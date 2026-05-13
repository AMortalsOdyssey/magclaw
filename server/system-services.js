import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { defaultReleaseNotes, normalizeReleaseNotes } from './release-notes.js';
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

  function records(value) {
    return Array.isArray(value) ? value.filter(Boolean) : [];
  }

  function publicState(req = null) {
    const currentState = getState() || {};
    const cloud = typeof publicCloudState === 'function' ? publicCloudState(req) : undefined;
    const currentHumanId = cloud?.auth?.currentMember?.humanId || null;
    if (cloud?.auth?.currentUser && !cloud?.auth?.currentMember) {
      return {
        ...currentState,
        channels: [],
        dms: [],
        messages: [],
        replies: [],
        tasks: [],
        agents: [],
        computers: [],
        humans: [],
        routeEvents: [],
        systemNotifications: [],
        settings: publicSettings(cloud),
        connection: publicConnection(),
        cloud,
        releaseNotes: publicReleaseNotes(),
        runtime: runtimeSnapshot(),
        runningRunIds: [],
      };
    }
    const channels = records(currentState.channels);
    const dms = records(currentState.dms);
    const messages = records(currentState.messages);
    const replies = records(currentState.replies);
    const visibleDms = currentHumanId
      ? dms.filter((dm) => records(dm.participantIds).includes(currentHumanId))
      : dms;
    const visibleDmIds = new Set(visibleDms.map((dm) => dm.id));
    return {
      ...currentState,
      settings: publicSettings(cloud),
      channels: channels.filter((channel) => !channel.archived),
      dms: visibleDms,
      messages: messages.filter((message) => message.spaceType !== 'dm' || visibleDmIds.has(message.spaceId)),
      replies: replies.filter((reply) => reply.spaceType !== 'dm' || visibleDmIds.has(reply.spaceId)),
      tasks: records(currentState.tasks),
      agents: records(currentState.agents),
      computers: records(currentState.computers),
      humans: records(currentState.humans),
      routeEvents: records(currentState.routeEvents),
      systemNotifications: records(currentState.systemNotifications),
      connection: publicConnection(),
      cloud,
      releaseNotes: publicReleaseNotes(),
      runtime: runtimeSnapshot(),
      runningRunIds: [...runningProcesses.keys()],
    };
  }
  
  function workspaceFanoutApiConfig(cloud = null) {
    return cloud?.workspace?.metadata?.fanoutApi || null;
  }

  function publicSettings(cloud = null) {
    const fanoutApi = normalizeFanoutApiConfig(workspaceFanoutApiConfig(cloud) || state?.settings?.fanoutApi || {});
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
  
  function updateFanoutApiConfig(body = {}, workspace = null) {
    const current = normalizeFanoutApiConfig(workspace?.metadata?.fanoutApi || state.settings?.fanoutApi || {});
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
    const normalized = normalizeFanoutApiConfig(next);
    state.settings.fanoutApi = normalized;
    if (workspace) {
      workspace.metadata = {
        ...(workspace.metadata || {}),
        fanoutApi: normalized,
      };
      workspace.updatedAt = now();
    }
    state.router = {
      ...(state.router || {}),
      mode: fanoutApiConfigured() ? 'llm_fanout' : 'rules_fallback',
      fallback: 'rules',
      cardSource: 'workspace_markdown',
    };
    delete state.router.brainAgentId;
    return normalized;
  }
  
  function runtimeSnapshot() {
    const daemonPackageVersion = localDaemonPackageVersion();
    return {
      node: process.version,
      platform: `${os.platform()} ${os.arch()}`,
      host: os.hostname(),
      webPackageName: '@magclaw/web',
      webPackageVersion: localWebPackageVersion(),
      webLatestVersion: latestWebPackageVersion(localWebPackageVersion()),
      codexPath: state?.settings?.codexPath || defaultCodexPath(),
      daemonPackageName: '@magclaw/daemon',
      daemonPackageVersion,
      daemonLatestVersion: latestDaemonPackageVersion(daemonPackageVersion),
    };
  }

  function publicReleaseNotes() {
    const defaults = defaultReleaseNotes({ root: ROOT });
    const normalized = normalizeReleaseNotes(state?.releaseNotes, defaults);
    normalized.web.currentVersion = process.env.MAGCLAW_WEB_VERSION || localWebPackageVersion() || normalized.web.currentVersion;
    normalized.web.latestVersion = latestWebPackageVersion(normalized.web.currentVersion);
    normalized.daemon.currentVersion = localDaemonPackageVersion() || normalized.daemon.currentVersion;
    normalized.daemon.latestVersion = latestDaemonPackageVersion(normalized.daemon.currentVersion);
    return normalized;
  }

  function localWebPackageVersion() {
    try {
      const pkg = JSON.parse(readFileSync(path.join(ROOT, 'web', 'package.json'), 'utf8'));
      return String(pkg.version || '');
    } catch {
      return '';
    }
  }

  function latestWebPackageVersion(fallback = '') {
    return String(
      process.env.MAGCLAW_WEB_LATEST_VERSION
      || state?.settings?.webVersionControl?.latestVersion
      || state?.settings?.webLatestVersion
      || fallback
      || '',
    ).trim();
  }

  function localDaemonPackageVersion() {
    const envVersion = String(process.env.MAGCLAW_DAEMON_VERSION || '').trim();
    if (envVersion) return envVersion;
    try {
      const pkg = JSON.parse(readFileSync(path.join(ROOT, 'daemon', 'package.json'), 'utf8'));
      return String(pkg.version || '');
    } catch {
      return '';
    }
  }

  function latestDaemonPackageVersion(fallback = '') {
    return String(
      process.env.MAGCLAW_DAEMON_LATEST_VERSION
      || state?.settings?.daemonVersionControl?.latestVersion
      || state?.settings?.daemonLatestVersion
      || fallback
      || '',
    ).trim();
  }
  
  async function getRuntimeInfo() {
    const codexPath = await resolveCodexPath();
    const version = await execText(codexPath, ['--version']).catch((error) => error.message);
    return {
      ...runtimeSnapshot(),
      codexVersion: version.trim(),
      port: PORT,
      dataDir: DATA_DIR,
    };
  }

  function defaultCodexPath() {
    const macAppBinary = '/Applications/Codex.app/Contents/Resources/codex';
    if (existsSync(macAppBinary)) return macAppBinary;
    return 'codex';
  }

  async function resolveCodexPath() {
    const configured = state.settings?.codexPath || '';
    const candidates = [configured, defaultCodexPath(), 'codex']
      .map((item) => String(item || '').trim())
      .filter(Boolean);
    for (const candidate of [...new Set(candidates)]) {
      try {
        await execText(candidate, ['--version']);
        return candidate;
      } catch {
        // Keep trying known fallbacks so a stale CODEX_PATH does not hide Codex.app.
      }
    }
    return configured || defaultCodexPath();
  }

  function executableCandidates(command) {
    return [...new Set([
      command,
      path.join(path.dirname(process.execPath), command),
      path.join(os.homedir(), '.local', 'bin', command),
    ].filter(Boolean))];
  }

  async function resolveCommandVersion(command) {
    let lastError = null;
    for (const candidate of executableCandidates(command)) {
      try {
        return {
          path: candidate,
          version: (await execText(candidate, ['--version'])).trim(),
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error(`${command} was not found`);
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
      const codexPath = await resolveCodexPath();
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
      const claude = await resolveCommandVersion('claude');
      runtimes.push({
        id: 'claude-code',
        name: 'Claude Code',
        path: claude.path,
        version: claude.version,
        installed: true,
        models: ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5-20251001'],
        defaultModel: 'claude-sonnet-4-6',
      });
    } catch {
      runtimes.push({ id: 'claude-code', name: 'Claude Code', installed: false });
    }
  
    // Kimi CLI
    try {
      const kimi = await resolveCommandVersion('kimi');
      runtimes.push({
        id: 'kimi',
        name: 'Kimi CLI',
        path: kimi.path,
        version: kimi.version,
        installed: true,
        createSupported: false,
        models: ['kimi-k2-0905', 'kimi-k2-turbo-preview'],
        defaultModel: 'kimi-k2-0905',
      });
    } catch {
      runtimes.push({ id: 'kimi', name: 'Kimi CLI', installed: false, createSupported: false });
    }

    // Cursor CLI
    try {
      let cursorPath = 'cursor-agent';
      let cursorVersion = '';
      try {
        const cursor = await resolveCommandVersion(cursorPath);
        cursorPath = cursor.path;
        cursorVersion = cursor.version;
      } catch {
        cursorPath = 'cursor';
        const cursor = await resolveCommandVersion(cursorPath);
        cursorPath = cursor.path;
        cursorVersion = cursor.version;
      }
      runtimes.push({
        id: 'cursor',
        name: 'Cursor CLI',
        path: cursorPath,
        version: cursorVersion,
        installed: true,
        createSupported: false,
        models: ['auto'],
        defaultModel: 'auto',
      });
    } catch {
      runtimes.push({ id: 'cursor', name: 'Cursor CLI', installed: false, createSupported: false });
    }

    // Gemini CLI
    try {
      const gemini = await resolveCommandVersion('gemini');
      runtimes.push({
        id: 'gemini',
        name: 'Gemini CLI',
        path: gemini.path,
        version: gemini.version,
        installed: true,
        createSupported: false,
        models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
        defaultModel: 'gemini-2.5-pro',
      });
    } catch {
      runtimes.push({ id: 'gemini', name: 'Gemini CLI', installed: false, createSupported: false });
    }

    // Copilot CLI
    try {
      const copilot = await resolveCommandVersion('copilot');
      runtimes.push({
        id: 'copilot',
        name: 'Copilot CLI',
        path: copilot.path,
        version: copilot.version,
        installed: true,
        createSupported: false,
        models: ['gpt-5', 'gpt-4.1', 'claude-sonnet-4.5'],
        defaultModel: 'gpt-5',
      });
    } catch {
      runtimes.push({ id: 'copilot', name: 'Copilot CLI', installed: false, createSupported: false });
    }

    // OpenCode
    try {
      const openCode = await resolveCommandVersion('opencode');
      runtimes.push({
        id: 'opencode',
        name: 'OpenCode',
        path: openCode.path,
        version: openCode.version,
        installed: true,
        createSupported: false,
        models: ['gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'],
        defaultModel: 'gpt-4o',
      });
    } catch {
      runtimes.push({ id: 'opencode', name: 'OpenCode', installed: false, createSupported: false });
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
