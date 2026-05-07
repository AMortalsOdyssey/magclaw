async function fallbackToCodexExec(agent, proc, workspace, error) {
  clearAgentRunWatchdog(proc);
  proc.usedLegacyFallback = true;
  addSystemEvent('agent_runtime_fallback', `${agent.name} falling back to legacy codex exec: ${error.message}`, { agentId: agent.id });
  const previousChild = proc.child;
  proc.child = null;
  if (previousChild && !previousChild.killed) previousChild.kill('SIGTERM');
  await startCodexAgentLegacy(agent, proc, workspace);
}

async function startCodexAgentLegacy(agent, proc, workspace) {
  const standingPrompt = createAgentStandingPrompt(agent, proc.spaceType, proc.spaceId);
  const promptMessages = proc.inbox.slice();
  proc.promptMessageCount = promptMessages.length;
  const turnPrompt = createAgentTurnPrompt(promptMessages, agent);
  const fullPrompt = `${standingPrompt}\n\n---\n\n${turnPrompt}`;
  const runtime = resolveCodexRuntime(agent, promptMessages);
  const codexHome = await prepareAgentCodexHome(agent);

  const outputFile = path.join(RUNS_DIR, `${proc.sessionId}-agent-response.txt`);

  // Codex exec mode for agent conversation
  const args = [
    'exec',
    ...magclawMcpConfigArgs(agent),
    '--json',
    '--skip-git-repo-check',
    '--sandbox', state.settings.sandbox || 'read-only',
    '-C', workspace,
    '-o', outputFile,
  ];

  if (runtime.model) {
    args.push('-m', runtime.model);
  }

  if (runtime.reasoningEffort) {
    args.push('-c', `model_reasoning_effort=${JSON.stringify(runtime.reasoningEffort)}`);
  }

  args.push('-');

  proc.status = 'running';
  setAgentStatus(agent, 'thinking', 'codex_legacy_turn_started', {
    activeWorkItemIds: normalizeIds(promptMessages.map((message) => message?.workItemId)),
    runtimeModel: runtime.model,
    runtimeReasoningEffort: runtime.reasoningEffort,
    runtimeOverrideReason: runtime.overrideReason,
  });
  addSystemEvent('agent_started', `${agent.name} started with Codex`, {
    agentId: agent.id,
    model: runtime.model,
    reasoningEffort: runtime.reasoningEffort,
    overrideReason: runtime.overrideReason,
  });
  markWorkItemsDelivered(promptMessages, 'turn');
  await persistState();
  broadcastState();

  const child = spawn(state.settings.codexPath || 'codex', args, {
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(agent.envVars ? Object.fromEntries(agent.envVars.map(e => [e.key, e.value])) : {}),
      CODEX_HOME: codexHome,
      MAGCLAW_AGENT_ID: agent.id,
      MAGCLAW_AGENT_DATA_DIR: agentDataDir(agent),
      MAGCLAW_SERVER_URL: `http://${HOST}:${PORT}`,
    },
  });

  proc.child = child;
  let stdoutBuffer = '';

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) {
        try {
          const event = JSON.parse(line);
          addSystemEvent('agent_activity', summarizeCodexEvent(event), { agentId: agent.id, raw: event });
        } catch {
          // ignore non-JSON lines
        }
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    const msg = chunk.toString().trim();
    if (msg) {
      addSystemEvent('agent_stderr', msg, { agentId: agent.id });
    }
  });

  child.on('error', async (error) => {
    proc.status = 'error';
    setAgentStatus(agent, 'error', 'codex_legacy_error');
    addSystemEvent('agent_error', `${agent.name} error: ${error.message}`, { agentId: agent.id });
    await persistState();
    broadcastState();
    agentProcesses.delete(agent.id);
  });

  child.on('close', async (code) => {
    const queuedMessages = proc.stopRequested ? (proc.restartMessagesAfterStop || []) : proc.inbox.slice(proc.promptMessageCount);
    const sourceMessage = proc.inbox[Math.max(0, proc.promptMessageCount - 1)] || null;
    proc.status = 'idle';
    setAgentStatus(agent, 'idle', 'codex_legacy_closed', { activeWorkItemIds: [] });

    // Read the output file for the response
    let responseText = '';
    try {
      responseText = (await readFile(outputFile, 'utf8')).trim();
    } catch {
      responseText = '';
    }

    const fallbackGuard = { workItemIds: [sourceMessage?.workItemId].filter(Boolean) };
    if (responseText && proc.suppressOutput) {
      addSystemEvent('agent_stdout_suppressed', `${agent.name} stopped before posting final stdout.`, {
        agentId: agent.id,
        workItemId: sourceMessage?.workItemId || null,
      });
    } else if (responseText && turnMetaAllWorkStopped(fallbackGuard)) {
      addSystemEvent('agent_stdout_suppressed', `${agent.name} output was suppressed for stopped work.`, {
        agentId: agent.id,
        workItemId: sourceMessage?.workItemId || null,
      });
    } else if (responseText && !turnMetaHasExplicitSend(fallbackGuard)) {
      await postAgentResponse(agent, proc.spaceType, proc.spaceId, responseText, proc.parentMessageId, { sourceMessage });
    } else if (responseText) {
      addSystemEvent('agent_stdout_suppressed', `${agent.name} used send_message; final stdout fallback was suppressed.`, {
        agentId: agent.id,
        workItemId: sourceMessage?.workItemId || null,
      });
    }

    addSystemEvent(proc.stopRequested ? 'agent_stopped' : 'agent_completed', `${agent.name} ${proc.stopRequested ? 'stopped' : 'finished'} (code ${code})`, { agentId: agent.id });
    await persistState();
    broadcastState();
    agentProcesses.delete(agent.id);
    restartAgentWithQueuedMessages(agent, proc, queuedMessages);
  });

  // Write the prompt to stdin
  child.stdin.write(fullPrompt);
  child.stdin.end();
}

function restartAgentWithQueuedMessages(agent, proc, queuedMessages = []) {
  if (!queuedMessages.length) return;
  const firstQueued = queuedMessages[0];
  const nextSpaceType = firstQueued.spaceType || proc.spaceType;
  const nextSpaceId = firstQueued.spaceId || proc.spaceId;
  addSystemEvent('agent_queue_drained', `${agent.name} has ${queuedMessages.length} queued message(s)`, {
    agentId: agent.id,
    count: queuedMessages.length,
    spaceType: nextSpaceType,
    spaceId: nextSpaceId,
  });
  startAgentProcess(agent, nextSpaceType, nextSpaceId, queuedMessages).catch((error) => {
    addSystemEvent('agent_error', `${agent.name} queue restart failed: ${error.message}`, { agentId: agent.id });
  });
}

function partitionMessagesByScope(messages, scope) {
  const scoped = [];
  const other = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    (deliveryMessageMatchesScope(message, scope) ? scoped : other).push(message);
  }
  return { scoped, other };
}

function partitionMessagesByTask(messages, task) {
  const scoped = [];
  const other = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    (deliveryMessageMatchesTask(message, task) ? scoped : other).push(message);
  }
  return { scoped, other };
}

function stopWorkItemsForScope(scope, agentId = null) {
  const stopped = [];
  state.workItems = Array.isArray(state.workItems) ? state.workItems : [];
  for (const item of state.workItems) {
    if (agentId && item.agentId !== agentId) continue;
    if (!workItemMatchesScope(item, scope)) continue;
    if (item.status === 'responded' || item.status === 'stopped') continue;
    item.status = 'stopped';
    item.stoppedAt = item.stoppedAt || now();
    item.updatedAt = now();
    item.stopScope = scope ? { spaceType: scope.spaceType, spaceId: scope.spaceId } : null;
    stopped.push(item.id);
  }
  return stopped;
}

function stopWorkItemsForTask(task, agentId = null) {
  const stopped = [];
  state.workItems = Array.isArray(state.workItems) ? state.workItems : [];
  for (const item of state.workItems) {
    if (agentId && item.agentId !== agentId) continue;
    if (!workItemMatchesTask(item, task)) continue;
    if (item.status === 'responded' || item.status === 'stopped') continue;
    item.status = 'stopped';
    item.stoppedAt = item.stoppedAt || now();
    item.updatedAt = now();
    item.stopTaskId = task.id;
    stopped.push(item.id);
  }
  return stopped;
}

function activeTurnMetas(proc) {
  const ids = proc?.activeTurnIds instanceof Set
    ? [...proc.activeTurnIds]
    : (proc?.activeTurnId ? [proc.activeTurnId] : []);
  return ids.map((id) => proc.turnMeta?.get(id)).filter(Boolean);
}

function activeDeliveryMessagesOutsideTask(proc, task) {
  const outsideWorkItemIds = new Set();
  for (const meta of activeTurnMetas(proc)) {
    if (!turnMetaMatchesTask(meta, task)) continue;
    for (const id of normalizeIds(meta.workItemIds || [])) {
      const item = findWorkItem(id);
      if (item && !workItemMatchesTask(item, task) && item.status !== 'responded' && item.status !== 'stopped') {
        outsideWorkItemIds.add(id);
      }
    }
  }
  if (!outsideWorkItemIds.size) return [];
  return (Array.isArray(proc?.inbox) ? proc.inbox : [])
    .filter((message) => message?.workItemId && outsideWorkItemIds.has(message.workItemId));
}

function uniqueDeliveryMessages(messages) {
  const seen = new Set();
  const result = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message) continue;
    const key = message.workItemId || message.id;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    result.push(message);
  }
  return result;
}

function processHasOnlyScopedActiveWork(proc, scope) {
  const metas = activeTurnMetas(proc);
  if (metas.length) {
    return metas.every((meta) => turnMetaMatchesScope(meta, scope) && !turnMetaHasWorkOutsideScope(meta, scope));
  }
  return spaceMatchesScope(proc, scope);
}

function processHasActiveTaskWork(proc, task) {
  return activeTurnMetas(proc).some((meta) => turnMetaMatchesTask(meta, task));
}

function stopAgentProcessForScope(agent, proc, scope, restartMessages = []) {
  clearAgentBusyDeliveryTimer(proc);
  clearAgentRunWatchdog(proc);
  proc.stopRequested = true;
  proc.suppressOutput = true;
  proc.stoppedAt = now();
  proc.stoppedScope = scope ? { spaceType: scope.spaceType, spaceId: scope.spaceId } : null;
  proc.restartMessagesAfterStop = restartMessages.filter(Boolean);
  proc.pendingDeliveryMessages = [];
  proc.pendingInitialMessages = [];
  proc.pendingInitialPrompt = null;
  setAgentStatus(agent, proc.restartMessagesAfterStop.length ? 'queued' : 'idle', 'agent_stop_scope');
  if (proc.child && !proc.child.killed) {
    proc.child.kill('SIGTERM');
    return true;
  }
  agentProcesses.delete(agent.id);
  if (proc.restartMessagesAfterStop.length) restartAgentWithQueuedMessages(agent, proc, proc.restartMessagesAfterStop);
  return false;
}

function stopAgentProcessForTask(agent, proc, task, restartMessages = []) {
  clearAgentBusyDeliveryTimer(proc);
  clearAgentRunWatchdog(proc);
  proc.stopRequested = true;
  proc.suppressOutput = true;
  proc.stoppedAt = now();
  proc.stoppedTaskId = task.id;
  proc.restartMessagesAfterStop = uniqueDeliveryMessages(restartMessages);
  proc.pendingDeliveryMessages = [];
  proc.pendingInitialMessages = [];
  proc.pendingInitialPrompt = null;
  setAgentStatus(agent, proc.restartMessagesAfterStop.length ? 'queued' : 'idle', 'agent_stop_task');
  if (proc.child && !proc.child.killed) {
    proc.child.kill('SIGTERM');
    return true;
  }
  agentProcesses.delete(agent.id);
  if (proc.restartMessagesAfterStop.length) restartAgentWithQueuedMessages(agent, proc, proc.restartMessagesAfterStop);
  return false;
}

function stopAgentProcesses(scope = null) {
  const stoppedAgents = [];
  const stoppedWorkItems = [];
  for (const [agentId, proc] of agentProcesses.entries()) {
    const agent = findAgent(agentId);
    if (!agent) continue;
    const stoppedForAgent = stopWorkItemsForScope(scope, agentId);
    stoppedWorkItems.push(...stoppedForAgent);

    const inbox = partitionMessagesByScope(proc.inbox, scope);
    const pending = partitionMessagesByScope(proc.pendingDeliveryMessages, scope);
    const initial = partitionMessagesByScope(proc.pendingInitialMessages, scope);
    const activeMetas = activeTurnMetas(proc);
    const pendingActiveScoped = !activeMetas.length && deliveryMessageMatchesScope(proc.lastSourceMessage, scope);
    proc.inbox = inbox.other;
    proc.pendingDeliveryMessages = pending.other;
    proc.pendingInitialMessages = initial.other;

    const restartMessages = [...inbox.other, ...pending.other, ...initial.other];
    const removedMessages = inbox.scoped.length + pending.scoped.length + initial.scoped.length;
    const activeScopedOnly = processHasOnlyScopedActiveWork(proc, scope) || pendingActiveScoped;
    const shouldStop = !scope || activeScopedOnly || (removedMessages > 0 && !activeMetas.length && (spaceMatchesScope(proc, scope) || pendingActiveScoped));

    if (shouldStop) {
      stopAgentProcessForScope(agent, proc, scope, restartMessages);
      stoppedAgents.push(agentId);
    } else if (removedMessages > 0 || stoppedForAgent.length) {
      clearAgentBusyDeliveryTimer(proc);
      if (!restartMessages.length && !activeMetas.length) setAgentStatus(agent, 'idle', 'agent_stop_scope_pruned');
    }
  }
  return {
    stoppedAgents: normalizeIds(stoppedAgents),
    stoppedWorkItems: normalizeIds(stoppedWorkItems),
  };
}

function stopAgentProcessesForTask(task) {
  const stoppedAgents = [];
  const stoppedWorkItems = [];
  for (const [agentId, proc] of agentProcesses.entries()) {
    const agent = findAgent(agentId);
    if (!agent) continue;
    const activeTask = processHasActiveTaskWork(proc, task);
    const restartActiveMessages = activeTask ? activeDeliveryMessagesOutsideTask(proc, task) : [];
    const stoppedForAgent = stopWorkItemsForTask(task, agentId);
    stoppedWorkItems.push(...stoppedForAgent);

    const inbox = partitionMessagesByTask(proc.inbox, task);
    const pending = partitionMessagesByTask(proc.pendingDeliveryMessages, task);
    const initial = partitionMessagesByTask(proc.pendingInitialMessages, task);
    proc.inbox = inbox.other;
    proc.pendingDeliveryMessages = pending.other;
    proc.pendingInitialMessages = initial.other;

    const restartMessages = uniqueDeliveryMessages([
      ...restartActiveMessages,
      ...inbox.other,
      ...pending.other,
      ...initial.other,
    ]);
    const removedMessages = inbox.scoped.length + pending.scoped.length + initial.scoped.length;
    const shouldStop = activeTask || (removedMessages > 0 && !activeTurnMetas(proc).length);

    if (shouldStop) {
      stopAgentProcessForTask(agent, proc, task, restartMessages);
      stoppedAgents.push(agentId);
    } else if (removedMessages > 0 || stoppedForAgent.length) {
      clearAgentBusyDeliveryTimer(proc);
      if (!restartMessages.length && !activeTurnMetas(proc).length) setAgentStatus(agent, 'idle', 'agent_stop_task_pruned');
    }
  }
  return {
    stoppedAgents: normalizeIds(stoppedAgents),
    stoppedWorkItems: normalizeIds(stoppedWorkItems),
  };
}

function steerAgentProcessesForTaskStop(task, actorId = 'hum_local', replyId = null) {
  const steeredAgents = [];
  const stoppedWorkItems = [];
  for (const [agentId, proc] of agentProcesses.entries()) {
    const agent = findAgent(agentId);
    if (!agent) continue;
    const activeTurnIds = proc.activeTurnIds instanceof Set
      ? [...proc.activeTurnIds]
      : (proc.activeTurnId ? [proc.activeTurnId] : []);
    const taskTurnIds = activeTurnIds.filter((turnId) => turnMetaMatchesTask(proc.turnMeta?.get(turnId), task));
    const inbox = partitionMessagesByTask(proc.inbox, task);
    const pending = partitionMessagesByTask(proc.pendingDeliveryMessages, task);
    const initial = partitionMessagesByTask(proc.pendingInitialMessages, task);
    proc.inbox = inbox.other;
    proc.pendingDeliveryMessages = pending.other;
    proc.pendingInitialMessages = initial.other;
    const removedMessages = inbox.scoped.length + pending.scoped.length + initial.scoped.length;
    const taskWorkIds = normalizeIds([
      ...taskTurnIds.flatMap((turnId) => proc.turnMeta?.get(turnId)?.workItemIds || []),
      ...inbox.scoped.map((message) => message?.workItemId),
      ...pending.scoped.map((message) => message?.workItemId),
      ...initial.scoped.map((message) => message?.workItemId),
    ]);
    stoppedWorkItems.push(...taskWorkIds);

    if (!taskTurnIds.length) {
      if (removedMessages > 0 || taskWorkIds.length) {
        clearAgentBusyDeliveryTimer(proc);
        if (!activeTurnMetas(proc).length && !proc.pendingDeliveryMessages?.length) setAgentStatus(agent, 'idle', 'task_stop_pruned');
      }
      continue;
    }

    if (!proc.threadId || !proc.child || proc.child.killed) continue;
    proc.pendingTurnRequests = proc.pendingTurnRequests || new Map();
    for (const turnId of taskTurnIds) {
      const meta = proc.turnMeta?.get(turnId);
      const workItemIds = normalizeIds(meta?.workItemIds || taskWorkIds);
      const requestId = sendCodexAppServerRequest(proc, 'turn/steer', {
        threadId: proc.threadId,
        expectedTurnId: turnId,
        input: [{
          type: 'text',
          text: `System: The user stopped ${taskLabel(task)} in this thread. Stop work for that task, do not send a final answer for it, keep this agent session alive, and wait for new messages.`,
        }],
      });
      if (!requestId) continue;
      proc.pendingTurnRequests.set(requestId, {
        parentMessageId: meta?.parentMessageId || null,
        sourceMessage: meta?.sourceMessage || null,
        spaceType: meta?.spaceType || task.spaceType,
        spaceId: meta?.spaceId || task.spaceId,
        workItemIds,
        targetKeys: meta?.targetKeys || [],
      });
    }
    if (taskTurnIds.length) {
      steeredAgents.push(agentId);
      addSystemEvent('agent_task_stop_steered', `${agent.name} was asked to stop ${taskLabel(task)} without closing its Codex session.`, {
        agentId,
        taskId: task.id,
        actorId,
        replyId,
      });
    }
  }
  return {
    steeredAgents: normalizeIds(steeredAgents),
    stoppedWorkItems: normalizeIds(stoppedWorkItems),
  };
}

function stopRunsForScope(scope = null) {
  const stoppedRuns = [];
  for (const [runId, child] of runningProcesses.entries()) {
    const run = findRun(runId);
    if (!run || (scope && !runMatchesScope(run, scope))) continue;
    run.stopRequested = true;
    child.kill('SIGTERM');
    stoppedRuns.push(runId);
  }
  return normalizeIds(stoppedRuns);
}

function stopRunsForTask(task) {
  const stoppedRuns = [];
  for (const [runId, child] of runningProcesses.entries()) {
    const run = findRun(runId);
    if (!run || !runMatchesTask(run, task)) continue;
    run.stopRequested = true;
    child.kill('SIGTERM');
    stoppedRuns.push(runId);
  }
  return normalizeIds(stoppedRuns);
}

function waitForAgentProcessExit(proc, timeoutMs = 5000) {
  if (!proc?.child) return Promise.resolve();
  if (proc.child.exitCode !== null || proc.child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        proc.child.kill('SIGKILL');
      } catch {
        // Process already ended.
      }
      resolve();
    }, timeoutMs);
    proc.child.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stopAgentProcessForControl(agent) {
  const proc = agentProcesses.get(agent.id);
  if (!proc) return false;
  clearAgentBusyDeliveryTimer(proc);
  clearAgentRunWatchdog(proc);
  proc.stopRequested = true;
  proc.suppressOutput = true;
  proc.restartMessagesAfterStop = [];
  proc.pendingDeliveryMessages = [];
  proc.pendingInitialMessages = [];
  proc.pendingInitialPrompt = null;
  if (proc.child && !proc.child.killed) {
    proc.child.kill('SIGTERM');
    await waitForAgentProcessExit(proc);
  } else {
    agentProcesses.delete(agent.id);
  }
  return true;
}
