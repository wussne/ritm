// Создание одного автономного HTML. Это просмотр интерфейса, не production-сервер.
import {build} from 'esbuild';import {readFileSync,writeFileSync} from 'node:fs';import {seed} from '../src/domain.js';
const state=seed();
// Переносим исходный шаблон на известную неделю без зависимости от дня сборки.
const raw=seed();for(let i=0;i<state.events.length;i++){const day=(new Date(raw.events[i].date+'T12:00:00Z').getUTCDay()+6)%7;state.events[i].date='2026-09-'+String(21+day);}
const cache=JSON.parse(readFileSync('tests/fixtures/preview-cache.json','utf8'));
const result=await build({entryPoints:['src/main.jsx'],bundle:true,minify:true,format:'iife',write:false,loader:{'.css':'empty'},define:{'process.env.NODE_ENV':'"production"'}});
const css=readFileSync('src/style.css','utf8').replace(/@import[^;]+;/g,'');
const boot=`window.RITM_PREVIEW_WEEK='2026-09-21';let snapshot=${JSON.stringify({state,cache,version:1,connections:{driving:true,telegram:false}})};window.fetch=async(url,options={})=>{const path=String(url);let body;try{body=JSON.parse(options.body||'{}')}catch{};let out={};if(path.endsWith('/state')){if(options.method==='PUT'){snapshot.state=body.state;snapshot.version++;}out=snapshot;}else if(path.endsWith('/sync')){out={cache:snapshot.cache};}else if(path.endsWith('/login')||path.endsWith('/logout'))out={ok:true};else return new Response('{}',{status:404});return new Response(JSON.stringify(out),{headers:{'content-type':'application/json'}})};`;
writeFileSync('preview.html',`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ритм — автономный предпросмотр</title><style>${css}</style></head><body><div id="root"></div><script>${boot.replaceAll('</script','<\\/script')}</script><script>${result.outputFiles[0].text.replaceAll('</script','<\\/script')}</script></body></html>`);
console.log('Создан preview.html — без ключей, сети и установки');
