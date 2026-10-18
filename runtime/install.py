"""Instala una copia estable del runtime en el usuario actual. No inicia llamadas."""
import argparse
import os
import plistlib
import shutil
import subprocess
from pathlib import Path

if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--start',action='store_true');args=parser.parse_args()
    source=Path(__file__).resolve().parent;state=Path.home()/'.local/share/taskbot';dest=state/'service'
    dest.mkdir(mode=0o700,parents=True,exist_ok=True)
    for name in ['run.py','daemon.py','vault.py','voice.py']:shutil.copy2(source/name,dest/name)
    jarvis=state/'jarvis';jarvis.mkdir(exist_ok=True);shutil.copy2(source.parent/'jarvis/conversation.py',jarvis/'conversation.py')
    python=state/'venv/bin/python'
    if not python.exists():subprocess.run(['python3','-m','venv',str(state/'venv')],check=True)
    subprocess.run([str(python),'-m','pip','install','-r',str(source/'requirements.txt')],check=True)
    config=Path.home()/'.config/taskbot/runtime.json';env=Path.home()/'.config/taskbot/runtime.env'
    if not config.exists() or not env.exists():raise RuntimeError('Falta la configuración privada en ~/.config/taskbot')
    log=state/'logs';log.mkdir(mode=0o700,exist_ok=True)
    agent=Path.home()/'Library/LaunchAgents/com.taskbot.runtime.plist';agent.parent.mkdir(parents=True,exist_ok=True)
    plist={'Label':'com.taskbot.runtime','ProgramArguments':[str(python),str(dest/'run.py'),'--config',str(config),'--env-file',str(env)],'RunAtLoad':True,'KeepAlive':True,'ThrottleInterval':10,'WorkingDirectory':str(dest),'StandardOutPath':str(log/'runtime.log'),'StandardErrorPath':str(log/'runtime-error.log'),'EnvironmentVariables':{'PATH':'/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin','PYTHONUNBUFFERED':'1'}}
    agent.write_bytes(plistlib.dumps(plist));agent.chmod(0o600)
    if args.start:
        subprocess.run(['launchctl','bootout',f'gui/{os.getuid()}',str(agent)],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        subprocess.run(['launchctl','bootstrap',f'gui/{os.getuid()}',str(agent)],check=True)
    print('Runtime instalado en ~/.local/share/taskbot. Sin credenciales en el plist. '+('Servicio iniciado.' if args.start else 'No se ha iniciado el servicio.'))
