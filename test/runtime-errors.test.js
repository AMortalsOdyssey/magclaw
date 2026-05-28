import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  classifyRuntimeError,
  isRuntimeSessionReplayError,
  runtimeActivityWithStructuredError,
} from '../server/runtime-errors.js';

test('runtime error classifier maps auth and startup failures to structured actions', () => {
  const login = classifyRuntimeError(new Error('Codex authentication failed: not logged in'), {
    runtime: 'codex',
    phase: 'thread/start',
  });
  assert.equal(login.code, 'login_required');
  assert.equal(login.recoverable, true);
  assert.equal(login.recoveryAction, 'reauthorize_runtime');
  assert.match(login.userAction, /sign in/i);

  const spawn = classifyRuntimeError(new Error('spawn /bad/codex ENOENT'), {
    runtime: 'codex',
    phase: 'spawn',
  });
  assert.equal(spawn.code, 'spawn_failed');
  assert.equal(spawn.recoverable, false);
  assert.equal(spawn.recoveryAction, 'fix_runtime_path');
});

test('runtime error classifier marks stale thread resume as auto recoverable', () => {
  const error = classifyRuntimeError({
    message: 'thread/resume failed: thread not found, session replay rejected',
  }, {
    runtime: 'codex',
    phase: 'thread/resume',
  });

  assert.equal(error.code, 'session_replay_rejected');
  assert.equal(error.recoverable, true);
  assert.equal(error.recoveryAction, 'start_new_session');
  assert.equal(isRuntimeSessionReplayError(error), true);
});

test('runtime activity wrapper exposes UI-facing error fields', () => {
  const activity = runtimeActivityWithStructuredError({
    source: 'codex-stderr',
    detail: 'Current runtime status: thinking',
  }, 'ERROR codex_api::endpoint::responses_websocket: failed to connect to websocket: /v1/responses', {
    runtime: 'codex',
    phase: 'daemon-activity',
  });

  assert.equal(activity.errorCode, 'network_or_proxy_failure');
  assert.equal(activity.errorTitle, 'Runtime network failure');
  assert.equal(activity.recoverable, true);
  assert.equal(activity.recoveryAction, 'check_proxy_then_retry');
  assert.match(activity.userAction, /proxy\/network/i);
  assert.equal(activity.runtimeError.code, 'network_or_proxy_failure');
});

test('codex app-server handler can recover stale thread resume with a fresh start', async () => {
  const source = await readFile(new URL('../server/agent-runtime/app-server-turns.js', import.meta.url), 'utf8');

  assert.match(source, /function recoverCodexThreadResume/);
  assert.match(source, /pending\?\.method !== 'thread\/resume'/);
  assert.match(source, /isRuntimeSessionReplayError\(runtimeError\)/);
  assert.match(source, /delete params\.threadId/);
  assert.match(source, /sendCodexAppServerRequest\(proc, 'thread\/start', params\)/);
  assert.match(source, /agent_runtime_recovery/);
});
