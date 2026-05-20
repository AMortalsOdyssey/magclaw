import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createAgentRuntimeManager } from '../server/agent-runtime-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

test('passive awareness work items are completed without counting as sends', () => {
  const state = {
    workItems: [
      { id: 'wi_read', status: 'delivered', sendCount: 0, updatedAt: 'old' },
      { id: 'wi_stopped', status: 'stopped', sendCount: 0 },
    ],
  };
  const runtime = createAgentRuntimeManager({
    getState: () => state,
    findWorkItem: (id) => state.workItems.find((item) => item.id === id) || null,
    now: () => '2026-05-20T18:40:00.000Z',
  });

  assert.equal(runtime.markPassiveAwarenessWorkItemsObserved({ workItemId: 'wi_read' }), true);
  assert.equal(state.workItems[0].status, 'responded');
  assert.equal(state.workItems[0].completedAt, '2026-05-20T18:40:00.000Z');
  assert.equal(state.workItems[0].updatedAt, '2026-05-20T18:40:00.000Z');
  assert.equal(state.workItems[0].sendCount, 0);
  assert.equal(state.workItems[0].passiveAwarenessObserved, true);

  assert.equal(runtime.markPassiveAwarenessWorkItemsObserved({ workItemId: 'wi_stopped' }), false);
  assert.equal(state.workItems[1].status, 'stopped');
});

test('runtime keeps agent channel awareness passive unless the agent explicitly sends', async () => {
  const relaySource = await readFile(path.join(ROOT, 'server/agent-runtime/warm-control-relay.js'), 'utf8');
  assert.match(relaySource, /async function fanOutAgentChannelAwareness/);
  assert.match(relaySource, /selectAgentAwarenessTargets/);
  assert.ok(
    relaySource.indexOf('await relayAgentMentions(message') < relaySource.indexOf('await fanOutAgentChannelAwareness(message'),
    'top-level Agent responses should relay explicit mentions before passive peer awareness',
  );

  const appServerSource = await readFile(path.join(ROOT, 'server/agent-runtime/app-server-turns.js'), 'utf8');
  assert.match(appServerSource, /sourceMessage\?\.passiveAwareness/);
  assert.match(appServerSource, /agent_passive_awareness_stdout_suppressed/);
  assert.match(appServerSource, /markPassiveAwarenessWorkItemsObserved/);
});
