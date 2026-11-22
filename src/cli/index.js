#!/usr/bin/env node
import { parse, help, version } from './args.js';

try {
  const args = parse(process.argv.slice(2));
  if (args.cmd === 'version' || args.cmd === 'help') {
    const output = args.cmd === 'version' ? version : help;
    console.log(args.values.json ? JSON.stringify({ schemaVersion: 1, [args.cmd]: output }) : output);
  } else {
    if (Number(process.versions.node.split('.')[0]) !== 24)
      throw Object.assign(new Error('Install Node.js 24 LTS for Igor v' + version), { exitCode: 3 });
    if (process.platform !== 'win32') process.umask(0o077);
    const { main } = await import('./main.js');
    await main(args);
  }
} catch (err) {
  process.exitCode = err.exitCode || 1;
  if (process.argv.includes('--json'))
    console.log(JSON.stringify({ schemaVersion: 1, error: err.message, exitCode: process.exitCode }));
  else console.error('igor: ' + err.message);
}
