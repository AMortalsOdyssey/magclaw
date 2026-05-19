import test from 'node:test';
import assert from 'node:assert/strict';
import { handleMessageApi } from '../server/api/message-routes.js';

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
    makeId: (prefix) => `${prefix}_new`,
    normalizeIds: (ids) => [...new Set((ids || []).map(String).filter(Boolean))],
    normalizeConversationRecord: (record) => record,
    now: () => '2026-05-04T00:00:00.000Z',
    persistState: async () => {},
    pickAvailableAgent: () => null,
    readJson: async () => ({}),
    routeMessageForChannel: async () => ({ targetAgentIds: [] }),
    routeThreadReplyForChannel: async () => ({ targetAgentIds: [] }),
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
