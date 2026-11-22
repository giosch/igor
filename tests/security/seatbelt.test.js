import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { jobPaths } from '../../src/core.js';
import { prepareJobDirs } from '../../src/supervisor/job.js';
import { prepareSeatbelt } from '../../src/sandbox/macos-seatbelt.js';
import { temp } from '../helpers.js';

test(
  'native Seatbelt denies sibling jobs, host files and protected inputs to child processes',
  { skip: process.platform !== 'darwin' && 'requires the macOS kernel', timeout: 30000 },
  async t => {
    const root = await temp(t),
      p = jobPaths(root, 'job_' + 'c'.repeat(32)),
      other = jobPaths(root, 'job_' + 'd'.repeat(32));
    await prepareJobDirs(p);
    await prepareJobDirs(other);
    const files = [
      path.join(other.code, 'other.txt'),
      path.join(root, 'host.txt'),
      path.join(p.input, 'control.json'),
    ];
    for (const f of files) await fs.writeFile(f, 'Igor test fixture');
    const listener = net.createServer(s => s.end());
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => listener.close(resolve)));
    const sandbox = await prepareSeatbelt(p, { readable: [] }, { port: listener.address().port });
    const script =
      "for(const f of process.argv.slice(1)){try{require('node:fs').readFileSync(f);process.exit(1)}catch(e){if(!['EPERM','EACCES'].includes(e.code))throw e}}";
    const proc = sandbox.execute(process.execPath, ['-e', script, ...files]);
    proc.stdin.end();
    let stderr = '';
    proc.stderr.on('data', c => {
      stderr += c;
    });
    proc.stdout.resume();
    assert.equal((await proc.done).code, 0, stderr);
  }
);
