import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMentions,
  extractMentionTokens,
  isMentionBoundaryChar,
  mentionTokenForId,
  normalizeIds,
} from '../server/mentions.js';
import { createConversationModel } from '../server/conversation-model.js';

test('mention helpers normalize ids and render token forms', () => {
  assert.deepEqual(normalizeIds([' a ', 'b', 'a', '', null]), ['a', 'b', 'null']);
  assert.equal(mentionTokenForId('agt_demo'), '<@agt_demo>');
  assert.equal(mentionTokenForId('!here'), '<!here>');
  assert.equal(isMentionBoundaryChar('，'), true);
  assert.equal(isMentionBoundaryChar('a'), false);
});

test('mention token extraction can validate known actors', () => {
  const mentions = extractMentionTokens('<@agt_one> <@agt_missing> <@hum_me> <!all> <!all>', {
    findAgent: (id) => (id === 'agt_one' ? { id } : null),
    findHuman: (id) => (id === 'hum_me' ? { id } : null),
  });

  assert.deepEqual(mentions.agents, ['agt_one']);
  assert.deepEqual(mentions.humans, ['hum_me']);
  assert.deepEqual(mentions.special, ['all']);
});

test('applyMentions stores normalized agent and human ids', () => {
  const record = { body: 'body' };
  applyMentions(record, {
    agents: ['agt_a', 'agt_a', 'agt_b'],
    humans: ['hum_local', 'hum_local'],
  });

  assert.deepEqual(record.mentionedAgentIds, ['agt_a', 'agt_b']);
  assert.deepEqual(record.mentionedHumanIds, ['hum_local']);
});

test('conversation mention validation resolves active cloud member humans', () => {
  const state = {
    humans: [],
    agents: [],
    computers: [],
    channels: [],
    dms: [],
    messages: [],
    replies: [],
    tasks: [],
    missions: [],
    runs: [],
    workItems: [],
    cloud: {
      users: [{ id: 'usr_cloud', email: 'cloud@example.com', name: 'Cloud Human' }],
      workspaceMembers: [{ id: 'mem_cloud', userId: 'usr_cloud', humanId: 'hum_cloud', role: 'member', status: 'active' }],
    },
  };
  const model = createConversationModel({
    getState: () => state,
    httpError: (status, message) => Object.assign(new Error(message), { status }),
    makeId: (prefix) => `${prefix}_test`,
    now: () => '2026-05-08T00:00:00.000Z',
    extractLocalReferences: () => [],
    projectReferenceFromParts: () => null,
  });

  assert.equal(model.findHuman('hum_cloud').name, 'Cloud Human');
  assert.deepEqual(model.extractMentions('<@hum_cloud>').humans, ['hum_cloud']);
});
