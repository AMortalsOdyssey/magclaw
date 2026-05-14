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
    }, 8000);
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
    assert.match(capabilityWriteback.memory, /## 能力/);
    assert.match(capabilityWriteback.profile, /优势与技能/);

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
    assert.match(styleWriteback.style, /语气适配/);

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

test('thread agent mention relay ignores descriptive references and keeps explicit handoffs', async () => {
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
      body: JSON.stringify({ name: 'relay-intent', description: 'relay intent', agentIds: [han.id, zhong.id] }),
    });

    const parent = await request(server.baseUrl, `/api/spaces/channel/${channel.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        body: `<@${han.id}> 先聊两句`,
        attachmentIds: [],
      }),
    });

    const hanWorkItem = await waitFor(async () => {
      const snapshot = await request(server.baseUrl, '/api/state');
      return snapshot.workItems.find((item) => item.sourceMessageId === parent.message.id && item.agentId === han.id);
    });
    assert.ok(hanWorkItem);

    const descriptive = await request(server.baseUrl, '/api/agent-tools/messages/send', {
      method: 'POST',
      body: JSON.stringify({
        agentId: han.id,
        workItemId: hanWorkItem.id,
        target: hanWorkItem.target,
        content: `<@${zhong.id}> 读代码挺稳，我负责把闲聊接上。`,
      }),
    });
    assert.equal(descriptive.ok, true);

    await new Promise((resolve) => setTimeout(resolve, 150));
    let snapshot = await request(server.baseUrl, '/api/state');
    assert.equal(snapshot.workItems.some((item) => item.sourceMessageId === descriptive.message.id && item.agentId === zhong.id), false);
    assert.equal(snapshot.events.some((event) => (
      event.type === 'agent_message_relay_suppressed'
      && event.toAgentId === zhong.id
      && event.reason === 'mention_reference'
    )), true);

    const handoff = await request(server.baseUrl, '/api/agent-tools/messages/send', {
      method: 'POST',
      body: JSON.stringify({
        agentId: han.id,
        workItemId: hanWorkItem.id,
        target: hanWorkItem.target,
        content: `我先说一句，<@${zhong.id}> 也可以补充一下。`,
      }),
    });
    assert.equal(handoff.ok, true);

    snapshot = await waitFor(async () => {
      const state = await request(server.baseUrl, '/api/state');
      const workItem = state.workItems.find((item) => item.sourceMessageId === handoff.message.id && item.agentId === zhong.id);
      return workItem ? state : null;
    });
    assert.equal(snapshot.workItems.some((item) => item.sourceMessageId === handoff.message.id && item.agentId === zhong.id), true);
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
    assert.match(memory.file.content, /## 知识索引/);
    assert.match(memory.file.content, /notes\/profile\.md/);
    assert.match(memory.file.content, /notes\/work-log\.md/);
    assert.match(memory.file.content, /## 当前上下文/);
    assert.doesNotMatch(memory.file.content, /## Collaboration Rules/);
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
if (args[0] === '--version') {
  process.stdout.write('codex-cli fake\\n');
  process.exit(0);
}
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
  const server = await startIsolatedServer({ MAGCLAW_CODEX_PATH: fakeCodexPath });
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
    assert.equal(finalState.settings.codexPath, fakeCodexPath);
    assert.ok(finalState.events.some((event) => (
      event.type === 'codex_path_repaired'
      && event.agentId === 'agt_codex'
    )));
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
    assert.match(config, new RegExp(`\\[projects\\.${JSON.stringify(os.homedir()).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`));
    assert.match(config, /trust_level\s*=\s*"trusted"/);
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
