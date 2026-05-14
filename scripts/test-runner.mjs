#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(__filename), '..');

const suites = {
  quick: [
    'test/agent-context.test.js',
    'test/agent-history.test.js',
    'test/agent-routes.test.js',
    'test/agent-tool-routes.test.js',
    'test/cloud-auth-operations.test.js',
    'test/cloud-postgres.test.js',
    'test/cloud-routes.test.js',
    'test/codex-runtime.test.js',
    'test/collab-routes.test.js',
    'test/config-yaml.test.js',
    'test/daemon-package.test.js',
    'test/daemon-relay-socket-errors.test.js',
    'test/delivery-boundaries.test.js',
    'test/fanout-api.test.js',
    'test/fanout-toast.test.js',
    'test/intents.test.js',
    'test/mentions.test.js',
    'test/mission-routes.test.js',
    'test/path-utils.test.js',
    'test/project-files.test.js',
    'test/project-routes.test.js',
    'test/release-notes.test.js',
    'test/reminder-scheduler.test.js',
    'test/state-core.test.js',
    'test/system-routes.test.js',
    'test/task-routes.test.js',
    'test/ui-sse-render.test.js',
  ],
  ui: [
    'test/console-server-form.test.js',
    'test/console-server-navigation.test.js',
    'test/project-ui.test.js',
    'test/ui-sse-render.test.js',
  ],
  flow: [
    'test/cloud-auth-relay.test.js',
    'test/daemon-codex-relay.test.js',
    'test/magclaw-flow-01.test.js',
    'test/magclaw-flow-02.test.js',
    'test/magclaw-flow-03.test.js',
  ],
  pg: [
    'test/cloud-postgres.test.js',
    'test/cloud-auth-postgres.test.js',
  ],
};

function allTestFiles() {
  return readdirSync(path.join(ROOT, 'test'))
    .filter((name) => name.endsWith('.test.js'))
    .sort()
    .map((name) => `test/${name}`);
}

const rawArgs = process.argv.slice(2);
const separatorIndex = rawArgs.indexOf('--');
const suiteName = (separatorIndex === 0 ? 'quick' : rawArgs[0]) || 'quick';
const unexpectedArgs = separatorIndex >= 0 ? rawArgs.slice(1, separatorIndex) : rawArgs.slice(1);
const extraNodeArgs = separatorIndex >= 0 ? rawArgs.slice(separatorIndex + 1) : [];
const files = suiteName === 'all' ? allTestFiles() : suites[suiteName];

if (!files) {
  console.error(`Unknown test suite "${suiteName}". Use one of: ${[...Object.keys(suites), 'all'].join(', ')}`);
  process.exit(1);
}

if (unexpectedArgs.length) {
  console.error(`Unexpected argument(s): ${unexpectedArgs.join(' ')}. Pass node test flags after "--".`);
  process.exit(1);
}

const serialSuites = new Set(['all', 'flow']);
const args = [
  '--test',
  ...(serialSuites.has(suiteName) ? ['--test-concurrency=1'] : []),
  ...extraNodeArgs,
  ...files,
];
const child = spawn(process.execPath, args, {
  cwd: ROOT,
  stdio: 'inherit',
  env: {
    ...process.env,
    MAGCLAW_ATTACHMENT_STORAGE: process.env.MAGCLAW_ATTACHMENT_STORAGE || 'local',
  },
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
