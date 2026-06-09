import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  databaseNameFromUrl,
  databaseUrlWithName,
  isTransientPostgresMigrationError,
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

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

test('postgres migration retries only transient startup errors', () => {
  assert.equal(isTransientPostgresMigrationError({ code: '40P01' }), true);
  assert.equal(isTransientPostgresMigrationError({ code: '40001' }), true);
  assert.equal(isTransientPostgresMigrationError({ code: '55P03' }), true);
  assert.equal(isTransientPostgresMigrationError({ code: '23514' }), false);
  assert.equal(isTransientPostgresMigrationError(new Error('deadlock detected')), false);
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
    'cloud_markdown_documents',
    'cloud_markdown_operations',
    'cloud_markdown_maintenance_runs',
    'cloud_channel_members',
    'cloud_conversation_read_states',
    'cloud_conversation_sequences',
    'cloud_audit_logs',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
    }
    assert.match(sql, /\bowner_user_id\b/);
    assert.match(sql, /\bmachine_fingerprint\b/);
    assert.match(sql, /\bruntime_details\b/);
    assert.match(sql, /\bstorage_mode\b/);
  assert.match(sql, /component IN \('web', 'daemon', 'computer', 'cliCore', 'teamSharing'\)/);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS cloud_release_notes_component_check/);
  assert.match(sql, /role IN \('member', 'admin', 'owner'\)/);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS cloud_computers_status_check/);
  assert.match(sql, /ADD CONSTRAINT cloud_computers_status_check[\s\S]*status IN \('pairing', 'connected', 'offline', 'disabled', 'upgrade_pending', 'upgrading', 'restarting', 'rollback', 'upgrade_failed'\)/);
  assert.match(sql, /status IN \('todo', 'in_progress', 'in_review', 'done', 'closed'\)/);
  assert.match(sql, /WHEN 'owner' THEN 'owner'/);
  assert.match(sql, /third_party_name/);
  assert.match(sql, /metadata #>> '\{oauth,feishu,providerAccountId\}'/);
  assert.match(sql, /third_party_provider = 'feishu'/);
  assert.match(sql, /cloud_users_active_normalized_email_uidx/);
  assert.match(sql, /cloud_messages_space_cursor_idx/);
  assert.match(sql, /cloud_conversation_sequences[\s\S]*next_seq BIGINT NOT NULL DEFAULT 1/);
  assert.match(sql, /cloud_conversation_sequences_updated_idx/);
  assert.match(sql, /cloud_channel_members_human_active_idx/);
  assert.match(sql, /cloud_conversation_read_states_space_idx/);
  assert.match(sql, /INSERT INTO cloud_channel_members[\s\S]*jsonb_array_elements_text/);
  assert.match(sql, /cloud_messages[\s\S]*space_seq BIGINT NOT NULL DEFAULT 0/);
  assert.match(sql, /cloud_messages[\s\S]*reactions JSONB NOT NULL DEFAULT '\[\]'::jsonb/);
  assert.match(sql, /cloud_messages[\s\S]*followed_by JSONB NOT NULL DEFAULT '\[\]'::jsonb/);
  assert.match(sql, /cloud_replies[\s\S]*space_type TEXT NOT NULL DEFAULT 'channel'/);
  assert.match(sql, /cloud_replies[\s\S]*space_seq BIGINT NOT NULL DEFAULT 0/);
  assert.match(sql, /INSERT INTO cloud_conversation_sequences[\s\S]*MAX\(space_seq\) \+ 1/);
  assert.match(sql, /cloud_markdown_operations[\s\S]*idempotency_key TEXT NOT NULL DEFAULT ''/);
  assert.match(sql, /cloud_markdown_operations_doc_sequence_uidx/);
  assert.match(sql, /cloud_markdown_operations_idempotency_uidx/);
  assert.match(sql, /cloud_markdown_maintenance_runs_workspace_created_idx/);
  assert.match(sql, /ON cloud_messages\(workspace_id, space_type, space_id, created_at DESC, id DESC\)/);
  assert.match(sql, /cloud_replies_workspace_parent_cursor_idx/);
  assert.match(sql, /cloud_replies[\s\S]*reactions JSONB NOT NULL DEFAULT '\[\]'::jsonb/);
  assert.match(sql, /ON cloud_replies\(workspace_id, parent_message_id, created_at DESC, id DESC\)/);
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
      status: 'online',
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
      status: 'busy',
      createdAt,
      updatedAt: createdAt,
    }],
    channels: [{
      id: 'chan_all',
      workspaceId: 'wsp_main',
      name: 'all',
      humanIds: ['hum_owner'],
      memberIds: ['hum_owner'],
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
      reactions: [{ key: 'rocket', emoji: '🚀', actorId: 'hum_owner', actorName: 'Owner', createdAt }],
      followedBy: ['hum_owner'],
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
      reactions: [{ key: 'heart', emoji: '❤️', actorId: 'hum_owner', actorName: 'Owner', createdAt }],
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
      status: 'closed',
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
      bytes: 42,
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
    'cloud_channel_members',
    'cloud_dms',
    'cloud_conversation_sequences',
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
  const computerInsert = queries.find((query) => query.sql.includes('INSERT INTO "magclaw"."cloud_computers"') && query.params[0] === 'cmp_remote');
  const humanInsert = queries.find((query) => query.sql.includes('INSERT INTO "magclaw"."cloud_humans"') && query.params[0] === 'hum_owner');
  const agentInsert = queries.find((query) => query.sql.includes('INSERT INTO "magclaw"."cloud_agents"') && query.params[0] === 'agt_remote');
  const channelMemberInsert = queries.find((query) => query.sql.includes('INSERT INTO "magclaw"."cloud_channel_members"') && query.params[0] === 'wsp_main');
  const channelMemberStaleUpdate = queries.find((query) => (
    query.sql.includes('WITH active_members(workspace_id, channel_id, human_id) AS')
    && query.sql.includes('UPDATE "magclaw"."cloud_channel_members" AS member')
  ));
  const sequenceInsert = queries.find((query) => query.sql.includes('INSERT INTO "magclaw"."cloud_conversation_sequences"') && query.params[0] === 'wsp_main');
  const messageInsert = queries.find((query) => query.sql.includes('INSERT INTO "magclaw"."cloud_messages"') && query.params[0] === 'msg_remote');
  const replyInsert = queries.find((query) => query.sql.includes('INSERT INTO "magclaw"."cloud_replies"') && query.params[0] === 'rep_remote');
  const taskInsert = queries.find((query) => query.sql.includes('INSERT INTO "magclaw"."cloud_tasks"') && query.params[0] === 'task_remote');
  const attachmentInsert = queries.find((query) => query.sql.includes('INSERT INTO "magclaw"."cloud_attachments"') && query.params[0] === 'att_remote');
  assert.equal(computerInsert.params[7], 'offline');
  assert.equal(humanInsert.params[6], 'offline');
  assert.equal(agentInsert.params[9], 'idle');
  assert.equal(JSON.parse(agentInsert.params[15]).state.status, 'idle');
  assert.equal(channelMemberInsert.params[1], 'chan_all');
  assert.equal(channelMemberInsert.params[2], 'hum_owner');
  assert.deepEqual(channelMemberStaleUpdate.params[0], ['wsp_main']);
  assert.equal(channelMemberStaleUpdate.params[1], 'wsp_main');
  assert.equal(channelMemberStaleUpdate.params[2], 'chan_all');
  assert.equal(channelMemberStaleUpdate.params[3], 'hum_owner');
  assert.equal(sequenceInsert.params[1], 'dm');
  assert.equal(sequenceInsert.params[2], 'dm_remote');
  assert.equal(sequenceInsert.params[3], 2);
  assert.match(messageInsert.sql, /\breactions\b/);
  assert.match(messageInsert.sql, /\bfollowed_by\b/);
  assert.match(messageInsert.sql, /\bspace_seq\b/);
  assert.match(replyInsert.sql, /\breactions\b/);
  assert.match(replyInsert.sql, /\bspace_type\b/);
  assert.match(replyInsert.sql, /\bspace_seq\b/);
  assert.equal(messageInsert.params[4], 1);
  assert.equal(replyInsert.params[5], 2);
  assert.match(JSON.stringify(messageInsert.params), /rocket/);
  assert.match(JSON.stringify(messageInsert.params), /hum_owner/);
  assert.match(JSON.stringify(replyInsert.params), /heart/);
  assert.equal(taskInsert.params[7], 'closed');
  assert.equal(attachmentInsert.params[6], 42);
});

test('postgres unread count query is user-scoped and read-fanout based', async () => {
  const queries = [];
  const pool = {
    async connect() {
      return {
        async query(sql, params = []) {
          queries.push({ sql, params });
          return {
            rows: [
              { space_type: 'channel', space_id: 'chan_all', unread_count: 2, joined: true, muted: false },
              { space_type: 'channel', space_id: 'chan_public', unread_count: 5, joined: false, muted: true },
              { space_type: 'dm', space_id: 'dm_one', unread_count: 1, joined: true, muted: false },
            ],
          };
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

  const result = await store.getUnreadCounts({ workspaceId: 'wsp_main', humanId: 'hum_reader' });
  const query = queries.find((item) => item.sql.includes('accessible_spaces'));

  assert.deepEqual(query.params, ['wsp_main', 'hum_reader']);
  assert.equal(result.globalUnread, 3);
  assert.equal(result.spaces.find((space) => space.spaceId === 'chan_public')?.unreadCount, 5);
  assert.equal(result.spaces.find((space) => space.spaceId === 'chan_public')?.muted, true);
  assert.match(query.sql, /cloud_channel_members/);
  assert.match(query.sql, /cloud_conversation_read_states/);
  assert.match(query.sql, /GROUP BY member\.workspace_id, member\.human_id/);
  assert.match(query.sql, /COUNT\(DISTINCT message\.id\)::int AS unread_count/);
  assert.match(query.sql, /COUNT\(DISTINCT reply\.id\)::int AS unread_count/);
  assert.match(query.sql, /message\.author_type IN \('user', 'human', 'agent'\)/);
  assert.match(query.sql, /reply\.author_type IN \('user', 'human', 'agent'\)/);
  assert.match(query.sql, /NOT \(message\.author_type IN \('user', 'human'\) AND message\.author_id = \$2\)/);
  assert.match(query.sql, /thread_read\.thread_root_id = message\.id/);
  assert.match(query.sql, /thread_read\.thread_root_id = parent\.id/);
  assert.match(query.sql, /OR NOT/);
});

test('postgres store indexes markdown document operations and maintenance runs', async () => {
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

  await store.persistMarkdownDocumentIndex({
    workspaceId: 'wsp_main',
    agentId: 'agt_one',
    relPath: 'MEMORY.md',
    revision: 2,
    documentHash: 'hash_after',
    currentSegment: 1,
    updatedAt: '2026-05-21T00:00:00.000Z',
  });
  await store.persistMarkdownOperationIndex({
    operationId: 'mdop_one',
    workspaceId: 'wsp_main',
    agentId: 'agt_one',
    relPath: 'MEMORY.md',
    sequence: 2,
    revision: 2,
    segmentIndex: 1,
    idempotencyKey: 'idem-one',
    status: 'applied',
    operation: { type: 'upsert_bullet' },
    beforeHash: 'hash_before',
    afterHash: 'hash_after',
    sourceTrigger: 'test',
    createdAt: '2026-05-21T00:00:00.000Z',
    appliedAt: '2026-05-21T00:00:01.000Z',
  });
  await store.persistMarkdownMaintenanceRun({
    id: 'maint_one',
    workspaceId: 'wsp_main',
    agentId: 'agt_one',
    relPath: 'MEMORY.md',
    status: 'completed',
    model: 'qwen-test',
    beforeHash: 'hash_before',
    afterHash: 'hash_after',
    summary: 'merged duplicate headings',
    createdAt: '2026-05-21T00:00:02.000Z',
  });

  assert.ok(queries.some((query) => query.sql.includes('INSERT INTO "magclaw"."cloud_markdown_documents"')));
  assert.ok(queries.some((query) => query.sql.includes('INSERT INTO "magclaw"."cloud_markdown_operations"')));
  assert.ok(queries.some((query) => query.sql.includes('INSERT INTO "magclaw"."cloud_markdown_maintenance_runs"')));
  const operationQuery = queries.find((query) => query.sql.includes('cloud_markdown_operations'));
  assert.match(operationQuery.sql, /ON CONFLICT DO NOTHING/);
  assert.match(operationQuery.sql, /existing\.operation_id = incoming\.operation_id/);
  assert.equal(operationQuery.params[0], 'mdop_one');
  assert.equal(JSON.parse(operationQuery.params[9]).type, 'upsert_bullet');
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

test('postgres store deletes one computer through queued deleteComputer', async () => {
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
  await store.deleteComputer('cmp_pending', 'wsp_main');
  const deleteQuery = queries.find((query) => (
    query.sql.includes('DELETE FROM "magclaw"."cloud_computers"')
    && query.sql.includes('id = $1')
  ));
  assert.ok(deleteQuery, 'expected deleteComputer to remove the requested cloud computer row');
  assert.deepEqual(deleteQuery.params, ['cmp_pending', 'wsp_main']);
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
    cloud_messages: [{
      id: 'msg_reacted',
      workspace_id: 'wsp_main',
      space_type: 'channel',
      space_id: 'chan_all',
      author_type: 'human',
      author_id: 'hum_owner',
      body: 'React here',
      reply_count: 1,
      reactions: [{ key: 'rocket', emoji: '🚀', actorId: 'hum_owner', actorName: 'Owner', createdAt }],
      followed_by: ['hum_owner'],
      saved_by: [],
      read_by: [],
      created_at: createdAt,
      updated_at: createdAt,
    }],
    cloud_replies: [{
      id: 'rep_reacted',
      workspace_id: 'wsp_main',
      parent_message_id: 'msg_reacted',
      author_type: 'agent',
      author_id: 'agt_remote',
      body: 'React back',
      reactions: [{ key: 'heart', emoji: '❤️', actorId: 'hum_owner', actorName: 'Owner', createdAt }],
      saved_by: [],
      read_by: [],
      created_at: createdAt,
      updated_at: createdAt,
    }],
    cloud_attachments: [{
      id: 'att_image',
      workspace_id: 'wsp_main',
      storage_key: '2026/05/att_image-note.png',
      storage_mode: 'pvc',
      filename: 'note.png',
      mime_type: 'image/png',
      size_bytes: 8,
      checksum_sha256: 'sha256-demo',
      source: 'upload',
      created_by: 'hum_owner',
      created_at: createdAt,
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
    attachmentBaseDir: '/var/lib/magclaw/uploads',
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
  assert.equal(state.packageVersions, undefined);
  assert.equal(state.attachments[0].url, '/api/attachments/att_image/note.png?workspaceId=wsp_main');
  assert.equal(state.attachments[0].path, '/var/lib/magclaw/uploads/2026/05/att_image-note.png');
  assert.equal(state.attachments[0].relativePath, '2026/05/att_image-note.png');
  assert.equal(state.attachments[0].bytes, 8);
  assert.deepEqual(state.messages[0].reactions.map((item) => item.key), ['rocket']);
  assert.deepEqual(state.messages[0].followedBy, ['hum_owner']);
  assert.deepEqual(state.replies[0].reactions.map((item) => item.key), ['heart']);
});

test('postgres store merges team sharing state records across workspaces on load', async () => {
  const createdAt = '2026-06-01T00:00:00.000Z';
  const rowsForTable = {
    cloud_state_records: [
      {
        workspace_id: 'wsp_owner',
        kind: 'teamSharing',
        id: 'value',
        position: 0,
        payload: {
          sessions: {
            sess_shared: { sessionId: 'sess_shared', workspaceId: 'wsp_owner', channelId: 'chan_owner', abstractRevision: 3, updatedAt: '2026-06-01T00:03:00.000Z' },
          },
          events: {
            sess_shared: [
              { eventId: 'evt_1', ordinal: 1, createdAt },
              { eventId: 'evt_2', ordinal: 2, createdAt: '2026-06-01T00:02:00.000Z' },
            ],
          },
          abstracts: {
            sess_shared: { revision: 3, abstractMarkdown: '# Owner' },
          },
          vectorDocuments: [
            { vectorDocumentId: 'sess_shared:L0', sessionId: 'sess_shared', workspaceId: 'wsp_owner', layer: 'L0' },
          ],
        },
      },
      {
        workspace_id: 'wsp_other',
        kind: 'teamSharing',
        id: 'value',
        position: 0,
        payload: {
          sessions: {
            sess_other: { sessionId: 'sess_other', workspaceId: 'wsp_other', channelId: 'chan_other', abstractRevision: 1, updatedAt: createdAt },
            sess_shared: { sessionId: 'sess_shared', workspaceId: 'wsp_owner', channelId: 'chan_stale', abstractRevision: 1, updatedAt: createdAt },
          },
          events: {
            sess_other: [{ eventId: 'evt_other', ordinal: 1, createdAt }],
            sess_shared: [{ eventId: 'evt_1', ordinal: 1, createdAt }],
          },
          abstracts: {
            sess_other: { revision: 1, abstractMarkdown: '# Other' },
            sess_shared: { revision: 1, abstractMarkdown: '# Stale' },
          },
        },
      },
    ],
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
  await store.loadIntoState(state);

  assert.equal(state.teamSharing.sessions.sess_shared.channelId, 'chan_owner');
  assert.equal(state.teamSharing.sessions.sess_shared.abstractRevision, 3);
  assert.equal(state.teamSharing.abstracts.sess_shared.revision, 3);
  assert.deepEqual(state.teamSharing.events.sess_shared.map((event) => event.eventId), ['evt_1', 'evt_2']);
  assert.equal(state.teamSharing.sessions.sess_other.channelId, 'chan_other');
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
  assert.equal(stateRecordInserts.length, 1);
  assert.match(stateRecordInserts[0].sql, /ON CONFLICT \(workspace_id, kind, id\) DO UPDATE SET/);
  assert.equal(stateRecordInserts[0].params[1], 'projects');
  assert.equal(stateRecordInserts[0].params[2], 'project_duplicate');
  assert.equal(JSON.parse(stateRecordInserts[0].params[6]).name, 'latest');
  const orphanInsert = stateRecordInserts.find((query) => query.params[2] === 'project_orphan');
  assert.equal(orphanInsert, undefined);
});

test('postgres store persists team sharing object as durable state', async () => {
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
  const createdAt = '2026-06-01T00:00:00.000Z';
  await store.persistFromState({
    connection: { workspaceId: 'wsp_main' },
    teamSharing: {
      sessions: { sess_1: { sessionId: 'sess_1', channelId: 'chan_team' } },
      vectorDocuments: [{ vectorDocumentId: 'sess_1:L0', layer: 'L0' }],
    },
    cloud: {
      workspaces: [{ id: 'wsp_main', slug: 'main', name: 'Main', createdAt, updatedAt: createdAt }],
      users: [],
      workspaceMembers: [],
      sessions: [],
      invitations: [],
      passwordResetTokens: [],
    },
  });

  const stateRecordInsert = queries.find((query) => query.sql.includes('INSERT INTO "magclaw"."cloud_state_records"'));
  assert.ok(stateRecordInsert);
  const rows = [];
  for (let index = 0; index < stateRecordInsert.params.length; index += 7) {
    rows.push(stateRecordInsert.params.slice(index, index + 7));
  }
  const teamSharingRow = rows.find((row) => row[1] === 'teamSharing');
  assert.ok(teamSharingRow);
  assert.equal(teamSharingRow[0], 'wsp_main');
  assert.equal(teamSharingRow[2], 'value');
  assert.equal(JSON.parse(teamSharingRow[6]).sessions.sess_1.channelId, 'chan_team');
});

test('postgres store persists scoped team sharing state to the requested workspace', async () => {
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
  const createdAt = '2026-06-01T00:00:00.000Z';
  await store.persistWorkspaceFromState({
    connection: { workspaceId: 'wsp_other' },
    teamSharing: {
      sessions: {
        sess_main: { sessionId: 'sess_main', workspaceId: 'wsp_main', channelId: 'chan_main', abstractRevision: 2 },
        sess_other: { sessionId: 'sess_other', workspaceId: 'wsp_other', channelId: 'chan_other', abstractRevision: 1 },
      },
      events: {
        sess_main: [{ eventId: 'evt_main', ordinal: 1, createdAt }],
        sess_other: [{ eventId: 'evt_other', ordinal: 1, createdAt }],
      },
      abstracts: {
        sess_main: { revision: 2, abstractMarkdown: '# Main' },
        sess_other: { revision: 1, abstractMarkdown: '# Other' },
      },
      vectorDocuments: [
        { vectorDocumentId: 'sess_main:L0', sessionId: 'sess_main', workspaceId: 'wsp_main', layer: 'L0' },
        { vectorDocumentId: 'sess_other:L0', sessionId: 'sess_other', workspaceId: 'wsp_other', layer: 'L0' },
      ],
      shares: [
        { id: 'share_main', workspaceId: 'wsp_main', title: 'Main share', updatedAt: createdAt },
        { id: 'share_other', workspaceId: 'wsp_other', title: 'Other share', updatedAt: createdAt },
      ],
      assets: [
        { id: 'asset_main', workspaceId: 'wsp_main', filename: 'main.mp4', updatedAt: createdAt },
        { id: 'asset_other', workspaceId: 'wsp_other', filename: 'other.mp4', updatedAt: createdAt },
      ],
      shareContents: [
        { id: 'shc_main', workspaceId: 'wsp_main', contentHash: 'hash_main', content: '<h1>Main</h1>', updatedAt: createdAt },
        { id: 'shc_other', workspaceId: 'wsp_other', contentHash: 'hash_other', content: '<h1>Other</h1>', updatedAt: createdAt },
      ],
    },
    cloud: {
      workspaces: [
        { id: 'wsp_main', slug: 'main', name: 'Main', createdAt, updatedAt: createdAt },
        { id: 'wsp_other', slug: 'other', name: 'Other', createdAt, updatedAt: createdAt },
      ],
      users: [],
      workspaceMembers: [],
      sessions: [],
      invitations: [],
      passwordResetTokens: [],
    },
  }, 'wsp_main');

  const stateRecordInsert = queries.find((query) => query.sql.includes('INSERT INTO "magclaw"."cloud_state_records"'));
  assert.ok(stateRecordInsert);
  const rows = [];
  for (let index = 0; index < stateRecordInsert.params.length; index += 7) {
    rows.push(stateRecordInsert.params.slice(index, index + 7));
  }
  const teamSharingRow = rows.find((row) => row[1] === 'teamSharing');
  assert.ok(teamSharingRow);
  assert.equal(teamSharingRow[0], 'wsp_main');
  const payload = JSON.parse(teamSharingRow[6]);
  assert.deepEqual(Object.keys(payload.sessions), ['sess_main']);
  assert.equal(payload.abstracts.sess_main.revision, 2);
  assert.equal(payload.sessions.sess_other, undefined);
  assert.equal(payload.vectorDocuments.some((doc) => doc.sessionId === 'sess_other'), false);
  assert.deepEqual(payload.shares.map((share) => share.id), ['share_main']);
  assert.deepEqual(payload.assets.map((asset) => asset.id), ['asset_main']);
  assert.deepEqual(payload.shareContents.map((blob) => blob.id), ['shc_main']);
});

test('postgres store skips default local placeholder workspace runtime persistence', async () => {
  const queries = [];
  const pool = {
    async connect() {
      return {
        async query(sql, params = []) {
          queries.push({ sql, params });
          if (sql.includes('INSERT INTO "magclaw"."cloud_channels"')) {
            throw new Error('should not persist placeholder local channels');
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
  const createdAt = '2026-05-18T00:00:00.000Z';
  await store.persistWorkspaceFromState({
    connection: { workspaceId: 'local' },
    cloud: {
      workspaces: [{ id: 'local', slug: 'local', name: 'MagClaw', createdAt }],
      workspaceMembers: [],
    },
    channels: [{ id: 'chan_local', workspaceId: 'local', name: 'all', createdAt, updatedAt: createdAt }],
  }, 'local');

  assert.equal(queries.some((query) => query.sql.includes('cloud_channels')), false);
});

test('postgres store skips default local placeholder workspace auth persistence', async () => {
  const queries = [];
  const pool = {
    async connect() {
      return {
        async query(sql, params = []) {
          queries.push({ sql, params });
          if (sql.includes('INSERT INTO "magclaw"."cloud_workspaces"') && params[0] === 'local') {
            throw new Error('should not persist placeholder local workspace');
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
  const createdAt = '2026-05-18T00:00:00.000Z';
  await store.persistAuthFromState({
    cloud: {
      workspaces: [{ id: 'local', slug: 'local', name: 'MagClaw', createdAt }],
      users: [],
      workspaceMembers: [],
      sessions: [],
      invitations: [],
      passwordResetTokens: [],
    },
  });

  assert.equal(queries.some((query) => query.sql.includes('cloud_workspaces')), false);
});

test('postgres store can persist a single workspace runtime snapshot', async () => {
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
  await store.persistWorkspaceFromState({
    cloud: {
      workspaces: [
        { id: 'wsp_one', slug: 'one', name: 'One', createdAt, updatedAt: createdAt },
        { id: 'wsp_two', slug: 'two', name: 'Two', createdAt, updatedAt: createdAt },
      ],
    },
    computers: [
      { id: 'cmp_one', workspaceId: 'wsp_one', name: 'One Mac', status: 'connected', createdAt, updatedAt: createdAt },
      { id: 'cmp_two', workspaceId: 'wsp_two', name: 'Two Mac', status: 'connected', createdAt, updatedAt: createdAt },
    ],
    channels: [
      { id: 'chan_one', workspaceId: 'wsp_one', name: 'one', createdAt, updatedAt: createdAt },
      { id: 'chan_two', workspaceId: 'wsp_two', name: 'two', createdAt, updatedAt: createdAt },
    ],
    messages: [
      { id: 'msg_one', workspaceId: 'wsp_one', spaceType: 'channel', spaceId: 'chan_one', authorType: 'human', authorId: 'hum_one', body: 'one', createdAt, updatedAt: createdAt },
      { id: 'msg_two', workspaceId: 'wsp_two', spaceType: 'channel', spaceId: 'chan_two', authorType: 'human', authorId: 'hum_two', body: 'two', createdAt, updatedAt: createdAt },
    ],
  }, 'wsp_one');

  const deleteQueries = queries.filter((query) => query.sql.includes('DELETE FROM "magclaw"'));
  assert.ok(deleteQueries.length);
  for (const query of deleteQueries) assert.deepEqual(query.params[0], ['wsp_one']);
  assert.equal(queries.some((query) => query.params?.includes?.('chan_two') || query.params?.includes?.('msg_two') || query.params?.includes?.('cmp_two')), false);
  assert.equal(queries.some((query) => query.params?.includes?.('chan_one') || query.params?.includes?.('msg_one') || query.params?.includes?.('cmp_one')), true);
});

test('postgres store does not mis-scope or duplicate channel rows during workspace runtime persistence', async () => {
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
  const updatedAt = '2026-05-13T00:00:01.000Z';

  await store.persistWorkspaceFromState({
    connection: { workspaceId: 'wsp_two' },
    cloud: {
      workspaces: [
        { id: 'wsp_one', slug: 'one', name: 'One', createdAt, updatedAt: createdAt },
        { id: 'wsp_two', slug: 'two', name: 'Two', createdAt, updatedAt: createdAt },
      ],
    },
    channels: [
      { id: 'chan_shared', workspaceId: 'wsp_one', name: 'all', createdAt, updatedAt: createdAt },
      { id: 'chan_shared', name: 'all', createdAt, updatedAt: createdAt },
      { id: 'chan_two', workspaceId: 'wsp_two', name: 'two-old', createdAt, updatedAt: createdAt },
      { id: 'chan_two', workspaceId: 'wsp_two', name: 'two-latest', createdAt, updatedAt },
    ],
  }, 'wsp_two');

  const channelInsert = queries.find((query) => query.sql.includes('INSERT INTO "magclaw"."cloud_channels"'));
  assert.ok(channelInsert);
  const rows = [];
  for (let index = 0; index < channelInsert.params.length; index += 8) {
    rows.push(channelInsert.params.slice(index, index + 8));
  }
  assert.deepEqual(rows.map((row) => row[0]), ['chan_two']);
  assert.equal(rows[0][1], 'wsp_two');
  assert.equal(rows[0][2], 'two-latest');
});

test('postgres store runs different workspace runtime persists concurrently', async () => {
  const entered = {
    wsp_one: deferred(),
    wsp_two: deferred(),
  };
  const release = {
    wsp_one: deferred(),
    wsp_two: deferred(),
  };
  const queries = [];
  const pool = {
    async connect() {
      return {
        async query(sql, params = []) {
          queries.push({ sql, params });
          const workspaceIds = params[0];
          if (
            sql.includes('WITH')
            && sql.includes('cloud_state_records')
            && Array.isArray(workspaceIds)
            && workspaceIds.length === 1
            && entered[workspaceIds[0]]
          ) {
            entered[workspaceIds[0]].resolve();
            await release[workspaceIds[0]].promise;
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
    poolMax: 10,
  });
  const createdAt = '2026-05-13T00:00:00.000Z';
  const state = {
    cloud: {
      workspaces: [
        { id: 'wsp_one', slug: 'one', name: 'One', createdAt, updatedAt: createdAt },
        { id: 'wsp_two', slug: 'two', name: 'Two', createdAt, updatedAt: createdAt },
      ],
    },
    channels: [
      { id: 'chan_one', workspaceId: 'wsp_one', name: 'one', createdAt, updatedAt: createdAt },
      { id: 'chan_two', workspaceId: 'wsp_two', name: 'two', createdAt, updatedAt: createdAt },
    ],
  };

  const firstPersist = store.persistWorkspaceFromState(state, 'wsp_one');
  await entered.wsp_one.promise;
  const secondPersist = store.persistWorkspaceFromState(state, 'wsp_two');
  try {
    assert.equal(
      await Promise.race([
        entered.wsp_two.promise.then(() => true),
        delay(50).then(() => false),
      ]),
      true,
    );
  } finally {
    release.wsp_one.resolve();
    release.wsp_two.resolve();
  }
  await Promise.all([firstPersist, secondPersist]);

  assert.ok(queries.some((query) => Array.isArray(query.params[0]) && query.params[0][0] === 'wsp_one'));
  assert.ok(queries.some((query) => Array.isArray(query.params[0]) && query.params[0][0] === 'wsp_two'));
});

test('postgres store keeps same workspace runtime persists serial', async () => {
  let activeRuntimeDeletes = 0;
  let maxActiveRuntimeDeletes = 0;
  const releaseFirst = deferred();
  const firstEntered = deferred();
  const queries = [];
  const pool = {
    async connect() {
      return {
        async query(sql, params = []) {
          queries.push({ sql, params });
          if (
            sql.includes('WITH')
            && sql.includes('cloud_state_records')
            && Array.isArray(params[0])
            && params[0][0] === 'wsp_one'
          ) {
            activeRuntimeDeletes += 1;
            maxActiveRuntimeDeletes = Math.max(maxActiveRuntimeDeletes, activeRuntimeDeletes);
            firstEntered.resolve();
            if (queries.filter((query) => query.sql.includes('cloud_state_records')).length === 1) {
              await releaseFirst.promise;
            }
            activeRuntimeDeletes -= 1;
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
    poolMax: 10,
  });
  const createdAt = '2026-05-13T00:00:00.000Z';
  const state = {
    cloud: {
      workspaces: [{ id: 'wsp_one', slug: 'one', name: 'One', createdAt, updatedAt: createdAt }],
    },
    channels: [{ id: 'chan_one', workspaceId: 'wsp_one', name: 'one', createdAt, updatedAt: createdAt }],
  };

  const firstPersist = store.persistWorkspaceFromState(state, 'wsp_one');
  await firstEntered.promise;
  const secondPersist = store.persistWorkspaceFromState(state, 'wsp_one');
  try {
    await delay(50);
    assert.equal(maxActiveRuntimeDeletes, 1);
  } finally {
    releaseFirst.resolve();
  }
  await Promise.all([firstPersist, secondPersist]);
  assert.equal(maxActiveRuntimeDeletes, 1);
});

test('postgres store lets narrow auth operations bypass blocked workspace runtime persists', async () => {
  const workspaceEntered = deferred();
  const releaseWorkspace = deferred();
  const authEntered = deferred();
  const queries = [];
  const pool = {
    async connect() {
      return {
        async query(sql, params = []) {
          queries.push({ sql, params });
          if (
            sql.includes('WITH')
            && sql.includes('cloud_state_records')
            && Array.isArray(params[0])
            && params[0][0] === 'wsp_main'
          ) {
            workspaceEntered.resolve();
            await releaseWorkspace.promise;
          }
          if (sql.includes('INSERT INTO "magclaw"."cloud_sessions"')) {
            authEntered.resolve();
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
    poolMax: 10,
  });
  const createdAt = '2026-05-13T00:00:00.000Z';
  const runtimePersist = store.persistWorkspaceFromState({
    cloud: {
      workspaces: [{ id: 'wsp_main', slug: 'main', name: 'Main', createdAt, updatedAt: createdAt }],
    },
    channels: [{ id: 'chan_main', workspaceId: 'wsp_main', name: 'main', createdAt, updatedAt: createdAt }],
  }, 'wsp_main');
  await workspaceEntered.promise;
  const authPersist = store.persistAuthOperation({
    type: 'login',
    user: {
      id: 'usr_login',
      lastLoginAt: '2026-05-13T01:00:00.000Z',
    },
    session: {
      id: 'sess_login',
      userId: 'usr_login',
      tokenHash: 'token_hash',
      createdAt: '2026-05-13T01:00:00.000Z',
      expiresAt: '2026-06-12T01:00:00.000Z',
      userAgent: 'node-test',
      ipHash: 'ip_hash',
      revokedAt: null,
    },
  });
  try {
    assert.equal(
      await Promise.race([
        authEntered.promise.then(() => true),
        delay(50).then(() => false),
      ]),
      true,
    );
  } finally {
    releaseWorkspace.resolve();
  }
  await Promise.all([runtimePersist, authPersist]);
});

test('postgres store treats full snapshot persistence as a runtime barrier', async () => {
  const firstWorkspaceEntered = deferred();
  const releaseFirstWorkspace = deferred();
  const fullSnapshotEntered = deferred();
  const releaseFullSnapshot = deferred();
  const secondWorkspaceEntered = deferred();
  const runtimeDeleteOrder = [];
  const pool = {
    async connect() {
      return {
        async query(sql, params = []) {
          if (
            sql.includes('WITH')
            && sql.includes('cloud_state_records')
            && Array.isArray(params[0])
          ) {
            const ids = params[0].join(',');
            runtimeDeleteOrder.push(ids);
            if (ids === 'wsp_one') {
              firstWorkspaceEntered.resolve();
              await releaseFirstWorkspace.promise;
            } else if (ids === 'wsp_one,wsp_two') {
              fullSnapshotEntered.resolve();
              await releaseFullSnapshot.promise;
            } else if (ids === 'wsp_two') {
              secondWorkspaceEntered.resolve();
            }
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
    poolMax: 10,
  });
  const createdAt = '2026-05-13T00:00:00.000Z';
  const state = {
    cloud: {
      workspaces: [
        { id: 'wsp_one', slug: 'one', name: 'One', createdAt, updatedAt: createdAt },
        { id: 'wsp_two', slug: 'two', name: 'Two', createdAt, updatedAt: createdAt },
      ],
      users: [],
      workspaceMembers: [],
      sessions: [],
    },
    channels: [
      { id: 'chan_one', workspaceId: 'wsp_one', name: 'one', createdAt, updatedAt: createdAt },
      { id: 'chan_two', workspaceId: 'wsp_two', name: 'two', createdAt, updatedAt: createdAt },
    ],
  };

  const firstPersist = store.persistWorkspaceFromState(state, 'wsp_one');
  await firstWorkspaceEntered.promise;
  const fullPersist = store.persistFromState(state);
  const secondPersist = store.persistWorkspaceFromState(state, 'wsp_two');
  assert.equal(
    await Promise.race([
      fullSnapshotEntered.promise.then(() => true),
      delay(50).then(() => false),
    ]),
    false,
  );

  releaseFirstWorkspace.resolve();
  await fullSnapshotEntered.promise;
  assert.equal(
    await Promise.race([
      secondWorkspaceEntered.promise.then(() => true),
      delay(50).then(() => false),
    ]),
    false,
  );

  releaseFullSnapshot.resolve();
  await Promise.all([firstPersist, fullPersist, secondPersist]);
  assert.deepEqual(runtimeDeleteOrder, ['wsp_one', 'wsp_one,wsp_two', 'wsp_two']);
});

test('postgres workspace persistence preserves newer agent and human fields during upsert', async () => {
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
  await store.persistWorkspaceFromState({
    humans: [{ id: 'hum_main', workspaceId: 'wsp_main', name: 'Human', status: 'online', lastSeenAt: createdAt, createdAt, updatedAt: createdAt }],
    computers: [{ id: 'cmp_main' }],
    agents: [{ id: 'agt_main', workspaceId: 'wsp_main', computerId: 'cmp_main', name: 'Agent', description: 'fresh', status: 'idle', createdAt, updatedAt: createdAt, statusUpdatedAt: createdAt }],
    channels: [],
    dms: [],
    messages: [],
    replies: [],
    tasks: [],
    workItems: [],
    attachments: [],
    reminders: [],
    missions: [],
    runs: [],
    projects: [],
    cloud: {
      workspaces: [{ id: 'wsp_main', slug: 'main', name: 'Main', createdAt, updatedAt: createdAt }],
    },
  }, 'wsp_main');

  const runtimeDelete = queries.find((query) => query.sql.includes('WITH') && query.sql.includes('cloud_state_records'));
  assert.ok(runtimeDelete);
  assert.equal(runtimeDelete.sql.includes('cloud_agents'), false);
  assert.equal(runtimeDelete.sql.includes('cloud_humans'), false);
  assert.ok(queries.some((query) => query.sql.includes('DELETE FROM "magclaw"."cloud_agents"') && query.sql.includes('AND NOT (id = ANY($2::text[]))')));
  const agentInsert = queries.find((query) => query.sql.includes('INSERT INTO "magclaw"."cloud_agents"'));
  const humanInsert = queries.find((query) => query.sql.includes('INSERT INTO "magclaw"."cloud_humans"'));
  assert.match(agentInsert.sql, /ON CONFLICT \(id\) DO UPDATE SET/);
  assert.match(agentInsert.sql, /description = CASE WHEN/);
  assert.match(agentInsert.sql, /status_updated_at = CASE/);
  assert.match(humanInsert.sql, /status = CASE WHEN/);
  assert.match(humanInsert.sql, /last_seen_at = CASE/);
});

test('postgres computer upsert keeps a newer connected daemon row from stale offline snapshots', async () => {
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
    computers: [{ id: 'cmp_main', workspaceId: 'wsp_main', name: 'Computer', status: 'offline', connectedVia: 'daemon', createdAt, updatedAt: createdAt, lastSeenAt: createdAt }],
    cloud: {
      workspaces: [{ id: 'wsp_main', slug: 'main', name: 'Main', createdAt, updatedAt: createdAt }],
      users: [],
      workspaceMembers: [],
      sessions: [],
      invitations: [],
      passwordResetTokens: [],
      computerTokens: [],
      pairingTokens: [],
    },
  });

  const computerInsert = queries.find((query) => query.sql.includes('INSERT INTO "magclaw"."cloud_computers"'));
  assert.match(computerInsert.sql, /EXCLUDED\.status = 'offline'/);
  assert.match(computerInsert.sql, /"magclaw"\."cloud_computers"\.status = 'connected'/);
  assert.match(computerInsert.sql, /last_seen_at = CASE/);
});

test('postgres store publishes and listens for realtime invalidation events', async () => {
  const queries = [];
  const listenerClient = new EventEmitter();
  listenerClient.query = async (sql, params = []) => {
    queries.push({ sql, params });
    return { rows: [] };
  };
  listenerClient.release = () => {};
  const pool = {
    async connect() {
      return listenerClient;
    },
  };
  const store = createStore({
    databaseUrl: 'postgresql://user:secret@example.test:5432/postgres',
    database: 'magclaw_cloud',
    schema: 'magclaw',
    realtimeChannel: 'magclaw_realtime_test',
    pool,
  });

  await store.publishRealtimeEvent({
    sourceId: 'rt_source',
    workspaceId: 'wsp_main',
    reason: 'workspace_state_changed',
  });
  const notify = queries.find((query) => query.sql.includes('pg_notify'));
  assert.ok(notify);
  assert.equal(notify.params[0], 'magclaw_realtime_test');
  assert.equal(JSON.parse(notify.params[1]).workspaceId, 'wsp_main');

  const events = [];
  const stop = await store.subscribeRealtimeEvents((event) => events.push(event));
  assert.ok(queries.some((query) => /LISTEN "magclaw_realtime_test"/.test(query.sql)));
  listenerClient.emit('notification', {
    channel: 'magclaw_realtime_test',
    payload: JSON.stringify({ sourceId: 'rt_other', workspaceId: 'wsp_main', reason: 'test' }),
  });
  assert.equal(events[0].workspaceId, 'wsp_main');
  await stop();
  assert.ok(queries.some((query) => /UNLISTEN "magclaw_realtime_test"/.test(query.sql)));
});

test('postgres store reloads a single workspace without replacing other workspace rows', async () => {
  const queries = [];
  const createdAt = '2026-05-13T00:00:00.000Z';
  const pool = {
    async connect() {
      return {
        async query(sql, params = []) {
          queries.push({ sql, params });
          if (sql.includes('cloud_humans')) {
            return { rows: [{ id: 'hum_one_new', workspace_id: 'wsp_one', user_id: 'usr_one', name: 'One New', email: 'one@example.test', role: 'member', status: 'offline', avatar: '', description: '', created_at: createdAt, updated_at: createdAt }] };
          }
          if (sql.includes('cloud_channels')) {
            return { rows: [{ id: 'chan_one_new', workspace_id: 'wsp_one', name: 'one-new', description: '', archived_at: null, created_at: createdAt, updated_at: createdAt, metadata: { state: { humanIds: ['hum_one_new'], memberIds: ['hum_one_new'] } } }] };
          }
          if (sql.includes('cloud_state_records')) {
            return {
              rows: [{
                workspace_id: 'wsp_one',
                kind: 'teamSharing',
                id: 'value',
                position: 0,
                payload: {
                  sessions: {
                    sess_one_new: { sessionId: 'sess_one_new', workspaceId: 'wsp_one', channelId: 'chan_one_new', abstractRevision: 1 },
                  },
                  abstracts: {
                    sess_one_new: { revision: 1, abstractMarkdown: '# One New' },
                  },
                  vectorDocuments: [
                    { vectorDocumentId: 'sess_one_new:L0', sessionId: 'sess_one_new', workspaceId: 'wsp_one', layer: 'L0' },
                  ],
                },
              }],
            };
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
  const state = {
    humans: [
      { id: 'hum_one_old', workspaceId: 'wsp_one', name: 'Old One' },
      { id: 'hum_two', workspaceId: 'wsp_two', name: 'Two' },
    ],
    computers: [],
    agents: [],
    channels: [
      { id: 'chan_one_old', workspaceId: 'wsp_one', name: 'old-one' },
      { id: 'chan_two', workspaceId: 'wsp_two', name: 'two' },
    ],
    dms: [],
    messages: [],
    replies: [],
    tasks: [],
    workItems: [],
    attachments: [],
    reminders: [],
    missions: [],
    runs: [],
    projects: [],
    teamSharing: {
      sessions: {
        sess_one_old: { sessionId: 'sess_one_old', workspaceId: 'wsp_one', channelId: 'chan_one_old', abstractRevision: 1 },
        sess_two: { sessionId: 'sess_two', workspaceId: 'wsp_two', channelId: 'chan_two', abstractRevision: 1 },
      },
      abstracts: {
        sess_one_old: { revision: 1, abstractMarkdown: '# One Old' },
        sess_two: { revision: 1, abstractMarkdown: '# Two' },
      },
      vectorDocuments: [
        { vectorDocumentId: 'sess_one_old:L0', sessionId: 'sess_one_old', workspaceId: 'wsp_one', layer: 'L0' },
        { vectorDocumentId: 'sess_two:L0', sessionId: 'sess_two', workspaceId: 'wsp_two', layer: 'L0' },
      ],
    },
  };
  await store.loadWorkspaceIntoState(state, 'wsp_one');
  assert.equal(state.humans.some((human) => human.id === 'hum_one_old'), false);
  assert.equal(state.channels.some((channel) => channel.id === 'chan_one_old'), false);
  assert.equal(state.humans.some((human) => human.id === 'hum_two'), true);
  assert.equal(state.channels.some((channel) => channel.id === 'chan_two'), true);
  assert.equal(state.humans.some((human) => human.id === 'hum_one_new'), true);
  assert.equal(state.channels.some((channel) => channel.id === 'chan_one_new'), true);
  assert.equal(state.teamSharing.sessions.sess_one_old, undefined);
  assert.equal(state.teamSharing.sessions.sess_one_new.channelId, 'chan_one_new');
  assert.equal(state.teamSharing.sessions.sess_two.channelId, 'chan_two');
  assert.equal(state.teamSharing.abstracts.sess_one_new.revision, 1);
  assert.equal(state.teamSharing.vectorDocuments.some((doc) => doc.sessionId === 'sess_one_old'), false);
  assert.ok(queries.some((query) => query.sql.includes('cloud_humans') && query.params[0] === 'wsp_one'));
});

test('postgres workspace reload preserves recovered Team Sharing state when no scoped row exists', async () => {
  const createdAt = '2026-05-13T00:00:00.000Z';
  const pool = {
    async connect() {
      return {
        async query(sql) {
          if (sql.includes('cloud_humans')) {
            return { rows: [{ id: 'hum_one_new', workspace_id: 'wsp_one', user_id: 'usr_one', name: 'One New', email: 'one@example.test', role: 'member', status: 'offline', avatar: '', description: '', created_at: createdAt, updated_at: createdAt }] };
          }
          if (sql.includes('cloud_channels')) {
            return { rows: [{ id: 'chan_one_new', workspace_id: 'wsp_one', name: 'one-new', description: '', archived_at: null, created_at: createdAt, updated_at: createdAt, metadata: { state: { humanIds: ['hum_one_new'], memberIds: ['hum_one_new'] } } }] };
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
  const state = {
    humans: [],
    computers: [],
    agents: [],
    channels: [],
    dms: [],
    messages: [],
    replies: [],
    tasks: [],
    workItems: [],
    attachments: [],
    reminders: [],
    missions: [],
    runs: [],
    projects: [],
    teamSharing: {
      sessions: {
        sess_one_legacy: { sessionId: 'sess_one_legacy', workspaceId: 'wsp_one', channelId: 'chan_one', abstractRevision: 1 },
        sess_two: { sessionId: 'sess_two', workspaceId: 'wsp_two', channelId: 'chan_two', abstractRevision: 1 },
      },
      abstracts: {
        sess_one_legacy: { revision: 1, abstractMarkdown: '# One Legacy' },
        sess_two: { revision: 1, abstractMarkdown: '# Two' },
      },
      vectorDocuments: [
        { vectorDocumentId: 'sess_one_legacy:L0', sessionId: 'sess_one_legacy', workspaceId: 'wsp_one', layer: 'L0' },
        { vectorDocumentId: 'sess_two:L0', sessionId: 'sess_two', workspaceId: 'wsp_two', layer: 'L0' },
      ],
      auth: {
        tokens: {
          tok_one: { token: 'tok_one', workspaceId: 'wsp_one' },
        },
      },
    },
  };
  await store.loadWorkspaceIntoState(state, 'wsp_one');
  assert.equal(state.humans.some((human) => human.id === 'hum_one_new'), true);
  assert.equal(state.channels.some((channel) => channel.id === 'chan_one_new'), true);
  assert.equal(state.teamSharing.sessions.sess_one_legacy.channelId, 'chan_one');
  assert.equal(state.teamSharing.sessions.sess_two.channelId, 'chan_two');
  assert.equal(state.teamSharing.abstracts.sess_one_legacy.abstractMarkdown, '# One Legacy');
  assert.equal(state.teamSharing.vectorDocuments.some((doc) => doc.sessionId === 'sess_one_legacy'), true);
  assert.equal(state.teamSharing.auth.tokens.tok_one.workspaceId, 'wsp_one');
});

test('postgres store pages message history with keyset SQL', async () => {
  const queries = [];
  const createdAt = '2026-05-13T00:00:00.000Z';
  const pool = {
    async connect() {
      return {
        async query(sql, params = []) {
          queries.push({ sql, params });
          if (sql.includes('FROM "magclaw"."cloud_messages"')) {
            return {
              rows: [
                {
                  id: 'msg_8',
                  workspace_id: 'wsp_main',
                  space_type: 'channel',
                  space_id: 'chan_main',
                  author_type: 'human',
                  author_id: 'hum_owner',
                  body: 'older',
                  reply_count: 0,
                  created_at: createdAt,
                  updated_at: createdAt,
                },
                {
                  id: 'msg_7',
                  workspace_id: 'wsp_main',
                  space_type: 'channel',
                  space_id: 'chan_main',
                  author_type: 'human',
                  author_id: 'hum_owner',
                  body: 'has more sentinel',
                  reply_count: 0,
                  created_at: '2026-05-12T00:00:00.000Z',
                  updated_at: '2026-05-12T00:00:00.000Z',
                },
              ],
            };
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

  const page = await store.listSpaceMessagesPage({
    workspaceId: 'wsp_main',
    spaceType: 'channel',
    spaceId: 'chan_main',
    limit: 1,
    before: '2026-05-14T00:00:00.000Z',
    beforeId: 'msg_9',
  });

  const query = queries.find((item) => item.sql.includes('FROM "magclaw"."cloud_messages"'));
  assert.match(query.sql, /\(created_at, id\) < \(\$4::timestamptz, \$5::text\)/);
  assert.match(query.sql, /ORDER BY created_at DESC, id DESC/);
  assert.match(query.sql, /LIMIT \$6/);
  assert.deepEqual(query.params, ['wsp_main', 'channel', 'chan_main', '2026-05-14T00:00:00.000Z', 'msg_9', 2]);
  assert.deepEqual(page.messages.map((message) => message.id), ['msg_8']);
  assert.equal(page.pagination.hasMore, true);
  assert.equal(page.pagination.nextBeforeId, 'msg_8');
});

test('postgres bootstrap window hydration keeps state timestamp for unchanged rows', async () => {
  const createdAt = '2026-05-13T00:00:00.000Z';
  const originalStateUpdatedAt = '2026-05-14T00:00:00.000Z';
  let body = 'unchanged';
  let updatedAt = createdAt;
  const messageRecord = () => ({
    id: 'msg_1',
    workspaceId: 'wsp_main',
    spaceType: 'channel',
    spaceId: 'chan_main',
    spaceSeq: 1,
    authorType: 'human',
    authorId: 'hum_owner',
    body,
    attachmentIds: [],
    mentionedAgentIds: [],
    mentionedHumanIds: [],
    replyCount: 0,
    savedBy: [],
    readBy: [],
    reactions: [],
    followedBy: [],
    createdAt,
    updatedAt,
  });
  const pool = {
    async connect() {
      return {
        async query(sql) {
          if (sql.includes('FROM "magclaw"."cloud_messages"')) {
            return {
              rows: [{
                id: 'msg_1',
                workspace_id: 'wsp_main',
                space_type: 'channel',
                space_id: 'chan_main',
                space_seq: 1,
                author_type: 'human',
                author_id: 'hum_owner',
                body,
                attachment_ids: [],
                mentioned_agent_ids: [],
                mentioned_human_ids: [],
                reply_count: 0,
                saved_by: [],
                read_by: [],
                reactions: [],
                followed_by: [],
                created_at: createdAt,
                updated_at: updatedAt,
              }],
            };
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
  const state = {
    updatedAt: originalStateUpdatedAt,
    cloud: {},
    channels: [],
    messages: [messageRecord()],
    replies: [],
  };

  const unchanged = await store.loadConversationWindowIntoState(state, {
    workspaceId: 'wsp_main',
    spaceType: 'channel',
    spaceId: 'chan_main',
    messageLimit: 1,
  });
  assert.equal(unchanged.changed, false);
  assert.equal(state.updatedAt, originalStateUpdatedAt);

  body = 'changed';
  updatedAt = '2026-05-13T00:00:01.000Z';
  const changed = await store.loadConversationWindowIntoState(state, {
    workspaceId: 'wsp_main',
    spaceType: 'channel',
    spaceId: 'chan_main',
    messageLimit: 1,
  });
  assert.equal(changed.changed, true);
  assert.notEqual(state.updatedAt, originalStateUpdatedAt);
  assert.equal(state.messages.find((message) => message.id === 'msg_1')?.body, 'changed');
});

test('postgres store pages thread replies with workspace parent cursor SQL', async () => {
  const queries = [];
  const createdAt = '2026-05-13T00:00:00.000Z';
  const pool = {
    async connect() {
      return {
        async query(sql, params = []) {
          queries.push({ sql, params });
          if (sql.includes('FROM "magclaw"."cloud_replies"')) {
            return {
              rows: [{
                id: 'rep_8',
                workspace_id: 'wsp_main',
                parent_message_id: 'msg_parent',
                author_type: 'agent',
                author_id: 'agt_one',
                body: 'reply',
                created_at: createdAt,
                updated_at: createdAt,
              }],
            };
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

  const page = await store.listThreadRepliesPage({
    workspaceId: 'wsp_main',
    parentMessageId: 'msg_parent',
    limit: 1,
    before: '2026-05-14T00:00:00.000Z',
    beforeId: 'rep_9',
  });

  const query = queries.find((item) => item.sql.includes('FROM "magclaw"."cloud_replies"'));
  assert.match(query.sql, /WHERE workspace_id = \$1/);
  assert.match(query.sql, /AND parent_message_id = \$2/);
  assert.match(query.sql, /\(created_at, id\) < \(\$3::timestamptz, \$4::text\)/);
  assert.match(query.sql, /ORDER BY created_at DESC, id DESC/);
  assert.deepEqual(query.params, ['wsp_main', 'msg_parent', '2026-05-14T00:00:00.000Z', 'rep_9', 2]);
  assert.deepEqual(page.replies.map((reply) => reply.id), ['rep_8']);
  assert.equal(page.pagination.hasMore, false);
});

test('postgres store bounded hydration does not perform unbounded message loads', async () => {
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

  await store.loadIntoState({});

  const messageQuery = queries.find((query) => query.sql.includes('FROM "magclaw"."cloud_messages"'));
  const replyQuery = queries.find((query) => query.sql.includes('FROM "magclaw"."cloud_replies"'));
  assert.match(messageQuery.sql, /ORDER BY created_at DESC, id DESC LIMIT \$1/);
  assert.match(replyQuery.sql, /ORDER BY created_at DESC, id DESC LIMIT \$1/);
  assert.equal(messageQuery.params[0], 500);
  assert.equal(replyQuery.params[0], 500);
});

test('postgres store reloads auth directory without clobbering active workspace', async () => {
  const queries = [];
  const createdAt = '2026-05-13T00:00:00.000Z';
  const rowsForTable = {
    cloud_workspaces: [{
      id: 'wsp_auth',
      slug: 'auth',
      name: 'Auth Workspace',
      owner_user_id: 'usr_auth',
      created_at: createdAt,
      updated_at: createdAt,
    }],
    cloud_users: [{
      id: 'usr_auth',
      email: 'auth@example.test',
      name: 'Auth User',
      password_hash: 'hash',
      language: 'en',
      created_at: createdAt,
      updated_at: createdAt,
    }],
    cloud_workspace_members: [{
      id: 'wmem_auth',
      workspace_id: 'wsp_auth',
      user_id: 'usr_auth',
      human_id: 'hum_auth',
      role: 'admin',
      status: 'active',
      joined_at: createdAt,
      created_at: createdAt,
      updated_at: createdAt,
    }],
    cloud_sessions: [{
      id: 'sess_auth',
      user_id: 'usr_auth',
      token_hash: 'hash_session',
      created_at: createdAt,
      expires_at: '2026-05-26T00:00:00.000Z',
    }],
    cloud_computers: [{
      id: 'cmp_auth',
      workspace_id: 'wsp_auth',
      name: 'Auth Runner',
      status: 'connected',
      connected_via: 'daemon',
      runtime_ids: [],
      runtime_details: [],
      capabilities: [],
      running_agents: [],
      created_at: createdAt,
      updated_at: createdAt,
    }],
  };
  const pool = {
    async connect() {
      return {
        async query(sql, params = []) {
          queries.push({ sql, params });
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
  const state = {
    connection: { workspaceId: 'wsp_active' },
    cloud: { workspaces: [{ id: 'wsp_active', slug: 'active', name: 'Active' }] },
    channels: [{ id: 'chan_active', workspaceId: 'wsp_active', name: 'all' }],
  };

  await store.loadAuthIntoState(state);

  assert.equal(state.connection.workspaceId, 'wsp_active');
  assert.equal(state.channels[0].id, 'chan_active');
  assert.equal(state.cloud.workspaces[0].id, 'wsp_auth');
  assert.equal(state.cloud.users[0].id, 'usr_auth');
  assert.equal(state.cloud.workspaceMembers[0].humanId, 'hum_auth');
  assert.equal(state.computers[0].id, 'cmp_auth');
  assert.equal(queries.some((query) => query.sql.includes('cloud_state_records')), false);
  assert.equal(queries.some((query) => query.sql.includes('cloud_messages')), false);
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
        thirdPartyName: 'Snapshot Feishu',
        thirdPartyProvider: 'feishu',
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
  assert.match(userInsert?.sql || '', /third_party_name/);
  assert.equal(userInsert?.params[6], 'Snapshot Feishu');
  assert.equal(userInsert?.params[7], 'feishu');
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
