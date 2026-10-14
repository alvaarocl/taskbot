"""Jarvis: te llama por Telegram a la hora de despertarte y te cuenta el día.

Lo lanza taskbot (workflow_dispatch de GitHub Actions) un rato antes de la hora; el texto ya escrito se pide a
taskbot con el código del encargo (así no aparece en los registros de GitHub).
Este script: texto → voz (edge-tts) → espera a la hora → llama desde la cuenta "Jarvis" (Telethon + py-tgcalls)
→ reproduce el audio → cuelga. Si no lo coges o falla la conexión, vuelve a llamar. Al final le dice a taskbot
cómo ha ido (para que te deje el resumen por escrito si no lo cogiste).

Variables (secretos de GitHub y entradas del workflow):
  TG_API_ID, TG_API_HASH, TG_SESSION  cuenta Jarvis (sesión de jarvis/login.py)
  WAKE_AT                             hora de la llamada, ISO con zona (2026-10-15T08:00:00+02:00)
  JOB                                 código del encargo en taskbot
  REPORT_URL, REPORT_TOKEN            taskbot (/api/jarvis): de ahí sale el texto, a quién llamar y la voz,
                                      y ahí se avisa del resultado
No imprime el texto ni ningún secreto: los registros solo dicen qué paso se está dando.
"""

import asyncio
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

import edge_tts
from pytgcalls import PyTgCalls, filters
from pytgcalls.exceptions import CallBusy, CallDeclined, CallDiscarded, TimedOutAnswer
from telethon.errors import UserPrivacyRestrictedError
from pytgcalls.types import ChatUpdate, MediaStream, StreamEnded
from telethon import TelegramClient
from telethon.sessions import StringSession

ATTEMPTS = 3          # llamadas como mucho
RETRY_WAIT = 60       # segundos entre llamadas si no lo coges
CONNECT_RETRIES = 2   # la conexión de audio a veces no arranca: se repite la llamada al momento
AUDIO = "briefing.mp3"


def log(msg):
    print(f"[{datetime.now(timezone.utc).strftime('%H:%M:%S')}] {msg}", flush=True)


# Cloudflare bloquea el user-agent por defecto de Python: hay que presentarse.
HEADERS = {"authorization": f"Bearer {os.environ['REPORT_TOKEN']}", "content-type": "application/json", "user-agent": "jarvis/1.0 (taskbot)"}


def taskbot(method, body=None, query=""):
    req = urllib.request.Request(os.environ["REPORT_URL"] + query, method=method, headers=HEADERS,
                                 data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def report(status, attempts):
    try:
        taskbot("POST", {"status": status, "attempts": attempts, "job": os.environ["JOB"]})
    except Exception as e:  # el aviso no puede tumbar la llamada
        log(f"no he podido avisar a taskbot: {type(e).__name__} {getattr(e, 'code', '')}")


async def speak(text, voice):
    # Un segundo de margen al empezar: al descolgar se pierde el principio del audio.
    await edge_tts.Communicate("... " + text, voice, rate="+4%").save(AUDIO)


async def wait_until(when):
    left = (when - datetime.now(timezone.utc)).total_seconds()
    if left > 0:
        log(f"esperando {int(left)} s hasta la hora")
        await asyncio.sleep(left)


async def main():
    job = taskbot("GET", query=f"?job={os.environ['JOB']}")
    if not job.get("text"):
        log("taskbot no tiene el encargo (caducado o código erróneo)")
        return 1
    target = int(job["target"])
    wake_at = datetime.fromisoformat(os.environ["WAKE_AT"])

    log("generando la voz")
    await speak(job["text"], job.get("voice") or "es-ES-AlvaroNeural")

    client = TelegramClient(StringSession(os.environ["TG_SESSION"]), int(os.environ["TG_API_ID"]), os.environ["TG_API_HASH"])
    calls = PyTgCalls(client)
    finished = asyncio.Event()

    @calls.on_update(filters.stream_end())
    async def _ended(_, update: StreamEnded):
        finished.set()

    @calls.on_update(filters.chat_update(ChatUpdate.Status.DISCARDED_CALL))
    async def _hung_up(_, update: ChatUpdate):
        finished.set()  # has colgado a mitad: vale como escuchado

    await client.start()
    await calls.start()
    await wait_until(wake_at)

    stream = MediaStream(AUDIO, video_flags=MediaStream.Flags.IGNORE)
    status, attempt = "no_answer", 0
    while attempt < ATTEMPTS and status != "answered":
        attempt += 1
        for _ in range(CONNECT_RETRIES + 1):
            log(f"llamando (intento {attempt})")
            finished.clear()
            try:
                await calls.play(target, stream)
            except UserPrivacyRestrictedError:
                log("tu privacidad de Telegram no deja llamar a esta cuenta")
                report("privacy", attempt)
                await client.disconnect()
                return 3
            except (TimedOutAnswer, CallDeclined, CallBusy, CallDiscarded) as e:
                log(f"sin respuesta: {type(e).__name__}")
                break  # no lo ha cogido: esperar antes de volver a llamar
            except Exception as e:
                log(f"la conexión no ha arrancado ({type(e).__name__}); repito")
                await asyncio.sleep(3)
                continue
            log("descolgado: reproduciendo")
            try:
                await asyncio.wait_for(finished.wait(), timeout=600)
            except asyncio.TimeoutError:
                pass
            await asyncio.sleep(1.5)
            try:
                await calls.leave_call(target)
            except Exception:
                pass
            status = "answered"
            break
        if status != "answered" and attempt < ATTEMPTS:
            await asyncio.sleep(RETRY_WAIT)

    log(f"resultado: {status} tras {attempt} intento(s)")
    report(status, attempt)
    await client.disconnect()
    return 0 if status == "answered" else 2


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
