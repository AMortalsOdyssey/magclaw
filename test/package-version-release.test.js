import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import os from 'node:os';
import { collectReleasePackages, runPackagePublishRelease, validateDependencyAvailability } from '../scripts/publish-magclaw-packages.mjs';

const releasePackages = [
  { name: '@magclaw/cli-core', version: '0.1.40', dir: '/repo/cli-core' },
  { name: '@magclaw/daemon', version: '0.1.40', dir: '/repo/daemon' },
  { name: '@magclaw/computer', version: '0.1.40', dir: '/repo/computer' },
  { name: '@magclaw/team-sharing', version: '0.1.40', dir: '/repo/team-sharing' },
];
const notifyManifest = JSON.parse(await readFile(new URL('../notify/package.json', import.meta.url), 'utf8'));
const notifyOwnerManifest = JSON.parse(await readFile(new URL('../notify-owner/package.json', import.meta.url), 'utf8'));

async function writePackage(root, dir, pkg) {
  const packageDir = join(root, dir);
  await mkdir(packageDir, { recursive: true });
  await writeFile(join(packageDir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
}

test('collect release packages expands cli-core to daemon and computer only', async () => {
  const root = await mkdtemp(join(os.tmpdir(), 'magclaw-release-packages-'));
  await writePackage(root, 'cli-core', { name: '@magclaw/cli-core', version: '0.1.80' });
  await writePackage(root, 'daemon', { name: '@magclaw/daemon', version: '0.1.80', dependencies: { '@magclaw/cli-core': '0.1.80' } });
  await writePackage(root, 'computer', { name: '@magclaw/computer', version: '0.1.80', dependencies: { '@magclaw/cli-core': '0.1.80' } });
  await writePackage(root, 'team-sharing', { name: '@magclaw/team-sharing', version: '0.1.81' });

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
  await writePackage(root, 'team-sharing', { name: '@magclaw/team-sharing', version: '0.1.81' });

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
  await writePackage(root, 'team-sharing', { name: '@magclaw/team-sharing', version: '0.1.84' });

  const daemonOnly = await collectReleasePackages({ root, packageNames: ['@magclaw/daemon'] });
  const computerOnly = await collectReleasePackages({ root, packageNames: ['@magclaw/computer'] });
  const teamSharingOnly = await collectReleasePackages({ root, packageNames: ['@magclaw/team-sharing'] });

  assert.deepEqual(daemonOnly.map((pkg) => `${pkg.name}@${pkg.version}`), ['@magclaw/daemon@0.1.82']);
  assert.deepEqual(computerOnly.map((pkg) => `${pkg.name}@${pkg.version}`), ['@magclaw/computer@0.1.83']);
  assert.deepEqual(teamSharingOnly.map((pkg) => `${pkg.name}@${pkg.version}`), ['@magclaw/team-sharing@0.1.84']);
});

test('dependent-only releases require their cli-core pin to exist on the registry', async () => {
  const root = await mkdtemp(join(os.tmpdir(), 'magclaw-release-packages-'));
  await writePackage(root, 'cli-core', { name: '@magclaw/cli-core', version: '0.1.81' });
  await writePackage(root, 'daemon', { name: '@magclaw/daemon', version: '0.1.82', dependencies: { '@magclaw/cli-core': '0.1.81' } });
  await writePackage(root, 'computer', { name: '@magclaw/computer', version: '0.1.82', dependencies: { '@magclaw/cli-core': '0.1.81' } });
  await writePackage(root, 'team-sharing', { name: '@magclaw/team-sharing', version: '0.1.84' });
  const computerOnly = await collectReleasePackages({ root, packageNames: ['@magclaw/computer'] });

  const checked = await validateDependencyAvailability(computerOnly, {
    npmVersionExists: async (packageName, version) => packageName === '@magclaw/cli-core' && version === '0.1.81',
  });
  assert.deepEqual(checked, [{ packageName: '@magclaw/computer', dependency: '@magclaw/cli-core@0.1.81' }]);

  await assert.rejects(
    () => validateDependencyAvailability(computerOnly, { npmVersionExists: async () => false }),
    /depends on @magclaw\/cli-core@0\.1\.81, which is not published/,
  );
});

test('dependency availability check is skipped when cli-core ships in the same release set', async () => {
  const root = await mkdtemp(join(os.tmpdir(), 'magclaw-release-packages-'));
  await writePackage(root, 'cli-core', { name: '@magclaw/cli-core', version: '0.1.81' });
  await writePackage(root, 'daemon', { name: '@magclaw/daemon', version: '0.1.81', dependencies: { '@magclaw/cli-core': '0.1.81' } });
  await writePackage(root, 'computer', { name: '@magclaw/computer', version: '0.1.81', dependencies: { '@magclaw/cli-core': '0.1.81' } });
  await writePackage(root, 'team-sharing', { name: '@magclaw/team-sharing', version: '0.1.84' });
  const packages = await collectReleasePackages({ root, packageNames: ['@magclaw/cli-core'] });

  const checked = await validateDependencyAvailability(packages, {
    npmVersionExists: async () => {
      throw new Error('should not be called');
    },
  });
  assert.deepEqual(checked, []);
});

test('collect release packages does not validate team-sharing against cli-core version', async () => {
  const root = await mkdtemp(join(os.tmpdir(), 'magclaw-release-packages-'));
  await writePackage(root, 'cli-core', { name: '@magclaw/cli-core', version: '0.1.90' });
  await writePackage(root, 'daemon', { name: '@magclaw/daemon', version: '0.1.90', dependencies: { '@magclaw/cli-core': '0.1.90' } });
  await writePackage(root, 'computer', { name: '@magclaw/computer', version: '0.1.90', dependencies: { '@magclaw/cli-core': '0.1.90' } });
  await writePackage(root, 'team-sharing', { name: '@magclaw/team-sharing', version: '0.1.91' });

  const packages = await collectReleasePackages({ root, packageNames: ['@magclaw/cli-core'] });

  assert.deepEqual(packages.map((pkg) => `${pkg.name}@${pkg.version}`), [
    '@magclaw/cli-core@0.1.90',
    '@magclaw/daemon@0.1.90',
    '@magclaw/computer@0.1.90',
  ]);
});

test('collect release packages allows team-sharing to publish without cli-core dependency', async () => {
  const root = await mkdtemp(join(os.tmpdir(), 'magclaw-release-packages-'));
  await writePackage(root, 'cli-core', { name: '@magclaw/cli-core', version: '0.1.90' });
  await writePackage(root, 'daemon', { name: '@magclaw/daemon', version: '0.1.90', dependencies: { '@magclaw/cli-core': '0.1.90' } });
  await writePackage(root, 'computer', { name: '@magclaw/computer', version: '0.1.90', dependencies: { '@magclaw/cli-core': '0.1.90' } });
  await writePackage(root, 'team-sharing', { name: '@magclaw/team-sharing', version: '0.1.91' });

  const packages = await collectReleasePackages({ root, packageNames: ['@magclaw/team-sharing'] });

  assert.deepEqual(packages.map((pkg) => `${pkg.name}@${pkg.version}`), [
    '@magclaw/team-sharing@0.1.91',
  ]);
});

test('collect release packages allows Notify to publish independently', async () => {
  const packages = await collectReleasePackages({
    root: new URL('..', import.meta.url).pathname,
    packageNames: ['@magclaw/notify'],
  });
  assert.deepEqual(packages.map((pkg) => pkg.name), ['@magclaw/notify']);
  assert.equal(packages[0].version, notifyManifest.version);
});

test('collect release packages allows Notify Owner to publish independently', async () => {
  const packages = await collectReleasePackages({
    root: new URL('..', import.meta.url).pathname,
    packageNames: ['@magclaw/notify-owner'],
  });
  assert.deepEqual(packages.map((pkg) => pkg.name), ['@magclaw/notify-owner']);
  assert.equal(packages[0].version, notifyOwnerManifest.version);
});

test('package release runner infers next for prereleases and preserves latest', async () => {
  const calls = [];
  const prerelease = [{
    name: '@magclaw/notify',
    version: '0.4.0-beta.1',
    dir: '/repo/notify',
  }];

  const result = await runPackagePublishRelease({
    packages: prerelease,
    publishId: 'pkgrel_prerelease',
    npmPublish: async (pkg, options) => calls.push(['npm-publish', pkg.name, options.distTag]),
    npmVerify: async (pkg) => ({
      packageName: pkg.name,
      version: pkg.version,
      distTags: { latest: '0.3.7', next: pkg.version },
    }),
    logger: { info() {}, warn() {}, error() {} },
  });

  assert.deepEqual(calls, [['npm-publish', '@magclaw/notify', 'next']]);
  assert.equal(result.verified[0].distTag, 'next');
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

  assert.deepEqual(calls.map((call) => call[0]), ['npm-verify', 'npm-verify', 'npm-verify', 'npm-verify']);
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
