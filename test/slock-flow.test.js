import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, cp, lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
let nextTestPort = 5600 + Math.floor(Math.random() * 1000);

async function startIsolatedServer(extraEnv = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-slock-flow-'));
  await mkdir(path.join(tmp, 'public'), { recursive: true });
  await cp(path.join(ROOT, 'server'), path.join(tmp, 'server'), { recursive: true });
  await cp(path.join(ROOT, 'public', 'index.html'), path.join(tmp, 'public', 'index.html'));
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

  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/state`);
      if (response.ok) {
        return {
          baseUrl,
          tmp,
          async stop() {
            child.kill('SIGINT');
            await new Promise((resolve) => child.once('exit', resolve));
            await rm(tmp, { recursive: true, force: true });
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

test('thread stop intent cancels only that task work and lets other queued work continue', async () => {
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
    assert.equal(stopped.stoppedTask.status, 'cancelled');

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
    assert.equal(task.status, 'cancelled');
    assert.match(task.cancelledAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(task.history.some((item) => item.type === 'cancelled_from_thread'));
    const taskReplies = finalState.replies.filter((reply) => reply.parentMessageId === taskMessage.message.id);
    assert.ok(taskReplies.some((reply) => reply.body === 'Task stopped from thread request.'));
    const stoppedItem = finalState.workItems.find((item) => item.sourceMessageId === taskMessage.message.id);
    const otherItem = finalState.workItems.find((item) => item.sourceMessageId === otherMessage.message.id);
    assert.equal(stoppedItem?.status, 'cancelled');
    assert.equal(otherItem?.status, 'responded');
  } finally {
    await server.stop();
    await rm(fakeCodexDir, { recursive: true, force: true });
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
    assert.match(memory.file.absolutePath, /\.magclaw\/agents\/agt_codex\/MEMORY\.md$/);
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
    assert.match(config, /memories\s*=\s*false/);
    await assert.rejects(lstat(path.join(codexHome, 'plugins')), /ENOENT/);

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

    const finalState = await waitFor(async () => {
      const snapshot = await request(server.baseUrl, '/api/state');
      const stoppedReplies = snapshot.replies.filter((reply) => reply.parentMessageId === stoppedChannel.message.id);
      const otherReplies = snapshot.replies.filter((reply) => reply.parentMessageId === otherChannel.message.id);
      const agent = snapshot.agents.find((item) => item.id === 'agt_codex');
      return otherReplies.some((reply) => reply.body.includes('other channel survived scoped stop'))
        && !stoppedReplies.some((reply) => reply.body.includes('stopped channel should not reply'))
        && agent?.status === 'idle'
        ? snapshot
        : null;
    }, 8000);

    assert.ok(finalState);
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
