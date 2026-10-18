"""Servicio personal. Solo conexiones salientes; no inicia sesión ni instala servicios por sí solo."""
import asyncio
import json
import logging
import os
import signal
import sqlite3
import time
import urllib.request
from pathlib import Path
from vault import Vault

log=logging.getLogger('taskbot-runtime')

class Worker:
    def __init__(self,config):
        self.base=config['worker_url'].rstrip('/')
        if not self.base.startswith('https://') and not self.base.startswith('http://127.0.0.1:'): raise ValueError('Usa HTTPS o loopback')
        self.token=os.environ['RUNTIME_TOKEN']
        self.relay=config.get('fallback_url')
        self.prefer_relay=bool(config.get('prefer_relay',False))
        if self.relay and not self.relay.startswith('https://'):raise ValueError('El relevo necesita HTTPS')
    def request(self,path,body):
        headers={'authorization':'Bearer '+self.token,'content-type':'application/json','user-agent':'taskbot-runtime/1.0'}
        # Elegir ruta mediante una consulta sin efectos. No repetir una operación incierta en otra ruta.
        if self.relay and not getattr(self,'route_checked',False):
            probe=urllib.request.Request(self.base+'/api/runtime/identity',data=b'{}',headers=headers,method='POST')
            try:
                with urllib.request.urlopen(probe,timeout=3) as response:json.load(response)
                self.prefer_relay=False
            except urllib.error.URLError:self.prefer_relay=True
            self.route_checked=True
        if not self.prefer_relay:
            req=urllib.request.Request(self.base+'/api/runtime'+path,data=json.dumps(body).encode(),headers=headers,method='POST')
        else:
            req=urllib.request.Request(self.relay,data=json.dumps({'path':path,'body':body}).encode(),headers=headers,method='POST')
        try:
            with urllib.request.urlopen(req,timeout=30) as response:return json.load(response)
        except urllib.error.URLError:
            self.route_checked=False
            raise

async def main(config):
    state=Path(config.get('state_dir','~/.local/share/taskbot')).expanduser();state.mkdir(mode=0o700,parents=True,exist_ok=True)
    # Dos copias del servicio no pueden competir por cuenta, notas o trabajos.
    import fcntl
    lock=(state/'daemon.lock').open('w')
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    vault=Vault(config,state);worker=Worker(config)
    cache=sqlite3.connect(state/'jobs.sqlite');cache.execute('CREATE TABLE IF NOT EXISTS results (id TEXT PRIMARY KEY,result TEXT NOT NULL,at REAL NOT NULL)');cache.commit()
    voice=None
    if config.get('voice',{}).get('enabled'):
        from voice import VoiceService
        voice=VoiceService(config['voice'],worker,config)
        try:await voice.start()
        except Exception as e:
            log.warning('Voz no disponible: %s; Obsidian sigue operativo',type(e).__name__)
            try:await voice.stop()
            except Exception:pass
            voice=None
    active={};stop=asyncio.Event();loop=asyncio.get_running_loop()
    for sig in (signal.SIGTERM,signal.SIGINT):loop.add_signal_handler(sig,stop.set)

    async def execute(job):
        key=job['id'];result=None
        try:
            row=cache.execute('SELECT result FROM results WHERE id=?',(key,)).fetchone()
            if row:result=json.loads(row[0])
            elif job['expires_at']<time.time()*1000: result={'error':'expired'}
            elif job['operation']=='call':
                result=await voice.call(job['payload']) if voice else {'error':'Voz no configurada'}
            else: result=await asyncio.to_thread(vault.execute,job['operation'],job['payload'],key)
        except Exception as e:
            # No registrar contenido de notas, audio o credenciales.
            log.warning('job %s: %s',key,type(e).__name__);result={'error':str(e)[:300]}
        cache.execute('INSERT OR REPLACE INTO results VALUES (?,?,?)',(key,json.dumps(result),time.time()));cache.commit()
        # Si falla la entrega se conserva en disco y se reenvía cuando se reclame otra vez.
        try:await asyncio.to_thread(worker.request,'/jobs/result',{'id':key,'lease':job['lease'],'result':result})
        except Exception:log.warning('Resultado pendiente de entregar: %s',key)
        active.pop(key,None)

    heartbeat=0
    try:
        while not stop.is_set():
            try:
                if time.monotonic()-heartbeat>30:
                    await asyncio.to_thread(worker.request,'/heartbeat',{'vault':True,'voice':bool(voice and voice.ready)})
                    for job,_task in list(active.values()):
                        await asyncio.to_thread(worker.request,'/jobs/lease',{'id':job['id'],'lease':job['lease']})
                    heartbeat=time.monotonic()
                if len(active)<4:
                    res=await asyncio.to_thread(worker.request,'/jobs/claim',{})
                    job=res.get('job')
                    if job:
                        task=asyncio.create_task(execute(job));active[job['id']]=(job,task)
                await asyncio.wait_for(stop.wait(),timeout=float(config.get('poll_interval',5 if worker.prefer_relay else 1.5)))
            except asyncio.TimeoutError:pass
            except Exception as e:
                log.warning('Conexión pendiente: %s',type(e).__name__)
                try:await asyncio.wait_for(stop.wait(),timeout=5)
                except asyncio.TimeoutError:pass
    finally:
        for _,task in active.values():task.cancel()
        await asyncio.gather(*(task for _,task in list(active.values())),return_exceptions=True)
        if voice:await voice.stop()
        cache.close();lock.close()

if __name__=='__main__':
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);args=parser.parse_args()
    logging.basicConfig(level=logging.INFO,format='%(asctime)s %(name)s %(levelname)s %(message)s')
    asyncio.run(main(json.loads(Path(args.config).expanduser().read_text())))
