import { notificationPolicy } from './proactive.js';
import { submitRuntime, runtimeStatus } from './runtime.js';
import { syncStatus } from './freshness.js';
import { searchMail, readMail, draftMail, organizeMail, gmailStatus } from './gmail.js';
const str=description=>({type:'string',description});
const tool=(name,description,properties={},required=[])=>({type:'function',function:{name,description,parameters:{type:'object',properties,required,additionalProperties:false}}});
export const PERSONAL_TOOLS=[
 tool('avisos_configurar','Consulta o configura por petición explícita las nuevas llamadas urgentes por plazos con hora exacta. No cambia el despertador. Para activarlas necesita silencio y antelación acordados.',{llamadas_urgentes:{type:'boolean'},silencio_desde:str('HH:MM'),silencio_hasta:str('HH:MM'),antelacion_min:{type:'integer'}}),
 tool('tareas_buscar','Busca todas las tareas, notas y materiales por texto o categoría, incluidos sin fecha. IDs solo para herramientas.',{consulta:str('Texto; vacío para listar'),estado:{type:'string',enum:['pendiente','hecha','retirada','todos']}},[]),
 tool('obsidian_buscar','Busca contexto en los proyectos Markdown permitidos. Devuelve fuente y fragmento; lee la nota antes de afirmar detalles.',{consulta:str('Palabras clave')},['consulta']),
 tool('obsidian_leer','Lee una nota recuperada por búsqueda, con su versión.',{ruta:str('Ruta relativa exacta')},['ruta']),
 tool('obsidian_capturar','Captura una idea o nota en Inbox de Obsidian. No reorganiza proyectos.',{texto:str('Contenido indicado por el usuario')},['texto']),
 tool('obsidian_actualizar','Actualiza una nota permitida solo por petición del usuario y con la versión obtenida al leer. Respeta contenido existente.',{ruta:str('Ruta'),contenido:str('Contenido completo actualizado'),version:str('SHA256 devuelto al leer')},['ruta','contenido','version']),
 tool('memoria_ver','Consulta objetivos, hábitos, horarios, decisiones y preferencias confirmadas.',{consulta:str('Filtro opcional')}),
 tool('memoria_recordar','Recuerda solo una declaración explícita del usuario, con su procedencia. No guardar inferencias ni datos financieros.',{texto:str('Hecho confirmado'),tipo:{type:'string',enum:['objetivo','habito','horario','preferencia','decision']},fuente:str('Mensaje/declaración del usuario que lo confirma')},['texto','tipo','fuente']),
 tool('memoria_olvidar','Retira una memoria identificada; solo cuando lo solicita el usuario.',{id:str('ID de memoria')},['id']),
 tool('correo_buscar','Busca mensajes directamente en el buzón conectado, con consulta de Gmail.',{consulta:str('Búsqueda'),cuenta:{type:'string',enum:['personal','universidad']}},['consulta']),
 tool('correo_leer','Lee el hilo de un mensaje encontrado, con enlaces.',{id:str('ID del mensaje'),cuenta:{type:'string',enum:['personal','universidad']}},['id']),
 tool('correo_borrador','Prepara un borrador solicitado. Nunca envía el correo.',{para:str('Email destinatario'),asunto:str('Asunto'),cuerpo:str('Texto'),cuenta:{type:'string',enum:['personal','universidad']}},['para','asunto','cuerpo']),
 tool('correo_organizar','Solo por petición explícita: archivar, marcar leído/no leído o destacar un mensaje. No borra ni envía.',{id:str('ID'),cuenta:{type:'string',enum:['personal','universidad']},accion:{type:'string',enum:['archive','read','unread','star','unstar']}},['id','accion']),
 tool('servicio_estado','Estado de conexiones y última sincronización. Si hay un trabajo pendiente, consulta su ID.',{trabajo:str('ID opcional del trabajo pendiente')}),
];
export const PERSONAL_HANDLERS={
 avisos_configurar:notificationPolicy,
 async tareas_buscar(env,a) {
   const q=String(a.consulta||'').replace(/[\\%_]/g,'\\$&').slice(0,150);
   const status=['pendiente','hecha','retirada'].includes(a.estado)?a.estado:'pendiente';
   const {results}=await env.DB.prepare(`SELECT id,kind,text,status,category,due_date,due_at,start_at,end_at,url,source FROM items WHERE (text LIKE ? ESCAPE '\\' OR category LIKE ? ESCAPE '\\') ${a.estado==='todos'?'':'AND status=?'} ORDER BY COALESCE(due_date,'9999') LIMIT 50`)
     .bind(...[ `%${q}%`, `%${q}%`,...(a.estado==='todos'?[]:[status])]).all();
   return {items:results,partial:results.length===50};
 },
 obsidian_buscar:(e,a)=>submitRuntime(e,'vault.search',{query:a.consulta}),
 obsidian_leer:(e,a)=>submitRuntime(e,'vault.read',{path:a.ruta}),
 obsidian_capturar:(e,a)=>submitRuntime(e,'vault.capture',{text:a.texto}),
 obsidian_actualizar:(e,a)=>submitRuntime(e,'vault.update',{path:a.ruta,content:a.contenido,version:a.version}),
 memoria_ver:(e,a)=>submitRuntime(e,'memory.list',{query:a.consulta}),
 memoria_recordar:(e,a)=>submitRuntime(e,'memory.remember',{text:a.texto,kind:a.tipo,source:a.fuente}),
 memoria_olvidar:(e,a)=>submitRuntime(e,'memory.forget',{id:a.id}),
 correo_buscar:(e,a)=>searchMail(e,a.consulta,a.cuenta),correo_leer:(e,a)=>readMail(e,a.id,a.cuenta),
 correo_borrador:(e,a)=>draftMail(e,{to:a.para,subject:a.asunto,body:a.cuerpo,account:a.cuenta}),
 correo_organizar:(e,a)=>organizeMail(e,{messageId:a.id,action:a.accion,account:a.cuenta}),
 async servicio_estado(env,a) {
   const job=a.trabajo?await env.DB.prepare('SELECT id,status,result,expires_at FROM runtime_jobs WHERE id=?').bind(a.trabajo).first():null;
   return {runtime:await runtimeStatus(env),mail:await gmailStatus(env),sync:await syncStatus(env),...(job?{job:{...job,result:job.result?JSON.parse(job.result):null,expired:job.expires_at<Date.now()}}:{})};
 },
};
