import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyMentions,
  extractMentionTokens,
  isMentionBoundaryChar,
  mentionTokenForId,
  normalizeIds,
} from '../server/mentions.js';

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
