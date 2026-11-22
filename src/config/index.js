import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { check, integer, keys, mkdir, jsonFile, saveJson } from '../core.js';
import defaults from '../../examples/models.json' with { type: 'json' };
import { exclusive } from '../jobs/store.js';

export function dataHome() {
  if (process.env.IGOR_HOME) {
    check(path.isAbsolute(process.env.IGOR_HOME), 'IGOR_HOME must be an absolute path');
    return path.resolve(process.env.IGOR_HOME);
  }
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || os.homedir(), 'igor');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'igor');
  return path.join(os.homedir(), '.local', 'share', 'igor');
}
export const defaultConfig = {
  schemaVersion: 1,
  timeoutMs: 900000,
  startupMs: 180000,
  piPath: null,
  omlxPath: 'omlx',
  llamaPath: 'llama-server',
  limits: { files: 20000, fileBytes: 32 * 1024 ** 2, totalBytes: 512 * 1024 ** 2 },
};
export function validateConfig(c) {
  keys(c, Object.keys(defaultConfig), 'config');
  check(c.schemaVersion === 1, 'Unsupported config schema');
  integer(c.timeoutMs, 'timeoutMs', 1, 86400000);
  integer(c.startupMs, 'startupMs', 100, 900000);
  for (const key of ['piPath', 'omlxPath', 'llamaPath']) {
    if (key === 'piPath' && c[key] === null) continue;
    check(typeof c[key] === 'string' && c[key].length > 0 && !/[\r\n\0]/.test(c[key]), 'Invalid ' + key);
    check(
      path.isAbsolute(c[key]) || /^[\w-]+$/.test(c[key]),
      key + ' must be a command name or an absolute path'
    );
  }
  keys(c.limits, ['files', 'fileBytes', 'totalBytes'], 'snapshot limits');
  for (const key of Object.keys(defaultConfig.limits)) integer(c.limits[key], key);
  check(
    c.limits.fileBytes <= 512 * 1024 ** 2 && c.limits.fileBytes <= c.limits.totalBytes,
    'Invalid per-file snapshot limit'
  );
  return c;
}
export async function initialize(home) {
  check(
    path.dirname(home) !== home && path.resolve(os.homedir()) !== home,
    'Choose a dedicated Igor data directory'
  );
  await mkdir(home);
  const real = await fs.realpath(home);
  const existing = await fs.readdir(real);
  const initializing = name => /^init\.lock(?:-journal)?$|^config\.json\..+\.tmp$/.test(name);
  if (existing.length && !existing.includes('config.json') && !existing.every(initializing)) {
    // A directory enumeration can straddle another process's initial publish.
    const started = await fs.stat(path.join(real, 'init.lock')).catch(err => {
      if (err.code === 'ENOENT') return null;
      throw err;
    });
    check(started?.isFile(), 'IGOR_HOME must be a dedicated Igor directory');
  }
  const lock = exclusive(path.join(real, 'init.lock'), 5000);
  check(lock, 'Data directory initialization is busy');
  try {
    const current = await fs.readdir(real);
    check(
      current.includes('config.json') || current.every(initializing),
      'IGOR_HOME must be a dedicated Igor directory'
    );
    if (!current.includes('config.json')) await saveJson(path.join(real, 'config.json'), defaultConfig);
    const config = validateConfig(await jsonFile(path.join(real, 'config.json')));
    const registry = structuredClone(defaults);
    if (process.platform !== 'darwin') registry.defaultModel = 'mock';
    if (!current.includes('models.json')) await saveJson(path.join(real, 'models.json'), registry);
    for (const dir of ['jobs', 'runtime', 'cache']) await mkdir(path.join(real, dir));
    return { home: real, config };
  } finally {
    lock.close();
  }
}
