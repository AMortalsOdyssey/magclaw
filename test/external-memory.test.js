import assert from 'node:assert/strict';
import test from 'node:test';

import { createCollabMemoryManager } from '../server/collab-memory.js';
import {
  buildFeishuExternalMemoryOperations,
  searchFeishuExternalMemoryDocuments,
} from '../server/external-memory.js';
import { applyMarkdownOperation } from '../server/markdown-document.js';

function sampleFeishuPayload() {
  const message = {
    id: 'msg_feishu',
    spaceType: 'channel',
    spaceId: 'chan_all',
    body: 'Trace ID：fsc_20260529_memory\n\nInstruction:\n请总结增长方案',
    createdAt: '2026-05-29T08:00:00.000Z',
    attachmentIds: ['att_1'],
    metadata: {
      systemKind: 'external_import',
      origin: {
        provider: 'feishu',
        traceId: 'fsc_20260529_memory',
        chatId: 'oc_growth',
        chatName: '增长项目群',
        chatType: 'group',
        senderName: 'JHB',
        senderOpenId: 'ou_jhb',
        senderType: 'user',
        triggerMessageId: 'om_trigger',
        rootMessageId: 'om_root',
        threadId: 'omt_growth_topic',
      },
      externalImport: {
        provider: 'feishu',
        replyPolicy: 'thread_all',
        syncEnabled: true,
        traceId: 'fsc_20260529_memory',
      },
      feishu: {
        contextRecords: [
          {
            id: 'om_alice',
            author: 'Alice',
            openId: 'ou_alice',
            senderType: 'user',
            text: 'Alice 负责增长数据看板，需要本周完成。',
            attachmentIds: ['att_1'],
            createdAt: '2026-05-29T07:55:00.000Z',
          },
          {
            id: 'om_bot',
            author: 'Reminder Bot',
            appId: 'cli_reminder',
            senderType: 'app',
            isBot: true,
            text: '下午三点评审。',
            createdAt: '2026-05-29T07:56:00.000Z',
          },
        ],
        mentions: [
          { name: 'Alice', openId: 'ou_alice', type: 'user' },
        ],
        attachmentCount: 1,
      },
    },
  };
  return {
    message,
    task: {
      id: 'task_feishu',
      number: 12,
      title: '请总结增长方案',
      status: 'in_progress',
      threadMessageId: 'msg_feishu',
    },
    channel: { id: 'chan_all', name: 'all' },
    externalImport: { provider: 'feishu' },
  };
}

function applyOperations(operations) {
  const docs = {};
  for (const operation of operations) {
    const relPath = operation.target.relPath;
    const current = docs[relPath] || `# ${relPath}\n`;
    docs[relPath] = applyMarkdownOperation(current, operation);
  }
  return docs;
}

test('Feishu external memory writes daily task people and entrypoint documents that can be recalled', () => {
  const payload = sampleFeishuPayload();
  const operations = buildFeishuExternalMemoryOperations({
    trigger: 'external_import',
    payload,
    now: () => '2026-05-29T08:01:00.000Z',
  });

  const relPaths = operations.map((operation) => operation.target.relPath);
  assert.ok(relPaths.includes('MEMORY.md'));
  assert.ok(relPaths.includes('notes/feishu/daily/2026-05-29.md'));
  assert.ok(relPaths.includes('notes/feishu/tasks/fsc_20260529_memory.md'));
  assert.ok(relPaths.includes('notes/feishu/people/feishu_ou_jhb.md'));
  assert.ok(relPaths.includes('notes/feishu/people/feishu_ou_alice.md'));
  assert.ok(relPaths.includes('notes/feishu/people/feishu_cli_reminder.md'));

  const docs = applyOperations(operations);
  assert.match(docs['MEMORY.md'], /notes\/feishu\/tasks\/fsc_20260529_memory\.md/);
  assert.match(docs['MEMORY.md'], /Alice.*增长数据看板/);
  assert.match(docs['notes/feishu/tasks/fsc_20260529_memory.md'], /Trace ID: fsc_20260529_memory/);
  assert.match(docs['notes/feishu/tasks/fsc_20260529_memory.md'], /JHB.*请总结增长方案/);
  assert.match(docs['notes/feishu/tasks/fsc_20260529_memory.md'], /Alice.*负责增长数据看板/);
  assert.match(docs['notes/feishu/people/feishu_ou_alice.md'], /负责增长数据看板/);
  assert.match(docs['notes/feishu/people/feishu_cli_reminder.md'], /bot/);

  const recall = searchFeishuExternalMemoryDocuments(docs, 'Alice 负责增长数据看板', { limit: 3 });
  assert.equal(recall[0].relPath, 'notes/feishu/people/feishu_ou_alice.md');
  assert.match(recall[0].preview, /负责增长数据看板/);
});

test('collab memory manager applies Feishu external memory operations through markdown writeback', async () => {
  const operations = [];
  const events = [];
  const agent = { id: 'agt_codex', name: 'Codex Local', workspaceId: 'srv_1' };
  const manager = createCollabMemoryManager({
    addSystemEvent: (type, message, metadata) => events.push({ type, message, metadata }),
    agentCardCache: new Map(),
    broadcastState: () => {},
    channelAgentIds: () => ['agt_codex'],
    displayActor: (id) => id,
    findMessage: () => null,
    getState: () => ({ connection: { workspaceId: 'srv_1' }, replies: [] }),
    makeId: (prefix) => `${prefix}_1`,
    normalizeConversationRecord: (record) => record,
    now: () => '2026-05-29T08:01:00.000Z',
    persistState: async () => {},
    spaceDisplayName: () => '#all',
    submitAgentMarkdownOperation: async (targetAgent, operation, options) => {
      operations.push({ targetAgent, operation, options });
      return { ok: true, relPath: operation.target.relPath };
    },
    taskLabel: (task) => `#${task?.number || '?'}`,
  });

  await manager.writeAgentMemoryUpdate(agent, 'external_import', sampleFeishuPayload());

  assert.ok(operations.some((item) => item.operation.target.relPath === 'MEMORY.md'));
  assert.ok(operations.some((item) => item.operation.target.relPath === 'notes/feishu/tasks/fsc_20260529_memory.md'));
  assert.ok(operations.some((item) => item.operation.target.relPath === 'notes/feishu/people/feishu_ou_alice.md'));
  assert.ok(operations.every((item) => item.options.sourceTrigger === 'feishu_external_memory'));
  assert.equal(events.at(-1).type, 'agent_memory_writeback');
  assert.equal(events.at(-1).metadata.trigger, 'external_import');
});
