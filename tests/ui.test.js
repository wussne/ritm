import test from 'node:test';import assert from 'node:assert/strict';import {JSDOM} from 'jsdom';import {build} from 'esbuild';import {unlinkSync} from 'node:fs';import React from 'react';
import {seed,monday,addDays,today} from '../src/domain.js';
test('DOM: ученик, итоги, конфликт и длительность найденного окна',async()=>{
 const dom=new JSDOM('<!doctype html><html><body><div id="test"></div></body></html>',{url:'http://localhost',pretendToBeVisual:true});
 for(const key of ['window','document','HTMLElement','Element','Node','NodeFilter','CustomEvent','MutationObserver','Event','MouseEvent','HTMLInputElement'])globalThis[key]=dom.window[key];
 Object.defineProperty(globalThis,'navigator',{value:dom.window.navigator,configurable:true});
 globalThis.getComputedStyle=dom.window.getComputedStyle;globalThis.requestAnimationFrame=dom.window.requestAnimationFrame;globalThis.cancelAnimationFrame=dom.window.cancelAnimationFrame;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 await build({entryPoints:['src/main.jsx'],bundle:true,format:'esm',platform:'node',packages:'external',loader:{'.css':'empty'},outfile:'tests/.ui-built.mjs',logLevel:'silent'});
 const {render,fireEvent,cleanup,within,waitFor}=await import('@testing-library/react');
 const {StudentEditor,EventEditor,FindTime}=await import('./.ui-built.mjs');
 try{
 let s=seed(),saved;const onSave=async next=>{saved=next;return true};
 render(React.createElement(StudentEditor,{data:s,save:onSave,onClose(){},saving:false}));
 fireEvent.change(within(document.body).getByLabelText('Имя'),{target:{value:'Тестовый ученик'}});
 fireEvent.change(within(document.body).getByLabelText('На чём остановились'),{target:{value:'Системы счисления'}});
 fireEvent.click(within(document.body).getByRole('button',{name:'Сохранить карточку'}));
 await waitFor(()=>assert.equal(saved.students.at(-1).name,'Тестовый ученик'));cleanup();
 s=saved;const student=s.students.at(-1);
 render(React.createElement(StudentEditor,{student,data:s,save:onSave,onClose(){},saving:false}));
 fireEvent.click(within(document.body).getByRole('button',{name:'Итоги урока'}));
 fireEvent.change(within(document.body).getByLabelText('Что прошли'),{target:{value:'Разобрали восьмеричную систему'}});
 fireEvent.change(within(document.body).getByLabelText('Что дальше'),{target:{value:'Задание 8'}});
 fireEvent.click(within(document.body).getByRole('button',{name:'Сохранить итоги'}));
 await waitFor(()=>assert.equal(saved.students.at(-1).history.length,1));assert.equal(saved.students.at(-1).next,'Задание 8');cleanup();
 const first=s.events[0];
 render(React.createElement(EventEditor,{data:s,cache:{},initial:{date:first.date,time:first.time},save:onSave,onClose(){},sync:async()=>{},saving:false}));
 assert.ok(within(document.body).getByText('Это время занято'));assert.equal(within(document.body).getByRole('button',{name:'Добавить занятие'}).disabled,true);cleanup();
 const d=monday(addDays(today(),14));let chosen;
 render(React.createElement(FindTime,{data:{...s,events:[]},cache:{},initialWeek:d,onClose(){},choose:(...args)=>chosen=args,sync:async()=>{}}));
 fireEvent.change(within(document.body).getByLabelText('Длительность'),{target:{value:'90'}});
 fireEvent.click(within(document.body).getAllByRole('button',{name:'16:00'})[0]);assert.equal(chosen[2],90);cleanup();
 render(React.createElement(EventEditor,{data:{...s,events:[]},cache:{},initial:{date:d,time:'16:00',duration:90},save:onSave,onClose(){},sync:async()=>{},saving:false}));
 assert.equal(within(document.body).getByLabelText('Длительность, минут').value,'90');cleanup();
 }finally{cleanup();dom.window.close();unlinkSync('tests/.ui-built.mjs');}
});
