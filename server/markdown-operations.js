import { readFile } from 'node:fs/promises';
import {
  appendMarkdownOperationRecord,
  atomicWriteMarkdownFile,
  DEFAULT_MARKDOWN_OPLOG_SEGMENT_MAX_BYTES,
  DEFAULT_MARKDOWN_OPLOG_SEGMENT_MAX_OPS,
  ensureMarkdownDocumentLog,
  findMarkdownOperationByIdempotencyKey,
  markdownContentHash,
  readMarkdownOplogManifest,
  rebuildMarkdownFromOplog,
} from './markdown-oplog.js';
import { applyMarkdownOperation } from './markdown-document.js';
import { normalizeProjectRelPath, safePathWithin } from './path-utils.js';

function cleanRelPath(value) {
  const relPath = normalizeProjectRelPath(value || 'MEMORY.md');
  return relPath || 'MEMORY.md';
}

function cleanOperation(operation = {}) {
  const type = String(operation.type || '').trim();
  if (!type) throw new Error('Markdown operation type is required.');
  return {
    ...operation,
    type,
    target: {
      ...(operation.target || {}),
      relPath: cleanRelPath(operation.target?.relPath || operation.relPath || 'MEMORY.md'),
    },
  };
}

function operationRelPath(operation = {}) {
  return cleanRelPath(operation.target?.relPath || operation.relPath || 'MEMORY.md');
}

function workspaceIdFor(agent) {
  return String(agent?.workspaceId || 'local');
}

function defaultContentFor(agent, relPath, defaultAgentMemory) {
  if (relPath === 'MEMORY.md' && typeof defaultAgentMemory === 'function') return defaultAgentMemory(agent);
  const title = relPath.split('/').pop()?.replace(/\.(md|txt)$/i, '') || 'note';
  return `# ${agent?.name || 'Agent'} ${title}\n`;
}

function idempotencyKeyFor(agent, operation, options = {}) {
  if (options.idempotencyKey) return String(options.idempotencyKey);
  const trigger = String(options.sourceTrigger || 'markdown_operation');
  const relPath = operationRelPath(operation);
  const payload = JSON.stringify(operation);
  return `${workspaceIdFor(agent)}:${agent?.id || 'unknown'}:${relPath}:${trigger}:${markdownContentHash(payload).slice(0, 20)}`;
}

function queueKeyFor(agent, relPath) {
  return [workspaceIdFor(agent), agent?.id || 'unknown', relPath].join(':');
}

export function createMarkdownOperationApplier(deps = {}) {
  const {
    addSystemEvent = () => {},
    defaultAgentMemory = null,
    ensureAgentWorkspace,
    logWarning = (message, meta) => console.warn(message, meta || ''),
    makeId = (prefix) => `${prefix}_${Date.now()}`,
    materializeMarkdownMirror = null,
    now = () => new Date().toISOString(),
    persistMarkdownDocumentIndex = null,
    persistMarkdownOperationIndex = null,
    segmentMaxBytes = DEFAULT_MARKDOWN_OPLOG_SEGMENT_MAX_BYTES,
    segmentMaxOps = DEFAULT_MARKDOWN_OPLOG_SEGMENT_MAX_OPS,
  } = deps;
  const queues = new Map();
  const asyncPersists = new Set();

  function warnAsyncPersistFailure(label, error, meta = {}) {
    const message = `[markdown-applier] ${label} failed relPath=${meta.relPath || ''} message=${String(error?.message || error).slice(0, 240)}`;
    logWarning(message, {
      ...meta,
      error: String(error?.message || error),
    });
    addSystemEvent(`markdown_${label.replace(/\s+/g, '_')}_error`, `${label} failed for ${meta.relPath || 'Markdown document'}.`, {
      ...meta,
      error: String(error?.message || error),
    });
  }

  function queueAsyncPersist(label, fn, meta = {}) {
    let task;
    task = new Promise((resolve) => {
      const timer = setTimeout(resolve, 0);
      timer.unref?.();
    })
      .then(fn)
      .catch((error) => warnAsyncPersistFailure(label, error, meta))
      .finally(() => {
        asyncPersists.delete(task);
      });
    asyncPersists.add(task);
    return task;
  }

  async function flushAsyncPersists() {
    while (asyncPersists.size) {
      await Promise.allSettled([...asyncPersists]);
    }
  }

  async function repairMaterializedFile({ root, relPath, filePath, reason }) {
    const rebuilt = await rebuildMarkdownFromOplog(root, relPath);
    await atomicWriteMarkdownFile(filePath, rebuilt.content);
    addSystemEvent('markdown_oplog_rebuild', `Rebuilt ${relPath} from operation logs.`, {
      relPath,
      reason,
      revision: rebuilt.revision,
      hash: rebuilt.hash,
    });
    return rebuilt.content;
  }

  async function applyNow(agent, rawOperation, options = {}) {
    if (!agent?.id) throw new Error('Agent is required for Markdown operation.');
    if (typeof ensureAgentWorkspace !== 'function') throw new Error('ensureAgentWorkspace dependency is required.');
    const operation = cleanOperation(rawOperation);
    const relPath = operationRelPath(operation);
    const root = await ensureAgentWorkspace(agent);
    const filePath = safePathWithin(root, relPath);
    if (!filePath) throw new Error(`Invalid Markdown target path: ${relPath}`);

    let current = await readFile(filePath, 'utf8').catch(() => defaultContentFor(agent, relPath, defaultAgentMemory));
    await ensureMarkdownDocumentLog({
      root,
      relPath,
      initialContent: current,
      workspaceId: workspaceIdFor(agent),
      agentId: agent.id,
      now,
      segmentMaxBytes,
      segmentMaxOps,
    });

    const idempotencyKey = idempotencyKeyFor(agent, operation, options);
    const existing = await findMarkdownOperationByIdempotencyKey(root, relPath, idempotencyKey);
    if (existing) {
      return {
        ok: true,
        status: 'deduped',
        operationId: existing.operationId,
        revision: existing.revision,
        relPath,
      };
    }

    const manifest = await readMarkdownOplogManifest(root, relPath);
    const beforeHash = markdownContentHash(current);
    if (manifest?.documentHash && beforeHash !== manifest.documentHash) {
      current = await repairMaterializedFile({
        root,
        relPath,
        filePath,
        reason: 'materialized_hash_mismatch',
      });
    }

    const stableBeforeHash = markdownContentHash(current);
    const afterContent = applyMarkdownOperation(current, operation);
    const afterHash = markdownContentHash(afterContent);
    const operationId = options.operationId || makeId('mdop');
    const record = {
      operationId,
      workspaceId: workspaceIdFor(agent),
      agentId: agent.id,
      relPath,
      idempotencyKey,
      operation,
      beforeHash: stableBeforeHash,
      afterHash,
      sourceTrigger: String(options.sourceTrigger || 'markdown_operation'),
      createdAt: now(),
      appliedAt: now(),
      status: 'applied',
      metadata: options.metadata || {},
    };
    const appended = await appendMarkdownOperationRecord({
      root,
      relPath,
      initialContent: current,
      workspaceId: workspaceIdFor(agent),
      agentId: agent.id,
      record,
      now,
      segmentMaxBytes,
      segmentMaxOps,
    });
    await atomicWriteMarkdownFile(filePath, afterContent);

    queueAsyncPersist('markdown_async_persist', async () => {
      let mirrorMetadata = null;
      if (relPath === 'MEMORY.md' && typeof materializeMarkdownMirror === 'function') {
        mirrorMetadata = await Promise.resolve(materializeMarkdownMirror({
          agent,
          workspaceId: workspaceIdFor(agent),
          agentId: agent.id,
          relPath,
          content: afterContent,
          revision: appended.record.revision,
          documentHash: afterHash,
          updatedAt: appended.record.appliedAt,
          record: appended.record,
        })).catch((error) => {
          warnAsyncPersistFailure('mirror persist', error, {
            agentId: agent.id,
            workspaceId: workspaceIdFor(agent),
            relPath,
            operationId,
          });
          return null;
        });
      }

      if (typeof persistMarkdownDocumentIndex === 'function') {
        await Promise.resolve(persistMarkdownDocumentIndex({
          workspaceId: workspaceIdFor(agent),
          agentId: agent.id,
          relPath,
          revision: appended.record.revision,
          documentHash: afterHash,
          currentSegment: appended.record.segmentIndex,
          updatedAt: appended.record.appliedAt,
          metadata: mirrorMetadata && !mirrorMetadata.skipped ? {
            storageMode: mirrorMetadata.storageMode || 'pvc',
            storageKey: mirrorMetadata.storageKey || '',
            bytes: Number(mirrorMetadata.bytes || 0),
            documentHash: mirrorMetadata.documentHash || afterHash,
            revision: Number(mirrorMetadata.revision || appended.record.revision),
            updatedAt: mirrorMetadata.updatedAt || appended.record.appliedAt,
          } : {},
        })).catch((error) => {
          warnAsyncPersistFailure('document index persist', error, {
            agentId: agent.id,
            workspaceId: workspaceIdFor(agent),
            relPath,
            operationId,
          });
        });
      }
      if (typeof persistMarkdownOperationIndex === 'function') {
        await Promise.resolve(persistMarkdownOperationIndex({
          ...appended.record,
          metadata: {
            ...(appended.record.metadata || {}),
            ...(mirrorMetadata && !mirrorMetadata.skipped ? { mirror: mirrorMetadata } : {}),
          },
        })).catch((error) => {
          warnAsyncPersistFailure('operation index persist', error, {
            agentId: agent.id,
            workspaceId: workspaceIdFor(agent),
            relPath,
            operationId,
          });
        });
      }
    }, {
      agentId: agent.id,
      workspaceId: workspaceIdFor(agent),
      relPath,
      operationId,
    });

    addSystemEvent('markdown_operation_applied', `Applied Markdown operation ${operation.type} to ${relPath}.`, {
      agentId: agent.id,
      workspaceId: workspaceIdFor(agent),
      relPath,
      operationId,
      revision: appended.record.revision,
      segmentIndex: appended.record.segmentIndex,
    });
    return {
      ok: true,
      status: 'applied',
      operationId,
      revision: appended.record.revision,
      relPath,
      segmentIndex: appended.record.segmentIndex,
      beforeHash: stableBeforeHash,
      afterHash,
    };
  }

  function submitAgentMarkdownOperation(agent, operation, options = {}) {
    const clean = cleanOperation(operation);
    const relPath = operationRelPath(clean);
    const key = queueKeyFor(agent, relPath);
    const previous = queues.get(key) || Promise.resolve();
    let queued;
    queued = previous
      .catch(() => false)
      .then(() => applyNow(agent, clean, options))
      .catch((error) => {
        addSystemEvent('markdown_operation_error', `Markdown operation failed for ${agent?.name || 'Agent'}: ${error.message}`, {
          agentId: agent?.id || null,
          workspaceId: workspaceIdFor(agent),
          relPath,
          operationType: clean.type,
        });
        throw error;
      })
      .finally(() => {
        if (queues.get(key) === queued) queues.delete(key);
      });
    queues.set(key, queued);
    return queued;
  }

  return {
    applyNow,
    flushAsyncPersists,
    pendingAsyncPersistCount: () => asyncPersists.size,
    pendingQueueCount: () => queues.size,
    submitAgentMarkdownOperation,
  };
}
