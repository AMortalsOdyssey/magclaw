import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNpmPackageVersionResolver } from './npm-package-versions.js';
import { defaultReleaseNotes, normalizeReleaseNotes } from './release-notes.js';
import { normalizeCloudUrl, normalizeFanoutApiConfig, publicApiKeyPreview } from './runtime-config.js';
import { teamSharingDisplayBodyForRecord } from './team-sharing.js';

// System/runtime and local-project services.
// HTTP route modules use this for public state shaping, installed-runtime
// detection, the native folder picker, and project folder registration.
const RUNTIME_PACKAGE_NAMES = Object.freeze(['@magclaw/daemon', '@magclaw/computer', '@magclaw/cli-core', '@magclaw/team-sharing']);
const DEFAULT_PACKAGE_VERSION_WEB_CACHE_MS = 10 * 60_000;
const PACKAGE_UPDATE_CACHE_TTL_SECONDS = 12 * 60 * 60;
const BOOTSTRAP_UNREAD_RECORD_LIMIT = 80;
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
  const packageVersionSnapshotTtlMs = Math.max(1000, Number(packageVersionCacheTtlMs) || DEFAULT_PACKAGE_VERSION_WEB_CACHE_MS);
  const packageVersionPollingIntervalMs = Math.max(1000, Number(packageVersionPollIntervalMs) || packageVersionSnapshotTtlMs);

  function records(value) {
    return Array.isArray(value) ? value.filter(Boolean) : [];
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

  function clampLimit(value, fallback, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(max, Math.max(1, Math.floor(parsed)));
  }

  function recordTime(record) {
    const parsed = Date.parse(record?.updatedAt || record?.createdAt || '');
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function conversationRecordUnreadForHuman(record, humanId) {
    if (!humanId || !record?.id || record.authorType !== 'agent') return false;
    const readBy = records(record.readBy).map(String);
    return !readBy.includes(String(humanId));
  }

  function includeUnreadConversationRecords({
    currentHumanId,
    messages,
    replies,
    messageById,
    replyById,
  }) {
    const hydration = {
      limit: BOOTSTRAP_UNREAD_RECORD_LIMIT,
      included: 0,
      truncated: false,
    };
    if (!currentHumanId) return hydration;
    const sourceMessages = records(messages);
    const sourceMessageById = new Map(sourceMessages.map((message) => [message.id, message]).filter(([id]) => id));
    const unreadCandidates = [];
    for (const message of sourceMessages) {
      if (!conversationRecordUnreadForHuman(message, currentHumanId)) continue;
      if (messageById.has(message.id)) continue;
      unreadCandidates.push({ time: recordTime(message), message, reply: null, parent: null });
    }
    for (const reply of records(replies)) {
      if (!conversationRecordUnreadForHuman(reply, currentHumanId)) continue;
      if (replyById.has(reply.id)) continue;
      const parent = sourceMessageById.get(reply.parentMessageId);
      unreadCandidates.push({ time: recordTime(reply), message: null, reply, parent });
    }
    unreadCandidates.sort((a, b) => b.time - a.time);
    let omitted = 0;
    for (const candidate of unreadCandidates) {
      const requiredRecords = (
        (candidate.message && !messageById.has(candidate.message.id) ? 1 : 0)
        + (candidate.reply && !replyById.has(candidate.reply.id) ? 1 : 0)
        + (candidate.parent && !messageById.has(candidate.parent.id) ? 1 : 0)
      );
      if (!requiredRecords) continue;
      if (hydration.included + requiredRecords > BOOTSTRAP_UNREAD_RECORD_LIMIT) {
        omitted += requiredRecords;
        continue;
      }
      if (candidate.parent) messageById.set(candidate.parent.id, candidate.parent);
      if (candidate.message) messageById.set(candidate.message.id, candidate.message);
      if (candidate.reply) replyById.set(candidate.reply.id, candidate.reply);
      hydration.included += requiredRecords;
    }
    hydration.truncated = omitted > 0;
    return hydration;
  }

  function newestRecords(items, limit) {
    return records(items)
      .slice()
      .sort((a, b) => recordTime(b) - recordTime(a))
      .slice(0, limit);
  }

  function compareTaskRecords(a, b) {
    const timeDiff = recordTime(b) - recordTime(a);
    if (timeDiff) return timeDiff;
    return String(b?.id || '').localeCompare(String(a?.id || ''));
  }

  function taskPageInfo(candidates = [], page = [], limit = 0) {
    const cursor = page.length ? page[page.length - 1] : null;
    return {
      limit,
      loaded: page.length,
      total: candidates.length,
      hasMore: candidates.length > page.length,
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
    const body = teamSharingDisplayBodyForRecord(record);
    const metadata = publicConversationMetadata(record?.metadata);
    const changedBody = body && body !== record?.body;
    if (!changedBody && metadata === record?.metadata) return record;
    const next = { ...record };
    if (changedBody) next.body = body;
    if (metadata) next.metadata = metadata;
    else if (Object.hasOwn(next, 'metadata')) delete next.metadata;
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
    return record;
  }

  function compactBootstrapHumanRecord(human = {}) {
    const record = { ...human };
    for (const key of ['workspaceId', 'lastSeenAt', 'presenceUpdatedAt', 'updatedAt']) {
      if (Object.hasOwn(record, key)) delete record[key];
    }
    return record;
  }

  function compactBootstrapCloudMember(member = {}) {
    if (!member || typeof member !== 'object') return member;
    return {
      ...member,
      human: member.human && typeof member.human === 'object'
        ? compactBootstrapHumanRecord(member.human)
        : member.human,
    };
  }

  function compactBootstrapCloudState(cloud = null) {
    if (!cloud || typeof cloud !== 'object') return cloud;
    const next = { ...cloud };
    if (Array.isArray(cloud.members)) next.members = cloud.members.map(compactBootstrapCloudMember);
    return next;
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
      if (req?.magclawBootstrapHydration) options.hydration = req.magclawBootstrapHydration;
      return options;
    } catch {
      return {};
    }
  }

  function publicState(req = null) {
    const currentState = getState() || {};
    const cloud = typeof publicCloudState === 'function' ? publicCloudState(req) : undefined;
    const currentHumanId = cloud?.auth?.currentMember?.humanId || null;
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
    const channels = records(currentState.channels);
    const dms = records(currentState.dms);
    const messages = records(currentState.messages);
    const replies = records(currentState.replies);
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
    const scopedMessages = messages.filter(inCurrentWorkspace);
    const scopedReplies = replies.filter(inCurrentWorkspace);
    const scopedRecords = (key) => records(currentState[key]).filter(inCurrentWorkspace);
    const scopedAgents = scopedRecords('agents');
    const visibleComputers = scopedRecords('computers').filter((computer) => {
      const status = String(computer?.status || '').toLowerCase();
      if (status === 'connected' || computer?.lastSeenAt) return true;
      const hasBoundAgent = scopedAgents.some((agent) => agent?.computerId === computer?.id && !agent.deletedAt);
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
    const visibleMessages = scopedMessages
      .filter((message) => message.spaceType !== 'dm' || visibleDmIds.has(message.spaceId))
      .map(publicConversationRecord);
    const visibleReplies = scopedReplies
      .filter((reply) => reply.spaceType !== 'dm' || visibleDmIds.has(reply.spaceId))
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
    const snapshot = publicState(req);
    if (!snapshot || !Array.isArray(snapshot.channels)) return snapshot;
    const effectiveOptions = { ...bootstrapOptionsFromRequest(req), ...options };

    const spaceType = ['channel', 'dm'].includes(effectiveOptions.spaceType) ? effectiveOptions.spaceType : 'channel';
    const fallbackSpaceId = spaceType === 'dm'
      ? snapshot.dms?.[0]?.id
      : snapshot.channels?.[0]?.id;
    const spaceId = String(effectiveOptions.spaceId || fallbackSpaceId || 'chan_all');
    const threadMessageId = String(effectiveOptions.threadMessageId || '');
    const messageLimit = clampLimit(effectiveOptions.messageLimit, 80, 200);
    const threadReplyLimit = clampLimit(effectiveOptions.replyLimit || effectiveOptions.messageLimit, 80, 300);
    const threadRootLimit = clampLimit(effectiveOptions.threadRootLimit, 120, 300);
    const eventLimit = clampLimit(effectiveOptions.eventLimit, 120, 300);
    const taskLimit = clampLimit(effectiveOptions.taskLimit, 160, 500);
    const currentHumanId = snapshot.cloud?.auth?.currentMember?.humanId || null;

    const selectedMessages = records(snapshot.messages)
      .filter((message) => message.spaceType === spaceType && String(message.spaceId) === spaceId)
      .slice()
      .sort((a, b) => recordTime(b) - recordTime(a))
      .slice(0, messageLimit)
      .sort((a, b) => recordTime(a) - recordTime(b));
    const selectedMessageCursor = selectedMessages[0] || null;
    const hydratedMessagePagination = effectiveOptions.hydration?.messages?.pagination || null;
    const threadRoots = newestRecords(
      records(snapshot.messages).filter((message) => (
        Number(message.replyCount || 0) > 0
        || message.taskId
        || records(message.savedBy).length
        || String(message.id || '') === threadMessageId
      )),
      threadRootLimit,
    );
    const messageById = new Map();
    for (const message of [...selectedMessages, ...threadRoots]) messageById.set(message.id, message);
    if (threadMessageId && !messageById.has(threadMessageId)) {
      const threadRoot = records(snapshot.messages).find((message) => String(message.id || '') === threadMessageId);
      if (threadRoot) messageById.set(threadRoot.id, threadRoot);
    }

    const latestReplyByParent = new Map();
    const allSelectedThreadReplies = [];
    for (const reply of records(snapshot.replies).slice().sort((a, b) => recordTime(a) - recordTime(b))) {
      if (messageById.has(reply.parentMessageId)) latestReplyByParent.set(reply.parentMessageId, reply);
      if (threadMessageId && String(reply.parentMessageId || '') === threadMessageId) allSelectedThreadReplies.push(reply);
    }
    const selectedThreadReplies = allSelectedThreadReplies
      .slice()
      .sort((a, b) => recordTime(b) - recordTime(a))
      .slice(0, threadReplyLimit)
      .sort((a, b) => recordTime(a) - recordTime(b));
    const selectedThreadReplyCursor = selectedThreadReplies[0] || null;
    const threadRepliesPagination = effectiveOptions.hydration?.replies?.pagination
      || (threadMessageId
        ? {
            limit: threadReplyLimit,
            hasMore: allSelectedThreadReplies.length > selectedThreadReplies.length,
            nextBefore: selectedThreadReplyCursor?.createdAt || '',
            nextBeforeId: selectedThreadReplyCursor?.id || '',
          }
        : null);
    const replyById = new Map();
    for (const reply of [...latestReplyByParent.values(), ...selectedThreadReplies]) replyById.set(reply.id, reply);
    const unreadHydration = includeUnreadConversationRecords({
      currentHumanId,
      messages: snapshot.messages,
      replies: snapshot.replies,
      messageById,
      replyById,
    });

    const taskIds = new Set();
    for (const message of messageById.values()) {
      if (message.taskId) taskIds.add(message.taskId);
    }
    const taskRecords = records(snapshot.tasks).slice().sort(compareTaskRecords);
    const openStatuses = new Set(['todo', 'in_progress', 'in_review']);
    const memberChannelIds = new Set(records(snapshot.channels)
      .filter((channel) => (
        !currentHumanId
        || records(channel.memberIds).includes(currentHumanId)
        || records(channel.humanIds).includes(currentHumanId)
      ))
      .map((channel) => channel.id));
    const selectedSpaceTasks = taskRecords.filter((task) => (
      task.spaceType === spaceType && String(task.spaceId) === spaceId
    ));
    const globalChannelTasks = taskRecords.filter((task) => (
      task.spaceType === 'channel'
      && (!currentHumanId || memberChannelIds.has(task.spaceId))
    ));
    const openTaskCount = taskRecords.filter((task) => openStatuses.has(String(task.status || 'todo'))).length;
    const selectedSpaceTaskPage = selectedSpaceTasks.slice(0, taskLimit);
    const globalTaskPage = globalChannelTasks.slice(0, taskLimit);
    const visibleTaskById = new Map();
    for (const task of [...selectedSpaceTaskPage, ...globalTaskPage]) {
      if (task?.id) visibleTaskById.set(task.id, task);
    }
    for (const task of taskRecords) {
      if (taskIds.has(task.id)) visibleTaskById.set(task.id, task);
    }
    const visibleTasks = [...visibleTaskById.values()].sort(compareTaskRecords);

    const attachmentIds = new Set();
    for (const record of [...messageById.values(), ...replyById.values(), ...visibleTasks]) {
      for (const id of records(record.attachmentIds)) attachmentIds.add(String(id));
    }

    return {
      ...snapshot,
      bootstrap: {
        mode: 'bootstrap',
        fullState: false,
        spaceType,
        spaceId,
        messageLimit,
        threadRootLimit,
        hasMoreMessages: hydratedMessagePagination
          ? Boolean(hydratedMessagePagination.hasMore)
          : records(snapshot.messages)
            .filter((message) => message.spaceType === spaceType && String(message.spaceId) === spaceId).length > selectedMessages.length,
        nextBefore: hydratedMessagePagination?.nextBefore || selectedMessageCursor?.createdAt || '',
        nextBeforeId: hydratedMessagePagination?.nextBeforeId || selectedMessageCursor?.id || '',
        threadReplies: threadRepliesPagination,
        tasks: {
          limit: taskLimit,
          loaded: visibleTasks.length,
          openCount: openTaskCount,
          space: taskPageInfo(selectedSpaceTasks, selectedSpaceTaskPage, taskLimit),
          global: taskPageInfo(globalChannelTasks, globalTaskPage, taskLimit),
        },
        unreadHydration,
      },
      messages: [...messageById.values()].sort((a, b) => recordTime(a) - recordTime(b)),
      replies: [...replyById.values()].sort((a, b) => recordTime(a) - recordTime(b)),
      tasks: visibleTasks,
      agents: records(snapshot.agents).map(compactBootstrapAgentRecord),
      humans: records(snapshot.humans).map(compactBootstrapHumanRecord),
      runs: newestRecords(snapshot.runs, 80).sort((a, b) => recordTime(a) - recordTime(b)),
      workItems: newestRecords(snapshot.workItems, 200).sort((a, b) => recordTime(a) - recordTime(b)),
      events: newestRecords(snapshot.events, eventLimit).sort((a, b) => recordTime(a) - recordTime(b)),
      routeEvents: newestRecords(snapshot.routeEvents, 80).sort((a, b) => recordTime(a) - recordTime(b)),
      systemNotifications: newestRecords(snapshot.systemNotifications, 120).sort((a, b) => recordTime(a) - recordTime(b)),
      attachments: records(snapshot.attachments).filter((attachment) => attachmentIds.has(String(attachment.id))),
      cloud: compactBootstrapCloudState(snapshot.cloud),
    };
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
    publicState,
    runtimeSnapshot,
    startPackageVersionPolling,
    stopPackageVersionPolling,
    updateFanoutApiConfig,
  };
}
