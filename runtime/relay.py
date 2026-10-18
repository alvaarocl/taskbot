"""Relevo opcional: solo el Worker propio, rutas permitidas y autenticación independiente."""
import json
import os
import urllib.request
import urllib.error
import modal
secret=modal.Secret.from_name('taskbot-runtime')
app=modal.App('taskbot-runtime-relay')
image=modal.Image.debian_slim(python_version='3.13').pip_install('fastapi==0.146.0')
ALLOWED={'/identity','/status','/heartbeat','/jobs/claim','/jobs/result','/jobs/lease','/voice/session','/voice/turn','/voice/report','/assistant/generate','/mail/authorize','/mail/exchange','/mail/status'}

def forward(path,body):
    if path not in ALLOWED:return {'error':'path'},400
    data=json.dumps(body).encode()
    if len(data)>2000000:return {'error':'too large'},413
    req=urllib.request.Request('https://taskbot.alvarocarpintero2.workers.dev/api/runtime'+path,data=data,headers={'authorization':'Bearer '+os.environ['RUNTIME_TOKEN'],'content-type':'application/json','user-agent':'taskbot-runtime-relay/1.0'})
    try:
        with urllib.request.urlopen(req,timeout=25) as response:return json.load(response),response.status
    except urllib.error.HTTPError as e:
        try:return json.load(e),e.code
        except Exception:return {'error':'upstream'},e.code

@app.function(image=image,secrets=[secret],cpu=0.125,memory=128,timeout=35,scaledown_window=2,max_containers=2)
def relay_rpc(path:str,body:dict):
    # El transporte RPC ya requiere las credenciales de esta cuenta Modal.
    result,status=forward(path,body)
    if status>=400:raise RuntimeError('Worker returned '+str(status)+': '+str(result.get('error','failed')))
    return result

@app.function(image=image,secrets=[secret],cpu=0.125,memory=128,timeout=35,scaledown_window=2,max_containers=2)
@modal.asgi_app()
def relay():
    from fastapi import FastAPI,Request
    from fastapi.responses import JSONResponse
    api=FastAPI()
    @api.post('/')
    async def proxy(request:Request):
        import asyncio,hmac
        if not hmac.compare_digest(request.headers.get('authorization',''),'Bearer '+os.environ['RUNTIME_TOKEN']):return JSONResponse({'error':'unauthorized'},status_code=401)
        raw=await request.body()
        if len(raw)>2000000:return JSONResponse({'error':'too large'},status_code=413)
        try:
            body=json.loads(raw);result,status=await asyncio.to_thread(forward,body.get('path'),body.get('body',{}))
            return JSONResponse(result,status_code=status)
        except Exception:return JSONResponse({'error':'upstream unavailable'},status_code=503)
    return api
