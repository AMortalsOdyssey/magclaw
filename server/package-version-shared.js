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

export function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function jsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function cleanText(value) {
  return String(value || '').trim();
}

export function iso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function recordStatus(value, fallback = 'published') {
  const status = cleanText(value) || fallback;
  return ['pending', 'published', 'failed'].includes(status) ? status : fallback;
}

export function recordChannel(value) {
  return cleanText(value) || PACKAGE_VERSION_CHANNEL;
}

export function normalizePackageVersionRecord(record, defaults = {}) {
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
  return normalizePackageVersionRecord(row, { source: 'db' });
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
