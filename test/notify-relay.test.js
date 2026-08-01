import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';
import WebSocket from 'ws';
import { hashNotifySecret } from '../server/notify.js';
import { createNotifyRelay } from '../server/notify-relay.js';

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
  const state = {
    notifyRecords: [
      daemonToken('nat_1', 'nrl_1', 'daemon-token-one'),
      daemonToken('nat_2', 'nrl_2', 'daemon-token-two'),
    ],
  };
  const relay = createNotifyRelay({ getState: () => state, persistState: async () => {} });
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

  first.close();
  second.close();
  relay.beginDrain();
  server.close();
  await once(server, 'close');
});
