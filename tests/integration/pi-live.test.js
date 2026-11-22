import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { jobPaths, systemEnv, command } from '../../src/core.js';
import { prepareJobDirs } from '../../src/supervisor/job.js';
import { ownedProcess } from '../../src/supervisor/process.js';
import { prepareSeatbelt, workerEnv } from '../../src/sandbox/macos-seatbelt.js';
import { runPi, findPi } from '../../src/agents/pi.js';
import { gateway } from '../../src/inference/gateway.js';
import { budget } from '../../src/models/registry.js';
import models from '../../examples/models.json' with { type: 'json' };
import { repo, temp } from '../helpers.js';

// The only tool instructions this server can issue are these three fixed actions
// on a disposable fixture. No user prompt or external model reaches this test.
const calls = [
  { name: 'read', args: { path: 'clamp.js' } },
  {
    name: 'write',
    args: {
      path: 'clamp.js',
      content:
        'export function clamp(value, lower, upper) {\n  return Math.min(upper, Math.max(lower, value));\n}\n',
    },
  },
  { name: 'bash', args: { command: 'node --test' } },
];
test(
  'installed Pi RPC reads, writes and runs tests through authenticated streamed tool calls',
  { timeout: 45000 },
  async t => {
    let runtime;
    const local = path.join(
      repo,
      '.igor-dev',
      'pi',
      'node_modules',
      '@earendil-works',
      'pi-coding-agent',
      'dist',
      'bundle',
      'cli.js'
    );
    const pin =
      process.env.IGOR_TEST_PI ||
      (await fs.stat(local).then(
        () => local,
        () => null
      ));
    try {
      runtime = await findPi({ piPath: pin });
    } catch (err) {
      if (pin || process.env.IGOR_REQUIRE_PI) throw err;
      t.skip('Install Pi 1.6.0 or set IGOR_TEST_PI to its cli.js');
      return;
    }
    const root = await temp(t),
      p = jobPaths(root, 'job_' + 'b'.repeat(32));
    await prepareJobDirs(p);
    await fs.cp(path.join(repo, 'examples', 'sample-project'), p.code, { recursive: true });
    const before = await command(process.execPath, ['--test'], { cwd: p.code, allow: [1] });
    assert.equal(before.code, 1);
    const model = structuredClone(models.models.mock);
    model.options.modelId = 'igor-test';
    const seen = [];
    let serverError;
    const server = http.createServer(async (req, res) => {
      try {
        assert.equal(req.url, '/v1/chat/completions');
        assert.equal(req.headers.authorization, 'Bearer upstream-key');
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const request = JSON.parse(Buffer.concat(chunks));
        const index = request.messages.filter(m => m.role === 'tool').length;
        assert.equal(request.model, 'igor-test');
        assert.equal(request.stream, true);
        assert.deepEqual(request.tools.map(t => t.function.name).sort(), ['bash', 'edit', 'read', 'write']);
        seen.push(index);
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const send = (delta, finish = null, usage) =>
          res.write(
            'data: ' +
              JSON.stringify({
                id: 'completion-' + index,
                object: 'chat.completion.chunk',
                model: 'igor-test',
                created: 1700000000,
                choices: [{ index: 0, delta, finish_reason: finish }],
                ...(usage ? { usage } : {}),
              }) +
              '\n\n'
          );
        send({ role: 'assistant' });
        if (index < calls.length) {
          const c = calls[index];
          send({
            tool_calls: [
              { index: 0, id: 'call_' + index, type: 'function', function: { name: c.name, arguments: '' } },
            ],
          });
          send({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(c.args) } }] });
          send({}, 'tool_calls');
        } else {
          send({
            content: JSON.stringify({ outcome: 'success', summary: 'Fixed clamp and ran the tests.' }),
          });
          send({}, 'stop');
        }
        res.end(
          'data: ' +
            JSON.stringify({
              choices: [],
              usage: { prompt_tokens: 220, completion_tokens: 18, total_tokens: 238 },
            }) +
            '\n\ndata: [DONE]\n\n'
        );
      } catch (err) {
        serverError = err;
        res.writeHead(500);
        res.end(JSON.stringify({ error: { message: err.message } }));
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const limits = budget(model),
      gate = await gateway(
        { endpoint: 'http://127.0.0.1:' + server.address().port + '/v1', key: 'upstream-key' },
        model,
        limits
      );
    t.after(() => gate.close());
    let sandbox;
    if (process.platform === 'darwin') sandbox = await prepareSeatbelt(p, runtime, gate);
    else {
      const env = {
        ...systemEnv(),
        ...workerEnv(p),
        PATH: process.env.PATH,
        USERPROFILE: p.scratch,
        TEMP: p.scratch,
        TMP: p.scratch,
      };
      if (process.platform === 'win32')
        env.SHELL = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
      await fs.mkdir(env.TMPDIR, { recursive: true });
      sandbox = { env, execute: (exe, args) => ownedProcess(exe, args, { cwd: p.code, env }) };
    }
    const events = [];
    let diagnostic = '';
    const result = await runPi({
      spec: { prompt: 'Fix the clamp fixture' },
      p,
      model,
      limits,
      gate,
      runtime,
      sandbox,
      signal: AbortSignal.timeout(30000),
      event: async (type, details) => events.push({ type, ...details }),
      stderr: async b => {
        diagnostic += b;
      },
    }).catch(err => {
      throw serverError || new Error(err.message + '\n' + diagnostic);
    });
    assert.ifError(serverError);
    assert.deepEqual(seen, [0, 1, 2, 3]);
    assert.equal(result.reported, 'success');
    assert.equal(result.commands[0].ok, true, JSON.stringify(events));
    assert(result.usage.input > 0);
    assert.deepEqual(
      events.filter(e => e.type === 'tool_end').map(e => e.tool),
      ['read', 'write', 'bash']
    );
    assert.equal((await command(process.execPath, ['--test'], { cwd: p.code })).code, 0);
  }
);
