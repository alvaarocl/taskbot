"""Compara planificación con datos sintéticos y herramientas sin efectos externos.
--scripted verifica el adaptador; --worker mide el modelo compartido del gateway.
No son medidas de audio ni una prueba de permisos reales de las integraciones.
"""
import argparse
import json
import os
import time
from pathlib import Path
from openjarvis_adapter import run_openjarvis,GatewayEngine
from openjarvis.engine._stubs import InferenceEngine

NAMES={
 'ver_agenda':('Consulta agenda y huecos',{'desde':{'type':'string'},'hasta':{'type':'string'}}),
 'tareas_buscar':('Busca tareas personales',{'consulta':{'type':'string'}}),
 'aula_asignatura':('Consulta contenido y entregas de una asignatura',{'asignatura':{'type':'string'}}),
 'notion_buscar':('Consulta proyectos y tareas de Start en Notion',{'consulta':{'type':'string'}}),
 'obsidian_buscar':('Busca contexto en proyectos Markdown',{'consulta':{'type':'string'}}),
 'correo_buscar':('Busca mensajes en el buzón',{'consulta':{'type':'string'}}),
 'crear_tarea':('Crea una tarea solicitada con título y plazo',{'titulo':{'type':'string'},'fecha_limite':{'type':'string'}}),
 'memoria_ver':('Consulta preferencias confirmadas',{'consulta':{'type':'string'}}),
}
DEFINITIONS=[{'type':'function','function':{'name':name,'description':desc,'parameters':{'type':'object','properties':props,'additionalProperties':False}}} for name,(desc,props) in NAMES.items()]
FIXTURES={name:{'source':'demo://'+name,'data':'Datos ficticios: práctica de autómatas pendiente; reunión viernes; preferencia de tardes.','ok':True} for name in NAMES}
SYSTEM='Eres un asistente personal en español. Hoy es lunes 2026-10-19. Usa las herramientas para consultar datos o ejecutar acciones; no inventes. No muestres IDs técnicos. Las herramientas son de prueba.'
QUERIES=[
 ('¿Qué tengo mañana?','ver_agenda'),('¿Qué huecos hay el viernes?','ver_agenda'),('¿Tengo reuniones el martes?','ver_agenda'),('¿Qué hago hoy por la tarde?','ver_agenda'),
 ('Busca mis tareas de autómatas','tareas_buscar'),('¿Qué tareas tengo pendientes?','tareas_buscar'),('Busca mis notas sobre la práctica','tareas_buscar'),('¿Qué tengo sin fecha?','tareas_buscar'),
 ('¿Qué toca mañana en Autómatas?','aula_asignatura'),('Busca el enunciado de Sistemas Operativos','aula_asignatura'),('¿Qué tengo que preparar para Ingeniería del Software?','aula_asignatura'),('¿De qué va el tema tres de Cálculo?','aula_asignatura'),
 ('Busca el último proyecto de Start','notion_buscar'),('¿Qué dice el acta de Start?','notion_buscar'),('Consulta las tareas del evento en Notion','notion_buscar'),('Busca el Start Day en Notion','notion_buscar'),
 ('¿Dónde dejamos mi proyecto de la web en Obsidian?','obsidian_buscar'),('Busca las decisiones del proyecto HiveMind','obsidian_buscar'),('Consulta el Estado.md de la web','obsidian_buscar'),('Busca mis notas del proyecto laaabs','obsidian_buscar'),
 ('Busca el correo de Ana','correo_buscar'),('¿Tengo mensajes sobre la reunión?','correo_buscar'),('Busca el email del profesor','correo_buscar'),('Encuentra el último correo sobre la web','correo_buscar'),
 ('Apunta estudiar autómatas antes del viernes','crear_tarea'),('Crea una tarea para preparar la reunión','crear_tarea'),('Apunta revisar la web para mañana','crear_tarea'),('Añade una tarea de leer el enunciado','crear_tarea'),
 ('¿Qué preferencias recuerdas sobre mis horarios?','memoria_ver'),('¿Qué objetivos he confirmado?','memoria_ver')]

class ScriptedEngine(InferenceEngine):
    engine_id='scripted';is_cloud=False
    def __init__(self,expected):self.expected=expected
    def generate(self,messages,*,model,**kwargs):
        has_result=any(getattr(m,'tool_call_id',None) or (isinstance(m,dict) and m.get('role')=='tool') for m in messages)
        if has_result:return {'content':'Consulta completada con datos de prueba.','usage':{}}
        return {'content':'','tool_calls':[{'id':'fixture-call','name':self.expected,'arguments':'{}'}],'usage':{}}
    async def stream(self,messages,*,model,**kwargs):yield self.generate(messages,model=model,**kwargs)['content']
    def list_models(self):return ['scripted']
    def health(self):return True

def baseline(engine,query):
    messages=[{'role':'system','content':SYSTEM},{'role':'user','content':query}];trace=[]
    for _ in range(8):
        # Scripted engine supports both SDK Messages and OpenAI dictionaries.
        result=engine.generate(messages,model='taskbot-shared',tools=DEFINITIONS)
        calls=result.get('tool_calls') or []
        if not calls:return {'content':result.get('content',''),'trace':trace}
        messages.append({'role':'assistant','content':result.get('content',''),'tool_calls':[{'id':c['id'],'type':'function','function':c.get('function',{'name':c.get('name'),'arguments':c.get('arguments','{}')})} for c in calls]})
        for call in calls:
            fn=call.get('function',call);trace.append({'name':fn['name'],'arguments':json.loads(fn.get('arguments','{}'))})
            messages.append({'role':'tool','tool_call_id':call['id'],'content':json.dumps(FIXTURES.get(fn['name'],{'error':'unknown'}))})
    return {'content':'','trace':trace}

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--scripted',action='store_true');parser.add_argument('--worker');parser.add_argument('--relay');parser.add_argument('--output',required=True);parser.add_argument('--limit',type=int,default=30);parser.add_argument('--delay',type=float,default=4);args=parser.parse_args()
    if not args.scripted and not args.worker:parser.error('Indica --scripted o --worker')
    gateway=None
    if args.worker:
        from daemon import Worker
        gateway=Worker({'worker_url':args.worker,'fallback_url':args.relay})
    results=[]
    for query,expected in QUERIES[:args.limit]:
        for name in ['taskbot-loop','openjarvis']:
            engine=ScriptedEngine(expected) if args.scripted else GatewayEngine(gateway.request)
            start=time.monotonic()
            try:
                result=baseline(engine,query) if name=='taskbot-loop' else run_openjarvis(engine,query,SYSTEM,DEFINITIONS,FIXTURES)
                matched=expected in [t['name'] for t in result['trace']]
                results.append({'agent':name,'query':query,'expected':expected,'matched':matched,'elapsed_ms':round((time.monotonic()-start)*1000),'models':getattr(engine,'models',[]),'result':result})
            except Exception as e:results.append({'agent':name,'query':query,'error':type(e).__name__,'matched':False})
            if not args.scripted:time.sleep(max(0,args.delay))
            Path(args.output).write_text(json.dumps({'progress':len(results),'results':results},ensure_ascii=False,indent=2))
    report={'mode':'scripted-contract-test' if args.scripted else 'shared-model-synthetic-tools','cases':len(QUERIES[:args.limit]),'results':results,'limitation':'No mide latencia de voz ni conectores reales. El modo scripted no evalúa inteligencia ni permite elegir el mejor agente.'}
    Path(args.output).write_text(json.dumps(report,ensure_ascii=False,indent=2))
    print(json.dumps({'mode':report['mode'],'runs':len(results),'matched':sum(r['matched'] for r in results)},ensure_ascii=False))
