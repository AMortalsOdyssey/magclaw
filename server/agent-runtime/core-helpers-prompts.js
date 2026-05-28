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

function canonicalAgentResponseText(value) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

const agentSessionQueues = new Map();

function runtimeSessionLimit(name, fallback) {
  const value = typeof name === 'string' && name === 'agent'
    ? (typeof AGENT_MAX_ACTIVE_SESSIONS !== 'undefined' ? AGENT_MAX_ACTIVE_SESSIONS : fallback)
    : (typeof COMPUTER_MAX_ACTIVE_SESSIONS !== 'undefined' ? COMPUTER_MAX_ACTIVE_SESSIONS : fallback);
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function processIsActiveRuntimeSession(proc) {
  if (!proc || proc.stopRequested || proc.child?.killed) return false;
  if (proc.status === 'starting' || proc.status === 'running') return true;
  if (proc.activeTurnId || proc.activeTurnIds?.size || proc.pendingTurnRequests?.size) return true;
  if (proc.pendingInitialPrompt || proc.pendingInitialMessages?.length || proc.pendingDeliveryMessages?.length) return true;
  return Boolean(proc.warmupActive);
}

function activeRuntimeSessionCountForAgent(agentId) {
  return [...agentProcesses.values()].filter((proc) => (
    proc?.agentId === agentId && processIsActiveRuntimeSession(proc)
  )).length;
}

function activeRuntimeSessionCountForComputer(computerId) {
  if (!computerId) return 0;
  return [...agentProcesses.values()].filter((proc) => {
    if (!processIsActiveRuntimeSession(proc)) return false;
    const procAgent = findAgent(proc.agentId);
    return procAgent?.computerId === computerId;
  }).length;
}

function canStartRuntimeSession(agent) {
  const agentLimit = runtimeSessionLimit('agent', 2);
  const computerLimit = runtimeSessionLimit('computer', 8);
  return activeRuntimeSessionCountForAgent(agent.id) < agentLimit
    && activeRuntimeSessionCountForComputer(agent.computerId) < computerLimit;
}

function queuedSessionKey(agent, processKey) {
  return `${agent.id}:${processKey}`;
}

function enqueueRuntimeSessionDelivery(agent, {
  processKey,
  sessionKey,
  spaceType,
  spaceId,
  parentMessageId = null,
  deliveryMessage,
}) {
  const key = queuedSessionKey(agent, processKey);
  const existing = agentSessionQueues.get(key) || {
    agentId: agent.id,
    processKey,
    sessionKey,
    spaceType,
    spaceId,
    parentMessageId,
    messages: [],
    createdAt: now(),
  };
  existing.messages.push(deliveryMessage);
  existing.updatedAt = now();
  agentSessionQueues.set(key, existing);
  const procLike = {
    agentId: agent.id,
    computerId: agent.computerId || null,
    workspaceId: workspaceIdForConversation(state, {
      spaceType,
      spaceId,
      fallbackRecord: deliveryMessage,
      agent,
    }),
    sessionKey,
    spaceType,
    spaceId,
    parentMessageId,
    target: targetForConversation(spaceType, spaceId, parentMessageId),
    status: 'queued',
    lastSourceMessage: deliveryMessage,
  };
  updateRuntimeSession(agent, procLike, {
    status: 'queued',
    lastTurnAt: null,
    activeTurnIds: [],
    activeTargetKeys: [],
  });
  addSystemEvent('agent_runtime_session_queued', `${agent.name} queued a conversation lane until runtime capacity is available.`, {
    agentId: agent.id,
    processKey,
    sessionKey,
    messageId: deliveryMessage?.id || null,
    workItemId: deliveryMessage?.workItemId || null,
  });
}

async function drainRuntimeSessionQueues(agent = null) {
  const candidates = [...agentSessionQueues.entries()]
    .filter(([, item]) => !agent || item.agentId === agent.id)
    .sort((a, b) => String(a[1].createdAt || '').localeCompare(String(b[1].createdAt || '')));
  for (const [key, item] of candidates) {
    const targetAgent = findAgent(item.agentId);
    if (!targetAgent || !canStartRuntimeSession(targetAgent)) continue;
    agentSessionQueues.delete(key);
    await startAgentProcess(targetAgent, item.spaceType, item.spaceId, item.messages);
  }
}

function agentRuntimeSessionKey(agent, spaceType, spaceId, message = null, parentMessageId = null) {
  return conversationLaneKeyForMessage(state, {
    agent,
    spaceType,
    spaceId,
    message,
    parentMessageId,
  });
}

function agentRuntimeProcessKeyFor(agent, sessionKey) {
  return agentRuntimeProcessKey(agent?.id || agent, sessionKey);
}

function agentProcessKeyForDelivery(agent, spaceType, spaceId, message = null, parentMessageId = null) {
  return agentRuntimeProcessKeyFor(agent, agentRuntimeSessionKey(agent, spaceType, spaceId, message, parentMessageId));
}

function agentProcessEntries(agentId) {
  return [...agentProcesses.entries()].filter(([, proc]) => proc?.agentId === agentId);
}

function firstAgentProcess(agentId) {
  return agentProcessEntries(agentId)[0]?.[1] || null;
}

function deleteAgentProcess(procOrAgent, fallbackAgentId = '') {
  const proc = procOrAgent?.sessionId ? procOrAgent : null;
  if (proc?.processKey) {
    agentProcesses.delete(proc.processKey);
    return;
  }
  const agentId = proc?.agentId || procOrAgent?.id || fallbackAgentId || procOrAgent;
  if (!agentId) return;
  for (const [key, item] of agentProcesses.entries()) {
    if (item?.agentId === agentId) agentProcesses.delete(key);
  }
}

function normalizeRuntimeSessions() {
  state.agentRuntimeSessions = Array.isArray(state.agentRuntimeSessions) ? state.agentRuntimeSessions : [];
  return state.agentRuntimeSessions;
}

function findRuntimeSession(agent, sessionKey) {
  return normalizeRuntimeSessions().find((session) => (
    session.agentId === agent.id
    && session.sessionKey === sessionKey
  )) || null;
}

function ensureRuntimeSession(agent, proc) {
  const sessions = normalizeRuntimeSessions();
  let session = findRuntimeSession(agent, proc.sessionKey);
  const timestamp = now();
  if (!session) {
    session = {
      id: makeId('ars'),
      workspaceId: proc.workspaceId || workspaceIdForConversation(state, {
        spaceType: proc.spaceType,
        spaceId: proc.spaceId,
        fallbackRecord: proc.lastSourceMessage || proc.pendingInitialMessages?.[0] || null,
        agent,
      }),
      agentId: agent.id,
      computerId: agent.computerId || null,
      sessionKey: proc.sessionKey,
      target: proc.target || targetForConversation(proc.spaceType, proc.spaceId, proc.parentMessageId || null),
      spaceType: proc.spaceType,
      spaceId: proc.spaceId,
      parentMessageId: proc.parentMessageId || null,
      codexThreadId: null,
      status: proc.status || 'starting',
      activeTurnIds: [],
      activeTargetKeys: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      lastTurnAt: null,
      metadata: {},
    };
    sessions.push(session);
  }
  session.workspaceId = session.workspaceId || proc.workspaceId || 'local';
  session.computerId = agent.computerId || session.computerId || null;
  session.target = proc.target || session.target;
  session.spaceType = proc.spaceType || session.spaceType;
  session.spaceId = proc.spaceId || session.spaceId;
  session.parentMessageId = proc.parentMessageId || null;
  session.status = proc.status || session.status || 'starting';
  session.updatedAt = timestamp;
  proc.runtimeSessionRecordId = session.id;
  return session;
}

function updateRuntimeSession(agent, proc, patch = {}) {
  const session = ensureRuntimeSession(agent, proc);
  Object.assign(session, patch, { updatedAt: now() });
  return session;
}

function summarizeCodexEvent(event) {
  if (!event || typeof event !== 'object') return String(event || '');
  const candidates = [
    event.message,
    event.text,
    event.output,
    event.delta,
    event.type,
    event.msg?.message,
    event.msg?.text,
    event.item?.text,
    event.item?.message,
  ].filter(Boolean);
  if (candidates.length) return String(candidates[0]);
  return JSON.stringify(event).slice(0, 600);
}

function summarizeCodexRequest(method, params = {}) {
  const input = Array.isArray(params.input) ? params.input : [];
  const inputChars = input.reduce((sum, item) => sum + String(item?.text || '').length, 0);
  return {
    method,
    threadId: params.threadId || params.thread?.id || null,
    turnId: params.turnId || null,
    expectedTurnId: params.expectedTurnId || null,
    model: params.model || null,
    effort: params.effort || null,
    cwd: params.cwd || null,
    inputChars,
  };
}

function activeTurnIdList(proc) {
  return proc?.activeTurnIds instanceof Set
    ? [...proc.activeTurnIds]
    : (proc?.activeTurnId ? [proc.activeTurnId] : []);
}

function parseToolArguments(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function codexToolCallId(item) {
  return String(item?.id || item?.callId || item?.call_id || item?.itemId || item?.item_id || '');
}

function codexToolName(item) {
  const tool = item?.tool;
  return String(
    item?.name
    || item?.toolName
    || item?.tool_name
    || (typeof tool === 'string' ? tool : tool?.name)
    || item?.function?.name
    || item?.call?.name
    || ''
  );
}

function codexToolNameMatches(name, expected) {
  const value = String(name || '').trim();
  if (!value || !expected) return false;
  return value === expected
    || value.endsWith(`.${expected}`)
    || value.endsWith(`/${expected}`)
    || value.endsWith(`:${expected}`)
    || value.endsWith(`__${expected}`);
}

function codexToolArguments(item) {
  const candidates = [
    item?.arguments,
    item?.args,
    item?.input,
    item?.params?.arguments,
    item?.params?.input,
    item?.toolInput,
    item?.tool_input,
    item?.function?.arguments,
    item?.call?.arguments,
  ];
  for (const candidate of candidates) {
    const parsed = parseToolArguments(candidate);
    if (Object.keys(parsed).length) return parsed;
  }
  return {};
}

function canonicalMagClawToolName(name) {
  const tools = [
    'send_message',
    'read_history',
    'search_messages',
    'search_agent_memory',
    'read_agent_memory',
    'list_agents',
    'read_agent_profile',
    'read_agent_avatar',
    'list_attachments',
    'read_attachment',
    'write_memory',
    'list_tasks',
    'create_tasks',
    'claim_tasks',
    'update_task_status',
    'propose_channel_members',
    'schedule_reminder',
    'list_reminders',
    'cancel_reminder',
  ];
  return tools.find((tool) => codexToolNameMatches(name, tool)) || '';
}

function summarizeToolArguments(name, args = {}) {
  return {
    workItemId: args.workItemId || args.work_item_id || null,
    target: args.target || args.channel || null,
    contentLength: args.content ? String(args.content).trim().length : 0,
    queryLength: args.query || args.q ? String(args.query || args.q).length : 0,
    taskId: args.taskId || null,
    attachmentId: args.attachmentId || args.attachment_id || args.id || null,
    reminderId: args.reminderId || args.reminder_id || args.id || null,
    taskNumber: args.taskNumber || null,
    status: args.status || args.nextStatus || null,
    memberIds: Array.isArray(args.memberIds) ? args.memberIds : null,
    name: name || null,
  };
}

function isoFromMs(value) {
  const ms = Number(value || 0);
  return ms > 0 ? new Date(ms).toISOString() : null;
}

function updateAgentRuntimeActivity(agent, proc, activity, detail, extra = {}) {
  const timestamp = now();
  const payload = {
    activity,
    detail: detail || '',
    updatedAt: timestamp,
    lastProgressAt: isoFromMs(proc?.lastTurnProgressAt),
    lastProgressReason: proc?.lastTurnProgressReason || null,
    activeTurnIds: activeTurnIdList(proc),
    ...extra,
  };
  if (proc) {
    proc.lastActivity = activity;
    proc.lastActivityDetail = detail || '';
    proc.lastActivityAt = timestamp;
    proc.lastActivityAtMs = Date.now();
  }
  if (agent) {
    agent.runtimeActivity = payload;
    agent.heartbeatAt = timestamp;
  }
  return payload;
}

function addAgentRuntimeActivityEvent(agent, proc, type, activity, detail, extra = {}, options = {}) {
  const payload = updateAgentRuntimeActivity(agent, proc, activity, detail, extra);
  if (options.countAsHeartbeat !== false && proc) proc.lastActivityHeartbeatAt = Date.now();
  addSystemEvent(type, detail || `${agent.name} is ${activity}.`, {
    agentId: agent.id,
    activity,
    detail: detail || '',
    ...extra,
  });
  if (options.broadcast) {
    if (typeof recordRealtimeEvent === 'function' && agent?.id) {
      recordRealtimeEvent('agent_status_changed', {
        agent: {
          id: agent.id,
          status: agent.status || 'offline',
          previousStatus: agent.previousStatus || null,
          statusUpdatedAt: agent.statusUpdatedAt || null,
          heartbeatAt: agent.heartbeatAt || null,
          runtimeActivity: agent.runtimeActivity || null,
          activeWorkItemIds: agent.activeWorkItemIds || [],
        },
      }, { scopeType: 'agent', scopeId: agent.id });
    }
    persistState().then(() => broadcastState({ realtimeOnly: true })).catch(() => {});
  }
  return payload;
}

function noteAgentRuntimeProgress(agent, proc, activity, detail, extra = {}) {
  updateAgentRuntimeActivity(agent, proc, activity, detail, extra);
}

function runtimeErrorActivity(error, context = {}) {
  if (typeof runtimeActivityWithStructuredError === 'function') {
    return runtimeActivityWithStructuredError({
      source: context.source || context.runtime || 'agent-runtime',
      activity: 'error',
      at: now(),
    }, error, context);
  }
  return {
    source: context.source || 'agent-runtime',
    activity: 'error',
    error: error?.message || String(error || 'Runtime error'),
    at: now(),
  };
}

function setAgentRuntimeError(agent, reason, error, context = {}, extra = {}) {
  const runtimeActivity = runtimeErrorActivity(error, context);
  setAgentStatus(agent, 'error', reason, {
    ...extra,
    runtimeActivity,
  });
  return runtimeActivity;
}

const CODEX_WARMUP_PROMPT = [
  'Runtime warmup for MagClaw.',
  'Reply with exactly: ready',
  'Do not call tools, do not inspect files, and do not write memory.',
].join('\n');

function promptAvatarDescription(agent = {}) {
  const avatar = String(agent.avatar || agent.avatarUrl || '').trim();
  if (!avatar) return 'not set';
  if (/^data:/i.test(avatar)) {
    const mime = avatar.match(/^data:([^;,]+)/i)?.[1] || 'data';
    return `${mime} data URL (${avatar.length} chars)`;
  }
  return avatar;
}

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
    `You are ${agent.name}, an AI agent running in MagClaw.`,
    agent.description ? `Your role: ${agent.description}` : '',
    '',
    'Your MagClaw identity:',
    `- Visible name: ${agent.name}`,
    `- Agent id: ${agent.id}`,
    `- Runtime: ${agent.runtime || 'unknown'}${agent.runtimeId ? ` (${agent.runtimeId})` : ''}`,
    agent.model || agent.defaultModel ? `- Model: ${agent.model || agent.defaultModel}` : '',
    agent.reasoningEffort ? `- Reasoning effort: ${agent.reasoningEffort}` : '',
    agent.description ? `- Description: ${agent.description}` : '',
    `- Avatar: ${promptAvatarDescription(agent)}`,
    '- If the user asks your name or who you are, answer from this identity using your visible name. Do not answer with only an @mention token.',
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
    '- Your reply body is shown directly to the user. Do not add out-of-band status narration such as "已处理", "已回复原 DM 线程", "已处理并已回复原 DM 线程", "I replied", or similar wrapper text unless the user explicitly asks for a status note.',
    '- For any non-trivial answer, use readable Markdown structure: short headings, bullets or numbered lists, code fences, inline code, or tables when they make the answer easier to scan. Do not return one dense paragraph for multi-step work.',
    '- In a channel, MagClaw may deliver the same open human message to every member agent, similar to a team chat. If the message is not directed at one specific agent and you have useful context, answer briefly from your role.',
    '- If the user names or @mentions another agent, respect that routing and avoid taking over unless you were also named or can add a small coordination note.',
    '- For ordinary chat or coordination, just answer in natural language. Do not run shell commands.',
    '- Do not run Codex native memory-writing, memory consolidation, or profile-update workflows inside MagClaw chat turns; use MagClaw memory writeback instead.',
    '- For simple Q&A, greetings, role questions, one-off lookups, weather/forecast requests, or lightweight coordination, answer in the current thread and do not create a task.',
    '- For simple lookup/weather requests, use at most one or two authoritative lookups, then reply with a compact answer. Do not inspect local files or run project/memory workflows unless the user explicitly asks.',
    '- Each delivered message includes a bracket header such as `[target=#all:msg_xxx workItem=wi_xxx msg=msg_xxx task=task_xxx ...]`. Treat target and workItem as routing authority.',
    '- For multi-channel, multi-task, or thread/task work, reply with the controlled send_message API using the exact target and workItemId from the current header.',
    '- You may call send_message without a workItemId only for proactive messages to visible targets such as dm:@Agent, dm:@Human, #channel, or #channel:thread.',
    '- If you call send_message, MagClaw will not duplicate your final stdout for that same turn. If you do not call send_message, MagClaw will post your final stdout back to the source thread as a compatibility fallback.',
    '- Never guess a channel or thread target. Use the exact target from the header or read/search history first.',
    '- Task statuses are exactly: todo, in_progress, in_review, done, closed. Do not use completed, complete, finished, resolved, canceled, or other synonyms as status values.',
    '- Use done only when the requested work is completed and ready/accepted. Use closed when the user asks to close/stop/cancel/terminate a task or says the work is no longer needed.',
    '- If a user asks you to bring a workspace member into a channel and that member is not currently in the channel, do not say you have no permission and do not add them directly. Create a channel member proposal for human review.',
    '- Prefer the native MagClaw MCP tools when they are available: send_message, list_agents, read_agent_profile, read_agent_avatar, read_history, search_messages, list_attachments, read_attachment, search_agent_memory, read_agent_memory, write_memory, list_tasks, create_tasks, claim_tasks, update_task_status, propose_channel_members, schedule_reminder, list_reminders, and cancel_reminder. Their runtime names may be prefixed by the Codex MCP bridge.',
    '- If MCP tools are unavailable, you may call the controlled MagClaw agent tool APIs when needed: GET /api/agent-tools/agents, GET /api/agent-tools/agents/read, GET /api/agent-tools/agents/avatar/read, GET /api/agent-tools/history, GET /api/agent-tools/search, GET /api/agent-tools/attachments, GET /api/agent-tools/attachments/read, GET /api/agent-tools/memory/search, GET /api/agent-tools/memory/read, GET /api/agent-tools/tasks, GET /api/agent-tools/reminders, POST /api/agent-tools/messages/send, POST /api/agent-tools/memory, POST /api/agent-tools/tasks, POST /api/agent-tools/tasks/claim, POST /api/agent-tools/tasks/update, POST /api/agent-tools/channel-member-proposals, POST /api/agent-tools/reminders, and POST /api/agent-tools/reminders/cancel.',
    typeof renderAgentPermissionGuidance === 'function' ? renderAgentPermissionGuidance(agent) : '',
    `- Create a new task with: curl -sS -X POST http://${HOST}:${PORT}/api/agent-tools/tasks -H 'content-type: application/json' -d '{"agentId":"${agent.id}","channel":"${toolTarget}","claim":true,"sourceMessageId":"msg_xxx","tasks":[{"title":"Task title"}]}'. Use the current header msg=... as sourceMessageId so retries reuse the same task.`,
    `- Update a claimed task with: curl -sS -X POST http://${HOST}:${PORT}/api/agent-tools/tasks/update -H 'content-type: application/json' -d '{"agentId":"${agent.id}","taskId":"task_xxx","status":"in_review"}'. Valid statuses are only "todo", "in_progress", "in_review", "done", and "closed"; use "closed" for close/stop/cancel/terminated work. If the user only asks to close an unclaimed task, update it to "closed" with "force": true instead of claiming it first.`,
    `- Suggest adding a channel member with human review: curl -sS -X POST http://${HOST}:${PORT}/api/agent-tools/channel-member-proposals -H 'content-type: application/json' -d '{"agentId":"${agent.id}","channelId":"${spaceId}","memberIds":["hum_xxx"],"reason":"Why this person is needed"}'`,
    `- Record durable memory with: curl -sS -X POST http://${HOST}:${PORT}/api/agent-tools/memory -H 'content-type: application/json' -d '{"agentId":"${agent.id}","kind":"preference","summary":"Short durable fact"}'. Use kind=capability, communication_style, preference, or memory.`,
    `- Search peer memory when name/role is not enough: curl -s "http://${HOST}:${PORT}/api/agent-tools/memory/search?agentId=${agent.id}&q=<query>&limit=10". Read a result with /api/agent-tools/memory/read?agentId=${agent.id}&targetAgentId=agt_xxx&path=notes/profile.md.`,
    `- Read your own profile when identity details matter: curl -s "http://${HOST}:${PORT}/api/agent-tools/agents/read?agentId=${agent.id}&targetAgentId=me".`,
    `- Read another Agent's avatar image when the user compares an uploaded image with an Agent avatar: curl -s "http://${HOST}:${PORT}/api/agent-tools/agents/avatar/read?agentId=${agent.id}&targetAgentId=agt_xxx".`,
    `- Read an uploaded attachment's original file when the user references an attachment or asks about an image/file: curl -s "http://${HOST}:${PORT}/api/agent-tools/attachments/read?agentId=${agent.id}&attachmentId=att_xxx". Image attachments are also supplied to Codex as image input when possible; use read_attachment if the image/file is missing from direct context.`,
    `- For a simple "remind me" request, schedule a reminder instead of creating a task: curl -sS -X POST http://${HOST}:${PORT}/api/agent-tools/reminders -H 'content-type: application/json' -d '{"agentId":"${agent.id}","target":"${toolTarget}","title":"Reminder title","delaySeconds":300}'. Use the exact thread target from the header when the reminder belongs in a thread.`,
    '- Create or claim tasks only for durable work with progress/state: coding changes, debugging, deployment, docs/report deliverables, multi-step research, migrations, reviews, or when the user explicitly says task/as task/创建任务.',
    '- When a user asks for actionable durable work, claim the existing task if MagClaw already created one for you, then continue the work in the task thread.',
    '- Thread replies cannot become tasks directly. If new work emerges in a thread, create a new top-level task-message with sourceMessageId/sourceReplyId instead of claiming the reply.',
    '- If work already exists as a task, claim it instead of creating a duplicate.',
    '- Maintain your own MagClaw workspace memory during important task progress through the controlled memory API: keep MEMORY.md as a short Chinese entrypoint, and put detailed dated notes in notes/.',
    '- MEMORY.md should only contain role, knowledge index, short skills, active context, and brief recent-work titles. Do not turn it into a diary; use notes/work-log.md for task logs and decisions.',
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
