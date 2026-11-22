import { saveJson } from '../core.js';

export function resultRecord({
  jobId,
  spec,
  outcome,
  agent,
  observations,
  filesChanged = [],
  baseRevision = null,
  patchComplete = false,
  durationMs,
  runtime = null,
  resources = null,
}) {
  const commands = agent?.commands ?? observations?.commands ?? [];
  return {
    schemaVersion: 1,
    jobId,
    ...outcome,
    model: spec?.modelId ?? null,
    agent: spec?.model ? (spec.model.runtime === 'mock' ? 'mock' : 'pi') : null,
    agentCompleted: Boolean(agent),
    agentOutcome: agent?.reported ?? 'unknown',
    summary: agent?.summary ?? outcome.error,
    verification: {
      status: commands.length ? 'tool_results' : 'unverified',
      commands,
      independentlyVerified: false,
    },
    filesChanged,
    baseRevision,
    artifacts: { patch: 'changes.patch', manifest: 'manifest.json', patchComplete },
    durationMs,
    runtime,
    resources,
  };
}
export async function publish(store, p, detail) {
  // On a crash after this rename, recovery can commit the published result.
  await saveJson(p.result, detail);
  store.transition(detail.jobId, detail.status, detail.exitCode, detail.error);
}
