import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { parse } from '../../src/cli/args.js';
import { defaultConfig, validateConfig, initialize } from '../../src/config/index.js';
import defaults from '../../examples/models.json' with { type: 'json' };
import { budget, validateModel, registry, changeRegistry } from '../../src/models/registry.js';
import { Store, exclusive } from '../../src/jobs/store.js';
import { temp } from '../helpers.js';
import { resultRecord } from '../../src/results/index.js';
import resultSchema from '../../docs/result.schema.json' with { type: 'json' };
import { jobPaths, saveJson } from '../../src/core.js';
import { recover, prepareJobDirs } from '../../src/supervisor/job.js';
import { descendantRss } from '../../src/supervisor/metrics.js';

test('CLI options are typed, exclusive and command-specific', () => {
  const args = parse(['--json', 'run', '--prompt', 'fix', '--code', 'a b', '--background']);
  assert.equal(args.values.code, 'a b');
  assert.equal(args.values.background, true);
  for (const invalid of [
    ['run', '--prompt', 'x'],
    ['run', '--code', 'x', '--prompt', 'p', '--prompt-file', 'f'],
    ['status', '--model', 'm'],
    ['result'],
    ['export', 'j'],
    ['list', '--json', '--json'],
    ['model', 'add', 'new'],
    ['start', '--unsafe'],
  ]) {
    assert.throws(() => parse(invalid));
  }
});
test('configuration and registry reject incompatible definitions and reserve output', () => {
  assert.throws(() => validateConfig({ ...defaultConfig, timeoutMs: -1 }));
  assert.throws(() => validateConfig({ ...defaultConfig, extra: 0 }));
  const m = defaults.models['inkling-mini'];
  assert.equal(validateModel('inkling-mini', m), m);
  assert.deepEqual(budget(m, 1000000), {
    context: 65536,
    output: 8192,
    input: 57344,
    reserve: 8192,
    keepRecent: 14336,
  });
  assert.throws(() => budget(m, 4096));
  assert.throws(() => validateModel('x', { ...m, runtime: 'llamacpp' }));
  assert.throws(() => validateModel('x', { ...m, capabilities: { tools: false } }));
  assert.throws(() => validateModel('../x', m));
  assert.throws(() => validateModel('con', m));
  assert.throws(() => validateModel('x', { ...m, source: { ...m.source, repository: '../a' } }));
});
test('model add and remove persist without side effects on weights', async t => {
  const home = await temp(t);
  await initialize(home);
  await changeRegistry(home, 'local', defaults.models.mock);
  assert.equal((await registry(home)).models.local.runtime, 'mock');
  assert.deepEqual(await fs.readdir(path.join(home, 'cache')), []);
  await assert.rejects(changeRegistry(home, 'local', defaults.models.mock));
  await changeRegistry(home, 'local', null);
  assert.equal((await registry(home)).models.local, undefined);
});
test('transactional FIFO claim, singleton, rollback and durable history', async t => {
  let a, b;
  t.after(() => {
    a?.close();
    b?.close();
  });
  const home = await temp(t);
  await initialize(home);
  a = new Store(home);
  b = new Store(home);
  const first = a.submit({}),
    second = b.submit({});
  assert.notEqual(first, second);
  assert.equal(a.claim().id, first);
  assert.equal(b.claim(), null);
  assert.throws(() => a.transition(first, 'completed'));
  assert.equal(b.row(first).status, 'preparing');
  a.transition(first, 'running');
  a.transition(first, 'finalizing');
  a.transition(first, 'completed', 0);
  assert.equal(b.claim().id, second);
  assert.deepEqual(
    b.history(first).map(s => s.status),
    ['queued', 'preparing', 'running', 'finalizing', 'completed']
  );
  const lock = exclusive(path.join(home, 'test.lock'));
  assert.equal(exclusive(path.join(home, 'test.lock')), null);
  lock.close();
});
test('a result published just before a crash is committed exactly once on restart', async t => {
  let store;
  t.after(() => store?.close());
  const home = await temp(t),
    ctx = await initialize(home);
  store = new Store(home);
  const id = store.submit({ modelId: 'mock', model: defaults.models.mock }),
    row = store.claim();
  store.transition(id, 'running');
  store.transition(id, 'finalizing');
  const p = jobPaths(home, id);
  await prepareJobDirs(p);
  const detail = resultRecord({
    jobId: id,
    spec: JSON.parse(row.spec),
    outcome: { status: 'completed', exitCode: 0, error: null },
    agent: { reported: 'success', summary: 'done', commands: [] },
    durationMs: 100,
    patchComplete: true,
  });
  for (const field of resultSchema.required) assert(Object.hasOwn(detail, field));
  await saveJson(p.result, detail);
  await recover(ctx, store);
  await recover(ctx, store);
  assert.equal(store.row(id).status, 'completed');
  assert.equal(store.history(id).filter(e => e.status === 'completed').length, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(p.result)), detail);
});
test('process memory measurements include only descendants of the supervisor', () => {
  assert.equal(descendantRss('1 0 999\n2 1 100\n3 2 300\n6 3 200\n7 1 500\n', 2), 500 * 1024);
});
