import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMessageApi } from '../server/api/message-routes.js';
import {
  agentMemoryWriteIntent,
  inferAgentMemoryWriteback,
  userPreferenceIntent,
} from '../server/intents.js';
import {
  inferAgentPermissionGrant,
  recordAgentPermissionGrant,
} from '../server/agent-permissions.js';
import {
  inferConversationDisclosureGrant,
  recordConversationGrant,
} from '../server/conversation-grants.js';

function makeResponse() {
  return {
    statusCode: null,
    data: null,
    error: null,
  };
}

function routeDeps(overrides = {}) {
  const state = {
    channels: [{ id: 'chan_all', memberIds: ['hum_local'], humanIds: ['hum_local'], agentIds: [] }],
    dms: [{ id: 'dm_1', participantIds: ['hum_local', 'agt_codex'] }],
    messages: [
      { id: 'msg_1', spaceType: 'channel', spaceId: 'chan_all', body: 'one', createdAt: '2026-05-01T00:00:00.000Z' },
      { id: 'msg_2', spaceType: 'channel', spaceId: 'chan_all', body: 'two', createdAt: '2026-05-02T00:00:00.000Z' },
      { id: 'msg_3', spaceType: 'channel', spaceId: 'chan_all', body: 'three', createdAt: '2026-05-03T00:00:00.000Z' },
    ],
    replies: [
      { id: 'rep_1', parentMessageId: 'msg_3', body: 'first', createdAt: '2026-05-03T01:00:00.000Z' },
      { id: 'rep_2', parentMessageId: 'msg_3', body: 'second', createdAt: '2026-05-03T02:00:00.000Z' },
    ],
  };
  const deps = {
    addCollabEvent: () => {},
    addSystemEvent: () => {},
    addSystemReply: () => {},
    agentAvailableForAutoWork: () => false,
    agentCapabilityQuestionIntent: () => false,
    agentMemoryWriteIntent: () => false,
    applyMentions: () => {},
    availabilityFollowupIntent: () => false,
    broadcastState: () => {},
    channelAgentIds: () => [],
    channelHumanIds: () => [],
    createOrClaimTaskForMessage: () => null,
    createTaskFromMessage: () => null,
    createTaskFromThreadIntent: () => null,
    currentActor: () => ({ member: { humanId: 'hum_local', workspaceId: 'local' } }),
    deliverMessageToAgent: async () => {},
    extractMentions: () => ({ agents: [], humans: [] }),
    findAgent: () => null,
    findChannel: (id) => state.channels.find((channel) => channel.id === id),
    findConversationRecord: (id) => state.messages.find((message) => message.id === id)
      || state.replies.find((reply) => reply.id === id),
    findHuman: () => null,
    findMessage: (id) => state.messages.find((message) => message.id === id),
    findTaskForThreadMessage: () => null,
    finishTaskFromThread: () => null,
    getState: () => state,
    inferAgentMemoryWriteback: () => null,
    inferAgentPermissionGrant: () => null,
    inferConversationDisclosureGrant: () => null,
    makeId: (prefix) => `${prefix}_new`,
    normalizeIds: (ids) => [...new Set((ids || []).map(String).filter(Boolean))],
    normalizeConversationRecord: (record) => record,
    now: () => '2026-05-04T00:00:00.000Z',
    persistState: async () => {},
    pickAvailableAgent: () => null,
    readJson: async () => ({}),
    routeMessageForChannel: async () => ({ targetAgentIds: [] }),
    routeThreadReplyForChannel: async () => ({ targetAgentIds: [] }),
    recordAgentPermissionGrant: () => false,
    recordConversationGrant: () => null,
    scheduleAgentMemoryWriteback: () => {},
    searchAgentMemory: async () => ({ ok: true, results: [] }),
    sendError: (res, statusCode, message) => {
      res.statusCode = statusCode;
      res.error = message;
    },
    sendJson: (res, statusCode, data) => {
      res.statusCode = statusCode;
      res.data = data;
    },
    stopTaskFromThread: () => null,
    taskCreationIntent: () => false,
    taskEndIntent: () => false,
    taskStopIntent: () => false,
    taskThreadDeliveryMessage: () => null,
    textAddressesAgent: () => false,
    userPreferenceIntent: () => false,
  };
  return { ...deps, ...overrides, state };
}

test('message route group pages space messages newest-first with an older cursor', async () => {
  const res = makeResponse();
  const handled = await handleMessageApi(
    { method: 'GET' },
    res,
    new URL('http://local/api/spaces/channel/chan_all/messages?limit=2'),
    routeDeps(),
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.data.messages.map((message) => message.id), ['msg_2', 'msg_3']);
  assert.equal(res.data.pagination.hasMore, true);
  assert.equal(res.data.pagination.nextBefore, '2026-05-02T00:00:00.000Z');
  assert.equal(res.data.pagination.nextBeforeId, 'msg_2');
});

test('message route group pages thread replies', async () => {
  const res = makeResponse();
  const handled = await handleMessageApi(
    { method: 'GET' },
    res,
    new URL('http://local/api/messages/msg_3/replies?limit=1'),
    routeDeps(),
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.data.replies.map((reply) => reply.id), ['rep_2']);
  assert.equal(res.data.pagination.hasMore, true);
  assert.equal(res.data.pagination.nextBefore, '2026-05-03T02:00:00.000Z');
  assert.equal(res.data.pagination.nextBeforeId, 'rep_2');
});

test('message route group uses beforeId to avoid duplicate same-timestamp pages', async () => {
  const deps = routeDeps();
  deps.state.messages.push({
    id: 'msg_4',
    spaceType: 'channel',
    spaceId: 'chan_all',
    body: 'same timestamp',
    createdAt: '2026-05-03T00:00:00.000Z',
  });

  const first = makeResponse();
  await handleMessageApi(
    { method: 'GET' },
    first,
    new URL('http://local/api/spaces/channel/chan_all/messages?limit=2'),
    deps,
  );

  assert.deepEqual(first.data.messages.map((message) => message.id), ['msg_3', 'msg_4']);
  assert.equal(first.data.pagination.nextBefore, '2026-05-03T00:00:00.000Z');
  assert.equal(first.data.pagination.nextBeforeId, 'msg_3');

  const second = makeResponse();
  await handleMessageApi(
    { method: 'GET' },
    second,
    new URL(`http://local/api/spaces/channel/chan_all/messages?limit=2&before=${encodeURIComponent(first.data.pagination.nextBefore)}&beforeId=${first.data.pagination.nextBeforeId}`),
    deps,
  );

  assert.deepEqual(second.data.messages.map((message) => message.id), ['msg_1', 'msg_2']);
  assert.equal(second.data.pagination.hasMore, false);
});

test('message route group delegates space message pages to PostgreSQL repository when available', async () => {
  let called = null;
  const deps = routeDeps({
    listSpaceMessagesPage: async (options) => {
      called = options;
      return {
        messages: [{ id: 'pg_msg', spaceType: 'channel', spaceId: 'chan_all', createdAt: '2026-05-04T00:00:00.000Z' }],
        pagination: {
          limit: options.limit,
          hasMore: false,
          nextBefore: '2026-05-04T00:00:00.000Z',
          nextBeforeId: 'pg_msg',
        },
      };
    },
  });

  const res = makeResponse();
  await handleMessageApi(
    { method: 'GET' },
    res,
    new URL('http://local/api/spaces/channel/chan_all/messages?limit=10&before=2026-05-05T00%3A00%3A00.000Z&beforeId=msg_9'),
    deps,
  );

  assert.equal(called.workspaceId, 'local');
  assert.equal(called.spaceType, 'channel');
  assert.equal(called.spaceId, 'chan_all');
  assert.equal(called.limit, 10);
  assert.equal(called.before, '2026-05-05T00:00:00.000Z');
  assert.equal(called.beforeId, 'msg_9');
  assert.deepEqual(res.data.messages.map((message) => message.id), ['pg_msg']);
});

test('message route group can page thread replies from repository when parent is not hydrated', async () => {
  let replyPageOptions = null;
  const deps = routeDeps({
    getMessageById: async (id, options) => ({
      id,
      workspaceId: options.workspaceId,
      spaceType: 'channel',
      spaceId: 'chan_all',
      createdAt: '2026-05-03T00:00:00.000Z',
    }),
    listThreadRepliesPage: async (options) => {
      replyPageOptions = options;
      return {
        replies: [{ id: 'pg_rep', parentMessageId: options.parentMessageId, createdAt: '2026-05-04T00:00:00.000Z' }],
        pagination: {
          limit: options.limit,
          hasMore: false,
          nextBefore: '2026-05-04T00:00:00.000Z',
          nextBeforeId: 'pg_rep',
        },
      };
    },
  });
  deps.state.messages = [];

  const res = makeResponse();
  await handleMessageApi(
    { method: 'GET' },
    res,
    new URL('http://local/api/messages/msg_old/replies?limit=5&before=2026-05-05T00%3A00%3A00.000Z&beforeId=rep_9'),
    deps,
  );

  assert.equal(replyPageOptions.workspaceId, 'local');
  assert.equal(replyPageOptions.parentMessageId, 'msg_old');
  assert.equal(replyPageOptions.limit, 5);
  assert.equal(replyPageOptions.before, '2026-05-05T00:00:00.000Z');
  assert.equal(replyPageOptions.beforeId, 'rep_9');
  assert.deepEqual(res.data.replies.map((reply) => reply.id), ['pg_rep']);
});

test('message search supports filter-only newest-first results and conversation privacy', async () => {
  const deps = routeDeps();
  deps.state.channels = [
    { id: 'chan_all', workspaceId: 'local', name: 'all', memberIds: ['hum_local'], humanIds: ['hum_local'], agentIds: [] },
    { id: 'chan_public', workspaceId: 'local', name: 'public', visibility: 'public', memberIds: [], humanIds: [], agentIds: [] },
    { id: 'chan_private', workspaceId: 'local', name: 'private', visibility: 'private', memberIds: [], humanIds: [], agentIds: [] },
  ];
  deps.state.dms = [
    { id: 'dm_1', workspaceId: 'local', participantIds: ['hum_local', 'agt_codex'] },
    { id: 'dm_hidden', workspaceId: 'local', participantIds: ['hum_other', 'agt_codex'] },
  ];
  deps.state.messages = [
    {
      id: 'msg_old_alpha',
      workspaceId: 'local',
      spaceType: 'channel',
      spaceId: 'chan_all',
      authorType: 'human',
      authorId: 'hum_local',
      body: 'alpha older',
      createdAt: '2026-05-03T00:00:00.000Z',
    },
    {
      id: 'msg_new_alpha',
      workspaceId: 'local',
      spaceType: 'channel',
      spaceId: 'chan_all',
      authorType: 'agent',
      authorId: 'agt_codex',
      body: 'alpha newer',
      createdAt: '2026-05-04T01:00:00.000Z',
    },
    {
      id: 'msg_public_unjoined',
      workspaceId: 'local',
      spaceType: 'channel',
      spaceId: 'chan_public',
      authorType: 'human',
      authorId: 'hum_public',
      body: 'public channel is searchable',
      createdAt: '2026-05-04T02:00:00.000Z',
    },
    {
      id: 'msg_private_hidden',
      workspaceId: 'local',
      spaceType: 'channel',
      spaceId: 'chan_private',
      authorType: 'human',
      authorId: 'hum_private',
      body: 'private channel is not searchable',
      createdAt: '2026-05-04T03:00:00.000Z',
    },
    {
      id: 'msg_dm_visible',
      workspaceId: 'local',
      spaceType: 'dm',
      spaceId: 'dm_1',
      authorType: 'agent',
      authorId: 'agt_codex',
      body: 'private direct visible',
      createdAt: '2026-05-04T04:00:00.000Z',
    },
    {
      id: 'msg_dm_hidden',
      workspaceId: 'local',
      spaceType: 'dm',
      spaceId: 'dm_hidden',
      authorType: 'agent',
      authorId: 'agt_codex',
      body: 'private direct hidden',
      createdAt: '2026-05-04T05:00:00.000Z',
    },
  ];
  deps.state.replies = [
    {
      id: 'rep_alpha',
      workspaceId: 'local',
      parentMessageId: 'msg_new_alpha',
      spaceType: 'channel',
      spaceId: 'chan_all',
      authorType: 'human',
      authorId: 'hum_local',
      body: 'alpha reply newest',
      createdAt: '2026-05-04T06:00:00.000Z',
    },
  ];

  const alpha = makeResponse();
  await handleMessageApi(
    { method: 'GET' },
    alpha,
    new URL('http://local/api/search/messages?q=alpha&limit=10'),
    deps,
  );
  assert.equal(alpha.statusCode, 200);
  assert.deepEqual(alpha.data.results.map((record) => record.id), ['rep_alpha', 'msg_new_alpha', 'msg_old_alpha']);
  assert.deepEqual(alpha.data.parents.map((record) => record.id), ['msg_new_alpha']);

  const today = makeResponse();
  await handleMessageApi(
    { method: 'GET' },
    today,
    new URL('http://local/api/search/messages?range=today&limit=20'),
    deps,
  );
  assert.equal(today.statusCode, 200);
  assert.ok(today.data.results.some((record) => record.id === 'msg_public_unjoined'));
  assert.ok(today.data.results.some((record) => record.id === 'msg_dm_visible'));
  assert.equal(today.data.results.some((record) => record.id === 'msg_private_hidden'), false);
  assert.equal(today.data.results.some((record) => record.id === 'msg_dm_hidden'), false);

  const sender = makeResponse();
  await handleMessageApi(
    { method: 'GET' },
    sender,
    new URL('http://local/api/search/messages?senderId=hum_local&range=today&limit=20'),
    deps,
  );
  assert.equal(sender.statusCode, 200);
  assert.deepEqual(sender.data.results.map((record) => record.id), ['rep_alpha']);
});

test('inbox read endpoint marks a full DM scope including loaded thread replies', async () => {
  const deps = routeDeps();
  deps.state.messages = [
    {
      id: 'msg_dm_agent',
      workspaceId: 'local',
      spaceType: 'dm',
      spaceId: 'dm_1',
      authorType: 'agent',
      authorId: 'agt_codex',
      body: 'unread dm',
      readBy: [],
      createdAt: '2026-05-03T00:00:00.000Z',
    },
    {
      id: 'msg_dm_parent',
      workspaceId: 'local',
      spaceType: 'dm',
      spaceId: 'dm_1',
      authorType: 'human',
      authorId: 'hum_local',
      body: 'thread parent',
      readBy: ['hum_local'],
      createdAt: '2026-05-03T00:01:00.000Z',
    },
    {
      id: 'msg_channel_agent',
      workspaceId: 'local',
      spaceType: 'channel',
      spaceId: 'chan_all',
      authorType: 'agent',
      authorId: 'agt_codex',
      body: 'other space',
      readBy: [],
      createdAt: '2026-05-03T00:02:00.000Z',
    },
  ];
  deps.state.replies = [
    {
      id: 'rep_dm_agent',
      workspaceId: 'local',
      parentMessageId: 'msg_dm_parent',
      spaceType: 'dm',
      spaceId: 'dm_1',
      authorType: 'agent',
      authorId: 'agt_codex',
      body: 'unread dm reply',
      readBy: [],
      createdAt: '2026-05-03T00:03:00.000Z',
    },
    {
      id: 'rep_channel_agent',
      workspaceId: 'local',
      parentMessageId: 'msg_channel_agent',
      spaceType: 'channel',
      spaceId: 'chan_all',
      authorType: 'agent',
      authorId: 'agt_codex',
      body: 'other reply',
      readBy: [],
      createdAt: '2026-05-03T00:04:00.000Z',
    },
  ];
  deps.readJson = async () => ({ spaceType: 'dm', spaceId: 'dm_1' });

  const res = makeResponse();
  await handleMessageApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/inbox/read'),
    deps,
  );

  assert.equal(res.statusCode, 200);
  assert.ok(deps.state.messages.find((message) => message.id === 'msg_dm_agent')?.readBy.includes('hum_local'));
  assert.ok(deps.state.replies.find((reply) => reply.id === 'rep_dm_agent')?.readBy.includes('hum_local'));
  assert.deepEqual(deps.state.messages.find((message) => message.id === 'msg_channel_agent')?.readBy, []);
  assert.deepEqual(deps.state.replies.find((reply) => reply.id === 'rep_channel_agent')?.readBy, []);
  assert.deepEqual(new Set(res.data.readRecordIds), new Set(['msg_dm_agent', 'msg_dm_parent', 'rep_dm_agent']));
});

test('inbox read endpoint sends durable thread scope for replies that are not loaded yet', async () => {
  let durableOptions = null;
  const deps = routeDeps({
    markConversationRecordsRead: async (options) => {
      durableOptions = options;
      return { messageIds: ['msg_3'], replyIds: ['rep_remote'], count: 1 };
    },
    readJson: async () => ({ threadMessageId: 'msg_3' }),
  });
  deps.state.messages[2].workspaceId = 'local';
  deps.state.messages[2].authorType = 'agent';
  deps.state.messages[2].authorId = 'agt_codex';
  deps.state.messages[2].readBy = [];
  deps.state.replies = [
    {
      id: 'rep_1',
      workspaceId: 'local',
      parentMessageId: 'msg_3',
      spaceType: 'channel',
      spaceId: 'chan_all',
      authorType: 'agent',
      authorId: 'agt_codex',
      body: 'loaded reply',
      readBy: [],
      createdAt: '2026-05-03T01:00:00.000Z',
    },
  ];

  const res = makeResponse();
  await handleMessageApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/inbox/read'),
    deps,
  );

  assert.equal(res.statusCode, 200);
  assert.equal(durableOptions.threadMessageId, 'msg_3');
  assert.equal(durableOptions.workspaceId, 'local');
  assert.ok(deps.state.messages[2].readBy.includes('hum_local'));
  assert.ok(deps.state.replies[0].readBy.includes('hum_local'));
  assert.ok(res.data.readRecordIds.includes('rep_remote'));
});

test('message route group can walk large channel, DM, and thread histories without duplicate pages', async () => {
  const deps = routeDeps();
  const isoMinute = (minute) => new Date(Date.UTC(2026, 4, 1, 0, minute)).toISOString();
  const channelIds = Array.from({ length: 240 }, (_, index) => `msg_chan_${String(index + 1).padStart(3, '0')}`);
  const dmIds = Array.from({ length: 220 }, (_, index) => `msg_dm_${String(index + 1).padStart(3, '0')}`);
  const replyIds = Array.from({ length: 360 }, (_, index) => `rep_thread_${String(index + 1).padStart(3, '0')}`);
  deps.state.messages = [
    ...channelIds.map((id, index) => ({
      id,
      workspaceId: 'local',
      spaceType: 'channel',
      spaceId: 'chan_all',
      body: id,
      createdAt: isoMinute(index + 1),
    })),
    ...dmIds.map((id, index) => ({
      id,
      workspaceId: 'local',
      spaceType: 'dm',
      spaceId: 'dm_1',
      body: id,
      createdAt: isoMinute(index + 1000),
    })),
    {
      id: 'msg_thread_root',
      workspaceId: 'local',
      spaceType: 'channel',
      spaceId: 'chan_thread',
      body: 'thread root',
      replyCount: replyIds.length,
      createdAt: isoMinute(2000),
    },
  ];
  deps.state.replies = replyIds.map((id, index) => ({
    id,
    workspaceId: 'local',
    parentMessageId: 'msg_thread_root',
    spaceType: 'channel',
    spaceId: 'chan_all',
    body: id,
    createdAt: isoMinute(index + 3000),
  }));

  async function collectPagedIds(buildUrl, key) {
    const ids = [];
    let before = '';
    let beforeId = '';
    let pageCount = 0;
    while (true) {
      const res = makeResponse();
      await handleMessageApi({ method: 'GET' }, res, buildUrl({ before, beforeId }), deps);
      assert.equal(res.statusCode, 200);
      const pageIds = res.data[key].map((record) => record.id);
      assert.equal(new Set([...ids, ...pageIds]).size, ids.length + pageIds.length);
      ids.push(...pageIds);
      pageCount += 1;
      if (!res.data.pagination.hasMore) break;
      assert.ok(res.data.pagination.nextBefore);
      assert.ok(res.data.pagination.nextBeforeId);
      before = res.data.pagination.nextBefore;
      beforeId = res.data.pagination.nextBeforeId;
      assert.ok(pageCount < 10);
    }
    return ids;
  }

  const cursorQuery = ({ before, beforeId }) => (
    before
      ? `&before=${encodeURIComponent(before)}&beforeId=${encodeURIComponent(beforeId)}`
      : ''
  );
  const channelPages = await collectPagedIds(
    (cursor) => new URL(`http://local/api/spaces/channel/chan_all/messages?limit=80${cursorQuery(cursor)}`),
    'messages',
  );
  const dmPages = await collectPagedIds(
    (cursor) => new URL(`http://local/api/spaces/dm/dm_1/messages?limit=80${cursorQuery(cursor)}`),
    'messages',
  );
  const replyPages = await collectPagedIds(
    (cursor) => new URL(`http://local/api/messages/msg_thread_root/replies?limit=80${cursorQuery(cursor)}`),
    'replies',
  );

  assert.equal(channelPages.length, channelIds.length);
  assert.equal(dmPages.length, dmIds.length);
  assert.equal(replyPages.length, replyIds.length);
  for (const id of channelIds) assert.ok(channelPages.includes(id));
  for (const id of dmIds) assert.ok(dmPages.includes(id));
  for (const id of replyIds) assert.ok(replyPages.includes(id));
});

test('message route group toggles current-human reactions on messages and replies', async () => {
  const deps = routeDeps({
    currentActor: () => ({ member: { humanId: 'hum_reactor', workspaceId: 'local' } }),
    findHuman: (id) => (id === 'hum_reactor' ? { id, name: 'Rhea' } : null),
    readJson: async () => ({ key: 'rocket' }),
  });

  const messageReaction = makeResponse();
  await handleMessageApi(
    { method: 'POST' },
    messageReaction,
    new URL('http://local/api/messages/msg_1/reactions'),
    deps,
  );

  assert.equal(messageReaction.statusCode, 200);
  assert.deepEqual(deps.state.messages[0].reactions, [{
    key: 'rocket',
    emoji: '🚀',
    actorId: 'hum_reactor',
    actorType: 'human',
    actorName: 'Rhea',
    createdAt: '2026-05-04T00:00:00.000Z',
  }]);

  const replyReaction = makeResponse();
  await handleMessageApi(
    { method: 'POST' },
    replyReaction,
    new URL('http://local/api/messages/rep_1/reactions'),
    deps,
  );

  assert.equal(replyReaction.statusCode, 200);
  assert.equal(deps.state.replies[0].reactions[0].key, 'rocket');
  assert.equal(deps.state.replies[0].reactions[0].actorId, 'hum_reactor');
});

test('message route group rejects unknown reactions and toggles duplicate reactions off', async () => {
  const deps = routeDeps({
    currentActor: () => ({ member: { humanId: 'hum_reactor', workspaceId: 'local' } }),
    findHuman: (id) => (id === 'hum_reactor' ? { id, name: 'Rhea' } : null),
  });

  const invalid = makeResponse();
  await handleMessageApi(
    { method: 'POST' },
    invalid,
    new URL('http://local/api/messages/msg_1/reactions'),
    { ...deps, readJson: async () => ({ key: 'not-real' }) },
  );

  assert.equal(invalid.statusCode, 400);
  assert.match(invalid.error, /Reaction is not supported/);

  const add = makeResponse();
  await handleMessageApi(
    { method: 'POST' },
    add,
    new URL('http://local/api/messages/msg_1/reactions'),
    { ...deps, readJson: async () => ({ key: 'heart' }) },
  );
  assert.equal(add.statusCode, 200);
  assert.equal(deps.state.messages[0].reactions.length, 1);

  const remove = makeResponse();
  await handleMessageApi(
    { method: 'POST' },
    remove,
    new URL('http://local/api/messages/msg_1/reactions'),
    { ...deps, readJson: async () => ({ key: 'heart' }) },
  );
  assert.equal(remove.statusCode, 200);
  assert.deepEqual(deps.state.messages[0].reactions, []);
});

test('message route group counts the same reaction from different humans separately', async () => {
  let humanId = 'hum_reactor';
  const deps = routeDeps({
    currentActor: () => ({ member: { humanId, workspaceId: 'local' } }),
    findHuman: (id) => ({ id, name: id === 'hum_reactor' ? 'Rhea' : 'Mo' }),
    readJson: async () => ({ key: 'heart' }),
  });

  const first = makeResponse();
  await handleMessageApi(
    { method: 'POST' },
    first,
    new URL('http://local/api/messages/msg_1/reactions'),
    deps,
  );

  humanId = 'hum_other';
  const second = makeResponse();
  await handleMessageApi(
    { method: 'POST' },
    second,
    new URL('http://local/api/messages/msg_1/reactions'),
    deps,
  );

  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.deepEqual(deps.state.messages[0].reactions.map((reaction) => reaction.actorId), [
    'hum_reactor',
    'hum_other',
  ]);
  assert.equal(deps.state.messages[0].reactions.filter((reaction) => reaction.key === 'heart').length, 2);
});

test('message route group toggles thread follow state from roots and replies', async () => {
  const deps = routeDeps({
    currentActor: () => ({ member: { humanId: 'hum_follower', workspaceId: 'local' } }),
  });

  const followFromReply = makeResponse();
  await handleMessageApi(
    { method: 'POST' },
    followFromReply,
    new URL('http://local/api/messages/rep_1/follow'),
    deps,
  );

  assert.equal(followFromReply.statusCode, 200);
  assert.equal(followFromReply.data.message.id, 'msg_3');
  assert.deepEqual(deps.state.messages[2].followedBy, ['hum_follower']);

  const unfollowFromRoot = makeResponse();
  await handleMessageApi(
    { method: 'POST' },
    unfollowFromRoot,
    new URL('http://local/api/messages/msg_3/follow'),
    deps,
  );

  assert.equal(unfollowFromRoot.statusCode, 200);
  assert.deepEqual(deps.state.messages[2].followedBy, []);
});

test('message route group saves messages with the authenticated human id', async () => {
  const deps = routeDeps({
    currentActor: () => ({ member: { humanId: 'hum_saved', workspaceId: 'local' } }),
  });

  const res = makeResponse();
  await handleMessageApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/messages/msg_1/save'),
    deps,
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(deps.state.messages[0].savedBy, ['hum_saved']);
});

test('message route group accepts DM messages to agents waiting for computer upgrade', async () => {
  const deliveries = [];
  const remoteAgent = {
    id: 'agt_codex',
    workspaceId: 'wsp_upgrade',
    computerId: 'cmp_upgrade',
    name: 'Remote Agent',
    status: 'waiting_for_upgrade',
  };
  const deps = routeDeps({
    deliverMessageToAgent: async (agent, spaceType, spaceId, message) => {
      deliveries.push({ agent, spaceType, spaceId, message });
    },
    findAgent: (id) => (id === remoteAgent.id ? remoteAgent : null),
    readJson: async () => ({ body: 'Please queue this while the daemon upgrades.' }),
  });
  deps.state.connection = { workspaceId: 'wsp_upgrade' };
  deps.state.dms = [{ id: 'dm_upgrade', workspaceId: 'wsp_upgrade', participantIds: ['hum_local', remoteAgent.id] }];
  deps.state.computers = [{
    id: 'cmp_upgrade',
    workspaceId: 'wsp_upgrade',
    name: 'Remote Computer',
    status: 'restarting',
    connectedVia: 'daemon',
    metadata: { daemonUpgrade: { commandId: 'dupgrade_test', status: 'restarting' } },
  }];
  deps.state.agents = [remoteAgent];
  const res = makeResponse();

  const handled = await handleMessageApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/spaces/dm/dm_upgrade/messages'),
    deps,
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 201);
  assert.equal(res.data.message.spaceId, 'dm_upgrade');
  assert.equal(res.data.message.body, 'Please queue this while the daemon upgrades.');
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].agent.id, remoteAgent.id);
  assert.equal(deliveries[0].message.id, res.data.message.id);
});

test('message route group stores structured selected-text references on messages and replies', async () => {
  const deps = routeDeps();
  deps.state.channels = [{ id: 'chan_all', workspaceId: 'wsp_refs', memberIds: ['hum_local'], humanIds: ['hum_local'], agentIds: [] }];
  deps.state.humans = [{ id: 'hum_author', name: 'Cindy' }];
  deps.state.messages = [{
    id: 'msg_source',
    workspaceId: 'wsp_refs',
    spaceType: 'channel',
    spaceId: 'chan_all',
    authorType: 'human',
    authorId: 'hum_author',
    body: 'Alpha beta gamma delta',
    attachmentIds: [],
    createdAt: '2026-05-03T00:00:00.000Z',
  }];
  deps.state.replies = [];
  deps.findHuman = (id) => deps.state.humans.find((human) => human.id === id) || null;
  deps.readJson = async () => ({
    body: '',
    references: [{
      mode: 'quote',
      kind: 'selection',
      sourceRecordId: 'msg_source',
      selectedText: 'beta gamma',
    }],
  });

  const messageRes = makeResponse();
  await handleMessageApi(
    { method: 'POST' },
    messageRes,
    new URL('http://local/api/spaces/channel/chan_all/messages'),
    deps,
  );

  assert.equal(messageRes.statusCode, 201);
  assert.equal(messageRes.data.message.body, '');
  assert.equal(messageRes.data.message.references[0].kind, 'selection');
  assert.equal(messageRes.data.message.references[0].mode, 'quote');
  assert.equal(messageRes.data.message.references[0].selectedText, 'beta gamma');
  assert.equal(messageRes.data.message.references[0].authorName, 'Cindy');
  assert.deepEqual(messageRes.data.message.references[0].recordIds, ['msg_source']);
  assert.deepEqual(messageRes.data.message.metadata.references, messageRes.data.message.references);

  deps.readJson = async () => ({
    body: 'reply with context',
    references: [{
      mode: 'context',
      kind: 'message',
      sourceRecordId: 'msg_source',
    }],
  });

  const replyRes = makeResponse();
  await handleMessageApi(
    { method: 'POST' },
    replyRes,
    new URL(`http://local/api/messages/${messageRes.data.message.id}/replies`),
    deps,
  );

  assert.equal(replyRes.statusCode, 201);
  assert.equal(replyRes.data.reply.references[0].kind, 'message');
  assert.equal(replyRes.data.reply.references[0].mode, 'context');
  assert.equal(replyRes.data.reply.metadata.references[0].sourceRecordId, 'msg_source');
});

test('message route group rejects cross-private conversation references', async () => {
  const deps = routeDeps();
  deps.state.connection = { workspaceId: 'wsp_private' };
  deps.state.channels = [{ id: 'chan_all', workspaceId: 'wsp_private', memberIds: ['hum_local'], humanIds: ['hum_local'], agentIds: [] }];
  deps.state.dms = [{ id: 'dm_private', workspaceId: 'wsp_private', participantIds: ['hum_local', 'agt_codex'] }];
  deps.state.messages = [{
    id: 'msg_private',
    workspaceId: 'wsp_private',
    spaceType: 'dm',
    spaceId: 'dm_private',
    authorType: 'agent',
    authorId: 'agt_codex',
    body: 'private context',
    attachmentIds: [],
    createdAt: '2026-05-03T00:00:00.000Z',
  }];
  deps.readJson = async () => ({
    body: 'try leaking this',
    references: [{ mode: 'context', kind: 'message', sourceRecordId: 'msg_private' }],
  });

  const res = makeResponse();
  await handleMessageApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/spaces/channel/chan_all/messages'),
    deps,
  );

  assert.equal(res.statusCode, 400);
  assert.match(res.error, /Private conversation references/);
});

test('message route group rejects private records smuggled through reference recordIds', async () => {
  const deps = routeDeps();
  deps.state.connection = { workspaceId: 'wsp_private_records' };
  deps.state.channels = [{ id: 'chan_all', workspaceId: 'wsp_private_records', memberIds: ['hum_local'], humanIds: ['hum_local'], agentIds: [] }];
  deps.state.dms = [{ id: 'dm_private', workspaceId: 'wsp_private_records', participantIds: ['hum_local', 'agt_codex'] }];
  deps.state.messages = [
    {
      id: 'msg_public',
      workspaceId: 'wsp_private_records',
      spaceType: 'channel',
      spaceId: 'chan_all',
      authorType: 'human',
      authorId: 'hum_local',
      body: 'public anchor',
      createdAt: '2026-05-03T00:00:00.000Z',
    },
    {
      id: 'msg_private',
      workspaceId: 'wsp_private_records',
      spaceType: 'dm',
      spaceId: 'dm_private',
      authorType: 'agent',
      authorId: 'agt_codex',
      body: 'private payload',
      createdAt: '2026-05-03T00:01:00.000Z',
    },
  ];
  deps.readJson = async () => ({
    body: 'try smuggling this',
    references: [{
      mode: 'context',
      kind: 'conversation',
      sourceRecordId: 'msg_public',
      recordIds: ['msg_public', 'msg_private'],
    }],
  });

  const res = makeResponse();
  await handleMessageApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/spaces/channel/chan_all/messages'),
    deps,
  );

  assert.equal(res.statusCode, 400);
  assert.match(res.error, /Private conversation references/);
});

test('message route group waits for explicit memory writebacks before responding', async () => {
  let memoryFinished = false;
  let responseSawMemoryFinished = null;
  const agent = { id: 'agt_qinyi', name: '秦亦', status: 'idle' };
  const deps = routeDeps({
    agentAvailableForAutoWork: () => true,
    agentMemoryWriteIntent: () => true,
    channelAgentIds: () => [agent.id],
    findAgent: (id) => (id === agent.id ? agent : null),
    findChannel: (id) => deps.state.channels.find((channel) => channel.id === id),
    inferAgentMemoryWriteback: () => ({
      kind: 'capability',
      summary: '专门帮我做业务调研',
      sourceText: '秦亦，以后你专门帮我做业务调研，记到你的 memory 里面',
    }),
    readJson: async () => ({ body: '秦亦，以后你专门帮我做业务调研，记到你的 memory 里面' }),
    routeMessageForChannel: async () => ({ targetAgentIds: [agent.id] }),
    scheduleAgentMemoryWriteback: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      memoryFinished = true;
      return true;
    },
    sendJson: (res, statusCode, data) => {
      responseSawMemoryFinished = memoryFinished;
      res.statusCode = statusCode;
      res.data = data;
    },
  });
  deps.state.channels = [{ id: 'chan_all', memberIds: ['hum_local', agent.id], humanIds: ['hum_local'], agentIds: [agent.id] }];
  deps.state.dms = [];
  deps.state.messages = [];
  deps.state.replies = [];

  const res = makeResponse();
  const handled = await handleMessageApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/spaces/channel/chan_all/messages'),
    deps,
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 201);
  assert.equal(responseSawMemoryFinished, true);
});

test('message route group records mentioned agent specialty assignments in memory', async () => {
  const yuanYao = { id: 'agt_yuanyao', name: '元瑶', status: 'idle' };
  let writeback = null;
  const deps = routeDeps({
    agentMemoryWriteIntent,
    channelAgentIds: () => [yuanYao.id],
    extractMentions: () => ({ agents: [yuanYao.id], humans: [] }),
    findAgent: (id) => (id === yuanYao.id ? yuanYao : null),
    findChannel: (id) => deps.state.channels.find((channel) => channel.id === id),
    inferAgentMemoryWriteback,
    readJson: async () => ({ body: '@元瑶 以后专攻群里的情绪价值的提供' }),
    routeMessageForChannel: async () => ({ targetAgentIds: [] }),
    scheduleAgentMemoryWriteback: async (agent, trigger, payload) => {
      writeback = { agent, trigger, payload };
      return true;
    },
    userPreferenceIntent,
  });
  deps.state.channels = [{ id: 'chan_all', memberIds: ['hum_local', yuanYao.id], humanIds: ['hum_local'], agentIds: [yuanYao.id] }];
  deps.state.messages = [];

  const res = makeResponse();
  const handled = await handleMessageApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/spaces/channel/chan_all/messages'),
    deps,
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 201);
  assert.equal(writeback.agent.id, yuanYao.id);
  assert.equal(writeback.trigger, 'explicit_user_memory');
  assert.deepEqual(writeback.payload.memory, {
    kind: 'capability',
    summary: '专攻群里的情绪价值的提供',
    sourceText: '@元瑶 以后专攻群里的情绪价值的提供',
  });
});

test('message route group persists explicit agent permission grants before delivery', async () => {
  const cindy = { id: 'agt_cindy', name: 'Cindy', status: 'idle', permissionGrants: [] };
  const events = [];
  const persistCalls = [];
  let deliveredGrantCount = null;
  let writeback = null;
  const deps = routeDeps({
    addSystemEvent: (type, message, extra) => events.push({ type, message, ...extra }),
    agentAvailableForAutoWork: () => true,
    channelAgentIds: () => [cindy.id],
    extractMentions: () => ({ agents: [cindy.id], humans: [] }),
    findAgent: (id) => (id === cindy.id ? cindy : null),
    findChannel: (id) => deps.state.channels.find((channel) => channel.id === id),
    inferAgentPermissionGrant,
    persistState: async (options) => {
      persistCalls.push(options || {});
    },
    readJson: async () => ({ body: '@Cindy 以后运行流水线，部署测试环境，不需要我确认，你有这个权限' }),
    recordAgentPermissionGrant,
    routeMessageForChannel: async () => ({ targetAgentIds: [cindy.id] }),
    scheduleAgentMemoryWriteback: async (agent, trigger, payload) => {
      if (trigger === 'permission_grant') writeback = { agent, trigger, payload };
      return true;
    },
    deliverMessageToAgent: async (agent) => {
      deliveredGrantCount = agent.permissionGrants.length;
    },
  });
  deps.state.channels = [{ id: 'chan_all', workspaceId: 'wsp_perm', memberIds: ['hum_local', cindy.id], humanIds: ['hum_local'], agentIds: [cindy.id] }];
  deps.state.messages = [];

  const res = makeResponse();
  const handled = await handleMessageApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/spaces/channel/chan_all/messages'),
    deps,
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 201);
  assert.equal(cindy.permissionGrants.length, 1);
  assert.equal(cindy.permissionGrants[0].kind, 'test_deployment_without_confirmation');
  assert.equal(deliveredGrantCount, 1);
  assert.equal(writeback.trigger, 'permission_grant');
  assert.equal(writeback.payload.memory.kind, 'preference');
  assert.ok(persistCalls.length >= 2);
  assert.ok(persistCalls.every((call) => call.workspaceId === 'wsp_perm'));
  assert.ok(events.some((event) => event.type === 'agent_permission_grant_persisted' && event.agentId === cindy.id));
});

test('message route group persists and revokes DM disclosure grants server-side', async () => {
  const cindy = { id: 'agt_cindy', name: 'Cindy' };
  const events = [];
  const deps = routeDeps({
    addSystemEvent: (type, message, extra) => events.push({ type, message, ...extra }),
    findAgent: (id) => (id === cindy.id ? cindy : null),
    inferConversationDisclosureGrant,
    recordConversationGrant,
  });
  deps.state.connection = { workspaceId: 'wsp_dm' };
  deps.state.conversationGrants = [];
  deps.state.dms = [{ id: 'dm_cindy', workspaceId: 'wsp_dm', participantIds: ['hum_local', cindy.id] }];
  deps.state.messages = [];
  deps.readJson = async () => ({ body: '你可以以后告诉他，但只能总结，不要原文转述' });

  let res = makeResponse();
  let handled = await handleMessageApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/spaces/dm/dm_cindy/messages'),
    deps,
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 201);
  assert.equal(deps.state.conversationGrants.length, 1);
  assert.equal(deps.state.conversationGrants[0].agentId, cindy.id);
  assert.equal(deps.state.conversationGrants[0].sourceTarget, 'dm:dm_cindy');
  assert.equal(deps.state.conversationGrants[0].status, 'active');
  assert.deepEqual(deps.state.conversationGrants[0].actions, ['read', 'summarize']);
  assert.ok(events.some((event) => event.type === 'conversation_grant_persisted' && event.agentId === cindy.id));

  deps.readJson = async () => ({ body: '撤销刚才的授权，不要再告诉别人这个私聊内容' });
  res = makeResponse();
  handled = await handleMessageApi(
    { method: 'POST' },
    res,
    new URL('http://local/api/spaces/dm/dm_cindy/messages'),
    deps,
  );

  assert.equal(handled, true);
  assert.equal(res.statusCode, 201);
  assert.equal(deps.state.conversationGrants.length, 1);
  assert.equal(deps.state.conversationGrants[0].status, 'revoked');
  assert.ok(deps.state.conversationGrants[0].revokedAt);
  assert.ok(events.some((event) => event.type === 'conversation_grant_revoked' && event.agentId === cindy.id));
});
