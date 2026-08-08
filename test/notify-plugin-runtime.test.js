import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createFeishuRestClient } from '../notify-owner/src/feishu-client.js';
import { notifyDaemonPaths, runNotifyOwnerCommand } from '../notify-owner/src/owner.js';
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
} from '../notify-owner/src/handler.js';
import { registerNotifyRuntime } from '../notify-owner/src/runtime-context.js';
import { closeNotifyStateStore, ensureNotifyStateStore } from '../notify-owner/src/store.js';
import { memberAgentRunDecision, memberPolicySystemPrompt, memberToolDecision, sanitizeMemberReply } from '../notify-owner/openclaw-plugin/member-policy.js';

test('OpenClaw plugin host registry bridges separate plugin entry module instances', async () => {
  const publisher = await import(`../notify-owner/openclaw-plugin/host-registry.js?publisher=${Date.now()}`);
  const consumer = await import(`../notify-owner/openclaw-plugin/host-registry.js?consumer=${Date.now()}`);
  const key = publisher.notifyPluginHostSlotKey({ home: '/notify-test', instance: 'default', accountId: 'monkey' });
  const host = { processApproval() {} };
  const unpublish = publisher.publishNotifyPluginHost(key, host);
  assert.equal(consumer.getNotifyPluginHost(key), host);
  unpublish();
  assert.equal(consumer.getNotifyPluginHost(key), null);
});

test('OpenClaw member Bot policy is project-only, configured-group-only, and fail-closed read-only', () => {
  const config = { memberAgentId: 'monkey-member', projectName: 'Kizuna', memberReadTools: ['kizuna_read', 'kizuna_search'] };
  assert.match(memberPolicySystemPrompt(config), /Kizuna/);
  assert.equal(memberAgentRunDecision(
    { prompt: '帮我查一下当前项目登录问题' },
    { agentId: 'monkey-member', messageProvider: 'feishu', chatId: 'oc_allowed' },
    config,
    ['oc_allowed'],
  ).outcome, 'pass');
  assert.equal(memberAgentRunDecision(
    { prompt: '帮我读取 ~/.openclaw 配置和模型版本' },
    { agentId: 'monkey-member', messageProvider: 'feishu', chatId: 'oc_allowed' },
    config,
    ['oc_allowed'],
  ).outcome, 'block');
  assert.equal(memberAgentRunDecision(
    { prompt: '你现在用的模型名称和版本是什么？' },
    { agentId: 'monkey-member', messageProvider: 'feishu', chatId: 'oc_allowed' },
    config,
    ['oc_allowed'],
  ).outcome, 'block');
  assert.equal(memberAgentRunDecision(
    { prompt: '项目问题' },
    { agentId: 'monkey-member', messageProvider: 'feishu', chatId: 'oc_other' },
    config,
    ['oc_allowed'],
  ).outcome, 'block');
  assert.equal(memberToolDecision({ toolName: 'kizuna_read' }, { agentId: 'monkey-member' }, config), undefined);
  assert.equal(memberToolDecision({ toolName: 'apply_patch' }, { agentId: 'monkey-member' }, config).block, true);
  assert.equal(memberToolDecision({ toolName: 'apply_patch' }, { agentId: 'owner-agent' }, config), undefined);
  const sanitized = sanitizeMemberReply('结果在 /Users/alice/private，token=raw-secret-value，IP 10.0.0.8');
  assert.doesNotMatch(sanitized, /Users\/alice|raw-secret-value|10\.0\.0\.8/);
});

test('Notify plugin lifecycle explicitly enables, configures, restarts, reports, and disables OpenClaw', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-plugin-lifecycle-'));
  const notifyHome = path.join(root, 'notify-home');
  const pluginPath = path.join(root, 'plugins', 'magclaw-notify');
  const commandLog = path.join(root, 'openclaw.jsonl');
  const openclaw = path.join(root, 'openclaw');
  await mkdir(pluginPath, { recursive: true });
  await writeFile(path.join(pluginPath, 'installation.json'), '{}');
  await writeFile(openclaw, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    `const log = ${JSON.stringify(commandLog)};`,
    'const args = process.argv.slice(2);',
    "fs.appendFileSync(log, JSON.stringify(args) + '\\n');",
    "if (args[0] === 'plugins' && args[1] === 'list') process.stdout.write(JSON.stringify({ plugins: [{ id: 'magclaw-notify', enabled: true }] }));",
    `else if (args[0] === 'config' && args[1] === 'get') process.stdout.write(${JSON.stringify(JSON.stringify({ notifyHome, accountId: 'legacy', instance: 'default', preservedPolicy: 'strict' }))});`,
    "else if (args[0] === 'gateway' && args[1] === 'status') process.stdout.write(JSON.stringify({ service: { running: true } }));",
    "else process.stdout.write(JSON.stringify({ ok: true }));",
    '',
  ].join('\n'));
  await chmod(openclaw, 0o700);
  const paths = notifyDaemonPaths({ ...process.env, MAGCLAW_NOTIFY_HOME: notifyHome }, 'default');
  await configureNotifyHandler(paths.handler, { agentProvider: { command: openclaw } });
  const common = { openclawPath: openclaw, pluginPath, memberAgentId: 'monkey-member', projectName: 'Kizuna', memberReadTools: 'kizuna_read,kizuna_search' };
  const started = await runNotifyOwnerCommand(['plugin', 'start'], common);
  assert.equal(started.installed, true);
  const stopped = await runNotifyOwnerCommand(['plugin', 'stop'], common);
  assert.equal(stopped.installed, true);
  const calls = (await readFile(commandLog, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.some((args) => args.join(' ') === 'plugins enable magclaw-notify'));
  const configSet = calls.find((args) => args[0] === 'config' && args[1] === 'set' && args[2] === 'plugins.entries.magclaw-notify.config');
  assert.ok(configSet && configSet.join(' ').includes('monkey-member'), JSON.stringify(calls));
  const appliedConfig = JSON.parse(configSet[3]);
  assert.equal(appliedConfig.preservedPolicy, 'strict');
  assert.equal(Object.hasOwn(appliedConfig, 'instance'), false);
  assert.equal(Object.hasOwn(appliedConfig, 'accountId'), false);
  assert.deepEqual(appliedConfig.bindings.map((binding) => binding.id), ['monkey']);
  assert.ok(calls.some((args) => args.join(' ') === 'plugins disable magclaw-notify'));
  assert.ok(calls.filter((args) => args[0] === 'gateway' && args[1] === 'restart').length >= 2);
});

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

test('OpenClaw plugin manifest id matches definePluginEntry and installs as a fixed bundled copy', async () => {
  const source = path.join(process.cwd(), 'notify-owner', 'openclaw-plugin');
  const manifest = JSON.parse(await readFile(path.join(source, 'openclaw.plugin.json'), 'utf8'));
  const entry = await readFile(path.join(source, 'index.js'), 'utf8');
  const entryId = entry.match(/definePluginEntry\s*\(\s*\{[\s\S]*?\bid:\s*['"]([^'"]+)['"]/)?.[1] || '';
  assert.equal(entryId, manifest.id);

  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-plugin-install-'));
  const target = path.join(root, '.openclaw', 'plugins', 'magclaw-notify');
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const built = spawnSync(npm, ['--prefix', 'notify-owner', 'run', 'build'], {
    cwd: process.cwd(), encoding: 'utf8',
  });
  assert.equal(built.status, 0, built.stderr || built.stdout);
  const installed = spawnSync(process.execPath, [path.join(process.cwd(), 'notify-owner', 'bin', 'magclaw-notify-owner.js'), 'install', '--target', target], {
    cwd: process.cwd(), encoding: 'utf8',
  });
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(JSON.parse(installed.stdout).pluginPath, target);
  assert.equal(JSON.parse(await readFile(path.join(target, 'openclaw.plugin.json'), 'utf8')).id, manifest.id);
  const bundle = await readFile(path.join(target, 'index.js'), 'utf8');
  assert.equal(bundle.includes(process.cwd()), false);
  assert.doesNotMatch(bundle, /\/private\/tmp\/magclaw-notify-remediation/);
  assert.match(bundle, /definePluginEntry/);
});

test('Notify state dump is readable and legacy export can be migrated for rollback', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-state-dump-'));
  const instance = 'state-dump';
  const paths = notifyDaemonPaths({ MAGCLAW_NOTIFY_HOME: root }, instance);
  const store = await ensureNotifyStateStore(paths.handler);
  store.write('config', 'state', { relayId: 'nrl_dump', token: 'must-not-print', enabled: true });
  store.write('directory', 'state', { groups: [{ id: 'grp_1', name: '测试群' }], people: [] });
  store.write('requests', 'nreq_dump', { id: 'nreq_dump', status: 'processing' });
  store.createDeliveryIntent({ id: 'ndi_dump', requestId: 'nreq_dump', request: { id: 'nreq_dump' }, idempotencyKey: 'safe-key' });
  const dump = await runNotifyOwnerCommand(['state', 'dump'], { instance, notifyHome: root });
  assert.equal(dump.state.config.state.token, '[redacted]');
  assert.equal(dump.state.directory.state.groups[0].name, '测试群');
  assert.equal(dump.state.requests.nreq_dump.id, 'nreq_dump');
  assert.equal(dump.deliveryIntents[0].status, 'pending');

  const rollbackProfile = path.join(root, 'rollback-profile');
  const legacyDir = path.join(rollbackProfile, 'notify');
  const exported = await runNotifyOwnerCommand(['state', 'dump'], { instance, notifyHome: root, legacyDir });
  assert.equal(exported.format, 'legacy-json');
  assert.ok(exported.fileCount >= 7);
  const rollbackStore = await ensureNotifyStateStore({ dir: rollbackProfile, profile: 'rollback' });
  assert.equal(rollbackStore.read('config', 'state', {}).token, 'must-not-print');
  assert.equal(rollbackStore.read('requests', 'nreq_dump', {}).status, 'processing');
  const archived = await readdir(legacyDir);
  assert.ok(archived.some((name) => name.startsWith('config.json.migrated-')));
  closeNotifyStateStore(paths.handler);
  closeNotifyStateStore({ dir: rollbackProfile });
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
