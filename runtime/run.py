"""Lanzador que mantiene credenciales fuera del plist y del repositorio."""
import argparse
import asyncio
import json
import logging
import os
from pathlib import Path
from daemon import main

if __name__=='__main__':
    os.umask(0o077)
    parser=argparse.ArgumentParser();parser.add_argument('--config',required=True);parser.add_argument('--env-file',required=True);args=parser.parse_args()
    path=Path(args.env_file).expanduser()
    if path.stat().st_mode & 0o077:raise RuntimeError('El archivo privado debe tener permisos 0600')
    for line in path.read_text().splitlines():
        if line and not line.startswith('#'):
            key,value=line.split('=',1)
            if key in {'RUNTIME_TOKEN','TG_API_ID','TG_API_HASH','TG_SESSION'}:os.environ[key]=value
    logging.basicConfig(level=logging.INFO,format='%(asctime)s %(name)s %(levelname)s %(message)s')
    asyncio.run(main(json.loads(Path(args.config).expanduser().read_text())))
