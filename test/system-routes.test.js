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
    updateFanoutApiConfig: (body, workspace = null) => {
      state.settings.fanoutApi = { ...body };
      if (workspace) {
        workspace.metadata = { ...(workspace.metadata || {}), fanoutApi: { ...body } };
      }
      return state.settings.fanoutApi;
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

test('fan-out settings route stores config on the active workspace', async () => {
  const workspace = { id: 'wsp_test', metadata: {} };
  let persistedCloud = false;
  let persistedLocal = false;
  const deps = routeDeps({
    cloudAuth: {
      isLoginRequired: () => false,
      primaryWorkspace: () => workspace,
      persistCloudState: async () => { persistedCloud = true; },
    },
    fanoutApiConfigured: (config = deps.state.settings.fanoutApi) => Boolean(config.enabled && config.baseUrl && config.model && config.apiKey),
    persistState: async () => { persistedLocal = true; },
    readJson: async () => ({
      enabled: true,
      baseUrl: 'https://models.example/v1',
      model: 'qwen-test',
      apiKey: 'secret',
    }),
  });
  const res = makeResponse();

  assert.equal(await handleSystemApi(
    { method: 'PATCH', on: () => {} },
    res,
    new URL('http://local/api/settings/fanout'),
    deps,
  ), true);

  assert.equal(res.statusCode, 200);
  assert.equal(workspace.metadata.fanoutApi.model, 'qwen-test');
  assert.equal(deps.state.settings.fanoutApi.baseUrl, 'https://models.example/v1');
  assert.equal(deps.events[0].extra.workspaceId, 'wsp_test');
  assert.equal(persistedCloud, true);
  assert.equal(persistedLocal, false);
});

test('fan-out settings route requires an admin workspace role', async () => {
  let updated = false;
  const deps = routeDeps({
    cloudAuth: {
      isLoginRequired: () => true,
      requireUser: (_req, res, sendError) => {
        sendError(res, 403, 'Workspace role is not allowed.');
        return null;
      },
      primaryWorkspace: () => ({ id: 'wsp_forbidden', metadata: {} }),
    },
    updateFanoutApiConfig: () => {
      updated = true;
      return {};
    },
    readJson: async () => ({ enabled: true, model: 'qwen-test' }),
  });
  const res = makeResponse();

  assert.equal(await handleSystemApi(
    { method: 'POST', on: () => {} },
    res,
    new URL('http://local/api/settings/fanout'),
    deps,
  ), true);

  assert.equal(res.statusCode, 403);
  assert.equal(res.error, 'Workspace role is not allowed.');
  assert.equal(updated, false);
});
