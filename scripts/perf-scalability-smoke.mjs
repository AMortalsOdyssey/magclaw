import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createStateCore } from '../server/state-core.js';
import { createSystemServices } from '../server/system-services.js';

const NOW = '2026-06-08T00:00:00.000Z';
const BOOTSTRAP_DIRECTORY_FORMAT = 'tuple-v1';
const BOOTSTRAP_CONVERSATION_FORMAT = 'tuple-v1';
const BOOTSTRAP_DIRECTORY_SCOPE = 'visible';
const BOOTSTRAP_QUERY = 'spaceType=channel&spaceId=chan_all&messageLimit=80&threadRootLimit=160&directoryFormat=tuple-v1&conversationFormat=tuple-v1&directoryScope=visible';
const DIRECTORY_PAGE_LIMIT = 250;
const BOOTSTRAP_AGENT_TUPLE_FIELDS = Object.freeze([
  'id',
  'name',
  'description',
  'status',
  'runtime',
  'model',
  'createdAt',
  'activeWorkItemIds',
  'avatar',
  'previousStatus',
  'runtimeId',
  'reasoningEffort',
  'computerId',
  'workspace',
  'envVars',
  'createdBy',
  'createdByHumanId',
  'ownerHumanId',
  'createdByUserId',
  'creatorName',
  'creatorEmail',
  'runtimeLastStartedAt',
  'runtimeLastTurnAt',
  'runtimeWarmAt',
  'runtimeActivity',
  'activitySeq',
  'activityAt',
  'disabledAt',
  'disabledByServerDeletedAt',
  'deletedAt',
  'archivedAt',
]);
const BOOTSTRAP_HUMAN_TUPLE_FIELDS = Object.freeze([
  'id',
  'name',
  'role',
  'status',
  'createdAt',
  'email',
  'avatar',
  'avatarUrl',
  'authUserId',
  'userId',
  'identityReference',
]);
const BOOTSTRAP_CLOUD_MEMBER_TUPLE_FIELDS = Object.freeze([
  'id',
  'userId',
  'humanId',
  'user',
  'role',
]);
const BOOTSTRAP_MESSAGE_TUPLE_FIELDS = Object.freeze([
  'id',
  'spaceType',
  'spaceId',
  'authorType',
  'authorId',
  'body',
  'readBy',
  'replyCount',
  'createdAt',
  'updatedAt',
  'taskId',
  'savedBy',
  'metadata',
  'eventType',
  'bodyTruncated',
]);
const BOOTSTRAP_REPLY_TUPLE_FIELDS = Object.freeze([
  'id',
  'parentMessageId',
  'spaceType',
  'spaceId',
  'authorType',
  'authorId',
  'body',
  'readBy',
  'createdAt',
  'updatedAt',
  'savedBy',
  'metadata',
  'eventType',
  'bodyTruncated',
]);
const BOOTSTRAP_TASK_TUPLE_FIELDS = Object.freeze([
  'id',
  'spaceType',
  'spaceId',
  'title',
  'status',
  'createdAt',
  'updatedAt',
  'messageId',
  'claimedBy',
  'assigneeId',
  'assigneeIds',
  'createdBy',
  'metadata',
]);
const BUDGETS = Object.freeze({
  bootstrapBytes: Number(process.env.MAGCLAW_PERF_BOOTSTRAP_BYTES || 220_000),
  bootstrapMs: Number(process.env.MAGCLAW_PERF_BOOTSTRAP_MS || 80),
  directoryPageBytes: Number(process.env.MAGCLAW_PERF_DIRECTORY_PAGE_BYTES || 80_000),
  directoryPageMs: Number(process.env.MAGCLAW_PERF_DIRECTORY_PAGE_MS || 250),
  directoryTotalBytes: Number(process.env.MAGCLAW_PERF_DIRECTORY_TOTAL_BYTES || 280_000),
  directoryPages: Number(process.env.MAGCLAW_PERF_DIRECTORY_PAGES || 4),
  directoryLargePageBytes: Number(process.env.MAGCLAW_PERF_DIRECTORY_LARGE_PAGE_BYTES || 80_000),
  directoryLargePageMs: Number(process.env.MAGCLAW_PERF_DIRECTORY_LARGE_PAGE_MS || 120),
  directorySearchBytes: Number(process.env.MAGCLAW_PERF_DIRECTORY_SEARCH_BYTES || 20_000),
  directorySearchMs: Number(process.env.MAGCLAW_PERF_DIRECTORY_SEARCH_MS || 250),
  directoryBroadSearchBytes: Number(process.env.MAGCLAW_PERF_DIRECTORY_BROAD_SEARCH_BYTES || 20_000),
  directoryBroadSearchMs: Number(process.env.MAGCLAW_PERF_DIRECTORY_BROAD_SEARCH_MS || 250),
  membersDirectoryPageBytes: Number(process.env.MAGCLAW_PERF_MEMBERS_DIRECTORY_PAGE_BYTES || 35_000),
  membersDirectoryPageMs: Number(process.env.MAGCLAW_PERF_MEMBERS_DIRECTORY_PAGE_MS || 250),
  membersRailRows: Number(process.env.MAGCLAW_PERF_MEMBERS_RAIL_ROWS || 170),
  membersRailModelMs: Number(process.env.MAGCLAW_PERF_MEMBERS_RAIL_MODEL_MS || 50),
  heartbeatBytes: Number(process.env.MAGCLAW_PERF_HEARTBEAT_BYTES || 50_000),
  heartbeatMs: Number(process.env.MAGCLAW_PERF_HEARTBEAT_MS || 50),
  deferredOpenBytes: Number(process.env.MAGCLAW_PERF_DEFERRED_OPEN_BYTES || 10_000),
  deferredHeartbeatFullSerializations: Number(process.env.MAGCLAW_PERF_DEFERRED_HEARTBEAT_FULL_SERIALIZATIONS || 0),
  repeatedHeartbeatBytes: Number(process.env.MAGCLAW_PERF_REPEATED_HEARTBEAT_BYTES || 10_000),
  humanHeartbeatChurnBytes: Number(process.env.MAGCLAW_PERF_HUMAN_HEARTBEAT_CHURN_BYTES || 10_000),
  presenceMemberDeltaBytes: Number(process.env.MAGCLAW_PERF_PRESENCE_MEMBER_DELTA_BYTES || 25_000),
  stateChangeFanoutBytes: Number(process.env.MAGCLAW_PERF_STATE_CHANGE_FANOUT_BYTES || 700_000),
  stateChangeFanoutBytesCoalesced: Number(process.env.MAGCLAW_PERF_STATE_CHANGE_FANOUT_COALESCED_BYTES || 90_000),
  stateChangeFanoutEvents: Number(process.env.MAGCLAW_PERF_STATE_CHANGE_FANOUT_EVENTS || 100),
  conversationRecordFanoutBytes: Number(process.env.MAGCLAW_PERF_CONVERSATION_RECORD_FANOUT_BYTES || 80_000),
  conversationRecordFanoutEvents: Number(process.env.MAGCLAW_PERF_CONVERSATION_RECORD_FANOUT_EVENTS || 100),
  unreadCountsFanoutBytes: Number(process.env.MAGCLAW_PERF_UNREAD_COUNTS_FANOUT_BYTES || 80_000),
  unreadCountsFanoutEvents: Number(process.env.MAGCLAW_PERF_UNREAD_COUNTS_FANOUT_EVENTS || 100),
  bootstrapProjectedConversationReads: Number(process.env.MAGCLAW_PERF_BOOTSTRAP_PROJECTED_CONVERSATION_READS || 500),
  unreadHydrationRecords: Number(process.env.MAGCLAW_PERF_UNREAD_RECORDS || 80),
  bootstrapTasks: Number(process.env.MAGCLAW_PERF_BOOTSTRAP_TASKS || 200),
  bootstrapLargeHistoryMs: Number(process.env.MAGCLAW_PERF_BOOTSTRAP_LARGE_HISTORY_MS || 120),
  bootstrapLargeHistoryBytes: Number(process.env.MAGCLAW_PERF_BOOTSTRAP_LARGE_HISTORY_BYTES || 80_000),
  bootstrapLargeUnreadMs: Number(process.env.MAGCLAW_PERF_BOOTSTRAP_LARGE_UNREAD_MS || 120),
  bootstrapLargeUnreadBytes: Number(process.env.MAGCLAW_PERF_BOOTSTRAP_LARGE_UNREAD_BYTES || 60_000),
});

function assertBudget(condition, message) {
  if (condition) return;
  throw new Error(message);
}

function usefulValue(value) {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value) && value.length === 0) return false;
  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return false;
  return true;
}

function tupleRecordToObject(entry, fields = []) {
  if (!Array.isArray(entry)) return entry && typeof entry === 'object' ? entry : {};
  const record = {};
  fields.forEach((field, index) => {
    const value = entry[index];
    if (usefulValue(value)) record[field] = value;
  });
  const extra = entry[fields.length];
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) Object.assign(record, extra);
  return record;
}

function decodeTupleRecords(entries = [], fields = []) {
  return (entries || []).map((entry) => tupleRecordToObject(entry, fields));
}

function directoryPagePath(cursor = '') {
  const params = new URLSearchParams();
  params.set('directoryFormat', BOOTSTRAP_DIRECTORY_FORMAT);
  params.set('limit', String(DIRECTORY_PAGE_LIMIT));
  if (cursor) params.set('cursor', cursor);
  return `/api/directory?${params.toString()}`;
}

function measureDirectoryHydration(services) {
  let cursor = '';
  const seenCursors = new Set();
  const pages = [];
  const allAgents = [];
  const allHumans = [];
  const allMembers = [];
  let totalBytes = 0;
  let totalMs = 0;
  let hasDirectoryTuples = true;
  let hasInternalFields = false;
  let lastPage = null;
  for (let index = 0; index < 20; index += 1) {
    const started = performance.now();
    const snapshot = services.publicDirectoryState({
      url: directoryPagePath(cursor),
      headers: {},
    });
    const body = JSON.stringify(snapshot);
    const ms = Math.round(performance.now() - started);
    const bytes = Buffer.byteLength(body, 'utf8');
    const decodedAgents = decodeTupleRecords(snapshot.agents, BOOTSTRAP_AGENT_TUPLE_FIELDS);
    const decodedHumans = decodeTupleRecords(snapshot.humans, BOOTSTRAP_HUMAN_TUPLE_FIELDS);
    const decodedMembers = decodeTupleRecords(snapshot.cloud?.members || [], BOOTSTRAP_CLOUD_MEMBER_TUPLE_FIELDS);
    allAgents.push(...decodedAgents);
    allHumans.push(...decodedHumans);
    allMembers.push(...decodedMembers);
    totalBytes += bytes;
    totalMs += ms;
    hasDirectoryTuples = hasDirectoryTuples
      && (snapshot.agents || []).some(Array.isArray)
      && (snapshot.humans || []).some(Array.isArray)
      && (snapshot.cloud?.members || []).some(Array.isArray);
    hasInternalFields = hasInternalFields
      || body.includes('promptCache')
      || body.includes('runtimeSession');
    const page = snapshot.bootstrap?.directory?.page || {};
    lastPage = page;
    pages.push({
      ms,
      bytes,
      cursor: page.cursor || '',
      nextCursor: page.nextCursor || '',
      hasMore: Boolean(page.hasMore),
      agents: snapshot.agents.length,
      humans: snapshot.humans.length,
      cloudMembers: snapshot.cloud?.members?.length || 0,
      scope: snapshot.bootstrap?.directory?.scope || '',
    });
    if (!page.hasMore || !page.nextCursor) break;
    if (seenCursors.has(page.nextCursor)) throw new Error(`directory cursor loop at ${page.nextCursor}`);
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  return {
    pages,
    totalMs,
    totalBytes,
    maxPageMs: Math.max(0, ...pages.map((page) => page.ms)),
    maxPageBytes: Math.max(0, ...pages.map((page) => page.bytes)),
    pageLimit: DIRECTORY_PAGE_LIMIT,
    directoryFormat: BOOTSTRAP_DIRECTORY_FORMAT,
    directoryScope: 'paged',
    agents: allAgents.length,
    humans: allHumans.length,
    cloudMembers: allMembers.length,
    hasMoreAfterLastPage: Boolean(lastPage?.hasMore),
    hasDirectoryTuples,
    hasCloudMemberDuplication: allMembers.some((member) => (
      member.human
      || member.workspaceId
      || member.updatedAt
      || member.createdAt
      || member.status === 'active'
      || member.role === 'member'
      || member.user?.id
      || member.user?.name
    )),
    hasMemberChurnFields: allAgents.some((agent) => agent.workspaceId || agent.role || agent.statusUpdatedAt || agent.heartbeatAt || agent.updatedAt)
      || allHumans.some((human) => human.workspaceId || human.lastSeenAt || human.presenceUpdatedAt || human.updatedAt),
    hasInternalFields,
  };
}

function measureLargeDirectoryPage() {
  const sourceState = makeSyntheticState({
    humans: 10_000,
    agents: 10_000,
    messages: 0,
    replies: 0,
    tasks: 0,
  });
  const services = makeSystemServices(sourceState);
  const started = performance.now();
  const snapshot = services.publicDirectoryState({
    url: directoryPagePath(''),
    headers: {},
  });
  const body = JSON.stringify(snapshot);
  const decodedAgents = decodeTupleRecords(snapshot.agents, BOOTSTRAP_AGENT_TUPLE_FIELDS);
  const decodedHumans = decodeTupleRecords(snapshot.humans, BOOTSTRAP_HUMAN_TUPLE_FIELDS);
  const decodedMembers = decodeTupleRecords(snapshot.cloud?.members || [], BOOTSTRAP_CLOUD_MEMBER_TUPLE_FIELDS);
  return {
    ms: Math.round(performance.now() - started),
    bytes: Buffer.byteLength(body, 'utf8'),
    sourceAgents: sourceState.agents.length,
    sourceHumans: sourceState.humans.length,
    agents: snapshot.agents.length,
    humans: snapshot.humans.length,
    cloudMembers: snapshot.cloud?.members?.length || 0,
    agentTotal: snapshot.bootstrap?.directory?.agents?.total || 0,
    humanTotal: snapshot.bootstrap?.directory?.humans?.total || 0,
    memberTotal: snapshot.bootstrap?.directory?.members?.total || 0,
    nextCursor: snapshot.bootstrap?.directory?.page?.nextCursor || '',
    hasMore: Boolean(snapshot.bootstrap?.directory?.page?.hasMore),
    hasDirectoryTuples: (snapshot.agents || []).some(Array.isArray)
      && (snapshot.humans || []).some(Array.isArray)
      && (snapshot.cloud?.members || []).some(Array.isArray),
    hasInternalFields: body.includes('promptCache')
      || body.includes('runtimeSession'),
    hasCloudMemberDuplication: decodedMembers.some((member) => (
      member.human
      || member.workspaceId
      || member.updatedAt
      || member.createdAt
      || member.status === 'active'
      || member.role === 'member'
      || member.user?.id
      || member.user?.name
    )),
    hasMemberChurnFields: decodedAgents.some((agent) => agent.workspaceId || agent.role || agent.statusUpdatedAt || agent.heartbeatAt || agent.updatedAt)
      || decodedHumans.some((human) => human.workspaceId || human.lastSeenAt || human.presenceUpdatedAt || human.updatedAt),
  };
}

function measureDirectorySearch({ query = '9999', limit = 5 } = {}) {
  const sourceState = makeSyntheticState({
    humans: 10_000,
    agents: 10_000,
    messages: 0,
    replies: 0,
    tasks: 0,
  });
  const services = makeSystemServices(sourceState);
  const started = performance.now();
  const snapshot = services.publicDirectorySearchState({
    url: `/api/directory/search?directoryFormat=tuple-v1&query=${encodeURIComponent(query)}&limit=${limit}`,
    headers: {},
  });
  const body = JSON.stringify(snapshot);
  const decodedAgents = decodeTupleRecords(snapshot.agents, BOOTSTRAP_AGENT_TUPLE_FIELDS);
  const decodedHumans = decodeTupleRecords(snapshot.humans, BOOTSTRAP_HUMAN_TUPLE_FIELDS);
  const decodedMembers = decodeTupleRecords(snapshot.cloud?.members || [], BOOTSTRAP_CLOUD_MEMBER_TUPLE_FIELDS);
  return {
    ms: Math.round(performance.now() - started),
    bytes: Buffer.byteLength(body, 'utf8'),
    sourceAgents: sourceState.agents.length,
    sourceHumans: sourceState.humans.length,
    mode: snapshot.bootstrap?.mode || '',
    directoryFormat: snapshot.bootstrap?.directoryFormat || '',
    directoryScope: snapshot.bootstrap?.directory?.scope || '',
    query: snapshot.bootstrap?.directorySearch?.query || '',
    limit: snapshot.bootstrap?.directorySearch?.limit || 0,
    agents: snapshot.agents.length,
    humans: snapshot.humans.length,
    cloudMembers: snapshot.cloud?.members?.length || 0,
    agentIds: decodedAgents.map((agent) => agent.id),
    humanIds: decodedHumans.map((human) => human.id),
    memberIds: decodedMembers.map((member) => member.id),
    agentTotal: snapshot.bootstrap?.directory?.agents?.total || 0,
    humanTotal: snapshot.bootstrap?.directory?.humans?.total || 0,
    memberTotal: snapshot.bootstrap?.directory?.members?.total || 0,
    hasDirectoryTuples: (snapshot.agents || []).some(Array.isArray)
      && (snapshot.humans || []).some(Array.isArray)
      && (snapshot.cloud?.members || []).some(Array.isArray),
    hasAgentTuples: snapshot.agents.length === 0 || (snapshot.agents || []).some(Array.isArray),
    hasHumanTuples: snapshot.humans.length === 0 || (snapshot.humans || []).some(Array.isArray),
    hasMemberTuples: (snapshot.cloud?.members || []).length === 0 || (snapshot.cloud?.members || []).some(Array.isArray),
    hasInternalFields: body.includes('promptCache')
      || body.includes('runtimeSession')
      || body.includes('sourceAnchor'),
    hasCloudMemberDuplication: decodedMembers.some((member) => (
      member.human
      || member.workspaceId
      || member.updatedAt
      || member.createdAt
      || member.status === 'active'
      || member.role === 'member'
      || member.user?.id
      || member.user?.name
    )),
  };
}

function measureMembersDirectoryPage() {
  const sourceState = makeSyntheticState({
    humans: 10_000,
    agents: 0,
    messages: 0,
    replies: 0,
    tasks: 0,
  });
  const services = makeSystemServices(sourceState);
  const started = performance.now();
  const snapshot = services.publicMembersDirectoryState({
    url: '/api/members/directory?page=100&pageSize=50',
    headers: {},
  });
  const body = JSON.stringify(snapshot);
  return {
    ms: Math.round(performance.now() - started),
    bytes: Buffer.byteLength(body, 'utf8'),
    sourceHumans: sourceState.humans.length,
    mode: snapshot.mode || '',
    page: snapshot.page || 0,
    pageSize: snapshot.pageSize || 0,
    total: snapshot.total || 0,
    totalPages: snapshot.totalPages || 0,
    rows: snapshot.rows?.length || 0,
    firstMemberId: snapshot.rows?.[0]?.member?.id || '',
    lastMemberId: snapshot.rows?.[snapshot.rows.length - 1]?.member?.id || '',
    hasOffPageFirstMember: body.includes('mem_0000'),
    hasOffPageLastMember: body.includes('mem_9999'),
    hasInternalFields: body.includes('promptCache')
      || body.includes('runtimeSession')
      || body.includes('sourceAnchor')
      || body.includes('tokenHash')
      || body.includes('passwordHash'),
  };
}

async function measureMembersRailWindow() {
  const source = await readFile(path.join(process.cwd(), 'public', 'app', 'render-shell-rail-inbox.js'), 'utf8');
  const start = source.indexOf('function membersRailQueryValue');
  const end = source.indexOf('function renderMembersRailSearch');
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('members rail model source slice not found');
  }
  const agents = Array.from({ length: 10_000 }, (_, index) => ({
    id: `agt_${String(index).padStart(4, '0')}`,
    name: `Agent ${index}`,
    status: 'idle',
    runtime: 'codex',
  }));
  const humans = Array.from({ length: 10_000 }, (_, index) => ({
    id: `hum_${String(index).padStart(4, '0')}`,
    name: `Human ${index}`,
    email: `human${index}@example.test`,
    status: 'offline',
  }));
  const context = {
    MEMBERS_RAIL_WINDOW_SIZE: 80,
    membersRailSearchQuery: '',
    membersRailAgentLimit: 80,
    membersRailHumanLimit: 80,
    membersRailSearchState: { status: 'idle', query: '', total: 0, error: '' },
    selectedAgentId: 'agt_9999',
    selectedHumanId: 'hum_9999',
    appState: {
      bootstrap: {
        directory: {
          agents: { loaded: agents.length, total: agents.length, hasMore: false },
          humans: { loaded: humans.length, total: humans.length, hasMore: false },
          members: { loaded: humans.length, total: humans.length, hasMore: false },
        },
      },
    },
    humansByJoinOrder: () => humans,
  };
  const helpers = vm.runInNewContext(`${source.slice(start, end)}; ({ membersRailModel });`, context);
  const started = performance.now();
  const model = helpers.membersRailModel(agents);
  return {
    ms: Math.round(performance.now() - started),
    sourceAgents: agents.length,
    sourceHumans: humans.length,
    visibleAgents: model.visibleAgents.length,
    visibleHumans: model.visibleHumans.length,
    visibleRows: model.visibleAgents.length + model.visibleHumans.length,
    includesSelectedAgent: model.visibleAgents.some((agent) => agent.id === 'agt_9999'),
    includesSelectedHuman: model.visibleHumans.some((human) => human.id === 'hum_9999'),
    agentCount: model.agents.length,
    humanCount: model.humans.length,
  };
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
      locked: true,
      defaultChannel: true,
      memberIds: [],
      humanIds: [],
      agentIds: [],
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
    state.channels[0].memberIds.push(id);
    state.channels[0].humanIds.push(id);
  }

  for (let index = 0; index < agents; index += 1) {
    const id = `agt_${String(index).padStart(4, '0')}`;
    state.agents.push({
      id,
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
    state.channels[0].memberIds.push(id);
    state.channels[0].agentIds.push(id);
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
  const cloudMembers = (state.humans || []).map((human, index) => ({
    id: `mem_${String(index).padStart(4, '0')}`,
    workspaceId: 'local',
    userId: `usr_${String(index).padStart(4, '0')}`,
    humanId: human.id,
    role: index === 0 ? 'owner' : 'member',
    status: 'active',
    createdAt: human.createdAt || NOW,
    updatedAt: human.updatedAt || NOW,
    user: {
      id: `usr_${String(index).padStart(4, '0')}`,
      name: human.name,
      email: `human${index}@example.test`,
    },
    human: {
      ...human,
      email: `human${index}@example.test`,
    },
  }));
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
      members: cloudMembers,
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
      humanTimestampEntries: (heartbeat.humans || []).filter((entry) => (
        Array.isArray(entry)
          ? Boolean(entry[2] || entry[3])
          : Boolean(entry?.lastSeenAt || entry?.presenceUpdatedAt)
      )).length,
      hasInternalFields: body.includes('promptCache') || body.includes('runtimeSession'),
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function measureRepeatedHeartbeatFanout(state) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-perf-scalability-heartbeat-'));
  const sseClients = new Set();
  const originalStringify = JSON.stringify;
  let fullPresenceSerializations = 0;
  try {
    JSON.stringify = function patchedStringify(value, ...args) {
      if (
        value
        && typeof value === 'object'
        && Array.isArray(value.agents)
        && value.agents.length >= 100
        && Array.isArray(value.humans)
        && value.humans.length >= 100
      ) {
        fullPresenceSerializations += 1;
      }
      return originalStringify.call(this, value, ...args);
    };
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
      fullPresenceSerializations,
    };
  } finally {
    JSON.stringify = originalStringify;
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
      compactStatusEntries: realtimeEnvelopes.every((envelope) => (
        envelope.payload?.entryType === 'agent_status_changed'
        && (envelope.payload?.entries || []).every((entry) => typeof entry === 'string')
      )),
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

async function measureConversationRecordFanout(state) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-perf-scalability-conversation-record-'));
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
    Object.assign(core.state, structuredClone(state));
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
    const unrelatedClient = {
      magclawRequest: {
        url: '/api/events?spaceType=channel&spaceId=chan_other',
        magclawPresenceWorkspaceId: 'local',
      },
      writes: [],
      write(packet) {
        this.writes.push(packet);
        return true;
      },
      once() {},
    };
    for (const client of clients) sseClients.add(client);
    sseClients.add(unrelatedClient);

    const message = {
      id: 'msg_perf_realtime',
      workspaceId: 'local',
      spaceType: 'channel',
      spaceId: 'chan_all',
      authorType: 'human',
      authorId: 'hum_0000',
      body: 'A realtime conversation event should let peers patch the visible chat without a bootstrap refetch.',
      readBy: ['hum_0000'],
      replyCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
    };
    core.recordRealtimeEvent('conversation_record_changed', {
      workspaceId: message.workspaceId,
      spaceType: message.spaceType,
      spaceId: message.spaceId,
      recordId: message.id,
      parentMessageId: '',
      recordKind: 'message',
      message,
    }, {
      workspaceId: message.workspaceId,
      scopeType: message.spaceType,
      scopeId: message.spaceId,
      threadMessageId: null,
    });

    const packets = clients.flatMap((client) => client.writes);
    const unrelatedPackets = unrelatedClient.writes;
    const realtimePackets = packets.filter((packet) => packet.startsWith('event: realtime-event\n'));
    const realtimeEnvelopes = realtimePackets.map((packet) => JSON.parse(packet.match(/^event: realtime-event\ndata: ([\s\S]*)\n\n$/)?.[1] || '{}'));
    return {
      clients: clients.length,
      totalBytes: packets.reduce((sum, packet) => sum + Buffer.byteLength(packet, 'utf8'), 0),
      packets: packets.length,
      realtimeEvents: realtimePackets.length,
      eventTypes: [...new Set(realtimeEnvelopes.map((envelope) => envelope.eventType))],
      messageIds: [...new Set(realtimeEnvelopes.map((envelope) => envelope.payload?.message?.id).filter(Boolean))],
      stateResyncEvents: packets.filter((packet) => packet.startsWith('event: state-resync-required\n')).length,
      heartbeatEvents: packets.filter((packet) => packet.startsWith('event: heartbeat\n')).length,
      unrelatedPackets: unrelatedPackets.length,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function measureUnreadCountsFanout(state) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-perf-scalability-unread-counts-'));
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
    Object.assign(core.state, structuredClone(state));
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
    const otherWorkspaceClient = {
      magclawRequest: {
        url: '/api/events?spaceType=channel&spaceId=chan_all',
        magclawPresenceWorkspaceId: 'other',
      },
      writes: [],
      write(packet) {
        this.writes.push(packet);
        return true;
      },
      once() {},
    };
    for (const client of clients) sseClients.add(client);
    sseClients.add(otherWorkspaceClient);

    core.recordRealtimeEvent('unread_counts_updated', {
      workspaceId: 'local',
      targetHumanId: 'hum_0000',
      updatedAt: NOW,
    }, {
      workspaceId: 'local',
      scopeType: 'workspace',
      scopeId: 'local',
    });

    const packets = clients.flatMap((client) => client.writes);
    const otherWorkspacePackets = otherWorkspaceClient.writes;
    const realtimePackets = packets.filter((packet) => packet.startsWith('event: realtime-event\n'));
    const realtimeEnvelopes = realtimePackets.map((packet) => JSON.parse(packet.match(/^event: realtime-event\ndata: ([\s\S]*)\n\n$/)?.[1] || '{}'));
    return {
      clients: clients.length,
      totalBytes: packets.reduce((sum, packet) => sum + Buffer.byteLength(packet, 'utf8'), 0),
      packets: packets.length,
      realtimeEvents: realtimePackets.length,
      eventTypes: [...new Set(realtimeEnvelopes.map((envelope) => envelope.eventType))],
      targetHumanIds: [...new Set(realtimeEnvelopes.map((envelope) => envelope.payload?.targetHumanId).filter(Boolean))],
      stateResyncEvents: packets.filter((packet) => packet.startsWith('event: state-resync-required\n')).length,
      heartbeatEvents: packets.filter((packet) => packet.startsWith('event: heartbeat\n')).length,
      otherWorkspacePackets: otherWorkspacePackets.length,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

function measureBootstrapProjectionWindow() {
  const state = makeSyntheticState({
    humans: 10,
    agents: 10,
    messages: 10_000,
    replies: 0,
    tasks: 0,
  });
  let metadataReads = 0;
  for (const message of state.messages) {
    message.readBy = ['hum_0000'];
    const metadata = message.metadata;
    Object.defineProperty(message, 'metadata', {
      configurable: true,
      enumerable: true,
      get() {
        metadataReads += 1;
        return metadata;
      },
    });
  }
  const services = makeSystemServices(state);
  const snapshot = services.publicBootstrapState({
    url: `/api/bootstrap?${BOOTSTRAP_QUERY}`,
    headers: {},
  });
  return {
    sourceMessages: state.messages.length,
    projectedMetadataReads: metadataReads,
    messages: snapshot.messages.length,
    hasMoreMessages: Boolean(snapshot.bootstrap?.hasMoreMessages),
  };
}

function makeLargeHistoryState({ messages = 100_000, replies = 5_000 } = {}) {
  const state = {
    version: 1,
    connection: { workspaceId: 'local' },
    settings: {},
    channels: [{
      id: 'chan_all',
      workspaceId: 'local',
      name: 'all',
      locked: true,
      defaultChannel: true,
      memberIds: ['hum_0000', 'agt_0000'],
      humanIds: ['hum_0000'],
      agentIds: ['agt_0000'],
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
    agents: [{ id: 'agt_0000', workspaceId: 'local', name: 'Agent 0', status: 'idle', createdAt: NOW, updatedAt: NOW }],
    humans: [{ id: 'hum_0000', workspaceId: 'local', name: 'Human 0', status: 'online', createdAt: NOW, updatedAt: NOW }],
    computers: [],
    reminders: [],
    missions: [],
    projects: [],
    channelMemberProposals: [],
  };
  for (let index = 0; index < messages; index += 1) {
    const createdAt = timestamp(index * 1000);
    state.messages.push({
      id: `msg_${String(index).padStart(6, '0')}`,
      workspaceId: 'local',
      spaceType: 'channel',
      spaceId: 'chan_all',
      authorType: index % 2 ? 'human' : 'agent',
      authorId: index % 2 ? 'hum_0000' : 'agt_0000',
      body: `message ${index}`,
      readBy: ['hum_0000'],
      replyCount: index % 1000 === 0 ? 1 : 0,
      createdAt,
      updatedAt: createdAt,
    });
  }
  for (let index = 0; index < replies; index += 1) {
    const createdAt = timestamp((messages + index) * 1000);
    state.replies.push({
      id: `rep_${String(index).padStart(5, '0')}`,
      workspaceId: 'local',
      parentMessageId: `msg_${String(index * 20).padStart(6, '0')}`,
      spaceType: 'channel',
      spaceId: 'chan_all',
      authorType: 'agent',
      authorId: 'agt_0000',
      body: `reply ${index}`,
      readBy: ['hum_0000'],
      createdAt,
      updatedAt: createdAt,
    });
  }
  return state;
}

function measureLargeBootstrapHistory() {
  const state = makeLargeHistoryState();
  const services = makeSystemServices(state);
  const started = performance.now();
  const snapshot = services.publicBootstrapState({
    url: `/api/bootstrap?${BOOTSTRAP_QUERY}`,
    headers: {},
  });
  const body = JSON.stringify(snapshot);
  return {
    sourceMessages: state.messages.length,
    sourceReplies: state.replies.length,
    ms: Math.round(performance.now() - started),
    bytes: Buffer.byteLength(body, 'utf8'),
    messages: snapshot.messages.length,
    replies: snapshot.replies.length,
    hasMoreMessages: Boolean(snapshot.bootstrap?.hasMoreMessages),
  };
}

function makeLargeUnreadState({ messages = 100_000, replies = 5_000 } = {}) {
  const state = {
    version: 1,
    connection: { workspaceId: 'local' },
    settings: {},
    channels: [{
      id: 'chan_all',
      workspaceId: 'local',
      name: 'all',
      locked: true,
      defaultChannel: true,
      memberIds: ['hum_0000', 'agt_0000'],
      humanIds: ['hum_0000'],
      agentIds: ['agt_0000'],
      createdAt: NOW,
      updatedAt: NOW,
    }],
    dms: [{
      id: 'dm_bulk',
      workspaceId: 'local',
      participantIds: ['hum_0000', 'agt_0000'],
      createdAt: NOW,
      updatedAt: NOW,
    }],
    messages: [],
    replies: [],
    tasks: [],
    runs: [],
    workItems: [],
    events: [],
    routeEvents: [],
    systemNotifications: [],
    attachments: [],
    agents: [{ id: 'agt_0000', workspaceId: 'local', name: 'Agent 0', status: 'idle', createdAt: NOW, updatedAt: NOW }],
    humans: [{ id: 'hum_0000', workspaceId: 'local', name: 'Human 0', status: 'online', createdAt: NOW, updatedAt: NOW }],
    computers: [],
    reminders: [],
    missions: [],
    projects: [],
    channelMemberProposals: [],
  };
  for (let index = 0; index < messages; index += 1) {
    const createdAt = timestamp(index * 1000);
    state.messages.push({
      id: `msg_unread_${String(index).padStart(6, '0')}`,
      workspaceId: 'local',
      spaceType: 'dm',
      spaceId: 'dm_bulk',
      authorType: 'human',
      authorId: 'hum_0000',
      body: `parent ${index}`,
      readBy: ['hum_0000'],
      replyCount: 0,
      createdAt,
      updatedAt: createdAt,
    });
  }
  for (let index = 0; index < replies; index += 1) {
    const createdAt = timestamp((messages + index) * 1000);
    state.replies.push({
      id: `rep_unread_${String(index).padStart(5, '0')}`,
      workspaceId: 'local',
      parentMessageId: `msg_unread_${String(index * 20).padStart(6, '0')}`,
      spaceType: 'dm',
      spaceId: 'dm_bulk',
      authorType: 'agent',
      authorId: 'agt_0000',
      body: `unread reply ${index}`,
      readBy: [],
      createdAt,
      updatedAt: createdAt,
    });
  }
  return state;
}

function measureLargeUnreadBootstrap() {
  const state = makeLargeUnreadState();
  const services = makeSystemServices(state);
  const started = performance.now();
  const snapshot = services.publicBootstrapState({
    url: `/api/bootstrap?${BOOTSTRAP_QUERY}`,
    headers: {},
  });
  const body = JSON.stringify(snapshot);
  return {
    sourceMessages: state.messages.length,
    sourceReplies: state.replies.length,
    ms: Math.round(performance.now() - started),
    bytes: Buffer.byteLength(body, 'utf8'),
    messages: snapshot.messages.length,
    replies: snapshot.replies.length,
    unreadHydration: snapshot.bootstrap?.unreadHydration || null,
  };
}

async function main() {
  const smokeStarted = performance.now();
  const state = makeSyntheticState();
  const services = makeSystemServices(state);
  const bootstrapStarted = performance.now();
  const snapshot = services.publicBootstrapState({
    url: `/api/bootstrap?${BOOTSTRAP_QUERY}`,
    headers: {},
  });
  const bootstrapProjectedAt = performance.now();
  const body = JSON.stringify(snapshot);
  const bootstrapSerializedAt = performance.now();
  const directory = measureDirectoryHydration(services);
  const directoryLargePage = measureLargeDirectoryPage();
  const directorySearch = measureDirectorySearch();
  const directoryBroadSearch = measureDirectorySearch({ query: 'agent', limit: 5 });
  const membersDirectoryPage = measureMembersDirectoryPage();
  const membersRailWindow = await measureMembersRailWindow();
  const bootstrapAllChannel = (snapshot.channels || []).find((channel) => (
    channel?.id === 'chan_all'
    || String(channel?.name || '').trim().toLowerCase() === 'all'
  ));
  const decodedAgents = decodeTupleRecords(snapshot.agents, BOOTSTRAP_AGENT_TUPLE_FIELDS);
  const decodedHumans = decodeTupleRecords(snapshot.humans, BOOTSTRAP_HUMAN_TUPLE_FIELDS);
  const decodedCloudMembers = decodeTupleRecords(snapshot.cloud?.members || [], BOOTSTRAP_CLOUD_MEMBER_TUPLE_FIELDS);
  const decodedMessages = decodeTupleRecords(snapshot.messages, BOOTSTRAP_MESSAGE_TUPLE_FIELDS);
  const decodedReplies = decodeTupleRecords(snapshot.replies, BOOTSTRAP_REPLY_TUPLE_FIELDS);
  const decodedTasks = decodeTupleRecords(snapshot.tasks, BOOTSTRAP_TASK_TUPLE_FIELDS);
  const selectedMessagePageStart = state.messages.length - 80;
  const syntheticMessageIndex = (message) => {
    const match = String(message?.id || '').match(/^msg_(\d+)$/);
    return match ? Number(match[1]) : -1;
  };
  const previewBodyLengths = [...decodedMessages, ...decodedReplies]
    .filter((record) => record.bodyTruncated === true)
    .map((record) => String(record.body || '').length);
  const bootstrap = {
    ms: Math.round(bootstrapSerializedAt - bootstrapStarted),
    projectMs: Math.round(bootstrapProjectedAt - bootstrapStarted),
    serializeMs: Math.round(bootstrapSerializedAt - bootstrapProjectedAt),
    bytes: Buffer.byteLength(body, 'utf8'),
    directoryFormat: snapshot.bootstrap?.directoryFormat || '',
    conversationFormat: snapshot.bootstrap?.conversationFormat || '',
    directoryScope: snapshot.bootstrap?.directory?.scope || '',
    directory: snapshot.bootstrap?.directory || null,
    hasBootstrapDirectoryTuples: (snapshot.agents || []).some(Array.isArray)
      && (snapshot.humans || []).some(Array.isArray)
      && (snapshot.cloud?.members || []).some(Array.isArray),
    hasBootstrapConversationTuples: (snapshot.messages || []).some(Array.isArray)
      && (snapshot.replies || []).some(Array.isArray)
      && (snapshot.tasks || []).some(Array.isArray),
    messages: snapshot.messages.length,
    replies: snapshot.replies.length,
    tasks: snapshot.tasks.length,
    taskHydration: snapshot.bootstrap?.tasks || null,
    agents: snapshot.agents.length,
    humans: snapshot.humans.length,
    cloudMembers: snapshot.cloud?.members?.length || 0,
    allChannelMembershipMode: bootstrapAllChannel?.membershipMode || '',
    allChannelMemberCount: bootstrapAllChannel?.memberCount || 0,
    hasBootstrapAllChannelMembershipLists: ['memberIds', 'humanIds', 'agentIds'].some((key) => (
      Array.isArray(bootstrapAllChannel?.[key])
    )),
    unreadHydration: snapshot.bootstrap?.unreadHydration || null,
    previewTruncatedMessages: decodedMessages.filter((message) => message.bodyTruncated === true).length,
    previewTruncatedReplies: decodedReplies.filter((reply) => reply.bodyTruncated === true).length,
    previewMaxBodyChars: previewBodyLengths.length ? Math.max(...previewBodyLengths) : 0,
    selectedPageTruncatedMessages: decodedMessages.filter((message) => (
      message.bodyTruncated === true
      && syntheticMessageIndex(message) >= selectedMessagePageStart
    )).length,
    hasBootstrapMemberChurnFields: decodedAgents.some((agent) => agent.workspaceId || agent.role || agent.statusUpdatedAt || agent.heartbeatAt || agent.updatedAt)
      || decodedHumans.some((human) => human.workspaceId || human.lastSeenAt || human.presenceUpdatedAt || human.updatedAt),
    hasBootstrapConversationChurnFields: [...decodedMessages, ...decodedReplies].some((record) => (
      record.workspaceId || (record.updatedAt && record.createdAt && record.updatedAt === record.createdAt)
    )),
    hasBootstrapTaskChurnFields: decodedTasks.some((task) => (
      task.workspaceId
      || (task.updatedAt && task.createdAt && task.updatedAt === task.createdAt)
      || (Array.isArray(task.assigneeIds) && task.assigneeIds.length === 0)
      || (Array.isArray(task.attachmentIds) && task.attachmentIds.length === 0)
      || (Array.isArray(task.mentionedAgentIds) && task.mentionedAgentIds.length === 0)
      || (Array.isArray(task.mentionedHumanIds) && task.mentionedHumanIds.length === 0)
      || (Array.isArray(task.history) && task.history.length === 0)
    )),
    hasBootstrapEmptyAgentWorkItems: decodedAgents.some((agent) => (
      Array.isArray(agent.activeWorkItemIds) && agent.activeWorkItemIds.length === 0
    )),
    hasBootstrapDuplicateAgentRuntimeState: decodedAgents.some((agent) => (
      (agent.runtime && agent.runtimeId && agent.runtime === agent.runtimeId)
      || (agent.status && agent.previousStatus && agent.previousStatus === agent.status)
    )),
    hasBootstrapCloudMemberDuplication: decodedCloudMembers.some((member) => (
      member.human
      || member.workspaceId
      || member.updatedAt
      || member.createdAt
      || member.status === 'active'
      || member.role === 'member'
      || member.user?.id
      || member.user?.name
    )),
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
  const conversationRecordFanout = await measureConversationRecordFanout(state);
  const unreadCountsFanout = await measureUnreadCountsFanout(state);
  const bootstrapProjection = measureBootstrapProjectionWindow();
  const bootstrapLargeHistory = measureLargeBootstrapHistory();
  const bootstrapLargeUnread = measureLargeUnreadBootstrap();

  assertBudget(bootstrap.ms <= BUDGETS.bootstrapMs, `bootstrap ${bootstrap.ms}ms exceeds ${BUDGETS.bootstrapMs}ms`);
  assertBudget(bootstrap.bytes <= BUDGETS.bootstrapBytes, `bootstrap ${bootstrap.bytes} bytes exceeds ${BUDGETS.bootstrapBytes}`);
  assertBudget(bootstrap.directoryFormat === BOOTSTRAP_DIRECTORY_FORMAT, `bootstrap directory format expected ${BOOTSTRAP_DIRECTORY_FORMAT} but got ${bootstrap.directoryFormat || '[none]'}`);
  assertBudget(bootstrap.conversationFormat === BOOTSTRAP_CONVERSATION_FORMAT, `bootstrap conversation format expected ${BOOTSTRAP_CONVERSATION_FORMAT} but got ${bootstrap.conversationFormat || '[none]'}`);
  assertBudget(bootstrap.directoryScope === BOOTSTRAP_DIRECTORY_SCOPE, `bootstrap directory scope expected ${BOOTSTRAP_DIRECTORY_SCOPE} but got ${bootstrap.directoryScope || '[none]'}`);
  assertBudget(bootstrap.hasBootstrapDirectoryTuples, 'bootstrap did not compact member directories into tuple rows');
  assertBudget(bootstrap.hasBootstrapConversationTuples, 'bootstrap did not compact conversation records into tuple rows');
  assertBudget(bootstrap.previewTruncatedMessages > 0, 'bootstrap did not truncate background message preview bodies');
  assertBudget(bootstrap.previewTruncatedReplies > 0, 'bootstrap did not truncate background reply preview bodies');
  assertBudget(bootstrap.previewMaxBodyChars <= 140, `bootstrap preview bodies exceeded 140 chars: ${bootstrap.previewMaxBodyChars}`);
  assertBudget(bootstrap.selectedPageTruncatedMessages === 0, 'bootstrap truncated active conversation page message bodies');
  assertBudget(bootstrap.agents < state.agents.length, 'bootstrap still loaded the full Agent directory');
  assertBudget(bootstrap.humans < state.humans.length, 'bootstrap still loaded the full Human directory');
  assertBudget(bootstrap.cloudMembers < state.humans.length, 'bootstrap still loaded the full cloud member directory');
  assertBudget(bootstrap.directory?.agents?.total === state.agents.length, 'bootstrap directory metadata lost Agent total');
  assertBudget(bootstrap.directory?.humans?.total === state.humans.length, 'bootstrap directory metadata lost Human total');
  assertBudget(bootstrap.directory?.members?.total === state.humans.length, 'bootstrap directory metadata lost member total');
  assertBudget(!bootstrap.hasInternalFields, 'bootstrap leaked internal payload fields');
  assertBudget(!bootstrap.hasBootstrapMemberChurnFields, 'bootstrap leaked member churn fields');
  assertBudget(!bootstrap.hasBootstrapConversationChurnFields, 'bootstrap leaked conversation churn fields');
  assertBudget(!bootstrap.hasBootstrapTaskChurnFields, 'bootstrap leaked task churn fields');
  assertBudget(!bootstrap.hasBootstrapEmptyAgentWorkItems, 'bootstrap leaked empty agent work item arrays');
  assertBudget(!bootstrap.hasBootstrapDuplicateAgentRuntimeState, 'bootstrap leaked duplicate agent runtime/status fields');
  assertBudget(!bootstrap.hasBootstrapCloudMemberDuplication, 'bootstrap leaked duplicate cloud member human payloads');
  assertBudget(bootstrap.allChannelMembershipMode === 'all', 'bootstrap did not compact all-channel membership mode');
  assertBudget(bootstrap.allChannelMemberCount === state.humans.length + state.agents.length, `bootstrap all-channel member count expected ${state.humans.length + state.agents.length} but got ${bootstrap.allChannelMemberCount}`);
  assertBudget(!bootstrap.hasBootstrapAllChannelMembershipLists, 'bootstrap leaked all-channel membership id lists');
  assertBudget(bootstrap.tasks <= BUDGETS.bootstrapTasks, `bootstrap ${bootstrap.tasks} tasks exceeds ${BUDGETS.bootstrapTasks}`);
  assertBudget(bootstrap.taskHydration?.space?.hasMore === true, 'bootstrap task hydration did not expose selected-space pagination');
  assertBudget(bootstrap.taskHydration?.global?.hasMore === true, 'bootstrap task hydration did not expose global pagination');
  assertBudget(bootstrap.unreadHydration?.included <= BUDGETS.unreadHydrationRecords, 'bootstrap unread hydration is unbounded');
  assertBudget(directory.maxPageMs <= BUDGETS.directoryPageMs, `directory max page ${directory.maxPageMs}ms exceeds ${BUDGETS.directoryPageMs}ms`);
  assertBudget(directory.maxPageBytes <= BUDGETS.directoryPageBytes, `directory max page ${directory.maxPageBytes} bytes exceeds ${BUDGETS.directoryPageBytes}`);
  assertBudget(directory.totalBytes <= BUDGETS.directoryTotalBytes, `directory total ${directory.totalBytes} bytes exceeds ${BUDGETS.directoryTotalBytes}`);
  assertBudget(directory.pages.length <= BUDGETS.directoryPages, `directory ${directory.pages.length} pages exceeds ${BUDGETS.directoryPages}`);
  assertBudget(directory.directoryFormat === BOOTSTRAP_DIRECTORY_FORMAT, `directory format expected ${BOOTSTRAP_DIRECTORY_FORMAT} but got ${directory.directoryFormat || '[none]'}`);
  assertBudget(directory.directoryScope === 'paged', `directory scope expected paged but got ${directory.directoryScope || '[none]'}`);
  assertBudget(directory.pageLimit === DIRECTORY_PAGE_LIMIT, `directory page limit expected ${DIRECTORY_PAGE_LIMIT} but got ${directory.pageLimit}`);
  assertBudget(!directory.hasMoreAfterLastPage, 'directory pagination did not reach the final page');
  assertBudget(directory.hasDirectoryTuples, 'directory did not compact member directories into tuple rows');
  assertBudget(directory.agents === state.agents.length, `directory expected ${state.agents.length} agents but got ${directory.agents}`);
  assertBudget(directory.humans === state.humans.length, `directory expected ${state.humans.length} humans but got ${directory.humans}`);
  assertBudget(directory.cloudMembers === state.humans.length, `directory expected ${state.humans.length} members but got ${directory.cloudMembers}`);
  assertBudget(!directory.hasCloudMemberDuplication, 'directory leaked duplicate cloud member human payloads');
  assertBudget(!directory.hasMemberChurnFields, 'directory leaked member churn fields');
  assertBudget(!directory.hasInternalFields, 'directory leaked internal payload fields');
  assertBudget(directoryLargePage.sourceAgents === 10_000 && directoryLargePage.sourceHumans === 10_000, 'large directory page smoke did not use the 10000-member fixture');
  assertBudget(directoryLargePage.ms <= BUDGETS.directoryLargePageMs, `large directory page ${directoryLargePage.ms}ms exceeds ${BUDGETS.directoryLargePageMs}ms`);
  assertBudget(directoryLargePage.bytes <= BUDGETS.directoryLargePageBytes, `large directory page ${directoryLargePage.bytes} bytes exceeds ${BUDGETS.directoryLargePageBytes}`);
  assertBudget(directoryLargePage.agents === DIRECTORY_PAGE_LIMIT, `large directory page expected ${DIRECTORY_PAGE_LIMIT} agents but got ${directoryLargePage.agents}`);
  assertBudget(directoryLargePage.humans === DIRECTORY_PAGE_LIMIT, `large directory page expected ${DIRECTORY_PAGE_LIMIT} humans but got ${directoryLargePage.humans}`);
  assertBudget(directoryLargePage.cloudMembers === DIRECTORY_PAGE_LIMIT, `large directory page expected ${DIRECTORY_PAGE_LIMIT} members but got ${directoryLargePage.cloudMembers}`);
  assertBudget(directoryLargePage.agentTotal === 10_000 && directoryLargePage.humanTotal === 10_000 && directoryLargePage.memberTotal === 10_000, 'large directory page metadata did not preserve full totals');
  assertBudget(directoryLargePage.nextCursor === `${DIRECTORY_PAGE_LIMIT}:${DIRECTORY_PAGE_LIMIT}:${DIRECTORY_PAGE_LIMIT}`, `large directory page next cursor was ${directoryLargePage.nextCursor || '[none]'}`);
  assertBudget(directoryLargePage.hasMore, 'large directory page did not expose additional pages');
  assertBudget(directoryLargePage.hasDirectoryTuples, 'large directory page did not compact member directories into tuple rows');
  assertBudget(!directoryLargePage.hasCloudMemberDuplication, 'large directory page leaked duplicate cloud member human payloads');
  assertBudget(!directoryLargePage.hasMemberChurnFields, 'large directory page leaked member churn fields');
  assertBudget(!directoryLargePage.hasInternalFields, 'large directory page leaked internal payload fields');
  assertBudget(directorySearch.sourceAgents === 10_000 && directorySearch.sourceHumans === 10_000, 'directory search smoke did not use the 10000-member fixture');
  assertBudget(directorySearch.ms <= BUDGETS.directorySearchMs, `directory search ${directorySearch.ms}ms exceeds ${BUDGETS.directorySearchMs}ms`);
  assertBudget(directorySearch.bytes <= BUDGETS.directorySearchBytes, `directory search ${directorySearch.bytes} bytes exceeds ${BUDGETS.directorySearchBytes}`);
  assertBudget(directorySearch.mode === 'directory-search', `directory search mode expected directory-search but got ${directorySearch.mode || '[none]'}`);
  assertBudget(directorySearch.directoryFormat === BOOTSTRAP_DIRECTORY_FORMAT, `directory search format expected ${BOOTSTRAP_DIRECTORY_FORMAT} but got ${directorySearch.directoryFormat || '[none]'}`);
  assertBudget(directorySearch.directoryScope === 'search', `directory search scope expected search but got ${directorySearch.directoryScope || '[none]'}`);
  assertBudget(directorySearch.query === '9999', `directory search query expected 9999 but got ${directorySearch.query || '[none]'}`);
  assertBudget(directorySearch.limit === 5, `directory search limit expected 5 but got ${directorySearch.limit}`);
  assertBudget(directorySearch.agents === 1, `directory search expected 1 agent but got ${directorySearch.agents}`);
  assertBudget(directorySearch.humans === 1, `directory search expected 1 human but got ${directorySearch.humans}`);
  assertBudget(directorySearch.cloudMembers === 1, `directory search expected 1 member but got ${directorySearch.cloudMembers}`);
  assertBudget(directorySearch.agentIds.includes('agt_9999'), 'directory search did not return the matching Agent');
  assertBudget(directorySearch.humanIds.includes('hum_9999'), 'directory search did not return the matching Human');
  assertBudget(directorySearch.memberIds.includes('mem_9999'), 'directory search did not return the matching member');
  assertBudget(directorySearch.agentTotal === 1 && directorySearch.humanTotal === 1 && directorySearch.memberTotal === 1, 'directory search metadata did not preserve match totals');
  assertBudget(directorySearch.hasDirectoryTuples, 'directory search did not compact member directories into tuple rows');
  assertBudget(!directorySearch.hasCloudMemberDuplication, 'directory search leaked duplicate cloud member human payloads');
  assertBudget(!directorySearch.hasInternalFields, 'directory search leaked internal payload fields');
  assertBudget(directoryBroadSearch.sourceAgents === 10_000 && directoryBroadSearch.sourceHumans === 10_000, 'broad directory search smoke did not use the 10000-member fixture');
  assertBudget(directoryBroadSearch.ms <= BUDGETS.directoryBroadSearchMs, `broad directory search ${directoryBroadSearch.ms}ms exceeds ${BUDGETS.directoryBroadSearchMs}ms`);
  assertBudget(directoryBroadSearch.bytes <= BUDGETS.directoryBroadSearchBytes, `broad directory search ${directoryBroadSearch.bytes} bytes exceeds ${BUDGETS.directoryBroadSearchBytes}`);
  assertBudget(directoryBroadSearch.query === 'agent', `broad directory search query expected agent but got ${directoryBroadSearch.query || '[none]'}`);
  assertBudget(directoryBroadSearch.limit === 5, `broad directory search limit expected 5 but got ${directoryBroadSearch.limit}`);
  assertBudget(directoryBroadSearch.agents === 5, `broad directory search expected 5 loaded agents but got ${directoryBroadSearch.agents}`);
  assertBudget(directoryBroadSearch.humans === 0, `broad directory search expected 0 humans but got ${directoryBroadSearch.humans}`);
  assertBudget(directoryBroadSearch.cloudMembers === 0, `broad directory search expected 0 members but got ${directoryBroadSearch.cloudMembers}`);
  assertBudget(directoryBroadSearch.agentTotal === 10_000, `broad directory search expected 10000 matching agents but got ${directoryBroadSearch.agentTotal}`);
  assertBudget(directoryBroadSearch.humanTotal === 0 && directoryBroadSearch.memberTotal === 0, 'broad directory search metadata reported non-agent matches');
  assertBudget(directoryBroadSearch.hasAgentTuples, 'broad directory search did not compact agent rows into tuple rows');
  assertBudget(directoryBroadSearch.hasHumanTuples, 'broad directory search returned non-tuple human rows');
  assertBudget(directoryBroadSearch.hasMemberTuples, 'broad directory search returned non-tuple member rows');
  assertBudget(!directoryBroadSearch.hasCloudMemberDuplication, 'broad directory search leaked duplicate cloud member human payloads');
  assertBudget(!directoryBroadSearch.hasInternalFields, 'broad directory search leaked internal payload fields');
  assertBudget(membersDirectoryPage.sourceHumans === 10_000, 'members directory page smoke did not use the 10000-member fixture');
  assertBudget(membersDirectoryPage.ms <= BUDGETS.membersDirectoryPageMs, `members directory page ${membersDirectoryPage.ms}ms exceeds ${BUDGETS.membersDirectoryPageMs}ms`);
  assertBudget(membersDirectoryPage.bytes <= BUDGETS.membersDirectoryPageBytes, `members directory page ${membersDirectoryPage.bytes} bytes exceeds ${BUDGETS.membersDirectoryPageBytes}`);
  assertBudget(membersDirectoryPage.mode === 'members-directory', `members directory mode expected members-directory but got ${membersDirectoryPage.mode || '[none]'}`);
  assertBudget(membersDirectoryPage.page === 100, `members directory page expected 100 but got ${membersDirectoryPage.page}`);
  assertBudget(membersDirectoryPage.pageSize === 50, `members directory page size expected 50 but got ${membersDirectoryPage.pageSize}`);
  assertBudget(membersDirectoryPage.total === 10_000, `members directory total expected 10000 but got ${membersDirectoryPage.total}`);
  assertBudget(membersDirectoryPage.totalPages === 200, `members directory total pages expected 200 but got ${membersDirectoryPage.totalPages}`);
  assertBudget(membersDirectoryPage.rows === 50, `members directory page expected 50 rows but got ${membersDirectoryPage.rows}`);
  assertBudget(membersDirectoryPage.firstMemberId === 'mem_4950', `members directory first row expected mem_4950 but got ${membersDirectoryPage.firstMemberId || '[none]'}`);
  assertBudget(membersDirectoryPage.lastMemberId === 'mem_4999', `members directory last row expected mem_4999 but got ${membersDirectoryPage.lastMemberId || '[none]'}`);
  assertBudget(!membersDirectoryPage.hasOffPageFirstMember && !membersDirectoryPage.hasOffPageLastMember, 'members directory page leaked off-page member rows');
  assertBudget(!membersDirectoryPage.hasInternalFields, 'members directory page leaked internal payload fields');
  assertBudget(membersRailWindow.sourceAgents === 10_000 && membersRailWindow.sourceHumans === 10_000, 'members rail window smoke did not use the 10000-agent/10000-human fixture');
  assertBudget(membersRailWindow.ms <= BUDGETS.membersRailModelMs, `members rail model ${membersRailWindow.ms}ms exceeds ${BUDGETS.membersRailModelMs}ms`);
  assertBudget(membersRailWindow.visibleRows <= BUDGETS.membersRailRows, `members rail rendered ${membersRailWindow.visibleRows} rows exceeds ${BUDGETS.membersRailRows}`);
  assertBudget(membersRailWindow.visibleAgents < membersRailWindow.agentCount, 'members rail did not window agent rows');
  assertBudget(membersRailWindow.visibleHumans < membersRailWindow.humanCount, 'members rail did not window human rows');
  assertBudget(membersRailWindow.includesSelectedAgent, 'members rail window dropped the selected agent');
  assertBudget(membersRailWindow.includesSelectedHuman, 'members rail window dropped the selected human');
  assertBudget(heartbeat.ms <= BUDGETS.heartbeatMs, `heartbeat ${heartbeat.ms}ms exceeds ${BUDGETS.heartbeatMs}ms`);
  assertBudget(heartbeat.bytes <= BUDGETS.heartbeatBytes, `heartbeat ${heartbeat.bytes} bytes exceeds ${BUDGETS.heartbeatBytes}`);
  assertBudget(heartbeat.humanTimestampEntries === 0, `heartbeat included ${heartbeat.humanTimestampEntries} unselected human timestamp entries`);
  assertBudget(!heartbeat.hasInternalFields, 'heartbeat leaked internal payload fields');
  assertBudget(repeatedHeartbeat.deferredOpenBytes <= BUDGETS.deferredOpenBytes, `deferred SSE open ${repeatedHeartbeat.deferredOpenBytes} bytes exceeds ${BUDGETS.deferredOpenBytes}`);
  assertBudget(repeatedHeartbeat.fullPresenceSerializations <= BUDGETS.deferredHeartbeatFullSerializations, `deferred unchanged heartbeat serialized ${repeatedHeartbeat.fullPresenceSerializations} full presence payloads`);
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
  assertBudget(stateChangeFanout.compactStatusEntries, 'state change fanout did not compact status activity entries');
  assertBudget(stateChangeFanout.maxCoalescedCount === stateChangeFanout.statusChanges, 'state change fanout did not report the full coalesced count');
  assertBudget(stateChangeFanout.minSeqStart === 1 && stateChangeFanout.maxSeq === stateChangeFanout.statusChanges, 'state change fanout did not preserve a continuous sequence range');
  assertBudget(stateChangeFanout.stateResyncEvents === 0, 'status-only state change fanout sent resync events');
  assertBudget(stateChangeFanout.heartbeatEvents === 0, 'state change fanout sent heartbeat payload events');
  assertBudget(stateChangeFanout.heartbeatBytes === 0, 'state change fanout sent heartbeat payload bytes');
  assertBudget(conversationRecordFanout.totalBytes <= BUDGETS.conversationRecordFanoutBytes, `conversation record fanout ${conversationRecordFanout.totalBytes} bytes exceeds ${BUDGETS.conversationRecordFanoutBytes}`);
  assertBudget(conversationRecordFanout.realtimeEvents === BUDGETS.conversationRecordFanoutEvents, `conversation record fanout ${conversationRecordFanout.realtimeEvents} realtime events exceeds ${BUDGETS.conversationRecordFanoutEvents}`);
  assertBudget(conversationRecordFanout.eventTypes.length === 1 && conversationRecordFanout.eventTypes[0] === 'conversation_record_changed', 'conversation record fanout did not use conversation realtime events');
  assertBudget(conversationRecordFanout.messageIds.length === 1 && conversationRecordFanout.messageIds[0] === 'msg_perf_realtime', 'conversation record fanout did not carry the changed message');
  assertBudget(conversationRecordFanout.stateResyncEvents === 0, 'conversation record fanout sent resync events');
  assertBudget(conversationRecordFanout.heartbeatEvents === 0, 'conversation record fanout sent heartbeat events');
  assertBudget(conversationRecordFanout.unrelatedPackets === 0, 'conversation record fanout leaked to unrelated channel clients');
  assertBudget(unreadCountsFanout.totalBytes <= BUDGETS.unreadCountsFanoutBytes, `unread counts fanout ${unreadCountsFanout.totalBytes} bytes exceeds ${BUDGETS.unreadCountsFanoutBytes}`);
  assertBudget(unreadCountsFanout.realtimeEvents === BUDGETS.unreadCountsFanoutEvents, `unread counts fanout ${unreadCountsFanout.realtimeEvents} realtime events exceeds ${BUDGETS.unreadCountsFanoutEvents}`);
  assertBudget(unreadCountsFanout.eventTypes.length === 1 && unreadCountsFanout.eventTypes[0] === 'unread_counts_updated', 'unread counts fanout did not use unread realtime events');
  assertBudget(unreadCountsFanout.targetHumanIds.length === 1 && unreadCountsFanout.targetHumanIds[0] === 'hum_0000', 'unread counts fanout did not carry the target human id');
  assertBudget(unreadCountsFanout.stateResyncEvents === 0, 'unread counts fanout sent resync events');
  assertBudget(unreadCountsFanout.heartbeatEvents === 0, 'unread counts fanout sent heartbeat events');
  assertBudget(unreadCountsFanout.otherWorkspacePackets === 0, 'unread counts fanout leaked to another workspace');
  assertBudget(bootstrapProjection.hasMoreMessages === true, 'bootstrap projection smoke did not expose history pagination');
  assertBudget(bootstrapProjection.projectedMetadataReads <= BUDGETS.bootstrapProjectedConversationReads, `bootstrap projected ${bootstrapProjection.projectedMetadataReads} conversation metadata reads from ${bootstrapProjection.sourceMessages} source messages`);
  assertBudget(bootstrapLargeHistory.hasMoreMessages === true, 'large-history bootstrap did not expose history pagination');
  assertBudget(bootstrapLargeHistory.ms <= BUDGETS.bootstrapLargeHistoryMs, `large-history bootstrap ${bootstrapLargeHistory.ms}ms exceeds ${BUDGETS.bootstrapLargeHistoryMs}ms`);
  assertBudget(bootstrapLargeHistory.bytes <= BUDGETS.bootstrapLargeHistoryBytes, `large-history bootstrap ${bootstrapLargeHistory.bytes} bytes exceeds ${BUDGETS.bootstrapLargeHistoryBytes}`);
  assertBudget(bootstrapLargeUnread.unreadHydration?.included === BUDGETS.unreadHydrationRecords, `large-unread bootstrap hydrated ${bootstrapLargeUnread.unreadHydration?.included || 0} unread records`);
  assertBudget(bootstrapLargeUnread.unreadHydration?.truncated === true, 'large-unread bootstrap did not mark unread hydration as truncated');
  assertBudget(bootstrapLargeUnread.ms <= BUDGETS.bootstrapLargeUnreadMs, `large-unread bootstrap ${bootstrapLargeUnread.ms}ms exceeds ${BUDGETS.bootstrapLargeUnreadMs}ms`);
  assertBudget(bootstrapLargeUnread.bytes <= BUDGETS.bootstrapLargeUnreadBytes, `large-unread bootstrap ${bootstrapLargeUnread.bytes} bytes exceeds ${BUDGETS.bootstrapLargeUnreadBytes}`);

  console.log(JSON.stringify({
    ok: true,
    budgets: BUDGETS,
    bootstrap,
    directory,
    directoryLargePage,
    directorySearch,
    directoryBroadSearch,
    membersDirectoryPage,
    membersRailWindow,
    heartbeat,
    repeatedHeartbeat,
    humanHeartbeatChurn,
    presenceMemberDelta,
    stateChangeFanout,
    conversationRecordFanout,
    unreadCountsFanout,
    bootstrapProjection,
    bootstrapLargeHistory,
    bootstrapLargeUnread,
    smokeMs: Math.round(performance.now() - smokeStarted),
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
