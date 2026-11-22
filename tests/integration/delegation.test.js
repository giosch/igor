import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, invoke, repo } from '../helpers.js';

test('published Claude skill resolves its references and reviews the result, diff and tool evidence in one call', async t => {
  const skillDir = path.join(repo, 'skills', 'igor-delegate'),
    skill = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\r?\nname: igor-delegate\r?\ndescription: .+\r?\n---/);
  const refs = [...skill.matchAll(/\]\((references\/[^)]+)\)/g)];
  assert.equal(refs.length, 3);
  for (const [, file] of refs) await fs.access(path.join(skillDir, file));
  const { home, code, run } = await fixture(t),
    job = await run(['--background', '--mock-delay-ms', '250']);
  const finished = await invoke(home, ['wait', job.jobId]);
  const review = await invoke(home, ['review', job.jobId]);
  assert.deepEqual(review.result, finished);
  assert.deepEqual(review.verification.agent, finished.verification);
  assert.equal(review.verification.independent, null);
  assert.equal(review.verification.independentlyVerified, false);
  assert.deepEqual(review.result.filesChanged, ['igor-task.md']);
  assert(review.result.artifacts.patchComplete);
  assert.match(review.diff, /new file mode 100644/);
  assert(!(await fs.readdir(code)).includes('igor-task.md'));
  await invoke(home, ['verify', job.jobId], 2);
  if (process.platform !== 'darwin') await invoke(home, ['verify', job.jobId, '--check', 'exit 0'], 5);
});

test(
  'verify runs explicit checks against the patched original snapshot and records independent evidence',
  {
    skip: process.platform !== 'darwin',
    timeout: 30000,
  },
  async t => {
    const { root, home, code, run } = await fixture(t);
    const original = path.join(code, 'marker');
    const docs = path.join(root, 'docs');
    await fs.mkdir(docs);
    await fs.writeFile(path.join(docs, 'guide.txt'), 'reference');
    await fs.writeFile(original, 'captured');
    const job = await run(['--docs', docs]);
    await fs.writeFile(original, 'later edit');
    const failed = await invoke(
      home,
      ['verify', job.jobId, '--check', 'echo failure >&2; touch transient; exit 7'],
      1
    );
    assert.equal(failed.checkExitCode, 7);
    assert.match(failed.stderr, /failure/);
    assert.equal((await invoke(home, ['review', job.jobId])).verification.independent.status, 'failed');
    const passed = await invoke(home, [
      'verify',
      job.jobId,
      '--check',
      'test "$(cat marker)" = captured && test -f igor-task.md && test ! -e transient && cat ../docs/guide.txt',
    ]);
    assert.equal(passed.status, 'passed');
    assert.equal(passed.stdout, 'reference');
    const reviewed = await invoke(home, ['review', job.jobId]);
    assert.equal(reviewed.verification.independentlyVerified, true);
    assert.deepEqual(
      reviewed.verification.independent,
      Object.fromEntries(Object.entries(passed).filter(([key]) => key !== 'schemaVersion'))
    );
    assert.equal(await fs.readFile(original, 'utf8'), 'later edit');
    await assert.rejects(fs.access(path.join(code, 'igor-task.md')), { code: 'ENOENT' });
    assert(!(await fs.readdir(home)).some(name => name.startsWith('verify-')));
  }
);
test('simultaneous cold submissions elect a single supervisor and finish in durable FIFO order', async t => {
  const { home, run } = await fixture(t);
  const submitted = await Promise.all(
    Array.from({ length: 4 }, () => run(['--background', '--mock-delay-ms', '75']))
  );
  await Promise.all(submitted.map(j => invoke(home, ['wait', j.jobId])));
  const { jobs } = await invoke(home, ['list']);
  assert.equal(new Set(jobs.map(j => j.jobId)).size, 4);
  for (let i = 1; i < jobs.length; i++)
    assert(Date.parse(jobs[i].started) >= Date.parse(jobs[i - 1].finished));
});
