import { splitInterval } from './time.js';
const cache=new WeakMap();
export async function externalBusy(env, from, to) {
  if (!env.CALENDAR_API) return [];
  const existing=cache.get(env);
  if(existing && existing.from<=from && existing.to>=to && Date.now()-existing.at<30000) return existing.blocks.filter(b=>b.date>=from&&b.date<=to);
  const start=Date.parse(from+'T00:00Z')-86400000;
  const end=Date.parse(to+'T00:00Z')+2*86400000;
  const r=await env.CALENDAR_API.fetch(`https://internal/internal/busy?from=${start}&to=${end}`, {signal:AbortSignal.timeout(12000)});
  if (!r.ok) throw new Error('No se ha podido actualizar el calendario externo; no puedo garantizar los huecos.');
  const j=await r.json();
  if (!Array.isArray(j.busy)) throw new Error('Respuesta de calendario incompleta.');
  const blocks=j.busy.flatMap(b=>splitInterval(b.start,b.end));
  cache.set(env,{from,to,at:Date.now(),blocks});
  return blocks.filter(b=>b.date>=from&&b.date<=to);
}
