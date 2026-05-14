import {
  extractMentionTokens,
  escapeRegExp,
  isMentionBoundaryChar,
  mentionTokenForId,
  normalizeIds,
} from './mentions.js';
import { findWorkspaceAllChannel } from './workspace-defaults.js';

// Conversation model helpers.
// This module keeps lookup, mention rendering, scope matching, and task-thread
// bookkeeping in one place so route/runtime modules can ask domain questions
// without reading the whole HTTP entrypoint.
export function createConversationModel(deps) {
  const {
    getState,
    httpError,
    makeId,
    now,
    extractLocalReferences,
    projectReferenceFromParts,
  } = deps;
  const state = new Proxy({}, {
    get(_target, prop) {
      return getState()[prop];
    },
    set(_target, prop, value) {
      getState()[prop] = value;
      return true;
    },
  });

  function findMission(id) {
    return state.missions.find((mission) => mission.id === id);
  }
  
  function findRun(id) {
    return state.runs.find((run) => run.id === id);
  }
  
  function findChannel(id) {
    return state.channels.find((channel) => channel.id === id);
  }

  function defaultWorkspaceId() {
    return String(state.connection?.workspaceId || state.cloud?.workspace?.id || 'local').trim() || 'local';
  }

  function requestedWorkspaceId(options = {}) {
    return String(options?.workspaceId || '').trim();
  }

  function effectiveWorkspaceId(options = {}) {
    return requestedWorkspaceId(options) || defaultWorkspaceId();
  }

  function recordWorkspaceId(record) {
    return String(record?.workspaceId || '').trim();
  }

  function recordBelongsToWorkspace(record, workspaceId) {
    const target = String(workspaceId || '').trim();
    if (!target) return true;
    const value = recordWorkspaceId(record);
    return !value || value === target;
  }

  function messageBelongsToWorkspace(message, workspaceId) {
    if (recordBelongsToWorkspace(message, workspaceId) && recordWorkspaceId(message)) return true;
    if (recordWorkspaceId(message)) return false;
    if (message?.spaceType === 'channel') return recordBelongsToWorkspace(findChannel(message.spaceId), workspaceId);
    if (message?.spaceType === 'dm') return recordBelongsToWorkspace(state.dms?.find((dm) => dm.id === message.spaceId), workspaceId);
    return true;
  }
  
  function selectedDefaultSpaceId(spaceType) {
    if (spaceType === 'dm') return state.dms?.[0]?.id || '';
    const workspaceId = defaultWorkspaceId();
    return findWorkspaceAllChannel(state, workspaceId)?.id || state.channels?.[0]?.id || 'chan_all';
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
  
  function findChannelByRef(ref, options = {}) {
    const raw = String(ref || '').trim().replace(/^#/, '');
    if (!raw) return null;
    const workspaceId = effectiveWorkspaceId(options);
    if (raw === 'all' || raw === 'chan_all') {
      return findWorkspaceAllChannel(state, workspaceId)
        || state.channels.find((channel) => channel.id === 'chan_all' && recordBelongsToWorkspace(channel, workspaceId))
        || null;
    }
    const matches = state.channels.filter((channel) => (
      channel.id === raw
      || channel.name === raw
      || channel.id.startsWith(raw)
      || channel.name.startsWith(raw)
    ));
    return matches.find((channel) => recordBelongsToWorkspace(channel, workspaceId)) || null;
  }
  
  function findDmByRef(ref, options = {}) {
    const raw = String(ref || '').trim().replace(/^dm:/, '');
    if (!raw) return null;
    const workspaceId = effectiveWorkspaceId(options);
    const matches = state.dms.filter((dm) => dm.id === raw || dm.id.startsWith(raw) || dm.name === raw);
    return matches.find((dm) => recordBelongsToWorkspace(dm, workspaceId)) || null;
  }
  
  function findMessageByRef(ref, options = {}) {
    const raw = String(ref || '').trim();
    if (!raw) return null;
    const workspaceId = effectiveWorkspaceId(options);
    return state.messages.find((message) => (
      message.id === raw
      || message.id.startsWith(raw)
    ) && messageBelongsToWorkspace(message, workspaceId)) || null;
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
  
  function resolveMessageTarget(target, options = {}) {
    const raw = String(target || '').trim();
    if (!raw) throw httpError(400, 'Target is required.');
    const workspaceId = effectiveWorkspaceId(options);
    if (raw.startsWith('#')) {
      const withoutHash = raw.slice(1);
      const separator = withoutHash.indexOf(':');
      const channelRef = separator >= 0 ? withoutHash.slice(0, separator) : withoutHash;
      const parentRef = separator >= 0 ? withoutHash.slice(separator + 1) : '';
      const channel = findChannelByRef(channelRef, { ...options, workspaceId });
      if (!channel) throw httpError(404, `Channel not found: #${channelRef}`);
      let parentMessageId = null;
      if (parentRef) {
        const parent = findMessageByRef(parentRef, { ...options, workspaceId: recordWorkspaceId(channel) || workspaceId });
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
      const dm = findDmByRef(dmRef, { ...options, workspaceId });
      if (!dm) throw httpError(404, `DM not found: ${dmRef}`);
      let parentMessageId = null;
      if (parentRef) {
        const parent = findMessageByRef(parentRef, { ...options, workspaceId: recordWorkspaceId(dm) || workspaceId });
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
  
  function workspaceHumans() {
    const humans = new Map((state.humans || []).map((human) => [human.id, human]));
    const usersById = new Map((state.cloud?.users || []).map((user) => [user.id, user]));
    for (const member of state.cloud?.workspaceMembers || []) {
      if ((member.status || 'active') !== 'active') continue;
      if (!member.humanId || humans.has(member.humanId)) continue;
      const user = usersById.get(member.userId) || {};
      humans.set(member.humanId, {
        id: member.humanId,
        name: user.name || user.email?.split('@')[0] || member.humanId.replace(/^hum_/, ''),
        email: user.email || '',
        role: member.role || 'member',
        status: 'offline',
      });
    }
    return [...humans.values()];
  }

  function findHuman(id) {
    return workspaceHumans().find((human) => human.id === id);
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
      const agentStatus = String(agent?.status || '').toLowerCase();
      if (agent?.deletedAt || agent?.archivedAt || agentStatus === 'deleted' || agentStatus === 'disabled') continue;
      entries.push([visibleMentionLabel(agent), agent.id]);
    }
    for (const human of workspaceHumans()) {
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
  
  function extractMentions(text) {
    return extractMentionTokens(text, { findAgent, findHuman });
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
  
  function resolveConversationSpace(input = {}, options = {}) {
    const scopedOptions = { ...options, workspaceId: requestedWorkspaceId(options) || requestedWorkspaceId(input) || '' };
    if (input.target) {
      const target = resolveMessageTarget(input.target, scopedOptions);
      return { spaceType: target.spaceType, spaceId: target.spaceId, label: spaceDisplayName(target.spaceType, target.spaceId) };
    }
    const rawChannel = String(input.channel || '').trim();
    if (rawChannel) {
      if (rawChannel.startsWith('#')) {
        const name = rawChannel.slice(1);
        const channel = findChannelByRef(name, scopedOptions);
        if (!channel) throw httpError(404, `Channel not found: ${rawChannel}`);
        return { spaceType: 'channel', spaceId: channel.id, label: `#${channel.name}` };
      }
      if (rawChannel.toLowerCase().startsWith('dm:')) {
        const dmRef = rawChannel.slice(3);
        const dm = findDmByRef(dmRef, scopedOptions);
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
  
  function workItemIsStopped(workItemId) {
    return Boolean(workItemId && findWorkItem(workItemId)?.status === 'stopped');
  }
  
  function turnMetaHasStoppedWork(turnMeta) {
    return normalizeIds(turnMeta?.workItemIds || []).some(workItemIsStopped);
  }
  
  function turnMetaAllWorkStopped(turnMeta) {
    const ids = normalizeIds(turnMeta?.workItemIds || []);
    return ids.length > 0 && ids.every(workItemIsStopped);
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
    return ['done', 'closed'].includes(task?.status);
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
      workspaceId: task.workspaceId || state.connection?.workspaceId || 'local',
      eventType: eventType || 'task_event',
      taskId: task.id,
    });
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

  return {
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
    turnMetaAllWorkStopped,
    turnMetaHasStoppedWork,
    turnMetaHasWorkOutsideScope,
    turnMetaMatchesScope,
    turnMetaMatchesTask,
    visibleMentionLabel,
    workItemIsStopped,
    workItemMatchesScope,
    workItemMatchesTask,
  };
}
