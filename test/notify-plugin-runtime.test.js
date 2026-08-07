import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFeishuRestClient } from '../notify-daemon/src/feishu-client.js';
import {
  addNotifyGroup,
  confirmNotifyMapping,
  configureNotifyHandler,
  createPinnedNotifyImageAgent,
  createPinnedNotifyImageLookup,
  downloadNotifyImage,
  prepareNotifyDelivery,
  recoverNotifyDeliveries,
  resolvePublicNotifyImage,
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

test('Notify image DNS validation pins the approved address into the undici Agent lookup', async () => {
  let resolverCalls = 0;
  const resolved = await resolvePublicNotifyImage('https://images.example.com/proof.png', {
    lookup: async () => {
      resolverCalls += 1;
      return [{ address: resolverCalls === 1 ? '93.184.216.34' : '127.0.0.1', family: 4 }];
    },
  });
  assert.equal(resolverCalls, 1);
  assert.equal(resolved.address, '93.184.216.34');
  const pinnedLookup = createPinnedNotifyImageLookup(resolved.address, resolved.family);
  const connected = await new Promise((resolve, reject) => pinnedLookup('images.example.com', {}, (error, address, family) => {
    if (error) reject(error);
    else resolve({ address, family });
  }));
  assert.deepEqual(connected, { address: '93.184.216.34', family: 4 });
  const agent = createPinnedNotifyImageAgent(resolved);
  assert.equal(agent.constructor.name, 'Agent');
  await agent.close();
});

test('Notify image redirects repeat DNS validation and preserve each original Host header', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-image-pin-'));
  const lookups = [];
  const dispatchers = [];
  const requests = [];
  const lookupByHost = {
    'images.example.com': '93.184.216.34',
    'cdn.example.net': '142.250.72.14',
  };
  const file = await downloadNotifyImage(
    { url: 'https://images.example.com/start', alt: 'proof' },
    path.join(root, 'proof'),
    {
      lookup: async (hostname) => {
        lookups.push(hostname);
        return [{ address: lookupByHost[hostname], family: 4 }];
      },
      agentFactory: (resolved) => {
        const dispatcher = { resolved, closed: false, async close() { this.closed = true; } };
        dispatchers.push(dispatcher);
        return dispatcher;
      },
      fetch: async (url, options) => {
        requests.push({ url: String(url), host: options.headers.host, dispatcher: options.dispatcher });
        if (requests.length === 1) return new Response(null, { status: 302, headers: { location: 'https://cdn.example.net/final.png' } });
        return new Response(Buffer.from('safe-image'), { status: 200, headers: { 'content-type': 'image/png' } });
      },
    },
  );
  assert.deepEqual(lookups, ['images.example.com', 'cdn.example.net']);
  assert.deepEqual(dispatchers.map((item) => item.resolved.address), ['93.184.216.34', '142.250.72.14']);
  assert.deepEqual(requests.map((item) => item.host), ['images.example.com', 'cdn.example.net']);
  assert.ok(requests.every((request, index) => request.dispatcher === dispatchers[index]));
  assert.ok(dispatchers.every((dispatcher) => dispatcher.closed));
  assert.equal(await readFile(file, 'utf8'), 'safe-image');
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
  store.write('memory', 'state', { value: 'before' });
  assert.throws(() => store.transaction(() => {
    store.write('memory', 'state', { value: 'inside' });
    throw new Error('rollback transaction');
  }), /rollback transaction/);
  assert.deepEqual(store.read('memory', 'state', {}), { value: 'before' });
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

function confirmWorker(args) {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'fixtures', 'notify-confirm-worker.mjs'), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
    if (stdout.includes('READY\n')) readyResolve();
  });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  const result = new Promise((resolve, reject) => {
    child.once('error', (error) => { readyReject(error); reject(error); });
    child.once('close', (code) => {
      if (!stdout.includes('READY\n')) readyReject(new Error(`Notify confirm worker exited before ready: ${stderr}`));
      const lines = stdout.trim().split(/\r?\n/).filter((line) => line !== 'READY');
      let payload = null;
      try { payload = JSON.parse(lines.at(-1) || '{}'); } catch {}
      resolve({ code, payload, stderr });
    });
  });
  return { ready, result };
}

test('Notify confirmation CAS permits exactly one cross-process transport send', async () => {
  const profilePaths = await configuredProfile('cross-process-cas');
  const prepared = await prepareNotifyDelivery(profilePaths, notifyRequest('nreq_cross_process'));
  const gateFile = path.join(profilePaths.dir, 'confirm.gate');
  const transportFile = path.join(profilePaths.dir, 'transport.jsonl');
  closeNotifyStateStore(profilePaths);

  const workers = [
    confirmWorker([profilePaths.dir, prepared.confirmationId, gateFile, transportFile]),
    confirmWorker([profilePaths.dir, prepared.confirmationId, gateFile, transportFile]),
  ];
  await Promise.all(workers.map((worker) => worker.ready));
  await writeFile(gateFile, 'go\n', { mode: 0o600 });
  const results = await Promise.all(workers.map((worker) => worker.result));
  assert.equal(results.filter((result) => result.code === 0 && result.payload?.ok).length, 1, JSON.stringify(results));
  assert.equal(results.filter((result) => result.payload?.ok === false && /already claimed/i.test(result.payload.error)).length, 1, JSON.stringify(results));

  const sends = (await readFile(transportFile, 'utf8')).trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  assert.equal(sends.filter((send) => send.receiveIdType === 'chat_id').length, 1);
});

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
