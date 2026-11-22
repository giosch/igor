import { ownedProcess } from '../../src/supervisor/process.js';
import { systemEnv } from '../../src/core.js';
const child = ownedProcess(process.execPath, ['-e', 'console.log(process.pid);setInterval(()=>{},1000)'], {
  cwd: process.cwd(),
  env: systemEnv(),
});
child.stdout.on('data', b => {
  process.send({ pid: Number(b.toString().trim()) });
});
child.stderr.pipe(process.stderr);
await child.done;
