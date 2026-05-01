// Agent tool API routes.
// These endpoints are called by running Agents, not by the human UI. They let an
// Agent inspect bounded history, send a routed response tied to a work item, and
// create/claim/update tasks without reaching across channel boundaries.

export async function handleAgentToolApi(req, res, url, deps) {
  const {
    addSystemEvent,
    broadcastState,
    claimTask,
    createTaskFromMessage,
    createTaskMessage,
    displayActor,
    findAgent,
    findConversationRecord,
    findMessage,
    findTaskForAgentTool,
    findWorkItem,
    formatAgentHistory,
    formatAgentSearchResults,
    getState,
    httpError,
    markWorkItemResponded,
    normalizeIds,
    persistState,
    postAgentResponse,
    readAgentHistory,
    readJson,
    resolveConversationSpace,
    resolveMessageTarget,
    searchAgentMessageHistory,
    sendError,
    sendJson,
    taskLabel,
    updateTaskForAgent,
    workItemTargetMatches,
  } = deps;
  const state = getState();

  if (req.method === 'GET' && url.pathname === '/api/agent-tools/history') {
    const agentId = url.searchParams.get('agentId') || '';
    const history = readAgentHistory(state, {
      target: url.searchParams.get('target') || url.searchParams.get('channel') || '#all',
      limit: url.searchParams.get('limit') || undefined,
      around: url.searchParams.get('around') || undefined,
      before: url.searchParams.get('before') || undefined,
      after: url.searchParams.get('after') || undefined,
    });
    addSystemEvent('agent_history_read', `${displayActor(agentId) || 'Agent'} read ${history.target || 'history'}.`, {
      agentId,
      target: history.target || url.searchParams.get('target') || '#all',
      ok: Boolean(history.ok),
    });
    sendJson(res, history.ok ? 200 : 404, {
      ...history,
      text: formatAgentHistory(history, { state, targetAgentId: agentId }),
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/agent-tools/search') {
    const agentId = url.searchParams.get('agentId') || '';
    const search = searchAgentMessageHistory(state, {
      query: url.searchParams.get('q') || url.searchParams.get('query') || '',
      target: url.searchParams.get('target') || url.searchParams.get('channel') || '#all',
      limit: url.searchParams.get('limit') || undefined,
    });
    addSystemEvent('agent_history_search', `${displayActor(agentId) || 'Agent'} searched message history.`, {
      agentId,
      query: url.searchParams.get('q') || url.searchParams.get('query') || '',
      target: url.searchParams.get('target') || '#all',
      ok: Boolean(search.ok),
    });
    sendJson(res, search.ok ? 200 : 400, {
      ...search,
      text: formatAgentSearchResults(search, { state, targetAgentId: agentId }),
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent-tools/messages/send') {
    const body = await readJson(req);
    const agent = findAgent(String(body.agentId || ''));
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    const workItem = findWorkItem(String(body.workItemId || body.work_item_id || ''));
    if (!workItem) {
      sendError(res, 404, 'Work item not found.');
      return true;
    }
    if (workItem.agentId !== agent.id) {
      sendError(res, 403, 'Work item belongs to a different agent.');
      return true;
    }
    if (workItem.status === 'cancelled') {
      sendError(res, 409, 'Work item was stopped by the user.');
      return true;
    }
    const content = String(body.content || '').trim();
    if (!content) {
      sendError(res, 400, 'Message content is required.');
      return true;
    }
    let target;
    try {
      target = resolveMessageTarget(body.target || workItem.target);
      if (!workItemTargetMatches(workItem, target)) {
        throw httpError(409, 'Target does not match the work item conversation.');
      }
    } catch (error) {
      sendError(res, error.status || 400, error.message);
      return true;
    }

    // send_message is tied to the work item target so an Agent cannot post into
    // another channel or thread just by guessing a conversation id.
    const sourceMessage = findConversationRecord(workItem.sourceMessageId);
    const posted = await postAgentResponse(agent, target.spaceType, target.spaceId, content, target.parentMessageId || null, {
      sourceMessage,
    });
    markWorkItemResponded(workItem, target.label, posted);
    addSystemEvent('agent_tool_send_message', `${agent.name} sent a routed message to ${target.label}.`, {
      agentId: agent.id,
      workItemId: workItem.id,
      target: target.label,
      responseId: posted?.id || null,
    });
    await persistState();
    broadcastState();
    sendJson(res, 200, {
      ok: true,
      target: target.label,
      workItemId: workItem.id,
      workItem,
      message: posted,
      text: `Message sent to ${target.label}.`,
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent-tools/tasks/update') {
    const body = await readJson(req);
    const agent = findAgent(String(body.agentId || ''));
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    let task;
    try {
      task = findTaskForAgentTool(body);
      updateTaskForAgent(task, agent, body.status || body.nextStatus, { force: body.force === true || body.allowUnclaimed === true });
    } catch (error) {
      sendError(res, error.status || 400, error.message);
      return true;
    }
    await persistState();
    broadcastState();
    sendJson(res, 200, {
      ok: true,
      task,
      text: `${taskLabel(task)} is now ${task.status}.`,
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent-tools/tasks') {
    const body = await readJson(req);
    const agent = findAgent(String(body.agentId || ''));
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    let space;
    try {
      space = resolveConversationSpace(body);
    } catch (error) {
      sendError(res, error.status || 400, error.message);
      return true;
    }
    const taskInputs = Array.isArray(body.tasks) && body.tasks.length
      ? body.tasks
      : [{ title: body.title, body: body.body }];
    const created = [];
    try {
      for (const input of taskInputs) {
        // Task creation accepts both per-item and request-level assignee fields
        // because Agents often batch several task suggestions in one tool call.
        const assigneeIds = normalizeIds([
          ...(Array.isArray(input.assigneeIds) ? input.assigneeIds : []),
          ...(input.assigneeId ? [input.assigneeId] : []),
          ...(Array.isArray(body.assigneeIds) ? body.assigneeIds : []),
          ...(body.assigneeId ? [body.assigneeId] : []),
          ...(body.claim ? [agent.id] : []),
        ]);
        const { message, task } = createTaskMessage({
          title: input.title,
          body: String(input.body ?? body.body ?? '').trim(),
          ...space,
          authorType: 'agent',
          authorId: agent.id,
          assigneeIds,
          attachmentIds: Array.isArray(input.attachmentIds) ? input.attachmentIds : (Array.isArray(body.attachmentIds) ? body.attachmentIds : []),
          sourceMessageId: input.sourceMessageId || body.sourceMessageId || null,
          sourceReplyId: input.sourceReplyId || body.sourceReplyId || null,
        });
        if (body.claim) claimTask(task, agent.id, { force: body.force });
        created.push({
          task,
          message,
          taskNumber: task.number,
          messageId: message.id,
          title: task.title,
          threadTarget: `${space.label}:${message.id}`,
        });
      }
    } catch (error) {
      sendError(res, error.status || 400, error.message);
      return true;
    }
    addSystemEvent('agent_tool_create_tasks', `${agent.name} created ${created.length} task(s).`, {
      agentId: agent.id,
      taskIds: created.map((item) => item.task.id),
      spaceType: space.spaceType,
      spaceId: space.spaceId,
    });
    await persistState();
    broadcastState();
    sendJson(res, 201, {
      ok: true,
      tasks: created,
      text: [
        `Created ${created.length} task(s) in ${space.label}:`,
        ...created.map((item) => `${taskLabel(item.task)} msg=${item.messageId} "${item.title}"`),
        '',
        'To follow up, reply in:',
        ...created.map((item) => `${taskLabel(item.task)} -> ${item.threadTarget}`),
      ].join('\n'),
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent-tools/tasks/claim') {
    const body = await readJson(req);
    const agent = findAgent(String(body.agentId || ''));
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    let space;
    try {
      space = resolveConversationSpace(body);
    } catch (error) {
      sendError(res, error.status || 400, error.message);
      return true;
    }
    const claimed = [];
    const numbers = Array.isArray(body.taskNumbers) ? body.taskNumbers : (Array.isArray(body.task_numbers) ? body.task_numbers : []);
    const messageIds = Array.isArray(body.messageIds) ? body.messageIds : (Array.isArray(body.message_ids) ? body.message_ids : []);
    try {
      // Agents can claim an existing task by number, or promote a top-level
      // conversation message into a task and claim it in one tool call.
      for (const number of numbers) {
        const task = state.tasks.find((item) => (
          item.spaceType === space.spaceType
          && item.spaceId === space.spaceId
          && Number(item.number) === Number(number)
        ));
        if (!task) throw httpError(404, `Task not found: #${number}`);
        claimed.push(claimTask(task, agent.id, { force: body.force }));
      }
      for (const messageId of messageIds) {
        const message = findMessage(String(messageId)) || state.messages.find((item) => item.id.startsWith(String(messageId)));
        if (!message || message.authorType === 'system' || message.parentMessageId) {
          throw httpError(400, 'Only regular top-level messages can be claimed as tasks.');
        }
        const task = createTaskFromMessage(message, body.title || message.body, { createdBy: message.authorId });
        claimed.push(claimTask(task, agent.id, { force: body.force }));
      }
    } catch (error) {
      sendError(res, error.status || 400, error.message);
      return true;
    }
    await persistState();
    broadcastState();
    sendJson(res, 200, {
      ok: true,
      tasks: claimed,
      text: claimed.map((task) => `Claimed ${taskLabel(task)} "${task.title}"`).join('\n'),
    });
    return true;
  }

  return false;
}
