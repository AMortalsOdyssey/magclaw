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

test('environment owner login protects app APIs and supports invites end to end', async () => {
  const server = await startIsolatedServer({
    MAGCLAW_OWNER_NAME: 'Owner',
    MAGCLAW_OWNER_EMAIL: 'owner@example.com',
    MAGCLAW_OWNER_PASSWORD: 'password123',
  });
  let daemon = null;
  try {
    const initial = await request(server.baseUrl, '/api/cloud/auth/status');
    assert.equal(initial.data.auth.initialized, true);
    assert.equal(initial.data.auth.ownerConfigured, true);
    assert.equal(initial.data.auth.currentUser, null);

    await request(server.baseUrl, '/api/cloud/auth/bootstrap-owner', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Web Owner',
        email: 'web-owner@example.com',
        password: 'password123',
      }),
      expectStatus: 410,
    });

    await request(server.baseUrl, '/api/state', { expectStatus: 401 });
    await request(server.baseUrl, '/api/settings', {
      method: 'POST',
      body: JSON.stringify({ model: 'anonymous-probe' }),
      expectStatus: 401,
    });

    const owner = await request(server.baseUrl, '/api/cloud/auth/login', {
      method: 'POST',
      body: JSON.stringify({
        email: 'owner@example.com',
        password: 'password123',
      }),
    });
    assert.equal(owner.data.user.email, 'owner@example.com');
    assert.equal(owner.data.member.role, 'owner');
    const ownerCookie = owner.cookie;
    assert.match(ownerCookie, /magclaw_session=/);

    const ownerState = await request(server.baseUrl, '/api/state', { cookie: ownerCookie });
    assert.equal(ownerState.data.cloud.auth.currentUser.email, 'owner@example.com');
    const ownerSettings = await request(server.baseUrl, '/api/settings', {
      method: 'POST',
      cookie: ownerCookie,
      body: JSON.stringify({ model: 'owner-model' }),
    });
    assert.equal(ownerSettings.status, 200);

    const invite = await request(server.baseUrl, '/api/cloud/invitations', {
      method: 'POST',
      cookie: ownerCookie,
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

    const pairing = await request(server.baseUrl, '/api/cloud/computers/pairing-tokens', {
      method: 'POST',
      cookie: ownerCookie,
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
      const snapshot = (await request(server.baseUrl, '/api/state', { cookie: ownerCookie })).data;
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
