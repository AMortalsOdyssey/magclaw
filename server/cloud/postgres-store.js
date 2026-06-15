import { Pool } from 'pg';
import crypto from 'node:crypto';
import path from 'node:path';
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
import { normalizeReleaseNotes, RELEASE_CATEGORY_KEYS, RELEASE_COMPONENTS } from '../release-notes.js';
import { normalizeStoredConversationReferences } from '../conversation-references.js';
import { safePathWithin } from '../path-utils.js';
import {
  filterKnowledgeSpaceStateForWorkspace,
  hasKnowledgeSpaceContent,
  mergeKnowledgeSpaceState,
} from '../knowledge-space.js';

const TRANSIENT_POSTGRES_PERSIST_ERROR_CODES = new Set(['55P03', '40001', '40P01']);
const DURABLE_STATE_RECORD_ARRAY_KEYS = Object.freeze(['reminders', 'missions', 'runs', 'projects', 'agentRuntimeSessions', 'conversationGrants']);
const DURABLE_STATE_RECORD_OBJECT_KEYS = Object.freeze(['settings', 'connection', 'router', 'teamSharing', 'knowledgeSpace']);
const EPHEMERAL_STATE_RECORD_KEYS = new Set(['events', 'routeEvents', 'systemNotifications', 'inboxReads']);
const EPHEMERAL_STATE_RECORD_KEY_LIST = Object.freeze([...EPHEMERAL_STATE_RECORD_KEYS]);
const MESSAGE_PAGE_DEFAULT_LIMIT = 80;
const MESSAGE_PAGE_MAX_LIMIT = 200;
const THREAD_REPLY_PAGE_MAX_LIMIT = 300;
const RECENT_MESSAGE_HYDRATION_LIMIT = 500;
const RECENT_REPLY_HYDRATION_LIMIT = 500;
const KNOWLEDGE_SECRET_RECORD_ID = 'knowledge-space-secret-key';

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

function cloneJsonValue(value) {
  return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
}

function objectHasKeys(value) {
  return Object.keys(jsonObject(value)).length > 0;
}

function cleanIdentifier(value) {
  return String(value || '').trim();
}

function teamSharingRecordWorkspaceId(record) {
  return cleanIdentifier(record?.workspaceId || record?.workspace_id);
}

function teamSharingRecordSessionId(record) {
  return cleanIdentifier(record?.sessionId || record?.session_id);
}

function teamSharingRecordVersion(record = {}) {
  return Math.max(
    Number(record.revision || 0),
    Number(record.abstractRevision || 0),
    Number(record.lastEventOrdinal || 0),
    Number(record.ordinal || 0),
  );
}

function teamSharingRecordTime(record = {}) {
  const time = Date.parse(record.updatedAt || record.updated_at || record.createdAt || record.created_at || '');
  return Number.isFinite(time) ? time : 0;
}

function preferTeamSharingRecord(existing, next) {
  if (!existing) return cloneJsonValue(next);
  if (!next) return cloneJsonValue(existing);
  const existingVersion = teamSharingRecordVersion(existing);
  const nextVersion = teamSharingRecordVersion(next);
  if (nextVersion < existingVersion) return cloneJsonValue(existing);
  if (nextVersion > existingVersion) return cloneJsonValue(next);
  const existingTime = teamSharingRecordTime(existing);
  const nextTime = teamSharingRecordTime(next);
  if (nextTime < existingTime) return cloneJsonValue(existing);
  if (nextTime > existingTime) return cloneJsonValue(next);
  return { ...cloneJsonValue(existing), ...cloneJsonValue(next) };
}

function teamSharingArrayIdentity(key, item, index) {
  const record = jsonObject(item);
  const explicit = record.activityId || record.feedbackId || record.vectorDocumentId || record.queryId || record.id;
  if (explicit) return `${key}:${explicit}`;
  const sessionId = teamSharingRecordSessionId(record);
  if (sessionId && record.revision != null) return `${key}:${sessionId}:revision:${record.revision}`;
  if (sessionId && record.createdAt) return `${key}:${sessionId}:created:${record.createdAt}`;
  return `${key}:index:${index}:${JSON.stringify(item)}`;
}

function mergeTeamSharingArrays(key, ...arrays) {
  const merged = new Map();
  let index = 0;
  for (const array of arrays) {
    for (const item of safeArray(array)) {
      const identity = teamSharingArrayIdentity(key, item, index);
      merged.set(identity, preferTeamSharingRecord(merged.get(identity), item));
      index += 1;
    }
  }
  return [...merged.values()];
}

function mergeTeamSharingRecordMap(...maps) {
  const merged = {};
  for (const map of maps) {
    for (const [key, value] of Object.entries(jsonObject(map))) {
      merged[key] = preferTeamSharingRecord(merged[key], value);
    }
  }
  return merged;
}

function teamSharingEventIdentity(event, index) {
  const record = jsonObject(event);
  return record.eventId || record.id || `${record.ordinal || index}:${record.createdAt || ''}`;
}

function compareTeamSharingEvents(left, right) {
  return Number(left?.ordinal || 0) - Number(right?.ordinal || 0)
    || String(left?.createdAt || '').localeCompare(String(right?.createdAt || ''))
    || String(left?.eventId || '').localeCompare(String(right?.eventId || ''));
}

function mergeTeamSharingEventsMap(...maps) {
  const merged = {};
  for (const map of maps) {
    for (const [sessionId, events] of Object.entries(jsonObject(map))) {
      const byId = new Map();
      let index = 0;
      for (const event of safeArray(merged[sessionId])) {
        byId.set(teamSharingEventIdentity(event, index), event);
        index += 1;
      }
      for (const event of safeArray(events)) {
        const identity = teamSharingEventIdentity(event, index);
        byId.set(identity, preferTeamSharingRecord(byId.get(identity), event));
        index += 1;
      }
      merged[sessionId] = [...byId.values()].sort(compareTeamSharingEvents);
    }
  }
  return merged;
}

function mergeTeamSharingAuth(leftAuth, rightAuth) {
  const left = jsonObject(leftAuth);
  const right = jsonObject(rightAuth);
  if (!objectHasKeys(left) && !objectHasKeys(right)) return undefined;
  return {
    ...cloneJsonValue(left),
    ...cloneJsonValue(right),
    deviceRequests: mergeTeamSharingRecordMap(left.deviceRequests, right.deviceRequests),
    tokens: mergeTeamSharingRecordMap(left.tokens, right.tokens),
  };
}

function mergeTeamSharingState(leftValue, rightValue) {
  const left = jsonObject(leftValue);
  const right = jsonObject(rightValue);
  const merged = {
    ...cloneJsonValue(left),
    ...cloneJsonValue(right),
    sessions: mergeTeamSharingRecordMap(left.sessions, right.sessions),
    events: mergeTeamSharingEventsMap(left.events, right.events),
    syncLedger: mergeTeamSharingRecordMap(left.syncLedger, right.syncLedger),
    abstracts: mergeTeamSharingRecordMap(left.abstracts, right.abstracts),
    activities: mergeTeamSharingArrays('activities', left.activities, right.activities),
    feedback: mergeTeamSharingArrays('feedback', left.feedback, right.feedback),
    vectorDocuments: mergeTeamSharingArrays('vectorDocuments', left.vectorDocuments, right.vectorDocuments),
    searchTraces: mergeTeamSharingArrays('searchTraces', left.searchTraces, right.searchTraces),
  };
  const shares = mergeTeamSharingArrays('shares', left.shares, right.shares);
  if (shares.length) merged.shares = shares;
  const assets = mergeTeamSharingArrays('assets', left.assets, right.assets);
  if (assets.length) merged.assets = assets;
  const shareContents = mergeTeamSharingArrays('shareContents', left.shareContents, right.shareContents);
  if (shareContents.length) merged.shareContents = shareContents;
  const auth = mergeTeamSharingAuth(left.auth, right.auth);
  if (auth) merged.auth = auth;
  return merged;
}

function teamSharingSessionIdsForWorkspace(teamSharingState, workspaceId, options = {}) {
  const cleanWorkspaceId = cleanIdentifier(workspaceId);
  const includeUnscoped = Boolean(options.includeUnscoped);
  const source = jsonObject(teamSharingState);
  const sessionIds = new Set();
  for (const [sessionId, session] of Object.entries(jsonObject(source.sessions))) {
    const recordWorkspaceId = teamSharingRecordWorkspaceId(session);
    if (recordWorkspaceId === cleanWorkspaceId || (includeUnscoped && !recordWorkspaceId)) {
      sessionIds.add(cleanIdentifier(session?.sessionId || sessionId));
    }
  }
  for (const collection of [source.activities, source.feedback, source.vectorDocuments, source.shares, source.assets, source.shareContents]) {
    for (const record of safeArray(collection)) {
      if (teamSharingRecordWorkspaceId(record) !== cleanWorkspaceId) continue;
      const sessionId = teamSharingRecordSessionId(record);
      if (sessionId) sessionIds.add(sessionId);
    }
  }
  for (const [key, ledger] of Object.entries(jsonObject(source.syncLedger))) {
    if (teamSharingRecordWorkspaceId(ledger) !== cleanWorkspaceId) continue;
    const sessionId = teamSharingRecordSessionId(ledger) || cleanIdentifier(key);
    if (sessionId) sessionIds.add(sessionId);
  }
  return sessionIds;
}

function filterTeamSharingAuthForWorkspace(authValue, workspaceId, includeMatches) {
  const cleanWorkspaceId = cleanIdentifier(workspaceId);
  const auth = jsonObject(authValue);
  const filterMap = (map) => {
    const result = {};
    for (const [key, record] of Object.entries(jsonObject(map))) {
      const matches = teamSharingRecordWorkspaceId(record) === cleanWorkspaceId;
      if (includeMatches ? matches : !matches) result[key] = cloneJsonValue(record);
    }
    return result;
  };
  const next = {
    ...cloneJsonValue(auth),
    deviceRequests: filterMap(auth.deviceRequests),
    tokens: filterMap(auth.tokens),
  };
  return objectHasKeys(next.deviceRequests) || objectHasKeys(next.tokens) ? next : undefined;
}

function filterTeamSharingStateForWorkspace(teamSharingState, workspaceId, options = {}) {
  const cleanWorkspaceId = cleanIdentifier(workspaceId);
  const includeMatches = options.includeMatches !== false;
  const includeUnscoped = Boolean(options.includeUnscoped);
  const source = jsonObject(teamSharingState);
  const sessionIds = teamSharingSessionIdsForWorkspace(source, cleanWorkspaceId, { includeUnscoped });
  const matchesRecord = (record) => {
    const recordWorkspaceId = teamSharingRecordWorkspaceId(record);
    const sessionId = teamSharingRecordSessionId(record);
    if (recordWorkspaceId === cleanWorkspaceId) return true;
    if (sessionId && sessionIds.has(sessionId)) return true;
    return includeUnscoped && !recordWorkspaceId && !sessionId;
  };
  const keep = (matches) => (includeMatches ? matches : !matches);
  const filterMap = (map, matcher) => {
    const result = {};
    for (const [key, value] of Object.entries(jsonObject(map))) {
      if (keep(matcher(value, key))) result[key] = cloneJsonValue(value);
    }
    return result;
  };
  const sessions = filterMap(source.sessions, (session, key) => {
    const recordWorkspaceId = teamSharingRecordWorkspaceId(session);
    return recordWorkspaceId === cleanWorkspaceId
      || (includeUnscoped && !recordWorkspaceId)
      || sessionIds.has(cleanIdentifier(session?.sessionId || key));
  });
  const matchingVectorDocumentIds = new Set(safeArray(source.vectorDocuments)
    .filter(matchesRecord)
    .map((record) => cleanIdentifier(record?.vectorDocumentId))
    .filter(Boolean));
  const vectorDocuments = safeArray(source.vectorDocuments).filter((record) => keep(matchesRecord(record))).map(cloneJsonValue);
  const result = {
    sessions,
    events: filterMap(source.events, (_events, key) => sessionIds.has(cleanIdentifier(key))),
    syncLedger: filterMap(source.syncLedger, (ledger, key) => {
      const sessionId = teamSharingRecordSessionId(ledger);
      return matchesRecord(ledger) || (sessionId && sessionIds.has(sessionId)) || sessionIds.has(cleanIdentifier(key));
    }),
    abstracts: filterMap(source.abstracts, (_abstract, key) => sessionIds.has(cleanIdentifier(key))),
    activities: safeArray(source.activities).filter((record) => keep(matchesRecord(record))).map(cloneJsonValue),
    feedback: safeArray(source.feedback).filter((record) => keep(matchesRecord(record))).map(cloneJsonValue),
    vectorDocuments,
    searchTraces: safeArray(source.searchTraces).filter((trace) => {
      const matches = matchesRecord(trace)
        || safeArray(trace?.selectedTop5).some((id) => matchingVectorDocumentIds.has(cleanIdentifier(id)))
        || safeArray(trace?.vectorCandidates).some((id) => matchingVectorDocumentIds.has(cleanIdentifier(id)));
      return keep(matches);
    }).map(cloneJsonValue),
  };
  const shares = safeArray(source.shares).filter((record) => keep(matchesRecord(record))).map(cloneJsonValue);
  if (shares.length) result.shares = shares;
  const assets = safeArray(source.assets).filter((record) => keep(matchesRecord(record))).map(cloneJsonValue);
  if (assets.length) result.assets = assets;
  const shareContents = safeArray(source.shareContents).filter((record) => keep(matchesRecord(record))).map(cloneJsonValue);
  if (shareContents.length) result.shareContents = shareContents;
  const auth = filterTeamSharingAuthForWorkspace(source.auth, cleanWorkspaceId, includeMatches);
  if (auth) result.auth = auth;
  return result;
}

function hasTeamSharingContent(teamSharingState) {
  const source = jsonObject(teamSharingState);
  return objectHasKeys(source.sessions)
    || objectHasKeys(source.events)
    || objectHasKeys(source.syncLedger)
    || objectHasKeys(source.abstracts)
    || safeArray(source.activities).length > 0
    || safeArray(source.feedback).length > 0
    || safeArray(source.vectorDocuments).length > 0
    || safeArray(source.searchTraces).length > 0
    || safeArray(source.shares).length > 0
    || safeArray(source.assets).length > 0
    || safeArray(source.shareContents).length > 0
    || objectHasKeys(source.auth?.deviceRequests)
    || objectHasKeys(source.auth?.tokens);
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
  const references = normalizeStoredConversationReferences(next.references || next.metadata?.references);
  if (references.length) {
    next.references = references;
    next.metadata = { ...jsonObject(next.metadata), references };
  }
  return next;
}

function computerStatus(value) {
  const status = String(value || '').trim().toLowerCase();
  if ([
    'offline',
    'disabled',
    'pairing',
    'upgrade_pending',
    'upgrading',
    'restarting',
    'rollback',
    'upgrade_failed',
  ].includes(status)) return status;
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
    if ((status === 'connected' || status === 'upgrade_pending' || status === 'upgrading' || status === 'restarting' || status === 'rollback') && connectedVia === 'daemon') {
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

function sequenceNumber(value) {
  const number = Number(value || 0);
  return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function channelHumanMembershipIds(channel = {}) {
  const ids = new Set();
  for (const id of safeArray(channel.humanIds)) {
    const value = String(id || '').trim();
    if (value.startsWith('hum_')) ids.add(value);
  }
  for (const id of safeArray(channel.memberIds)) {
    const value = String(id || '').trim();
    if (value.startsWith('hum_')) ids.add(value);
  }
  return [...ids];
}

function unreadBooleanSql(recordAlias, key) {
  const cleanKey = String(key || '').replace(/[^a-zA-Z0-9_]/g, '');
  return `LOWER(COALESCE(${recordAlias}.metadata #>> '{state,${cleanKey}}', ${recordAlias}.metadata ->> '${cleanKey}', 'false')) IN ('true', '1', 'yes')`;
}

function unreadChannelPrivateSql(channelAlias = 'channel') {
  return `(
    LOWER(COALESCE(${channelAlias}.metadata #>> '{state,visibility}', ${channelAlias}.metadata ->> 'visibility', 'public')) IN ('private', 'secret')
    OR LOWER(COALESCE(${channelAlias}.metadata #>> '{state,privacy}', ${channelAlias}.metadata ->> 'privacy', '')) IN ('private', 'secret')
    OR LOWER(COALESCE(${channelAlias}.metadata #>> '{state,isPrivate}', ${channelAlias}.metadata ->> 'isPrivate', 'false')) IN ('true', '1', 'yes')
    OR LOWER(COALESCE(${channelAlias}.metadata #>> '{state,private}', ${channelAlias}.metadata ->> 'private', 'false')) IN ('true', '1', 'yes')
    OR LOWER(COALESCE(${channelAlias}.metadata #>> '{state,secret}', ${channelAlias}.metadata ->> 'secret', 'false')) IN ('true', '1', 'yes')
  )`;
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

function workspaceIdForRuntimeRecord(record, cloud) {
  const ids = workspaceIds(cloud);
  if (!ids.length) return '';
  const explicit = record?.workspaceId || record?.workspace_id;
  if (explicit) return ids.includes(explicit) ? explicit : '';
  return ids.length === 1 ? ids[0] : '';
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
    spaceType: spaceType(row.space_type),
    spaceId: row.space_id || '',
    spaceSeq: sequenceNumber(row.space_seq),
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
  const source = jsonObject(jsonObject(row.metadata).state);
  return recordFromMetadata(row, {
    id: row.id,
    workspaceId: row.workspace_id,
    parentMessageId: row.parent_message_id,
    spaceType: spaceType(row.space_type || source.spaceType),
    spaceId: row.space_id || source.spaceId || '',
    spaceSeq: sequenceNumber(row.space_seq),
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

function attachmentPathFromStorageKey(storageKey, attachmentBaseDir = '') {
  const key = String(storageKey || '').trim();
  const baseDir = String(attachmentBaseDir || '').trim();
  if (!key || !baseDir) return '';
  if (path.isAbsolute(key)) {
    const resolved = path.resolve(key);
    const relative = path.relative(path.resolve(baseDir), resolved);
    if (relative && (relative.startsWith('..') || path.isAbsolute(relative))) return '';
    return resolved;
  }
  return safePathWithin(baseDir, key) || '';
}

function attachmentUrl(id, filename = 'attachment', workspaceId = '') {
  const attachmentId = String(id || '').trim();
  if (!attachmentId) return '';
  const base = `/api/attachments/${attachmentId}/${encodeURIComponent(filename || 'attachment')}`;
  const scope = String(workspaceId || '').trim();
  return scope ? `${base}?workspaceId=${encodeURIComponent(scope)}` : base;
}

function attachmentFromRow(row, options = {}) {
  const filename = row.filename || '';
  const storageKey = row.storage_key || '';
  const sizeBytes = Number(row.size_bytes || 0);
  const filePath = attachmentPathFromStorageKey(storageKey, options.attachmentBaseDir);
  const base = {
    id: row.id,
    workspaceId: row.workspace_id,
    storageKey,
    relativePath: path.isAbsolute(String(storageKey || '')) ? '' : storageKey,
    storageMode: row.storage_mode || 'pvc',
    name: filename,
    filename,
    type: row.mime_type || '',
    mimeType: row.mime_type || '',
    bytes: sizeBytes,
    size: sizeBytes,
    sizeBytes,
    checksumSha256: row.checksum_sha256 || '',
    source: row.source || 'upload',
    createdBy: row.created_by || '',
    createdAt: requiredIso(row.created_at),
    url: attachmentUrl(row.id, filename, row.workspace_id),
  };
  if (filePath) base.path = filePath;
  return recordFromMetadata(row, base);
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
      for (const category of RELEASE_CATEGORY_KEYS) {
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
  const grouped = Object.fromEntries(RELEASE_COMPONENTS.map((component) => [component, new Map()]));
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
        new: [],
        bugFix: [],
        approval: [],
        features: [],
        fixes: [],
        improved: [],
      });
    }
    const release = grouped[component].get(key);
    const category = RELEASE_CATEGORY_KEYS.includes(row.category) ? row.category : 'new';
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
  const attachmentBaseDir = String(options.attachmentBaseDir || process.env.MAGCLAW_UPLOAD_DIR || '').trim();
  const knowledgeSecretLogger = typeof options.knowledgeSecretLogger === 'function'
    ? options.knowledgeSecretLogger
    : console.info;
  let pool = options.pool || null;
  let realtimeClient = null;
  let realtimeStopper = null;
  let realtimeReconnectTimer = null;
  let initialized = false;
  let migration = null;
  const workspacePersistConcurrency = Math.max(1, Math.min(4, Math.max(1, poolMax - 2)));
  const workspacePersistTails = new Map();
  const workspacePersistWaiters = [];
  let activeWorkspacePersists = 0;
  let controlPlanePersistTail = Promise.resolve();
  let authPersistTail = Promise.resolve();
  const poolsWithErrorHandler = new WeakSet();

  function settled(promise) {
    return Promise.resolve(promise).catch(() => {});
  }

  async function acquireWorkspacePersistSlot() {
    if (activeWorkspacePersists < workspacePersistConcurrency) {
      activeWorkspacePersists += 1;
      return;
    }
    await new Promise((resolve) => workspacePersistWaiters.push(resolve));
  }

  function releaseWorkspacePersistSlot() {
    const next = workspacePersistWaiters.shift();
    if (next) {
      next();
      return;
    }
    activeWorkspacePersists = Math.max(0, activeWorkspacePersists - 1);
  }

  async function runWorkspacePersistTask(run) {
    await acquireWorkspacePersistSlot();
    try {
      return await run();
    } finally {
      releaseWorkspacePersistSlot();
    }
  }

  function enqueueWorkspacePersist(workspaceId, run) {
    const cleanWorkspaceId = String(workspaceId || '').trim();
    if (!cleanWorkspaceId) return Promise.resolve();
    const controlPlaneBarrier = settled(controlPlanePersistTail);
    const previousWorkspaceTail = settled(workspacePersistTails.get(cleanWorkspaceId) || Promise.resolve());
    const task = Promise.all([controlPlaneBarrier, previousWorkspaceTail])
      .then(() => runWorkspacePersistTask(run));
    const safeTask = settled(task);
    workspacePersistTails.set(cleanWorkspaceId, safeTask);
    safeTask.then(() => {
      if (workspacePersistTails.get(cleanWorkspaceId) === safeTask) {
        workspacePersistTails.delete(cleanWorkspaceId);
      }
    });
    return task;
  }

  function enqueueControlPlanePersist(run) {
    const previousControlPlaneTail = settled(controlPlanePersistTail);
    const workspaceTailsAtBarrier = Array.from(workspacePersistTails.values()).map(settled);
    const authTailAtBarrier = settled(authPersistTail);
    const task = previousControlPlaneTail
      .then(() => Promise.all([...workspaceTailsAtBarrier, authTailAtBarrier]))
      .then(run);
    controlPlanePersistTail = settled(task);
    return task;
  }

  function enqueueAuthPersist(run) {
    const controlPlaneBarrier = settled(controlPlanePersistTail);
    const previousAuthTail = settled(authPersistTail);
    const task = Promise.all([controlPlaneBarrier, previousAuthTail]).then(run);
    authPersistTail = settled(task);
    return task;
  }

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

  function setKnowledgeSecretEnv(env, secret) {
    if (!env || typeof env !== 'object') return;
    env.MAGCLAW_KNOWLEDGE_SECRET_KEY = String(secret || '');
  }

  function logKnowledgeSecret(message) {
    try {
      knowledgeSecretLogger(message);
    } catch {
      // Logging must never block database-backed startup secret provisioning.
    }
  }

  async function ensureKnowledgeSecretWithClient(client, env = process.env) {
    const secretsTable = table('cloud_server_secrets');
    const existing = firstRow(await client.query(
      `SELECT secret_value FROM ${secretsTable} WHERE id = $1`,
      [KNOWLEDGE_SECRET_RECORD_ID],
    ));
    if (existing?.secret_value) {
      setKnowledgeSecretEnv(env, existing.secret_value);
      logKnowledgeSecret('[knowledge-space] Loaded database-managed encryption secret.');
      return { ok: true, configured: true, source: 'database' };
    }

    const explicit = String(env?.MAGCLAW_KNOWLEDGE_SECRET_KEY || '').trim();
    const secret = explicit || crypto.randomBytes(32).toString('base64url');
    const inserted = firstRow(await client.query(`
      INSERT INTO ${secretsTable} (id, secret_value, metadata)
      VALUES ($1, $2, $3::jsonb)
      ON CONFLICT (id) DO NOTHING
      RETURNING secret_value
    `, [
      KNOWLEDGE_SECRET_RECORD_ID,
      secret,
      JSON.stringify({
        purpose: 'knowledge_space_secret_encryption',
        source: explicit ? 'env' : 'generated',
      }),
    ]));
    if (inserted?.secret_value) {
      setKnowledgeSecretEnv(env, inserted.secret_value);
      logKnowledgeSecret(explicit
        ? '[knowledge-space] Seeded database-managed encryption secret from existing env.'
        : '[knowledge-space] Generated database-managed encryption secret.');
      return { ok: true, configured: true, source: explicit ? 'env' : 'generated' };
    }

    const raced = firstRow(await client.query(
      `SELECT secret_value FROM ${secretsTable} WHERE id = $1`,
      [KNOWLEDGE_SECRET_RECORD_ID],
    ));
    if (!raced?.secret_value) {
      throw new Error('Knowledge Space database secret could not be created.');
    }
    setKnowledgeSecretEnv(env, raced.secret_value);
    logKnowledgeSecret('[knowledge-space] Loaded database-managed encryption secret.');
    return { ok: true, configured: true, source: 'database' };
  }

  async function ensureKnowledgeSecret(env = process.env) {
    return withClient((client) => ensureKnowledgeSecretWithClient(client, env));
  }

  function messageRuntimeConflictSuffix() {
    const existing = table('cloud_messages');
    return `
      ON CONFLICT (id) DO UPDATE SET
        workspace_id = EXCLUDED.workspace_id,
        space_type = EXCLUDED.space_type,
        space_id = EXCLUDED.space_id,
        space_seq = CASE
          WHEN ${existing}.space_seq > 0 THEN ${existing}.space_seq
          ELSE EXCLUDED.space_seq
        END,
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
        space_type = EXCLUDED.space_type,
        space_id = EXCLUDED.space_id,
        space_seq = CASE
          WHEN ${existing}.space_seq > 0 THEN ${existing}.space_seq
          ELSE EXCLUDED.space_seq
        END,
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

  function channelMemberRuntimeConflictSuffix() {
    const existing = table('cloud_channel_members');
    return `
      ON CONFLICT (workspace_id, channel_id, human_id) DO UPDATE SET
        joined_at = CASE
          WHEN ${existing}.left_at IS NOT NULL THEN EXCLUDED.joined_at
          ELSE ${existing}.joined_at
        END,
        left_at = NULL,
        updated_at = GREATEST(COALESCE(${existing}.updated_at, EXCLUDED.updated_at), EXCLUDED.updated_at)
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
    for (const component of RELEASE_COMPONENTS) {
      const ids = entries
        .filter((entry) => entry.component === component)
        .map((entry) => entry.id);
      if (ids.length) {
        await client.query(`DELETE FROM ${table('cloud_release_notes')} WHERE component = $1 AND id <> ALL($2::text[])`, [component, ids]);
      } else {
        await client.query(`DELETE FROM ${table('cloud_release_notes')} WHERE component = $1`, [component]);
      }
    }
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

  function dedupeRowsByColumn(rows, columnIndex = 0) {
    const deduped = new Map();
    const withoutKey = [];
    for (const row of rows) {
      const key = row?.[columnIndex];
      if (!key) {
        withoutKey.push(row);
        continue;
      }
      const normalizedKey = String(key);
      if (deduped.has(normalizedKey)) deduped.delete(normalizedKey);
      deduped.set(normalizedKey, row);
    }
    return [...withoutKey, ...deduped.values()];
  }

  function applyConversationSequenceEntry(entry, seq) {
    const value = sequenceNumber(seq);
    if (!value) return;
    entry.row[entry.spaceSeqIndex] = value;
    if (entry.record && typeof entry.record === 'object') entry.record.spaceSeq = value;
  }

  function conversationSequenceLaneKey(entry) {
    const workspaceId = String(entry.row[entry.workspaceIdIndex] || '').trim();
    const type = spaceType(entry.row[entry.spaceTypeIndex]);
    const spaceId = String(entry.row[entry.spaceIdIndex] || '').trim();
    if (!workspaceId || !spaceId) return '';
    return `${workspaceId}\u0000${type}\u0000${spaceId}`;
  }

  async function hydrateExistingConversationSequences(client, entries) {
    const messageEntries = new Map();
    const replyEntries = new Map();
    for (const entry of entries) {
      const id = String(entry.row?.[0] || '').trim();
      if (!id || sequenceNumber(entry.row[entry.spaceSeqIndex])) continue;
      if (entry.kind === 'reply') replyEntries.set(id, entry);
      else messageEntries.set(id, entry);
    }
    if (messageEntries.size) {
      const result = await client.query(`
        SELECT id, space_seq
        FROM ${table('cloud_messages')}
        WHERE id = ANY($1::text[]) AND space_seq > 0
      `, [[...messageEntries.keys()]]);
      for (const row of result?.rows || []) {
        const entry = messageEntries.get(row.id);
        if (entry) applyConversationSequenceEntry(entry, row.space_seq);
      }
    }
    if (replyEntries.size) {
      const result = await client.query(`
        SELECT id, space_type, space_id, space_seq
        FROM ${table('cloud_replies')}
        WHERE id = ANY($1::text[]) AND space_seq > 0
      `, [[...replyEntries.keys()]]);
      for (const row of result?.rows || []) {
        const entry = replyEntries.get(row.id);
        if (!entry) continue;
        entry.row[entry.spaceTypeIndex] = row.space_type || entry.row[entry.spaceTypeIndex];
        entry.row[entry.spaceIdIndex] = row.space_id || entry.row[entry.spaceIdIndex];
        applyConversationSequenceEntry(entry, row.space_seq);
      }
    }
  }

  async function reserveConversationSequenceRange(client, workspaceId, type, spaceId, count) {
    const cleanCount = Number(count || 0);
    if (!workspaceId || !spaceId || cleanCount <= 0) return 1;
    const result = await client.query(`
      INSERT INTO ${table('cloud_conversation_sequences')}
        (workspace_id, space_type, space_id, next_seq, updated_at)
      VALUES ($1, $2, $3, $4::bigint + 1, now())
      ON CONFLICT (workspace_id, space_type, space_id) DO UPDATE SET
        next_seq = ${table('cloud_conversation_sequences')}.next_seq + $4::bigint,
        updated_at = now()
      RETURNING next_seq - $4::bigint AS first_seq
    `, [workspaceId, type, spaceId, cleanCount]);
    return sequenceNumber(result?.rows?.[0]?.first_seq) || 1;
  }

  async function assignMissingConversationSequences(client, entries) {
    const activeEntries = entries.filter((entry) => entry?.row && !sequenceNumber(entry.row[entry.spaceSeqIndex]));
    if (!activeEntries.length) return;
    await hydrateExistingConversationSequences(client, activeEntries);
    const groups = new Map();
    for (const entry of activeEntries) {
      if (sequenceNumber(entry.row[entry.spaceSeqIndex])) continue;
      const key = conversationSequenceLaneKey(entry);
      if (!key) continue;
      const group = groups.get(key) || [];
      group.push(entry);
      groups.set(key, group);
    }
    for (const [key, group] of groups.entries()) {
      const [workspaceId, type, spaceId] = key.split('\u0000');
      group.sort((left, right) => {
        const leftCreated = String(left.row[left.createdAtIndex] || '');
        const rightCreated = String(right.row[right.createdAtIndex] || '');
        if (leftCreated !== rightCreated) return leftCreated.localeCompare(rightCreated);
        const leftKind = left.kind === 'reply' ? 1 : 0;
        const rightKind = right.kind === 'reply' ? 1 : 0;
        if (leftKind !== rightKind) return leftKind - rightKind;
        return String(left.row[0] || '').localeCompare(String(right.row[0] || ''));
      });
      const firstSeq = await reserveConversationSequenceRange(client, workspaceId, type, spaceId, group.length);
      group.forEach((entry, index) => applyConversationSequenceEntry(entry, firstSeq + index));
    }
  }

  async function syncChannelMembershipRows(client, workspaceIdsToSync, channelMembershipRows) {
    const rows = dedupeRowsByColumn(channelMembershipRows, 5);
    await batchInsertRows(client, 'cloud_channel_members', [
      'workspace_id',
      'channel_id',
      'human_id',
      'joined_at',
      'updated_at',
    ], rows.map((row) => row.slice(0, 5)), {}, channelMemberRuntimeConflictSuffix());

    const scopedWorkspaceIds = safeArray(workspaceIdsToSync).map(String).filter(Boolean);
    if (!scopedWorkspaceIds.length) return;
    if (!rows.length) {
      await client.query(`
        UPDATE ${table('cloud_channel_members')}
        SET left_at = COALESCE(left_at, now()),
            updated_at = now()
        WHERE workspace_id = ANY($1::text[])
          AND left_at IS NULL
      `, [scopedWorkspaceIds]);
      return;
    }
    const params = [scopedWorkspaceIds];
    const valuesSql = rows.map((row) => {
      params.push(row[0], row[1], row[2]);
      const index = params.length - 2;
      return `($${index}::text, $${index + 1}::text, $${index + 2}::text)`;
    }).join(', ');
    await client.query(`
      WITH active_members(workspace_id, channel_id, human_id) AS (
        VALUES ${valuesSql}
      )
      UPDATE ${table('cloud_channel_members')} AS member
      SET left_at = COALESCE(member.left_at, now()),
          updated_at = now()
      WHERE member.workspace_id = ANY($1::text[])
        AND member.left_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM active_members AS active
          WHERE active.workspace_id = member.workspace_id
            AND active.channel_id = member.channel_id
            AND active.human_id = member.human_id
        )
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

  async function searchConversationRecords(options = {}) {
    const workspaceId = String(options.workspaceId || '').trim();
    if (!workspaceId) {
      return {
        results: [],
        messages: [],
        replies: [],
        parents: [],
        pagination: {
          limit: parsePageLimit(options.limit),
          hasMore: false,
          nextBefore: '',
          nextBeforeId: '',
        },
      };
    }
    const limit = parsePageLimit(options.limit, MESSAGE_PAGE_DEFAULT_LIMIT, 400);
    return withClient(async (client) => {
      const params = [workspaceId];
      const messageWhere = ['workspace_id = $1'];
      const replyWhere = ['workspace_id = $1'];
      const queryTerms = String(options.query || '').trim().split(/\s+/).filter(Boolean).slice(0, 8);
      for (const term of queryTerms) {
        const param = params.push(`%${term}%`);
        messageWhere.push(`body ILIKE $${param}`);
        replyWhere.push(`body ILIKE $${param}`);
      }
      const senderId = String(options.senderId || '').trim();
      if (senderId) {
        const param = params.push(senderId);
        messageWhere.push(`author_id = $${param}`);
        replyWhere.push(`author_id = $${param}`);
      }
      const channelId = String(options.channelId || '').trim();
      if (channelId) {
        const param = params.push(channelId);
        messageWhere.push(`space_type = 'channel' AND space_id = $${param}`);
        replyWhere.push(`COALESCE(metadata #>> '{state,spaceType}', '') = 'channel' AND COALESCE(metadata #>> '{state,spaceId}', '') = $${param}`);
      }
      const after = iso(options.after);
      if (after) {
        const param = params.push(after);
        messageWhere.push(`created_at >= $${param}::timestamptz`);
        replyWhere.push(`created_at >= $${param}::timestamptz`);
      }
      const cursor = cursorClause(params, options.before, options.beforeId, 'created_at', 'id');
      if (cursor) {
        messageWhere.push(cursor.replace(/^ AND /, ''));
        replyWhere.push(cursor.replace(/^ AND /, ''));
      }
      const limitParam = params.push(limit + 1);
      const rows = await client.query(`
        SELECT 'message' AS record_kind, *
        FROM ${table('cloud_messages')}
        WHERE ${messageWhere.join(' AND ')}
        UNION ALL
        SELECT 'reply' AS record_kind, *
        FROM ${table('cloud_replies')}
        WHERE ${replyWhere.join(' AND ')}
        ORDER BY created_at DESC, id DESC
        LIMIT $${limitParam}
      `, params);
      const rawPage = rows.rows.slice(0, limit);
      const messages = rawPage.filter((row) => row.record_kind === 'message').map(messageFromRow);
      const replies = rawPage.filter((row) => row.record_kind === 'reply').map(replyFromRow);
      const parentIds = [...new Set(replies.map((reply) => reply.parentMessageId).filter(Boolean))];
      let parents = [];
      if (parentIds.length) {
        const parentRows = await client.query(`
          SELECT *
          FROM ${table('cloud_messages')}
          WHERE workspace_id = $1
            AND id = ANY($2::text[])
        `, [workspaceId, parentIds]);
        parents = parentRows.rows.map(messageFromRow);
      }
      const parentById = new Map(parents.map((parent) => [parent.id, parent]));
      for (const reply of replies) {
        if ((!reply.spaceType || !reply.spaceId) && parentById.has(reply.parentMessageId)) {
          const parent = parentById.get(reply.parentMessageId);
          reply.spaceType = parent.spaceType;
          reply.spaceId = parent.spaceId;
        }
      }
      const byId = new Map([...messages, ...replies].map((record) => [record.id, record]));
      const results = rawPage.map((row) => byId.get(row.id)).filter(Boolean);
      const last = results[results.length - 1] || null;
      return {
        results,
        messages,
        replies,
        parents,
        pagination: {
          limit,
          hasMore: rows.rows.length > rawPage.length,
          nextBefore: last?.createdAt || '',
          nextBeforeId: last?.id || '',
        },
      };
    });
  }

  async function markConversationRecordsRead(options = {}) {
    const workspaceId = String(options.workspaceId || '').trim();
    const humanId = String(options.humanId || '').trim();
    const recordIds = [...new Set(safeArray(options.recordIds).map(String).filter(Boolean))].slice(0, 500);
    const cleanSpaceType = options.spaceType ? spaceType(options.spaceType) : '';
    const spaceId = String(options.spaceId || '').trim();
    const threadMessageId = String(options.threadMessageId || '').trim();
    const readAt = requiredIso(options.readAt || new Date());
    if (!workspaceId || !humanId || (!recordIds.length && !(cleanSpaceType && spaceId) && !threadMessageId)) {
      return { messageIds: [], replyIds: [], count: 0 };
    }

    return withClient(async (client) => {
      const messageIds = new Set();
      const replyIds = new Set();
      let cursorSpaceType = cleanSpaceType;
      let cursorSpaceId = spaceId;

      async function upsertReadState({ stateSpaceType, stateSpaceId, threadRootId = '' }) {
        if (!stateSpaceType || !stateSpaceId) return;
        await client.query(`
          INSERT INTO ${table('cloud_conversation_read_states')}
            (workspace_id, human_id, space_type, space_id, thread_root_id, joined_at, last_read_at, updated_at)
          VALUES ($1, $2, $3, $4, $5, $6, $6, $6)
          ON CONFLICT (workspace_id, human_id, space_type, space_id, thread_root_id) DO UPDATE SET
            joined_at = LEAST(${table('cloud_conversation_read_states')}.joined_at, EXCLUDED.joined_at),
            last_read_at = GREATEST(${table('cloud_conversation_read_states')}.last_read_at, EXCLUDED.last_read_at),
            updated_at = EXCLUDED.updated_at
        `, [workspaceId, humanId, stateSpaceType, stateSpaceId, threadRootId || '', readAt]);
      }

      async function updateMessages(whereSql, params) {
        const humanParam = params.push(humanId);
        const result = await client.query(`
          UPDATE ${table('cloud_messages')} AS message
          SET read_by = COALESCE(message.read_by, '[]'::jsonb) || to_jsonb(ARRAY[$${humanParam}::text])
          WHERE ${whereSql}
            AND NOT (COALESCE(message.read_by, '[]'::jsonb) @> to_jsonb(ARRAY[$${humanParam}::text]))
          RETURNING message.id
        `, params);
        for (const row of result.rows || []) messageIds.add(row.id);
      }

      async function updateReplies(whereSql, params) {
        const humanParam = params.push(humanId);
        const result = await client.query(`
          UPDATE ${table('cloud_replies')} AS reply
          SET read_by = COALESCE(reply.read_by, '[]'::jsonb) || to_jsonb(ARRAY[$${humanParam}::text])
          WHERE ${whereSql}
            AND NOT (COALESCE(reply.read_by, '[]'::jsonb) @> to_jsonb(ARRAY[$${humanParam}::text]))
          RETURNING reply.id
        `, params);
        for (const row of result.rows || []) replyIds.add(row.id);
      }

      if (recordIds.length) {
        await updateMessages('message.workspace_id = $1 AND message.id = ANY($2::text[])', [workspaceId, recordIds]);
        await updateReplies('reply.workspace_id = $1 AND reply.id = ANY($2::text[])', [workspaceId, recordIds]);
      }
      if (cleanSpaceType && spaceId) {
        await updateMessages('message.workspace_id = $1 AND message.space_type = $2 AND message.space_id = $3', [workspaceId, cleanSpaceType, spaceId]);
        const humanParam = 4;
        const result = await client.query(`
          UPDATE ${table('cloud_replies')} AS reply
          SET read_by = COALESCE(reply.read_by, '[]'::jsonb) || to_jsonb(ARRAY[$${humanParam}::text])
          FROM ${table('cloud_messages')} AS message
          WHERE reply.workspace_id = $1
            AND message.workspace_id = $1
            AND reply.parent_message_id = message.id
            AND message.space_type = $2
            AND message.space_id = $3
            AND NOT (COALESCE(reply.read_by, '[]'::jsonb) @> to_jsonb(ARRAY[$${humanParam}::text]))
          RETURNING reply.id
        `, [workspaceId, cleanSpaceType, spaceId, humanId]);
        for (const row of result.rows || []) replyIds.add(row.id);
      }
      if (threadMessageId) {
        if (!cursorSpaceType || !cursorSpaceId) {
          const threadRoot = firstRow(await client.query(`
            SELECT space_type, space_id
            FROM ${table('cloud_messages')}
            WHERE workspace_id = $1
              AND id = $2
            LIMIT 1
          `, [workspaceId, threadMessageId]));
          cursorSpaceType = threadRoot?.space_type || cursorSpaceType;
          cursorSpaceId = threadRoot?.space_id || cursorSpaceId;
        }
        await updateMessages('message.workspace_id = $1 AND message.id = $2', [workspaceId, threadMessageId]);
        await updateReplies('reply.workspace_id = $1 AND reply.parent_message_id = $2', [workspaceId, threadMessageId]);
      }
      if (cursorSpaceType && cursorSpaceId && !threadMessageId) {
        await upsertReadState({ stateSpaceType: cursorSpaceType, stateSpaceId: cursorSpaceId });
      }
      if (cursorSpaceType && cursorSpaceId && threadMessageId) {
        await upsertReadState({ stateSpaceType: cursorSpaceType, stateSpaceId: cursorSpaceId, threadRootId: threadMessageId });
      }

      return {
        messageIds: [...messageIds],
        replyIds: [...replyIds],
        count: messageIds.size + replyIds.size,
        readAt,
      };
    });
  }

  async function upsertChannelMember(options = {}) {
    const workspaceId = String(options.workspaceId || '').trim();
    const channelId = String(options.channelId || '').trim();
    const humanId = String(options.humanId || '').trim();
    const joinedAt = requiredIso(options.joinedAt || new Date());
    if (!workspaceId || !channelId || !humanId) return null;
    return withClient(async (client) => {
      await client.query(`
        INSERT INTO ${table('cloud_channel_members')}
          (workspace_id, channel_id, human_id, joined_at, left_at, updated_at)
        VALUES ($1, $2, $3, $4, NULL, $4)
        ON CONFLICT (workspace_id, channel_id, human_id) DO UPDATE SET
          joined_at = CASE
            WHEN ${table('cloud_channel_members')}.left_at IS NOT NULL THEN EXCLUDED.joined_at
            ELSE ${table('cloud_channel_members')}.joined_at
          END,
          left_at = NULL,
          updated_at = EXCLUDED.updated_at
      `, [workspaceId, channelId, humanId, joinedAt]);
      await client.query(`
        INSERT INTO ${table('cloud_conversation_read_states')}
          (workspace_id, human_id, space_type, space_id, thread_root_id, joined_at, last_read_at, updated_at)
        VALUES ($1, $2, 'channel', $3, '', $4, $4, $4)
        ON CONFLICT (workspace_id, human_id, space_type, space_id, thread_root_id) DO UPDATE SET
          joined_at = CASE
            WHEN ${table('cloud_conversation_read_states')}.last_read_at < EXCLUDED.last_read_at
              THEN EXCLUDED.joined_at
            ELSE ${table('cloud_conversation_read_states')}.joined_at
          END,
          last_read_at = GREATEST(${table('cloud_conversation_read_states')}.last_read_at, EXCLUDED.last_read_at),
          updated_at = EXCLUDED.updated_at
      `, [workspaceId, humanId, channelId, joinedAt]);
      return { workspaceId, channelId, humanId, joinedAt };
    });
  }

  async function leaveChannelMember(options = {}) {
    const workspaceId = String(options.workspaceId || '').trim();
    const channelId = String(options.channelId || '').trim();
    const humanId = String(options.humanId || '').trim();
    const leftAt = requiredIso(options.leftAt || new Date());
    if (!workspaceId || !channelId || !humanId) return null;
    return withClient(async (client) => {
      await client.query(`
        UPDATE ${table('cloud_channel_members')}
        SET left_at = $4,
            updated_at = $4
        WHERE workspace_id = $1
          AND channel_id = $2
          AND human_id = $3
      `, [workspaceId, channelId, humanId, leftAt]);
      return { workspaceId, channelId, humanId, leftAt };
    });
  }

  async function getUnreadCounts(options = {}) {
    const workspaceId = String(options.workspaceId || '').trim();
    const humanId = String(options.humanId || '').trim();
    if (!workspaceId || !humanId) return { globalUnread: 0, spaces: [] };
    const hiddenMessageSql = `(${unreadBooleanSql('message', 'hiddenFromChannel')} OR ${unreadBooleanSql('message', 'internal')})`;
    const hiddenReplySql = `(${unreadBooleanSql('reply', 'hiddenFromChannel')} OR ${unreadBooleanSql('reply', 'internal')})`;
    const channelPrivateSql = unreadChannelPrivateSql('channel');
    return withClient(async (client) => {
      const result = await client.query(`
        WITH workspace_member AS (
          SELECT
            member.workspace_id,
            member.human_id,
            COALESCE(MAX(member.joined_at), MIN(member.created_at), now()) AS joined_at,
            COALESCE(MIN(member.created_at), now()) AS created_at
          FROM ${table('cloud_workspace_members')} AS member
          WHERE member.workspace_id = $1
            AND member.human_id = $2
            AND member.removed_at IS NULL
          GROUP BY member.workspace_id, member.human_id
        ),
        accessible_spaces AS (
          SELECT
            'channel'::text AS space_type,
            channel.id AS space_id,
            COALESCE(channel.created_at, now()) AS created_at,
            (member.human_id IS NOT NULL AND member.left_at IS NULL) AS joined,
            NOT (member.human_id IS NOT NULL AND member.left_at IS NULL) AS muted,
            GREATEST(
              COALESCE(channel.created_at, now()),
              CASE
                WHEN member.human_id IS NOT NULL AND member.left_at IS NULL
                  THEN COALESCE(member.joined_at, channel.created_at, now())
                ELSE COALESCE(workspace_member.joined_at, workspace_member.created_at, channel.created_at, now())
              END
            ) AS joined_at
          FROM ${table('cloud_channels')} AS channel
          CROSS JOIN workspace_member
          LEFT JOIN ${table('cloud_channel_members')} AS member
            ON member.workspace_id = channel.workspace_id
           AND member.channel_id = channel.id
           AND member.human_id = $2
          WHERE channel.workspace_id = $1
            AND channel.archived_at IS NULL
            AND (
              (member.human_id IS NOT NULL AND member.left_at IS NULL)
              OR NOT ${channelPrivateSql}
            )
          UNION ALL
          SELECT
            'dm'::text AS space_type,
            dm.id AS space_id,
            COALESCE(dm.created_at, now()) AS created_at,
            TRUE AS joined,
            FALSE AS muted,
            GREATEST(
              COALESCE(dm.created_at, now()),
              COALESCE(workspace_member.joined_at, workspace_member.created_at, dm.created_at, now())
            ) AS joined_at
          FROM ${table('cloud_dms')} AS dm
          CROSS JOIN workspace_member
          WHERE dm.workspace_id = $1
            AND COALESCE(dm.participant_ids, '[]'::jsonb) @> to_jsonb(ARRAY[$2::text])
        ),
        message_unreads AS (
          SELECT
            space.space_type,
            space.space_id,
            space.joined,
            space.muted,
            COUNT(DISTINCT message.id)::int AS unread_count
          FROM accessible_spaces AS space
          JOIN ${table('cloud_messages')} AS message
            ON message.workspace_id = $1
           AND message.space_type = space.space_type
           AND message.space_id = space.space_id
          LEFT JOIN ${table('cloud_conversation_read_states')} AS space_read
            ON space_read.workspace_id = $1
           AND space_read.human_id = $2
           AND space_read.space_type = space.space_type
           AND space_read.space_id = space.space_id
           AND space_read.thread_root_id = ''
          LEFT JOIN ${table('cloud_conversation_read_states')} AS thread_read
            ON thread_read.workspace_id = $1
           AND thread_read.human_id = $2
           AND thread_read.space_type = space.space_type
           AND thread_read.space_id = space.space_id
           AND thread_read.thread_root_id = message.id
          WHERE message.author_type IN ('user', 'human', 'agent')
            AND NOT (message.author_type IN ('user', 'human') AND message.author_id = $2)
            AND NOT ${hiddenMessageSql}
            AND message.created_at > GREATEST(
              space.joined_at,
              COALESCE(space_read.last_read_at, space.joined_at),
              COALESCE(thread_read.last_read_at, space.joined_at)
            )
          GROUP BY space.space_type, space.space_id, space.joined, space.muted
        ),
        reply_unreads AS (
          SELECT
            space.space_type,
            space.space_id,
            space.joined,
            space.muted,
            COUNT(DISTINCT reply.id)::int AS unread_count
          FROM accessible_spaces AS space
          JOIN ${table('cloud_messages')} AS parent
            ON parent.workspace_id = $1
           AND parent.space_type = space.space_type
           AND parent.space_id = space.space_id
          JOIN ${table('cloud_replies')} AS reply
            ON reply.workspace_id = $1
           AND reply.parent_message_id = parent.id
          LEFT JOIN ${table('cloud_conversation_read_states')} AS space_read
            ON space_read.workspace_id = $1
           AND space_read.human_id = $2
           AND space_read.space_type = space.space_type
           AND space_read.space_id = space.space_id
           AND space_read.thread_root_id = ''
          LEFT JOIN ${table('cloud_conversation_read_states')} AS thread_read
            ON thread_read.workspace_id = $1
           AND thread_read.human_id = $2
           AND thread_read.space_type = space.space_type
           AND thread_read.space_id = space.space_id
           AND thread_read.thread_root_id = parent.id
          WHERE reply.author_type IN ('user', 'human', 'agent')
            AND NOT (reply.author_type IN ('user', 'human') AND reply.author_id = $2)
            AND NOT ${hiddenReplySql}
            AND reply.created_at > GREATEST(
              space.joined_at,
              COALESCE(space_read.last_read_at, space.joined_at),
              COALESCE(thread_read.last_read_at, space.joined_at)
            )
          GROUP BY space.space_type, space.space_id, space.joined, space.muted
        ),
        merged AS (
          SELECT * FROM message_unreads
          UNION ALL
          SELECT * FROM reply_unreads
        )
        SELECT
          space.space_type,
          space.space_id,
          space.joined,
          space.muted,
          COALESCE(SUM(merged.unread_count), 0)::int AS unread_count
        FROM accessible_spaces AS space
        LEFT JOIN merged
          ON merged.space_type = space.space_type
         AND merged.space_id = space.space_id
        GROUP BY space.space_type, space.space_id, space.joined, space.muted
        ORDER BY space.space_type ASC, space.space_id ASC
      `, [workspaceId, humanId]);
      const spaces = (result.rows || []).map((row) => ({
        spaceType: row.space_type,
        spaceId: row.space_id,
        unreadCount: Number(row.unread_count || 0),
        joined: row.joined !== false,
        muted: row.muted === true,
      }));
      const globalUnread = spaces.reduce((sum, item) => (
        item.joined && !item.muted ? sum + Number(item.unreadCount || 0) : sum
      ), 0);
      return { globalUnread, spaces };
    });
  }

  function sameRecordPayload(left, right) {
    if (left === right) return true;
    try {
      return JSON.stringify(left) === JSON.stringify(right);
    } catch {
      return false;
    }
  }

  function mergeRecordsIntoState(state, key, records) {
    if (!records?.length) return false;
    const byId = new Map(safeArray(state[key]).map((record) => [record?.id, record]).filter(([id]) => id));
    let changed = false;
    for (const record of records) {
      if (!record?.id) continue;
      const previous = byId.get(record.id);
      if (previous && sameRecordPayload(previous, record)) continue;
      byId.set(record.id, record);
      changed = true;
    }
    if (!changed) return false;
    state[key] = [...byId.values()].sort(compareRecordCreatedAsc);
    return true;
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
    let changed = false;
    if (workspaceId && spaceId) {
      result.messages = await listSpaceMessagesPage({
        workspaceId,
        spaceType: cleanSpaceType,
        spaceId,
        limit: options.messageLimit || MESSAGE_PAGE_DEFAULT_LIMIT,
      });
      changed = mergeRecordsIntoState(state, 'messages', result.messages.messages) || changed;
    }
    const threadMessageId = String(options.threadMessageId || '').trim();
    if (workspaceId && threadMessageId) {
      const parent = safeArray(state.messages).find((message) => message.id === threadMessageId)
        || await getMessageById(threadMessageId, { workspaceId });
      if (parent) {
        changed = mergeRecordsIntoState(state, 'messages', [parent]) || changed;
        result.replies = await listThreadRepliesPage({
          workspaceId,
          parentMessageId: parent.id,
          limit: options.replyLimit || MESSAGE_PAGE_DEFAULT_LIMIT,
        });
        changed = mergeRecordsIntoState(state, 'replies', result.replies.replies) || changed;
      }
    }
    if (changed) state.updatedAt = requiredIso();
    result.changed = changed;
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
    const messageById = new Map(safeArray(state.messages).map((message) => [message.id, message]).filter(([id]) => Boolean(id)));
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
    const computerRows = [];
    const agentRows = [];
    const channelRows = [];
    const channelMembershipRows = [];
    const dmRows = [];
    const messageRows = [];
    const replyRows = [];
    const conversationSequenceEntries = [];
    const taskRows = [];
    const workItemRows = [];
    const attachmentRows = [];
    const stateRecordRows = [];

    for (const human of safeArray(state.humans)) {
      const workspaceId = workspaceIdForRuntimeRecord(human, cloud);
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

    for (const computer of safeArray(state.computers)) {
      if (!computer?.id) continue;
      const workspaceId = workspaceIdForRuntimeRecord(computer, cloud);
      if (!workspaceId || !inScope(workspaceId)) continue;
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

    for (const agent of safeArray(state.agents)) {
      const workspaceId = workspaceIdForRuntimeRecord(agent, cloud);
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
      const workspaceId = workspaceIdForRuntimeRecord(channel, cloud);
      if (!workspaceId || !inScope(workspaceId)) continue;
      const channelCreatedAt = requiredIso(channel.createdAt);
      channelRows.push([
        channel.id,
        workspaceId,
        channel.name || channel.id,
        channel.description || '',
        iso(channel.archivedAt || (channel.archived ? channel.updatedAt : null)),
        channelCreatedAt,
        requiredIso(channel.updatedAt || channel.createdAt),
        JSON.stringify(metadataWithState(channel)),
      ]);
      for (const humanId of channelHumanMembershipIds(channel)) {
        channelMembershipRows.push([
          workspaceId,
          channel.id,
          humanId,
          channelCreatedAt,
          requiredIso(channel.updatedAt || channel.createdAt),
          `${workspaceId}:${channel.id}:${humanId}`,
        ]);
      }
    }

    for (const dm of safeArray(state.dms)) {
      const workspaceId = workspaceIdForRuntimeRecord(dm, cloud);
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
      const workspaceId = workspaceIdForRuntimeRecord(message, cloud);
      if (!workspaceId || !inScope(workspaceId)) continue;
      const row = [
        message.id,
        workspaceId,
        spaceType(message.spaceType),
        message.spaceId || '',
        sequenceNumber(message.spaceSeq),
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
      ];
      messageRows.push(row);
      conversationSequenceEntries.push({
        kind: 'message',
        row,
        record: message,
        workspaceIdIndex: 1,
        spaceTypeIndex: 2,
        spaceIdIndex: 3,
        spaceSeqIndex: 4,
        createdAtIndex: 16,
      });
    }

    for (const reply of safeArray(state.replies)) {
      const workspaceId = workspaceIdForRuntimeRecord(reply, cloud);
      if (!workspaceId || !inScope(workspaceId) || !reply.parentMessageId || !messageIds.has(reply.parentMessageId)) continue;
      const parentMessage = messageById.get(reply.parentMessageId) || null;
      const row = [
        reply.id,
        workspaceId,
        reply.parentMessageId,
        spaceType(reply.spaceType || parentMessage?.spaceType),
        reply.spaceId || parentMessage?.spaceId || '',
        sequenceNumber(reply.spaceSeq),
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
      ];
      replyRows.push(row);
      conversationSequenceEntries.push({
        kind: 'reply',
        row,
        record: reply,
        workspaceIdIndex: 1,
        spaceTypeIndex: 3,
        spaceIdIndex: 4,
        spaceSeqIndex: 5,
        createdAtIndex: 15,
      });
    }

    for (const task of safeArray(state.tasks)) {
      const workspaceId = workspaceIdForRuntimeRecord(task, cloud);
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
      const workspaceId = workspaceIdForRuntimeRecord(item, cloud);
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
      const workspaceId = workspaceIdForRuntimeRecord(attachment, cloud);
      if (!workspaceId || !inScope(workspaceId)) continue;
      attachmentRows.push([
        attachment.id,
        workspaceId,
        attachment.storageKey || attachment.path || attachment.url || attachment.id,
        attachment.storageMode || 'pvc',
        attachment.filename || attachment.name || attachment.id,
        attachment.mimeType || attachment.type || '',
        Number(attachment.sizeBytes || attachment.size || attachment.bytes || 0),
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
      if (key === 'teamSharing') {
        const defaultTeamSharingWorkspaceId = workspaceIdFor(value, state, cloud);
        for (const workspaceId of ids) {
          const scoped = filterTeamSharingStateForWorkspace(value, workspaceId, {
            includeUnscoped: ids.length === 1 || defaultTeamSharingWorkspaceId === workspaceId,
          });
          if (!hasTeamSharingContent(scoped)) continue;
          stateRecordRows.push([
            workspaceId,
            key,
            'value',
            0,
            null,
            null,
            JSON.stringify(scoped),
          ]);
        }
        continue;
      }
      if (key === 'knowledgeSpace') {
        for (const workspaceId of ids) {
          const scoped = filterKnowledgeSpaceStateForWorkspace(value, workspaceId);
          if (!hasKnowledgeSpaceContent(scoped)) continue;
          stateRecordRows.push([
            workspaceId,
            key,
            'value',
            0,
            null,
            null,
            JSON.stringify(scoped),
          ]);
        }
        continue;
      }
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
    ], dedupeRowsByColumn(humanRows), { metadata: '::jsonb' }, humanRuntimeConflictSuffix());
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
    ], dedupeRowsByColumn(computerRows), {
      runtime_ids: '::jsonb',
      runtime_details: '::jsonb',
      capabilities: '::jsonb',
      running_agents: '::jsonb',
      metadata: '::jsonb',
    }, computerAuthConflictSuffix());
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
    ], dedupeRowsByColumn(agentRows), { metadata: '::jsonb' }, agentRuntimeConflictSuffix());
    await batchInsertRows(client, 'cloud_channels', [
      'id',
      'workspace_id',
      'name',
      'description',
      'archived_at',
      'created_at',
      'updated_at',
      'metadata',
    ], dedupeRowsByColumn(channelRows), { metadata: '::jsonb' });
    await syncChannelMembershipRows(client, ids, channelMembershipRows);
    await batchInsertRows(client, 'cloud_dms', [
      'id',
      'workspace_id',
      'participant_ids',
      'created_at',
      'updated_at',
      'metadata',
    ], dedupeRowsByColumn(dmRows), { participant_ids: '::jsonb', metadata: '::jsonb' });
    const dedupedMessageRows = dedupeRowsByColumn(messageRows);
    const dedupedReplyRows = dedupeRowsByColumn(replyRows);
    const dedupedConversationRows = new Set([...dedupedMessageRows, ...dedupedReplyRows]);
    await assignMissingConversationSequences(
      client,
      conversationSequenceEntries.filter((entry) => dedupedConversationRows.has(entry.row)),
    );
    await batchInsertRows(client, 'cloud_messages', [
      'id',
      'workspace_id',
      'space_type',
      'space_id',
      'space_seq',
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
    ], dedupedMessageRows, {
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
      'space_type',
      'space_id',
      'space_seq',
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
    ], dedupedReplyRows, {
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
    ], dedupeRowsByColumn(taskRows), {
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
    ], dedupeRowsByColumn(workItemRows), { target: '::jsonb', payload: '::jsonb', metadata: '::jsonb' });
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
    ], dedupeRowsByColumn(attachmentRows), { metadata: '::jsonb' });
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
    return enqueueControlPlanePersist(() => persistFromStateWithRetry(snapshot));
  }

  function persistWorkspaceFromState(state, workspaceId) {
    const snapshot = cloneRecord(state);
    const cleanWorkspaceId = String(workspaceId || '').trim();
    return enqueueWorkspacePersist(cleanWorkspaceId, () => persistWorkspaceFromStateNow(snapshot, cleanWorkspaceId));
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
    return enqueueControlPlanePersist(() => deleteComputerNow(cleanComputerId, cleanWorkspaceId));
  }

  async function persistMarkdownDocumentIndex(record = {}) {
    const workspaceId = String(record.workspaceId || '').trim();
    const agentId = String(record.agentId || '').trim();
    const relPath = String(record.relPath || '').trim();
    if (!workspaceId || !agentId || !relPath) return;
    const metadata = jsonObject(record.metadata);
    const storageMode = String(record.storageMode || metadata.storageMode || metadata.mirror?.storageMode || 'metadata');
    const storageKey = String(record.storageKey || metadata.storageKey || metadata.mirror?.storageKey || '');
    const bytes = Number(record.bytes || metadata.bytes || metadata.mirror?.bytes || 0);
    await withClient(async (client) => {
      await client.query(`
        INSERT INTO ${table('cloud_markdown_documents')}
          (workspace_id, agent_id, rel_path, revision, storage_mode, storage_key, bytes,
           document_hash, current_segment, updated_at, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
        ON CONFLICT (workspace_id, agent_id, rel_path) DO UPDATE SET
          revision = GREATEST(${table('cloud_markdown_documents')}.revision, EXCLUDED.revision),
          storage_mode = EXCLUDED.storage_mode,
          storage_key = EXCLUDED.storage_key,
          bytes = EXCLUDED.bytes,
          document_hash = EXCLUDED.document_hash,
          current_segment = EXCLUDED.current_segment,
          updated_at = GREATEST(${table('cloud_markdown_documents')}.updated_at, EXCLUDED.updated_at),
          metadata = EXCLUDED.metadata
      `, [
        workspaceId,
        agentId,
        relPath,
        Number(record.revision || 0),
        storageMode,
        storageKey,
        bytes,
        String(record.documentHash || ''),
        Number(record.currentSegment || 1),
        requiredIso(record.updatedAt),
        JSON.stringify(metadata),
      ]);
    });
  }

  async function persistMarkdownOperationIndex(record = {}) {
    const operationId = String(record.operationId || '').trim();
    const workspaceId = String(record.workspaceId || '').trim();
    const agentId = String(record.agentId || '').trim();
    const relPath = String(record.relPath || '').trim();
    if (!operationId || !workspaceId || !agentId || !relPath) return;
    await withClient(async (client) => {
      await client.query(`
        WITH incoming AS (
          SELECT
            $1::text AS operation_id,
            $2::text AS workspace_id,
            $3::text AS agent_id,
            $4::text AS rel_path,
            $5::bigint AS sequence,
            $6::bigint AS revision,
            $7::integer AS segment_index,
            $8::text AS idempotency_key,
            $9::text AS status,
            $10::jsonb AS operation,
            $11::text AS before_hash,
            $12::text AS after_hash,
            $13::text AS source_trigger,
            $14::timestamptz AS created_at,
            $15::timestamptz AS applied_at,
            $16::text AS error,
            $17::jsonb AS metadata
        ),
        inserted AS (
        INSERT INTO ${table('cloud_markdown_operations')}
          (operation_id, workspace_id, agent_id, rel_path, sequence, revision, segment_index,
           idempotency_key, status, operation, before_hash, after_hash, source_trigger,
           created_at, applied_at, error, metadata)
        SELECT operation_id, workspace_id, agent_id, rel_path, sequence, revision, segment_index,
          idempotency_key, status, operation, before_hash, after_hash, source_trigger,
          created_at, applied_at, error, metadata
        FROM incoming
        ON CONFLICT DO NOTHING
        RETURNING operation_id
        )
        UPDATE ${table('cloud_markdown_operations')} existing
        SET
          status = incoming.status,
          revision = incoming.revision,
          segment_index = incoming.segment_index,
          before_hash = incoming.before_hash,
          after_hash = incoming.after_hash,
          applied_at = incoming.applied_at,
          error = incoming.error,
          metadata = incoming.metadata
        FROM incoming
        WHERE NOT EXISTS (SELECT 1 FROM inserted)
          AND existing.operation_id = incoming.operation_id
      `, [
        operationId,
        workspaceId,
        agentId,
        relPath,
        Number(record.sequence || record.revision || 0),
        Number(record.revision || record.sequence || 0),
        Number(record.segmentIndex || 1),
        String(record.idempotencyKey || ''),
        String(record.status || 'applied'),
        JSON.stringify(jsonObject(record.operation)),
        String(record.beforeHash || ''),
        String(record.afterHash || ''),
        String(record.sourceTrigger || ''),
        requiredIso(record.createdAt),
        record.appliedAt ? requiredIso(record.appliedAt) : null,
        String(record.error || ''),
        JSON.stringify(jsonObject(record.metadata)),
      ]);
    });
  }

  async function persistMarkdownMaintenanceRun(record = {}) {
    const id = String(record.id || '').trim();
    const workspaceId = String(record.workspaceId || '').trim();
    const relPath = String(record.relPath || '').trim();
    if (!id || !workspaceId || !relPath) return;
    await withClient(async (client) => {
      await client.query(`
        INSERT INTO ${table('cloud_markdown_maintenance_runs')}
          (id, workspace_id, agent_id, rel_path, status, model, before_hash, after_hash, summary, created_at, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
        ON CONFLICT (id) DO UPDATE SET
          status = EXCLUDED.status,
          after_hash = EXCLUDED.after_hash,
          summary = EXCLUDED.summary,
          metadata = EXCLUDED.metadata
      `, [
        id,
        workspaceId,
        String(record.agentId || '') || null,
        relPath,
        String(record.status || 'completed'),
        String(record.model || ''),
        String(record.beforeHash || ''),
        String(record.afterHash || ''),
        String(record.summary || '').slice(0, 1000),
        requiredIso(record.createdAt),
        JSON.stringify(jsonObject(record.metadata)),
      ]);
    });
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
    return enqueueControlPlanePersist(() => persistAuthFromStateNow(snapshot));
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
    return enqueueAuthPersist(() => persistAuthOperationNow(snapshot));
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
      const stateRecords = await client.query(`SELECT * FROM ${table('cloud_state_records')} ORDER BY kind ASC, workspace_id ASC, position ASC, id ASC`);
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
      state.attachments = attachments.rows.map((row) => attachmentFromRow(row, { attachmentBaseDir }));
      state.events = [];
      state.routeEvents = [];
      state.systemNotifications = [];
      state.inboxReads = {};
      state.teamSharing = {};
      state.knowledgeSpace = {};
      const objectKeys = new Set(DURABLE_STATE_RECORD_OBJECT_KEYS);
      for (const row of stateRecords.rows) {
        const kind = row.kind;
        if (!kind) continue;
        if (EPHEMERAL_STATE_RECORD_KEYS.has(kind)) continue;
        if (objectKeys.has(kind) && row.id === 'value') {
          if (kind === 'teamSharing') {
            state.teamSharing = mergeTeamSharingState(state.teamSharing, jsonObject(row.payload));
            continue;
          }
          if (kind === 'knowledgeSpace') {
            state.knowledgeSpace = mergeKnowledgeSpaceState(state.knowledgeSpace, jsonObject(row.payload));
            continue;
          }
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
      replaceWorkspaceRows('attachments', attachments.rows.map((row) => attachmentFromRow(row, { attachmentBaseDir })));
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
      for (const kind of DURABLE_STATE_RECORD_OBJECT_KEYS) {
        const row = stateRecords.rows.find((item) => item.kind === kind && item.id === 'value');
        if (kind === 'teamSharing') {
          if (!row) continue;
          const withoutWorkspace = filterTeamSharingStateForWorkspace(state.teamSharing, scopedWorkspaceId, {
            includeMatches: false,
          });
          state.teamSharing = mergeTeamSharingState(withoutWorkspace, jsonObject(row.payload));
          continue;
        }
        if (kind === 'knowledgeSpace') {
          if (!row) continue;
          const withoutWorkspace = filterKnowledgeSpaceStateForWorkspace(state.knowledgeSpace, scopedWorkspaceId, {
            includeMatches: false,
          });
          state.knowledgeSpace = mergeKnowledgeSpaceState(withoutWorkspace, jsonObject(row.payload));
          continue;
        }
        if (row) state[kind] = jsonObject(row.payload);
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
    const knowledgeSecret = await ensureKnowledgeSecret(process.env);
    await withClient(async (client) => {
      await persistReleaseNotesFromState(client, state);
      await pruneEphemeralActivityRows(client);
    });
    await loadIntoState(state, { resetTransientRuntimeState: true });
    initialized = true;
    console.info(`[cloud-postgres] connected database=${database} schema=${schema}`);
    return {
      ok: true,
      enabled: true,
      migration,
      database,
      schema,
      knowledgeSecret: {
        configured: Boolean(knowledgeSecret?.configured),
        source: knowledgeSecret?.source || '',
      },
    };
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
    ensureKnowledgeSecret,
    loadConversationWindowIntoState,
    listSpaceMessagesPage,
    searchConversationRecords,
    listThreadRepliesPage,
    getMessageById,
    markConversationRecordsRead,
    getUnreadCounts,
    upsertChannelMember,
    leaveChannelMember,
    publishRealtimeEvent,
    persistAuthOperation,
    persistAuthFromState,
    persistFromState,
    persistWorkspaceFromState,
    deleteComputer,
    persistMarkdownDocumentIndex,
    persistMarkdownOperationIndex,
    persistMarkdownMaintenanceRun,
    subscribeRealtimeEvents,
    publicInfo: () => ({
      backend: 'postgres',
      database,
      schema,
      url: redactDatabaseUrl(databaseUrl),
    }),
  };
}
