import { parseArgs } from 'node:util';
import { check, IgorError } from '../core.js';
import pkg from '../../package.json' with { type: 'json' };

export const version = pkg.version;

const specs = {
  start: ['model'],
  stop: [],
  supervise: [],
  doctor: ['model'],
  run: [
    'prompt',
    'prompt-file',
    'code',
    'docs',
    'model',
    'context',
    'reasoning-effort',
    'timeout-ms',
    'background',
    'follow',
    'mock-mode',
    'mock-delay-ms',
  ],
  list: ['status'],
  status: [],
  logs: ['follow'],
  wait: [],
  result: [],
  review: [],
  verify: ['check', 'baseline'],
  diff: [],
  export: ['output'],
  cancel: [],
  clean: ['older-than-days'],
  model: ['file'],
  help: [],
  version: [],
};
const booleans = new Set(['json', 'background', 'follow', 'baseline', 'help', 'version']);
export function parse(argv) {
  const names = new Set([...Object.values(specs).flat(), ...booleans]);
  const options = Object.fromEntries(
    [...names].map(k => [k, { type: booleans.has(k) ? 'boolean' : 'string' }])
  );
  options.help.short = 'h';
  options.version.short = 'v';
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true, tokens: true });
  } catch (err) {
    throw new IgorError(err.message, 2);
  }
  const { positionals, values, tokens } = parsed;
  const cmd = values.help ? 'help' : values.version ? 'version' : positionals.shift() || 'help';
  check(Object.hasOwn(specs, cmd), 'Unknown command: ' + cmd);
  if (cmd === 'help' || cmd === 'version') return { cmd, values, positionals: [] };
  const seen = new Set();
  for (const t of tokens.filter(t => t.kind === 'option')) {
    check(!seen.has(t.name), 'Duplicate option --' + t.name);
    seen.add(t.name);
    check(t.name === 'json' || specs[cmd].includes(t.name), 'Invalid option for ' + cmd + ': --' + t.name);
  }
  const required = ['result', 'review', 'verify', 'diff', 'export', 'logs', 'wait', 'cancel'].includes(cmd)
    ? 1
    : 0;
  if (cmd === 'model') {
    const [sub] = positionals;
    check(['list', 'inspect', 'add', 'download', 'verify', 'remove'].includes(sub), 'Unknown model command');
    check(
      positionals.length === (sub === 'list' ? 1 : 2),
      'Expected model ' + sub + (sub === 'list' ? '' : ' MODEL_ID')
    );
    check(sub === 'add' ? Boolean(values.file) : !values.file, 'model add requires --file DEFINITION.json');
  } else
    check(
      positionals.length >= required && positionals.length <= (cmd === 'status' ? 1 : required),
      'Unexpected or missing arguments for ' + cmd
    );
  if (cmd === 'run') {
    check(
      values.code && Boolean(values.prompt) !== Boolean(values['prompt-file']),
      'run requires --code and exactly one of --prompt or --prompt-file'
    );
    check(!(values.follow && values.background), 'Use --follow or --background');
    if (values['reasoning-effort'] !== undefined)
      check(
        ['default', 'none', 'low'].includes(values['reasoning-effort']),
        'Expected reasoning effort default, none, or low'
      );
  }
  if (cmd === 'export') check(values.output, 'export requires --output');
  if (cmd === 'verify')
    check(
      values.check?.trim() && Buffer.byteLength(values.check) <= 16384 && !values.check.includes('\0'),
      'verify requires --check with a shell command up to 16384 bytes'
    );
  return { cmd, values, positionals };
}
export const help = `Igor ${version} · local coding delegation

  igor doctor [--model ID]             Check dependencies and model readiness
  igor start [--model ID]              Start the supervisor and inference service
  igor stop                           Stop services owned by Igor
  igor run --code DIR (--prompt TEXT | --prompt-file FILE)
           [--docs DIR] [--model ID] [--context TOKENS] [--timeout-ms MS] [--background | --follow]
           [--reasoning-effort default|none|low] (managed oMLX)
  igor list [--status STATE]           List jobs in submission order
  igor status [JOB_ID]                 Show service or job status
  igor logs JOB_ID [--follow]          Read structured job events
  igor wait JOB_ID                    Wait for the terminal result
  igor result JOB_ID                  Read the job result
  igor review JOB_ID                  Read the result, diff and verification summary
  igor verify JOB_ID --check CMD [--baseline]
                                       Check a patch or the original snapshot (macOS)
  igor diff JOB_ID                    Print the Git patch
  igor export JOB_ID --output FILE    Write a new patch file
  igor cancel JOB_ID                  Request cancellation
  igor clean [--older-than-days N]    Remove terminal jobs and their artifacts
  igor model list | inspect ID | add ID --file FILE | download ID | verify ID | remove ID

All commands support --json. Set IGOR_HOME to select a dedicated data directory.`;
