#!/usr/bin/env node

import { runNotifyDaemonCommand } from '../src/daemon.js';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; index += 1; }
  }
  if (positional[0] === 'daemon') positional.shift();
  return { positional, flags };
}

const { positional, flags } = parseArgs(process.argv);
runNotifyDaemonCommand(positional, flags).then((result) => {
  if (result !== null && result !== undefined) process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
}).catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = 1;
});
