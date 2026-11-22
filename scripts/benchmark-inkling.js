import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { check, command, jobPaths, jsonFile, mkdir, saveJson } from '../src/core.js';
import { dataHome, initialize } from '../src/config/index.js';

const cli = fileURLToPath(new URL('../src/cli/index.js', import.meta.url));
const model = 'inkling-mini';

async function benchmark() {
  const { values } = parseArgs({
    options: Object.fromEntries(
      ['code', 'docs', 'prompt-file', 'check', 'context'].map(key => [key, { type: 'string' }])
    ),
  });
  check(
    values.code && values['prompt-file'] && values.check,
    "Usage: node scripts/benchmark-inkling.js --code DIR --prompt-file FILE --check 'CMD' [--docs DIR] [--context TOKENS]"
  );
  check(
    process.platform === 'darwin' && process.arch === 'arm64',
    'Inkling benchmarking requires Apple Silicon',
    5
  );
  const { home } = await initialize(dataHome());
  const env = { ...process.env, IGOR_HOME: home };
  async function igor(args) {
    const { stdout } = await command(process.execPath, [cli, ...args, '--json'], {
      env,
      allow: [0, 1, 2, 3, 4, 5, 6, 7],
    });
    return JSON.parse(stdout);
  }
  const doctor = await igor(['doctor', '--model', model]);
  check(doctor.ok, JSON.stringify(doctor.checks?.filter(c => !c.ok) ?? doctor), doctor.exitCode);
  const root = path.join(home, 'benchmarks');
  await mkdir(root);
  const runDir = await fs.mkdtemp(path.join(root, 'inkling-'));
  const reportFile = path.join(runDir, 'report.json');
  const prompt = path.join(runDir, 'task.md');
  await fs.copyFile(values['prompt-file'], prompt);
  const report = { schemaVersion: 1, model, check: values.check, comparable: true, trials: [] };
  console.error('Benchmark report: ' + reportFile);
  let reference;

  for (const effort of ['default', 'none', 'low']) {
    console.error('Running Inkling with reasoning effort ' + effort);
    const started = Date.now();
    const result = await igor([
      'run',
      '--code',
      values.code,
      '--prompt-file',
      prompt,
      '--model',
      model,
      '--reasoning-effort',
      effort,
      ...(values.docs ? ['--docs', values.docs] : []),
      ...(values.context ? ['--context', values.context] : []),
    ]);
    check(result.jobId, result.error || 'Igor did not return a job ID');
    check(
      result.runtime?.reasoningEffort === effort,
      'The job did not record the requested effort. Run igor stop and retry with v0.1.5 or later.'
    );
    const runWallMs = Date.now() - started;
    const review = await igor(['review', result.jobId]);
    check(review.result, review.error || 'Igor did not return a review');
    await saveJson(path.join(runDir, effort + '-review.json'), review);
    const snapshot = await jsonFile(path.join(jobPaths(home, result.jobId).input, 'snapshot.json')).catch(
      err => {
        if (result.artifacts.patchComplete) throw err;
        return null;
      }
    );
    const snapshotSha256 = snapshot
      ? createHash('sha256')
          .update(JSON.stringify([snapshot.code.files, snapshot.docs?.files ?? null]))
          .digest('hex')
      : null;
    if (effort === 'default') reference = snapshotSha256;
    report.comparable &&= Boolean(reference) && snapshotSha256 === reference;
    const checked = result.artifacts.patchComplete
      ? await igor(['verify', result.jobId, '--check', values.check])
      : { status: 'skipped', detail: 'Job did not capture a complete patch' };
    const verification = checked.status ? checked : { ...checked, status: 'error' };
    report.trials.push({
      effort,
      jobId: result.jobId,
      snapshotSha256,
      status: result.status,
      exitCode: result.exitCode,
      completionReason: result.completionReason ?? null,
      finalStopReason: result.finalStopReason ?? null,
      tokenUsage: result.resources?.tokenUsage ?? null,
      runtime: result.runtime,
      runWallMs,
      filesChanged: result.filesChanged,
      patchPass: result.filesChanged.length > 0 && verification.status === 'passed',
      verification,
    });
    await saveJson(reportFile, report);
  }
  console.log(JSON.stringify({ ...report, reportFile }, null, 2));
  if (!report.comparable) process.exitCode = 1;
}

try {
  await benchmark();
} catch (err) {
  console.error(err.message);
  process.exitCode = err.exitCode || 1;
}
