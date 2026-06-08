import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

function fakeSseClient(req = {}, options = {}) {
  const listeners = new Map();
  const client = {
    magclawRequest: req,
    writes: [],
    blockWrites: Boolean(options.blockWrites),
    write(packet) {
      this.writes.push(packet);
      return !this.blockWrites;
    },
    once(eventName, listener) {
      listeners.set(eventName, listener);
    },
    emitDrain() {
      const listener = listeners.get('drain');
      listeners.delete('drain');
      this.blockWrites = false;
      listener?.();
    },
  };
  return client;
}

function ssePackets(client, eventName) {
  return client.writes.filter((packet) => packet.startsWith(`event: ${eventName}\n`));
}

function sseEnvelopes(client, eventName) {
  return ssePackets(client, eventName).map((packet) => {
    const match = packet.match(/^event: [^\n]+\ndata: ([\s\S]*)\n\n$/);
    return JSON.parse(match?.[1] || '{}');
  });
}

test('state core can skip local SQLite and JSON persistence for PostgreSQL-backed cloud mode', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-state-core-'));
  const core = makeStateCore(tmp, {
    USE_SQLITE_STATE: false,
    ACTIVITY_LOG_DIR: path.join(tmp, 'activity-logs'),
  });
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

test('state core waits for external persistence when no local durable store is enabled', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-state-core-external-'));
  const core = makeStateCore(tmp, {
    USE_SQLITE_STATE: false,
    WRITE_STATE_JSON: false,
    ACTIVITY_LOG_DIR: path.join(tmp, 'activity-logs'),
  });
  let releaseExternal;
  let externalStarted = false;
  let externalFinished = false;
  const externalGate = new Promise((resolve) => {
    releaseExternal = resolve;
  });
  try {
    await core.ensureStorage();
    core.setExternalStatePersister(async () => {
      externalStarted = true;
      await externalGate;
      externalFinished = true;
    });

    const persistPromise = core.persistState();
    for (let index = 0; index < 5 && !externalStarted; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(externalStarted, true);

    let persistSettled = false;
    persistPromise.finally(() => {
      persistSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(persistSettled, false);

    releaseExternal();
    await persistPromise;
    assert.equal(externalFinished, true);
  } finally {
    releaseExternal?.();
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

test('state core reads a deduped seven day agent activity window from state and JSONL logs', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-state-core-agent-activity-'));
  const activityDir = path.join(tmp, 'activity-logs');
  try {
    await mkdir(activityDir, { recursive: true });
    await writeFile(path.join(activityDir, 'activity-2026-05-10.jsonl'), [
      JSON.stringify({
        id: 'evt_yesterday',
        type: 'agent_activity',
        message: 'Ada reported daemon activity.',
        agentId: 'agt_ada',
        createdAt: '2026-05-10T08:00:00.000Z',
      }),
      JSON.stringify({
        id: 'evt_other',
        type: 'agent_activity',
        message: 'Other agent activity.',
        agentId: 'agt_other',
        createdAt: '2026-05-10T09:00:00.000Z',
      }),
    ].join('\n') + '\n');
    await writeFile(path.join(activityDir, 'activity-2026-05-03.jsonl'), `${JSON.stringify({
      id: 'evt_old',
      type: 'agent_activity',
      message: 'Old Ada activity.',
      agentId: 'agt_ada',
      createdAt: '2026-05-03T08:00:00.000Z',
    })}\n`);

    const core = makeStateCore(tmp, {
      USE_SQLITE_STATE: false,
      ACTIVITY_LOG_DIR: activityDir,
      now: () => '2026-05-11T12:00:00.000Z',
    });
    await core.ensureStorage();
    core.addSystemEvent('agent_status_changed', 'Ada is idle.', {
      id: 'evt_today',
      agentId: 'agt_ada',
      status: 'idle',
      createdAt: '2026-05-11T10:00:00.000Z',
    });
    core.addSystemEvent('agent_activity', 'Duplicate state event should win.', {
      id: 'evt_yesterday',
      agentId: 'agt_ada',
      createdAt: '2026-05-10T08:30:00.000Z',
    });
    await core.flushActivityLog();

    const result = await core.agentActivityWindow('agt_ada', {
      days: 7,
      limit: 2,
      before: '2026-05-11T12:00:00.000Z',
    });

    assert.equal(result.agentId, 'agt_ada');
    assert.equal(result.events.length, 2);
    assert.deepEqual(result.events.map((event) => event.id), ['evt_today', 'evt_yesterday']);
    assert.equal(result.events[1].message, 'Duplicate state event should win.');
    assert.equal(result.hasMore, false);
    assert.equal(result.nextBefore, '');
    assert.equal(result.windowStart, '2026-05-04T12:00:00.000Z');
    assert.equal(result.windowEnd, '2026-05-11T12:00:00.000Z');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('state core coalesces burst state broadcasts into lightweight resync signals', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-state-core-sse-'));
  const sseClients = new Set();
  const cloudPushes = [];
  let publicStateCalls = 0;
  const core = makeStateCore(tmp, {
    USE_SQLITE_STATE: false,
    STATE_BROADCAST_DEBOUNCE_MS: 20,
    sseClients,
    publicState: (req) => ({
      spaceId: new URL(req?.url || '/api/events', 'http://127.0.0.1').searchParams.get('spaceId') || '',
      snapshotSeq: publicStateCalls += 1,
    }),
    queueCloudPush: (reason) => cloudPushes.push(reason),
  });
  const sharedScope = {
    url: '/api/events?spaceType=channel&spaceId=chan_all&messageLimit=50&threadRootLimit=30',
    headers: { cookie: 'magclaw_session=same-user' },
  };
  const firstClient = fakeSseClient(sharedScope);
  const secondClient = fakeSseClient(sharedScope);
  const thirdClient = fakeSseClient({
    url: '/api/events?spaceType=channel&spaceId=chan_design&messageLimit=50&threadRootLimit=30',
    headers: { cookie: 'magclaw_session=same-user' },
  });
  sseClients.add(firstClient);
  sseClients.add(secondClient);
  sseClients.add(thirdClient);

  try {
    await core.ensureStorage();
    core.broadcastState();
    core.broadcastState();
    core.broadcastState();

    assert.equal(ssePackets(firstClient, 'state-resync-required').length, 0);
    assert.deepEqual(cloudPushes, ['state_changed', 'state_changed', 'state_changed']);

    await new Promise((resolve) => setTimeout(resolve, 60));

    assert.equal(ssePackets(firstClient, 'state-resync-required').length, 1);
    assert.equal(ssePackets(firstClient, 'heartbeat').length, 0);
    assert.equal(ssePackets(secondClient, 'state-resync-required').length, 1);
    assert.equal(ssePackets(secondClient, 'heartbeat').length, 0);
    assert.equal(ssePackets(thirdClient, 'state-resync-required').length, 1);
    assert.equal(ssePackets(thirdClient, 'heartbeat').length, 0);
    assert.equal(publicStateCalls, 0);
    assert.equal(ssePackets(firstClient, 'state-resync-required')[0], ssePackets(secondClient, 'state-resync-required')[0]);
    assert.equal(ssePackets(firstClient, 'state-resync-required')[0], ssePackets(thirdClient, 'state-resync-required')[0]);
    assert.match(ssePackets(firstClient, 'state-resync-required')[0], /"type":"state_resync_required"/);
    assert.doesNotMatch(ssePackets(firstClient, 'state-resync-required')[0], /"payload"/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('state core broadcasts agent realtime events without forcing state patches', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-state-core-realtime-'));
  const activityDir = path.join(tmp, 'activity-logs');
  await mkdir(activityDir, { recursive: true });
  const sseClients = new Set();
  const core = makeStateCore(tmp, {
    USE_SQLITE_STATE: false,
    ACTIVITY_LOG_DIR: activityDir,
    STATE_BROADCAST_DEBOUNCE_MS: 0,
    sseClients,
  });
  const channelClient = fakeSseClient({ url: '/api/events?spaceType=channel&spaceId=chan_all' });
  const otherChannelClient = fakeSseClient({ url: '/api/events?spaceType=channel&spaceId=chan_other' });
  sseClients.add(channelClient);
  sseClients.add(otherChannelClient);

  try {
    await core.ensureStorage();
    core.setAgentStatus(core.state.agents[0], 'working', 'test', { forceEvent: true });
    core.addSystemEvent('message_sent', 'Message sent.', {
      workspaceId: 'local',
      spaceType: 'channel',
      spaceId: 'chan_all',
      messageId: 'msg_1',
    });

    const channelEvents = sseEnvelopes(channelClient, 'realtime-event');
    const otherEvents = sseEnvelopes(otherChannelClient, 'realtime-event');
    assert.ok(channelEvents.some((event) => event.eventType === 'agent_status_changed'));
    assert.ok(channelEvents.some((event) => event.eventType === 'agent_activity_changed'));
    assert.ok(otherEvents.some((event) => event.eventType === 'agent_status_changed'));
    assert.ok(otherEvents.some((event) => event.eventType === 'agent_activity_changed'));
    assert.ok(channelEvents.some((event) => event.payload?.event?.type === 'message_sent'));
    assert.equal(otherEvents.some((event) => event.payload?.event?.type === 'message_sent'), false);
    assert.equal(ssePackets(channelClient, 'state-delta').length, 0);
    assert.equal(ssePackets(otherChannelClient, 'state-delta').length, 0);
    await core.flushActivityLog();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('state core broadcasts unread realtime events for lightweight count refresh', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-state-core-unread-'));
  const sseClients = new Set();
  const core = makeStateCore(tmp, {
    USE_SQLITE_STATE: false,
    STATE_BROADCAST_DEBOUNCE_MS: 0,
    sseClients,
  });
  const channelClient = fakeSseClient({ url: '/api/events?spaceType=channel&spaceId=chan_all' });
  const unrelatedClient = fakeSseClient({ url: '/api/events?spaceType=channel&spaceId=chan_other' });
  sseClients.add(channelClient);
  sseClients.add(unrelatedClient);

  try {
    await core.ensureStorage();
    core.recordRealtimeEvent('unread_counts_invalidated', {
      workspaceId: 'local',
      spaceType: 'channel',
      spaceId: 'chan_all',
      messageId: 'msg_1',
    }, {
      workspaceId: 'local',
      scopeType: 'workspace',
      scopeId: 'local',
    });
    core.recordRealtimeEvent('unread_counts_updated', {
      workspaceId: 'local',
      targetHumanId: 'hum_reader',
      updatedAt: '2026-05-12T00:00:00.000Z',
    }, {
      workspaceId: 'local',
      scopeType: 'workspace',
      scopeId: 'local',
    });

    const channelEvents = sseEnvelopes(channelClient, 'realtime-event');
    const unrelatedEvents = sseEnvelopes(unrelatedClient, 'realtime-event');
    assert.deepEqual(channelEvents.map((event) => event.eventType), [
      'unread_counts_invalidated',
      'unread_counts_updated',
    ]);
    assert.deepEqual(unrelatedEvents.map((event) => event.eventType), [
      'unread_counts_invalidated',
      'unread_counts_updated',
    ]);
    assert.equal(ssePackets(channelClient, 'state-delta').length, 0);

    const replay = core.realtimeEventsForRequest({
      url: '/api/events?spaceType=channel&spaceId=chan_all',
    }, 0);
    assert.equal(replay.gap, false);
    assert.deepEqual(replay.events.map((event) => event.eventType), [
      'unread_counts_invalidated',
      'unread_counts_updated',
    ]);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('state core coalesces pending resync signals for backpressured SSE clients', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-state-core-slow-sse-'));
  const sseClients = new Set();
  let publicStateCalls = 0;
  const core = makeStateCore(tmp, {
    USE_SQLITE_STATE: false,
    STATE_BROADCAST_DEBOUNCE_MS: 0,
    sseClients,
    publicState: () => ({ snapshotSeq: publicStateCalls += 1 }),
  });
  const slowClient = fakeSseClient({ url: '/api/events?spaceType=channel&spaceId=chan_all' }, { blockWrites: true });
  sseClients.add(slowClient);

  try {
    await core.ensureStorage();
    core.broadcastState({ immediate: true });
    core.broadcastState({ immediate: true });
    core.broadcastState({ immediate: true });

    assert.equal(ssePackets(slowClient, 'state-resync-required').length, 1);
    assert.equal(publicStateCalls, 0);

    slowClient.emitDrain();

    const patches = sseEnvelopes(slowClient, 'state-resync-required');
    assert.equal(patches.length, 2);
    assert.equal(patches.at(-1).type, 'state_resync_required');
    assert.equal(patches.at(-1).reason, 'state_changed');
    assert.equal(publicStateCalls, 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('state core keeps state generation bounded for 100 SSE clients during agent status bursts', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-state-core-sse-load-'));
  const activityDir = path.join(tmp, 'activity-logs');
  await mkdir(activityDir, { recursive: true });
  const sseClients = new Set();
  let publicStateCalls = 0;
  const core = makeStateCore(tmp, {
    USE_SQLITE_STATE: false,
    ACTIVITY_LOG_DIR: activityDir,
    STATE_BROADCAST_DEBOUNCE_MS: 0,
    sseClients,
    publicState: () => ({ snapshotSeq: publicStateCalls += 1 }),
  });
  const clients = Array.from({ length: 100 }, () => fakeSseClient({
    url: '/api/events?spaceType=channel&spaceId=chan_all&messageLimit=50&threadRootLimit=30',
    headers: { cookie: 'magclaw_session=same-user' },
  }));
  for (const client of clients) sseClients.add(client);

  try {
    await core.ensureStorage();
    core.broadcastState({ immediate: true, skipCloudPush: true });
    assert.equal(publicStateCalls, 0);
    assert.equal(clients.every((client) => ssePackets(client, 'state-resync-required').length === 1), true);
    assert.equal(clients.every((client) => ssePackets(client, 'heartbeat').length === 0), true);

    const agent = core.state.agents[0];
    for (let index = 0; index < 10; index += 1) {
      core.setAgentStatus(agent, index % 2 === 0 ? 'working' : 'thinking', 'load_test', { forceEvent: true });
    }

    assert.equal(publicStateCalls, 0);
    assert.equal(clients.every((client) => ssePackets(client, 'state-resync-required').length === 1), true);
    assert.equal(clients.every((client) => ssePackets(client, 'realtime-event').length >= 10), true);
    assert.equal(clients.every((client) => ssePackets(client, 'heartbeat').length === 0), true);
    const averagePacketBytes = clients
      .flatMap((client) => client.writes)
      .reduce((sum, packet) => sum + Buffer.byteLength(packet), 0) / clients.reduce((sum, client) => sum + client.writes.length, 0);
    assert.ok(averagePacketBytes > 0);
    await core.flushActivityLog();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('state core filters presence heartbeats to the request workspace', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-state-core-heartbeat-'));
  const core = makeStateCore(tmp, { USE_SQLITE_STATE: false });
  try {
    await core.ensureStorage();
    core.state.connection.workspaceId = 'wsp_a';
    core.state.agents = [
      { id: 'agt_a', workspaceId: 'wsp_a', name: 'Agent A', status: 'idle' },
      { id: 'agt_b', workspaceId: 'wsp_b', name: 'Agent B', status: 'working' },
      { id: 'agt_legacy', name: 'Legacy Agent', status: 'idle' },
    ];
    core.state.humans = [
      { id: 'hum_a', workspaceId: 'wsp_a', name: 'Human A', status: 'online', lastSeenAt: new Date().toISOString() },
      { id: 'hum_b', workspaceId: 'wsp_b', name: 'Human B', status: 'online', lastSeenAt: new Date().toISOString() },
      { id: 'hum_legacy', name: 'Legacy Human', status: 'offline' },
    ];

    const heartbeat = core.presenceHeartbeat({ magclawPresenceWorkspaceId: 'wsp_a' });

    assert.deepEqual(heartbeat.agents.map((agent) => agent.id), ['agt_a', 'agt_legacy']);
    assert.deepEqual(heartbeat.humans.map((human) => human.id), ['hum_a', 'hum_legacy']);
    assert.deepEqual(heartbeat.agents[0], { id: 'agt_a', status: 'idle' });
    assert.equal(heartbeat.agents[0].name, undefined);
    assert.equal(heartbeat.agents[0].activeWorkItemIds, undefined);
    assert.equal(heartbeat.humans[0].name, undefined);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('state core skips unchanged presence heartbeat payloads after initial fanout', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-state-core-heartbeat-dedupe-'));
  const sseClients = new Set();
  const core = makeStateCore(tmp, {
    USE_SQLITE_STATE: false,
    WRITE_STATE_JSON: false,
    sseClients,
  });
  try {
    await core.ensureStorage();
    core.state.agents = [{
      id: 'agt_a',
      workspaceId: 'local',
      status: 'idle',
      createdAt: '2026-05-12T00:00:00.000Z',
    }];
    core.state.humans = [{
      id: 'hum_a',
      workspaceId: 'local',
      status: 'online',
      lastSeenAt: new Date().toISOString(),
      createdAt: '2026-05-12T00:00:00.000Z',
    }];
    const client = fakeSseClient({ magclawPresenceWorkspaceId: 'local' });
    sseClients.add(client);

    core.broadcastHeartbeat();
    core.broadcastHeartbeat();

    assert.equal(ssePackets(client, 'heartbeat').length, 1);
    assert.equal(client.writes.at(-1).startsWith(': heartbeat-unchanged'), true);

    core.state.agents[0].status = 'working';
    core.broadcastHeartbeat();

    const heartbeats = sseEnvelopes(client, 'heartbeat');
    assert.equal(heartbeats.length, 2);
    assert.equal(heartbeats.at(-1).agents[0].status, 'working');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('state core records scoped realtime journal events for SSE replay', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-state-core-journal-'));
  const activityDir = path.join(tmp, 'activity-logs');
  await mkdir(activityDir, { recursive: true });
  const core = makeStateCore(tmp, {
    USE_SQLITE_STATE: false,
    ACTIVITY_LOG_DIR: activityDir,
  });
  try {
    await core.ensureStorage();
    const event = core.addSystemEvent('message_sent', 'Message sent.', {
      workspaceId: 'local',
      spaceType: 'channel',
      spaceId: 'chan_all',
      messageId: 'msg_1',
    });
    core.setAgentStatus(core.state.agents[0], 'working', 'test', { forceEvent: true });

    const snapshot = core.stateFullSnapshot();
    assert.equal(snapshot.cloud.realtimeEvents.length, 4);
    assert.deepEqual(snapshot.cloud.realtimeEvents.map((item) => item.seq), [1, 2, 3, 4]);
    assert.equal(snapshot.cloud.realtimeEvents[0].payload.event.id, event.id);
    const activityEvent = snapshot.cloud.realtimeEvents.find((item) => item.eventType === 'agent_activity_changed');
    assert.equal(activityEvent.payload.agentId, core.state.agents[0].id);
    assert.ok(activityEvent.payload.activitySeq >= 1);
    assert.ok(Array.isArray(activityEvent.payload.entries));

    const replay = core.realtimeEventsForRequest({
      url: '/api/events?spaceType=channel&spaceId=chan_all',
    }, 0);
    assert.equal(replay.gap, false);
    assert.equal(replay.currentSeq, 4);
    assert.deepEqual(replay.events.map((item) => item.eventType), ['system_event', 'system_event', 'agent_status_changed', 'agent_activity_changed']);
    await core.flushActivityLog();
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
