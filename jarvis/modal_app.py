"""Jarvis en Modal: la voz natural (OmniVoice clonando una voz de referencia) y la llamada por Telegram.

  - Voice (con GPU, se apaga sola a los 2 min sin uso): texto → audio con la voz de /voz/ref.wav del volumen
    "jarvis" (+ /voz/ref.txt, lo que se dice en ella) y el efecto de asistente.
  - call (sin GPU, barato): pide el encargo a taskbot, espera hasta poco antes de la hora, genera la voz y llama
    (jarvis/call.py: dial).
  - start: endpoint web al que taskbot manda {job, wake_at, token}.

Desplegar:  modal deploy jarvis/modal_app.py
Necesita: volumen "jarvis" con la voz y secreto "jarvis" (TG_API_ID, TG_API_HASH, TG_SESSION, REPORT_URL, REPORT_TOKEN).
"""

import os
import re
import subprocess
from datetime import datetime, timezone

import modal

app = modal.App("jarvis")
vol = modal.Volume.from_name("jarvis", create_if_missing=True)
secret = modal.Secret.from_name("jarvis")
HERE = os.path.dirname(os.path.abspath(__file__))

voice_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg")
    .pip_install("torch==2.8.0", "torchaudio==2.8.0", "omnivoice==0.2.1", "soundfile")
    .env({"HF_HOME": "/vol/hf"})  # el modelo (3,3 GB) se descarga una vez y se queda en el volumen
)
call_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg")
    .pip_install("telethon==1.45.0", "py-tgcalls==3.0.0", "fastapi[standard]")
    .add_local_file(os.path.join(HERE, "call.py"), "/root/call.py")
    .add_local_file(os.path.join(HERE, "conversation.py"), "/root/conversation.py")
)

# Efecto de asistente: algo de brillo y un eco corto, metálico.
FX = "highpass=f=90,equalizer=f=3500:t=q:w=1.2:g=3,aecho=0.8:0.6:18|36:0.25|0.15,volume=1.1"
SPEED = 0.96  # algo pausado, estilo mayordomo


def chunks(text, limit=260):
    """Frases agrupadas hasta ~260 caracteres: en textos largos la voz clonada pierde calidad."""
    out, cur = [], ""
    for s in re.split(r"(?<=[.!?¿¡…])\s+", text.strip()):
        if cur and len(cur) + len(s) > limit:
            out.append(cur)
            cur = s
        else:
            cur = f"{cur} {s}".strip()
    if cur:
        out.append(cur)
    return out


@app.cls(gpu="T4", image=voice_image, volumes={"/vol": vol}, scaledown_window=120, timeout=900)
class Voice:
    @modal.enter()
    def load(self):
        import torch
        from omnivoice import OmniVoice

        self.model = OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map="cuda", dtype=torch.float16)
        self.ref_text = open("/vol/voz/ref.txt").read().strip()
        vol.commit()  # guarda el modelo descargado para la próxima vez

    @modal.method()
    def speak(self, text: str, lead_ms: int = 500) -> bytes:
        import numpy as np
        import soundfile as sf
        import torch

        parts = []
        pause = np.zeros(int(24000 * 0.25), dtype=np.float32)
        for i, piece in enumerate(chunks(text)):
            torch.manual_seed(11 + i)
            audio = self.model.generate(text=piece, language="es", ref_audio="/vol/voz/ref.wav", ref_text=self.ref_text, speed=SPEED)
            parts += [np.asarray(audio[0], dtype=np.float32), pause]
        sf.write("/tmp/raw.wav", np.concatenate(parts), 24000)
        # Medio segundo de silencio al principio: al descolgar se pierde el comienzo del audio.
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", "/tmp/raw.wav", "-af", f"adelay={max(1, lead_ms)},{FX}", "-ar", "48000", "-ac", "1", "-b:a", "96k", "/tmp/out.mp3"], check=True)
        return open("/tmp/out.mp3", "rb").read()


@app.function(image=call_image, secrets=[secret], timeout=2400, cpu=1.0, memory=1024)
async def call(job: str, wake_at: str):
    import asyncio
    import sys

    sys.path.insert(0, "/root")
    os.environ["JOB"] = job
    import call as caller  # jarvis/call.py

    data = caller.taskbot("GET", query=f"?job={job}")
    if not data.get("text"):
        caller.log("taskbot no tiene el encargo (caducado o código erróneo)")
        return 1
    when = datetime.fromisoformat(wake_at)
    if data.get("opening"):
        # Llamada con conversación: saludo con pregunta y turnos (jarvis/conversation.py).
        from telethon import TelegramClient
        from telethon.sessions import StringSession
        import conversation

        left = (when - datetime.now(timezone.utc)).total_seconds() - 150
        if left > 0:
            caller.log(f"esperando {int(left)} s para preparar la voz")
            await asyncio.sleep(left)
        client = TelegramClient(StringSession(os.environ["TG_SESSION"]), int(os.environ["TG_API_ID"]), os.environ["TG_API_HASH"])
        await client.start()
        voice = Voice()
        try:
            return await conversation.converse(
                client, int(data["target"]), when, data["opening"], job,
                speak=lambda text, lead: voice.speak.remote(text, lead), taskbot=caller.taskbot,
                log=caller.log, report=caller.report)
        finally:
            await client.disconnect()
    # La voz se genera ~3 min antes: así la GPU solo se paga mientras genera, no mientras espera.
    left = (when - datetime.now(timezone.utc)).total_seconds() - 180
    if left > 0:
        caller.log(f"esperando {int(left)} s para generar la voz")
        await asyncio.sleep(left)
    caller.log("generando la voz (OmniVoice)")
    audio = await Voice().speak.remote.aio(data["text"])
    open("/tmp/briefing.mp3", "wb").write(audio)
    return await caller.dial(int(data["target"]), "/tmp/briefing.mp3", when)


@app.function(image=call_image, secrets=[secret])
@modal.fastapi_endpoint(method="POST")
def start(body: dict):
    if body.get("token") != os.environ["REPORT_TOKEN"]:
        return {"error": "unauthorized"}
    call.spawn(body["job"], body["wake_at"])
    return {"ok": True}


@app.local_entrypoint()
def prueba(texto: str = "Buenos días, señor. Son las ocho en punto, y me temo que hoy no podrá quedarse en la cama. ¿Desea algo más?", salida: str = "jarvis_prueba.mp3"):
    """modal run jarvis/modal_app.py --texto "…": genera la voz y la guarda aquí, sin llamar a nadie."""
    import time

    t0 = time.time()
    open(salida, "wb").write(Voice().speak.remote(texto))
    print(f"{salida} en {time.time() - t0:.0f} s")


@app.function(image=call_image, secrets=[secret], timeout=300)
def turno(audio_wav: bytes) -> dict:
    """Un turno de conversación sin llamada: audio → taskbot (transcribe y responde) → voz de Jarvis."""
    import base64
    import sys

    sys.path.insert(0, "/root")
    os.environ.setdefault("JOB", "test")
    import call as caller

    res = caller.taskbot("POST", {"test": True, "audio": base64.b64encode(audio_wav).decode()}, "/turn")
    if res.get("reply"):
        res["mp3"] = Voice().speak.remote(res["reply"], 0)
    return res


@app.local_entrypoint()
def prueba_turno(wav: str, salida: str = "jarvis_turno.mp3"):
    """modal run jarvis/modal_app.py::prueba_turno --wav pregunta.wav: lo que oye, lo que responde y su voz."""
    import time

    t0 = time.time()
    res = turno.remote(open(wav, "rb").read())
    if res.get("mp3"):
        open(salida, "wb").write(res.pop("mp3"))
    print(f"[{time.time() - t0:.1f} s] oído: {res.get('heard')!r}\nrespuesta: {res.get('reply')!r} · fin: {res.get('end')}")
