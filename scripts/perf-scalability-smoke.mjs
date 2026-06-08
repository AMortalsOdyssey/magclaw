import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createStateCore } from '../server/state-core.js';
import { createSystemServices } from '../server/system-services.js';

const NOW = '2026-06-08T00:00:00.000Z';
const BUDGETS = Object.freeze({
  bootstrapBytes: Number(process.env.MAGCLAW_PERF_BOOTSTRAP_BYTES || 1_500_000),
  bootstrapMs: Number(process.env.MAGCLAW_PERF_BOOTSTRAP_MS || 250),
  heartbeatBytes: Number(process.env.MAGCLAW_PERF_HEARTBEAT_BYTES || 400_000),
  heartbeatMs: Number(process.env.MAGCLAW_PERF_HEARTBEAT_MS || 50),
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
    hasInternalFields: body.includes('externalImport')
      || body.includes('startupCollaboration')
      || body.includes('promptCache')
      || body.includes('runtimeSession')
      || body.includes('sourceAnchor'),
  };
  const heartbeat = await measureHeartbeat(state);

  assertBudget(bootstrap.ms <= BUDGETS.bootstrapMs, `bootstrap ${bootstrap.ms}ms exceeds ${BUDGETS.bootstrapMs}ms`);
  assertBudget(bootstrap.bytes <= BUDGETS.bootstrapBytes, `bootstrap ${bootstrap.bytes} bytes exceeds ${BUDGETS.bootstrapBytes}`);
  assertBudget(!bootstrap.hasInternalFields, 'bootstrap leaked internal payload fields');
  assertBudget(bootstrap.tasks <= BUDGETS.bootstrapTasks, `bootstrap ${bootstrap.tasks} tasks exceeds ${BUDGETS.bootstrapTasks}`);
  assertBudget(bootstrap.taskHydration?.space?.hasMore === true, 'bootstrap task hydration did not expose selected-space pagination');
  assertBudget(bootstrap.taskHydration?.global?.hasMore === true, 'bootstrap task hydration did not expose global pagination');
  assertBudget(bootstrap.unreadHydration?.included <= BUDGETS.unreadHydrationRecords, 'bootstrap unread hydration is unbounded');
  assertBudget(heartbeat.ms <= BUDGETS.heartbeatMs, `heartbeat ${heartbeat.ms}ms exceeds ${BUDGETS.heartbeatMs}ms`);
  assertBudget(heartbeat.bytes <= BUDGETS.heartbeatBytes, `heartbeat ${heartbeat.bytes} bytes exceeds ${BUDGETS.heartbeatBytes}`);
  assertBudget(!heartbeat.hasInternalFields, 'heartbeat leaked internal payload fields');

  console.log(JSON.stringify({ ok: true, budgets: BUDGETS, bootstrap, heartbeat }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
