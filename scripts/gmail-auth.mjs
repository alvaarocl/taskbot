// OAuth local: guarda el refresh token en archivo 0600, nunca lo imprime.
// GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... node scripts/gmail-auth.mjs --account personal --output /ruta/privada/gmail.env
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { writeFile,chmod } from 'node:fs/promises';
import { parseArgs } from 'node:util';
const {values}=parseArgs({options:{account:{type:'string',default:'personal'},output:{type:'string'},port:{type:'string',default:'8765'}}});
if(!['personal','universidad'].includes(values.account)||!values.output)throw Error('Indica --account personal|universidad y --output privado');
const client=process.env.GMAIL_CLIENT_ID,secret=process.env.GMAIL_CLIENT_SECRET;
if(!client||!secret)throw Error('Faltan GMAIL_CLIENT_ID y GMAIL_CLIENT_SECRET del cliente OAuth de Google.');
const state=randomBytes(24).toString('hex');const redirect=`http://127.0.0.1:${Number(values.port)}/callback`;
const scopes=['https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/gmail.modify','https://www.googleapis.com/auth/gmail.compose'];
const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
url.search=new URLSearchParams({client_id:client,redirect_uri:redirect,response_type:'code',scope:scopes.join(' '),access_type:'offline',prompt:'consent select_account',state}).toString();
const server=http.createServer(async(req,res)=>{
 try {
  const u=new URL(req.url,redirect);
  if(u.pathname!='/callback'||u.searchParams.get('state')!==state){res.writeHead(403);res.end('Solicitud no válida');return;}
  if(!u.searchParams.get('code')){res.writeHead(400);res.end('No se ha autorizado la cuenta');return;}
  const response=await fetch('https://oauth2.googleapis.com/token',{method:'POST',body:new URLSearchParams({client_id:client,client_secret:secret,code:u.searchParams.get('code'),redirect_uri:redirect,grant_type:'authorization_code'})});
  const j=await response.json();if(!response.ok||!j.refresh_token)throw Error('Google no ha devuelto autorización persistente');
  const prefix=values.account==='personal'?'GMAIL':'UNIVERSITY_GMAIL';
  await writeFile(values.output,`${prefix}_CLIENT_ID=${client}\n${prefix}_CLIENT_SECRET=${secret}\n${prefix}_REFRESH_TOKEN=${j.refresh_token}\n`,{mode:0o600,flag:'wx'});
  await chmod(values.output,0o600);res.end('Cuenta autorizada. Puedes cerrar esta pestaña.');console.log('Autorización guardada en el archivo privado indicado. No se ha enviado ningún correo.');server.close();
 }catch {res.writeHead(500);res.end('No se ha podido completar la autorización.');server.close();process.exitCode=1;}
});
server.listen(Number(values.port),'127.0.0.1',()=>{console.log(`Autoriza la cuenta ${values.account} abriendo este enlace:\n${url.href}`);console.log('Caduca en 10 minutos.');});
setTimeout(()=>server.close(),600000).unref();
