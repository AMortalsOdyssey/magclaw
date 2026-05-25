import { Pool } from 'pg';
import {
  DEFAULT_DATABASE,
  DEFAULT_SCHEMA,
  databaseNameFromUrl,
  databaseUrlWithName,
  normalizeDatabaseUrl,
  quoteIdent,
} from './cloud/postgres.js';

export const PACKAGE_VERSION_CHANNEL = 'latest';
export const PACKAGE_VERSION_TABLE = 'cloud_package_versions';
export const MAGCLAW_RELEASE_PACKAGE_NAMES = Object.freeze([
  '@magclaw/cli-core',
  '@magclaw/daemon',
  '@magclaw/computer',
]);
export const MAGCLAW_RUNTIME_PACKAGE_NAMES = Object.freeze([
  '@magclaw/daemon',
  '@magclaw/computer',
]);

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function jsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanText(value) {
  return String(value || '').trim();
}

function iso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function requiredIso(value = null) {
  return iso(value) || new Date().toISOString();
}

function tableName(schema = DEFAULT_SCHEMA) {
  return `${quoteIdent(schema || DEFAULT_SCHEMA)}.${quoteIdent(PACKAGE_VERSION_TABLE)}`;
}

function recordStatus(value, fallback = 'published') {
  const status = cleanText(value) || fallback;
  return ['pending', 'published', 'failed'].includes(status) ? status : fallback;
}

function recordChannel(value) {
  return cleanText(value) || PACKAGE_VERSION_CHANNEL;
}

function normalizeRecord(record, defaults = {}) {
  const packageName = cleanText(record?.packageName || record?.package_name || defaults.packageName);
  const version = cleanText(record?.version || record?.latest || defaults.version);
  return {
    packageName,
    channel: recordChannel(record?.channel || defaults.channel),
    version,
    latest: version,
    status: recordStatus(record?.status || defaults.status),
    publishId: cleanText(record?.publishId || record?.publish_id || defaults.publishId),
    npmVerifiedAt: iso(record?.npmVerifiedAt || record?.npm_verified_at || defaults.npmVerifiedAt),
    dbSyncedAt: iso(record?.dbSyncedAt || record?.db_synced_at || defaults.dbSyncedAt),
    error: cleanText(record?.error || defaults.error),
    createdAt: iso(record?.createdAt || record?.created_at || defaults.createdAt),
    updatedAt: iso(record?.updatedAt || record?.updated_at || defaults.updatedAt),
    metadata: jsonObject(record?.metadata || defaults.metadata),
    source: record?.source || defaults.source || 'db',
  };
}

export function packageVersionFromRow(row) {
  return normalizeRecord(row, { source: 'db' });
}

export function packageVersionsFromRows(rows) {
  const manifest = {};
  for (const row of safeArray(rows)) {
    const record = packageVersionFromRow(row);
    if (!record.packageName || !record.version) continue;
    if (record.channel !== PACKAGE_VERSION_CHANNEL || record.status !== 'published') continue;
    manifest[record.packageName] = record;
  }
  return manifest;
}

export function latestPackageVersionFromManifest(manifest, packageName, fallback = '') {
  const name = cleanText(packageName);
  if (!name || !manifest || typeof manifest !== 'object') return cleanText(fallback);
  const record = manifest[name];
  if (typeof record === 'string') return cleanText(record || fallback);
  return cleanText(record?.latest || record?.version || fallback);
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
