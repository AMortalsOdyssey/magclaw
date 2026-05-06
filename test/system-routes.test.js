import test from 'node:test';
import assert from 'node:assert/strict';
import { handleSystemApi } from '../server/api/system-routes.js';

function makeResponse() {
  return {
    statusCode: null,
    data: null,
    error: null,
    writes: [],
    headers: null,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    write(chunk) {
      this.writes.push(chunk);
    },
  };
}

function routeDeps(overrides = {}) {
  const state = {
    settings: {
      codexPath: 'codex',
      defaultWorkspace: '/tmp/old',
      model: '',
      sandbox: 'workspace-write',
      fanoutApi: {},
    },
    router: { mode: 'rules_fallback' },
  };
  const events = [];
  const sseClients = new Set();
  return {
    addSystemEvent: (type, message, extra = {}) => events.push({ type, message, extra }),
    broadcastState: () => {},
    defaultWorkspace: '/tmp/default',
    detectInstalledRuntimes: async () => [{ id: 'codex' }],
    fanoutApiConfigured: () => true,
    getRuntimeInfo: async () => ({ ok: true }),
    getState: () => state,
    persistState: async () => {},
    presenceHeartbeat: () => ({ agents: [] }),
    publicState: () => ({ settings: state.settings, router: state.router }),
    readJson: async () => ({}),
    sendError: (res, statusCode, message) => {
      res.statusCode = statusCode;
      res.error = message;
    },
    sendJson: (res, statusCode, data) => {
      res.statusCode = statusCode;
      res.data = data;
    },
    sseClients,
    updateFanoutApiConfig: (body) => {
      state.settings.fanoutApi = { ...body };
    },
    events,
    state,
    ...overrides,
  };
}

test('system route group returns public state and ignores unrelated API paths', async () => {
  const deps = routeDeps();
  const stateRes = makeResponse();
  assert.equal(await handleSystemApi(
    { method: 'GET', on: () => {} },
    stateRes,
    new URL('http://local/api/state'),
    deps,
  ), true);
  assert.equal(stateRes.statusCode, 200);
  assert.deepEqual(stateRes.data.router, { mode: 'rules_fallback' });

  const otherRes = makeResponse();
  assert.equal(await handleSystemApi(
    { method: 'GET', on: () => {} },
    otherRes,
    new URL('http://local/api/messages'),
    deps,
  ), false);
});

test('system settings route updates runtime settings through injected state', async () => {
  const deps = routeDeps({
    readJson: async () => ({
      codexPath: '/bin/codex',
      defaultWorkspace: '/tmp/work',
      model: 'gpt-test',
      sandbox: 'read-only',
    }),
  });
  const res = makeResponse();
  assert.equal(await handleSystemApi(
    { method: 'POST', on: () => {} },
    res,
    new URL('http://local/api/settings'),
    deps,
  ), true);
  assert.equal(deps.state.settings.codexPath, '/bin/codex');
  assert.equal(deps.state.settings.model, 'gpt-test');
  assert.equal(deps.state.settings.sandbox, 'read-only');
  assert.equal(deps.events[0].type, 'settings_updated');
});
