async function startAgentProcess(agent, spaceType, spaceId, initialMessage) {
  const agentId = agent.id;
  const runtime = getAgentRuntime(agent);
  const workspace = path.resolve(agent.workspace || state.settings.defaultWorkspace || ROOT);
  const initialMessages = Array.isArray(initialMessage)
    ? initialMessage.filter(Boolean)
    : (initialMessage ? [initialMessage] : []);

  // Check if agent already has a running process
  if (agentProcesses.has(agentId)) {
    const proc = agentProcesses.get(agentId);
    if (proc.status === 'running' || proc.status === 'starting') {
      // Queue the message for delivery
      proc.inbox.push(...initialMessages);
      return proc;
    }
  }

  // Create agent process entry
  const sessionId = makeId('sess');
  const proc = {
    sessionId,
    agentId,
    spaceType,
    spaceId,
    status: 'starting',
    inbox: initialMessages,
    pendingDeliveryMessages: [],
    busyDeliveryTimer: null,
    promptMessageCount: 0,
    child: null,
    runtime,
    parentMessageId: initialMessages[0]?.parentMessageId || null,
    startedAt: now(),
    workspace,
  };
  agentProcesses.set(agentId, proc);

  // Update agent status
  setAgentStatus(agent, 'starting', 'delivery_started');
  await persistState();
  broadcastState();

  addSystemEvent('agent_starting', `Starting ${agent.name} (${runtime})`, { agentId, sessionId });

  if (runtime === 'claude') {
    await startClaudeAgent(agent, proc, workspace);
  } else {
    await startCodexAgent(agent, proc, workspace);
  }

  return proc;
}

async function startClaudeAgent(agent, proc, workspace) {
  // TODO: Move Claude to the same persistent resume/steer contract once its CLI exposes a stable app-server style API.
  const standingPrompt = createAgentStandingPrompt(agent, proc.spaceType, proc.spaceId);
  const promptMessages = proc.inbox.slice();
  proc.promptMessageCount = promptMessages.length;
  proc.lastSourceMessage = promptMessages[promptMessages.length - 1] || null;
  const turnPrompt = createAgentTurnPrompt(promptMessages, agent);
  const fullPrompt = `${standingPrompt}\n\n---\n\n${turnPrompt}`;

  // Claude Code headless mode using --print for simple response
  const args = [
    '--print',
    '-p', fullPrompt,
  ];

  if (agent.model) {
    args.push('--model', agent.model);
  }

  proc.status = 'running';
  addSystemEvent('agent_started', `${agent.name} started with Claude Code`, { agentId: agent.id });
  const deliveredWorkItemIds = markWorkItemsDelivered(promptMessages, 'turn');
  setAgentStatus(agent, 'thinking', 'claude_turn_started', { activeWorkItemIds: deliveredWorkItemIds });
  await persistState();
  broadcastState();

  const child = spawn('claude', args, {
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(agent.envVars ? Object.fromEntries(agent.envVars.map(e => [e.key, e.value])) : {}),
    },
  });

  proc.child = child;
  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  child.on('error', async (error) => {
    proc.status = 'error';
    setAgentStatus(agent, 'error', 'claude_error', { activeWorkItemIds: [] });
    addSystemEvent('agent_error', `${agent.name} error: ${error.message}`, { agentId: agent.id });
    await persistState();
    broadcastState();
    agentProcesses.delete(agent.id);
  });

  child.on('close', async (code) => {
    const queuedMessages = proc.stopRequested ? (proc.restartMessagesAfterStop || []) : proc.inbox.slice(proc.promptMessageCount);
    const sourceMessage = proc.inbox[Math.max(0, proc.promptMessageCount - 1)] || null;
    proc.status = 'idle';
    setAgentStatus(agent, 'idle', 'claude_turn_closed', { activeWorkItemIds: [] });

	    // Post the response back to the conversation
	    const responseText = stdout.trim() || stderr.trim() || '(No response)';
	    const fallbackGuard = { workItemIds: [sourceMessage?.workItemId].filter(Boolean) };
	    if (responseText && responseText !== '(No response)' && proc.suppressOutput) {
	      addSystemEvent('agent_stdout_suppressed', `${agent.name} stopped before posting final stdout.`, {
	        agentId: agent.id,
	        workItemId: sourceMessage?.workItemId || null,
	      });
	    } else if (responseText && responseText !== '(No response)' && turnMetaAllWorkStopped(fallbackGuard)) {
	      addSystemEvent('agent_stdout_suppressed', `${agent.name} output was suppressed for stopped work.`, {
	        agentId: agent.id,
	        workItemId: sourceMessage?.workItemId || null,
	      });
	    } else if (responseText && responseText !== '(No response)' && !turnMetaHasExplicitSend(fallbackGuard)) {
	      const posted = await postAgentResponse(agent, proc.spaceType, proc.spaceId, responseText, proc.parentMessageId, { sourceMessage });
	      markFallbackResponseWorkItem(sourceMessage, posted);
	    } else if (responseText && responseText !== '(No response)') {
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
}

async function startCodexAgent(agent, proc, workspace) {
  const standingPrompt = createAgentStandingPrompt(agent, proc.spaceType, proc.spaceId);
  const promptMessages = proc.inbox.slice();
  proc.promptMessageCount = promptMessages.length;
  const turnPrompt = createAgentTurnPrompt(promptMessages, agent);
  const runtime = resolveCodexRuntime(agent, promptMessages);
  const args = ['app-server', ...magclawMcpConfigArgs(agent), '--listen', 'stdio://'];
  const codexHome = await prepareAgentCodexHome(agent);

  proc.requestId = 0;
  proc.workspace = workspace;
  proc.stdoutBuffer = '';
	  proc.responseBuffer = '';
	  proc.activeTurnId = null;
	  proc.activeTurnIds = new Set();
	  proc.activeTurnTargets = new Set();
	  proc.pendingTurnRequests = new Map();
  proc.pendingAppServerRequests = new Map();
  proc.pendingMcpToolCalls = new Map();
  proc.turnWatchdogTimer = null;
  proc.lastTurnProgressAt = null;
  proc.lastTurnProgressReason = null;
  proc.lastActivity = 'working';
  proc.lastActivityDetail = 'Starting Codex app-server';
  proc.lastActivityAt = now();
  proc.lastActivityAtMs = Date.now();
  proc.lastActivityHeartbeatAt = Date.now();
  proc.runtimeProgressStaleSince = null;
  proc.turnMeta = new Map();
  proc.pendingInitialPrompt = promptMessages.length ? turnPrompt : null;
  proc.pendingInitialMessages = promptMessages;
  proc.pendingDeliveryMessages = Array.isArray(proc.pendingDeliveryMessages) ? proc.pendingDeliveryMessages : [];
  proc.busyDeliveryTimer = proc.busyDeliveryTimer || null;
  proc.pendingThreadRequest = null;
  proc.initializeRequestId = null;
  proc.threadReady = false;
  proc.usedLegacyFallback = false;
  proc.currentCodexRuntime = runtime;
  proc.status = 'starting';
  setAgentStatus(agent, 'starting', 'codex_app_server_start');
  noteAgentRuntimeProgress(agent, proc, 'working', 'Starting Codex app-server', {
    sessionId: proc.sessionId || null,
  });
  agent.runtimeLastStartedAt = now();
  await writeAgentSessionFile(agent).catch(() => {});

  addSystemEvent('agent_started', `${agent.name} starting with Codex app-server`, { agentId: agent.id });
  addSystemEvent('agent_codex_app_server_spawn', `${agent.name} spawning Codex app-server.`, {
    agentId: agent.id,
    sessionId: proc.sessionId,
    cwd: workspace,
    codexHome,
    model: runtime.model,
    reasoningEffort: runtime.reasoningEffort || null,
  });

  const child = spawn(state.settings.codexPath || 'codex', args, {
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NO_COLOR: '1',
      ...(agent.envVars ? Object.fromEntries(agent.envVars.map(e => [e.key, e.value])) : {}),
      CODEX_HOME: codexHome,
      MAGCLAW_AGENT_ID: agent.id,
      MAGCLAW_AGENT_DATA_DIR: agentDataDir(agent),
      MAGCLAW_SERVER_URL: `http://${HOST}:${PORT}`,
    },
  });

  proc.child = child;

  child.stdout.on('data', (chunk) => {
    proc.stdoutBuffer += chunk.toString();
    const lines = proc.stdoutBuffer.split(/\r?\n/);
    proc.stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      handleCodexAppServerLine(agent, proc, line).catch((error) => {
        addSystemEvent('agent_error', `${agent.name} app-server event error: ${error.message}`, { agentId: agent.id });
      });
    }
  });

  child.stderr.on('data', (chunk) => {
    const msg = chunk.toString().trim();
    if (msg) addSystemEvent('agent_stderr', msg, { agentId: agent.id });
    const retry = parseCodexStreamRetry(msg);
    if (retry) {
      triggerCodexStreamRetryFallback(agent, proc, workspace, retry).catch((error) => {
        addSystemEvent('agent_error', `${agent.name} stream retry fallback failed: ${error.message}`, { agentId: agent.id });
      });
    }
  });

  child.on('error', async (error) => {
    if (proc.child !== child) return;
    clearAgentBusyDeliveryTimer(proc);
    clearAgentRunWatchdog(proc);
    if (!proc.threadReady && !proc.usedLegacyFallback) {
      await fallbackToCodexExec(agent, proc, workspace, error);
      return;
    }
    proc.status = 'error';
    setAgentStatus(agent, 'error', 'codex_app_server_error');
    addSystemEvent('agent_error', `${agent.name} error: ${error.message}`, { agentId: agent.id });
    await persistState();
    broadcastState();
    agentProcesses.delete(agent.id);
  });

  child.on('close', async (code) => {
    if (proc.child !== child) return;
    clearAgentBusyDeliveryTimer(proc);
    clearAgentRunWatchdog(proc);
    if (!proc.threadReady && !proc.usedLegacyFallback) {
      if (proc.stopRequested) {
        proc.status = 'idle';
        setAgentStatus(agent, proc.restartMessagesAfterStop?.length ? 'queued' : 'idle', 'codex_stopped_before_ready');
        addSystemEvent('agent_stopped', `${agent.name} stopped before Codex session was ready`, { agentId: agent.id });
        await persistState();
        broadcastState();
        agentProcesses.delete(agent.id);
        restartAgentWithQueuedMessages(agent, proc, proc.restartMessagesAfterStop || []);
        return;
      }
      await fallbackToCodexExec(agent, proc, workspace, new Error(`Codex app-server exited before thread start (code ${code ?? 'unknown'}).`));
      return;
    }
    if (!proc.suppressOutput && proc.responseBuffer.trim()) {
      const sourceMessage = proc.lastSourceMessage || proc.inbox[Math.max(0, proc.promptMessageCount - 1)] || null;
      if (turnMetaHasExplicitSend({ workItemIds: [sourceMessage?.workItemId].filter(Boolean) })) {
        addSystemEvent('agent_stdout_suppressed', `${agent.name} used send_message; final stdout fallback was suppressed.`, {
          agentId: agent.id,
          workItemId: sourceMessage?.workItemId || null,
        });
		      } else {
		        const posted = await postAgentResponse(agent, proc.spaceType, proc.spaceId, proc.responseBuffer.trim(), deliveryParentMessageId(sourceMessage, proc.parentMessageId), { sourceMessage });
		        markFallbackResponseWorkItem(sourceMessage, posted);
		      }
      proc.responseBuffer = '';
    } else if (proc.suppressOutput && proc.responseBuffer.trim()) {
      proc.responseBuffer = '';
      addSystemEvent('agent_stdout_suppressed', `${agent.name} stopped before posting buffered output.`, { agentId: agent.id });
    }
    proc.status = proc.stopRequested || code === 0 ? 'idle' : 'error';
    setAgentStatus(agent, proc.stopRequested
      ? (proc.restartMessagesAfterStop?.length ? 'queued' : 'idle')
      : (code === 0 ? 'idle' : 'error'), 'codex_app_server_closed');
    addSystemEvent(proc.stopRequested ? 'agent_stopped' : (code === 0 ? 'agent_app_server_closed' : 'agent_error'), `${agent.name} Codex app-server ${proc.stopRequested ? 'stopped' : 'exited'} (code ${code ?? 'unknown'})`, { agentId: agent.id });
    await writeAgentSessionFile(agent).catch(() => {});
    await persistState();
    broadcastState();
    agentProcesses.delete(agent.id);
    restartAgentWithQueuedMessages(agent, proc, proc.restartMessagesAfterStop || []);
  });

  proc.initializeRequestId = sendCodexAppServerRequest(proc, 'initialize', {
    clientInfo: { name: 'magclaw', version: '0.1.0' },
    capabilities: { experimentalApi: true },
  });
  proc.pendingThreadRequest = {
    method: agent.runtimeSessionId ? 'thread/resume' : 'thread/start',
    params: {
      ...(agent.runtimeSessionId ? { threadId: agent.runtimeSessionId } : {}),
      cwd: workspace,
      approvalPolicy: 'never',
      sandbox: state.settings.sandbox || 'workspace-write',
      developerInstructions: standingPrompt,
      model: runtime.model,
      ...(codexThreadConfig(runtime) ? { config: codexThreadConfig(runtime) } : {}),
    },
  };
  await persistState();
  broadcastState();
}
