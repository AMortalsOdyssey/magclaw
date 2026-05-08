import crypto from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

export const MIGRATION_ID = '20260506_cloud_base';
export const DEFAULT_DATABASE = 'magclaw_cloud';
export const DEFAULT_SCHEMA = 'magclaw';
export const DEFAULT_MAINTENANCE_DATABASE = 'postgres';

function assertIdentifier(value, label) {
  const name = String(value || '').trim();
  if (!name) throw new Error(`${label} is required.`);
  if (name.length > 63) throw new Error(`${label} must be 63 characters or fewer.`);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`${label} must contain only letters, numbers, and underscores, and cannot start with a number.`);
  }
  return name;
}

export function quoteIdent(value) {
  const name = assertIdentifier(value, 'identifier');
  return `"${name.replaceAll('"', '""')}"`;
}

export function normalizeDatabaseUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw
    .replace(/^postgresql\+asyncpg:\/\//, 'postgresql://')
    .replace(/^postgres\+asyncpg:\/\//, 'postgres://');
}

export function redactDatabaseUrl(value) {
  const normalized = normalizeDatabaseUrl(value);
  if (!normalized) return '';
  try {
    const url = new URL(normalized);
    if (url.password) url.password = '***';
    return url.toString();
  } catch {
    return normalized.replace(/\/\/([^:@/]+):([^@/]+)@/, '//$1:***@');
  }
}

export function databaseNameFromUrl(value, fallback = DEFAULT_DATABASE) {
  const normalized = normalizeDatabaseUrl(value);
  if (!normalized) return fallback;
  const url = new URL(normalized);
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, '').split('/')[0] || '');
  return database || fallback;
}

export function databaseUrlWithName(value, databaseName) {
  const normalized = normalizeDatabaseUrl(value);
  if (!normalized) throw new Error('DATABASE_URL is required.');
  const url = new URL(normalized);
  url.pathname = `/${encodeURIComponent(assertIdentifier(databaseName, 'database'))}`;
  return url.toString();
}

export function parsePostgresArgs(argv = []) {
  const options = {
    command: 'migrate',
    databaseUrl: process.env.DATABASE_URL || process.env.MAGCLAW_DATABASE_URL || '',
    database: process.env.MAGCLAW_DATABASE || '',
    schema: process.env.MAGCLAW_DATABASE_SCHEMA || DEFAULT_SCHEMA,
    maintenanceDatabase: process.env.MAGCLAW_MAINTENANCE_DATABASE || DEFAULT_MAINTENANCE_DATABASE,
    createDatabase: true,
  };

  const args = [...argv];
  if (args[0] && !args[0].startsWith('--')) options.command = args.shift();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = () => {
      index += 1;
      return args[index];
    };
    if (arg === '--database-url') options.databaseUrl = next();
    else if (arg === '--database') options.database = next();
    else if (arg === '--schema') options.schema = next();
    else if (arg === '--maintenance-database') options.maintenanceDatabase = next();
    else if (arg === '--no-create-database') options.createDatabase = false;
    else if (arg === '--help' || arg === '-h') options.command = 'help';
    else throw new Error(`Unknown argument: ${arg}`);
  }

  options.databaseUrl = normalizeDatabaseUrl(options.databaseUrl);
  options.database = assertIdentifier(
    options.database || databaseNameFromUrl(options.databaseUrl, DEFAULT_DATABASE),
    'database',
  );
  options.schema = assertIdentifier(options.schema, 'schema');
  options.maintenanceDatabase = assertIdentifier(options.maintenanceDatabase, 'maintenance database');
  return options;
}

export async function loadSchemaSql() {
  return readFile(new URL('./postgres-schema.sql', import.meta.url), 'utf8');
}

function checksumSql(sql) {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

function clientFor(connectionString) {
  return new Client({ connectionString });
}

async function ensureDatabase(options) {
  if (!options.createDatabase) return { created: false, exists: null };
  const maintenanceUrl = databaseUrlWithName(options.databaseUrl, options.maintenanceDatabase);
  const client = clientFor(maintenanceUrl);
  await client.connect();
  try {
    const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [options.database]);
    if (existing.rowCount > 0) return { created: false, exists: true };
    await client.query(`CREATE DATABASE ${quoteIdent(options.database)}`);
    return { created: true, exists: false };
  } finally {
    await client.end();
  }
}

async function migrationStatus(client, schema, migrationId) {
  const table = `${quoteIdent(schema)}.magclaw_migrations`;
  const result = await client.query(`SELECT id, checksum, applied_at FROM ${table} WHERE id = $1`, [migrationId]);
  return result.rows[0] || null;
}

export async function migratePostgres(optionsInput = {}) {
  const hasExplicitDatabase = Object.prototype.hasOwnProperty.call(optionsInput, 'database')
    && optionsInput.database;
  const options = {
    ...parsePostgresArgs([]),
    ...optionsInput,
  };
  options.databaseUrl = normalizeDatabaseUrl(options.databaseUrl);
  options.database = assertIdentifier(
    hasExplicitDatabase ? options.database : databaseNameFromUrl(options.databaseUrl, options.database || DEFAULT_DATABASE),
    'database',
  );
  options.schema = assertIdentifier(options.schema || DEFAULT_SCHEMA, 'schema');
  options.maintenanceDatabase = assertIdentifier(options.maintenanceDatabase || DEFAULT_MAINTENANCE_DATABASE, 'maintenance database');

  const databaseResult = await ensureDatabase(options);
  const schemaSql = await loadSchemaSql();
  const checksum = checksumSql(schemaSql);
  const targetUrl = databaseUrlWithName(options.databaseUrl, options.database);
  const client = clientFor(targetUrl);
  await client.connect();
  try {
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(options.schema)}`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${quoteIdent(options.schema)}.magclaw_migrations (
        id TEXT PRIMARY KEY,
        checksum TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    const previous = await migrationStatus(client, options.schema, MIGRATION_ID);
    const checksumChanged = Boolean(previous && previous.checksum !== checksum);

    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL search_path TO ${quoteIdent(options.schema)}, public`);
      await client.query(schemaSql);
      await client.query(
        `INSERT INTO ${quoteIdent(options.schema)}.magclaw_migrations (id, checksum)
         VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET checksum = EXCLUDED.checksum`,
        [MIGRATION_ID, checksum],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }

    const tableCount = await client.query(`
      SELECT COUNT(*)::int AS count
      FROM information_schema.tables
      WHERE table_schema = $1
        AND table_name LIKE 'cloud_%'
    `, [options.schema]);

    return {
      ok: true,
      database: options.database,
      schema: options.schema,
      migrationId: MIGRATION_ID,
      checksum,
      checksumChanged,
      databaseCreated: databaseResult.created,
      tableCount: Number(tableCount.rows[0]?.count || 0),
    };
  } finally {
    await client.end();
  }
}

export async function postgresStatus(optionsInput = {}) {
  const hasExplicitDatabase = Object.prototype.hasOwnProperty.call(optionsInput, 'database')
    && optionsInput.database;
  const options = {
    ...parsePostgresArgs([]),
    ...optionsInput,
  };
  options.databaseUrl = normalizeDatabaseUrl(options.databaseUrl);
  options.database = assertIdentifier(
    hasExplicitDatabase ? options.database : databaseNameFromUrl(options.databaseUrl, options.database || DEFAULT_DATABASE),
    'database',
  );
  options.schema = assertIdentifier(options.schema || DEFAULT_SCHEMA, 'schema');
  const client = clientFor(databaseUrlWithName(options.databaseUrl, options.database));
  await client.connect();
  try {
    const tables = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = $1
        AND table_name LIKE 'cloud_%'
      ORDER BY table_name
    `, [options.schema]);
    return {
      ok: true,
      database: options.database,
      schema: options.schema,
      tables: tables.rows.map((row) => row.table_name),
    };
  } finally {
    await client.end();
  }
}

function helpText() {
  return `Usage:
  node server/cloud/postgres.js migrate --database-url <url> [--database magclaw_cloud] [--schema magclaw]
  node server/cloud/postgres.js status  --database-url <url> [--database magclaw_cloud] [--schema magclaw]

Notes:
  - postgresql+asyncpg:// URLs are accepted and normalized for the Node pg driver.
  - The migrate command creates the target database unless --no-create-database is set.
  - Secrets are never written to project files by this command.`;
}

async function main() {
  const options = parsePostgresArgs(process.argv.slice(2));
  if (options.command === 'help') {
    console.log(helpText());
    return;
  }
  if (!options.databaseUrl) throw new Error('DATABASE_URL or --database-url is required.');
  if (options.command === 'migrate') {
    const result = await migratePostgres(options);
    console.log(JSON.stringify({
      ...result,
      databaseUrl: redactDatabaseUrl(options.databaseUrl),
    }, null, 2));
    return;
  }
  if (options.command === 'status') {
    const result = await postgresStatus(options);
    console.log(JSON.stringify({
      ...result,
      databaseUrl: redactDatabaseUrl(options.databaseUrl),
    }, null, 2));
    return;
  }
  throw new Error(`Unknown command: ${options.command}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
