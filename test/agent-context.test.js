import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAgentContextPack,
  renderAgentContextPack,
} from '../server/agent-context.js';

test('agent context pack includes recent channel messages, current message, tasks, attachments, and thread context', () => {
  const state = {
    humans: [{ id: 'hum_local', name: 'You', role: 'admin' }],
    agents: [
      { id: 'agt_333', name: '333', description: 'solver', status: 'idle' },
      { id: 'agt_ccc', name: 'CCC', description: 'reviewer', status: 'idle' },
    ],
    channels: [{
      id: 'chan_all',
      name: 'all',
      description: 'General channel',
      humanIds: ['hum_local'],
      agentIds: ['agt_333', 'agt_ccc'],
      memberIds: ['hum_local', 'agt_333', 'agt_ccc'],
    }],
    dms: [],
    messages: [
      {
        id: 'msg_1',
        spaceType: 'channel',
        spaceId: 'chan_all',
        authorType: 'human',
        authorId: 'hum_local',
        body: '<@agt_ccc> 你叫什么',
        attachmentIds: [],
        createdAt: '2026-04-27T10:00:00.000Z',
      },
      {
        id: 'msg_2',
        spaceType: 'channel',
        spaceId: 'chan_all',
        authorType: 'agent',
        authorId: 'agt_ccc',
        body: '我叫 CCC。',
        attachmentIds: ['att_1'],
        createdAt: '2026-04-27T10:01:00.000Z',
      },
      {
        id: 'msg_parent',
        spaceType: 'channel',
        spaceId: 'chan_all',
        authorType: 'human',
        authorId: 'hum_local',
        body: '<@agt_333> 做一下任务',
        attachmentIds: [],
        taskId: 'task_1',
        createdAt: '2026-04-27T10:02:00.000Z',
      },
      {
        id: 'msg_current',
        spaceType: 'channel',
        spaceId: 'chan_all',
        authorType: 'human',
        authorId: 'hum_local',
        body: '<@agt_333> 我刚才问 CCC 什么问题',
        attachmentIds: [],
        createdAt: '2026-04-27T10:03:00.000Z',
      },
    ],
    replies: [
      {
        id: 'rep_1',
        parentMessageId: 'msg_parent',
        spaceType: 'channel',
        spaceId: 'chan_all',
        authorType: 'agent',
        authorId: 'agt_333',
        body: '我开始处理。',
        attachmentIds: [],
        createdAt: '2026-04-27T10:02:30.000Z',
      },
    ],
    tasks: [{
      id: 'task_1',
      number: 7,
      title: '做一下任务',
      body: 'thread task',
      status: 'in_progress',
      spaceType: 'channel',
      spaceId: 'chan_all',
      assigneeIds: ['agt_333'],
      sourceMessageId: 'msg_parent',
      threadMessageId: 'msg_parent',
    }],
    attachments: [{
      id: 'att_1',
      name: 'note.png',
      type: 'image/png',
      bytes: 1234,
      path: '/tmp/note.png',
    }],
  };

  const pack = buildAgentContextPack({
    state,
    agentId: 'agt_333',
    spaceType: 'channel',
    spaceId: 'chan_all',
    currentMessage: state.messages.at(-1),
    parentMessageId: 'msg_parent',
    limits: { recentMessages: 10, threadReplies: 10, tasks: 10, attachments: 10 },
  });

  assert.equal(pack.space.name, 'all');
  assert.deepEqual(pack.participants.map((item) => item.name), ['You', '333', 'CCC']);
  assert.equal(pack.currentMessage.id, 'msg_current');
  assert.ok(pack.recentMessages.some((item) => item.id === 'msg_1'));
  assert.ok(pack.recentMessages.some((item) => item.id === 'msg_2'));
  assert.equal(pack.thread.parentMessage.id, 'msg_parent');
  assert.equal(pack.thread.recentReplies[0].id, 'rep_1');
  assert.equal(pack.tasks[0].number, 7);
  assert.equal(pack.attachments[0].id, 'att_1');

  const rendered = renderAgentContextPack(pack, { targetAgentId: 'agt_333' });
  assert.match(rendered, /Context snapshot for #all/);
  assert.match(rendered, /Participants: @You - admin, @333 \(you\) - solver, @CCC - reviewer/);
  assert.match(rendered, /\[msg=msg_1 .* @You: @CCC 你叫什么/);
  assert.match(rendered, /\[msg=msg_2 .* @CCC: 我叫 CCC。/);
  assert.match(rendered, /Current message/);
  assert.match(rendered, /@333 我刚才问 CCC 什么问题/);
  assert.match(rendered, /Thread context/);
  assert.match(rendered, /task #7 \[in_progress\] 做一下任务/);
  assert.match(rendered, /note\.png image\/png 1234 bytes/);
  assert.doesNotMatch(rendered, /agt_333|agt_ccc|hum_local/);
});

test('agent context pack renders required peer memory search grounding', () => {
  const state = {
    humans: [{ id: 'hum_local', name: 'You', role: 'admin' }],
    agents: [
      { id: 'agt_han', name: '韩立', description: 'protector', status: 'idle' },
      { id: 'agt_wan', name: '南宫婉', description: 'planner', status: 'idle' },
    ],
    channels: [{
      id: 'chan_trip',
      name: 'trip',
      humanIds: ['hum_local'],
      agentIds: ['agt_han', 'agt_wan'],
      memberIds: ['hum_local', 'agt_han', 'agt_wan'],
    }],
    dms: [],
    messages: [{
      id: 'msg_current',
      spaceType: 'channel',
      spaceId: 'chan_trip',
      authorType: 'human',
      authorId: 'hum_local',
      body: '旅游相关的问题找谁比较擅长？',
      attachmentIds: [],
      createdAt: '2026-05-03T12:48:00.000Z',
    }],
    replies: [],
    tasks: [],
    attachments: [],
  };

  const pack = buildAgentContextPack({
    state,
    agentId: 'agt_wan',
    spaceType: 'channel',
    spaceId: 'chan_trip',
    currentMessage: state.messages[0],
    toolBaseUrl: 'http://127.0.0.1:6543',
    peerMemorySearch: {
      required: true,
      query: '旅游相关的问题找谁比较擅长？',
      reason: 'agent discovery',
      results: [{
        agentId: 'agt_han',
        agentName: '韩立',
        path: 'MEMORY.md',
        line: 14,
        matchedTerms: ['旅游'],
        preview: '解决旅游、出行路线和避开人潮的问题。',
      }],
    },
  });

  const rendered = renderAgentContextPack(pack, { targetAgentId: 'agt_wan' });
  assert.match(rendered, /Peer memory search:/);
  assert.match(rendered, /Required for this turn: yes/);
  assert.match(rendered, /@韩立 \(agt_han\) MEMORY\.md:14; matched=旅游: 解决旅游/);
  assert.match(rendered, /For agent capability or suitability questions, use the peer memory search results above first/);
});

test('workspace all context expands cloud workspace humans and agents', () => {
  const state = {
    connection: { workspaceId: 'wsp_test22222' },
    cloud: {
      users: [
        { id: 'usr_jjjj', name: 'JJJJ', email: 'jjjj@example.test' },
      ],
      workspaceMembers: [
        { id: 'wmem_jjjj', workspaceId: 'wsp_test22222', userId: 'usr_jjjj', humanId: 'hum_jjjj', role: 'owner', status: 'active' },
      ],
    },
    humans: [
      { id: 'hum_bobo', workspaceId: 'wsp_test22222', name: 'bobo126126', role: 'admin', status: 'online' },
    ],
    agents: [
      { id: 'agt_smile', workspaceId: 'wsp_test22222', name: '😊', description: 'general helper', status: 'idle' },
      { id: 'agt_el', workspaceId: 'wsp_test22222', name: 'EL', description: 'engineering lead', status: 'idle' },
      { id: 'agt_other', workspaceId: 'wsp_other', name: 'Other', description: 'outside', status: 'idle' },
    ],
    channels: [{
      id: 'chan_f1b4e205ff',
      workspaceId: 'wsp_test22222',
      name: 'all',
      description: 'Default server-wide channel.',
      locked: true,
      defaultChannel: true,
      humanIds: ['hum_bobo'],
      agentIds: ['agt_smile'],
      memberIds: ['hum_bobo', 'agt_smile'],
    }],
    dms: [],
    messages: [{
      id: 'msg_current',
      workspaceId: 'wsp_test22222',
      spaceType: 'channel',
      spaceId: 'chan_f1b4e205ff',
      authorType: 'human',
      authorId: 'hum_bobo',
      body: 'EL，你知道我们这个 channel 里还有谁在吗？',
      attachmentIds: [],
      createdAt: '2026-05-14T02:31:21.000Z',
    }],
    replies: [],
    tasks: [],
    attachments: [],
  };

  const pack = buildAgentContextPack({
    state,
    agentId: 'agt_el',
    spaceType: 'channel',
    spaceId: 'chan_f1b4e205ff',
    currentMessage: state.messages[0],
  });

  assert.deepEqual(
    pack.participants.map((item) => [item.name, item.type]),
    [['bobo126126', 'human'], ['JJJJ', 'human'], ['😊', 'agent'], ['EL', 'agent']],
  );
  assert.equal(pack.space.visibility, 'public');
  assert.equal(pack.space.defaultChannel, true);

  const rendered = renderAgentContextPack(pack, { targetAgentId: 'agt_el' });
  assert.match(rendered, /Space: Channel \(public, default workspace channel\)/);
  assert.match(rendered, /Participants: @bobo126126 - admin, @JJJJ - owner, @😊 - general helper, @EL \(you\) - engineering lead/);
  assert.doesNotMatch(rendered, /@Other/);
});
