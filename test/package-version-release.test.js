import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { collectReleasePackages, runPackagePublishRelease } from '../scripts/publish-magclaw-packages.mjs';

const releasePackages = [
  { name: '@magclaw/cli-core', version: '0.1.40', dir: '/repo/cli-core' },
  { name: '@magclaw/daemon', version: '0.1.40', dir: '/repo/daemon' },
  { name: '@magclaw/computer', version: '0.1.40', dir: '/repo/computer' },
];

async function writePackage(root, dir, pkg) {
  const packageDir = join(root, dir);
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
}

test('collect release packages expands cli-core to daemon and computer and enforces matching versions', async () => {
  const root = await mkdtemp(join(os.tmpdir(), 'magclaw-release-packages-'));
  await writePackage(root, 'cli-core', { name: '@magclaw/cli-core', version: '0.1.80' });
  await writePackage(root, 'daemon', { name: '@magclaw/daemon', version: '0.1.80', dependencies: { '@magclaw/cli-core': '0.1.80' } });
  await writePackage(root, 'computer', { name: '@magclaw/computer', version: '0.1.80', dependencies: { '@magclaw/cli-core': '0.1.80' } });

  const packages = await collectReleasePackages({ root, packageNames: ['@magclaw/cli-core'] });

  assert.deepEqual(packages.map((pkg) => pkg.name), [
    '@magclaw/cli-core',
    '@magclaw/daemon',
    '@magclaw/computer',
  ]);
});

test('collect release packages rejects cli-core releases when dependents were not bumped', async () => {
  const root = await mkdtemp(join(os.tmpdir(), 'magclaw-release-packages-'));
  await writePackage(root, 'cli-core', { name: '@magclaw/cli-core', version: '0.1.81' });
  await writePackage(root, 'daemon', { name: '@magclaw/daemon', version: '0.1.80', dependencies: { '@magclaw/cli-core': '0.1.81' } });
  await writePackage(root, 'computer', { name: '@magclaw/computer', version: '0.1.81', dependencies: { '@magclaw/cli-core': '0.1.81' } });

  await assert.rejects(
    () => collectReleasePackages({ root, packageNames: ['@magclaw/cli-core'] }),
    /@magclaw\/daemon version 0\.1\.80 must match @magclaw\/cli-core 0\.1\.81/,
  );
});

test('collect release packages lets daemon and computer publish independently when cli-core is unchanged', async () => {
  const root = await mkdtemp(join(os.tmpdir(), 'magclaw-release-packages-'));
  await writePackage(root, 'cli-core', { name: '@magclaw/cli-core', version: '0.1.81' });
  await writePackage(root, 'daemon', { name: '@magclaw/daemon', version: '0.1.82', dependencies: { '@magclaw/cli-core': '0.1.81' } });
  await writePackage(root, 'computer', { name: '@magclaw/computer', version: '0.1.83', dependencies: { '@magclaw/cli-core': '0.1.81' } });

  const daemonOnly = await collectReleasePackages({ root, packageNames: ['@magclaw/daemon'] });
  const computerOnly = await collectReleasePackages({ root, packageNames: ['@magclaw/computer'] });

  assert.deepEqual(daemonOnly.map((pkg) => `${pkg.name}@${pkg.version}`), ['@magclaw/daemon@0.1.82']);
  assert.deepEqual(computerOnly.map((pkg) => `${pkg.name}@${pkg.version}`), ['@magclaw/computer@0.1.83']);
});

test('package release runner publishes packages and verifies npm latest without DB access', async () => {
  const calls = [];

  await runPackagePublishRelease({
    packages: releasePackages,
    publishId: 'pkgrel_test',
    npmPublish: async (pkg) => calls.push(['npm-publish', pkg.name]),
    npmVerify: async (pkg) => {
      calls.push(['npm-verify', pkg.name]);
      return { packageName: pkg.name, version: pkg.version, distTags: { latest: pkg.version } };
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  assert.deepEqual(calls.map((call) => call[0]), [
    'npm-publish',
    'npm-verify',
    'npm-publish',
    'npm-verify',
    'npm-publish',
    'npm-verify',
  ]);
});

test('package release runner supports verify-only for already-published packages', async () => {
  const calls = [];

  await runPackagePublishRelease({
    packages: releasePackages,
    publishId: 'pkgrel_test',
    verifyOnly: true,
    npmPublish: async (pkg) => calls.push(['npm-publish', pkg.name]),
    npmVerify: async (pkg) => {
      calls.push(['npm-verify', pkg.name]);
      return { packageName: pkg.name, version: pkg.version, distTags: { latest: pkg.version } };
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  assert.deepEqual(calls.map((call) => call[0]), ['npm-verify', 'npm-verify', 'npm-verify']);
});

test('package release runner fails loudly when npm publish fails', async () => {
  const calls = [];

  await assert.rejects(
    () => runPackagePublishRelease({
      packages: releasePackages,
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

  assert.deepEqual(calls.map((call) => call[0]), ['npm-publish', 'npm-publish']);
});

test('package release runner fails loudly when npm latest is not the selected version', async () => {
  await assert.rejects(
    () => runPackagePublishRelease({
      packages: releasePackages,
      publishId: 'pkgrel_test',
      npmPublish: async () => {},
      npmVerify: async (pkg) => ({ packageName: pkg.name, version: pkg.version, distTags: { latest: '0.1.39' } }),
      logger: { info() {}, warn() {}, error() {} },
    }),
    /npm-verify failed.*latest dist-tag/s,
  );
});
