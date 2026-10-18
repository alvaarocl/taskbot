"""Cuenta Jarvis persistente. py-tgcalls acepta la llamada entrante al hacer play()."""
import asyncio
import base64
import json
import logging
import os
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'jarvis'))
from conversation import Pump,Ears,to_pcm,to_wav,sentences,OUT_RATE,IN_RATE

log=logging.getLogger('taskbot-voice')

class VoiceService:
    def __init__(self,config,worker,runtime_config):
        self.config=config;self.worker=worker;self.owner=int(config['owner_id']);self.ready=False
        self.lock=asyncio.Lock();self.ended=asyncio.Event();self.pump=None;self.ears=None;self.tasks=set();self.speech_lock=asyncio.Lock()

    async def start(self):
        from telethon import TelegramClient
        from telethon.sessions import StringSession
        from pytgcalls import PyTgCalls,filters
        from pytgcalls.types import ChatUpdate,Direction,Device,StreamFrames
        self.client=TelegramClient(StringSession(os.environ['TG_SESSION']),int(os.environ['TG_API_ID']),os.environ['TG_API_HASH'])
        await self.client.connect()
        if not await self.client.is_user_authorized(): raise RuntimeError('La sesión de Jarvis no está autorizada; usa jarvis/login.py')
        self.calls=PyTgCalls(self.client)
        @self.calls.on_update(filters.chat_update(ChatUpdate.Status.INCOMING_CALL))
        async def incoming(_,update):
            if update.chat_id!=self.owner or self.lock.locked():
                try:await self.calls.leave_call(update.chat_id)
                except Exception:pass
                return
            task=asyncio.create_task(self.call({'incoming':True}));self.tasks.add(task);task.add_done_callback(self.tasks.discard)
        @self.calls.on_update(filters.chat_update(ChatUpdate.Status.LEFT_CALL))
        async def ended(_,update):
            if update.chat_id==self.owner:self.ended.set()
        @self.calls.on_update(filters.stream_frame(Direction.INCOMING,Device.MICROPHONE))
        async def frames(_,update:StreamFrames):
            if update.chat_id==self.owner and self.ears:
                for frame in update.frames:self.ears.feed(frame.frame)
        await self.calls.start();self.ready=True

    def api(self,path,body):
        return self.worker.request('/voice/'+path,body)

    async def speak(self,text,pump):
        import edge_tts
        # Cada frase tiene un archivo propio: dos síntesis nunca pisan /tmp/raw.wav.
        async with self.speech_lock:
            pump.cut=False
            for phrase in sentences(text):
                if pump.cut:return
                with tempfile.TemporaryDirectory(prefix='taskbot-voice-') as directory:
                    audio=Path(directory)/'voice.mp3'
                    await asyncio.wait_for(edge_tts.Communicate(phrase,self.config.get('voice','es-ES-AlvaroNeural')).save(str(audio)),timeout=18)
                    pcm=await asyncio.to_thread(to_pcm,audio.read_bytes())
                if pump.cut:return
                pump.say(pcm)
            await pump.done()

    async def call(self,payload):
        from pytgcalls.types import MediaStream,ExternalMedia,RecordStream
        from pytgcalls.types.raw import AudioParameters
        # Esperar al horario sin bloquear llamadas entrantes ni consumir la duración de conversación.
        if payload.get('wake_at'):
            from datetime import datetime
            when=datetime.fromisoformat(payload['wake_at']).timestamp()
            if when-time.time()>0:await asyncio.sleep(when-time.time())
            if time.time()-when>120:return {'error':'expired call'}
        # Nunca poner una llamada entrante en espera detrás de una llamada activa.
        if self.lock.locked():return {'error':'busy'}
        async with self.lock:
            target=self.owner;self.ended.clear();job=payload.get('job');started=time.monotonic();pump=None
            try:
                await asyncio.wait_for(self.calls.play(target,MediaStream(ExternalMedia.AUDIO,AudioParameters(bitrate=OUT_RATE,channels=1))),timeout=45)
                if not job:
                    session=await asyncio.to_thread(self.api,'session',{})
                    job=session['job'];opening=session['opening']
                else:
                    session=await asyncio.to_thread(self.api,'session',{'job':job})
                    opening=session.get('opening') or 'Hola. ¿En qué te ayudo?'
                await asyncio.to_thread(self.api,'report',{'job':job,'status':'answered'})
                pump=Pump(self.calls,target);self.pump=pump;self.ears=Ears(pump)
                await self.calls.record(target,RecordStream(audio=True,audio_parameters=AudioParameters(bitrate=IN_RATE,channels=1)))
                pump.task=asyncio.create_task(pump.run());await self.speak(opening,pump)
                self.ears.heard_at=time.monotonic();nudged=False
                while not self.ended.is_set() and time.monotonic()-started<self.config.get('max_minutes',12)*60:
                    try:pcm=await asyncio.wait_for(self.ears.phrases.get(),timeout=1)
                    except asyncio.TimeoutError:
                        idle=time.monotonic()-max(self.ears.heard_at,pump.last_voice)
                        if idle>65:break
                        if idle>40 and not nudged:await self.speak('¿Sigues ahí?',pump);nudged=True
                        continue
                    nudged=False;t0=time.monotonic();generation=self.ears.heard_at
                    response=await asyncio.to_thread(self.api,'turn',{'job':job,'audio':base64.b64encode(to_wav(pcm)).decode()})
                    log.info('turn total_before_tts_ms=%d',round((time.monotonic()-t0)*1000))
                    if self.ended.is_set():break
                    # Si el usuario ha continuado hablando, procesar lo nuevo antes de leer respuesta obsoleta.
                    if self.ears.in_speech or not self.ears.phrases.empty():continue
                    if response.get('reply'):await self.speak(response['reply'],pump)
                    if response.get('end'):break
                return {'ok':True,'job':job}
            except asyncio.CancelledError:raise
            except Exception as e:
                log.warning('call failure: %s',type(e).__name__)
                if job:
                    try:await asyncio.to_thread(self.api,'report',{'job':job,'status':'failed'})
                    except Exception:pass
                return {'error':type(e).__name__}
            finally:
                self.ears=None;self.pump=None
                if pump and pump.task:pump.task.cancel();await asyncio.gather(pump.task,return_exceptions=True)
                try:await self.calls.leave_call(target)
                except Exception:pass

    async def stop(self):
        self.ready=False;self.ended.set()
        for task in list(self.tasks):task.cancel()
        await asyncio.gather(*self.tasks,return_exceptions=True)
        if self.lock.locked():
            try:await self.calls.leave_call(self.owner)
            except Exception:pass
        await self.client.disconnect()
