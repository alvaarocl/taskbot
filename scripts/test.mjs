// Tests reproducibles en un clon limpio sin publicar configuración personal.
import {existsSync,copyFileSync,unlinkSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
const created=!existsSync('config.js');
if(created)copyFileSync('config.example.js','config.js');
try {
 const result=spawnSync(process.execPath,['--test','test/integration.test.js'],{stdio:'inherit'});
 process.exitCode=result.status??1;
} finally {if(created)unlinkSync('config.js');}
