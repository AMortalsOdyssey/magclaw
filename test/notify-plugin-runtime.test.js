import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFeishuRestClient } from '../notify-daemon/src/feishu-client.js';
import {
  addNotifyGroup,
  confirmNotifyMapping,
  configureNotifyHandler,
  prepareNotifyDelivery,
  recoverNotifyDeliveries,
} from '../notify-daemon/src/handler.js';
import { registerNotifyRuntime } from '../notify-daemon/src/runtime-context.js';
import { closeNotifyStateStore, ensureNotifyStateStore } from '../notify-daemon/src/store.js';

function response(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

test('Feishu REST client shares token refresh and covers deterministic message, update, image, and directory operations', async () => {
  const calls = [];
  let tokenCalls = 0;
  const client = createFeishuRestClient({
    credentialProvider: async () => ({ appId: 'cli_test', appSecret: 'secret_test', domain: 'feishu' }),
    fetch: async (url, init = {}) => {
      const parsed = new URL(url);
      calls.push({ path: parsed.pathname, query: parsed.search, method: init.method || 'GET', body: init.body });
      if (parsed.pathname.endsWith('/tenant_access_token/internal')) {
        tokenCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        return response({ code: 0, tenant_access_token: 'tenant_test', expire: 7200 });
      }
      if (parsed.pathname === '/open-apis/im/v1/messages') return response({ code: 0, data: { message_id: 'om_test' } });
      if (parsed.pathname === '/open-apis/interactive/v1/card/update') return response({ code: 0 });
      if (parsed.pathname === '/open-apis/im/v1/messages/om_test') return response({ code: 0 });
      if (parsed.pathname === '/open-apis/im/v1/images') return response({ code: 0, data: { image_key: 'img_test' } });
      if (parsed.pathname.endsWith('/members')) return response({ code: 0, data: { items: [{ member_id: 'ou_test', name: '测试用户' }] } });
      return response({ code: 404, msg: 'not found' }, 404);
    },
  });

  const [first, second] = await Promise.all([
    client.sendInteractive({ receiveIdType: 'chat_id', receiveId: 'oc_test', card: { schema: '2.0' }, idempotencyKey: 'mcn_one' }),
    client.sendInteractive({ receiveIdType: 'open_id', receiveId: 'ou_owner', card: { schema: '2.0' }, idempotencyKey: 'mcn_two' }),
  ]);
  assert.equal(first.messageId, 'om_test');
  assert.equal(second.messageId, 'om_test');
  assert.equal(tokenCalls, 1);
  assert.ok(calls.some((call) => call.path === '/open-apis/im/v1/messages' && call.query.includes('uuid=mcn_one')));
  assert.equal((await client.updateCard({ token: 'callback', card: {} })).updated, true);
  assert.equal((await client.patchMessage({ messageId: 'om_test', card: {} })).updated, true);
  assert.equal((await client.uploadImage({ bytes: Buffer.from('png'), filename: 'test.png', contentType: 'image/png' })).imageKey, 'img_test');
  assert.deepEqual(await client.listChatMembers({ chatId: 'oc_test' }), [{ member_id: 'ou_test', name: '测试用户' }]);
});

test('Notify SQLite store migrates legacy JSON once and archives the old source files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-sqlite-migrate-'));
  const notifyRoot = path.join(root, 'notify');
  await mkdir(path.join(notifyRoot, 'requests'), { recursive: true });
  await writeFile(path.join(notifyRoot, 'pending-confirmations.json'), `${JSON.stringify([{ id: 'ncf_legacy' }])}\n`);
  const profilePaths = { dir: root };
  const [store, concurrentStore] = await Promise.all([
    ensureNotifyStateStore(profilePaths),
    ensureNotifyStateStore(profilePaths),
  ]);
  assert.equal(concurrentStore, store);
  assert.deepEqual(store.read('pending', 'state', []), [{ id: 'ncf_legacy' }]);
  assert.ok((await readdir(notifyRoot)).some((name) => name.startsWith('pending-confirmations.json.migrated-')));
  assert.ok((await readdir(notifyRoot)).includes('state.db'));
  closeNotifyStateStore(profilePaths);
});

function notifyRequest(id) {
  return {
    id,
    requester: { id: 'usr_sender', name: '发送者' },
    payload: {
      target: { group: '测试群' },
      content: { title: '测试通知', markdown: '- 已完成' },
      mentions: [],
      context: {},
    },
  };
}

function crashAtHook() {
  const error = new Error('injected gateway crash');
  error.code = 'MAGCLAW_CRASH_INJECTION';
  throw error;
}

async function configuredProfile(name) {
  const root = await mkdtemp(path.join(os.tmpdir(), `magclaw-notify-${name}-`));
  const profilePaths = { dir: root, profile: name, config: path.join(root, 'daemon-config.json') };
  await configureNotifyHandler(profilePaths, {
    agentProvider: { kind: 'openclaw', agentId: '' },
    deliveryProvider: { kind: 'feishu-rest', account: 'monkey', enabled: true },
    confirmationProvider: { kind: 'feishu-rest', account: 'monkey', target: 'ou_owner', ownerOpenId: 'ou_owner', enabled: true },
  });
  await addNotifyGroup(profilePaths, { name: '测试群', chatId: 'oc_test' });
  return profilePaths;
}

function countingFeishu() {
  const calls = [];
  return {
    calls,
    client: {
      async sendInteractive(input) {
        calls.push(input);
        return { messageId: `om_${calls.length}` };
      },
      async patchMessage() { return { updated: true }; },
      async updateCard() { return { updated: true }; },
      async listChatMembers() { return []; },
      async uploadImage() { return { imageKey: 'img_test' }; },
    },
  };
}

for (const scenario of [
  { name: 'after-intent', hook: 'afterIntentPersisted', expectedBeforeRecovery: 0 },
  { name: 'after-transport', hook: 'afterTransportSent', expectedBeforeRecovery: 1 },
  { name: 'after-decision', hook: 'afterDecisionPersisted', expectedBeforeRecovery: 0 },
]) {
  test(`Notify restart recovery is exactly-once for crash ${scenario.name}`, async () => {
    const profilePaths = await configuredProfile(`recovery-${scenario.name}`);
    const transport = countingFeishu();
    let injected = false;
    const unregister = registerNotifyRuntime(profilePaths, {
      feishuClient: transport.client,
      deliveryHooks: {
        [scenario.hook]: () => {
          if (injected) return;
          injected = true;
          crashAtHook();
        },
      },
    });
    const prepared = await prepareNotifyDelivery(profilePaths, notifyRequest(`nreq_${scenario.name}`));
    await assert.rejects(
      confirmNotifyMapping(profilePaths, prepared.confirmationId, 'once', { operatorId: 'ou_owner' }),
      /injected gateway crash/,
    );
    assert.equal(transport.calls.filter((call) => call.receiveIdType === 'chat_id').length, scenario.expectedBeforeRecovery);
    unregister();
    closeNotifyStateStore(profilePaths);

    const restarted = registerNotifyRuntime(profilePaths, { feishuClient: transport.client });
    const recovered = await recoverNotifyDeliveries(profilePaths);
    assert.ok(recovered.some((result) => result.requestId === `nreq_${scenario.name}`));
    assert.equal(transport.calls.filter((call) => call.receiveIdType === 'chat_id').length, 1);
    await recoverNotifyDeliveries(profilePaths);
    assert.equal(transport.calls.filter((call) => call.receiveIdType === 'chat_id').length, 1);
    restarted();
    closeNotifyStateStore(profilePaths);
  });
}
