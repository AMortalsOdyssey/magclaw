import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCollabMemoryManager } from '../server/collab-memory.js';
import { deterministicCleanupMarkdown } from '../server/markdown-document.js';
import { createMarkdownMaintenanceManager } from '../server/markdown-maintenance.js';
import { createMarkdownOperationApplier } from '../server/markdown-operations.js';
import {
  readMarkdownOperationRecords,
  readMarkdownOplogManifest,
  rebuildMarkdownFromOplog,
} from '../server/markdown-oplog.js';

async function makeHarness(options = {}) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-mdops-'));
  const root = path.join(tmp, 'agent');
  await mkdir(path.join(root, 'notes'), { recursive: true });
  const events = [];
  const agent = { id: 'agt_one', name: 'One', workspaceId: 'wsp_one' };
  const applier = createMarkdownOperationApplier({
    addSystemEvent: (type, message, extra = {}) => events.push({ type, message, extra }),
    defaultAgentMemory: () => [
      '# One',
      '',
      '## 近期工作',
      '- seed',
      '',
    ].join('\n'),
    ensureAgentWorkspace: async () => root,
    makeId: (prefix) => `${prefix}_${events.length}_${Date.now()}`,
    now: (() => {
      let tick = 0;
      return () => `2026-05-21T00:00:${String(tick++).padStart(2, '0')}.000Z`;
    })(),
    segmentMaxBytes: options.segmentMaxBytes || 10 * 1024 * 1024,
    segmentMaxOps: options.segmentMaxOps || 10_000,
  });
  return { agent, applier, events, root, tmp };
}

test('markdown operation applier shards logs and rebuilds materialized Markdown in order', async () => {
  const { agent, applier, root, tmp } = await makeHarness({ segmentMaxOps: 3 });
  try {
    for (let index = 0; index < 8; index += 1) {
      await applier.submitAgentMarkdownOperation(agent, {
        type: 'upsert_bullet',
        target: { relPath: 'MEMORY.md', heading: 'Recent Work' },
        text: `- item ${index}`,
        maxItems: 20,
      }, { idempotencyKey: `item-${index}` });
    }

    const files = await readdir(path.join(root, '.magclaw-ops', 'markdown', 'MEMORY.md'));
    assert.ok(files.includes('log-000001.jsonl'));
    assert.ok(files.includes('log-000002.jsonl'));
    const manifest = await readMarkdownOplogManifest(root, 'MEMORY.md');
    assert.equal(manifest.currentSegment >= 3, true);
    assert.equal(manifest.revision, 9);

    await rm(path.join(root, 'MEMORY.md'));
    const rebuilt = await rebuildMarkdownFromOplog(root, 'MEMORY.md');
    assert.match(rebuilt.content, /- item 7/);
    assert.match(rebuilt.content, /- seed/);
    assert.equal(rebuilt.revision, 9);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('markdown operation applier serializes same-document concurrent writes without dropping bullets', async () => {
  const { agent, applier, root, tmp } = await makeHarness();
  try {
    await Promise.all(Array.from({ length: 25 }, (_, index) => applier.submitAgentMarkdownOperation(agent, {
      type: 'upsert_bullet',
      target: { relPath: 'MEMORY.md', heading: 'Recent Work' },
      text: `- concurrent ${index}`,
      maxItems: 40,
    }, { idempotencyKey: `concurrent-${index}` })));

    const content = await readFile(path.join(root, 'MEMORY.md'), 'utf8');
    for (let index = 0; index < 25; index += 1) {
      assert.match(content, new RegExp(`- concurrent ${index}\\b`));
    }
    const manifest = await readMarkdownOplogManifest(root, 'MEMORY.md');
    assert.equal(manifest.revision, 26);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('markdown operation applier treats idempotency keys as exactly-once writes', async () => {
  const { agent, applier, root, tmp } = await makeHarness();
  try {
    const first = await applier.submitAgentMarkdownOperation(agent, {
      type: 'upsert_bullet',
      target: { relPath: 'notes/profile.md', heading: 'Strengths And Skills' },
      text: '- specializes in memory systems',
    }, { idempotencyKey: 'profile-memory-systems' });
    const second = await applier.submitAgentMarkdownOperation(agent, {
      type: 'upsert_bullet',
      target: { relPath: 'notes/profile.md', heading: 'Strengths And Skills' },
      text: '- specializes in memory systems',
    }, { idempotencyKey: 'profile-memory-systems' });

    assert.equal(first.status, 'applied');
    assert.equal(second.status, 'deduped');
    const records = await readMarkdownOperationRecords(root, 'notes/profile.md');
    assert.equal(records.length, 2);
    const content = await readFile(path.join(root, 'notes', 'profile.md'), 'utf8');
    assert.equal((content.match(/specializes in memory systems/g) || []).length, 1);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('collab memory writeback records capabilities through the Markdown operation applier', async () => {
  const { agent, applier, root, tmp } = await makeHarness();
  try {
    const state = { messages: [], replies: [] };
    const manager = createCollabMemoryManager({
      addSystemEvent: () => {},
      agentCardCache: new Map(),
      broadcastState: () => {},
      channelAgentIds: () => [],
      displayActor: (id) => id,
      findMessage: () => null,
      getState: () => state,
      makeId: (prefix) => `${prefix}_one`,
      normalizeConversationRecord: (record) => record,
      now: () => '2026-05-21T00:00:00.000Z',
      persistState: async () => {},
      spaceDisplayName: () => '#all',
      submitAgentMarkdownOperation: applier.submitAgentMarkdownOperation,
      taskLabel: () => 'TASK-1',
    });

    const changed = await manager.writeAgentMemoryUpdate(agent, 'agent_memory_tool', {
      memory: {
        kind: 'capability',
        summary: '专攻群里的情绪价值提供',
        sourceText: '以后专攻群里的情绪价值提供',
      },
    });

    assert.equal(changed, true);
    const memory = await readFile(path.join(root, 'MEMORY.md'), 'utf8');
    const profile = await readFile(path.join(root, 'notes', 'profile.md'), 'utf8');
    assert.match(memory, /- 专攻群里的情绪价值提供/);
    assert.match(profile, /- 专攻群里的情绪价值提供/);
    const records = await readMarkdownOperationRecords(root, 'MEMORY.md');
    assert.ok(records.some((record) => record.operation?.type === 'upsert_bullet'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('deterministic Markdown cleanup merges duplicate headings and removes duplicate bullets', () => {
  const cleaned = deterministicCleanupMarkdown([
    '# Agent',
    '',
    '## 第三章',
    '- A',
    '- A',
    '',
    '## 第三章',
    '- B',
    '- 暂无近期可复用记录。',
    '',
  ].join('\n'));

  assert.equal((cleaned.match(/## 第三章/g) || []).length, 1);
  assert.equal((cleaned.match(/- A/g) || []).length, 1);
  assert.match(cleaned, /- B/);
  assert.doesNotMatch(cleaned, /暂无近期可复用记录/);
});

test('markdown maintenance applies cleanup through the applier and records run metadata', async () => {
  const { agent, applier, root, tmp } = await makeHarness();
  const runs = [];
  try {
    await writeFile(path.join(root, 'MEMORY.md'), [
      '# One',
      '',
      '## 第三章',
      '- A',
      '- A',
      '',
      '## 第三章',
      '- B',
      '',
    ].join('\n'));
    const maintenance = createMarkdownMaintenanceManager({
      addSystemEvent: () => {},
      ensureAgentWorkspace: async () => root,
      makeId: (prefix) => `${prefix}_${runs.length}`,
      now: () => '2026-05-21T00:00:00.000Z',
      persistMarkdownMaintenanceRun: async (record) => runs.push(record),
      submitAgentMarkdownOperation: applier.submitAgentMarkdownOperation,
    });

    const result = await maintenance.maintainAgentMarkdown(agent, 'MEMORY.md', { semantic: false });
    assert.equal(result.deterministicChanged, true);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'completed');
    assert.equal(runs[0].metadata.mode, 'deterministic');
    const memory = await readFile(path.join(root, 'MEMORY.md'), 'utf8');
    assert.equal((memory.match(/## 第三章/g) || []).length, 1);
    assert.equal((memory.match(/- A/g) || []).length, 1);
    assert.match(memory, /- B/);
    const records = await readMarkdownOperationRecords(root, 'MEMORY.md');
    assert.ok(records.some((record) => record.operation?.type === 'maintenance_rewrite'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('markdown maintenance reports global LLM failures with generic UI copy and detailed logs', async () => {
  const { agent, applier, root, tmp } = await makeHarness();
  const issues = [];
  const errors = [];
  try {
    await writeFile(path.join(root, 'MEMORY.md'), '# One\n\n## 近期工作\n- seed\n');
    const maintenance = createMarkdownMaintenanceManager({
      addSystemEvent: () => {},
      ensureAgentWorkspace: async () => root,
      llmConfig: { baseUrl: '', apiKey: '', model: '' },
      logLlmIssue: (message, detail) => errors.push({ message, detail }),
      reportLlmIssue: (issue) => issues.push(issue),
      submitAgentMarkdownOperation: applier.submitAgentMarkdownOperation,
    });

    const result = await maintenance.maintainAgentMarkdown(agent, 'MEMORY.md', { semantic: true });

    assert.equal(result.semantic, 'llm_unconfigured');
    assert.equal(issues.length, 1);
    assert.equal(issues[0].message, '会话总结的 LLM 异常');
    assert.equal(issues[0].workspaceId, 'wsp_one');
    assert.equal(issues[0].agentId, 'agt_one');
    assert.match(issues[0].detail, /not configured/i);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /global LLM unavailable/i);
    assert.match(JSON.stringify(errors[0].detail), /MEMORY\.md/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
