import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Client } from 'pg';
import {
  databaseUrlWithName,
  normalizeDatabaseUrl,
  quoteIdent,
} from '../server/cloud/postgres.js';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const TEST_DATABASE_URL = normalizeDatabaseUrl(process.env.MAGCLAW_TEST_DATABASE_URL || '');
const TEST_DATABASE = process.env.MAGCLAW_TEST_DATABASE || 'magclaw_cloud';
let nextTestPort = 7200 + Math.floor(Math.random() * 300);

async function dropSchema(schema) {
  if (!TEST_DATABASE_URL) return;
  const client = new Client({ connectionString: databaseUrlWithName(TEST_DATABASE_URL, TEST_DATABASE) });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
  } finally {
    await client.end();
  }
}

async function launchIsolatedServer(tmp, schema) {
  const port = nextTestPort++;
  await mkdir(path.join(tmp, 'public'), { recursive: true });
  await mkdir(path.join(tmp, 'uploads'), { recursive: true });
  await cp(path.join(ROOT, 'server'), path.join(tmp, 'server'), { recursive: true });
  await cp(path.join(ROOT, 'public', 'index.html'), path.join(tmp, 'public', 'index.html'));
  await symlink(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'), 'dir');

  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: tmp,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      CODEX_PATH: '/bin/false',
      MAGCLAW_DEPLOYMENT: 'cloud',
      MAGCLAW_DATA_DIR: path.join(tmp, '.magclaw'),
      MAGCLAW_UPLOAD_DIR: path.join(tmp, 'uploads'),
      MAGCLAW_ATTACHMENT_STORAGE: 'pvc',
      DATABASE_URL: '',
      MAGCLAW_DATABASE_URL: TEST_DATABASE_URL,
      MAGCLAW_DATABASE: TEST_DATABASE,
      MAGCLAW_DATABASE_SCHEMA: schema,
      MAGCLAW_ADMIN_NAME: 'Admin',
      MAGCLAW_ADMIN_EMAIL: 'admin@example.com',
      MAGCLAW_ADMIN_PASSWORD: 'password123',
      MAGCLAW_ALLOW_SIGNUPS: '1',
      MAGCLAW_MAIL_TRANSPORT: 'file',
      MAGCLAW_MAIL_OUTBOX: path.join(tmp, '.magclaw', 'outbox.jsonl'),
      MAGCLAW_MAIL_FROM: 'MagClaw <noreply@example.com>',
      MAGCLAW_PUBLIC_URL: 'https://pg.magclaw.example',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk.toString(); });
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  let stopped = false;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/cloud/auth/status`);
      if (response.ok) {
        return {
          baseUrl,
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

test('Postgres-backed cloud auth persists open signup and Console invitation decisions', {
  skip: TEST_DATABASE_URL ? false : 'set MAGCLAW_TEST_DATABASE_URL to run this integration test',
}, async () => {
  const schema = `magclaw_test_${Date.now()}_${process.pid}`;
  let server = null;
  let tmp = null;
  try {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-cloud-pg-'));
    server = await launchIsolatedServer(tmp, schema);
    const initial = await request(server.baseUrl, '/api/cloud/auth/status');
    assert.equal(initial.data.auth.storageBackend, 'postgres');
    assert.equal(initial.data.auth.initialized, true);

    const admin = await request(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
    });
    assert.match(admin.cookie, /magclaw_session=/);

    const firstInvite = await request(server.baseUrl, '/api/cloud/invitations', {
      method: 'POST',
      cookie: admin.cookie,
      body: JSON.stringify({ email: 'console-pg@example.com', role: 'member' }),
    });
    const secondInvite = await request(server.baseUrl, '/api/cloud/invitations', {
      method: 'POST',
      cookie: admin.cookie,
      body: JSON.stringify({ email: 'console-pg@example.com', role: 'admin' }),
    });
    assert.notEqual(firstInvite.data.invitation.id, secondInvite.data.invitation.id);
    assert.match(firstInvite.data.inviteToken, /^mc_inv_/);
    assert.match(secondInvite.data.inviteToken, /^mc_inv_/);

    const openAccount = await request(server.baseUrl, '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        email: 'console-pg@example.com',
        name: 'Console PG',
        password: 'password123',
      }),
    });
    assert.equal(openAccount.status, 201);
    assert.equal(openAccount.data.user.email, 'console-pg@example.com');
    assert.equal(openAccount.data.member, null);
    assert.equal(openAccount.data.workspace, null);
    assert.match(openAccount.cookie, /magclaw_session=/);

    const accountState = await request(server.baseUrl, '/api/state', { cookie: openAccount.cookie });
    assert.equal(accountState.data.channels.length, 0);
    assert.equal(accountState.data.cloud.myInvitations.length, 2);
    assert.equal(accountState.data.cloud.auth.currentMember, null);

    const createdServer = await request(server.baseUrl, '/api/console/servers', {
      method: 'POST',
      cookie: openAccount.cookie,
      body: JSON.stringify({ name: 'PG Team', slug: 'pg-team' }),
    });
    assert.equal(createdServer.status, 201);
    assert.equal(createdServer.data.server.slug, 'pg-team');
    assert.equal(createdServer.data.member.role, 'admin');
    await request(server.baseUrl, '/api/console/servers', {
      method: 'POST',
      cookie: openAccount.cookie,
      body: JSON.stringify({ name: 'PG Team Duplicate', slug: 'pg-team' }),
      expectStatus: 409,
    });

    await request(server.baseUrl, '/api/cloud/server/profile', {
      method: 'PATCH',
      cookie: openAccount.cookie,
      body: JSON.stringify({
        name: 'PG Team Renamed',
        avatar: 'data:image/png;base64,cGc=',
        onboardingAgentId: 'agt_codex',
        newAgentGreetingEnabled: false,
      }),
    });
    const joinLink = await request(server.baseUrl, '/api/cloud/join-links', {
      method: 'POST',
      cookie: openAccount.cookie,
      body: JSON.stringify({ maxUses: 2, expiresAt: '2035-01-01T00:00:00.000Z' }),
    });
    assert.match(joinLink.data.joinLink.url, /\/join\/mc_join_/);

    const ownedServers = await request(server.baseUrl, '/api/console/servers', { cookie: openAccount.cookie });
    assert.deepEqual(ownedServers.data.servers.map((item) => item.slug), ['pg-team']);
    assert.equal(ownedServers.data.servers[0].name, 'PG Team Renamed');
    assert.equal(ownedServers.data.servers[0].avatar, 'data:image/png;base64,cGc=');

    const consoleInvitations = await request(server.baseUrl, '/api/console/invitations', {
      cookie: openAccount.cookie,
    });
    assert.deepEqual(
      consoleInvitations.data.invitations.map((item) => item.status).sort(),
      ['pending', 'pending'],
    );

    const declined = await request(server.baseUrl, `/api/console/invitations/${firstInvite.data.invitation.id}/decline`, {
      method: 'POST',
      cookie: openAccount.cookie,
      body: '{}',
    });
    assert.equal(declined.data.invitation.status, 'declined');

    await request(server.baseUrl, `/api/console/invitations/${firstInvite.data.invitation.id}/accept`, {
      method: 'POST',
      cookie: openAccount.cookie,
      body: '{}',
      expectStatus: 409,
    });

    const accepted = await request(server.baseUrl, `/api/console/invitations/${secondInvite.data.invitation.id}/accept`, {
      method: 'POST',
      cookie: openAccount.cookie,
      body: '{}',
    });
    assert.equal(accepted.data.invitation.status, 'accepted');
    assert.equal(accepted.data.member.role, 'admin');
    assert.ok(accepted.data.cloud.auth.currentMember);
    assert.deepEqual(accepted.data.console.workspaces.map((item) => item.slug).sort(), ['local', 'pg-team']);
    assert.equal(accepted.data.cloud.joinLinks.length, 1);

    const servers = await request(server.baseUrl, '/api/console/servers', { cookie: openAccount.cookie });
    assert.deepEqual(servers.data.servers.map((item) => item.slug).sort(), ['local', 'pg-team']);

    const forgot = await request(server.baseUrl, '/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email: 'console-pg@example.com' }),
    });
    assert.equal(forgot.data.ok, true);
    assert.equal(forgot.data.sent, true);
    const outbox = (await readFile(path.join(tmp, '.magclaw', 'outbox.jsonl'), 'utf8')).trim().split('\n');
    const message = JSON.parse(outbox.at(-1));
    assert.equal(message.to, 'console-pg@example.com');
    assert.match(message.html, /https:\/\/pg\.magclaw\.example\/reset-password\?token=mc_reset_/);
    assert.match(message.html, /https:\/\/pg\.magclaw\.example\/brand\/magclaw-logo\.png/);
    assert.match(message.html, /background:#ff66cc/);
    assert.doesNotMatch(message.html, /#ffd743|#FFD800|--magclaw-sun/i);

    const client = new Client({ connectionString: databaseUrlWithName(TEST_DATABASE_URL, TEST_DATABASE) });
    await client.connect();
    try {
      const users = await client.query(
        `SELECT normalized_email, password_hash FROM ${quoteIdent(schema)}.cloud_users ORDER BY normalized_email ASC`,
      );
      assert.deepEqual(users.rows.map((row) => row.normalized_email), ['admin@example.com', 'console-pg@example.com']);
      assert.ok(users.rows.every((row) => String(row.password_hash || '').startsWith('scrypt$')));

      const sessions = await client.query(
        `SELECT COUNT(*)::int AS count FROM ${quoteIdent(schema)}.cloud_sessions WHERE revoked_at IS NULL`,
      );
      assert.equal(sessions.rows[0].count, 2);

      const memberRows = await client.query(
        `SELECT m.role, m.status
         FROM ${quoteIdent(schema)}.cloud_workspace_members m
         JOIN ${quoteIdent(schema)}.cloud_users u ON u.id = m.user_id
         WHERE u.normalized_email = $1`,
        ['console-pg@example.com'],
      );
      assert.deepEqual(memberRows.rows.map((row) => row.role).sort(), ['admin', 'admin']);
      assert.ok(memberRows.rows.every((row) => row.status === 'active'));

      const invitations = await client.query(
        `SELECT role, accepted_at, revoked_at, metadata
         FROM ${quoteIdent(schema)}.cloud_invitations
         WHERE normalized_email = $1
         ORDER BY created_at ASC`,
        ['console-pg@example.com'],
      );
      assert.equal(invitations.rows.length, 2);
      assert.equal(invitations.rows[0].role, 'member');
      assert.equal(invitations.rows[0].metadata.consoleAction, 'declined');
      assert.ok(invitations.rows[0].revoked_at);
      assert.equal(invitations.rows[1].role, 'admin');
      assert.equal(invitations.rows[1].metadata.consoleAction, 'accepted');
      assert.ok(invitations.rows[1].accepted_at);

      const resets = await client.query(
        `SELECT COUNT(*)::int AS count
         FROM ${quoteIdent(schema)}.cloud_password_resets r
         JOIN ${quoteIdent(schema)}.cloud_users u ON u.id = r.user_id
         WHERE u.normalized_email = $1
           AND r.consumed_at IS NULL
           AND r.revoked_at IS NULL`,
        ['console-pg@example.com'],
      );
      assert.equal(resets.rows[0].count, 1);
    } finally {
      await client.end();
    }

    await server.stop();
    server = null;

    const restartTmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-cloud-pg-restart-'));
    server = await launchIsolatedServer(restartTmp, schema);
    const restartedMember = await request(server.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'console-pg@example.com', password: 'password123' }),
    });
    assert.equal(restartedMember.data.user.email, 'console-pg@example.com');
    assert.equal(restartedMember.data.member.role, 'admin');
    const restartedState = await request(server.baseUrl, '/api/state', { cookie: restartedMember.cookie });
    assert.equal(restartedState.data.cloud.auth.currentMember.role, 'admin');
    assert.ok(restartedState.data.channels.length > 0);
  } finally {
    if (server) await server.stop();
    await dropSchema(schema);
  }
});
