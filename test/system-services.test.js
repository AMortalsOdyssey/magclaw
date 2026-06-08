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

test('bootstrap state bounds off-space unread hydration to newest records', () => {
  const services = makeServices((state) => {
    state.dms.push({
      id: 'dm_bulk',
      workspaceId: 'local',
      participantIds: ['hum_1', 'agt_bulk'],
      createdAt: '2026-05-18T00:10:00.000Z',
      updatedAt: '2026-05-18T00:10:00.000Z',
    });
    const start = Date.parse('2026-05-18T00:10:00.000Z');
    for (let index = 0; index < 300; index += 1) {
      const timestamp = new Date(start + index * 1000).toISOString();
      state.messages.push({
        id: `msg_bulk_${String(index).padStart(3, '0')}`,
        workspaceId: 'local',
        spaceType: 'dm',
        spaceId: 'dm_bulk',
        authorType: 'agent',
        authorId: 'agt_bulk',
        body: `bulk unread ${index} ${'x'.repeat(4096)}`,
        readBy: [],
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
  });
  const req = {
    url: '/api/events?spaceType=dm&spaceId=dm_1&messageLimit=20&threadRootLimit=40',
    headers: {},
  };

  const snapshot = services.publicBootstrapState(req);
  const messageIds = snapshot.messages.map((message) => message.id);
  const bulkIds = messageIds.filter((id) => id.startsWith('msg_bulk_'));

  assert.equal(bulkIds.length, 80);
  assert.ok(messageIds.includes('msg_bulk_299'));
  assert.ok(messageIds.includes('msg_bulk_220'));
  assert.equal(messageIds.includes('msg_bulk_219'), false);
  assert.equal(messageIds.includes('msg_bulk_000'), false);
  assert.deepEqual(snapshot.bootstrap.unreadHydration, {
    limit: 80,
    included: 80,
    truncated: true,
  });
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot), 'utf8') < 500_000);
});

test('bootstrap unread hydration checks read markers without mapping arrays', () => {
  class ReadMarkers extends Array {
    static get [Symbol.species]() {
      return Array;
    }

    map() {
      throw new Error('unread hydration should not allocate mapped read markers');
    }
  }
  const services = makeServices((state) => {
    state.messages.push({
      id: 'msg_read_marker',
      workspaceId: 'local',
      spaceType: 'dm',
      spaceId: 'dm_1',
      authorType: 'agent',
      authorId: 'agt_1',
      body: 'already read off-space message',
      readBy: ReadMarkers.from(['hum_1']),
      createdAt: '2026-05-18T00:10:00.000Z',
      updatedAt: '2026-05-18T00:10:00.000Z',
    });
  });

  const snapshot = services.publicBootstrapState({
    url: '/api/events?spaceType=channel&spaceId=chan_all&messageLimit=20&threadRootLimit=40',
    headers: {},
  });

  assert.equal(snapshot.messages.some((message) => message.id === 'msg_read_marker'), false);
  assert.equal(snapshot.bootstrap.unreadHydration.included, 0);
});

test('bootstrap state hydrates newest unread replies with parent context', () => {
  const services = makeServices((state) => {
    state.dms.push({
      id: 'dm_reply_bulk',
      workspaceId: 'local',
      participantIds: ['hum_1', 'agt_reply_bulk'],
      createdAt: '2026-05-18T00:10:00.000Z',
      updatedAt: '2026-05-18T00:10:00.000Z',
    });
    const start = Date.parse('2026-05-18T00:10:00.000Z');
    for (let index = 0; index < 90; index += 1) {
      const parentTime = new Date(start + index * 1000).toISOString();
      const replyTime = new Date(start + (1000 + index) * 1000).toISOString();
      state.messages.push({
        id: `msg_reply_parent_${String(index).padStart(3, '0')}`,
        workspaceId: 'local',
        spaceType: 'dm',
        spaceId: 'dm_reply_bulk',
        authorType: 'human',
        authorId: 'hum_1',
        body: `parent ${index}`,
        readBy: ['hum_1'],
        replyCount: 0,
        createdAt: parentTime,
        updatedAt: parentTime,
      });
      state.replies.push({
        id: `rep_reply_bulk_${String(index).padStart(3, '0')}`,
        workspaceId: 'local',
        parentMessageId: `msg_reply_parent_${String(index).padStart(3, '0')}`,
        spaceType: 'dm',
        spaceId: 'dm_reply_bulk',
        authorType: 'agent',
        authorId: 'agt_reply_bulk',
        body: `reply ${index}`,
        readBy: [],
        createdAt: replyTime,
        updatedAt: replyTime,
      });
    }
  });
  const req = {
    url: '/api/events?spaceType=dm&spaceId=dm_1&messageLimit=20&threadRootLimit=40',
    headers: {},
  };

  const snapshot = services.publicBootstrapState(req);
  const messageIds = snapshot.messages.map((message) => message.id);
  const replyIds = snapshot.replies.map((reply) => reply.id);

  assert.equal(messageIds.filter((id) => id.startsWith('msg_reply_parent_')).length, 40);
  assert.equal(replyIds.filter((id) => id.startsWith('rep_reply_bulk_')).length, 40);
  assert.ok(messageIds.includes('msg_reply_parent_089'));
  assert.ok(replyIds.includes('rep_reply_bulk_089'));
  assert.ok(messageIds.includes('msg_reply_parent_050'));
  assert.ok(replyIds.includes('rep_reply_bulk_050'));
  assert.equal(messageIds.includes('msg_reply_parent_049'), false);
  assert.equal(replyIds.includes('rep_reply_bulk_049'), false);
  assert.deepEqual(snapshot.bootstrap.unreadHydration, {
    limit: 80,
    included: 80,
    truncated: true,
  });
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

test('bootstrap state projects only the visible conversation window', () => {
  let metadataReads = 0;
  const services = makeServices((state) => {
    state.messages = [];
    const start = Date.parse('2026-05-18T00:00:00.000Z');
    for (let index = 0; index < 600; index += 1) {
      const timestamp = new Date(start + index * 1000).toISOString();
      const message = {
        id: `msg_window_${String(index).padStart(3, '0')}`,
        workspaceId: 'local',
        spaceType: 'channel',
        spaceId: 'chan_all',
        authorType: 'human',
        authorId: 'hum_1',
        body: `windowed message ${index}`,
        readBy: ['hum_1'],
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      Object.defineProperty(message, 'metadata', {
        configurable: true,
        enumerable: true,
        get() {
          metadataReads += 1;
          return { externalImport: { rawPayload: 'server-only' } };
        },
      });
      state.messages.push(message);
    }
  });

  const snapshot = services.publicBootstrapState({
    url: '/api/bootstrap?spaceType=channel&spaceId=chan_all&messageLimit=20&threadRootLimit=20',
    headers: {},
  });

  assert.equal(snapshot.messages.length, 20);
  assert.equal(snapshot.messages[0].id, 'msg_window_580');
  assert.equal(snapshot.messages.at(-1).id, 'msg_window_599');
  assert.equal(snapshot.bootstrap.hasMoreMessages, true);
  assert.ok(metadataReads < 80, `metadata reads should stay windowed, got ${metadataReads}`);
});

test('bootstrap state filters source conversation arrays once before windowing', () => {
  class CountingMessages extends Array {
    static filterCalls = 0;

    static get [Symbol.species]() {
      return Array;
    }

    filter(...args) {
      CountingMessages.filterCalls += 1;
      return super.filter(...args);
    }
  }
  class CountingReplies extends Array {
    static filterCalls = 0;

    static get [Symbol.species]() {
      return Array;
    }

    filter(...args) {
      CountingReplies.filterCalls += 1;
      return super.filter(...args);
    }
  }
  const messages = CountingMessages.from(Array.from({ length: 240 }, (_value, index) => ({
    id: `msg_count_${String(index).padStart(3, '0')}`,
    workspaceId: 'local',
    spaceType: 'channel',
    spaceId: 'chan_all',
    authorType: 'agent',
    authorId: 'agt_1',
    body: `message ${index}`,
    readBy: ['hum_1'],
    createdAt: `2026-05-18T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
    updatedAt: `2026-05-18T00:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
  })));
  const replies = CountingReplies.from(Array.from({ length: 40 }, (_value, index) => ({
    id: `rep_count_${String(index).padStart(3, '0')}`,
    workspaceId: 'local',
    parentMessageId: `msg_count_${String(200 + (index % 20)).padStart(3, '0')}`,
    spaceType: 'channel',
    spaceId: 'chan_all',
    authorType: 'agent',
    authorId: 'agt_1',
    body: `reply ${index}`,
    readBy: ['hum_1'],
    createdAt: `2026-05-18T01:00:${String(index).padStart(2, '0')}.000Z`,
    updatedAt: `2026-05-18T01:00:${String(index).padStart(2, '0')}.000Z`,
  })));
  const services = makeServices((state) => {
    state.messages = messages;
    state.replies = replies;
    state.agents = [{ id: 'agt_1', workspaceId: 'local', name: 'Ada', status: 'idle' }];
  });

  const snapshot = services.publicBootstrapState({
    url: '/api/bootstrap?spaceType=channel&spaceId=chan_all&messageLimit=20&threadRootLimit=20',
    headers: {},
  });

  assert.equal(snapshot.messages.length, 20);
  assert.equal(snapshot.bootstrap.hasMoreMessages, true);
  assert.equal(CountingMessages.filterCalls, 1);
  assert.equal(CountingReplies.filterCalls, 1);
});

test('bootstrap state selects newest conversation window from unsorted state arrays', () => {
  const services = makeServices((state) => {
    state.messages = [
      {
        id: 'msg_oldest',
        workspaceId: 'local',
        spaceType: 'channel',
        spaceId: 'chan_all',
        body: 'oldest',
        createdAt: '2026-05-18T00:00:00.000Z',
        updatedAt: '2026-05-18T00:00:00.000Z',
      },
      {
        id: 'msg_newest',
        workspaceId: 'local',
        spaceType: 'channel',
        spaceId: 'chan_all',
        body: 'newest',
        createdAt: '2026-05-18T00:03:00.000Z',
        updatedAt: '2026-05-18T00:03:00.000Z',
      },
      {
        id: 'msg_middle',
        workspaceId: 'local',
        spaceType: 'channel',
        spaceId: 'chan_all',
        body: 'middle',
        createdAt: '2026-05-18T00:02:00.000Z',
        updatedAt: '2026-05-18T00:02:00.000Z',
      },
      {
        id: 'msg_older',
        workspaceId: 'local',
        spaceType: 'channel',
        spaceId: 'chan_all',
        body: 'older',
        createdAt: '2026-05-18T00:01:00.000Z',
        updatedAt: '2026-05-18T00:01:00.000Z',
      },
    ];
  });

  const snapshot = services.publicBootstrapState({
    url: '/api/bootstrap?spaceType=channel&spaceId=chan_all&messageLimit=2&threadRootLimit=1',
    headers: {},
  });

  assert.deepEqual(snapshot.messages.map((message) => message.id), ['msg_middle', 'msg_newest']);
  assert.equal(snapshot.bootstrap.hasMoreMessages, true);
  assert.equal(snapshot.bootstrap.nextBeforeId, 'msg_middle');
});

test('bootstrap state can compact conversation records into tuple rows', () => {
  const createdAt = '2026-05-18T00:10:00.000Z';
  const services = makeServices((state) => {
    state.messages[0].replyCount = 1;
    state.replies.push({
      id: 'rep_channel',
      workspaceId: 'local',
      parentMessageId: 'msg_channel',
      spaceType: 'channel',
      spaceId: 'chan_all',
      authorType: 'agent',
      authorId: 'agt_1',
      body: 'reply body',
      readBy: [],
      createdAt,
      updatedAt: createdAt,
    });
    state.tasks.push({
      id: 'task_channel',
      workspaceId: 'local',
      spaceType: 'channel',
      spaceId: 'chan_all',
      title: 'Channel task',
      status: 'todo',
      createdAt,
      updatedAt: createdAt,
    });
  });

  const plain = services.publicBootstrapState({
    url: '/api/bootstrap?spaceType=channel&spaceId=chan_all&messageLimit=20&threadRootLimit=20',
    headers: {},
  });
  const compact = services.publicBootstrapState({
    url: '/api/bootstrap?spaceType=channel&spaceId=chan_all&messageLimit=20&threadRootLimit=20&conversationFormat=tuple-v1',
    headers: {},
  });
  const decode = (entry, fields = []) => {
    const record = {};
    fields.forEach((field, index) => {
      if (entry[index] !== undefined && entry[index] !== null) record[field] = entry[index];
    });
    const extra = entry[fields.length];
    if (extra && typeof extra === 'object' && !Array.isArray(extra)) Object.assign(record, extra);
    return record;
  };

  assert.equal(Array.isArray(plain.messages[0]), false);
  assert.equal(compact.bootstrap.conversationFormat, 'tuple-v1');
  assert.equal(Array.isArray(compact.messages[0]), true);
  assert.equal(Array.isArray(compact.replies[0]), true);
  assert.equal(Array.isArray(compact.tasks[0]), true);
  assert.equal(decode(compact.messages[0], compact.bootstrap.conversationFields.messages).body, 'channel hello');
  assert.equal(decode(compact.messages[0], compact.bootstrap.conversationFields.messages).replyCount, 1);
  assert.equal(decode(compact.replies[0], compact.bootstrap.conversationFields.replies).parentMessageId, 'msg_channel');
  assert.equal(decode(compact.replies[0], compact.bootstrap.conversationFields.replies).body, 'reply body');
  assert.equal(decode(compact.tasks.find((task) => task[0] === 'task_channel'), compact.bootstrap.conversationFields.tasks).title, 'Channel task');
  assert.equal(decode(compact.tasks.find((task) => task[0] === 'task_channel'), compact.bootstrap.conversationFields.tasks).status, 'todo');
});

test('bootstrap state truncates only background conversation preview bodies', () => {
  const base = Date.parse('2026-05-18T00:00:00.000Z');
  const longRootBody = `thread root ${'r'.repeat(600)}`;
  const longReplyBody = `thread reply ${'p'.repeat(600)}`;
  const services = makeServices((state) => {
    state.messages = [
      {
        id: 'msg_current',
        workspaceId: 'local',
        spaceType: 'channel',
        spaceId: 'chan_all',
        authorType: 'agent',
        authorId: 'agt_1',
        body: `current page ${'c'.repeat(600)}`,
        readBy: ['hum_1'],
        createdAt: new Date(base + 5 * 60_000).toISOString(),
        updatedAt: new Date(base + 5 * 60_000).toISOString(),
      },
      {
        id: 'msg_thread',
        workspaceId: 'local',
        spaceType: 'channel',
        spaceId: 'chan_all',
        authorType: 'agent',
        authorId: 'agt_1',
        body: longRootBody,
        readBy: ['hum_1'],
        replyCount: 1,
        createdAt: new Date(base + 4 * 60_000).toISOString(),
        updatedAt: new Date(base + 4 * 60_000).toISOString(),
      },
      {
        id: 'msg_old',
        workspaceId: 'local',
        spaceType: 'channel',
        spaceId: 'chan_all',
        authorType: 'agent',
        authorId: 'agt_1',
        body: 'old',
        readBy: ['hum_1'],
        createdAt: new Date(base + 1 * 60_000).toISOString(),
        updatedAt: new Date(base + 1 * 60_000).toISOString(),
      },
    ];
    state.replies = [{
      id: 'rep_thread',
      workspaceId: 'local',
      parentMessageId: 'msg_thread',
      spaceType: 'channel',
      spaceId: 'chan_all',
      authorType: 'agent',
      authorId: 'agt_1',
      body: longReplyBody,
      readBy: ['hum_1'],
      createdAt: new Date(base + 6 * 60_000).toISOString(),
      updatedAt: new Date(base + 6 * 60_000).toISOString(),
    }];
  });

  const preview = services.publicBootstrapState({
    url: '/api/bootstrap?spaceType=channel&spaceId=chan_all&messageLimit=1&threadRootLimit=20',
    headers: {},
  });
  const previewRoot = preview.messages.find((message) => message.id === 'msg_thread');
  const previewReply = preview.replies.find((reply) => reply.id === 'rep_thread');
  assert.equal(preview.messages.find((message) => message.id === 'msg_current').bodyTruncated, undefined);
  assert.equal(previewRoot.bodyTruncated, true);
  assert.equal(previewRoot.body.length, 140);
  assert.equal(previewReply.bodyTruncated, true);
  assert.equal(previewReply.body.length, 140);

  const opened = services.publicBootstrapState({
    url: '/api/bootstrap?spaceType=channel&spaceId=chan_all&threadMessageId=msg_thread&messageLimit=1&threadRootLimit=20',
    headers: {},
  });
  assert.equal(opened.messages.find((message) => message.id === 'msg_thread').body, longRootBody);
  assert.equal(opened.messages.find((message) => message.id === 'msg_thread').bodyTruncated, undefined);
  assert.equal(opened.replies.find((reply) => reply.id === 'rep_thread').body, longReplyBody);
  assert.equal(opened.replies.find((reply) => reply.id === 'rep_thread').bodyTruncated, undefined);
});

test('bootstrap state windows task hydration and keeps referenced task records', () => {
  const baseTime = Date.parse('2026-05-18T00:00:00.000Z');
  const services = makeServices((state) => {
    state.tasks = Array.from({ length: 120 }, (_, index) => {
      const position = index + 1;
      const updatedAt = new Date(baseTime + position * 60_000).toISOString();
      return {
        id: `task_${String(position).padStart(3, '0')}`,
        workspaceId: 'local',
        spaceType: 'channel',
        spaceId: 'chan_all',
        title: `Task ${position}`,
        status: 'todo',
        createdAt: updatedAt,
        updatedAt,
      };
    });
    state.messages.push({
      id: 'msg_old_task_reference',
      workspaceId: 'local',
      spaceType: 'channel',
      spaceId: 'chan_all',
      taskId: 'task_001',
      body: 'old referenced task',
      createdAt: new Date(baseTime + 130 * 60_000).toISOString(),
      updatedAt: new Date(baseTime + 130 * 60_000).toISOString(),
    });
  });

  const snapshot = services.publicBootstrapState({
    url: '/api/bootstrap?spaceType=channel&spaceId=chan_all&taskLimit=40',
    headers: {},
  });
  const taskIds = snapshot.tasks.map((task) => task.id);

  assert.equal(snapshot.bootstrap.tasks.limit, 40);
  assert.equal(snapshot.bootstrap.tasks.openCount, 120);
  assert.equal(snapshot.bootstrap.tasks.space.hasMore, true);
  assert.equal(snapshot.bootstrap.tasks.space.nextBeforeId, 'task_081');
  assert.equal(snapshot.bootstrap.tasks.global.hasMore, true);
  assert.equal(taskIds.includes('task_120'), true);
  assert.equal(taskIds.includes('task_081'), true);
  assert.equal(taskIds.includes('task_080'), false);
  assert.equal(taskIds.includes('task_001'), true);
  assert.ok(snapshot.tasks.length <= 41);
});

test('bootstrap state formats Team Sharing interaction replies as paired questions and answers', () => {
  const services = makeServices((state) => {
    state.messages[0].replyCount = 1;
    state.replies.push({
      id: 'rep_team_sharing_interaction',
      workspaceId: 'local',
      parentMessageId: 'msg_channel',
      spaceType: 'channel',
      spaceId: 'chan_all',
      body: [
        'Agent 提问：链接范围：这次“MagClaw 生成的任何链接都要登录”具体保护到哪一类链接？',
        'Agent 提问：机器绑定：Team Sharing CLI token 的机器绑定做到哪种强度？',
        '用户回答：机器绑定：软绑定 (Recommended)',
        '用户回答：链接范围：内容+工作区',
      ].join('\n'),
      metadata: {
        teamSharing: {
          presentation: {
            mode: 'interaction',
            source: 'codex',
            interaction: {
              questions: [
                {
                  id: 'links',
                  header: '链接范围',
                  question: '这次“MagClaw 生成的任何链接都要登录”具体保护到哪一类链接？',
                  options: [{ label: '内容+工作区', description: '保护会话内容与工作区入口。' }],
                },
                {
                  id: 'binding',
                  header: '机器绑定',
                  question: 'Team Sharing CLI token 的机器绑定做到哪种强度？',
                  options: [{ label: '软绑定 (Recommended)', description: '按设备信息提示风险，不硬拦正常使用。' }],
                },
              ],
              answers: [
                { id: 'binding', values: ['软绑定 (Recommended)'] },
                { id: 'links', values: ['内容+工作区'] },
              ],
            },
          },
        },
      },
      createdAt: '2026-05-18T00:01:00.000Z',
      updatedAt: '2026-05-18T00:01:00.000Z',
    });
  });
  const req = {
    url: '/api/events?spaceType=channel&spaceId=chan_all&threadMessageId=msg_channel&messageLimit=80',
    headers: {},
  };

  const snapshot = services.publicBootstrapState(req);
  const reply = snapshot.replies.find((item) => item.id === 'rep_team_sharing_interaction');

  assert.ok(reply);
  assert.match(reply.body, /\*\*Agent 提问：链接范围\*\*：这次“MagClaw 生成的任何链接都要登录”具体保护到哪一类链接？/);
  assert.match(reply.body, /\*\*用户回答：\*\* 内容\+工作区 `（保护会话内容与工作区入口。）`/);
  assert.ok(reply.body.indexOf('内容+工作区') < reply.body.indexOf('**Agent 提问：机器绑定**'));
  assert.ok(reply.body.indexOf('**Agent 提问：机器绑定**') < reply.body.indexOf('软绑定 (Recommended)'));
  assert.doesNotMatch(reply.body, /^Agent 提问：/m);
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

test('bootstrap state keeps object directories by default and supports tuple directory opt-in', () => {
  const createdAt = '2026-05-18T00:00:00.000Z';
  const services = makeServices((state) => {
    state.agents = [{
      id: 'agt_public',
      workspaceId: 'local',
      name: 'Public Agent',
      description: 'Shown in members',
      status: 'working',
      runtime: 'codex',
      runtimeId: 'codex',
      model: 'gpt-test',
      activeWorkItemIds: ['wi_1'],
      createdAt,
      updatedAt: createdAt,
    }];
    state.humans = [{
      id: 'hum_1',
      workspaceId: 'local',
      name: 'Human One',
      role: 'owner',
      status: 'online',
      lastSeenAt: createdAt,
      createdAt,
      updatedAt: createdAt,
    }];
  }, {
    publicCloudState: () => ({
      auth: {
        currentUser: { id: 'usr_1' },
        currentMember: { workspaceId: 'local', humanId: 'hum_1', role: 'owner' },
        storageBackend: 'postgres',
      },
      workspace: { id: 'local', slug: 'local' },
      members: [{
        id: 'mem_1',
        workspaceId: 'local',
        userId: 'usr_1',
        humanId: 'hum_1',
        role: 'owner',
        status: 'active',
        createdAt,
        updatedAt: createdAt,
        user: { id: 'usr_1', name: 'Human One', email: 'human@example.test' },
        human: { id: 'hum_1', name: 'Human One', email: 'human@example.test' },
      }],
    }),
  });

  const objectSnapshot = services.publicBootstrapState({
    url: '/api/bootstrap?spaceType=channel&spaceId=chan_all',
    headers: {},
  });
  assert.equal(Array.isArray(objectSnapshot.agents[0]), false);
  assert.equal(objectSnapshot.bootstrap.directoryFormat, undefined);
  assert.equal(objectSnapshot.agents[0].id, 'agt_public');
  assert.equal(objectSnapshot.cloud.members[0].human, undefined);

  const tupleSnapshot = services.publicBootstrapState({
    url: '/api/bootstrap?spaceType=channel&spaceId=chan_all&directoryFormat=tuple-v1',
    headers: {},
  });
  assert.equal(tupleSnapshot.bootstrap.directoryFormat, 'tuple-v1');
  assert.deepEqual(tupleSnapshot.agents[0].slice(0, 8), [
    'agt_public',
    'Public Agent',
    'Shown in members',
    'working',
    'codex',
    'gpt-test',
    createdAt,
    ['wi_1'],
  ]);
  assert.deepEqual(tupleSnapshot.humans[0].slice(0, 5), ['hum_1', 'Human One', 'owner', 'online', createdAt]);
  assert.deepEqual(tupleSnapshot.cloud.members[0].slice(0, 5), [
    'mem_1',
    'usr_1',
    'hum_1',
    { email: 'human@example.test' },
    'owner',
  ]);
});

test('bootstrap state only includes web release notes needed by first paint settings', () => {
  const services = makeServices();

  const bootstrap = services.publicBootstrapState({
    url: '/api/bootstrap?spaceType=channel&spaceId=chan_all',
    headers: {},
  });
  const full = services.publicState({ url: '/api/state', headers: {} });

  assert.deepEqual(Object.keys(bootstrap.releaseNotes).sort(), ['web']);
  assert.equal(Boolean(bootstrap.releaseNotes.web), true);
  assert.equal(Boolean(full.releaseNotes.daemon), true);
});

test('bootstrap visible directory scope trims startup members and directory endpoint hydrates full roster', () => {
  const createdAt = '2026-05-18T00:00:00.000Z';
  const services = makeServices((state) => {
    state.agents = [
      {
        id: 'agt_visible',
        workspaceId: 'local',
        name: 'Visible Agent',
        description: 'Author in the selected channel',
        status: 'working',
        runtime: 'codex',
        model: 'gpt-test',
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: 'agt_hidden',
        workspaceId: 'local',
        name: 'Hidden Agent',
        status: 'idle',
        runtime: 'codex',
        model: 'gpt-test',
        createdAt,
        updatedAt: createdAt,
      },
    ];
    state.humans = [
      { id: 'hum_1', workspaceId: 'local', name: 'Current Human', role: 'owner', status: 'online', createdAt, updatedAt: createdAt },
      { id: 'hum_hidden', workspaceId: 'local', name: 'Hidden Human', role: 'member', status: 'offline', createdAt, updatedAt: createdAt },
    ];
    state.messages[0].authorType = 'agent';
    state.messages[0].authorId = 'agt_visible';
  }, {
    publicCloudState: () => ({
      auth: {
        currentUser: { id: 'usr_1' },
        currentMember: { id: 'mem_1', workspaceId: 'local', humanId: 'hum_1', role: 'owner' },
        storageBackend: 'postgres',
      },
      workspace: { id: 'local', slug: 'local' },
      members: [
        {
          id: 'mem_1',
          workspaceId: 'local',
          userId: 'usr_1',
          humanId: 'hum_1',
          role: 'owner',
          status: 'active',
          createdAt,
          updatedAt: createdAt,
          user: { id: 'usr_1', name: 'Current Human', email: 'current@example.test' },
        },
        {
          id: 'mem_hidden',
          workspaceId: 'local',
          userId: 'usr_hidden',
          humanId: 'hum_hidden',
          role: 'member',
          status: 'active',
          createdAt,
          updatedAt: createdAt,
          user: { id: 'usr_hidden', name: 'Hidden Human', email: 'hidden@example.test' },
        },
      ],
      invitations: [
        {
          id: 'inv_pending',
          workspaceId: 'local',
          email: 'pending@example.test',
          role: 'admin',
          status: 'pending',
          createdAt: '2026-05-19T00:00:00.000Z',
          expiresAt: '2999-01-01T00:00:00.000Z',
        },
      ],
    }),
  });

  const startup = services.publicBootstrapState({
    url: '/api/bootstrap?spaceType=channel&spaceId=chan_all&directoryFormat=tuple-v1&directoryScope=visible',
    headers: {},
  });
  assert.equal(startup.bootstrap.directory.scope, 'visible');
  assert.equal(startup.bootstrap.directory.agents.total, 2);
  assert.equal(startup.bootstrap.directory.humans.total, 2);
  assert.equal(startup.bootstrap.directory.members.total, 2);
  assert.deepEqual(startup.agents.map((agent) => agent[0]), ['agt_visible']);
  assert.deepEqual(startup.humans.map((human) => human[0]), ['hum_1']);
  assert.deepEqual(startup.cloud.members.map((member) => member[0]), ['mem_1']);

  const leanStartup = makeServices((state) => {
    state.agents = [
      {
        id: 'agt_visible',
        workspaceId: 'local',
        name: 'Visible Agent',
        status: 'working',
        runtime: 'codex',
        model: 'gpt-test',
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: 'agt_hidden',
        workspaceId: 'local',
        name: 'Hidden Agent',
        status: 'idle',
        get envVars() {
          throw new Error('visible bootstrap should not project hidden agents');
        },
      },
    ];
    state.humans = [
      { id: 'hum_1', workspaceId: 'local', name: 'Current Human', role: 'owner', status: 'online', createdAt, updatedAt: createdAt },
      {
        id: 'hum_hidden',
        workspaceId: 'local',
        get name() {
          throw new Error('visible bootstrap should not project hidden humans');
        },
      },
    ];
    state.messages[0].authorType = 'agent';
    state.messages[0].authorId = 'agt_visible';
  }, {
    publicCloudState: () => ({
      auth: {
        currentUser: { id: 'usr_1' },
        currentMember: { id: 'mem_1', workspaceId: 'local', humanId: 'hum_1', role: 'owner' },
        storageBackend: 'postgres',
      },
      workspace: { id: 'local', slug: 'local' },
      members: [
        { id: 'mem_1', workspaceId: 'local', userId: 'usr_1', humanId: 'hum_1', role: 'owner', status: 'active' },
        {
          id: 'mem_hidden',
          workspaceId: 'local',
          userId: 'usr_hidden',
          humanId: 'hum_hidden',
          get user() {
            throw new Error('visible bootstrap should not project hidden members');
          },
        },
      ],
    }),
  }).publicBootstrapState({
    url: '/api/bootstrap?spaceType=channel&spaceId=chan_all&directoryFormat=tuple-v1&directoryScope=visible',
    headers: {},
  });
  assert.deepEqual(leanStartup.agents.map((agent) => agent[0]), ['agt_visible']);
  assert.deepEqual(leanStartup.humans.map((human) => human[0]), ['hum_1']);
  assert.deepEqual(leanStartup.cloud.members.map((member) => member[0]), ['mem_1']);
  assert.equal(leanStartup.bootstrap.directory.agents.total, 2);
  assert.equal(leanStartup.bootstrap.directory.humans.total, 2);
  assert.equal(leanStartup.bootstrap.directory.members.total, 2);

  const directory = services.publicDirectoryState({
    url: '/api/directory?directoryFormat=tuple-v1',
    headers: {},
  });
  assert.equal(directory.bootstrap.directory.scope, 'full');
  assert.deepEqual(directory.agents.map((agent) => agent[0]), ['agt_visible', 'agt_hidden']);
  assert.deepEqual(directory.humans.map((human) => human[0]), ['hum_1', 'hum_hidden']);
  assert.deepEqual(directory.cloud.members.map((member) => member[0]), ['mem_1', 'mem_hidden']);

  const firstPage = services.publicDirectoryState({
    url: '/api/directory?directoryFormat=tuple-v1&limit=1',
    headers: {},
  });
  assert.equal(firstPage.bootstrap.directory.scope, 'page');
  assert.equal(firstPage.bootstrap.directory.page.hasMore, true);
  assert.equal(firstPage.bootstrap.directory.page.nextCursor, '1:1:1');
  assert.deepEqual(firstPage.agents.map((agent) => agent[0]), ['agt_visible']);
  assert.deepEqual(firstPage.humans.map((human) => human[0]), ['hum_1']);
  assert.deepEqual(firstPage.cloud.members.map((member) => member[0]), ['mem_1']);

  const leanDirectoryPage = makeServices((state) => {
    state.agents = [
      {
        id: 'agt_visible',
        workspaceId: 'local',
        name: 'Visible Agent',
        status: 'working',
        runtime: 'codex',
        model: 'gpt-test',
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: 'agt_hidden',
        workspaceId: 'local',
        name: 'Hidden Agent',
        status: 'idle',
        get envVars() {
          throw new Error('directory page should not project off-page agents');
        },
      },
    ];
    state.humans = [
      { id: 'hum_1', workspaceId: 'local', name: 'Current Human', role: 'owner', status: 'online', createdAt, updatedAt: createdAt },
      {
        id: 'hum_hidden',
        workspaceId: 'local',
        get name() {
          throw new Error('directory page should not project off-page humans');
        },
      },
    ];
  }, {
    publicCloudState: () => ({
      auth: {
        currentUser: { id: 'usr_1' },
        currentMember: { id: 'mem_1', workspaceId: 'local', humanId: 'hum_1', role: 'owner' },
        storageBackend: 'postgres',
      },
      workspace: { id: 'local', slug: 'local' },
      members: [
        { id: 'mem_1', workspaceId: 'local', userId: 'usr_1', humanId: 'hum_1', role: 'owner', status: 'active' },
        {
          id: 'mem_hidden',
          workspaceId: 'local',
          userId: 'usr_hidden',
          humanId: 'hum_hidden',
          get user() {
            throw new Error('directory page should not project off-page members');
          },
        },
      ],
    }),
  }).publicDirectoryState({
    url: '/api/directory?directoryFormat=tuple-v1&limit=1',
    headers: {},
  });
  assert.deepEqual(leanDirectoryPage.agents.map((agent) => agent[0]), ['agt_visible']);
  assert.deepEqual(leanDirectoryPage.humans.map((human) => human[0]), ['hum_1']);
  assert.deepEqual(leanDirectoryPage.cloud.members.map((member) => member[0]), ['mem_1']);
  assert.equal(leanDirectoryPage.bootstrap.directory.agents.total, 2);
  assert.equal(leanDirectoryPage.bootstrap.directory.humans.total, 2);
  assert.equal(leanDirectoryPage.bootstrap.directory.members.total, 2);
  assert.equal(leanDirectoryPage.bootstrap.directory.page.nextCursor, '1:1:1');

  const secondPage = services.publicDirectoryState({
    url: '/api/directory?directoryFormat=tuple-v1&limit=1&cursor=1:1:1',
    headers: {},
  });
  assert.equal(secondPage.bootstrap.directory.scope, 'page');
  assert.equal(secondPage.bootstrap.directory.page.hasMore, false);
  assert.deepEqual(secondPage.agents.map((agent) => agent[0]), ['agt_hidden']);
  assert.deepEqual(secondPage.humans.map((human) => human[0]), ['hum_hidden']);
  assert.deepEqual(secondPage.cloud.members.map((member) => member[0]), ['mem_hidden']);

  const search = services.publicDirectorySearchState({
    url: '/api/directory/search?directoryFormat=tuple-v1&query=hidden&limit=1',
    headers: {},
  });
  assert.equal(search.bootstrap.mode, 'directory-search');
  assert.equal(search.bootstrap.directory.scope, 'search');
  assert.equal(search.bootstrap.directorySearch.query, 'hidden');
  assert.equal(search.bootstrap.directorySearch.limit, 1);
  assert.deepEqual(search.agents.map((agent) => agent[0]), ['agt_hidden']);
  assert.deepEqual(search.humans.map((human) => human[0]), ['hum_hidden']);
  assert.deepEqual(search.cloud.members.map((member) => member[0]), ['mem_hidden']);
  assert.equal(search.bootstrap.directory.agents.loaded, 1);
  assert.equal(search.bootstrap.directory.humans.loaded, 1);
  assert.equal(search.bootstrap.directory.members.loaded, 1);

  const leanSearch = makeServices((state) => {
    class ConversationRecords extends Array {
      static get [Symbol.species]() {
        return Array;
      }

      filter() {
        throw new Error('directory search should not filter conversation records');
      }
    }
    state.messages = ConversationRecords.from(state.messages);
    state.replies = ConversationRecords.from(state.replies);
    state.agents = [
      {
        id: 'agt_other',
        workspaceId: 'local',
        name: 'Other Agent',
        status: 'idle',
        get envVars() {
          throw new Error('directory search should not project non-matching agents');
        },
      },
      {
        id: 'agt_target',
        workspaceId: 'local',
        name: 'Target Agent',
        status: 'idle',
        envVars: { SAFE: '1' },
      },
    ];
  }).publicDirectorySearchState({
    url: '/api/directory/search?directoryFormat=tuple-v1&query=target&limit=1&types=agents',
    headers: {},
  });
  assert.deepEqual(leanSearch.agents.map((agent) => agent[0]), ['agt_target']);
  assert.equal(leanSearch.bootstrap.directory.agents.total, 1);

  const membersPage = services.publicMembersDirectoryState({
    url: '/api/members/directory?page=2&pageSize=1',
    headers: {},
  });
  assert.equal(membersPage.mode, 'members-directory');
  assert.equal(membersPage.page, 2);
  assert.equal(membersPage.pageSize, 1);
  assert.equal(membersPage.total, 3);
  assert.equal(membersPage.totalPages, 3);
  assert.equal(membersPage.rows.length, 1);
  assert.equal(membersPage.rows[0].member.id, 'mem_hidden');
  assert.equal(membersPage.rows[0].member.human.name, 'Hidden Human');

  const memberSearch = services.publicMembersDirectoryState({
    url: '/api/members/directory?q=pending&pageSize=10',
    headers: {},
  });
  assert.equal(memberSearch.query, 'pending');
  assert.equal(memberSearch.total, 1);
  assert.equal(memberSearch.rows[0].type, 'invitation');
  assert.equal(memberSearch.rows[0].invitation.id, 'inv_pending');
});

test('members directory compacts only visible page rows', () => {
  const firstAt = '2026-05-18T00:00:00.000Z';
  const secondAt = '2026-05-19T00:00:00.000Z';
  const page = makeServices((state) => {
    state.humans = [
      { id: 'hum_1', workspaceId: 'local', name: 'Visible Human', email: 'visible@example.test', createdAt: firstAt },
      {
        id: 'hum_hidden',
        workspaceId: 'local',
        name: 'Hidden Human',
        email: 'hidden@example.test',
        createdAt: secondAt,
        get lastSeenAt() {
          throw new Error('members directory should not compact off-page humans');
        },
      },
    ];
  }, {
    publicCloudState: () => ({
      auth: {
        currentUser: { id: 'usr_1' },
        currentMember: { id: 'mem_1', workspaceId: 'local', humanId: 'hum_1', role: 'owner' },
        storageBackend: 'postgres',
      },
      workspace: { id: 'local', slug: 'local' },
      members: [
        {
          id: 'mem_1',
          workspaceId: 'local',
          userId: 'usr_1',
          humanId: 'hum_1',
          role: 'owner',
          status: 'active',
          createdAt: firstAt,
        },
        {
          id: 'mem_hidden',
          workspaceId: 'local',
          userId: 'usr_hidden',
          humanId: 'hum_hidden',
          status: 'active',
          createdAt: secondAt,
          get role() {
            throw new Error('members directory should not compact off-page members');
          },
        },
      ],
    }),
  }).publicMembersDirectoryState({
    url: '/api/members/directory?page=1&pageSize=1',
    headers: {},
  });

  assert.equal(page.mode, 'members-directory');
  assert.equal(page.page, 1);
  assert.equal(page.pageSize, 1);
  assert.equal(page.total, 2);
  assert.equal(page.totalPages, 2);
  assert.equal(page.hasMore, true);
  assert.equal(page.rows.length, 1);
  assert.equal(page.rows[0].member.id, 'mem_1');
  assert.equal(page.rows[0].member.human.name, 'Visible Human');
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

test('package version polling refreshes NPM every 10 minutes without broadcasting updates', async () => {
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
  assert.deepEqual(broadcasts, []);
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

test('bootstrap state omits large internal server indexes from public payloads', () => {
  const services = makeServices((state) => {
    state.teamSharing = {
      sessions: { sess_big: { title: 'Large internal session' } },
      events: { sess_big: [{ eventId: 'evt_big', cleanText: 'internal raw transcript' }] },
      vectorDocuments: [{ id: 'vec_big', text: 'internal vector text'.repeat(1000) }],
    };
    state.agentRuntimeSessions = Array.from({ length: 20 }, (_, index) => ({
      id: `runtime_${index}`,
      rawLog: 'internal runtime log'.repeat(500),
    }));
    state.conversationGrants = [{ tokenHash: 'internal-token-hash' }];
    state.packageVersions = { '@magclaw/daemon': { latest: '9.9.9' } };
  });

  const snapshot = services.publicBootstrapState({
    url: '/api/bootstrap?spaceType=channel&spaceId=chan_all',
    headers: {},
  });

  assert.equal(snapshot.teamSharing, undefined);
  assert.equal(snapshot.agentRuntimeSessions, undefined);
  assert.equal(snapshot.conversationGrants, undefined);
  assert.equal(snapshot.packageVersions, undefined);
  assert.equal(snapshot.messages.some((message) => message.id === 'msg_channel'), true);
});

test('bootstrap state projects record metadata to frontend display fields only', () => {
  const services = makeServices((state) => {
    state.messages.push({
      id: 'msg_feishu_public',
      workspaceId: 'local',
      spaceType: 'channel',
      spaceId: 'chan_all',
      authorType: 'system',
      authorId: 'system',
      body: 'Imported from Feishu\n\nContext:\n- 张三: 需要跟进',
      metadata: {
        systemKind: 'external_import',
        origin: {
          provider: 'feishu',
          traceId: 'trace_public',
          chatId: 'oc_chat',
          chatName: '产品群',
          chatType: 'group',
          senderName: '张三',
          senderAvatar: 'avatar.png',
          senderOpenId: 'ou_public',
          internalRawPayload: 'x'.repeat(5000),
        },
        externalImport: {
          provider: 'feishu',
          syncEnabled: true,
          rawRequest: 'x'.repeat(5000),
        },
        feishu: {
          attachmentCount: 2,
          internalEvent: 'x'.repeat(5000),
          contextRecords: [{
            id: 'ctx_1',
            senderName: '李四',
            text: '上下文消息',
            createdAt: '2026-05-18T00:02:00.000Z',
            rawEvent: 'x'.repeat(5000),
          }],
        },
      },
      createdAt: '2026-05-18T00:02:00.000Z',
      updatedAt: '2026-05-18T00:02:00.000Z',
    });
    state.replies.push({
      id: 'rep_team_public',
      workspaceId: 'local',
      parentMessageId: 'msg_channel',
      spaceType: 'channel',
      spaceId: 'chan_all',
      authorType: 'agent',
      authorId: 'team_sharing_codex',
      body: 'Team Sharing display body',
      metadata: {
        systemKind: 'team_sharing_event',
        teamSharing: {
          runtime: 'codex',
          sessionId: 'sess_public',
          eventId: 'evt_internal',
          sourceAnchor: 'raw/source#123',
          ordinal: 99,
          uploader: {
            id: 'hum_1',
            name: 'Owner',
            email: 'owner@example.com',
            avatar: 'owner.png',
            privateToken: 'secret',
          },
          presentation: {
            mode: 'plan',
            interaction: { questions: [{ question: 'internal' }] },
          },
          contentSegments: [
            { type: 'body', text: 'Team Sharing display body' },
            { type: 'quote', label: '选取片段', text: '保留引用段' },
          ],
        },
      },
      createdAt: '2026-05-18T00:03:00.000Z',
      updatedAt: '2026-05-18T00:03:00.000Z',
    });
    state.tasks.push({
      id: 'task_internal_metadata',
      workspaceId: 'local',
      spaceType: 'channel',
      spaceId: 'chan_all',
      title: 'Task with internal startup metadata',
      status: 'todo',
      metadata: {
        systemKind: 'external_import',
        startupCollaboration: {
          status: 'running',
          deliveries: [{ agentId: 'agt_a', raw: 'x'.repeat(5000) }],
          fallbackReason: { raw: 'x'.repeat(5000) },
        },
        origin: { provider: 'feishu', raw: 'x'.repeat(5000) },
      },
      createdAt: '2026-05-18T00:04:00.000Z',
      updatedAt: '2026-05-18T00:04:00.000Z',
    });
    state.agents = [
      {
        id: 'agt_public',
        workspaceId: 'local',
        name: 'Public Agent',
        description: 'Shown in members',
        avatar: 'agent.png',
        runtime: 'codex',
        runtimeId: 'codex',
        model: 'gpt-test',
        reasoningEffort: 'medium',
        computerId: 'cmp_local',
        status: 'working',
        statusUpdatedAt: '2026-05-18T00:04:30.000Z',
        activeWorkItemIds: ['wi_1'],
        envVars: [{ key: 'PUBLIC_MODE', value: 'on' }],
        createdAt: '2026-05-18T00:04:00.000Z',
        updatedAt: '2026-05-18T00:04:30.000Z',
        metadata: {
          promptCache: 'x'.repeat(5000),
          runtimeSession: { raw: 'x'.repeat(5000) },
        },
      },
    ];
  });

  const snapshot = services.publicBootstrapState({
    url: '/api/bootstrap?spaceType=channel&spaceId=chan_all&messageLimit=80&threadRootLimit=160',
    headers: {},
  });
  const message = snapshot.messages.find((item) => item.id === 'msg_feishu_public');
  const reply = snapshot.replies.find((item) => item.id === 'rep_team_public');
  const task = snapshot.tasks.find((item) => item.id === 'task_internal_metadata');
  const agent = snapshot.agents.find((item) => item.id === 'agt_public');

  assert.equal(message.metadata.systemKind, 'external_import');
  assert.equal(message.metadata.origin.senderName, '张三');
  assert.equal(message.metadata.origin.internalRawPayload, undefined);
  assert.equal(message.metadata.externalImport, undefined);
  assert.equal(message.metadata.feishu.attachmentCount, 2);
  assert.equal(message.metadata.feishu.contextRecords[0].text, '上下文消息');
  assert.equal(message.metadata.feishu.contextRecords[0].rawEvent, undefined);
  assert.equal(reply.body, 'Team Sharing display body');
  assert.equal(reply.metadata.teamSharing.sessionId, 'sess_public');
  assert.equal(reply.metadata.teamSharing.eventId, undefined);
  assert.equal(reply.metadata.teamSharing.sourceAnchor, undefined);
  assert.deepEqual(reply.metadata.teamSharing.presentation, { mode: 'plan' });
  assert.deepEqual(reply.metadata.teamSharing.contentSegments, [{ type: 'quote', label: '选取片段', text: '保留引用段' }]);
  assert.equal(reply.metadata.teamSharing.uploader.privateToken, undefined);
  assert.deepEqual(task.metadata, { systemKind: 'external_import' });
  assert.equal(agent.name, 'Public Agent');
  assert.equal(agent.model, 'gpt-test');
  assert.equal(agent.metadata, undefined);
});

test('bootstrap state compacts member directory churn fields without changing full public state', () => {
  const createdAt = '2026-05-18T00:04:00.000Z';
  const updatedAt = '2026-05-18T00:05:00.000Z';
  const services = makeServices((state) => {
    state.agents = [{
      id: 'agt_compact',
      workspaceId: 'local',
      name: 'Compact Agent',
      description: 'Still searchable',
      role: 'agent',
      status: 'working',
      previousStatus: 'working',
      runtime: 'codex',
      runtimeId: 'codex',
      model: 'gpt-test',
      reasoningEffort: 'medium',
      activeWorkItemIds: ['wi_1'],
      statusUpdatedAt: updatedAt,
      heartbeatAt: updatedAt,
      createdAt,
      updatedAt,
    }, {
      id: 'agt_idle',
      workspaceId: 'local',
      name: 'Idle Agent',
      status: 'idle',
      activeWorkItemIds: [],
      createdAt,
      updatedAt,
    }];
    state.humans = [{
      id: 'hum_1',
      workspaceId: 'local',
      name: 'Owner',
      email: 'owner@example.test',
      avatarUrl: 'https://avatar.example.test/owner.png',
      role: 'owner',
      status: 'online',
      lastSeenAt: updatedAt,
      presenceUpdatedAt: updatedAt,
      createdAt,
      updatedAt,
    }, {
      id: 'hum_2',
      workspaceId: 'local',
      name: 'Member',
      email: 'member@example.test',
      avatarUrl: 'https://avatar.example.test/member.png',
      role: 'member',
      status: 'offline',
      createdAt,
      updatedAt,
    }];
    Object.assign(state.channels[0], {
      locked: true,
      defaultChannel: true,
      memberIds: ['hum_1', 'agt_compact', 'agt_idle'],
      humanIds: ['hum_1'],
      agentIds: ['agt_compact', 'agt_idle'],
    });
    state.messages.push({
      id: 'msg_redundant_update',
      workspaceId: 'local',
      spaceType: 'channel',
      spaceId: 'chan_all',
      body: 'same timestamp',
      createdAt,
      updatedAt: createdAt,
    }, {
      id: 'msg_edited',
      workspaceId: 'local',
      spaceType: 'channel',
      spaceId: 'chan_all',
      body: 'edited timestamp',
      createdAt,
      updatedAt,
    });
    state.replies.push({
      id: 'rep_redundant_update',
      workspaceId: 'local',
      parentMessageId: 'msg_channel',
      spaceType: 'channel',
      spaceId: 'chan_all',
      body: 'same reply timestamp',
      createdAt,
      updatedAt: createdAt,
    });
    state.tasks.push({
      id: 'task_compact',
      workspaceId: 'local',
      spaceType: 'channel',
      spaceId: 'chan_all',
      title: 'compact task',
      status: 'todo',
      assigneeIds: [],
      attachmentIds: [],
      mentionedAgentIds: [],
      mentionedHumanIds: [],
      history: [],
      createdAt,
      updatedAt: createdAt,
    });
  }, {
    publicCloudState: () => ({
      auth: {
        currentUser: { id: 'usr_1' },
        currentMember: { workspaceId: 'local', humanId: 'hum_1', role: 'admin' },
        storageBackend: 'postgres',
      },
      workspace: { id: 'local', slug: 'local' },
      members: [{
        id: 'mem_1',
        workspaceId: 'local',
        userId: 'usr_1',
        humanId: 'hum_1',
        role: 'owner',
        status: 'active',
        createdAt,
        updatedAt,
        user: { id: 'usr_1', email: 'owner@example.test', avatarUrl: 'https://avatar.example.test/owner.png' },
        human: {
          id: 'hum_1',
          workspaceId: 'local',
          name: 'Owner',
          email: 'owner@example.test',
          avatarUrl: 'https://avatar.example.test/owner.png',
          role: 'owner',
          status: 'online',
          lastSeenAt: updatedAt,
          presenceUpdatedAt: updatedAt,
          createdAt,
          updatedAt,
        },
      }, {
        id: 'mem_2',
        workspaceId: 'local',
        userId: 'usr_2',
        humanId: 'hum_2',
        role: 'member',
        status: 'active',
        createdAt,
        updatedAt,
        user: { id: 'usr_2', email: 'member@example.test', avatarUrl: 'https://avatar.example.test/member.png' },
      }, {
        id: 'mem_external',
        workspaceId: 'local',
        userId: 'usr_external',
        humanId: 'hum_external',
        role: 'member',
        status: 'active',
        createdAt,
        updatedAt,
        user: { id: 'usr_external', email: 'external@example.test', avatarUrl: 'https://avatar.example.test/external.png' },
        human: {
          id: 'hum_external',
          workspaceId: 'local',
          name: 'External',
          email: 'external@example.test',
          avatarUrl: 'https://avatar.example.test/external.png',
          role: 'member',
          status: 'offline',
          createdAt,
          updatedAt,
        },
      }],
    }),
  });

  const full = services.publicState();
  const bootstrap = services.publicBootstrapState({
    url: '/api/bootstrap?spaceType=channel&spaceId=chan_all',
    headers: {},
  });

  assert.equal(full.agents[0].workspaceId, 'local');
  assert.equal(full.agents[0].statusUpdatedAt, updatedAt);
  assert.deepEqual(full.agents[1].activeWorkItemIds, []);
  assert.equal(full.humans[0].lastSeenAt, updatedAt);
  assert.deepEqual(full.channels.find((channel) => channel.id === 'chan_all').memberIds, ['hum_1', 'agt_compact', 'agt_idle']);
  assert.equal(full.messages.find((message) => message.id === 'msg_redundant_update').workspaceId, 'local');
  assert.equal(full.messages.find((message) => message.id === 'msg_redundant_update').updatedAt, createdAt);
  assert.equal(full.tasks.find((task) => task.id === 'task_compact').workspaceId, 'local');
  assert.equal(full.tasks.find((task) => task.id === 'task_compact').updatedAt, createdAt);
  assert.deepEqual(full.tasks.find((task) => task.id === 'task_compact').assigneeIds, []);

  const bootstrapAllChannel = bootstrap.channels.find((channel) => channel.id === 'chan_all');
  assert.equal(bootstrapAllChannel.membershipMode, 'all');
  assert.equal(bootstrapAllChannel.memberCount, 3);
  assert.equal(bootstrapAllChannel.memberIds, undefined);
  assert.equal(bootstrapAllChannel.humanIds, undefined);
  assert.equal(bootstrapAllChannel.agentIds, undefined);
  assert.deepEqual(bootstrap.channels.find((channel) => channel.id === 'chan_member').memberIds, ['hum_1']);

  assert.equal(bootstrap.agents[0].workspaceId, undefined);
  assert.equal(bootstrap.agents[0].role, undefined);
  assert.equal(bootstrap.agents[0].statusUpdatedAt, undefined);
  assert.equal(bootstrap.agents[0].heartbeatAt, undefined);
  assert.equal(bootstrap.agents[0].updatedAt, undefined);
  assert.equal(bootstrap.agents[0].description, 'Still searchable');
  assert.equal(bootstrap.agents[0].runtime, 'codex');
  assert.equal(bootstrap.agents[0].runtimeId, undefined);
  assert.equal(bootstrap.agents[0].previousStatus, undefined);
  assert.equal(bootstrap.agents[0].model, 'gpt-test');
  assert.equal(bootstrap.agents[0].createdAt, createdAt);
  assert.deepEqual(bootstrap.agents[0].activeWorkItemIds, ['wi_1']);
  assert.equal(bootstrap.agents[1].activeWorkItemIds, undefined);

  assert.equal(bootstrap.humans[0].workspaceId, undefined);
  assert.equal(bootstrap.humans[0].lastSeenAt, undefined);
  assert.equal(bootstrap.humans[0].presenceUpdatedAt, undefined);
  assert.equal(bootstrap.humans[0].updatedAt, undefined);
  assert.equal(bootstrap.humans[0].role, 'owner');
  assert.equal(bootstrap.humans[0].createdAt, createdAt);
  assert.equal(bootstrap.cloud.members[0].human, undefined);
  assert.equal(bootstrap.cloud.members[0].humanId, 'hum_1');
  assert.equal(bootstrap.cloud.members[0].workspaceId, undefined);
  assert.equal(bootstrap.cloud.members[0].createdAt, undefined);
  assert.equal(bootstrap.cloud.members[0].updatedAt, undefined);
  assert.equal(bootstrap.cloud.members[0].status, undefined);
  assert.equal(bootstrap.cloud.members[0].role, 'owner');
  assert.equal(bootstrap.cloud.members[0].user, undefined);
  assert.equal(bootstrap.cloud.members[1].role, undefined);
  assert.equal(bootstrap.cloud.members[1].user, undefined);
  assert.equal(bootstrap.cloud.members[2].human, undefined);
  assert.deepEqual(bootstrap.cloud.members[2].user, {
    email: 'external@example.test',
    avatarUrl: 'https://avatar.example.test/external.png',
  });
  assert.equal(bootstrap.messages.find((message) => message.id === 'msg_redundant_update').workspaceId, undefined);
  assert.equal(bootstrap.messages.find((message) => message.id === 'msg_redundant_update').updatedAt, undefined);
  assert.equal(bootstrap.messages.find((message) => message.id === 'msg_edited').updatedAt, updatedAt);
  assert.equal(bootstrap.replies.find((reply) => reply.id === 'rep_redundant_update').workspaceId, undefined);
  assert.equal(bootstrap.replies.find((reply) => reply.id === 'rep_redundant_update').updatedAt, undefined);
  assert.equal(bootstrap.tasks.find((task) => task.id === 'task_compact').workspaceId, undefined);
  assert.equal(bootstrap.tasks.find((task) => task.id === 'task_compact').updatedAt, undefined);
  assert.equal(bootstrap.tasks.find((task) => task.id === 'task_compact').assigneeIds, undefined);
  assert.equal(bootstrap.tasks.find((task) => task.id === 'task_compact').attachmentIds, undefined);
  assert.equal(bootstrap.tasks.find((task) => task.id === 'task_compact').mentionedAgentIds, undefined);
  assert.equal(bootstrap.tasks.find((task) => task.id === 'task_compact').mentionedHumanIds, undefined);
  assert.equal(bootstrap.tasks.find((task) => task.id === 'task_compact').history, undefined);
});

test('public state for signed-in non-members keeps empty collection fields stable', () => {
  const services = makeServices(null, {
    publicCloudState: () => ({
      auth: {
        currentUser: { id: 'usr_pending' },
        currentMember: null,
        storageBackend: 'postgres',
      },
      workspace: { id: 'local', slug: 'local' },
    }),
  });

  const snapshot = services.publicState();

  for (const key of ['messages', 'replies', 'tasks', 'events', 'workItems', 'attachments', 'projects', 'runs']) {
    assert.deepEqual(snapshot[key], [], key);
  }
  assert.equal(snapshot.teamSharing, undefined);
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
