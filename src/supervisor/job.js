import path from 'node:path';
import fs from 'node:fs/promises';
import { check, integer, jobPaths, mkdir, saveJson, atomic, IgorError } from '../core.js';
import { sourceRoot, snapshot } from '../workspace/snapshot.js';
import { baseline, collectPatch, emptyPatch } from '../workspace/patch.js';
import { validateModel, budget } from '../models/registry.js';
import { gateway } from '../inference/gateway.js';
import { runMock } from '../agents/mock.js';
import { findPi, runPi } from '../agents/pi.js';
import { basicSeatbelt, prepareSeatbelt } from '../sandbox/macos-seatbelt.js';
import { measure } from './metrics.js';
import { exclusive } from '../jobs/store.js';
import { resultRecord, publish } from '../results/index.js';

export async function validateSpec(spec, home) {
  check(
    spec && typeof spec.prompt === 'string' && spec.prompt.trim() && Buffer.byteLength(spec.prompt) <= 262144,
    'Expected a prompt of 1–262144 bytes'
  );
  spec.code = await sourceRoot(spec.code, home);
  if (spec.docs) spec.docs = await sourceRoot(spec.docs, home);
  validateModel(spec.modelId, spec.model);
  budget(spec.model, spec.context);
  integer(spec.timeoutMs, 'timeout-ms', 1, 86400000);
  check(['success', 'task-failure', 'error', 'timeout'].includes(spec.mockMode), 'Invalid mock mode');
  integer(spec.mockDelayMs, 'mock-delay-ms', 0, 86400000);
  check(
    spec.model.runtime === 'mock' || (spec.mockMode === 'success' && spec.mockDelayMs === 0),
    'Mock options require a mock model'
  );
  return spec;
}
export async function prepareJobDirs(p) {
  for (const dir of [p.input, p.code, p.docs, p.scratch, p.logs, p.output]) await mkdir(dir);
}
function outcome(status, exitCode, message) {
  return { status, exitCode, error: message };
}
export async function executeJob(ctx, store, row, runtimes, isStopping) {
  const p = jobPaths(ctx.home, row.id),
    controller = new AbortController(),
    { signal } = controller;
  const started = Date.now(),
    metrics = measure();
  let spec,
    manifest,
    base,
    agentResult,
    observations,
    gate,
    backend,
    version,
    limits,
    changed = [],
    patchComplete = false;
  let result = outcome('failed', 1, 'Job did not finish'),
    timer,
    interval;
  await prepareJobDirs(p);
  const log = path.join(p.logs, 'events.jsonl'),
    errFile = path.join(p.logs, 'stderr.log');
  await fs.writeFile(errFile, '', { mode: 0o600 });
  const event = (type, detail = {}) =>
    fs.appendFile(
      log,
      JSON.stringify({ schemaVersion: 1, at: new Date().toISOString(), type, ...detail }) + '\n',
      { mode: 0o600 }
    );
  const monitor = () => {
    if (store.row(row.id).cancel) controller.abort(new IgorError('Job cancelled', 7));
    else if (isStopping()) controller.abort(new IgorError('Supervisor stopped', 1));
  };
  try {
    spec = await validateSpec(JSON.parse(row.spec), ctx.home);
    limits = budget(spec.model, spec.context);
    monitor();
    signal.throwIfAborted();
    timer = setTimeout(() => controller.abort(new IgorError('Job exceeded its timeout', 6)), spec.timeoutMs);
    interval = setInterval(monitor, 75);
    await atomic(path.join(p.input, 'prompt.md'), spec.prompt);
    await saveJson(path.join(p.input, 'job.json'), { schemaVersion: 1, ...spec, limits, config: ctx.config });
    await event('preparing', { model: spec.modelId });
    if (spec.model.runtime !== 'mock') await basicSeatbelt();
    manifest = await snapshot(spec, p, ctx.config.limits, signal);
    base = await baseline(p, manifest, signal);
    try {
      backend = await runtimes.use(spec.modelId, spec.model, limits, signal);
    } finally {
      store.db.prepare('UPDATE service SET model=? WHERE singleton=1').run(backend ? spec.modelId : null);
    }
    let runtime, sandbox;
    if (spec.model.runtime !== 'mock') {
      runtime = await findPi(ctx.config);
      version = runtime.version;
      gate = await gateway(backend, spec.model, limits);
      sandbox = await prepareSeatbelt(p, runtime, gate, signal);
    }
    signal.throwIfAborted();
    store.transition(row.id, 'running');
    await event('running', { agent: runtime ? 'pi' : 'mock', sandbox: sandbox?.name ?? 'development-mock' });
    const args = {
      spec,
      p,
      signal,
      event,
      gate,
      runtime,
      sandbox,
      model: spec.model,
      limits,
      stderr: bytes => fs.appendFile(errFile, bytes),
    };
    agentResult = runtime ? await runPi(args) : await runMock(args);
    monitor();
    signal.throwIfAborted();
    store.transition(row.id, 'finalizing');
    await event('finalizing');
    changed = await collectPatch(p, manifest, base, ctx.config.limits, signal);
    patchComplete = true;
    monitor();
    signal.throwIfAborted();
    result = outcome('completed', agentResult.reported === 'failed' ? 1 : 0, null);
  } catch (error) {
    observations = error.observations;
    const err = signal.aborted ? signal.reason : error,
      code = err.exitCode || 1;
    const status =
      code === 7 ? 'cancelled' : code === 6 ? 'timed_out' : isStopping() ? 'interrupted' : 'failed';
    result = outcome(status, code, err.message);
    await fs.appendFile(errFile, err.message + '\n');
    if (base && !patchComplete) {
      try {
        changed = await collectPatch(p, manifest, base, ctx.config.limits, AbortSignal.timeout(30000));
        patchComplete = true;
      } catch (patchErr) {
        await event('patch_error', { message: patchErr.message });
      }
    }
  } finally {
    clearTimeout(timer);
    clearInterval(interval);
    await gate?.close();
  }
  if (!patchComplete) await emptyPatch(p);
  const resources = await metrics();
  const detail = resultRecord({
    jobId: row.id,
    spec,
    outcome: result,
    agent: agentResult,
    observations,
    filesChanged: changed,
    baseRevision: manifest?.code.revision,
    patchComplete,
    durationMs: Date.now() - started,
    runtime: {
      context: limits ?? null,
      piVersion: version ?? null,
      backendVersion: backend?.version ?? null,
      modelRevision: backend?.revision ?? null,
    },
    resources: { ...resources, tokenUsage: agentResult?.usage ?? observations?.usage ?? null },
  });
  await event('finished', { status: detail.status, exitCode: detail.exitCode });
  await publish(store, p, detail);
}
export async function recover(ctx, store) {
  const row = store.active();
  if (!row) return;
  const p = jobPaths(ctx.home, row.id);
  await prepareJobDirs(p);
  let saved;
  try {
    saved = JSON.parse(await fs.readFile(p.result, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
  }
  if (
    saved?.schemaVersion === 1 &&
    saved.jobId === row.id &&
    ['completed', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(saved.status)
  ) {
    store.transition(row.id, saved.status, saved.exitCode, saved.error);
    return;
  }
  const error = 'Supervisor exited during ' + row.status + '. The job was not replayed.';
  await recordTerminal(store, p, row, 'interrupted', 1, error);
}
async function recordTerminal(store, p, row, status, code, error) {
  const spec = (() => {
    try {
      return JSON.parse(row.spec);
    } catch {
      return {};
    }
  })();
  await emptyPatch(p);
  await fs.appendFile(
    path.join(p.logs, 'events.jsonl'),
    JSON.stringify({ schemaVersion: 1, at: new Date().toISOString(), type: status, message: error }) + '\n'
  );
  await fs.appendFile(path.join(p.logs, 'stderr.log'), error + '\n');
  if (typeof spec.prompt === 'string') await atomic(path.join(p.input, 'prompt.md'), spec.prompt);
  await publish(
    store,
    p,
    resultRecord({
      jobId: row.id,
      spec,
      outcome: outcome(status, code, error),
      durationMs: row.started ? Date.now() - Date.parse(row.started) : 0,
    })
  );
}
export async function cancelQueued(ctx, store) {
  const pending = store.db.prepare("SELECT id FROM jobs WHERE status='queued' AND cancel=1").all();
  if (!pending.length) return;
  const lock = exclusive(path.join(ctx.home, 'runtime', 'cancel.lock'));
  if (!lock) return;
  try {
    for (const { id } of pending) {
      const row = store.db.prepare("SELECT * FROM jobs WHERE id=? AND status='queued' AND cancel=1").get(id);
      if (!row) continue;
      const p = jobPaths(ctx.home, id);
      await prepareJobDirs(p);
      await recordTerminal(store, p, row, 'cancelled', 7, 'Job cancelled before execution');
    }
  } finally {
    lock.close();
  }
}
