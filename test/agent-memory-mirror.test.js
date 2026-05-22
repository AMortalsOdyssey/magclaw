import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentMemoryMirrorManager } from '../server/agent-memory-mirror.js';
import { markdownContentHash } from '../server/markdown-oplog.js';

test('agent memory mirror writes and reads only MEMORY.md from PVC storage', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-memory-mirror-'));
  const events = [];
  try {
    const manager = createAgentMemoryMirrorManager({
      rootDir: tmp,
      addSystemEvent: (type, message, extra = {}) => events.push({ type, message, extra }),
      now: () => '2026-05-21T00:00:00.000Z',
    });
    const agent = { id: 'agt_one', name: 'Mirror Agent', workspaceId: 'wsp_one' };
    const content = '# Mirror Agent\n\n## 渐进式披露\n';
    const metadata = await manager.materializeAgentMemoryMirror({
      agent,
      workspaceId: 'wsp_one',
      agentId: 'agt_one',
      relPath: 'MEMORY.md',
      content,
      documentHash: markdownContentHash(content),
      revision: 3,
      updatedAt: '2026-05-21T00:00:00.000Z',
    });

    assert.equal(metadata.storageMode, 'pvc');
    assert.match(metadata.storageKey, /agent-memory\/wsp_one\/agt_one\/MEMORY\.md$/);
    assert.equal(metadata.revision, 3);
    assert.equal(await readFile(path.join(tmp, 'wsp_one', 'agt_one', 'MEMORY.md'), 'utf8'), content);

    const ignored = await manager.materializeAgentMemoryMirror({
      agent,
      relPath: 'notes/profile.md',
      content: '# Should stay local\n',
    });
    assert.equal(ignored.skipped, true);

    const tree = await manager.listAgentMemoryMirrorWorkspace(agent);
    assert.equal(tree.source, 'cloud_mirror');
    assert.deepEqual(tree.entries.map((entry) => entry.path), ['MEMORY.md']);

    const file = await manager.readAgentMemoryMirrorFile(agent);
    assert.equal(file.file.source, 'cloud_mirror');
    assert.equal(file.file.content, content);
    assert.ok(events.some((entry) => entry.type === 'agent_memory_mirror_written'));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('agent memory mirror migration copies legacy MEMORY.md, verifies hash, and clears legacy workspace', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-memory-mirror-'));
  const legacy = path.join(tmp, 'legacy-agent');
  const cleared = [];
  try {
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, 'MEMORY.md'), '# Legacy\n\n- old cloud memory\n', 'utf8');
    const manager = createAgentMemoryMirrorManager({
      rootDir: path.join(tmp, 'mirror'),
      now: () => '2026-05-21T00:00:00.000Z',
    });
    const agent = { id: 'agt_legacy', name: 'Legacy', workspaceId: 'wsp_one', workspacePath: legacy };

    const result = await manager.migrateAgentMemoryMirror({
      agent,
      legacyWorkspacePath: legacy,
      clearLegacyWorkspace: async (record) => cleared.push(record),
    });

    assert.equal(result.ok, true);
    assert.equal(result.source, 'legacy_materialized');
    assert.equal(result.hash, markdownContentHash('# Legacy\n\n- old cloud memory\n'));
    assert.equal(cleared.length, 1);
    assert.equal(cleared[0].agentId, 'agt_legacy');
    assert.equal(cleared[0].legacyWorkspacePath, legacy);
    const mirrored = await manager.readAgentMemoryMirrorFile(agent);
    assert.match(mirrored.file.content, /old cloud memory/);
    assert.equal(agent.memoryMirrorMigration?.source, 'legacy_materialized');
    assert.ok(agent.memoryMirrorMigration?.clearedLegacyWorkspaceAt);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
