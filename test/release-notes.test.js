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
  assert.equal(notes.web.releases[0].version, '0.4.0');
  assert.match(notes.web.releases[0].title, /K8s and context upgrades/);
  assert.equal(notes.web.releases[0].new[0], 'Containerized daemon profiles can now run on K8s with server-managed lifecycle support.');
  assert.equal(notes.web.releases[0].new[1], 'Context packs now include multiple message sources when agents need richer conversation context.');
  assert.equal(notes.web.releases[0].new[2], 'Remote background daemons can be upgraded from the Web without opening the connected machine.');
  assert.equal(notes.web.releases[0].new[3], 'Agent-to-Agent delivery is more reliable across DMs, threads, and routed work.');
  assert.equal(notes.web.releases[0].new[4], 'Agent status surfaces now show clearer working, idle, warming, and upgrade states.');
  assert.equal(notes.web.releases[0].new[5], 'Message context menus now expose more reliable actions for saved, referenced, and shared messages.');
  assert.equal(notes.web.releases[0].new[6], 'Quoted messages now jump directly to their source conversation item.');
  assert.equal(notes.web.releases[0].new[7], 'Task creation now dispatches work to the right owner and collaborators more consistently.');
  assert.equal(notes.web.releases[0].bugFix[0], 'Thread context references now stay in the thread instead of jumping back to the channel.');
  assert.equal(notes.web.releases[1].new[0], 'Messages now support structured quote and context references for selections, messages, threads, and visible conversations.');
  assert.equal(notes.web.releases[2].new[0], 'Daemon help now documents restart, list, status, stop, and logs commands.');
  assert.equal(notes.web.releases[3].bugFix[0], 'Daemon CLI installation skips transient npx and npm script PATH directories.');
  assert.equal(notes.web.releases[4].new[0], 'Release notes now track daemon CLI status, stop, and restore controls.');
  assert.equal(notes.web.releases[5].bugFix[0], 'Daemon upgrade controls only appear when an update or upgrade state exists.');
  assert.equal(notes.web.releases[6].bugFix[0], 'Remote daemon upgrades no longer trust stale background service state.');
  assert.equal(notes.web.releases[7].bugFix[0], 'Queued Agent work resumes after the upgraded daemon reconnects.');
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

  assert.equal(notes.web.currentVersion, '0.4.0');
  assert.deepEqual(notes.web.releases.map((release) => release.version), ['0.4.0', '0.3.8', '0.3.7', '0.3.6', '0.3.5', '0.3.4', '0.3.3', '0.3.2', '0.3.1', '0.3.0']);
  assert.equal(notes.web.releases[0].new[0], 'Containerized daemon profiles can now run on K8s with server-managed lifecycle support.');
  assert.equal(notes.web.releases[9].features[0], 'Feishu authorization login is now supported.');
  assert.equal(notes.daemon.releases[0].version, '0.1.17');
  assert.equal(notes.computer.releases[0].version, '0.1.23');
});
