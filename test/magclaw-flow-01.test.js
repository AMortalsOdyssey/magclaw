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

test('project folder picker adds the selected local folder without typing a path', async () => {
  const projectDir = await mkdtemp(path.join(os.tmpdir(), 'magclaw-picked-project-'));
  const server = await startIsolatedServer({ MAGCLAW_PICK_FOLDER_PATH: projectDir });
  try {
    await writeFile(path.join(projectDir, 'README.md'), '# Picked\n');

    const picked = await request(server.baseUrl, '/api/projects/pick-folder', {
      method: 'POST',
      body: JSON.stringify({
        spaceType: 'channel',
        spaceId: 'chan_all',
      }),
    });

    assert.equal(picked.canceled, false);
    assert.equal(picked.project.path, projectDir);
    assert.equal(picked.project.spaceId, 'chan_all');
    assert.ok(picked.projects.some((project) => project.path === projectDir));
  } finally {
    await server.stop();
    await rm(projectDir, { recursive: true, force: true });
  }
});

test('save endpoint toggles both channel messages and thread replies', async () => {
  const server = await startIsolatedServer();
  try {
    const created = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({ body: 'Saveable parent message' }),
    });
    const replied = await request(server.baseUrl, `/api/messages/${created.message.id}/replies`, {
      method: 'POST',
      body: JSON.stringify({ body: 'Saveable thread reply' }),
    });

    const savedParent = await request(server.baseUrl, `/api/messages/${created.message.id}/save`, { method: 'POST', body: '{}' });
    const savedReply = await request(server.baseUrl, `/api/messages/${replied.reply.id}/save`, { method: 'POST', body: '{}' });

    assert.ok(savedParent.message.savedBy.includes('hum_local'));
    assert.ok(savedReply.message.savedBy.includes('hum_local'));

    const state = await request(server.baseUrl, '/api/state');
    assert.ok(state.messages.find((message) => message.id === created.message.id)?.savedBy.includes('hum_local'));
    assert.ok(state.replies.find((reply) => reply.id === replied.reply.id)?.savedBy.includes('hum_local'));
  } finally {
    await server.stop();
  }
});

test('inbox read endpoint marks agent messages and replies while leaving workspace activity local', async () => {
  const server = await startIsolatedServer();
  try {
    const agentMessage = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({
        authorType: 'agent',
        authorId: 'agt_codex',
        body: 'Unread top-level agent note',
      }),
    });
    const parent = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({ body: 'Human thread parent' }),
    });
    const agentReply = await request(server.baseUrl, `/api/messages/${parent.message.id}/replies`, {
      method: 'POST',
      body: JSON.stringify({
        authorType: 'agent',
        authorId: 'agt_codex',
        body: 'Unread agent reply',
      }),
    });

    assert.deepEqual(agentMessage.message.readBy, []);
    assert.deepEqual(agentReply.reply.readBy, []);

    const readAt = new Date().toISOString();
    await request(server.baseUrl, '/api/inbox/read', {
      method: 'POST',
      body: JSON.stringify({
        recordIds: [agentMessage.message.id, agentReply.reply.id],
        workspaceActivityReadAt: readAt,
      }),
    });

    const state = await request(server.baseUrl, '/api/state');
    assert.ok(state.messages.find((message) => message.id === agentMessage.message.id)?.readBy.includes('hum_local'));
    assert.ok(state.replies.find((reply) => reply.id === agentReply.reply.id)?.readBy.includes('hum_local'));
    assert.equal(state.inboxReads.hum_local.workspaceActivityReadAt, undefined);
  } finally {
    await server.stop();
  }
});

test('dm thread replies dispatch to the private agent for pickup receipts', async () => {
  const server = await startIsolatedServer();
  try {
    const { dm } = await request(server.baseUrl, '/api/dms', {
      method: 'POST',
      body: JSON.stringify({ participantId: 'agt_codex' }),
    });
    const parent = await request(server.baseUrl, `/api/spaces/dm/${dm.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        authorType: 'agent',
        authorId: 'agt_codex',
        body: 'Private parent from the agent',
        attachmentIds: [],
      }),
    });
    const reply = await request(server.baseUrl, `/api/messages/${parent.message.id}/replies`, {
      method: 'POST',
      body: JSON.stringify({
        body: '继续看一下这个私聊 thread',
        attachmentIds: [],
      }),
    });

    const finalState = await waitFor(async () => {
      const snapshot = await request(server.baseUrl, '/api/state');
      const workItem = snapshot.workItems.find((item) => (
        item.sourceMessageId === reply.reply.id
        && item.parentMessageId === parent.message.id
        && item.spaceType === 'dm'
        && item.spaceId === dm.id
        && item.agentId === 'agt_codex'
      ));
      return workItem ? snapshot : null;
    }, 4000);

    const workItem = finalState.workItems.find((item) => item.sourceMessageId === reply.reply.id);
    assert.equal(workItem.agentId, 'agt_codex');
    assert.equal(workItem.target, `dm:${dm.id}:${parent.message.id}`);
  } finally {
    await server.stop();
  }
});

test('chat and task records are persisted in SQLite without a JSON state file by default', async (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    t.skip('Node built-in SQLite is unavailable in this runtime');
    return;
  }

  const server = await startIsolatedServer();
  try {
    const created = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({
        body: '<@agt_codex> 请把这个保存成任务',
        attachmentIds: [],
        asTask: true,
      }),
    });
    await request(server.baseUrl, `/api/messages/${created.message.id}/save`, { method: 'POST', body: '{}' });

    const apiState = await request(server.baseUrl, '/api/state');
    assert.ok(apiState.messages.some((message) => message.id === created.message.id));
    assert.ok(apiState.tasks.some((task) => task.id === created.task.id));
    assert.ok(apiState.messages.find((message) => message.id === created.message.id)?.savedBy.includes('hum_local'));

    await assert.rejects(
      () => readFile(path.join(server.tmp, '.magclaw', 'state.json'), 'utf8'),
      /ENOENT/,
    );

    await lstat(path.join(server.tmp, '.magclaw', 'state.sqlite'));
    const db = new DatabaseSync(path.join(server.tmp, '.magclaw', 'state.sqlite'));
    try {
      const messages = db.prepare("SELECT COUNT(*) AS count FROM state_records WHERE kind = 'messages'").get();
      const tasks = db.prepare("SELECT COUNT(*) AS count FROM state_records WHERE kind = 'tasks'").get();
      const snapshot = db.prepare("SELECT COUNT(*) AS count FROM state_records WHERE kind = '__state' AND id = 'snapshot'").get();
      assert.ok(Number(messages.count) >= 2);
      assert.ok(Number(tasks.count) >= 1);
      assert.equal(Number(snapshot.count), 1);
    } finally {
      db.close();
    }
  } finally {
    await server.stop();
  }
});

test('new channels leave agent members optional and selected members fan out like MagClaw', async () => {
  const server = await startIsolatedServer();
  try {
    const { agent: alice } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Alice', description: 'Knowledge system helper', runtime: 'Codex CLI' }),
    });
    const { agent: cindy } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Cindy', description: 'Onboarding helper', runtime: 'Codex CLI' }),
    });
    const { agent: offline } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'OfflineAgent', description: 'Unavailable helper', runtime: 'Codex CLI' }),
    });
    await request(server.baseUrl, `/api/agents/${offline.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'offline' }),
    });

    const { channel } = await request(server.baseUrl, '/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'hello-room', description: 'casual room' }),
    });
    assert.deepEqual(channel.agentIds, []);

    const explicitEmpty = await request(server.baseUrl, '/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'manual-empty', description: 'explicit empty channel', agentIds: [] }),
    });
    assert.deepEqual(explicitEmpty.channel.agentIds, []);

    const selected = await request(server.baseUrl, '/api/channels', {
      method: 'POST',
      body: JSON.stringify({
        name: 'selected-hello-room',
        description: 'manual member channel',
        agentIds: [alice.id, cindy.id, offline.id],
      }),
    });
    assert.deepEqual(selected.channel.agentIds.sort(), [alice.id, cindy.id, offline.id].sort());

    const created = await request(server.baseUrl, `/api/spaces/channel/${selected.channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: '大家好', attachmentIds: [] }),
    });
    const deliveredAgentIds = await waitFor(async () => {
      const snapshot = await request(server.baseUrl, '/api/state');
      const ids = snapshot.workItems
        .filter((item) => item.sourceMessageId === created.message.id)
        .map((item) => item.agentId)
        .sort();
      return ids.length >= 2 ? ids : null;
    });
    assert.deepEqual(deliveredAgentIds, [alice.id, cindy.id].sort());
  } finally {
    await server.stop();
  }
});

test('Codex agents never persist the unsupported default model sentinel', async () => {
  const server = await startIsolatedServer({ CODEX_MODEL: '' });
  try {
    const { agent } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'ModelSafe', runtime: 'Codex CLI' }),
    });
    assert.notEqual(agent.model.toLowerCase(), 'default');

    const patched = await request(server.baseUrl, `/api/agents/${agent.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ model: 'default' }),
    });
    assert.notEqual(patched.agent.model.toLowerCase(), 'default');
  } finally {
    await server.stop();
  }
});

test('stale runtime statuses reset to idle when the local server restarts', async () => {
  let server = await startIsolatedServer({ MAGCLAW_WRITE_STATE_JSON: '1' });
  const tmp = server.tmp;
  let cleaned = false;
  try {
    const patched = await request(server.baseUrl, '/api/agents/agt_codex', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'error' }),
    });
    assert.equal(patched.agent.status, 'error');
    const { agent: idleStale } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Idle Stale', description: 'stale live activity', runtime: 'Codex CLI' }),
    });

    await server.stop({ keepTmp: true });
    const stateFile = path.join(tmp, '.magclaw', 'state.json');
    const savedState = JSON.parse(await readFile(stateFile, 'utf8'));
    const savedAgent = savedState.agents.find((agent) => agent.id === 'agt_codex');
    savedAgent.activeWorkItemIds = ['wi_stale'];
    savedAgent.runtimeActivity = {
      activity: 'working',
      detail: 'Old stuck turn',
      activeTurnIds: ['turn_stale'],
      pendingToolCalls: [{ id: 'tool_stale', name: '', workItemId: 'wi_stale' }],
    };
    const savedIdleStale = savedState.agents.find((agent) => agent.id === idleStale.id);
    savedIdleStale.activeWorkItemIds = ['wi_idle_stale'];
    savedIdleStale.runtimeActivity = {
      activity: 'working',
      detail: 'Old idle live marker',
      activeTurnIds: ['turn_idle_stale'],
    };
    await writeFile(stateFile, JSON.stringify(savedState, null, 2));
    server = await launchIsolatedServer(tmp, { MAGCLAW_WRITE_STATE_JSON: '1' });

    const state = await request(server.baseUrl, '/api/state');
    const agent = state.agents.find((item) => item.id === 'agt_codex');
    assert.equal(agent?.status, 'idle');
    assert.deepEqual(agent?.activeWorkItemIds, []);
    assert.equal(agent?.runtimeActivity, null);
    const idleRecovered = state.agents.find((item) => item.id === idleStale.id);
    assert.equal(idleRecovered?.status, 'idle');
    assert.deepEqual(idleRecovered?.activeWorkItemIds, []);
    assert.equal(idleRecovered?.runtimeActivity, null);
    await server.stop();
    cleaned = true;
  } finally {
    if (!cleaned) {
      try {
        await server?.stop?.({ keepTmp: true });
      } catch {
        // ignore cleanup races in failed restart assertions
      }
      await rm(tmp, { recursive: true, force: true });
    }
  }
});

test('status changes publish an immediate heartbeat without waiting for the interval', async () => {
  const server = await startIsolatedServer({ MAGCLAW_STATE_HEARTBEAT_MS: '10000' });
  const controller = new AbortController();
  const response = await fetch(`${server.baseUrl}/api/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    await readSseEventFromReader(reader, decoder, 'heartbeat');
    await request(server.baseUrl, '/api/agents/agt_codex', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'working' }),
    });
    const heartbeat = await readSseEventFromReader(reader, decoder, 'heartbeat', 600);
    assert.equal(heartbeat.agents.find((agent) => agent.id === 'agt_codex')?.status, 'working');
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
    await server.stop();
  }
});

test('activity probe resets stale busy status when the local app-server is idle', async () => {
  const fakeCodexDir = await mkdtemp(path.join(os.tmpdir(), 'magclaw-fake-probe-idle-'));
  const fakeCodexPath = path.join(fakeCodexDir, 'codex-fake.js');
  const logPath = path.join(fakeCodexDir, 'codex-log.jsonl');
  await writeFile(fakeCodexPath, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const logPath = process.env.FAKE_CODEX_LOG;
function log(value) {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(value) + '\\n');
}
if (args[0] === 'app-server') {
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
      send({ id: message.id, result: { thread: { id: 'thread_probe_idle' } } });
      return;
    }
    if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'turn_probe_idle' } } });
      send({ method: 'turn/started', params: { turn: { id: 'turn_probe_idle' } } });
      setTimeout(() => {
        send({ method: 'item/agentMessage/delta', params: { itemId: 'item_probe_idle', delta: 'probe idle complete' } });
        send({ method: 'turn/completed', params: { turn: { id: 'turn_probe_idle', status: 'completed' } } });
      }, 40);
    }
  }
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
    MAGCLAW_STATE_HEARTBEAT_MS: '50',
  });
  try {
    await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({ body: '<@agt_codex> complete and stay warm', attachmentIds: [] }),
    });
    await waitFor(async () => {
      const state = await request(server.baseUrl, '/api/state');
      return state.agents.find((agent) => agent.id === 'agt_codex')?.status === 'idle' ? state : null;
    }, 4000);
    await request(server.baseUrl, '/api/agents/agt_codex', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'working' }),
    });
    const recovered = await waitFor(async () => {
      const state = await request(server.baseUrl, '/api/state');
      const agent = state.agents.find((item) => item.id === 'agt_codex');
      return agent?.status === 'idle' && state.events.some((event) => event.type === 'agent_status_probe_recovered' && event.agentId === 'agt_codex') ? state : null;
    }, 2500);
    assert.ok(recovered);
  } finally {
    await server.stop();
    await rm(fakeCodexDir, { recursive: true, force: true });
  }
});

test('MagClaw-style message task stores mentions, channel task number, assignees, and thread end intent', async () => {
  const server = await startIsolatedServer();
  try {
    const { channel } = await request(server.baseUrl, '/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'x', description: 'test channel', agentIds: [] }),
    });

    const created = await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        body: '<@agt_codex> 请做一版 MagClaw thread 复刻',
        asTask: true,
        attachmentIds: [],
      }),
    });

    assert.deepEqual(created.message.mentionedAgentIds, ['agt_codex']);
    assert.deepEqual(created.message.mentionedHumanIds, []);
    assert.deepEqual(created.message.readBy, ['hum_local']);
    assert.equal(created.task.number, 1);
    assert.deepEqual(created.task.assigneeIds, ['agt_codex']);
    assert.equal(created.task.sourceMessageId, created.message.id);

    await request(server.baseUrl, `/api/tasks/${created.task.id}/claim`, {
      method: 'POST',
      body: JSON.stringify({ actorId: 'agt_codex' }),
    });
    await request(server.baseUrl, `/api/tasks/${created.task.id}/request-review`, {
      method: 'POST',
      body: '{}',
    });

    const reply = await request(server.baseUrl, `/api/messages/${created.message.id}/replies`, {
      method: 'POST',
      body: JSON.stringify({
        body: '把这个任务结束',
        attachmentIds: ['att_demo'],
      }),
    });
    assert.deepEqual(reply.reply.attachmentIds, ['att_demo']);
    assert.deepEqual(reply.reply.readBy, ['hum_local']);
    assert.equal(reply.reply.spaceType, 'channel');
    assert.equal(reply.reply.spaceId, channel.id);

    const finalState = await request(server.baseUrl, '/api/state');
    const task = finalState.tasks.find((item) => item.id === created.task.id);
    assert.equal(task.status, 'done');
    assert.match(task.endIntentAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(task.history.some((item) => item.type === 'ended_from_thread'));
  } finally {
    await server.stop();
  }
});

test('thread task creation immediately dispatches the claimed task thread to the agent', async () => {
  const fakeCodexDir = await mkdtemp(path.join(os.tmpdir(), 'magclaw-fake-thread-task-'));
  const fakeCodexPath = path.join(fakeCodexDir, 'codex-fake.js');
  const logPath = path.join(fakeCodexDir, 'codex-log.jsonl');
  await writeFile(fakeCodexPath, `#!/usr/bin/env node
const fs = require('node:fs');
const logPath = process.env.FAKE_CODEX_LOG;
let buffer = '';
let turnCount = 0;
function log(value) {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify({ ...value }) + '\\n');
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
    send({ id: message.id, result: { thread: { id: 'thread_fake_task_dispatch' } } });
    return;
  }
  if (message.method === 'thread/resume') {
    send({ id: message.id, result: { thread: { id: message.params.threadId } } });
    return;
  }
  if (message.method === 'turn/start' || message.method === 'turn/steer') {
    const turnId = 'turn_' + (++turnCount);
    const prompt = message.params?.input?.[0]?.text || '';
    log({ prompt });
    send({ id: message.id, result: { turn: { id: turnId } } });
    setTimeout(() => completeTurn(turnId, '广州出发建议优先选高铁可达的近郊或错峰路线，避开热门高速。'), 30);
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
  });
  try {
    const { channel } = await request(server.baseUrl, '/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'thread-task-dispatch', description: 'task dispatch', agentIds: ['agt_codex'] }),
    });
    const parent = await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        body: '五一出行讨论背景',
        attachmentIds: [],
      }),
    });

    const created = await request(server.baseUrl, `/api/messages/${parent.message.id}/replies`, {
      method: 'POST',
      body: JSON.stringify({
        body: '开启一个 task，调研下从广州出发，走哪里不会堵车<@agt_codex>',
        attachmentIds: [],
      }),
    });
    assert.equal(created.createdTask.title, '调研下从广州出发，走哪里不会堵车');
    assert.equal(created.createdTask.status, 'in_progress');
    assert.equal(created.createdTask.claimedBy, 'agt_codex');

    const finalState = await waitFor(async () => {
      const snapshot = await request(server.baseUrl, '/api/state');
      const replies = snapshot.replies.filter((reply) => reply.parentMessageId === created.createdTaskMessage.id);
      const workItem = snapshot.workItems.find((item) => (
        item.agentId === 'agt_codex'
        && item.sourceMessageId === created.createdTaskMessage.id
        && item.parentMessageId === created.createdTaskMessage.id
      ));
      return workItem?.status === 'responded'
        && replies.some((reply) => reply.body.includes('广州出发建议'))
        ? snapshot
        : null;
    }, 8000);

    assert.ok(finalState);
    const workItem = finalState.workItems.find((item) => item.sourceMessageId === created.createdTaskMessage.id);
    assert.equal(workItem.target, `#${channel.name}:${created.createdTaskMessage.id}`);
    assert.equal(workItem.taskId, created.createdTask.id);
    const entries = await readJsonLines(logPath);
    const promptEntry = entries.find((item) => item.prompt?.includes('Task #1 has been created and claimed for you.'));
    assert.ok(promptEntry);
    assert.match(promptEntry.prompt, /Title: 调研下从广州出发，走哪里不会堵车/);
    assert.match(promptEntry.prompt, /Trigger reply:/);
  } finally {
    await server.stop();
    await rm(fakeCodexDir, { recursive: true, force: true });
  }
});

test('thread stop intent marks that task done and lets other queued work continue', async () => {
  const fakeCodexDir = await mkdtemp(path.join(os.tmpdir(), 'magclaw-fake-thread-stop-'));
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
process.on('SIGTERM', () => {
  log({ signal: 'SIGTERM' });
  process.exit(143);
});
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
    send({ id: message.id, result: { thread: { id: 'thread_fake_thread_stop_' + process.pid } } });
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
    const isOtherWork = prompt.includes('other task must continue');
    setTimeout(() => {
      completeTurn(turnId, isOtherWork ? 'other task survived thread stop' : 'stopped task should not reply');
    }, isOtherWork ? 30 : 2000);
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
      body: JSON.stringify({ name: 'thread-stop-other', description: 'surviving work channel', agentIds: ['agt_codex'] }),
    });

    const taskMessage = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({
        body: '<@agt_codex> 请做一个长任务',
        asTask: true,
        attachmentIds: [],
      }),
    });
    assert.ok(taskMessage.task?.id);

    await waitFor(async () => {
      const entries = await readJsonLines(logPath);
      return entries.some((item) => item.method === 'turn/start');
    }, 3000);

    const otherMessage = await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        body: '<@agt_codex> other task must continue',
        attachmentIds: [],
      }),
    });

    const stopped = await request(server.baseUrl, `/api/messages/${taskMessage.message.id}/replies`, {
      method: 'POST',
      body: JSON.stringify({
        body: '停掉这个任务',
        attachmentIds: [],
      }),
    });
    assert.equal(stopped.stoppedTask.status, 'done');

    const finalState = await waitFor(async () => {
      const snapshot = await request(server.baseUrl, '/api/state');
      const taskReplies = snapshot.replies.filter((reply) => reply.parentMessageId === taskMessage.message.id);
      const otherReplies = snapshot.replies.filter((reply) => reply.parentMessageId === otherMessage.message.id);
      const agent = snapshot.agents.find((item) => item.id === 'agt_codex');
      return otherReplies.some((reply) => reply.body.includes('other task survived thread stop'))
        && !taskReplies.some((reply) => reply.body.includes('stopped task should not reply'))
        && agent?.status === 'idle'
        ? snapshot
        : null;
    }, 8000);

    assert.ok(finalState);
    const task = finalState.tasks.find((item) => item.id === taskMessage.task.id);
    assert.equal(task.status, 'done');
    assert.match(task.completedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(task.history.some((item) => item.type === 'stopped_done_from_thread'));
    const taskReplies = finalState.replies.filter((reply) => reply.parentMessageId === taskMessage.message.id);
    assert.ok(taskReplies.some((reply) => reply.body === 'Task marked done from thread stop request.'));
    const stoppedItem = finalState.workItems.find((item) => item.sourceMessageId === taskMessage.message.id);
    const otherItem = finalState.workItems.find((item) => item.sourceMessageId === otherMessage.message.id);
    assert.equal(stoppedItem?.status, 'stopped');
    assert.equal(otherItem?.status, 'responded');
    const entries = await readJsonLines(logPath);
    assert.equal(entries.some((item) => item.signal === 'SIGTERM'), false);
    assert.equal(entries.some((item) => item.method === 'turn/steer'), true);
    const pids = new Set(entries
      .filter((item) => item.method === 'turn/start' || item.method === 'turn/steer')
      .map((item) => item.pid));
    assert.equal(pids.size, 1);
  } finally {
    await server.stop();
    await rm(fakeCodexDir, { recursive: true, force: true });
  }
});

test('thread replies route to participant agents and natural names select one agent', async () => {
  const server = await startIsolatedServer();
  try {
    const { agent: cindy } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Cindy', description: 'Onboarding Assistant', runtime: 'Codex CLI' }),
    });
    const { agent: cc } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'cc', description: 'Helper', runtime: 'Codex CLI' }),
    });
    const { channel } = await request(server.baseUrl, '/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'multi-agent-thread', description: 'thread routing', agentIds: [cindy.id, cc.id] }),
    });
    const parent = await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        body: '我有一个想法，帮我一起看看',
        attachmentIds: [],
      }),
    });

    await request(server.baseUrl, `/api/messages/${parent.message.id}/replies`, {
      method: 'POST',
      body: JSON.stringify({
        authorType: 'agent',
        authorId: cindy.id,
        body: '我可以先判断这个想法适合什么工作流。',
        attachmentIds: [],
      }),
    });
    await request(server.baseUrl, `/api/messages/${parent.message.id}/replies`, {
      method: 'POST',
      body: JSON.stringify({
        authorType: 'agent',
        authorId: cc.id,
        body: '我也可以帮你拆一下。',
        attachmentIds: [],
      }),
    });

    const named = await request(server.baseUrl, `/api/messages/${parent.message.id}/replies`, {
      method: 'POST',
      body: JSON.stringify({
        body: 'Cindy，你说的对',
        attachmentIds: [],
      }),
    });
    const namedState = await request(server.baseUrl, '/api/state');
    const namedWork = namedState.workItems.filter((item) => item.sourceMessageId === named.reply.id);
    assert.deepEqual(namedWork.map((item) => item.agentId), [cindy.id]);

    const broad = await request(server.baseUrl, `/api/messages/${parent.message.id}/replies`, {
      method: 'POST',
      body: JSON.stringify({
        body: '继续这个任务',
        attachmentIds: [],
      }),
    });
    const broadState = await request(server.baseUrl, '/api/state');
    const broadAgentIds = broadState.workItems
      .filter((item) => item.sourceMessageId === broad.reply.id)
      .map((item) => item.agentId)
      .sort();
    assert.deepEqual(broadAgentIds, [cc.id, cindy.id].sort());
  } finally {
    await server.stop();
  }
});

test('thread replies addressed to the parent author do not wake named contextual agents', async () => {
  const server = await startIsolatedServer();
  const mock = await startMockFanoutApi(() => ({
    mode: 'directed',
    targetAgentIds: [],
    confidence: 0.1,
    reason: 'should not be called for direct parent thread replies',
  }));
  try {
    const { agent: nangong } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: '南宫婉', description: '温柔的出行建议助手', runtime: 'Codex CLI' }),
    });
    const { agent: hanli } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: '韩立', description: '谨慎的同行者', runtime: 'Codex CLI' }),
    });
    await request(server.baseUrl, '/api/settings/fanout', {
      method: 'POST',
      body: JSON.stringify({
        enabled: true,
        baseUrl: `${mock.baseUrl}/v1`,
        apiKey: 'thread-parent-key',
        model: 'thread-parent-router',
      }),
    });
    const { channel } = await request(server.baseUrl, '/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'parent-address', description: 'parent thread routing', agentIds: [nangong.id, hanli.id] }),
    });
    const parent = await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        authorType: 'agent',
        authorId: nangong.id,
        body: '是呀，五一的广州肯定挤得像开了副本一样。',
        attachmentIds: [],
      }),
    });

    const reply = await request(server.baseUrl, `/api/messages/${parent.message.id}/replies`, {
      method: 'POST',
      body: JSON.stringify({
        body: '是的，我也感觉，不知道你和韩立去哪里玩了',
        attachmentIds: [],
      }),
    });

    assert.equal(reply.route.strategy, 'rules');
    assert.equal(reply.route.llmUsed, false);
    assert.equal(reply.route.mode, 'directed');
    assert.deepEqual(reply.route.targetAgentIds, [nangong.id]);
    assert.equal(mock.calls.length, 0);

    const delivered = await waitFor(async () => {
      const snapshot = await request(server.baseUrl, '/api/state');
      const ids = snapshot.workItems
        .filter((item) => item.sourceMessageId === reply.reply.id)
        .map((item) => item.agentId)
        .sort();
      return ids.length ? ids : null;
    });
    assert.deepEqual(delivered, [nangong.id]);
  } finally {
    await server.stop();
    await mock.stop();
  }
});

test('task APIs create top-level task messages and reject direct reply-as-task payloads', async () => {
  const server = await startIsolatedServer();
  try {
    const parent = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({
        body: '<@agt_codex> 我有一个新想法',
        attachmentIds: [],
      }),
    });
    const reply = await request(server.baseUrl, `/api/messages/${parent.message.id}/replies`, {
      method: 'POST',
      body: JSON.stringify({
        body: '这个想法先放在 thread 里继续讨论',
        attachmentIds: [],
      }),
    });

    const rejected = await fetch(`${server.baseUrl}/api/messages/${parent.message.id}/replies`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        body: '这条 reply 不能直接变 task',
        asTask: true,
      }),
    });
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /Thread replies cannot become tasks/i);

    const manual = await request(server.baseUrl, '/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: '梳理并落地这个新想法的方案',
        body: '从 thread 里提升出来的新任务',
        spaceType: 'channel',
        spaceId: 'chan_all',
        assigneeId: 'agt_codex',
        sourceMessageId: parent.message.id,
        sourceReplyId: reply.reply.id,
      }),
    });
    assert.equal(manual.task.number, 1);
    assert.equal(manual.task.sourceMessageId, parent.message.id);
    assert.equal(manual.task.sourceReplyId, reply.reply.id);
    assert.equal(manual.message.authorType, 'human');
    assert.equal(manual.message.authorId, 'hum_local');
    assert.equal(manual.message.body, '梳理并落地这个新想法的方案');
    assert.equal(manual.message.taskId, manual.task.id);
    assert.equal(manual.task.messageId, manual.message.id);
    assert.equal(manual.task.threadMessageId, manual.message.id);

    const created = await request(server.baseUrl, '/api/agent-tools/tasks', {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agt_codex',
        channel: '#all',
        claim: true,
        sourceMessageId: parent.message.id,
        sourceReplyId: reply.reply.id,
        tasks: [{ title: '实现多 Agent task 编排' }],
      }),
    });
    assert.equal(created.tasks.length, 1);
    assert.equal(created.tasks[0].taskNumber, 2);
    assert.match(created.tasks[0].threadTarget, /^#all:msg_/);
    assert.equal(created.tasks[0].task.status, 'in_progress');
    assert.equal(created.tasks[0].task.createdBy, 'agt_codex');
    assert.equal(created.tasks[0].task.claimedBy, 'agt_codex');

    const finalState = await request(server.baseUrl, '/api/state');
    const task = finalState.tasks.find((item) => item.id === created.tasks[0].task.id);
    const taskMessage = finalState.messages.find((message) => message.id === task.messageId);
    assert.equal(taskMessage.authorType, 'agent');
    assert.equal(taskMessage.authorId, 'agt_codex');
    assert.equal(taskMessage.body, '实现多 Agent task 编排');
    assert.equal(taskMessage.taskId, task.id);
    assert.ok(finalState.messages.some((message) => message.eventType === 'task_created' && message.body.includes('1 new task created: #2')));
    assert.ok(finalState.messages.some((message) => message.eventType === 'task_claimed' && message.body.includes('Codex Local claimed #2')));
    assert.ok(finalState.replies.some((item) => item.parentMessageId === task.messageId && item.body.includes('Task claimed by Codex Local.')));
  } finally {
    await server.stop();
  }
});

test('work-like channel messages are auto-claimed as top-level tasks', async () => {
  const server = await startIsolatedServer();
  try {
    const created = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({
        body: '谁去帮忙修复登录 bug 并跑一下回归测试',
        attachmentIds: [],
      }),
    });

    assert.ok(created.task);
    assert.equal(created.message.taskId, created.task.id);
    assert.equal(created.task.messageId, created.message.id);
    assert.equal(created.task.status, 'in_progress');
    assert.equal(created.task.claimedBy, 'agt_codex');
    assert.deepEqual(created.task.assigneeIds, ['agt_codex']);

    const finalState = await request(server.baseUrl, '/api/state');
    const task = finalState.tasks.find((item) => item.id === created.task.id);
    const message = finalState.messages.find((item) => item.id === created.message.id);
    assert.equal(task.title, '谁去帮忙修复登录 bug 并跑一下回归测试');
    assert.equal(message.taskId, task.id);
    assert.ok(finalState.messages.some((item) => item.eventType === 'task_claimed' && item.body.includes('Codex Local claimed')));
    assert.ok(finalState.replies.some((item) => item.parentMessageId === created.message.id && item.body.includes('Task claimed by Codex Local.')));
  } finally {
    await server.stop();
  }
});

test('quick lookup channel messages start a thread response without auto-creating a task', async () => {
  const server = await startIsolatedServer();
  try {
    const created = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({
        body: '谁去帮忙给我查一下广州未来 10 天的天气情况',
        attachmentIds: [],
      }),
    });

    assert.equal(created.task, null);
    assert.equal(created.message.taskId || null, null);

    const finalState = await request(server.baseUrl, '/api/state');
    const message = finalState.messages.find((item) => item.id === created.message.id);
    assert.equal(message.taskId || null, null);
    assert.equal(finalState.tasks.some((task) => task.messageId === created.message.id), false);
  } finally {
    await server.stop();
  }
});

test('thread task intent creates an agent-authored top-level task message linked to the source reply', async () => {
  const server = await startIsolatedServer();
  try {
    const parent = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({
        body: '<@agt_codex> 我有一个想法，帮我一起梳理多 agent 协作方案',
        attachmentIds: [],
      }),
    });

    const reply = await request(server.baseUrl, `/api/messages/${parent.message.id}/replies`, {
      method: 'POST',
      body: JSON.stringify({
        body: '创建一个 task',
        attachmentIds: [],
      }),
    });

    assert.ok(reply.createdTask);
    assert.equal(reply.createdTask.sourceMessageId, parent.message.id);
    assert.equal(reply.createdTask.sourceReplyId, reply.reply.id);
    assert.equal(reply.createdTask.status, 'in_progress');
    assert.equal(reply.createdTask.claimedBy, 'agt_codex');
    assert.equal(reply.createdTaskMessage.authorType, 'agent');
    assert.equal(reply.createdTaskMessage.authorId, 'agt_codex');
    assert.equal(reply.createdTaskMessage.taskId, reply.createdTask.id);

    const finalState = await request(server.baseUrl, '/api/state');
    const task = finalState.tasks.find((item) => item.id === reply.createdTask.id);
    const taskMessage = finalState.messages.find((item) => item.id === task.messageId);
    assert.equal(taskMessage.authorType, 'agent');
    assert.equal(taskMessage.authorId, 'agt_codex');
    assert.equal(taskMessage.taskId, task.id);
    assert.ok(finalState.replies.some((item) => item.parentMessageId === parent.message.id && item.authorId === 'agt_codex' && item.body.includes(`#${task.number}`)));
    assert.ok(finalState.messages.some((item) => item.eventType === 'task_created' && item.body.includes(`1 new task created: #${task.number}`)));
    assert.ok(finalState.messages.some((item) => item.eventType === 'task_claimed' && item.body.includes(`Codex Local claimed #${task.number}`)));
  } finally {
    await server.stop();
  }
});

test('top-level channel messages fan out to members unless directed or task-like', async () => {
  const server = await startIsolatedServer();
  try {
    const { agent: github } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'CCC', description: 'GitHub repo, issue, pull request, CI/CD helper', runtime: 'Codex CLI' }),
    });
    const { agent: design } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Ziling', description: 'Visual design and writing helper', runtime: 'Codex CLI' }),
    });
    const { agent: sleeper } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'sleepy', description: 'Offline helper', runtime: 'Codex CLI' }),
    });
    await request(server.baseUrl, `/api/agents/${sleeper.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'offline' }),
    });
    const { channel } = await request(server.baseUrl, '/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'dispatch', description: 'targeted routing', agentIds: [github.id, design.id, sleeper.id] }),
    });

    const created = await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        body: '谁的学历高？',
        attachmentIds: [],
      }),
    });

    const deliveredAgentIds = await waitFor(async () => {
      const snapshot = await request(server.baseUrl, '/api/state');
      const ids = snapshot.workItems
        .filter((item) => item.sourceMessageId === created.message.id)
        .map((item) => item.agentId)
        .sort();
      return ids.length >= 2 ? ids : null;
    });
    assert.deepEqual(deliveredAgentIds, [github.id, design.id].sort());

    const directed = await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        body: 'CCC 你知道 GitHub 吗',
        attachmentIds: [],
      }),
    });
    const directedDeliveredAgentIds = await waitFor(async () => {
      const snapshot = await request(server.baseUrl, '/api/state');
      const ids = snapshot.workItems
        .filter((item) => item.sourceMessageId === directed.message.id)
        .map((item) => item.agentId)
        .sort();
      return ids.length >= 1 ? ids : null;
    });
    assert.deepEqual(directedDeliveredAgentIds, [github.id]);

    const { agent: availableA } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Available A', description: 'Idle helper', runtime: 'Codex CLI' }),
    });
    const { agent: availableB } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Available B', description: 'Idle helper', runtime: 'Codex CLI' }),
    });
    const { agent: offlineAvailable } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Offline Available', description: 'Not available', runtime: 'Codex CLI' }),
    });
    await request(server.baseUrl, `/api/agents/${offlineAvailable.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'offline' }),
    });
    const { channel: availabilityChannel } = await request(server.baseUrl, '/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'availability', description: 'availability routing', agentIds: [availableA.id, availableB.id, offlineAvailable.id] }),
    });
    const available = await request(server.baseUrl, `/api/spaces/channel/${availabilityChannel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        body: '大家谁今天有空',
        attachmentIds: [],
      }),
    });
    const availabilityDeliveredAgentIds = await waitFor(async () => {
      const snapshot = await request(server.baseUrl, '/api/state');
      const ids = snapshot.workItems
        .filter((item) => item.sourceMessageId === available.message.id)
        .map((item) => item.agentId)
        .sort();
      return ids.length >= 2 ? ids : null;
    });
    assert.deepEqual(availabilityDeliveredAgentIds, [availableA.id, availableB.id].sort());
    const availabilityState = await request(server.baseUrl, '/api/state');
    assert.equal(availabilityState.tasks.some((task) => task.messageId === available.message.id), false);
  } finally {
    await server.stop();
  }
});

test('contextual human follow-up stays with the recently focused agent', async () => {
  const server = await startIsolatedServer();
  try {
    const { agent: ziling } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: '紫灵', description: '广州本地美食、生活方式和路线建议', runtime: 'Codex CLI' }),
    });
    const { agent: ccc } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'CCC', description: '资料检索、工程和文档整理', runtime: 'Codex CLI' }),
    });
    const { agent: yun } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: '云道友', description: '文化、旅行和轻松闲聊', runtime: 'Codex CLI' }),
    });
    const { channel } = await request(server.baseUrl, '/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: '行吧-test', description: 'contextual routing', agentIds: [ziling.id, ccc.id, yun.id] }),
    });

    const open = await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: '大家对广州的美食了解吗', attachmentIds: [] }),
    });
    assert.equal(open.route.mode, 'broadcast');
    assert.deepEqual(open.route.targetAgentIds.slice().sort(), [ziling.id, ccc.id, yun.id].sort());

    const directed = await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: '哈哈哈，还是紫灵会吃', attachmentIds: [] }),
    });
    assert.equal(directed.route.mode, 'directed');
    assert.deepEqual(directed.route.targetAgentIds, [ziling.id]);

    await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        authorType: 'agent',
        authorId: ziling.id,
        body: '广州这题我熟，早茶、烧腊、糖水和本地小店都能聊。',
        attachmentIds: [],
      }),
    });

    const followup = await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: '嗯，那为啥你心里的吃饭没有包含牛肉火锅呢？', attachmentIds: [] }),
    });
    assert.equal(followup.route.mode, 'contextual_follow_up');
    assert.deepEqual(followup.route.targetAgentIds, [ziling.id]);

    const finalState = await request(server.baseUrl, '/api/state');
    const routeEvent = finalState.routeEvents.find((event) => event.messageId === followup.message.id);
    assert.equal(routeEvent.mode, 'contextual_follow_up');
    assert.equal(routeEvent.fallbackUsed, true);
    assert.match(routeEvent.reason, /recent focused conversation|single-agent context/i);
    assert.deepEqual(
      finalState.workItems
        .filter((item) => item.sourceMessageId === followup.message.id)
        .map((item) => item.agentId),
      [ziling.id],
    );

    await request(server.baseUrl, `/api/agents/${ziling.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'idle' }),
    });
    await request(server.baseUrl, `/api/agents/${ccc.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'idle' }),
    });
    await request(server.baseUrl, `/api/agents/${yun.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'idle' }),
    });
    const capability = await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: '谁的学历高？', attachmentIds: [] }),
    });
    assert.equal(capability.route.mode, 'broadcast');
    assert.deepEqual(capability.route.targetAgentIds.slice().sort(), [ziling.id, ccc.id, yun.id].sort());
  } finally {
    await server.stop();
  }
});

test('configured fan-out API leaves simple routing on local rules', async () => {
  const server = await startIsolatedServer();
  const mock = await startMockFanoutApi(() => ({
    mode: 'broadcast',
    targetAgentIds: [],
    confidence: 0.1,
    reason: 'should not be called for simple rules',
  }));
  try {
    const { agent: ziling } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: '紫灵', description: '广州本地美食、生活方式和路线建议', runtime: 'Codex CLI' }),
    });
    const { agent: ccc } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'CCC', description: '资料检索、工程和文档整理', runtime: 'Codex CLI' }),
    });
    const { agent: yun } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: '云道友', description: '文化、旅行和轻松闲聊', runtime: 'Codex CLI' }),
    });
    await request(server.baseUrl, '/api/settings/fanout', {
      method: 'POST',
      body: JSON.stringify({
        enabled: true,
        baseUrl: `${mock.baseUrl}/v1`,
        apiKey: 'test-key',
        model: 'test-router',
      }),
    });
    const { channel } = await request(server.baseUrl, '/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'rules-context', description: 'local contextual routing', agentIds: [ziling.id, ccc.id, yun.id] }),
    });

    const open = await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: '大家对广州的美食了解吗', attachmentIds: [] }),
    });
    assert.equal(open.route.fallbackUsed, false);
    assert.equal(open.route.strategy, 'rules');
    assert.equal(open.route.llmUsed, false);
    assert.equal(open.route.mode, 'broadcast');

    const directed = await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: '哈哈哈，还是紫灵会吃', attachmentIds: [] }),
    });
    assert.equal(directed.route.mode, 'directed');
    assert.deepEqual(directed.route.targetAgentIds, [ziling.id]);

    await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        authorType: 'agent',
        authorId: ziling.id,
        body: '我会按本地吃法来讲。',
        attachmentIds: [],
      }),
    });

    const followup = await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: '嗯，那为啥你心里的吃饭没有包含牛肉火锅呢？', attachmentIds: [] }),
    });
    assert.equal(followup.route.fallbackUsed, false);
    assert.equal(followup.route.strategy, 'rules');
    assert.equal(followup.route.mode, 'contextual_follow_up');
    assert.deepEqual(followup.route.targetAgentIds, [ziling.id]);
    assert.equal(mock.calls.length, 0);
  } finally {
    await server.stop();
    await mock.stop();
  }
});

test('Fan-out API config is masked globally and drives LLM card routing when needed', async () => {
  const server = await startIsolatedServer();
  let githubId = '';
  let designId = '';
  let outsideId = '';
  const fanoutContexts = [];
  const mock = await startMockFanoutApi((body) => {
    const content = JSON.parse(body.messages.at(-1).content);
    fanoutContexts.push(content);
    if (content.trigger.type === 'explicit_mention_plus_named_agent') {
      return {
        mode: 'directed',
        targetAgentIds: [githubId, designId],
        confidence: 0.91,
        reason: 'The named designer should also receive this.',
      };
    }
    return {
      mode: 'task_claim',
      targetAgentIds: [githubId],
      claimantAgentId: githubId,
      confidence: 0.93,
      reason: 'GitPilot is the strongest card match for GitHub PR and CI work.',
      taskIntent: { title: 'Fix GitHub PR CI', kind: 'coding' },
    };
  });
  try {
    const initial = await request(server.baseUrl, '/api/state');
    assert.equal(initial.router.mode, 'rules_fallback');
    assert.equal(initial.settings.fanoutApi.configured, false);

    const { channel: fallbackChannel } = await request(server.baseUrl, '/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'fanout-fallback', description: 'no fan-out config yet', agentIds: [] }),
    });
    const fallbackCreated = await request(server.baseUrl, `/api/spaces/channel/${fallbackChannel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: '晚上好', attachmentIds: [] }),
    });
    assert.equal(fallbackCreated.route.fallbackUsed, true);
    assert.equal(fallbackCreated.route.llmUsed, false);

    const { agent: github } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'GitPilot', description: 'General helper', runtime: 'Codex CLI' }),
    });
    githubId = github.id;
    const { agent: design } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'DesignPilot', description: 'General helper', runtime: 'Codex CLI' }),
    });
    designId = design.id;
    const { agent: outside } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'ResearchPilot', description: 'Research and source checking', runtime: 'Codex CLI' }),
    });
    outsideId = outside.id;
    await writeFile(
      path.join(server.tmp, '.magclaw', 'agents', github.id, 'notes', 'profile.md'),
      '# GitPilot Profile\n\n## Strengths And Skills\n- GitHub pull requests, repo triage, CI failures, release checks, and code review.\n',
    );
    await writeFile(
      path.join(server.tmp, '.magclaw', 'agents', design.id, 'notes', 'profile.md'),
      '# DesignPilot Profile\n\n## Strengths And Skills\n- Visual design, layout polish, writing tone, and presentation structure.\n',
    );
    await writeFile(
      path.join(server.tmp, '.magclaw', 'agents', outside.id, 'notes', 'profile.md'),
      '# ResearchPilot Profile\n\n## Strengths And Skills\n- Market research, fact checking, and source synthesis.\n',
    );
    const { channel } = await request(server.baseUrl, '/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'fanout-route', description: 'llm fanout routing', agentIds: [github.id, design.id] }),
    });

    await request(server.baseUrl, '/api/settings/fanout', {
      method: 'POST',
      body: JSON.stringify({
        enabled: true,
        baseUrl: `${mock.baseUrl}/v1`,
        apiKey: 'secret-test-key',
        model: 'test-router',
        fallbackModel: 'deepseek-v4-flash',
      }),
    });

    const configured = await request(server.baseUrl, '/api/state');
    assert.equal(configured.router.mode, 'llm_fanout');
    assert.equal(configured.settings.fanoutApi.configured, true);
    assert.equal(configured.settings.fanoutApi.hasApiKey, true);
    assert.equal(configured.settings.fanoutApi.apiKeyPreview, 'secret****');
    assert.equal(configured.settings.fanoutApi.fallbackModel, 'deepseek-v4-flash');
    assert.equal(configured.settings.fanoutApi.timeoutMs, 5000);
    assert.equal(JSON.stringify(configured.settings).includes('secret-test-key'), false);

    const direct = await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: `<@${github.id}> 请看一下这个 PR`, attachmentIds: [] }),
    });
    assert.equal(direct.route.strategy, 'rules');
    assert.equal(direct.route.llmUsed, false);
    assert.deepEqual(direct.route.targetAgentIds, [github.id]);
    assert.equal(mock.calls.length, 0);

    const created = await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: '帮我修复 GitHub PR 里的 CI 问题并验证一下', attachmentIds: [] }),
    });

    assert.equal(created.route.mode, 'task_claim');
    assert.equal(created.route.strategy, 'rules');
    assert.equal(created.route.llmUsed, false);
    assert.equal(created.route.claimantAgentId, github.id);
    assert.equal(created.task.claimedBy, github.id);
    await waitFor(() => mock.calls.length >= 1 ? true : null);
    assert.ok(fanoutContexts[0].agentCards.map((card) => card.id).includes(outside.id));
    assert.ok(fanoutContexts[0].agentCards.find((card) => card.id === outside.id && card.channelMember === false && card.selectable === false));
    assert.ok(fanoutContexts[0].allowedChannelAgentIds.includes(github.id));
    assert.equal(fanoutContexts[0].allowedChannelAgentIds.includes(outside.id), false);
    assert.equal(mock.calls[0].url, '/v1/chat/completions');
    assert.equal(mock.calls[0].headers.authorization, 'Bearer secret-test-key');

    const mixed = await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: `<@${github.id}> DesignPilot 也一起看看这个布局风险`, attachmentIds: [] }),
    });
    assert.equal(mixed.route.mode, 'directed');
    assert.equal(mixed.route.strategy, 'rules');
    assert.equal(mixed.route.llmUsed, false);
    assert.deepEqual(mixed.route.targetAgentIds, [github.id]);
    await waitFor(() => mock.calls.length >= 2 ? true : null);

    const snapshot = await waitFor(async () => {
      const state = await request(server.baseUrl, '/api/state');
      const routeEvent = state.routeEvents.find((event) => event.messageId === created.message.id && event.strategy === 'rules');
      const llmRouteEvent = state.routeEvents.find((event) => event.messageId === created.message.id && event.strategy === 'llm_supplement');
      const workItems = state.workItems.filter((item) => item.sourceMessageId === created.message.id);
      return routeEvent && llmRouteEvent && workItems.length ? { routeEvent, llmRouteEvent, workItems, state } : null;
    });
    assert.equal(snapshot.routeEvent.fallbackUsed, false);
    assert.equal(snapshot.routeEvent.mode, 'task_claim');
    assert.equal(snapshot.routeEvent.strategy, 'rules');
    assert.equal(snapshot.routeEvent.llmUsed, false);
    assert.equal(snapshot.llmRouteEvent.strategy, 'llm_supplement');
    assert.equal(snapshot.llmRouteEvent.llmUsed, true);
    assert.equal(snapshot.llmRouteEvent.llmModel, 'test-router');
    assert.ok(Number.isFinite(snapshot.llmRouteEvent.llmLatencyMs));
    assert.deepEqual(snapshot.routeEvent.targetAgentIds, [github.id]);
    assert.deepEqual(snapshot.workItems.map((item) => item.agentId), [github.id]);
  } finally {
    await server.stop();
    await mock.stop();
  }
});

test('Fan-out API force keywords trigger LLM routing for otherwise direct messages', async () => {
  const server = await startIsolatedServer();
  let targetId = '';
  const fanoutContexts = [];
  const mock = await startMockFanoutApi((body) => {
    const content = JSON.parse(body.messages.at(-1).content);
    fanoutContexts.push(content);
    return {
      mode: 'directed',
      targetAgentIds: [targetId],
      confidence: 0.88,
      reason: 'Forced keyword test route.',
    };
  });
  try {
    const { agent: alpha } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'AlphaPilot', description: 'Direct helper', runtime: 'Codex CLI' }),
    });
    targetId = alpha.id;
    const { agent: beta } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'BetaPilot', description: 'Secondary helper', runtime: 'Codex CLI' }),
    });
    const { channel } = await request(server.baseUrl, '/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'force-keyword', description: 'keyword LLM test', agentIds: [alpha.id, beta.id] }),
    });

    await request(server.baseUrl, '/api/settings/fanout', {
      method: 'POST',
      body: JSON.stringify({
        enabled: true,
        baseUrl: `${mock.baseUrl}/v1`,
        apiKey: 'force-key',
        model: 'force-router',
        forceKeywords: '强制LLM\n/llm',
      }),
    });
    const configured = await request(server.baseUrl, '/api/state');
    assert.deepEqual(configured.settings.fanoutApi.forceKeywords, ['强制LLM', '/llm']);

    const created = await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: `<@${alpha.id}> 强制LLM 请看一下`, attachmentIds: [] }),
    });

    assert.equal(created.route.strategy, 'rules');
    assert.equal(created.route.llmUsed, false);
    assert.deepEqual(created.route.targetAgentIds, [alpha.id]);
    await waitFor(() => mock.calls.length >= 1 ? true : null);
    assert.equal(fanoutContexts[0].trigger.type, 'force_keyword');
    assert.equal(fanoutContexts[0].trigger.keyword, '强制LLM');
    assert.deepEqual(fanoutContexts[0].message.mentionedAgentIds, [alpha.id]);

    const state = await request(server.baseUrl, '/api/state');
    const routeEvent = state.routeEvents.find((event) => event.messageId === created.message.id && event.strategy === 'llm_supplement');
    assert.equal(routeEvent.llmUsed, true);
    assert.equal(routeEvent.llmModel, 'force-router');
    assert.ok(routeEvent.evidence.find((item) => item.type === 'llm_trigger' && item.value === 'force_keyword'));
    assert.ok(routeEvent.evidence.find((item) => item.type === 'llm_force_keyword' && item.value === '强制LLM'));
  } finally {
    await server.stop();
    await mock.stop();
  }
});

test('Fan-out API retries with the fallback model after primary failure', async () => {
  const server = await startIsolatedServer();
  let targetId = '';
  const mock = await startMockFanoutApi((body) => {
    if (body.model === 'qwen3.5-flash') {
      throw new Error('primary model unavailable');
    }
    return {
      mode: 'directed',
      targetAgentIds: [targetId],
      confidence: 0.9,
      reason: 'Fallback model selected the explicit helper.',
    };
  });
  try {
    const { agent: alpha } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'AlphaPilot', description: 'Direct helper', runtime: 'Codex CLI' }),
    });
    targetId = alpha.id;
    const { channel } = await request(server.baseUrl, '/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'fallback-route', description: 'fallback route test', agentIds: [alpha.id] }),
    });

    await request(server.baseUrl, '/api/settings/fanout', {
      method: 'POST',
      body: JSON.stringify({
        enabled: true,
        baseUrl: `${mock.baseUrl}/v1`,
        apiKey: 'fallback-key',
        model: 'qwen3.5-flash',
        fallbackModel: 'deepseek-v4-flash',
        timeoutMs: 5000,
        forceKeywords: '/llm',
      }),
    });

    await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: `<@${alpha.id}> /llm 请确认一下`, attachmentIds: [] }),
    });

    const delivered = await waitFor(async () => {
      const state = await request(server.baseUrl, '/api/state');
      return state.routeEvents.find((event) => event.strategy === 'llm_supplement') || null;
    });
    assert.equal(mock.calls.length, 2);
    assert.deepEqual(mock.calls.map((call) => call.body.model), ['qwen3.5-flash', 'deepseek-v4-flash']);
    assert.equal(delivered.llmUsed, true);
    assert.equal(delivered.llmModel, 'deepseek-v4-flash');
    assert.ok(delivered.evidence.find((item) => item.type === 'llm_primary_model' && item.value === 'qwen3.5-flash'));
    assert.ok(delivered.evidence.find((item) => item.type === 'llm_fallback_model' && item.value === 'deepseek-v4-flash'));
  } finally {
    await server.stop();
    await mock.stop();
  }
});

test('thread replies use Fan-out API routing when multiple agent participants are ambiguous', async () => {
  const server = await startIsolatedServer();
  let weiId = '';
  let zhongId = '';
  const fanoutContexts = [];
  const mock = await startMockFanoutApi((body) => {
    const content = JSON.parse(body.messages.at(-1).content);
    fanoutContexts.push(content);
    return {
      mode: 'directed',
      targetAgentIds: [weiId, zhongId],
      confidence: 0.89,
      reason: 'The reply addresses Wei by nickname and Zhong by title.',
    };
  });
  try {
    const { agent: hanli } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: '韩立', description: '谨慎的修仙者', runtime: 'Codex CLI' }),
    });
    const { agent: wei } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: '魏无涯', description: '魏道友，行事公道', runtime: 'Codex CLI' }),
    });
    weiId = wei.id;
    const { agent: zhong } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: '仲神师', description: '神师，直言严厉', runtime: 'Codex CLI' }),
    });
    zhongId = zhong.id;
    const { channel } = await request(server.baseUrl, '/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'thread-fanout', description: 'thread semantic routing', agentIds: [hanli.id, wei.id, zhong.id] }),
    });
    await request(server.baseUrl, '/api/settings/fanout', {
      method: 'POST',
      body: JSON.stringify({
        enabled: true,
        baseUrl: `${mock.baseUrl}/v1`,
        apiKey: 'thread-key',
        model: 'thread-router',
      }),
    });

    const parent = await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        body: `<@${hanli.id}> 先开个讨论`,
        attachmentIds: [],
      }),
    });
    assert.equal(mock.calls.length, 0);

    const reply = await request(server.baseUrl, `/api/messages/${parent.message.id}/replies`, {
      method: 'POST',
      body: JSON.stringify({
        body: '我觉得魏道友确实比较公道，神师，你也太严厉了吧',
        attachmentIds: [],
      }),
    });

    assert.equal(reply.route.strategy, 'rules');
    assert.equal(reply.route.llmUsed, false);
    assert.deepEqual(reply.route.targetAgentIds, [hanli.id]);
    await waitFor(() => mock.calls.length >= 1 ? true : null);
    assert.equal(fanoutContexts[0].thread.parentMessage.id, parent.message.id);
    assert.equal(fanoutContexts[0].thread.currentReplyId, reply.reply.id);
    assert.ok(fanoutContexts[0].thread.participantAgentIds.includes(hanli.id));
    assert.equal(fanoutContexts[0].trigger.type, 'thread_named_agent');

    const delivered = await waitFor(async () => {
      const state = await request(server.baseUrl, '/api/state');
      const workItems = state.workItems
        .filter((item) => item.sourceMessageId === reply.reply.id)
        .map((item) => item.agentId)
        .sort();
      const routeEvent = state.routeEvents.find((event) => event.messageId === reply.reply.id && event.strategy === 'llm_supplement');
      return workItems.length === 3 && routeEvent ? { workItems, routeEvent } : null;
    });
    assert.deepEqual(delivered.workItems, [hanli.id, wei.id, zhong.id].sort());
    assert.equal(delivered.routeEvent.parentMessageId, parent.message.id);
    assert.equal(delivered.routeEvent.llmUsed, true);
    assert.equal(delivered.routeEvent.llmModel, 'thread-router');
    assert.deepEqual(delivered.routeEvent.targetAgentIds.slice().sort(), [wei.id, zhong.id].sort());
  } finally {
    await server.stop();
    await mock.stop();
  }
});
