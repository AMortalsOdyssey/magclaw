import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { handleSystemApi } from '../server/api/system-routes.js';

function makeResponse() {
  return {
    statusCode: null,
    data: null,
    error: null,
    writes: [],
    headers: null,
    ended: false,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    write(chunk) {
      this.writes.push(chunk);
    },
    end(chunk) {
      if (chunk) this.writes.push(chunk);
      this.ended = true;
    },
  };
}

const TINY_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lpC6iQAAAABJRU5ErkJggg==';

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
    publicBootstrapState: (_req, options) => ({ bootstrap: { options }, router: state.router }),
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

test('share image save route writes PNG files to the configured local directory', async () => {
  const downloadDir = await mkdtemp(path.join(os.tmpdir(), 'magclaw-share-test-'));
  const deps = routeDeps({
    shareImageDownloadDir: downloadDir,
    readJson: async () => ({
      imageUrl: TINY_PNG_DATA_URL,
      fileName: 'magclaw-share-test.png',
    }),
  });
  const res = makeResponse();

  assert.equal(await handleSystemApi(
    { method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' }, on: () => {} },
    res,
    new URL('http://local/api/share-images/save'),
    deps,
  ), true);

  assert.equal(res.statusCode, 200);
  assert.equal(res.data.ok, true);
  assert.equal(res.data.fileName, 'magclaw-share-test.png');
  assert.equal(res.data.path, path.join(downloadDir, 'magclaw-share-test.png'));
  const saved = await readFile(res.data.path);
  assert.equal(saved.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
});

test('share image save route rejects non-loopback callers', async () => {
  let readJsonCalled = false;
  const deps = routeDeps({
    shareImageDownloadDir: '/tmp',
    readJson: async () => {
      readJsonCalled = true;
      return {};
    },
  });
  const res = makeResponse();

  assert.equal(await handleSystemApi(
    { method: 'POST', headers: {}, socket: { remoteAddress: '10.0.0.8' }, on: () => {} },
    res,
    new URL('http://local/api/share-images/save'),
    deps,
  ), true);

  assert.equal(res.statusCode, 403);
  assert.equal(readJsonCalled, false);
});

test('share image avatar proxy only fetches avatar URLs present in state', async () => {
  const remoteAvatar = 'https://avatars.example.test/human.png';
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const previousFetch = globalThis.fetch;
  let fetchedUrl = '';
  globalThis.fetch = async (url) => {
    fetchedUrl = String(url);
    return {
      ok: true,
      status: 200,
      headers: new Map([['content-type', 'image/png']]),
      arrayBuffer: async () => imageBytes.buffer.slice(imageBytes.byteOffset, imageBytes.byteOffset + imageBytes.byteLength),
    };
  };
  try {
    const deps = routeDeps();
    deps.state.humans = [{ id: 'hum_remote', avatar: remoteAvatar }];
    const res = makeResponse();
    assert.equal(await handleSystemApi(
      { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' }, on: () => {} },
      res,
      new URL(`http://local/api/share-images/avatar?src=${encodeURIComponent(remoteAvatar)}`),
      deps,
    ), true);

    assert.equal(fetchedUrl, remoteAvatar);
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Content-Type'], 'image/png');
    assert.deepEqual(Buffer.concat(res.writes.map((chunk) => Buffer.from(chunk))), imageBytes);

    const rejected = makeResponse();
    assert.equal(await handleSystemApi(
      { method: 'GET', headers: {}, socket: { remoteAddress: '127.0.0.1' }, on: () => {} },
      rejected,
      new URL('http://local/api/share-images/avatar?src=https%3A%2F%2Fother.example.test%2Favatar.png'),
      deps,
    ), true);
    assert.equal(rejected.statusCode, 403);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

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

test('system route group returns bootstrap state with route query options', async () => {
  const deps = routeDeps();
  const res = makeResponse();
  assert.equal(await handleSystemApi(
    { method: 'GET', on: () => {} },
    res,
    new URL('http://local/api/bootstrap?spaceType=channel&spaceId=chan_all&messageLimit=40&threadMessageId=msg_1'),
    deps,
  ), true);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.data.bootstrap.options, {
    spaceType: 'channel',
    spaceId: 'chan_all',
    threadMessageId: 'msg_1',
    messageLimit: '40',
    threadRootLimit: '',
    eventLimit: '',
  });
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
