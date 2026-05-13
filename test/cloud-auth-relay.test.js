import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, readFile, access } from 'node:fs/promises';
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
      MAGCLAW_CONFIG_FILE: path.join(tmp, '.magclaw', 'server.yaml'),
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

async function launchExpectingExit(extraEnv = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-cloud-exit-'));
  await mkdir(path.join(tmp, 'public'), { recursive: true });
  await cp(path.join(ROOT, 'server'), path.join(tmp, 'server'), { recursive: true });
  await cp(path.join(ROOT, 'public', 'index.html'), path.join(tmp, 'public', 'index.html'));
  const port = nextTestPort++;
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: tmp,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      CODEX_PATH: '/bin/false',
      MAGCLAW_DATA_DIR: path.join(tmp, '.magclaw'),
      MAGCLAW_CONFIG_FILE: path.join(tmp, '.magclaw', 'server.yaml'),
      MAGCLAW_DATABASE_URL: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGINT');
      resolve(null);
    }, 1500);
    child.once('exit', (exitCode) => {
      clearTimeout(timer);
      resolve(exitCode);
    });
  });
  await rm(tmp, { recursive: true, force: true });
  return { code, output };
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

async function registerOwnerServer(server, options = {}) {
  const {
    name = 'Admin',
    email = 'admin@example.com',
    password = 'password123',
    serverName = 'Admin Team',
    slug = 'admin-team',
  } = options;
  const account = await request(server.baseUrl, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name, email, password }),
  });
  const created = await request(server.baseUrl, '/api/console/servers', {
    method: 'POST',
    cookie: account.cookie,
    body: JSON.stringify({ name: serverName, slug }),
  });
  return {
    account,
    cookie: account.cookie,
    server: created.data.server,
    member: created.data.member,
  };
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

test('cloud deployment falls back to local state without PostgreSQL by default', async () => {
  const server = await startIsolatedServer({ MAGCLAW_DEPLOYMENT: 'cloud' });
  try {
    const status = await request(server.baseUrl, '/api/cloud/auth/status');
    assert.equal(status.data.auth.storageBackend, 'state');
    const ready = await request(server.baseUrl, '/api/readyz');
    assert.equal(ready.data.ok, true);
    assert.equal(ready.data.storage.postgres.required, false);
    assert.equal(ready.data.storage.postgres.backend, 'state');
  } finally {
    await server.stop();
  }
});

test('cloud deployment can require PostgreSQL explicitly', async () => {
  const result = await launchExpectingExit({ MAGCLAW_DEPLOYMENT: 'cloud', MAGCLAW_REQUIRE_POSTGRES: '1' });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /MAGCLAW_DATABASE_URL is required/);
});

test('cloud health and readiness expose K8s-friendly storage checks', async () => {
  const uploadDir = await mkdtemp(path.join(os.tmpdir(), 'magclaw-upload-pvc-'));
  const server = await startIsolatedServer({
    MAGCLAW_UPLOAD_DIR: uploadDir,
    MAGCLAW_ATTACHMENT_STORAGE: 'pvc',
  });
  try {
    const health = await request(server.baseUrl, '/api/healthz');
    assert.equal(health.data.ok, true);
    assert.equal(health.data.service, 'magclaw-web');
    const ready = await request(server.baseUrl, '/api/readyz');
    assert.equal(ready.data.ok, true);
    assert.equal(ready.data.storage.attachments.mode, 'pvc');
    assert.equal(ready.data.storage.attachments.writable, true);
  } finally {
    await server.stop();
    await rm(uploadDir, { recursive: true, force: true });
  }
});

test('server profile and join links are managed through cloud APIs', async () => {
  const server = await startIsolatedServer();
  try {
    const owner = await registerOwnerServer(server);
    const cookie = owner.cookie;

    const profile = await request(server.baseUrl, '/api/cloud/server/profile', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({
        name: 'Renamed Server',
        avatar: 'data:image/png;base64,ZmFrZQ==',
        onboardingAgentId: 'agt_codex',
        newAgentGreetingEnabled: false,
      }),
    });
    assert.equal(profile.data.workspace.name, 'Renamed Server');
    assert.equal(profile.data.workspace.avatar, 'data:image/png;base64,ZmFrZQ==');
    assert.equal(profile.data.workspace.onboardingAgentId, 'agt_codex');
    assert.equal(profile.data.workspace.newAgentGreetingEnabled, false);

    const created = await request(server.baseUrl, '/api/console/servers', {
      method: 'POST',
      cookie,
      body: JSON.stringify({ name: 'Second Server', slug: 'second-server' }),
    });
    await request(server.baseUrl, '/api/cloud/server/profile', {
      method: 'PATCH',
      cookie,
      body: JSON.stringify({
        workspaceSlug: 'second-server',
        name: 'Second Renamed',
        avatar: 'data:image/png;base64,c2Vjb25k',
      }),
    });
    const switched = await request(server.baseUrl, `/api/console/servers/${created.data.server.slug}/switch`, {
      method: 'POST',
      cookie,
      body: '{}',
    });
    assert.equal(switched.data.server.name, 'Second Renamed');
    assert.equal(switched.data.server.avatar, 'data:image/png;base64,c2Vjb25k');
    await request(server.baseUrl, `/api/console/servers/${owner.server.slug}/switch`, {
      method: 'POST',
      cookie,
      body: '{}',
    });
    const originalState = await request(server.baseUrl, '/api/state', { cookie });
    assert.equal(originalState.data.cloud.workspace.name, 'Renamed Server');
    assert.equal(originalState.data.cloud.workspace.avatar, 'data:image/png;base64,ZmFrZQ==');

    const link = await request(server.baseUrl, '/api/cloud/join-links', {
      method: 'POST',
      cookie,
      body: JSON.stringify({
        maxUses: 3,
        expiresAt: '2035-01-01T00:00:00.000Z',
      }),
    });
    assert.equal(link.status, 201);
    assert.match(link.data.joinLink.url, /\/join\/mc_join_/);
    assert.equal(link.data.joinLink.maxUses, 3);
    assert.equal(link.data.joinLink.usedCount, 0);

    const state = await request(server.baseUrl, '/api/state', { cookie });
    assert.equal(state.data.cloud.workspace.name, 'Renamed Server');
    assert.equal(state.data.cloud.workspace.avatar, 'data:image/png;base64,ZmFrZQ==');
    assert.equal(state.data.cloud.joinLinks.length, 1);

    const revoked = await request(server.baseUrl, `/api/cloud/join-links/${encodeURIComponent(link.data.joinLink.id)}/revoke`, {
      method: 'POST',
      cookie,
      body: '{}',
    });
    assert.ok(revoked.data.joinLink.revokedAt);
  } finally {
    await server.stop();
  }
});

test('public account registration and password reset use SMTP outbox without invite', async () => {
  const outbox = path.join(await mkdtemp(path.join(os.tmpdir(), 'magclaw-mail-')), 'outbox.jsonl');
  const server = await startIsolatedServer({
    MAGCLAW_MAIL_TRANSPORT: 'file',
    MAGCLAW_MAIL_OUTBOX: outbox,
    MAGCLAW_MAIL_FROM: 'MagClaw <noreply@example.com>',
    MAGCLAW_PUBLIC_URL: 'https://cloud.magclaw.example',
  });
  try {
    const created = await request(server.baseUrl, '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Free User',
        email: 'free@example.com',
        password: 'password123',
      }),
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.user.email, 'free@example.com');
    assert.equal(created.data.member, null);
    assert.match(created.cookie, /magclaw_session=/);

    const serverCreated = await request(server.baseUrl, '/api/console/servers', {
      method: 'POST',
      cookie: created.cookie,
      body: JSON.stringify({ name: 'Free Team', slug: 'free-team' }),
    });
    assert.equal(serverCreated.status, 201);
    assert.equal(serverCreated.data.server.name, 'Free Team');
    assert.equal(serverCreated.data.server.slug, 'free-team');
    assert.equal(serverCreated.data.member.role, 'admin');
    const firstServerComputer = await request(server.baseUrl, '/api/computers', {
      method: 'POST',
      cookie: created.cookie,
      body: JSON.stringify({ name: 'Free Team computer' }),
    });
    assert.equal(firstServerComputer.status, 201);
    assert.equal(firstServerComputer.data.computer.workspaceId, serverCreated.data.server.id);
    const duplicateServer = await request(server.baseUrl, '/api/console/servers', {
      method: 'POST',
      cookie: created.cookie,
      body: JSON.stringify({ name: 'Duplicate Team', slug: 'free-team' }),
      expectStatus: 409,
    });
    assert.equal(duplicateServer.data.error, 'Server slug is already taken.');
    const shortSlug = await request(server.baseUrl, '/api/console/servers', {
      method: 'POST',
      cookie: created.cookie,
      body: JSON.stringify({ name: 'Short Team', slug: 'abcd' }),
      expectStatus: 400,
    });
    assert.equal(shortSlug.data.error, 'Server slug must be 5-63 lowercase letters, numbers, or hyphens.');
    const secondServer = await request(server.baseUrl, '/api/console/servers', {
      method: 'POST',
      cookie: created.cookie,
      body: JSON.stringify({ name: 'Second Team', slug: 'second-team' }),
    });
    assert.equal(secondServer.status, 201);
    const scopedState = await request(server.baseUrl, '/api/state', { cookie: created.cookie });
    assert.equal(scopedState.data.cloud.workspace.slug, 'second-team');
    assert.equal(
      scopedState.data.computers.some((computer) => computer.id === firstServerComputer.data.computer.id),
      false,
    );
    assert.deepEqual(scopedState.data.cloud.members.map((member) => member.workspaceId), [secondServer.data.server.id]);

    await request(server.baseUrl, `/api/console/servers/${serverCreated.data.server.slug}/switch`, {
      method: 'POST',
      cookie: created.cookie,
      body: '{}',
    });
    const firstServerState = await request(server.baseUrl, '/api/state', { cookie: created.cookie });
    assert.equal(
      firstServerState.data.computers.some((computer) => computer.id === firstServerComputer.data.computer.id),
      true,
    );

    const forgot = await request(server.baseUrl, '/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email: 'free@example.com' }),
    });
    assert.equal(forgot.data.ok, true);
    assert.equal(forgot.data.sent, true);
    await access(outbox);
    const lines = (await readFile(outbox, 'utf8')).trim().split('\n');
    const message = JSON.parse(lines.at(-1));
    assert.equal(message.to, 'free@example.com');
    assert.match(message.html, /https:\/\/cloud\.magclaw\.example\/reset-password\?token=mc_reset_/);
    assert.match(message.html, /https:\/\/cloud\.magclaw\.example\/brand\/magclaw-logo\.png/);
    assert.match(message.html, /background:#ff66cc/);
    assert.doesNotMatch(message.html, /#ffd743|#FFD800|--magclaw-sun/i);
  } finally {
    await server.stop();
    await rm(path.dirname(outbox), { recursive: true, force: true });
  }
});

test('console invitations stay repeatable and resolve per logged-in user', async () => {
  const server = await startIsolatedServer();
  try {
    const owner = await request(server.baseUrl, '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Owner',
        email: 'owner@example.com',
        password: 'password123',
      }),
    });
    await request(server.baseUrl, '/api/console/servers', {
      method: 'POST',
      cookie: owner.cookie,
      body: JSON.stringify({ name: 'Owner Team', slug: 'owner-team' }),
    });
    const first = await request(server.baseUrl, '/api/cloud/invitations', {
      method: 'POST',
      cookie: owner.cookie,
      body: JSON.stringify({ email: 'console-user@example.com', role: 'member' }),
    });
    const second = await request(server.baseUrl, '/api/cloud/invitations', {
      method: 'POST',
      cookie: owner.cookie,
      body: JSON.stringify({ email: 'console-user@example.com', role: 'admin' }),
    });
    assert.notEqual(first.data.invitation.id, second.data.invitation.id);
    await request(server.baseUrl, `/api/cloud/auth/invitation-status?token=${encodeURIComponent(first.data.inviteToken)}`);

    const user = await request(server.baseUrl, '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Console User',
        email: 'console-user@example.com',
        password: 'password123',
      }),
    });
    const consoleState = await request(server.baseUrl, '/api/state', { cookie: user.cookie });
    assert.equal(consoleState.data.channels.length, 0);
    assert.equal(consoleState.data.cloud.myInvitations.length, 2);
    assert.equal(consoleState.data.cloud.auth.currentMember, null);

    const declined = await request(server.baseUrl, `/api/console/invitations/${first.data.invitation.id}/decline`, {
      method: 'POST',
      cookie: user.cookie,
      body: '{}',
    });
    assert.equal(declined.data.invitation.status, 'declined');
    await request(server.baseUrl, `/api/console/invitations/${first.data.invitation.id}/accept`, {
      method: 'POST',
      cookie: user.cookie,
      body: '{}',
      expectStatus: 409,
    });

    const accepted = await request(server.baseUrl, `/api/console/invitations/${second.data.invitation.id}/accept`, {
      method: 'POST',
      cookie: user.cookie,
      body: '{}',
    });
    assert.equal(accepted.data.invitation.status, 'accepted');
    assert.equal(accepted.data.member.role, 'admin');
    assert.ok(accepted.data.cloud.auth.currentMember);
  } finally {
    await server.stop();
  }
});

test('owner registration protects app APIs and supports invites end to end', async () => {
  const server = await startIsolatedServer();
  let daemon = null;
  try {
    const initial = await request(server.baseUrl, '/api/cloud/auth/status');
    assert.equal(initial.data.auth.initialized, false);
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

    const owner = await registerOwnerServer(server);

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
    assert.ok(adminApis.data.endpoints.some((item) => item.method === 'POST' && item.path === '/api/cloud/invitations' && item.role === 'admin'));
    assert.ok(adminApis.data.endpoints.some((item) => item.method === 'POST' && item.path === '/api/cloud/invitations/batch' && item.role === 'admin'));
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
    assert.equal(owner.member.role, 'admin');
    assert.match(adminCookie, /magclaw_session=/);

    const adminState = await request(server.baseUrl, '/api/state', { cookie: adminCookie });
    assert.equal(adminState.data.cloud.auth.currentUser.email, 'admin@example.com');
    assert.equal(adminState.data.cloud.auth.currentUser.language, 'en');
    assert.equal(adminState.data.cloud.auth.currentMember.role, 'admin');
    assert.equal(adminState.data.cloud.auth.sessionTtlMs, 1000 * 60 * 60 * 24 * 14);
    assert.match(adminState.data.cloud.auth.sessionExpiresAt, /^\d{4}-\d{2}-\d{2}T/);
    const adminPreferences = await request(server.baseUrl, '/api/cloud/auth/preferences', {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ language: 'zh-CN' }),
    });
    assert.equal(adminPreferences.data.user.language, 'zh-CN');
    assert.equal(adminPreferences.data.cloud.auth.currentUser.language, 'zh-CN');
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

    await request(server.baseUrl, '/api/cloud/invitations', {
      method: 'POST',
      cookie: memberCookie,
      body: JSON.stringify({ email: 'another@example.com', role: 'member' }),
      expectStatus: 403,
    });
    await request(server.baseUrl, '/api/settings', {
      method: 'POST',
      cookie: memberCookie,
      body: JSON.stringify({ model: 'member-probe' }),
      expectStatus: 403,
    });
    const memberState = await request(server.baseUrl, '/api/state', { cookie: memberCookie });
    assert.equal(memberState.data.cloud.auth.currentUser.email, 'member@example.com');
    assert.equal(memberState.data.cloud.auth.capabilities.chat_channels, true);
    assert.equal(memberState.data.cloud.auth.capabilities.chat_agent_dm, true);
    assert.equal(memberState.data.cloud.auth.capabilities.warm_agents, true);
    assert.equal(memberState.data.cloud.auth.capabilities.manage_agents, false);
    assert.equal(memberState.data.cloud.auth.capabilities.manage_computers, false);
    assert.equal(memberState.data.cloud.auth.capabilities.pair_computers, false);
    assert.ok(memberState.data.humans.some((human) => human.id === member.data.member.humanId && human.status === 'online'));
    assert.equal(memberState.data.dms.some((dm) => dm.id === 'dm_codex'), false);

    const memberMessage = await request(server.baseUrl, '/api/spaces/channel/chan_all/messages', {
      method: 'POST',
      cookie: memberCookie,
      body: JSON.stringify({ body: 'Member can chat in #all.' }),
    });
    assert.equal(memberMessage.status, 201);
    assert.equal(memberMessage.data.message.authorId, member.data.member.humanId);
    assert.deepEqual(memberMessage.data.message.readBy, [member.data.member.humanId]);
    const memberReply = await request(server.baseUrl, `/api/messages/${memberMessage.data.message.id}/replies`, {
      method: 'POST',
      cookie: memberCookie,
      body: JSON.stringify({ body: 'Member can reply in a thread.' }),
    });
    assert.equal(memberReply.status, 201);
    assert.equal(memberReply.data.reply.authorId, member.data.member.humanId);
    await request(server.baseUrl, '/api/spaces/dm/dm_codex/messages', {
      method: 'POST',
      cookie: memberCookie,
      body: JSON.stringify({ body: 'Member cannot write to someone else DM.' }),
      expectStatus: 403,
    });
    const memberDm = await request(server.baseUrl, '/api/dms', {
      method: 'POST',
      cookie: memberCookie,
      body: JSON.stringify({ participantId: 'agt_codex' }),
    });
    assert.ok(memberDm.data.dm.participantIds.includes(member.data.member.humanId));
    assert.ok(memberDm.data.dm.participantIds.includes('agt_codex'));
    const memberDmMessage = await request(server.baseUrl, `/api/spaces/dm/${memberDm.data.dm.id}/messages`, {
      method: 'POST',
      cookie: memberCookie,
      body: JSON.stringify({ body: 'Member can DM an agent.' }),
    });
    assert.equal(memberDmMessage.status, 201);
    assert.equal(memberDmMessage.data.message.authorId, member.data.member.humanId);
    const memberDmState = await request(server.baseUrl, '/api/state', { cookie: memberCookie });
    assert.ok(memberDmState.data.dms.some((dm) => dm.id === memberDm.data.dm.id));
    assert.equal(memberDmState.data.dms.some((dm) => dm.id === 'dm_codex'), false);
    assert.ok(memberDmState.data.messages.some((message) => message.id === memberDmMessage.data.message.id));
    assert.equal(memberDmState.data.messages.some((message) => message.spaceId === 'dm_codex'), false);
    const memberWarmMissingAgent = await request(server.baseUrl, '/api/agents/missing-agent/warm', {
      method: 'POST',
      cookie: memberCookie,
      body: JSON.stringify({ spaceType: 'channel', spaceId: 'chan_all' }),
      expectStatus: 404,
    });
    assert.equal(memberWarmMissingAgent.data.error, 'Agent not found.');
    await request(server.baseUrl, '/api/agents', {
      method: 'POST',
      cookie: memberCookie,
      body: JSON.stringify({ name: 'Member-created Agent' }),
      expectStatus: 403,
    });
    await request(server.baseUrl, '/api/computers', {
      method: 'POST',
      cookie: memberCookie,
      body: JSON.stringify({ name: 'Member computer' }),
      expectStatus: 403,
    });

    const pairing = await request(server.baseUrl, '/api/cloud/computers/pairing-tokens', {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ name: 'CI runner' }),
    });
    assert.match(pairing.data.pairToken, /^mc_pair_/);
    assert.match(pairing.data.command, /MAGCLAW_REPO_DIR="\/path\/to\/magclaw"; node "\$MAGCLAW_REPO_DIR\/daemon\/bin\/magclaw-daemon\.js" connect/);
    assert.doesNotMatch(pairing.data.command, /--background/);
    assert.match(pairing.data.command, /--profile "?admin-team"?/);
    assert.match(pairing.data.command, /# Admin Team/);
    assert.equal(pairing.data.provisional, true);
    assert.equal(pairing.data.displayName, 'CI runner');
    const prePairState = await request(server.baseUrl, '/api/state', { cookie: adminCookie });
    const pendingComputer = prePairState.data.computers.find((item) => item.id === pairing.data.computer.id);
    assert.equal(pendingComputer?.status, 'pairing');
    assert.equal(pendingComputer?.connectedVia, 'daemon');
    assert.equal(pendingComputer?.name, 'CI runner');

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
    await request(server.baseUrl, '/api/agent-tools/history?agentId=agt_codex', {
      expectStatus: 401,
    });
    const daemonHistory = await request(server.baseUrl, '/api/agent-tools/history?agentId=agt_codex', {
      headers: { authorization: `Bearer ${saved.token}` },
    });
    assert.equal(daemonHistory.data.ok, true);
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

test('cloud pairing command can use the domain-friendly npm daemon launcher', async () => {
  const server = await startIsolatedServer({
    MAGCLAW_DAEMON_COMMAND_MODE: 'npm',
    MAGCLAW_PUBLIC_URL: 'https://magclaw.example.test',
  });
  try {
    const admin = await registerOwnerServer(server);
    const pairing = await request(server.baseUrl, '/api/cloud/computers/pairing-tokens', {
      method: 'POST',
      cookie: admin.cookie,
      body: JSON.stringify({ name: 'Cloud runner' }),
    });
    assert.match(pairing.data.command, /^npx -y @magclaw\/daemon@latest connect /);
    assert.match(pairing.data.command, /--server-url "?https:\/\/magclaw\.example\.test"?/);
    assert.doesNotMatch(pairing.data.command, /MAGCLAW_REPO_DIR/);
    assert.equal(pairing.data.displayName, 'Cloud runner');
  } finally {
    await server.stop();
  }
});

test('cloud pairing command carries the requested computer display name', async () => {
  const server = await startIsolatedServer({
    MAGCLAW_DAEMON_COMMAND_MODE: 'npm',
    MAGCLAW_PUBLIC_URL: 'https://magclaw.example.test',
  });
  try {
    const admin = await registerOwnerServer(server);
    const pairing = await request(server.baseUrl, '/api/cloud/computers/pairing-tokens', {
      method: 'POST',
      cookie: admin.cookie,
      body: JSON.stringify({ displayName: 'Studio Mac' }),
    });
    assert.equal(pairing.data.displayName, 'Studio Mac');
    assert.equal(pairing.data.computer.name, 'Studio Mac');
    assert.match(pairing.data.command, /--display-name "?Studio Mac"?/);
  } finally {
    await server.stop();
  }
});

test('cloud roles enforce admin invite and removal boundaries', async () => {
  const server = await startIsolatedServer();
  try {
    const admin = await registerOwnerServer(server);
    const adminCookie = admin.cookie;

    const delegatedAdminInvite = await request(server.baseUrl, '/api/cloud/invitations', {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ email: 'delegated-admin@example.com', role: 'admin' }),
    });
    const delegatedAdmin = await request(server.baseUrl, '/api/cloud/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        inviteToken: delegatedAdminInvite.data.inviteToken,
        email: 'delegated-admin@example.com',
        name: 'Delegated Admin',
        password: 'password123',
      }),
    });
    assert.equal(delegatedAdmin.data.member.role, 'admin');
    assert.match(delegatedAdmin.data.user.id, /^usr_\d{8}$/);
    const delegatedAdminCookie = delegatedAdmin.cookie;

    const secondAdminInvite = await request(server.baseUrl, '/api/cloud/invitations', {
      method: 'POST',
      cookie: delegatedAdminCookie,
      body: JSON.stringify({ email: 'second-admin@example.com', role: 'admin' }),
    });
    assert.equal(secondAdminInvite.data.invitation.role, 'admin');
    const secondAdmin = await request(server.baseUrl, '/api/cloud/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        inviteToken: secondAdminInvite.data.inviteToken,
        email: 'second-admin@example.com',
        name: 'Second Admin',
        password: 'password123',
      }),
    });
    await request(server.baseUrl, `/api/cloud/members/${admin.member.id}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ role: 'member' }),
      expectStatus: 403,
    });
    const memberInvite = await request(server.baseUrl, '/api/cloud/invitations', {
      method: 'POST',
      cookie: delegatedAdminCookie,
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

    const adminPromotesMember = await request(server.baseUrl, `/api/cloud/members/${member.data.member.id}`, {
      method: 'PATCH',
      cookie: delegatedAdminCookie,
      body: JSON.stringify({ role: 'admin' }),
    });
    assert.equal(adminPromotesMember.data.member.role, 'admin');
    const adminDemotesMember = await request(server.baseUrl, `/api/cloud/members/${member.data.member.id}`, {
      method: 'PATCH',
      cookie: adminCookie,
      body: JSON.stringify({ role: 'member' }),
    });
    assert.equal(adminDemotesMember.data.member.role, 'member');
    await request(server.baseUrl, `/api/cloud/members/${delegatedAdmin.data.member.id}`, {
      method: 'PATCH',
      cookie: memberCookie,
      body: JSON.stringify({ role: 'member' }),
      expectStatus: 403,
    });

    await request(server.baseUrl, '/api/cloud/invitations', {
      method: 'POST',
      cookie: memberCookie,
      body: JSON.stringify({ email: 'friend@example.com', role: 'member' }),
      expectStatus: 403,
    });
    await request(server.baseUrl, '/api/cloud/invitations', {
      method: 'POST',
      cookie: memberCookie,
      body: JSON.stringify({ email: 'bad-admin@example.com', role: 'admin' }),
      expectStatus: 403,
    });

    const computer = await request(server.baseUrl, '/api/computers', {
      method: 'POST',
      cookie: delegatedAdminCookie,
      body: JSON.stringify({ name: 'Admin runner' }),
    });
    assert.equal(computer.data.computer.name, 'Admin runner');
    await request(server.baseUrl, '/api/computers', {
      method: 'POST',
      cookie: memberCookie,
      body: JSON.stringify({ name: 'Member runner' }),
      expectStatus: 403,
    });
    await request(server.baseUrl, '/api/settings', {
      method: 'POST',
      cookie: delegatedAdminCookie,
      body: JSON.stringify({ model: 'admin-probe' }),
    });

    const removed = await request(server.baseUrl, `/api/cloud/members/${member.data.member.id}`, {
      method: 'DELETE',
      cookie: delegatedAdminCookie,
      body: JSON.stringify({}),
    });
    assert.equal(removed.data.member.status, 'removed');
    await request(server.baseUrl, '/api/cloud/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'member@example.com', password: 'password123' }),
      expectStatus: 401,
    });

    const removedAdmin = await request(server.baseUrl, `/api/cloud/members/${secondAdmin.data.member.id}`, {
      method: 'DELETE',
      cookie: delegatedAdminCookie,
      body: JSON.stringify({}),
    });
    assert.equal(removedAdmin.data.member.status, 'removed');

    const reinvite = await request(server.baseUrl, '/api/cloud/invitations', {
      method: 'POST',
      cookie: delegatedAdminCookie,
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
  const server = await startIsolatedServer();
  try {
    const admin = await registerOwnerServer(server);
    const adminCookie = admin.cookie;

    const batch = await request(server.baseUrl, '/api/cloud/invitations/batch', {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ emails: ['batch-one@example.com', 'batch-two@example.com'], role: 'member' }),
    });
    assert.equal(batch.data.invitations.length, 2);
    assert.deepEqual(batch.data.invitations.map((item) => item.email), ['batch-one@example.com', 'batch-two@example.com']);
    assert.ok(batch.data.invitations.every((item) => item.inviteToken?.startsWith('mc_inv_')));
    assert.ok(batch.data.invitations.every((item) => item.inviteUrl?.includes('/activate?email=')));
    const refreshedInvite = await request(server.baseUrl, '/api/cloud/invitations', {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ email: 'batch-two@example.com', role: 'member' }),
    });
    assert.match(refreshedInvite.data.inviteToken, /^mc_inv_/);
    assert.notEqual(refreshedInvite.data.inviteToken, batch.data.invitations[1].inviteToken);
    assert.notEqual(refreshedInvite.data.inviteUrl, batch.data.invitations[1].inviteUrl);
    const olderInviteStatus = await request(server.baseUrl, `/api/cloud/auth/invitation-status?token=${encodeURIComponent(batch.data.invitations[1].inviteToken)}`);
    assert.equal(olderInviteStatus.data.invitation.email, 'batch-two@example.com');
    const refreshedInviteStatus = await request(server.baseUrl, `/api/cloud/auth/invitation-status?token=${encodeURIComponent(refreshedInvite.data.inviteToken)}`);
    assert.equal(refreshedInviteStatus.data.invitation.email, 'batch-two@example.com');
    const browserOriginInvite = await request(server.baseUrl, '/api/cloud/invitations', {
      method: 'POST',
      cookie: adminCookie,
      headers: { origin: 'https://cloud.magclaw.example' },
      body: JSON.stringify({ email: 'browser-origin@example.com', role: 'member' }),
    });
    assert.match(browserOriginInvite.data.inviteUrl, /^https:\/\/cloud\.magclaw\.example\/activate\?email=browser-origin%40example\.com&token=mc_inv_/);
    await request(server.baseUrl, '/api/cloud/invitations/batch', {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ emails: ['bad-role@example.com'], role: 'superadmin' }),
      expectStatus: 403,
    });

    const inviteStatus = await request(server.baseUrl, `/api/cloud/auth/invitation-status?token=${encodeURIComponent(batch.data.invitations[0].inviteToken)}`);
    assert.equal(inviteStatus.data.invitation.email, 'batch-one@example.com');
    assert.equal(inviteStatus.data.invitation.role, 'member');
    assert.equal(inviteStatus.data.invitation.status, 'pending');

    const tamperInvite = await request(server.baseUrl, '/api/cloud/invitations', {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ email: 'tamper@example.com', role: 'member' }),
    });
    const changedEmail = await request(server.baseUrl, '/api/cloud/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        inviteToken: tamperInvite.data.inviteToken,
        email: 'changed@example.com',
        name: 'Changed Email',
        password: 'password123',
      }),
      expectStatus: 400,
    });
    assert.equal(changedEmail.data.error, 'Email must match the invitation.');
    const changedRole = await request(server.baseUrl, '/api/cloud/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        inviteToken: tamperInvite.data.inviteToken,
        role: 'admin',
        name: 'Changed Role',
        password: 'password123',
      }),
      expectStatus: 400,
    });
    assert.equal(changedRole.data.error, 'Role is controlled by the invitation.');
    const tamperMember = await request(server.baseUrl, '/api/cloud/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        inviteToken: tamperInvite.data.inviteToken,
        name: 'Tamper Member',
        password: 'password123',
      }),
    });
    assert.equal(tamperMember.data.user.email, 'tamper@example.com');
    assert.equal(tamperMember.data.member.role, 'member');

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
    const registeredInvite = await request(server.baseUrl, '/api/cloud/invitations', {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ email: 'batch-one@example.com', role: 'member' }),
    });
    assert.match(registeredInvite.data.inviteToken, /^mc_inv_/);
    assert.notEqual(registeredInvite.data.inviteToken, batch.data.invitations[0].inviteToken);
    assert.match(registeredInvite.data.inviteUrl, /\/activate\?email=batch-one%40example\.com&token=mc_inv_/);
    const registeredInviteStatus = await request(server.baseUrl, `/api/cloud/auth/invitation-status?token=${encodeURIComponent(registeredInvite.data.inviteToken)}`, {
      expectStatus: 409,
    });
    assert.equal(registeredInviteStatus.data.error, 'User already exists.');

    const reset = await request(server.baseUrl, '/api/cloud/password-resets', {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ memberId: member.data.member.id }),
    });
    assert.equal(reset.data.email, 'batch-one@example.com');
    assert.match(reset.data.resetToken, /^mc_reset_/);
    assert.match(reset.data.resetUrl, /\/reset-password\?token=/);
    const refreshedReset = await request(server.baseUrl, '/api/cloud/password-resets', {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ memberId: member.data.member.id }),
    });
    assert.match(refreshedReset.data.resetToken, /^mc_reset_/);
    assert.notEqual(refreshedReset.data.resetToken, reset.data.resetToken);
    assert.notEqual(refreshedReset.data.resetUrl, reset.data.resetUrl);
    await request(server.baseUrl, `/api/cloud/auth/reset-status?token=${encodeURIComponent(reset.data.resetToken)}`, {
      expectStatus: 410,
    });
    await request(server.baseUrl, '/api/state', { cookie: member.cookie, expectStatus: 401 });
    await request(server.baseUrl, '/api/cloud/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'batch-one@example.com', password: 'password123' }),
      expectStatus: 401,
    });

    const resetStatus = await request(server.baseUrl, `/api/cloud/auth/reset-status?token=${encodeURIComponent(refreshedReset.data.resetToken)}`);
    assert.equal(resetStatus.data.reset.email, 'batch-one@example.com');
    await request(server.baseUrl, '/api/cloud/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ resetToken: refreshedReset.data.resetToken, password: 'password' }),
      expectStatus: 400,
    });
    const resetLogin = await request(server.baseUrl, '/api/cloud/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ resetToken: refreshedReset.data.resetToken, password: 'newpass123' }),
    });
    assert.equal(resetLogin.data.user.email, 'batch-one@example.com');
    assert.match(resetLogin.cookie, /magclaw_session=/);
    await request(server.baseUrl, '/api/cloud/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ resetToken: refreshedReset.data.resetToken, password: 'again123' }),
      expectStatus: 410,
    });
    const newLogin = await request(server.baseUrl, '/api/cloud/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'batch-one@example.com', password: 'newpass123' }),
    });
    assert.equal(newLogin.data.user.email, 'batch-one@example.com');
    const resetAfterUse = await request(server.baseUrl, '/api/cloud/password-resets', {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ memberId: member.data.member.id }),
    });
    assert.match(resetAfterUse.data.resetToken, /^mc_reset_/);
    assert.notEqual(resetAfterUse.data.resetToken, refreshedReset.data.resetToken);
  } finally {
    await server.stop();
  }
});
