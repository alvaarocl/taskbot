"""Autoriza una sesión NUEVA en este equipo. Nunca reutilizar la sesión de otro servidor."""
import asyncio
import getpass
import os
import subprocess
from pathlib import Path
from telethon import TelegramClient
from telethon.sessions import StringSession

async def main():
    path=Path.home()/'.config/taskbot/runtime.env'
    values=dict(line.split('=',1) for line in path.read_text().splitlines() if '=' in line)
    phone_path=path.with_name('telegram-phone')
    phone=phone_path.read_text().strip() if phone_path.exists() else None
    if phone_path.exists():phone_path.unlink()
    client=TelegramClient(StringSession(),int(values['TG_API_ID']),values['TG_API_HASH'])
    print('Autoriza la cuenta secundaria de Telegram que usas para Jarvis, NO tu cuenta personal principal.')
    print('Se creará una sesión independiente para este Mac. Los datos se guardan localmente con permisos 0600.')
    try:
        await client.start(phone=phone or (lambda:getpass.getpass('Teléfono de Jarvis con prefijo: ')),code_callback=lambda:getpass.getpass('Código recibido en Telegram: '),password=lambda:getpass.getpass('Contraseña de verificación en dos pasos (si la pide): '))
        values['TG_SESSION']=client.session.save()
        temporary=path.with_suffix('.new');temporary.write_text('\n'.join(f'{k}={v}' for k,v in values.items())+'\n');temporary.chmod(0o600);os.replace(temporary,path)
    finally:await client.disconnect()
    subprocess.run(['launchctl','kickstart','-k',f'gui/{os.getuid()}/com.taskbot.runtime'],check=True)
    print('Sesión independiente guardada. Servicio reiniciado. No se ha realizado ninguna llamada.')

if __name__=='__main__':
    try:asyncio.run(main())
    except KeyboardInterrupt:print('\nAutorización cancelada; el resto del servicio sigue disponible.')
