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
    'cloud_computers',
    'cloud_pairing_tokens',
    'cloud_computer_tokens',
    'cloud_agents',
    'cloud_messages',
    'cloud_tasks',
    'cloud_attachments',
    'cloud_agent_deliveries',
    'cloud_audit_logs',
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
});
