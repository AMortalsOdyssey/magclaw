import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
let nextTestPort = 6800 + Math.floor(Math.random() * 300);

async function launchIsolatedServer(tmp, extraEnv = {}) {
  const port = nextTestPort++;
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: tmp,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      CODEX_PATH: '/bin/false',
      MAGCLAW_DATA_DIR: path.join(tmp, '.magclaw'),
      DATABASE_URL: '',
      MAGCLAW_DATABASE_URL: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  let stopped = false;

  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/cloud/auth/status`);
      if (response.ok) {
        return {
          baseUrl,
          tmp,
          async stop() {
            if (!stopped) {
              stopped = true;
              child.kill('SIGINT');
              await new Promise((resolve) => child.once('exit', resolve));
            }
            await rm(tmp, { recursive: true, force: true });
          },
        };
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  child.kill('SIGINT');
  await rm(tmp, { recursive: true, force: true });
  throw new Error(`server did not start: ${output}`);
}

async function startIsolatedServer(extraEnv = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-cloud-relay-'));
  await mkdir(path.join(tmp, 'public'), { recursive: true });
  await cp(path.join(ROOT, 'server'), path.join(tmp, 'server'), { recursive: true });
  await cp(path.join(ROOT, 'public', 'index.html'), path.join(tmp, 'public', 'index.html'));
  return launchIsolatedServer(tmp, extraEnv);
}

async function request(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.cookie ? { cookie: options.cookie } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (options.expectStatus) {
    assert.equal(response.status, options.expectStatus, JSON.stringify(data));
    return { data, cookie: response.headers.get('set-cookie') || '', status: response.status };
  }
  if (!response.ok) throw new Error(`${response.status} ${data.error || response.statusText}`);
  return { data, cookie: response.headers.get('set-cookie') || '', status: response.status };
}

async function waitFor(fn, timeoutMs = 5000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error('timed out waiting for condition');
}

test('environment admin login protects app APIs and supports invites end to end', async () => {
  const server = await startIsolatedServer({
    MAGCLAW_ADMIN_NAME: 'Admin',
    MAGCLAW_ADMIN_EMAIL: 'admin@example.com',
    MAGCLAW_ADMIN_PASSWORD: 'password123',
  });
  let daemon = null;
  try {
    const initial = await request(server.baseUrl, '/api/cloud/auth/status');
    assert.equal(initial.data.auth.initialized, true);
    assert.equal(initial.data.auth.adminConfigured, true);
    assert.equal('ownerConfigured' in initial.data.auth, false);
    assert.equal(initial.data.auth.currentUser, null);

    await request(server.baseUrl, '/api/cloud/auth/bootstrap-owner', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Web Admin',
        email: 'web-admin@example.com',
        password: 'password123',
      }),
      expectStatus: 404,
    });

    await request(server.baseUrl, '/api/state', { expectStatus: 401 });
    await request(server.baseUrl, '/api/events', { expectStatus: 401 });
    await request(server.baseUrl, '/api/settings', {
      method: 'POST',
      body: JSON.stringify({ model: 'anonymous-probe' }),
      expectStatus: 401,
    });
    const badLogin = await request(server.baseUrl, '/api/cloud/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'missing@example.com', password: 'wrong-password' }),
      expectStatus: 401,
    });
    assert.equal(badLogin.data.error, 'Invalid email or password.');

    const basicAuth = `Basic ${Buffer.from('admin@example.com:password123').toString('base64')}`;
    const basicState = await request(server.baseUrl, '/api/state', {
      headers: { authorization: basicAuth },
    });
    assert.equal(basicState.data.cloud.auth.currentUser.email, 'admin@example.com');
    assert.equal(basicState.data.cloud.auth.currentMember.role, 'admin');

    const basicInvite = await request(server.baseUrl, '/api/cloud/invitations', {
      method: 'POST',
      headers: { authorization: basicAuth },
      body: JSON.stringify({ email: 'basic-member@example.com', role: 'member' }),
    });
    assert.match(basicInvite.data.inviteToken, /^mc_inv_/);
    const adminApis = await request(server.baseUrl, '/api/cloud/admin/apis', {
      headers: { authorization: basicAuth },
    });
    assert.equal(adminApis.data.auth.basicAuth, true);
    const membersApiModule = adminApis.data.modules.find((item) => item.id === 'members');
    assert.equal(membersApiModule.name, 'Members');
    assert.ok(membersApiModule.endpoints.some((item) => item.method === 'POST' && item.path === '/api/cloud/invitations/batch' && item.response.invitations[0].inviteUrl));
    assert.ok(membersApiModule.endpoints.some((item) => item.method === 'POST' && item.path === '/api/cloud/password-resets' && item.response.resetUrl));
    assert.ok(membersApiModule.endpoints.some((item) => item.method === 'PATCH' && item.path === '/api/cloud/members/:id'));
    assert.ok(adminApis.data.endpoints.some((item) => item.method === 'POST' && item.path === '/api/cloud/invitations' && item.role === 'member'));
    assert.ok(adminApis.data.endpoints.some((item) => item.method === 'POST' && item.path === '/api/cloud/invitations/batch' && item.role === 'member'));
    assert.ok(adminApis.data.endpoints.some((item) => item.method === 'POST' && item.path === '/api/cloud/password-resets' && item.role === 'admin'));
    assert.ok(adminApis.data.endpoints.some((item) => item.path === '/api/settings/fanout' && item.role === 'admin'));

    const admin = await request(server.baseUrl, '/api/cloud/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'admin@example.com',
        password: 'password123',
      }),
    });
    assert.equal(admin.data.user.email, 'admin@example.com');
    assert.equal(admin.data.member.role, 'admin');
    const adminCookie = admin.cookie;
    assert.match(adminCookie, /magclaw_session=/);

    const adminState = await request(server.baseUrl, '/api/state', { cookie: adminCookie });
    assert.equal(adminState.data.cloud.auth.currentUser.email, 'admin@example.com');
    assert.equal(adminState.data.cloud.auth.currentMember.role, 'admin');
    assert.equal(adminState.data.cloud.auth.sessionTtlMs, 1000 * 60 * 60 * 24 * 14);
    assert.match(adminState.data.cloud.auth.sessionExpiresAt, /^\d{4}-\d{2}-\d{2}T/);
    const adminPresence = await request(server.baseUrl, '/api/cloud/auth/heartbeat', {
      method: 'POST',
      cookie: adminCookie,
      body: '{}',
    });
    assert.equal(adminPresence.data.timeoutMs, 1000 * 60 * 2);
    assert.equal(adminPresence.data.human.status, 'online');
    const adminSettings = await request(server.baseUrl, '/api/settings', {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ model: 'admin-model' }),
    });
    assert.equal(adminSettings.status, 200);

    const invite = await request(server.baseUrl, '/api/cloud/invitations', {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ email: 'member@example.com', role: 'member' }),
    });
    assert.match(invite.data.inviteToken, /^mc_inv_/);

    const member = await request(server.baseUrl, '/api/cloud/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        inviteToken: invite.data.inviteToken,
        name: 'Member',
        email: 'member@example.com',
        password: 'password123',
      }),
    });
    assert.equal(member.data.member.role, 'member');
    const memberCookie = member.cookie;

    const memberInviteResult = await request(server.baseUrl, '/api/cloud/invitations', {
      method: 'POST',
      cookie: memberCookie,
      body: JSON.stringify({ email: 'another@example.com', role: 'member' }),
    });
    assert.equal(memberInviteResult.data.invitation.role, 'member');
    await request(server.baseUrl, '/api/settings', {
      method: 'POST',
      cookie: memberCookie,
      body: JSON.stringify({ model: 'member-probe' }),
      expectStatus: 403,
    });
    const memberState = await request(server.baseUrl, '/api/state', { cookie: memberCookie });
    assert.equal(memberState.data.cloud.auth.currentUser.email, 'member@example.com');
    assert.ok(memberState.data.humans.some((human) => human.id === member.data.member.humanId && human.status === 'online'));

    const pairing = await request(server.baseUrl, '/api/cloud/computers/pairing-tokens', {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ name: 'CI runner' }),
    });
    assert.match(pairing.data.pairToken, /^mc_pair_/);
    assert.match(pairing.data.command, /server\/daemon\/cli\.js/);

    const daemonConfig = path.join(server.tmp, 'daemon.json');
    daemon = spawn(process.execPath, [
      'server/daemon/cli.js',
      '--server-url',
      server.baseUrl,
      '--pair-token',
      pairing.data.pairToken,
      '--config',
      daemonConfig,
    ], {
      cwd: server.tmp,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const state = await waitFor(async () => {
      const snapshot = (await request(server.baseUrl, '/api/state', { cookie: adminCookie })).data;
      const computer = snapshot.computers.find((item) => item.id === pairing.data.computer.id);
      return computer?.status === 'connected' ? snapshot : null;
    });

    const pairedComputer = state.computers.find((item) => item.id === pairing.data.computer.id);
    assert.equal(pairedComputer.connectedVia, 'daemon');
    assert.ok((pairedComputer.runtimeIds || []).includes('codex'));
    const saved = JSON.parse(await readFile(daemonConfig, 'utf8'));
    assert.match(saved.token, /^mc_machine_/);
  } finally {
    if (daemon) {
      daemon.kill('SIGINT');
      await Promise.race([
        new Promise((resolve) => daemon.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 500)),
      ]);
    }
    await server.stop();
  }
});

test('cloud roles enforce core member invite and removal boundaries', async () => {
  const server = await startIsolatedServer({
    MAGCLAW_ADMIN_NAME: 'Admin',
    MAGCLAW_ADMIN_EMAIL: 'admin@example.com',
    MAGCLAW_ADMIN_PASSWORD: 'password123',
  });
  try {
    const admin = await request(server.baseUrl, '/api/cloud/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
    });
    const adminCookie = admin.cookie;

    await request(server.baseUrl, '/api/cloud/invitations', {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ email: 'bad-admin@example.com', role: 'admin' }),
      expectStatus: 403,
    });

    const coreInvite = await request(server.baseUrl, '/api/cloud/invitations', {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ email: 'core@example.com', role: 'core_member' }),
    });
    const core = await request(server.baseUrl, '/api/cloud/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        inviteToken: coreInvite.data.inviteToken,
        email: 'core@example.com',
        name: 'Core',
        password: 'password123',
      }),
    });
    assert.equal(core.data.member.role, 'core_member');
    assert.match(core.data.user.id, /^usr_\d{8}$/);
    const coreCookie = core.cookie;

      const invitedCore = await request(server.baseUrl, '/api/cloud/invitations', {
        method: 'POST',
        cookie: coreCookie,
        body: JSON.stringify({ email: 'core-two@example.com', role: 'core_member' }),
      });
      assert.equal(invitedCore.data.invitation.role, 'core_member');
      const coreTwo = await request(server.baseUrl, '/api/cloud/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          inviteToken: invitedCore.data.inviteToken,
          email: 'core-two@example.com',
          name: 'Core Two',
          password: 'password123',
        }),
      });
    await request(server.baseUrl, `/api/cloud/members/${admin.data.member.id}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ role: 'member' }),
      expectStatus: 403,
    });
    await request(server.baseUrl, '/api/cloud/invitations', {
      method: 'POST',
      cookie: coreCookie,
      body: JSON.stringify({ email: 'bad-admin@example.com', role: 'admin' }),
      expectStatus: 403,
    });

    const memberInvite = await request(server.baseUrl, '/api/cloud/invitations', {
      method: 'POST',
      cookie: coreCookie,
      body: JSON.stringify({ email: 'member@example.com', role: 'member' }),
    });
    const member = await request(server.baseUrl, '/api/cloud/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        inviteToken: memberInvite.data.inviteToken,
        email: 'member@example.com',
        name: 'Member',
        password: 'password123',
      }),
    });
    assert.equal(member.data.member.role, 'member');
    const oldMemberUserId = member.data.user.id;
    const oldMemberHumanId = member.data.member.humanId;
    const memberCookie = member.cookie;

    const corePromotesMember = await request(server.baseUrl, `/api/cloud/members/${member.data.member.id}`, {
      method: 'PATCH',
      cookie: coreCookie,
      body: JSON.stringify({ role: 'core_member' }),
    });
    assert.equal(corePromotesMember.data.member.role, 'core_member');
    const adminDemotesMember = await request(server.baseUrl, `/api/cloud/members/${member.data.member.id}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ role: 'member' }),
    });
    assert.equal(adminDemotesMember.data.member.role, 'member');
    await request(server.baseUrl, `/api/cloud/members/${member.data.member.id}`, {
      method: 'PATCH',
      cookie: coreCookie,
      body: JSON.stringify({ role: 'admin' }),
      expectStatus: 400,
    });
    await request(server.baseUrl, `/api/cloud/members/${core.data.member.id}`, {
      method: 'PATCH',
      cookie: memberCookie,
      body: JSON.stringify({ role: 'member' }),
      expectStatus: 403,
    });

    const memberInvitesMember = await request(server.baseUrl, '/api/cloud/invitations', {
      method: 'POST',
      cookie: memberCookie,
      body: JSON.stringify({ email: 'friend@example.com', role: 'member' }),
    });
    assert.equal(memberInvitesMember.data.invitation.role, 'member');
    await request(server.baseUrl, '/api/cloud/invitations', {
      method: 'POST',
      cookie: memberCookie,
      body: JSON.stringify({ email: 'bad-core@example.com', role: 'core_member' }),
      expectStatus: 403,
    });

    const computer = await request(server.baseUrl, '/api/computers', {
      method: 'POST',
      cookie: coreCookie,
      body: JSON.stringify({ name: 'Core runner' }),
    });
    assert.equal(computer.data.computer.name, 'Core runner');
    await request(server.baseUrl, '/api/computers', {
      method: 'POST',
      cookie: memberCookie,
      body: JSON.stringify({ name: 'Member runner' }),
      expectStatus: 403,
    });
    await request(server.baseUrl, '/api/settings', {
      method: 'POST',
      cookie: coreCookie,
      body: JSON.stringify({ model: 'core-probe' }),
      expectStatus: 403,
    });

    const removed = await request(server.baseUrl, `/api/cloud/members/${member.data.member.id}`, {
      method: 'DELETE',
      cookie: coreCookie,
      body: JSON.stringify({}),
    });
    assert.equal(removed.data.member.status, 'removed');
    await request(server.baseUrl, '/api/cloud/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'member@example.com', password: 'password123' }),
      expectStatus: 401,
    });

      await request(server.baseUrl, `/api/cloud/members/${coreTwo.data.member.id}`, {
        method: 'DELETE',
        cookie: coreCookie,
        body: JSON.stringify({}),
      expectStatus: 403,
    });

    const reinvite = await request(server.baseUrl, '/api/cloud/invitations', {
      method: 'POST',
      cookie: coreCookie,
      body: JSON.stringify({ email: 'member@example.com', role: 'member' }),
    });
    const rejoined = await request(server.baseUrl, '/api/cloud/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        inviteToken: reinvite.data.inviteToken,
        email: 'member@example.com',
        name: 'Member Again',
        password: 'password456',
      }),
    });
    assert.notEqual(rejoined.data.user.id, oldMemberUserId);
    assert.notEqual(rejoined.data.member.humanId, oldMemberHumanId);
    assert.match(rejoined.data.user.id, /^usr_\d{8}$/);
  } finally {
    await server.stop();
  }
});

test('cloud invite registration and admin password reset flows enforce tokens and password policy', async () => {
  const server = await startIsolatedServer({
    MAGCLAW_ADMIN_NAME: 'Admin',
    MAGCLAW_ADMIN_EMAIL: 'admin@example.com',
    MAGCLAW_ADMIN_PASSWORD: 'password123',
  });
  try {
    const admin = await request(server.baseUrl, '/api/cloud/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
    });
    const adminCookie = admin.cookie;

    const batch = await request(server.baseUrl, '/api/cloud/invitations/batch', {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ emails: ['batch-one@example.com', 'batch-two@example.com'], role: 'member' }),
    });
    assert.equal(batch.data.invitations.length, 2);
    assert.deepEqual(batch.data.invitations.map((item) => item.email), ['batch-one@example.com', 'batch-two@example.com']);
    assert.ok(batch.data.invitations.every((item) => item.inviteToken?.startsWith('mc_inv_')));
    assert.ok(batch.data.invitations.every((item) => item.inviteUrl?.includes('/invite?token=')));
    await request(server.baseUrl, '/api/cloud/invitations/batch', {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ emails: ['bad-admin@example.com'], role: 'admin' }),
      expectStatus: 403,
    });

    const inviteStatus = await request(server.baseUrl, `/api/cloud/auth/invitation-status?token=${encodeURIComponent(batch.data.invitations[0].inviteToken)}`);
    assert.equal(inviteStatus.data.invitation.email, 'batch-one@example.com');
    assert.equal(inviteStatus.data.invitation.role, 'member');
    assert.equal(inviteStatus.data.invitation.status, 'pending');

    await request(server.baseUrl, '/api/cloud/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        inviteToken: batch.data.invitations[0].inviteToken,
        email: 'batch-one@example.com',
        name: 'Batch One',
        password: 'password',
      }),
      expectStatus: 400,
    });
    const member = await request(server.baseUrl, '/api/cloud/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        inviteToken: batch.data.invitations[0].inviteToken,
        email: 'batch-one@example.com',
        name: 'Batch One',
        password: 'password123',
      }),
    });
    assert.equal(member.data.user.email, 'batch-one@example.com');
    assert.equal(member.data.member.role, 'member');
    await request(server.baseUrl, `/api/cloud/auth/invitation-status?token=${encodeURIComponent(batch.data.invitations[0].inviteToken)}`, {
      expectStatus: 409,
    });
    await request(server.baseUrl, '/api/cloud/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        inviteToken: batch.data.invitations[0].inviteToken,
        email: 'batch-one@example.com',
        name: 'Batch One Again',
        password: 'password123',
      }),
      expectStatus: 409,
    });

    const reset = await request(server.baseUrl, '/api/cloud/password-resets', {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ memberId: member.data.member.id }),
    });
    assert.equal(reset.data.email, 'batch-one@example.com');
    assert.match(reset.data.resetToken, /^mc_reset_/);
    assert.match(reset.data.resetUrl, /\/reset-password\?token=/);
    await request(server.baseUrl, '/api/state', { cookie: member.cookie, expectStatus: 401 });
    await request(server.baseUrl, '/api/cloud/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'batch-one@example.com', password: 'password123' }),
      expectStatus: 401,
    });

    const resetStatus = await request(server.baseUrl, `/api/cloud/auth/reset-status?token=${encodeURIComponent(reset.data.resetToken)}`);
    assert.equal(resetStatus.data.reset.email, 'batch-one@example.com');
    await request(server.baseUrl, '/api/cloud/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ resetToken: reset.data.resetToken, password: 'password' }),
      expectStatus: 400,
    });
    const resetLogin = await request(server.baseUrl, '/api/cloud/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ resetToken: reset.data.resetToken, password: 'newpass123' }),
    });
    assert.equal(resetLogin.data.user.email, 'batch-one@example.com');
    assert.match(resetLogin.cookie, /magclaw_session=/);
    await request(server.baseUrl, '/api/cloud/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ resetToken: reset.data.resetToken, password: 'again123' }),
      expectStatus: 410,
    });
    const newLogin = await request(server.baseUrl, '/api/cloud/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'batch-one@example.com', password: 'newpass123' }),
    });
    assert.equal(newLogin.data.user.email, 'batch-one@example.com');
  } finally {
    await server.stop();
  }
});
