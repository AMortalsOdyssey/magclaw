import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

async function createHarness(initialState = {}) {
  const source = await readFile(new URL('../public/app/state-sync.js', import.meta.url), 'utf8');
  const rafQueue = [];
  const canceledFrames = new Set();
  const updates = [];
  const context = {
    appState: {
      messages: [],
      replies: [],
      tasks: [],
      agents: [],
      humans: [],
      ...initialState,
    },
    window: {
      requestAnimationFrame(callback) {
        const id = rafQueue.length + 1;
        rafQueue.push({ id, callback });
        return id;
      },
      cancelAnimationFrame(id) {
        canceledFrames.add(id);
      },
    },
  };
  context.applyStateUpdate = (nextState) => {
    updates.push(nextState);
    context.appState = nextState;
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return {
    context,
    updates,
    flushFrames() {
      const queued = rafQueue.splice(0, rafQueue.length);
      for (const frame of queued) {
        if (!canceledFrames.has(frame.id)) frame.callback();
      }
    },
  };
}

test('state sync queue coalesces high-frequency browser updates into one apply', async () => {
  const { context, updates, flushFrames } = await createHarness({ updatedAt: 'base' });

  for (let index = 1; index <= 100; index += 1) {
    assert.equal(context.queueStateUpdate({ ...context.pendingStateUpdateBase(), updatedAt: `burst-${index}` }), true);
  }

  assert.equal(updates.length, 0);
  assert.equal(context.pendingStateUpdateBase().updatedAt, 'burst-100');

  flushFrames();

  assert.equal(updates.length, 1);
  assert.equal(context.appState.updatedAt, 'burst-100');
  assert.equal(context.pendingStateUpdateBase(), context.appState);
});

test('state sync immediate updates clear a queued frame before applying', async () => {
  const { context, updates, flushFrames } = await createHarness({ updatedAt: 'base' });

  context.queueStateUpdate({ ...context.appState, updatedAt: 'queued' });
  context.queueStateUpdate({ ...context.appState, updatedAt: 'immediate' }, { immediate: true });
  flushFrames();

  assert.equal(updates.length, 1);
  assert.equal(context.appState.updatedAt, 'immediate');
});

test('state sync normalizes tuple bootstrap directories before applying', async () => {
  const { context, updates } = await createHarness();
  const createdAt = '2026-05-18T00:00:00.000Z';

  context.queueStateUpdate({
    bootstrap: { directoryFormat: 'tuple-v1' },
    agents: [[
      'agt_public',
      'Public Agent',
      'Shown in members',
      'working',
      'codex',
      'gpt-test',
      createdAt,
      ['wi_1'],
    ]],
    humans: [['hum_1', 'Human One', 'owner', 'online', createdAt]],
    cloud: {
      members: [[
        'mem_1',
        'usr_1',
        'hum_1',
        { email: 'human@example.test' },
        'owner',
      ]],
    },
    messages: [],
    replies: [],
    tasks: [],
  }, { immediate: true });

  assert.equal(updates.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(context.appState.agents[0])), {
    id: 'agt_public',
    name: 'Public Agent',
    description: 'Shown in members',
    status: 'working',
    runtime: 'codex',
    model: 'gpt-test',
    createdAt,
    activeWorkItemIds: ['wi_1'],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context.appState.humans[0])), {
    id: 'hum_1',
    name: 'Human One',
    role: 'owner',
    status: 'online',
    createdAt,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(context.appState.cloud.members[0])), {
    id: 'mem_1',
    userId: 'usr_1',
    humanId: 'hum_1',
    user: { email: 'human@example.test' },
    role: 'owner',
  });
});

test('state sync preserves hydrated full directory across partial bootstrap refreshes', async () => {
  const { context } = await createHarness({
    bootstrap: {
      directory: {
        scope: 'full',
        agents: { loaded: 2, total: 2, hasMore: false },
        humans: { loaded: 2, total: 2, hasMore: false },
        members: { loaded: 2, total: 2, hasMore: false },
      },
    },
    agents: [
      { id: 'agt_visible', name: 'Visible Agent', status: 'working' },
      { id: 'agt_hidden', name: 'Hidden Agent', status: 'idle' },
    ],
    humans: [
      { id: 'hum_1', name: 'Current Human' },
      { id: 'hum_hidden', name: 'Hidden Human' },
    ],
    cloud: {
      members: [
        { id: 'mem_1', humanId: 'hum_1', userId: 'usr_1' },
        { id: 'mem_hidden', humanId: 'hum_hidden', userId: 'usr_hidden' },
      ],
    },
  });

  const partialRefresh = context.preserveLoadedDirectorySnapshot(context.appState, {
    bootstrap: {
      directory: {
        scope: 'visible',
        agents: { loaded: 1, total: 2, hasMore: true },
        humans: { loaded: 1, total: 2, hasMore: true },
        members: { loaded: 1, total: 2, hasMore: true },
      },
    },
    agents: [{ id: 'agt_visible', name: 'Visible Agent', status: 'idle' }],
    humans: [{ id: 'hum_1', name: 'Current Human Updated' }],
    cloud: { members: [{ id: 'mem_1', humanId: 'hum_1', userId: 'usr_1', role: 'owner' }] },
  });

  assert.equal(partialRefresh.bootstrap.directory.scope, 'full');
  assert.deepEqual(JSON.parse(JSON.stringify(partialRefresh.agents.map((agent) => [agent.id, agent.status]))), [
    ['agt_visible', 'idle'],
    ['agt_hidden', 'idle'],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(partialRefresh.humans.map((human) => [human.id, human.name]))), [
    ['hum_1', 'Current Human Updated'],
    ['hum_hidden', 'Hidden Human'],
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(partialRefresh.cloud.members.map((member) => [member.id, member.role || 'member']))), [
    ['mem_1', 'owner'],
    ['mem_hidden', 'member'],
  ]);
});

test('submitted conversation merge replaces optimistic messages and replies without double counts', async () => {
  const { context, updates } = await createHarness({
    messages: [{
      id: 'msg_parent',
      createdAt: '2026-05-22T09:00:00.000Z',
      replyCount: 0,
      updatedAt: '2026-05-22T09:00:00.000Z',
    }],
    replies: [],
    tasks: [],
  });

  assert.equal(context.applySubmittedConversationResult({
    reply: {
      id: 'local_rep_1',
      optimistic: true,
      parentMessageId: 'msg_parent',
      body: 'draft',
      createdAt: '2026-05-22T09:01:00.000Z',
    },
  }), true);
  assert.equal(context.appState.messages[0].replyCount, 1);

  assert.equal(context.applySubmittedConversationResult({
    reply: {
      id: 'rep_server_1',
      parentMessageId: 'msg_parent',
      body: 'server',
      createdAt: '2026-05-22T09:02:00.000Z',
    },
  }, { removeOptimisticId: 'local_rep_1' }), true);

  assert.equal(updates.length, 2);
  assert.deepEqual([...context.appState.replies.map((reply) => reply.id)], ['rep_server_1']);
  assert.equal(context.appState.messages[0].replyCount, 1);
  assert.equal(context.appState.replies.some((reply) => reply.optimistic), false);
});

test('submitted reply merge normalizes malformed conversation arrays', async () => {
  const { context } = await createHarness({
    messages: [{
      id: 'msg_parent',
      createdAt: '2026-05-22T09:00:00.000Z',
      replyCount: 0,
      updatedAt: '2026-05-22T09:00:00.000Z',
    }],
    replies: { stale: true },
    tasks: null,
  });

  assert.equal(context.applySubmittedConversationResult({
    reply: {
      id: 'rep_server_1',
      parentMessageId: 'msg_parent',
      body: 'server',
      createdAt: '2026-05-22T09:02:00.000Z',
    },
  }), true);

  assert.deepEqual([...context.appState.replies.map((reply) => reply.id)], ['rep_server_1']);
  assert.deepEqual([...context.appState.tasks], []);
  assert.equal(context.appState.messages[0].replyCount, 1);
});

test('submitted task merge updates task state and links the backing message', async () => {
  const { context } = await createHarness({
    messages: [{
      id: 'msg_task',
      createdAt: '2026-05-22T09:00:00.000Z',
      updatedAt: '2026-05-22T09:00:00.000Z',
    }],
    tasks: [{ id: 'task_1', status: 'todo', messageId: 'msg_task' }],
  });

  assert.equal(context.applySubmittedConversationResult({
    task: {
      id: 'task_1',
      status: 'in_progress',
      messageId: 'msg_task',
      updatedAt: '2026-05-22T09:03:00.000Z',
    },
  }), true);

  assert.equal(context.appState.tasks.length, 1);
  assert.equal(context.appState.tasks[0].status, 'in_progress');
  assert.equal(context.appState.messages[0].taskId, 'task_1');
  assert.equal(context.appState.messages[0].updatedAt, '2026-05-22T09:03:00.000Z');
});
