async function resetAgentRuntimeSession(agent) {
  agent.runtimeSessionId = null;
  agent.runtimeLastTurnAt = null;
  await writeAgentSessionFile(agent).catch(() => {});
}

async function resetAgentWorkspaceFiles(agent) {
  await rm(agentDataDir(agent), { recursive: true, force: true, maxRetries: 5, retryDelay: 80 });
  agent.runtimeSessionId = null;
  agent.runtimeSessionHome = null;
  agent.runtimeConfigVersion = 0;
  agent.runtimeLastStartedAt = null;
  agent.runtimeLastTurnAt = null;
  agent.workspacePath = null;
  await ensureAgentWorkspace(agent);
}

function codexProcessHasActiveTurn(proc) {
  return Boolean(proc?.activeTurnId || proc?.activeTurnIds?.size || proc?.pendingTurnRequests?.size);
}

function timestampAtOrAfter(value, baseline) {
  if (!value) return false;
  if (!baseline) return true;
  const valueTime = new Date(value).getTime();
  const baselineTime = new Date(baseline).getTime();
  return Number.isFinite(valueTime) && Number.isFinite(baselineTime) && valueTime >= baselineTime;
}

function codexProcessIsWarm(agent, proc) {
  const startedAt = agent.runtimeLastStartedAt || proc?.startedAt || null;
  return Boolean(
    proc
    && proc.threadReady
    && !proc.child?.killed
    && !proc.stopRequested
    && (proc.warmupCompletedAt || timestampAtOrAfter(agent.runtimeWarmAt, startedAt) || timestampAtOrAfter(agent.runtimeLastTurnAt, startedAt))
  );
}

async function runCodexWarmup(agent, proc) {
  const stillCurrent = () => agentProcesses.get(agent.id) === proc && !proc.stopRequested && !proc.child?.killed;
  const startedAt = Date.now();
  const timeoutMs = Math.max(15_000, Number(process.env.MAGCLAW_AGENT_WARMUP_READY_TIMEOUT_MS || 180_000));
  while (stillCurrent()) {
    if (codexProcessIsWarm(agent, proc)) {
      proc.warmupRequestedAt = null;
      return true;
    }
    if (proc.threadReady && proc.status === 'idle' && !codexProcessHasActiveTurn(proc)) break;
    if (Date.now() - startedAt > timeoutMs) {
      proc.warmupRequestedAt = null;
      addSystemEvent('agent_warmup_timeout', `${agent.name} warmup waited too long for an idle Codex session.`, {
        agentId: agent.id,
        sessionId: proc.threadId || null,
        status: proc.status,
      });
      await persistState();
      broadcastState();
      return false;
    }
    await delay(250);
  }
  if (!stillCurrent()) return false;
  const baseRuntime = resolveCodexRuntime(agent, []);
  const runtime = {
    ...baseRuntime,
    reasoningEffort: 'low',
    overrideReason: 'runtime_warmup',
  };
  proc.warmupStartedAt = Date.now();
  const sent = startCodexAppServerTurn(agent, proc, CODEX_WARMUP_PROMPT, {
    mode: 'warmup',
    messages: [],
    runtimeOverride: runtime,
  });
  if (!sent) {
    proc.warmupRequestedAt = null;
    proc.warmupStartedAt = null;
    addSystemEvent('agent_warmup_failed', `${agent.name} warmup could not start.`, {
      agentId: agent.id,
      sessionId: proc.threadId || null,
    });
    await persistState();
    broadcastState();
    return false;
  }
  return true;
}

function scheduleCodexWarmup(agent, proc) {
  if (getAgentRuntime(agent) !== 'codex') return false;
  if (!proc || proc.stopRequested || proc.child?.killed) return false;
  if (codexProcessIsWarm(agent, proc) || proc.warmupRequestedAt || proc.warmupActive) return false;
  if (proc.inbox?.length || proc.pendingInitialPrompt || proc.pendingDeliveryMessages?.length || codexProcessHasActiveTurn(proc)) return false;
  proc.warmupRequestedAt = now();
  addSystemEvent('agent_warmup_requested', `${agent.name} Codex warmup requested`, {
    agentId: agent.id,
    sessionId: proc.threadId || null,
  });
  setTimeout(() => {
    runCodexWarmup(agent, proc).catch((error) => {
      proc.warmupRequestedAt = null;
      proc.warmupStartedAt = null;
      proc.warmupActive = false;
      addSystemEvent('agent_warmup_failed', `${agent.name} warmup failed: ${error.message}`, { agentId: agent.id });
      persistState().then(broadcastState).catch(() => {});
    });
  }, 0);
  return true;
}

async function startAgentFromControl(agent) {
  if (cloudRelay?.agentShouldUseRelay?.(agent)) {
    return cloudRelay.startAgent(agent, { reason: 'manual_start' });
  }
  return startAgentProcess(agent, 'channel', 'chan_all', []);
}

async function warmAgentFromControl(agent, { spaceType = 'channel', spaceId = 'chan_all' } = {}) {
  const runtime = getAgentRuntime(agent);
  if (cloudRelay?.agentShouldUseRelay?.(agent)) {
    return cloudRelay.startAgent(agent, {
      reason: 'warmup',
      spaceType,
      spaceId,
    });
  }
  let proc = agentProcesses.get(agent.id);
  const normalizedSpaceType = spaceType === 'dm' ? 'dm' : 'channel';
  const normalizedSpaceId = String(spaceId || (normalizedSpaceType === 'channel' ? 'chan_all' : '') || 'chan_all');
  if (!proc || proc.child?.killed || proc.stopRequested) {
    proc = await startAgentProcess(agent, normalizedSpaceType, normalizedSpaceId, []);
  } else if (!codexProcessHasActiveTurn(proc)) {
    applyAgentProcessDeliveryScope(proc, normalizedSpaceType, normalizedSpaceId, null);
  }
  const scheduled = runtime === 'codex' ? scheduleCodexWarmup(agent, proc) : false;
  await persistState();
  broadcastState();
  return {
    running: true,
    warm: runtime === 'codex' ? codexProcessIsWarm(agent, proc) : true,
    warming: Boolean(scheduled || proc?.warmupRequestedAt || proc?.warmupActive),
    status: proc?.status || agent.status || 'idle',
  };
}

async function restartAgentFromControl(agent, mode = 'restart') {
  const normalizedMode = ['restart', 'reset-session', 'full-reset'].includes(mode) ? mode : 'restart';
  if (cloudRelay?.agentShouldUseRelay?.(agent)) {
    addCollabEvent('agent_restart_requested', `${agent.name} remote restart requested (${normalizedMode}).`, {
      agentId: agent.id,
      mode: normalizedMode,
    });
    return cloudRelay.startAgent(agent, { reason: `remote_${normalizedMode}` });
  }
  const stopped = await stopAgentProcessForControl(agent);
  if (normalizedMode === 'full-reset') {
    await resetAgentWorkspaceFiles(agent);
  } else if (normalizedMode === 'reset-session') {
    await resetAgentRuntimeSession(agent);
  }
  addCollabEvent('agent_restart_requested', `${agent.name} restart requested (${normalizedMode}).`, {
    agentId: agent.id,
    mode: normalizedMode,
    stopped,
  });
  await persistState();
  broadcastState();
  await startAgentFromControl(agent);
  return { mode: normalizedMode, stopped };
}

function agentAlreadyRoutedForSource(agentId, sourceMessage, { spaceType, spaceId, parentMessageId = null } = {}) {
  if (!agentId || !sourceMessage?.id) return false;
  const expectedParentId = parentMessageId || sourceMessage.parentMessageId || null;
  return (state.workItems || []).some((item) => (
    item.agentId === agentId
    && item.sourceMessageId === sourceMessage.id
    && item.status !== 'stopped'
    && item.spaceType === spaceType
    && item.spaceId === spaceId
    && String(item.parentMessageId || '') === String(expectedParentId || '')
  ));
}

function compactRelayText(value) {
  return String(value || '').replace(/\s+/g, '');
}

function agentMentionRelayLooksIntentional(record, targetAgent) {
  const body = String(record?.body || '');
  const targetId = String(targetAgent?.id || '');
  if (!body || !targetId) return false;
  const token = `<@${targetId}>`;
  let index = body.indexOf(token);
  while (index >= 0) {
    const before = compactRelayText(body.slice(Math.max(0, index - 48), index));
    const after = compactRelayText(body.slice(index + token.length, index + token.length + 64));
    const afterLower = after.toLowerCase();
    const beforeLower = before.toLowerCase();

    if (/(请|麻烦|叫|让|找|问|邀请|交给|拉|handoff|invite|ask|loopin|loop-in)$/.test(beforeLower)) return true;
    if (/^(你|您|也|可以|能|能不能|要不要|来|请|麻烦|帮|帮忙|接|接着|继续|补|补充|看|看看|处理|跟进|推进|判断|评审|review|take|handle|please|can|could|would)/i.test(afterLower)) return true;
    if (/^(也可以|也来|也帮|你也|您也|来补|补一下|补充一下|接一下|看一下|看看|处理一下|跟进一下)/.test(after)) return true;

    index = body.indexOf(token, index + token.length);
  }
  return false;
}

async function relayAgentMentions(record, { parentMessageId = null, sourceMessage = null } = {}) {
  if (record.authorType !== 'agent') return;
  if (!parentMessageId && !record.taskId) return;
  const relayDepth = Number(record.agentRelayDepth || 0);
  const mentions = extractMentions(record.body || '');
  const targetIds = mentions.agents.filter((id) => id !== record.authorId);
  if (!targetIds.length) return;
  if (relayDepth >= MAX_AGENT_RELAY_DEPTH) {
    addSystemEvent('agent_relay_capped', 'Agent mention relay depth reached.', {
      messageId: record.id,
      agentId: record.authorId,
      relayDepth,
      targetIds,
    });
    return;
  }

  const channel = record.spaceType === 'channel' ? findChannel(record.spaceId) : null;
  const allowedIds = new Set(channel ? channelAgentIds(channel) : targetIds);
  for (const targetId of targetIds) {
    if (!allowedIds.has(targetId)) continue;
    const targetAgent = findAgent(targetId);
    if (!targetAgent) continue;
    if (!agentMentionRelayLooksIntentional(record, targetAgent)) {
      addSystemEvent('agent_message_relay_suppressed', `${displayActor(record.authorId)} mentioned ${targetAgent.name}, but it did not look like a handoff.`, {
        fromAgentId: record.authorId,
        toAgentId: targetAgent.id,
        messageId: record.id,
        sourceMessageId: sourceMessage?.id || null,
        parentMessageId,
        reason: 'mention_reference',
      });
      continue;
    }
    if (agentAlreadyRoutedForSource(targetAgent.id, sourceMessage, {
      spaceType: record.spaceType,
      spaceId: record.spaceId,
      parentMessageId,
    })) {
      addSystemEvent('agent_message_relay_suppressed', `${displayActor(record.authorId)} mentioned ${targetAgent.name}, but ${targetAgent.name} already received this turn.`, {
        fromAgentId: record.authorId,
        toAgentId: targetAgent.id,
        messageId: record.id,
        sourceMessageId: sourceMessage?.id || null,
        parentMessageId,
      });
      continue;
    }
    addSystemEvent('agent_message_relay', `${displayActor(record.authorId)} mentioned ${targetAgent.name}`, {
      fromAgentId: record.authorId,
      toAgentId: targetAgent.id,
      messageId: record.id,
      relayDepth,
      parentMessageId,
    });
    deliverMessageToAgent(targetAgent, record.spaceType, record.spaceId, record, { parentMessageId }).catch(err => {
      addSystemEvent('delivery_error', `Failed to relay message to ${targetAgent.name}: ${err.message}`, {
        agentId: targetAgent.id,
        messageId: record.id,
        parentMessageId,
      });
    });
  }
}

function inferTaskIdForDelivery(message, parentMessageId) {
  if (message?.taskId) return message.taskId;
  const parent = parentMessageId ? findMessage(parentMessageId) : null;
  const task = findTaskForThreadMessage(parent || message);
  return task?.id || null;
}

function createWorkItemForDelivery(agent, message, { spaceType, spaceId, parentMessageId = null, suppressTaskContext = false } = {}) {
  state.workItems = Array.isArray(state.workItems) ? state.workItems : [];
  const target = targetForConversation(spaceType, spaceId, parentMessageId);
  const item = {
    id: makeId('wi'),
    agentId: agent.id,
    sourceMessageId: message.id,
    parentMessageId: parentMessageId || null,
    spaceType,
    spaceId,
    target,
    taskId: suppressTaskContext ? null : inferTaskIdForDelivery(message, parentMessageId),
    status: 'queued',
    createdAt: now(),
    updatedAt: now(),
    deliveredAt: null,
    respondedAt: null,
    sendCount: 0,
  };
  state.workItems.push(item);
  addSystemEvent('work_item_created', `${agent.name} received ${target}`, {
    agentId: agent.id,
    workItemId: item.id,
    messageId: message.id,
    target,
  });
  return item;
}

function markWorkItemsDelivered(messages, deliveryMode) {
  const ids = normalizeIds((Array.isArray(messages) ? messages : [messages])
    .map((message) => message?.workItemId));
  for (const id of ids) {
    const item = findWorkItem(id);
    if (!item) continue;
    if (item.status === 'stopped') continue;
    item.status = item.status === 'responded' ? item.status : 'delivered';
    item.deliveryMode = deliveryMode;
    item.deliveredAt = item.deliveredAt || now();
    item.updatedAt = now();
  }
  return ids;
}

function turnMetaHasExplicitSend(turnMeta) {
  const ids = normalizeIds(turnMeta?.workItemIds || []);
  return ids.some((id) => {
    const item = findWorkItem(id);
    return item?.respondedAt || item?.status === 'responded' || item?.status === 'stopped' || Number(item?.sendCount || 0) > 0;
  });
}

function workItemTargetMatches(item, resolvedTarget) {
  if (!item || !resolvedTarget) return false;
  return (
    item.spaceType === resolvedTarget.spaceType
    && item.spaceId === resolvedTarget.spaceId
    && String(item.parentMessageId || '') === String(resolvedTarget.parentMessageId || '')
  );
}

function markWorkItemResponded(item, target, record) {
  item.status = 'responded';
  item.respondedAt = item.respondedAt || now();
  item.updatedAt = now();
  item.sendCount = Number(item.sendCount || 0) + 1;
  item.lastSentTarget = target;
  item.lastResponseId = record?.id || null;
}

function markFallbackResponseWorkItem(sourceMessage, record) {
  return markFallbackResponseWorkItems(sourceMessage, record);
}

function markFallbackResponseWorkItems(sourceMessage, record, workItemIds = []) {
  const workItemId = sourceMessage?.workItemId;
  const ids = normalizeIds([...workItemIds, workItemId].filter(Boolean));
  let marked = false;
  for (const id of ids) {
    const item = findWorkItem(id);
    if (!item || item.status === 'responded' || item.status === 'stopped') continue;
    markWorkItemResponded(item, sourceMessage?.target || item.target || null, record);
    marked = true;
  }
  return marked;
}

async function postAgentResponse(agent, spaceType, spaceId, body, parentMessageId = null, options = {}) {
  const responseBody = prepareAgentResponseBody(body);
  const sourceDepth = Number(options.sourceMessage?.agentRelayDepth || 0);
  const agentRelayDepth = sourceDepth + 1;
  if (parentMessageId && findMessage(parentMessageId)) {
    const parent = findMessage(parentMessageId);
    const reply = normalizeConversationRecord({
      id: makeId('rep'),
      parentMessageId,
      spaceType: parent.spaceType || spaceType,
      spaceId: parent.spaceId || spaceId,
      authorType: 'agent',
      authorId: agent.id,
      body: responseBody,
      attachmentIds: [],
      agentRelayDepth,
      createdAt: now(),
      updatedAt: now(),
    });
    state.replies.push(reply);
    parent.replyCount = state.replies.filter((item) => item.parentMessageId === parentMessageId).length;
    parent.updatedAt = now();
    addCollabEvent('agent_thread_response', `${agent.name} responded in thread`, { replyId: reply.id, messageId: parentMessageId, agentId: agent.id });
    await persistState();
    broadcastState();
    await relayAgentMentions(reply, { parentMessageId, sourceMessage: options.sourceMessage });
    return reply;
  }

  const message = normalizeConversationRecord({
    id: makeId('msg'),
    spaceType,
    spaceId,
    authorType: 'agent',
    authorId: agent.id,
    body: responseBody,
    attachmentIds: [],
    agentRelayDepth,
    replyCount: 0,
    savedBy: [],
    createdAt: now(),
    updatedAt: now(),
  });
  state.messages.push(message);
  addCollabEvent('agent_response', `${agent.name} responded`, { messageId: message.id, agentId: agent.id });
  await persistState();
  broadcastState();
  await relayAgentMentions(message, { sourceMessage: options.sourceMessage });
  return message;
}
