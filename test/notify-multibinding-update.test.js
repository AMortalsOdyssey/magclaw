import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  listNotifyConnections,
  notifyProjectPaths,
  readNotifyConnections,
  saveNotifyConnection,
  selectNotifyConnection,
  useNotifyConnection,
} from '../notify/src/connections.js';
import {
  installGlobalNotifyClient,
  loginNotifyClient,
  setupNotifyClient,
} from '../notify/src/cli.js';
import {
  decodeNotifyConnectionToken,
  encodeNotifyConnectionToken,
} from '../notify/src/setup-token.js';
import { encodeNotifyConnectionToken as encodeOwnerConnectionToken } from '../notify-owner/src/setup-token.js';
import {
  applyNotifyUpdate,
  checkNotifyUpdate,
  notifyUpdatePaths,
  notifyVersionGreater,
  readNotifyUpdateState,
} from '../notify/src/update.js';
import {
  addNotifyBinding,
  listNotifyBindings,
  notifyBindingProfile,
  readNotifyBindings,
  resolveNotifyBinding,
} from '../notify-owner/src/bindings.js';
import {
  addNotifyGroup,
  confirmNotifyMapping,
  listNotifyDirectory,
  prepareNotifyDelivery,
  reconcileNotifyGroups,
  resolveNotifyGroup,
} from '../notify-owner/src/handler.js';
import { closeNotifyStateStore, ensureNotifyStateStore } from '../notify-owner/src/store.js';
import {
  applyNotifyOwnerUpdate,
  notifyOwnerUpdatePaths,
  readNotifyOwnerUpdateState,
} from '../notify-owner/src/update.js';
import { installNotifyOpenClawPlugin, rollbackNotifyOpenClawPlugin } from '../notify-owner/src/plugin-installer.js';

async function project(root, name) {
  const dir = path.join(root, name);
  await mkdir(path.join(dir, '.git'), { recursive: true });
  return dir;
}

function fakeNotifyLogin(relayHandle, calls = []) {
  return async (relayUrl, pathname, options = {}) => {
    calls.push({ relayUrl, pathname, options });
    if (pathname === '/api/notify/auth/start') {
      return {
        verificationUri: '/notify/auth/approve?user_code=ABCDE-12345',
        userCode: 'ABCDE-12345',
        deviceCode: 'mcn_dev_test',
        intervalMs: 1,
      };
    }
    return {
      status: 'approved',
      token: `mcn_access_${relayHandle}`,
      tokenExpiresAt: '2026-08-10T00:00:00.000Z',
      relayHandle,
      user: { id: 'usr_sender', name: 'Sender' },
    };
  };
}

test('Notify one-token setup derives Relay and Bot, installs integrations, and selects the project default', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-one-token-'));
  const projectDir = await project(root, 'alpha');
  const env = { MAGCLAW_NOTIFY_HOME: path.join(root, 'home') };
  const rawToken = 'mcn_inv_7KQ4P9DX3M2F8R6T';
  const ownerToken = encodeNotifyConnectionToken({ relayUrl: 'https://magclaw-testing.multiego.me/', setupToken: rawToken });
  assert.equal(ownerToken, 'MCN-T-7KQ4-P9DX-3M2F-8R6T');
  assert.equal(ownerToken, encodeOwnerConnectionToken({ relayUrl: 'https://magclaw-testing.multiego.me/', setupToken: rawToken }));
  assert.deepEqual(decodeNotifyConnectionToken(ownerToken), {
    setupToken: rawToken,
    relayUrl: 'https://magclaw-testing.multiego.me',
    format: 'short-connection-code',
  });

  const calls = [];
  const installed = [];
  let loginPrompt = '';
  const result = await setupNotifyClient({ token: ownerToken, projectDir, noOpen: true }, [], {
    env,
    installGlobalNotifyClient: async () => ({ packageName: '@magclaw/notify', version: '0.8.1', installed: true }),
    requestJson: fakeNotifyLogin('monkey-ee50caa', calls),
    installNotifyIntegrations: async () => { installed.push('called'); return [{ kind: 'codex' }]; },
    stderr: { write(value) { loginPrompt += value; } },
  });
  assert.equal(result.connection, 'monkey-ee50caa');
  assert.equal(result.default, true);
  assert.equal(result.clientInstall.version, '0.8.1');
  assert.equal(result.relayUrl, 'https://magclaw-testing.multiego.me');
  assert.deepEqual(result.installedIntegrations, [{ kind: 'codex' }]);
  assert.deepEqual(installed, ['called']);
  assert.equal(calls[0].relayUrl, 'https://magclaw-testing.multiego.me');
  assert.equal(calls[0].options.body.inviteToken, rawToken);
  assert.match(loginPrompt, /^Open this link to approve MagClaw Notify \(no code entry required\):\nhttps:\/\/magclaw-testing\.multiego\.me\/notify\/auth\/approve\?user_code=ABCDE-12345\n/);
  assert.doesNotMatch(loginPrompt, /^Code:/m);
  assert.doesNotMatch(JSON.stringify(await listNotifyConnections({ projectDir, env })), /7KQ4P9DX3M2F8R6T|MCN-T/);
});

test('Notify official Relay tokens render as compact connection codes while legacy and custom tokens remain compatible', () => {
  const rawToken = 'mcn_inv_7KQ4P9DX3M2F8R6T';
  const testingCode = encodeNotifyConnectionToken({
    relayUrl: 'https://magclaw-testing.multiego.me/',
    setupToken: rawToken,
  });
  assert.equal(testingCode, 'MCN-T-7KQ4-P9DX-3M2F-8R6T');
  assert.equal(testingCode, encodeOwnerConnectionToken({
    relayUrl: 'https://magclaw-testing.multiego.me/',
    setupToken: rawToken,
  }));
  assert.deepEqual(decodeNotifyConnectionToken(testingCode.toLowerCase()), {
    setupToken: rawToken,
    relayUrl: 'https://magclaw-testing.multiego.me',
    format: 'short-connection-code',
  });

  const productionCode = encodeNotifyConnectionToken({
    relayUrl: 'https://magclaw.multiego.me',
    setupToken: rawToken,
  });
  assert.equal(productionCode, 'MCN-P-7KQ4-P9DX-3M2F-8R6T');
  assert.deepEqual(decodeNotifyConnectionToken(productionCode), {
    setupToken: rawToken,
    relayUrl: 'https://magclaw.multiego.me',
    format: 'short-connection-code',
  });

  const oldRawToken = 'mcn_inv_monkey-ee50caa_existing-owner-secret';
  const oldOwnerToken = encodeNotifyConnectionToken({
    relayUrl: 'https://magclaw-testing.multiego.me',
    setupToken: oldRawToken,
  });
  assert.match(oldOwnerToken, /^mcn_setup_/);
  assert.deepEqual(decodeNotifyConnectionToken(oldOwnerToken), {
    setupToken: oldRawToken,
    relayUrl: 'https://magclaw-testing.multiego.me',
    format: 'connection-token',
  });

  const customToken = encodeNotifyConnectionToken({
    relayUrl: 'https://notify.example',
    setupToken: rawToken,
  });
  assert.match(customToken, /^mcn_setup_/);
  assert.deepEqual(decodeNotifyConnectionToken(customToken), {
    setupToken: rawToken,
    relayUrl: 'https://notify.example',
    format: 'connection-token',
  });
});

test('Notify setup keeps multiple Bot Tokens isolated, makes the newest default, and updates repeated Bots in place', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-multi-token-'));
  const projectDir = await project(root, 'alpha');
  const env = { MAGCLAW_NOTIFY_HOME: path.join(root, 'home') };
  const connectionIds = [];
  const setup = async (relayHandle, secret) => setupNotifyClient({
    token: encodeNotifyConnectionToken({ relayUrl: 'https://notify.example', setupToken: `mcn_inv_${relayHandle}_${secret}` }),
    projectDir,
    noOpen: true,
    noSkill: true,
  }, [], {
    env,
    installGlobalNotifyClient: async () => ({ installed: true }),
    requestJson: async (relayUrl, pathname, options) => {
      if (pathname === '/api/notify/auth/start') connectionIds.push(options.body.connectionId);
      return fakeNotifyLogin(relayHandle)(relayUrl, pathname, options);
    },
    stderr: { write() {} },
  });

  await setup('monkey-ee50caa', 'first');
  await setup('release-12345678', 'second');
  let connections = await listNotifyConnections({ projectDir, env });
  assert.equal(connections.connections.length, 2);
  assert.equal(connections.defaultConnection, 'release-12345678');

  await setup('monkey-ee50caa', 'rotated');
  connections = await listNotifyConnections({ projectDir, env });
  assert.equal(connections.connections.length, 2);
  assert.equal(connections.defaultConnection, 'monkey-ee50caa');
  assert.equal(connectionIds[0], connectionIds[2]);
});

test('Notify setup reuses an existing user-named Bot connection and repairs only same-device duplicates', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-existing-name-'));
  const projectDir = await project(root, 'alpha');
  const env = { MAGCLAW_NOTIFY_HOME: path.join(root, 'home') };
  await saveNotifyConnection({
    relayUrl: 'https://notify.example', token: 'old-token', connectionId: 'ncn_same', relayHandle: 'monkey-ee50caa',
  }, { projectDir, connection: 'monkey', env });
  await saveNotifyConnection({
    relayUrl: 'https://notify.example', token: 'duplicate-token', connectionId: 'ncn_same', relayHandle: 'monkey-ee50caa',
  }, { projectDir, connection: 'monkey-ee50caa', env });
  await saveNotifyConnection({
    relayUrl: 'https://notify.example', token: 'other-device', connectionId: 'ncn_other', relayHandle: 'monkey-ee50caa',
  }, { projectDir, connection: 'monkey-other-device', env });
  const result = await setupNotifyClient({
    token: encodeNotifyConnectionToken({
      relayUrl: 'https://notify.example', setupToken: 'mcn_inv_monkey-ee50caa_reuse-existing',
    }),
    projectDir,
    noOpen: true,
    noSkill: true,
  }, [], {
    env,
    installGlobalNotifyClient: async () => ({ installed: true }),
    requestJson: fakeNotifyLogin('monkey-ee50caa'),
    stderr: { write() {} },
  });
  assert.equal(result.connection, 'monkey');
  const connections = await listNotifyConnections({ projectDir, env });
  assert.deepEqual(connections.connections.map((item) => item.name), ['monkey', 'monkey-other-device']);
  assert.equal(connections.defaultConnection, 'monkey');
});

test('Notify setup preserves an authenticated connection when host integration installation fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-install-recovery-'));
  const projectDir = await project(root, 'alpha');
  const env = { MAGCLAW_NOTIFY_HOME: path.join(root, 'home') };
  const token = encodeNotifyConnectionToken({
    relayUrl: 'https://notify.example',
    setupToken: 'mcn_inv_monkey-ee50caa_install-failure',
  });
  await assert.rejects(setupNotifyClient({ token, projectDir, noOpen: true }, [], {
    env,
    installGlobalNotifyClient: async () => ({ installed: true }),
    requestJson: fakeNotifyLogin('monkey-ee50caa'),
    installNotifyIntegrations: async () => { throw new Error('invalid Claude Desktop JSON'); },
    stderr: { write() {} },
  }), /connection monkey-ee50caa was saved.*run setup again/i);
  const connections = await listNotifyConnections({ projectDir, env });
  assert.equal(connections.connections.length, 1);
  assert.equal(connections.defaultConnection, 'monkey-ee50caa');
});

test('Notify setup rejects damaged self-describing Tokens before contacting a Relay or writing project state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-bad-token-'));
  const projectDir = path.join(root, 'plain-directory');
  const env = { MAGCLAW_NOTIFY_HOME: path.join(root, 'home') };
  await mkdir(projectDir, { recursive: true });
  let contacted = false;
  await assert.rejects(setupNotifyClient({ token: 'mcn_setup_not-valid-base64', projectDir, noOpen: true }, [], {
    env,
    installGlobalNotifyClient: async () => { throw new Error('must not install'); },
    requestJson: async () => { contacted = true; },
    stderr: { write() {} },
  }), /invalid or damaged/i);
  assert.equal(contacted, false);
  assert.equal((await listNotifyConnections({ projectDir, env })).connections.length, 0);
  await assert.rejects(setupNotifyClient({ token: 'MCN-T-7KQ4-P9DX-3M2F-8R6I', projectDir }, [], {
    env,
    installGlobalNotifyClient: async () => { throw new Error('must not install'); },
  }), /valid Owner-provided Token/i);
  await assert.rejects(setupNotifyClient({ token: 'not-a-notify-token', projectDir }, [], {
    env,
    installGlobalNotifyClient: async () => { throw new Error('must not install'); },
  }), /valid Owner-provided Token/i);
});

test('Notify bootstrap installs and verifies the exact Client version on POSIX and Windows', async () => {
  for (const platform of ['darwin', 'win32']) {
    const calls = [];
    const result = await installGlobalNotifyClient({
      platform,
      spawnSync(command, args) {
        calls.push({ command, args });
        if (args[0] === 'install') return { status: 0, stdout: '', stderr: '' };
        return {
          status: 0,
          stdout: JSON.stringify({ dependencies: { '@magclaw/notify': { version: '0.8.1' } } }),
          stderr: '',
        };
      },
    });
    assert.equal(result.version, '0.8.1');
    assert.equal(calls[0].command, platform === 'win32' ? 'npm.cmd' : 'npm');
    assert.deepEqual(calls[0].args.slice(0, 2), ['install', '--global']);
    assert.ok(calls[0].args.includes('@magclaw/notify@0.8.1'));
    assert.deepEqual(calls[1].args.slice(0, 4), ['list', '--global', '--depth=0', '--json']);
  }
});

test('Notify bootstrap stops before Relay login and project writes when global installation fails', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-global-install-failure-'));
  const projectDir = await project(root, 'alpha');
  const env = { MAGCLAW_NOTIFY_HOME: path.join(root, 'home') };
  let contacted = false;
  await assert.rejects(setupNotifyClient({
    token: encodeNotifyConnectionToken({
      relayUrl: 'https://notify.example',
      setupToken: 'mcn_inv_monkey-ee50caa_global-install-failure',
    }),
    projectDir,
    noOpen: true,
  }, [], {
    env,
    installGlobalNotifyClient: async () => { throw new Error('npm global directory is not writable'); },
    requestJson: async () => { contacted = true; },
    stderr: { write() {} },
  }), /npm global directory is not writable/i);
  assert.equal(contacted, false);
  assert.equal((await listNotifyConnections({ projectDir, env })).connections.length, 0);
});

test('Notify Client scopes multiple connections by project, refuses ambiguous selection, and recovers a corrupted registry', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-project-connections-'));
  const home = path.join(root, 'home');
  const firstProject = await project(root, 'alpha');
  const secondProject = await project(root, 'beta');
  const env = { MAGCLAW_NOTIFY_HOME: home };
  await Promise.all([
    saveNotifyConnection({ relayUrl: 'https://one.example', token: 'token-one', connectionId: 'ncn_one' }, { projectDir: firstProject, connection: 'monkey', env }),
    saveNotifyConnection({ relayUrl: 'https://two.example', token: 'token-two', connectionId: 'ncn_two' }, { projectDir: secondProject, connection: 'monkey', env }),
  ]);
  await saveNotifyConnection({ relayUrl: 'https://backup.example', token: 'token-backup', connectionId: 'ncn_backup' }, { projectDir: firstProject, connection: 'backup', env });
  const first = await listNotifyConnections({ projectDir: firstProject, env });
  const second = await listNotifyConnections({ projectDir: secondProject, env });
  assert.notEqual(first.projectKey, second.projectKey);
  assert.deepEqual(first.connections.map((item) => item.name), ['backup', 'monkey']);
  assert.deepEqual(second.connections.map((item) => item.name), ['monkey']);
  assert.equal((await selectNotifyConnection({ projectDir: firstProject, env })).name, 'monkey');
  await useNotifyConnection('backup', { projectDir: firstProject, env });
  assert.equal((await selectNotifyConnection({ projectDir: firstProject, env })).name, 'backup');

  const paths = notifyProjectPaths({ projectDir: firstProject, env });
  const registry = JSON.parse(await readFile(paths.connections, 'utf8'));
  registry.defaultConnection = '';
  await writeFile(paths.connections, `${JSON.stringify(registry)}\n`, { mode: 0o600 });
  await assert.rejects(selectNotifyConnection({ projectDir: firstProject, env }), /multiple Notify connections and no default/i);
  await writeFile(paths.connections, '{broken', { mode: 0o600 });
  const recovered = await readNotifyConnections({ projectDir: firstProject, env });
  assert.equal(recovered.recoveredFromBackup, true);
  assert.equal((await stat(paths.connections)).mode & 0o777, 0o600);
});

test('Notify connection registry serializes high-contention writers without losing entries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-project-stress-'));
  const projectDir = await project(root, 'stress');
  const env = { MAGCLAW_NOTIFY_HOME: path.join(root, 'home') };
  await Promise.all(Array.from({ length: 60 }, (_, index) => saveNotifyConnection({
    relayUrl: `https://${index}.example`, token: `token-${index}`, connectionId: `ncn_${index}`,
  }, { projectDir, connection: `connection-${index}`, env })));
  assert.equal((await listNotifyConnections({ projectDir, env })).connections.length, 60);
});

test('Notify Owner supports multiple Bot Bindings with isolated state and backup recovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-bindings-'));
  const env = { MAGCLAW_NOTIFY_HOME: root };
  const monkey = await addNotifyBinding({ id: 'monkey', name: 'Monkey', accountId: 'monkey' }, env);
  const release = await addNotifyBinding({ id: 'release-bot', name: 'Release Bot', accountId: 'release' }, env);
  assert.notEqual(monkey.profile.root, release.profile.root);
  assert.match(monkey.profile.root, /bindings\/monkey$/);
  await assert.rejects(resolveNotifyBinding({}, env), /Multiple Notify Bots/);
  assert.equal((await resolveNotifyBinding({ bot: 'release-bot' }, env)).binding.accountId, 'release');
  await assert.rejects(addNotifyBinding({ id: 'monkey', name: 'Other', accountId: 'other' }, env), /already used/);
  const paths = (await readNotifyBindings(env)).paths;
  await writeFile(paths.file, '{broken', { mode: 0o600 });
  const recovered = await readNotifyBindings(env);
  assert.equal(recovered.recoveredFromBackup, true);
  assert.equal((await listNotifyBindings(env)).bindings.length, 1);
});

function request(id, group, connectionId = 'ncn_one', requesterId = 'usr_sender') {
  return {
    id,
    requester: { id: requesterId, name: 'Sender', connectionId, identity: { provider: 'feishu', providerAccountId: `union_${requesterId}` } },
    payload: { target: { group }, content: { title: 'Test', markdown: 'done' }, mentions: [], context: {} },
  };
}

test('Duplicate Feishu group names require explicit chat selection and remember only a scoped route preference', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-duplicate-groups-'));
  const profile = { dir: root, profile: 'monkey' };
  const first = await addNotifyGroup(profile, { name: '研发群', chatId: 'oc_first', routeLabel: '研发群 · 上海', ownerName: '甲', memberCount: 12 });
  const second = await addNotifyGroup(profile, { name: '研发群', chatId: 'oc_second', routeLabel: '研发群 · 北京', ownerName: '乙', memberCount: 18 });
  const initial = await listNotifyDirectory(profile);
  assert.equal(resolveNotifyGroup(initial.directory, '研发群').status, 'ambiguous');
  const prepared = await prepareNotifyDelivery(profile, request('nreq_ambiguous', '研发群'));
  assert.equal(prepared.status, 'awaiting_confirmation');
  const confirmed = await confirmNotifyMapping(profile, prepared.confirmationId, 'approve', { candidateGroupId: second.id });
  assert.equal(confirmed.result.status, 'awaiting_owner_approval');
  const directory = (await listNotifyDirectory(profile)).directory;
  assert.equal(resolveNotifyGroup(directory, '研发群', { connectionId: 'ncn_one', requesterId: 'usr_sender' }).group.id, second.id);
  assert.equal(resolveNotifyGroup(directory, '研发群', { connectionId: 'ncn_other', requesterId: 'usr_sender' }).status, 'ambiguous');
  assert.equal(resolveNotifyGroup(directory, '研发群', { connectionId: 'ncn_one', requesterId: 'usr_other' }).status, 'ambiguous');
  const duplicate = await confirmNotifyMapping(profile, prepared.confirmationId, 'approve', { candidateGroupId: first.id });
  assert.equal(duplicate.deduped, true);
  closeNotifyStateStore(profile);
});

test('Group reconciliation disables only terminal Feishu chat failures and preserves routes on transient errors', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-group-reconcile-'));
  const profile = { dir: root, profile: 'monkey' };
  await addNotifyGroup(profile, { name: '正常群', chatId: 'oc_ok' });
  await addNotifyGroup(profile, { name: '已移除群', chatId: 'oc_removed' });
  await addNotifyGroup(profile, { name: '临时失败群', chatId: 'oc_transient' });
  const result = await reconcileNotifyGroups(profile, {
    async getChat({ chatId }) {
      if (chatId === 'oc_ok') return { owner_name: 'Owner', user_count: 9 };
      const error = new Error('lookup failed');
      if (chatId === 'oc_removed') { error.httpStatus = 404; error.apiCode = 230001; }
      else { error.httpStatus = 503; error.apiCode = 999999; }
      throw error;
    },
  });
  assert.deepEqual(result, { checked: 2, available: 1, unavailable: 1 });
  const groups = (await listNotifyDirectory(profile)).directory.groups;
  assert.equal(groups.find((item) => item.chatId === 'oc_removed').available, false);
  assert.equal(groups.find((item) => item.chatId === 'oc_transient').available, true);
  closeNotifyStateStore(profile);
});

async function fakeNpm(root, delayMs = 0) {
  const command = path.join(root, 'fake-npm');
  const log = path.join(root, 'npm.jsonl');
  await writeFile(command, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    delayMs ? `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${delayMs});` : '',
    "if (process.argv.includes('exec')) { const spec = process.argv.find((value) => value.startsWith('--package=@magclaw/notify@')); process.stdout.write(spec.split('@').at(-1) + '\\n'); }",
  ].filter(Boolean).join('\n'), { mode: 0o700 });
  await chmod(command, 0o700);
  return { command, log };
}

test('Notify Client auto-update checks versions, verifies an exact package, keeps rollback state, and recovers corrupt state', async () => {
  assert.equal(notifyVersionGreater('0.6.1', '0.6.0'), true);
  assert.equal(notifyVersionGreater('0.6.0', '0.6.0'), false);
  const check = await checkNotifyUpdate({ currentVersion: '0.6.0', fetch: async () => new Response(JSON.stringify({ version: '0.6.1' })) });
  assert.equal(check.updateAvailable, true);
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-client-update-'));
  const env = { ...process.env, MAGCLAW_NOTIFY_HOME: path.join(root, 'home') };
  const npm = await fakeNpm(root);
  const result = await applyNotifyUpdate('0.6.1', { currentVersion: '0.6.0', npmPath: npm.command }, env);
  assert.equal(result.updated, true);
  assert.equal(result.previousVersion, '0.6.0');
  const paths = notifyUpdatePaths(env);
  assert.equal((await stat(paths.state)).mode & 0o777, 0o600);
  await writeFile(paths.state, '{broken', { mode: 0o600 });
  const recovered = await readNotifyUpdateState(env);
  assert.equal(recovered.recoveredFromBackup, true);
  const calls = (await readFile(npm.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.some((args) => args.includes('@magclaw/notify@0.6.1')));
  assert.ok(calls.some((args) => args.includes('--package=@magclaw/notify@0.6.1')));
});

test('Notify Client auto-update cross-process lock allows only one installer under contention', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-client-update-race-'));
  const home = path.join(root, 'home');
  const npm = await fakeNpm(root, 250);
  const worker = path.resolve('test/fixtures/notify-update-worker.mjs');
  const launch = () => spawn(process.execPath, [worker, home, npm.command, '0.6.1', '0.6.0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const children = [launch(), launch()];
  const outputs = await Promise.all(children.map(async (child) => {
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; }); child.stderr.on('data', (chunk) => { stderr += chunk; });
    const [code] = await once(child, 'close'); assert.equal(code, 0, stderr); return JSON.parse(stdout);
  }));
  assert.equal(outputs.filter((item) => item.updated).length, 1);
  assert.equal(outputs.filter((item) => ['update_in_progress', 'already_current'].includes(item.reason)).length, 1);
});

async function fakeOwnerTools(root) {
  const npm = path.join(root, 'fake-owner-npm');
  const openclaw = path.join(root, 'fake-openclaw');
  const log = path.join(root, 'owner-tools.jsonl');
  await writeFile(npm, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(['npm', ...process.argv.slice(2)]) + '\\n');`,
    "if (process.argv.includes('exec') && process.argv.includes('--version')) { const spec = process.argv.find((value) => value.startsWith('--package=@magclaw/notify-owner@')); process.stdout.write(spec.split('@').at(-1) + '\\n'); }",
    "else if (process.argv.includes('exec')) process.stdout.write('{\"ok\":true}\\n');",
  ].join('\n'), { mode: 0o700 });
  await writeFile(openclaw, [
    '#!/usr/bin/env node',
    "const fs = require('fs');",
    `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(['openclaw', ...process.argv.slice(2)]) + '\\n');`,
    "process.stdout.write('{\"ok\":true}\\n');",
  ].join('\n'), { mode: 0o700 });
  await Promise.all([chmod(npm, 0o700), chmod(openclaw, 0o700)]);
  return { npm, openclaw, log };
}

test('Notify Owner auto-update verifies the exact package, installs the fixed plugin, restarts only when idle, and keeps recovery state', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-owner-update-'));
  const env = { ...process.env, MAGCLAW_NOTIFY_HOME: path.join(root, 'home') };
  const tools = await fakeOwnerTools(root);
  const result = await applyNotifyOwnerUpdate('0.8.1', {
    currentVersion: '0.8.0', npmPath: tools.npm, openclawPath: tools.openclaw,
  }, env);
  assert.equal(result.updated, true);
  assert.equal(result.restarted, true);
  const paths = notifyOwnerUpdatePaths(env);
  assert.equal((await stat(paths.state)).mode & 0o777, 0o600);
  await writeFile(paths.state, '{broken', { mode: 0o600 });
  assert.equal((await readNotifyOwnerUpdateState(env)).recoveredFromBackup, true);
  const calls = (await readFile(tools.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(calls.some((args) => args.includes('@magclaw/notify-owner@0.8.1')));
  assert.ok(calls.some((args) => args.includes('--package=@magclaw/notify-owner@0.8.1') && args.includes('--version')));
  assert.ok(calls.some((args) => args.includes('magclaw-notify-owner') && args.includes('install')));
  assert.ok(calls.some((args) => args[0] === 'openclaw' && args.includes('restart')));
});

test('Notify Owner update defers the Gateway restart while an approval is pending', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-owner-update-busy-'));
  const env = { ...process.env, MAGCLAW_NOTIFY_HOME: path.join(root, 'home') };
  const binding = await addNotifyBinding({ id: 'monkey', name: 'Monkey', accountId: 'monkey' }, env);
  const store = await ensureNotifyStateStore(binding.profile.handler);
  store.writeConfirmation({ id: 'ncf_busy0001', status: 'pending', requestId: 'nreq_busy', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  closeNotifyStateStore(binding.profile.handler);
  const tools = await fakeOwnerTools(root);
  const result = await applyNotifyOwnerUpdate('0.8.2', {
    currentVersion: '0.8.0', npmPath: tools.npm, openclawPath: tools.openclaw,
  }, env);
  assert.equal(result.updated, true);
  assert.equal(result.restarted, false);
  assert.equal(result.deferredForBusyState, true);
  assert.equal((await readNotifyOwnerUpdateState(env)).pendingRestart, true);
  const calls = (await readFile(tools.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(calls.some((args) => args[0] === 'openclaw' && args.includes('restart')), false);
});

test('Notify plugin installer retains one verified version and can roll back atomically', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-plugin-rollback-'));
  const target = path.join(root, 'magclaw-notify');
  const packageRoot = path.resolve('notify-owner');
  const first = await installNotifyOpenClawPlugin({ packageRoot, target });
  const second = await installNotifyOpenClawPlugin({ packageRoot, target });
  assert.equal(first.sha256, second.sha256);
  assert.equal(await stat(`${target}.previous`).then(() => true), true);
  await writeFile(path.join(target, 'index.js'), 'corrupted', { mode: 0o600 });
  const rollback = await rollbackNotifyOpenClawPlugin({ target });
  assert.equal(rollback.rolledBack, true);
  assert.equal(rollback.sha256, first.sha256);
});
