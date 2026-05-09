async function handleCodexThreadReady(agent, proc, threadId) {
  const alreadyReady = proc.threadReady && proc.threadId === threadId;
  proc.threadId = threadId;
  proc.threadReady = true;
  agent.runtimeSessionId = threadId;
  await writeAgentSessionFile(agent).catch(() => {});
  if (!alreadyReady) {
    addSystemEvent('agent_session_ready', `${agent.name} Codex session ready`, { agentId: agent.id, sessionId: threadId });
  }
  if (proc.pendingInitialPrompt) {
    const prompt = proc.pendingInitialPrompt;
    const messages = proc.pendingInitialMessages || [];
    proc.pendingInitialPrompt = null;
    proc.pendingInitialMessages = [];
    if (startCodexAppServerTurn(agent, proc, prompt, { mode: 'turn', messages })) {
      proc.lastSourceMessage = messages[messages.length - 1] || proc.lastSourceMessage || null;
      markWorkItemsDelivered(messages, 'turn');
    }
  } else if (proc.status !== 'running' && !proc.activeTurnId && !proc.activeTurnIds?.size && !proc.pendingTurnRequests?.size) {
    proc.status = 'idle';
    setAgentStatus(agent, 'idle', 'codex_process_ready');
    if (!alreadyReady) {
      addSystemEvent('agent_process_ready', `${agent.name} is ready and waiting for messages.`, { agentId: agent.id, sessionId: threadId });
    }
  }
  await persistState();
  broadcastState();
}

function deliveryTargetKey(message) {
  if (!message) return '';
  const taskSuffix = message.taskId ? ` task=${message.taskId}` : '';
  if (message.target) return `${String(message.target)}${taskSuffix}`;
  if (message.spaceType && message.spaceId) {
    return `${targetForConversation(message.spaceType, message.spaceId, message.parentMessageId || null)}${taskSuffix}`;
  }
  return taskSuffix.trim();
}

function deliveryTargetKeys(messages) {
  return [...new Set((Array.isArray(messages) ? messages : [messages])
    .map(deliveryTargetKey)
    .filter(Boolean))];
}

function rememberActiveTurnTargets(proc, mode, targetKeys = []) {
  const keys = Array.isArray(targetKeys) ? targetKeys.filter(Boolean) : [];
  if (!keys.length) return;
  if (mode === 'steer') {
    proc.activeTurnTargets = proc.activeTurnTargets instanceof Set ? proc.activeTurnTargets : new Set();
    for (const key of keys) proc.activeTurnTargets.add(key);
    return;
  }
  proc.activeTurnTargets = new Set(keys);
}

function pendingMatchesActiveTurnTargets(proc, pendingMessages) {
  const activeTargets = proc?.activeTurnTargets instanceof Set ? proc.activeTurnTargets : new Set();
  if (!activeTargets.size) return false;
  const pendingKeys = deliveryTargetKeys(pendingMessages);
  if (!pendingKeys.length) return false;
  return pendingKeys.every((key) => activeTargets.has(key));
}

function deliveryParentMessageId(sourceMessage, fallbackParentMessageId = null) {
  if (sourceMessage) return sourceMessage.parentMessageId || null;
  return fallbackParentMessageId || null;
}

function applyAgentProcessDeliveryScope(proc, spaceType, spaceId, parentMessageId = null) {
  if (!proc) return;
  proc.spaceType = spaceType;
  proc.spaceId = spaceId;
  proc.parentMessageId = parentMessageId || null;
}

function startCodexAppServerTurn(agent, proc, prompt, { mode = 'turn', messages = [], runtimeOverride = null } = {}) {
  if (!proc.threadId) return false;
  const input = [{ type: 'text', text: prompt }];
  const runtime = runtimeOverride
    ? { ...runtimeOverride }
    : mode === 'steer' && proc.currentCodexRuntime
    ? proc.currentCodexRuntime
    : resolveCodexRuntime(agent, messages);
  const isWarmup = mode === 'warmup';
  let requestId = null;
  if (mode === 'steer' && proc.activeTurnId) {
    requestId = sendCodexAppServerRequest(proc, 'turn/steer', {
      threadId: proc.threadId,
      expectedTurnId: proc.activeTurnId,
      input,
    });
  } else {
    requestId = sendCodexAppServerRequest(proc, 'turn/start', {
      threadId: proc.threadId,
      input,
      model: runtime.model,
      ...(runtime.reasoningEffort ? { effort: runtime.reasoningEffort } : {}),
    });
  }
  if (!requestId) return false;
  const promptMessages = Array.isArray(messages) ? messages.filter(Boolean) : [];
  const sourceMessage = promptMessages[promptMessages.length - 1] || null;
  const targetKeys = deliveryTargetKeys(promptMessages);
  proc.pendingTurnRequests = proc.pendingTurnRequests || new Map();
  proc.pendingTurnRequests.set(requestId, {
    parentMessageId: deliveryParentMessageId(sourceMessage, proc.parentMessageId),
    sourceMessage,
    spaceType: sourceMessage?.spaceType || proc.spaceType,
    spaceId: sourceMessage?.spaceId || proc.spaceId,
    workItemIds: normalizeIds(promptMessages.map((message) => message?.workItemId)),
    targetKeys,
    runtime,
    warmup: isWarmup,
  });
  touchAgentRunProgress(agent, proc, `${mode}_request_sent`);
  rememberActiveTurnTargets(proc, mode, targetKeys);
  proc.currentCodexRuntime = runtime;
  proc.status = 'running';
  if (isWarmup) proc.warmupActive = true;
  setAgentStatus(agent, mode === 'steer' ? 'working' : (isWarmup ? 'warming' : 'thinking'), isWarmup ? 'agent_warmup_started' : (mode === 'steer' ? 'agent_steered' : 'agent_turn_started'), {
    activeWorkItemIds: normalizeIds(promptMessages.map((message) => message?.workItemId)),
    runtimeModel: runtime.model,
    runtimeReasoningEffort: runtime.reasoningEffort,
    runtimeOverrideReason: runtime.overrideReason,
  });
  addAgentRuntimeActivityEvent(agent, proc, 'agent_runtime_activity', mode === 'steer' ? 'working' : (isWarmup ? 'warming' : 'thinking'), isWarmup ? 'Hidden warmup turn started.' : (mode === 'steer' ? 'Queued message delivered to active runtime.' : 'Turn started.'), {
    sessionId: proc.threadId,
    model: runtime.model,
    reasoningEffort: runtime.reasoningEffort || null,
    mode,
    warmup: isWarmup,
  }, { broadcast: false });
  if (!isWarmup) {
    agent.runtimeLastTurnAt = now();
  } else {
    agent.runtimeWarmRequestedAt = now();
  }
  addSystemEvent(isWarmup ? 'agent_warmup_started' : (mode === 'steer' ? 'agent_steered' : 'agent_turn_started'), `${agent.name} ${isWarmup ? 'started a hidden warmup turn' : (mode === 'steer' ? 'received a steering message' : 'started a turn')}`, {
    agentId: agent.id,
    sessionId: proc.threadId,
    model: runtime.model,
    reasoningEffort: runtime.reasoningEffort,
    overrideReason: runtime.overrideReason,
  });
  persistState().then(broadcastState);
  return true;
}

async function sendCodexAppServerMessages(agent, proc, messages, { mode = 'turn' } = {}) {
  const promptMessages = Array.isArray(messages) ? messages.filter(Boolean) : [messages].filter(Boolean);
  if (!promptMessages.length) return false;
  const prompt = createAgentTurnPrompt(promptMessages, agent);
  const sent = mode === 'steer'
    ? startCodexAppServerTurn(agent, proc, prompt, { mode: 'steer', messages: promptMessages })
    : (proc.status === 'idle' && startCodexAppServerTurn(agent, proc, prompt, { mode: 'turn', messages: promptMessages }));
  if (!sent) return false;
  proc.inbox.push(...promptMessages);
  proc.promptMessageCount = proc.inbox.length;
  proc.lastSourceMessage = promptMessages[promptMessages.length - 1] || proc.lastSourceMessage || null;
  markWorkItemsDelivered(promptMessages, mode);
  return true;
}

function clearAgentBusyDeliveryTimer(proc) {
  if (!proc?.busyDeliveryTimer) return;
  clearTimeout(proc.busyDeliveryTimer);
  proc.busyDeliveryTimer = null;
}

function queueCodexBusyDelivery(agent, proc, deliveryMessage) {
  proc.pendingDeliveryMessages = Array.isArray(proc.pendingDeliveryMessages) ? proc.pendingDeliveryMessages : [];
  proc.pendingDeliveryMessages.push(deliveryMessage);
  addSystemEvent('message_queued', `Message queued for busy agent ${agent.name}`, {
    agentId: agent.id,
    messageId: deliveryMessage.id,
    parentMessageId: deliveryMessage.parentMessageId || null,
    workItemId: deliveryMessage.workItemId || null,
  });
  scheduleCodexBusyDelivery(agent, proc);
}

function scheduleCodexBusyDelivery(agent, proc) {
  if (!proc || proc.busyDeliveryTimer) return;
  proc.busyDeliveryTimer = setTimeout(() => {
    proc.busyDeliveryTimer = null;
    flushCodexPendingDeliveries(agent, proc).catch((error) => {
      addSystemEvent('delivery_error', `Failed to steer queued messages to ${agent.name}: ${error.message}`, {
        agentId: agent.id,
      });
    });
  }, AGENT_BUSY_DELIVERY_DELAY_MS);
}

async function flushCodexPendingDeliveries(agent, proc) {
  const pending = Array.isArray(proc?.pendingDeliveryMessages) ? proc.pendingDeliveryMessages : [];
  if (!pending.length) return false;
  if (!proc.child || proc.child.killed || !proc.threadId) {
    scheduleCodexBusyDelivery(agent, proc);
    return false;
  }
  const wantsSteer = proc.status === 'running' || proc.status === 'starting';
  if (wantsSteer && !proc.activeTurnId) {
    scheduleCodexBusyDelivery(agent, proc);
    return false;
  }
  if (wantsSteer && !pendingMatchesActiveTurnTargets(proc, pending)) {
    scheduleCodexBusyDelivery(agent, proc);
    return false;
  }
  const batch = pending.splice(0, pending.length);
  const mode = wantsSteer ? 'steer' : 'turn';
  const sent = await sendCodexAppServerMessages(agent, proc, batch, { mode });
  if (!sent) {
    proc.pendingDeliveryMessages = [...batch, ...(proc.pendingDeliveryMessages || [])];
    scheduleCodexBusyDelivery(agent, proc);
    return false;
  }
  addSystemEvent(mode === 'steer' ? 'agent_busy_batch_delivered' : 'agent_queue_turn_delivered', `${agent.name} received ${batch.length} queued message(s).`, {
    agentId: agent.id,
    count: batch.length,
    mode,
  });
  return true;
}

async function handleCodexTurnCompleted(agent, proc, turn) {
  const turnId = turn?.id || proc.activeTurnId;
  touchAgentRunProgress(agent, proc, 'turn_completed', { turnId });
  if (turnId) proc.activeTurnIds?.delete(turnId);
  if (turn?.status === 'failed' && turn?.error?.message) {
    addSystemEvent('agent_error', `${agent.name} turn failed: ${turn.error.message}`, { agentId: agent.id, sessionId: proc.threadId });
  }
  const turnMeta = turnId ? proc.turnMeta?.get(turnId) : null;
  if (turnId) proc.turnMeta?.delete(turnId);
  if (turnMeta?.warmup) {
    const elapsedMs = proc.warmupStartedAt ? Date.now() - proc.warmupStartedAt : null;
    proc.responseBuffer = '';
    proc.warmupActive = false;
    proc.warmupRequestedAt = null;
    proc.warmupCompletedAt = now();
    proc.warmupStartedAt = null;
    agent.runtimeWarmAt = proc.warmupCompletedAt;
    addSystemEvent('agent_warmup_completed', `${agent.name} hidden warmup completed`, {
      agentId: agent.id,
      sessionId: proc.threadId,
      turnId,
      elapsedMs,
      model: turnMeta.runtime?.model || null,
      reasoningEffort: turnMeta.runtime?.reasoningEffort || null,
    });
  } else if (proc.responseBuffer.trim()) {
    const responseText = proc.responseBuffer.trim();
    proc.responseBuffer = '';
    if (turnMeta && turnMetaAllWorkStopped(turnMeta)) {
      addSystemEvent('agent_stdout_suppressed', `${agent.name} output was suppressed for stopped work.`, {
        agentId: agent.id,
        sessionId: proc.threadId,
        turnId,
        workItemIds: turnMeta.workItemIds || [],
      });
    } else if (turnMeta && turnMetaHasExplicitSend(turnMeta)) {
      addSystemEvent('agent_stdout_suppressed', `${agent.name} used send_message; final stdout fallback was suppressed.`, {
        agentId: agent.id,
        sessionId: proc.threadId,
        turnId,
        workItemIds: turnMeta.workItemIds || [],
      });
    } else if (turnMeta) {
      const sourceMessage = turnMeta.sourceMessage || proc.lastSourceMessage || proc.inbox[Math.max(0, proc.promptMessageCount - 1)] || null;
      const posted = await postAgentResponse(agent, turnMeta.spaceType || proc.spaceType, turnMeta.spaceId || proc.spaceId, responseText, deliveryParentMessageId(sourceMessage, turnMeta.parentMessageId), { sourceMessage });
      markFallbackResponseWorkItems(sourceMessage, posted, turnMeta.workItemIds || []);
    } else {
      addSystemEvent('agent_unsolicited_turn_suppressed', `${agent.name} produced output for an untracked Codex turn; output was not posted.`, {
        agentId: agent.id,
        sessionId: proc.threadId,
        turnId,
      });
    }
  }
  if (!proc.activeTurnIds?.size) {
    clearAgentRunWatchdog(proc);
    proc.activeTurnId = null;
    proc.activeTurnTargets = new Set();
    proc.agentMessageStreamingAt = null;
    updateAgentRuntimeActivity(agent, proc, 'online', 'Idle', {
      activeTurnIds: [],
      pendingToolCalls: [],
    });
    proc.status = 'idle';
    setAgentStatus(agent, 'idle', 'codex_turn_completed', { activeWorkItemIds: [] });
  }
  if (!proc.activeTurnIds?.size && proc.pendingDeliveryMessages?.length) {
    clearAgentBusyDeliveryTimer(proc);
    await flushCodexPendingDeliveries(agent, proc);
  }
  await writeAgentSessionFile(agent).catch(() => {});
  await persistState();
  broadcastState();
}

async function handleCodexAppServerLine(agent, proc, line) {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    addSystemEvent('agent_stdout', line.slice(0, 600), { agentId: agent.id });
    return;
  }

  if (message.result) {
    recordCodexRequestCompleted(agent, proc, message.id, message.result);
    touchAgentRunProgress(agent, proc, 'app_server_result');
    if (message.id === proc.initializeRequestId) {
      proc.initializeRequestId = null;
      sendCodexAppServerNotification(proc, 'initialized', {});
      if (proc.pendingThreadRequest) {
        sendCodexAppServerRequest(proc, proc.pendingThreadRequest.method, proc.pendingThreadRequest.params);
        proc.pendingThreadRequest = null;
      }
      return;
    }
    const threadId = message.result.thread?.id;
    if (typeof threadId === 'string') {
      await handleCodexThreadReady(agent, proc, threadId);
      return;
    }
    const turnId = message.result.turn?.id || message.result.turnId;
    if (typeof turnId === 'string') {
      proc.activeTurnId = turnId;
      proc.activeTurnIds = proc.activeTurnIds || new Set();
      proc.activeTurnIds.add(turnId);
      const meta = proc.pendingTurnRequests?.get(message.id);
      if (meta) {
        proc.turnMeta = proc.turnMeta || new Map();
        proc.turnMeta.set(turnId, meta);
        proc.pendingTurnRequests.delete(message.id);
      }
      touchAgentRunProgress(agent, proc, 'turn_request_acknowledged', { turnId });
      return;
    }
  }

  if (message.error) {
    if (message.id !== undefined && message.id !== null) recordCodexRequestFailed(agent, proc, message.id, message.error);
    addSystemEvent('agent_error', `${agent.name} app-server request failed: ${message.error.message || 'unknown error'}`, { agentId: agent.id, raw: message.error });
    return;
  }

  if (message.method && message.id !== undefined && message.id !== null) {
    if (message.method === 'mcpServer/elicitation/request') {
      await handleCodexMcpServerElicitationRequest(agent, proc, message);
      return;
    }
    if (message.method === 'item/tool/call') {
      await handleCodexDynamicToolCallRequest(agent, proc, message);
      return;
    }
    addSystemEvent('agent_app_server_request_unhandled', `${agent.name} received unsupported app-server request ${message.method}.`, {
      agentId: agent.id,
      requestId: message.id,
      method: message.method,
      raw: message.params || null,
    });
    sendCodexAppServerError(proc, message.id, -32601, `Method not found: ${message.method}`);
    return;
  }

  switch (message.method) {
    case 'thread/started': {
      const threadId = message.params?.thread?.id;
      if (typeof threadId === 'string') await handleCodexThreadReady(agent, proc, threadId);
      break;
    }
    case 'turn/started': {
      const turnId = message.params?.turn?.id;
      if (typeof turnId === 'string') {
        proc.activeTurnId = turnId;
        proc.activeTurnIds = proc.activeTurnIds || new Set();
        proc.activeTurnIds.add(turnId);
      }
      touchAgentRunProgress(agent, proc, 'turn_started', { turnId });
      proc.status = 'running';
      setAgentStatus(agent, 'thinking', 'codex_turn_started');
      await persistState();
      broadcastState();
      break;
    }
    case 'item/agentMessage/delta': {
      const delta = message.params?.delta;
      if (typeof delta === 'string') proc.responseBuffer += delta;
      if (!proc.agentMessageStreamingAt) {
        proc.agentMessageStreamingAt = Date.now();
        addAgentRuntimeActivityEvent(agent, proc, 'agent_activity', 'thinking', 'Streaming response text.', {
          raw: { type: 'agentMessageDelta' },
        }, { broadcast: true });
      } else {
        noteAgentRuntimeProgress(agent, proc, 'thinking', 'Streaming response text.');
      }
      touchAgentRunProgress(agent, proc, 'agent_message_delta');
      break;
    }
    case 'item/completed': {
      const item = message.params?.item;
      if (item?.type === 'agentMessage' && typeof item.text === 'string' && item.text && !proc.responseBuffer.includes(item.text)) {
        proc.responseBuffer += item.text;
      }
      if (item?.type === 'commandExecution' || item?.type === 'mcpToolCall' || item?.type === 'collabAgentToolCall') {
        recordCodexToolCallCompleted(agent, proc, item);
        addAgentRuntimeActivityEvent(agent, proc, 'agent_activity', 'working', summarizeCodexEvent(item), { raw: item }, { broadcast: true });
      }
      touchAgentRunProgress(agent, proc, 'item_completed');
      break;
    }
    case 'item/started': {
      const item = message.params?.item;
      if (item?.type === 'commandExecution' || item?.type === 'mcpToolCall' || item?.type === 'collabAgentToolCall') {
        recordCodexToolCallStarted(agent, proc, item);
      }
      if (item?.type) addAgentRuntimeActivityEvent(agent, proc, 'agent_activity', 'working', `${agent.name}: ${item.type}`, { raw: item }, { broadcast: true });
      touchAgentRunProgress(agent, proc, 'item_started');
      break;
    }
    case 'turn/completed': {
      await handleCodexTurnCompleted(agent, proc, message.params?.turn || {});
      break;
    }
    case 'error':
      addSystemEvent('agent_error', `${agent.name} app-server error`, { agentId: agent.id, raw: message.params });
      break;
  }
}
