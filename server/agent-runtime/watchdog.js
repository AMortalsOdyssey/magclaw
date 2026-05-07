function clearAgentRunWatchdog(proc) {
  if (!proc?.turnWatchdogTimer) return;
  clearTimeout(proc.turnWatchdogTimer);
  proc.turnWatchdogTimer = null;
}

function resetCodexActiveTurnState(proc) {
  proc.activeTurnId = null;
  proc.activeTurnIds = new Set();
  proc.activeTurnTargets = new Set();
  proc.pendingTurnRequests = new Map();
  proc.turnMeta = new Map();
  proc.pendingMcpToolCalls = new Map();
  proc.lastTurnProgressAt = null;
  proc.lastTurnProgressReason = null;
  proc.lastRunStallLoggedAt = null;
  proc.lastTurnProgressTurnId = null;
  proc.lastActivity = '';
  proc.lastActivityDetail = '';
  proc.lastActivityAt = null;
  proc.lastActivityAtMs = null;
  proc.lastActivityHeartbeatAt = null;
  proc.runtimeProgressStaleSince = null;
  proc.agentMessageStreamingAt = null;
}

function scheduleAgentRunWatchdog(agent, proc) {
  if (!proc || proc.usedLegacyFallback || proc.stopRequested || proc.child?.killed) return false;
  const intervalMs = Math.min(...[
    AGENT_RUN_STALL_LOG_MS,
    AGENT_STUCK_SEND_MESSAGE_MS,
    AGENT_ACTIVITY_HEARTBEAT_MS,
    AGENT_RUNTIME_PROGRESS_STALE_MS,
  ].filter((value) => Number(value) > 0));
  if (!Number.isFinite(intervalMs) || intervalMs < 1) return false;
  if (!codexProcessHasActiveTurn(proc)) {
    clearAgentRunWatchdog(proc);
    return false;
  }
  clearAgentRunWatchdog(proc);
  proc.turnWatchdogTimer = setTimeout(() => {
    proc.turnWatchdogTimer = null;
    handleAgentRunWatchdogTimeout(agent, proc).catch((error) => {
      addSystemEvent('agent_error', `${agent.name} watchdog failed: ${error.message}`, { agentId: agent.id });
      persistState().then(broadcastState).catch(() => {});
    });
  }, intervalMs);
  proc.turnWatchdogTimer.unref?.();
  return true;
}

function touchAgentRunProgress(agent, proc, reason, extra = {}) {
  if (!proc || proc.usedLegacyFallback || proc.stopRequested) return;
  if (!codexProcessHasActiveTurn(proc)) return;
  const wasStalled = Boolean(proc.runtimeProgressStaleSince);
  proc.lastTurnProgressAt = Date.now();
  proc.lastTurnProgressReason = reason;
  proc.lastRunStallLoggedAt = null;
  proc.runtimeProgressStaleSince = null;
  if (extra.turnId) proc.lastTurnProgressTurnId = extra.turnId;
  if (wasStalled) {
    addAgentRuntimeActivityEvent(agent, proc, 'agent_runtime_progress_observed', 'working', 'Runtime progress resumed after a stalled window.', {
      reason,
      turnId: extra.turnId || null,
    }, { broadcast: true });
  } else {
    updateAgentRuntimeActivity(agent, proc, proc.lastActivity || 'working', proc.lastActivityDetail || reason, {
      reason,
    });
  }
  scheduleAgentRunWatchdog(agent, proc);
}

function activeToolCallSummaries(proc) {
  return [...(proc?.pendingMcpToolCalls?.values?.() || [])]
    .filter((call) => !call.completedAt && !call.recoveredAt)
    .map((call) => ({
      id: call.id,
      name: call.name,
      startedAt: call.startedAt,
      startedAtMs: call.startedAtMs,
      turnIds: call.turnIds || [],
      workItemId: call.arguments?.workItemId || call.arguments?.work_item_id || null,
      target: call.arguments?.target || null,
      contentLength: call.arguments?.content ? String(call.arguments.content).trim().length : 0,
    }));
}

function recordCodexToolCallStarted(agent, proc, item = {}) {
  const name = codexToolName(item);
  const args = codexToolArguments(item);
  const explicitId = codexToolCallId(item);
  const id = explicitId || `tool_${Date.now().toString(36)}_${Number(proc.nextToolCallSequence || 0) + 1}`;
  proc.nextToolCallSequence = Number(proc.nextToolCallSequence || 0) + 1;
  proc.pendingMcpToolCalls = proc.pendingMcpToolCalls || new Map();
  const summary = summarizeToolArguments(name, args);
  proc.pendingMcpToolCalls.set(id, {
    id,
    name,
    arguments: args,
    raw: item,
    turnIds: activeTurnIdList(proc),
    startedAt: now(),
    startedAtMs: Date.now(),
  });
  addSystemEvent('agent_mcp_tool_call_started', `${agent.name} started ${name || item.type || 'tool call'}.`, {
    agentId: agent.id,
    toolCallId: id,
    turnIds: activeTurnIdList(proc),
    ...summary,
    raw: item,
  });
}

function recordCodexToolCallCompleted(agent, proc, item = {}) {
  const name = codexToolName(item);
  const explicitId = codexToolCallId(item);
  let call = explicitId ? proc.pendingMcpToolCalls?.get(explicitId) : null;
  if (!call && proc.pendingMcpToolCalls?.size) {
    call = [...proc.pendingMcpToolCalls.values()]
      .reverse()
      .find((candidate) => !candidate.completedAt && (!name || candidate.name === name));
  }
  const id = explicitId || call?.id || null;
  if (call) {
    call.completedAt = now();
    call.durationMs = Date.now() - call.startedAtMs;
  }
  addSystemEvent('agent_mcp_tool_call_completed', `${agent.name} completed ${name || call?.name || item.type || 'tool call'}.`, {
    agentId: agent.id,
    toolCallId: id,
    durationMs: call?.durationMs || null,
    turnIds: call?.turnIds || activeTurnIdList(proc),
    ...summarizeToolArguments(name || call?.name || '', codexToolArguments(item) || call?.arguments || {}),
    raw: item,
  });
}

function maybeAddAgentActivityHeartbeat(agent, proc, staleMs, activeTurnIds, pendingToolCalls) {
  if (!AGENT_ACTIVITY_HEARTBEAT_MS || !codexProcessHasActiveTurn(proc)) return false;
  const lastHeartbeatAt = Number(proc.lastActivityHeartbeatAt || 0);
  if (lastHeartbeatAt && Date.now() - lastHeartbeatAt < AGENT_ACTIVITY_HEARTBEAT_MS) return false;
  proc.lastActivityHeartbeatAt = Date.now();
  const activity = proc.runtimeProgressStaleSince ? 'error' : (proc.lastActivity || 'working');
  const detail = proc.runtimeProgressStaleSince
    ? proc.lastActivityDetail || 'Runtime progress is stalled.'
    : proc.lastActivityDetail || 'Runtime is still active.';
  updateAgentRuntimeActivity(agent, proc, activity, detail, {
    staleMs,
    activeTurnIds,
    pendingToolCalls,
  });
  addSystemEvent('agent_activity_heartbeat', `${agent.name} still ${activity}: ${detail}`, {
    agentId: agent.id,
    activity,
    detail,
    staleMs,
    lastProgressAt: isoFromMs(proc.lastTurnProgressAt),
    lastProgressReason: proc.lastTurnProgressReason || null,
    activeTurnIds,
    pendingToolCalls,
  });
  return true;
}

function maybeMarkRuntimeProgressStale(agent, proc, staleMs, activeTurnIds, pendingToolCalls) {
  if (!AGENT_RUNTIME_PROGRESS_STALE_MS || staleMs < AGENT_RUNTIME_PROGRESS_STALE_MS || proc.runtimeProgressStaleSince) return false;
  proc.runtimeProgressStaleSince = now();
  const staleForMinutes = Math.max(1, Math.floor(staleMs / 60_000));
  const detail = `Runtime stalled: no runtime events for ${staleForMinutes}m`;
  updateAgentRuntimeActivity(agent, proc, 'error', detail, {
    staleMs,
    activeTurnIds,
    pendingToolCalls,
  });
  proc.lastActivityHeartbeatAt = Date.now();
  addSystemEvent('agent_runtime_progress_stalled', `${agent.name} ${detail}.`, {
    agentId: agent.id,
    activity: 'error',
    detail,
    staleMs,
    staleForMinutes,
    lastProgressAt: isoFromMs(proc.lastTurnProgressAt),
    lastProgressReason: proc.lastTurnProgressReason || null,
    activeTurnIds,
    pendingToolCalls,
  });
  return true;
}

async function recoverPendingSendMessageToolCalls(agent, proc) {
  const minAgeMs = Math.max(1, Number(AGENT_STUCK_SEND_MESSAGE_MS || 0));
  const calls = [...(proc.pendingMcpToolCalls?.values?.() || [])]
    .filter((call) => !call.completedAt && !call.recoveredAt && codexToolNameMatches(call.name, 'send_message') && (Date.now() - Number(call.startedAtMs || 0)) >= minAgeMs);
  let recovered = 0;
  for (const call of calls) {
    const args = call.arguments || {};
    const workItemId = String(args.workItemId || args.work_item_id || '').trim()
      || normalizeIds(call.turnIds?.flatMap((turnId) => proc.turnMeta?.get(turnId)?.workItemIds || []))[0]
      || '';
    const workItem = findWorkItem(workItemId);
    const content = String(args.content || '').trim();
    if (!workItem || workItem.agentId !== agent.id || workItem.status === 'responded' || workItem.status === 'stopped' || !content) {
      addSystemEvent('agent_run_watchdog_recovery_skipped', `${agent.name} could not recover a pending send_message call.`, {
        agentId: agent.id,
        toolCallId: call.id,
        workItemId: workItemId || null,
        hasWorkItem: Boolean(workItem),
        workItemStatus: workItem?.status || null,
        contentLength: content.length,
      });
      continue;
    }
    let target;
    try {
      target = resolveMessageTarget(args.target || workItem.target);
      if (!workItemTargetMatches(workItem, target)) {
        throw httpError(409, 'Target does not match the work item conversation.');
      }
      const sourceMessage = findMessage(workItem.sourceMessageId) || findConversationRecord(workItem.sourceMessageId);
      const posted = await postAgentResponse(agent, target.spaceType, target.spaceId, content, target.parentMessageId || null, {
        sourceMessage,
      });
      markWorkItemResponded(workItem, target.label, posted);
      call.recoveredAt = now();
      recovered += 1;
      addSystemEvent('agent_run_watchdog_recovered_send_message', `${agent.name} recovered a stuck send_message call to ${target.label}.`, {
        agentId: agent.id,
        toolCallId: call.id,
        workItemId: workItem.id,
        target: target.label,
        responseId: posted?.id || null,
      });
    } catch (error) {
      addSystemEvent('agent_run_watchdog_recovery_failed', `${agent.name} failed to recover send_message: ${error.message}`, {
        agentId: agent.id,
        toolCallId: call.id,
        workItemId,
      });
    }
  }
  return recovered;
}

async function handleAgentRunWatchdogTimeout(agent, proc) {
  if (agentProcesses.get(agent.id) !== proc || proc.stopRequested || proc.child?.killed || proc.usedLegacyFallback) return false;
  if (!codexProcessHasActiveTurn(proc)) return false;
  const lastProgressAt = Number(proc.lastTurnProgressAt || 0);
  const staleMs = Date.now() - (lastProgressAt || Date.now());
  const activeTurnIds = activeTurnIdList(proc);
  const pendingToolCalls = activeToolCallSummaries(proc);
  let changed = false;

  const hasRecoverableSendMessage = pendingToolCalls.some((call) => (
    codexToolNameMatches(call.name, 'send_message')
    && call.workItemId
    && call.contentLength > 0
    && Date.now() - Number(call.startedAtMs || 0) >= AGENT_STUCK_SEND_MESSAGE_MS
  ));

  if (hasRecoverableSendMessage) {
    addSystemEvent('agent_send_message_watchdog_timeout', `${agent.name} send_message watchdog fired after ${staleMs}ms without progress.`, {
      agentId: agent.id,
      sessionId: proc.threadId || null,
      staleMs,
      lastProgressReason: proc.lastTurnProgressReason || null,
      activeTurnIds,
      pendingToolCalls,
    });
    const recovered = await recoverPendingSendMessageToolCalls(agent, proc);
    if (recovered > 0) {
      for (const turnId of activeTurnIds) {
        sendCodexAppServerRequest(proc, 'turn/interrupt', {
          threadId: proc.threadId,
          turnId,
        });
      }
      clearAgentRunWatchdog(proc);
      const queuedMessages = uniqueDeliveryMessages(proc.pendingDeliveryMessages || []);
      proc.stopRequested = true;
      proc.suppressOutput = true;
      proc.restartMessagesAfterStop = queuedMessages;
      proc.pendingDeliveryMessages = [];
      proc.responseBuffer = '';
      resetCodexActiveTurnState(proc);
      proc.status = 'idle';
      setAgentStatus(agent, queuedMessages.length ? 'queued' : 'idle', 'agent_run_watchdog_recovered', { activeWorkItemIds: [] });
      await writeAgentSessionFile(agent).catch(() => {});
      await persistState();
      broadcastState();
      if (proc.child && !proc.child.killed) proc.child.kill('SIGTERM');
      else {
        agentProcesses.delete(agent.id);
        if (queuedMessages.length) restartAgentWithQueuedMessages(agent, proc, queuedMessages);
      }
      return true;
    }
  }

  if (AGENT_RUN_STALL_LOG_MS && (!lastProgressAt || staleMs >= AGENT_RUN_STALL_LOG_MS)) {
    const lastLoggedAt = Number(proc.lastRunStallLoggedAt || 0);
    if (!lastLoggedAt || Date.now() - lastLoggedAt >= AGENT_RUN_STALL_LOG_MS) {
      proc.lastRunStallLoggedAt = Date.now();
      addSystemEvent('agent_run_watchdog_stall', `${agent.name} has had no app-server progress for ${staleMs}ms; leaving the turn running.`, {
        agentId: agent.id,
        sessionId: proc.threadId || null,
        staleMs,
        lastProgressReason: proc.lastTurnProgressReason || null,
        activeTurnIds,
        pendingToolCalls,
      });
      changed = true;
    }
  }
  changed = maybeMarkRuntimeProgressStale(agent, proc, staleMs, activeTurnIds, pendingToolCalls) || changed;
  changed = maybeAddAgentActivityHeartbeat(agent, proc, staleMs, activeTurnIds, pendingToolCalls) || changed;
  if (changed) {
    await persistState();
    broadcastState();
  }
  scheduleAgentRunWatchdog(agent, proc);
  return false;
}

async function triggerCodexStreamRetryFallback(agent, proc, workspace, retry) {
  if (!retry) return false;
  const retryLimit = Math.min(CODEX_STREAM_RETRY_LIMIT, Number(retry.total) || CODEX_STREAM_RETRY_LIMIT);
  if (retry.count < retryLimit) return false;
  if (proc.streamRetryFallbackStarted || proc.usedLegacyFallback || proc.stopRequested || proc.warmupActive) return false;
  proc.streamRetryFallbackStarted = true;
  if (proc.threadId && proc.activeTurnId) {
    sendCodexAppServerRequest(proc, 'turn/interrupt', {
      threadId: proc.threadId,
      turnId: proc.activeTurnId,
    });
  }
  proc.responseBuffer = '';
  await fallbackToCodexExec(agent, proc, workspace, new Error(`Codex stream disconnected ${retry.count}/${retry.total}; early retry limit is ${CODEX_STREAM_RETRY_LIMIT}.`));
  return true;
}
