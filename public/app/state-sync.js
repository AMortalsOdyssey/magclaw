let pendingStateUpdate = null;
let pendingStateUpdateFrame = null;

const BOOTSTRAP_AGENT_TUPLE_FIELDS = [
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
];
const BOOTSTRAP_HUMAN_TUPLE_FIELDS = [
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
];
const BOOTSTRAP_CLOUD_MEMBER_TUPLE_FIELDS = [
  'id',
  'userId',
  'humanId',
  'user',
  'role',
];

function tupleValueIsUseful(value) {
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value) && value.length === 0) return false;
  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) return false;
  return true;
}

function tupleRecordToObject(entry, fields = []) {
  if (!Array.isArray(entry)) return entry && typeof entry === 'object' ? entry : {};
  const record = {};
  fields.forEach((field, index) => {
    const value = entry[index];
    if (tupleValueIsUseful(value)) record[field] = value;
  });
  const extra = entry[fields.length];
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    Object.assign(record, extra);
  }
  return record;
}

function normalizeStateDirectorySnapshot(stateSnapshot = {}) {
  if (!stateSnapshot || typeof stateSnapshot !== 'object') return stateSnapshot;
  const hasTupleDirectories = stateSnapshot?.bootstrap?.directoryFormat === 'tuple-v1'
    || (Array.isArray(stateSnapshot?.agents) && stateSnapshot.agents.some(Array.isArray))
    || (Array.isArray(stateSnapshot?.humans) && stateSnapshot.humans.some(Array.isArray))
    || (Array.isArray(stateSnapshot?.cloud?.members) && stateSnapshot.cloud.members.some(Array.isArray));
  if (!hasTupleDirectories) return stateSnapshot;
  const next = { ...stateSnapshot };
  if (Array.isArray(stateSnapshot.agents)) {
    next.agents = stateSnapshot.agents.map((agent) => tupleRecordToObject(agent, BOOTSTRAP_AGENT_TUPLE_FIELDS));
  }
  if (Array.isArray(stateSnapshot.humans)) {
    next.humans = stateSnapshot.humans.map((human) => tupleRecordToObject(human, BOOTSTRAP_HUMAN_TUPLE_FIELDS));
  }
  if (stateSnapshot.cloud && typeof stateSnapshot.cloud === 'object' && Array.isArray(stateSnapshot.cloud.members)) {
    next.cloud = {
      ...stateSnapshot.cloud,
      members: stateSnapshot.cloud.members.map((member) => tupleRecordToObject(member, BOOTSTRAP_CLOUD_MEMBER_TUPLE_FIELDS)),
    };
  }
  return next;
}

function pendingStateUpdateBase() {
  return pendingStateUpdate || appState;
}

function clearPendingStateUpdate() {
  pendingStateUpdate = null;
  if (pendingStateUpdateFrame) {
    if (typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(pendingStateUpdateFrame);
    }
    pendingStateUpdateFrame = null;
  }
}

function flushPendingStateUpdate() {
  const nextState = pendingStateUpdate;
  pendingStateUpdate = null;
  pendingStateUpdateFrame = null;
  if (nextState && typeof applyStateUpdate === 'function') applyStateUpdate(nextState);
}

function queueStateUpdate(nextState, { immediate = false } = {}) {
  if (!nextState) return false;
  nextState = normalizeStateDirectorySnapshot(nextState);
  if (immediate) {
    clearPendingStateUpdate();
    if (typeof applyStateUpdate === 'function') applyStateUpdate(nextState);
    return true;
  }
  pendingStateUpdate = nextState;
  if (!pendingStateUpdateFrame) {
    pendingStateUpdateFrame = window.requestAnimationFrame(flushPendingStateUpdate);
  }
  return true;
}

function stateRecordArray(records) {
  return Array.isArray(records) ? records : [];
}

function normalizeConversationStateSnapshot(stateSnapshot = {}) {
  stateSnapshot = normalizeStateDirectorySnapshot(stateSnapshot);
  return {
    ...stateSnapshot,
    messages: [...stateRecordArray(stateSnapshot?.messages)],
    replies: [...stateRecordArray(stateSnapshot?.replies)],
    tasks: [...stateRecordArray(stateSnapshot?.tasks)],
  };
}

function sortConversationRecords(records = []) {
  return [...records].sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
}

function upsertConversationRecord(records = [], record = null) {
  if (!record?.id) return records || [];
  const next = [...(records || [])];
  const index = next.findIndex((item) => item?.id === record.id);
  if (index >= 0) {
    next[index] = { ...next[index], ...record };
    return sortConversationRecords(next);
  }
  next.push(record);
  return sortConversationRecords(next);
}

function upsertStateRecord(records = [], record = null) {
  if (!record?.id) return records || [];
  const next = [...(records || [])];
  const index = next.findIndex((item) => item?.id === record.id);
  if (index >= 0) {
    next[index] = { ...next[index], ...record };
  } else {
    next.unshift(record);
  }
  return next;
}

function mergeSubmittedReplyParent(messages = [], reply = null, replyWasPresent = false) {
  if (!reply?.parentMessageId || replyWasPresent) return messages;
  return (messages || []).map((message) => {
    if (message?.id !== reply.parentMessageId) return message;
    return {
      ...message,
      replyCount: Number(message.replyCount || 0) + 1,
      updatedAt: reply.createdAt || reply.updatedAt || message.updatedAt,
    };
  });
}

function dropOptimisticConversationRecord(stateSnapshot, removeOptimisticId = '') {
  const id = String(removeOptimisticId || '');
  if (!stateSnapshot || !id) return stateSnapshot;
  const optimisticMessage = (stateSnapshot.messages || []).find((record) => record.id === id && record.optimistic === true);
  const optimisticReply = (stateSnapshot.replies || []).find((record) => record.id === id && record.optimistic === true);
  if (!optimisticMessage && !optimisticReply) return stateSnapshot;
  let messages = (stateSnapshot.messages || []).filter((record) => !(record.id === id && record.optimistic === true));
  const replies = (stateSnapshot.replies || []).filter((record) => !(record.id === id && record.optimistic === true));
  if (optimisticReply?.parentMessageId) {
    messages = messages.map((message) => (
      message?.id === optimisticReply.parentMessageId
        ? { ...message, replyCount: Math.max(0, Number(message.replyCount || 0) - 1) }
        : message
    ));
  }
  return { ...stateSnapshot, messages, replies };
}

function applySubmittedConversationResult(result = {}) {
  if (!appState || typeof applyStateUpdate !== 'function') return false;
  const options = arguments[1] || {};
  const removeOptimisticId = String(options.removeOptimisticId || '');
  let changed = Boolean(removeOptimisticId);
  let nextState = normalizeConversationStateSnapshot(appState);
  if (removeOptimisticId) {
    nextState = normalizeConversationStateSnapshot(dropOptimisticConversationRecord(nextState, removeOptimisticId));
  }
  const taskRecords = [
    result.task,
    result.createdTask,
    result.endedTask,
    result.stoppedTask,
  ].filter(Boolean);

  for (const task of taskRecords) {
    nextState.tasks = upsertStateRecord(nextState.tasks, task);
    if (task.messageId) {
      nextState.messages = nextState.messages.map((message) => (
        message?.id === task.messageId
          ? { ...message, taskId: task.id, updatedAt: task.updatedAt || message.updatedAt }
          : message
      ));
    }
    changed = true;
  }
  if (result.message) {
    nextState.messages = upsertConversationRecord(nextState.messages, result.message);
    changed = true;
  }
  if (result.createdTaskMessage) {
    nextState.messages = upsertConversationRecord(nextState.messages, result.createdTaskMessage);
    changed = true;
  }
  if (result.reply) {
    const replies = stateRecordArray(nextState.replies);
    const replyWasPresent = replies.some((item) => item?.id === result.reply.id);
    nextState.replies = upsertConversationRecord(replies, result.reply);
    nextState.messages = mergeSubmittedReplyParent(nextState.messages, result.reply, replyWasPresent);
    changed = true;
  }
  if (!changed) return false;
  applyStateUpdate(nextState);
  return true;
}
