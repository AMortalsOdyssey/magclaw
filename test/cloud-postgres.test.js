import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  databaseNameFromUrl,
  databaseUrlWithName,
  loadSchemaSql,
  normalizeDatabaseUrl,
  normalizePostgresRuntimeOptions,
  parsePostgresArgs,
  postgresAdvisoryLockKey,
  postgresRuntimeOptionsFromEnv,
  quoteIdent,
  redactDatabaseUrl,
  withPostgresAdvisoryLock,
} from '../server/cloud/postgres.js';
import { createCloudPostgresStore as createStore } from '../server/cloud/postgres-store.js';

test('postgres store consumes idle pool connection errors', () => {
  const pool = new EventEmitter();
  const previousWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    createStore({
      databaseUrl: 'postgresql://user:secret@example.test:5432/magclaw_cloud',
      pool,
    });
    const error = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    assert.doesNotThrow(() => pool.emit('error', error));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /cloud-postgres/);
    assert.match(warnings[0], /ECONNRESET/);
  } finally {
    console.warn = previousWarn;
  }
});

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

test('postgres runtime options parse timeouts and advisory lock serializes startup work', async () => {
  assert.deepEqual(postgresRuntimeOptionsFromEnv({
    MAGCLAW_DATABASE_LOCK_TIMEOUT_MS: '1234',
    MAGCLAW_DATABASE_STATEMENT_TIMEOUT_MS: '5678',
    MAGCLAW_DATABASE_IDLE_IN_TRANSACTION_TIMEOUT_MS: '4321',
    MAGCLAW_DATABASE_STARTUP_LOCK_TIMEOUT_MS: '8765',
    MAGCLAW_DATABASE_CONNECT_TIMEOUT_MS: '2222',
  }), {
    lockTimeoutMs: 1234,
    statementTimeoutMs: 5678,
    idleInTransactionSessionTimeoutMs: 4321,
    startupLockTimeoutMs: 8765,
    connectTimeoutMs: 2222,
  });
  assert.equal(normalizePostgresRuntimeOptions({ lockTimeoutMs: -1 }).lockTimeoutMs, 10_000);

  const lockKey = postgresAdvisoryLockKey('migration', 'magclaw_cloud', 'magclaw');
  assert.equal(lockKey.length, 2);
  const calls = [];
  let tries = 0;
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('pg_try_advisory_lock')) {
        tries += 1;
        return { rows: [{ locked: tries > 1 }] };
      }
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
      return { rows: [] };
    },
  };
  const result = await withPostgresAdvisoryLock(client, lockKey, async () => 'locked', {
    timeoutMs: 500,
    retryMs: 100,
  });
  assert.equal(result, 'locked');
  assert.equal(tries, 2);
  assert.ok(calls.some((call) => call.sql.includes('pg_advisory_unlock')));
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

test('postgres store persists relay core state without durable activity logs', async () => {
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
    projects: [{
      id: 'proj_remote',
      workspaceId: 'wsp_main',
      name: 'Remote project',
      path: '/repo',
      createdAt,
      updatedAt: createdAt,
    }],
    events: [{ id: 'evt_remote', workspaceId: 'wsp_main', type: 'test', createdAt }],
    routeEvents: [{ id: 'route_remote', workspaceId: 'wsp_main', type: 'fanout', createdAt }],
    systemNotifications: [{ id: 'notif_remote', workspaceId: 'wsp_main', type: 'member_notice', createdAt }],
    inboxReads: {
      hum_owner: {
        workspaceActivityReadAt: createdAt,
        updatedAt: createdAt,
      },
    },
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
  ]) {
    assert.match(sqlText, new RegExp(`INSERT INTO "magclaw"\\."${table}"`));
  }
  assert.doesNotMatch(sqlText, /cloud_daemon_events/);
  assert.doesNotMatch(sqlText, /cloud_release_notes/);
  const serializedParams = JSON.stringify(queries.map((query) => query.params));
  assert.match(serializedParams, /proj_remote/);
  assert.doesNotMatch(serializedParams, /evt_remote|route_remote|notif_remote|devt_remote|workspaceActivityReadAt/);
});

test('postgres store restores legacy provisional computers before pairing tokens', async () => {
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
    computers: [],
    cloud: {
      workspaces: [{ id: 'wsp_main', slug: 'main', name: 'Main', createdAt, updatedAt: createdAt }],
      users: [],
      workspaceMembers: [],
      sessions: [],
      invitations: [],
      passwordResetTokens: [],
      computerTokens: [],
      pairingTokens: [{
        id: 'pair_pending',
        workspaceId: 'wsp_main',
        computerId: 'cmp_pending',
        label: 'Pending runner',
        tokenHash: 'hash_pending_pair',
        createdAt,
        expiresAt: '2026-05-07T00:15:00.000Z',
        metadata: {
          provisionalComputer: true,
          computer: {
            id: 'cmp_pending',
            workspaceId: 'wsp_main',
            name: 'Pending runner',
            status: 'pairing',
            connectedVia: 'daemon',
            createdAt,
            updatedAt: createdAt,
          },
        },
      }],
      agentDeliveries: [],
      daemonEvents: [],
    },
  });
  const computerInsertIndex = queries.findIndex((query) => (
    query.sql.includes('INSERT INTO "magclaw"."cloud_computers"')
    && query.params[0] === 'cmp_pending'
  ));
  const pairingInsertIndex = queries.findIndex((query) => (
    query.sql.includes('INSERT INTO "magclaw"."cloud_pairing_tokens"')
    && query.params[0] === 'pair_pending'
  ));
  assert.notEqual(computerInsertIndex, -1);
  assert.notEqual(pairingInsertIndex, -1);
  assert.ok(computerInsertIndex < pairingInsertIndex);
});

test('postgres store retries full-state persistence after transient lock timeout', async () => {
  const queries = [];
  let workspaceFailures = 0;
  const pool = {
    async connect() {
      return {
        async query(sql, params = []) {
          queries.push({ sql, params });
          if (
            sql.includes('INSERT INTO "magclaw"."cloud_workspaces"')
            && params[0] === 'wsp_retry'
            && workspaceFailures === 0
          ) {
            workspaceFailures += 1;
            throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
          }
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
  const createdAt = '2026-05-13T00:00:00.000Z';
  const previousError = console.error;
  const previousWarn = console.warn;
  console.error = () => {};
  console.warn = () => {};
  try {
    await store.persistFromState({
      cloud: {
        workspaces: [{ id: 'wsp_retry', slug: 'retry', name: 'Retry', createdAt, updatedAt: createdAt }],
        users: [],
        workspaceMembers: [],
        sessions: [],
        invitations: [],
        passwordResetTokens: [],
      },
      releaseNotes: {
        web: {
          currentVersion: '0.2.1',
          latestVersion: '0.2.1',
          releases: [{
            version: '0.2.1',
            date: '2026-05-13',
            title: 'Retry release',
            features: ['Retry transient lock timeout'],
            fixes: [],
            improved: [],
          }],
        },
        daemon: {
          currentVersion: '0.1.2',
          latestVersion: '0.1.2',
          releases: [],
        },
      },
    });
  } finally {
    console.error = previousError;
    console.warn = previousWarn;
  }
  assert.equal(workspaceFailures, 1);
  assert.equal(queries.filter((query) => query.sql === 'BEGIN').length, 2);
  assert.equal(queries.filter((query) => query.sql === 'ROLLBACK').length, 1);
  assert.equal(queries.filter((query) => query.sql === 'COMMIT').length, 1);
  assert.ok(queries.some((query) => (
    query.sql.includes('INSERT INTO "magclaw"."cloud_workspaces"')
    && query.params[0] === 'wsp_retry'
  )));
});

test('postgres store skips orphan computer tokens and pairing tokens', async () => {
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
    computers: [{
      id: 'cmp_present',
      workspaceId: 'wsp_main',
      name: 'Present runner',
      status: 'offline',
      connectedVia: 'daemon',
      runtimeIds: [],
      createdAt,
      updatedAt: createdAt,
    }],
    cloud: {
      workspaces: [{ id: 'wsp_main', slug: 'main', name: 'Main', createdAt, updatedAt: createdAt }],
      users: [],
      workspaceMembers: [],
      sessions: [],
      invitations: [],
      passwordResetTokens: [],
      computerTokens: [{
        id: 'ctok_orphan',
        workspaceId: 'wsp_main',
        computerId: 'cmp_missing',
        label: 'Orphan machine token',
        tokenHash: 'hash_orphan_machine',
        createdAt,
        revokedAt: createdAt,
      }],
      pairingTokens: [{
        id: 'pair_orphan',
        workspaceId: 'wsp_main',
        computerId: 'cmp_missing',
        label: 'Orphan pair token',
        tokenHash: 'hash_orphan_pair',
        createdAt,
        expiresAt: '2026-05-07T00:15:00.000Z',
        revokedAt: createdAt,
      }],
      agentDeliveries: [],
      daemonEvents: [],
    },
  });
  assert.equal(queries.some((query) => (
    query.sql.includes('INSERT INTO "magclaw"."cloud_computer_tokens"')
    && query.params[0] === 'ctok_orphan'
  )), false);
  assert.equal(queries.some((query) => (
    query.sql.includes('INSERT INTO "magclaw"."cloud_pairing_tokens"')
    && query.params[0] === 'pair_orphan'
  )), false);
});

test('postgres store deletes computers absent from the in-memory workspace snapshot', async () => {
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
  const createdAt = '2026-05-13T00:00:00.000Z';
  await store.persistFromState({
    computers: [{
      id: 'cmp_keep',
      workspaceId: 'wsp_main',
      name: 'Keep runner',
      status: 'connected',
      connectedVia: 'daemon',
      runtimeIds: [],
      createdAt,
      updatedAt: createdAt,
    }],
    cloud: {
      workspaces: [{ id: 'wsp_main', slug: 'main', name: 'Main', createdAt, updatedAt: createdAt }],
      users: [],
      workspaceMembers: [],
      sessions: [],
      invitations: [],
      passwordResetTokens: [],
      computerTokens: [],
      pairingTokens: [],
      agentDeliveries: [],
      daemonEvents: [],
    },
  });
  const deleteQuery = queries.find((query) => (
    query.sql.includes('DELETE FROM "magclaw"."cloud_computers"')
  ));
  assert.ok(deleteQuery, 'expected stale cloud computer rows to be removed during snapshot persistence');
  assert.deepEqual(deleteQuery.params, [['wsp_main'], ['cmp_keep']]);
  const deleteIndex = queries.indexOf(deleteQuery);
  const insertIndex = queries.findIndex((query) => (
    query.sql.includes('INSERT INTO "magclaw"."cloud_computers"')
    && query.params[0] === 'cmp_keep'
  ));
  assert.ok(deleteIndex >= 0 && insertIndex > deleteIndex, 'stale deletion should run before current computer upserts');
});

test('postgres store can reset transient online state when loading a fresh server process', async () => {
  const createdAt = '2026-05-13T10:01:53.000Z';
  const rowsForTable = {
    cloud_workspaces: [{
      id: 'wsp_main',
      slug: 'main',
      name: 'Main',
      created_at: createdAt,
      updated_at: createdAt,
    }],
    cloud_humans: [{
      id: 'hum_owner',
      workspace_id: 'wsp_main',
      user_id: 'usr_owner',
      name: 'Owner',
      email: 'owner@example.test',
      role: 'owner',
      status: 'online',
      last_seen_at: createdAt,
      created_at: createdAt,
      updated_at: createdAt,
    }],
    cloud_computers: [{
      id: 'cmp_remote',
      workspace_id: 'wsp_main',
      name: 'Remote Mac',
      status: 'connected',
      connected_via: 'daemon',
      runtime_ids: ['codex'],
      created_at: createdAt,
      updated_at: createdAt,
      last_seen_at: createdAt,
      daemon_connected_at: createdAt,
    }],
    cloud_agents: [{
      id: 'agt_remote',
      workspace_id: 'wsp_main',
      computer_id: 'cmp_remote',
      name: 'Remote Agent',
      runtime: 'codex',
      model: 'gpt-5.5',
      reasoning_effort: 'medium',
      status: 'busy',
      created_at: createdAt,
      updated_at: createdAt,
      status_updated_at: createdAt,
    }],
  };
  const pool = {
    async connect() {
      return {
        async query(sql) {
          const match = String(sql).match(/FROM "magclaw"\."([^"]+)"/);
          return { rows: match ? (rowsForTable[match[1]] || []) : [] };
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
  const state = {};
  await store.loadIntoState(state, { resetTransientRuntimeState: true, loadedAt: '2026-05-13T10:26:00.000Z' });

  assert.equal(state.computers[0].status, 'offline');
  assert.equal(state.computers[0].disconnectedAt, '2026-05-13T10:26:00.000Z');
  assert.equal(state.humans[0].status, 'offline');
  assert.equal(state.humans[0].presenceUpdatedAt, '2026-05-13T10:26:00.000Z');
  assert.equal(state.agents[0].status, 'idle');
  assert.deepEqual(state.agents[0].activeWorkItemIds, []);
  assert.equal(state.agents[0].runtimeActivity, null);
});

test('postgres store upserts duplicate durable state records without crashing', async () => {
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
    projects: [
      { id: 'project_duplicate', workspaceId: 'wsp_main', name: 'first', createdAt, updatedAt: createdAt },
      { id: 'project_duplicate', workspaceId: 'wsp_main', name: 'latest', createdAt, updatedAt: createdAt },
      { id: 'project_orphan', workspaceId: 'wsp_missing', name: 'fallback', createdAt, updatedAt: createdAt },
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
  assert.equal(stateRecordInserts[1].params[1], 'projects');
  assert.equal(stateRecordInserts[1].params[2], 'project_duplicate');
  assert.equal(JSON.parse(stateRecordInserts[1].params[6]).name, 'latest');
  const orphanInsert = stateRecordInserts.find((query) => query.params[2] === 'project_orphan');
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
