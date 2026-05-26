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

async function waitForCondition(fn, timeoutMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return false;
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

test('task route group starts selected agents as sequential owner and collaborators', async () => {
  const deliveries = [];
  const routeCalls = [];
  const workItems = [];
  const deps = routeDeps({
    readJson: async () => ({
      title: 'Refine task fanout',
      assigneeIds: ['agt_owner', 'agt_peer', 'agt_third'],
      spaceType: 'channel',
      spaceId: 'chan_all',
    }),
    findAgent: (id) => ({
      id,
      name: id === 'agt_owner' ? 'Owner Agent' : (id === 'agt_peer' ? 'Peer Agent' : 'Third Agent'),
      status: 'idle',
    }),
    routeTaskAssignees: async ({ task, message, selectedAgents, maxParticipants }) => {
      routeCalls.push({
        taskId: task.id,
        messageId: message.id,
        selectedAgentIds: selectedAgents.map((agent) => agent.id),
        maxParticipants,
      });
      return {
        ownerAgentId: 'agt_owner',
        collaboratorAgentIds: ['agt_peer', 'agt_third'],
        participantAgentIds: ['agt_owner', 'agt_peer', 'agt_third'],
        cappedAgentIds: [],
        routeEvent: {
          id: 'route_task_owner',
          strategy: 'fanout',
          selectedAgentIds: ['agt_owner', 'agt_peer', 'agt_third'],
          ownerAgentId: 'agt_owner',
          collaboratorAgentIds: ['agt_peer', 'agt_third'],
        },
      };
    },
    taskAssignmentDeliveryMessage: (task, sourceMessage, { recipientAgent, role, ownerAgent, collaboratorAgents }) => ({
      ...sourceMessage,
      id: `${sourceMessage.id}_${recipientAgent.id}_${role}`,
      taskId: task.id,
      mentionedAgentIds: [recipientAgent.id],
      body: [
        `Task #${task.number}: ${task.title}`,
        `Role: ${role}`,
        `Owner: ${ownerAgent.name}`,
        `Collaborators: ${collaboratorAgents.map((agent) => agent.name).join(', ') || 'none'}`,
        `workItem/task: ${task.id}`,
      ].join('\n'),
    }),
    deliverMessageToAgent: async (agent, spaceType, spaceId, message, options) => {
      const workItem = { id: `wi_${agent.id}`, agentId: agent.id, status: 'delivered' };
      workItems.push(workItem);
      deliveries.push({ agent, spaceType, spaceId, message, options, workItem });
      return workItem;
    },
    taskStartupWaitMs: 200,
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
  assert.deepEqual(routeCalls, [{
    taskId: 'task_new',
    messageId: 'msg_new',
    selectedAgentIds: ['agt_owner', 'agt_peer', 'agt_third'],
    maxParticipants: 4,
  }]);
  assert.equal(res.data.task.claimedBy, 'agt_owner');
  assert.equal(res.data.task.status, 'in_progress');
  assert.deepEqual(res.data.task.assigneeIds, ['agt_peer', 'agt_third']);
  assert.equal(deliveries.length, 1);
  assert.deepEqual(deliveries.map((item) => item.agent.id), ['agt_owner']);
  assert.ok(deliveries.every((item) => item.options.parentMessageId === 'msg_new'));
  assert.match(deliveries[0].message.body, /Role: owner/);
  workItems[0].status = 'responded';
  assert.equal(await waitForCondition(() => deliveries.length === 2), true);
  assert.match(deliveries[1].message.body, /Role: collaborator/);
  assert.match(deliveries[1].message.body, /Owner: Owner Agent/);
  workItems[1].status = 'responded';
  assert.equal(await waitForCondition(() => deliveries.length === 3), true);
  assert.match(deliveries[2].message.body, /Role: collaborator/);
  assert.deepEqual(deliveries.map((item) => item.agent.id), ['agt_owner', 'agt_peer', 'agt_third']);
  assert.ok(res.data.task.history.some((item) => item.type === 'task_owner_selected'));
  assert.equal(res.data.task.metadata.startupCollaboration.status, 'running');
  assert.deepEqual(res.data.task.metadata.startupCollaboration.participantAgentIds, ['agt_owner', 'agt_peer', 'agt_third']);
});

test('task route group caps startup collaborators and continues after timeout', async () => {
  const deliveries = [];
  const deps = routeDeps({
    readJson: async () => ({
      title: 'Cap startup speakers',
      assigneeIds: ['agt_owner', 'agt_a', 'agt_b', 'agt_c', 'agt_d'],
      spaceType: 'channel',
      spaceId: 'chan_all',
    }),
    findAgent: (id) => ({ id, name: id.replace('agt_', '').toUpperCase(), status: 'idle' }),
    routeTaskAssignees: async () => ({
      ownerAgentId: 'agt_owner',
      collaboratorAgentIds: ['agt_a', 'agt_b', 'agt_c'],
      participantAgentIds: ['agt_owner', 'agt_a', 'agt_b', 'agt_c'],
      cappedAgentIds: ['agt_d'],
      routeEvent: {
        id: 'route_capped',
        strategy: 'fallback_rules',
        selectedAgentIds: ['agt_owner', 'agt_a', 'agt_b', 'agt_c', 'agt_d'],
        ownerAgentId: 'agt_owner',
        collaboratorAgentIds: ['agt_a', 'agt_b', 'agt_c'],
        cappedAgentIds: ['agt_d'],
      },
    }),
    taskAssignmentDeliveryMessage: (task, sourceMessage, { recipientAgent, role }) => ({
      ...sourceMessage,
      id: `${sourceMessage.id}_${recipientAgent.id}_${role}`,
      taskId: task.id,
      mentionedAgentIds: [recipientAgent.id],
      body: `Role: ${role}`,
    }),
    deliverMessageToAgent: async (agent, spaceType, spaceId, message, options) => {
      const workItem = { id: `wi_${agent.id}`, agentId: agent.id, status: 'delivered' };
      deliveries.push({ agent, spaceType, spaceId, message, options, workItem });
      return workItem;
    },
    taskStartupWaitMs: 15,
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
  assert.equal(deliveries.length, 1);
  assert.equal(await waitForCondition(() => deliveries.length === 4, 300), true);
  assert.deepEqual(deliveries.map((item) => item.agent.id), ['agt_owner', 'agt_a', 'agt_b', 'agt_c']);
  assert.deepEqual(res.data.task.assigneeIds, ['agt_a', 'agt_b', 'agt_c']);
  assert.deepEqual(res.data.task.metadata.startupCollaboration.cappedAgentIds, ['agt_d']);
  assert.ok(res.data.task.history.some((item) => item.type === 'task_startup_timeout'));
});

test('task route group keeps selected assignees as todo when no selected owner is available', async () => {
  const deliveries = [];
  const systemEvents = [];
  const deps = routeDeps({
    readJson: async () => ({
      title: 'Need available owner',
      assigneeIds: ['agt_sleeping'],
      spaceType: 'channel',
      spaceId: 'chan_all',
    }),
    findAgent: (id) => ({ id, name: 'Sleeping Agent', status: 'offline' }),
    routeTaskAssignees: async () => ({
      ownerAgentId: null,
      collaboratorAgentIds: [],
      routeEvent: {
        id: 'route_task_skipped',
        strategy: 'none',
        selectedAgentIds: ['agt_sleeping'],
        fallbackReason: 'No selected agents are available.',
      },
    }),
    addSystemEvent: (type, message, extra = {}) => {
      systemEvents.push({ type, message, extra });
    },
    deliverMessageToAgent: async (agent, spaceType, spaceId, message, options) => {
      deliveries.push({ agent, spaceType, spaceId, message, options });
    },
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
  assert.equal(res.data.task.status, 'todo');
  assert.equal(res.data.task.claimedBy || null, null);
  assert.deepEqual(res.data.task.assigneeIds, ['agt_sleeping']);
  assert.equal(deliveries.length, 0);
  assert.ok(res.data.task.history.some((item) => item.type === 'task_dispatch_skipped'));
  assert.deepEqual(systemEvents.map((item) => item.type), ['task_dispatch_skipped']);
});

test('task route group persists known workspace changes with scoped options', async () => {
  const persistCalls = [];
  const deps = routeDeps({
    persistState: async (options = {}) => {
      persistCalls.push(options);
    },
  });
  deps.state.tasks[0].workspaceId = 'wsp_task';
  const res = makeResponse();
  const handled = await handleTaskApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/tasks/task_1/claim'),
    deps,
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(persistCalls, [{ workspaceId: 'wsp_task', reason: 'task_claimed' }]);
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

test('task route group records direct manual status transitions and lets SSE debounce coalesce updates', async () => {
  const timeline = [];
  const broadcastOptions = [];
  const deps = routeDeps({
    addTaskTimelineMessage: (task, body, eventType) => {
      timeline.push({ taskId: task.id, body, eventType });
    },
    broadcastState: (options = {}) => {
      broadcastOptions.push(options);
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
  assert.deepEqual(broadcastOptions, [{}]);
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
