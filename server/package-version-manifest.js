import { Pool } from 'pg';
import {
  PACKAGE_VERSION_CHANNEL,
  PACKAGE_VERSION_TABLE,
  MAGCLAW_RELEASE_PACKAGE_NAMES,
  MAGCLAW_RUNTIME_PACKAGE_NAMES,
  cleanText,
  iso,
  jsonObject,
  normalizePackageVersionRecord,
  packageVersionFromRow,
  packageVersionsFromRows,
  recordChannel,
  safeArray,
} from './package-version-shared.js';
import {
  DEFAULT_DATABASE,
  DEFAULT_SCHEMA,
  databaseNameFromUrl,
  databaseUrlWithName,
  normalizeDatabaseUrl,
  quoteIdent,
} from './cloud/postgres.js';

export {
  PACKAGE_VERSION_CHANNEL,
  PACKAGE_VERSION_TABLE,
  MAGCLAW_RELEASE_PACKAGE_NAMES,
  MAGCLAW_RUNTIME_PACKAGE_NAMES,
  packageVersionFromRow,
  packageVersionsFromRows,
  latestPackageVersionFromManifest,
} from './package-version-shared.js';

function requiredIso(value = null) {
  return iso(value) || new Date().toISOString();
}

function tableName(schema = DEFAULT_SCHEMA) {
  return `${quoteIdent(schema || DEFAULT_SCHEMA)}.${quoteIdent(PACKAGE_VERSION_TABLE)}`;
}

function normalizeRecord(record, defaults = {}) {
  return normalizePackageVersionRecord(record, defaults);
}

export async function selectPackageVersionRows(client, options = {}) {
  const packageNames = safeArray(options.packageNames).map(cleanText).filter(Boolean);
  const channel = recordChannel(options.channel);
  const params = [channel];
  let packageFilter = '';
  if (packageNames.length) {
    params.push(packageNames);
    packageFilter = `AND package_name = ANY($${params.length}::text[])`;
  }
  const statusFilter = options.publishedOnly === false ? '' : "AND status = 'published'";
  const result = await client.query(
    `
      SELECT *
      FROM ${tableName(options.schema)}
      WHERE channel = $1
        ${statusFilter}
        ${packageFilter}
      ORDER BY package_name ASC, updated_at DESC
    `,
    params,
  );
  return result.rows || [];
}

export async function upsertPackageVersionRecords(client, records, options = {}) {
  const schema = options.schema || DEFAULT_SCHEMA;
  const nowIso = requiredIso(options.now);
  for (const input of safeArray(records)) {
    const record = normalizeRecord(input, {
      channel: options.channel || PACKAGE_VERSION_CHANNEL,
      status: options.status || 'published',
      publishId: options.publishId || '',
      npmVerifiedAt: options.npmVerifiedAt || null,
      dbSyncedAt: options.dbSyncedAt || nowIso,
      error: options.error || '',
      metadata: options.metadata || {},
    });
    if (!record.packageName || !record.version) continue;
    await client.query(
      `
        INSERT INTO ${tableName(schema)} (
          package_name,
          channel,
          version,
          status,
          publish_id,
          npm_verified_at,
          db_synced_at,
          error,
          metadata,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8, $9::jsonb, now(), now())
        ON CONFLICT (package_name, channel) DO UPDATE SET
          version = EXCLUDED.version,
          status = EXCLUDED.status,
          publish_id = EXCLUDED.publish_id,
          npm_verified_at = EXCLUDED.npm_verified_at,
          db_synced_at = EXCLUDED.db_synced_at,
          error = EXCLUDED.error,
          metadata = EXCLUDED.metadata,
          updated_at = now()
      `,
      [
        record.packageName,
        record.channel,
        record.version,
        record.status,
        record.publishId,
        record.npmVerifiedAt,
        record.dbSyncedAt || nowIso,
        record.error,
        JSON.stringify(record.metadata),
      ],
    );
  }
}

export function createPackageVersionManifestStore(options = {}) {
  const databaseUrl = normalizeDatabaseUrl(options.databaseUrl || '');
  const database = options.database || databaseNameFromUrl(databaseUrl, DEFAULT_DATABASE);
  const schema = options.schema || DEFAULT_SCHEMA;
  let pool = options.pool || null;
  if (!databaseUrl && !pool) return null;

  async function withClient(fn) {
    if (!pool) {
      pool = new Pool({
        connectionString: databaseUrlWithName(databaseUrl, database),
        max: Number(options.poolMax || 1) || 1,
      });
    }
    const client = await pool.connect();
    try {
      return await fn(client);
    } finally {
      client.release();
    }
  }

  async function withTransaction(label, fn) {
    return withClient(async (client) => {
      await client.query('BEGIN');
      try {
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        error.message = `${label} failed: ${error.message || error}`;
        throw error;
      }
    });
  }

  function enrichRecords(records, status, context = {}) {
    const nowIso = requiredIso(context.now);
    return safeArray(records).map((record) => normalizeRecord(record, {
      status,
      publishId: context.publishId || '',
      npmVerifiedAt: status === 'published' ? (record.npmVerifiedAt || nowIso) : null,
      dbSyncedAt: nowIso,
      error: context.error || '',
      metadata: {
        ...jsonObject(record.metadata),
        publishId: context.publishId || '',
      },
    }));
  }

  async function read(packageNames, readOptions = {}) {
    const rows = await withClient((client) => selectPackageVersionRows(client, {
      schema,
      packageNames,
      channel: readOptions.channel || PACKAGE_VERSION_CHANNEL,
      publishedOnly: readOptions.publishedOnly !== false,
    }));
    return rows.map(packageVersionFromRow);
  }

  return {
    async markPending(records, context = {}) {
      return withTransaction('package version pending manifest', (client) => upsertPackageVersionRecords(
        client,
        enrichRecords(records, 'pending', context),
        { schema, status: 'pending', publishId: context.publishId || '', error: '' },
      ));
    },
    async markPublished(records, context = {}) {
      return withTransaction('package version published manifest', (client) => upsertPackageVersionRecords(
        client,
        enrichRecords(records, 'published', context),
        { schema, status: 'published', publishId: context.publishId || '', error: '' },
      ));
    },
    async markFailed(records, context = {}) {
      return withTransaction('package version failed manifest', (client) => upsertPackageVersionRecords(
        client,
        enrichRecords(records, 'failed', context),
        { schema, status: 'failed', publishId: context.publishId || '', error: context.error || '' },
      ));
    },
    read,
    async latest(packageName) {
      const rows = await read([packageName], { publishedOnly: true });
      return rows[0] || null;
    },
    async close() {
      if (pool && !options.pool) await pool.end();
      pool = null;
    },
  };
}
