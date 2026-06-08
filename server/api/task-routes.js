import path from 'node:path';
import { createTaskStartupCollaboration } from '../task-startup-collaboration.js';

const TASK_STATUS_VALUES = ['todo', 'in_progress', 'in_review', 'done', 'closed'];
const TASK_STATUS_ERROR = `Unsupported task status. Use one of: ${TASK_STATUS_VALUES.join(', ')}.`;

// Task lifecycle API routes.
// This module owns human-facing task state transitions. The lower-level helpers
// still live in index.js for now, but the route decisions are grouped here so
// future readers can inspect the task workflow without scanning every chat path.

export async function handleTaskApi(req, res, url, deps) {
  const {
    addCollabEvent,
    addSystemEvent = () => {},
    addSystemReply,
    addTaskHistory,
    addTaskTimelineMessage,
    broadcastState,
    claimTask,
    createTaskMessage,
    deliverMessageToAgent,
    displayActor,
    ensureTaskThread,
    findAgent,
    findTask,
    getState,
    makeId,
    normalizeIds,
    now,
    persistState,
    readJson,
    recordRealtimeEvent,
    resolveConversationSpace,
    routeTaskAssignees,
    root,
    sendError,
    sendJson,
    startCodexRun,
    taskAssignmentDeliveryMessage,
    taskIsClosed,
    taskLabel,
  } = deps;
  const state = getState();
  const allowedTaskStatuses = new Set(TASK_STATUS_VALUES);
  const { startTaskStartupCollaboration } = createTaskStartupCollaboration(deps);

  function taskThreadMessage(task = null) {
    if (!task) return null;
    const threadId = task.threadMessageId || task.messageId || task.sourceMessageId || '';
    return (state.messages || []).find((message) => (
      (threadId && message.id === threadId)
      || message.taskId === task.id
    )) || null;
  }

  function taskThreadMessageId(task = null) {
    return taskThreadMessage(task)?.id || task?.threadMessageId || task?.messageId || task?.sourceMessageId || '';
  }

  function latestTaskThreadReply(task = null) {
    const parentMessageId = taskThreadMessageId(task);
    if (!parentMessageId) return null;
    return (state.replies || [])
      .filter((reply) => reply?.parentMessageId === parentMessageId)
      .sort(compareTaskRecords)[0] || null;
  }

  function captureTaskThreadReplies(task = null, operation = () => {}) {
    const beforeReplyIds = new Set((state.replies || []).map((reply) => reply?.id).filter(Boolean));
    const result = operation();
    const parentMessageId = taskThreadMessageId(task);
    const replies = (state.replies || [])
      .filter((item) => item?.parentMessageId === parentMessageId && !beforeReplyIds.has(item.id))
      .sort(compareTaskRecords);
    return {
      result,
      reply: replies[0] || null,
      replies,
    };
  }

  function captureTaskThreadReply(task = null, operation = () => {}) {
    const { result, reply } = captureTaskThreadReplies(task, operation);
    return {
      result,
      reply,
    };
  }

  async function captureTaskThreadRepliesAsync(task = null, operation = async () => {}) {
    const beforeReplyIds = new Set((state.replies || []).map((reply) => reply?.id).filter(Boolean));
    const result = await operation();
    const parentMessageId = taskThreadMessageId(task);
    const replies = (state.replies || [])
      .filter((item) => item?.parentMessageId === parentMessageId && !beforeReplyIds.has(item.id))
      .sort(compareTaskRecords);
    return {
      result,
      reply: replies[0] || null,
      replies,
    };
  }

  function taskRealtimeScope(task = null, reply = null) {
    const thread = taskThreadMessage(task);
    const workspaceId = workspaceIdForRecord(reply || task || thread, thread?.workspaceId || 'local') || 'local';
    const spaceType = reply?.spaceType || task?.spaceType || thread?.spaceType || '';
    const spaceId = reply?.spaceId || task?.spaceId || thread?.spaceId || '';
    const threadMessageId = reply?.parentMessageId || thread?.id || task?.threadMessageId || task?.messageId || '';
    return { workspaceId, spaceType, spaceId, threadMessageId };
  }

  function recordTaskRealtimeChange(task = null, {
    reply = null,
    replies = null,
    message = null,
    mission = null,
    run = null,
    workspaceWide = false,
  } = {}) {
    if (typeof recordRealtimeEvent !== 'function' || !task?.id) return null;
    const replyRecords = (Array.isArray(replies) ? replies : [reply]).filter(Boolean);
    const primaryReply = reply || replyRecords[0] || null;
    const scope = taskRealtimeScope(task, primaryReply);
    const workspaceId = workspaceIdForRecord(primaryReply || message || task || mission || run, scope.workspaceId || 'local') || 'local';
    const recordId = primaryReply?.id || message?.id || run?.id || mission?.id || task.id;
    const recordKind = primaryReply ? 'reply' : message ? 'message' : run ? 'run' : mission ? 'mission' : 'task';
    return recordRealtimeEvent('conversation_record_changed', {
      workspaceId,
      spaceType: scope.spaceType,
      spaceId: scope.spaceId,
      recordId,
      parentMessageId: primaryReply?.parentMessageId || scope.threadMessageId || '',
      recordKind,
      task,
      ...(primaryReply ? { reply: primaryReply } : {}),
      ...(replyRecords.length ? { replies: replyRecords } : {}),
      ...(message ? { message } : {}),
      ...(mission ? { mission } : {}),
      ...(run ? { run } : {}),
    }, {
      workspaceId,
      scopeType: workspaceWide ? 'workspace' : scope.spaceType || 'workspace',
      scopeId: workspaceWide ? workspaceId : scope.spaceId || workspaceId,
      threadMessageId: scope.threadMessageId || null,
    });
  }

  function broadcastTaskRealtimeState(task = null, options = {}) {
    recordTaskRealtimeChange(task, options);
    broadcastState({ realtimeOnly: true });
  }

  function workspaceIdForRecord(record = null, fallback = '') {
    return String(
      record?.workspaceId
      || fallback
      || state.connection?.workspaceId
      || state.cloud?.workspace?.id
      || state.cloud?.workspaces?.[0]?.id
      || '',
    ).trim();
  }

  function persistTaskState(record = null, reason = 'task_changed') {
    const workspaceId = workspaceIdForRecord(record);
    return persistState(workspaceId ? { workspaceId, reason } : { reason });
  }

  function deliveryErrorHandler(task, agent, message) {
    return (error) => {
      addSystemEvent('task_delivery_error', `Could not deliver ${taskLabel(task)} to ${agent?.name || agent?.id || 'agent'}: ${error.message}`, {
        taskId: task?.id || null,
        messageId: message?.id || null,
        agentId: agent?.id || null,
      });
    };
  }

  async function dispatchCreatedTask(task, message, selectedAgentIds) {
    try {
      await startTaskStartupCollaboration(task, message, selectedAgentIds);
    } catch (error) {
      deliveryErrorHandler(task, null, message)(error);
    }
  }

  function workspaceIdForRecord(record = null, fallback = '') {
    return String(
      record?.workspaceId
      || fallback
      || state.connection?.workspaceId
      || state.cloud?.workspace?.id
      || state.cloud?.workspaces?.[0]?.id
      || '',
    ).trim();
  }

  function persistTaskState(record = null, reason = 'task_changed') {
    const workspaceId = workspaceIdForRecord(record);
    return persistState(workspaceId ? { workspaceId, reason } : { reason });
  }

  function paginationLimit(value, fallback = 80, max = 200) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(max, Math.max(1, Math.floor(parsed)));
  }

  function recordTime(record) {
    const parsed = Date.parse(record?.updatedAt || record?.createdAt || '');
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function compareTaskRecords(a, b) {
    const timeDiff = recordTime(b) - recordTime(a);
    if (timeDiff) return timeDiff;
    return String(b?.id || '').localeCompare(String(a?.id || ''));
  }

  function beforeCursor(url) {
    const raw = url.searchParams.get('before') || '';
    const id = String(url.searchParams.get('beforeId') || '');
    if (!raw) return { time: Number.POSITIVE_INFINITY, id: '' };
    const parsed = Date.parse(raw);
    return {
      time: Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY,
      id,
    };
  }

  function recordBeforeCursor(record, cursor) {
    if (!cursor || cursor.time === Number.POSITIVE_INFINITY) return true;
    const time = recordTime(record);
    if (time < cursor.time) return true;
    if (time > cursor.time || !cursor.id) return false;
    return String(record?.id || '').localeCompare(cursor.id) < 0;
  }

  function closeTask(task, actorId = 'hum_local', reason = 'Task closed.') {
    if (!task) return null;
    if (task.status === 'closed') return task;
    const closedAt = now();
    task.status = 'closed';
    task.closedAt = closedAt;
    task.endIntentAt = task.endIntentAt || closedAt;
    task.reviewRequestedAt = null;
    task.updatedAt = closedAt;
    addTaskHistory(task, 'closed', reason, actorId);
    const thread = ensureTaskThread(task);
    addSystemReply(thread.id, 'Task closed.');
    addTaskTimelineMessage(task, `× ${displayActor(actorId)} closed ${taskLabel(task)}`, 'task_closed');
    addCollabEvent('task_closed', `Task closed: ${task.title}`, { taskId: task.id, actorId });
    return task;
  }

  if (req.method === 'GET' && url.pathname === '/api/tasks') {
    const requestedSpaceType = url.searchParams.get('spaceType') || '';
    const requestedSpaceId = url.searchParams.get('spaceId') || '';
    const status = url.searchParams.get('status') || '';
    const limit = paginationLimit(url.searchParams.get('limit'));
    const before = beforeCursor(url);
    const matching = (state.tasks || [])
      .filter((task) => !requestedSpaceType || task.spaceType === requestedSpaceType)
      .filter((task) => !requestedSpaceId || String(task.spaceId || '') === requestedSpaceId)
      .filter((task) => !status || String(task.status || '') === status)
      .filter((task) => recordBeforeCursor(task, before))
      .sort(compareTaskRecords);
    const page = matching.slice(0, limit);
    const nextBefore = page.length ? (page[page.length - 1].updatedAt || page[page.length - 1].createdAt || '') : '';
    const nextBeforeId = page.length ? String(page[page.length - 1].id || '') : '';
    sendJson(res, 200, {
      tasks: page,
      pagination: {
        limit,
        hasMore: matching.length > page.length,
        nextBefore,
        nextBeforeId,
      },
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/tasks') {
    const body = await readJson(req);
    const title = String(body.title || '').trim();
    if (!title) {
      sendError(res, 400, 'Task title is required.');
      return true;
    }
    let space;
    try {
      space = resolveConversationSpace(body);
    } catch (error) {
      sendError(res, error.status || 400, error.message);
      return true;
    }
    const assigneeIds = normalizeIds([
      ...(Array.isArray(body.assigneeIds) ? body.assigneeIds : []),
      ...(body.assigneeId ? [body.assigneeId] : []),
    ]);

    // Tasks are created as conversation messages so every task has a stable
    // thread for follow-up discussion, agent updates, and review notes.
    const { message, task } = createTaskMessage({
      title,
      body: String(body.body || '').trim(),
      ...space,
      authorType: body.authorType === 'agent' ? 'agent' : 'human',
      authorId: String(body.authorId || 'hum_local'),
      assigneeIds,
      attachmentIds: Array.isArray(body.attachmentIds) ? body.attachmentIds.map(String) : [],
      sourceMessageId: body.sourceMessageId || body.messageId || null,
      sourceReplyId: body.sourceReplyId || null,
      status: body.status || 'todo',
    });
    const { replies } = await captureTaskThreadRepliesAsync(task, () => dispatchCreatedTask(task, message, assigneeIds));
    await persistTaskState(task, 'task_created');
    broadcastTaskRealtimeState(task, { message, replies });
    sendJson(res, 201, { message, task, ...(replies.length ? { reply: replies[0], replies } : {}) });
    return true;
  }

  const claimMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/claim$/);
  if (req.method === 'POST' && claimMatch) {
    const task = findTask(claimMatch[1]);
    if (!task) {
      sendError(res, 404, 'Task not found.');
      return true;
    }
    const body = await readJson(req);
    const actorId = String(body.actorId || body.assigneeId || 'agt_codex');
    let reply = null;
    try {
      ({ reply } = captureTaskThreadReply(task, () => claimTask(task, actorId, { force: body.force })));
    } catch (error) {
      sendError(res, error.status || 409, error.message);
      return true;
    }
    await persistTaskState(task, 'task_claimed');
    broadcastTaskRealtimeState(task, { reply });
    sendJson(res, 200, { task, ...(reply ? { reply } : {}) });
    return true;
  }

  const unclaimMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/unclaim$/);
  if (req.method === 'POST' && unclaimMatch) {
    const task = findTask(unclaimMatch[1]);
    if (!task) {
      sendError(res, 404, 'Task not found.');
      return true;
    }
    if (taskIsClosed(task)) {
      sendError(res, 409, 'Closed task cannot be unclaimed.');
      return true;
    }

    // Releasing a claim rewinds execution-only fields, but keeps the assignee
    // list so humans do not lose the intended owner suggestions.
    const { reply } = captureTaskThreadReply(task, () => {
      const actorId = task.claimedBy || 'hum_local';
      task.claimedBy = null;
      task.assigneeId = task.assigneeIds?.[0] || null;
      task.claimedAt = null;
      task.status = 'todo';
      task.reviewRequestedAt = null;
      addTaskHistory(task, 'unclaimed', 'Claim released.', actorId);
      const thread = ensureTaskThread(task);
      addSystemReply(thread.id, 'Task claim released.');
      addTaskTimelineMessage(task, `🔓 ${displayActor(actorId)} released ${taskLabel(task)}`, 'task_unclaimed');
    });
    await persistTaskState(task, 'task_unclaimed');
    broadcastTaskRealtimeState(task, { reply });
    sendJson(res, 200, { task, ...(reply ? { reply } : {}) });
    return true;
  }

  const reviewMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/request-review$/);
  if (req.method === 'POST' && reviewMatch) {
    const task = findTask(reviewMatch[1]);
    if (!task) {
      sendError(res, 404, 'Task not found.');
      return true;
    }
    if (taskIsClosed(task)) {
      sendError(res, 409, 'Closed task cannot request review.');
      return true;
    }
    if (!task.claimedBy) {
      sendError(res, 409, 'Task must be claimed before requesting review.');
      return true;
    }
    const { reply } = captureTaskThreadReply(task, () => {
      task.status = 'in_review';
      task.reviewRequestedAt = now();
      addTaskHistory(task, 'review_requested', 'Review requested.', task.claimedBy);
      const thread = ensureTaskThread(task);
      addSystemReply(thread.id, 'Review requested. Waiting for human approval.');
      addTaskTimelineMessage(task, `👀 ${displayActor(task.claimedBy)} moved ${taskLabel(task)} to In Review`, 'task_review');
    });
    await persistTaskState(task, 'task_review_requested');
    broadcastTaskRealtimeState(task, { reply });
    sendJson(res, 200, { task, ...(reply ? { reply } : {}) });
    return true;
  }

  const approveMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/approve$/);
  if (req.method === 'POST' && approveMatch) {
    const task = findTask(approveMatch[1]);
    if (!task) {
      sendError(res, 404, 'Task not found.');
      return true;
    }
    if (task.status !== 'in_review') {
      sendError(res, 409, 'Task must be in review before approval.');
      return true;
    }
    const { reply } = captureTaskThreadReply(task, () => {
      task.status = 'done';
      task.completedAt = now();
      addTaskHistory(task, 'approved', 'Human review approved; task marked done.');
      const thread = ensureTaskThread(task);
      addSystemReply(thread.id, 'Human review approved. Task marked done.');
      addTaskTimelineMessage(task, `✅ ${displayActor('hum_local')} moved ${taskLabel(task)} to Done`, 'task_done');
    });
    await persistTaskState(task, 'task_approved');
    broadcastTaskRealtimeState(task, { reply });
    sendJson(res, 200, { task, ...(reply ? { reply } : {}) });
    return true;
  }

  const reopenMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/reopen$/);
  if (req.method === 'POST' && reopenMatch) {
    const task = findTask(reopenMatch[1]);
    if (!task) {
      sendError(res, 404, 'Task not found.');
      return true;
    }

    // Reopen clears terminal stop markers together; otherwise old
    // status timestamps can make a newly reopened task look already resolved.
    const { reply } = captureTaskThreadReply(task, () => {
      task.status = 'todo';
      task.claimedBy = null;
      task.assigneeId = task.assigneeIds?.[0] || null;
      task.claimedAt = null;
      task.reviewRequestedAt = null;
      task.completedAt = null;
      task.closedAt = null;
      task.endIntentAt = null;
      task.stoppedAt = null;
      addTaskHistory(task, 'reopened', 'Task reopened by human.');
      const thread = ensureTaskThread(task);
      addSystemReply(thread.id, 'Task reopened.');
      addTaskTimelineMessage(task, `↩ ${displayActor('hum_local')} reopened ${taskLabel(task)}`, 'task_reopened');
    });
    await persistTaskState(task, 'task_reopened');
    broadcastTaskRealtimeState(task, { reply });
    sendJson(res, 200, { task, ...(reply ? { reply } : {}) });
    return true;
  }

  const closeMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/close$/);
  if (req.method === 'POST' && closeMatch) {
    const task = findTask(closeMatch[1]);
    if (!task) {
      sendError(res, 404, 'Task not found.');
      return true;
    }
    if (task.status === 'done') {
      sendError(res, 409, 'Done task cannot be closed. Reopen it first if this work should be canceled.');
      return true;
    }
    const body = await readJson(req);
    const { reply } = captureTaskThreadReply(task, () => {
      closeTask(task, String(body.actorId || 'hum_local'), String(body.reason || 'Task closed by human.'));
    });
    await persistTaskState(task, 'task_closed');
    broadcastTaskRealtimeState(task, { reply });
    sendJson(res, 200, { task, ...(reply ? { reply } : {}) });
    return true;
  }

  const runTaskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/run-codex$/);
  if (req.method === 'POST' && runTaskMatch) {
    const task = findTask(runTaskMatch[1]);
    if (!task) {
      sendError(res, 404, 'Task not found.');
      return true;
    }
    if (taskIsClosed(task)) {
      sendError(res, 409, 'Closed task cannot start a Codex run.');
      return true;
    }
    const actorId = 'agt_codex';
    if (task.claimedBy && task.claimedBy !== actorId) {
      sendError(res, 409, `Task is already claimed by ${task.claimedBy}.`);
      return true;
    }
    let mission = null;
    let run = null;
    const { replies } = captureTaskThreadReplies(task, () => {
      if (!task.claimedBy) {
        // A Codex run owns the task while it executes, so unclaimed work is
        // auto-claimed by the Codex agent before the background process starts.
        task.claimedBy = actorId;
        task.assigneeId = actorId;
        task.assigneeIds = normalizeIds([...(task.assigneeIds || []), actorId]);
        task.claimedAt = now();
        task.status = 'in_progress';
        addTaskHistory(task, 'claimed', 'Auto-claimed before Codex run.', actorId);
        addSystemReply(ensureTaskThread(task).id, 'Task auto-claimed by Codex before run.');
        addTaskTimelineMessage(task, `📌 ${displayActor(actorId)} claimed ${taskLabel(task)}`, 'task_claimed');
      }

      mission = {
        id: makeId('mis'),
        title: task.title,
        goal: `${task.title}\n\n${task.body || ''}\n\nTask id: ${task.id}`,
        status: 'ready',
        priority: 'normal',
        workspace: path.resolve(state.settings.defaultWorkspace || root),
        scopeAllow: ['**/*'],
        scopeDeny: ['.env*', 'node_modules/**', '.git/**'],
        gates: ['npm run check'],
        evidenceRequired: ['diff summary', 'test output', 'risk notes'],
        humanCheckpoints: ['before dangerous command', 'before deploy'],
        attachmentIds: Array.isArray(task.attachmentIds) ? task.attachmentIds : [],
        localReferences: Array.isArray(task.localReferences) ? task.localReferences : [],
        taskId: task.id,
        createdAt: now(),
        updatedAt: now(),
      };
      state.missions.unshift(mission);
      run = {
        id: makeId('run'),
        missionId: mission.id,
        taskId: task.id,
        runtime: 'codex',
        status: 'queued',
        createdAt: now(),
        startedAt: null,
        completedAt: null,
        exitCode: null,
        finalMessage: '',
      };
      state.runs.unshift(run);
      task.runIds = Array.isArray(task.runIds) ? task.runIds : [];
      task.runIds.unshift(run.id);
      addTaskHistory(task, 'run_started', `Codex run started: ${run.id}`, actorId, { runId: run.id, missionId: mission.id });
      addSystemReply(ensureTaskThread(task).id, `Codex run started: ${run.id}.`);
    });
    await persistTaskState(task, 'task_run_started');
    broadcastTaskRealtimeState(task, { replies, mission, run, workspaceWide: true });
    startCodexRun(mission, run);
    sendJson(res, 201, { task, mission, run, ...(replies.length ? { reply: replies[0], replies } : {}) });
    return true;
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (['PATCH', 'POST'].includes(req.method) && taskMatch) {
    const task = findTask(taskMatch[1]);
    if (!task) {
      sendError(res, 404, 'Task not found.');
      return true;
    }
    const body = await readJson(req);
    let taskStatusChanged = false;
    if (body.title !== undefined) task.title = String(body.title || task.title).trim();
    if (body.body !== undefined) task.body = String(body.body || '').trim();
    if (body.status !== undefined && body.status !== task.status) {
      const nextStatus = String(body.status || task.status);
      if (!allowedTaskStatuses.has(nextStatus)) {
        sendError(res, 400, TASK_STATUS_ERROR);
        return true;
      }
      if (nextStatus === 'done' && task.status !== 'in_review') {
        sendError(res, 409, 'Task must be in review before done.');
        return true;
      }
      if (nextStatus === 'closed') {
        const { reply } = captureTaskThreadReply(task, () => {
          closeTask(task, 'hum_local', String(body.reason || 'Task closed by human.'));
        });
        await persistTaskState(task, 'task_closed');
        broadcastTaskRealtimeState(task, { reply });
        sendJson(res, 200, { task, ...(reply ? { reply } : {}) });
        return true;
      }
      task.status = nextStatus;
      taskStatusChanged = true;
      if (nextStatus === 'todo' || nextStatus === 'in_progress') {
        task.reviewRequestedAt = null;
        task.completedAt = null;
        task.closedAt = null;
      }
      if (nextStatus === 'in_review') {
        task.reviewRequestedAt = now();
        task.closedAt = null;
      }
      if (nextStatus === 'done') {
        task.completedAt = now();
        task.closedAt = null;
      }
      addTaskHistory(task, 'status_changed', `Status changed to ${nextStatus}.`);
      if (nextStatus === 'todo') addTaskTimelineMessage(task, `↩ ${displayActor('hum_local')} moved ${taskLabel(task)} to Todo`, 'task_reopened');
      if (nextStatus === 'in_progress') addTaskTimelineMessage(task, `📌 ${displayActor('hum_local')} moved ${taskLabel(task)} to In Progress`, 'task_progress');
      if (nextStatus === 'in_review') addTaskTimelineMessage(task, `👀 ${displayActor('hum_local')} moved ${taskLabel(task)} to In Review`, 'task_review');
      if (nextStatus === 'done') addTaskTimelineMessage(task, `✅ ${displayActor('hum_local')} moved ${taskLabel(task)} to Done`, 'task_done');
    }

    // The UI has both single-assignee and multi-assignee callers. Keep both
    // write shapes here until the old assigneeId field can be fully retired.
    if (body.assigneeId !== undefined) {
      task.assigneeId = body.assigneeId ? String(body.assigneeId) : null;
      task.assigneeIds = task.assigneeId ? normalizeIds([...(task.assigneeIds || []), task.assigneeId]) : [];
      addTaskHistory(task, 'assigned', task.assigneeId ? `Assigned to ${displayActor(task.assigneeId)}.` : 'Assignee cleared.');
    }
    if (body.assigneeIds !== undefined) {
      task.assigneeIds = normalizeIds(body.assigneeIds);
      task.assigneeId = task.assigneeIds[0] || null;
      addTaskHistory(task, 'assigned', task.assigneeIds.length ? `Assigned to ${task.assigneeIds.map((id) => displayActor(id)).join(', ')}.` : 'Assignees cleared.');
    }
    task.updatedAt = now();
    addCollabEvent('task_updated', `Task updated: ${task.title}`, { taskId: task.id });
    await persistTaskState(task, 'task_updated');
    if (taskStatusChanged) broadcastTaskRealtimeState(task);
    else broadcastState();
    sendJson(res, 200, { task });
    return true;
  }

  const deleteTaskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteTaskMatch) {
    const taskId = deleteTaskMatch[1];
    const deletedTask = findTask(taskId);
    state.tasks = state.tasks.filter((task) => task.id !== taskId);
    for (const message of state.messages) {
      if (message.taskId === taskId) delete message.taskId;
    }
    addCollabEvent('task_deleted', 'Task deleted.', { taskId });
    await persistTaskState(deletedTask, 'task_deleted');
    broadcastState();
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}
