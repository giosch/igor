import path from 'node:path';
import { check, integer, keys, safeId, safeRelative, jsonFile, saveJson } from '../core.js';
import { exclusive } from '../jobs/store.js';
import defaults from '../../examples/models.json' with { type: 'json' };

export function validateModel(id, m) {
  safeId(id);
  keys(
    m,
    ['runtime', 'source', 'format', 'quantization', 'context', 'generation', 'capabilities', 'options'],
    'model'
  );
  const formats = { mock: 'mock', omlx: 'mlx', llamacpp: 'gguf', external: 'api' };
  check(
    Object.hasOwn(formats, m.runtime) && m.format === formats[m.runtime],
    'Incompatible runtime and format'
  );
  check(typeof m.quantization === 'string' && m.quantization.length > 0, 'Missing quantization');
  keys(m.source, ['type', 'repository', 'revision', 'file'], 'model source');
  if (['omlx', 'llamacpp'].includes(m.runtime)) {
    check(
      m.source.type === 'huggingface' && /^[\w.-]+\/[\w.-]+$/.test(m.source.repository),
      'Expected a Hugging Face repository'
    );
    safeRelative(m.source.repository);
    check(
      m.source.revision == null || /^[0-9a-f]{40}$/.test(m.source.revision),
      'Use a full pinned revision or null'
    );
    if (m.runtime === 'llamacpp')
      check(/^[\w.-]+\.gguf$/i.test(m.source.file), 'A single GGUF filename is required');
  } else check(m.source.type === m.runtime, 'Incompatible model source');
  keys(m.context, ['modelMaximum', 'runtimeMaximum', 'default'], 'context');
  for (const k of ['modelMaximum', 'runtimeMaximum', 'default']) integer(m.context[k], k);
  keys(m.generation, ['maxOutputTokens', 'temperature', 'reasoningEffort'], 'generation');
  if (m.generation.reasoningEffort !== undefined)
    check(
      m.runtime === 'omlx' && ['default', 'none', 'low'].includes(m.generation.reasoningEffort),
      'Model reasoning effort requires managed oMLX and accepts default, none, or low'
    );
  integer(m.generation.maxOutputTokens, 'maxOutputTokens');
  check(
    Number.isFinite(m.generation.temperature) &&
      m.generation.temperature >= 0 &&
      m.generation.temperature <= 2,
    'Invalid temperature'
  );
  keys(m.capabilities, ['tools', 'vision'], 'capabilities');
  check(
    m.capabilities.tools === true && typeof (m.capabilities.vision ?? false) === 'boolean',
    'Coding models must support tools'
  );
  if (m.options === undefined)
    m.options = { modelId: m.runtime === 'omlx' ? m.source.repository.split('/').at(-1) : id };
  keys(
    m.options,
    [
      'modelId',
      ...(m.runtime === 'mock' ? ['available'] : []),
      ...(m.runtime === 'omlx' ? ['mtp'] : []),
      ...(m.runtime === 'external' ? ['endpoint', 'apiKeyEnv'] : []),
    ],
    'model options'
  );
  check(
    typeof m.options.modelId === 'string' && /^[A-Za-z0-9][\w./:@+-]{0,159}$/.test(m.options.modelId),
    'Invalid provider model ID'
  );
  if (m.runtime === 'omlx') {
    safeRelative(m.options.modelId);
    check(!m.options.modelId.includes('/'), 'Use an oMLX model directory name');
  }
  for (const key of ['mtp', 'available'])
    if (key in m.options) check(typeof m.options[key] === 'boolean', 'Invalid ' + key);
  if (m.runtime === 'external') {
    let url;
    try {
      url = new URL(m.options.endpoint);
    } catch {
      check(false, 'Invalid external endpoint');
    }
    check(
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname.replace(/\/$/, '') === '/v1',
      'Expected an HTTPS or loopback /v1 endpoint'
    );
    if (m.options.apiKeyEnv)
      check(/^[A-Z_][A-Z0-9_]*$/.test(m.options.apiKeyEnv), 'Invalid API key environment name');
  }
  budget(m);
  return m;
}
export function budget(m, requested = m.context.default) {
  const context = Math.min(
    m.context.modelMaximum,
    m.context.runtimeMaximum,
    integer(requested, 'requested context')
  );
  const output = m.generation.maxOutputTokens;
  check(context > output + 256, 'Context too small for output and compaction reservations');
  return {
    context,
    output,
    input: context - output,
    reserve: output,
    keepRecent: Math.max(128, Math.floor((context - output) / 4)),
  };
}
export async function registry(home) {
  const reg = await jsonFile(path.join(home, 'models.json'));
  keys(reg, ['schemaVersion', 'defaultModel', 'models'], 'registry');
  check(
    reg.schemaVersion === 1 && reg.models && typeof reg.models === 'object' && !Array.isArray(reg.models),
    'Invalid model registry'
  );
  for (const [id, model] of Object.entries(reg.models)) validateModel(id, model);
  check(Object.hasOwn(reg.models, reg.defaultModel), 'Unknown default model');
  return reg;
}
export function modelFor(reg, id = reg.defaultModel) {
  safeId(id);
  check(Object.hasOwn(reg.models, id), 'Unknown model: ' + id);
  return reg.models[id];
}
export function resolveReasoningEffort(id, model, requested) {
  const inkling = defaults.models['inkling-mini'];
  // Registries created before 0.1.7 lack this setting.
  const shippedEffort =
    id === 'inkling-mini' && model.runtime === 'omlx' && model.source.repository === inkling.source.repository
      ? inkling.generation.reasoningEffort
      : undefined;
  const effort = requested ?? model.generation.reasoningEffort ?? shippedEffort;
  return effort === 'default' ? undefined : effort;
}
export async function changeRegistry(home, id, model) {
  safeId(id);
  const lock = exclusive(path.join(home, 'runtime', 'registry.lock'), 5000);
  check(lock, 'Registry is busy');
  try {
    const reg = await registry(home);
    if (model) {
      check(!Object.hasOwn(reg.models, id), 'Model already registered: ' + id);
      reg.models[id] = validateModel(id, model);
    } else {
      modelFor(reg, id);
      check(id !== reg.defaultModel, 'Select another default in models.json before removing this model');
      delete reg.models[id];
    }
    await saveJson(path.join(home, 'models.json'), reg);
  } finally {
    lock.close();
  }
}
