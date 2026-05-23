import assert from 'node:assert/strict';
import test from 'node:test';
import { createSystemServices } from '../server/system-services.js';

function makeServices(configureState = null) {
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
