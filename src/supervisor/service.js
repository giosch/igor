import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { check, sleep, IgorError } from '../core.js';
import { Store, exclusive } from '../jobs/store.js';
import { registry, modelFor, budget } from '../models/registry.js';
import { RuntimeManager } from '../inference/backends.js';
import { cancelQueued, executeJob, recover } from './job.js';

const lockPath = home => path.join(home, 'runtime', 'supervisor.lock');
export function active(home) {
  const lock = exclusive(lockPath(home));
  if (!lock) return true;
  lock.close();
  return false;
}
export async function serve(ctx) {
  const lock = exclusive(lockPath(ctx.home));
  if (!lock) return;
  let store,
    manager,
    stopping = false,
    owner = randomUUID();
  const stop = () => {
    stopping = true;
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  try {
    store = new Store(ctx.home);
    manager = new RuntimeManager(ctx);
    store.db
      .prepare(
        "UPDATE service SET owner=?,pid=?,state='starting',stop=0,model=NULL,request=NULL,response=NULL"
      )
      .run(owner, process.pid);
    await recover(ctx, store);
    store.db.exec("UPDATE service SET state='ready'");
    const requestedStop = () => stopping || Boolean(store.service().stop);
    while (!requestedStop()) {
      await cancelQueued(ctx, store);
      const service = store.service();
      if (service.request) {
        const req = JSON.parse(service.request);
        let reply;
        const controller = new AbortController();
        const watch = setInterval(() => {
          if (requestedStop()) controller.abort(new IgorError('Supervisor stopped'));
        }, 100);
        try {
          const model = modelFor(await registry(ctx.home), req.model);
          await manager.use(req.model, model, budget(model), controller.signal);
          reply = { id: req.id, model: req.model, ok: true };
        } catch (err) {
          reply = { id: req.id, ok: false, error: err.message, exitCode: err.exitCode || 1 };
        } finally {
          clearInterval(watch);
        }
        store.db
          .prepare('UPDATE service SET model=?,request=NULL,response=? WHERE request=?')
          .run(reply.ok ? req.model : null, JSON.stringify(reply), service.request);
        continue;
      }
      const job = store.claim();
      if (job) await executeJob(ctx, store, job, manager, requestedStop);
      else await sleep(80);
    }
  } finally {
    try {
      await manager?.stop();
      store?.db
        .prepare("UPDATE service SET state='stopped',pid=NULL,owner=NULL,model=NULL WHERE owner=?")
        .run(owner);
    } finally {
      store?.close();
      lock.close();
      process.off('SIGTERM', stop);
      process.off('SIGINT', stop);
    }
  }
}
export async function ensureService(ctx, store) {
  if (active(ctx.home) && store.service().state === 'ready' && !store.service().stop) return;
  const log = path.join(ctx.home, 'runtime', 'supervisor.log');
  let failure,
    spawnedAt = 0;
  const deadline = Date.now() + Math.max(10000, store.service().stop ? ctx.config.startupMs + 35000 : 10000);
  do {
    if (failure) throw failure;
    if (active(ctx.home)) {
      const service = store.service();
      if (service.state === 'ready' && !service.stop) return;
    } else if (Date.now() - spawnedAt > 1000) {
      const fd = fs.openSync(log, 'a', 0o600);
      try {
        const child = spawn(
          process.execPath,
          [fileURLToPath(new URL('../cli/index.js', import.meta.url)), 'supervise'],
          {
            cwd: ctx.home,
            env: { ...process.env, IGOR_HOME: ctx.home },
            detached: true,
            windowsHide: true,
            stdio: ['ignore', fd, fd],
          }
        );
        child.on('error', err => {
          failure = err;
        });
        child.unref();
        spawnedAt = Date.now();
      } finally {
        fs.closeSync(fd);
      }
    }
    await sleep(50);
  } while (Date.now() < deadline);
  throw new IgorError('Supervisor did not start. Inspect ' + log);
}
export async function warm(ctx, store, model) {
  await ensureService(ctx, store);
  const deadline = Date.now() + ctx.config.startupMs + ctx.config.timeoutMs + 10000;
  const id = randomUUID(),
    req = JSON.stringify({ id, model });
  let lock;
  while (!(lock = exclusive(path.join(ctx.home, 'runtime', 'start.lock')))) {
    check(Date.now() < deadline, 'Another start request is still pending', 4);
    await sleep(60);
  }
  try {
    store.db.prepare('UPDATE service SET request=?,response=NULL').run(req);
    do {
      const response = store.service().response;
      if (response) {
        const reply = JSON.parse(response);
        if (reply.id === id) {
          if (!reply.ok) throw new IgorError(reply.error, reply.exitCode);
          return { model, ready: true };
        }
      }
      check(active(ctx.home), 'Supervisor stopped while starting inference', 1);
      await sleep(50);
    } while (Date.now() < deadline);
    throw new IgorError('Inference startup timed out', 4);
  } finally {
    lock.close();
  }
}
export async function stopService(ctx, store) {
  if (!active(ctx.home)) return { running: false };
  store.db.exec('UPDATE service SET stop=1');
  const deadline = Date.now() + ctx.config.startupMs + 35000;
  while (active(ctx.home) && Date.now() < deadline) await sleep(50);
  check(!active(ctx.home), 'Supervisor did not stop within its shutdown deadline');
  return { running: false };
}
