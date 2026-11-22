import { fork } from 'node:child_process';
import { systemEnv } from '../core.js';

// The guardian has a private IPC pipe to the supervisor. EOF also arrives
// after an ungraceful supervisor exit, so owned processes have a reaper.
export function ownedProcess(exe, args, { cwd, env }) {
  const guard = fork(new URL('./guardian.js', import.meta.url), [], {
    env: systemEnv(),
    execArgv: [],
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  const done = new Promise((resolve, reject) => {
    guard.once('error', reject);
    guard.once('exit', (code, signal) => resolve({ code, signal }));
  });
  guard.send({ exe, args, cwd, env });
  guard.stdin.on('error', err => {
    if (!['EPIPE', 'ERR_STREAM_DESTROYED'].includes(err.code)) guard.emit('error', err);
  });
  return {
    stdin: guard.stdin,
    stdout: guard.stdout,
    stderr: guard.stderr,
    done,
    async stop() {
      if (guard.connected) guard.send({ stop: true }, () => {});
      await done;
    },
  };
}
