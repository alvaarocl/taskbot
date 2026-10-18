// Las nuevas llamadas urgentes están apagadas hasta que el usuario acuerde sus reglas.
import { localParts } from './time.js';
const KEY='notifications:policy';
const TIME=/^(?:[01]\d|2[0-3]):[0-5]\d$/;
export function inQuiet(time,from,to) {
  if(!TIME.test(from||'')||!TIME.test(to||''))return true;
  if(from===to)return true;
  return from<to?time>=from&&time<to:time>=from||time<to;
}
export async function notificationPolicy(env,args={}) {
  const prev=await env.FILES.get(KEY,{type:'json'})||{urgent_calls:false};
  const out={...prev};
  if('silencio_desde' in args){if(!TIME.test(args.silencio_desde))return {error:'Hora inválida'};out.quiet_from=args.silencio_desde;}
  if('silencio_hasta' in args){if(!TIME.test(args.silencio_hasta))return {error:'Hora inválida'};out.quiet_to=args.silencio_hasta;}
  if('antelacion_min' in args){if(!Number.isInteger(args.antelacion_min)||args.antelacion_min<15||args.antelacion_min>1440)return {error:'Antelación entre 15 y 1440 minutos'};out.lead_min=args.antelacion_min;}
  if('llamadas_urgentes' in args)out.urgent_calls=args.llamadas_urgentes===true;
  if(out.urgent_calls&&(!TIME.test(out.quiet_from||'')||!TIME.test(out.quiet_to||'')||!out.lead_min))return {error:'Para activar llamadas urgentes, indica silencio desde/hasta y con cuántos minutos avisar. Se aplican a plazos pendientes con hora exacta.'};
  if(Object.keys(args).length)await env.FILES.put(KEY,JSON.stringify(out));
  return {ok:true,policy:out,scope:'plazos pendientes con hora exacta; el despertador conserva su configuración independiente'};
}
export async function proactiveTick(env) {
  if(!env.OWNER_CHAT_ID)return;
  const policy=(await notificationPolicy(env)).policy;
  if(!policy.urgent_calls)return;
  const {tg}=await import("./telegram.js");
  const now=localParts(Date.now());if(inQuiet(now.time,policy.quiet_from,policy.quiet_to))return;
  const {results}=await env.DB.prepare("SELECT id,text,due_at FROM items WHERE status='pendiente' AND kind='tarea' AND due_at IS NOT NULL ORDER BY due_at LIMIT 50").all();
  const localNow=Date.parse(`${now.date}T${now.time}:00Z`);
  const imminent=results.filter(x=>{const left=(Date.parse(x.due_at+':00Z')-localNow)/60000;return left>0&&left<=policy.lead_min});
  if(!imminent.length)return;
  const fingerprint=imminent.map(x=>x.id+':'+x.due_at).join('|');
  const key='urgent:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(fingerprint)))).map(x=>x.toString(16).padStart(2,'0')).join('');
  if(await env.FILES.get(key))return;
  // Registrar el intento para no insistir ni duplicar llamadas ante errores.
  await env.FILES.put(key,'attempted',{expirationTtl:2*86400});
  await tg(env,'sendMessage',{chat_id:env.OWNER_CHAT_ID,text:'⏰ Plazos próximos:\n'+imminent.map(x=>`• ${x.text} · ${x.due_at.replace('T',' ')}`).join('\n')});
  const {callNow}=await import('./wake.js');
  try {await callNow(env);}catch {await tg(env,'sendMessage',{chat_id:env.OWNER_CHAT_ID,text:'No he podido conectar la llamada. El aviso anterior sigue vigente; no volveré a llamarte por estos mismos plazos.'});}
}
