#!/usr/bin/env node

import { installNotifyOpenClawPlugin } from '../dist/plugin-installer.js';

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
  if (['owner', 'daemon'].includes(positional[0])) positional.shift();
  return { positional, flags };
}

const { positional, flags } = parseArgs(process.argv);
const command = positional[0] || 'status';
const operation = flags.version === true || command === 'version'
  ? import('../package.json', { with: { type: 'json' } }).then(({ default: pkg }) => ({ __version: pkg.version }))
  : command === 'install'
  ? installNotifyOpenClawPlugin({ target: flags.target || flags.pluginPath })
  : import('../dist/owner.js').then(({ runNotifyOwnerCommand }) => runNotifyOwnerCommand(positional, flags));

operation.then((result) => {
  if (result?.__version) process.stdout.write(`${result.__version}\n`);
  else if (result !== null && result !== undefined) process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
}).catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error.message })}\n`);
  process.exitCode = 1;
});
