import net from 'node:net';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import { check, command, mkdir, saveJson, sleep, systemEnv, IgorError } from '../core.js';
import { verify } from '../models/download.js';
import { ownedProcess } from '../supervisor/process.js';

async function freePort() {
  const socket = net.createServer();
  await new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', resolve);
  });
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}
export async function inspectRuntime(model, config, signal) {
  if (['mock', 'external'].includes(model.runtime)) return model.runtime;
  const omlx = model.runtime === 'omlx';
  if (omlx)
    check(
      process.platform === 'darwin' && process.arch === 'arm64',
      'oMLX requires Apple Silicon and native arm64 Node',
      3
    );
  const exe = omlx ? config.omlxPath : config.llamaPath;
  const timeout = AbortSignal.timeout(20000);
  const opts = { signal: signal ? AbortSignal.any([signal, timeout]) : timeout };
  const version = await command(exe, ['--version'], opts).catch(err => {
    if (omlx && err.code === 'ENOENT') {
      throw new IgorError(
        err.message +
          '. Install the oMLX CLI on your Mac:\n' +
          '  brew tap jundot/omlx https://github.com/jundot/omlx\n' +
          '  brew install jundot/omlx/omlx\n' +
          'Then run omlx --version and retry. For a custom installation, set omlxPath in config.json to the executable.',
        3
      );
    }
    throw err;
  });
  const versionText = (version.stdout.toString() + ' ' + version.stderr).trim();
  if (omlx) {
    const match = versionText.match(/\b(\d+)\.(\d+)\.(\d+)/);
    check(
      match && (+match[1] > 0 || +match[2] > 8 || (+match[2] === 8 && +match[3] >= 1)),
      'oMLX 0.8.1 or newer is required',
      4
    );
  }
  const help = await command(exe, omlx ? ['serve', '--help'] : ['--help'], opts);
  for (const flag of omlx
    ? ['--model-dir', '--base-path', '--host', '--port', '--pin']
    : ['--model', '--alias', '--ctx-size', '--host', '--port', '--jinja']) {
    check((help.stdout.toString() + help.stderr).includes(flag), 'Installed runtime lacks ' + flag, 4);
  }
  return versionText.slice(0, 300);
}
class MockBackend {
  constructor(model) {
    this.model = model;
    this.endpoint = 'mock://local';
    this.active = false;
  }
  async start() {
    check(this.model.options.available !== false, 'Mock inference model unavailable', 4);
    this.active = true;
  }
  async health() {
    return this.active;
  }
  async stop() {
    this.active = false;
  }
}
class ApiBackend {
  constructor(model) {
    this.model = model;
    this.endpoint = model.options.endpoint?.replace(/\/$/, '');
  }
  async health(signal) {
    try {
      const timeout = AbortSignal.timeout(3000);
      const res = await fetch(this.endpoint + '/models', {
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: this.key ? { authorization: 'Bearer ' + this.key } : {},
      });
      return res.ok && (await res.json()).data?.some(m => m.id === this.model.options.modelId);
    } catch {
      return false;
    }
  }
  async start(signal) {
    const name = this.model.options.apiKeyEnv;
    this.key = name ? process.env[name] : null;
    check(!name || this.key, 'Missing host API key environment variable ' + name, 4);
    check(await this.health(signal), 'External endpoint did not advertise ' + this.model.options.modelId, 4);
  }
  async stop() {}
}
export class ManagedBackend extends ApiBackend {
  constructor(model, ctx, id, limits, { inspect = inspectRuntime, launch = ownedProcess } = {}) {
    super(model);
    Object.assign(this, { ctx, id, limits, inspect, launch });
  }
  async start(signal) {
    const { config, home } = this.ctx,
      m = this.model;
    this.version = await this.inspect(m, config, signal);
    const cache = await verify(home, this.id, m, false);
    this.revision = cache.revision;
    const port = await freePort();
    const base = path.join(home, 'runtime', this.id);
    await mkdir(base);
    const env = {
      ...systemEnv(),
      HOME: base,
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
      PYTHONUNBUFFERED: '1',
    };
    this.key = randomBytes(32).toString('hex');
    let args, exe;
    if (m.runtime === 'omlx') {
      await saveJson(path.join(base, 'model_settings.json'), {
        version: 1,
        models: {
          [m.options.modelId]: {
            max_context_window: this.limits.context,
            max_tokens: this.limits.output,
            mtp_enabled: m.options.mtp === true,
            trust_remote_code: false,
          },
        },
      });
      env.OMLX_API_KEY = this.key;
      exe = config.omlxPath;
      args = [
        'serve',
        '--base-path',
        base,
        '--model-dir',
        cache.models,
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--pin',
        m.options.modelId,
      ];
    } else {
      env.LLAMA_API_KEY = this.key;
      exe = config.llamaPath;
      args = [
        '--model',
        path.join(cache.dir, m.source.file),
        '--alias',
        m.options.modelId,
        '--ctx-size',
        String(this.limits.context),
        '--parallel',
        '1',
        '--jinja',
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
      ];
    }
    this.endpoint = 'http://127.0.0.1:' + port + '/v1';
    this.logPath = path.join(base, 'server.log');
    this.log = createWriteStream(this.logPath, { flags: 'w', mode: 0o600 });
    this.proc = this.launch(exe, args, { cwd: base, env });
    this.proc.stdout.pipe(this.log, { end: false });
    this.proc.stderr.pipe(this.log, { end: false });
    let exited = false;
    this.proc.done.then(() => {
      exited = true;
    });
    const deadline = Date.now() + config.startupMs;
    while (!exited && Date.now() < deadline) {
      signal?.throwIfAborted();
      if (await this.health(signal)) return;
      await sleep(200, null, { signal });
    }
    throw new IgorError(
      'Inference server failed readiness. Inspect ' +
        this.logPath +
        ': ' +
        (await fs.readFile(this.logPath, 'utf8')).slice(-900),
      4
    );
  }
  async stop() {
    await this.proc?.stop();
    if (this.log) {
      this.log.end();
      await finished(this.log);
    }
  }
}
export class RuntimeManager {
  constructor(ctx) {
    this.ctx = ctx;
  }
  async use(id, model, limits, signal) {
    const signature = JSON.stringify([id, model, limits.context]);
    if (this.signature === signature && (await this.backend.health(signal))) return this.backend;
    await this.stop();
    this.backend =
      model.runtime === 'mock'
        ? new MockBackend(model)
        : model.runtime === 'external'
          ? new ApiBackend(model)
          : new ManagedBackend(model, this.ctx, id, limits);
    try {
      await this.backend.start(signal);
      this.signature = signature;
      return this.backend;
    } catch (err) {
      await this.stop();
      throw err;
    }
  }
  async stop() {
    await this.backend?.stop();
    this.backend = null;
    this.signature = null;
  }
}
