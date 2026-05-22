import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultReleaseNotes, normalizeReleaseNotes } from '../server/release-notes.js';

test('release notes expose independent Web and Daemon version catalogs', () => {
  const notes = defaultReleaseNotes({
    root: new URL('..', import.meta.url).pathname,
    env: {
      MAGCLAW_WEB_VERSION: '0.3.1',
      MAGCLAW_DAEMON_VERSION: '0.1.1',
    },
  });

  assert.equal(notes.web.currentVersion, '0.3.1');
  assert.equal(notes.daemon.currentVersion, '0.1.1');
  assert.match(notes.web.releases[0].title, /Remote daemon/);
  assert.equal(notes.web.releases[0].new[0], 'Owners and admins can trigger daemon upgrades from Computer details.');
  assert.equal(notes.web.releases[0].bugFix[0], 'Queued Agent work resumes after the upgraded daemon reconnects.');
  assert.match(notes.daemon.releases[0].title, /Default magclaw/);
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

  assert.equal(notes.web.currentVersion, '0.3.2');
  assert.deepEqual(notes.web.releases.map((release) => release.version), ['0.3.2', '0.3.1', '0.3.0']);
  assert.equal(notes.web.releases[0].approval[0], 'Remote daemon upgrades still require owner or admin confirmation.');
  assert.equal(notes.web.releases[2].features[0], 'Feishu authorization login is now supported.');
  assert.equal(notes.daemon.releases[0].version, '0.1.12');
});
