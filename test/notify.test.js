import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { handleNotifyApi } from '../server/api/notify-routes.js';
import {
  applyNotifyResult,
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
  resolveNotifyGroup,
  resolveNotifyPeople,
} from '../cli-core/src/notify-handler.js';
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

function routeDeps(state, overrides = {}) {
  let id = 0;
  return {
    currentActor: () => ({
      user: { id: 'usr_1', name: '张三', email: 'zhangsan@example.com' },
      member: { workspaceId: 'ws_1', humanId: 'hum_1', role: 'member' },
    }),
    currentUser: () => ({ id: 'usr_1', name: '张三', email: 'zhangsan@example.com' }),
    daemonRelay: {
      deliverNotifyRequest: async (_computer, request) => ({ queued: true, delivery: { id: `adl_${request.id}` } }),
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

test('Notify device login issues a machine-bound token and submits an external-safe request', async () => {
  const fingerprint = `mfp_${'a'.repeat(64)}`;
  const state = {
    connection: { workspaceId: 'ws_1' },
    cloud: { workspaces: [{ id: 'ws_1' }] },
    computers: [{ id: 'cmp_1', workspaceId: 'ws_1', status: 'connected', connectedVia: 'daemon' }],
    notifyRecords: [],
  };
  const deps = routeDeps(state);
  const started = await callRoute(deps, 'POST', '/api/notify/auth/start', {
    body: { workspaceId: 'ws_1', machineFingerprint: fingerprint },
  });
  assert.equal(started.res.status, 201);
  assert.equal(started.res.body.status, 'approved');

  const approved = await callRoute(deps, 'POST', '/api/notify/auth/token', {
    body: { deviceCode: started.res.body.deviceCode, machineFingerprint: fingerprint },
  });
  assert.equal(approved.res.body.status, 'approved');
  assert.ok(approved.res.body.token.startsWith('mcn_'));
  assert.equal(JSON.stringify(state).includes(approved.res.body.token), false);

  const headers = {
    authorization: `Bearer ${approved.res.body.token}`,
    'x-magclaw-machine-fingerprint': fingerprint,
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
  assert.deepEqual(Object.keys(submitted.res.body.request).sort(), ['completedAt', 'createdAt', 'id', 'reason', 'status', 'target', 'title', 'updatedAt'].sort());
  assert.equal(JSON.stringify(submitted.res.body).includes('cmp_1'), false);

  deps.daemonRelay.deliverNotifyRequest = async (_computer, request) => {
    applyNotifyResult(state, {
      requestId: request.id,
      status: 'awaiting_configuration',
      publicReason: 'Notify groups are not configured.',
    }, deps.now);
    return { queued: true, delivery: { id: `adl_${request.id}` } };
  };
  const fastResult = await callRoute(deps, 'POST', '/api/notify/requests', {
    headers: { ...headers, 'idempotency-key': 'session-1:turn-2:研发群' },
    body: {
      explicitUserAuthorization: true,
      target: { group: '研发群' },
      content: { title: '快速回写', markdown: '- 本地配置尚未完成' },
      context: { sessionId: 'session-1', turnId: 'turn-2' },
    },
  });
  assert.equal(fastResult.res.body.request.status, 'awaiting_configuration');
  assert.equal(fastResult.res.body.request.reason, 'Notify groups are not configured.');

  const token = notifyTokenForRequest(state, { headers }, 'notify:status');
  assert.ok(token);
  assert.equal(token.machineFingerprint, fingerprint);
  assert.equal(notifyRecords(state).filter((record) => record.type === 'request').length, 2);
});

test('Notify browser approval cannot cross MagClaw workspaces', async () => {
  const state = {
    connection: { workspaceId: 'ws_1' },
    cloud: { workspaces: [{ id: 'ws_1' }, { id: 'ws_2' }] },
    computers: [],
    notifyRecords: [],
  };
  const deps = routeDeps(state);
  const started = await callRoute(deps, 'POST', '/api/notify/auth/start', {
    body: { workspaceId: 'ws_2', machineFingerprint: `mfp_${'b'.repeat(64)}` },
  });
  assert.equal(started.res.body.status, 'pending');
  const approvalUrl = `${started.res.body.verificationUri}`;
  const approval = await callRoute(deps, 'GET', approvalUrl);
  assert.equal(approval.res.status, 403);
  assert.equal(notifyRecords(state).find((record) => record.type === 'auth_device').status, 'pending');
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

test('Notify machine result reporting updates only its routed request', async () => {
  const state = {
    notifyRecords: [{
      id: 'nreq_result',
      type: 'request',
      workspaceId: 'ws_1',
      computerId: 'cmp_1',
      requesterTokenId: 'nat_1',
      status: 'awaiting_confirmation',
      payload: { target: { group: '研发群' }, content: { title: '本轮更新' } },
      createdAt: new Date(1_800_000_000_000).toISOString(),
      updatedAt: new Date(1_800_000_000_000).toISOString(),
    }],
  };
  const deps = routeDeps(state, {
    authenticateDaemonRequest: () => ({ workspaceId: 'ws_1', computerId: 'cmp_1' }),
  });
  const reported = await callRoute(deps, 'POST', '/api/notify/internal/result', {
    body: { requestId: 'nreq_result', status: 'rejected', publicReason: 'Owner rejected the mapping.' },
  });
  assert.equal(reported.res.status, 200);
  assert.equal(reported.res.body.request.status, 'rejected');
  assert.equal(state.notifyRecords[0].status, 'rejected');

  deps.authenticateDaemonRequest = () => ({ workspaceId: 'ws_1', computerId: 'cmp_other' });
  const denied = await callRoute(deps, 'POST', '/api/notify/internal/result', {
    body: { requestId: 'nreq_result', status: 'sent' },
  });
  assert.equal(denied.res.status, 404);
});

test('Notify machine route registration cannot replace another active computer', async () => {
  const state = {
    computers: [
      { id: 'cmp_1', workspaceId: 'ws_1', status: 'connected' },
      { id: 'cmp_2', workspaceId: 'ws_1', status: 'connected' },
    ],
    notifyRecords: [],
  };
  const deps = routeDeps(state, {
    authenticateDaemonRequest: () => ({ workspaceId: 'ws_1', computerId: 'cmp_1' }),
  });
  const registered = await callRoute(deps, 'POST', '/api/notify/internal/route');
  assert.equal(registered.res.status, 200);
  assert.equal(registered.res.body.route.registered, true);
  assert.equal(state.notifyRecords.find((record) => record.type === 'route').computerId, 'cmp_1');

  deps.authenticateDaemonRequest = () => ({ workspaceId: 'ws_1', computerId: 'cmp_2' });
  const conflict = await callRoute(deps, 'POST', '/api/notify/internal/route');
  assert.equal(conflict.res.status, 409);
  assert.equal(state.notifyRecords.find((record) => record.type === 'route').computerId, 'cmp_1');
});
