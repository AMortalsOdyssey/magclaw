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
    tasks: [],
    messages: [{ id: 'msg_1', body: 'source', authorType: 'human', spaceType: 'channel', spaceId: 'chan_all' }],
  };
  const agent = { id: 'agt_one', name: 'Agent One' };
  const events = [];
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
    displayActor: (id) => id,
    findAgent: (agentId) => (agentId === agent.id ? agent : null),
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
    readJson: async () => ({}),
    resolveConversationSpace: () => ({ spaceType: 'channel', spaceId: 'chan_all', label: 'channel:chan_all' }),
    resolveMessageTarget: () => ({ spaceType: 'channel', spaceId: 'chan_all', parentMessageId: null, label: 'channel:chan_all' }),
    searchAgentMessageHistory: () => ({ ok: true, results: [] }),
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
    workItemTargetMatches: () => true,
    agent,
    events,
    state,
    ...overrides,
  };
}

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

test('agent tool send_message rejects cancelled work before posting', async () => {
  const deps = routeDeps({
    findWorkItem: () => ({
      id: 'work_1',
      agentId: 'agt_one',
      status: 'cancelled',
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
