import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm } from 'node:fs/promises';
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
    CODEX_HOME_CONFIG_VERSION: 8,
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

function fakeSseClient(req = {}) {
  const client = {
    magclawRequest: req,
    writes: [],
    write(packet) {
      this.writes.push(packet);
      return true;
    },
  };
  return client;
}

function ssePackets(client, eventName) {
  return client.writes.filter((packet) => packet.startsWith(`event: ${eventName}\n`));
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

test('state core writes activity events to JSONL and restores recent activity tail', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-state-core-activity-'));
  const activityDir = path.join(tmp, 'activity-logs');
  try {
    const first = makeStateCore(tmp, {
      USE_SQLITE_STATE: false,
      ACTIVITY_LOG_DIR: activityDir,
    });
    await first.ensureStorage();
    first.addSystemEvent('activity_probe', 'Activity persisted.', { agentId: 'agt_codex' });
    await first.flushActivityLog();

    const logText = await readFile(path.join(activityDir, 'activity-2026-05-12.jsonl'), 'utf8');
    assert.match(logText, /activity_probe/);

    const second = makeStateCore(tmp, {
      USE_SQLITE_STATE: false,
      ACTIVITY_LOG_DIR: activityDir,
    });
    await second.ensureStorage();
    assert.ok(second.stateFullSnapshot().events.some((event) => event.type === 'activity_probe' && event.agentId === 'agt_codex'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('state core coalesces burst state broadcasts for SSE clients', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-state-core-sse-'));
  const sseClients = new Set();
  const cloudPushes = [];
  let snapshotSeq = 0;
  const core = makeStateCore(tmp, {
    USE_SQLITE_STATE: false,
    STATE_BROADCAST_DEBOUNCE_MS: 20,
    sseClients,
    publicState: (req) => ({
      requestId: req?.requestId || '',
      snapshotSeq: snapshotSeq += 1,
    }),
    queueCloudPush: (reason) => cloudPushes.push(reason),
  });
  const firstClient = fakeSseClient({ requestId: 'first' });
  const secondClient = fakeSseClient({ requestId: 'second' });
  sseClients.add(firstClient);
  sseClients.add(secondClient);

  try {
    await core.ensureStorage();
    core.broadcastState();
    core.broadcastState();
    core.broadcastState();

    assert.equal(ssePackets(firstClient, 'state-delta').length, 0);
    assert.deepEqual(cloudPushes, ['state_changed', 'state_changed', 'state_changed']);

    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(ssePackets(firstClient, 'state-delta').length, 1);
    assert.equal(ssePackets(firstClient, 'heartbeat').length, 1);
    assert.equal(ssePackets(secondClient, 'state-delta').length, 1);
    assert.equal(ssePackets(secondClient, 'heartbeat').length, 1);
    assert.match(ssePackets(firstClient, 'state-delta')[0], /"type":"state_patch"/);
    assert.match(ssePackets(firstClient, 'state-delta')[0], /"requestId":"first"/);
    assert.match(ssePackets(secondClient, 'state-delta')[0], /"requestId":"second"/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
