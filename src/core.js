import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

export { sleep };
export class IgorError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}
export function check(condition, message, code = 2) {
  if (!condition) throw new IgorError(message, code);
}
export function integer(value, name, min = 1, max = Number.MAX_SAFE_INTEGER) {
  check(Number.isSafeInteger(value) && value >= min && value <= max, 'Invalid ' + name);
  return value;
}
export function keys(value, allowed, name) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'Invalid ' + name);
  for (const key of Object.keys(value)) check(allowed.includes(key), 'Unknown ' + name + ' field: ' + key);
}
export async function mkdir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
}
export async function jsonFile(file) {
  try {
    return JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new IgorError('Cannot read ' + file + ': ' + err.message, 2);
  }
}
export async function atomic(file, data) {
  const temp = file + '.' + randomUUID() + '.tmp';
  await fs.writeFile(temp, data, { mode: 0o600, flush: true, flag: 'wx' });
  try {
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}
export const saveJson = (file, value) => atomic(file, JSON.stringify(value, null, 2) + '\n');
export function inside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep));
}
export function safeRelative(name) {
  check(typeof name === 'string' && name.length > 0 && name.length <= 4096, 'Invalid relative path');
  for (const part of name.split('/')) {
    check(
      part &&
        part !== '.' &&
        part !== '..' &&
        !/[\\:<>"|?*\x00-\x1f\x7f]/.test(part) &&
        !/[. ]$/.test(part) &&
        !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part),
      'Unsafe relative path: ' + name
    );
  }
  return name;
}
export function safeId(id) {
  check(
    typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id) && !Object.hasOwn(Object.prototype, id),
    'Invalid model identifier'
  );
  return safeRelative(id);
}
export function jobPaths(home, id) {
  check(/^job_[0-9a-f]{32}$/.test(id), 'Invalid job identifier');
  const root = path.join(home, 'jobs', id);
  const output = path.join(root, 'output');
  return {
    root,
    code: path.join(root, 'workspace', 'code'),
    docs: path.join(root, 'workspace', 'docs'),
    input: path.join(root, 'input'),
    scratch: path.join(root, 'scratch'),
    logs: path.join(root, 'logs'),
    output,
    result: path.join(output, 'result.json'),
    patch: path.join(output, 'changes.patch'),
  };
}
export function systemEnv() {
  const names = ['PATH', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP', 'TMPDIR'];
  return Object.fromEntries(names.filter(k => process.env[k]).map(k => [k, process.env[k]]));
}
export function command(
  exe,
  args,
  { cwd, env = systemEnv(), input, signal, max = 32 * 1024 ** 2, allow = [0] } = {}
) {
  return new Promise((resolve, reject) => {
    const proc = spawn(exe, args, { cwd, env, signal, windowsHide: true, stdio: 'pipe' });
    const out = [],
      err = [];
    let bytes = 0;
    function capture(list, data) {
      bytes += data.length;
      if (bytes > max) {
        proc.kill();
        reject(new IgorError('Output limit exceeded for ' + exe));
      } else list.push(data);
    }
    proc.stdout.on('data', data => capture(out, data));
    proc.stderr.on('data', data => capture(err, data));
    proc.on('error', error =>
      reject(error.code === 'ENOENT' ? new IgorError('Missing executable: ' + exe, 3) : error)
    );
    proc.stdin.on('error', error => {
      if (error.code !== 'EPIPE') reject(error);
    });
    proc.stdin.end(input);
    proc.on('close', code => {
      const stdout = Buffer.concat(out),
        stderr = Buffer.concat(err).toString().trim();
      if (!allow.includes(code)) reject(new IgorError(exe + ' exited ' + code + ': ' + stderr.slice(-3000)));
      else resolve({ stdout, stderr, code });
    });
  });
}
