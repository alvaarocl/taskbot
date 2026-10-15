"""Conversación por voz dentro de la llamada de Telegram (la usa jarvis/modal_app.py).

Jarvis te saluda con una pregunta y después habláis por turnos:
  tu voz (frames de la llamada) → detecta cuándo acabas de hablar → /api/jarvis/turn de taskbot (transcribe y el
  asistente responde, con sus herramientas: apuntar, mover, consultar…) → la voz natural (Voice en Modal) → a la
  llamada. Mientras habla no escucha (para no oírse a sí mismo). Termina cuando te despides, cuelgas o te quedas
  callado un buen rato.
"""

import array
import asyncio
import base64
import io
import math
import subprocess
import time
import wave
from datetime import datetime, timezone

from pytgcalls import PyTgCalls, filters
from pytgcalls.exceptions import CallBusy, CallDeclined, CallDiscarded, TimedOutAnswer
from pytgcalls.types import ChatUpdate, Device, Direction, ExternalMedia, MediaStream, RecordStream, StreamFrames
from pytgcalls.types.raw import AudioParameters
from telethon.errors import UserPrivacyRestrictedError

OUT_RATE = 48000              # lo que mandamos a la llamada (PCM 16 bits, mono)
IN_RATE = 16000               # lo que recibimos (suficiente para reconocer la voz)
FRAME = OUT_RATE * 2 // 100   # 10 ms de audio de salida
SILENCE_END = 1.0             # s de silencio que cierran tu frase
MIN_SPEECH = 0.35             # s mínimos para contar como frase
MAX_SPEECH = 15               # s máximos de una frase
NUDGE_AFTER = 25              # s callado → "¿algo más?"
BYE_AFTER = 15                # s más callado → se despide y cuelga
MAX_CALL = 12 * 60            # s de llamada como mucho
FILLER_AFTER = 1.3            # s pensando → "un momento"


def to_pcm(mp3: bytes) -> bytes:
    """mp3 (de Voice) → PCM s16le 48 kHz mono para mandarlo por la llamada."""
    return subprocess.run(["ffmpeg", "-v", "error", "-i", "pipe:0", "-f", "s16le", "-ac", "1", "-ar", str(OUT_RATE), "pipe:1"],
                          input=mp3, capture_output=True, check=True).stdout


def to_wav(pcm: bytes) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(IN_RATE)
        w.writeframes(pcm)
    return buf.getvalue()


def rms(chunk: bytes) -> float:
    a = array.array("h", chunk[: len(chunk) // 2 * 2])
    return math.sqrt(sum(x * x for x in a) / len(a)) if a else 0.0


class Pump:
    """Manda 10 ms de audio cada 10 ms: lo que haya en cola o silencio. `speaking` = hay voz sonando."""

    def __init__(self, calls, target):
        self.calls, self.target, self.buf = calls, target, bytearray()
        self.last_voice = 0.0
        self.task = None

    @property
    def speaking(self):
        return len(self.buf) > 0

    def say(self, pcm: bytes):
        self.buf += pcm

    async def done(self):
        while self.speaking:
            await asyncio.sleep(0.05)
        await asyncio.sleep(0.3)  # cola del eco

    async def run(self):
        silence = bytes(FRAME)
        t0, n = time.monotonic(), 0
        while True:
            chunk = bytes(self.buf[:FRAME]) if self.buf else silence
            del self.buf[:FRAME]
            if len(chunk) < FRAME:
                chunk += bytes(FRAME - len(chunk))
            if chunk is not silence:
                self.last_voice = time.monotonic()
            try:
                await self.calls.send_frame(self.target, Device.MICROPHONE, chunk)
            except Exception:
                return  # la llamada ha terminado
            n += 1
            await asyncio.sleep(max(0.0, t0 + n * 0.01 - time.monotonic()))


class Ears:
    """Detector de frases por energía, con ruido de fondo adaptativo. Ignora lo que llega mientras Jarvis habla."""

    def __init__(self, pump):
        self.pump, self.noise = pump, 300.0
        self.cur, self.in_speech, self.quiet = bytearray(), False, 0.0
        self.phrases = asyncio.Queue()
        self.heard_at = time.monotonic()

    def feed(self, chunk: bytes):
        if self.pump.speaking or time.monotonic() - self.pump.last_voice < 0.4:
            self.cur.clear()
            self.in_speech = False
            return
        level, secs = rms(chunk), len(chunk) / 2 / IN_RATE
        threshold = max(400.0, self.noise * 3)
        if level > threshold:
            self.in_speech, self.quiet = True, 0.0
            self.cur += chunk
        elif self.in_speech:
            self.cur += chunk
            self.quiet += secs
            if self.quiet >= SILENCE_END:
                self._close()
        else:
            self.noise = 0.95 * self.noise + 0.05 * level
        if self.in_speech and len(self.cur) / 2 / IN_RATE >= MAX_SPEECH:
            self._close()

    def _close(self):
        pcm, self.cur, self.in_speech, self.quiet = bytes(self.cur), bytearray(), False, 0.0
        if len(pcm) / 2 / IN_RATE >= MIN_SPEECH + SILENCE_END:
            self.heard_at = time.monotonic()
            self.phrases.put_nowait(pcm)


async def converse(client, target, wake_at, opening: str, job: str, speak, taskbot, log, report, attempts=3, retry_wait=60):
    """Llama a `target` a la hora `wake_at` y mantiene la conversación.
    `speak(text, lead_ms)` → mp3; `taskbot(method, body, query)` → dict."""
    calls = PyTgCalls(client)
    ended = asyncio.Event()

    @calls.on_update(filters.chat_update(ChatUpdate.Status.DISCARDED_CALL))
    async def _hung_up(_, update: ChatUpdate):
        ended.set()

    await calls.start()

    # La voz del saludo y del "un momento" se prepara antes de llamar (la GPU ya está caliente después).
    log("preparando la voz")
    opening_pcm, filler_pcm = await asyncio.gather(
        asyncio.to_thread(lambda: to_pcm(speak(opening, 600))),
        asyncio.to_thread(lambda: to_pcm(speak("Un momento, señor.", 0))),
    )

    left = (wake_at - datetime.now(timezone.utc)).total_seconds()
    if left > 0:
        log(f"esperando {int(left)} s hasta la hora")
        await asyncio.sleep(left)

    status, attempt, conn_fails = "no_answer", 0, 0
    while attempt < attempts and status != "answered":
        attempt += 1
        log(f"llamando (intento {attempt})")
        try:
            await calls.play(target, MediaStream(ExternalMedia.AUDIO, AudioParameters(bitrate=OUT_RATE, channels=1)))
        except UserPrivacyRestrictedError:
            log("tu privacidad de Telegram no deja llamar a esta cuenta")
            report("privacy", attempt)
            return 3
        except (TimedOutAnswer, CallDeclined, CallBusy, CallDiscarded) as e:
            log(f"sin respuesta: {type(e).__name__}")
            if attempt < attempts:
                await asyncio.sleep(retry_wait)
            continue
        except Exception as e:
            # La conexión de audio a veces no arranca a la primera: se repite al momento (sin gastar intento).
            conn_fails += 1
            log(f"la conexión no ha arrancado ({type(e).__name__}); repito")
            if conn_fails <= 4:
                attempt -= 1
            await asyncio.sleep(3)
            continue
        status = "answered"

    if status != "answered":
        report(status, attempt)
        return 2
    log("descolgado: conversación")
    report("answered", attempt)

    pump = Pump(calls, target)
    ears = Ears(pump)

    @calls.on_update(filters.stream_frame(Direction.INCOMING, Device.MICROPHONE))
    async def _frames(_, update: StreamFrames):
        for f in update.frames:
            ears.feed(f.frame)

    await calls.record(target, RecordStream(audio=True, audio_parameters=AudioParameters(bitrate=IN_RATE, channels=1)))
    pump.task = asyncio.create_task(pump.run())
    pump.say(opening_pcm)
    await pump.done()
    ears.heard_at = time.monotonic()

    started, nudged, turns = time.monotonic(), False, 0
    while not ended.is_set() and time.monotonic() - started < MAX_CALL:
        try:
            pcm = await asyncio.wait_for(ears.phrases.get(), timeout=1.0)
        except asyncio.TimeoutError:
            idle = time.monotonic() - max(ears.heard_at, pump.last_voice)
            if not nudged and idle > NUDGE_AFTER:
                nudged = True
                pump.say(to_pcm(await asyncio.to_thread(speak, "¿Necesita algo más, señor?", 0)))
                await pump.done()
            elif nudged and idle > BYE_AFTER:
                pump.say(to_pcm(await asyncio.to_thread(speak, "Muy bien. Que tenga un buen día, señor.", 0)))
                await pump.done()
                break
            continue

        nudged, turns = False, turns + 1
        log(f"turno {turns}: {len(pcm) / 2 / IN_RATE:.1f} s de voz")
        ask = asyncio.create_task(asyncio.to_thread(
            taskbot, "POST", {"job": job, "audio": base64.b64encode(to_wav(pcm)).decode()}, "/turn"))
        done, _ = await asyncio.wait({ask}, timeout=FILLER_AFTER)
        if not done:
            pump.say(filler_pcm)
        try:
            res = await ask
        except Exception as e:
            log(f"taskbot no responde ({type(e).__name__})")
            res = {"reply": "Perdone, señor, he perdido la conexión un momento. ¿Me lo repite?"}
        reply = (res or {}).get("reply")
        if not reply:
            continue  # ruido o nada que entender
        audio = to_pcm(await asyncio.to_thread(speak, reply, 0))
        await pump.done()  # que acabe el "un momento"
        pump.say(audio)
        await pump.done()
        if res.get("end"):
            break

    log(f"fin de la llamada tras {turns} turno(s)")
    try:
        await calls.leave_call(target)
    except Exception:
        pass
    if pump.task:
        pump.task.cancel()
    return 0
