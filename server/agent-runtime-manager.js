import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { buildAgentContextPack, renderAgentContextPack } from './agent-context.js';
import { codexThreadConfig, parseCodexStreamRetry } from './codex-runtime.js';
import { normalizeIds } from './mentions.js';

// Agent runtime and delivery manager.
// This entrypoint owns dependency wiring; implementation parts live under
// server/agent-runtime/ so each file stays small enough for safe Agent edits.

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const runtimePartNames = [
  'core-helpers-prompts.js',
  'process-start.js',
  'codex-jsonrpc-tools.js',
  'watchdog.js',
  'app-server-turns.js',
  'legacy-stop.js',
  'warm-control-relay.js',
  'delivery-tasks.js',
  'exports.js',
];

const runtimeParts = runtimePartNames.map((name) => {
  const filename = path.join(__dirname, 'agent-runtime', name);
  return new vm.Script(readFileSync(filename, 'utf8'), { filename });
});

export function createAgentRuntimeManager(deps) {
  const state = new Proxy({}, {
    get(_target, prop) {
      return deps.getState()?.[prop];
    },
    set(_target, prop, value) {
      deps.getState()[prop] = value;
      return true;
    },
  });

  const runtimeContext = vm.createContext({
    ...deps,
    state,
    spawn,
    readFile,
    rm,
    path,
    buildAgentContextPack,
    renderAgentContextPack,
    codexThreadConfig,
    parseCodexStreamRetry,
    normalizeIds,
    process,
    console,
    URL,
    AbortController,
    Set,
    Map,
    fetch,
    setTimeout,
    clearTimeout,
  });

  for (const part of runtimeParts) {
    part.runInContext(runtimeContext);
  }

  return runtimeContext.__createAgentRuntimeExports();
}
