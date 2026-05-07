import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAgentToolApi } from '../server/api/agent-tool-routes.js';

function makeResponse() {
  return {
    statusCode: null,
    data: null,
    error: null,
  };
}

function routeDeps(overrides = {}) {
  const state = {
    agents: [],
    tasks: [],
    reminders: [],
    messages: [{ id: 'msg_1', body: 'source', authorType: 'human', spaceType: 'channel', spaceId: 'chan_all' }],
  };
  const agent = { id: 'agt_one', name: 'Agent One' };
  const events = [];
  const memoryWrites = [];
  return {
    addSystemEvent: (type, message, extra = {}) => events.push({ type, message, extra }),
    broadcastState: () => {},
    claimTask: (task, agentId) => {
      task.claimedBy = agentId;
      return task;
    },
    createTaskFromMessage: (message, title) => ({ id: 'task_from_message', title, sourceMessageId: message.id }),
    createTaskMessage: ({ title, assigneeIds }) => {
      const task = { id: 'task_1', number: 1, title, status: 'todo', assigneeIds };
      const message = { id: 'msg_task_1', taskId: task.id };
      return { task, message };
    },
    createReminder: (input) => {
      const reminder = {
        id: 'rem_1',
        title: input.title,
        status: 'scheduled',
        fireAt: input.fireAt,
        ownerAgentId: input.agentId,
        spaceType: 'channel',
        spaceId: 'chan_all',
        parentMessageId: input.parentMessageId || null,
      };
      state.reminders.unshift(reminder);
      return { reminder, text: `Scheduled reminder ${reminder.id}.` };
    },
    cancelReminder: (input) => {
      const reminder = state.reminders.find((item) => item.id === input.reminderId);
      if (!reminder) throw Object.assign(new Error('Reminder not found.'), { status: 404 });
      reminder.status = 'canceled';
      return { reminder, text: `Canceled reminder ${reminder.id}.` };
    },
    displayActor: (id) => id,
    findAgent: (agentId) => (agentId === agent.id ? agent : state.agents.find((item) => item.id === agentId) || null),
    findConversationRecord: (id) => state.messages.find((message) => message.id === id),
    findMessage: (id) => state.messages.find((message) => message.id === id),
    findTaskForAgentTool: () => ({ id: 'task_update', status: 'todo' }),
    findWorkItem: () => null,
    formatAgentHistory: () => 'formatted history',
    formatAgentSearchResults: () => 'formatted search',
    getState: () => state,
    httpError: (status, message) => Object.assign(new Error(message), { status }),
    markWorkItemResponded: () => {},
    normalizeIds: (items) => [...new Set((items || []).filter(Boolean).map(String))],
    persistState: async () => {},
    postAgentResponse: async () => ({ id: 'rep_1' }),
    readAgentHistory: () => ({ ok: true, target: '#all', messages: [] }),
    readAgentMemoryFile: async () => ({ file: { path: 'MEMORY.md', content: '# Agent One\n' } }),
    readJson: async () => ({}),
    resolveConversationSpace: () => ({ spaceType: 'channel', spaceId: 'chan_all', label: 'channel:chan_all' }),
    resolveMessageTarget: () => ({ spaceType: 'channel', spaceId: 'chan_all', parentMessageId: null, label: 'channel:chan_all' }),
    searchAgentMessageHistory: () => ({ ok: true, results: [] }),
    searchAgentMemory: async () => ({ ok: true, query: 'bug', results: [] }),
    sendError: (res, statusCode, message) => {
      res.statusCode = statusCode;
      res.error = message;
    },
    sendJson: (res, statusCode, data) => {
      res.statusCode = statusCode;
      res.data = data;
    },
    taskLabel: (task) => `#${task.number || task.id}`,
    updateTaskForAgent: (task, _agent, status) => {
      task.status = status;
    },
    writeAgentMemoryUpdate: async (targetAgent, trigger, payload) => memoryWrites.push({ targetAgent, trigger, payload }),
    workItemTargetMatches: () => true,
    agent,
    events,
    memoryWrites,
    state,
    ...overrides,
  };
}

test('agent tool reminders can schedule, list, and cancel timed reminders', async () => {
  const deps = routeDeps({
    readJson: async () => ({
      agentId: 'agt_one',
      target: '#all:msg_1',
      title: '提醒我带笔记本',
      delaySeconds: 300,
    }),
  });

  const scheduleRes = makeResponse();
  assert.equal(await handleAgentToolApi(
    { method: 'POST' },
    scheduleRes,
    new URL('http://local/api/agent-tools/reminders'),
    deps,
  ), true);
  assert.equal(scheduleRes.statusCode, 201);
  assert.equal(scheduleRes.data.reminder.title, '提醒我带笔记本');
  assert.equal(deps.state.reminders[0].status, 'scheduled');

  const listRes = makeResponse();
  assert.equal(await handleAgentToolApi(
    { method: 'GET' },
    listRes,
    new URL('http://local/api/agent-tools/reminders?agentId=agt_one&status=scheduled'),
    deps,
  ), true);
  assert.equal(listRes.statusCode, 200);
  assert.equal(listRes.data.reminders.length, 1);
  assert.match(listRes.data.text, /提醒我带笔记本/);

  const cancelDeps = {
    ...deps,
    readJson: async () => ({ agentId: 'agt_one', reminderId: 'rem_1' }),
  };
  const cancelRes = makeResponse();
  assert.equal(await handleAgentToolApi(
    { method: 'POST' },
    cancelRes,
    new URL('http://local/api/agent-tools/reminders/cancel'),
    cancelDeps,
  ), true);
  assert.equal(cancelRes.statusCode, 200);
  assert.equal(deps.state.reminders[0].status, 'canceled');
});

test('agent tool route group formats bounded history reads', async () => {
  const deps = routeDeps();
  const res = makeResponse();
  const handled = await handleAgentToolApi(
    { method: 'GET' },
    res,
    new URL('http://local/api/agent-tools/history?agentId=agt_one&target=%23all'),
    deps,
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.data.text, 'formatted history');
  assert.equal(deps.events[0].type, 'agent_history_read');
});

test('agent tool send_message rejects stopped work before posting', async () => {
  const deps = routeDeps({
    findWorkItem: () => ({
      id: 'work_1',
      agentId: 'agt_one',
      status: 'stopped',
      target: { spaceType: 'channel', spaceId: 'chan_all' },
    }),
    readJson: async () => ({
      agentId: 'agt_one',
      workItemId: 'work_1',
      content: 'hello',
    }),
  });
  const res = makeResponse();
  const handled = await handleAgentToolApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/agent-tools/messages/send'),
    deps,
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 409);
});

test('agent tool task creation merges assignees and can claim created work', async () => {
  const deps = routeDeps({
    readJson: async () => ({
      agentId: 'agt_one',
      title: 'Prepare notes',
      assigneeIds: ['agt_two'],
      claim: true,
    }),
  });
  const res = makeResponse();
  const handled = await handleAgentToolApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/agent-tools/tasks'),
    deps,
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.data.tasks[0].task.assigneeIds, ['agt_two', 'agt_one']);
  assert.equal(res.data.tasks[0].task.claimedBy, 'agt_one');
});

test('agent tool memory endpoint records controlled memory writebacks', async () => {
  const deps = routeDeps({
    readJson: async () => ({
      agentId: 'agt_one',
      kind: 'communication_style',
      summary: '学习马斯克 X 推文语气，按用户要求使用',
      messageId: 'msg_1',
    }),
  });
  const res = makeResponse();
  const handled = await handleAgentToolApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/agent-tools/memory'),
    deps,
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(deps.memoryWrites[0].trigger, 'agent_memory_tool');
  assert.equal(deps.memoryWrites[0].payload.memory.kind, 'communication_style');
  assert.equal(deps.memoryWrites[0].payload.message.id, 'msg_1');
});

test('agent tool memory search and read expose peer notes through controlled APIs', async () => {
  const deps = routeDeps({
    searchAgentMemory: async (query, options) => ({
      ok: true,
      query,
      terms: ['bug', '修复'],
      results: [{
        agentId: 'agt_two',
        agentName: 'Bug Fixer',
        agentDescription: 'General helper',
        path: 'notes/work-log.md',
        line: 4,
        score: 8,
        matchedTerms: ['bug', '修复'],
        preview: '- 修复登录 bug 并补测试',
      }],
      truncated: false,
      options,
    }),
    readAgentMemoryFile: async (targetAgent, relPath) => ({
      file: {
        path: relPath,
        content: '# Bug Fixer Work Log\n- 修复登录 bug 并补测试\n',
      },
    }),
  });
  deps.state.agents.push({ id: 'agt_two', name: 'Bug Fixer' });

  const searchRes = makeResponse();
  assert.equal(await handleAgentToolApi(
    { method: 'GET' },
    searchRes,
    new URL('http://local/api/agent-tools/memory/search?agentId=agt_one&q=bug%20%E4%BF%AE%E5%A4%8D&limit=5'),
    deps,
  ), true);
  assert.equal(searchRes.statusCode, 200);
  assert.equal(searchRes.data.results[0].agentId, 'agt_two');
  assert.match(searchRes.data.text, /notes\/work-log\.md:4/);

  const readRes = makeResponse();
  assert.equal(await handleAgentToolApi(
    { method: 'GET' },
    readRes,
    new URL('http://local/api/agent-tools/memory/read?agentId=agt_one&targetAgentId=agt_two&path=notes/work-log.md'),
    deps,
  ), true);
  assert.equal(readRes.statusCode, 200);
  assert.match(readRes.data.text, /修复登录 bug/);
});
