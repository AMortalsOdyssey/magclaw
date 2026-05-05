import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { buildAgentContextPack, renderAgentContextPack } from './agent-context.js';
import { codexThreadConfig, parseCodexStreamRetry } from './codex-runtime.js';
import { normalizeIds } from './mentions.js';

// Agent runtime and delivery manager.
// The module owns long-lived Agent process state, Codex app-server turns,
// legacy exec fallback, work item delivery, and task mutations performed by
// Agents. HTTP route modules call this manager through explicit dependencies.

export function createAgentRuntimeManager(deps) {
  const {
    addCollabEvent,
    addSystemEvent,
    addSystemReply,
    addTaskHistory,
    addTaskTimelineMessage,
    agentAvailableForAutoWork,
    agentDataDir,
    agentProcesses,
    autoTaskMessageIntent,
    broadcastState,
    channelAgentIds,
    channelHumanIds,
    CODEX_STREAM_RETRY_LIMIT,
    codexRuntimeOverrideForDelivery,
    deliveryMessageMatchesScope,
    deliveryMessageMatchesTask,
    displayActor,
    ensureAgentWorkspace,
    ensureTaskThread,
    extractLocalReferences,
    extractMentions,
    findAgent,
    findChannel,
    findHuman,
    findMessage,
    findMission,
    findRun,
    findTask,
    findTaskForThreadMessage,
    findWorkItem,
    getState,
    HOST,
    httpError,
    localReferenceLines,
    makeId,
    MAX_AGENT_RELAY_DEPTH,
    now,
    persistState,
    pickAvailableAgent,
    prepareAgentCodexHome,
    prepareAgentResponseBody,
    projectsForSpace,
    renderMentionsForAgent,
    resolveCodexRuntime,
    resolveConversationSpace,
    runMatchesTask,
    ROOT,
    runningProcesses,
    RUNS_DIR,
    scheduleAgentMemoryWriteback,
    setAgentStatus,
    shouldStartThreadForAgentDelivery,
    spaceDisplayName,
    spaceMatchesScope,
    taskIsClosed,
    taskLabel,
    taskMatchesScope,
    targetForConversation,
    turnMetaAllWorkCancelled,
    turnMetaHasWorkOutsideScope,
    turnMetaMatchesScope,
    turnMetaMatchesTask,
    writeAgentSessionFile,
    workItemMatchesScope,
    workItemMatchesTask,
    AGENT_BUSY_DELIVERY_DELAY_MS,
    PORT,
    normalizeConversationRecord,
    nextTaskNumber,
  } = deps;
  const state = new Proxy({}, {
    get(_target, prop) {
      return getState()?.[prop];
    },
    set(_target, prop, value) {
      getState()[prop] = value;
      return true;
    },
  });

// Agent Process Manager - handles agent conversations
function getAgentRuntime(agent) {
  const runtime = String(agent.runtime || '').toLowerCase();
  if (runtime.includes('claude')) return 'claude';
  if (runtime.includes('codex')) return 'codex';
  return 'codex'; // default
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function tomlArray(values) {
  return `[${values.map((value) => tomlString(value)).join(',')}]`;
}

function magclawMcpConfigArgs(agent) {
  const bridgePath = path.join(ROOT, 'server', 'magclaw-mcp-server.js');
  const baseUrl = `http://${HOST}:${PORT}`;
  return [
    '-c', 'wire_api="responses"',
    '-c', `mcp_servers.magclaw.command=${tomlString(process.execPath)}`,
    '-c', `mcp_servers.magclaw.args=${tomlArray([bridgePath, '--agent-id', agent.id, '--base-url', baseUrl])}`,
    '-c', 'mcp_servers.magclaw.startup_timeout_sec=30',
    '-c', 'mcp_servers.magclaw.tool_timeout_sec=120',
    '-c', 'mcp_servers.magclaw.enabled=true',
    '-c', 'mcp_servers.magclaw.required=true',
  ];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const CODEX_WARMUP_PROMPT = [
  'Runtime warmup for MagClaw.',
  'Reply with exactly: ready',
  'Do not call tools, do not inspect files, and do not write memory.',
].join('\n');

function createAgentStandingPrompt(agent, spaceType, spaceId) {
  const channel = spaceType === 'channel' ? findChannel(spaceId) : null;
  const spaceName = spaceType === 'dm'
    ? `DM with ${agent.name}`
    : `#${channel?.name || 'channel'}`;
  const toolTarget = spaceType === 'dm' ? `dm:${spaceId}` : `#${channel?.name || 'channel'}`;
  const agentsInSpace = spaceType === 'channel'
    ? channelAgentIds(channel).map(id => findAgent(id)).filter(Boolean)
    : state.agents.filter((item) => item.id === agent.id);
  const humansInSpace = spaceType === 'channel'
    ? channelHumanIds(channel).map(id => findHuman(id)).filter(Boolean)
    : state.humans.filter((item) => item.id === 'hum_local');
  const projectsInSpace = projectsForSpace(spaceType, spaceId);

  return [
    `You are ${agent.name}, an AI agent running in Magclaw.`,
    agent.description ? `Your role: ${agent.description}` : '',
    '',
    'Context:',
    `- You are in: ${spaceName}`,
    `- Your workspace: ${agent.workspace || state.settings.defaultWorkspace || ROOT}`,
    agentsInSpace.length ? `- Agents in this conversation: ${agentsInSpace.map((item) => {
      const label = item.id === agent.id ? `${item.name} (you)` : item.name;
      return item.description ? `${label} - ${item.description}` : label;
    }).join('; ')}` : '',
    humansInSpace.length ? `- Humans in this conversation: ${humansInSpace.map((item) => item.name).join(', ')}` : '',
    projectsInSpace.length ? `- Project folders in this conversation: ${projectsInSpace.map((item) => `${item.name}: ${item.path}`).join('; ')}` : '',
    '',
    'Guidelines:',
    '- Respond helpfully and concisely to the user.',
    '- In a channel, Magclaw may deliver the same open human message to every member agent, similar to a team chat. If the message is not directed at one specific agent and you have useful context, answer briefly from your role.',
    '- If the user names or @mentions another agent, respect that routing and avoid taking over unless you were also named or can add a small coordination note.',
    '- For ordinary chat or coordination, just answer in natural language. Do not run shell commands.',
    '- Do not run Codex native memory-writing, memory consolidation, or profile-update workflows inside MagClaw chat turns; use MagClaw memory writeback instead.',
    '- For simple Q&A, greetings, role questions, one-off lookups, weather/forecast requests, or lightweight coordination, answer in the current thread and do not create a task.',
    '- For simple lookup/weather requests, use at most one or two authoritative lookups, then reply with a compact answer. Do not inspect local files or run project/memory workflows unless the user explicitly asks.',
    '- Each delivered message includes a bracket header such as `[target=#all:msg_xxx workItem=wi_xxx msg=msg_xxx task=task_xxx ...]`. Treat target and workItem as routing authority.',
    '- For multi-channel, multi-task, or thread/task work, reply with the controlled send_message API: POST /api/agent-tools/messages/send using the exact target and workItemId from the current header.',
    '- If you call send_message for a work item, Magclaw will not duplicate your final stdout for that same turn. If you do not call send_message, Magclaw will post your final stdout back to the source thread as a compatibility fallback.',
    '- Never guess a channel or thread target. Use the exact target from the header or read/search history first.',
    '- Prefer the native MagClaw MCP tools when they are available: send_message, read_history, search_messages, search_agent_memory, read_agent_memory, write_memory, list_tasks, create_tasks, claim_tasks, and update_task_status. Their runtime names may be prefixed by the Codex MCP bridge.',
    '- If MCP tools are unavailable, you may call the controlled Magclaw agent tool APIs when needed: GET /api/agent-tools/history, GET /api/agent-tools/search, GET /api/agent-tools/memory/search, GET /api/agent-tools/memory/read, GET /api/agent-tools/tasks, POST /api/agent-tools/messages/send, POST /api/agent-tools/memory, POST /api/agent-tools/tasks, POST /api/agent-tools/tasks/claim, and POST /api/agent-tools/tasks/update.',
    `- Create a new task with: curl -sS -X POST http://${HOST}:${PORT}/api/agent-tools/tasks -H 'content-type: application/json' -d '{"agentId":"${agent.id}","channel":"${toolTarget}","claim":true,"tasks":[{"title":"Task title"}]}'`,
    `- Update a claimed task with: curl -sS -X POST http://${HOST}:${PORT}/api/agent-tools/tasks/update -H 'content-type: application/json' -d '{"agentId":"${agent.id}","taskId":"task_xxx","status":"in_review"}'`,
    `- Record durable memory with: curl -sS -X POST http://${HOST}:${PORT}/api/agent-tools/memory -H 'content-type: application/json' -d '{"agentId":"${agent.id}","kind":"preference","summary":"Short durable fact"}'. Use kind=capability, communication_style, preference, or memory.`,
    `- Search peer memory when name/role is not enough: curl -s "http://${HOST}:${PORT}/api/agent-tools/memory/search?agentId=${agent.id}&q=<query>&limit=10". Read a result with /api/agent-tools/memory/read?agentId=${agent.id}&targetAgentId=agt_xxx&path=notes/profile.md.`,
    '- Create or claim tasks only for durable work with progress/state: coding changes, debugging, deployment, docs/report deliverables, multi-step research, migrations, reviews, or when the user explicitly says task/as task/创建任务.',
    '- When a user asks for actionable durable work, claim the existing task if Magclaw already created one for you, then continue the work in the task thread.',
    '- Thread replies cannot become tasks directly. If new work emerges in a thread, create a new top-level task-message with sourceMessageId/sourceReplyId instead of claiming the reply.',
    '- If work already exists as a task, claim it instead of creating a duplicate.',
    '- Maintain your own MagClaw workspace memory during important task progress through the controlled memory API: keep MEMORY.md as a concise entrypoint, and put detailed dated notes in notes/.',
    '- MEMORY.md should contain short skills, active context, and brief recent-work titles only. Do not turn it into a diary; use notes/work-log.md for task logs and decisions.',
    '- If the user explicitly asks you to remember, record, learn a style, or update your specialty, acknowledge it normally. MagClaw also writes obvious explicit memory requests automatically, so do not claim that the filesystem is read-only.',
    '- Mention another participant with their visible name, for example @Alice. Do not expose internal ids like agt_xxx, hum_xxx, or raw <@...> tokens.',
    '- If a user references a local file or folder with @, treat the shown path as the original project file/folder, not as an uploaded attachment copy.',
    '- If asked to perform coding tasks, do them in your workspace and summarize the result.',
    '- Be conversational but professional.',
    '',
    'The user will send you messages. Respond naturally.',
  ].filter(Boolean).join('\n');
}

function messageAddressingHint(message, agent) {
  if (message.mentionedAgentIds?.includes(agent.id)) return ' mentioned you';
  return '';
}

function createAgentTurnPrompt(messages, agent) {
  return messages.map(m => {
    if (m.contextPack) {
      return renderAgentContextPack(m.contextPack, { state, targetAgentId: agent.id });
    }
    const author = displayActor(m.authorId);
    const refs = localReferenceLines(m.localReferences?.length ? m.localReferences : extractLocalReferences(m.body || ''));
    return `[${author}${messageAddressingHint(m, agent)}]: ${renderMentionsForAgent(m.body)}${refs ? `\nLocal project references:\n${refs}` : ''}`;
  }).join('\n\n');
}

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
  markWorkItemsDelivered(promptMessages, 'turn');
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
    setAgentStatus(agent, 'error', 'claude_error');
    addSystemEvent('agent_error', `${agent.name} error: ${error.message}`, { agentId: agent.id });
    await persistState();
    broadcastState();
    agentProcesses.delete(agent.id);
  });

  child.on('close', async (code) => {
    const queuedMessages = proc.stopRequested ? (proc.restartMessagesAfterStop || []) : proc.inbox.slice(proc.promptMessageCount);
    const sourceMessage = proc.inbox[Math.max(0, proc.promptMessageCount - 1)] || null;
    proc.status = 'idle';
    setAgentStatus(agent, 'idle', 'claude_turn_closed');

	    // Post the response back to the conversation
	    const responseText = stdout.trim() || stderr.trim() || '(No response)';
	    const fallbackGuard = { workItemIds: [sourceMessage?.workItemId].filter(Boolean) };
	    if (responseText && responseText !== '(No response)' && proc.suppressOutput) {
	      addSystemEvent('agent_stdout_suppressed', `${agent.name} stopped before posting final stdout.`, {
	        agentId: agent.id,
	        workItemId: sourceMessage?.workItemId || null,
	      });
	    } else if (responseText && responseText !== '(No response)' && turnMetaAllWorkCancelled(fallbackGuard)) {
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
  proc.stdoutBuffer = '';
	  proc.responseBuffer = '';
	  proc.activeTurnId = null;
	  proc.activeTurnIds = new Set();
	  proc.activeTurnTargets = new Set();
	  proc.pendingTurnRequests = new Map();
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
  agent.runtimeLastStartedAt = now();
  await writeAgentSessionFile(agent).catch(() => {});

  addSystemEvent('agent_started', `${agent.name} starting with Codex app-server`, { agentId: agent.id });

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

function nextCodexRequestId(proc) {
  proc.requestId = Number(proc.requestId || 0) + 1;
  return proc.requestId;
}

function sendCodexAppServerRequest(proc, method, params = {}) {
  if (!proc.child?.stdin?.writable) return null;
  const id = nextCodexRequestId(proc);
  proc.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return id;
}

function sendCodexAppServerNotification(proc, method, params = {}) {
  if (!proc.child?.stdin?.writable) return;
  proc.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

async function triggerCodexStreamRetryFallback(agent, proc, workspace, retry) {
  if (!retry || retry.count < CODEX_STREAM_RETRY_LIMIT) return false;
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
  rememberActiveTurnTargets(proc, mode, targetKeys);
  proc.currentCodexRuntime = runtime;
  proc.status = 'running';
  if (isWarmup) proc.warmupActive = true;
  setAgentStatus(agent, mode === 'steer' ? 'working' : 'thinking', isWarmup ? 'agent_warmup_started' : (mode === 'steer' ? 'agent_steered' : 'agent_turn_started'), {
    activeWorkItemIds: normalizeIds(promptMessages.map((message) => message?.workItemId)),
    runtimeModel: runtime.model,
    runtimeReasoningEffort: runtime.reasoningEffort,
    runtimeOverrideReason: runtime.overrideReason,
  });
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
    if (turnMeta && turnMetaAllWorkCancelled(turnMeta)) {
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
    proc.activeTurnId = null;
    proc.activeTurnTargets = new Set();
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
      return;
    }
  }

  if (message.error) {
    addSystemEvent('agent_error', `${agent.name} app-server request failed: ${message.error.message || 'unknown error'}`, { agentId: agent.id, raw: message.error });
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
      proc.status = 'running';
      setAgentStatus(agent, 'thinking', 'codex_turn_started');
      await persistState();
      broadcastState();
      break;
    }
    case 'item/agentMessage/delta': {
      const delta = message.params?.delta;
      if (typeof delta === 'string') proc.responseBuffer += delta;
      break;
    }
    case 'item/completed': {
      const item = message.params?.item;
      if (item?.type === 'agentMessage' && typeof item.text === 'string' && item.text && !proc.responseBuffer.includes(item.text)) {
        proc.responseBuffer += item.text;
      }
      if (item?.type === 'commandExecution' || item?.type === 'mcpToolCall' || item?.type === 'collabAgentToolCall') {
        addSystemEvent('agent_activity', summarizeCodexEvent(item), { agentId: agent.id, raw: item });
      }
      break;
    }
    case 'item/started': {
      const item = message.params?.item;
      if (item?.type) addSystemEvent('agent_activity', `${agent.name}: ${item.type}`, { agentId: agent.id, raw: item });
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

async function fallbackToCodexExec(agent, proc, workspace, error) {
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
    } else if (responseText && turnMetaAllWorkCancelled(fallbackGuard)) {
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

function cancelWorkItemsForScope(scope, agentId = null) {
  const cancelled = [];
  state.workItems = Array.isArray(state.workItems) ? state.workItems : [];
  for (const item of state.workItems) {
    if (agentId && item.agentId !== agentId) continue;
    if (!workItemMatchesScope(item, scope)) continue;
    if (item.status === 'responded' || item.status === 'cancelled') continue;
    item.status = 'cancelled';
    item.cancelledAt = item.cancelledAt || now();
    item.updatedAt = now();
    item.cancelScope = scope ? { spaceType: scope.spaceType, spaceId: scope.spaceId } : null;
    cancelled.push(item.id);
  }
  return cancelled;
}

function cancelWorkItemsForTask(task, agentId = null) {
  const cancelled = [];
  state.workItems = Array.isArray(state.workItems) ? state.workItems : [];
  for (const item of state.workItems) {
    if (agentId && item.agentId !== agentId) continue;
    if (!workItemMatchesTask(item, task)) continue;
    if (item.status === 'responded' || item.status === 'cancelled') continue;
    item.status = 'cancelled';
    item.cancelledAt = item.cancelledAt || now();
    item.updatedAt = now();
    item.cancelTaskId = task.id;
    cancelled.push(item.id);
  }
  return cancelled;
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
      if (item && !workItemMatchesTask(item, task) && item.status !== 'responded' && item.status !== 'cancelled') {
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
  const cancelledWorkItems = [];
  for (const [agentId, proc] of agentProcesses.entries()) {
    const agent = findAgent(agentId);
    if (!agent) continue;
    const cancelledForAgent = cancelWorkItemsForScope(scope, agentId);
    cancelledWorkItems.push(...cancelledForAgent);

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
    } else if (removedMessages > 0 || cancelledForAgent.length) {
      clearAgentBusyDeliveryTimer(proc);
      if (!restartMessages.length && !activeMetas.length) setAgentStatus(agent, 'idle', 'agent_stop_scope_pruned');
    }
  }
  return {
    stoppedAgents: normalizeIds(stoppedAgents),
    cancelledWorkItems: normalizeIds(cancelledWorkItems),
  };
}

function stopAgentProcessesForTask(task) {
  const stoppedAgents = [];
  const cancelledWorkItems = [];
  for (const [agentId, proc] of agentProcesses.entries()) {
    const agent = findAgent(agentId);
    if (!agent) continue;
    const activeTask = processHasActiveTaskWork(proc, task);
    const restartActiveMessages = activeTask ? activeDeliveryMessagesOutsideTask(proc, task) : [];
    const cancelledForAgent = cancelWorkItemsForTask(task, agentId);
    cancelledWorkItems.push(...cancelledForAgent);

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
    } else if (removedMessages > 0 || cancelledForAgent.length) {
      clearAgentBusyDeliveryTimer(proc);
      if (!restartMessages.length && !activeTurnMetas(proc).length) setAgentStatus(agent, 'idle', 'agent_stop_task_pruned');
    }
  }
  return {
    stoppedAgents: normalizeIds(stoppedAgents),
    cancelledWorkItems: normalizeIds(cancelledWorkItems),
  };
}

function steerAgentProcessesForTaskStop(task, actorId = 'hum_local', replyId = null) {
  const steeredAgents = [];
  const cancelledWorkItems = [];
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
    cancelledWorkItems.push(...taskWorkIds);

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
    cancelledWorkItems: normalizeIds(cancelledWorkItems),
  };
}

function stopRunsForScope(scope = null) {
  const stoppedRuns = [];
  for (const [runId, child] of runningProcesses.entries()) {
    const run = findRun(runId);
    if (!run || (scope && !runMatchesScope(run, scope))) continue;
    run.cancelRequested = true;
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
    run.cancelRequested = true;
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
  return startAgentProcess(agent, 'channel', 'chan_all', []);
}

async function warmAgentFromControl(agent, { spaceType = 'channel', spaceId = 'chan_all' } = {}) {
  const runtime = getAgentRuntime(agent);
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
    && item.status !== 'cancelled'
    && item.spaceType === spaceType
    && item.spaceId === spaceId
    && String(item.parentMessageId || '') === String(expectedParentId || '')
  ));
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

function createWorkItemForDelivery(agent, message, { spaceType, spaceId, parentMessageId = null } = {}) {
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
    taskId: inferTaskIdForDelivery(message, parentMessageId),
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
    if (item.status === 'cancelled') continue;
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
    return item?.respondedAt || item?.status === 'responded' || item?.status === 'cancelled' || Number(item?.sendCount || 0) > 0;
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
    if (!item || item.status === 'responded' || item.status === 'cancelled') continue;
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

async function deliverMessageToAgent(agent, spaceType, spaceId, message, options = {}) {
  const parentMessageId = options.parentMessageId || message.parentMessageId || (shouldStartThreadForAgentDelivery(message) ? message.id : null);
  const workItem = createWorkItemForDelivery(agent, message, { spaceType, spaceId, parentMessageId });
  const runtimeOverride = getAgentRuntime(agent) === 'codex'
    ? codexRuntimeOverrideForDelivery(message, workItem)
    : null;
  const routedMessage = {
    ...message,
    target: workItem.target,
    workItemId: workItem.id,
    taskId: message.taskId || workItem.taskId || null,
  };
  const contextPack = buildAgentContextPack({
    state,
    agentId: agent.id,
    spaceType,
    spaceId,
    currentMessage: routedMessage,
    parentMessageId,
    workItem,
    peerMemorySearch: options.peerMemorySearch || null,
    toolBaseUrl: `http://${HOST}:${PORT}`,
  });
  const deliveryMessage = {
    ...routedMessage,
    spaceType,
    spaceId,
    agentRelayDepth: Number(message.agentRelayDepth || 0),
    contextPack,
    ...(runtimeOverride ? { runtimeOverride } : {}),
    ...(parentMessageId ? { parentMessageId } : {}),
  };
  if (runtimeOverride) {
    addSystemEvent('agent_fast_chat_runtime', `${agent.name} using low-latency chat runtime.`, {
      agentId: agent.id,
      messageId: message.id,
      parentMessageId,
      workItemId: workItem.id,
      model: runtimeOverride.model || null,
      reasoningEffort: runtimeOverride.reasoningEffort,
      reason: runtimeOverride.reason,
    });
  }
  // Check if agent has a running process
  const proc = agentProcesses.get(agent.id);

  if (proc && getAgentRuntime(agent) === 'codex') {
    const codexProcessAliveOrBooting = !proc.child || !proc.child.killed;
    if (codexProcessAliveOrBooting && (proc.status === 'running' || proc.status === 'starting')) {
      queueCodexBusyDelivery(agent, proc, deliveryMessage);
      await persistState();
      broadcastState();
      return;
    }
    if (proc.child && !proc.child.killed && proc.status === 'idle' && proc.threadId) {
      applyAgentProcessDeliveryScope(proc, spaceType, spaceId, parentMessageId);
      if (await sendCodexAppServerMessages(agent, proc, [deliveryMessage], { mode: 'turn' })) {
        await persistState();
        broadcastState();
        return;
      }
    }
  } else if (proc && (proc.status === 'running' || proc.status === 'starting')) {
    // Non-Codex runtimes still queue until their one-shot process exits.
    proc.inbox.push(deliveryMessage);
    if (!proc.parentMessageId && parentMessageId) proc.parentMessageId = parentMessageId;
    addSystemEvent('message_queued', `Message queued for busy agent ${agent.name}`, { agentId: agent.id, messageId: message.id, parentMessageId });
    await persistState();
    broadcastState();
    return;
  }

  // Start the agent process with this message
  await startAgentProcess(agent, spaceType, spaceId, deliveryMessage);
}

function createTaskFromMessage(message, title, options = {}) {
  if (message.taskId) {
    const existing = findTask(message.taskId);
    if (existing) return existing;
  }
  const assigneeIds = normalizeIds(options.assigneeIds?.length ? options.assigneeIds : (message.mentionedAgentIds || []));
  const createdBy = String(options.createdBy || message.authorId || 'hum_local');

  const task = {
    id: makeId('task'),
    number: nextTaskNumber(message.spaceType, message.spaceId),
    title: String(title || message.body || 'Untitled task').trim().slice(0, 180),
    body: String(options.body ?? message.body ?? '').trim(),
    status: String(options.status || 'todo'),
    spaceType: message.spaceType,
    spaceId: message.spaceId,
    messageId: message.id,
    threadMessageId: message.id,
    sourceMessageId: options.sourceMessageId ? String(options.sourceMessageId) : message.id,
    sourceReplyId: options.sourceReplyId ? String(options.sourceReplyId) : null,
    assigneeId: assigneeIds[0] || null,
    assigneeIds,
    claimedBy: null,
    claimedAt: null,
    reviewRequestedAt: null,
    completedAt: null,
    endIntentAt: null,
    runIds: [],
    attachmentIds: Array.isArray(message.attachmentIds) ? message.attachmentIds : [],
    localReferences: Array.isArray(options.localReferences) ? options.localReferences : (Array.isArray(message.localReferences) ? message.localReferences : []),
    createdBy,
    createdAt: now(),
    updatedAt: now(),
    history: [],
  };
  addTaskHistory(task, 'created', `Task ${taskLabel(task)} created from message.`);
  state.tasks.unshift(task);
  message.taskId = task.id;
  addTaskTimelineMessage(task, `📋 1 new task created: ${taskLabel(task)} ${task.title}`, 'task_created');
  addCollabEvent('task_created', `Task created: ${task.title}`, { taskId: task.id, messageId: message.id, number: task.number });
  return task;
}

function createTaskMessage({ title, body = '', spaceType, spaceId, authorType = 'human', authorId = 'hum_local', assigneeIds = [], attachmentIds = [], sourceMessageId = null, sourceReplyId = null, status = 'todo' }) {
  const taskTitle = String(title || '').trim().slice(0, 180);
  if (!taskTitle) throw httpError(400, 'Task title is required.');
  const message = normalizeConversationRecord({
    id: makeId('msg'),
    spaceType,
    spaceId,
    authorType,
    authorId,
    body: taskTitle,
    attachmentIds: normalizeIds(attachmentIds),
    mentionedAgentIds: normalizeIds(assigneeIds),
    mentionedHumanIds: [],
    readBy: authorType === 'human' ? ['hum_local'] : [],
    replyCount: 0,
    savedBy: [],
    createdAt: now(),
    updatedAt: now(),
  });
  state.messages.push(message);
  const task = createTaskFromMessage(message, taskTitle, {
    body,
    status,
    assigneeIds,
    sourceMessageId: sourceMessageId || message.id,
    sourceReplyId,
    createdBy: authorId,
    localReferences: extractLocalReferences(body || taskTitle),
  });
  message.taskId = task.id;
  return { message, task };
}

function claimTask(task, actorId, options = {}) {
  if (!task) throw httpError(404, 'Task not found.');
  if (taskIsClosed(task)) throw httpError(409, 'Closed task cannot be claimed.');
  const claimant = String(actorId || 'agt_codex');
  if (task.claimedBy && task.claimedBy !== claimant && !options.force) {
    throw httpError(409, `Task is already claimed by ${task.claimedBy}.`);
  }
  if (task.claimedBy === claimant && task.status === 'in_progress') {
    return task;
  }
  task.claimedBy = claimant;
  task.assigneeId = claimant;
  task.assigneeIds = normalizeIds([...(task.assigneeIds || []), claimant]);
  task.claimedAt = task.claimedAt || now();
  task.status = 'in_progress';
  task.updatedAt = now();
  addTaskHistory(task, 'claimed', `Claimed by ${displayActor(claimant)}.`, claimant);
  const thread = ensureTaskThread(task);
  addSystemReply(thread.id, `Task claimed by ${displayActor(claimant)}.`);
  addTaskTimelineMessage(task, `📌 ${displayActor(claimant)} claimed ${taskLabel(task)}`, 'task_claimed');
  addCollabEvent('task_claimed', `Task claimed: ${task.title}`, { taskId: task.id, actorId: claimant, number: task.number });
  const claimantAgent = findAgent(claimant);
  if (claimantAgent) scheduleAgentMemoryWriteback(claimantAgent, 'task_claimed', { task });
  return task;
}

function findTaskForAgentTool(body, space = null) {
  const taskId = String(body.taskId || body.task_id || '').trim();
  if (taskId) {
    const exact = findTask(taskId) || state.tasks.find((task) => task.id.startsWith(taskId));
    if (exact) return exact;
    throw httpError(404, `Task not found: ${taskId}`);
  }
  const taskNumber = body.taskNumber ?? body.task_number ?? body.number;
  if (taskNumber !== undefined && taskNumber !== null && taskNumber !== '') {
    const scoped = space || resolveConversationSpace(body);
    const task = state.tasks.find((item) => (
      item.spaceType === scoped.spaceType
      && item.spaceId === scoped.spaceId
      && Number(item.number) === Number(taskNumber)
    ));
    if (task) return task;
    throw httpError(404, `Task not found: #${taskNumber}`);
  }
  const messageId = String(body.messageId || body.message_id || '').trim();
  if (messageId) {
    const message = findMessage(messageId) || state.messages.find((item) => item.id.startsWith(messageId));
    const task = findTaskForThreadMessage(message);
    if (task) return task;
    throw httpError(404, `Task not found for message: ${messageId}`);
  }
  throw httpError(400, 'taskId, taskNumber, or messageId is required.');
}

function updateTaskForAgent(task, agent, nextStatus, options = {}) {
  const status = String(nextStatus || '').trim();
  if (!['todo', 'in_progress', 'in_review', 'done'].includes(status)) {
    throw httpError(400, 'Unsupported task status.');
  }
  if (task.claimedBy && task.claimedBy !== agent.id && !options.force) {
    throw httpError(409, `Task is already claimed by ${task.claimedBy}.`);
  }
  if (!task.claimedBy && !options.force) {
    throw httpError(409, 'Task must be claimed before agent status updates.');
  }
  if (!task.claimedBy) {
    task.claimedBy = agent.id;
    task.claimedAt = now();
    task.assigneeId = agent.id;
    task.assigneeIds = normalizeIds([...(task.assigneeIds || []), agent.id]);
  }
  const previousStatus = task.status;
  task.status = status;
  task.updatedAt = now();
  if (status === 'in_progress') {
    task.reviewRequestedAt = null;
    task.completedAt = null;
    addTaskHistory(task, 'agent_in_progress', 'Agent moved task to In Progress.', agent.id);
    addSystemReply(ensureTaskThread(task).id, `${agent.name} moved this task to In Progress.`);
    addTaskTimelineMessage(task, `📌 ${displayActor(agent.id)} moved ${taskLabel(task)} to In Progress`, 'task_claimed');
  } else if (status === 'in_review') {
    task.reviewRequestedAt = task.reviewRequestedAt || now();
    task.completedAt = null;
    addTaskHistory(task, 'agent_review_requested', 'Agent requested review.', agent.id);
    addSystemReply(ensureTaskThread(task).id, `${agent.name} requested review.`);
    addTaskTimelineMessage(task, `👀 ${displayActor(agent.id)} moved ${taskLabel(task)} to In Review`, 'task_review');
    scheduleAgentMemoryWriteback(agent, 'task_in_review', { task });
  } else if (status === 'done') {
    task.completedAt = task.completedAt || now();
    addTaskHistory(task, 'agent_done', 'Agent marked task done.', agent.id);
    addSystemReply(ensureTaskThread(task).id, `${agent.name} marked this task done.`);
    addTaskTimelineMessage(task, `✅ ${displayActor(agent.id)} moved ${taskLabel(task)} to Done`, 'task_done');
    scheduleAgentMemoryWriteback(agent, 'task_done', { task });
  } else if (status === 'todo') {
    task.reviewRequestedAt = null;
    task.completedAt = null;
    addTaskHistory(task, 'agent_todo', 'Agent moved task back to Todo.', agent.id);
    addSystemReply(ensureTaskThread(task).id, `${agent.name} moved this task back to Todo.`);
  }
  addCollabEvent('agent_task_updated', `${agent.name} moved ${taskLabel(task)} from ${previousStatus || 'unknown'} to ${status}`, {
    agentId: agent.id,
    taskId: task.id,
    previousStatus,
    status,
  });
  return task;
}

  return {
    getAgentRuntime,
    createAgentStandingPrompt,
    createAgentTurnPrompt,
    startAgentProcess,
    startClaudeAgent,
    startCodexAgent,
    sendCodexAppServerRequest,
    sendCodexAppServerNotification,
    triggerCodexStreamRetryFallback,
    handleCodexThreadReady,
    startCodexAppServerTurn,
    sendCodexAppServerMessages,
    clearAgentBusyDeliveryTimer,
    queueCodexBusyDelivery,
    scheduleCodexBusyDelivery,
    flushCodexPendingDeliveries,
    handleCodexTurnCompleted,
    handleCodexAppServerLine,
    fallbackToCodexExec,
    startCodexAgentLegacy,
    restartAgentWithQueuedMessages,
    partitionMessagesByScope,
    partitionMessagesByTask,
    cancelWorkItemsForScope,
    cancelWorkItemsForTask,
    activeTurnMetas,
    activeDeliveryMessagesOutsideTask,
    uniqueDeliveryMessages,
    processHasOnlyScopedActiveWork,
    processHasActiveTaskWork,
    stopAgentProcessForScope,
    stopAgentProcessForTask,
    stopAgentProcesses,
    stopAgentProcessesForTask,
    steerAgentProcessesForTaskStop,
    stopRunsForScope,
    stopRunsForTask,
    waitForAgentProcessExit,
    stopAgentProcessForControl,
    resetAgentRuntimeSession,
    resetAgentWorkspaceFiles,
    startAgentFromControl,
    warmAgentFromControl,
    restartAgentFromControl,
    agentAlreadyRoutedForSource,
    relayAgentMentions,
    inferTaskIdForDelivery,
    createWorkItemForDelivery,
    markWorkItemsDelivered,
    turnMetaHasExplicitSend,
    workItemTargetMatches,
    markWorkItemResponded,
    markFallbackResponseWorkItem,
    markFallbackResponseWorkItems,
    postAgentResponse,
    deliverMessageToAgent,
    createTaskFromMessage,
    createTaskMessage,
    claimTask,
    findTaskForAgentTool,
    updateTaskForAgent,
  };
}
