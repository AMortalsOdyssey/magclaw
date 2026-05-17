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
    taskIsClosed: (task) => ['done', 'closed', 'stopped'].includes(task.status),
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

test('task route group pages tasks with space and status filters', async () => {
  const deps = routeDeps();
  deps.state.tasks = [
    { id: 'task_old', title: 'Old', status: 'todo', spaceType: 'channel', spaceId: 'chan_all', updatedAt: '2026-05-01T00:00:00.000Z' },
    { id: 'task_mid', title: 'Mid', status: 'todo', spaceType: 'channel', spaceId: 'chan_all', updatedAt: '2026-05-02T00:00:00.000Z' },
    { id: 'task_new', title: 'New', status: 'todo', spaceType: 'channel', spaceId: 'chan_all', updatedAt: '2026-05-03T00:00:00.000Z' },
    { id: 'task_done', title: 'Done', status: 'done', spaceType: 'channel', spaceId: 'chan_all', updatedAt: '2026-05-04T00:00:00.000Z' },
  ];
  const res = makeResponse();

  const handled = await handleTaskApi(
    { method: 'GET' },
    res,
    new URL('http://local/api/tasks?spaceType=channel&spaceId=chan_all&status=todo&limit=2'),
    deps,
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.data.tasks.map((task) => task.id), ['task_new', 'task_mid']);
  assert.equal(res.data.pagination.hasMore, true);
  assert.equal(res.data.pagination.nextBefore, '2026-05-02T00:00:00.000Z');
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

test('task route group records direct manual status transitions in the task timeline', async () => {
  const timeline = [];
  const deps = routeDeps({
    addTaskTimelineMessage: (task, body, eventType) => {
      timeline.push({ taskId: task.id, body, eventType });
    },
    readJson: async () => ({ status: 'in_progress' }),
  });
  const res = makeResponse();
  const handled = await handleTaskApi(
    { method: 'PATCH' },
    res,
    new URL('http://local/api/tasks/task_1'),
    deps,
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(deps.state.tasks[0].status, 'in_progress');
  assert.equal(deps.state.tasks[0].updatedAt, deps.now());
  assert.deepEqual(timeline, [{
    taskId: 'task_1',
    body: '📌 hum_local moved #1 to In Progress',
    eventType: 'task_progress',
  }]);
  assert.ok(deps.state.tasks[0].history.some((item) => item.type === 'status_changed'));
});

test('task route group closes tasks without review and keeps closed terminal', async () => {
  const deps = routeDeps({ readJson: async () => ({ status: 'closed' }) });
  const res = makeResponse();
  const handled = await handleTaskApi(
    { method: 'PATCH' },
    res,
    new URL('http://local/api/tasks/task_1'),
    deps,
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(deps.state.tasks[0].status, 'closed');
  assert.equal(deps.state.tasks[0].closedAt, deps.now());
  assert.ok(deps.state.tasks[0].history.some((item) => item.type === 'closed'));

  const claimRes = makeResponse();
  await handleTaskApi(
    { method: 'POST' },
    claimRes,
    new URL('http://local/api/tasks/task_1/claim'),
    {
      ...deps,
      claimTask: (task) => {
        if (deps.taskIsClosed(task)) {
          const error = new Error('Closed task cannot be claimed.');
          error.status = 409;
          throw error;
        }
      },
      readJson: async () => ({ actorId: 'agt_codex' }),
    },
  );
  assert.equal(claimRes.statusCode, 409);

  const runRes = makeResponse();
  await handleTaskApi(
    { method: 'POST' },
    runRes,
    new URL('http://local/api/tasks/task_1/run-codex'),
    deps,
  );
  assert.equal(runRes.statusCode, 409);

  const reopenRes = makeResponse();
  await handleTaskApi(
    { method: 'POST' },
    reopenRes,
    new URL('http://local/api/tasks/task_1/reopen'),
    deps,
  );
  assert.equal(reopenRes.statusCode, 200);
  assert.equal(deps.state.tasks[0].status, 'todo');
  assert.equal(deps.state.tasks[0].closedAt, null);
});

test('task route group supports explicit close endpoint', async () => {
  const deps = routeDeps();
  deps.state.tasks[0].status = 'in_progress';
  deps.state.tasks[0].claimedBy = 'agt_codex';
  deps.state.tasks[0].reviewRequestedAt = deps.now();
  const res = makeResponse();
  const handled = await handleTaskApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/tasks/task_1/close'),
    deps,
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.data.task.status, 'closed');
  assert.equal(res.data.task.reviewRequestedAt, null);
  assert.equal(res.data.task.closedAt, deps.now());
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
