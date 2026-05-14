#!/usr/bin/env node
// MCP stdio bridge used by cloud-connected daemon agents. It forwards MagClaw
// tool calls to the cloud server with the daemon machine token.
import { readFileSync } from 'node:fs';

function parseArgs(argv) {
  const options = {
    agentId: '',
    baseUrl: process.env.MAGCLAW_SERVER_URL || 'http://127.0.0.1:6543',
    token: process.env.MAGCLAW_MACHINE_TOKEN || '',
    tokenFile: '',
  };
  for (let index = 2; index < argv.length; index += 1) {
    const item = argv[index];
    const next = argv[index + 1] || '';
    if (item === '--agent-id') {
      options.agentId = next;
      index += 1;
    } else if (item === '--base-url') {
      options.baseUrl = next || options.baseUrl;
      index += 1;
    } else if (item === '--token') {
      options.token = next || options.token;
      index += 1;
    } else if (item === '--token-file') {
      options.tokenFile = next || '';
      index += 1;
    }
  }
  options.baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
  return options;
}

const options = parseArgs(process.argv);
let buffer = '';
let cachedMachineConfig = null;

function machineConfig() {
  if (cachedMachineConfig) return cachedMachineConfig;
  cachedMachineConfig = {};
  if (!options.tokenFile) return cachedMachineConfig;
  try {
    cachedMachineConfig = JSON.parse(readFileSync(options.tokenFile, 'utf8')) || {};
  } catch {
    cachedMachineConfig = {};
  }
  return cachedMachineConfig;
}

function machineToken() {
  if (options.token) return options.token;
  return String(machineConfig().token || machineConfig().machineToken || '');
}

function workspaceId() {
  const config = machineConfig();
  return String(config.workspaceId || config.workspace || '');
}

function machineHeaders(body) {
  const token = machineToken();
  const workspace = workspaceId();
  return {
    ...(body ? { 'content-type': 'application/json' } : {}),
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(workspace ? { 'x-magclaw-workspace-id': workspace } : {}),
  };
}

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
    description: 'Send a routed MagClaw reply tied to the current work item.',
    inputSchema: schema({
      workItemId: { type: 'string' },
      target: { type: 'string' },
      content: { type: 'string' },
    }, ['workItemId', 'target', 'content']),
  },
  {
    name: 'read_history',
    description: 'Read bounded MagClaw conversation history.',
    inputSchema: schema({
      target: { type: 'string' },
      limit: { type: 'number' },
      around: { type: 'string' },
      before: { type: 'string' },
      after: { type: 'string' },
    }),
  },
  {
    name: 'search_messages',
    description: 'Search MagClaw message history by text.',
    inputSchema: schema({
      query: { type: 'string' },
      target: { type: 'string' },
      limit: { type: 'number' },
    }, ['query']),
  },
  {
    name: 'search_agent_memory',
    description: 'Search MagClaw agent memory files.',
    inputSchema: schema({
      query: { type: 'string' },
      targetAgentId: { type: 'string' },
      limit: { type: 'number' },
    }, ['query']),
  },
  {
    name: 'read_agent_memory',
    description: 'Read a permitted MagClaw memory file for an agent.',
    inputSchema: schema({
      targetAgentId: { type: 'string' },
      path: { type: 'string' },
    }, ['targetAgentId']),
  },
  {
    name: 'list_agents',
    description: 'List compact MagClaw agent profiles visible in the current server or channel.',
    inputSchema: schema({
      query: { type: 'string' },
      target: { type: 'string' },
      channel: { type: 'string' },
      limit: { type: 'number' },
    }),
  },
  {
    name: 'read_agent_profile',
    description: 'Read a concise MagClaw agent profile with runtime, description, channels, and safe public fields.',
    inputSchema: schema({
      targetAgentId: { type: 'string' },
      targetAgent: { type: 'string' },
    }),
  },
  {
    name: 'write_memory',
    description: 'Record a concise durable memory for this agent.',
    inputSchema: schema({
      kind: { type: 'string', enum: ['capability', 'communication_style', 'preference', 'memory'] },
      summary: { type: 'string' },
      sourceText: { type: 'string' },
      messageId: { type: 'string' },
    }, ['summary']),
  },
  {
    name: 'list_tasks',
    description: 'List visible MagClaw tasks.',
    inputSchema: schema({
      channel: { type: 'string' },
      target: { type: 'string' },
      status: { type: 'string' },
      assigneeId: { type: 'string' },
      limit: { type: 'number' },
    }),
  },
  {
    name: 'create_tasks',
    description: 'Create one or more MagClaw tasks.',
    inputSchema: schema({
      channel: { type: 'string' },
      target: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string' },
      tasks: { type: 'array', items: { type: 'object' } },
      claim: { type: 'boolean' },
      assigneeId: { type: 'string' },
      assigneeIds: { type: 'array', items: { type: 'string' } },
      sourceMessageId: { type: 'string' },
      sourceReplyId: { type: 'string' },
    }),
  },
  {
    name: 'claim_tasks',
    description: 'Claim existing tasks or promote messages into claimed tasks.',
    inputSchema: schema({
      channel: { type: 'string' },
      target: { type: 'string' },
      taskNumbers: { type: 'array', items: { type: 'number' } },
      messageIds: { type: 'array', items: { type: 'string' } },
      title: { type: 'string' },
      force: { type: 'boolean' },
    }),
  },
  {
    name: 'update_task_status',
    description: 'Update a claimed MagClaw task status. Use done for ready/accepted work and closed for close, stop, cancel, or terminated work.',
    inputSchema: schema({
      taskId: { type: 'string' },
      taskNumber: { type: 'number' },
      channel: { type: 'string' },
      status: { type: 'string' },
      force: { type: 'boolean' },
    }, ['status']),
  },
  {
    name: 'propose_channel_members',
    description: 'Suggest adding server members to a MagClaw channel for human review.',
    inputSchema: schema({
      channelId: { type: 'string' },
      channel: { type: 'string' },
      memberIds: { type: 'array', items: { type: 'string' } },
      memberId: { type: 'string' },
      reason: { type: 'string' },
    }, ['reason']),
  },
  {
    name: 'schedule_reminder',
    description: 'Schedule a one-time MagClaw reminder.',
    inputSchema: schema({
      target: { type: 'string' },
      channel: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string' },
      delaySeconds: { type: 'number' },
      fireAt: { type: 'string' },
      messageId: { type: 'string' },
      parentMessageId: { type: 'string' },
      sourceMessageId: { type: 'string' },
    }, ['title']),
  },
  {
    name: 'list_reminders',
    description: 'List reminders owned by this agent.',
    inputSchema: schema({
      status: { type: 'string' },
      limit: { type: 'number' },
    }),
  },
  {
    name: 'cancel_reminder',
    description: 'Cancel a scheduled reminder.',
    inputSchema: schema({
      reminderId: { type: 'string' },
      id: { type: 'string' },
    }),
  },
];

function send(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function sendError(id, code, message, data = null) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message, data } })}\n`);
}

function textResult(text) {
  return { content: [{ type: 'text', text: String(text || '') }] };
}

function jsonText(value) {
  if (typeof value?.text === 'string' && value.text.trim()) return value.text;
  return JSON.stringify(value ?? {}, null, 2);
}

function withAgentId(args = {}) {
  return { ...args, agentId: args.agentId || options.agentId };
}

function queryString(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const value = search.toString();
  return value ? `?${value}` : '';
}

async function request(pathname, { method = 'GET', query = {}, body = null } = {}) {
  const response = await fetch(`${options.baseUrl}${pathname}${queryString(query)}`, {
    method,
    headers: machineHeaders(body),
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
    const error = new Error(data?.error || data?.message || text || `HTTP ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

async function callTool(name, rawArgs = {}) {
  const args = withAgentId(rawArgs);
  switch (name) {
    case 'send_message':
      return request('/api/agent-tools/messages/send', {
        method: 'POST',
        body: {
          agentId: args.agentId,
          workItemId: args.workItemId || args.work_item_id,
          target: args.target,
          content: args.content,
        },
      });
    case 'read_history':
      return request('/api/agent-tools/history', {
        query: {
          agentId: args.agentId,
          target: args.target || args.channel,
          limit: args.limit,
          around: args.around,
          before: args.before,
          after: args.after,
        },
      });
    case 'search_messages':
      return request('/api/agent-tools/search', {
        query: {
          agentId: args.agentId,
          query: args.query || args.q,
          target: args.target || args.channel,
          limit: args.limit,
        },
      });
    case 'search_agent_memory':
      return request('/api/agent-tools/memory/search', {
        query: {
          agentId: args.agentId,
          query: args.query || args.q,
          targetAgentId: args.targetAgentId || args.targetAgent,
          limit: args.limit,
        },
      });
    case 'read_agent_memory':
      return request('/api/agent-tools/memory/read', {
        query: {
          agentId: args.agentId,
          targetAgentId: args.targetAgentId || args.targetAgent,
          path: args.path || 'MEMORY.md',
        },
      });
    case 'list_agents':
      return request('/api/agent-tools/agents', {
        query: {
          agentId: args.agentId,
          query: args.query || args.q,
          target: args.target || args.channel,
          limit: args.limit,
        },
      });
    case 'read_agent_profile':
      return request('/api/agent-tools/agents/read', {
        query: {
          agentId: args.agentId,
          targetAgentId: args.targetAgentId || args.targetAgent,
        },
      });
    case 'write_memory':
      return request('/api/agent-tools/memory', {
        method: 'POST',
        body: args,
      });
    case 'list_tasks':
      return request('/api/agent-tools/tasks', {
        query: {
          agentId: args.agentId,
          channel: args.channel,
          target: args.target,
          status: args.status,
          assigneeId: args.assigneeId,
          limit: args.limit,
        },
      });
    case 'create_tasks':
      return request('/api/agent-tools/tasks', {
        method: 'POST',
        body: args,
      });
    case 'claim_tasks':
      return request('/api/agent-tools/tasks/claim', {
        method: 'POST',
        body: args,
      });
    case 'update_task_status':
      return request('/api/agent-tools/tasks/update', {
        method: 'POST',
        body: args,
      });
    case 'propose_channel_members':
      return request('/api/agent-tools/channel-member-proposals', {
        method: 'POST',
        body: {
          agentId: args.agentId,
          channelId: args.channelId || args.channel_id || args.channel,
          memberIds: args.memberIds || args.member_ids || (args.memberId ? [args.memberId] : undefined),
          reason: args.reason,
        },
      });
    case 'schedule_reminder':
      return request('/api/agent-tools/reminders', {
        method: 'POST',
        body: args,
      });
    case 'list_reminders':
      return request('/api/agent-tools/reminders', {
        query: {
          agentId: args.agentId,
          status: args.status,
          limit: args.limit,
        },
      });
    case 'cancel_reminder':
      return request('/api/agent-tools/reminders/cancel', {
        method: 'POST',
        body: args,
      });
    default:
      throw new Error(`Unsupported tool: ${name || '(empty)'}`);
  }
}

async function handle(message) {
  const id = message.id;
  try {
    if (message.method === 'initialize') {
      send(id, {
        protocolVersion: message.params?.protocolVersion || '2024-11-05',
        serverInfo: { name: 'magclaw-cloud', version: '0.1.0' },
        capabilities: { tools: {} },
      });
      return;
    }
    if (message.method === 'tools/list') {
      send(id, { tools });
      return;
    }
    if (message.method === 'tools/call') {
      const result = await callTool(message.params?.name, message.params?.arguments || {});
      send(id, textResult(jsonText(result)));
      return;
    }
    if (message.method === 'notifications/initialized' || message.method === 'initialized') return;
    sendError(id, -32601, `Unsupported method: ${message.method || 'unknown'}`);
  } catch (error) {
    sendError(id, -32000, error.message, error.data || null);
  }
}

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      handle(JSON.parse(line));
    } catch (error) {
      sendError(null, -32700, error.message);
    }
  }
});
