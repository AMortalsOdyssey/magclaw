import assert from 'node:assert/strict';
import test from 'node:test';
import { createSystemServices } from '../server/system-services.js';

function makeServices(configureState = null, options = {}) {
  const createdAt = '2026-05-18T00:00:00.000Z';
  const state = {
    connection: { workspaceId: 'local' },
    settings: {},
    channels: [
      { id: 'chan_all', workspaceId: 'local', name: 'all', memberIds: ['hum_1'], createdAt, updatedAt: createdAt },
      { id: 'chan_member', workspaceId: 'local', name: 'member-room', memberIds: ['hum_1'], createdAt, updatedAt: createdAt },
      { id: 'chan_outside', workspaceId: 'local', name: 'outside-room', memberIds: ['hum_other'], createdAt, updatedAt: createdAt },
    ],
    dms: [{ id: 'dm_1', workspaceId: 'local', participantIds: ['hum_1', 'agt_1'], createdAt, updatedAt: createdAt }],
    messages: [
      { id: 'msg_channel', workspaceId: 'local', spaceType: 'channel', spaceId: 'chan_all', body: 'channel hello', createdAt, updatedAt: createdAt },
      { id: 'msg_dm', workspaceId: 'local', spaceType: 'dm', spaceId: 'dm_1', body: 'dm hello', createdAt, updatedAt: createdAt },
    ],
    replies: [],
    tasks: [
      { id: 'task_member_done', workspaceId: 'local', spaceType: 'channel', spaceId: 'chan_member', title: 'Done for my channel', status: 'done', createdAt, updatedAt: createdAt },
      { id: 'task_outside_done', workspaceId: 'local', spaceType: 'channel', spaceId: 'chan_outside', title: 'Done outside', status: 'done', createdAt, updatedAt: createdAt },
    ],
    runs: [],
    workItems: [],
    events: [],
    routeEvents: [],
    systemNotifications: [],
    attachments: [],
  };
  if (typeof configureState === 'function') configureState(state);
  return createSystemServices({
    addSystemEvent: () => {},
    broadcastState: () => {},
    fanoutApiConfigured: () => false,
    getState: () => state,
    httpError: (status, message) => Object.assign(new Error(message), { status }),
    makeId: (prefix) => `${prefix}_test`,
    now: () => createdAt,
    persistState: async () => {},
    publicCloudState: () => ({
      auth: {
        currentUser: { id: 'usr_1' },
        currentMember: { workspaceId: 'local', humanId: 'hum_1', role: 'admin' },
        storageBackend: 'postgres',
      },
      workspace: { id: 'local', slug: 'local' },
    }),
    projectsForSpace: () => [],
    runningProcesses: new Map(),
    selectedDefaultSpaceId: (spaceType) => (spaceType === 'dm' ? 'dm_1' : 'chan_all'),
    DATA_DIR: '/tmp',
    PORT: 6543,
    ROOT: process.cwd(),
    ...options,
  });
}

test('bootstrap state reads active DM options from event stream requests', () => {
  const services = makeServices();
  const req = {
    url: '/api/events?spaceType=dm&spaceId=dm_1&messageLimit=20&threadRootLimit=40',
    headers: {},
  };

  const snapshot = services.publicBootstrapState(req);

  assert.equal(snapshot.bootstrap.spaceType, 'dm');
  assert.equal(snapshot.bootstrap.spaceId, 'dm_1');
  assert.equal(snapshot.bootstrap.messageLimit, 20);
  assert.equal(snapshot.bootstrap.threadRootLimit, 40);
  assert.deepEqual(snapshot.messages.map((message) => message.body), ['dm hello']);
});

test('bootstrap state includes visible off-space unread agent messages for rail refresh', () => {
  const unreadAt = '2026-05-18T00:05:00.000Z';
  const readAt = '2026-05-18T00:06:00.000Z';
  const services = makeServices((state) => {
    state.dms.push(
      { id: 'dm_other', workspaceId: 'local', participantIds: ['hum_1', 'agt_2'], createdAt: unreadAt, updatedAt: unreadAt },
      { id: 'dm_hidden', workspaceId: 'local', participantIds: ['hum_other', 'agt_3'], createdAt: unreadAt, updatedAt: unreadAt },
    );
    state.messages.push(
      {
        id: 'msg_unread_other_dm',
        workspaceId: 'local',
        spaceType: 'dm',
        spaceId: 'dm_other',
        authorType: 'agent',
        authorId: 'agt_2',
        body: 'new unread off-space DM',
        readBy: [],
        createdAt: unreadAt,
        updatedAt: unreadAt,
      },
      {
        id: 'msg_read_other_dm',
        workspaceId: 'local',
        spaceType: 'dm',
        spaceId: 'dm_other',
        authorType: 'agent',
        authorId: 'agt_2',
        body: 'old read off-space DM',
        readBy: ['hum_1'],
        createdAt: readAt,
        updatedAt: readAt,
      },
      {
        id: 'msg_hidden_unread_dm',
        workspaceId: 'local',
        spaceType: 'dm',
        spaceId: 'dm_hidden',
        authorType: 'agent',
        authorId: 'agt_3',
        body: 'hidden unread DM',
        readBy: [],
        createdAt: unreadAt,
        updatedAt: unreadAt,
      },
    );
  });
  const req = {
    url: '/api/events?spaceType=dm&spaceId=dm_1&messageLimit=20&threadRootLimit=40',
    headers: {},
  };

  const snapshot = services.publicBootstrapState(req);
  const messageIds = snapshot.messages.map((message) => message.id);

  assert.ok(messageIds.includes('msg_unread_other_dm'));
  assert.equal(messageIds.includes('msg_read_other_dm'), false);
  assert.equal(messageIds.includes('msg_hidden_unread_dm'), false);
});

test('bootstrap state limits selected thread replies to the loaded page', () => {
  const services = makeServices((state) => {
    state.messages[0].replyCount = 101;
    state.replies = Array.from({ length: 101 }, (_, index) => {
      const position = index + 1;
      const replyTime = new Date(Date.parse(state.messages[0].createdAt) + position * 60_000).toISOString();
      return {
        id: `rep_${String(position).padStart(3, '0')}`,
        workspaceId: 'local',
        parentMessageId: 'msg_channel',
        spaceType: 'channel',
        spaceId: 'chan_all',
        body: `reply ${position}`,
        createdAt: replyTime,
        updatedAt: replyTime,
      };
    });
  });
  const req = {
    url: '/api/events?spaceType=channel&spaceId=chan_all&threadMessageId=msg_channel&messageLimit=80',
    headers: {},
  };

  const snapshot = services.publicBootstrapState(req);
  const replies = snapshot.replies.filter((reply) => reply.parentMessageId === 'msg_channel');

  assert.equal(replies.length, 80);
  assert.equal(replies[0].id, 'rep_022');
  assert.equal(replies.at(-1).id, 'rep_101');
  assert.equal(snapshot.bootstrap.threadReplies.hasMore, true);
  assert.equal(snapshot.bootstrap.threadReplies.nextBeforeId, 'rep_022');
  assert.equal(snapshot.replies.some((reply) => reply.id === 'rep_001'), false);
});

test('bootstrap state includes terminal task updates for the current member channels', () => {
  const services = makeServices();
  const req = {
    url: '/api/events?spaceType=channel&spaceId=chan_all',
    headers: {},
  };

  const snapshot = services.publicBootstrapState(req);

  assert.equal(snapshot.tasks.some((task) => task.id === 'task_member_done'), true);
  assert.equal(snapshot.tasks.some((task) => task.id === 'task_outside_done'), false);
});

test('public state exposes configured public URL for share exports', () => {
  const previous = process.env.MAGCLAW_PUBLIC_URL;
  process.env.MAGCLAW_PUBLIC_URL = 'https://magclaw.multiego.me/';
  try {
    const services = makeServices();
    const snapshot = services.publicState();

    assert.equal(snapshot.connection.publicUrl, 'https://magclaw.multiego.me');
  } finally {
    if (previous === undefined) delete process.env.MAGCLAW_PUBLIC_URL;
    else process.env.MAGCLAW_PUBLIC_URL = previous;
  }
});

test('runtime snapshot exposes independent NPM latest versions for daemon and computer', () => {
  const services = makeServices(null, {
    npmPackageVersions: {
      latest: (packageName, fallback = '') => {
        if (packageName === '@magclaw/daemon') return '0.1.30';
        if (packageName === '@magclaw/computer') return '0.1.31';
        return fallback;
      },
      refreshAll: () => {},
    },
  });

  const runtime = services.runtimeSnapshot();

  assert.equal(runtime.daemonPackageName, '@magclaw/daemon');
  assert.equal(runtime.daemonLatestVersion, '0.1.30');
  assert.equal(runtime.computerPackageName, '@magclaw/computer');
  assert.equal(runtime.computerLatestVersion, '0.1.31');
});

test('runtime snapshot ignores legacy state package versions and uses NPM latest', () => {
  const services = makeServices((state) => {
    state.packageVersions = {
      '@magclaw/daemon': { latest: '0.1.40', source: 'db' },
      '@magclaw/computer': { version: '0.1.41', source: 'db' },
    };
  }, {
    npmPackageVersions: {
      latest: (packageName, fallback = '') => {
        if (packageName === '@magclaw/daemon') return '0.1.30';
        if (packageName === '@magclaw/computer') return '0.1.31';
        return fallback;
      },
      refreshAll: () => {},
    },
  });

  const runtime = services.runtimeSnapshot();

  assert.equal(runtime.daemonLatestVersion, '0.1.30');
  assert.equal(runtime.computerLatestVersion, '0.1.31');
});

test('package version snapshot refreshes NPM once per 10 minute web cache window', async () => {
  let nowMs = 1_000;
  const calls = [];
  let refreshCount = 0;
  const services = makeServices(null, {
    nowMs: () => nowMs,
    npmPackageVersions: {
      latest: (packageName) => {
        calls.push(['latest', packageName, refreshCount]);
        if (packageName === '@magclaw/daemon') return `0.1.${49 + refreshCount}`;
        if (packageName === '@magclaw/computer') return `0.1.${50 + refreshCount}`;
        return '';
      },
      maybeRefreshAll: () => {
        refreshCount += 1;
        calls.push(['refresh', refreshCount]);
      },
    },
  });

  const first = await services.packageVersionSnapshot();
  const second = await services.packageVersionSnapshot({ serverSlug: 'other-server' });
  nowMs += 9 * 60_000;
  const third = await services.packageVersionSnapshot();
  nowMs += 60_000;
  const fourth = await services.packageVersionSnapshot();

  assert.equal(first.packages['@magclaw/daemon'].latest, '0.1.50');
  assert.equal(second.packages['@magclaw/computer'].latest, '0.1.51');
  assert.equal(third.cacheTtlMs, 10 * 60_000);
  assert.equal(refreshCount, 2);
  assert.equal(calls.filter((call) => call[0] === 'refresh').length, 2);
  assert.equal(fourth.packages['@magclaw/daemon'].source, 'npm-cache');
  assert.equal(fourth.packages['@magclaw/daemon'].latest, '0.1.51');
});

test('package version polling refreshes NPM every 10 minutes and broadcasts updates', async () => {
  let daemonLatest = '';
  let computerLatest = '';
  let refreshCount = 0;
  const broadcasts = [];
  const timers = [];
  const cleared = [];
  const services = makeServices(null, {
    broadcastState: () => broadcasts.push('state'),
    packageVersionPollIntervalMs: 10 * 60_000,
    setIntervalFn: (callback, intervalMs) => {
      const timer = {
        callback,
        intervalMs,
        unrefed: false,
        unref() {
          this.unrefed = true;
        },
      };
      timers.push(timer);
      return timer;
    },
    clearIntervalFn: (timer) => cleared.push(timer),
    npmPackageVersions: {
      latest: (packageName) => {
        if (packageName === '@magclaw/daemon') return daemonLatest;
        if (packageName === '@magclaw/computer') return computerLatest;
        return '';
      },
      maybeRefreshAll: () => {
        refreshCount += 1;
        daemonLatest = `0.1.${40 + refreshCount}`;
        computerLatest = `0.1.${50 + refreshCount}`;
      },
    },
  });

  const timer = services.startPackageVersionPolling();
  await new Promise((resolve) => setImmediate(resolve));
  await timer.callback();
  services.stopPackageVersionPolling();

  assert.equal(timers.length, 1);
  assert.equal(timer.intervalMs, 10 * 60_000);
  assert.equal(timer.unrefed, true);
  assert.equal(refreshCount, 2);
  assert.deepEqual(broadcasts, ['state', 'state']);
  assert.deepEqual(cleared, [timer]);
});

test('package version snapshot falls back to local versions when NPM is unavailable', async () => {
  const services = makeServices((state) => {
    state.packageVersions = {
      '@magclaw/daemon': { latest: '0.1.60', source: 'state' },
    };
  }, {
    npmPackageVersions: {
      latest: (packageName, fallback = '') => (packageName === '@magclaw/computer' ? '0.1.61' : fallback),
      refreshAll: () => {},
    },
  });

  const snapshot = await services.packageVersionSnapshot();

  assert.notEqual(snapshot.packages['@magclaw/daemon'].latest, '0.1.60');
  assert.equal(snapshot.packages['@magclaw/daemon'].source, 'local');
  assert.equal(snapshot.packages['@magclaw/computer'].latest, '0.1.61');
  assert.equal(snapshot.packages['@magclaw/computer'].source, 'npm-cache');
});

test('public state includes minimal identities for visible external human mentions', () => {
  const services = makeServices((state) => {
    state.humans = [
      { id: 'hum_1', workspaceId: 'local', name: 'Owner', email: 'owner@example.com' },
      {
        id: 'hum_external',
        workspaceId: 'other',
        name: 'External Human',
        email: 'external@example.com',
        avatar: 'avatar-data',
      },
    ];
    state.messages.push({
      id: 'msg_external_mention',
      workspaceId: 'local',
      spaceType: 'channel',
      spaceId: 'chan_all',
      body: 'Talk to <@hum_external>',
      mentionedHumanIds: ['hum_external'],
      createdAt: '2026-05-18T00:01:00.000Z',
      updatedAt: '2026-05-18T00:01:00.000Z',
    });
  });

  const snapshot = services.publicState();
  const external = snapshot.humans.find((human) => human.id === 'hum_external');

  assert.equal(Boolean(external), true);
  assert.equal(external.name, 'External Human');
  assert.equal(external.identityReference, true);
  assert.equal(external.avatar, 'avatar-data');
  assert.equal(external.email, undefined);
});
