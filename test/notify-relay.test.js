import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import WebSocket from 'ws';
import { hashNotifySecret } from '../server/notify.js';
import { createNotifyRelay } from '../server/notify-relay.js';
import { connectOnce, notifyDaemonPaths } from '../notify-daemon/src/daemon.js';
import { listNotifyTargetGrants } from '../notify-daemon/src/handler.js';
import { closeNotifyStateStore, ensureNotifyStateStore } from '../notify-daemon/src/store.js';

function daemonToken(id, relayId, rawToken) {
  return {
    id,
    type: 'auth_token',
    relayId,
    tokenHash: hashNotifySecret(rawToken),
    scopes: ['notify:daemon'],
  };
}

test('independent Notify Relay routes each request to only the token-bound Daemon', async () => {
  const auditEvents = [];
  const state = {
    notifyRecords: [
      daemonToken('nat_1', 'nrl_1', 'daemon-token-one'),
      daemonToken('nat_2', 'nrl_2', 'daemon-token-two'),
    ],
  };
  const relay = createNotifyRelay({ getState: () => state, persistState: async () => {}, audit: async (event) => { auditEvents.push(event); } });
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => {
    relay.handleUpgrade(req, socket, head).then((handled) => {
      if (!handled) socket.destroy();
    }).catch(() => socket.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  const first = new WebSocket(`ws://127.0.0.1:${port}/notify/connect`, { headers: { authorization: 'Bearer daemon-token-one' } });
  const second = new WebSocket(`ws://127.0.0.1:${port}/notify/connect`, { headers: { authorization: 'Bearer daemon-token-two' } });
  await Promise.all([once(first, 'open'), once(second, 'open')]);

  const firstDelivery = new Promise((resolve) => {
    first.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.type === 'notify:deliver') {
        first.send(JSON.stringify({
          type: 'notify:deliver:ack',
          commandId: message.commandId,
          requestId: message.request.id,
          status: 'awaiting_owner_approval',
          publicReason: 'Owner approval is pending.',
        }));
        resolve(message);
      }
    });
  });
  let secondReceivedDelivery = false;
  second.on('message', (raw) => {
    if (JSON.parse(String(raw)).type === 'notify:deliver') secondReceivedDelivery = true;
  });

  const queued = await relay.deliverNotifyRequest({ id: 'nreq_1', relayId: 'nrl_1', payload: {} });
  const message = await firstDelivery;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(queued.queued, true);
  assert.equal(queued.acknowledged, true);
  assert.equal(queued.ack.status, 'awaiting_owner_approval');
  assert.equal(message.request.id, 'nreq_1');
  assert.equal(secondReceivedDelivery, false);
  assert.ok(auditEvents.some((event) => event.event === 'relay.websocket.connected' && event.relayId === 'nrl_1'));
  assert.ok(auditEvents.some((event) => event.event === 'relay.delivery.dispatch_started' && event.requestId === 'nreq_1'));
  assert.ok(auditEvents.some((event) => event.event === 'relay.command.acknowledged' && event.requestId === 'nreq_1'));
  assert.ok(auditEvents.some((event) => event.event === 'relay.delivery.dispatch_completed' && event.outcome === 'acknowledged'));
  assert.doesNotMatch(JSON.stringify(auditEvents), /daemon-token-one|daemon-token-two/);

  first.close();
  second.close();
  relay.beginDrain();
  server.close();
  await once(server, 'close');
});

test('Notify Relay sends notify:grants:revoke and the connected daemon revokes local grants', async () => {
  const state = { notifyRecords: [daemonToken('nat_local', 'nrl_local', 'daemon-token-local')] };
  const relayAudit = [];
  const relay = createNotifyRelay({
    getState: () => state,
    persistState: async () => {},
    audit: async (event) => { relayAudit.push(event); },
    ackTimeoutMs: 2_000,
  });
  const server = http.createServer((_req, res) => { res.writeHead(404); res.end(); });
  server.on('upgrade', (req, socket, head) => {
    relay.handleUpgrade(req, socket, head).then((handled) => {
      if (!handled) socket.destroy();
    }).catch(() => socket.destroy());
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-grants-revoke-'));
  const paths = notifyDaemonPaths({ MAGCLAW_NOTIFY_HOME: root }, 'default');
  const store = await ensureNotifyStateStore(paths.handler);
  store.write('grants', 'state', {
    version: 1,
    grants: [
      { id: 'ntg_1', status: 'active', userId: 'usr_sender', userName: 'Sender', groupId: 'grp_1', groupName: '研发群' },
      { id: 'ntg_2', status: 'active', userId: 'usr_other', userName: 'Other', groupId: 'grp_1', groupName: '研发群' },
    ],
  });
  closeNotifyStateStore(paths.handler);
  const abort = new AbortController();
  const connected = connectOnce(paths, {
    relayUrl: `http://127.0.0.1:${server.address().port}`,
    relayId: 'nrl_local',
    token: 'daemon-token-local',
    machineFingerprint: '',
  }, abort.signal);
  for (let attempt = 0; attempt < 100 && !relay.status('nrl_local').connected; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(relay.status('nrl_local').connected, true);
  const result = await relay.revokeNotifyGrants('nrl_local', 'usr_sender');
  assert.deepEqual(result, { available: true, revoked: 1, status: 'succeeded' });
  assert.equal((await listNotifyTargetGrants(paths.handler, { userId: 'usr_sender' })).length, 0);
  assert.equal((await listNotifyTargetGrants(paths.handler, { userId: 'usr_other' })).length, 1);
  assert.ok(relayAudit.some((event) => event.event === 'relay.command.acknowledged' && event.metadata.commandType === 'notify:grants:revoke'));
  assert.ok(relayAudit.some((event) => event.event === 'relay.grants.revoke_completed' && event.metadata.revokedCount === 1));

  abort.abort();
  await connected;
  relay.beginDrain();
  server.close();
  await once(server, 'close');
  closeNotifyStateStore(paths.handler);
});
