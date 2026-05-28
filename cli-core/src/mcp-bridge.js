#!/usr/bin/env node
// MCP stdio bridge used by cloud-connected daemon agents. It forwards MagClaw
// tool calls to the cloud server with the daemon machine token.
import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const options = {
    agentId: '',
    agentRoot: '',
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
    } else if (item === '--agent-root') {
      options.agentRoot = next || '';
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

const PROGRESSIVE_DISCLOSURE_SECTION = [
  '## 渐进式披露',
  '- 其他 Agent 默认只会先读取本文件；不要假设它们已经看到 `notes/` 或 `workspace/` 中的详细文件。',
  '- 如果信息不足、但已经知道具体需要什么内容，请再次请求明确路径，例如 `read_agent_memory(targetAgentId="<agent-id>", path="notes/profile.md")` 或 `read_agent_file(targetAgentId="<agent-id>", path="workspace/<file>")`。',
  '- 本文件只放入口索引、能力边界和路径线索；详细规则、任务记录和交付物放入 `notes/` 或 `workspace/` 的明确文件。',
].join('\n');

function localAgentRoot() {
  return options.agentRoot ? path.resolve(options.agentRoot) : '';
}

function localMemoryHash(content) {
  return crypto.createHash('sha256').update(String(content || '')).digest('hex');
}

function defaultLocalMemory(agentId) {
  return [
    `# ${agentId || 'Agent'}`,
    '',
    '## 知识索引',
    '- `notes/profile.md` - 角色边界、稳定能力和回复习惯。',
    '- `notes/work-log.md` - 任务记录、长期决策和完成产物。',
    '',
    PROGRESSIVE_DISCLOSURE_SECTION,
    '',
    '## 能力',
    '- 暂无经过真实任务验证的稳定能力。',
    '',
    '## 当前上下文',
    '- 暂无需要跨回合延续的任务。',
    '',
    '## 近期工作',
    '- 暂无近期可复用记录。',
    '',
  ].join('\n');
}

function ensureLocalMemoryGuidance(content, agentId) {
  const value = String(content || '').replace(/\s+$/u, '');
  if (/^##\s+渐进式披露\s*$/m.test(value)) return `${value}\n`;
  if (!value.trim()) return defaultLocalMemory(agentId);
  return `${value}\n\n${PROGRESSIVE_DISCLOSURE_SECTION}\n`;
}

function headingForMemoryKind(kind) {
  const value = String(kind || '').trim().toLowerCase();
  if (value === 'capability') return '能力';
  if (value === 'preference' || value === 'communication_style') return '当前上下文';
  return '近期工作';
}

function upsertLocalMemoryBullet(content, heading, summary) {
  const lines = String(content || '').replace(/\s+$/u, '').split(/\r?\n/);
  const text = String(summary || '').trim().replace(/^\-\s*/, '');
  if (!text) return `${lines.join('\n')}\n`;
  const bullet = `- ${text}`;
  if (lines.some((line) => line.trim() === bullet)) return `${lines.join('\n')}\n`;
  const headingIndex = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (headingIndex === -1) return `${lines.join('\n')}\n\n## ${heading}\n${bullet}\n`;
  let insertAt = headingIndex + 1;
  while (insertAt < lines.length && lines[insertAt].trim() === '') insertAt += 1;
  lines.splice(insertAt, 0, bullet);
  return `${lines.join('\n')}\n`;
}

async function writeLocalMemory(args = {}) {
  const root = localAgentRoot();
  if (!root) return null;
  await mkdir(path.join(root, 'notes'), { recursive: true });
  await mkdir(path.join(root, 'workspace'), { recursive: true });
  const memoryPath = path.join(root, 'MEMORY.md');
  if (!existsSync(memoryPath)) await writeFile(memoryPath, defaultLocalMemory(options.agentId), 'utf8');
  const current = await readFile(memoryPath, 'utf8').catch(() => defaultLocalMemory(options.agentId));
  const summary = String(args.summary || args.content || args.sourceText || '').trim();
  if (!summary) throw new Error('Memory summary is required.');
  const next = upsertLocalMemoryBullet(
    ensureLocalMemoryGuidance(current, options.agentId),
    headingForMemoryKind(args.kind),
    summary,
  );
  await writeFile(memoryPath, next, 'utf8');
  return {
    content: next,
    documentHash: localMemoryHash(next),
    path: memoryPath,
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
    description: 'Send a MagClaw message. With workItemId it replies to the current routed task; without workItemId it can proactively send to a visible target such as dm:@Agent.',
    inputSchema: schema({
      workItemId: { type: 'string' },
      target: { type: 'string' },
      content: { type: 'string' },
    }, ['target', 'content']),
  },
  {
    name: 'read_history',
    description: 'Read bounded MagClaw conversation history.',
    inputSchema: schema({
      target: { type: 'string' },
      workItemId: { type: 'string' },
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
      workItemId: { type: 'string' },
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
    description: 'Read MEMORY.md by default, or a permitted notes/*.md|txt file when the path is explicitly known.',
    inputSchema: schema({
      targetAgentId: { type: 'string' },
      path: { type: 'string' },
    }, ['targetAgentId']),
  },
  {
    name: 'read_agent_file',
    description: 'Read an explicit detailed Agent workspace path after MEMORY.md points to it.',
    inputSchema: schema({
      targetAgentId: { type: 'string' },
      path: { type: 'string' },
    }, ['targetAgentId', 'path']),
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
    name: 'read_agent_avatar',
    description: 'Read a MagClaw agent avatar image for visual comparison with uploaded attachments.',
    inputSchema: schema({
      targetAgentId: { type: 'string' },
      targetAgent: { type: 'string' },
      maxBytes: { type: 'number' },
    }),
  },
  {
    name: 'list_attachments',
    description: 'List MagClaw attachment metadata visible to this agent.',
    inputSchema: schema({
      target: { type: 'string' },
      channel: { type: 'string' },
      workItemId: { type: 'string' },
      messageId: { type: 'string' },
      limit: { type: 'number' },
    }),
  },
  {
    name: 'read_attachment',
    description: 'Read an uploaded MagClaw attachment original file. Image attachments are returned as MCP image content when possible.',
    inputSchema: schema({
      attachmentId: { type: 'string' },
      id: { type: 'string' },
      maxBytes: { type: 'number' },
      format: { type: 'string' },
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

function imageResultContent(value = {}) {
  const type = String(value?.avatar?.type || value?.file?.type || value?.attachment?.type || '').toLowerCase();
  if (!type.startsWith('image/')) return null;
  if (value?.file?.truncated || value?.avatar?.truncated) return null;
  const data = String(value?.contentBase64 || '').trim();
  if (!data) return null;
  return { type: 'image', data, mimeType: type };
}

function contentResult(value) {
  const content = [{ type: 'text', text: jsonText(value) }];
  const image = imageResultContent(value);
  if (image) content.push(image);
  return { content };
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
          workItemId: args.workItemId || args.work_item_id,
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
          workItemId: args.workItemId || args.work_item_id,
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
    case 'read_agent_file':
      return request('/api/agent-tools/files/read', {
        query: {
          agentId: args.agentId,
          targetAgentId: args.targetAgentId || args.targetAgent,
          path: args.path,
        },
      });
    case 'write_memory':
      {
        const local = await writeLocalMemory(args);
        if (!local) {
          return request('/api/agent-tools/memory', {
            method: 'POST',
            body: args,
          });
        }
        request('/api/agent-tools/memory/mirror', {
          method: 'POST',
          body: {
            ...args,
            content: local.content,
            documentHash: local.documentHash,
            idempotencyKey: `daemon-memory:${workspaceId() || 'local'}:${args.agentId}:${local.documentHash}`,
          },
        }).catch((error) => {
          console.error(`[magclaw-mcp] async MEMORY.md mirror sync failed: ${error.message}`);
        });
        return {
          ok: true,
          status: 'local_applied',
          mirrorSync: 'queued',
          file: {
            path: 'MEMORY.md',
            absolutePath: local.path,
            documentHash: local.documentHash,
          },
          text: 'Memory updated locally. Cloud MEMORY.md mirror sync queued.',
        };
      }
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
    case 'read_agent_avatar':
      return request('/api/agent-tools/agents/avatar/read', {
        query: {
          agentId: args.agentId,
          targetAgentId: args.targetAgentId || args.targetAgent,
          maxBytes: args.maxBytes || args.max_bytes,
        },
      });
    case 'list_attachments':
      return request('/api/agent-tools/attachments', {
        query: {
          agentId: args.agentId,
          target: args.target || args.channel,
          workItemId: args.workItemId || args.work_item_id,
          messageId: args.messageId || args.message_id,
          limit: args.limit,
        },
      });
    case 'read_attachment':
      return request('/api/agent-tools/attachments/read', {
        query: {
          agentId: args.agentId,
          attachmentId: args.attachmentId || args.attachment_id || args.id,
          maxBytes: args.maxBytes || args.max_bytes,
          format: args.format,
        },
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
      send(id, contentResult(result));
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
