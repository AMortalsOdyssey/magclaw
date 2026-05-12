import assert from 'node:assert/strict';
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createStateCore } from '../server/state-core.js';

function makeStateCore(tmp, overrides = {}) {
  let idCounter = 0;
  return createStateCore({
    ensureAllAgentWorkspaces: async () => {},
    extractLocalReferences: () => [],
    findAgent: () => null,
    agentProcesses: new Map(),
    makeId: (prefix) => `${prefix}_${idCounter += 1}`,
    normalizeConversationRecord: (record) => record,
    now: () => '2026-05-12T00:00:00.000Z',
    publicState: (state) => state,
    queueCloudPush: () => {},
    sseClients: new Set(),
    targetForConversation: () => '',
    taskScopeKey: () => '',
    AGENT_BOOT_RESET_STATUSES: new Set(),
    AGENT_STATUS_STALE_MS: 45_000,
    AGENTS_DIR: path.join(tmp, 'agents'),
    ATTACHMENTS_DIR: path.join(tmp, 'attachments'),
    CLOUD_PROTOCOL_VERSION: 1,
    CODEX_FALLBACK_MODEL: 'gpt-5.5',
    CODEX_HOME_CONFIG_VERSION: 7,
    FANOUT_API_TIMEOUT_MS: 30_000,
    ROOT: tmp,
    RUNS_DIR: path.join(tmp, 'runs'),
    SOURCE_CODEX_HOME: path.join(tmp, 'codex-home'),
    SQLITE_BACKED_STATE_KEYS: ['messages', 'replies', 'tasks', 'reminders', 'workItems', 'events'],
    STATE_DB_FILE: path.join(tmp, 'state.sqlite'),
    STATE_FILE: path.join(tmp, 'state.json'),
    WRITE_STATE_JSON: false,
    ...overrides,
  });
}

test('state core can skip local SQLite and JSON persistence for PostgreSQL-backed cloud mode', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-state-core-'));
  const core = makeStateCore(tmp, { USE_SQLITE_STATE: false });
  try {
    await core.ensureStorage();
    await core.persistState();

    await assert.rejects(() => lstat(path.join(tmp, 'state.sqlite')), /ENOENT/);
    await assert.rejects(() => lstat(path.join(tmp, 'state.json')), /ENOENT/);

    const snapshot = core.stateFullSnapshot();
    assert.equal(snapshot.storage.sqliteEnabled, false);
    assert.equal(snapshot.storage.jsonSnapshotEnabled, false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
