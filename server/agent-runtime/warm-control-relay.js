async function resetAgentRuntimeSession(agent) {
  agent.runtimeSessionId = null;
  agent.runtimeLastTurnAt = null;
  if (Array.isArray(state.agentRuntimeSessions)) {
    for (const session of state.agentRuntimeSessions) {
      if (session?.agentId !== agent.id) continue;
      session.codexThreadId = null;
      session.status = 'reset';
      session.activeTurnIds = [];
      session.activeTargetKeys = [];
      session.updatedAt = now();
    }
  }
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
  if (Array.isArray(state.agentRuntimeSessions)) {
    state.agentRuntimeSessions = state.agentRuntimeSessions.filter((session) => session?.agentId !== agent.id);
  }
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
  const stillCurrent = () => agentProcesses.get(proc.processKey) === proc && !proc.stopRequested && !proc.child?.killed;
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
  return startAgentProcess(agent, 'channel', defaultChannelId(), []);
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
  const normalizedSpaceType = spaceType === 'dm' ? 'dm' : 'channel';
  const normalizedSpaceId = String(spaceId || (normalizedSpaceType === 'channel' ? defaultChannelId() : '') || defaultChannelId());
  const processKey = agentProcessKeyForDelivery(agent, normalizedSpaceType, normalizedSpaceId, null, null);
  let proc = agentProcesses.get(processKey) || firstAgentProcess(agent.id);
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

function defaultChannelId() {
  const workspaceId = state.connection?.workspaceId || state.cloud?.workspace?.id || 'local';
  const allChannel = state.channels?.find((channel) => (
    (channel.locked || channel.defaultChannel || channel.id === 'chan_all' || channel.name === 'all')
    && (channel.workspaceId || 'local') === workspaceId
    && !channel.archived
  ));
  return allChannel?.id || state.channels?.[0]?.id || 'chan_all';
}

async function restartAgentFromControl(agent, mode = 'restart') {
  const normalizedMode = ['restart', 'reset-session', 'full-reset'].includes(mode) ? mode : 'restart';
  if (cloudRelay?.agentShouldUseRelay?.(agent)) {
    addCollabEvent('agent_restart_requested', `${agent.name} remote restart requested (${normalizedMode}).`, {
      agentId: agent.id,
      mode: normalizedMode,
    });
    return cloudRelay.restartAgent(agent, {
      mode: normalizedMode,
      reason: `remote_${normalizedMode}`,
    });
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

function dmHasParticipant(dm, participantId) {
  return Array.isArray(dm?.participantIds) && dm.participantIds.includes(participantId);
}

function dmHumanParticipantIds(dm) {
  return (dm?.participantIds || []).filter((id) => findHuman(id) || String(id || '').startsWith('hum_'));
}

function originHumanIdForPrivateDmHandoff(sourceDm, sourceMessage = null) {
  const humanIds = dmHumanParticipantIds(sourceDm);
  if (sourceMessage?.authorType === 'human' && humanIds.includes(sourceMessage.authorId)) {
    return sourceMessage.authorId;
  }
  return humanIds[0] || null;
}

function findOrCreateUserAgentHandoffDm(humanId, targetAgent, workspaceId) {
  const normalizedWorkspaceId = String(workspaceId || 'local');
  const existing = (state.dms || []).find((dm) => (
    String(dm.workspaceId || 'local') === normalizedWorkspaceId
    && dmHasParticipant(dm, humanId)
    && dmHasParticipant(dm, targetAgent.id)
  ));
  if (existing) return { dm: existing, created: false };

  const dm = {
    id: makeId('dm'),
    workspaceId: normalizedWorkspaceId,
    participantIds: [humanId, targetAgent.id],
    createdAt: now(),
    updatedAt: now(),
  };
  state.dms = Array.isArray(state.dms) ? state.dms : [];
  state.dms.push(dm);
  return { dm, created: true };
}

function privateHandoffMessageBody(record, sourceAgent, targetAgent, originHumanId, sourceMessage = null) {
  const originalRequest = sourceMessage?.body && sourceMessage.id !== record.id
    ? String(sourceMessage.body || '').trim()
    : '';
  return [
    `Private handoff for <@${originHumanId}>.`,
    `Source agent: <@${sourceAgent.id}>.`,
    `Target agent: <@${targetAgent.id}>.`,
    originalRequest ? `Original request: ${originalRequest}` : '',
    `Handoff message: ${String(record.body || '').trim()}`,
    'Continue in this DM with the human if you can help. Create or claim a task only when the work needs tracked follow-up.',
  ].filter(Boolean).join('\n');
}

function createUserAgentHandoffMessage(record, sourceAgent, targetAgent, originHumanId, dm, workspaceId, sourceMessage = null) {
  const message = normalizeConversationRecord({
    id: makeId('msg'),
    workspaceId,
    spaceType: 'dm',
    spaceId: dm.id,
    authorType: 'system',
    authorId: 'system',
    body: privateHandoffMessageBody(record, sourceAgent, targetAgent, originHumanId, sourceMessage),
    attachmentIds: Array.isArray(record.attachmentIds) ? record.attachmentIds : [],
    mentionedAgentIds: [sourceAgent.id, targetAgent.id],
    mentionedHumanIds: [originHumanId],
    readBy: [originHumanId],
    replyCount: 0,
    savedBy: [],
    agentRelayDepth: Number(record.agentRelayDepth || 0),
    handoffSourceMessageId: record.id,
    handoffSourceParentMessageId: record.parentMessageId || null,
    suppressTaskContext: true,
    internal: true,
    hiddenFromChannel: true,
    metadata: {
      visibility: 'internal',
      kind: 'private_user_agent_handoff',
      sourceAgentId: sourceAgent.id,
      targetAgentId: targetAgent.id,
      originHumanId,
      sourceDmId: record.spaceId,
      sourceMessageId: sourceMessage?.id || null,
    },
    createdAt: now(),
    updatedAt: now(),
  });
  state.messages.push(message);
  return message;
}

async function relayPrivateDmMentionToUserAgentDm(record, targetAgent, { parentMessageId = null, sourceMessage = null } = {}) {
  if (record.spaceType !== 'dm') return false;
  const sourceDm = (state.dms || []).find((dm) => dm.id === record.spaceId);
  if (dmHasParticipant(sourceDm, targetAgent.id)) return false;
  const sourceAgent = findAgent(record.authorId);
  if (!sourceAgent) return false;
  const originHumanId = originHumanIdForPrivateDmHandoff(sourceDm, sourceMessage);
  if (!originHumanId) return false;

  const workspaceId = record.workspaceId
    || sourceMessage?.workspaceId
    || sourceDm?.workspaceId
    || workspaceIdForSpace('dm', record.spaceId, record, sourceAgent);
  const { dm, created } = findOrCreateUserAgentHandoffDm(originHumanId, targetAgent, workspaceId);
  const handoffMessage = createUserAgentHandoffMessage(record, sourceAgent, targetAgent, originHumanId, dm, workspaceId, sourceMessage);
  addSystemEvent('agent_dm_handoff_relay', `${sourceAgent.name} routed a private handoff from ${displayActor(originHumanId)} to ${targetAgent.name}.`, {
    fromAgentId: sourceAgent.id,
    toAgentId: targetAgent.id,
    originHumanId,
    sourceMessageId: record.id,
    sourceParentMessageId: parentMessageId || null,
    dmId: dm.id,
    handoffMessageId: handoffMessage.id,
    dmCreated: created,
  });
  await persistState();
  broadcastState();
  deliverMessageToAgent(targetAgent, 'dm', dm.id, handoffMessage, {
    proactive: true,
    sourceAgentId: sourceAgent.id,
    suppressTaskContext: true,
  }).catch((err) => {
    addSystemEvent('delivery_error', `Failed to deliver private user-Agent handoff to ${targetAgent.name}: ${err.message}`, {
      agentId: targetAgent.id,
      messageId: handoffMessage.id,
      dmId: dm.id,
    });
  });
  return true;
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
    if (await relayPrivateDmMentionToUserAgentDm(record, targetAgent, { parentMessageId, sourceMessage })) {
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

async function fanOutAgentChannelAwareness(record, { sourceMessage = null } = {}) {
  const channel = record?.spaceType === 'channel' ? findChannel(record.spaceId) : null;
  const targets = selectAgentAwarenessTargets({
    state,
    channel,
    record,
    channelAgentIds,
    findAgent,
    agentAvailableForAutoWork,
  });
  if (!targets.length) return [];

  addSystemEvent('agent_channel_awareness_fanout', `${displayActor(record.authorId)} public channel message delivered to ${targets.length} peer agent(s).`, {
    messageId: record.id,
    fromAgentId: record.authorId,
    targetAgentIds: targets.map((agent) => agent.id),
    sourceMessageId: sourceMessage?.id || null,
    relayDepth: Number(record.agentRelayDepth || 0),
  });

  const awarenessMessage = {
    ...record,
    passiveAwareness: true,
    suppressTaskContext: true,
  };
  for (const targetAgent of targets) {
    deliverMessageToAgent(targetAgent, record.spaceType, record.spaceId, awarenessMessage, {
      suppressTaskContext: true,
      contextLimits: {
        recentMessages: 8,
        threadReplies: 3,
        tasks: 3,
      },
    }).catch((err) => {
      addSystemEvent('delivery_error', `Failed to deliver public Agent awareness to ${targetAgent.name}: ${err.message}`, {
        agentId: targetAgent.id,
        messageId: record.id,
      });
    });
  }
  return targets;
}

function inferTaskIdForDelivery(message, parentMessageId) {
  if (message?.taskId) return message.taskId;
  const parent = parentMessageId ? findMessage(parentMessageId) : null;
  const task = findTaskForThreadMessage(parent || message);
  return task?.id || null;
}

function workspaceIdForSpace(spaceType, spaceId, fallbackRecord = null, agent = null) {
  const target = spaceType === 'channel'
    ? state.channels?.find((channel) => channel.id === spaceId)
    : state.dms?.find((dm) => dm.id === spaceId);
  return fallbackRecord?.workspaceId
    || target?.workspaceId
    || agent?.workspaceId
    || state.connection?.workspaceId
    || state.cloud?.workspace?.id
    || 'local';
}

function createWorkItemForDelivery(agent, message, { spaceType, spaceId, parentMessageId = null, suppressTaskContext = false } = {}) {
  state.workItems = Array.isArray(state.workItems) ? state.workItems : [];
  const target = targetForConversation(spaceType, spaceId, parentMessageId);
  const item = {
    id: makeId('wi'),
    workspaceId: workspaceIdForSpace(spaceType, spaceId, message, agent),
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

function markPassiveAwarenessWorkItemsObserved(sourceMessage, workItemIds = []) {
  const ids = normalizeIds([...workItemIds, sourceMessage?.workItemId].filter(Boolean));
  let marked = false;
  for (const id of ids) {
    const item = findWorkItem(id);
    if (!item || item.status === 'responded' || item.status === 'stopped') continue;
    item.status = 'responded';
    item.completedAt = item.completedAt || now();
    item.updatedAt = now();
    item.passiveAwarenessObserved = true;
    marked = true;
  }
  return marked;
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

function findExistingAgentResponseForDelivery(agent, parentMessageId = null, options = {}) {
  const deliveryId = String(options.deliveryId || '').trim();
  const idempotencyKey = String(options.idempotencyKey || '').trim();
  if (!deliveryId && !idempotencyKey) return null;
  const records = parentMessageId ? state.replies : state.messages;
  return (records || []).find((record) => (
    record?.authorType === 'agent'
    && record.authorId === agent.id
    && String(record.parentMessageId || '') === String(parentMessageId || '')
    && (
      (deliveryId && record.deliveryId === deliveryId)
      || (idempotencyKey && record.idempotencyKey === idempotencyKey)
    )
  )) || null;
}

function responseCreatedTimeMs(record) {
  const parsed = Date.parse(record?.createdAt || record?.updatedAt || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function findRecentDuplicateAgentResponse(agent, spaceType, spaceId, responseBody, parentMessageId = null, options = {}) {
  const dedupeWindowMs = Number(options.dedupeWindowMs || 0);
  if (!Number.isFinite(dedupeWindowMs) || dedupeWindowMs <= 0) return null;
  const baselineMs = Date.parse(options.dedupeNow || now());
  if (!Number.isFinite(baselineMs)) return null;
  const records = parentMessageId ? state.replies : state.messages;
  const canonicalResponseBody = canonicalAgentResponseText(responseBody);
  return (records || []).slice().reverse().find((record) => {
    const createdMs = responseCreatedTimeMs(record);
    return (
      record?.authorType === 'agent'
      && record.authorId === agent.id
      && record.spaceType === spaceType
      && record.spaceId === spaceId
      && String(record.parentMessageId || '') === String(parentMessageId || '')
      && canonicalAgentResponseText(record.body) === canonicalResponseBody
      && createdMs > 0
      && baselineMs >= createdMs
      && baselineMs - createdMs <= dedupeWindowMs
    );
  }) || null;
}

function attachAgentResponseDeliveryIdentity(record, options = {}) {
  if (!record) return false;
  let changed = false;
  const deliveryId = String(options.deliveryId || '').trim();
  const idempotencyKey = String(options.idempotencyKey || '').trim();
  if (deliveryId && !record.deliveryId) {
    record.deliveryId = deliveryId;
    changed = true;
  }
  if (idempotencyKey && !record.idempotencyKey) {
    record.idempotencyKey = idempotencyKey;
    changed = true;
  }
  if (changed) {
    record.updatedAt = now();
    normalizeConversationRecord(record);
  }
  return changed;
}

async function returnExistingAgentResponse(record, options = {}) {
  if (attachAgentResponseDeliveryIdentity(record, options)) {
    await persistState();
    broadcastState();
  }
  return record;
}

async function postAgentResponse(agent, spaceType, spaceId, body, parentMessageId = null, options = {}) {
  const responseBody = prepareAgentResponseBody(body);
  const sourceDepth = Number(options.sourceMessage?.agentRelayDepth || 0);
  const agentRelayDepth = sourceDepth + 1;
  const parentForResponse = parentMessageId ? findMessage(parentMessageId) : null;
  const dedupeSpaceType = parentForResponse?.spaceType || spaceType;
  const dedupeSpaceId = parentForResponse?.spaceId || spaceId;
  const existingResponse = findExistingAgentResponseForDelivery(agent, parentMessageId, options);
  if (existingResponse) return returnExistingAgentResponse(existingResponse, options);
  const recentDuplicate = findRecentDuplicateAgentResponse(agent, dedupeSpaceType, dedupeSpaceId, responseBody, parentMessageId, options);
  if (recentDuplicate) {
    addSystemEvent('agent_response_deduped', `${agent.name} repeated a recent message to the same target.`, {
      agentId: agent.id,
      responseId: recentDuplicate.id,
      spaceType: dedupeSpaceType,
      spaceId: dedupeSpaceId,
      parentMessageId: parentMessageId || null,
      deliveryId: options.deliveryId || null,
      idempotencyKey: options.idempotencyKey || null,
    });
    return returnExistingAgentResponse(recentDuplicate, options);
  }
  if (parentForResponse) {
    const parent = parentForResponse;
    const reply = normalizeConversationRecord({
      id: makeId('rep'),
      workspaceId: parent.workspaceId || options.sourceMessage?.workspaceId || workspaceIdForSpace(parent.spaceType || spaceType, parent.spaceId || spaceId, null, agent),
      parentMessageId,
      spaceType: parent.spaceType || spaceType,
      spaceId: parent.spaceId || spaceId,
      authorType: 'agent',
      authorId: agent.id,
      body: responseBody,
      attachmentIds: [],
      agentRelayDepth,
      deliveryId: options.deliveryId || null,
      idempotencyKey: options.idempotencyKey || null,
      createdAt: now(),
      updatedAt: now(),
    });
    state.replies.push(reply);
    parent.replyCount = Math.max(
      Number(parent.replyCount || 0) + 1,
      state.replies.filter((item) => item.parentMessageId === parentMessageId).length,
    );
    parent.updatedAt = now();
    addCollabEvent('agent_thread_response', `${agent.name} responded in thread`, { replyId: reply.id, messageId: parentMessageId, agentId: agent.id });
    await persistState();
    broadcastState();
    await relayAgentMentions(reply, { parentMessageId, sourceMessage: options.sourceMessage });
    return reply;
  }

  const message = normalizeConversationRecord({
    id: makeId('msg'),
    workspaceId: options.sourceMessage?.workspaceId || workspaceIdForSpace(spaceType, spaceId, null, agent),
    spaceType,
    spaceId,
    authorType: 'agent',
    authorId: agent.id,
    body: responseBody,
    attachmentIds: [],
    agentRelayDepth,
    deliveryId: options.deliveryId || null,
    idempotencyKey: options.idempotencyKey || null,
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
  await fanOutAgentChannelAwareness(message, { sourceMessage: options.sourceMessage });
  return message;
}
