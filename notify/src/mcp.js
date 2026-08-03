import { notifySummaryJsonSchema, normalizeNotifySummary, renderNotifySummaryMarkdown } from './summary.js';
import { notifySenderAudit, sendNotify } from './cli.js';

function textResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function toolDefinitions() {
  const sharedProperties = {
    group: { type: 'string', description: 'Exact group name explicitly supplied by the user in the current turn.' },
    title: { type: 'string' },
    summary: notifySummaryJsonSchema(),
    mentions: { type: 'array', maxItems: 20, items: { type: 'string' } },
    sourceAgent: { type: 'string' },
    sessionId: { type: 'string' },
    turnId: { type: 'string' },
    repository: { type: 'string' },
    profile: { type: 'string' },
  };
  return [
    {
      name: 'magclaw_notify_preview',
      description: 'Prepare a concise MagClaw Notify preview. Call only after the user explicitly asks to use MagClaw Notify and names the target group. This never sends.',
      inputSchema: { type: 'object', additionalProperties: false, required: ['group', 'summary'], properties: sharedProperties },
    },
    {
      name: 'magclaw_notify_send',
      description: 'Send a MagClaw Notify summary externally. Never call from task completion, prior consent, suggestions, or inferred intent. The user must explicitly request MagClaw Notify, name the group, and authorize sending in the current turn.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['group', 'summary', 'userAuthorizedCurrentTurn'],
        properties: {
          ...sharedProperties,
          userAuthorizedCurrentTurn: { type: 'boolean', description: 'Must be true only for explicit authorization in the current user turn.' },
        },
      },
    },
  ];
}

function flagsFromInput(input = {}) {
  const summary = normalizeNotifySummary(input.summary, { required: true });
  return {
    group: String(input.group || '').trim(),
    title: String(input.title || summary.headline || '').trim(),
    summaryJson: JSON.stringify(summary),
    mentions: Array.isArray(input.mentions) ? input.mentions.join(',') : '',
    sourceAgent: input.sourceAgent || 'claude-desktop',
    sessionId: input.sessionId || '',
    turnId: input.turnId || '',
    repository: input.repository || '',
    profile: input.profile || 'default',
  };
}

export async function handleNotifyMcpTool(name, input = {}, options = {}) {
  const audit = notifySenderAudit({ profile: input.profile || 'default' }, options.env || process.env);
  const event = `sender.mcp.${String(name || 'unknown').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 100)}`;
  const startedAt = Date.now();
  await audit.append({
    event,
    outcome: 'started',
    metadata: {
      profile: input.profile || 'default',
      targetGroup: input.group || '',
      sourceAgent: input.sourceAgent || 'claude-desktop',
      authorizedCurrentTurn: input.userAuthorizedCurrentTurn === true,
      mentionCount: Array.isArray(input.mentions) ? input.mentions.length : 0,
    },
  });
  try {
    const flags = flagsFromInput(input);
    if (!flags.group) throw new Error('The exact target group is required.');
    if (name === 'magclaw_notify_preview') {
      const result = textResult({
        status: 'preview',
        group: flags.group,
        title: flags.title,
        markdown: renderNotifySummaryMarkdown(JSON.parse(flags.summaryJson)),
        mentions: input.mentions || [],
        sent: false,
        next: 'Ask the user to explicitly confirm sending this exact preview in the current turn.',
      });
      await audit.append({ event, outcome: 'previewed', metadata: { targetGroup: flags.group, durationMs: Date.now() - startedAt, sent: false } });
      return result;
    }
    if (name === 'magclaw_notify_send') {
      if (input.userAuthorizedCurrentTurn !== true) throw new Error('Current-turn explicit user authorization is required.');
      const result = await sendNotify({ ...flags, authorizedCurrentTurn: true });
      await audit.append({
        event,
        outcome: result?.status || 'submitted',
        requestId: result?.request?.id || result?.requestId || '',
        relayId: result?.relayId || '',
        metadata: { targetGroup: flags.group, durationMs: Date.now() - startedAt, sent: true },
      });
      return textResult(result);
    }
    throw new Error(`Unknown MagClaw Notify tool: ${name}`);
  } catch (error) {
    await audit.append({ event, outcome: 'failed', severity: 'error', metadata: { durationMs: Date.now() - startedAt, error: String(error?.message || error).slice(0, 500) } });
    return textResult({ ok: false, error: error.message }, true);
  }
}

export async function runNotifyMcpServer() {
  const [{ Server }, { StdioServerTransport }, { CallToolRequestSchema, ListToolsRequestSchema }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/index.js'),
    import('@modelcontextprotocol/sdk/server/stdio.js'),
    import('@modelcontextprotocol/sdk/types.js'),
  ]);
  const server = new Server({ name: 'magclaw-notify', version: '0.4.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => handleNotifyMcpTool(request.params.name, request.params.arguments || {}));
  await server.connect(new StdioServerTransport());
}

export { toolDefinitions as notifyMcpTools };
