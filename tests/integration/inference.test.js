import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { initialize } from '../../src/config/index.js';
import { selectFiles, fetchFile, download, verify } from '../../src/models/download.js';
import { RuntimeManager } from '../../src/inference/backends.js';
import { chatRequest, gateway } from '../../src/inference/gateway.js';
import { budget } from '../../src/models/registry.js';
import registry from '../../examples/models.json' with { type: 'json' };
import { temp } from '../helpers.js';

test('reasoning effort is opt-in and only the host can choose it', () => {
  const model = registry.models['inkling-mini'];
  const limits = budget(model);
  const body = {
    model: model.options.modelId,
    messages: [{ role: 'user', content: 'test' }],
    reasoning_effort: 'high',
    chat_template_kwargs: { reasoning_effort: 'high' },
  };
  const baseline = chatRequest(body, model, limits);
  assert.equal(baseline.reasoning_effort, undefined);
  assert.equal(baseline.chat_template_kwargs, undefined);
  for (const effort of ['none', 'low']) {
    assert.deepEqual(chatRequest(body, model, limits, effort), { ...baseline, reasoning_effort: effort });
  }
});
test('gateway authenticates, restricts routes and models, strips unsafe upstream options, streams bytes', async t => {
  const m = registry.models.mock,
    seen = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    seen.push({ body: JSON.parse(Buffer.concat(chunks)), key: req.headers.authorization });
    res.setHeader('content-type', 'text/event-stream');
    res.write('data: hello\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => upstream.close(resolve)));
  const g = await gateway(
    { endpoint: 'http://127.0.0.1:' + upstream.address().port + '/v1', key: 'host-only' },
    m,
    budget(m)
  );
  t.after(() => g.close());
  const headers = { authorization: 'Bearer ' + g.token },
    body = {
      model: 'mock',
      messages: [{ role: 'user', content: 'test' }],
      stream: true,
      max_tokens: 100000,
      web_search: true,
    };
  const post = obj =>
    fetch(g.endpoint + '/chat/completions', { method: 'POST', headers, body: JSON.stringify(obj) });
  assert.equal((await fetch(g.endpoint + '/models')).status, 401);
  assert.equal((await fetch(g.endpoint + '/admin', { headers })).status, 404);
  assert.equal((await (await fetch(g.endpoint + '/models', { headers })).json()).data[0].id, 'mock');
  assert.equal((await post({ ...body, model: 'another' })).status, 400);
  assert.equal(
    (
      await post({
        ...body,
        messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'file:///private' } }] }],
      })
    ).status,
    400
  );
  assert.equal((await post({ ...body, tools: [{ type: 'web_search' }] })).status, 400);
  assert.equal(await (await post(body)).text(), 'data: hello\n\ndata: [DONE]\n\n');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].body.web_search, undefined);
  assert.equal(seen[0].body.max_tokens, 1024);
  assert.equal(seen[0].key, 'Bearer host-only');
});
test('runtime selection verifies model identity and stop leaves an external server running', async t => {
  const server = http.createServer((req, res) => res.end(JSON.stringify({ data: [{ id: 'local' }] })));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const m = {
    ...registry.models.mock,
    runtime: 'external',
    options: { modelId: 'local', endpoint: 'http://127.0.0.1:' + server.address().port + '/v1' },
  };
  const manager = new RuntimeManager({});
  await manager.use('external', m, budget(m));
  await manager.stop();
  assert.equal((await fetch(m.options.endpoint + '/models')).status, 200);
  await assert.rejects(
    manager.use('external', { ...m, options: { ...m.options, modelId: 'missing' } }, budget(m)),
    /advertise/
  );
  await assert.rejects(
    manager.use('mock', { ...registry.models.mock, options: { available: false } }, budget(m)),
    /unavailable/
  );
});
test('downloader verifies content, detects corruption and resumes with a bounded range', async t => {
  const home = await temp(t);
  await initialize(home);
  const mock = registry.models.mock;
  await download(home, 'mock', mock);
  const cache = await verify(home, 'mock', mock);
  await fs.writeFile(path.join(cache.dir, 'mock.txt'), 'bad');
  await assert.rejects(verify(home, 'mock', mock), /damaged/);
  const data = Buffer.from('0123456789'),
    hash = createHash('sha256').update(data).digest('hex');
  await fs.writeFile(path.join(home, 'weights.part'), data.subarray(0, 4));
  await fetchFile(
    'test',
    home,
    { name: 'weights', size: data.length, hash, algorithm: 'sha256' },
    async (_, options) => {
      assert.equal(options.headers.Range, 'bytes=4-');
      return new Response(data.subarray(4), { status: 206, headers: { 'content-range': 'bytes 4-9/10' } });
    }
  );
  assert.deepEqual(await fs.readFile(path.join(home, 'weights')), data);
  await assert.rejects(
    fetchFile(
      'test',
      home,
      { name: 'wrong', size: 10, hash: 'bad', algorithm: 'sha256' },
      async () => new Response(data)
    ),
    /Checksum/
  );
  const m = registry.models['inkling-mini'];
  const siblings = [
    'config.json',
    'model.safetensors',
    'mtp.safetensors',
    'arbitrary.py',
    'weights.bin',
    '../file.safetensors',
  ].map(rfilename => ({ rfilename, size: 10, blobId: '0'.repeat(40) }));
  assert.deepEqual(
    selectFiles(m, { sha: m.source.revision, siblings }).map(f => f.name),
    ['config.json', 'model.safetensors', 'mtp.safetensors']
  );
  assert.throws(() => selectFiles(m, { sha: 'f'.repeat(40), siblings }), /revision mismatch/);
});
