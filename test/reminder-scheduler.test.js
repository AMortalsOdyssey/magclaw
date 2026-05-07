import test from 'node:test';
import assert from 'node:assert/strict';
import { createReminderScheduler } from '../server/reminder-scheduler.js';

function schedulerDeps(overrides = {}) {
  const state = {
    reminders: [],
    messages: [{
      id: 'msg_parent',
      spaceType: 'channel',
      spaceId: 'chan_all',
      authorType: 'human',
      authorId: 'hum_local',
      body: '明天提醒我带笔记本',
      replyCount: 0,
      createdAt: '2026-05-07T00:00:00.000Z',
      updatedAt: '2026-05-07T00:00:00.000Z',
    }],
    replies: [],
    agents: [{ id: 'agt_one', name: 'Agent One' }],
  };
  const delivered = [];
  const events = [];
  let clock = new Date('2026-05-07T00:00:00.000Z').toISOString();
  return {
    addSystemEvent: (type, message, extra = {}) => events.push({ type, message, extra }),
    addSystemMessage: (spaceType, spaceId, body, extra = {}) => {
      const message = {
        id: `msg_${state.messages.length + 1}`,
        spaceType,
        spaceId,
        authorType: 'system',
        authorId: 'system',
        body,
        replyCount: 0,
        createdAt: clock,
        updatedAt: clock,
        ...extra,
      };
      state.messages.push(message);
      return message;
    },
    addSystemReply: (parentMessageId, body, extra = {}) => {
      const reply = {
        id: `rep_${state.replies.length + 1}`,
        parentMessageId,
        spaceType: 'channel',
        spaceId: 'chan_all',
        authorType: 'system',
        authorId: 'system',
        body,
        createdAt: clock,
        updatedAt: clock,
        ...extra,
      };
      state.replies.push(reply);
      return reply;
    },
    broadcastState: () => {},
    deliverMessageToAgent: async (agent, spaceType, spaceId, message, options = {}) => {
      delivered.push({ agent, spaceType, spaceId, message, options });
    },
    findAgent: (id) => state.agents.find((agent) => agent.id === id) || null,
    findMessage: (id) => state.messages.find((message) => message.id === id) || null,
    getState: () => state,
    makeId: (prefix) => `${prefix}_${state.reminders.length + 1}`,
    now: () => clock,
    persistState: async () => {},
    resolveMessageTarget: () => ({
      spaceType: 'channel',
      spaceId: 'chan_all',
      parentMessageId: 'msg_parent',
      label: '#all:msg_parent',
    }),
    setClock: (value) => {
      clock = new Date(value).toISOString();
    },
    state,
    delivered,
    events,
    ...overrides,
  };
}

test('reminder scheduler fires due reminders into the anchored thread and wakes the owner agent', async () => {
  const deps = schedulerDeps();
  const scheduler = createReminderScheduler(deps);
  const { reminder } = scheduler.createReminder({
    agentId: 'agt_one',
    target: '#all:msg_parent',
    title: '记得带笔记本',
    fireAt: '2026-05-07T00:05:00.000Z',
  });
  assert.equal(reminder.status, 'scheduled');
  assert.equal(deps.state.replies.length, 1);
  assert.match(deps.state.replies[0].body, /scheduled/i);

  deps.setClock('2026-05-07T00:05:01.000Z');
  const fired = await scheduler.fireDueReminders();
  assert.equal(fired.length, 1);
  assert.equal(reminder.status, 'fired');
  assert.equal(reminder.firedAt, '2026-05-07T00:05:01.000Z');
  assert.equal(deps.state.replies.at(-1).eventType, 'reminder_fired');
  assert.match(deps.state.replies.at(-1).body, /记得带笔记本/);
  assert.equal(deps.delivered.length, 1);
  assert.equal(deps.delivered[0].options.parentMessageId, 'msg_parent');
  assert.equal(deps.delivered[0].options.suppressTaskContext, true);
  assert.deepEqual(deps.delivered[0].options.contextLimits, { tasks: 0 });
  assert.match(deps.delivered[0].message.body, /Do not update task status/);
});
