import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import { Client } from 'pg';
import { createCloudPostgresStore } from '../server/cloud/postgres-store.js';
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
  await mkdir(path.join(tmp, 'uploads'), { recursive: true });

  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    cwd: tmp,
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      CODEX_PATH: '/bin/false',
      MAGCLAW_DEPLOYMENT: 'cloud',
      MAGCLAW_REQUIRE_POSTGRES: '1',
      MAGCLAW_DATA_DIR: path.join(tmp, '.magclaw'),
      MAGCLAW_UPLOAD_DIR: path.join(tmp, 'uploads'),
      MAGCLAW_ATTACHMENT_STORAGE: 'pvc',
      MAGCLAW_DATABASE_URL: TEST_DATABASE_URL,
      MAGCLAW_DATABASE: TEST_DATABASE,
      MAGCLAW_DATABASE_SCHEMA: schema,
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

  for (let attempt = 0; attempt < 300; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) break;
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
    assert.equal(initial.data.auth.initialized, false);

    const adminAccount = await request(server.baseUrl, '/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Admin',
        email: 'admin@example.com',
        password: 'password123',
      }),
    });
    assert.match(adminAccount.cookie, /magclaw_session=/);
    const adminServer = await request(server.baseUrl, '/api/console/servers', {
      method: 'POST',
      cookie: adminAccount.cookie,
      body: JSON.stringify({ name: 'Admin Team', slug: 'admin-team' }),
    });
    assert.equal(adminServer.data.member.role, 'owner');
    const adminCookie = adminAccount.cookie;

    const firstInvite = await request(server.baseUrl, '/api/cloud/invitations', {
      method: 'POST',
      cookie: adminCookie,
      body: JSON.stringify({ email: 'console-pg@example.com', role: 'member' }),
    });
    const secondInvite = await request(server.baseUrl, '/api/cloud/invitations', {
      method: 'POST',
      cookie: adminCookie,
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
    assert.equal(createdServer.data.member.role, 'owner');
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
    assert.deepEqual(accepted.data.console.workspaces.map((item) => item.slug).sort(), ['admin-team', 'pg-team']);
    assert.equal(accepted.data.cloud.joinLinks.length, 1);

    const servers = await request(server.baseUrl, '/api/console/servers', { cookie: openAccount.cookie });
    assert.deepEqual(servers.data.servers.map((item) => item.slug).sort(), ['admin-team', 'pg-team']);

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
      assert.deepEqual(memberRows.rows.map((row) => row.role).sort(), ['admin', 'owner']);
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
    assert.deepEqual(restartedState.data.cloud.workspaces.map((item) => item.slug).sort(), ['admin-team', 'pg-team']);
  } finally {
    if (server) await server.stop();
    await dropSchema(schema);
  }
});

test('large share HTML uses the upload volume, PostgreSQL recovery, and reversible metadata', {
  skip: TEST_DATABASE_URL ? false : 'set MAGCLAW_TEST_DATABASE_URL to run this integration test',
}, async (t) => {
  const schema = `magclaw_share_test_${Date.now()}_${process.pid}`;
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-share-pg-'));
  const server = await launchIsolatedServer(tmp, schema);
  const connectionString = databaseUrlWithName(TEST_DATABASE_URL, TEST_DATABASE);
  const client = new Client({ connectionString });
  const store = createCloudPostgresStore({
    databaseUrl: connectionString,
    database: TEST_DATABASE,
    schema,
    attachmentBaseDir: path.join(tmp, 'uploads'),
  });
  t.after(async () => {
    await server.stop();
    await client.end();
    await store.close();
    await dropSchema(schema);
  });
  await client.connect();

  const auth = await request(server.baseUrl, '/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name: 'Share Owner', email: 'share-owner@example.com', password: 'password123' }),
  });
  const cookie = auth.cookie.split(';')[0];
  await request(server.baseUrl, '/api/console/servers', {
    method: 'POST', cookie, body: JSON.stringify({ name: 'Test Team', slug: 'share-team' }),
  });
  const sharesPath = '/api/team-sharing/shares';
  const content = `<!doctype html><html><head><title>Sample</title></head><body><section id="story"><h1>正文样本</h1><p>首个版本</p></section><script>const data="${'数据'.repeat(75_000)}";</script></body></html>`;
  const publish = (body) => request(server.baseUrl, sharesPath, {
    method: 'POST', cookie, expectStatus: 201,
    body: JSON.stringify({ title: 'Share sample', contentType: 'html', content: body, optimizeAssets: false }),
  });
  const { data: share } = await publish(content);
  await publish('<p>Small share</p>');
  const sharePath = `${sharesPath}/${share.shareId}`;
  const readShare = () => request(server.baseUrl, sharePath, { cookie });
  const readSharingState = async () => {
    const { rows } = await client.query(
      `SELECT payload FROM ${quoteIdent(schema)}.cloud_state_records WHERE kind = 'teamSharing' AND payload ? 'shares'`,
    );
    return rows[0].payload;
  };
  const previous = await readSharingState();
  assert.ok(previous.shareContents.some((blob) => blob.content === content));
  assert.equal((await readShare()).data.content, content);

  const activated = await store.manageShareBodyStorage('enable');
  assert.equal(activated.backupBodies, 1);
  assert.equal(activated.changedRecords, 1);
  const compact = await readSharingState();
  const legacyBlob = compact.shareContents.find((blob) => blob.contentHash === share.share.contentHash);
  assert.equal(legacyBlob.content, undefined);
  assert.equal(legacyBlob.bodyFile.bytes, Buffer.byteLength(content));
  assert.ok(compact.shareContents.some((blob) => blob.content === '<p>Small share</p>'));
  const { workspaceId, sha256 } = legacyBlob.bodyFile;
  const workspaceHash = createHash('sha256').update(workspaceId).digest('hex');
  const file = path.join(tmp, 'uploads', '.team-sharing-bodies', workspaceHash, sha256.slice(0, 2), `${sha256}.html.gz`);
  assert.equal(gunzipSync(await readFile(file)).toString('utf8'), content);
  assert.equal((await request(server.baseUrl, sharesPath, { cookie })).data.count, 2);
  const html = await fetch(`${server.baseUrl}/s/${share.shareId}`, { headers: { cookie } });
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-security-policy'), /sandbox/);
  assert.match(await html.text(), /首个版本/);
  assert.equal((await request(server.baseUrl, `${sharePath}/sections`, { cookie })).data.sections[0].sectionId, 'story');
  await request(server.baseUrl, sharePath, { expectStatus: 401 });

  await writeFile(file, 'broken gzip');
  assert.equal(await store.readShareBody(legacyBlob.bodyFile), content);
  assert.equal((await readShare()).data.content, content);

  const editedContent = content.replace('首个版本', '第二个版本');
  const edits = await Promise.all(['Edited title', 'Concurrent edit'].map(async (title) => {
    const response = await fetch(`${server.baseUrl}${sharePath}`, {
      method: 'PATCH',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        title,
        baseVersionId: share.share.versionId,
        operations: [{ op: 'replace_content', content: editedContent }],
        optimizeAssets: false,
      }),
    });
    await response.text();
    return response.status;
  }));
  assert.deepEqual(edits.sort(), [200, 409]);
  const edited = (await readShare()).data;
  assert.equal(edited.content, editedContent);
  assert.notEqual(edited.versionId, share.share.versionId);
  assert.equal((await store.manageShareBodyStorage('status')).backupBodies, 2);
  const restored = await store.manageShareBodyStorage('restore');
  assert.equal(restored.enabled, false);
  const restoredState = await readSharingState();
  assert.ok(restoredState.shareContents.some((blob) => blob.content === content));
  assert.ok(restoredState.shareContents.some((blob) => blob.content === editedContent));
  assert.equal((await readShare()).data.content, editedContent);

  await request(server.baseUrl, sharePath, { method: 'DELETE', cookie });
  await request(server.baseUrl, sharePath, { cookie, expectStatus: 404 });
});
