import assert from 'node:assert/strict';
import { chmod, cp, lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  ROOT,
  launchIsolatedServer,
  readJsonLines,
  readSseEvent,
  readSseEventFromReader,
  request,
  startIsolatedServer,
  startMockFanoutApi,
  waitFor,
} from './helpers/magclaw-flow.js';

test('Codex app-server MCP tool approval requests auto-approve MagClaw tools', async () => {
  const fakeCodexDir = await mkdtemp(path.join(os.tmpdir(), 'magclaw-fake-mcp-approval-'));
  const fakeCodexPath = path.join(fakeCodexDir, 'codex-fake.js');
  const logPath = path.join(fakeCodexDir, 'codex-log.jsonl');
  await writeFile(fakeCodexPath, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const logPath = process.env.FAKE_CODEX_LOG;
function log(value) {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(value) + '\\n');
}
if (args[0] === 'exec') {
  const outputPath = args[args.indexOf('-o') + 1];
  log({ mode: 'exec', args });
  process.stdin.on('end', () => {
    fs.writeFileSync(outputPath, 'legacy fallback should not run for MCP approval');
    process.exit(0);
  });
  process.stdin.resume();
} else if (args[0] === 'app-server') {
  log({ mode: 'app-server', args });
  let buffer = '';
  function send(value) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
  }
  function handle(message) {
    log({ incoming: message });
    if (message.id === 77 && message.result) {
      log({ elicitationResponse: message.result });
      send({
        method: 'item/completed',
        params: {
          item: {
            id: 'call_memory_search',
            type: 'mcpToolCall',
            server: 'magclaw',
            tool: 'search_agent_memory',
            status: 'completed',
            arguments: { query: '旅游', limit: 10 },
            result: { content: [{ type: 'text', text: '魏无涯: 旅游经验丰富' }] },
          },
        },
      });
      send({ method: 'item/agentMessage/delta', params: { delta: '查过记忆了，魏无涯更擅长旅游。' } });
      send({
        method: 'item/completed',
        params: {
          item: {
            id: 'agent_reply',
            type: 'agentMessage',
            text: '查过记忆了，魏无涯更擅长旅游。',
          },
        },
      });
      send({ method: 'turn/completed', params: { turn: { id: 'turn_mcp_approval', status: 'completed' } } });
      return;
    }
    if (message.method === 'initialize') {
      send({ id: message.id, result: {} });
      return;
    }
    if (message.method === 'initialized') return;
    if (message.method === 'thread/start') {
      send({ id: message.id, result: { thread: { id: 'thread_mcp_approval' } } });
      return;
    }
    if (message.method === 'thread/resume') {
      send({ id: message.id, result: { thread: { id: message.params.threadId } } });
      return;
    }
    if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'turn_mcp_approval' } } });
      send({ method: 'turn/started', params: { turn: { id: 'turn_mcp_approval' } } });
      setTimeout(() => {
        send({
          method: 'item/started',
          params: {
            item: {
              id: 'call_memory_search',
              type: 'mcpToolCall',
              server: 'magclaw',
              tool: 'search_agent_memory',
              status: 'inProgress',
              arguments: { query: '旅游', limit: 10 },
            },
          },
        });
        send({
          id: 77,
          method: 'mcpServer/elicitation/request',
          params: {
            threadId: 'thread_mcp_approval',
            turnId: 'turn_mcp_approval',
            serverName: 'magclaw',
            mode: 'form',
            _meta: {
              codex_approval_kind: 'mcp_tool_call',
              persist: ['session', 'always'],
              tool_description: 'Search MagClaw agent memory.',
              tool_params: { query: '旅游', limit: 10 },
              tool_params_display: [
                { name: 'query', value: '旅游', display_name: 'query' },
                { name: 'limit', value: 10, display_name: 'limit' },
              ],
            },
            message: 'Allow the magclaw MCP server to run tool "search_agent_memory"?',
            requestedSchema: { type: 'object', properties: {} },
          },
        });
      }, 20);
    }
    if (message.method === 'turn/interrupt') {
      log({ method: 'turn/interrupt-unexpected', params: message.params });
      send({ id: message.id, result: {} });
    }
  }
  process.on('SIGTERM', () => process.exit(0));
  process.stdin.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\\r?\\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      handle(JSON.parse(line));
    }
  });
}
`);
  await chmod(fakeCodexPath, 0o755);
  const server = await startIsolatedServer({
    CODEX_PATH: fakeCodexPath,
    FAKE_CODEX_LOG: logPath,
    MAGCLAW_AGENT_STUCK_SEND_MESSAGE_MS: '5000',
    MAGCLAW_AGENT_RUN_STALL_LOG_MS: '5000',
    MAGCLAW_STATE_HEARTBEAT_MS: '25',
  });
  try {
    const created = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({ body: '<@agt_codex> 查一下谁对旅游比较擅长', attachmentIds: [] }),
    });

    const finalState = await waitFor(async () => {
      const state = await request(server.baseUrl, '/api/state');
      const replied = state.replies.some((item) => item.parentMessageId === created.message.id && item.body.includes('魏无涯更擅长旅游'));
      const agent = state.agents.find((item) => item.id === 'agt_codex');
      return replied && agent?.status === 'idle' ? state : null;
    }, 6000);
    assert.ok(finalState, JSON.stringify((await request(server.baseUrl, '/api/state')).events.slice(-20), null, 2));
    const workItem = finalState.workItems.find((item) => item.sourceMessageId === created.message.id && item.agentId === 'agt_codex');
    assert.equal(workItem.status, 'responded');
    assert.ok(finalState.events.some((item) => item.type === 'agent_mcp_elicitation_auto_approved'
      && item.canonicalName === 'search_agent_memory'));
    assert.ok(finalState.events.some((item) => item.type === 'agent_mcp_tool_call_completed'
      && item.toolCallId === 'call_memory_search'));
    assert.equal(finalState.events.some((item) => item.type === 'agent_app_server_request_unhandled'
      && item.method === 'mcpServer/elicitation/request'), false);
    const entries = await readJsonLines(logPath);
    assert.ok(entries.some((item) => item.elicitationResponse?.action === 'accept'));
    assert.equal(entries.some((item) => item.mode === 'exec'), false);
  } finally {
    await server.stop();
    await rm(fakeCodexDir, { recursive: true, force: true });
  }
});

test('Codex app-server watchdog logs but does not kill a long-running tool call', async () => {
  const fakeCodexDir = await mkdtemp(path.join(os.tmpdir(), 'magclaw-fake-watchdog-long-tool-'));
  const fakeCodexPath = path.join(fakeCodexDir, 'codex-fake.js');
  const logPath = path.join(fakeCodexDir, 'codex-log.jsonl');
  await writeFile(fakeCodexPath, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const logPath = process.env.FAKE_CODEX_LOG;
function log(value) {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(value) + '\\n');
}
if (args[0] === 'exec') {
  const outputPath = args[args.indexOf('-o') + 1];
  log({ mode: 'exec', args });
  process.stdin.on('end', () => {
    fs.writeFileSync(outputPath, 'legacy fallback should not run for long tool call');
    process.exit(0);
  });
  process.stdin.resume();
} else if (args[0] === 'app-server') {
  log({ mode: 'app-server', args });
  let buffer = '';
  function send(value) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
  }
  function handle(message) {
    log({ method: message.method, params: message.params });
    if (message.method === 'initialize') {
      send({ id: message.id, result: {} });
      return;
    }
    if (message.method === 'initialized') return;
    if (message.method === 'thread/start') {
      send({ id: message.id, result: { thread: { id: 'thread_watchdog_long_tool' } } });
      return;
    }
    if (message.method === 'thread/resume') {
      send({ id: message.id, result: { thread: { id: message.params.threadId } } });
      return;
    }
    if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'turn_watchdog_long_tool' } } });
      send({ method: 'turn/started', params: { turn: { id: 'turn_watchdog_long_tool' } } });
      setTimeout(() => {
        send({
          method: 'item/started',
          params: {
            item: {
              id: 'tool_watchdog_shell',
              type: 'commandExecution',
              command: 'sleep 20 && echo done',
            },
          },
        });
      }, 20);
      setTimeout(() => {
        send({
          method: 'item/completed',
          params: {
            item: {
              id: 'tool_watchdog_shell',
              type: 'commandExecution',
              command: 'sleep 20 && echo done',
            },
          },
        });
        send({ method: 'item/agentMessage/delta', params: { itemId: 'item_watchdog_long_tool', delta: 'long tool completed normally' } });
        send({ method: 'turn/completed', params: { turn: { id: 'turn_watchdog_long_tool', status: 'completed' } } });
      }, 850);
    }
    if (message.method === 'turn/interrupt') {
      log({ method: 'turn/interrupt-unexpected', params: message.params });
      send({ id: message.id, result: {} });
    }
  }
  process.on('SIGTERM', () => {
    log({ signal: 'SIGTERM' });
    process.exit(143);
  });
  process.stdin.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\\r?\\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      handle(JSON.parse(line));
    }
  });
}
`);
  await chmod(fakeCodexPath, 0o755);
  const server = await startIsolatedServer({
    CODEX_PATH: fakeCodexPath,
    FAKE_CODEX_LOG: logPath,
    MAGCLAW_AGENT_STUCK_SEND_MESSAGE_MS: '300',
    MAGCLAW_AGENT_RUN_STALL_LOG_MS: '300',
    MAGCLAW_STATE_HEARTBEAT_MS: '25',
  });
  try {
    const created = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({ body: '<@agt_codex> 跑一个耗时工具调用', attachmentIds: [] }),
    });

    const finalState = await waitFor(async () => {
      const state = await request(server.baseUrl, '/api/state');
      const replied = state.replies.some((item) => item.parentMessageId === created.message.id && item.body.includes('long tool completed normally'));
      const agent = state.agents.find((item) => item.id === 'agt_codex');
      return replied && agent?.status === 'idle' ? state : null;
    }, 6000);
    assert.ok(finalState, JSON.stringify((await request(server.baseUrl, '/api/state')).events.slice(-20), null, 2));
    assert.ok(finalState.events.some((item) => item.type === 'agent_run_watchdog_stall' && item.agentId === 'agt_codex'));
    assert.equal(finalState.events.some((item) => item.type === 'agent_runtime_fallback'), false);
    assert.equal(finalState.events.some((item) => item.type === 'agent_send_message_watchdog_timeout'), false);
    const entries = await readJsonLines(logPath);
    assert.ok(entries.some((item) => item.mode === 'app-server'));
    assert.equal(entries.some((item) => item.mode === 'exec'), false);
    assert.equal(entries.some((item) => item.method === 'turn/interrupt-unexpected'), false);
    assert.equal(entries.some((item) => item.signal === 'SIGTERM'), false);
  } finally {
    await server.stop();
    await rm(fakeCodexDir, { recursive: true, force: true });
  }
});

test('Codex app-server watchdog emits MagClaw-style activity heartbeat and runtime stalled events without killing the turn', async () => {
  const fakeCodexDir = await mkdtemp(path.join(os.tmpdir(), 'magclaw-fake-watchdog-activity-'));
  const fakeCodexPath = path.join(fakeCodexDir, 'codex-fake.js');
  const logPath = path.join(fakeCodexDir, 'codex-log.jsonl');
  await writeFile(fakeCodexPath, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const logPath = process.env.FAKE_CODEX_LOG;
function log(value) {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(value) + '\\n');
}
if (args[0] === 'exec') {
  const outputPath = args[args.indexOf('-o') + 1];
  log({ mode: 'exec', args });
  process.stdin.on('end', () => {
    fs.writeFileSync(outputPath, 'legacy fallback should not run for activity watchdog');
    process.exit(0);
  });
  process.stdin.resume();
} else if (args[0] === 'app-server') {
  log({ mode: 'app-server', args });
  let buffer = '';
  function send(value) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
  }
  function handle(message) {
    log({ method: message.method, params: message.params });
    if (message.method === 'initialize') {
      send({ id: message.id, result: {} });
      return;
    }
    if (message.method === 'initialized') return;
    if (message.method === 'thread/start') {
      send({ id: message.id, result: { thread: { id: 'thread_watchdog_activity' } } });
      return;
    }
    if (message.method === 'thread/resume') {
      send({ id: message.id, result: { thread: { id: message.params.threadId } } });
      return;
    }
    if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'turn_watchdog_activity' } } });
      send({ method: 'turn/started', params: { turn: { id: 'turn_watchdog_activity' } } });
      setTimeout(() => {
        send({
          method: 'item/started',
          params: {
            item: {
              id: 'tool_watchdog_activity',
              type: 'commandExecution',
              command: 'long command with sparse runtime events',
            },
          },
        });
      }, 20);
      setTimeout(() => {
        send({
          method: 'item/completed',
          params: {
            item: {
              id: 'tool_watchdog_activity',
              type: 'commandExecution',
              command: 'long command with sparse runtime events',
            },
          },
        });
        send({ method: 'item/agentMessage/delta', params: { itemId: 'item_watchdog_activity', delta: 'activity watchdog completed normally' } });
        send({ method: 'turn/completed', params: { turn: { id: 'turn_watchdog_activity', status: 'completed' } } });
      }, 1100);
    }
    if (message.method === 'turn/interrupt') {
      log({ method: 'turn/interrupt-unexpected', params: message.params });
      send({ id: message.id, result: {} });
    }
  }
  process.on('SIGTERM', () => {
    log({ signal: 'SIGTERM' });
    process.exit(143);
  });
  process.stdin.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split(/\\r?\\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      handle(JSON.parse(line));
    }
  });
}
`);
  await chmod(fakeCodexPath, 0o755);
  const server = await startIsolatedServer({
    CODEX_PATH: fakeCodexPath,
    FAKE_CODEX_LOG: logPath,
    MAGCLAW_AGENT_STUCK_SEND_MESSAGE_MS: '5000',
    MAGCLAW_AGENT_RUN_STALL_LOG_MS: '250',
    MAGCLAW_AGENT_ACTIVITY_HEARTBEAT_MS: '250',
    MAGCLAW_AGENT_RUNTIME_PROGRESS_STALE_MS: '650',
    MAGCLAW_STATE_HEARTBEAT_MS: '25',
  });
  try {
    const created = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({ body: '<@agt_codex> 跑一个稀疏事件长任务', attachmentIds: [] }),
    });

    const finalState = await waitFor(async () => {
      const state = await request(server.baseUrl, '/api/state');
      const replied = state.replies.some((item) => item.parentMessageId === created.message.id && item.body.includes('activity watchdog completed normally'));
      const agent = state.agents.find((item) => item.id === 'agt_codex');
      return replied && agent?.status === 'idle' ? state : null;
    }, 6000);
    assert.ok(finalState.events.some((item) => item.type === 'agent_activity_heartbeat' && item.agentId === 'agt_codex'));
    assert.ok(finalState.events.some((item) => item.type === 'agent_runtime_progress_stalled' && item.agentId === 'agt_codex'));
    assert.ok(finalState.events.some((item) => item.type === 'agent_runtime_progress_observed' && item.agentId === 'agt_codex'));
    assert.equal(finalState.events.some((item) => item.type === 'agent_runtime_fallback'), false);
    assert.equal(finalState.events.some((item) => item.type === 'agent_send_message_watchdog_timeout'), false);
    const entries = await readJsonLines(logPath);
    assert.ok(entries.some((item) => item.mode === 'app-server'));
    assert.equal(entries.some((item) => item.mode === 'exec'), false);
    assert.equal(entries.some((item) => item.method === 'turn/interrupt-unexpected'), false);
    assert.equal(entries.some((item) => item.signal === 'SIGTERM'), false);
  } finally {
    await server.stop();
    await rm(fakeCodexDir, { recursive: true, force: true });
  }
});

test('agent tool send_message routes by work item and rejects cross-channel targets', async () => {
  const server = await startIsolatedServer();
  try {
    const { channel } = await request(server.baseUrl, '/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'x', description: 'wrong target channel', agentIds: ['agt_codex'] }),
    });

    const created = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({
        body: '<@agt_codex> reply through the explicit work item router',
        attachmentIds: [],
      }),
    });

    const workItem = await waitFor(async () => {
      const snapshot = await request(server.baseUrl, '/api/state');
      return snapshot.workItems?.find((item) => item.sourceMessageId === created.message.id && item.agentId === 'agt_codex');
    }, 3000);
    assert.ok(workItem);
    assert.match(workItem.id, /^wi_/);
    assert.match(workItem.target, /^#all:msg_/);

    const sent = await request(server.baseUrl, '/api/agent-tools/messages/send', {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agt_codex',
        workItemId: workItem.id,
        target: workItem.target,
        content: 'explicit routed reply',
      }),
    });
    assert.equal(sent.ok, true);
    assert.equal(sent.workItem.status, 'responded');

    const rejected = await fetch(`${server.baseUrl}/api/agent-tools/messages/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agt_codex',
        workItemId: workItem.id,
        target: `#${channel.name}`,
        content: 'this must not land in the wrong channel',
      }),
    });
    assert.equal(rejected.status, 409);

    const finalState = await request(server.baseUrl, '/api/state');
    assert.ok(finalState.replies.some((reply) => reply.parentMessageId === created.message.id && reply.body === 'explicit routed reply'));
    assert.equal(finalState.messages.some((message) => message.spaceId === channel.id && message.body === 'this must not land in the wrong channel'), false);
    assert.ok(finalState.events.some((event) => event.type === 'agent_tool_send_message_started' && event.workItemId === workItem.id));
    assert.ok(finalState.events.some((event) => event.type === 'agent_tool_send_message' && event.workItemId === workItem.id && event.durationMs >= 0));
    assert.ok(finalState.events.some((event) => event.type === 'agent_tool_send_message_failed' && event.status === 409 && event.workItemId === workItem.id));
  } finally {
    await server.stop();
  }
});

test('agent tool task update enforces claimed ownership and status transitions', async () => {
  const server = await startIsolatedServer();
  try {
    const created = await request(server.baseUrl, '/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Agent-owned task update flow',
        spaceType: 'channel',
        spaceId: 'chan_all',
        assigneeId: 'agt_codex',
      }),
    });
    await request(server.baseUrl, `/api/tasks/${created.task.id}/claim`, {
      method: 'POST',
      body: JSON.stringify({ actorId: 'agt_codex' }),
    });

    const inReview = await request(server.baseUrl, '/api/agent-tools/tasks/update', {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agt_codex',
        taskId: created.task.id,
        status: 'in_review',
      }),
    });
    assert.equal(inReview.task.status, 'in_review');
    assert.match(inReview.task.reviewRequestedAt, /^\d{4}-\d{2}-\d{2}T/);

    const done = await request(server.baseUrl, '/api/agent-tools/tasks/update', {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agt_codex',
        taskId: created.task.id,
        status: 'done',
      }),
    });
    assert.equal(done.task.status, 'done');
    assert.match(done.task.completedAt, /^\d{4}-\d{2}-\d{2}T/);

    const otherAgent = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Other Worker', runtime: 'Codex CLI' }),
    });
    const otherTask = await request(server.baseUrl, '/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: 'Task claimed by another agent',
        spaceType: 'channel',
        spaceId: 'chan_all',
        assigneeId: otherAgent.agent.id,
      }),
    });
    await request(server.baseUrl, `/api/tasks/${otherTask.task.id}/claim`, {
      method: 'POST',
      body: JSON.stringify({ actorId: otherAgent.agent.id }),
    });

    const rejected = await fetch(`${server.baseUrl}/api/agent-tools/tasks/update`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'agt_codex',
        taskId: otherTask.task.id,
        status: 'in_review',
      }),
    });
    assert.equal(rejected.status, 409);

    const finalState = await request(server.baseUrl, '/api/state');
    const task = finalState.tasks.find((item) => item.id === created.task.id);
    assert.ok(task.history.some((item) => item.type === 'agent_review_requested'));
    assert.ok(task.history.some((item) => item.type === 'agent_done'));
  } finally {
    await server.stop();
  }
});

test('agent profile update persists editable detail fields', async () => {
  const server = await startIsolatedServer();
  try {
    const created = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Profile Editable',
        description: 'before',
        runtime: 'Codex CLI',
        model: 'gpt-5.4',
        reasoningEffort: 'medium',
        avatar: '/avatars/avatar_0001.svg',
      }),
    });

    const updated = await request(server.baseUrl, `/api/agents/${created.agent.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: 'Profile Updated',
        description: 'after',
        model: 'gpt-5.5',
        reasoningEffort: 'high',
        avatar: 'data:image/png;base64,AAAA',
      }),
    });

    assert.equal(updated.agent.name, 'Profile Updated');
    assert.equal(updated.agent.description, 'after');
    assert.equal(updated.agent.model, 'gpt-5.5');
    assert.equal(updated.agent.reasoningEffort, 'high');
    assert.equal(updated.agent.avatar, 'data:image/png;base64,AAAA');
    const state = await request(server.baseUrl, '/api/state');
    const agent = state.agents.find((item) => item.id === created.agent.id);
    assert.equal(agent.name, 'Profile Updated');
    assert.equal(agent.reasoningEffort, 'high');
  } finally {
    await server.stop();
  }
});

test('agent start and restart modes follow MagClaw-style session and workspace rules', async () => {
  const fakeCodexDir = await mkdtemp(path.join(os.tmpdir(), 'magclaw-fake-restart-codex-'));
  const fakeCodexPath = path.join(fakeCodexDir, 'codex-fake.cjs');
  await writeFile(fakeCodexPath, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex-cli fake-restart');
  process.exit(0);
}
if (args[0] === 'debug' && args[1] === 'models') {
  console.log(JSON.stringify({ models: [{ slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list', supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'high' }] }] }));
  process.exit(0);
}
let requestCount = 0;
let buffer = '';
function send(value) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
}
function handle(message) {
  if (message.method === 'initialize') {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'thread/resume') {
    send({ id: message.id, result: { thread: { id: message.params.threadId } } });
    return;
  }
  if (message.method === 'thread/start') {
    requestCount += 1;
    send({ id: message.id, result: { thread: { id: 'thread_' + process.pid + '_' + requestCount } } });
  }
}
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.on('SIGTERM', () => process.exit(0));
`);
  await chmod(fakeCodexPath, 0o755);

  const server = await startIsolatedServer({ CODEX_PATH: fakeCodexPath });
  const agentDir = path.join(server.tmp, '.magclaw', 'agents', 'agt_codex');
  const notePath = path.join(agentDir, 'notes', 'keep.md');
  const workspacePath = path.join(agentDir, 'workspace', 'scratch.txt');
  try {
    await request(server.baseUrl, '/api/agents/agt_codex/start', {
      method: 'POST',
      body: '{}',
    });
    const firstRunAgent = await waitFor(async () => {
      const state = await request(server.baseUrl, '/api/state');
      const agent = state.agents.find((item) => item.id === 'agt_codex');
      return agent?.runtimeSessionId && agent.status === 'idle' ? agent : null;
    });
    assert.ok(firstRunAgent.runtimeSessionId);

    await writeFile(notePath, 'preserve me');
    await writeFile(workspacePath, 'delete me later');

    await request(server.baseUrl, '/api/agents/agt_codex/restart', {
      method: 'POST',
      body: JSON.stringify({ mode: 'restart' }),
    });
    const restartedAgent = await waitFor(async () => {
      const state = await request(server.baseUrl, '/api/state');
      const agent = state.agents.find((item) => item.id === 'agt_codex');
      return agent?.status === 'idle' ? agent : null;
    });
    assert.equal(restartedAgent.runtimeSessionId, firstRunAgent.runtimeSessionId);
    assert.equal(await readFile(notePath, 'utf8'), 'preserve me');

    await request(server.baseUrl, '/api/agents/agt_codex/restart', {
      method: 'POST',
      body: JSON.stringify({ mode: 'reset-session' }),
    });
    const resetSessionAgent = await waitFor(async () => {
      const state = await request(server.baseUrl, '/api/state');
      const agent = state.agents.find((item) => item.id === 'agt_codex');
      return agent?.runtimeSessionId && agent.status === 'idle' && agent.runtimeSessionId !== firstRunAgent.runtimeSessionId ? agent : null;
    });
    assert.ok(resetSessionAgent.runtimeSessionId);
    assert.equal(await readFile(notePath, 'utf8'), 'preserve me');

    await request(server.baseUrl, '/api/agents/agt_codex/restart', {
      method: 'POST',
      body: JSON.stringify({ mode: 'full-reset' }),
    });
    const fullResetAgent = await waitFor(async () => {
      const state = await request(server.baseUrl, '/api/state');
      const agent = state.agents.find((item) => item.id === 'agt_codex');
      return agent?.runtimeSessionId && agent.status === 'idle' && agent.runtimeSessionId !== resetSessionAgent.runtimeSessionId ? agent : null;
    });
    assert.ok(fullResetAgent.runtimeSessionId);
    await assert.rejects(readFile(notePath, 'utf8'), { code: 'ENOENT' });
    await assert.rejects(readFile(workspacePath, 'utf8'), { code: 'ENOENT' });
    assert.ok(await readFile(path.join(agentDir, 'MEMORY.md'), 'utf8'));
  } finally {
    await server.stop();
    await rm(fakeCodexDir, { recursive: true, force: true });
  }
});

test('agent explicit send_message suppresses stdout fallback for the same turn', async () => {
  const fakeCodexDir = await mkdtemp(path.join(os.tmpdir(), 'magclaw-fake-send-tool-'));
  const fakeCodexPath = path.join(fakeCodexDir, 'codex-fake.js');
  await writeFile(fakeCodexPath, `#!/usr/bin/env node
let buffer = '';
let turnCount = 0;
function send(value) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
}
async function handle(message) {
  if (message.method === 'initialize') {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: 'thread_fake_send_tool' } } });
    return;
  }
  if (message.method === 'turn/start') {
    const turnId = 'turn_' + (++turnCount);
    const prompt = message.params?.input?.[0]?.text || '';
    const target = prompt.match(/target=([^\\s\\]]+)/)?.[1];
    const workItemId = prompt.match(/workItem=(wi_[^\\s\\]]+)/)?.[1];
    if (target && workItemId) {
      await fetch('http://127.0.0.1:' + process.env.PORT + '/api/agent-tools/messages/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          agentId: 'agt_codex',
          workItemId,
          target,
          content: 'explicit tool response',
        }),
      });
    }
    send({ id: message.id, result: { turn: { id: turnId } } });
    send({ method: 'turn/started', params: { turn: { id: turnId } } });
    send({ method: 'item/agentMessage/delta', params: { itemId: 'item_' + turnId, delta: 'stdout fallback should be suppressed' } });
    send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });
  }
}
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    Promise.resolve(handle(JSON.parse(line))).catch((error) => {
      send({ method: 'error', params: { message: error.message } });
    });
  }
});
`);
  await chmod(fakeCodexPath, 0o755);
  const server = await startIsolatedServer({ CODEX_PATH: fakeCodexPath });
  try {
    const created = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({
        body: '<@agt_codex> use send_message instead of final stdout',
        attachmentIds: [],
      }),
    });

    const finalState = await waitFor(async () => {
      const snapshot = await request(server.baseUrl, '/api/state');
      const replies = snapshot.replies.filter((reply) => reply.parentMessageId === created.message.id);
      return replies.some((reply) => reply.body === 'explicit tool response') ? snapshot : null;
    }, 8000);
    assert.ok(finalState);
    const allBodies = [...finalState.messages, ...finalState.replies].map((record) => record.body);
    assert.ok(allBodies.includes('explicit tool response'));
    assert.equal(allBodies.includes('stdout fallback should be suppressed'), false);
  } finally {
    await server.stop();
    await rm(fakeCodexDir, { recursive: true, force: true });
  }
});

test('busy Codex agent batches different-channel messages into the next turn and routes each target', async () => {
  const fakeCodexDir = await mkdtemp(path.join(os.tmpdir(), 'magclaw-fake-busy-batch-'));
  const fakeCodexPath = path.join(fakeCodexDir, 'codex-fake.js');
  const logPath = path.join(fakeCodexDir, 'codex-log.jsonl');
  await writeFile(fakeCodexPath, `#!/usr/bin/env node
const fs = require('node:fs');
const logPath = process.env.FAKE_CODEX_LOG;
let buffer = '';
let turnCount = 0;
function log(value) {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(value) + '\\n');
}
function send(value) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
}
function routedItems(prompt) {
  const items = [];
  const regex = /\\[target=([^\\s\\]]+)\\s+workItem=(wi_[^\\s\\]]+)/g;
  let match;
  while ((match = regex.exec(prompt))) {
    items.push({ target: match[1], workItemId: match[2] });
  }
  return items;
}
async function sendTool(item, content) {
  await fetch('http://127.0.0.1:' + process.env.PORT + '/api/agent-tools/messages/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agentId: 'agt_codex',
      workItemId: item.workItemId,
      target: item.target,
      content,
    }),
  });
}
function completeTurn(turnId, text, delay) {
  send({ method: 'turn/started', params: { turn: { id: turnId } } });
  setTimeout(() => {
    send({ method: 'item/agentMessage/delta', params: { itemId: 'item_' + turnId, delta: text } });
    send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });
  }, delay);
}
async function handle(message) {
  log({ method: message.method, params: message.params });
  if (message.method === 'initialize') {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: 'thread_fake_busy_batch' } } });
    return;
  }
  if (message.method === 'turn/start' || message.method === 'turn/steer') {
    const turnId = 'turn_' + (++turnCount);
    const prompt = message.params?.input?.[0]?.text || '';
    const items = routedItems(prompt);
    log({ method: 'prompt/items', turnId, items });
    send({ id: message.id, result: { turn: { id: turnId } } });
    if (message.method === 'turn/steer') {
      completeTurn(turnId, 'unexpected steer response', 0);
      return;
    }
    if (turnCount === 1) {
      completeTurn(turnId, 'initial delayed response', 500);
      return;
    }
    for (const item of items) {
      await sendTool(item, 'routed reply for ' + item.target);
    }
    completeTurn(turnId, 'batch stdout fallback should be suppressed', 0);
  }
}
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (line.trim()) Promise.resolve(handle(JSON.parse(line))).catch((error) => {
      log({ method: 'error', message: error.message });
      send({ method: 'error', params: { message: error.message } });
    });
  }
});
`);
  await chmod(fakeCodexPath, 0o755);
  const server = await startIsolatedServer({
    CODEX_PATH: fakeCodexPath,
    FAKE_CODEX_LOG: logPath,
    MAGCLAW_AGENT_BUSY_DELIVERY_DELAY_MS: '60',
  });
  try {
    const { channel } = await request(server.baseUrl, '/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'x', description: 'second work channel', agentIds: ['agt_codex'] }),
    });

    const first = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({
        body: '<@agt_codex> first long-running question',
        attachmentIds: [],
      }),
    });

    await waitFor(async () => {
      const entries = await readJsonLines(logPath);
      return entries.some((item) => item.method === 'turn/start');
    }, 3000);

    const second = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({
        body: '<@agt_codex> second queued question from all',
        attachmentIds: [],
      }),
    });
    const third = await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        body: '<@agt_codex> third queued question from x',
        attachmentIds: [],
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 180));
    const entries = await readJsonLines(logPath);
    assert.equal(entries.some((item) => item.method === 'turn/steer'), false);

    const finalState = await waitFor(async () => {
      const snapshot = await request(server.baseUrl, '/api/state');
      const firstReplies = snapshot.replies.filter((reply) => reply.parentMessageId === first.message.id);
      const secondReplies = snapshot.replies.filter((reply) => reply.parentMessageId === second.message.id);
      const thirdReplies = snapshot.replies.filter((reply) => reply.parentMessageId === third.message.id);
      return firstReplies.some((reply) => reply.body.includes('initial delayed response'))
        && secondReplies.some((reply) => reply.body.includes('routed reply for #all:'))
        && thirdReplies.some((reply) => reply.body.includes('routed reply for #x:'))
        ? snapshot
        : null;
    }, 8000);
    assert.ok(finalState);

    const finalEntries = await readJsonLines(logPath);
    const turnStarts = finalEntries.filter((item) => item.method === 'turn/start');
    assert.equal(finalEntries.some((item) => item.method === 'turn/steer'), false);
    assert.ok(turnStarts.length >= 2);
    const batchPrompt = turnStarts[1].params.input[0].text;
    assert.match(batchPrompt, /target=#all:msg_/);
    assert.match(batchPrompt, /target=#x:msg_/);
    assert.match(batchPrompt, /workItem=wi_/);
    assert.equal(batchPrompt.includes('second queued question from all'), true);
    assert.equal(batchPrompt.includes('third queued question from x'), true);
    assert.equal([...finalState.messages, ...finalState.replies].some((record) => record.body === 'batch stdout fallback should be suppressed'), false);
  } finally {
    await server.stop();
    await rm(fakeCodexDir, { recursive: true, force: true });
  }
});

test('scoped stop marks current channel work stopped without stopping queued work in another channel', async () => {
  const fakeCodexDir = await mkdtemp(path.join(os.tmpdir(), 'magclaw-fake-scoped-stop-'));
  const fakeCodexPath = path.join(fakeCodexDir, 'codex-fake.js');
  const logPath = path.join(fakeCodexDir, 'codex-log.jsonl');
  await writeFile(fakeCodexPath, `#!/usr/bin/env node
const fs = require('node:fs');
const logPath = process.env.FAKE_CODEX_LOG;
let buffer = '';
let turnCount = 0;
function log(value) {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify({ pid: process.pid, ...value }) + '\\n');
}
function send(value) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
}
function completeTurn(turnId, text) {
  send({ method: 'turn/started', params: { turn: { id: turnId } } });
  send({ method: 'item/agentMessage/delta', params: { itemId: 'item_' + turnId, delta: text } });
  send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });
}
function handle(message) {
  log({ method: message.method, params: message.params });
  if (message.method === 'initialize') {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: 'thread_fake_scoped_stop' } } });
    return;
  }
  if (message.method === 'thread/resume') {
    send({ id: message.id, result: { thread: { id: message.params.threadId } } });
    return;
  }
  if (message.method === 'turn/start' || message.method === 'turn/steer') {
    const turnId = 'turn_' + (++turnCount);
    const prompt = message.params?.input?.[0]?.text || '';
    send({ id: message.id, result: { turn: { id: turnId } } });
    const isOtherChannel = prompt.includes('other channel must survive');
    setTimeout(() => {
      completeTurn(turnId, isOtherChannel ? 'other channel survived scoped stop' : 'stopped channel should not reply');
    }, isOtherChannel ? 30 : 2000);
  }
}
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (line.trim()) handle(JSON.parse(line));
  }
});
`);
  await chmod(fakeCodexPath, 0o755);
  const server = await startIsolatedServer({
    CODEX_PATH: fakeCodexPath,
    FAKE_CODEX_LOG: logPath,
    MAGCLAW_AGENT_BUSY_DELIVERY_DELAY_MS: '60',
  });
  try {
    const { channel } = await request(server.baseUrl, '/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'x', description: 'other work channel', agentIds: ['agt_codex'] }),
    });

    const stoppedChannel = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({
        body: '<@agt_codex> stopped channel long-running work',
        attachmentIds: [],
      }),
    });

    await waitFor(async () => {
      const entries = await readJsonLines(logPath);
      return entries.some((item) => item.method === 'turn/start');
    }, 3000);

    const otherChannel = await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        body: '<@agt_codex> other channel must survive',
        attachmentIds: [],
      }),
    });

    const stopped = await request(server.baseUrl, '/api/agents/stop-all', {
      method: 'POST',
      body: JSON.stringify({ spaceType: 'channel', spaceId: 'chan_all' }),
    });
    assert.deepEqual(stopped.scope, { spaceType: 'channel', spaceId: 'chan_all', label: '#all' });

    let lastScopedStopSnapshot = null;
    const finalState = await waitFor(async () => {
      const snapshot = await request(server.baseUrl, '/api/state');
      const stoppedReplies = snapshot.replies.filter((reply) => reply.parentMessageId === stoppedChannel.message.id);
      const otherReplies = snapshot.replies.filter((reply) => reply.parentMessageId === otherChannel.message.id);
      const stoppedItem = snapshot.workItems.find((item) => item.sourceMessageId === stoppedChannel.message.id);
      const otherItem = snapshot.workItems.find((item) => item.sourceMessageId === otherChannel.message.id);
      lastScopedStopSnapshot = {
        stoppedReplies: stoppedReplies.map((reply) => reply.body),
        otherReplies: otherReplies.map((reply) => reply.body),
        stoppedItemStatus: stoppedItem?.status,
        otherItemStatus: otherItem?.status,
      };
      return otherReplies.some((reply) => reply.body.includes('other channel survived scoped stop'))
        && !stoppedReplies.some((reply) => reply.body.includes('stopped channel should not reply'))
        && stoppedItem?.status === 'stopped'
        && otherItem?.status === 'responded'
        ? snapshot
        : null;
    }, 8000);

    assert.ok(finalState, JSON.stringify(lastScopedStopSnapshot));
    const stoppedItem = finalState.workItems.find((item) => item.sourceMessageId === stoppedChannel.message.id);
    const otherItem = finalState.workItems.find((item) => item.sourceMessageId === otherChannel.message.id);
    assert.equal(stoppedItem?.status, 'stopped');
    assert.equal(otherItem?.status, 'responded');
  } finally {
    await server.stop();
    await rm(fakeCodexDir, { recursive: true, force: true });
  }
});

test('uploads use year-month folders while project file mentions stay local', async () => {
  const server = await startIsolatedServer();
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'magclaw-project-'));
  try {
    await mkdir(path.join(projectDir, 'notes'), { recursive: true });
    await writeFile(path.join(projectDir, 'notes', 'brief.md'), '# Brief\n\nhello');
    await writeFile(path.join(projectDir, 'README.md'), '# Project\n\nroot');

    const upload = await request(server.baseUrl, '/api/attachments', {
      method: 'POST',
      body: JSON.stringify({
        files: [{
          name: 'clip.png',
          type: 'image/png',
          source: 'clipboard',
          dataUrl: `data:image/png;base64,${Buffer.from('png-data').toString('base64')}`,
        }],
      }),
    });
    assert.equal(upload.attachments.length, 1);
    const uploaded = upload.attachments[0];
    const bucket = `${new Date(uploaded.createdAt).getFullYear()}/${String(new Date(uploaded.createdAt).getMonth() + 1).padStart(2, '0')}`;
    assert.ok(uploaded.relativePath.startsWith(`${bucket}/`));
    assert.match(uploaded.path, new RegExp(`${bucket.replace('/', '\\/')}/att_`));
    assert.equal(uploaded.source, 'clipboard');

    const added = await request(server.baseUrl, '/api/projects', {
      method: 'POST',
      body: JSON.stringify({
        path: projectDir,
        name: 'Spec Project',
        spaceType: 'channel',
        spaceId: 'chan_all',
      }),
    });
    assert.equal(added.project.name, 'Spec Project');

    const search = await request(server.baseUrl, '/api/projects/search?spaceType=channel&spaceId=chan_all&q=brief');
    const brief = search.items.find((item) => item.path === 'notes/brief.md');
    assert.equal(brief?.kind, 'file');
    assert.equal(brief.absolutePath, path.join(projectDir, 'notes', 'brief.md'));

    const encodedPath = encodeURIComponent('notes/brief.md');
    const created = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({
        body: `<#file:${added.project.id}:${encodedPath}> please update the original file`,
        attachmentIds: [],
      }),
    });
    assert.deepEqual(created.message.attachmentIds, []);
    assert.equal(created.message.localReferences.length, 1);
    assert.equal(created.message.localReferences[0].kind, 'file');
    assert.equal(created.message.localReferences[0].path, 'notes/brief.md');
    assert.equal(created.message.localReferences[0].absolutePath, path.join(projectDir, 'notes', 'brief.md'));

    const finalState = await request(server.baseUrl, '/api/state');
    assert.equal(finalState.attachments.length, 1);

    const rootTree = await request(server.baseUrl, `/api/projects/${added.project.id}/tree`);
    assert.equal(rootTree.project.id, added.project.id);
    assert.equal(rootTree.path, '');
    assert.equal(rootTree.entries.find((item) => item.path === 'notes')?.kind, 'folder');
    assert.equal(rootTree.entries.find((item) => item.path === 'README.md')?.kind, 'file');

    const notesTree = await request(server.baseUrl, `/api/projects/${added.project.id}/tree?path=notes`);
    assert.equal(notesTree.entries.find((item) => item.path === 'notes/brief.md')?.kind, 'file');

    const preview = await request(server.baseUrl, `/api/projects/${added.project.id}/file?path=${encodeURIComponent('notes/brief.md')}`);
    assert.equal(preview.file.path, 'notes/brief.md');
    assert.equal(preview.file.previewKind, 'markdown');
    assert.equal(preview.file.content, '# Brief\n\nhello');
  } finally {
    await server.stop();
    await rm(projectDir, { recursive: true, force: true });
  }
});
