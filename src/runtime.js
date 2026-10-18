// Puente saliente: el equipo personal consulta trabajos. No abre puertos del Mac.
import config from '../config.js';
const OPS=new Set(['vault.search','vault.read','vault.capture','vault.update','memory.list','memory.remember','memory.forget','call']);
export const runtimeEnabled=env=>Boolean(config.runtime?.enabled && env.RUNTIME_TOKEN);
const json=(body,status=200)=>Response.json(body,{status,headers:{'cache-control':'no-store'}});
export async function runtimeStatus(env) {
  const row=await env.DB.prepare("SELECT value,updated_at FROM runtime_state WHERE key='health'").first();
  const h=row?{...JSON.parse(row.value),at:row.updated_at}:null;
  return {...h,online:Boolean(h&&Date.now()-h.at<90000)};
}
export async function submitRuntime(env,operation,payload,{wait=true,expiresAt=Date.now()+20000}={}) {
  if(!runtimeEnabled(env))return {error:'El servicio personal no está configurado.'};
  const health=await runtimeStatus(env);
  if(!health.online)return {error:'El equipo personal está desconectado; no he ejecutado la acción.'};
  if(!OPS.has(operation))throw new Error('Operación no permitida');
  const id=crypto.randomUUID();
  await env.DB.prepare('INSERT INTO runtime_jobs (id,operation,payload,expires_at,created_at) VALUES (?,?,?,?,?)')
    .bind(id,operation,JSON.stringify(payload),expiresAt,Date.now()).run();
  if(!wait)return {ok:true,pending:true,id};
  const deadline=Date.now()+Math.min(16000,config.runtime?.timeoutMs||16000);
  while(Date.now()<deadline) {
    await new Promise(resolve=>setTimeout(resolve,400));
    const row=await env.DB.prepare('SELECT status,result FROM runtime_jobs WHERE id=?').bind(id).first();
    if(row?.status==='done')return JSON.parse(row.result);
  }
  // No afirmar fracaso definitivo: el trabajo puede haberse ejecutado ya en el equipo.
  return {pending:true,id,nota:'Todavía no hay confirmación. No repitas la acción: consulta su estado con servicio_estado.'};
}
export async function handleRuntime(request,env) {
  if(!env.RUNTIME_TOKEN || request.headers.get('authorization')!==`Bearer ${env.RUNTIME_TOKEN}`)return json({error:'unauthorized'},401);
  const url=new URL(request.url); const path=url.pathname.replace('/api/runtime','');
  if(request.method==='POST' && path.startsWith('/mail/')) {
    const action=path.slice(6);
    if(!['authorize','exchange','status'].includes(action)||!env.CALENDAR_API)return json({error:'not configured'},503);
    const r=await env.CALENDAR_API.fetch('https://internal/internal/gmail/'+action,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(await request.json())});
    return new Response(r.body,{status:r.status,headers:{'content-type':'application/json','cache-control':'no-store'}});
  }
  if(request.method==='POST' && path==='/status') {
    const state=await runtimeStatus(env),body=await request.json().catch(()=>({}));
    if(body.mail){const {gmailStatus}=await import('./gmail.js');state.mail=await gmailStatus(env,{verify:true});}
    if(body.calendar && env.CALENDAR_API){
      state.calendar={};
      for(const route of ['health','availability?duration=30']){
        try{
          const r=await env.CALENDAR_API.fetch('https://internal/'+route),data=await r.json();
          state.calendar[route]={status:r.status,...(route==='health'?data:{slots:data.slots?.length||0})};
        }catch{state.calendar[route]={error:'unavailable'};}
      }
    }
    return json(state);
  }
  if(request.method==='POST' && path==='/identity') return json({owner_id:String(env.OWNER_CHAT_ID||'')});
  if(request.method==='POST' && path==='/assistant/generate') {
    if(!config.runtime?.evaluation)return json({error:'evaluation disabled'},403);
    const body=await request.json();
    if(!Array.isArray(body.messages) || body.messages.length>50 || JSON.stringify(body).length>100000) return json({error:'invalid'},400);
    const {chat}=await import('./llm.js');
    // Solo inferencia; las herramientas de evaluación se ejecutan contra fixtures en el cliente.
    return json(await chat(env,{messages:body.messages,tools:body.tools||[],prefer:'fast',effort:'low',maxTokens:700,slowFallback:false}));
  }
  if(request.method==='POST' && path.startsWith('/voice/')) {
    if(!runtimeEnabled(env) || !config.runtime?.voice) return json({error:'voice disabled'},503);
    const body=await request.json();
    const {createVoiceSession,jarvisTurn,jarvisReport}=await import('./wake.js');
    if(path==='/voice/session')return json(await createVoiceSession(env,body.job));
    if(path==='/voice/turn')return json(await jarvisTurn(env,body));
    if(path==='/voice/report')return json(await jarvisReport(env,body));
    return json({error:'not found'},404);
  }
  if(request.method==='POST' && path==='/heartbeat') {
    const body=await request.json();
    await env.DB.prepare("INSERT INTO runtime_state(key,value,updated_at) VALUES ('health',?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at").bind(JSON.stringify({voice:Boolean(body.voice),vault:Boolean(body.vault),version:1}),Date.now()).run();
    return json({ok:true});
  }
  if(request.method==='POST' && path==='/jobs/claim') {
    const now=Date.now(),lease=crypto.randomUUID();
    const row=await env.DB.prepare(`UPDATE runtime_jobs SET status='running',lease=?,lease_until=? WHERE id=(
      SELECT id FROM runtime_jobs WHERE expires_at>? AND (status='pending' OR (status='running' AND lease_until<?)) ORDER BY created_at LIMIT 1
    ) RETURNING id,operation,payload,expires_at,lease`).bind(lease,now+90000,now,now).first();
    return json({job:row?{...row,payload:JSON.parse(row.payload)}:null});
  }
  if(request.method==='POST' && (path==='/jobs/result'||path==='/jobs/lease')) {
    const body=await request.json();
    if(!body.id || !body.lease)return json({error:'invalid'},400);
    if(path.endsWith('/lease')) {
      const r=await env.DB.prepare("UPDATE runtime_jobs SET lease_until=? WHERE id=? AND lease=? AND status='running'").bind(Date.now()+90000,body.id,body.lease).run();
      return json({ok:Boolean(r.meta.changes)},r.meta.changes?200:409);
    }
    const result=JSON.stringify(body.result??{error:'Resultado vacío'});
    if(result.length>64000)return json({error:'too large'},413);
    const r=await env.DB.prepare("UPDATE runtime_jobs SET status='done',result=?,completed_at=? WHERE id=? AND lease=? AND status='running'")
      .bind(result,Date.now(),body.id,body.lease).run();
    return json({ok:Boolean(r.meta.changes)},r.meta.changes?200:409);
  }
  return json({error:'not found'},404);
}
export async function cleanRuntime(env) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM runtime_jobs WHERE expires_at<?').bind(Date.now()-86400000),
    env.DB.prepare('DELETE FROM processed_updates WHERE created_at<?').bind(Date.now()-7*86400000),
  ]);
}
