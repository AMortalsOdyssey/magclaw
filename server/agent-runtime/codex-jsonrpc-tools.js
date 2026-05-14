function nextCodexRequestId(proc) {
  proc.requestId = Number(proc.requestId || 0) + 1;
  return proc.requestId;
}

function sendCodexAppServerRequest(proc, method, params = {}) {
  if (!proc.child?.stdin?.writable) return null;
  const id = nextCodexRequestId(proc);
  const agent = findAgent(proc.agentId);
  const summary = summarizeCodexRequest(method, params);
  proc.pendingAppServerRequests = proc.pendingAppServerRequests || new Map();
  proc.pendingAppServerRequests.set(id, {
    method,
    summary,
    startedAt: Date.now(),
  });
  addSystemEvent('agent_codex_request_sent', `${agent?.name || proc.agentId} sent Codex ${method}.`, {
    agentId: proc.agentId,
    requestId: id,
    ...summary,
  });
  proc.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return id;
}

function sendCodexAppServerNotification(proc, method, params = {}) {
  if (!proc.child?.stdin?.writable) return;
  const agent = findAgent(proc.agentId);
  addSystemEvent('agent_codex_notification_sent', `${agent?.name || proc.agentId} sent Codex notification ${method}.`, {
    agentId: proc.agentId,
    method,
    threadId: params.threadId || null,
    turnId: params.turnId || null,
  });
  proc.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

function sendCodexAppServerResponse(proc, id, result = {}) {
  if (!proc.child?.stdin?.writable || id === undefined || id === null) return false;
  proc.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  return true;
}

function sendCodexAppServerError(proc, id, code, message, data = null) {
  if (!proc.child?.stdin?.writable || id === undefined || id === null) return false;
  proc.child.stdin.write(JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: {
      code,
      message: String(message || 'Request failed.'),
      ...(data ? { data } : {}),
    },
  }) + '\n');
  return true;
}

function recordCodexRequestCompleted(agent, proc, requestId, result = null) {
  const pending = proc.pendingAppServerRequests?.get(requestId);
  if (!pending) return;
  proc.pendingAppServerRequests.delete(requestId);
  addSystemEvent('agent_codex_request_completed', `${agent.name} Codex ${pending.method} completed.`, {
    agentId: agent.id,
    requestId,
    method: pending.method,
    durationMs: Date.now() - pending.startedAt,
    threadId: result?.thread?.id || pending.summary?.threadId || null,
    turnId: result?.turn?.id || result?.turnId || pending.summary?.turnId || null,
  });
}

function recordCodexRequestFailed(agent, proc, requestId, error = {}) {
  const pending = proc.pendingAppServerRequests?.get(requestId);
  if (pending) proc.pendingAppServerRequests.delete(requestId);
  addSystemEvent('agent_codex_request_failed', `${agent.name} Codex ${pending?.method || 'request'} failed: ${error.message || 'unknown error'}`, {
    agentId: agent.id,
    requestId,
    method: pending?.method || null,
    durationMs: pending ? Date.now() - pending.startedAt : null,
    raw: error,
  });
}

function localToolText(data) {
  if (typeof data?.text === 'string' && data.text.trim()) return data.text;
  return JSON.stringify(data ?? {}, null, 2);
}

function dynamicToolContentResult(text) {
  return {
    contentItems: [
      { type: 'inputText', text: String(text || '') },
    ],
  };
}

function mcpElicitationToolName(params = {}) {
  const meta = params?._meta || {};
  const explicitName = meta.tool_name || meta.toolName || meta.tool || meta.name;
  if (explicitName) return String(explicitName);
  const match = /tool\s+"([^"]+)"/i.exec(String(params?.message || ''));
  return match?.[1] || '';
}

function shouldAutoApproveMagClawElicitation(params = {}) {
  if (String(params?.serverName || '') !== 'magclaw') return false;
  if (params?._meta?.codex_approval_kind !== 'mcp_tool_call') return false;
  return Boolean(canonicalMagClawToolName(mcpElicitationToolName(params)));
}

async function requestMagClawLocalTool(pathname, { method = 'GET', query = {}, body = null } = {}) {
  const url = new URL(`http://${HOST}:${PORT}${pathname}`);
  for (const [key, value] of Object.entries(query || {})) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { text };
    }
    if (!response.ok) {
      const message = data?.error || data?.message || text || `HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function executeMagClawLocalTool(agent, name, args = {}) {
  const tool = canonicalMagClawToolName(name);
  if (!tool) throw new Error(`Unsupported MagClaw tool: ${name || '(unnamed)'}`);
  const agentId = agent.id;
  if (tool === 'send_message') {
    return requestMagClawLocalTool('/api/agent-tools/messages/send', {
      method: 'POST',
      body: {
        agentId,
        workItemId: args.workItemId || args.work_item_id,
        target: args.target,
        content: args.content,
      },
    });
  }
  if (tool === 'read_history') {
    return requestMagClawLocalTool('/api/agent-tools/history', {
      query: {
        agentId,
        target: args.target || args.channel,
        limit: args.limit,
        around: args.around,
        before: args.before,
        after: args.after,
      },
    });
  }
  if (tool === 'search_messages') {
    return requestMagClawLocalTool('/api/agent-tools/search', {
      query: {
        agentId,
        query: args.query || args.q,
        target: args.target || args.channel,
        limit: args.limit,
      },
    });
  }
  if (tool === 'search_agent_memory') {
    return requestMagClawLocalTool('/api/agent-tools/memory/search', {
      query: {
        agentId,
        query: args.query || args.q,
        targetAgentId: args.targetAgentId || args.targetAgent,
        limit: args.limit,
      },
    });
  }
  if (tool === 'read_agent_memory') {
    return requestMagClawLocalTool('/api/agent-tools/memory/read', {
      query: {
        agentId,
        targetAgentId: args.targetAgentId || args.targetAgent,
        path: args.path,
      },
    });
  }
  if (tool === 'write_memory') {
    return requestMagClawLocalTool('/api/agent-tools/memory', {
      method: 'POST',
      body: {
        agentId,
        kind: args.kind,
        summary: args.summary || args.content,
        sourceText: args.sourceText || args.source,
        messageId: args.messageId,
      },
    });
  }
  if (tool === 'list_tasks') {
    return requestMagClawLocalTool('/api/agent-tools/tasks', {
      query: {
        agentId,
        channel: args.channel,
        target: args.target,
        status: args.status,
        assigneeId: args.assigneeId === 'me' ? agentId : args.assigneeId,
        limit: args.limit,
      },
    });
  }
  if (tool === 'create_tasks') {
    return requestMagClawLocalTool('/api/agent-tools/tasks', {
      method: 'POST',
      body: { ...args, agentId: args.agentId || agentId },
    });
  }
  if (tool === 'claim_tasks') {
    return requestMagClawLocalTool('/api/agent-tools/tasks/claim', {
      method: 'POST',
      body: { ...args, agentId: args.agentId || agentId },
    });
  }
  if (tool === 'update_task_status') {
    return requestMagClawLocalTool('/api/agent-tools/tasks/update', {
      method: 'POST',
      body: {
        agentId,
        taskId: args.taskId,
        taskNumber: args.taskNumber,
        channel: args.channel,
        status: args.status || args.nextStatus,
        force: args.force,
      },
    });
  }
  if (tool === 'propose_channel_members') {
    return requestMagClawLocalTool('/api/agent-tools/channel-member-proposals', {
      method: 'POST',
      body: {
        ...args,
        agentId: args.agentId || agentId,
      },
    });
  }
  throw new Error(`Unsupported MagClaw tool: ${tool}`);
}

function dynamicToolRequestInfo(proc, params = {}) {
  const item = params.item || params;
  const callId = codexToolCallId(item) || String(params.callId || params.call_id || '');
  const pending = callId ? proc.pendingMcpToolCalls?.get(callId) : null;
  const rawArgs = codexToolArguments(item);
  const textArgs = parseToolArguments(params.inputText || params.input_text);
  const args = Object.keys(rawArgs).length
    ? rawArgs
    : (Object.keys(textArgs).length ? textArgs : (pending?.arguments || {}));
  const name = codexToolName(item) || pending?.name || '';
  return {
    callId,
    turnId: params.turnId || params.turn_id || null,
    name,
    canonicalName: canonicalMagClawToolName(name),
    args,
  };
}

async function handleCodexDynamicToolCallRequest(agent, proc, message) {
  const info = dynamicToolRequestInfo(proc, message.params || {});
  if (!info.canonicalName) {
    addSystemEvent('agent_dynamic_tool_call_failed', `${agent.name} received an unsupported dynamic tool request.`, {
      agentId: agent.id,
      requestId: message.id,
      toolCallId: info.callId || null,
      name: info.name || null,
      raw: message.params || null,
    });
    sendCodexAppServerError(proc, message.id, -32602, `Unsupported dynamic tool request: ${info.name || '(unnamed)'}`);
    return true;
  }
  const startedAt = Date.now();
  addSystemEvent('agent_dynamic_tool_call_started', `${agent.name} executing ${info.canonicalName} for Codex app-server.`, {
    agentId: agent.id,
    requestId: message.id,
    toolCallId: info.callId || null,
    turnId: info.turnId,
    ...summarizeToolArguments(info.canonicalName, info.args),
  });
  try {
    const data = await executeMagClawLocalTool(agent, info.canonicalName, info.args);
    const result = dynamicToolContentResult(localToolText(data));
    sendCodexAppServerResponse(proc, message.id, result);
    if (info.callId) {
      recordCodexToolCallCompleted(agent, proc, {
        id: info.callId,
        type: 'mcpToolCall',
        name: info.canonicalName,
        arguments: info.args,
      });
    }
    touchAgentRunProgress(agent, proc, 'dynamic_tool_response', { turnId: info.turnId });
    addSystemEvent('agent_dynamic_tool_call_completed', `${agent.name} completed ${info.canonicalName} for Codex app-server.`, {
      agentId: agent.id,
      requestId: message.id,
      toolCallId: info.callId || null,
      turnId: info.turnId,
      durationMs: Date.now() - startedAt,
      ...summarizeToolArguments(info.canonicalName, info.args),
    });
  } catch (error) {
    sendCodexAppServerError(proc, message.id, error.status || 1, error.message || 'Tool call failed.', error.data || null);
    addSystemEvent('agent_dynamic_tool_call_failed', `${agent.name} failed ${info.canonicalName}: ${error.message}`, {
      agentId: agent.id,
      requestId: message.id,
      toolCallId: info.callId || null,
      turnId: info.turnId,
      durationMs: Date.now() - startedAt,
      status: error.status || null,
      ...summarizeToolArguments(info.canonicalName, info.args),
    });
  }
  await persistState();
  broadcastState();
  return true;
}

async function handleCodexMcpServerElicitationRequest(agent, proc, message) {
  const params = message.params || {};
  const toolName = mcpElicitationToolName(params);
  const canonicalName = canonicalMagClawToolName(toolName);
  const approve = shouldAutoApproveMagClawElicitation(params);
  const eventType = approve ? 'agent_mcp_elicitation_auto_approved' : 'agent_mcp_elicitation_declined';
  addSystemEvent(eventType, approve
    ? `${agent.name} auto-approved MagClaw MCP tool ${canonicalName}.`
    : `${agent.name} declined unsupported MCP elicitation ${toolName || params.serverName || 'unknown'}.`, {
      agentId: agent.id,
      requestId: message.id,
      serverName: params.serverName || null,
      toolName: toolName || null,
      canonicalName: canonicalName || null,
      turnId: params.turnId || null,
      threadId: params.threadId || null,
      raw: params,
    });
  sendCodexAppServerResponse(proc, message.id, {
    action: approve ? 'accept' : 'decline',
  });
  touchAgentRunProgress(agent, proc, approve ? 'mcp_elicitation_auto_approved' : 'mcp_elicitation_declined', {
    turnId: params.turnId || null,
  });
  await persistState();
  broadcastState();
  return true;
}
