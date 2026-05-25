import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultReleaseNotes, normalizeReleaseNotes } from '../server/release-notes.js';

test('release notes expose independent Web, Daemon, and Computer version catalogs', () => {
  const notes = defaultReleaseNotes({
    root: new URL('..', import.meta.url).pathname,
    env: {
      MAGCLAW_WEB_VERSION: '0.3.1',
      MAGCLAW_DAEMON_VERSION: '0.1.1',
      MAGCLAW_COMPUTER_VERSION: '0.1.2',
    },
  });

  assert.equal(notes.web.currentVersion, '0.3.1');
  assert.equal(notes.daemon.currentVersion, '0.1.1');
  assert.equal(notes.computer.currentVersion, '0.1.2');
  assert.equal(notes.computer.packageName, '@magclaw/computer');
  assert.match(notes.web.releases[0].title, /Structured message references/);
  assert.equal(notes.web.releases[0].new[0], 'Messages now support structured quote and context references for selections, messages, threads, and visible conversations.');
  assert.equal(notes.web.releases[0].bugFix[0], 'Private or restricted conversation records cannot be smuggled through reference record ids.');
  assert.equal(notes.web.releases[1].new[0], 'Daemon help now documents restart, list, status, stop, and logs commands.');
  assert.equal(notes.web.releases[2].bugFix[0], 'Daemon CLI installation skips transient npx and npm script PATH directories.');
  assert.equal(notes.web.releases[3].new[0], 'Release notes now track daemon CLI status, stop, and restore controls.');
  assert.equal(notes.web.releases[4].bugFix[0], 'Daemon upgrade controls only appear when an update or upgrade state exists.');
  assert.equal(notes.web.releases[5].bugFix[0], 'Remote daemon upgrades no longer trust stale background service state.');
  assert.equal(notes.web.releases[6].bugFix[0], 'Queued Agent work resumes after the upgraded daemon reconnects.');
  assert.match(notes.daemon.releases[0].title, /Restart help and local list/);
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

  assert.equal(notes.web.currentVersion, '0.3.8');
  assert.deepEqual(notes.web.releases.map((release) => release.version), ['0.3.8', '0.3.7', '0.3.6', '0.3.5', '0.3.4', '0.3.3', '0.3.2', '0.3.1', '0.3.0']);
  assert.equal(notes.web.releases[0].new[0], 'Messages now support structured quote and context references for selections, messages, threads, and visible conversations.');
  assert.equal(notes.web.releases[8].features[0], 'Feishu authorization login is now supported.');
  assert.equal(notes.daemon.releases[0].version, '0.1.17');
  assert.equal(notes.computer.releases[0].version, '0.1.23');
});
