// Agent tool API routes.
// These endpoints are called by running Agents, not by the human UI. They let an
// Agent inspect bounded history, send a routed response tied to a work item, and
// create/claim/update tasks without reaching across channel boundaries.

export async function handleAgentToolApi(req, res, url, deps) {
  const {
    addSystemEvent,
    broadcastState,
    cancelReminder,
    claimTask,
    createReminder,
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
    now,
    persistState,
    postAgentResponse,
    readAgentHistory,
    readAgentMemoryFile,
    readJson,
    resolveConversationSpace,
    resolveMessageTarget,
    listReminders,
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
  const TASK_CREATE_DEDUPE_WINDOW_MS = 5 * 60 * 1000;

  function headerValue(name) {
    const headers = req.headers || {};
    const lower = name.toLowerCase();
    return headers[name] || headers[lower] || '';
  }

  function requestWorkspaceId() {
    return String(
      req.daemonAuth?.workspaceId
      || headerValue('x-magclaw-workspace-id')
      || state.connection?.workspaceId
      || '',
    ).trim();
  }

  function workspaceMatches(record, workspaceId = requestWorkspaceId()) {
    const target = String(workspaceId || '').trim();
    if (!target) return true;
    const recordWorkspace = String(record?.workspaceId || '').trim();
    if (recordWorkspace) return recordWorkspace === target;
    const stateWorkspace = String(state.connection?.workspaceId || '').trim();
    return Boolean(stateWorkspace && stateWorkspace === target);
  }

  function compactText(value, limit = 240) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length <= limit) return text;
    return `${text.slice(0, Math.max(0, limit - 1)).trim()}...`;
  }

  function runtimeLabel(agent) {
    return compactText(agent?.runtimeId || agent?.runtime || agent?.model || 'unknown', 80);
  }

  function normalizedTaskText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function taskTimeMs(task) {
    const value = task?.createdAt || task?.updatedAt || '';
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : 0;
  }

  function currentTimeMs() {
    const value = typeof now === 'function' ? now() : new Date().toISOString();
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : Date.now();
  }

  function taskBodyMatches(task, bodyText) {
    const requested = normalizedTaskText(bodyText);
    const existing = normalizedTaskText(task?.body || '');
    if (!requested && !existing) return true;
    if (!requested || !existing) return false;
    return requested === existing;
  }

  function taskIsReusable(task) {
    return Boolean(task && !['done', 'closed', 'stopped'].includes(String(task.status || '').toLowerCase()));
  }

  function duplicateTaskResult(task, space, reused = true) {
    return {
      task,
      message: findMessage(task.messageId) || null,
      taskNumber: task.number,
      messageId: task.messageId || null,
      title: task.title,
      threadTarget: `${space.label}:${task.threadMessageId || task.messageId || task.id}`,
      reused,
    };
  }

  function findDuplicateAgentTask({ agent, space, title, bodyText = '', sourceMessageId = '', sourceReplyId = '' }) {
    const normalizedTitle = normalizedTaskText(title);
    if (!normalizedTitle) return null;
    const sourceId = String(sourceMessageId || '').trim();
    const replyId = String(sourceReplyId || '').trim();
    const requestMs = currentTimeMs();
    return (state.tasks || []).find((task) => {
      if (!taskIsReusable(task)) return false;
      if (task.spaceType !== space.spaceType || task.spaceId !== space.spaceId) return false;
      if (normalizedTaskText(task.title) !== normalizedTitle) return false;
      if (!taskBodyMatches(task, bodyText)) return false;
      if (sourceId || replyId) {
        return String(task.sourceMessageId || '') === sourceId
          && String(task.sourceReplyId || '') === replyId;
      }
      if (String(task.createdBy || '') !== agent.id) return false;
      const ageMs = requestMs - taskTimeMs(task);
      return ageMs >= 0 && ageMs <= TASK_CREATE_DEDUPE_WINDOW_MS;
    }) || null;
  }

  function findHumanName(id) {
    return (state.humans || []).find((human) => human.id === id)?.name || '';
  }

  function agentChannelNames(agent, workspaceId = requestWorkspaceId()) {
    if (!agent?.id) return [];
    return (state.channels || [])
      .filter((channel) => workspaceMatches(channel, workspaceId))
      .filter((channel) => channelHasMember(channel, agent.id))
      .map((channel) => `#${channel.name || channel.id}`)
      .slice(0, 12);
  }

  function publicAgentSummary(agent, { detailed = false } = {}) {
    const creatorId = agent.ownerId || agent.createdBy || agent.creatorId || '';
    return {
      id: agent.id,
      name: agent.name || agent.id,
      description: compactText(agent.description || '', detailed ? 1200 : 260),
      runtime: agent.runtime || '',
      runtimeId: agent.runtimeId || '',
      runtimeLabel: runtimeLabel(agent),
      status: agent.status || '',
      model: compactText(agent.model || agent.defaultModel || '', 120),
      reasoningEffort: agent.reasoningEffort || '',
      systemRole: compactText(agent.systemRole || agent.role || '', detailed ? 500 : 160),
      creatorId,
      creatorName: findHumanName(creatorId) || displayActor(creatorId) || creatorId || '',
      createdAt: agent.createdAt || '',
      updatedAt: agent.updatedAt || '',
      channels: agentChannelNames(agent),
    };
  }

  function renderAgentSummaryLine(agent) {
    const summary = publicAgentSummary(agent);
    const pieces = [
      `@${summary.name} (${summary.id})`,
      `runtime=${summary.runtimeLabel}`,
      summary.status ? `status=${summary.status}` : '',
      summary.description ? `desc=${summary.description}` : '',
      summary.channels?.length ? `channels=${summary.channels.join(',')}` : '',
    ].filter(Boolean);
    return `- ${pieces.join(' | ')}`;
  }

  function renderAgentProfile(summary) {
    return [
      `@${summary.name} (${summary.id})`,
      `Runtime: ${summary.runtimeLabel}`,
      summary.status ? `Status: ${summary.status}` : '',
      summary.description ? `Description: ${summary.description}` : '',
      summary.systemRole ? `Role: ${summary.systemRole}` : '',
      summary.model ? `Model: ${summary.model}` : '',
      summary.reasoningEffort ? `Reasoning: ${summary.reasoningEffort}` : '',
      summary.creatorName ? `Creator: ${summary.creatorName}` : '',
      summary.createdAt ? `Created: ${summary.createdAt}` : '',
      summary.updatedAt ? `Updated: ${summary.updatedAt}` : '',
      summary.channels?.length ? `Channels: ${summary.channels.join(', ')}` : '',
    ].filter(Boolean).join('\n');
  }

  function targetChannelFromQuery(workspaceId = requestWorkspaceId()) {
    const raw = String(url.searchParams.get('target') || url.searchParams.get('channel') || '').trim();
    if (!raw) return null;
    const channelRef = raw.match(/^#([^:]+)(?::.+)?$/)?.[1] || raw.replace(/^#/, '').split(':')[0];
    return (state.channels || []).find((channel) => (
      workspaceMatches(channel, workspaceId)
      && (channel.id === channelRef || channel.id.startsWith(channelRef) || channel.name === channelRef)
    )) || null;
  }

  function workspaceAgents(workspaceId = requestWorkspaceId()) {
    return (state.agents || []).filter((agent) => workspaceMatches(agent, workspaceId));
  }

  function findWorkspaceAgent(ref, workspaceId = requestWorkspaceId()) {
    const value = String(ref || '').trim();
    if (!value) return null;
    return workspaceAgents(workspaceId).find((agent) => (
      agent.id === value
      || agent.id.startsWith(value)
      || agent.name === value
      || `@${agent.name}` === value
    )) || null;
  }

  function resolveProposalChannel(body = {}) {
    const channelRef = String(body.channelId || body.channel_id || '').trim();
    if (channelRef) {
      const channel = (state.channels || []).find((item) => item.id === channelRef || item.id.startsWith(channelRef));
      if (!channel) throw httpError(404, `Channel not found: ${channelRef}`);
      return channel;
    }
    const space = resolveConversationSpace(body);
    if (space.spaceType !== 'channel') throw httpError(400, 'Channel member proposals require a channel target.');
    return (state.channels || []).find((item) => item.id === space.spaceId);
  }

  function findMember(id) {
    return (state.humans || []).find((human) => human.id === id)
      || (state.agents || []).find((agent) => agent.id === id)
      || null;
  }

  function channelHasMember(channel, memberId) {
    return [
      ...(Array.isArray(channel.memberIds) ? channel.memberIds : []),
      ...(Array.isArray(channel.humanIds) ? channel.humanIds : []),
      ...(Array.isArray(channel.agentIds) ? channel.agentIds : []),
    ].includes(memberId);
  }

  if (req.method === 'GET' && url.pathname === '/api/agent-tools/reminders') {
    const agentId = url.searchParams.get('agentId') || '';
    const result = typeof listReminders === 'function'
      ? listReminders({
        agentId,
        status: url.searchParams.get('status') || '',
        limit: url.searchParams.get('limit') || undefined,
      })
      : {
        ok: true,
        reminders: (state.reminders || []).filter((reminder) => (
          (!agentId || reminder.ownerAgentId === agentId || reminder.createdBy === agentId)
          && (!url.searchParams.get('status') || reminder.status === url.searchParams.get('status'))
        )),
      };
    const reminders = result.reminders || [];
    addSystemEvent('agent_reminders_listed', `${displayActor(agentId) || 'Agent'} listed reminders.`, {
      agentId,
      status: url.searchParams.get('status') || null,
      resultCount: reminders.length,
    });
    sendJson(res, 200, {
      ok: true,
      reminders,
      text: result.text || (reminders.length
        ? [
          'Reminders:',
          ...reminders.map((reminder) => `#${String(reminder.id || '').split('_').pop() || reminder.id} [${reminder.status}] ${reminder.fireAt} "${reminder.title}"`),
        ].join('\n')
        : 'No reminders.'),
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent-tools/reminders') {
    const body = await readJson(req);
    const agent = findAgent(String(body.agentId || ''));
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    try {
      const result = createReminder({
        ...body,
        agentId: agent.id,
      });
      addSystemEvent('agent_tool_schedule_reminder', `${agent.name} scheduled a reminder.`, {
        agentId: agent.id,
        reminderId: result.reminder?.id || null,
        fireAt: result.reminder?.fireAt || null,
      });
      await persistState();
      broadcastState();
      sendJson(res, 201, result);
    } catch (error) {
      sendError(res, error.status || 400, error.message);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent-tools/reminders/cancel') {
    const body = await readJson(req);
    const agent = findAgent(String(body.agentId || ''));
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    try {
      const result = cancelReminder({
        ...body,
        agentId: agent.id,
      });
      await persistState();
      broadcastState();
      sendJson(res, 200, result);
    } catch (error) {
      sendError(res, error.status || 400, error.message);
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/agent-tools/agents') {
    const agentId = url.searchParams.get('agentId') || '';
    const workspaceId = requestWorkspaceId();
    const query = compactText(url.searchParams.get('q') || url.searchParams.get('query') || '', 120).toLowerCase();
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit') || 20)));
    const channel = targetChannelFromQuery(workspaceId);
    const channelAgentIds = channel
      ? new Set([
        ...(Array.isArray(channel.agentIds) ? channel.agentIds : []),
        ...(Array.isArray(channel.memberIds) ? channel.memberIds : []),
      ])
      : null;
    const agents = workspaceAgents(workspaceId)
      .filter((agent) => agent.id !== agentId)
      .filter((agent) => !channelAgentIds || channelAgentIds.has(agent.id))
      .filter((agent) => {
        if (!query) return true;
        return [
          agent.name,
          agent.id,
          agent.description,
          agent.runtime,
          agent.runtimeId,
          agent.model,
          agent.systemRole,
        ].some((value) => String(value || '').toLowerCase().includes(query));
      })
      .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)))
      .slice(0, limit);
    addSystemEvent('agent_profiles_listed', `${displayActor(agentId) || 'Agent'} listed agent profiles.`, {
      agentId,
      workspaceId: workspaceId || null,
      target: channel ? `#${channel.name || channel.id}` : null,
      query: query || null,
      resultCount: agents.length,
    });
    sendJson(res, 200, {
      ok: true,
      workspaceId: workspaceId || null,
      count: agents.length,
      agents: agents.map((agent) => publicAgentSummary(agent)),
      text: agents.length
        ? [
          `Agent profiles${channel ? ` in #${channel.name || channel.id}` : ''}:`,
          ...agents.map(renderAgentSummaryLine),
        ].join('\n')
        : `No matching agents${channel ? ` in #${channel.name || channel.id}` : ''}.`,
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/agent-tools/agents/read') {
    const agentId = url.searchParams.get('agentId') || '';
    const workspaceId = requestWorkspaceId();
    const targetAgentRef = url.searchParams.get('targetAgentId') || url.searchParams.get('targetAgent') || '';
    const targetAgent = findWorkspaceAgent(targetAgentRef, workspaceId);
    if (!targetAgent) {
      sendError(res, 404, 'Target agent not found.');
      return true;
    }
    const summary = publicAgentSummary(targetAgent, { detailed: true });
    addSystemEvent('agent_profile_read', `${displayActor(agentId) || 'Agent'} read ${targetAgent.name} profile.`, {
      agentId,
      workspaceId: workspaceId || null,
      targetAgentId: targetAgent.id,
    });
    sendJson(res, 200, {
      ok: true,
      workspaceId: workspaceId || null,
      agent: summary,
      text: renderAgentProfile(summary),
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/agent-tools/history') {
    const agentId = url.searchParams.get('agentId') || '';
    const workspaceId = requestWorkspaceId();
    const history = readAgentHistory(state, {
      target: url.searchParams.get('target') || url.searchParams.get('channel') || '#all',
      limit: url.searchParams.get('limit') || undefined,
      around: url.searchParams.get('around') || undefined,
      before: url.searchParams.get('before') || undefined,
      after: url.searchParams.get('after') || undefined,
      workspaceId,
    });
    addSystemEvent('agent_history_read', `${displayActor(agentId) || 'Agent'} read ${history.target || 'history'}.`, {
      agentId,
      workspaceId: workspaceId || null,
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
    const workspaceId = requestWorkspaceId();
    const search = searchAgentMessageHistory(state, {
      query: url.searchParams.get('q') || url.searchParams.get('query') || '',
      target: url.searchParams.get('target') || url.searchParams.get('channel') || '#all',
      limit: url.searchParams.get('limit') || undefined,
      workspaceId,
    });
    addSystemEvent('agent_history_search', `${displayActor(agentId) || 'Agent'} searched message history.`, {
      agentId,
      workspaceId: workspaceId || null,
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
    const workspaceId = requestWorkspaceId();
    const targetAgentId = url.searchParams.get('targetAgentId') || url.searchParams.get('targetAgent') || '';
    const search = await searchAgentMemory(url.searchParams.get('q') || url.searchParams.get('query') || '', {
      targetAgentId,
      limit: url.searchParams.get('limit') || undefined,
      workspaceId,
    });
    addSystemEvent('agent_memory_search', `${displayActor(agentId) || 'Agent'} searched agent memory.`, {
      agentId,
      workspaceId: workspaceId || null,
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
    const workspaceId = requestWorkspaceId();
    const targetAgentRef = url.searchParams.get('targetAgentId') || url.searchParams.get('targetAgent') || '';
    const targetAgent = findWorkspaceAgent(targetAgentRef, workspaceId)
      || (() => {
        const agent = findAgent(targetAgentRef);
        return agent && workspaceMatches(agent, workspaceId) ? agent : null;
      })();
    if (!targetAgent) {
      sendError(res, 404, 'Target agent not found.');
      return true;
    }
    try {
      const file = await readAgentMemoryFile(targetAgent, url.searchParams.get('path') || 'MEMORY.md');
      addSystemEvent('agent_memory_read', `${displayActor(agentId) || 'Agent'} read ${targetAgent.name} memory.`, {
        agentId,
        workspaceId: workspaceId || null,
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
    if (workItem.status === 'stopped') {
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
    const previousResponse = workItem.lastResponseId ? findConversationRecord(workItem.lastResponseId) : null;
    if (
      previousResponse
      && workItem.sendCount > 0
      && workItem.lastSentTarget === target.label
      && previousResponse.authorType === 'agent'
      && previousResponse.authorId === agent.id
      && String(previousResponse.body || '').trim() === content
    ) {
      addSystemEvent('agent_tool_send_message_deduped', `${agent.name} repeated the same routed message to ${target.label}.`, {
        traceId,
        agentId: agent.id,
        workItemId: workItem.id,
        target: target.label,
        responseId: previousResponse.id,
        durationMs: Date.now() - startedAt,
      });
      await persistState();
      broadcastState();
      sendJson(res, 200, {
        ok: true,
        deduped: true,
        target: target.label,
        workItemId: workItem.id,
        workItem,
        message: previousResponse,
        text: `Message already sent to ${target.label}.`,
      });
      return true;
    }
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

  if (req.method === 'POST' && url.pathname === '/api/agent-tools/channel-member-proposals') {
    const body = await readJson(req);
    const agent = findAgent(String(body.agentId || ''));
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    let channel;
    try {
      channel = resolveProposalChannel(body);
      if (!channel) throw httpError(404, 'Channel not found.');
      if (!channelHasMember(channel, agent.id)) {
        throw httpError(403, 'Agent can only propose members for channels it belongs to.');
      }
    } catch (error) {
      sendError(res, error.status || 400, error.message);
      return true;
    }
    const requestedMemberIds = normalizeIds([
      ...(Array.isArray(body.memberIds) ? body.memberIds : []),
      ...(Array.isArray(body.member_ids) ? body.member_ids : []),
      ...(body.memberId ? [body.memberId] : []),
    ]);
    const memberIds = requestedMemberIds
      .filter((id) => findMember(id))
      .filter((id) => !channelHasMember(channel, id));
    if (!memberIds.length) {
      sendError(res, 400, 'No eligible non-channel members were proposed.');
      return true;
    }
    const signature = memberIds.slice().sort().join('|');
    const existing = (state.channelMemberProposals || []).find((proposal) => (
      proposal.status === 'pending'
      && proposal.channelId === channel.id
      && proposal.proposedBy === agent.id
      && normalizeIds(proposal.memberIds).sort().join('|') === signature
    ));
    if (existing) {
      sendJson(res, 200, {
        ok: true,
        deduped: true,
        proposal: existing,
        text: `Proposal already pending for #${channel.name}.`,
      });
      return true;
    }
    const createdAt = now();
    const proposal = {
      id: makeId('prop'),
      workspaceId: channel.workspaceId || state.connection?.workspaceId || 'local',
      channelId: channel.id,
      proposedBy: agent.id,
      memberIds,
      reason: String(body.reason || body.body || '').trim() || 'Agent suggested adding these members to the channel.',
      status: 'pending',
      reviewerId: null,
      sourceMessageId: body.messageId || body.sourceMessageId || null,
      createdAt,
      updatedAt: createdAt,
      reviewedAt: null,
      acceptedAt: null,
      declinedAt: null,
    };
    state.channelMemberProposals = Array.isArray(state.channelMemberProposals) ? state.channelMemberProposals : [];
    state.channelMemberProposals.unshift(proposal);
    addSystemEvent('channel_member_proposal_created', `${agent.name} proposed adding ${memberIds.length} member(s) to #${channel.name}.`, {
      agentId: agent.id,
      channelId: channel.id,
      proposalId: proposal.id,
      memberIds,
    });
    await persistState();
    broadcastState();
    sendJson(res, 201, {
      ok: true,
      proposal,
      text: `Suggested ${memberIds.length} member(s) for #${channel.name}. Waiting for human review.`,
    });
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
    let createdCount = 0;
    let reusedCount = 0;
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
        const title = input.title;
        const bodyText = String(input.body ?? body.body ?? '').trim();
        const sourceMessageId = input.sourceMessageId || body.sourceMessageId || null;
        const sourceReplyId = input.sourceReplyId || body.sourceReplyId || null;
        const duplicate = input.allowDuplicate === true || body.allowDuplicate === true
          ? null
          : findDuplicateAgentTask({
            agent,
            space,
            title,
            bodyText,
            sourceMessageId,
            sourceReplyId,
          });
        if (duplicate) {
          if (body.claim && (!duplicate.claimedBy || duplicate.claimedBy === agent.id || body.force === true)) {
            claimTask(duplicate, agent.id, { force: body.force });
          }
          reusedCount += 1;
          created.push(duplicateTaskResult(duplicate, space, true));
          continue;
        }
        const { message, task } = createTaskMessage({
          title,
          body: bodyText,
          ...space,
          authorType: 'agent',
          authorId: agent.id,
          assigneeIds,
          attachmentIds: Array.isArray(input.attachmentIds) ? input.attachmentIds : (Array.isArray(body.attachmentIds) ? body.attachmentIds : []),
          sourceMessageId,
          sourceReplyId,
        });
        if (body.claim) claimTask(task, agent.id, { force: body.force });
        createdCount += 1;
        created.push({
          task,
          message,
          taskNumber: task.number,
          messageId: message.id,
          title: task.title,
          threadTarget: `${space.label}:${message.id}`,
          reused: false,
        });
      }
    } catch (error) {
      sendError(res, error.status || 400, error.message);
      return true;
    }
    addSystemEvent('agent_tool_create_tasks', `${agent.name} created ${createdCount} task(s) and reused ${reusedCount} existing task(s).`, {
      agentId: agent.id,
      taskIds: created.map((item) => item.task.id),
      createdTaskIds: created.filter((item) => !item.reused).map((item) => item.task.id),
      reusedTaskIds: created.filter((item) => item.reused).map((item) => item.task.id),
      spaceType: space.spaceType,
      spaceId: space.spaceId,
    });
    await persistState();
    broadcastState();
    const summary = createdCount && reusedCount
      ? `Created ${createdCount} and reused ${reusedCount} task(s) in ${space.label}:`
      : (createdCount
        ? `Created ${createdCount} task(s) in ${space.label}:`
        : `Reused ${reusedCount} existing task(s) in ${space.label}:`);
    sendJson(res, createdCount ? 201 : 200, {
      ok: true,
      tasks: created,
      text: [
        summary,
        ...created.map((item) => `${taskLabel(item.task)} msg=${item.messageId}${item.reused ? ' reused=true' : ''} "${item.title}"`),
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
