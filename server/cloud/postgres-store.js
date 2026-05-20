import { Pool } from 'pg';
import {
  DEFAULT_DATABASE,
  DEFAULT_MAINTENANCE_DATABASE,
  DEFAULT_SCHEMA,
  applyLocalPostgresTimeouts,
  configurePostgresSession,
  databaseNameFromUrl,
  databaseUrlWithName,
  migratePostgres,
  normalizeDatabaseUrl,
  normalizePostgresRuntimeOptions,
  postgresRuntimeOptionsFromEnv,
  quoteIdent,
  redactDatabaseUrl,
} from './postgres.js';
import { normalizeReleaseNotes, RELEASE_COMPONENTS } from '../release-notes.js';

const TRANSIENT_POSTGRES_PERSIST_ERROR_CODES = new Set(['55P03', '40001', '40P01']);
const DURABLE_STATE_RECORD_ARRAY_KEYS = Object.freeze(['reminders', 'missions', 'runs', 'projects']);
const DURABLE_STATE_RECORD_OBJECT_KEYS = Object.freeze(['settings', 'connection', 'router']);
const EPHEMERAL_STATE_RECORD_KEYS = new Set(['events', 'routeEvents', 'systemNotifications', 'inboxReads']);
const EPHEMERAL_STATE_RECORD_KEY_LIST = Object.freeze([...EPHEMERAL_STATE_RECORD_KEYS]);
const MESSAGE_PAGE_DEFAULT_LIMIT = 80;
const MESSAGE_PAGE_MAX_LIMIT = 200;
const THREAD_REPLY_PAGE_MAX_LIMIT = 300;
const RECENT_MESSAGE_HYDRATION_LIMIT = 500;
const RECENT_REPLY_HYDRATION_LIMIT = 500;

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function iso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function requiredIso(value) {
  return iso(value) || new Date().toISOString();
}

function dateOnly(value) {
  if (!value) return '';
  if (value instanceof Date) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  const raw = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return iso(value)?.slice(0, 10) || '';
}

function jsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.trunc(parsed);
}

function parsePageLimit(value, fallback = MESSAGE_PAGE_DEFAULT_LIMIT, max = MESSAGE_PAGE_MAX_LIMIT) {
  const parsed = parsePositiveInteger(value, fallback);
  return Math.min(max, parsed);
}

function compareRecordCreatedAsc(a, b) {
  const aTime = Date.parse(a?.createdAt || a?.updatedAt || '');
  const bTime = Date.parse(b?.createdAt || b?.updatedAt || '');
  const aValue = Number.isFinite(aTime) ? aTime : 0;
  const bValue = Number.isFinite(bTime) ? bTime : 0;
  return aValue - bValue || String(a?.id || '').localeCompare(String(b?.id || ''));
}

function realtimeChannelName(value, schema = DEFAULT_SCHEMA) {
  const explicit = String(value || '').trim();
  const raw = explicit || `magclaw_realtime_${schema || DEFAULT_SCHEMA}`;
  const normalized = raw.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^([^a-zA-Z_])/, '_$1');
  return (normalized || 'magclaw_realtime').slice(0, 63);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function postgresPoolErrorCode(error) {
  return String(error?.code || error?.errno || 'UNKNOWN');
}

function postgresPoolErrorMessage(error) {
  return String(error?.message || error || 'PostgreSQL pool error').replace(/\s+/g, ' ').slice(0, 300);
}

function isTransientPostgresPersistError(error) {
  return TRANSIENT_POSTGRES_PERSIST_ERROR_CODES.has(postgresPoolErrorCode(error));
}

function stripStateMetadata(value) {
  const metadata = { ...jsonObject(value) };
  delete metadata.state;
  return metadata;
}

function metadataWithState(record, durableOverrides = {}) {
  return {
    ...jsonObject(record?.metadata),
    state: {
      ...jsonObject(record),
      ...jsonObject(durableOverrides),
    },
  };
}

async function upsertStateRecord(client, tableName, values) {
  await client.query(`
    INSERT INTO ${tableName}
      (workspace_id, kind, id, position, created_at, updated_at, payload)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
    ON CONFLICT (workspace_id, kind, id) DO UPDATE SET
      position = EXCLUDED.position,
      created_at = COALESCE(${tableName}.created_at, EXCLUDED.created_at),
      updated_at = COALESCE(EXCLUDED.updated_at, ${tableName}.updated_at),
      payload = EXCLUDED.payload
  `, values);
}

function recordFromMetadata(row, base = {}) {
  const metadata = jsonObject(row.metadata);
  const source = jsonObject(metadata.state);
  const next = {
    ...source,
    ...base,
  };
  if (!source.metadata && Object.keys(stripStateMetadata(metadata)).length) {
    next.metadata = stripStateMetadata(metadata);
  }
  return next;
}

function computerStatus(value) {
  const status = String(value || '').trim();
  if (status === 'disabled' || status === 'pairing') return status;
  return 'offline';
}

function agentStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (status === 'disabled' || status === 'deleted' || status === 'offline') return status;
  return 'idle';
}

function humanStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if (status === 'invited' || status === 'removed' || status === 'disabled') return status;
  return 'offline';
}

const TRANSIENT_AGENT_LOAD_STATUSES = new Set(['starting', 'thinking', 'working', 'running', 'busy', 'queued', 'warming', 'error']);

function resetTransientRuntimeStateAfterLoad(state, loadedAt = requiredIso()) {
  for (const computer of safeArray(state.computers)) {
    const status = String(computer.status || '').toLowerCase();
    const connectedVia = String(computer.connectedVia || '').toLowerCase();
    if (status === 'connected' && connectedVia === 'daemon') {
      computer.status = 'offline';
      computer.disconnectedAt = computer.disconnectedAt || loadedAt;
      computer.updatedAt = loadedAt;
    }
  }
  for (const human of safeArray(state.humans)) {
    if (String(human.status || '').toLowerCase() === 'online') {
      human.status = 'offline';
      human.presenceUpdatedAt = loadedAt;
      human.updatedAt = loadedAt;
    }
  }
  for (const agent of safeArray(state.agents)) {
    if (TRANSIENT_AGENT_LOAD_STATUSES.has(String(agent.status || '').toLowerCase())) {
      agent.status = 'idle';
      agent.statusUpdatedAt = loadedAt;
      agent.heartbeatAt = loadedAt;
      agent.activeWorkItemIds = [];
      agent.runtimeActivity = null;
      agent.updatedAt = loadedAt;
    }
  }
}

function taskStatus(value) {
  const status = String(value || '').trim();
  return ['todo', 'in_progress', 'in_review', 'done', 'closed'].includes(status) ? status : 'todo';
}

function authorType(value) {
  const type = String(value || '').trim();
  return ['user', 'human', 'agent', 'system'].includes(type) ? type : 'system';
}

function spaceType(value) {
  const type = String(value || '').trim();
  return ['channel', 'dm'].includes(type) ? type : 'channel';
}

function isDefaultLocalWorkspacePlaceholder(workspace, cloud) {
  const id = String(workspace?.id || '').trim();
  if (id !== 'local') return false;
  const slug = String(workspace?.slug || workspace?.id || '').trim();
  const hasOwner = Boolean(workspace?.ownerUserId || workspace?.owner_user_id);
  const hasMember = safeArray(cloud?.workspaceMembers).some((member) => String(member?.workspaceId || '') === id);
  return (!slug || slug === 'local') && !hasOwner && !hasMember;
}

function durableCloudWorkspaces(cloud) {
  return safeArray(cloud?.workspaces)
    .filter((workspace) => workspace?.id && !isDefaultLocalWorkspacePlaceholder(workspace, cloud));
}

function workspaceIds(cloud) {
  return durableCloudWorkspaces(cloud).map((workspace) => workspace.id).filter(Boolean);
}

function fallbackWorkspaceId(cloud) {
  return workspaceIds(cloud)[0] || '';
}

function defaultWorkspaceId(state, cloud) {
  const ids = new Set(workspaceIds(cloud));
  if (!ids.size) return '';
  return [
    state?.connection?.workspaceId,
    cloud?.auth?.currentWorkspaceId,
    cloud?.workspaces?.[0]?.id,
  ].find((id) => id && ids.has(id)) || '';
}

function workspaceIdFor(record, state, cloud) {
  const ids = new Set(workspaceIds(cloud));
  if (!ids.size) return '';
  const explicit = record?.workspaceId || record?.workspace_id;
  if (explicit) return ids.has(explicit) ? explicit : '';
  return defaultWorkspaceId(state, cloud);
}

function userIdForHuman(human, cloud) {
  if (human?.authUserId) return human.authUserId;
  const member = safeArray(cloud?.workspaceMembers).find((item) => item.humanId && item.humanId === human?.id);
  return member?.userId || null;
}

function roleForHuman(human, cloud) {
  const member = safeArray(cloud?.workspaceMembers).find((item) => item.humanId && item.humanId === human?.id);
  return member?.role || human?.role || 'member';
}

function firstRow(result) {
  return result.rows[0] || null;
}

function tableName(schema, table) {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

function userFromRow(row) {
  return {
    id: row.id,
    email: row.email,
    name: row.name || '',
    passwordHash: row.password_hash || '',
    avatarUrl: row.avatar_url || '',
    thirdPartyName: row.third_party_name || jsonObject(jsonObject(row.metadata).oauth).feishu?.name || '',
    thirdPartyProvider: row.third_party_provider || (jsonObject(jsonObject(row.metadata).oauth).feishu ? 'feishu' : ''),
    language: row.language || 'en',
    emailVerifiedAt: iso(row.email_verified_at),
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
    lastLoginAt: iso(row.last_login_at),
    disabledAt: iso(row.disabled_at),
    metadata: jsonObject(row.metadata),
  };
}

function workspaceFromRow(row) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    avatar: row.avatar || '',
    onboardingAgentId: row.onboarding_agent_id || '',
    newAgentGreetingEnabled: row.new_agent_greeting_enabled !== false,
    ownerUserId: row.owner_user_id || null,
    deletedAt: iso(row.deleted_at),
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
    metadata: jsonObject(row.metadata),
  };
}

function joinLinkFromRow(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    tokenHash: row.token_hash,
    maxUses: Number(row.max_uses || 0),
    usedCount: Number(row.used_count || 0),
    expiresAt: iso(row.expires_at),
    revokedAt: iso(row.revoked_at),
    revokedBy: row.revoked_by || null,
    createdBy: row.created_by || null,
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
    metadata: jsonObject(row.metadata),
  };
}

function memberFromRow(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    humanId: row.human_id || '',
    role: row.role,
    status: row.status,
    joinedAt: iso(row.joined_at),
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
    removedAt: iso(row.removed_at),
    metadata: jsonObject(row.metadata),
  };
}

function sessionFromRow(row) {
  return {
    id: row.id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    createdAt: requiredIso(row.created_at),
    expiresAt: requiredIso(row.expires_at),
    userAgent: row.user_agent || '',
    ipHash: row.ip_hash || '',
    revokedAt: iso(row.revoked_at),
    lastSeenAt: iso(row.last_seen_at),
    metadata: jsonObject(row.metadata),
  };
}

function invitationFromRow(row) {
    return {
      id: row.id,
      workspaceId: row.workspace_id,
      humanId: row.human_id || '',
      email: row.email,
      role: row.role,
      tokenHash: row.token_hash,
      invitedBy: row.invited_by || null,
      expiresAt: requiredIso(row.expires_at),
      acceptedAt: iso(row.accepted_at),
      acceptedBy: row.accepted_by || null,
      revokedAt: iso(row.revoked_at),
      createdAt: requiredIso(row.created_at),
      metadata: jsonObject(row.metadata),
  };
}

function passwordResetFromRow(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    tokenHash: row.token_hash,
    createdBy: row.created_by || null,
    expiresAt: requiredIso(row.expires_at),
    consumedAt: iso(row.consumed_at),
    revokedAt: iso(row.revoked_at),
    createdAt: requiredIso(row.created_at),
    metadata: jsonObject(row.metadata),
  };
}

function computerFromRow(row) {
  return recordFromMetadata(row, {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name || '',
    hostname: row.hostname || '',
    os: row.os || '',
    arch: row.arch || '',
    daemonVersion: row.daemon_version || '',
    status: row.status || 'offline',
    connectedVia: row.connected_via || 'daemon',
    runtimeIds: safeArray(row.runtime_ids),
    runtimeDetails: safeArray(row.runtime_details),
    capabilities: safeArray(row.capabilities),
    runningAgents: safeArray(row.running_agents),
    machineFingerprint: row.machine_fingerprint || '',
    createdBy: row.created_by || null,
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
    lastSeenAt: iso(row.last_seen_at),
    daemonConnectedAt: iso(row.daemon_connected_at),
    disconnectedAt: iso(row.disconnected_at),
    disabledAt: iso(row.disabled_at),
  });
}

function humanFromRow(row) {
  return recordFromMetadata(row, {
    id: row.id,
    workspaceId: row.workspace_id,
    authUserId: row.user_id || '',
    name: row.name || '',
    email: row.email || '',
    role: row.role || 'member',
    status: row.status || 'offline',
    avatar: row.avatar || '',
    description: row.description || '',
    lastSeenAt: iso(row.last_seen_at),
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
  });
}

function agentFromRow(row) {
  return recordFromMetadata(row, {
    id: row.id,
    workspaceId: row.workspace_id,
    computerId: row.computer_id || '',
    name: row.name || '',
    handle: row.handle || '',
    description: row.description || '',
    runtime: row.runtime || '',
    runtimeId: jsonObject(row.metadata).state?.runtimeId || row.runtime || '',
    model: row.model || '',
    reasoningEffort: row.reasoning_effort || '',
    status: row.status || 'offline',
    workspacePath: row.workspace_path || '',
    workspace: row.workspace_path || '',
    createdByUserId: row.created_by || '',
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
    statusUpdatedAt: iso(row.status_updated_at),
  });
}

function channelFromRow(row) {
  return recordFromMetadata(row, {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name || '',
    description: row.description || '',
    archived: Boolean(row.archived_at),
    archivedAt: iso(row.archived_at),
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
  });
}

function dmFromRow(row) {
  return recordFromMetadata(row, {
    id: row.id,
    workspaceId: row.workspace_id,
    participantIds: safeArray(row.participant_ids),
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
  });
}

function messageFromRow(row) {
  return recordFromMetadata(row, {
    id: row.id,
    workspaceId: row.workspace_id,
    spaceType: row.space_type,
    spaceId: row.space_id,
    authorType: row.author_type,
    authorId: row.author_id || '',
    body: row.body || '',
    attachmentIds: safeArray(row.attachment_ids),
    mentionedAgentIds: safeArray(row.mentioned_agent_ids),
    mentionedHumanIds: safeArray(row.mentioned_human_ids),
    replyCount: Number(row.reply_count || 0),
    savedBy: safeArray(row.saved_by),
    readBy: safeArray(row.read_by),
    reactions: safeArray(row.reactions),
    followedBy: safeArray(row.followed_by),
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
  });
}

function replyFromRow(row) {
  return recordFromMetadata(row, {
    id: row.id,
    workspaceId: row.workspace_id,
    parentMessageId: row.parent_message_id,
    authorType: row.author_type,
    authorId: row.author_id || '',
    body: row.body || '',
    attachmentIds: safeArray(row.attachment_ids),
    mentionedAgentIds: safeArray(row.mentioned_agent_ids),
    mentionedHumanIds: safeArray(row.mentioned_human_ids),
    savedBy: safeArray(row.saved_by),
    readBy: safeArray(row.read_by),
    reactions: safeArray(row.reactions),
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
  });
}

function taskFromRow(row) {
  return recordFromMetadata(row, {
    id: row.id,
    workspaceId: row.workspace_id,
    number: row.number,
    spaceType: row.space_type,
    spaceId: row.space_id,
    title: row.title || '',
    body: row.body || '',
    status: row.status || 'todo',
    createdBy: row.created_by || '',
    claimedBy: row.claimed_by || '',
    claimedAt: iso(row.claimed_at),
    reviewRequestedAt: iso(row.review_requested_at),
    completedAt: iso(row.completed_at),
    sourceMessageId: row.source_message_id || null,
    sourceReplyId: row.source_reply_id || null,
    threadMessageId: row.thread_message_id || null,
    assigneeIds: safeArray(row.assignee_ids),
    attachmentIds: safeArray(row.attachment_ids),
    localReferences: safeArray(row.local_references),
    history: safeArray(row.history),
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
  });
}

function workItemFromRow(row) {
  const source = jsonObject(jsonObject(row.metadata).state);
  return recordFromMetadata(row, {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id || '',
    taskId: row.task_id || null,
    messageId: row.message_id || null,
    sourceMessageId: row.message_id || null,
    parentMessageId: row.parent_message_id || null,
    status: row.status || 'queued',
    target: Object.keys(jsonObject(row.target)).length ? jsonObject(row.target) : source.target,
    payload: jsonObject(row.payload),
    sendCount: Number(row.send_count || 0),
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
    completedAt: iso(row.completed_at),
  });
}

function attachmentFromRow(row) {
  return recordFromMetadata(row, {
    id: row.id,
    workspaceId: row.workspace_id,
    storageKey: row.storage_key,
    storageMode: row.storage_mode || 'pvc',
    name: row.filename || '',
    filename: row.filename || '',
    type: row.mime_type || '',
    mimeType: row.mime_type || '',
    size: Number(row.size_bytes || 0),
    sizeBytes: Number(row.size_bytes || 0),
    checksumSha256: row.checksum_sha256 || '',
    source: row.source || 'upload',
    createdBy: row.created_by || '',
    createdAt: requiredIso(row.created_at),
  });
}

function computerTokenFromRow(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    computerId: row.computer_id,
    label: row.label || '',
    tokenHash: row.token_hash,
    createdAt: requiredIso(row.created_at),
    lastUsedAt: iso(row.last_used_at),
    expiresAt: iso(row.expires_at),
    revokedAt: iso(row.revoked_at),
    metadata: jsonObject(row.metadata),
  };
}

function pairingTokenFromRow(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    computerId: row.computer_id,
    label: row.label || '',
    tokenHash: row.token_hash,
    createdBy: row.created_by || null,
    createdAt: requiredIso(row.created_at),
    expiresAt: requiredIso(row.expires_at),
    consumedAt: iso(row.consumed_at),
    revokedAt: iso(row.revoked_at),
    metadata: jsonObject(row.metadata),
  };
}

function agentDeliveryFromRow(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    computerId: row.computer_id,
    messageId: row.message_id || null,
    workItemId: row.work_item_id || null,
    seq: Number(row.seq || 0),
    type: row.type,
    commandType: row.command_type,
    status: row.status,
    idempotencyKey: row.idempotency_key || '',
    attempts: Number(row.attempts || 0),
    payload: jsonObject(row.payload),
    error: row.error || '',
    createdAt: requiredIso(row.created_at),
    updatedAt: requiredIso(row.updated_at),
    sentAt: iso(row.sent_at),
    ackedAt: iso(row.acked_at),
    completedAt: iso(row.completed_at),
  };
}

function realtimeEventFromRow(row) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    seq: Number(row.seq || 0),
    eventType: row.event_type,
    scopeType: row.scope_type || 'workspace',
    scopeId: row.scope_id || '',
    threadMessageId: row.thread_message_id || null,
    payload: jsonObject(row.payload),
    createdAt: requiredIso(row.created_at),
  };
}

function releaseNoteRowId(component, version, category, position) {
  return [component, version, category, position]
    .map((part) => String(part || '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, ''))
    .join('_')
    .slice(0, 180);
}

function releaseEntriesFromNotes(releaseNotesInput) {
  const releaseNotes = normalizeReleaseNotes(releaseNotesInput);
  const entries = [];
  for (const component of RELEASE_COMPONENTS) {
    for (const release of safeArray(releaseNotes[component]?.releases)) {
      for (const category of ['features', 'fixes', 'improved']) {
        safeArray(release[category]).forEach((body, position) => {
          entries.push({
            id: releaseNoteRowId(component, release.version, category, position),
            component,
            version: release.version,
            releasedAt: release.date,
            title: release.title || '',
            category,
            body: String(body || ''),
            position,
          });
        });
      }
    }
  }
  return entries.filter((entry) => entry.version && entry.releasedAt && entry.body);
}

function releaseNotesFromRows(rows, fallback) {
  const notes = normalizeReleaseNotes(fallback);
  const grouped = {
    web: new Map(),
    daemon: new Map(),
  };
  for (const row of safeArray(rows)) {
    const component = RELEASE_COMPONENTS.includes(row.component) ? row.component : '';
    if (!component) continue;
    const version = String(row.version || '').trim();
    const date = dateOnly(row.released_at);
    if (!version || !date) continue;
    const key = `${version}:${date}`;
    if (!grouped[component].has(key)) {
      grouped[component].set(key, {
        id: `${component}-${version}`,
        version,
        date,
        title: row.title || '',
        features: [],
        fixes: [],
        improved: [],
      });
    }
    const release = grouped[component].get(key);
    const category = ['features', 'fixes', 'improved'].includes(row.category) ? row.category : 'features';
    release[category].push(String(row.body || ''));
  }
  for (const component of RELEASE_COMPONENTS) {
    const releases = [...grouped[component].values()];
    if (releases.length) notes[component].releases = releases;
  }
  return normalizeReleaseNotes(notes);
}

export function cloudPostgresOptionsFromEnv(env = process.env) {
  const databaseUrl = normalizeDatabaseUrl(env.MAGCLAW_DATABASE_URL || '');
  if (!databaseUrl) return null;
  return {
    databaseUrl,
    database: env.MAGCLAW_DATABASE || databaseNameFromUrl(databaseUrl, DEFAULT_DATABASE),
    schema: env.MAGCLAW_DATABASE_SCHEMA || DEFAULT_SCHEMA,
    maintenanceDatabase: env.MAGCLAW_MAINTENANCE_DATABASE || DEFAULT_MAINTENANCE_DATABASE,
    createDatabase: env.MAGCLAW_DATABASE_CREATE !== '0',
    poolMax: env.MAGCLAW_DATABASE_POOL_MAX,
    runtimeOptions: postgresRuntimeOptionsFromEnv(env),
  };
}

export function createCloudPostgresStore(optionsInput = {}) {
  const options = {
    ...(cloudPostgresOptionsFromEnv() || {}),
    ...optionsInput,
  };
  const databaseUrl = normalizeDatabaseUrl(options.databaseUrl || '');
  if (!databaseUrl) return null;

  const database = options.database || databaseNameFromUrl(databaseUrl, DEFAULT_DATABASE);
  const schema = options.schema || DEFAULT_SCHEMA;
  const maintenanceDatabase = options.maintenanceDatabase || DEFAULT_MAINTENANCE_DATABASE;
  const createDatabase = options.createDatabase !== false;
  const poolMax = parsePositiveInteger(options.poolMax || process.env.MAGCLAW_DATABASE_POOL_MAX, 10);
  const runtimeOptions = normalizePostgresRuntimeOptions(options.runtimeOptions || postgresRuntimeOptionsFromEnv());
  const applicationName = options.applicationName || process.env.MAGCLAW_DATABASE_APPLICATION_NAME || 'magclaw-web';
  const realtimeChannel = realtimeChannelName(options.realtimeChannel || process.env.MAGCLAW_REALTIME_CHANNEL, schema);
  const recentMessageHydrationLimit = parsePageLimit(
    options.recentMessageHydrationLimit || process.env.MAGCLAW_RECENT_MESSAGE_HYDRATION_LIMIT,
    RECENT_MESSAGE_HYDRATION_LIMIT,
    2000,
  );
  const recentReplyHydrationLimit = parsePageLimit(
    options.recentReplyHydrationLimit || process.env.MAGCLAW_RECENT_REPLY_HYDRATION_LIMIT,
    RECENT_REPLY_HYDRATION_LIMIT,
    2000,
  );
  let pool = options.pool || null;
  let realtimeClient = null;
  let realtimeStopper = null;
  let realtimeReconnectTimer = null;
  let initialized = false;
  let migration = null;
  let persistQueue = Promise.resolve();
  const poolsWithErrorHandler = new WeakSet();

  function attachPoolErrorHandler(nextPool) {
    if (!nextPool || typeof nextPool.on !== 'function') return;
    if (poolsWithErrorHandler.has(nextPool)) return;
    poolsWithErrorHandler.add(nextPool);
    nextPool.on('error', (error) => {
      const code = postgresPoolErrorCode(error);
      console.warn(`[cloud-postgres] idle client error code=${code} message=${postgresPoolErrorMessage(error)}`);
    });
  }

  attachPoolErrorHandler(pool);

  function clearRealtimeReconnect() {
    if (!realtimeReconnectTimer) return;
    clearTimeout(realtimeReconnectTimer);
    realtimeReconnectTimer = null;
  }

  function releaseRealtimeClient(client) {
    if (!client) return;
    if (realtimeClient === client) realtimeClient = null;
    try {
      client.release?.();
    } catch {
      // Listener shutdown/reconnect cleanup should never block app shutdown.
    }
  }

  function table(name) {
    return tableName(schema, name);
  }

  function messageRuntimeConflictSuffix() {
    const existing = table('cloud_messages');
    return `
      ON CONFLICT (id) DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        space_type = EXCLUDED.space_type,
        space_id = EXCLUDED.space_id,
        author_type = EXCLUDED.author_type,
        author_id = EXCLUDED.author_id,
        body = EXCLUDED.body,
        attachment_ids = EXCLUDED.attachment_ids,
        mentioned_agent_ids = EXCLUDED.mentioned_agent_ids,
        mentioned_human_ids = EXCLUDED.mentioned_human_ids,
        reply_count = GREATEST(${existing}.reply_count, EXCLUDED.reply_count),
        saved_by = EXCLUDED.saved_by,
        read_by = EXCLUDED.read_by,
        reactions = EXCLUDED.reactions,
        followed_by = EXCLUDED.followed_by,
        created_at = COALESCE(${existing}.created_at, EXCLUDED.created_at),
        updated_at = GREATEST(COALESCE(${existing}.updated_at, EXCLUDED.updated_at), EXCLUDED.updated_at),
        metadata = EXCLUDED.metadata
    `;
  }

  function replyRuntimeConflictSuffix() {
    const existing = table('cloud_replies');
    return `
      ON CONFLICT (id) DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        parent_message_id = EXCLUDED.parent_message_id,
        author_type = EXCLUDED.author_type,
        author_id = EXCLUDED.author_id,
        body = EXCLUDED.body,
        attachment_ids = EXCLUDED.attachment_ids,
        mentioned_agent_ids = EXCLUDED.mentioned_agent_ids,
        mentioned_human_ids = EXCLUDED.mentioned_human_ids,
        saved_by = EXCLUDED.saved_by,
        read_by = EXCLUDED.read_by,
        reactions = EXCLUDED.reactions,
        created_at = COALESCE(${existing}.created_at, EXCLUDED.created_at),
        updated_at = GREATEST(COALESCE(${existing}.updated_at, EXCLUDED.updated_at), EXCLUDED.updated_at),
        metadata = EXCLUDED.metadata
    `;
  }

  function greatestTimestamp(tableKey, column) {
    return `CASE
      WHEN ${table(tableKey)}.${column} IS NULL THEN EXCLUDED.${column}
      WHEN EXCLUDED.${column} IS NULL THEN ${table(tableKey)}.${column}
      ELSE GREATEST(${table(tableKey)}.${column}, EXCLUDED.${column})
    END`;
  }

  function agentRuntimeConflictSuffix() {
    const existing = table('cloud_agents');
    const existingNewer = `COALESCE(${existing}.updated_at, TIMESTAMPTZ 'epoch') > COALESCE(EXCLUDED.updated_at, TIMESTAMPTZ 'epoch')`;
    const existingStatusNewer = `COALESCE(${existing}.status_updated_at, TIMESTAMPTZ 'epoch') > COALESCE(EXCLUDED.status_updated_at, TIMESTAMPTZ 'epoch')`;
    return `
      ON CONFLICT (id) DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        computer_id = EXCLUDED.computer_id,
        name = CASE WHEN ${existingNewer} THEN ${existing}.name ELSE EXCLUDED.name END,
        handle = CASE WHEN ${existingNewer} THEN ${existing}.handle ELSE EXCLUDED.handle END,
        description = CASE WHEN ${existingNewer} THEN ${existing}.description ELSE EXCLUDED.description END,
        runtime = CASE WHEN ${existingNewer} THEN ${existing}.runtime ELSE EXCLUDED.runtime END,
        model = CASE WHEN ${existingNewer} THEN ${existing}.model ELSE EXCLUDED.model END,
        reasoning_effort = CASE WHEN ${existingNewer} THEN ${existing}.reasoning_effort ELSE EXCLUDED.reasoning_effort END,
        status = CASE WHEN ${existingStatusNewer} THEN ${existing}.status ELSE EXCLUDED.status END,
        workspace_path = CASE WHEN ${existingNewer} THEN ${existing}.workspace_path ELSE EXCLUDED.workspace_path END,
        created_by = CASE WHEN ${existingNewer} THEN ${existing}.created_by ELSE EXCLUDED.created_by END,
        created_at = LEAST(COALESCE(${existing}.created_at, EXCLUDED.created_at), EXCLUDED.created_at),
        updated_at = GREATEST(COALESCE(${existing}.updated_at, EXCLUDED.updated_at), EXCLUDED.updated_at),
        status_updated_at = ${greatestTimestamp('cloud_agents', 'status_updated_at')},
        metadata = CASE WHEN ${existingNewer} THEN ${existing}.metadata ELSE EXCLUDED.metadata END
    `;
  }

  function humanRuntimeConflictSuffix() {
    const existing = table('cloud_humans');
    const existingProfileNewer = `COALESCE(${existing}.updated_at, TIMESTAMPTZ 'epoch') > COALESCE(EXCLUDED.updated_at, TIMESTAMPTZ 'epoch')`;
    const existingPresenceNewer = `COALESCE(${existing}.last_seen_at, TIMESTAMPTZ 'epoch') > COALESCE(EXCLUDED.last_seen_at, TIMESTAMPTZ 'epoch')`;
    return `
      ON CONFLICT (id) DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        user_id = EXCLUDED.user_id,
        name = CASE WHEN ${existingProfileNewer} THEN ${existing}.name ELSE EXCLUDED.name END,
        email = CASE WHEN ${existingProfileNewer} THEN ${existing}.email ELSE EXCLUDED.email END,
        role = EXCLUDED.role,
        status = CASE WHEN ${existingPresenceNewer} THEN ${existing}.status ELSE EXCLUDED.status END,
        avatar = CASE WHEN ${existingProfileNewer} THEN ${existing}.avatar ELSE EXCLUDED.avatar END,
        description = CASE WHEN ${existingProfileNewer} THEN ${existing}.description ELSE EXCLUDED.description END,
        last_seen_at = ${greatestTimestamp('cloud_humans', 'last_seen_at')},
        created_at = LEAST(COALESCE(${existing}.created_at, EXCLUDED.created_at), EXCLUDED.created_at),
        updated_at = GREATEST(COALESCE(${existing}.updated_at, EXCLUDED.updated_at), EXCLUDED.updated_at),
        metadata = CASE WHEN ${existingProfileNewer} THEN ${existing}.metadata ELSE EXCLUDED.metadata END
    `;
  }

  function computerAuthConflictSuffix() {
    const existing = table('cloud_computers');
    const excludedDisconnectOrSeen = `COALESCE(EXCLUDED.disconnected_at, EXCLUDED.last_seen_at, EXCLUDED.updated_at, TIMESTAMPTZ 'epoch')`;
    const staleOfflineDowngrade = `EXCLUDED.status = 'offline'
          AND ${existing}.status = 'connected'
          AND COALESCE(${existing}.last_seen_at, TIMESTAMPTZ 'epoch') > ${excludedDisconnectOrSeen}`;
    return `
      ON CONFLICT (id) DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        name = EXCLUDED.name,
        hostname = EXCLUDED.hostname,
        os = EXCLUDED.os,
        arch = EXCLUDED.arch,
        daemon_version = EXCLUDED.daemon_version,
        status = CASE WHEN ${staleOfflineDowngrade} THEN ${existing}.status ELSE EXCLUDED.status END,
        connected_via = EXCLUDED.connected_via,
        runtime_ids = EXCLUDED.runtime_ids,
        runtime_details = EXCLUDED.runtime_details,
        capabilities = EXCLUDED.capabilities,
        running_agents = EXCLUDED.running_agents,
        machine_fingerprint = EXCLUDED.machine_fingerprint,
        updated_at = GREATEST(COALESCE(${existing}.updated_at, EXCLUDED.updated_at), EXCLUDED.updated_at),
        last_seen_at = ${greatestTimestamp('cloud_computers', 'last_seen_at')},
        daemon_connected_at = ${greatestTimestamp('cloud_computers', 'daemon_connected_at')},
        disconnected_at = ${greatestTimestamp('cloud_computers', 'disconnected_at')},
        disabled_at = EXCLUDED.disabled_at,
        metadata = EXCLUDED.metadata
    `;
  }

  async function withClient(fn) {
    if (!pool) {
      pool = new Pool({
        connectionString: databaseUrlWithName(databaseUrl, database),
        max: poolMax,
        connectionTimeoutMillis: runtimeOptions.connectTimeoutMs,
      });
      attachPoolErrorHandler(pool);
    }
    const client = await pool.connect();
    try {
      await configurePostgresSession(client, runtimeOptions, { applicationName });
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async function withTransaction(client, label, fn) {
    await client.query('BEGIN');
    try {
      await applyLocalPostgresTimeouts(client, runtimeOptions);
      const result = await fn();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        console.error(`[cloud-postgres] failed to rollback ${label} transaction`, rollbackError);
      }
      console.error(`[cloud-postgres] ${label} transaction failed`, error);
      throw error;
    }
  }

  async function publishRealtimeEvent(payload = {}) {
    const event = {
      version: 1,
      type: 'state_changed',
      createdAt: requiredIso(),
      ...jsonObject(payload),
    };
    const body = JSON.stringify(event);
    const compactBody = body.length <= 7900
      ? body
      : JSON.stringify({
        version: event.version,
        type: event.type,
        sourceId: event.sourceId || null,
        workspaceId: event.workspaceId || null,
        reason: event.reason || 'state_changed',
        createdAt: event.createdAt,
      });
    await withClient((client) => client.query('SELECT pg_notify($1, $2)', [realtimeChannel, compactBody]));
  }

  async function subscribeRealtimeEvents(onEvent) {
    if (typeof onEvent !== 'function') return async () => {};
    if (realtimeStopper) await realtimeStopper();

    let stopped = false;
    let connecting = false;

    const scheduleReconnect = (reason = 'unknown') => {
      if (stopped || realtimeReconnectTimer) return;
      realtimeReconnectTimer = setTimeout(() => {
        realtimeReconnectTimer = null;
        connect().catch((error) => {
          console.warn(`[cloud-postgres] realtime reconnect failed reason=${reason} message=${postgresPoolErrorMessage(error)}`);
          scheduleReconnect('retry_failed');
        });
      }, 1000);
      realtimeReconnectTimer.unref?.();
    };

    const connect = async () => {
      if (stopped || connecting || realtimeClient) return;
      connecting = true;
      let client = null;
      try {
        if (!pool) {
          pool = new Pool({
            connectionString: databaseUrlWithName(databaseUrl, database),
            max: poolMax,
            connectionTimeoutMillis: runtimeOptions.connectTimeoutMs,
          });
          attachPoolErrorHandler(pool);
        }
        client = await pool.connect();
        await configurePostgresSession(client, runtimeOptions, { applicationName: `${applicationName}-realtime` });
        const handleNotification = (message) => {
          if (message?.channel !== realtimeChannel) return;
          let event = {};
          try {
            event = message.payload ? JSON.parse(message.payload) : {};
          } catch {
            event = { payload: message.payload || '' };
          }
          onEvent({
            type: event.type || 'state_changed',
            channel: message.channel,
            createdAt: event.createdAt || requiredIso(),
            ...jsonObject(event),
          });
        };
        const handleDisconnect = (error) => {
          if (stopped) return;
          if (error) {
            console.warn(`[cloud-postgres] realtime listener disconnected code=${postgresPoolErrorCode(error)} message=${postgresPoolErrorMessage(error)}`);
          }
          releaseRealtimeClient(client);
          scheduleReconnect(error ? 'error' : 'end');
        };
        client.on?.('notification', handleNotification);
        client.on?.('error', handleDisconnect);
        client.on?.('end', () => handleDisconnect(null));
        await client.query(`LISTEN ${quoteIdent(realtimeChannel)}`);
        realtimeClient = client;
        console.info(`[cloud-postgres] realtime listener active channel=${realtimeChannel}`);
      } catch (error) {
        releaseRealtimeClient(client);
        throw error;
      } finally {
        connecting = false;
      }
    };

    const stop = async () => {
      stopped = true;
      clearRealtimeReconnect();
      const client = realtimeClient;
      realtimeClient = null;
      if (client) {
        try {
          await client.query(`UNLISTEN ${quoteIdent(realtimeChannel)}`);
        } catch {
          // Best-effort shutdown only.
        }
        releaseRealtimeClient(client);
      }
      if (realtimeStopper === stop) realtimeStopper = null;
    };

    realtimeStopper = stop;
    await connect();
    return stop;
  }

  function cloneRecord(value) {
    return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
  }

  function snapshotAuthOperation(operation) {
    return {
      type: operation?.type,
      user: cloneRecord(operation?.user),
      session: cloneRecord(operation?.session),
      reset: cloneRecord(operation?.reset),
      sessions: safeArray(operation?.sessions).map(cloneRecord),
      passwordResetTokens: safeArray(operation?.passwordResetTokens).map(cloneRecord),
    };
  }

  function normalizedEmailForUserRow(user) {
    const email = normalizeEmail(user?.email);
    if (email) return email;
    const oauth = jsonObject(jsonObject(user?.metadata).oauth);
    const feishu = jsonObject(oauth.feishu);
    const providerAccountId = String(feishu.providerAccountId || '').trim();
    if (providerAccountId) return `oauth:feishu:${providerAccountId}`;
    return `user:${String(user?.id || '').trim()}`;
  }

  async function upsertUserSnapshot(client, user) {
    if (!user?.id) return;
    await client.query(`
      INSERT INTO ${table('cloud_users')}
        (id, email, normalized_email, name, password_hash, avatar_url,
         third_party_name, third_party_provider, language, email_verified_at,
         created_at, updated_at, last_login_at, disabled_at, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        email = EXCLUDED.email,
        normalized_email = EXCLUDED.normalized_email,
        name = EXCLUDED.name,
        password_hash = COALESCE(${table('cloud_users')}.password_hash, EXCLUDED.password_hash),
        avatar_url = EXCLUDED.avatar_url,
        third_party_name = EXCLUDED.third_party_name,
        third_party_provider = EXCLUDED.third_party_provider,
        language = EXCLUDED.language,
        email_verified_at = COALESCE(${table('cloud_users')}.email_verified_at, EXCLUDED.email_verified_at),
        updated_at = GREATEST(COALESCE(${table('cloud_users')}.updated_at, EXCLUDED.updated_at), EXCLUDED.updated_at),
        last_login_at = CASE
          WHEN EXCLUDED.last_login_at IS NULL THEN ${table('cloud_users')}.last_login_at
          ELSE GREATEST(COALESCE(${table('cloud_users')}.last_login_at, EXCLUDED.last_login_at), EXCLUDED.last_login_at)
        END,
        disabled_at = COALESCE(${table('cloud_users')}.disabled_at, EXCLUDED.disabled_at),
        metadata = ${table('cloud_users')}.metadata || EXCLUDED.metadata
    `, [
      user.id,
      user.email,
      normalizedEmailForUserRow(user),
      user.name || '',
      user.passwordHash || null,
      user.avatarUrl || '',
      user.thirdPartyName || '',
      user.thirdPartyProvider || '',
      user.language || 'en',
      iso(user.emailVerifiedAt),
      requiredIso(user.createdAt),
      requiredIso(user.updatedAt || user.createdAt),
      iso(user.lastLoginAt),
      iso(user.disabledAt),
      JSON.stringify(jsonObject(user.metadata)),
    ]);
  }

  async function updateLoginUser(client, user) {
    if (!user?.id || !iso(user.lastLoginAt)) return;
    await client.query(`
      UPDATE ${table('cloud_users')}
      SET
        last_login_at = GREATEST(COALESCE(last_login_at, $2), $2),
        updated_at = GREATEST(COALESCE(updated_at, $2), $2)
      WHERE id = $1 AND disabled_at IS NULL
    `, [user.id, iso(user.lastLoginAt)]);
  }

  async function updateUserPassword(client, user) {
    if (!user?.id || typeof user.passwordHash !== 'string') return;
    const updatedAt = requiredIso(user.updatedAt || user.lastLoginAt);
    await client.query(`
      UPDATE ${table('cloud_users')}
      SET
        password_hash = $2,
        email_verified_at = COALESCE(${table('cloud_users')}.email_verified_at, $3),
        updated_at = GREATEST(COALESCE(${table('cloud_users')}.updated_at, $4), $4),
        last_login_at = CASE
          WHEN $5::timestamptz IS NULL THEN ${table('cloud_users')}.last_login_at
          ELSE GREATEST(COALESCE(${table('cloud_users')}.last_login_at, $5), $5)
        END
      WHERE id = $1 AND disabled_at IS NULL
    `, [
      user.id,
      user.passwordHash,
      iso(user.emailVerifiedAt),
      updatedAt,
      iso(user.lastLoginAt),
    ]);
  }

  async function upsertSession(client, session) {
    if (!session?.id) return;
    await client.query(`
      INSERT INTO ${table('cloud_sessions')}
        (id, user_id, token_hash, created_at, expires_at, user_agent,
         ip_hash, revoked_at, last_seen_at, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        expires_at = LEAST(${table('cloud_sessions')}.expires_at, EXCLUDED.expires_at),
        revoked_at = COALESCE(${table('cloud_sessions')}.revoked_at, EXCLUDED.revoked_at),
        last_seen_at = COALESCE(EXCLUDED.last_seen_at, ${table('cloud_sessions')}.last_seen_at),
        metadata = ${table('cloud_sessions')}.metadata || EXCLUDED.metadata
    `, [
      session.id,
      session.userId,
      session.tokenHash,
      requiredIso(session.createdAt),
      requiredIso(session.expiresAt),
      session.userAgent || '',
      session.ipHash || '',
      iso(session.revokedAt),
      iso(session.lastSeenAt),
      JSON.stringify(jsonObject(session.metadata)),
    ]);
  }

  async function upsertPasswordReset(client, reset) {
    if (!reset?.id) return;
    await client.query(`
      INSERT INTO ${table('cloud_password_resets')}
        (id, workspace_id, user_id, token_hash, created_by, expires_at,
         consumed_at, revoked_at, created_at, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
      ON CONFLICT (id) DO UPDATE SET
        expires_at = LEAST(${table('cloud_password_resets')}.expires_at, EXCLUDED.expires_at),
        consumed_at = COALESCE(${table('cloud_password_resets')}.consumed_at, EXCLUDED.consumed_at),
        revoked_at = COALESCE(${table('cloud_password_resets')}.revoked_at, EXCLUDED.revoked_at),
        metadata = ${table('cloud_password_resets')}.metadata || EXCLUDED.metadata
    `, [
      reset.id,
      reset.workspaceId,
      reset.userId,
      reset.tokenHash,
      reset.createdBy || null,
      requiredIso(reset.expiresAt),
      iso(reset.consumedAt),
      iso(reset.revokedAt),
      requiredIso(reset.createdAt),
      JSON.stringify(jsonObject(reset.metadata)),
    ]);
  }

  async function isEmpty(client) {
    const result = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM ${table('cloud_users')}) AS users,
        (SELECT COUNT(*)::int FROM ${table('cloud_workspaces')}) AS workspaces
    `);
    const row = firstRow(result);
    return Number(row?.users || 0) === 0 && Number(row?.workspaces || 0) === 0;
  }

  async function persistReleaseNotesFromState(client, state) {
    const entries = releaseEntriesFromNotes(state.releaseNotes);
    for (const entry of entries) {
      await client.query(`
        INSERT INTO ${table('cloud_release_notes')}
          (id, component, version, released_at, title, category, body, position, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, '{}'::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          released_at = EXCLUDED.released_at,
          title = EXCLUDED.title,
          category = EXCLUDED.category,
          body = EXCLUDED.body,
          position = EXCLUDED.position
      `, [
        entry.id,
        entry.component,
        entry.version,
        entry.releasedAt,
        entry.title,
        entry.category,
        entry.body,
        entry.position,
      ]);
    }
  }

  async function isRuntimeEmpty(client) {
    const result = await client.query(`
      SELECT
        (SELECT COUNT(*)::int FROM ${table('cloud_humans')}) AS humans,
        (SELECT COUNT(*)::int FROM ${table('cloud_agents')}) AS agents,
        (SELECT COUNT(*)::int FROM ${table('cloud_messages')}) AS messages,
        (SELECT COUNT(*)::int FROM ${table('cloud_state_records')} WHERE NOT (kind = ANY($1::text[]))) AS state_records
    `, [EPHEMERAL_STATE_RECORD_KEY_LIST]);
    const row = firstRow(result);
    return Number(row?.humans || 0) === 0
      && Number(row?.agents || 0) === 0
      && Number(row?.messages || 0) === 0
      && Number(row?.state_records || 0) === 0;
  }

  async function batchInsertRows(client, tableName, columns, rows, casts = {}, suffix = '') {
    if (!rows.length) return;
    const params = [];
    const values = rows.map((row) => {
      const placeholders = row.map((value, index) => {
        params.push(value);
        const column = columns[index];
        return `$${params.length}${casts[column] || ''}`;
      });
      return `(${placeholders.join(', ')})`;
    });
    await client.query(`
      INSERT INTO ${table(tableName)}
        (${columns.join(', ')})
      VALUES ${values.join(',\n')}
      ${suffix}
    `, params);
  }

  async function batchUpsertStateRecords(client, rows) {
    const deduped = new Map();
    for (const row of rows) {
      deduped.set(`${row[0]}\0${row[1]}\0${row[2]}`, row);
    }
    await batchInsertRows(client, 'cloud_state_records', [
      'workspace_id',
      'kind',
      'id',
      'position',
      'created_at',
      'updated_at',
      'payload',
    ], [...deduped.values()], { payload: '::jsonb' }, `
      ON CONFLICT (workspace_id, kind, id) DO UPDATE SET
        position = EXCLUDED.position,
        created_at = EXCLUDED.created_at,
        updated_at = EXCLUDED.updated_at,
        payload = EXCLUDED.payload
    `);
  }

  function pageFromDescendingRows(rows, limit, mapper, key) {
    const pageRows = rows.slice(0, limit);
    const records = pageRows.map(mapper).sort(compareRecordCreatedAsc);
    const cursorRow = pageRows.at(-1) || null;
    return {
      [key]: records,
      pagination: {
        limit,
        hasMore: rows.length > pageRows.length,
        nextBefore: cursorRow ? requiredIso(cursorRow.created_at) : '',
        nextBeforeId: cursorRow?.id || '',
      },
    };
  }

  function cursorClause(params, before, beforeId, columnPrefix = '') {
    const beforeAt = iso(before);
    const cleanBeforeId = String(beforeId || '').trim();
    const createdColumn = `${columnPrefix}created_at`;
    const idColumn = `${columnPrefix}id`;
    if (beforeAt && cleanBeforeId) {
      const timeParam = params.push(beforeAt);
      const idParam = params.push(cleanBeforeId);
      return ` AND (${createdColumn}, ${idColumn}) < ($${timeParam}::timestamptz, $${idParam}::text)`;
    }
    if (beforeAt) {
      const timeParam = params.push(beforeAt);
      return ` AND ${createdColumn} < $${timeParam}::timestamptz`;
    }
    return '';
  }

  async function listSpaceMessagesPage(options = {}) {
    const workspaceId = String(options.workspaceId || '').trim();
    const cleanSpaceType = spaceType(options.spaceType);
    const spaceId = String(options.spaceId || '').trim();
    if (!workspaceId || !spaceId) {
      return {
        messages: [],
        pagination: {
          limit: parsePageLimit(options.limit),
          hasMore: false,
          nextBefore: '',
          nextBeforeId: '',
        },
      };
    }
    const limit = parsePageLimit(options.limit);
    return withClient(async (client) => {
      const params = [workspaceId, cleanSpaceType, spaceId];
      const cursor = cursorClause(params, options.before, options.beforeId);
      const limitParam = params.push(limit + 1);
      const rows = await client.query(`
        SELECT *
        FROM ${table('cloud_messages')}
        WHERE workspace_id = $1
          AND space_type = $2
          AND space_id = $3
          ${cursor}
        ORDER BY created_at DESC, id DESC
        LIMIT $${limitParam}
      `, params);
      return pageFromDescendingRows(rows.rows, limit, messageFromRow, 'messages');
    });
  }

  async function listThreadRepliesPage(options = {}) {
    const workspaceId = String(options.workspaceId || '').trim();
    const parentMessageId = String(options.parentMessageId || '').trim();
    if (!workspaceId || !parentMessageId) {
      return {
        replies: [],
        pagination: {
          limit: parsePageLimit(options.limit, MESSAGE_PAGE_DEFAULT_LIMIT, THREAD_REPLY_PAGE_MAX_LIMIT),
          hasMore: false,
          nextBefore: '',
          nextBeforeId: '',
        },
      };
    }
    const limit = parsePageLimit(options.limit, MESSAGE_PAGE_DEFAULT_LIMIT, THREAD_REPLY_PAGE_MAX_LIMIT);
    return withClient(async (client) => {
      const params = [workspaceId, parentMessageId];
      const cursor = cursorClause(params, options.before, options.beforeId);
      const limitParam = params.push(limit + 1);
      const rows = await client.query(`
        SELECT *
        FROM ${table('cloud_replies')}
        WHERE workspace_id = $1
          AND parent_message_id = $2
          ${cursor}
        ORDER BY created_at DESC, id DESC
        LIMIT $${limitParam}
      `, params);
      return pageFromDescendingRows(rows.rows, limit, replyFromRow, 'replies');
    });
  }

  async function getMessageById(messageId, options = {}) {
    const id = String(messageId || '').trim();
    if (!id) return null;
    return withClient(async (client) => {
      const params = [id];
      const workspaceId = String(options.workspaceId || '').trim();
      const workspaceClause = workspaceId ? ` AND workspace_id = $${params.push(workspaceId)}` : '';
      const result = await client.query(`
        SELECT *
        FROM ${table('cloud_messages')}
        WHERE id = $1
          ${workspaceClause}
        LIMIT 1
      `, params);
      return result.rows[0] ? messageFromRow(result.rows[0]) : null;
    });
  }

  function mergeRecordsIntoState(state, key, records) {
    if (!records?.length) return;
    const byId = new Map(safeArray(state[key]).map((record) => [record?.id, record]).filter(([id]) => id));
    for (const record of records) byId.set(record.id, record);
    state[key] = [...byId.values()].sort(compareRecordCreatedAsc);
  }

  function resolveHydrationSpaceId(state, workspaceId, cleanSpaceType, requestedSpaceId = '') {
    const explicit = String(requestedSpaceId || '').trim();
    if (cleanSpaceType === 'dm') {
      if (explicit) return explicit;
      return safeArray(state.dms).find((dm) => String(dm?.workspaceId || '') === workspaceId)?.id || '';
    }
    const channels = safeArray(state.channels).filter((channel) => String(channel?.workspaceId || '') === workspaceId && !channel.archived);
    if (explicit && explicit !== 'chan_all') return explicit;
    const allChannel = channels.find((channel) => (
      channel.locked
      || channel.defaultChannel
      || String(channel.id || '') === 'chan_all'
      || String(channel.name || '').trim().toLowerCase() === 'all'
    ));
    return allChannel?.id || explicit || channels[0]?.id || '';
  }

  async function loadConversationWindowIntoState(state, options = {}) {
    const cloud = state.cloud || {};
    const workspaceId = String(options.workspaceId || defaultWorkspaceId(state, cloud) || fallbackWorkspaceId(cloud) || '').trim();
    const cleanSpaceType = spaceType(options.spaceType);
    const spaceId = resolveHydrationSpaceId(state, workspaceId, cleanSpaceType, options.spaceId);
    const result = { messages: null, replies: null };
    if (workspaceId && spaceId) {
      result.messages = await listSpaceMessagesPage({
        workspaceId,
        spaceType: cleanSpaceType,
        spaceId,
        limit: options.messageLimit || MESSAGE_PAGE_DEFAULT_LIMIT,
      });
      mergeRecordsIntoState(state, 'messages', result.messages.messages);
    }
    const threadMessageId = String(options.threadMessageId || '').trim();
    if (workspaceId && threadMessageId) {
      const parent = safeArray(state.messages).find((message) => message.id === threadMessageId)
        || await getMessageById(threadMessageId, { workspaceId });
      if (parent) {
        mergeRecordsIntoState(state, 'messages', [parent]);
        result.replies = await listThreadRepliesPage({
          workspaceId,
          parentMessageId: parent.id,
          limit: options.replyLimit || MESSAGE_PAGE_DEFAULT_LIMIT,
        });
        mergeRecordsIntoState(state, 'replies', result.replies.replies);
      }
    }
    state.updatedAt = requiredIso();
    return result;
  }

  async function replaceWorkspaceRuntimeRows(client, state, cloud, scopeWorkspaceIds = null) {
    const allWorkspaceIds = workspaceIds(cloud);
    const requestedIds = safeArray(scopeWorkspaceIds).map(String).filter(Boolean);
    const ids = requestedIds.length
      ? requestedIds.filter((id) => allWorkspaceIds.includes(id))
      : allWorkspaceIds;
    if (!ids.length) return;
    const inScope = (workspaceId) => ids.includes(String(workspaceId || ''));
    const computerIds = new Set(safeArray(state.computers).map((computer) => computer.id).filter(Boolean));
    const agentIds = new Set(safeArray(state.agents).map((agent) => agent.id).filter(Boolean));
    const taskIds = new Set(safeArray(state.tasks).map((task) => task.id).filter(Boolean));
    const messageIds = new Set(safeArray(state.messages).map((message) => message.id).filter(Boolean));
    const runtimeTables = [
      'cloud_state_records',
      'cloud_work_items',
      'cloud_tasks',
      'cloud_dms',
      'cloud_channels',
      'cloud_attachments',
    ];
    await client.query(`
      WITH ${runtimeTables.map((tableToClear, index) => `
        cleared_${index} AS (
          DELETE FROM ${table(tableToClear)}
          WHERE workspace_id = ANY($1::text[])
          RETURNING 1
        )`).join(',')}
      SELECT 1
    `, [ids]);

    const humanRows = [];
    const agentRows = [];
    const channelRows = [];
    const dmRows = [];
    const messageRows = [];
    const replyRows = [];
    const taskRows = [];
    const workItemRows = [];
    const attachmentRows = [];
    const stateRecordRows = [];

    for (const human of safeArray(state.humans)) {
      const workspaceId = workspaceIdFor(human, state, cloud);
      if (!workspaceId || !inScope(workspaceId)) continue;
      const durableStatus = humanStatus(human.status);
      humanRows.push([
        human.id,
        workspaceId,
        userIdForHuman(human, cloud),
        human.name || '',
        human.email || '',
        roleForHuman(human, cloud),
        durableStatus,
        human.avatar || human.avatarUrl || '',
        human.description || '',
        iso(human.lastSeenAt || human.presenceUpdatedAt),
        requiredIso(human.createdAt),
        requiredIso(human.updatedAt || human.createdAt),
        JSON.stringify(metadataWithState(human, { status: durableStatus })),
      ]);
    }

    for (const agent of safeArray(state.agents)) {
      const workspaceId = workspaceIdFor(agent, state, cloud);
      if (!workspaceId || !inScope(workspaceId)) continue;
      const durableStatus = agentStatus(agent.status);
      agentRows.push([
        agent.id,
        workspaceId,
        computerIds.has(agent.computerId) ? agent.computerId : null,
        agent.name || agent.handle || agent.id,
        agent.handle || '',
        agent.description || '',
        agent.runtimeId || agent.runtime || '',
        agent.model || '',
        agent.reasoningEffort || '',
        durableStatus,
        agent.workspacePath || agent.workspace || '',
        agent.createdByUserId || null,
        requiredIso(agent.createdAt),
        requiredIso(agent.updatedAt || agent.createdAt),
        iso(agent.statusUpdatedAt),
        JSON.stringify(metadataWithState(agent, {
          status: durableStatus,
          activeWorkItemIds: [],
          runtimeActivity: null,
        })),
      ]);
    }

    for (const channel of safeArray(state.channels)) {
      const workspaceId = workspaceIdFor(channel, state, cloud);
      if (!workspaceId || !inScope(workspaceId)) continue;
      channelRows.push([
        channel.id,
        workspaceId,
        channel.name || channel.id,
        channel.description || '',
        iso(channel.archivedAt || (channel.archived ? channel.updatedAt : null)),
        requiredIso(channel.createdAt),
        requiredIso(channel.updatedAt || channel.createdAt),
        JSON.stringify(metadataWithState(channel)),
      ]);
    }

    for (const dm of safeArray(state.dms)) {
      const workspaceId = workspaceIdFor(dm, state, cloud);
      if (!workspaceId || !inScope(workspaceId)) continue;
      dmRows.push([
        dm.id,
        workspaceId,
        JSON.stringify(safeArray(dm.participantIds)),
        requiredIso(dm.createdAt),
        requiredIso(dm.updatedAt || dm.createdAt),
        JSON.stringify(metadataWithState(dm)),
      ]);
    }

    for (const message of safeArray(state.messages)) {
      const workspaceId = workspaceIdFor(message, state, cloud);
      if (!workspaceId || !inScope(workspaceId)) continue;
      messageRows.push([
        message.id,
        workspaceId,
        spaceType(message.spaceType),
        message.spaceId || '',
        authorType(message.authorType),
        message.authorId || '',
        message.body || '',
        JSON.stringify(safeArray(message.attachmentIds)),
        JSON.stringify(safeArray(message.mentionedAgentIds)),
        JSON.stringify(safeArray(message.mentionedHumanIds)),
        Number(message.replyCount || 0),
        JSON.stringify(safeArray(message.savedBy)),
        JSON.stringify(safeArray(message.readBy)),
        JSON.stringify(safeArray(message.reactions)),
        JSON.stringify(safeArray(message.followedBy)),
        requiredIso(message.createdAt),
        requiredIso(message.updatedAt || message.createdAt),
        JSON.stringify(metadataWithState(message)),
      ]);
    }

    for (const reply of safeArray(state.replies)) {
      const workspaceId = workspaceIdFor(reply, state, cloud);
      if (!workspaceId || !inScope(workspaceId) || !reply.parentMessageId || !messageIds.has(reply.parentMessageId)) continue;
      replyRows.push([
        reply.id,
        workspaceId,
        reply.parentMessageId,
        authorType(reply.authorType),
        reply.authorId || '',
        reply.body || '',
        JSON.stringify(safeArray(reply.attachmentIds)),
        JSON.stringify(safeArray(reply.mentionedAgentIds)),
        JSON.stringify(safeArray(reply.mentionedHumanIds)),
        JSON.stringify(safeArray(reply.savedBy)),
        JSON.stringify(safeArray(reply.readBy)),
        JSON.stringify(safeArray(reply.reactions)),
        requiredIso(reply.createdAt),
        requiredIso(reply.updatedAt || reply.createdAt),
        JSON.stringify(metadataWithState(reply)),
      ]);
    }

    for (const task of safeArray(state.tasks)) {
      const workspaceId = workspaceIdFor(task, state, cloud);
      if (!workspaceId || !inScope(workspaceId)) continue;
      taskRows.push([
        task.id,
        workspaceId,
        task.number || null,
        spaceType(task.spaceType),
        task.spaceId || '',
        task.title || '',
        task.body || '',
        taskStatus(task.status),
        task.createdBy || '',
        task.claimedBy || '',
        iso(task.claimedAt),
        iso(task.reviewRequestedAt),
        iso(task.completedAt),
        task.sourceMessageId || task.messageId || null,
        task.sourceReplyId || null,
        task.threadMessageId || null,
        JSON.stringify(safeArray(task.assigneeIds)),
        JSON.stringify(safeArray(task.attachmentIds)),
        JSON.stringify(safeArray(task.localReferences)),
        JSON.stringify(safeArray(task.history)),
        requiredIso(task.createdAt),
        requiredIso(task.updatedAt || task.createdAt),
        JSON.stringify(metadataWithState(task)),
      ]);
    }

    for (const item of safeArray(state.workItems)) {
      const workspaceId = workspaceIdFor(item, state, cloud);
      if (!workspaceId || !inScope(workspaceId)) continue;
      workItemRows.push([
        item.id,
        workspaceId,
        agentIds.has(item.agentId) ? item.agentId : null,
        taskIds.has(item.taskId) ? item.taskId : null,
        item.messageId || item.sourceMessageId || null,
        item.parentMessageId || null,
        item.status || 'queued',
        JSON.stringify(jsonObject(item.target)),
        JSON.stringify(jsonObject(item.payload)),
        Number(item.sendCount || 0),
        requiredIso(item.createdAt),
        requiredIso(item.updatedAt || item.createdAt),
        iso(item.completedAt || item.respondedAt),
        JSON.stringify(metadataWithState(item)),
      ]);
    }

    for (const attachment of safeArray(state.attachments)) {
      const workspaceId = workspaceIdFor(attachment, state, cloud);
      if (!workspaceId || !inScope(workspaceId)) continue;
      attachmentRows.push([
        attachment.id,
        workspaceId,
        attachment.storageKey || attachment.path || attachment.url || attachment.id,
        attachment.storageMode || 'pvc',
        attachment.filename || attachment.name || attachment.id,
        attachment.mimeType || attachment.type || '',
        Number(attachment.sizeBytes || attachment.size || 0),
        attachment.checksumSha256 || '',
        attachment.source || 'upload',
        attachment.createdBy || attachment.authorId || '',
        requiredIso(attachment.createdAt),
        JSON.stringify(metadataWithState(attachment)),
      ]);
    }

    for (const key of DURABLE_STATE_RECORD_ARRAY_KEYS) {
      const records = safeArray(state[key]);
      for (let position = 0; position < records.length; position += 1) {
        const record = records[position];
        const workspaceId = workspaceIdFor(record, state, cloud);
        if (!workspaceId || !inScope(workspaceId)) continue;
        const id = record?.id || `${key}_${position}`;
        stateRecordRows.push([
          workspaceId,
          key,
          id,
          position,
          iso(record?.createdAt),
          iso(record?.updatedAt),
          JSON.stringify(record),
        ]);
      }
    }
    for (const key of DURABLE_STATE_RECORD_OBJECT_KEYS) {
      const value = state[key];
      if (!value || typeof value !== 'object') continue;
      const workspaceId = workspaceIdFor(value, state, cloud);
      if (!workspaceId || !inScope(workspaceId)) continue;
      stateRecordRows.push([
        workspaceId,
        key,
        'value',
        0,
        null,
        null,
        JSON.stringify(value),
      ]);
    }

    await client.query(`
      DELETE FROM ${table('cloud_humans')}
      WHERE workspace_id = ANY($1::text[])
        AND NOT (id = ANY($2::text[]))
    `, [ids, humanRows.map((row) => row[0])]);
    await client.query(`
      DELETE FROM ${table('cloud_agents')}
      WHERE workspace_id = ANY($1::text[])
        AND NOT (id = ANY($2::text[]))
    `, [ids, agentRows.map((row) => row[0])]);

    await batchInsertRows(client, 'cloud_humans', [
      'id',
      'workspace_id',
      'user_id',
      'name',
      'email',
      'role',
      'status',
      'avatar',
      'description',
      'last_seen_at',
      'created_at',
      'updated_at',
      'metadata',
    ], humanRows, { metadata: '::jsonb' }, humanRuntimeConflictSuffix());
    await batchInsertRows(client, 'cloud_agents', [
      'id',
      'workspace_id',
      'computer_id',
      'name',
      'handle',
      'description',
      'runtime',
      'model',
      'reasoning_effort',
      'status',
      'workspace_path',
      'created_by',
      'created_at',
      'updated_at',
      'status_updated_at',
      'metadata',
    ], agentRows, { metadata: '::jsonb' }, agentRuntimeConflictSuffix());
    await batchInsertRows(client, 'cloud_channels', [
      'id',
      'workspace_id',
      'name',
      'description',
      'archived_at',
      'created_at',
      'updated_at',
      'metadata',
    ], channelRows, { metadata: '::jsonb' });
    await batchInsertRows(client, 'cloud_dms', [
      'id',
      'workspace_id',
      'participant_ids',
      'created_at',
      'updated_at',
      'metadata',
    ], dmRows, { participant_ids: '::jsonb', metadata: '::jsonb' });
    await batchInsertRows(client, 'cloud_messages', [
      'id',
      'workspace_id',
      'space_type',
      'space_id',
      'author_type',
      'author_id',
      'body',
      'attachment_ids',
      'mentioned_agent_ids',
      'mentioned_human_ids',
      'reply_count',
      'saved_by',
      'read_by',
      'reactions',
      'followed_by',
      'created_at',
      'updated_at',
      'metadata',
    ], messageRows, {
      attachment_ids: '::jsonb',
      mentioned_agent_ids: '::jsonb',
      mentioned_human_ids: '::jsonb',
      saved_by: '::jsonb',
      read_by: '::jsonb',
      reactions: '::jsonb',
      followed_by: '::jsonb',
      metadata: '::jsonb',
    }, messageRuntimeConflictSuffix());
    await batchInsertRows(client, 'cloud_replies', [
      'id',
      'workspace_id',
      'parent_message_id',
      'author_type',
      'author_id',
      'body',
      'attachment_ids',
      'mentioned_agent_ids',
      'mentioned_human_ids',
      'saved_by',
      'read_by',
      'reactions',
      'created_at',
      'updated_at',
      'metadata',
    ], replyRows, {
      attachment_ids: '::jsonb',
      mentioned_agent_ids: '::jsonb',
      mentioned_human_ids: '::jsonb',
      saved_by: '::jsonb',
      read_by: '::jsonb',
      reactions: '::jsonb',
      metadata: '::jsonb',
    }, replyRuntimeConflictSuffix());
    await batchInsertRows(client, 'cloud_tasks', [
      'id',
      'workspace_id',
      'number',
      'space_type',
      'space_id',
      'title',
      'body',
      'status',
      'created_by',
      'claimed_by',
      'claimed_at',
      'review_requested_at',
      'completed_at',
      'source_message_id',
      'source_reply_id',
      'thread_message_id',
      'assignee_ids',
      'attachment_ids',
      'local_references',
      'history',
      'created_at',
      'updated_at',
      'metadata',
    ], taskRows, {
      assignee_ids: '::jsonb',
      attachment_ids: '::jsonb',
      local_references: '::jsonb',
      history: '::jsonb',
      metadata: '::jsonb',
    });
    await batchInsertRows(client, 'cloud_work_items', [
      'id',
      'workspace_id',
      'agent_id',
      'task_id',
      'message_id',
      'parent_message_id',
      'status',
      'target',
      'payload',
      'send_count',
      'created_at',
      'updated_at',
      'completed_at',
      'metadata',
    ], workItemRows, { target: '::jsonb', payload: '::jsonb', metadata: '::jsonb' });
    await batchInsertRows(client, 'cloud_attachments', [
      'id',
      'workspace_id',
      'storage_key',
      'storage_mode',
      'filename',
      'mime_type',
      'size_bytes',
      'checksum_sha256',
      'source',
      'created_by',
      'created_at',
      'metadata',
    ], attachmentRows, { metadata: '::jsonb' });
    await batchUpsertStateRecords(client, stateRecordRows);
  }

  async function pruneEphemeralActivityRows(client) {
    const stateRecords = await client.query(
      `DELETE FROM ${table('cloud_state_records')} WHERE kind = ANY($1::text[])`,
      [EPHEMERAL_STATE_RECORD_KEY_LIST],
    );
    const daemonEvents = await client.query(`DELETE FROM ${table('cloud_daemon_events')}`);
    const stateRecordCount = Number(stateRecords?.rowCount || 0);
    const daemonEventCount = Number(daemonEvents?.rowCount || 0);
    if (stateRecordCount || daemonEventCount) {
      console.info(`[cloud-postgres] pruned ephemeral activity rows stateRecords=${stateRecordCount} daemonEvents=${daemonEventCount}`);
    }
  }

  async function persistFromStateNow(state) {
    const cloud = state.cloud || {};
    await withClient(async (client) => {
      await withTransaction(client, 'persistFromState', async () => {
        for (const user of safeArray(cloud.users)) {
          await upsertUserSnapshot(client, user);
        }

        const workspaceIdsForPersist = new Set(workspaceIds(cloud));
        const defaultPersistWorkspaceId = fallbackWorkspaceId(cloud);

        for (const workspace of durableCloudWorkspaces(cloud)) {
          await client.query(`
            INSERT INTO ${table('cloud_workspaces')}
              (id, slug, name, avatar, onboarding_agent_id, new_agent_greeting_enabled,
               owner_user_id, deleted_at, created_at, updated_at, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
            ON CONFLICT (id) DO UPDATE SET
              slug = EXCLUDED.slug,
              name = EXCLUDED.name,
              avatar = EXCLUDED.avatar,
              onboarding_agent_id = EXCLUDED.onboarding_agent_id,
              new_agent_greeting_enabled = EXCLUDED.new_agent_greeting_enabled,
              owner_user_id = EXCLUDED.owner_user_id,
              deleted_at = EXCLUDED.deleted_at,
              updated_at = EXCLUDED.updated_at,
              metadata = EXCLUDED.metadata
          `, [
            workspace.id,
            workspace.slug || workspace.id,
            workspace.name || workspace.slug || workspace.id,
            workspace.avatar || '',
            workspace.onboardingAgentId || '',
            workspace.newAgentGreetingEnabled !== false,
            workspace.ownerUserId || workspace.owner_user_id || null,
            iso(workspace.deletedAt),
            requiredIso(workspace.createdAt),
            requiredIso(workspace.updatedAt || workspace.createdAt),
            JSON.stringify(jsonObject(workspace.metadata)),
          ]);
        }

        for (const member of safeArray(cloud.workspaceMembers).filter((item) => workspaceIdsForPersist.has(item?.workspaceId))) {
          await client.query(`
            INSERT INTO ${table('cloud_workspace_members')}
              (id, workspace_id, user_id, human_id, role, status, joined_at,
               created_at, updated_at, removed_at, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
            ON CONFLICT (id) DO UPDATE SET
              workspace_id = EXCLUDED.workspace_id,
              user_id = EXCLUDED.user_id,
              human_id = EXCLUDED.human_id,
              role = EXCLUDED.role,
              status = EXCLUDED.status,
              joined_at = EXCLUDED.joined_at,
              updated_at = EXCLUDED.updated_at,
              removed_at = EXCLUDED.removed_at,
              metadata = EXCLUDED.metadata
          `, [
            member.id,
            member.workspaceId,
            member.userId,
            member.humanId || null,
            member.role || 'member',
            member.status || 'active',
            iso(member.joinedAt),
            requiredIso(member.createdAt),
            requiredIso(member.updatedAt || member.createdAt),
            iso(member.removedAt),
            JSON.stringify(jsonObject(member.metadata)),
          ]);
        }

        await batchInsertRows(client, 'cloud_sessions', [
          'id',
          'user_id',
          'token_hash',
          'created_at',
          'expires_at',
          'user_agent',
          'ip_hash',
          'revoked_at',
          'last_seen_at',
          'metadata',
        ], safeArray(cloud.sessions).filter((session) => session?.id).map((session) => [
          session.id,
          session.userId,
          session.tokenHash,
          requiredIso(session.createdAt),
          requiredIso(session.expiresAt),
          session.userAgent || '',
          session.ipHash || '',
          iso(session.revokedAt),
          iso(session.lastSeenAt),
          JSON.stringify(jsonObject(session.metadata)),
        ]), { metadata: '::jsonb' }, `
          ON CONFLICT (id) DO UPDATE SET
            expires_at = LEAST(${table('cloud_sessions')}.expires_at, EXCLUDED.expires_at),
            revoked_at = COALESCE(${table('cloud_sessions')}.revoked_at, EXCLUDED.revoked_at),
            last_seen_at = COALESCE(EXCLUDED.last_seen_at, ${table('cloud_sessions')}.last_seen_at),
            metadata = ${table('cloud_sessions')}.metadata || EXCLUDED.metadata
        `);

        for (const invitation of safeArray(cloud.invitations)) {
          if (!workspaceIdsForPersist.has(invitation?.workspaceId)) continue;
          await client.query(`
              INSERT INTO ${table('cloud_invitations')}
                (id, workspace_id, human_id, email, normalized_email, role, token_hash,
                 invited_by, expires_at, accepted_at, accepted_by, revoked_at, created_at, metadata)
              VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
              ON CONFLICT (id) DO UPDATE SET
                workspace_id = EXCLUDED.workspace_id,
                human_id = EXCLUDED.human_id,
                email = EXCLUDED.email,
                normalized_email = EXCLUDED.normalized_email,
                role = EXCLUDED.role,
                token_hash = EXCLUDED.token_hash,
                invited_by = EXCLUDED.invited_by,
                expires_at = EXCLUDED.expires_at,
                accepted_at = EXCLUDED.accepted_at,
                accepted_by = EXCLUDED.accepted_by,
                revoked_at = EXCLUDED.revoked_at,
                metadata = EXCLUDED.metadata
            `, [
              invitation.id,
              invitation.workspaceId,
              invitation.humanId || null,
              invitation.email,
              normalizeEmail(invitation.email),
              invitation.role || 'member',
              invitation.tokenHash,
              invitation.invitedBy || null,
              requiredIso(invitation.expiresAt),
              iso(invitation.acceptedAt),
              invitation.acceptedBy || null,
              iso(invitation.revokedAt),
              requiredIso(invitation.createdAt),
              JSON.stringify(jsonObject(invitation.metadata)),
          ]);
        }

        for (const reset of safeArray(cloud.passwordResetTokens)) {
          await upsertPasswordReset(client, reset);
        }

        for (const joinLink of safeArray(cloud.joinLinks)) {
          if (!workspaceIdsForPersist.has(joinLink?.workspaceId)) continue;
          await client.query(`
            INSERT INTO ${table('cloud_join_links')}
              (id, workspace_id, token_hash, max_uses, used_count, expires_at,
               revoked_at, revoked_by, created_by, created_at, updated_at, metadata)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
            ON CONFLICT (id) DO UPDATE SET
              workspace_id = EXCLUDED.workspace_id,
              token_hash = EXCLUDED.token_hash,
              max_uses = EXCLUDED.max_uses,
              used_count = EXCLUDED.used_count,
              expires_at = EXCLUDED.expires_at,
              revoked_at = EXCLUDED.revoked_at,
              revoked_by = EXCLUDED.revoked_by,
              updated_at = EXCLUDED.updated_at,
              metadata = EXCLUDED.metadata
          `, [
            joinLink.id,
            joinLink.workspaceId,
            joinLink.tokenHash,
            Number(joinLink.maxUses || 0),
            Number(joinLink.usedCount || 0),
            iso(joinLink.expiresAt),
            iso(joinLink.revokedAt),
            joinLink.revokedBy || null,
            joinLink.createdBy || null,
            requiredIso(joinLink.createdAt),
            requiredIso(joinLink.updatedAt || joinLink.createdAt),
            JSON.stringify(jsonObject(joinLink.metadata)),
          ]);
        }

        const computersForPersist = [...safeArray(state.computers)];
        const computerIdsForPersist = new Set(computersForPersist.map((computer) => computer?.id).filter(Boolean));
        for (const pair of safeArray(cloud.pairingTokens)) {
          const provisionalComputer = pair?.metadata?.provisionalComputer && jsonObject(pair.metadata.computer);
          if (!pair?.computerId || !provisionalComputer?.id || computerIdsForPersist.has(pair.computerId)) continue;
          const workspaceId = pair.workspaceId || provisionalComputer.workspaceId || defaultPersistWorkspaceId;
          if (!workspaceId || !workspaceIdsForPersist.has(workspaceId)) continue;
          computersForPersist.push({
            ...provisionalComputer,
            id: pair.computerId,
            workspaceId,
            status: provisionalComputer.status || 'pairing',
            connectedVia: provisionalComputer.connectedVia || 'daemon',
            createdAt: provisionalComputer.createdAt || pair.createdAt,
            updatedAt: provisionalComputer.updatedAt || pair.createdAt,
          });
          computerIdsForPersist.add(pair.computerId);
          console.warn(`[postgres-store] restored provisional pairing computer computer=${pair.computerId} workspace=${workspaceId}`);
        }

        const runtimeWorkspaceIdsForPersist = workspaceIds(cloud);
        if (runtimeWorkspaceIdsForPersist.length) {
          await client.query(`
            DELETE FROM ${table('cloud_computers')}
            WHERE workspace_id = ANY($1::text[])
              AND NOT (id = ANY($2::text[]))
          `, [runtimeWorkspaceIdsForPersist, [...computerIdsForPersist]]);
        }

        const computerRows = [];
        for (const computer of computersForPersist) {
          const workspaceId = computer.workspaceId || defaultPersistWorkspaceId;
          if (!workspaceId || !workspaceIdsForPersist.has(workspaceId)) continue;
          computerRows.push([
            computer.id,
            workspaceId,
            computer.name || computer.hostname || computer.id,
            computer.hostname || '',
            computer.os || '',
            computer.arch || '',
            computer.daemonVersion || '',
            computerStatus(computer.status),
            computer.connectedVia || 'daemon',
            JSON.stringify(safeArray(computer.runtimeIds)),
            JSON.stringify(safeArray(computer.runtimeDetails)),
            JSON.stringify(safeArray(computer.capabilities)),
            JSON.stringify(safeArray(computer.runningAgents)),
            computer.machineFingerprint || computer.fingerprint || '',
            computer.createdBy || null,
            requiredIso(computer.createdAt),
            requiredIso(computer.updatedAt || computer.createdAt),
            iso(computer.lastSeenAt),
            iso(computer.daemonConnectedAt),
            iso(computer.disconnectedAt),
            iso(computer.disabledAt),
            JSON.stringify(jsonObject(computer.metadata)),
          ]);
        }
        await batchInsertRows(client, 'cloud_computers', [
          'id',
          'workspace_id',
          'name',
          'hostname',
          'os',
          'arch',
          'daemon_version',
          'status',
          'connected_via',
          'runtime_ids',
          'runtime_details',
          'capabilities',
          'running_agents',
          'machine_fingerprint',
          'created_by',
          'created_at',
          'updated_at',
          'last_seen_at',
          'daemon_connected_at',
          'disconnected_at',
          'disabled_at',
          'metadata',
        ], computerRows, {
          runtime_ids: '::jsonb',
          runtime_details: '::jsonb',
          capabilities: '::jsonb',
          running_agents: '::jsonb',
          metadata: '::jsonb',
        }, computerAuthConflictSuffix());

        await replaceWorkspaceRuntimeRows(client, state, cloud);

        const computerTokenRows = [];
        for (const token of safeArray(cloud.computerTokens)) {
          if (!token?.computerId || !computerIdsForPersist.has(token.computerId)) {
            console.warn(`[postgres-store] skipping orphan computer token token=${token.id || 'unknown'} computer=${token.computerId}`);
            continue;
          }
          const workspaceId = token.workspaceId || defaultPersistWorkspaceId;
          if (!workspaceId || !workspaceIdsForPersist.has(workspaceId)) continue;
          computerTokenRows.push([
            token.id,
            workspaceId,
            token.computerId,
            token.label || '',
            token.tokenHash,
            requiredIso(token.createdAt),
            iso(token.lastUsedAt),
            iso(token.expiresAt),
            iso(token.revokedAt),
            JSON.stringify(jsonObject(token.metadata)),
          ]);
        }
        await batchInsertRows(client, 'cloud_computer_tokens', [
          'id',
          'workspace_id',
          'computer_id',
          'label',
          'token_hash',
          'created_at',
          'last_used_at',
          'expires_at',
          'revoked_at',
          'metadata',
        ], computerTokenRows, { metadata: '::jsonb' }, `
          ON CONFLICT (id) DO UPDATE SET
            workspace_id = EXCLUDED.workspace_id,
            computer_id = EXCLUDED.computer_id,
            label = EXCLUDED.label,
            token_hash = EXCLUDED.token_hash,
            last_used_at = EXCLUDED.last_used_at,
            expires_at = EXCLUDED.expires_at,
            revoked_at = EXCLUDED.revoked_at,
            metadata = EXCLUDED.metadata
        `);

        const pairingTokenRows = [];
        for (const pair of safeArray(cloud.pairingTokens)) {
          if (!pair?.computerId || !computerIdsForPersist.has(pair.computerId)) {
            console.warn(`[postgres-store] skipping orphan pairing token token=${pair.id || 'unknown'} computer=${pair.computerId}`);
            continue;
          }
          const workspaceId = pair.workspaceId || defaultPersistWorkspaceId;
          if (!workspaceId || !workspaceIdsForPersist.has(workspaceId)) continue;
          pairingTokenRows.push([
            pair.id,
            workspaceId,
            pair.computerId,
            pair.label || '',
            pair.tokenHash,
            pair.createdBy || null,
            requiredIso(pair.createdAt),
            requiredIso(pair.expiresAt),
            iso(pair.consumedAt),
            iso(pair.revokedAt),
            JSON.stringify(jsonObject(pair.metadata)),
          ]);
        }
        await batchInsertRows(client, 'cloud_pairing_tokens', [
          'id',
          'workspace_id',
          'computer_id',
          'label',
          'token_hash',
          'created_by',
          'created_at',
          'expires_at',
          'consumed_at',
          'revoked_at',
          'metadata',
        ], pairingTokenRows, { metadata: '::jsonb' }, `
          ON CONFLICT (id) DO UPDATE SET
            workspace_id = EXCLUDED.workspace_id,
            computer_id = EXCLUDED.computer_id,
            label = EXCLUDED.label,
            token_hash = EXCLUDED.token_hash,
            created_by = EXCLUDED.created_by,
            expires_at = EXCLUDED.expires_at,
            consumed_at = EXCLUDED.consumed_at,
            revoked_at = EXCLUDED.revoked_at,
            metadata = EXCLUDED.metadata
        `);

        const deliveryRows = [];
        for (const delivery of safeArray(cloud.agentDeliveries)) {
          const workspaceId = delivery.workspaceId || defaultPersistWorkspaceId;
          if (!workspaceId || !workspaceIdsForPersist.has(workspaceId)) continue;
          deliveryRows.push([
            delivery.id,
            workspaceId,
            delivery.agentId,
            delivery.computerId,
            delivery.messageId || null,
            delivery.workItemId || null,
            Number(delivery.seq || 0),
            delivery.type || delivery.commandType || '',
            delivery.commandType || delivery.type || '',
            delivery.status || 'queued',
            delivery.idempotencyKey || delivery.idempotency_key || null,
            Number(delivery.attempts || 0),
            JSON.stringify(jsonObject(delivery.payload)),
            delivery.error || '',
            requiredIso(delivery.createdAt),
            requiredIso(delivery.updatedAt || delivery.createdAt),
            iso(delivery.sentAt),
            iso(delivery.ackedAt),
            iso(delivery.completedAt),
          ]);
        }
        await batchInsertRows(client, 'cloud_agent_deliveries', [
          'id',
          'workspace_id',
          'agent_id',
          'computer_id',
          'message_id',
          'work_item_id',
          'seq',
          'type',
          'command_type',
          'status',
          'idempotency_key',
          'attempts',
          'payload',
          'error',
          'created_at',
          'updated_at',
          'sent_at',
          'acked_at',
          'completed_at',
        ], deliveryRows, { payload: '::jsonb' }, `
          ON CONFLICT (id) DO UPDATE SET
            workspace_id = EXCLUDED.workspace_id,
            agent_id = EXCLUDED.agent_id,
            computer_id = EXCLUDED.computer_id,
            message_id = EXCLUDED.message_id,
            work_item_id = EXCLUDED.work_item_id,
            seq = EXCLUDED.seq,
            type = EXCLUDED.type,
            command_type = EXCLUDED.command_type,
            status = EXCLUDED.status,
            idempotency_key = EXCLUDED.idempotency_key,
            attempts = EXCLUDED.attempts,
            payload = EXCLUDED.payload,
            error = EXCLUDED.error,
            updated_at = EXCLUDED.updated_at,
            sent_at = EXCLUDED.sent_at,
            acked_at = EXCLUDED.acked_at,
            completed_at = EXCLUDED.completed_at
        `);

        const realtimeRows = [];
        for (const event of safeArray(cloud.realtimeEvents)) {
          const workspaceId = event.workspaceId || defaultPersistWorkspaceId;
          if (!workspaceId || !workspaceIdsForPersist.has(workspaceId)) continue;
          realtimeRows.push([
            event.id,
            workspaceId,
            Number(event.seq || 0),
            event.eventType || event.event_type || event.type || '',
            event.scopeType || event.scope_type || 'workspace',
            event.scopeId || event.scope_id || '',
            event.threadMessageId || event.thread_message_id || null,
            JSON.stringify(jsonObject(event.payload)),
            requiredIso(event.createdAt),
          ]);
        }
        await batchInsertRows(client, 'cloud_realtime_events', [
          'id',
          'workspace_id',
          'seq',
          'event_type',
          'scope_type',
          'scope_id',
          'thread_message_id',
          'payload',
          'created_at',
        ], realtimeRows, { payload: '::jsonb' }, `
          ON CONFLICT (id) DO UPDATE SET
            workspace_id = EXCLUDED.workspace_id,
            seq = EXCLUDED.seq,
            event_type = EXCLUDED.event_type,
            scope_type = EXCLUDED.scope_type,
            scope_id = EXCLUDED.scope_id,
            thread_message_id = EXCLUDED.thread_message_id,
            payload = EXCLUDED.payload,
            created_at = EXCLUDED.created_at
        `);

      });
    });
  }

  async function persistWorkspaceFromStateNow(state, workspaceId) {
    const cloud = state.cloud || {};
    const cleanWorkspaceId = String(workspaceId || '').trim();
    if (!cleanWorkspaceId) return;
    await withClient(async (client) => {
      await withTransaction(client, 'persistWorkspaceFromState', async () => {
        await replaceWorkspaceRuntimeRows(client, state, cloud, [cleanWorkspaceId]);
      });
    });
  }

  async function persistFromStateWithRetry(state) {
    const retryDelaysMs = [250, 750, 1500];
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await persistFromStateNow(state);
      } catch (error) {
        if (!isTransientPostgresPersistError(error) || attempt >= retryDelaysMs.length) throw error;
        const delayMs = retryDelaysMs[attempt];
        console.warn(
          `[cloud-postgres] retrying persistFromState after transient error `
          + `attempt=${attempt + 1} code=${postgresPoolErrorCode(error)} delayMs=${delayMs} `
          + `message=${postgresPoolErrorMessage(error)}`,
        );
        await sleep(delayMs);
      }
    }
  }

  function persistFromState(state) {
    const snapshot = cloneRecord(state);
    const next = persistQueue.then(
      () => persistFromStateWithRetry(snapshot),
      () => persistFromStateWithRetry(snapshot),
    );
    persistQueue = next.catch(() => {});
    return next;
  }

  function persistWorkspaceFromState(state, workspaceId) {
    const snapshot = cloneRecord(state);
    const cleanWorkspaceId = String(workspaceId || '').trim();
    const next = persistQueue.then(
      () => persistWorkspaceFromStateNow(snapshot, cleanWorkspaceId),
      () => persistWorkspaceFromStateNow(snapshot, cleanWorkspaceId),
    );
    persistQueue = next.catch(() => {});
    return next;
  }

  async function deleteComputerNow(computerId, workspaceId = '') {
    const cleanComputerId = String(computerId || '').trim();
    const cleanWorkspaceId = String(workspaceId || '').trim();
    if (!cleanComputerId) return;
    await withClient(async (client) => {
      await withTransaction(client, 'deleteComputer', async () => {
        await client.query(`
          DELETE FROM ${table('cloud_computers')}
          WHERE id = $1
            AND ($2::text = '' OR workspace_id = $2)
        `, [cleanComputerId, cleanWorkspaceId]);
      });
    });
  }

  function deleteComputer(computerId, workspaceId = '') {
    const cleanComputerId = String(computerId || '').trim();
    const cleanWorkspaceId = String(workspaceId || '').trim();
    const next = persistQueue.then(
      () => deleteComputerNow(cleanComputerId, cleanWorkspaceId),
      () => deleteComputerNow(cleanComputerId, cleanWorkspaceId),
    );
    persistQueue = next.catch(() => {});
    return next;
  }

  async function persistAuthFromStateNow(state) {
    const cloud = state.cloud || {};
    const users = safeArray(cloud.users).map(cloneRecord);
    const workspaces = durableCloudWorkspaces(cloud).map(cloneRecord);
    const workspaceIdsForAuth = new Set(workspaces.map((workspace) => workspace.id).filter(Boolean));
    const defaultAuthWorkspaceId = workspaces[0]?.id || '';
    const workspaceMembers = safeArray(cloud.workspaceMembers)
      .filter((member) => workspaceIdsForAuth.has(member?.workspaceId))
      .map(cloneRecord);
    const sessions = safeArray(cloud.sessions).map(cloneRecord);

    await withClient(async (client) => {
      await withTransaction(client, 'persistAuthFromState', async () => {
        await batchInsertRows(client, 'cloud_users', [
          'id',
          'email',
          'normalized_email',
          'name',
          'password_hash',
          'avatar_url',
          'third_party_name',
          'third_party_provider',
          'language',
          'email_verified_at',
          'created_at',
          'updated_at',
          'last_login_at',
          'disabled_at',
          'metadata',
        ], users.filter((user) => user?.id).map((user) => [
          user.id,
          user.email,
          normalizedEmailForUserRow(user),
          user.name || '',
          user.passwordHash || null,
          user.avatarUrl || '',
          user.thirdPartyName || '',
          user.thirdPartyProvider || '',
          user.language || 'en',
          iso(user.emailVerifiedAt),
          requiredIso(user.createdAt),
          requiredIso(user.updatedAt || user.createdAt),
          iso(user.lastLoginAt),
          iso(user.disabledAt),
          JSON.stringify(jsonObject(user.metadata)),
        ]), { metadata: '::jsonb' }, `
          ON CONFLICT (id) DO UPDATE SET
            email = EXCLUDED.email,
            normalized_email = EXCLUDED.normalized_email,
            name = EXCLUDED.name,
            password_hash = COALESCE(${table('cloud_users')}.password_hash, EXCLUDED.password_hash),
            avatar_url = EXCLUDED.avatar_url,
            third_party_name = EXCLUDED.third_party_name,
            third_party_provider = EXCLUDED.third_party_provider,
            language = EXCLUDED.language,
            email_verified_at = COALESCE(${table('cloud_users')}.email_verified_at, EXCLUDED.email_verified_at),
            updated_at = GREATEST(COALESCE(${table('cloud_users')}.updated_at, EXCLUDED.updated_at), EXCLUDED.updated_at),
            last_login_at = CASE
              WHEN EXCLUDED.last_login_at IS NULL THEN ${table('cloud_users')}.last_login_at
              ELSE GREATEST(COALESCE(${table('cloud_users')}.last_login_at, EXCLUDED.last_login_at), EXCLUDED.last_login_at)
            END,
            disabled_at = COALESCE(${table('cloud_users')}.disabled_at, EXCLUDED.disabled_at),
            metadata = ${table('cloud_users')}.metadata || EXCLUDED.metadata
        `);

        await batchInsertRows(client, 'cloud_sessions', [
          'id',
          'user_id',
          'token_hash',
          'created_at',
          'expires_at',
          'user_agent',
          'ip_hash',
          'revoked_at',
          'last_seen_at',
          'metadata',
        ], sessions.filter((session) => session?.id).map((session) => [
          session.id,
          session.userId,
          session.tokenHash,
          requiredIso(session.createdAt),
          requiredIso(session.expiresAt),
          session.userAgent || '',
          session.ipHash || '',
          iso(session.revokedAt),
          iso(session.lastSeenAt),
          JSON.stringify(jsonObject(session.metadata)),
        ]), { metadata: '::jsonb' }, `
          ON CONFLICT (id) DO UPDATE SET
            expires_at = LEAST(${table('cloud_sessions')}.expires_at, EXCLUDED.expires_at),
            revoked_at = COALESCE(${table('cloud_sessions')}.revoked_at, EXCLUDED.revoked_at),
            last_seen_at = COALESCE(EXCLUDED.last_seen_at, ${table('cloud_sessions')}.last_seen_at),
            metadata = ${table('cloud_sessions')}.metadata || EXCLUDED.metadata
        `);

        await batchInsertRows(client, 'cloud_workspaces', [
          'id',
          'slug',
          'name',
          'avatar',
          'onboarding_agent_id',
          'new_agent_greeting_enabled',
          'owner_user_id',
          'deleted_at',
          'created_at',
          'updated_at',
          'metadata',
        ], workspaces.filter((workspace) => workspace?.id).map((workspace) => [
          workspace.id,
          workspace.slug || workspace.id,
          workspace.name || workspace.slug || workspace.id,
          workspace.avatar || '',
          workspace.onboardingAgentId || '',
          workspace.newAgentGreetingEnabled !== false,
          workspace.ownerUserId || workspace.owner_user_id || null,
          iso(workspace.deletedAt),
          requiredIso(workspace.createdAt),
          requiredIso(workspace.updatedAt || workspace.createdAt),
          JSON.stringify(jsonObject(workspace.metadata)),
        ]), { metadata: '::jsonb' }, `
          ON CONFLICT (id) DO UPDATE SET
            slug = EXCLUDED.slug,
            name = EXCLUDED.name,
            avatar = EXCLUDED.avatar,
            onboarding_agent_id = EXCLUDED.onboarding_agent_id,
            new_agent_greeting_enabled = EXCLUDED.new_agent_greeting_enabled,
            owner_user_id = EXCLUDED.owner_user_id,
            deleted_at = EXCLUDED.deleted_at,
            updated_at = EXCLUDED.updated_at,
            metadata = EXCLUDED.metadata
        `);

        await batchInsertRows(client, 'cloud_workspace_members', [
          'id',
          'workspace_id',
          'user_id',
          'human_id',
          'role',
          'status',
          'joined_at',
          'created_at',
          'updated_at',
          'removed_at',
          'metadata',
        ], workspaceMembers.filter((member) => member?.id).map((member) => [
          member.id,
          member.workspaceId,
          member.userId,
          member.humanId || null,
          member.role || 'member',
          member.status || 'active',
          iso(member.joinedAt),
          requiredIso(member.createdAt),
          requiredIso(member.updatedAt || member.createdAt),
          iso(member.removedAt),
          JSON.stringify(jsonObject(member.metadata)),
        ]), { metadata: '::jsonb' }, `
          ON CONFLICT (id) DO UPDATE SET
            workspace_id = EXCLUDED.workspace_id,
            user_id = EXCLUDED.user_id,
            human_id = EXCLUDED.human_id,
            role = EXCLUDED.role,
            status = EXCLUDED.status,
            joined_at = EXCLUDED.joined_at,
            updated_at = EXCLUDED.updated_at,
            removed_at = EXCLUDED.removed_at,
            metadata = EXCLUDED.metadata
        `);

        const computersForAuth = safeArray(state.computers);
        const computerIdsForAuth = new Set(computersForAuth.map((computer) => computer?.id).filter(Boolean));
        await batchInsertRows(client, 'cloud_computers', [
          'id',
          'workspace_id',
          'name',
          'hostname',
          'os',
          'arch',
          'daemon_version',
          'status',
          'connected_via',
          'runtime_ids',
          'runtime_details',
          'capabilities',
          'running_agents',
          'machine_fingerprint',
          'created_by',
          'created_at',
          'updated_at',
          'last_seen_at',
          'daemon_connected_at',
          'disconnected_at',
          'disabled_at',
          'metadata',
        ], computersForAuth
          .map((computer) => ({ computer, workspaceId: computer?.workspaceId || defaultAuthWorkspaceId }))
          .filter(({ computer, workspaceId }) => computer?.id && workspaceId && workspaceIdsForAuth.has(workspaceId))
          .map(({ computer, workspaceId }) => [
          computer.id,
          workspaceId,
          computer.name || computer.hostname || computer.id,
          computer.hostname || '',
          computer.os || '',
          computer.arch || '',
          computer.daemonVersion || '',
          computerStatus(computer.status),
          computer.connectedVia || 'daemon',
          JSON.stringify(safeArray(computer.runtimeIds)),
          JSON.stringify(safeArray(computer.runtimeDetails)),
          JSON.stringify(safeArray(computer.capabilities)),
          JSON.stringify(safeArray(computer.runningAgents)),
          computer.machineFingerprint || computer.fingerprint || '',
          computer.createdBy || null,
          requiredIso(computer.createdAt),
          requiredIso(computer.updatedAt || computer.createdAt),
          iso(computer.lastSeenAt),
          iso(computer.daemonConnectedAt),
          iso(computer.disconnectedAt),
          iso(computer.disabledAt),
          JSON.stringify(jsonObject(computer.metadata)),
        ]), {
          runtime_ids: '::jsonb',
          runtime_details: '::jsonb',
          capabilities: '::jsonb',
          running_agents: '::jsonb',
          metadata: '::jsonb',
        }, computerAuthConflictSuffix());

        await batchInsertRows(client, 'cloud_computer_tokens', [
          'id',
          'workspace_id',
          'computer_id',
          'label',
          'token_hash',
          'created_at',
          'last_used_at',
          'expires_at',
          'revoked_at',
          'metadata',
        ], safeArray(cloud.computerTokens)
          .map((token) => ({ token, workspaceId: token?.workspaceId || defaultAuthWorkspaceId }))
          .filter(({ token, workspaceId }) => token?.id && computerIdsForAuth.has(token.computerId) && workspaceId && workspaceIdsForAuth.has(workspaceId))
          .map(({ token, workspaceId }) => [
          token.id,
          workspaceId,
          token.computerId,
          token.label || '',
          token.tokenHash,
          requiredIso(token.createdAt),
          iso(token.lastUsedAt),
          iso(token.expiresAt),
          iso(token.revokedAt),
          JSON.stringify(jsonObject(token.metadata)),
        ]), { metadata: '::jsonb' }, `
          ON CONFLICT (id) DO UPDATE SET
            workspace_id = EXCLUDED.workspace_id,
            computer_id = EXCLUDED.computer_id,
            label = EXCLUDED.label,
            token_hash = EXCLUDED.token_hash,
            last_used_at = EXCLUDED.last_used_at,
            expires_at = EXCLUDED.expires_at,
            revoked_at = EXCLUDED.revoked_at,
            metadata = EXCLUDED.metadata
        `);

        await batchInsertRows(client, 'cloud_pairing_tokens', [
          'id',
          'workspace_id',
          'computer_id',
          'label',
          'token_hash',
          'created_by',
          'created_at',
          'expires_at',
          'consumed_at',
          'revoked_at',
          'metadata',
        ], safeArray(cloud.pairingTokens)
          .map((pair) => ({ pair, workspaceId: pair?.workspaceId || defaultAuthWorkspaceId }))
          .filter(({ pair, workspaceId }) => pair?.id && computerIdsForAuth.has(pair.computerId) && workspaceId && workspaceIdsForAuth.has(workspaceId))
          .map(({ pair, workspaceId }) => [
          pair.id,
          workspaceId,
          pair.computerId,
          pair.label || '',
          pair.tokenHash,
          pair.createdBy || null,
          requiredIso(pair.createdAt),
          requiredIso(pair.expiresAt),
          iso(pair.consumedAt),
          iso(pair.revokedAt),
          JSON.stringify(jsonObject(pair.metadata)),
        ]), { metadata: '::jsonb' }, `
          ON CONFLICT (id) DO UPDATE SET
            workspace_id = EXCLUDED.workspace_id,
            computer_id = EXCLUDED.computer_id,
            label = EXCLUDED.label,
            token_hash = EXCLUDED.token_hash,
            created_by = EXCLUDED.created_by,
            expires_at = EXCLUDED.expires_at,
            consumed_at = EXCLUDED.consumed_at,
            revoked_at = EXCLUDED.revoked_at,
            metadata = EXCLUDED.metadata
        `);

      });
    });
  }

  function persistAuthFromState(state) {
    const snapshot = cloneRecord(state);
    const next = persistQueue.then(
      () => persistAuthFromStateNow(snapshot),
      () => persistAuthFromStateNow(snapshot),
    );
    persistQueue = next.catch(() => {});
    return next;
  }

  async function persistAuthOperationNow(operation) {
    await withClient(async (client) => {
      await withTransaction(client, 'persistAuthOperation', async () => {
        switch (operation.type) {
          case 'register-open-account':
          case 'oauth-login':
            await upsertUserSnapshot(client, operation.user);
            await upsertSession(client, operation.session);
            break;
          case 'login':
            await updateLoginUser(client, operation.user);
            await upsertSession(client, operation.session);
            break;
          case 'password-update':
            await updateUserPassword(client, operation.user);
            break;
          case 'logout':
            await upsertSession(client, operation.session);
            break;
          case 'password-reset-request':
            await updateUserPassword(client, operation.user);
            for (const reset of operation.passwordResetTokens) {
              await upsertPasswordReset(client, reset);
            }
            if (operation.reset) await upsertPasswordReset(client, operation.reset);
            for (const session of operation.sessions) {
              await upsertSession(client, session);
            }
            break;
          case 'password-reset-complete':
            await updateUserPassword(client, operation.user);
            await upsertPasswordReset(client, operation.reset);
            await upsertSession(client, operation.session);
            break;
          default:
            throw new Error(`Unsupported auth operation: ${operation.type || 'unknown'}`);
        }
      });
    });
  }

  function persistAuthOperation(operation) {
    const snapshot = snapshotAuthOperation(operation);
    const next = persistQueue.then(
      () => persistAuthOperationNow(snapshot),
      () => persistAuthOperationNow(snapshot),
    );
    persistQueue = next.catch(() => {});
    return next;
  }

  async function loadIntoState(state, loadOptions = {}) {
    const cloud = state.cloud || {};
    await withClient(async (client) => {
      const workspaces = await client.query(`SELECT * FROM ${table('cloud_workspaces')} ORDER BY created_at ASC, id ASC`);
      const users = await client.query(`SELECT * FROM ${table('cloud_users')} ORDER BY created_at ASC, id ASC`);
      const members = await client.query(`SELECT * FROM ${table('cloud_workspace_members')} ORDER BY created_at ASC, id ASC`);
      const sessions = await client.query(`SELECT * FROM ${table('cloud_sessions')} ORDER BY created_at ASC, id ASC`);
      const invitations = await client.query(`SELECT * FROM ${table('cloud_invitations')} ORDER BY created_at ASC, id ASC`);
      const passwordResets = await client.query(`SELECT * FROM ${table('cloud_password_resets')} ORDER BY created_at ASC, id ASC`);
      const joinLinks = await client.query(`SELECT * FROM ${table('cloud_join_links')} ORDER BY created_at ASC, id ASC`);
      const humans = await client.query(`SELECT * FROM ${table('cloud_humans')} ORDER BY created_at ASC, id ASC`);
      const computers = await client.query(`SELECT * FROM ${table('cloud_computers')} ORDER BY created_at ASC, id ASC`);
      const agents = await client.query(`SELECT * FROM ${table('cloud_agents')} ORDER BY created_at ASC, id ASC`);
      const channels = await client.query(`SELECT * FROM ${table('cloud_channels')} ORDER BY created_at ASC, id ASC`);
      const dms = await client.query(`SELECT * FROM ${table('cloud_dms')} ORDER BY created_at ASC, id ASC`);
      const messages = await client.query(`SELECT * FROM ${table('cloud_messages')} ORDER BY created_at DESC, id DESC LIMIT $1`, [recentMessageHydrationLimit]);
      const replies = await client.query(`SELECT * FROM ${table('cloud_replies')} ORDER BY created_at DESC, id DESC LIMIT $1`, [recentReplyHydrationLimit]);
      const tasks = await client.query(`SELECT * FROM ${table('cloud_tasks')} ORDER BY created_at ASC, id ASC`);
      const workItems = await client.query(`SELECT * FROM ${table('cloud_work_items')} ORDER BY created_at ASC, id ASC`);
      const attachments = await client.query(`SELECT * FROM ${table('cloud_attachments')} ORDER BY created_at ASC, id ASC`);
      const stateRecords = await client.query(`SELECT * FROM ${table('cloud_state_records')} ORDER BY kind ASC, position ASC, id ASC`);
      const computerTokens = await client.query(`SELECT * FROM ${table('cloud_computer_tokens')} ORDER BY created_at ASC, id ASC`);
      const pairingTokens = await client.query(`SELECT * FROM ${table('cloud_pairing_tokens')} ORDER BY created_at ASC, id ASC`);
      const agentDeliveries = await client.query(`SELECT * FROM ${table('cloud_agent_deliveries')} ORDER BY created_at ASC, id ASC`);
      const realtimeEvents = await client.query(`SELECT * FROM ${table('cloud_realtime_events')} ORDER BY workspace_id ASC, seq ASC`);
      const releaseNotes = await client.query(`SELECT * FROM ${table('cloud_release_notes')} ORDER BY component ASC, released_at DESC, version DESC, category ASC, position ASC`);
      cloud.workspaces = workspaces.rows.map(workspaceFromRow);
      cloud.users = users.rows.map(userFromRow);
      cloud.workspaceMembers = members.rows.map(memberFromRow);
      cloud.sessions = sessions.rows.map(sessionFromRow);
      cloud.invitations = invitations.rows.map(invitationFromRow);
      cloud.passwordResetTokens = passwordResets.rows.map(passwordResetFromRow);
      cloud.joinLinks = joinLinks.rows.map(joinLinkFromRow);
      cloud.computerTokens = computerTokens.rows.map(computerTokenFromRow);
      cloud.pairingTokens = pairingTokens.rows.map(pairingTokenFromRow);
      cloud.agentDeliveries = agentDeliveries.rows.map(agentDeliveryFromRow);
      cloud.realtimeEvents = realtimeEvents.rows.map(realtimeEventFromRow);
      cloud.daemonEvents = [];
      const loadedComputers = computers.rows.map(computerFromRow);
      state.humans = humans.rows.map(humanFromRow);
      state.computers = loadedComputers;
      state.agents = agents.rows.map(agentFromRow);
      state.channels = channels.rows.map(channelFromRow);
      state.dms = dms.rows.map(dmFromRow);
      state.messages = messages.rows.map(messageFromRow).sort(compareRecordCreatedAsc);
      state.replies = replies.rows.map(replyFromRow).sort(compareRecordCreatedAsc);
      state.tasks = tasks.rows.map(taskFromRow);
      state.workItems = workItems.rows.map(workItemFromRow);
      state.attachments = attachments.rows.map(attachmentFromRow);
      state.events = [];
      state.routeEvents = [];
      state.systemNotifications = [];
      state.inboxReads = {};
      const objectKeys = new Set(DURABLE_STATE_RECORD_OBJECT_KEYS);
      for (const row of stateRecords.rows) {
        const kind = row.kind;
        if (!kind) continue;
        if (EPHEMERAL_STATE_RECORD_KEYS.has(kind)) continue;
        if (objectKeys.has(kind) && row.id === 'value') {
          state[kind] = jsonObject(row.payload);
          continue;
        }
        if (!Array.isArray(state[kind])) state[kind] = [];
        state[kind].push(row.payload);
      }
      if (loadOptions.resetTransientRuntimeState) {
        resetTransientRuntimeStateAfterLoad(state, loadOptions.loadedAt || requiredIso());
      }
      state.releaseNotes = releaseNotesFromRows(releaseNotes.rows, state.releaseNotes);
      state.cloud = cloud;
    });
  }

  async function loadAuthIntoState(state) {
    const cloud = state.cloud || {};
    await withClient(async (client) => {
      const workspaces = await client.query(`SELECT * FROM ${table('cloud_workspaces')} ORDER BY created_at ASC, id ASC`);
      const users = await client.query(`SELECT * FROM ${table('cloud_users')} ORDER BY created_at ASC, id ASC`);
      const members = await client.query(`SELECT * FROM ${table('cloud_workspace_members')} ORDER BY created_at ASC, id ASC`);
      const sessions = await client.query(`SELECT * FROM ${table('cloud_sessions')} ORDER BY created_at ASC, id ASC`);
      const invitations = await client.query(`SELECT * FROM ${table('cloud_invitations')} ORDER BY created_at ASC, id ASC`);
      const passwordResets = await client.query(`SELECT * FROM ${table('cloud_password_resets')} ORDER BY created_at ASC, id ASC`);
      const joinLinks = await client.query(`SELECT * FROM ${table('cloud_join_links')} ORDER BY created_at ASC, id ASC`);
      const computers = await client.query(`SELECT * FROM ${table('cloud_computers')} ORDER BY created_at ASC, id ASC`);
      const computerTokens = await client.query(`SELECT * FROM ${table('cloud_computer_tokens')} ORDER BY created_at ASC, id ASC`);
      const pairingTokens = await client.query(`SELECT * FROM ${table('cloud_pairing_tokens')} ORDER BY created_at ASC, id ASC`);
      const agentDeliveries = await client.query(`SELECT * FROM ${table('cloud_agent_deliveries')} ORDER BY created_at ASC, id ASC`);
      const realtimeEvents = await client.query(`SELECT * FROM ${table('cloud_realtime_events')} ORDER BY workspace_id ASC, seq ASC`);

      cloud.schemaVersion = Number(cloud.schemaVersion || 1);
      cloud.auth = {
        ...(cloud.auth || {}),
        passwordLogin: true,
      };
      cloud.workspaces = workspaces.rows.map(workspaceFromRow);
      cloud.users = users.rows.map(userFromRow);
      cloud.workspaceMembers = members.rows.map(memberFromRow);
      cloud.sessions = sessions.rows.map(sessionFromRow);
      cloud.invitations = invitations.rows.map(invitationFromRow);
      cloud.passwordResetTokens = passwordResets.rows.map(passwordResetFromRow);
      cloud.joinLinks = joinLinks.rows.map(joinLinkFromRow);
      cloud.computerTokens = computerTokens.rows.map(computerTokenFromRow);
      cloud.pairingTokens = pairingTokens.rows.map(pairingTokenFromRow);
      cloud.agentDeliveries = agentDeliveries.rows.map(agentDeliveryFromRow);
      cloud.realtimeEvents = realtimeEvents.rows.map(realtimeEventFromRow);
      cloud.daemonEvents = [];
      state.computers = computers.rows.map(computerFromRow);
      state.cloud = cloud;
      state.updatedAt = requiredIso();
    });
  }

  async function loadWorkspaceIntoState(state, workspaceId) {
    const scopedWorkspaceId = String(workspaceId || '').trim();
    if (!scopedWorkspaceId) {
      await loadIntoState(state);
      return;
    }
    const cloud = state.cloud || {};
    const replaceWorkspaceRows = (key, rows) => {
      const existing = safeArray(state[key]).filter((item) => String(item?.workspaceId || '') !== scopedWorkspaceId);
      state[key] = [...existing, ...rows];
    };
    await withClient(async (client) => {
      const humans = await client.query(`SELECT * FROM ${table('cloud_humans')} WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC`, [scopedWorkspaceId]);
      const computers = await client.query(`SELECT * FROM ${table('cloud_computers')} WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC`, [scopedWorkspaceId]);
      const agents = await client.query(`SELECT * FROM ${table('cloud_agents')} WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC`, [scopedWorkspaceId]);
      const channels = await client.query(`SELECT * FROM ${table('cloud_channels')} WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC`, [scopedWorkspaceId]);
      const dms = await client.query(`SELECT * FROM ${table('cloud_dms')} WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC`, [scopedWorkspaceId]);
      const messages = await client.query(`SELECT * FROM ${table('cloud_messages')} WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`, [scopedWorkspaceId, recentMessageHydrationLimit]);
      const replies = await client.query(`SELECT * FROM ${table('cloud_replies')} WHERE workspace_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`, [scopedWorkspaceId, recentReplyHydrationLimit]);
      const tasks = await client.query(`SELECT * FROM ${table('cloud_tasks')} WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC`, [scopedWorkspaceId]);
      const workItems = await client.query(`SELECT * FROM ${table('cloud_work_items')} WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC`, [scopedWorkspaceId]);
      const attachments = await client.query(`SELECT * FROM ${table('cloud_attachments')} WHERE workspace_id = $1 ORDER BY created_at ASC, id ASC`, [scopedWorkspaceId]);
      const stateRecords = await client.query(
        `SELECT * FROM ${table('cloud_state_records')} WHERE workspace_id = $1 ORDER BY kind ASC, position ASC, id ASC`,
        [scopedWorkspaceId],
      );
      const realtimeEvents = await client.query(
        `SELECT * FROM ${table('cloud_realtime_events')} WHERE workspace_id = $1 ORDER BY seq ASC`,
        [scopedWorkspaceId],
      );
      replaceWorkspaceRows('humans', humans.rows.map(humanFromRow));
      replaceWorkspaceRows('computers', computers.rows.map(computerFromRow));
      replaceWorkspaceRows('agents', agents.rows.map(agentFromRow));
      replaceWorkspaceRows('channels', channels.rows.map(channelFromRow));
      replaceWorkspaceRows('dms', dms.rows.map(dmFromRow));
      replaceWorkspaceRows('messages', messages.rows.map(messageFromRow).sort(compareRecordCreatedAsc));
      replaceWorkspaceRows('replies', replies.rows.map(replyFromRow).sort(compareRecordCreatedAsc));
      replaceWorkspaceRows('tasks', tasks.rows.map(taskFromRow));
      replaceWorkspaceRows('workItems', workItems.rows.map(workItemFromRow));
      replaceWorkspaceRows('attachments', attachments.rows.map(attachmentFromRow));
      cloud.realtimeEvents = [
        ...safeArray(cloud.realtimeEvents).filter((item) => String(item?.workspaceId || '') !== scopedWorkspaceId),
        ...realtimeEvents.rows.map(realtimeEventFromRow),
      ];
      for (const kind of DURABLE_STATE_RECORD_ARRAY_KEYS) {
        const rows = stateRecords.rows
          .filter((row) => row.kind === kind)
          .map((row) => ({ ...jsonObject(row.payload), workspaceId: row.workspace_id }));
        replaceWorkspaceRows(kind, rows);
      }
      state.updatedAt = requiredIso();
    });
  }

  async function initialize(state) {
    if (initialized) return { ok: true, enabled: true, migration, database, schema };
    migration = await migratePostgres({
      databaseUrl,
      database,
      schema,
      maintenanceDatabase,
      createDatabase,
      runtimeOptions,
    });
    await withClient(async (client) => {
      await persistReleaseNotesFromState(client, state);
      await pruneEphemeralActivityRows(client);
    });
    await loadIntoState(state, { resetTransientRuntimeState: true });
    initialized = true;
    console.info(`[cloud-postgres] connected database=${database} schema=${schema}`);
    return { ok: true, enabled: true, migration, database, schema };
  }

  async function close() {
    if (realtimeStopper) await realtimeStopper();
    clearRealtimeReconnect();
    if (pool && !options.pool) await pool.end();
    pool = null;
    initialized = false;
  }

  return {
    close,
    initialize,
    isEnabled: () => true,
    loadIntoState,
    loadAuthIntoState,
    loadWorkspaceIntoState,
    loadConversationWindowIntoState,
    listSpaceMessagesPage,
    listThreadRepliesPage,
    getMessageById,
    publishRealtimeEvent,
    persistAuthOperation,
    persistAuthFromState,
    persistFromState,
    persistWorkspaceFromState,
    deleteComputer,
    subscribeRealtimeEvents,
    publicInfo: () => ({
      backend: 'postgres',
      database,
      schema,
      url: redactDatabaseUrl(databaseUrl),
    }),
  };
}
