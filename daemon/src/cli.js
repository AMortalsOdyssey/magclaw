import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, copyFile, cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PROFILE = 'default';
export const DEFAULT_SERVER_URL = 'http://127.0.0.1:6543';
const DEFAULT_DAEMON_HEARTBEAT_MS = 25_000;
const DEFAULT_DAEMON_INBOUND_WATCHDOG_MS = 70_000;
const DEFAULT_DAEMON_RECONNECT_MIN_MS = 1_000;
const DEFAULT_DAEMON_RECONNECT_MAX_MS = 30_000;
const DEFAULT_MAX_CONCURRENT_AGENT_STARTS = 5;
const DEFAULT_AGENT_START_INTERVAL_MS = 500;
const DEFAULT_TRAJECTORY_COALESCE_MS = 350;
const DELIVERY_LEDGER_LIMIT = 500;
const DELIVERY_LEDGER_RETENTION_MS = 1000 * 60 * 60 * 24 * 7;
const CODEX_PERMISSION_REQUEST_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
]);
const CODEX_SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const MCP_BRIDGE_PATH = path.join(PACKAGE_ROOT, 'src', 'mcp-bridge.js');
const PACKAGE_JSON = (() => {
  try {
    return JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
})();
export const DAEMON_VERSION = String(PACKAGE_JSON.version || '0.0.0');
const SOURCE_CODEX_HOME = path.resolve(process.env.MAGCLAW_CODEX_HOME_SOURCE || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const CODEX_HOME_SHARED_ENTRIES = ['auth.json', 'plugins', 'vendor_imports'];
export const CAPABILITIES = [
  'agent:start',
  'agent:restart',
  'agent:deliver',
  'agent:stop',
  'agent:skills:list',
  'daemon:upgrade',
  'daemon:release_notice',
  'machine:runtime_models:detect',
];

function now() {
  return new Date().toISOString();
}

function localTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-') + ' ' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join(':');
}

export function formatDaemonLogLine(level, category, message, date = new Date()) {
  const safeLevel = String(level || 'info').toUpperCase();
  const safeCategory = String(category || 'daemon').toUpperCase();
  return `${localTimestamp(date)} ${safeLevel} ${safeCategory} ${String(message || '')}`;
}

function daemonLog(level, category, message) {
  const line = formatDaemonLogLine(level, category, message);
  if (level === 'error') {
    console.error(line);
  } else if (level === 'warning' || level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

function logInfo(category, message) {
  daemonLog('info', category, message);
}

function logWarning(category, message) {
  daemonLog('warning', category, message);
}

function logError(category, message) {
  daemonLog('error', category, message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function runtimeCommandHasPathSeparator(command) {
  return /[\\/]/.test(String(command || ''));
}

export function runtimeCommandNeedsShell(command, platform = process.platform) {
  const basename = String(command || '').split(/[\\/]/).pop() || '';
  return platform === 'win32' && /\.(cmd|bat)$/i.test(basename);
}

function envInteger(env, name, fallback, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  const parsed = Number(env?.[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

export function daemonConversationLaneKey({ workspaceId = 'local', message = {}, spaceType = '', spaceId = '', parentMessageId = null } = {}) {
  const kind = String(spaceType || message?.spaceType || 'channel') === 'dm' ? 'dm' : 'channel';
  const workspace = String(workspaceId || message?.workspaceId || 'local').trim() || 'local';
  const targetSpaceId = String(spaceId || message?.spaceId || (kind === 'dm' ? 'dm' : 'chan_all')).trim();
  const parent = String(parentMessageId || message?.parentMessageId || '').trim();
  return parent
    ? `${kind}:${workspace}:${targetSpaceId}:thread:${parent}`
    : `${kind}:${workspace}:${targetSpaceId}:top`;
}

export function daemonAgentSessionMapKey(agentId, sessionKey) {
  return `${String(agentId || 'agent').trim()}:${String(sessionKey || 'default').trim()}`;
}

function codexApprovalPolicy(env = process.env) {
  const value = String(env.MAGCLAW_CODEX_APPROVAL_POLICY || env.CODEX_APPROVAL_POLICY || 'never').trim();
  return value || 'never';
}

function codexSandbox(env = process.env) {
  const value = String(env.MAGCLAW_CODEX_SANDBOX || env.CODEX_SANDBOX || 'danger-full-access').trim();
  return CODEX_SANDBOX_MODES.has(value) ? value : 'danger-full-access';
}

function isCodexPermissionRequest(method) {
  return CODEX_PERMISSION_REQUEST_METHODS.has(String(method || ''));
}

function codexPermissionDeclineResult(method) {
  if (String(method || '') === 'item/permissions/requestApproval') {
    return { permissions: {} };
  }
  return { decision: 'decline' };
}

function summarizeCodexPermissionRequest(method, params = {}) {
  const summary = {
    method: String(method || ''),
  };
  if (typeof params.command === 'string' && params.command.trim()) {
    summary.commandPreview = params.command.replace(/\s+/g, ' ').trim().slice(0, 300);
  }
  if (typeof params.cwd === 'string' && params.cwd.trim()) {
    summary.cwd = params.cwd.slice(0, 500);
  }
  if (typeof params.reason === 'string' && params.reason.trim()) {
    summary.reason = params.reason.replace(/\s+/g, ' ').trim().slice(0, 300);
  }
  const permissions = params.permissions && typeof params.permissions === 'object' && !Array.isArray(params.permissions)
    ? Object.keys(params.permissions)
    : [];
  if (permissions.length) summary.permissionKeys = permissions.slice(0, 20);
  const changes = Array.isArray(params.changes)
    ? params.changes.map((item) => String(item?.path || item?.uri || '').trim()).filter(Boolean).slice(0, 10)
    : [];
  if (changes.length) summary.paths = changes;
  return summary;
}

const BASE_ALLOWED_OPERATIONS = [
  '读写 Agent workspace、用户明确给出的项目路径，以及任务相关的临时文件。',
  '执行常规开发命令：git status/fetch/pull/clone、安装依赖、运行测试/构建、启动本地服务、查看日志和只读诊断。',
  '在不触达生产环境的前提下操作测试环境、测试流水线和本地验证流程。',
];

const BASE_CONFIRMATION_REQUIRED = [
  '删除整个项目目录、批量删除用户文件、覆盖不可恢复内容，或执行 rm -rf 这类破坏性命令。',
  'git reset --hard、强推、回滚、取消/终止正在运行的任务或流水线。',
  '生产部署、test+prod 无法拆分的流水线、生产升级、部署配置变更。',
  '数据库迁移/清库/批量写入、sudo、系统配置、权限/所有权修改、密钥/cookie/token 处理。',
];

function cleanPermissionText(value, limit = 260) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normalizeAgentPermissionGrants(grants = []) {
  return (Array.isArray(grants) ? grants : [])
    .filter((grant) => grant && typeof grant === 'object' && grant.kind)
    .map((grant) => ({
      kind: String(grant.kind),
      summary: cleanPermissionText(grant.summary),
      allowed: [...new Set((Array.isArray(grant.allowed) ? grant.allowed : []).map((item) => cleanPermissionText(item)).filter(Boolean))],
      requiresConfirmation: [...new Set((Array.isArray(grant.requiresConfirmation) ? grant.requiresConfirmation : []).map((item) => cleanPermissionText(item)).filter(Boolean))],
    }));
}

function renderAgentPermissionGuidance(agent = {}) {
  const grants = normalizeAgentPermissionGrants(agent.permissionGrants);
  const lines = [
    'Operation permission profile:',
    '- 默认允许常规开发操作：' + BASE_ALLOWED_OPERATIONS.join(' '),
    '- 高风险动作必须先确认：' + BASE_CONFIRMATION_REQUIRED.join(' '),
    '- 固定确认句：要求用户回复 `确认执行 <动作/路径>` 或同等明确确认后，再执行对应高风险动作。',
    '- 不要因为需要确认就停止任务；先说明影响、等待用户确认，确认后继续完成剩余工作。',
  ];
  if (grants.length) {
    lines.push('- 已持久授权的默认操作：');
    for (const grant of grants) {
      lines.push(`  - ${grant.summary}${grant.allowed.length ? ` 可直接执行：${grant.allowed.join(' ')}` : ''}${grant.requiresConfirmation.length ? ` 仍需确认：${grant.requiresConfirmation.join(' ')}` : ''}`);
    }
  } else {
    lines.push('- 当前没有额外持久授权；按默认开发权限和高风险确认边界执行。');
  }
  return lines.join('\n');
}

function remoteAgentStandingPrompt(agent = {}) {
  return [
    `You are ${agent.name || agent.id || 'a MagClaw remote agent'}, a MagClaw agent running on this local computer for real work.`,
    agent.runtime ? `Runtime: ${agent.runtime}` : '',
    agent.description ? `Agent description: ${cleanPermissionText(agent.description, 300)}` : '',
    '',
    renderAgentPermissionGuidance(agent),
    '',
    'Use MagClaw MCP tools for conversation, memory, tasks, reminders, and history. Use shell/file tools for real local work when the user asks for concrete execution.',
    'Keep durable preferences and permission boundaries in MagClaw memory through write_memory when the user grants or changes them.',
    'Do not expose machine tokens, secrets, cookies, or private credentials in chat, docs, logs, or commits.',
  ].filter(Boolean).join('\n');
}

function commandLooksHighRisk(command) {
  const value = String(command || '').toLowerCase();
  if (!value) return false;
  return [
    /\bsudo\b/,
    /\brm\s+(-[a-z]*r[a-z]*f|-rf|-fr)\b/,
    /\bgit\s+reset\s+--hard\b/,
    /\bgit\s+push\b.*(--force|-f\b)/,
    /\b(drop\s+database|truncate\s+table|delete\s+from)\b/,
    /\b(terraform|tofu)\s+(apply|destroy)\b/,
    /\bhelm\s+(upgrade|rollback|delete|uninstall)\b/,
    /\bkubectl\s+(delete|apply|replace|rollout|scale|patch)\b/,
    /(生产|prod|production).{0,30}(部署|发布|升级|回滚|deploy|release|upgrade|rollback)/,
    /(部署|发布|升级|回滚|deploy|release|upgrade|rollback).{0,30}(生产|prod|production)/,
    /(取消|终止|terminate|cancel).{0,30}(流水线|pipeline|部署|deploy)/,
  ].some((pattern) => pattern.test(value));
}

function fileChangeLooksHighRisk(params = {}) {
  const changes = Array.isArray(params.changes) ? params.changes : [];
  return changes.some((change) => {
    const action = String(change?.action || change?.kind || change?.type || '').toLowerCase();
    const filePath = String(change?.path || change?.uri || '');
    if (/(delete|remove|unlink|rmdir)/.test(action)) return true;
    if (/\/(\.ssh|\.gnupg|Library\/Keychains)\b/.test(filePath)) return true;
    return false;
  });
}

function codexPermissionDecision(method, params = {}) {
  const name = String(method || '');
  let highRisk = false;
  if (name === 'item/commandExecution/requestApproval') highRisk = commandLooksHighRisk(params.command);
  if (name === 'item/fileChange/requestApproval') highRisk = fileChangeLooksHighRisk(params);
  if (highRisk) {
    return {
      decision: 'decline',
      reason: 'high_risk_requires_user_confirmation',
      result: name === 'item/permissions/requestApproval' ? { permissions: {} } : { decision: 'decline' },
    };
  }
  if (name === 'item/permissions/requestApproval') {
    return {
      decision: 'approve',
      reason: 'default_development_access',
      result: { permissions: params.permissions && typeof params.permissions === 'object' ? params.permissions : {} },
    };
  }
  return {
    decision: 'approve',
    reason: 'default_development_access',
    result: { decision: 'approve' },
  };
}

function safeProfileName(value) {
  const name = String(value || DEFAULT_PROFILE).trim() || DEFAULT_PROFILE;
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80) || DEFAULT_PROFILE;
}

function safeFilePart(value) {
  const name = String(value || '').trim() || 'item';
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120) || 'item';
}

function daemonRoot(env = process.env) {
  return path.resolve(env.MAGCLAW_DAEMON_HOME || path.join(os.homedir(), '.magclaw', 'daemon'));
}

function rootLockPaths(env = process.env) {
  const root = daemonRoot(env);
  return {
    runDir: path.join(root, 'run'),
    lockFile: path.join(root, 'run', 'daemon.lock'),
  };
}

export function profilePaths(profile = DEFAULT_PROFILE, env = process.env) {
  const profileName = safeProfileName(profile);
  const dir = path.join(daemonRoot(env), 'profiles', profileName);
  return {
    profile: profileName,
    dir,
    config: path.join(dir, 'config.json'),
    owner: path.join(dir, 'owner.json'),
    lockFile: path.join(dir, 'run', 'daemon.lock'),
    runDir: path.join(dir, 'run'),
    logDir: path.join(dir, 'logs'),
    agentsDir: path.join(dir, 'agents'),
    deliveryLedger: path.join(dir, 'delivery-ledger.json'),
    releaseNotices: path.join(dir, 'release-notices.json'),
    service: path.join(dir, 'service.json'),
    upgradeHandoff: path.join(dir, 'upgrade-handoff.json'),
  };
}

function machineFingerprintValue() {
  return `mfp_${crypto.createHash('sha256')
    .update([
      os.hostname(),
      os.platform(),
      os.arch(),
      os.homedir(),
    ].join('|'))
    .digest('hex')}`;
}

export async function ensureMachineFingerprint(profile = DEFAULT_PROFILE, env = process.env) {
  const paths = profilePaths(profile, env);
  const existing = await readJsonFile(paths.owner, null);
  if (existing?.fingerprint) {
    return {
      ...existing,
      profile: paths.profile,
    };
  }
  const owner = {
    profile: paths.profile,
    fingerprint: machineFingerprintValue(),
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    createdAt: now(),
  };
  await writeJsonFile(paths.owner, owner);
  return owner;
}

function pidIsRunning(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    if (process.platform !== 'win32') {
      const status = spawnSync('ps', ['-p', String(value), '-o', 'stat='], {
        encoding: 'utf8',
        timeout: 1000,
      });
      const state = String(status.stdout || '').trim();
      if (status.status === 0 && /^Z/i.test(state)) return false;
    }
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function activeLockFile(lockFile, fallback = {}) {
  if (!existsSync(lockFile)) return null;
  const lock = await readJsonFile(lockFile, null);
  if (lock?.pid && pidIsRunning(lock.pid)) {
    return {
      ...fallback,
      ...lock,
      lockFile,
    };
  }
  await rm(lockFile, { force: true }).catch(() => {});
  return null;
}

export async function activeDaemonLock(profile = DEFAULT_PROFILE, env = process.env) {
  const paths = profilePaths(profile, env);
  return activeLockFile(paths.lockFile, { profile: paths.profile });
}

export async function activeComputerLock(env = process.env) {
  const paths = rootLockPaths(env);
  return activeLockFile(paths.lockFile, { scope: 'computer' });
}

async function writeLockFile(file, lock) {
  const handle = await open(file, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`);
  } finally {
    await handle.close();
  }
}

async function acquireDaemonLock(profile = DEFAULT_PROFILE, config = {}, env = process.env) {
  const paths = profilePaths(profile, env);
  await mkdir(paths.runDir, { recursive: true });
  const lock = {
    pid: process.pid,
    profile: paths.profile,
    serverUrl: config.serverUrl || '',
    computerId: config.computerId || null,
    startedAt: now(),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const active = await activeDaemonLock(paths.profile, env);
    if (active) {
      throw new Error(`MagClaw daemon profile "${paths.profile}" is already running with pid ${active.pid}. Run "magclaw-daemon stop --profile ${paths.profile}" before starting another daemon.`);
    }
    try {
      await writeLockFile(paths.lockFile, lock);
      return async () => {
        const current = await readJsonFile(paths.lockFile, null);
        if (Number(current?.pid) === process.pid) {
          await rm(paths.lockFile, { force: true }).catch(() => {});
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`MagClaw daemon profile "${paths.profile}" is already starting.`);
}

function parseFlagKey(item) {
  return item
    .replace(/^--/, '')
    .replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
}

export function parseCli(argv = process.argv) {
  const args = argv.slice(2);
  const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'connect';
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item.startsWith('--')) continue;
    const equalsIndex = item.indexOf('=');
    if (equalsIndex > 2) {
      flags[parseFlagKey(item.slice(0, equalsIndex))] = item.slice(equalsIndex + 1);
      continue;
    }
    const key = parseFlagKey(item);
    const next = args[index + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      index += 1;
    }
  }
  flags.profile = safeProfileName(flags.profile || process.env.MAGCLAW_DAEMON_PROFILE || DEFAULT_PROFILE);
  return { command, flags };
}

async function readJsonFile(file, fallback = {}) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function readProfile(profile, env = process.env) {
  const paths = profilePaths(profile, env);
  const config = await readJsonFile(paths.config, {});
  return {
    ...config,
    profile: paths.profile,
  };
}

async function saveProfile(profile, config, env = process.env) {
  const paths = profilePaths(profile, env);
  const owner = await ensureMachineFingerprint(paths.profile, env);
  const pairToken = config.pairToken || '';
  const safeConfig = {
    profile: paths.profile,
    serverUrl: String(config.serverUrl || DEFAULT_SERVER_URL).replace(/\/+$/, ''),
    workspaceId: config.workspaceId || config.workspace || 'local',
    computerId: config.computerId || null,
    name: config.name || os.hostname(),
    fingerprint: config.fingerprint || owner.fingerprint,
    token: pairToken ? '' : (config.token || ''),
    pairToken,
    createdAt: config.createdAt || now(),
    updatedAt: now(),
  };
  if (safeConfig.token) safeConfig.pairToken = '';
  await writeJsonFile(paths.config, safeConfig);
  return safeConfig;
}

async function readServiceState(profile = DEFAULT_PROFILE, env = process.env) {
  const paths = profilePaths(profile, env);
  const state = await readJsonFile(paths.service, {});
  return {
    version: 1,
    profile: paths.profile,
    mode: state.mode || 'foreground',
    background: Boolean(state.background),
    launcher: state.launcher || '',
    packageSpec: state.packageSpec || '',
    previousPackageSpec: state.previousPackageSpec || '',
    installedDaemonVersion: state.installedDaemonVersion || DAEMON_VERSION,
    updatedAt: state.updatedAt || '',
    ...state,
  };
}

async function writeServiceState(profile = DEFAULT_PROFILE, patch = {}, env = process.env) {
  const paths = profilePaths(profile, env);
  const previous = await readServiceState(paths.profile, env);
  const next = {
    ...previous,
    ...patch,
    version: 1,
    profile: paths.profile,
    updatedAt: now(),
  };
  await writeJsonFile(paths.service, next);
  return next;
}

async function readUpgradeHandoff(profile = DEFAULT_PROFILE, env = process.env) {
  const paths = profilePaths(profile, env);
  const handoff = await readJsonFile(paths.upgradeHandoff, null);
  return handoff && typeof handoff === 'object' && !Array.isArray(handoff) ? handoff : null;
}

async function writeUpgradeHandoff(profile = DEFAULT_PROFILE, patch = {}, env = process.env) {
  const paths = profilePaths(profile, env);
  const previous = await readUpgradeHandoff(paths.profile, env) || {};
  const handoff = {
    ...previous,
    ...patch,
    profile: paths.profile,
    updatedAt: now(),
  };
  await writeJsonFile(paths.upgradeHandoff, handoff);
  return handoff;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function commandOutput(command, args = [], options = {}) {
  const spawnSpec = runtimeSpawnSpec(command, args);
  const result = spawnSync(spawnSpec.command, spawnSpec.args, {
    encoding: 'utf8',
    timeout: options.timeoutMs || 3000,
    env: options.env || process.env,
    shell: spawnSpec.shell,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal || '',
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    error: result.error || null,
  };
}

export function selectRuntimeCommandPath(output, fallback = '', platform = process.platform) {
  const paths = String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!paths.length) return fallback;
  if (platform !== 'win32') return paths[0];
  const score = (file) => {
    const ext = path.extname(file).toLowerCase();
    if (ext === '.cmd' || ext === '.bat') return 0;
    if (ext === '.exe' || ext === '.com') return 1;
    return 2;
  };
  return paths
    .map((file, index) => ({ file, index, score: score(file) }))
    .sort((left, right) => left.score - right.score || left.index - right.index)[0]?.file || paths[0];
}

function commandExists(command, env = process.env) {
  const checker = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [command] : ['-v', command];
  const result = process.platform === 'win32'
    ? commandOutput(checker, args, { env, timeoutMs: 1500 })
    : commandOutput('/bin/sh', ['-lc', `command -v ${JSON.stringify(command)}`], { env, timeoutMs: 1500 });
  if (result.ok) return selectRuntimeCommandPath(result.stdout, command);
  for (const candidate of [
    path.join(path.dirname(process.execPath), command),
    path.join(os.homedir(), '.local', 'bin', command),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return '';
}

function runtimeVersion(command, env = process.env) {
  const result = commandOutput(command, ['--version'], { env, timeoutMs: 3000 });
  if (!result.ok && result.error?.code === 'ENOENT') return '';
  return result.stdout || result.stderr || '';
}

function codexAppServerCapable(command, env = process.env) {
  const result = commandOutput(command, ['app-server', '--help'], { env, timeoutMs: 3000 });
  if (result.error?.code === 'ENOENT') return false;
  if (result.ok) return true;
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return output.includes('app-server') || output.includes('listen') || output.includes('stdio');
}

function defaultCodexCommand(env = process.env) {
  const macAppBinary = '/Applications/Codex.app/Contents/Resources/codex';
  const candidates = [env.CODEX_PATH, env.MAGCLAW_CODEX_PATH, macAppBinary, 'codex']
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    const command = runtimeCommandHasPathSeparator(candidate)
      ? candidate
      : commandExists(candidate, env) || candidate;
    if (runtimeCommandHasPathSeparator(command) && !existsSync(command)) continue;
    const result = commandOutput(command, ['--version'], { env, timeoutMs: 3000 });
    if (result.ok) return command;
  }
  return candidates[0] || 'codex';
}

function codexRuntimeModels(command, env = process.env) {
  const fallback = {
    models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex'],
    modelNames: [
      { slug: 'gpt-5.5', name: 'GPT-5.5' },
      { slug: 'gpt-5.4', name: 'GPT-5.4' },
      { slug: 'gpt-5.4-mini', name: 'GPT-5.4 Mini' },
      { slug: 'gpt-5.3-codex', name: 'GPT-5.3 Codex' },
    ],
    defaultModel: 'gpt-5.5',
    reasoningEffort: ['low', 'medium', 'high', 'xhigh'],
    defaultReasoningEffort: 'medium',
  };
  const result = commandOutput(command, ['debug', 'models'], { env, timeoutMs: 5000 });
  if (!result.ok) return fallback;
  try {
    const data = JSON.parse(result.stdout || '{}');
    const modelNames = [];
    let defaultModel = '';
    let reasoningEffort = [];
    for (const model of Array.isArray(data.models) ? data.models : []) {
      if (model.visibility && model.visibility !== 'list') continue;
      const slug = String(model.slug || '').trim();
      if (!slug) continue;
      modelNames.push({ slug, name: model.display_name || model.name || slug });
      if (!defaultModel) {
        defaultModel = slug;
        reasoningEffort = (Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [])
          .map((item) => String(item.effort || '').trim())
          .filter(Boolean);
      }
    }
    if (!modelNames.length) return fallback;
    return {
      models: modelNames.map((model) => model.slug),
      modelNames,
      defaultModel: defaultModel || modelNames[0].slug,
      reasoningEffort: reasoningEffort.length ? reasoningEffort : fallback.reasoningEffort,
      defaultReasoningEffort: 'medium',
    };
  } catch {
    return fallback;
  }
}

export async function detectRuntimes(env = process.env) {
  const codexCommand = defaultCodexCommand(env);
  const candidates = [
    {
      id: 'codex',
      name: 'Codex CLI',
      command: codexCommand,
      createSupported: true,
      modelsFor: (command) => codexRuntimeModels(command, env),
    },
    {
      id: 'claude-code',
      name: 'Claude Code',
      command: env.CLAUDE_PATH || 'claude',
      createSupported: true,
      models: ['claude-sonnet-4-6', 'claude-opus-4-7', 'claude-haiku-4-5-20251001'],
      defaultModel: 'claude-sonnet-4-6',
    },
    {
      id: 'kimi',
      name: 'Kimi CLI',
      command: env.KIMI_PATH || 'kimi',
      createSupported: false,
      models: ['kimi-k2-0905', 'kimi-k2-turbo-preview'],
      defaultModel: 'kimi-k2-0905',
    },
    {
      id: 'cursor',
      name: 'Cursor CLI',
      command: env.CURSOR_PATH || 'cursor-agent',
      createSupported: false,
      models: ['auto'],
      defaultModel: 'auto',
    },
    {
      id: 'gemini',
      name: 'Gemini CLI',
      command: env.GEMINI_PATH || 'gemini',
      createSupported: false,
      models: ['gemini-2.5-pro', 'gemini-2.5-flash'],
      defaultModel: 'gemini-2.5-pro',
    },
    {
      id: 'copilot',
      name: 'Copilot CLI',
      command: env.COPILOT_PATH || 'copilot',
      createSupported: false,
      models: ['auto'],
      defaultModel: 'auto',
    },
    {
      id: 'opencode',
      name: 'OpenCode',
      command: env.OPENCODE_PATH || 'opencode',
      createSupported: false,
      models: ['auto'],
      defaultModel: 'auto',
    },
  ];
  return candidates.map((item) => {
    const pathValue = runtimeCommandHasPathSeparator(item.command) ? (existsSync(item.command) ? item.command : '') : commandExists(item.command, env);
    const runtimeCommand = pathValue || item.command;
    const installed = Boolean(pathValue);
    const version = installed ? runtimeVersion(runtimeCommand, env) : '';
    const modelInfo = installed && item.modelsFor ? item.modelsFor(runtimeCommand) : {
      models: item.models || [],
      modelNames: (item.models || []).map((model) => ({ slug: model, name: model })),
      defaultModel: item.defaultModel || item.models?.[0] || '',
      reasoningEffort: [],
      defaultReasoningEffort: '',
    };
    return {
      id: item.id,
      name: item.name,
      command: runtimeCommand,
      path: pathValue,
      installed,
      version,
      createSupported: item.createSupported !== false,
      appServer: item.id === 'codex' && installed ? codexAppServerCapable(runtimeCommand, env) : false,
      ...modelInfo,
    };
  });
}

export function toWebSocketUrl(serverUrl, config = {}) {
  const base = String(serverUrl || DEFAULT_SERVER_URL).replace(/\/+$/, '');
  const wsBase = base.startsWith('https://')
    ? `wss://${base.slice('https://'.length)}`
    : base.startsWith('http://')
      ? `ws://${base.slice('http://'.length)}`
      : base;
  const url = new URL(`${wsBase}/daemon/connect`);
  const token = String(config.token || config.machineToken || config.apiKey || '').trim();
  const pairToken = String(config.pairToken || '').trim();
  if (token) url.searchParams.set('token', token);
  else if (pairToken) url.searchParams.set('pair_token', pairToken);
  else url.searchParams.set('token', '');
  return url;
}

function encodeFrame(payload) {
  const data = Buffer.from(JSON.stringify(payload), 'utf8');
  const length = data.length;
  const header = length < 126
    ? Buffer.alloc(2)
    : length < 65536
      ? Buffer.alloc(4)
      : Buffer.alloc(10);
  header[0] = 0x81;
  if (length < 126) {
    header[1] = 0x80 | length;
  } else if (length < 65536) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(data);
  for (let index = 0; index < masked.length; index += 1) {
    masked[index] ^= mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function decodeFrames(connection, chunk) {
  connection.buffer = Buffer.concat([connection.buffer, chunk]);
  const frames = [];
  while (connection.buffer.length >= 2) {
    const first = connection.buffer[0];
    const second = connection.buffer[1];
    const opcode = first & 0x0f;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (connection.buffer.length < offset + 2) break;
      length = connection.buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (connection.buffer.length < offset + 8) break;
      length = Number(connection.buffer.readBigUInt64BE(offset));
      offset += 8;
    }
    if (connection.buffer.length < offset + length) break;
    const payload = connection.buffer.subarray(offset, offset + length);
    connection.buffer = connection.buffer.subarray(offset + length);
    frames.push({ opcode, text: payload.toString('utf8') });
  }
  return frames;
}

function sendJsonFrame(socket, payload) {
  socket.write(encodeFrame(payload));
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function tomlArray(values) {
  return `[${values.map((value) => tomlString(value)).join(',')}]`;
}

function codexMcpArgs({ agentId, serverUrl, tokenFile }) {
  return [
    '-c', 'wire_api="responses"',
    '-c', `mcp_servers.magclaw.command=${tomlString(process.execPath)}`,
    '-c', `mcp_servers.magclaw.args=${tomlArray([MCP_BRIDGE_PATH, '--agent-id', agentId, '--base-url', serverUrl, '--token-file', tokenFile])}`,
    '-c', 'mcp_servers.magclaw.startup_timeout_sec=30',
    '-c', 'mcp_servers.magclaw.tool_timeout_sec=120',
    '-c', 'mcp_servers.magclaw.enabled=true',
    '-c', 'mcp_servers.magclaw.required=false',
  ];
}

function contextArray(value) {
  return Array.isArray(value) ? value : [];
}

function contextText(value, limit = 1200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function contextSnippet(value, limit = 240) {
  const text = contextText(value, limit);
  return text.length >= limit ? `${text.slice(0, Math.max(0, limit - 3)).trim()}...` : text;
}

function contextActorName(pack, id) {
  const value = String(id || '').trim();
  if (!value) return 'unknown';
  const actor = contextArray(pack?.participants).find((item) => item.id === value)
    || contextArray(pack?.suggestedMembers).find((item) => item.id === value);
  return actor?.name || value;
}

function renderContextMentions(pack, text) {
  return String(text || '').replace(/<@([^>]+)>/g, (_, id) => `@${contextActorName(pack, id)}`);
}

function renderContextParticipant(item = {}, targetAgentId = '') {
  const self = item.id === targetAgentId ? ' (you)' : '';
  const details = [
    item.type || '',
    item.role ? `role=${item.role}` : '',
    item.runtime ? `runtime=${item.runtime}` : '',
    item.status ? `status=${item.status}` : '',
    item.description ? `description=${contextSnippet(item.description, 96)}` : '',
  ].filter(Boolean).join('; ');
  return `@${item.name || item.id}${self}${details ? ` - ${details}` : ''}`;
}

function renderContextMessage(pack, record = {}, targetAgentId = '') {
  const addressed = contextArray(record.mentionedAgentIds).includes(targetAgentId) ? ' mentioned you' : '';
  const bits = [
    record.id ? `msg=${record.id}` : '',
    record.parentMessageId ? `parent=${record.parentMessageId}` : '',
    record.workItemId ? `workItem=${record.workItemId}` : '',
    record.taskId ? `task=${record.taskId}` : '',
    record.createdAt ? `time=${String(record.createdAt).replace('T', ' ').slice(0, 16)}` : '',
    record.authorType ? `type=${record.authorType}` : '',
  ].filter(Boolean).join(' ');
  return `[${bits}] @${contextActorName(pack, record.authorId)}${addressed}: ${renderContextMentions(pack, contextSnippet(record.body, 420))}`;
}

function renderContextTasks(pack) {
  const tasks = contextArray(pack?.tasks);
  if (!tasks.length) return '- (none)';
  return tasks.map((task) => {
    const assignees = contextArray(task.assigneeIds).map((id) => `@${contextActorName(pack, id)}`).join(', ');
    return `- task #${task.number || '?'} [${task.status || 'todo'}] ${contextText(task.title, 240)}${assignees ? ` (assignees: ${assignees})` : ''}`;
  }).join('\n');
}

function renderContextEventMembers(pack, event = {}) {
  const ids = [
    ...contextArray(event.memberIds),
    event.memberId,
  ].filter(Boolean);
  const uniqueIds = [...new Set(ids.map(String))];
  return uniqueIds.map((id) => `@${contextActorName(pack, id)}`).join(', ');
}

function renderContextEvent(pack, event = {}) {
  const bits = [
    event.id ? `event=${event.id}` : '',
    event.type ? `type=${event.type}` : '',
    event.createdAt ? `time=${String(event.createdAt).replace('T', ' ').slice(0, 16)}` : '',
  ].filter(Boolean).join(' ');
  const members = renderContextEventMembers(pack, event);
  if (event.type === 'channel_member_added' && members) {
    return `[${bits}] ${members} joined this channel.`;
  }
  if (event.type === 'channel_member_removed' && members) {
    return `[${bits}] ${members} left or was removed from this channel.`;
  }
  if (event.type === 'channel_member_proposal_accepted' && members) {
    return `[${bits}] Human review accepted adding ${members} to this channel.`;
  }
  return `[${bits}] ${renderContextMentions(pack, contextSnippet(event.message, 300))}`;
}

function renderContextEvents(pack) {
  const events = contextArray(pack?.recentEvents);
  if (!events.length) return '- (none)';
  return events.map((event) => renderContextEvent(pack, event)).join('\n');
}

function renderContextPeerMemory(pack) {
  const search = pack?.peerMemorySearch;
  if (!search?.required && !contextArray(search?.results).length) return '';
  const lines = [
    'Peer memory search:',
    `- Required: ${search.required ? 'yes' : 'no'}`,
    search.reason ? `- Reason: ${contextText(search.reason, 240)}` : '',
    search.query ? `- Query: ${contextText(search.query, 240)}` : '',
  ].filter(Boolean);
  const results = contextArray(search.results);
  if (!results.length) {
    lines.push('- Results: no matches. If this asks what another agent specializes in, call search_messages/read_history for prior role assignments before answering.');
  } else {
    lines.push('- Results:');
    for (const item of results.slice(0, 3)) {
      lines.push(`  - @${item.agentName || item.agentId}: ${contextSnippet(item.preview, 220)}`);
    }
    if (results.length > 3) lines.push(`  - ${results.length - 3} more result(s) omitted; call search_agent_memory/read_agent_memory and search_messages/read_history if needed.`);
  }
  return lines.join('\n');
}

function renderContextSuggestedMembers(pack) {
  const members = contextArray(pack?.suggestedMembers);
  if (!members.length) return '';
  const agentLines = [];
  const humanLines = [];
  for (const item of members.slice(0, 20)) {
    const details = [
      item.type || '',
      item.role ? `role=${item.role}` : '',
      item.runtime ? `runtime=${item.runtime}` : '',
      item.status ? `status=${item.status}` : '',
      item.description ? `description=${contextSnippet(item.description, 120)}` : '',
    ].filter(Boolean).join('; ');
    const line = `- @${item.name || item.id}${details ? ` - ${details}` : ''}`;
    if (item.type === 'agent') agentLines.push(line);
    else humanLines.push(line);
  }
  const lines = [
    'Server members not in this channel yet:',
    agentLines.length ? '- Agents available to suggest adding:' : '',
    ...agentLines,
    humanLines.length ? '- Humans available to suggest adding:' : '',
    ...humanLines,
    'These are server-scoped members across connected computers; they are valid candidates for human-reviewed channel-member proposals.',
  ].filter(Boolean);
  return lines.join('\n');
}

function compactContextParticipants(pack, targetAgentId = '') {
  const participants = contextArray(pack?.participants);
  const importantIds = new Set([
    targetAgentId,
    pack?.currentMessage?.authorId,
    ...contextArray(pack?.currentMessage?.mentionedAgentIds),
    ...contextArray(pack?.currentMessage?.mentionedHumanIds),
  ].filter(Boolean));
  for (const record of contextArray(pack?.recentMessages).slice(-4)) {
    if (record?.authorId) importantIds.add(record.authorId);
    for (const id of contextArray(record?.mentionedAgentIds)) importantIds.add(id);
    for (const id of contextArray(record?.mentionedHumanIds)) importantIds.add(id);
  }
  const selected = [];
  for (const item of participants) {
    if (importantIds.has(item.id)) selected.push(item);
  }
  for (const item of participants) {
    if (selected.length >= 10) break;
    if (!selected.some((existing) => existing.id === item.id)) selected.push(item);
  }
  const selectedIds = new Set(selected.map((item) => item.id));
  return {
    total: participants.length,
    selected: participants.filter((item) => selectedIds.has(item.id)),
    omitted: Math.max(0, participants.length - selected.length),
  };
}

function renderRemoteAgentContextPack(pack, targetAgentId = '') {
  if (!pack?.currentMessage) return '';
  const recent = contextArray(pack.recentMessages).slice(-4);
  const participants = compactContextParticipants(pack, targetAgentId);
  const lines = [
    `Context snapshot for ${pack.space?.label || pack.space?.name || pack.space?.id || 'conversation'}`,
    `- Space: ${pack.space?.type || 'space'} (${pack.space?.visibility || 'public'}${pack.space?.defaultChannel ? ', default workspace channel' : ''})`,
    pack.space?.description ? `- Channel description: ${contextSnippet(pack.space.description, 180)}` : '',
    `- Participants shown: ${participants.selected.map((item) => renderContextParticipant(item, targetAgentId)).join(', ') || '(none)'}`,
    participants.omitted ? `- Participants omitted: ${participants.omitted}. Use list_agents/read_agent_profile or search_agent_memory when a broader roster or specialties matter.` : '',
    pack.space?.type === 'channel' && !pack.space?.defaultChannel ? renderContextSuggestedMembers(pack) : '',
    '',
    'Current message:',
    renderContextMessage(pack, pack.currentMessage, targetAgentId),
    '',
    'Recent channel activity (oldest to newest):',
    renderContextEvents(pack),
    'Use channel activity to resolve implicit references like "the new agent", "he", "she", "that member", or "刚加入的那位" before replying.',
    '',
    'Recent visible messages (oldest to newest):',
    recent.length ? recent.map((record) => renderContextMessage(pack, record, targetAgentId)).join('\n') : '- (none)',
  ];
  if (pack.thread?.parentMessage) {
    lines.push(
      '',
      'Thread context:',
      renderContextMessage(pack, pack.thread.parentMessage, targetAgentId),
      contextArray(pack.thread.recentReplies).length
        ? contextArray(pack.thread.recentReplies).slice(-3).map((record) => renderContextMessage(pack, record, targetAgentId)).join('\n')
        : '- (no earlier thread replies)',
    );
  }
  lines.push(
    '',
    'Relevant tasks:',
    renderContextTasks(pack),
    '',
    renderContextPeerMemory(pack),
    '',
    'Progressive context tools: list_agents, read_agent_profile, read_history, search_messages, search_agent_memory, read_agent_memory, and list_tasks are available through MagClaw MCP.',
    'For "who can we bring in" or agent suitability questions, use the server member list above first; call list_agents without a target for the server-wide agent roster, because target filters to the current channel.',
    'For agent capability or specialty questions, use peer memory first; if memory is empty or weak, search_messages/read_history for earlier user role assignments before saying the fact is unknown.',
    'Use this compact snapshot first. Call the tools only when the answer depends on omitted participants, deeper history, memory, or task details.',
  );
  return lines.filter(Boolean).join('\n');
}

export function deliveryPrompt(agent, message = {}, workItem = null) {
  const target = message.target || (message.spaceType && message.spaceId
    ? `${message.spaceType}:${message.spaceId}${message.parentMessageId ? `:${message.parentMessageId}` : ''}`
    : '#all');
  const workItemId = workItem?.id || message.workItemId || '';
  const workItemLine = workItem?.id || message.workItemId
    ? `Work item id: ${workItemId}`
    : 'Work item id: none';
  return [
    `You are ${agent.name || agent.id}, a MagClaw remote agent running on this local computer.`,
    agent.runtime ? `Runtime: ${agent.runtime}` : '',
    agent.description ? `Agent description: ${contextSnippet(agent.description, 180)}` : '',
    'You must respond to the incoming message unless it is purely informational and clearly needs no reply.',
    'For ordinary replies to the current source conversation, finish with the exact reply text and MagClaw will post it back.',
    'Use send_message with workItemId and the exact target for routed task replies; use send_message without workItemId only when you need to proactively message another visible target such as dm:@Agent or #channel:thread.',
    'Use the other MagClaw MCP tools only when you need to inspect omitted roster details, read history, search messages or memory, manage tasks, write memory, or schedule reminders.',
    'The daemon already provides the MagClaw MCP bridge and MAGCLAW_MACHINE_TOKEN. Prefer MCP tools; if you fall back to shell curl for /api/agent-tools/*, include `-H "authorization: Bearer $MAGCLAW_MACHINE_TOKEN"` and do not claim the machine token is missing.',
    renderAgentPermissionGuidance(agent),
    `Agent id: ${agent.id}`,
    `Conversation target: ${target}`,
    workItemLine,
    message.parentMessageId ? `Parent message id: ${message.parentMessageId}` : '',
    message.id ? `Source message id: ${message.id}` : '',
    renderRemoteAgentContextPack(message.contextPack, agent.id),
    '',
    'Incoming message:',
    String(message.body || message.content || '').trim() || '(empty)',
  ].filter(Boolean).join('\n');
}

function parseToolArguments(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function codexToolCallId(item) {
  return String(item?.id || item?.callId || item?.call_id || item?.itemId || item?.item_id || '');
}

function codexToolName(item) {
  const tool = item?.tool;
  return String(
    item?.name
    || item?.toolName
    || item?.tool_name
    || (typeof tool === 'string' ? tool : tool?.name)
    || item?.function?.name
    || item?.call?.name
    || ''
  );
}

function codexToolNameMatches(name, expected) {
  const value = String(name || '').trim();
  if (!value || !expected) return false;
  return value === expected
    || value.endsWith(`.${expected}`)
    || value.endsWith(`/${expected}`)
    || value.endsWith(`:${expected}`)
    || value.endsWith(`__${expected}`);
}

function codexToolArguments(item) {
  const candidates = [
    item?.arguments,
    item?.args,
    item?.input,
    item?.params?.arguments,
    item?.params?.input,
    item?.toolInput,
    item?.tool_input,
    item?.function?.arguments,
    item?.call?.arguments,
  ];
  for (const candidate of candidates) {
    const parsed = parseToolArguments(candidate);
    if (Object.keys(parsed).length) return parsed;
  }
  return {};
}

function canonicalMagClawToolName(name) {
  const tools = [
    'send_message',
    'read_history',
    'search_messages',
    'search_agent_memory',
    'read_agent_memory',
    'list_agents',
    'read_agent_profile',
    'write_memory',
    'list_tasks',
    'create_tasks',
    'claim_tasks',
    'update_task_status',
    'propose_channel_members',
    'schedule_reminder',
    'list_reminders',
    'cancel_reminder',
  ];
  return tools.find((tool) => codexToolNameMatches(name, tool)) || '';
}

function dynamicToolContentResult(text) {
  return {
    contentItems: [
      { type: 'inputText', text: String(text || '') },
    ],
  };
}

function jsonText(value) {
  if (typeof value?.text === 'string' && value.text.trim()) return value.text;
  return JSON.stringify(value ?? {}, null, 2);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function toolCallSignature(name, args = {}) {
  return `${String(name || '').trim()}|${stableJson(args || {})}`;
}

function agentRuntimeKind(agent = {}) {
  const value = String(agent.runtimeId || agent.runtime || '').toLowerCase();
  if (value.includes('claude')) return 'claude-code';
  if (value.includes('codex')) return 'codex';
  return value || 'codex';
}

function runtimeHookConfigName(runtimeKind) {
  if (runtimeKind === 'claude-code') return 'settings.json';
  return 'hooks.json';
}

function runtimeHookDefaultConfig(runtimeKind) {
  if (runtimeKind === 'codex') return { hooks: [] };
  if (runtimeKind === 'claude-code') return { hooks: {} };
  return {};
}

async function writeJsonFileIfMissing(filePath, value) {
  if (existsSync(filePath)) return;
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function prepareRuntimeHooks({ agentDir, workspace, codexHome = '', runtimeKind }) {
  const cleanRuntimeKind = String(runtimeKind || '').trim().toLowerCase() || 'codex';
  const runtimeDir = path.join(workspace, 'runtime-hooks', cleanRuntimeKind);
  const hooksDir = path.join(runtimeDir, 'hooks');
  const configPath = path.join(runtimeDir, runtimeHookConfigName(cleanRuntimeKind));
  await mkdir(hooksDir, { recursive: true });
  await writeJsonFileIfMissing(configPath, runtimeHookDefaultConfig(cleanRuntimeKind));
  const targets = cleanRuntimeKind === 'codex'
    ? [
        [configPath, path.join(codexHome || path.join(agentDir, 'codex-home'), 'hooks.json')],
        [hooksDir, path.join(codexHome || path.join(agentDir, 'codex-home'), 'hooks')],
      ]
    : cleanRuntimeKind === 'claude-code'
      ? [
          [configPath, path.join(workspace, '.claude', 'settings.json')],
          [hooksDir, path.join(workspace, '.claude', 'hooks')],
        ]
      : [];
  for (const [source, target] of targets) {
    await mkdir(path.dirname(target), { recursive: true });
    await linkPathEntry(source, target);
  }
  return { runtime: cleanRuntimeKind, root: runtimeDir, configPath, hooksDir };
}

function agentEnvironment(agent = {}, env = process.env) {
  const output = { ...env };
  for (const item of Array.isArray(agent.envVars) ? agent.envVars : []) {
    const key = String(item.key || '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    output[key] = String(item.value || '');
  }
  return output;
}

async function ensureSymlinkedCodexHomeEntry(codexHome, entryName) {
  const source = path.join(SOURCE_CODEX_HOME, entryName);
  if (!existsSync(source)) return;
  const target = path.join(codexHome, entryName);
  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink()) {
      const current = await readlink(target);
      const resolved = path.resolve(path.dirname(target), current);
      if (resolved === source) return;
      await unlink(target);
    } else {
      return;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const sourceStat = await stat(source);
  const linkType = sourceStat.isDirectory()
    ? (process.platform === 'win32' ? 'junction' : 'dir')
    : 'file';
  try {
    await symlink(source, target, linkType);
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EINVAL', 'UNKNOWN', 'ENOTSUP'].includes(error?.code)) {
      throw error;
    }
    if (sourceStat.isDirectory()) {
      await cp(source, target, { recursive: true, dereference: true, errorOnExist: true, force: false });
    } else {
      await copyFile(source, target);
    }
  }
}

function toPosixPath(value) {
  return String(value || '').split(path.sep).join('/');
}

async function linkPathEntry(source, target) {
  if (!source || !existsSync(source)) return false;
  if (path.resolve(source) === path.resolve(target)) return false;
  try {
    const existing = await lstat(target);
    if (existing.isSymbolicLink()) {
      const current = await readlink(target);
      const resolved = path.resolve(path.dirname(target), current);
      if (resolved === source) return true;
      await unlink(target);
    } else {
      return false;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const sourceStat = await stat(source);
  await symlink(source, target, sourceStat.isDirectory() ? 'dir' : 'file');
  return true;
}

async function globalSkillRoots() {
  const candidates = [
    path.join(SOURCE_CODEX_HOME, 'skills'),
    path.join(os.homedir(), '.agents', 'skills'),
  ];
  const roots = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const resolved = await realpath(candidate).catch(() => path.resolve(candidate));
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    roots.push(candidate);
  }
  return roots;
}

async function syncGlobalSkillsIntoAgentHome(codexHome, workspace) {
  const targetSkillsRoot = path.join(codexHome, 'skills');
  await mkdir(targetSkillsRoot, { recursive: true });
  const roots = await globalSkillRoots();
  for (const sourceSkillsRoot of [...roots].reverse()) {
    const entries = await readdir(sourceSkillsRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const source = path.join(sourceSkillsRoot, entry.name);
      if (entry.name === '.system' && (entry.isDirectory() || entry.isSymbolicLink())) {
        const targetSystemRoot = path.join(targetSkillsRoot, '.system');
        await mkdir(targetSystemRoot, { recursive: true });
        const systemEntries = await readdir(source, { withFileTypes: true }).catch(() => []);
        for (const systemEntry of systemEntries) {
          const systemSource = path.join(source, systemEntry.name);
          const systemTarget = path.join(targetSystemRoot, systemEntry.name);
          await linkPathEntry(systemSource, systemTarget).catch(() => {});
        }
        continue;
      }
      if (!entry.isDirectory() && !entry.isSymbolicLink() && !entry.isFile()) continue;
      await linkPathEntry(source, path.join(targetSkillsRoot, entry.name)).catch(() => {});
    }
  }

  const workspaceSkillsLink = path.join(workspace, 'skills');
  await linkPathEntry(targetSkillsRoot, workspaceSkillsLink).catch(() => {});
}

function firstFrontmatterValue(content, keys) {
  const match = String(content || '').match(/^---\s*\n([\s\S]*?)\n---\s*\n?/);
  if (!match) return '';
  const lines = match[1].split(/\r?\n/);
  for (const key of keys) {
    const line = lines.find((item) => item.toLowerCase().startsWith(`${key.toLowerCase()}:`));
    if (!line) continue;
    return line.slice(line.indexOf(':') + 1).trim().replace(/^['"]|['"]$/g, '');
  }
  return '';
}

function firstMarkdownParagraph(content) {
  return String(content || '')
    .replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, '')
    .split(/\n\s*\n/g)
    .map((block) => block.replace(/^#+\s+.*$/gm, '').replace(/\s+/g, ' ').trim())
    .find(Boolean) || '';
}

function skillNameFromPath(absPath) {
  const parent = path.basename(path.dirname(absPath));
  const base = path.basename(absPath, path.extname(absPath));
  return base === 'SKILL' ? parent : base;
}

function pluginNameFromPath(absPath) {
  const parts = String(absPath || '').split(/[\\/]+/).filter(Boolean);
  for (let index = 0; index < parts.length - 2; index += 1) {
    if (parts[index] === 'plugins' && parts[index + 1] === 'cache') {
      return parts[index + 2] || '';
    }
  }
  return '';
}

function shortenSkillPath(absPath, { agentRoot = '', codexHome = '' } = {}) {
  const resolved = path.resolve(absPath);
  const sourceHome = path.resolve(SOURCE_CODEX_HOME);
  const home = os.homedir();
  if (agentRoot && resolved.startsWith(path.resolve(agentRoot))) return toPosixPath(path.relative(agentRoot, resolved));
  if (codexHome && resolved.startsWith(path.resolve(codexHome))) return toPosixPath(path.relative(codexHome, resolved));
  if (resolved.startsWith(sourceHome)) return toPosixPath(path.join('~/.codex', path.relative(sourceHome, resolved)));
  if (resolved.startsWith(home)) return toPosixPath(path.join('~', path.relative(home, resolved)));
  return resolved;
}

async function parseSkillFile(filePath, scope, context = {}) {
  const content = await readFile(filePath, 'utf8').catch(() => '');
  const resolvedFilePath = await realpath(filePath).catch(() => filePath);
  const name = firstFrontmatterValue(content, ['name', 'title']) || skillNameFromPath(filePath);
  const description = firstFrontmatterValue(content, ['description', 'summary', 'short_description', 'short-description'])
    || firstMarkdownParagraph(content)
    || 'No description provided.';
  const shortPath = shortenSkillPath(resolvedFilePath, context);
  return {
    id: `${scope}:${shortPath}`,
    name,
    description: description.slice(0, 500),
    path: shortPath,
    absolutePath: resolvedFilePath,
    scope,
    kind: path.basename(filePath) === 'SKILL.md' ? 'skill' : 'command',
    plugin: pluginNameFromPath(resolvedFilePath),
  };
}

export function windowsNpmShimScript(command, platform = process.platform) {
  if (platform !== 'win32' || !/\.cmd$/i.test(String(command || ''))) return '';
  if (!existsSync(command)) return '';
  let content = '';
  try {
    content = readFileSync(command, 'utf8');
  } catch {
    return '';
  }
  const match = content.match(/"%dp0%\\([^"]+?\.js)"/i);
  if (!match?.[1]) return '';
  const script = path.join(path.dirname(command), match[1].replace(/[\\/]+/g, path.sep));
  return existsSync(script) ? script : '';
}

function runtimeSpawnSpec(command, args = [], platform = process.platform) {
  const shimScript = windowsNpmShimScript(command, platform);
  if (shimScript) {
    return {
      command: process.execPath,
      args: [shimScript, ...args],
      shell: false,
    };
  }
  return {
    command,
    args,
    shell: runtimeCommandNeedsShell(command, platform),
  };
}

async function scanSkillsDir(root, scope, context = {}) {
  const skills = [];
  if (!root || !existsSync(root)) return skills;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.system') continue;
    const abs = path.join(root, entry.name);
    if (entry.isDirectory() || entry.isSymbolicLink()) {
      const skillFile = path.join(abs, 'SKILL.md');
      if (existsSync(skillFile)) {
        skills.push(await parseSkillFile(skillFile, scope, context));
        continue;
      }
      if (entry.name === '.system') skills.push(...await scanSkillsDir(abs, 'system', context));
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      skills.push(await parseSkillFile(abs, scope === 'agent' ? 'agent' : 'command', context));
    }
  }
  return skills;
}

async function findPluginSkillFiles(root, { maxEntries = 400 } = {}) {
  const found = [];
  async function walk(dir, depth = 0) {
    if (found.length >= maxEntries || depth > 8 || !existsSync(dir)) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (found.length >= maxEntries) break;
      if (entry.name.startsWith('.')) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory() || entry.isSymbolicLink()) {
        if (entry.name === 'skills') {
          const skillDirs = await readdir(abs, { withFileTypes: true }).catch(() => []);
          for (const skillDir of skillDirs) {
            const skillFile = path.join(abs, skillDir.name, 'SKILL.md');
            if ((skillDir.isDirectory() || skillDir.isSymbolicLink()) && existsSync(skillFile)) found.push(skillFile);
          }
          continue;
        }
        await walk(abs, depth + 1);
      }
    }
  }
  await walk(root);
  return found;
}

async function resolvedRoots(paths) {
  const roots = [];
  for (const item of paths) {
    if (!item || !existsSync(item)) continue;
    roots.push(await realpath(item).catch(() => path.resolve(item)));
  }
  return roots;
}

function uniqueSkills(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.scope}:${item.name}:${item.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

function daemonSkillTools() {
  return [
    'send_message',
    'read_history',
    'search_messages',
    'search_agent_memory',
    'read_agent_memory',
    'list_agents',
    'read_agent_profile',
    'write_memory',
    'list_tasks',
    'create_tasks',
    'claim_tasks',
    'update_task_status',
    'schedule_reminder',
    'list_reminders',
    'cancel_reminder',
  ];
}

function codexTrustedProjectPaths() {
  const home = path.resolve(os.homedir());
  const sourceCodexHome = path.resolve(SOURCE_CODEX_HOME);
  const trustRoot = sourceCodexHome === home || sourceCodexHome.startsWith(`${home}${path.sep}`)
    ? home
    : sourceCodexHome;
  return [...new Set([trustRoot].filter(Boolean))];
}

function codexTrustConfigLines() {
  return codexTrustedProjectPaths().flatMap((projectPath) => [
    `[projects.${tomlString(projectPath)}]`,
    'trust_level = "trusted"',
    '',
  ]);
}

class CodexAgentSession {
  constructor({ agent, profile, paths, serverUrl, token, workspaceId, sessionKey = '', send, markDelivery = null, onStatusChange = null, env = process.env }) {
    this.agent = agent;
    this.profile = profile;
    this.paths = paths;
    this.serverUrl = serverUrl;
    this.token = token;
    this.workspaceId = workspaceId || 'local';
    this.sessionKey = sessionKey || daemonConversationLaneKey({ workspaceId: this.workspaceId });
    this.send = send;
    this.markDelivery = typeof markDelivery === 'function' ? markDelivery : async () => {};
    this.onStatusChange = typeof onStatusChange === 'function' ? onStatusChange : () => {};
    this.env = env;
    this.child = null;
    this.requestId = 0;
    this.pending = new Map();
    this.stdoutBuffer = '';
    this.responseBuffer = '';
    const matchingRuntimeSession = Array.isArray(agent.runtimeSessions)
      ? agent.runtimeSessions.find((session) => session?.sessionKey === this.sessionKey)
      : null;
    this.threadId = matchingRuntimeSession?.codexThreadId || agent.runtimeSessionId || '';
    this.activeTurnId = '';
    this.status = 'offline';
    this.started = false;
    this.pendingPrompts = [];
    this.activeDeliveryId = '';
    this.completedToolCallIds = new Set();
    this.activeTurnToolSignatures = new Set();
    this.activeTurnUsedSendMessage = false;
    this.codexMessageQueue = Promise.resolve();
    this.streamActivityTimer = null;
    this.pendingStreamActivity = null;
    this.trajectoryCoalesceMs = envInteger(this.env, 'MAGCLAW_DAEMON_TRAJECTORY_COALESCE_MS', DEFAULT_TRAJECTORY_COALESCE_MS, { min: 0, max: 5_000 });
  }

  agentDir() {
    return path.join(this.paths.agentsDir, safeFilePart(this.agent.id));
  }

  codexHome() {
    return path.join(this.agentDir(), 'codex-home');
  }

  workspace() {
    return path.join(this.agentDir(), 'workspace');
  }

  async prepare() {
    await mkdir(this.codexHome(), { recursive: true });
    await mkdir(this.workspace(), { recursive: true });
    await Promise.all(CODEX_HOME_SHARED_ENTRIES.map((entry) => ensureSymlinkedCodexHomeEntry(this.codexHome(), entry)));
    await prepareRuntimeHooks({
      agentDir: this.agentDir(),
      workspace: this.workspace(),
      codexHome: this.codexHome(),
      runtimeKind: 'codex',
    });
    await syncGlobalSkillsIntoAgentHome(this.codexHome(), this.workspace());
    await writeFile(path.join(this.codexHome(), 'config.toml'), [
      'wire_api = "responses"',
      '',
      '[features]',
      'memories = false',
      'plugins = true',
      '',
      '[analytics]',
      'enabled = false',
      '',
      ...codexTrustConfigLines(),
    ].join('\n'));
    await writeFile(path.join(this.workspace(), 'AGENTS.md'), [
      '# MagClaw Remote Agent Workspace',
      '',
      'This workspace is isolated for a MagClaw cloud-connected agent.',
      'Do not assume files from the user localhost MagClaw instance are present here.',
      'Global Codex skills are linked into `./skills` for read-only reuse when available.',
      'Agent-specific skills can be installed under `./skills/<skill-name>/SKILL.md`; this path belongs to this agent only.',
      '',
    ].join('\n'));
  }

  async listSkills() {
    await this.prepare();
    const context = {
      agentRoot: this.agentDir(),
      codexHome: this.codexHome(),
    };
    const roots = await globalSkillRoots();
    const globalSkills = [];
    for (const root of roots) globalSkills.push(...await scanSkillsDir(root, 'global', context));
    const globalResolvedRoots = await resolvedRoots(roots);
    const agentRoots = [
      path.join(this.codexHome(), 'skills'),
      path.join(this.agentDir(), '.codex', 'skills'),
      path.join(this.agentDir(), '.agents', 'skills'),
    ];
    const agentSkills = [];
    for (const root of agentRoots) agentSkills.push(...await scanSkillsDir(root, 'agent', context));
    const workspaceSkills = agentSkills.filter((skill) => {
      const resolved = path.resolve(skill.absolutePath);
      return !globalResolvedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
    });
    const pluginFiles = await findPluginSkillFiles(path.join(SOURCE_CODEX_HOME, 'plugins', 'cache'));
    const pluginSkills = [];
    for (const file of pluginFiles) pluginSkills.push(await parseSkillFile(file, 'plugin', context));
    return {
      agent: {
        id: this.agent.id,
        name: this.agent.name || this.agent.id,
        codexHome: this.codexHome(),
        workspacePath: this.workspace(),
      },
      global: uniqueSkills(globalSkills),
      workspace: uniqueSkills(workspaceSkills),
      plugin: uniqueSkills(pluginSkills),
      tools: daemonSkillTools(),
    };
  }

  sendStatus(status, activity = null) {
    this.status = status;
    this.onStatusChange(this, status);
    this.send({
      type: 'agent:status',
      agentId: this.agent.id,
      status,
      deliveryId: this.activeDeliveryId || null,
      sessionId: this.threadId || null,
      sessionKey: this.sessionKey || null,
      activity: activity || {
        source: '@magclaw/daemon',
        status,
        at: now(),
      },
    });
  }

  sendRequest(method, params = {}) {
    if (!this.child?.stdin?.writable) return null;
    this.requestId += 1;
    const id = this.requestId;
    this.pending.set(id, { method, params, startedAt: Date.now() });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return id;
  }

  sendNotification(method, params = {}) {
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  sendResponse(id, result = {}) {
    if (!this.child?.stdin?.writable || id === undefined || id === null) return false;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
    return true;
  }

  sendErrorResponse(id, code, message, data = null) {
    if (!this.child?.stdin?.writable || id === undefined || id === null) return false;
    this.child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: {
        code,
        message: String(message || 'Request failed.'),
        ...(data ? { data } : {}),
      },
    })}\n`);
    return true;
  }

  queueCodexStreamActivity() {
    this.pendingStreamActivity = {
      type: 'agent:activity',
      agentId: this.agent.id,
      status: 'working',
      activity: { source: 'codex-stream', chars: this.responseBuffer.length, at: now() },
    };
    if (this.trajectoryCoalesceMs <= 0) {
      this.flushCodexStreamActivity();
      return;
    }
    if (this.streamActivityTimer) return;
    this.streamActivityTimer = setTimeout(() => {
      this.streamActivityTimer = null;
      this.flushCodexStreamActivity();
    }, this.trajectoryCoalesceMs);
    this.streamActivityTimer.unref?.();
  }

  flushCodexStreamActivity() {
    if (this.streamActivityTimer) {
      clearTimeout(this.streamActivityTimer);
      this.streamActivityTimer = null;
    }
    const payload = this.pendingStreamActivity;
    this.pendingStreamActivity = null;
    if (payload) this.send(payload);
  }

  async requestMagClawTool(pathname, { method = 'GET', query = {}, body = null } = {}) {
    const url = new URL(`${this.serverUrl.replace(/\/+$/, '')}${pathname}`);
    for (const [key, value] of Object.entries(query || {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          authorization: `Bearer ${this.token}`,
          ...(this.workspaceId ? { 'x-magclaw-workspace-id': this.workspaceId } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      const text = await response.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { text };
      }
      if (!response.ok) {
        const error = new Error(data?.error || data?.message || text || `HTTP ${response.status}`);
        error.status = response.status;
        error.data = data;
        throw error;
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  executeMagClawTool(name, rawArgs = {}) {
    const args = { ...rawArgs, agentId: rawArgs.agentId || this.agent.id };
    switch (name) {
      case 'send_message':
        return this.requestMagClawTool('/api/agent-tools/messages/send', {
          method: 'POST',
          body: {
            agentId: args.agentId,
            workItemId: args.workItemId || args.work_item_id,
            deliveryId: args.deliveryId || args.delivery_id || this.activeDeliveryId || undefined,
            idempotencyKey: args.idempotencyKey || args.idempotency_key || this.activeDeliveryId || undefined,
            target: args.target,
            content: args.content,
          },
        });
      case 'read_history':
        return this.requestMagClawTool('/api/agent-tools/history', {
          query: {
            agentId: args.agentId,
            target: args.target || args.channel,
            workItemId: args.workItemId || args.work_item_id,
            limit: args.limit,
            around: args.around,
            before: args.before,
            after: args.after,
          },
        });
      case 'search_messages':
        return this.requestMagClawTool('/api/agent-tools/search', {
          query: {
            agentId: args.agentId,
            query: args.query || args.q,
            target: args.target || args.channel,
            workItemId: args.workItemId || args.work_item_id,
            limit: args.limit,
          },
        });
      case 'search_agent_memory':
        return this.requestMagClawTool('/api/agent-tools/memory/search', {
          query: {
            agentId: args.agentId,
            query: args.query || args.q,
            targetAgentId: args.targetAgentId || args.targetAgent,
            limit: args.limit,
          },
        });
      case 'read_agent_memory':
        return this.requestMagClawTool('/api/agent-tools/memory/read', {
          query: {
            agentId: args.agentId,
            targetAgentId: args.targetAgentId || args.targetAgent,
            path: args.path || 'MEMORY.md',
          },
        });
      case 'list_agents':
        return this.requestMagClawTool('/api/agent-tools/agents', {
          query: {
            agentId: args.agentId,
            query: args.query || args.q,
            target: args.target || args.channel,
            limit: args.limit,
          },
        });
      case 'read_agent_profile':
        return this.requestMagClawTool('/api/agent-tools/agents/read', {
          query: {
            agentId: args.agentId,
            targetAgentId: args.targetAgentId || args.targetAgent,
          },
        });
      case 'write_memory':
        return this.requestMagClawTool('/api/agent-tools/memory', {
          method: 'POST',
          body: args,
        });
      case 'list_tasks':
        return this.requestMagClawTool('/api/agent-tools/tasks', {
          query: {
            agentId: args.agentId,
            channel: args.channel,
            target: args.target,
            status: args.status,
            assigneeId: args.assigneeId,
            limit: args.limit,
          },
        });
      case 'create_tasks':
        return this.requestMagClawTool('/api/agent-tools/tasks', {
          method: 'POST',
          body: args,
        });
      case 'claim_tasks':
        return this.requestMagClawTool('/api/agent-tools/tasks/claim', {
          method: 'POST',
          body: args,
        });
      case 'update_task_status':
        return this.requestMagClawTool('/api/agent-tools/tasks/update', {
          method: 'POST',
          body: args,
        });
      case 'propose_channel_members':
        return this.requestMagClawTool('/api/agent-tools/channel-member-proposals', {
          method: 'POST',
          body: {
            agentId: args.agentId,
            channelId: args.channelId || args.channel_id || args.channel,
            memberIds: args.memberIds || args.member_ids || (args.memberId ? [args.memberId] : undefined),
            reason: args.reason,
          },
        });
      case 'schedule_reminder':
        return this.requestMagClawTool('/api/agent-tools/reminders', {
          method: 'POST',
          body: args,
        });
      case 'list_reminders':
        return this.requestMagClawTool('/api/agent-tools/reminders', {
          query: {
            agentId: args.agentId,
            status: args.status,
            limit: args.limit,
          },
        });
      case 'cancel_reminder':
        return this.requestMagClawTool('/api/agent-tools/reminders/cancel', {
          method: 'POST',
          body: args,
        });
      default:
        throw new Error(`Unsupported MagClaw tool: ${name || '(unnamed)'}`);
    }
  }

  async executeCodexToolItem(item = {}, requestId = null, params = {}) {
    const callId = codexToolCallId(item) || String(params.callId || params.call_id || '');
    const name = canonicalMagClawToolName(codexToolName(item));
    if (!name) return false;
    const textArgs = parseToolArguments(params.inputText || params.input_text);
    const args = Object.keys(codexToolArguments(item)).length
      ? codexToolArguments(item)
      : textArgs;
    const signature = toolCallSignature(name, args);
    if ((callId && this.completedToolCallIds.has(callId)) || this.activeTurnToolSignatures.has(signature)) {
      if (requestId !== null && requestId !== undefined) this.sendResponse(requestId, dynamicToolContentResult('Already handled.'));
      return true;
    }
    this.activeTurnToolSignatures.add(signature);
    this.send({
      type: 'agent:activity',
      agentId: this.agent.id,
      status: 'working',
      activity: { source: 'magclaw-tool', tool: name, at: now() },
    });
    try {
      const data = await this.executeMagClawTool(name, args);
      if (callId) this.completedToolCallIds.add(callId);
      if (name === 'send_message') this.activeTurnUsedSendMessage = true;
      if (requestId !== null && requestId !== undefined) {
        this.sendResponse(requestId, dynamicToolContentResult(jsonText(data)));
      }
      return true;
    } catch (error) {
      this.activeTurnToolSignatures.delete(signature);
      if (requestId !== null && requestId !== undefined) {
        this.sendErrorResponse(requestId, error.status || -32000, error.message || 'Tool call failed.', error.data || null);
        return true;
      }
      this.send({
        type: 'agent:error',
        agentId: this.agent.id,
        error: error.message || 'Tool call failed.',
      });
      return true;
    }
  }

  handleCodexPermissionRequest(method, requestId, params = {}) {
    const summary = summarizeCodexPermissionRequest(method, params);
    const policy = codexPermissionDecision(method, params);
    logWarning('codex', `Auto-${policy.decision === 'approve' ? 'approved' : 'declined'} Codex permission request method=${method} agent=${this.agent.id} reason=${policy.reason}`);
    this.send({
      type: 'agent:activity',
      agentId: this.agent.id,
      status: this.status || 'working',
      deliveryId: this.activeDeliveryId || null,
      activity: {
        source: 'codex-permission',
        decision: policy.decision,
        reason: policy.reason,
        ...summary,
        at: now(),
      },
    });
    return this.sendResponse(requestId, policy.result);
  }

  async start() {
    if (this.started) return;
    await this.prepare();
    const codexCommand = defaultCodexCommand(this.env);
    const args = ['app-server', ...codexMcpArgs({
      agentId: this.agent.id,
      serverUrl: this.serverUrl,
      tokenFile: this.paths.config,
    }), '--listen', 'stdio://'];
    const spawnSpec = runtimeSpawnSpec(codexCommand, args);
    this.child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: this.workspace(),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: spawnSpec.shell,
      env: {
        ...agentEnvironment(this.agent, this.env),
        NO_COLOR: '1',
        CODEX_HOME: this.codexHome(),
        MAGCLAW_AGENT_ID: this.agent.id,
        MAGCLAW_DAEMON_PROFILE: this.profile,
        MAGCLAW_SERVER_URL: this.serverUrl,
        MAGCLAW_MACHINE_TOKEN: this.token,
      },
    });
    this.started = true;
    this.status = 'starting';
    this.sendStatus('starting', { source: '@magclaw/daemon', detail: 'Starting Codex app-server', at: now() });

    this.child.stdout.on('data', (chunk) => this.handleStdout(chunk));
    this.child.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (!text) return;
      this.send({
        type: 'agent:activity',
        agentId: this.agent.id,
        status: this.status || 'working',
        activity: { source: 'codex-stderr', text: text.slice(0, 2000), at: now() },
      });
    });
    this.child.on('error', (error) => {
      this.send({ type: 'agent:error', agentId: this.agent.id, error: error.message });
      this.sendStatus('error', { source: '@magclaw/daemon', error: error.message, at: now() });
    });
    this.child.on('close', (code, signal) => {
      this.flushCodexStreamActivity();
      this.started = false;
      this.child = null;
      const stopped = this.status === 'stopping';
      this.sendStatus(stopped ? 'offline' : 'error', {
        source: '@magclaw/daemon',
        detail: `Codex app-server exited with code ${code ?? 'unknown'}`,
        signal: signal || null,
        at: now(),
      });
    });

    this.sendRequest('initialize', { clientInfo: { name: '@magclaw/daemon', version: DAEMON_VERSION } });
    this.sendNotification('initialized', {});
    const method = this.threadId ? 'thread/resume' : 'thread/start';
    const params = {
      ...(this.threadId ? { threadId: this.threadId } : {}),
      cwd: this.workspace(),
      approvalPolicy: codexApprovalPolicy(this.env),
      sandbox: codexSandbox(this.env),
      developerInstructions: remoteAgentStandingPrompt(this.agent),
    };
    this.sendRequest(method, params);
  }

  async deliver(message = {}, workItem = null, deliveryId = '') {
    const prompt = deliveryPrompt(this.agent, message, workItem);
    if (!this.started) await this.start();
    if (!this.threadId) {
      this.pendingPrompts.push({ prompt, message, workItem, deliveryId });
      return;
    }
    this.startTurn(prompt, message, workItem, deliveryId);
  }

  startTurn(prompt, message = {}, workItem = null, deliveryId = '') {
    if (!this.threadId) return false;
    this.activeDeliveryId = deliveryId || '';
    this.activeTurnToolSignatures = new Set();
    this.activeTurnUsedSendMessage = false;
    const model = this.agent.model || undefined;
    const effort = this.agent.reasoningEffort || undefined;
    const params = {
      threadId: this.threadId,
      input: [{ type: 'text', text: prompt }],
      approvalPolicy: codexApprovalPolicy(this.env),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    };
    const requestId = this.activeTurnId
      ? this.sendRequest('turn/steer', { threadId: this.threadId, expectedTurnId: this.activeTurnId, input: params.input })
      : this.sendRequest('turn/start', params);
    if (!requestId) return false;
    this.pending.set(requestId, {
      ...(this.pending.get(requestId) || {}),
      sourceMessage: message,
      workItem,
    });
    this.lastSourceMessage = message;
    this.responseBuffer = '';
    if (this.activeDeliveryId) {
      this.markDelivery(this.activeDeliveryId, 'started', {
            agentId: this.agent.id,
            sessionKey: this.sessionKey || null,
            messageId: message?.id || null,
        workItemId: workItem?.id || message?.workItemId || null,
      }).catch((error) => {
        logWarning('daemon', `Failed to update delivery ledger for ${this.activeDeliveryId}: ${error.message}`);
      });
    }
    this.sendStatus('thinking', { source: '@magclaw/daemon', detail: 'Turn started', at: now() });
    return true;
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk.toString();
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const payload = JSON.parse(line);
        this.codexMessageQueue = this.codexMessageQueue
          .then(() => this.handleCodexMessage(payload))
          .catch((error) => {
            this.send({ type: 'agent:activity', agentId: this.agent.id, status: this.status, activity: { source: 'codex-stdout', error: error.message, at: now() } });
          });
      } catch (error) {
        this.send({
          type: 'agent:activity',
          agentId: this.agent.id,
          status: this.status,
          activity: { source: 'codex-stdout', error: error.message, at: now() },
        });
      }
    }
  }

  async handleCodexMessage(message) {
    if (message.id !== undefined && (message.result || message.error)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        this.send({ type: 'agent:error', agentId: this.agent.id, error: message.error.message || 'Codex request failed.' });
        if (this.activeDeliveryId) await this.markDelivery(this.activeDeliveryId, 'failed', { error: message.error.message || 'Codex request failed.' });
        this.sendStatus('error', { source: '@magclaw/daemon', error: message.error.message || 'Codex request failed.', at: now() });
        return;
      }
      if (pending?.method === 'thread/start' || pending?.method === 'thread/resume') {
        this.threadId = message.result?.thread?.id || message.result?.threadId || this.threadId;
        this.send({ type: 'agent:session', agentId: this.agent.id, status: 'idle', sessionId: this.threadId, sessionKey: this.sessionKey || null });
        this.sendStatus('idle', { source: '@magclaw/daemon', detail: 'Codex session ready', at: now() });
        const queued = this.pendingPrompts.splice(0);
        for (const item of queued) this.startTurn(item.prompt, item.message, item.workItem, item.deliveryId);
      } else if (pending?.method === 'turn/start' || pending?.method === 'turn/steer') {
        this.activeTurnId = message.result?.turn?.id || message.result?.turnId || this.activeTurnId;
      }
      return;
    }

    const method = message.method || '';
    const params = message.params || {};
    if (method && message.id !== undefined && message.id !== null) {
      if (isCodexPermissionRequest(method)) {
        this.handleCodexPermissionRequest(method, message.id, params);
        return;
      }
      if (method === 'item/tool/call') {
        const handled = await this.executeCodexToolItem(params.item || params, message.id, params);
        if (!handled) this.sendErrorResponse(message.id, -32602, `Unsupported dynamic tool request: ${codexToolName(params.item || params) || '(unnamed)'}`);
        return;
      }
      if (method === 'mcpServer/elicitation/request') {
        this.sendResponse(message.id, { action: 'accept' });
        return;
      }
    }
    if (method === 'thread/started') {
      this.threadId = params.thread?.id || params.threadId || this.threadId;
      this.send({ type: 'agent:session', agentId: this.agent.id, status: 'idle', sessionId: this.threadId, sessionKey: this.sessionKey || null });
      return;
    }
    if (method === 'turn/started') {
      this.activeTurnId = params.turn?.id || params.turnId || this.activeTurnId;
      this.sendStatus('working', { source: '@magclaw/daemon', detail: 'Codex turn running', turnId: this.activeTurnId || null, at: now() });
      return;
    }
    if (method === 'item/agentMessage/delta' || method === 'response/output_text/delta') {
      this.responseBuffer += String(params.delta || params.text || '');
      this.queueCodexStreamActivity();
      return;
    }
    if (method === 'item/completed') {
      const item = params.item || {};
      if (await this.executeCodexToolItem(item, null, params)) return;
      const text = item?.text || item?.message || params.text || '';
      if (text) this.responseBuffer += String(text);
      return;
    }
    if (method === 'turn/completed' || method === 'turn/failed') {
      this.flushCodexStreamActivity();
      const body = this.responseBuffer.trim();
      if (body && method === 'turn/completed' && !this.activeTurnUsedSendMessage) {
        const frame = {
          type: 'agent:message',
          agentId: this.agent.id,
          deliveryId: this.activeDeliveryId || null,
          payload: {
            body,
            message: this.lastSourceMessage || null,
            sourceMessage: this.lastSourceMessage || null,
            spaceType: this.lastSourceMessage?.spaceType || 'channel',
            spaceId: this.lastSourceMessage?.spaceId || 'chan_all',
            parentMessageId: this.lastSourceMessage?.parentMessageId || null,
            idempotencyKey: this.activeDeliveryId || null,
          },
        };
        this.send(frame);
        if (this.activeDeliveryId) await this.markDelivery(this.activeDeliveryId, 'completed', { resultFrame: frame });
      }
      if (this.activeDeliveryId && method === 'turn/completed') {
        await this.markDelivery(this.activeDeliveryId, 'completed');
      } else if (this.activeDeliveryId && method === 'turn/failed') {
        await this.markDelivery(this.activeDeliveryId, 'failed', { error: 'Turn failed' });
      }
      this.responseBuffer = '';
      this.activeTurnId = '';
      this.activeTurnUsedSendMessage = false;
      this.sendStatus(method === 'turn/completed' ? 'idle' : 'error', {
        source: '@magclaw/daemon',
        detail: method === 'turn/completed' ? 'Turn completed' : 'Turn failed',
        at: now(),
      });
      this.activeDeliveryId = '';
      return;
    }
    this.send({
      type: 'agent:activity',
      agentId: this.agent.id,
      status: this.status || 'working',
      activity: { source: 'codex-event', method, at: now() },
    });
  }

  stop() {
    this.status = 'stopping';
    this.flushCodexStreamActivity();
    if (this.child) this.child.kill('SIGTERM');
  }
}

class ClaudeAgentSession {
  constructor({ agent, profile, paths, serverUrl, token, send, markDelivery = null, onStatusChange = null, env = process.env }) {
    this.agent = agent;
    this.profile = profile;
    this.paths = paths;
    this.serverUrl = serverUrl;
    this.token = token;
    this.send = send;
    this.markDelivery = typeof markDelivery === 'function' ? markDelivery : async () => {};
    this.onStatusChange = typeof onStatusChange === 'function' ? onStatusChange : () => {};
    this.env = env;
    this.child = null;
    this.status = 'offline';
    this.started = false;
    this.activeDeliveryId = '';
  }

  agentDir() {
    return path.join(this.paths.agentsDir, safeFilePart(this.agent.id));
  }

  workspace() {
    return path.join(this.agentDir(), 'workspace');
  }

  async prepare() {
    await mkdir(this.workspace(), { recursive: true });
    await prepareRuntimeHooks({
      agentDir: this.agentDir(),
      workspace: this.workspace(),
      runtimeKind: 'claude-code',
    });
    await writeFile(path.join(this.workspace(), 'AGENTS.md'), [
      '# MagClaw Remote Claude Agent Workspace',
      '',
      'This workspace is isolated for a MagClaw cloud-connected Claude Code agent.',
      '',
    ].join('\n'));
  }

  sendStatus(status, activity = null) {
    this.status = status;
    this.onStatusChange(this, status);
    this.send({
      type: 'agent:status',
      agentId: this.agent.id,
      status,
      deliveryId: this.activeDeliveryId || null,
      sessionId: null,
      activity: activity || {
        source: 'claude-code',
        status,
        at: now(),
      },
    });
  }

  async start() {
    if (this.started) return;
    await this.prepare();
    this.started = true;
    this.sendStatus('idle', { source: 'claude-code', detail: 'Claude Code runner ready', at: now() });
  }

  async deliver(message = {}, workItem = null, deliveryId = '') {
    await this.start();
    this.activeDeliveryId = deliveryId || '';
    const prompt = deliveryPrompt(this.agent, message, workItem);
    const claudeCommand = this.env.CLAUDE_PATH || 'claude';
    const args = ['--print'];
    if (this.agent.model) args.push('--model', String(this.agent.model));
    args.push(prompt);
    const timeoutMs = Number(this.env.MAGCLAW_DAEMON_RUNTIME_TIMEOUT_MS || 10 * 60 * 1000);
    if (this.activeDeliveryId) {
      await this.markDelivery(this.activeDeliveryId, 'started', {
        agentId: this.agent.id,
        messageId: message?.id || null,
        workItemId: workItem?.id || message?.workItemId || null,
      });
    }
    this.sendStatus('thinking', { source: 'claude-code', detail: 'Claude Code turn started', at: now() });
    await new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (status, detail) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.child = null;
        if (status === 'idle') {
          const body = stdout.trim();
          if (body) {
            const frame = {
              type: 'agent:message',
              agentId: this.agent.id,
              deliveryId: this.activeDeliveryId || null,
              payload: {
                body,
                message,
                sourceMessage: message,
                spaceType: message.spaceType || 'channel',
                spaceId: message.spaceId || 'chan_all',
                parentMessageId: message.parentMessageId || null,
                idempotencyKey: this.activeDeliveryId || null,
              },
            };
            this.send(frame);
            this.markDelivery(this.activeDeliveryId, 'completed', { resultFrame: frame }).catch(() => {});
          }
          this.markDelivery(this.activeDeliveryId, 'completed').catch(() => {});
          this.sendStatus('idle', { source: 'claude-code', detail: detail || 'Claude Code turn completed', at: now() });
        } else {
          const error = detail || stderr.trim() || 'Claude Code failed.';
          this.send({ type: 'agent:error', commandId: this.activeDeliveryId || undefined, deliveryId: this.activeDeliveryId || null, agentId: this.agent.id, error });
          this.markDelivery(this.activeDeliveryId, 'failed', { error }).catch(() => {});
          this.sendStatus('error', { source: 'claude-code', error, at: now() });
        }
        this.activeDeliveryId = '';
        resolve();
      };
      this.child = spawn(claudeCommand, args, {
        cwd: this.workspace(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...agentEnvironment(this.agent, this.env),
          NO_COLOR: '1',
          MAGCLAW_AGENT_ID: this.agent.id,
          MAGCLAW_DAEMON_PROFILE: this.profile,
          MAGCLAW_SERVER_URL: this.serverUrl,
          MAGCLAW_MACHINE_TOKEN: this.token,
        },
      });
      const timer = setTimeout(() => {
        if (this.child) this.child.kill('SIGTERM');
        finish('error', 'Claude Code session timed out.');
      }, timeoutMs);
      this.child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        this.send({
          type: 'agent:activity',
          agentId: this.agent.id,
          status: 'working',
          activity: { source: 'claude-code', chars: stdout.length, at: now() },
        });
      });
      this.child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      this.child.on('error', (error) => finish('error', error.message));
      this.child.on('close', (code, signal) => {
        if (code === 0) finish('idle');
        else finish('error', stderr.trim() || `Claude Code exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.`);
      });
    });
  }

  stop() {
    this.status = 'stopping';
    if (this.child) this.child.kill('SIGTERM');
    this.started = false;
  }
}

class MagClawDaemon {
  constructor(config, env = process.env) {
    this.env = env;
    this.config = config;
    this.paths = profilePaths(config.profile, env);
    this.socket = null;
    this.request = null;
    this.sessions = new Map();
    this.closed = false;
    this.heartbeatTimer = null;
    this.inboundWatchdogTimer = null;
    this.lastInboundAt = null;
    this.lastInboundKind = '';
    this.reconnectDelayMs = envInteger(env, 'MAGCLAW_DAEMON_RECONNECT_MIN_MS', DEFAULT_DAEMON_RECONNECT_MIN_MS, { min: 100, max: 60_000 });
    this.reconnectMinMs = this.reconnectDelayMs;
    this.reconnectMaxMs = envInteger(env, 'MAGCLAW_DAEMON_RECONNECT_MAX_MS', DEFAULT_DAEMON_RECONNECT_MAX_MS, { min: this.reconnectMinMs, max: 5 * 60_000 });
    this.heartbeatIntervalMs = envInteger(env, 'MAGCLAW_DAEMON_HEARTBEAT_MS', DEFAULT_DAEMON_HEARTBEAT_MS, { min: 5_000, max: 5 * 60_000 });
    this.inboundWatchdogMs = envInteger(env, 'MAGCLAW_DAEMON_INBOUND_WATCHDOG_MS', DEFAULT_DAEMON_INBOUND_WATCHDOG_MS, { min: 0, max: 10 * 60_000 });
    this.maxActiveAgentSessions = envInteger(env, 'MAGCLAW_AGENT_MAX_ACTIVE_SESSIONS', 2, { min: 1, max: 100 });
    this.maxActiveComputerSessions = envInteger(env, 'MAGCLAW_COMPUTER_MAX_ACTIVE_SESSIONS', 8, { min: 1, max: 500 });
    this.maxConcurrentAgentStarts = envInteger(env, 'MAGCLAW_DAEMON_MAX_CONCURRENT_AGENT_STARTS', DEFAULT_MAX_CONCURRENT_AGENT_STARTS, { min: 1, max: 100 });
    this.agentStartIntervalMs = envInteger(env, 'MAGCLAW_DAEMON_AGENT_START_INTERVAL_MS', DEFAULT_AGENT_START_INTERVAL_MS, { min: 0, max: 60_000 });
    this.agentStartQueue = [];
    this.agentStartPromises = new Map();
    this.agentStartPumpTimer = null;
    this.activeAgentStartCount = 0;
    this.lastAgentStartAt = 0;
    this.lastAgentStartAgentId = '';
    this.pendingSessionDeliveries = [];
    this.drainingSessionDeliveries = false;
    this.daemonRunId = `${process.pid}:${Date.now()}`;
    this.deliveryLedgerCache = null;
    this.deliveryLedgerQueue = Promise.resolve();
    this.pendingUpgradeRequest = null;
    this.upgradeIdleTimer = null;
    this.upgradeWorkerStarting = false;
  }

  send(payload) {
    if (!this.socket || this.socket.destroyed) return false;
    sendJsonFrame(this.socket, payload);
    return true;
  }

  async loadDeliveryLedger() {
    if (this.deliveryLedgerCache) return this.deliveryLedgerCache;
    const ledger = await readJsonFile(this.paths.deliveryLedger, { records: [] });
    const records = Array.isArray(ledger.records) ? ledger.records : [];
    this.deliveryLedgerCache = {
      version: 1,
      updatedAt: ledger.updatedAt || now(),
      records: records
        .filter((record) => record && record.deliveryId)
        .map((record) => ({
          ...record,
          deliveryId: String(record.deliveryId),
          status: String(record.status || 'accepted'),
          updatedAt: record.updatedAt || record.acceptedAt || now(),
        })),
    };
    return this.deliveryLedgerCache;
  }

  pruneDeliveryLedger(ledger) {
    const cutoff = Date.now() - DELIVERY_LEDGER_RETENTION_MS;
    ledger.records = ledger.records
      .filter((record) => {
        if (['accepted', 'started'].includes(record.status)) return true;
        const updatedAt = Date.parse(record.updatedAt || record.completedAt || record.acceptedAt || '');
        return !Number.isFinite(updatedAt) || updatedAt >= cutoff;
      })
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
      .slice(0, DELIVERY_LEDGER_LIMIT);
    ledger.updatedAt = now();
  }

  async updateDeliveryLedger(mutator) {
    const task = this.deliveryLedgerQueue
      .catch(() => {})
      .then(async () => {
        const ledger = await this.loadDeliveryLedger();
        const result = await mutator(ledger);
        this.pruneDeliveryLedger(ledger);
        await writeJsonFile(this.paths.deliveryLedger, ledger);
        return result;
      });
    this.deliveryLedgerQueue = task.then(() => {}, () => {});
    return task;
  }

  async acceptDelivery(message, agent) {
    const deliveryId = String(message.commandId || message.deliveryId || '').trim();
    if (!deliveryId) return { duplicate: false, record: null };
    const payload = message.payload || {};
    const sourceMessage = payload.message || {};
    const workItem = payload.workItem || {};
    return this.updateDeliveryLedger((ledger) => {
      const timestamp = now();
      let record = ledger.records.find((item) => item.deliveryId === deliveryId);
      const isDuplicate = Boolean(record && (
        ['completed', 'failed', 'stopped'].includes(record.status)
        || (record.runId === this.daemonRunId && ['accepted', 'started'].includes(record.status))
      ));
      if (!record) {
        record = { deliveryId };
        ledger.records.unshift(record);
      }
      if (isDuplicate) {
        record.updatedAt = timestamp;
        record.lastDuplicateAt = timestamp;
        record.duplicateCount = Number(record.duplicateCount || 0) + 1;
        return { duplicate: true, record: { ...record } };
      }
      Object.assign(record, {
        status: 'accepted',
        runId: this.daemonRunId,
        agentId: agent?.id || message.agentId || record.agentId || '',
        messageId: sourceMessage.id || message.messageId || record.messageId || null,
        workItemId: workItem.id || sourceMessage.workItemId || message.workItemId || record.workItemId || null,
        idempotencyKey: message.idempotencyKey || record.idempotencyKey || null,
        acceptedAt: timestamp,
        updatedAt: timestamp,
      });
      return { duplicate: false, record: { ...record } };
    });
  }

  async markDelivery(deliveryId, status, meta = {}) {
    const id = String(deliveryId || '').trim();
    if (!id) return null;
    return this.updateDeliveryLedger((ledger) => {
      const timestamp = now();
      let record = ledger.records.find((item) => item.deliveryId === id);
      if (!record) {
        record = { deliveryId: id, acceptedAt: timestamp };
        ledger.records.unshift(record);
      }
      record.status = String(status || record.status || 'accepted');
      record.runId = record.runId || this.daemonRunId;
      record.updatedAt = timestamp;
      if (record.status === 'started') record.startedAt = record.startedAt || timestamp;
      if (['completed', 'failed', 'stopped'].includes(record.status)) record.completedAt = record.completedAt || timestamp;
      if (meta.agentId) record.agentId = meta.agentId;
      if (meta.messageId) record.messageId = meta.messageId;
      if (meta.workItemId) record.workItemId = meta.workItemId;
      if (meta.error) record.error = String(meta.error);
      if (meta.resultFrame) record.resultFrame = meta.resultFrame;
      return { ...record };
    });
  }

  async recordReleaseNotice(message) {
    const notice = {
      commandId: String(message.commandId || ''),
      version: String(message.notice?.version || message.version || ''),
      title: String(message.notice?.title || message.title || 'Daemon release notice'),
      body: String(message.notice?.body || message.notice?.message || message.message || ''),
      severity: String(message.notice?.severity || message.severity || 'info'),
      receivedAt: now(),
    };
    const current = await readJsonFile(this.paths.releaseNotices, { notices: [] });
    const notices = Array.isArray(current.notices) ? current.notices : [];
    notices.unshift(notice);
    await writeJsonFile(this.paths.releaseNotices, {
      version: 1,
      updatedAt: notice.receivedAt,
      notices: notices.slice(0, 50),
    });
    return notice;
  }

  daemonIsIdleForUpgrade() {
    if (this.activeAgentStartCount > 0) return false;
    if (this.agentStartQueue.length || this.agentStartPromises.size) return false;
    if (this.pendingSessionDeliveries.length || this.drainingSessionDeliveries) return false;
    return [...this.sessions.values()].every((session) => !this.sessionIsActive(session));
  }

  clearUpgradeIdleTimer() {
    if (!this.upgradeIdleTimer) return;
    clearTimeout(this.upgradeIdleTimer);
    this.upgradeIdleTimer = null;
  }

  scheduleUpgradeIdleCheck() {
    if (!this.pendingUpgradeRequest || this.closed || this.upgradeIdleTimer) return;
    this.upgradeIdleTimer = setTimeout(() => {
      this.upgradeIdleTimer = null;
      this.maybeStartPendingUpgrade().catch((error) => {
        logError('upgrade', `Failed to evaluate pending daemon upgrade: ${error.message}`);
      });
    }, 1000);
    this.upgradeIdleTimer.unref?.();
  }

  async maybeStartPendingUpgrade() {
    if (!this.pendingUpgradeRequest || this.upgradeWorkerStarting) return;
    if (!this.daemonIsIdleForUpgrade()) {
      this.scheduleUpgradeIdleCheck();
      return;
    }
    const request = this.pendingUpgradeRequest;
    this.pendingUpgradeRequest = null;
    this.clearUpgradeIdleTimer();
    await this.startUpgradeWorker(request);
  }

  async startUpgradeWorker(message = {}) {
    const commandId = String(message.commandId || '').trim();
    if (!commandId) return false;
    this.upgradeWorkerStarting = true;
    const targetVersion = String(message.targetVersion || message.version || 'latest').trim() || 'latest';
    const previousVersion = String(message.previousVersion || DAEMON_VERSION).trim() || DAEMON_VERSION;
    const service = await readServiceState(this.paths.profile, this.env);
    if (!service.background) {
      const error = 'Remote daemon upgrade requires a background service. Run `magclaw start` or reconnect with `--background` first.';
      await writeUpgradeHandoff(this.paths.profile, {
        commandId,
        status: 'failed',
        phase: 'background_required',
        progress: 0,
        message: error,
        previousVersion,
        targetVersion,
        error,
      }, this.env);
      this.send({
        type: 'daemon:upgrade:ack',
        commandId,
        status: 'failed',
        phase: 'background_required',
        progress: 0,
        message: error,
        previousVersion,
        targetVersion,
      });
      this.upgradeWorkerStarting = false;
      return false;
    }

    await writeUpgradeHandoff(this.paths.profile, {
      commandId,
      status: 'upgrading',
      phase: 'worker_starting',
      progress: 1,
      message: 'Upgrade worker is starting.',
      previousVersion,
      targetVersion,
      packageSpec: message.packageSpec || '',
      startedAt: now(),
    }, this.env);
    this.send({
      type: 'daemon:upgrade:ack',
      commandId,
      status: 'upgrading',
      phase: 'worker_starting',
      progress: 1,
      previousVersion,
      targetVersion,
      message: 'Upgrade worker is starting.',
    });
    const args = [
      executablePath(),
      'upgrade-worker',
      '--profile',
      this.paths.profile,
      '--command-id',
      commandId,
      '--target-version',
      targetVersion,
      '--previous-version',
      previousVersion,
    ];
    if (message.packageSpec) args.push('--package-spec', String(message.packageSpec));
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
      env: {
        ...this.env,
        MAGCLAW_DAEMON_HOME: daemonRoot(this.env),
      },
    });
    child.unref();
    logInfo('upgrade', `Started daemon upgrade worker command=${commandId} target=${targetVersion}.`);
    this.upgradeWorkerStarting = false;
    return true;
  }

  async handleDaemonUpgrade(message = {}) {
    const commandId = String(message.commandId || '').trim();
    const targetVersion = String(message.targetVersion || message.version || 'latest').trim() || 'latest';
    const previousVersion = String(message.previousVersion || DAEMON_VERSION).trim() || DAEMON_VERSION;
    if (!commandId) {
      this.send({ type: 'daemon:upgrade:ack', status: 'failed', error: 'Missing commandId.' });
      return;
    }
    await writeUpgradeHandoff(this.paths.profile, {
      commandId,
      status: this.daemonIsIdleForUpgrade() ? 'accepted' : 'queued_until_idle',
      phase: this.daemonIsIdleForUpgrade() ? 'accepted' : 'waiting_for_idle',
      progress: 0,
      message: this.daemonIsIdleForUpgrade() ? 'Daemon accepted upgrade command.' : 'Waiting for all Agent work to become idle.',
      previousVersion,
      targetVersion,
      packageSpec: message.packageSpec || '',
      requestedAt: now(),
    }, this.env);
    if (!this.daemonIsIdleForUpgrade()) {
      this.pendingUpgradeRequest = message;
      this.send({
        type: 'daemon:upgrade:ack',
        commandId,
        status: 'queued_until_idle',
        phase: 'waiting_for_idle',
        progress: 0,
        previousVersion,
        targetVersion,
        message: 'Waiting for all Agent work to become idle.',
      });
      this.scheduleUpgradeIdleCheck();
      return;
    }
    await this.startUpgradeWorker(message);
  }

  async readyPayload() {
    const runtimes = await detectRuntimes(this.env);
    const owner = await ensureMachineFingerprint(this.paths.profile, this.env);
    const service = await readServiceState(this.paths.profile, this.env);
    const upgrade = await readUpgradeHandoff(this.paths.profile, this.env);
    return {
      type: 'ready',
      computerId: this.config.computerId || null,
      workspaceId: this.config.workspaceId || 'local',
      machineFingerprint: this.config.fingerprint || owner.fingerprint,
      name: this.config.name || os.hostname(),
      hostname: os.hostname(),
      os: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      daemonVersion: DAEMON_VERSION,
      service: {
        mode: service.mode || 'foreground',
        background: Boolean(service.background),
        launcher: service.launcher || '',
        packageSpec: service.packageSpec || '',
      },
      upgrade: upgrade || null,
      runtimes: runtimes.filter((runtime) => runtime.installed).map((runtime) => runtime.id),
      runtimeDetails: runtimes,
      runningAgents: [...this.sessions.keys()],
      capabilities: CAPABILITIES,
    };
  }

  async sendReady() {
    const payload = await this.readyPayload();
    const sent = this.send(payload);
    logInfo(
      'daemon',
      `Sent ready payload for computer ${payload.computerId || 'unpaired'} (runtimes=${payload.runtimes.join(', ') || 'none'}, runningAgents=${payload.runningAgents.length}, sent=${sent}).`,
    );
  }

  sendHeartbeat() {
    const sent = this.send({
      type: 'heartbeat',
      time: now(),
      computerId: this.config.computerId || null,
      daemonVersion: DAEMON_VERSION,
      runningAgents: [...this.sessions.keys()],
    });
    logInfo('daemon', `Sent heartbeat (runningAgents=${this.sessions.size}, sent=${sent}).`);
  }

  startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(), this.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
    this.sendHeartbeat();
  }

  stopHeartbeat() {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  clearInboundWatchdog() {
    if (!this.inboundWatchdogTimer) return;
    clearTimeout(this.inboundWatchdogTimer);
    this.inboundWatchdogTimer = null;
  }

  resetInboundWatchdog() {
    this.clearInboundWatchdog();
    if (!this.inboundWatchdogMs || this.closed || !this.socket || this.socket.destroyed) return;
    this.inboundWatchdogTimer = setTimeout(() => {
      const ageMs = this.lastInboundAt ? Date.now() - this.lastInboundAt : this.inboundWatchdogMs;
      logWarning('network', `No inbound daemon traffic for ${Math.round(ageMs / 1000)}s; reconnecting.`);
      this.socket?.destroy(new Error('Inbound watchdog timed out.'));
    }, this.inboundWatchdogMs);
    this.inboundWatchdogTimer.unref?.();
  }

  markInbound(kind) {
    this.lastInboundAt = Date.now();
    this.lastInboundKind = String(kind || 'message');
    this.resetInboundWatchdog();
  }

  enqueueAgentStart(agentId, startFn) {
    const key = String(agentId || '').trim();
    if (!key) return Promise.resolve().then(startFn);
    const existing = this.agentStartPromises.get(key);
    if (existing) return existing;
    const promise = new Promise((resolve, reject) => {
      this.agentStartQueue.push({ agentId: key, startFn, resolve, reject });
      logInfo('agent', `Agent start queued (${key}); queue=${this.agentStartQueue.length}, active=${this.activeAgentStartCount}, max=${this.maxConcurrentAgentStarts}.`);
      this.pumpAgentStartQueue();
    });
    this.agentStartPromises.set(key, promise);
    promise.then(
      () => this.agentStartPromises.delete(key),
      () => this.agentStartPromises.delete(key),
    );
    return promise;
  }

  pumpAgentStartQueue() {
    if (this.agentStartPumpTimer) return;
    if (!this.agentStartQueue.length) return;
    if (this.activeAgentStartCount >= this.maxConcurrentAgentStarts) return;
    const next = this.agentStartQueue[0];
    const rateLimited = next?.agentId !== this.lastAgentStartAgentId;
    const elapsed = Date.now() - this.lastAgentStartAt;
    const waitMs = rateLimited ? Math.max(0, this.agentStartIntervalMs - elapsed) : 0;
    if (waitMs > 0) {
      this.agentStartPumpTimer = setTimeout(() => {
        this.agentStartPumpTimer = null;
        this.pumpAgentStartQueue();
      }, waitMs);
      this.agentStartPumpTimer.unref?.();
      return;
    }
    const item = this.agentStartQueue.shift();
    if (!item) return;
    this.activeAgentStartCount += 1;
    this.lastAgentStartAt = Date.now();
    this.lastAgentStartAgentId = item.agentId;
    logInfo('agent', `Agent start dequeued (${item.agentId}); queue=${this.agentStartQueue.length}, active=${this.activeAgentStartCount}.`);
    Promise.resolve()
      .then(item.startFn)
      .then(item.resolve, item.reject)
      .finally(() => {
        this.activeAgentStartCount = Math.max(0, this.activeAgentStartCount - 1);
        this.pumpAgentStartQueue();
        this.maybeStartPendingUpgrade().catch((error) => {
          logWarning('upgrade', `Failed to start pending daemon upgrade after agent start finished: ${error.message}`);
        });
      });
  }

  async handleFrame(message) {
    const frameType = String(message?.type || 'unknown');
    logInfo('daemon', `Received ${frameType}`);
    switch (frameType) {
      case 'pairing:accepted':
        this.config.computerId = message.computerId;
        this.config.workspaceId = message.workspaceId || this.config.workspaceId || 'local';
        this.config.token = message.machineToken;
        this.config.pairToken = '';
        await saveProfile(this.paths.profile, this.config, this.env);
        logInfo('daemon', `Paired computer ${message.computerId}.`);
        await this.sendReady();
        break;
      case 'connected':
        this.config.computerId = message.computerId || this.config.computerId;
        this.config.workspaceId = message.workspaceId || this.config.workspaceId;
        await saveProfile(this.paths.profile, this.config, this.env);
        await this.sendReady();
        break;
      case 'ready:ack':
        logInfo('daemon', `MagClaw daemon ready for computer ${message.computerId || this.config.computerId}.`);
        break;
      case 'ping':
        this.send({ type: 'pong', time: now() });
        break;
      case 'server:draining':
        logWarning('daemon', `MagClaw cloud is draining (${message.reason || 'rolling upgrade'}); reconnecting.`);
        this.socket?.end();
        break;
      case 'daemon:release_notice':
        {
          const notice = await this.recordReleaseNotice(message);
          logInfo('daemon', `Release notice received${notice.version ? ` for ${notice.version}` : ''}: ${notice.title}`);
          this.send({
            type: 'daemon:release_notice:ack',
            commandId: message.commandId || null,
            version: notice.version || null,
            receivedAt: notice.receivedAt,
          });
        }
        break;
      case 'daemon:upgrade':
        await this.handleDaemonUpgrade(message);
        break;
      case 'agent:start':
        await this.handleAgentStart(message);
        break;
      case 'agent:restart':
        await this.handleAgentRestart(message);
        break;
      case 'agent:deliver':
        await this.handleAgentDeliver(message);
        break;
      case 'agent:stop':
        await this.handleAgentStop(message);
        break;
      case 'agent:activity_probe':
        this.handleAgentActivityProbe(message);
        break;
      case 'agent:skills:list':
        await this.handleAgentSkillsList(message);
        break;
      case 'machine:runtime_models:detect':
        this.send({ type: 'machine:runtime_models:result', commandId: message.commandId, runtimes: await detectRuntimes(this.env) });
        break;
      case 'token:revoked':
        logError('daemon', 'Machine token was revoked by the server.');
        this.close();
        process.exitCode = 2;
        break;
      default:
        logWarning('network', `Unhandled server frame: ${message.type || 'unknown'}`);
        break;
    }
  }

  async handleAgentSkillsList(message) {
    const existing = message.agentId
      ? [...this.sessions.values()].find((session) => session.agent?.id === message.agentId) || null
      : null;
    const agent = existing?.agent || message.payload?.agent || { id: message.agentId, name: message.agentId || 'Agent', runtime: 'codex' };
    try {
      const session = existing || this.sessionFor(agent);
      const skills = typeof session.listSkills === 'function'
        ? await session.listSkills()
        : { agent: { id: agent.id, name: agent.name || agent.id }, global: [], workspace: [], plugin: [], tools: [] };
      this.send({ type: 'agent:skills:list_result', commandId: message.commandId, agentId: agent.id, skills });
      this.send({ type: 'agent:ack', commandId: message.commandId, agentId: agent.id, status: session.status || 'idle' });
    } catch (error) {
      this.send({ type: 'agent:skills:list_result', commandId: message.commandId, agentId: agent.id, skills: { agent: { id: agent.id, name: agent.name || agent.id }, global: [], workspace: [], plugin: [], tools: [], error: error.message } });
      this.send({ type: 'agent:error', commandId: message.commandId, agentId: agent.id, error: error.message });
    }
  }

  sessionIsActive(session) {
    if (!session || session.child?.killed) return false;
    if (session.activeTurnId) return true;
    if (session.pendingPrompts?.length || session.pending?.size) return true;
    return ['starting', 'thinking', 'working', 'running'].includes(String(session.status || '').toLowerCase());
  }

  activeSessionCountForAgent(agentId) {
    return [...this.sessions.values()].filter((session) => (
      session.agent?.id === agentId && this.sessionIsActive(session)
    )).length;
  }

  activeSessionCountForComputer() {
    return [...this.sessions.values()].filter((session) => this.sessionIsActive(session)).length;
  }

  canUseSessionSlot(agent, mapKey) {
    const existing = this.sessions.get(mapKey);
    if (existing && this.sessionIsActive(existing)) return true;
    return this.activeSessionCountForAgent(agent.id) < this.maxActiveAgentSessions
      && this.activeSessionCountForComputer() < this.maxActiveComputerSessions;
  }

  queueSessionDelivery(message, agent, sessionKey, mapKey) {
    this.pendingSessionDeliveries.push({
      message,
      agent,
      sessionKey,
      mapKey,
      queuedAt: now(),
    });
    logInfo('daemon', `Queued delivery ${message.commandId || '(missing)'} for ${agent.id} session ${sessionKey}; active session limit reached.`);
  }

  async drainPendingSessionDeliveries() {
    if (this.drainingSessionDeliveries || !this.pendingSessionDeliveries.length) return;
    this.drainingSessionDeliveries = true;
    try {
      let progressed = true;
      while (progressed) {
        progressed = false;
        for (let index = 0; index < this.pendingSessionDeliveries.length; index += 1) {
          const item = this.pendingSessionDeliveries[index];
          if (!this.canUseSessionSlot(item.agent, item.mapKey)) continue;
          this.pendingSessionDeliveries.splice(index, 1);
          index -= 1;
          progressed = true;
          const payload = item.message.payload || {};
          const session = this.sessionFor(item.agent, {
            sessionKey: item.sessionKey,
            workspaceId: item.message.workspaceId || payload.workspaceId || '',
            message: payload.message || {},
          });
          if (!session.started) await this.enqueueAgentStart(item.agent.id, () => session.start());
          await session.deliver(payload.message || {}, payload.workItem || null, item.message.commandId || '');
        }
      }
    } finally {
      this.drainingSessionDeliveries = false;
    }
  }

  sessionFor(agent, context = {}) {
    const sessionKey = context.sessionKey || daemonConversationLaneKey({
      workspaceId: context.workspaceId || this.config.workspaceId || 'local',
      message: context.message || context.payload?.message || {},
      spaceType: context.spaceType || context.payload?.spaceType || '',
      spaceId: context.spaceId || context.payload?.spaceId || '',
      parentMessageId: context.parentMessageId || context.payload?.parentMessageId || null,
    });
    const mapKey = daemonAgentSessionMapKey(agent.id, sessionKey);
    const existing = this.sessions.get(mapKey);
    if (existing) return existing;
    const kind = agentRuntimeKind(agent);
    const SessionClass = kind === 'codex'
      ? CodexAgentSession
      : kind === 'claude-code'
        ? ClaudeAgentSession
        : null;
    if (!SessionClass) throw new Error(`Unsupported runtime: ${agent.runtime || agent.runtimeId || 'unknown'}`);
    const session = new SessionClass({
      agent,
      profile: this.paths.profile,
      paths: this.paths,
      serverUrl: this.config.serverUrl,
      token: this.config.token,
      workspaceId: this.config.workspaceId || 'local',
      sessionKey,
      send: (payload) => this.send(payload),
      markDelivery: (deliveryId, status, meta) => this.markDelivery(deliveryId, status, meta),
      onStatusChange: () => {
        this.drainPendingSessionDeliveries().catch((error) => {
          logWarning('daemon', `Failed to drain pending session deliveries: ${error.message}`);
        });
        this.maybeStartPendingUpgrade().catch((error) => {
          logWarning('upgrade', `Failed to start pending daemon upgrade after session status changed: ${error.message}`);
        });
      },
      env: this.env,
    });
    this.sessions.set(mapKey, session);
    return session;
  }

  async handleAgentStart(message) {
    const agent = message.payload?.agent || { id: message.agentId, name: message.agentId || 'Agent' };
    this.send({ type: 'agent:start:ack', commandId: message.commandId, agentId: agent.id, status: 'starting' });
    try {
      const session = this.sessionFor(agent, message.payload || {});
      await this.enqueueAgentStart(agent.id, () => session.start());
    } catch (error) {
      this.send({ type: 'agent:error', commandId: message.commandId, agentId: agent.id, error: error.message });
    }
  }

  async handleAgentRestart(message) {
    const agent = message.payload?.agent || { id: message.agentId, name: message.agentId || 'Agent' };
    const mode = ['restart', 'reset-session', 'full-reset'].includes(message.payload?.mode)
      ? message.payload.mode
      : 'restart';
    this.send({ type: 'agent:ack', commandId: message.commandId, agentId: agent.id, status: 'starting' });
    try {
      const matching = [...this.sessions.entries()].filter(([, session]) => session.agent?.id === agent.id);
      for (const [key, existing] of matching) {
        existing.stop();
        this.sessions.delete(key);
      }
      if (mode === 'reset-session' || mode === 'full-reset') {
        agent.runtimeSessionId = null;
      }
      if (mode === 'full-reset') {
        await rm(path.join(this.paths.agentsDir, safeFilePart(agent.id)), {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 80,
        });
      }
      const session = this.sessionFor(agent, message.payload || {});
      await this.enqueueAgentStart(agent.id, () => session.start());
    } catch (error) {
      this.send({ type: 'agent:error', commandId: message.commandId, agentId: agent.id, error: error.message });
    }
  }

  async handleAgentDeliver(message) {
    const agent = message.payload?.agent || { id: message.agentId, name: message.agentId || 'Agent' };
    try {
      const accepted = await this.acceptDelivery(message, agent);
      if (accepted.duplicate) {
        this.send({
          type: 'agent:deliver:ack',
          commandId: message.commandId,
          deliveryId: message.commandId || null,
          agentId: agent.id,
          duplicate: true,
          deliveryStatus: accepted.record?.status || 'accepted',
        });
        if (accepted.record?.resultFrame) this.send(accepted.record.resultFrame);
        logInfo('daemon', `Re-acked duplicate delivery ${message.commandId || '(missing)'} for ${agent.id}; status=${accepted.record?.status || 'accepted'}.`);
        return;
      }
      const sessionContext = {
        sessionKey: message.payload?.sessionKey || message.sessionKey || '',
        workspaceId: message.workspaceId || message.payload?.workspaceId || '',
        message: message.payload?.message || {},
      };
      const sessionKey = sessionContext.sessionKey || daemonConversationLaneKey({
        workspaceId: sessionContext.workspaceId || this.config.workspaceId || 'local',
        message: sessionContext.message,
      });
      const mapKey = daemonAgentSessionMapKey(agent.id, sessionKey);
      this.send({ type: 'agent:deliver:ack', commandId: message.commandId, agentId: agent.id, status: 'queued' });
      if (!this.canUseSessionSlot(agent, mapKey)) {
        this.queueSessionDelivery(message, agent, sessionKey, mapKey);
        return;
      }
      const session = this.sessionFor(agent, { ...sessionContext, sessionKey });
      if (!session.started) await this.enqueueAgentStart(agent.id, () => session.start());
      await session.deliver(message.payload?.message || {}, message.payload?.workItem || null, message.commandId || '');
    } catch (error) {
      if (message.commandId) await this.markDelivery(message.commandId, 'failed', { agentId: agent.id, error: error.message }).catch(() => {});
      this.send({ type: 'agent:error', commandId: message.commandId, agentId: agent.id, error: error.message });
    }
  }

  async handleAgentStop(message) {
    const agentId = message.agentId || message.payload?.agentId;
    const matching = [...this.sessions.entries()].filter(([, session]) => session.agent?.id === agentId);
    for (const [key, session] of matching) {
      session.stop();
      this.sessions.delete(key);
    }
    if (message.commandId) await this.markDelivery(message.commandId, 'stopped', { agentId }).catch(() => {});
    this.send({ type: 'agent:ack', commandId: message.commandId, agentId, status: 'offline' });
  }

  handleAgentActivityProbe(message) {
    const agentId = message.agentId || message.payload?.agentId;
    const session = [...this.sessions.values()].find((item) => item.agent?.id === agentId) || null;
    const status = session?.status || 'offline';
    this.send({
      type: 'agent:activity',
      agentId,
      status,
      probeId: message.probeId || null,
      activity: {
        source: '@magclaw/daemon',
        detail: session ? `Current daemon runtime status: ${status}` : 'Agent not running on this computer',
        probeId: message.probeId || null,
        at: now(),
      },
    });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const session of this.sessions.values()) session.stop();
    this.sessions.clear();
    this.stopHeartbeat();
    this.clearInboundWatchdog();
    if (this.agentStartPumpTimer) {
      clearTimeout(this.agentStartPumpTimer);
      this.agentStartPumpTimer = null;
    }
    this.clearUpgradeIdleTimer();
    const queuedStarts = this.agentStartQueue.splice(0);
    for (const item of queuedStarts) {
      item.resolve?.();
    }
    this.agentStartPromises.clear();
    if (this.request) {
      this.request.destroy(new Error('MagClaw daemon is shutting down.'));
      this.request = null;
    }
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
    this.socket = null;
  }

  async connectOnce() {
    if (this.closed) return;
    await this.refreshConfigFromDisk();
    const url = toWebSocketUrl(this.config.serverUrl, this.config);
    const requestModule = url.protocol === 'wss:' ? https : http;
    const requestUrl = new URL(url.href.replace(/^ws/, 'http'));
    const key = crypto.randomBytes(16).toString('base64');
    logInfo('daemon', `Connecting MagClaw daemon profile "${this.paths.profile}" to ${this.config.serverUrl}...`);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        this.stopHeartbeat();
        this.clearInboundWatchdog();
        if (this.socket && this.socket.destroyed) this.socket = null;
        if (this.request === req) this.request = null;
        callback(value);
      };
      const req = requestModule.request(requestUrl, {
        method: 'GET',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': key,
        },
      });
      this.request = req;
      req.on('upgrade', (res, socket, head = Buffer.alloc(0)) => {
        if (this.request === req) this.request = null;
        if (res.statusCode !== 101) {
          socket.destroy();
          finish(reject, new Error(`WebSocket upgrade failed: ${res.statusCode}`));
          return;
        }
        if (this.closed) {
          socket.destroy();
          finish(resolve);
          return;
        }
        this.socket = socket;
        this.reconnectDelayMs = this.reconnectMinMs;
        this.markInbound('websocket_open');
        logInfo('daemon', 'Connected to MagClaw cloud; waiting for ready acknowledgement.');
        this.startHeartbeat();
        const connection = { socket, buffer: Buffer.alloc(0) };
        let disconnectLogged = false;
        const logConnectionDrop = (reason) => {
          if (this.closed || disconnectLogged) return;
          disconnectLogged = true;
          logWarning('daemon', `MagClaw cloud connection ${reason}; local agent sessions continue running until reconnect.`);
        };
        const handleChunk = (chunk) => {
          for (const frame of decodeFrames(connection, chunk)) {
            if (frame.opcode === 0x8) {
              this.markInbound('websocket_close');
              socket.end();
              return;
            }
            this.markInbound(frame.opcode === 0x1 ? 'message' : `opcode_${frame.opcode}`);
            if (frame.opcode !== 0x1) continue;
            try {
              this.handleFrame(JSON.parse(frame.text)).catch((error) => {
                this.send({ type: 'error', error: error.message });
              });
            } catch (error) {
              logError('network', `Invalid server frame: ${error.message}`);
            }
          }
        };
        socket.on('data', handleChunk);
        if (head.length) handleChunk(head);
        socket.on('close', () => {
          logConnectionDrop('closed');
          if (this.socket === socket) this.socket = null;
          finish(resolve);
        });
        socket.on('end', () => {
          logConnectionDrop('ended');
          if (this.socket === socket) this.socket = null;
          finish(resolve);
        });
        socket.on('error', (error) => {
          logConnectionDrop(`errored (${error.message})`);
          if (this.socket === socket) this.socket = null;
          if (this.closed) finish(resolve);
          else finish(reject, error);
        });
      });
      req.on('response', (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk.toString(); });
        res.on('end', () => {
          finish(reject, new Error(body || `HTTP ${res.statusCode}`));
        });
      });
      req.on('error', (error) => {
        if (this.closed) finish(resolve);
        else finish(reject, error);
      });
      req.setTimeout(30_000, () => {
        req.destroy(new Error('WebSocket upgrade timed out.'));
      });
      req.end();
    });
  }

  async runForever() {
    while (!this.closed) {
      try {
        await this.connectOnce();
      } catch (error) {
        logError('daemon', `MagClaw daemon connection failed: ${error.message}`);
      }
      if (!this.closed) {
        const delayMs = this.reconnectDelayMs;
        logInfo('daemon', `Reconnecting in ${delayMs}ms.`);
        await sleep(delayMs);
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, this.reconnectMaxMs);
      }
    }
  }

  async refreshConfigFromDisk() {
    const diskConfig = await readProfile(this.paths.profile, this.env);
    const token = String(this.config.token || diskConfig.token || diskConfig.machineToken || diskConfig.apiKey || '').trim();
    const pairToken = token ? '' : String(this.config.pairToken || diskConfig.pairToken || '').trim();
    this.config = {
      ...diskConfig,
      ...this.config,
      profile: this.paths.profile,
      token,
      pairToken,
      workspaceId: this.config.workspaceId || diskConfig.workspaceId || 'local',
    };
  }
}

function executablePath() {
  return path.join(PACKAGE_ROOT, 'bin', 'magclaw-daemon.js');
}

async function writeLauncher(profile, env = process.env) {
  const paths = profilePaths(profile, env);
  await mkdir(paths.runDir, { recursive: true });
  const npmPath = commandExists('npm', env);
  const nodeDir = path.dirname(process.execPath);
  const npmDir = npmPath ? path.dirname(npmPath) : '';
  const commandMode = String(env.MAGCLAW_DAEMON_COMMAND_MODE || '').trim().toLowerCase();
  const useNpmLauncher = Boolean(npmPath) && !['local', 'local-repo', 'repo', 'source'].includes(commandMode);
  const launcher = path.join(paths.runDir, 'launcher.js');
  const fallbackBin = executablePath();
  const previousService = await readServiceState(paths.profile, env);
  const service = await writeServiceState(paths.profile, {
    mode: process.platform === 'darwin' ? 'launchd' : process.platform === 'linux' ? 'systemd' : process.platform === 'win32' ? 'schtasks' : 'foreground',
    background: true,
    launcher,
    packageSpec: env.MAGCLAW_DAEMON_PACKAGE_SPEC || previousService.packageSpec || `@magclaw/daemon@${DAEMON_VERSION}`,
    previousPackageSpec: previousService.previousPackageSpec || '',
    installedDaemonVersion: DAEMON_VERSION,
    commandMode: useNpmLauncher ? 'npm' : 'local',
  }, env);
  const code = [
    '#!/usr/bin/env node',
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    `const npmPath = ${JSON.stringify(npmPath)};`,
    `const useNpmLauncher = ${JSON.stringify(useNpmLauncher)};`,
    `const nodeDir = ${JSON.stringify(nodeDir)};`,
    `const npmDir = ${JSON.stringify(npmDir)};`,
    `const fallbackBin = ${JSON.stringify(fallbackBin)};`,
    `const profile = ${JSON.stringify(paths.profile)};`,
    `const daemonHome = ${JSON.stringify(daemonRoot(env))};`,
    `const serviceFile = ${JSON.stringify(paths.service)};`,
    `const defaultPackageSpec = ${JSON.stringify(service.packageSpec)};`,
    "let service = {};",
    "try { service = JSON.parse(fs.readFileSync(serviceFile, 'utf8')); } catch {}",
    "const packageSpec = String(service.packageSpec || defaultPackageSpec || '@magclaw/daemon@latest');",
    'const command = useNpmLauncher ? npmPath : process.execPath;',
    "const args = useNpmLauncher",
    "  ? ['exec', '--yes', '--package', packageSpec, '--', 'magclaw-daemon', 'connect', '--profile', profile]",
    "  : [fallbackBin, 'connect', '--profile', profile];",
    "const launchPath = [nodeDir, npmDir, process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'].filter(Boolean).join(':');",
    'const child = spawn(command, args, {',
    "  stdio: 'inherit',",
    '  env: { ...process.env, MAGCLAW_DAEMON_HOME: daemonHome, PATH: launchPath },',
    '});',
    "child.on('exit', (code, signal) => {",
    '  if (signal) process.kill(process.pid, signal);',
    '  process.exit(code || 0);',
    '});',
    "child.on('error', (error) => {",
    "  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);",
    "  console.error(`${stamp} ERROR DAEMON ${error.message}`);",
    '  process.exit(1);',
    '});',
    '',
  ].join('\n');
  await writeFile(launcher, code);
  await chmod(launcher, 0o755).catch(() => {});
  return launcher;
}

function launchAgentLabel(profile) {
  return `ai.magclaw.daemon.${safeProfileName(profile)}`;
}

function plistEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function ensureExecutable(file) {
  await chmod(file, 0o755).catch(() => {});
}

async function startMacBackground(profile, env = process.env) {
  const paths = profilePaths(profile, env);
  const label = launchAgentLabel(paths.profile);
  const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const plist = path.join(launchAgentsDir, `${label}.plist`);
  await mkdir(paths.logDir, { recursive: true });
  await mkdir(launchAgentsDir, { recursive: true });
  const launcher = await writeLauncher(paths.profile, env);
  await ensureExecutable(launcher);
  const programArguments = [process.execPath, launcher];
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${plistEscape(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...programArguments.map((item) => `    <string>${plistEscape(item)}</string>`),
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  <string>${plistEscape(path.join(paths.logDir, 'daemon.log'))}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${plistEscape(path.join(paths.logDir, 'daemon.err.log'))}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
  await writeFile(plist, xml);
  spawnSync('launchctl', ['bootout', `gui/${process.getuid()}`, plist], { stdio: 'ignore' });
  const boot = spawnSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, plist], { encoding: 'utf8' });
  if (boot.status !== 0) {
    const load = spawnSync('launchctl', ['load', plist], { encoding: 'utf8' });
    if (load.status !== 0) throw new Error((boot.stderr || load.stderr || 'launchctl failed').trim());
  }
  return { ok: true, mode: 'launchd', label, file: plist };
}

function systemdServiceName(profile) {
  return `magclaw-daemon-${safeProfileName(profile)}.service`;
}

async function startLinuxBackground(profile, env = process.env) {
  const paths = profilePaths(profile, env);
  const serviceName = systemdServiceName(paths.profile);
  const serviceDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const serviceFile = path.join(serviceDir, serviceName);
  await mkdir(paths.logDir, { recursive: true });
  await mkdir(serviceDir, { recursive: true });
  const launcher = await writeLauncher(paths.profile, env);
  await ensureExecutable(launcher);
  await writeFile(serviceFile, [
    '[Unit]',
    `Description=MagClaw daemon (${paths.profile})`,
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${process.execPath} ${launcher}`,
    'Restart=always',
    'RestartSec=3',
    `Environment=MAGCLAW_DAEMON_PROFILE=${paths.profile}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n'));
  const reload = spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8' });
  if (reload.status !== 0) throw new Error((reload.stderr || 'systemctl daemon-reload failed').trim());
  const enable = spawnSync('systemctl', ['--user', 'enable', '--now', serviceName], { encoding: 'utf8' });
  if (enable.status !== 0) throw new Error((enable.stderr || 'systemctl enable failed').trim());
  return { ok: true, mode: 'systemd', serviceName, file: serviceFile };
}

function windowsTaskName(profile) {
  return `MagClaw Daemon ${safeProfileName(profile)}`;
}

async function startWindowsBackground(profile, env = process.env) {
  const paths = profilePaths(profile, env);
  await mkdir(paths.logDir, { recursive: true });
  const launcher = await writeLauncher(paths.profile, env);
  await ensureExecutable(launcher);
  const taskName = windowsTaskName(paths.profile);
  const command = `"${process.execPath}" "${launcher}"`;
  spawnSync('schtasks.exe', ['/Delete', '/TN', taskName, '/F'], { stdio: 'ignore' });
  const create = spawnSync('schtasks.exe', [
    '/Create',
    '/SC',
    'ONLOGON',
    '/TN',
    taskName,
    '/TR',
    command,
    '/RL',
    'LIMITED',
    '/F',
  ], { encoding: 'utf8' });
  if (create.status !== 0) throw new Error((create.stderr || create.stdout || 'schtasks create failed').trim());
  const run = spawnSync('schtasks.exe', ['/Run', '/TN', taskName], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error((run.stderr || run.stdout || 'schtasks run failed').trim());
  return { ok: true, mode: 'schtasks', taskName, file: launcher };
}

async function startBackground(profile, env = process.env) {
  if (process.platform === 'darwin') return startMacBackground(profile, env);
  if (process.platform === 'linux') return startLinuxBackground(profile, env);
  if (process.platform === 'win32') return startWindowsBackground(profile, env);
  return { ok: false, mode: 'foreground', message: 'Background daemon is only automated on macOS launchd, Linux user systemd, and Windows schtasks.' };
}

async function waitForPidExit(pid, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidIsRunning(pid)) return true;
    await sleep(100);
  }
  return !pidIsRunning(pid);
}

async function stopActiveDaemon(profile, env = process.env) {
  const active = await activeDaemonLock(profile, env);
  const pid = Number(active?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return { ok: true, running: false };
  }
  if (pid === process.pid) {
    return { ok: false, running: true, pid, error: 'Refusing to stop the current process.' };
  }

  let signal = 'SIGTERM';
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (error?.code === 'ESRCH') {
      await rm(active.lockFile, { force: true }).catch(() => {});
      return { ok: true, running: false, pid, staleLockRemoved: true };
    }
    return { ok: false, running: true, pid, error: error.message };
  }

  let stopped = await waitForPidExit(pid);
  if (!stopped) {
    signal = 'SIGKILL';
    try {
      process.kill(pid, signal);
      stopped = await waitForPidExit(pid, 1000);
    } catch (error) {
      if (error?.code === 'ESRCH') stopped = true;
      else return { ok: false, running: true, pid, signal, error: error.message };
    }
  }

  if (stopped) {
    await rm(active.lockFile, { force: true }).catch(() => {});
  }
  return { ok: stopped, running: !stopped, pid, signal };
}

function stopBackground(profile, env = process.env) {
  if (process.platform === 'darwin') {
    const paths = profilePaths(profile, env);
    const label = launchAgentLabel(paths.profile);
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}`, plist], { stdio: 'ignore' });
    return { ok: true, mode: 'launchd', label, file: plist };
  }
  if (process.platform === 'linux') {
    const paths = profilePaths(profile, env);
    const serviceName = systemdServiceName(paths.profile);
    const result = spawnSync('systemctl', ['--user', 'disable', '--now', serviceName], { encoding: 'utf8' });
    return { ok: result.status === 0, mode: 'systemd', serviceName, error: result.stderr || '' };
  }
  if (process.platform === 'win32') {
    const paths = profilePaths(profile, env);
    const taskName = windowsTaskName(paths.profile);
    spawnSync('schtasks.exe', ['/End', '/TN', taskName], { stdio: 'ignore' });
    const result = spawnSync('schtasks.exe', ['/Change', '/TN', taskName, '/DISABLE'], { encoding: 'utf8' });
    return { ok: result.status === 0, mode: 'schtasks', taskName, error: result.stderr || result.stdout || '' };
  }
  return { ok: false, mode: 'foreground' };
}

async function stopDaemon(profile, env = process.env) {
  const background = stopBackground(profile, env);
  const processResult = await stopActiveDaemon(profile, env);
  const backgroundRequired = background.mode !== 'foreground';
  return {
    ok: Boolean(processResult.ok && (!backgroundRequired || background.ok)),
    background,
    process: processResult,
  };
}

async function uninstallBackground(profile, env = process.env) {
  const stopped = await stopDaemon(profile, env);
  if (process.platform === 'darwin') {
    const paths = profilePaths(profile, env);
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${launchAgentLabel(paths.profile)}.plist`);
    await rm(plist, { force: true });
  } else if (process.platform === 'linux') {
    const paths = profilePaths(profile, env);
    await rm(path.join(os.homedir(), '.config', 'systemd', 'user', systemdServiceName(paths.profile)), { force: true });
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
  } else if (process.platform === 'win32') {
    const paths = profilePaths(profile, env);
    spawnSync('schtasks.exe', ['/Delete', '/TN', windowsTaskName(paths.profile), '/F'], { stdio: 'ignore' });
  }
  return stopped;
}

async function status(profile) {
  const paths = profilePaths(profile);
  const config = await readProfile(paths.profile);
  const configStat = await stat(paths.config).catch(() => null);
  const lock = await activeDaemonLock(paths.profile);
  const computerLock = await activeComputerLock();
  let service = { mode: 'foreground', active: false };
  if (process.platform === 'darwin') {
    const label = launchAgentLabel(paths.profile);
    const result = spawnSync('launchctl', ['print', `gui/${process.getuid()}/${label}`], { encoding: 'utf8' });
    service = { mode: 'launchd', active: result.status === 0, label };
  } else if (process.platform === 'linux') {
    const serviceName = systemdServiceName(paths.profile);
    const result = spawnSync('systemctl', ['--user', 'is-active', serviceName], { encoding: 'utf8' });
    service = { mode: 'systemd', active: result.status === 0, serviceName, status: String(result.stdout || '').trim() };
  } else if (process.platform === 'win32') {
    const taskName = windowsTaskName(paths.profile);
    const result = spawnSync('schtasks.exe', ['/Query', '/TN', taskName, '/FO', 'LIST'], { encoding: 'utf8' });
    service = { mode: 'schtasks', active: result.status === 0, taskName, status: String(result.stdout || '').trim() };
  }
  return {
    profile: paths.profile,
    configPath: paths.config,
    configured: Boolean(configStat),
    running: Boolean(lock),
    pid: lock?.pid || null,
    lockFile: paths.lockFile,
    computerRunning: Boolean(computerLock),
    computerPid: computerLock?.pid || null,
    serverUrl: config.serverUrl || '',
    computerId: config.computerId || null,
    hasMachineToken: Boolean(config.token),
    hasPairToken: Boolean(config.pairToken),
    service,
  };
}

async function logs(profile) {
  const paths = profilePaths(profile);
  const files = [path.join(paths.logDir, 'daemon.log'), path.join(paths.logDir, 'daemon.err.log')];
  for (const file of files) {
    if (!existsSync(file)) continue;
    process.stdout.write(`\n==> ${file} <==\n`);
    const text = await readFile(file, 'utf8').catch(() => '');
    process.stdout.write(text.split(/\r?\n/).slice(-120).join('\n'));
    process.stdout.write('\n');
  }
}

async function doctor(env = process.env) {
  const runtimes = await detectRuntimes(env);
  return {
    ok: true,
    daemonVersion: DAEMON_VERSION,
    node: process.version,
    platform: process.platform,
    arch: os.arch(),
    profileRoot: daemonRoot(env),
    runtimes,
  };
}

function toUpgradeProgressWebSocketUrl(serverUrl, config = {}, commandId = '') {
  const base = String(serverUrl || DEFAULT_SERVER_URL).replace(/\/+$/, '');
  const wsBase = base.startsWith('https://')
    ? `wss://${base.slice('https://'.length)}`
    : base.startsWith('http://')
      ? `ws://${base.slice('http://'.length)}`
      : base;
  const url = new URL(`${wsBase}/api/daemon-upgrade-progress`);
  url.searchParams.set('computerId', String(config.computerId || ''));
  url.searchParams.set('commandId', String(commandId || ''));
  url.searchParams.set('token', String(config.token || config.machineToken || config.apiKey || ''));
  return url;
}

async function openUpgradeProgressSocket(url) {
  const requestModule = url.protocol === 'wss:' ? https : http;
  const requestUrl = new URL(url.href.replace(/^ws/, 'http'));
  const key = crypto.randomBytes(16).toString('base64');
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = requestModule.request(requestUrl, {
      method: 'GET',
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key,
      },
    });
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      callback(value);
    };
    req.on('upgrade', (res, socket, head = Buffer.alloc(0)) => {
      if (res.statusCode !== 101) {
        socket.destroy();
        finish(reject, new Error(`Upgrade progress WebSocket failed: ${res.statusCode}`));
        return;
      }
      const connection = { socket, buffer: Buffer.alloc(0) };
      let completed = null;
      let closed = false;
      const listeners = new Set();
      const handleChunk = (chunk) => {
        for (const frame of decodeFrames(connection, chunk)) {
          if (frame.opcode === 0x8) {
            socket.end();
            return;
          }
          if (frame.opcode !== 0x1) continue;
          let message = null;
          try {
            message = JSON.parse(frame.text);
          } catch {
            continue;
          }
          if (message?.type === 'daemon:upgrade:complete') completed = message;
          for (const listener of listeners) listener(message);
        }
      };
      socket.on('data', handleChunk);
      if (head.length) handleChunk(head);
      socket.on('close', () => { closed = true; });
      socket.on('end', () => { closed = true; });
      socket.on('error', () => { closed = true; });
      finish(resolve, {
        socket,
        send: (payload) => {
          if (socket.destroyed) return false;
          sendJsonFrame(socket, payload);
          return true;
        },
        close: () => {
          if (!socket.destroyed) socket.end();
        },
        onMessage: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        waitForComplete: (timeoutMs = 120_000) => new Promise((completeResolve) => {
          if (completed) {
            completeResolve(completed);
            return;
          }
          const timer = setTimeout(() => {
            cleanup();
            completeResolve(completed || null);
          }, timeoutMs);
          timer.unref?.();
          const cleanup = () => {
            clearTimeout(timer);
            off();
          };
          const off = listeners.add ? (() => listeners.delete(listener)) : () => {};
          const listener = (message) => {
            if (message?.type !== 'daemon:upgrade:complete') return;
            completed = message;
            cleanup();
            completeResolve(message);
          };
          listeners.add(listener);
          const closeCheck = setInterval(() => {
            if (!closed && !socket.destroyed) return;
            clearInterval(closeCheck);
            if (!completed) {
              cleanup();
              completeResolve(null);
            }
          }, 500);
          closeCheck.unref?.();
        }),
      });
    });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk.toString(); });
      res.on('end', () => finish(reject, new Error(body || `HTTP ${res.statusCode}`)));
    });
    req.on('error', (error) => finish(reject, error));
    req.setTimeout(30_000, () => req.destroy(new Error('Upgrade progress WebSocket timed out.')));
    req.end();
  });
}

function packageSpecForUpgrade(targetVersion, flags = {}, env = process.env) {
  const explicit = String(flags.packageSpec || env.MAGCLAW_DAEMON_UPGRADE_PACKAGE_SPEC || '').trim();
  if (explicit) return explicit;
  const target = String(targetVersion || '').trim();
  return target && target !== 'latest' ? `@magclaw/daemon@${target}` : '@magclaw/daemon@latest';
}

function npmPackageLooksRemote(packageSpec) {
  const value = String(packageSpec || '').trim();
  return value.startsWith('@magclaw/daemon@') || value === '@magclaw/daemon';
}

function preflightPackage(packageSpec, env = process.env) {
  if (env.MAGCLAW_DAEMON_UPGRADE_SKIP_PREFLIGHT === '1') return { ok: true, skipped: true };
  if (!npmPackageLooksRemote(packageSpec)) return { ok: true, skipped: true };
  const npmPath = commandExists('npm', env);
  if (!npmPath) return { ok: false, error: 'npm was not found.' };
  const result = spawnSync(npmPath, ['view', packageSpec, 'version', '--json'], {
    encoding: 'utf8',
    timeout: 45_000,
    env,
  });
  return {
    ok: result.status === 0,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    error: result.status === 0 ? '' : (String(result.stderr || result.stdout || '').trim() || `npm view exited ${result.status}`),
  };
}

async function runUpgradeWorker(flags, env = process.env) {
  const profile = safeProfileName(flags.profile || DEFAULT_PROFILE);
  const config = await buildConfig({ profile }, env);
  const commandId = String(flags.commandId || `local_upgrade_${Date.now()}`).trim();
  const targetVersion = String(flags.targetVersion || flags.version || 'latest').trim() || 'latest';
  const previousVersion = String(flags.previousVersion || DAEMON_VERSION).trim() || DAEMON_VERSION;
  const packageSpec = packageSpecForUpgrade(targetVersion, flags, env);
  const progressIntervalMs = Math.max(100, Math.min(5000, Number(flags.progressIntervalMs || env.MAGCLAW_DAEMON_UPGRADE_PROGRESS_MS || 500) || 500));
  const readyTimeoutMs = Math.max(5000, Math.min(10 * 60_000, Number(flags.readyTimeoutMs || env.MAGCLAW_DAEMON_UPGRADE_READY_TIMEOUT_MS || 120_000) || 120_000));
  const serviceBefore = await readServiceState(profile, env);
  const previousPackageSpec = serviceBefore.packageSpec || `@magclaw/daemon@${previousVersion}`;
  const dryRunPlan = {
    ok: true,
    dryRun: Boolean(flags.dryRun),
    commandId,
    profile,
    currentVersion: DAEMON_VERSION,
    previousVersion,
    targetVersion,
    packageSpec,
    previousPackageSpec,
    service: serviceBefore,
    progressIntervalMs,
    readyTimeoutMs,
  };
  if (flags.dryRun) return dryRunPlan;

  let progressSocket = null;
  let latestProgress = {
    type: 'daemon:upgrade:progress',
    commandId,
    status: 'upgrading',
    phase: 'resolve_target',
    progress: 0,
    message: 'Preparing daemon upgrade.',
    previousVersion,
    targetVersion,
  };
  const emitProgress = async (patch = {}) => {
    latestProgress = {
      ...latestProgress,
      ...patch,
      type: 'daemon:upgrade:progress',
      commandId,
      previousVersion,
      targetVersion,
      time: now(),
    };
    await writeUpgradeHandoff(profile, {
      commandId,
      status: latestProgress.status,
      phase: latestProgress.phase,
      progress: latestProgress.progress,
      message: latestProgress.message,
      previousVersion,
      targetVersion,
      packageSpec,
      error: latestProgress.error || '',
      startedAt: latestProgress.startedAt || undefined,
    }, env);
    progressSocket?.send(latestProgress);
  };

  if (config.computerId && config.token) {
    try {
      progressSocket = await openUpgradeProgressSocket(toUpgradeProgressWebSocketUrl(config.serverUrl, config, commandId));
    } catch (error) {
      logWarning('upgrade', `Progress WebSocket unavailable; continuing local upgrade: ${error.message}`);
    }
  }

  const progressTimer = setInterval(() => {
    progressSocket?.send({ ...latestProgress, time: now() });
  }, progressIntervalMs);
  progressTimer.unref?.();

  let switchedService = false;
  try {
    await emitProgress({ status: 'upgrading', phase: 'resolve_target', progress: 8, message: `Resolved target ${packageSpec}.`, startedAt: now() });
    await emitProgress({ status: 'upgrading', phase: 'download', progress: 25, message: 'Checking package metadata.' });
    const preflight = preflightPackage(packageSpec, env);
    if (!preflight.ok) {
      const error = `Preflight failed: ${preflight.error}`;
      await emitProgress({ status: 'failed', phase: 'preflight', progress: 25, message: error, error });
      return { ok: false, error, phase: 'preflight' };
    }

    await emitProgress({ status: 'upgrading', phase: 'stage_service', progress: 45, message: 'Staging service launcher.' });
    await writeServiceState(profile, {
      mode: serviceBefore.mode || (process.platform === 'darwin' ? 'launchd' : process.platform === 'linux' ? 'systemd' : process.platform === 'win32' ? 'schtasks' : 'foreground'),
      background: true,
      packageSpec,
      previousPackageSpec,
      pendingCommandId: commandId,
      pendingTargetVersion: targetVersion,
    }, env);
    switchedService = true;

    await emitProgress({ status: 'restarting', phase: 'stop_old_daemon', progress: 62, message: 'Stopping current daemon service.' });
    stopBackground(profile, env);
    await sleep(800);

    await emitProgress({ status: 'restarting', phase: 'start_target_daemon', progress: 78, message: 'Starting target daemon service.' });
    const start = await startBackground(profile, env);
    if (!start.ok) throw new Error(start.error || start.message || 'Failed to start target daemon service.');

    await emitProgress({ status: 'restarting', phase: 'wait_ready', progress: 92, message: 'Waiting for upgraded daemon heartbeat.' });
    const complete = progressSocket ? await progressSocket.waitForComplete(readyTimeoutMs) : null;
    if (complete?.status === 'succeeded') {
      await emitProgress({ status: 'succeeded', phase: 'ready', progress: 100, message: 'Daemon upgrade completed.' });
      await writeServiceState(profile, { installedDaemonVersion: targetVersion, pendingCommandId: '', pendingTargetVersion: '' }, env);
      return { ok: true, commandId, targetVersion, packageSpec };
    }
    if (!progressSocket && env.MAGCLAW_DAEMON_UPGRADE_ASSUME_READY === '1') {
      await emitProgress({ status: 'succeeded', phase: 'ready', progress: 100, message: 'Daemon upgrade completed locally.' });
      await writeServiceState(profile, { installedDaemonVersion: targetVersion, pendingCommandId: '', pendingTargetVersion: '' }, env);
      return { ok: true, commandId, targetVersion, packageSpec, assumedReady: true };
    }
    throw new Error('Timed out waiting for upgraded daemon ready acknowledgement.');
  } catch (error) {
    const upgradeError = error?.message || String(error);
    if (!switchedService) {
      await emitProgress({ status: 'failed', phase: latestProgress.phase || 'preflight', progress: latestProgress.progress || 0, message: upgradeError, error: upgradeError });
      return { ok: false, error: upgradeError };
    }
    await emitProgress({ status: 'rollback', phase: 'rollback', progress: 82, message: `Rolling back: ${upgradeError}`, error: upgradeError });
    let rollbackError = '';
    try {
      await writeServiceState(profile, {
        packageSpec: previousPackageSpec,
        previousPackageSpec: packageSpec,
        pendingCommandId: '',
        pendingTargetVersion: '',
      }, env);
      stopBackground(profile, env);
      await sleep(500);
      const restart = await startBackground(profile, env);
      if (!restart.ok) throw new Error(restart.error || restart.message || 'Failed to restart previous daemon service.');
      await emitProgress({ status: 'rollback_succeeded', phase: 'rollback_succeeded', progress: 100, message: 'Rolled back to the previous daemon service.', error: upgradeError });
      return { ok: false, rolledBack: true, error: upgradeError };
    } catch (rollback) {
      rollbackError = rollback?.message || String(rollback);
      await emitProgress({ status: 'rollback_failed', phase: 'rollback_failed', progress: 100, message: `Rollback failed: ${rollbackError}`, error: rollbackError });
      return { ok: false, rolledBack: false, error: upgradeError, rollbackError };
    }
  } finally {
    clearInterval(progressTimer);
    setTimeout(() => progressSocket?.close(), 500).unref?.();
  }
}

async function runManualUpgrade(flags, env = process.env) {
  const plan = await runUpgradeWorker(flags.dryRun ? flags : { ...flags, commandId: flags.commandId || `manual_upgrade_${Date.now()}` }, env);
  printJson(plan);
}

async function buildConfig(flags, env = process.env) {
  const diskConfig = await readProfile(flags.profile, env);
  const profile = flags.profile || diskConfig.profile || DEFAULT_PROFILE;
  const owner = await ensureMachineFingerprint(profile, env);
  const apiKey = flags.apiKey || flags.machineToken || flags.token || '';
  const token = String(apiKey || diskConfig.token || diskConfig.machineToken || '').trim();
  const pairToken = token ? '' : (flags.pairToken || diskConfig.pairToken || '');
  return {
    ...diskConfig,
    ...flags,
    profile,
    serverUrl: String(flags.serverUrl || diskConfig.serverUrl || env.MAGCLAW_PUBLIC_URL || DEFAULT_SERVER_URL).replace(/\/+$/, ''),
    token,
    pairToken,
    workspaceId: flags.workspaceId || flags.workspace || diskConfig.workspaceId || 'local',
    name: flags.displayName || flags.name || diskConfig.name || os.hostname(),
    fingerprint: flags.fingerprint || diskConfig.fingerprint || owner.fingerprint,
  };
}

async function runForegroundDaemon(config, env = process.env) {
  const releaseLock = await acquireDaemonLock(config.profile, config, env);
  const daemon = new MagClawDaemon(config, env);
  let forceExitTimer = null;
  const shutdown = (signal) => {
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    daemon.close();
    forceExitTimer ||= setTimeout(() => process.exit(process.exitCode || 1), 5000);
    forceExitTimer.unref?.();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    await daemon.runForever();
  } finally {
    if (forceExitTimer) clearTimeout(forceExitTimer);
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    await releaseLock();
  }
}

async function runConnect(flags, env = process.env) {
  const config = await buildConfig(flags, env);
  if (!config.pairToken && !config.token) {
    throw new Error('Run connect with --api-key, --pair-token for legacy pairing, or use a saved profile with a machine token.');
  }
  await saveProfile(config.profile, config, env);
  if (flags.background) {
    const result = await startBackground(config.profile, env);
    printJson(result);
    if (!result.ok) {
      logWarning('daemon', 'Falling back to foreground mode.');
      await runForegroundDaemon(config, env);
    }
    return;
  }
  await runForegroundDaemon(config, env);
}

export async function main(argv = process.argv, env = process.env) {
  const { command, flags } = parseCli(argv);
  switch (command) {
    case 'connect':
      await runConnect(flags, env);
      break;
    case 'start': {
      const config = await buildConfig(flags, env);
      await saveProfile(config.profile, config, env);
      printJson(await startBackground(config.profile, env));
      break;
    }
    case 'stop':
      printJson(await stopDaemon(flags.profile, env));
      break;
    case 'restart':
      await stopDaemon(flags.profile, env);
      printJson(await startBackground(flags.profile, env));
      break;
    case 'status':
      printJson(await status(flags.profile));
      break;
    case 'logs':
      await logs(flags.profile);
      break;
    case 'doctor':
      printJson(await doctor(env));
      break;
    case 'upgrade':
      await runManualUpgrade(flags, env);
      break;
    case 'upgrade-worker':
      printJson(await runUpgradeWorker(flags, env));
      break;
    case 'uninstall':
      printJson(await uninstallBackground(flags.profile, env));
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}
