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
const MAX_PROJECT_SEARCH_RESULTS = 80;
const MAX_PROJECT_SCAN_ENTRIES = 4000;
const MAX_PROJECT_SEARCH_DEPTH = 8;
const MAX_PROJECT_TREE_ENTRIES = 300;
const MAX_PROJECT_FILE_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_AGENT_WORKSPACE_TREE_ENTRIES = 300;
const MAX_AGENT_WORKSPACE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_AGENT_RELAY_DEPTH = 2;
const AGENT_BUSY_DELIVERY_DELAY_MS = Math.max(10, Number(process.env.MAGCLAW_AGENT_BUSY_DELIVERY_DELAY_MS || 160));
const STATE_HEARTBEAT_MS = Math.max(25, Number(process.env.MAGCLAW_STATE_HEARTBEAT_MS || 1000));
const AGENT_STATUS_STALE_MS = Math.max(1000, Number(process.env.MAGCLAW_AGENT_STATUS_STALE_MS || 45_000));
const ROUTE_EVENTS_LIMIT = Math.max(50, Number(process.env.MAGCLAW_ROUTE_EVENTS_LIMIT || 500));
const AGENT_CARD_TEXT_LIMIT = 5000;
const FANOUT_API_TIMEOUT_MS = Math.max(500, Number(process.env.MAGCLAW_FANOUT_TIMEOUT_MS || 2500));
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
const PROJECT_SEARCH_EXCLUDES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.magclaw',
  'node_modules',
  '.next',
  'dist',
  'build',
  'target',
  '.venv',
  '__pycache__',
]);
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd']);
const TEXT_PREVIEW_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.mdown',
  '.mkd',
  '.log',
  '.csv',
  '.json',
  '.jsonl',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.css',
  '.html',
  '.xml',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.sh',
  '.zsh',
  '.bash',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
]);

const runningProcesses = new Map();
const agentProcesses = new Map(); // agentId -> { child, sessionId, status, inbox }
const sseClients = new Set();
let cloudPushTimer = null;
let syncInProgress = false;

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
]);

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

function normalizeCloudUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.replace(/\/+$/, '');
}

function normalizeFanoutApiConfig(config = {}) {
  const timeoutMs = Number(config.timeoutMs || FANOUT_API_TIMEOUT_MS);
  return {
    enabled: Boolean(config.enabled),
    baseUrl: normalizeCloudUrl(config.baseUrl || ''),
    apiKey: String(config.apiKey || ''),
    model: String(config.model || '').trim(),
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(500, Math.min(30_000, timeoutMs)) : FANOUT_API_TIMEOUT_MS,
  };
}

function fanoutApiConfigured(config = state?.settings?.fanoutApi) {
  const normalized = normalizeFanoutApiConfig(config || {});
  return Boolean(normalized.enabled && normalized.baseUrl && normalized.apiKey && normalized.model);
}

function publicApiKeyPreview(value) {
  const key = String(value || '');
  if (!key) return '';
  return `${key.slice(0, Math.min(6, key.length))}${key.length > 6 ? '****' : ''}`;
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
  const value = String(model || '').trim();
  if (value && value.toLowerCase() !== 'default') return value;
  const fallbackValue = String(fallback || process.env.CODEX_MODEL || '').trim();
  if (fallbackValue && fallbackValue.toLowerCase() !== 'default') return fallbackValue;
  return CODEX_FALLBACK_MODEL;
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

function splitLines(value) {
  if (Array.isArray(value)) return value.map(String).map((line) => line.trim()).filter(Boolean);
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function safeFileName(name) {
  return String(name || 'attachment')
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 120);
}

function safePathWithin(base, target = '.') {
  const basePath = path.resolve(base);
  const resolved = path.resolve(basePath, target || '.');
  const relative = path.relative(basePath, resolved);
  if (relative && (relative.startsWith('..') || path.isAbsolute(relative))) return null;
  return resolved;
}

function toPosixPath(value) {
  return String(value || '').replace(/\\/g, '/').split(path.sep).join('/');
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    return String(value || '');
  }
}

function normalizeProjectRelPath(value) {
  return toPosixPath(decodePathSegment(value))
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '');
}

function baseNameFromProjectPath(value, fallback = 'project') {
  const parts = normalizeProjectRelPath(value).split('/').filter(Boolean);
  return parts.pop() || fallback;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function attachmentPeriod(createdAt = new Date()) {
  const date = createdAt instanceof Date ? createdAt : new Date(createdAt);
  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return { year, month, relativeDir: `${year}/${month}` };
}

function mimeForPath(filePath, fallback = 'application/octet-stream') {
  const ext = path.extname(filePath).toLowerCase();
  if (contentTypes.has(ext)) return contentTypes.get(ext).replace(/;.*$/, '');
  if (ext === '.txt' || ext === '.md' || ext === '.log') return 'text/plain';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.csv') return 'text/csv';
  if (ext === '.json') return 'application/json';
  if (ext === '.zip') return 'application/zip';
  return fallback;
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

function projectRelativePath(project, absolutePath) {
  return toPosixPath(path.relative(project.path, absolutePath));
}

function fuzzyIncludes(query, value) {
  const q = String(query || '').toLowerCase();
  const target = String(value || '').toLowerCase();
  if (!q) return true;
  if (target.includes(q)) return true;
  let cursor = 0;
  for (const char of q) {
    cursor = target.indexOf(char, cursor);
    if (cursor < 0) return false;
    cursor += 1;
  }
  return true;
}

function projectSearchScore(query, item) {
  const q = String(query || '').toLowerCase();
  const name = item.name.toLowerCase();
  const rel = item.path.toLowerCase();
  if (!q) return item.kind === 'folder' ? 1 : 2;
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.includes(q)) return 2;
  if (rel.includes(q)) return 3;
  return 4;
}

async function searchProject(project, query) {
  const results = [];
  const queue = [{ dir: project.path, depth: 0 }];
  let scanned = 0;

  while (queue.length && scanned < MAX_PROJECT_SCAN_ENTRIES && results.length < MAX_PROJECT_SEARCH_RESULTS * 3) {
    const current = queue.shift();
    let entries = [];
    try {
      entries = await readdir(current.dir, { withFileTypes: true });
    } catch (error) {
      addSystemEvent('project_scan_skipped', `Could not scan ${project.name}: ${error.message}`, {
        projectId: project.id,
        path: current.dir,
      });
      continue;
    }

    for (const entry of entries) {
      if (scanned >= MAX_PROJECT_SCAN_ENTRIES) break;
      if (PROJECT_SEARCH_EXCLUDES.has(entry.name)) continue;
      scanned += 1;

      const absolutePath = path.join(current.dir, entry.name);
      const relPath = projectRelativePath(project, absolutePath);
      const isDirectory = entry.isDirectory();
      if (fuzzyIncludes(query, `${entry.name} ${relPath}`)) {
        results.push({
          id: `${project.id}:${relPath}`,
          projectId: project.id,
          projectName: project.name,
          name: entry.name,
          path: relPath,
          absolutePath,
          kind: isDirectory ? 'folder' : 'file',
        });
      }
      if (isDirectory && current.depth < MAX_PROJECT_SEARCH_DEPTH) {
        queue.push({ dir: absolutePath, depth: current.depth + 1 });
      }
    }
  }

  return results
    .sort((a, b) => projectSearchScore(query, a) - projectSearchScore(query, b)
      || (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === 'folder' ? -1 : 1))
    .slice(0, MAX_PROJECT_SEARCH_RESULTS);
}

async function searchProjectItems(spaceType, spaceId, query) {
  const projects = projectsForSpace(spaceType, spaceId);
  const batches = await Promise.all(projects.map((project) => searchProject(project, query)));
  return batches
    .flat()
    .sort((a, b) => projectSearchScore(query, a) - projectSearchScore(query, b)
      || (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === 'folder' ? -1 : 1))
    .slice(0, MAX_PROJECT_SEARCH_RESULTS);
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

function projectEntry(project, relPath, info) {
  const isDirectory = info.isDirectory();
  return {
    id: `${project.id}:${relPath}`,
    projectId: project.id,
    projectName: project.name,
    name: baseNameFromProjectPath(relPath, project.name),
    path: relPath,
    kind: isDirectory ? 'folder' : 'file',
    type: isDirectory ? 'folder' : mimeForPath(relPath),
    bytes: isDirectory ? 0 : info.size,
    updatedAt: info.mtime.toISOString(),
  };
}

async function listProjectTree(project, rawRelPath = '') {
  const relPath = normalizeProjectRelPath(rawRelPath);
  const dirPath = safePathWithin(project.path, relPath || '.');
  if (!dirPath) throw httpError(400, 'Project tree path must stay inside the project folder.');
  const info = await stat(dirPath).catch(() => null);
  if (!info) throw httpError(404, 'Project tree path was not found.');
  if (!info.isDirectory()) throw httpError(400, 'Project tree path must be a directory.');

  const dirEntries = (await readdir(dirPath, { withFileTypes: true }))
    .filter((entry) => !PROJECT_SEARCH_EXCLUDES.has(entry.name))
    .sort((a, b) => (a.isDirectory() === b.isDirectory()
      ? a.name.localeCompare(b.name)
      : a.isDirectory() ? -1 : 1))
    .slice(0, MAX_PROJECT_TREE_ENTRIES);

  const entries = [];
  for (const entry of dirEntries) {
    const childRelPath = toPosixPath(path.join(relPath, entry.name)).replace(/^\/+/, '');
    const childPath = safePathWithin(project.path, childRelPath);
    if (!childPath) continue;
    try {
      entries.push(projectEntry(project, childRelPath, await stat(childPath)));
    } catch (error) {
      addSystemEvent('project_tree_entry_skipped', `Could not inspect ${entry.name}: ${error.message}`, {
        projectId: project.id,
        path: childRelPath,
      });
    }
  }

  return {
    project: {
      id: project.id,
      name: project.name,
      path: project.path,
    },
    path: relPath,
    entries,
    truncated: dirEntries.length >= MAX_PROJECT_TREE_ENTRIES,
  };
}

function projectFilePreviewKind(filePath, buffer) {
  const ext = path.extname(filePath).toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
  if (TEXT_PREVIEW_EXTENSIONS.has(ext)) return 'text';
  if (buffer.includes(0)) return 'binary';
  const sample = buffer.subarray(0, Math.min(buffer.length, 2048)).toString('utf8');
  return sample.includes('\uFFFD') ? 'binary' : 'text';
}

async function readProjectFilePreview(project, rawRelPath = '') {
  const relPath = normalizeProjectRelPath(rawRelPath);
  const filePath = safePathWithin(project.path, relPath);
  if (!filePath) throw httpError(400, 'Project file path must stay inside the project folder.');
  const info = await stat(filePath).catch(() => null);
  if (!info) throw httpError(404, 'Project file was not found.');
  if (!info.isFile()) throw httpError(400, 'Project preview path must be a file.');
  if (info.size > MAX_PROJECT_FILE_PREVIEW_BYTES) {
    throw httpError(413, `File preview is limited to ${MAX_PROJECT_FILE_PREVIEW_BYTES} bytes.`);
  }

  const buffer = await readFile(filePath);
  const previewKind = projectFilePreviewKind(filePath, buffer);
  return {
    file: {
      id: `file:${project.id}:${relPath}`,
      projectId: project.id,
      projectName: project.name,
      name: baseNameFromProjectPath(relPath, project.name),
      path: relPath,
      absolutePath: filePath,
      type: mimeForPath(filePath),
      bytes: info.size,
      updatedAt: info.mtime.toISOString(),
      previewKind,
      content: previewKind === 'binary' ? '' : buffer.toString('utf8'),
    },
  };
}

function agentDataDir(agent) {
  return path.join(AGENTS_DIR, String(agent?.id || 'unknown'));
}

function agentCodexHomeDir(agent) {
  return path.join(agentDataDir(agent), 'codex-home');
}

async function ensureSymlinkedCodexHomeEntry(codexHome, entryName) {
  const source = path.join(SOURCE_CODEX_HOME, entryName);
  if (!existsSync(source)) return;
  const target = path.join(codexHome, entryName);
  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink()) {
      const current = await readlink(target);
      const resolved = path.resolve(path.dirname(target), current);
      if (resolved === source) return;
      await unlink(target);
    } else {
      // Do not overwrite agent-local files. This keeps the isolated home safe if
      // Codex creates local state with the same name in a later release.
      return;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const sourceStat = await stat(source);
  await symlink(source, target, sourceStat.isDirectory() ? 'dir' : 'file');
}

async function removeStaleCodexHomeEntry(codexHome, entryName) {
  const target = path.join(codexHome, entryName);
  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink()) {
      await unlink(target);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function writeAgentCodexConfig(codexHome) {
  await writeFile(path.join(codexHome, 'config.toml'), [
    '# Generated by MagClaw. Keep chat agents isolated from the user Codex app.',
    '',
    '[features]',
    'memories = false',
    '',
  ].join('\n'), 'utf8');
}

async function writeAgentCodexAgentsFile(codexHome) {
  await writeFile(path.join(codexHome, 'AGENTS.md'), [
    '# MagClaw Agent Runtime',
    '',
    '- This Codex home is managed by MagClaw for chat-agent turns.',
    '- Do not run Codex memory-writing or consolidation workflows inside MagClaw chat turns.',
    '- Follow the MagClaw prompt for the current channel, thread, or task.',
    '',
  ].join('\n'), 'utf8');
}

async function prepareAgentCodexHome(agent) {
  const codexHome = agentCodexHomeDir(agent);
  await mkdir(codexHome, { recursive: true });
  await Promise.all(CODEX_HOME_STALE_SHARED_ENTRIES.map((entry) => removeStaleCodexHomeEntry(codexHome, entry).catch((error) => {
    addSystemEvent('agent_codex_home_cleanup_skipped', `Could not clean Codex home entry ${entry}: ${error.message}`, {
      agentId: agent?.id,
      codexHome,
      entry,
    });
  })));
  await Promise.all(CODEX_HOME_SHARED_ENTRIES.map((entry) => ensureSymlinkedCodexHomeEntry(codexHome, entry).catch((error) => {
    addSystemEvent('agent_codex_home_link_skipped', `Could not link Codex home entry ${entry}: ${error.message}`, {
      agentId: agent?.id,
      source: path.join(SOURCE_CODEX_HOME, entry),
      codexHome,
    });
  })));
  await writeAgentCodexConfig(codexHome);
  await writeAgentCodexAgentsFile(codexHome);
  if (agent.runtimeSessionId && (agent.runtimeSessionHome !== codexHome || Number(agent.runtimeConfigVersion || 0) !== CODEX_HOME_CONFIG_VERSION)) {
    addSystemEvent('agent_runtime_session_reset', `${agent.name} runtime session reset for isolated Codex home config.`, {
      agentId: agent.id,
      previousSessionId: agent.runtimeSessionId,
      previousHome: agent.runtimeSessionHome || SOURCE_CODEX_HOME,
      codexHome,
      previousConfigVersion: Number(agent.runtimeConfigVersion || 0),
      configVersion: CODEX_HOME_CONFIG_VERSION,
    });
    agent.runtimeSessionId = null;
    agent.runtimeLastTurnAt = null;
  }
  agent.runtimeSessionHome = codexHome;
  agent.runtimeConfigVersion = CODEX_HOME_CONFIG_VERSION;
  return codexHome;
}

function defaultAgentMemory(agent) {
  if (isBrainAgent(agent)) {
    return [
      `# ${agent?.name || 'MagClaw Brain'}`,
      '',
      '## Role',
      'You are the internal routing brain for MagClaw. Your job is to decide which channel agents should be awakened, which agent should claim durable work, and when memory writeback should be triggered.',
      '',
      '## Routing Principles',
      '- Hard rules first: explicit mentions, channel membership, thread ownership, and claimed tasks override semantic guesses.',
      '- Use Agent Cards as the compact progressive-disclosure layer. Do not read every note for every message unless a later implementation explicitly asks you to.',
      '- Prefer all member agents for ordinary open channel chat and availability checks.',
      '- Prefer a single best-fit claimant for concrete durable work, then rely on the task claim lock.',
      '- If routing fails, let the rule fallback handle the message instead of dropping it.',
      '',
      '## Key Knowledge',
      '- `notes/profile.md` - router capability, fallback policy, and scoring priorities.',
      '- `notes/channels.md` - channel membership and dispatch norms.',
      '- `notes/agents.md` - agent cards and observed specialties.',
      '- `notes/work-log.md` - route tuning decisions and memory writeback changes.',
      '',
      '## Active Context',
      '- Router v2 uses structured route events, agent cards, and rules fallback.',
      '- Future upgrades may replace the deterministic evaluator with an LLM or embedding-based router while preserving the same RouteDecision shape.',
      '',
      '## Memory Maintenance',
      '- Record high-signal routing failures, new dispatch rules, and agent specialty changes in notes/work-log.md or notes/agents.md.',
      '- Keep this entrypoint short; link to detailed notes instead of expanding everything here.',
      '',
    ].join('\n');
  }
  const role = String(agent?.description || 'General-purpose MagClaw teammate.').trim();
  return [
    `# ${agent?.name || 'Agent'}`,
    '',
    '## Role',
    `You are ${agent?.name || 'this agent'}, ${role}`,
    '',
    '## Key Knowledge',
    '- `notes/profile.md` - your role, strengths, skills, and response boundaries.',
    '- `notes/channels.md` - channel membership and collaboration context.',
    '- `notes/agents.md` - other agents, their specialties, and handoff cues.',
    '- `notes/work-log.md` - durable work history, decisions, and completed artifacts.',
    '',
    '## Active Context',
    '- No active task has been recorded yet.',
    '- Before a long task or context-heavy handoff, summarize the current task, target thread, owner, and next step here.',
    '',
    '## Collaboration Rules',
    '- Treat `MEMORY.md` as a concise entry point, not the full notebook.',
    '- Put durable detail in `notes/` and add or update the index above when a new note matters.',
    '- Record high-value preferences, specialties, work logs, and handoff facts as part of task progress; the user should not need to ask every time.',
    '- Claim concrete work before doing it when a task exists, then post progress in the task thread.',
    '- In shared channels, member agents may all receive open human messages. Reply briefly when you can add useful perspective; respect directed conversations when another agent is named or assigned.',
    '- Keep replies concise and use history/search tools when recent context is insufficient.',
    '',
  ].join('\n');
}

function defaultAgentProfileNote(agent) {
  const role = String(agent?.description || 'General-purpose MagClaw teammate.').trim();
  return [
    `# ${agent?.name || 'Agent'} Profile`,
    '',
    '## Role',
    role,
    '',
    '## Strengths And Skills',
    '- Add concrete specialties as they become clear from real work.',
    '- Keep this list practical: tools, domains, repositories, workflows, and review strengths.',
    '',
    '## Response Boundaries',
    '- In shared channels, open human messages may be delivered to every member agent. Reply briefly if you can help, and stay especially concise when several agents may answer.',
    '- For directed messages, assignments, and existing task ownership, let the named or assigned agent take the lead.',
    '- For broad availability checks, state availability briefly and wait for a task or follow-up.',
    '- Avoid joining a conversation already owned by another agent unless invited.',
    '- Maintain `MEMORY.md` and `notes/` after meaningful work so future handoffs can rely on them.',
    '',
  ].join('\n');
}

function defaultAgentChannelsNote(agent) {
  const memberships = (state?.channels || [])
    .filter((channel) => channelAgentIds(channel).includes(agent.id))
    .map((channel) => `- #${channel.name}: ${channel.description || 'No description yet.'}`);
  return [
    `# ${agent?.name || 'Agent'} Channels`,
    '',
    '## Membership',
    ...(memberships.length ? memberships : ['- No channel membership has been recorded yet.']),
    '',
    '## Channel Memory',
    '- Record channel-specific norms, standing workstreams, and user preferences here.',
    '- Keep private thread/task details in `notes/work-log.md` unless they become channel-level context.',
    '',
  ].join('\n');
}

function defaultAgentPeersNote(agent) {
  const peers = (state?.agents || [])
    .filter((item) => item.id !== agent.id)
    .map((item) => `- ${item.name}: ${item.description || item.runtime || 'No specialty recorded yet.'}`);
  return [
    `# ${agent?.name || 'Agent'} Peer Map`,
    '',
    '## Other Agents',
    ...(peers.length ? peers : ['- No other agents have been recorded yet.']),
    '',
    '## Handoff Cues',
    '- Update this file when another agent demonstrates a reliable specialty.',
    '- Mention the likely owner when a request clearly belongs to another agent.',
    '',
  ].join('\n');
}

function defaultAgentWorkLogNote(agent) {
  return [
    `# ${agent?.name || 'Agent'} Work Log`,
    '',
    '## Open Work',
    '- No open work has been recorded yet.',
    '',
    '## Completed Work',
    '- No completed work has been recorded yet.',
    '',
    '## Durable Decisions',
    '- No durable decisions have been recorded yet.',
    '',
  ].join('\n');
}

function defaultAgentWorkspaceReadme(agent) {
  return [
    `# ${agent?.name || 'Agent'} Workspace`,
    '',
    'Use this folder for scratch files, generated artifacts, downloaded references, and deliverables that belong to this agent.',
    '',
    '- Keep long-lived knowledge in `../MEMORY.md` and `../notes/`.',
    '- Keep task-specific files grouped by project or task when possible.',
    '',
  ].join('\n');
}

async function writeFileIfMissing(filePath, content) {
  if (!existsSync(filePath)) await writeFile(filePath, content);
}

function shouldUpgradeSeededAgentMemory(content) {
  return content.includes('## Collaboration Principles')
    && content.includes('## Knowledge Index')
    && content.includes('No durable work log has been recorded yet.')
    && !content.includes('notes/profile.md');
}

async function ensureAgentWorkspace(agent) {
  if (!agent?.id) return null;
  const dir = agentDataDir(agent);
  agent.workspacePath = dir;
  await mkdir(path.join(dir, 'notes'), { recursive: true });
  await mkdir(path.join(dir, 'workspace'), { recursive: true });
  const memoryPath = path.join(dir, 'MEMORY.md');
  if (!existsSync(memoryPath)) {
    await writeFile(memoryPath, defaultAgentMemory(agent));
  } else {
    const content = await readFile(memoryPath, 'utf8').catch(() => '');
    if (shouldUpgradeSeededAgentMemory(content)) {
      await writeFile(memoryPath, defaultAgentMemory(agent));
    }
  }
  await writeFileIfMissing(path.join(dir, 'notes', 'profile.md'), defaultAgentProfileNote(agent));
  await writeFileIfMissing(path.join(dir, 'notes', 'channels.md'), defaultAgentChannelsNote(agent));
  await writeFileIfMissing(path.join(dir, 'notes', 'agents.md'), defaultAgentPeersNote(agent));
  await writeFileIfMissing(path.join(dir, 'notes', 'work-log.md'), defaultAgentWorkLogNote(agent));
  await writeFileIfMissing(path.join(dir, 'workspace', 'README.md'), defaultAgentWorkspaceReadme(agent));
  const sessionsPath = path.join(dir, 'sessions.json');
  if (!existsSync(sessionsPath)) {
    await writeFile(sessionsPath, JSON.stringify({
      agentId: agent.id,
      runtime: agent.runtime || 'Codex CLI',
      runtimeSessionId: agent.runtimeSessionId || null,
      runtimeSessionHome: agent.runtimeSessionHome || null,
      runtimeConfigVersion: agent.runtimeConfigVersion || CODEX_HOME_CONFIG_VERSION,
      updatedAt: now(),
    }, null, 2));
  }
  await prepareAgentCodexHome(agent);
  return dir;
}

async function ensureAllAgentWorkspaces() {
  for (const agent of state?.agents || []) {
    await ensureAgentWorkspace(agent);
  }
}

async function writeAgentSessionFile(agent) {
  const dir = await ensureAgentWorkspace(agent);
  if (!dir) return;
  await writeFile(path.join(dir, 'sessions.json'), JSON.stringify({
    agentId: agent.id,
    runtime: agent.runtime || 'Codex CLI',
    runtimeSessionId: agent.runtimeSessionId || null,
    runtimeSessionHome: agent.runtimeSessionHome || null,
    runtimeConfigVersion: agent.runtimeConfigVersion || CODEX_HOME_CONFIG_VERSION,
    runtimeLastStartedAt: agent.runtimeLastStartedAt || null,
    runtimeLastTurnAt: agent.runtimeLastTurnAt || null,
    updatedAt: now(),
    todo: [
      'Persist non-Codex runtime sessions once Claude/other runtimes expose stable resume APIs.',
      'Add editable workspace files with conflict detection and audit history.',
    ],
  }, null, 2));
}

function agentWorkspacePreviewKind(filePath, buffer) {
  return projectFilePreviewKind(filePath, buffer);
}

async function listAgentWorkspace(agent, rawRelPath = '') {
  const root = await ensureAgentWorkspace(agent);
  const relPath = normalizeProjectRelPath(rawRelPath);
  const dirPath = safePathWithin(root, relPath || '.');
  if (!dirPath) throw httpError(400, 'Agent workspace path must stay inside the agent workspace.');
  const info = await stat(dirPath).catch(() => null);
  if (!info) throw httpError(404, 'Agent workspace path was not found.');
  if (!info.isDirectory()) throw httpError(400, 'Agent workspace path must be a directory.');
  const dirEntries = (await readdir(dirPath, { withFileTypes: true }))
    .filter((entry) => !entry.name.startsWith('.'))
    .sort((a, b) => (a.isDirectory() === b.isDirectory()
      ? a.name.localeCompare(b.name)
      : a.isDirectory() ? -1 : 1))
    .slice(0, MAX_AGENT_WORKSPACE_TREE_ENTRIES);

  const entries = [];
  for (const entry of dirEntries) {
    const childRelPath = toPosixPath(path.join(relPath, entry.name)).replace(/^\/+/, '');
    const childPath = safePathWithin(root, childRelPath);
    if (!childPath) continue;
    const childInfo = await stat(childPath).catch(() => null);
    if (!childInfo) continue;
    entries.push({
      id: `${agent.id}:${childRelPath}`,
      name: entry.name,
      path: childRelPath,
      kind: entry.isDirectory() ? 'folder' : 'file',
      type: entry.isDirectory() ? 'folder' : mimeForPath(childPath),
      bytes: entry.isDirectory() ? 0 : childInfo.size,
      updatedAt: childInfo.mtime.toISOString(),
    });
  }

  return {
    agent: {
      id: agent.id,
      name: agent.name,
      workspacePath: root,
    },
    path: relPath,
    entries,
    truncated: dirEntries.length >= MAX_AGENT_WORKSPACE_TREE_ENTRIES,
  };
}

async function readAgentWorkspaceFile(agent, rawRelPath = '') {
  const root = await ensureAgentWorkspace(agent);
  const relPath = normalizeProjectRelPath(rawRelPath);
  const filePath = safePathWithin(root, relPath);
  if (!filePath) throw httpError(400, 'Agent workspace file path must stay inside the agent workspace.');
  const info = await stat(filePath).catch(() => null);
  if (!info) throw httpError(404, 'Agent workspace file was not found.');
  if (!info.isFile()) throw httpError(400, 'Agent workspace preview path must be a file.');
  if (info.size > MAX_AGENT_WORKSPACE_FILE_BYTES) {
    throw httpError(413, `Agent workspace preview is limited to ${MAX_AGENT_WORKSPACE_FILE_BYTES} bytes.`);
  }
  const buffer = await readFile(filePath);
  const previewKind = agentWorkspacePreviewKind(filePath, buffer);
  return {
    file: {
      id: `${agent.id}:${relPath}`,
      agentId: agent.id,
      agentName: agent.name,
      name: baseNameFromProjectPath(relPath, agent.name),
      path: relPath,
      absolutePath: filePath,
      type: mimeForPath(filePath),
      bytes: info.size,
      updatedAt: info.mtime.toISOString(),
      previewKind,
      content: previewKind === 'binary' ? '' : buffer.toString('utf8'),
    },
  };
}

function findMission(id) {
  return state.missions.find((mission) => mission.id === id);
}

function findRun(id) {
  return state.runs.find((run) => run.id === id);
}

function findChannel(id) {
  return state.channels.find((channel) => channel.id === id);
}

function selectedDefaultSpaceId(spaceType) {
  if (spaceType === 'dm') return state.dms?.[0]?.id || '';
  return state.channels?.[0]?.id || 'chan_all';
}

function findMessage(id) {
  return state.messages.find((message) => message.id === id);
}

function findReply(id) {
  return state.replies.find((reply) => reply.id === id);
}

function findConversationRecord(id) {
  return findMessage(id) || findReply(id);
}

function findWorkItem(id) {
  return state.workItems?.find((item) => item.id === id);
}

function findChannelByRef(ref) {
  const raw = String(ref || '').trim().replace(/^#/, '');
  if (!raw) return null;
  return state.channels.find((channel) => (
    channel.id === raw
    || channel.name === raw
    || channel.id.startsWith(raw)
    || channel.name.startsWith(raw)
  )) || null;
}

function findDmByRef(ref) {
  const raw = String(ref || '').trim().replace(/^dm:/, '');
  if (!raw) return null;
  return state.dms.find((dm) => dm.id === raw || dm.id.startsWith(raw) || dm.name === raw) || null;
}

function findMessageByRef(ref) {
  const raw = String(ref || '').trim();
  if (!raw) return null;
  return state.messages.find((message) => (
    message.id === raw
    || message.id.startsWith(raw)
  )) || null;
}

function targetForConversation(spaceType, spaceId, parentMessageId = null) {
  if (spaceType === 'channel') {
    const channel = findChannel(spaceId);
    const base = `#${channel?.name || spaceId}`;
    return parentMessageId ? `${base}:${parentMessageId}` : base;
  }
  if (spaceType === 'dm') {
    const base = `dm:${spaceId}`;
    return parentMessageId ? `${base}:${parentMessageId}` : base;
  }
  return `${spaceType}:${spaceId}${parentMessageId ? `:${parentMessageId}` : ''}`;
}

function resolveMessageTarget(target) {
  const raw = String(target || '').trim();
  if (!raw) throw httpError(400, 'Target is required.');
  if (raw.startsWith('#')) {
    const withoutHash = raw.slice(1);
    const separator = withoutHash.indexOf(':');
    const channelRef = separator >= 0 ? withoutHash.slice(0, separator) : withoutHash;
    const parentRef = separator >= 0 ? withoutHash.slice(separator + 1) : '';
    const channel = findChannelByRef(channelRef);
    if (!channel) throw httpError(404, `Channel not found: #${channelRef}`);
    let parentMessageId = null;
    if (parentRef) {
      const parent = findMessageByRef(parentRef);
      if (!parent) throw httpError(404, `Thread message not found: ${parentRef}`);
      if (parent.spaceType !== 'channel' || parent.spaceId !== channel.id) {
        throw httpError(409, 'Thread target does not belong to the target channel.');
      }
      parentMessageId = parent.id;
    }
    return {
      spaceType: 'channel',
      spaceId: channel.id,
      parentMessageId,
      label: targetForConversation('channel', channel.id, parentMessageId),
    };
  }
  if (raw.startsWith('dm:')) {
    const parts = raw.split(':');
    const dmRef = parts[1] || '';
    const parentRef = parts.slice(2).join(':');
    const dm = findDmByRef(dmRef);
    if (!dm) throw httpError(404, `DM not found: ${dmRef}`);
    let parentMessageId = null;
    if (parentRef) {
      const parent = findMessageByRef(parentRef);
      if (!parent) throw httpError(404, `Thread message not found: ${parentRef}`);
      if (parent.spaceType !== 'dm' || parent.spaceId !== dm.id) {
        throw httpError(409, 'Thread target does not belong to the target DM.');
      }
      parentMessageId = parent.id;
    }
    return {
      spaceType: 'dm',
      spaceId: dm.id,
      parentMessageId,
      label: targetForConversation('dm', dm.id, parentMessageId),
    };
  }
  throw httpError(400, 'Target must start with #channel or dm:.');
}

function findAgent(id) {
  return state.agents.find((agent) => agent.id === id);
}

function findHuman(id) {
  return state.humans.find((human) => human.id === id);
}

function findActor(id) {
  return findAgent(id) || findHuman(id) || null;
}

function findComputer(id) {
  return state.computers.find((computer) => computer.id === id);
}

function findTask(id) {
  return state.tasks.find((task) => task.id === id);
}

function normalizeIds(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(String)
    .map((id) => id.trim())
    .filter(Boolean))];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionTokenForId(id) {
  return String(id).startsWith('!') ? `<!${String(id).replace(/^!/, '')}>` : `<@${id}>`;
}

function isAsciiMentionWordChar(char) {
  return /[A-Za-z0-9_.-]/.test(char);
}

function isMentionBoundaryChar(char) {
  if (!char) return true;
  if (/\s/.test(char)) return true;
  if (/[，。！？；：、,.!?;:()[\]{}「」『』《》【】"'`“”‘’]/.test(char)) return true;
  return !isAsciiMentionWordChar(char);
}

function visibleMentionLabel(actor) {
  return actor?.name ? `@${actor.name}` : '';
}

function renderMentionsForAgent(text) {
  return String(text || '')
    .replace(/<@(agt_\w+|hum_\w+)>/g, (match, id) => {
      const actor = findActor(id);
      return actor ? visibleMentionLabel(actor) : match;
    })
    .replace(/<!(all|here|channel|everyone)>/g, (_, type) => `@${type}`)
    .replace(/<#(file|folder):([^:>]+):([^>]*)>/g, (match, kind, projectId, rawRelPath) => {
      const ref = projectReferenceFromParts(kind, projectId, rawRelPath);
      return ref ? `@${ref.name} (${ref.kind}: ${ref.absolutePath})` : match;
    });
}

function knownMentionEntries() {
  const entries = [];
  for (const agent of state.agents || []) {
    entries.push([visibleMentionLabel(agent), agent.id]);
  }
  for (const human of state.humans || []) {
    entries.push([visibleMentionLabel(human), human.id]);
    if (human.email) entries.push([`@${human.email.split('@')[0]}`, human.id]);
  }
  for (const special of ['all', 'here', 'channel', 'everyone']) {
    entries.push([`@${special}`, `!${special}`]);
  }
  return entries
    .filter(([label]) => label)
    .sort((a, b) => b[0].length - a[0].length);
}

function encodeVisibleMentions(text) {
  let result = String(text || '');
  for (const [label, id] of knownMentionEntries()) {
    const pattern = new RegExp(escapeRegExp(label), 'g');
    result = result.replace(pattern, (match, offset, fullText) => {
      const before = offset > 0 ? fullText[offset - 1] : '';
      const after = fullText[offset + match.length] || '';
      if (!isMentionBoundaryChar(before) || !isMentionBoundaryChar(after)) return match;
      return mentionTokenForId(id);
    });
  }
  return result;
}

function replaceBareActorIds(text) {
  return String(text || '').replace(/\b(agt_\w+|hum_\w+)\b/g, (match, id, offset, fullText) => {
    if (offset >= 2 && fullText.slice(offset - 2, offset) === '<@') return match;
    const actor = findActor(id);
    return actor?.name || match;
  });
}

function prepareAgentResponseBody(text) {
  return encodeVisibleMentions(replaceBareActorIds(String(text || '').trim()));
}

function defaultReadBy(record) {
  if (record.authorType === 'human' && record.authorId === 'hum_local') return ['hum_local'];
  if (record.authorType === 'system') return ['hum_local'];
  return [];
}

function normalizeConversationRecord(record) {
  const mentions = extractMentions(record.body || '');
  record.attachmentIds = normalizeIds(record.attachmentIds);
  record.localReferences = extractLocalReferences(record.body || '');
  record.mentionedAgentIds = normalizeIds(record.mentionedAgentIds?.length ? record.mentionedAgentIds : mentions.agents);
  record.mentionedHumanIds = normalizeIds(record.mentionedHumanIds?.length ? record.mentionedHumanIds : mentions.humans);
  record.readBy = normalizeIds(record.readBy?.length ? record.readBy : defaultReadBy(record));
  record.savedBy = normalizeIds(record.savedBy);
  return record;
}

// Extract mentions from message text
// Parses <@agent_id>, <@human_id>, and <!special> patterns
function extractMentions(text) {
  const mentions = {
    agents: [],
    humans: [],
    special: [],
  };
  // Extract <@agt_xxx> agent mentions
  const agentMatches = text.matchAll(/<@(agt_\w+)>/g);
  for (const match of agentMatches) {
    const agent = findAgent(match[1]);
    if (agent && !mentions.agents.includes(agent.id)) {
      mentions.agents.push(agent.id);
    }
  }
  // Extract <@hum_xxx> human mentions
  const humanMatches = text.matchAll(/<@(hum_\w+)>/g);
  for (const match of humanMatches) {
    const human = findHuman(match[1]);
    if (human && !mentions.humans.includes(match[1])) {
      mentions.humans.push(match[1]);
    }
  }
  // Extract <!special> mentions (all, here, channel, everyone)
  const specialMatches = text.matchAll(/<!(all|here|channel|everyone)>/g);
  for (const match of specialMatches) {
    if (!mentions.special.includes(match[1])) {
      mentions.special.push(match[1]);
    }
  }
  return mentions;
}

function applyMentions(record, mentions = extractMentions(record.body || '')) {
  record.mentionedAgentIds = normalizeIds(mentions.agents);
  record.mentionedHumanIds = normalizeIds(mentions.humans);
  return record;
}

function taskScopeKey(spaceType, spaceId) {
  return `${spaceType || 'channel'}:${spaceId || 'chan_all'}`;
}

function nextTaskNumber(spaceType, spaceId) {
  const key = taskScopeKey(spaceType, spaceId);
  return state.tasks
    .filter((task) => taskScopeKey(task.spaceType, task.spaceId) === key)
    .reduce((max, task) => Math.max(max, Number(task.number) || 0), 0) + 1;
}

function taskLabel(task) {
  return `#${Number(task.number) || shortTaskId(task.id)}`;
}

function spaceDisplayName(spaceType, spaceId) {
  if (spaceType === 'channel') return `#${findChannel(spaceId)?.name || spaceId || 'channel'}`;
  if (spaceType === 'dm') return `dm:${spaceId || 'unknown'}`;
  return `${spaceType || 'space'}:${spaceId || ''}`;
}

function resolveConversationSpace(input = {}) {
  if (input.target) {
    const target = resolveMessageTarget(input.target);
    return { spaceType: target.spaceType, spaceId: target.spaceId, label: spaceDisplayName(target.spaceType, target.spaceId) };
  }
  const rawChannel = String(input.channel || '').trim();
  if (rawChannel) {
    if (rawChannel.startsWith('#')) {
      const name = rawChannel.slice(1);
      const channel = state.channels.find((item) => item.name === name || item.id === name || item.id.startsWith(name));
      if (!channel) throw httpError(404, `Channel not found: ${rawChannel}`);
      return { spaceType: 'channel', spaceId: channel.id, label: `#${channel.name}` };
    }
    if (rawChannel.toLowerCase().startsWith('dm:')) {
      const dmRef = rawChannel.slice(3);
      const dm = state.dms.find((item) => item.id === dmRef || item.id.startsWith(dmRef));
      if (!dm) throw httpError(404, `DM not found: ${rawChannel}`);
      return { spaceType: 'dm', spaceId: dm.id, label: `dm:${dm.id}` };
    }
  }
  const spaceType = input.spaceType === 'dm' ? 'dm' : 'channel';
  const spaceId = String(input.spaceId || selectedDefaultSpaceId(spaceType));
  const exists = spaceType === 'channel' ? findChannel(spaceId) : state.dms.some((item) => item.id === spaceId);
  if (!exists) throw httpError(404, 'Conversation not found.');
  return { spaceType, spaceId, label: spaceDisplayName(spaceType, spaceId) };
}

function stopScopeFromBody(body = {}) {
  const hasScope = body.spaceType !== undefined || body.spaceId !== undefined || body.channel !== undefined || body.target !== undefined;
  return hasScope ? resolveConversationSpace(body) : null;
}

function spaceMatchesScope(record, scope) {
  if (!scope) return true;
  return record?.spaceType === scope.spaceType && record?.spaceId === scope.spaceId;
}

function taskMatchesScope(task, scope) {
  return Boolean(task && spaceMatchesScope(task, scope));
}

function messageMatchesScope(message, scope) {
  if (!message) return false;
  if (spaceMatchesScope(message, scope)) return true;
  if (message.parentMessageId) return messageMatchesScope(findMessage(message.parentMessageId), scope);
  return false;
}

function workItemMatchesScope(item, scope) {
  if (!item) return false;
  if (spaceMatchesScope(item, scope)) return true;
  return messageMatchesScope(findConversationRecord(item.sourceMessageId), scope);
}

function deliveryMessageMatchesScope(message, scope) {
  if (!message) return false;
  if (spaceMatchesScope(message, scope)) return true;
  const workItem = message.workItemId ? findWorkItem(message.workItemId) : null;
  if (workItemMatchesScope(workItem, scope)) return true;
  return messageMatchesScope(findConversationRecord(message.id), scope);
}

function runMatchesScope(run, scope) {
  if (!run) return false;
  const task = findTask(run.taskId || findMission(run.missionId)?.taskId);
  if (task) return taskMatchesScope(task, scope);
  const mission = findMission(run.missionId);
  if (mission?.spaceType || mission?.spaceId) return spaceMatchesScope(mission, scope);
  return false;
}

function workItemIsCancelled(workItemId) {
  return Boolean(workItemId && findWorkItem(workItemId)?.status === 'cancelled');
}

function turnMetaHasCancelledWork(turnMeta) {
  return normalizeIds(turnMeta?.workItemIds || []).some(workItemIsCancelled);
}

function turnMetaAllWorkCancelled(turnMeta) {
  const ids = normalizeIds(turnMeta?.workItemIds || []);
  return ids.length > 0 && ids.every(workItemIsCancelled);
}

function turnMetaMatchesScope(turnMeta, scope) {
  if (!turnMeta) return false;
  if (spaceMatchesScope(turnMeta, scope)) return true;
  if (messageMatchesScope(turnMeta.sourceMessage, scope)) return true;
  return normalizeIds(turnMeta.workItemIds || []).some((id) => workItemMatchesScope(findWorkItem(id), scope));
}

function turnMetaHasWorkOutsideScope(turnMeta, scope) {
  const ids = normalizeIds(turnMeta?.workItemIds || []);
  if (!ids.length) return !turnMetaMatchesScope(turnMeta, scope);
  return ids.some((id) => {
    const item = findWorkItem(id);
    return item && !workItemMatchesScope(item, scope);
  });
}

function taskIsClosed(task) {
  return task?.status === 'done';
}

function taskThreadRecordIds(task) {
  return normalizeIds([
    task?.messageId,
    task?.threadMessageId,
    task?.sourceMessageId,
  ]);
}

function messageMatchesTask(message, task) {
  if (!message || !task) return false;
  const threadIds = taskThreadRecordIds(task);
  if (message.taskId === task.id) return true;
  if (threadIds.includes(message.id)) return true;
  if (message.parentMessageId && threadIds.includes(message.parentMessageId)) return true;
  if (message.parentMessageId) return messageMatchesTask(findMessage(message.parentMessageId), task);
  return false;
}

function workItemMatchesTask(item, task) {
  if (!item || !task) return false;
  const threadIds = taskThreadRecordIds(task);
  if (item.taskId === task.id) return true;
  if (threadIds.includes(item.sourceMessageId) || threadIds.includes(item.parentMessageId)) return true;
  if (messageMatchesTask(findConversationRecord(item.sourceMessageId), task)) return true;
  if (item.parentMessageId && messageMatchesTask(findMessage(item.parentMessageId), task)) return true;
  return false;
}

function deliveryMessageMatchesTask(message, task) {
  if (!message || !task) return false;
  if (message.taskId === task.id) return true;
  const workItem = message.workItemId ? findWorkItem(message.workItemId) : null;
  if (workItemMatchesTask(workItem, task)) return true;
  if (messageMatchesTask(findConversationRecord(message.id), task)) return true;
  if (message.parentMessageId && messageMatchesTask(findMessage(message.parentMessageId), task)) return true;
  return false;
}

function runMatchesTask(run, task) {
  if (!run || !task) return false;
  if (run.taskId === task.id) return true;
  const mission = findMission(run.missionId);
  return mission?.taskId === task.id;
}

function turnMetaMatchesTask(turnMeta, task) {
  if (!turnMeta || !task) return false;
  if (messageMatchesTask(turnMeta.sourceMessage, task)) return true;
  return normalizeIds(turnMeta.workItemIds || []).some((id) => workItemMatchesTask(findWorkItem(id), task));
}

function shortTaskId(id) {
  return String(id || '').split('_').pop()?.slice(0, 6) || 'task';
}

function findTaskForThreadMessage(message) {
  if (!message) return null;
  if (message.taskId) {
    const direct = findTask(message.taskId);
    if (direct) return direct;
  }
  return state.tasks.find((task) => task.threadMessageId === message.id || task.messageId === message.id || task.sourceMessageId === message.id) || null;
}

function addSystemMessage(spaceType, spaceId, body, extra = {}) {
  const message = normalizeConversationRecord({
    id: makeId('msg'),
    spaceType,
    spaceId,
    authorType: 'system',
    authorId: 'system',
    body,
    attachmentIds: [],
    replyCount: 0,
    savedBy: [],
    createdAt: now(),
    updatedAt: now(),
    ...extra,
  });
  state.messages.push(message);
  return message;
}

function addTaskTimelineMessage(task, body, eventType) {
  return addSystemMessage(task.spaceType, task.spaceId, body, {
    eventType: eventType || 'task_event',
    taskId: task.id,
  });
}

function taskStopIntent(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;
  return [
    /停(掉|止|下|一下)?这个(任务|会话|thread|对话)/,
    /这个(任务|会话|thread|对话).*(停掉|停止|暂停|取消|不要继续|别继续)/,
    /取消这个(任务|会话|thread|对话)/,
    /不要继续.*(这个|这条)?.*(任务|会话|thread|对话)/,
    /别(做|继续).*(这个|这条)?.*(任务|会话|thread|对话)/,
    /\b(stop|cancel|abort)\b.*\b(task|thread|work)\b/i,
  ].some((pattern) => pattern.test(value));
}

function taskEndIntent(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;
  return [
    /把这个(任务|会话|thread|对话)结束/,
    /结束这个(任务|会话|thread|对话)/,
    /这个(任务|会话|thread|对话).*(结束|完成)/,
    /(mark|move).*(task|thread).*(done|complete)/,
    /\b(done|complete|completed)\b/,
  ].some((pattern) => pattern.test(value));
}

function taskCreationIntent(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;
  return [
    /(创建|新建|开启|开|建)(一个|个)?\s*(task|任务)/,
    /(把|将).*(变成|作为|转成|创建成|提升成).*(task|任务)/,
    /(create|make|open|start).*(task)/i,
  ].some((pattern) => pattern.test(value));
}

function quickAnswerIntent(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;
  const asksForSimpleLookup = [
    /(查一下|查询|搜索|找一下|看一下|告诉我|问一下|是什么|为什么|怎么|多少|天气|预报|知道.*吗)/,
    /\b(search|lookup|find|what|why|how|weather|forecast)\b/i,
  ].some((pattern) => pattern.test(value));
  if (!asksForSimpleLookup) return false;
  return ![
    /(写成|整理成|生成|落地|实现|修复|修改|部署|接入|迁移|重构|监控|报告|文档|方案|测试|验证|长期|持续|任务|task|pr|代码)/,
    /\b(report|doc|document|plan|proposal|implement|fix|deploy|migrate|refactor|monitor|test|verify|task|pr|code)\b/i,
  ].some((pattern) => pattern.test(value));
}

function autoTaskMessageIntent(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;
  if (taskCreationIntent(value)) return true;
  if (quickAnswerIntent(value)) return false;
  if (value.length > 240) return true;
  return [
    /(谁去|谁能|有没有人|请|帮我|帮忙|麻烦|需要|去|把|给我).*(修复|修一下|修改|改一下|实现|做一版|做一下|处理|解决|调研并|测试|验证|检查代码|写|总结成|整理成|生成|规划|设计|接入|部署|运行|迁移|重构|落地)/,
    /(修复|修一下|修改|改一下|实现|做一版|处理|解决|测试|验证|写文档|生成报告|整理方案|落地方案|接入|部署|迁移|重构)/,
    /(fix|implement|debug|test|write|create|build|deploy|review|investigate|summarize into|turn into|migrate|refactor)\b/i,
  ].some((pattern) => pattern.test(value));
}

function agentResponseIntent(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;
  if (autoTaskMessageIntent(value) || quickAnswerIntent(value)) return true;
  return [
    /(谁去|谁能|有没有人|请|帮我|帮忙|麻烦|需要|去|给我|帮我看看|看一下|查一下|查询|搜索|找一下|天气|预报|分析|总结|整理|规划|设计)/,
    /\b(help|search|lookup|find|analyze|summarize|weather|forecast|question)\b/i,
  ].some((pattern) => pattern.test(value));
}

function workLikeMessageIntent(text) {
  return agentResponseIntent(text);
}

function agentAvailableForAutoWork(agent) {
  if (!agent) return false;
  if (['offline', 'error'].includes(String(agent.status || '').toLowerCase())) return false;
  return true;
}

function agentIdleForAvailability(agent) {
  if (!agentAvailableForAutoWork(agent)) return false;
  return ['idle', 'online', 'connected'].includes(String(agent.status || '').toLowerCase());
}

function availabilityBroadcastIntent(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;
  return [
    /(大家|各位|all|team)?.*(谁|哪位|有没有人).*(有空|空闲|能帮|可以帮|available|free)/i,
    /(大家|各位|all|team).*(有空|空闲|在吗|available|free|around)/i,
    /(谁|哪位).*(今天|现在|这会儿|目前)?.*(有空|空闲)/,
    /(anyone|who).*(available|free)/i,
    /\b(is anyone around|who can help)\b/i,
  ].some((pattern) => pattern.test(value));
}

function channelGreetingIntent(text) {
  const value = String(text || '')
    .replace(/<[@!#][^>]+>/g, ' ')
    .trim()
    .toLowerCase();
  if (!value) return false;
  return [
    /^(大家|各位|team|all)?\s*(早上好|上午好|中午好|下午好|晚上好|晚安|你好|你们好|hi|hello|hey)[!！。.\s]*$/i,
    /^(大家|各位|各位朋友|朋友们|team|all|everyone)\s*好[!！。.\s]*$/i,
    /^(hi|hello|hey)\s+(team|all|everyone)[!！。.\s]*$/i,
  ].some((pattern) => pattern.test(value));
}

function directAvailabilityIntent(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;
  return [
    /(有空|空闲|有时间|在吗|忙吗|能接|可以接|能帮|可以帮)/,
    /\b(available|free|around|can help|can take)\b/i,
  ].some((pattern) => pattern.test(value));
}

function availabilityFollowupIntent(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;
  return [
    /(其他|其它|其余|剩下|别的|另外).*(人|agent|几个|几位|一位|两位|二位|三位|四位|五位|六位|七位|八位|九位|十位|一个|两个|二个|三个|四个|五个|六个|七个|八个|九个|十个|呢|有空|空闲|在吗|能接|可以接)/,
    /^(那|那么|还有)?\s*(其他|其它|其余|剩下|别的|另外)\s*([一二两三四五六七八九十0-9]+)?\s*(个|位)?\s*(人|agent)?\s*(呢|吗|嘛|啊|？|\?)?$/i,
    /\b(what about|how about).*(others|the rest|everyone else)\b/i,
    /\b(others|the rest|everyone else)\??$/i,
  ].some((pattern) => pattern.test(value));
}

function messageTimeMs(record) {
  const time = Date.parse(record?.createdAt || '');
  return Number.isFinite(time) ? time : 0;
}

const CONTEXTUAL_FOLLOWUP_WINDOW_MS = 30 * 60 * 1000;

function contextualAgentFollowupIntent(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;
  if (
    availabilityBroadcastIntent(value)
    || availabilityFollowupIntent(value)
    || agentCapabilityQuestionIntent(value)
    || autoTaskMessageIntent(value)
    || channelGreetingIntent(value)
  ) {
    return false;
  }
  if (/(大家|各位|你们|所有人|每个人|全员|全部|其他|其它|别人|all|everyone|team|agents?)/i.test(value)) {
    return false;
  }
  return [
    /(你|你的|你刚才|你心里|你说|你觉得|你那边|你上面|你前面|为什么你|为啥你|那你|所以你)/,
    /^(嗯|呃|哦|噢|那|所以|为啥|为什么|怎么|然后|继续|再说|展开)[，,。.\s]*/i,
    /\b(you|your|why did you|why are you|what do you mean|continue|go on|then)\b/i,
  ].some((pattern) => pattern.test(value));
}

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

function agentCapabilityQuestionIntent(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;
  return [
    /(谁|哪位|哪个|哪些).*(学历|能力|技能|skill|专长|擅长|会|知道|熟悉|更适合|适合|最适合|靠谱|厉害)/i,
    /(比较|介绍|说说).*(agent|成员|大家|每个人|各自).*(能力|技能|专长|职责|擅长)/i,
    /\b(who|which agent).*(best|better|skill|capability|expert|knows|can)\b/i,
  ].some((pattern) => pattern.test(value));
}

function routeEvidence(type, value) {
  return { type, value: String(value || '').slice(0, 240) };
}

function fanoutApiEndpoint(baseUrl) {
  const base = normalizeCloudUrl(baseUrl || '');
  if (!base) return '';
  if (/\/(chat\/completions|responses)$/i.test(base)) return base;
  return `${base}/chat/completions`;
}

function namedAgentsOutsideExplicitMentions(channelAgents, text, mentionedIds = []) {
  const explicit = new Set(normalizeIds(mentionedIds));
  return availableChannelAgents(channelAgents)
    .filter((agent) => !explicit.has(agent.id))
    .filter((agent) => textAddressesAgent(agent, text));
}

function fanoutApiTriggerReason({ channelAgents, mentions, message }) {
  if (!fanoutApiConfigured()) return null;
  if (message?.authorType !== 'human') return null;
  const text = String(message?.body || '');
  if (!text.trim()) return null;
  if (mentions.special.includes('all') || mentions.special.includes('everyone')) return null;
  if (mentions.special.includes('here') || mentions.special.includes('channel')) return null;

  const extraNamed = namedAgentsOutsideExplicitMentions(channelAgents, text, mentions.agents);
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

function fanoutApiMessages({ channelAgents, mentions, message, allCards, trigger }) {
  const channelAgentIds = new Set((channelAgents || []).map((agent) => agent.id));
  const availableIds = availableChannelAgents(channelAgents).map((agent) => agent.id);
  const payload = {
    message: {
      id: message?.id || null,
      authorType: message?.authorType || 'human',
      body: renderMentionsForAgent(message?.body || ''),
      mentionedAgentIds: normalizeIds(mentions.agents),
      specialMentions: normalizeIds(mentions.special),
    },
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
        'Return only a single JSON object matching the requested schema. Do not include markdown.',
      ].join(' '),
    },
    {
      role: 'user',
      content: JSON.stringify(payload),
    },
  ];
}

function fanoutApiResponseText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  const choice = data?.choices?.[0]?.message?.content;
  if (typeof choice === 'string') return choice;
  if (Array.isArray(choice)) {
    return choice.map((part) => part?.text || part?.content || '').join('');
  }
  if (Array.isArray(data?.output)) {
    return data.output
      .flatMap((item) => item?.content || [])
      .map((part) => part?.text || '')
      .join('');
  }
  return '';
}

function parseFanoutApiJson(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Fan-out API returned an empty response.');
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error('Fan-out API did not return valid JSON.');
  }
}

async function callFanoutApi({ channelAgents, mentions, message, spaceId, allCards, trigger }) {
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
        messages: fanoutApiMessages({ channelAgents, mentions, message, spaceId, allCards, trigger }),
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

function inferTaskIntentKind(text) {
  const value = String(text || '').toLowerCase();
  if (/(代码|实现|修复|debug|bug|pr|github|repo|ci|deploy|部署|迁移|重构|code|fix|implement|refactor)/i.test(value)) return 'coding';
  if (/(调研|研究|搜索|资料|竞品|research|lookup|search)/i.test(value)) return 'research';
  if (/(文档|报告|总结|方案|docs?|document|report|plan)/i.test(value)) return 'docs';
  if (/(运行|监控|状态|日志|server|ops|deploy|部署)/i.test(value)) return 'ops';
  if (/(规划|计划|设计|拆分|路线|roadmap|plan|design)/i.test(value)) return 'planning';
  return 'unknown';
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

function userPreferenceIntent(text) {
  const value = String(text || '').trim().toLowerCase();
  if (!value) return false;
  return [
    /(以后|后续|以后都|以后要|请记住|记住|偏好|我喜欢|我希望|不要再|别再|规则|约定|原则)/,
    /\b(remember|preference|from now on|going forward|always|never)\b/i,
  ].some((pattern) => pattern.test(value));
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

// Agent Process Manager - handles agent conversations
function getAgentRuntime(agent) {
  const runtime = String(agent.runtime || '').toLowerCase();
  if (runtime.includes('claude')) return 'claude';
  if (runtime.includes('codex')) return 'codex';
  return 'codex'; // default
}

function createAgentStandingPrompt(agent, spaceType, spaceId) {
  const channel = spaceType === 'channel' ? findChannel(spaceId) : null;
  const spaceName = spaceType === 'dm'
    ? `DM with ${agent.name}`
    : `#${channel?.name || 'channel'}`;
  const toolTarget = spaceType === 'dm' ? `dm:${spaceId}` : `#${channel?.name || 'channel'}`;
  const agentsInSpace = spaceType === 'channel'
    ? channelAgentIds(channel).map(id => findAgent(id)).filter(Boolean)
    : state.agents.filter((item) => item.id === agent.id);
  const humansInSpace = spaceType === 'channel'
    ? channelHumanIds(channel).map(id => findHuman(id)).filter(Boolean)
    : state.humans.filter((item) => item.id === 'hum_local');
  const projectsInSpace = projectsForSpace(spaceType, spaceId);

  return [
    `You are ${agent.name}, an AI agent running in Magclaw.`,
    agent.description ? `Your role: ${agent.description}` : '',
    '',
    'Context:',
    `- You are in: ${spaceName}`,
    `- Your workspace: ${agent.workspace || state.settings.defaultWorkspace || ROOT}`,
    agentsInSpace.length ? `- Agents in this conversation: ${agentsInSpace.map((item) => item.id === agent.id ? `${item.name} (you)` : item.name).join(', ')}` : '',
    humansInSpace.length ? `- Humans in this conversation: ${humansInSpace.map((item) => item.name).join(', ')}` : '',
    projectsInSpace.length ? `- Project folders in this conversation: ${projectsInSpace.map((item) => `${item.name}: ${item.path}`).join('; ')}` : '',
    '',
    'Guidelines:',
    '- Respond helpfully and concisely to the user.',
    '- In a channel, Magclaw may deliver the same open human message to every member agent, similar to a team chat. If the message is not directed at one specific agent and you have useful context, answer briefly from your role.',
    '- If the user names or @mentions another agent, respect that routing and avoid taking over unless you were also named or can add a small coordination note.',
    '- For ordinary chat or coordination, just answer in natural language. Do not run shell commands.',
    '- Do not run Codex memory-writing, memory consolidation, or profile-update workflows inside MagClaw chat turns.',
    '- For simple Q&A, greetings, role questions, one-off lookups, weather/forecast requests, or lightweight coordination, answer in the current thread and do not create a task.',
    '- For simple lookup/weather requests, use at most one or two authoritative lookups, then reply with a compact answer. Do not inspect local files or run project/memory workflows unless the user explicitly asks.',
    '- Each delivered message includes a bracket header such as `[target=#all:msg_xxx workItem=wi_xxx msg=msg_xxx task=task_xxx ...]`. Treat target and workItem as routing authority.',
    '- For multi-channel, multi-task, or thread/task work, reply with the controlled send_message API: POST /api/agent-tools/messages/send using the exact target and workItemId from the current header.',
    '- If you call send_message for a work item, Magclaw will not duplicate your final stdout for that same turn. If you do not call send_message, Magclaw will post your final stdout back to the source thread as a compatibility fallback.',
    '- Never guess a channel or thread target. Use the exact target from the header or read/search history first.',
    '- If the current prompt includes Magclaw history tools, you may use them to read or search conversation history when the compact snapshot is insufficient.',
    '- You may call the controlled Magclaw agent tool APIs when needed: GET /api/agent-tools/history, GET /api/agent-tools/search, POST /api/agent-tools/messages/send, POST /api/agent-tools/tasks, POST /api/agent-tools/tasks/claim, and POST /api/agent-tools/tasks/update.',
    `- Create a new task with: curl -sS -X POST http://${HOST}:${PORT}/api/agent-tools/tasks -H 'content-type: application/json' -d '{"agentId":"${agent.id}","channel":"${toolTarget}","claim":true,"tasks":[{"title":"Task title"}]}'`,
    `- Update a claimed task with: curl -sS -X POST http://${HOST}:${PORT}/api/agent-tools/tasks/update -H 'content-type: application/json' -d '{"agentId":"${agent.id}","taskId":"task_xxx","status":"in_review"}'`,
    '- Create or claim tasks only for durable work with progress/state: coding changes, debugging, deployment, docs/report deliverables, multi-step research, migrations, reviews, or when the user explicitly says task/as task/创建任务.',
    '- When a user asks for actionable durable work, claim the existing task if Magclaw already created one for you, then continue the work in the task thread.',
    '- Thread replies cannot become tasks directly. If new work emerges in a thread, create a new top-level task-message with sourceMessageId/sourceReplyId instead of claiming the reply.',
    '- If work already exists as a task, claim it instead of creating a duplicate.',
    '- Maintain your own workspace memory by default: write high-value preferences, specialties, work logs, and durable handoff facts to MEMORY.md or notes/ during important task progress.',
    '- After important task progress or completion, update your MEMORY.md with structured notes under Active Tasks, Channel Context, and Work Log. Keep it concise and progressively disclosed; put detail notes under notes/ when needed.',
    '- Mention another participant with their visible name, for example @Alice. Do not expose internal ids like agt_xxx, hum_xxx, or raw <@...> tokens.',
    '- If a user references a local file or folder with @, treat the shown path as the original project file/folder, not as an uploaded attachment copy.',
    '- If asked to perform coding tasks, do them in your workspace and summarize the result.',
    '- Be conversational but professional.',
    '',
    'The user will send you messages. Respond naturally.',
  ].filter(Boolean).join('\n');
}

function messageAddressingHint(message, agent) {
  if (message.mentionedAgentIds?.includes(agent.id)) return ' mentioned you';
  return '';
}

function createAgentTurnPrompt(messages, agent) {
  return messages.map(m => {
    if (m.contextPack) {
      return renderAgentContextPack(m.contextPack, { state, targetAgentId: agent.id });
    }
    const author = displayActor(m.authorId);
    const refs = localReferenceLines(m.localReferences?.length ? m.localReferences : extractLocalReferences(m.body || ''));
    return `[${author}${messageAddressingHint(m, agent)}]: ${renderMentionsForAgent(m.body)}${refs ? `\nLocal project references:\n${refs}` : ''}`;
  }).join('\n\n');
}

async function startAgentProcess(agent, spaceType, spaceId, initialMessage) {
  const agentId = agent.id;
  const runtime = getAgentRuntime(agent);
  const workspace = path.resolve(agent.workspace || state.settings.defaultWorkspace || ROOT);
  const initialMessages = Array.isArray(initialMessage)
    ? initialMessage.filter(Boolean)
    : (initialMessage ? [initialMessage] : []);

  // Check if agent already has a running process
  if (agentProcesses.has(agentId)) {
    const proc = agentProcesses.get(agentId);
    if (proc.status === 'running' || proc.status === 'starting') {
      // Queue the message for delivery
      proc.inbox.push(...initialMessages);
      return proc;
    }
  }

  // Create agent process entry
  const sessionId = makeId('sess');
  const proc = {
    sessionId,
    agentId,
    spaceType,
    spaceId,
    status: 'starting',
    inbox: initialMessages,
    pendingDeliveryMessages: [],
    busyDeliveryTimer: null,
    promptMessageCount: 0,
    child: null,
    runtime,
    parentMessageId: initialMessages[0]?.parentMessageId || null,
    startedAt: now(),
  };
  agentProcesses.set(agentId, proc);

  // Update agent status
  setAgentStatus(agent, 'starting', 'delivery_started');
  await persistState();
  broadcastState();

  addSystemEvent('agent_starting', `Starting ${agent.name} (${runtime})`, { agentId, sessionId });

  if (runtime === 'claude') {
    await startClaudeAgent(agent, proc, workspace);
  } else {
    await startCodexAgent(agent, proc, workspace);
  }

  return proc;
}

async function startClaudeAgent(agent, proc, workspace) {
  // TODO: Move Claude to the same persistent resume/steer contract once its CLI exposes a stable app-server style API.
  const standingPrompt = createAgentStandingPrompt(agent, proc.spaceType, proc.spaceId);
  const promptMessages = proc.inbox.slice();
  proc.promptMessageCount = promptMessages.length;
  proc.lastSourceMessage = promptMessages[promptMessages.length - 1] || null;
  const turnPrompt = createAgentTurnPrompt(promptMessages, agent);
  const fullPrompt = `${standingPrompt}\n\n---\n\n${turnPrompt}`;

  // Claude Code headless mode using --print for simple response
  const args = [
    '--print',
    '-p', fullPrompt,
  ];

  if (agent.model) {
    args.push('--model', agent.model);
  }

  proc.status = 'running';
  addSystemEvent('agent_started', `${agent.name} started with Claude Code`, { agentId: agent.id });
  markWorkItemsDelivered(promptMessages, 'turn');
  await persistState();
  broadcastState();

  const child = spawn('claude', args, {
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(agent.envVars ? Object.fromEntries(agent.envVars.map(e => [e.key, e.value])) : {}),
    },
  });

  proc.child = child;
  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  child.on('error', async (error) => {
    proc.status = 'error';
    setAgentStatus(agent, 'error', 'claude_error');
    addSystemEvent('agent_error', `${agent.name} error: ${error.message}`, { agentId: agent.id });
    await persistState();
    broadcastState();
    agentProcesses.delete(agent.id);
  });

  child.on('close', async (code) => {
    const queuedMessages = proc.stopRequested ? (proc.restartMessagesAfterStop || []) : proc.inbox.slice(proc.promptMessageCount);
    const sourceMessage = proc.inbox[Math.max(0, proc.promptMessageCount - 1)] || null;
    proc.status = 'idle';
    setAgentStatus(agent, 'idle', 'claude_turn_closed');

	    // Post the response back to the conversation
	    const responseText = stdout.trim() || stderr.trim() || '(No response)';
	    const fallbackGuard = { workItemIds: [sourceMessage?.workItemId].filter(Boolean) };
	    if (responseText && responseText !== '(No response)' && proc.suppressOutput) {
	      addSystemEvent('agent_stdout_suppressed', `${agent.name} stopped before posting final stdout.`, {
	        agentId: agent.id,
	        workItemId: sourceMessage?.workItemId || null,
	      });
	    } else if (responseText && responseText !== '(No response)' && turnMetaAllWorkCancelled(fallbackGuard)) {
	      addSystemEvent('agent_stdout_suppressed', `${agent.name} output was suppressed for stopped work.`, {
	        agentId: agent.id,
	        workItemId: sourceMessage?.workItemId || null,
	      });
	    } else if (responseText && responseText !== '(No response)' && !turnMetaHasExplicitSend(fallbackGuard)) {
	      const posted = await postAgentResponse(agent, proc.spaceType, proc.spaceId, responseText, proc.parentMessageId, { sourceMessage });
	      markFallbackResponseWorkItem(sourceMessage, posted);
	    } else if (responseText && responseText !== '(No response)') {
      addSystemEvent('agent_stdout_suppressed', `${agent.name} used send_message; final stdout fallback was suppressed.`, {
        agentId: agent.id,
        workItemId: sourceMessage?.workItemId || null,
      });
    }

    addSystemEvent(proc.stopRequested ? 'agent_stopped' : 'agent_completed', `${agent.name} ${proc.stopRequested ? 'stopped' : 'finished'} (code ${code})`, { agentId: agent.id });
    await persistState();
    broadcastState();
    agentProcesses.delete(agent.id);
    restartAgentWithQueuedMessages(agent, proc, queuedMessages);
  });
}

async function startCodexAgent(agent, proc, workspace) {
  const standingPrompt = createAgentStandingPrompt(agent, proc.spaceType, proc.spaceId);
  const promptMessages = proc.inbox.slice();
  proc.promptMessageCount = promptMessages.length;
  const turnPrompt = createAgentTurnPrompt(promptMessages, agent);
  const args = ['app-server', '--listen', 'stdio://'];
  const codexHome = await prepareAgentCodexHome(agent);

  proc.requestId = 0;
  proc.stdoutBuffer = '';
	  proc.responseBuffer = '';
	  proc.activeTurnId = null;
	  proc.activeTurnIds = new Set();
	  proc.activeTurnTargets = new Set();
	  proc.pendingTurnRequests = new Map();
  proc.turnMeta = new Map();
  proc.pendingInitialPrompt = promptMessages.length ? turnPrompt : null;
  proc.pendingInitialMessages = promptMessages;
  proc.pendingDeliveryMessages = Array.isArray(proc.pendingDeliveryMessages) ? proc.pendingDeliveryMessages : [];
  proc.busyDeliveryTimer = proc.busyDeliveryTimer || null;
  proc.pendingThreadRequest = null;
  proc.initializeRequestId = null;
  proc.threadReady = false;
  proc.usedLegacyFallback = false;
  proc.status = 'starting';
  setAgentStatus(agent, 'starting', 'codex_app_server_start');
  agent.runtimeLastStartedAt = now();
  await writeAgentSessionFile(agent).catch(() => {});

  addSystemEvent('agent_started', `${agent.name} starting with Codex app-server`, { agentId: agent.id });

  const child = spawn(state.settings.codexPath || 'codex', args, {
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NO_COLOR: '1',
      ...(agent.envVars ? Object.fromEntries(agent.envVars.map(e => [e.key, e.value])) : {}),
      CODEX_HOME: codexHome,
    },
  });

  proc.child = child;

  child.stdout.on('data', (chunk) => {
    proc.stdoutBuffer += chunk.toString();
    const lines = proc.stdoutBuffer.split(/\r?\n/);
    proc.stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      handleCodexAppServerLine(agent, proc, line).catch((error) => {
        addSystemEvent('agent_error', `${agent.name} app-server event error: ${error.message}`, { agentId: agent.id });
      });
    }
  });

  child.stderr.on('data', (chunk) => {
    const msg = chunk.toString().trim();
    if (msg) addSystemEvent('agent_stderr', msg, { agentId: agent.id });
  });

  child.on('error', async (error) => {
    clearAgentBusyDeliveryTimer(proc);
    if (!proc.threadReady && !proc.usedLegacyFallback) {
      await fallbackToCodexExec(agent, proc, workspace, error);
      return;
    }
    proc.status = 'error';
    setAgentStatus(agent, 'error', 'codex_app_server_error');
    addSystemEvent('agent_error', `${agent.name} error: ${error.message}`, { agentId: agent.id });
    await persistState();
    broadcastState();
    agentProcesses.delete(agent.id);
  });

  child.on('close', async (code) => {
    clearAgentBusyDeliveryTimer(proc);
    if (!proc.threadReady && !proc.usedLegacyFallback) {
      if (proc.stopRequested) {
        proc.status = 'idle';
        setAgentStatus(agent, proc.restartMessagesAfterStop?.length ? 'queued' : 'idle', 'codex_stopped_before_ready');
        addSystemEvent('agent_stopped', `${agent.name} stopped before Codex session was ready`, { agentId: agent.id });
        await persistState();
        broadcastState();
        agentProcesses.delete(agent.id);
        restartAgentWithQueuedMessages(agent, proc, proc.restartMessagesAfterStop || []);
        return;
      }
      await fallbackToCodexExec(agent, proc, workspace, new Error(`Codex app-server exited before thread start (code ${code ?? 'unknown'}).`));
      return;
    }
    if (!proc.suppressOutput && proc.responseBuffer.trim()) {
      const sourceMessage = proc.lastSourceMessage || proc.inbox[Math.max(0, proc.promptMessageCount - 1)] || null;
      if (turnMetaHasExplicitSend({ workItemIds: [sourceMessage?.workItemId].filter(Boolean) })) {
        addSystemEvent('agent_stdout_suppressed', `${agent.name} used send_message; final stdout fallback was suppressed.`, {
          agentId: agent.id,
          workItemId: sourceMessage?.workItemId || null,
        });
		      } else {
		        const posted = await postAgentResponse(agent, proc.spaceType, proc.spaceId, proc.responseBuffer.trim(), deliveryParentMessageId(sourceMessage, proc.parentMessageId), { sourceMessage });
		        markFallbackResponseWorkItem(sourceMessage, posted);
		      }
      proc.responseBuffer = '';
    } else if (proc.suppressOutput && proc.responseBuffer.trim()) {
      proc.responseBuffer = '';
      addSystemEvent('agent_stdout_suppressed', `${agent.name} stopped before posting buffered output.`, { agentId: agent.id });
    }
    proc.status = proc.stopRequested || code === 0 ? 'idle' : 'error';
    setAgentStatus(agent, proc.stopRequested
      ? (proc.restartMessagesAfterStop?.length ? 'queued' : 'idle')
      : (code === 0 ? 'idle' : 'error'), 'codex_app_server_closed');
    addSystemEvent(proc.stopRequested ? 'agent_stopped' : (code === 0 ? 'agent_app_server_closed' : 'agent_error'), `${agent.name} Codex app-server ${proc.stopRequested ? 'stopped' : 'exited'} (code ${code ?? 'unknown'})`, { agentId: agent.id });
    await writeAgentSessionFile(agent).catch(() => {});
    await persistState();
    broadcastState();
    agentProcesses.delete(agent.id);
    restartAgentWithQueuedMessages(agent, proc, proc.restartMessagesAfterStop || []);
  });

  proc.initializeRequestId = sendCodexAppServerRequest(proc, 'initialize', {
    clientInfo: { name: 'magclaw', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });
  proc.pendingThreadRequest = {
    method: agent.runtimeSessionId ? 'thread/resume' : 'thread/start',
    params: {
      ...(agent.runtimeSessionId ? { threadId: agent.runtimeSessionId } : {}),
      cwd: workspace,
      approvalPolicy: 'never',
      sandbox: state.settings.sandbox || 'workspace-write',
      developerInstructions: standingPrompt,
      model: normalizeCodexModelName(agent.model, state.settings?.model),
      ...(agent.reasoningEffort ? { config: { model_reasoning_effort: agent.reasoningEffort } } : {}),
    },
  };
  await persistState();
  broadcastState();
}

function nextCodexRequestId(proc) {
  proc.requestId = Number(proc.requestId || 0) + 1;
  return proc.requestId;
}

function sendCodexAppServerRequest(proc, method, params = {}) {
  if (!proc.child?.stdin?.writable) return null;
  const id = nextCodexRequestId(proc);
  proc.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return id;
}

function sendCodexAppServerNotification(proc, method, params = {}) {
  if (!proc.child?.stdin?.writable) return;
  proc.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

async function handleCodexThreadReady(agent, proc, threadId) {
  proc.threadId = threadId;
  proc.threadReady = true;
  agent.runtimeSessionId = threadId;
  await writeAgentSessionFile(agent).catch(() => {});
  addSystemEvent('agent_session_ready', `${agent.name} Codex session ready`, { agentId: agent.id, sessionId: threadId });
  if (proc.pendingInitialPrompt) {
    const prompt = proc.pendingInitialPrompt;
    const messages = proc.pendingInitialMessages || [];
    proc.pendingInitialPrompt = null;
    proc.pendingInitialMessages = [];
    if (startCodexAppServerTurn(agent, proc, prompt, { mode: 'turn', messages })) {
      proc.lastSourceMessage = messages[messages.length - 1] || proc.lastSourceMessage || null;
      markWorkItemsDelivered(messages, 'turn');
    }
  } else {
    proc.status = 'idle';
    setAgentStatus(agent, 'idle', 'codex_process_ready');
    addSystemEvent('agent_process_ready', `${agent.name} is ready and waiting for messages.`, { agentId: agent.id, sessionId: threadId });
  }
  await persistState();
  broadcastState();
}

function deliveryTargetKey(message) {
  if (!message) return '';
  const taskSuffix = message.taskId ? ` task=${message.taskId}` : '';
  if (message.target) return `${String(message.target)}${taskSuffix}`;
  if (message.spaceType && message.spaceId) {
    return `${targetForConversation(message.spaceType, message.spaceId, message.parentMessageId || null)}${taskSuffix}`;
  }
  return taskSuffix.trim();
}

function deliveryTargetKeys(messages) {
  return [...new Set((Array.isArray(messages) ? messages : [messages])
    .map(deliveryTargetKey)
    .filter(Boolean))];
}

function rememberActiveTurnTargets(proc, mode, targetKeys = []) {
  const keys = Array.isArray(targetKeys) ? targetKeys.filter(Boolean) : [];
  if (!keys.length) return;
  if (mode === 'steer') {
    proc.activeTurnTargets = proc.activeTurnTargets instanceof Set ? proc.activeTurnTargets : new Set();
    for (const key of keys) proc.activeTurnTargets.add(key);
    return;
  }
  proc.activeTurnTargets = new Set(keys);
}

function pendingMatchesActiveTurnTargets(proc, pendingMessages) {
  const activeTargets = proc?.activeTurnTargets instanceof Set ? proc.activeTurnTargets : new Set();
  if (!activeTargets.size) return false;
  const pendingKeys = deliveryTargetKeys(pendingMessages);
  if (!pendingKeys.length) return false;
  return pendingKeys.every((key) => activeTargets.has(key));
}

function deliveryParentMessageId(sourceMessage, fallbackParentMessageId = null) {
  if (sourceMessage) return sourceMessage.parentMessageId || null;
  return fallbackParentMessageId || null;
}

function applyAgentProcessDeliveryScope(proc, spaceType, spaceId, parentMessageId = null) {
  if (!proc) return;
  proc.spaceType = spaceType;
  proc.spaceId = spaceId;
  proc.parentMessageId = parentMessageId || null;
}

function startCodexAppServerTurn(agent, proc, prompt, { mode = 'turn', messages = [] } = {}) {
  if (!proc.threadId) return false;
  const input = [{ type: 'text', text: prompt }];
  let requestId = null;
  if (mode === 'steer' && proc.activeTurnId) {
    requestId = sendCodexAppServerRequest(proc, 'turn/steer', {
      threadId: proc.threadId,
      expectedTurnId: proc.activeTurnId,
      input,
    });
  } else {
    requestId = sendCodexAppServerRequest(proc, 'turn/start', {
      threadId: proc.threadId,
      input,
    });
  }
  if (!requestId) return false;
  const promptMessages = Array.isArray(messages) ? messages.filter(Boolean) : [];
  const sourceMessage = promptMessages[promptMessages.length - 1] || null;
  const targetKeys = deliveryTargetKeys(promptMessages);
  proc.pendingTurnRequests = proc.pendingTurnRequests || new Map();
  proc.pendingTurnRequests.set(requestId, {
    parentMessageId: deliveryParentMessageId(sourceMessage, proc.parentMessageId),
    sourceMessage,
    spaceType: sourceMessage?.spaceType || proc.spaceType,
    spaceId: sourceMessage?.spaceId || proc.spaceId,
    workItemIds: normalizeIds(promptMessages.map((message) => message?.workItemId)),
    targetKeys,
  });
  rememberActiveTurnTargets(proc, mode, targetKeys);
  proc.status = 'running';
  setAgentStatus(agent, mode === 'steer' ? 'working' : 'thinking', mode === 'steer' ? 'agent_steered' : 'agent_turn_started', {
    activeWorkItemIds: normalizeIds(promptMessages.map((message) => message?.workItemId)),
  });
  agent.runtimeLastTurnAt = now();
  addSystemEvent(mode === 'steer' ? 'agent_steered' : 'agent_turn_started', `${agent.name} ${mode === 'steer' ? 'received a steering message' : 'started a turn'}`, { agentId: agent.id, sessionId: proc.threadId });
  persistState().then(broadcastState);
  return true;
}

async function sendCodexAppServerMessages(agent, proc, messages, { mode = 'turn' } = {}) {
  const promptMessages = Array.isArray(messages) ? messages.filter(Boolean) : [messages].filter(Boolean);
  if (!promptMessages.length) return false;
  const prompt = createAgentTurnPrompt(promptMessages, agent);
  const sent = mode === 'steer'
    ? startCodexAppServerTurn(agent, proc, prompt, { mode: 'steer', messages: promptMessages })
    : (proc.status === 'idle' && startCodexAppServerTurn(agent, proc, prompt, { mode: 'turn', messages: promptMessages }));
  if (!sent) return false;
  proc.inbox.push(...promptMessages);
  proc.promptMessageCount = proc.inbox.length;
  proc.lastSourceMessage = promptMessages[promptMessages.length - 1] || proc.lastSourceMessage || null;
  markWorkItemsDelivered(promptMessages, mode);
  return true;
}

function clearAgentBusyDeliveryTimer(proc) {
  if (!proc?.busyDeliveryTimer) return;
  clearTimeout(proc.busyDeliveryTimer);
  proc.busyDeliveryTimer = null;
}

function queueCodexBusyDelivery(agent, proc, deliveryMessage) {
  proc.pendingDeliveryMessages = Array.isArray(proc.pendingDeliveryMessages) ? proc.pendingDeliveryMessages : [];
  proc.pendingDeliveryMessages.push(deliveryMessage);
  addSystemEvent('message_queued', `Message queued for busy agent ${agent.name}`, {
    agentId: agent.id,
    messageId: deliveryMessage.id,
    parentMessageId: deliveryMessage.parentMessageId || null,
    workItemId: deliveryMessage.workItemId || null,
  });
  scheduleCodexBusyDelivery(agent, proc);
}

function scheduleCodexBusyDelivery(agent, proc) {
  if (!proc || proc.busyDeliveryTimer) return;
  proc.busyDeliveryTimer = setTimeout(() => {
    proc.busyDeliveryTimer = null;
    flushCodexPendingDeliveries(agent, proc).catch((error) => {
      addSystemEvent('delivery_error', `Failed to steer queued messages to ${agent.name}: ${error.message}`, {
        agentId: agent.id,
      });
    });
  }, AGENT_BUSY_DELIVERY_DELAY_MS);
}

async function flushCodexPendingDeliveries(agent, proc) {
  const pending = Array.isArray(proc?.pendingDeliveryMessages) ? proc.pendingDeliveryMessages : [];
  if (!pending.length) return false;
  if (!proc.child || proc.child.killed || !proc.threadId) {
    scheduleCodexBusyDelivery(agent, proc);
    return false;
  }
  const wantsSteer = proc.status === 'running' || proc.status === 'starting';
  if (wantsSteer && !proc.activeTurnId) {
    scheduleCodexBusyDelivery(agent, proc);
    return false;
  }
  if (wantsSteer && !pendingMatchesActiveTurnTargets(proc, pending)) {
    scheduleCodexBusyDelivery(agent, proc);
    return false;
  }
  const batch = pending.splice(0, pending.length);
  const mode = wantsSteer ? 'steer' : 'turn';
  const sent = await sendCodexAppServerMessages(agent, proc, batch, { mode });
  if (!sent) {
    proc.pendingDeliveryMessages = [...batch, ...(proc.pendingDeliveryMessages || [])];
    scheduleCodexBusyDelivery(agent, proc);
    return false;
  }
  addSystemEvent(mode === 'steer' ? 'agent_busy_batch_delivered' : 'agent_queue_turn_delivered', `${agent.name} received ${batch.length} queued message(s).`, {
    agentId: agent.id,
    count: batch.length,
    mode,
  });
  return true;
}

async function handleCodexTurnCompleted(agent, proc, turn) {
  const turnId = turn?.id || proc.activeTurnId;
  if (turnId) proc.activeTurnIds?.delete(turnId);
  if (turn?.status === 'failed' && turn?.error?.message) {
    addSystemEvent('agent_error', `${agent.name} turn failed: ${turn.error.message}`, { agentId: agent.id, sessionId: proc.threadId });
  }
  const turnMeta = turnId ? proc.turnMeta?.get(turnId) : null;
  if (turnId) proc.turnMeta?.delete(turnId);
  if (proc.responseBuffer.trim()) {
    const responseText = proc.responseBuffer.trim();
    proc.responseBuffer = '';
    if (turnMeta && turnMetaAllWorkCancelled(turnMeta)) {
      addSystemEvent('agent_stdout_suppressed', `${agent.name} output was suppressed for stopped work.`, {
        agentId: agent.id,
        sessionId: proc.threadId,
        turnId,
        workItemIds: turnMeta.workItemIds || [],
      });
    } else if (turnMeta && turnMetaHasExplicitSend(turnMeta)) {
      addSystemEvent('agent_stdout_suppressed', `${agent.name} used send_message; final stdout fallback was suppressed.`, {
        agentId: agent.id,
        sessionId: proc.threadId,
        turnId,
        workItemIds: turnMeta.workItemIds || [],
      });
    } else if (turnMeta) {
      const sourceMessage = turnMeta.sourceMessage || proc.lastSourceMessage || proc.inbox[Math.max(0, proc.promptMessageCount - 1)] || null;
      const posted = await postAgentResponse(agent, turnMeta.spaceType || proc.spaceType, turnMeta.spaceId || proc.spaceId, responseText, deliveryParentMessageId(sourceMessage, turnMeta.parentMessageId), { sourceMessage });
      markFallbackResponseWorkItems(sourceMessage, posted, turnMeta.workItemIds || []);
    } else {
      addSystemEvent('agent_unsolicited_turn_suppressed', `${agent.name} produced output for an untracked Codex turn; output was not posted.`, {
        agentId: agent.id,
        sessionId: proc.threadId,
        turnId,
      });
    }
  }
  if (!proc.activeTurnIds?.size) {
    proc.activeTurnId = null;
    proc.activeTurnTargets = new Set();
    proc.status = 'idle';
    setAgentStatus(agent, 'idle', 'codex_turn_completed', { activeWorkItemIds: [] });
  }
  if (!proc.activeTurnIds?.size && proc.pendingDeliveryMessages?.length) {
    clearAgentBusyDeliveryTimer(proc);
    await flushCodexPendingDeliveries(agent, proc);
  }
  await writeAgentSessionFile(agent).catch(() => {});
  await persistState();
  broadcastState();
}

async function handleCodexAppServerLine(agent, proc, line) {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    addSystemEvent('agent_stdout', line.slice(0, 600), { agentId: agent.id });
    return;
  }

  if (message.result) {
    if (message.id === proc.initializeRequestId) {
      proc.initializeRequestId = null;
      sendCodexAppServerNotification(proc, 'initialized', {});
      if (proc.pendingThreadRequest) {
        sendCodexAppServerRequest(proc, proc.pendingThreadRequest.method, proc.pendingThreadRequest.params);
        proc.pendingThreadRequest = null;
      }
      return;
    }
    const threadId = message.result.thread?.id;
    if (typeof threadId === 'string') {
      await handleCodexThreadReady(agent, proc, threadId);
      return;
    }
    const turnId = message.result.turn?.id || message.result.turnId;
    if (typeof turnId === 'string') {
      proc.activeTurnId = turnId;
      proc.activeTurnIds = proc.activeTurnIds || new Set();
      proc.activeTurnIds.add(turnId);
      const meta = proc.pendingTurnRequests?.get(message.id);
      if (meta) {
        proc.turnMeta = proc.turnMeta || new Map();
        proc.turnMeta.set(turnId, meta);
        proc.pendingTurnRequests.delete(message.id);
      }
      return;
    }
  }

  if (message.error) {
    addSystemEvent('agent_error', `${agent.name} app-server request failed: ${message.error.message || 'unknown error'}`, { agentId: agent.id, raw: message.error });
    return;
  }

  switch (message.method) {
    case 'thread/started': {
      const threadId = message.params?.thread?.id;
      if (typeof threadId === 'string') await handleCodexThreadReady(agent, proc, threadId);
      break;
    }
    case 'turn/started': {
      const turnId = message.params?.turn?.id;
      if (typeof turnId === 'string') {
        proc.activeTurnId = turnId;
        proc.activeTurnIds = proc.activeTurnIds || new Set();
        proc.activeTurnIds.add(turnId);
      }
      proc.status = 'running';
      setAgentStatus(agent, 'thinking', 'codex_turn_started');
      await persistState();
      broadcastState();
      break;
    }
    case 'item/agentMessage/delta': {
      const delta = message.params?.delta;
      if (typeof delta === 'string') proc.responseBuffer += delta;
      break;
    }
    case 'item/completed': {
      const item = message.params?.item;
      if (item?.type === 'agentMessage' && typeof item.text === 'string' && item.text && !proc.responseBuffer.includes(item.text)) {
        proc.responseBuffer += item.text;
      }
      if (item?.type === 'commandExecution' || item?.type === 'mcpToolCall' || item?.type === 'collabAgentToolCall') {
        addSystemEvent('agent_activity', summarizeCodexEvent(item), { agentId: agent.id, raw: item });
      }
      break;
    }
    case 'item/started': {
      const item = message.params?.item;
      if (item?.type) addSystemEvent('agent_activity', `${agent.name}: ${item.type}`, { agentId: agent.id, raw: item });
      break;
    }
    case 'turn/completed': {
      await handleCodexTurnCompleted(agent, proc, message.params?.turn || {});
      break;
    }
    case 'error':
      addSystemEvent('agent_error', `${agent.name} app-server error`, { agentId: agent.id, raw: message.params });
      break;
  }
}

async function fallbackToCodexExec(agent, proc, workspace, error) {
  proc.usedLegacyFallback = true;
  addSystemEvent('agent_runtime_fallback', `${agent.name} falling back to legacy codex exec: ${error.message}`, { agentId: agent.id });
  if (proc.child && !proc.child.killed) proc.child.kill('SIGTERM');
  await startCodexAgentLegacy(agent, proc, workspace);
}

async function startCodexAgentLegacy(agent, proc, workspace) {
  const standingPrompt = createAgentStandingPrompt(agent, proc.spaceType, proc.spaceId);
  const promptMessages = proc.inbox.slice();
  proc.promptMessageCount = promptMessages.length;
  const turnPrompt = createAgentTurnPrompt(promptMessages, agent);
  const fullPrompt = `${standingPrompt}\n\n---\n\n${turnPrompt}`;
  const codexHome = await prepareAgentCodexHome(agent);

  const outputFile = path.join(RUNS_DIR, `${proc.sessionId}-agent-response.txt`);

  // Codex exec mode for agent conversation
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox', state.settings.sandbox || 'read-only',
    '-C', workspace,
    '-o', outputFile,
  ];

  const model = normalizeCodexModelName(agent.model, state.settings?.model);
  if (model) {
    args.push('-m', model);
  }

  if (agent.reasoningEffort) {
    args.push('-c', `model_reasoning_effort=${JSON.stringify(agent.reasoningEffort)}`);
  }

  args.push('-');

  proc.status = 'running';
  setAgentStatus(agent, 'thinking', 'codex_legacy_turn_started', {
    activeWorkItemIds: normalizeIds(promptMessages.map((message) => message?.workItemId)),
  });
  addSystemEvent('agent_started', `${agent.name} started with Codex`, { agentId: agent.id });
  markWorkItemsDelivered(promptMessages, 'turn');
  await persistState();
  broadcastState();

  const child = spawn(state.settings.codexPath || 'codex', args, {
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(agent.envVars ? Object.fromEntries(agent.envVars.map(e => [e.key, e.value])) : {}),
      CODEX_HOME: codexHome,
    },
  });

  proc.child = child;
  let stdoutBuffer = '';

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) {
        try {
          const event = JSON.parse(line);
          addSystemEvent('agent_activity', summarizeCodexEvent(event), { agentId: agent.id, raw: event });
        } catch {
          // ignore non-JSON lines
        }
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    const msg = chunk.toString().trim();
    if (msg) {
      addSystemEvent('agent_stderr', msg, { agentId: agent.id });
    }
  });

  child.on('error', async (error) => {
    proc.status = 'error';
    setAgentStatus(agent, 'error', 'codex_legacy_error');
    addSystemEvent('agent_error', `${agent.name} error: ${error.message}`, { agentId: agent.id });
    await persistState();
    broadcastState();
    agentProcesses.delete(agent.id);
  });

  child.on('close', async (code) => {
    const queuedMessages = proc.stopRequested ? (proc.restartMessagesAfterStop || []) : proc.inbox.slice(proc.promptMessageCount);
    const sourceMessage = proc.inbox[Math.max(0, proc.promptMessageCount - 1)] || null;
    proc.status = 'idle';
    setAgentStatus(agent, 'idle', 'codex_legacy_closed', { activeWorkItemIds: [] });

    // Read the output file for the response
    let responseText = '';
    try {
      responseText = (await readFile(outputFile, 'utf8')).trim();
    } catch {
      responseText = '';
    }

    const fallbackGuard = { workItemIds: [sourceMessage?.workItemId].filter(Boolean) };
    if (responseText && proc.suppressOutput) {
      addSystemEvent('agent_stdout_suppressed', `${agent.name} stopped before posting final stdout.`, {
        agentId: agent.id,
        workItemId: sourceMessage?.workItemId || null,
      });
    } else if (responseText && turnMetaAllWorkCancelled(fallbackGuard)) {
      addSystemEvent('agent_stdout_suppressed', `${agent.name} output was suppressed for stopped work.`, {
        agentId: agent.id,
        workItemId: sourceMessage?.workItemId || null,
      });
    } else if (responseText && !turnMetaHasExplicitSend(fallbackGuard)) {
      await postAgentResponse(agent, proc.spaceType, proc.spaceId, responseText, proc.parentMessageId, { sourceMessage });
    } else if (responseText) {
      addSystemEvent('agent_stdout_suppressed', `${agent.name} used send_message; final stdout fallback was suppressed.`, {
        agentId: agent.id,
        workItemId: sourceMessage?.workItemId || null,
      });
    }

    addSystemEvent(proc.stopRequested ? 'agent_stopped' : 'agent_completed', `${agent.name} ${proc.stopRequested ? 'stopped' : 'finished'} (code ${code})`, { agentId: agent.id });
    await persistState();
    broadcastState();
    agentProcesses.delete(agent.id);
    restartAgentWithQueuedMessages(agent, proc, queuedMessages);
  });

  // Write the prompt to stdin
  child.stdin.write(fullPrompt);
  child.stdin.end();
}

function restartAgentWithQueuedMessages(agent, proc, queuedMessages = []) {
  if (!queuedMessages.length) return;
  const firstQueued = queuedMessages[0];
  const nextSpaceType = firstQueued.spaceType || proc.spaceType;
  const nextSpaceId = firstQueued.spaceId || proc.spaceId;
  addSystemEvent('agent_queue_drained', `${agent.name} has ${queuedMessages.length} queued message(s)`, {
    agentId: agent.id,
    count: queuedMessages.length,
    spaceType: nextSpaceType,
    spaceId: nextSpaceId,
  });
  startAgentProcess(agent, nextSpaceType, nextSpaceId, queuedMessages).catch((error) => {
    addSystemEvent('agent_error', `${agent.name} queue restart failed: ${error.message}`, { agentId: agent.id });
  });
}

function partitionMessagesByScope(messages, scope) {
  const scoped = [];
  const other = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    (deliveryMessageMatchesScope(message, scope) ? scoped : other).push(message);
  }
  return { scoped, other };
}

function partitionMessagesByTask(messages, task) {
  const scoped = [];
  const other = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    (deliveryMessageMatchesTask(message, task) ? scoped : other).push(message);
  }
  return { scoped, other };
}

function cancelWorkItemsForScope(scope, agentId = null) {
  const cancelled = [];
  state.workItems = Array.isArray(state.workItems) ? state.workItems : [];
  for (const item of state.workItems) {
    if (agentId && item.agentId !== agentId) continue;
    if (!workItemMatchesScope(item, scope)) continue;
    if (item.status === 'responded' || item.status === 'cancelled') continue;
    item.status = 'cancelled';
    item.cancelledAt = item.cancelledAt || now();
    item.updatedAt = now();
    item.cancelScope = scope ? { spaceType: scope.spaceType, spaceId: scope.spaceId } : null;
    cancelled.push(item.id);
  }
  return cancelled;
}

function cancelWorkItemsForTask(task, agentId = null) {
  const cancelled = [];
  state.workItems = Array.isArray(state.workItems) ? state.workItems : [];
  for (const item of state.workItems) {
    if (agentId && item.agentId !== agentId) continue;
    if (!workItemMatchesTask(item, task)) continue;
    if (item.status === 'responded' || item.status === 'cancelled') continue;
    item.status = 'cancelled';
    item.cancelledAt = item.cancelledAt || now();
    item.updatedAt = now();
    item.cancelTaskId = task.id;
    cancelled.push(item.id);
  }
  return cancelled;
}

function activeTurnMetas(proc) {
  const ids = proc?.activeTurnIds instanceof Set
    ? [...proc.activeTurnIds]
    : (proc?.activeTurnId ? [proc.activeTurnId] : []);
  return ids.map((id) => proc.turnMeta?.get(id)).filter(Boolean);
}

function activeDeliveryMessagesOutsideTask(proc, task) {
  const outsideWorkItemIds = new Set();
  for (const meta of activeTurnMetas(proc)) {
    if (!turnMetaMatchesTask(meta, task)) continue;
    for (const id of normalizeIds(meta.workItemIds || [])) {
      const item = findWorkItem(id);
      if (item && !workItemMatchesTask(item, task) && item.status !== 'responded' && item.status !== 'cancelled') {
        outsideWorkItemIds.add(id);
      }
    }
  }
  if (!outsideWorkItemIds.size) return [];
  return (Array.isArray(proc?.inbox) ? proc.inbox : [])
    .filter((message) => message?.workItemId && outsideWorkItemIds.has(message.workItemId));
}

function uniqueDeliveryMessages(messages) {
  const seen = new Set();
  const result = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message) continue;
    const key = message.workItemId || message.id;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    result.push(message);
  }
  return result;
}

function processHasOnlyScopedActiveWork(proc, scope) {
  const metas = activeTurnMetas(proc);
  if (metas.length) {
    return metas.every((meta) => turnMetaMatchesScope(meta, scope) && !turnMetaHasWorkOutsideScope(meta, scope));
  }
  return spaceMatchesScope(proc, scope);
}

function processHasActiveTaskWork(proc, task) {
  return activeTurnMetas(proc).some((meta) => turnMetaMatchesTask(meta, task));
}

function stopAgentProcessForScope(agent, proc, scope, restartMessages = []) {
  clearAgentBusyDeliveryTimer(proc);
  proc.stopRequested = true;
  proc.suppressOutput = true;
  proc.stoppedAt = now();
  proc.stoppedScope = scope ? { spaceType: scope.spaceType, spaceId: scope.spaceId } : null;
  proc.restartMessagesAfterStop = restartMessages.filter(Boolean);
  proc.pendingDeliveryMessages = [];
  proc.pendingInitialMessages = [];
  proc.pendingInitialPrompt = null;
  setAgentStatus(agent, proc.restartMessagesAfterStop.length ? 'queued' : 'idle', 'agent_stop_scope');
  if (proc.child && !proc.child.killed) {
    proc.child.kill('SIGTERM');
    return true;
  }
  agentProcesses.delete(agent.id);
  if (proc.restartMessagesAfterStop.length) restartAgentWithQueuedMessages(agent, proc, proc.restartMessagesAfterStop);
  return false;
}

function stopAgentProcessForTask(agent, proc, task, restartMessages = []) {
  clearAgentBusyDeliveryTimer(proc);
  proc.stopRequested = true;
  proc.suppressOutput = true;
  proc.stoppedAt = now();
  proc.stoppedTaskId = task.id;
  proc.restartMessagesAfterStop = uniqueDeliveryMessages(restartMessages);
  proc.pendingDeliveryMessages = [];
  proc.pendingInitialMessages = [];
  proc.pendingInitialPrompt = null;
  setAgentStatus(agent, proc.restartMessagesAfterStop.length ? 'queued' : 'idle', 'agent_stop_task');
  if (proc.child && !proc.child.killed) {
    proc.child.kill('SIGTERM');
    return true;
  }
  agentProcesses.delete(agent.id);
  if (proc.restartMessagesAfterStop.length) restartAgentWithQueuedMessages(agent, proc, proc.restartMessagesAfterStop);
  return false;
}

function stopAgentProcesses(scope = null) {
  const stoppedAgents = [];
  const cancelledWorkItems = [];
  for (const [agentId, proc] of agentProcesses.entries()) {
    const agent = findAgent(agentId);
    if (!agent) continue;
    const cancelledForAgent = cancelWorkItemsForScope(scope, agentId);
    cancelledWorkItems.push(...cancelledForAgent);

    const inbox = partitionMessagesByScope(proc.inbox, scope);
    const pending = partitionMessagesByScope(proc.pendingDeliveryMessages, scope);
    const initial = partitionMessagesByScope(proc.pendingInitialMessages, scope);
    const activeMetas = activeTurnMetas(proc);
    const pendingActiveScoped = !activeMetas.length && deliveryMessageMatchesScope(proc.lastSourceMessage, scope);
    proc.inbox = inbox.other;
    proc.pendingDeliveryMessages = pending.other;
    proc.pendingInitialMessages = initial.other;

    const restartMessages = [...inbox.other, ...pending.other, ...initial.other];
    const removedMessages = inbox.scoped.length + pending.scoped.length + initial.scoped.length;
    const activeScopedOnly = processHasOnlyScopedActiveWork(proc, scope) || pendingActiveScoped;
    const shouldStop = !scope || activeScopedOnly || (removedMessages > 0 && !activeMetas.length && (spaceMatchesScope(proc, scope) || pendingActiveScoped));

    if (shouldStop) {
      stopAgentProcessForScope(agent, proc, scope, restartMessages);
      stoppedAgents.push(agentId);
    } else if (removedMessages > 0 || cancelledForAgent.length) {
      clearAgentBusyDeliveryTimer(proc);
      if (!restartMessages.length && !activeMetas.length) setAgentStatus(agent, 'idle', 'agent_stop_scope_pruned');
    }
  }
  return {
    stoppedAgents: normalizeIds(stoppedAgents),
    cancelledWorkItems: normalizeIds(cancelledWorkItems),
  };
}

function stopAgentProcessesForTask(task) {
  const stoppedAgents = [];
  const cancelledWorkItems = [];
  for (const [agentId, proc] of agentProcesses.entries()) {
    const agent = findAgent(agentId);
    if (!agent) continue;
    const activeTask = processHasActiveTaskWork(proc, task);
    const restartActiveMessages = activeTask ? activeDeliveryMessagesOutsideTask(proc, task) : [];
    const cancelledForAgent = cancelWorkItemsForTask(task, agentId);
    cancelledWorkItems.push(...cancelledForAgent);

    const inbox = partitionMessagesByTask(proc.inbox, task);
    const pending = partitionMessagesByTask(proc.pendingDeliveryMessages, task);
    const initial = partitionMessagesByTask(proc.pendingInitialMessages, task);
    proc.inbox = inbox.other;
    proc.pendingDeliveryMessages = pending.other;
    proc.pendingInitialMessages = initial.other;

    const restartMessages = uniqueDeliveryMessages([
      ...restartActiveMessages,
      ...inbox.other,
      ...pending.other,
      ...initial.other,
    ]);
    const removedMessages = inbox.scoped.length + pending.scoped.length + initial.scoped.length;
    const shouldStop = activeTask || (removedMessages > 0 && !activeTurnMetas(proc).length);

    if (shouldStop) {
      stopAgentProcessForTask(agent, proc, task, restartMessages);
      stoppedAgents.push(agentId);
    } else if (removedMessages > 0 || cancelledForAgent.length) {
      clearAgentBusyDeliveryTimer(proc);
      if (!restartMessages.length && !activeTurnMetas(proc).length) setAgentStatus(agent, 'idle', 'agent_stop_task_pruned');
    }
  }
  return {
    stoppedAgents: normalizeIds(stoppedAgents),
    cancelledWorkItems: normalizeIds(cancelledWorkItems),
  };
}

function steerAgentProcessesForTaskStop(task, actorId = 'hum_local', replyId = null) {
  const steeredAgents = [];
  const cancelledWorkItems = [];
  for (const [agentId, proc] of agentProcesses.entries()) {
    const agent = findAgent(agentId);
    if (!agent) continue;
    const activeTurnIds = proc.activeTurnIds instanceof Set
      ? [...proc.activeTurnIds]
      : (proc.activeTurnId ? [proc.activeTurnId] : []);
    const taskTurnIds = activeTurnIds.filter((turnId) => turnMetaMatchesTask(proc.turnMeta?.get(turnId), task));
    const inbox = partitionMessagesByTask(proc.inbox, task);
    const pending = partitionMessagesByTask(proc.pendingDeliveryMessages, task);
    const initial = partitionMessagesByTask(proc.pendingInitialMessages, task);
    proc.inbox = inbox.other;
    proc.pendingDeliveryMessages = pending.other;
    proc.pendingInitialMessages = initial.other;
    const removedMessages = inbox.scoped.length + pending.scoped.length + initial.scoped.length;
    const taskWorkIds = normalizeIds([
      ...taskTurnIds.flatMap((turnId) => proc.turnMeta?.get(turnId)?.workItemIds || []),
      ...inbox.scoped.map((message) => message?.workItemId),
      ...pending.scoped.map((message) => message?.workItemId),
      ...initial.scoped.map((message) => message?.workItemId),
    ]);
    cancelledWorkItems.push(...taskWorkIds);

    if (!taskTurnIds.length) {
      if (removedMessages > 0 || taskWorkIds.length) {
        clearAgentBusyDeliveryTimer(proc);
        if (!activeTurnMetas(proc).length && !proc.pendingDeliveryMessages?.length) setAgentStatus(agent, 'idle', 'task_stop_pruned');
      }
      continue;
    }

    if (!proc.threadId || !proc.child || proc.child.killed) continue;
    proc.pendingTurnRequests = proc.pendingTurnRequests || new Map();
    for (const turnId of taskTurnIds) {
      const meta = proc.turnMeta?.get(turnId);
      const workItemIds = normalizeIds(meta?.workItemIds || taskWorkIds);
      const requestId = sendCodexAppServerRequest(proc, 'turn/steer', {
        threadId: proc.threadId,
        expectedTurnId: turnId,
        input: [{
          type: 'text',
          text: `System: The user stopped ${taskLabel(task)} in this thread. Stop work for that task, do not send a final answer for it, keep this agent session alive, and wait for new messages.`,
        }],
      });
      if (!requestId) continue;
      proc.pendingTurnRequests.set(requestId, {
        parentMessageId: meta?.parentMessageId || null,
        sourceMessage: meta?.sourceMessage || null,
        spaceType: meta?.spaceType || task.spaceType,
        spaceId: meta?.spaceId || task.spaceId,
        workItemIds,
        targetKeys: meta?.targetKeys || [],
      });
    }
    if (taskTurnIds.length) {
      steeredAgents.push(agentId);
      addSystemEvent('agent_task_stop_steered', `${agent.name} was asked to stop ${taskLabel(task)} without closing its Codex session.`, {
        agentId,
        taskId: task.id,
        actorId,
        replyId,
      });
    }
  }
  return {
    steeredAgents: normalizeIds(steeredAgents),
    cancelledWorkItems: normalizeIds(cancelledWorkItems),
  };
}

function stopRunsForScope(scope = null) {
  const stoppedRuns = [];
  for (const [runId, child] of runningProcesses.entries()) {
    const run = findRun(runId);
    if (!run || (scope && !runMatchesScope(run, scope))) continue;
    run.cancelRequested = true;
    child.kill('SIGTERM');
    stoppedRuns.push(runId);
  }
  return normalizeIds(stoppedRuns);
}

function stopRunsForTask(task) {
  const stoppedRuns = [];
  for (const [runId, child] of runningProcesses.entries()) {
    const run = findRun(runId);
    if (!run || !runMatchesTask(run, task)) continue;
    run.cancelRequested = true;
    child.kill('SIGTERM');
    stoppedRuns.push(runId);
  }
  return normalizeIds(stoppedRuns);
}

function waitForAgentProcessExit(proc, timeoutMs = 5000) {
  if (!proc?.child) return Promise.resolve();
  if (proc.child.exitCode !== null || proc.child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        proc.child.kill('SIGKILL');
      } catch {
        // Process already ended.
      }
      resolve();
    }, timeoutMs);
    proc.child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stopAgentProcessForControl(agent) {
  const proc = agentProcesses.get(agent.id);
  if (!proc) return false;
  clearAgentBusyDeliveryTimer(proc);
  proc.stopRequested = true;
  proc.suppressOutput = true;
  proc.restartMessagesAfterStop = [];
  proc.pendingDeliveryMessages = [];
  proc.pendingInitialMessages = [];
  proc.pendingInitialPrompt = null;
  if (proc.child && !proc.child.killed) {
    proc.child.kill('SIGTERM');
    await waitForAgentProcessExit(proc);
  } else {
    agentProcesses.delete(agent.id);
  }
  return true;
}

async function resetAgentRuntimeSession(agent) {
  agent.runtimeSessionId = null;
  agent.runtimeLastTurnAt = null;
  await writeAgentSessionFile(agent).catch(() => {});
}

async function resetAgentWorkspaceFiles(agent) {
  await rm(agentDataDir(agent), { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
  agent.runtimeSessionId = null;
  agent.runtimeSessionHome = null;
  agent.runtimeConfigVersion = 0;
  agent.runtimeLastStartedAt = null;
  agent.runtimeLastTurnAt = null;
  agent.workspacePath = null;
  await ensureAgentWorkspace(agent);
}

async function startAgentFromControl(agent) {
  return startAgentProcess(agent, 'channel', 'chan_all', []);
}

async function restartAgentFromControl(agent, mode = 'restart') {
  const normalizedMode = ['restart', 'reset-session', 'full-reset'].includes(mode) ? mode : 'restart';
  const stopped = await stopAgentProcessForControl(agent);
  if (normalizedMode === 'full-reset') {
    await resetAgentWorkspaceFiles(agent);
  } else if (normalizedMode === 'reset-session') {
    await resetAgentRuntimeSession(agent);
  }
  addCollabEvent('agent_restart_requested', `${agent.name} restart requested (${normalizedMode}).`, {
    agentId: agent.id,
    mode: normalizedMode,
    stopped,
  });
  await persistState();
  broadcastState();
  await startAgentFromControl(agent);
  return { mode: normalizedMode, stopped };
}

async function relayAgentMentions(record, { parentMessageId = null } = {}) {
  if (record.authorType !== 'agent') return;
  if (!parentMessageId && !record.taskId) return;
  const relayDepth = Number(record.agentRelayDepth || 0);
  const mentions = extractMentions(record.body || '');
  const targetIds = mentions.agents.filter((id) => id !== record.authorId);
  if (!targetIds.length) return;
  if (relayDepth >= MAX_AGENT_RELAY_DEPTH) {
    addSystemEvent('agent_relay_capped', 'Agent mention relay depth reached.', {
      messageId: record.id,
      agentId: record.authorId,
      relayDepth,
      targetIds,
    });
    return;
  }

  const channel = record.spaceType === 'channel' ? findChannel(record.spaceId) : null;
  const allowedIds = new Set(channel ? channelAgentIds(channel) : targetIds);
  for (const targetId of targetIds) {
    if (!allowedIds.has(targetId)) continue;
    const targetAgent = findAgent(targetId);
    if (!targetAgent) continue;
    addSystemEvent('agent_message_relay', `${displayActor(record.authorId)} mentioned ${targetAgent.name}`, {
      fromAgentId: record.authorId,
      toAgentId: targetAgent.id,
      messageId: record.id,
      relayDepth,
      parentMessageId,
    });
    deliverMessageToAgent(targetAgent, record.spaceType, record.spaceId, record, { parentMessageId }).catch(err => {
      addSystemEvent('delivery_error', `Failed to relay message to ${targetAgent.name}: ${err.message}`, {
        agentId: targetAgent.id,
        messageId: record.id,
        parentMessageId,
      });
    });
  }
}

function inferTaskIdForDelivery(message, parentMessageId) {
  if (message?.taskId) return message.taskId;
  const parent = parentMessageId ? findMessage(parentMessageId) : null;
  const task = findTaskForThreadMessage(parent || message);
  return task?.id || null;
}

function createWorkItemForDelivery(agent, message, { spaceType, spaceId, parentMessageId = null } = {}) {
  state.workItems = Array.isArray(state.workItems) ? state.workItems : [];
  const target = targetForConversation(spaceType, spaceId, parentMessageId);
  const item = {
    id: makeId('wi'),
    agentId: agent.id,
    sourceMessageId: message.id,
    parentMessageId: parentMessageId || null,
    spaceType,
    spaceId,
    target,
    taskId: inferTaskIdForDelivery(message, parentMessageId),
    status: 'queued',
    createdAt: now(),
    updatedAt: now(),
    deliveredAt: null,
    respondedAt: null,
    sendCount: 0,
  };
  state.workItems.push(item);
  addSystemEvent('work_item_created', `${agent.name} received ${target}`, {
    agentId: agent.id,
    workItemId: item.id,
    messageId: message.id,
    target,
  });
  return item;
}

function markWorkItemsDelivered(messages, deliveryMode) {
  const ids = normalizeIds((Array.isArray(messages) ? messages : [messages])
    .map((message) => message?.workItemId));
  for (const id of ids) {
    const item = findWorkItem(id);
    if (!item) continue;
    if (item.status === 'cancelled') continue;
    item.status = item.status === 'responded' ? item.status : 'delivered';
    item.deliveryMode = deliveryMode;
    item.deliveredAt = item.deliveredAt || now();
    item.updatedAt = now();
  }
  return ids;
}

function turnMetaHasExplicitSend(turnMeta) {
  const ids = normalizeIds(turnMeta?.workItemIds || []);
  return ids.some((id) => {
    const item = findWorkItem(id);
    return item?.respondedAt || item?.status === 'responded' || item?.status === 'cancelled' || Number(item?.sendCount || 0) > 0;
  });
}

function workItemTargetMatches(item, resolvedTarget) {
  if (!item || !resolvedTarget) return false;
  return (
    item.spaceType === resolvedTarget.spaceType
    && item.spaceId === resolvedTarget.spaceId
    && String(item.parentMessageId || '') === String(resolvedTarget.parentMessageId || '')
  );
}

function markWorkItemResponded(item, target, record) {
  item.status = 'responded';
  item.respondedAt = item.respondedAt || now();
  item.updatedAt = now();
  item.sendCount = Number(item.sendCount || 0) + 1;
  item.lastSentTarget = target;
  item.lastResponseId = record?.id || null;
}

function markFallbackResponseWorkItem(sourceMessage, record) {
  return markFallbackResponseWorkItems(sourceMessage, record);
}

function markFallbackResponseWorkItems(sourceMessage, record, workItemIds = []) {
  const workItemId = sourceMessage?.workItemId;
  const ids = normalizeIds([...workItemIds, workItemId].filter(Boolean));
  let marked = false;
  for (const id of ids) {
    const item = findWorkItem(id);
    if (!item || item.status === 'responded' || item.status === 'cancelled') continue;
    markWorkItemResponded(item, sourceMessage?.target || item.target || null, record);
    marked = true;
  }
  return marked;
}

async function postAgentResponse(agent, spaceType, spaceId, body, parentMessageId = null, options = {}) {
  const responseBody = prepareAgentResponseBody(body);
  const sourceDepth = Number(options.sourceMessage?.agentRelayDepth || 0);
  const agentRelayDepth = sourceDepth + 1;
  if (parentMessageId && findMessage(parentMessageId)) {
    const parent = findMessage(parentMessageId);
    const reply = normalizeConversationRecord({
      id: makeId('rep'),
      parentMessageId,
      spaceType: parent.spaceType || spaceType,
      spaceId: parent.spaceId || spaceId,
      authorType: 'agent',
      authorId: agent.id,
      body: responseBody,
      attachmentIds: [],
      agentRelayDepth,
      createdAt: now(),
      updatedAt: now(),
    });
    state.replies.push(reply);
    parent.replyCount = state.replies.filter((item) => item.parentMessageId === parentMessageId).length;
    parent.updatedAt = now();
    addCollabEvent('agent_thread_response', `${agent.name} responded in thread`, { replyId: reply.id, messageId: parentMessageId, agentId: agent.id });
    await persistState();
    broadcastState();
    await relayAgentMentions(reply, { parentMessageId });
    return reply;
  }

  const message = normalizeConversationRecord({
    id: makeId('msg'),
    spaceType,
    spaceId,
    authorType: 'agent',
    authorId: agent.id,
    body: responseBody,
    attachmentIds: [],
    agentRelayDepth,
    replyCount: 0,
    savedBy: [],
    createdAt: now(),
    updatedAt: now(),
  });
  state.messages.push(message);
  addCollabEvent('agent_response', `${agent.name} responded`, { messageId: message.id, agentId: agent.id });
  await persistState();
  broadcastState();
  await relayAgentMentions(message);
  return message;
}

async function deliverMessageToAgent(agent, spaceType, spaceId, message, options = {}) {
  const parentMessageId = options.parentMessageId || message.parentMessageId || (shouldStartThreadForAgentDelivery(message) ? message.id : null);
  const workItem = createWorkItemForDelivery(agent, message, { spaceType, spaceId, parentMessageId });
  const routedMessage = {
    ...message,
    target: workItem.target,
    workItemId: workItem.id,
    taskId: message.taskId || workItem.taskId || null,
  };
  const contextPack = buildAgentContextPack({
    state,
    agentId: agent.id,
    spaceType,
    spaceId,
    currentMessage: routedMessage,
    parentMessageId,
    workItem,
    toolBaseUrl: `http://${HOST}:${PORT}`,
  });
  const deliveryMessage = {
    ...routedMessage,
    spaceType,
    spaceId,
    agentRelayDepth: Number(message.agentRelayDepth || 0),
    contextPack,
    ...(parentMessageId ? { parentMessageId } : {}),
  };
  // Check if agent has a running process
  const proc = agentProcesses.get(agent.id);

  if (proc && getAgentRuntime(agent) === 'codex') {
    const codexProcessAliveOrBooting = !proc.child || !proc.child.killed;
    if (codexProcessAliveOrBooting && (proc.status === 'running' || proc.status === 'starting')) {
      queueCodexBusyDelivery(agent, proc, deliveryMessage);
      await persistState();
      broadcastState();
      return;
    }
    if (proc.child && !proc.child.killed && proc.status === 'idle' && proc.threadId) {
      applyAgentProcessDeliveryScope(proc, spaceType, spaceId, parentMessageId);
      if (await sendCodexAppServerMessages(agent, proc, [deliveryMessage], { mode: 'turn' })) {
        await persistState();
        broadcastState();
        return;
      }
    }
  } else if (proc && (proc.status === 'running' || proc.status === 'starting')) {
    // Non-Codex runtimes still queue until their one-shot process exits.
    proc.inbox.push(deliveryMessage);
    if (!proc.parentMessageId && parentMessageId) proc.parentMessageId = parentMessageId;
    addSystemEvent('message_queued', `Message queued for busy agent ${agent.name}`, { agentId: agent.id, messageId: message.id, parentMessageId });
    await persistState();
    broadcastState();
    return;
  }

  // Start the agent process with this message
  await startAgentProcess(agent, spaceType, spaceId, deliveryMessage);
}

function createTaskFromMessage(message, title, options = {}) {
  if (message.taskId) {
    const existing = findTask(message.taskId);
    if (existing) return existing;
  }
  const assigneeIds = normalizeIds(options.assigneeIds?.length ? options.assigneeIds : (message.mentionedAgentIds || []));
  const createdBy = String(options.createdBy || message.authorId || 'hum_local');

  const task = {
    id: makeId('task'),
    number: nextTaskNumber(message.spaceType, message.spaceId),
    title: String(title || message.body || 'Untitled task').trim().slice(0, 180),
    body: String(options.body ?? message.body ?? '').trim(),
    status: String(options.status || 'todo'),
    spaceType: message.spaceType,
    spaceId: message.spaceId,
    messageId: message.id,
    threadMessageId: message.id,
    sourceMessageId: options.sourceMessageId ? String(options.sourceMessageId) : message.id,
    sourceReplyId: options.sourceReplyId ? String(options.sourceReplyId) : null,
    assigneeId: assigneeIds[0] || null,
    assigneeIds,
    claimedBy: null,
    claimedAt: null,
    reviewRequestedAt: null,
    completedAt: null,
    endIntentAt: null,
    runIds: [],
    attachmentIds: Array.isArray(message.attachmentIds) ? message.attachmentIds : [],
    localReferences: Array.isArray(options.localReferences) ? options.localReferences : (Array.isArray(message.localReferences) ? message.localReferences : []),
    createdBy,
    createdAt: now(),
    updatedAt: now(),
    history: [],
  };
  addTaskHistory(task, 'created', `Task ${taskLabel(task)} created from message.`);
  state.tasks.unshift(task);
  message.taskId = task.id;
  addTaskTimelineMessage(task, `📋 1 new task created: ${taskLabel(task)} ${task.title}`, 'task_created');
  addCollabEvent('task_created', `Task created: ${task.title}`, { taskId: task.id, messageId: message.id, number: task.number });
  return task;
}

function createTaskMessage({ title, body = '', spaceType, spaceId, authorType = 'human', authorId = 'hum_local', assigneeIds = [], attachmentIds = [], sourceMessageId = null, sourceReplyId = null, status = 'todo' }) {
  const taskTitle = String(title || '').trim().slice(0, 180);
  if (!taskTitle) throw httpError(400, 'Task title is required.');
  const message = normalizeConversationRecord({
    id: makeId('msg'),
    spaceType,
    spaceId,
    authorType,
    authorId,
    body: taskTitle,
    attachmentIds: normalizeIds(attachmentIds),
    mentionedAgentIds: normalizeIds(assigneeIds),
    mentionedHumanIds: [],
    readBy: authorType === 'human' ? ['hum_local'] : [],
    replyCount: 0,
    savedBy: [],
    createdAt: now(),
    updatedAt: now(),
  });
  state.messages.push(message);
  const task = createTaskFromMessage(message, taskTitle, {
    body,
    status,
    assigneeIds,
    sourceMessageId: sourceMessageId || message.id,
    sourceReplyId,
    createdBy: authorId,
    localReferences: extractLocalReferences(body || taskTitle),
  });
  message.taskId = task.id;
  return { message, task };
}

function claimTask(task, actorId, options = {}) {
  if (!task) throw httpError(404, 'Task not found.');
  if (taskIsClosed(task)) throw httpError(409, 'Closed task cannot be claimed.');
  const claimant = String(actorId || 'agt_codex');
  if (task.claimedBy && task.claimedBy !== claimant && !options.force) {
    throw httpError(409, `Task is already claimed by ${task.claimedBy}.`);
  }
  if (task.claimedBy === claimant && task.status === 'in_progress') {
    return task;
  }
  task.claimedBy = claimant;
  task.assigneeId = claimant;
  task.assigneeIds = normalizeIds([...(task.assigneeIds || []), claimant]);
  task.claimedAt = task.claimedAt || now();
  task.status = 'in_progress';
  task.updatedAt = now();
  addTaskHistory(task, 'claimed', `Claimed by ${displayActor(claimant)}.`, claimant);
  const thread = ensureTaskThread(task);
  addSystemReply(thread.id, `Task claimed by ${displayActor(claimant)}.`);
  addTaskTimelineMessage(task, `📌 ${displayActor(claimant)} claimed ${taskLabel(task)}`, 'task_claimed');
  addCollabEvent('task_claimed', `Task claimed: ${task.title}`, { taskId: task.id, actorId: claimant, number: task.number });
  const claimantAgent = findAgent(claimant);
  if (claimantAgent) scheduleAgentMemoryWriteback(claimantAgent, 'task_claimed', { task });
  return task;
}

function findTaskForAgentTool(body, space = null) {
  const taskId = String(body.taskId || body.task_id || '').trim();
  if (taskId) {
    const exact = findTask(taskId) || state.tasks.find((task) => task.id.startsWith(taskId));
    if (exact) return exact;
    throw httpError(404, `Task not found: ${taskId}`);
  }
  const taskNumber = body.taskNumber ?? body.task_number ?? body.number;
  if (taskNumber !== undefined && taskNumber !== null && taskNumber !== '') {
    const scoped = space || resolveConversationSpace(body);
    const task = state.tasks.find((item) => (
      item.spaceType === scoped.spaceType
      && item.spaceId === scoped.spaceId
      && Number(item.number) === Number(taskNumber)
    ));
    if (task) return task;
    throw httpError(404, `Task not found: #${taskNumber}`);
  }
  const messageId = String(body.messageId || body.message_id || '').trim();
  if (messageId) {
    const message = findMessage(messageId) || state.messages.find((item) => item.id.startsWith(messageId));
    const task = findTaskForThreadMessage(message);
    if (task) return task;
    throw httpError(404, `Task not found for message: ${messageId}`);
  }
  throw httpError(400, 'taskId, taskNumber, or messageId is required.');
}

function updateTaskForAgent(task, agent, nextStatus, options = {}) {
  const status = String(nextStatus || '').trim();
  if (!['todo', 'in_progress', 'in_review', 'done'].includes(status)) {
    throw httpError(400, 'Unsupported task status.');
  }
  if (task.claimedBy && task.claimedBy !== agent.id && !options.force) {
    throw httpError(409, `Task is already claimed by ${task.claimedBy}.`);
  }
  if (!task.claimedBy && !options.force) {
    throw httpError(409, 'Task must be claimed before agent status updates.');
  }
  if (!task.claimedBy) {
    task.claimedBy = agent.id;
    task.claimedAt = now();
    task.assigneeId = agent.id;
    task.assigneeIds = normalizeIds([...(task.assigneeIds || []), agent.id]);
  }
  const previousStatus = task.status;
  task.status = status;
  task.updatedAt = now();
  if (status === 'in_progress') {
    task.reviewRequestedAt = null;
    task.completedAt = null;
    addTaskHistory(task, 'agent_in_progress', 'Agent moved task to In Progress.', agent.id);
    addSystemReply(ensureTaskThread(task).id, `${agent.name} moved this task to In Progress.`);
    addTaskTimelineMessage(task, `📌 ${displayActor(agent.id)} moved ${taskLabel(task)} to In Progress`, 'task_claimed');
  } else if (status === 'in_review') {
    task.reviewRequestedAt = task.reviewRequestedAt || now();
    task.completedAt = null;
    addTaskHistory(task, 'agent_review_requested', 'Agent requested review.', agent.id);
    addSystemReply(ensureTaskThread(task).id, `${agent.name} requested review.`);
    addTaskTimelineMessage(task, `👀 ${displayActor(agent.id)} moved ${taskLabel(task)} to In Review`, 'task_review');
    scheduleAgentMemoryWriteback(agent, 'task_in_review', { task });
  } else if (status === 'done') {
    task.completedAt = task.completedAt || now();
    addTaskHistory(task, 'agent_done', 'Agent marked task done.', agent.id);
    addSystemReply(ensureTaskThread(task).id, `${agent.name} marked this task done.`);
    addTaskTimelineMessage(task, `✅ ${displayActor(agent.id)} moved ${taskLabel(task)} to Done`, 'task_done');
    scheduleAgentMemoryWriteback(agent, 'task_done', { task });
  } else if (status === 'todo') {
    task.reviewRequestedAt = null;
    task.completedAt = null;
    addTaskHistory(task, 'agent_todo', 'Agent moved task back to Todo.', agent.id);
    addSystemReply(ensureTaskThread(task).id, `${agent.name} moved this task back to Todo.`);
  }
  addCollabEvent('agent_task_updated', `${agent.name} moved ${taskLabel(task)} from ${previousStatus || 'unknown'} to ${status}`, {
    agentId: agent.id,
    taskId: task.id,
    previousStatus,
    status,
  });
  return task;
}

async function handleApi(req, res, url) {
  if (!requireCloudDeploymentApi(req, res, url)) return true;

  if (req.method === 'GET' && url.pathname === '/api/state') {
    sendJson(res, 200, publicState());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/agent-tools/history') {
    const agentId = url.searchParams.get('agentId') || '';
    const history = readAgentHistory(state, {
      target: url.searchParams.get('target') || url.searchParams.get('channel') || '#all',
      limit: url.searchParams.get('limit') || undefined,
      around: url.searchParams.get('around') || undefined,
      before: url.searchParams.get('before') || undefined,
      after: url.searchParams.get('after') || undefined,
    });
    addSystemEvent('agent_history_read', `${displayActor(agentId) || 'Agent'} read ${history.target || 'history'}.`, {
      agentId,
      target: history.target || url.searchParams.get('target') || '#all',
      ok: Boolean(history.ok),
    });
    sendJson(res, history.ok ? 200 : 404, {
      ...history,
      text: formatAgentHistory(history, { state, targetAgentId: agentId }),
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/agent-tools/search') {
    const agentId = url.searchParams.get('agentId') || '';
    const search = searchAgentMessageHistory(state, {
      query: url.searchParams.get('q') || url.searchParams.get('query') || '',
      target: url.searchParams.get('target') || url.searchParams.get('channel') || '#all',
      limit: url.searchParams.get('limit') || undefined,
    });
    addSystemEvent('agent_history_search', `${displayActor(agentId) || 'Agent'} searched message history.`, {
      agentId,
      query: url.searchParams.get('q') || url.searchParams.get('query') || '',
      target: url.searchParams.get('target') || '#all',
      ok: Boolean(search.ok),
    });
    sendJson(res, search.ok ? 200 : 400, {
      ...search,
      text: formatAgentSearchResults(search, { state, targetAgentId: agentId }),
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent-tools/messages/send') {
    const body = await readJson(req);
    const agent = findAgent(String(body.agentId || ''));
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    const workItem = findWorkItem(String(body.workItemId || body.work_item_id || ''));
    if (!workItem) {
      sendError(res, 404, 'Work item not found.');
      return true;
    }
    if (workItem.agentId !== agent.id) {
      sendError(res, 403, 'Work item belongs to a different agent.');
      return true;
    }
    if (workItem.status === 'cancelled') {
      sendError(res, 409, 'Work item was stopped by the user.');
      return true;
    }
    const content = String(body.content || '').trim();
    if (!content) {
      sendError(res, 400, 'Message content is required.');
      return true;
    }
    let target;
    try {
      target = resolveMessageTarget(body.target || workItem.target);
      if (!workItemTargetMatches(workItem, target)) {
        throw httpError(409, 'Target does not match the work item conversation.');
      }
    } catch (error) {
      sendError(res, error.status || 400, error.message);
      return true;
    }
    const sourceMessage = findConversationRecord(workItem.sourceMessageId);
    const posted = await postAgentResponse(agent, target.spaceType, target.spaceId, content, target.parentMessageId || null, {
      sourceMessage,
    });
    markWorkItemResponded(workItem, target.label, posted);
    addSystemEvent('agent_tool_send_message', `${agent.name} sent a routed message to ${target.label}.`, {
      agentId: agent.id,
      workItemId: workItem.id,
      target: target.label,
      responseId: posted?.id || null,
    });
    await persistState();
    broadcastState();
    sendJson(res, 200, {
      ok: true,
      target: target.label,
      workItemId: workItem.id,
      workItem,
      message: posted,
      text: `Message sent to ${target.label}.`,
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent-tools/tasks/update') {
    const body = await readJson(req);
    const agent = findAgent(String(body.agentId || ''));
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    let task;
    try {
      task = findTaskForAgentTool(body);
      updateTaskForAgent(task, agent, body.status || body.nextStatus, { force: body.force === true || body.allowUnclaimed === true });
    } catch (error) {
      sendError(res, error.status || 400, error.message);
      return true;
    }
    await persistState();
    broadcastState();
    sendJson(res, 200, {
      ok: true,
      task,
      text: `${taskLabel(task)} is now ${task.status}.`,
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent-tools/tasks') {
    const body = await readJson(req);
    const agent = findAgent(String(body.agentId || ''));
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    let space;
    try {
      space = resolveConversationSpace(body);
    } catch (error) {
      sendError(res, error.status || 400, error.message);
      return true;
    }
    const taskInputs = Array.isArray(body.tasks) && body.tasks.length
      ? body.tasks
      : [{ title: body.title, body: body.body }];
    const created = [];
    try {
      for (const input of taskInputs) {
        const assigneeIds = normalizeIds([
          ...(Array.isArray(input.assigneeIds) ? input.assigneeIds : []),
          ...(input.assigneeId ? [input.assigneeId] : []),
          ...(Array.isArray(body.assigneeIds) ? body.assigneeIds : []),
          ...(body.assigneeId ? [body.assigneeId] : []),
          ...(body.claim ? [agent.id] : []),
        ]);
        const { message, task } = createTaskMessage({
          title: input.title,
          body: String(input.body ?? body.body ?? '').trim(),
          ...space,
          authorType: 'agent',
          authorId: agent.id,
          assigneeIds,
          attachmentIds: Array.isArray(input.attachmentIds) ? input.attachmentIds : (Array.isArray(body.attachmentIds) ? body.attachmentIds : []),
          sourceMessageId: input.sourceMessageId || body.sourceMessageId || null,
          sourceReplyId: input.sourceReplyId || body.sourceReplyId || null,
        });
        if (body.claim) claimTask(task, agent.id, { force: body.force });
        created.push({
          task,
          message,
          taskNumber: task.number,
          messageId: message.id,
          title: task.title,
          threadTarget: `${space.label}:${message.id}`,
        });
      }
    } catch (error) {
      sendError(res, error.status || 400, error.message);
      return true;
    }
    addSystemEvent('agent_tool_create_tasks', `${agent.name} created ${created.length} task(s).`, {
      agentId: agent.id,
      taskIds: created.map((item) => item.task.id),
      spaceType: space.spaceType,
      spaceId: space.spaceId,
    });
    await persistState();
    broadcastState();
    sendJson(res, 201, {
      ok: true,
      tasks: created,
      text: [
        `Created ${created.length} task(s) in ${space.label}:`,
        ...created.map((item) => `${taskLabel(item.task)} msg=${item.messageId} "${item.title}"`),
        '',
        'To follow up, reply in:',
        ...created.map((item) => `${taskLabel(item.task)} -> ${item.threadTarget}`),
      ].join('\n'),
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent-tools/tasks/claim') {
    const body = await readJson(req);
    const agent = findAgent(String(body.agentId || ''));
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    let space;
    try {
      space = resolveConversationSpace(body);
    } catch (error) {
      sendError(res, error.status || 400, error.message);
      return true;
    }
    const claimed = [];
    const numbers = Array.isArray(body.taskNumbers) ? body.taskNumbers : (Array.isArray(body.task_numbers) ? body.task_numbers : []);
    const messageIds = Array.isArray(body.messageIds) ? body.messageIds : (Array.isArray(body.message_ids) ? body.message_ids : []);
    try {
      for (const number of numbers) {
        const task = state.tasks.find((item) => (
          item.spaceType === space.spaceType
          && item.spaceId === space.spaceId
          && Number(item.number) === Number(number)
        ));
        if (!task) throw httpError(404, `Task not found: #${number}`);
        claimed.push(claimTask(task, agent.id, { force: body.force }));
      }
      for (const messageId of messageIds) {
        const message = findMessage(String(messageId)) || state.messages.find((item) => item.id.startsWith(String(messageId)));
        if (!message || message.authorType === 'system' || message.parentMessageId) {
          throw httpError(400, 'Only regular top-level messages can be claimed as tasks.');
        }
        const task = createTaskFromMessage(message, body.title || message.body, { createdBy: message.authorId });
        claimed.push(claimTask(task, agent.id, { force: body.force }));
      }
    } catch (error) {
      sendError(res, error.status || 400, error.message);
      return true;
    }
    await persistState();
    broadcastState();
    sendJson(res, 200, {
      ok: true,
      tasks: claimed,
      text: claimed.map((task) => `Claimed ${taskLabel(task)} "${task.title}"`).join('\n'),
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/cloud/health') {
    if (!requireCloudAccess(req, res)) return true;
    sendJson(res, 200, {
      ok: true,
      name: 'Magclaw Control Plane',
      deployment: state.connection?.deployment || 'local',
      protocolVersion: CLOUD_PROTOCOL_VERSION,
      workspaceId: url.searchParams.get('workspaceId') || state.connection?.workspaceId || 'local',
      time: now(),
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/cloud/status') {
    sendJson(res, 200, {
      connection: publicConnection(),
      health: {
        localUrl: `http://${HOST}:${PORT}`,
        dataDir: DATA_DIR,
        protocolVersion: CLOUD_PROTOCOL_VERSION,
      },
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/config') {
    const body = await readJson(req);
    const previousMode = state.connection.mode;
    state.connection = {
      ...state.connection,
      mode: body.mode === 'cloud' ? 'cloud' : 'local',
      deployment: body.deployment ? String(body.deployment) : state.connection.deployment,
      controlPlaneUrl: normalizeCloudUrl(body.controlPlaneUrl ?? state.connection.controlPlaneUrl),
      relayUrl: normalizeCloudUrl(body.relayUrl ?? state.connection.relayUrl),
      cloudToken: body.cloudToken !== undefined ? String(body.cloudToken || '').trim() : state.connection.cloudToken,
      workspaceId: String(body.workspaceId || state.connection.workspaceId || 'local'),
      deviceName: String(body.deviceName || state.connection.deviceName || os.hostname()),
      autoSync: Boolean(body.autoSync),
      protocolVersion: CLOUD_PROTOCOL_VERSION,
    };
    if (state.connection.mode === 'local') {
      state.connection.pairingStatus = 'local';
    } else if (previousMode !== 'cloud' && state.connection.pairingStatus === 'local') {
      state.connection.pairingStatus = 'configured';
    }
    addSystemEvent('cloud_configured', `Connection mode set to ${state.connection.mode}.`);
    await persistState();
    broadcastState();
    sendJson(res, 200, { connection: publicConnection() });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/pair') {
    const body = await readJson(req);
    if (body.controlPlaneUrl !== undefined) state.connection.controlPlaneUrl = normalizeCloudUrl(body.controlPlaneUrl);
    if (body.relayUrl !== undefined) state.connection.relayUrl = normalizeCloudUrl(body.relayUrl);
    if (body.cloudToken !== undefined) state.connection.cloudToken = String(body.cloudToken || '').trim();
    if (body.workspaceId !== undefined) state.connection.workspaceId = String(body.workspaceId || 'local');
    if (body.deviceName !== undefined) state.connection.deviceName = String(body.deviceName || os.hostname());
    state.connection.mode = 'cloud';
    state.connection.pairingStatus = 'pairing';
    await persistState();

    try {
      const health = await cloudFetch(`/api/cloud/health?workspaceId=${encodeURIComponent(state.connection.workspaceId || 'local')}`);
      state.connection.pairingStatus = 'paired';
      state.connection.pairedAt = now();
      state.connection.lastError = '';
      addSystemEvent('cloud_paired', `Paired with ${state.connection.controlPlaneUrl}.`, { health });
      await persistState();
      broadcastState();
      sendJson(res, 200, { connection: publicConnection(), health });
    } catch (error) {
      state.connection.pairingStatus = 'configured';
      state.connection.lastError = error.message;
      await persistState();
      broadcastState();
      sendError(res, 502, error.message);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/disconnect') {
    state.connection.mode = 'local';
    state.connection.pairingStatus = 'local';
    state.connection.pairedAt = null;
    state.connection.lastSyncAt = null;
    state.connection.lastSyncDirection = null;
    state.connection.lastError = '';
    state.connection.autoSync = false;
    addSystemEvent('cloud_disconnected', 'Switched back to local-only mode.');
    await persistState();
    broadcastState();
    sendJson(res, 200, { connection: publicConnection() });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/cloud/export-state') {
    if (!requireCloudAccess(req, res)) return true;
    sendJson(res, 200, { snapshot: cloudSnapshot() });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/import-state') {
    if (!requireCloudAccess(req, res)) return true;
    const body = await readJson(req);
    const snapshot = body.snapshot || body;
    applyCloudSnapshot(snapshot);
    state.connection.lastSyncAt = now();
    state.connection.lastSyncDirection = 'import';
    state.connection.lastError = '';
    addSystemEvent('cloud_imported', `Cloud snapshot imported${body.reason ? ` (${body.reason})` : ''}.`);
    await persistState();
    broadcastState();
    sendJson(res, 200, { ok: true, importedAt: state.connection.lastSyncAt });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/sync/push') {
    const result = await pushStateToCloud('manual_push');
    broadcastState();
    sendJson(res, 200, { ok: true, result, connection: publicConnection() });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/sync/pull') {
    const result = await pullStateFromCloud();
    broadcastState();
    sendJson(res, 200, { ok: true, result, connection: publicConnection() });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/runtime') {
    sendJson(res, 200, await getRuntimeInfo());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/runtimes') {
    sendJson(res, 200, { runtimes: await detectInstalledRuntimes() });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
    res.write(`event: heartbeat\ndata: ${JSON.stringify(presenceHeartbeat())}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/settings') {
    const body = await readJson(req);
    state.settings = {
      ...state.settings,
      codexPath: String(body.codexPath || state.settings.codexPath || 'codex'),
      defaultWorkspace: path.resolve(String(body.defaultWorkspace || state.settings.defaultWorkspace || ROOT)),
      model: String(body.model || ''),
      sandbox: ['read-only', 'workspace-write', 'danger-full-access'].includes(body.sandbox)
        ? body.sandbox
        : state.settings.sandbox,
    };
    addSystemEvent('settings_updated', 'Runtime settings updated.');
    await persistState();
    broadcastState();
    sendJson(res, 200, publicState());
    return true;
  }

  if (['POST', 'PATCH'].includes(req.method) && url.pathname === '/api/settings/fanout') {
    const body = await readJson(req);
    updateFanoutApiConfig(body);
    addSystemEvent('fanout_api_settings_updated', 'Fan-out API settings updated.', {
      configured: fanoutApiConfigured(),
      baseUrl: state.settings.fanoutApi.baseUrl,
      model: state.settings.fanoutApi.model,
      hasApiKey: Boolean(state.settings.fanoutApi.apiKey),
    });
    await persistState();
    broadcastState();
    sendJson(res, 200, publicState());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/projects') {
    const body = await readJson(req);
    try {
      const result = await addProjectFolder({
        rawPath: body.path,
        name: body.name,
        spaceType: body.spaceType,
        spaceId: body.spaceId,
      });
      sendJson(res, result.created ? 201 : 200, result);
    } catch (error) {
      sendError(res, error.status || 500, error.message);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/projects/pick-folder') {
    const body = await readJson(req);
    try {
      const pickedPath = await pickFolderPath(body.defaultPath || state.settings?.defaultWorkspace || ROOT);
      if (!pickedPath) {
        sendJson(res, 200, { canceled: true });
        return true;
      }
      const result = await addProjectFolder({
        rawPath: pickedPath,
        name: body.name,
        spaceType: body.spaceType,
        spaceId: body.spaceId,
      });
      sendJson(res, result.created ? 201 : 200, { canceled: false, ...result });
    } catch (error) {
      addSystemEvent('project_picker_failed', `Project folder picker failed: ${error.message}`);
      sendError(res, error.status || 500, error.message);
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/projects/search') {
    const spaceType = url.searchParams.get('spaceType') === 'dm' ? 'dm' : 'channel';
    const spaceId = url.searchParams.get('spaceId') || selectedDefaultSpaceId(spaceType);
    const query = url.searchParams.get('q') || '';
    const items = await searchProjectItems(spaceType, spaceId, query);
    sendJson(res, 200, { items });
    return true;
  }

  const projectTreeMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/tree$/);
  if (req.method === 'GET' && projectTreeMatch) {
    const project = findProject(decodePathSegment(projectTreeMatch[1]));
    if (!project) {
      sendError(res, 404, 'Project not found.');
      return true;
    }
    try {
      sendJson(res, 200, await listProjectTree(project, url.searchParams.get('path') || ''));
    } catch (error) {
      addSystemEvent('project_tree_failed', `Project tree failed: ${error.message}`, {
        projectId: project.id,
        path: url.searchParams.get('path') || '',
      });
      sendError(res, error.status || 500, error.message);
    }
    return true;
  }

  const projectFileMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/file$/);
  if (req.method === 'GET' && projectFileMatch) {
    const project = findProject(decodePathSegment(projectFileMatch[1]));
    if (!project) {
      sendError(res, 404, 'Project not found.');
      return true;
    }
    try {
      sendJson(res, 200, await readProjectFilePreview(project, url.searchParams.get('path') || ''));
    } catch (error) {
      addSystemEvent('project_file_preview_failed', `Project file preview failed: ${error.message}`, {
        projectId: project.id,
        path: url.searchParams.get('path') || '',
      });
      sendError(res, error.status || 500, error.message);
    }
    return true;
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/projects/')) {
    const [, , , id] = url.pathname.split('/');
    const project = findProject(id);
    if (!project) {
      sendError(res, 404, 'Project not found.');
      return true;
    }
    state.projects = state.projects.filter((item) => item.id !== id);
    addSystemEvent('project_removed', `Project folder removed: ${project.name}`, { projectId: project.id });
    await persistState();
    broadcastState();
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/attachments') {
    const body = await readJson(req);
    const files = Array.isArray(body.files) ? body.files : [];
    if (files.length > MAX_ATTACHMENT_UPLOADS) {
      sendError(res, 400, `A single upload can include at most ${MAX_ATTACHMENT_UPLOADS} files.`);
      return true;
    }
    const created = [];

    for (const file of files) {
      const match = String(file.dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
      if (!match) continue;
      const type = match[1];
      const buffer = Buffer.from(match[2], 'base64');
      const attachment = await saveAttachmentBuffer({
        name: file.name,
        type,
        buffer,
        source: file.source === 'clipboard' ? 'clipboard' : 'upload',
      });
      state.attachments.push(attachment);
      created.push(attachment);
    }

    addSystemEvent('attachments_added', `${created.length} attachment(s) added.`);
    await persistState();
    broadcastState();
    sendJson(res, 201, { attachments: created });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/attachments/reference') {
    addSystemEvent('attachment_reference_rejected', 'Project file references stay local and are not copied into attachments.');
    sendError(res, 410, 'Project file references stay local. Use @ file/folder tokens instead of creating attachment copies.');
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/channels') {
    const body = await readJson(req);
    const name = normalizeName(body.name, 'new-channel');
    if (!name) {
      sendError(res, 400, 'Channel name is required.');
      return true;
    }
    if (state.channels.some((channel) => channel.name === name && !channel.archived)) {
      sendError(res, 409, 'Channel already exists.');
      return true;
    }
    const humanIds = Array.isArray(body.humanIds) && body.humanIds.length ? body.humanIds.map(String) : ['hum_local'];
    const agentIds = Array.isArray(body.agentIds)
      ? body.agentIds.map(String).filter((id) => agentParticipatesInChannels(findAgent(id)))
      : [];
    const memberIds = [...new Set([...humanIds, ...agentIds])];
    const channel = {
      id: makeId('chan'),
      name,
      description: String(body.description || '').trim(),
      ownerId: String(body.ownerId || 'hum_local'),
      humanIds,
      agentIds,
      memberIds,
      archived: false,
      createdAt: now(),
      updatedAt: now(),
    };
    state.channels.push(channel);
    state.messages.push(normalizeConversationRecord({
      id: makeId('msg'),
      spaceType: 'channel',
      spaceId: channel.id,
      authorType: 'system',
      authorId: 'system',
      body: `Channel #${channel.name} created.`,
      attachmentIds: [],
      replyCount: 0,
      savedBy: [],
      createdAt: now(),
      updatedAt: now(),
    }));
    addCollabEvent('channel_created', `Channel #${channel.name} created.`, { channelId: channel.id });
    for (const agentId of agentIds) {
      const agent = findAgent(agentId);
      if (agent) scheduleAgentMemoryWriteback(agent, 'channel_membership_changed', { channel });
    }
    await persistState();
    broadcastState();
    sendJson(res, 201, { channel });
    return true;
  }

  const channelMatch = url.pathname.match(/^\/api\/channels\/([^/]+)$/);
  if (['PATCH', 'POST'].includes(req.method) && channelMatch) {
    const channel = findChannel(channelMatch[1]);
    if (!channel) {
      sendError(res, 404, 'Channel not found.');
      return true;
    }
    const body = await readJson(req);
    if (body.name !== undefined) channel.name = normalizeName(body.name, channel.name);
    if (body.description !== undefined) channel.description = String(body.description || '').trim();
    if (body.ownerId !== undefined) channel.ownerId = String(body.ownerId || channel.ownerId || 'hum_local');
    const previousAgentIds = normalizeIds(channel.agentIds);
    if (Array.isArray(body.agentIds)) {
      channel.agentIds = body.agentIds.map(String).filter((id) => agentParticipatesInChannels(findAgent(id)));
    }
    if (Array.isArray(body.humanIds)) channel.humanIds = body.humanIds.map(String);
    if (Array.isArray(body.memberIds)) {
      channel.memberIds = body.memberIds.map(String).filter((id) => !id.startsWith('agt_') || agentParticipatesInChannels(findAgent(id)));
    }
    const changedAgentIds = normalizeIds([...previousAgentIds, ...(channel.agentIds || [])]);
    if (body.archived !== undefined) channel.archived = Boolean(body.archived);
    channel.updatedAt = now();
    addCollabEvent('channel_updated', `Channel #${channel.name} updated.`, { channelId: channel.id });
    for (const agentId of changedAgentIds) {
      const agent = findAgent(agentId);
      if (agent) scheduleAgentMemoryWriteback(agent, 'channel_membership_changed', { channel });
    }
    await persistState();
    broadcastState();
    sendJson(res, 200, { channel });
    return true;
  }

  // Channel members management
  const channelMembersMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/members$/);
  if (req.method === 'POST' && channelMembersMatch) {
    const channel = findChannel(channelMembersMatch[1]);
    if (!channel) {
      sendError(res, 404, 'Channel not found.');
      return true;
    }
    const body = await readJson(req);
    const memberId = String(body.memberId || '').trim();
    if (!memberId) {
      sendError(res, 400, 'Member ID is required.');
      return true;
    }
    if (memberId.startsWith('agt_') && !agentParticipatesInChannels(findAgent(memberId))) {
      sendError(res, 400, 'Brain/router agents cannot be added as channel members.');
      return true;
    }
    channel.memberIds = Array.isArray(channel.memberIds) ? channel.memberIds : [];
    if (!channel.memberIds.includes(memberId)) {
      channel.memberIds.push(memberId);
      // Also update legacy fields
      if (memberId.startsWith('agt_')) {
        channel.agentIds = Array.isArray(channel.agentIds) ? channel.agentIds : [];
        if (!channel.agentIds.includes(memberId)) channel.agentIds.push(memberId);
      } else if (memberId.startsWith('hum_')) {
        channel.humanIds = Array.isArray(channel.humanIds) ? channel.humanIds : [];
        if (!channel.humanIds.includes(memberId)) channel.humanIds.push(memberId);
      }
      channel.updatedAt = now();
      addCollabEvent('channel_member_added', `Member added to #${channel.name}`, { channelId: channel.id, memberId });
      const agent = memberId.startsWith('agt_') ? findAgent(memberId) : null;
      if (agent) scheduleAgentMemoryWriteback(agent, 'channel_membership_changed', { channel });
      await persistState();
      broadcastState();
    }
    sendJson(res, 200, { channel });
    return true;
  }

  const channelMemberRemoveMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/members\/([^/]+)$/);
  if (req.method === 'DELETE' && channelMemberRemoveMatch) {
    const channel = findChannel(channelMemberRemoveMatch[1]);
    if (!channel) {
      sendError(res, 404, 'Channel not found.');
      return true;
    }
    const memberId = channelMemberRemoveMatch[2];
    channel.memberIds = Array.isArray(channel.memberIds) ? channel.memberIds.filter(id => id !== memberId) : [];
    channel.agentIds = Array.isArray(channel.agentIds) ? channel.agentIds.filter(id => id !== memberId) : [];
    channel.humanIds = Array.isArray(channel.humanIds) ? channel.humanIds.filter(id => id !== memberId) : [];
    channel.updatedAt = now();
    addCollabEvent('channel_member_removed', `Member removed from #${channel.name}`, { channelId: channel.id, memberId });
    const agent = memberId.startsWith('agt_') ? findAgent(memberId) : null;
    if (agent) scheduleAgentMemoryWriteback(agent, 'channel_membership_changed', { channel });
    await persistState();
    broadcastState();
    sendJson(res, 200, { channel });
    return true;
  }

  // Leave channel
  const channelLeaveMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/leave$/);
  if (req.method === 'POST' && channelLeaveMatch) {
    const channel = findChannel(channelLeaveMatch[1]);
    if (!channel) {
      sendError(res, 404, 'Channel not found.');
      return true;
    }
    if (channel.id === 'chan_all') {
      sendError(res, 400, 'Cannot leave the #all channel.');
      return true;
    }
    const memberId = 'hum_local';
    channel.memberIds = Array.isArray(channel.memberIds) ? channel.memberIds.filter(id => id !== memberId) : [];
    channel.humanIds = Array.isArray(channel.humanIds) ? channel.humanIds.filter(id => id !== memberId) : [];
    channel.updatedAt = now();
    addCollabEvent('channel_left', `Left #${channel.name}`, { channelId: channel.id, memberId });
    await persistState();
    broadcastState();
    sendJson(res, 200, { channel });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/dms') {
    const body = await readJson(req);
    const participantId = String(body.participantId || '').trim();
    if (!participantId) {
      sendError(res, 400, 'Participant is required.');
      return true;
    }
    let dm = state.dms.find((item) => item.participantIds.includes(participantId));
    if (!dm) {
      dm = {
        id: makeId('dm'),
        participantIds: ['hum_local', participantId],
        createdAt: now(),
        updatedAt: now(),
      };
      state.dms.push(dm);
    }
    addCollabEvent('dm_opened', 'DM opened.', { dmId: dm.id });
    await persistState();
    broadcastState();
    sendJson(res, 200, { dm });
    return true;
  }

  const messageMatch = url.pathname.match(/^\/api\/spaces\/(channel|dm)\/([^/]+)\/messages$/);
  if (req.method === 'POST' && messageMatch) {
    const body = await readJson(req);
    const [, spaceType, spaceId] = messageMatch;
    const targetExists = spaceType === 'channel'
      ? state.channels.some((channel) => channel.id === spaceId)
      : state.dms.some((dm) => dm.id === spaceId);
    if (!targetExists) {
      sendError(res, 404, 'Conversation not found.');
      return true;
    }
    const text = String(body.body || '').trim();
    const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds.map(String) : [];
    if (!text && !attachmentIds.length) {
      sendError(res, 400, 'Message body or attachment is required.');
      return true;
    }
    const mentions = extractMentions(text);
    const message = normalizeConversationRecord({
      id: makeId('msg'),
      spaceType,
      spaceId,
      authorType: body.authorType === 'agent' ? 'agent' : 'human',
      authorId: String(body.authorId || 'hum_local'),
      body: text,
      attachmentIds,
      mentionedAgentIds: mentions.agents,
      mentionedHumanIds: mentions.humans,
      readBy: body.authorType === 'agent' ? [] : ['hum_local'],
      replyCount: 0,
      savedBy: [],
      createdAt: now(),
      updatedAt: now(),
    });
    applyMentions(message, mentions);
    state.messages.push(message);

    let task = null;
    if (body.asTask) {
      task = createTaskFromMessage(message, body.taskTitle || text);
      message.taskId = task.id;
    }

    let respondingAgents = [];
    let routeDecision = null;
    if (message.authorType === 'human' && spaceType === 'channel') {
      const channel = findChannel(spaceId);
      if (channel) {
        const channelAgents = channelAgentIds(channel)
          .map(id => findAgent(id))
          .filter(Boolean);
        routeDecision = await routeMessageForChannel({
          channelAgents,
          mentions,
          message,
          spaceId,
        });
        respondingAgents = routeDecision.targetAgentIds
          .map((id) => channelAgents.find((agent) => agent.id === id))
          .filter(Boolean);
        const claimant = routeDecision.claimantAgentId
          ? channelAgents.find((agent) => agent.id === routeDecision.claimantAgentId)
          : null;
        if (claimant && routeDecision.mode === 'task_claim' && routeDecision.taskIntent) {
          task = createOrClaimTaskForMessage(message, claimant, {
            title: body.taskTitle || routeDecision.taskIntent.title || text,
            createdBy: message.authorId,
          });
          message.taskId = task.id;
        }
      }
    }

    addCollabEvent('message_sent', 'Message sent.', { messageId: message.id, spaceType, spaceId });
    await persistState();
    broadcastState();

    // Deliver message to agents in the conversation
    if (message.authorType === 'human') {
      if (spaceType === 'dm') {
        // In a DM, deliver to the agent participant
        const dm = state.dms.find(d => d.id === spaceId);
        if (dm) {
          const agentId = dm.participantIds.find(id => id.startsWith('agt_'));
          const agent = agentId ? findAgent(agentId) : null;
          if (agent) {
            // Don't await - let agent process in background
            deliverMessageToAgent(agent, spaceType, spaceId, message).catch(err => {
              addSystemEvent('delivery_error', `Failed to deliver to ${agent.name}: ${err.message}`, { agentId });
            });
          }
        }
      } else if (spaceType === 'channel') {
        // In a channel, use intelligent dispatch based on mentions, work intent, and personality.
        for (const agent of respondingAgents) {
          deliverMessageToAgent(agent, spaceType, spaceId, message).catch(err => {
            addSystemEvent('delivery_error', `Failed to deliver to ${agent.name}: ${err.message}`, { agentId: agent.id });
          });
        }
      }
    }

    if (message.authorType === 'human' && userPreferenceIntent(text)) {
      const memoryTargets = respondingAgents.length
        ? respondingAgents
        : (spaceType === 'channel'
          ? channelAgentIds(findChannel(spaceId)).map((id) => findAgent(id)).filter(Boolean)
          : []);
      for (const agent of memoryTargets) {
        scheduleAgentMemoryWriteback(agent, 'user_preference', { message, spaceType, spaceId });
      }
    }
    if (routeDecision?.targetAgentIds?.length > 1 && (agentCapabilityQuestionIntent(text) || availabilityFollowupIntent(text))) {
      for (const agent of respondingAgents) {
        scheduleAgentMemoryWriteback(agent, 'multi_agent_collaboration', {
          message,
          spaceType,
          spaceId,
          routeEvent: routeDecision.routeEvent,
          peerAgentIds: routeDecision.targetAgentIds.filter((id) => id !== agent.id),
        });
      }
    }

    sendJson(res, 201, { message, task, route: routeDecision });
    return true;
  }

  const replyMatch = url.pathname.match(/^\/api\/messages\/([^/]+)\/replies$/);
  if (req.method === 'POST' && replyMatch) {
    const message = findMessage(replyMatch[1]);
    if (!message) {
      sendError(res, 404, 'Message not found.');
      return true;
    }
    const body = await readJson(req);
    if (body.asTask) {
      sendError(res, 400, 'Thread replies cannot become tasks. Create a new top-level task message instead.');
      return true;
    }
    const text = String(body.body || '').trim();
    const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds.map(String) : [];
    if (!text && !attachmentIds.length) {
      sendError(res, 400, 'Reply body or attachment is required.');
      return true;
    }
    const mentions = extractMentions(text);
    const reply = normalizeConversationRecord({
      id: makeId('rep'),
      parentMessageId: message.id,
      spaceType: message.spaceType,
      spaceId: message.spaceId,
      authorType: body.authorType === 'agent' ? 'agent' : 'human',
      authorId: String(body.authorId || 'hum_local'),
      body: text,
      attachmentIds,
      mentionedAgentIds: mentions.agents,
      mentionedHumanIds: mentions.humans,
      readBy: body.authorType === 'agent' ? [] : ['hum_local'],
      createdAt: now(),
      updatedAt: now(),
    });
    applyMentions(reply, mentions);
    state.replies.push(reply);
    message.replyCount = state.replies.filter((item) => item.parentMessageId === message.id).length;
    message.updatedAt = now();
    addCollabEvent('thread_reply', 'Thread reply added.', { messageId: message.id, replyId: reply.id });
    const linkedTask = findTaskForThreadMessage(message);
    let createdThreadTask = null;
    let createdThreadTaskMessage = null;
    let endedThreadTask = null;
    let stoppedThreadTask = null;
    let stopResult = null;
    if (reply.authorType === 'human' && linkedTask && taskStopIntent(text)) {
      stopResult = stopTaskFromThread(linkedTask, reply.authorId, reply.id);
      stoppedThreadTask = linkedTask;
      addSystemReply(message.id, 'Task marked done from thread stop request.');
    } else if (reply.authorType === 'human' && linkedTask && taskEndIntent(text)) {
      finishTaskFromThread(linkedTask, reply.authorId, reply.id);
      endedThreadTask = linkedTask;
      addSystemReply(message.id, 'Task marked done from thread request.');
    }
    if (reply.authorType === 'human' && message.spaceType === 'channel' && taskCreationIntent(text)) {
      const channel = findChannel(message.spaceId);
      const channelAgents = channel
        ? channelAgentIds(channel).map(id => findAgent(id)).filter(Boolean)
        : [];
      const preferredAgentIds = [
        ...(mentions.agents || []),
        ...(linkedTask?.claimedBy ? [linkedTask.claimedBy] : []),
        ...(linkedTask?.assigneeIds || []),
        ...(message.mentionedAgentIds || []),
      ];
      const agent = pickAvailableAgent(channelAgents, preferredAgentIds);
      if (agent) {
        const created = createTaskFromThreadIntent(message, reply, agent);
        createdThreadTask = created.task;
        createdThreadTaskMessage = created.message;
      }
    }
    await persistState();
    broadcastState();

    if (createdThreadTask && createdThreadTaskMessage) {
      const taskAgent = findAgent(createdThreadTask.claimedBy || createdThreadTask.assigneeId);
      if (taskAgent) {
        const taskDeliveryMessage = taskThreadDeliveryMessage(createdThreadTask, createdThreadTaskMessage, reply, taskAgent);
        deliverMessageToAgent(taskAgent, message.spaceType, message.spaceId, taskDeliveryMessage, { parentMessageId: createdThreadTaskMessage.id }).catch(err => {
          addSystemEvent('delivery_error', `Failed to deliver created task to ${taskAgent.name}: ${err.message}`, {
            agentId: taskAgent.id,
            taskId: createdThreadTask.id,
            messageId: createdThreadTaskMessage.id,
          });
        });
      }
    }

    if (reply.authorType === 'human' && !createdThreadTask && !endedThreadTask && !stoppedThreadTask) {
      const channel = message.spaceType === 'channel' ? findChannel(message.spaceId) : null;
      const channelAgents = channel
        ? channelAgentIds(channel).map(id => findAgent(id)).filter(Boolean)
        : [];
      let respondingAgents = message.spaceType === 'channel'
        ? determineThreadRespondingAgents(message, reply, channelAgents, mentions, linkedTask)
        : [];
      if (message.spaceType === 'dm') {
        const dm = state.dms.find((item) => item.id === message.spaceId);
        const agentId = dm?.participantIds?.find((id) => id.startsWith('agt_'));
        const agent = agentId ? findAgent(agentId) : null;
        respondingAgents = agent && agentAvailableForAutoWork(agent) ? [agent] : [];
      }
      for (const agent of respondingAgents) {
        deliverMessageToAgent(agent, message.spaceType, message.spaceId, reply, { parentMessageId: message.id }).catch(err => {
          addSystemEvent('delivery_error', `Failed to deliver thread reply to ${agent.name}: ${err.message}`, { agentId: agent.id, replyId: reply.id, parentMessageId: message.id });
        });
      }
    }

    sendJson(res, 201, {
      reply,
      createdTask: createdThreadTask,
      createdTaskMessage: createdThreadTaskMessage,
      endedTask: endedThreadTask,
      stoppedTask: stoppedThreadTask,
      stopResult,
    });
    return true;
  }

  const saveMatch = url.pathname.match(/^\/api\/messages\/([^/]+)\/save$/);
  if (req.method === 'POST' && saveMatch) {
    const message = findConversationRecord(saveMatch[1]);
    if (!message) {
      sendError(res, 404, 'Message not found.');
      return true;
    }
    const userId = 'hum_local';
    message.savedBy = Array.isArray(message.savedBy) ? message.savedBy : [];
    if (message.savedBy.includes(userId)) {
      message.savedBy = message.savedBy.filter((id) => id !== userId);
    } else {
      message.savedBy.push(userId);
    }
    message.updatedAt = now();
    await persistState();
    broadcastState();
    sendJson(res, 200, { message });
    return true;
  }

  const taskFromMessageMatch = url.pathname.match(/^\/api\/messages\/([^/]+)\/task$/);
  if (req.method === 'POST' && taskFromMessageMatch) {
    const message = findMessage(taskFromMessageMatch[1]);
    if (!message) {
      sendError(res, 404, 'Message not found.');
      return true;
    }
    const body = await readJson(req);
    normalizeConversationRecord(message);
    const task = createTaskFromMessage(message, body.title || message.body);
    message.taskId = task.id;
    await persistState();
    broadcastState();
    sendJson(res, 201, { task });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/tasks') {
    const body = await readJson(req);
    const title = String(body.title || '').trim();
    if (!title) {
      sendError(res, 400, 'Task title is required.');
      return true;
    }
    let space;
    try {
      space = resolveConversationSpace(body);
    } catch (error) {
      sendError(res, error.status || 400, error.message);
      return true;
    }
    const assigneeIds = normalizeIds([
      ...(Array.isArray(body.assigneeIds) ? body.assigneeIds : []),
      ...(body.assigneeId ? [body.assigneeId] : []),
    ]);
    const { message, task } = createTaskMessage({
      title,
      body: String(body.body || '').trim(),
      ...space,
      authorType: body.authorType === 'agent' ? 'agent' : 'human',
      authorId: String(body.authorId || 'hum_local'),
      assigneeIds,
      attachmentIds: Array.isArray(body.attachmentIds) ? body.attachmentIds.map(String) : [],
      sourceMessageId: body.sourceMessageId || body.messageId || null,
      sourceReplyId: body.sourceReplyId || null,
      status: body.status || 'todo',
    });
    await persistState();
    broadcastState();
    sendJson(res, 201, { message, task });
    return true;
  }

  const claimMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/claim$/);
  if (req.method === 'POST' && claimMatch) {
    const task = findTask(claimMatch[1]);
    if (!task) {
      sendError(res, 404, 'Task not found.');
      return true;
    }
    const body = await readJson(req);
    const actorId = String(body.actorId || body.assigneeId || 'agt_codex');
    try {
      claimTask(task, actorId, { force: body.force });
    } catch (error) {
      sendError(res, error.status || 409, error.message);
      return true;
    }
    await persistState();
    broadcastState();
    sendJson(res, 200, { task });
    return true;
  }

  const unclaimMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/unclaim$/);
  if (req.method === 'POST' && unclaimMatch) {
    const task = findTask(unclaimMatch[1]);
    if (!task) {
      sendError(res, 404, 'Task not found.');
      return true;
    }
    if (taskIsClosed(task)) {
      sendError(res, 409, 'Closed task cannot be unclaimed.');
      return true;
    }
    const actorId = task.claimedBy || 'hum_local';
    task.claimedBy = null;
    task.assigneeId = task.assigneeIds?.[0] || null;
    task.claimedAt = null;
    task.status = 'todo';
    task.reviewRequestedAt = null;
    addTaskHistory(task, 'unclaimed', 'Claim released.', actorId);
    const thread = ensureTaskThread(task);
    addSystemReply(thread.id, 'Task claim released.');
    addTaskTimelineMessage(task, `🔓 ${displayActor(actorId)} released ${taskLabel(task)}`, 'task_unclaimed');
    await persistState();
    broadcastState();
    sendJson(res, 200, { task });
    return true;
  }

  const reviewMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/request-review$/);
  if (req.method === 'POST' && reviewMatch) {
    const task = findTask(reviewMatch[1]);
    if (!task) {
      sendError(res, 404, 'Task not found.');
      return true;
    }
    if (taskIsClosed(task)) {
      sendError(res, 409, 'Closed task cannot request review.');
      return true;
    }
    if (!task.claimedBy) {
      sendError(res, 409, 'Task must be claimed before requesting review.');
      return true;
    }
    task.status = 'in_review';
    task.reviewRequestedAt = now();
    addTaskHistory(task, 'review_requested', 'Review requested.', task.claimedBy);
    const thread = ensureTaskThread(task);
    addSystemReply(thread.id, 'Review requested. Waiting for human approval.');
    addTaskTimelineMessage(task, `👀 ${displayActor(task.claimedBy)} moved ${taskLabel(task)} to In Review`, 'task_review');
    await persistState();
    broadcastState();
    sendJson(res, 200, { task });
    return true;
  }

  const approveMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/approve$/);
  if (req.method === 'POST' && approveMatch) {
    const task = findTask(approveMatch[1]);
    if (!task) {
      sendError(res, 404, 'Task not found.');
      return true;
    }
    if (task.status !== 'in_review') {
      sendError(res, 409, 'Task must be in review before approval.');
      return true;
    }
    task.status = 'done';
    task.completedAt = now();
    addTaskHistory(task, 'approved', 'Human review approved; task marked done.');
    const thread = ensureTaskThread(task);
    addSystemReply(thread.id, 'Human review approved. Task marked done.');
    addTaskTimelineMessage(task, `✅ ${displayActor('hum_local')} moved ${taskLabel(task)} to Done`, 'task_done');
    await persistState();
    broadcastState();
    sendJson(res, 200, { task });
    return true;
  }

  const reopenMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/reopen$/);
  if (req.method === 'POST' && reopenMatch) {
    const task = findTask(reopenMatch[1]);
    if (!task) {
      sendError(res, 404, 'Task not found.');
      return true;
    }
    task.status = 'todo';
    task.claimedBy = null;
    task.assigneeId = task.assigneeIds?.[0] || null;
    task.claimedAt = null;
    task.reviewRequestedAt = null;
    task.completedAt = null;
    task.endIntentAt = null;
    task.cancelledAt = null;
    task.stoppedAt = null;
    addTaskHistory(task, 'reopened', 'Task reopened by human.');
    const thread = ensureTaskThread(task);
    addSystemReply(thread.id, 'Task reopened.');
    addTaskTimelineMessage(task, `↩ ${displayActor('hum_local')} reopened ${taskLabel(task)}`, 'task_reopened');
    await persistState();
    broadcastState();
    sendJson(res, 200, { task });
    return true;
  }

  const runTaskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/run-codex$/);
  if (req.method === 'POST' && runTaskMatch) {
    const task = findTask(runTaskMatch[1]);
    if (!task) {
      sendError(res, 404, 'Task not found.');
      return true;
    }
    if (taskIsClosed(task)) {
      sendError(res, 409, 'Closed task cannot start a Codex run.');
      return true;
    }
    const actorId = 'agt_codex';
    if (task.claimedBy && task.claimedBy !== actorId) {
      sendError(res, 409, `Task is already claimed by ${task.claimedBy}.`);
      return true;
    }
    if (!task.claimedBy) {
      task.claimedBy = actorId;
      task.assigneeId = actorId;
      task.assigneeIds = normalizeIds([...(task.assigneeIds || []), actorId]);
      task.claimedAt = now();
      task.status = 'in_progress';
      addTaskHistory(task, 'claimed', 'Auto-claimed before Codex run.', actorId);
      addSystemReply(ensureTaskThread(task).id, 'Task auto-claimed by Codex before run.');
      addTaskTimelineMessage(task, `📌 ${displayActor(actorId)} claimed ${taskLabel(task)}`, 'task_claimed');
    }

    const mission = {
      id: makeId('mis'),
      title: task.title,
      goal: `${task.title}\n\n${task.body || ''}\n\nTask id: ${task.id}`,
      status: 'ready',
      priority: 'normal',
      workspace: path.resolve(state.settings.defaultWorkspace || ROOT),
      scopeAllow: ['**/*'],
      scopeDeny: ['.env*', 'node_modules/**', '.git/**'],
      gates: ['npm run check'],
      evidenceRequired: ['diff summary', 'test output', 'risk notes'],
      humanCheckpoints: ['before dangerous command', 'before deploy'],
      attachmentIds: Array.isArray(task.attachmentIds) ? task.attachmentIds : [],
      localReferences: Array.isArray(task.localReferences) ? task.localReferences : [],
      taskId: task.id,
      createdAt: now(),
      updatedAt: now(),
    };
    state.missions.unshift(mission);
    const run = {
      id: makeId('run'),
      missionId: mission.id,
      taskId: task.id,
      runtime: 'codex',
      status: 'queued',
      createdAt: now(),
      startedAt: null,
      completedAt: null,
      exitCode: null,
      finalMessage: '',
    };
    state.runs.unshift(run);
    task.runIds = Array.isArray(task.runIds) ? task.runIds : [];
    task.runIds.unshift(run.id);
    addTaskHistory(task, 'run_started', `Codex run started: ${run.id}`, actorId, { runId: run.id, missionId: mission.id });
    addSystemReply(ensureTaskThread(task).id, `Codex run started: ${run.id}.`);
    await persistState();
    broadcastState();
    startCodexRun(mission, run);
    sendJson(res, 201, { task, mission, run });
    return true;
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (['PATCH', 'POST'].includes(req.method) && taskMatch) {
    const task = findTask(taskMatch[1]);
    if (!task) {
      sendError(res, 404, 'Task not found.');
      return true;
    }
    const body = await readJson(req);
    if (body.title !== undefined) task.title = String(body.title || task.title).trim();
    if (body.body !== undefined) task.body = String(body.body || '').trim();
    if (body.status !== undefined && body.status !== task.status) {
      const nextStatus = String(body.status || task.status);
      if (nextStatus === 'done' && task.status !== 'in_review') {
        sendError(res, 409, 'Task must be in review before done.');
        return true;
      }
      task.status = nextStatus;
      if (nextStatus === 'in_review') task.reviewRequestedAt = now();
      if (nextStatus === 'done') task.completedAt = now();
      addTaskHistory(task, 'status_changed', `Status changed to ${nextStatus}.`);
      if (nextStatus === 'in_review') addTaskTimelineMessage(task, `👀 ${displayActor('hum_local')} moved ${taskLabel(task)} to In Review`, 'task_review');
      if (nextStatus === 'done') addTaskTimelineMessage(task, `✅ ${displayActor('hum_local')} moved ${taskLabel(task)} to Done`, 'task_done');
    }
    if (body.assigneeId !== undefined) {
      task.assigneeId = body.assigneeId ? String(body.assigneeId) : null;
      task.assigneeIds = task.assigneeId ? normalizeIds([...(task.assigneeIds || []), task.assigneeId]) : [];
      addTaskHistory(task, 'assigned', task.assigneeId ? `Assigned to ${displayActor(task.assigneeId)}.` : 'Assignee cleared.');
    }
    if (body.assigneeIds !== undefined) {
      task.assigneeIds = normalizeIds(body.assigneeIds);
      task.assigneeId = task.assigneeIds[0] || null;
      addTaskHistory(task, 'assigned', task.assigneeIds.length ? `Assigned to ${task.assigneeIds.map((id) => displayActor(id)).join(', ')}.` : 'Assignees cleared.');
    }
    task.updatedAt = now();
    addCollabEvent('task_updated', `Task updated: ${task.title}`, { taskId: task.id });
    await persistState();
    broadcastState();
    sendJson(res, 200, { task });
    return true;
  }

  const deleteTaskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteTaskMatch) {
    const taskId = deleteTaskMatch[1];
    state.tasks = state.tasks.filter((task) => task.id !== taskId);
    for (const message of state.messages) {
      if (message.taskId === taskId) delete message.taskId;
    }
    addCollabEvent('task_deleted', 'Task deleted.', { taskId });
    await persistState();
    broadcastState();
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/brain-agents') {
    sendJson(res, 200, {
      brainAgents: [],
      activeBrainAgentId: null,
      router: state.router || {},
      deprecated: true,
      replacement: '/api/settings/fanout',
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/brain-agents') {
    sendError(res, 410, 'Brain Agent configuration was replaced by /api/settings/fanout.');
    return true;
  }

  const brainAgentMatch = url.pathname.match(/^\/api\/brain-agents\/([^/]+)$/);
  if (['PATCH', 'POST'].includes(req.method) && brainAgentMatch) {
    sendError(res, 410, 'Brain Agent configuration was replaced by /api/settings/fanout.');
    return true;
  }

  if (req.method === 'DELETE' && brainAgentMatch) {
    sendError(res, 410, 'Brain Agent configuration was replaced by /api/settings/fanout.');
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/agents') {
    const body = await readJson(req);
    const agent = {
      id: makeId('agt'),
      name: String(body.name || 'New Agent').trim().slice(0, 80),
      description: String(body.description || '').trim(),
      runtime: String(body.runtime || 'Codex CLI'),
      model: normalizeCodexModelName(body.model, state.settings?.model),
      status: 'idle',
      computerId: String(body.computerId || 'cmp_local'),
      workspace: path.resolve(String(body.workspace || state.settings.defaultWorkspace || ROOT)),
      reasoningEffort: body.reasoningEffort ? String(body.reasoningEffort) : null,
      envVars: Array.isArray(body.envVars) ? body.envVars : null,
      avatar: body.avatar ? String(body.avatar) : null,
      statusUpdatedAt: now(),
      heartbeatAt: now(),
      createdAt: now(),
    };
    state.agents.push(agent);
    await ensureAgentWorkspace(agent);

    // Auto-add to #all channel
    const allChannel = findChannel('chan_all');
    if (allChannel && agentParticipatesInChannels(agent)) {
      allChannel.agentIds = normalizeIds([...(allChannel.agentIds || []), agent.id]);
      allChannel.memberIds = normalizeIds([...(allChannel.memberIds || []), agent.id]);
      allChannel.updatedAt = now();
    }

    addCollabEvent('agent_created', `Agent created: ${agent.name}`, { agentId: agent.id });
    await persistState();
    broadcastState();
    sendJson(res, 201, { agent });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/agents/stop-all') {
    const body = await readJson(req);
    let scope = null;
    try {
      scope = stopScopeFromBody(body);
    } catch (error) {
      sendError(res, error.status || 400, error.message);
      return true;
    }
    const stoppedRuns = stopRunsForScope(scope);
    const stopped = stopAgentProcesses(scope);
    if (!scope) {
      for (const agent of state.agents) setAgentStatus(agent, 'idle', 'stop_all');
      agentProcesses.clear();
    }
    const label = scope?.label || 'all channels';
    addCollabEvent('agents_stopped', `Stop all agents requested in ${label}.`, {
      scope: scope ? { spaceType: scope.spaceType, spaceId: scope.spaceId } : null,
      stoppedRuns,
      stoppedAgents: stopped.stoppedAgents,
      cancelledWorkItems: stopped.cancelledWorkItems,
    });
    await persistState();
    broadcastState();
    sendJson(res, 200, {
      ok: true,
      scope,
      stoppedRuns,
      stoppedAgents: stopped.stoppedAgents,
      cancelledWorkItems: stopped.cancelledWorkItems,
    });
    return true;
  }

  const agentStartMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/start$/);
  if (req.method === 'POST' && agentStartMatch) {
    const agent = findAgent(agentStartMatch[1]);
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    if (!agentProcesses.has(agent.id)) {
      await startAgentFromControl(agent);
      addCollabEvent('agent_start_requested', `Agent start requested: ${agent.name}`, { agentId: agent.id });
      await persistState();
      broadcastState();
    }
    sendJson(res, 202, { agent, running: true });
    return true;
  }

  const agentRestartMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/restart$/);
  if (req.method === 'POST' && agentRestartMatch) {
    const agent = findAgent(agentRestartMatch[1]);
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    const body = await readJson(req);
    const result = await restartAgentFromControl(agent, String(body.mode || 'restart'));
    sendJson(res, 202, { agent, ...result });
    return true;
  }

  const agentWorkspaceMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/workspace$/);
  if (req.method === 'GET' && agentWorkspaceMatch) {
    const agent = findAgent(agentWorkspaceMatch[1]);
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    try {
      const tree = await listAgentWorkspace(agent, url.searchParams.get('path') || '');
      sendJson(res, 200, tree);
    } catch (error) {
      sendError(res, error.status || 500, error.message);
    }
    return true;
  }

  const agentWorkspaceFileMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/workspace\/file$/);
  if (req.method === 'GET' && agentWorkspaceFileMatch) {
    const agent = findAgent(agentWorkspaceFileMatch[1]);
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    try {
      const file = await readAgentWorkspaceFile(agent, url.searchParams.get('path') || 'MEMORY.md');
      sendJson(res, 200, file);
    } catch (error) {
      sendError(res, error.status || 500, error.message);
    }
    return true;
  }

  const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (['PATCH', 'POST'].includes(req.method) && agentMatch) {
    const agent = findAgent(agentMatch[1]);
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    const body = await readJson(req);
    for (const key of ['name', 'description', 'runtime', 'model', 'computerId', 'workspace', 'reasoningEffort', 'avatar']) {
      if (body[key] !== undefined) agent[key] = String(body[key] || '').trim();
    }
    if (body.status !== undefined) setAgentStatus(agent, String(body.status || '').trim() || 'idle', 'agent_patch', { forceEvent: true });
    if (body.model !== undefined) agent.model = normalizeCodexModelName(body.model, state.settings?.model);
    if (body.reasoningEffort === null) agent.reasoningEffort = null;
    if (Array.isArray(body.envVars)) agent.envVars = body.envVars;
    addCollabEvent('agent_updated', `Agent updated: ${agent.name}`, { agentId: agent.id });
    await persistState();
    broadcastState();
    sendJson(res, 200, { agent });
    return true;
  }

  if (req.method === 'DELETE' && agentMatch) {
    const agentId = agentMatch[1];
    const agent = findAgent(agentId);
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    // Remove from agents list
    state.agents = state.agents.filter(a => a.id !== agentId);
    // Remove from all channels
    for (const channel of state.channels) {
      channel.agentIds = Array.isArray(channel.agentIds) ? channel.agentIds.filter(id => id !== agentId) : [];
      channel.memberIds = Array.isArray(channel.memberIds) ? channel.memberIds.filter(id => id !== agentId) : [];
    }
    addCollabEvent('agent_deleted', `Agent deleted: ${agent.name}`, { agentId });
    await persistState();
    broadcastState();
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/computers') {
    const body = await readJson(req);
    const computer = {
      id: makeId('cmp'),
      name: String(body.name || os.hostname()).trim(),
      os: String(body.os || `${os.platform()} ${os.arch()}`),
      daemonVersion: String(body.daemonVersion || 'manual'),
      status: body.status || 'offline',
      runtimeIds: Array.isArray(body.runtimeIds) ? body.runtimeIds.map(String) : ['codex'],
      createdAt: now(),
    };
    state.computers.push(computer);
    addCollabEvent('computer_added', `Computer added: ${computer.name}`, { computerId: computer.id });
    await persistState();
    broadcastState();
    sendJson(res, 201, { computer });
    return true;
  }

  const computerMatch = url.pathname.match(/^\/api\/computers\/([^/]+)$/);
  if (['PATCH', 'POST'].includes(req.method) && computerMatch) {
    const computer = findComputer(computerMatch[1]);
    if (!computer) {
      sendError(res, 404, 'Computer not found.');
      return true;
    }
    const body = await readJson(req);
    for (const key of ['name', 'os', 'daemonVersion', 'status']) {
      if (body[key] !== undefined) computer[key] = String(body[key] || '').trim();
    }
    await persistState();
    broadcastState();
    sendJson(res, 200, { computer });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/humans') {
    const body = await readJson(req);
    const email = String(body.email || '').trim();
    const human = {
      id: makeId('hum'),
      name: String(body.name || email.split('@')[0] || 'Human').trim(),
      email,
      role: body.role || 'member',
      status: 'invited',
      createdAt: now(),
    };
    state.humans.push(human);
    const allChannel = findChannel('chan_all');
    if (allChannel) {
      allChannel.humanIds = normalizeIds([...(allChannel.humanIds || []), human.id]);
      allChannel.memberIds = normalizeIds([...(allChannel.memberIds || []), human.id]);
      allChannel.updatedAt = now();
    }
    addCollabEvent('human_invited', `Human invited: ${human.email || human.name}`, { humanId: human.id });
    await persistState();
    broadcastState();
    sendJson(res, 201, { human });
    return true;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/attachments/')) {
    const [, , , id] = url.pathname.split('/');
    const attachment = state.attachments.find((item) => item.id === id);
    if (!attachment) {
      sendError(res, 404, 'Attachment not found.');
      return true;
    }
    res.writeHead(200, {
      'content-type': attachment.type || 'application/octet-stream',
      'content-length': attachment.bytes,
      'cache-control': 'private, max-age=3600',
    });
    createReadStream(attachment.path).pipe(res);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/missions') {
    const body = await readJson(req);
    const mission = {
      id: makeId('mis'),
      title: String(body.title || 'Untitled mission').slice(0, 140),
      goal: String(body.goal || '').trim(),
      status: 'ready',
      priority: body.priority || 'normal',
      workspace: path.resolve(String(body.workspace || state.settings.defaultWorkspace || ROOT)),
      scopeAllow: splitLines(body.scopeAllow || '**/*'),
      scopeDeny: splitLines(body.scopeDeny || '.env*\nnode_modules/**\n.git/**'),
      gates: splitLines(body.gates),
      evidenceRequired: splitLines(body.evidenceRequired || 'diff summary\ntest output\nrisk notes'),
      humanCheckpoints: splitLines(body.humanCheckpoints || 'before dangerous command\nbefore deploy'),
      attachmentIds: Array.isArray(body.attachmentIds) ? body.attachmentIds.map(String) : [],
      localReferences: Array.isArray(body.localReferences) ? body.localReferences : [],
      createdAt: now(),
      updatedAt: now(),
    };

    if (!mission.goal) {
      sendError(res, 400, 'Mission goal is required.');
      return true;
    }

    state.missions.unshift(mission);
    addSystemEvent('mission_created', `Mission created: ${mission.title}`, { missionId: mission.id });
    await persistState();
    broadcastState();
    sendJson(res, 201, { mission });
    return true;
  }

  const runMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/runs$/);
  if (req.method === 'POST' && runMatch) {
    const mission = findMission(runMatch[1]);
    if (!mission) {
      sendError(res, 404, 'Mission not found.');
      return true;
    }
    const run = {
      id: makeId('run'),
      missionId: mission.id,
      runtime: 'codex',
      status: 'queued',
      createdAt: now(),
      startedAt: null,
      completedAt: null,
      exitCode: null,
      finalMessage: '',
    };
    state.runs.unshift(run);
    await persistState();
    broadcastState();
    startCodexRun(mission, run);
    sendJson(res, 201, { run });
    return true;
  }

  const cancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
  if (req.method === 'POST' && cancelMatch) {
    const run = findRun(cancelMatch[1]);
    const child = runningProcesses.get(cancelMatch[1]);
    if (!run || !child) {
      sendError(res, 404, 'Running Codex process not found.');
      return true;
    }
    run.cancelRequested = true;
    child.kill('SIGTERM');
    addRunEvent(run.id, 'runner', 'Cancellation requested.');
    await persistState();
    broadcastState();
    sendJson(res, 200, { run });
    return true;
  }

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
