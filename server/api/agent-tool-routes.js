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
    makeId,
    markWorkItemResponded,
    normalizeIds,
    persistState,
    postAgentResponse,
    readAgentHistory,
    readAgentMemoryFile,
    readJson,
    resolveConversationSpace,
    resolveMessageTarget,
    searchAgentMessageHistory,
    searchAgentMemory,
    sendError,
    sendJson,
    taskLabel,
    updateTaskForAgent,
    writeAgentMemoryUpdate,
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

  function memorySearchText(search) {
    if (!search?.ok) return search?.text || 'Memory search failed.';
    if (!search.results?.length) return `No memory matches for "${search.query}".`;
    return [
      `Memory search results for "${search.query}":`,
      ...search.results.map((item, index) => [
        `${index + 1}. @${item.agentName} (${item.agentId}) ${item.path}:${item.line}`,
        `   ${item.preview}`,
      ].join('\n')),
      search.truncated ? '- More matches were omitted by the limit.' : '',
    ].filter(Boolean).join('\n');
  }

  if (req.method === 'GET' && url.pathname === '/api/agent-tools/memory/search') {
    const agentId = url.searchParams.get('agentId') || '';
    const targetAgentId = url.searchParams.get('targetAgentId') || url.searchParams.get('targetAgent') || '';
    const search = await searchAgentMemory(url.searchParams.get('q') || url.searchParams.get('query') || '', {
      targetAgentId,
      limit: url.searchParams.get('limit') || undefined,
    });
    addSystemEvent('agent_memory_search', `${displayActor(agentId) || 'Agent'} searched agent memory.`, {
      agentId,
      query: search.query || '',
      targetAgentId: targetAgentId || null,
      resultCount: search.results?.length || 0,
      ok: Boolean(search.ok),
    });
    sendJson(res, search.ok ? 200 : 400, {
      ...search,
      text: memorySearchText(search),
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/agent-tools/memory/read') {
    const agentId = url.searchParams.get('agentId') || '';
    const targetAgentRef = url.searchParams.get('targetAgentId') || url.searchParams.get('targetAgent') || '';
    const targetAgent = findAgent(targetAgentRef) || (state.agents || []).find((agent) => agent.name === targetAgentRef);
    if (!targetAgent) {
      sendError(res, 404, 'Target agent not found.');
      return true;
    }
    try {
      const file = await readAgentMemoryFile(targetAgent, url.searchParams.get('path') || 'MEMORY.md');
      addSystemEvent('agent_memory_read', `${displayActor(agentId) || 'Agent'} read ${targetAgent.name} memory.`, {
        agentId,
        targetAgentId: targetAgent.id,
        path: file.file.path,
      });
      sendJson(res, 200, {
        ok: true,
        ...file,
        text: [
          `@${targetAgent.name} ${file.file.path}`,
          file.file.content,
        ].join('\n'),
      });
    } catch (error) {
      sendError(res, error.status || 400, error.message);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent-tools/memory') {
    const body = await readJson(req);
    const agent = findAgent(String(body.agentId || ''));
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    const summary = String(body.summary || body.content || '').trim();
    if (!summary) {
      sendError(res, 400, 'Memory summary is required.');
      return true;
    }
    const allowedKinds = new Set(['capability', 'communication_style', 'preference', 'memory']);
    const kind = allowedKinds.has(String(body.kind || '')) ? String(body.kind) : 'memory';
    const sourceMessage = body.messageId ? findConversationRecord(String(body.messageId)) : null;
    await writeAgentMemoryUpdate(agent, 'agent_memory_tool', {
      message: sourceMessage || null,
      spaceType: sourceMessage?.spaceType || null,
      spaceId: sourceMessage?.spaceId || null,
      memory: {
        kind,
        summary,
        sourceText: String(body.sourceText || body.source || '').trim() || summary,
      },
    });
    await persistState();
    broadcastState();
    sendJson(res, 200, {
      ok: true,
      text: `Memory updated for ${agent.name}.`,
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent-tools/messages/send') {
    const traceId = makeId ? makeId('tool') : `tool_${Date.now().toString(36)}`;
    const startedAt = Date.now();
    const fail = (status, message, extra = {}) => {
      addSystemEvent('agent_tool_send_message_failed', `send_message failed: ${message}`, {
        traceId,
        status,
        durationMs: Date.now() - startedAt,
        ...extra,
      });
      persistState().then(broadcastState).catch(() => {});
      sendError(res, status, message);
      return true;
    };
    const body = await readJson(req);
    const rawAgentId = String(body.agentId || '');
    const rawWorkItemId = String(body.workItemId || body.work_item_id || '');
    const rawTarget = String(body.target || '');
    const rawContent = String(body.content || '');
    addSystemEvent('agent_tool_send_message_started', 'send_message request received.', {
      traceId,
      agentId: rawAgentId || null,
      workItemId: rawWorkItemId || null,
      target: rawTarget || null,
      contentLength: rawContent.trim().length,
    });
    const agent = findAgent(String(body.agentId || ''));
    if (!agent) {
      return fail(404, 'Agent not found.', {
        agentId: rawAgentId || null,
        workItemId: rawWorkItemId || null,
      });
    }
    const workItem = findWorkItem(String(body.workItemId || body.work_item_id || ''));
    if (!workItem) {
      return fail(404, 'Work item not found.', {
        agentId: agent.id,
        workItemId: rawWorkItemId || null,
      });
    }
    if (workItem.agentId !== agent.id) {
      return fail(403, 'Work item belongs to a different agent.', {
        agentId: agent.id,
        workItemId: workItem.id,
        ownerAgentId: workItem.agentId,
      });
    }
    if (workItem.status === 'cancelled') {
      return fail(409, 'Work item was stopped by the user.', {
        agentId: agent.id,
        workItemId: workItem.id,
      });
    }
    const content = String(body.content || '').trim();
    if (!content) {
      return fail(400, 'Message content is required.', {
        agentId: agent.id,
        workItemId: workItem.id,
      });
    }
    let target;
    try {
      target = resolveMessageTarget(body.target || workItem.target);
      if (!workItemTargetMatches(workItem, target)) {
        throw httpError(409, 'Target does not match the work item conversation.');
      }
    } catch (error) {
      return fail(error.status || 400, error.message, {
        agentId: agent.id,
        workItemId: workItem.id,
        target: rawTarget || workItem.target || null,
      });
    }

    // send_message is tied to the work item target so an Agent cannot post into
    // another channel or thread just by guessing a conversation id.
    const sourceMessage = findConversationRecord(workItem.sourceMessageId);
    try {
      const posted = await postAgentResponse(agent, target.spaceType, target.spaceId, content, target.parentMessageId || null, {
        sourceMessage,
      });
      markWorkItemResponded(workItem, target.label, posted);
      addSystemEvent('agent_tool_send_message', `${agent.name} sent a routed message to ${target.label}.`, {
        traceId,
        agentId: agent.id,
        workItemId: workItem.id,
        target: target.label,
        responseId: posted?.id || null,
        durationMs: Date.now() - startedAt,
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
    } catch (error) {
      return fail(error.status || 500, error.message || 'Failed to send message.', {
        agentId: agent.id,
        workItemId: workItem.id,
        target: target.label,
      });
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/agent-tools/tasks') {
    const agentId = url.searchParams.get('agentId') || '';
    let scope = null;
    if (url.searchParams.get('target') || url.searchParams.get('channel') || url.searchParams.get('spaceType') || url.searchParams.get('spaceId')) {
      try {
        scope = resolveConversationSpace({
          target: url.searchParams.get('target') || '',
          channel: url.searchParams.get('channel') || '',
          spaceType: url.searchParams.get('spaceType') || '',
          spaceId: url.searchParams.get('spaceId') || '',
        });
      } catch (error) {
        sendError(res, error.status || 400, error.message);
        return true;
      }
    }
    const status = String(url.searchParams.get('status') || '').trim();
    const assigneeId = String(url.searchParams.get('assigneeId') || '').trim();
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 25)));
    const tasks = (state.tasks || [])
      .filter((task) => !scope || (task.spaceType === scope.spaceType && task.spaceId === scope.spaceId))
      .filter((task) => !status || task.status === status)
      .filter((task) => !assigneeId || (task.assigneeIds || []).includes(assigneeId))
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
      .slice(0, limit);
    addSystemEvent('agent_tasks_listed', `${displayActor(agentId) || 'Agent'} listed tasks.`, {
      agentId,
      target: scope?.label || null,
      status: status || null,
      assigneeId: assigneeId || null,
      resultCount: tasks.length,
    });
    sendJson(res, 200, {
      ok: true,
      tasks,
      text: tasks.length ? [
        `Tasks${scope ? ` in ${scope.label}` : ''}:`,
        ...tasks.map((task) => {
          const assignees = (task.assigneeIds || []).map((id) => displayActor(id) || id).join(', ') || 'unassigned';
          return `${taskLabel(task)} [${task.status || 'todo'}] ${task.title || '(untitled)'} - assignee ${assignees}`;
        }),
      ].join('\n') : `No tasks${scope ? ` in ${scope.label}` : ''}.`,
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
