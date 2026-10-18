"""Adaptador de evaluación: OpenJarvis usa herramientas de prueba, nunca el bot de producción."""
import json
from openjarvis.agents.orchestrator import OrchestratorAgent
from openjarvis.engine._stubs import InferenceEngine
from openjarvis.engine._base import messages_to_dicts
from openjarvis.tools._stubs import BaseTool,ToolSpec
from openjarvis.core.types import ToolResult

class GatewayEngine(InferenceEngine):
    engine_id='taskbot-gateway';is_cloud=True
    def __init__(self,request):self.request=request;self.models=[]
    def generate(self,messages,*,model,**kwargs):
        result=self.request('/assistant/generate',{'messages':messages if messages and isinstance(messages[0],dict) else messages_to_dicts(messages),'tools':kwargs.get('tools',[])})
        self.models.append(result.get('model',result.get('provider','unknown')))
        message=result['message']
        return {'content':message.get('content',''),'tool_calls':[{'id':c['id'],'name':c.get('function',c)['name'],'arguments':c.get('function',c).get('arguments','{}')} for c in message.get('tool_calls',[])],'usage':result.get('usage',{})}
    async def stream(self,messages,*,model,**kwargs):
        yield self.generate(messages,model=model,**kwargs)['content']
    def list_models(self):return ['taskbot-shared']
    def health(self):return True

class FixtureTool(BaseTool):
    def __init__(self,spec,fixtures,trace):self.definition=spec;self.fixtures=fixtures;self.trace=trace;self.tool_id=spec['name']
    @property
    def spec(self):return ToolSpec(name=self.tool_id,description=self.definition['description'],parameters=self.definition['parameters'])
    def execute(self,**params):
        self.trace.append({'name':self.tool_id,'arguments':params})
        result=self.fixtures.get(self.tool_id,{'error':'Fixture no disponible'})
        return ToolResult(tool_name=self.tool_id,content=json.dumps(result,ensure_ascii=False),success='error' not in result)

def run_openjarvis(engine,query,system,definitions,fixtures):
    trace=[];tools=[FixtureTool(s['function'],fixtures,trace) for s in definitions]
    agent=OrchestratorAgent(engine,model='taskbot-shared',tools=tools,max_turns=8,temperature=0,max_tokens=700,system_prompt=system,parallel_tools=False)
    result=agent.run(query)
    return {'content':result.content,'trace':trace,'turns':result.turns}
