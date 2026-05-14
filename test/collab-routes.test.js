import test from 'node:test';
import assert from 'node:assert/strict';
import { handleCollabApi } from '../server/api/collab-routes.js';

function makeResponse() {
  return {
    statusCode: null,
    data: null,
    error: null,
  };
}

function routeDeps(overrides = {}) {
  let id = 0;
  const state = {
    agents: [
      { id: 'agt_one', name: 'One', runtime: 'Codex CLI' },
      { id: 'agt_two', name: 'Two', runtime: 'Codex CLI' },
    ],
    channels: [{
      id: 'chan_all',
      name: 'all',
      humanIds: ['hum_local'],
      agentIds: ['agt_one'],
      memberIds: ['hum_local', 'agt_one'],
      archived: false,
    }],
    computers: [{ id: 'cmp_one', name: 'Old Computer', status: 'offline' }],
    dms: [],
    humans: [{ id: 'hum_local', name: 'You' }],
    messages: [],
  };
  const events = [];
  const memoryUpdates = [];
  return {
    addCollabEvent: (type, message, extra = {}) => events.push({ type, message, extra }),
    agentParticipatesInChannels: (agent) => Boolean(agent),
    broadcastState: () => {},
    findAgent: (agentId) => state.agents.find((agent) => agent.id === agentId),
    findChannel: (channelId) => state.channels.find((channel) => channel.id === channelId),
    findComputer: (computerId) => state.computers.find((computer) => computer.id === computerId),
    getState: () => state,
    makeId: (prefix) => `${prefix}_${++id}`,
    normalizeConversationRecord: (record) => record,
    normalizeIds: (items) => [...new Set((items || []).filter(Boolean).map(String))],
    normalizeName: (value, fallback) => String(value || fallback || '').trim().toLowerCase().replace(/\s+/g, '-'),
    now: () => '2026-05-02T00:00:00.000Z',
    persistState: async () => {},
    readJson: async () => ({}),
    scheduleAgentMemoryWriteback: (agent, trigger, payload) => memoryUpdates.push({ agentId: agent.id, trigger, payload }),
    sendError: (res, statusCode, message) => {
      res.statusCode = statusCode;
      res.error = message;
    },
    sendJson: (res, statusCode, data) => {
      res.statusCode = statusCode;
      res.data = data;
    },
    events,
    memoryUpdates,
    state,
    ...overrides,
  };
}

test('collab route group creates channels with synced membership fields and an anchor message', async () => {
  const deps = routeDeps({
    readJson: async () => ({
      name: 'Product Room',
      humanIds: ['hum_local'],
      agentIds: ['agt_one', 'agt_two', 'agt_missing'],
    }),
  });
  const res = makeResponse();
  const handled = await handleCollabApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/channels'),
    deps,
  );
  assert.equal(handled, true);
  assert.equal(res.statusCode, 201);
  assert.deepEqual(res.data.channel.agentIds, ['agt_one', 'agt_two']);
  assert.deepEqual(res.data.channel.memberIds, ['hum_local', 'agt_one', 'agt_two']);
  assert.equal(deps.state.messages[0].body, 'Channel #product-room created.');
  assert.equal(deps.memoryUpdates[0].trigger, 'channel_membership_changed');
});

test('collab route group stamps cloud channels and DMs with the current workspace', async () => {
  const deps = routeDeps({
    currentActor: () => ({
      user: { id: 'usr_owner', email: 'owner@example.test' },
      member: { workspaceId: 'wsp_main', humanId: 'hum_owner', role: 'admin' },
    }),
    readJson: async () => ({
      name: 'Cloud Room',
      agentIds: ['agt_one'],
    }),
  });
  const channelRes = makeResponse();
  await handleCollabApi(
    { method: 'POST' },
    channelRes,
    new URL('http://local/api/channels'),
    deps,
  );

  assert.equal(channelRes.statusCode, 201);
  assert.equal(channelRes.data.channel.workspaceId, 'wsp_main');
  assert.equal(channelRes.data.channel.humanIds.includes('hum_owner'), true);
  assert.equal(deps.state.messages[0].workspaceId, 'wsp_main');

  deps.readJson = async () => ({ participantId: 'agt_one' });
  const dmRes = makeResponse();
  await handleCollabApi(
    { method: 'POST' },
    dmRes,
    new URL('http://local/api/dms'),
    deps,
  );

  assert.equal(dmRes.statusCode, 200);
  assert.equal(dmRes.data.dm.workspaceId, 'wsp_main');
  assert.deepEqual(dmRes.data.dm.participantIds, ['hum_owner', 'agt_one']);
});

test('collab route group manages channel members across legacy and canonical fields', async () => {
  const deps = routeDeps({
    readJson: async () => ({ memberId: 'agt_one' }),
  });
  deps.state.channels.push({
    id: 'chan_side',
    name: 'side',
    humanIds: ['hum_local'],
    agentIds: [],
    memberIds: ['hum_local'],
    archived: false,
  });
  const channel = deps.state.channels.at(-1);
  channel.memberIds = ['hum_local'];
  channel.agentIds = [];

  const addRes = makeResponse();
  assert.equal(await handleCollabApi(
    { method: 'POST' },
    addRes,
    new URL('http://local/api/channels/chan_side/members'),
    deps,
  ), true);
  assert.deepEqual(channel.memberIds, ['hum_local', 'agt_one']);
  assert.deepEqual(channel.agentIds, ['agt_one']);

  const removeRes = makeResponse();
  assert.equal(await handleCollabApi(
    { method: 'DELETE' },
    removeRes,
    new URL('http://local/api/channels/chan_side/members/agt_one'),
    deps,
  ), true);
  assert.deepEqual(channel.memberIds, ['hum_local']);
  assert.deepEqual(channel.agentIds, []);
});

test('collab route group lets the current human join and leave a channel', async () => {
  const deps = routeDeps({
    currentActor: () => ({
      user: { id: 'usr_cloud', email: 'cloud@example.test' },
      member: { workspaceId: 'wsp_main', humanId: 'hum_cloud', role: 'member' },
    }),
  });
  deps.state.channels.push({
    id: 'chan_cloud',
    workspaceId: 'wsp_main',
    name: 'cloud',
    humanIds: [],
    agentIds: [],
    memberIds: [],
    archived: false,
  });
  const channel = deps.state.channels.at(-1);

  const joinRes = makeResponse();
  assert.equal(await handleCollabApi(
    { method: 'POST' },
    joinRes,
    new URL('http://local/api/channels/chan_cloud/join'),
    deps,
  ), true);
  assert.equal(joinRes.statusCode, 200);
  assert.deepEqual(channel.memberIds, ['hum_cloud']);
  assert.deepEqual(channel.humanIds, ['hum_cloud']);

  const leaveRes = makeResponse();
  assert.equal(await handleCollabApi(
    { method: 'POST' },
    leaveRes,
    new URL('http://local/api/channels/chan_cloud/leave'),
    deps,
  ), true);
  assert.equal(leaveRes.statusCode, 200);
  assert.deepEqual(channel.memberIds, []);
  assert.deepEqual(channel.humanIds, []);
});

test('collab route group keeps all-channel membership locked', async () => {
  const deps = routeDeps();
  const removeRes = makeResponse();
  assert.equal(await handleCollabApi(
    { method: 'DELETE' },
    removeRes,
    new URL('http://local/api/channels/chan_all/members/agt_one'),
    deps,
  ), true);
  assert.equal(removeRes.statusCode, 400);
  assert.equal(deps.state.channels[0].memberIds.includes('agt_one'), true);
});

test('collab route group opens reusable DMs and invites humans into all', async () => {
  const deps = routeDeps({
    readJson: async () => ({ participantId: 'agt_one' }),
  });
  const firstRes = makeResponse();
  await handleCollabApi(
    { method: 'POST' },
    firstRes,
    new URL('http://local/api/dms'),
    deps,
  );
  const secondRes = makeResponse();
  await handleCollabApi(
    { method: 'POST' },
    secondRes,
    new URL('http://local/api/dms'),
    deps,
  );
  assert.equal(deps.state.dms.length, 1);
  assert.equal(firstRes.data.dm.id, secondRes.data.dm.id);

  deps.readJson = async () => ({ email: 'new@example.com', name: 'New Human' });
  const humanRes = makeResponse();
  await handleCollabApi(
    { method: 'POST' },
    humanRes,
    new URL('http://local/api/humans'),
    deps,
  );
  assert.equal(humanRes.statusCode, 201);
  assert.equal(deps.state.channels[0].humanIds.includes(humanRes.data.human.id), true);
});

test('collab route group only lets humans edit their own profile fields', async () => {
  const deps = routeDeps({
    currentActor: () => ({
      user: { id: 'usr_admin', email: 'admin@example.test' },
      member: { workspaceId: 'wsp_main', humanId: 'hum_admin', role: 'admin' },
    }),
    readJson: async () => ({ description: 'edited by admin' }),
  });
  deps.state.humans.push({
    id: 'hum_other',
    workspaceId: 'wsp_main',
    authUserId: 'usr_other',
    name: 'Other',
    description: 'private',
  });
  const res = makeResponse();
  assert.equal(await handleCollabApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/humans/hum_other'),
    deps,
  ), true);
  assert.equal(res.statusCode, 403);
  assert.equal(deps.state.humans.find((human) => human.id === 'hum_other').description, 'private');
});
