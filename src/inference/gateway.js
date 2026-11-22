import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomBytes } from 'node:crypto';
import { check } from '../core.js';

export function chatRequest(body, model, limits) {
  check(
    body && body.model === model.options.modelId && Array.isArray(body.messages) && body.messages.length,
    'Unexpected model or messages'
  );
  const messages = body.messages.map(m => {
    check(m && ['system', 'developer', 'user', 'assistant', 'tool'].includes(m.role), 'Invalid message role');
    let content = m.content ?? null;
    if (Array.isArray(content))
      content = content.map(part => {
        check(part?.type === 'text' && typeof part.text === 'string', 'Only text content is supported');
        return { type: 'text', text: part.text };
      });
    else check(content === null || typeof content === 'string', 'Invalid message content');
    const message = { role: m.role, content };
    if (typeof m.tool_call_id === 'string') message.tool_call_id = m.tool_call_id;
    if (m.tool_calls) {
      check(m.role === 'assistant' && Array.isArray(m.tool_calls), 'Invalid tool history');
      message.tool_calls = m.tool_calls.map(t => {
        check(
          t?.type === 'function' &&
            typeof t.id === 'string' &&
            typeof t.function?.name === 'string' &&
            typeof t.function.arguments === 'string',
          'Invalid tool call'
        );
        return {
          type: 'function',
          id: t.id,
          function: { name: t.function.name, arguments: t.function.arguments },
        };
      });
    }
    return message;
  });
  const output = body.max_tokens ?? body.max_completion_tokens ?? limits.output;
  check(Number.isInteger(output) && output > 0, 'Invalid output limit');
  const request = {
    model: body.model,
    messages,
    stream: body.stream === true,
    temperature: model.generation.temperature,
    max_tokens: Math.min(output, limits.output),
  };
  if (request.stream && body.stream_options?.include_usage) request.stream_options = { include_usage: true };
  if (body.tools) {
    check(Array.isArray(body.tools) && body.tools.length <= 4, 'Unsupported tools');
    request.tools = body.tools.map(t => {
      check(
        t?.type === 'function' && ['read', 'write', 'edit', 'bash'].includes(t.function?.name),
        'Unsupported inference tool'
      );
      return {
        type: 'function',
        function: {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        },
      };
    });
  }
  return request;
}
export async function gateway(backend, model, limits) {
  const token = randomBytes(32).toString('hex');
  const server = http.createServer({ maxHeaderSize: 8192 }, async (req, res) => {
    const reply = (code, message) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(message));
    };
    if (req.headers.authorization !== 'Bearer ' + token) return reply(401, { error: 'Unauthorized' });
    if (req.method === 'GET' && req.url === '/v1/models')
      return reply(200, { object: 'list', data: [{ id: model.options.modelId, object: 'model' }] });
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions')
      return reply(404, { error: 'Unknown route' });
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    let forwarding = false;
    try {
      let size = 0;
      const chunks = [];
      for await (const data of req) {
        size += data.length;
        if (size > 4 * 1024 ** 2) return reply(413, { error: 'Request too large' });
        chunks.push(data);
      }
      const body = chatRequest(JSON.parse(Buffer.concat(chunks).toString()), model, limits);
      forwarding = true;
      const upstream = await fetch(backend.endpoint + '/chat/completions', {
        method: 'POST',
        redirect: 'error',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...(backend.key ? { authorization: 'Bearer ' + backend.key } : {}),
        },
        body: JSON.stringify(body),
      });
      res.writeHead(upstream.status, {
        'content-type': upstream.headers.get('content-type') || 'application/json',
        'cache-control': 'no-store',
      });
      if (upstream.body) await pipeline(Readable.fromWeb(upstream.body), res);
      else res.end();
    } catch (err) {
      if (!res.headersSent && !res.destroyed)
        reply(forwarding ? 502 : 400, { error: forwarding ? 'Inference upstream unavailable' : err.message });
      else res.destroy();
    }
  });
  server.requestTimeout = 30000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  return {
    port,
    token,
    endpoint: 'http://127.0.0.1:' + port + '/v1',
    async close() {
      const closed = new Promise(resolve => server.close(resolve));
      server.closeAllConnections();
      await closed;
    },
  };
}
