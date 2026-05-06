import test from 'node:test';
import assert from 'node:assert/strict';
import { handleTaskApi } from '../server/api/task-routes.js';

function makeResponse() {
  return {
    statusCode: null,
    data: null,
    error: null,
  };
}

function routeDeps(overrides = {}) {
  const state = {
    settings: { defaultWorkspace: '/tmp/workspace' },
    tasks: [{
      id: 'task_1',
      number: 1,
      title: 'Existing task',
      body: 'Existing body',
      status: 'todo',
      assigneeIds: [],
      attachmentIds: [],
      localReferences: [],
    }],
    messages: [{ id: 'msg_1', taskId: 'task_1', body: 'Task source' }],
    missions: [],
    runs: [],
  };
  const deps = {
    addCollabEvent: () => {},
    addSystemReply: () => {},
    addTaskHistory: (task, type, message, actorId, extra = {}) => {
      task.history = [...(task.history || []), { type, message, actorId, ...extra }];
    },
    addTaskTimelineMessage: () => {},
    broadcastState: () => {},
    claimTask: (task, actorId) => {
      task.claimedBy = actorId;
      task.assigneeId = actorId;
      task.assigneeIds = deps.normalizeIds([...(task.assigneeIds || []), actorId]);
      task.claimedAt = deps.now();
      task.status = 'in_progress';
      return task;
    },
    createTaskMessage: (input) => {
      const task = {
        id: 'task_new',
        number: 2,
        title: input.title,
        body: input.body,
        status: input.status,
        assigneeIds: input.assigneeIds,
        attachmentIds: input.attachmentIds,
        localReferences: [],
      };
      const message = { id: 'msg_new', taskId: task.id, body: input.title };
      state.tasks.unshift(task);
      state.messages.unshift(message);
      return { message, task };
    },
    displayActor: (id) => id,
    ensureTaskThread: (task) => ({ id: `thread_${task.id}` }),
    findTask: (id) => state.tasks.find((task) => task.id === id),
    getState: () => state,
    makeId: (prefix) => `${prefix}_new`,
    normalizeIds: (ids) => [...new Set((ids || []).filter(Boolean).map(String))],
    now: () => '2026-05-02T00:00:00.000Z',
    persistState: async () => {},
    readJson: async () => ({}),
    resolveConversationSpace: () => ({ spaceType: 'channel', spaceId: 'chan_all', label: '#all' }),
    root: '/tmp/root',
    sendError: (res, statusCode, message) => {
      res.statusCode = statusCode;
      res.error = message;
    },
    sendJson: (res, statusCode, data) => {
      res.statusCode = statusCode;
      res.data = data;
    },
    startCodexRun: () => {},
    taskIsClosed: (task) => ['done', 'stopped', 'stopped'].includes(task.status),
    taskLabel: (task) => `#${task.number || task.id}`,
  };
  return { ...deps, ...overrides, state };
}

test('task route group ignores unrelated API paths', async () => {
  const res = makeResponse();
  const handled = await handleTaskApi(
    { method: 'GET' },
    res,
    new URL('http://local/api/state'),
    routeDeps(),
  );
  assert.equal(handled, false);
});

test('task route group creates conversation-backed tasks', async () => {
  const deps = routeDeps({
    readJson: async () => ({
      title: 'Write release note',
      body: 'Summarize the change',
      assigneeIds: ['agt_one'],
      assigneeId: 'agt_two',
      attachmentIds: [10, 'att_2'],
    }),
  });
  const res = makeResponse();
  const handled = await handleTaskApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/tasks'),
    deps,
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 201);
  assert.equal(res.data.task.title, 'Write release note');
  assert.deepEqual(res.data.task.assigneeIds, ['agt_one', 'agt_two']);
  assert.deepEqual(res.data.task.attachmentIds, ['10', 'att_2']);
  assert.equal(deps.state.messages[0].taskId, 'task_new');
});

test('task route group rejects done transition before review', async () => {
  const deps = routeDeps({ readJson: async () => ({ status: 'done' }) });
  const res = makeResponse();
  const handled = await handleTaskApi(
    { method: 'PATCH' },
    res,
    new URL('http://local/api/tasks/task_1'),
    deps,
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 409);
  assert.equal(deps.state.tasks[0].status, 'todo');
});

test('task route group auto-claims work before starting a Codex run', async () => {
  let started = null;
  const deps = routeDeps({
    startCodexRun: (mission, run) => {
      started = { mission, run };
    },
  });
  const res = makeResponse();
  const handled = await handleTaskApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/tasks/task_1/run-codex'),
    deps,
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 201);
  assert.equal(deps.state.tasks[0].claimedBy, 'agt_codex');
  assert.equal(deps.state.missions[0].taskId, 'task_1');
  assert.equal(deps.state.runs[0].taskId, 'task_1');
  assert.equal(started.run.id, 'run_new');
});

test('task route group deletes task links from messages', async () => {
  const deps = routeDeps();
  const res = makeResponse();
  const handled = await handleTaskApi(
    { method: 'DELETE' },
    res,
    new URL('http://local/api/tasks/task_1'),
    deps,
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(deps.state.tasks.length, 0);
  assert.equal('taskId' in deps.state.messages[0], false);
});
