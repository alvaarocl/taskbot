// Consentimiento local usando el cliente OAuth del servicio de reservas. No muestra ni recibe tokens OAuth.
import http from 'node:http';
import {readFileSync,statSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseArgs} from 'node:util';
const {values}=parseArgs({options:{account:{type:'string',default:'personal'}}});
if(!['personal','universidad'].includes(values.account))throw Error('Cuenta: personal o universidad');
const privateFile=join(homedir(),'.config/taskbot/runtime.env');
if(statSync(privateFile).mode&0o077)throw Error('El archivo privado necesita permisos 0600');
const env=Object.fromEntries(readFileSync(privateFile,'utf8').split('\n').filter(l=>l&&!l.startsWith('#')).map(l=>{const i=l.indexOf('=');return [l.slice(0,i),l.slice(i+1)]}));
const settings=JSON.parse(readFileSync(join(homedir(),'.config/taskbot/runtime.json'),'utf8'));
async function api(path,body){
 const relay=settings.fallback_url;
 const response=await fetch(relay||settings.worker_url+'/api/runtime'+path,{method:'POST',headers:{authorization:'Bearer '+env.RUNTIME_TOKEN,'content-type':'application/json'},body:JSON.stringify(relay?{path,body}:body),signal:AbortSignal.timeout(35000)});
 const result=await response.json();if(!response.ok){if(result.activation_url)spawnSync('open',[result.activation_url],{stdio:'ignore'});throw Error(result.error||'No se ha podido completar la autorización');}return result;
}
let state;
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,'http://127.0.0.1:8765');
 if(url.pathname!='/callback'||url.searchParams.get('state')!==state){res.writeHead(400).end('Solicitud no válida.');return;}
 try{
  if(!url.searchParams.get('code'))throw Error('No has autorizado el acceso. Puedes cerrar esta ventana.');
  const result=await api('/mail/exchange',{state,code:url.searchParams.get('code')});
  res.setHeader('Content-Type','text/plain; charset=utf-8');res.end('Cuenta conectada. Puedes cerrar esta pestaña.');
  console.log('Cuenta '+result.account+' conectada: '+result.email+'. No se ha enviado ningún correo.');
 }catch(e){res.writeHead(400,{'Content-Type':'text/plain; charset=utf-8'}).end(e.message);console.log(e.message);process.exitCode=1;}
 finally{server.close();}
});
server.listen(8765,'127.0.0.1',async()=>{
 try{
  const result=await api('/mail/authorize',{account:values.account});state=result.state;
  console.log('Autoriza tu cuenta '+values.account+' en el navegador. Puedes cancelar sin conectar nada.');
  spawnSync('open',[result.url],{stdio:'ignore'});
 }catch(e){console.log(e.message);server.close();process.exitCode=1;}
});
server.on('error',()=>{console.log('El puerto local 8765 está ocupado. Cierra otra autorización de Google antes de intentarlo.');process.exitCode=1;});
setTimeout(()=>server.close(),600000).unref();
