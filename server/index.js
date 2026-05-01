import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  buildAgentContextPack,
  renderAgentContextPack,
} from './agent-context.js';
import {
  formatAgentHistory,
  formatAgentSearchResults,
  readAgentHistory,
  searchAgentMessageHistory,
} from './agent-history.js';
import {
  codexRuntimeOverrideForDelivery as codexRuntimeOverrideForDeliveryBase,
  codexStreamRetryLimit,
  codexThreadConfig,
  parseCodexStreamRetry,
  resolveCodexRuntime as resolveCodexRuntimeBase,
} from './codex-runtime.js';
import {
  fanoutApiEndpoint,
  fanoutApiResponseText,
  parseFanoutApiJson,
} from './fanout-api.js';
import {
  applyMentions,
  escapeRegExp,
  extractMentionTokens,
  isMentionBoundaryChar,
  mentionTokenForId,
  normalizeIds,
} from './mentions.js';
import {
  agentCapabilityQuestionIntent,
  agentResponseIntent,
  autoTaskMessageIntent,
  availabilityBroadcastIntent,
  availabilityFollowupIntent,
  channelGreetingIntent,
  contextualAgentFollowupIntent,
  directAvailabilityIntent,
  inferTaskIntentKind,
  taskCreationIntent,
  taskEndIntent,
  taskStopIntent,
  userPreferenceIntent,
} from './intents.js';
import {
  fanoutApiConfigReady,
  normalizeChatRuntimeConfig,
  normalizeCloudUrl,
  normalizeCodexModelName as normalizeCodexModelNameBase,
  normalizeFanoutApiConfig as normalizeFanoutApiConfigBase,
  publicApiKeyPreview,
} from './runtime-config.js';
import {
  baseNameFromProjectPath,
  CONTENT_TYPES as contentTypes,
  decodePathSegment,
  httpError,
  mimeForPath,
  normalizeProjectRelPath,
  safeFileName,
  safePathWithin,
  splitLines,
  toPosixPath,
} from './path-utils.js';
import {
  listProjectTree as listProjectTreeBase,
  projectFilePreviewKind,
  readProjectFilePreview as readProjectFilePreviewBase,
  searchProject,
  sortProjectSearchResults,
} from './project-files.js';
import { createAgentRuntimeManager } from './agent-runtime-manager.js';
import { createAgentWorkspaceManager } from './agent-workspace.js';
import { createConversationModel } from './conversation-model.js';
import { handleAgentApi } from './api/agent-routes.js';
import { handleAgentToolApi } from './api/agent-tool-routes.js';
import { handleCloudApi } from './api/cloud-routes.js';
import { handleCollabApi } from './api/collab-routes.js';
import { handleMessageApi } from './api/message-routes.js';
import { handleMissionApi } from './api/mission-routes.js';
import { handleProjectApi } from './api/project-routes.js';
import { handleSystemApi } from './api/system-routes.js';
import { handleTaskApi } from './api/task-routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, '.magclaw');
const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
const RUNS_DIR = path.join(DATA_DIR, 'runs');
const AGENTS_DIR = path.join(DATA_DIR, 'agents');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const STATE_DB_FILE = path.join(DATA_DIR, 'state.sqlite');
const SOURCE_CODEX_HOME = path.resolve(process.env.MAGCLAW_CODEX_HOME_SOURCE || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const DEFAULT_PORT = 6543;
const PORT = Number(process.env.PORT || DEFAULT_PORT);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_JSON_BYTES = 40 * 1024 * 1024;
const MAX_ATTACHMENT_UPLOADS = 20;
const MAX_AGENT_WORKSPACE_TREE_ENTRIES = 300;
const MAX_AGENT_WORKSPACE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_AGENT_RELAY_DEPTH = 2;
const AGENT_BUSY_DELIVERY_DELAY_MS = Math.max(10, Number(process.env.MAGCLAW_AGENT_BUSY_DELIVERY_DELAY_MS || 160));
const STATE_HEARTBEAT_MS = Math.max(25, Number(process.env.MAGCLAW_STATE_HEARTBEAT_MS || 1000));
const AGENT_STATUS_STALE_MS = Math.max(1000, Number(process.env.MAGCLAW_AGENT_STATUS_STALE_MS || 45_000));
const ROUTE_EVENTS_LIMIT = Math.max(50, Number(process.env.MAGCLAW_ROUTE_EVENTS_LIMIT || 500));
const AGENT_CARD_TEXT_LIMIT = 5000;
const FANOUT_API_TIMEOUT_MS = Math.max(500, Number(process.env.MAGCLAW_FANOUT_TIMEOUT_MS || 2500));
const CODEX_STREAM_RETRY_LIMIT = codexStreamRetryLimit();
const LEGACY_BRAIN_AGENT_ID = 'agt_magclaw_brain';
const BRAIN_AGENT_NAME = 'MagClaw Brain';
const BRAIN_AGENT_DESCRIPTION = 'Routes channel fan-out, task claim recommendations, agent cards, and memory writeback triggers.';
const CLOUD_PROTOCOL_VERSION = 1;
const CODEX_HOME_CONFIG_VERSION = 2;
const CODEX_FALLBACK_MODEL = 'gpt-5.5';
const SQLITE_BACKED_STATE_KEYS = ['messages', 'replies', 'tasks', 'workItems', 'events'];
const AGENT_BOOT_RESET_STATUSES = new Set(['starting', 'thinking', 'working', 'running', 'busy', 'queued', 'error']);
const CODEX_HOME_SHARED_ENTRIES = [
  'auth.json',
];
const CODEX_HOME_STALE_SHARED_ENTRIES = [
  'config.toml',
  'AGENTS.md',
  'agent-rules',
  'plugins',
  'skills',
  'rules',
  'hooks.json',
  'hooks',
  'vendor_imports',
];
const runningProcesses = new Map();
const agentProcesses = new Map(); // agentId -> { child, sessionId, status, inbox }
const sseClients = new Set();
let cloudPushTimer = null;
let syncInProgress = false;

let state = null;
let saveChain = Promise.resolve();
let stateDb = null;
const agentCardCache = new Map();

function now() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

function normalizeFanoutApiConfig(config = {}) {
  return normalizeFanoutApiConfigBase(config, FANOUT_API_TIMEOUT_MS);
}

function fanoutApiConfigured(config = state?.settings?.fanoutApi) {
  return fanoutApiConfigReady(config || {}, FANOUT_API_TIMEOUT_MS);
}

function defaultState() {
  const seededAt = now();
  const hostName = os.hostname();
  return {
    version: 7,
    createdAt: seededAt,
    updatedAt: seededAt,
    settings: {
      codexPath: process.env.CODEX_PATH || '/Applications/Codex.app/Contents/Resources/codex',
      defaultWorkspace: ROOT,
      model: process.env.CODEX_MODEL || '',
      sandbox: process.env.CODEX_SANDBOX || 'workspace-write',
      fanoutApi: {
        enabled: process.env.MAGCLAW_FANOUT_API_ENABLED === '1',
        baseUrl: normalizeCloudUrl(process.env.MAGCLAW_FANOUT_API_BASE_URL || ''),
        apiKey: process.env.MAGCLAW_FANOUT_API_KEY || '',
        model: process.env.MAGCLAW_FANOUT_API_MODEL || '',
        timeoutMs: FANOUT_API_TIMEOUT_MS,
      },
      chatRuntime: normalizeChatRuntimeConfig({
        enabled: process.env.MAGCLAW_CHAT_FAST_RUNTIME !== '0',
        model: process.env.MAGCLAW_CHAT_MODEL || process.env.MAGCLAW_FAST_CHAT_MODEL || '',
        reasoningEffort: process.env.MAGCLAW_CHAT_REASONING || 'low',
      }),
    },
    connection: {
      mode: process.env.MAGCLAW_MODE === 'cloud' ? 'cloud' : 'local',
      deployment: process.env.MAGCLAW_DEPLOYMENT || 'local',
      controlPlaneUrl: normalizeCloudUrl(process.env.MAGCLAW_CLOUD_URL || ''),
      relayUrl: normalizeCloudUrl(process.env.MAGCLAW_RELAY_URL || ''),
      cloudToken: process.env.MAGCLAW_CLOUD_TOKEN || '',
      workspaceId: process.env.MAGCLAW_WORKSPACE_ID || 'local',
      deviceId: process.env.MAGCLAW_DEVICE_ID || makeId('dev'),
      deviceName: hostName,
      pairingStatus: process.env.MAGCLAW_MODE === 'cloud' ? 'configured' : 'local',
      pairedAt: null,
      lastSyncAt: null,
      lastSyncDirection: null,
      lastError: '',
      autoSync: process.env.MAGCLAW_AUTO_SYNC === '1',
      protocolVersion: CLOUD_PROTOCOL_VERSION,
    },
    storage: {
      schemaVersion: 1,
      sqliteFile: 'state.sqlite',
      sqliteBackedKeys: SQLITE_BACKED_STATE_KEYS,
    },
    router: {
      mode: 'rules_fallback',
      brainAgentId: null,
      fallback: 'rules',
      cardSource: 'workspace_markdown',
    },
    brainAgents: [],
    humans: [
      {
        id: 'hum_local',
        name: 'You',
        email: 'local@magclaw.dev',
        role: 'owner',
        status: 'online',
        createdAt: seededAt,
      },
    ],
    computers: [
      {
        id: 'cmp_local',
        name: hostName,
        os: `${os.platform()} ${os.arch()}`,
        daemonVersion: 'local-dev',
        status: 'connected',
        runtimeIds: ['codex'],
        createdAt: seededAt,
      },
    ],
    agents: [
      {
        id: 'agt_codex',
        name: 'Codex Local',
        description: 'Local Codex CLI agent bound to this machine.',
        runtime: 'Codex CLI',
        model: process.env.CODEX_MODEL || 'default',
        status: 'idle',
        computerId: 'cmp_local',
        workspace: ROOT,
        createdAt: seededAt,
      },
    ],
    channels: [
      {
        id: 'chan_all',
        name: 'all',
        description: 'Default local coordination channel.',
        ownerId: 'hum_local',
        humanIds: ['hum_local'],
        agentIds: ['agt_codex'],
        memberIds: ['hum_local', 'agt_codex'],
        archived: false,
        createdAt: seededAt,
        updatedAt: seededAt,
      },
    ],
    dms: [
      {
        id: 'dm_codex',
        participantIds: ['hum_local', 'agt_codex'],
        createdAt: seededAt,
        updatedAt: seededAt,
      },
    ],
    messages: [
      {
        id: 'msg_welcome',
        spaceType: 'channel',
        spaceId: 'chan_all',
        authorType: 'system',
        authorId: 'system',
        body: 'Magclaw local is ready. Create a task, start a Codex mission, or open a thread.',
        attachmentIds: [],
        mentionedAgentIds: [],
        mentionedHumanIds: [],
        readBy: ['hum_local'],
        replyCount: 0,
        savedBy: [],
        createdAt: seededAt,
        updatedAt: seededAt,
      },
    ],
    replies: [],
    tasks: [],
    missions: [],
    runs: [],
    attachments: [],
    projects: [],
    workItems: [],
    routeEvents: [],
    events: [],
  };
}

async function ensureStorage() {
  await mkdir(ATTACHMENTS_DIR, { recursive: true });
  await mkdir(RUNS_DIR, { recursive: true });
  await mkdir(AGENTS_DIR, { recursive: true });
  await initializeStateDatabase();

  if (!existsSync(STATE_FILE)) {
    state = defaultState();
    migrateState();
    await ensureAllAgentWorkspaces();
    await persistState();
    return;
  }

  try {
    state = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    migrateState();
    migrateJsonBackedStateToSqlite();
    hydrateSqliteBackedState();
    migrateState();
    await ensureAllAgentWorkspaces();
    await persistState();
  } catch {
    state = defaultState();
    migrateState();
    addSystemEvent('state_recovered', 'State file was unreadable, Magclaw started with a clean state.');
    await ensureAllAgentWorkspaces();
    await persistState();
  }
}

async function initializeStateDatabase() {
  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(STATE_DB_FILE);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS state_records (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT,
        updated_at TEXT,
        payload TEXT NOT NULL,
        PRIMARY KEY (kind, id)
      );
      CREATE INDEX IF NOT EXISTS idx_state_records_kind_position ON state_records(kind, position);
      CREATE INDEX IF NOT EXISTS idx_state_records_kind_created ON state_records(kind, created_at);
    `);
    stateDb = db;
  } catch (error) {
    stateDb = null;
    console.warn(`SQLite state store unavailable; falling back to state.json arrays: ${error.message}`);
  }
}

function sqliteBackedStateEnabled() {
  return Boolean(stateDb);
}

function sqliteRecordCount() {
  if (!sqliteBackedStateEnabled()) return 0;
  const row = stateDb.prepare('SELECT COUNT(*) AS count FROM state_records').get();
  return Number(row?.count || 0);
}

function hasJsonBackedRecords(sourceState = state) {
  return SQLITE_BACKED_STATE_KEYS.some((key) => Array.isArray(sourceState?.[key]) && sourceState[key].length);
}

function migrateJsonBackedStateToSqlite() {
  if (!sqliteBackedStateEnabled() || !state || sqliteRecordCount() > 0 || !hasJsonBackedRecords(state)) return;
  syncSqliteBackedState();
}

function hydrateSqliteBackedState() {
  if (!sqliteBackedStateEnabled() || !state || sqliteRecordCount() === 0) return;
  const select = stateDb.prepare('SELECT payload FROM state_records WHERE kind = ? ORDER BY position ASC, created_at ASC, id ASC');
  for (const key of SQLITE_BACKED_STATE_KEYS) {
    const rows = select.all(key);
    state[key] = rows
      .map((row) => {
        try {
          return JSON.parse(row.payload);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }
}

function syncSqliteBackedState() {
  if (!sqliteBackedStateEnabled() || !state) return;
  const removeKind = stateDb.prepare('DELETE FROM state_records WHERE kind = ?');
  const insert = stateDb.prepare(`
    INSERT INTO state_records (kind, id, position, created_at, updated_at, payload)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stateDb.exec('BEGIN IMMEDIATE');
  try {
    for (const key of SQLITE_BACKED_STATE_KEYS) {
      removeKind.run(key);
      const records = Array.isArray(state[key]) ? state[key] : [];
      records.forEach((record, index) => {
        const id = String(record?.id || `${key}_${index}`);
        insert.run(
          key,
          id,
          index,
          record?.createdAt || null,
          record?.updatedAt || record?.createdAt || null,
          JSON.stringify(record),
        );
      });
    }
    stateDb.exec('COMMIT');
  } catch (error) {
    stateDb.exec('ROLLBACK');
    throw error;
  }
}

function normalizeCodexModelName(model, fallback = '') {
  return normalizeCodexModelNameBase(model, fallback, CODEX_FALLBACK_MODEL);
}

function codexRuntimeOverrideForDelivery(message, workItem = null) {
  return codexRuntimeOverrideForDeliveryBase(message, workItem, state.settings?.chatRuntime || {}, {
    taskCreationIntent,
    autoTaskMessageIntent,
  });
}

function resolveCodexRuntime(agent, messages = []) {
  return resolveCodexRuntimeBase(agent, messages, {
    settingsModel: state.settings?.model,
    normalizeModelName: normalizeCodexModelName,
  });
}

function isBrainAgent(agent) {
  if (!agent) return false;
  return agent.isBrain === true || String(agent.systemRole || '').toLowerCase() === 'brain';
}

function agentParticipatesInChannels(agent) {
  return Boolean(agent && !isBrainAgent(agent));
}

function isLegacyBrainRuntime(runtime) {
  return String(runtime || '').trim().toLowerCase() === 'router brain';
}

function normalizeBrainAgentConfig(brain = {}, options = {}) {
  const createdAt = brain.createdAt || now();
  const runtime = isLegacyBrainRuntime(brain.runtime) ? '' : String(brain.runtime || '').trim();
  const model = brain.model
    ? normalizeCodexModelName(brain.model, state.settings?.model)
    : normalizeCodexModelName(state.settings?.model, CODEX_FALLBACK_MODEL);
  const active = Boolean(options.active ?? brain.active);
  return {
    id: String(brain.id || makeId('brain')),
    name: BRAIN_AGENT_NAME,
    description: BRAIN_AGENT_DESCRIPTION,
    runtime,
    model,
    status: runtime ? 'configured' : 'offline',
    active,
    computerId: String(brain.computerId || 'cmp_local'),
    workspace: path.resolve(String(brain.workspace || state.settings?.defaultWorkspace || ROOT)),
    reasoningEffort: brain.reasoningEffort ? String(brain.reasoningEffort) : null,
    createdAt,
    updatedAt: brain.updatedAt || createdAt,
  };
}

function reconcileBrainAgentConfigs() {
  state.brainAgents = Array.isArray(state.brainAgents) ? state.brainAgents : [];
  const migrated = [];
  const currentBrainId = state.router?.brainAgentId || null;

  for (const agent of state.agents || []) {
    if (!isBrainAgent(agent)) continue;
    if (agent.id !== LEGACY_BRAIN_AGENT_ID && !isLegacyBrainRuntime(agent.runtime)) {
      migrated.push(normalizeBrainAgentConfig(agent, { active: agent.id === currentBrainId || Boolean(agent.active) }));
    }
  }

  state.agents = (state.agents || []).filter((agent) => !isBrainAgent(agent));
  state.brainAgents = [...state.brainAgents, ...migrated].map((brain) => normalizeBrainAgentConfig(brain));

  const seen = new Set();
  state.brainAgents = state.brainAgents.filter((brain) => {
    if (!brain.id || seen.has(brain.id)) return false;
    seen.add(brain.id);
    return true;
  });

  const configured = state.brainAgents.filter((brain) => brain.runtime);
  const requestedActive = currentBrainId
    ? configured.find((brain) => brain.id === currentBrainId)
    : configured.find((brain) => brain.active);
  const activeBrain = requestedActive || null;

  for (const brain of state.brainAgents) {
    brain.active = Boolean(activeBrain && brain.id === activeBrain.id);
    brain.status = brain.runtime ? 'configured' : 'offline';
  }

  state.router = {
    mode: activeBrain ? 'brain_agent' : 'rules_fallback',
    brainAgentId: activeBrain?.id || null,
    fallback: 'rules',
    cardSource: 'workspace_markdown',
    ...(state.router || {}),
  };
  state.router.mode = activeBrain ? 'brain_agent' : 'rules_fallback';
  state.router.brainAgentId = activeBrain?.id || null;
  state.router.fallback = state.router.fallback || 'rules';
  state.router.cardSource = state.router.cardSource || 'workspace_markdown';
  return activeBrain;
}

function migrateState() {
  const fresh = defaultState();
  state.version = 7;
  state.settings = { ...fresh.settings, ...(state.settings || {}) };
  state.settings.fanoutApi = normalizeFanoutApiConfig({
    ...fresh.settings.fanoutApi,
    ...(state.settings.fanoutApi || {}),
  });
  state.settings.chatRuntime = normalizeChatRuntimeConfig({
    ...fresh.settings.chatRuntime,
    ...(state.settings.chatRuntime || {}),
  });
  state.connection = { ...fresh.connection, ...(state.connection || {}) };
  state.storage = { ...fresh.storage, ...(state.storage || {}), sqliteBackedKeys: SQLITE_BACKED_STATE_KEYS };
  state.router = { ...fresh.router, ...(state.router || {}) };
  state.connection.mode = state.connection.mode === 'cloud' ? 'cloud' : 'local';
  state.connection.controlPlaneUrl = normalizeCloudUrl(state.connection.controlPlaneUrl || '');
  state.connection.relayUrl = normalizeCloudUrl(state.connection.relayUrl || '');
  state.connection.cloudToken = String(state.connection.cloudToken || process.env.MAGCLAW_CLOUD_TOKEN || '');
  state.connection.protocolVersion = CLOUD_PROTOCOL_VERSION;
  for (const key of ['humans', 'computers', 'agents', 'brainAgents', 'channels', 'dms', 'messages', 'replies', 'tasks', 'missions', 'runs', 'attachments', 'projects', 'workItems', 'routeEvents', 'events']) {
    if (!Array.isArray(state[key])) state[key] = fresh[key] || [];
  }
  if (!state.humans.length) state.humans = fresh.humans;
  if (!state.computers.length) state.computers = fresh.computers;
  if (!state.agents.length) state.agents = fresh.agents;
  reconcileBrainAgentConfigs();
  state.router.mode = fanoutApiConfigured() ? 'llm_fanout' : 'rules_fallback';
  state.router.brainAgentId = null;
  if (!state.agents.length) state.agents = fresh.agents;
  if (!state.channels.length) state.channels = fresh.channels;
  if (!state.dms.length) state.dms = fresh.dms;
  if (!state.messages.length) state.messages = fresh.messages;
  for (const channel of state.channels) {
    channel.ownerId = channel.ownerId || 'hum_local';
    channel.humanIds = Array.isArray(channel.humanIds) ? channel.humanIds : ['hum_local'];
    channel.agentIds = Array.isArray(channel.agentIds) ? channel.agentIds : [];
    channel.memberIds = Array.isArray(channel.memberIds)
      ? channel.memberIds
      : [...channel.humanIds, ...channel.agentIds];
    if (!channel.humanIds.includes('hum_local')) channel.humanIds.unshift('hum_local');
    if (!channel.memberIds.includes('hum_local')) channel.memberIds.unshift('hum_local');
    if (channel.id === 'chan_all') {
      for (const human of state.humans) {
        if (!channel.humanIds.includes(human.id)) channel.humanIds.push(human.id);
        if (!channel.memberIds.includes(human.id)) channel.memberIds.push(human.id);
      }
      for (const agent of state.agents.filter(agentParticipatesInChannels)) {
        if (!channel.agentIds.includes(agent.id)) channel.agentIds.push(agent.id);
        if (!channel.memberIds.includes(agent.id)) channel.memberIds.push(agent.id);
      }
    }
    channel.agentIds = normalizeIds(channel.agentIds).filter((id) => agentParticipatesInChannels(findAgent(id)));
    channel.memberIds = normalizeIds(channel.memberIds).filter((id) => !id.startsWith('agt_') || agentParticipatesInChannels(findAgent(id)));
  }
  for (const message of state.messages) {
    normalizeConversationRecord(message);
  }
  for (const reply of state.replies) {
    const parent = state.messages.find((message) => message.id === reply.parentMessageId);
    if (parent) {
      reply.spaceType = reply.spaceType || parent.spaceType;
      reply.spaceId = reply.spaceId || parent.spaceId;
    }
    normalizeConversationRecord(reply);
  }
  for (const item of state.workItems) {
    item.id = item.id || makeId('wi');
    item.status = item.status || 'queued';
    item.createdAt = item.createdAt || now();
    item.updatedAt = item.updatedAt || item.createdAt;
    item.parentMessageId = item.parentMessageId || null;
    item.target = item.target || targetForConversation(item.spaceType, item.spaceId, item.parentMessageId);
    item.sendCount = Number(item.sendCount || 0);
  }
  for (const attachment of state.attachments) {
    attachment.source = attachment.source || 'upload';
    attachment.createdAt = attachment.createdAt || now();
    if (!attachment.url && attachment.id) {
      attachment.url = `/api/attachments/${attachment.id}/${encodeURIComponent(attachment.name || 'attachment')}`;
    }
  }
  state.projects = state.projects
    .filter((project) => project && project.path)
    .map((project) => ({
      id: project.id || makeId('prj'),
      name: String(project.name || path.basename(project.path) || 'Project').slice(0, 80),
      path: path.resolve(String(project.path)),
      spaceType: project.spaceType === 'dm' ? 'dm' : 'channel',
      spaceId: String(project.spaceId || 'chan_all'),
      createdAt: project.createdAt || now(),
      updatedAt: project.updatedAt || project.createdAt || now(),
    }));
  const taskCounters = new Map();
  const tasksByCreation = [...state.tasks].sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  for (const task of state.tasks) {
    task.history = Array.isArray(task.history) ? task.history : [];
    task.attachmentIds = Array.isArray(task.attachmentIds) ? task.attachmentIds : [];
    task.assigneeIds = normalizeIds(task.assigneeIds);
    if (task.assigneeId && !task.assigneeIds.includes(task.assigneeId)) task.assigneeIds.unshift(task.assigneeId);
    task.threadMessageId = task.threadMessageId || task.messageId || null;
    task.sourceMessageId = task.sourceMessageId || task.messageId || task.threadMessageId || null;
    task.sourceReplyId = task.sourceReplyId || null;
    task.claimedBy = task.claimedBy || task.assigneeId || null;
    task.claimedAt = task.claimedAt || null;
    task.reviewRequestedAt = task.reviewRequestedAt || null;
    task.completedAt = task.completedAt || null;
    task.cancelledAt = task.cancelledAt || null;
    task.stoppedAt = task.stoppedAt || null;
    if (task.status === 'cancelled') {
      const closedAt = task.completedAt || task.cancelledAt || task.stoppedAt || task.updatedAt || task.createdAt || now();
      task.status = 'done';
      task.completedAt = closedAt;
      task.endIntentAt = task.endIntentAt || closedAt;
      task.reviewRequestedAt = null;
    }
    task.endIntentAt = task.endIntentAt || null;
    task.runIds = Array.isArray(task.runIds) ? task.runIds : [];
    task.localReferences = Array.isArray(task.localReferences) ? task.localReferences : extractLocalReferences(task.body || '');
  }
  for (const task of tasksByCreation) {
    const key = taskScopeKey(task.spaceType, task.spaceId);
    const current = taskCounters.get(key) || 0;
    if (Number.isInteger(task.number) && task.number > 0) {
      taskCounters.set(key, Math.max(current, task.number));
    } else {
      const next = current + 1;
      task.number = next;
      taskCounters.set(key, next);
    }
  }
  // Migrate agents to include personality and memory fields
  for (const agent of state.agents) {
    if (!agent.personality) {
      agent.personality = {
        traits: ['helpful'],
        interests: [],
        responseStyle: 'concise',
        proactivity: 0.3,
      };
    }
    if (!agent.memory) {
      agent.memory = {
        conversationSummaries: [],
        knownTopics: [],
        userPreferences: {},
        lastInteraction: null,
      };
    }
    const legacyRuntimeSessionId = agent.runtimeSessionId && !agent.runtimeSessionHome
      ? agent.runtimeSessionId
      : null;
    agent.runtimeSessionId = legacyRuntimeSessionId ? null : agent.runtimeSessionId || null;
    agent.runtimeSessionHome = agent.runtimeSessionHome || null;
    agent.runtimeConfigVersion = Number(agent.runtimeConfigVersion || 0);
    const staleRuntimeConfig = agent.runtimeSessionId && agent.runtimeConfigVersion !== CODEX_HOME_CONFIG_VERSION;
    if (staleRuntimeConfig) {
      addSystemEvent('agent_runtime_session_reset', `${agent.name} Codex session was cleared before isolated runtime config start.`, {
        agentId: agent.id,
        previousSessionId: agent.runtimeSessionId,
        previousHome: agent.runtimeSessionHome || SOURCE_CODEX_HOME,
        previousConfigVersion: agent.runtimeConfigVersion,
        configVersion: CODEX_HOME_CONFIG_VERSION,
      });
      agent.runtimeSessionId = null;
      agent.runtimeLastTurnAt = null;
    }
    agent.runtimeLastStartedAt = agent.runtimeLastStartedAt || null;
    agent.runtimeLastTurnAt = legacyRuntimeSessionId ? null : agent.runtimeLastTurnAt || null;
    agent.workspacePath = agent.workspacePath || path.join(AGENTS_DIR, agent.id);
    agent.statusUpdatedAt = agent.statusUpdatedAt || agent.updatedAt || agent.createdAt || now();
    agent.heartbeatAt = agent.heartbeatAt || agent.statusUpdatedAt;
    agent.activeWorkItemIds = normalizeIds(agent.activeWorkItemIds || []);
    agent.model = isBrainAgent(agent) ? (agent.model || 'agent-card-router') : normalizeCodexModelName(agent.model, state.settings?.model);
    if (!isBrainAgent(agent) && AGENT_BOOT_RESET_STATUSES.has(String(agent.status || '').toLowerCase())) {
      agent.status = 'idle';
    }
    if (legacyRuntimeSessionId) {
      addSystemEvent('agent_runtime_session_reset', `${agent.name} legacy Codex session was cleared before isolated runtime start.`, {
        agentId: agent.id,
        previousSessionId: legacyRuntimeSessionId,
        previousHome: SOURCE_CODEX_HOME,
      });
    }
  }
}

function persistState() {
  if (!state) return Promise.resolve();
  state.updatedAt = now();
  const payload = JSON.stringify(stateJsonSnapshot(), null, 2);
  saveChain = saveChain.then(async () => {
    syncSqliteBackedState();
    const tmp = `${STATE_FILE}.tmp`;
    await writeFile(tmp, payload);
    await rename(tmp, STATE_FILE);
  });
  return saveChain;
}

function stateJsonSnapshot() {
  const snapshot = {
    ...state,
    storage: {
      ...(state.storage || {}),
      sqliteEnabled: sqliteBackedStateEnabled(),
      sqliteFile: path.basename(STATE_DB_FILE),
      sqliteBackedKeys: SQLITE_BACKED_STATE_KEYS,
    },
  };
  if (sqliteBackedStateEnabled()) {
    for (const key of SQLITE_BACKED_STATE_KEYS) snapshot[key] = [];
  }
  return snapshot;
}

function addSystemEvent(type, message, extra = {}) {
  if (!state) return;
  state.events.push({
    id: makeId('evt'),
    type,
    message,
    createdAt: now(),
    ...extra,
  });
  trimEvents();
}

function addRunEvent(runId, type, message, extra = {}) {
  const event = {
    id: makeId('evt'),
    runId,
    type,
    message,
    createdAt: now(),
    ...extra,
  };
  state.events.push(event);
  trimEvents();
  broadcast('run-event', event);
  return event;
}

function trimEvents() {
  if (state.events.length > 1200) {
    state.events = state.events.slice(state.events.length - 1200);
  }
}

function broadcast(type, payload) {
  const packet = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    res.write(packet);
  }
}

function broadcastState() {
  broadcast('state', publicState());
  broadcastHeartbeat();
  queueCloudPush('state_changed');
}

function presenceHeartbeat() {
  return {
    createdAt: now(),
    updatedAt: state?.updatedAt || null,
    agents: (state?.agents || []).map((agent) => ({
      id: agent.id,
      name: agent.name,
      status: agent.status || 'offline',
      runtime: agent.runtime || '',
      statusUpdatedAt: agent.statusUpdatedAt || null,
      heartbeatAt: agent.heartbeatAt || null,
      activeWorkItemIds: normalizeIds(agent.activeWorkItemIds || []),
      runtimeLastStartedAt: agent.runtimeLastStartedAt || null,
      runtimeLastTurnAt: agent.runtimeLastTurnAt || null,
    })),
  };
}

function broadcastHeartbeat() {
  broadcast('heartbeat', presenceHeartbeat());
}

function agentStatusIsBusy(status) {
  return ['starting', 'thinking', 'working', 'running', 'busy', 'queued'].includes(String(status || '').toLowerCase());
}

function setAgentStatus(agent, status, reason = 'status_update', extra = {}) {
  if (!agent) return null;
  const nextStatus = String(status || 'idle');
  const previousStatus = agent.status || 'offline';
  agent.status = nextStatus;
  agent.statusUpdatedAt = now();
  agent.heartbeatAt = agent.statusUpdatedAt;
  if (extra.activeWorkItemIds !== undefined) {
    agent.activeWorkItemIds = normalizeIds(extra.activeWorkItemIds);
  }
  if (previousStatus !== nextStatus || extra.forceEvent) {
    addSystemEvent('agent_status_changed', `${agent.name} is ${nextStatus}.`, {
      agentId: agent.id,
      previousStatus,
      status: nextStatus,
      reason,
      ...(extra.event || {}),
    });
  }
  return agent;
}

function reconcileAgentStatusHeartbeats() {
  if (!state?.agents?.length) return false;
  let changed = false;
  const activeAgentIds = new Set([...agentProcesses.keys()]);
  const threshold = Date.now() - AGENT_STATUS_STALE_MS;
  for (const agent of state.agents) {
    if (isBrainAgent(agent)) continue;
    if (activeAgentIds.has(agent.id)) {
      agent.heartbeatAt = now();
      continue;
    }
    if (agentStatusIsBusy(agent.status)) {
      const updated = Date.parse(agent.heartbeatAt || agent.statusUpdatedAt || agent.updatedAt || agent.createdAt || '');
      if (!Number.isFinite(updated) || updated < threshold) {
        setAgentStatus(agent, 'idle', 'stale_heartbeat_timeout');
        addSystemEvent('agent_status_recovered', `${agent.name} status reset to idle after missing heartbeat.`, { agentId: agent.id });
        changed = true;
      }
    }
  }
  return changed;
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

function cloudBearerToken(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function safeTokenEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireCloudAccess(req, res) {
  const expected = process.env.MAGCLAW_CLOUD_TOKEN || '';
  if (!expected) return true;
  if (safeTokenEqual(cloudBearerToken(req), expected)) return true;
  sendError(res, 401, 'Cloud access token is required.');
  return false;
}

function requireCloudDeploymentApi(req, res, url) {
  if (state?.connection?.deployment !== 'cloud') return true;
  if (!process.env.MAGCLAW_CLOUD_TOKEN) return true;
  const syncPaths = new Set(['/api/cloud/health', '/api/cloud/export-state', '/api/cloud/import-state']);
  if (syncPaths.has(url.pathname)) return true;
  if (safeTokenEqual(cloudBearerToken(req), process.env.MAGCLAW_CLOUD_TOKEN)) return true;
  sendError(res, 401, 'Cloud deployment API requires a bearer token.');
  return false;
}

function collectBody(req, maxBytes = MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await collectBody(req);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function attachmentPeriod(createdAt = new Date()) {
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt);
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return { year, month, relativeDir: `${year}/${month}` };
}

async function saveAttachmentBuffer({ name, type, buffer, source = 'upload', extra = {} }) {
  const id = makeId('att');
  const createdAt = now();
  const safeName = safeFileName(name);
  const period = attachmentPeriod(new Date(createdAt));
  const diskName = `${id}-${safeName}`;
  const dir = path.join(ATTACHMENTS_DIR, period.relativeDir);
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, diskName);
  await writeFile(filePath, buffer);
  return {
    id,
    name: safeName,
    type: type || 'application/octet-stream',
    bytes: buffer.length,
    path: filePath,
    relativePath: `${period.relativeDir}/${diskName}`,
    source,
    url: `/api/attachments/${id}/${encodeURIComponent(safeName)}`,
    createdAt,
    ...extra,
  };
}

function findProject(id) {
  return state.projects.find((project) => project.id === id);
}

function projectsForSpace(spaceType, spaceId) {
  return (state.projects || []).filter((project) => (
    project.spaceType === spaceType && project.spaceId === spaceId
  ));
}

async function searchProjectItems(spaceType, spaceId, query) {
  const projects = projectsForSpace(spaceType, spaceId);
  const batches = await Promise.all(projects.map((project) => searchProject(project, query, {
    onError: addSystemEvent,
  })));
  return sortProjectSearchResults(query, batches.flat());
}

function projectReferenceFromParts(kind, projectId, rawRelPath) {
  const project = findProject(String(projectId || ''));
  if (!project) return null;
  const referenceKind = kind === 'folder' ? 'folder' : 'file';
  const relPath = normalizeProjectRelPath(rawRelPath);
  const absolutePath = safePathWithin(project.path, relPath || '.');
  if (!absolutePath) return null;
  return {
    id: `${referenceKind}:${project.id}:${relPath}`,
    kind: referenceKind,
    projectId: project.id,
    projectName: project.name,
    name: relPath ? baseNameFromProjectPath(relPath, project.name) : project.name,
    path: relPath,
    absolutePath,
    token: `<#${referenceKind}:${project.id}:${encodeURIComponent(relPath)}>`,
  };
}

function extractLocalReferences(text) {
  const refs = [];
  const seen = new Set();
  const matches = String(text || '').matchAll(/<#(file|folder):([^:>]+):([^>]*)>/g);
  for (const match of matches) {
    const ref = projectReferenceFromParts(match[1], match[2], match[3]);
    if (!ref || seen.has(ref.id)) continue;
    seen.add(ref.id);
    refs.push(ref);
  }
  return refs;
}

function localReferenceLines(refs = []) {
  return refs.length
    ? refs.map((ref) => `- ${ref.kind} ${ref.name}: ${ref.absolutePath}`).join('\n')
    : '';
}

function listProjectTree(project, rawRelPath = '') {
  return listProjectTreeBase(project, rawRelPath, { onError: addSystemEvent });
}

function readProjectFilePreview(project, rawRelPath = '') {
  return readProjectFilePreviewBase(project, rawRelPath);
}

const conversationModel = createConversationModel({
  getState: () => state,
  httpError,
  makeId,
  now,
  extractLocalReferences,
  projectReferenceFromParts,
});
const {
  addSystemMessage,
  addTaskTimelineMessage,
  agentAvailableForAutoWork,
  agentIdleForAvailability,
  defaultReadBy,
  deliveryMessageMatchesScope,
  deliveryMessageMatchesTask,
  encodeVisibleMentions,
  extractMentions,
  findActor,
  findAgent,
  findChannel,
  findChannelByRef,
  findComputer,
  findConversationRecord,
  findDmByRef,
  findHuman,
  findMessage,
  findMessageByRef,
  findMission,
  findReply,
  findRun,
  findTask,
  findTaskForThreadMessage,
  findWorkItem,
  knownMentionEntries,
  messageMatchesScope,
  messageMatchesTask,
  nextTaskNumber,
  normalizeConversationRecord,
  prepareAgentResponseBody,
  renderMentionsForAgent,
  replaceBareActorIds,
  resolveConversationSpace,
  resolveMessageTarget,
  runMatchesScope,
  runMatchesTask,
  selectedDefaultSpaceId,
  shortTaskId,
  spaceDisplayName,
  spaceMatchesScope,
  stopScopeFromBody,
  targetForConversation,
  taskIsClosed,
  taskLabel,
  taskMatchesScope,
  taskScopeKey,
  taskThreadRecordIds,
  turnMetaAllWorkCancelled,
  turnMetaHasCancelledWork,
  turnMetaHasWorkOutsideScope,
  turnMetaMatchesScope,
  turnMetaMatchesTask,
  visibleMentionLabel,
  workItemIsCancelled,
  workItemMatchesScope,
  workItemMatchesTask,
} = conversationModel;

const agentWorkspace = createAgentWorkspaceManager({
  addSystemEvent,
  channelAgentIds,
  getState: () => state,
  isBrainAgent,
  now,
  AGENTS_DIR,
  CODEX_HOME_CONFIG_VERSION,
  CODEX_HOME_SHARED_ENTRIES,
  CODEX_HOME_STALE_SHARED_ENTRIES,
  MAX_AGENT_WORKSPACE_FILE_BYTES,
  MAX_AGENT_WORKSPACE_TREE_ENTRIES,
  SOURCE_CODEX_HOME,
});
const {
  agentDataDir,
  ensureAgentWorkspace,
  ensureAllAgentWorkspaces,
  listAgentWorkspace,
  prepareAgentCodexHome,
  readAgentWorkspaceFile,
  writeAgentSessionFile,
} = agentWorkspace;

function messageTimeMs(record) {
  const time = Date.parse(record?.createdAt || '');
  return Number.isFinite(time) ? time : 0;
}

const CONTEXTUAL_FOLLOWUP_WINDOW_MS = 30 * 60 * 1000;

function latestRouteEventForMessage(messageId, spaceId) {
  return [...(state.routeEvents || [])]
    .reverse()
    .find((event) => event.messageId === messageId
      && event.spaceType === 'channel'
      && (!spaceId || event.spaceId === spaceId));
}

function recentChannelMessageEntries(message, spaceId, windowMs = CONTEXTUAL_FOLLOWUP_WINDOW_MS) {
  const records = state.messages || [];
  const currentIndex = records.findIndex((record) => record.id === message?.id);
  const currentMs = messageTimeMs(message) || Date.now();
  return records
    .map((record, index) => ({ record, index, ms: messageTimeMs(record) }))
    .filter((entry) => entry.record.id !== message?.id
      && entry.record.spaceType === 'channel'
      && entry.record.spaceId === spaceId
      && (currentIndex < 0 || entry.index < currentIndex)
      && (!entry.ms || !currentMs || currentMs - entry.ms <= windowMs))
    .sort((a, b) => b.ms - a.ms || b.index - a.index);
}

function focusedRecentAgentForHumanFollowup(channelAgents, message, spaceId) {
  if (message?.authorType !== 'human') return null;
  if (!contextualAgentFollowupIntent(message?.body)) return null;

  const channelAgentById = new Map((channelAgents || [])
    .filter(agentParticipatesInChannels)
    .map((agent) => [agent.id, agent]));
  if (!channelAgentById.size) return null;

  const recent = recentChannelMessageEntries(message, spaceId);
  const lastHuman = recent.find((entry) => entry.record.authorType === 'human');
  if (lastHuman) {
    const routeEvent = latestRouteEventForMessage(lastHuman.record.id, spaceId);
    const routedIds = normalizeIds(routeEvent?.targetAgentIds || [])
      .filter((id) => channelAgentById.has(id));
    if (routedIds.length === 1) {
      return {
        agent: channelAgentById.get(routedIds[0]),
        source: 'recent_directed_human_message',
        referenceMessageId: lastHuman.record.id,
        routeEventId: routeEvent?.id || null,
      };
    }

    const agentIdsAfterLastHuman = normalizeIds(recent
      .filter((entry) => entry.index > lastHuman.index
        && entry.record.authorType === 'agent'
        && channelAgentById.has(entry.record.authorId))
      .map((entry) => entry.record.authorId));
    if (agentIdsAfterLastHuman.length === 1) {
      return {
        agent: channelAgentById.get(agentIdsAfterLastHuman[0]),
        source: 'single_recent_agent_reply',
        referenceMessageId: recent.find((entry) => entry.record.authorId === agentIdsAfterLastHuman[0])?.record.id || null,
        routeEventId: null,
      };
    }
  }

  const latest = recent[0]?.record || null;
  if (!lastHuman && latest?.authorType === 'agent' && channelAgentById.has(latest.authorId)) {
    return {
      agent: channelAgentById.get(latest.authorId),
      source: 'latest_agent_message',
      referenceMessageId: latest.id,
      routeEventId: null,
    };
  }
  return null;
}

function availabilityTargetAgentIds(channelAgents, record) {
  if (!record || record.authorType !== 'human') return [];
  if (!directAvailabilityIntent(record.body) && !availabilityBroadcastIntent(record.body)) return [];
  const channelIds = new Set((channelAgents || []).map((agent) => agent.id));
  const namedIds = (channelAgents || [])
    .filter((agent) => textAddressesAgent(agent, record.body))
    .map((agent) => agent.id);
  return normalizeIds([...(record.mentionedAgentIds || []), ...namedIds])
    .filter((id) => channelIds.has(id));
}

function recentAvailabilityContextAgentIds(channelAgents, message, spaceId) {
  const currentMs = messageTimeMs(message) || Date.now();
  const contextWindowMs = 30 * 60 * 1000;
  return [...(state.messages || [])]
    .filter((record) => record.id !== message?.id
      && record.spaceType === 'channel'
      && record.spaceId === spaceId
      && record.authorType === 'human')
    .sort((a, b) => messageTimeMs(b) - messageTimeMs(a))
    .map((record) => {
      const recordMs = messageTimeMs(record);
      if (recordMs && currentMs && currentMs - recordMs > contextWindowMs) return [];
      return availabilityTargetAgentIds(channelAgents, record);
    })
    .find((ids) => ids.length)
    || [];
}

function availabilityFollowupAgents(channelAgents, message, spaceId) {
  if (!availabilityFollowupIntent(message?.body)) return [];
  const previouslyAskedIds = new Set(recentAvailabilityContextAgentIds(channelAgents, message, spaceId));
  if (!previouslyAskedIds.size) return [];
  return uniqueAgents((channelAgents || [])
    .filter(agentIdleForAvailability)
    .filter((agent) => !previouslyAskedIds.has(agent.id)));
}

function dispatchSearchTerms(text) {
  const value = String(text || '')
    .toLowerCase()
    .replace(/<[@!#][^>]+>/g, ' ');
  const stopwords = new Set([
    'the', 'and', 'for', 'you', 'can', 'help', 'please', 'with', 'this', 'that',
    '知道', '帮忙', '帮我', '一下', '大家', '今天', '有空', '谁去', '谁能',
  ]);
  return value
    .split(/[^a-z0-9_.\-\u4e00-\u9fa5]+/i)
    .map((term) => term.trim())
    .filter((term) => term.length >= 2 && !stopwords.has(term))
    .slice(0, 24);
}

function agentDispatchHaystack(agent) {
  const personality = agent?.personality || {};
  const memory = agent?.memory || {};
  return [
    agent?.name,
    agent?.displayName,
    agent?.description,
    agent?.runtime,
    ...(Array.isArray(personality.interests) ? personality.interests : []),
    ...(Array.isArray(personality.traits) ? personality.traits : []),
    ...(Array.isArray(memory.knownTopics) ? memory.knownTopics : []),
  ].filter(Boolean).join(' ').toLowerCase();
}

function agentDispatchScore(agent, text) {
  if (!agentAvailableForAutoWork(agent)) return -Infinity;
  let score = 0;
  if (textAddressesAgent(agent, text)) score += 100;
  const haystack = agentDispatchHaystack(agent);
  for (const term of dispatchSearchTerms(text)) {
    if (haystack.includes(term)) score += Math.min(24, term.length * 3);
  }
  if (agentIdleForAvailability(agent)) score += 4;
  if (String(agent.status || '').toLowerCase() === 'working') score -= 2;
  if (agent.id === 'agt_codex') score += 0.1;
  return score;
}

function pickAvailableAgent(channelAgents, preferredIds = []) {
  const candidates = (channelAgents || []).filter(agentAvailableForAutoWork);
  if (!candidates.length) return null;
  for (const id of normalizeIds(preferredIds)) {
    const preferred = candidates.find((agent) => agent.id === id);
    if (preferred) return preferred;
  }
  return candidates.find((agent) => ['idle', 'online'].includes(String(agent.status || '').toLowerCase()))
    || candidates[0]
    || null;
}

function pickBestFitAgent(channelAgents, message, preferredIds = []) {
  const preferred = pickAvailableAgent(channelAgents, preferredIds);
  if (preferred && preferredIds.length) return preferred;
  const candidates = (channelAgents || []).filter(agentAvailableForAutoWork);
  if (!candidates.length) return null;
  const text = String(message?.body || '');
  const ranked = candidates
    .map((agent, index) => ({ agent, index, score: agentDispatchScore(agent, text) }))
    .sort((a, b) => b.score - a.score
      || (agentIdleForAvailability(b.agent) ? 1 : 0) - (agentIdleForAvailability(a.agent) ? 1 : 0)
      || a.index - b.index);
  return ranked[0]?.agent || null;
}

function uniqueAgents(agents) {
  return normalizeIds((agents || []).map((agent) => agent?.id))
    .map((id) => (agents || []).find((agent) => agent?.id === id))
    .filter(Boolean);
}

function cleanTaskTitle(text, fallback = 'Follow-up task') {
  const cleaned = String(text || '')
    .replace(/<[@!#][^>]+>/g, ' ')
    .replace(/(创建|新建|开启|开|建)(一个|个)?\s*(task|任务)/gi, ' ')
    .replace(/\b(create|make|open|start)\s+(a\s+)?task\b/gi, ' ')
    .replace(/^[\s，。！？；：、,.!?;:\-]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || fallback).slice(0, 120);
}

function titleFromThreadTaskIntent(parent, reply) {
  const replyTitle = cleanTaskTitle(reply?.body || '', '');
  if (replyTitle) return replyTitle;
  return cleanTaskTitle(parent?.body || '', 'Thread follow-up task');
}

function createOrClaimTaskForMessage(message, agent, options = {}) {
  if (!message || !agent) return null;
  const task = createTaskFromMessage(message, options.title || message.body, {
    assigneeIds: [agent.id],
    createdBy: options.createdBy || message.authorId,
  });
  if (!task.claimedBy) claimTask(task, agent.id, { force: false });
  return task;
}

function createTaskFromThreadIntent(parent, reply, agent) {
  const title = titleFromThreadTaskIntent(parent, reply);
  const body = [
    `Created from thread in ${spaceDisplayName(parent.spaceType, parent.spaceId)}.`,
    '',
    `Parent: ${renderMentionsForAgent(parent.body || '')}`,
    `Trigger: ${renderMentionsForAgent(reply.body || '')}`,
  ].join('\n');
  const result = createTaskMessage({
    title,
    body,
    spaceType: parent.spaceType,
    spaceId: parent.spaceId,
    authorType: 'agent',
    authorId: agent.id,
    assigneeIds: [agent.id],
    sourceMessageId: parent.id,
    sourceReplyId: reply.id,
  });
  claimTask(result.task, agent.id, { force: true });
  const ack = normalizeConversationRecord({
    id: makeId('rep'),
    parentMessageId: parent.id,
    spaceType: parent.spaceType,
    spaceId: parent.spaceId,
    authorType: 'agent',
    authorId: agent.id,
    body: `已创建并 claim ${taskLabel(result.task)}：${result.task.title}。我会在新的 task thread 里继续推进。`,
    attachmentIds: [],
    createdAt: now(),
    updatedAt: now(),
  });
  state.replies.push(ack);
  parent.replyCount = state.replies.filter((item) => item.parentMessageId === parent.id).length;
  parent.updatedAt = now();
  addCollabEvent('thread_task_created', `${agent.name} created ${taskLabel(result.task)} from a thread reply.`, {
    agentId: agent.id,
    taskId: result.task.id,
    sourceMessageId: parent.id,
    sourceReplyId: reply.id,
  });
  return { ...result, ackReply: ack };
}

function taskThreadDeliveryMessage(task, message, triggerReply, agent) {
  const trigger = renderMentionsForAgent(triggerReply?.body || '').trim();
  const details = String(task?.body || '').trim();
  const body = [
    `Task ${taskLabel(task)} has been created and claimed for you.`,
    `Title: ${task?.title || message?.body || 'Untitled task'}`,
    details ? `Context:\n${details}` : '',
    trigger ? `Trigger reply:\n${trigger}` : '',
    'Continue the work in this task thread. Reply with findings or results here, and move the task to in_review when ready for human validation.',
  ].filter(Boolean).join('\n\n');
  return {
    ...message,
    authorType: triggerReply?.authorType || 'human',
    authorId: triggerReply?.authorId || 'hum_local',
    body,
    mentionedAgentIds: normalizeIds([...(message?.mentionedAgentIds || []), agent?.id]),
    taskId: task?.id || message?.taskId || null,
  };
}

function shouldStartThreadForAgentDelivery(message) {
  if (!message || message.parentMessageId) return false;
  if (message.authorType !== 'human') return false;
  if (!message.id || !String(message.id).startsWith('msg_')) return false;
  if (message.taskId) return true;
  if (Array.isArray(message.attachmentIds) && message.attachmentIds.length > 0) return true;
  if (agentResponseIntent(message.body)) return true;
  return Array.isArray(message.mentionedAgentIds) && message.mentionedAgentIds.length > 0;
}

function finishTaskFromThread(task, actorId, replyId) {
  if (!task || taskIsClosed(task)) return false;
  task.status = 'done';
  task.completedAt = now();
  task.endIntentAt = task.endIntentAt || task.completedAt;
  task.claimedBy = task.claimedBy || actorId || null;
  if (task.claimedBy && task.claimedBy.startsWith('agt_')) {
    task.assigneeIds = normalizeIds([...(task.assigneeIds || []), task.claimedBy]);
    task.assigneeId = task.assigneeId || task.claimedBy;
  }
  addTaskHistory(task, 'ended_from_thread', 'Task ended from thread intent.', actorId || 'hum_local', { replyId });
  addTaskTimelineMessage(task, `✅ ${displayActor(actorId)} moved ${taskLabel(task)} to Done`, 'task_done');
  return true;
}

function stopTaskFromThread(task, actorId, replyId) {
  if (!task || taskIsClosed(task)) {
    return { changed: false, stoppedRuns: [], stoppedAgents: [], cancelledWorkItems: [] };
  }
  const stoppedAt = now();
  task.status = 'done';
  task.completedAt = task.completedAt || stoppedAt;
  task.endIntentAt = task.endIntentAt || stoppedAt;
  task.stoppedAt = task.stoppedAt || stoppedAt;
  task.reviewRequestedAt = null;
  task.updatedAt = now();
  addTaskHistory(task, 'stopped_done_from_thread', 'Task stopped from thread intent and marked Done.', actorId || 'hum_local', { replyId });
  addTaskTimelineMessage(task, `✓ ${displayActor(actorId)} stopped ${taskLabel(task)} and moved it to Done`, 'task_done');
  addCollabEvent('task_stopped_done_from_thread', `${displayActor(actorId)} stopped ${taskLabel(task)} from its thread and marked it Done.`, {
    taskId: task.id,
    actorId: actorId || 'hum_local',
    replyId,
  });
  const directlyCancelledWorkItems = cancelWorkItemsForTask(task);
  const stoppedRuns = stopRunsForTask(task);
  const steered = steerAgentProcessesForTaskStop(task, actorId, replyId);
  return {
    changed: true,
    stoppedRuns,
    stoppedAgents: [],
    steeredAgents: steered.steeredAgents,
    cancelledWorkItems: normalizeIds([...directlyCancelledWorkItems, ...steered.cancelledWorkItems]),
  };
}

function displayActor(id) {
  if (id === 'system') return 'Magclaw';
  if (id === 'agt_codex') return 'Codex Local';
  const human = findHuman(id);
  if (human) return human.name;
  const agent = findAgent(id);
  if (agent) return agent.name;
  return id || 'Someone';
}

function channelAgentIds(channel) {
  if (!channel) return [];
  if (channel.id === 'chan_all') return state.agents.filter(agentParticipatesInChannels).map((agent) => agent.id);
  return normalizeIds([...(channel.agentIds || []), ...(channel.memberIds || []).filter((id) => id.startsWith('agt_'))])
    .filter((id) => agentParticipatesInChannels(findAgent(id)));
}

function channelHumanIds(channel) {
  if (!channel) return [];
  if (channel.id === 'chan_all') return state.humans.map((human) => human.id);
  return normalizeIds([...(channel.humanIds || []), ...(channel.memberIds || []).filter((id) => id.startsWith('hum_'))]);
}

function directedPrimaryAgentId(mentions, message) {
  if (!Array.isArray(mentions?.agents) || mentions.agents.length < 2) return null;
  const visibleText = renderMentionsForAgent(message?.body || '').replace(/\s+/g, '');
  const ordered = mentions.agents
    .map((id) => {
      const actor = findAgent(id);
      const label = actor ? visibleMentionLabel(actor).replace(/\s+/g, '') : '';
      return { id, label, index: label ? visibleText.indexOf(label) : -1 };
    })
    .filter((item) => item.index >= 0)
    .sort((a, b) => a.index - b.index);
  if (ordered.length < 2) return null;

  const [first, second] = ordered;
  const bridge = visibleText.slice(first.index + first.label.length, second.index);
  if (/(你|请你|麻烦你|帮我|去)?(找|叫|问|联系|拉|邀请|带|和|跟)$/.test(bridge)) return first.id;
  if (/(你|请你|麻烦你|帮我).*(找|叫|问|联系|拉|邀请|带|和|跟)/.test(bridge)) return first.id;
  return null;
}

function textAddressesAgent(agent, text) {
  const raw = String(text || '');
  const aliases = normalizeIds([agent?.name, agent?.displayName]);
  for (const alias of aliases) {
    const value = String(alias || '').trim();
    if (!value) continue;
    if (/^[A-Za-z0-9_.-]+$/.test(value)) {
      const pattern = new RegExp(`(^|[^A-Za-z0-9_.-])@?${escapeRegExp(value)}(?=$|[^A-Za-z0-9_.-])`, 'i');
      if (pattern.test(raw)) return true;
    } else if (raw.toLowerCase().includes(value.toLowerCase())) {
      return true;
    }
  }
  return false;
}

function markdownSection(content, heading) {
  const lines = String(content || '').split(/\r?\n/);
  const target = String(heading || '').trim().toLowerCase();
  let start = -1;
  let level = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#{1,6})\s+(.+?)\s*$/);
    if (!match) continue;
    if (match[2].trim().toLowerCase() === target) {
      start = index + 1;
      level = match[1].length;
      break;
    }
  }
  if (start === -1) return '';
  const collected = [];
  for (let index = start; index < lines.length; index += 1) {
    const match = lines[index].match(/^(#{1,6})\s+/);
    if (match && match[1].length <= level) break;
    collected.push(lines[index]);
  }
  return collected.join('\n').trim();
}

function compactMarkdownText(value, limit = AGENT_CARD_TEXT_LIMIT) {
  return String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]+]\(([^)]+)\)/g, ' $1 ')
    .replace(/[#>*_\-[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

async function fileSignature(filePath) {
  const info = await stat(filePath).catch(() => null);
  if (!info?.isFile()) return 'missing';
  return `${info.size}:${Number(info.mtimeMs || 0).toFixed(0)}`;
}

async function readAgentCardFile(root, relPath, maxChars = AGENT_CARD_TEXT_LIMIT) {
  const filePath = safePathWithin(root, relPath);
  if (!filePath) return '';
  const content = await readFile(filePath, 'utf8').catch(() => '');
  return content.slice(0, maxChars);
}

function recentAgentTasks(agent) {
  return [...(state.tasks || [])]
    .filter((task) => task.claimedBy === agent.id || (task.assigneeIds || []).includes(agent.id))
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
    .slice(0, 6)
    .map((task) => `#${task.number || '?'} ${task.status || 'todo'} ${task.title || ''}`.trim());
}

function agentChannelNames(agent) {
  return (state.channels || [])
    .filter((channel) => !channel.archived && channelAgentIds(channel).includes(agent.id))
    .map((channel) => `#${channel.name}`);
}

async function buildAgentCard(agent) {
  if (!agent) return null;
  const root = agentDataDir(agent);
  const files = ['MEMORY.md', 'notes/profile.md', 'notes/agents.md', 'notes/work-log.md'];
  const signatureParts = await Promise.all(files.map((relPath) => fileSignature(path.join(root, relPath))));
  const signature = [
    agent.id,
    agent.name,
    agent.description,
    agent.status,
    agent.runtime,
    signatureParts.join('|'),
    (state.tasks || []).length,
  ].join('::');
  const cached = agentCardCache.get(agent.id);
  if (cached?.signature === signature) return cached.card;

  const [memory, profile, peers, workLog] = await Promise.all(files.map((relPath) => readAgentCardFile(root, relPath)));
  const role = markdownSection(memory, 'Role') || markdownSection(profile, 'Role') || agent.description || '';
  const capabilities = [
    markdownSection(memory, 'Capabilities'),
    markdownSection(profile, 'Strengths And Skills'),
    markdownSection(profile, 'Skills'),
    markdownSection(memory, 'Key Knowledge'),
  ].filter(Boolean).join('\n');
  const activeContext = markdownSection(memory, 'Active Context');
  const collaboration = [
    markdownSection(memory, 'Collaboration Rules'),
    markdownSection(profile, 'Response Boundaries'),
  ].filter(Boolean).join('\n');
  const recentTasks = recentAgentTasks(agent);
  const card = {
    id: agent.id,
    name: agent.name,
    description: agent.description || '',
    runtime: agent.runtime || '',
    status: agent.status || 'offline',
    systemRole: agent.systemRole || '',
    isBrain: isBrainAgent(agent),
    channels: agentChannelNames(agent),
    role: compactMarkdownText(role, 1600),
    capabilities: compactMarkdownText(capabilities || profile, 2200),
    collaboration: compactMarkdownText(collaboration, 1600),
    activeContext: compactMarkdownText(activeContext, 1400),
    peers: compactMarkdownText(peers, 1800),
    workLog: compactMarkdownText(workLog, 2200),
    recentTasks,
    haystack: compactMarkdownText([
      agent.name,
      agent.displayName,
      agent.description,
      agent.runtime,
      role,
      capabilities,
      activeContext,
      peers,
      workLog,
      recentTasks.join(' '),
    ].filter(Boolean).join('\n'), 9000).toLowerCase(),
    sourceFiles: files,
  };
  agentCardCache.set(agent.id, { signature, card });
  return card;
}

async function buildAgentCards(agents) {
  const cards = await Promise.all((agents || []).map((agent) => buildAgentCard(agent).catch((error) => {
    addSystemEvent('agent_card_error', `Could not build agent card for ${agent?.name || 'agent'}: ${error.message}`, {
      agentId: agent?.id || null,
    });
    return null;
  })));
  return new Map(cards.filter(Boolean).map((card) => [card.id, card]));
}

function threadParticipantAgentIds(message, linkedTask = null) {
  const ids = [];
  if (message?.authorType === 'agent') ids.push(message.authorId);
  ids.push(...(message?.mentionedAgentIds || []));
  ids.push(...(latestRouteEventForMessage(message?.id, message?.spaceId)?.targetAgentIds || []));
  if (linkedTask?.claimedBy) ids.push(linkedTask.claimedBy);
  ids.push(...(linkedTask?.assigneeIds || []));
  ids.push(...state.replies
    .filter((reply) => reply.parentMessageId === message?.id && reply.authorType === 'agent')
    .map((reply) => reply.authorId));
  return normalizeIds(ids);
}

function determineThreadRespondingAgents(message, reply, channelAgents, mentions, linkedTask = null) {
  if (mentions.agents.length || mentions.special.length) {
    return determineRespondingAgents(channelAgents, mentions, reply, message.spaceId);
  }
  const named = channelAgents.filter((agent) => textAddressesAgent(agent, reply.body));
  if (named.length) return named;
  const participantIds = threadParticipantAgentIds(message, linkedTask);
  const participants = participantIds
    .map((id) => channelAgents.find((agent) => agent.id === id))
    .filter(Boolean);
  if (participants.length) return normalizeIds(participants.map((agent) => agent.id))
    .map((id) => participants.find((agent) => agent.id === id))
    .filter(Boolean);
  if (reply?.authorType === 'human' && agentResponseIntent(reply.body)) {
    const agent = pickAvailableAgent(channelAgents);
    return agent ? [agent] : [];
  }
  return [];
}

function routeEvidence(type, value) {
  return { type, value: String(value || '').slice(0, 240) };
}

function namedAgentsOutsideExplicitMentions(channelAgents, text, mentionedIds = []) {
  const explicit = new Set(normalizeIds(mentionedIds));
  return availableChannelAgents(channelAgents)
    .filter((agent) => !explicit.has(agent.id))
    .filter((agent) => textAddressesAgent(agent, text));
}

function agentReferenceVariants(agent) {
  const variants = new Set();
  for (const alias of [agent?.name, agent?.displayName]) {
    const value = String(alias || '').trim();
    if (!value) continue;
    variants.add(value);
    if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
      if (value.length >= 2) variants.add(value.slice(-2));
      if (value.length >= 3) variants.add(value.slice(-3));
      const first = value.slice(0, 1);
      if (/[\u4e00-\u9fa5]/.test(first)) {
        variants.add(`${first}道友`);
        variants.add(`${first}老师`);
        variants.add(`${first}师`);
      }
    }
  }
  return [...variants].filter((variant) => variant.length >= 2);
}

function implicitAgentReferences(channelAgents, text, mentionedIds = []) {
  const explicit = new Set(normalizeIds(mentionedIds));
  const raw = String(text || '').toLowerCase();
  if (!raw.trim()) return [];
  return availableChannelAgents(channelAgents)
    .filter((agent) => !explicit.has(agent.id))
    .filter((agent) => agentReferenceVariants(agent).some((variant) => raw.includes(variant.toLowerCase())));
}

function fanoutApiTriggerReason({ channelAgents, mentions, message, thread = null }) {
  if (!fanoutApiConfigured()) return null;
  if (message?.authorType !== 'human') return null;
  const text = String(message?.body || '');
  if (!text.trim()) return null;
  if (mentions.special.includes('all') || mentions.special.includes('everyone')) return null;
  if (mentions.special.includes('here') || mentions.special.includes('channel')) return null;

  const extraNamed = namedAgentsOutsideExplicitMentions(channelAgents, text, mentions.agents);
  const implicitNamed = implicitAgentReferences(channelAgents, text, mentions.agents);
  if (thread) {
    const threadParticipantIds = normalizeIds(thread.participantAgentIds || []);
    const combinedNamed = uniqueAgents([...extraNamed, ...implicitNamed]);
    if (mentions.agents.length && combinedNamed.length) {
      return {
        type: 'thread_explicit_mention_plus_named_agent',
        reason: 'Thread reply explicitly @mentions one agent and also appears to reference another agent.',
        namedAgentIds: combinedNamed.map((agent) => agent.id),
        participantAgentIds: threadParticipantIds,
      };
    }
    if (!mentions.agents.length && combinedNamed.length) {
      return {
        type: 'thread_named_agent',
        reason: 'Thread reply names or nicknames one or more agents; semantic routing should decide the reply targets.',
        namedAgentIds: combinedNamed.map((agent) => agent.id),
        participantAgentIds: threadParticipantIds,
      };
    }
    if (!mentions.agents.length && threadParticipantIds.length > 1) {
      return {
        type: 'thread_reply_semantic',
        reason: 'Thread reply has multiple possible agent participants and needs semantic routing.',
        namedAgentIds: [],
        participantAgentIds: threadParticipantIds,
      };
    }
    if (agentCapabilityQuestionIntent(text)) {
      return {
        type: 'thread_capability_question',
        reason: 'Thread capability comparison should use all agent cards before deciding fan-out.',
        namedAgentIds: combinedNamed.map((agent) => agent.id),
        participantAgentIds: threadParticipantIds,
      };
    }
    if (autoTaskMessageIntent(text)) {
      return {
        type: 'thread_task_claim',
        reason: 'Thread work request needs semantic routing and a single claimant when possible.',
        namedAgentIds: combinedNamed.map((agent) => agent.id),
        participantAgentIds: threadParticipantIds,
      };
    }
  }
  if (mentions.agents.length && extraNamed.length) {
    return {
      type: 'explicit_mention_plus_named_agent',
      reason: 'Message explicitly @mentions one agent and also names another channel agent.',
      namedAgentIds: extraNamed.map((agent) => agent.id),
    };
  }
  if (mentions.agents.length) return null;
  if (!mentions.agents.length && extraNamed.length > 1) {
    return {
      type: 'multiple_named_agents',
      reason: 'Message names multiple channel agents without explicit @mentions.',
      namedAgentIds: extraNamed.map((agent) => agent.id),
    };
  }
  if (agentCapabilityQuestionIntent(text)) {
    return {
      type: 'capability_question',
      reason: 'Capability comparison should use all agent cards before deciding fan-out.',
      namedAgentIds: extraNamed.map((agent) => agent.id),
    };
  }
  if (autoTaskMessageIntent(text)) {
    return {
      type: 'task_claim',
      reason: 'Concrete work request needs semantic routing and a single claimant when possible.',
      namedAgentIds: extraNamed.map((agent) => agent.id),
    };
  }
  return null;
}

function serializeFanoutCard(card, channelAgentIds) {
  const channelMember = channelAgentIds.has(card.id);
  return {
    id: card.id,
    name: card.name,
    description: card.description,
    status: card.status,
    channels: card.channels || [],
    channelMember,
    selectable: channelMember,
    role: card.role || '',
    capabilities: card.capabilities || '',
    activeContext: card.activeContext || '',
    collaboration: card.collaboration || '',
    recentTasks: card.recentTasks || [],
    sourceFiles: card.sourceFiles || [],
  };
}

function fanoutConversationRecord(record) {
  if (!record) return null;
  return {
    id: record.id || null,
    parentMessageId: record.parentMessageId || null,
    authorType: record.authorType || 'unknown',
    authorId: record.authorId || null,
    authorName: displayActor(record.authorId),
    body: renderMentionsForAgent(record.body || ''),
    mentionedAgentIds: normalizeIds(record.mentionedAgentIds || []),
    taskId: record.taskId || null,
    createdAt: record.createdAt || null,
  };
}

function threadFanoutContext(parentMessage, reply, linkedTask = null) {
  if (!parentMessage) return null;
  const participantAgentIds = threadParticipantAgentIds(parentMessage, linkedTask);
  const recentReplies = [...(state.replies || [])]
    .filter((item) => item.parentMessageId === parentMessage.id)
    .sort((a, b) => messageTimeMs(a) - messageTimeMs(b))
    .slice(-10);
  return {
    parentMessage: fanoutConversationRecord(parentMessage),
    currentReplyId: reply?.id || null,
    participantAgentIds,
    participantAgents: participantAgentIds
      .map((id) => findAgent(id))
      .filter(Boolean)
      .map((agent) => ({
        id: agent.id,
        name: agent.name,
        description: agent.description || '',
        status: agent.status || '',
      })),
    linkedTask: linkedTask ? {
      id: linkedTask.id,
      number: linkedTask.number || null,
      title: linkedTask.title || '',
      status: linkedTask.status || '',
      claimedBy: linkedTask.claimedBy || null,
      assigneeIds: normalizeIds(linkedTask.assigneeIds || []),
    } : null,
    recentReplies: recentReplies.map(fanoutConversationRecord),
  };
}

function fanoutApiMessages({ channelAgents, mentions, message, allCards, trigger, thread = null }) {
  const channelAgentIds = new Set((channelAgents || []).map((agent) => agent.id));
  const availableIds = availableChannelAgents(channelAgents).map((agent) => agent.id);
  const payload = {
    message: {
      id: message?.id || null,
      parentMessageId: message?.parentMessageId || null,
      authorType: message?.authorType || 'human',
      body: renderMentionsForAgent(message?.body || ''),
      mentionedAgentIds: normalizeIds(mentions.agents),
      specialMentions: normalizeIds(mentions.special),
    },
    thread,
    trigger,
    allowedChannelAgentIds: availableIds,
    channelAgents: (channelAgents || []).map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description || '',
      status: agent.status || '',
    })),
    agentCards: [...(allCards?.values?.() || [])].map((card) => serializeFanoutCard(card, channelAgentIds)),
    outputSchema: {
      mode: 'directed | broadcast | availability | task_claim | contextual_follow_up | passive_awareness',
      targetAgentIds: ['agt_id'],
      claimantAgentId: 'agt_id or null',
      confidence: 'number from 0 to 1',
      reason: 'short routing explanation',
      taskIntent: { title: 'short title', kind: 'coding | research | docs | ops | planning | unknown' },
    },
  };
  return [
    {
      role: 'system',
      content: [
        'You are Magclaw fan-out router.',
        'Decide which selectable channel agents should receive this message.',
        'Use all agent cards for capability awareness, but targetAgentIds and claimantAgentId must be chosen only from allowedChannelAgentIds.',
        'Prefer one claimant for concrete work. Use broadcast only for open group discussion or capability comparison.',
        'For thread replies, use the parent message, recent replies, participants, and nicknames/titles to avoid waking unrelated agents.',
        'If a thread reply is simple chat, prefer the smallest useful target set; use passive_awareness with no targets if no agent should answer.',
        'Return only a single JSON object matching the requested schema. Do not include markdown.',
      ].join(' '),
    },
    {
      role: 'user',
      content: JSON.stringify(payload),
    },
  ];
}

async function callFanoutApi({ channelAgents, mentions, message, spaceId, allCards, trigger, thread = null }) {
  const config = normalizeFanoutApiConfig(state.settings?.fanoutApi || {});
  if (!fanoutApiConfigured(config)) throw new Error('Fan-out API is not fully configured.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  const startedAt = Date.now();
  try {
    const response = await fetch(fanoutApiEndpoint(config.baseUrl), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: fanoutApiMessages({ channelAgents, mentions, message, spaceId, allCards, trigger, thread }),
        temperature: 0,
      }),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      throw new Error(data?.error?.message || data?.message || response.statusText);
    }
    const rawDecision = parseFanoutApiJson(fanoutApiResponseText(data));
    const latencyMs = Date.now() - startedAt;
    const decision = normalizeRouteDecision({
      ...rawDecision,
      targetAgentIds: rawDecision.targetAgentIds || rawDecision.agentIds || rawDecision.targets || [],
      claimantAgentId: rawDecision.claimantAgentId || null,
      reason: rawDecision.reason || 'Fan-out API selected agents.',
      evidence: [
        routeEvidence('llm_trigger', trigger?.type || 'semantic'),
        routeEvidence('llm_reason', trigger?.reason || ''),
        routeEvidence('llm_model', config.model),
        routeEvidence('llm_latency_ms', String(latencyMs)),
        ...(Array.isArray(rawDecision.evidence) ? rawDecision.evidence : []),
      ],
      llmUsed: true,
      llmAttempted: true,
      llmLatencyMs: latencyMs,
      llmModel: config.model,
      llmBaseUrl: config.baseUrl,
      strategy: 'llm',
    }, channelAgents);
    return decision;
  } finally {
    clearTimeout(timeout);
  }
}

function selectBrainAgent() {
  const activeId = state.router?.brainAgentId || null;
  const active = activeId
    ? (state.brainAgents || []).find((brain) => brain.id === activeId && brain.active && brain.runtime)
    : null;
  return active || null;
}

function findBrainAgent(id) {
  return (state.brainAgents || []).find((brain) => brain.id === id) || null;
}

function activateBrainAgent(brainId) {
  const brain = findBrainAgent(brainId);
  if (!brain) throw httpError(404, 'Brain Agent not found.');
  if (!brain.runtime) throw httpError(400, 'Brain Agent runtime must be configured before activation.');
  for (const item of state.brainAgents || []) {
    item.active = item.id === brain.id;
    item.status = item.runtime ? 'configured' : 'offline';
    item.updatedAt = item.id === brain.id ? now() : item.updatedAt;
  }
  state.router = {
    mode: 'brain_agent',
    brainAgentId: brain.id,
    fallback: 'rules',
    cardSource: 'workspace_markdown',
    ...(state.router || {}),
  };
  state.router.mode = 'brain_agent';
  state.router.brainAgentId = brain.id;
  return brain;
}

function deactivateBrainAgent(brainId = null) {
  for (const item of state.brainAgents || []) {
    if (!brainId || item.id === brainId) {
      item.active = false;
      item.status = item.runtime ? 'configured' : 'offline';
      item.updatedAt = now();
    }
  }
  if (!brainId || state.router?.brainAgentId === brainId) {
    state.router = {
      mode: 'rules_fallback',
      brainAgentId: null,
      fallback: 'rules',
      cardSource: 'workspace_markdown',
      ...(state.router || {}),
    };
    state.router.mode = 'rules_fallback';
    state.router.brainAgentId = null;
  }
}

function createBrainAgentConfig(body = {}) {
  const runtime = String(body.runtime || '').trim();
  if (!runtime || isLegacyBrainRuntime(runtime)) throw httpError(400, 'Brain Agent runtime is required.');
  const brain = normalizeBrainAgentConfig({
    runtime,
    model: body.model || state.settings?.model,
    computerId: body.computerId || 'cmp_local',
    workspace: body.workspace || state.settings?.defaultWorkspace || ROOT,
    reasoningEffort: body.reasoningEffort || null,
    createdAt: now(),
    updatedAt: now(),
  });
  state.brainAgents.push(brain);
  const shouldActivate = body.active === true || (body.active === undefined && !selectBrainAgent());
  if (shouldActivate) activateBrainAgent(brain.id);
  return brain;
}

function updateBrainAgentConfig(brain, body = {}) {
  if (!brain) throw httpError(404, 'Brain Agent not found.');
  const next = {
    ...brain,
    runtime: body.runtime !== undefined ? String(body.runtime || '').trim() : brain.runtime,
    model: body.model !== undefined ? body.model : brain.model,
    computerId: body.computerId !== undefined ? body.computerId : brain.computerId,
    workspace: body.workspace !== undefined ? body.workspace : brain.workspace,
    reasoningEffort: body.reasoningEffort !== undefined ? body.reasoningEffort : brain.reasoningEffort,
    updatedAt: now(),
  };
  const normalized = normalizeBrainAgentConfig(next, { active: brain.active });
  if (!normalized.runtime) throw httpError(400, 'Brain Agent runtime is required.');
  Object.assign(brain, normalized);
  if (body.active === true) activateBrainAgent(brain.id);
  if (body.active === false) deactivateBrainAgent(brain.id);
  return brain;
}

function availableChannelAgents(channelAgents) {
  return (channelAgents || [])
    .filter(agentParticipatesInChannels)
    .filter(agentAvailableForAutoWork);
}

function idleChannelAgents(channelAgents) {
  return availableChannelAgents(channelAgents).filter(agentIdleForAvailability);
}

function agentDispatchScoreFromCard(agent, card, text) {
  if (!agentAvailableForAutoWork(agent)) return -Infinity;
  let score = agentDispatchScore(agent, text);
  const haystack = String(card?.haystack || agentDispatchHaystack(agent)).toLowerCase();
  for (const term of dispatchSearchTerms(text)) {
    if (haystack.includes(term)) score += Math.min(36, term.length * 4);
  }
  if (card?.recentTasks?.length) score += Math.min(3, card.recentTasks.length * 0.4);
  if (String(agent.status || '').toLowerCase() === 'idle') score += 3;
  return score;
}

function pickBestFitAgentWithCards(channelAgents, message, cards, preferredIds = []) {
  const preferred = pickAvailableAgent(channelAgents, preferredIds);
  if (preferred && preferredIds.length) return { agent: preferred, score: 999 };
  const candidates = availableChannelAgents(channelAgents);
  if (!candidates.length) return { agent: null, score: -Infinity };
  const text = String(message?.body || '');
  const ranked = candidates
    .map((agent, index) => ({
      agent,
      index,
      score: agentDispatchScoreFromCard(agent, cards?.get(agent.id), text),
    }))
    .sort((a, b) => b.score - a.score
      || (agentIdleForAvailability(b.agent) ? 1 : 0) - (agentIdleForAvailability(a.agent) ? 1 : 0)
      || a.index - b.index);
  return ranked[0] || { agent: null, score: -Infinity };
}

function normalizeRouteDecision(decision, channelAgents) {
  const allowed = new Set((channelAgents || []).map((agent) => agent.id));
  const targetAgentIds = normalizeIds(decision?.targetAgentIds || []).filter((id) => allowed.has(id));
  const claimantAgentId = targetAgentIds.includes(decision?.claimantAgentId)
    ? decision.claimantAgentId
    : null;
  const llmUsed = Boolean(decision?.llmUsed);
  const fallbackUsed = Boolean(decision?.fallbackUsed);
  return {
    mode: decision?.mode || 'passive_awareness',
    targetAgentIds,
    claimantAgentId,
    confidence: Number.isFinite(Number(decision?.confidence)) ? Number(decision.confidence) : 0.5,
    reason: String(decision?.reason || 'Router selected agents.'),
    evidence: Array.isArray(decision?.evidence) ? decision.evidence : [],
    taskIntent: decision?.taskIntent || null,
    brainAgentId: decision?.brainAgentId || null,
    fallbackUsed,
    strategy: decision?.strategy || (llmUsed ? 'llm' : (fallbackUsed ? 'fallback_rules' : 'rules')),
    llmUsed,
    llmAttempted: Boolean(decision?.llmAttempted || llmUsed),
    llmLatencyMs: Number.isFinite(Number(decision?.llmLatencyMs)) ? Number(decision.llmLatencyMs) : null,
    llmModel: decision?.llmModel ? String(decision.llmModel) : null,
    llmBaseUrl: decision?.llmBaseUrl ? String(decision.llmBaseUrl) : null,
  };
}

function evaluateBrainRouteDecision({ channelAgents, mentions, message, spaceId, cards, brainAgent = null, fallbackUsed = false, fallbackError = null }) {
  const available = availableChannelAgents(channelAgents);
  const idle = idleChannelAgents(channelAgents);
  const text = String(message?.body || '');
  const evidence = [
    routeEvidence('router', brainAgent?.name || 'rules'),
    routeEvidence('channel_member', `${available.length}/${channelAgents.length} available member agents`),
    ...(fallbackError ? [routeEvidence('fallback_error', fallbackError.message || fallbackError)] : []),
  ];
  const baseDecision = {
    brainAgentId: brainAgent?.id || null,
    fallbackUsed,
    strategy: fallbackUsed ? 'fallback_rules' : 'rules',
    llmAttempted: Boolean(fallbackError),
  };

  if (mentions.agents.length > 0) {
    const directedPrimary = message?.authorType === 'human' ? directedPrimaryAgentId(mentions, message) : null;
    const targetAgentIds = directedPrimary
      ? [directedPrimary]
      : mentions.agents.filter((id) => available.some((agent) => agent.id === id));
    return normalizeRouteDecision({
      mode: 'directed',
      targetAgentIds,
      confidence: 0.98,
      reason: directedPrimary
        ? 'Explicit multi-agent mention looked like a request for the first named agent to coordinate.'
        : 'Explicit agent mention routes to the mentioned agent(s).',
      evidence: [...evidence, routeEvidence('mention', mentions.agents.join(', '))],
      ...baseDecision,
    }, channelAgents);
  }

  if (mentions.special.includes('all') || mentions.special.includes('everyone')) {
    return normalizeRouteDecision({
      mode: 'broadcast',
      targetAgentIds: available.map((agent) => agent.id),
      confidence: 0.95,
      reason: '@all/@everyone wakes every available channel agent.',
      evidence: [...evidence, routeEvidence('mention', '@all')],
      ...baseDecision,
    }, channelAgents);
  }

  if (mentions.special.includes('here') || mentions.special.includes('channel')) {
    return normalizeRouteDecision({
      mode: 'availability',
      targetAgentIds: idle.map((agent) => agent.id),
      confidence: 0.92,
      reason: '@here/@channel wakes idle/online channel agents.',
      evidence: [...evidence, routeEvidence('status', `${idle.length} idle/online agents`)],
      ...baseDecision,
    }, channelAgents);
  }

  if (message?.authorType === 'human') {
    const named = available.filter((agent) => textAddressesAgent(agent, text));
    if (named.length) {
      return normalizeRouteDecision({
        mode: directAvailabilityIntent(text) ? 'availability' : 'directed',
        targetAgentIds: named.map((agent) => agent.id),
        confidence: 0.93,
        reason: 'Natural-language agent name matched a channel member.',
        evidence: [...evidence, routeEvidence('mention', named.map((agent) => agent.name).join(', '))],
        ...baseDecision,
      }, channelAgents);
    }

    const followupAgents = availabilityFollowupAgents(channelAgents, message, spaceId);
    if (followupAgents.length) {
      return normalizeRouteDecision({
        mode: 'follow_up',
        targetAgentIds: followupAgents.map((agent) => agent.id),
        confidence: 0.88,
        reason: 'Availability follow-up targets remaining idle agents from recent channel context.',
        evidence: [...evidence, routeEvidence('recent_context', 'availability follow-up')],
        ...baseDecision,
      }, channelAgents);
    }

    const focusedFollowup = focusedRecentAgentForHumanFollowup(channelAgents, message, spaceId);
    if (focusedFollowup?.agent) {
      return normalizeRouteDecision({
        mode: 'contextual_follow_up',
        targetAgentIds: [focusedFollowup.agent.id],
        confidence: 0.89,
        reason: `Recent single-agent context indicates this follow-up is for ${focusedFollowup.agent.name}.`,
        evidence: [
          ...evidence,
          routeEvidence('recent_context', focusedFollowup.source),
          routeEvidence('reference_message', focusedFollowup.referenceMessageId || ''),
          routeEvidence('reference_route', focusedFollowup.routeEventId || ''),
        ],
        ...baseDecision,
      }, channelAgents);
    }

    if (availabilityBroadcastIntent(text)) {
      return normalizeRouteDecision({
        mode: 'availability',
        targetAgentIds: idle.map((agent) => agent.id),
        confidence: 0.9,
        reason: 'Availability check should let available channel agents answer for themselves.',
        evidence: [...evidence, routeEvidence('status', `${idle.length} idle/online agents`)],
        ...baseDecision,
      }, channelAgents);
    }

    if (agentCapabilityQuestionIntent(text)) {
      return normalizeRouteDecision({
        mode: 'broadcast',
        targetAgentIds: available.map((agent) => agent.id),
        confidence: 0.86,
        reason: 'Capability or identity comparison needs agents to self-report and sense each other.',
        evidence: [...evidence, routeEvidence('agent_card', 'capability comparison')],
        ...baseDecision,
      }, channelAgents);
    }

    if (autoTaskMessageIntent(text)) {
      const best = pickBestFitAgentWithCards(channelAgents, message, cards, mentions.agents || []);
      return normalizeRouteDecision({
        mode: 'task_claim',
        targetAgentIds: best.agent ? [best.agent.id] : [],
        claimantAgentId: best.agent?.id || null,
        confidence: best.agent ? Math.min(0.94, Math.max(0.66, 0.62 + (best.score / 200))) : 0.2,
        reason: best.agent
          ? `Concrete work detected; ${best.agent.name} is the best-fit claimant from agent card scoring.`
          : 'Concrete work detected but no available channel agent could claim it.',
        evidence: [
          ...evidence,
          routeEvidence('agent_card', best.agent ? `${best.agent.name} score=${Number(best.score || 0).toFixed(1)}` : 'none'),
          routeEvidence('task_lock', 'claim before execution'),
        ],
        taskIntent: best.agent ? {
          title: cleanTaskTitle(text),
          kind: inferTaskIntentKind(text),
        } : null,
        ...baseDecision,
      }, channelAgents);
    }

    return normalizeRouteDecision({
      mode: channelGreetingIntent(text) ? 'broadcast' : 'broadcast',
      targetAgentIds: available.map((agent) => agent.id),
      confidence: channelGreetingIntent(text) ? 0.82 : 0.74,
      reason: 'Open human channel message fans out to available member agents.',
      evidence,
      ...baseDecision,
    }, channelAgents);
  }

  const targetAgentIds = available
    .filter((agent) => shouldAgentRespond(agent, message, spaceId))
    .map((agent) => agent.id);
  return normalizeRouteDecision({
    mode: 'passive_awareness',
    targetAgentIds,
    confidence: 0.5,
    reason: 'Non-human message used passive awareness fallback.',
    evidence,
    ...baseDecision,
  }, channelAgents);
}

function legacyRouteDecision(channelAgents, mentions, message, spaceId, error = null) {
  const agents = determineRespondingAgents(channelAgents, mentions, message, spaceId);
  const claimant = message?.authorType === 'human' && autoTaskMessageIntent(message.body)
    ? pickBestFitAgent(channelAgents, message)
    : null;
  const focusedFollowup = focusedRecentAgentForHumanFollowup(channelAgents, message, spaceId);
  const isContextualFollowup = Boolean(focusedFollowup?.agent
    && agents.length === 1
    && agents[0]?.id === focusedFollowup.agent.id);
  const isDirected = Boolean(!claimant
    && !isContextualFollowup
    && message?.authorType === 'human'
    && agents.length
    && agents.length < availableChannelAgents(channelAgents).length);
  return normalizeRouteDecision({
    mode: claimant ? 'task_claim' : (isContextualFollowup ? 'contextual_follow_up' : (isDirected ? 'directed' : 'broadcast')),
    targetAgentIds: agents.map((agent) => agent.id),
    claimantAgentId: claimant?.id || null,
    confidence: isContextualFollowup ? 0.76 : 0.45,
    reason: isContextualFollowup
      ? `Rules fallback kept the recent focused conversation with ${focusedFollowup.agent.name}.`
      : (error ? `Fan-out router failed; rules fallback used: ${error.message}` : 'Rules fallback selected agents.'),
    evidence: [
      routeEvidence('fallback', error?.message || 'legacy rules'),
      ...(isContextualFollowup ? [
        routeEvidence('recent_context', focusedFollowup.source),
        routeEvidence('reference_message', focusedFollowup.referenceMessageId || ''),
        routeEvidence('reference_route', focusedFollowup.routeEventId || ''),
      ] : []),
    ],
    taskIntent: claimant ? { title: cleanTaskTitle(message?.body || ''), kind: inferTaskIntentKind(message?.body || '') } : null,
    brainAgentId: selectBrainAgent()?.id || null,
    fallbackUsed: true,
  }, channelAgents);
}

function addRouteEvent(decision, { message, spaceType = 'channel', spaceId = null } = {}) {
  state.routeEvents = Array.isArray(state.routeEvents) ? state.routeEvents : [];
  const event = {
    id: makeId('route'),
    messageId: message?.id || null,
    parentMessageId: message?.parentMessageId || null,
    spaceType,
    spaceId,
    mode: decision.mode,
    targetAgentIds: decision.targetAgentIds,
    claimantAgentId: decision.claimantAgentId || null,
    confidence: decision.confidence,
    reason: decision.reason,
    evidence: decision.evidence || [],
    taskIntent: decision.taskIntent || null,
    brainAgentId: decision.brainAgentId || null,
    fallbackUsed: Boolean(decision.fallbackUsed),
    strategy: decision.strategy || (decision.llmUsed ? 'llm' : (decision.fallbackUsed ? 'fallback_rules' : 'rules')),
    llmUsed: Boolean(decision.llmUsed),
    llmAttempted: Boolean(decision.llmAttempted || decision.llmUsed),
    llmLatencyMs: Number.isFinite(Number(decision.llmLatencyMs)) ? Number(decision.llmLatencyMs) : null,
    llmModel: decision.llmModel || null,
    createdAt: now(),
  };
  state.routeEvents.push(event);
  if (state.routeEvents.length > ROUTE_EVENTS_LIMIT) {
    state.routeEvents = state.routeEvents.slice(state.routeEvents.length - ROUTE_EVENTS_LIMIT);
  }
  addSystemEvent('route_decision', `Route ${event.mode}: ${event.targetAgentIds.length} agent(s) selected.`, {
    routeEventId: event.id,
    messageId: event.messageId,
    parentMessageId: event.parentMessageId,
    spaceType: event.spaceType,
    spaceId: event.spaceId,
    mode: event.mode,
    targetAgentIds: event.targetAgentIds,
    claimantAgentId: event.claimantAgentId,
    confidence: event.confidence,
    reason: event.reason,
    evidence: event.evidence,
    taskIntent: event.taskIntent,
    brainAgentId: event.brainAgentId,
    fallbackUsed: event.fallbackUsed,
    strategy: event.strategy,
    llmUsed: event.llmUsed,
    llmAttempted: event.llmAttempted,
    llmLatencyMs: event.llmLatencyMs,
    llmModel: event.llmModel,
  });
  return event;
}

async function routeMessageForChannel({ channelAgents, mentions, message, spaceId }) {
  try {
    const allRoutingAgents = (state.agents || []).filter(agentParticipatesInChannels);
    const allCards = await buildAgentCards(allRoutingAgents);
    const trigger = fanoutApiTriggerReason({ channelAgents, mentions, message });
    if (trigger) {
      try {
        const decision = await callFanoutApi({ channelAgents, mentions, message, spaceId, allCards, trigger });
        const routeEvent = addRouteEvent(decision, { message, spaceId });
        return { ...decision, routeEvent };
      } catch (error) {
        const decision = evaluateBrainRouteDecision({
          channelAgents,
          mentions,
          message,
          spaceId,
          cards: allCards,
          fallbackUsed: true,
          fallbackError: error,
        });
        const routeEvent = addRouteEvent(decision, { message, spaceId });
        return { ...decision, routeEvent };
      }
    }
    const decision = evaluateBrainRouteDecision({
      channelAgents,
      mentions,
      message,
      spaceId,
      cards: allCards,
      fallbackUsed: !fanoutApiConfigured(),
    });
    const routeEvent = addRouteEvent(decision, { message, spaceId });
    return { ...decision, routeEvent };
  } catch (error) {
    const decision = legacyRouteDecision(channelAgents, mentions, message, spaceId, error);
    const routeEvent = addRouteEvent(decision, { message, spaceId });
    return { ...decision, routeEvent };
  }
}

function evaluateThreadRouteDecision({ channelAgents, mentions, parentMessage, reply, linkedTask = null, fallbackUsed = false, fallbackError = null }) {
  const respondingAgents = determineThreadRespondingAgents(parentMessage, reply, channelAgents, mentions, linkedTask);
  const named = (channelAgents || []).filter((agent) => textAddressesAgent(agent, reply?.body));
  const evidence = [
    routeEvidence('router', 'thread_rules'),
    routeEvidence('thread_parent', parentMessage?.id || ''),
    routeEvidence('thread_participants', threadParticipantAgentIds(parentMessage, linkedTask).join(', ')),
    ...(fallbackError ? [routeEvidence('fallback_error', fallbackError.message || fallbackError)] : []),
  ];
  const hasExplicitMention = Boolean(mentions.agents.length || mentions.special.length || named.length);
  let mode = 'passive_awareness';
  if (mentions.special.includes('all') || mentions.special.includes('everyone')) {
    mode = 'broadcast';
  } else if (mentions.special.includes('here') || mentions.special.includes('channel')) {
    mode = 'availability';
  } else if (hasExplicitMention) {
    mode = 'directed';
  } else if (respondingAgents.length) {
    mode = 'contextual_follow_up';
  }
  return normalizeRouteDecision({
    mode,
    targetAgentIds: respondingAgents.map((agent) => agent.id),
    confidence: hasExplicitMention ? 0.9 : (respondingAgents.length ? 0.72 : 0.4),
    reason: fallbackError
      ? `Thread fan-out router failed; rules fallback used: ${fallbackError.message}`
      : (respondingAgents.length ? 'Thread rules selected responding agents.' : 'Thread rules found no agent that needs to answer.'),
    evidence,
    fallbackUsed,
    strategy: fallbackUsed ? 'fallback_rules' : 'rules',
    llmAttempted: Boolean(fallbackError),
  }, channelAgents);
}

async function routeThreadReplyForChannel({ channelAgents, mentions, parentMessage, reply, linkedTask = null, spaceId }) {
  try {
    const thread = threadFanoutContext(parentMessage, reply, linkedTask);
    const trigger = fanoutApiTriggerReason({ channelAgents, mentions, message: reply, thread });
    if (trigger) {
      try {
        const allRoutingAgents = (state.agents || []).filter(agentParticipatesInChannels);
        const allCards = await buildAgentCards(allRoutingAgents);
        const decision = await callFanoutApi({ channelAgents, mentions, message: reply, spaceId, allCards, trigger, thread });
        const routeEvent = addRouteEvent(decision, { message: reply, spaceId });
        return { ...decision, routeEvent };
      } catch (error) {
        const decision = evaluateThreadRouteDecision({
          channelAgents,
          mentions,
          parentMessage,
          reply,
          linkedTask,
          fallbackUsed: true,
          fallbackError: error,
        });
        const routeEvent = addRouteEvent(decision, { message: reply, spaceId });
        return { ...decision, routeEvent };
      }
    }
    const decision = evaluateThreadRouteDecision({
      channelAgents,
      mentions,
      parentMessage,
      reply,
      linkedTask,
      fallbackUsed: !fanoutApiConfigured(),
    });
    const routeEvent = addRouteEvent(decision, { message: reply, spaceId });
    return { ...decision, routeEvent };
  } catch (error) {
    const decision = evaluateThreadRouteDecision({
      channelAgents,
      mentions,
      parentMessage,
      reply,
      linkedTask,
      fallbackUsed: true,
      fallbackError: error,
    });
    const routeEvent = addRouteEvent(decision, { message: reply, spaceId });
    return { ...decision, routeEvent };
  }
}

// Determine which agents should respond based on mentions and personality
function determineRespondingAgents(channelAgents, mentions, message, spaceId) {
  const respondingAgents = [];

  // Case 1: Specific agent(s) mentioned via <@agt_xxx>
  if (mentions.agents.length > 0) {
    const directedPrimary = message?.authorType === 'human' ? directedPrimaryAgentId(mentions, message) : null;
    if (directedPrimary) {
      const agent = channelAgents.find(a => a.id === directedPrimary);
      return agent ? [agent] : [];
    }
    for (const agentId of mentions.agents) {
      const agent = channelAgents.find(a => a.id === agentId);
      if (agent) respondingAgents.push(agent);
    }
    return respondingAgents;
  }

  // Case 2: @all or @everyone - all available agents respond
  if (mentions.special.includes('all') || mentions.special.includes('everyone')) {
    return channelAgents.filter(agentAvailableForAutoWork);
  }

  // Case 3: @here - only online/idle agents respond
  if (mentions.special.includes('here') || mentions.special.includes('channel')) {
    return channelAgents.filter(agentIdleForAvailability);
  }

  // Case 4: Top-level human channel messages follow Slock-style channel membership.
  if (message?.authorType === 'human') {
    const named = channelAgents.filter((agent) => textAddressesAgent(agent, message.body));
    if (named.length) return uniqueAgents(named.filter(agentAvailableForAutoWork));
    const followupAgents = availabilityFollowupAgents(channelAgents, message, spaceId);
    if (followupAgents.length) return followupAgents;
    const focusedFollowup = focusedRecentAgentForHumanFollowup(channelAgents, message, spaceId);
    if (focusedFollowup?.agent) return [focusedFollowup.agent];
    if (autoTaskMessageIntent(message.body)) {
      const agent = pickBestFitAgent(channelAgents, message);
      return agent ? [agent] : [];
    }
    return channelAgents.filter(agentAvailableForAutoWork);
  }

  // Case 5: Non-human messages without mentions can still use personality-based routing.
  for (const agent of channelAgents) {
    if (shouldAgentRespond(agent, message, spaceId)) {
      respondingAgents.push(agent);
    }
  }

  return respondingAgents;
}

// Personality-based decision: should this agent respond without direct mention?
function shouldAgentRespond(agent, message, spaceId) {
  const personality = agent.personality || {};
  const memory = agent.memory || {};
  const proactivity = typeof personality.proactivity === 'number' ? personality.proactivity : 0.3;

  // Base score starts at proactivity level
  let score = proactivity;

  // Factor 1: Message mentions topics in agent's interests
  const interests = personality.interests || [];
  const messageText = (message.body || '').toLowerCase();
  const topicMatch = interests.some(topic => messageText.includes(topic.toLowerCase()));
  if (topicMatch) score += 0.3;

  // Factor 2: Agent has recent context in this space (within 30 minutes)
  const recentThreshold = 30 * 60 * 1000;
  const hasRecentContext = (memory.conversationSummaries || []).some(
    s => s.spaceId === spaceId && Date.now() - new Date(s.updatedAt).getTime() < recentThreshold
  );
  if (hasRecentContext) score += 0.2;

  // Factor 3: Random factor for natural variation
  const randomFactor = Math.random() * 0.3;

  // Decision: respond if combined score exceeds threshold
  return (score + randomFactor) > 0.6;
}

function normalizeName(value, fallback) {
  return String(value || fallback || '')
    .trim()
    .replace(/^#/, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 48);
}

function addCollabEvent(type, message, extra = {}) {
  addSystemEvent(type, message, extra);
}

function addTaskHistory(task, type, message, actorId = 'hum_local', extra = {}) {
  task.history = Array.isArray(task.history) ? task.history : [];
  const item = {
    id: makeId('hist'),
    type,
    message,
    actorId,
    createdAt: now(),
    ...extra,
  };
  task.history.push(item);
  task.updatedAt = now();
  return item;
}

function memoryEventTitle(trigger, payload = {}) {
  if (payload.task) return `${trigger}: ${taskLabel(payload.task)} ${payload.task.title || ''}`.trim();
  if (payload.channel) return `${trigger}: #${payload.channel.name}`;
  if (payload.message) return `${trigger}: ${String(payload.message.body || '').slice(0, 90)}`;
  return trigger;
}

function markdownBulletText(value) {
  return String(value || '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 260);
}

function upsertMarkdownBullet(content, heading, bullet, maxItems = 10) {
  const lines = String(content || '').split(/\r?\n/);
  const headingLine = `## ${heading}`;
  let headingIndex = lines.findIndex((line) => line.trim().toLowerCase() === headingLine.toLowerCase());
  if (headingIndex === -1) {
    const suffix = lines.length && lines[lines.length - 1].trim() ? ['', headingLine, bullet] : [headingLine, bullet];
    return [...lines, ...suffix].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }
  let endIndex = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^#{1,6}\s+/.test(lines[index])) {
      endIndex = index;
      break;
    }
  }
  const before = lines.slice(0, headingIndex + 1);
  const section = lines.slice(headingIndex + 1, endIndex).filter((line) => line.trim());
  const after = lines.slice(endIndex);
  const bullets = [bullet, ...section.filter((line) => line.trim() !== bullet.trim())]
    .filter((line) => line.trim().startsWith('- '))
    .slice(0, maxItems);
  return [...before, ...bullets, '', ...after].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

async function appendAgentMemoryNote(agent, relPath, heading, bullet) {
  const root = await ensureAgentWorkspace(agent);
  const filePath = safePathWithin(root, relPath);
  if (!filePath) return;
  const existing = await readFile(filePath, 'utf8').catch(() => `# ${agent.name} ${path.basename(relPath, '.md')}\n`);
  await writeFile(filePath, upsertMarkdownBullet(existing, heading, bullet));
}

async function updateAgentMemoryEntrypoint(agent, bullet) {
  const root = await ensureAgentWorkspace(agent);
  const memoryPath = safePathWithin(root, 'MEMORY.md');
  if (!memoryPath) return;
  const existing = await readFile(memoryPath, 'utf8').catch(() => defaultAgentMemory(agent));
  await writeFile(memoryPath, upsertMarkdownBullet(existing, 'Recent Memory Updates', bullet, 8));
}

function memoryWritebackBullet(trigger, payload = {}) {
  const stamp = now();
  if (payload.task) {
    const task = payload.task;
    return `- ${stamp} [${trigger}] ${taskLabel(task)} ${markdownBulletText(task.title)} status=${task.status || 'todo'} channel=${spaceDisplayName(task.spaceType, task.spaceId)}`;
  }
  if (payload.channel) {
    const channel = payload.channel;
    const members = channelAgentIds(channel).map((id) => displayActor(id)).join(', ') || 'no agent members';
    return `- ${stamp} [${trigger}] #${channel.name} members=${markdownBulletText(members)} description=${markdownBulletText(channel.description || 'none')}`;
  }
  if (payload.message) {
    return `- ${stamp} [${trigger}] ${spaceDisplayName(payload.spaceType || payload.message.spaceType, payload.spaceId || payload.message.spaceId)} ${markdownBulletText(payload.message.body)}`;
  }
  if (payload.routeEvent) {
    return `- ${stamp} [${trigger}] route=${payload.routeEvent.mode} targets=${payload.routeEvent.targetAgentIds?.map(displayActor).join(', ') || 'none'} reason=${markdownBulletText(payload.routeEvent.reason)}`;
  }
  return `- ${stamp} [${trigger}] ${markdownBulletText(memoryEventTitle(trigger, payload))}`;
}

async function writeAgentMemoryUpdate(agent, trigger, payload = {}) {
  if (!agent || isBrainAgent(agent)) return false;
  const bullet = memoryWritebackBullet(trigger, payload);
  await appendAgentMemoryNote(agent, 'notes/work-log.md', 'Memory Writebacks', bullet);
  await updateAgentMemoryEntrypoint(agent, bullet);
  if (payload.channel) {
    await appendAgentMemoryNote(agent, 'notes/channels.md', 'Channel Memory', bullet);
  }
  if (payload.routeEvent || payload.peerAgentIds?.length) {
    await appendAgentMemoryNote(agent, 'notes/agents.md', 'Observed Collaboration', bullet);
  }
  addSystemEvent('agent_memory_writeback', `${agent.name} workspace memory updated for ${trigger}.`, {
    agentId: agent.id,
    trigger,
    taskId: payload.task?.id || null,
    messageId: payload.message?.id || null,
    channelId: payload.channel?.id || payload.spaceId || null,
  });
  agentCardCache.delete(agent.id);
  return true;
}

function scheduleAgentMemoryWriteback(agent, trigger, payload = {}) {
  if (!agent || isBrainAgent(agent)) return;
  writeAgentMemoryUpdate(agent, trigger, payload)
    .then((changed) => (changed ? persistState().then(broadcastState) : null))
    .catch((error) => {
      addSystemEvent('agent_memory_writeback_error', `Memory writeback failed for ${agent.name}: ${error.message}`, {
        agentId: agent.id,
        trigger,
      });
      persistState().then(broadcastState).catch(() => {});
    });
}

function addSystemReply(parentMessageId, body) {
  const parent = findMessage(parentMessageId);
  if (!parent) return null;
  const reply = normalizeConversationRecord({
    id: makeId('rep'),
    parentMessageId,
    spaceType: parent.spaceType,
    spaceId: parent.spaceId,
    authorType: 'system',
    authorId: 'system',
    body,
    attachmentIds: [],
    createdAt: now(),
    updatedAt: now(),
  });
  state.replies.push(reply);
  parent.replyCount = state.replies.filter((item) => item.parentMessageId === parentMessageId).length;
  parent.updatedAt = now();
  return reply;
}

function cloudSnapshot() {
  const allowedKeys = ['humans', 'computers', 'agents', 'brainAgents', 'channels', 'dms', 'messages', 'replies', 'tasks', 'missions', 'runs', 'attachments', 'projects', 'workItems', 'routeEvents', 'events'];
  const snapshot = {
    version: state.version,
    exportedAt: now(),
    workspaceId: state.connection?.workspaceId || 'local',
    protocolVersion: CLOUD_PROTOCOL_VERSION,
    router: state.router || {},
  };
  for (const key of allowedKeys) {
    snapshot[key] = Array.isArray(state[key]) ? state[key] : [];
  }
  return snapshot;
}

function applyCloudSnapshot(snapshot) {
  const allowedKeys = ['humans', 'computers', 'agents', 'brainAgents', 'channels', 'dms', 'messages', 'replies', 'tasks', 'missions', 'runs', 'attachments', 'projects', 'workItems', 'routeEvents', 'events'];
  for (const key of allowedKeys) {
    if (Array.isArray(snapshot?.[key])) state[key] = snapshot[key];
  }
  if (snapshot?.router && typeof snapshot.router === 'object') state.router = snapshot.router;
  migrateState();
}

function cloudEndpoint(pathname) {
  const base = normalizeCloudUrl(state.connection?.controlPlaneUrl || '');
  if (!base) throw new Error('Cloud control plane URL is not configured.');
  return `${base}${pathname}`;
}

async function cloudFetch(pathname, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  const cloudToken = String(state.connection?.cloudToken || process.env.MAGCLAW_CLOUD_TOKEN || '');
  const headers = {
    'content-type': 'application/json',
    'x-magclaw-device-id': state.connection?.deviceId || '',
    'x-magclaw-workspace-id': state.connection?.workspaceId || '',
    ...(cloudToken ? { authorization: `Bearer ${cloudToken}` } : {}),
    ...(options.headers || {}),
  };
  try {
    const response = await fetch(cloudEndpoint(pathname), {
      ...options,
      signal: controller.signal,
      headers,
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function pushStateToCloud(reason = 'manual') {
  if (!state.connection?.controlPlaneUrl) throw new Error('Cloud control plane URL is not configured.');
  syncInProgress = true;
  try {
    const result = await cloudFetch('/api/cloud/import-state', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: state.connection.workspaceId || 'local',
        deviceId: state.connection.deviceId,
        reason,
        snapshot: cloudSnapshot(),
      }),
    });
    state.connection.lastSyncAt = now();
    state.connection.lastSyncDirection = 'push';
    state.connection.lastError = '';
    await persistState();
    return result;
  } catch (error) {
    state.connection.lastError = error.message;
    await persistState();
    throw error;
  } finally {
    syncInProgress = false;
  }
}

async function pullStateFromCloud() {
  if (!state.connection?.controlPlaneUrl) throw new Error('Cloud control plane URL is not configured.');
  syncInProgress = true;
  try {
    const result = await cloudFetch(`/api/cloud/export-state?workspaceId=${encodeURIComponent(state.connection.workspaceId || 'local')}`);
    applyCloudSnapshot(result.snapshot || result);
    state.connection.lastSyncAt = now();
    state.connection.lastSyncDirection = 'pull';
    state.connection.lastError = '';
    await persistState();
    return result;
  } catch (error) {
    state.connection.lastError = error.message;
    await persistState();
    throw error;
  } finally {
    syncInProgress = false;
  }
}

function queueCloudPush(reason) {
  if (syncInProgress) return;
  if (state?.connection?.mode !== 'cloud') return;
  if (!state.connection.autoSync) return;
  if (!state.connection.controlPlaneUrl) return;
  if (!['paired', 'connected'].includes(state.connection.pairingStatus)) return;
  clearTimeout(cloudPushTimer);
  cloudPushTimer = setTimeout(() => {
    pushStateToCloud(reason).catch(() => {});
  }, 900);
}

function ensureTaskThread(task) {
  if (task.threadMessageId && findMessage(task.threadMessageId)) return findMessage(task.threadMessageId);
  if (task.messageId && findMessage(task.messageId)) {
    task.threadMessageId = task.messageId;
    return findMessage(task.messageId);
  }

  const message = normalizeConversationRecord({
    id: makeId('msg'),
    spaceType: task.spaceType,
    spaceId: task.spaceId,
    authorType: String(task.createdBy || '').startsWith('agt_') ? 'agent' : 'human',
    authorId: task.createdBy || 'hum_local',
    body: task.title || 'Untitled task',
    attachmentIds: Array.isArray(task.attachmentIds) ? task.attachmentIds : [],
    replyCount: 0,
    savedBy: [],
    taskId: task.id,
    createdAt: task.createdAt || now(),
    updatedAt: now(),
  });
  state.messages.push(message);
  task.messageId = message.id;
  task.threadMessageId = message.id;
  return message;
}

function publicState() {
  return {
    ...state,
    settings: publicSettings(),
    channels: (state.channels || []).filter((channel) => !channel.archived),
    connection: publicConnection(),
    runtime: runtimeSnapshot(),
    runningRunIds: [...runningProcesses.keys()],
  };
}

function publicSettings() {
  const fanoutApi = normalizeFanoutApiConfig(state?.settings?.fanoutApi || {});
  const { apiKey, ...settings } = state?.settings || {};
  void apiKey;
  return {
    ...settings,
    fanoutApi: {
      enabled: fanoutApi.enabled,
      baseUrl: fanoutApi.baseUrl,
      model: fanoutApi.model,
      timeoutMs: fanoutApi.timeoutMs,
      hasApiKey: Boolean(fanoutApi.apiKey),
      apiKeyPreview: publicApiKeyPreview(fanoutApi.apiKey),
      configured: fanoutApiConfigured(fanoutApi),
    },
  };
}

function publicConnection() {
  const { cloudToken, ...connection } = state?.connection || {};
  return {
    ...connection,
    hasControlPlane: Boolean(state?.connection?.controlPlaneUrl),
    hasRelay: Boolean(state?.connection?.relayUrl),
    hasCloudToken: Boolean(cloudToken || process.env.MAGCLAW_CLOUD_TOKEN),
  };
}

function updateFanoutApiConfig(body = {}) {
  const current = normalizeFanoutApiConfig(state.settings?.fanoutApi || {});
  const next = {
    ...current,
    enabled: body.enabled !== undefined ? Boolean(body.enabled) : current.enabled,
    baseUrl: body.baseUrl !== undefined ? normalizeCloudUrl(body.baseUrl || '') : current.baseUrl,
    model: body.model !== undefined ? String(body.model || '').trim() : current.model,
    timeoutMs: body.timeoutMs !== undefined ? Number(body.timeoutMs) : current.timeoutMs,
  };
  if (body.clearApiKey === true) {
    next.apiKey = '';
  } else if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
    next.apiKey = body.apiKey.trim();
  }
  state.settings.fanoutApi = normalizeFanoutApiConfig(next);
  state.router = {
    ...(state.router || {}),
    mode: fanoutApiConfigured() ? 'llm_fanout' : 'rules_fallback',
    brainAgentId: null,
    fallback: 'rules',
    cardSource: 'workspace_markdown',
  };
  return state.settings.fanoutApi;
}

function runtimeSnapshot() {
  return {
    node: process.version,
    platform: `${os.platform()} ${os.arch()}`,
    host: os.hostname(),
    codexPath: state?.settings?.codexPath || 'codex',
  };
}

async function getRuntimeInfo() {
  const codexPath = state.settings.codexPath || 'codex';
  const version = await execText(codexPath, ['--version']).catch((error) => error.message);
  return {
    ...runtimeSnapshot(),
    codexVersion: version.trim(),
    port: PORT,
    dataDir: DATA_DIR,
  };
}

async function getCodexModels(codexPath) {
  try {
    const output = await execText(codexPath, ['debug', 'models']);
    const data = JSON.parse(output);
    const models = [];
    let defaultModel = null;
    let reasoningEfforts = [];

    for (const m of data.models || []) {
      if (m.visibility === 'list') {
        models.push({
          slug: m.slug,
          name: m.display_name || m.slug,
        });
        if (!defaultModel) {
          defaultModel = m.slug;
          reasoningEfforts = (m.supported_reasoning_levels || []).map(r => r.effort);
        }
      }
    }
    return { models, defaultModel, reasoningEfforts };
  } catch {
    return {
      models: [{ slug: 'gpt-5.5', name: 'GPT-5.5' }],
      defaultModel: 'gpt-5.5',
      reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
    };
  }
}

async function detectInstalledRuntimes() {
  const runtimes = [];

  // Codex CLI
  try {
    const codexPath = state.settings.codexPath || 'codex';
    const version = await execText(codexPath, ['--version']);
    const { models, defaultModel, reasoningEfforts } = await getCodexModels(codexPath);
    runtimes.push({
      id: 'codex',
      name: 'Codex CLI',
      path: codexPath,
      version: version.trim(),
      installed: true,
      models: models.map(m => m.slug),
      modelNames: models,
      defaultModel,
      reasoningEffort: reasoningEfforts,
      defaultReasoningEffort: 'medium',
    });
  } catch {
    runtimes.push({ id: 'codex', name: 'Codex CLI', installed: false });
  }

  // Claude Code
  try {
    const claudeVersion = await execText('claude', ['--version']);
    runtimes.push({
      id: 'claude-code',
      name: 'Claude Code',
      path: 'claude',
      version: claudeVersion.trim(),
      installed: true,
      models: ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5-20251001'],
      defaultModel: 'claude-sonnet-4-6',
    });
  } catch {
    runtimes.push({ id: 'claude-code', name: 'Claude Code', installed: false });
  }

  // OpenCode
  try {
    const openCodeVersion = await execText('opencode', ['--version']);
    runtimes.push({
      id: 'opencode',
      name: 'OpenCode',
      path: 'opencode',
      version: openCodeVersion.trim(),
      installed: true,
      models: ['gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'],
      defaultModel: 'gpt-4o',
    });
  } catch {
    runtimes.push({ id: 'opencode', name: 'OpenCode', installed: false });
  }

  // Goose
  try {
    const gooseVersion = await execText('goose', ['--version']);
    runtimes.push({
      id: 'goose',
      name: 'Goose',
      path: 'goose',
      version: gooseVersion.trim(),
      installed: true,
      models: ['gpt-4o', 'claude-3-opus', 'claude-3-sonnet'],
      defaultModel: 'gpt-4o',
    });
  } catch {
    runtimes.push({ id: 'goose', name: 'Goose', installed: false });
  }

  // Aider
  try {
    const aiderVersion = await execText('aider', ['--version']);
    runtimes.push({
      id: 'aider',
      name: 'Aider',
      path: 'aider',
      version: aiderVersion.trim(),
      installed: true,
      models: ['gpt-4o', 'claude-3-opus', 'claude-3-sonnet', 'deepseek-coder'],
      defaultModel: 'gpt-4o',
    });
  } catch {
    runtimes.push({ id: 'aider', name: 'Aider', installed: false });
  }

  return runtimes;
}

function execText(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

function execFileResult(command, args, options = {}) {
  return new Promise((resolve) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      resolve({
        code: typeof error?.code === 'number' ? error.code : 0,
        signal: error?.signal || null,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        error,
      });
    });
  });
}

function appleScriptString(value) {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

async function pickFolderPath(defaultPath = '') {
  if (Object.prototype.hasOwnProperty.call(process.env, 'MAGCLAW_PICK_FOLDER_PATH')) {
    const picked = String(process.env.MAGCLAW_PICK_FOLDER_PATH || '').trim();
    return picked ? path.resolve(picked) : null;
  }
  if (process.platform !== 'darwin') {
    throw httpError(501, 'Native folder picker is currently available on macOS only.');
  }

  let defaultLocation = '';
  const candidate = path.resolve(String(defaultPath || state.settings?.defaultWorkspace || ROOT));
  try {
    const info = await stat(candidate);
    defaultLocation = info.isDirectory() ? candidate : path.dirname(candidate);
  } catch {
    defaultLocation = ROOT;
  }

  const args = [
    '-e', `set defaultFolder to POSIX file ${appleScriptString(defaultLocation)} as alias`,
    '-e', 'try',
    '-e', '  set pickedFolder to choose folder with prompt "Open Project Folder" default location defaultFolder',
    '-e', '  POSIX path of pickedFolder',
    '-e', 'on error number -128',
    '-e', '  return ""',
    '-e', 'end try',
  ];
  const result = await execFileResult('osascript', args);
  if (result.error && result.code !== 0) {
    throw httpError(500, result.stderr.trim() || result.error.message || 'Folder picker failed.');
  }
  const picked = result.stdout.trim();
  return picked ? path.resolve(picked) : null;
}

async function addProjectFolder({ rawPath, name = '', spaceType = 'channel', spaceId = '' }) {
  const normalizedSpaceType = spaceType === 'dm' ? 'dm' : 'channel';
  const normalizedSpaceId = String(spaceId || selectedDefaultSpaceId(normalizedSpaceType));
  const cleanPath = String(rawPath || '').trim();
  if (!cleanPath) throw httpError(400, 'Project folder path is required.');
  const projectPath = path.resolve(cleanPath);

  let info;
  try {
    info = await stat(projectPath);
  } catch (error) {
    addSystemEvent('project_add_failed', `Project folder not found: ${projectPath}`, { error: error.message });
    throw httpError(404, 'Project folder was not found on the Magclaw server.');
  }
  if (!info.isDirectory()) throw httpError(400, 'Project path must be a directory.');

  const existing = state.projects.find((project) => (
    project.spaceType === normalizedSpaceType && project.spaceId === normalizedSpaceId && project.path === projectPath
  ));
  if (existing) {
    return { project: existing, projects: projectsForSpace(normalizedSpaceType, normalizedSpaceId), created: false };
  }

  const project = {
    id: makeId('prj'),
    name: String(name || path.basename(projectPath) || 'Project').trim().slice(0, 80),
    path: projectPath,
    spaceType: normalizedSpaceType,
    spaceId: normalizedSpaceId,
    createdAt: now(),
    updatedAt: now(),
  };
  state.projects.push(project);
  addSystemEvent('project_added', `Project folder added: ${project.name}`, {
    projectId: project.id,
    spaceType: normalizedSpaceType,
    spaceId: normalizedSpaceId,
  });
  await persistState();
  broadcastState();
  return { project, projects: projectsForSpace(normalizedSpaceType, normalizedSpaceId), created: true };
}

function createPrompt(mission, run, attachments) {
  const contract = {
    goal: mission.goal,
    workspace: mission.workspace,
    scopeAllow: mission.scopeAllow,
    scopeDeny: mission.scopeDeny,
    gates: mission.gates,
    evidenceRequired: mission.evidenceRequired,
    humanCheckpoints: mission.humanCheckpoints,
    localReferences: mission.localReferences || [],
  };

  const attachmentLines = attachments.length
    ? attachments.map((item) => `- ${item.name} (${item.type || 'file'}): ${item.path}`).join('\n')
    : '- none';

  return [
    'You are Codex running under Magclaw local mission control.',
    '',
    'Mission contract:',
    JSON.stringify(contract, null, 2),
    '',
    'Operating rules:',
    '- Stay inside the mission scope unless the user explicitly asks otherwise.',
    '- Prefer small, verifiable changes.',
    '- Run the requested gates when practical.',
    '- End with a concise evidence report: changed files, tests run, residual risks.',
    '- Do not claim completion if evidence is missing.',
    '',
    `Run id: ${run.id}`,
    `Mission id: ${mission.id}`,
    '',
    'Attachments saved locally:',
    attachmentLines,
    '',
    'Local project references are original files/folders, not attachment copies:',
    localReferenceLines(mission.localReferences || []) || '- none',
    '',
    'User request:',
    mission.goal,
  ].join('\n');
}

function summarizeCodexEvent(event) {
  if (!event || typeof event !== 'object') return String(event || '');
  const candidates = [
    event.message,
    event.text,
    event.output,
    event.delta,
    event.type,
    event.msg?.message,
    event.msg?.text,
    event.item?.text,
    event.item?.message,
  ].filter(Boolean);

  if (candidates.length) return String(candidates[0]);
  return JSON.stringify(event).slice(0, 600);
}

function handleCodexLine(run, line) {
  if (!line.trim()) return;
  try {
    const event = JSON.parse(line);
    addRunEvent(run.id, 'codex', summarizeCodexEvent(event), { raw: event });
  } catch {
    addRunEvent(run.id, 'stdout', line);
  }
}

function startCodexRun(mission, run) {
  const workspace = path.resolve(mission.workspace || state.settings.defaultWorkspace || ROOT);
  const attachments = state.attachments.filter((item) => mission.attachmentIds.includes(item.id));
  const imageAttachments = attachments.filter((item) => String(item.type || '').startsWith('image/'));
  const outputFile = path.join(RUNS_DIR, `${run.id}-last-message.txt`);
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    state.settings.sandbox || 'workspace-write',
    '-C',
    workspace,
    '-o',
    outputFile,
  ];

  if (state.settings.model) {
    args.push('-m', state.settings.model);
  }

  for (const image of imageAttachments) {
    args.push('-i', image.path);
  }

  args.push('-');

  run.status = 'running';
  run.startedAt = now();
  run.workspace = workspace;
  run.command = `${state.settings.codexPath} ${args.map((arg) => (arg.includes(' ') ? JSON.stringify(arg) : arg)).join(' ')}`;
  mission.status = 'running';
  mission.updatedAt = now();
  addRunEvent(run.id, 'runner', `Starting Codex in ${workspace}`);
  persistState().then(broadcastState);

  const child = spawn(state.settings.codexPath || 'codex', args, {
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

  runningProcesses.set(run.id, child);

  let stdoutBuffer = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) handleCodexLine(run, line);
    persistState();
  });

  child.stderr.on('data', (chunk) => {
    const message = chunk.toString().trim();
    if (message) addRunEvent(run.id, 'stderr', message);
    persistState();
  });

  child.on('error', (error) => {
    runningProcesses.delete(run.id);
    run.status = 'failed';
    run.completedAt = now();
    run.exitCode = null;
    mission.status = 'failed';
    mission.updatedAt = now();
    addRunEvent(run.id, 'runner-error', error.message);
    persistState().then(broadcastState);
  });

  child.on('close', async (code) => {
    runningProcesses.delete(run.id);
    if (stdoutBuffer.trim()) handleCodexLine(run, stdoutBuffer.trim());
    run.exitCode = code;
    run.completedAt = now();

    let finalMessage = '';
    try {
      finalMessage = (await readFile(outputFile, 'utf8')).trim();
    } catch {
      finalMessage = '';
    }

    run.finalMessage = finalMessage;
    if (run.cancelRequested) {
      run.status = 'cancelled';
      mission.status = 'ready';
    } else {
      run.status = code === 0 ? 'succeeded' : 'failed';
      mission.status = code === 0 ? 'review' : 'failed';
    }
    if (run.taskId) {
      const task = findTask(run.taskId);
      if (task) {
        if (run.status === 'succeeded') {
          task.status = 'in_review';
          task.reviewRequestedAt = now();
          addTaskHistory(task, 'review_requested', `Codex run ${run.id} succeeded; moved to review.`, task.claimedBy || 'agt_codex', { runId: run.id });
          addSystemReply(ensureTaskThread(task).id, `Codex run ${run.id} finished. Review requested.`);
          addTaskTimelineMessage(task, `👀 ${displayActor(task.claimedBy || 'agt_codex')} moved ${taskLabel(task)} to In Review`, 'task_review');
        } else if (run.status === 'failed') {
          addTaskHistory(task, 'run_failed', `Codex run ${run.id} failed.`, task.claimedBy || 'agt_codex', { runId: run.id });
          addSystemReply(ensureTaskThread(task).id, `Codex run ${run.id} failed. Check evidence.`);
        } else if (run.status === 'cancelled') {
          addTaskHistory(task, 'run_cancelled', `Codex run ${run.id} cancelled.`, task.claimedBy || 'agt_codex', { runId: run.id });
          addSystemReply(ensureTaskThread(task).id, `Codex run ${run.id} cancelled.`);
        }
      }
    }
    mission.updatedAt = now();
    addRunEvent(run.id, 'runner', `Codex exited with code ${code ?? 'unknown'}.`);
    await persistState();
    broadcastState();
  });

  child.stdin.write(createPrompt(mission, run, attachments));
  child.stdin.end();
}

const agentRuntime = createAgentRuntimeManager({
  addCollabEvent,
  addSystemEvent,
  addSystemReply,
  addTaskHistory,
  addTaskTimelineMessage,
  agentAvailableForAutoWork,
  agentDataDir,
  agentProcesses,
  autoTaskMessageIntent,
  broadcastState,
  channelAgentIds,
  channelHumanIds,
  CODEX_STREAM_RETRY_LIMIT,
  codexRuntimeOverrideForDelivery,
  deliveryMessageMatchesScope,
  deliveryMessageMatchesTask,
  displayActor,
  ensureAgentWorkspace,
  ensureTaskThread,
  extractLocalReferences,
  extractMentions,
  findAgent,
  findChannel,
  findHuman,
  findMessage,
  findMission,
  findRun,
  findTask,
  findTaskForThreadMessage,
  findWorkItem,
  getState: () => state,
  HOST,
  httpError,
  localReferenceLines,
  makeId,
  MAX_AGENT_RELAY_DEPTH,
  normalizeConversationRecord,
  now,
  nextTaskNumber,
  persistState,
  pickAvailableAgent,
  prepareAgentCodexHome,
  prepareAgentResponseBody,
  projectsForSpace,
  renderMentionsForAgent,
  resolveCodexRuntime,
  resolveConversationSpace,
  runMatchesTask,
  ROOT,
  runningProcesses,
  RUNS_DIR,
  scheduleAgentMemoryWriteback,
  setAgentStatus,
  shouldStartThreadForAgentDelivery,
  spaceDisplayName,
  spaceMatchesScope,
  taskIsClosed,
  taskLabel,
  taskMatchesScope,
  targetForConversation,
  turnMetaAllWorkCancelled,
  turnMetaHasWorkOutsideScope,
  turnMetaMatchesScope,
  turnMetaMatchesTask,
  writeAgentSessionFile,
  workItemMatchesScope,
  workItemMatchesTask,
  AGENT_BUSY_DELIVERY_DELAY_MS,
  PORT,
});

const {
  getAgentRuntime,
  createAgentStandingPrompt,
  createAgentTurnPrompt,
  startAgentProcess,
  startClaudeAgent,
  startCodexAgent,
  sendCodexAppServerRequest,
  sendCodexAppServerNotification,
  triggerCodexStreamRetryFallback,
  handleCodexThreadReady,
  startCodexAppServerTurn,
  sendCodexAppServerMessages,
  clearAgentBusyDeliveryTimer,
  queueCodexBusyDelivery,
  scheduleCodexBusyDelivery,
  flushCodexPendingDeliveries,
  handleCodexTurnCompleted,
  handleCodexAppServerLine,
  fallbackToCodexExec,
  startCodexAgentLegacy,
  restartAgentWithQueuedMessages,
  partitionMessagesByScope,
  partitionMessagesByTask,
  cancelWorkItemsForScope,
  cancelWorkItemsForTask,
  activeTurnMetas,
  activeDeliveryMessagesOutsideTask,
  uniqueDeliveryMessages,
  processHasOnlyScopedActiveWork,
  processHasActiveTaskWork,
  stopAgentProcessForScope,
  stopAgentProcessForTask,
  stopAgentProcesses,
  stopAgentProcessesForTask,
  steerAgentProcessesForTaskStop,
  stopRunsForScope,
  stopRunsForTask,
  waitForAgentProcessExit,
  stopAgentProcessForControl,
  resetAgentRuntimeSession,
  resetAgentWorkspaceFiles,
  startAgentFromControl,
  restartAgentFromControl,
  agentAlreadyRoutedForSource,
  relayAgentMentions,
  inferTaskIdForDelivery,
  createWorkItemForDelivery,
  markWorkItemsDelivered,
  turnMetaHasExplicitSend,
  workItemTargetMatches,
  markWorkItemResponded,
  markFallbackResponseWorkItem,
  markFallbackResponseWorkItems,
  postAgentResponse,
  deliverMessageToAgent,
  createTaskFromMessage,
  createTaskMessage,
  claimTask,
  findTaskForAgentTool,
  updateTaskForAgent,
} = agentRuntime;

function projectApiDeps() {
  return {
    addProjectFolder,
    addSystemEvent,
    broadcastState,
    decodePathSegment,
    defaultWorkspace: ROOT,
    findProject,
    getState: () => state,
    listProjectTree,
    maxAttachmentUploads: MAX_ATTACHMENT_UPLOADS,
    persistState,
    pickFolderPath,
    readJson,
    readProjectFilePreview,
    saveAttachmentBuffer,
    searchProjectItems,
    selectedDefaultSpaceId,
    sendError,
    sendJson,
  };
}

function cloudApiDeps() {
  return {
    addSystemEvent,
    applyCloudSnapshot,
    broadcastState,
    cloudFetch,
    cloudSnapshot,
    dataDir: DATA_DIR,
    getState: () => state,
    host: HOST,
    normalizeCloudUrl,
    now,
    persistState,
    port: PORT,
    protocolVersion: CLOUD_PROTOCOL_VERSION,
    publicConnection,
    pullStateFromCloud,
    pushStateToCloud,
    readJson,
    requireCloudAccess,
    sendError,
    sendJson,
  };
}

function systemApiDeps() {
  return {
    addSystemEvent,
    broadcastState,
    defaultWorkspace: ROOT,
    detectInstalledRuntimes,
    fanoutApiConfigured,
    getRuntimeInfo,
    getState: () => state,
    persistState,
    presenceHeartbeat,
    publicState,
    readJson,
    sendError,
    sendJson,
    sseClients,
    updateFanoutApiConfig,
  };
}

function collabApiDeps() {
  return {
    addCollabEvent,
    agentParticipatesInChannels,
    broadcastState,
    findAgent,
    findChannel,
    findComputer,
    getState: () => state,
    makeId,
    normalizeConversationRecord,
    normalizeIds,
    normalizeName,
    now,
    persistState,
    readJson,
    scheduleAgentMemoryWriteback,
    sendError,
    sendJson,
  };
}

function agentToolApiDeps() {
  return {
    addSystemEvent,
    broadcastState,
    claimTask,
    createTaskFromMessage,
    createTaskMessage,
    displayActor,
    findAgent,
    findConversationRecord,
    findMessage,
    findTaskForAgentTool,
    findWorkItem,
    formatAgentHistory,
    formatAgentSearchResults,
    getState: () => state,
    httpError,
    markWorkItemResponded,
    normalizeIds,
    persistState,
    postAgentResponse,
    readAgentHistory,
    readJson,
    resolveConversationSpace,
    resolveMessageTarget,
    searchAgentMessageHistory,
    sendError,
    sendJson,
    taskLabel,
    updateTaskForAgent,
    workItemTargetMatches,
  };
}

function missionApiDeps() {
  return {
    addRunEvent,
    addSystemEvent,
    broadcastState,
    findMission,
    findRun,
    getRunningProcess: (runId) => runningProcesses.get(runId),
    getState: () => state,
    makeId,
    now,
    persistState,
    readJson,
    root: ROOT,
    sendError,
    sendJson,
    splitLines,
    startCodexRun,
  };
}

function taskApiDeps() {
  return {
    addCollabEvent,
    addSystemReply,
    addTaskHistory,
    addTaskTimelineMessage,
    broadcastState,
    claimTask,
    createTaskMessage,
    displayActor,
    ensureTaskThread,
    findTask,
    getState: () => state,
    makeId,
    normalizeIds,
    now,
    persistState,
    readJson,
    resolveConversationSpace,
    root: ROOT,
    sendError,
    sendJson,
    startCodexRun,
    taskIsClosed,
    taskLabel,
  };
}

function agentApiDeps() {
  return {
    addCollabEvent,
    agentParticipatesInChannels,
    broadcastState,
    clearAgentProcesses: () => agentProcesses.clear(),
    ensureAgentWorkspace,
    findAgent,
    findChannel,
    getState: () => state,
    hasAgentProcess: (agentId) => agentProcesses.has(agentId),
    listAgentWorkspace,
    makeId,
    normalizeCodexModelName,
    normalizeIds,
    now,
    persistState,
    readAgentWorkspaceFile,
    readJson,
    restartAgentFromControl,
    root: ROOT,
    sendError,
    sendJson,
    setAgentStatus,
    startAgentFromControl,
    stopAgentProcesses,
    stopRunsForScope,
    stopScopeFromBody,
  };
}

function messageApiDeps() {
  return {
    addCollabEvent,
    addSystemEvent,
    addSystemReply,
    agentAvailableForAutoWork,
    agentCapabilityQuestionIntent,
    applyMentions,
    availabilityFollowupIntent,
    broadcastState,
    channelAgentIds,
    createOrClaimTaskForMessage,
    createTaskFromMessage,
    createTaskFromThreadIntent,
    deliverMessageToAgent,
    extractMentions,
    findAgent,
    findChannel,
    findConversationRecord,
    findMessage,
    findTaskForThreadMessage,
    finishTaskFromThread,
    getState: () => state,
    makeId,
    normalizeConversationRecord,
    now,
    persistState,
    pickAvailableAgent,
    readJson,
    routeMessageForChannel,
    routeThreadReplyForChannel,
    scheduleAgentMemoryWriteback,
    sendError,
    sendJson,
    stopTaskFromThread,
    taskCreationIntent,
    taskEndIntent,
    taskStopIntent,
    taskThreadDeliveryMessage,
    userPreferenceIntent,
  };
}

async function handleApi(req, res, url) {
  if (!requireCloudDeploymentApi(req, res, url)) return true;

  if (await handleSystemApi(req, res, url, systemApiDeps())) return true;

  if (await handleAgentToolApi(req, res, url, agentToolApiDeps())) return true;

  if (await handleMissionApi(req, res, url, missionApiDeps())) return true;

  if (await handleTaskApi(req, res, url, taskApiDeps())) return true;

  if (await handleAgentApi(req, res, url, agentApiDeps())) return true;

  if (await handleCloudApi(req, res, url, cloudApiDeps())) return true;

  if (await handleProjectApi(req, res, url, projectApiDeps())) return true;

  if (await handleCollabApi(req, res, url, collabApiDeps())) return true;

  if (await handleMessageApi(req, res, url, messageApiDeps())) return true;

  return false;
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const requestedPath = safePathWithin(PUBLIC_DIR, pathname.replace(/^\/+/, ''));
  if (!requestedPath) {
    sendError(res, 403, 'Forbidden.');
    return;
  }

  let filePath = requestedPath;
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'content-type': contentTypes.get(ext) || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(filePath).pipe(res);
}

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);

  try {
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url);
      if (!handled) sendError(res, 404, 'API route not found.');
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    sendError(res, 500, error.message || 'Internal server error.');
  }
}

await ensureStorage();

const server = http.createServer(handleRequest);
const heartbeatTimer = setInterval(() => {
  if (reconcileAgentStatusHeartbeats()) {
    persistState().then(broadcastState).catch(() => {});
    return;
  }
  if (sseClients.size) broadcastHeartbeat();
}, STATE_HEARTBEAT_MS);
heartbeatTimer.unref?.();

server.listen(PORT, HOST, () => {
  addSystemEvent('server_started', `Magclaw local server started at http://${HOST}:${PORT}`);
  persistState().then(broadcastState);
  console.log(`Magclaw local is running at http://${HOST}:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});

process.on('SIGINT', () => {
  clearInterval(heartbeatTimer);
  for (const child of runningProcesses.values()) child.kill('SIGTERM');
  for (const proc of agentProcesses.values()) {
    if (proc.child && !proc.child.killed) proc.child.kill('SIGTERM');
  }
  server.close(() => process.exit(0));
});
