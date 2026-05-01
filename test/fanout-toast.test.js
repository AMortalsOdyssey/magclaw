import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFanoutDecisionCards,
  compactFanoutReason,
  renderFanoutDecisionToasts,
  routeAgentNames,
} from '../public/fanout-toast.js';

test('fan-out toast helpers render one concise LLM route card', () => {
  const routeEvent = {
    id: 'route_1',
    targetAgentIds: ['agt_a', 'agt_b'],
    reason: 'semantic thread reply mentioned two different agents',
  };
  const state = {
    agents: [
      { id: 'agt_a', name: '韩立' },
      { id: 'agt_b', name: '仲神师' },
    ],
  };

  assert.equal(routeAgentNames(routeEvent, state), '韩立, 仲神师');
  const cards = buildFanoutDecisionCards(routeEvent, state);
  assert.equal(cards.length, 1);
  assert.equal(cards[0].title, 'LLM fan-out');
  assert.match(cards[0].body, /韩立, 仲神师/);
  assert.match(cards[0].meta, /semantic thread reply/);
  const html = renderFanoutDecisionToasts(cards);
  assert.match(html, /fanout-toast-stack/);
  assert.match(html, /LLM fan-out/);
  assert.doesNotMatch(html, /Fan-out API \/ Trigger/);
});

test('fan-out toast reason falls back to evidence and truncates long text', () => {
  const longReason = 'x'.repeat(120);
  assert.equal(compactFanoutReason({ reason: longReason }).length, 92);
  assert.match(compactFanoutReason({ evidence: [{ type: 'hint', value: 'named agent' }] }), /named agent/);
});
