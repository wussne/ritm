// Все даты в интерфейсе — календарные даты Томска, не локальная зона устройства.
export const ZONE='Asia/Tomsk';
export const today=()=>new Intl.DateTimeFormat('en-CA',{timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
export const addDays=(date,n)=>new Date(Date.parse(date+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
export const weekday=date=>(new Date(date+'T12:00:00Z').getUTCDay()+6)%7;
export const monday=date=>addDays(date,-weekday(date));
export const minutes=time=>Number(time.slice(0,2))*60+Number(time.slice(3,5));
export const clock=n=>`${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`;
export const niceDate=(date,options={day:'numeric',month:'long'})=>new Date(date+'T12:00:00Z').toLocaleDateString('ru-RU',{...options,timeZone:'UTC'});
export const stamp=(date,time)=>`${date}T${time}`;
export const instant=local=>Date.parse(local+':00+07:00');
export const SOURCES={lesson:'Урок',university:'Пара',driving:'Вождение',personal:'Личное'};
export const defaults={workStart:'09:00',workEnd:'23:59',breakMinutes:0,travelMinutes:30,subgroup:'all',reminderMinutes:15};
export function seed(){
 const start=monday(today());
 const students=['Пётр','Данияр','Настя','Мария','Света','Данил','Платон'].map((name,i)=>({id:'s'+i,name,topic:'',homework:'',next:'',materials:'',notes:'',history:[]}));
 const slots=[[0,1,'20:00'],[0,3,'20:00'],[1,2,'21:00'],[2,0,'23:00'],[3,5,'16:00'],[4,1,'21:00'],[4,4,'21:00'],[5,5,'22:00'],[5,6,'22:00'],[6,1,'22:00'],[6,3,'22:00'],[null,3,'16:00'],[null,4,'16:00']];
 return {students,events:slots.map(([student,day,time],i)=>({id:'initial'+i,title:student===null?'Очное занятие':students[student].name,studentId:student===null?'':students[student].id,kind:'lesson',date:addDays(start,day),time,duration:60,repeat:'weekly',until:'',exceptions:[],location:student===null?'Очно':'Онлайн',note:'',provisional:true})),notes:{},settings:{...defaults}};
}
export function occurrences(state,from,to,cache={}){
 let events=[];
 for(const e of state.events){
   for(let date=from;date<to;date=addDays(date,1)){
     if(date<e.date||e.until&&date>e.until||e.exceptions.includes(date))continue;
     if(e.repeat==='none'?date!==e.date:weekday(date)!==weekday(e.date))continue;
     events.push({...e,title:state.students.find(s=>s.id===e.studentId)?.name||e.title,ruleId:e.id,id:e.id+'@'+date,date,start:stamp(date,e.time),end:stamp(addDays(date,Math.floor((minutes(e.time)+e.duration)/1440)),clock((minutes(e.time)+e.duration)%1440))});
   }
 }
 for(const record of Object.values(cache))for(const e of record.events||[]){
   if(e.start.slice(0,10)<from||e.start.slice(0,10)>=to)continue;
   const subgroup=state.settings.subgroup;
   if(e.kind==='university'&&subgroup!=='all'&&e.subgroup&&e.subgroup!==subgroup)continue;
   events.push({...e,date:e.start.slice(0,10),time:e.start.slice(11,16),duration:(instant(e.end)-instant(e.start))/60000,external:true});
 }
 return [...new Map(events.map(e=>[e.id,e])).values()].sort((a,b)=>a.start.localeCompare(b.start));
}
export function conflicts(candidate,events,settings,ignoreId){
 const s=instant(candidate.start),e=instant(candidate.end);
 return events.filter(x=>x.id!==ignoreId).flatMap(x=>{
   const xs=instant(x.start),xe=instant(x.end);
   const travel=x.kind==='driving'||x.kind==='university'||candidate.kind==='driving'||candidate.kind==='university';
   const gap=(travel?settings.travelMinutes:settings.breakMinutes)*60000;
   if(s<xe&&e>xs)return [{event:x,type:'overlap'}];
   if(s<xe+gap&&e+gap>xs)return [{event:x,type:'buffer'}];
   return [];
 });
}
export function coverage(cache,date){
 return ['university','driving'].map(source=>{
  const record=cache[source+':'+monday(date)];
  const fresh=record?.lastSuccess&&Date.now()-Date.parse(record.lastSuccess)<30*60000&&!record.error;
  return {source,known:!!record?.lastSuccess,fresh:!!fresh,record};
 });
}
export function freeSlots(state,events,date,duration){
 const found=[];
 for(let t=minutes(state.settings.workStart);t+duration<=minutes(state.settings.workEnd);t+=15){
  const c={kind:'lesson',start:stamp(date,clock(t)),end:stamp(date,clock(t+duration))};
  if(!conflicts(c,events,state.settings).length)found.push(clock(t));
 }
 return found;
}

// Greedy interval lanes within each overlap group; stable even for chained overlaps.
export function eventLanes(events){
 const sorted=[...events].sort((a,b)=>a.start.localeCompare(b.start)||b.end.localeCompare(a.end)),result=new Map();
 let group=[],ends=[],groupEnd='';
 const flush=()=>{for(const [id,lane] of group)result.set(id,{lane,count:ends.length});group=[];ends=[];groupEnd='';};
 for(const e of sorted){if(group.length&&e.start>=groupEnd)flush();let lane=ends.findIndex(end=>end<=e.start);if(lane<0)lane=ends.length;ends[lane]=e.end;group.push([e.id,lane]);if(e.end>groupEnd)groupEnd=e.end;}
 flush();return result;
}
