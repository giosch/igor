import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { check, IgorError, saveJson, mkdir, sleep } from '../core.js';

const flags = [
  '--offline',
  '--no-approve',
  '--no-session',
  '--no-extensions',
  '--no-mcp',
  '--no-skills',
  '--no-prompt-templates',
  '--no-themes',
  '--no-context-files',
];
export async function findPi(config) {
  const candidates =
    config.piPath && path.isAbsolute(config.piPath)
      ? [config.piPath]
      : (process.env.PATH || '').split(path.delimiter).flatMap(dir => {
          const bin = path.join(dir, config.piPath || 'pi');
          if (process.platform !== 'win32') return [bin];
          const npmEntry = path.join(
            dir,
            'node_modules',
            '@earendil-works',
            'pi-coding-agent',
            'dist',
            'bundle',
            'cli.js'
          );
          return [npmEntry, bin];
        });
  if (!config.piPath) {
    const bundled = new URL(
      '../../node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
      import.meta.url
    );
    candidates.unshift(fileURLToPath(bundled));
  }
  for (const candidate of candidates) {
    let entry;
    try {
      entry = await fs.realpath(candidate);
    } catch (err) {
      if (['ENOENT', 'ENOTDIR'].includes(err.code)) continue;
      throw err;
    }
    let dir = path.dirname(entry);
    while (dir !== path.dirname(dir)) {
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
        if (pkg.name === '@earendil-works/pi-coding-agent') {
          check(
            pkg.version === '1.6.0',
            'This adapter supports Pi 1.6.0. Installed version: ' + pkg.version,
            3
          );
          return { entry: path.join(dir, pkg.bin.pi), version: pkg.version, readable: [dir] };
        }
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      dir = path.dirname(dir);
    }
  }
  throw new IgorError(
    'Install @earendil-works/pi-coding-agent@1.6.0 or set piPath to its absolute cli.js path',
    3
  );
}
export async function configurePi(p, env, model, limits, gate) {
  await mkdir(env.PI_CODING_AGENT_DIR);
  await saveJson(path.join(env.PI_CODING_AGENT_DIR, 'models.json'), {
    providers: {
      igor: {
        baseUrl: gate.endpoint,
        api: 'openai-completions',
        apiKey: gate.token,
        models: [
          {
            id: model.options.modelId,
            name: model.options.modelId,
            reasoning: false,
            input: ['text'],
            contextWindow: limits.context,
            maxTokens: limits.output,
            compat: {
              supportsDeveloperRole: false,
              supportsStore: false,
              supportsUsageInStreaming: true,
              maxTokensField: 'max_tokens',
            },
          },
        ],
      },
    },
  });
  await saveJson(path.join(env.PI_CODING_AGENT_DIR, 'settings.json'), {
    defaultProjectTrust: 'never',
    compaction: { enabled: true, reserveTokens: limits.reserve, keepRecentTokens: limits.keepRecent },
    retry: { enabled: false },
    shellPath: env.SHELL,
    enableSkillCommands: false,
    enableInstallTelemetry: false,
    enableAnalytics: false,
  });
}
function messageText(message) {
  return (
    message.content
      ?.filter(p => p.type === 'text')
      .map(p => p.text)
      .join('\n')
      .trim() || ''
  );
}
function reportedOutcome(raw) {
  try {
    const body = JSON.parse(raw);
    if (
      ['success', 'failed'].includes(body?.outcome) &&
      typeof body.summary === 'string' &&
      body.summary.trim()
    )
      return { reported: body.outcome, summary: body.summary.slice(0, 16000) };
  } catch {
    // A report candidate may contain prose or an incomplete JSON object.
  }
  return null;
}
function report(message) {
  const text = messageText(message);
  const evidence = { finalStopReason: message.stopReason ?? null, agentReply: text.slice(-64000) };
  if (message.stopReason === 'length') {
    return {
      ...evidence,
      reported: 'unknown',
      completionReason: 'output_limit',
      summary: 'Pi reached the output token limit before finishing the task.',
    };
  }
  const fence = [...text.matchAll(/^[ \t]*```([^\r\n]*)\r?\n([\s\S]*?)^[ \t]*```[ \t]*$/gm)].at(-1);
  const trailing = text.lastIndexOf('\n{');
  let parsed = reportedOutcome(text);
  if (!parsed && fence && fence.index + fence[0].length === text.length) {
    if (['', 'json'].includes(fence[1].trim().toLowerCase())) parsed = reportedOutcome(fence[2]);
  } else if (!parsed && trailing >= 0) {
    parsed = reportedOutcome(text.slice(trailing + 1));
  }
  if (!parsed && /^```(?:json)?[ \t]+\{[^\r\n]*\}[ \t]*```$/i.test(text))
    parsed = reportedOutcome(text.replace(/^```(?:json)?[ \t]+|[ \t]*```$/gi, ''));
  if (parsed)
    return {
      ...evidence,
      ...parsed,
      completionReason: 'reported_' + (parsed.reported === 'success' ? 'success' : 'failure'),
    };
  return {
    ...evidence,
    reported: 'unknown',
    completionReason: 'unconfirmed_report',
    summary: text.slice(0, 16000) || 'Pi returned no textual summary.',
  };
}
async function* records(stream) {
  stream.setEncoding('utf8');
  let buffer = '';
  for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      check(end < 16 * 1024 ** 2, 'Pi RPC record too large');
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line.trim()) yield JSON.parse(line);
    }
    check(buffer.length < 16 * 1024 ** 2, 'Pi RPC record too large');
  }
  check(!buffer.trim(), 'Truncated Pi RPC record', 1);
}
async function send(proc, value) {
  if (!proc.stdin.write(JSON.stringify(value) + '\n')) await once(proc.stdin, 'drain');
}
export async function runPi({ spec, p, model, limits, gate, runtime, sandbox, signal, event, stderr }) {
  await configurePi(p, sandbox.env, model, limits, gate);
  const args = [
    runtime.entry,
    '--mode',
    'rpc',
    ...flags,
    '--provider',
    'igor',
    '--model',
    model.options.modelId,
    '--tools',
    'read,write,edit,bash',
    '--thinking',
    'off',
  ];
  const proc = sandbox.execute(process.execPath, args);
  const output = new Map(),
    commands = [],
    usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let last,
    accepted = false,
    settled = false,
    sessionId,
    turns = 0;
  let previewRemaining = 32000;
  const preview = message => {
    const text = messageText(message).slice(0, Math.min(4000, previewRemaining));
    previewRemaining -= text.length;
    return text;
  };
  const drain = (async () => {
    for await (const bytes of proc.stderr) await stderr(bytes);
  })();
  let killTimer;
  const abort = () => {
    if (proc.stdin.writable) proc.stdin.write('{"type":"abort"}\n');
    killTimer = setTimeout(() => void proc.stop(), 350);
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    await send(proc, { id: 'state', type: 'get_state' });
    for await (const msg of records(proc.stdout)) {
      signal.throwIfAborted();
      if (msg.type === 'response') {
        check(msg.success, 'Pi rejected ' + msg.command + ': ' + msg.error, 1);
        if (msg.id === 'state') {
          const selected = msg.data?.model;
          check(
            selected?.provider === 'igor' &&
              selected.id === model.options.modelId &&
              selected.contextWindow === limits.context,
            'Pi selected an unexpected model or context budget',
            4
          );
          sessionId = msg.data.sessionId;
          await event('pi_session', { sessionId, model: selected.id, context: selected.contextWindow });
          const instruction =
            '\n\nIgor job instructions: Work in the current code directory.' +
            (spec.docs ? ' Read-only documentation is in ../docs.' : '') +
            ' Run the requested verification. End with a JSON object containing outcome ("success" or "failed") and a short summary.';
          await send(proc, { id: 'task', type: 'prompt', message: spec.prompt + instruction });
        } else if (msg.id === 'task') {
          check(
            !msg.data?.disposition || msg.data.disposition === 'started',
            'Pi did not start the requested task'
          );
          accepted = true;
        }
      } else if (msg.type === 'tool_execution_start') {
        const detail = { tool: msg.toolName, callId: msg.toolCallId };
        if (msg.toolName === 'bash') {
          detail.command = String(msg.args?.command ?? '').slice(0, 4000);
          output.set(msg.toolCallId, detail.command);
        } else detail.path = String(msg.args?.path ?? '').slice(0, 1000);
        await event('tool_start', detail);
      } else if (msg.type === 'tool_execution_end') {
        const ok = msg.isError === false;
        const exitCode = msg.result?.details?.exitCode ?? (ok ? 0 : null);
        if (output.has(msg.toolCallId))
          commands.push({
            command: output.get(msg.toolCallId),
            ok,
            exitCode,
            evidence: 'pi-tool-result',
          });
        await event('tool_end', {
          tool: msg.toolName,
          callId: msg.toolCallId,
          ok,
          ...(msg.toolName === 'bash' ? { exitCode, output: preview(msg.result ?? {}) } : {}),
          durationMs: msg.durationMs ?? null,
        });
      } else if (msg.type === 'message_end' && msg.message?.role === 'assistant') {
        last = msg.message;
        turns++;
        for (const key of Object.keys(usage)) usage[key] += Number(last.usage?.[key]) || 0;
        await event('assistant_turn', {
          turn: turns,
          stopReason: last.stopReason,
          usage: last.usage ?? null,
          text: preview(last),
        });
      } else if (msg.type === 'agent_settled') {
        check(!msg.aborted, 'Pi aborted the task', 1);
        settled = true;
      }
      if (accepted && settled) break;
    }
    signal.throwIfAborted();
    check(accepted && settled && last, 'Pi exited before settling the task. Inspect stderr.log.', 1);
    check(
      !['error', 'aborted'].includes(last.stopReason),
      last.errorMessage || 'Inference failed inside Pi',
      4
    );
    return { ...report(last), commands, usage, sessionId, turns };
  } catch (err) {
    err.observations = { commands, usage };
    throw err;
  } finally {
    clearTimeout(killTimer);
    signal.removeEventListener('abort', abort);
    proc.stdout.resume();
    proc.stdin.end();
    await Promise.race([proc.done, sleep(250)]);
    await proc.stop();
    await drain;
  }
}
