import assert from 'node:assert/strict';
import test from 'node:test';
import {
  databaseNameFromUrl,
  databaseUrlWithName,
  loadSchemaSql,
  normalizeDatabaseUrl,
  parsePostgresArgs,
  quoteIdent,
  redactDatabaseUrl,
} from '../server/cloud/postgres.js';
import { createCloudPostgresStore as createStore } from '../server/cloud/postgres-store.js';

test('postgres URL helpers accept asyncpg URLs without exposing secrets', () => {
  const asyncpgUrl = 'postgresql+asyncpg://user:secret@example.test:5432';
  assert.equal(
    normalizeDatabaseUrl(asyncpgUrl),
    'postgresql://user:secret@example.test:5432',
  );
  assert.equal(databaseNameFromUrl(asyncpgUrl, 'magclaw_cloud'), 'magclaw_cloud');
  assert.equal(
    databaseUrlWithName(asyncpgUrl, 'magclaw_cloud'),
    'postgresql://user:secret@example.test:5432/magclaw_cloud',
  );
  assert.equal(
    redactDatabaseUrl(asyncpgUrl),
    'postgresql://user:***@example.test:5432',
  );
});

test('postgres CLI args validate database and schema identifiers', () => {
  const options = parsePostgresArgs([
    'migrate',
    '--database-url',
    'postgresql://user:secret@example.test:5432/postgres',
    '--database',
    'magclaw_cloud',
    '--schema',
    'magclaw',
    '--maintenance-database',
    'postgres',
  ]);
  assert.equal(options.command, 'migrate');
  assert.equal(options.database, 'magclaw_cloud');
  assert.equal(options.schema, 'magclaw');
  assert.equal(options.maintenanceDatabase, 'postgres');
  assert.throws(
    () => parsePostgresArgs(['migrate', '--database-url', 'postgresql://x/y', '--schema', 'bad-name']),
    /schema must contain only letters/,
  );
  assert.equal(quoteIdent('cloud_users'), '"cloud_users"');
});

test('postgres schema covers auth, relay, collaboration, attachments, and audit tables', async () => {
  const sql = await loadSchemaSql();
  for (const table of [
    'cloud_users',
    'cloud_sessions',
    'cloud_invitations',
    'cloud_humans',
    'cloud_computers',
    'cloud_pairing_tokens',
    'cloud_computer_tokens',
    'cloud_agents',
    'cloud_messages',
    'cloud_replies',
    'cloud_tasks',
    'cloud_work_items',
    'cloud_state_records',
    'cloud_attachments',
    'cloud_agent_deliveries',
    'cloud_release_notes',
    'cloud_audit_logs',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
    }
    assert.match(sql, /\bowner_user_id\b/);
    assert.match(sql, /\bmachine_fingerprint\b/);
    assert.match(sql, /\bruntime_details\b/);
    assert.match(sql, /\bstorage_mode\b/);
    assert.match(sql, /component IN \('web', 'daemon'\)/);
    assert.match(sql, /role IN \('member', 'admin'\)/);
    assert.match(sql, /WHEN 'owner' THEN 'admin'/);
    assert.match(sql, /cloud_users_active_normalized_email_uidx/);
  assert.match(sql, /WHERE disabled_at IS NULL/);
  assert.doesNotMatch(sql, /\buid\b/);
});

test('postgres store persists relay computers tokens deliveries and daemon events', async () => {
  const queries = [];
  const pool = {
    async connect() {
      return {
        async query(sql, params = []) {
          queries.push({ sql, params });
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const store = createStore({
    databaseUrl: 'postgresql://user:secret@example.test:5432/postgres',
    database: 'magclaw_cloud',
    schema: 'magclaw',
    pool,
  });
  const createdAt = '2026-05-07T00:00:00.000Z';
  await store.persistFromState({
    humans: [{
      id: 'hum_owner',
      workspaceId: 'wsp_main',
      name: 'Owner',
      email: 'owner@example.test',
      role: 'owner',
      createdAt,
    }],
    computers: [{
      id: 'cmp_remote',
      workspaceId: 'wsp_main',
      name: 'Remote Mac',
      status: 'connected',
      connectedVia: 'daemon',
      runtimeIds: ['codex'],
      capabilities: ['agent:deliver'],
      createdAt,
      updatedAt: createdAt,
    }],
    agents: [{
      id: 'agt_remote',
      workspaceId: 'wsp_main',
      computerId: 'cmp_remote',
      name: 'Remote Agent',
      runtime: 'codex',
      model: 'gpt-5.5',
      status: 'idle',
      createdAt,
      updatedAt: createdAt,
    }],
    channels: [{
      id: 'chan_all',
      workspaceId: 'wsp_main',
      name: 'all',
      createdAt,
      updatedAt: createdAt,
    }],
    dms: [{
      id: 'dm_remote',
      workspaceId: 'wsp_main',
      participantIds: ['hum_owner', 'agt_remote'],
      createdAt,
      updatedAt: createdAt,
    }],
    messages: [{
      id: 'msg_remote',
      workspaceId: 'wsp_main',
      spaceType: 'dm',
      spaceId: 'dm_remote',
      authorType: 'human',
      authorId: 'hum_owner',
      body: 'hello',
      createdAt,
      updatedAt: createdAt,
    }],
    replies: [{
      id: 'rep_remote',
      workspaceId: 'wsp_main',
      parentMessageId: 'msg_remote',
      authorType: 'agent',
      authorId: 'agt_remote',
      body: 'hi',
      createdAt,
      updatedAt: createdAt,
    }],
    tasks: [{
      id: 'task_remote',
      workspaceId: 'wsp_main',
      number: 1,
      spaceType: 'dm',
      spaceId: 'dm_remote',
      title: 'Ship it',
      status: 'todo',
      createdAt,
      updatedAt: createdAt,
    }],
    workItems: [{
      id: 'wi_remote',
      workspaceId: 'wsp_main',
      agentId: 'agt_remote',
      taskId: 'task_remote',
      sourceMessageId: 'msg_remote',
      status: 'queued',
      createdAt,
      updatedAt: createdAt,
    }],
    attachments: [{
      id: 'att_remote',
      workspaceId: 'wsp_main',
      storageKey: 'uploads/att_remote',
      filename: 'note.txt',
      mimeType: 'text/plain',
      createdAt,
    }],
    events: [{ id: 'evt_remote', workspaceId: 'wsp_main', type: 'test', createdAt }],
    cloud: {
      workspaces: [{ id: 'wsp_main', slug: 'main', name: 'Main', createdAt, updatedAt: createdAt }],
      users: [],
      workspaceMembers: [],
      sessions: [],
      invitations: [],
      passwordResetTokens: [],
      computerTokens: [{
        id: 'ctok_remote',
        workspaceId: 'wsp_main',
        computerId: 'cmp_remote',
        label: 'Remote Mac',
        tokenHash: 'hash_machine',
        createdAt,
      }],
      pairingTokens: [{
        id: 'pair_remote',
        workspaceId: 'wsp_main',
        computerId: 'cmp_remote',
        label: 'Pair Remote',
        tokenHash: 'hash_pair',
        createdAt,
        expiresAt: '2026-05-07T00:15:00.000Z',
      }],
      agentDeliveries: [{
        id: 'adl_remote',
        workspaceId: 'wsp_main',
        agentId: 'agt_remote',
        computerId: 'cmp_remote',
        seq: 1,
        type: 'agent:deliver',
        commandType: 'agent:deliver',
        status: 'queued',
        payload: { message: { body: 'hello' } },
        createdAt,
        updatedAt: createdAt,
      }],
      daemonEvents: [{
        id: 'devt_remote',
        workspaceId: 'wsp_main',
        computerId: 'cmp_remote',
        type: 'computer_ready',
        message: 'Computer ready',
        meta: { computerId: 'cmp_remote' },
        createdAt,
      }],
    },
    releaseNotes: {
      web: {
        currentVersion: '0.2.0',
        latestVersion: '0.2.0',
        releases: [{
          version: '0.2.0',
          date: '2026-05-09',
          title: 'Cloud release',
          features: ['Cloud account flow'],
          fixes: [],
          improved: [],
        }],
      },
      daemon: {
        currentVersion: '0.1.1',
        latestVersion: '0.1.1',
        releases: [],
      },
    },
  });
  const sqlText = queries.map((query) => query.sql).join('\n');
  for (const table of [
    'cloud_computers',
    'cloud_humans',
    'cloud_agents',
    'cloud_channels',
    'cloud_dms',
    'cloud_messages',
    'cloud_replies',
    'cloud_tasks',
    'cloud_work_items',
    'cloud_attachments',
    'cloud_state_records',
    'cloud_computer_tokens',
    'cloud_pairing_tokens',
    'cloud_agent_deliveries',
    'cloud_daemon_events',
    'cloud_release_notes',
  ]) {
    assert.match(sqlText, new RegExp(`INSERT INTO "magclaw"\\."${table}"`));
  }
});

test('postgres store upserts duplicate residual state records without crashing', async () => {
  const queries = [];
  const pool = {
    async connect() {
      return {
        async query(sql, params = []) {
          queries.push({ sql, params });
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const store = createStore({
    databaseUrl: 'postgresql://user:secret@example.test:5432/postgres',
    database: 'magclaw_cloud',
    schema: 'magclaw',
    pool,
  });
  const createdAt = '2026-05-12T00:00:00.000Z';
  await store.persistFromState({
    routeEvents: [
      { id: 'route_duplicate', workspaceId: 'wsp_main', choice: 'first', createdAt },
      { id: 'route_duplicate', workspaceId: 'wsp_main', choice: 'latest', createdAt },
      { id: 'route_orphan', workspaceId: 'wsp_missing', choice: 'fallback', createdAt },
    ],
    cloud: {
      workspaces: [{ id: 'wsp_main', slug: 'main', name: 'Main', createdAt, updatedAt: createdAt }],
      users: [],
      workspaceMembers: [],
      sessions: [],
      invitations: [],
      passwordResetTokens: [],
    },
  });
  const stateRecordInserts = queries.filter((query) => (
    query.sql.includes('INSERT INTO "magclaw"."cloud_state_records"')
  ));
  assert.equal(stateRecordInserts.length, 2);
  assert.match(stateRecordInserts[0].sql, /ON CONFLICT \(workspace_id, kind, id\) DO UPDATE SET/);
  assert.equal(stateRecordInserts[1].params[2], 'route_duplicate');
  assert.equal(JSON.parse(stateRecordInserts[1].params[6]).choice, 'latest');
  const orphanInsert = stateRecordInserts.find((query) => query.params[2] === 'route_orphan');
  assert.equal(orphanInsert, undefined);
});

test('postgres store persists auth state without flushing runtime records', async () => {
  const queries = [];
  const pool = {
    async connect() {
      return {
        async query(sql, params = []) {
          queries.push({ sql, params });
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const store = createStore({
    databaseUrl: 'postgresql://user:secret@example.test:5432/postgres',
    database: 'magclaw_cloud',
    schema: 'magclaw',
    pool,
  });
  const createdAt = '2026-05-12T00:00:00.000Z';
  await store.persistAuthFromState({
    routeEvents: [{ id: 'route_auth_should_skip', workspaceId: 'wsp_main', createdAt }],
    cloud: {
      workspaces: [{ id: 'wsp_main', slug: 'main', name: 'Main', createdAt, updatedAt: createdAt }],
      users: [{
        id: 'usr_auth',
        email: 'auth@example.test',
        name: 'Auth User',
        passwordHash: 'hash',
        language: 'en',
        createdAt,
        updatedAt: createdAt,
        lastLoginAt: createdAt,
      }],
      workspaceMembers: [{
        id: 'wmem_auth',
        workspaceId: 'wsp_main',
        userId: 'usr_auth',
        role: 'admin',
        status: 'active',
        joinedAt: createdAt,
        createdAt,
        updatedAt: createdAt,
      }],
      sessions: [{
        id: 'sess_auth',
        userId: 'usr_auth',
        tokenHash: 'session_hash',
        createdAt,
        expiresAt: '2026-05-26T00:00:00.000Z',
      }],
    },
  });
  const sqlText = queries.map((query) => query.sql).join('\n');
  for (const table of ['cloud_users', 'cloud_workspaces', 'cloud_workspace_members', 'cloud_sessions']) {
    assert.match(sqlText, new RegExp(`INSERT INTO "magclaw"\\."${table}"`));
  }
  assert.doesNotMatch(sqlText, /cloud_state_records/);
  assert.doesNotMatch(sqlText, /cloud_route_events/);
});

test('postgres store snapshots auth state before async connection waits', async () => {
  const queries = [];
  const createdAt = '2026-05-12T00:00:00.000Z';
  const state = {
    cloud: {
      workspaces: [{ id: 'wsp_snapshot', slug: 'snapshot', name: 'Snapshot', createdAt, updatedAt: createdAt }],
      users: [{
        id: 'usr_snapshot',
        email: 'snapshot@example.test',
        name: 'Snapshot User',
        passwordHash: 'hash',
        language: 'en',
        createdAt,
        updatedAt: createdAt,
      }],
      workspaceMembers: [],
      sessions: [],
    },
  };
  const pool = {
    async connect() {
      state.cloud.users = [];
      state.cloud.workspaces = [];
      return {
        async query(sql, params = []) {
          queries.push({ sql, params });
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const store = createStore({
    databaseUrl: 'postgresql://user:secret@example.test:5432/postgres',
    database: 'magclaw_cloud',
    schema: 'magclaw',
    pool,
  });
  await store.persistAuthFromState(state);
  const userInsert = queries.find((query) => query.sql.includes('INSERT INTO "magclaw"."cloud_users"'));
  const workspaceInsert = queries.find((query) => query.sql.includes('INSERT INTO "magclaw"."cloud_workspaces"'));
  assert.equal(userInsert?.params[0], 'usr_snapshot');
  assert.equal(workspaceInsert?.params[0], 'wsp_snapshot');
});

test('postgres store persists login auth operation with narrow monotonic writes', async () => {
  const queries = [];
  const pool = {
    async connect() {
      return {
        async query(sql, params = []) {
          queries.push({ sql, params });
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const store = createStore({
    databaseUrl: 'postgresql://user:secret@example.test:5432/postgres',
    database: 'magclaw_cloud',
    schema: 'magclaw',
    pool,
  });

  await store.persistAuthOperation({
    type: 'login',
    user: {
      id: 'usr_login',
      lastLoginAt: '2026-05-12T01:00:00.000Z',
    },
    session: {
      id: 'sess_login',
      userId: 'usr_login',
      tokenHash: 'token_hash',
      createdAt: '2026-05-12T01:00:00.000Z',
      expiresAt: '2026-06-11T01:00:00.000Z',
      userAgent: 'node-test',
      ipHash: 'ip_hash',
      revokedAt: null,
    },
  });

  const userUpdate = queries.find((query) => query.sql.includes('UPDATE "magclaw"."cloud_users"'));
  const sessionUpsert = queries.find((query) => query.sql.includes('INSERT INTO "magclaw"."cloud_sessions"'));
  assert.ok(userUpdate);
  assert.doesNotMatch(userUpdate.sql, /password_hash/);
  assert.ok(sessionUpsert);
  assert.match(sessionUpsert.sql, /revoked_at = COALESCE\("magclaw"\."cloud_sessions"\.revoked_at, EXCLUDED\.revoked_at\)/);
  assert.doesNotMatch(queries.map((query) => query.sql).join('\n'), /cloud_state_records/);
});

test('postgres store persists password updates as narrow auth operations', async () => {
  const queries = [];
  const pool = {
    async connect() {
      return {
        async query(sql, params = []) {
          queries.push({ sql, params });
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const store = createStore({
    databaseUrl: 'postgresql://user:secret@example.test:5432/postgres',
    database: 'magclaw_cloud',
    schema: 'magclaw',
    pool,
  });

  await store.persistAuthOperation({
    type: 'password-update',
    user: {
      id: 'usr_admin',
      passwordHash: 'new_admin_hash',
      emailVerifiedAt: '2026-05-12T01:00:00.000Z',
      updatedAt: '2026-05-12T01:00:00.000Z',
    },
  });

  const userUpdate = queries.find((query) => query.sql.includes('UPDATE "magclaw"."cloud_users"'));
  assert.match(userUpdate?.sql || '', /password_hash = \$2/);
  assert.equal(userUpdate?.params[0], 'usr_admin');
  assert.equal(userUpdate?.params[1], 'new_admin_hash');
  assert.doesNotMatch(queries.map((query) => query.sql).join('\n'), /cloud_sessions/);
});


test('postgres store persists password reset completion without reviving consumed tokens', async () => {
  const queries = [];
  const pool = {
    async connect() {
      return {
        async query(sql, params = []) {
          queries.push({ sql, params });
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const store = createStore({
    databaseUrl: 'postgresql://user:secret@example.test:5432/postgres',
    database: 'magclaw_cloud',
    schema: 'magclaw',
    pool,
  });

  await store.persistAuthOperation({
    type: 'password-reset-complete',
    user: {
      id: 'usr_reset',
      passwordHash: 'new_hash',
      emailVerifiedAt: '2026-05-12T01:00:00.000Z',
      updatedAt: '2026-05-12T01:00:00.000Z',
    },
    reset: {
      id: 'preset_1',
      workspaceId: 'wsp_main',
      userId: 'usr_reset',
      tokenHash: 'reset_hash',
      createdBy: null,
      expiresAt: '2026-05-12T02:00:00.000Z',
      consumedAt: '2026-05-12T01:00:00.000Z',
      revokedAt: null,
      createdAt: '2026-05-12T00:00:00.000Z',
    },
    session: {
      id: 'sess_reset',
      userId: 'usr_reset',
      tokenHash: 'token_hash',
      createdAt: '2026-05-12T01:00:00.000Z',
      expiresAt: '2026-06-11T01:00:00.000Z',
      userAgent: 'node-test',
      ipHash: 'ip_hash',
      revokedAt: null,
    },
  });

  const userUpdate = queries.find((query) => query.sql.includes('UPDATE "magclaw"."cloud_users"'));
  const resetUpsert = queries.find((query) => query.sql.includes('INSERT INTO "magclaw"."cloud_password_resets"'));
  assert.match(userUpdate?.sql || '', /password_hash = \$2/);
  assert.match(resetUpsert?.sql || '', /consumed_at = COALESCE\("magclaw"\."cloud_password_resets"\.consumed_at, EXCLUDED\.consumed_at\)/);
  assert.match(resetUpsert?.sql || '', /revoked_at = COALESCE\("magclaw"\."cloud_password_resets"\.revoked_at, EXCLUDED\.revoked_at\)/);
});
