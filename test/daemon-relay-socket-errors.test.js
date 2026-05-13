import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import { createDaemonRelay } from '../server/cloud/daemon-relay.js';

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.writes = [];
    this.destroyed = false;
  }

  write(chunk) {
    this.writes.push(String(chunk));
    return true;
  }

  end(chunk = '') {
    if (chunk) this.write(chunk);
    this.ended = true;
    this.emit('close');
  }

  destroy() {
    this.destroyed = true;
    this.emit('close');
  }
}

function createRelay() {
  const cloud = {
    workspaces: [{ id: 'wsp_test', slug: 'test', name: 'Test' }],
    pairingTokens: [],
    computerTokens: [],
    daemonEvents: [],
    agentDeliveries: [],
  };
  const state = {
    cloud,
    computers: [],
    events: [],
  };
  let nextId = 0;
  const relay = createDaemonRelay({
    addSystemEvent: () => {},
    broadcastState: () => {},
    cloudAuth: {
      ensureCloudState: () => cloud,
      primaryWorkspace: () => cloud.workspaces[0],
      sha256: (value) => crypto.createHash('sha256').update(String(value)).digest('hex'),
      token: (prefix) => `${prefix}_test_${nextId += 1}`,
    },
    findAgent: () => null,
    findComputer: (id) => state.computers.find((computer) => computer.id === id),
    getState: () => state,
    host: '127.0.0.1',
    makeId: (prefix = 'id') => `${prefix}_${nextId += 1}`,
    normalizeConversationRecord: (record) => record,
    now: () => '2026-05-13T00:00:00.000Z',
    persistState: async () => {},
    port: 6543,
    setAgentStatus: () => {},
  });
  return { cloud, relay, state };
}

test('daemon relay consumes socket reset during websocket authentication', async () => {
  const { relay } = createRelay();
  const socket = new FakeSocket();
  const req = {
    url: '/daemon/connect?pair_token=mc_pair_missing',
    headers: {
      host: 'magclaw.example.test',
      'sec-websocket-key': 'test-key',
    },
    socket: {},
  };

  const upgrade = relay.handleUpgrade(req, socket);
  const reset = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
  assert.doesNotThrow(() => socket.emit('error', reset));
  assert.equal(await upgrade, true);
  assert.match(socket.writes.join(''), /401 Unauthorized/);
});

test('daemon relay status omits events for deleted computers', () => {
  const { cloud, relay, state } = createRelay();
  state.computers.push({
    id: 'cmp_live',
    workspaceId: 'wsp_test',
    name: 'Live computer',
    status: 'connected',
  });
  cloud.daemonEvents.push(
    {
      id: 'devt_live',
      workspaceId: 'wsp_test',
      computerId: 'cmp_live',
      type: 'computer_connected',
      message: 'Computer connected: Live computer',
      meta: { computerId: 'cmp_live', workspaceId: 'wsp_test' },
      createdAt: '2026-05-13T00:00:00.000Z',
    },
    {
      id: 'devt_deleted',
      workspaceId: 'wsp_test',
      computerId: null,
      type: 'computer_connected',
      message: 'Computer connected: deleted pod',
      meta: { computerId: 'cmp_deleted', workspaceId: 'wsp_test' },
      createdAt: '2026-05-13T00:00:01.000Z',
    },
    {
      id: 'devt_other_workspace',
      workspaceId: 'wsp_other',
      computerId: null,
      type: 'computer_connected',
      message: 'Computer connected: other workspace',
      meta: { workspaceId: 'wsp_other' },
      createdAt: '2026-05-13T00:00:02.000Z',
    },
    {
      id: 'devt_note',
      workspaceId: 'wsp_test',
      computerId: null,
      type: 'relay_note',
      message: 'Relay note',
      meta: { workspaceId: 'wsp_test' },
      createdAt: '2026-05-13T00:00:03.000Z',
    },
  );

  assert.deepEqual(
    relay.publicRelayState().daemonEvents.map((event) => event.id),
    ['devt_live', 'devt_note'],
  );
});
