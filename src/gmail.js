import config from "../config.js";
// Gmail directo: consulta, etiquetas y borradores. No existe herramienta de envío ni borrado.
const ACCOUNT_PREFIX={personal:'GMAIL',universidad:'UNIVERSITY_GMAIL'};
export function gmailAccounts(env) { if(config.gmail?.broker && env.CALENDAR_API)return ['personal','universidad']; return Object.keys(ACCOUNT_PREFIX).filter(key=>{const p=ACCOUNT_PREFIX[key];return env[p+'_CLIENT_ID']&&env[p+'_CLIENT_SECRET']&&env[p+'_REFRESH_TOKEN']}); }
export const gmailEnabled=env=>gmailAccounts(env).length>0;
function accountEnv(env,account) {
  const available=gmailAccounts(env);
  const key=account || (available.length===1?available[0]:null);
  if(!key || !available.includes(key)) throw new Error('Selecciona una cuenta conectada: '+(available.join(', ')||'ninguna'));
  if(config.gmail?.broker && env.CALENDAR_API)return {...env,_gmailAccount:key};
  const prefix=ACCOUNT_PREFIX[key];
  return {...env,GMAIL_CLIENT_ID:env[prefix+'_CLIENT_ID'],GMAIL_CLIENT_SECRET:env[prefix+'_CLIENT_SECRET'],GMAIL_REFRESH_TOKEN:env[prefix+'_REFRESH_TOKEN'],_gmailAccount:key};
}
async function token(env) {
  const cached=await env.FILES.get('gmail:token:'+(env._gmailAccount||'personal'));if(cached)return cached;
  const r=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:env.GMAIL_CLIENT_ID,client_secret:env.GMAIL_CLIENT_SECRET,refresh_token:env.GMAIL_REFRESH_TOKEN,grant_type:'refresh_token'})});
  const j=await r.json();if(!r.ok||!j.access_token)throw new Error('Gmail: revisa la autorización de la cuenta.');
  await env.FILES.put('gmail:token:'+(env._gmailAccount||'personal'),j.access_token,{expirationTtl:Math.max(60,(j.expires_in||3600)-300)});return j.access_token;
}
async function api(env,path,body) {
  if(config.gmail?.broker && env.CALENDAR_API) {
    const response=await env.CALENDAR_API.fetch('https://internal/internal/gmail/request',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({account:env._gmailAccount||'personal',path,body})});
    const result=await response.json();if(!response.ok)return {error:result.error||'Correo no autorizado'};return result;
  }
  if(!env.GMAIL_REFRESH_TOKEN)return {error:'Gmail no está conectado. El reenvío de correo no permite buscar en el buzón.'};
  const r=await fetch('https://gmail.googleapis.com/gmail/v1/users/me'+path,{method:body?'POST':'GET',headers:{authorization:'Bearer '+await token(env),'content-type':'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(12000)});
  const j=await r.json();if(!r.ok)throw new Error(`Gmail ${r.status}: no se pudo completar la operación.`);return j;
}
const id=v=>{if(!/^[a-zA-Z0-9_-]{1,180}$/.test(v||''))throw new Error('ID de correo inválido');return v;};
export function decodeText(value) {
  if(!value)return '';
  return new TextDecoder().decode(Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0)));
}
export function messageText(payload) {
  if(payload?.mimeType==='text/plain')return decodeText(payload.body?.data);
  return (payload?.parts||[]).map(messageText).filter(Boolean).join('\n');
}
function summary(m) {
  const headers=m.payload?.headers||[];const h=name=>headers.find(x=>x.name.toLowerCase()===name)?.value||'';
  return {id:m.id,thread_id:m.threadId,from:h('from'),to:h('to'),subject:h('subject'),date:h('date'),text:messageText(m.payload).slice(0,14000)||m.snippet,source:`https://mail.google.com/mail/u/0/#all/${m.id}`};
}
export async function searchMail(env,query,account) {
  const available=gmailAccounts(env);
  if(!available.length)return {error:'No hay cuentas de Gmail autorizadas; el reenvío no da acceso al buzón.'};
  const selected=account?[account]:available;
  const results=[];
  for(const key of selected) {
    try { results.push({account:key,...await searchAccount(accountEnv(env,key),query)}); }
    catch(e) { results.push({account:key,error:e.message}); }
  }
  return {accounts:results};
}
async function searchAccount(env,query) {
  const j=await api(env,'/messages?maxResults=8&q='+encodeURIComponent(String(query||'').slice(0,500)));
  if(j.error)return j;
  const messages=[];
  for(const m of j.messages||[]) {const r=await api(env,`/messages/${id(m.id)}?format=full`);messages.push(summary(r));}
  return {messages,partial:Boolean(j.nextPageToken),read_at:new Date().toISOString()};
}
export async function readMail(env,messageId,account) {
  env=accountEnv(env,account);
  const m=await api(env,`/messages/${id(messageId)}?format=full`);if(m.error)return m;
  const thread=await api(env,`/threads/${id(m.threadId)}?format=full`);if(thread.error)return thread;
  return {messages:(thread.messages||[]).slice(-12).map(summary),partial:(thread.messages||[]).length>12};
}
export async function draftMail(env,{to,subject,body,account}) {
  env=accountEnv(env,account);
  if(!/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(to||'')||/[\r\n]/.test(subject||''))return {error:'Destinatario o asunto inválidos.'};
  const bytes=new TextEncoder().encode(String(body||'').slice(0,16000));
  const encoded=btoa(Array.from(bytes,b=>String.fromCharCode(b)).join(''));
  const subject64=btoa(Array.from(new TextEncoder().encode(String(subject||'').slice(0,300)),b=>String.fromCharCode(b)).join(''));
  const raw=`To: ${to}\r\nSubject: =?UTF-8?B?${subject64}?=\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${encoded}`;
  const j=await api(env,'/drafts',{message:{raw:btoa(raw).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')}});
  return j.error?j:{ok:true,draft_id:j.id,sent:false,nota:'Borrador preparado, no enviado.'};
}
export async function organizeMail(env,{messageId,action,account}) {
  env=accountEnv(env,account);
  if(!['archive','read','unread','star','unstar'].includes(action))return {error:'Acción no permitida'};
  const labels={archive:{removeLabelIds:['INBOX']},read:{removeLabelIds:['UNREAD']},unread:{addLabelIds:['UNREAD']},star:{addLabelIds:['STARRED']},unstar:{removeLabelIds:['STARRED']}};
  const result=await api(env,`/messages/${id(messageId)}/modify`,labels[action]);return result.error?result:{ok:true,id:result.id,action};
}
