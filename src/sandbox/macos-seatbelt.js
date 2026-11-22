import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { check, command, mkdir, IgorError } from '../core.js';
import { ownedProcess } from '../supervisor/process.js';

const executable = '/usr/bin/sandbox-exec';
const quote = value => JSON.stringify(value);
export function profile({ code, docs, scratch, readable, node, port }) {
  check(Number.isInteger(port) && port > 0 && port <= 65535, 'Invalid gateway port', 5);
  const roots = [
    ...new Set([
      '/System/Library',
      '/System/iOSSupport/System/Library',
      '/usr/lib',
      '/usr/share',
      '/usr/bin',
      '/usr/libexec',
      '/bin',
      '/Library/Apple/System/Library',
      '/Library/Developer/CommandLineTools',
      '/opt/homebrew/Cellar',
      '/opt/homebrew/opt',
      ...readable,
      code,
      docs,
      scratch,
    ]),
  ];
  const ancestors = new Set(['/', '/dev']);
  for (let item of [...roots, node])
    while (path.dirname(item) !== item) {
      item = path.dirname(item);
      ancestors.add(item);
    }
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-fork process-exec)',
    '(allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name-prefix "machdep.cpu.") (sysctl-name-prefix "kern.os") (sysctl-name "kern.version") (sysctl-name "kern.hostname") (sysctl-name "kern.argmax") (sysctl-name "kern.maxfilesperproc") (sysctl-name "kern.usrstack64") (sysctl-name "vm.loadavg"))',
    '(allow signal process-info* (target same-sandbox))',
    '(allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.system.notification_center") (global-name "com.apple.system.opendirectoryd.libinfo"))',
    '(allow file-read-metadata ' + [...ancestors].map(v => '(literal ' + quote(v) + ')').join(' ') + ')',
    '(allow file-read* file-map-executable ' +
      roots.map(v => '(subpath ' + quote(v) + ')').join(' ') +
      ' (literal ' +
      quote(node) +
      '))',
    '(allow file-read* (literal "/") (literal "/dev/random") (literal "/dev/urandom") (literal "/private/etc/localtime") (literal "/private/etc/passwd") (subpath "/private/var/db/timezone"))',
    '(allow file-read-metadata (literal "/etc") (literal "/var") (literal "/tmp"))',
    '(allow file-read* file-write* (literal "/dev/null") (subpath ' +
      quote(code) +
      ') (subpath ' +
      quote(scratch) +
      '))',
    '(allow network-outbound (remote ip "localhost:' + port + '"))',
    '',
  ].join('\n');
}
export function workerEnv(p) {
  return {
    PATH: [path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
    HOME: p.scratch,
    TMPDIR: path.join(p.scratch, 'tmp'),
    SHELL: '/bin/bash',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    PI_CODING_AGENT_DIR: path.join(p.scratch, 'pi'),
    PI_OFFLINE: '1',
    DO_NOT_TRACK: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    BASH_ENV: '/dev/null',
    // The worker uses an HTTP loopback gateway. Homebrew's OpenSSL config lives outside its sandbox.
    ...(process.platform === 'darwin' ? { OPENSSL_CONF: '/dev/null' } : {}),
    CI: '1',
  };
}
export async function basicSeatbelt() {
  check(process.platform === 'darwin', 'Real Pi execution requires macOS Seatbelt', 5);
  try {
    await command(executable, [
      '-p',
      '(version 1)(deny default)(allow process-exec file-read* file-map-executable)',
      '/usr/bin/true',
    ]);
  } catch (err) {
    throw new IgorError('Seatbelt initialization failed: ' + err.message, 5);
  }
}
// Run a trusted probe with the exact job profile before allowing Pi to start.
// The second listener is deliberately reachable from the host so its denial is meaningful.
export async function prepareSeatbelt(p, runtime, gate, signal) {
  await basicSeatbelt();
  const env = workerEnv(p);
  await mkdir(env.TMPDIR);
  await mkdir(env.PI_CODING_AGENT_DIR);
  const nonce = randomUUID();
  const dirs = {
    code: await fs.realpath(p.code),
    docs: await fs.realpath(p.docs),
    scratch: await fs.realpath(p.scratch),
  };
  const node = await fs.realpath(process.execPath);
  const policy = profile({ ...dirs, node, readable: runtime.readable, port: gate.port });
  const policyFile = path.join(p.input, 'seatbelt.sb');
  await fs.writeFile(policyFile, policy, { mode: 0o600 });
  const sentinel = path.join(p.input, 'private-' + nonce);
  const doc = path.join(p.docs, '.igor-probe-' + nonce);
  const link = path.join(p.scratch, 'link-' + nonce);
  const codeFile = path.join(p.code, '.igor-probe-' + nonce);
  const listener = net.createServer(socket => socket.end());
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  try {
    await fs.writeFile(sentinel, nonce, { flag: 'wx', mode: 0o600 });
    await fs.writeFile(doc, nonce, { flag: 'wx', mode: 0o400 });
    await fs.symlink(sentinel, link);
    const script = `
      const fs=require('node:fs'), net=require('node:net'), {spawnSync}=require('node:child_process');
      const [inside,doc,privateFile,link,allowed,denied]=process.argv.slice(1);
      function deny(fn){try{fn()}catch(e){if(['EPERM','EACCES'].includes(e.code))return}throw Error('missing filesystem denial')}
      function connect(port,host='127.0.0.1'){return new Promise((yes,no)=>{const s=net.connect(+port,host);s.setTimeout(2000,()=>s.destroy(Error('timeout')));s.on('error',no);s.on('connect',()=>{s.destroy();yes()})})}
      (async()=>{fs.writeFileSync(inside,'probe',{flag:'wx'});fs.readFileSync(doc);
        deny(()=>fs.writeFileSync(doc+'-write','probe'));deny(()=>fs.readFileSync(privateFile));deny(()=>fs.readFileSync(link));
        fs.writeFileSync(process.env.TMPDIR+'/private','probe',{mode:0o600});
        if((fs.statSync(process.env.TMPDIR+'/private').mode&0o077)!==0)throw Error('scratch mode');
        const child=spawnSync('/bin/cat',[privateFile]);if(child.status===0||child.status===null)throw Error('subprocess boundary');
        if(Object.keys(process.env).some(k=>/TOKEN|PASSWORD|SECRET|API_KEY|SSH_AUTH_SOCK/.test(k)))throw Error('inherited credential');
        await connect(allowed);for(const [port,host] of [[denied,'127.0.0.1'],[80,'192.0.2.1']]){
          try{await connect(port,host)}catch(e){if(['EPERM','EACCES'].includes(e.code))continue;throw e}throw Error('unrestricted network')}
      })().catch(e=>{console.error(e);process.exitCode=1})`;
    await command(
      executable,
      [
        '-f',
        policyFile,
        node,
        '-e',
        script,
        codeFile,
        doc,
        sentinel,
        link,
        String(gate.port),
        String(listener.address().port),
      ],
      {
        env,
        cwd: p.code,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
      }
    );
  } catch (err) {
    throw new IgorError('Seatbelt job preflight failed: ' + err.message, 5);
  } finally {
    await new Promise(resolve => listener.close(resolve));
    await Promise.all(
      [sentinel, doc, link, codeFile, doc + '-write'].map(file => fs.rm(file, { force: true }))
    );
  }
  return {
    name: 'macos-seatbelt',
    env,
    execute(exe, args) {
      return ownedProcess(executable, ['-f', policyFile, exe, ...args], { cwd: p.code, env });
    },
  };
}
