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
import { createCollabMemoryManager } from './collab-memory.js';
import { createCloudSync } from './cloud-sync.js';
import { createRoutingEngine } from './routing-engine.js';
import { createMissionRunner } from './mission-runner.js';
import { createSystemServices } from './system-services.js';
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
  channelAgentIds: (...args) => channelAgentIds(...args),
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

const routingEngine = createRoutingEngine({
  addSystemEvent,
  agentAvailableForAutoWork,
  agentCardCache,
  agentDataDir,
  agentIdleForAvailability,
  agentParticipatesInChannels,
  findAgent,
  findChannel,
  findHuman,
  findTask,
  findTaskForThreadMessage,
  getState: () => state,
  isBrainAgent,
  makeId,
  now,
  renderMentionsForAgent,
  spaceDisplayName,
  taskIsClosed,
  taskLabel,
  visibleMentionLabel,
  AGENT_CARD_TEXT_LIMIT,
  BRAIN_AGENT_DESCRIPTION,
  BRAIN_AGENT_NAME,
  FANOUT_API_TIMEOUT_MS,
  LEGACY_BRAIN_AGENT_ID,
  ROUTE_EVENTS_LIMIT,
});
const {
  buildAgentCards,
  channelAgentIds,
  channelHumanIds,
  cleanTaskTitle,
  determineRespondingAgents,
  displayActor,
  pickAvailableAgent,
  routeMessageForChannel,
  routeThreadReplyForChannel,
  shouldAgentRespond,
  textAddressesAgent,
  threadParticipantAgentIds,
  uniqueAgents,
} = routingEngine;

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

const collabMemory = createCollabMemoryManager({
  addSystemEvent,
  agentCardCache,
  broadcastState,
  channelAgentIds,
  defaultAgentMemory: agentWorkspace.defaultAgentMemory,
  displayActor,
  ensureAgentWorkspace,
  findMessage,
  getState: () => state,
  isBrainAgent,
  makeId,
  normalizeConversationRecord,
  now,
  persistState,
  spaceDisplayName,
  taskLabel,
});
const {
  addCollabEvent,
  addSystemReply,
  addTaskHistory,
  normalizeName,
  scheduleAgentMemoryWriteback,
} = collabMemory;

const cloudSync = createCloudSync({
  getState: () => state,
  migrateState,
  now,
  persistState,
  CLOUD_PROTOCOL_VERSION,
});
const {
  applyCloudSnapshot,
  cloudFetch,
  cloudSnapshot,
  pullStateFromCloud,
  pushStateToCloud,
  queueCloudPush,
} = cloudSync;

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

const systemServices = createSystemServices({
  addSystemEvent,
  broadcastState,
  fanoutApiConfigured,
  getState: () => state,
  httpError,
  makeId,
  now,
  persistState,
  projectsForSpace,
  runningProcesses,
  selectedDefaultSpaceId,
  DATA_DIR,
  PORT,
  ROOT,
});
const {
  addProjectFolder,
  detectInstalledRuntimes,
  execFileResult,
  execText,
  getRuntimeInfo,
  pickFolderPath,
  publicConnection,
  publicState,
  updateFanoutApiConfig,
} = systemServices;

const missionRunner = createMissionRunner({
  addRunEvent,
  addSystemReply,
  addTaskHistory,
  addTaskTimelineMessage,
  broadcastState,
  displayActor,
  ensureTaskThread,
  findTask,
  getState: () => state,
  localReferenceLines,
  now,
  persistState,
  runningProcesses,
  ROOT,
  RUNS_DIR,
  taskLabel,
});
const { startCodexRun } = missionRunner;

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
