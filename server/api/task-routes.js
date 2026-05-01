import path from 'node:path';

// Task lifecycle API routes.
// This module owns human-facing task state transitions. The lower-level helpers
// still live in index.js for now, but the route decisions are grouped here so
// future readers can inspect the task workflow without scanning every chat path.

export async function handleTaskApi(req, res, url, deps) {
  const {
    addCollabEvent,
    addSystemReply,
    addTaskHistory,
    addTaskTimelineMessage,
    broadcastState,
    claimTask,
    createTaskMessage,
    displayActor,
    ensureTaskThread,
    findTask,
    getState,
    makeId,
    normalizeIds,
    now,
    persistState,
    readJson,
    resolveConversationSpace,
    root,
    sendError,
    sendJson,
    startCodexRun,
    taskIsClosed,
    taskLabel,
  } = deps;
  const state = getState();

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
    await persistState();
    broadcastState();
    sendJson(res, 201, { message, task });
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
    try {
      claimTask(task, actorId, { force: body.force });
    } catch (error) {
      sendError(res, error.status || 409, error.message);
      return true;
    }
    await persistState();
    broadcastState();
    sendJson(res, 200, { task });
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
    await persistState();
    broadcastState();
    sendJson(res, 200, { task });
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
    task.status = 'in_review';
    task.reviewRequestedAt = now();
    addTaskHistory(task, 'review_requested', 'Review requested.', task.claimedBy);
    const thread = ensureTaskThread(task);
    addSystemReply(thread.id, 'Review requested. Waiting for human approval.');
    addTaskTimelineMessage(task, `👀 ${displayActor(task.claimedBy)} moved ${taskLabel(task)} to In Review`, 'task_review');
    await persistState();
    broadcastState();
    sendJson(res, 200, { task });
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
    task.status = 'done';
    task.completedAt = now();
    addTaskHistory(task, 'approved', 'Human review approved; task marked done.');
    const thread = ensureTaskThread(task);
    addSystemReply(thread.id, 'Human review approved. Task marked done.');
    addTaskTimelineMessage(task, `✅ ${displayActor('hum_local')} moved ${taskLabel(task)} to Done`, 'task_done');
    await persistState();
    broadcastState();
    sendJson(res, 200, { task });
    return true;
  }

  const reopenMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/reopen$/);
  if (req.method === 'POST' && reopenMatch) {
    const task = findTask(reopenMatch[1]);
    if (!task) {
      sendError(res, 404, 'Task not found.');
      return true;
    }

    // Reopen clears terminal/cancellation markers together; otherwise old
    // status timestamps can make a newly reopened task look already resolved.
    task.status = 'todo';
    task.claimedBy = null;
    task.assigneeId = task.assigneeIds?.[0] || null;
    task.claimedAt = null;
    task.reviewRequestedAt = null;
    task.completedAt = null;
    task.endIntentAt = null;
    task.cancelledAt = null;
    task.stoppedAt = null;
    addTaskHistory(task, 'reopened', 'Task reopened by human.');
    const thread = ensureTaskThread(task);
    addSystemReply(thread.id, 'Task reopened.');
    addTaskTimelineMessage(task, `↩ ${displayActor('hum_local')} reopened ${taskLabel(task)}`, 'task_reopened');
    await persistState();
    broadcastState();
    sendJson(res, 200, { task });
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

    const mission = {
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
    const run = {
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
    await persistState();
    broadcastState();
    startCodexRun(mission, run);
    sendJson(res, 201, { task, mission, run });
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
    if (body.title !== undefined) task.title = String(body.title || task.title).trim();
    if (body.body !== undefined) task.body = String(body.body || '').trim();
    if (body.status !== undefined && body.status !== task.status) {
      const nextStatus = String(body.status || task.status);
      if (nextStatus === 'done' && task.status !== 'in_review') {
        sendError(res, 409, 'Task must be in review before done.');
        return true;
      }
      task.status = nextStatus;
      if (nextStatus === 'in_review') task.reviewRequestedAt = now();
      if (nextStatus === 'done') task.completedAt = now();
      addTaskHistory(task, 'status_changed', `Status changed to ${nextStatus}.`);
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
    await persistState();
    broadcastState();
    sendJson(res, 200, { task });
    return true;
  }

  const deleteTaskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteTaskMatch) {
    const taskId = deleteTaskMatch[1];
    state.tasks = state.tasks.filter((task) => task.id !== taskId);
    for (const message of state.messages) {
      if (message.taskId === taskId) delete message.taskId;
    }
    addCollabEvent('task_deleted', 'Task deleted.', { taskId });
    await persistState();
    broadcastState();
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}
