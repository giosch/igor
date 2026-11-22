import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { git, snapshot, inventory } from '../../src/workspace/snapshot.js';
import { baseline, collectPatch } from '../../src/workspace/patch.js';
import { defaultConfig } from '../../src/config/index.js';
import { jobPaths } from '../../src/core.js';
import { prepareJobDirs } from '../../src/supervisor/job.js';
import { temp } from '../helpers.js';

test('nested documentation stays outside the writable snapshot and cannot be introduced by the patch', async t => {
  const root = await temp(t),
    code = path.join(root, 'project'),
    docs = path.join(code, 'guide');
  await fs.mkdir(docs, { recursive: true });
  await fs.writeFile(path.join(docs, 'notes.md'), 'reference');
  await fs.writeFile(path.join(code, 'main.js'), 'source');
  const p = jobPaths(root, 'job_' + 'b'.repeat(32));
  await prepareJobDirs(p);
  const captured = await snapshot({ code, docs }, p, defaultConfig.limits);
  assert.deepEqual(await fs.readdir(p.code), ['main.js']);
  assert.equal(await fs.readFile(path.join(p.docs, 'notes.md'), 'utf8'), 'reference');
  const base = await baseline(p, captured);
  await fs.mkdir(path.join(p.code, 'guide'));
  await fs.writeFile(path.join(p.code, 'guide', 'notes.md'), 'replacement');
  assert.deepEqual(await collectPatch(p, captured, base, defaultConfig.limits), []);
  assert.equal(await fs.readFile(p.patch, 'utf8'), '');
});

test('patch round-trips dirty tracked, untracked, binary, rename, delete, CRLF and executable files', async t => {
  const root = await temp(t),
    code = path.join(root, 'original'),
    docs = path.join(root, 'docs');
  await fs.mkdir(code);
  await fs.mkdir(docs);
  await fs.writeFile(path.join(docs, 'guide.md'), 'guide');
  const g = args => git(args, { cwd: code });
  await g(['init', '-q']);
  const write = (n, v) => fs.writeFile(path.join(code, n), v);
  await write('edit.txt', 'initial\n');
  await write('gone.txt', 'remove\n');
  await write('move me.txt', 'unchanged\n');
  await write('blob.bin', Buffer.from([0, 1, 2, 3]));
  await write('already-gone', 'missing');
  await write('.gitignore', 'ignored*\n');
  await write('script', '#!/bin/sh\n');
  await g(['add', '.']);
  await g(['update-index', '--chmod=+x', 'script']);
  await g(['-c', 'user.name=Igor', '-c', 'user.email=igor@localhost', 'commit', '-qm', 'initial']);
  if (process.platform !== 'win32') await fs.chmod(path.join(code, 'script'), 0o755);
  await fs.unlink(path.join(code, 'already-gone'));
  await write('edit.txt', 'user edit\r\n');
  await write('untracked.js', 'const local = 1;\n');
  await write('ignored.bin', 'ignored');
  await write('.env', 'example-secret');
  const p = jobPaths(root, 'job_' + 'a'.repeat(32));
  await prepareJobDirs(p);
  const initial = await snapshot({ code, docs }, p, defaultConfig.limits);
  assert.match(initial.code.revision, /^\w{40}$/);
  assert.deepEqual(initial.code.deleted, ['already-gone']);
  assert.equal(initial.docs.files[0].path, 'guide.md');
  assert(initial.code.excluded.includes('.env'));
  assert(!initial.code.files.some(f => ['ignored.bin', '.git', '.env'].includes(f.path)));
  assert.equal(initial.code.files.find(f => f.path === 'script').mode, '100755');
  const tree = await baseline(p, initial);
  const clone = path.join(root, 'applicability');
  await fs.cp(p.code, clone, { recursive: true });
  // Apply inside a separate repository so Git never discovers the development checkout.
  await git(['init', '-q'], { cwd: clone });
  await fs.writeFile(path.join(p.code, 'edit.txt'), 'worker edit\r\n');
  await fs.unlink(path.join(p.code, 'gone.txt'));
  await fs.rename(path.join(p.code, 'move me.txt'), path.join(p.code, 'moved.txt'));
  await fs.writeFile(path.join(p.code, 'blob.bin'), Buffer.from([0, 9, 8]));
  await fs.writeFile(path.join(p.code, 'added.txt'), 'hello\n');
  const changed = await collectPatch(p, initial, tree, defaultConfig.limits);
  assert(changed.includes('moved.txt'));
  const patch = await fs.readFile(p.patch);
  assert.match(patch.toString(), /GIT binary patch/);
  assert.match(patch.toString(), /rename from/);
  await git(['apply', '--check', p.patch], { cwd: clone });
  await git(['apply', p.patch], { cwd: clone });
  assert.equal(await fs.readFile(path.join(clone, 'edit.txt'), 'utf8'), 'worker edit\r\n');
  assert.deepEqual(await fs.readFile(path.join(clone, 'blob.bin')), Buffer.from([0, 9, 8]));
  assert.equal(await fs.readFile(path.join(code, 'edit.txt'), 'utf8'), 'user edit\r\n');
  assert.equal(await fs.readFile(path.join(code, 'gone.txt'), 'utf8'), 'remove\n');
  await assert.rejects(
    inventory(code, { ...defaultConfig.limits, fileBytes: 2 }, { source: true }),
    /limit exceeded/
  );
});
