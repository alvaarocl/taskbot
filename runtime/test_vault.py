import tempfile
import unittest
from pathlib import Path
from vault import Vault,digest

class VaultTest(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)/'vault';self.root.mkdir()
        (self.root/'Proyecto').mkdir();(self.root/'Proyecto/Estado.md').write_text('# Web\nSiguiente paso: reservas')
        self.v=Vault({'vault':str(self.root),'read_paths':['Proyecto'],'write_paths':['_Jarvis']},Path(self.temp.name)/'state')
    def tearDown(self):self.temp.cleanup()
    def test_read_search_and_scope(self):
        self.assertEqual(self.v.search('reservas')['notes'][0]['path'],'Proyecto/Estado.md')
        for path in ['../secret.md','/tmp/secret.md','Proyecto/.git/config.md','Privado/secret.md']:
            with self.assertRaises(ValueError):self.v.read(path)
    def test_symlink_outside_allowlist(self):
        other=Path(self.temp.name)/'secret.md';other.write_text('secret')
        (self.root/'Proyecto/linked.md').symlink_to(other)
        with self.assertRaises(ValueError):self.v.read('Proyecto/linked.md')
        self.assertEqual(self.v.search('secret')['notes'],[])
    def test_capture_retry_does_not_duplicate(self):
        self.v.capture('Una idea','request1');self.v.capture('Una idea','request1')
        self.assertEqual((self.root/'_Jarvis/Inbox.md').read_text().count('Una idea'),1)
    def test_update_conflict_and_recovery(self):
        self.v.capture('Inicial','one');read=self.v.read('_Jarvis/Inbox.md')
        (self.root/'_Jarvis/Inbox.md').write_text('Editado por otro agente')
        result=self.v.update('_Jarvis/Inbox.md','Cambio',read['version'],'two');self.assertEqual(result['error'],'conflict')
        self.assertEqual((self.root/'_Jarvis/Inbox.md').read_text(),'Editado por otro agente')
        fresh=self.v.read('_Jarvis/Inbox.md');self.v.update('_Jarvis/Inbox.md','Nuevo',fresh['version'],'three')
        self.assertEqual((self.v.state/'backups/three/original.md').read_text(),'Editado por otro agente')
    def test_memory_forget_excludes_retrieval(self):
        self.v.remember('Prefiero las tardes','preferencia','Lo indicó el usuario','memory1')
        self.assertEqual(len(self.v.execute('memory.list',{},'list')['notes']),1)
        self.v.forget('memory1','forget1')
        self.assertEqual(self.v.execute('memory.list',{},'list')['notes'],[])
        self.assertEqual(self.v.search('Prefiero las tardes')['notes'],[])
    def test_project_read_does_not_authorize_write(self):
        note=self.v.read('Proyecto/Estado.md')
        with self.assertRaises(ValueError):self.v.update(note['path'],'Otra cosa',note['version'],'x')

if __name__=='__main__':unittest.main()
