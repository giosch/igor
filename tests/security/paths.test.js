import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { jobPaths, safeRelative, inside } from '../../src/core.js';
import { sourceRoot, inventory, git } from '../../src/workspace/snapshot.js';
import { defaultConfig } from '../../src/config/index.js';
import { DevelopmentSandbox } from '../../src/sandbox/development.js';
import { profile, workerEnv } from '../../src/sandbox/macos-seatbelt.js';
import { fixture, invoke, temp } from '../helpers.js';

test('path validation handles traversal, drives, streams and reserved names', () => {
  for (const name of [
    '',
    '../x',
    'a/../x',
    '/x',
    'C:/private',
    '\\\\server\\share',
    'a:b',
    'a\\b',
    'foo/CON.txt',
    'nul',
    'a//b',
    'x.',
    'bad\nname',
  ])
    assert.throws(() => safeRelative(name));
  assert.equal(safeRelative("dir/a 'b.js"), "dir/a 'b.js");
  assert.throws(() => jobPaths('/tmp', '../../x'));
  if (process.platform === 'win32') {
    assert(inside('C:\\ROOT', 'c:\\root\\sub'));
    assert(!inside('C:\\root', 'D:\\root'));
  }
});
test('snapshot rejects symlinks or Windows directory junctions and linked tracked ancestors', async t => {
  const root = await temp(t),
    code = path.join(root, 'code'),
    privateDir = path.join(root, 'private');
  await fs.mkdir(code);
  await fs.mkdir(privateDir);
  await fs.writeFile(path.join(privateDir, 'test.txt'), 'private');
  await fs.symlink(
    privateDir,
    path.join(code, 'external'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  await assert.rejects(inventory(code, defaultConfig.limits, { source: true }), /Links|Linked|escape/);
  await fs.unlink(path.join(code, 'external'));
  await fs.mkdir(path.join(code, 'external'));
  await fs.writeFile(path.join(code, 'external', 'test.txt'), 'tracked');
  await git(['init', '-q'], { cwd: code });
  await git(['add', '.'], { cwd: code });
  await fs.rm(path.join(code, 'external'), { recursive: true });
  await fs.symlink(
    privateDir,
    path.join(code, 'external'),
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  await assert.rejects(inventory(code, defaultConfig.limits, { source: true }), /Links|Linked|escape/);
  assert.equal(await fs.readFile(path.join(privateDir, 'test.txt'), 'utf8'), 'private');
});
test('nested home is rejected before any write; development backend refuses real agents', async t => {
  const { home, root, code } = await fixture(t);
  await assert.rejects(sourceRoot(root, home), /overlap/);
  const nested = path.join(code, 'never-created');
  assert.match((await invoke(nested, ['run', '--code', code, '--prompt', 'x'], 2)).error, /overlap/);
  await assert.rejects(fs.access(nested));
  assert.throws(() => new DevelopmentSandbox().prepare({}, 'pi'), /Seatbelt/);
  if (process.platform !== 'darwin')
    assert.equal(
      (await invoke(home, ['run', '--code', code, '--prompt', 'x', '--model', 'inkling-mini'], 5)).status,
      'failed'
    );
});
test('Seatbelt defaults to deny, scopes the port, and sanitizes worker environment', () => {
  const policy = profile({
    code: '/a/code',
    docs: '/a/docs',
    scratch: '/a/scratch',
    node: '/app/node',
    readable: ['/app/pi'],
    port: 43210,
  });
  assert.match(policy, /\(deny default\)/);
  assert.match(policy, /localhost:43210/);
  assert(!policy.split('\n').find(s => s.includes('file-write') && s.includes('/a/docs')));
  assert(!policy.includes('localhost:*'));
  assert.throws(() => profile({ port: '123)' }));
  const env = workerEnv({ scratch: '/private-job' });
  assert.equal(env.HOME, '/private-job');
  assert.equal(env.SSH_AUTH_SOCK, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
});
