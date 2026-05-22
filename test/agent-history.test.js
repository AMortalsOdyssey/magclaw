import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatAgentHistory,
  readAgentHistory,
  searchAgentMessageHistory,
} from '../server/agent-history.js';

test('agent history tools read channel, read thread, and search visible messages with task hints', () => {
  const state = {
    humans: [{ id: 'hum_local', name: 'You', role: 'admin' }],
    agents: [{ id: 'agt_333', name: '333', description: 'solver' }],
    channels: [{
      id: 'chan_all',
      name: 'all',
      description: 'General',
      humanIds: ['hum_local'],
      agentIds: ['agt_333'],
      memberIds: ['hum_local', 'agt_333'],
    }],
    dms: [],
    messages: [
      {
        id: 'msg_old',
        spaceType: 'channel',
        spaceId: 'chan_all',
        authorType: 'human',
        authorId: 'hum_local',
        body: 'old channel context',
        attachmentIds: [],
        createdAt: '2026-04-27T09:00:00.000Z',
      },
      {
        id: 'msg_parent',
        spaceType: 'channel',
        spaceId: 'chan_all',
        authorType: 'human',
        authorId: 'hum_local',
        body: '<@agt_333> investigate schema drift',
        attachmentIds: [],
        taskId: 'task_1',
        replyCount: 2,
        createdAt: '2026-04-27T10:00:00.000Z',
      },
      {
        id: 'msg_latest',
        spaceType: 'channel',
        spaceId: 'chan_all',
        authorType: 'agent',
        authorId: 'agt_333',
        body: 'latest top-level note',
        attachmentIds: [],
        createdAt: '2026-04-27T10:10:00.000Z',
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
        body: 'schema drift is in the migration plan',
        attachmentIds: [],
        createdAt: '2026-04-27T10:01:00.000Z',
      },
      {
        id: 'rep_2',
        parentMessageId: 'msg_parent',
        spaceType: 'channel',
        spaceId: 'chan_all',
        authorType: 'human',
        authorId: 'hum_local',
        body: 'please compare the schema result',
        attachmentIds: [],
        createdAt: '2026-04-27T10:02:00.000Z',
      },
    ],
    tasks: [{
      id: 'task_1',
      number: 3,
      status: 'in_progress',
      title: 'investigate schema drift',
      spaceType: 'channel',
      spaceId: 'chan_all',
      messageId: 'msg_parent',
      threadMessageId: 'msg_parent',
      sourceMessageId: 'msg_parent',
      assigneeIds: ['agt_333'],
    }],
    attachments: [],
  };

  const channelHistory = readAgentHistory(state, { target: '#all', limit: 2 });
  assert.equal(channelHistory.kind, 'channel');
  assert.deepEqual(channelHistory.messages.map((item) => item.id), ['msg_parent', 'msg_latest']);

  const threadHistory = readAgentHistory(state, { target: '#all:msg_parent', limit: 10 });
  assert.equal(threadHistory.kind, 'thread');
  assert.equal(threadHistory.parent.id, 'msg_parent');
  assert.deepEqual(threadHistory.messages.map((item) => item.id), ['msg_parent', 'rep_1', 'rep_2']);

  const rendered = formatAgentHistory(threadHistory, { state, targetAgentId: 'agt_333' });
  assert.match(rendered, /target=#all:msg_parent/);
  assert.match(rendered, /@You: @333 investigate schema drift/);
  assert.match(rendered, /\[task #3 status=in_progress assignees=@333\]/);
  assert.match(rendered, /@333: schema drift is in the migration plan/);

  const search = searchAgentMessageHistory(state, { query: 'schema', target: '#all', limit: 5 });
  assert.deepEqual(search.results.map((item) => item.id), ['msg_parent', 'rep_1', 'rep_2']);
  assert.equal(search.results[1].target, '#all:msg_parent');
  assert.match(search.results[1].next, /read_history\(target="#all:msg_parent", around="rep_1"/);
});

test('agent history exposes and searches structured conversation references', () => {
  const state = {
    humans: [{ id: 'hum_local', name: 'You' }],
    agents: [{ id: 'agt_codex', name: 'Codex' }],
    channels: [{ id: 'chan_all', name: 'all', memberIds: ['hum_local', 'agt_codex'] }],
    dms: [],
    messages: [{
      id: 'msg_ref',
      spaceType: 'channel',
      spaceId: 'chan_all',
      authorType: 'human',
      authorId: 'hum_local',
      body: '<@agt_codex> use the attached context',
      attachmentIds: [],
      references: [{
        id: 'ref_1',
        mode: 'context',
        kind: 'selection',
        sourceRecordId: 'msg_source',
        selectedText: 'structured reference search needle',
        bodyPreview: 'source preview',
      }],
      createdAt: '2026-05-22T09:00:00.000Z',
    }],
    replies: [],
    tasks: [],
  };

  const history = readAgentHistory(state, { target: '#all', limit: 10 });
  assert.equal(history.messages[0].references[0].kind, 'selection');
  const rendered = formatAgentHistory(history, { state, targetAgentId: 'agt_codex' });
  assert.match(rendered, /references=context\/selection:msg_source/);

  const search = searchAgentMessageHistory(state, { target: '#all', query: 'needle' });
  assert.equal(search.results[0].id, 'msg_ref');
});

test('agent history tools scope duplicate channel names by workspace id', () => {
  const state = {
    humans: [{ id: 'hum_local', name: 'You' }],
    agents: [{ id: 'agt_one', name: 'One', workspaceId: 'wsp_one' }],
    channels: [
      { id: 'chan_one_all', name: 'all', workspaceId: 'wsp_one', memberIds: ['hum_local', 'agt_one'] },
      { id: 'chan_two_all', name: 'all', workspaceId: 'wsp_two', memberIds: ['hum_local'] },
    ],
    dms: [],
    messages: [
      {
        id: 'msg_one',
        workspaceId: 'wsp_one',
        spaceType: 'channel',
        spaceId: 'chan_one_all',
        authorType: 'human',
        authorId: 'hum_local',
        body: 'workspace one schema note',
        createdAt: '2026-05-14T01:00:00.000Z',
      },
      {
        id: 'msg_two',
        workspaceId: 'wsp_two',
        spaceType: 'channel',
        spaceId: 'chan_two_all',
        authorType: 'human',
        authorId: 'hum_local',
        body: 'workspace two schema note',
        createdAt: '2026-05-14T02:00:00.000Z',
      },
    ],
    replies: [
      {
        id: 'rep_two',
        workspaceId: 'wsp_two',
        parentMessageId: 'msg_two',
        spaceType: 'channel',
        spaceId: 'chan_two_all',
        authorType: 'human',
        authorId: 'hum_local',
        body: 'workspace two reply schema',
        createdAt: '2026-05-14T02:01:00.000Z',
      },
    ],
    tasks: [],
  };

  const one = readAgentHistory(state, { target: '#all', workspaceId: 'wsp_one', limit: 10 });
  assert.deepEqual(one.messages.map((message) => message.id), ['msg_one']);

  const twoSearch = searchAgentMessageHistory(state, { query: 'schema', target: '#all', workspaceId: 'wsp_two', limit: 10 });
  assert.deepEqual(twoSearch.results.map((message) => message.id), ['msg_two', 'rep_two']);
  assert.equal(twoSearch.results[1].target, '#all:msg_two');
});

test('agent history blocks cross-DM reads unless current work item or grant allows it', () => {
  const state = {
    humans: [
      { id: 'hum_owner', name: 'Owner' },
      { id: 'hum_other', name: 'Other' },
    ],
    agents: [{ id: 'agt_cindy', name: 'Cindy', workspaceId: 'wsp_one' }],
    channels: [],
    dms: [
      { id: 'dm_owner', workspaceId: 'wsp_one', participantIds: ['hum_owner', 'agt_cindy'] },
      { id: 'dm_other', workspaceId: 'wsp_one', participantIds: ['hum_other', 'agt_cindy'] },
    ],
    messages: [
      {
        id: 'msg_owner',
        workspaceId: 'wsp_one',
        spaceType: 'dm',
        spaceId: 'dm_owner',
        authorType: 'human',
        authorId: 'hum_owner',
        body: 'private owner context',
        createdAt: '2026-05-21T01:00:00.000Z',
      },
      {
        id: 'msg_other',
        workspaceId: 'wsp_one',
        spaceType: 'dm',
        spaceId: 'dm_other',
        authorType: 'human',
        authorId: 'hum_other',
        body: 'private other context',
        createdAt: '2026-05-21T02:00:00.000Z',
      },
    ],
    replies: [],
    tasks: [],
    workItems: [{
      id: 'wi_owner',
      workspaceId: 'wsp_one',
      agentId: 'agt_cindy',
      spaceType: 'dm',
      spaceId: 'dm_owner',
      parentMessageId: null,
      target: 'dm:dm_owner',
      sourceMessageId: 'msg_owner',
    }],
    conversationGrants: [],
  };

  const currentDm = readAgentHistory(state, {
    agentId: 'agt_cindy',
    workItemId: 'wi_owner',
    target: 'dm:dm_owner',
    workspaceId: 'wsp_one',
  });
  assert.equal(currentDm.ok, true);
  assert.deepEqual(currentDm.messages.map((message) => message.id), ['msg_owner']);

  const otherDm = readAgentHistory(state, {
    agentId: 'agt_cindy',
    workItemId: 'wi_owner',
    target: 'dm:dm_other',
    workspaceId: 'wsp_one',
  });
  assert.equal(otherDm.ok, false);
  assert.equal(otherDm.code, 'dm_forbidden');

  state.conversationGrants.push({
    id: 'grant_1',
    workspaceId: 'wsp_one',
    grantorHumanId: 'hum_other',
    agentId: 'agt_cindy',
    sourceTarget: 'dm:dm_other',
    actions: ['read', 'summarize'],
    status: 'active',
    createdAt: '2026-05-21T03:00:00.000Z',
  });

  const grantedDm = searchAgentMessageHistory(state, {
    agentId: 'agt_cindy',
    query: 'other',
    target: 'dm:dm_other',
    workspaceId: 'wsp_one',
  });
  assert.equal(grantedDm.ok, true);
  assert.deepEqual(grantedDm.results.map((message) => message.id), ['msg_other']);
});
