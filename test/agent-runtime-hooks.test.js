import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgentWorkspaceManager } from '../server/agent-workspace.js';

function workspaceManager(tmp) {
  return createAgentWorkspaceManager({
    addSystemEvent: () => {},
    channelAgentIds: () => [],
    getState: () => ({ agents: [] }),
    now: () => '2026-05-21T10:00:00.000Z',
    AGENTS_DIR: path.join(tmp, 'agents'),
    CODEX_HOME_CONFIG_VERSION: 8,
    CODEX_HOME_SHARED_ENTRIES: [],
    CODEX_HOME_STALE_SHARED_ENTRIES: ['hooks.json', 'hooks'],
    MAX_AGENT_WORKSPACE_FILE_BYTES: 1024 * 1024,
    MAX_AGENT_WORKSPACE_TREE_ENTRIES: 300,
    SOURCE_CODEX_HOME: path.join(tmp, 'source-codex-home'),
  });
}

async function pathExists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

test('agent workspace prepares Codex native hooks under a runtime-specific sidecar', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-runtime-hooks-'));
  try {
    const manager = workspaceManager(tmp);
    const agent = { id: 'agt_hooks', name: 'Hook Agent', runtime: 'Codex CLI', runtimeId: 'codex' };

    await manager.ensureAgentWorkspace(agent);

    const agentRoot = manager.agentDataDir(agent);
    const codexHooksJson = path.join(agentRoot, 'workspace', 'runtime-hooks', 'codex', 'hooks.json');
    const codexHooksDir = path.join(agentRoot, 'workspace', 'runtime-hooks', 'codex', 'hooks');
    const exposedHooksJson = path.join(agentRoot, 'codex-home', 'hooks.json');
    const exposedHooksDir = path.join(agentRoot, 'codex-home', 'hooks');

    assert.deepEqual(JSON.parse(await readFile(codexHooksJson, 'utf8')), { hooks: [] });
    assert.equal((await lstat(codexHooksDir)).isDirectory(), true);
    assert.equal(await realpath(exposedHooksJson), await realpath(codexHooksJson));
    assert.equal(await realpath(exposedHooksDir), await realpath(codexHooksDir));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('agent workspace preserves Codex hooks when Claude Code hooks are added later', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-runtime-hooks-'));
  try {
    const manager = workspaceManager(tmp);
    const agent = { id: 'agt_switch', name: 'Switch Agent', runtime: 'Codex CLI', runtimeId: 'codex' };

    await manager.ensureAgentWorkspace(agent);
    const agentRoot = manager.agentDataDir(agent);
    const codexHooksJson = path.join(agentRoot, 'workspace', 'runtime-hooks', 'codex', 'hooks.json');
    await writeFile(codexHooksJson, JSON.stringify({ hooks: [{ name: 'keep-codex-hook' }] }, null, 2));

    agent.runtime = 'Claude Code';
    agent.runtimeId = 'claude-code';
    await manager.prepareAgentRuntimeHooks(agent);

    const claudeSettingsJson = path.join(agentRoot, 'workspace', 'runtime-hooks', 'claude-code', 'settings.json');
    const claudeHooksDir = path.join(agentRoot, 'workspace', 'runtime-hooks', 'claude-code', 'hooks');
    const exposedClaudeSettings = path.join(agentRoot, 'workspace', '.claude', 'settings.json');
    const exposedClaudeHooks = path.join(agentRoot, 'workspace', '.claude', 'hooks');

    assert.deepEqual(JSON.parse(await readFile(codexHooksJson, 'utf8')), { hooks: [{ name: 'keep-codex-hook' }] });
    assert.deepEqual(JSON.parse(await readFile(claudeSettingsJson, 'utf8')), { hooks: {} });
    assert.equal((await lstat(claudeHooksDir)).isDirectory(), true);
    assert.equal(await realpath(exposedClaudeSettings), await realpath(claudeSettingsJson));
    assert.equal(await realpath(exposedClaudeHooks), await realpath(claudeHooksDir));
    assert.equal(await pathExists(path.join(agentRoot, 'workspace', 'runtime-hooks', 'codex', 'hooks.json')), true);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
