import { test } from 'node:test';
import assert from 'node:assert/strict';
import { environment } from './helpers.js';
import { hideReferences } from '../src/presentation.js';
import { localEpoch,localParts,splitInterval } from '../src/time.js';
import { PERSONAL_HANDLERS } from '../src/personal-tools.js';
import { handleRuntime } from '../src/runtime.js';
import { runSync,syncStatus } from '../src/freshness.js';
import { notionTaskFields } from '../src/notion.js';
import { messageText } from '../src/gmail.js';
import { handleInbox } from '../src/inbox.js';
import { loadBusy } from '../src/brain.js';
import { applyTool } from '../src/agent.js';

test('IDs de presentación ocultos; números y hashtags del título se conservan',()=>{
 assert.equal(hideReferences('Apuntada #105 · Estudiar autómatas 2 · #uni'),'Apuntada · Estudiar autómatas 2 · #uni');
 assert.equal(hideReferences('Capítulo 105, 17:00–18:00'),'Capítulo 105, 17:00–18:00');
});
test('hora de Madrid y reservas nocturnas respetan cambio de hora',()=>{
 assert.equal(new Date(localEpoch('2026-10-24','10:00')).toISOString(),'2026-10-24T08:00:00.000Z');
 assert.equal(new Date(localEpoch('2026-10-26','10:00')).toISOString(),'2026-10-26T09:00:00.000Z');
 const blocks=splitInterval(localEpoch('2026-10-24','23:30'),localEpoch('2026-10-25','01:00'));
 assert.deepEqual(blocks.map(x=>[x.date,x.start,x.end]),[['2026-10-24','23:30','24:00'],['2026-10-25','00:00','01:00']]);
});
test('búsqueda incluye notas sin fecha y escapa comodines',async()=>{
 const e=environment();await e.DB.prepare("INSERT INTO items(kind,text) VALUES ('nota','Proyecto 100%')").run();
 assert.equal((await PERSONAL_HANDLERS.tareas_buscar(e,{consulta:'100%'})).items.length,1);
 assert.equal((await PERSONAL_HANDLERS.tareas_buscar(e,{consulta:'xyz%'})).items.length,0);
});
test('runtime requiere token; claim atómico, lease y resultado no aceptan otro cliente',async()=>{
 const e={...environment(),RUNTIME_TOKEN:'secret'};
 const req=(path,body,token='secret')=>new Request('https://worker/api/runtime'+path,{method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify(body)});
 assert.equal((await handleRuntime(req('/jobs/claim',{},'wrong'),e)).status,401);
 await e.DB.prepare('INSERT INTO runtime_jobs(id,operation,payload,expires_at,created_at) VALUES (?,?,?,?,?)').bind('j','vault.read','{}',Date.now()+60000,Date.now()).run();
 const jobs=await Promise.all([handleRuntime(req('/jobs/claim',{}),e),handleRuntime(req('/jobs/claim',{}),e)]);
 const bodies=await Promise.all(jobs.map(r=>r.json()));assert.equal(bodies.filter(x=>x.job).length,1);
 const job=bodies.find(x=>x.job).job;
 assert.equal((await handleRuntime(req('/jobs/result',{id:'j',lease:'wrong',result:{ok:true}}),e)).status,409);
 assert.equal((await handleRuntime(req('/jobs/result',{id:'j',lease:job.lease,result:{ok:true}}),e)).status,200);
});
test('sync fallida conserva fecha de éxito anterior y deja error visible',async()=>{
 const e=environment();await runSync(e,'test',async()=>{});const first=(await syncStatus(e))[0].success_at;
 await runSync(e,'test',async()=>{throw Error('offline')});const state=(await syncStatus(e))[0];assert.equal(state.success_at,first);assert.equal(state.error,'offline');
});
test('Notion conserva la hora límite y reconoce estado reabierto y fecha retirada',()=>{
 const c={date:'Fecha',status:'Estado',priority:'Prioridad',done:['Completada']};
 const r={properties:{Nombre:{type:'title',title:[{plain_text:'Práctica'}]},Fecha:{date:{start:'2026-10-26T20:00:00Z'}},Estado:{status:{name:'Pendiente'}}}};
 assert.equal(notionTaskFields(r,c).due_at,'2026-10-26T21:00');r.properties.Fecha.date=null;assert.equal(notionTaskFields(r,c).due_date,null);
});
test('Gmail decodifica texto UTF8 anidado sin ejecutar HTML',()=>{
 const data=Buffer.from('Hola Álvaro').toString('base64url');assert.equal(messageText({parts:[{mimeType:'text/plain',body:{data}}]}),'Hola Álvaro');
});
test('reserva idempotente se incorpora a la agenda y cancelarla libera el bloque',async()=>{
 const e=environment();
 const push=body=>handleInbox(new Request('https://internal/internal/inbox',{method:'POST',body:JSON.stringify(body)}),e);
 const body={id:'book:abc',kind:'reunion',name:'Ana',start:'2026-10-26T10:00:00Z',end:'2026-10-26T10:30:00Z'};
 await push(body);await push(body);assert.equal(e.DB.raw.prepare('SELECT count(*) AS n FROM inbox').get().n,1);
 let busy=await loadBusy(e,'2026-10-26','2026-10-26',null,false);assert.ok(busy.some(x=>x.label.includes('Ana')&&x.start==='11:00'));
 await push({id:body.id,status:'cancelada'});busy=await loadBusy(e,'2026-10-26','2026-10-26',null,false);assert.ok(!busy.some(x=>x.label.includes('Ana')));
});
test('editar y completar tarea mantiene undo con done_at',async()=>{
 const e=environment();const {result}=await applyTool(e,'crear_tarea',{titulo:'Autómatas',sin_hueco:true});
 assert.ok(result.id);await applyTool(e,'marcar_hecho',{id:result.id});const item=e.DB.raw.prepare('SELECT * FROM items WHERE id=?').get(result.id);assert.equal(item.status,'hecha');assert.ok(item.done_at);
});

test('Start reconcilia renombre, fecha retirada, completada, reapertura y desasignación',async t=>{
 const {syncNotionTasks}=await import('../src/notion.js');
 const config=(await import('../config.js')).default;
 const previous=config.notion;config.notion={name:'Start',category:'start',tasks:{date:'Fecha',assignee:'Persona',status:'Estado',done:['Completada'],priority:'Prioridad'}};
 t.after(()=>config.notion=previous);
 const e={...environment(),NOTION_TOKEN:'test'};
 await e.FILES.put('notion:ids',JSON.stringify({tasks:'tasks',me:'member'}));
 const page={id:'page',url:'https://notion.so/page',properties:{Title:{type:'title',title:[{plain_text:'Original'}]},Fecha:{date:{start:'2026-12-10'}},Persona:{relation:[{id:'member'}]},Estado:{status:{name:'Pendiente'}}}};
 let assigned=true;
 t.mock.method(globalThis,'fetch',async url=>Response.json(url.includes('/query')?{results:assigned?[page]:[],has_more:false}:page));
 await syncNotionTasks(e);
 let item=e.DB.raw.prepare("SELECT * FROM items WHERE source='notion:page'").get();assert.equal(item.text,'Original');
 page.properties.Title.title[0].plain_text='Nuevo título';page.properties.Fecha.date=null;
 await syncNotionTasks(e);item=e.DB.raw.prepare("SELECT * FROM items WHERE source='notion:page'").get();assert.equal(item.text,'Nuevo título');assert.equal(item.due_date,null);
 page.properties.Estado.status.name='Completada';await syncNotionTasks(e);item=e.DB.raw.prepare("SELECT * FROM items WHERE source='notion:page'").get();assert.equal(item.status,'hecha');assert.equal(item.start_at,null);
 page.properties.Estado.status.name='Pendiente';await syncNotionTasks(e);item=e.DB.raw.prepare("SELECT * FROM items WHERE source='notion:page'").get();assert.equal(item.status,'pendiente');assert.equal(item.done_at,null);
 assigned=false;page.properties.Persona.relation=[];await syncNotionTasks(e);item=e.DB.raw.prepare("SELECT * FROM items WHERE source='notion:page'").get();assert.equal(item.status,'retirada');assert.equal(item.start_at,null);
});

test('llamadas urgentes requieren reglas; silencio atraviesa medianoche',async()=>{
 const {inQuiet,notificationPolicy}=await import('../src/proactive.js');const e=environment();
 assert.equal(inQuiet('23:30','23:00','08:00'),true);assert.equal(inQuiet('07:00','23:00','08:00'),true);assert.equal(inQuiet('10:00','23:00','08:00'),false);
 assert.ok((await notificationPolicy(e,{llamadas_urgentes:true})).error);
 assert.equal((await notificationPolicy(e)).policy.urgent_calls,false);
 assert.equal((await notificationPolicy(e,{llamadas_urgentes:true,silencio_desde:'23:00',silencio_hasta:'08:00',antelacion_min:120})).policy.urgent_calls,true);
});

test('Aula Global reconcilia plazo y reapertura; estimación permanece diferenciada',async()=>{
 const {syncTasks}=await import('../src/aulaglobal.js');const e=environment();
 const pending=[{source:'ag:assign:1',course:'Autómatas',name:'Práctica',due:Date.parse('2026-12-01T22:59Z')/1000,done:false,url:'https://moodle.example/1'}];
 await syncTasks(e,pending);await syncTasks(e,pending);assert.equal(e.DB.raw.prepare("SELECT count(*) AS n FROM items WHERE source='ag:assign:1'").get().n,1);
 pending[0].done=true;await syncTasks(e,pending);assert.equal(e.DB.raw.prepare("SELECT status FROM items WHERE source='ag:assign:1'").get().status,'hecha');
 pending[0].done=false;pending[0].due+=86400;await syncTasks(e,pending);const item=e.DB.raw.prepare("SELECT * FROM items WHERE source='ag:assign:1'").get();assert.equal(item.status,'pendiente');assert.equal(item.due_date,'2026-12-02');assert.equal(item.done_at,null);
});

test('hacer una tarea un día concreto no convierte ese día en fecha límite',async()=>{
 const e=environment();const {result}=await applyTool(e,'crear_tarea',{titulo:'Estudiar autómatas',fecha_realizacion:'2026-12-06',hora_realizacion:'11:00',duracion_min:60});
 const item=e.DB.raw.prepare('SELECT * FROM items WHERE id=?').get(result.id);assert.equal(item.due_date,null);assert.equal(item.start_at,'2026-12-06T11:00');assert.equal(item.end_at,'2026-12-06T12:00');
});


test('runtime rechaza JSON inválido, cuerpos grandes y métodos sin modificar datos',async()=>{
 const e={...environment(),RUNTIME_TOKEN:'secret'};
 const req=(body,method='POST')=>new Request('https://worker/api/runtime/heartbeat',{method,headers:{authorization:'Bearer secret'},...(method==='POST'?{body}:{})});
 assert.equal((await handleRuntime(req('{'),e)).status,400);
 assert.equal((await handleRuntime(req('null'),e)).status,400);
 assert.equal((await handleRuntime(req(JSON.stringify({x:'a'.repeat(2000000)})),e)).status,413);
 assert.equal((await handleRuntime(req(null,'GET'),e)).status,405);
 assert.equal(e.DB.raw.prepare('SELECT count(*) AS n FROM runtime_state').get().n,0);
});

test('rutas privadas, calendarios y endpoints internos no se exponen sin autorización',async()=>{
 const {default:worker}=await import('../src/index.js');
 const {default:config}=await import('../config.js');
 const previous=config.runtime;config.runtime={...previous,voice:true};
 try{
  const e={...environment(),CAL_TOKEN:'calendar-secret',RUNTIME_TOKEN:'runtime-secret',TG_WEBHOOK_SECRET:'webhook-secret'};
  for(const [path,method,expected] of [['/api/items','GET',401],['/api/runtime/status','POST',401],['/calendar.ics','GET',403],['/cal/clases.ics','GET',403],['/internal/busy','GET',404],['/internal/inbox','POST',404],['/webhook','POST',403],['/api/jarvis','GET',410]]){
   const r=await worker.fetch(new Request('https://worker.example'+path,{method}),e,{waitUntil(){throw Error('No debe ejecutar trabajo')}});assert.equal(r.status,expected,path);
  }
 }finally{config.runtime=previous;}
});
