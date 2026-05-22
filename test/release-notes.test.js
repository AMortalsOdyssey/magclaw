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
  assert.match(notes.web.releases[0].title, /Agent memory/);
  assert.equal(notes.web.releases[0].new[0], 'Agent memory mirrors only MEMORY.md to cloud storage while workspace files stay on the Computer.');
  assert.equal(notes.web.releases[0].bugFix[0], 'Local memory writes succeed even when PVC or PostgreSQL mirror sync fails.');
  assert.match(notes.daemon.releases[0].title, /Runtime-native agent hook layout/);
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

  assert.equal(notes.web.currentVersion, '0.3.1');
  assert.deepEqual(notes.web.releases.map((release) => release.version), ['0.3.1', '0.3.0']);
  assert.equal(notes.web.releases[0].new[0], 'Agent memory mirrors only MEMORY.md to cloud storage while workspace files stay on the Computer.');
  assert.equal(notes.web.releases[1].features[0], 'Feishu authorization login is now supported.');
  assert.equal(notes.daemon.releases[0].version, '0.1.10');
});
