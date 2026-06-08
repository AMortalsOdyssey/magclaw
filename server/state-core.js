import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createActivityLog } from './activity-log.js';
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
    publicStateForSse = publicState,
    queueCloudPush,
    sseClients,
    targetForConversation,
    taskScopeKey,
    AGENT_BOOT_RESET_STATUSES,
    AGENT_STATUS_STALE_MS,
    AGENTS_DIR,
    ACTIVITY_LOG_DIR = '',
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
    STATE_BROADCAST_DEBOUNCE_MS = 80,
    USE_SQLITE_STATE = true,
    WRITE_STATE_JSON = false,
  } = deps;

  let state = null;
  let saveChain = Promise.resolve();
  let stateDb = null;
  let externalStatePersister = null;
  let stateBroadcastTimer = null;
  let sseSeq = 0;
  const stateBroadcastDebounceMs = (() => {
    const parsed = Number(STATE_BROADCAST_DEBOUNCE_MS);
    return Number.isFinite(parsed) ? Math.min(1000, Math.max(0, parsed)) : 80;
  })();
  const activityLog = createActivityLog({
    dir: ACTIVITY_LOG_DIR || path.join(ROOT, 'activity-logs'),
    now,
  });
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
        sandbox: process.env.CODEX_SANDBOX || 'danger-full-access',
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
        realtimeEvents: [],
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
          reactions: [],
          followedBy: [],
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
      channelMemberProposals: [],
      agentRuntimeSessions: [],
      conversationGrants: [],
      workItems: [],
        routeEvents: [],
        events: [],
        systemNotifications: [],
        inboxReads: {},
      };
    }

  async function mergeActivityTail() {
    if (!state) return;
    const tail = await activityLog.readTail(1200).catch((error) => {
      console.warn(`[activity-log] startup tail read failed: ${error.message}`);
      return [];
    });
    if (!tail.length) return;
    const seen = new Set((Array.isArray(state.events) ? state.events : []).map((event) => event?.id).filter(Boolean));
    const restored = tail.filter((event) => event?.id && !seen.has(event.id));
    if (!restored.length) return;
    state.events = [...(Array.isArray(state.events) ? state.events : []), ...restored]
      .sort((a, b) => {
        const left = Date.parse(a.createdAt || '');
        const right = Date.parse(b.createdAt || '');
        if (Number.isFinite(left) && Number.isFinite(right) && left !== right) return left - right;
        return String(a.id || '').localeCompare(String(b.id || ''));
      });
    trimEvents();
  }
  
  async function ensureStorage() {
    await mkdir(ATTACHMENTS_DIR, { recursive: true });
    await mkdir(RUNS_DIR, { recursive: true });
    await mkdir(AGENTS_DIR, { recursive: true });
    await initializeStateDatabase();

    if (!LOCAL_STATE_PERSISTENCE_ENABLED) {
      state = defaultState();
      migrateState();
      await mergeActivityTail();
      await ensureAllAgentWorkspaces();
      return;
    }
  
    const sqliteSnapshot = readSqliteStateSnapshot();
    if (sqliteSnapshot) {
      state = sqliteSnapshot;
      migrateState();
      hydrateSqliteBackedState();
      migrateState();
      await mergeActivityTail();
      await ensureAllAgentWorkspaces();
      await persistState({ skipExternal: true });
      return;
    }

    if (!existsSync(STATE_FILE)) {
      state = defaultState();
      migrateState();
      await mergeActivityTail();
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
      await mergeActivityTail();
      await ensureAllAgentWorkspaces();
      await persistState({ skipExternal: true });
    } catch {
      state = defaultState();
      migrateState();
      addSystemEvent('state_recovered', 'State file was unreadable, Magclaw started with a clean state.');
      await mergeActivityTail();
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
    for (const key of ['workspaces', 'workspaceMembers', 'users', 'sessions', 'invitations', 'pairingTokens', 'computerTokens', 'agentDeliveries', 'daemonEvents', 'realtimeEvents']) {
      if (!Array.isArray(state.cloud[key])) state.cloud[key] = fresh.cloud[key] || [];
    }
    if (!state.cloud.workspaces.length) state.cloud.workspaces = fresh.cloud.workspaces;
    for (const workspace of state.cloud.workspaces) {
      workspace.updatedAt = workspace.updatedAt || workspace.createdAt || now();
    }
      const roleMap = {
        owner: 'owner',
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
      for (const workspace of state.cloud.workspaces) {
        const activeMembers = state.cloud.workspaceMembers
          .filter((member) => member.workspaceId === workspace.id && member.status !== 'removed');
        let owners = activeMembers.filter((member) => member.role === 'owner');
        if (!owners.length) {
          const promotedOwner = activeMembers.find((member) => workspace.ownerUserId && member.userId === workspace.ownerUserId)
            || activeMembers
              .filter((member) => member.role === 'admin')
              .sort((a, b) => Date.parse(a.joinedAt || a.createdAt || 0) - Date.parse(b.joinedAt || b.createdAt || 0))[0];
          if (promotedOwner) {
            promotedOwner.role = 'owner';
            promotedOwner.updatedAt = promotedOwner.updatedAt || workspace.updatedAt;
            owners = [promotedOwner];
          }
        }
        if (!workspace.ownerUserId && owners[0]?.userId) workspace.ownerUserId = owners[0].userId;
      }
      for (const key of ['humans', 'computers', 'agents', 'channels', 'dms', 'messages', 'replies', 'tasks', 'reminders', 'missions', 'runs', 'attachments', 'projects', 'channelMemberProposals', 'agentRuntimeSessions', 'conversationGrants', 'workItems', 'routeEvents', 'events', 'systemNotifications']) {
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
      for (const member of state.cloud.workspaceMembers) {
        if (member.role !== 'owner') continue;
        const human = state.humans.find((item) => item.id === member.humanId);
        if (human) human.role = 'owner';
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
    for (const session of state.agentRuntimeSessions) {
      session.id = session.id || makeId('ars');
      session.workspaceId = session.workspaceId || state.connection?.workspaceId || 'local';
      session.agentId = session.agentId || null;
      session.computerId = session.computerId || null;
      session.sessionKey = session.sessionKey || null;
      session.target = session.target || targetForConversation(session.spaceType, session.spaceId, session.parentMessageId || null);
      session.spaceType = session.spaceType === 'dm' ? 'dm' : 'channel';
      session.spaceId = session.spaceId || '';
      session.parentMessageId = session.parentMessageId || null;
      session.codexThreadId = session.codexThreadId || null;
      session.status = session.status || 'idle';
      session.activeTurnIds = normalizeIds(session.activeTurnIds || []);
      session.activeTargetKeys = normalizeIds(session.activeTargetKeys || []);
      session.lastTurnAt = session.lastTurnAt || null;
      session.createdAt = session.createdAt || now();
      session.updatedAt = session.updatedAt || session.createdAt;
      session.metadata = session.metadata && typeof session.metadata === 'object' ? session.metadata : {};
    }
    for (const grant of state.conversationGrants) {
      grant.id = grant.id || makeId('grant');
      grant.workspaceId = grant.workspaceId || state.connection?.workspaceId || 'local';
      grant.grantorHumanId = grant.grantorHumanId || grant.humanId || null;
      grant.agentId = grant.agentId || null;
      grant.sourceTarget = grant.sourceTarget || '';
      grant.allowedRecipients = normalizeIds(grant.allowedRecipients || grant.allowedRecipientIds || []);
      grant.allowedTargets = normalizeIds(grant.allowedTargets || []);
      grant.actions = normalizeIds(grant.actions?.length ? grant.actions : ['read', 'summarize']);
      grant.status = grant.revokedAt ? 'revoked' : (grant.status || 'active');
      grant.sourceMessageId = grant.sourceMessageId || null;
      grant.scopeText = String(grant.scopeText || grant.sourceText || '').trim();
      grant.createdAt = grant.createdAt || now();
      grant.updatedAt = grant.updatedAt || null;
      grant.revokedAt = grant.revokedAt || null;
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
        const closedAt = task.closedAt || task.stoppedAt || task.updatedAt || task.createdAt || now();
        task.status = 'closed';
        task.closedAt = closedAt;
        task.endIntentAt = task.endIntentAt || closedAt;
        task.reviewRequestedAt = null;
      }
      if (!['todo', 'in_progress', 'in_review', 'done', 'closed'].includes(task.status)) task.status = 'todo';
      task.endIntentAt = task.endIntentAt || null;
      task.closedAt = task.closedAt || null;
      task.runIds = Array.isArray(task.runIds) ? task.runIds : [];
      task.localReferences = Array.isArray(task.localReferences) ? task.localReferences : extractLocalReferences(task.body || '');
    }
    for (const proposal of state.channelMemberProposals) {
      proposal.id = proposal.id || makeId('prop');
      proposal.workspaceId = proposal.workspaceId || state.connection?.workspaceId || 'local';
      proposal.channelId = proposal.channelId || proposal.spaceId || null;
      proposal.memberIds = normalizeIds(proposal.memberIds || (proposal.memberId ? [proposal.memberId] : []));
      proposal.proposedBy = proposal.proposedBy || proposal.agentId || null;
      proposal.reason = String(proposal.reason || '').trim();
      proposal.status = ['pending', 'accepted', 'declined'].includes(proposal.status) ? proposal.status : 'pending';
      proposal.reviewerId = proposal.reviewerId || null;
      proposal.createdAt = proposal.createdAt || now();
      proposal.updatedAt = proposal.updatedAt || proposal.createdAt;
      proposal.reviewedAt = proposal.reviewedAt || null;
      proposal.acceptedAt = proposal.acceptedAt || null;
      proposal.declinedAt = proposal.declinedAt || null;
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
      agent.activitySeq = Math.max(0, Math.floor(Number(agent.activitySeq || 0)) || 0);
      agent.activityAt = agent.activityAt || agent.runtimeActivity?.updatedAt || agent.heartbeatAt || null;
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
      if (['connected', 'upgrade_pending', 'upgrading', 'restarting', 'rollback'].includes(String(computer.status || '').toLowerCase()) && String(computer.connectedVia || '').toLowerCase() === 'daemon') {
        computer.status = 'offline';
        computer.disconnectedAt = computer.disconnectedAt || now();
      }
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
        const workspaceId = options.workspaceId || state.connection?.workspaceId || state.cloud?.workspace?.id || '';
        const externalWrite = Promise.resolve()
          .then(() => externalStatePersister(stateFullSnapshot(), { ...options, workspaceId }));
        const shouldAwaitExternal = options.awaitExternal === true
          || (!LOCAL_STATE_PERSISTENCE_ENABLED && options.awaitExternal !== false);
        if (shouldAwaitExternal) {
          await externalWrite;
        } else {
          externalWrite.catch((error) => {
            console.error('[state] background external persist failed', error);
          });
        }
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
  
  function addSystemEvent(type, message, extra = {}, options = {}) {
    if (!state) return;
    const event = {
      id: makeId('evt'),
      type,
      message,
      createdAt: now(),
      ...extra,
    };
    state.events.push(event);
    trimEvents();
    activityLog.append(event).catch(() => {});
    if (!options.skipRealtime) recordRealtimeEvent('system_event', { event }, extra);
    return event;
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
    activityLog.append(event).catch(() => {});
    recordRealtimeEvent('run_event', { event }, { workspaceId: event.workspaceId, scopeType: 'workspace' });
    broadcast('run-event', event);
    return event;
  }
  
  function trimEvents() {
    if (state.events.length > 1200) {
      state.events = state.events.slice(state.events.length - 1200);
    }
  }

  function eventAgentId(event = {}) {
    return String(event.agentId || event.meta?.agentId || event.raw?.agentId || event.activity?.agentId || '');
  }

  function eventCreatedMs(event = {}) {
    const value = Date.parse(event.createdAt || '');
    return Number.isFinite(value) ? value : 0;
  }

  function parseActivityLimit(value, fallback = 5000) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(5000, Math.max(1, Math.trunc(parsed)));
  }

  function parseActivityDays(value, fallback = 7) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(30, Math.max(1, Math.trunc(parsed)));
  }

  async function agentActivityWindow(agentId, options = {}) {
    const cleanAgentId = String(agentId || '').trim();
    const limit = parseActivityLimit(options.limit);
    const days = parseActivityDays(options.days);
    const parsedEnd = Date.parse(options.before || '');
    const windowEndDate = Number.isFinite(parsedEnd) ? new Date(parsedEnd) : new Date(now());
    const windowStartDate = new Date(windowEndDate.getTime() - days * 24 * 60 * 60 * 1000);
    const windowStart = windowStartDate.toISOString();
    const windowEnd = windowEndDate.toISOString();
    const logRecords = await activityLog.readWindow({
      start: windowStart,
      end: windowEnd,
      limit: limit + 1,
    }).catch((error) => {
      console.warn(`[activity-log] agent activity read failed: ${error.message}`);
      return [];
    });
    const inWindow = (event) => {
      const created = eventCreatedMs(event);
      return created >= windowStartDate.getTime() && created <= windowEndDate.getTime();
    };
    const sameAgent = (event) => eventAgentId(event) === cleanAgentId;
    const recordsById = new Map();
    for (const event of logRecords.filter((item) => sameAgent(item) && inWindow(item))) {
      if (event?.id) recordsById.set(event.id, event);
    }
    for (const event of (Array.isArray(state?.events) ? state.events : []).filter((item) => sameAgent(item) && inWindow(item))) {
      if (event?.id) recordsById.set(event.id, event);
    }
    const events = [...recordsById.values()]
      .sort((a, b) => eventCreatedMs(b) - eventCreatedMs(a) || String(b.id || '').localeCompare(String(a.id || '')));
    const visible = events.slice(0, limit);
    return {
      agentId: cleanAgentId,
      events: visible,
      hasMore: events.length > limit,
      nextBefore: events.length > limit ? (visible.at(-1)?.createdAt || '') : '',
      windowStart,
      windowEnd,
    };
  }

  function primaryWorkspaceId() {
    return state?.connection?.workspaceId
      || state?.cloud?.workspaces?.[0]?.id
      || 'local';
  }

  function nextRealtimeSeq(workspaceId = primaryWorkspaceId()) {
    const maxSeq = (state?.cloud?.realtimeEvents || [])
      .filter((event) => (event.workspaceId || primaryWorkspaceId()) === workspaceId)
      .reduce((max, event) => Math.max(max, Number(event.seq || 0)), 0);
    return maxSeq + 1;
  }

  function currentRealtimeSeq(workspaceId = primaryWorkspaceId()) {
    return (state?.cloud?.realtimeEvents || [])
      .filter((event) => (event.workspaceId || primaryWorkspaceId()) === workspaceId)
      .reduce((max, event) => Math.max(max, Number(event.seq || 0)), 0);
  }

  function realtimeScopeFromPayload(payload = {}, scope = {}) {
    if (scope.scopeType) return scope;
    const threadMessageId = scope.threadMessageId || payload.threadMessageId || payload.parentMessageId || '';
    if (threadMessageId) {
      return {
        scopeType: 'thread',
        scopeId: String(threadMessageId),
        threadMessageId: String(threadMessageId),
      };
    }
    const spaceType = scope.spaceType || payload.spaceType || '';
    const spaceId = scope.spaceId || payload.spaceId || '';
    if (spaceType && spaceId) {
      return {
        scopeType: String(spaceType),
        scopeId: String(spaceId),
        threadMessageId: null,
      };
    }
    return {
      scopeType: 'workspace',
      scopeId: scope.scopeId || payload.workspaceId || '',
      threadMessageId: scope.threadMessageId || null,
    };
  }

  function trimRealtimeEvents(workspaceId) {
    if (!state?.cloud) return;
    const all = Array.isArray(state.cloud.realtimeEvents) ? state.cloud.realtimeEvents : [];
    const scoped = all
      .filter((event) => event.workspaceId === workspaceId)
      .sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
    const overflow = Math.max(0, scoped.length - 2000);
    if (!overflow) return;
    const drop = new Set(scoped.slice(0, overflow).map((event) => event.id));
    state.cloud.realtimeEvents = all.filter((event) => !drop.has(event.id));
  }

  const REALTIME_BROADCAST_EVENT_TYPES = new Set([
    'agent_activity_changed',
    'agent_status_changed',
    'system_event',
    'run_event',
    'unread_counts_invalidated',
    'unread_counts_updated',
  ]);

  function recordRealtimeEvent(eventType, payload = {}, scope = {}) {
    if (!state?.cloud) return null;
    state.cloud.realtimeEvents = Array.isArray(state.cloud.realtimeEvents) ? state.cloud.realtimeEvents : [];
    const workspaceId = scope.workspaceId || payload.workspaceId || primaryWorkspaceId();
    const resolvedScope = realtimeScopeFromPayload(payload, scope);
    const event = {
      id: makeId('rte'),
      workspaceId,
      seq: nextRealtimeSeq(workspaceId),
      eventType: String(eventType || 'event'),
      scopeType: resolvedScope.scopeType || 'workspace',
      scopeId: resolvedScope.scopeId || '',
      threadMessageId: resolvedScope.threadMessageId || null,
      payload,
      createdAt: now(),
    };
    state.cloud.realtimeEvents.push(event);
    trimRealtimeEvents(workspaceId);
    if (REALTIME_BROADCAST_EVENT_TYPES.has(event.eventType)) {
      broadcastRealtimeEvent(event);
    }
    return event;
  }

  function requestRealtimeScope(req = null) {
    const url = new URL(req?.url || '/api/events', 'http://127.0.0.1');
    return {
      spaceType: url.searchParams.get('spaceType') || '',
      spaceId: url.searchParams.get('spaceId') || '',
      threadMessageId: url.searchParams.get('threadMessageId') || '',
    };
  }

  function realtimeEventMatchesRequest(event, req = null) {
    const requestScope = requestRealtimeScope(req);
    if (!requestScope.spaceType && !requestScope.spaceId && !requestScope.threadMessageId) return true;
    if (event.scopeType === 'workspace' || event.scopeType === 'agent') return true;
    if (requestScope.threadMessageId && event.threadMessageId === requestScope.threadMessageId) return true;
    if (requestScope.threadMessageId && event.scopeType === 'thread' && event.scopeId === requestScope.threadMessageId) return true;
    if (requestScope.spaceType && requestScope.spaceId) {
      return event.scopeType === requestScope.spaceType && event.scopeId === requestScope.spaceId;
    }
    return false;
  }

  function realtimeEventEnvelope(event) {
    return {
      seq: Number(event.seq || 0),
      type: 'realtime_event',
      eventType: event.eventType || event.event_type || '',
      scopeType: event.scopeType || 'workspace',
      scopeId: event.scopeId || '',
      threadMessageId: event.threadMessageId || null,
      createdAt: event.createdAt || now(),
      payload: event.payload || {},
    };
  }

  function realtimeEventsForRequest(req = null, lastSeqInput = 0) {
    const workspaceId = primaryWorkspaceId();
    const lastSeq = Number(lastSeqInput || 0);
    const all = (state?.cloud?.realtimeEvents || [])
      .filter((event) => (event.workspaceId || workspaceId) === workspaceId)
      .sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
    const minSeq = all.length ? Number(all[0].seq || 0) : 0;
    const currentSeq = currentRealtimeSeq(workspaceId);
    const gap = Boolean(lastSeq > 0 && minSeq > 0 && lastSeq < minSeq - 1);
    if (gap) return { gap: true, minSeq, currentSeq, events: [] };
    return {
      gap: false,
      minSeq,
      currentSeq,
      events: all
        .filter((event) => Number(event.seq || 0) > lastSeq)
        .filter((event) => realtimeEventMatchesRequest(event, req))
        .map(realtimeEventEnvelope),
    };
  }

  function expectedStreamClose(error) {
    const code = String(error?.code || error?.errno || '');
    return code === 'ECONNRESET' || code === 'EPIPE' || code === 'ERR_STREAM_PREMATURE_CLOSE';
  }

  function logSseWriteError(error) {
    if (expectedStreamClose(error)) return;
    const code = String(error?.code || error?.errno || 'UNKNOWN');
    const message = String(error?.message || error || 'SSE broadcast error').replace(/\s+/g, ' ').slice(0, 300);
    console.warn(`[state-core] sse broadcast error code=${code} message=${message}`);
  }

  function ssePacket(type, body) {
    return `event: ${type}\ndata: ${JSON.stringify(body)}\n\n`;
  }

  function sseComment(comment = 'keepalive') {
    return `: ${String(comment || 'keepalive').replace(/[\r\n]+/g, ' ')}\n\n`;
  }

  function ensureSseDrainHandler(res) {
    if (res.magclawSseDrainAttached || typeof res.once !== 'function') return;
    res.magclawSseDrainAttached = true;
    res.once('drain', () => {
      res.magclawSseDrainAttached = false;
      flushPendingSsePackets(res);
    });
  }

  function queuePendingSsePacket(res, packet, coalesceKey) {
    res.magclawPendingSsePackets = res.magclawPendingSsePackets instanceof Map
      ? res.magclawPendingSsePackets
      : new Map();
    res.magclawPendingSsePackets.set(String(coalesceKey || 'packet'), packet);
    res.magclawSseBackpressure = true;
    ensureSseDrainHandler(res);
  }

  function writeSsePacket(res, packet, { coalesceKey = 'packet' } = {}) {
    if (!res || typeof res.write !== 'function') return;
    if (res.magclawSseBackpressure || res.writableNeedDrain) {
      queuePendingSsePacket(res, packet, coalesceKey);
      return;
    }
    try {
      const accepted = res.write(packet);
      if (accepted === false) {
        res.magclawSseBackpressure = true;
        ensureSseDrainHandler(res);
      }
    } catch (error) {
      res.magclawPendingSsePackets?.clear?.();
      sseClients.delete(res);
      logSseWriteError(error);
    }
  }

  function flushPendingSsePackets(res) {
    const pending = res?.magclawPendingSsePackets;
    if (!(pending instanceof Map) || !pending.size) {
      if (res) res.magclawSseBackpressure = false;
      return;
    }
    const entries = [...pending.entries()];
    pending.clear();
    res.magclawSseBackpressure = false;
    for (let index = 0; index < entries.length; index += 1) {
      const [coalesceKey, packet] = entries[index];
      writeSsePacket(res, packet, { coalesceKey });
      if (res.magclawSseBackpressure || res.writableNeedDrain) {
        const remaining = entries.slice(index + 1);
        for (const [key, queuedPacket] of remaining) queuePendingSsePacket(res, queuedPacket, key);
        break;
      }
    }
  }

  function broadcastRealtimeEvent(event) {
    if (!sseClients.size) return;
    const envelope = realtimeEventEnvelope(event);
    const packet = ssePacket('realtime-event', envelope);
    const coalesceKey = `realtime-event:${envelope.eventType}:${envelope.scopeType}:${envelope.scopeId || ''}`;
    for (const res of sseClients) {
      if (!realtimeEventMatchesRequest(event, res.magclawRequest || null)) continue;
      writeSsePacket(res, packet, { coalesceKey });
    }
  }
  
  function broadcast(type, payload) {
    for (const res of sseClients) {
      const body = typeof payload === 'function' ? payload(res.magclawRequest || null) : payload;
      writeSsePacket(res, ssePacket(type, body), { coalesceKey: type });
    }
  }

  function nextSseSeq() {
    sseSeq += 1;
    return sseSeq;
  }

  function currentSseSeq() {
    sseSeq = Math.max(sseSeq, currentRealtimeSeq(primaryWorkspaceId()));
    return sseSeq;
  }

  function stateResyncEnvelope(seq = currentSseSeq(), reason = 'state_changed') {
    return {
      seq,
      type: 'state_resync_required',
      reason,
      currentSeq: seq,
      createdAt: now(),
    };
  }

  function broadcastStateDelta() {
    const seq = currentSseSeq();
    const packet = ssePacket('state-resync-required', stateResyncEnvelope(seq));
    for (const res of sseClients) {
      writeSsePacket(res, packet, { coalesceKey: 'state-resync-required' });
    }
  }

  function flushStateBroadcast() {
    if (stateBroadcastTimer) {
      clearTimeout(stateBroadcastTimer);
      stateBroadcastTimer = null;
    }
    if (!sseClients.size) return;
    broadcastStateDelta();
  }

  function scheduleStateBroadcast(options = {}) {
    if (!sseClients.size) return;
    if (options.immediate || stateBroadcastDebounceMs <= 0) {
      flushStateBroadcast();
      return;
    }
    if (stateBroadcastTimer) return;
    stateBroadcastTimer = setTimeout(() => {
      stateBroadcastTimer = null;
      flushStateBroadcast();
    }, stateBroadcastDebounceMs);
    stateBroadcastTimer.unref?.();
  }

  function broadcastState(options = {}) {
    if (!options.realtimeOnly) scheduleStateBroadcast(options);
    if (!options.skipCloudPush) queueCloudPush('state_changed');
  }

  function presenceHeartbeat(req = null) {
    const workspaceId = String(
      req?.magclawPresenceWorkspaceId
      || req?.daemonAuth?.workspaceId
      || state?.connection?.workspaceId
      || state?.cloud?.workspace?.id
      || '',
    ).trim();
    const workspaceMatches = (record) => {
      if (!workspaceId) return true;
      const recordWorkspaceId = String(record?.workspaceId || '').trim();
      return !recordWorkspaceId || recordWorkspaceId === workspaceId;
    };
    const humanCutoff = Date.now() - HUMAN_PRESENCE_TIMEOUT_MS;
    const humanPresence = (human) => {
      const status = String(human?.status || 'offline').toLowerCase();
      if (status !== 'online') return status || 'offline';
      const seenAt = Date.parse(human.lastSeenAt || human.presenceUpdatedAt || human.updatedAt || human.createdAt || '');
      return seenAt && seenAt >= humanCutoff ? 'online' : 'offline';
    };
    const compact = (entry) => Object.fromEntries(Object.entries(entry).filter(([_key, value]) => {
      if (value === undefined || value === null || value === '') return false;
      if (Array.isArray(value) && value.length === 0) return false;
      if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return false;
      return true;
    }));
    return {
      createdAt: now(),
      updatedAt: state?.updatedAt || null,
      agents: (state?.agents || []).filter(workspaceMatches).map((agent) => compact({
        id: agent.id,
        status: agent.status || 'offline',
        runtimeLastStartedAt: agent.runtimeLastStartedAt || null,
        runtimeLastTurnAt: agent.runtimeLastTurnAt || null,
        runtimeWarmAt: agent.runtimeWarmAt || null,
        runtimeActivity: agent.runtimeActivity || null,
        activitySeq: Number(agent.activitySeq || 0) || null,
        activityAt: agent.activityAt || null,
      })),
      humans: (state?.humans || []).filter(workspaceMatches).map((human) => compact({
        id: human.id,
        status: humanPresence(human),
        lastSeenAt: human.lastSeenAt || null,
        presenceUpdatedAt: human.presenceUpdatedAt || null,
      })),
    };
  }

  function presenceWorkspaceIdForRequest(req = null) {
    return String(
      req?.magclawPresenceWorkspaceId
      || req?.daemonAuth?.workspaceId
      || state?.connection?.workspaceId
      || state?.cloud?.workspace?.id
      || '',
    ).trim();
  }

  function presenceHeartbeatSignature(heartbeat = {}) {
    return JSON.stringify({
      agents: heartbeat.agents || [],
      humans: heartbeat.humans || [],
    });
  }

  function writePresenceHeartbeatPacket(res, entry, { force = false, seedOnly = false } = {}) {
    if (!res || !entry) return false;
    if (seedOnly) {
      res.magclawPresenceHeartbeatSignature = entry.signature;
      writeSsePacket(res, entry.keepalivePacket, { coalesceKey: 'heartbeat-keepalive' });
      return false;
    }
    if (!force && res.magclawPresenceHeartbeatSignature === entry.signature) {
      writeSsePacket(res, entry.keepalivePacket, { coalesceKey: 'heartbeat-keepalive' });
      return false;
    }
    res.magclawPresenceHeartbeatSignature = entry.signature;
    writeSsePacket(res, entry.packet, { coalesceKey: 'heartbeat' });
    return true;
  }

  function presenceHeartbeatEntry(req = null) {
    const body = presenceHeartbeat(req);
    return {
      body,
      signature: presenceHeartbeatSignature(body),
      packet: ssePacket('heartbeat', body),
      keepalivePacket: sseComment('heartbeat-unchanged'),
    };
  }

  function writePresenceHeartbeat(res, req = null, options = {}) {
    return writePresenceHeartbeatPacket(res, presenceHeartbeatEntry(req), options);
  }
  
  function broadcastHeartbeat() {
    const entriesByWorkspace = new Map();
    for (const res of sseClients) {
      const req = res.magclawRequest || null;
      const workspaceId = presenceWorkspaceIdForRequest(req);
      const key = workspaceId || '__all__';
      let entry = entriesByWorkspace.get(key);
      if (!entry) {
        entry = presenceHeartbeatEntry(req);
        entriesByWorkspace.set(key, entry);
      }
      writePresenceHeartbeatPacket(res, entry);
    }
  }
  
  function agentStatusIsBusy(status) {
    return ['starting', 'thinking', 'working', 'running', 'busy', 'queued', 'warming'].includes(String(status || '').toLowerCase());
  }

  function agentActivityDetail(activity = null) {
    if (!activity || typeof activity !== 'object') return '';
    return String(
      activity.error
      || activity.detail
      || activity.note
      || activity.text
      || activity.message
      || activity.tool
      || ''
    ).trim();
  }

  function nextAgentActivitySeq(agent) {
    const current = Math.max(0, Math.floor(Number(agent?.activitySeq || 0)) || 0);
    agent.activitySeq = current + 1;
    return agent.activitySeq;
  }

  function normalizeAgentActivityRealtimeEntry(entry = {}, fallback = {}) {
    const source = entry && typeof entry === 'object' ? entry : {};
    const activity = source.activity && typeof source.activity === 'object'
      ? source.activity
      : fallback.runtimeActivity || null;
    const detail = String(
      source.detail
      || source.message
      || source.text
      || agentActivityDetail(activity)
      || fallback.detail
      || ''
    ).trim();
    const agentId = source.agentId || fallback.agentId || '';
    const type = source.type || source.eventType || source.kind || fallback.type || 'agent_activity_changed';
    const normalized = { type };
    if (source.id) normalized.id = source.id;
    if (agentId && agentId !== fallback.agentId) normalized.agentId = agentId;
    if (activity) normalized.activity = activity;
    if (detail) normalized.detail = detail;
    if (source.message && source.message !== detail) normalized.message = source.message;
    if (source.createdAt || source.at) normalized.createdAt = source.createdAt || source.at;
    if (source.raw) normalized.raw = source.raw;
    return normalized;
  }

  function recordAgentActivityChanged(agent, options = {}) {
    if (!agent?.id) return null;
    const activity = agent.runtimeActivity && typeof agent.runtimeActivity === 'object' ? agent.runtimeActivity : null;
    const activityAt = options.activityAt || activity?.updatedAt || activity?.at || agent.heartbeatAt || agent.statusUpdatedAt || now();
    const activitySeq = Number(options.activitySeq || 0) > 0
      ? Math.floor(Number(options.activitySeq))
      : nextAgentActivitySeq(agent);
    agent.activitySeq = activitySeq;
    agent.activityAt = activityAt;
    const detail = String(options.detail || agentActivityDetail(activity) || '').trim();
    const fallback = {
      agentId: agent.id,
      type: options.type || 'agent_activity_changed',
      runtimeActivity: activity,
      detail,
      activityAt,
    };
    const entries = (Array.isArray(options.entries) ? options.entries : [])
      .map((entry) => normalizeAgentActivityRealtimeEntry(entry, fallback))
      .filter((entry) => entry.agentId || fallback.agentId);
    const status = agent.status || 'offline';
    const includeRuntimeActivity = Boolean(activity) || !agentStatusIsBusy(status) || options.includeRuntimeActivity === true;
    const activeWorkItemIds = Array.isArray(agent.activeWorkItemIds) ? agent.activeWorkItemIds : [];
    const agentPatch = {
      id: agent.id,
      status,
    };
    const previousStatus = options.previousStatus || agent.previousStatus || null;
    if (previousStatus) agentPatch.previousStatus = previousStatus;
    if (agent.statusUpdatedAt) agentPatch.statusUpdatedAt = agent.statusUpdatedAt;
    if (agent.heartbeatAt) agentPatch.heartbeatAt = agent.heartbeatAt;
    if (includeRuntimeActivity) agentPatch.runtimeActivity = activity;
    if (activeWorkItemIds.length || !agentStatusIsBusy(status)) agentPatch.activeWorkItemIds = activeWorkItemIds;
    const payload = {
      agentId: agent.id,
      activitySeq,
      activityAt,
      entries,
      agent: agentPatch,
    };
    if (detail) payload.detail = detail;
    if (includeRuntimeActivity) payload.runtimeActivity = activity;
    return recordRealtimeEvent('agent_activity_changed', payload, {
      workspaceId: options.workspaceId || agent.workspaceId || '',
      scopeType: 'agent',
      scopeId: agent.id,
    });
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
    agent.updatedAt = agent.statusUpdatedAt;
    agent.heartbeatAt = agent.statusUpdatedAt;
    if (extra.runtimeActivity !== undefined) {
      agent.runtimeActivity = extra.runtimeActivity;
    } else if (!agentStatusIsBusy(nextStatus)) {
      agent.runtimeActivity = null;
    }
    if (extra.activeWorkItemIds !== undefined) {
      agent.activeWorkItemIds = normalizeIds(extra.activeWorkItemIds);
    }
    const shouldRecordStatus = previousStatus !== nextStatus || extra.forceEvent;
    const shouldRecordActivity = shouldRecordStatus || extra.runtimeActivity !== undefined;
    if (shouldRecordStatus) {
      addSystemEvent('agent_status_changed', `${agent.name} is ${nextStatus}.`, {
        agentId: agent.id,
        previousStatus,
        status: nextStatus,
        reason,
        ...(extra.event || {}),
      }, { skipRealtime: true });
    }
    if (shouldRecordActivity) {
      recordAgentActivityChanged(agent, {
        type: 'agent_status_changed',
        previousStatus,
        detail: agentActivityDetail(agent.runtimeActivity) || `${agent.name} is ${nextStatus}.`,
        entries: [{
          type: 'agent_status_changed',
          agentId: agent.id,
          activity: agent.runtimeActivity || null,
          detail: agentActivityDetail(agent.runtimeActivity) || `${agent.name} is ${nextStatus}.`,
          raw: {
            previousStatus,
            status: nextStatus,
            reason,
            ...(extra.event || {}),
          },
        }],
      });
    }
    return agent;
  }
  
  function reconcileAgentStatusHeartbeats() {
    if (!state?.agents?.length) return false;
    let changed = false;
    const activeAgentIds = new Set([...agentProcesses.values()].map((proc) => proc?.agentId).filter(Boolean));
    const threshold = Date.now() - AGENT_STATUS_STALE_MS;
    for (const agent of state.agents) {
      const activeProc = activeAgentIds.has(agent.id)
        ? [...agentProcesses.values()].find((proc) => proc?.agentId === agent.id) || null
        : null;
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
    agentActivityWindow,
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
    writePresenceHeartbeat,
    reconcileAgentStatusHeartbeats,
    realtimeEventsForRequest,
    recordAgentActivityChanged,
    recordRealtimeEvent,
    resolveCodexRuntime,
    flushActivityLog: () => activityLog.flush(),
    setExternalStatePersister,
    setAgentStatus,
    state: stateProxy,
    stateFullSnapshot,
    stateJsonSnapshot,
  };
}
