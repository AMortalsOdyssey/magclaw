import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildAgentContextPack,
  renderAgentContextPack,
} from '../server/agent-context.js';

test('agent context pack includes recent channel messages, current message, tasks, attachments, and thread context', () => {
  const state = {
    humans: [{ id: 'hum_local', name: 'You', role: 'owner' }],
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
  assert.match(rendered, /Participants: @You, @333 \(you\), @CCC/);
  assert.match(rendered, /\[msg=msg_1 .* @You: @CCC 你叫什么/);
  assert.match(rendered, /\[msg=msg_2 .* @CCC: 我叫 CCC。/);
  assert.match(rendered, /Current message/);
  assert.match(rendered, /@333 我刚才问 CCC 什么问题/);
  assert.match(rendered, /Thread context/);
  assert.match(rendered, /task #7 \[in_progress\] 做一下任务/);
  assert.match(rendered, /note\.png image\/png 1234 bytes/);
  assert.doesNotMatch(rendered, /agt_333|agt_ccc|hum_local/);
});
