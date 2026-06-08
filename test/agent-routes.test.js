import test from 'node:test';
import assert from 'node:assert/strict';
import { handleAgentApi } from '../server/api/agent-routes.js';

function makeResponse() {
  return {
    statusCode: null,
    data: null,
    error: null,
  };
}

function routeDeps(overrides = {}) {
  const state = {
    settings: { defaultWorkspace: '/tmp/workspace', model: 'gpt-default' },
    agents: [{
      id: 'agt_1',
      name: 'Ada',
      description: '',
      runtime: 'Codex CLI',
      model: 'gpt-5.5',
      status: 'busy',
      assigneeIds: [],
      reasoningEffort: 'xhigh',
    }],
    channels: [
      { id: 'chan_all', agentIds: [], memberIds: ['hum_local'] },
      { id: 'chan_side', agentIds: ['agt_1'], memberIds: ['hum_local', 'agt_1'] },
    ],
  };
  return {
    addCollabEvent: () => {},
    agentParticipatesInChannels: () => true,
    broadcastState: () => {},
    clearAgentProcesses: () => {},
    ensureAgentWorkspace: async () => {},
    findAgent: (id) => state.agents.find((agent) => agent.id === id),
    findChannel: (id) => state.channels.find((channel) => channel.id === id),
    getState: () => state,
    hasAgentProcess: () => false,
    listAgentSkills: async () => ({ global: [], workspace: [], plugin: [], tools: [] }),
    listAgentWorkspace: async () => ({ entries: [] }),
    listAgentActivity: async () => ({ agentId: 'agt_1', events: [], hasMore: false, nextBefore: '', windowStart: '', windowEnd: '' }),
    makeId: (prefix) => `${prefix}_new`,
    normalizeCodexModelName: (model, fallback) => String(model || fallback || ''),
    normalizeIds: (ids) => [...new Set((ids || []).filter(Boolean).map(String))],
    now: () => '2026-05-02T00:00:00.000Z',
    persistState: async () => {},
    readAgentWorkspaceFile: async () => ({ path: 'MEMORY.md', content: '' }),
    readJson: async () => ({}),
    restartAgentFromControl: async () => ({ restarted: true }),
    root: '/tmp/root',
    sendError: (res, statusCode, message) => {
      res.statusCode = statusCode;
      res.error = message;
    },
    sendJson: (res, statusCode, data) => {
      res.statusCode = statusCode;
      res.data = data;
    },
    setAgentStatus: (agent, status, reason) => {
      agent.status = status;
      agent.statusReason = reason;
    },
    startAgentFromControl: async () => ({ started: true }),
    stopAgentProcesses: () => ({ stoppedAgents: ['agt_1'], stoppedWorkItems: [] }),
    stopRunsForScope: () => ['run_1'],
    stopScopeFromBody: () => null,
    warmAgentFromControl: async () => ({ running: true, warm: false, warming: true, status: 'starting' }),
    state,
    ...overrides,
  };
}

test('agent route group ignores unrelated API paths', async () => {
  const res = makeResponse();
  const handled = await handleAgentApi(
    { method: 'GET' },
    res,
    new URL('http://local/api/state'),
    routeDeps(),
  );
  assert.equal(handled, false);
});

test('agent route group creates agents, seeds workspace, and joins all', async () => {
  let seededAgentId = null;
  let startedAgentId = null;
  const events = [];
  const deps = routeDeps({
    addCollabEvent: (type, message, meta) => {
      events.push({ type, message, meta });
    },
    ensureAgentWorkspace: async (agent) => {
      seededAgentId = agent.id;
    },
    readJson: async () => ({
      name: 'Builder',
      model: 'gpt-5.4-mini',
      reasoningEffort: 'low',
      envVars: [{ key: 'A', value: 'B' }],
    }),
    startAgentFromControl: async (agent) => {
      startedAgentId = agent.id;
      return { started: true };
    },
  });
  const res = makeResponse();
  const handled = await handleAgentApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/agents'),
    deps,
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 201);
  assert.equal(seededAgentId, 'agt_new');
  assert.equal(startedAgentId, 'agt_new');
  assert.equal(deps.state.agents.at(-1).workspace, '/tmp/workspace');
  assert.deepEqual(deps.state.channels[0].agentIds, ['agt_new']);
  assert.deepEqual(deps.state.channels[0].memberIds, ['hum_local', 'agt_new']);
  assert.equal(events[0].type, 'agent_created');
  assert.equal(events[1].type, 'agent_start_requested');
  assert.equal(events[1].meta.reason, 'create');
});

test('agent route group keeps a created agent when auto-start cannot queue', async () => {
  const events = [];
  const originalWarn = console.warn;
  console.warn = () => {};
  const deps = routeDeps({
    addCollabEvent: (type, message, meta) => {
      events.push({ type, message, meta });
    },
    readJson: async () => ({ name: 'Disconnected Agent', computerId: 'cmp_missing' }),
    startAgentFromControl: async () => ({ queued: false, error: 'Computer not found.' }),
  });
  const res = makeResponse();
  let handled = false;
  try {
    handled = await handleAgentApi(
      { method: 'POST' },
      res,
      new URL('http://local/api/agents'),
      deps,
    );
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(handled, true);
  assert.equal(res.statusCode, 201);
  assert.equal(res.data.agent.name, 'Disconnected Agent');
  assert.equal(deps.state.agents.at(-1).id, 'agt_new');
  assert.equal(events[0].type, 'agent_created');
  assert.equal(events[1].type, 'agent_start_failed');
  assert.equal(events[1].meta.error, 'Computer not found.');
});

test('agent route group stamps new cloud agents with the current workspace', async () => {
  const deps = routeDeps({
    currentActor: () => ({
      user: { id: 'usr_owner', name: 'Owner', email: 'owner@example.test' },
      member: { workspaceId: 'wsp_main', humanId: 'hum_owner' },
    }),
    readJson: async () => ({
      name: 'Workspace Agent',
      runtime: 'Codex CLI',
      runtimeId: 'codex',
      model: 'gpt-5.5',
      computerId: 'cmp_remote',
    }),
  });
  const res = makeResponse();
  const handled = await handleAgentApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/agents'),
    deps,
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 201);
  assert.equal(res.data.agent.workspaceId, 'wsp_main');
  assert.equal(deps.state.agents.at(-1).workspaceId, 'wsp_main');
  assert.equal(res.data.agent.createdByHumanId, 'hum_owner');
});

test('agent route group joins new cloud agents to the workspace all channel', async () => {
  const deps = routeDeps({
    currentActor: () => ({
      user: { id: 'usr_owner', name: 'Owner', email: 'owner@example.test' },
      member: { workspaceId: 'wsp_main', humanId: 'hum_owner' },
    }),
    readJson: async () => ({
      name: 'Workspace Agent',
      runtime: 'Codex CLI',
      runtimeId: 'codex',
      computerId: 'cmp_remote',
    }),
  });
  deps.state.channels = [
    { id: 'chan_all', workspaceId: 'wsp_other', name: 'all', agentIds: [], memberIds: ['hum_other'] },
    { id: 'chan_workspace_all', workspaceId: 'wsp_main', name: 'all', locked: true, agentIds: [], memberIds: ['hum_owner'] },
  ];
  const res = makeResponse();
  await handleAgentApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/agents'),
    deps,
  );

  assert.equal(res.statusCode, 201);
  assert.deepEqual(deps.state.channels[0].agentIds, []);
  assert.deepEqual(deps.state.channels[1].agentIds, ['agt_new']);
  assert.deepEqual(deps.state.channels[1].memberIds, ['hum_owner', 'agt_new']);
});

test('agent route group rejects duplicate agent names in the same workspace after trimming spaces', async () => {
  const deps = routeDeps({
    currentActor: () => ({
      user: { id: 'usr_owner', name: 'Owner', email: 'owner@example.test' },
      member: { workspaceId: 'wsp_main', humanId: 'hum_owner' },
    }),
    readJson: async () => ({
      name: ' Bui lder ',
      runtime: 'Codex CLI',
      runtimeId: 'codex',
      computerId: 'cmp_remote',
    }),
  });
  deps.state.agents.push({
    id: 'agt_builder',
    workspaceId: 'wsp_main',
    name: 'Builder',
    status: 'deleted',
    deletedAt: '2026-05-01T00:00:00.000Z',
  });
  const res = makeResponse();
  const handled = await handleAgentApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/agents'),
    deps,
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 409);
  assert.match(res.error, /Agent name already exists/i);
  assert.equal(deps.state.agents.filter((agent) => agent.name.replace(/\s+/g, '') === 'Builder').length, 1);
});

test('agent route group rejects reserved agent names on create', async () => {
  const deps = routeDeps({
    readJson: async () => ({
      name: 'all',
      runtime: 'Codex CLI',
      runtimeId: 'codex',
    }),
  });
  const res = makeResponse();
  const handled = await handleAgentApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/agents'),
    deps,
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  assert.match(res.error, /reserved/i);
  assert.equal(deps.state.agents.length, 1);
});

test('agent route group allows differently cased names in the same workspace', async () => {
  const deps = routeDeps({
    currentActor: () => ({
      user: { id: 'usr_owner', name: 'Owner', email: 'owner@example.test' },
      member: { workspaceId: 'wsp_main', humanId: 'hum_owner' },
    }),
    readJson: async () => ({
      name: 'builder',
      runtime: 'Codex CLI',
      runtimeId: 'codex',
      computerId: 'cmp_remote',
    }),
  });
  deps.state.agents.push({
    id: 'agt_builder',
    workspaceId: 'wsp_main',
    name: 'Builder',
    status: 'disabled',
  });
  const res = makeResponse();
  await handleAgentApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/agents'),
    deps,
  );

  assert.equal(res.statusCode, 201);
  assert.equal(res.data.agent.name, 'builder');
});

test('agent route group generates a new agent id when makeId collides', async () => {
  const ids = ['agt_1', 'agt_unique'];
  const deps = routeDeps({
    makeId: () => ids.shift(),
    readJson: async () => ({
      name: 'Unique Agent',
      runtime: 'Codex CLI',
      runtimeId: 'codex',
      computerId: 'cmp_remote',
    }),
  });
  const res = makeResponse();
  await handleAgentApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/agents'),
    deps,
  );

  assert.equal(res.statusCode, 201);
  assert.equal(res.data.agent.id, 'agt_unique');
  assert.equal(deps.state.agents.filter((agent) => agent.id === 'agt_1').length, 1);
});

test('agent route group rejects renaming to another agent name in the same workspace', async () => {
  const deps = routeDeps({
    currentActor: () => ({
      user: { id: 'usr_owner', name: 'Owner', email: 'owner@example.test' },
      member: { workspaceId: 'wsp_main', humanId: 'hum_owner' },
    }),
    readJson: async () => ({ name: 'Al pha' }),
  });
  deps.state.agents[0].workspaceId = 'wsp_main';
  deps.state.agents.push({
    id: 'agt_alpha',
    workspaceId: 'wsp_main',
    name: 'Alpha',
    status: 'disabled',
  });
  const res = makeResponse();
  await handleAgentApi(
    { method: 'PATCH' },
    res,
    new URL('http://local/api/agents/agt_1'),
    deps,
  );

  assert.equal(res.statusCode, 409);
  assert.match(res.error, /Agent name already exists/i);
  assert.equal(deps.state.agents[0].name, 'Ada');
});

test('agent route group rejects reserved agent names on rename', async () => {
  const deps = routeDeps({
    readJson: async () => ({ name: 'System' }),
  });
  const res = makeResponse();
  await handleAgentApi(
    { method: 'PATCH' },
    res,
    new URL('http://local/api/agents/agt_1'),
    deps,
  );

  assert.equal(res.statusCode, 400);
  assert.match(res.error, /reserved/i);
  assert.equal(deps.state.agents[0].name, 'Ada');
});

test('agent route group broadcasts status-only patches through realtime events only', async () => {
  const broadcasts = [];
  const deps = routeDeps({
    broadcastState: (options = {}) => {
      broadcasts.push(options);
    },
    readJson: async () => ({ status: 'idle' }),
  });
  const res = makeResponse();
  const handled = await handleAgentApi(
    { method: 'PATCH' },
    res,
    new URL('http://local/api/agents/agt_1'),
    deps,
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(deps.state.agents[0].status, 'idle');
  assert.deepEqual(broadcasts, [{ realtimeOnly: true }]);
});

test('agent route group keeps profile patches on the resync broadcast path', async () => {
  const broadcasts = [];
  const deps = routeDeps({
    broadcastState: (options = {}) => {
      broadcasts.push(options);
    },
    readJson: async () => ({ status: 'idle', name: 'Ada Profile' }),
  });
  const res = makeResponse();
  const handled = await handleAgentApi(
    { method: 'PATCH' },
    res,
    new URL('http://local/api/agents/agt_1'),
    deps,
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(deps.state.agents[0].name, 'Ada Profile');
  assert.deepEqual(broadcasts, [{}]);
});

test('agent route group starts only when no process is already running', async () => {
  let startCalls = 0;
  const deps = routeDeps({
    hasAgentProcess: () => true,
    startAgentFromControl: async () => {
      startCalls += 1;
    },
  });
  const res = makeResponse();
  const handled = await handleAgentApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/agents/agt_1/start'),
    deps,
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 202);
  assert.equal(startCalls, 0);
  assert.equal(res.data.running, true);
});

test('agent route group warms an agent process for the selected space', async () => {
  let warmPayload = null;
  const deps = routeDeps({
    readJson: async () => ({ spaceType: 'dm', spaceId: 'dm_1' }),
    warmAgentFromControl: async (_agent, payload) => {
      warmPayload = payload;
      return { running: true, warm: false, warming: true, status: 'starting' };
    },
  });
  const res = makeResponse();
  const handled = await handleAgentApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/agents/agt_1/warm'),
    deps,
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 202);
  assert.deepEqual(warmPayload, { spaceType: 'dm', spaceId: 'dm_1' });
  assert.equal(res.data.warming, true);
});

test('agent route group marks restart as starting before control handoff', async () => {
  const order = [];
  const deps = routeDeps({
    broadcastState: (options = {}) => {
      order.push(`broadcast:${deps.state.agents[0].status}:${Boolean(options.realtimeOnly)}`);
    },
    restartAgentFromControl: async () => {
      order.push(`restart:${deps.state.agents[0].status}`);
      return { restarted: true };
    },
    setAgentStatus: (agent, status, reason, extra = {}) => {
      order.push(`status:${status}:${reason}:${Boolean(extra.forceEvent)}`);
      agent.status = status;
      agent.statusReason = reason;
    },
  });
  const res = makeResponse();
  const handled = await handleAgentApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/agents/agt_1/restart'),
    deps,
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 202);
  assert.deepEqual(order.slice(0, 3), [
    'status:starting:agent_restart_requested:true',
    'broadcast:starting:true',
    'restart:starting',
  ]);
  assert.equal(res.data.agent.status, 'starting');
});

test('agent route group stop-all resets visible status and process registry', async () => {
  let cleared = false;
  const deps = routeDeps({
    clearAgentProcesses: () => {
      cleared = true;
    },
  });
  const res = makeResponse();
  const handled = await handleAgentApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/agents/stop-all'),
    deps,
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(cleared, true);
  assert.equal(deps.state.agents[0].status, 'idle');
  assert.deepEqual(res.data.stoppedRuns, ['run_1']);
});

test('agent route group updates profile fields and removes channel membership on delete', async () => {
  const deps = routeDeps({
    readJson: async () => ({
      name: 'Ada Lovelace',
      model: 'gpt-5.4-mini',
      reasoningEffort: null,
      envVars: [{ key: 'TOKEN', value: 'x' }],
    }),
  });
  const patchRes = makeResponse();
  const patchHandled = await handleAgentApi(
    { method: 'PATCH' },
    patchRes,
    new URL('http://local/api/agents/agt_1'),
    deps,
  );
  assert.equal(patchHandled, true);
  assert.equal(patchRes.statusCode, 200);
  assert.equal(deps.state.agents[0].name, 'Ada Lovelace');
  assert.equal(deps.state.agents[0].reasoningEffort, null);

  const deleteRes = makeResponse();
  const deleteHandled = await handleAgentApi(
    { method: 'DELETE' },
    deleteRes,
    new URL('http://local/api/agents/agt_1'),
    deps,
  );
  assert.equal(deleteHandled, true);
  assert.equal(deleteRes.statusCode, 200);
  assert.equal(deps.state.agents.length, 1);
  assert.equal(deps.state.agents[0].status, 'deleted');
  assert.match(deps.state.agents[0].deletedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(deps.state.channels[1].agentIds, []);
  assert.deepEqual(deps.state.channels[1].memberIds, ['hum_local']);
});

test('agent skills route requests daemon skills for remote agents', async () => {
  let requestedAgentId = '';
  const deps = routeDeps({
    requestAgentSkills: async (agent) => {
      requestedAgentId = agent.id;
      return {
        agent: { id: agent.id, name: agent.name },
        global: [{ name: 'itinerary-scout' }],
        workspace: [],
        plugin: [],
        tools: ['send_message'],
      };
    },
    listAgentSkills: async () => {
      throw new Error('local skill scan should not run for connected remote agents');
    },
  });
  deps.state.agents[0].computerId = 'cmp_remote';
  const res = makeResponse();
  const handled = await handleAgentApi(
    { method: 'GET' },
    res,
    new URL('http://local/api/agents/agt_1/skills'),
    deps,
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(requestedAgentId, 'agt_1');
  assert.equal(res.data.global[0].name, 'itinerary-scout');
  assert.deepEqual(res.data.tools, ['send_message']);
});

test('agent activity route returns the selected agent activity window', async () => {
  let activityArgs = null;
  const deps = routeDeps({
    listAgentActivity: async (agentId, options) => {
      activityArgs = { agentId, options };
      return {
        agentId,
        events: [
          { id: 'evt_today', agentId, type: 'agent_status_changed', message: 'Ada is idle.', createdAt: '2026-05-11T10:00:00.000Z' },
          { id: 'evt_yesterday', agentId, type: 'agent_activity', message: 'Ada reported daemon activity.', createdAt: '2026-05-10T08:00:00.000Z' },
        ],
        hasMore: false,
        nextBefore: '',
        windowStart: '2026-05-04T12:00:00.000Z',
        windowEnd: '2026-05-11T12:00:00.000Z',
      };
    },
  });
  const res = makeResponse();
  const handled = await handleAgentApi(
    { method: 'GET' },
    res,
    new URL('http://local/api/agents/agt_1/activity?days=7&limit=5000&before=2026-05-11T12%3A00%3A00.000Z'),
    deps,
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(activityArgs.agentId, 'agt_1');
  assert.deepEqual(activityArgs.options, {
    days: '7',
    limit: '5000',
    before: '2026-05-11T12:00:00.000Z',
  });
  assert.deepEqual(res.data.events.map((event) => event.id), ['evt_today', 'evt_yesterday']);
});

test('agent activity route returns 404 for a missing agent', async () => {
  const res = makeResponse();
  const handled = await handleAgentApi(
    { method: 'GET' },
    res,
    new URL('http://local/api/agents/missing/activity'),
    routeDeps(),
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 404);
  assert.equal(res.error, 'Agent not found.');
});

test('agent workspace route falls back to cloud MEMORY.md mirror for offline remote agents', async () => {
  const deps = routeDeps({
    findComputer: (id) => ({ id, status: 'offline' }),
    listAgentWorkspace: async () => {
      throw new Error('offline daemon workspace should not be listed');
    },
    listAgentMemoryMirrorWorkspace: async (agent) => ({
      agent: { id: agent.id, name: agent.name, workspacePath: '/mirror/wsp/agt_1', source: 'cloud_mirror' },
      path: '',
      source: 'cloud_mirror',
      entries: [{
        id: `${agent.id}:MEMORY.md`,
        name: 'MEMORY.md',
        path: 'MEMORY.md',
        kind: 'file',
        type: 'text/markdown',
        bytes: 42,
        updatedAt: '2026-05-21T00:00:00.000Z',
        source: 'cloud_mirror',
      }],
      truncated: false,
    }),
  });
  deps.state.agents[0].computerId = 'cmp_remote';
  deps.state.agents[0].workspaceId = 'wsp_test';
  deps.state.agents[0].status = 'waiting_for_computer';

  const res = makeResponse();
  const handled = await handleAgentApi(
    { method: 'GET' },
    res,
    new URL('http://local/api/agents/agt_1/workspace'),
    deps,
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.data.source, 'cloud_mirror');
  assert.deepEqual(res.data.entries.map((entry) => entry.path), ['MEMORY.md']);
});

test('offline agent workspace file route serves mirror MEMORY.md and rejects detailed files', async () => {
  const deps = routeDeps({
    findComputer: (id) => ({ id, status: 'offline' }),
    readAgentWorkspaceFile: async () => {
      throw new Error('offline daemon workspace file should not be read');
    },
    readAgentMemoryMirrorFile: async (agent) => ({
      file: {
        id: `${agent.id}:MEMORY.md`,
        agentId: agent.id,
        agentName: agent.name,
        name: 'MEMORY.md',
        path: 'MEMORY.md',
        absolutePath: '/mirror/wsp/agt_1/MEMORY.md',
        type: 'text/markdown',
        bytes: 42,
        updatedAt: '2026-05-21T00:00:00.000Z',
        previewKind: 'markdown',
        content: '# Ada\n\n## 渐进式披露\n',
        source: 'cloud_mirror',
      },
    }),
  });
  deps.state.agents[0].computerId = 'cmp_remote';
  deps.state.agents[0].workspaceId = 'wsp_test';
  deps.state.agents[0].status = 'waiting_for_computer';

  const memoryRes = makeResponse();
  await handleAgentApi(
    { method: 'GET' },
    memoryRes,
    new URL('http://local/api/agents/agt_1/workspace/file?path=MEMORY.md'),
    deps,
  );
  assert.equal(memoryRes.statusCode, 200);
  assert.equal(memoryRes.data.file.source, 'cloud_mirror');
  assert.match(memoryRes.data.file.content, /渐进式披露/);

  const detailedRes = makeResponse();
  await handleAgentApi(
    { method: 'GET' },
    detailedRes,
    new URL('http://local/api/agents/agt_1/workspace/file?path=notes/profile.md'),
    deps,
  );
  assert.equal(detailedRes.statusCode, 409);
  assert.match(detailedRes.error, /Computer offline \/ file unavailable/);
});
