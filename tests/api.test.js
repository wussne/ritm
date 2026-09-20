import test from 'node:test';import assert from 'node:assert/strict';import {spawn} from 'node:child_process';import {mkdtempSync,rmSync} from 'node:fs';import {tmpdir} from 'node:os';import path from 'node:path';
test('API: авторизация, сохранение, версии, валидация и экспорт',async()=>{
 const dir=mkdtempSync(path.join(tmpdir(),'ritm-test-'));
 const child=spawn(process.execPath,['server/index.js'],{env:{...process.env,APP_PASSWORD:'test-only-password',SESSION_SECRET:'test-only-secret-with-at-least-32-chars',DATA_DIR:dir,PORT:'3917',NODE_ENV:'test'},stdio:['ignore','pipe','pipe']});
 try{
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Не запустился сервер')),8000);child.stdout.on('data',()=>{clearTimeout(timer);resolve()});child.on('error',reject);});
 const base='http://127.0.0.1:3917/api/';
 assert.equal((await fetch(base+'state')).status,401);
 let res=await fetch(base+'login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'wrong'})});assert.equal(res.status,401);
 res=await fetch(base+'login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({password:'test-only-password'})});assert.equal(res.status,200);
 const cookie=res.headers.get('set-cookie').split(';')[0],headers={'content-type':'application/json',cookie};
 let initial=await (await fetch(base+'state',{headers})).json();assert.equal(initial.state.students.length,7);
 initial.state.students[0].notes='Проверка записи';
 let saved=await fetch(base+'state',{method:'PUT',headers,body:JSON.stringify(initial)});assert.equal(saved.status,200);
 assert.equal((await fetch(base+'state',{method:'PUT',headers,body:JSON.stringify(initial)})).status,409);
 const read=await (await fetch(base+'state',{headers})).json();assert.equal(read.state.students[0].notes,'Проверка записи');
 read.state.events[0].date='2026-02-31';assert.equal((await fetch(base+'state',{method:'PUT',headers,body:JSON.stringify(read)})).status,400);
 assert.equal((await fetch(base+'sync',{method:'POST',headers,body:JSON.stringify({week:'2026-09-22'})})).status,400);
 assert.equal((await fetch(base+'state',{method:'PUT',headers:{...headers,origin:'https://wrong.example'},body:JSON.stringify(initial)})).status,403);
 assert.equal((await fetch(base+'export',{headers})).status,200);
 }finally{child.kill();await new Promise(r=>child.on('close',r));rmSync(dir,{recursive:true,force:true});}
});
