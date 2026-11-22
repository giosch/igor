import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { sleep, IgorError } from '../core.js';
import { DevelopmentSandbox } from '../sandbox/development.js';

export async function runMock({ spec, p, signal, event }) {
  const sandbox = new DevelopmentSandbox(),
    session = sandbox.prepare(p, 'mock');
  await sleep(spec.mockDelayMs || 1, null, { signal });
  if (spec.mockMode === 'error') throw new IgorError('Simulated inference failure', 4);
  if (spec.mockMode === 'timeout') await sleep(86400000, null, { signal });
  const file = sandbox.writeTarget(session, 'igor-task.md');
  const digest = createHash('sha256').update(spec.prompt).digest('hex');
  await event('tool_start', { tool: 'write', path: 'igor-task.md' });
  await fs.writeFile(file, '# Mock task\n\nPrompt SHA-256: ' + digest + '\n', { mode: 0o600, signal });
  await event('tool_end', { tool: 'write', ok: true });
  const failed = spec.mockMode === 'task-failure';
  return {
    summary: failed
      ? 'The mock agent reported an unmet acceptance criterion.'
      : 'The mock agent wrote igor-task.md.',
    reported: failed ? 'failed' : 'success',
    commands: [],
    usage: null,
  };
}
