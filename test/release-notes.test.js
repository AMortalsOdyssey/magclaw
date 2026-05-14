import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultReleaseNotes, normalizeReleaseNotes } from '../server/release-notes.js';

test('release notes expose independent Web and Daemon version catalogs', () => {
  const notes = defaultReleaseNotes({
    root: new URL('..', import.meta.url).pathname,
    env: {
      MAGCLAW_WEB_VERSION: '0.2.0',
      MAGCLAW_DAEMON_VERSION: '0.1.1',
    },
  });

  assert.equal(notes.web.currentVersion, '0.2.0');
  assert.equal(notes.daemon.currentVersion, '0.1.1');
  assert.match(notes.web.releases[0].title, /Cloud account/);
  assert.match(notes.daemon.releases[0].title, /Production domain/);
});

test('release notes normalization keeps seeded module releases authoritative', () => {
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

  assert.equal(notes.web.releases.find((release) => release.version === '0.2.0').date, '2026-05-09');
  assert.equal(notes.web.releases.find((release) => release.version === '0.2.1').features[0], 'A future feature');
  assert.ok(notes.daemon.releases.length > 0);
});
