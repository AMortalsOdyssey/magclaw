import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStateCore } from '../server/state-core.js';
import { createSystemServices } from '../server/system-services.js';

const NOW = '2026-06-08T00:00:00.000Z';
const BUDGETS = Object.freeze({
  bootstrapBytes: Number(process.env.MAGCLAW_PERF_BOOTSTRAP_BYTES || 900_000),
  bootstrapMs: Number(process.env.MAGCLAW_PERF_BOOTSTRAP_MS || 250),
  heartbeatBytes: Number(process.env.MAGCLAW_PERF_HEARTBEAT_BYTES || 400_000),
  heartbeatMs: Number(process.env.MAGCLAW_PERF_HEARTBEAT_MS || 50),
  deferredOpenBytes: Number(process.env.MAGCLAW_PERF_DEFERRED_OPEN_BYTES || 10_000),
  repeatedHeartbeatBytes: Number(process.env.MAGCLAW_PERF_REPEATED_HEARTBEAT_BYTES || 10_000),
  humanHeartbeatChurnBytes: Number(process.env.MAGCLAW_PERF_HUMAN_HEARTBEAT_CHURN_BYTES || 10_000),
  presenceMemberDeltaBytes: Number(process.env.MAGCLAW_PERF_PRESENCE_MEMBER_DELTA_BYTES || 50_000),
  stateChangeFanoutBytes: Number(process.env.MAGCLAW_PERF_STATE_CHANGE_FANOUT_BYTES || 700_000),
  stateChangeFanoutBytesCoalesced: Number(process.env.MAGCLAW_PERF_STATE_CHANGE_FANOUT_COALESCED_BYTES || 120_000),
  stateChangeFanoutEvents: Number(process.env.MAGCLAW_PERF_STATE_CHANGE_FANOUT_EVENTS || 100),
  unreadHydrationRecords: Number(process.env.MAGCLAW_PERF_UNREAD_RECORDS || 80),
  bootstrapTasks: Number(process.env.MAGCLAW_PERF_BOOTSTRAP_TASKS || 200),
});

function assertBudget(condition, message) {
  if (condition) return;
  throw new Error(message);
}

function timestamp(offsetMs = 0) {
  return new Date(Date.parse(NOW) + offsetMs).toISOString();
}

function makeSyntheticState({
  humans = 1000,
  agents = 1000,
  messages = 20_000,
  replies = 1000,
  tasks = 2000,
} = {}) {
  const state = {
    version: 1,
    connection: { workspaceId: 'local' },
    settings: {},
    channels: [{
      id: 'chan_all',
      workspaceId: 'local',
      name: 'all',
      memberIds: ['hum_0000'],
      createdAt: NOW,
      updatedAt: NOW,
    }],
    dms: [],
    messages: [],
    replies: [],
    tasks: [],
    runs: [],
    workItems: [],
    events: [],
    routeEvents: [],
    systemNotifications: [],
    attachments: [],
    agents: [],
    humans: [],
    computers: [],
    reminders: [],
    missions: [],
    projects: [],
    channelMemberProposals: [],
  };

  for (let index = 0; index < humans; index += 1) {
    const id = `hum_${String(index).padStart(4, '0')}`;
    state.humans.push({
      id,
      workspaceId: 'local',
      name: `Human ${index}`,
      role: index === 0 ? 'owner' : 'member',
      status: index % 5 === 0 ? 'online' : 'offline',
      lastSeenAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
    });
    if (index < 200 && !state.channels[0].memberIds.includes(id)) {
      state.channels[0].memberIds.push(id);
    }
  }

  for (let index = 0; index < agents; index += 1) {
    state.agents.push({
      id: `agt_${String(index).padStart(4, '0')}`,
      workspaceId: 'local',
      name: `Agent ${index}`,
      description: `Synthetic agent ${index}`,
      role: 'agent',
      status: index % 10 === 0 ? 'working' : 'idle',
      runtime: 'codex',
      runtimeId: 'codex',
      model: 'gpt-test',
      activeWorkItemIds: index % 10 === 0 ? [`wi_${index}`] : [],
      statusUpdatedAt: NOW,
      heartbeatAt: NOW,
      createdAt: NOW,
      updatedAt: NOW,
      metadata: {
        promptCache: 'x'.repeat(1024),
        runtimeSession: { raw: 'x'.repeat(1024) },
      },
    });
  }

  for (let index = 0; index < messages; index += 1) {
    const createdAt = timestamp(index * 1000);
    state.messages.push({
      id: `msg_${String(index).padStart(5, '0')}`,
      workspaceId: 'local',
      spaceType: 'channel',
      spaceId: 'chan_all',
      authorType: 'agent',
      authorId: `agt_${String(index % agents).padStart(4, '0')}`,
      body: `synthetic message ${index} ${'m'.repeat(512)}`,
      readBy: index % 2 ? ['hum_0000'] : [],
      replyCount: index % 100 === 0 ? 1 : 0,
      createdAt,
      updatedAt: createdAt,
      metadata: {
        externalImport: { rawPayload: 'private'.repeat(200) },
        teamSharing: {
          sourceAnchor: `anchor-${index}`,
          eventId: `event-${index}`,
          contentSegments: [{ index: 0, body: 'duplicate'.repeat(200) }],
        },
      },
    });
  }

  for (let index = 0; index < replies; index += 1) {
    const createdAt = timestamp((messages + index) * 1000);
    state.replies.push({
      id: `rep_${String(index).padStart(4, '0')}`,
      workspaceId: 'local',
      parentMessageId: `msg_${String(index * 20).padStart(5, '0')}`,
      spaceType: 'channel',
      spaceId: 'chan_all',
      authorType: 'agent',
      authorId: `agt_${String(index % agents).padStart(4, '0')}`,
      body: `synthetic reply ${index} ${'r'.repeat(512)}`,
      readBy: [],
      createdAt,
      updatedAt: createdAt,
    });
  }

  for (let index = 0; index < tasks; index += 1) {
    state.tasks.push({
      id: `task_${index}`,
      workspaceId: 'local',
      spaceType: 'channel',
      spaceId: 'chan_all',
      title: `task ${index}`,
      status: index % 2 ? 'todo' : 'done',
      createdAt: NOW,
      updatedAt: NOW,
      metadata: {
        systemKind: index % 100 === 0 ? 'external_import' : '',
        startupCollaboration: { raw: 'internal'.repeat(200) },
      },
    });
  }

  return state;
}

function makeSystemServices(state) {
  return createSystemServices({
    addSystemEvent: () => {},
    broadcastState: () => {},
    fanoutApiConfigured: () => false,
    getState: () => state,
    httpError: (status, message) => Object.assign(new Error(message), { status }),
    makeId: (prefix) => `${prefix}_synthetic`,
    now: () => NOW,
    persistState: async () => {},
    publicCloudState: () => ({
      auth: {
        currentUser: { id: 'usr_perf' },
        currentMember: { workspaceId: 'local', humanId: 'hum_0000', role: 'admin' },
        storageBackend: 'postgres',
      },
      workspace: { id: 'local', slug: 'local' },
    }),
    projectsForSpace: () => [],
    runningProcesses: new Map(),
    selectedDefaultSpaceId: () => 'chan_all',
    DATA_DIR: os.tmpdir(),
    PORT: 6543,
    ROOT: process.cwd(),
    npmPackageVersions: { latest: (_packageName, fallback = '') => fallback, refreshAll: () => {} },
  });
}

async function measureHeartbeat(state) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-perf-scalability-'));
  try {
    const core = createStateCore({
      addSystemEvent: () => {},
      broadcastState: () => {},
      fanoutApiConfigured: () => false,
      getState: () => state,
      httpError: (status, message) => Object.assign(new Error(message), { status }),
      makeId: (prefix) => `${prefix}_synthetic`,
      now: () => NOW,
      persistState: async () => {},
      publicStateForSse: () => ({}),
      DATA_DIR: tmp,
      ROOT: process.cwd(),
      RUNS_DIR: tmp,
      STATE_FILE: path.join(tmp, 'state.json'),
      STATE_DB_FILE: path.join(tmp, 'state.db'),
      STATE_BROADCAST_DEBOUNCE_MS: 50,
      USE_SQLITE_STATE: false,
      WRITE_STATE_JSON: false,
      SQLITE_BACKED_STATE_KEYS: [],
    });
    Object.assign(core.state, state);
    const started = performance.now();
    const heartbeat = core.presenceHeartbeat({ magclawPresenceWorkspaceId: 'local' });
    const body = JSON.stringify(heartbeat);
    return {
      ms: Math.round(performance.now() - started),
      bytes: Buffer.byteLength(body, 'utf8'),
      agents: heartbeat.agents.length,
      humans: heartbeat.humans.length,
      hasInternalFields: body.includes('promptCache') || body.includes('runtimeSession'),
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function measureRepeatedHeartbeatFanout(state) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-perf-scalability-heartbeat-'));
  const sseClients = new Set();
  try {
    const core = createStateCore({
      addSystemEvent: () => {},
      broadcastState: () => {},
      fanoutApiConfigured: () => false,
      getState: () => state,
      httpError: (status, message) => Object.assign(new Error(message), { status }),
      makeId: (prefix) => `${prefix}_synthetic`,
      now: () => NOW,
      persistState: async () => {},
      publicStateForSse: () => ({}),
      sseClients,
      DATA_DIR: tmp,
      ROOT: process.cwd(),
      RUNS_DIR: tmp,
      STATE_FILE: path.join(tmp, 'state.json'),
      STATE_DB_FILE: path.join(tmp, 'state.db'),
      STATE_BROADCAST_DEBOUNCE_MS: 50,
      USE_SQLITE_STATE: false,
      WRITE_STATE_JSON: false,
      SQLITE_BACKED_STATE_KEYS: [],
    });
    Object.assign(core.state, state);
    const clients = Array.from({ length: 100 }, () => ({
      magclawRequest: { magclawPresenceWorkspaceId: 'local' },
      writes: [],
      write(packet) {
        this.writes.push(packet);
        return true;
      },
      once() {},
    }));
    for (const client of clients) sseClients.add(client);

    for (const client of clients) {
      core.writePresenceHeartbeat(client, client.magclawRequest, { seedOnly: true });
    }
    const deferredOpenWrites = clients.flatMap((client) => client.writes);
    core.broadcastHeartbeat();
    const firstWrites = clients.flatMap((client) => client.writes.slice(1));
    core.broadcastHeartbeat();
    const repeatedWrites = clients.flatMap((client) => client.writes.slice(2));

    return {
      clients: clients.length,
      deferredOpenBytes: deferredOpenWrites.reduce((sum, packet) => sum + Buffer.byteLength(packet, 'utf8'), 0),
      deferredOpenHeartbeatEvents: deferredOpenWrites.filter((packet) => packet.startsWith('event: heartbeat\n')).length,
      firstBytes: firstWrites.reduce((sum, packet) => sum + Buffer.byteLength(packet, 'utf8'), 0),
      firstHeartbeatEvents: firstWrites.filter((packet) => packet.startsWith('event: heartbeat\n')).length,
      repeatedBytes: repeatedWrites.reduce((sum, packet) => sum + Buffer.byteLength(packet, 'utf8'), 0),
      repeatedHeartbeatEvents: repeatedWrites.filter((packet) => packet.startsWith('event: heartbeat\n')).length,
      repeatedKeepalives: repeatedWrites.filter((packet) => packet.startsWith(': heartbeat-unchanged\n\n')).length,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function measureHumanHeartbeatChurnFanout(state) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-perf-scalability-human-heartbeat-'));
  const sseClients = new Set();
  try {
    const core = createStateCore({
      addSystemEvent: () => {},
      broadcastState: () => {},
      fanoutApiConfigured: () => false,
      getState: () => state,
      httpError: (status, message) => Object.assign(new Error(message), { status }),
      makeId: (prefix) => `${prefix}_synthetic`,
      now: () => NOW,
      persistState: async () => {},
      publicStateForSse: () => ({}),
      sseClients,
      DATA_DIR: tmp,
      ROOT: process.cwd(),
      RUNS_DIR: tmp,
      STATE_FILE: path.join(tmp, 'state.json'),
      STATE_DB_FILE: path.join(tmp, 'state.db'),
      STATE_BROADCAST_DEBOUNCE_MS: 50,
      USE_SQLITE_STATE: false,
      WRITE_STATE_JSON: false,
      SQLITE_BACKED_STATE_KEYS: [],
    });
    Object.assign(core.state, structuredClone(state));
    const human = core.state.humans[0];
    human.status = 'online';
    human.lastSeenAt = new Date().toISOString();
    human.presenceUpdatedAt = human.lastSeenAt;
    const clients = Array.from({ length: 100 }, () => ({
      magclawRequest: { magclawPresenceWorkspaceId: 'local' },
      writes: [],
      write(packet) {
        this.writes.push(packet);
        return true;
      },
      once() {},
    }));
    for (const client of clients) sseClients.add(client);

    for (const client of clients) {
      core.writePresenceHeartbeat(client, client.magclawRequest, { seedOnly: true });
    }
    human.lastSeenAt = new Date(Date.now() + 30_000).toISOString();
    human.presenceUpdatedAt = human.lastSeenAt;
    core.broadcastHeartbeat();
    const packets = clients.flatMap((client) => client.writes.slice(1));

    return {
      clients: clients.length,
      totalBytes: packets.reduce((sum, packet) => sum + Buffer.byteLength(packet, 'utf8'), 0),
      heartbeatEvents: packets.filter((packet) => packet.startsWith('event: heartbeat\n')).length,
      keepalives: packets.filter((packet) => packet.startsWith(': heartbeat-unchanged\n\n')).length,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function measurePresenceMemberDeltaFanout(state) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-perf-scalability-presence-delta-'));
  const sseClients = new Set();
  try {
    const core = createStateCore({
      addSystemEvent: () => {},
      broadcastState: () => {},
      fanoutApiConfigured: () => false,
      getState: () => state,
      httpError: (status, message) => Object.assign(new Error(message), { status }),
      makeId: (prefix) => `${prefix}_synthetic`,
      now: () => NOW,
      persistState: async () => {},
      publicStateForSse: () => ({}),
      sseClients,
      DATA_DIR: tmp,
      ROOT: process.cwd(),
      RUNS_DIR: tmp,
      STATE_FILE: path.join(tmp, 'state.json'),
      STATE_DB_FILE: path.join(tmp, 'state.db'),
      STATE_BROADCAST_DEBOUNCE_MS: 50,
      USE_SQLITE_STATE: false,
      WRITE_STATE_JSON: false,
      SQLITE_BACKED_STATE_KEYS: [],
    });
    Object.assign(core.state, structuredClone(state));
    const agent = core.state.agents[0];
    const human = core.state.humans[0];
    agent.status = 'idle';
    human.status = 'online';
    human.lastSeenAt = new Date().toISOString();
    human.presenceUpdatedAt = human.lastSeenAt;
    const clients = Array.from({ length: 100 }, () => ({
      magclawRequest: { magclawPresenceWorkspaceId: 'local' },
      writes: [],
      write(packet) {
        this.writes.push(packet);
        return true;
      },
      once() {},
    }));
    for (const client of clients) sseClients.add(client);

    for (const client of clients) {
      core.writePresenceHeartbeat(client, client.magclawRequest, { seedOnly: true });
    }
    agent.status = 'working';
    agent.activitySeq = Number(agent.activitySeq || 0) + 1;
    agent.activityAt = new Date().toISOString();
    human.status = 'offline';
    human.presenceUpdatedAt = new Date().toISOString();
    core.broadcastHeartbeat();
    const packets = clients.flatMap((client) => client.writes.slice(1));
    const heartbeatPackets = packets.filter((packet) => packet.startsWith('event: heartbeat\n'));
    const heartbeats = heartbeatPackets.map((packet) => JSON.parse(packet.match(/^event: heartbeat\ndata: ([\s\S]*)\n\n$/)?.[1] || '{}'));
    const maxAgents = Math.max(0, ...heartbeats.map((heartbeat) => (heartbeat.agents || []).length));
    const maxHumans = Math.max(0, ...heartbeats.map((heartbeat) => (heartbeat.humans || []).length));

    return {
      clients: clients.length,
      totalBytes: packets.reduce((sum, packet) => sum + Buffer.byteLength(packet, 'utf8'), 0),
      heartbeatEvents: heartbeatPackets.length,
      maxAgents,
      maxHumans,
      fullPayloadEvents: heartbeats.filter((heartbeat) => (
        (heartbeat.agents || []).length > 2 || (heartbeat.humans || []).length > 2
      )).length,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function measureStateChangeFanout(state) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-perf-scalability-state-change-'));
  const sseClients = new Set();
  try {
    const core = createStateCore({
      addSystemEvent: () => {},
      broadcastState: () => {},
      fanoutApiConfigured: () => false,
      getState: () => state,
      httpError: (status, message) => Object.assign(new Error(message), { status }),
      makeId: (prefix) => `${prefix}_synthetic`,
      now: () => NOW,
      persistState: async () => {},
      publicStateForSse: () => ({}),
      sseClients,
      DATA_DIR: tmp,
      ROOT: process.cwd(),
      RUNS_DIR: tmp,
      STATE_FILE: path.join(tmp, 'state.json'),
      STATE_DB_FILE: path.join(tmp, 'state.db'),
      STATE_BROADCAST_DEBOUNCE_MS: 0,
      USE_SQLITE_STATE: false,
      WRITE_STATE_JSON: false,
      SQLITE_BACKED_STATE_KEYS: [],
    });
    Object.assign(core.state, state);
    core.state.cloud = {
      schemaVersion: 1,
      workspaces: [{ id: 'local', slug: 'local', name: 'MagClaw', createdAt: NOW }],
      workspaceMembers: [],
      users: [],
      sessions: [],
      invitations: [],
      pairingTokens: [],
      computerTokens: [],
      agentDeliveries: [],
      daemonEvents: [],
      realtimeEvents: [],
    };
    const clients = Array.from({ length: 100 }, () => ({
      magclawRequest: {
        url: '/api/events?spaceType=channel&spaceId=chan_all',
        magclawPresenceWorkspaceId: 'local',
      },
      writes: [],
      write(packet) {
        this.writes.push(packet);
        return true;
      },
      once() {},
    }));
    for (const client of clients) sseClients.add(client);

    const agent = core.state.agents[0];
    for (let index = 0; index < 10; index += 1) {
      core.setAgentStatus(agent, index % 2 === 0 ? 'working' : 'thinking', 'perf_state_change', { forceEvent: true });
      core.broadcastState({ immediate: true, skipCloudPush: true, realtimeOnly: true });
    }
    core.flushRealtimeBroadcasts();

    const packets = clients.flatMap((client) => client.writes);
    const heartbeatPackets = packets.filter((packet) => packet.startsWith('event: heartbeat\n'));
    const realtimePackets = packets.filter((packet) => packet.startsWith('event: realtime-event\n'));
    const realtimeEnvelopes = realtimePackets.map((packet) => JSON.parse(packet.match(/^event: realtime-event\ndata: ([\s\S]*)\n\n$/)?.[1] || '{}'));
    return {
      clients: clients.length,
      statusChanges: 10,
      totalBytes: packets.reduce((sum, packet) => sum + Buffer.byteLength(packet, 'utf8'), 0),
      packets: packets.length,
      realtimeEvents: realtimePackets.length,
      maxEntries: Math.max(0, ...realtimeEnvelopes.map((envelope) => (envelope.payload?.entries || []).length)),
      maxCoalescedCount: Math.max(0, ...realtimeEnvelopes.map((envelope) => Number(envelope.coalescedCount || 0))),
      minSeqStart: Math.min(...realtimeEnvelopes.map((envelope) => Number(envelope.seqStart || 0))),
      maxSeq: Math.max(0, ...realtimeEnvelopes.map((envelope) => Number(envelope.seq || 0))),
      stateResyncEvents: packets.filter((packet) => packet.startsWith('event: state-resync-required\n')).length,
      heartbeatEvents: heartbeatPackets.length,
      heartbeatBytes: heartbeatPackets.reduce((sum, packet) => sum + Buffer.byteLength(packet, 'utf8'), 0),
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function main() {
  const state = makeSyntheticState();
  const services = makeSystemServices(state);
  const started = performance.now();
  const snapshot = services.publicBootstrapState({
    url: '/api/bootstrap?spaceType=channel&spaceId=chan_all&messageLimit=80&threadRootLimit=160',
    headers: {},
  });
  const body = JSON.stringify(snapshot);
  const bootstrap = {
    ms: Math.round(performance.now() - started),
    bytes: Buffer.byteLength(body, 'utf8'),
    messages: snapshot.messages.length,
    replies: snapshot.replies.length,
    tasks: snapshot.tasks.length,
    taskHydration: snapshot.bootstrap?.tasks || null,
    agents: snapshot.agents.length,
    humans: snapshot.humans.length,
    unreadHydration: snapshot.bootstrap?.unreadHydration || null,
    hasBootstrapMemberChurnFields: snapshot.agents.some((agent) => agent.workspaceId || agent.role || agent.statusUpdatedAt || agent.heartbeatAt || agent.updatedAt)
      || snapshot.humans.some((human) => human.workspaceId || human.lastSeenAt || human.presenceUpdatedAt || human.updatedAt),
    hasInternalFields: body.includes('externalImport')
      || body.includes('startupCollaboration')
      || body.includes('promptCache')
      || body.includes('runtimeSession')
      || body.includes('sourceAnchor'),
  };
  const heartbeat = await measureHeartbeat(state);
  const repeatedHeartbeat = await measureRepeatedHeartbeatFanout(state);
  const humanHeartbeatChurn = await measureHumanHeartbeatChurnFanout(state);
  const presenceMemberDelta = await measurePresenceMemberDeltaFanout(state);
  const stateChangeFanout = await measureStateChangeFanout(state);

  assertBudget(bootstrap.ms <= BUDGETS.bootstrapMs, `bootstrap ${bootstrap.ms}ms exceeds ${BUDGETS.bootstrapMs}ms`);
  assertBudget(bootstrap.bytes <= BUDGETS.bootstrapBytes, `bootstrap ${bootstrap.bytes} bytes exceeds ${BUDGETS.bootstrapBytes}`);
  assertBudget(!bootstrap.hasInternalFields, 'bootstrap leaked internal payload fields');
  assertBudget(!bootstrap.hasBootstrapMemberChurnFields, 'bootstrap leaked member churn fields');
  assertBudget(bootstrap.tasks <= BUDGETS.bootstrapTasks, `bootstrap ${bootstrap.tasks} tasks exceeds ${BUDGETS.bootstrapTasks}`);
  assertBudget(bootstrap.taskHydration?.space?.hasMore === true, 'bootstrap task hydration did not expose selected-space pagination');
  assertBudget(bootstrap.taskHydration?.global?.hasMore === true, 'bootstrap task hydration did not expose global pagination');
  assertBudget(bootstrap.unreadHydration?.included <= BUDGETS.unreadHydrationRecords, 'bootstrap unread hydration is unbounded');
  assertBudget(heartbeat.ms <= BUDGETS.heartbeatMs, `heartbeat ${heartbeat.ms}ms exceeds ${BUDGETS.heartbeatMs}ms`);
  assertBudget(heartbeat.bytes <= BUDGETS.heartbeatBytes, `heartbeat ${heartbeat.bytes} bytes exceeds ${BUDGETS.heartbeatBytes}`);
  assertBudget(!heartbeat.hasInternalFields, 'heartbeat leaked internal payload fields');
  assertBudget(repeatedHeartbeat.deferredOpenBytes <= BUDGETS.deferredOpenBytes, `deferred SSE open ${repeatedHeartbeat.deferredOpenBytes} bytes exceeds ${BUDGETS.deferredOpenBytes}`);
  assertBudget(repeatedHeartbeat.deferredOpenHeartbeatEvents === 0, 'deferred SSE open sent heartbeat payload events');
  assertBudget(repeatedHeartbeat.repeatedBytes <= BUDGETS.repeatedHeartbeatBytes, `repeated heartbeat fanout ${repeatedHeartbeat.repeatedBytes} bytes exceeds ${BUDGETS.repeatedHeartbeatBytes}`);
  assertBudget(repeatedHeartbeat.repeatedHeartbeatEvents === 0, 'unchanged repeated heartbeat sent payload events');
  assertBudget(humanHeartbeatChurn.totalBytes <= BUDGETS.humanHeartbeatChurnBytes, `human timestamp heartbeat churn ${humanHeartbeatChurn.totalBytes} bytes exceeds ${BUDGETS.humanHeartbeatChurnBytes}`);
  assertBudget(humanHeartbeatChurn.heartbeatEvents === 0, 'human timestamp heartbeat churn sent payload events');
  assertBudget(presenceMemberDelta.totalBytes <= BUDGETS.presenceMemberDeltaBytes, `presence member delta fanout ${presenceMemberDelta.totalBytes} bytes exceeds ${BUDGETS.presenceMemberDeltaBytes}`);
  assertBudget(presenceMemberDelta.heartbeatEvents === presenceMemberDelta.clients, 'presence member delta did not notify each SSE client');
  assertBudget(presenceMemberDelta.maxAgents <= 1, 'presence member delta sent unchanged agents');
  assertBudget(presenceMemberDelta.maxHumans <= 1, 'presence member delta sent unchanged humans');
  assertBudget(presenceMemberDelta.fullPayloadEvents === 0, 'presence member delta sent full member payloads');
  assertBudget(stateChangeFanout.totalBytes <= BUDGETS.stateChangeFanoutBytes, `state change fanout ${stateChangeFanout.totalBytes} bytes exceeds ${BUDGETS.stateChangeFanoutBytes}`);
  assertBudget(stateChangeFanout.totalBytes <= BUDGETS.stateChangeFanoutBytesCoalesced, `coalesced state change fanout ${stateChangeFanout.totalBytes} bytes exceeds ${BUDGETS.stateChangeFanoutBytesCoalesced}`);
  assertBudget(stateChangeFanout.realtimeEvents <= BUDGETS.stateChangeFanoutEvents, `state change fanout ${stateChangeFanout.realtimeEvents} realtime events exceeds ${BUDGETS.stateChangeFanoutEvents}`);
  assertBudget(stateChangeFanout.realtimeEvents === stateChangeFanout.clients, 'state change fanout did not coalesce to one realtime event per client');
  assertBudget(stateChangeFanout.maxEntries === stateChangeFanout.statusChanges, 'state change fanout dropped coalesced activity entries');
  assertBudget(stateChangeFanout.maxCoalescedCount === stateChangeFanout.statusChanges, 'state change fanout did not report the full coalesced count');
  assertBudget(stateChangeFanout.minSeqStart === 1 && stateChangeFanout.maxSeq === stateChangeFanout.statusChanges, 'state change fanout did not preserve a continuous sequence range');
  assertBudget(stateChangeFanout.stateResyncEvents === 0, 'status-only state change fanout sent resync events');
  assertBudget(stateChangeFanout.heartbeatEvents === 0, 'state change fanout sent heartbeat payload events');
  assertBudget(stateChangeFanout.heartbeatBytes === 0, 'state change fanout sent heartbeat payload bytes');

  console.log(JSON.stringify({ ok: true, budgets: BUDGETS, bootstrap, heartbeat, repeatedHeartbeat, humanHeartbeatChurn, presenceMemberDelta, stateChangeFanout }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
