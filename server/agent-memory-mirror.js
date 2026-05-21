import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  baseNameFromProjectPath,
  httpError,
  mimeForPath,
  normalizeProjectRelPath,
  safePathWithin,
} from './path-utils.js';
import { markdownContentHash } from './markdown-oplog.js';

function cleanSegment(value, fallback = 'local') {
  return String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 160) || fallback;
}

function workspaceIdFor(agent = {}, fallback = 'local') {
  return String(agent.workspaceId || fallback || 'local').trim() || 'local';
}

function mirrorRelPathFor(agent = {}, relPath = 'MEMORY.md') {
  const workspaceId = cleanSegment(workspaceIdFor(agent));
  const agentId = cleanSegment(agent.id || agent.agentId || 'unknown');
  return path.join(workspaceId, agentId, normalizeProjectRelPath(relPath || 'MEMORY.md') || 'MEMORY.md');
}

async function atomicWrite(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, filePath);
}

export function createAgentMemoryMirrorManager(deps = {}) {
  const {
    addSystemEvent = () => {},
    enabled = true,
    rootDir = '',
    now = () => new Date().toISOString(),
  } = deps;
  const root = rootDir ? path.resolve(rootDir) : '';

  function mirrorPath(agent = {}, relPath = 'MEMORY.md') {
    if (!root) return '';
    return safePathWithin(root, mirrorRelPathFor(agent, relPath));
  }

  function storageKey(agent = {}, relPath = 'MEMORY.md') {
    const key = mirrorRelPathFor(agent, relPath).split(path.sep).join('/');
    return `agent-memory/${key}`;
  }

  async function materializeAgentMemoryMirror(payload = {}) {
    const relPath = normalizeProjectRelPath(payload.relPath || payload.target?.relPath || 'MEMORY.md') || 'MEMORY.md';
    if (relPath !== 'MEMORY.md') return { skipped: true, reason: 'memory_only' };
    if (!enabled || !root) return { skipped: true, reason: 'disabled' };
    const agent = payload.agent || {
      id: payload.agentId,
      name: payload.agentName || payload.agentId,
      workspaceId: payload.workspaceId,
    };
    const filePath = mirrorPath(agent, relPath);
    if (!filePath) throw new Error('Invalid agent memory mirror path.');
    const content = String(payload.content ?? payload.markdown ?? '');
    await atomicWrite(filePath, content);
    const info = await stat(filePath);
    const hash = payload.documentHash || markdownContentHash(content);
    const metadata = {
      storageMode: 'pvc',
      storageKey: storageKey(agent, relPath),
      bytes: info.size,
      documentHash: hash,
      revision: Number(payload.revision || 0),
      updatedAt: payload.updatedAt || now(),
    };
    addSystemEvent('agent_memory_mirror_written', `Updated cloud MEMORY.md mirror for ${agent.name || agent.id || 'Agent'}.`, {
      agentId: agent.id || payload.agentId || null,
      workspaceId: workspaceIdFor(agent, payload.workspaceId),
      relPath,
      storageKey: metadata.storageKey,
      bytes: metadata.bytes,
      documentHash: metadata.documentHash,
      revision: metadata.revision,
    });
    return metadata;
  }

  async function readAgentMemoryMirrorFile(agent = {}) {
    const relPath = 'MEMORY.md';
    const filePath = mirrorPath(agent, relPath);
    if (!filePath) throw httpError(404, 'Cloud memory mirror is not configured.');
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) throw httpError(404, 'Cloud memory mirror was not found.');
    const content = await readFile(filePath, 'utf8');
    return {
      file: {
        id: `${agent.id}:${relPath}`,
        agentId: agent.id,
        agentName: agent.name,
        name: baseNameFromProjectPath(relPath, agent.name),
        path: relPath,
        absolutePath: filePath,
        type: mimeForPath(filePath),
        bytes: info.size,
        updatedAt: info.mtime.toISOString(),
        previewKind: 'markdown',
        content,
        source: 'cloud_mirror',
        storageMode: 'pvc',
        storageKey: storageKey(agent, relPath),
      },
    };
  }

  async function listAgentMemoryMirrorWorkspace(agent = {}, rawRelPath = '') {
    const relPath = normalizeProjectRelPath(rawRelPath || '');
    if (relPath && relPath !== '.') throw httpError(404, 'Cloud mirror only exposes MEMORY.md while the Computer is offline.');
    const filePath = mirrorPath(agent, 'MEMORY.md');
    if (!filePath) throw httpError(404, 'Cloud memory mirror is not configured.');
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) throw httpError(404, 'Cloud memory mirror was not found.');
    return {
      agent: {
        id: agent.id,
        name: agent.name,
        workspacePath: path.dirname(filePath),
        source: 'cloud_mirror',
      },
      path: '',
      source: 'cloud_mirror',
      stale: false,
      entries: [{
        id: `${agent.id}:MEMORY.md`,
        name: 'MEMORY.md',
        path: 'MEMORY.md',
        kind: 'file',
        type: mimeForPath(filePath),
        bytes: info.size,
        updatedAt: info.mtime.toISOString(),
        source: 'cloud_mirror',
      }],
      truncated: false,
    };
  }

  async function migrateAgentMemoryMirror(options = {}) {
    const agent = options.agent || {};
    if (!agent.id) throw new Error('Agent is required for memory mirror migration.');
    let source = '';
    let content = '';
    const legacyPath = options.legacyWorkspacePath || agent.workspacePath || '';
    const legacyMemoryPath = legacyPath ? safePathWithin(legacyPath, 'MEMORY.md') : '';
    if (legacyMemoryPath) {
      content = await readFile(legacyMemoryPath, 'utf8').catch(() => '');
      if (content.trim()) source = 'legacy_materialized';
    }
    if (!content.trim() && typeof options.rebuildLegacyMemory === 'function') {
      content = await Promise.resolve(options.rebuildLegacyMemory(agent)).catch(() => '');
      if (String(content || '').trim()) source = 'legacy_operations';
    }
    if (!content.trim() && typeof options.defaultAgentMemory === 'function') {
      content = String(options.defaultAgentMemory(agent) || '');
      source = 'default_memory';
    }
    if (!content.trim()) throw new Error('No MEMORY.md content available for migration.');

    const hash = markdownContentHash(content);
    const metadata = await materializeAgentMemoryMirror({
      agent,
      relPath: 'MEMORY.md',
      content,
      documentHash: hash,
      revision: Number(options.revision || agent.memoryMirrorMigration?.revision || 1),
      updatedAt: now(),
    });
    if (metadata.skipped) throw new Error(`Memory mirror migration skipped: ${metadata.reason || 'unknown'}`);
    const mirrored = await readAgentMemoryMirrorFile(agent);
    const mirrorHash = markdownContentHash(mirrored.file.content);
    if (mirrorHash !== hash) throw new Error('Memory mirror migration hash verification failed.');

    const migratedAt = now();
    const clearRecord = {
      agentId: agent.id,
      workspaceId: workspaceIdFor(agent),
      legacyWorkspacePath: legacyPath || null,
      mirrorStorageKey: metadata.storageKey,
      hash,
      source,
      migratedAt,
    };
    if (typeof options.clearLegacyWorkspace === 'function') {
      await options.clearLegacyWorkspace(clearRecord);
      clearRecord.clearedLegacyWorkspaceAt = now();
      if (legacyPath) await rm(path.join(legacyPath, 'workspace'), { recursive: true, force: true }).catch(() => {});
      agent.workspacePath = null;
    }
    agent.memoryMirrorMigration = {
      migratedAt,
      source,
      hash,
      storageMode: 'pvc',
      storageKey: metadata.storageKey,
      clearedLegacyWorkspaceAt: clearRecord.clearedLegacyWorkspaceAt || null,
    };
    return {
      ok: true,
      source,
      hash,
      metadata,
      migration: agent.memoryMirrorMigration,
    };
  }

  return {
    listAgentMemoryMirrorWorkspace,
    materializeAgentMemoryMirror,
    migrateAgentMemoryMirror,
    mirrorPath,
    readAgentMemoryMirrorFile,
    storageKey,
  };
}
