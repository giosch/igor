import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, invoke, repo, cli } from '../helpers.js';
import { command } from '../../src/core.js';
import { git } from '../../src/workspace/snapshot.js';

test('published Claude skill resolves its references and its submit-review-apply workflow works in a disposable checkout', async t => {
  const skillDir = path.join(repo, 'skills', 'igor-delegate'),
    skill = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
  assert.match(skill, /^---\r?\nname: igor-delegate\r?\ndescription: .+\r?\n---/);
  const refs = [...skill.matchAll(/\]\((references\/[^)]+)\)/g)];
  assert.equal(refs.length, 3);
  for (const [, file] of refs) await fs.access(path.join(skillDir, file));
  const { home, code, root, run } = await fixture(t),
    job = await run(['--background', '--mock-delay-ms', '250']);
  const followed = await command(process.execPath, [cli, 'logs', job.jobId, '--follow', '--json'], {
    env: { ...process.env, IGOR_HOME: home },
    signal: AbortSignal.timeout(15000),
  });
  const events = followed.stdout
    .toString()
    .trim()
    .split('\n')
    .map(line => JSON.parse(line));
  assert.equal(events.at(-1).type, 'finished');
  await invoke(home, ['wait', job.jobId]);
  const result = await invoke(home, ['result', job.jobId]);
  assert.equal(result.verification.independentlyVerified, false);
  assert.deepEqual(result.filesChanged, ['igor-task.md']);
  assert(result.artifacts.patchComplete);
  const preview = await invoke(home, ['diff', job.jobId]);
  assert.match(preview.patch, /new file mode 100644/);
  const patch = path.join(root, 'review.patch'),
    review = path.join(root, 'review');
  await invoke(home, ['export', job.jobId, '--output', patch]);
  await fs.cp(code, review, { recursive: true });
  await git(['init', '-q'], { cwd: review });
  await git(['apply', '--check', patch], { cwd: review });
  await git(['apply', patch], { cwd: review });
  assert.match(
    await fs.readFile(path.join(review, 'igor-task.md'), 'utf8'),
    /^# Mock task\n\nPrompt SHA-256: [a-f0-9]{64}\n$/
  );
  assert(!(await fs.readdir(code)).includes('igor-task.md'));
});
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
