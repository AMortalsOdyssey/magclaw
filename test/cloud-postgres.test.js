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
});
