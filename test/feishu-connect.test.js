import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  buildChannelImportPath,
  ensureChannelFeishuRouteKey,
  parseChannelImportPath,
  validateChannelImportPath,
} from '../server/integrations/feishu-connect/route-token.js';
import { createFeishuInboundImporter } from '../server/integrations/feishu-connect/inbound.js';
import { createFeishuOutboundSync } from '../server/integrations/feishu-connect/outbound.js';
import { createFeishuConnectClient } from '../server/integrations/feishu-connect/client.js';
import { threadReplyPayload } from '../server/integrations/feishu-connect/cards.js';

function baseDeps(overrides = {}) {
  const state = {
    connection: { workspaceId: 'srv_1', name: 'Ops Server' },
    cloud: { workspace: { id: 'srv_1', name: 'Ops Server' } },
    channels: [
      {
        id: 'chan_1',
        name: 'ops',
        memberIds: ['hum_local'],
        humanIds: ['hum_local'],
        agentIds: ['agt_a', 'agt_b'],
        metadata: {},
      },
    ],
    agents: [
      { id: 'agt_a', name: 'Alice', status: 'online' },
      { id: 'agt_b', name: 'Bob', status: 'online' },
    ],
    humans: [{ id: 'hum_local', name: 'Local Human' }],
    messages: [],
    replies: [],
    tasks: [],
    attachments: [],
    workItems: [],
    events: [],
  };
  const events = [];
  const deliveredTasks = [];
  const memoryWrites = [];
  const deps = {
    addCollabEvent: (type, message, metadata) => events.push({ type, message, metadata }),
    addSystemEvent: (type, message, metadata) => events.push({ type, message, metadata }),
    addSystemReply: () => {},
    addTaskHistory: (task, type, message, actor = 'system', metadata = {}) => {
      task.history = [...(task.history || []), { type, message, actor, metadata }];
    },
    addTaskTimelineMessage: () => {},
    applyMentions: () => {},
    broadcastState: () => {},
    channelAgentIds: (channel) => channel?.agentIds || [],
    claimTask: (task, actorId) => {
      task.claimedBy = actorId;
      task.status = 'in_progress';
      return task;
    },
    createTaskFromMessage: (message, title, options = {}) => {
      const task = {
        id: `task_${state.tasks.length + 1}`,
        number: state.tasks.length + 1,
        title,
        body: message.body,
        workspaceId: message.workspaceId,
        status: 'todo',
        spaceType: message.spaceType,
        spaceId: message.spaceId,
        messageId: message.id,
        threadMessageId: message.id,
        sourceMessageId: message.id,
        assigneeIds: options.assigneeIds || [],
        attachmentIds: message.attachmentIds || [],
        createdBy: options.createdBy || message.authorId,
        metadata: options.metadata || {},
        history: [],
      };
      state.tasks.unshift(task);
      message.taskId = task.id;
      return task;
    },
    deliverMessageToAgent: async (agent, spaceType, spaceId, message, context = {}) => {
      deliveredTasks.push({ agent, spaceType, spaceId, message, context });
    },
    displayActor: (id) => id,
    extractMentions: () => ({ agents: [], humans: [] }),
    findAgent: (id) => state.agents.find((agent) => agent.id === id) || null,
    findChannel: (id) => state.channels.find((channel) => channel.id === id) || null,
    getState: () => state,
    makeId: (prefix) => `${prefix}_${state.messages.length + state.replies.length + state.attachments.length + 1}`,
    normalizeConversationRecord: (record) => ({
      replyCount: 0,
      readBy: [],
      savedBy: [],
      attachmentIds: [],
      mentionedAgentIds: [],
      mentionedHumanIds: [],
      metadata: {},
      ...record,
    }),
    normalizeIds: (ids) => [...new Set((ids || []).map(String).filter(Boolean))],
    now: () => '2026-05-29T08:00:00.000Z',
    persistState: async () => {},
    routeTaskAssignees: async ({ selectedAgentIds }) => ({
      ownerAgentId: selectedAgentIds[0],
      collaboratorAgentIds: selectedAgentIds,
      participantAgentIds: selectedAgentIds,
      strategy: 'test',
    }),
    scheduleAgentMemoryWriteback: async (agent, trigger, payload) => {
      memoryWrites.push({ agent, trigger, payload });
      return true;
    },
    startTaskStartupCollaboration: async (task, message, selectedAgentIds) => {
      task.metadata = task.metadata || {};
      task.metadata.startupCollaboration = {
        status: 'running',
        selectedAgentIds,
      };
      deliveredTasks.push({ task, message, selectedAgentIds });
      return { startup: task.metadata.startupCollaboration };
    },
    saveAttachmentBuffer: async ({ name, type, buffer, source, extra }) => ({
      id: `att_${state.attachments.length + 1}`,
      name,
      type,
      bytes: buffer.length,
      source,
      url: `/api/attachments/att_${state.attachments.length + 1}/${encodeURIComponent(name)}`,
      createdAt: '2026-05-29T08:00:00.000Z',
      ...extra,
    }),
  };
  return { ...deps, ...overrides, state, events, deliveredTasks, memoryWrites };
}

test('channel import path is signed with a stable route key and rejects tampering', () => {
  const deps = baseDeps();
  const channel = deps.state.channels[0];

  const routeKey = ensureChannelFeishuRouteKey(channel, { randomId: () => 'fixed-route-key' });
  const path = buildChannelImportPath({
    serverId: 'srv_1',
    channelId: 'chan_1',
    routeKey,
  });

  assert.equal(routeKey, 'fixed-route-key');
  assert.equal(parseChannelImportPath(path).channelId, 'chan_1');
  assert.equal(validateChannelImportPath(path, deps).channel.id, 'chan_1');
  assert.equal(validateChannelImportPath(path.replace('fixed-route-key', 'wrong'), deps).ok, false);
  assert.match(validateChannelImportPath('mc://magclaw/server/srv_1/channel/missing?key=x', deps).message, /未识别到该路径/);
});

test('Feishu inbound import creates an external system message, task, trace id, and attachment context', async () => {
  const deps = baseDeps();
  ensureChannelFeishuRouteKey(deps.state.channels[0], { randomId: () => 'fixed-route-key' });
  const sentMessages = [];
  const importer = createFeishuInboundImporter({
    ...deps,
    feishuClient: {
      async hydrateEvent(event) {
        return {
          text: event.text,
          sender: { id: 'ou_user_1', name: '张三' },
          chat: { id: 'oc_group_1', name: '产品群' },
          sourceMessageId: 'om_trigger',
          records: [
            { id: 'om_ctx_1', author: '李四', text: '第一条上下文', createdAt: '2026-05-29T07:59:00.000Z' },
            { id: 'om_ctx_2', author: '王五', text: '第二条上下文', createdAt: '2026-05-29T07:58:00.000Z' },
          ],
          attachments: [
            {
              name: 'screenshot.png',
              type: 'image/png',
              buffer: Buffer.from('image-bytes'),
              resourceId: 'img_1',
            },
          ],
        };
      },
      async replyToEvent(event, payload) {
        sentMessages.push({ event, payload });
        return { messageId: 'om_ack' };
      },
    },
    traceIdFactory: () => 'fsc_test_trace',
  });

  const result = await importer.handleMessageEvent({
    text: '请导入 mc://magclaw/server/srv_1/channel/chan_1?key=fixed-route-key',
  });

  assert.equal(result.ok, true);
  assert.equal(result.traceId, 'fsc_test_trace');
  assert.equal(deps.state.messages.length, 1);
  const message = deps.state.messages[0];
  assert.equal(message.authorType, 'system');
  assert.equal(message.metadata.systemKind, 'external_import');
  assert.equal(message.metadata.origin.provider, 'feishu');
  assert.equal(message.metadata.origin.senderName, '张三');
  assert.equal(message.metadata.origin.senderId, 'ou_user_1');
  assert.equal(message.metadata.origin.chatName, '产品群');
  assert.equal(message.metadata.origin.traceId, 'fsc_test_trace');
  assert.equal(message.metadata.externalImport.replyPolicy, 'thread_all');
  assert.equal(message.metadata.feishu.ackMessageId, 'om_ack');
  assert.equal(message.metadata.externalDelivery.feishu.feishuMessageId, 'om_ack');
  assert.doesNotMatch(message.body, /^Imported from Feishu$/m);
  assert.match(message.body, /Trace ID：fsc_test_trace/);
  assert.match(message.body, /Instruction:\n请导入/);
  assert.match(message.body, /Feishu identities:\n- 张三 \(trigger, user, open_id=ou_use\*\*\*\*r_1\)/);
  assert.doesNotMatch(message.body, /open_id=ou_user_1/);
  assert.match(message.body, /Context:\n- 李四: 第一条上下文/);
  assert.doesNotMatch(message.body, /来源：|触发人：|目标：/);
  assert.equal(message.attachmentIds.length, 1);
  assert.deepEqual(message.metadata.feishu.contextRecords.map((record) => ({
    id: record.id,
    author: record.author,
    text: record.text,
    authorId: record.authorId,
    openId: record.openId,
    senderType: record.senderType,
    createdAt: record.createdAt,
  })), [
    { id: 'om_ctx_1', author: '李四', text: '第一条上下文', authorId: '', openId: '', senderType: 'user', createdAt: '2026-05-29T07:59:00.000Z' },
    { id: 'om_ctx_2', author: '王五', text: '第二条上下文', authorId: '', openId: '', senderType: 'user', createdAt: '2026-05-29T07:58:00.000Z' },
  ]);
  assert.equal(deps.state.attachments[0].metadata.origin.provider, 'feishu');
  assert.equal(deps.state.tasks.length, 1);
  assert.equal(deps.state.tasks[0].threadMessageId, message.id);
  assert.equal(deps.state.tasks[0].sourceMessageId, message.id);
  assert.equal(deps.state.tasks[0].metadata.origin.traceId, 'fsc_test_trace');
  assert.deepEqual(deps.state.tasks[0].metadata.startupCollaboration.selectedAgentIds, ['agt_a', 'agt_b']);
  assert.ok(deps.deliveredTasks.length >= 1);
  assert.equal(deps.deliveredTasks[0].message.id, message.id);
  assert.deepEqual(deps.memoryWrites.map((item) => [item.agent.id, item.trigger]), [
    ['agt_a', 'external_import'],
    ['agt_b', 'external_import'],
  ]);
  assert.equal(deps.memoryWrites[0].payload.message.id, message.id);
  assert.equal(deps.memoryWrites[0].payload.task.id, deps.state.tasks[0].id);
  assert.equal(deps.memoryWrites[0].payload.externalImport.traceId, 'fsc_test_trace');
  assert.match(sentMessages[0].payload.content, /fsc_test_trace/);
});

test('Feishu client hydrates group avatar objects, mention names, and context timestamps', async () => {
  const fakeClient = {
    im: {
      v1: {
        message: {
          async get() {
            return { data: { items: [] } };
          },
        },
        chat: {
          async get() {
            return {
              data: {
                name: '产品讨论群',
                chat_mode: 'group',
                avatar: { avatar_72: 'https://example.test/group-72.png' },
              },
            };
          },
        },
        messageResource: {
          async get() {
            throw new Error('not used');
          },
        },
      },
    },
    contact: {
      v3: {
        user: {
          async basicBatch({ data }) {
            return {
              data: {
                users: data.user_ids.map((id) => ({
                  user_id: id,
                  name: id === 'ou_trigger' ? '张三' : '',
                })),
              },
            };
          },
          async batch({ params }) {
            return {
              data: {
                items: params.user_ids.map((id) => ({
                  open_id: id,
                  name: id === 'ou_trigger' ? '张三' : '',
                  avatar: { avatar_72: id === 'ou_trigger' ? 'https://example.test/ou_trigger.png' : '' },
                })),
              },
            };
          },
        },
      },
    },
  };
  const client = await createFeishuConnectClient(
    { appId: 'cli_test', appSecret: 'secret', tenant: 'feishu' },
    {
      client: fakeClient,
      larkSdk: {
        Client: function Client() { return fakeClient; },
        WSClient: function WSClient() {},
        EventDispatcher: function EventDispatcher() { return { register: () => ({}) }; },
        Domain: { Feishu: 'feishu' },
      },
    },
  );

  const hydrated = await client.hydrateEvent({
    message: {
      message_id: 'om_mention',
      msg_type: 'text',
      chat_id: 'oc_group',
      create_time: '1780000000123',
      content: JSON.stringify({
        text: '<at user_id="ou_bot">_user_1</at> 为啥今年这么热？',
        mentions: [
          { id: { open_id: 'ou_bot' }, name: '气象 Bot' },
        ],
      }),
    },
    sender: { sender_id: { open_id: 'ou_trigger', user_id: 'trigger_user' } },
  });

  assert.equal(hydrated.chat.avatar, 'https://example.test/group-72.png');
  assert.equal(hydrated.text, '@气象 Bot 为啥今年这么热？');
  assert.equal(hydrated.records[0].text, '@气象 Bot 为啥今年这么热？');
  assert.equal(hydrated.records[0].authorId, 'ou_trigger');
  assert.equal(hydrated.records[0].openId, 'ou_trigger');
  assert.equal(hydrated.records[0].senderType, 'user');
  assert.equal(hydrated.mentions[0].id, 'ou_bot');
  assert.equal(hydrated.mentions[0].name, '气象 Bot');
  assert.equal(hydrated.records[0].createdAt, new Date(1780000000123).toISOString());
  assert.equal(hydrated.mentionedBot, true);
});

test('Feishu client keeps user and bot identity records for imported context', async () => {
  const fakeClient = {
    im: {
      v1: {
        message: {
          async get({ path }) {
            assert.equal(path.message_id, 'om_forward');
            return {
              data: {
                items: [
                  {
                    message_id: 'om_human',
                    msg_type: 'text',
                    sender: { sender_type: 'user', sender_id: { open_id: 'ou_human', user_id: 'u_human' } },
                    body: { content: JSON.stringify({ text: '用户说要分析这张图' }) },
                  },
                  {
                    message_id: 'om_bot',
                    msg_type: 'text',
                    sender: { sender_type: 'app', sender_id: { app_id: 'cli_weather_bot' }, name: 'Weather Bot' },
                    body: { content: JSON.stringify({ text: 'Weather Bot 给了一个初步判断' }) },
                  },
                ],
              },
            };
          },
        },
        chat: {
          async get() {
            return { data: { name: '产品群', chat_mode: 'group' } };
          },
        },
        messageResource: {
          async get() {
            throw new Error('not used');
          },
        },
      },
    },
    contact: {
      v3: {
        user: {
          async basicBatch({ data }) {
            return { data: { users: data.user_ids.map((id) => ({ user_id: id, name: id === 'ou_trigger' ? '张三' : '李四' })) } };
          },
          async batch({ params }) {
            return { data: { items: params.user_ids.map((id) => ({ open_id: id, name: id === 'ou_trigger' ? '张三' : '李四' })) } };
          },
        },
      },
    },
  };
  const client = await createFeishuConnectClient(
    { appId: 'cli_test', appSecret: 'secret', tenant: 'feishu' },
    {
      client: fakeClient,
      larkSdk: {
        Client: function Client() { return fakeClient; },
        WSClient: function WSClient() {},
        EventDispatcher: function EventDispatcher() { return { register: () => ({}) }; },
        Domain: { Feishu: 'feishu' },
      },
    },
  );

  const hydrated = await client.hydrateEvent({
    message: {
      message_id: 'om_trigger',
      msg_type: 'text',
      parent_id: 'om_forward',
      chat_id: 'oc_group',
      content: JSON.stringify({ text: '导入 mc://magclaw/server/srv_1/channel/chan_1?key=k' }),
    },
    sender: { sender_type: 'user', sender_id: { open_id: 'ou_trigger', user_id: 'u_trigger' } },
  });

  const human = hydrated.records.find((record) => record.id === 'om_human');
  const bot = hydrated.records.find((record) => record.id === 'om_bot');
  assert.equal(hydrated.sender.name, '张三');
  assert.equal(human.author, '李四');
  assert.equal(human.authorId, 'ou_human');
  assert.equal(human.openId, 'ou_human');
  assert.equal(human.userId, 'u_human');
  assert.equal(human.senderType, 'user');
  assert.equal(bot.author, 'Weather Bot');
  assert.equal(bot.authorId, 'cli_weather_bot');
  assert.equal(bot.appId, 'cli_weather_bot');
  assert.equal(bot.senderType, 'bot');
  assert.equal(bot.isBot, true);
});

test('Feishu client masks unresolved sender ids for display while preserving raw ids', async () => {
  const fakeClient = {
    contact: {
      v3: {
        user: {
          async basicBatch() {
            throw new Error('missing contact scope');
          },
          async batch() {
            throw new Error('missing contact scope');
          },
        },
      },
    },
    im: {
      v1: {
        chat: {
          async get() {
            throw new Error('missing chat scope');
          },
        },
      },
    },
  };
  const client = await createFeishuConnectClient(
    { appId: 'cli_test', appSecret: 'secret', tenant: 'feishu' },
    {
      client: fakeClient,
      larkSdk: {
        Client: function Client() { return fakeClient; },
        WSClient: function WSClient() {},
        EventDispatcher: function EventDispatcher() { return { register: () => ({}) }; },
        Domain: { Feishu: 'feishu' },
      },
    },
  );

  const hydrated = await client.hydrateEvent({
    message: {
      message_id: 'om_raw_sender',
      msg_type: 'text',
      chat_id: 'oc_private_room_1234567890',
      chat_type: 'p2p',
      content: JSON.stringify({ text: '权限不足时也不要裸露完整 open id' }),
    },
    sender: {
      sender_type: 'user',
      sender_id: {
        open_id: 'ou_hidden_sender_1234567890',
        user_id: 'u_hidden_sender_1234567890',
      },
    },
  });

  assert.equal(hydrated.sender.openId, 'ou_hidden_sender_1234567890');
  assert.equal(hydrated.sender.userId, 'u_hidden_sender_1234567890');
  assert.equal(hydrated.sender.name, 'Feishu user u_hidd****7890');
  assert.equal(hydrated.records[0].openId, 'ou_hidden_sender_1234567890');
  assert.equal(hydrated.records[0].author, 'Feishu user u_hidd****7890');
  assert.doesNotMatch(hydrated.sender.name, /ou_hidden_sender_1234567890|u_hidden_sender_1234567890/);
  assert.doesNotMatch(hydrated.records[0].author, /ou_hidden_sender_1234567890|u_hidden_sender_1234567890/);
});

test('Feishu quoted replies without a path continue the existing MagClaw thread', async () => {
  const deps = baseDeps({
    routeThreadReplyForChannel: async () => ({
      targetAgentIds: ['agt_a'],
      mode: 'contextual_follow_up',
      confidence: 0.8,
    }),
    extractMentions: () => ({ agents: [], humans: [], special: [] }),
    findTaskForThreadMessage: (message) => deps.state.tasks.find((task) => task.threadMessageId === message.id) || null,
  });
  ensureChannelFeishuRouteKey(deps.state.channels[0], { randomId: () => 'fixed-route-key' });
  let ackIndex = 0;
  const sentMessages = [];
  const hydrationByText = new Map([
    ['初次导入 mc://magclaw/server/srv_1/channel/chan_1?key=fixed-route-key', {
      text: '初次导入 mc://magclaw/server/srv_1/channel/chan_1?key=fixed-route-key',
	      sender: { id: 'ou_user_1', name: '张三' },
	      chat: { id: 'oc_group_1', name: '产品群', type: 'group' },
	      mentionedBot: true,
	      sourceMessageId: 'om_first_user',
      records: [{ id: 'om_first_user', author: '张三', text: '初次导入 mc://magclaw/server/srv_1/channel/chan_1?key=fixed-route-key' }],
      attachments: [],
    }],
    ['继续追问', {
      text: '继续追问',
      sender: { id: 'ou_user_1', name: '张三' },
      chat: { id: 'oc_group_1', name: '产品群', type: 'group' },
      sourceMessageId: 'om_followup_user',
      parentMessageId: 'om_ack_1',
      rootMessageId: 'om_first_user',
      relatedMessageIds: ['om_followup_user', 'om_ack_1'],
      records: [
        { id: 'om_followup_user', author: '张三', text: '继续追问' },
        { id: 'om_ack_1', author: 'MagClaw Bot', text: '已导入 MagClaw' },
      ],
      attachments: [],
    }],
    ['再问一次', {
      text: '再问一次',
      sender: { id: 'ou_user_1', name: '张三' },
      chat: { id: 'oc_group_1', name: '产品群', type: 'group' },
      sourceMessageId: 'om_followup_user_2',
      parentMessageId: 'om_followup_user',
      rootMessageId: 'om_first_user',
      relatedMessageIds: ['om_followup_user_2', 'om_followup_user'],
      records: [
        { id: 'om_followup_user_2', author: '张三', text: '再问一次' },
        { id: 'om_followup_user', author: '张三', text: '继续追问' },
      ],
      attachments: [],
    }],
  ]);
  const importer = createFeishuInboundImporter({
    ...deps,
    feishuClient: {
      async hydrateEvent(event) {
        return hydrationByText.get(event.text);
      },
      async replyToEvent(event, payload) {
        ackIndex += 1;
        sentMessages.push({ event, payload });
        return { messageId: `om_ack_${ackIndex}` };
      },
    },
    traceIdFactory: () => 'fsc_thread_trace',
  });

  const first = await importer.handleMessageEvent({ text: '初次导入 mc://magclaw/server/srv_1/channel/chan_1?key=fixed-route-key' });
  const second = await importer.handleMessageEvent({ text: '继续追问' });
  const third = await importer.handleMessageEvent({ text: '再问一次' });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(second.continued, true);
  assert.equal(third.ok, true);
  assert.equal(third.continued, true);
  assert.equal(deps.state.messages.length, 1);
  assert.equal(deps.state.tasks.length, 1);
  assert.equal(deps.state.replies.length, 2);
  assert.equal(deps.state.replies[0].parentMessageId, first.message.id);
  assert.equal(deps.state.replies[0].metadata.origin.traceId, 'fsc_thread_trace');
  assert.equal(deps.state.replies[0].metadata.origin.parentMessageId, 'om_ack_1');
  assert.equal(deps.state.replies[0].metadata.externalDelivery.feishu.feishuMessageId, 'om_ack_2');
  assert.equal(deps.state.replies[1].parentMessageId, first.message.id);
  assert.equal(deps.state.replies[1].metadata.origin.parentMessageId, 'om_followup_user');
  assert.match(deps.state.replies[1].body, /Trace ID：fsc_thread_trace/);
  const deliveredContinuation = deps.deliveredTasks.find((item) => item.context?.parentMessageId === first.message.id);
  assert.ok(deliveredContinuation);
  assert.equal(deliveredContinuation.message.id, deps.state.replies[0].id);
  assert.match(sentMessages[1].payload.content, /已追加到 MagClaw Thread/);
});

test('Feishu message without a path and without a known reply chain is rejected', async () => {
  const deps = baseDeps();
  const sentMessages = [];
  const importer = createFeishuInboundImporter({
    ...deps,
    feishuClient: {
      async hydrateEvent(event) {
        return {
	          text: event.text,
	          sender: { id: 'ou_user_1', name: '张三' },
	          chat: { id: 'oc_group_1', name: '产品群', type: 'group' },
	          mentionedBot: true,
	          sourceMessageId: 'om_orphan',
          records: [{ id: 'om_orphan', author: '张三', text: event.text }],
          attachments: [],
        };
      },
      async replyToEvent(event, payload) {
        sentMessages.push(payload);
        return { messageId: 'om_error' };
      },
    },
  });

  const result = await importer.handleMessageEvent({ text: '没有路径也没有引用链' });

  assert.equal(result.ok, false);
  assert.match(sentMessages[0].content, /未识别到该路径/);
});

test('Feishu inbound import omits empty HTML instructions and unreadable reference noise', async () => {
  const deps = baseDeps();
  ensureChannelFeishuRouteKey(deps.state.channels[0], { randomId: () => 'fixed-route-key' });
  const importer = createFeishuInboundImporter({
    ...deps,
    feishuClient: {
      async hydrateEvent(event) {
        return {
          text: event.text,
	          sender: { id: 'ou_user_1', name: '张三' },
	          chat: { id: 'oc_group_1', name: '产品群', type: 'group' },
	          mentionedBot: true,
	          sourceMessageId: 'om_trigger',
          records: [
            { id: 'om_trigger', author: '张三', text: '<p>mc://magclaw/server/srv_1/channel/chan_1?key=fixed-route-key</p>' },
            { id: 'om_forward', author: '李四', text: '[无法读取飞书引用消息：om_forward]' },
          ],
          skippedReferenceIds: ['om_forward'],
          attachments: [],
        };
      },
      async replyToEvent() {
        return { messageId: 'om_ack' };
      },
    },
    traceIdFactory: () => 'fsc_test_trace',
  });

  const result = await importer.handleMessageEvent({
    text: '<p>mc://magclaw/server/srv_1/channel/chan_1?key=fixed-route-key</p>',
  });

  assert.equal(result.ok, true);
  assert.doesNotMatch(result.message.body, /Instruction:/);
  assert.doesNotMatch(result.message.body, /无法读取飞书引用消息/);
  assert.equal(result.message.metadata.feishu.skippedReferenceCount, 1);
  assert.match(result.task.title, /Feishu import fsc_test_trace/);
});

test('Feishu inbound startup delivery is anchored to the imported message thread', async () => {
  const deps = baseDeps({
    startTaskStartupCollaboration: undefined,
    taskAssignmentDeliveryMessage: (task, message) => ({
      id: `delivery_${task.id}`,
      body: message.body,
      taskId: task.id,
      attachmentIds: message.attachmentIds || [],
    }),
    taskStartupWaitMs: 1,
  });
  ensureChannelFeishuRouteKey(deps.state.channels[0], { randomId: () => 'fixed-route-key' });
  const importer = createFeishuInboundImporter({
    ...deps,
    feishuClient: {
      async hydrateEvent(event) {
        return {
          text: event.text,
	          sender: { id: 'ou_user_1', name: '张三' },
	          chat: { id: 'oc_group_1', name: '产品群', type: 'group' },
	          mentionedBot: true,
	          sourceMessageId: 'om_trigger',
          records: [{ author: '李四', text: '请处理这个上下文' }],
          attachments: [],
        };
      },
      async replyToEvent() {
        return { messageId: 'om_ack' };
      },
    },
    traceIdFactory: () => 'fsc_thread_trace',
  });

  const result = await importer.handleMessageEvent({
    text: '处理一下 mc://magclaw/server/srv_1/channel/chan_1?key=fixed-route-key',
  });

  assert.equal(result.ok, true);
  assert.equal(result.task.threadMessageId, result.message.id);
  assert.ok(deps.deliveredTasks.length >= 1);
  assert.equal(deps.deliveredTasks[0].context.parentMessageId, result.message.id);
});

test('Feishu inbound import replies with the invalid id when the channel path is wrong', async () => {
  const deps = baseDeps();
  const sentMessages = [];
  const importer = createFeishuInboundImporter({
    ...deps,
    feishuClient: {
      async hydrateEvent(event) {
        return { text: event.text, sender: { id: 'ou_user_1', name: '张三' }, chat: { id: 'oc_group_1', name: '产品群' }, records: [] };
      },
      async replyToEvent(event, payload) {
        sentMessages.push(payload);
        return { messageId: 'om_error' };
      },
    },
  });

  const result = await importer.handleMessageEvent({
    text: 'mc://magclaw/server/srv_1/channel/chan_1?key=wrong-key',
  });

  assert.equal(result.ok, false);
  assert.match(sentMessages[0].content, /未识别到该路径/);
  assert.match(sentMessages[0].content, /wrong-key/);
});

test('Feishu group messages without bot mention are silently ignored', async () => {
  const deps = baseDeps();
  ensureChannelFeishuRouteKey(deps.state.channels[0], { randomId: () => 'fixed-route-key' });
  const sentMessages = [];
  const importer = createFeishuInboundImporter({
    ...deps,
    feishuClient: {
      async hydrateEvent(event) {
        return {
          text: event.text,
          sender: { id: 'ou_user_1', name: '张三' },
          chat: { id: 'oc_group_1', name: '产品群', type: 'group' },
          mentionedBot: false,
          sourceMessageId: 'om_noise',
          records: [{ id: 'om_noise', author: '张三', text: event.text }],
          attachments: [],
        };
      },
      async replyToEvent(event, payload) {
        sentMessages.push(payload);
        return { messageId: 'om_should_not_send' };
      },
    },
  });

  const result = await importer.handleMessageEvent({
    text: '路过的群消息 mc://magclaw/server/srv_1/channel/chan_1?key=fixed-route-key',
  });

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'not_mentioned');
  assert.equal(deps.state.messages.length, 0);
  assert.equal(deps.state.tasks.length, 0);
  assert.equal(sentMessages.length, 0);
});

test('Feishu client hydrates replied merge-forward messages and downloads nested resources', async () => {
  const fetchedIds = [];
  const resourceRequests = [];
  const fakeClient = {
    im: {
      v1: {
        message: {
          async get({ path }) {
            fetchedIds.push(path.message_id);
            assert.equal(path.message_id, 'om_forward');
            return {
              data: {
                items: [
                  {
                    message_id: 'om_forward',
                    msg_type: 'merge_forward',
                    content: JSON.stringify({ message_id: 'om_child_1', content: 'Merged and Forwarded Message' }),
                  },
                  {
                    message_id: 'om_child_1',
                    msg_type: 'text',
                    sender: { sender_id: { user_id: 'u_1' } },
                    body: { content: JSON.stringify({ text: '第一条转发消息' }) },
                  },
                  {
                    message_id: 'om_child_2',
                    msg_type: 'post',
                    sender: { sender_id: { user_id: 'u_2' } },
                    body: { content: JSON.stringify({
                      content: [[
                        { tag: 'text', text: '富文本说明' },
                        { tag: 'img', image_key: 'img_nested' },
                      ]],
                    }) },
                  },
                ],
              },
            };
          },
        },
        chat: {
          async get({ path }) {
            assert.equal(path.chat_id, 'oc_group');
            return {
              data: {
                name: '产品讨论群',
                chat_mode: 'group',
                avatar: 'https://example.test/group.png',
              },
            };
          },
        },
        messageResource: {
          async get({ path, params }) {
            resourceRequests.push({ path, params });
            return { getReadableStream: () => Readable.from([Buffer.from('image-bytes')]) };
          },
        },
      },
    },
    contact: {
      v3: {
        user: {
          async basicBatch({ data, params }) {
            assert.equal(params.user_id_type, 'open_id');
            return {
              data: {
                users: data.user_ids.map((id) => ({
                  user_id: id,
                  name: id === 'ou_trigger' ? '张三' : `用户-${id.slice(-1)}`,
                })),
              },
            };
          },
          async batch({ params }) {
            return {
              data: {
                items: params.user_ids.map((id) => ({
                  open_id: id,
                  name: id === 'ou_trigger' ? '张三' : `用户-${id.slice(-1)}`,
                  avatar: { avatar_72: `https://example.test/${id}.png` },
                  mobile: '',
                })),
              },
            };
          },
        },
      },
    },
  };
  const client = await createFeishuConnectClient(
    { appId: 'cli_test', appSecret: 'secret', tenant: 'feishu' },
    {
      client: fakeClient,
      larkSdk: {
        Client: function Client() { return fakeClient; },
        WSClient: function WSClient() {},
        EventDispatcher: function EventDispatcher() { return { register: () => ({}) }; },
        Domain: { Feishu: 'feishu' },
      },
    },
  );

  const hydrated = await client.hydrateEvent({
    message: {
      message_id: 'om_reply',
      msg_type: 'text',
      parent_id: 'om_forward',
      chat_id: 'oc_group',
      content: JSON.stringify({ text: '导入 mc://magclaw/server/srv_1/channel/chan_1?key=k' }),
    },
    sender: { sender_id: { open_id: 'ou_trigger', user_id: 'trigger_user' } },
  });

  assert.deepEqual(fetchedIds, ['om_forward']);
  assert.equal(hydrated.sender.name, '张三');
  assert.equal(hydrated.sender.avatar, 'https://example.test/ou_trigger.png');
  assert.equal(hydrated.chat.name, '产品讨论群');
  assert.equal(hydrated.chat.avatar, 'https://example.test/group.png');
  assert.equal(hydrated.parentMessageId, 'om_forward');
  assert.equal(hydrated.rootMessageId, '');
  assert.deepEqual(hydrated.relatedMessageIds, ['om_reply', 'om_forward', 'om_child_1', 'om_child_2']);
  assert.match(hydrated.records.map((record) => record.text).join('\n'), /第一条转发消息/);
  assert.match(hydrated.records.map((record) => record.text).join('\n'), /富文本说明/);
  assert.equal(hydrated.attachments.length, 1);
  assert.equal(hydrated.attachments[0].buffer.toString(), 'image-bytes');
  assert.deepEqual(resourceRequests[0], {
    path: { message_id: 'om_child_2', file_key: 'img_nested' },
    params: { type: 'image' },
  });
});

test('Feishu client downloads image resources from replied message body content', async () => {
  const resourceRequests = [];
  const fakeClient = {
    im: {
      v1: {
        message: {
          async get({ path }) {
            if (path.message_id === 'om_reply') {
              return {
                data: {
                  items: [
                    {
                      message_id: 'om_reply',
                      msg_type: 'text',
                      parent_id: 'om_image',
                      root_id: 'om_image',
                      body: { content: JSON.stringify({ text: '能识别这个图吗 mc://magclaw/server/srv_1/channel/chan_1?key=k' }) },
                    },
                  ],
                },
              };
            }
            assert.equal(path.message_id, 'om_image');
            return {
              data: {
                items: [
                  {
                    message_id: 'om_image',
                    msg_type: 'image',
                    sender: { id: 'ou_image', id_type: 'open_id' },
                    body: { content: JSON.stringify({ image_key: 'img_parent' }) },
                  },
                ],
              },
            };
          },
        },
        chat: {
          async get() {
            return { data: { name: 'JHB', chat_mode: 'group' } };
          },
        },
        messageResource: {
          async get({ path, params }) {
            resourceRequests.push({ path, params });
            return { getReadableStream: () => Readable.from([Buffer.from('parent-image')]) };
          },
        },
      },
    },
    contact: { v3: { user: {} } },
  };
  const client = await createFeishuConnectClient(
    { appId: 'cli_test', appSecret: 'secret', tenant: 'feishu' },
    {
      client: fakeClient,
      larkSdk: {
        Client: function Client() { return fakeClient; },
        WSClient: function WSClient() {},
        EventDispatcher: function EventDispatcher() { return { register: () => ({}) }; },
        Domain: { Feishu: 'feishu' },
      },
    },
  );

  const hydrated = await client.hydrateEvent({
    message: {
      message_id: 'om_reply',
      msg_type: 'text',
      chat_id: 'oc_group',
      content: JSON.stringify({ text: '能识别这个图吗 mc://magclaw/server/srv_1/channel/chan_1?key=k' }),
    },
    sender: { sender_id: { open_id: 'ou_trigger' } },
  });

  assert.equal(hydrated.attachments.length, 1);
  assert.equal(hydrated.parentMessageId, 'om_image');
  assert.equal(hydrated.rootMessageId, 'om_image');
  assert.equal(hydrated.attachments[0].buffer.toString(), 'parent-image');
  assert.deepEqual(resourceRequests[0], {
    path: { message_id: 'om_image', file_key: 'img_parent' },
    params: { type: 'image' },
  });
});

test('Feishu client expands topic context and Feishu document links best-effort', async () => {
  const fakeClient = {
    im: {
      v1: {
        message: {
          async list() {
            return {
              data: {
                items: [
                  {
                    message_id: 'om_topic_root',
                    msg_type: 'text',
                    thread_id: 'om_topic_root',
                    sender: { sender_id: { open_id: 'ou_a' } },
                    body: { content: JSON.stringify({ text: '话题背景：需要整理投放方案' }) },
                  },
                  {
                    message_id: 'om_topic_doc',
                    msg_type: 'post',
                    root_id: 'om_topic_root',
                    thread_id: 'om_topic_root',
                    sender: { sender_id: { open_id: 'ou_b' } },
                    body: { content: JSON.stringify({
                      content: [[
                        { tag: 'text', text: '参考文档' },
                        { tag: 'a', text: '方案文档', href: 'https://example.feishu.cn/docx/DocToken123' },
                      ]],
                    }) },
                  },
                  {
                    message_id: 'om_topic_trigger',
                    msg_type: 'text',
                    root_id: 'om_topic_root',
                    thread_id: 'om_topic_root',
                    sender: { sender_id: { open_id: 'ou_trigger' } },
                    body: { content: JSON.stringify({
                      text: '<at user_id="ou_bot">_user_1</at> 导入 mc://magclaw/server/srv_1/channel/chan_1?key=k',
                      mentions: [{ id: { open_id: 'ou_bot' }, name: 'monkey' }],
                    }) },
                  },
                ],
              },
            };
          },
        },
        chat: {
          async get() {
            return { data: { name: '增长话题群', chat_mode: 'topic' } };
          },
        },
        messageResource: {
          async get() {
            throw new Error('not used');
          },
        },
      },
    },
    contact: { v3: { user: {} } },
    docx: {
      v1: {
        document: {
          rawContent: {
            async get({ path }) {
              assert.equal(path.document_id, 'DocToken123');
              return { data: { content: '文档正文：预算 10w，目标 CTR 3%。' } };
            },
          },
        },
      },
    },
  };
  const client = await createFeishuConnectClient(
    { appId: 'cli_test', appSecret: 'secret', tenant: 'feishu' },
    {
      client: fakeClient,
      larkSdk: {
        Client: function Client() { return fakeClient; },
        WSClient: function WSClient() {},
        EventDispatcher: function EventDispatcher() { return { register: () => ({}) }; },
        Domain: { Feishu: 'feishu' },
      },
    },
  );

  const hydrated = await client.hydrateEvent({
    message: {
      message_id: 'om_topic_trigger',
      msg_type: 'text',
      chat_id: 'oc_topic_group',
      chat_type: 'group',
      root_id: 'om_topic_root',
      thread_id: 'om_topic_root',
      content: JSON.stringify({
        text: '<at user_id="ou_bot">_user_1</at> 导入 mc://magclaw/server/srv_1/channel/chan_1?key=k',
        mentions: [{ id: { open_id: 'ou_bot' }, name: 'monkey' }],
      }),
    },
    sender: { sender_id: { open_id: 'ou_trigger' } },
  });

  const joined = hydrated.records.map((record) => record.text).join('\n');
  assert.equal(hydrated.chat.type, 'topic');
  assert.equal(hydrated.threadId, 'om_topic_root');
  assert.equal(hydrated.mentionedBot, true);
  assert.deepEqual(hydrated.relatedMessageIds, ['om_topic_root', 'om_topic_doc', 'om_topic_trigger']);
  assert.match(joined, /话题背景：需要整理投放方案/);
  assert.match(joined, /方案文档 \(https:\/\/example\.feishu\.cn\/docx\/DocToken123\)/);
  assert.match(joined, /文档正文：预算 10w/);
});

test('Feishu outbound sync sends thread replies once and marks delivery metadata', async () => {
  const deps = baseDeps();
  deps.state.messages.push({
    id: 'msg_import',
    workspaceId: 'srv_1',
    spaceType: 'channel',
    spaceId: 'chan_1',
    authorType: 'system',
    authorId: 'system',
    body: 'Imported from Feishu',
    metadata: {
      systemKind: 'external_import',
      origin: {
        provider: 'feishu',
        traceId: 'fsc_test_trace',
        chatId: 'oc_group_1',
        triggerMessageId: 'om_trigger',
        chatType: 'topic',
        threadId: 'om_topic_root',
      },
      externalImport: {
        provider: 'feishu',
        syncEnabled: true,
        replyPolicy: 'thread_all',
      },
    },
  });
  const reply = {
    id: 'rep_1',
    parentMessageId: 'msg_import',
    spaceType: 'channel',
    spaceId: 'chan_1',
    authorType: 'agent',
    authorId: 'agt_a',
    body: 'Agent result',
    metadata: {},
  };
  deps.state.replies.push(reply);
  const sent = [];
  const sync = createFeishuOutboundSync({
    ...deps,
    feishuClient: {
      async sendThreadReply(payload) {
        sent.push(payload);
        return { messageId: 'om_sent' };
      },
    },
  });

  await sync.syncReply(reply);
  await sync.syncReply(reply);

  assert.equal(sent.length, 1);
  assert.equal(sent[0].traceId, 'fsc_test_trace');
  assert.equal(sent[0].msgType, 'interactive');
  assert.equal(sent[0].replyInThread, true);
  const card = JSON.parse(sent[0].content);
  assert.equal(card.schema, '2.0');
  assert.equal(card.header.title.content, 'Agent Alice replied');
  assert.equal(card.body.elements[0].tag, 'markdown');
  assert.match(card.body.elements[0].content, /Agent result/);
  assert.equal(reply.metadata.externalDelivery.feishu.status, 'sent');
  assert.equal(reply.metadata.externalDelivery.feishu.feishuMessageId, 'om_sent');
});

test('Feishu thread reply payload renders markdown as an interactive card with fallback text', () => {
  const payload = threadReplyPayload({
    traceId: 'fsc_card_trace',
    actorName: 'Alice',
    actorType: 'agent',
    body: '## Result\n\n- item one\n- item two',
  });
  const card = JSON.parse(payload.content);
  assert.equal(payload.msg_type, 'interactive');
  assert.match(payload.fallbackText, /fsc_card_trace/);
  assert.equal(card.header.title.content, 'Agent Alice replied');
  assert.match(card.body.elements[0].content, /## Result/);
});
