#!/usr/bin/env node
// Minimal MCP stdio bridge for MagClaw chat agents.
// It exposes MagClaw's controlled local HTTP agent-tool API as native Codex
// tool calls, so agents can use server capabilities without shelling out to curl.

const DEFAULT_BASE_URL = 'http://127.0.0.1:6543';

function parseArgs(argv) {
  const options = {
    agentId: '',
    baseUrl: process.env.MAGCLAW_SERVER_URL || DEFAULT_BASE_URL,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === '--agent-id') {
      options.agentId = argv[index + 1] || '';
      index += 1;
    } else if (item === '--base-url') {
      options.baseUrl = argv[index + 1] || options.baseUrl;
      index += 1;
    }
  }
  options.baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  return options;
}

const options = parseArgs(process.argv);

function schema(properties, required = []) {
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

const tools = [
  {
    name: 'send_message',
    description: 'Send a routed MagClaw reply tied to the current work item. Use the exact target/workItemId from the prompt header.',
    inputSchema: schema({
      workItemId: { type: 'string', description: 'The work item id from the delivered message header.' },
      target: { type: 'string', description: 'Conversation target such as #all, @Agent, or #channel:msg_id.' },
      content: { type: 'string', description: 'Message body to post.' },
    }, ['workItemId', 'target', 'content']),
  },
  {
    name: 'read_history',
    description: 'Read bounded MagClaw conversation history for a channel, DM, or thread target.',
    inputSchema: schema({
      target: { type: 'string', description: 'Conversation target, default #all.' },
      limit: { type: 'number', description: 'Maximum records to return.' },
      around: { type: 'string', description: 'Optional message id to read around.' },
      before: { type: 'string', description: 'Optional ISO timestamp/message cursor.' },
      after: { type: 'string', description: 'Optional ISO timestamp/message cursor.' },
    }),
  },
  {
    name: 'search_messages',
    description: 'Search MagClaw message history by text.',
    inputSchema: schema({
      query: { type: 'string', description: 'Text to search for.' },
      target: { type: 'string', description: 'Conversation target, default #all.' },
      limit: { type: 'number', description: 'Maximum results to return.' },
    }, ['query']),
  },
  {
    name: 'search_agent_memory',
    description: 'Search MagClaw agent MEMORY.md and notes files for specialties, experience, handoff cues, and durable context.',
    inputSchema: schema({
      query: { type: 'string', description: 'Search text.' },
      targetAgentId: { type: 'string', description: 'Optional target agent id or name.' },
      limit: { type: 'number', description: 'Maximum results to return.' },
    }, ['query']),
  },
  {
    name: 'read_agent_memory',
    description: 'Read a permitted MagClaw memory file for an agent, such as MEMORY.md or notes/profile.md.',
    inputSchema: schema({
      targetAgentId: { type: 'string', description: 'Target agent id or name.' },
      path: { type: 'string', description: 'Memory path, default MEMORY.md.' },
    }, ['targetAgentId']),
  },
  {
    name: 'write_memory',
    description: 'Record a concise durable memory for yourself. Use for explicit remember/learn requests or proven specialties/preferences.',
    inputSchema: schema({
      kind: {
        type: 'string',
        enum: ['capability', 'communication_style', 'preference', 'memory'],
        description: 'Memory type.',
      },
      summary: { type: 'string', description: 'Short durable fact to record.' },
      sourceText: { type: 'string', description: 'Optional source text.' },
      messageId: { type: 'string', description: 'Optional source message id.' },
    }, ['summary']),
  },
  {
    name: 'list_tasks',
    description: 'List visible MagClaw tasks, optionally filtered by channel, status, or assignee.',
    inputSchema: schema({
      channel: { type: 'string', description: 'Optional channel name or id.' },
      target: { type: 'string', description: 'Optional target label such as #all.' },
      status: { type: 'string', description: 'Optional task status.' },
      assigneeId: { type: 'string', description: 'Optional assignee id. Use "me" for this agent.' },
      limit: { type: 'number', description: 'Maximum tasks to return.' },
    }),
  },
  {
    name: 'create_tasks',
    description: 'Create one or more MagClaw tasks in a channel/DM and optionally claim them.',
    inputSchema: schema({
      channel: { type: 'string', description: 'Channel label/name/id, such as #all.' },
      target: { type: 'string', description: 'Conversation target alternative to channel.' },
      title: { type: 'string', description: 'Single task title.' },
      body: { type: 'string', description: 'Task body.' },
      tasks: {
        type: 'array',
        items: schema({
          title: { type: 'string' },
          body: { type: 'string' },
          assigneeId: { type: 'string' },
          assigneeIds: { type: 'array', items: { type: 'string' } },
          sourceMessageId: { type: 'string' },
          sourceReplyId: { type: 'string' },
        }, ['title']),
      },
      claim: { type: 'boolean', description: 'Whether this agent should claim the created tasks.' },
      assigneeId: { type: 'string', description: 'Optional assignee id.' },
      assigneeIds: { type: 'array', items: { type: 'string' } },
      sourceMessageId: { type: 'string' },
      sourceReplyId: { type: 'string' },
    }),
  },
  {
    name: 'claim_tasks',
    description: 'Claim existing MagClaw tasks by channel task number, or promote messages into claimed tasks.',
    inputSchema: schema({
      channel: { type: 'string', description: 'Channel label/name/id, such as #all.' },
      target: { type: 'string', description: 'Conversation target alternative to channel.' },
      taskNumbers: { type: 'array', items: { type: 'number' } },
      messageIds: { type: 'array', items: { type: 'string' } },
      title: { type: 'string', description: 'Optional title when promoting a message.' },
      force: { type: 'boolean' },
    }),
  },
  {
    name: 'update_task_status',
    description: 'Update a claimed MagClaw task status.',
    inputSchema: schema({
      taskId: { type: 'string', description: 'Task id.' },
      taskNumber: { type: 'number', description: 'Task number in channel.' },
      channel: { type: 'string', description: 'Channel label/name/id for taskNumber lookup.' },
      status: { type: 'string', description: 'Next status, e.g. in_progress, in_review, done.' },
      force: { type: 'boolean', description: 'Allow updating unclaimed task when appropriate.' },
    }, ['status']),
  },
];

function sendMessage(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function sendError(id, code, message, data = null) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, data } })}\n`);
}

function textResult(text) {
  return {
    content: [{ type: 'text', text: String(text || '') }],
  };
}

function jsonText(value) {
  if (typeof value?.text === 'string' && value.text.trim()) return value.text;
  return JSON.stringify(value, null, 2);
}

function withAgentId(args = {}) {
  return {
    ...args,
    agentId: args.agentId || options.agentId,
  };
}

function queryString(params = {}) {
  const search = new URLSearchParams();
  for (const [key, raw] of Object.entries(params)) {
    if (raw === undefined || raw === null || raw === '') continue;
    search.set(key, String(raw));
  }
  const value = search.toString();
  return value ? `?${value}` : '';
}

async function request(pathname, { method = 'GET', query = {}, body = null } = {}) {
  const url = `${options.baseUrl}${pathname}${queryString(query)}`;
  const response = await fetch(url, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
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
}

async function callTool(name, args = {}) {
  if (!options.agentId) throw new Error('MagClaw MCP bridge was started without --agent-id.');
  if (name === 'send_message') {
    return request('/api/agent-tools/messages/send', {
      method: 'POST',
      body: withAgentId({
        workItemId: args.workItemId || args.work_item_id,
        target: args.target,
        content: args.content,
      }),
    });
  }
  if (name === 'read_history') {
    return request('/api/agent-tools/history', {
      query: withAgentId({
        target: args.target || args.channel,
        limit: args.limit,
        around: args.around,
        before: args.before,
        after: args.after,
      }),
    });
  }
  if (name === 'search_messages') {
    return request('/api/agent-tools/search', {
      query: withAgentId({
        query: args.query || args.q,
        target: args.target || args.channel,
        limit: args.limit,
      }),
    });
  }
  if (name === 'search_agent_memory') {
    return request('/api/agent-tools/memory/search', {
      query: withAgentId({
        query: args.query || args.q,
        targetAgentId: args.targetAgentId || args.targetAgent,
        limit: args.limit,
      }),
    });
  }
  if (name === 'read_agent_memory') {
    return request('/api/agent-tools/memory/read', {
      query: withAgentId({
        targetAgentId: args.targetAgentId || args.targetAgent,
        path: args.path,
      }),
    });
  }
  if (name === 'write_memory') {
    return request('/api/agent-tools/memory', {
      method: 'POST',
      body: withAgentId({
        kind: args.kind,
        summary: args.summary || args.content,
        sourceText: args.sourceText || args.source,
        messageId: args.messageId,
      }),
    });
  }
  if (name === 'list_tasks') {
    return request('/api/agent-tools/tasks', {
      query: withAgentId({
        channel: args.channel,
        target: args.target,
        status: args.status,
        assigneeId: args.assigneeId === 'me' ? options.agentId : args.assigneeId,
        limit: args.limit,
      }),
    });
  }
  if (name === 'create_tasks') {
    return request('/api/agent-tools/tasks', {
      method: 'POST',
      body: withAgentId(args),
    });
  }
  if (name === 'claim_tasks') {
    return request('/api/agent-tools/tasks/claim', {
      method: 'POST',
      body: withAgentId(args),
    });
  }
  if (name === 'update_task_status') {
    return request('/api/agent-tools/tasks/update', {
      method: 'POST',
      body: withAgentId({
        taskId: args.taskId,
        taskNumber: args.taskNumber,
        channel: args.channel,
        status: args.status || args.nextStatus,
        force: args.force,
      }),
    });
  }
  throw new Error(`Unknown MagClaw tool: ${name}`);
}

async function handle(message) {
  if (!message || typeof message !== 'object') return;
  const { id, method, params } = message;
  try {
    if (method === 'initialize') {
      sendMessage(id, {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'magclaw', version: '0.1.0' },
      });
      return;
    }
    if (method === 'notifications/initialized' || method === 'initialized') return;
    if (method === 'tools/list') {
      sendMessage(id, { tools });
      return;
    }
    if (method === 'tools/call') {
      const data = await callTool(params?.name || '', params?.arguments || {});
      sendMessage(id, textResult(jsonText(data)));
      return;
    }
    if (id !== undefined && id !== null) sendError(id, -32601, `Method not found: ${method}`);
  } catch (error) {
    if (id !== undefined && id !== null) {
      sendMessage(id, {
        content: [{ type: 'text', text: error.message || String(error) }],
        isError: true,
      });
    }
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line)).catch((error) => {
        process.stderr.write(`MagClaw MCP error: ${error.message}\n`);
      });
    } catch (error) {
      process.stderr.write(`MagClaw MCP parse error: ${error.message}\n`);
    }
  }
});
