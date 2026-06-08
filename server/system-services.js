import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNpmPackageVersionResolver } from './npm-package-versions.js';
import { defaultReleaseNotes, defaultReleaseNotesForComponent, normalizeReleaseNotes, normalizeReleaseNotesForComponent } from './release-notes.js';
import { normalizeCloudUrl, normalizeFanoutApiConfig, publicApiKeyPreview } from './runtime-config.js';
import { teamSharingDisplayBodyForRecord } from './team-sharing.js';
import { isWorkspaceAllChannel } from './workspace-defaults.js';

// System/runtime and local-project services.
// HTTP route modules use this for public state shaping, installed-runtime
// detection, the native folder picker, and project folder registration.
const RUNTIME_PACKAGE_NAMES = Object.freeze(['@magclaw/daemon', '@magclaw/computer', '@magclaw/cli-core', '@magclaw/team-sharing']);
const DEFAULT_PACKAGE_VERSION_WEB_CACHE_MS = 10 * 60_000;
const PACKAGE_UPDATE_CACHE_TTL_SECONDS = 12 * 60 * 60;
const BOOTSTRAP_UNREAD_RECORD_LIMIT = 80;
const BOOTSTRAP_UNREAD_CANDIDATE_LIMIT = BOOTSTRAP_UNREAD_RECORD_LIMIT * 2;
const BOOTSTRAP_CONVERSATION_PREVIEW_CHARS = 140;
const BOOTSTRAP_DIRECTORY_FORMAT_TUPLE = 'tuple-v1';
const BOOTSTRAP_DIRECTORY_SCOPE_VISIBLE = 'visible';
const DIRECTORY_PAGE_LIMIT_DEFAULT = 0;
const DIRECTORY_PAGE_LIMIT_MAX = 500;
const DIRECTORY_SEARCH_LIMIT_DEFAULT = 25;
const DIRECTORY_SEARCH_LIMIT_MAX = 100;
const MEMBERS_DIRECTORY_PAGE_SIZE_DEFAULT = 50;
const MEMBERS_DIRECTORY_PAGE_SIZE_MAX = 100;
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
const BOOTSTRAP_CONVERSATION_FORMAT_TUPLE = 'tuple-v1';
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
const PACKAGE_RELEASE_COMPONENTS = Object.freeze({
  '@magclaw/web': 'web',
  '@magclaw/daemon': 'daemon',
  '@magclaw/computer': 'computer',
  '@magclaw/cli-core': 'cliCore',
  '@magclaw/team-sharing': 'teamSharing',
});

export function createSystemServices(deps) {
  const {
    addSystemEvent,
    broadcastState,
    fanoutApiConfigured,
    getState,
    httpError,
    makeId,
    now,
    nowMs = () => Date.now(),
    npmPackageVersions = createNpmPackageVersionResolver(),
    packageVersionCacheTtlMs = DEFAULT_PACKAGE_VERSION_WEB_CACHE_MS,
    packageVersionPollIntervalMs = packageVersionCacheTtlMs,
    persistState,
    publicCloudState,
    projectsForSpace,
    runningProcesses,
    selectedDefaultSpaceId,
    setIntervalFn = globalThis.setInterval?.bind(globalThis),
    clearIntervalFn = globalThis.clearInterval?.bind(globalThis),
    DATA_DIR,
    PORT,
    ROOT,
  } = deps;
  const state = new Proxy({}, {
    get(_target, prop) { return getState()[prop]; },
    set(_target, prop, value) { getState()[prop] = value; return true; },
  });
  let npmVersionRefreshInFlight = null;
  let packageVersionPollingTimer = null;
  let packageVersionSnapshotCache = null;
  let packageVersionSnapshotInflight = null;
  const recordTimeCache = new WeakMap();
  const packageVersionSnapshotTtlMs = Math.max(1000, Number(packageVersionCacheTtlMs) || DEFAULT_PACKAGE_VERSION_WEB_CACHE_MS);
  const packageVersionPollingIntervalMs = Math.max(1000, Number(packageVersionPollIntervalMs) || packageVersionSnapshotTtlMs);

  function records(value) {
    if (!Array.isArray(value)) return [];
    const output = new Array(value.length);
    let count = 0;
    for (const item of value) {
      if (item) {
        output[count] = item;
        count += 1;
      }
    }
    output.length = count;
    return output;
  }

  function mentionedHumanIdsForRecords(items = []) {
    const ids = new Set();
    for (const item of records(items)) {
      for (const id of records(item.mentionedHumanIds)) {
        const text = String(id || '').trim();
        if (text.startsWith('hum_')) ids.add(text);
      }
      String(item.body || '').replace(/<@(hum_\w+)>/g, (_token, id) => {
        ids.add(id);
        return _token;
      });
    }
    return ids;
  }

  function publicHumanReference(human) {
    if (!human?.id) return null;
    return {
      id: human.id,
      workspaceId: human.workspaceId || '',
      name: human.name || 'Human',
      avatar: human.avatar || '',
      role: human.role || 'human',
      status: human.status || 'offline',
      createdAt: human.createdAt || '',
      updatedAt: human.updatedAt || human.createdAt || '',
      identityReference: true,
    };
  }

  function appendReferencedHumans(scopedHumans, visibleRecords, currentState) {
    const humans = records(scopedHumans);
    const existingIds = new Set(humans.map((human) => String(human?.id || '')).filter(Boolean));
    const referencedIds = mentionedHumanIdsForRecords(visibleRecords);
    if (!referencedIds.size) return humans;
    const allHumans = records(currentState?.humans);
    const references = [];
    for (const id of referencedIds) {
      if (existingIds.has(id)) continue;
      const human = allHumans.find((item) => String(item?.id || '') === id);
      const reference = publicHumanReference(human);
      if (!reference) continue;
      references.push(reference);
      existingIds.add(id);
    }
    return references.length ? [...humans, ...references] : humans;
  }

  function visibleDirectoryHumansForIds(sourceHumans, ids, inScope) {
    const targetIds = ids?.humanIds instanceof Set ? ids.humanIds : new Set();
    const humans = [];
    const foundIds = new Set();
    let total = 0;
    let externalVisibleReferences = 0;
    const source = Array.isArray(sourceHumans) ? sourceHumans : [];
    for (const human of source) {
      if (!human) continue;
      const scoped = inScope(human);
      if (scoped) total += 1;
      const id = String(human?.id || '');
      if (!id || !targetIds.has(id) || foundIds.has(id)) continue;
      const record = scoped ? human : publicHumanReference(human);
      if (!record) continue;
      humans.push(record);
      foundIds.add(id);
      if (!scoped) externalVisibleReferences += 1;
    }
    return {
      humans,
      total: total + externalVisibleReferences,
    };
  }

  function clampLimit(value, fallback, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(max, Math.max(1, Math.floor(parsed)));
  }

  function recordTimestampValue(record) {
    return record?.updatedAt || record?.createdAt || '';
  }

  function isoTimestampRank(value) {
    if (typeof value !== 'string') return '';
    const text = value.trim();
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(text) ? text : '';
  }

  function recordTime(record, value = recordTimestampValue(record)) {
    if (record && typeof record === 'object') {
      const cached = recordTimeCache.get(record);
      if (cached?.value === value) return cached.time;
      const parsed = Date.parse(value);
      const time = Number.isFinite(parsed) ? parsed : 0;
      recordTimeCache.set(record, { value, time });
      return time;
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function compareRecordTime(a, b) {
    const leftValue = recordTimestampValue(a);
    const rightValue = recordTimestampValue(b);
    const leftIso = isoTimestampRank(leftValue);
    const rightIso = isoTimestampRank(rightValue);
    if (leftIso && rightIso) {
      if (leftIso > rightIso) return 1;
      if (leftIso < rightIso) return -1;
      return 0;
    }
    return recordTime(a, leftValue) - recordTime(b, rightValue);
  }

  function compareNewestRank(a, b) {
    const timeDiff = compareRecordTime(a, b);
    if (timeDiff) return timeDiff;
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  }

  function compareNewestRecords(a, b) {
    return -compareNewestRank(a, b);
  }

  function compareOldestRecords(a, b) {
    return compareNewestRank(a, b);
  }

  function newestHeapSwap(heap, left, right) {
    const current = heap[left];
    heap[left] = heap[right];
    heap[right] = current;
  }

  function newestHeapSiftUp(heap, index) {
    let child = index;
    while (child > 0) {
      const parent = Math.floor((child - 1) / 2);
      if (compareNewestRank(heap[child], heap[parent]) >= 0) break;
      newestHeapSwap(heap, child, parent);
      child = parent;
    }
  }

  function newestHeapSiftDown(heap, index) {
    let parent = index;
    while (true) {
      const left = parent * 2 + 1;
      const right = left + 1;
      let worst = parent;
      if (left < heap.length && compareNewestRank(heap[left], heap[worst]) < 0) worst = left;
      if (right < heap.length && compareNewestRank(heap[right], heap[worst]) < 0) worst = right;
      if (worst === parent) break;
      newestHeapSwap(heap, parent, worst);
      parent = worst;
    }
  }

  function addBoundedNewestRecord(heap, record, limit) {
    if (!record || !Number.isFinite(limit) || limit <= 0) return;
    if (heap.length < limit) {
      heap.push(record);
      newestHeapSiftUp(heap, heap.length - 1);
      return;
    }
    if (compareNewestRank(record, heap[0]) > 0) {
      heap[0] = record;
      newestHeapSiftDown(heap, 0);
    }
  }

  function newestRecordsPage(items, limit, predicate = null) {
    const normalizedLimit = Math.floor(Number(limit) || 0);
    if (normalizedLimit <= 0) return { records: [], total: 0, hasMore: false };
    const source = Array.isArray(items) ? items : [];
    let monotonicTotal = 0;
    let previous = null;
    let monotonicOldestFirst = true;
    const monotonicRecords = [];
    let monotonicWriteIndex = 0;
    for (const item of source) {
      if (!item) continue;
      if (predicate && !predicate(item)) continue;
      if (previous && compareOldestRecords(previous, item) > 0) {
        monotonicOldestFirst = false;
        break;
      }
      monotonicTotal += 1;
      if (monotonicRecords.length < normalizedLimit) {
        monotonicRecords.push(item);
      } else {
        monotonicRecords[monotonicWriteIndex] = item;
        monotonicWriteIndex = (monotonicWriteIndex + 1) % normalizedLimit;
      }
      previous = item;
    }
    if (monotonicOldestFirst) {
      monotonicRecords.sort(compareNewestRecords);
      return {
        records: monotonicRecords,
        total: monotonicTotal,
        hasMore: monotonicTotal > monotonicRecords.length,
      };
    }

    const heap = [];
    let total = 0;
    for (const item of source) {
      if (!item) continue;
      if (predicate && !predicate(item)) continue;
      total += 1;
      addBoundedNewestRecord(heap, item, normalizedLimit);
    }
    heap.sort(compareNewestRecords);
    return {
      records: heap,
      total,
      hasMore: total > heap.length,
    };
  }

  function createNewestPageCollector(limit) {
    const normalizedLimit = Math.floor(Number(limit) || 0);
    return {
      limit: normalizedLimit,
      records: [],
      heap: [],
      total: 0,
      writeIndex: 0,
    };
  }

  function addMonotonicNewestRecord(collector, record) {
    if (!record || collector.limit <= 0) return;
    collector.total += 1;
    if (collector.records.length < collector.limit) {
      collector.records.push(record);
      return;
    }
    collector.records[collector.writeIndex] = record;
    collector.writeIndex = (collector.writeIndex + 1) % collector.limit;
  }

  function addHeapNewestRecord(collector, record) {
    if (!record || collector.limit <= 0) return;
    collector.total += 1;
    addBoundedNewestRecord(collector.heap, record, collector.limit);
  }

  function finishNewestPageCollector(collector, recordsKey = 'records') {
    const recordsValue = collector[recordsKey] || [];
    recordsValue.sort(compareNewestRecords);
    return {
      records: recordsValue,
      total: collector.total,
      hasMore: collector.total > recordsValue.length,
    };
  }

  function newestRecordPages(items, specs = [], options = {}) {
    const source = Array.isArray(items) ? items : [];
    const visit = typeof options?.visit === 'function' ? options.visit : null;
    const collectors = records(specs).map((spec) => ({
      predicate: typeof spec?.predicate === 'function' ? spec.predicate : null,
      collector: createNewestPageCollector(spec?.limit),
    }));
    if (!collectors.length && !visit) return [];
    let previous = null;
    let monotonicOldestFirst = true;
    for (const item of source) {
      if (!item) continue;
      if (visit) visit(item);
      if (previous && compareOldestRecords(previous, item) > 0) {
        monotonicOldestFirst = false;
      }
      if (monotonicOldestFirst) {
        for (const entry of collectors) {
          if (entry.predicate && !entry.predicate(item)) continue;
          addMonotonicNewestRecord(entry.collector, item);
        }
      }
      previous = item;
    }
    if (monotonicOldestFirst) {
      return collectors.map((entry) => finishNewestPageCollector(entry.collector, 'records'));
    }

    const heapCollectors = collectors.map((entry) => ({
      predicate: entry.predicate,
      collector: createNewestPageCollector(entry.collector.limit),
    }));
    for (const item of source) {
      if (!item) continue;
      for (const entry of heapCollectors) {
        if (entry.predicate && !entry.predicate(item)) continue;
        addHeapNewestRecord(entry.collector, item);
      }
    }
    return heapCollectors.map((entry) => finishNewestPageCollector(entry.collector, 'heap'));
  }

  function readByIncludesHuman(readBy, humanId) {
    const expected = String(humanId || '');
    if (!expected || !Array.isArray(readBy)) return false;
    for (const value of readBy) {
      if (String(value || '') === expected) return true;
    }
    return false;
  }

  function conversationRecordUnreadForHuman(record, humanId) {
    if (!humanId || !record?.id || record.authorType !== 'agent') return false;
    return !readByIncludesHuman(record.readBy, humanId);
  }

  function includeUnreadConversationRecords({
    currentHumanId,
    messages,
    replies,
    messageById,
    replyById,
    recordVisible = null,
  }) {
    const hydration = {
      limit: BOOTSTRAP_UNREAD_RECORD_LIMIT,
      included: 0,
      truncated: false,
    };
    if (!currentHumanId) return hydration;
    const sourceMessages = Array.isArray(messages) ? messages : [];
    const sourceReplies = Array.isArray(replies) ? replies : [];
    const unreadCandidateHeap = [];
    let unreadCandidateCount = 0;
    const addUnreadCandidate = (kind, record) => {
      if (!record?.id) return;
      unreadCandidateCount += 1;
      addBoundedNewestRecord(unreadCandidateHeap, {
        id: `${kind}:${record.id}`,
        kind,
        record,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      }, BOOTSTRAP_UNREAD_CANDIDATE_LIMIT);
    };
    for (const message of sourceMessages) {
      if (!conversationRecordUnreadForHuman(message, currentHumanId)) continue;
      if (messageById.has(message.id)) continue;
      if (recordVisible && !recordVisible(message)) continue;
      addUnreadCandidate('message', message);
    }
    for (const reply of sourceReplies) {
      if (!reply) continue;
      if (!conversationRecordUnreadForHuman(reply, currentHumanId)) continue;
      if (replyById.has(reply.id)) continue;
      if (recordVisible && !recordVisible(reply)) continue;
      addUnreadCandidate('reply', reply);
    }
    const unreadCandidates = unreadCandidateHeap.sort(compareNewestRecords);
    const parentIds = new Set();
    for (const candidate of unreadCandidates) {
      if (candidate.kind !== 'reply') continue;
      const parentId = String(candidate.record?.parentMessageId || '');
      if (parentId && !messageById.has(parentId)) parentIds.add(parentId);
    }
    const parentById = new Map();
    if (parentIds.size) {
      for (let index = sourceMessages.length - 1; index >= 0; index -= 1) {
        const message = sourceMessages[index];
        if (!message) continue;
        if (recordVisible && !recordVisible(message)) continue;
        const id = String(message?.id || '');
        if (!parentIds.has(id)) continue;
        parentById.set(id, message);
        if (parentById.size >= parentIds.size) break;
      }
    }
    let omitted = 0;
    for (const candidate of unreadCandidates) {
      const message = candidate.kind === 'message' ? candidate.record : null;
      const reply = candidate.kind === 'reply' ? candidate.record : null;
      const parent = reply ? parentById.get(String(reply.parentMessageId || '')) : null;
      const requiredRecords = (
        (message && !messageById.has(message.id) ? 1 : 0)
        + (reply && !replyById.has(reply.id) ? 1 : 0)
        + (parent && !messageById.has(parent.id) ? 1 : 0)
      );
      if (!requiredRecords) continue;
      if (hydration.included + requiredRecords > BOOTSTRAP_UNREAD_RECORD_LIMIT) {
        omitted += requiredRecords;
        continue;
      }
      if (parent) messageById.set(parent.id, parent);
      if (message) messageById.set(message.id, message);
      if (reply) replyById.set(reply.id, reply);
      hydration.included += requiredRecords;
    }
    hydration.truncated = omitted > 0 || unreadCandidateCount > unreadCandidates.length;
    return hydration;
  }

  function newestRecords(items, limit) {
    return newestRecordsPage(items, limit).records;
  }

  function compareTaskRecords(a, b) {
    return compareNewestRecords(a, b);
  }

  function taskPageInfo(candidates = [], page = [], limit = 0) {
    const total = Array.isArray(candidates) ? candidates.length : Math.max(0, Number(candidates) || 0);
    const cursor = page.length ? page[page.length - 1] : null;
    return {
      limit,
      loaded: page.length,
      total,
      hasMore: total > page.length,
      nextBefore: cursor?.updatedAt || cursor?.createdAt || '',
      nextBeforeId: cursor?.id || '',
    };
  }

  function usefulMetadataValue(value) {
    if (value === undefined || value === null || value === '') return false;
    if (Array.isArray(value) && value.length === 0) return false;
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return false;
    return true;
  }

  function pickPublicFields(source = {}, fields = []) {
    if (!source || typeof source !== 'object') return undefined;
    const result = {};
    for (const field of fields) {
      const value = source[field];
      if (usefulMetadataValue(value)) result[field] = value;
    }
    return Object.keys(result).length ? result : undefined;
  }

  function publicTeamSharingUploader(uploader = null) {
    return pickPublicFields(uploader, [
      'id',
      'humanId',
      'name',
      'email',
      'userEmail',
      'authUserId',
      'userId',
      'avatar',
      'avatarUrl',
    ]);
  }

  function publicTeamSharingContentSegment(segment = {}) {
    const type = String(segment?.type || '').trim().toLowerCase() || 'quote';
    if (type === 'body') return null;
    const text = String(segment?.text || segment?.content || '').trim();
    if (!text) return null;
    return {
      type,
      ...(segment.label ? { label: String(segment.label) } : {}),
      text,
    };
  }

  function publicTeamSharingMetadata(teamSharing = null) {
    if (!teamSharing || typeof teamSharing !== 'object') return undefined;
    const result = pickPublicFields(teamSharing, ['runtime', 'projectKey', 'sessionId', 'title']) || {};
    const uploader = publicTeamSharingUploader(teamSharing.uploader);
    if (uploader) result.uploader = uploader;
    const presentationMode = String(teamSharing.presentation?.mode || '').trim();
    if (presentationMode) result.presentation = { mode: presentationMode };
    const contentSegments = records(teamSharing.contentSegments)
      .map(publicTeamSharingContentSegment)
      .filter(Boolean);
    if (contentSegments.length) result.contentSegments = contentSegments;
    return Object.keys(result).length ? result : undefined;
  }

  function publicFeishuContextRecord(record = {}, index = 0) {
    const result = pickPublicFields(record, [
      'id',
      'messageId',
      'author',
      'authorId',
      'senderName',
      'senderType',
      'openId',
      'userId',
      'unionId',
      'appId',
      'createdAt',
      'time',
      'timestamp',
      'attachmentIds',
    ]) || {};
    if (record.sender && typeof record.sender === 'object') {
      const sender = pickPublicFields(record.sender, ['id', 'name', 'type', 'appId']);
      if (sender) result.sender = sender;
    }
    const text = String(record.text || record.body || record.content || '').trim();
    if (text) result.text = text;
    return Object.keys(result).length ? result : { id: `context_${index}` };
  }

  function publicFeishuMetadata(feishu = null) {
    if (!feishu || typeof feishu !== 'object') return undefined;
    const result = pickPublicFields(feishu, [
      'ackMessageId',
      'attachmentCount',
      'selectedRecordCount',
      'skippedAttachmentCount',
      'skippedReferenceCount',
    ]) || {};
    const contextRecords = records(feishu.contextRecords).map(publicFeishuContextRecord);
    if (contextRecords.length) result.contextRecords = contextRecords;
    return Object.keys(result).length ? result : undefined;
  }

  function publicExternalDeliveryMetadata(externalDelivery = null) {
    if (!externalDelivery || typeof externalDelivery !== 'object') return undefined;
    const result = {};
    const feishu = pickPublicFields(externalDelivery.feishu, [
      'status',
      'feishuMessageId',
      'sentAt',
      'traceId',
      'deliveryKind',
    ]);
    if (feishu) result.feishu = feishu;
    return Object.keys(result).length ? result : undefined;
  }

  function publicConversationMetadata(metadata = null) {
    if (!metadata || typeof metadata !== 'object') return undefined;
    const result = {};
    if (metadata.systemKind) result.systemKind = metadata.systemKind;
    const teamSharing = publicTeamSharingMetadata(metadata.teamSharing);
    if (teamSharing) result.teamSharing = teamSharing;
    const origin = pickPublicFields(metadata.origin, [
      'provider',
      'traceId',
      'chatId',
      'chatName',
      'chatType',
      'chatMode',
      'chatAvatar',
      'senderId',
      'senderName',
      'senderType',
      'senderAvatar',
      'senderOpenId',
      'senderUserId',
      'senderUnionId',
      'senderAppId',
      'triggerMessageId',
    ]);
    if (origin) result.origin = origin;
    const feishu = publicFeishuMetadata(metadata.feishu);
    if (feishu) result.feishu = feishu;
    const externalDelivery = publicExternalDeliveryMetadata(metadata.externalDelivery);
    if (externalDelivery) result.externalDelivery = externalDelivery;
    const agentStream = pickPublicFields(metadata.agentStream, ['status', 'streamId']);
    if (agentStream) result.agentStream = agentStream;
    return Object.keys(result).length ? result : undefined;
  }

  function publicConversationRecord(record) {
    const rawMetadata = record?.metadata;
    const hasMetadataField = Object.hasOwn(record || {}, 'metadata');
    const body = teamSharingDisplayBodyForRecord(record, { metadata: rawMetadata });
    const metadata = publicConversationMetadata(rawMetadata);
    const changedBody = body && body !== record?.body;
    const changedMetadata = metadata !== rawMetadata || (hasMetadataField && metadata === undefined);
    if (!changedBody && !changedMetadata) return record;
    const next = {};
    for (const key of Object.keys(record || {})) {
      if (key === 'metadata') continue;
      next[key] = record[key];
    }
    if (changedBody) next.body = body;
    if (metadata) next.metadata = metadata;
    return next;
  }

  function compactBootstrapConversationRecord(record = {}, options = {}) {
    if (!record || typeof record !== 'object') return record;
    const next = { ...record };
    if (Object.hasOwn(next, 'workspaceId')) delete next.workspaceId;
    if (next.updatedAt && next.createdAt && next.updatedAt === next.createdAt) delete next.updatedAt;
    if (
      options.previewOnly
      && typeof next.body === 'string'
      && next.body.length > BOOTSTRAP_CONVERSATION_PREVIEW_CHARS
    ) {
      next.body = next.body.slice(0, BOOTSTRAP_CONVERSATION_PREVIEW_CHARS);
      next.bodyTruncated = true;
    }
    return next;
  }

  function publicTaskMetadata(metadata = null) {
    if (!metadata || typeof metadata !== 'object') return undefined;
    const result = {};
    if (metadata.systemKind) result.systemKind = metadata.systemKind;
    return Object.keys(result).length ? result : undefined;
  }

  function publicTaskRecord(task = {}) {
    const metadata = publicTaskMetadata(task.metadata);
    const next = { ...task };
    if (metadata) next.metadata = metadata;
    else if (Object.hasOwn(next, 'metadata')) delete next.metadata;
    return next;
  }

  function compactBootstrapTaskRecord(task = {}) {
    if (!task || typeof task !== 'object') return task;
    const record = { ...task };
    if (Object.hasOwn(record, 'workspaceId')) delete record.workspaceId;
    if (record.updatedAt && record.createdAt && record.updatedAt === record.createdAt) delete record.updatedAt;
    for (const key of ['assigneeIds', 'attachmentIds', 'mentionedAgentIds', 'mentionedHumanIds', 'history']) {
      if (Array.isArray(record[key]) && record[key].length === 0) delete record[key];
    }
    return record;
  }

  function publicAgentRecord(agent = {}) {
    const record = pickPublicFields(agent, [
      'id',
      'workspaceId',
      'name',
      'description',
      'avatar',
      'role',
      'status',
      'previousStatus',
      'statusReason',
      'runtime',
      'runtimeId',
      'model',
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
      'activeWorkItemIds',
      'statusUpdatedAt',
      'heartbeatAt',
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
      'createdAt',
      'updatedAt',
    ]) || { id: agent?.id || '' };
    if (Array.isArray(agent.activeWorkItemIds)) record.activeWorkItemIds = agent.activeWorkItemIds;
    if (Object.hasOwn(agent, 'runtimeActivity') && agent.runtimeActivity === null) record.runtimeActivity = null;
    return record;
  }

  function compactBootstrapAgentRecord(agent = {}) {
    const record = { ...agent };
    for (const key of ['workspaceId', 'role', 'statusReason', 'statusUpdatedAt', 'heartbeatAt', 'updatedAt']) {
      if (Object.hasOwn(record, key)) delete record[key];
    }
    if (Array.isArray(record.activeWorkItemIds) && record.activeWorkItemIds.length === 0) {
      delete record.activeWorkItemIds;
    }
    if (record.runtime && record.runtimeId && record.runtime === record.runtimeId) {
      delete record.runtimeId;
    }
    if (record.status && record.previousStatus && record.previousStatus === record.status) {
      delete record.previousStatus;
    }
    return record;
  }

  function compactBootstrapHumanRecord(human = {}) {
    const record = { ...human };
    for (const key of ['workspaceId', 'lastSeenAt', 'presenceUpdatedAt', 'updatedAt']) {
      if (Object.hasOwn(record, key)) delete record[key];
    }
    return record;
  }

  function compactBootstrapCloudMember(member = {}, options = {}) {
    if (!member || typeof member !== 'object') return member;
    const humansById = options.humansById instanceof Map ? options.humansById : new Map();
    const record = { ...member };
    if (!record.humanId && record.human && typeof record.human === 'object' && record.human.id) {
      record.humanId = record.human.id;
    }
    const identityHuman = record.humanId ? humansById.get(String(record.humanId)) : null;
    if (record.user && typeof record.user === 'object') {
      const user = {};
      const userEmail = String(record.user.email || '').trim();
      const humanEmail = String(identityHuman?.email || '').trim();
      if (userEmail && userEmail !== humanEmail) user.email = userEmail;
      const userAvatarUrl = String(record.user.avatarUrl || '').trim();
      const humanAvatarUrl = String(identityHuman?.avatarUrl || identityHuman?.avatar || '').trim();
      if (userAvatarUrl && userAvatarUrl !== humanAvatarUrl) user.avatarUrl = userAvatarUrl;
      if (Object.keys(user).length) record.user = user;
      else delete record.user;
    }
    if (Object.hasOwn(record, 'human')) delete record.human;
    if (Object.hasOwn(record, 'workspaceId')) delete record.workspaceId;
    if (Object.hasOwn(record, 'updatedAt')) delete record.updatedAt;
    if (Object.hasOwn(record, 'createdAt')) delete record.createdAt;
    if (record.status === 'active') delete record.status;
    if (record.role === 'member') delete record.role;
    return record;
  }

  function compactBootstrapCloudState(cloud = null, options = {}) {
    if (!cloud || typeof cloud !== 'object') return cloud;
    const next = { ...cloud };
    if (Array.isArray(cloud.members)) {
      next.members = cloud.members.map((member) => compactBootstrapCloudMember(member, options));
    }
    return next;
  }

  function humansByIdForMembers(humans = [], members = [], options = {}) {
    const includeAll = options.includeAll === true;
    const memberHumanIds = includeAll
      ? null
      : new Set(records(members).map((member) => String(member?.humanId || member?.human?.id || '')).filter(Boolean));
    const result = new Map();
    for (const human of records(humans)) {
      const id = String(human?.id || '');
      if (!id) continue;
      if (includeAll || memberHumanIds.has(id)) result.set(id, human);
    }
    return result;
  }

  function directoryStats(records, total) {
    const loaded = Array.isArray(records) ? records.length : 0;
    const normalizedTotal = Math.max(loaded, Number(total || 0) || 0);
    return {
      loaded,
      total: normalizedTotal,
      hasMore: loaded < normalizedTotal,
    };
  }

  function addDirectoryId(target, value) {
    const id = String(value || '').trim();
    if (!id) return;
    if (id.startsWith('agt_')) target.agentIds.add(id);
    if (id.startsWith('hum_')) target.humanIds.add(id);
  }

  function addRecordDirectoryReferences(target, record = {}) {
    addDirectoryId(target, record.authorId);
    addDirectoryId(target, record.createdByHumanId || record.createdBy);
    addDirectoryId(target, record.ownerHumanId || record.ownerId);
    addDirectoryId(target, record.claimedBy);
    addDirectoryId(target, record.assigneeId);
    for (const id of records(record.assigneeIds)) addDirectoryId(target, id);
    for (const id of records(record.mentionedAgentIds)) addDirectoryId(target, id);
    for (const id of records(record.mentionedHumanIds)) addDirectoryId(target, id);
    String(record.body || '').replace(/<@(agt_\w+|hum_\w+)>/g, (_token, id) => {
      addDirectoryId(target, id);
      return _token;
    });
  }

  function addChannelDirectoryReferences(target, channel = {}) {
    if (!channel || typeof channel !== 'object') return;
    if (isWorkspaceAllChannel(channel)) return;
    for (const id of records(channel.memberIds)) addDirectoryId(target, id);
    for (const id of records(channel.humanIds)) addDirectoryId(target, id);
    for (const id of records(channel.agentIds)) addDirectoryId(target, id);
  }

  function addDmDirectoryReferences(target, dm = {}) {
    for (const id of records(dm?.participantIds)) addDirectoryId(target, id);
  }

  function collectVisibleDirectoryIds({
    currentHumanId = '',
    cloud = null,
    selectedAgentId = '',
    selectedHumanId = '',
    selectedChannel = null,
    visibleDms = [],
    messages = [],
    replies = [],
    tasks = [],
  } = {}) {
    const target = { agentIds: new Set(), humanIds: new Set(), memberIds: new Set() };
    addDirectoryId(target, currentHumanId);
    addDirectoryId(target, cloud?.auth?.currentMember?.humanId);
    addDirectoryId(target, selectedAgentId);
    addDirectoryId(target, selectedHumanId);
    addChannelDirectoryReferences(target, selectedChannel);
    for (const dm of records(visibleDms)) addDmDirectoryReferences(target, dm);
    for (const record of [...records(messages), ...records(replies), ...records(tasks)]) {
      addRecordDirectoryReferences(target, record);
    }
    for (const member of records(cloud?.members)) {
      if (
        target.humanIds.has(String(member?.humanId || ''))
        || target.memberIds.has(String(member?.id || ''))
        || String(member?.id || '') === String(cloud?.auth?.currentMember?.id || '')
      ) {
        if (member?.id) target.memberIds.add(String(member.id));
        if (member?.humanId) target.humanIds.add(String(member.humanId));
      }
    }
    return target;
  }

  function filterDirectoryRecords({ agents = [], humans = [], cloud = null, ids = null } = {}) {
    if (!ids) return { agents, humans, cloud };
    const nextCloud = cloud && typeof cloud === 'object' ? { ...cloud } : cloud;
    const filteredAgents = records(agents).filter((agent) => ids.agentIds.has(String(agent?.id || '')));
    const filteredHumans = records(humans).filter((human) => ids.humanIds.has(String(human?.id || '')));
    if (nextCloud && Array.isArray(nextCloud.members)) {
      nextCloud.members = nextCloud.members.filter((member) => (
        ids.memberIds.has(String(member?.id || ''))
        || ids.humanIds.has(String(member?.humanId || ''))
      ));
    }
    return { agents: filteredAgents, humans: filteredHumans, cloud: nextCloud };
  }

  function directoryMetadata({ scope = 'full', agents = [], humans = [], cloud = null, totals = {} } = {}) {
    return {
      scope,
      agents: directoryStats(agents, totals.agents),
      humans: directoryStats(humans, totals.humans),
      members: directoryStats(cloud?.members || [], totals.members),
    };
  }

  function parseDirectoryCursor(value = '') {
    const [agentOffset, humanOffset, memberOffset] = String(value || '')
      .split(':')
      .map((part) => Math.max(0, Math.floor(Number(part) || 0)));
    return {
      agentOffset: agentOffset || 0,
      humanOffset: humanOffset || 0,
      memberOffset: memberOffset || 0,
    };
  }

  function directoryCursorValue(cursor = {}) {
    return [
      Math.max(0, Math.floor(Number(cursor.agentOffset) || 0)),
      Math.max(0, Math.floor(Number(cursor.humanOffset) || 0)),
      Math.max(0, Math.floor(Number(cursor.memberOffset) || 0)),
    ].join(':');
  }

  function directoryPageLimit(value) {
    const parsed = Math.floor(Number(value) || 0);
    if (parsed <= 0) return DIRECTORY_PAGE_LIMIT_DEFAULT;
    return Math.min(DIRECTORY_PAGE_LIMIT_MAX, Math.max(1, parsed));
  }

  function directorySearchLimit(value) {
    const parsed = Math.floor(Number(value) || 0);
    if (parsed <= 0) return DIRECTORY_SEARCH_LIMIT_DEFAULT;
    return Math.min(DIRECTORY_SEARCH_LIMIT_MAX, Math.max(1, parsed));
  }

  function directoryPage(records, offset, limit) {
    const items = Array.isArray(records) ? records : [];
    if (!limit) return { records: items, nextOffset: items.length, hasMore: false };
    const start = Math.min(items.length, Math.max(0, Math.floor(Number(offset) || 0)));
    const end = Math.min(items.length, start + limit);
    return {
      records: items.slice(start, end),
      nextOffset: end,
      hasMore: end < items.length,
    };
  }

  function applyDirectoryPagination({ agents = [], humans = [], cloud = null, limit = 0, cursor = {} } = {}) {
    const nextCloud = cloud && typeof cloud === 'object' ? { ...cloud } : cloud;
    const agentPage = directoryPage(agents, cursor.agentOffset, limit);
    const humanPage = directoryPage(humans, cursor.humanOffset, limit);
    const memberPage = directoryPage(nextCloud?.members || [], cursor.memberOffset, limit);
    if (nextCloud && Array.isArray(nextCloud.members)) nextCloud.members = memberPage.records;
    const hasMore = agentPage.hasMore || humanPage.hasMore || memberPage.hasMore;
    return {
      agents: agentPage.records,
      humans: humanPage.records,
      cloud: nextCloud,
      page: {
        limit,
        cursor: directoryCursorValue(cursor),
        nextCursor: hasMore
          ? directoryCursorValue({
              agentOffset: agentPage.nextOffset,
              humanOffset: humanPage.nextOffset,
              memberOffset: memberPage.nextOffset,
            })
          : '',
        hasMore,
      },
    };
  }

  function normalizeDirectorySearchQuery(value = '') {
    return String(value || '').trim().toLowerCase();
  }

  function directorySearchText(values = []) {
    return records(values)
      .map((value) => String(value || '').trim().toLowerCase())
      .filter(Boolean)
      .join(' ');
  }

  function directorySearchMatches(text, query) {
    if (!query) return true;
    return String(text || '').includes(query);
  }

  function directorySearchSingleValueMatches(value, query) {
    if (!query) return true;
    if (value === undefined || value === null || value === '') return false;
    const text = String(value);
    if (!text) return false;
    if (text.includes(query)) return true;
    const lowered = text.toLowerCase();
    return lowered !== text && lowered.includes(query);
  }

  function directorySearchHasWhitespace(query = '') {
    return /\s/.test(String(query || ''));
  }

  function agentDirectorySearchText(agent = {}) {
    return directorySearchText([
      agent.id,
      agent.name,
      agent.description,
      agent.runtime,
      agent.runtimeId,
      agent.model,
      agent.creatorName,
      agent.creatorEmail,
    ]);
  }

  function agentDirectorySearchMatches(agent = {}, query = '') {
    if (!query) return true;
    if (directorySearchHasWhitespace(query)) return directorySearchMatches(agentDirectorySearchText(agent), query);
    return directorySearchSingleValueMatches(agent.id, query)
      || directorySearchSingleValueMatches(agent.name, query)
      || directorySearchSingleValueMatches(agent.description, query)
      || directorySearchSingleValueMatches(agent.runtime, query)
      || directorySearchSingleValueMatches(agent.runtimeId, query)
      || directorySearchSingleValueMatches(agent.model, query)
      || directorySearchSingleValueMatches(agent.creatorName, query)
      || directorySearchSingleValueMatches(agent.creatorEmail, query);
  }

  function humanDirectorySearchText(human = {}) {
    return directorySearchText([
      human.id,
      human.name,
      human.email,
      human.authUserId,
      human.userId,
      human.identityReference,
      human.role,
      human.thirdPartyName,
      human.third_party_name,
    ]);
  }

  function humanDirectorySearchMatches(human = {}, query = '') {
    if (!query) return true;
    if (directorySearchHasWhitespace(query)) return directorySearchMatches(humanDirectorySearchText(human), query);
    return directorySearchSingleValueMatches(human.id, query)
      || directorySearchSingleValueMatches(human.name, query)
      || directorySearchSingleValueMatches(human.email, query)
      || directorySearchSingleValueMatches(human.authUserId, query)
      || directorySearchSingleValueMatches(human.userId, query)
      || directorySearchSingleValueMatches(human.identityReference, query)
      || directorySearchSingleValueMatches(human.role, query)
      || directorySearchSingleValueMatches(human.thirdPartyName, query)
      || directorySearchSingleValueMatches(human.third_party_name, query);
  }

  function memberDirectorySearchText(member = {}, human = null) {
    return directorySearchText([
      member.id,
      member.userId,
      member.humanId,
      member.email,
      member.role,
      member.user?.id,
      member.user?.name,
      member.user?.email,
      member.user?.thirdPartyName,
      member.user?.third_party_name,
      member.human?.name,
      member.human?.email,
      human?.name,
      human?.email,
      human?.authUserId,
      human?.userId,
      human?.thirdPartyName,
      human?.third_party_name,
    ]);
  }

  function memberDirectorySearchMatches(member = {}, human = null, query = '') {
    if (!query) return true;
    if (directorySearchHasWhitespace(query)) return directorySearchMatches(memberDirectorySearchText(member, human), query);
    return directorySearchSingleValueMatches(member.id, query)
      || directorySearchSingleValueMatches(member.userId, query)
      || directorySearchSingleValueMatches(member.humanId, query)
      || directorySearchSingleValueMatches(member.email, query)
      || directorySearchSingleValueMatches(member.role, query)
      || directorySearchSingleValueMatches(member.user?.id, query)
      || directorySearchSingleValueMatches(member.user?.name, query)
      || directorySearchSingleValueMatches(member.user?.email, query)
      || directorySearchSingleValueMatches(member.user?.thirdPartyName, query)
      || directorySearchSingleValueMatches(member.user?.third_party_name, query)
      || directorySearchSingleValueMatches(member.human?.name, query)
      || directorySearchSingleValueMatches(member.human?.email, query)
      || directorySearchSingleValueMatches(human?.name, query)
      || directorySearchSingleValueMatches(human?.email, query)
      || directorySearchSingleValueMatches(human?.authUserId, query)
      || directorySearchSingleValueMatches(human?.userId, query)
      || directorySearchSingleValueMatches(human?.thirdPartyName, query)
      || directorySearchSingleValueMatches(human?.third_party_name, query);
  }

  function directorySearchTypes(value = '') {
    const raw = String(value || 'agents,humans,members')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    const allowed = new Set(['agents', 'humans', 'members']);
    const selected = raw.filter((item) => allowed.has(item));
    return selected.length ? new Set(selected) : allowed;
  }

  function limitedDirectorySearch(recordsInput, matcher, limit) {
    const matched = [];
    let total = 0;
    for (const record of records(recordsInput)) {
      if (!matcher(record)) continue;
      total += 1;
      if (matched.length < limit) matched.push(record);
    }
    return { records: matched, total };
  }

  function directorySearchSnapshot({ agents = [], humans = [], cloud = null, query = '', limit = DIRECTORY_SEARCH_LIMIT_DEFAULT, types = null } = {}) {
    const selectedTypes = types instanceof Set ? types : directorySearchTypes();
    const agentMatches = selectedTypes.has('agents')
      ? limitedDirectorySearch(agents, (agent) => agentDirectorySearchMatches(agent, query), limit)
      : { records: [], total: 0 };
    const humanMatches = selectedTypes.has('humans')
      ? limitedDirectorySearch(humans, (human) => humanDirectorySearchMatches(human, query), limit)
      : { records: [], total: 0 };
    const humansById = selectedTypes.has('members')
      ? new Map(records(humans).map((human) => [String(human?.id || ''), human]).filter(([id]) => id))
      : new Map();
    const memberMatches = selectedTypes.has('members')
      ? limitedDirectorySearch(
          cloud?.members,
          (member) => memberDirectorySearchMatches(member, humansById.get(String(member?.humanId || '')), query),
          limit,
        )
      : { records: [], total: 0 };
    return {
      agents: agentMatches.records,
      humans: humanMatches.records,
      cloud: cloud && typeof cloud === 'object' ? { ...cloud, members: memberMatches.records } : cloud,
      totals: {
        agents: agentMatches.total,
        humans: humanMatches.total,
        members: memberMatches.total,
      },
    };
  }

  function membersDirectoryPageNumber(value) {
    const parsed = Math.floor(Number(value) || 0);
    return Math.max(1, parsed || 1);
  }

  function membersDirectoryPageSize(value) {
    const parsed = Math.floor(Number(value) || 0);
    if (parsed <= 0) return MEMBERS_DIRECTORY_PAGE_SIZE_DEFAULT;
    return Math.min(MEMBERS_DIRECTORY_PAGE_SIZE_MAX, Math.max(1, parsed));
  }

  function normalizeMembersDirectoryQuery(value = '') {
    return String(value || '').trim().toLowerCase();
  }

  function membersDirectoryWorkspaceId(cloud = null) {
    return String(cloud?.workspace?.id || cloud?.auth?.currentMember?.workspaceId || '').trim();
  }

  function memberDirectoryHumanRecord(member = {}, humansById = new Map()) {
    if (member?.human && typeof member.human === 'object') return member.human;
    const humanId = String(member?.humanId || '').trim();
    if (humanId && humansById.has(humanId)) return humansById.get(humanId);
    const userId = String(member?.userId || member?.user?.id || '').trim();
    if (userId && humansById.has(userId)) return humansById.get(userId);
    const email = String(member?.user?.email || member?.email || '').trim().toLowerCase();
    if (email && humansById.has(email)) return humansById.get(email);
    return {};
  }

  function memberDirectoryEmail(member = {}, humansById = new Map()) {
    const human = memberDirectoryHumanRecord(member, humansById);
    return String(member?.user?.email || human?.email || member?.email || member?.userId || '').trim();
  }

  function memberDirectoryDisplayName(member = {}, humansById = new Map()) {
    const human = memberDirectoryHumanRecord(member, humansById);
    return String(member?.user?.name || human?.name || member?.name || member?.user?.email || member?.email || member?.humanId || 'Member').trim();
  }

  function memberDirectorySortTimestamp(value) {
    const timestamp = Date.parse(value || '');
    return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
  }

  function compareMemberDirectorySortParts(a, b) {
    const timeDiff = memberDirectorySortTimestamp(a?.invitedAt) - memberDirectorySortTimestamp(b?.invitedAt);
    if (timeDiff) return timeDiff;
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  }

  function acceptedInvitationForDirectoryMember(member = {}, invitations = [], humansById = new Map()) {
    const email = memberDirectoryEmail(member, humansById).toLowerCase();
    const userId = String(member?.user?.id || member?.userId || '').trim();
    return records(invitations)
      .filter((invitation) => {
        if (!invitation?.acceptedAt) return false;
        if (userId && invitation.acceptedBy === userId) return true;
        return email && String(invitation.email || '').trim().toLowerCase() === email;
      })
      .sort((a, b) => compareMemberDirectorySortParts(
        { invitedAt: a.createdAt, id: a.id },
        { invitedAt: b.createdAt, id: b.id },
      ))[0] || null;
  }

  function compactMembersDirectoryUser(user = null, human = {}) {
    if (!user || typeof user !== 'object') return null;
    const record = {};
    for (const key of ['id', 'name', 'email', 'avatarUrl', 'avatar']) {
      if (usefulMetadataValue(user[key])) record[key] = user[key];
    }
    if (record.email && human?.email && String(record.email) === String(human.email)) delete record.email;
    if (record.avatarUrl && (human?.avatarUrl || human?.avatar) && String(record.avatarUrl) === String(human.avatarUrl || human.avatar)) delete record.avatarUrl;
    return Object.keys(record).length ? record : null;
  }

  function compactMembersDirectoryHuman(human = {}) {
    if (!human || typeof human !== 'object' || !human.id) return null;
    const record = compactBootstrapHumanRecord(human);
    if (human.lastSeenAt) record.lastSeenAt = human.lastSeenAt;
    if (human.presenceUpdatedAt) record.presenceUpdatedAt = human.presenceUpdatedAt;
    if (human.joinedAt) record.joinedAt = human.joinedAt;
    return record;
  }

  function compactMembersDirectoryMember(member = {}, humansById = new Map()) {
    const human = memberDirectoryHumanRecord(member, humansById);
    const record = {};
    for (const key of ['id', 'userId', 'humanId', 'role', 'status', 'joinedAt', 'createdAt']) {
      if (usefulMetadataValue(member[key])) record[key] = member[key];
    }
    const user = compactMembersDirectoryUser(member.user, human);
    if (user) record.user = user;
    const compactHuman = compactMembersDirectoryHuman(human);
    if (compactHuman) record.human = compactHuman;
    return record;
  }

  function compactMembersDirectoryInvitation(invitation = {}) {
    const record = {};
    for (const key of ['id', 'email', 'name', 'role', 'status', 'humanId', 'acceptedAt', 'revokedAt', 'expiresAt', 'createdAt']) {
      if (usefulMetadataValue(invitation[key])) record[key] = invitation[key];
    }
    return record;
  }

  function memberDirectoryRowSearchText(row = {}, humansById = new Map()) {
    if (row.type === 'invitation') {
      const invitation = row.invitation || {};
      return directorySearchText([
        invitation.id,
        invitation.email,
        invitation.name,
        invitation.role,
        invitation.status,
      ]);
    }
    const member = row.member || {};
    return directorySearchText([
      member.id,
      member.userId,
      member.humanId,
      member.role,
      member.status,
      memberDirectoryDisplayName(member, humansById),
      memberDirectoryEmail(member, humansById),
      member.user?.name,
      member.user?.email,
      member.human?.name,
      member.human?.email,
    ]);
  }

  function memberDirectorySortParts(row = {}, humansById = new Map()) {
    if (row.type === 'invitation') {
      return {
        group: 1,
        invitedAt: row.invitation?.createdAt,
        id: row.invitation?.id || row.invitation?.email || '',
      };
    }
    const member = row.member || {};
    const human = memberDirectoryHumanRecord(member, humansById);
    return {
      group: 0,
      invitedAt: row.invitation?.createdAt || member.createdAt || member.joinedAt || human.createdAt || human.joinedAt,
      id: row.invitation?.id || member.id || member.userId || memberDirectoryEmail(member, humansById),
    };
  }

  function compareMembersDirectoryRows(a, b, humansById = new Map()) {
    const left = memberDirectorySortParts(a, humansById);
    const right = memberDirectorySortParts(b, humansById);
    const groupDiff = left.group - right.group;
    if (groupDiff) return groupDiff;
    return compareMemberDirectorySortParts(left, right);
  }

  function compactMembersDirectoryRow(row = {}, humansById = new Map()) {
    if (row.type === 'invitation') {
      return {
        type: 'invitation',
        invitation: compactMembersDirectoryInvitation(row.invitation),
        sortAt: row.sortAt || '',
      };
    }
    return {
      type: 'member',
      member: compactMembersDirectoryMember(row.member, humansById),
      invitation: row.invitation ? compactMembersDirectoryInvitation(row.invitation) : null,
      sortAt: row.sortAt || '',
    };
  }

  function buildMembersDirectoryRows({ cloud = null, humans = [], query = '' } = {}) {
    const workspaceId = membersDirectoryWorkspaceId(cloud);
    const humansById = new Map();
    for (const human of records(humans)) {
      if (human?.id) humansById.set(String(human.id), human);
      if (human?.authUserId) humansById.set(String(human.authUserId), human);
      if (human?.userId) humansById.set(String(human.userId), human);
      if (human?.email) humansById.set(String(human.email).toLowerCase(), human);
    }
    const invitations = records(cloud?.invitations).filter((invitation) => (
      !workspaceId
      || !invitation?.workspaceId
      || String(invitation.workspaceId) === workspaceId
    ));
    const activeMembers = records(cloud?.members)
      .filter((member) => (
        (!workspaceId || !member?.workspaceId || String(member.workspaceId) === workspaceId)
        && String(member?.status || 'active') === 'active'
      ));
    const activeEmails = new Set(activeMembers.map((member) => memberDirectoryEmail(member, humansById).toLowerCase()).filter(Boolean));
    const rows = [
      ...activeMembers.map((member) => {
        const invitation = acceptedInvitationForDirectoryMember(member, invitations, humansById);
        const human = memberDirectoryHumanRecord(member, humansById);
        return {
          type: 'member',
          member,
          invitation,
          sortAt: invitation?.createdAt || member.createdAt || member.joinedAt || human.createdAt || human.joinedAt || '',
        };
      }),
      ...invitations
        .filter((invitation) => !invitation.acceptedAt && !invitation.revokedAt)
        .filter((invitation) => !invitation.expiresAt || Date.parse(invitation.expiresAt) > Date.now())
        .filter((invitation) => !activeEmails.has(String(invitation.email || '').trim().toLowerCase()))
        .map((invitation) => ({
          type: 'invitation',
          invitation,
          sortAt: invitation.createdAt || '',
        })),
    ];
    const filteredRows = query
      ? rows.filter((row) => directorySearchMatches(memberDirectoryRowSearchText(row, humansById), query))
      : rows;
    return {
      rows: filteredRows.sort((a, b) => compareMembersDirectoryRows(a, b, humansById)),
      humansById,
    };
  }

  function membersDirectoryPageSnapshot({ cloud = null, humans = [], query = '', page = 1, pageSize = MEMBERS_DIRECTORY_PAGE_SIZE_DEFAULT } = {}) {
    const { rows, humansById } = buildMembersDirectoryRows({ cloud, humans, query });
    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const safePage = Math.min(Math.max(1, Number(page) || 1), totalPages);
    const start = (safePage - 1) * pageSize;
    const pageRows = rows.slice(start, start + pageSize).map((row) => compactMembersDirectoryRow(row, humansById));
    return {
      mode: 'members-directory',
      query,
      page: safePage,
      pageSize,
      total,
      totalPages,
      hasMore: safePage < totalPages,
      rows: pageRows,
    };
  }

  function compactTuple(values = []) {
    let lastIndex = values.length - 1;
    while (lastIndex >= 0) {
      if (usefulMetadataValue(values[lastIndex])) break;
      lastIndex -= 1;
    }
    return values.slice(0, lastIndex + 1);
  }

  function bootstrapTupleRecord(record = {}, fields = []) {
    if (!record || typeof record !== 'object') return record;
    const fieldSet = new Set(fields);
    const extra = {};
    for (const [key, value] of Object.entries(record)) {
      if (!fieldSet.has(key) && usefulMetadataValue(value)) extra[key] = value;
    }
    const values = fields.map((field) => (usefulMetadataValue(record[field]) ? record[field] : null));
    values.push(Object.keys(extra).length ? extra : null);
    return compactTuple(values);
  }

  function encodeBootstrapDirectories(snapshot = {}, options = {}) {
    if (options.directoryFormat !== BOOTSTRAP_DIRECTORY_FORMAT_TUPLE) return snapshot;
    const next = {
      ...snapshot,
      bootstrap: {
        ...(snapshot.bootstrap || {}),
        directoryFormat: BOOTSTRAP_DIRECTORY_FORMAT_TUPLE,
      },
    };
    if (Array.isArray(snapshot.agents)) {
      next.agents = snapshot.agents.map((agent) => bootstrapTupleRecord(agent, BOOTSTRAP_AGENT_TUPLE_FIELDS));
    }
    if (Array.isArray(snapshot.humans)) {
      next.humans = snapshot.humans.map((human) => bootstrapTupleRecord(human, BOOTSTRAP_HUMAN_TUPLE_FIELDS));
    }
    if (snapshot.cloud && typeof snapshot.cloud === 'object' && Array.isArray(snapshot.cloud.members)) {
      next.cloud = {
        ...snapshot.cloud,
        members: snapshot.cloud.members.map((member) => bootstrapTupleRecord(member, BOOTSTRAP_CLOUD_MEMBER_TUPLE_FIELDS)),
      };
    }
    return next;
  }

  function encodeBootstrapConversationRecords(snapshot = {}, options = {}) {
    if (options.conversationFormat !== BOOTSTRAP_CONVERSATION_FORMAT_TUPLE) return snapshot;
    const next = {
      ...snapshot,
      bootstrap: {
        ...(snapshot.bootstrap || {}),
        conversationFormat: BOOTSTRAP_CONVERSATION_FORMAT_TUPLE,
        conversationFields: {
          messages: BOOTSTRAP_MESSAGE_TUPLE_FIELDS,
          replies: BOOTSTRAP_REPLY_TUPLE_FIELDS,
          tasks: BOOTSTRAP_TASK_TUPLE_FIELDS,
        },
      },
    };
    if (Array.isArray(snapshot.messages)) {
      next.messages = snapshot.messages.map((message) => bootstrapTupleRecord(message, BOOTSTRAP_MESSAGE_TUPLE_FIELDS));
    }
    if (Array.isArray(snapshot.replies)) {
      next.replies = snapshot.replies.map((reply) => bootstrapTupleRecord(reply, BOOTSTRAP_REPLY_TUPLE_FIELDS));
    }
    if (Array.isArray(snapshot.tasks)) {
      next.tasks = snapshot.tasks.map((task) => bootstrapTupleRecord(task, BOOTSTRAP_TASK_TUPLE_FIELDS));
    }
    return next;
  }

  function compactBootstrapChannelRecord(channel = {}) {
    if (!channel || typeof channel !== 'object') return channel;
    const record = { ...channel };
    if (!isWorkspaceAllChannel(record)) return record;
    const memberIds = new Set([
      ...records(record.memberIds),
      ...records(record.humanIds),
      ...records(record.agentIds),
    ].map(String).filter(Boolean));
    record.membershipMode = 'all';
    record.memberCount = memberIds.size || Number(record.memberCount || 0) || 0;
    delete record.memberIds;
    delete record.humanIds;
    delete record.agentIds;
    return record;
  }

  function bootstrapOptionsFromRequest(req) {
    try {
      const url = new URL(req?.url || '/', 'http://magclaw.local');
      const options = {
        spaceType: url.searchParams.get('spaceType') || '',
        spaceId: url.searchParams.get('spaceId') || '',
        threadMessageId: url.searchParams.get('threadMessageId') || '',
        messageLimit: url.searchParams.get('messageLimit') || '',
        threadRootLimit: url.searchParams.get('threadRootLimit') || '',
        eventLimit: url.searchParams.get('eventLimit') || '',
        taskLimit: url.searchParams.get('taskLimit') || '',
      };
      const directoryFormat = url.searchParams.get('directoryFormat') || '';
      if (directoryFormat) options.directoryFormat = directoryFormat;
      const conversationFormat = url.searchParams.get('conversationFormat') || '';
      if (conversationFormat) options.conversationFormat = conversationFormat;
      const directoryScope = url.searchParams.get('directoryScope') || '';
      if (directoryScope) options.directoryScope = directoryScope;
      const selectedAgentId = url.searchParams.get('selectedAgentId') || '';
      if (selectedAgentId) options.selectedAgentId = selectedAgentId;
      const selectedHumanId = url.searchParams.get('selectedHumanId') || '';
      if (selectedHumanId) options.selectedHumanId = selectedHumanId;
      const limit = url.searchParams.get('limit') || '';
      if (limit) options.limit = limit;
      const cursor = url.searchParams.get('cursor') || '';
      if (cursor) options.cursor = cursor;
      const page = url.searchParams.get('page') || '';
      if (page) options.page = page;
      const pageSize = url.searchParams.get('pageSize') || '';
      if (pageSize) options.pageSize = pageSize;
      const query = url.searchParams.get('query') || '';
      if (query) options.query = query;
      const q = url.searchParams.get('q') || '';
      if (q && !options.query) options.query = q;
      const types = url.searchParams.get('types') || '';
      if (types) options.types = types;
      if (req?.magclawBootstrapHydration) options.hydration = req.magclawBootstrapHydration;
      return options;
    } catch {
      return {};
    }
  }

  function publicStateScope(req = null, options = {}) {
    const currentState = getState() || {};
    const cloud = typeof publicCloudState === 'function' ? publicCloudState(req) : undefined;
    const currentHumanId = cloud?.auth?.currentMember?.humanId || null;
    const includeConversationArrays = options.includeConversationArrays !== false;
    const channels = records(currentState.channels);
    const dms = records(currentState.dms);
    const messages = includeConversationArrays ? records(currentState.messages) : [];
    const replies = includeConversationArrays ? records(currentState.replies) : [];
    const activeWorkspaceId = cloud?.auth?.currentMember?.workspaceId || cloud?.workspace?.id || '';
    const scopeToWorkspace = Boolean(cloud?.auth?.currentUser && cloud?.auth?.currentMember && activeWorkspaceId);
    const keepLegacyUnscopedRecords = cloud?.auth?.storageBackend !== 'postgres';
    const inCurrentWorkspace = (record) => (
      !scopeToWorkspace
      || String(record?.workspaceId || '') === String(activeWorkspaceId)
      || (!record?.workspaceId && keepLegacyUnscopedRecords)
    );
    const scopedChannels = channels.filter(inCurrentWorkspace);
    const scopedDms = dms.filter(inCurrentWorkspace);
    const scopedMessages = includeConversationArrays ? messages.filter(inCurrentWorkspace) : [];
    const scopedReplies = includeConversationArrays ? replies.filter(inCurrentWorkspace) : [];
    const scopedRecords = (key) => records(currentState[key]).filter(inCurrentWorkspace);
    const scopedAgents = scopedRecords('agents');
    let agentBoundComputerIds = null;
    const boundComputerIds = () => {
      if (agentBoundComputerIds) return agentBoundComputerIds;
      agentBoundComputerIds = new Set();
      for (const agent of scopedAgents) {
        if (!agent || agent.deletedAt) continue;
        const computerId = String(agent.computerId || '');
        if (computerId) agentBoundComputerIds.add(computerId);
      }
      return agentBoundComputerIds;
    };
    const visibleComputers = scopedRecords('computers').filter((computer) => {
      const status = String(computer?.status || '').toLowerCase();
      if (status === 'connected' || computer?.lastSeenAt) return true;
      const hasBoundAgent = boundComputerIds().has(String(computer?.id || ''));
      if (hasBoundAgent) return true;
      if (computer?.metadata?.pairingProvisional) return false;
      return !(
        status === 'pairing'
        && String(computer?.connectedVia || '').toLowerCase() === 'daemon'
        && records(computer?.runtimeIds).length === 0
      );
    });
    const visibleDms = currentHumanId
      ? scopedDms.filter((dm) => records(dm.participantIds).includes(currentHumanId))
      : scopedDms;
    const visibleDmIds = new Set(visibleDms.map((dm) => dm.id));
    const conversationVisible = (record) => record.spaceType !== 'dm' || visibleDmIds.has(record.spaceId);
    return {
      currentState,
      cloud,
      currentHumanId,
      scopedChannels,
      scopedDms,
      scopedMessages,
      scopedReplies,
      scopedRecords,
      scopedAgents,
      visibleComputers,
      visibleDms,
      visibleDmIds,
      inCurrentWorkspace,
      conversationVisible,
    };
  }

  function publicState(req = null) {
    const scope = publicStateScope(req);
    const {
      currentState,
      cloud,
      currentHumanId,
      scopedChannels,
      scopedMessages,
      scopedReplies,
      scopedRecords,
      scopedAgents,
      visibleComputers,
      visibleDms,
      conversationVisible,
    } = scope;
    const publicBase = publicStateBase(currentState);
    if (cloud?.auth?.currentUser && !cloud?.auth?.currentMember) {
      return {
        ...publicBase,
        channels: [],
        dms: [],
        messages: [],
        replies: [],
        tasks: [],
        agents: [],
        computers: [],
        humans: [],
        reminders: [],
        missions: [],
        runs: [],
        attachments: [],
        projects: [],
        channelMemberProposals: [],
        workItems: [],
        events: [],
        routeEvents: [],
        systemNotifications: [],
        settings: publicSettings(cloud),
        connection: publicConnection(),
        cloud,
        releaseNotes: publicReleaseNotes(),
        runtime: runtimeSnapshot(),
        runningRunIds: [],
      };
    }
    const visibleMessages = scopedMessages
      .filter(conversationVisible)
      .map(publicConversationRecord);
    const visibleReplies = scopedReplies
      .filter(conversationVisible)
      .map(publicConversationRecord);
    const visibleHumans = appendReferencedHumans(scopedRecords('humans'), [...visibleMessages, ...visibleReplies], currentState);
    return {
      ...publicBase,
      settings: publicSettings(cloud),
      channels: scopedChannels.filter((channel) => !channel.archived),
      dms: visibleDms,
      messages: visibleMessages,
      replies: visibleReplies,
      tasks: scopedRecords('tasks').map(publicTaskRecord),
      agents: scopedAgents.map(publicAgentRecord),
      computers: visibleComputers,
      humans: visibleHumans,
      reminders: scopedRecords('reminders'),
      missions: scopedRecords('missions'),
      runs: scopedRecords('runs'),
      attachments: scopedRecords('attachments'),
      projects: scopedRecords('projects'),
      channelMemberProposals: scopedRecords('channelMemberProposals'),
      workItems: scopedRecords('workItems'),
      events: scopedRecords('events'),
      routeEvents: scopedRecords('routeEvents'),
      systemNotifications: scopedRecords('systemNotifications'),
      connection: publicConnection(),
      cloud,
      releaseNotes: publicReleaseNotes(),
      runtime: runtimeSnapshot(),
      runningRunIds: [...runningProcesses.keys()],
    };
  }

  function publicStateBase(currentState = {}) {
    const base = {};
    for (const key of ['createdAt', 'updatedAt', 'version']) {
      if (Object.hasOwn(currentState, key)) base[key] = currentState[key];
    }
    if (currentState.router && typeof currentState.router === 'object') {
      base.router = currentState.router;
    }
    if (currentState.storage && typeof currentState.storage === 'object') {
      base.storage = currentState.storage;
    }
    if (currentState.inboxReads && typeof currentState.inboxReads === 'object') {
      base.inboxReads = currentState.inboxReads;
    }
    return base;
  }

  function publicBootstrapState(req = null, options = {}) {
    const scope = publicStateScope(req, { includeConversationArrays: false });
    const {
      currentState,
      cloud,
      currentHumanId,
      scopedChannels,
      scopedRecords,
      scopedAgents,
      visibleComputers,
      visibleDms,
      inCurrentWorkspace,
      conversationVisible,
    } = scope;
    if (cloud?.auth?.currentUser && !cloud?.auth?.currentMember) return publicState(req);
    if (!Array.isArray(scopedChannels)) return publicState(req);
    const effectiveOptions = { ...bootstrapOptionsFromRequest(req), ...options };

    const spaceType = ['channel', 'dm'].includes(effectiveOptions.spaceType) ? effectiveOptions.spaceType : 'channel';
    const fallbackSpaceId = spaceType === 'dm'
      ? visibleDms?.[0]?.id
      : scopedChannels?.[0]?.id;
    const spaceId = String(effectiveOptions.spaceId || fallbackSpaceId || 'chan_all');
    const threadMessageId = String(effectiveOptions.threadMessageId || '');
    const messageLimit = clampLimit(effectiveOptions.messageLimit, 80, 200);
    const threadReplyLimit = clampLimit(effectiveOptions.replyLimit || effectiveOptions.messageLimit, 80, 300);
    const threadRootLimit = clampLimit(effectiveOptions.threadRootLimit, 120, 300);
    const eventLimit = clampLimit(effectiveOptions.eventLimit, 120, 300);
    const taskLimit = clampLimit(effectiveOptions.taskLimit, 160, 500);
    const directoryScope = effectiveOptions.directoryScope === BOOTSTRAP_DIRECTORY_SCOPE_VISIBLE
      ? BOOTSTRAP_DIRECTORY_SCOPE_VISIBLE
      : 'full';
    const visibleConversationRecord = (record) => Boolean(record)
      && inCurrentWorkspace(record)
      && conversationVisible(record);
    const sourceMessages = Array.isArray(currentState.messages) ? currentState.messages : [];
    const sourceReplies = Array.isArray(currentState.replies) ? currentState.replies : [];
    const selectedChannel = spaceType === 'channel'
      ? scopedChannels.find((channel) => String(channel?.id || '') === spaceId)
      : null;

    const [selectedMessagePage, threadRootMessagePage] = newestRecordPages(sourceMessages, [
      {
        limit: messageLimit,
        predicate: (message) => visibleConversationRecord(message)
          && message.spaceType === spaceType
          && String(message.spaceId) === spaceId,
      },
      {
        limit: threadRootLimit,
        predicate: (message) => (
          visibleConversationRecord(message)
          && (Number(message.replyCount || 0) > 0
          || message.taskId
          || records(message.savedBy).length
          || String(message.id || '') === threadMessageId)
        ),
      },
    ]);
    const selectedMessages = selectedMessagePage.records.slice().sort(compareOldestRecords);
    const fullMessageIds = new Set(selectedMessages.map((message) => String(message?.id || '')).filter(Boolean));
    const selectedMessageCursor = selectedMessages[0] || null;
    const hydratedMessagePagination = effectiveOptions.hydration?.messages?.pagination || null;
    const threadRoots = threadRootMessagePage.records;
    const messageById = new Map();
    for (const message of [...selectedMessages, ...threadRoots]) messageById.set(message.id, message);
    if (threadMessageId && !messageById.has(threadMessageId)) {
      const threadRoot = sourceMessages.find((message) => (
        visibleConversationRecord(message)
        && String(message.id || '') === threadMessageId
      ));
      if (threadRoot) messageById.set(threadRoot.id, threadRoot);
    }
    if (threadMessageId) fullMessageIds.add(threadMessageId);

    const latestReplyByParent = new Map();
    const selectedThreadReplyPages = newestRecordPages(
      sourceReplies,
      threadMessageId
        ? [{
            limit: threadReplyLimit,
            predicate: (reply) => visibleConversationRecord(reply)
              && String(reply?.parentMessageId || '') === threadMessageId,
          }]
        : [],
      {
        visit: (reply) => {
          if (!visibleConversationRecord(reply)) return;
          const parentMessageId = reply.parentMessageId;
          if (!messageById.has(parentMessageId)) return;
          const previous = latestReplyByParent.get(parentMessageId);
          if (!previous || compareNewestRecords(reply, previous) < 0) latestReplyByParent.set(parentMessageId, reply);
        },
      },
    );
    const selectedThreadReplyPage = threadMessageId
      ? selectedThreadReplyPages[0] || { records: [], total: 0, hasMore: false }
      : { records: [], total: 0, hasMore: false };
    const selectedThreadReplies = selectedThreadReplyPage.records.slice().sort(compareOldestRecords);
    const fullReplyIds = new Set(selectedThreadReplies.map((reply) => String(reply?.id || '')).filter(Boolean));
    const selectedThreadReplyCursor = selectedThreadReplies[0] || null;
    const threadRepliesPagination = effectiveOptions.hydration?.replies?.pagination
      || (threadMessageId
        ? {
            limit: threadReplyLimit,
            hasMore: selectedThreadReplyPage.hasMore,
            nextBefore: selectedThreadReplyCursor?.createdAt || '',
            nextBeforeId: selectedThreadReplyCursor?.id || '',
          }
        : null);
    const replyById = new Map();
    for (const reply of [...latestReplyByParent.values(), ...selectedThreadReplies]) replyById.set(reply.id, reply);
    const unreadHydration = includeUnreadConversationRecords({
      currentHumanId,
      messages: sourceMessages,
      replies: sourceReplies,
      messageById,
      replyById,
      recordVisible: visibleConversationRecord,
    });

    const taskIds = new Set();
    for (const message of messageById.values()) {
      if (message.taskId) taskIds.add(message.taskId);
    }
    const sourceTasks = Array.isArray(currentState.tasks) ? currentState.tasks : [];
    const taskInScope = (task) => Boolean(task) && inCurrentWorkspace(task);
    const openStatuses = new Set(['todo', 'in_progress', 'in_review']);
    const memberChannelIds = new Set();
    for (const channel of scopedChannels) {
      if (
        !currentHumanId
        || records(channel.memberIds).includes(currentHumanId)
        || records(channel.humanIds).includes(currentHumanId)
      ) {
        memberChannelIds.add(channel.id);
      }
    }
    const selectedSpaceTaskPage = [];
    const globalTaskPage = [];
    const referencedTaskById = new Map();
    let openTaskCount = 0;
    const [selectedSpaceTasks, globalChannelTasks] = newestRecordPages(sourceTasks, [
      {
        limit: taskLimit,
        predicate: (task) => taskInScope(task)
          && task.spaceType === spaceType
          && String(task.spaceId) === spaceId,
      },
      {
        limit: taskLimit,
        predicate: (task) => taskInScope(task)
          && task.spaceType === 'channel'
          && (!currentHumanId || memberChannelIds.has(task.spaceId)),
      },
    ], {
      visit: (task) => {
        if (!taskInScope(task)) return;
        if (openStatuses.has(String(task.status || 'todo'))) openTaskCount += 1;
        if (taskIds.has(task.id)) referencedTaskById.set(task.id, task);
      },
    });
    selectedSpaceTaskPage.push(...selectedSpaceTasks.records);
    globalTaskPage.push(...globalChannelTasks.records);
    const visibleTaskById = new Map();
    for (const task of [...selectedSpaceTaskPage, ...globalTaskPage]) {
      if (task?.id) visibleTaskById.set(task.id, task);
    }
    for (const task of referencedTaskById.values()) {
      visibleTaskById.set(task.id, task);
    }
    const visibleTasks = [...visibleTaskById.values()]
      .sort(compareTaskRecords)
      .map(publicTaskRecord)
      .map(compactBootstrapTaskRecord);

    const attachmentIds = new Set();
    for (const record of [...messageById.values(), ...replyById.values(), ...visibleTasks]) {
      for (const id of records(record.attachmentIds)) attachmentIds.add(String(id));
    }
    const directoryMessages = [...messageById.values()];
    const directoryReplies = [...replyById.values()];
    const visibleDirectoryIds = directoryScope === BOOTSTRAP_DIRECTORY_SCOPE_VISIBLE
      ? collectVisibleDirectoryIds({
          currentHumanId,
          cloud,
          selectedAgentId: effectiveOptions.selectedAgentId,
          selectedHumanId: effectiveOptions.selectedHumanId,
          selectedChannel,
          visibleDms,
          messages: directoryMessages,
          replies: directoryReplies,
          tasks: visibleTasks,
        })
      : null;
    let rawDirectoryHumans;
    let directoryHumanTotal;
    if (visibleDirectoryIds) {
      const visibleHumans = visibleDirectoryHumansForIds(currentState.humans, visibleDirectoryIds, inCurrentWorkspace);
      rawDirectoryHumans = visibleHumans.humans;
      directoryHumanTotal = visibleHumans.total;
    } else {
      rawDirectoryHumans = appendReferencedHumans(
        scopedRecords('humans'),
        [...directoryMessages, ...directoryReplies],
        currentState,
      );
      directoryHumanTotal = rawDirectoryHumans.length;
    }
    const directoryTotals = {
      agents: scopedAgents.length,
      humans: directoryHumanTotal,
      members: Array.isArray(cloud?.members) ? cloud.members.length : records(cloud?.members).length,
    };
    const rawDirectory = filterDirectoryRecords({
      agents: scopedAgents,
      humans: rawDirectoryHumans,
      cloud,
      ids: visibleDirectoryIds,
    });
    const directoryHumans = records(rawDirectory.humans);
    const directory = {
      agents: records(rawDirectory.agents).map(publicAgentRecord).map(compactBootstrapAgentRecord),
      humans: directoryHumans.map(compactBootstrapHumanRecord),
      cloud: compactBootstrapCloudState(rawDirectory.cloud, {
        humansById: new Map(directoryHumans.map((human) => [String(human?.id || ''), human]).filter(([id]) => id)),
      }),
    };
    const newestScopedRecords = (key, limit) => newestRecordsPage(
      currentState[key],
      limit,
      (record) => Boolean(record) && inCurrentWorkspace(record),
    ).records.sort(compareOldestRecords);
    const scopedRecordsWithIds = (key, ids = new Set()) => {
      if (!ids.size) return [];
      const source = Array.isArray(currentState[key]) ? currentState[key] : [];
      const matched = [];
      for (const record of source) {
        if (!record || !inCurrentWorkspace(record)) continue;
        if (!ids.has(String(record.id))) continue;
        matched.push(record);
      }
      return matched;
    };

    const snapshot = {
      ...publicStateBase(currentState),
      settings: publicSettings(cloud),
      channels: scopedChannels.filter((channel) => !channel.archived).map(compactBootstrapChannelRecord),
      dms: visibleDms,
      tasks: visibleTasks,
      agents: directory.agents,
      computers: visibleComputers,
      humans: directory.humans,
      reminders: scopedRecords('reminders'),
      missions: scopedRecords('missions'),
      projects: scopedRecords('projects'),
      channelMemberProposals: scopedRecords('channelMemberProposals'),
      connection: publicConnection(),
      cloud: directory.cloud,
      releaseNotes: publicBootstrapReleaseNotes(),
      runtime: runtimeSnapshot(),
      runningRunIds: [...runningProcesses.keys()],
      bootstrap: {
        mode: 'bootstrap',
        fullState: false,
        spaceType,
        spaceId,
        messageLimit,
        threadRootLimit,
        hasMoreMessages: hydratedMessagePagination
          ? Boolean(hydratedMessagePagination.hasMore)
          : selectedMessagePage.hasMore,
        nextBefore: hydratedMessagePagination?.nextBefore || selectedMessageCursor?.createdAt || '',
        nextBeforeId: hydratedMessagePagination?.nextBeforeId || selectedMessageCursor?.id || '',
        threadReplies: threadRepliesPagination,
        tasks: {
          limit: taskLimit,
          loaded: visibleTasks.length,
          openCount: openTaskCount,
          space: taskPageInfo(selectedSpaceTasks.total, selectedSpaceTaskPage, taskLimit),
          global: taskPageInfo(globalChannelTasks.total, globalTaskPage, taskLimit),
        },
        unreadHydration,
        directory: directoryMetadata({
          scope: directoryScope,
          agents: directory.agents,
          humans: directory.humans,
          cloud: directory.cloud,
          totals: directoryTotals,
        }),
      },
      messages: [...messageById.values()]
        .sort(compareOldestRecords)
        .map(publicConversationRecord)
        .map((message) => compactBootstrapConversationRecord(message, {
          previewOnly: !fullMessageIds.has(String(message?.id || '')),
        })),
      replies: [...replyById.values()]
        .sort(compareOldestRecords)
        .map(publicConversationRecord)
        .map((reply) => compactBootstrapConversationRecord(reply, {
          previewOnly: !fullReplyIds.has(String(reply?.id || '')),
        })),
      runs: newestScopedRecords('runs', 80),
      workItems: newestScopedRecords('workItems', 200),
      events: newestScopedRecords('events', eventLimit),
      routeEvents: newestScopedRecords('routeEvents', 80),
      systemNotifications: newestScopedRecords('systemNotifications', 120),
      attachments: scopedRecordsWithIds('attachments', attachmentIds),
    };
    return encodeBootstrapDirectories(encodeBootstrapConversationRecords(snapshot, effectiveOptions), effectiveOptions);
  }

  function publicDirectoryState(req = null, options = {}) {
    const scope = publicStateScope(req);
    const {
      currentState,
      cloud,
      scopedRecords,
      scopedAgents,
    } = scope;
    if (cloud?.auth?.currentUser && !cloud?.auth?.currentMember) {
      return encodeBootstrapDirectories({
        ...publicStateBase(currentState),
        agents: [],
        humans: [],
        cloud: { ...(cloud || {}), members: [] },
        bootstrap: {
          mode: 'directory',
          fullState: false,
          directory: directoryMetadata({ scope: 'full', agents: [], humans: [], cloud: { members: [] } }),
        },
      }, options);
    }
    const effectiveOptions = { ...bootstrapOptionsFromRequest(req), ...options };
    const scopedHumans = scopedRecords('humans');
    const rawMemberCount = records(cloud?.members).length;
    const pageLimit = directoryPageLimit(effectiveOptions.limit);
    const pageCursor = parseDirectoryCursor(effectiveOptions.cursor);
    const rawDirectoryPage = applyDirectoryPagination({
      agents: scopedAgents,
      humans: scopedHumans,
      cloud,
      limit: pageLimit,
      cursor: pageCursor,
    });
    const pageHumans = records(rawDirectoryPage.humans);
    const directoryPageSnapshot = {
      agents: records(rawDirectoryPage.agents).map(publicAgentRecord).map(compactBootstrapAgentRecord),
      humans: pageHumans.map(compactBootstrapHumanRecord),
      cloud: compactBootstrapCloudState(rawDirectoryPage.cloud, {
        humansById: humansByIdForMembers(scopedHumans, rawDirectoryPage.cloud?.members, { includeAll: !pageLimit }),
      }),
      page: rawDirectoryPage.page,
    };
    const directory = {
      ...directoryMetadata({
        scope: pageLimit ? 'page' : 'full',
        agents: directoryPageSnapshot.agents,
        humans: directoryPageSnapshot.humans,
        cloud: directoryPageSnapshot.cloud,
        totals: {
          agents: scopedAgents.length,
          humans: scopedHumans.length,
          members: rawMemberCount,
        },
      }),
      page: directoryPageSnapshot.page,
    };
    const snapshot = {
      ...publicStateBase(currentState),
      agents: directoryPageSnapshot.agents,
      humans: directoryPageSnapshot.humans,
      cloud: directoryPageSnapshot.cloud,
      bootstrap: {
        mode: 'directory',
        fullState: false,
        directory,
      },
    };
    return encodeBootstrapDirectories(snapshot, effectiveOptions);
  }

  function publicDirectorySearchState(req = null, options = {}) {
    const scope = publicStateScope(req, { includeConversationArrays: false });
    const {
      currentState,
      cloud,
      scopedRecords,
      scopedAgents,
    } = scope;
    const effectiveOptions = { ...bootstrapOptionsFromRequest(req), ...options };
    const query = normalizeDirectorySearchQuery(effectiveOptions.query);
    const limit = directorySearchLimit(effectiveOptions.limit);
    const types = directorySearchTypes(effectiveOptions.types);
    if (cloud?.auth?.currentUser && !cloud?.auth?.currentMember) {
      return encodeBootstrapDirectories({
        ...publicStateBase(currentState),
        agents: [],
        humans: [],
        cloud: { ...(cloud || {}), members: [] },
        bootstrap: {
          mode: 'directory-search',
          fullState: false,
          directory: directoryMetadata({ scope: 'search', agents: [], humans: [], cloud: { members: [] } }),
          directorySearch: { query, limit, types: [...types], total: 0 },
        },
      }, effectiveOptions);
    }
    const scopedHumans = scopedRecords('humans');
    const rawCloud = cloud && typeof cloud === 'object' ? {
      ...cloud,
      members: records(cloud.members).filter((member) => (
        !member?.workspaceId
        || !cloud?.workspace?.id
        || String(member.workspaceId) === String(cloud.workspace.id)
      )),
    } : cloud;
    const search = directorySearchSnapshot({
      agents: scopedAgents,
      humans: scopedHumans,
      cloud: rawCloud,
      query,
      limit,
      types,
    });
    const publicAgents = search.agents.map(publicAgentRecord).map(compactBootstrapAgentRecord);
    const publicHumans = search.humans.map(compactBootstrapHumanRecord);
    const publicCloud = compactBootstrapCloudState(search.cloud, {
      humansById: new Map(scopedHumans.map((human) => [String(human?.id || ''), human]).filter(([id]) => id)),
    });
    const directory = directoryMetadata({
      scope: 'search',
      agents: publicAgents,
      humans: publicHumans,
      cloud: publicCloud,
      totals: search.totals,
    });
    const total = Number(directory.agents.loaded || 0)
      + Number(directory.humans.loaded || 0)
      + Number(directory.members.loaded || 0);
    const snapshot = {
      ...publicStateBase(currentState),
      agents: publicAgents,
      humans: publicHumans,
      cloud: publicCloud,
      bootstrap: {
        mode: 'directory-search',
        fullState: false,
        directory,
        directorySearch: {
          query,
          limit,
          types: [...types],
          total,
        },
      },
    };
    return encodeBootstrapDirectories(snapshot, effectiveOptions);
  }

  function publicMembersDirectoryState(req = null, options = {}) {
    const scope = publicStateScope(req);
    const {
      cloud,
      scopedRecords,
    } = scope;
    const effectiveOptions = { ...bootstrapOptionsFromRequest(req), ...options };
    const query = normalizeMembersDirectoryQuery(effectiveOptions.query || effectiveOptions.q);
    const page = membersDirectoryPageNumber(effectiveOptions.page);
    const pageSize = membersDirectoryPageSize(effectiveOptions.pageSize || effectiveOptions.limit);
    if (cloud?.auth?.currentUser && !cloud?.auth?.currentMember) {
      return {
        mode: 'members-directory',
        query,
        page: 1,
        pageSize,
        total: 0,
        totalPages: 1,
        hasMore: false,
        rows: [],
      };
    }
    return membersDirectoryPageSnapshot({
      cloud,
      humans: scopedRecords('humans'),
      query,
      page,
      pageSize,
    });
  }
  
  function workspaceFanoutApiConfig(cloud = null) {
    return cloud?.workspace?.metadata?.fanoutApi || null;
  }

  function publicSettings(cloud = null) {
    const fanoutApi = normalizeFanoutApiConfig(workspaceFanoutApiConfig(cloud) || state?.settings?.fanoutApi || {});
    const { apiKey, ...settings } = state?.settings || {};
    void apiKey;
    return {
      ...settings,
      fanoutApi: {
        enabled: fanoutApi.enabled,
        baseUrl: fanoutApi.baseUrl,
        model: fanoutApi.model,
        fallbackModel: fanoutApi.fallbackModel,
        timeoutMs: fanoutApi.timeoutMs,
        forceKeywords: fanoutApi.forceKeywords,
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
      publicUrl: normalizeCloudUrl(process.env.MAGCLAW_PUBLIC_URL || ''),
      hasControlPlane: Boolean(state?.connection?.controlPlaneUrl),
      hasRelay: Boolean(state?.connection?.relayUrl),
      hasCloudToken: Boolean(cloudToken || process.env.MAGCLAW_CLOUD_TOKEN),
    };
  }
  
  function updateFanoutApiConfig(body = {}, workspace = null) {
    const current = normalizeFanoutApiConfig(workspace?.metadata?.fanoutApi || state.settings?.fanoutApi || {});
    const next = {
      ...current,
      enabled: body.enabled !== undefined ? Boolean(body.enabled) : current.enabled,
      baseUrl: body.baseUrl !== undefined ? normalizeCloudUrl(body.baseUrl || '') : current.baseUrl,
      model: body.model !== undefined ? String(body.model || '').trim() : current.model,
      fallbackModel: body.fallbackModel !== undefined ? String(body.fallbackModel || '').trim() : current.fallbackModel,
      timeoutMs: body.timeoutMs !== undefined ? Number(body.timeoutMs) : current.timeoutMs,
      forceKeywords: body.forceKeywords !== undefined ? body.forceKeywords : current.forceKeywords,
    };
    if (body.clearApiKey === true) {
      next.apiKey = '';
    } else if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
      next.apiKey = body.apiKey.trim();
    }
    const normalized = normalizeFanoutApiConfig(next);
    state.settings.fanoutApi = normalized;
    if (workspace) {
      workspace.metadata = {
        ...(workspace.metadata || {}),
        fanoutApi: normalized,
      };
      workspace.updatedAt = now();
    }
    state.router = {
      ...(state.router || {}),
      mode: fanoutApiConfigured() ? 'llm_fanout' : 'rules_fallback',
      fallback: 'rules',
      cardSource: 'workspace_markdown',
    };
    delete state.router.brainAgentId;
    return normalized;
  }
  
  function runtimeSnapshot() {
    const daemonPackageVersion = localDaemonPackageVersion();
    const computerPackageVersion = localComputerPackageVersion();
    const cliCorePackageVersion = localCliCorePackageVersion();
    const teamSharingPackageVersion = localTeamSharingPackageVersion();
    scheduleNpmPackageVersionRefresh();
    return {
      node: process.version,
      platform: `${os.platform()} ${os.arch()}`,
      host: os.hostname(),
      webPackageName: '@magclaw/web',
      webPackageVersion: localWebPackageVersion(),
      webLatestVersion: latestWebPackageVersion(localWebPackageVersion()),
      codexPath: state?.settings?.codexPath || defaultCodexPath(),
      daemonPackageName: '@magclaw/daemon',
      daemonPackageVersion,
      daemonLatestVersion: latestDaemonPackageVersion(daemonPackageVersion),
      computerPackageName: '@magclaw/computer',
      computerPackageVersion,
      computerLatestVersion: latestComputerPackageVersion(computerPackageVersion),
      cliCorePackageName: '@magclaw/cli-core',
      cliCorePackageVersion,
      cliCoreLatestVersion: latestCliCorePackageVersion(cliCorePackageVersion),
      teamSharingPackageName: '@magclaw/team-sharing',
      teamSharingPackageVersion,
      teamSharingLatestVersion: latestTeamSharingPackageVersion(teamSharingPackageVersion),
    };
  }

  function localPackageVersionForName(packageName) {
    if (packageName === '@magclaw/daemon') return localDaemonPackageVersion();
    if (packageName === '@magclaw/computer') return localComputerPackageVersion();
    if (packageName === '@magclaw/cli-core') return localCliCorePackageVersion();
    if (packageName === '@magclaw/team-sharing') return localTeamSharingPackageVersion();
    if (packageName === '@magclaw/web') return localWebPackageVersion();
    return '';
  }

  function latestPackageVersionForName(packageName, fallback = '') {
    if (packageName === '@magclaw/web') return latestWebPackageVersion(fallback);
    if (packageName === '@magclaw/daemon') return latestDaemonPackageVersion(fallback);
    if (packageName === '@magclaw/computer') return latestComputerPackageVersion(fallback);
    if (packageName === '@magclaw/cli-core') return latestCliCorePackageVersion(fallback);
    if (packageName === '@magclaw/team-sharing') return latestTeamSharingPackageVersion(fallback);
    return String(fallback || '').trim();
  }

  function currentNpmPackageVersions() {
    return Object.fromEntries(RUNTIME_PACKAGE_NAMES.map((packageName) => [
      packageName,
      String(npmPackageVersions?.latest?.(packageName, '') || '').trim(),
    ]));
  }

  function npmPackageVersionsChanged(before, after) {
    return RUNTIME_PACKAGE_NAMES.some((packageName) => {
      const latest = after[packageName];
      return latest && latest !== before[packageName];
    });
  }

  function scheduleNpmPackageVersionRefresh() {
    const refresh = npmPackageVersions?.maybeRefreshAll || npmPackageVersions?.refreshAll;
    if (!refresh) return Promise.resolve();
    if (npmVersionRefreshInFlight) return npmVersionRefreshInFlight;
    const before = currentNpmPackageVersions();
    npmVersionRefreshInFlight = Promise.resolve(refresh.call(npmPackageVersions))
      .then(() => {
        const after = currentNpmPackageVersions();
        if (npmPackageVersionsChanged(before, after)) {
          packageVersionSnapshotCache = null;
        }
      })
      .catch(() => {})
      .finally(() => {
        npmVersionRefreshInFlight = null;
      });
    return npmVersionRefreshInFlight;
  }

  async function refreshPackageVersionCache() {
    await scheduleNpmPackageVersionRefresh();
  }

  function startPackageVersionPolling() {
    if (packageVersionPollingTimer || typeof setIntervalFn !== 'function') return packageVersionPollingTimer;
    scheduleNpmPackageVersionRefresh();
    packageVersionPollingTimer = setIntervalFn(() => scheduleNpmPackageVersionRefresh(), packageVersionPollingIntervalMs);
    packageVersionPollingTimer?.unref?.();
    return packageVersionPollingTimer;
  }

  function stopPackageVersionPolling() {
    if (!packageVersionPollingTimer || typeof clearIntervalFn !== 'function') return;
    clearIntervalFn(packageVersionPollingTimer);
    packageVersionPollingTimer = null;
  }

  async function buildPackageVersionSnapshot() {
    const checkedAtMs = Number(nowMs()) || Date.now();
    await refreshPackageVersionCache();
    const packages = {};
    for (const packageName of RUNTIME_PACKAGE_NAMES) {
      const npmLatest = String(npmPackageVersions?.latest?.(packageName, '') || '').trim();
      if (npmLatest) {
        packages[packageName] = {
          packageName,
          latest: npmLatest,
          version: npmLatest,
          source: 'npm-cache',
        };
        continue;
      }
      const localVersion = localPackageVersionForName(packageName);
      packages[packageName] = {
        packageName,
        latest: localVersion,
        version: localVersion,
        source: 'local',
      };
    }

    return {
      ok: true,
      cacheTtlMs: packageVersionSnapshotTtlMs,
      checkedAt: new Date(checkedAtMs).toISOString(),
      packages,
    };
  }

  async function packageVersionSnapshot(options = {}) {
    const checkedAtMs = Number(nowMs()) || Date.now();
    if (
      !options.force
      && packageVersionSnapshotCache
      && checkedAtMs - packageVersionSnapshotCache.checkedAtMs < packageVersionSnapshotTtlMs
    ) {
      return packageVersionSnapshotCache.snapshot;
    }
    if (packageVersionSnapshotInflight) return packageVersionSnapshotInflight;
    packageVersionSnapshotInflight = buildPackageVersionSnapshot()
      .then((snapshot) => {
        packageVersionSnapshotCache = { checkedAtMs, snapshot };
        return snapshot;
      })
      .finally(() => {
        packageVersionSnapshotInflight = null;
      });
    return packageVersionSnapshotInflight;
  }

  function publicReleaseNotes() {
    const defaults = defaultReleaseNotes({ root: ROOT });
    const normalized = normalizeReleaseNotes(state?.releaseNotes, defaults);
    normalized.web.currentVersion = process.env.MAGCLAW_WEB_VERSION || localWebPackageVersion() || normalized.web.currentVersion;
    normalized.web.latestVersion = latestWebPackageVersion(normalized.web.currentVersion);
    normalized.daemon.currentVersion = localDaemonPackageVersion() || normalized.daemon.currentVersion;
    normalized.daemon.latestVersion = latestDaemonPackageVersion(normalized.daemon.currentVersion);
    normalized.computer.currentVersion = localComputerPackageVersion() || normalized.computer.currentVersion;
    normalized.computer.latestVersion = latestComputerPackageVersion(normalized.computer.currentVersion);
    normalized.cliCore.currentVersion = localCliCorePackageVersion() || normalized.cliCore.currentVersion;
    normalized.cliCore.latestVersion = latestCliCorePackageVersion(normalized.cliCore.currentVersion);
    normalized.teamSharing.currentVersion = localTeamSharingPackageVersion() || normalized.teamSharing.currentVersion;
    normalized.teamSharing.latestVersion = latestTeamSharingPackageVersion(normalized.teamSharing.currentVersion);
    return normalized;
  }

  function publicBootstrapReleaseNotes() {
    const webDefaults = defaultReleaseNotesForComponent('web', { root: ROOT });
    const web = normalizeReleaseNotesForComponent('web', state?.releaseNotes?.web, webDefaults);
    web.currentVersion = process.env.MAGCLAW_WEB_VERSION || localWebPackageVersion() || web.currentVersion;
    web.latestVersion = latestWebPackageVersion(web.currentVersion);
    return {
      web,
    };
  }

  function localWebPackageVersion() {
    try {
      const pkg = JSON.parse(readFileSync(path.join(ROOT, 'web', 'package.json'), 'utf8'));
      return String(pkg.version || '');
    } catch {
      return '';
    }
  }

  function latestWebPackageVersion(fallback = '') {
    return String(
      process.env.MAGCLAW_WEB_LATEST_VERSION
      || state?.settings?.webVersionControl?.latestVersion
      || state?.settings?.webLatestVersion
      || fallback
      || '',
    ).trim();
  }

  function localDaemonPackageVersion() {
    const envVersion = String(process.env.MAGCLAW_DAEMON_VERSION || '').trim();
    if (envVersion) return envVersion;
    try {
      const pkg = JSON.parse(readFileSync(path.join(ROOT, 'daemon', 'package.json'), 'utf8'));
      return String(pkg.version || '');
    } catch {
      return '';
    }
  }

  function latestDaemonPackageVersion(fallback = '') {
    return String(
      process.env.MAGCLAW_DAEMON_LATEST_VERSION
      || npmPackageVersions?.latest?.('@magclaw/daemon', '')
      || state?.settings?.daemonVersionControl?.latestVersion
      || state?.settings?.daemonLatestVersion
      || fallback
      || '',
    ).trim();
  }

  function localComputerPackageVersion() {
    const envVersion = String(process.env.MAGCLAW_COMPUTER_VERSION || '').trim();
    if (envVersion) return envVersion;
    try {
      const pkg = JSON.parse(readFileSync(path.join(ROOT, 'computer', 'package.json'), 'utf8'));
      return String(pkg.version || '');
    } catch {
      return '';
    }
  }

  function latestComputerPackageVersion(fallback = '') {
    return String(
      process.env.MAGCLAW_COMPUTER_LATEST_VERSION
      || npmPackageVersions?.latest?.('@magclaw/computer', '')
      || state?.settings?.computerVersionControl?.latestVersion
      || state?.settings?.computerLatestVersion
      || fallback
      || '',
    ).trim();
  }

  function localCliCorePackageVersion() {
    const envVersion = String(process.env.MAGCLAW_CLI_CORE_VERSION || '').trim();
    if (envVersion) return envVersion;
    try {
      const pkg = JSON.parse(readFileSync(path.join(ROOT, 'cli-core', 'package.json'), 'utf8'));
      return String(pkg.version || '');
    } catch {
      return '';
    }
  }

  function latestCliCorePackageVersion(fallback = '') {
    return String(
      process.env.MAGCLAW_CLI_CORE_LATEST_VERSION
      || npmPackageVersions?.latest?.('@magclaw/cli-core', '')
      || state?.settings?.cliCoreVersionControl?.latestVersion
      || state?.settings?.cliCoreLatestVersion
      || fallback
      || '',
    ).trim();
  }

  function localTeamSharingPackageVersion() {
    const envVersion = String(process.env.MAGCLAW_TEAM_SHARING_VERSION || '').trim();
    if (envVersion) return envVersion;
    try {
      const pkg = JSON.parse(readFileSync(path.join(ROOT, 'team-sharing', 'package.json'), 'utf8'));
      return String(pkg.version || '');
    } catch {
      return '';
    }
  }

  function latestTeamSharingPackageVersion(fallback = '') {
    return String(
      process.env.MAGCLAW_TEAM_SHARING_LATEST_VERSION
      || npmPackageVersions?.latest?.('@magclaw/team-sharing', '')
      || state?.settings?.teamSharingVersionControl?.latestVersion
      || state?.settings?.teamSharingLatestVersion
      || fallback
      || '',
    ).trim();
  }

  function semverParts(value = '') {
    return String(value || '').replace(/^[^\d]*/, '').split(/[.-]/).slice(0, 3).map((part) => Number.parseInt(part, 10) || 0);
  }

  function semverGreater(left = '', right = '') {
    const a = semverParts(left);
    const b = semverParts(right);
    for (let index = 0; index < 3; index += 1) {
      if (a[index] > b[index]) return true;
      if (a[index] < b[index]) return false;
    }
    return false;
  }

  function releaseWithinVersionWindow(release, currentVersion, latestVersion) {
    const version = String(release?.version || '').trim();
    if (!version) return false;
    if (currentVersion && !semverGreater(version, currentVersion)) return false;
    if (latestVersion && semverGreater(version, latestVersion)) return false;
    return true;
  }

  function packageReleaseNotes(componentNotes, currentVersion, latestVersion) {
    const releases = Array.isArray(componentNotes?.releases) ? componentNotes.releases : [];
    const scoped = releases.filter((release) => releaseWithinVersionWindow(release, currentVersion, latestVersion));
    return {
      component: componentNotes?.component || '',
      packageName: componentNotes?.packageName || '',
      currentVersion: String(currentVersion || componentNotes?.currentVersion || ''),
      latestVersion: String(latestVersion || componentNotes?.latestVersion || ''),
      releases: scoped.length ? scoped : releases.slice(0, latestVersion && currentVersion === latestVersion ? 1 : 0),
    };
  }

  function compactReleaseNotesMarkdown(releaseNotes) {
    const lines = [];
    const categories = ['new', 'bugFix', 'approval', 'features', 'fixes', 'improved'];
    for (const release of releaseNotes?.releases || []) {
      for (const category of categories) {
        for (const item of release[category] || []) {
          const text = String(item || '').replace(/\s+/g, ' ').trim();
          if (!text) continue;
          lines.push(`- ${text}`);
          if (lines.length >= 5) return lines.join('\n');
        }
      }
    }
    return lines.join('\n');
  }

  async function packageUpdateSnapshot(options = {}) {
    const packageName = String(options.packageName || '').trim();
    if (!packageName) return { ok: false, error: 'packageName is required' };
    const component = PACKAGE_RELEASE_COMPONENTS[packageName] || '';
    const packageVersions = await packageVersionSnapshot({ force: Boolean(options.force) });
    const notes = publicReleaseNotes();
    const componentNotes = component ? notes[component] : null;
    const currentVersion = String(
      options.currentVersion
      || localPackageVersionForName(packageName)
      || componentNotes?.currentVersion
      || '',
    ).trim();
    const latestVersion = String(
      packageVersions?.packages?.[packageName]?.latest
      || latestPackageVersionForName(packageName, componentNotes?.latestVersion || currentVersion)
      || componentNotes?.latestVersion
      || currentVersion
      || '',
    ).trim();
    const releaseNotes = packageReleaseNotes(componentNotes, currentVersion, latestVersion);
    return {
      ok: true,
      package: {
        name: packageName,
        packageName,
        currentVersion,
        latestVersion,
        updateAvailable: semverGreater(latestVersion, currentVersion),
        updateMode: packageName === '@magclaw/team-sharing' ? 'silent' : 'manual',
        cacheTtlSeconds: PACKAGE_UPDATE_CACHE_TTL_SECONDS,
      },
      releaseNotesMarkdown: compactReleaseNotesMarkdown(releaseNotes),
      releaseNotes,
    };
  }

  async function getRuntimeInfo() {
    const codexPath = await resolveCodexPath();
    const version = await execText(codexPath, ['--version']).catch((error) => error.message);
    return {
      ...runtimeSnapshot(),
      codexVersion: version.trim(),
      port: PORT,
      dataDir: DATA_DIR,
    };
  }

  function defaultCodexPath() {
    const macAppBinary = '/Applications/Codex.app/Contents/Resources/codex';
    if (existsSync(macAppBinary)) return macAppBinary;
    return 'codex';
  }

  function commandHasPathSeparator(command) {
    return /[\\/]/.test(String(command || ''));
  }

  function commandNeedsShell(command) {
    const basename = String(command || '').split(/[\\/]/).pop() || '';
    return process.platform === 'win32' && /\.(cmd|bat)$/i.test(basename);
  }

  function commandNameCandidates(command) {
    const value = String(command || '').trim();
    if (!value) return [];
    if (commandHasPathSeparator(value) || path.extname(value)) return [value];
    if (process.platform !== 'win32') return [value];
    const exts = String(process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean);
    return [value, ...exts.map((ext) => `${value}${ext}`)];
  }

  function pathEntries(value = process.env.PATH || '') {
    return String(value || '')
      .split(path.delimiter)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  function uniquePathEntries(entries = []) {
    const seen = new Set();
    const result = [];
    for (const entry of entries) {
      const value = String(entry || '').trim();
      if (!value) continue;
      const key = process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(value);
    }
    return result;
  }

  function runtimeSearchDirs() {
    const home = String(process.env.HOME || process.env.USERPROFILE || os.homedir() || '').trim();
    const userEntries = home ? [
      path.join(home, '.local', 'bin'),
      path.join(home, 'bin'),
      path.join(home, '.npm-global', 'bin'),
      path.join(home, '.volta', 'bin'),
      path.join(home, '.bun', 'bin'),
      process.platform === 'win32' ? path.join(home, 'AppData', 'Roaming', 'npm') : '',
    ] : [];
    const platformEntries = process.platform === 'darwin'
      ? ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin']
      : process.platform === 'win32'
        ? []
        : ['/usr/local/bin', '/usr/local/sbin'];
    return uniquePathEntries([
      ...pathEntries(),
      process.env.NVM_BIN,
      process.env.VOLTA_HOME ? path.join(process.env.VOLTA_HOME, 'bin') : '',
      process.env.BUN_INSTALL ? path.join(process.env.BUN_INSTALL, 'bin') : '',
      path.dirname(process.execPath),
      ...userEntries,
      ...platformEntries,
    ]);
  }

  function runtimeExecutionEnv() {
    return {
      ...process.env,
      PATH: runtimeSearchDirs().join(path.delimiter),
    };
  }

  async function resolveCodexPath() {
    const configured = state.settings?.codexPath || '';
    const candidates = [configured, defaultCodexPath(), 'codex']
      .map((item) => String(item || '').trim())
      .filter(Boolean);
    for (const candidate of [...new Set(candidates)]) {
      try {
        await execText(candidate, ['--version']);
        return candidate;
      } catch {
        // Keep trying known fallbacks so a stale CODEX_PATH does not hide Codex.app.
      }
    }
    return configured || defaultCodexPath();
  }

  function executableCandidates(command) {
    const names = commandNameCandidates(command);
    return [...new Set(names.flatMap((name) => [
      name,
      ...(
        commandHasPathSeparator(name)
          ? []
          : runtimeSearchDirs().map((dir) => path.join(dir, name))
      ),
    ]).filter(Boolean))];
  }

  async function resolveCommandVersion(command) {
    let lastError = null;
    for (const candidate of executableCandidates(command)) {
      try {
        return {
          path: candidate,
          version: (await execText(candidate, ['--version'])).trim(),
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error(`${command} was not found`);
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
      const codexPath = await resolveCodexPath();
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
      const claude = await resolveCommandVersion('claude');
      runtimes.push({
        id: 'claude-code',
        name: 'Claude Code',
        path: claude.path,
        version: claude.version,
        installed: true,
        models: ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5-20251001'],
        defaultModel: 'claude-sonnet-4-6',
      });
    } catch {
      runtimes.push({ id: 'claude-code', name: 'Claude Code', installed: false });
    }
  
    // Kimi CLI
    try {
      const kimi = await resolveCommandVersion('kimi');
      runtimes.push({
        id: 'kimi',
        name: 'Kimi CLI',
        path: kimi.path,
        version: kimi.version,
        installed: true,
        createSupported: false,
        models: ['kimi-k2-0905', 'kimi-k2-turbo-preview'],
        defaultModel: 'kimi-k2-0905',
      });
    } catch {
      runtimes.push({ id: 'kimi', name: 'Kimi CLI', installed: false, createSupported: false });
    }

    // Cursor CLI
    try {
      let cursorPath = 'cursor-agent';
      let cursorVersion = '';
      try {
        const cursor = await resolveCommandVersion(cursorPath);
        cursorPath = cursor.path;
        cursorVersion = cursor.version;
      } catch {
        cursorPath = 'cursor';
        const cursor = await resolveCommandVersion(cursorPath);
        cursorPath = cursor.path;
        cursorVersion = cursor.version;
      }
      runtimes.push({
        id: 'cursor',
        name: 'Cursor CLI',
        path: cursorPath,
        version: cursorVersion,
        installed: true,
        createSupported: false,
        models: ['auto'],
        defaultModel: 'auto',
      });
    } catch {
      runtimes.push({ id: 'cursor', name: 'Cursor CLI', installed: false, createSupported: false });
    }

    // Gemini CLI
    try {
      const gemini = await resolveCommandVersion('gemini');
      runtimes.push({
        id: 'gemini',
        name: 'Gemini CLI',
        path: gemini.path,
        version: gemini.version,
        installed: true,
        createSupported: false,
        models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
        defaultModel: 'gemini-2.5-pro',
      });
    } catch {
      runtimes.push({ id: 'gemini', name: 'Gemini CLI', installed: false, createSupported: false });
    }

    // Copilot CLI
    try {
      const copilot = await resolveCommandVersion('copilot');
      runtimes.push({
        id: 'copilot',
        name: 'Copilot CLI',
        path: copilot.path,
        version: copilot.version,
        installed: true,
        createSupported: false,
        models: ['gpt-5', 'gpt-4.1', 'claude-sonnet-4.5'],
        defaultModel: 'gpt-5',
      });
    } catch {
      runtimes.push({ id: 'copilot', name: 'Copilot CLI', installed: false, createSupported: false });
    }

    // OpenCode
    try {
      const openCode = await resolveCommandVersion('opencode');
      runtimes.push({
        id: 'opencode',
        name: 'OpenCode',
        path: openCode.path,
        version: openCode.version,
        installed: true,
        createSupported: false,
        models: ['gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'],
        defaultModel: 'gpt-4o',
      });
    } catch {
      runtimes.push({ id: 'opencode', name: 'OpenCode', installed: false, createSupported: false });
    }
  
    return runtimes;
  }
  
  function execText(command, args) {
    return new Promise((resolve, reject) => {
      execFile(command, args, { timeout: 10_000, shell: commandNeedsShell(command), env: runtimeExecutionEnv() }, (error, stdout, stderr) => {
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
      execFile(command, args, { ...options, env: options.env || runtimeExecutionEnv(), shell: options.shell ?? commandNeedsShell(command) }, (error, stdout, stderr) => {
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

  return {
    addProjectFolder,
    detectInstalledRuntimes,
    execFileResult,
    execText,
    getRuntimeInfo,
    pickFolderPath,
    packageUpdateSnapshot,
    packageVersionSnapshot,
    publicConnection,
    publicSettings,
    publicBootstrapState,
    publicDirectoryState,
    publicDirectorySearchState,
    publicMembersDirectoryState,
    publicState,
    runtimeSnapshot,
    startPackageVersionPolling,
    stopPackageVersionPolling,
    updateFanoutApiConfig,
  };
}
