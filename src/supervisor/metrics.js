import os from 'node:os';
import { command } from '../core.js';

export function descendantRss(output, rootPid) {
  const children = new Map();
  for (const row of output.trim().split('\n')) {
    const [pid, ppid, rss] = row.trim().split(/\s+/).map(Number);
    if (!pid || !Number.isFinite(rss)) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push({ pid, rss });
  }
  let total = 0;
  const pending = [rootPid],
    seen = new Set(pending);
  while (pending.length) {
    for (const child of children.get(pending.pop()) || []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      total += child.rss * 1024;
      pending.push(child.pid);
    }
  }
  return total;
}
export function measure() {
  const cpu = process.cpuUsage(),
    metrics = { peakDescendantRssBytes: null, minimumSystemFreeBytes: null, samples: 0 };
  let pending, timer;
  async function sample() {
    const { stdout } = await command('/bin/ps', ['-axo', 'pid=,ppid=,rss='], {
      signal: AbortSignal.timeout(2000),
    });
    metrics.peakDescendantRssBytes = Math.max(
      metrics.peakDescendantRssBytes || 0,
      descendantRss(stdout.toString(), process.pid)
    );
    metrics.minimumSystemFreeBytes = Math.min(metrics.minimumSystemFreeBytes ?? Infinity, os.freemem());
    metrics.samples++;
  }
  if (process.platform === 'darwin') {
    const take = () => {
      if (!pending)
        pending = sample()
          .catch(err => {
            metrics.samplingError = err.message;
          })
          .finally(() => {
            pending = null;
          });
    };
    take();
    timer = setInterval(take, 1000);
  }
  return async () => {
    clearInterval(timer);
    await pending;
    const delta = process.cpuUsage(cpu);
    return {
      ...metrics,
      supervisorCpuMicros: delta.user + delta.system,
      supervisorRssBytes: process.memoryUsage().rss,
    };
  };
}
