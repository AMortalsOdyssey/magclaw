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
    this.writes.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk)));
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

function encodeFrame(payload) {
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  const length = data.length;
  const header = length < 126
    ? Buffer.alloc(2)
    : length < 65536
      ? Buffer.alloc(4)
      : Buffer.alloc(10);
  header[0] = 0x81;
  if (length < 126) {
    header[1] = length;
  } else if (length < 65536) {
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, data]);
}

function decodeServerMessages(socket) {
  const data = Buffer.concat(socket.writes);
  const marker = Buffer.from('\r\n\r\n');
  const headerEnd = data.indexOf(marker);
  let buffer = headerEnd >= 0 ? data.subarray(headerEnd + marker.length) : data;
  const messages = [];
  while (buffer.length >= 2) {
    const second = buffer[1];
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffer.length < 4) break;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length < 10) break;
      length = Number(buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    if (buffer.length < offset + length) break;
    messages.push(JSON.parse(buffer.subarray(offset, offset + length).toString('utf8')));
    buffer = buffer.subarray(offset + length);
  }
  return messages;
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
    agents: [],
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
    findAgent: (id) => state.agents.find((agent) => agent.id === id) || null,
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

test('daemon relay ready only replays queued deliveries and waits before retrying sent deliveries', async () => {
  const { cloud, relay, state } = createRelay();
  const rawToken = 'mc_machine_existing';
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  state.computers.push({
    id: 'cmp_remote',
    workspaceId: 'wsp_test',
    name: 'Remote',
    status: 'offline',
    connectedVia: 'daemon',
  });
  cloud.computerTokens.push({
    id: 'ctok_remote',
    workspaceId: 'wsp_test',
    computerId: 'cmp_remote',
    tokenHash,
    revokedAt: null,
  });
  cloud.agentDeliveries.push(
    {
      id: 'adl_queued',
      workspaceId: 'wsp_test',
      agentId: 'agt_remote',
      computerId: 'cmp_remote',
      seq: 1,
      type: 'agent:deliver',
      commandType: 'agent:deliver',
      status: 'queued',
      payload: { message: { id: 'msg_queued' } },
      attempts: 0,
      createdAt: '2026-05-13T00:00:00.000Z',
      updatedAt: '2026-05-13T00:00:00.000Z',
    },
    {
      id: 'adl_sent',
      workspaceId: 'wsp_test',
      agentId: 'agt_remote',
      computerId: 'cmp_remote',
      seq: 2,
      type: 'agent:deliver',
      commandType: 'agent:deliver',
      status: 'sent',
      sentAt: '2026-05-13T00:00:00.000Z',
      payload: { message: { id: 'msg_sent' } },
      attempts: 1,
      createdAt: '2026-05-13T00:00:00.000Z',
      updatedAt: '2026-05-13T00:00:00.000Z',
    },
  );
  const socket = new FakeSocket();
  const req = {
    url: `/daemon/connect?token=${rawToken}`,
    headers: {
      host: 'magclaw.example.test',
      'sec-websocket-key': 'test-key',
    },
    socket: {},
  };

  assert.equal(await relay.handleUpgrade(req, socket), true);
  socket.emit('data', encodeFrame({ type: 'ready', runtimes: ['codex'] }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const deliveredIds = decodeServerMessages(socket)
    .filter((message) => message.type === 'agent:deliver')
    .map((message) => message.commandId);
  assert.deepEqual(deliveredIds, ['adl_queued']);
  assert.equal(cloud.agentDeliveries.find((item) => item.id === 'adl_sent').attempts, 1);
});

test('daemon relay dedupes active agent deliveries by work item, message, and agent', async () => {
  const { cloud, relay, state } = createRelay();
  state.computers.push({
    id: 'cmp_remote',
    workspaceId: 'wsp_test',
    name: 'Remote',
    status: 'offline',
    connectedVia: 'daemon',
  });
  state.agents.push({
    id: 'agt_remote',
    workspaceId: 'wsp_test',
    computerId: 'cmp_remote',
    name: 'Remote Agent',
    runtime: 'codex',
  });
  cloud.computerTokens.push({
    id: 'ctok_remote',
    workspaceId: 'wsp_test',
    computerId: 'cmp_remote',
    tokenHash: 'hash',
    revokedAt: null,
  });
  cloud.agentDeliveries.push({
    id: 'adl_existing',
    workspaceId: 'wsp_test',
    agentId: 'agt_remote',
    computerId: 'cmp_remote',
    messageId: 'msg_same',
    workItemId: 'wi_same',
    seq: 1,
    type: 'agent:deliver',
    commandType: 'agent:deliver',
    status: 'queued',
    payload: {},
    attempts: 0,
    createdAt: '2026-05-13T00:00:00.000Z',
    updatedAt: '2026-05-13T00:00:00.000Z',
  });

  const result = await relay.deliverToAgent(state.agents[0], {
    id: 'msg_same',
    workItemId: 'wi_same',
    body: 'same work',
  }, { id: 'wi_same' });

  assert.equal(result, true);
  assert.equal(cloud.agentDeliveries.length, 1);
  assert.equal(cloud.agentDeliveries[0].id, 'adl_existing');
});
