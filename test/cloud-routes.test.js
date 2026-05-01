import test from 'node:test';
import assert from 'node:assert/strict';
import { handleCloudApi } from '../server/api/cloud-routes.js';

function makeResponse() {
  return {
    statusCode: null,
    data: null,
    error: null,
  };
}

function routeDeps(overrides = {}) {
  const state = {
    connection: {
      mode: 'local',
      deployment: 'local',
      controlPlaneUrl: '',
      relayUrl: '',
      cloudToken: '',
      workspaceId: 'local',
      deviceName: 'test-device',
      pairingStatus: 'local',
      autoSync: false,
      lastSyncAt: null,
      lastSyncDirection: null,
      lastError: '',
    },
  };
  const events = [];
  return {
    addSystemEvent: (type, message) => events.push({ type, message }),
    applyCloudSnapshot: () => {},
    broadcastState: () => {},
    cloudFetch: async () => ({ ok: true }),
    cloudSnapshot: () => ({ version: 1 }),
    dataDir: '/tmp/magclaw',
    getState: () => state,
    host: '127.0.0.1',
    normalizeCloudUrl: (value) => String(value || '').replace(/\/+$/, ''),
    now: () => '2026-05-02T00:00:00.000Z',
    persistState: async () => {},
    port: 6543,
    protocolVersion: 1,
    publicConnection: () => state.connection,
    pullStateFromCloud: async () => ({ pulled: true }),
    pushStateToCloud: async () => ({ pushed: true }),
    readJson: async () => ({}),
    requireCloudAccess: () => true,
    sendError: (res, statusCode, message) => {
      res.statusCode = statusCode;
      res.error = message;
    },
    sendJson: (res, statusCode, data) => {
      res.statusCode = statusCode;
      res.data = data;
    },
    events,
    state,
    ...overrides,
  };
}

test('cloud route group ignores unrelated API paths', async () => {
  const res = makeResponse();
  const handled = await handleCloudApi(
    { method: 'GET' },
    res,
    new URL('http://local/api/state'),
    routeDeps(),
  );
  assert.equal(handled, false);
});

test('cloud config route updates connection mode and normalized URLs', async () => {
  const deps = routeDeps({
    readJson: async () => ({
      mode: 'cloud',
      controlPlaneUrl: 'https://control.example///',
      relayUrl: 'https://relay.example/',
      workspaceId: 'team',
      autoSync: true,
    }),
  });
  const res = makeResponse();
  const handled = await handleCloudApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/cloud/config'),
    deps,
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.equal(deps.state.connection.mode, 'cloud');
  assert.equal(deps.state.connection.controlPlaneUrl, 'https://control.example');
  assert.equal(deps.state.connection.pairingStatus, 'configured');
  assert.equal(deps.events[0].type, 'cloud_configured');
});

test('cloud import route records sync metadata after applying snapshot', async () => {
  let importedSnapshot = null;
  const deps = routeDeps({
    applyCloudSnapshot: (snapshot) => {
      importedSnapshot = snapshot;
    },
    readJson: async () => ({ snapshot: { version: 7 }, reason: 'test' }),
  });
  const res = makeResponse();
  const handled = await handleCloudApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/cloud/import-state'),
    deps,
  );
  assert.equal(handled, true);
  assert.deepEqual(importedSnapshot, { version: 7 });
  assert.equal(deps.state.connection.lastSyncDirection, 'import');
  assert.equal(res.data.importedAt, '2026-05-02T00:00:00.000Z');
});
