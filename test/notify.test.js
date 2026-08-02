import assert from 'node:assert/strict';
import { chmod, mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
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
  approvalCardUpdateAttempts,
  confirmNotifyMapping,
  configureNotifyHandler,
  handleNotifyDelivery,
  larkCardForApprovalOutcome,
  larkCardForTargetApproval,
  listNotifyTargetGrants,
  larkCardForNotify,
  isPrivateNotifyAddress,
  mergeNotifyMentions,
  resolveNotifyGroup,
  resolveNotifyPeople,
  prepareNotifyDelivery,
} from '../notify/src/handler.js';
import { installNotifyIntegrations, notifyIdempotencyKey } from '../notify/src/cli.js';
import { handleNotifyMcpTool } from '../notify/src/mcp.js';
import { normalizeNotifySummary, renderNotifySummaryMarkdown } from '../notify/src/summary.js';
import { processNotifyApprovalEvent, startNotifyApprovalListener } from '../notify/src/daemon.js';

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
      listNotifyTargets: async () => ({ available: true, targets: [] }),
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

test('Notify structured summaries normalize mixed work and preserve safe rich content', () => {
  const summary = normalizeNotifySummary({
    headline: '完成通知能力升级并验证富文本',
    taskTypes: ['feature', 'bugfix', 'unknown'],
    sections: [
      { type: 'feature', title: '新增能力', items: [{ status: 'done', text: '支持结构化总结' }] },
      { type: 'bugfix', title: '修复', items: [{ status: 'verified', text: '修复卡片更新', evidence: '18/18' }] },
      { type: 'custom', title: '自定义结论', items: ['保留扩展空间'] },
    ],
    links: [{ label: '技术文档', url: 'https://example.com/docs' }],
    images: [{ url: 'https://example.com/result.png', alt: '结果截图' }],
  }, { required: true });
  assert.deepEqual(summary.taskTypes, ['feature', 'bugfix']);
  const markdown = renderNotifySummaryMarkdown(summary);
  assert.match(markdown, /【已完成】支持结构化总结/);
  assert.match(markdown, /\[技术文档\]\(https:\/\/example.com\/docs\)/);
  assert.match(markdown, /\[结果截图\]\(https:\/\/example.com\/result.png\)/);
  const payload = normalizeNotifySubmission({
    explicitUserAuthorization: true,
    target: { group: '测试' },
    content: { summary },
  });
  assert.equal(payload.schemaVersion, 2);
  assert.equal(payload.content.summary.headline, summary.headline);
  assert.match(payload.content.markdown, /自定义结论/);
  assert.throws(() => normalizeNotifySummary({ headline: 'bad', images: [{ url: 'http://127.0.0.1/a.png' }] }, { required: true }), /HTTPS/);
  assert.equal(isPrivateNotifyAddress('127.0.0.1'), true);
  assert.equal(isPrivateNotifyAddress('192.168.1.1'), true);
  assert.equal(isPrivateNotifyAddress('::1'), true);
  assert.equal(isPrivateNotifyAddress('8.8.8.8'), false);
});

test('Notify integrations install native Skills and a Claude Desktop MCP entry without implicit invocation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-hosts-'));
  const installed = await installNotifyIntegrations({ targets: 'codex,claude-code,claude-desktop' }, {
    homeDir: root,
    platform: 'darwin',
    env: {},
  });
  assert.deepEqual(installed.map((item) => item.kind), ['codex', 'claude-code', 'claude-desktop']);
  const codexMetadata = await readFile(path.join(root, '.codex', 'skills', 'magclaw-notify', 'agents', 'openai.yaml'), 'utf8');
  assert.match(codexMetadata, /allow_implicit_invocation: false/);
  const claudeSkill = await readFile(path.join(root, '.claude', 'skills', 'magclaw-notify', 'SKILL.md'), 'utf8');
  assert.match(claudeSkill, /disable-model-invocation: true/);
  const desktop = JSON.parse(await readFile(path.join(root, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'), 'utf8'));
  assert.equal(desktop.mcpServers['magclaw-notify'].command, 'npx');
  assert.deepEqual(desktop.mcpServers['magclaw-notify'].args.slice(-2), ['@magclaw/notify@0.3.0', 'mcp']);

  const windowsRoot = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-hosts-win-'));
  await installNotifyIntegrations({ targets: 'claude-code,claude-desktop' }, {
    homeDir: windowsRoot,
    platform: 'win32',
    env: { APPDATA: path.join(windowsRoot, 'Roaming') },
  });
  const windowsDesktop = JSON.parse(await readFile(path.join(windowsRoot, 'Roaming', 'Claude', 'claude_desktop_config.json'), 'utf8'));
  assert.equal(windowsDesktop.mcpServers['magclaw-notify'].command, 'cmd.exe');
  assert.deepEqual(windowsDesktop.mcpServers['magclaw-notify'].args.slice(0, 4), ['/d', '/s', '/c', 'npx']);
});

test('Notify MCP preview is non-sending and send tool requires explicit current-turn authorization', async () => {
  const input = {
    group: '测试',
    summary: {
      headline: '完成 MCP 工具接入',
      taskTypes: ['feature'],
      sections: [{ type: 'feature', title: '新增能力', items: [{ status: 'done', text: '支持 Claude Desktop' }] }],
    },
  };
  const preview = await handleNotifyMcpTool('magclaw_notify_preview', input);
  const previewBody = JSON.parse(preview.content[0].text);
  assert.equal(previewBody.sent, false);
  assert.match(previewBody.next, /explicitly confirm/);
  const rejected = await handleNotifyMcpTool('magclaw_notify_send', { ...input, userAuthorizedCurrentTurn: false });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /explicit user authorization/i);
});

test('Notify approval listener keeps lark-cli stdin open until daemon shutdown', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-listener-'));
  const notifyDir = path.join(root, 'notify');
  const fakeLark = path.join(root, 'fake-lark-cli.mjs');
  await mkdir(notifyDir, { recursive: true });
  await writeFile(path.join(notifyDir, 'config.json'), `${JSON.stringify({
    confirmationProvider: {
      kind: 'lark-cli-feishu',
      command: fakeLark,
      account: 'monkey',
      ownerOpenId: 'ou_owner',
      enabled: true,
    },
  })}\n`);
  await writeFile(fakeLark, [
    '#!/usr/bin/env node',
    "process.stdin.resume();",
    "process.stdin.once('end', () => process.exit(19));",
    "setInterval(() => {}, 1000);",
    '',
  ].join('\n'));
  await chmod(fakeLark, 0o755);

  const controller = new AbortController();
  const listener = await startNotifyApprovalListener({ handler: { dir: root } }, controller.signal);
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(listener.child.exitCode, null);
  controller.abort();
  await new Promise((resolve) => listener.child.once('exit', resolve));
});

test('Notify approval cards preserve complete request context across pending, processing, and sent states', () => {
  const confirmation = {
    id: 'ncf_card_detail',
    requestIds: ['nreq_card_detail'],
    details: { userName: '蒋海波', groupName: '测试monkey', requestedGroup: '测试' },
    expiresAt: '2026-08-04T13:35:54.581Z',
    decidedAt: '2026-08-02T13:36:51.943Z',
  };
  const requests = [{
    id: 'nreq_card_detail',
    payload: {
      content: { title: '全链路验收', markdown: '- 第一项完整内容\n- 第二项完整内容' },
      mentions: ['蒋海波'],
      context: { sourceAgent: 'codex', repository: 'magclaw' },
    },
  }];
  const pending = JSON.stringify(larkCardForTargetApproval(confirmation, requests));
  assert.match(pending, /申请人.*蒋海波/);
  assert.match(pending, /测试monkey（请求名称：测试）/);
  assert.match(pending, /第一项完整内容/);
  assert.match(pending, /通知对象：蒋海波/);

  const processing = JSON.stringify(larkCardForApprovalOutcome(
    confirmation, 'once', { status: 'processing' }, { phase: 'processing', requests },
  ));
  assert.match(processing, /仅允许本次 · 正在处理/);
  assert.match(processing, /正在调用本地 Agent/);
  assert.match(processing, /第一项完整内容/);

  const sent = JSON.stringify(larkCardForApprovalOutcome(
    confirmation, 'once', { status: 'sent' }, { phase: 'completed', requests, results: [{ status: 'sent' }] },
  ));
  assert.match(sent, /MagClaw Notify · 已发送/);
  assert.match(sent, /消息 1：已发送/);
  assert.match(sent, /不建立长期授权/);
});

test('Notify approval event updates the original card before and after slow allowed delivery', async () => {
  const calls = [];
  const inspection = {
    handled: true,
    action: { source: 'magclaw_notify', confirmationId: 'ncf_order', decision: 'once' },
    confirmation: { id: 'ncf_order', status: 'pending', requestIds: ['nreq_order'] },
  };
  const handled = { ...inspection, confirmation: { ...inspection.confirmation, status: 'approved_once' }, result: { status: 'sent' } };
  const result = await processNotifyApprovalEvent({ dir: '/tmp/unused' }, { token: 'token' }, {
    inspect: async () => inspection,
    update: async (_paths, _event, value) => { calls.push(`update:${value.phase}:${value.result.status}`); },
    handle: async () => { calls.push('handle'); return handled; },
  });
  assert.equal(result.result.status, 'sent');
  assert.deepEqual(calls, ['update:processing:processing', 'handle', 'update:completed:sent']);
});

test('Notify approval card update falls back from callback token to the original message id', () => {
  const card = { schema: '2.0', header: { title: { tag: 'plain_text', content: '已发送' } }, body: { elements: [] } };
  const attempts = approvalCardUpdateAttempts(
    { account: 'monkey' },
    { token: 'callback_token' },
    { promptMessageId: 'om_original_card' },
    card,
  );
  assert.deepEqual(attempts.map((item) => item.method), ['callback_token', 'message_patch']);
  assert.equal(attempts[0].args.includes('/open-apis/interactive/v1/card/update'), true);
  assert.equal(attempts[1].args.includes('/open-apis/im/v1/messages/om_original_card'), true);
  const patchBody = JSON.parse(attempts[1].args.at(-1));
  assert.deepEqual(JSON.parse(patchBody.content), card);
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
      listNotifyTargets: async (_relayId, requester) => ({ available: true, targets: [{ group: requester.id === 'usr_1' ? '研发群' : '' }] }),
      deliverNotifyRequest: async (request) => {
        delivered.push(request);
        return {
          queued: true,
          delivery: { id: `ndl_${request.id}` },
          ack: {
            status: 'awaiting_owner_approval',
            publicReason: 'Owner approval is pending.',
            confirmationExpiresAt: '2027-01-17T08:00:00.000Z',
            pendingRequestCount: 1,
            batchedRequestIds: [request.id],
          },
        };
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
  assert.equal(submitted.res.body.request.status, 'awaiting_owner_approval');
  assert.equal(submitted.res.body.request.approval.pendingRequestCount, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].relayId, installation.id);
  assert.equal(delivered[0].computerId, undefined);
  assert.equal(JSON.stringify(submitted.res.body).includes(installation.id), false);

  const targets = await callRoute(deps, 'GET', '/api/notify/targets', { headers });
  assert.deepEqual(targets.res.body.targets, [{ group: '研发群' }]);
  assert.equal(JSON.stringify(targets.res.body).includes('oc_'), false);

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
    {
      title: '修复完成',
      markdown: '- 已修复登录问题\n- [变更说明](https://example.com/change)',
      uploadedImages: [{ imageKey: 'img_local_uploaded', alt: '验收截图', caption: '真实验收结果' }],
    },
    [{ person: { name: '张三', openId: 'ou_local_only' } }],
    { name: '李四' },
  );
  assert.equal(card.header.title.content, '修复完成');
  assert.match(card.body.elements[0].content, /^<at id=ou_local_only><\/at>/);
  assert.match(card.body.elements[0].content, /\[变更说明\]\(https:\/\/example.com\/change\)/);
  assert.deepEqual(card.body.elements[2], {
    tag: 'img', img_key: 'img_local_uploaded', alt: { tag: 'plain_text', content: '验收截图' },
  });
  assert.match(card.body.elements.at(-1).content, /由 李四/);
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
  const request = {
    id: 'nreq_openclaw_mention',
    requester: { id: 'hum_remote', name: '李四' },
    payload: {
      target: { group: '研发群' },
      content: { title: '本轮更新', markdown: '- 完成修复' },
      mentions: ['张三'],
      context: {},
    },
  };
  const awaiting = await handleNotifyDelivery(profilePaths, request);
  assert.equal(awaiting.status, 'awaiting_owner_approval');
  const approved = await confirmNotifyMapping(profilePaths, awaiting.confirmationId, 'once');
  assert.equal(approved.result.status, 'failed');
  assert.equal(approved.result.publicReason, 'Notify delivery failed.');
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
  assert.equal(confirmed.result.status, 'awaiting_owner_approval');
  assert.equal(confirmed.cloudReport.reported, false);
  const pendingAfterAlias = JSON.parse(await readFile(path.join(root, 'notify', 'pending-confirmations.json'), 'utf8'));
  const targetApproval = pendingAfterAlias.find((record) => record.kind === 'target_access' && record.status === 'pending');
  const targetApproved = await confirmNotifyMapping(profilePaths, targetApproval.id, 'once');
  assert.equal(targetApproved.result.status, 'awaiting_configuration');
  const directory = JSON.parse(await readFile(path.join(root, 'notify', 'directory.json'), 'utf8'));
  assert.deepEqual(directory.groups[0].confirmedAliases, ['研发群']);
});

test('Notify target approval batches per user and group with once, permanent, owner-only, and 48-hour semantics', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-target-access-'));
  const profilePaths = { dir: root, profile: 'target-access', config: path.join(root, 'daemon-config.json') };
  await configureNotifyHandler(profilePaths, {
    agentProvider: { command: path.join(root, 'missing-agent') },
    confirmationProvider: { ownerOpenId: 'ou_owner' },
  });
  await addNotifyGroup(profilePaths, { name: '测试monkey', chatId: 'oc_local_only', aliases: ['测试'] });
  const makeRequest = (id, requesterId = 'usr_sender') => ({
    id,
    requester: { id: requesterId, name: '李四' },
    payload: {
      target: { group: '测试' },
      content: { title: `本轮更新 ${id}`, markdown: '- 完成修复' },
      mentions: [],
      context: {},
    },
  });

  const first = await prepareNotifyDelivery(profilePaths, makeRequest('nreq_batch_1'));
  const second = await prepareNotifyDelivery(profilePaths, makeRequest('nreq_batch_2'));
  const third = await prepareNotifyDelivery(profilePaths, makeRequest('nreq_batch_3'));
  assert.equal(first.status, 'awaiting_owner_approval');
  assert.equal(first.promptNeeded, true);
  assert.equal(second.confirmationId, first.confirmationId);
  assert.equal(second.promptNeeded, false);
  assert.equal(third.pendingRequestCount, 3);
  const pending = JSON.parse(await readFile(path.join(root, 'notify', 'pending-confirmations.json'), 'utf8'));
  const batch = pending.find((record) => record.id === first.confirmationId);
  assert.ok(Math.abs((Date.parse(batch.expiresAt) - Date.parse(batch.createdAt)) - 48 * 60 * 60 * 1000) < 1000);
  const card = larkCardForTargetApproval(batch);
  assert.deepEqual(card.body.elements.filter((element) => element.tag === 'button').map((element) => element.behaviors[0].value.decision), ['once', 'always', 'reject']);

  await assert.rejects(
    confirmNotifyMapping(profilePaths, first.confirmationId, 'always', { operatorId: 'ou_not_owner' }),
    /Only the configured Notify owner/i,
  );
  const once = await confirmNotifyMapping(profilePaths, first.confirmationId, 'once', { operatorId: 'ou_owner' });
  assert.deepEqual(once.results.map((result) => result.status), ['awaiting_configuration', 'rejected', 'rejected']);
  assert.equal((await listNotifyTargetGrants(profilePaths)).length, 0);

  const next = await prepareNotifyDelivery(profilePaths, makeRequest('nreq_batch_4'));
  const nextAgain = await prepareNotifyDelivery(profilePaths, makeRequest('nreq_batch_5'));
  assert.notEqual(next.confirmationId, first.confirmationId);
  assert.equal(nextAgain.confirmationId, next.confirmationId);
  const always = await confirmNotifyMapping(profilePaths, next.confirmationId, 'always', { operatorId: 'ou_owner' });
  assert.deepEqual(always.results.map((result) => result.status), ['awaiting_configuration', 'awaiting_configuration']);
  const grants = await listNotifyTargetGrants(profilePaths, { userId: 'usr_sender' });
  assert.equal(grants.length, 1);
  assert.equal(grants[0].target.group, '测试monkey');
  const direct = await prepareNotifyDelivery(profilePaths, makeRequest('nreq_batch_6'));
  assert.equal(direct.status, 'processing');
  assert.equal(direct.shouldProcess, true);

  const expiring = await prepareNotifyDelivery(profilePaths, makeRequest('nreq_expired', 'usr_other'));
  const pendingPath = path.join(root, 'notify', 'pending-confirmations.json');
  const expiringRecords = JSON.parse(await readFile(pendingPath, 'utf8'));
  const expiringRecord = expiringRecords.find((record) => record.id === expiring.confirmationId);
  expiringRecord.expiresAt = new Date(Date.now() - 1000).toISOString();
  await writeFile(pendingPath, `${JSON.stringify(expiringRecords, null, 2)}\n`);
  await assert.rejects(confirmNotifyMapping(profilePaths, expiring.confirmationId, 'always', { operatorId: 'ou_owner' }), /expired/i);
  const afterExpiry = JSON.parse(await readFile(pendingPath, 'utf8'));
  assert.equal(afterExpiry.find((record) => record.id === expiring.confirmationId).result.status, 'approval_expired');
  const retry = await prepareNotifyDelivery(profilePaths, makeRequest('nreq_expired_retry', 'usr_other'));
  assert.notEqual(retry.confirmationId, expiring.confirmationId);
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
