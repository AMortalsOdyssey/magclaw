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
});
