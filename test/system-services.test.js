import assert from 'node:assert/strict';
import test from 'node:test';
import { createSystemServices } from '../server/system-services.js';

function makeServices() {
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
