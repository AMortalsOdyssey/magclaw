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
    createTaskMessage: ({ title, assigneeIds, spaceType = 'channel', spaceId = 'chan_all', authorId = agent.id, sourceMessageId = null, sourceReplyId = null }) => {
      const taskNumber = state.tasks.length + 1;
      const task = {
        id: `task_${taskNumber}`,
        number: taskNumber,
        title,
        status: 'todo',
        assigneeIds,
        createdBy: authorId,
        spaceType,
        spaceId,
        sourceMessageId: sourceMessageId || `msg_task_${taskNumber}`,
        sourceReplyId,
        createdAt: `2026-05-14T00:00:0${taskNumber}.000Z`,
        updatedAt: `2026-05-14T00:00:0${taskNumber}.000Z`,
      };
      const message = { id: `msg_task_${taskNumber}`, taskId: task.id, authorType: 'agent', authorId, spaceType, spaceId };
      state.tasks.unshift(task);
      state.messages.push(message);
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
    makeId: (prefix) => `${prefix}_new`,
    markWorkItemResponded: () => {},
    normalizeIds: (items) => [...new Set((items || []).filter(Boolean).map(String))],
    now: () => '2026-05-14T00:01:00.000Z',
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
    submitAgentMarkdownOperation: async () => ({ ok: true, status: 'applied', revision: 1, operationId: 'mdop_test' }),
    taskLabel: (task) => `#${task.number || task.id}`,
    updateTaskForAgent: (task, _agent, status) => {
      task.status = status;
    },
    writeAgentMemoryUpdate: async (targetAgent, trigger, payload) => memoryWrites.push({ targetAgent, trigger, payload }),
    workItemTargetMatches: () => true,
    deliverMessageToAgent: async () => {},
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

test('agent tool writes persist with the daemon workspace scope', async () => {
  const persistCalls = [];
  const deps = routeDeps({
    persistState: async (options = {}) => {
      persistCalls.push(options);
    },
    readJson: async () => ({
      agentId: 'agt_one',
      title: 'Ping standup',
      fireAt: '2026-05-14T01:00:00.000Z',
    }),
  });
  const res = makeResponse();
  const handled = await handleAgentToolApi(
    { method: 'POST', daemonAuth: { workspaceId: 'wsp_test' } },
    res,
    new URL('http://local/api/agent-tools/reminders'),
    deps,
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(persistCalls, [{ workspaceId: 'wsp_test', reason: 'agent_tool_reminder_created' }]);
});

test('agent tool route group formats bounded history reads', async () => {
  let historyOptions = null;
  const deps = routeDeps({
    readAgentHistory: (_state, options) => {
      historyOptions = options;
      return { ok: true, target: '#all', messages: [] };
    },
  });
  const res = makeResponse();
  const handled = await handleAgentToolApi(
    { method: 'GET', daemonAuth: { workspaceId: 'wsp_test' } },
    res,
    new URL('http://local/api/agent-tools/history?agentId=agt_one&target=%23all'),
    deps,
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200, res.error || '');
  assert.equal(res.data.text, 'formatted history');
  assert.equal(historyOptions.workspaceId, 'wsp_test');
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

test('agent tool send_message can proactively DM a visible agent without a work item', async () => {
  const deliveries = [];
  const posted = [];
  const deps = routeDeps({
    readJson: async () => ({
      agentId: 'agt_one',
      target: 'dm:@Alice',
      content: '我来同步一下',
    }),
    postAgentResponse: async (agent, spaceType, spaceId, content, parentMessageId, options) => {
      const message = {
        id: 'msg_proactive',
        workspaceId: 'wsp_test',
        spaceType,
        spaceId,
        authorType: 'agent',
        authorId: agent.id,
        body: content,
        parentMessageId,
        createdAt: '2026-05-21T04:00:00.000Z',
      };
      posted.push({ agent, spaceType, spaceId, content, parentMessageId, options, message });
      deps.state.messages.push(message);
      return message;
    },
    deliverMessageToAgent: async (agent, spaceType, spaceId, message, options) => {
      deliveries.push({ agent, spaceType, spaceId, message, options });
    },
  });
  deps.state.connection = { workspaceId: 'wsp_test' };
  deps.state.agents.push({ id: 'agt_alice', name: 'Alice', workspaceId: 'wsp_test', status: 'idle' });
  deps.state.dms = [];

  const res = makeResponse();
  const handled = await handleAgentToolApi(
    { method: 'POST', daemonAuth: { workspaceId: 'wsp_test' } },
    res,
    new URL('http://local/api/agent-tools/messages/send'),
    deps,
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200, res.error || '');
  assert.equal(res.data.proactive, true);
  assert.equal(deps.state.dms.length, 1);
  assert.deepEqual(deps.state.dms[0].participantIds, ['agt_one', 'agt_alice']);
  assert.equal(posted[0].spaceType, 'dm');
  assert.equal(posted[0].spaceId, deps.state.dms[0].id);
  assert.equal(posted[0].options.dedupeWindowMs, 3000);
  assert.equal(deliveries[0].agent.id, 'agt_alice');
  assert.equal(deliveries[0].options.parentMessageId, null);
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

test('agent tool task creation reuses an immediate duplicate from the same agent and target', async () => {
  let payload = {
    agentId: 'agt_one',
    target: '#all',
    title: '调研一个产品',
    claim: true,
  };
  const deps = routeDeps({
    readJson: async () => payload,
  });

  const firstRes = makeResponse();
  assert.equal(await handleAgentToolApi(
    { method: 'POST' },
    firstRes,
    new URL('http://local/api/agent-tools/tasks'),
    deps,
  ), true);
  assert.equal(firstRes.statusCode, 201);
  assert.equal(deps.state.tasks.length, 1);

  payload = { ...payload };
  const secondRes = makeResponse();
  assert.equal(await handleAgentToolApi(
    { method: 'POST' },
    secondRes,
    new URL('http://local/api/agent-tools/tasks'),
    deps,
  ), true);
  assert.equal(secondRes.statusCode, 200);
  assert.equal(deps.state.tasks.length, 1);
  assert.equal(secondRes.data.tasks[0].task.id, firstRes.data.tasks[0].task.id);
  assert.equal(secondRes.data.tasks[0].reused, true);
});

test('agent tool task status updates use debounced state broadcasts', async () => {
  const broadcastOptions = [];
  const task = { id: 'task_update', number: 7, status: 'todo' };
  const deps = routeDeps({
    broadcastState: (options = {}) => {
      broadcastOptions.push(options);
    },
    findTaskForAgentTool: () => task,
    readJson: async () => ({
      agentId: 'agt_one',
      taskId: task.id,
      status: 'in_review',
      force: true,
    }),
    updateTaskForAgent: (targetTask, _agent, status) => {
      targetTask.status = status;
    },
  });
  const res = makeResponse();
  const handled = await handleAgentToolApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/agent-tools/tasks/update'),
    deps,
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(task.status, 'in_review');
  assert.deepEqual(broadcastOptions, [{}]);
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

test('daemon memory mirror endpoint rewrites MEMORY.md through the central applier', async () => {
  let applied = null;
  const deps = routeDeps({
    submitAgentMarkdownOperation: async (agent, operation, options) => {
      applied = { agent, operation, options };
      return { ok: true, status: 'applied', revision: 7, operationId: 'mdop_mirror' };
    },
    readJson: async () => ({
      agentId: 'agt_one',
      content: '# Agent One\n\n## 渐进式披露\n- mirror\n',
      documentHash: 'hash_mirror',
    }),
  });

  const res = makeResponse();
  assert.equal(await handleAgentToolApi(
    { method: 'POST', daemonAuth: { workspaceId: 'local', computerId: 'cmp_remote' } },
    res,
    new URL('http://local/api/agent-tools/memory/mirror'),
    deps,
  ), true);

  assert.equal(res.statusCode, 202);
  assert.equal(applied.agent.id, 'agt_one');
  assert.equal(applied.operation.type, 'maintenance_rewrite');
  assert.equal(applied.operation.target.relPath, 'MEMORY.md');
  assert.match(applied.operation.markdown, /渐进式披露/);
  assert.equal(applied.options.sourceTrigger, 'daemon_memory_mirror');
  assert.equal(applied.options.metadata.computerId, 'cmp_remote');
});

test('agent tool memory search defaults to MEMORY.md while explicit reads can fetch peer notes', async () => {
  let memorySearchOptions = null;
  const deps = routeDeps({
    searchAgentMemory: async (query, options) => ({
      ok: true,
      query,
      terms: ['bug', '修复'],
      results: [{
        agentId: 'agt_two',
        agentName: 'Bug Fixer',
        agentDescription: 'General helper',
        path: 'MEMORY.md',
        line: 4,
        score: 8,
        matchedTerms: ['bug', '修复'],
        preview: '- 修复登录 bug 的入口线索在 notes/work-log.md',
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
  deps.searchAgentMemory = async (query, options) => {
    memorySearchOptions = options;
    return {
      ok: true,
      query,
      terms: ['bug', '修复'],
      results: [{
        agentId: 'agt_two',
        agentName: 'Bug Fixer',
        agentDescription: 'General helper',
        path: 'MEMORY.md',
        line: 4,
        score: 8,
        matchedTerms: ['bug', '修复'],
        preview: '- 修复登录 bug 的入口线索在 notes/work-log.md',
      }],
      truncated: false,
      options,
    };
  };
  deps.state.agents.push({ id: 'agt_two', name: 'Bug Fixer', workspaceId: 'wsp_test' });

  const searchRes = makeResponse();
  assert.equal(await handleAgentToolApi(
    { method: 'GET', daemonAuth: { workspaceId: 'wsp_test' } },
    searchRes,
    new URL('http://local/api/agent-tools/memory/search?agentId=agt_one&q=bug%20%E4%BF%AE%E5%A4%8D&limit=5'),
    deps,
  ), true);
  assert.equal(searchRes.statusCode, 200);
  assert.equal(searchRes.data.results[0].agentId, 'agt_two');
  assert.match(searchRes.data.text, /MEMORY\.md:4/);
  assert.equal(memorySearchOptions.workspaceId, 'wsp_test');
  assert.deepEqual(memorySearchOptions.includePaths, ['MEMORY.md']);

  const readRes = makeResponse();
  assert.equal(await handleAgentToolApi(
    { method: 'GET', daemonAuth: { workspaceId: 'wsp_test' } },
    readRes,
    new URL('http://local/api/agent-tools/memory/read?agentId=agt_one&targetAgentId=agt_two&path=notes/work-log.md'),
    deps,
  ), true);
  assert.equal(readRes.statusCode, 200);
  assert.match(readRes.data.text, /修复登录 bug/);
});

test('agent tool file read requires an explicit path for detailed workspace disclosure', async () => {
  let requestedPath = '';
  const deps = routeDeps({
    readAgentMemoryFile: async (targetAgent, relPath) => {
      requestedPath = relPath;
      return {
        file: {
          path: relPath,
          content: '# Detailed Plan\n- 只有明确请求路径时才返回。\n',
        },
      };
    },
  });
  deps.state.agents.push({ id: 'agt_two', name: 'Bug Fixer', workspaceId: 'wsp_test' });

  const res = makeResponse();
  assert.equal(await handleAgentToolApi(
    { method: 'GET', daemonAuth: { workspaceId: 'wsp_test' } },
    res,
    new URL('http://local/api/agent-tools/files/read?agentId=agt_one&targetAgentId=agt_two&path=workspace/plans/fix.md'),
    deps,
  ), true);

  assert.equal(res.statusCode, 200);
  assert.equal(requestedPath, 'workspace/plans/fix.md');
  assert.match(res.data.text, /workspace\/plans\/fix\.md/);
  assert.match(res.data.text, /只有明确请求路径时才返回/);
});

test('agent tool APIs list and read workspace-scoped agent profiles', async () => {
  const deps = routeDeps();
  deps.state.connection = { workspaceId: 'wsp_fallback' };
  deps.state.channels = [
    {
      id: 'chan_one',
      name: 'all',
      workspaceId: 'wsp_test',
      memberIds: ['hum_local', 'agt_one', 'agt_two'],
      agentIds: ['agt_one', 'agt_two'],
    },
    {
      id: 'chan_other',
      name: 'all',
      workspaceId: 'wsp_other',
      memberIds: ['agt_three'],
      agentIds: ['agt_three'],
    },
  ];
  deps.state.agents.push(
    {
      id: 'agt_two',
      name: 'Bug Fixer',
      description: 'Finds narrow regressions and explains exact fixes.',
      runtime: 'codex',
      runtimeId: 'Codex',
      ownerId: 'hum_local',
      createdAt: '2026-05-14T08:00:00.000Z',
      workspaceId: 'wsp_test',
    },
    {
      id: 'agt_three',
      name: 'Other Workspace',
      description: 'Should stay hidden from this daemon.',
      runtime: 'codex',
      workspaceId: 'wsp_other',
    },
  );

  const listRes = makeResponse();
  assert.equal(await handleAgentToolApi(
    { method: 'GET', daemonAuth: { workspaceId: 'wsp_test' } },
    listRes,
    new URL('http://local/api/agent-tools/agents?agentId=agt_one&target=%23all&limit=10'),
    deps,
  ), true);
  assert.equal(listRes.statusCode, 200);
  assert.deepEqual(listRes.data.agents.map((agent) => agent.id), ['agt_two']);
  assert.match(listRes.data.text, /@Bug Fixer/);
  assert.doesNotMatch(listRes.data.text, /Other Workspace/);

  const readRes = makeResponse();
  assert.equal(await handleAgentToolApi(
    { method: 'GET', daemonAuth: { workspaceId: 'wsp_test' } },
    readRes,
    new URL('http://local/api/agent-tools/agents/read?agentId=agt_one&targetAgent=Bug%20Fixer'),
    deps,
  ), true);
  assert.equal(readRes.statusCode, 200);
  assert.equal(readRes.data.agent.id, 'agt_two');
  assert.match(readRes.data.text, /Runtime: Codex/);

  const hiddenRes = makeResponse();
  assert.equal(await handleAgentToolApi(
    { method: 'GET', daemonAuth: { workspaceId: 'wsp_test' } },
    hiddenRes,
    new URL('http://local/api/agent-tools/agents/read?agentId=agt_one&targetAgent=Other%20Workspace'),
    deps,
  ), true);
  assert.equal(hiddenRes.statusCode, 404);
});
