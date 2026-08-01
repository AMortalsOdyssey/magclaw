import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { handleNotifyApi } from '../server/api/notify-routes.js';
import {
  NOTIFY_TOKEN_TTL_MS,
  hashNotifySecret,
  normalizeNotifySubmission,
  notifyRecords,
  notifyTokenForRequest,
} from '../server/notify.js';
import {
  addNotifyGroup,
  addNotifyPerson,
  confirmNotifyMapping,
  configureNotifyHandler,
  handleNotifyDelivery,
  larkCardForNotify,
  mergeNotifyMentions,
  resolveNotifyGroup,
  resolveNotifyPeople,
} from '../notify/src/handler.js';
import { notifyIdempotencyKey } from '../notify/src/cli.js';

function responseRecorder() {
  return {
    status: 0,
    body: null,
    headers: {},
    writeHead(status, headers = {}) { this.status = status; this.headers = headers; },
    end(body = '') { this.raw = body; },
  };
}

function feishuUser(id = 'usr_1', name = '张三', tenantKey = 'tenant_1') {
  return {
    id,
    name,
    email: `${id}@example.com`,
    thirdPartyProvider: 'feishu',
    metadata: {
      oauth: {
        feishu: {
          providerAccountId: `union_${id}`,
          tenantKey,
          openId: `ou_${id}`,
          unionId: `union_${id}`,
          userId: `feishu_${id}`,
          linkedAt: '2026-08-01T00:00:00.000Z',
          lastLoginAt: '2026-08-01T00:00:00.000Z',
          accessToken: 'raw_feishu_access_token_must_not_be_copied',
        },
      },
    },
  };
}

function routeDeps(state, overrides = {}) {
  let id = 0;
  const user = feishuUser();
  return {
    currentActor: () => ({
      user,
      member: { workspaceId: 'ws_1', humanId: 'hum_1', role: 'member' },
    }),
    currentUser: () => user,
    notifyRelay: {
      deliverNotifyRequest: async (request) => ({ queued: true, delivery: { id: `ndl_${request.id}` } }),
    },
    getState: () => state,
    makeId: (prefix) => `${prefix}_${++id}`,
    now: () => new Date(1_800_000_000_000 + id * 1000).toISOString(),
    persistState: async () => {},
    readJson: async (req) => req.body || {},
    sendError: (res, status, message) => { res.status = status; res.body = { error: message }; },
    sendJson: (res, status, body) => { res.status = status; res.body = body; },
    ...overrides,
  };
}

async function callRoute(deps, method, pathname, options = {}) {
  const req = {
    method,
    url: pathname,
    headers: options.headers || {},
    body: options.body || {},
    socket: { remoteAddress: '127.0.0.1' },
  };
  const res = responseRecorder();
  const handled = await handleNotifyApi(req, res, new URL(pathname, 'http://magclaw.test'), deps);
  assert.equal(handled, true);
  return { req, res };
}

test('Notify submission requires explicit current-turn authorization and strips raw mentions', () => {
  assert.throws(() => normalizeNotifySubmission({ group: '研发群', markdown: 'done' }), /explicit user authorization/i);
  assert.throws(() => normalizeNotifySubmission({ explicitUserAuthorization: true, group: '研发群', markdown: 'done', chat_id: 'oc_secret' }), /Raw Feishu identifiers/i);
  const payload = normalizeNotifySubmission({
    explicitUserAuthorization: true,
    group: '研发群',
    markdown: '<at user_id="ou_secret">张三</at> 完成修复 @all',
  });
  assert.equal(payload.target.group, '研发群');
  assert.equal(payload.content.markdown, '完成修复');
});

test('Notify idempotency keys are stable ASCII even for Chinese group names', () => {
  const first = notifyIdempotencyKey('session-1:turn-1:研发群');
  assert.equal(first, notifyIdempotencyKey('session-1:turn-1:研发群'));
  assert.match(first, /^mcn_[A-Za-z0-9_-]{43}$/);
});

test('Standalone Notify Daemon creates a stable handle and one-time setup token', async () => {
  const fingerprint = `mfp_${'a'.repeat(64)}`;
  const state = {
    connection: { workspaceId: 'ws_1' },
    cloud: { workspaces: [{ id: 'ws_1' }] },
    notifyRecords: [],
  };
  const deps = routeDeps(state);
  const started = await callRoute(deps, 'POST', '/api/notify/daemon/auth/start', {
    body: { relayName: 'MagClaw', machineFingerprint: fingerprint },
  });
  assert.equal(started.res.status, 201);
  assert.equal(started.res.body.status, 'pending');

  const approval = await callRoute(deps, 'GET', started.res.body.verificationUri);
  assert.equal(approval.res.status, 200);
  const installation = notifyRecords(state).find((record) => record.type === 'installation');
  assert.match(installation.handle, /^magclaw-[a-f0-9]{7}$/);
  assert.equal(installation.machineFingerprint, fingerprint);
  assert.equal(installation.computerId, undefined);

  const repeatedStart = await callRoute(deps, 'POST', '/api/notify/daemon/auth/start', {
    body: { machineFingerprint: fingerprint },
  });
  await callRoute(deps, 'GET', repeatedStart.res.body.verificationUri);
  assert.equal(notifyRecords(state).filter((record) => record.type === 'installation').length, 1);

  const renamedStart = await callRoute(deps, 'POST', '/api/notify/daemon/auth/start', {
    body: { relayName: 'Monkey', machineFingerprint: fingerprint },
  });
  await callRoute(deps, 'GET', renamedStart.res.body.verificationUri);
  const installations = notifyRecords(state).filter((record) => record.type === 'installation');
  assert.equal(installations.length, 2);
  assert.match(installations[1].handle, /^monkey-[a-f0-9]{7}$/);

  const approved = await callRoute(deps, 'POST', '/api/notify/daemon/auth/token', {
    body: { deviceCode: started.res.body.deviceCode, machineFingerprint: fingerprint },
  });
  assert.equal(approved.res.body.status, 'approved');
  assert.equal(approved.res.body.relayHandle, installation.handle);
  assert.match(approved.res.body.inviteToken, new RegExp(`^mcn_inv_${installation.handle}_`));
  assert.equal(JSON.stringify(state).includes(approved.res.body.inviteToken), false);
  assert.ok(notifyTokenForRequest(state, { headers: {
    authorization: `Bearer ${approved.res.body.token}`,
    'x-magclaw-machine-fingerprint': fingerprint,
  } }, 'notify:daemon'));
  const daemonToken = notifyRecords(state).find((record) => record.type === 'auth_token' && record.authMode === 'daemon');
  assert.equal(JSON.stringify(daemonToken).includes('raw_feishu_access_token_must_not_be_copied'), false);
  assert.equal(daemonToken.user.identity.openId, 'ou_usr_1');
});

test('Notify sender authorization lasts 90 days and is limited to the owner Feishu tenant', async () => {
  assert.equal(NOTIFY_TOKEN_TTL_MS, 90 * 24 * 60 * 60 * 1000);
  const daemonFingerprint = `mfp_${'1'.repeat(64)}`;
  const state = {
    connection: { workspaceId: 'ws_1' },
    cloud: { workspaces: [{ id: 'ws_1' }], users: [] },
    notifyRecords: [],
  };
  let currentUser = feishuUser('usr_owner', 'Owner', 'tenant_owner');
  const deps = routeDeps(state, {
    currentUser: () => currentUser,
    currentActor: () => ({ user: currentUser, member: { workspaceId: 'ws_1', humanId: 'hum_owner', role: 'owner' } }),
  });
  const daemonStart = await callRoute(deps, 'POST', '/api/notify/daemon/auth/start', {
    body: { relayName: 'Monkey', machineFingerprint: daemonFingerprint },
  });
  await callRoute(deps, 'GET', daemonStart.res.body.verificationUri);
  const daemonAuth = await callRoute(deps, 'POST', '/api/notify/daemon/auth/token', {
    body: { deviceCode: daemonStart.res.body.deviceCode, machineFingerprint: daemonFingerprint },
  });

  currentUser = feishuUser('usr_outside', 'Outside', 'tenant_outside');
  const denied = await callRoute(deps, 'POST', '/api/notify/auth/start', {
    body: { inviteToken: daemonAuth.res.body.inviteToken, machineFingerprint: `mfp_${'2'.repeat(64)}` },
  });
  assert.equal(denied.res.status, 403);
  assert.match(denied.res.body.error, /owner's Feishu tenant/i);

  currentUser = feishuUser('usr_sender', 'Sender', 'tenant_owner');
  const before = Date.now();
  const clientStart = await callRoute(deps, 'POST', '/api/notify/auth/start', {
    body: { inviteToken: daemonAuth.res.body.inviteToken, machineFingerprint: `mfp_${'3'.repeat(64)}` },
  });
  const clientAuth = await callRoute(deps, 'POST', '/api/notify/auth/token', {
    body: { deviceCode: clientStart.res.body.deviceCode, machineFingerprint: `mfp_${'3'.repeat(64)}` },
  });
  const lifetime = Date.parse(clientAuth.res.body.tokenExpiresAt) - before;
  assert.ok(lifetime <= NOTIFY_TOKEN_TTL_MS && lifetime >= NOTIFY_TOKEN_TTL_MS - 2000);
});

test('Notify owner can list and revoke sender access and rotate a leaked Setup Token', async () => {
  const daemonFingerprint = `mfp_${'4'.repeat(64)}`;
  const firstClientFingerprint = `mfp_${'5'.repeat(64)}`;
  const secondClientFingerprint = `mfp_${'6'.repeat(64)}`;
  const state = {
    connection: { workspaceId: 'ws_1' },
    cloud: { workspaces: [{ id: 'ws_1' }], users: [] },
    notifyRecords: [],
  };
  const ownerUser = feishuUser('usr_owner', 'Owner', 'tenant_owner');
  const senderUser = feishuUser('usr_sender', 'Sender', 'tenant_owner');
  let currentUser = ownerUser;
  const deps = routeDeps(state, {
    currentUser: () => currentUser,
    currentActor: () => ({ user: currentUser, member: { workspaceId: 'ws_1', humanId: 'hum_dynamic', role: 'owner' } }),
  });
  const daemonStart = await callRoute(deps, 'POST', '/api/notify/daemon/auth/start', {
    body: { relayName: 'Monkey', machineFingerprint: daemonFingerprint, client: { hostname: 'owner-mac', platform: 'darwin', arch: 'arm64' } },
  });
  await callRoute(deps, 'GET', daemonStart.res.body.verificationUri);
  const daemonAuth = await callRoute(deps, 'POST', '/api/notify/daemon/auth/token', {
    body: { deviceCode: daemonStart.res.body.deviceCode, machineFingerprint: daemonFingerprint },
  });
  const daemonHeaders = {
    authorization: `Bearer ${daemonAuth.res.body.token}`,
    'x-magclaw-machine-fingerprint': daemonFingerprint,
  };

  currentUser = senderUser;
  const loginClient = async (fingerprint, hostname) => {
    const started = await callRoute(deps, 'POST', '/api/notify/auth/start', {
      body: {
        inviteToken: daemonAuth.res.body.inviteToken,
        machineFingerprint: fingerprint,
        client: { hostname, platform: 'darwin', arch: 'arm64' },
      },
    });
    return callRoute(deps, 'POST', '/api/notify/auth/token', {
      body: { deviceCode: started.res.body.deviceCode, machineFingerprint: fingerprint },
    });
  };
  const firstClient = await loginClient(firstClientFingerprint, 'sender-one');
  const secondClient = await loginClient(secondClientFingerprint, 'sender-two');
  const pendingFingerprint = `mfp_${'9'.repeat(64)}`;
  const pendingFromOldSetupToken = await callRoute(deps, 'POST', '/api/notify/auth/start', {
    body: {
      inviteToken: daemonAuth.res.body.inviteToken,
      machineFingerprint: pendingFingerprint,
      client: { hostname: 'pending-sender', platform: 'darwin', arch: 'arm64' },
    },
  });
  const firstHeaders = {
    authorization: `Bearer ${firstClient.res.body.token}`,
    'x-magclaw-machine-fingerprint': firstClientFingerprint,
  };
  const secondHeaders = {
    authorization: `Bearer ${secondClient.res.body.token}`,
    'x-magclaw-machine-fingerprint': secondClientFingerprint,
  };

  const listed = await callRoute(deps, 'GET', '/api/notify/daemon/access', { headers: daemonHeaders });
  assert.equal(listed.res.status, 200);
  assert.equal(listed.res.body.counts.active, 2);
  assert.deepEqual(listed.res.body.access.map((record) => record.device.hostname).sort(), ['sender-one', 'sender-two']);
  assert.equal(listed.res.body.access[0].user.identity.openId, 'ou_usr_sender');
  assert.equal(JSON.stringify(listed.res.body).includes('raw_feishu_access_token_must_not_be_copied'), false);

  const clientCannotManage = await callRoute(deps, 'GET', '/api/notify/daemon/access', { headers: firstHeaders });
  assert.equal(clientCannotManage.res.status, 401);

  const firstAccess = listed.res.body.access.find((record) => record.device.hostname === 'sender-one');
  const revoked = await callRoute(deps, 'POST', '/api/notify/daemon/access/revoke', {
    headers: daemonHeaders,
    body: { accessId: firstAccess.id },
  });
  assert.equal(revoked.res.body.revoked, 1);
  const firstWhoami = await callRoute(deps, 'GET', '/api/notify/auth/whoami', { headers: firstHeaders });
  assert.equal(firstWhoami.res.status, 401);
  const secondWhoami = await callRoute(deps, 'GET', '/api/notify/auth/whoami', { headers: secondHeaders });
  assert.equal(secondWhoami.res.status, 200);

  const oldSetupToken = daemonAuth.res.body.inviteToken;
  const rotated = await callRoute(deps, 'POST', '/api/notify/daemon/setup-token/rotate', {
    headers: daemonHeaders,
    body: { revokeExisting: true },
  });
  assert.equal(rotated.res.status, 200);
  assert.notEqual(rotated.res.body.setupToken, oldSetupToken);
  assert.equal(rotated.res.body.revokedExistingAccess, 1);
  assert.equal(JSON.stringify(state).includes(rotated.res.body.setupToken), false);

  const oldTokenDenied = await callRoute(deps, 'POST', '/api/notify/auth/start', {
    body: { inviteToken: oldSetupToken, machineFingerprint: `mfp_${'7'.repeat(64)}` },
  });
  assert.equal(oldTokenDenied.res.status, 404);
  const pendingTokenDenied = await callRoute(deps, 'POST', '/api/notify/auth/token', {
    body: { deviceCode: pendingFromOldSetupToken.res.body.deviceCode, machineFingerprint: pendingFingerprint },
  });
  assert.equal(pendingTokenDenied.res.body.status, 'rejected');
  assert.equal(pendingTokenDenied.res.body.reason, 'setup_token_rotated');
  const newTokenAccepted = await callRoute(deps, 'POST', '/api/notify/auth/start', {
    body: { inviteToken: rotated.res.body.setupToken, machineFingerprint: `mfp_${'8'.repeat(64)}` },
  });
  assert.equal(newTokenAccepted.res.status, 201);
  const secondWhoamiAfterRotation = await callRoute(deps, 'GET', '/api/notify/auth/whoami', { headers: secondHeaders });
  assert.equal(secondWhoamiAfterRotation.res.status, 401);

  const audit = await callRoute(deps, 'GET', '/api/notify/daemon/access?include_revoked=1', { headers: daemonHeaders });
  assert.equal(audit.res.body.counts.revoked, 2);
  assert.equal(audit.res.body.access.every((record) => record.status === 'revoked'), true);
});

test('Setup token routes an authenticated client request to exactly one independent Notify Relay', async () => {
  const daemonFingerprint = `mfp_${'b'.repeat(64)}`;
  const clientFingerprint = `mfp_${'c'.repeat(64)}`;
  const state = {
    connection: { workspaceId: 'ws_1' },
    cloud: { workspaces: [{ id: 'ws_1' }] },
    notifyRecords: [],
  };
  const delivered = [];
  const deps = routeDeps(state, {
    notifyRelay: {
      deliverNotifyRequest: async (request) => {
        delivered.push(request);
        return { queued: true, delivery: { id: `ndl_${request.id}` } };
      },
    },
  });
  const daemonStart = await callRoute(deps, 'POST', '/api/notify/daemon/auth/start', {
    body: { relayName: 'Monkey', machineFingerprint: daemonFingerprint },
  });
  await callRoute(deps, 'GET', daemonStart.res.body.verificationUri);
  const daemonAuth = await callRoute(deps, 'POST', '/api/notify/daemon/auth/token', {
    body: { deviceCode: daemonStart.res.body.deviceCode, machineFingerprint: daemonFingerprint },
  });
  const installation = notifyRecords(state).find((record) => record.type === 'installation');

  const clientStart = await callRoute(deps, 'POST', '/api/notify/auth/start', {
    body: { inviteToken: daemonAuth.res.body.inviteToken, machineFingerprint: clientFingerprint },
  });
  const clientAuth = await callRoute(deps, 'POST', '/api/notify/auth/token', {
    body: { deviceCode: clientStart.res.body.deviceCode, machineFingerprint: clientFingerprint },
  });
  const headers = {
    authorization: `Bearer ${clientAuth.res.body.token}`,
    'x-magclaw-machine-fingerprint': clientFingerprint,
    'idempotency-key': 'session-1:turn-1:研发群',
  };
  const submitted = await callRoute(deps, 'POST', '/api/notify/requests', {
    headers,
    body: {
      explicitUserAuthorization: true,
      target: { group: '研发群' },
      content: { title: '修复完成', markdown: '- 修复重复回调' },
      context: { sessionId: 'session-1', turnId: 'turn-1' },
    },
  });
  assert.equal(submitted.res.status, 202);
  assert.equal(submitted.res.body.request.status, 'queued');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].relayId, installation.id);
  assert.equal(delivered[0].computerId, undefined);
  assert.equal(JSON.stringify(submitted.res.body).includes(installation.id), false);

  const token = notifyTokenForRequest(state, { headers }, 'notify:status');
  assert.equal(token.relayId, installation.id);
});

test('Notify local directory keeps exact aliases deterministic and fuzzy groups confirmation-only', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-test-'));
  const profilePaths = { dir: root };
  const group = await addNotifyGroup(profilePaths, { name: '研发一群', chatId: 'oc_local_only', aliases: ['技术研发群'] });
  const person = await addNotifyPerson(profilePaths, { name: '张三', openId: 'ou_local_only', aliases: ['Zhang San'], groupChatIds: ['oc_local_only'] });
  const directory = JSON.parse(await readFile(path.join(root, 'notify', 'directory.json'), 'utf8'));

  assert.equal(resolveNotifyGroup(directory, '技术研发群').group.id, group.id);
  assert.equal(resolveNotifyGroup(directory, '研发群').status, 'confirmation_required');
  assert.equal(resolveNotifyGroup(directory, '运营群').status, 'unavailable');
  assert.equal(resolveNotifyPeople(directory, ['Zhang San'], group)[0].person.id, person.id);
});

test('Notify lark-cli card injects only locally resolved Feishu mentions', () => {
  const card = larkCardForNotify(
    { title: '修复完成', markdown: '- 已修复登录问题' },
    [{ person: { name: '张三', openId: 'ou_local_only' } }],
    { name: '李四' },
  );
  assert.equal(card.header.title.content, '修复完成');
  assert.match(card.body.elements[0].content, /^<at id=ou_local_only><\/at>/);
  assert.match(card.body.elements[2].content, /由 李四/);
});

test('Notify analysis cannot drop explicitly requested mentions', () => {
  assert.deepEqual(mergeNotifyMentions(['蒋海波'], []), ['蒋海波']);
  assert.deepEqual(
    mergeNotifyMentions(['蒋海波'], ['蒋海波', '张三']),
    ['蒋海波', '张三'],
  );
});

test('Notify handler records local context and stops at empty group configuration', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-handler-'));
  const result = await handleNotifyDelivery({ dir: root }, {
    id: 'nreq_context',
    requester: { id: 'hum_remote', name: '李四' },
    payload: {
      target: { group: '研发群' },
      content: { title: '本轮更新', markdown: '- 完成修复' },
      context: { sourceAgent: 'codex', sessionId: 'sess_1', turnId: 'turn_2', repository: 'repo' },
    },
  });
  assert.equal(result.status, 'awaiting_configuration');
  const memory = JSON.parse(await readFile(path.join(root, 'notify', 'memory.json'), 'utf8'));
  assert.equal(memory.recentContexts[0].sessionId, 'sess_1');
  assert.equal(memory.recentContexts[0].turnId, 'turn_2');
  assert.equal(memory.requesters.hum_remote.name, '李四');
});

test('Notify OpenClaw delivery never silently drops a requested Feishu mention', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-openclaw-mention-'));
  const profilePaths = { dir: root };
  await addNotifyGroup(profilePaths, { name: '研发群', chatId: 'oc_local_only' });
  await addNotifyPerson(profilePaths, { name: '张三', openId: 'ou_local_only', groupChatIds: ['oc_local_only'] });
  await configureNotifyHandler(profilePaths, {
    agentProvider: { command: path.join(root, 'missing-agent') },
    deliveryProvider: { kind: 'openclaw-feishu', account: 'monkey', enabled: true },
  });
  const result = await handleNotifyDelivery(profilePaths, {
    id: 'nreq_openclaw_mention',
    requester: { id: 'hum_remote', name: '李四' },
    payload: {
      target: { group: '研发群' },
      content: { title: '本轮更新', markdown: '- 完成修复' },
      mentions: ['张三'],
      context: {},
    },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.publicReason, 'Notify delivery failed.');
});

test('Notify owner confirmation persists a fuzzy group alias and resumes the stored request', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-confirm-'));
  const profilePaths = { dir: root, profile: 'confirm-test', config: path.join(root, 'config.json') };
  await configureNotifyHandler(profilePaths, { agentProvider: { command: path.join(root, 'missing-agent') } });
  await addNotifyGroup(profilePaths, { name: '研发一群', chatId: 'oc_local_only' });
  const request = {
    id: 'nreq_confirm',
    requester: { id: 'hum_remote', name: '李四' },
    payload: {
      target: { group: '研发群' },
      content: { title: '本轮更新', markdown: '- 完成修复' },
      mentions: [],
      context: {},
    },
  };
  const awaiting = await handleNotifyDelivery(profilePaths, request);
  assert.equal(awaiting.status, 'awaiting_confirmation');
  const pending = JSON.parse(await readFile(path.join(root, 'notify', 'pending-confirmations.json'), 'utf8'));
  const confirmed = await confirmNotifyMapping(profilePaths, pending[0].id, 'approve');
  assert.equal(confirmed.confirmation.status, 'approved');
  assert.equal(confirmed.result.status, 'awaiting_configuration');
  assert.equal(confirmed.cloudReport.reported, false);
  const directory = JSON.parse(await readFile(path.join(root, 'notify', 'directory.json'), 'utf8'));
  assert.deepEqual(directory.groups[0].confirmedAliases, ['研发群']);
});

test('Notify Daemon result reporting updates only its own Relay request', async () => {
  const daemonToken = 'mcn_daemon_relay_one';
  const otherToken = 'mcn_daemon_relay_two';
  const state = {
    notifyRecords: [
      {
        id: 'nat_daemon_1', type: 'auth_token', workspaceId: 'ws_1', relayId: 'nrl_1',
        tokenHash: hashNotifySecret(daemonToken), scopes: ['notify:daemon'],
      },
      {
        id: 'nat_daemon_2', type: 'auth_token', workspaceId: 'ws_1', relayId: 'nrl_2',
        tokenHash: hashNotifySecret(otherToken), scopes: ['notify:daemon'],
      },
      {
        id: 'nreq_result', type: 'request', workspaceId: 'ws_1', relayId: 'nrl_1',
        requesterTokenId: 'nat_1', status: 'awaiting_confirmation',
        payload: { target: { group: '研发群' }, content: { title: '本轮更新' } },
        createdAt: new Date(1_800_000_000_000).toISOString(),
        updatedAt: new Date(1_800_000_000_000).toISOString(),
      },
    ],
  };
  const deps = routeDeps(state);
  const reported = await callRoute(deps, 'POST', '/api/notify/daemon/result', {
    headers: { authorization: `Bearer ${daemonToken}` },
    body: { requestId: 'nreq_result', status: 'rejected', publicReason: 'Owner rejected the mapping.' },
  });
  assert.equal(reported.res.status, 200);
  assert.equal(reported.res.body.request.status, 'rejected');
  assert.equal(state.notifyRecords.find((record) => record.id === 'nreq_result').status, 'rejected');

  const denied = await callRoute(deps, 'POST', '/api/notify/daemon/result', {
    headers: { authorization: `Bearer ${otherToken}` },
    body: { requestId: 'nreq_result', status: 'sent' },
  });
  assert.equal(denied.res.status, 404);
});
