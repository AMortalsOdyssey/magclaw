import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultReleaseNotes, normalizeReleaseNotes } from '../server/release-notes.js';

test('release notes expose independent Web, Daemon, and Computer version catalogs', () => {
  const notes = defaultReleaseNotes({
    root: new URL('..', import.meta.url).pathname,
    env: {
      MAGCLAW_WEB_VERSION: '0.4.1',
      MAGCLAW_DAEMON_VERSION: '0.1.1',
      MAGCLAW_COMPUTER_VERSION: '0.1.2',
      MAGCLAW_CLI_CORE_VERSION: '0.1.3',
      MAGCLAW_TEAM_SHARING_VERSION: '0.1.56',
    },
  });

  assert.equal(notes.web.currentVersion, '0.4.1');
  assert.equal(notes.daemon.currentVersion, '0.1.1');
  assert.equal(notes.computer.currentVersion, '0.1.2');
  assert.equal(notes.cliCore.currentVersion, '0.1.3');
  assert.equal(notes.teamSharing.currentVersion, '0.1.56');
  assert.equal(notes.computer.packageName, '@magclaw/computer');
  assert.equal(notes.teamSharing.packageName, '@magclaw/team-sharing');
  assert.equal(notes.cliCore.packageName, '@magclaw/cli-core');
  assert.equal(notes.web.releases[0].version, '0.4.1');
  assert.match(notes.web.releases[0].title, /Package update API/);
  assert.match(notes.web.releases[0].new[0], /package-specific update metadata/i);
  assert.equal(notes.web.releases[1].version, '0.4.0');
  assert.equal(notes.daemon.releases[0].version, '0.1.40');
  assert.match(notes.daemon.releases[0].title, /Shared CLI core alignment/);
  assert.match(notes.teamSharing.releases[0].title, /project lifecycle/i);
  assert.match(notes.teamSharing.releases[0].new[0], /registered projects/i);
  assert.match(notes.cliCore.releases[0].title, /Shared CLI core package/);
});

test('release notes normalization keeps the seeded catalog authoritative', () => {
  const notes = normalizeReleaseNotes({
    web: {
      currentVersion: '0.2.0',
      releases: [
        {
          version: '0.2.0',
          date: '2026-05-09',
          title: 'Custom',
          features: ['A feature'],
        },
        {
          version: '0.2.1',
          date: '2026-05-10',
          title: 'Custom',
          features: ['A future feature'],
        },
      ],
    },
  });

  assert.equal(notes.web.currentVersion, '0.4.1');
  assert.deepEqual(notes.web.releases.map((release) => release.version).slice(0, 3), ['0.4.1', '0.4.0', '0.3.8']);
  assert.match(notes.web.releases[0].new[0], /package-specific update metadata/i);
  assert.equal(notes.web.releases[10].features[0], 'Feishu authorization login is now supported.');
  assert.equal(notes.daemon.releases[0].version, '0.1.40');
  assert.ok(notes.daemon.releases.some((release) => release.version === '0.1.17'));
  assert.equal(notes.computer.releases[0].version, '0.1.40');
  assert.ok(notes.computer.releases.some((release) => release.version === '0.1.23'));
  assert.equal(notes.teamSharing.releases[0].version, '0.1.56');
});

test('release notes can render compact package update markdown', () => {
  const notes = defaultReleaseNotes({
    root: new URL('..', import.meta.url).pathname,
    env: { MAGCLAW_TEAM_SHARING_VERSION: '0.1.55' },
  });
  const latest = notes.teamSharing.releases[0];
  const lines = latest.new.concat(latest.bugFix, latest.approval).slice(0, 5);

  assert.equal(latest.version, '0.1.56');
  assert.ok(lines.length <= 5);
  assert.ok(lines.every((line) => line.length < 160));
});
