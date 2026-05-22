import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import test, { mock } from 'node:test';

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

function createRelay(options = {}) {
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
  const persistCalls = [];
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
    isDraining: options.isDraining || (() => false),
    makeId: (prefix = 'id') => `${prefix}_${nextId += 1}`,
    normalizeConversationRecord: (record) => record,
    now: () => '2026-05-13T00:00:00.000Z',
    persistState: options.persistState || (async (persistOptions = {}) => {
      persistCalls.push(persistOptions);
    }),
    port: 6543,
    DAEMON_RECONNECT_GRACE_MS: options.reconnectGraceMs ?? 0,
    setAgentStatus: (agent, status) => {
      if (agent) agent.status = status;
    },
  });
  return { cloud, persistCalls, relay, state };
}

test('daemon relay rejects new daemon websockets while draining', async () => {
  const { relay } = createRelay({ isDraining: () => true });
  const socket = new FakeSocket();

  assert.equal(await relay.handleUpgrade({
    url: '/daemon/connect?token=mc_machine_any',
    headers: {
      host: 'magclaw.multiego.me',
      'sec-websocket-key': 'test-key',
    },
    socket: {},
  }, socket), true);

  assert.match(Buffer.concat(socket.writes).toString('utf8'), /503 Service Unavailable/);
});

test('daemon relay consumes socket reset during websocket authentication', async () => {
  const { relay } = createRelay();
  const socket = new FakeSocket();
  const req = {
    url: '/daemon/connect?pair_token=mc_pair_missing',
    headers: {
      host: 'magclaw.multiego.me',
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

test('daemon relay sends server draining control frame before closing live daemons', async () => {
  const { cloud, relay, state } = createRelay();
  const rawToken = 'mc_machine_existing';
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  state.computers.push({
    id: 'cmp_remote',
    workspaceId: 'wsp_test',
    name: 'Remote',
    status: 'connected',
    connectedVia: 'daemon',
  });
  cloud.computerTokens.push({
    id: 'ctok_remote',
    workspaceId: 'wsp_test',
    computerId: 'cmp_remote',
    tokenHash,
    createdAt: '2026-05-13T00:00:00.000Z',
  });
  const socket = new FakeSocket();
  assert.equal(await relay.handleUpgrade({
    url: `/daemon/connect?token=${rawToken}`,
    headers: {
      host: 'magclaw.multiego.me',
      'sec-websocket-key': 'test-key',
    },
    socket: {},
  }, socket), true);

  relay.beginDrain('test');
  const messages = decodeServerMessages(socket);
  assert.equal(messages.some((message) => message.type === 'server:draining' && message.reason === 'test'), true);
  assert.equal(socket.ended, true);
});

test('daemon relay dispatches and records daemon release notice acknowledgements', async () => {
  const { cloud, persistCalls, relay, state } = createRelay();
  const rawToken = 'mc_machine_existing';
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  state.computers.push({
    id: 'cmp_remote',
    workspaceId: 'wsp_test',
    name: 'Remote',
    status: 'connected',
    connectedVia: 'daemon',
  });
  cloud.computerTokens.push({
    id: 'ctok_remote',
    workspaceId: 'wsp_test',
    computerId: 'cmp_remote',
    tokenHash,
    createdAt: '2026-05-13T00:00:00.000Z',
  });
  const socket = new FakeSocket();
  assert.equal(await relay.handleUpgrade({
    url: `/daemon/connect?token=${rawToken}`,
    headers: {
      host: 'magclaw.multiego.me',
      'sec-websocket-key': 'test-key',
    },
    socket: {},
  }, socket), true);

  const result = relay.sendDaemonReleaseNotice('cmp_remote', {
    version: '0.50.0',
    title: 'Daemon release notice',
  });
  assert.equal(result.sent, true);
  const notice = decodeServerMessages(socket).find((message) => message.type === 'daemon:release_notice');
  assert.equal(notice.commandId, result.commandId);
  assert.equal(notice.notice.version, '0.50.0');

  socket.emit('data', encodeFrame({
    type: 'daemon:release_notice:ack',
    commandId: result.commandId,
    version: '0.50.0',
    receivedAt: '2026-05-13T00:00:00.000Z',
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(cloud.daemonEvents.some((event) => event.type === 'daemon_release_notice_acked'), true);
  assert.ok(persistCalls.some((call) => (
    call.workspaceId === 'wsp_test' && call.reason === 'daemon_release_notice_acked'
  )));
});

test('daemon relay requests daemon upgrade and records waiting state', async () => {
  const { cloud, relay, state } = createRelay();
  const rawToken = 'mc_machine_existing';
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  state.computers.push({
    id: 'cmp_remote',
    workspaceId: 'wsp_test',
    name: 'Remote',
    status: 'connected',
    connectedVia: 'daemon',
    daemonVersion: '0.1.10',
    metadata: {},
  });
  cloud.computerTokens.push({
    id: 'ctok_remote',
    workspaceId: 'wsp_test',
    computerId: 'cmp_remote',
    tokenHash,
    revokedAt: null,
  });
  const socket = new FakeSocket();
  assert.equal(await relay.handleUpgrade({
    url: `/daemon/connect?token=${rawToken}`,
    headers: {
      host: 'magclaw.multiego.me',
      'sec-websocket-key': 'test-key',
    },
    socket: {},
  }, socket), true);
  socket.emit('data', encodeFrame({ type: 'ready', daemonVersion: '0.1.10', runtimes: ['codex'] }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const result = await relay.requestDaemonUpgrade('cmp_remote', { targetVersion: '0.1.11', requestedBy: 'usr_owner' });

  assert.equal(result.sent, true);
  assert.equal(state.computers[0].status, 'upgrade_pending');
  assert.equal(state.computers[0].metadata.daemonUpgrade.status, 'pending_idle');
  assert.equal(state.computers[0].metadata.daemonUpgrade.targetVersion, '0.1.11');
  const upgrade = decodeServerMessages(socket).find((message) => message.type === 'daemon:upgrade');
  assert.equal(upgrade.commandId, result.commandId);
  assert.equal(upgrade.targetVersion, '0.1.11');
  assert.ok(cloud.daemonEvents.some((event) => event.type === 'daemon_upgrade_requested'));
});

test('daemon relay queues deliveries while computer upgrade is pending and replays after ready', async () => {
  const { cloud, relay, state } = createRelay();
  state.computers.push({
    id: 'cmp_remote',
    workspaceId: 'wsp_test',
    name: 'Remote',
    status: 'upgrade_pending',
    connectedVia: 'daemon',
    daemonVersion: '0.1.10',
    metadata: {
      daemonUpgrade: {
        commandId: 'dupgrade_existing',
        status: 'pending_idle',
        targetVersion: '0.1.11',
      },
    },
  });
  state.agents.push({
    id: 'agt_remote',
    workspaceId: 'wsp_test',
    computerId: 'cmp_remote',
    name: 'Remote Agent',
    runtime: 'codex',
    status: 'idle',
  });

  const result = await relay.deliverToAgent(state.agents[0], {
    id: 'msg_wait_upgrade',
    body: 'Queue while upgrade waits.',
  }, { id: 'wi_wait_upgrade' });

  assert.equal(result, true);
  assert.equal(state.agents[0].status, 'waiting_for_upgrade');
  assert.equal(cloud.agentDeliveries[0].status, 'queued');
  assert.equal(cloud.agentDeliveries[0].sentAt, null);

  const rawToken = 'mc_machine_existing';
  cloud.computerTokens.push({
    id: 'ctok_remote',
    workspaceId: 'wsp_test',
    computerId: 'cmp_remote',
    tokenHash: crypto.createHash('sha256').update(rawToken).digest('hex'),
    revokedAt: null,
  });
  const socket = new FakeSocket();
  assert.equal(await relay.handleUpgrade({
    url: `/daemon/connect?token=${rawToken}`,
    headers: {
      host: 'magclaw.multiego.me',
      'sec-websocket-key': 'test-key',
    },
    socket: {},
  }, socket), true);
  socket.emit('data', encodeFrame({
    type: 'ready',
    daemonVersion: '0.1.11',
    upgrade: { commandId: 'dupgrade_existing', status: 'succeeded', targetVersion: '0.1.11' },
    runtimes: ['codex'],
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(state.computers[0].status, 'connected');
  assert.equal(state.computers[0].daemonVersion, '0.1.11');
  assert.equal(state.computers[0].metadata.daemonUpgrade.status, 'succeeded');
  assert.equal(state.agents[0].status, 'idle');
  assert.equal(cloud.agentDeliveries[0].status, 'sent');
  assert.equal(decodeServerMessages(socket).some((message) => message.type === 'agent:deliver'), true);
});

test('daemon relay accepts isolated upgrade progress websockets per computer and command', async () => {
  const { relay, state, cloud } = createRelay();
  const rawOne = 'mc_machine_one';
  const rawTwo = 'mc_machine_two';
  state.computers.push(
    {
      id: 'cmp_one',
      workspaceId: 'wsp_test',
      name: 'One',
      status: 'upgrading',
      connectedVia: 'daemon',
      metadata: { daemonUpgrade: { commandId: 'dupgrade_one', status: 'upgrading' } },
    },
    {
      id: 'cmp_two',
      workspaceId: 'wsp_test',
      name: 'Two',
      status: 'upgrading',
      connectedVia: 'daemon',
      metadata: { daemonUpgrade: { commandId: 'dupgrade_two', status: 'upgrading' } },
    },
  );
  cloud.computerTokens.push(
    {
      id: 'ctok_one',
      workspaceId: 'wsp_test',
      computerId: 'cmp_one',
      tokenHash: crypto.createHash('sha256').update(rawOne).digest('hex'),
      revokedAt: null,
    },
    {
      id: 'ctok_two',
      workspaceId: 'wsp_test',
      computerId: 'cmp_two',
      tokenHash: crypto.createHash('sha256').update(rawTwo).digest('hex'),
      revokedAt: null,
    },
  );
  const socketOne = new FakeSocket();
  const socketTwo = new FakeSocket();
  assert.equal(await relay.handleUpgrade({
    url: `/api/daemon-upgrade-progress?computerId=cmp_one&commandId=dupgrade_one&token=${rawOne}`,
    headers: { host: 'magclaw.multiego.me', 'sec-websocket-key': 'progress-one' },
    socket: {},
  }, socketOne), true);
  assert.equal(await relay.handleUpgrade({
    url: `/api/daemon-upgrade-progress?computerId=cmp_two&commandId=dupgrade_two&token=${rawTwo}`,
    headers: { host: 'magclaw.multiego.me', 'sec-websocket-key': 'progress-two' },
    socket: {},
  }, socketTwo), true);

  socketOne.emit('data', encodeFrame({
    type: 'daemon:upgrade:progress',
    commandId: 'dupgrade_one',
    phase: 'download',
    progress: 35,
    message: 'Downloaded package metadata',
  }));
  socketTwo.emit('data', encodeFrame({
    type: 'daemon:upgrade:progress',
    commandId: 'dupgrade_two',
    phase: 'rollback',
    status: 'rollback',
    progress: 80,
    message: 'Rolling back',
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(state.computers[0].metadata.daemonUpgrade.phase, 'download');
  assert.equal(state.computers[0].metadata.daemonUpgrade.progress, 35);
  assert.equal(state.computers[1].metadata.daemonUpgrade.phase, 'rollback');
  assert.equal(state.computers[1].metadata.daemonUpgrade.status, 'rollback');
  assert.equal(state.computers[1].metadata.daemonUpgrade.progress, 80);
});

test('daemon relay coalesces heartbeat persistence by workspace', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const { cloud, persistCalls, relay, state } = createRelay();
    const rawToken = 'mc_machine_existing';
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    state.computers.push({
      id: 'cmp_remote',
      workspaceId: 'wsp_test',
      name: 'Remote',
      status: 'connected',
      connectedVia: 'daemon',
    });
    cloud.computerTokens.push({
      id: 'ctok_remote',
      workspaceId: 'wsp_test',
      computerId: 'cmp_remote',
      tokenHash,
      createdAt: '2026-05-13T00:00:00.000Z',
    });
    const socket = new FakeSocket();
    assert.equal(await relay.handleUpgrade({
      url: `/daemon/connect?token=${rawToken}`,
      headers: {
        host: 'magclaw.multiego.me',
        'sec-websocket-key': 'test-key',
      },
      socket: {},
    }, socket), true);
    persistCalls.length = 0;

    socket.emit('data', encodeFrame({ type: 'heartbeat', runningAgents: ['agt_one'] }));
    socket.emit('data', encodeFrame({ type: 'heartbeat', runningAgents: ['agt_one', 'agt_two'] }));
    await Promise.resolve();
    assert.equal(persistCalls.length, 0);

    mock.timers.tick(3000);
    await Promise.resolve();
    assert.deepEqual(persistCalls, [{ reason: 'daemon_heartbeat', workspaceId: 'wsp_test' }]);
  } finally {
    mock.timers.reset();
  }
});

test('daemon relay forwards delivery idempotency fields with agent messages', async () => {
  const { cloud, relay, state } = createRelay();
  const rawToken = 'mc_machine_existing';
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  state.computers.push({
    id: 'cmp_remote',
    workspaceId: 'wsp_test',
    name: 'Remote',
    status: 'connected',
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
    tokenHash,
    createdAt: '2026-05-13T00:00:00.000Z',
  });
  let received = null;
  relay.setHandlers({
    onAgentMessage: async (message) => {
      received = message;
    },
  });
  const socket = new FakeSocket();
  assert.equal(await relay.handleUpgrade({
    url: `/daemon/connect?token=${rawToken}`,
    headers: {
      host: 'magclaw.multiego.me',
      'sec-websocket-key': 'test-key',
    },
    socket: {},
  }, socket), true);

  socket.emit('data', encodeFrame({
    type: 'agent:message',
    agentId: 'agt_remote',
    deliveryId: 'adl_reply_1',
    payload: {
      body: 'same reply',
      spaceType: 'channel',
      spaceId: 'chan_test',
      parentMessageId: 'msg_parent',
      sourceMessage: { id: 'msg_parent', spaceType: 'channel', spaceId: 'chan_test' },
      idempotencyKey: 'agent:deliver:cmp_remote:agt_remote:msg_parent:wi_1',
    },
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(received?.deliveryId, 'adl_reply_1');
  assert.equal(received?.idempotencyKey, 'agent:deliver:cmp_remote:agt_remote:msg_parent:wi_1');
  assert.equal(cloud.agentDeliveries.find((item) => item.id === 'adl_reply_1')?.status, undefined);
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
      host: 'magclaw.multiego.me',
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

test('daemon relay requeues unacked sent deliveries when the socket disconnects', async () => {
  const { cloud, relay, state } = createRelay();
  const rawToken = 'mc_machine_existing';
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  state.computers.push({
    id: 'cmp_remote',
    workspaceId: 'wsp_test',
    name: 'Remote',
    status: 'connected',
    connectedVia: 'daemon',
  });
  state.workItems = [{
    id: 'wi_sent',
    workspaceId: 'wsp_test',
    agentId: 'agt_remote',
    status: 'sent_remote',
    target: '#all',
  }];
  cloud.computerTokens.push({
    id: 'ctok_remote',
    workspaceId: 'wsp_test',
    computerId: 'cmp_remote',
    tokenHash,
    revokedAt: null,
  });
  cloud.agentDeliveries.push({
    id: 'adl_sent',
    workspaceId: 'wsp_test',
    agentId: 'agt_remote',
    computerId: 'cmp_remote',
    workItemId: 'wi_sent',
    seq: 1,
    type: 'agent:deliver',
    commandType: 'agent:deliver',
    status: 'sent',
    sentAt: '2026-05-13T00:00:00.000Z',
    payload: { message: { id: 'msg_sent' } },
    attempts: 1,
    createdAt: '2026-05-13T00:00:00.000Z',
    updatedAt: '2026-05-13T00:00:00.000Z',
  });

  const socket = new FakeSocket();
  assert.equal(await relay.handleUpgrade({
    url: `/daemon/connect?token=${rawToken}`,
    headers: {
      host: 'magclaw.multiego.me',
      'sec-websocket-key': 'test-key',
    },
    socket: {},
  }, socket), true);
  socket.emit('close');
  await new Promise((resolve) => setTimeout(resolve, 0));

  const delivery = cloud.agentDeliveries.find((item) => item.id === 'adl_sent');
  assert.equal(delivery.status, 'queued');
  assert.match(delivery.error, /Connection dropped before daemon acknowledgement/);
  assert.equal(state.workItems[0].status, 'queued_remote');
  assert.ok(cloud.daemonEvents.some((event) => event.type === 'agent_delivery_requeued'));

  const nextSocket = new FakeSocket();
  assert.equal(await relay.handleUpgrade({
    url: `/daemon/connect?token=${rawToken}`,
    headers: {
      host: 'magclaw.multiego.me',
      'sec-websocket-key': 'test-key',
    },
    socket: {},
  }, nextSocket), true);
  nextSocket.emit('data', encodeFrame({ type: 'ready', runtimes: ['codex'] }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const deliveredIds = decodeServerMessages(nextSocket)
    .filter((message) => message.type === 'agent:deliver')
    .map((message) => message.commandId);
  assert.deepEqual(deliveredIds, ['adl_sent']);
  assert.equal(delivery.status, 'sent');
  assert.equal(delivery.attempts, 2);
});

test('daemon relay keeps offline agent presence while queuing delivery for a stopped daemon', async () => {
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
    status: 'offline',
  });

  const result = await relay.deliverToAgent(state.agents[0], {
    id: 'msg_after_stop',
    body: 'Queue this after the daemon was stopped.',
  });

  assert.equal(result, true);
  assert.equal(state.agents[0].status, 'offline');
  assert.equal(cloud.agentDeliveries.length, 1);
  assert.equal(cloud.agentDeliveries[0].status, 'queued');
});

test('daemon relay records delivery idempotency keys and failed terminal status', async () => {
  const { cloud, relay, state } = createRelay();
  state.computers.push({
    id: 'cmp_remote',
    workspaceId: 'wsp_test',
    name: 'Remote',
    status: 'connected',
    connectedVia: 'daemon',
  });
  state.agents.push({
    id: 'agt_remote',
    workspaceId: 'wsp_test',
    computerId: 'cmp_remote',
    name: 'Remote Agent',
    runtime: 'codex',
    status: 'idle',
  });

  const result = await relay.deliverToAgent(state.agents[0], {
    id: 'msg_idempotent',
    body: 'Queue this once.',
  }, { id: 'wi_idempotent' });

  assert.equal(result, true);
  assert.equal(cloud.agentDeliveries.length, 1);
  assert.match(cloud.agentDeliveries[0].idempotencyKey, /^agent:deliver:cmp_remote:agt_remote:msg_idempotent:wi_idempotent$/);

  const socket = new FakeSocket();
  const rawToken = 'mc_machine_existing';
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  cloud.computerTokens.push({
    id: 'ctok_remote',
    workspaceId: 'wsp_test',
    computerId: 'cmp_remote',
    tokenHash,
    createdAt: '2026-05-13T00:00:00.000Z',
  });
  assert.equal(await relay.handleUpgrade({
    url: `/daemon/connect?token=${rawToken}`,
    headers: {
      host: 'magclaw.multiego.me',
      'sec-websocket-key': 'test-key',
    },
    socket: {},
  }, socket), true);
  socket.emit('data', encodeFrame({
    type: 'agent:error',
    agentId: 'agt_remote',
    commandId: cloud.agentDeliveries[0].id,
    error: 'boom',
  }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(cloud.agentDeliveries[0].status, 'failed');
  assert.equal(cloud.agentDeliveries[0].error, 'boom');
  assert.equal(typeof cloud.agentDeliveries[0].completedAt, 'string');
});

test('daemon relay keeps agents out of offline during quick reconnect grace', async () => {
  const { cloud, relay, state } = createRelay({ reconnectGraceMs: 50 });
  const rawToken = 'mc_machine_existing';
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  state.computers.push({
    id: 'cmp_remote',
    workspaceId: 'wsp_test',
    name: 'Remote',
    status: 'connected',
    connectedVia: 'daemon',
  });
  state.agents.push({
    id: 'agt_remote',
    workspaceId: 'wsp_test',
    computerId: 'cmp_remote',
    name: 'Remote Agent',
    runtime: 'codex',
    status: 'idle',
  });
  state.workItems = [{
    id: 'wi_sent',
    workspaceId: 'wsp_test',
    agentId: 'agt_remote',
    status: 'sent_remote',
    target: '#all',
  }];
  cloud.computerTokens.push({
    id: 'ctok_remote',
    workspaceId: 'wsp_test',
    computerId: 'cmp_remote',
    tokenHash,
    revokedAt: null,
  });
  cloud.agentDeliveries.push({
    id: 'adl_sent',
    workspaceId: 'wsp_test',
    agentId: 'agt_remote',
    computerId: 'cmp_remote',
    workItemId: 'wi_sent',
    seq: 1,
    type: 'agent:deliver',
    commandType: 'agent:deliver',
    status: 'sent',
    sentAt: '2026-05-13T00:00:00.000Z',
    payload: { message: { id: 'msg_sent' } },
    attempts: 1,
    createdAt: '2026-05-13T00:00:00.000Z',
    updatedAt: '2026-05-13T00:00:00.000Z',
  });

  const firstSocket = new FakeSocket();
  assert.equal(await relay.handleUpgrade({
    url: `/daemon/connect?token=${rawToken}`,
    headers: {
      host: 'magclaw.multiego.me',
      'sec-websocket-key': 'test-key',
    },
    socket: {},
  }, firstSocket), true);
  firstSocket.emit('close');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(state.computers[0].status, 'connected');
  assert.equal(state.agents[0].status, 'idle');
  assert.equal(cloud.agentDeliveries[0].status, 'sent');
  assert.ok(cloud.daemonEvents.some((event) => event.type === 'computer_reconnect_grace'));
  assert.equal(cloud.daemonEvents.some((event) => event.type === 'agent_computer_offline'), false);

  const nextSocket = new FakeSocket();
  assert.equal(await relay.handleUpgrade({
    url: `/daemon/connect?token=${rawToken}`,
    headers: {
      host: 'magclaw.multiego.me',
      'sec-websocket-key': 'test-key',
    },
    socket: {},
  }, nextSocket), true);
  nextSocket.emit('data', encodeFrame({ type: 'ready', runtimes: ['codex'] }));
  await new Promise((resolve) => setTimeout(resolve, 75));

  const deliveredIds = decodeServerMessages(nextSocket)
    .filter((message) => message.type === 'agent:deliver')
    .map((message) => message.commandId);
  assert.deepEqual(deliveredIds, ['adl_sent']);
  assert.equal(state.computers[0].status, 'connected');
  assert.equal(state.computers[0].reconnectingSince, null);
  assert.notEqual(state.agents[0].status, 'offline');
  assert.equal(cloud.agentDeliveries[0].status, 'sent');
  assert.equal(cloud.agentDeliveries[0].attempts, 2);
  assert.equal(cloud.daemonEvents.some((event) => event.type === 'agent_computer_offline'), false);
});

test('daemon relay restores connected status from any live websocket frame', async () => {
  const { cloud, relay, state } = createRelay();
  const rawToken = 'mc_machine_live';
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  state.computers.push({
    id: 'cmp_remote',
    workspaceId: 'wsp_test',
    name: 'Remote computer',
    status: 'offline',
    connectedVia: 'daemon',
    createdAt: '2026-05-13T00:00:00.000Z',
    updatedAt: '2026-05-13T00:00:00.000Z',
  });
  cloud.computerTokens.push({
    id: 'tok_remote',
    workspaceId: 'wsp_test',
    computerId: 'cmp_remote',
    tokenHash,
    revokedAt: null,
  });

  const socket = new FakeSocket();
  assert.equal(await relay.handleUpgrade({
    url: `/daemon/connect?token=${rawToken}`,
    headers: {
      host: 'magclaw.multiego.me',
      'sec-websocket-key': 'test-key',
    },
    socket: {},
  }, socket), true);

  state.computers[0].status = 'offline';
  socket.emit('data', encodeFrame({ type: 'pong' }));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(state.computers[0].status, 'connected');
  assert.equal(state.computers[0].lastSeenAt, '2026-05-13T00:00:00.000Z');
});

test('daemon relay marks offline after reconnect grace expires', async () => {
  const { cloud, relay, state } = createRelay({ reconnectGraceMs: 25 });
  const rawToken = 'mc_machine_existing';
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  state.computers.push({
    id: 'cmp_remote',
    workspaceId: 'wsp_test',
    name: 'Remote',
    status: 'connected',
    connectedVia: 'daemon',
  });
  state.agents.push({
    id: 'agt_remote',
    workspaceId: 'wsp_test',
    computerId: 'cmp_remote',
    name: 'Remote Agent',
    runtime: 'codex',
    status: 'idle',
  });
  cloud.computerTokens.push({
    id: 'ctok_remote',
    workspaceId: 'wsp_test',
    computerId: 'cmp_remote',
    tokenHash,
    revokedAt: null,
  });

  const socket = new FakeSocket();
  assert.equal(await relay.handleUpgrade({
    url: `/daemon/connect?token=${rawToken}`,
    headers: {
      host: 'magclaw.multiego.me',
      'sec-websocket-key': 'test-key',
    },
    socket: {},
  }, socket), true);
  socket.emit('close');
  await new Promise((resolve) => setTimeout(resolve, 40));

  assert.equal(state.computers[0].status, 'offline');
  assert.equal(state.agents[0].status, 'offline');
  assert.ok(cloud.daemonEvents.some((event) => event.type === 'agent_computer_offline'));
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
