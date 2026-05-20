import assert from 'node:assert/strict';
import test from 'node:test';

import { selectAgentAwarenessTargets } from '../server/agent-awareness.js';

test('agent awareness targets other available channel agents for top-level public agent messages', () => {
  const state = {
    agents: [
      { id: 'agt_cindy', name: 'Cindy', status: 'idle' },
      { id: 'agt_alice', name: 'Alice', status: 'idle' },
      { id: 'agt_busy', name: 'Busy', status: 'working' },
    ],
  };
  const channel = {
    id: 'chan_all',
    memberIds: ['hum_owner', 'agt_cindy', 'agt_alice', 'agt_busy'],
    agentIds: ['agt_cindy', 'agt_alice', 'agt_busy'],
  };
  const record = {
    id: 'msg_cindy',
    spaceType: 'channel',
    spaceId: 'chan_all',
    authorType: 'agent',
    authorId: 'agt_cindy',
    body: '收到，我会把这个作为长期角色侧重点。',
    agentRelayDepth: 1,
  };

  const targets = selectAgentAwarenessTargets({
    state,
    channel,
    record,
    channelAgentIds: () => ['agt_cindy', 'agt_alice', 'agt_busy'],
    findAgent: (id) => state.agents.find((agent) => agent.id === id) || null,
    agentAvailableForAutoWork: (agent) => ['idle', 'online'].includes(agent.status),
  });

  assert.deepEqual(targets.map((agent) => agent.id), ['agt_alice']);
});

test('agent awareness skips thread replies and recursive relay messages', () => {
  const state = {
    agents: [
      { id: 'agt_cindy', name: 'Cindy', status: 'idle' },
      { id: 'agt_alice', name: 'Alice', status: 'idle' },
    ],
  };
  const channel = { id: 'chan_all', agentIds: ['agt_cindy', 'agt_alice'] };
  const base = {
    id: 'msg_cindy',
    spaceType: 'channel',
    spaceId: 'chan_all',
    authorType: 'agent',
    authorId: 'agt_cindy',
  };
  const deps = {
    state,
    channel,
    channelAgentIds: () => ['agt_cindy', 'agt_alice'],
    findAgent: (id) => state.agents.find((agent) => agent.id === id) || null,
    agentAvailableForAutoWork: () => true,
  };

  assert.deepEqual(selectAgentAwarenessTargets({ ...deps, record: { ...base, parentMessageId: 'msg_parent', agentRelayDepth: 1 } }), []);
  assert.deepEqual(selectAgentAwarenessTargets({ ...deps, record: { ...base, agentRelayDepth: 2 } }), []);
});
