let pendingStateUpdate = null;
let pendingStateUpdateFrame = null;

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
