import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, invoke, until } from '../helpers.js';
import { jobPaths } from '../../src/core.js';
import { Store } from '../../src/jobs/store.js';

test('CLI service, blocking job, export, result, clean and source immutability', async t => {
  const { root, home, code, run } = await fixture(t);
  assert((await invoke(home, ['doctor', '--model', 'mock'])).ok);
  await invoke(home, ['start', '--model', 'mock']);
  const pid = (await invoke(home, ['status'])).pid;
  await Promise.all([invoke(home, ['start', '--model', 'mock']), invoke(home, ['start', '--model', 'mock'])]);
  assert.equal((await invoke(home, ['status'])).pid, pid);
  const result = await run();
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.filesChanged, ['igor-task.md']);
  assert.equal(result.verification.independentlyVerified, false);
  assert.deepEqual(await invoke(home, ['result', result.jobId]), result);
  assert.equal((await invoke(home, ['status', result.jobId])).history.length, 5);
  assert.equal((await invoke(home, ['list', '--status', 'completed'])).jobs.length, 1);
  const output = path.join(root, 'changes.patch');
  await invoke(home, ['export', result.jobId, '--output', output]);
  assert.equal(await fs.readFile(output, 'utf8'), (await invoke(home, ['diff', result.jobId])).patch);
  assert.match((await invoke(home, ['logs', result.jobId])).events.at(-1).type, /finished/);
  assert(!(await fs.readdir(code)).includes('igor-task.md'));
  await invoke(home, ['export', result.jobId, '--output', path.join(code, 'bad.patch')], 2);
  assert.equal((await invoke(home, ['clean'])).removed.length, 1);
  await invoke(home, ['result', result.jobId], 2);
});
test('multiple submitting processes, FIFO, queued and running cancellation, timeouts and agent failures', async t => {
  const { home, run } = await fixture(t);
  const a = await run(['--background', '--mock-delay-ms', '4000']);
  const b = await run(['--background']);
  const c = await run(['--background']);
  await invoke(home, ['cancel', b.jobId]);
  await invoke(home, ['cancel', a.jobId]);
  for (const id of [a.jobId, b.jobId])
    assert.equal((await invoke(home, ['wait', id], 7)).status, 'cancelled');
  await invoke(home, ['wait', c.jobId]);
  const jobs = (await invoke(home, ['list'])).jobs;
  assert.deepEqual(
    jobs.map(j => j.jobId),
    [a.jobId, b.jobId, c.jobId]
  );
  assert.equal(jobs[1].started, null);
  assert(Date.parse(jobs[2].started) >= Date.parse(jobs[0].finished));
  assert.equal((await run(['--timeout-ms', '90', '--mock-mode', 'timeout'], 6)).status, 'timed_out');
  const failed = await run(['--mock-mode', 'task-failure'], 1);
  assert.equal(failed.status, 'completed');
  assert.equal(failed.agentOutcome, 'failed');
  const error = await run(['--mock-mode', 'error'], 4);
  assert.equal(error.agentCompleted, false);
  assert.match(error.error, /inference/);
  assert((await fs.readFile(jobPaths(home, error.jobId).result, 'utf8')).includes('exitCode'));
});
test('hard supervisor exit interrupts claimed work, preserves queued work and reconciles on restart', async t => {
  const { home, run } = await fixture(t);
  const a = await run(['--background', '--mock-delay-ms', '8000']),
    b = await run(['--background']);
  await until(async () => (await invoke(home, ['status', a.jobId])).status === 'running');
  const pid = (await invoke(home, ['status'])).pid;
  process.kill(pid, 'SIGKILL');
  await until(async () => !(await invoke(home, ['status'])).running);
  await invoke(home, ['start', '--model', 'mock']);
  assert.equal((await invoke(home, ['result', a.jobId], 1)).status, 'interrupted');
  assert.equal((await invoke(home, ['wait', b.jobId])).status, 'completed');
  const db = new Store(home);
  const bad = db.submit({});
  db.close();
  assert.equal((await invoke(home, ['wait', bad], 2)).status, 'failed');
});
