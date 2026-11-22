import { spawn } from 'node:child_process';
let child,
  stopping = false,
  timer;
function kill(signal) {
  if (!child?.pid) return;
  try {
    process.kill(process.platform === 'win32' ? child.pid : -child.pid, signal);
  } catch (err) {
    if (err.code !== 'ESRCH') process.stderr.write(err.message + '\n');
  }
}
function stop() {
  if (stopping) return;
  stopping = true;
  if (!child) {
    process.exit(0);
  }
  kill('SIGTERM');
  timer = setTimeout(() => kill('SIGKILL'), 1000);
}
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('message', msg => {
  if (msg.stop) return stop();
  if (child || stopping) return;
  child = spawn(msg.exe, msg.args, {
    cwd: msg.cwd,
    env: msg.env,
    stdio: [0, 1, 2],
    windowsHide: true,
    detached: process.platform !== 'win32',
  });
  child.on('error', err => {
    process.stderr.write(err.message + '\n');
    process.exit(err.code === 'ENOENT' ? 3 : 1);
  });
  child.on('exit', code => {
    clearTimeout(timer);
    if (process.platform !== 'win32') kill('SIGKILL');
    process.exit(code ?? 1);
  });
});
