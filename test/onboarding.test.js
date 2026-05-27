import assert from 'node:assert/strict';
import test from 'node:test';

import { createOnboardingManager } from '../server/onboarding.js';

function uniqueIds(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean).map(String))];
}

test('new agent greeting task is delivered internally without entering channel messages', async () => {
  let nextId = 0;
  const agent = {
    id: 'agt_dark',
    workspaceId: 'wsp_dark',
    name: '黑化',
    runtime: 'Codex CLI',
    description: '',
    status: 'idle',
  };
  const state = {
    connection: { workspaceId: 'wsp_dark' },
    cloud: {
      workspaces: [{
        id: 'wsp_dark',
        name: 'Dark Team',
        newAgentGreetingEnabled: true,
      }],
    },
    channels: [{
      id: 'chan_all_dark',
      workspaceId: 'wsp_dark',
      name: 'all',
      defaultChannel: true,
      agentIds: [agent.id],
      memberIds: [agent.id],
    }],
    agents: [agent],
    messages: [
      {
        id: 'msg_zh_1',
        workspaceId: 'wsp_dark',
        spaceType: 'channel',
        spaceId: 'chan_all_dark',
        authorType: 'human',
        authorId: 'hum_owner',
        body: '大家好，我们今天先看一下部署状态。',
        createdAt: '2026-05-21T09:00:00.000Z',
      },
      {
        id: 'msg_zh_2',
        workspaceId: 'wsp_dark',
        spaceType: 'channel',
        spaceId: 'chan_all_dark',
        authorType: 'human',
        authorId: 'hum_owner',
        body: '这个 Agent 后面主要负责代码调查和修复。',
        createdAt: '2026-05-21T09:01:00.000Z',
      },
    ],
    events: [],
  };
  const deliveries = [];
  const manager = createOnboardingManager({
    addSystemEvent(type, message, extra = {}) {
      state.events.push({ id: `evt_${nextId += 1}`, type, message, ...extra });
    },
    addSystemMessage() {
      throw new Error('agent greeting tasks should not be visible channel messages');
    },
    broadcastState() {},
    deliverMessageToAgent: async (targetAgent, spaceType, spaceId, message, options = {}) => {
      deliveries.push({ targetAgent, spaceType, spaceId, message, options });
    },
    findAgent: (id) => (id === agent.id ? agent : null),
    getState: () => state,
    makeId: (prefix) => `${prefix}_${nextId += 1}`,
    normalizeIds: uniqueIds,
    now: () => '2026-05-21T10:00:00.000Z',
    persistState: async () => {},
  });

  const taskMessage = manager.scheduleNewAgentGreeting(agent, { workspaceId: 'wsp_dark' });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(taskMessage);
  assert.equal(taskMessage.internal, true);
  assert.equal(taskMessage.hiddenFromChannel, true);
  assert.equal(state.messages.some((message) => message.id === taskMessage.id), false);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].spaceType, 'channel');
  assert.equal(deliveries[0].spaceId, 'chan_all_dark');
  assert.equal(deliveries[0].message.id, taskMessage.id);
  assert.match(deliveries[0].message.body, /Onboarding task \(system-triggered\): This is a new Agent greeting/);
  assert.match(deliveries[0].message.body, /Recent #all language context: Chinese \(zh-CN\)/);
  assert.match(deliveries[0].message.body, /Agent description: No description provided yet\./);
  assert.match(deliveries[0].message.body, /Runtime: Codex CLI/);
  assert.equal(state.events.some((event) => event.type === 'agent_onboarding_greeting_task_created'), true);
});

test('human onboarding task is delivered internally without entering channel messages', async () => {
  let nextId = 0;
  const agent = {
    id: 'agt_welcome',
    workspaceId: 'wsp_welcome',
    name: 'Welcome Lead',
    runtime: 'Codex CLI',
    description: 'Helps new humans find the right place to start',
    status: 'idle',
  };
  const human = {
    id: 'hum_new',
    workspaceId: 'wsp_welcome',
    name: 'New Human',
    email: 'new-human@example.com',
  };
  const state = {
    connection: { workspaceId: 'wsp_welcome' },
    cloud: {
      workspaces: [{
        id: 'wsp_welcome',
        name: 'Welcome Team',
        onboardingAgentId: agent.id,
      }],
    },
    channels: [{
      id: 'chan_all_welcome',
      workspaceId: 'wsp_welcome',
      name: 'all',
      defaultChannel: true,
      agentIds: [agent.id],
      memberIds: [agent.id, human.id],
    }],
    agents: [agent],
    messages: [
      {
        id: 'msg_zh_1',
        workspaceId: 'wsp_welcome',
        spaceType: 'channel',
        spaceId: 'chan_all_welcome',
        authorType: 'human',
        authorId: 'hum_owner',
        body: '大家好，我们今天先把新成员的协作路径说清楚。',
        createdAt: '2026-05-21T09:00:00.000Z',
      },
      {
        id: 'msg_zh_2',
        workspaceId: 'wsp_welcome',
        spaceType: 'channel',
        spaceId: 'chan_all_welcome',
        authorType: 'human',
        authorId: 'hum_owner',
        body: '这里是 MagClaw 的项目频道，可以直接和 Agent 一起推进任务。',
        createdAt: '2026-05-21T09:01:00.000Z',
      },
    ],
    events: [],
  };
  const deliveries = [];
  const manager = createOnboardingManager({
    addSystemEvent(type, message, extra = {}) {
      state.events.push({ id: `evt_${nextId += 1}`, type, message, ...extra });
    },
    addSystemMessage() {
      throw new Error('human onboarding tasks should not be visible channel messages');
    },
    broadcastState() {},
    deliverMessageToAgent: async (targetAgent, spaceType, spaceId, message, options = {}) => {
      deliveries.push({ targetAgent, spaceType, spaceId, message, options });
    },
    findAgent: (id) => (id === agent.id ? agent : null),
    getState: () => state,
    makeId: (prefix) => `${prefix}_${nextId += 1}`,
    normalizeIds: uniqueIds,
    now: () => '2026-05-21T10:00:00.000Z',
    persistState: async () => {},
  });

  const taskMessage = manager.scheduleHumanOnboarding({
    human,
    workspace: state.cloud.workspaces[0],
    trigger: 'member_joined',
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.ok(taskMessage);
  assert.equal(taskMessage.internal, true);
  assert.equal(taskMessage.hiddenFromChannel, true);
  assert.equal(state.messages.some((message) => message.id === taskMessage.id), false);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].spaceType, 'channel');
  assert.equal(deliveries[0].spaceId, 'chan_all_welcome');
  assert.equal(deliveries[0].message.id, taskMessage.id);
  assert.match(deliveries[0].message.body, /Onboarding task \(system-triggered\): This is a new human member onboarding/);
  assert.match(deliveries[0].message.body, /<@hum_new>/);
  assert.match(deliveries[0].message.body, /Recent #all language context: Chinese \(zh-CN\)/);
  assert.match(deliveries[0].message.body, /what MagClaw is/);
  assert.equal(state.events.some((event) => event.type === 'human_onboarding_task_created'), true);
});
