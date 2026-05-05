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
    listAgentWorkspace: async () => ({ entries: [] }),
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
    stopAgentProcesses: () => ({ stoppedAgents: ['agt_1'], cancelledWorkItems: [] }),
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
  const deps = routeDeps({
    ensureAgentWorkspace: async (agent) => {
      seededAgentId = agent.id;
    },
    readJson: async () => ({
      name: 'Builder',
      model: 'gpt-5.4-mini',
      reasoningEffort: 'low',
      envVars: [{ key: 'A', value: 'B' }],
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
  assert.equal(seededAgentId, 'agt_new');
  assert.equal(deps.state.agents.at(-1).workspace, '/tmp/workspace');
  assert.deepEqual(deps.state.channels[0].agentIds, ['agt_new']);
  assert.deepEqual(deps.state.channels[0].memberIds, ['hum_local', 'agt_new']);
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
  assert.equal(deps.state.agents.length, 0);
  assert.deepEqual(deps.state.channels[1].agentIds, []);
  assert.deepEqual(deps.state.channels[1].memberIds, ['hum_local']);
});
