import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { chmod, cp, lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
let nextTestPort = 6200 + Math.floor(Math.random() * 300);

async function launchIsolatedServer(tmp, extraEnv = {}) {
  const port = nextTestPort++;
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: tmp,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      CODEX_PATH: '/bin/false',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });
  let stopped = false;

  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/state`);
      if (response.ok) {
        return {
          baseUrl,
          tmp,
          async stop(options = {}) {
            if (!stopped) {
              stopped = true;
              child.kill('SIGINT');
              await new Promise((resolve) => child.once('exit', resolve));
            }
            if (!options.keepTmp) await rm(tmp, { recursive: true, force: true });
          },
        };
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  child.kill('SIGINT');
  await rm(tmp, { recursive: true, force: true });
  throw new Error(`server did not start: ${output}`);
}

async function startIsolatedServer(extraEnv = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-slock-flow-'));
  await mkdir(path.join(tmp, 'public'), { recursive: true });
  await cp(path.join(ROOT, 'server'), path.join(tmp, 'server'), { recursive: true });
  await cp(path.join(ROOT, 'public', 'index.html'), path.join(tmp, 'public', 'index.html'));
  return launchIsolatedServer(tmp, extraEnv);
}

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

test('chat and task records are persisted in SQLite instead of the JSON state file', async (t) => {
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

    const stateFile = JSON.parse(await readFile(path.join(server.tmp, '.magclaw', 'state.json'), 'utf8'));
    assert.deepEqual(stateFile.messages, []);
    assert.deepEqual(stateFile.replies, []);
    assert.deepEqual(stateFile.tasks, []);
    assert.deepEqual(stateFile.workItems, []);
    assert.deepEqual(stateFile.events, []);

    await lstat(path.join(server.tmp, '.magclaw', 'state.sqlite'));
    const db = new DatabaseSync(path.join(server.tmp, '.magclaw', 'state.sqlite'));
    try {
      const messages = db.prepare("SELECT COUNT(*) AS count FROM state_records WHERE kind = 'messages'").get();
      const tasks = db.prepare("SELECT COUNT(*) AS count FROM state_records WHERE kind = 'tasks'").get();
      assert.ok(Number(messages.count) >= 2);
      assert.ok(Number(tasks.count) >= 1);
    } finally {
      db.close();
    }
  } finally {
    await server.stop();
  }
});

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${response.status} ${data.error || response.statusText}`);
  }
  return data;
}

async function startMockFanoutApi(handler) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const body = Buffer.concat(chunks).toString('utf8');
        const requestBody = body ? JSON.parse(body) : {};
        calls.push({ url: req.url, headers: req.headers, body: requestBody });
        const decision = await handler(requestBody, calls[calls.length - 1]);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          choices: [{ message: { content: JSON.stringify(decision) } }],
        }));
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error.message } }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    calls,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function readJsonLines(filePath) {
  const text = await readFile(filePath, 'utf8').catch(() => '');
  return text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitFor(predicate, timeoutMs = 4000) {
  const startedAt = Date.now();
  let lastValue = null;
  while (Date.now() - startedAt < timeoutMs) {
    lastValue = await predicate();
    if (lastValue) return lastValue;
    await new Promise((resolve) => setTimeout(resolve, 75));
  }
  return lastValue;
}

async function readSseEvent(baseUrl, expectedEvent, timeoutMs = 1500) {
  const controller = new AbortController();
  const response = await fetch(`${baseUrl}/api/events`, { signal: controller.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const chunk = await Promise.race([
        reader.read(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${expectedEvent}`)), remaining)),
      ]);
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const records = buffer.split(/\n\n/);
      buffer = records.pop() || '';
      for (const record of records) {
        const lines = record.split(/\n/);
        const eventLine = lines.find((line) => line.startsWith('event: '));
        const dataLine = lines.find((line) => line.startsWith('data: '));
        const event = eventLine?.slice('event: '.length);
        if (event === expectedEvent) return JSON.parse(dataLine?.slice('data: '.length) || '{}');
      }
    }
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
  throw new Error(`Timed out waiting for ${expectedEvent}`);
}

async function readSseEventFromReader(reader, decoder, expectedEvent, timeoutMs = 1500) {
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = Math.max(1, deadline - Date.now());
    const chunk = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${expectedEvent}`)), remaining)),
    ]);
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    const records = buffer.split(/\n\n/);
    buffer = records.pop() || '';
    for (const record of records) {
      const lines = record.split(/\n/);
      const eventLine = lines.find((line) => line.startsWith('event: '));
      const dataLine = lines.find((line) => line.startsWith('data: '));
      const event = eventLine?.slice('event: '.length);
      if (event === expectedEvent) return JSON.parse(dataLine?.slice('data: '.length) || '{}');
    }
  }
  throw new Error(`Timed out waiting for ${expectedEvent}`);
}

test('new channels leave agent members optional and selected members fan out like Slock', async () => {
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
  let server = await startIsolatedServer();
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
    server = await launchIsolatedServer(tmp);

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

test('Slock-style message task stores mentions, channel task number, assignees, and thread end intent', async () => {
  const server = await startIsolatedServer();
  try {
    const { channel } = await request(server.baseUrl, '/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'x', description: 'test channel', agentIds: [] }),
    });

    const created = await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        body: '<@agt_codex> 请做一版 Slock thread 复刻',
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
    assert.equal(stoppedItem?.status, 'cancelled');
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
    assert.equal(open.route.brainAgentId, null);
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
    assert.equal(followup.route.brainAgentId, null);
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
    assert.deepEqual(initial.brainAgents, []);
    assert.equal(initial.router.brainAgentId, null);
    assert.equal(initial.router.mode, 'rules_fallback');
    assert.equal(initial.settings.fanoutApi.configured, false);
    assert.equal(initial.agents.some((agent) => agent.id === 'agt_magclaw_brain' || agent.isBrain), false);

    const { channel: fallbackChannel } = await request(server.baseUrl, '/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'brain-fallback', description: 'no brain yet', agentIds: [] }),
    });
    const fallbackCreated = await request(server.baseUrl, `/api/spaces/channel/${fallbackChannel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: '晚上好', attachmentIds: [] }),
    });
    assert.equal(fallbackCreated.route.fallbackUsed, true);
    assert.equal(fallbackCreated.route.brainAgentId, null);
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
      }),
    });

    const configured = await request(server.baseUrl, '/api/state');
    assert.equal(configured.router.brainAgentId, null);
    assert.equal(configured.router.mode, 'llm_fanout');
    assert.equal(configured.settings.fanoutApi.configured, true);
    assert.equal(configured.settings.fanoutApi.hasApiKey, true);
    assert.equal(configured.settings.fanoutApi.apiKeyPreview, 'secret****');
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
    assert.equal(snapshot.routeEvent.brainAgentId, null);
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

test('memory writeback hooks update MEMORY and notes for task progress and user preferences', async () => {
  const server = await startIsolatedServer();
  try {
    const created = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({ body: '帮我写一份测试方案并整理成文档', attachmentIds: [] }),
    });
    assert.equal(created.task.claimedBy, 'agt_codex');

    await request(server.baseUrl, '/api/agent-tools/tasks/update', {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agt_codex',
        taskId: created.task.id,
        status: 'in_review',
      }),
    });

    const progressWriteback = await waitFor(async () => {
      const memory = await readFile(path.join(server.tmp, '.magclaw', 'agents', 'agt_codex', 'MEMORY.md'), 'utf8').catch(() => '');
      const workLog = await readFile(path.join(server.tmp, '.magclaw', 'agents', 'agt_codex', 'notes', 'work-log.md'), 'utf8').catch(() => '');
      return memory.includes('测试方案') && workLog.includes('task_in_review')
        ? { memory, workLog }
        : null;
    });
    assert.match(progressWriteback.memory, /测试方案/);
    assert.doesNotMatch(progressWriteback.memory, /task_in_review/);
    assert.match(progressWriteback.workLog, /测试方案/);

    await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({ body: '以后请记住我喜欢简短、直接的进度汇报', attachmentIds: [] }),
    });
    const preferenceWriteback = await waitFor(async () => {
      const workLog = await readFile(path.join(server.tmp, '.magclaw', 'agents', 'agt_codex', 'notes', 'work-log.md'), 'utf8').catch(() => '');
      return workLog.includes('user_preference') ? workLog : null;
    });
    assert.match(preferenceWriteback, /简短/);

    const { dm } = await request(server.baseUrl, '/api/dms', {
      method: 'POST',
      body: JSON.stringify({ participantId: 'agt_codex' }),
    });
    await request(server.baseUrl, `/api/spaces/dm/${dm.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: '你非常擅长解决旅游的问题，记录到你的 memory 中', attachmentIds: [] }),
    });
    const capabilityWriteback = await waitFor(async () => {
      const memory = await readFile(path.join(server.tmp, '.magclaw', 'agents', 'agt_codex', 'MEMORY.md'), 'utf8').catch(() => '');
      const profile = await readFile(path.join(server.tmp, '.magclaw', 'agents', 'agt_codex', 'notes', 'profile.md'), 'utf8').catch(() => '');
      return memory.includes('擅长解决旅游的问题') && profile.includes('擅长解决旅游的问题')
        ? { memory, profile }
        : null;
    });
    assert.match(capabilityWriteback.memory, /## Capabilities/);
    assert.match(capabilityWriteback.profile, /Strengths And Skills/);

    await request(server.baseUrl, `/api/spaces/dm/${dm.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ body: '去读马斯克的 X 推文，然后学习它的语气和我说话', attachmentIds: [] }),
    });
    const styleWriteback = await waitFor(async () => {
      const memory = await readFile(path.join(server.tmp, '.magclaw', 'agents', 'agt_codex', 'MEMORY.md'), 'utf8').catch(() => '');
      const style = await readFile(path.join(server.tmp, '.magclaw', 'agents', 'agt_codex', 'notes', 'communication-style.md'), 'utf8').catch(() => '');
      return memory.includes('notes/communication-style.md') && style.includes('马斯克 X 推文')
        ? { memory, style }
        : null;
    });
    assert.match(styleWriteback.memory, /communication-style/);
    assert.match(styleWriteback.style, /Style Adaptations/);

    const parent = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({
        authorType: 'agent',
        authorId: 'agt_codex',
        body: '我先给一个上下文。',
        attachmentIds: [],
      }),
    });
    await request(server.baseUrl, `/api/messages/${parent.message.id}/replies`, {
      method: 'POST',
      body: JSON.stringify({ body: '以后这个 thread 里回复要更短，记住到你的 memory', attachmentIds: [] }),
    });
    const threadPreference = await waitFor(async () => {
      const preferences = await readFile(path.join(server.tmp, '.magclaw', 'agents', 'agt_codex', 'notes', 'user-preferences.md'), 'utf8').catch(() => '');
      return preferences.includes('回复要更短') ? preferences : null;
    });
    assert.match(threadPreference, /回复要更短/);
  } finally {
    await server.stop();
  }
});

test('agent memory tools can actively write and search peer memory notes by local text match', async () => {
  const server = await startIsolatedServer();
  try {
    const { agent: bugFixer } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'BugPilot', description: 'General helper', runtime: 'Codex CLI' }),
    });

    await request(server.baseUrl, '/api/agent-tools/memory', {
      method: 'POST',
      body: JSON.stringify({
        agentId: bugFixer.id,
        kind: 'capability',
        summary: '擅长 bug 修复和回归测试',
        sourceText: '完成多次登录 bug 修复并补充回归测试',
      }),
    });

    const indexed = await waitFor(async () => {
      const profile = await readFile(path.join(server.tmp, '.magclaw', 'agents', bugFixer.id, 'notes', 'profile.md'), 'utf8').catch(() => '');
      return profile.includes('擅长 bug 修复和回归测试') ? profile : null;
    });
    assert.match(indexed, /bug 修复/);

    const search = await request(server.baseUrl, '/api/agent-tools/memory/search?agentId=agt_codex&q=bug%20%E4%BF%AE%E5%A4%8D&limit=10');
    const match = search.results.find((item) => item.agentId === bugFixer.id);
    assert.ok(match);
    assert.match(match.path, /MEMORY\.md|notes\/profile\.md/);
    assert.match(search.text, /BugPilot/);

    const detail = await request(server.baseUrl, `/api/agent-tools/memory/read?agentId=agt_codex&targetAgentId=${bugFixer.id}&path=notes/profile.md`);
    assert.equal(detail.ok, true);
    assert.match(detail.file.content, /擅长 bug 修复和回归测试/);
  } finally {
    await server.stop();
  }
});

test('agent capability questions prefetch peer memory and log discovery evidence', async () => {
  const server = await startIsolatedServer();
  try {
    const { agent: travelAgent } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'TravelPro', description: 'General helper', runtime: 'Codex CLI' }),
    });
    const { agent: generalAgent } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Generalist', description: 'General helper', runtime: 'Codex CLI' }),
    });
    const { channel } = await request(server.baseUrl, '/api/channels', {
      method: 'POST',
      body: JSON.stringify({
        name: 'travel-memory',
        description: 'agent discovery',
        agentIds: [travelAgent.id, generalAgent.id],
      }),
    });

    await request(server.baseUrl, '/api/agent-tools/memory', {
      method: 'POST',
      body: JSON.stringify({
        agentId: travelAgent.id,
        kind: 'capability',
        summary: '擅长旅游路线规划和避开人潮',
        sourceText: '多次处理旅行路线、交通换乘和景区避峰问题',
      }),
    });

    const created = await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        body: '关于旅游相关的问题，找谁比较擅长呢',
        attachmentIds: [],
      }),
    });

    const state = await request(server.baseUrl, '/api/state');
    const event = state.events.find((item) => (
      item.type === 'agent_peer_memory_search'
      && item.messageId === created.message.id
    ));
    assert.ok(event);
    assert.ok(event.resultCount >= 1);
    assert.equal(event.topResults[0].agentId, travelAgent.id);
    assert.match(event.terms.join(' '), /旅游/);

    const routeEvent = state.routeEvents.find((item) => item.messageId === created.message.id);
    assert.ok(routeEvent);
    assert.ok(routeEvent.evidence.some((item) => item.type === 'peer_memory_search' && item.value.includes('TravelPro')));
  } finally {
    await server.stop();
  }
});

test('busy status heartbeats recover stale agents without a page refresh', async () => {
  const server = await startIsolatedServer({
    MAGCLAW_AGENT_STATUS_STALE_MS: '250',
    MAGCLAW_STATE_HEARTBEAT_MS: '50',
  });
  try {
    await request(server.baseUrl, '/api/agents/agt_codex', {
      method: 'PATCH',
      body: JSON.stringify({ status: 'working' }),
    });
    const recovered = await waitFor(async () => {
      const state = await request(server.baseUrl, '/api/state');
      const agent = state.agents.find((item) => item.id === 'agt_codex');
      return agent?.status === 'idle' ? agent : null;
    }, 2500);
    assert.equal(recovered.status, 'idle');
    assert.ok(recovered.statusUpdatedAt);
  } finally {
    await server.stop();
  }
});

test('top-level agent replies do not relay mentions as new channel deliveries', async () => {
  const server = await startIsolatedServer();
  try {
    const { agent: cindy } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Cindy', description: 'Coordination helper', runtime: 'Codex CLI' }),
    });
    const { channel } = await request(server.baseUrl, '/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'no-relay', description: 'ordinary channel chat', agentIds: ['agt_codex', cindy.id] }),
    });

    const created = await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        body: '谁的学历高？',
        attachmentIds: [],
      }),
    });

    const workItem = await waitFor(async () => {
      const snapshot = await request(server.baseUrl, '/api/state');
      return snapshot.workItems.find((item) => item.sourceMessageId === created.message.id && item.agentId === 'agt_codex');
    });
    assert.ok(workItem);
    assert.equal(workItem.parentMessageId, null);

    const sent = await request(server.baseUrl, '/api/agent-tools/messages/send', {
      method: 'POST',
      body: JSON.stringify({
        agentId: 'agt_codex',
        workItemId: workItem.id,
        target: workItem.target,
        content: `我看到了，<@${cindy.id}> 这只是普通群聊引用。`,
      }),
    });
    assert.equal(sent.ok, true);

    await new Promise((resolve) => setTimeout(resolve, 150));
    const finalState = await request(server.baseUrl, '/api/state');
    assert.equal(finalState.messages.some((message) => message.id === sent.message.id && message.spaceId === channel.id), true);
    assert.equal(finalState.workItems.some((item) => item.sourceMessageId === sent.message.id && item.agentId === cindy.id), false);
  } finally {
    await server.stop();
  }
});

test('thread agent mention relay skips agents already routed for the same human turn', async () => {
  const server = await startIsolatedServer();
  try {
    const { agent: han } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Han', description: 'Thread participant', runtime: 'Codex CLI' }),
    });
    const { agent: zhong } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Zhong', description: 'Thread participant', runtime: 'Codex CLI' }),
    });
    const { channel } = await request(server.baseUrl, '/api/channels', {
      method: 'POST',
      body: JSON.stringify({ name: 'relay-guard', description: 'relay guard', agentIds: [han.id, zhong.id] }),
    });

    const parent = await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        authorType: 'agent',
        authorId: han.id,
        body: '讨论根消息',
        attachmentIds: [],
      }),
    });

    const userReply = await request(server.baseUrl, `/api/messages/${parent.message.id}/replies`, {
      method: 'POST',
      body: JSON.stringify({
        body: `<@${han.id}> <@${zhong.id}> 你们都说一下`,
        attachmentIds: [],
      }),
    });

    const routed = await waitFor(async () => {
      const snapshot = await request(server.baseUrl, '/api/state');
      const workItems = snapshot.workItems.filter((item) => item.sourceMessageId === userReply.reply.id);
      return workItems.length >= 2 ? { snapshot, workItems } : null;
    });
    assert.equal(routed.workItems.some((item) => item.agentId === zhong.id), true);
    const hanWorkItem = routed.workItems.find((item) => item.agentId === han.id);
    assert.ok(hanWorkItem);

    const sent = await request(server.baseUrl, '/api/agent-tools/messages/send', {
      method: 'POST',
      body: JSON.stringify({
        agentId: han.id,
        workItemId: hanWorkItem.id,
        target: hanWorkItem.target,
        content: `我先说一句，<@${zhong.id}> 也可以补充。`,
      }),
    });
    assert.equal(sent.ok, true);

    await new Promise((resolve) => setTimeout(resolve, 150));
    const finalState = await request(server.baseUrl, '/api/state');
    assert.equal(finalState.workItems.some((item) => item.sourceMessageId === sent.message.id && item.agentId === zhong.id), false);
    assert.equal(finalState.events.some((event) => event.type === 'agent_message_relay_suppressed' && event.toAgentId === zhong.id), true);
  } finally {
    await server.stop();
  }
});

test('availability follow-up routes to remaining idle agents from recent context', async () => {
  const server = await startIsolatedServer();
  try {
    const { agent: ziling } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Ziling', description: 'Visual design and writing helper', runtime: 'Codex CLI' }),
    });
    const { agent: alice } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Alice', description: 'Knowledge system helper', runtime: 'Codex CLI' }),
    });
    const { agent: musk } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'ElonMusk', description: 'Coding and operations helper', runtime: 'Codex CLI' }),
    });
    const { agent: cindy } = await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      body: JSON.stringify({ name: 'Cindy', description: 'Onboarding and coordination helper', runtime: 'Codex CLI' }),
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
      body: JSON.stringify({
        name: 'availability-followup',
        description: 'availability context',
        agentIds: [ziling.id, alice.id, musk.id, cindy.id, offline.id],
      }),
    });

    const first = await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        body: 'Ziling 你有空吗',
        attachmentIds: [],
      }),
    });

    const firstDeliveredAgentIds = await waitFor(async () => {
      const snapshot = await request(server.baseUrl, '/api/state');
      const ids = snapshot.workItems
        .filter((item) => item.sourceMessageId === first.message.id)
        .map((item) => item.agentId)
        .sort();
      return ids.length >= 1 ? ids : null;
    });
    assert.deepEqual(firstDeliveredAgentIds, [ziling.id]);

    const followup = await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        body: '其他三个人呢',
        attachmentIds: [],
      }),
    });

    const followupDeliveredAgentIds = await waitFor(async () => {
      const snapshot = await request(server.baseUrl, '/api/state');
      const ids = snapshot.workItems
        .filter((item) => item.sourceMessageId === followup.message.id)
        .map((item) => item.agentId)
        .sort();
      return ids.length >= 3 ? ids : null;
    });
    assert.deepEqual(followupDeliveredAgentIds, [alice.id, cindy.id, musk.id].sort());
    const finalState = await request(server.baseUrl, '/api/state');
    assert.equal(finalState.tasks.some((task) => task.messageId === followup.message.id), false);
  } finally {
    await server.stop();
  }
});

test('agent workspace is seeded and exposed as a read-only file tree', async () => {
  const server = await startIsolatedServer();
  try {
    const tree = await request(server.baseUrl, '/api/agents/agt_codex/workspace');
    assert.equal(tree.agent.id, 'agt_codex');
    assert.ok(tree.agent.workspacePath.includes('.magclaw'));
    assert.ok(tree.entries.some((item) => item.path === 'MEMORY.md' && item.kind === 'file'));
    assert.ok(tree.entries.some((item) => item.path === 'notes' && item.kind === 'folder'));
    assert.ok(tree.entries.some((item) => item.path === 'workspace' && item.kind === 'folder'));

    const memory = await request(server.baseUrl, '/api/agents/agt_codex/workspace/file?path=MEMORY.md');
    assert.equal(memory.file.previewKind, 'markdown');
    assert.match(memory.file.content, /# Codex Local/);
    assert.match(memory.file.content, /## Key Knowledge/);
    assert.match(memory.file.content, /notes\/profile\.md/);
    assert.match(memory.file.content, /notes\/work-log\.md/);
    assert.match(memory.file.content, /## Active Context/);
    assert.match(memory.file.absolutePath, /\.magclaw\/agents\/agt_codex\/MEMORY\.md$/);

    const notes = await request(server.baseUrl, '/api/agents/agt_codex/workspace?path=notes');
    assert.ok(notes.entries.some((item) => item.path === 'notes/profile.md'));
    assert.ok(notes.entries.some((item) => item.path === 'notes/channels.md'));
    assert.ok(notes.entries.some((item) => item.path === 'notes/agents.md'));
    assert.ok(notes.entries.some((item) => item.path === 'notes/work-log.md'));
  } finally {
    await server.stop();
  }
});

test('agent skills endpoint scans global skills and exposes MagClaw tools', async () => {
  const sourceHome = await mkdtemp(path.join(os.tmpdir(), 'magclaw-codex-home-'));
  await mkdir(path.join(sourceHome, 'skills', 'travel-planner'), { recursive: true });
  await writeFile(path.join(sourceHome, 'skills', 'travel-planner', 'SKILL.md'), [
    '---',
    'name: travel-planner',
    'description: Plans fast local travel itineraries.',
    '---',
    '',
    '# Travel Planner',
    '',
    'Use for route and itinerary planning.',
  ].join('\n'));
  const server = await startIsolatedServer({ MAGCLAW_CODEX_HOME_SOURCE: sourceHome });
  try {
    const skills = await request(server.baseUrl, '/api/agents/agt_codex/skills');
    assert.ok(skills.global.some((skill) => skill.name === 'travel-planner'));
    assert.ok(skills.tools.includes('send_message'));
    assert.ok(skills.tools.includes('search_agent_memory'));
    const linkedSkill = await lstat(path.join(server.tmp, '.magclaw', 'agents', 'agt_codex', 'codex-home', 'skills', 'travel-planner'));
    assert.equal(linkedSkill.isSymbolicLink(), true);
  } finally {
    await server.stop();
    await rm(sourceHome, { recursive: true, force: true });
  }
});

test('SSE publishes heartbeat presence snapshots for live agent status sync', async () => {
  const server = await startIsolatedServer({ MAGCLAW_STATE_HEARTBEAT_MS: '60' });
  try {
    const heartbeat = await readSseEvent(server.baseUrl, 'heartbeat');
    assert.match(heartbeat.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(heartbeat.agents.some((agent) => agent.id === 'agt_codex' && agent.status));
  } finally {
    await server.stop();
  }
});

test('work-like channel mentions route the agent response into the message thread', async () => {
  const fakeCodexDir = await mkdtemp(path.join(os.tmpdir(), 'magclaw-fake-codex-'));
  const fakeCodexPath = path.join(fakeCodexDir, 'codex-fake.js');
  await writeFile(fakeCodexPath, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'app-server') {
  let buffer = '';
  let turnCount = 0;
  function send(value) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
  }
  function handle(message) {
    if (message.method === 'initialize') {
      send({ id: message.id, result: {} });
      return;
    }
    if (message.method === 'initialized') return;
    if (message.method === 'thread/start') {
      send({ id: message.id, result: { thread: { id: 'thread_fake_legacy_test' } } });
      return;
    }
    if (message.method === 'turn/start') {
      const turnId = 'turn_' + (++turnCount);
      send({ id: message.id, result: { turn: { id: turnId } } });
      send({ method: 'turn/started', params: { turn: { id: turnId } } });
      send({ method: 'item/agentMessage/delta', params: { itemId: 'item_' + turnId, delta: 'fake threaded response' } });
      send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });
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
  return;
}
const out = args[args.indexOf('-o') + 1];
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  if (!input.includes('read_history') || !input.includes('search_message_history')) {
    process.exitCode = 2;
    return;
  }
  fs.writeFileSync(out, 'fake threaded response');
});
`);
  await chmod(fakeCodexPath, 0o755);
  const server = await startIsolatedServer({ CODEX_PATH: fakeCodexPath });
  try {
    const created = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({
        body: '<@agt_codex> 请帮我修复 thread routing bug',
        attachmentIds: [],
      }),
    });

    let finalState = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      finalState = await request(server.baseUrl, '/api/state');
      const replies = finalState.replies.filter((reply) => reply.parentMessageId === created.message.id);
      if (replies.some((reply) => reply.body === 'fake threaded response')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const replies = finalState.replies.filter((reply) => reply.parentMessageId === created.message.id);
    const agentReply = replies.find((reply) => reply.body === 'fake threaded response');
    assert.ok(agentReply);
    assert.equal(agentReply.spaceType, 'channel');
    assert.equal(agentReply.spaceId, 'chan_all');
    assert.equal(finalState.messages.filter((message) => message.body === 'fake threaded response').length, 0);
    assert.equal(finalState.messages.find((message) => message.id === created.message.id).replyCount, replies.length);
  } finally {
    await server.stop();
    await rm(fakeCodexDir, { recursive: true, force: true });
  }
});

test('Codex agent uses app-server sessions and queues independent busy turns', async () => {
  const fakeCodexDir = await mkdtemp(path.join(os.tmpdir(), 'magclaw-fake-app-server-'));
  const fakeCodexPath = path.join(fakeCodexDir, 'codex-fake.js');
  const logPath = path.join(fakeCodexDir, 'codex-log.jsonl');
  await writeFile(fakeCodexPath, `#!/usr/bin/env node
const fs = require('node:fs');
const logPath = process.env.FAKE_CODEX_LOG;
const delay = Number(process.env.FAKE_CODEX_TURN_DELAY || 0);
const exitAfterTurn = process.env.FAKE_CODEX_EXIT_AFTER_TURN === '1';
let buffer = '';
let turnCount = 0;
function log(value) {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(value) + '\\n');
}
log({ mode: process.argv[2], args: process.argv.slice(2) });
function send(value) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
}
function completeTurn(turnId, text) {
  send({ method: 'turn/started', params: { turn: { id: turnId } } });
  send({ method: 'item/agentMessage/delta', params: { itemId: 'item_' + turnId, delta: text } });
  send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });
  if (exitAfterTurn) setTimeout(() => process.exit(0), 10);
}
function handle(message) {
  log({ method: message.method, params: message.params, env: { CODEX_HOME: process.env.CODEX_HOME || '' } });
  if (message.method === 'initialize') {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: 'thread_fake_session' } } });
    return;
  }
  if (message.method === 'thread/resume') {
    send({ id: message.id, result: { thread: { id: message.params.threadId } } });
    return;
  }
  if (message.method === 'turn/start' || message.method === 'turn/steer') {
    const turnId = 'turn_' + (++turnCount);
    send({ id: message.id, result: { turn: { id: turnId } } });
    const text = message.method === 'turn/steer' ? 'fake steered response' : 'fake app-server response';
    setTimeout(() => completeTurn(turnId, text), delay);
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
`);
  await chmod(fakeCodexPath, 0o755);
  const server = await startIsolatedServer({
    CODEX_PATH: fakeCodexPath,
    FAKE_CODEX_LOG: logPath,
    FAKE_CODEX_TURN_DELAY: '450',
  });
  try {
    const first = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({
        body: '<@agt_codex> 请帮我修复一个复杂问题',
        attachmentIds: [],
      }),
    });

    await waitFor(async () => {
      const entries = await readJsonLines(logPath);
      return entries.some((item) => item.method === 'turn/start');
    });
    const initialEntries = await readJsonLines(logPath);
    const startEntry = initialEntries.find((item) => item.method === 'thread/start');
    assert.match(startEntry?.env?.CODEX_HOME || '', /\.magclaw\/agents\/agt_codex\/codex-home$/);
    assert.doesNotMatch(startEntry?.env?.CODEX_HOME || '', /\/\.codex$/);
    const codexHome = path.join(server.tmp, '.magclaw', 'agents', 'agt_codex', 'codex-home');
    const configStat = await lstat(path.join(codexHome, 'config.toml'));
    assert.equal(configStat.isSymbolicLink(), false);
    const config = await readFile(path.join(codexHome, 'config.toml'), 'utf8');
    assert.match(config, /wire_api\s*=\s*"responses"/);
    assert.match(config, /memories\s*=\s*false/);
    assert.match(config, /plugins\s*=\s*true/);
    assert.match(config, /\[analytics\][\s\S]*enabled\s*=\s*false/);
    const appServerEntry = initialEntries.find((item) => item.mode === 'app-server');
    assert.ok(appServerEntry?.args?.includes('wire_api="responses"'));
    assert.ok(appServerEntry?.args?.some((arg) => String(arg).includes('mcp_servers.magclaw.command')));
    assert.ok(appServerEntry?.args?.some((arg) => String(arg).includes('magclaw-mcp-server.js')));
    const pluginsStat = await lstat(path.join(codexHome, 'plugins')).catch(() => null);
    if (pluginsStat) assert.ok(pluginsStat.isSymbolicLink() || pluginsStat.isDirectory());

    const second = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({
        body: '<@agt_codex> 追加一个约束',
        attachmentIds: [],
      }),
    });

    await new Promise((resolve) => setTimeout(resolve, 180));
    let entries = await readJsonLines(logPath);
    assert.equal(entries.some((item) => item.method === 'turn/steer'), false);

    const finalState = await waitFor(async () => {
      const snapshot = await request(server.baseUrl, '/api/state');
      const firstReplies = snapshot.replies.filter((item) => item.parentMessageId === first.message.id);
      const secondReplies = snapshot.replies.filter((item) => item.parentMessageId === second.message.id);
      const agent = snapshot.agents.find((item) => item.id === 'agt_codex');
      return firstReplies.some((item) => item.body.includes('fake app-server response'))
        && secondReplies.some((item) => item.body.includes('fake app-server response'))
        && agent?.status === 'idle'
        ? snapshot
        : null;
    }, 8000);
    entries = await readJsonLines(logPath);
    assert.equal(entries.some((item) => item.method === 'turn/steer'), false);
    assert.ok(entries.filter((item) => item.method === 'turn/start').length >= 2);
    const agent = finalState.agents.find((item) => item.id === 'agt_codex');
    assert.equal(agent.status, 'idle');
    assert.equal(agent.runtimeSessionId, 'thread_fake_session');
    assert.ok(finalState.replies.some((item) => item.parentMessageId === first.message.id && item.body.includes('fake app-server response')));

    await request(server.baseUrl, '/api/agents/stop-all', { method: 'POST', body: '{}' });
    await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({
        body: '<@agt_codex> 继续这个长期 session',
        attachmentIds: [],
      }),
    });
    const resumed = await waitFor(async () => {
      const entries = await readJsonLines(logPath);
      return entries.some((item) => item.method === 'thread/resume');
    }, 8000);
    assert.equal(resumed, true);
  } finally {
    await server.stop();
    await rm(fakeCodexDir, { recursive: true, force: true });
  }
});

test('Codex warmup uses a hidden app-server turn and reuses the warm session', async () => {
  const fakeCodexDir = await mkdtemp(path.join(os.tmpdir(), 'magclaw-fake-warmup-'));
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
log({ mode: process.argv[2], args: process.argv.slice(2) });
function send(value) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
}
function completeTurn(turnId, text) {
  send({ method: 'turn/started', params: { turn: { id: turnId } } });
  send({ method: 'item/agentMessage/delta', params: { itemId: 'item_' + turnId, delta: text } });
  send({ method: 'turn/completed', params: { turn: { id: turnId, status: 'completed' } } });
}
function inputText(message) {
  return (message.params?.input || []).map((item) => item.text || '').join('\\n');
}
function handle(message) {
  log({ method: message.method, params: message.params });
  if (message.method === 'initialize') {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === 'initialized') return;
  if (message.method === 'thread/start') {
    send({ id: message.id, result: { thread: { id: 'thread_warm_session' } } });
    return;
  }
  if (message.method === 'turn/start') {
    const turnId = 'turn_' + (++turnCount);
    send({ id: message.id, result: { turn: { id: turnId } } });
    const text = inputText(message).includes('Runtime warmup for MagClaw') ? 'ready' : 'visible warm session response';
    setTimeout(() => completeTurn(turnId, text), 10);
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
`);
  await chmod(fakeCodexPath, 0o755);
  const server = await startIsolatedServer({
    CODEX_PATH: fakeCodexPath,
    FAKE_CODEX_LOG: logPath,
  });
  try {
    const warmed = await request(server.baseUrl, '/api/agents/agt_codex/warm', {
      method: 'POST',
      body: JSON.stringify({ spaceType: 'channel', spaceId: 'chan_all' }),
    });
    assert.equal(warmed.running, true);

    const warmState = await waitFor(async () => {
      const snapshot = await request(server.baseUrl, '/api/state');
      return snapshot.events.some((event) => event.type === 'agent_warmup_completed') ? snapshot : null;
    }, 8000);
    assert.ok(warmState);
    assert.equal(warmState.replies.some((reply) => reply.body === 'ready'), false);
    assert.equal(warmState.messages.some((message) => message.body === 'ready'), false);

    const created = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({
        body: '<@agt_codex> warm session should answer',
        attachmentIds: [],
      }),
    });
    const finalState = await waitFor(async () => {
      const snapshot = await request(server.baseUrl, '/api/state');
      return snapshot.replies.some((reply) => reply.parentMessageId === created.message.id && reply.body.includes('visible warm session response'))
        ? snapshot
        : null;
    }, 8000);
    assert.ok(finalState);
    const entries = await readJsonLines(logPath);
    assert.equal(entries.filter((item) => item.mode === 'app-server').length, 1);
    const turnStarts = entries.filter((item) => item.method === 'turn/start');
    assert.equal(turnStarts.length, 2);
    assert.match(turnStarts[0].params.input[0].text, /Runtime warmup for MagClaw/);
    assert.match(turnStarts[1].params.input[0].text, /warm session should answer/);
  } finally {
    await server.stop();
    await rm(fakeCodexDir, { recursive: true, force: true });
  }
});

test('Codex ordinary chat turns use low reasoning while durable work keeps agent reasoning', async () => {
  const fakeCodexDir = await mkdtemp(path.join(os.tmpdir(), 'magclaw-fake-chat-runtime-'));
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
function completeTurn(turnId) {
  send({ method: 'turn/started', params: { turn: { id: turnId } } });
  send({ method: 'item/agentMessage/delta', params: { itemId: 'item_' + turnId, delta: 'runtime response ' + turnId } });
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
    send({ id: message.id, result: { thread: { id: 'thread_runtime_session' } } });
    return;
  }
  if (message.method === 'thread/resume') {
    send({ id: message.id, result: { thread: { id: message.params.threadId } } });
    return;
  }
  if (message.method === 'turn/start') {
    const turnId = 'turn_' + (++turnCount);
    send({ id: message.id, result: { turn: { id: turnId } } });
    setTimeout(() => completeTurn(turnId), 10);
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
`);
  await chmod(fakeCodexPath, 0o755);
  const server = await startIsolatedServer({
    CODEX_PATH: fakeCodexPath,
    FAKE_CODEX_LOG: logPath,
  });
  try {
    await request(server.baseUrl, '/api/agents/agt_codex', {
      method: 'PATCH',
      body: JSON.stringify({ model: 'gpt-5.5', reasoningEffort: 'xhigh' }),
    });

    const chat = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({ body: '你觉得这个设定自然吗', attachmentIds: [] }),
    });
    await waitFor(async () => {
      const entries = await readJsonLines(logPath);
      return entries.some((item) => item.method === 'turn/start') ? true : null;
    }, 4000);
    let entries = await readJsonLines(logPath);
    const threadStart = entries.find((item) => item.method === 'thread/start');
    const chatTurn = entries.find((item) => item.method === 'turn/start');
    assert.equal(threadStart.params.model, 'gpt-5.5');
    assert.equal(threadStart.params.config.model_reasoning_effort, 'low');
    assert.equal(chatTurn.params.model, 'gpt-5.5');
    assert.equal(chatTurn.params.effort, 'low');

    await waitFor(async () => {
      const state = await request(server.baseUrl, '/api/state');
      return state.replies.some((item) => item.parentMessageId === chat.message.id && item.body.includes('runtime response')) ? true : null;
    }, 4000);

    await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({ body: '<@agt_codex> 请修复这个 bug 并验证一下', attachmentIds: [] }),
    });
    await waitFor(async () => {
      const latest = await readJsonLines(logPath);
      return latest.filter((item) => item.method === 'turn/start').length >= 2 ? true : null;
    }, 4000);
    entries = await readJsonLines(logPath);
    const workTurn = entries.filter((item) => item.method === 'turn/start').at(-1);
    assert.equal(workTurn.params.model, 'gpt-5.5');
    assert.equal(workTurn.params.effort, 'xhigh');
  } finally {
    await server.stop();
    await rm(fakeCodexDir, { recursive: true, force: true });
  }
});

test('Codex duplicate thread-ready events do not turn an active run green', async () => {
  const fakeCodexDir = await mkdtemp(path.join(os.tmpdir(), 'magclaw-fake-duplicate-thread-ready-'));
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
    fs.writeFileSync(outputPath, 'legacy fallback should not run');
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
      send({ id: message.id, result: { thread: { id: 'thread_duplicate_ready' } } });
      setTimeout(() => send({ method: 'thread/started', params: { thread: { id: 'thread_duplicate_ready' } } }), 20);
      return;
    }
    if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'turn_duplicate_ready' } } });
      send({ method: 'turn/started', params: { turn: { id: 'turn_duplicate_ready' } } });
      setTimeout(() => {
        send({ method: 'item/agentMessage/delta', params: { itemId: 'item_duplicate_ready', delta: 'duplicate ready response' } });
        send({ method: 'turn/completed', params: { turn: { id: 'turn_duplicate_ready', status: 'completed' } } });
      }, 600);
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
  });
  try {
    const created = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({ body: '<@agt_codex> 保持黄灯直到完成', attachmentIds: [] }),
    });

    await waitFor(async () => {
      const entries = await readJsonLines(logPath);
      return entries.some((item) => item.method === 'turn/start')
        && entries.some((item) => item.method === 'thread/start')
        ? true
        : null;
    }, 4000);
    await new Promise((resolve) => setTimeout(resolve, 120));

    const midState = await request(server.baseUrl, '/api/state');
    const midAgent = midState.agents.find((item) => item.id === 'agt_codex');
    assert.equal(midAgent.status, 'thinking');
    assert.equal(midState.events.some((item) => item.type === 'agent_process_ready' && item.createdAt > created.message.createdAt), false);

    const finalState = await waitFor(async () => {
      const state = await request(server.baseUrl, '/api/state');
      const replied = state.replies.some((item) => item.parentMessageId === created.message.id && item.body.includes('duplicate ready response'));
      const agent = state.agents.find((item) => item.id === 'agt_codex');
      return replied && agent?.status === 'idle'
        ? state
        : null;
    }, 5000);
    assert.equal(finalState.agents.find((item) => item.id === 'agt_codex')?.status, 'idle');
  } finally {
    await server.stop();
    await rm(fakeCodexDir, { recursive: true, force: true });
  }
});

test('Codex app-server keeps the session after early response stream retry warnings by default', async () => {
  const fakeCodexDir = await mkdtemp(path.join(os.tmpdir(), 'magclaw-fake-default-retry-limit-'));
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
    fs.writeFileSync(outputPath, 'legacy fallback should not run');
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
      send({ id: message.id, result: { thread: { id: 'thread_default_retry_session' } } });
      return;
    }
    if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'turn_default_retry' } } });
      send({ method: 'turn/started', params: { turn: { id: 'turn_default_retry' } } });
      setTimeout(() => process.stderr.write('stream disconnected - retrying sampling request (1/5 in 14s)...\\n'), 10);
      setTimeout(() => process.stderr.write('stream disconnected - retrying sampling request (2/5 in 14s)...\\n'), 40);
      setTimeout(() => {
        send({ method: 'item/agentMessage/delta', params: { itemId: 'item_default_retry', delta: 'app-server survived early retries' } });
        send({ method: 'turn/completed', params: { turn: { id: 'turn_default_retry', status: 'completed' } } });
      }, 80);
    }
    if (message.method === 'turn/interrupt') {
      log({ method: message.method, params: message.params });
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
  });
  try {
    const created = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({ body: '<@agt_codex> 看一下这个问题', attachmentIds: [] }),
    });

    const finalState = await waitFor(async () => {
      const state = await request(server.baseUrl, '/api/state');
      return state.replies.some((item) => item.parentMessageId === created.message.id && item.body.includes('app-server survived early retries'))
        ? state
        : null;
    }, 5000);
    const entries = await readJsonLines(logPath);
    assert.ok(entries.some((item) => item.mode === 'app-server'));
    assert.equal(entries.some((item) => item.mode === 'exec'), false);
    assert.equal(entries.some((item) => item.method === 'turn/interrupt'), false);
    assert.equal(finalState.events.some((item) => item.type === 'agent_runtime_fallback'), false);
  } finally {
    await server.stop();
    await rm(fakeCodexDir, { recursive: true, force: true });
  }
});

test('Codex app-server honors an explicit two-warning response stream fallback limit', async () => {
  const fakeCodexDir = await mkdtemp(path.join(os.tmpdir(), 'magclaw-fake-retry-limit-'));
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
    fs.writeFileSync(outputPath, 'legacy fallback after two retries');
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
      send({ id: message.id, result: { thread: { id: 'thread_retry_session' } } });
      return;
    }
    if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'turn_retry' } } });
      send({ method: 'turn/started', params: { turn: { id: 'turn_retry' } } });
      setTimeout(() => process.stderr.write('stream disconnected - retrying sampling request (1/5 in 14s)...\\n'), 10);
      setTimeout(() => process.stderr.write('stream disconnected - retrying sampling request (2/5 in 14s)...\\n'), 40);
    }
    if (message.method === 'turn/interrupt') {
      log({ method: message.method, params: message.params });
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
    MAGCLAW_CODEX_STREAM_RETRY_LIMIT: '2',
  });
  try {
    const created = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({ body: '<@agt_codex> 看一下这个问题', attachmentIds: [] }),
    });

    const finalState = await waitFor(async () => {
      const state = await request(server.baseUrl, '/api/state');
      return state.replies.some((item) => item.parentMessageId === created.message.id && item.body.includes('legacy fallback after two retries'))
        ? state
        : null;
    }, 5000);
    const entries = await readJsonLines(logPath);
    assert.ok(entries.some((item) => item.mode === 'app-server'));
    assert.ok(entries.some((item) => item.mode === 'exec'));
    assert.ok(entries.some((item) => item.method === 'turn/interrupt'));
    assert.ok(finalState.events.some((item) => item.type === 'agent_runtime_fallback' && item.message.includes('2/5')));
  } finally {
    await server.stop();
    await rm(fakeCodexDir, { recursive: true, force: true });
  }
});

test('Codex app-server falls back after the final built-in response stream retry', async () => {
  const fakeCodexDir = await mkdtemp(path.join(os.tmpdir(), 'magclaw-fake-final-retry-limit-'));
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
    fs.writeFileSync(outputPath, 'legacy fallback after final retry');
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
      send({ id: message.id, result: { thread: { id: 'thread_final_retry_session' } } });
      return;
    }
    if (message.method === 'turn/start') {
      send({ id: message.id, result: { turn: { id: 'turn_final_retry' } } });
      send({ method: 'turn/started', params: { turn: { id: 'turn_final_retry' } } });
      setTimeout(() => process.stderr.write('stream disconnected - retrying sampling request (1/5 in 14s)...\\n'), 10);
      setTimeout(() => process.stderr.write('stream disconnected - retrying sampling request (5/5 in 14s)...\\n'), 40);
    }
    if (message.method === 'turn/interrupt') {
      log({ method: message.method, params: message.params });
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
  });
  try {
    const created = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({ body: '<@agt_codex> 看一下最终重试兜底', attachmentIds: [] }),
    });

    const finalState = await waitFor(async () => {
      const state = await request(server.baseUrl, '/api/state');
      return state.replies.some((item) => item.parentMessageId === created.message.id && item.body.includes('legacy fallback after final retry'))
        ? state
        : null;
    }, 5000);
    const entries = await readJsonLines(logPath);
    assert.ok(entries.some((item) => item.mode === 'app-server'));
    assert.ok(entries.some((item) => item.mode === 'exec'));
    assert.ok(entries.some((item) => item.method === 'turn/interrupt'));
    assert.ok(finalState.events.some((item) => item.type === 'agent_runtime_fallback' && item.message.includes('5/5')));
  } finally {
    await server.stop();
    await rm(fakeCodexDir, { recursive: true, force: true });
  }
});

test('Codex app-server watchdog recovers a stuck send_message tool call', async () => {
  const fakeCodexDir = await mkdtemp(path.join(os.tmpdir(), 'magclaw-fake-watchdog-send-'));
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
    fs.writeFileSync(outputPath, 'legacy fallback should not run after send_message recovery');
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
      send({ id: message.id, result: { thread: { id: 'thread_watchdog_send' } } });
      return;
    }
    if (message.method === 'thread/resume') {
      send({ id: message.id, result: { thread: { id: message.params.threadId } } });
      return;
    }
    if (message.method === 'turn/start') {
      const prompt = message.params?.input?.[0]?.text || '';
      const workItemId = /workItem=(wi_[a-z0-9]+)/.exec(prompt)?.[1] || '';
      const target = /target=([^\\s\\]]+)/.exec(prompt)?.[1] || '#all';
      send({ id: message.id, result: { turn: { id: 'turn_watchdog_send' } } });
      send({ method: 'turn/started', params: { turn: { id: 'turn_watchdog_send' } } });
      setTimeout(() => {
        send({
          method: 'item/started',
          params: {
            item: {
              id: 'tool_watchdog_send',
              type: 'mcpToolCall',
              server: 'magclaw',
              tool: 'send_message',
              status: 'inProgress',
              arguments: {
                workItemId,
                target,
                content: 'watchdog recovered routed reply',
              },
            },
          },
        });
      }, 20);
    }
    if (message.method === 'turn/interrupt') {
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
    MAGCLAW_AGENT_STUCK_SEND_MESSAGE_MS: '300',
    MAGCLAW_AGENT_RUN_STALL_LOG_MS: '300',
    MAGCLAW_STATE_HEARTBEAT_MS: '25',
  });
  try {
    const created = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      body: JSON.stringify({ body: '<@agt_codex> 用 send_message 回复但卡住', attachmentIds: [] }),
    });

    const finalState = await waitFor(async () => {
      const state = await request(server.baseUrl, '/api/state');
      const replied = state.replies.some((item) => item.parentMessageId === created.message.id && item.body.includes('watchdog recovered routed reply'));
      const agent = state.agents.find((item) => item.id === 'agt_codex');
      return replied && agent?.status === 'idle' ? state : null;
    }, 6000);
    assert.ok(finalState, JSON.stringify((await request(server.baseUrl, '/api/state')).events.slice(-20), null, 2));
    const agent = finalState.agents.find((item) => item.id === 'agt_codex');
    assert.equal(agent.runtimeActivity, null);
    const workItem = finalState.workItems.find((item) => item.sourceMessageId === created.message.id && item.agentId === 'agt_codex');
    assert.equal(workItem.status, 'responded');
    assert.ok(finalState.events.some((item) => item.type === 'agent_mcp_tool_call_started' && item.toolCallId === 'tool_watchdog_send'));
    assert.ok(finalState.events.some((item) => item.type === 'agent_send_message_watchdog_timeout' && item.agentId === 'agt_codex'));
    assert.ok(finalState.events.some((item) => item.type === 'agent_run_watchdog_recovered_send_message' && item.workItemId === workItem.id));
    const entries = await readJsonLines(logPath);
    assert.ok(entries.some((item) => item.mode === 'app-server'));
    assert.equal(entries.some((item) => item.mode === 'exec'), false);
  } finally {
    await server.stop();
    await rm(fakeCodexDir, { recursive: true, force: true });
  }
});

test('Codex app-server dynamic tool call requests execute MagClaw MCP tools', async () => {
  const fakeCodexDir = await mkdtemp(path.join(os.tmpdir(), 'magclaw-fake-dynamic-tool-'));
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
    fs.writeFileSync(outputPath, 'legacy fallback should not run for dynamic tool call');
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
    if (message.id === 99 && message.result) {
      log({ dynamicToolResponse: message.result });
      send({
        method: 'item/completed',
        params: {
          item: {
            id: 'call_dynamic_send',
            type: 'mcpToolCall',
            server: 'magclaw',
            tool: 'send_message',
            status: 'completed',
            arguments: message.params?.arguments || {},
            result: message.result,
          },
        },
      });
      send({ method: 'turn/completed', params: { turn: { id: 'turn_dynamic_tool', status: 'completed' } } });
      return;
    }
    if (message.method === 'initialize') {
      send({ id: message.id, result: {} });
      return;
    }
    if (message.method === 'initialized') return;
    if (message.method === 'thread/start') {
      send({ id: message.id, result: { thread: { id: 'thread_dynamic_tool' } } });
      return;
    }
    if (message.method === 'thread/resume') {
      send({ id: message.id, result: { thread: { id: message.params.threadId } } });
      return;
    }
    if (message.method === 'turn/start') {
      const prompt = message.params?.input?.[0]?.text || '';
      const workItemId = /workItem=(wi_[a-z0-9]+)/.exec(prompt)?.[1] || '';
      const target = /target=([^\\s\\]]+)/.exec(prompt)?.[1] || '#all';
      const toolArgs = {
        workItemId,
        target,
        content: 'dynamic tool routed reply',
      };
      send({ id: message.id, result: { turn: { id: 'turn_dynamic_tool' } } });
      send({ method: 'turn/started', params: { turn: { id: 'turn_dynamic_tool' } } });
      setTimeout(() => {
        send({
          method: 'item/started',
          params: {
            item: {
              id: 'call_dynamic_send',
              type: 'mcpToolCall',
              server: 'magclaw',
              tool: 'send_message',
              status: 'inProgress',
              arguments: toolArgs,
            },
          },
        });
        send({
          id: 99,
          method: 'item/tool/call',
          params: {
            callId: 'call_dynamic_send',
            turnId: 'turn_dynamic_tool',
            name: 'send_message',
            arguments: toolArgs,
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
      body: JSON.stringify({ body: '<@agt_codex> 用动态 tool call 回复', attachmentIds: [] }),
    });

    const finalState = await waitFor(async () => {
      const state = await request(server.baseUrl, '/api/state');
      const replied = state.replies.some((item) => item.parentMessageId === created.message.id && item.body.includes('dynamic tool routed reply'));
      const agent = state.agents.find((item) => item.id === 'agt_codex');
      return replied && agent?.status === 'idle' ? state : null;
    }, 6000);
    assert.ok(finalState, JSON.stringify((await request(server.baseUrl, '/api/state')).events.slice(-20), null, 2));
    const workItem = finalState.workItems.find((item) => item.sourceMessageId === created.message.id && item.agentId === 'agt_codex');
    assert.equal(workItem.status, 'responded');
    assert.ok(finalState.events.some((item) => item.type === 'agent_dynamic_tool_call_started' && item.toolCallId === 'call_dynamic_send'));
    assert.ok(finalState.events.some((item) => item.type === 'agent_dynamic_tool_call_completed' && item.toolCallId === 'call_dynamic_send'));
    assert.ok(finalState.events.some((item) => item.type === 'agent_mcp_tool_call_completed' && item.toolCallId === 'call_dynamic_send'));
    assert.ok(finalState.events.some((item) => item.type === 'agent_tool_send_message' && item.workItemId === workItem.id));
    assert.equal(finalState.events.some((item) => item.type === 'agent_send_message_watchdog_timeout'), false);
    const entries = await readJsonLines(logPath);
    assert.ok(entries.some((item) => item.dynamicToolResponse?.contentItems?.[0]?.type === 'inputText'
      && item.dynamicToolResponse.contentItems[0].text.includes('Message sent')));
    assert.equal(entries.some((item) => item.mode === 'exec'), false);
  } finally {
    await server.stop();
    await rm(fakeCodexDir, { recursive: true, force: true });
  }
});

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

test('Codex app-server watchdog emits Slock-style activity heartbeat and runtime stalled events without killing the turn', async () => {
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

test('agent start and restart modes follow Slock-style session and workspace rules', async () => {
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

test('scoped stop cancels current channel work without stopping queued work in another channel', async () => {
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
        && stoppedItem?.status === 'cancelled'
        && otherItem?.status === 'responded'
        ? snapshot
        : null;
    }, 8000);

    assert.ok(finalState, JSON.stringify(lastScopedStopSnapshot));
    const stoppedItem = finalState.workItems.find((item) => item.sourceMessageId === stoppedChannel.message.id);
    const otherItem = finalState.workItems.find((item) => item.sourceMessageId === otherChannel.message.id);
    assert.equal(stoppedItem?.status, 'cancelled');
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
