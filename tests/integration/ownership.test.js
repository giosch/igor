import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs/promises';
import { repo, temp, until } from '../helpers.js';
import { command, systemEnv } from '../../src/core.js';
import { initialize } from '../../src/config/index.js';
import { ManagedBackend } from '../../src/inference/backends.js';
import { download } from '../../src/models/download.js';
import { budget } from '../../src/models/registry.js';
import { ownedProcess } from '../../src/supervisor/process.js';
import registry from '../../examples/models.json' with { type: 'json' };

test(
  'owned process guardian reaps its worker when the parent process is killed',
  { timeout: 15000 },
  async t => {
    const owner = fork(new URL('../fixtures/process-owner.js', import.meta.url), [], {
      env: systemEnv(),
      execArgv: [],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    const [worker] = await once(owner, 'message');
    assert(Number.isInteger(worker.pid) && worker.pid > 0);
    t.after(() => {
      if (owner.exitCode === null && owner.signalCode === null) owner.kill();
    });
    owner.kill('SIGKILL');
    await until(() => {
      try {
        process.kill(worker.pid, 0);
        return false;
      } catch (err) {
        return err.code === 'ESRCH';
      }
    });
  }
);

test('managed oMLX and llama.cpp adapters start authenticated fixture servers, enforce identity and release their ports', async t => {
  const root = await temp(t),
    ctx = await initialize(root);
  for (const runtime of ['omlx', 'llamacpp']) {
    const id = 'test-' + runtime,
      original = registry.models['inkling-mini'],
      revision = 'a'.repeat(40);
    const m = {
      ...original,
      runtime,
      format: runtime === 'omlx' ? 'mlx' : 'gguf',
      source: {
        type: 'huggingface',
        repository: 'test/fixture',
        revision,
        ...(runtime === 'llamacpp' ? { file: 'tiny.gguf' } : {}),
      },
      options: { modelId: 'test-weight', ...(runtime === 'omlx' ? { mtp: true } : {}) },
    };
    const names =
      runtime === 'omlx' ? ['config.json', 'model.safetensors', 'mtp.safetensors'] : ['tiny.gguf'];
    const files = Object.fromEntries(names.map(n => [n, Buffer.from(n === 'config.json' ? '{}' : 'test')]));
    const siblings = names.map(n => ({
      rfilename: n,
      size: files[n].length,
      lfs: { sha256: createHash('sha256').update(files[n]).digest('hex') },
    }));
    await download(root, id, m, {
      request: async url =>
        url.includes('/api/models/')
          ? Response.json({ sha: revision, siblings })
          : new Response(files[url.split('/').at(-1)]),
    });
    let invocation;
    const backend = new ManagedBackend(m, ctx, id, budget(m), {
      inspect: async () => 'fixture-1',
      launch: (exe, args, options) => {
        invocation = { exe, args, options };
        return ownedProcess(
          process.execPath,
          [path.join(repo, 'tests', 'fixtures', 'runtime.js'), ...args],
          options
        );
      },
    });
    try {
      await backend.start();
      if (runtime === 'omlx') {
        const requests = await fetch(new URL('/fixture/status-requests', backend.endpoint), {
          headers: { authorization: 'Bearer ' + backend.key },
        });
        assert((await requests.json()) >= 2, 'start must wait for the selected model to load');
      }
      assert(await backend.health());
      assert.equal((await fetch(backend.endpoint + '/models')).status, 401);
      assert.equal(invocation.args[invocation.args.indexOf('--host') + 1], '127.0.0.1');
      assert.equal(invocation.options.env.HF_HUB_OFFLINE, '1');
      if (runtime === 'omlx') {
        const settings = JSON.parse(await fs.readFile(path.join(root, 'runtime', id, 'model_settings.json')));
        assert.equal(settings.version, 2);
        assert.deepEqual(settings.models['test-weight'], {
          is_pinned: true,
          max_context_window: 32768,
          max_tokens: 8192,
          mtp_enabled: true,
          trust_remote_code: false,
        });
        assert(invocation.args.includes('--base-path'));
        if (process.env.IGOR_TEST_OMLX_PYTHON) {
          const upstreamCheck = path.join(repo, 'tests', 'fixtures', 'omlx_settings.py');
          await command(process.env.IGOR_TEST_OMLX_PYTHON, [upstreamCheck, ...invocation.args]);
        }
      } else {
        assert(invocation.args.includes('--jinja'));
        assert(invocation.args.includes('32768'));
      }
    } finally {
      await backend.stop();
    }
    assert.equal(await backend.health(), false);
  }
});
