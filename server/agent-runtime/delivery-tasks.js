const TASK_STATUS_VALUES = ['todo', 'in_progress', 'in_review', 'done', 'closed'];
const TASK_STATUS_ERROR = `Unsupported task status. Use one of: ${TASK_STATUS_VALUES.join(', ')}.`;

function compactLogText(value, limit = 120) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function deliveryContextLogSummary(agent, contextPack) {
  const participants = Array.isArray(contextPack?.participants) ? contextPack.participants : [];
  const target = participants.find((item) => item.id === agent?.id) || {};
  return {
    space: contextPack?.space ? `${contextPack.space.type}:${contextPack.space.id}` : null,
    spaceName: contextPack?.space?.label || contextPack?.space?.name || null,
    targetAgent: {
      id: agent?.id || null,
      name: agent?.name || null,
      runtime: agent?.runtime || target.runtime || null,
      description: compactLogText(agent?.description || target.description || ''),
    },
    participants: participants.map((item) => ({
      id: item.id,
      name: item.name,
      type: item.type,
      runtime: item.runtime || null,
      status: item.status || null,
      description: compactLogText(item.description || item.role || ''),
    })),
    recentMessages: Array.isArray(contextPack?.recentMessages) ? contextPack.recentMessages.length : 0,
    threadReplies: Array.isArray(contextPack?.thread?.recentReplies) ? contextPack.thread.recentReplies.length : 0,
    tasks: Array.isArray(contextPack?.tasks) ? contextPack.tasks.length : 0,
    peerMemoryRequired: Boolean(contextPack?.peerMemorySearch?.required),
    peerMemoryResults: Array.isArray(contextPack?.peerMemorySearch?.results) ? contextPack.peerMemorySearch.results.length : 0,
  };
}

async function deliverMessageToAgent(agent, spaceType, spaceId, message, options = {}) {
  const parentMessageId = options.parentMessageId || message.parentMessageId || (shouldStartThreadForAgentDelivery(message) ? message.id : null);
  const suppressTaskContext = options.suppressTaskContext === true || message.suppressTaskContext === true;
  const workItem = createWorkItemForDelivery(agent, message, { spaceType, spaceId, parentMessageId, suppressTaskContext });
  const runtimeOverride = getAgentRuntime(agent) === 'codex'
    ? codexRuntimeOverrideForDelivery(message, workItem)
    : null;
  const routedMessage = {
    ...message,
    target: workItem.target,
    workItemId: workItem.id,
    taskId: suppressTaskContext ? null : (message.taskId || workItem.taskId || null),
  };
  const contextPack = buildAgentContextPack({
    state,
    agentId: agent.id,
    spaceType,
    spaceId,
    currentMessage: routedMessage,
    parentMessageId,
    workItem,
    peerMemorySearch: options.peerMemorySearch || null,
    toolBaseUrl: `http://${HOST}:${PORT}`,
    limits: options.contextLimits || {},
  });
  const deliveryMessage = {
    ...routedMessage,
    spaceType,
    spaceId,
    agentRelayDepth: Number(message.agentRelayDepth || 0),
    contextPack,
    ...(runtimeOverride ? { runtimeOverride } : {}),
    ...(parentMessageId ? { parentMessageId } : {}),
  };
  console.info('[agent-delivery] context_pack', JSON.stringify({
    messageId: message.id || null,
    workItemId: workItem.id,
    parentMessageId,
    cloudRelay: Boolean(cloudRelay?.agentShouldUseRelay?.(agent)),
    ...deliveryContextLogSummary(agent, contextPack),
  }));
  if (cloudRelay?.agentShouldUseRelay?.(agent)) {
    await cloudRelay.deliverToAgent(agent, deliveryMessage, workItem);
    return;
  }
  if (runtimeOverride) {
    addSystemEvent('agent_fast_chat_runtime', `${agent.name} using low-latency chat runtime.`, {
      agentId: agent.id,
      messageId: message.id,
      parentMessageId,
      workItemId: workItem.id,
      model: runtimeOverride.model || null,
      reasoningEffort: runtimeOverride.reasoningEffort,
      reason: runtimeOverride.reason,
    });
  }
  // Check if agent has a running process
  const proc = agentProcesses.get(agent.id);

  if (proc && getAgentRuntime(agent) === 'codex') {
    const codexProcessAliveOrBooting = !proc.child || !proc.child.killed;
    if (codexProcessAliveOrBooting && (proc.status === 'running' || proc.status === 'starting')) {
      queueCodexBusyDelivery(agent, proc, deliveryMessage);
      await persistState();
      broadcastState();
      return;
    }
    if (proc.child && !proc.child.killed && proc.status === 'idle' && proc.threadId) {
      applyAgentProcessDeliveryScope(proc, spaceType, spaceId, parentMessageId);
      if (await sendCodexAppServerMessages(agent, proc, [deliveryMessage], { mode: 'turn' })) {
        await persistState();
        broadcastState();
        return;
      }
    }
  } else if (proc && (proc.status === 'running' || proc.status === 'starting')) {
    // Non-Codex runtimes still queue until their one-shot process exits.
    proc.inbox.push(deliveryMessage);
    if (!proc.parentMessageId && parentMessageId) proc.parentMessageId = parentMessageId;
    addSystemEvent('message_queued', `Message queued for busy agent ${agent.name}`, { agentId: agent.id, messageId: message.id, parentMessageId });
    await persistState();
    broadcastState();
    return;
  }

  // Start the agent process with this message
  await startAgentProcess(agent, spaceType, spaceId, deliveryMessage);
}

function workspaceIdForSpace(spaceType, spaceId) {
  const target = spaceType === 'channel'
    ? state.channels?.find((channel) => channel.id === spaceId)
    : state.dms?.find((dm) => dm.id === spaceId);
  return target?.workspaceId || state.connection?.workspaceId || state.cloud?.workspace?.id || 'local';
}

function createTaskFromMessage(message, title, options = {}) {
  if (message.taskId) {
    const existing = findTask(message.taskId);
    if (existing) return existing;
  }
  const assigneeIds = normalizeIds(options.assigneeIds?.length ? options.assigneeIds : (message.mentionedAgentIds || []));
  const createdBy = String(options.createdBy || message.authorId || 'hum_local');

  const task = {
    id: makeId('task'),
    number: nextTaskNumber(message.spaceType, message.spaceId),
    title: String(title || message.body || 'Untitled task').trim().slice(0, 180),
    body: String(options.body ?? message.body ?? '').trim(),
    workspaceId: message.workspaceId || options.workspaceId || workspaceIdForSpace(message.spaceType, message.spaceId),
    status: String(options.status || 'todo'),
    spaceType: message.spaceType,
    spaceId: message.spaceId,
    messageId: message.id,
    threadMessageId: message.id,
    sourceMessageId: options.sourceMessageId ? String(options.sourceMessageId) : message.id,
    sourceReplyId: options.sourceReplyId ? String(options.sourceReplyId) : null,
    assigneeId: assigneeIds[0] || null,
    assigneeIds,
    claimedBy: null,
    claimedAt: null,
    reviewRequestedAt: null,
    completedAt: null,
    closedAt: null,
    endIntentAt: null,
    runIds: [],
    attachmentIds: Array.isArray(message.attachmentIds) ? message.attachmentIds : [],
    localReferences: Array.isArray(options.localReferences) ? options.localReferences : (Array.isArray(message.localReferences) ? message.localReferences : []),
    createdBy,
    createdAt: now(),
    updatedAt: now(),
    history: [],
  };
  addTaskHistory(task, 'created', `Task ${taskLabel(task)} created from message.`);
  state.tasks.unshift(task);
  message.taskId = task.id;
  addTaskTimelineMessage(task, `📋 1 new task created: ${taskLabel(task)} ${task.title}`, 'task_created');
  addCollabEvent('task_created', `Task created: ${task.title}`, { taskId: task.id, messageId: message.id, number: task.number });
  return task;
}

function createTaskMessage({ title, body = '', spaceType, spaceId, workspaceId = null, authorType = 'human', authorId = 'hum_local', assigneeIds = [], mentionedHumanIds = [], attachmentIds = [], sourceMessageId = null, sourceReplyId = null, status = 'todo' }) {
  const taskTitle = String(title || '').trim().slice(0, 180);
  if (!taskTitle) throw httpError(400, 'Task title is required.');
  const taskWorkspaceId = workspaceId || workspaceIdForSpace(spaceType, spaceId);
  const message = normalizeConversationRecord({
    id: makeId('msg'),
    workspaceId: taskWorkspaceId,
    spaceType,
    spaceId,
    authorType,
    authorId,
    body: taskTitle,
    attachmentIds: normalizeIds(attachmentIds),
    mentionedAgentIds: normalizeIds(assigneeIds),
    mentionedHumanIds: normalizeIds(mentionedHumanIds),
    readBy: authorType === 'human' ? ['hum_local'] : [],
    replyCount: 0,
    savedBy: [],
    createdAt: now(),
    updatedAt: now(),
  });
  state.messages.push(message);
  const task = createTaskFromMessage(message, taskTitle, {
    body,
    status,
    workspaceId: taskWorkspaceId,
    assigneeIds,
    sourceMessageId: sourceMessageId || message.id,
    sourceReplyId,
    createdBy: authorId,
    localReferences: extractLocalReferences(body || taskTitle),
  });
  message.taskId = task.id;
  return { message, task };
}

function claimTask(task, actorId, options = {}) {
  if (!task) throw httpError(404, 'Task not found.');
  if (taskIsClosed(task)) throw httpError(409, 'Closed task cannot be claimed.');
  const claimant = String(actorId || 'agt_codex');
  if (task.claimedBy && task.claimedBy !== claimant && !options.force) {
    throw httpError(409, `Task is already claimed by ${task.claimedBy}.`);
  }
  if (task.claimedBy === claimant && task.status === 'in_progress') {
    return task;
  }
  task.claimedBy = claimant;
  task.assigneeId = claimant;
  task.assigneeIds = normalizeIds([...(task.assigneeIds || []), claimant]);
  task.claimedAt = task.claimedAt || now();
  task.status = 'in_progress';
  task.updatedAt = now();
  addTaskHistory(task, 'claimed', `Claimed by ${displayActor(claimant)}.`, claimant);
  const thread = ensureTaskThread(task);
  addSystemReply(thread.id, `Task claimed by ${displayActor(claimant)}.`);
  addTaskTimelineMessage(task, `📌 ${displayActor(claimant)} claimed ${taskLabel(task)}`, 'task_claimed');
  addCollabEvent('task_claimed', `Task claimed: ${task.title}`, { taskId: task.id, actorId: claimant, number: task.number });
  const claimantAgent = findAgent(claimant);
  if (claimantAgent) scheduleAgentMemoryWriteback(claimantAgent, 'task_claimed', { task });
  return task;
}

function findTaskForAgentTool(body, space = null) {
  const taskId = String(body.taskId || body.task_id || '').trim();
  if (taskId) {
    const exact = findTask(taskId) || state.tasks.find((task) => task.id.startsWith(taskId));
    if (exact) return exact;
    throw httpError(404, `Task not found: ${taskId}`);
  }
  const taskNumber = body.taskNumber ?? body.task_number ?? body.number;
  if (taskNumber !== undefined && taskNumber !== null && taskNumber !== '') {
    const scoped = space || resolveConversationSpace(body);
    const task = state.tasks.find((item) => (
      item.spaceType === scoped.spaceType
      && item.spaceId === scoped.spaceId
      && Number(item.number) === Number(taskNumber)
    ));
    if (task) return task;
    throw httpError(404, `Task not found: #${taskNumber}`);
  }
  const messageId = String(body.messageId || body.message_id || '').trim();
  if (messageId) {
    const message = findMessage(messageId) || state.messages.find((item) => item.id.startsWith(messageId));
    const task = findTaskForThreadMessage(message);
    if (task) return task;
    throw httpError(404, `Task not found for message: ${messageId}`);
  }
  throw httpError(400, 'taskId, taskNumber, or messageId is required.');
}

function updateTaskForAgent(task, agent, nextStatus, options = {}) {
  const status = String(nextStatus || '').trim();
  if (!TASK_STATUS_VALUES.includes(status)) {
    throw httpError(400, TASK_STATUS_ERROR);
  }
  if (task.claimedBy && task.claimedBy !== agent.id && !options.force) {
    throw httpError(409, `Task is already claimed by ${task.claimedBy}.`);
  }
  if (!task.claimedBy && !options.force) {
    throw httpError(409, 'Task must be claimed before agent status updates.');
  }
  if (!task.claimedBy) {
    task.claimedBy = agent.id;
    task.claimedAt = now();
    task.assigneeId = agent.id;
    task.assigneeIds = normalizeIds([...(task.assigneeIds || []), agent.id]);
  }
  const previousStatus = task.status;
  if (previousStatus === status) {
    return task;
  }
  task.status = status;
  task.updatedAt = now();
  if (status === 'in_progress') {
    task.reviewRequestedAt = null;
    task.completedAt = null;
    task.closedAt = null;
    addTaskHistory(task, 'agent_in_progress', 'Agent moved task to In Progress.', agent.id);
    addSystemReply(ensureTaskThread(task).id, `${agent.name} moved this task to In Progress.`);
    addTaskTimelineMessage(task, `📌 ${displayActor(agent.id)} moved ${taskLabel(task)} to In Progress`, 'task_claimed');
  } else if (status === 'in_review') {
    task.reviewRequestedAt = task.reviewRequestedAt || now();
    task.completedAt = null;
    task.closedAt = null;
    addTaskHistory(task, 'agent_review_requested', 'Agent requested review.', agent.id);
    addSystemReply(ensureTaskThread(task).id, `${agent.name} requested review.`);
    addTaskTimelineMessage(task, `👀 ${displayActor(agent.id)} moved ${taskLabel(task)} to In Review`, 'task_review');
    scheduleAgentMemoryWriteback(agent, 'task_in_review', { task });
  } else if (status === 'done') {
    task.completedAt = task.completedAt || now();
    task.closedAt = null;
    addTaskHistory(task, 'agent_done', 'Agent marked task done.', agent.id);
    addSystemReply(ensureTaskThread(task).id, `${agent.name} marked this task done.`);
    addTaskTimelineMessage(task, `✅ ${displayActor(agent.id)} moved ${taskLabel(task)} to Done`, 'task_done');
    scheduleAgentMemoryWriteback(agent, 'task_done', { task });
  } else if (status === 'closed') {
    task.closedAt = task.closedAt || now();
    task.reviewRequestedAt = null;
    addTaskHistory(task, 'agent_closed', 'Agent closed the task.', agent.id);
    addSystemReply(ensureTaskThread(task).id, `${agent.name} closed this task.`);
    addTaskTimelineMessage(task, `× ${displayActor(agent.id)} moved ${taskLabel(task)} to Closed`, 'task_closed');
    scheduleAgentMemoryWriteback(agent, 'task_closed', { task });
  } else if (status === 'todo') {
    task.reviewRequestedAt = null;
    task.completedAt = null;
    task.closedAt = null;
    addTaskHistory(task, 'agent_todo', 'Agent moved task back to Todo.', agent.id);
    addSystemReply(ensureTaskThread(task).id, `${agent.name} moved this task back to Todo.`);
  }
  addCollabEvent('agent_task_updated', `${agent.name} moved ${taskLabel(task)} from ${previousStatus || 'unknown'} to ${status}`, {
    agentId: agent.id,
    taskId: task.id,
    previousStatus,
    status,
  });
  return task;
}
