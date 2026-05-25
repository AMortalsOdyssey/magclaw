import assert from 'node:assert/strict';
import test from 'node:test';
import { runPackagePublishRelease } from '../scripts/publish-magclaw-packages.mjs';
import { createPackageVersionManifestStore } from '../server/package-version-manifest.js';

const releasePackages = [
  { name: '@magclaw/cli-core', version: '0.1.40', dir: '/repo/cli-core' },
  { name: '@magclaw/daemon', version: '0.1.40', dir: '/repo/daemon' },
  { name: '@magclaw/computer', version: '0.1.40', dir: '/repo/computer' },
];

test('package release runner marks DB pending, publishes, verifies npm, then finalizes DB atomically', async () => {
  const calls = [];
  const db = new Map();
  const manifestStore = {
    async markPending(records, context) {
      calls.push(['pending', records.map((record) => record.packageName), context.publishId]);
      for (const record of records) db.set(record.packageName, { ...record, status: 'pending' });
    },
    async markPublished(records, context) {
      calls.push(['published', records.map((record) => record.packageName), context.publishId]);
      for (const record of records) db.set(record.packageName, { ...record, status: 'published' });
    },
    async markFailed(records, context) {
      calls.push(['failed', records.map((record) => record.packageName), context.error]);
    },
    async read(packageNames) {
      calls.push(['read', packageNames]);
      return packageNames.map((packageName) => db.get(packageName)).filter(Boolean);
    },
  };

  await runPackagePublishRelease({
    packages: releasePackages,
    manifestStore,
    publishId: 'pkgrel_test',
    npmPublish: async (pkg) => calls.push(['npm-publish', pkg.name]),
    npmVerify: async (pkg) => {
      calls.push(['npm-verify', pkg.name]);
      return { packageName: pkg.name, version: pkg.version, distTags: { latest: pkg.version } };
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  assert.deepEqual(calls.map((call) => call[0]), [
    'pending',
    'npm-publish',
    'npm-verify',
    'npm-publish',
    'npm-verify',
    'npm-publish',
    'npm-verify',
    'published',
    'read',
  ]);
  assert.equal(db.get('@magclaw/daemon').status, 'published');
});

test('package release runner records failed manifest status when npm publish fails', async () => {
  const calls = [];
  const manifestStore = {
    async markPending(records) {
      calls.push(['pending', records.length]);
    },
    async markPublished() {
      calls.push(['published']);
    },
    async markFailed(records, context) {
      calls.push(['failed', records.length, context.error]);
    },
    async read() {
      return [];
    },
  };

  await assert.rejects(
    () => runPackagePublishRelease({
      packages: releasePackages,
      manifestStore,
      publishId: 'pkgrel_test',
      npmPublish: async (pkg) => {
        calls.push(['npm-publish', pkg.name]);
        if (pkg.name === '@magclaw/daemon') throw new Error('npm publish denied');
      },
      npmVerify: async (pkg) => ({ packageName: pkg.name, version: pkg.version, distTags: { latest: pkg.version } }),
      logger: { info() {}, warn() {}, error() {} },
    }),
    /npm-publish failed.*npm publish denied/s,
  );

  assert.deepEqual(calls.map((call) => call[0]), ['pending', 'npm-publish', 'npm-publish', 'failed']);
  assert.match(calls.at(-1)[2], /npm publish denied/);
});

test('package release runner fails loudly when npm is verified but DB finalize fails', async () => {
  const calls = [];
  const manifestStore = {
    async markPending(records) {
      calls.push(['pending', records.length]);
    },
    async markPublished() {
      calls.push(['published']);
      throw new Error('database unavailable');
    },
    async markFailed(records, context) {
      calls.push(['failed', records.length, context.error]);
    },
    async read() {
      return [];
    },
  };

  await assert.rejects(
    () => runPackagePublishRelease({
      packages: releasePackages,
      manifestStore,
      publishId: 'pkgrel_test',
      npmPublish: async (pkg) => calls.push(['npm-publish', pkg.name]),
      npmVerify: async (pkg) => {
        calls.push(['npm-verify', pkg.name]);
        return { packageName: pkg.name, version: pkg.version, distTags: { latest: pkg.version } };
      },
      logger: { info() {}, warn() {}, error() {} },
    }),
    /db-published failed.*--sync-only/s,
  );

  assert.deepEqual(calls.map((call) => call[0]), [
    'pending',
    'npm-publish',
    'npm-verify',
    'npm-publish',
    'npm-verify',
    'npm-publish',
    'npm-verify',
    'published',
    'failed',
  ]);
});

test('package version manifest store finalizes package records in one DB transaction', async () => {
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
  const store = createPackageVersionManifestStore({
    databaseUrl: 'postgresql://user:secret@example.test:5432/postgres',
    database: 'magclaw_cloud',
    schema: 'magclaw',
    pool,
  });

  await store.markPublished([
    { packageName: '@magclaw/daemon', version: '0.1.40', npmVerifiedAt: '2026-05-25T10:00:00.000Z' },
    { packageName: '@magclaw/computer', version: '0.1.40', npmVerifiedAt: '2026-05-25T10:00:00.000Z' },
  ], { publishId: 'pkgrel_test', now: '2026-05-25T10:01:00.000Z' });

  assert.deepEqual(queries.map((query) => query.sql).filter((sql) => ['BEGIN', 'COMMIT'].includes(sql)), ['BEGIN', 'COMMIT']);
  const inserts = queries.filter((query) => query.sql.includes('INSERT INTO "magclaw"."cloud_package_versions"'));
  assert.equal(inserts.length, 2);
  assert.deepEqual(inserts.map((query) => query.params[0]), ['@magclaw/daemon', '@magclaw/computer']);
  assert.equal(inserts[0].params[3], 'published');
  assert.equal(inserts[0].params[4], 'pkgrel_test');
});
