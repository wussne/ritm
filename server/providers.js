import * as cheerio from 'cheerio';
import {addDays,monday} from '../src/domain.js';
const BASE='https://timetable.tusur.ru/faculties/fsu/groups/435-2';
const clean=s=>s.replace(/\s+/g,' ').trim();
const months=['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
async function request(url,options={}){
 const response=await fetch(url,{...options,signal:AbortSignal.timeout(20000),redirect:'error'});
 if(!response.ok)throw new Error(`Источник ответил HTTP ${response.status}`);
 return response;
}
export function parseWeeks(html){
 const $=cheerio.load(html),weeks=[];
 $('.weeks a[href*="week_id="]').each((_,a)=>{
  const text=clean($(a).text()),m=text.match(/^(\d+)\s+(нечётная|чётная)\s+с\s+(\d+)\s+(\S+)\s+(\d{4})/);
  if(!m||!months.includes(m[4]))return;
  weeks.push({start:`${m[5]}-${String(months.indexOf(m[4])+1).padStart(2,'0')}-${m[3].padStart(2,'0')}`,number:Number(m[1]),parity:m[2],url:new URL($(a).attr('href'),BASE).href});
 });
 if(!weeks.length)throw new Error('Не удалось распознать список недель ТУСУР. Старое расписание сохранено.');
 return weeks;
}
export function parseTusur(html,week){
 const $=cheerio.load(html),events=new Map();
 if(!parseWeeks(html).some(w=>w.start===week.start))throw new Error('Источник не подтвердил выбранную неделю');
 $('.lesson-info-modal').each((_,node)=>{
  const el=$(node),fields={};
  el.find('.modal-body > p').each((_,p)=>{
   const label=clean($(p).children('strong').first().text()).replace(/:$/,'');
   const copy=$(p).clone();copy.children('strong').first().remove();fields[label]=clean(copy.text());
  });
  const date=fields['Дата проведения']?.match(/(\d{2})\.(\d{2})\.(\d{4})/),time=fields['Время проведения']?.match(/(\d{2}:\d{2})\s*[-–]\s*(\d{2}:\d{2})/);
  if(!date||!time)throw new Error('Изменился формат даты или времени ТУСУР');
  const day=`${date[3]}-${date[2]}-${date[1]}`;
  if(day<week.start||day>=addDays(week.start,7))throw new Error('ТУСУР вернул другую неделю. Обновление отменено.');
  const comment=fields['Комментарий']||'',id='tusur:'+el.attr('data-lesson-id');
  const sg=comment.toLowerCase().match(/подгрупп[аы]\s*([абab])/);
  events.set(id,{id,kind:'university',title:clean(el.find('.modal-title').text()),start:day+'T'+time[1],end:day+'T'+time[2],location:fields['Место проведения']||'',sourceNote:Object.entries(fields).filter(([k])=>!['Дата проведения','Время проведения'].includes(k)).map(([k,v])=>`${k}: ${v}`).join('\n'),subgroup:sg?({'a':'а','b':'б'}[sg[1]]||sg[1]):'',sourceUrl:week.url});
 });
 // Empty HTML must never clear a previously valid week silently.
 if(!events.size)throw new Error('На выбранной неделе не найдены занятия. Проверьте источник; неделя не объявлена свободной.');
 return {events:[...events.values()],week};
}
export async function tusur(start){
 const weeks=parseWeeks(await (await request(BASE)).text());
 const week=weeks.find(w=>w.start===start);
 if(!week)throw new Error('ТУСУР пока не опубликовал эту неделю');
 return parseTusur(await (await request(week.url)).text(),week);
}
export function parseDriving(json,start){
 if(json?.success!==true||!Array.isArray(json.data))throw new Error('Автошкола не подтвердила вход. Обновите DS_COOKIE на сервере.');
 const end=addDays(start,7);
 const events=json.data.map(x=>{
  if(!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(x.start_date)||!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(x.end_date)||!x.Key)throw new Error('Изменился формат расписания автошколы');
  return {id:'ds:'+x.Key,kind:'driving',title:'Вождение',start:x.start_date.replace(' ','T').slice(0,16),end:x.end_date.replace(' ','T').slice(0,16),location:x.RoomName||'',sourceNote:`Инструктор: ${x.EmployeeName||'не указан'}\nЗанятие: ${x.OrderNum||'—'}\nАвтомобиль ID: ${x.VehicleId||'—'}\nСтатус источника: ${x.State}\n${x.Themes?JSON.stringify(x.Themes):''}`,sourceUrl:'https://app.dscontrol.ru/'};
 });
 if(events.some(x=>x.end<=x.start))throw new Error('Некорректная длительность вождения');
 return {events:events.filter(e=>e.start.slice(0,10)>=start&&e.start.slice(0,10)<end)};
}
export async function driving(start){
 if(!process.env.DS_COOKIE)throw new Error('Добавьте DS_COOKIE в .env сервера, чтобы подключить автошколу');
 const query=new URLSearchParams({Kinds:'DT',OnlyMine:'true',MasterIds:'',AutodromeId:'',VehicleId:'',SessionTypeIds:'',TeacherIds:'',ThemeId:'',RoomId:'',timeshift:'-420',from:start,to:addDays(start,7)});
 const response=await request('https://app.dscontrol.ru/Api/StudentSchedulerList?'+query,{headers:{accept:'application/json','x-requested-with':'XMLHttpRequest',cookie:process.env.DS_COOKIE,Referer:'https://app.dscontrol.ru/'}});
 if(!response.headers.get('content-type')?.includes('json'))throw new Error('Автошкола вернула страницу входа. Обновите DS_COOKIE.');
 return parseDriving(await response.json(),start);
}
