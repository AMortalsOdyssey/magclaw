import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultReleaseNotes, normalizeReleaseNotes } from './release-notes.js';
import {
  codexRuntimeOverrideForDelivery as codexRuntimeOverrideForDeliveryBase,
  resolveCodexRuntime as resolveCodexRuntimeBase,
} from './codex-runtime.js';
import { autoTaskMessageIntent, taskCreationIntent } from './intents.js';
import { normalizeIds } from './mentions.js';
import {
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
    HUMAN_PRESENCE_TIMEOUT_MS = 1000 * 60 * 2,
    ROOT,
    RUNS_DIR,
    SOURCE_CODEX_HOME,
    SQLITE_BACKED_STATE_KEYS,
    STATE_DB_FILE,
    STATE_FILE,
    USE_SQLITE_STATE = true,
    WRITE_STATE_JSON = false,
  } = deps;

  let state = null;
  let saveChain = Promise.resolve();
  let stateDb = null;
  let externalStatePersister = null;
  const LOCAL_STATE_PERSISTENCE_ENABLED = USE_SQLITE_STATE || WRITE_STATE_JSON;
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
        fanoutApi: normalizeFanoutApiConfig({}),
        chatRuntime: normalizeChatRuntimeConfig({
          enabled: process.env.MAGCLAW_CHAT_FAST_RUNTIME !== '0',
          model: process.env.MAGCLAW_CHAT_MODEL || process.env.MAGCLAW_FAST_CHAT_MODEL || '',
          reasoningEffort: process.env.MAGCLAW_CHAT_REASONING || 'low',
        }),
      },
      releaseNotes: defaultReleaseNotes({ root: ROOT }),
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
        passwordResetTokens: [],
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
          daemonVersion: '',
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
      reminders: [],
      missions: [],
      runs: [],
      attachments: [],
      projects: [],
      workItems: [],
        routeEvents: [],
        events: [],
        systemNotifications: [],
        inboxReads: {},
      };
    }
  
  async function ensureStorage() {
    await mkdir(ATTACHMENTS_DIR, { recursive: true });
    await mkdir(RUNS_DIR, { recursive: true });
    await mkdir(AGENTS_DIR, { recursive: true });
    await initializeStateDatabase();

    if (!LOCAL_STATE_PERSISTENCE_ENABLED) {
      state = defaultState();
      migrateState();
      await ensureAllAgentWorkspaces();
      return;
    }
  
    const sqliteSnapshot = readSqliteStateSnapshot();
    if (sqliteSnapshot) {
      state = sqliteSnapshot;
      migrateState();
      hydrateSqliteBackedState();
      migrateState();
      await ensureAllAgentWorkspaces();
      await persistState({ skipExternal: true });
      return;
    }

    if (!existsSync(STATE_FILE)) {
      state = defaultState();
      migrateState();
      await ensureAllAgentWorkspaces();
      await persistState({ skipExternal: true });
      return;
    }
  
    try {
      state = JSON.parse(await readFile(STATE_FILE, 'utf8'));
      migrateState();
      migrateJsonBackedStateToSqlite();
      hydrateSqliteBackedState();
      migrateState();
      await ensureAllAgentWorkspaces();
      await persistState({ skipExternal: true });
    } catch {
      state = defaultState();
      migrateState();
      addSystemEvent('state_recovered', 'State file was unreadable, Magclaw started with a clean state.');
      await ensureAllAgentWorkspaces();
      await persistState({ skipExternal: true });
    }
  }
  
  async function initializeStateDatabase() {
    if (!USE_SQLITE_STATE) {
      stateDb = null;
      return;
    }
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

  function readSqliteStateSnapshot() {
    if (!sqliteBackedStateEnabled()) return null;
    const row = stateDb.prepare('SELECT payload FROM state_records WHERE kind = ? AND id = ?').get('__state', 'snapshot');
    if (!row?.payload) return null;
    try {
      return JSON.parse(row.payload);
    } catch (error) {
      console.warn(`SQLite state snapshot was unreadable; trying legacy state sources: ${error.message}`);
      return null;
    }
  }

  function writeSqliteStateSnapshot() {
    if (!sqliteBackedStateEnabled() || !state) return;
    const snapshot = JSON.stringify(stateFullSnapshot());
    stateDb.prepare(`
      INSERT INTO state_records (kind, id, position, created_at, updated_at, payload)
      VALUES ('__state', 'snapshot', 0, ?, ?, ?)
      ON CONFLICT(kind, id) DO UPDATE SET
        updated_at = excluded.updated_at,
        payload = excluded.payload
    `).run(state.createdAt || now(), state.updatedAt || now(), snapshot);
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
    state.releaseNotes = normalizeReleaseNotes(state.releaseNotes, fresh.releaseNotes);
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
    for (const workspace of state.cloud.workspaces) {
      workspace.updatedAt = workspace.updatedAt || workspace.createdAt || now();
      if (!workspace.ownerUserId) {
        const ownerMember = state.cloud.workspaceMembers
          .filter((member) => member.workspaceId === workspace.id && member.status !== 'removed' && member.role === 'admin')
          .sort((a, b) => Date.parse(a.joinedAt || a.createdAt || 0) - Date.parse(b.joinedAt || b.createdAt || 0))[0];
        if (ownerMember?.userId) workspace.ownerUserId = ownerMember.userId;
      }
    }
      const roleMap = {
        owner: 'admin',
        viewer: 'member',
        [['agent', 'admin'].join('_')]: 'admin',
        [['computer', 'admin'].join('_')]: 'admin',
      };
      for (const member of state.cloud.workspaceMembers) {
        member.role = roleMap[member.role] || member.role || 'member';
      }
      for (const invitation of state.cloud.invitations) {
        invitation.role = roleMap[invitation.role] || invitation.role || 'member';
      }
      for (const key of ['humans', 'computers', 'agents', 'channels', 'dms', 'messages', 'replies', 'tasks', 'reminders', 'missions', 'runs', 'attachments', 'projects', 'workItems', 'routeEvents', 'events', 'systemNotifications']) {
        if (!Array.isArray(state[key])) state[key] = fresh[key] || [];
      }
    state.inboxReads = state.inboxReads && typeof state.inboxReads === 'object' && !Array.isArray(state.inboxReads)
      ? state.inboxReads
      : {};
    for (const [humanId, readState] of Object.entries(state.inboxReads)) {
      if (!readState || typeof readState !== 'object' || Array.isArray(readState)) {
        delete state.inboxReads[humanId];
        continue;
      }
      readState.workspaceActivityReadAt = readState.workspaceActivityReadAt || null;
      readState.updatedAt = readState.updatedAt || readState.workspaceActivityReadAt || now();
    }
    delete state.brainAgents;
    if (!state.humans.length) state.humans = fresh.humans;
      for (const human of state.humans) {
        human.role = roleMap[human.role] || human.role || 'member';
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
    for (const reminder of state.reminders) {
      reminder.id = reminder.id || makeId('rem');
      reminder.title = String(reminder.title || reminder.body || 'Reminder').trim().slice(0, 180);
      reminder.body = String(reminder.body || '').trim();
      reminder.status = ['scheduled', 'fired', 'canceled'].includes(reminder.status) ? reminder.status : 'scheduled';
      reminder.spaceType = reminder.spaceType === 'dm' ? 'dm' : 'channel';
      reminder.spaceId = reminder.spaceId
        || (reminder.spaceType === 'dm' ? state.dms?.[0]?.id : state.channels?.[0]?.id)
        || 'chan_all';
      reminder.parentMessageId = reminder.parentMessageId || reminder.threadMessageId || null;
      reminder.sourceMessageId = reminder.sourceMessageId || reminder.messageId || reminder.parentMessageId || null;
      reminder.ownerAgentId = reminder.ownerAgentId || reminder.agentId || reminder.createdBy || null;
      reminder.createdBy = reminder.createdBy || reminder.ownerAgentId || null;
      reminder.createdAt = reminder.createdAt || now();
      reminder.updatedAt = reminder.updatedAt || reminder.createdAt;
      reminder.fireAt = reminder.fireAt || reminder.scheduledFor || reminder.createdAt;
      reminder.repeat = reminder.repeat || null;
      reminder.firedAt = reminder.firedAt || null;
      reminder.canceledAt = reminder.canceledAt || null;
      reminder.history = Array.isArray(reminder.history) ? reminder.history : [];
      reminder.target = reminder.target || targetForConversation(reminder.spaceType, reminder.spaceId, reminder.parentMessageId);
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
      if (computer.disabledAt) computer.status = 'disabled';
    }
  }
  
  function persistState(options = {}) {
    if (!state) return Promise.resolve();
    state.updatedAt = now();
    saveChain = saveChain.then(async () => {
      syncSqliteBackedState();
      writeSqliteStateSnapshot();
      if (WRITE_STATE_JSON || (!sqliteBackedStateEnabled() && LOCAL_STATE_PERSISTENCE_ENABLED)) {
        const payload = JSON.stringify(stateJsonSnapshot(), null, 2);
        const tmp = `${STATE_FILE}.tmp`;
        await writeFile(tmp, payload);
        await rename(tmp, STATE_FILE);
      }
      if (!options.skipExternal && externalStatePersister) {
        await externalStatePersister(stateFullSnapshot());
      }
    });
    return saveChain;
  }

  function decoratedSnapshot({ thinSqliteArrays = false } = {}) {
    const snapshot = {
      ...state,
      storage: {
        ...(state.storage || {}),
        sqliteEnabled: sqliteBackedStateEnabled(),
        sqliteFile: path.basename(STATE_DB_FILE),
        sqliteBackedKeys: SQLITE_BACKED_STATE_KEYS,
        jsonSnapshotEnabled: WRITE_STATE_JSON,
        localPersistence: sqliteBackedStateEnabled() ? 'sqlite' : (WRITE_STATE_JSON ? 'json' : 'memory'),
      },
    };
    if (thinSqliteArrays && sqliteBackedStateEnabled()) {
      for (const key of SQLITE_BACKED_STATE_KEYS) snapshot[key] = [];
    }
    return snapshot;
  }

  function stateFullSnapshot() {
    return decoratedSnapshot({ thinSqliteArrays: false });
  }

  function stateJsonSnapshot() {
    return decoratedSnapshot({ thinSqliteArrays: true });
  }

  function setExternalStatePersister(persister) {
    externalStatePersister = typeof persister === 'function' ? persister : null;
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

  function expectedStreamClose(error) {
    const code = String(error?.code || error?.errno || '');
    return code === 'ECONNRESET' || code === 'EPIPE' || code === 'ERR_STREAM_PREMATURE_CLOSE';
  }
  
  function broadcast(type, payload) {
    for (const res of sseClients) {
      const body = typeof payload === 'function' ? payload(res.magclawRequest || null) : payload;
      const packet = `event: ${type}\ndata: ${JSON.stringify(body)}\n\n`;
      try {
        res.write(packet);
      } catch (error) {
        sseClients.delete(res);
        if (!expectedStreamClose(error)) {
          const code = String(error?.code || error?.errno || 'UNKNOWN');
          const message = String(error?.message || error || 'SSE broadcast error').replace(/\s+/g, ' ').slice(0, 300);
          console.warn(`[state-core] sse broadcast error code=${code} message=${message}`);
        }
      }
    }
  }
  
  function broadcastState() {
    broadcast('state', (req) => publicState(req));
    broadcastHeartbeat();
    queueCloudPush('state_changed');
  }
  
  function presenceHeartbeat() {
    const humanCutoff = Date.now() - HUMAN_PRESENCE_TIMEOUT_MS;
    const humanPresence = (human) => {
      const status = String(human?.status || 'offline').toLowerCase();
      if (status !== 'online') return status || 'offline';
      const seenAt = Date.parse(human.lastSeenAt || human.presenceUpdatedAt || human.updatedAt || human.createdAt || '');
      return seenAt && seenAt >= humanCutoff ? 'online' : 'offline';
    };
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
      humans: (state?.humans || []).map((human) => ({
        id: human.id,
        name: human.name,
        status: humanPresence(human),
        lastSeenAt: human.lastSeenAt || null,
        presenceUpdatedAt: human.presenceUpdatedAt || null,
      })),
    };
  }
  
  function broadcastHeartbeat() {
    broadcast('heartbeat', presenceHeartbeat());
  }
  
  function agentStatusIsBusy(status) {
    return ['starting', 'thinking', 'working', 'running', 'busy', 'queued', 'warming'].includes(String(status || '').toLowerCase());
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
    setExternalStatePersister,
    setAgentStatus,
    state: stateProxy,
    stateFullSnapshot,
    stateJsonSnapshot,
  };
}
