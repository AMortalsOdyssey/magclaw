// Message and thread API routes.
// This route group owns the human-facing conversation writes: top-level
// messages, thread replies, saved toggles, and message-to-task promotion. The
// delivery/routing helpers are injected so the route remains a thin workflow
// coordinator rather than a second Agent runtime implementation.
import { findWorkspaceAllChannel, isWorkspaceAllChannel } from '../workspace-defaults.js';
import { firstActorReferenceIndex, textReferencesActor } from '../mentions.js';
import {
  CONVERSATION_REFERENCE_LIMITS,
  compactConversationReferenceText,
  normalizeStoredConversationReferences,
} from '../conversation-references.js';
import { createTaskStartupCollaboration } from '../task-startup-collaboration.js';

const MESSAGE_REACTION_OPTIONS = [
  { key: 'thumbs_up', emoji: '👍' },
  { key: 'heart', emoji: '❤️' },
  { key: 'party', emoji: '🎉' },
  { key: 'eyes', emoji: '👀' },
  { key: 'fire', emoji: '🔥' },
  { key: 'laugh', emoji: '😂' },
  { key: 'check', emoji: '✅' },
  { key: 'idea', emoji: '💡' },
  { key: 'pray', emoji: '🙏' },
  { key: 'clap', emoji: '👏' },
  { key: 'rocket', emoji: '🚀' },
  { key: 'thinking', emoji: '🤔' },
  { key: 'wow', emoji: '😮' },
  { key: 'smile', emoji: '😄' },
  { key: 'strong', emoji: '💪' },
  { key: 'sparkles', emoji: '✨' },
  { key: 'brain', emoji: '🧠' },
  { key: 'pin', emoji: '📌' },
  { key: 'tool', emoji: '🛠️' },
  { key: 'star', emoji: '⭐' },
];
const MESSAGE_REACTION_BY_KEY = new Map(MESSAGE_REACTION_OPTIONS.map((item) => [item.key, item]));
const MESSAGE_REACTION_BY_EMOJI = new Map(MESSAGE_REACTION_OPTIONS.map((item) => [item.emoji, item]));

export async function handleMessageApi(req, res, url, deps) {
  const {
    addCollabEvent,
    addSystemEvent,
    addSystemReply,
    addTaskHistory,
    agentAvailableForAutoWork,
    agentCapabilityQuestionIntent,
    agentMemoryWriteIntent,
    applyMentions,
    availabilityFollowupIntent,
    broadcastState,
    channelAgentIds,
    channelHumanIds,
    claimTask,
    createOrClaimTaskForMessage,
    createTaskFromMessage,
    createTaskMessage,
    createTaskFromThreadIntent,
    currentActor,
    deliverMessageToAgent,
    displayActor,
    extractMentions,
    findAgent,
    findChannel,
    findConversationRecord,
    findHuman,
    findMessage,
    findTaskForThreadMessage,
    finishTaskFromThread,
    getState,
    inferAgentMemoryWriteback,
    inferAgentPermissionGrant,
    inferConversationDisclosureGrant,
    getMessageById,
    listSpaceMessagesPage,
    listThreadRepliesPage,
    markConversationRecordsRead,
    makeId,
    normalizeIds,
    normalizeConversationRecord,
    now,
    persistState,
    pickAvailableAgent,
    readJson,
    routeMessageForChannel,
    routeTaskAssignees,
    routeThreadReplyForChannel,
    recordAgentPermissionGrant,
    recordConversationGrant,
    scheduleAgentMemoryWriteback,
    searchAgentMemory,
    sendError,
    sendJson,
    stopTaskFromThread,
    taskAssignmentDeliveryMessage,
    taskCreationIntent,
    taskEndIntent,
    taskStopIntent,
    taskThreadDeliveryMessage,
    taskLabel,
    textAddressesAgent,
    userPreferenceIntent,
  } = deps;
  const state = getState();
  const { startTaskStartupCollaboration } = createTaskStartupCollaboration(deps);

  function publicRouteDecision(routeDecision) {
    if (!routeDecision) return null;
    const { runFanoutSupplement, ...publicDecision } = routeDecision;
    return publicDecision;
  }

  function scheduleFanoutSupplementDelivery({
    routeDecision,
    channelAgents,
    message,
    spaceType,
    spaceId,
    parentMessageId = null,
    alreadyDeliveredAgentIds = [],
    deliveryContext = {},
  }) {
    if (typeof routeDecision?.runFanoutSupplement !== 'function') return;
    const delivered = new Set(alreadyDeliveredAgentIds.map(String));
    routeDecision.runFanoutSupplement().then(async (supplement) => {
      const targetAgents = (supplement?.targetAgentIds || [])
        .map((id) => channelAgents.find((agent) => agent.id === id))
        .filter(Boolean)
        .filter(agentAvailableForAutoWork)
        .filter((agent) => !delivered.has(agent.id));
      for (const agent of targetAgents) {
        delivered.add(agent.id);
        deliverMessageToAgent(agent, spaceType, spaceId, message, { parentMessageId, ...deliveryContext }).catch(err => {
          addSystemEvent('delivery_error', `Failed to deliver LLM supplement to ${agent.name}: ${err.message}`, {
            agentId: agent.id,
            messageId: message.id,
            parentMessageId,
            routeEventId: supplement?.routeEvent?.id || null,
          });
        });
      }
      await persistConversationState(message, spaceType, spaceId);
      broadcastState();
    }).catch(async (err) => {
      addSystemEvent('fanout_api_supplement_delivery_error', `LLM supplement delivery failed: ${err.message}`, {
        messageId: message?.id || null,
        parentMessageId,
      });
      await persistConversationState(message, spaceType, spaceId).catch(() => {});
      broadcastState();
    });
  }

  function uniqueAgents(agents) {
    const seen = new Set();
    return (agents || []).filter((agent) => {
      if (!agent || seen.has(agent.id)) return false;
      seen.add(agent.id);
      return true;
    });
  }

  function actorsNamedInText(actors, text, matcher = textReferencesActor) {
    return (actors || [])
      .map((actor, fallbackIndex) => ({
        actor,
        fallbackIndex,
        index: firstActorReferenceIndex(actor, text),
      }))
      .filter((item) => item.index >= 0 && matcher(item.actor, text))
      .sort((a, b) => a.index - b.index || a.fallbackIndex - b.fallbackIndex)
      .map((item) => item.actor);
  }

  function taskCandidateIdsFromChannel(channelAgents, mentions, text) {
    const named = actorsNamedInText(channelAgents, text, textAddressesAgent).map((agent) => agent.id);
    const explicit = normalizeIds([...(mentions?.agents || []), ...named]);
    return explicit.length ? explicit : channelAgents.map((agent) => agent.id);
  }

  function taskCandidateIdsFromThread(parentMessage, reply, channelAgents, mentions, linkedTask) {
    const channelAgentIdsSet = new Set((channelAgents || []).map((agent) => agent.id));
    const named = actorsNamedInText(channelAgents, reply?.body || '', textAddressesAgent).map((agent) => agent.id);
    const parentAuthor = String(parentMessage?.authorId || '').startsWith('agt_') ? [parentMessage.authorId] : [];
    const replyAuthor = String(reply?.authorId || '').startsWith('agt_') ? [reply.authorId] : [];
    const threadReplyAuthors = safeThreadReplies(parentMessage?.id)
      .map((item) => String(item?.authorId || ''))
      .filter((id) => id.startsWith('agt_'));
    const ids = normalizeIds([
      ...(mentions?.agents || []),
      ...named,
      ...parentAuthor,
      ...replyAuthor,
      ...threadReplyAuthors,
      ...(linkedTask?.claimedBy ? [linkedTask.claimedBy] : []),
      ...(linkedTask?.assigneeIds || []),
      ...(parentMessage?.mentionedAgentIds || []),
    ]).filter((id) => channelAgentIdsSet.has(id));
    return ids.length ? ids : (channelAgents || []).map((agent) => agent.id);
  }

  function safeThreadReplies(parentMessageId) {
    if (!parentMessageId) return [];
    return (state.replies || []).filter((reply) => reply.parentMessageId === parentMessageId);
  }

  function dmAgent(spaceId) {
    const dm = state.dms.find(d => d.id === spaceId);
    const agentId = dm?.participantIds?.find(id => id.startsWith('agt_'));
    return agentId ? findAgent(agentId) : null;
  }

  function currentHumanId(req) {
    const auth = typeof currentActor === 'function' ? currentActor(req) : null;
    return auth?.member?.humanId || state.cloud?.auth?.currentMember?.humanId || 'hum_local';
  }

  function currentHumanName(req, humanId = currentHumanId(req)) {
    const auth = typeof currentActor === 'function' ? currentActor(req) : null;
    const authName = auth?.member?.name || auth?.user?.name || '';
    const human = findHuman(humanId) || state.humans?.find((item) => item.id === humanId);
    return human?.name || authName || humanId;
  }

  function actorSnapshotName(authorId, authorType) {
    if (authorType === 'human') return findHuman(authorId)?.name || authorId || 'Unknown';
    if (authorType === 'agent') return findAgent(authorId)?.name || authorId || 'Unknown';
    if (authorId === 'system' || authorType === 'system') return 'Magclaw';
    return authorId || 'Unknown';
  }

  function spacePrivacy(spaceType, spaceId) {
    if (spaceType === 'dm') return 'private';
    const channel = findChannel(spaceId);
    const raw = String(channel?.visibility || channel?.privacy || '').trim().toLowerCase();
    if (['private', 'secret'].includes(raw) || channel?.private || channel?.secret || channel?.isPrivate) return 'private';
    return 'public';
  }

  function recordSourceSpace(record) {
    const root = threadRootForRecord(record) || record;
    return {
      root,
      spaceType: record?.spaceType || root?.spaceType || '',
      spaceId: record?.spaceId || root?.spaceId || '',
    };
  }

  function canReadReferenceRecord(req, record) {
    const auth = typeof currentActor === 'function' ? currentActor(req) : null;
    if (!auth) return true;
    const { spaceType, spaceId } = recordSourceSpace(record);
    if (spaceType === 'dm') return canUseDm(req, spaceId);
    if (spaceType === 'channel') return channelHasHuman(findChannel(spaceId), currentHumanId(req));
    return false;
  }

  function referenceCanTravel(sourceSpaceType, sourceSpaceId, targetSpaceType, targetSpaceId) {
    if (!sourceSpaceType || !sourceSpaceId) return false;
    if (sourceSpaceType === targetSpaceType && sourceSpaceId === targetSpaceId) return true;
    if (sourceSpaceType === 'dm' || targetSpaceType === 'dm') return false;
    if (spacePrivacy(sourceSpaceType, sourceSpaceId) !== 'public') return false;
    if (spacePrivacy(targetSpaceType, targetSpaceId) !== 'public') return false;
    return true;
  }

  function compareCreatedAsc(a, b) {
    const left = new Date(a?.createdAt || 0).getTime();
    const right = new Date(b?.createdAt || 0).getTime();
    if (left !== right) return left - right;
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  }

  function referenceRecordsForThread(parentMessageId) {
    const parent = findMessage(parentMessageId);
    if (!parent) return [];
    return [parent, ...state.replies
      .filter((reply) => reply.parentMessageId === parent.id)
      .sort(compareCreatedAsc)];
  }

  function referenceRecordsForConversation(spaceType, spaceId) {
    return state.messages
      .filter((message) => message.spaceType === spaceType && message.spaceId === spaceId)
      .sort(compareCreatedAsc)
      .slice(-CONVERSATION_REFERENCE_LIMITS.recordsPerReference);
  }

  function hydrateConversationReference(reference, req, targetSpaceType, targetSpaceId, targetWorkspaceId) {
    const ref = { ...reference };
    const sourceRecord = ref.sourceRecordId ? findConversationRecord(ref.sourceRecordId) : null;
    let parentMessage = ref.parentMessageId ? findMessage(ref.parentMessageId) : null;

    if ((ref.kind === 'message' || ref.kind === 'selection') && !sourceRecord) {
      return { error: 'Referenced message is not available.' };
    }
    if (sourceRecord?.parentMessageId) parentMessage = findMessage(sourceRecord.parentMessageId);
    if (ref.kind === 'thread') {
      parentMessage = parentMessage || (sourceRecord?.parentMessageId ? findMessage(sourceRecord.parentMessageId) : sourceRecord);
      if (!parentMessage || parentMessage.parentMessageId) return { error: 'Referenced thread is not available.' };
      ref.sourceRecordId = parentMessage.id;
      ref.parentMessageId = parentMessage.id;
      ref.sourceKind = 'message';
    }

    const anchor = sourceRecord || parentMessage || null;
    if (ref.kind !== 'conversation' && !anchor) return { error: 'Referenced message is not available.' };

    const sourceSpace = ref.kind === 'conversation'
      ? { spaceType: targetSpaceType, spaceId: targetSpaceId, root: null }
      : recordSourceSpace(anchor);
    const sourceWorkspaceId = ref.kind === 'conversation'
      ? targetWorkspaceId
      : workspaceIdForConversation(sourceSpace.root || anchor, sourceSpace.spaceType, sourceSpace.spaceId, req);
    if (sourceWorkspaceId && targetWorkspaceId && sourceWorkspaceId !== targetWorkspaceId) {
      return { error: 'Referenced message belongs to another workspace.' };
    }
    if (anchor && !canReadReferenceRecord(req, anchor)) {
      return { error: 'Referenced message is not available.' };
    }
    if (!referenceCanTravel(sourceSpace.spaceType, sourceSpace.spaceId, targetSpaceType, targetSpaceId)) {
      return { error: 'Private conversation references can only be sent inside the same conversation.' };
    }

    let records = [];
    if (ref.kind === 'thread') {
      records = referenceRecordsForThread(parentMessage.id);
    } else if (ref.kind === 'conversation') {
      records = referenceRecordsForConversation(targetSpaceType, targetSpaceId);
    } else if (anchor) {
      records = [anchor];
    }
    const suppliedIds = Array.isArray(ref.recordIds) ? ref.recordIds : [];
    const visibleSuppliedRecords = [];
    for (const id of suppliedIds) {
      const record = findConversationRecord(id);
      if (!record || !canReadReferenceRecord(req, record)) {
        return { error: 'Referenced message is not available.' };
      }
      const space = recordSourceSpace(record);
      const workspaceId = workspaceIdForConversation(space.root || record, space.spaceType, space.spaceId, req);
      if (targetWorkspaceId && workspaceId && workspaceId !== targetWorkspaceId) {
        return { error: 'Referenced message belongs to another workspace.' };
      }
      if (!referenceCanTravel(space.spaceType, space.spaceId, targetSpaceType, targetSpaceId)) {
        return { error: 'Private conversation references can only be sent inside the same conversation.' };
      }
      visibleSuppliedRecords.push(record);
    }
    if (visibleSuppliedRecords.length) records = visibleSuppliedRecords;

    const truncated = records.length > CONVERSATION_REFERENCE_LIMITS.recordsPerReference || Boolean(ref.truncated);
    const boundedRecords = records.slice(0, CONVERSATION_REFERENCE_LIMITS.recordsPerReference);
    const recordIds = boundedRecords.map((record) => record.id);
    const displayRecord = anchor || boundedRecords[0] || null;
    const selectedText = ref.kind === 'selection'
      ? compactConversationReferenceText(ref.selectedText, CONVERSATION_REFERENCE_LIMITS.selectedTextChars)
      : '';

    return {
      reference: {
        ...ref,
        sourceKind: displayRecord?.parentMessageId ? 'reply' : (ref.sourceKind || (displayRecord ? 'message' : undefined)),
        parentMessageId: displayRecord?.parentMessageId || ref.parentMessageId || undefined,
        spaceType: sourceSpace.spaceType,
        spaceId: sourceSpace.spaceId,
        authorType: displayRecord?.authorType || ref.authorType || undefined,
        authorId: displayRecord?.authorId || ref.authorId || undefined,
        authorName: displayRecord ? actorSnapshotName(displayRecord.authorId, displayRecord.authorType) : ref.authorName,
        createdAt: displayRecord?.createdAt || ref.createdAt || undefined,
        bodyPreview: compactConversationReferenceText(displayRecord?.body || ref.bodyPreview || ''),
        selectedText: selectedText || undefined,
        recordIds,
        truncated,
      },
    };
  }

  function normalizeIncomingReferencesForWrite(rawReferences, req, targetSpaceType, targetSpaceId, targetWorkspaceId) {
    if (rawReferences === undefined || rawReferences === null) return { references: [] };
    if (!Array.isArray(rawReferences)) return { error: 'Message references must be an array.' };
    const normalized = normalizeStoredConversationReferences(rawReferences, { makeId });
    if (rawReferences.length && !normalized.length) return { error: 'Message references are invalid.' };
    const references = [];
    for (const reference of normalized) {
      const hydrated = hydrateConversationReference(reference, req, targetSpaceType, targetSpaceId, targetWorkspaceId);
      if (hydrated.error) {
        console.info('[message] rejected conversation reference', {
          kind: reference.kind,
          sourceRecordId: reference.sourceRecordId || '',
          reason: hydrated.error,
        });
        return { error: hydrated.error };
      }
      references.push(hydrated.reference);
    }
    const finalReferences = normalizeStoredConversationReferences(references, { makeId });
    if (finalReferences.length) {
      console.info('[message] conversation references normalized', {
        targetSpaceType,
        targetSpaceId,
        referenceCount: finalReferences.length,
        kinds: finalReferences.map((ref) => ref.kind),
      });
    }
    return { references: finalReferences };
  }

  function workspaceIdForConversation(record, spaceType, spaceId, req = null) {
    const explicit = String(record?.workspaceId || record?.workspace_id || '').trim();
    if (explicit) return explicit;
    const target = spaceType === 'channel'
      ? state.channels.find((channel) => channel.id === spaceId)
      : state.dms.find((dm) => dm.id === spaceId);
    if (target?.workspaceId) return String(target.workspaceId).trim();
    if (req) return workspaceIdForSpace(spaceType, spaceId, req);
    return String(state.connection?.workspaceId || state.cloud?.workspace?.id || '').trim();
  }

  function persistConversationState(record, spaceType, spaceId, req = null) {
    const workspaceId = workspaceIdForConversation(record, spaceType, spaceId, req);
    return persistState(workspaceId ? { workspaceId, reason: 'conversation_changed' } : { reason: 'conversation_changed' });
  }

  function reactionOptionFromInput(input = {}) {
    const key = String(input.key || '').trim();
    const emoji = String(input.emoji || '').trim();
    return MESSAGE_REACTION_BY_KEY.get(key) || MESSAGE_REACTION_BY_EMOJI.get(emoji) || null;
  }

  function reactionSignature(reaction) {
    return `${reaction?.key || ''}:${reaction?.actorType || 'human'}:${reaction?.actorId || ''}`;
  }

  function toggleRecordReaction(record, option, req) {
    const humanId = currentHumanId(req);
    const actorName = currentHumanName(req, humanId);
    const signature = `${option.key}:human:${humanId}`;
    const seen = new Set();
    let removed = false;
    const nextReactions = [];
    for (const reaction of Array.isArray(record.reactions) ? record.reactions : []) {
      const clean = {
        key: String(reaction?.key || reaction?.emoji || '').trim(),
        emoji: String(reaction?.emoji || reaction?.key || '').trim(),
        actorId: String(reaction?.actorId || '').trim(),
        actorType: String(reaction?.actorType || 'human').trim() || 'human',
        actorName: String(reaction?.actorName || '').trim(),
        createdAt: reaction?.createdAt || now(),
      };
      if (!clean.key || !clean.emoji || !clean.actorId) continue;
      const itemSignature = reactionSignature(clean);
      if (itemSignature === signature) {
        removed = true;
        continue;
      }
      if (seen.has(itemSignature)) continue;
      seen.add(itemSignature);
      nextReactions.push(clean);
    }
    let reaction = null;
    if (!removed) {
      reaction = {
        key: option.key,
        emoji: option.emoji,
        actorId: humanId,
        actorType: 'human',
        actorName,
        createdAt: now(),
      };
      nextReactions.push(reaction);
    }
    record.reactions = nextReactions;
    record.updatedAt = now();
    normalizeConversationRecord(record);
    console.info('[message] reaction toggled', {
      recordId: record.id,
      reactionKey: option.key,
      humanId,
      active: !removed,
    });
    return { reaction, active: !removed };
  }

  function threadRootForRecord(record) {
    if (!record) return null;
    if (!record.parentMessageId) return record;
    return findMessage(record.parentMessageId);
  }

  function toggleThreadFollow(record, req) {
    const root = threadRootForRecord(record);
    if (!root) return null;
    const humanId = currentHumanId(req);
    const followed = new Set((Array.isArray(root.followedBy) ? root.followedBy : []).map(String).filter(Boolean));
    const active = !followed.has(humanId);
    if (active) followed.add(humanId);
    else followed.delete(humanId);
    root.followedBy = normalizeIds([...followed]);
    root.updatedAt = now();
    normalizeConversationRecord(root);
    console.info('[message] thread follow toggled', {
      messageId: root.id,
      sourceRecordId: record.id,
      humanId,
      active,
    });
    return { root, active };
  }

  function canUseDm(req, spaceId) {
    const auth = typeof currentActor === 'function' ? currentActor(req) : null;
    if (!auth) return true;
    const humanId = auth.member?.humanId;
    const dm = state.dms.find((item) => item.id === spaceId);
    return Boolean(humanId && dm?.participantIds?.includes(humanId));
  }

  function channelHasHuman(channel, humanId) {
    if (!channel || !humanId) return false;
    if (isWorkspaceAllChannel(channel)) return true;
    const ids = new Set([
      ...(Array.isArray(channel.memberIds) ? channel.memberIds : []),
      ...(Array.isArray(channel.humanIds) ? channel.humanIds : []),
    ].map(String));
    return ids.has(String(humanId));
  }

  function canWriteChannel(req, channel, author) {
    if (author?.authorType !== 'human') return true;
    const humanId = author.authorId || currentHumanId(req);
    const allowed = channelHasHuman(channel, humanId);
    if (!allowed) {
      console.info('[message] rejected non-member channel write', {
        channelId: channel?.id || '',
        humanId,
      });
    }
    return allowed;
  }

  function paginationLimit(value, fallback = 80, max = 200) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(max, Math.max(1, Math.floor(parsed)));
  }

  function recordTime(record) {
    const parsed = Date.parse(record?.createdAt || record?.updatedAt || '');
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function beforeCursorTime(url) {
    const raw = url.searchParams.get('before') || '';
    if (!raw) return Number.POSITIVE_INFINITY;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
  }

  function beforeCursorId(url) {
    return String(url.searchParams.get('beforeId') || '').trim();
  }

  function cursorMatchesBefore(record, before, beforeId = '') {
    const time = recordTime(record);
    if (!Number.isFinite(before) || before === Number.POSITIVE_INFINITY) return true;
    if (!beforeId) return time < before;
    return time < before || (time === before && String(record?.id || '') < beforeId);
  }

  function sortNewestFirst(a, b) {
    return recordTime(b) - recordTime(a) || String(b?.id || '').localeCompare(String(a?.id || ''));
  }

  function sortOldestFirst(a, b) {
    return recordTime(a) - recordTime(b) || String(a?.id || '').localeCompare(String(b?.id || ''));
  }

  function workspaceIdForRequest(req) {
    const auth = typeof currentActor === 'function' ? currentActor(req) : null;
    return String(auth?.member?.workspaceId || state.connection?.workspaceId || state.cloud?.workspace?.id || 'local').trim();
  }

  function workspaceIdForSpace(spaceType, spaceId, req) {
    const target = spaceType === 'channel'
      ? state.channels.find((channel) => channel.id === spaceId)
      : state.dms.find((dm) => dm.id === spaceId);
    if (target?.workspaceId) return target.workspaceId;
    const auth = typeof currentActor === 'function' ? currentActor(req) : null;
    return String(auth?.member?.workspaceId || state.connection?.workspaceId || state.cloud?.workspace?.id || 'local').trim();
  }

  function resolveSpaceId(spaceType, spaceId, req) {
    if (spaceType !== 'channel' || spaceId !== 'chan_all') return spaceId;
    const workspaceId = workspaceIdForSpace(spaceType, spaceId, req);
    return findWorkspaceAllChannel(state, workspaceId)?.id || spaceId;
  }

  function messageAuthor(req, body = {}) {
    const authorType = body.authorType === 'agent' ? 'agent' : 'human';
    const authorId = authorType === 'human'
      ? currentHumanId(req)
      : String(body.authorId || 'hum_local');
    return { authorType, authorId };
  }

  function ensureInboxReadState(humanId) {
    state.inboxReads = state.inboxReads && typeof state.inboxReads === 'object' && !Array.isArray(state.inboxReads)
      ? state.inboxReads
      : {};
    state.inboxReads[humanId] = state.inboxReads[humanId] && typeof state.inboxReads[humanId] === 'object'
      ? state.inboxReads[humanId]
      : {};
    return state.inboxReads[humanId];
  }

  function markConversationRecordRead(record, humanId) {
    if (!record) return false;
    normalizeConversationRecord(record);
    const readBy = new Set((record.readBy || []).map(String));
    const before = readBy.size;
    readBy.add(String(humanId));
    record.readBy = [...readBy];
    return readBy.size !== before;
  }

  function canReadSpace(req, spaceType, spaceId) {
    if (spaceType === 'dm') return canUseDm(req, spaceId);
    if (spaceType === 'channel') return channelHasHuman(findChannel(spaceId), currentHumanId(req));
    return false;
  }

  function recordMatchesSpace(record, spaceType, spaceId) {
    const source = recordSourceSpace(record);
    return source.spaceType === spaceType && source.spaceId === spaceId;
  }

  function localRecordsForSpace(spaceType, spaceId) {
    return [
      ...(state.messages || []),
      ...(state.replies || []),
    ].filter((record) => recordMatchesSpace(record, spaceType, spaceId));
  }

  function localRecordsForThread(parentMessageId) {
    const parent = findMessage(parentMessageId);
    return [
      parent,
      ...(state.replies || []).filter((reply) => reply.parentMessageId === parentMessageId),
    ].filter(Boolean);
  }

  if (req.method === 'POST' && url.pathname === '/api/inbox/read') {
    const body = await readJson(req);
    const humanId = currentHumanId(req);
    const recordIds = Array.isArray(body.recordIds)
      ? [...new Set(body.recordIds.map(String).filter(Boolean))].slice(0, 500)
      : [];
    const requestedSpaceType = ['channel', 'dm'].includes(body.spaceType) ? body.spaceType : '';
    const requestedSpaceId = String(body.spaceId || '').trim();
    const threadMessageId = String(body.threadMessageId || '').trim();
    let scopedSpaceType = '';
    let scopedSpaceId = '';
    let scopedThreadMessageId = '';
    let readWorkspaceId = workspaceIdForRequest(req);
    if (requestedSpaceType && requestedSpaceId) {
      scopedSpaceType = requestedSpaceType;
      scopedSpaceId = resolveSpaceId(requestedSpaceType, requestedSpaceId, req);
      const targetExists = scopedSpaceType === 'channel'
        ? state.channels.some((channel) => channel.id === scopedSpaceId)
        : state.dms.some((dm) => dm.id === scopedSpaceId);
      if (!targetExists) {
        sendError(res, 404, 'Conversation not found.');
        return true;
      }
      if (!canReadSpace(req, scopedSpaceType, scopedSpaceId)) {
        sendError(res, 403, 'Conversation is not available.');
        return true;
      }
      readWorkspaceId = workspaceIdForSpace(scopedSpaceType, scopedSpaceId, req);
    }
    if (threadMessageId) {
      const threadRoot = findMessage(threadMessageId)
        || (typeof getMessageById === 'function' ? await getMessageById(threadMessageId, { workspaceId: readWorkspaceId }) : null);
      if (!threadRoot) {
        sendError(res, 404, 'Thread not found.');
        return true;
      }
      if (!canReadSpace(req, threadRoot.spaceType, threadRoot.spaceId)) {
        sendError(res, 403, 'Conversation is not available.');
        return true;
      }
      scopedThreadMessageId = threadRoot.id;
      readWorkspaceId = threadRoot.workspaceId || workspaceIdForSpace(threadRoot.spaceType, threadRoot.spaceId, req);
    }
    if (!recordIds.length && !scopedSpaceId && !scopedThreadMessageId) {
      if (body.workspaceActivityReadAt !== undefined) {
        console.info('[inbox] workspace activity read acknowledged locally', { humanId });
      }
      sendJson(res, 200, {
        ok: true,
        readRecordIds: [],
        inboxReads: state.inboxReads?.[humanId] || {},
      });
      return true;
    }
    const readState = ensureInboxReadState(humanId);
    let changed = false;
    const markedRecordIds = new Set();
    for (const recordId of recordIds) {
      const record = findConversationRecord(recordId);
      if (!record) continue;
      if (markConversationRecordRead(record, humanId)) changed = true;
      markedRecordIds.add(record.id);
    }
    for (const record of scopedSpaceId ? localRecordsForSpace(scopedSpaceType, scopedSpaceId) : []) {
      if (markConversationRecordRead(record, humanId)) changed = true;
      markedRecordIds.add(record.id);
    }
    for (const record of scopedThreadMessageId ? localRecordsForThread(scopedThreadMessageId) : []) {
      if (markConversationRecordRead(record, humanId)) changed = true;
      markedRecordIds.add(record.id);
    }
    if (typeof markConversationRecordsRead === 'function') {
      const durableRead = await markConversationRecordsRead({
        workspaceId: readWorkspaceId,
        humanId,
        recordIds,
        spaceType: scopedSpaceType,
        spaceId: scopedSpaceId,
        threadMessageId: scopedThreadMessageId,
      });
      for (const id of [...(durableRead?.messageIds || []), ...(durableRead?.replyIds || [])]) markedRecordIds.add(id);
      if (durableRead?.count) changed = true;
    }
    readState.updatedAt = now();
    console.info('[inbox] mark read', {
      humanId,
      recordCount: markedRecordIds.size,
      scope: scopedThreadMessageId
        ? `thread:${scopedThreadMessageId}`
        : (scopedSpaceId ? `${scopedSpaceType}:${scopedSpaceId}` : 'records'),
    });
    if (changed) {
      await persistState({ workspaceId: readWorkspaceId, reason: 'conversation_read_state_changed' });
      broadcastState();
    }
    sendJson(res, 200, {
      ok: true,
      readRecordIds: [...markedRecordIds],
      inboxReads: readState,
    });
    return true;
  }

  function memoryTargetsForConversation({ spaceType, spaceId, respondingAgents = [], mentions = {}, parentMessage = null }) {
    const mentionedAgents = (mentions.agents || []).map((id) => findAgent(id)).filter(Boolean);
    if (respondingAgents.length || mentionedAgents.length) return uniqueAgents([...respondingAgents, ...mentionedAgents]);
    if (spaceType === 'dm') return uniqueAgents([dmAgent(spaceId)]);
    const parentAgent = parentMessage?.authorType === 'agent' ? findAgent(parentMessage.authorId) : null;
    if (parentAgent) return [parentAgent];
    const channel = findChannel(spaceId);
    return channel ? channelAgentIds(channel).map((id) => findAgent(id)).filter(Boolean) : [];
  }

  async function scheduleMessageMemoryWritebacks({ record, text, spaceType, spaceId, respondingAgents = [], mentions = {}, parentMessage = null }) {
    if (!record || record.authorType !== 'human') return;
    const memory = inferAgentMemoryWriteback(text);
    const explicitMemory = agentMemoryWriteIntent(text);
    const permissionGrant = typeof inferAgentPermissionGrant === 'function'
      ? inferAgentPermissionGrant(text)
      : null;
    const disclosureGrant = typeof inferConversationDisclosureGrant === 'function'
      ? inferConversationDisclosureGrant(text)
      : null;
    if (!memory && !userPreferenceIntent(text) && !permissionGrant && !disclosureGrant) return;
    const targets = memoryTargetsForConversation({
      spaceType,
      spaceId,
      respondingAgents,
      mentions,
      parentMessage,
    });
    const writes = [];
    let permissionChanged = false;
    if (permissionGrant) {
      for (const agent of targets) {
        const changed = typeof recordAgentPermissionGrant === 'function'
          ? recordAgentPermissionGrant(agent, permissionGrant, {
            now,
            sourceMessageId: record.id,
          })
          : false;
        if (changed) {
          permissionChanged = true;
          addSystemEvent('agent_permission_grant_persisted', `${agent.name} permission grant persisted.`, {
            agentId: agent.id,
            messageId: record.id,
            kind: permissionGrant.kind,
          });
        }
        writes.push(Promise.resolve(scheduleAgentMemoryWriteback(agent, 'permission_grant', {
          message: record,
          spaceType,
          spaceId,
          parentMessageId: parentMessage?.id || null,
          memory: {
            kind: 'preference',
            summary: permissionGrant.summary,
            sourceText: permissionGrant.sourceText || text,
          },
        })));
      }
    }
    if (disclosureGrant && spaceType === 'dm') {
      const sourceTarget = parentMessage?.id ? `dm:${spaceId}:${parentMessage.id}` : `dm:${spaceId}`;
      for (const agent of targets) {
        const grant = typeof recordConversationGrant === 'function'
          ? recordConversationGrant(state, {
            ...disclosureGrant,
            workspaceId: record.workspaceId || state.connection?.workspaceId || state.cloud?.workspace?.id || 'local',
            grantorHumanId: record.authorId,
            agentId: agent.id,
            sourceTarget,
            sourceMessageId: record.id,
          }, { makeId, now })
          : null;
        if (grant) {
          addSystemEvent(
            disclosureGrant.intent === 'revoke' ? 'conversation_grant_revoked' : 'conversation_grant_persisted',
            `${agent.name} conversation disclosure grant ${disclosureGrant.intent === 'revoke' ? 'revoked' : 'persisted'}.`,
            { agentId: agent.id, messageId: record.id, grantId: grant.id, sourceTarget },
          );
        }
      }
    }
    if (memory && !permissionGrant) {
      const trigger = explicitMemory ? 'explicit_user_memory' : 'user_preference';
      writes.push(...targets.map((agent) => Promise.resolve(scheduleAgentMemoryWriteback(agent, trigger, {
        message: record,
        spaceType,
        spaceId,
        parentMessageId: parentMessage?.id || null,
        memory,
      }))));
    } else if (!memory && userPreferenceIntent(text) && !permissionGrant) {
      writes.push(...targets.map((agent) => Promise.resolve(scheduleAgentMemoryWriteback(agent, 'user_preference', {
        message: record,
        spaceType,
        spaceId,
        parentMessageId: parentMessage?.id || null,
        memory,
      }))));
    }
    await Promise.all(writes);
    if (permissionChanged || disclosureGrant) {
      await persistConversationState(record, spaceType, spaceId);
      broadcastState();
    }
  }

  function compactPeerMemoryResult(item) {
    return {
      agentId: item.agentId,
      agentName: item.agentName,
      agentDescription: item.agentDescription || '',
      path: item.path,
      line: item.line,
      score: Number(item.score || 0),
      matchedTerms: Array.isArray(item.matchedTerms) ? item.matchedTerms.slice(0, 8) : [],
      preview: String(item.preview || '').slice(0, 280),
    };
  }

  function appendRouteEvidence(routeDecision, evidence) {
    if (!routeDecision || !evidence) return;
    routeDecision.evidence = Array.isArray(routeDecision.evidence) ? routeDecision.evidence : [];
    routeDecision.evidence.push(evidence);
    if (routeDecision.routeEvent) {
      routeDecision.routeEvent.evidence = Array.isArray(routeDecision.routeEvent.evidence) ? routeDecision.routeEvent.evidence : [];
      if (routeDecision.routeEvent.evidence !== routeDecision.evidence) {
        routeDecision.routeEvent.evidence.push(evidence);
      }
    }
  }

  async function buildPeerMemorySearchContext({
    text,
    message,
    routeDecision = null,
    parentMessageId = null,
  }) {
    if (!agentCapabilityQuestionIntent(text) || typeof searchAgentMemory !== 'function') return null;
    const reason = 'This message asks which agent is best suited, so agent memory and notes must be searched before recommending an agent.';
    let search = null;
    try {
      search = await searchAgentMemory(text, {
        limit: 12,
        purpose: 'agent_discovery',
        excludePaths: ['notes/work-log.md', 'notes/agents.md'],
        workspaceId: message?.workspaceId
          || (message?.spaceType === 'channel' ? findChannel(message.spaceId)?.workspaceId : '')
          || state.connection?.workspaceId
          || '',
      });
    } catch (error) {
      addSystemEvent('agent_peer_memory_search_error', `Peer memory search failed: ${error.message}`, {
        messageId: message?.id || null,
        parentMessageId,
        query: text,
        error: error.message,
      });
      appendRouteEvidence(routeDecision, { type: 'peer_memory_search_error', value: String(error.message || error).slice(0, 240) });
      return {
        required: true,
        ok: false,
        query: text,
        reason,
        results: [],
        error: error.message,
      };
    }
    const results = (search?.results || []).map(compactPeerMemoryResult);
    addSystemEvent('agent_peer_memory_search', 'Peer memory searched for agent capability question.', {
      messageId: message?.id || null,
      parentMessageId,
      routeEventId: routeDecision?.routeEvent?.id || null,
      query: search?.query || text,
      terms: search?.terms || [],
      resultCount: results.length,
      topResults: results.slice(0, 5).map((item) => ({
        agentId: item.agentId,
        agentName: item.agentName,
        path: item.path,
        line: item.line,
        score: item.score,
        matchedTerms: item.matchedTerms,
      })),
    });
    appendRouteEvidence(routeDecision, {
      type: 'peer_memory_search',
      value: results.length
        ? `${results.length} match(es): ${results.slice(0, 3).map((item) => `${item.agentName} ${item.path}:${item.line}`).join('; ')}`
        : '0 matches',
    });
    return {
      required: true,
      ok: Boolean(search?.ok),
      query: search?.query || text,
      terms: search?.terms || [],
      reason,
      results,
      truncated: Boolean(search?.truncated),
    };
  }

  const messageMatch = url.pathname.match(/^\/api\/spaces\/(channel|dm)\/([^/]+)\/messages$/);
  if (req.method === 'GET' && messageMatch) {
    const [, spaceType, rawSpaceId] = messageMatch;
    const spaceId = resolveSpaceId(spaceType, rawSpaceId, req);
    const targetExists = spaceType === 'channel'
      ? state.channels.some((channel) => channel.id === spaceId)
      : state.dms.some((dm) => dm.id === spaceId);
    if (!targetExists) {
      sendError(res, 404, 'Conversation not found.');
      return true;
    }
    if (spaceType === 'dm' && !canUseDm(req, spaceId)) {
      sendError(res, 403, 'Conversation is not available.');
      return true;
    }
    const limit = paginationLimit(url.searchParams.get('limit'));
    const before = beforeCursorTime(url);
    const beforeId = beforeCursorId(url);
    const workspaceId = workspaceIdForSpace(spaceType, spaceId, req);
    if (typeof listSpaceMessagesPage === 'function' && workspaceId) {
      const page = await listSpaceMessagesPage({
        workspaceId,
        spaceType,
        spaceId,
        limit,
        before: Number.isFinite(before) && before !== Number.POSITIVE_INFINITY ? new Date(before).toISOString() : '',
        beforeId,
      });
      if (page) {
        sendJson(res, 200, page);
        return true;
      }
    }
    const matching = state.messages
      .filter((message) => message.spaceType === spaceType && message.spaceId === spaceId)
      .filter((message) => cursorMatchesBefore(message, before, beforeId))
      .sort(sortNewestFirst);
    const page = matching.slice(0, limit);
    const nextBefore = page.length ? page[page.length - 1].createdAt : '';
    const nextBeforeId = page.length ? page[page.length - 1].id : '';
    sendJson(res, 200, {
      messages: page.slice().sort(sortOldestFirst),
      pagination: {
        limit,
        hasMore: matching.length > page.length,
        nextBefore,
        nextBeforeId,
      },
    });
    return true;
  }

  if (req.method === 'POST' && messageMatch) {
    const body = await readJson(req);
    const [, spaceType, rawSpaceId] = messageMatch;
    const spaceId = resolveSpaceId(spaceType, rawSpaceId, req);
    const targetExists = spaceType === 'channel'
      ? state.channels.some((channel) => channel.id === spaceId)
      : state.dms.some((dm) => dm.id === spaceId);
    if (!targetExists) {
      sendError(res, 404, 'Conversation not found.');
      return true;
    }
    if (spaceType === 'dm' && !canUseDm(req, spaceId)) {
      sendError(res, 403, 'Conversation is not available.');
      return true;
	    }
	    const text = String(body.body || '').trim();
	    const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds.map(String) : [];
	    const mentions = extractMentions(text);
	    const author = messageAuthor(req, body);
	    const channel = spaceType === 'channel' ? findChannel(spaceId) : null;
	    if (spaceType === 'channel' && !canWriteChannel(req, channel, author)) {
	      sendError(res, 403, 'Join this channel before sending messages.');
	      return true;
	    }
	    const workspaceId = workspaceIdForSpace(spaceType, spaceId, req);
	    const referenceResult = normalizeIncomingReferencesForWrite(body.references, req, spaceType, spaceId, workspaceId);
	    if (referenceResult.error) {
	      sendError(res, 400, referenceResult.error);
	      return true;
	    }
	    const references = referenceResult.references;
	    if (!text && !attachmentIds.length && !references.length) {
	      sendError(res, 400, 'Message body, attachment, or reference is required.');
	      return true;
	    }
	    const message = normalizeConversationRecord({
	      id: makeId('msg'),
	      workspaceId,
	      spaceType,
	      spaceId,
      authorType: author.authorType,
      authorId: author.authorId,
      body: text,
      attachmentIds,
      mentionedAgentIds: mentions.agents,
      mentionedHumanIds: mentions.humans,
	      readBy: author.authorType === 'agent' ? [] : [author.authorId],
	      replyCount: 0,
	      savedBy: [],
	      references,
	      metadata: references.length ? { references } : undefined,
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
      if (channel) {
        const channelAgents = channelAgentIds(channel)
          .map(id => findAgent(id))
          .filter(Boolean);
        if (body.asTask && task) {
          const selectedTaskAgentIds = taskCandidateIdsFromChannel(channelAgents, mentions, text);
          await startTaskStartupCollaboration(task, message, selectedTaskAgentIds);
        } else {
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
    } else if (message.authorType === 'human' && spaceType === 'dm' && body.asTask && task) {
      const agent = dmAgent(spaceId);
      if (agent) await startTaskStartupCollaboration(task, message, [agent.id]);
    }

    const peerMemorySearch = await buildPeerMemorySearchContext({
      text,
      message,
      routeDecision,
    });
    const deliveryContext = peerMemorySearch ? { peerMemorySearch } : {};

    addCollabEvent('message_sent', 'Message sent.', { messageId: message.id, spaceType, spaceId });
    await persistConversationState(message, spaceType, spaceId, req);
    broadcastState();

    await scheduleMessageMemoryWritebacks({
      record: message,
      text,
      spaceType,
      spaceId,
      respondingAgents,
      mentions,
    });

    // Delivery happens after the message is durably stored so a background
    // Agent turn can always read the source record and thread context.
    if (message.authorType === 'human' && !body.asTask) {
      if (spaceType === 'dm') {
        const dm = state.dms.find(d => d.id === spaceId);
        if (dm) {
          const agentId = dm.participantIds.find(id => id.startsWith('agt_'));
          const agent = agentId ? findAgent(agentId) : null;
          if (agent) {
            deliverMessageToAgent(agent, spaceType, spaceId, message, deliveryContext).catch(err => {
              addSystemEvent('delivery_error', `Failed to deliver to ${agent.name}: ${err.message}`, { agentId });
            });
          }
        }
      } else if (spaceType === 'channel') {
        for (const agent of respondingAgents) {
          deliverMessageToAgent(agent, spaceType, spaceId, message, deliveryContext).catch(err => {
            addSystemEvent('delivery_error', `Failed to deliver to ${agent.name}: ${err.message}`, { agentId: agent.id });
          });
        }
        scheduleFanoutSupplementDelivery({
          routeDecision,
          channelAgents: channelAgentIds(findChannel(spaceId)).map((id) => findAgent(id)).filter(Boolean),
          message,
          spaceType,
          spaceId,
          alreadyDeliveredAgentIds: respondingAgents.map((agent) => agent.id),
          deliveryContext,
        });
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

    sendJson(res, 201, { message, task, route: publicRouteDecision(routeDecision) });
    return true;
  }

  const replyMatch = url.pathname.match(/^\/api\/messages\/([^/]+)\/replies$/);
  if (req.method === 'GET' && replyMatch) {
    const requestWorkspaceId = workspaceIdForRequest(req);
    const message = findMessage(replyMatch[1])
      || (typeof getMessageById === 'function' ? await getMessageById(replyMatch[1], { workspaceId: requestWorkspaceId }) : null);
    if (!message) {
      sendError(res, 404, 'Message not found.');
      return true;
    }
    if (message.spaceType === 'dm' && !canUseDm(req, message.spaceId)) {
      sendError(res, 403, 'Conversation is not available.');
      return true;
    }
    const limit = paginationLimit(url.searchParams.get('limit'), 80, 300);
    const before = beforeCursorTime(url);
    const beforeId = beforeCursorId(url);
    const workspaceId = message.workspaceId || requestWorkspaceId;
    if (typeof listThreadRepliesPage === 'function' && workspaceId) {
      const page = await listThreadRepliesPage({
        workspaceId,
        parentMessageId: message.id,
        limit,
        before: Number.isFinite(before) && before !== Number.POSITIVE_INFINITY ? new Date(before).toISOString() : '',
        beforeId,
      });
      if (page) {
        sendJson(res, 200, page);
        return true;
      }
    }
    const matching = state.replies
      .filter((reply) => reply.parentMessageId === message.id)
      .filter((reply) => cursorMatchesBefore(reply, before, beforeId))
      .sort(sortNewestFirst);
    const page = matching.slice(0, limit);
    const nextBefore = page.length ? page[page.length - 1].createdAt : '';
    const nextBeforeId = page.length ? page[page.length - 1].id : '';
    sendJson(res, 200, {
      replies: page.slice().sort(sortOldestFirst),
      pagination: {
        limit,
        hasMore: matching.length > page.length,
        nextBefore,
        nextBeforeId,
      },
    });
    return true;
  }

  if (req.method === 'POST' && replyMatch) {
    const message = findMessage(replyMatch[1]);
    if (!message) {
      sendError(res, 404, 'Message not found.');
      return true;
    }
    if (message.spaceType === 'dm' && !canUseDm(req, message.spaceId)) {
      sendError(res, 403, 'Conversation is not available.');
      return true;
    }
    const body = await readJson(req);
    const replyAsTask = Boolean(body.asTask);
	    const text = String(body.body || '').trim();
	    const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds.map(String) : [];
	    const mentions = extractMentions(text);
	    const author = messageAuthor(req, body);
	    const parentChannel = message.spaceType === 'channel' ? findChannel(message.spaceId) : null;
	    if (message.spaceType === 'channel' && !canWriteChannel(req, parentChannel, author)) {
	      sendError(res, 403, 'Join this channel before replying in the thread.');
	      return true;
	    }
	    const replyWorkspaceId = message.workspaceId || workspaceIdForSpace(message.spaceType, message.spaceId, req);
	    const referenceResult = normalizeIncomingReferencesForWrite(body.references, req, message.spaceType, message.spaceId, replyWorkspaceId);
	    if (referenceResult.error) {
	      sendError(res, 400, referenceResult.error);
	      return true;
	    }
	    const references = referenceResult.references;
	    if (!text && !attachmentIds.length && !references.length) {
	      sendError(res, 400, 'Reply body, attachment, or reference is required.');
	      return true;
	    }
	    const reply = normalizeConversationRecord({
	      id: makeId('rep'),
	      workspaceId: replyWorkspaceId,
	      parentMessageId: message.id,
	      spaceType: message.spaceType,
	      spaceId: message.spaceId,
      authorType: author.authorType,
      authorId: author.authorId,
      body: text,
      attachmentIds,
	      mentionedAgentIds: mentions.agents,
	      mentionedHumanIds: mentions.humans,
	      readBy: author.authorType === 'agent' ? [] : [author.authorId],
	      references,
	      metadata: references.length ? { references } : undefined,
	      createdAt: now(),
	      updatedAt: now(),
	    });
    applyMentions(reply, mentions);
    state.replies.push(reply);
    message.replyCount = Math.max(
      Number(message.replyCount || 0) + 1,
      state.replies.filter((item) => item.parentMessageId === message.id).length,
    );
    message.updatedAt = now();
    addCollabEvent('thread_reply', 'Thread reply added.', { messageId: message.id, replyId: reply.id });
    const linkedTask = findTaskForThreadMessage(message);
    let createdThreadTask = null;
    let createdThreadTaskMessage = null;
    let endedThreadTask = null;
    let stoppedThreadTask = null;
    let stopResult = null;
    let routeDecision = null;
    let threadChannelAgents = [];
    if (reply.authorType === 'human' && linkedTask && taskStopIntent(text)) {
      stopResult = stopTaskFromThread(linkedTask, reply.authorId, reply.id);
      stoppedThreadTask = linkedTask;
      addSystemReply(message.id, 'Task closed from thread stop request.');
    } else if (reply.authorType === 'human' && linkedTask && taskEndIntent(text)) {
      finishTaskFromThread(linkedTask, reply.authorId, reply.id);
      endedThreadTask = linkedTask;
      addSystemReply(message.id, 'Task marked done from thread request.');
    }
    if (reply.authorType === 'human' && replyAsTask && message.spaceType === 'channel') {
      const channel = findChannel(message.spaceId);
      const channelAgents = channel
        ? channelAgentIds(channel).map(id => findAgent(id)).filter(Boolean)
        : [];
      const selectedTaskAgentIds = taskCandidateIdsFromThread(message, reply, channelAgents, mentions, linkedTask);
      if (selectedTaskAgentIds.length && typeof createTaskMessage === 'function') {
        const threadTaskBody = [
          `Created from thread in ${message.spaceType}:${message.spaceId}.`,
          '',
          `Parent: ${message.body || ''}`,
          `Trigger: ${reply.body || ''}`,
        ].join('\n');
        const created = createTaskMessage({
          title: text || message.body || 'Thread task',
          body: threadTaskBody,
          workspaceId: replyWorkspaceId,
          spaceType: message.spaceType,
          spaceId: message.spaceId,
          authorType: reply.authorType,
          authorId: reply.authorId,
          assigneeIds: selectedTaskAgentIds,
          attachmentIds,
          sourceMessageId: message.id,
          sourceReplyId: reply.id,
        });
        createdThreadTask = created.task;
        createdThreadTaskMessage = created.message;
        await startTaskStartupCollaboration(created.task, created.message, selectedTaskAgentIds);
      }
    } else if (reply.authorType === 'human' && message.spaceType === 'channel' && taskCreationIntent(text)) {
      const channel = findChannel(message.spaceId);
      const channelAgents = channel
        ? channelAgentIds(channel).map(id => findAgent(id)).filter(Boolean)
        : [];
      const channelHumans = channel
        ? channelHumanIds(channel).map(id => findHuman(id)).filter(Boolean)
        : [];
      const naturalAgentIds = actorsNamedInText(channelAgents, text, textAddressesAgent).map((agent) => agent.id);
      const naturalHumanIds = actorsNamedInText(channelHumans, text, textReferencesActor)
        .map((human) => human.id)
        .filter((id) => id !== reply.authorId);
      const preferredAgentIds = [
        ...(mentions.agents || []),
        ...naturalAgentIds,
        ...(linkedTask?.claimedBy ? [linkedTask.claimedBy] : []),
        ...(linkedTask?.assigneeIds || []),
        ...(message.mentionedAgentIds || []),
      ];
      const agent = pickAvailableAgent(channelAgents, preferredAgentIds);
      if (agent) {
        const created = createTaskFromThreadIntent(message, reply, agent, {
          targetHumanIds: normalizeIds([...(mentions.humans || []), ...naturalHumanIds]),
        });
        createdThreadTask = created.task;
        createdThreadTaskMessage = created.message;
      }
    }
    await persistConversationState(reply, message.spaceType, message.spaceId, req);
    broadcastState();

    if (createdThreadTask && createdThreadTaskMessage && !createdThreadTask.metadata?.startupCollaboration) {
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
      threadChannelAgents = channelAgents;
      let respondingAgents = [];
      if (message.spaceType === 'channel') {
        routeDecision = await routeThreadReplyForChannel({
          channelAgents,
          mentions,
          parentMessage: message,
          reply,
          linkedTask,
          spaceId: message.spaceId,
        });
        respondingAgents = routeDecision.targetAgentIds
          .map((id) => channelAgents.find((agent) => agent.id === id))
          .filter(Boolean);
      }
      const peerMemorySearch = await buildPeerMemorySearchContext({
        text,
        message: reply,
        routeDecision,
        parentMessageId: message.id,
      });
      const deliveryContext = peerMemorySearch ? { peerMemorySearch } : {};
      if (message.spaceType === 'dm') {
        const dm = state.dms.find((item) => item.id === message.spaceId);
        const agentId = dm?.participantIds?.find((id) => id.startsWith('agt_'));
        const agent = agentId ? findAgent(agentId) : null;
        respondingAgents = agent && agentAvailableForAutoWork(agent) ? [agent] : [];
      }
      await scheduleMessageMemoryWritebacks({
        record: reply,
        text,
        spaceType: message.spaceType,
        spaceId: message.spaceId,
        respondingAgents,
        mentions,
        parentMessage: message,
      });
      for (const agent of respondingAgents) {
        deliverMessageToAgent(agent, message.spaceType, message.spaceId, reply, { parentMessageId: message.id, ...deliveryContext }).catch(err => {
          addSystemEvent('delivery_error', `Failed to deliver thread reply to ${agent.name}: ${err.message}`, { agentId: agent.id, replyId: reply.id, parentMessageId: message.id });
        });
      }
      scheduleFanoutSupplementDelivery({
        routeDecision,
        channelAgents: threadChannelAgents,
        message: reply,
        spaceType: message.spaceType,
        spaceId: message.spaceId,
        parentMessageId: message.id,
        alreadyDeliveredAgentIds: respondingAgents.map((agent) => agent.id),
        deliveryContext,
      });
    }

    if (routeDecision) {
      await persistConversationState(reply, message.spaceType, message.spaceId, req);
      broadcastState();
    }

    sendJson(res, 201, {
      reply,
      createdTask: createdThreadTask,
      createdTaskMessage: createdThreadTaskMessage,
      endedTask: endedThreadTask,
      stoppedTask: stoppedThreadTask,
      stopResult,
      route: publicRouteDecision(routeDecision),
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
    const userId = currentHumanId(req);
    message.savedBy = Array.isArray(message.savedBy) ? message.savedBy : [];
    if (message.savedBy.includes(userId)) {
      message.savedBy = message.savedBy.filter((id) => id !== userId);
    } else {
      message.savedBy.push(userId);
    }
    message.updatedAt = now();
    normalizeConversationRecord(message);
    console.info('[message] save toggled', {
      recordId: message.id,
      humanId: userId,
      saved: message.savedBy.includes(userId),
    });
    await persistConversationState(message, message.spaceType, message.spaceId, req);
    broadcastState();
    sendJson(res, 200, { message });
    return true;
  }

  const reactionMatch = url.pathname.match(/^\/api\/messages\/([^/]+)\/reactions$/);
  if (req.method === 'POST' && reactionMatch) {
    const message = findConversationRecord(reactionMatch[1]);
    if (!message) {
      sendError(res, 404, 'Message not found.');
      return true;
    }
    const body = await readJson(req);
    const option = reactionOptionFromInput(body);
    if (!option) {
      console.warn('[message] unsupported reaction rejected', {
        recordId: reactionMatch[1],
        reactionKey: body?.key || '',
        reactionEmoji: body?.emoji || '',
      });
      sendError(res, 400, 'Reaction is not supported.');
      return true;
    }
    const result = toggleRecordReaction(message, option, req);
    await persistConversationState(message, message.spaceType, message.spaceId, req);
    broadcastState();
    sendJson(res, 200, { message, reaction: result.reaction, active: result.active });
    return true;
  }

  const followMatch = url.pathname.match(/^\/api\/messages\/([^/]+)\/follow$/);
  if (req.method === 'POST' && followMatch) {
    const message = findConversationRecord(followMatch[1]);
    if (!message) {
      sendError(res, 404, 'Message not found.');
      return true;
    }
    const result = toggleThreadFollow(message, req);
    if (!result) {
      sendError(res, 404, 'Thread message not found.');
      return true;
    }
    await persistConversationState(result.root, result.root?.spaceType, result.root?.spaceId, req);
    broadcastState();
    sendJson(res, 200, { message: result.root, followed: result.active });
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
    await persistConversationState(message, message.spaceType, message.spaceId, req);
    broadcastState();
    sendJson(res, 201, { task });
    return true;
  }

  return false;
}
