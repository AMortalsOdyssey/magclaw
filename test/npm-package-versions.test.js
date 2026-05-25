import assert from 'node:assert/strict';
import test from 'node:test';
import { createNpmPackageVersionResolver } from '../server/npm-package-versions.js';

test('npm package version resolver reads daemon and computer latest dist-tags', async () => {
  const requested = [];
  const resolver = createNpmPackageVersionResolver({
    nowMs: () => 1000,
    fetchJson: async (url) => {
      requested.push(String(url));
      if (String(url).includes('%2fdaemon')) return { 'dist-tags': { latest: '0.1.30' } };
      if (String(url).includes('%2fcomputer')) return { 'dist-tags': { latest: '0.1.31' } };
      return { 'dist-tags': { latest: '0.0.0' } };
    },
    packageNames: ['@magclaw/daemon', '@magclaw/computer'],
    ttlMs: 60_000,
  });

  await resolver.refreshAll();

  assert.equal(resolver.latest('@magclaw/daemon', '0.1.22'), '0.1.30');
  assert.equal(resolver.latest('@magclaw/computer', '0.1.22'), '0.1.31');
  assert.deepEqual(requested, [
    'https://registry.npmjs.org/@magclaw%2fdaemon',
    'https://registry.npmjs.org/@magclaw%2fcomputer',
  ]);
});

test('npm package version resolver keeps fallback while background refresh is pending', () => {
  const resolver = createNpmPackageVersionResolver({
    nowMs: () => 1000,
    fetchJson: async () => { throw new Error('network unavailable'); },
    packageNames: ['@magclaw/daemon'],
    ttlMs: 60_000,
  });

  resolver.refreshAll();

  assert.equal(resolver.latest('@magclaw/daemon', '0.1.22'), '0.1.22');
});

test('npm package version resolver defaults to a 30 minute refresh cache', async () => {
  let now = 1000;
  const requested = [];
  const resolver = createNpmPackageVersionResolver({
    nowMs: () => now,
    fetchJson: async (url) => {
      requested.push(String(url));
      return { 'dist-tags': { latest: `0.1.${requested.length}` } };
    },
    packageNames: ['@magclaw/daemon'],
  });

  await resolver.maybeRefreshAll();
  assert.equal(resolver.latest('@magclaw/daemon'), '0.1.1');

  now += 29 * 60_000;
  await resolver.maybeRefreshAll();
  assert.equal(resolver.latest('@magclaw/daemon'), '0.1.1');
  assert.equal(requested.length, 1);

  now += 60_000;
  await resolver.maybeRefreshAll();
  assert.equal(resolver.latest('@magclaw/daemon'), '0.1.2');
  assert.equal(requested.length, 2);
});

test('npm package version resolver prefers DB package manifest before npm registry', async () => {
  const resolver = createNpmPackageVersionResolver({
    nowMs: () => 1000,
    fetchManifest: async (packageName) => {
      if (packageName === '@magclaw/daemon') return { latest: '0.1.40', source: 'db' };
      return null;
    },
    fetchJson: async () => {
      throw new Error('registry should not be used when DB manifest is current');
    },
    packageNames: ['@magclaw/daemon'],
    ttlMs: 60_000,
  });

  await resolver.refreshAll();

  assert.equal(resolver.latest('@magclaw/daemon'), '0.1.40');
});
