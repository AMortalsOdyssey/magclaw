import { readFile } from 'node:fs/promises';
import { deterministicCleanupMarkdown } from './markdown-document.js';
import { llmConfigFromEnv, llmConfigReady, requestLlmJson } from './llm-client.js';
import { markdownContentHash } from './markdown-oplog.js';
import { safePathWithin } from './path-utils.js';

function maintenancePrompt() {
  return [
    'You are MagClaw Markdown memory maintenance.',
    'Rewrite the document to remove duplicate headings, merge semantically duplicate facts, remove contradicted stale facts, and promote recent or high-value facts.',
    'Preserve useful concrete facts and Markdown structure.',
    'Return only JSON with rewrittenMarkdown, kept, merged, removed, promoted, demoted, and reason.',
  ].join(' ');
}

function validRewrite(value) {
  return value && typeof value === 'object' && typeof value.rewrittenMarkdown === 'string' && value.rewrittenMarkdown.trim();
}

export function createMarkdownMaintenanceManager(deps = {}) {
  const {
    addSystemEvent = () => {},
    ensureAgentWorkspace,
    llmConfig = llmConfigFromEnv(),
    makeId = (prefix) => `${prefix}_${Date.now()}`,
    now = () => new Date().toISOString(),
    persistMarkdownMaintenanceRun = null,
    submitAgentMarkdownOperation,
  } = deps;

  async function persistRun(record = {}) {
    if (typeof persistMarkdownMaintenanceRun !== 'function') return;
    await persistMarkdownMaintenanceRun(record).catch((error) => {
      console.warn(`[markdown-maintenance] run persist failed relPath=${record.relPath || ''} message=${String(error?.message || error).slice(0, 240)}`);
    });
  }

  async function maintainAgentMarkdown(agent, relPath = 'MEMORY.md', options = {}) {
    if (!agent?.id) throw new Error('Agent is required for Markdown maintenance.');
    if (typeof ensureAgentWorkspace !== 'function') throw new Error('ensureAgentWorkspace dependency is required.');
    if (typeof submitAgentMarkdownOperation !== 'function') throw new Error('submitAgentMarkdownOperation dependency is required.');
    const root = await ensureAgentWorkspace(agent);
    const filePath = safePathWithin(root, relPath);
    if (!filePath) throw new Error(`Invalid Markdown maintenance path: ${relPath}`);
    const existing = await readFile(filePath, 'utf8').catch(() => '');
    const beforeHash = markdownContentHash(existing);
    const cleaned = deterministicCleanupMarkdown(existing);
    if (cleaned !== existing) {
      const result = await submitAgentMarkdownOperation(agent, {
        type: 'maintenance_rewrite',
        target: { relPath },
        markdown: cleaned,
        reason: 'deterministic_cleanup',
      }, {
        sourceTrigger: 'markdown_maintenance_deterministic',
        idempotencyKey: `maintenance:deterministic:${relPath}:${now()}`,
      });
      await persistRun({
        id: makeId('mdmaint'),
        workspaceId: String(agent.workspaceId || 'local'),
        agentId: agent.id,
        relPath,
        status: 'completed',
        beforeHash,
        afterHash: result?.afterHash || markdownContentHash(cleaned),
        summary: 'deterministic cleanup',
        createdAt: now(),
        metadata: { mode: 'deterministic' },
      });
    }
    if (!options.semantic) {
      return { ok: true, deterministicChanged: cleaned !== existing, semantic: 'skipped' };
    }
    if (!llmConfigReady(llmConfig)) {
      addSystemEvent('agent_memory_maintenance_skipped', 'Markdown semantic maintenance skipped because global LLM is not configured.', {
        agentId: agent.id,
        relPath,
      });
      await persistRun({
        id: makeId('mdmaint'),
        workspaceId: String(agent.workspaceId || 'local'),
        agentId: agent.id,
        relPath,
        status: 'skipped',
        beforeHash: markdownContentHash(cleaned),
        afterHash: markdownContentHash(cleaned),
        summary: 'semantic maintenance skipped: llm_unconfigured',
        createdAt: now(),
        metadata: { mode: 'semantic', reason: 'llm_unconfigured' },
      });
      return { ok: true, deterministicChanged: cleaned !== existing, semantic: 'llm_unconfigured' };
    }
    const result = await requestLlmJson({
      config: llmConfig,
      system: maintenancePrompt(),
      user: JSON.stringify({
        agent: { id: agent.id, name: agent.name || '' },
        relPath,
        markdown: cleaned,
      }),
      maxTokens: options.maxTokens || 4000,
    });
    if (!validRewrite(result)) {
      addSystemEvent('agent_memory_maintenance_error', 'Markdown semantic maintenance returned invalid JSON.', {
        agentId: agent.id,
        relPath,
      });
      await persistRun({
        id: makeId('mdmaint'),
        workspaceId: String(agent.workspaceId || 'local'),
        agentId: agent.id,
        relPath,
        status: 'failed',
        model: llmConfig.model,
        beforeHash: markdownContentHash(cleaned),
        afterHash: markdownContentHash(cleaned),
        summary: 'semantic maintenance returned invalid JSON',
        createdAt: now(),
        metadata: { mode: 'semantic', reason: 'invalid_output' },
      });
      return { ok: false, deterministicChanged: cleaned !== existing, semantic: 'invalid_output' };
    }
    const applied = await submitAgentMarkdownOperation(agent, {
      type: 'maintenance_rewrite',
      target: { relPath },
      markdown: result.rewrittenMarkdown,
      reason: result.reason || 'semantic_maintenance',
    }, {
      sourceTrigger: 'markdown_maintenance_semantic',
      idempotencyKey: `maintenance:semantic:${relPath}:${now()}`,
      metadata: {
        kept: result.kept || [],
        merged: result.merged || [],
        removed: result.removed || [],
        promoted: result.promoted || [],
        demoted: result.demoted || [],
        model: llmConfig.model,
      },
    });
    await persistRun({
      id: makeId('mdmaint'),
      workspaceId: String(agent.workspaceId || 'local'),
      agentId: agent.id,
      relPath,
      status: 'completed',
      model: llmConfig.model,
      beforeHash: markdownContentHash(cleaned),
      afterHash: applied?.afterHash || markdownContentHash(result.rewrittenMarkdown),
      summary: result.reason || 'semantic maintenance',
      createdAt: now(),
      metadata: {
        mode: 'semantic',
        kept: result.kept || [],
        merged: result.merged || [],
        removed: result.removed || [],
        promoted: result.promoted || [],
        demoted: result.demoted || [],
      },
    });
    addSystemEvent('agent_memory_maintenance', 'Markdown semantic maintenance applied.', {
      agentId: agent.id,
      relPath,
      model: llmConfig.model,
    });
    return { ok: true, deterministicChanged: cleaned !== existing, semantic: 'applied' };
  }

  return {
    maintainAgentMarkdown,
  };
}
