import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { inferDistTag, parseSemver, recommendVersion } from '../scripts/version-policy.mjs';

test('strict SemVer parser accepts supported forms and rejects date/build cores with four parts', () => {
  assert.deepEqual(parseSemver('0.4.0-rc.1+20260803.510'), {
    version: '0.4.0-rc.1+20260803.510',
    major: 0,
    minor: 4,
    patch: 0,
    prerelease: 'rc.1',
    build: '20260803.510',
  });
  assert.throws(() => parseSemver('2026.08.03.510'), /Invalid SemVer/);
  assert.throws(() => parseSemver('v0.4.0'), /Invalid SemVer/);
  assert.throws(() => parseSemver('0.4.0-beta.01'), /Invalid SemVer/);
});

test('version recommendations follow MagClaw pre-1.0 compatibility lines', () => {
  assert.equal(recommendVersion({ version: '0.3.7', change: 'fix' }).nextVersion, '0.3.8');
  assert.equal(recommendVersion({ version: '0.3.7', change: 'feature' }).nextVersion, '0.4.0');
  const breaking = recommendVersion({ version: '0.3.7', change: 'breaking' });
  assert.equal(breaking.nextVersion, '0.4.0');
  assert.equal(breaking.bump, 'minor-compatibility-line');
  assert.equal(recommendVersion({ version: '0.6.4', change: 'stabilize' }).nextVersion, '1.0.0');
});

test('stable packages use strict patch, minor, and major recommendations', () => {
  assert.equal(recommendVersion({ version: '1.2.3', change: 'fix' }).nextVersion, '1.2.4');
  assert.equal(recommendVersion({ version: '1.2.3', change: 'feature' }).nextVersion, '1.3.0');
  assert.equal(recommendVersion({ version: '1.2.3', change: 'breaking' }).nextVersion, '2.0.0');
});

test('prerelease stages map to safe npm dist-tags', () => {
  const beta = recommendVersion({ version: '0.3.7', change: 'feature', stage: 'beta' });
  assert.equal(beta.nextVersion, '0.4.0-beta.1');
  assert.equal(beta.distTag, 'next');
  assert.equal(inferDistTag('0.4.0-alpha.1'), 'canary');
  assert.equal(inferDistTag('0.4.0-rc.1'), 'next');
  assert.equal(inferDistTag('0.4.0-preview.1'), 'next');
  assert.equal(inferDistTag('0.4.0'), 'latest');
});

test('release recommendations advance or finalize the current prerelease core', () => {
  assert.equal(
    recommendVersion({ version: '0.4.0-beta.1', change: 'release', stage: 'beta' }).nextVersion,
    '0.4.0-beta.2',
  );
  const stable = recommendVersion({ version: '0.4.0-rc.2', change: 'release' });
  assert.equal(stable.nextVersion, '0.4.0');
  assert.equal(stable.distTag, 'latest');
  assert.equal(
    recommendVersion({ version: '0.4.0-beta.0', change: 'release', stage: 'beta' }).nextVersion,
    '0.4.0-beta.1',
  );
});

test('tracked repository entrypoints point version decisions to the canonical policy', async () => {
  const versioning = await readFile(new URL('../VERSIONING.md', import.meta.url), 'utf8');
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  assert.equal(packageJson.scripts['version:recommend'], 'node scripts/version-policy.mjs recommend');
  assert.match(readme, /\[VERSIONING\.md\]\(\.\/VERSIONING\.md\)/);
  assert.match(versioning, /the user\s+does not need to provide a version number/i);
  assert.match(versioning, /Choosing and recording the\s+next version does not authorize/);
});
