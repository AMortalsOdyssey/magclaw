import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeCloudUrl, normalizeFanoutApiConfig, publicApiKeyPreview } from './runtime-config.js';

// System/runtime and local-project services.
// HTTP route modules use this for public state shaping, installed-runtime
// detection, the native folder picker, and project folder registration.
export function createSystemServices(deps) {
  const {
    addSystemEvent,
    broadcastState,
    fanoutApiConfigured,
    getState,
    httpError,
    makeId,
    now,
    persistState,
    publicCloudState,
    projectsForSpace,
    runningProcesses,
    selectedDefaultSpaceId,
    DATA_DIR,
    PORT,
    ROOT,
  } = deps;
  const state = new Proxy({}, {
    get(_target, prop) { return getState()[prop]; },
    set(_target, prop, value) { getState()[prop] = value; return true; },
  });

  function publicState(req = null) {
    const currentState = getState() || {};
    return {
      ...currentState,
      settings: publicSettings(),
      channels: (currentState.channels || []).filter((channel) => !channel.archived),
      connection: publicConnection(),
      cloud: typeof publicCloudState === 'function' ? publicCloudState(req) : undefined,
      runtime: runtimeSnapshot(),
      runningRunIds: [...runningProcesses.keys()],
    };
  }
  
  function publicSettings() {
    const fanoutApi = normalizeFanoutApiConfig(state?.settings?.fanoutApi || {});
    const { apiKey, ...settings } = state?.settings || {};
    void apiKey;
    return {
      ...settings,
      fanoutApi: {
        enabled: fanoutApi.enabled,
        baseUrl: fanoutApi.baseUrl,
        model: fanoutApi.model,
        fallbackModel: fanoutApi.fallbackModel,
        timeoutMs: fanoutApi.timeoutMs,
        forceKeywords: fanoutApi.forceKeywords,
        hasApiKey: Boolean(fanoutApi.apiKey),
        apiKeyPreview: publicApiKeyPreview(fanoutApi.apiKey),
        configured: fanoutApiConfigured(fanoutApi),
      },
    };
  }
  
  function publicConnection() {
    const { cloudToken, ...connection } = state?.connection || {};
    return {
      ...connection,
      hasControlPlane: Boolean(state?.connection?.controlPlaneUrl),
      hasRelay: Boolean(state?.connection?.relayUrl),
      hasCloudToken: Boolean(cloudToken || process.env.MAGCLAW_CLOUD_TOKEN),
    };
  }
  
  function updateFanoutApiConfig(body = {}) {
    const current = normalizeFanoutApiConfig(state.settings?.fanoutApi || {});
    const next = {
      ...current,
      enabled: body.enabled !== undefined ? Boolean(body.enabled) : current.enabled,
      baseUrl: body.baseUrl !== undefined ? normalizeCloudUrl(body.baseUrl || '') : current.baseUrl,
      model: body.model !== undefined ? String(body.model || '').trim() : current.model,
      fallbackModel: body.fallbackModel !== undefined ? String(body.fallbackModel || '').trim() : current.fallbackModel,
      timeoutMs: body.timeoutMs !== undefined ? Number(body.timeoutMs) : current.timeoutMs,
      forceKeywords: body.forceKeywords !== undefined ? body.forceKeywords : current.forceKeywords,
    };
    if (body.clearApiKey === true) {
      next.apiKey = '';
    } else if (typeof body.apiKey === 'string' && body.apiKey.trim()) {
      next.apiKey = body.apiKey.trim();
    }
    state.settings.fanoutApi = normalizeFanoutApiConfig(next);
    state.router = {
      ...(state.router || {}),
      mode: fanoutApiConfigured() ? 'llm_fanout' : 'rules_fallback',
      brainAgentId: null,
      fallback: 'rules',
      cardSource: 'workspace_markdown',
    };
    return state.settings.fanoutApi;
  }
  
  function runtimeSnapshot() {
    return {
      node: process.version,
      platform: `${os.platform()} ${os.arch()}`,
      host: os.hostname(),
      codexPath: state?.settings?.codexPath || 'codex',
    };
  }
  
  async function getRuntimeInfo() {
    const codexPath = state.settings.codexPath || 'codex';
    const version = await execText(codexPath, ['--version']).catch((error) => error.message);
    return {
      ...runtimeSnapshot(),
      codexVersion: version.trim(),
      port: PORT,
      dataDir: DATA_DIR,
    };
  }
  
  async function getCodexModels(codexPath) {
    try {
      const output = await execText(codexPath, ['debug', 'models']);
      const data = JSON.parse(output);
      const models = [];
      let defaultModel = null;
      let reasoningEfforts = [];
  
      for (const m of data.models || []) {
        if (m.visibility === 'list') {
          models.push({
            slug: m.slug,
            name: m.display_name || m.slug,
          });
          if (!defaultModel) {
            defaultModel = m.slug;
            reasoningEfforts = (m.supported_reasoning_levels || []).map(r => r.effort);
          }
        }
      }
      return { models, defaultModel, reasoningEfforts };
    } catch {
      return {
        models: [{ slug: 'gpt-5.5', name: 'GPT-5.5' }],
        defaultModel: 'gpt-5.5',
        reasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
      };
    }
  }
  
  async function detectInstalledRuntimes() {
    const runtimes = [];
  
    // Codex CLI
    try {
      const codexPath = state.settings.codexPath || 'codex';
      const version = await execText(codexPath, ['--version']);
      const { models, defaultModel, reasoningEfforts } = await getCodexModels(codexPath);
      runtimes.push({
        id: 'codex',
        name: 'Codex CLI',
        path: codexPath,
        version: version.trim(),
        installed: true,
        models: models.map(m => m.slug),
        modelNames: models,
        defaultModel,
        reasoningEffort: reasoningEfforts,
        defaultReasoningEffort: 'medium',
      });
    } catch {
      runtimes.push({ id: 'codex', name: 'Codex CLI', installed: false });
    }
  
    // Claude Code
    try {
      const claudeVersion = await execText('claude', ['--version']);
      runtimes.push({
        id: 'claude-code',
        name: 'Claude Code',
        path: 'claude',
        version: claudeVersion.trim(),
        installed: true,
        models: ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5-20251001'],
        defaultModel: 'claude-sonnet-4-6',
      });
    } catch {
      runtimes.push({ id: 'claude-code', name: 'Claude Code', installed: false });
    }
  
    // OpenCode
    try {
      const openCodeVersion = await execText('opencode', ['--version']);
      runtimes.push({
        id: 'opencode',
        name: 'OpenCode',
        path: 'opencode',
        version: openCodeVersion.trim(),
        installed: true,
        models: ['gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'],
        defaultModel: 'gpt-4o',
      });
    } catch {
      runtimes.push({ id: 'opencode', name: 'OpenCode', installed: false });
    }
  
    // Goose
    try {
      const gooseVersion = await execText('goose', ['--version']);
      runtimes.push({
        id: 'goose',
        name: 'Goose',
        path: 'goose',
        version: gooseVersion.trim(),
        installed: true,
        models: ['gpt-4o', 'claude-3-opus', 'claude-3-sonnet'],
        defaultModel: 'gpt-4o',
      });
    } catch {
      runtimes.push({ id: 'goose', name: 'Goose', installed: false });
    }
  
    // Aider
    try {
      const aiderVersion = await execText('aider', ['--version']);
      runtimes.push({
        id: 'aider',
        name: 'Aider',
        path: 'aider',
        version: aiderVersion.trim(),
        installed: true,
        models: ['gpt-4o', 'claude-3-opus', 'claude-3-sonnet', 'deepseek-coder'],
        defaultModel: 'gpt-4o',
      });
    } catch {
      runtimes.push({ id: 'aider', name: 'Aider', installed: false });
    }
  
    return runtimes;
  }
  
  function execText(command, args) {
    return new Promise((resolve, reject) => {
      execFile(command, args, { timeout: 10_000 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout);
      });
    });
  }
  
  function execFileResult(command, args, options = {}) {
    return new Promise((resolve) => {
      execFile(command, args, options, (error, stdout, stderr) => {
        resolve({
          code: typeof error?.code === 'number' ? error.code : 0,
          signal: error?.signal || null,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error,
        });
      });
    });
  }
  
  function appleScriptString(value) {
    return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  
  async function pickFolderPath(defaultPath = '') {
    if (Object.prototype.hasOwnProperty.call(process.env, 'MAGCLAW_PICK_FOLDER_PATH')) {
      const picked = String(process.env.MAGCLAW_PICK_FOLDER_PATH || '').trim();
      return picked ? path.resolve(picked) : null;
    }
    if (process.platform !== 'darwin') {
      throw httpError(501, 'Native folder picker is currently available on macOS only.');
    }
  
    let defaultLocation = '';
    const candidate = path.resolve(String(defaultPath || state.settings?.defaultWorkspace || ROOT));
    try {
      const info = await stat(candidate);
      defaultLocation = info.isDirectory() ? candidate : path.dirname(candidate);
    } catch {
      defaultLocation = ROOT;
    }
  
    const args = [
      '-e', `set defaultFolder to POSIX file ${appleScriptString(defaultLocation)} as alias`,
      '-e', 'try',
      '-e', '  set pickedFolder to choose folder with prompt "Open Project Folder" default location defaultFolder',
      '-e', '  POSIX path of pickedFolder',
      '-e', 'on error number -128',
      '-e', '  return ""',
      '-e', 'end try',
    ];
    const result = await execFileResult('osascript', args);
    if (result.error && result.code !== 0) {
      throw httpError(500, result.stderr.trim() || result.error.message || 'Folder picker failed.');
    }
    const picked = result.stdout.trim();
    return picked ? path.resolve(picked) : null;
  }
  
  async function addProjectFolder({ rawPath, name = '', spaceType = 'channel', spaceId = '' }) {
    const normalizedSpaceType = spaceType === 'dm' ? 'dm' : 'channel';
    const normalizedSpaceId = String(spaceId || selectedDefaultSpaceId(normalizedSpaceType));
    const cleanPath = String(rawPath || '').trim();
    if (!cleanPath) throw httpError(400, 'Project folder path is required.');
    const projectPath = path.resolve(cleanPath);
  
    let info;
    try {
      info = await stat(projectPath);
    } catch (error) {
      addSystemEvent('project_add_failed', `Project folder not found: ${projectPath}`, { error: error.message });
      throw httpError(404, 'Project folder was not found on the Magclaw server.');
    }
    if (!info.isDirectory()) throw httpError(400, 'Project path must be a directory.');
  
    const existing = state.projects.find((project) => (
      project.spaceType === normalizedSpaceType && project.spaceId === normalizedSpaceId && project.path === projectPath
    ));
    if (existing) {
      return { project: existing, projects: projectsForSpace(normalizedSpaceType, normalizedSpaceId), created: false };
    }
  
    const project = {
      id: makeId('prj'),
      name: String(name || path.basename(projectPath) || 'Project').trim().slice(0, 80),
      path: projectPath,
      spaceType: normalizedSpaceType,
      spaceId: normalizedSpaceId,
      createdAt: now(),
      updatedAt: now(),
    };
    state.projects.push(project);
    addSystemEvent('project_added', `Project folder added: ${project.name}`, {
      projectId: project.id,
      spaceType: normalizedSpaceType,
      spaceId: normalizedSpaceId,
    });
    await persistState();
    broadcastState();
    return { project, projects: projectsForSpace(normalizedSpaceType, normalizedSpaceId), created: true };
  }

  return {
    addProjectFolder,
    detectInstalledRuntimes,
    execFileResult,
    execText,
    getRuntimeInfo,
    pickFolderPath,
    publicConnection,
    publicSettings,
    publicState,
    runtimeSnapshot,
    updateFanoutApiConfig,
  };
}
