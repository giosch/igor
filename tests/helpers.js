import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { command, sleep } from '../src/core.js';

export const repo = fileURLToPath(new URL('../', import.meta.url));
export const cli = path.join(repo, 'src', 'cli', 'index.js');
export async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'igor-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}
export async function invoke(home, args, expected = 0) {
  const { stdout, stderr, code } = await command(process.execPath, [cli, ...args, '--json'], {
    env: { ...process.env, IGOR_HOME: home },
    allow: [0, 1, 2, 3, 4, 5, 6, 7],
    signal: AbortSignal.timeout(35000),
  });
  assert.equal(code, expected, stdout.toString() + stderr);
  return JSON.parse(stdout);
}
export async function fixture(t) {
  let home;
  t.after(async () => {
    if (home) await invoke(home, ['stop']);
  });
  const root = await temp(t),
    code = path.join(root, 'code');
  home = path.join(root, 'state');
  await fs.cp(path.join(repo, 'examples', 'sample-project'), code, { recursive: true });
  return {
    root,
    home,
    code,
    run: (args = [], expected = 0) =>
      invoke(home, ['run', '--code', code, '--prompt', 'Fix clamp', '--model', 'mock', ...args], expected),
  };
}
export async function until(fn, timeout = 10000) {
  const end = Date.now() + timeout;
  do {
    const value = await fn();
    if (value) return value;
    await sleep(40);
  } while (Date.now() < end);
  assert.fail('Condition did not become true within ' + timeout + ' ms');
}
