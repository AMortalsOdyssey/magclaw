import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  codexRuntimeOverrideForDelivery as codexRuntimeOverrideForDeliveryBase,
  resolveCodexRuntime as resolveCodexRuntimeBase,
} from './codex-runtime.js';
import { autoTaskMessageIntent, taskCreationIntent } from './intents.js';
import { normalizeIds } from './mentions.js';
import {
  DEFAULT_FANOUT_API_BASE_URL,
  DEFAULT_FANOUT_API_FALLBACK_MODEL,
  DEFAULT_FANOUT_API_MODEL,
  fanoutApiConfigReady,
  normalizeChatRuntimeConfig,
  normalizeCloudUrl,
  normalizeCodexModelName as normalizeCodexModelNameBase,
  normalizeFanoutApiConfig as normalizeFanoutApiConfigBase,
} from './runtime-config.js';

// State core and migration layer.
// This owns the mutable state object, JSON/SQLite persistence, startup
// migrations, retired routing-agent cleanup, and Agent status bookkeeping.
export function createStateCore(deps) {
  const {
    ensureAllAgentWorkspaces,
    extractLocalReferences,
    findAgent,
    agentProcesses,
    makeId,
    normalizeConversationRecord,
    now,
    publicState,
    queueCloudPush,
    sseClients,
    targetForConversation,
    taskScopeKey,
    AGENT_BOOT_RESET_STATUSES,
    AGENT_STATUS_STALE_MS,
    AGENTS_DIR,
    ATTACHMENTS_DIR,
    CLOUD_PROTOCOL_VERSION,
    CODEX_FALLBACK_MODEL,
    CODEX_HOME_CONFIG_VERSION,
    FANOUT_API_TIMEOUT_MS,
    ROOT,
    RUNS_DIR,
    SOURCE_CODEX_HOME,
    SQLITE_BACKED_STATE_KEYS,
    STATE_DB_FILE,
    STATE_FILE,
  } = deps;

  let state = null;
  let saveChain = Promise.resolve();
  let stateDb = null;
  const stateProxy = new Proxy({}, {
    get(_target, prop) { return state?.[prop]; },
    set(_target, prop, value) {
      if (!state) state = {};
      state[prop] = value;
      return true;
    },
    ownKeys() { return Reflect.ownKeys(state || {}); },
    getOwnPropertyDescriptor(_target, prop) {
      if (!state || !(prop in state)) return undefined;
      return { enumerable: true, configurable: true };
    },
  });

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
          baseUrl: normalizeCloudUrl(process.env.MAGCLAW_FANOUT_API_BASE_URL || DEFAULT_FANOUT_API_BASE_URL),
          apiKey: process.env.MAGCLAW_FANOUT_API_KEY || '',
          model: process.env.MAGCLAW_FANOUT_API_MODEL || DEFAULT_FANOUT_API_MODEL,
          fallbackModel: process.env.MAGCLAW_FANOUT_API_FALLBACK_MODEL || DEFAULT_FANOUT_API_FALLBACK_MODEL,
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
      cloud: {
        schemaVersion: 1,
        auth: {
          allowSignups: process.env.MAGCLAW_ALLOW_SIGNUPS === '1',
          passwordLogin: true,
        },
        workspaces: [
          {
            id: process.env.MAGCLAW_WORKSPACE_ID || 'local',
            slug: process.env.MAGCLAW_WORKSPACE_ID || 'local',
            name: process.env.MAGCLAW_DEFAULT_WORKSPACE_NAME || 'MagClaw',
            createdAt: seededAt,
          },
        ],
        workspaceMembers: [],
        users: [],
        sessions: [],
        invitations: [],
        pairingTokens: [],
        computerTokens: [],
        agentDeliveries: [],
        daemonEvents: [],
      },
      storage: {
        schemaVersion: 1,
        sqliteFile: 'state.sqlite',
        sqliteBackedKeys: SQLITE_BACKED_STATE_KEYS,
      },
      router: {
        mode: 'rules_fallback',
        fallback: 'rules',
        cardSource: 'workspace_markdown',
      },
      humans: [
        {
          id: 'hum_local',
          name: 'You',
          email: 'local@magclaw.dev',
          role: 'admin',
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
  
  function agentParticipatesInChannels(agent) {
    return Boolean(agent);
  }
  
  function isRetiredRoutingAgent(agent) {
    if (!agent) return false;
    const runtime = String(agent.runtime || '').trim().toLowerCase();
    const role = String(agent.systemRole || '').trim().toLowerCase();
    return agent.id === 'agt_magclaw_brain'
      || agent.isBrain === true
      || role === 'brain'
      || runtime === 'agent-card-router'
      || runtime === 'router brain';
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
    state.cloud = { ...fresh.cloud, ...(state.cloud || {}) };
    state.cloud.auth = { ...fresh.cloud.auth, ...(state.cloud.auth || {}) };
    delete state.cloud.auth.ownerInviteOnly;
    for (const key of ['workspaces', 'workspaceMembers', 'users', 'sessions', 'invitations', 'pairingTokens', 'computerTokens', 'agentDeliveries', 'daemonEvents']) {
      if (!Array.isArray(state.cloud[key])) state.cloud[key] = fresh.cloud[key] || [];
    }
    if (!state.cloud.workspaces.length) state.cloud.workspaces = fresh.cloud.workspaces;
    for (const workspace of state.cloud.workspaces) delete workspace.ownerUserId;
    for (const member of state.cloud.workspaceMembers) {
      if (member.role === 'owner') member.role = 'admin';
    }
    for (const invitation of state.cloud.invitations) {
      if (invitation.role === 'owner') invitation.role = 'admin';
    }
    for (const key of ['humans', 'computers', 'agents', 'channels', 'dms', 'messages', 'replies', 'tasks', 'missions', 'runs', 'attachments', 'projects', 'workItems', 'routeEvents', 'events']) {
      if (!Array.isArray(state[key])) state[key] = fresh[key] || [];
    }
    delete state.brainAgents;
    if (!state.humans.length) state.humans = fresh.humans;
    for (const human of state.humans) {
      if (human.role === 'owner') human.role = 'admin';
    }
    if (!state.computers.length) state.computers = fresh.computers;
    if (!state.agents.length) state.agents = fresh.agents;
    state.agents = (state.agents || []).filter((agent) => !isRetiredRoutingAgent(agent));
    state.router = { ...fresh.router, ...(state.router || {}) };
    state.router.mode = fanoutApiConfigured() ? 'llm_fanout' : 'rules_fallback';
    delete state.router.brainAgentId;
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
      task.stoppedAt = task.stoppedAt || null;
      if (task.status === 'stopped') {
        const closedAt = task.completedAt || task.stoppedAt || task.updatedAt || task.createdAt || now();
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
      agent.runtimeActivity = agent.runtimeActivity && typeof agent.runtimeActivity === 'object' ? agent.runtimeActivity : null;
      agent.workspacePath = agent.workspacePath || path.join(AGENTS_DIR, agent.id);
      agent.computerId = agent.computerId || 'cmp_local';
      agent.statusUpdatedAt = agent.statusUpdatedAt || agent.updatedAt || agent.createdAt || now();
      agent.heartbeatAt = agent.heartbeatAt || agent.statusUpdatedAt;
      agent.activeWorkItemIds = normalizeIds(agent.activeWorkItemIds || []);
      agent.model = normalizeCodexModelName(agent.model, state.settings?.model);
      if (AGENT_BOOT_RESET_STATUSES.has(String(agent.status || '').toLowerCase())) {
        agent.status = 'idle';
        agent.activeWorkItemIds = [];
        agent.runtimeActivity = null;
      }
      if (!agentStatusIsBusy(agent.status)) {
        agent.activeWorkItemIds = [];
        agent.runtimeActivity = null;
      }
      if (legacyRuntimeSessionId) {
        addSystemEvent('agent_runtime_session_reset', `${agent.name} legacy Codex session was cleared before isolated runtime start.`, {
          agentId: agent.id,
          previousSessionId: legacyRuntimeSessionId,
          previousHome: SOURCE_CODEX_HOME,
        });
      }
    }
    for (const computer of state.computers) {
      computer.workspaceId = computer.workspaceId || state.connection.workspaceId || 'local';
      computer.status = computer.status || 'offline';
      computer.runtimeIds = Array.isArray(computer.runtimeIds) ? computer.runtimeIds : [];
      computer.connectedVia = computer.connectedVia || (computer.id === 'cmp_local' ? 'local' : 'manual');
      computer.updatedAt = computer.updatedAt || computer.createdAt || now();
      computer.lastSeenAt = computer.lastSeenAt || null;
      computer.capabilities = Array.isArray(computer.capabilities) ? computer.capabilities : [];
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
    for (const res of sseClients) {
      const body = typeof payload === 'function' ? payload(res.magclawRequest || null) : payload;
      const packet = `event: ${type}\ndata: ${JSON.stringify(body)}\n\n`;
      res.write(packet);
    }
  }
  
  function broadcastState() {
    broadcast('state', (req) => publicState(req));
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
        runtimeActivity: agent.runtimeActivity || null,
      })),
    };
  }
  
  function broadcastHeartbeat() {
    broadcast('heartbeat', presenceHeartbeat());
  }
  
  function agentStatusIsBusy(status) {
    return ['starting', 'thinking', 'working', 'running', 'busy', 'queued'].includes(String(status || '').toLowerCase());
  }

  function runtimeProcessHasActiveWork(proc) {
    if (!proc) return false;
    const status = String(proc.status || '').toLowerCase();
    if (agentStatusIsBusy(status)) return true;
    if (proc.warmupActive || proc.pendingInitialPrompt || proc.pendingThreadRequest || proc.initializeRequestId) return true;
    if (proc.activeTurnId) return true;
    if (proc.activeTurnIds instanceof Set && proc.activeTurnIds.size) return true;
    if (Array.isArray(proc.pendingDeliveryMessages) && proc.pendingDeliveryMessages.length) return true;
    return false;
  }
  
  function setAgentStatus(agent, status, reason = 'status_update', extra = {}) {
    if (!agent) return null;
    const nextStatus = String(status || 'idle');
    const previousStatus = agent.status || 'offline';
    agent.status = nextStatus;
    agent.statusUpdatedAt = now();
    agent.heartbeatAt = agent.statusUpdatedAt;
    if (!agentStatusIsBusy(nextStatus)) {
      agent.runtimeActivity = null;
    }
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
      const activeProc = activeAgentIds.has(agent.id) ? agentProcesses.get(agent.id) : null;
      if (activeProc) {
        if (agentStatusIsBusy(agent.status) && !runtimeProcessHasActiveWork(activeProc)) {
          setAgentStatus(agent, 'idle', 'activity_probe_idle');
          addSystemEvent('agent_status_probe_recovered', `${agent.name} status reset to idle after local runtime reported no active work.`, { agentId: agent.id });
          changed = true;
          continue;
        }
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

  return {
    addRunEvent,
    addSystemEvent,
    agentParticipatesInChannels,
    agentStatusIsBusy,
    broadcast,
    broadcastHeartbeat,
    broadcastState,
    codexRuntimeOverrideForDelivery,
    ensureStorage,
    fanoutApiConfigured,
    getState: () => state,
    migrateState,
    normalizeCodexModelName,
    normalizeFanoutApiConfig,
    persistState,
    presenceHeartbeat,
    reconcileAgentStatusHeartbeats,
    resolveCodexRuntime,
    setAgentStatus,
    state: stateProxy,
    stateJsonSnapshot,
  };
}
