import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { check, jsonFile, saveJson } from '../core.js';
import { reconstruct } from '../workspace/patch.js';
import { prepareSeatbelt } from '../sandbox/macos-seatbelt.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const receiptPath = p => path.join(p.output, 'verification.json');

export async function reviewJob(p) {
  const [result, patch, receipt] = await Promise.all([
    jsonFile(p.result),
    fs.readFile(p.patch),
    fs.readFile(receiptPath(p), 'utf8').then(JSON.parse, err => {
      if (err.code !== 'ENOENT') throw err;
      return null;
    }),
  ]);
  const independent =
    patch.length && result.filesChanged.length && receipt?.patchSha256 === digest(patch) ? receipt : null;
  const diff = patch.toString('utf8');
  return {
    jobId: result.jobId,
    result,
    diff,
    ...(Buffer.from(diff).equals(patch) ? {} : { diffBase64: patch.toString('base64') }),
    verification: {
      agent: result.verification,
      independentlyVerified: independent?.status === 'passed',
      independent,
    },
  };
}

async function tail(stream) {
  let text = '';
  for await (const chunk of stream.setEncoding('utf8')) text = (text + chunk).slice(-32768);
  return text;
}

export async function verifyJob(ctx, p, command, { baseline = false } = {}) {
  check(process.platform === 'darwin', 'Job verification requires macOS Seatbelt', 5);
  const result = await jsonFile(p.result);
  check(result.artifacts.patchComplete, 'Job has no complete patch to verify');
  const [{ baseTree }, patch] = await Promise.all([
    jsonFile(path.join(p.output, 'manifest.json')),
    baseline ? Buffer.alloc(0) : fs.readFile(p.patch),
  ]);
  check(
    baseline || (patch.length > 0 && result.filesChanged.length > 0),
    'Job has an empty patch. Use --baseline to check the original snapshot.'
  );
  const root = await fs.mkdtemp(path.join(ctx.home, 'verify-'));
  const review = Object.fromEntries(
    ['code', 'docs', 'input', 'scratch'].map(dir => [dir, path.join(root, dir)])
  );
  try {
    await Promise.all(Object.values(review).map(dir => fs.mkdir(dir, { mode: 0o700 })));
    await reconstruct(p, review, baseTree, patch);
    const sandbox = await prepareSeatbelt(review, { readable: [] }, null);
    const start = Date.now();
    const signal = AbortSignal.timeout(ctx.config.timeoutMs);
    const proc = sandbox.execute('/bin/bash', ['-c', command]);
    const stop = () => void proc.stop().catch(() => {});
    signal.addEventListener('abort', stop, { once: true });
    proc.stdin.end();
    let completed, stdout, stderr;
    try {
      [completed, stdout, stderr] = await Promise.all([proc.done, tail(proc.stdout), tail(proc.stderr)]);
    } finally {
      signal.removeEventListener('abort', stop);
      await proc.stop();
    }
    const status = signal.aborted ? 'timed_out' : completed.code === 0 ? 'passed' : 'failed';
    const verification = {
      jobId: result.jobId,
      command,
      status,
      checkExitCode: completed.code,
      exitCode: status === 'passed' ? 0 : status === 'timed_out' ? 6 : 1,
      stdout,
      stderr,
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - start,
      ...(baseline ? { baseline: true } : { patchSha256: digest(patch) }),
    };
    if (!baseline) await saveJson(receiptPath(p), verification);
    return verification;
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
