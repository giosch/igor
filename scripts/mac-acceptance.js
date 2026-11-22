import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { check, command, jobPaths, mkdir, saveJson } from '../src/core.js';
import { dataHome, initialize } from '../src/config/index.js';
import { prepareJobDirs } from '../src/supervisor/job.js';
import { prepareSeatbelt } from '../src/sandbox/macos-seatbelt.js';
import { findPi } from '../src/agents/pi.js';
import { git } from '../src/workspace/snapshot.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const cli = path.join(root, 'src', 'cli', 'index.js');
async function run(args, env, timeout = 1200000) {
  const result = await command(process.execPath, [cli, ...args, '--json'], {
    env,
    signal: AbortSignal.timeout(timeout),
    allow: [0, 1, 2, 3, 4, 5, 6, 7],
  });
  const value = JSON.parse(result.stdout);
  check(result.code === 0, value.error || value.summary || JSON.stringify(value), result.code || 1);
  return value;
}
async function independentCheck(ctx, original, patch, review) {
  const p = jobPaths(review, 'job_' + randomUUID().replaceAll('-', ''));
  await prepareJobDirs(p);
  await fs.cp(original, p.code, { recursive: true });
  await git(['init', '-q'], { cwd: p.code });
  await git(['apply', '--check', patch], { cwd: p.code });
  await git(['apply', patch], { cwd: p.code });
  // Test the reviewed change under a fresh profile, with a host-owned oracle.
  const runtime = await findPi(ctx.config),
    listener = net.createServer(s => s.end());
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  let proc;
  try {
    const sandbox = await prepareSeatbelt(p, runtime, { port: listener.address().port });
    const oracle =
      "import assert from 'node:assert/strict';import {clamp} from './clamp.js';for(const [a,b,c,want] of [[-7,0,5,0],[2,0,5,2],[9,0,5,5],[-1,-9,-3,-3],[0.5,0,1,0.5]])assert.equal(clamp(a,b,c),want);";
    proc = sandbox.execute(process.execPath, ['--input-type=module', '-e', oracle]);
    proc.stdin.end();
    proc.stdout.resume();
    let err = '';
    proc.stderr.on('data', b => {
      err = (err + b).slice(-2000);
    });
    const timer = setTimeout(() => void proc.stop(), 15000);
    try {
      assert.equal((await proc.done).code, 0, 'Independent clamp check failed: ' + err);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await proc?.stop();
    await new Promise(resolve => listener.close(resolve));
  }
}
async function main() {
  check(
    process.platform === 'darwin' && process.arch === 'arm64',
    'Run this acceptance test on native Apple Silicon macOS',
    3
  );
  const options = process.argv.slice(2);
  check(
    options.every(s => s === '--64k'),
    'Supported option: --64k'
  );
  const ctx = await initialize(dataHome()),
    env = { ...process.env, IGOR_HOME: ctx.home },
    model = 'inkling-mini';
  const label = new Date().toISOString().replaceAll(':', '-'),
    out = path.join(ctx.home, 'acceptance', label);
  await mkdir(out);
  const report = {
    schemaVersion: 1,
    os: os.release(),
    chip: os.cpus()[0]?.model,
    totalBytes: os.totalmem(),
    node: process.version,
    checks: [],
  };
  async function record(name, action) {
    process.stderr.write(name + ' …\n');
    try {
      const evidence = await action();
      report.checks.push({ name, ok: true, evidence });
    } catch (err) {
      report.checks.push({ name, ok: false, error: err.message });
      throw err;
    } finally {
      await saveJson(path.join(out, 'report.json'), report);
    }
  }
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'igor-acceptance-'));
  const code = path.join(temp, 'sample');
  await fs.cp(path.join(root, 'examples', 'sample-project'), code, { recursive: true });
  const original = await fs.readFile(path.join(code, 'clamp.js'), 'utf8');
  const previous = await run(['status'], env);
  try {
    await record('Dependencies and registered model', () => run(['doctor', '--model', model], env));
    await record('Native confinement and scripted real Pi', async () => {
      const pi = await findPi(ctx.config);
      const result = await command(
        process.execPath,
        ['--test', 'tests/security/seatbelt.test.js', 'tests/integration/pi-live.test.js'],
        {
          cwd: root,
          env: { ...env, IGOR_TEST_PI: pi.entry, IGOR_REQUIRE_PI: '1' },
          signal: AbortSignal.timeout(120000),
        }
      );
      return result.stdout.toString().trim();
    });
    await record('Pinned weight checksums', () => run(['model', 'verify', model], env));
    await record('oMLX startup', () => run(['start', '--model', model], env));
    await record('Inkling coding task and independent patch verification', async () => {
      const result = await run(
        [
          'run',
          '--model',
          model,
          '--context',
          '32768',
          '--code',
          code,
          '--prompt-file',
          path.join(root, 'examples', 'task.md'),
        ],
        env
      );
      assert.deepEqual(result.filesChanged, ['clamp.js']);
      assert(result.agentCompleted);
      assert(
        result.verification.commands.some(c => c.ok && /\bnode\s+--test\b/.test(c.command)),
        'Pi did not run the requested test'
      );
      const exported = await run(['export', result.jobId, '--output', path.join(temp, 'changes.patch')], env);
      await fs.copyFile(exported.output, path.join(out, 'changes.patch'));
      await independentCheck(ctx, code, exported.output, path.join(temp, 'review'));
      assert.equal(await fs.readFile(path.join(code, 'clamp.js'), 'utf8'), original);
      assert.deepEqual((await fs.readdir(code)).sort(), ['clamp.js', 'clamp.test.js', 'package.json']);
      return {
        jobId: result.jobId,
        agentOutcome: result.agentOutcome,
        independentVerification: 'passed',
        resources: result.resources,
      };
    });
    await record('Lightning MTP activation', async () => {
      const log = await fs.readFile(path.join(ctx.home, 'runtime', model, 'server.log'), 'utf8');
      const match = log
        .split('\n')
        .find(s => /Speculative backend selected.*(?:DSpark|Lightning MTP).*active/i.test(s));
      check(
        match,
        'oMLX did not report an active DSpark/MTP backend. Inspect runtime/inkling-mini/server.log.',
        4
      );
      return match.trim();
    });
    for (const context of options.includes('--64k') ? [32768, 65536] : [32768]) {
      await record('Context and memory at ' + context + ' tokens', async () => {
        const input = context - 8192,
          marker = randomUUID(),
          file = path.join(temp, 'context-' + context + '.md');
        await fs.writeFile(
          file,
          'Read the padding without taking any tool actions. Return the marker in your summary.\n' +
            ' x'.repeat(Math.floor(input * 0.86)) +
            '\nMarker ' +
            marker
        );
        const result = await run(
          ['run', '--model', model, '--code', code, '--context', String(context), '--prompt-file', file],
          env
        );
        assert.equal(result.runtime.context.context, context);
        assert.match(result.summary, new RegExp(marker));
        assert.deepEqual(result.filesChanged, []);
        const logs = await run(['logs', result.jobId], env);
        const peak = Math.max(
          0,
          ...logs.events
            .filter(e => e.type === 'assistant_turn')
            .map(e => (e.usage?.input || 0) + (e.usage?.cacheRead || 0))
        );
        check(peak >= input * 0.8, 'Provider usage did not demonstrate the requested input load: ' + peak, 4);
        check(result.resources.samples > 0, 'No process memory samples were collected');
        return {
          jobId: result.jobId,
          context,
          outputReservation: 8192,
          observedInputTokens: peak,
          durationMs: result.durationMs,
          resources: result.resources,
        };
      });
    }
  } finally {
    try {
      if (!previous.running) await run(['stop'], env);
      else if (previous.model && previous.model !== model)
        await run(['start', '--model', previous.model], env);
    } finally {
      await fs.rm(temp, { recursive: true, force: true });
      console.log('Acceptance report: ' + path.join(out, 'report.json'));
    }
  }
}
main().catch(err => {
  console.error(err.message);
  process.exitCode = err.exitCode || 1;
});
