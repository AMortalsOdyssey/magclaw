import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
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
      MAGCLAW_DATA_DIR: path.join(tmp, '.magclaw'),
      MAGCLAW_DATABASE_URL: TEST_DATABASE_URL,
      MAGCLAW_DATABASE: TEST_DATABASE,
      MAGCLAW_DATABASE_SCHEMA: schema,
      MAGCLAW_ADMIN_NAME: 'Admin',
      MAGCLAW_ADMIN_EMAIL: 'admin@example.com',
      MAGCLAW_ADMIN_PASSWORD: 'password123',
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

test('Postgres-backed cloud auth stores admin sessions invitations and registered users', {
  skip: TEST_DATABASE_URL ? false : 'set MAGCLAW_TEST_DATABASE_URL to run this integration test',
}, async () => {
  const schema = `magclaw_test_${Date.now()}_${process.pid}`;
  let server = null;
  try {
    const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-cloud-pg-'));
    server = await launchIsolatedServer(tmp, schema);
    const initial = await request(server.baseUrl, '/api/cloud/auth/status');
    assert.equal(initial.data.auth.storageBackend, 'postgres');
    assert.equal(initial.data.auth.initialized, true);

    const admin = await request(server.baseUrl, '/api/cloud/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
    });
    assert.match(admin.cookie, /magclaw_session=/);

    const invite = await request(server.baseUrl, '/api/cloud/invitations', {
      method: 'POST',
      cookie: admin.cookie,
      body: JSON.stringify({ email: 'member@example.com', role: 'member' }),
    });
    assert.match(invite.data.inviteToken, /^mc_inv_/);

    const member = await request(server.baseUrl, '/api/cloud/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        inviteToken: invite.data.inviteToken,
        email: 'member@example.com',
        name: 'Member',
        password: 'password123',
      }),
    });
    assert.equal(member.data.member.role, 'member');

    const client = new Client({ connectionString: databaseUrlWithName(TEST_DATABASE_URL, TEST_DATABASE) });
    await client.connect();
    try {
      const users = await client.query(
        `SELECT normalized_email, password_hash FROM ${quoteIdent(schema)}.cloud_users ORDER BY normalized_email ASC`,
      );
      assert.deepEqual(users.rows.map((row) => row.normalized_email), ['admin@example.com', 'member@example.com']);
      assert.ok(users.rows.every((row) => String(row.password_hash || '').startsWith('scrypt$')));

      const sessions = await client.query(
        `SELECT COUNT(*)::int AS count FROM ${quoteIdent(schema)}.cloud_sessions WHERE revoked_at IS NULL`,
      );
      assert.equal(sessions.rows[0].count, 2);

      const invitation = await client.query(
        `SELECT accepted_at FROM ${quoteIdent(schema)}.cloud_invitations WHERE normalized_email = $1`,
        ['member@example.com'],
      );
      assert.ok(invitation.rows[0].accepted_at);
    } finally {
      await client.end();
    }

    await server.stop();
    server = null;

    const restartTmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-cloud-pg-restart-'));
    server = await launchIsolatedServer(restartTmp, schema);
    const restartedMember = await request(server.baseUrl, '/api/cloud/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'member@example.com', password: 'password123' }),
    });
    assert.equal(restartedMember.data.user.email, 'member@example.com');
    assert.equal(restartedMember.data.member.role, 'member');
  } finally {
    if (server) await server.stop();
    await dropSchema(schema);
  }
});
