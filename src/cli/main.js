import fs from 'node:fs/promises';
import path from 'node:path';
import { check, integer, jobPaths, jsonFile, sleep, inside, safeId } from '../core.js';
import { dataHome, initialize } from '../config/index.js';
import { registry, modelFor, changeRegistry } from '../models/registry.js';
import { verify, download } from '../models/download.js';
import { sourceRoot, git } from '../workspace/snapshot.js';
import { Store, terminal } from '../jobs/store.js';
import { active, ensureService, serve, stopService, warm } from '../supervisor/service.js';
import { cancelQueued, validateSpec } from '../supervisor/job.js';
import { inspectRuntime, RuntimeManager } from '../inference/backends.js';
import { findPi } from '../agents/pi.js';
import { basicSeatbelt } from '../sandbox/macos-seatbelt.js';
import { budget } from '../models/registry.js';

async function doctor(ctx, id, model) {
  const checks = [];
  async function test(name, fn) {
    try {
      checks.push({ name, ok: true, detail: await fn() });
    } catch (err) {
      checks.push({ name, ok: false, detail: err.message, exitCode: err.exitCode || 3 });
    }
  }
  await test('node', () => process.version);
  await test('sqlite', () => 'Built-in SQLite, WAL');
  await test('git', async () => (await git(['--version'])).stdout.toString().trim());
  await test('model', () => ({ id, runtime: model.runtime, context: budget(model) }));
  if (model.runtime === 'mock') {
    await test('sandbox', () => 'Development mock, filesystem isolation is simulated');
    await test('inference', () => {
      check(model.options.available !== false, 'Mock inference unavailable', 4);
      return 'Deterministic mock';
    });
  } else {
    await test('seatbelt', async () => {
      await basicSeatbelt();
      return 'Baseline profile accepted. Each real job also probes its policy.';
    });
    await test('pi', async () => (await findPi(ctx.config)).version);
    await test('inference runtime', () => inspectRuntime(model, ctx.config));
    if (model.runtime !== 'external')
      await test('cached weights', async () => {
        const m = await verify(ctx.home, id, model, false);
        return { revision: m.revision, bytes: m.bytes };
      });
    else
      await test('external model', async () => {
        const manager = new RuntimeManager(ctx);
        try {
          await manager.use(id, model, budget(model));
          return 'Advertised by /v1/models';
        } finally {
          await manager.stop();
        }
      });
  }
  return { ok: checks.every(c => c.ok), checks, exitCode: checks.find(c => !c.ok)?.exitCode ?? 0 };
}
async function waitFor(ctx, store, id) {
  while (!terminal.includes(store.row(id).status)) {
    if (!active(ctx.home)) await ensureService(ctx, store);
    await sleep(90);
  }
  return jsonFile(jobPaths(ctx.home, id).result);
}
async function logs(ctx, store, id, follow, json) {
  const file = path.join(jobPaths(ctx.home, id).logs, 'events.jsonl');
  let offset = 0,
    partial = Buffer.alloc(0);
  const events = [];
  do {
    const done = terminal.includes(store.row(id).status);
    let handle;
    try {
      handle = await fs.open(file, 'r');
      const size = (await handle.stat()).size;
      while (offset < size) {
        const buf = Buffer.alloc(Math.min(65536, size - offset));
        const { bytesRead } = await handle.read(buf, 0, buf.length, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        partial = Buffer.concat([partial, buf.subarray(0, bytesRead)]);
        let end;
        while ((end = partial.indexOf(10)) >= 0) {
          const e = JSON.parse(partial.subarray(0, end));
          partial = partial.subarray(end + 1);
          if (follow)
            console.log(json ? JSON.stringify(e) : e.at + ' ' + e.type + (e.tool ? ' ' + e.tool : ''));
          else events.push(e);
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    } finally {
      await handle?.close();
    }
    if (done || !follow) break;
    if (!active(ctx.home)) await ensureService(ctx, store);
    await sleep(150);
  } while (true);
  return follow ? undefined : { events };
}
function human(v) {
  if (v.checks)
    return v.checks
      .map(
        c =>
          (c.ok ? 'OK   ' : 'FAIL ') +
          c.name +
          '  ' +
          (typeof c.detail === 'string' ? c.detail : JSON.stringify(c.detail))
      )
      .join('\n');
  if (v.jobs) return v.jobs.map(j => j.jobId + '  ' + j.status).join('\n') || 'No jobs.';
  if (v.models)
    return Object.entries(v.models)
      .map(([id, m]) => id + '  ' + m.runtime + (id === v.defaultModel ? '  (default)' : ''))
      .join('\n');
  if (v.events)
    return (
      v.events.map(e => e.at + ' ' + e.type + (e.tool ? ' ' + e.tool : '')).join('\n') || 'No events yet.'
    );
  if (v.jobId) return [v.jobId, v.status, v.summary || v.error].filter(Boolean).join('  ');
  if ('running' in v)
    return (v.running ? 'Supervisor running' : 'Supervisor stopped') + (v.model ? '  ' + v.model : '');
  return JSON.stringify(v, null, 2);
}
export async function main({ cmd, values: v, positionals: pos }) {
  const home = dataHome();
  if (cmd === 'run') {
    await sourceRoot(v.code, home);
    if (v.docs) await sourceRoot(v.docs, home);
  }
  const ctx = await initialize(home);
  if (cmd === 'supervise') return serve(ctx);
  const store = new Store(ctx.home);
  const id = pos[0];
  try {
    let value;
    switch (cmd) {
      case 'doctor':
      case 'start':
      case 'run': {
        const reg = await registry(ctx.home),
          modelId = v.model ?? reg.defaultModel,
          model = modelFor(reg, modelId);
        if (cmd === 'doctor') {
          value = await doctor(ctx, modelId, model);
          break;
        }
        if (cmd === 'start') {
          value = { running: true, ...(await warm(ctx, store, modelId)) };
          break;
        }
        if (v['prompt-file']) {
          const info = await fs.stat(v['prompt-file']).catch(err => {
            check(false, 'Cannot open prompt file: ' + err.message);
          });
          check(info.isFile() && info.size <= 262144, 'Expected a prompt file up to 262144 bytes');
        }
        const spec = await validateSpec(
          {
            code: path.resolve(v.code),
            docs: v.docs ? path.resolve(v.docs) : null,
            prompt: v.prompt ?? (await fs.readFile(v['prompt-file'], 'utf8')),
            modelId,
            model,
            context: Number(v.context ?? model.context.default),
            timeoutMs: Number(v['timeout-ms'] ?? ctx.config.timeoutMs),
            mockMode: v['mock-mode'] ?? 'success',
            mockDelayMs: Number(v['mock-delay-ms'] ?? 0),
          },
          ctx.home
        );
        await ensureService(ctx, store);
        const jobId = store.submit(spec);
        value = v.background ? { jobId, status: 'queued' } : await waitFor(ctx, store, jobId);
        break;
      }
      case 'stop':
        value = await stopService(ctx, store);
        break;
      case 'status': {
        if (id) {
          const row = store.row(id);
          value = {
            jobId: id,
            status: row.status,
            created: row.created,
            started: row.started,
            finished: row.finished,
            error: row.error,
            jobExitCode: row.exitCode,
            history: store.history(id),
          };
        } else {
          const service = store.service(),
            running = active(ctx.home);
          value = {
            running,
            pid: running ? service.pid : null,
            model: running ? service.model : null,
            dataDirectory: ctx.home,
          };
        }
        break;
      }
      case 'list':
        value = { jobs: store.list(v.status) };
        break;
      case 'wait':
        value = await waitFor(ctx, store, id);
        break;
      case 'cancel': {
        store.cancel(id);
        await cancelQueued(ctx, store);
        const row = store.row(id);
        if (!terminal.includes(row.status)) await ensureService(ctx, store);
        value = { jobId: id, status: row.status, cancelRequested: Boolean(row.cancel) };
        break;
      }
      case 'logs':
        value = await logs(ctx, store, id, v.follow, v.json);
        break;
      case 'diff':
      case 'export':
      case 'result': {
        const row = store.row(id);
        check(terminal.includes(row.status), 'Job has not finished');
        const p = jobPaths(ctx.home, id);
        if (cmd === 'result') value = await jsonFile(p.result);
        else if (cmd === 'diff') {
          const patch = await fs.readFile(p.patch);
          if (!v.json) {
            process.stdout.write(patch);
            return;
          }
          value = { jobId: id, patch: patch.toString() };
        } else {
          const output = path.resolve(v.output),
            parent = await fs.realpath(path.dirname(output)),
            spec = JSON.parse(row.spec);
          check(
            ![ctx.home, spec.code, spec.docs].filter(Boolean).some(dir => inside(dir, parent)),
            'Export outside the original inputs and Igor data directory'
          );
          await fs.copyFile(p.patch, output, fs.constants.COPYFILE_EXCL);
          value = { jobId: id, output };
        }
        break;
      }
      case 'model': {
        const [sub, key] = pos,
          reg = await registry(ctx.home);
        if (sub === 'list') value = reg;
        else if (sub === 'add') {
          await changeRegistry(ctx.home, key, await jsonFile(v.file));
          value = { registered: key };
        } else if (sub === 'remove') {
          await changeRegistry(ctx.home, key, null);
          value = { removed: key };
        } else {
          const m = modelFor(reg, key);
          if (sub === 'inspect') value = { id: key, model: m, budget: budget(m) };
          if (sub === 'download')
            value = await download(ctx.home, key, m, {
              progress: name => process.stderr.write('Checking ' + name + '\n'),
            });
          if (sub === 'verify' && m.runtime === 'external') {
            const manager = new RuntimeManager(ctx);
            try {
              await manager.use(key, m, budget(m));
              value = { id: key, modelId: m.options.modelId, advertised: true };
            } finally {
              await manager.stop();
            }
          } else if (sub === 'verify') value = await verify(ctx.home, safeId(key), m);
        }
        break;
      }
      case 'clean': {
        const days = integer(Number(v['older-than-days'] ?? 0), 'older-than-days', 0, 36500),
          cutoff = Date.now() - days * 86400000,
          removed = [];
        for (const job of store
          .list()
          .filter(j => terminal.includes(j.status) && Date.parse(j.finished) <= cutoff)) {
          const p = jobPaths(ctx.home, job.jobId);
          check(inside(path.join(ctx.home, 'jobs'), p.root), 'Unsafe cleanup target');
          const real = await fs.realpath(p.root).catch(err => {
            if (err.code === 'ENOENT') return p.root;
            throw err;
          });
          check(real === p.root, 'Unexpected linked job directory');
          await fs.rm(p.root, { recursive: true, force: true });
          store.db.prepare('DELETE FROM jobs WHERE id=?').run(job.jobId);
          removed.push(job.jobId);
        }
        value = { removed };
        break;
      }
    }
    if (value !== undefined) {
      process.exitCode = value.exitCode ?? 0;
      const output = v.json ? JSON.stringify({ schemaVersion: 1, ...value }) : human(value);
      console.log(output);
    }
  } finally {
    store.close();
  }
}
