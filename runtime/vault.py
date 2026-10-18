"""Herramientas de Markdown sin shell, con rutas permitidas y control de versión."""
import fcntl
import hashlib
import json
import os
import re
import tempfile
import unicodedata
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

SKIP={'.git','.obsidian','.venv','venv','node_modules','target','build','dist','__pycache__','.wrangler'}
def normalize(text):return ''.join(c for c in unicodedata.normalize('NFD',str(text).casefold()) if unicodedata.category(c)!='Mn')
def digest(text): return hashlib.sha256(text.encode()).hexdigest()
def now(): return datetime.now(timezone.utc).isoformat()

class Vault:
    def __init__(self,config,state):
        self.root=Path(config['vault']).expanduser().resolve(strict=True)
        self.read_paths=config.get('read_paths',[])
        self.write_paths=config.get('write_paths',['_Jarvis'])
        self.state=Path(state); self.state.mkdir(mode=0o700,parents=True,exist_ok=True)
        if not self.read_paths: raise ValueError('Configura read_paths explícitamente')

    def path(self,name,write=False):
        raw=Path(name)
        if raw.is_absolute() or '..' in raw.parts or any(p in SKIP or p.startswith('.') for p in raw.parts): raise ValueError('Ruta no permitida')
        path=(self.root/raw).resolve()
        rel=path.relative_to(self.root)
        allowed=self.write_paths if write else self.read_paths+self.write_paths
        if not any(rel==Path(p) or Path(p) in rel.parents for p in allowed): raise ValueError('Fuera de las carpetas permitidas')
        if any(p in SKIP or p.startswith('.') for p in rel.parts) or path.suffix.lower()!='.md': raise ValueError('Solo notas Markdown permitidas')
        return path

    @contextmanager
    def locked(self):
        with (self.state/'vault.lock').open('a') as f:
            fcntl.flock(f,fcntl.LOCK_EX)
            try: yield
            finally: fcntl.flock(f,fcntl.LOCK_UN)

    def read(self,name):
        path=self.path(name)
        if path.stat().st_size>1_000_000: raise ValueError('Nota demasiado grande')
        text=path.read_text()
        return {'path':str(path.relative_to(self.root)),'content':text[:24000],'partial':len(text)>24000,'version':digest(text),'source':path.as_uri(),'read_at':now()}

    def search(self,query,limit=8):
        words=re.findall(r'\w+',normalize(query))
        if not words: return {'notes':[]}
        found=[]; seen=set(); scanned=0; partial=False
        for folder in self.read_paths+self.write_paths:
            base=(self.root/folder)
            if not base.exists(): continue
            if base.is_symlink(): continue
            candidates=[base] if base.is_file() else self.walk(base)
            for path in candidates:
                scanned+=1
                if scanned>10000: partial=True; break
                try:
                    safe=self.path(str(path.relative_to(self.root)))
                    if safe in seen or safe.stat().st_size>1_000_000: continue
                    seen.add(safe); text=safe.read_text(); lower=normalize(text); title=normalize(safe.stem)
                    score=sum(3*title.count(w)+min(lower.count(w),10) for w in words)
                    if not score: continue
                    pos=min((lower.find(w) for w in words if w in lower),default=0)
                    found.append({'path':str(safe.relative_to(self.root)),'title':safe.stem,'snippet':text[max(0,pos-120):pos+600],'score':score,'source':safe.as_uri(),'version':digest(text)})
                except (ValueError,OSError,UnicodeError): continue
            if partial: break
        return {'notes':sorted(found,key=lambda x:x['score'],reverse=True)[:min(max(int(limit),1),15)],'partial':partial,'read_at':now()}

    def walk(self,base):
        for root,dirs,files in os.walk(base,followlinks=False):
            dirs[:]=[d for d in dirs if not d.startswith('.') and d not in SKIP and not (Path(root)/d).is_symlink()]
            for name in files:
                if name.endswith('.md') and not (Path(root)/name).is_symlink(): yield Path(root)/name

    def atomic(self,path,text,operation):
        if len(text)>100000: raise ValueError('Contenido demasiado grande')
        path.parent.mkdir(parents=True,exist_ok=True)
        # Revalidar tras mkdir; no permitir que una carpeta sea redirigida fuera del vault.
        path=self.path(str(path.relative_to(self.root)),True)
        if path.exists():
            backup=self.state/'backups'/operation
            backup.mkdir(parents=True,exist_ok=True)
            (backup/'original.md').write_text(path.read_text())
            (backup/'metadata.json').write_text(json.dumps({'path':str(path.relative_to(self.root)),'at':now()}))
        fd,temp=tempfile.mkstemp(prefix='.taskbot-',dir=path.parent)
        try:
            with os.fdopen(fd,'w') as f: f.write(text); f.flush(); os.fsync(f.fileno())
            os.replace(temp,path)
        finally:
            if os.path.exists(temp): os.unlink(temp)
        return {'ok':True,'path':str(path.relative_to(self.root)),'version':digest(text),'source':path.as_uri()}

    def capture(self,text,operation):
        path=self.path('_Jarvis/Inbox.md',True); marker=f'<!-- taskbot:{operation} -->'
        with self.locked():
            previous=path.read_text() if path.exists() else '# Inbox\n'
            if marker in previous:return {'ok':True,'path':'_Jarvis/Inbox.md','already_applied':True}
            return self.atomic(path,previous+f'\n## {now()}\n{marker}\n{str(text)[:12000]}\n',operation)

    def update(self,name,content,expected,operation):
        path=self.path(name,True)
        with self.locked():
            previous=path.read_text() if path.exists() else ''
            if previous==content: return {'ok':True,'path':name,'version':digest(content),'already_applied':True}
            if not expected or digest(previous)!=expected: return {'error':'conflict','message':'La nota ha cambiado. Léela otra vez antes de editar.','version':digest(previous)}
            return self.atomic(path,content,operation)

    def remember(self,text,kind,source,operation):
        if kind not in ['objetivo','habito','horario','preferencia','decision']: raise ValueError('Tipo de memoria no permitido')
        if not source: raise ValueError('La memoria necesita procedencia')
        path=self.path(f'_Jarvis/Memoria/{operation}.md',True)
        with self.locked():
            if path.exists(): return {'ok':True,'id':operation,'already_applied':True}
            result=self.atomic(path,f'# {kind}\n\nFecha: {now()}\nFuente: {str(source)[:500]}\nTipo: confirmado por el usuario\n\n{str(text)[:4000]}\n',operation)
            return {**result,'id':operation}

    def forget(self,memory_id,operation):
        if not re.fullmatch(r'[a-zA-Z0-9-]{1,80}',str(memory_id)):raise ValueError('Memoria inválida')
        path=self.path(f'_Jarvis/Memoria/{memory_id}.md',True)
        with self.locked():
            if not path.exists(): return {'ok':True,'already_absent':True}
            result=self.atomic(path,'# Memoria retirada\n\nSe ha retirado por petición del usuario.\n',operation)
            # Los backups de memorias olvidadas no deben volver a inyectarse en el contexto.
            return result

    def execute(self,op,payload,operation):
        if op=='vault.search': return self.search(payload.get('query',''),payload.get('limit',8))
        if op=='vault.read': return self.read(payload['path'])
        if op=='vault.capture': return self.capture(payload['text'],operation)
        if op=='vault.update': return self.update(payload['path'],payload['content'],payload.get('version'),operation)
        if op=='memory.remember': return self.remember(payload['text'],payload['kind'],payload['source'],operation)
        if op=='memory.forget': return self.forget(payload['id'],operation)
        if op=='memory.list':
            notes=[]; query=str(payload.get('query','')).casefold()
            for p in (self.root/'_Jarvis/Memoria').glob('*.md'):
                item=self.read(str(p.relative_to(self.root)))
                if '# Memoria retirada' in item['content']:continue
                if query and query not in item['content'].casefold():continue
                notes.append({'id':p.stem,**item})
                if len(notes)>=30:break
            return {'notes':notes}
        raise ValueError('Operación desconocida')
