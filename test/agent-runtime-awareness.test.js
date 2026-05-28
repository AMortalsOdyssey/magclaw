import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
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

test('remote delivery inlines current image attachment data before daemon dispatch', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-runtime-inline-image-'));
  const attachmentRoot = path.join(tmp, 'attachments');
  const imagePath = path.join(attachmentRoot, 'wsp_test', 'att_current.png');
  await mkdir(path.dirname(imagePath), { recursive: true });
  await writeFile(imagePath, Buffer.from('current-image'));
  const state = {
    humans: [{ id: 'hum_test', name: 'Human', role: 'owner' }],
    agents: [{
      id: 'agt_remote',
      name: 'Remote',
      runtime: 'codex',
      computerId: 'cmp_remote',
      workspaceId: 'wsp_test',
    }],
    channels: [{
      id: 'chan_all',
      name: 'all',
      workspaceId: 'wsp_test',
      humanIds: ['hum_test'],
      agentIds: ['agt_remote'],
      memberIds: ['hum_test', 'agt_remote'],
    }],
    dms: [],
    messages: [],
    replies: [],
    tasks: [],
    workItems: [],
    attachments: [{
      id: 'att_current',
      name: 'current.png',
      type: 'image/png',
      bytes: 13,
      storageKey: 'wsp_test/att_current.png',
      source: 'upload',
    }],
    events: [],
  };
  let delivered = null;
  const runtime = createAgentRuntimeManager({
    ROOT,
    HOST: '127.0.0.1',
    PORT: 6543,
    attachmentStorageDir: attachmentRoot,
    getState: () => state,
    makeId: () => 'wi_inline',
    now: () => '2026-05-28T10:00:00.000Z',
    addSystemEvent: () => {},
    targetForConversation: () => '#all',
    findMessage: () => null,
    findTaskForThreadMessage: () => null,
    shouldStartThreadForAgentDelivery: () => false,
    codexRuntimeOverrideForDelivery: () => null,
    cloudRelay: {
      agentShouldUseRelay: () => true,
      deliverToAgent: async (_agent, message) => {
        delivered = message;
      },
    },
  });

  try {
    await runtime.deliverMessageToAgent(state.agents[0], 'channel', 'chan_all', {
      id: 'msg_current',
      workspaceId: 'wsp_test',
      authorType: 'human',
      authorId: 'hum_test',
      body: '现在能看到吗',
      attachmentIds: ['att_current'],
    });

    const attachment = delivered?.contextPack?.attachments?.find((item) => item.id === 'att_current');
    assert.equal(attachment?.visualInput, true);
    assert.equal(attachment?.dataUrl, `data:image/png;base64,${Buffer.from('current-image').toString('base64')}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
