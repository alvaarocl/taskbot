"""Inicia sesión una vez con la cuenta de Telegram que te va a llamar ("Jarvis") y guarda lo necesario como
secretos del repo privado de Jarvis en GitHub (TG_API_ID, TG_API_HASH, TG_SESSION). Nada se imprime.

  python3 jarvis/login.py TU_USUARIO/TU_REPO_JARVIS

Antes: api_id y api_hash de https://my.telegram.org → API development tools (entrando con el número de la cuenta
Jarvis) y `gh` con sesión iniciada en GitHub. La sesión equivale a estar dentro de esa cuenta: trátala como una
contraseña (se puede cerrar desde Telegram → Ajustes → Dispositivos).
"""

import getpass
import subprocess
import sys

from telethon.sessions import StringSession
from telethon.sync import TelegramClient

if len(sys.argv) != 2 or "/" not in sys.argv[1]:
    sys.exit("Uso: python3 jarvis/login.py TU_USUARIO/TU_REPO_JARVIS")
REPO = sys.argv[1]


def secret(name, value):
    subprocess.run(["gh", "secret", "set", name, "--repo", REPO], input=value.encode(), check=True, stdout=subprocess.DEVNULL)


api_id = input("api_id: ").strip()
api_hash = getpass.getpass("api_hash (no se ve al escribir): ").strip()
with TelegramClient(StringSession(), int(api_id), api_hash) as client:
    # Telethon pide el número y el código que llega a la cuenta Jarvis (y la contraseña si tiene verificación en dos pasos).
    client.start(phone=lambda: input("Número de la cuenta Jarvis (con prefijo, +34…): ").strip(),
                 code_callback=lambda: input("Código que te ha llegado a Telegram (a la cuenta Jarvis): ").strip(),
                 password=lambda: getpass.getpass("Contraseña de verificación en dos pasos: "))
    me = client.get_me()
    session = client.session.save()

secret("TG_API_ID", api_id)
secret("TG_API_HASH", api_hash)
secret("TG_SESSION", session)
print(f"Listo: dentro como {me.first_name} (id {me.id}). Guardado en GitHub ({REPO}).")
