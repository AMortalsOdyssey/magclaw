import test from 'node:test';
import assert from 'node:assert/strict';
import { handleCollabApi } from '../server/api/collab-routes.js';
import {
  buildChannelImportPath,
  ensureChannelFeishuRouteKey,
} from '../server/integrations/feishu-connect/route-token.js';

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

test('collab route returns Team Sharing onboarding feedback with channel setup command', async () => {
  const deps = routeDeps();
  const res = makeResponse();

  assert.equal(await handleCollabApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/channels/chan_all/feishu-import-path'),
    deps,
  ), true);

  assert.equal(res.statusCode, 200);
  assert.match(res.data.setupCommand, /npx @magclaw\/team-sharing@latest setup/);
  assert.doesNotMatch(res.data.setupCommand, /--format markdown/);
  assert.equal(res.data.onboardingFeedback.status, 'ready');
  assert.ok(res.data.onboardingFeedback.sections.some((section) => section.title === 'Skill 说明'));
  assert.ok(res.data.onboardingFeedback.sections.some((section) => section.title === 'Hooks 功能'));
  assert.ok(res.data.onboardingFeedback.sections.some((section) => section.title === '数据查看'));
  assert.ok(!res.data.onboardingFeedback.sections.some((section) => section.title === 'Usage'));
  assert.deepEqual(res.data.onboardingFeedback.commands, []);
  assert.doesNotMatch(JSON.stringify(res.data.onboardingFeedback), /routeKey|route-key|token|Bearer/i);
});

test('collab route lets active workspace members copy a channel path without joining the channel', async () => {
  const createdAt = '2026-05-02T00:00:00.000Z';
  const deps = routeDeps({
    currentActor: () => ({
      user: { id: 'usr_member', email: 'member@example.test' },
      member: {
        id: 'wmem_member',
        workspaceId: 'wsp_main',
        userId: 'usr_member',
        humanId: 'hum_member',
        role: 'member',
        status: 'active',
      },
    }),
  });
  deps.state.connection = { workspaceId: 'wsp_main' };
  deps.state.cloud = {
    workspaces: [{ id: 'wsp_main', slug: 'main-team', name: 'Main Team', createdAt }],
    workspaceMembers: [
      { id: 'wmem_member', workspaceId: 'wsp_main', userId: 'usr_member', humanId: 'hum_member', role: 'member', status: 'active', joinedAt: createdAt },
    ],
  };
  deps.state.channels.push({
    id: 'chan_private',
    workspaceId: 'wsp_main',
    name: 'private-notes',
    humanIds: ['hum_other'],
    agentIds: [],
    memberIds: ['hum_other'],
    archived: false,
    metadata: {},
  });

  const res = makeResponse();
  assert.equal(await handleCollabApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/channels/chan_private/feishu-import-path'),
    deps,
  ), true);

  assert.equal(res.statusCode, 200);
  assert.equal(res.data.serverId, 'wsp_main');
  assert.equal(res.data.channelId, 'chan_private');
  assert.match(res.data.path, /^mc:\/\/magclaw\/server\/wsp_main\/channel\/chan_private\?key=/);
});

test('collab route resolves signed channel paths only for member servers', async () => {
  const createdAt = '2026-05-02T00:00:00.000Z';
  const deps = routeDeps({
    currentActor: () => ({
      user: { id: 'usr_path', email: 'path@example.test' },
      member: { id: 'wmem_alpha', workspaceId: 'wsp_alpha', userId: 'usr_path', humanId: 'hum_alpha', role: 'member', status: 'active' },
    }),
  });
  deps.state.connection = { workspaceId: 'wsp_alpha' };
  deps.state.cloud = {
    workspaces: [
      { id: 'wsp_alpha', slug: 'alpha-team', name: 'Alpha Team', createdAt },
      { id: 'wsp_beta', slug: 'beta-team', name: 'Beta Team', createdAt },
    ],
    workspaceMembers: [
      { id: 'wmem_alpha', workspaceId: 'wsp_alpha', userId: 'usr_path', humanId: 'hum_alpha', role: 'member', status: 'active', joinedAt: createdAt },
      { id: 'wmem_beta', workspaceId: 'wsp_beta', userId: 'usr_path', humanId: 'hum_beta', role: 'admin', status: 'active', joinedAt: createdAt },
    ],
  };
  const channel = {
    id: 'chan_beta',
    workspaceId: 'wsp_beta',
    name: 'beta-ops',
    humanIds: [],
    agentIds: [],
    memberIds: [],
    archived: false,
    metadata: {},
  };
  const routeKey = ensureChannelFeishuRouteKey(channel, { randomId: () => 'mcch_beta_fixed' });
  deps.state.channels.push(channel);
  const path = buildChannelImportPath({ serverId: 'wsp_beta', channelId: 'chan_beta', routeKey });

  const res = makeResponse();
  assert.equal(await handleCollabApi(
    { method: 'GET' },
    res,
    new URL(`http://local/api/channel-path/resolve?path=${encodeURIComponent(path)}`),
    deps,
  ), true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.data.serverSlug, 'beta-team');
  assert.equal(res.data.serverId, 'wsp_beta');
  assert.equal(res.data.channelId, 'chan_beta');
  assert.equal(res.data.channelName, 'beta-ops');
  assert.equal(res.data.targetType, 'channel');

  const tampered = makeResponse();
  await handleCollabApi(
    { method: 'GET' },
    tampered,
    new URL(`http://local/api/channel-path/resolve?path=${encodeURIComponent(path.replace('mcch_beta_fixed', 'mcch_wrong'))}`),
    deps,
  );
  assert.equal(tampered.statusCode, 404);
  assert.equal(tampered.error, 'Not Found');

  deps.state.cloud.workspaceMembers = deps.state.cloud.workspaceMembers.filter((member) => member.workspaceId !== 'wsp_beta');
  const denied = makeResponse();
  await handleCollabApi(
    { method: 'GET' },
    denied,
    new URL(`http://local/api/channel-path/resolve?path=${encodeURIComponent(path)}`),
    deps,
  );
  assert.equal(denied.statusCode, 404);
  assert.equal(denied.error, 'Not Found');
});

test('collab route hydrates the target workspace before resolving a member channel path', async () => {
  const createdAt = '2026-05-02T00:00:00.000Z';
  const channel = {
    id: 'chan_hydrated',
    workspaceId: 'wsp_beta',
    name: 'hydrated',
    humanIds: [],
    agentIds: [],
    memberIds: [],
    archived: false,
    metadata: {},
  };
  const routeKey = ensureChannelFeishuRouteKey(channel, { randomId: () => 'mcch_hydrated_fixed' });
  const deps = routeDeps({
    currentActor: () => ({
      user: { id: 'usr_path', email: 'path@example.test' },
      member: { id: 'wmem_alpha', workspaceId: 'wsp_alpha', userId: 'usr_path', humanId: 'hum_alpha', role: 'member', status: 'active' },
    }),
    loadWorkspaceIntoState: async (state, workspaceId) => {
      assert.equal(workspaceId, 'wsp_beta');
      state.channels.push(channel);
    },
  });
  deps.state.connection = { workspaceId: 'wsp_alpha' };
  deps.state.cloud = {
    workspaces: [
      { id: 'wsp_alpha', slug: 'alpha-team', name: 'Alpha Team', createdAt },
      { id: 'wsp_beta', slug: 'beta-team', name: 'Beta Team', createdAt },
    ],
    workspaceMembers: [
      { id: 'wmem_alpha', workspaceId: 'wsp_alpha', userId: 'usr_path', humanId: 'hum_alpha', role: 'member', status: 'active', joinedAt: createdAt },
      { id: 'wmem_beta', workspaceId: 'wsp_beta', userId: 'usr_path', humanId: 'hum_beta', role: 'member', status: 'active', joinedAt: createdAt },
    ],
  };
  const path = buildChannelImportPath({ serverId: 'wsp_beta', channelId: 'chan_hydrated', routeKey });

  const res = makeResponse();
  assert.equal(await handleCollabApi(
    { method: 'GET' },
    res,
    new URL(`http://local/api/channel-path/resolve?path=${encodeURIComponent(path)}`),
    deps,
  ), true);

  assert.equal(res.statusCode, 200);
  assert.equal(res.data.serverSlug, 'beta-team');
  assert.equal(res.data.channelId, 'chan_hydrated');
});

test('collab route group restricts daemon upgrades to admins and owners', async () => {
  let relayCall = null;
  const deps = routeDeps({
    daemonRelay: {
      requestDaemonUpgrade: async (computerId, options) => {
        relayCall = { computerId, options };
        return {
          commandId: 'dupgrade_test',
          sent: true,
          reused: false,
          computer: { id: computerId, status: 'upgrade_pending' },
          upgrade: { commandId: 'dupgrade_test', status: 'pending_idle' },
        };
      },
    },
    currentActor: () => ({
      user: { id: 'usr_member' },
      member: { workspaceId: 'wsp_main', humanId: 'hum_member', role: 'member' },
    }),
    readJson: async () => ({ targetVersion: '0.1.11' }),
  });
  const memberRes = makeResponse();
  assert.equal(await handleCollabApi(
    { method: 'POST' },
    memberRes,
    new URL('http://local/api/computers/cmp_one/daemon-upgrade'),
    deps,
  ), true);
  assert.equal(memberRes.statusCode, 403);
  assert.equal(relayCall, null);

  deps.currentActor = () => ({
    user: { id: 'usr_admin' },
    member: { workspaceId: 'wsp_main', humanId: 'hum_admin', role: 'admin' },
  });
  const adminRes = makeResponse();
  assert.equal(await handleCollabApi(
    { method: 'POST' },
    adminRes,
    new URL('http://local/api/computers/cmp_one/daemon-upgrade'),
    deps,
  ), true);
  assert.equal(adminRes.statusCode, 200);
  assert.equal(adminRes.data.commandId, 'dupgrade_test');
  assert.deepEqual(relayCall, {
    computerId: 'cmp_one',
    options: { targetVersion: '0.1.11', packageName: '@magclaw/daemon', requestedBy: 'usr_admin' },
  });
});

test('collab route targets the computer package latest version for computer-launched connections', async () => {
  let relayCall = null;
  const deps = routeDeps({
    daemonRelay: {
      requestDaemonUpgrade: async (computerId, options) => {
        relayCall = { computerId, options };
        return {
          commandId: 'dupgrade_computer',
          sent: true,
          reused: false,
          computer: { id: computerId, status: 'upgrade_pending' },
          upgrade: { commandId: 'dupgrade_computer', status: 'pending_idle' },
        };
      },
    },
    currentActor: () => ({
      user: { id: 'usr_owner' },
      member: { workspaceId: 'wsp_main', humanId: 'hum_owner', role: 'owner' },
    }),
    readJson: async () => ({}),
  });
  deps.state.runtime = {
    daemonLatestVersion: '0.1.30',
    daemonPackageVersion: '0.1.22',
    computerLatestVersion: '0.1.31',
    computerPackageVersion: '0.1.22',
  };
  deps.state.computers[0].connectedVia = 'computer';
  deps.state.computers[0].packageName = '@magclaw/computer';
  deps.state.computers[0].packageVersion = '0.1.22';

  const res = makeResponse();
  assert.equal(await handleCollabApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/computers/cmp_one/daemon-upgrade'),
    deps,
  ), true);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(relayCall, {
    computerId: 'cmp_one',
    options: {
      targetVersion: '0.1.31',
      packageName: '@magclaw/computer',
      requestedBy: 'usr_owner',
    },
  });
});

test('collab route trusts explicit daemon package name over stale computer kind', async () => {
  let relayCall = null;
  const deps = routeDeps({
    daemonRelay: {
      requestDaemonUpgrade: async (computerId, options) => {
        relayCall = { computerId, options };
        return {
          commandId: 'dupgrade_daemon',
          sent: true,
          reused: false,
          computer: { id: computerId, status: 'upgrade_pending' },
          upgrade: { commandId: 'dupgrade_daemon', status: 'pending_idle' },
        };
      },
    },
    currentActor: () => ({
      user: { id: 'usr_owner' },
      member: { workspaceId: 'wsp_main', humanId: 'hum_owner', role: 'owner' },
    }),
    readJson: async () => ({}),
  });
  deps.state.runtime = {
    daemonLatestVersion: '0.1.30',
    computerLatestVersion: '0.1.31',
  };
  deps.state.computers[0].connectedVia = 'computer';
  deps.state.computers[0].packageName = '@magclaw/daemon';
  deps.state.computers[0].packageKind = 'computer';
  deps.state.computers[0].packageVersion = '0.1.23';
  deps.state.computers[0].metadata = {
    package: {
      name: '@magclaw/daemon',
      kind: 'computer',
      version: '0.1.23',
    },
  };

  const res = makeResponse();
  assert.equal(await handleCollabApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/computers/cmp_one/daemon-upgrade'),
    deps,
  ), true);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(relayCall, {
    computerId: 'cmp_one',
    options: {
      targetVersion: '0.1.30',
      packageName: '@magclaw/daemon',
      requestedBy: 'usr_owner',
    },
  });
});

test('collab route requests a remote computer close for owners', async () => {
  let relayCall = null;
  const deps = routeDeps({
    daemonRelay: {
      requestComputerClose: async (computerId, options) => {
        relayCall = { computerId, options };
        return {
          commandId: 'dclose_test',
          sent: true,
          computer: { id: computerId, status: 'offline', metadata: { closeRequestedAt: '2026-05-02T00:00:00.000Z' } },
          stoppedAgents: 2,
        };
      },
    },
    currentActor: () => ({
      user: { id: 'usr_owner' },
      member: { workspaceId: 'wsp_main', humanId: 'hum_owner', role: 'owner' },
    }),
    readJson: async () => ({}),
  });
  deps.state.computers[0].status = 'connected';
  deps.state.agents[0].computerId = 'cmp_one';
  deps.state.agents[0].status = 'working';
  deps.state.agents[1].computerId = 'cmp_one';
  deps.state.agents[1].status = 'thinking';

  const res = makeResponse();
  assert.equal(await handleCollabApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/computers/cmp_one/close'),
    deps,
  ), true);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(relayCall, {
    computerId: 'cmp_one',
    options: {
      requestedBy: 'usr_owner',
      reason: 'closed_from_cloud',
      stopAgents: true,
      disableBackground: true,
    },
  });
  assert.equal(res.data.commandId, 'dclose_test');
  assert.equal(res.data.sent, true);
  assert.equal(res.data.stoppedAgents, 2);
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

test('collab route group persists created cloud channels with the request workspace scope', async () => {
  const persistCalls = [];
  const deps = routeDeps({
    currentActor: () => ({
      user: { id: 'usr_owner', email: 'owner@example.test' },
      member: { workspaceId: 'wsp_main', humanId: 'hum_owner', role: 'admin' },
    }),
    persistState: async (options = {}) => {
      persistCalls.push(options);
    },
    readJson: async () => ({
      name: 'Deploy Safe',
      agentIds: ['agt_one'],
    }),
  });
  const res = makeResponse();
  await handleCollabApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/channels'),
    deps,
  );

  assert.equal(res.statusCode, 201);
  assert.equal(persistCalls.length, 1);
  assert.equal(persistCalls[0].workspaceId, 'wsp_main');
  assert.equal(persistCalls[0].reason, 'channel_created');
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
