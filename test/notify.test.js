import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { handleNotifyApi } from '../server/api/notify-routes.js';
import {
  NOTIFY_DEVICE_TTL_MS,
  NOTIFY_TOKEN_TTL_MS,
  hashNotifySecret,
  normalizeNotifySubmission,
  notifyRecords,
  notifyTokenForRequest,
} from '../server/notify.js';
import {
  addNotifyGroup,
  addNotifyPerson,
  applyNotifyDirectory,
  approvalCardUpdateAttempts,
  confirmNotifyMapping,
  configureNotifyHandler,
  handleNotifyDelivery,
  inspectNotifyCardAction,
  installNotifyHandlerSkill,
  larkCardForApprovalOutcome,
  larkCardForTargetApproval,
  listNotifyDirectory,
  listNotifyTargetGrants,
  larkCardForNotify,
  isPrivateNotifyAddress,
  mergeNotifyMentions,
  resolveNotifyGroup,
  resolveNotifyPeople,
  removeNotifyDirectoryEntry,
  updateNotifyDirectoryAlias,
  prepareNotifyDelivery,
} from '../notify-owner/src/handler.js';
import { installNotifyIntegrations, notifyIdempotencyKey, notifyRequestIdempotencyKey } from '../notify/src/cli.js';
import { notifyProjectPaths } from '../notify/src/connections.js';
import { handleNotifyMcpTool } from '../notify/src/mcp.js';
import { normalizeNotifySummary, redactNotifyPublicText, renderNotifySummaryMarkdown, sanitizeNotifyMarkdown } from '../notify/src/summary.js';
import {
  ensureNotifyRuntimeLogs,
  notifyDaemonPaths,
  processNotifyApprovalEvent,
  runNotifyOwnerCommand,
  startNotifyApprovalListener,
} from '../notify-owner/src/owner.js';
import { notifyExecutableSearchPath, resolveNotifyExecutable } from '../notify-owner/src/executable.js';
import { normalizeNotifyInstance } from '../notify-owner/src/instance.js';
import {
  createNotifyAuditLog,
  LOCAL_NOTIFY_AUDIT_MAX_FILE_BYTES,
  LOCAL_NOTIFY_AUDIT_MAX_FILES,
  sanitizeNotifyAuditRecord,
} from '../notify/src/audit.js';
import { disableNotifyDaemonAutostart, enableNotifyDaemonAutostart, notifyDaemonAutostartStatus, notifyDaemonServiceSpec, stableNotifyNodePath } from '../notify-owner/src/service.js';
import { registerNotifyRuntime } from '../notify-owner/src/runtime-context.js';
import { ensureNotifyStateStore } from '../notify-owner/src/store.js';

async function readNotifyState(profilePaths, collection) {
  return (await ensureNotifyStateStore(profilePaths)).read(collection, 'state', collection === 'pending' || collection === 'receipts' ? [] : {});
}

async function writeNotifyState(profilePaths, collection, value) {
  (await ensureNotifyStateStore(profilePaths)).write(collection, 'state', value);
}

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
      revokeNotifyGrants: async () => ({ available: true, revoked: 0 }),
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

async function approveNotifyDevice(deps, verificationUri) {
  const reviewed = await callRoute(deps, 'GET', verificationUri);
  assert.equal(reviewed.res.status, 200);
  assert.match(reviewed.res.raw, /确认连接 Notify/);
  const csrfToken = reviewed.res.raw.match(/name="csrf_token" value="([^"]+)"/)?.[1] || '';
  const userCode = reviewed.res.raw.match(/name="user_code" value="([^"]+)"/)?.[1] || '';
  assert.ok(csrfToken);
  assert.match(userCode, /^[A-F0-9]{5}-[A-F0-9]{5}$/);
  const approved = await callRoute(deps, 'POST', new URL(verificationUri, 'http://magclaw.test').pathname, {
    body: { user_code: userCode, csrf_token: csrfToken },
  });
  assert.equal(approved.res.status, 200);
  assert.match(approved.res.raw, /Notify 已连接/);
  return { reviewed, approved };
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

test('Notify idempotency keys are stable for turns and unique for standalone sends', () => {
  const first = notifyIdempotencyKey('session-1:turn-1:研发群');
  assert.equal(first, notifyIdempotencyKey('session-1:turn-1:研发群'));
  assert.match(first, /^mcn_[A-Za-z0-9_-]{43}$/);
  assert.equal(
    notifyRequestIdempotencyKey({ sessionId: 'session-1', turnId: 'turn-1' }, '研发群'),
    notifyRequestIdempotencyKey({ sessionId: 'session-1', turnId: 'turn-1' }, '研发群'),
  );
  const values = ['uuid-a', 'uuid-b'];
  assert.notEqual(
    notifyRequestIdempotencyKey({}, '研发群', () => values.shift()),
    notifyRequestIdempotencyKey({}, '研发群', () => values.shift()),
  );
});

test('Notify audit files rotate, keep owner-only permissions, correlate events, and redact secrets and message bodies', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-audit-'));
  const audit = createNotifyAuditLog({ dir: root, scope: 'owner', maxFileBytes: 320, maxFiles: 2 });
  for (let index = 0; index < 5; index += 1) {
    await audit.append({
      event: 'owner.delivery.completed', outcome: 'sent', requestId: `nreq_${index}`,
      confirmationId: `ncf_${index}`, relayId: 'nrl_safe',
      metadata: {
        targetGroup: '测试', repository: '/workspace/magclaw',
        authorization: 'Bearer should-never-appear', token: 'raw-token', chatId: 'oc_secret', openId: 'ou_secret',
        content: 'private message body', error: 'request failed Authorization: Bearer embedded-secret token=another-secret --chat-id oc_hidden ou_hidden mcn_daemon_abcdefghijklmnopqrstuvwxyz0123456789 mfp_abcdefghijklmnopqrstuvwxyz0123456789',
      },
    });
  }
  const files = (await readdir(root)).filter((name) => name.endsWith('.jsonl'));
  assert.equal(files.length, 2);
  assert.equal((await stat(root)).mode & 0o777, 0o700);
  for (const name of files) assert.equal((await stat(path.join(root, name))).mode & 0o777, 0o600);
  const records = await audit.readTail(20);
  const serialized = JSON.stringify(records);
  assert.match(serialized, /nreq_4/);
  assert.match(serialized, /ncf_4/);
  assert.match(serialized, /nrl_safe/);
  assert.match(serialized, /\/workspace\/magclaw/);
  assert.doesNotMatch(serialized, /should-never-appear|raw-token|oc_secret|ou_secret|private message body|embedded-secret|another-secret|oc_hidden|ou_hidden|mcn_daemon_|mfp_/);
  assert.match(serialized, /\[redacted\]/);
  const direct = sanitizeNotifyAuditRecord({ event: 'test', metadata: { password: 'secret', note: 'Bearer abc123' } });
  assert.equal(direct.metadata.password, '[redacted]');
  assert.equal(direct.metadata.note, 'Bearer [redacted]');
});

test('Notify local audit retention is 10x larger and tail reads the latest records across large shards', async () => {
  assert.equal(LOCAL_NOTIFY_AUDIT_MAX_FILE_BYTES, 20 * 1024 * 1024);
  assert.equal(LOCAL_NOTIFY_AUDIT_MAX_FILES, 30);
  assert.equal(
    LOCAL_NOTIFY_AUDIT_MAX_FILE_BYTES * LOCAL_NOTIFY_AUDIT_MAX_FILES,
    (2 * 1024 * 1024 * 30) * 10,
  );

  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-audit-tail-'));
  const audit = createNotifyAuditLog({
    dir: root,
    scope: 'owner',
    maxFileBytes: LOCAL_NOTIFY_AUDIT_MAX_FILE_BYTES,
    maxFiles: LOCAL_NOTIFY_AUDIT_MAX_FILES,
  });
  for (let index = 0; index < 700; index += 1) {
    await audit.append({
      event: 'owner.performance.sample',
      requestId: `nreq_${index}`,
      metadata: { padding: 'safe-observation-'.repeat(8) },
    });
  }
  const status = await audit.status();
  assert.equal(status.maxTotalBytes, LOCAL_NOTIFY_AUDIT_MAX_FILE_BYTES * LOCAL_NOTIFY_AUDIT_MAX_FILES);
  const records = await audit.readTail(3);
  assert.deepEqual(records.map((record) => record.requestId), ['nreq_697', 'nreq_698', 'nreq_699']);

  const relayStatus = await createNotifyAuditLog({
    dir: await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-relay-audit-')),
    scope: 'relay',
  }).status();
  assert.equal(relayStatus.maxFileBytes, 2 * 1024 * 1024);
  assert.equal(relayStatus.maxFiles, 30);
});

test('Notify audit retention prunes by age and per-day shard count', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-audit-retention-'));
  const dir = path.join(root, 'audit');
  await mkdir(dir, { recursive: true });
  for (const name of [
    'notify-audit-2026-08-01.jsonl',
    'notify-audit-2026-08-07.jsonl',
    'notify-audit-2026-08-07-001.jsonl',
    'notify-audit-2026-08-07-002.jsonl',
  ]) await writeFile(path.join(dir, name), '{}\n');
  const audit = createNotifyAuditLog({
    dir,
    now: () => '2026-08-07T12:00:00.000Z',
    maxDays: 2,
    maxFilesPerDay: 2,
    maxFiles: 10,
  });
  await audit.append({ event: 'retention.check' });
  const names = await readdir(dir);
  assert.equal(names.includes('notify-audit-2026-08-01.jsonl'), false);
  assert.equal(names.includes('notify-audit-2026-08-07.jsonl'), false);
  assert.deepEqual(names.sort(), ['notify-audit-2026-08-07-001.jsonl', 'notify-audit-2026-08-07-002.jsonl']);
});

test('Notify HTTP routes emit sanitized correlation metadata without request content', async () => {
  const state = { connection: { workspaceId: 'ws_1' }, cloud: { workspaces: [{ id: 'ws_1' }] }, notifyRecords: [] };
  const events = [];
  const deps = routeDeps(state, { audit: async (event) => { events.push(event); } });
  const response = await callRoute(deps, 'POST', '/api/notify/daemon/auth/start', {
    headers: { 'user-agent': 'notify-test' },
    body: { relayName: 'Monkey', machineFingerprint: `mfp_${'a'.repeat(64)}`, secret: 'must-not-be-logged' },
  });
  assert.equal(response.res.status, 201);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'relay.api.daemon_auth_started');
  assert.equal(events[0].metadata.statusCode, 201);
  assert.equal(events[0].networkAddress, '127.0.0.1');
  assert.doesNotMatch(JSON.stringify(events[0]), /must-not-be-logged|machineFingerprint|mfp_/);
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
  const desktopConfigPath = path.join(root, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  await mkdir(path.dirname(desktopConfigPath), { recursive: true });
  const originalDesktopConfig = `${JSON.stringify({ mcpServers: { existing: { command: 'existing-mcp' } }, theme: 'dark' }, null, 2)}\n`;
  await writeFile(desktopConfigPath, originalDesktopConfig);
  const installed = await installNotifyIntegrations({ targets: 'codex,claude-code,openclaw,hermes,claude-desktop' }, {
    homeDir: root,
    platform: 'darwin',
    env: {},
  });
  assert.deepEqual(installed.map((item) => item.kind), ['codex', 'claude-code', 'openclaw', 'hermes', 'claude-desktop']);
  const codexMetadata = await readFile(path.join(root, '.codex', 'skills', 'magclaw-notify', 'agents', 'openai.yaml'), 'utf8');
  assert.match(codexMetadata, /allow_implicit_invocation: false/);
  const claudeSkill = await readFile(path.join(root, '.claude', 'skills', 'magclaw-notify', 'SKILL.md'), 'utf8');
  assert.match(claudeSkill, /disable-model-invocation: true/);
  const openclawSkill = await readFile(path.join(root, '.openclaw', 'skills', 'magclaw-notify', 'SKILL.md'), 'utf8');
  const hermesSkill = await readFile(path.join(root, '.hermes', 'skills', 'magclaw-notify', 'SKILL.md'), 'utf8');
  assert.match(openclawSkill, /disable-model-invocation: true/);
  assert.match(hermesSkill, /disable-model-invocation: true/);
  const desktop = JSON.parse(await readFile(desktopConfigPath, 'utf8'));
  assert.equal(desktop.theme, 'dark');
  assert.equal(desktop.mcpServers.existing.command, 'existing-mcp');
  assert.equal(desktop.mcpServers['magclaw-notify'].command, 'npx');
  assert.deepEqual(desktop.mcpServers['magclaw-notify'].args.slice(-2), ['@magclaw/notify@latest', 'mcp']);
  assert.equal(await readFile(`${desktopConfigPath}.magclaw-notify.bak`, 'utf8'), originalDesktopConfig);

  const invalidRoot = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-hosts-invalid-'));
  const invalidConfigPath = path.join(invalidRoot, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  await mkdir(path.dirname(invalidConfigPath), { recursive: true });
  await writeFile(invalidConfigPath, '{ "mcpServers": { trailing: true, }, }\n');
  await assert.rejects(
    installNotifyIntegrations({ targets: 'claude-desktop' }, { homeDir: invalidRoot, platform: 'darwin', env: {} }),
    /not valid JSON; no changes were made/i,
  );
  assert.equal(await readFile(invalidConfigPath, 'utf8'), '{ "mcpServers": { trailing: true, }, }\n');
  await assert.rejects(readFile(`${invalidConfigPath}.magclaw-notify.bak`, 'utf8'), /ENOENT/);

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

test('Public Notify package contains sender capabilities only and public docs omit owner runtime details', async () => {
  const packed = spawnSync('npm', ['pack', '--dry-run', '--json', './notify'], {
    cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, NPM_CONFIG_CACHE: path.join(os.tmpdir(), 'magclaw-notify-pack-test-cache'), NPM_CONFIG_UPDATE_NOTIFIER: 'false' },
  });
  assert.equal(packed.status, 0, packed.stderr);
  const files = JSON.parse(packed.stdout)[0].files.map((item) => item.path).sort();
  assert.ok(files.includes('src/cli.js'));
  assert.ok(files.includes('src/mcp.js'));
  assert.ok(files.includes('skills/magclaw-notify/SKILL.md'));
  assert.equal(files.some((file) => /(?:daemon|handler|service|executable|instance)\.js$/.test(file)), false);
  assert.equal(files.some((file) => file.includes('magclaw-notify-handler')), false);
  const publicDocs = `${await readFile(path.join(process.cwd(), 'notify', 'README.md'), 'utf8')}\n${await readFile(path.join(process.cwd(), 'notify', 'RELEASE_NOTES.md'), 'utf8')}`;
  for (const forbidden of ['MAGCLAW_NOTIFY_AUDIT_HASH_KEY', 'cloud_audit_logs', '.notify-audit-hash-key', '测试monkey', '蒋海波']) {
    assert.doesNotMatch(publicDocs, new RegExp(forbidden));
  }
});

test('Notify MCP preview is non-sending and send tool requires explicit current-turn authorization', async () => {
  const auditHome = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-mcp-audit-'));
  const input = {
    group: '测试',
    summary: {
      headline: '完成 MCP 工具接入',
      taskTypes: ['feature'],
      sections: [{ type: 'feature', title: '新增能力', items: [{ status: 'done', text: '支持 Claude Desktop' }] }],
    },
  };
  const preview = await handleNotifyMcpTool('magclaw_notify_preview', input, { env: { MAGCLAW_NOTIFY_HOME: auditHome } });
  const previewBody = JSON.parse(preview.content[0].text);
  assert.equal(previewBody.sent, false);
  assert.match(previewBody.next, /explicitly confirm/);
  const rejected = await handleNotifyMcpTool('magclaw_notify_send', { ...input, userAuthorizedCurrentTurn: false }, { env: { MAGCLAW_NOTIFY_HOME: auditHome } });
  assert.equal(rejected.isError, true);
  assert.match(rejected.content[0].text, /explicit user authorization/i);
  const auditRecords = await createNotifyAuditLog({ dir: notifyProjectPaths({ env: { MAGCLAW_NOTIFY_HOME: auditHome } }).auditDir }).readTail(10);
  assert.deepEqual(auditRecords.map((record) => record.outcome), ['started', 'previewed', 'started', 'failed']);
  assert.doesNotMatch(JSON.stringify(auditRecords), /支持 Claude Desktop/);
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
      eventConsumer: 'standalone',
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

test('Notify approval listener stays off by default when OpenClaw owns Monkey events', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-openclaw-events-'));
  await mkdir(path.join(root, 'notify'), { recursive: true });
  await writeFile(path.join(root, 'notify', 'config.json'), `${JSON.stringify({
    confirmationProvider: {
      kind: 'lark-cli-feishu',
      command: '/definitely/not/executed',
      account: 'monkey',
      ownerOpenId: 'ou_owner',
      enabled: true,
    },
  })}\n`);
  const controller = new AbortController();
  const listener = await startNotifyApprovalListener({ handler: { dir: root } }, controller.signal);
  assert.equal(listener.running, false);
});

test('Notify approval status reports plugin mode and refuses to manage an exec allowlist', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-approval-agent-'));
  const instance = 'approval-agent-test';
  const paths = notifyDaemonPaths({ MAGCLAW_NOTIFY_HOME: root }, instance);
  const fakeOpenClaw = path.join(root, 'fake-openclaw');
  await writeFile(fakeOpenClaw, [
    '#!/usr/bin/env node',
    'const args = process.argv.slice(2);',
    "if (args[0] === 'plugins') process.stdout.write(JSON.stringify({ plugins: [{ id: 'magclaw-notify', enabled: true }] }));",
    "else if (args[0] === 'approvals') process.stdout.write(JSON.stringify({ file: { agents: { 'monkey-owner': { allowlist: [{ pattern: '/Users/x/.local/share/magclaw-notify/approval-handlers/default' }] } } } }));",
    "else process.stdout.write('{}');",
    '',
  ].join('\n'));
  await chmod(fakeOpenClaw, 0o700);
  await configureNotifyHandler(paths.handler, {
    agentProvider: { command: fakeOpenClaw, agentId: 'monkey-member' },
    confirmationProvider: { account: 'monkey', ownerOpenId: 'ou_owner', approvalAgentId: 'monkey-owner', eventConsumer: 'openclaw' },
  });
  const status = await runNotifyOwnerCommand(['openclaw-approval', 'status'], { instance, notifyHome: root });
  assert.equal(status.mode, 'plugin');
  assert.equal(status.pluginLoaded, true);
  assert.equal(status.agentShellApprovalRequired, false);
  assert.match(status.pluginPath, /\.openclaw\/plugins\/magclaw-notify$/);
  // A leftover exec allowlist entry from the old shell handler must be surfaced.
  assert.equal(status.staleAllowlistEntries.length, 1);
  assert.equal(status.staleAllowlistEntries[0].agentId, 'monkey-owner');
  await assert.rejects(
    runNotifyOwnerCommand(['openclaw-approval', 'enable'], { instance, notifyHome: root }),
    /handled by the OpenClaw plugin/i,
  );
});

test('Notify handler Skill installs no Agent-invocable approval command', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-openclaw-handler-'));
  const legacyHandler = path.join(root, '.local', 'share', 'magclaw-notify', 'approval-handlers', 'product-a');
  await mkdir(path.dirname(legacyHandler), { recursive: true });
  await writeFile(legacyHandler, '#!/bin/sh\nexit 0\n');
  const installed = await installNotifyHandlerSkill({ targets: ['openclaw'], homeDir: root });
  assert.equal(installed.length, 1);
  assert.equal(installed[0].approvalHandler, undefined);
  // Installing must also clean up any handler left by an earlier version.
  await assert.rejects(stat(legacyHandler), /ENOENT/);
  const skill = await readFile(path.join(root, '.openclaw', 'skills', 'magclaw-notify-handler', 'SKILL.md'), 'utf8');
  const sourceSkill = await readFile(path.join(process.cwd(), 'notify-owner', 'skills', 'magclaw-notify-handler', 'SKILL.md'), 'utf8');
  for (const text of [skill, sourceSkill]) {
    assert.doesNotMatch(text, /approval-handlers/);
    assert.doesNotMatch(text, /NOTIFY_APPROVAL_HANDLER/);
    assert.doesNotMatch(text, /setup-token rotate/);
    // The Skill must tell the Agent approvals are not its job.
    assert.match(text, /Do not approve, confirm, or reject any Notify request by any means\./);
  }
});

test('Notify instances isolate local state and generate platform autostart services', () => {
  const root = path.join(os.tmpdir(), 'magclaw-notify-instance-test');
  assert.equal(normalizeNotifyInstance(' Product A '), 'product-a');
  assert.equal(notifyDaemonPaths({ MAGCLAW_NOTIFY_HOME: root }, 'default').root, path.join(root, 'daemon'));
  assert.equal(notifyDaemonPaths({ MAGCLAW_NOTIFY_HOME: root }, 'product-a').root, path.join(root, 'daemons', 'product-a'));

  const common = {
    instance: 'product-a',
    homeDir: '/home/owner',
    nodePath: '/opt/node/bin/node',
    binPath: '/opt/magclaw/notify.js',
    notifyHome: '/home/owner/.magclaw/notify-product-a',
    logPath: '/home/owner/notify.log',
    errorLogPath: '/home/owner/notify.error.log',
  };
  const mac = notifyDaemonServiceSpec({ ...common, platform: 'darwin' });
  assert.match(mac.file, /io\.magclaw\.notify\.product-a\.plist$/);
  assert.match(mac.content, /<string>product-a<\/string>/);
  assert.match(mac.content, /<string>--notify-home<\/string>/);
  assert.match(mac.content, /<string>\/home\/owner\/\.magclaw\/notify-product-a<\/string>/);
  assert.match(mac.content, /<key>RunAtLoad<\/key>/);
  assert.match(mac.content, /<key>ThrottleInterval<\/key>\s*<integer>3<\/integer>/);
  assert.match(mac.content, /<key>EnvironmentVariables<\/key>/);
  assert.match(mac.content, /\/opt\/node\/bin/);
  const linux = notifyDaemonServiceSpec({ ...common, platform: 'linux', xdgConfigHome: '/home/owner/.config' });
  assert.match(linux.file, /magclaw-notify-product-a\.service$/);
  assert.match(linux.content, /Restart=always/);
  assert.match(linux.content, /Environment="PATH=.*\/opt\/node\/bin/);
  const windows = notifyDaemonServiceSpec({ ...common, platform: 'win32' });
  assert.equal(windows.enable[0], 'schtasks.exe');
  assert.match(windows.enable[1].join(' '), /ONLOGON/);
  assert.equal(stableNotifyNodePath({ platform: 'darwin', pathExists: (candidate) => candidate === '/opt/homebrew/bin/node' }), '/opt/homebrew/bin/node');
});

test('Notify daemon runtime logs are preserved with owner-only permissions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-runtime-logs-'));
  const paths = notifyDaemonPaths({ MAGCLAW_NOTIFY_HOME: root }, 'secure-logs');
  await mkdir(path.dirname(paths.stdout), { recursive: true, mode: 0o755 });
  await writeFile(paths.stdout, 'existing output\n', { mode: 0o644 });
  await writeFile(paths.stderr, 'existing error\n', { mode: 0o644 });
  await ensureNotifyRuntimeLogs(paths);
  assert.equal((await stat(path.dirname(paths.stdout))).mode & 0o777, 0o700);
  assert.equal((await stat(paths.stdout)).mode & 0o777, 0o600);
  assert.equal((await stat(paths.stderr)).mode & 0o777, 0o600);
  assert.equal(await readFile(paths.stdout, 'utf8'), 'existing output\n');
  assert.equal(await readFile(paths.stderr, 'utf8'), 'existing error\n');
});

test('Notify background services resolve Homebrew and user-local CLIs with a minimal PATH', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-executable-'));
  const localBin = path.join(root, '.local', 'bin');
  const fakeCli = path.join(localBin, 'lark-cli');
  await mkdir(localBin, { recursive: true });
  await writeFile(fakeCli, '#!/bin/sh\nexit 0\n');
  await chmod(fakeCli, 0o755);
  const env = { PATH: '/usr/bin:/bin' };
  assert.equal(resolveNotifyExecutable('lark-cli', { platform: 'linux', homeDir: root, nodePath: '/opt/node/bin/node', env }), fakeCli);
  const servicePath = notifyExecutableSearchPath({ platform: 'darwin', homeDir: root, nodePath: '/opt/homebrew/bin/node', env });
  assert.ok(servicePath.split(path.delimiter).includes('/opt/homebrew/bin'));
  assert.ok(servicePath.split(path.delimiter).includes(localBin));
  assert.equal(servicePath.includes('node_modules/.bin'), false);
});

test('Notify autostart enable and disable manage only the selected instance service', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-service-'));
  const spec = notifyDaemonServiceSpec({
    instance: 'product-a',
    platform: 'linux',
    homeDir: root,
    xdgConfigHome: path.join(root, '.config'),
    nodePath: '/opt/node/bin/node',
    binPath: '/opt/magclaw/notify.js',
    logPath: path.join(root, 'notify.log'),
    errorLogPath: path.join(root, 'notify.error.log'),
  });
  const calls = [];
  const dependencies = { runCommand: async (...args) => { calls.push(args); } };
  await enableNotifyDaemonAutostart(spec, dependencies);
  assert.equal((await stat(spec.file)).mode & 0o777, 0o600);
  assert.equal((await notifyDaemonAutostartStatus(spec)).enabled, true);
  assert.deepEqual(calls.map(([command, args]) => [command, args.slice(0, 2)]), [
    ['systemctl', ['--user', 'daemon-reload']],
    ['systemctl', ['--user', 'enable']],
  ]);
  await disableNotifyDaemonAutostart(spec, dependencies);
  assert.equal((await notifyDaemonAutostartStatus(spec)).enabled, false);
});

test('Notify approval cards preserve complete request context across pending, processing, and sent states', () => {
  const confirmation = {
    id: 'ncf_card_detail',
    requestIds: ['nreq_card_detail'],
    details: { instance: 'product-a', userName: '蒋海波', groupName: '测试monkey', requestedGroup: '测试' },
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
  assert.match(pending, /"bot":"product-a"/);

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

test('Any Feishu-authenticated member can start their own Notify Daemon login by default', async () => {
  const fingerprint = `mfp_${'a'.repeat(64)}`;
  const state = { connection: { workspaceId: 'ws_1' }, cloud: { workspaces: [{ id: 'ws_1' }] }, notifyRecords: [] };
  let currentUser = null;
  const newcomer = feishuUser('usr_newcomer', 'Newcomer', 'tenant_other');
  // No bootstrap secret: this Relay is open, so owning a Daemon is self-service.
  const deps = routeDeps(state, {
    currentUser: () => currentUser,
    currentActor: () => (currentUser ? { user: currentUser, member: { workspaceId: 'ws_1', role: 'member' } } : null),
  });
  const started = await callRoute(deps, 'POST', '/api/notify/daemon/auth/start', {
    body: { relayName: 'Newcomer Bot', machineFingerprint: fingerprint, client: { hostname: 'new-mac', platform: 'linux', arch: 'x64' } },
  });
  assert.equal(started.res.status, 201);

  // Starting a login grants nothing until it is confirmed in the browser.
  const beforeConfirm = await callRoute(deps, 'POST', '/api/notify/daemon/auth/token', {
    body: { deviceCode: started.res.body.deviceCode, machineFingerprint: fingerprint },
  });
  assert.equal(beforeConfirm.res.body.status, 'pending');

  // An anonymous visitor cannot confirm it.
  const anonymous = await callRoute(deps, 'GET', started.res.body.verificationUri);
  assert.equal(anonymous.res.status, 302);

  currentUser = newcomer;
  const reviewed = await callRoute(deps, 'GET', started.res.body.verificationUri);
  assert.equal(reviewed.res.status, 200);
  const csrfToken = reviewed.res.raw.match(/name="csrf_token" value="([^"]+)"/)[1];
  const confirmed = await callRoute(deps, 'POST', '/notify/daemon/auth/approve', {
    body: { user_code: started.res.body.userCode, csrf_token: csrfToken },
  });
  assert.equal(confirmed.res.status, 200);
  const approved = await callRoute(deps, 'POST', '/api/notify/daemon/auth/token', {
    body: { deviceCode: started.res.body.deviceCode, machineFingerprint: fingerprint },
  });
  assert.equal(approved.res.body.status, 'approved');
  // The newcomer owns their own Relay installation and can issue Setup Tokens.
  assert.ok(approved.res.body.relayId);
  assert.ok(approved.res.body.inviteToken);
  assert.equal(approved.res.body.user.id, 'usr_newcomer');
});

test('Notify device authorization is owner-started, POST-confirmed, CSRF-protected, and one-time', async () => {
  const fingerprint = `mfp_${'f'.repeat(64)}`;
  const state = { connection: { workspaceId: 'ws_1' }, cloud: { workspaces: [{ id: 'ws_1' }] }, notifyRecords: [] };
  let currentUser = null;
  const owner = feishuUser('usr_owner', 'Owner', 'tenant_owner');
  const deps = routeDeps(state, {
    currentUser: () => currentUser,
    currentActor: () => currentUser ? { user: currentUser, member: { workspaceId: 'ws_1', role: 'owner' } } : null,
    notifyDaemonBootstrapSecret: 'bootstrap-test-secret',
  });
  const denied = await callRoute(deps, 'POST', '/api/notify/daemon/auth/start', {
    body: { relayName: 'Monkey', machineFingerprint: fingerprint },
  });
  assert.equal(denied.res.status, 401);
  const started = await callRoute(deps, 'POST', '/api/notify/daemon/auth/start', {
    headers: { 'x-magclaw-notify-bootstrap': 'bootstrap-test-secret' },
    body: { relayName: 'Monkey', machineFingerprint: fingerprint, client: { hostname: 'owner-mac', platform: 'darwin', arch: 'arm64' } },
  });
  assert.equal(started.res.status, 201);
  assert.match(started.res.body.userCode, /^[A-F0-9]{5}-[A-F0-9]{5}$/);

  currentUser = owner;
  const reviewed = await callRoute(deps, 'GET', started.res.body.verificationUri);
  assert.equal(reviewed.res.status, 200);
  assert.doesNotMatch(reviewed.res.raw, /owner-mac|darwin|arm64|aaaaaaaa/);
  assert.match(reviewed.res.raw, /不会把主机名、系统、文件路径或设备指纹发送给 Owner/);
  assert.equal(notifyRecords(state).some((record) => record.type === 'installation'), false);
  const pending = await callRoute(deps, 'POST', '/api/notify/daemon/auth/token', {
    body: { deviceCode: started.res.body.deviceCode, machineFingerprint: fingerprint },
  });
  assert.equal(pending.res.body.status, 'pending');
  const userCode = reviewed.res.raw.match(/name="user_code" value="([^"]+)"/)?.[1];
  const csrfToken = reviewed.res.raw.match(/name="csrf_token" value="([^"]+)"/)?.[1];
  const rejected = await callRoute(deps, 'POST', '/notify/daemon/auth/approve', {
    body: { user_code: userCode, csrf_token: 'wrong-token' },
  });
  assert.equal(rejected.res.status, 403);
  const approved = await callRoute(deps, 'POST', '/notify/daemon/auth/approve', {
    body: { user_code: userCode, csrf_token: csrfToken },
  });
  assert.equal(approved.res.status, 200);
  assert.match(approved.res.raw, /目标 Bot/);
  const replay = await callRoute(deps, 'POST', '/notify/daemon/auth/approve', {
    body: { user_code: userCode, csrf_token: csrfToken },
  });
  assert.equal(replay.res.status, 404);
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

  await approveNotifyDevice(deps, started.res.body.verificationUri);
  const installation = notifyRecords(state).find((record) => record.type === 'installation');
  assert.match(installation.handle, /^magclaw-[a-f0-9]{7}$/);
  assert.equal(installation.machineFingerprint, fingerprint);
  assert.equal(installation.computerId, undefined);

  const repeatedStart = await callRoute(deps, 'POST', '/api/notify/daemon/auth/start', {
    body: { machineFingerprint: fingerprint },
  });
  await approveNotifyDevice(deps, repeatedStart.res.body.verificationUri);
  assert.equal(notifyRecords(state).filter((record) => record.type === 'installation').length, 1);

  const renamedStart = await callRoute(deps, 'POST', '/api/notify/daemon/auth/start', {
    body: { relayName: 'Monkey', machineFingerprint: fingerprint },
  });
  await approveNotifyDevice(deps, renamedStart.res.body.verificationUri);
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

test('One owner and machine can create isolated Notify instances for different projects', async () => {
  const fingerprint = `mfp_${'d'.repeat(64)}`;
  const state = {
    connection: { workspaceId: 'ws_1' },
    cloud: { workspaces: [{ id: 'ws_1' }] },
    notifyRecords: [],
  };
  const deps = routeDeps(state);
  const invalid = await callRoute(deps, 'POST', '/api/notify/daemon/auth/start', {
    body: { instance: '***', relayName: 'Monkey', machineFingerprint: fingerprint },
  });
  assert.equal(invalid.res.status, 400);
  const loginInstance = async (instance) => {
    const started = await callRoute(deps, 'POST', '/api/notify/daemon/auth/start', {
      body: { instance, relayName: 'Monkey', machineFingerprint: fingerprint },
    });
    await approveNotifyDevice(deps, started.res.body.verificationUri);
    return callRoute(deps, 'POST', '/api/notify/daemon/auth/token', {
      body: { deviceCode: started.res.body.deviceCode, machineFingerprint: fingerprint },
    });
  };
  const product = await loginInstance('product-a');
  const operations = await loginInstance('operations');
  assert.notEqual(product.res.body.relayId, operations.res.body.relayId);
  assert.notEqual(product.res.body.relayHandle, operations.res.body.relayHandle);
  assert.notEqual(product.res.body.inviteToken, operations.res.body.inviteToken);
  assert.deepEqual(
    notifyRecords(state).filter((record) => record.type === 'installation').map((record) => record.instance).sort(),
    ['operations', 'product-a'],
  );
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
  const clock = Date.now();
  const deps = routeDeps(state, {
    now: () => new Date(clock).toISOString(),
    currentUser: () => currentUser,
    currentActor: () => ({ user: currentUser, member: { workspaceId: 'ws_1', humanId: 'hum_owner', role: 'owner' } }),
  });
  const daemonStart = await callRoute(deps, 'POST', '/api/notify/daemon/auth/start', {
    body: { relayName: 'Monkey', machineFingerprint: daemonFingerprint },
  });
  await approveNotifyDevice(deps, daemonStart.res.body.verificationUri);
  const daemonAuth = await callRoute(deps, 'POST', '/api/notify/daemon/auth/token', {
    body: { deviceCode: daemonStart.res.body.deviceCode, machineFingerprint: daemonFingerprint },
  });
  const daemonTokenRecord = notifyRecords(state).find((record) => record.type === 'auth_token' && record.authMode === 'daemon');
  assert.equal(Date.parse(daemonTokenRecord.expiresAt) - Date.parse(daemonTokenRecord.createdAt), NOTIFY_TOKEN_TTL_MS);

  currentUser = feishuUser('usr_outside', 'Outside', 'tenant_outside');
  const denied = await callRoute(deps, 'POST', '/api/notify/auth/start', {
    body: { inviteToken: daemonAuth.res.body.inviteToken, machineFingerprint: `mfp_${'2'.repeat(64)}` },
  });
  assert.equal(denied.res.status, 403);
  assert.match(denied.res.body.error, /owner's Feishu tenant/i);

  currentUser = feishuUser('usr_sender', 'Sender', 'tenant_owner');
  const before = clock;
  const clientStart = await callRoute(deps, 'POST', '/api/notify/auth/start', {
    body: { inviteToken: daemonAuth.res.body.inviteToken, machineFingerprint: `mfp_${'3'.repeat(64)}` },
  });
  assert.equal(Date.parse(clientStart.res.body.expiresAt) - clock, NOTIFY_DEVICE_TTL_MS);
  await approveNotifyDevice(deps, clientStart.res.body.verificationUri);
  const clientAuth = await callRoute(deps, 'POST', '/api/notify/auth/token', {
    body: { deviceCode: clientStart.res.body.deviceCode, machineFingerprint: `mfp_${'3'.repeat(64)}` },
  });
  const lifetime = Date.parse(clientAuth.res.body.tokenExpiresAt) - before;
  assert.equal(lifetime, NOTIFY_TOKEN_TTL_MS);
});

test('Notify device authorization expiration follows the injected 10-minute clock', async () => {
  assert.equal(NOTIFY_DEVICE_TTL_MS, 10 * 60 * 1000);
  let clock = Date.parse('2026-08-07T02:00:00.000Z');
  const state = { connection: { workspaceId: 'ws_1' }, cloud: { workspaces: [{ id: 'ws_1' }] }, notifyRecords: [] };
  const deps = routeDeps(state, { now: () => new Date(clock).toISOString() });
  const started = await callRoute(deps, 'POST', '/api/notify/daemon/auth/start', {
    body: { relayName: 'Clock', machineFingerprint: `mfp_${'c'.repeat(64)}` },
  });
  assert.equal(Date.parse(started.res.body.expiresAt) - clock, NOTIFY_DEVICE_TTL_MS);
  clock += NOTIFY_DEVICE_TTL_MS + 1;
  const expired = await callRoute(deps, 'POST', '/api/notify/daemon/auth/token', {
    body: { deviceCode: started.res.body.deviceCode, machineFingerprint: `mfp_${'c'.repeat(64)}` },
  });
  assert.equal(expired.res.body.status, 'expired');
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
  await approveNotifyDevice(deps, daemonStart.res.body.verificationUri);
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
        connectionId: hostname,
        machineFingerprint: fingerprint,
        client: { hostname, platform: 'darwin', arch: 'arm64' },
      },
    });
    await approveNotifyDevice(deps, started.res.body.verificationUri);
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
  assert.deepEqual(listed.res.body.access.map((record) => record.connectionId).sort(), ['sender-one', 'sender-two']);
  assert.equal(listed.res.body.access.some((record) => 'device' in record), false);
  assert.equal(listed.res.body.access[0].user.identity.openId, 'ou_usr_sender');
  assert.equal(JSON.stringify(listed.res.body).includes('raw_feishu_access_token_must_not_be_copied'), false);

  const clientCannotManage = await callRoute(deps, 'GET', '/api/notify/daemon/access', { headers: firstHeaders });
  assert.equal(clientCannotManage.res.status, 401);

  const firstAccess = listed.res.body.access.find((record) => record.connectionId === 'sender-one');
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

  const disabled = await callRoute(deps, 'POST', '/api/notify/daemon/setup-token/disable', {
    headers: daemonHeaders,
    body: { revokeExisting: false },
  });
  assert.equal(disabled.res.status, 200);
  assert.equal(disabled.res.body.setupTokenEnabled, false);
  const disabledTokenDenied = await callRoute(deps, 'POST', '/api/notify/auth/start', {
    body: { inviteToken: rotated.res.body.setupToken, machineFingerprint: `mfp_${'e'.repeat(64)}` },
  });
  assert.equal(disabledTokenDenied.res.status, 404);
  const reEnabled = await callRoute(deps, 'POST', '/api/notify/daemon/setup-token/rotate', {
    headers: daemonHeaders,
    body: {},
  });
  const reEnabledAccepted = await callRoute(deps, 'POST', '/api/notify/auth/start', {
    body: { inviteToken: reEnabled.res.body.setupToken, machineFingerprint: `mfp_${'f'.repeat(64)}` },
  });
  assert.equal(reEnabledAccepted.res.status, 201);

  const audit = await callRoute(deps, 'GET', '/api/notify/daemon/access?include_revoked=1', { headers: daemonHeaders });
  assert.equal(audit.res.body.counts.revoked, 2);
  assert.equal(audit.res.body.access.every((record) => record.status === 'revoked'), true);
});

test('Notify owner access kick reports cloud login and local group grant revocation separately', async () => {
  const daemonToken = 'mcn_daemon_owner_kick';
  const state = {
    connection: { workspaceId: 'ws_1' },
    cloud: { workspaces: [{ id: 'ws_1' }] },
    notifyRecords: [
      { id: 'nrl_kick', type: 'installation', workspaceId: 'ws_1', ownerUserId: 'usr_owner', handle: 'monkey-kick', enabled: true },
      {
        id: 'nat_owner', type: 'auth_token', authMode: 'daemon', workspaceId: 'ws_1', relayId: 'nrl_kick',
        tokenHash: hashNotifySecret(daemonToken), scopes: ['notify:daemon'], user: { id: 'usr_owner', name: 'Owner' },
      },
      { id: 'nat_sender_1', type: 'auth_token', authMode: 'client', workspaceId: 'ws_1', relayId: 'nrl_kick', user: { id: 'usr_sender' } },
      { id: 'nat_sender_2', type: 'auth_token', authMode: 'client', workspaceId: 'ws_1', relayId: 'nrl_kick', user: { id: 'usr_sender' }, revokedAt: '2026-08-01T00:00:00.000Z' },
      { id: 'nat_other', type: 'auth_token', authMode: 'client', workspaceId: 'ws_1', relayId: 'nrl_kick', user: { id: 'usr_other' } },
    ],
  };
  const relayCalls = [];
  const deps = routeDeps(state, {
    notifyRelay: {
      revokeNotifyGrants: async (relayId, userId) => {
        relayCalls.push({ relayId, userId });
        return { available: true, revoked: 3 };
      },
    },
  });
  const kicked = await callRoute(deps, 'POST', '/api/notify/daemon/access/kick', {
    headers: { authorization: `Bearer ${daemonToken}` },
    body: { userId: 'usr_sender' },
  });
  assert.equal(kicked.res.status, 200);
  assert.deepEqual(kicked.res.body, {
    ok: true,
    userId: 'usr_sender',
    cloudLoginsRevoked: 1,
    localGroupGrantsRevoked: 3,
    localDaemonAvailable: true,
  });
  assert.deepEqual(relayCalls, [{ relayId: 'nrl_kick', userId: 'usr_sender' }]);
  assert.ok(state.notifyRecords.find((record) => record.id === 'nat_sender_1').revokedAt);
  assert.equal(state.notifyRecords.find((record) => record.id === 'nat_other').revokedAt, undefined);
});

test('Notify daemon access kick CLI preserves explicit cloud and local revoke counts', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-kick-cli-'));
  const instance = 'kick-cli';
  const paths = notifyDaemonPaths({ MAGCLAW_NOTIFY_HOME: root }, instance);
  await mkdir(path.dirname(paths.config), { recursive: true });
  await writeFile(paths.config, `${JSON.stringify({
    relayUrl: 'http://127.0.0.1:7443', relayId: 'nrl_kick', token: 'owner-token', machineFingerprint: 'mfp_test',
  })}\n`, { mode: 0o600 });
  const originalFetch = globalThis.fetch;
  let request = null;
  globalThis.fetch = async (url, options) => {
    request = { url: String(url), body: JSON.parse(options.body) };
    return new Response(JSON.stringify({
      ok: true, cloudLoginsRevoked: 2, localGroupGrantsRevoked: 4, localDaemonAvailable: true,
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const result = await runNotifyOwnerCommand(['access', 'kick'], { instance, notifyHome: root, userId: 'usr_sender' });
    assert.deepEqual(result, {
      ok: true, userId: 'usr_sender', cloudLoginsRevoked: 2, localGroupGrantsRevoked: 4, localDaemonAvailable: true,
    });
    assert.equal(new URL(request.url).pathname, '/api/notify/daemon/access/kick');
    assert.deepEqual(request.body, { userId: 'usr_sender' });
  } finally {
    globalThis.fetch = originalFetch;
  }
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
  await approveNotifyDevice(deps, daemonStart.res.body.verificationUri);
  const daemonAuth = await callRoute(deps, 'POST', '/api/notify/daemon/auth/token', {
    body: { deviceCode: daemonStart.res.body.deviceCode, machineFingerprint: daemonFingerprint },
  });
  const installation = notifyRecords(state).find((record) => record.type === 'installation');

  const clientStart = await callRoute(deps, 'POST', '/api/notify/auth/start', {
    body: { inviteToken: daemonAuth.res.body.inviteToken, machineFingerprint: clientFingerprint },
  });
  await approveNotifyDevice(deps, clientStart.res.body.verificationUri);
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
  const directory = await readNotifyState(profilePaths, 'directory');

  assert.equal(resolveNotifyGroup(directory, '技术研发群').group.id, group.id);
  assert.equal(resolveNotifyGroup(directory, '研发群').status, 'confirmation_required');
  assert.equal(resolveNotifyGroup(directory, '运营群').status, 'unavailable');
  assert.equal(resolveNotifyPeople(directory, ['Zhang San'], group)[0].person.id, person.id);
  const proposed = resolveNotifyPeople(directory, ['张总'], group)[0];
  assert.equal(proposed.status, 'confirmation_required');
  assert.equal(proposed.candidates[0].person.id, person.id);
});

test('Notify managed directory supports direct file edits, alias management, apply, and removal', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-managed-directory-'));
  const profilePaths = { dir: root, profile: 'managed-directory' };
  await addNotifyGroup(profilePaths, { name: '某某研发部门', chatId: 'oc_research', aliases: ['研发部'] });
  await addNotifyPerson(profilePaths, { name: '张三', openId: 'ou_zhangsan', groupChatIds: ['oc_research'] });
  const listed = await listNotifyDirectory(profilePaths);
  const snapshot = JSON.parse(await readFile(listed.file, 'utf8'));
  snapshot.groups[0].aliases.push('研发群');
  await writeFile(listed.file, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
  const reloaded = await listNotifyDirectory(profilePaths);
  assert.equal(resolveNotifyGroup(reloaded.directory, '研发群').status, 'resolved');
  await updateNotifyDirectoryAlias(profilePaths, { action: 'add', kind: 'person', name: '张三', alias: '三哥' });
  assert.equal(resolveNotifyPeople((await listNotifyDirectory(profilePaths)).directory, ['三哥'])[0].status, 'resolved');
  await updateNotifyDirectoryAlias(profilePaths, { action: 'remove', kind: 'person', name: '张三', alias: '三哥' });
  assert.equal(resolveNotifyPeople((await listNotifyDirectory(profilePaths)).directory, ['三哥'])[0].status, 'unavailable');
  const imported = { ...snapshot, groups: [{ ...snapshot.groups[0], aliases: ['技术群'] }], people: snapshot.people };
  const importFile = path.join(root, 'directory-import.json');
  await writeFile(importFile, JSON.stringify(imported));
  await writeFile(listed.file, '{broken-json');
  assert.equal((await applyNotifyDirectory(profilePaths, { file: importFile })).groups, 1);
  assert.equal(resolveNotifyGroup((await listNotifyDirectory(profilePaths)).directory, '技术群').status, 'resolved');
  assert.equal((await removeNotifyDirectoryEntry(profilePaths, { kind: 'group', name: '某某研发部门' })).removed, 1);
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

test('Notify provider idempotency includes requestId so identical summaries remain distinct', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-provider-idempotency-'));
  const profilePaths = { dir: root, profile: 'provider-idempotency' };
  const argsLog = path.join(root, 'lark-args.jsonl');
  const fakeLark = path.join(root, 'fake-lark');
  await writeFile(fakeLark, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    `fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    "process.stdout.write(JSON.stringify({ data: { message_id: 'om_sent' } }));",
    '',
  ].join('\n'));
  await chmod(fakeLark, 0o700);
  await addNotifyGroup(profilePaths, { name: '研发群', chatId: 'oc_local_only' });
  await configureNotifyHandler(profilePaths, {
    agentProvider: { command: path.join(root, 'missing-agent') },
    deliveryProvider: { kind: 'lark-cli-feishu', command: fakeLark, account: 'monkey', enabled: true },
  });
  const makeRequest = (id) => ({
    id,
    requester: { id: 'usr_sender', name: '李四' },
    payload: {
      target: { group: '研发群' },
      content: { title: '相同结论', markdown: '- 完成同一项修复' },
      mentions: [], context: {},
    },
  });
  for (const id of ['nreq_same_1', 'nreq_same_2']) {
    const awaiting = await handleNotifyDelivery(profilePaths, makeRequest(id));
    const approved = await confirmNotifyMapping(profilePaths, awaiting.confirmationId, 'once');
    assert.equal(approved.result.status, 'sent');
  }
  const calls = (await readFile(argsLog, 'utf8')).trim().split('\n').map(JSON.parse);
  const keys = calls.map((args) => args[args.indexOf('--idempotency-key') + 1]);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  assert.ok(keys.every((key) => /^mcn_[A-Za-z0-9_-]{43}$/.test(key)));
});

test('Notify public summaries redact local machine details and credentials without losing repo-relative evidence', () => {
  const summary = normalizeNotifySummary({
    headline: '修复完成 /Users/alice/code/kizuna/backend，token=raw-secret-value',
    taskTypes: ['bugfix'],
    sections: [{
      type: 'bugfix',
      title: '登录修复',
      items: [{
        text: '修改 backend/auth/login.go，测试地址 192.168.1.7',
        status: 'verified',
        evidence: 'Bearer abcdef /home/alice/private.txt',
      }],
    }],
    links: [{ label: '测试报告', url: 'https://example.com/report?token=secret-value&view=full' }],
    images: [{ url: 'https://example.com/result.png?signature=secret-value', caption: '截图位于 C:\\Users\\alice\\Desktop\\result.png' }],
  }, { required: true });
  const rendered = renderNotifySummaryMarkdown(summary);
  assert.match(rendered, /backend\/auth\/login\.go/);
  assert.match(rendered, /\[kizuna\]\/backend/);
  assert.match(rendered, /\[private-ip\]/);
  assert.match(rendered, /Bearer \[redacted\]/);
  assert.match(summary.links[0].url, /token=%5Bredacted%5D/);
  assert.match(summary.images[0].url, /signature=%5Bredacted%5D/);
  assert.doesNotMatch(rendered, /Users\/alice|home\/alice|raw-secret-value|192\.168\.1\.7/);
  assert.equal(redactNotifyPublicText('secret: abc localhost:8080'), 'secret: [redacted] [local-host]');
});

test('Notify public redaction covers credential, identity, cluster, and phone inputs', () => {
  const cases = [
    ['GitLab token glpat-AbCdEf1234567890', 'GitLab token [redacted-secret]', /glpat-/],
    ['GitHub ghp_abcdefghijklmnopqrstuvwxyz123456', 'GitHub [redacted-secret]', /ghp_/],
    ['OAuth gho_abcdefghijklmnopqrstuvwxyz123456', 'OAuth [redacted-secret]', /gho_/],
    ['service ghs_abcdefghijklmnopqrstuvwxyz123456', 'service [redacted-secret]', /ghs_/],
    ['fine github_pat_11AAabcdefghijklmnopqrstuvwxyz', 'fine [redacted-secret]', /github_pat_/],
    ['jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature123', 'jwt [redacted-jwt]', /eyJ/],
    ['mail operator@example.com', 'mail [redacted-email]', /operator@/],
    ['host relay.prod.ttyuyin.com:443', 'host [private-host]', /ttyuyin/],
    ['dns notify.default.svc.cluster.local', 'dns [cluster-host]', /svc\.cluster/],
    ['pod=notify-owner-7f9d8c6b5-x2k9p namespace: magclaw-test', 'pod=[cluster-resource] namespace: [cluster-resource]', /notify-owner|magclaw-test/],
    ['call 13800138000', 'call [redacted-phone]', /13800138000/],
  ];
  for (const [input, expected, forbidden] of cases) {
    const actual = redactNotifyPublicText(input);
    assert.equal(actual, expected, input);
    assert.doesNotMatch(actual, forbidden, input);
  }
});

test('Notify rich text sanitizer keeps Markdown only and rebuilds safe HTTPS links', () => {
  const actual = sanitizeNotifyMarkdown([
    '<font color="red">完成</font>',
    '<a href="https://example.com/docs?token=raw">https://evil.invalid <b>文档</b></a>',
    '<a href="http://127.0.0.1/private">内网</a>',
    '<at user_id="ou_secret">张三</at>',
    '<script>alert(1)</script>',
    '[https://evil.invalid](https://example.com/safe)',
  ].join('\n'));
  assert.match(actual, /^完成/m);
  assert.match(actual, /\[文档\]\(https:\/\/example\.com\/docs\?token=%5Bredacted%5D\)/);
  assert.match(actual, /^内网$/m);
  assert.match(actual, /\[查看链接\]\(https:\/\/example\.com\/safe\)/);
  assert.doesNotMatch(actual, /<|ou_secret|alert|https:\/\/evil\.invalid|http:\/\/127\.0\.0\.1/);
});

test('Notify mirrors only sanitized delivery context into the shared OpenClaw group session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-context-sync-'));
  const profilePaths = { dir: root, profile: 'context-sync' };
  const openclawLog = path.join(root, 'openclaw-args.jsonl');
  const openclaw = path.join(root, 'fake-openclaw');
  const lark = path.join(root, 'fake-lark');
  await writeFile(openclaw, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    `const log = ${JSON.stringify(openclawLog)};`,
    "const args = process.argv.slice(2);",
    "const fileIndex = args.indexOf('--message-file');",
    "const prompt = fileIndex >= 0 ? fs.readFileSync(args[fileIndex + 1], 'utf8') : '';",
    "fs.appendFileSync(log, JSON.stringify({ args, prompt }) + '\\n');",
    "if (args.includes('magclaw-notify:nreq_context_sync')) process.stdout.write(JSON.stringify({ result: { title: '修复 /Users/alice/private', markdown: '- token=agent-secret 10.0.0.8' } }));",
    "else process.stdout.write(JSON.stringify({ ok: true }));",
    '',
  ].join('\n'));
  await writeFile(lark, [
    '#!/usr/bin/env node',
    "process.stdout.write(JSON.stringify({ data: { message_id: 'om_sent' } }));",
    '',
  ].join('\n'));
  await chmod(openclaw, 0o700);
  await chmod(lark, 0o700);
  await addNotifyGroup(profilePaths, { name: '研发群', chatId: 'oc_local_only' });
  await configureNotifyHandler(profilePaths, {
    agentProvider: { command: openclaw, agentId: 'monkey-member', groupContextSync: true },
    deliveryProvider: { kind: 'lark-cli-feishu', command: lark, account: 'monkey', enabled: true },
  });
  const request = {
    id: 'nreq_context_sync',
    requester: { id: 'hum_remote', name: '李四' },
    payload: {
      target: { group: '研发群' },
      content: { title: '本轮更新 /Users/alice/code/kizuna', markdown: '- secret: raw-secret-value token=sender-secret 10.0.0.8' },
      mentions: [],
      context: {},
    },
  };
  const awaiting = await handleNotifyDelivery(profilePaths, request);
  const approved = await confirmNotifyMapping(profilePaths, awaiting.confirmationId, 'once');
  assert.equal(approved.result.status, 'sent');
  assert.equal(approved.result.groupContextSync, 'succeeded');
  const calls = (await readFile(openclawLog, 'utf8')).trim().split('\n').map(JSON.parse);
  const groupCall = calls.find((call) => call.args.includes('feishu:group:oc_local_only'));
  assert.ok(groupCall);
  assert.match(groupCall.prompt, /Keep it as group conversation context/);
  assert.doesNotMatch(groupCall.prompt, /Users\/alice|sender-secret|10\.0\.0\.8/);
  assert.match(groupCall.prompt, /\[local-path\]|\[kizuna\]/);
  assert.match(groupCall.prompt, /\[private-ip\]/);
  // The delivered content is built from the sender's submission only. An Agent
  // reply must never become the message body, so its text cannot appear here.
  assert.doesNotMatch(groupCall.prompt, /agent-secret|修复/);
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
  const memory = await readNotifyState({ dir: root }, 'memory');
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
  const pending = await readNotifyState(profilePaths, 'pending');
  const confirmed = await confirmNotifyMapping(profilePaths, pending[0].id, 'approve');
  assert.equal(confirmed.confirmation.status, 'approved');
  assert.equal(confirmed.result.status, 'awaiting_owner_approval');
  assert.equal(confirmed.cloudReport.reported, false);
  const pendingAfterAlias = await readNotifyState(profilePaths, 'pending');
  const targetApproval = pendingAfterAlias.find((record) => record.kind === 'target_access' && record.status === 'pending');
  const targetApproved = await confirmNotifyMapping(profilePaths, targetApproval.id, 'once');
  assert.equal(targetApproved.result.status, 'awaiting_configuration');
  const directory = await readNotifyState(profilePaths, 'directory');
  assert.deepEqual(directory.groups[0].confirmedAliases, ['研发群']);
});

test('Notify target approval batches per user and group with once, long-lived, owner-only, and 24-hour semantics', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-target-access-'));
  const profilePaths = { dir: root, profile: 'target-access', config: path.join(root, 'daemon-config.json') };
  let clock = Date.parse('2026-08-07T03:00:00.000Z');
  const unregisterClock = registerNotifyRuntime(profilePaths, { now: () => new Date(clock).toISOString() });
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
  const pending = await readNotifyState(profilePaths, 'pending');
  const batch = pending.find((record) => record.id === first.confirmationId);
  assert.equal(Date.parse(batch.expiresAt) - Date.parse(batch.createdAt), 24 * 60 * 60 * 1000);
  const card = larkCardForTargetApproval(batch);
  assert.deepEqual(card.body.elements.filter((element) => element.tag === 'button').map((element) => element.behaviors[0].value.decision), ['once', 'always', 'reject']);

  await assert.rejects(
    inspectNotifyCardAction(profilePaths, { action_value: { source: 'magclaw_notify', confirmationId: first.confirmationId, decision: 'always' } }),
    /owner identity is required/i,
  );
  await assert.rejects(
    confirmNotifyMapping(profilePaths, first.confirmationId, 'always'),
    /owner identity is required/i,
  );
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
  assert.equal(Date.parse(grants[0].expiresAt) - Date.parse(grants[0].createdAt), 90 * 24 * 60 * 60 * 1000);
  const direct = await prepareNotifyDelivery(profilePaths, makeRequest('nreq_batch_6'));
  assert.equal(direct.status, 'processing');
  assert.equal(direct.shouldProcess, true);
  for (let index = 7; index <= 15; index += 1) {
    assert.equal((await prepareNotifyDelivery(profilePaths, makeRequest(`nreq_batch_${index}`))).status, 'processing');
  }
  const overLimit = await prepareNotifyDelivery(profilePaths, makeRequest('nreq_batch_16'));
  assert.equal(overLimit.status, 'awaiting_owner_approval');

  const expiring = await prepareNotifyDelivery(profilePaths, makeRequest('nreq_expired', 'usr_other'));
  const expiringRecords = await readNotifyState(profilePaths, 'pending');
  const expiringRecord = expiringRecords.find((record) => record.id === expiring.confirmationId);
  clock = Date.parse(expiringRecord.expiresAt) + 1;
  await assert.rejects(confirmNotifyMapping(profilePaths, expiring.confirmationId, 'always', { operatorId: 'ou_owner' }), /expired/i);
  const afterExpiry = await readNotifyState(profilePaths, 'pending');
  assert.equal(afterExpiry.find((record) => record.id === expiring.confirmationId).result.status, 'approval_expired');
  const retry = await prepareNotifyDelivery(profilePaths, makeRequest('nreq_expired_retry', 'usr_other'));
  assert.notEqual(retry.confirmationId, expiring.confirmationId);
  unregisterClock();
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
