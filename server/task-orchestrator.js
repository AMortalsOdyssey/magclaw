import { agentResponseIntent } from './intents.js';
import { normalizeIds } from './mentions.js';

// Task/thread orchestration helpers.
// These functions bridge chat threads and durable tasks: creating linked task
// messages, stopping/finishing from thread intent, and ensuring every task has
// a top-level conversation thread.
export function createTaskOrchestrator(deps) {
  const {
    addCollabEvent,
    addTaskHistory,
    addTaskTimelineMessage,
    stopWorkItemsForTask,
    claimTask,
    cleanTaskTitle,
    createTaskFromMessage,
    createTaskMessage,
    displayActor,
    findMessage,
    getState,
    makeId,
    normalizeConversationRecord,
    now,
    renderMentionsForAgent,
    spaceDisplayName,
    steerAgentProcessesForTaskStop,
    stopRunsForTask,
    taskIsClosed,
    taskLabel,
  } = deps;
  const state = new Proxy({}, {
    get(_target, prop) { return getState()[prop]; },
    set(_target, prop, value) { getState()[prop] = value; return true; },
  });

  function titleFromThreadTaskIntent(parent, reply) {
    const replyTitle = cleanTaskTitle(reply?.body || '', '');
    if (replyTitle) return replyTitle;
    return cleanTaskTitle(parent?.body || '', 'Thread follow-up task');
  }
  
  function createOrClaimTaskForMessage(message, agent, options = {}) {
    if (!message || !agent) return null;
    const task = createTaskFromMessage(message, options.title || message.body, {
      assigneeIds: [agent.id],
      createdBy: options.createdBy || message.authorId,
    });
    if (!task.claimedBy) claimTask(task, agent.id, { force: false });
    return task;
  }
  
  function createTaskFromThreadIntent(parent, reply, agent, options = {}) {
    const title = titleFromThreadTaskIntent(parent, reply);
    const targetHumanIds = normalizeIds(options.targetHumanIds || []);
    const targetHumans = targetHumanIds
      .map((id) => displayActor(id))
      .filter(Boolean);
    const body = [
      `Created from thread in ${spaceDisplayName(parent.spaceType, parent.spaceId)}.`,
      targetHumans.length ? `Human target(s): ${targetHumans.join(', ')}.` : '',
      '',
      `Parent: ${renderMentionsForAgent(parent.body || '')}`,
      `Trigger: ${renderMentionsForAgent(reply.body || '')}`,
    ].join('\n');
    const result = createTaskMessage({
      title,
      body,
      workspaceId: parent.workspaceId || reply.workspaceId || state.connection?.workspaceId || 'local',
      spaceType: parent.spaceType,
      spaceId: parent.spaceId,
      authorType: 'agent',
      authorId: agent.id,
      assigneeIds: [agent.id],
      mentionedHumanIds: targetHumanIds,
      sourceMessageId: parent.id,
      sourceReplyId: reply.id,
    });
    claimTask(result.task, agent.id, { force: true });
    const ack = normalizeConversationRecord({
      id: makeId('rep'),
      workspaceId: parent.workspaceId || reply.workspaceId || result.task.workspaceId || state.connection?.workspaceId || 'local',
      parentMessageId: parent.id,
      spaceType: parent.spaceType,
      spaceId: parent.spaceId,
      authorType: 'agent',
      authorId: agent.id,
      body: `已把这个工作整理成 ${taskLabel(result.task)}：${result.task.title}。我会在新的 task thread 里继续推进。`,
      attachmentIds: [],
      createdAt: now(),
      updatedAt: now(),
    });
    state.replies.push(ack);
    parent.replyCount = Math.max(
      Number(parent.replyCount || 0) + 1,
      state.replies.filter((item) => item.parentMessageId === parent.id).length,
    );
    parent.updatedAt = now();
    addCollabEvent('thread_task_created', `${agent.name} created ${taskLabel(result.task)} from a thread reply.`, {
      agentId: agent.id,
      taskId: result.task.id,
      sourceMessageId: parent.id,
      sourceReplyId: reply.id,
    });
    return { ...result, ackReply: ack };
  }
  
  function taskThreadDeliveryMessage(task, message, triggerReply, agent) {
    const trigger = renderMentionsForAgent(triggerReply?.body || '').trim();
    const details = String(task?.body || '').trim();
    const body = [
      `Task ${taskLabel(task)} is ready in this task thread.`,
      `Title: ${task?.title || message?.body || 'Untitled task'}`,
      details ? `Context:\n${details}` : '',
      trigger ? `Trigger reply:\n${trigger}` : '',
      'You are taking the first pass here. Reply naturally with findings, missing context, or results, and move the task to in_review when ready for human validation.',
    ].filter(Boolean).join('\n\n');
    return {
      ...message,
      authorType: triggerReply?.authorType || 'human',
      authorId: triggerReply?.authorId || 'hum_local',
      body,
      mentionedAgentIds: normalizeIds([...(message?.mentionedAgentIds || []), agent?.id]),
      taskId: task?.id || message?.taskId || null,
    };
  }

  function taskAgentName(agent) {
    return agent?.name ? `@${agent.name}` : (agent?.id || 'unknown agent');
  }

  function taskAssignmentDeliveryMessage(task, message, {
    recipientAgent = null,
    role = 'owner',
    ownerAgent = null,
    collaboratorAgents = [],
  } = {}) {
    const isOwner = role === 'owner';
    const details = String(task?.body || '').trim();
    const collaborators = normalizeIds((collaboratorAgents || []).map((agent) => agent?.id))
      .map((id) => (collaboratorAgents || []).find((agent) => agent?.id === id))
      .filter(Boolean);
    const collaboratorNames = collaborators.map(taskAgentName).join(', ') || 'none';
    const threadId = task?.threadMessageId || task?.messageId || message?.id || '-';
    const roleLines = isOwner
      ? [
        `Task ${taskLabel(task)} is ready in this task thread.`,
        'You are taking the first pass.',
        `Supporting teammates: ${collaboratorNames}.`,
        'Start naturally: understand the goal, name any concrete missing context only if it matters, and move the work forward.',
        'Keep internal routing and prompt mechanics invisible. Speak as a teammate focused on the user goal.',
        'When the task is ready for human validation, move it to in_review.',
      ]
      : [
        `Task ${taskLabel(task)} continues in this task thread.`,
        'Another teammate has already started.',
        `Lead teammate: ${taskAgentName(ownerAgent)}.`,
        'Read the earlier task-thread replies before answering.',
        'Contribute the next useful piece: evidence, constraints, risks, a path forward, a concise synthesis, or a direct answer.',
        'Keep internal routing and prompt mechanics invisible. Speak as a teammate building on the thread, and avoid repeating prior asks or conclusions.',
      ];
    const body = [
      roleLines[0],
      roleLines[1],
      `Title: ${task?.title || message?.body || 'Untitled task'}`,
      `Target thread: ${threadId}`,
      `Task id: ${task?.id || message?.taskId || '-'}`,
      ...roleLines.slice(2),
      details ? `Context:\n${details}` : '',
    ].filter(Boolean).join('\n\n');
    return {
      ...message,
      authorType: message?.authorType || 'human',
      authorId: message?.authorId || 'hum_local',
      body,
      mentionedAgentIds: normalizeIds([recipientAgent?.id]),
      taskId: task?.id || message?.taskId || null,
    };
  }

  function ensureTaskThread(task) {
    if (task.threadMessageId && findMessage(task.threadMessageId)) return findMessage(task.threadMessageId);
    if (task.messageId && findMessage(task.messageId)) {
      task.threadMessageId = task.messageId;
      return findMessage(task.messageId);
    }
  
    const message = normalizeConversationRecord({
      id: makeId('msg'),
      workspaceId: task.workspaceId || state.connection?.workspaceId || 'local',
      spaceType: task.spaceType,
      spaceId: task.spaceId,
      authorType: String(task.createdBy || '').startsWith('agt_') ? 'agent' : 'human',
      authorId: task.createdBy || 'hum_local',
      body: task.title || 'Untitled task',
      attachmentIds: Array.isArray(task.attachmentIds) ? task.attachmentIds : [],
      replyCount: 0,
      savedBy: [],
      taskId: task.id,
      createdAt: task.createdAt || now(),
      updatedAt: now(),
    });
    state.messages.push(message);
    task.messageId = message.id;
    task.threadMessageId = message.id;
    return message;
  }
  
  function shouldStartThreadForAgentDelivery(message) {
    if (!message || message.parentMessageId) return false;
    if (message.authorType !== 'human') return false;
    if (!message.id || !String(message.id).startsWith('msg_')) return false;
    if (message.taskId) return true;
    if (Array.isArray(message.attachmentIds) && message.attachmentIds.length > 0) return true;
    if (agentResponseIntent(message.body)) return true;
    return Array.isArray(message.mentionedAgentIds) && message.mentionedAgentIds.length > 0;
  }
  
  function finishTaskFromThread(task, actorId, replyId) {
    if (!task || taskIsClosed(task)) return false;
    task.status = 'done';
    task.completedAt = now();
    task.endIntentAt = task.endIntentAt || task.completedAt;
    task.claimedBy = task.claimedBy || actorId || null;
    if (task.claimedBy && task.claimedBy.startsWith('agt_')) {
      task.assigneeIds = normalizeIds([...(task.assigneeIds || []), task.claimedBy]);
      task.assigneeId = task.assigneeId || task.claimedBy;
    }
    addTaskHistory(task, 'ended_from_thread', 'Task ended from thread intent.', actorId || 'hum_local', { replyId });
    addTaskTimelineMessage(task, `✅ ${displayActor(actorId)} moved ${taskLabel(task)} to Done`, 'task_done');
    return true;
  }
  
  function stopTaskFromThread(task, actorId, replyId) {
    if (!task || taskIsClosed(task)) {
      return { changed: false, stoppedRuns: [], stoppedAgents: [], stoppedWorkItems: [] };
    }
    const stoppedAt = now();
    task.status = 'closed';
    task.closedAt = task.closedAt || stoppedAt;
    task.endIntentAt = task.endIntentAt || stoppedAt;
    task.stoppedAt = task.stoppedAt || stoppedAt;
    task.reviewRequestedAt = null;
    task.updatedAt = now();
    addTaskHistory(task, 'stopped_closed_from_thread', 'Task stopped from thread intent and marked Closed.', actorId || 'hum_local', { replyId });
    addTaskTimelineMessage(task, `× ${displayActor(actorId)} stopped ${taskLabel(task)} and moved it to Closed`, 'task_closed');
    addCollabEvent('task_stopped_closed_from_thread', `${displayActor(actorId)} stopped ${taskLabel(task)} from its thread and marked it Closed.`, {
      taskId: task.id,
      actorId: actorId || 'hum_local',
      replyId,
    });
    const directlyStoppedWorkItems = stopWorkItemsForTask(task);
    const stoppedRuns = stopRunsForTask(task);
    const steered = steerAgentProcessesForTaskStop(task, actorId, replyId);
    return {
      changed: true,
      stoppedRuns,
      stoppedAgents: [],
      steeredAgents: steered.steeredAgents,
      stoppedWorkItems: normalizeIds([...directlyStoppedWorkItems, ...steered.stoppedWorkItems]),
    };
  }
  
  return {
    createOrClaimTaskForMessage,
    createTaskFromThreadIntent,
    ensureTaskThread,
    finishTaskFromThread,
    shouldStartThreadForAgentDelivery,
    stopTaskFromThread,
    taskAssignmentDeliveryMessage,
    taskThreadDeliveryMessage,
  };
}
