import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMissionApi } from '../server/api/mission-routes.js';

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
    missions: [{ id: 'mis_1', title: 'Existing mission', attachmentIds: [] }],
    runs: [{ id: 'run_1', missionId: 'mis_1', status: 'running' }],
  };
  return {
    addRunEvent: () => {},
    addSystemEvent: () => {},
    broadcastState: () => {},
    findMission: (id) => state.missions.find((mission) => mission.id === id),
    findRun: (id) => state.runs.find((run) => run.id === id),
    getRunningProcess: () => null,
    getState: () => state,
    makeId: (prefix) => `${prefix}_new`,
    now: () => '2026-05-02T00:00:00.000Z',
    persistState: async () => {},
    readJson: async () => ({}),
    root: '/tmp/root',
    sendError: (res, statusCode, message) => {
      res.statusCode = statusCode;
      res.error = message;
    },
    sendJson: (res, statusCode, data) => {
      res.statusCode = statusCode;
      res.data = data;
    },
    splitLines: (value) => String(value || '').split('\n').map((line) => line.trim()).filter(Boolean),
    startCodexRun: () => {},
    state,
    ...overrides,
  };
}

test('mission route group ignores unrelated API paths', async () => {
  const res = makeResponse();
  const handled = await handleMissionApi(
    { method: 'GET' },
    res,
    new URL('http://local/api/state'),
    routeDeps(),
  );
  assert.equal(handled, false);
});

test('mission route group validates mission goal before mutating state', async () => {
  const deps = routeDeps({ readJson: async () => ({ title: 'No goal' }) });
  const res = makeResponse();
  const handled = await handleMissionApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/missions'),
    deps,
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 400);
  assert.equal(deps.state.missions.length, 1);
});

test('mission route group creates mission with normalized defaults', async () => {
  const deps = routeDeps({
    readJson: async () => ({
      title: 'Ship the refactor',
      goal: 'Split the server routes',
      attachmentIds: [123, 'att_2'],
    }),
  });
  const res = makeResponse();
  const handled = await handleMissionApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/missions'),
    deps,
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 201);
  assert.equal(deps.state.missions[0].id, 'mis_new');
  assert.equal(deps.state.missions[0].workspace, '/tmp/workspace');
  assert.deepEqual(deps.state.missions[0].scopeDeny, ['.env*', 'node_modules/**', '.git/**']);
  assert.deepEqual(deps.state.missions[0].attachmentIds, ['123', 'att_2']);
});

test('mission route group starts and cancels Codex runs through injected process controls', async () => {
  let startedRun = null;
  let killedSignal = null;
  const deps = routeDeps({
    getRunningProcess: () => ({ kill: (signal) => { killedSignal = signal; } }),
    startCodexRun: (mission, run) => {
      startedRun = { mission, run };
    },
  });

  const startRes = makeResponse();
  const startHandled = await handleMissionApi(
    { method: 'POST' },
    startRes,
    new URL('http://local/api/missions/mis_1/runs'),
    deps,
  );
  assert.equal(startHandled, true);
  assert.equal(startRes.statusCode, 201);
  assert.equal(startedRun.run.id, 'run_new');
  assert.equal(deps.state.runs[0].id, 'run_new');

  const cancelRes = makeResponse();
  const cancelHandled = await handleMissionApi(
    { method: 'POST' },
    cancelRes,
    new URL('http://local/api/runs/run_1/cancel'),
    deps,
  );
  assert.equal(cancelHandled, true);
  assert.equal(cancelRes.statusCode, 200);
  assert.equal(killedSignal, 'SIGTERM');
  assert.equal(deps.state.runs.find((run) => run.id === 'run_1').cancelRequested, true);
});
