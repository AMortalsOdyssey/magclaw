import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, copyFile, cp, lstat, mkdir, open, readFile, readdir, readlink, realpath, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderListProfiles, shouldUseColor } from './list-renderer.js';
import {
  buildTeamMemorySyncPackageFromTranscript,
  installTeamMemoryHookConfig,
  parseTeamMemoryTranscript,
} from './team-memory-hooks.js';
import {
  checkTeamSharingUpgrade,
  convertTeamSharingProjectToMemoryConfig,
  disableTeamSharingSkill,
  initTeamSharingProject,
  installTeamSharingHooks,
  installTeamSharingSkill,
  listTeamSharingProjects,
  loginTeamSharingProfile,
  logoutTeamSharingProfile,
  readTeamSharingProfileConfig,
  readTeamSharingProjectConfig,
  removeTeamSharingHooks,
  removeTeamSharingSkill,
  setTeamSharingProjectEnabled,
  setupTeamSharing,
  statusTeamSharingProject,
  statusTeamSharingHooks,
  statusTeamSharingSkill,
  teamSharingPaths,
  unsetTeamSharingProject,
  whoamiTeamSharingProfile,
} from './team-sharing.js';

export {
  checkTeamSharingUpgrade,
  disableTeamSharingSkill,
  initTeamSharingProject,
  installTeamSharingHooks,
  installTeamSharingSkill,
  listTeamSharingProjects,
  loginTeamSharingProfile,
  logoutTeamSharingProfile,
  removeTeamSharingHooks,
  removeTeamSharingSkill,
  setTeamSharingProjectEnabled,
  setupTeamSharing,
  statusTeamSharingProject,
  statusTeamSharingHooks,
  statusTeamSharingSkill,
  teamSharingPaths,
  unsetTeamSharingProject,
  whoamiTeamSharingProfile,
} from './team-sharing.js';

export const DEFAULT_PROFILE = 'default';
export const DEFAULT_SERVER_URL = 'http://127.0.0.1:6543';
const DEFAULT_DAEMON_HEARTBEAT_MS = 25_000;
const DEFAULT_DAEMON_INBOUND_WATCHDOG_MS = 15_000;
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
export const CLI_CORE_VERSION = DAEMON_VERSION;
const DAEMON_PACKAGE_NAME = '@magclaw/daemon';
const COMPUTER_PACKAGE_NAME = '@magclaw/computer';
const KNOWN_ENTRY_PACKAGE_NAMES = new Set([DAEMON_PACKAGE_NAME, COMPUTER_PACKAGE_NAME]);
const SOURCE_CODEX_HOME = path.resolve(process.env.MAGCLAW_CODEX_HOME_SOURCE || process.env.CODEX_HOME || path.join(os.homedir(), '.codex'));
const CODEX_HOME_SHARED_ENTRIES = ['auth.json', 'plugins', 'vendor_imports'];
export const CAPABILITIES = [
  'agent:start',
  'agent:restart',
  'agent:deliver',
  'agent:stop',
  'agent:skills:list',
  'daemon:upgrade',
  'daemon:close',
  'daemon:release_notice',
  'machine:runtime_models:detect',
];

function now() {
  return new Date().toISOString();
}

function claudeStreamEvents(raw) {
  if (!raw || typeof raw !== 'object') return [];
  const event = raw;
  const output = [];
  if (event.type === 'system' && event.subtype === 'init') {
    output.push({
      type: 'system',
      sessionId: event.session_id || event.sessionId || '',
      model: event.model || '',
      cwd: event.cwd || '',
    });
    return output;
  }
  const content = Array.isArray(event.message?.content) ? event.message.content : [];
  if (event.type === 'assistant') {
    for (const block of content) {
      if (block?.type === 'text' && typeof block.text === 'string' && block.text) {
        output.push({ type: 'text', delta: block.text });
      } else if (block?.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
        output.push({ type: 'thinking', delta: block.thinking });
      } else if (block?.type === 'tool_use' && block.id && block.name) {
        output.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input });
      }
    }
    return output;
  }
  if (event.type === 'user') {
    for (const block of content) {
      if (block?.type === 'tool_result' && block.tool_use_id) {
        output.push({
          type: 'tool_result',
          id: block.tool_use_id,
          output: typeof block.content === 'string' ? block.content : JSON.stringify(block.content),
          isError: block.is_error === true,
        });
      }
    }
    return output;
  }
  if (event.type === 'result') {
    if (event.usage) {
      output.push({
        type: 'usage',
        inputTokens: event.usage.input_tokens,
        outputTokens: event.usage.output_tokens,
        costUsd: event.total_cost_usd,
      });
    }
    output.push({ type: 'done', sessionId: event.session_id || event.sessionId || '' });
  }
  return output;
}

function claudeToolActivityDetail(event) {
  if (!event || typeof event !== 'object') return 'Claude Code activity';
  if (event.type === 'tool_use') return `Claude Code using ${event.name || 'tool'}`;
  if (event.type === 'tool_result') return event.isError ? 'Claude Code tool returned an error' : 'Claude Code tool completed';
  if (event.type === 'thinking') return 'Claude Code thinking';
  if (event.type === 'usage') return `Claude Code usage input=${event.inputTokens || 0} output=${event.outputTokens || 0}`;
  return 'Claude Code activity';
}

function codexStderrRuntimeError(text = '') {
  const detail = String(text || '').trim();
  if (!detail) return '';
  const lower = detail.toLowerCase();
  if (lower.includes('responses_websocket') && lower.includes('error')) return detail.slice(0, 2000);
  if (lower.includes('failed to connect to websocket') && lower.includes('/v1/responses')) return detail.slice(0, 2000);
  if (lower.includes('authentication') && lower.includes('openai')) return detail.slice(0, 2000);
  if (lower.includes('not logged in') || lower.includes('login is required')) return detail.slice(0, 2000);
  return '';
}

function packageInfoFromSpec(packageSpec = '') {
  const match = String(packageSpec || '').trim().match(/^(@magclaw\/(?:daemon|computer))(?:@(.+))?$/);
  return {
    name: match?.[1] || '',
    version: match?.[2] || '',
  };
}

function normalizeEntryPackageName(value = '', fallback = DAEMON_PACKAGE_NAME) {
  const clean = String(value || '').trim();
  if (KNOWN_ENTRY_PACKAGE_NAMES.has(clean)) return clean;
  return fallback;
}

function packageKindForPackageName(packageName = '') {
  return normalizeEntryPackageName(packageName) === COMPUTER_PACKAGE_NAME ? 'computer' : 'daemon';
}

function packageBinForPackageName(packageName = '') {
  return packageKindForPackageName(packageName) === 'computer' ? 'magclaw-computer' : 'magclaw';
}

function packageSpecForPackageName(packageName = DAEMON_PACKAGE_NAME, version = 'latest') {
  const name = normalizeEntryPackageName(packageName);
  const cleanVersion = String(version || '').trim() || 'latest';
  return cleanVersion === 'latest' ? `${name}@latest` : `${name}@${cleanVersion}`;
}

function runtimePackageInfo(env = process.env, service = {}) {
  const envSpec = String(env.MAGCLAW_DAEMON_PACKAGE_SPEC || '').trim();
  const serviceSpec = String(service.packageSpec || '').trim();
  const parsed = packageInfoFromSpec(envSpec || serviceSpec);
  const packageName = normalizeEntryPackageName(
    env.MAGCLAW_ENTRY_PACKAGE_NAME
      || env.MAGCLAW_DAEMON_PACKAGE_NAME
      || service.packageName
      || parsed.name,
  );
  const packageVersion = String(
    env.MAGCLAW_ENTRY_PACKAGE_VERSION
      || env.MAGCLAW_DAEMON_PACKAGE_VERSION
      || service.packageVersion
      || parsed.version
      || DAEMON_VERSION,
  ).trim();
  const packageKind = String(
    env.MAGCLAW_DAEMON_PACKAGE_KIND
      || service.packageKind
      || packageKindForPackageName(packageName),
  ).trim().toLowerCase() === 'computer' ? 'computer' : 'daemon';
  const packageBin = String(
    env.MAGCLAW_DAEMON_PACKAGE_BIN
      || service.packageBin
      || packageBinForPackageName(packageName),
  ).trim() || packageBinForPackageName(packageName);
  const packageSpec = envSpec || serviceSpec || packageSpecForPackageName(packageName, packageVersion || 'latest');
  return {
    name: packageName,
    version: packageVersion,
    kind: packageKind,
    bin: packageBin,
    spec: packageSpec,
  };
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

function computerChannelPath(env = process.env) {
  return path.join(daemonRoot(env), 'channel');
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

function sleepSync(ms) {
  const timeout = Math.max(0, Number(ms) || 0);
  if (!timeout) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, timeout);
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

function readJsonFileSync(file, fallback = {}) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonFileSync(file, value) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readServiceStateSync(profile = DEFAULT_PROFILE, env = process.env) {
  const paths = profilePaths(profile, env);
  return readJsonFileSync(paths.service, {});
}

function activeDaemonLockSync(profile = DEFAULT_PROFILE, env = process.env) {
  const paths = profilePaths(profile, env);
  const lock = readJsonFileSync(paths.lockFile, null);
  if (lock?.pid && pidIsRunning(lock.pid)) {
    return {
      profile: paths.profile,
      ...lock,
      lockFile: paths.lockFile,
    };
  }
  return null;
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
      throw new Error(`MagClaw daemon profile "${paths.profile}" is already running with pid ${active.pid}. Run "magclaw stop --profile ${paths.profile}" before starting another daemon.`);
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
  const positionals = [];
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (item === '-h') {
      flags.help = true;
      continue;
    }
    if (item === '-V') {
      flags.version = true;
      continue;
    }
    if (!item.startsWith('--')) {
      positionals.push(item);
      continue;
    }
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
  flags._ = positionals;
  flags.profileExplicit = Boolean(flags.profile);
  flags.profile = safeProfileName(flags.profile || process.env.MAGCLAW_DAEMON_PROFILE || DEFAULT_PROFILE);
  return { command, flags };
}

function renderHelp() {
  return [
    `MagClaw daemon CLI ${DAEMON_VERSION}`,
    '',
    'Usage: magclaw <command> [options]',
    '',
    'Commands:',
    '  connect      Connect this Computer to MagClaw Cloud (foreground by default)',
    '  computer     Pair this local computer with a server using browser approval',
    '  start        Start a saved background daemon profile',
    '  restart      Restart a saved background daemon profile',
    '  stop         Stop a daemon profile',
    '  status       Show daemon status for one profile',
    '  list         List local daemon profiles and connected Computers',
    '  logs         Print recent daemon logs for one profile',
    '  install-cli  Install or repair durable magclaw command shims',
    '  memory       Configure and use MagClaw team-memory sync',
    '  team-sharing Configure MagClaw Team Sharing setup, login, hooks, and skill',
    '  skills       Install or manage MagClaw feature skills',
    '  hooks        Install or manage MagClaw feature hooks',
    '  upgrade      Upgrade the background daemon package',
    '  doctor       Show runtime and environment diagnostics',
    '  uninstall    Stop and remove the background daemon service',
    '  restore      Legacy alias for restart',
    '  help         Show this help',
    '',
    'Common options:',
    '  --profile <name>       Profile/server slug (default: default)',
    '  --server-url <url>     MagClaw Cloud URL',
    '  --api-key <key>        Machine API key for connect',
    '  --background           Install and run as a background service',
    '  --disable              With stop: suppress background relaunch until next start',
    '  --bin-dir <path>       install-cli target directory',
    '  --to <version>         Upgrade target version (default: latest)',
    '  --wait-cloud           Wait for Cloud heartbeat during manual upgrade',
    '  --dry-run              Preview upgrade actions without restarting',
    '  --force                Overwrite an existing MagClaw CLI shim',
    '  --json                 Print machine-readable output for list',
    '  -h, --help             Show this help',
    '',
    'Examples:',
    '  magclaw computer setup /my-server --server-url https://magclaw.example.com',
    '  magclaw status --profile my-server',
    '  magclaw restart --profile my-server',
    '  magclaw upgrade --profile my-server --to latest',
    '  magclaw stop --profile my-server',
    '  magclaw list',
    '',
  ].join('\n');
}

function renderComputerHelp(subcommand = '') {
  const command = String(subcommand || '').trim();
  const usage = {
    login: [
      'Usage: magclaw-computer login [options] <serverSlug>',
      '',
      'Start MagClaw browser approval for one server. This is an alias for setup.',
      '',
      'Options:',
      '  --server-url <url>  MagClaw Cloud URL',
      '  --name <name>       Computer display name',
      '  --no-start          Save the approved profile without starting the daemon',
      '  -h, --help          Show this help',
    ],
    attach: [
      'Usage: magclaw-computer attach [options] <serverSlug>',
      '',
      'Attach this Computer to one MagClaw server using browser approval.',
      '',
      'Options:',
      '  --server-url <url>  MagClaw Cloud URL',
      '  --name <name>       Computer display name',
      '  --no-run            Save the approved profile without starting the daemon',
      '  --foreground        Run foreground if background service cannot start',
      '  -h, --help          Show this help',
    ],
    setup: [
      'Usage: magclaw-computer setup [options] <serverSlug>',
      '',
      'Set up this Computer for one server, then start its daemon unless --no-start is set.',
      '',
      'Options:',
      '  --server-url <url>  MagClaw Cloud URL',
      '  --name <name>       Computer display name',
      '  --no-start          Save the approved profile without starting the daemon',
      '  --foreground        Run foreground if background service cannot start',
      '  -h, --help          Show this help',
    ],
    detach: [
      'Usage: magclaw-computer detach <serverSlug>',
      '',
      'Stop one local profile and remove its local attachment state.',
    ],
    status: [
      'Usage: magclaw-computer status [options] [serverSlug]',
      '',
      'Show aggregate Computer state, or one server profile when a slug is provided.',
      '',
      'Options:',
      '  --json      Emit the machine-readable report',
      '  -h, --help  Show this help',
    ],
    start: [
      'Usage: magclaw-computer start [options] [serverSlug]',
      '',
      'Start one saved background daemon profile, or all saved profiles when no slug is provided.',
      '',
      'Options:',
      '  --foreground  Run in this terminal for one selected profile',
    ],
    stop: [
      'Usage: magclaw-computer stop [options] [serverSlug]',
      '',
      'Stop one daemon profile, or all saved profiles when no slug is provided.',
      '',
      'Options:',
      '  --disable  Suppress background relaunch until the next start',
    ],
    doctor: [
      'Usage: magclaw-computer doctor [options] [serverSlug]',
      '',
      'Diagnose local profiles, service state, runtime availability, and stale pidfiles.',
      '',
      'Options:',
      '  --json      Emit the machine-readable report',
      '  --cleanup   Clear stale local locks while diagnosing',
      '  --fix       Alias for --cleanup',
    ],
    logs: [
      'Usage: magclaw-computer logs [options] [serverSlug]',
      '',
      'Print recent daemon logs for one attached server profile.',
      '',
      'Options:',
      '  --lines <n>      Number of trailing lines to print (default 120)',
      '  --server <slug>  Select a server profile',
    ],
    runners: [
      'Usage: magclaw-computer runners <command> [options]',
      '',
      'Computer runner control plane.',
      '',
      'Commands:',
      '  list            List local daemon profiles and known Computer bindings',
      '  stop <agentId>  Not available locally; stop Agents from the MagClaw web console',
    ],
    channel: [
      'Usage: magclaw-computer channel [set <channel>]',
      '',
      'Show or set the local Computer release channel (latest | alpha | pinned:<semver>).',
    ],
    upgrade: [
      'Usage: magclaw-computer upgrade [options]',
      '',
      'Upgrade the background Computer package for a saved profile.',
      '',
      'Options:',
      '  --dry-run                  Preview upgrade actions',
      '  --channel <name>           latest | alpha | pinned:<semver>',
      '  --target-version <semver>  Explicit target version',
      '  --force                    Accepted for MagClaw compatibility; currently maps to the normal upgrade path',
    ],
  };
  if (command && usage[command]) return `${usage[command].join('\n')}\n`;
  return [
    `MagClaw Computer CLI ${DAEMON_VERSION}`,
    '',
    'Usage: magclaw-computer [options] [command]',
    '',
    'MagClaw Computer - local-machine control plane (browser approval + per-server profiles).',
    '',
    'Options:',
    '  -V, --version                        output the version number',
    '  -h, --help                           show help for command',
    '',
    'Commands:',
    '  login [options] <serverSlug>          Browser-approved login for one server (alias for setup)',
    '  attach [options] <serverSlug>         Attach this Computer to one server',
    '  setup [options] <serverSlug>          Login/attach if needed, then start',
    '  adopt-legacy [options] <serverSlug>   Migrate from legacy pair-token style setup when possible',
    '  detach <serverSlug>                   Remove one local server attachment',
    '  status [options] [serverSlug]         Show aggregate or per-profile state',
    '  start [options] [serverSlug]          Start one or all saved profiles',
    '  stop [options] [serverSlug]           Stop one or all saved profiles',
    '  doctor [options] [serverSlug]         Diagnose local profiles and runtime state',
    '  logs [options] [serverSlug]           Print one profile daemon log',
    '  runners                              Computer runner control plane',
    '  channel                              Show or set release channel',
    '  upgrade [options]                    Upgrade the Computer package',
    '  help [command]                       show help for command',
    '',
  ].join('\n');
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

export function teamMemoryPaths({ profile = DEFAULT_PROFILE, cwd = process.cwd(), env = process.env } = {}) {
  const home = homeDirForEnv(env) || os.homedir();
  const memoryHome = path.resolve(env.MAGCLAW_MEMORY_HOME || path.join(home, '.magclaw', 'memory'));
  const cleanProfile = safeProfileName(profile || env.MAGCLAW_MEMORY_PROFILE || DEFAULT_PROFILE);
  const projectDir = path.resolve(cwd || process.cwd());
  return {
    profile: cleanProfile,
    memoryHome,
    profilesDir: path.join(memoryHome, 'profiles'),
    profileConfig: path.join(memoryHome, 'profiles', cleanProfile, 'config.json'),
    projectConfig: path.join(projectDir, '.magclaw', 'team-memory.json'),
    projectCursor: path.join(projectDir, '.magclaw', 'team-memory-cursor.json'),
  };
}

function normalizeMemoryServerUrl(value = '') {
  return String(value || DEFAULT_SERVER_URL).replace(/\/+$/, '');
}

export async function loginTeamMemoryProfile(flags = {}, env = process.env) {
  const paths = teamMemoryPaths({ profile: flags.profile || env.MAGCLAW_MEMORY_PROFILE || DEFAULT_PROFILE, env });
  const existing = await readJsonFile(paths.profileConfig, {});
  const token = String(flags.token || flags.apiKey || flags.memoryToken || env.MAGCLAW_MEMORY_TOKEN || existing.token || '').trim();
  const serverUrl = normalizeMemoryServerUrl(flags.serverUrl || existing.serverUrl || env.MAGCLAW_PUBLIC_URL || DEFAULT_SERVER_URL);
  const profile = {
    version: 1,
    profile: paths.profile,
    serverUrl,
    workspaceId: String(flags.workspaceId || flags.workspace || existing.workspaceId || env.MAGCLAW_WORKSPACE_ID || 'local').trim(),
    token,
    tokenScope: ['team_memory:sync', 'team_memory:search', 'team_memory:context', 'team_memory:feedback', 'team_memory:share'],
    updatedAt: now(),
    createdAt: existing.createdAt || now(),
  };
  await writeJsonFile(paths.profileConfig, profile);
  return {
    ok: true,
    profile: paths.profile,
    serverUrl,
    workspaceId: profile.workspaceId,
    hasToken: Boolean(token),
    profileConfig: paths.profileConfig,
  };
}

export async function initTeamMemoryProject(flags = {}, env = process.env) {
  const cwd = path.resolve(flags.cwd || process.cwd());
  const paths = teamMemoryPaths({ profile: flags.profile || env.MAGCLAW_MEMORY_PROFILE || DEFAULT_PROFILE, cwd, env });
  const channel = String(flags.channel || flags.channelId || flags.channelPath || flags._?.[1] || '').trim();
  if (!channel) throw new Error('Usage: magclaw memory init --channel <channelPathOrId>');
  const existing = await readJsonFile(paths.projectConfig, {});
  const projectKey = String(flags.projectKey || existing.projectKey || path.basename(cwd)).trim();
  const config = {
    version: 1,
    enabled: flags.enabled === undefined ? true : !['0', 'false', 'no'].includes(String(flags.enabled).toLowerCase()),
    profile: paths.profile,
    serverUrl: normalizeMemoryServerUrl(flags.serverUrl || existing.serverUrl || env.MAGCLAW_PUBLIC_URL || DEFAULT_SERVER_URL),
    workspaceId: String(flags.workspaceId || flags.workspace || existing.workspaceId || env.MAGCLAW_WORKSPACE_ID || 'local').trim(),
    channelId: String(flags.channelId || (!/^(https?|feishu|lark|mc):/i.test(channel) ? channel : existing.channelId || '')).trim(),
    channelPath: String(flags.channelPath || (/^(https?|feishu|lark|mc):/i.test(channel) ? channel : existing.channelPath || '')).trim(),
    routingMode: 'fixed_single_channel',
    projectKey,
    enabledRuntimes: ['codex', 'claude_code'],
    updatedAt: now(),
    createdAt: existing.createdAt || now(),
  };
  await writeJsonFile(paths.projectConfig, config);
  return {
    ok: true,
    projectConfig: paths.projectConfig,
    profile: paths.profile,
    serverUrl: config.serverUrl,
    workspaceId: config.workspaceId,
    channelId: config.channelId,
    channelPath: config.channelPath,
    projectKey,
  };
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
    serverName: config.serverName || '',
    serverSlug: config.serverSlug || '',
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
  const parsed = packageInfoFromSpec(state.packageSpec || '');
  const packageName = normalizeEntryPackageName(state.packageName || parsed.name || DAEMON_PACKAGE_NAME);
  const packageVersion = String(state.packageVersion || parsed.version || state.installedPackageVersion || state.installedDaemonVersion || '').trim();
  return {
    ...state,
    version: 1,
    profile: paths.profile,
    mode: state.mode || 'foreground',
    background: Boolean(state.background),
    launcher: state.launcher || '',
    packageSpec: state.packageSpec || '',
    packageName,
    packageVersion,
    packageKind: String(state.packageKind || packageKindForPackageName(packageName)).toLowerCase() === 'computer' ? 'computer' : 'daemon',
    packageBin: state.packageBin || packageBinForPackageName(packageName),
    previousPackageSpec: state.previousPackageSpec || '',
    installedDaemonVersion: state.installedDaemonVersion || DAEMON_VERSION,
    installedPackageVersion: state.installedPackageVersion || packageVersion || state.installedDaemonVersion || DAEMON_VERSION,
    remoteClosed: Boolean(state.remoteClosed),
    remoteClosedAt: state.remoteClosedAt || '',
    remoteCloseReason: state.remoteCloseReason || '',
    remoteCloseCommandId: state.remoteCloseCommandId || '',
    updatedAt: state.updatedAt || '',
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

async function clearRemoteClosedServiceState(profile = DEFAULT_PROFILE, env = process.env) {
  return writeServiceState(profile, {
    remoteClosed: false,
    remoteClosedAt: '',
    remoteCloseReason: '',
    remoteCloseCommandId: '',
  }, env);
}

export function daemonRunLaunchedByBackgroundService(env = process.env) {
  return String(env.MAGCLAW_DAEMON_BACKGROUND_SERVICE || '').trim() === '1';
}

function backgroundServiceModeForPlatform(platform = process.platform) {
  if (platform === 'darwin') return 'launchd';
  if (platform === 'linux') return 'systemd';
  if (platform === 'win32') return 'schtasks';
  return 'foreground';
}

function normalizeBackgroundServiceMode(value = '') {
  const mode = String(value || '').trim().toLowerCase();
  if (['container', 'k8s', 'kubernetes', 'pod'].includes(mode)) return 'container';
  if (['launchd', 'systemd', 'schtasks', 'foreground'].includes(mode)) return mode;
  return '';
}

function requestedBackgroundServiceMode(env = process.env, platform = process.platform) {
  return normalizeBackgroundServiceMode(env.MAGCLAW_DAEMON_SERVICE_MODE)
    || normalizeBackgroundServiceMode(env.MAGCLAW_DAEMON_BACKGROUND_MODE)
    || backgroundServiceModeForPlatform(platform);
}

export function serviceStatePatchForDaemonRun(service = {}, env = process.env, platform = process.platform) {
  if (daemonRunLaunchedByBackgroundService(env)) {
    const serviceMode = normalizeBackgroundServiceMode(service.mode);
    return {
      mode: serviceMode && serviceMode !== 'foreground' ? serviceMode : requestedBackgroundServiceMode(env, platform),
      background: true,
    };
  }
  return { mode: 'foreground', background: false };
}

async function markForegroundServiceState(profile = DEFAULT_PROFILE, env = process.env) {
  const packageInfo = runtimePackageInfo(env);
  return writeServiceState(profile, {
    mode: 'foreground',
    background: false,
    launcher: 'foreground',
    packageSpec: packageInfo.spec,
    packageName: packageInfo.name,
    packageVersion: packageInfo.version,
    packageKind: packageInfo.kind,
    packageBin: packageInfo.bin,
    installedDaemonVersion: packageInfo.version || DAEMON_VERSION,
    installedPackageVersion: packageInfo.version || DAEMON_VERSION,
  }, env);
}

async function markDaemonRunServiceState(profile = DEFAULT_PROFILE, env = process.env) {
  if (!daemonRunLaunchedByBackgroundService(env)) return markForegroundServiceState(profile, env);
  const service = await readServiceState(profile, env);
  const packageInfo = runtimePackageInfo(env, service);
  return writeServiceState(profile, {
    ...serviceStatePatchForDaemonRun(service, env),
    packageSpec: packageInfo.spec,
    packageName: packageInfo.name,
    packageVersion: packageInfo.version,
    packageKind: packageInfo.kind,
    packageBin: packageInfo.bin,
    installedDaemonVersion: packageInfo.version || DAEMON_VERSION,
    installedPackageVersion: packageInfo.version || DAEMON_VERSION,
  }, env);
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

function homeDirForEnv(env = process.env) {
  return String(env.HOME || env.USERPROFILE || os.homedir() || '').trim();
}

function uniquePathEntries(entries = []) {
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const value = String(entry || '').trim();
    if (!value) continue;
    const key = durablePathKey(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

export function runtimeSearchPathEntries(env = process.env) {
  const home = homeDirForEnv(env);
  const userEntries = home ? [
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.bun', 'bin'),
    process.platform === 'win32' ? path.join(home, 'AppData', 'Roaming', 'npm') : '',
  ] : [];
  const platformEntries = process.platform === 'darwin'
    ? ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin']
    : process.platform === 'win32'
      ? []
      : ['/usr/local/bin', '/usr/local/sbin'];
  return uniquePathEntries([
    ...pathDirs(env),
    env.NVM_BIN,
    env.VOLTA_HOME ? path.join(env.VOLTA_HOME, 'bin') : '',
    env.BUN_INSTALL ? path.join(env.BUN_INSTALL, 'bin') : '',
    path.dirname(process.execPath),
    ...userEntries,
    ...platformEntries,
  ]);
}

function runtimeDetectionEnv(env = process.env) {
  return {
    ...env,
    PATH: runtimeSearchPathEntries(env).join(path.delimiter),
  };
}

function commandExists(command, env = process.env) {
  const runtimeEnv = runtimeDetectionEnv(env);
  const checker = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [command] : ['-v', command];
  const result = process.platform === 'win32'
    ? commandOutput(checker, args, { env: runtimeEnv, timeoutMs: 1500 })
    : commandOutput('/bin/sh', ['-lc', `command -v ${JSON.stringify(command)}`], { env: runtimeEnv, timeoutMs: 1500 });
  if (result.ok) return selectRuntimeCommandPath(result.stdout, command);
  for (const candidate of runtimeSearchPathEntries(runtimeEnv).map((dir) => path.join(dir, command))) {
    if (existsSync(candidate)) return candidate;
  }
  return '';
}

function shSingleQuote(value) {
  return `'${String(value || '').replace(/'/g, `'\\''`)}'`;
}

function psSingleQuote(value) {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function cmdEnvValue(value) {
  return String(value || '')
    .replace(/\^/g, '^^')
    .replace(/%/g, '%%')
    .replace(/&/g, '^&')
    .replace(/\|/g, '^|')
    .replace(/</g, '^<')
    .replace(/>/g, '^>');
}

function durablePathKey(value) {
  const resolved = path.resolve(String(value || ''));
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function pathLooksEphemeralCli(value) {
  const normalized = path.normalize(String(value || ''));
  const parts = normalized.split(/[\\/]+/);
  if (parts.includes('_npx')) return true;
  if (parts.includes('node-gyp-bin')) return true;
  for (let index = 0; index < parts.length - 1; index += 1) {
    if (parts[index] === 'node_modules' && parts[index + 1] === '.bin') return true;
  }
  return false;
}

function pathDirs(env = process.env) {
  return String(env.PATH || '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean);
}

function directoryIsInPath(dir, env = process.env) {
  const key = durablePathKey(dir);
  return pathDirs(env).some((item) => durablePathKey(item) === key);
}

function pathIsUnder(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function canWriteDirectory(dir, { create = false } = {}) {
  try {
    if (create) await mkdir(dir, { recursive: true });
    else {
      const stats = await stat(dir);
      if (!stats.isDirectory()) return false;
    }
    const probe = path.join(dir, `.magclaw-write-test-${process.pid}-${Date.now()}`);
    await writeFile(probe, '');
    await rm(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

function defaultCliPackageSpec(env = process.env) {
  return String(env.MAGCLAW_CLI_PACKAGE_SPEC || '@magclaw/cli-core@latest').trim() || '@magclaw/cli-core@latest';
}

function defaultComputerCliPackageSpec(env = process.env) {
  return String(env.MAGCLAW_COMPUTER_CLI_PACKAGE_SPEC || '@magclaw/computer@latest').trim() || '@magclaw/computer@latest';
}

function defaultCliNpmPath(env = process.env) {
  return commandExists('npm', env) || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
}

function contentHash(value = '') {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function cliShimTargets({ packageSpec = '@magclaw/cli-core@latest', computerPackageSpec = '@magclaw/computer@latest' } = {}) {
  return [
    {
      command: 'magclaw',
      packageSpec: String(packageSpec || '@magclaw/cli-core@latest').trim() || '@magclaw/cli-core@latest',
    },
    {
      command: 'magclaw-computer',
      packageSpec: String(computerPackageSpec || '@magclaw/computer@latest').trim() || '@magclaw/computer@latest',
    },
  ];
}

export function renderCliShimFiles({
  platform = process.platform,
  npmPath = '',
  packageSpec = '@magclaw/cli-core@latest',
  computerPackageSpec = '@magclaw/computer@latest',
} = {}) {
  const targetPackage = String(packageSpec || '@magclaw/cli-core@latest').trim() || '@magclaw/cli-core@latest';
  const targetComputerPackage = String(computerPackageSpec || '@magclaw/computer@latest').trim() || '@magclaw/computer@latest';
  const targetNpm = String(npmPath || (platform === 'win32' ? 'npm.cmd' : 'npm')).trim() || (platform === 'win32' ? 'npm.cmd' : 'npm');
  const targets = cliShimTargets({ packageSpec: targetPackage, computerPackageSpec: targetComputerPackage });
  if (platform === 'win32') {
    const fallback = path.win32.basename(targetNpm) || 'npm.cmd';
    return targets.flatMap((target) => [
      {
        name: `${target.command}.cmd`,
        command: target.command,
        executable: true,
        content: [
          '@echo off',
          `rem MagClaw CLI shim generated by @magclaw/cli-core ${DAEMON_VERSION}.`,
          'setlocal',
          `set "NPM_BIN=${cmdEnvValue(targetNpm)}"`,
          `if not exist "%NPM_BIN%" set "NPM_BIN=${cmdEnvValue(fallback)}"`,
          `set "PACKAGE_SPEC=${cmdEnvValue(target.packageSpec)}"`,
          'set "ARGS=%*"',
          `"%NPM_BIN%" exec --yes --package "%PACKAGE_SPEC%" -- ${target.command} %ARGS%`,
          'exit /b %ERRORLEVEL%',
          '',
        ].join('\r\n'),
      },
      {
        name: `${target.command}.ps1`,
        command: target.command,
        executable: true,
        content: [
          `# MagClaw CLI shim generated by @magclaw/cli-core ${DAEMON_VERSION}.`,
          `$npmBin = ${psSingleQuote(targetNpm)}`,
          `if (-not (Test-Path -LiteralPath $npmBin)) { $npmBin = ${psSingleQuote(fallback)} }`,
          `$packageSpec = ${psSingleQuote(target.packageSpec)}`,
          `& $npmBin exec --yes --package $packageSpec -- ${target.command} @args`,
          'exit $LASTEXITCODE',
          '',
        ].join('\n'),
      },
    ]);
  }
  const fallback = path.basename(targetNpm) || 'npm';
  return targets.map((target) => (
    {
      name: target.command,
      command: target.command,
      executable: true,
      content: [
        '#!/bin/sh',
        'set -eu',
        `# MagClaw CLI shim generated by @magclaw/cli-core ${DAEMON_VERSION}.`,
        `NPM_BIN=${shSingleQuote(targetNpm)}`,
        `PACKAGE_SPEC=${shSingleQuote(target.packageSpec)}`,
        'if [ ! -x "$NPM_BIN" ]; then',
        `  NPM_BIN=${shSingleQuote(fallback)}`,
        'fi',
        `exec "$NPM_BIN" exec --yes --package "$PACKAGE_SPEC" -- ${target.command} "$@"`,
        '',
      ].join('\n'),
    }
  ));
}

async function chooseCliShimBinDir(options = {}, env = process.env) {
  const explicit = String(options.binDir || options.cliBinDir || env.MAGCLAW_CLI_BIN_DIR || '').trim();
  if (explicit) {
    return { dir: path.resolve(explicit), explicit: true, pathReady: directoryIsInPath(explicit, env) || Boolean(options.binDir || options.cliBinDir) };
  }

  const home = os.homedir();
  const npmDir = path.dirname(defaultCliNpmPath(env));
  const candidates = [
    ...pathDirs(env).filter((dir) => {
      if (pathLooksEphemeralCli(dir)) return false;
      return pathIsUnder(home, dir);
    }),
    path.join(home, '.local', 'bin'),
    path.join(home, 'bin'),
    path.join(home, '.npm-global', 'bin'),
    path.join(home, '.volta', 'bin'),
    path.join(home, '.bun', 'bin'),
    pathIsUnder(home, npmDir) ? npmDir : '',
  ].filter(Boolean);

  for (const dir of [...new Set(candidates.map((item) => path.resolve(item)))]) {
    const create = dir === path.join(home, '.local', 'bin') || dir === path.join(home, 'bin');
    if (await canWriteDirectory(dir, { create })) {
      return { dir, explicit: false, pathReady: directoryIsInPath(dir, env) };
    }
  }

  const fallback = path.join(home, '.magclaw', 'bin');
  await mkdir(fallback, { recursive: true }).catch(() => {});
  return { dir: fallback, explicit: false, pathReady: directoryIsInPath(fallback, env) };
}

function isGeneratedMagClawShim(content = '') {
  return Boolean(
    content.includes('MagClaw CLI shim generated by @magclaw/cli-core')
    || content.includes('MagClaw CLI shim generated by @magclaw/daemon')
    || content.includes('@magclaw/cli-core@')
    || content.includes('@magclaw/daemon@')
    || content.includes('@magclaw/computer@')
  );
}

async function existingDurableMagclawCommand(command = 'magclaw', env = process.env) {
  const existing = commandExists(command, env);
  if (!existing || pathLooksEphemeralCli(existing)) return '';
  const content = await readFile(existing, 'utf8').catch(() => '');
  if (content && !isGeneratedMagClawShim(content)) {
    return '';
  }
  return existing;
}

async function inspectCliShimFile(file, expectedContent) {
  const expectedHash = contentHash(expectedContent);
  let existing = null;
  try {
    existing = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existing === null) {
    return {
      file,
      exists: false,
      generated: true,
      upToDate: false,
      reason: 'missing',
      currentHash: '',
      expectedHash,
    };
  }
  const generated = isGeneratedMagClawShim(existing);
  const currentHash = contentHash(existing);
  return {
    file,
    exists: true,
    generated,
    upToDate: generated && currentHash === expectedHash,
    reason: generated ? (currentHash === expectedHash ? 'current' : 'outdated') : 'non_magclaw_command',
    currentHash,
    expectedHash,
  };
}

async function writeCliShimFile(file, content, { force = false } = {}) {
  const status = await inspectCliShimFile(file, content);
  if (status.exists && !status.generated && !force) {
    const error = new Error(`Refusing to overwrite existing non-MagClaw command: ${file}`);
    error.code = 'EEXIST';
    throw error;
  }
  if (status.upToDate && !force) {
    await chmod(file, 0o755).catch(() => {});
    return {
      ...status,
      changed: false,
      written: false,
    };
  }
  await writeFile(file, content);
  await chmod(file, 0o755).catch(() => {});
  return {
    ...status,
    changed: true,
    written: true,
    upToDate: true,
    reason: force && status.exists ? 'forced' : status.reason,
    previousHash: status.currentHash,
    currentHash: status.expectedHash,
  };
}

async function installCliShim(options = {}, env = process.env) {
  if (env.MAGCLAW_INSTALL_CLI === '0' || options.installCli === false || options.noInstallCli) {
    return { ok: true, command: 'magclaw', installed: false, skipped: true, reason: 'disabled' };
  }
  const existing = await existingDurableMagclawCommand('magclaw', env);
  const existingComputer = await existingDurableMagclawCommand('magclaw-computer', env);
  const target = (existing || existingComputer) && !options.binDir && !options.cliBinDir && !options.force
    ? { dir: path.dirname(existing || existingComputer), explicit: false, pathReady: true }
    : await chooseCliShimBinDir(options, env);
  await mkdir(target.dir, { recursive: true });
  const npmPath = String(options.npmPath || defaultCliNpmPath(env)).trim() || (process.platform === 'win32' ? 'npm.cmd' : 'npm');
  const packageSpec = String(options.packageSpec || options.cliPackageSpec || defaultCliPackageSpec(env)).trim() || '@magclaw/cli-core@latest';
  const computerPackageSpec = String(options.computerPackageSpec || options.computerCliPackageSpec || defaultComputerCliPackageSpec(env)).trim() || '@magclaw/computer@latest';
  const shimFiles = renderCliShimFiles({
    platform: process.platform,
    npmPath,
    packageSpec,
    computerPackageSpec,
  });
  const shimResults = [];
  for (const shim of shimFiles) {
    const file = path.join(target.dir, shim.name);
    const result = await writeCliShimFile(file, shim.content, { force: Boolean(options.force) });
    shimResults.push({
      command: shim.command || shim.name,
      name: shim.name,
      ...result,
    });
  }
  const changedShims = shimResults.filter((shim) => shim.changed);
  const reason = changedShims.length
    ? (changedShims.every((shim) => !shim.exists) ? 'installed' : 'updated')
    : 'already_current';
  return {
    ok: true,
    command: 'magclaw',
    commands: ['magclaw', 'magclaw-computer'],
    installed: changedShims.length > 0,
    updated: changedShims.length > 0,
    binDir: target.dir,
    files: shimResults.map((shim) => shim.file),
    changedFiles: changedShims.map((shim) => shim.file),
    shims: shimResults,
    path: shimResults[0]?.file || '',
    pathReady: Boolean(target.pathReady),
    reason,
    packageSpec,
    computerPackageSpec,
    npmPath,
  };
}

async function tryInstallCliShim(options = {}, env = process.env) {
  try {
    return await installCliShim(options, env);
  } catch (error) {
    return {
      ok: false,
      command: 'magclaw',
      installed: false,
      error: error?.message || String(error),
    };
  }
}

function runtimeVersion(command, env = process.env) {
  const runtimeEnv = runtimeDetectionEnv(env);
  const result = commandOutput(command, ['--version'], { env: runtimeEnv, timeoutMs: 3000 });
  if (!result.ok && result.error?.code === 'ENOENT') return '';
  return result.stdout || result.stderr || '';
}

function codexAppServerCapable(command, env = process.env) {
  const runtimeEnv = runtimeDetectionEnv(env);
  const result = commandOutput(command, ['app-server', '--help'], { env: runtimeEnv, timeoutMs: 3000 });
  if (result.error?.code === 'ENOENT') return false;
  if (result.ok) return true;
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return output.includes('app-server') || output.includes('listen') || output.includes('stdio');
}

function defaultCodexCommand(env = process.env) {
  const runtimeEnv = runtimeDetectionEnv(env);
  const macAppBinary = '/Applications/Codex.app/Contents/Resources/codex';
  const candidates = [env.CODEX_PATH, env.MAGCLAW_CODEX_PATH, macAppBinary, 'codex']
    .map((item) => String(item || '').trim())
    .filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    const command = runtimeCommandHasPathSeparator(candidate)
      ? candidate
      : commandExists(candidate, runtimeEnv) || candidate;
    if (runtimeCommandHasPathSeparator(command) && !existsSync(command)) continue;
    const result = commandOutput(command, ['--version'], { env: runtimeEnv, timeoutMs: 3000 });
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
  const result = commandOutput(command, ['debug', 'models'], { env: runtimeDetectionEnv(env), timeoutMs: 5000 });
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
  const runtimeEnv = runtimeDetectionEnv(env);
  const codexCommand = defaultCodexCommand(runtimeEnv);
  const candidates = [
    {
      id: 'codex',
      name: 'Codex CLI',
      command: codexCommand,
      createSupported: true,
      modelsFor: (command) => codexRuntimeModels(command, runtimeEnv),
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
    const pathValue = runtimeCommandHasPathSeparator(item.command) ? (existsSync(item.command) ? item.command : '') : commandExists(item.command, runtimeEnv);
    const runtimeCommand = pathValue || item.command;
    const installed = Boolean(pathValue);
    const version = installed ? runtimeVersion(runtimeCommand, runtimeEnv) : '';
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
      appServer: item.id === 'codex' && installed ? codexAppServerCapable(runtimeCommand, runtimeEnv) : false,
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
  const machineFingerprint = String(config.fingerprint || config.machineFingerprint || '').trim();
  if (token) url.searchParams.set('token', token);
  else if (pairToken) url.searchParams.set('pair_token', pairToken);
  else url.searchParams.set('token', '');
  if (/^mfp_[a-f0-9]{64}$/i.test(machineFingerprint)) {
    url.searchParams.set('machine_fingerprint', machineFingerprint.toLowerCase());
  }
  const packageName = String(config.packageName || '').trim();
  const packageVersion = String(config.packageVersion || config.daemonVersion || '').trim();
  const packageKind = String(config.packageKind || '').trim();
  const packageSpec = String(config.packageSpec || '').trim();
  const packageBin = String(config.packageBin || '').trim();
  const cliCoreVersion = String(config.cliCoreVersion || '').trim();
  const serviceMode = String(config.serviceMode || '').trim();
  const serviceBackground = Boolean(config.serviceBackground);
  const serviceActive = Boolean(config.serviceActive);
  if (packageName) url.searchParams.set('package_name', packageName);
  if (packageVersion) {
    url.searchParams.set('package_version', packageVersion);
    url.searchParams.set('daemon_version', packageVersion);
  }
  if (packageKind) url.searchParams.set('package_kind', packageKind);
  if (packageSpec) url.searchParams.set('package_spec', packageSpec);
  if (packageBin) url.searchParams.set('package_bin', packageBin);
  if (cliCoreVersion) url.searchParams.set('cli_core_version', cliCoreVersion);
  if (serviceMode) url.searchParams.set('service_mode', serviceMode);
  url.searchParams.set('service_background', String(serviceBackground));
  url.searchParams.set('service_active', String(serviceActive));
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

function codexMcpArgs({ agentId, serverUrl, tokenFile, agentRoot = '' }) {
  return [
    '-c', 'wire_api="responses"',
    '-c', `mcp_servers.magclaw.command=${tomlString(process.execPath)}`,
    '-c', `mcp_servers.magclaw.args=${tomlArray([MCP_BRIDGE_PATH, '--agent-id', agentId, '--base-url', serverUrl, '--token-file', tokenFile, '--agent-root', agentRoot])}`,
    '-c', 'mcp_servers.magclaw.startup_timeout_sec=30',
    '-c', 'mcp_servers.magclaw.tool_timeout_sec=120',
    '-c', 'mcp_servers.magclaw.enabled=true',
    '-c', 'mcp_servers.magclaw.required=false',
  ];
}

function contextArray(value) {
  return Array.isArray(value) ? value : [];
}

function errorDetail(error) {
  const parts = [
    error?.message,
    error?.cause?.code,
    error?.cause?.message,
  ].map((item) => String(item || '').trim()).filter(Boolean);
  return [...new Set(parts)].join(' / ') || 'unknown error';
}

function contextText(value, limit = 1200) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function contextSnippet(value, limit = 240) {
  const text = contextText(value, limit);
  return text.length >= limit ? `${text.slice(0, Math.max(0, limit - 3)).trim()}...` : text;
}

function contextImageMimeFromName(value = '') {
  const name = String(value || '').toLowerCase().split(/[?#]/)[0];
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.gif')) return 'image/gif';
  if (name.endsWith('.svg')) return 'image/svg+xml';
  return '';
}

function contextDataImageUrl(value = '') {
  const text = String(value || '').trim();
  return /^data:image\//i.test(text) ? text : '';
}

function contextImageType(reference = {}) {
  const explicit = String(reference.type || reference.mime || reference.mimeType || '').toLowerCase();
  if (explicit.startsWith('image/')) return explicit;
  const data = contextDataImageUrl(reference.dataUrl || reference.url || reference.downloadUrl);
  if (data) return data.match(/^data:([^;,]+)[;,]/i)?.[1]?.toLowerCase() || 'image';
  return contextImageMimeFromName(reference.name || reference.filename || reference.url || reference.downloadUrl || reference.path || reference.description);
}

function isContextImageReference(reference = {}) {
  return contextImageType(reference).startsWith('image/');
}

function remoteImageUrl(value = '', serverUrl = '', fallbackPath = '') {
  const raw = String(value || '').trim();
  if (contextDataImageUrl(raw)) return raw;
  const base = String(serverUrl || DEFAULT_SERVER_URL).replace(/\/+$/, '');
  const candidate = raw || String(fallbackPath || '').trim();
  if (!candidate) return '';
  if (candidate.startsWith('/')) {
    try {
      return new URL(candidate, base).toString();
    } catch {
      return '';
    }
  }
  if (/^https?:\/\//i.test(candidate)) {
    try {
      const parsed = new URL(candidate);
      if (['0.0.0.0', '127.0.0.1', 'localhost', '::1'].includes(parsed.hostname) && base) {
        return new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, base).toString();
      }
      return parsed.toString();
    } catch {
      return '';
    }
  }
  return '';
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

function renderContextAttachments(pack) {
  const attachments = contextArray(pack?.attachments);
  if (!attachments.length) return '- (none)';
  return attachments.map((item) => {
    const details = [
      item.id ? `id=${item.id}` : '',
      item.messageId ? `from msg=${item.messageId}` : '',
      item.source ? `source=${item.source}` : '',
      item.path ? `path=${item.path}` : '',
      item.url ? `url=${item.url}` : '',
      item.id ? `tool=read_attachment(attachmentId="${item.id}")` : '',
    ].filter(Boolean).join(', ');
    return `- ${item.name || item.filename || item.id || 'attachment'} ${item.type || item.mime || 'file'} ${Number(item.bytes || item.sizeBytes || 0)} bytes${details ? ` (${details})` : ''}`;
  }).join('\n');
}

function renderContextTargetAgentAvatar(pack) {
  const avatar = pack?.targetAgent?.avatar;
  if (!avatar || avatar.kind === 'none') return '';
  const description = avatar.description ? ` (${avatar.description})` : '';
  if (avatar.visualInput !== false && isContextImageReference(avatar)) {
    return `- Your profile avatar: image supplied as visual input${description}. Use it when the user asks what your avatar shows.`;
  }
  return `- Your profile avatar: ${avatar.description || 'configured'}, but no visual input is available.`;
}

function contextParticipantAvatarVisualInputs(pack, targetAgentId = '') {
  return compactContextParticipants(pack, targetAgentId).selected.filter((item) => (
    item.id !== targetAgentId
    && item.type === 'agent'
    && item.avatar
    && item.avatar.kind !== 'none'
    && item.avatar.visualInput !== false
    && isContextImageReference(item.avatar)
  ));
}

function renderContextParticipantAvatarInputs(pack, targetAgentId = '') {
  const visible = contextParticipantAvatarVisualInputs(pack, targetAgentId);
  if (!visible.length) return '';
  const names = visible.map((item) => `@${item.name || item.id}`).join(', ');
  return `- Participant avatar visual inputs: ${names}. Use these when comparing an uploaded image to another Agent avatar; call read_agent_avatar if the relevant Agent is omitted.`;
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
    renderContextTargetAgentAvatar(pack),
    renderContextParticipantAvatarInputs(pack, targetAgentId),
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
    'Visible attachment metadata and original-file tools:',
    renderContextAttachments(pack),
    '',
    renderContextPeerMemory(pack),
    '',
    'Progressive context tools: list_agents, read_agent_profile, read_agent_avatar, read_history, search_messages, list_attachments, read_attachment, search_agent_memory, read_agent_memory, read_agent_file, and list_tasks are available through MagClaw MCP.',
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
    'list_attachments',
    'read_attachment',
    'search_agent_memory',
    'read_agent_memory',
    'read_agent_file',
    'list_agents',
    'read_agent_profile',
    'read_agent_avatar',
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

function pathIsWithinResolvedRoots(resolvedPath, roots = []) {
  const cleanPath = path.resolve(resolvedPath);
  return roots.some((root) => cleanPath === root || cleanPath.startsWith(`${root}${path.sep}`));
}

async function resolvedRoots(roots = []) {
  const resolved = [];
  for (const root of roots) {
    const logical = path.resolve(root);
    if (!resolved.includes(logical)) resolved.push(logical);
    const physical = await realpath(root).catch(() => logical);
    if (!resolved.includes(physical)) resolved.push(physical);
  }
  return resolved;
}

async function ensureWorkspaceSkillsDir(workspace, codexHome = '', agent = {}) {
  const workspaceSkills = path.join(workspace, 'skills');
  const legacyGeneratedSkills = codexHome ? path.join(codexHome, 'skills') : '';
  await mkdir(path.dirname(workspaceSkills), { recursive: true });
  try {
    const existing = await lstat(workspaceSkills);
    if (existing.isSymbolicLink()) {
      const current = await readlink(workspaceSkills);
      const resolved = path.resolve(path.dirname(workspaceSkills), current);
      if (legacyGeneratedSkills && resolved === path.resolve(legacyGeneratedSkills)) {
        await unlink(workspaceSkills);
        await mkdir(workspaceSkills, { recursive: true });
        logInfo('skills', `Repaired workspace skills directory for agent ${agent.id || 'unknown'}.`);
      } else {
        logWarning('skills', `Workspace skills path for agent ${agent.id || 'unknown'} is a custom symlink; leaving it untouched.`);
      }
    } else if (!existing.isDirectory()) {
      logWarning('skills', `Workspace skills path for agent ${agent.id || 'unknown'} is not a directory; leaving it untouched.`);
      return null;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await mkdir(workspaceSkills, { recursive: true });
  }
  return workspaceSkills;
}

async function migrateLegacyAgentSkills(codexHome, workspaceSkills, globalResolvedRoots, agent = {}) {
  const codexSkillsRoot = path.join(codexHome, 'skills');
  if (!workspaceSkills || !existsSync(codexSkillsRoot)) return;
  const entries = await readdir(codexSkillsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === '.system') continue;
    const source = path.join(codexSkillsRoot, entry.name);
    const target = path.join(workspaceSkills, entry.name);
    if (existsSync(target)) continue;
    const sourceInfo = await lstat(source).catch(() => null);
    if (!sourceInfo) continue;
    try {
      if (sourceInfo.isSymbolicLink()) {
        const current = await readlink(source);
        const resolved = path.resolve(path.dirname(source), current);
        if (pathIsWithinResolvedRoots(resolved, globalResolvedRoots)) continue;
        const realTarget = await realpath(resolved).catch(() => resolved);
        if (pathIsWithinResolvedRoots(realTarget, globalResolvedRoots)) continue;
        const targetInfo = await stat(realTarget).catch(() => null);
        if (!targetInfo) continue;
        await symlink(realTarget, target, targetInfo.isDirectory() ? 'dir' : 'file');
        await unlink(source);
      } else {
        await rename(source, target);
      }
      logInfo('skills', `Migrated legacy local skill ${entry.name} for agent ${agent.id || 'unknown'}.`);
    } catch (error) {
      logWarning('skills', `Could not migrate legacy local skill ${entry.name} for agent ${agent.id || 'unknown'}: ${error.message}`);
    }
  }
}

async function linkRuntimeSkillEntry(source, target, agent = {}) {
  const linked = await linkPathEntry(source, target);
  if (linked) return true;
  const existing = await lstat(target).catch(() => null);
  if (existing && !existing.isSymbolicLink() && path.resolve(source) !== path.resolve(target)) {
    logWarning('skills', `Could not link skill ${path.basename(target)} for agent ${agent.id || 'unknown'} because the runtime path is not a symlink.`);
  }
  return false;
}

async function linkSkillRootEntries(sourceRoot, targetRoot, agent = {}, { includeSystem = false } = {}) {
  const desired = new Set();
  if (!sourceRoot || !existsSync(sourceRoot)) return desired;
  const entries = await readdir(sourceRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith('.') && !(includeSystem && entry.name === '.system')) continue;
    const source = path.join(sourceRoot, entry.name);
    if (includeSystem && entry.name === '.system' && (entry.isDirectory() || entry.isSymbolicLink())) {
      desired.add(entry.name);
      const targetSystemRoot = path.join(targetRoot, '.system');
      await mkdir(targetSystemRoot, { recursive: true });
      const systemEntries = await readdir(source, { withFileTypes: true }).catch(() => []);
      for (const systemEntry of systemEntries) {
        if (!systemEntry.isDirectory() && !systemEntry.isSymbolicLink() && !systemEntry.isFile()) continue;
        const systemSource = path.join(source, systemEntry.name);
        const systemTarget = path.join(targetSystemRoot, systemEntry.name);
        await linkRuntimeSkillEntry(systemSource, systemTarget, agent).catch((error) => {
          logWarning('skills', `Could not link system skill ${systemEntry.name} for agent ${agent.id || 'unknown'}: ${error.message}`);
        });
      }
      continue;
    }
    if (!entry.isDirectory() && !entry.isSymbolicLink() && !entry.isFile()) continue;
    desired.add(entry.name);
    const target = path.join(targetRoot, entry.name);
    await linkRuntimeSkillEntry(source, target, agent).catch((error) => {
      logWarning('skills', `Could not link skill ${entry.name} for agent ${agent.id || 'unknown'}: ${error.message}`);
    });
  }
  return desired;
}

async function pruneGeneratedSkillLinks(targetSkillsRoot, desiredNames, agent = {}) {
  const entries = await readdir(targetSkillsRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.system') continue;
    if (desiredNames.has(entry.name)) continue;
    const target = path.join(targetSkillsRoot, entry.name);
    const existing = await lstat(target).catch(() => null);
    if (!existing) continue;
    if (existing.isSymbolicLink()) {
      await unlink(target);
    } else if (entry.name !== '.system') {
      logWarning('skills', `Stale runtime skill ${entry.name} for agent ${agent.id || 'unknown'} was not removed because it is not a symlink.`);
    }
  }
}

async function syncGlobalSkillsIntoAgentHome(codexHome, workspace, agent = {}) {
  const targetSkillsRoot = path.join(codexHome, 'skills');
  await mkdir(targetSkillsRoot, { recursive: true });
  const roots = await globalSkillRoots();
  const globalResolvedRoots = await resolvedRoots(roots);
  const workspaceSkills = await ensureWorkspaceSkillsDir(workspace, codexHome, agent);
  await migrateLegacyAgentSkills(codexHome, workspaceSkills, globalResolvedRoots, agent);
  const desiredNames = new Set();
  for (const sourceSkillsRoot of [...roots].reverse()) {
    for (const name of await linkSkillRootEntries(sourceSkillsRoot, targetSkillsRoot, agent, { includeSystem: true })) desiredNames.add(name);
  }
  for (const name of await linkSkillRootEntries(workspaceSkills, targetSkillsRoot, agent)) desiredNames.add(name);
  await pruneGeneratedSkillLinks(targetSkillsRoot, desiredNames, agent);
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
  const logicalFilePath = path.resolve(filePath);
  const name = firstFrontmatterValue(content, ['name', 'title']) || skillNameFromPath(filePath);
  const description = firstFrontmatterValue(content, ['description', 'summary', 'short_description', 'short-description'])
    || firstMarkdownParagraph(content)
    || 'No description provided.';
  const shortPath = shortenSkillPath(logicalFilePath, context);
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
    'list_attachments',
    'read_attachment',
    'search_agent_memory',
    'read_agent_memory',
    'read_agent_file',
    'list_agents',
    'read_agent_profile',
    'read_agent_avatar',
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

async function listDaemonAgentSkills({ agent, agentDir, workspace, codexHome = '' }) {
  const context = { agentRoot: agentDir, codexHome };
  const roots = await globalSkillRoots();
  const globalSkills = [];
  for (const root of roots) globalSkills.push(...await scanSkillsDir(root, 'global', context));
  const agentRoots = [
    path.join(workspace, 'skills'),
    path.join(agentDir, '.codex', 'skills'),
    path.join(agentDir, '.agents', 'skills'),
  ];
  const agentSkills = [];
  for (const root of agentRoots) agentSkills.push(...await scanSkillsDir(root, 'agent', context));
  const pluginFiles = await findPluginSkillFiles(path.join(SOURCE_CODEX_HOME, 'plugins', 'cache'));
  const pluginSkills = [];
  for (const file of pluginFiles) pluginSkills.push(await parseSkillFile(file, 'plugin', context));
  return {
    agent: {
      id: agent.id,
      name: agent.name || agent.id,
      codexHome: codexHome || undefined,
      workspacePath: workspace,
    },
    global: uniqueSkills(globalSkills),
    workspace: uniqueSkills(agentSkills),
    plugin: uniqueSkills(pluginSkills),
    tools: daemonSkillTools(),
  };
}

const DAEMON_PROGRESSIVE_DISCLOSURE_SECTION = [
  '## 渐进式披露',
  '- 其他 Agent 默认只会先读取本文件；不要假设它们已经看到 `notes/` 或 `workspace/` 中的详细文件。',
  '- 如果信息不足、但已经知道具体需要什么内容，请再次请求明确路径，例如 `read_agent_memory(targetAgentId="<agent-id>", path="notes/profile.md")` 或 `read_agent_file(targetAgentId="<agent-id>", path="workspace/<file>")`。',
  '- 本文件只放入口索引、能力边界和路径线索；详细规则、任务记录和交付物放入 `notes/` 或 `workspace/` 的明确文件。',
].join('\n');

function daemonDefaultAgentMemory(agent = {}) {
  return [
    `# ${agent.name || agent.id || 'Agent'}`,
    '',
    '## 角色',
    agent.description || '通用 MagClaw 协作伙伴。',
    '',
    '## 知识索引',
    '- `notes/profile.md` - 角色边界、稳定能力和回复习惯。',
    '- `notes/channels.md` - 频道成员、频道规范和协作上下文。',
    '- `notes/agents.md` - 其他 Agent 的专长与交接线索。',
    '- `notes/work-log.md` - 任务记录、长期决策和完成产物。',
    '',
    DAEMON_PROGRESSIVE_DISCLOSURE_SECTION,
    '',
    '## 能力',
    '- 暂无经过真实任务验证的稳定能力。',
    '',
    '## 当前上下文',
    '- 暂无需要跨回合延续的任务。',
    '',
    '## 近期工作',
    '- 暂无近期可复用记录。',
    '',
  ].join('\n');
}

function ensureDaemonMemoryGuidance(content, agent = {}) {
  const value = String(content || '').replace(/\s+$/u, '');
  if (/^##\s+渐进式披露\s*$/m.test(value)) return `${value}\n`;
  if (!value.trim()) return daemonDefaultAgentMemory(agent);
  return `${value}\n\n${DAEMON_PROGRESSIVE_DISCLOSURE_SECTION}\n`;
}

async function ensureDaemonAgentWorkspaceRoot(agentRoot, agent = {}) {
  await mkdir(path.join(agentRoot, 'notes'), { recursive: true });
  await mkdir(path.join(agentRoot, 'workspace'), { recursive: true });
  const memoryPath = path.join(agentRoot, 'MEMORY.md');
  if (!existsSync(memoryPath)) {
    await writeFile(memoryPath, daemonDefaultAgentMemory(agent), 'utf8');
  } else {
    const current = await readFile(memoryPath, 'utf8').catch(() => '');
    const next = ensureDaemonMemoryGuidance(current, agent);
    if (next !== current) await writeFile(memoryPath, next, 'utf8');
  }
}

function daemonMemoryHash(content) {
  return crypto.createHash('sha256').update(String(content || '')).digest('hex');
}

function daemonMemoryHeadingForKind(kind) {
  const value = String(kind || '').trim().toLowerCase();
  if (value === 'capability') return '能力';
  if (value === 'preference' || value === 'communication_style') return '当前上下文';
  return '近期工作';
}

function upsertDaemonMemoryBullet(content, heading, bullet) {
  const lines = String(content || '').replace(/\s+$/u, '').split(/\r?\n/);
  const text = String(bullet || '').trim().replace(/^\-\s*/, '');
  if (!text) return `${lines.join('\n')}\n`;
  const bulletLine = `- ${text}`;
  if (lines.some((line) => line.trim() === bulletLine)) return `${lines.join('\n')}\n`;
  const headingIndex = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (headingIndex === -1) {
    return `${lines.join('\n')}\n\n## ${heading}\n${bulletLine}\n`;
  }
  let insertAt = headingIndex + 1;
  while (insertAt < lines.length && lines[insertAt].trim() === '') insertAt += 1;
  lines.splice(insertAt, 0, bulletLine);
  return `${lines.join('\n')}\n`;
}

async function writeDaemonLocalMemory(agentRoot, agent = {}, args = {}) {
  await ensureDaemonAgentWorkspaceRoot(agentRoot, agent);
  const memoryPath = path.join(agentRoot, 'MEMORY.md');
  const summary = String(args.summary || args.content || args.sourceText || '').trim();
  if (!summary) throw new Error('Memory summary is required.');
  const current = await readFile(memoryPath, 'utf8').catch(() => daemonDefaultAgentMemory(agent));
  const heading = daemonMemoryHeadingForKind(args.kind);
  const next = upsertDaemonMemoryBullet(ensureDaemonMemoryGuidance(current, agent), heading, summary);
  await writeFile(memoryPath, next, 'utf8');
  const workLogPath = path.join(agentRoot, 'notes', 'work-log.md');
  const existingLog = await readFile(workLogPath, 'utf8').catch(() => `# ${agent.name || agent.id || 'Agent'} 工作记录\n\n## 记忆写入记录\n`);
  const logLine = `- ${now()} [daemon_write_memory] ${summary}`;
  if (!existingLog.includes(logLine)) {
    await writeFile(workLogPath, `${existingLog.replace(/\s+$/u, '')}\n${logLine}\n`, 'utf8');
  }
  return {
    content: next,
    documentHash: daemonMemoryHash(next),
    path: memoryPath,
  };
}

function normalizeDaemonWorkspaceRelPath(rawRelPath = '') {
  const normalized = path.posix.normalize(`/${String(rawRelPath || '').replace(/\\/g, '/')}`).replace(/^\/+/, '');
  if (!normalized || normalized === '.') return '';
  if (normalized === '..' || normalized.startsWith('../')) return '';
  return normalized;
}

function daemonWorkspaceFileType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'text/markdown';
  if (['.txt', '.log', '.jsonl', '.csv', '.yaml', '.yml'].includes(ext)) return 'text/plain';
  if (ext === '.json') return 'application/json';
  return 'application/octet-stream';
}

function daemonWorkspacePreviewKind(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.md' || ext === '.markdown') return 'markdown';
  if (['.txt', '.log', '.json', '.jsonl', '.csv', '.yaml', '.yml'].includes(ext)) return 'text';
  return 'binary';
}

function safeDaemonWorkspacePath(agentRoot, rawRelPath = '') {
  const relPath = normalizeDaemonWorkspaceRelPath(rawRelPath);
  const first = relPath.split('/')[0] || '';
  if (relPath && !['MEMORY.md', 'notes', 'workspace'].includes(first)) return null;
  if (relPath.split('/').some((part) => part.startsWith('.') || part === '..')) return null;
  const filePath = path.resolve(agentRoot, relPath || '.');
  const root = path.resolve(agentRoot);
  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) return null;
  return { relPath, filePath };
}

async function listDaemonAgentWorkspace(agentRoot, agent = {}, rawRelPath = '') {
  await ensureDaemonAgentWorkspaceRoot(agentRoot, agent);
  const resolved = safeDaemonWorkspacePath(agentRoot, rawRelPath);
  if (!resolved) throw new Error('Agent workspace path must stay inside the agent workspace.');
  const info = await stat(resolved.filePath);
  if (!info.isDirectory()) throw new Error('Agent workspace path must be a directory.');
  const entries = (await readdir(resolved.filePath, { withFileTypes: true }))
    .filter((entry) => !entry.name.startsWith('.'))
    .filter((entry) => resolved.relPath || ['MEMORY.md', 'notes', 'workspace'].includes(entry.name))
    .sort((a, b) => (a.isDirectory() === b.isDirectory()
      ? a.name.localeCompare(b.name)
      : a.isDirectory() ? -1 : 1))
    .slice(0, 300);
  const mapped = [];
  for (const entry of entries) {
    const childRelPath = path.posix.join(resolved.relPath, entry.name);
    const child = safeDaemonWorkspacePath(agentRoot, childRelPath);
    if (!child) continue;
    const childInfo = await stat(child.filePath).catch(() => null);
    if (!childInfo) continue;
    mapped.push({
      id: `${agent.id}:${childRelPath}`,
      name: entry.name,
      path: childRelPath,
      kind: entry.isDirectory() ? 'folder' : 'file',
      type: entry.isDirectory() ? 'folder' : daemonWorkspaceFileType(child.filePath),
      bytes: entry.isDirectory() ? 0 : childInfo.size,
      updatedAt: childInfo.mtime.toISOString(),
      source: 'computer_local',
    });
  }
  return {
    agent: {
      id: agent.id,
      name: agent.name || agent.id,
      workspacePath: agentRoot,
      source: 'computer_local',
    },
    path: resolved.relPath,
    source: 'computer_local',
    entries: mapped,
    truncated: entries.length >= 300,
  };
}

async function readDaemonAgentWorkspaceFile(agentRoot, agent = {}, rawRelPath = 'MEMORY.md') {
  await ensureDaemonAgentWorkspaceRoot(agentRoot, agent);
  const resolved = safeDaemonWorkspacePath(agentRoot, rawRelPath || 'MEMORY.md');
  if (!resolved) throw new Error('Agent workspace file path must stay inside the agent workspace.');
  const info = await stat(resolved.filePath);
  if (!info.isFile()) throw new Error('Agent workspace preview path must be a file.');
  if (info.size > 1024 * 1024) throw new Error('Agent workspace preview is limited to 1048576 bytes.');
  const buffer = await readFile(resolved.filePath);
  const previewKind = daemonWorkspacePreviewKind(resolved.filePath);
  return {
    file: {
      id: `${agent.id}:${resolved.relPath}`,
      agentId: agent.id,
      agentName: agent.name || agent.id,
      name: path.basename(resolved.relPath),
      path: resolved.relPath,
      absolutePath: resolved.filePath,
      type: daemonWorkspaceFileType(resolved.filePath),
      bytes: info.size,
      updatedAt: info.mtime.toISOString(),
      previewKind,
      content: previewKind === 'binary' ? '' : buffer.toString('utf8'),
      source: 'computer_local',
    },
  };
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
    this.activeTurnSawResponseDelta = false;
    this.activeTurnDeltaItemIds = new Set();
    this.codexMessageQueue = Promise.resolve();
    this.streamActivityTimer = null;
    this.pendingStreamActivity = null;
    this.lastRuntimeError = '';
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
    await ensureDaemonAgentWorkspaceRoot(this.agentDir(), this.agent);
    await Promise.all(CODEX_HOME_SHARED_ENTRIES.map((entry) => ensureSymlinkedCodexHomeEntry(this.codexHome(), entry)));
    await prepareRuntimeHooks({
      agentDir: this.agentDir(),
      workspace: this.workspace(),
      codexHome: this.codexHome(),
      runtimeKind: 'codex',
    });
    await syncGlobalSkillsIntoAgentHome(this.codexHome(), this.workspace(), this.agent);
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
      'Agent-specific skills can be installed under `./skills/<skill-name>/SKILL.md`; this path belongs to this agent only.',
      'Runtime-generated adapter directories are not skill install targets.',
      '',
    ].join('\n'));
  }

  async listWorkspace(relPath = '') {
    return listDaemonAgentWorkspace(this.agentDir(), this.agent, relPath);
  }

  async readWorkspaceFile(relPath = 'MEMORY.md') {
    return readDaemonAgentWorkspaceFile(this.agentDir(), this.agent, relPath);
  }

  async listSkills() {
    await this.prepare();
    return listDaemonAgentSkills({
      agent: this.agent,
      agentDir: this.agentDir(),
      workspace: this.workspace(),
      codexHome: this.codexHome(),
    });
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

  async reportRuntimeError(errorText, rawText = '') {
    const error = String(errorText || rawText || 'Codex runtime error.').trim().slice(0, 2000);
    if (!error) return;
    if (this.status === 'error' && this.lastRuntimeError === error) return;
    this.lastRuntimeError = error;
    const activity = {
      source: 'codex-stderr',
      error,
      text: String(rawText || error).trim().slice(0, 2000),
      at: now(),
    };
    this.send({
      type: 'agent:error',
      commandId: this.activeDeliveryId || undefined,
      deliveryId: this.activeDeliveryId || null,
      agentId: this.agent.id,
      error,
    });
    if (this.activeDeliveryId) {
      await this.markDelivery(this.activeDeliveryId, 'failed', {
        agentId: this.agent.id,
        sessionKey: this.sessionKey || null,
        messageId: this.lastSourceMessage?.id || null,
        workItemId: this.lastSourceMessage?.workItemId || null,
        error,
      }).catch((markError) => {
        logWarning('daemon', `Failed to mark delivery ${this.activeDeliveryId} failed after Codex runtime error: ${markError.message}`);
      });
    }
    this.sendStatus('error', activity);
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

  async readAttachmentImageInput(reference = {}) {
    const attachmentId = String(reference.id || reference.attachmentId || reference.attachment_id || '').trim();
    if (!attachmentId) return null;
    try {
      const data = await this.requestMagClawTool('/api/agent-tools/attachments/read', {
        query: {
          agentId: this.agent.id,
          attachmentId,
          maxBytes: 8 * 1024 * 1024,
        },
      });
      const dataUrl = contextDataImageUrl(data?.dataUrl);
      if (!dataUrl || data?.file?.truncated) return null;
      return {
        key: `attachment:${attachmentId}`,
        input: { type: 'image', url: dataUrl },
      };
    } catch (error) {
      logWarning('attachments', `Could not read image attachment ${attachmentId} for agent ${this.agent.id}: ${errorDetail(error)}`);
      return null;
    }
  }

  async imageInputFromContextReference(reference = {}, { preferReadAttachment = false } = {}) {
    if (!isContextImageReference(reference)) return null;
    const dataUrl = contextDataImageUrl(reference.dataUrl || reference.url || reference.downloadUrl);
    if (dataUrl) {
      return {
        key: `url:${dataUrl}`,
        input: { type: 'image', url: dataUrl },
      };
    }
    if (preferReadAttachment) {
      const resolved = await this.readAttachmentImageInput(reference);
      if (resolved) return resolved;
    }
    const url = remoteImageUrl(reference.url || reference.downloadUrl || '', this.serverUrl, reference.description);
    if (url) {
      return {
        key: `url:${url}`,
        input: { type: 'image', url },
      };
    }
    const filePath = String(reference.path || '').trim();
    if (filePath && existsSync(filePath)) {
      return {
        key: `path:${filePath}`,
        input: { type: 'localImage', path: filePath },
      };
    }
    return null;
  }

  async imageInputsForDelivery(message = {}) {
    const inputs = [];
    const seen = new Set();
    const pack = message?.contextPack || {};
    const allAttachments = contextArray(pack.attachments);
    const currentAttachmentIds = new Set(contextArray(message?.attachmentIds).map((id) => String(id || '').trim()).filter(Boolean));
    const attachmentsById = new Map(allAttachments.map((attachment) => [String(attachment?.id || '').trim(), attachment]));
    const attachments = currentAttachmentIds.size
      ? [...currentAttachmentIds].map((id) => attachmentsById.get(id) || { id, type: 'image/*' })
      : allAttachments;
    for (const attachment of attachments) {
      const resolved = await this.imageInputFromContextReference(attachment, { preferReadAttachment: true });
      if (!resolved || seen.has(resolved.key)) continue;
      seen.add(resolved.key);
      inputs.push(resolved.input);
    }
    const avatar = pack?.targetAgent?.avatar || null;
    if (avatar?.visualInput !== false) {
      const resolved = await this.imageInputFromContextReference(avatar);
      if (resolved && !seen.has(resolved.key)) {
        seen.add(resolved.key);
        inputs.push(resolved.input);
      }
    }
    const targetAgentId = String(pack?.targetAgentId || pack?.targetAgent?.id || this.agent.id || '');
    for (const participant of contextArray(pack.participants)) {
      if (participant?.type !== 'agent') continue;
      if (targetAgentId && String(participant.id || '') === targetAgentId) continue;
      const participantAvatar = participant.avatar || null;
      if (!participantAvatar || participantAvatar.visualInput === false || !isContextImageReference(participantAvatar)) continue;
      const resolved = await this.imageInputFromContextReference(participantAvatar);
      if (!resolved || seen.has(resolved.key)) continue;
      seen.add(resolved.key);
      inputs.push(resolved.input);
    }
    return inputs;
  }

  async executeMagClawTool(name, rawArgs = {}) {
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
      case 'list_attachments':
        return this.requestMagClawTool('/api/agent-tools/attachments', {
          query: {
            agentId: args.agentId,
            target: args.target || args.channel,
            workItemId: args.workItemId || args.work_item_id,
            messageId: args.messageId || args.message_id,
            limit: args.limit,
          },
        });
      case 'read_attachment':
        return this.requestMagClawTool('/api/agent-tools/attachments/read', {
          query: {
            agentId: args.agentId,
            attachmentId: args.attachmentId || args.attachment_id || args.id,
            maxBytes: args.maxBytes || args.max_bytes,
            format: args.format,
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
      case 'read_agent_file':
        return this.requestMagClawTool('/api/agent-tools/files/read', {
          query: {
            agentId: args.agentId,
            targetAgentId: args.targetAgentId || args.targetAgent,
            path: args.path,
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
      case 'read_agent_avatar':
        return this.requestMagClawTool('/api/agent-tools/agents/avatar/read', {
          query: {
            agentId: args.agentId,
            targetAgentId: args.targetAgentId || args.targetAgent,
            maxBytes: args.maxBytes || args.max_bytes,
          },
        });
      case 'write_memory':
        {
          const local = await writeDaemonLocalMemory(this.agentDir(), this.agent, args);
          this.requestMagClawTool('/api/agent-tools/memory/mirror', {
            method: 'POST',
            body: {
              agentId: args.agentId,
              content: local.content,
              documentHash: local.documentHash,
              idempotencyKey: `daemon-memory:${this.workspaceId}:${args.agentId}:${local.documentHash}`,
            },
          }).catch((error) => {
            logWarning('agent', `Async MEMORY.md mirror sync failed for ${args.agentId}: ${error.message}`);
          });
          return {
            ok: true,
            status: 'local_applied',
            mirrorSync: 'queued',
            file: {
              path: 'MEMORY.md',
              absolutePath: local.path,
              documentHash: local.documentHash,
            },
            text: 'Memory updated locally. Cloud MEMORY.md mirror sync queued.',
          };
        }
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

  appendCompletedAgentText(text = '', { hadDelta = false } = {}) {
    const value = String(text || '');
    if (!value) return;
    if (hadDelta) {
      if (this.responseBuffer.endsWith(value) || this.responseBuffer.includes(value)) return;
      if (value.startsWith(this.responseBuffer)) this.responseBuffer = value;
      else this.responseBuffer += value;
      return;
    }
    if (!this.responseBuffer.includes(value)) this.responseBuffer += value;
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
      agentRoot: this.agentDir(),
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
      const runtimeError = codexStderrRuntimeError(text);
      if (runtimeError) {
        this.reportRuntimeError(runtimeError, text).catch((error) => {
          logWarning('daemon', `Failed to report Codex runtime error for ${this.agent.id}: ${error.message}`);
        });
        return;
      }
      this.send({
        type: 'agent:activity',
        agentId: this.agent.id,
        status: this.status || 'working',
        deliveryId: this.activeDeliveryId || null,
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
    await this.startTurn(prompt, message, workItem, deliveryId);
  }

  async startTurn(prompt, message = {}, workItem = null, deliveryId = '') {
    if (!this.threadId) return false;
    this.activeDeliveryId = deliveryId || '';
    this.activeTurnToolSignatures = new Set();
    this.activeTurnUsedSendMessage = false;
    this.activeTurnSawResponseDelta = false;
    this.activeTurnDeltaItemIds = new Set();
    this.lastRuntimeError = '';
    const model = this.agent.model || undefined;
    const effort = this.agent.reasoningEffort || undefined;
    const imageInputs = await this.imageInputsForDelivery(message);
    const params = {
      threadId: this.threadId,
      input: [{ type: 'text', text: prompt }, ...imageInputs],
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
        for (const item of queued) await this.startTurn(item.prompt, item.message, item.workItem, item.deliveryId);
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
      const itemId = String(params.itemId || params.item_id || params.item?.id || '');
      if (itemId) this.activeTurnDeltaItemIds.add(itemId);
      this.activeTurnSawResponseDelta = true;
      this.queueCodexStreamActivity();
      return;
    }
    if (method === 'item/completed') {
      const item = params.item || {};
      if (await this.executeCodexToolItem(item, null, params)) return;
      const text = item?.text || item?.message || params.text || '';
      const itemId = String(item?.id || item?.itemId || item?.item_id || '');
      this.appendCompletedAgentText(text, {
        hadDelta: Boolean((itemId && this.activeTurnDeltaItemIds.has(itemId)) || this.activeTurnSawResponseDelta),
      });
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
      this.activeTurnSawResponseDelta = false;
      this.activeTurnDeltaItemIds.clear();
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
    this.responseBuffer = '';
    this.lastSourceMessage = null;
    this.pendingMessageDelta = null;
    this.messageDeltaTimer = null;
    this.trajectoryCoalesceMs = envInteger(this.env, 'MAGCLAW_DAEMON_TRAJECTORY_COALESCE_MS', DEFAULT_TRAJECTORY_COALESCE_MS, { min: 0, max: 5_000 });
  }

  agentDir() {
    return path.join(this.paths.agentsDir, safeFilePart(this.agent.id));
  }

  workspace() {
    return path.join(this.agentDir(), 'workspace');
  }

  async prepare() {
    await mkdir(this.workspace(), { recursive: true });
    await ensureWorkspaceSkillsDir(this.workspace(), path.join(this.agentDir(), 'codex-home'), this.agent);
    await ensureDaemonAgentWorkspaceRoot(this.agentDir(), this.agent);
    await prepareRuntimeHooks({
      agentDir: this.agentDir(),
      workspace: this.workspace(),
      runtimeKind: 'claude-code',
    });
    await writeFile(path.join(this.workspace(), 'AGENTS.md'), [
      '# MagClaw Remote Claude Agent Workspace',
      '',
      'This workspace is isolated for a MagClaw cloud-connected Claude Code agent.',
      'Agent-specific skills can be installed under `./skills/<skill-name>/SKILL.md`; this path belongs to this agent only.',
      'Runtime-generated adapter directories are not skill install targets.',
      '',
    ].join('\n'));
  }

  async listWorkspace(relPath = '') {
    return listDaemonAgentWorkspace(this.agentDir(), this.agent, relPath);
  }

  async readWorkspaceFile(relPath = 'MEMORY.md') {
    return readDaemonAgentWorkspaceFile(this.agentDir(), this.agent, relPath);
  }

  async listSkills() {
    await this.prepare();
    return listDaemonAgentSkills({
      agent: this.agent,
      agentDir: this.agentDir(),
      workspace: this.workspace(),
    });
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

  queueMessageDelta(delta = '') {
    const body = this.responseBuffer.trim();
    if (!body) return;
    this.pendingMessageDelta = {
      type: 'agent:message_delta',
      agentId: this.agent.id,
      deliveryId: this.activeDeliveryId || null,
      payload: {
        body,
        delta: String(delta || ''),
        message: this.lastSourceMessage || null,
        sourceMessage: this.lastSourceMessage || null,
        spaceType: this.lastSourceMessage?.spaceType || 'channel',
        spaceId: this.lastSourceMessage?.spaceId || 'chan_all',
        parentMessageId: this.lastSourceMessage?.parentMessageId || null,
        idempotencyKey: this.activeDeliveryId || null,
      },
    };
    if (this.trajectoryCoalesceMs <= 0) {
      this.flushMessageDelta();
      return;
    }
    if (this.messageDeltaTimer) return;
    this.messageDeltaTimer = setTimeout(() => {
      this.messageDeltaTimer = null;
      this.flushMessageDelta();
    }, this.trajectoryCoalesceMs);
    this.messageDeltaTimer.unref?.();
  }

  flushMessageDelta() {
    if (this.messageDeltaTimer) {
      clearTimeout(this.messageDeltaTimer);
      this.messageDeltaTimer = null;
    }
    const payload = this.pendingMessageDelta;
    this.pendingMessageDelta = null;
    if (payload) this.send(payload);
  }

  handleClaudeStreamEvent(event) {
    if (event.type === 'system') {
      if (event.sessionId) {
        this.send({
          type: 'agent:session',
          agentId: this.agent.id,
          status: this.status,
          sessionId: event.sessionId,
          sessionKey: null,
        });
      }
      return;
    }
    if (event.type === 'text') {
      this.responseBuffer += String(event.delta || '');
      this.queueMessageDelta(event.delta || '');
      this.send({
        type: 'agent:activity',
        agentId: this.agent.id,
        status: 'working',
        deliveryId: this.activeDeliveryId || null,
        activity: { source: 'claude-code-stream', chars: this.responseBuffer.length, at: now() },
      });
      return;
    }
    if (event.type === 'thinking' || event.type === 'tool_use' || event.type === 'tool_result' || event.type === 'usage') {
      this.send({
        type: 'agent:activity',
        agentId: this.agent.id,
        status: event.type === 'thinking' ? 'thinking' : 'working',
        deliveryId: this.activeDeliveryId || null,
        activity: {
          source: 'claude-code-stream',
          phase: event.type,
          detail: claudeToolActivityDetail(event),
          at: now(),
        },
      });
    }
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
    this.responseBuffer = '';
    this.lastSourceMessage = message || null;
    const prompt = deliveryPrompt(this.agent, message, workItem);
    const claudeCommand = this.env.CLAUDE_PATH || 'claude';
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
    if (this.agent.model) args.push('--model', String(this.agent.model));
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
      let stderr = '';
      let stdoutBuffer = '';
      let settled = false;
      const finalMessageFrame = (body) => ({
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
      });
      const finish = (status, detail) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.flushMessageDelta();
        this.child = null;
        const body = this.responseBuffer.trim();
        if (status === 'idle') {
          if (body) {
            const frame = finalMessageFrame(body);
            this.send(frame);
            this.markDelivery(this.activeDeliveryId, 'completed', { resultFrame: frame }).catch(() => {});
          }
          this.markDelivery(this.activeDeliveryId, 'completed').catch(() => {});
          this.sendStatus('idle', { source: 'claude-code', detail: detail || 'Claude Code turn completed', at: now() });
        } else {
          const error = detail || stderr.trim() || 'Claude Code failed.';
          const frame = body ? finalMessageFrame(body) : null;
          if (frame) this.send(frame);
          this.send({ type: 'agent:error', commandId: this.activeDeliveryId || undefined, deliveryId: this.activeDeliveryId || null, agentId: this.agent.id, error });
          this.markDelivery(this.activeDeliveryId, 'failed', { error, ...(frame ? { resultFrame: frame } : {}) }).catch(() => {});
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
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const raw = JSON.parse(line);
            for (const event of claudeStreamEvents(raw)) this.handleClaudeStreamEvent(event);
          } catch (error) {
            stderr += `${line}\n`;
            this.send({
              type: 'agent:activity',
              agentId: this.agent.id,
              status: 'working',
              deliveryId: this.activeDeliveryId || null,
              activity: { source: 'claude-code-stream', error: `Invalid stream JSON: ${error.message}`, at: now() },
            });
          }
        }
      });
      this.child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      this.child.on('error', (error) => finish('error', error.message));
      this.child.on('close', (code, signal) => {
        if (stdoutBuffer.trim()) {
          try {
            const raw = JSON.parse(stdoutBuffer.trim());
            for (const event of claudeStreamEvents(raw)) this.handleClaudeStreamEvent(event);
          } catch (error) {
            stderr += `${stdoutBuffer}\n`;
          }
          stdoutBuffer = '';
        }
        if (code === 0) finish('idle');
        else finish('error', stderr.trim() || `Claude Code exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.`);
      });
    });
  }

  stop() {
    this.status = 'stopping';
    this.flushMessageDelta();
    if (this.child) this.child.kill('SIGTERM');
    this.started = false;
  }
}

function readOnlySessionAckStatus(session) {
  const status = String(session?.status || '').toLowerCase();
  if ((!status || status === 'offline') && !session?.started) return 'idle';
  return session?.status || 'idle';
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
    this.runtimeStatusTimer = null;
    this.runtimeStatusInFlight = false;
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
    const packageName = normalizeEntryPackageName(message.packageName || packageInfoFromSpec(message.packageSpec || '').name || this.env.MAGCLAW_ENTRY_PACKAGE_NAME || this.env.MAGCLAW_DAEMON_PACKAGE_NAME);
    const packageKind = packageKindForPackageName(packageName);
    const packageBin = String(message.packageBin || packageBinForPackageName(packageName)).trim() || packageBinForPackageName(packageName);
    const service = await readServiceState(this.paths.profile, this.env);
    const activeService = backgroundServiceStatus(this.paths.profile, this.env);
    if (!service.background || !activeService.active) {
      const phase = service.background ? 'background_inactive' : 'background_required';
      const error = 'Remote daemon upgrade requires an active background daemon service. Run `magclaw start` or reconnect with `--background` first.';
      await writeUpgradeHandoff(this.paths.profile, {
        commandId,
        status: 'failed',
        phase,
        progress: 0,
        message: error,
        previousVersion,
        targetVersion,
        packageName,
        packageKind,
        packageBin,
        packageSpec: message.packageSpec || packageSpecForPackageName(packageName, targetVersion),
        error,
        service: activeService,
      }, this.env);
      this.send({
        type: 'daemon:upgrade:ack',
        commandId,
        status: 'failed',
        phase,
        progress: 0,
        message: error,
        previousVersion,
        targetVersion,
        packageName,
        packageKind,
        packageBin,
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
      packageName,
      packageKind,
      packageBin,
      packageSpec: message.packageSpec || packageSpecForPackageName(packageName, targetVersion),
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
      packageName,
      packageKind,
      packageBin,
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
    args.push('--package-name', packageName);
    args.push('--package-bin', packageBin);
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
    const packageName = normalizeEntryPackageName(message.packageName || packageInfoFromSpec(message.packageSpec || '').name || this.env.MAGCLAW_ENTRY_PACKAGE_NAME || this.env.MAGCLAW_DAEMON_PACKAGE_NAME);
    const packageKind = packageKindForPackageName(packageName);
    const packageBin = String(message.packageBin || packageBinForPackageName(packageName)).trim() || packageBinForPackageName(packageName);
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
      packageName,
      packageKind,
      packageBin,
      packageSpec: message.packageSpec || packageSpecForPackageName(packageName, targetVersion),
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
        packageName,
        packageKind,
        packageBin,
        message: 'Waiting for all Agent work to become idle.',
      });
      this.scheduleUpgradeIdleCheck();
      return;
    }
    await this.startUpgradeWorker(message);
  }

  async handleDaemonClose(message) {
    const commandId = String(message.commandId || '').trim();
    const service = await readServiceState(this.paths.profile, this.env);
    const serviceStatus = backgroundServiceStatus(this.paths.profile, this.env);
    const serviceRunMode = daemonServiceRunMode(service, serviceStatus);
    const packageInfo = runtimePackageInfo(this.env, service);
    const runMode = {
      mode: serviceRunMode.mode,
      background: serviceRunMode.background,
      active: serviceRunMode.active,
      label: serviceRunMode.background ? serviceStatus.label || '' : '',
      serviceName: serviceRunMode.background ? serviceStatus.serviceName || '' : '',
      taskName: serviceRunMode.background ? serviceStatus.taskName || '' : '',
      packageName: packageInfo.name,
      packageVersion: packageInfo.version,
      packageKind: packageInfo.kind,
      packageSpec: packageInfo.spec,
      packageBin: packageInfo.bin,
    };
    logWarning('daemon', `Remote close requested (${message.reason || 'closed_from_cloud'}).`);
    await writeServiceState(this.paths.profile, {
      remoteClosed: true,
      remoteClosedAt: now(),
      remoteCloseReason: message.reason || 'closed_from_cloud',
      remoteCloseCommandId: commandId,
    }, this.env);
    for (const session of this.sessions.values()) session.stop();
    this.sessions.clear();
    this.send({ type: 'daemon:close:ack',
      commandId,
      status: 'stopping',
      reason: message.reason || 'closed_from_cloud',
      service: runMode,
      at: now(),
    });
    const shouldStopBackground = Boolean(runMode.background);
    const background = shouldStopBackground
      ? stopBackground(this.paths.profile, this.env, { disable: message.disableBackground !== false })
      : { ok: true, mode: runMode.mode || 'foreground', skipped: true };
    if (shouldStopBackground) {
      logInfo('daemon', `Close request stopped background service mode=${background.mode || 'foreground'} ok=${Boolean(background.ok)}.`);
    } else {
      logInfo('daemon', 'Foreground close request did not stop background service.');
    }
    this.close({ notify: false, reason: 'cloud_close' });
    process.exitCode = 0;
    setTimeout(() => process.exit(0), 50).unref?.();
  }

  async readyPayload() {
    const owner = await ensureMachineFingerprint(this.paths.profile, this.env);
    const service = await readServiceState(this.paths.profile, this.env);
    const serviceStatus = backgroundServiceStatus(this.paths.profile, this.env);
    const serviceRunMode = daemonServiceRunMode(service, serviceStatus);
    const upgrade = await readUpgradeHandoff(this.paths.profile, this.env);
    const packageInfo = runtimePackageInfo(this.env, service);
    return {
      type: 'ready',
      computerId: this.config.computerId || null,
      workspaceId: this.config.workspaceId || 'local',
      machineFingerprint: this.config.fingerprint || owner.fingerprint,
      name: this.config.name || os.hostname(),
      hostname: os.hostname(),
      os: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      daemonVersion: packageInfo.version || DAEMON_VERSION,
      packageName: packageInfo.name,
      packageVersion: packageInfo.version,
      packageKind: packageInfo.kind,
      packageSpec: packageInfo.spec,
      packageBin: packageInfo.bin,
      cliCoreVersion: CLI_CORE_VERSION,
      service: {
        mode: serviceRunMode.mode,
        background: serviceRunMode.background,
        active: serviceRunMode.active,
        label: serviceRunMode.background ? serviceStatus.label || '' : '',
        serviceName: serviceRunMode.background ? serviceStatus.serviceName || '' : '',
        taskName: serviceRunMode.background ? serviceStatus.taskName || '' : '',
        launcher: service.launcher || '',
        packageSpec: service.packageSpec || packageInfo.spec || '',
        packageName: service.packageName || packageInfo.name,
        packageVersion: service.packageVersion || packageInfo.version,
        packageKind: service.packageKind || packageInfo.kind,
        packageBin: service.packageBin || packageInfo.bin,
        cliCoreVersion: CLI_CORE_VERSION,
      },
      upgrade: upgrade || null,
      runtimeScanPending: true,
      runningAgents: [...this.sessions.keys()],
      capabilities: CAPABILITIES,
    };
  }

  async sendReady() {
    const payload = await this.readyPayload();
    const sent = this.send(payload);
    logInfo(
      'daemon',
      `Sent ready payload for computer ${payload.computerId || 'unpaired'} (runtimes=deferred, runningAgents=${payload.runningAgents.length}, sent=${sent}).`,
    );
  }

  runtimeStatusDelayMs() {
    return envInteger(this.env, 'MAGCLAW_DAEMON_RUNTIME_STATUS_DELAY_MS', 1000, { min: 0, max: 60_000 });
  }

  clearRuntimeStatusTimer() {
    if (!this.runtimeStatusTimer) return;
    clearTimeout(this.runtimeStatusTimer);
    this.runtimeStatusTimer = null;
  }

  scheduleRuntimeStatus(reason = 'ready_ack') {
    if (this.closed || this.runtimeStatusTimer || this.runtimeStatusInFlight) return;
    this.runtimeStatusTimer = setTimeout(() => {
      this.runtimeStatusTimer = null;
      this.sendRuntimeStatus(reason).catch((error) => {
        logWarning('daemon', `Failed to send runtime status: ${error.message}`);
      });
    }, this.runtimeStatusDelayMs());
    this.runtimeStatusTimer.unref?.();
  }

  async runtimeStatusPayload(reason = 'ready_ack') {
    const runtimes = await detectRuntimes(this.env);
    const packageInfo = runtimePackageInfo(this.env);
    return {
      type: 'daemon:runtime_status',
      time: now(),
      reason,
      computerId: this.config.computerId || null,
      daemonVersion: packageInfo.version || DAEMON_VERSION,
      packageName: packageInfo.name,
      packageVersion: packageInfo.version,
      packageKind: packageInfo.kind,
      packageSpec: packageInfo.spec,
      packageBin: packageInfo.bin,
      cliCoreVersion: CLI_CORE_VERSION,
      runtimes: runtimes.filter((runtime) => runtime.installed).map((runtime) => runtime.id),
      runtimeDetails: runtimes,
      runningAgents: [...this.sessions.keys()],
    };
  }

  async sendRuntimeStatus(reason = 'ready_ack') {
    if (this.closed || this.runtimeStatusInFlight) return false;
    this.runtimeStatusInFlight = true;
    try {
      const payload = await this.runtimeStatusPayload(reason);
      const sent = this.send(payload);
      logInfo(
        'daemon',
        `Sent runtime status for computer ${payload.computerId || 'unpaired'} (runtimes=${payload.runtimes.join(', ') || 'none'}, sent=${sent}).`,
      );
      return sent;
    } finally {
      this.runtimeStatusInFlight = false;
    }
  }

  sendHeartbeat() {
    const packageInfo = runtimePackageInfo(this.env);
    const sent = this.send({
      type: 'heartbeat',
      time: now(),
      computerId: this.config.computerId || null,
      daemonVersion: packageInfo.version || DAEMON_VERSION,
      packageName: packageInfo.name,
      packageVersion: packageInfo.version,
      packageKind: packageInfo.kind,
      packageSpec: packageInfo.spec,
      packageBin: packageInfo.bin,
      cliCoreVersion: CLI_CORE_VERSION,
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
        this.scheduleRuntimeStatus('ready_ack');
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
      case 'daemon:close':
        await this.handleDaemonClose(message);
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
      case 'agent:workspace:list':
        await this.handleAgentWorkspaceList(message);
        break;
      case 'agent:workspace:file':
        await this.handleAgentWorkspaceFile(message);
        break;
      case 'machine:runtime_models:detect':
        this.send({ type: 'machine:runtime_models:result', commandId: message.commandId, runtimes: await detectRuntimes(this.env) });
        break;
      case 'token:revoked':
        logError('daemon', 'Machine token was revoked by the server.');
        this.close({ notify: false, reason: 'token_revoked' });
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
      this.send({ type: 'agent:ack', commandId: message.commandId, agentId: agent.id, status: readOnlySessionAckStatus(session) });
    } catch (error) {
      this.send({ type: 'agent:skills:list_result', commandId: message.commandId, agentId: agent.id, skills: { agent: { id: agent.id, name: agent.name || agent.id }, global: [], workspace: [], plugin: [], tools: [], error: error.message } });
      this.send({ type: 'agent:error', commandId: message.commandId, agentId: agent.id, error: error.message });
    }
  }

  async sessionForWorkspaceRequest(message) {
    const existing = message.agentId
      ? [...this.sessions.values()].find((session) => session.agent?.id === message.agentId) || null
      : null;
    const agent = existing?.agent || message.payload?.agent || {
      id: message.agentId,
      name: message.agentId || 'Agent',
      runtime: 'codex',
      runtimeId: 'codex',
    };
    return existing || this.sessionFor(agent, message.payload || {});
  }

  async handleAgentWorkspaceList(message) {
    try {
      const session = await this.sessionForWorkspaceRequest(message);
      const tree = await session.listWorkspace(message.path || message.payload?.path || '');
      this.send({ type: 'agent:workspace:list_result', commandId: message.commandId, agentId: session.agent.id, tree });
      this.send({ type: 'agent:ack', commandId: message.commandId, agentId: session.agent.id, status: readOnlySessionAckStatus(session) });
    } catch (error) {
      this.send({ type: 'agent:error', commandId: message.commandId, agentId: message.agentId || null, error: error.message });
    }
  }

  async handleAgentWorkspaceFile(message) {
    try {
      const session = await this.sessionForWorkspaceRequest(message);
      const file = await session.readWorkspaceFile(message.path || message.payload?.path || 'MEMORY.md');
      this.send({ type: 'agent:workspace:file_result', commandId: message.commandId, agentId: session.agent.id, file: file.file });
      this.send({ type: 'agent:ack', commandId: message.commandId, agentId: session.agent.id, status: readOnlySessionAckStatus(session) });
    } catch (error) {
      this.send({ type: 'agent:error', commandId: message.commandId, agentId: message.agentId || null, error: error.message });
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
        workspaceId: message.payload?.message?.workspaceId
          || message.payload?.workItem?.workspaceId
          || message.payload?.workspaceId
          || message.workspaceId
          || '',
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

  sendStoppingNotice(reason = 'local_stop') {
    const packageInfo = runtimePackageInfo(this.env);
    const sent = this.send({
      type: 'daemon:stopping',
      time: now(),
      reason,
      computerId: this.config.computerId || null,
      daemonVersion: packageInfo.version || DAEMON_VERSION,
      packageName: packageInfo.name,
      packageVersion: packageInfo.version,
      packageKind: packageInfo.kind,
      packageSpec: packageInfo.spec,
      packageBin: packageInfo.bin,
      runningAgents: [...this.sessions.keys()],
    });
    if (sent) logInfo('daemon', `Sent stopping notice (${reason}).`);
    return sent;
  }

  close(options = {}) {
    if (this.closed) return;
    const notify = options.notify !== false;
    if (notify) this.sendStoppingNotice(options.reason || 'local_stop');
    this.closed = true;
    for (const session of this.sessions.values()) session.stop();
    this.sessions.clear();
    this.stopHeartbeat();
    this.clearInboundWatchdog();
    this.clearRuntimeStatusTimer();
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
    if (this.socket && !this.socket.destroyed) {
      if (notify) this.socket.end();
      else this.socket.destroy();
    }
    this.socket = null;
  }

  async connectOnce() {
    if (this.closed) return;
    await this.refreshConfigFromDisk();
    const service = await readServiceState(this.paths.profile, this.env);
    const serviceStatus = backgroundServiceStatus(this.paths.profile, this.env);
    const serviceRunMode = daemonServiceRunMode(service, serviceStatus);
    const packageInfo = runtimePackageInfo(this.env, service);
    const url = toWebSocketUrl(this.config.serverUrl, {
      ...this.config,
      packageName: packageInfo.name,
      packageVersion: packageInfo.version,
      packageKind: packageInfo.kind,
      packageSpec: packageInfo.spec,
      packageBin: packageInfo.bin,
      cliCoreVersion: CLI_CORE_VERSION,
      serviceMode: serviceRunMode.mode,
      serviceBackground: serviceRunMode.background,
      serviceActive: serviceRunMode.active,
    });
    const requestModule = url.protocol === 'wss:' ? https : http;
    const requestUrl = new URL(url.href.replace(/^ws/, 'http'));
    const key = crypto.randomBytes(16).toString('base64');
    logInfo('daemon', `Connecting MagClaw daemon v${packageInfo.version || DAEMON_VERSION} profile "${this.paths.profile}" to ${this.config.serverUrl}...`);
    if (this.closed) return;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        this.stopHeartbeat();
        this.clearInboundWatchdog();
        this.clearRuntimeStatusTimer();
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
  const launchPathEntries = runtimeSearchPathEntries({
    ...env,
    PATH: [nodeDir, npmDir, env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'].filter(Boolean).join(path.delimiter),
  });
  const commandMode = String(env.MAGCLAW_DAEMON_COMMAND_MODE || '').trim().toLowerCase();
  const useNpmLauncher = Boolean(npmPath) && !['local', 'local-repo', 'repo', 'source'].includes(commandMode);
  const launcher = path.join(paths.runDir, 'launcher.js');
  const fallbackBin = executablePath();
  const previousService = await readServiceState(paths.profile, env);
  const preferPersistedPackage = Boolean(previousService.pendingCommandId);
  const envPackageInfo = runtimePackageInfo(env, {});
  const persistedPackageInfo = runtimePackageInfo({}, previousService);
  const packageInfo = preferPersistedPackage ? persistedPackageInfo : runtimePackageInfo(env, previousService);
  const packageSpec = preferPersistedPackage
    ? (previousService.packageSpec || persistedPackageInfo.spec)
    : (env.MAGCLAW_DAEMON_PACKAGE_SPEC || previousService.packageSpec || packageInfo.spec || packageSpecForPackageName(packageInfo.name, 'latest'));
  const packageName = normalizeEntryPackageName(
    packageInfoFromSpec(packageSpec).name
      || packageInfo.name
      || envPackageInfo.name
      || previousService.packageName,
  );
  const packageVersion = String(packageInfoFromSpec(packageSpec).version || packageInfo.version || previousService.packageVersion || '').trim();
  const packageKind = packageKindForPackageName(packageName);
  const packageBin = String(
    (preferPersistedPackage ? previousService.packageBin : env.MAGCLAW_DAEMON_PACKAGE_BIN)
      || previousService.packageBin
      || packageBinForPackageName(packageName),
  ).trim() || packageBinForPackageName(packageName);
  const envServiceMode = normalizeBackgroundServiceMode(env.MAGCLAW_DAEMON_SERVICE_MODE)
    || normalizeBackgroundServiceMode(env.MAGCLAW_DAEMON_BACKGROUND_MODE);
  const previousMode = normalizeBackgroundServiceMode(previousService.mode);
  const serviceMode = envServiceMode || (previousMode && previousMode !== 'foreground' ? previousMode : backgroundServiceModeForPlatform(process.platform));
  const service = await writeServiceState(paths.profile, {
    mode: serviceMode,
    background: true,
    launcher,
    packageSpec,
    packageName,
    packageVersion,
    packageKind,
    packageBin,
    previousPackageSpec: previousService.previousPackageSpec || '',
    installedDaemonVersion: packageVersion || DAEMON_VERSION,
    installedPackageVersion: packageVersion || DAEMON_VERSION,
    commandMode: useNpmLauncher ? 'npm' : 'local',
    remoteClosed: false,
    remoteClosedAt: '',
    remoteCloseReason: '',
    remoteCloseCommandId: '',
  }, env);
  const code = [
    '#!/usr/bin/env node',
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    `const npmPath = ${JSON.stringify(npmPath)};`,
    `const useNpmLauncher = ${JSON.stringify(useNpmLauncher)};`,
    `const nodeDir = ${JSON.stringify(nodeDir)};`,
    `const npmDir = ${JSON.stringify(npmDir)};`,
    `const pathDelimiter = ${JSON.stringify(path.delimiter)};`,
    `const launchPathEntries = ${JSON.stringify(launchPathEntries)};`,
    `const fallbackBin = ${JSON.stringify(fallbackBin)};`,
    `const profile = ${JSON.stringify(paths.profile)};`,
    `const daemonHome = ${JSON.stringify(daemonRoot(env))};`,
    `const serviceFile = ${JSON.stringify(paths.service)};`,
    `const defaultPackageSpec = ${JSON.stringify(service.packageSpec)};`,
    "let service = {};",
    "try { service = JSON.parse(fs.readFileSync(serviceFile, 'utf8')); } catch {}",
    "if (service.remoteClosed) {",
    "  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);",
    "  console.error(`${stamp} INFO DAEMON profile ${profile} is closed from MagClaw Cloud; run magclaw start/restart/connect to reconnect.`);",
    "  process.exit(0);",
    "}",
    "const packageSpec = String(service.packageSpec || defaultPackageSpec || '@magclaw/daemon@latest');",
    "const packageName = String(service.packageName || (packageSpec.startsWith('@magclaw/computer@') || packageSpec === '@magclaw/computer' ? '@magclaw/computer' : '@magclaw/daemon'));",
    "const packageKind = String(service.packageKind || (packageName === '@magclaw/computer' ? 'computer' : 'daemon'));",
    "const packageBin = String(service.packageBin || (packageKind === 'computer' ? 'magclaw-computer' : 'magclaw'));",
    "const packageVersionMatch = packageSpec.match(/^@magclaw\\/(?:daemon|computer)@(.+)$/);",
    "const packageVersion = String(service.packageVersion || (packageVersionMatch ? packageVersionMatch[1] : ''));",
    'const command = useNpmLauncher ? npmPath : process.execPath;',
    "const args = useNpmLauncher",
    "  ? ['exec', '--yes', '--package', packageSpec, '--', packageBin, 'connect', '--profile', profile]",
    "  : [fallbackBin, 'connect', '--profile', profile];",
    "const launchPath = [...launchPathEntries, nodeDir, npmDir, process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'].filter(Boolean).join(pathDelimiter);",
    "const childEnv = {",
    "  ...process.env,",
    "  MAGCLAW_DAEMON_HOME: daemonHome,",
    "  MAGCLAW_ENTRY_PACKAGE_NAME: packageName,",
    "  MAGCLAW_ENTRY_PACKAGE_VERSION: packageVersion,",
    "  MAGCLAW_DAEMON_PACKAGE_NAME: packageName,",
    "  MAGCLAW_DAEMON_PACKAGE_SPEC: packageSpec,",
    "  MAGCLAW_DAEMON_PACKAGE_KIND: packageKind,",
    "  MAGCLAW_DAEMON_PACKAGE_BIN: packageBin,",
    "  MAGCLAW_DAEMON_BACKGROUND_SERVICE: '1',",
    "  PATH: launchPath,",
    "};",
    "if (packageKind === 'computer') childEnv.MAGCLAW_COMPUTER_DAEMON = '1';",
    'const child = spawn(command, args, {',
    "  stdio: 'inherit',",
    '  env: childEnv,',
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

async function writeContainerSupervisor(profile, launcher, env = process.env) {
  const paths = profilePaths(profile, env);
  await mkdir(paths.runDir, { recursive: true });
  await mkdir(paths.logDir, { recursive: true });
  const supervisor = path.join(paths.runDir, 'container-supervisor.js');
  const restartSec = Math.max(1, Math.min(60, Number(env.MAGCLAW_DAEMON_CONTAINER_RESTART_SEC || 3) || 3));
  const code = [
    '#!/usr/bin/env node',
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const launcher = ${JSON.stringify(launcher)};`,
    `const serviceFile = ${JSON.stringify(paths.service)};`,
    `const logDir = ${JSON.stringify(paths.logDir)};`,
    `const restartMs = ${JSON.stringify(restartSec * 1000)};`,
    'let child = null;',
    'let stopping = false;',
    'function readService() {',
    "  try { return JSON.parse(fs.readFileSync(serviceFile, 'utf8')); } catch { return {}; }",
    '}',
    'function shouldStop() {',
    '  const service = readService();',
    '  return Boolean(service.remoteClosed || service.containerSupervisorDisabled);',
    '}',
    'function openLog(name) {',
    '  fs.mkdirSync(logDir, { recursive: true });',
    "  return fs.openSync(path.join(logDir, name), 'a');",
    '}',
    'function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }',
    'function stop(signal) {',
    '  stopping = true;',
    "  if (child && child.exitCode === null && child.signalCode === null) child.kill(signal || 'SIGTERM');",
    '  setTimeout(() => process.exit(0), 5000).unref?.();',
    '}',
    "process.once('SIGINT', () => stop('SIGINT'));",
    "process.once('SIGTERM', () => stop('SIGTERM'));",
    '(async () => {',
    '  while (!stopping) {',
    '    if (shouldStop()) break;',
    "    const out = openLog('daemon.log');",
    "    const err = openLog('daemon.err.log');",
    '    child = spawn(process.execPath, [launcher], {',
    "      stdio: ['ignore', out, err],",
    '      env: {',
    '        ...process.env,',
    "        MAGCLAW_DAEMON_SERVICE_MODE: 'container',",
    '      },',
    '    });',
    "    await new Promise((resolve) => child.once('exit', resolve));",
    '    fs.closeSync(out);',
    '    fs.closeSync(err);',
    '    child = null;',
    '    if (stopping || shouldStop()) break;',
    '    await sleep(restartMs);',
    '  }',
    '})().catch((error) => {',
    "  console.error(`[magclaw-container-supervisor] ${error && error.stack ? error.stack : error}`);",
    '  process.exit(1);',
    '});',
    '',
  ].join('\n');
  await writeFile(supervisor, code);
  await chmod(supervisor, 0o755).catch(() => {});
  return supervisor;
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

async function startContainerBackground(profile, env = process.env) {
  const paths = profilePaths(profile, env);
  await mkdir(paths.logDir, { recursive: true });
  const launcher = await writeLauncher(paths.profile, { ...env, MAGCLAW_DAEMON_SERVICE_MODE: 'container' });
  await ensureExecutable(launcher);
  const supervisor = await writeContainerSupervisor(paths.profile, launcher, env);
  await ensureExecutable(supervisor);
  await writeServiceState(paths.profile, {
    mode: 'container',
    background: true,
    launcher,
    containerSupervisor: supervisor,
    containerSupervisorDisabled: false,
  }, env);
  const current = backgroundServiceStatus(paths.profile, env);
  if (current.active) {
    return {
      ok: true,
      mode: 'container',
      active: true,
      alreadyRunning: true,
      pid: current.pid || null,
      supervisorPid: current.supervisorPid || null,
      file: supervisor,
      launcher,
      status: current.status || 'running',
    };
  }
  const child = spawn(process.execPath, [supervisor], {
    cwd: process.cwd(),
    detached: true,
    stdio: 'ignore',
    env: {
      ...env,
      MAGCLAW_DAEMON_SERVICE_MODE: 'container',
    },
  });
  child.unref();
  await writeServiceState(paths.profile, {
    mode: 'container',
    background: true,
    launcher,
    containerSupervisor: supervisor,
    containerSupervisorPid: child.pid || null,
  }, env);
  return {
    ok: true,
    mode: 'container',
    active: true,
    supervisorPid: child.pid || null,
    file: supervisor,
    launcher,
  };
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
  spawnSync('launchctl', ['enable', `gui/${process.getuid()}/${label}`], { stdio: 'ignore' });
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
  const service = await readServiceState(profile, env);
  const mode = normalizeBackgroundServiceMode(env.MAGCLAW_DAEMON_SERVICE_MODE)
    || normalizeBackgroundServiceMode(env.MAGCLAW_DAEMON_BACKGROUND_MODE)
    || normalizeBackgroundServiceMode(service.mode);
  if (mode === 'container') return startContainerBackground(profile, env);
  if (process.platform === 'darwin') return startMacBackground(profile, env);
  if (process.platform === 'linux') return startLinuxBackground(profile, env);
  if (process.platform === 'win32') return startWindowsBackground(profile, env);
  return { ok: false, mode: 'foreground', message: 'Background daemon is only automated on macOS launchd, Linux user systemd, and Windows schtasks.' };
}

export function parseLaunchdPrintStatus(result = {}) {
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  const state = (stdout.match(/^\s*state\s*=\s*(.+?)\s*$/m)?.[1] || '').trim();
  const activeCountValue = Number(stdout.match(/^\s*active count\s*=\s*(\d+)\s*$/m)?.[1] || NaN);
  const stateStatus = state || (result.status === 0 ? 'loaded' : 'inactive');
  const active = result.status === 0 && (
    stateStatus.toLowerCase() === 'running'
    || (!state && Number.isFinite(activeCountValue) && activeCountValue > 0)
  );
  return {
    active,
    status: active ? 'running' : stateStatus,
    state,
    activeCount: Number.isFinite(activeCountValue) ? activeCountValue : null,
    error: result.status === 0 ? '' : String(stderr || stdout || '').trim(),
  };
}

function backgroundServiceStatus(profile, env = process.env) {
  const paths = profilePaths(profile, env);
  const serviceState = readServiceStateSync(paths.profile, env);
  const requestedMode = normalizeBackgroundServiceMode(env.MAGCLAW_DAEMON_SERVICE_MODE)
    || normalizeBackgroundServiceMode(env.MAGCLAW_DAEMON_BACKGROUND_MODE);
  if (requestedMode === 'container' || normalizeBackgroundServiceMode(serviceState.mode) === 'container') {
    const lock = activeDaemonLockSync(paths.profile, env);
    const supervisorPid = Number(serviceState.containerSupervisorPid || 0);
    const supervisorRunning = Number.isInteger(supervisorPid) && supervisorPid > 0 && pidIsRunning(supervisorPid);
    const daemonRunning = Boolean(lock?.pid);
    return {
      mode: 'container',
      active: daemonRunning || supervisorRunning,
      pid: lock?.pid || null,
      supervisorPid: supervisorRunning ? supervisorPid : null,
      file: serviceState.containerSupervisor || '',
      launcher: serviceState.launcher || '',
      status: daemonRunning ? 'running' : supervisorRunning ? 'supervising' : 'inactive',
      error: '',
    };
  }
  if (process.platform === 'darwin') {
    const label = launchAgentLabel(paths.profile);
    const result = spawnSync('launchctl', ['print', `gui/${process.getuid()}/${label}`], { encoding: 'utf8' });
    const parsed = parseLaunchdPrintStatus(result);
    return {
      mode: 'launchd',
      active: parsed.active,
      label,
      file: path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`),
      status: parsed.status,
      state: parsed.state,
      activeCount: parsed.activeCount,
      error: parsed.error,
    };
  }
  if (process.platform === 'linux') {
    const serviceName = systemdServiceName(paths.profile);
    const result = spawnSync('systemctl', ['--user', 'is-active', serviceName], { encoding: 'utf8' });
    return {
      mode: 'systemd',
      active: result.status === 0,
      serviceName,
      status: String(result.stdout || '').trim(),
      error: result.status === 0 ? '' : String(result.stderr || '').trim(),
    };
  }
  if (process.platform === 'win32') {
    const taskName = windowsTaskName(paths.profile);
    const result = spawnSync('schtasks.exe', ['/Query', '/TN', taskName, '/FO', 'LIST'], { encoding: 'utf8' });
    return {
      mode: 'schtasks',
      active: result.status === 0,
      taskName,
      status: String(result.stdout || '').trim(),
      error: result.status === 0 ? '' : String(result.stderr || result.stdout || '').trim(),
    };
  }
  return { mode: 'foreground', active: false };
}

function daemonServiceRunMode(service = {}, serviceStatus = {}) {
  const background = service.background === true;
  return {
    mode: background ? (service.mode || serviceStatus.mode || 'foreground') : 'foreground',
    background,
    active: background ? Boolean(serviceStatus.active) : false,
  };
}

function launchctlResultIsNotLoaded(result) {
  const detail = String(result?.stderr || result?.stdout || '').toLowerCase();
  return detail.includes('no such process') || detail.includes('could not find service') || detail.includes('not found');
}

function launchctlServiceIsStopped(serviceTarget) {
  const result = spawnSync('launchctl', ['print', serviceTarget], { encoding: 'utf8' });
  if (result.status !== 0) return launchctlResultIsNotLoaded(result);
  const output = String(result.stdout || result.stderr || '');
  if (/\bstate\s*=\s*running\b/i.test(output)) return false;
  if (/\bpid\s*=\s*[1-9][0-9]*\b/i.test(output)) return false;
  return true;
}

function waitForBackgroundServiceStopped(serviceTarget, timeoutMs = 2000) {
  const deadline = Date.now() + Math.max(250, Number(timeoutMs) || 2000);
  while (Date.now() < deadline) {
    if (launchctlServiceIsStopped(serviceTarget)) return true;
    sleepSync(100);
  }
  return launchctlServiceIsStopped(serviceTarget);
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

function waitForPidExitSync(pid, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidIsRunning(pid)) return true;
    sleepSync(100);
  }
  return !pidIsRunning(pid);
}

function stopPidSync(pid, { allowCurrent = false, timeoutMs = 2000 } = {}) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return { ok: true, running: false };
  if (!allowCurrent && value === process.pid) {
    return { ok: true, running: true, pid: value, skippedCurrent: true };
  }
  try {
    process.kill(value, 'SIGTERM');
  } catch (error) {
    if (error?.code === 'ESRCH') return { ok: true, running: false, pid: value, stale: true };
    return { ok: false, running: true, pid: value, error: error.message };
  }
  if (waitForPidExitSync(value, timeoutMs)) return { ok: true, running: false, pid: value, signal: 'SIGTERM' };
  try {
    process.kill(value, 'SIGKILL');
  } catch (error) {
    if (error?.code === 'ESRCH') return { ok: true, running: false, pid: value, signal: 'SIGKILL' };
    return { ok: false, running: true, pid: value, signal: 'SIGKILL', error: error.message };
  }
  const stopped = waitForPidExitSync(value, 1000);
  return { ok: stopped, running: !stopped, pid: value, signal: 'SIGKILL' };
}

function stopContainerBackground(profile, env = process.env, options = {}) {
  const paths = profilePaths(profile, env);
  const state = readServiceStateSync(paths.profile, env);
  const lock = activeDaemonLockSync(paths.profile, env);
  const supervisor = stopPidSync(state.containerSupervisorPid);
  const daemon = stopPidSync(lock?.pid);
  if (options.disable) {
    writeJsonFileSync(paths.service, {
      ...state,
      version: 1,
      profile: paths.profile,
      mode: 'container',
      background: true,
      containerSupervisorDisabled: true,
      updatedAt: now(),
    });
  }
  return {
    ok: Boolean(supervisor.ok && daemon.ok),
    mode: 'container',
    supervisorPid: state.containerSupervisorPid || null,
    pid: lock?.pid || null,
    supervisor,
    process: daemon,
    file: state.containerSupervisor || '',
    launcher: state.launcher || '',
    disabled: Boolean(options.disable),
  };
}

function stopBackground(profile, env = process.env, options = {}) {
  const paths = profilePaths(profile, env);
  const state = readServiceStateSync(paths.profile, env);
  const requestedMode = normalizeBackgroundServiceMode(env.MAGCLAW_DAEMON_SERVICE_MODE)
    || normalizeBackgroundServiceMode(env.MAGCLAW_DAEMON_BACKGROUND_MODE);
  if (requestedMode === 'container' || normalizeBackgroundServiceMode(state.mode) === 'container') {
    return stopContainerBackground(paths.profile, env, options);
  }
  if (process.platform === 'darwin') {
    const label = launchAgentLabel(paths.profile);
    const serviceTarget = `gui/${process.getuid()}/${label}`;
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    if (options.disable) {
      const disabled = spawnSync('launchctl', ['disable', serviceTarget], { encoding: 'utf8' });
      const stopped = spawnSync('launchctl', ['stop', label], { encoding: 'utf8' });
      const stoppedConfirmed = stopped.status === 0 && waitForBackgroundServiceStopped(serviceTarget);
      const needsBootout = disabled.status !== 0 || !stoppedConfirmed;
      const bootout = needsBootout
        ? spawnSync('launchctl', ['bootout', serviceTarget], { encoding: 'utf8' })
        : null;
      const bootoutOk = bootout ? (bootout.status === 0 || launchctlResultIsNotLoaded(bootout)) : false;
      if (stopped.status !== 0) spawnSync('launchctl', ['bootout', `gui/${process.getuid()}`, plist], { stdio: 'ignore' });
      return {
        ok: disabled.status === 0 && (stoppedConfirmed || bootoutOk),
        mode: 'launchd',
        label,
        serviceTarget,
        file: plist,
        disabled: disabled.status === 0,
        stopped: stoppedConfirmed || bootoutOk,
        bootout: bootout ? bootout.status === 0 : false,
        error: disabled.status === 0 && (stoppedConfirmed || bootoutOk) ? '' : String(bootout?.stderr || stopped.stderr || disabled.stderr || bootout?.stdout || stopped.stdout || disabled.stdout || '').trim(),
      };
    }
    const bootout = spawnSync('launchctl', ['bootout', serviceTarget], { encoding: 'utf8' });
    return { ok: bootout.status === 0 || launchctlResultIsNotLoaded(bootout), mode: 'launchd', label, serviceTarget, file: plist, error: bootout.stderr || bootout.stdout || '' };
  }
  if (process.platform === 'linux') {
    const paths = profilePaths(profile, env);
    const serviceName = systemdServiceName(paths.profile);
    const result = options.disable
      ? spawnSync('systemctl', ['--user', 'disable', '--now', serviceName], { encoding: 'utf8' })
      : spawnSync('systemctl', ['--user', 'stop', serviceName], { encoding: 'utf8' });
    return { ok: result.status === 0, mode: 'systemd', serviceName, error: result.stderr || '' };
  }
  if (process.platform === 'win32') {
    const paths = profilePaths(profile, env);
    const taskName = windowsTaskName(paths.profile);
    spawnSync('schtasks.exe', ['/End', '/TN', taskName], { stdio: 'ignore' });
    if (!options.disable) return { ok: true, mode: 'schtasks', taskName };
    const result = spawnSync('schtasks.exe', ['/Change', '/TN', taskName, '/DISABLE'], { encoding: 'utf8' });
    return { ok: result.status === 0, mode: 'schtasks', taskName, error: result.stderr || result.stdout || '' };
  }
  return { ok: false, mode: 'foreground' };
}

async function stopDaemon(profile, env = process.env, options = {}) {
  const background = stopBackground(profile, env, options);
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
  const service = backgroundServiceStatus(paths.profile);
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

async function logs(profile, options = {}) {
  const paths = profilePaths(profile);
  const lines = Math.max(1, Math.min(5000, Number(options.lines || 120) || 120));
  const files = [path.join(paths.logDir, 'daemon.log'), path.join(paths.logDir, 'daemon.err.log')];
  for (const file of files) {
    if (!existsSync(file)) continue;
    process.stdout.write(`\n==> ${file} <==\n`);
    const text = await readFile(file, 'utf8').catch(() => '');
    process.stdout.write(text.split(/\r?\n/).slice(-lines).join('\n'));
    process.stdout.write('\n');
  }
}

async function listProfiles(env = process.env) {
  const root = daemonRoot(env);
  const profilesDir = path.join(root, 'profiles');
  const entries = await readdir(profilesDir, { withFileTypes: true }).catch(() => []);
  const profiles = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const paths = profilePaths(entry.name, env);
    const config = await readProfile(paths.profile, env);
    const configured = Boolean(await stat(paths.config).catch(() => null));
    if (!configured) continue;
    const lock = await activeDaemonLock(paths.profile, env);
    const service = backgroundServiceStatus(paths.profile, env);
    const serviceState = await readServiceState(paths.profile, env);
    profiles.push({
      profile: paths.profile,
      configured,
      running: Boolean(lock),
      pid: lock?.pid || null,
      serverUrl: config.serverUrl || '',
      computerId: config.computerId || null,
      name: config.name || '',
      computerName: config.computerName || config.name || '',
      serverName: config.serverName || config.serverSlug || paths.profile,
      serverSlug: config.serverSlug || paths.profile,
      workspaceId: config.workspaceId || config.workspace || '',
      hasMachineToken: Boolean(config.token || config.machineToken || config.apiKey),
      hasPairToken: Boolean(config.pairToken),
      service: {
        mode: service.mode || serviceState.mode || 'foreground',
        active: Boolean(service.active),
        label: service.label || '',
        serviceName: service.serviceName || '',
        taskName: service.taskName || '',
        status: service.status || '',
        state: service.state || '',
        activeCount: service.activeCount ?? null,
      },
      createdAt: config.createdAt || '',
      updatedAt: config.updatedAt || '',
    });
  }
  profiles.sort((left, right) => (
    profileListStatusRank(left) - profileListStatusRank(right)
    || profileListUpdatedMs(right) - profileListUpdatedMs(left)
    || left.profile.localeCompare(right.profile)
  ));
  return { ok: true, root, profiles };
}

function profileListStatusRank(profile = {}) {
  if (profile.running) return 0;
  if (profile.service?.active) return 1;
  return 2;
}

function profileListUpdatedMs(profile = {}) {
  const parsed = Date.parse(String(profile.updatedAt || profile.createdAt || ''));
  return Number.isFinite(parsed) ? parsed : 0;
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
  const packageName = normalizeEntryPackageName(
    flags.packageName
      || flags.package
      || env.MAGCLAW_DAEMON_UPGRADE_PACKAGE_NAME
      || env.MAGCLAW_ENTRY_PACKAGE_NAME
      || env.MAGCLAW_DAEMON_PACKAGE_NAME
      || packageInfoFromSpec(env.MAGCLAW_DAEMON_PACKAGE_SPEC || '').name,
  );
  const target = String(targetVersion || '').trim();
  return packageSpecForPackageName(packageName, target && target !== 'latest' ? target : 'latest');
}

function npmPackageLooksRemote(packageSpec) {
  const value = String(packageSpec || '').trim();
  return value.startsWith('@magclaw/daemon@')
    || value === '@magclaw/daemon'
    || value.startsWith('@magclaw/computer@')
    || value === '@magclaw/computer';
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

function compactBackgroundServiceStatus(service = {}) {
  return {
    mode: service.mode || 'foreground',
    active: Boolean(service.active),
    label: service.label || '',
    serviceName: service.serviceName || '',
    taskName: service.taskName || '',
    status: service.status || '',
    error: service.error || '',
  };
}

async function waitForLocalDaemonReady(profile, timeoutMs = 120_000, env = process.env) {
  const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 120_000);
  let lastService = null;
  while (Date.now() < deadline) {
    const service = backgroundServiceStatus(profile, env);
    lastService = service;
    const lock = await activeDaemonLock(profile, env);
    if (service.active && lock?.pid) {
      return {
        ok: true,
        pid: lock.pid,
        service: compactBackgroundServiceStatus(service),
      };
    }
    await sleep(250);
  }
  return {
    ok: false,
    error: 'Timed out waiting for the local daemon to become ready.',
    service: compactBackgroundServiceStatus(lastService || backgroundServiceStatus(profile, env)),
  };
}

async function runUpgradeWorker(flags, env = process.env) {
  const profile = safeProfileName(flags.profile || DEFAULT_PROFILE);
  const config = await buildConfig({ profile }, env);
  const commandId = String(flags.commandId || `local_upgrade_${Date.now()}`).trim();
  const targetVersion = String(flags.targetVersion || flags.version || flags.to || flags.tag || 'latest').trim() || 'latest';
  const previousVersion = String(flags.previousVersion || DAEMON_VERSION).trim() || DAEMON_VERSION;
  const packageSpec = packageSpecForUpgrade(targetVersion, flags, env);
  const packageName = normalizeEntryPackageName(packageInfoFromSpec(packageSpec).name || flags.packageName || env.MAGCLAW_ENTRY_PACKAGE_NAME || env.MAGCLAW_DAEMON_PACKAGE_NAME);
  const packageKind = packageKindForPackageName(packageName);
  const packageBin = String(flags.packageBin || env.MAGCLAW_DAEMON_UPGRADE_PACKAGE_BIN || packageBinForPackageName(packageName)).trim() || packageBinForPackageName(packageName);
  const progressIntervalMs = Math.max(100, Math.min(5000, Number(flags.progressIntervalMs || env.MAGCLAW_DAEMON_UPGRADE_PROGRESS_MS || 500) || 500));
  const readyTimeoutMs = Math.max(5000, Math.min(10 * 60_000, Number(flags.readyTimeoutMs || env.MAGCLAW_DAEMON_UPGRADE_READY_TIMEOUT_MS || 120_000) || 120_000));
  const localOnly = Boolean(flags.localOnly || flags.local || flags.noWaitCloud);
  const assumeReady = Boolean(flags.assumeReady || env.MAGCLAW_DAEMON_UPGRADE_ASSUME_READY === '1');
  const serviceBefore = await readServiceState(profile, env);
  const previousPackageSpec = serviceBefore.packageSpec || packageSpecForPackageName(packageName, previousVersion);
  const dryRunPlan = {
    ok: true,
    dryRun: Boolean(flags.dryRun),
    commandId,
    profile,
    currentVersion: DAEMON_VERSION,
    previousVersion,
    targetVersion,
    packageSpec,
    packageName,
    packageKind,
    packageBin,
    previousPackageSpec,
    service: serviceBefore,
    localOnly,
    waitForCloud: !localOnly && Boolean(config.computerId && config.token),
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

  if (!localOnly && config.computerId && config.token) {
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
      mode: normalizeBackgroundServiceMode(env.MAGCLAW_DAEMON_SERVICE_MODE)
        || normalizeBackgroundServiceMode(env.MAGCLAW_DAEMON_BACKGROUND_MODE)
        || normalizeBackgroundServiceMode(serviceBefore.mode)
        || backgroundServiceModeForPlatform(process.platform),
      background: true,
      packageSpec,
      packageName,
      packageVersion: targetVersion === 'latest' ? '' : targetVersion,
      packageKind,
      packageBin,
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
      await writeServiceState(profile, { installedDaemonVersion: targetVersion, installedPackageVersion: targetVersion, packageVersion: targetVersion, pendingCommandId: '', pendingTargetVersion: '' }, env);
      return { ok: true, commandId, targetVersion, packageSpec };
    }
    if (localOnly) {
      const ready = await waitForLocalDaemonReady(profile, readyTimeoutMs, env);
      if (!ready.ok) throw new Error(ready.error || 'Timed out waiting for the local daemon to become ready.');
      await emitProgress({ status: 'succeeded', phase: 'ready', progress: 100, message: 'Daemon upgrade completed locally.' });
      await writeServiceState(profile, { installedDaemonVersion: targetVersion, installedPackageVersion: targetVersion, packageVersion: targetVersion, pendingCommandId: '', pendingTargetVersion: '' }, env);
      return { ok: true, commandId, targetVersion, packageSpec, localReady: ready };
    }
    if (!progressSocket && assumeReady) {
      await emitProgress({ status: 'succeeded', phase: 'ready', progress: 100, message: 'Daemon upgrade completed locally.' });
      await writeServiceState(profile, { installedDaemonVersion: targetVersion, installedPackageVersion: targetVersion, packageVersion: targetVersion, pendingCommandId: '', pendingTargetVersion: '' }, env);
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
      const previousPackageInfo = packageInfoFromSpec(previousPackageSpec);
      const rollbackPackageName = normalizeEntryPackageName(previousPackageInfo.name || serviceBefore.packageName || packageName);
      await writeServiceState(profile, {
        packageSpec: previousPackageSpec,
        packageName: rollbackPackageName,
        packageVersion: previousPackageInfo.version || serviceBefore.packageVersion || previousVersion,
        packageKind: packageKindForPackageName(rollbackPackageName),
        packageBin: serviceBefore.packageBin || packageBinForPackageName(rollbackPackageName),
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
  const waitCloud = Boolean(flags.waitCloud || flags.waitServer || flags.remote);
  const manualFlags = {
    ...flags,
    localOnly: waitCloud ? false : true,
    assumeReady: waitCloud ? flags.assumeReady : true,
    commandId: flags.commandId || `manual_upgrade_${Date.now()}`,
  };
  const plan = await runUpgradeWorker(manualFlags, env);
  printJson(plan);
}

function normalizeSetupServerSlug(value = '') {
  return String(value || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
}

function normalizeSetupServerUrl(value = '') {
  return String(value || DEFAULT_SERVER_URL).replace(/\/+$/, '');
}

async function postSetupJson(serverUrl, pathname, body = {}) {
  const url = `${normalizeSetupServerUrl(serverUrl)}${pathname}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || data.message || `${response.status} ${response.statusText}`);
  }
  return data;
}

async function teamMemoryRequestJson({ serverUrl, token = '', method = 'GET', pathname = '/api/team-memory/doctor', body = null } = {}) {
  const response = await fetch(`${normalizeMemoryServerUrl(serverUrl)}${pathname}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || data.message || `${response.status} ${response.statusText}`);
  }
  return data;
}

async function readTeamMemoryProjectConfig(flags = {}, env = process.env) {
  const paths = teamMemoryPaths({ profile: flags.profile || env.MAGCLAW_MEMORY_PROFILE || DEFAULT_PROFILE, cwd: flags.cwd || process.cwd(), env });
  const teamSharing = await readTeamSharingProjectConfig({ profile: flags.profile || env.MAGCLAW_TEAM_SHARING_PROFILE || env.MAGCLAW_MEMORY_PROFILE || DEFAULT_PROFILE, cwd: flags.cwd || process.cwd(), env });
  if (teamSharing.config) {
    return {
      paths: {
        ...paths,
        teamSharingProjectConfig: teamSharing.paths.projectConfig,
      },
      config: convertTeamSharingProjectToMemoryConfig(teamSharing.config),
    };
  }
  return {
    paths,
    config: await readJsonFile(paths.projectConfig, null),
  };
}

async function readTeamMemoryProfile(profile, env = process.env) {
  const paths = teamMemoryPaths({ profile, env });
  const sharing = await readTeamSharingProfileConfig(profile, env);
  if (sharing.config?.token || sharing.config?.server_url) {
    return {
      paths: {
        ...paths,
        teamSharingProfileConfig: sharing.paths.profileConfig,
      },
      config: {
        version: sharing.config.version || 1,
        profile: sharing.config.profile || profile,
        serverUrl: sharing.config.server_url || sharing.config.serverUrl,
        workspaceId: sharing.config.workspace_id || sharing.config.workspaceId,
        token: sharing.config.token,
      },
    };
  }
  return {
    paths,
    config: await readJsonFile(paths.profileConfig, {}),
  };
}

async function resolveTeamMemoryClient(flags = {}, env = process.env) {
  const project = await readTeamMemoryProjectConfig(flags, env);
  if (!project.config) throw new Error('Run `magclaw memory init --channel <channel>` in this project first.');
  const profile = await readTeamMemoryProfile(flags.profile || project.config.profile || DEFAULT_PROFILE, env);
  return {
    project,
    profile,
    serverUrl: flags.serverUrl || project.config.serverUrl || profile.config.serverUrl || DEFAULT_SERVER_URL,
    token: String(profile.config.token || env.MAGCLAW_MEMORY_TOKEN || '').trim(),
  };
}

async function doctorTeamMemory(flags = {}, env = process.env) {
  const project = await readTeamMemoryProjectConfig(flags, env);
  const profileName = flags.profile || project.config?.profile || env.MAGCLAW_MEMORY_PROFILE || DEFAULT_PROFILE;
  const profile = await readTeamMemoryProfile(profileName, env);
  const serverUrl = normalizeMemoryServerUrl(flags.serverUrl || project.config?.serverUrl || profile.config.serverUrl || DEFAULT_SERVER_URL);
  const token = String(profile.config.token || env.MAGCLAW_MEMORY_TOKEN || '').trim();
  const local = {
    projectConfig: { exists: Boolean(project.config), path: project.paths.projectConfig },
    profileConfig: { exists: Boolean(profile.config?.profile), path: profile.paths.profileConfig },
    hasToken: Boolean(token),
    channelConfigured: Boolean(project.config?.channelId || project.config?.channelPath),
  };
  if (flags.offline) {
    return { ok: Object.values(local).every((item) => typeof item === 'boolean' ? item : item.exists !== false), local, remote: null };
  }
  try {
    const remote = await teamMemoryRequestJson({ serverUrl, token, pathname: '/api/team-memory/doctor' });
    return {
      ok: Boolean(local.projectConfig.exists && local.profileConfig.exists && local.channelConfigured && remote.ok),
      serverUrl,
      local,
      remote,
    };
  } catch (error) {
    return {
      ok: false,
      serverUrl,
      local,
      remote: { ok: false, error: error?.message || String(error) },
    };
  }
}

function cursorLastOrdinal(cursor = {}, runtime = 'codex', sessionId = '') {
  return Number(cursor?.sessions?.[runtime]?.[sessionId]?.lastOrdinal || 0);
}

async function writeTeamMemoryCursor(file, runtime, cursor) {
  const existing = await readJsonFile(file, {});
  const sessions = existing.sessions && typeof existing.sessions === 'object' ? existing.sessions : {};
  sessions[runtime] = sessions[runtime] && typeof sessions[runtime] === 'object' ? sessions[runtime] : {};
  sessions[runtime][cursor.sessionId] = {
    ...(sessions[runtime][cursor.sessionId] || {}),
    ...cursor,
  };
  await writeJsonFile(file, {
    version: 1,
    sessions,
    updatedAt: now(),
  });
}

export async function syncTeamMemoryTranscript(flags = {}, env = process.env) {
  const transcriptPath = String(flags.transcript || flags.file || flags._?.[1] || '').trim();
  if (!transcriptPath) {
    if (flags.hookEvent) return { ok: true, empty: true, reason: 'missing_transcript_path' };
    throw new Error('Usage: magclaw memory sync --transcript <path>');
  }
  const project = await readTeamMemoryProjectConfig(flags, env);
  if (!project.config) throw new Error('Run `magclaw memory init --channel <channel>` in this project first.');
  const runtime = String(flags.runtime || 'codex').trim().toLowerCase() === 'claude' || String(flags.runtime || '').trim().toLowerCase() === 'claude-code'
    ? 'claude_code'
    : String(flags.runtime || 'codex').trim().toLowerCase();
  if (project.config.enabled === false) {
    if (flags.hookEvent) return { ok: true, empty: true, reason: 'project_disabled' };
    throw new Error('Team Sharing is disabled for this project.');
  }
  const runtimeConfig = project.config.runtimes?.[runtime];
  if (flags.hookEvent && runtimeConfig && runtimeConfig.hooksEnabled === false) {
    return { ok: true, empty: true, reason: 'runtime_hooks_disabled' };
  }
  const profile = await readTeamMemoryProfile(flags.profile || project.config.profile || DEFAULT_PROFILE, env);
  const token = String(profile.config.token || env.MAGCLAW_MEMORY_TOKEN || '').trim();
  const content = await readFile(path.resolve(transcriptPath), 'utf8');
  const parsed = parseTeamMemoryTranscript(content, {
    runtime,
    sessionId: flags.sessionId || '',
    title: flags.title || '',
    projectDir: flags.cwd || process.cwd(),
  });
  const cursor = await readJsonFile(project.paths.projectCursor, {});
  const lastOrdinal = Number(flags.full ? 0 : cursorLastOrdinal(cursor, parsed.runtime, parsed.sessionId));
  const syncPackage = buildTeamMemorySyncPackageFromTranscript(content, {
    runtime: parsed.runtime,
    sessionId: parsed.sessionId,
    title: flags.title || parsed.title || path.basename(transcriptPath),
    projectKey: project.config.projectKey,
    workspaceId: project.config.workspaceId,
    channelId: project.config.channelId,
    channelPath: project.config.channelPath,
    projectDir: flags.cwd || process.cwd(),
    lastOrdinal,
    minCreatedAt: project.config.enabledSince || '',
  });
  if (syncPackage.empty || !syncPackage.body) return { ok: true, empty: true, cursor: syncPackage.cursor };
  const result = await teamMemoryRequestJson({
    serverUrl: flags.serverUrl || project.config.serverUrl || profile.config.serverUrl || DEFAULT_SERVER_URL,
    token,
    method: 'POST',
    pathname: '/api/team-memory/sync',
    body: syncPackage.body,
  });
  if (result?.ok !== false) {
    await writeTeamMemoryCursor(project.paths.projectCursor, parsed.runtime, syncPackage.cursor);
  }
  return {
    ...result,
    cursor: syncPackage.cursor,
  };
}

export async function installTeamMemoryHooks(flags = {}, env = process.env) {
  const home = homeDirForEnv(env) || os.homedir();
  const cwd = path.resolve(flags.cwd || process.cwd());
  const runtime = String(flags.runtime || 'all').trim().toLowerCase();
  const output = { ok: true };
  if (runtime === 'all' || runtime === 'codex') {
    output.codex = await installTeamMemoryHookConfig({
      runtime: 'codex',
      configPath: flags.codexConfig || path.join(home, '.codex', 'hooks.json'),
      projectDir: cwd,
    });
  }
  if (runtime === 'all' || runtime === 'claude' || runtime === 'claude_code' || runtime === 'claude-code') {
    output.claude = await installTeamMemoryHookConfig({
      runtime: 'claude_code',
      configPath: flags.claudeConfig || path.join(home, '.claude', 'settings.json'),
      projectDir: cwd,
    });
  }
  output.ok = Boolean((!output.codex || output.codex.ok) && (!output.claude || output.claude.ok));
  return output;
}

export async function searchTeamMemory(flags = {}, env = process.env) {
  const query = String(flags.query || flags._?.slice(1).join(' ') || '').trim();
  if (!query) throw new Error('Usage: magclaw memory search --query <text>');
  const { project, serverUrl, token } = await resolveTeamMemoryClient(flags, env);
  return teamMemoryRequestJson({
    serverUrl,
    token,
    method: 'POST',
    pathname: '/api/team-memory/search',
    body: {
      query,
      channelId: flags.channelId || project.config.channelId || '',
      projectKey: flags.projectKey || project.config.projectKey || '',
      dateRange: flags.dateRange || null,
      candidateK: flags.candidateK || undefined,
      limit: flags.limit || 5,
    },
  });
}

export async function readTeamMemoryContext(flags = {}, env = process.env) {
  const sessionId = String(flags.sessionId || flags.session || flags._?.[1] || '').trim();
  if (!sessionId) throw new Error('Usage: magclaw memory context --session-id <sessionId>');
  const { serverUrl, token } = await resolveTeamMemoryClient(flags, env);
  const params = new URLSearchParams();
  if (flags.anchorEventId || flags.anchor) params.set('anchorEventId', String(flags.anchorEventId || flags.anchor));
  if (flags.direction) params.set('direction', String(flags.direction));
  if (flags.limit) params.set('limit', String(flags.limit));
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return teamMemoryRequestJson({
    serverUrl,
    token,
    pathname: `/api/team-memory/context/${encodeURIComponent(sessionId)}${suffix}`,
  });
}

function inferShareArtifactType(explicit = '', filePath = '') {
  const clean = String(explicit || '').trim().toLowerCase();
  if (['html', 'markdown', 'md', 'svg', 'mermaid', 'mmd'].includes(clean)) {
    return clean === 'md' ? 'markdown' : clean === 'mmd' ? 'mermaid' : clean;
  }
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.svg') return 'svg';
  if (ext === '.mmd' || ext === '.mermaid') return 'mermaid';
  return 'markdown';
}

export async function shareTeamMemoryArtifact(flags = {}, env = process.env) {
  const fileArg = String(flags.file || flags.path || flags.artifact || flags._?.[1] || '').trim();
  const inlineContent = flags.content ?? flags.markdown ?? flags.html ?? '';
  if (!fileArg && !inlineContent) {
    throw new Error('Usage: magclaw team-sharing share-artifact --file <path> [--title <title>] [--type markdown|html|svg|mermaid]');
  }
  const cwd = path.resolve(flags.cwd || process.cwd());
  const filePath = fileArg ? path.resolve(cwd, fileArg) : '';
  const content = filePath ? await readFile(filePath, 'utf8') : String(inlineContent);
  const { project, serverUrl, token } = await resolveTeamMemoryClient(flags, env);
  const title = String(flags.title || flags.name || (filePath ? path.basename(filePath) : 'MagClaw shared page')).trim() || 'MagClaw shared page';
  return teamMemoryRequestJson({
    serverUrl,
    token,
    method: 'POST',
    pathname: '/api/team-memory/shares',
    body: {
      title,
      description: flags.description || '',
      contentType: inferShareArtifactType(flags.type || flags.contentType, filePath),
      content,
      workspaceId: flags.workspaceId || project.config.workspaceId || '',
      channelId: flags.channelId || project.config.channelId || '',
      channelPath: flags.channelPath || project.config.channelPath || '',
      projectKey: flags.projectKey || project.config.projectKey || '',
      source: {
        kind: 'cli_artifact',
        runtime: flags.runtime || '',
        file: filePath ? path.basename(filePath) : '',
      },
    },
  });
}

function teamMemorySkillMarkdown() {
  return [
    '---',
    'name: magclaw-team-memory',
    'description: Search, read, and publicly share MagClaw team memory artifacts from Codex and Claude Code sessions.',
    '---',
    '',
    '# MagClaw Team Memory',
    '',
    'Use this skill when the user asks what the team discussed, wants to align with another session, needs original AI conversation context, or asks to publish a generated summary as a share link.',
    '',
    '## Workflow',
    '',
    '1. Run `magclaw memory search --query "<question>" --limit 5` from the project directory.',
    '2. Answer from the returned L0/L1 evidence when the user only needs a rough understanding.',
    '3. For deep follow-up, run `magclaw memory context --session-id <sessionId> --anchor-event-id <eventId> --direction around --limit 20`.',
    '4. Cite session titles, source refs, and context URLs from the command output.',
    '5. When the user wants to share the synthesis, prefer a standalone HTML artifact using the Default Share HTML Style below, then run `magclaw team-sharing share-artifact --file <path> --title "<title>" --type html`.',
    '6. Return the public URL from the command output. The shared page is public by design and includes the creator and creation time in the footer.',
    '',
    '## Default Share HTML Style',
    '',
    'Use this style whenever the user asks to share something with the team, use MagClaw sharing, or create a public share link, unless the user explicitly asks for another visual direction.',
    '',
    '- Format: produce one self-contained `<!doctype html>` file with inline CSS, `lang="zh-CN"` by default, `meta viewport`, smooth anchor scrolling, and no external assets unless they are already public and intentional.',
    '- Hero: start with a deep blue-black technical hero using a subtle cyan dot-grid or radial pattern over a dark linear background. Include a compact eyebrow label, an emerald pulse/status mark, a clear H1, a short subtitle, and 3-4 metric tiles for the most important facts.',
    '- Layout: use a max-width content shell around 1160px. On desktop, use a two-column layout with a 240-260px sticky table of contents on the left and report content on the right. On small screens, collapse to a single column and make the nav static.',
    '- Body surface: use a pale wash page background and white report cards for major sections. Cards should use 8px radius, 1px neutral borders, subtle slate shadows, and generous but compact padding. Do not nest cards inside cards.',
    '- Palette: use neutral ink/muted/line/paper/wash colors, with cyan as the primary technical accent, emerald for success/confirmed states, amber for warnings/tradeoffs, and rose for danger/risk. Avoid one-note blue, purple, beige, or heavy gradient pages.',
    '- Typography: use system sans-serif fonts, `letter-spacing: 0`, strong line-height for Chinese text, hero-scale type only in the hero, and compact headings inside report sections.',
    '- Components: use lead paragraphs for conclusion sentences, callouts with a 4px colored left border, small rounded tags for states, metric tiles in the hero, 3-column cards for runtime/option summaries, and simple step blocks for flows.',
    '- Tables: use full-width comparison or checklist tables with clear headers, 1px borders, readable 14px text, and horizontal overflow handling when needed.',
    '- Code and commands: render inline code with a light chip style. Render command blocks in a dark terminal panel with cyan-tinted text, rounded 8px corners, overflow-x auto, and copy-friendly plain commands.',
    '- Diagrams: prefer CSS grid flow diagrams, compact architecture maps, or Mermaid blocks when they communicate the logic faster than prose. Every diagram should have labels that make sense without the surrounding chat transcript.',
    '- Responsive rules: mobile viewports must not overflow. Collapse hero metrics, cards, and flow grids to one column below tablet width; keep tables scrollable; ensure long commands and URLs wrap or scroll without breaking layout.',
    '- Content structure: write for reporting, not chat replay. Start each section with a conclusion sentence, then provide technical detail, commands, tradeoffs, and verification steps. Use numbered sections, clear anchors, and a table of contents for anything longer than a short note.',
    '- Share footer: rely on MagClaw to add creator and creation time. Do not duplicate credentials, local machine paths, hidden reasoning, raw tool output, or private configuration in the shared artifact.',
    '',
    '## Rules',
    '',
    '- Do not upload local secrets or raw tool output.',
    '- Before sharing, remove tokens, private URLs, personal paths, hidden reasoning, and sensitive customer data from the artifact.',
    '- Prefer concise synthesis first, then pull original context only when needed.',
    '- If search returns low confidence or too few results, ask a narrower question or date range.',
    '',
  ].join('\n');
}

async function writeTeamMemorySkill(rootDir) {
  const skillDir = path.join(rootDir, 'skills', 'magclaw-team-memory');
  await mkdir(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, 'SKILL.md');
  await writeFile(skillPath, teamMemorySkillMarkdown());
  return skillPath;
}

export async function installTeamMemorySkill(flags = {}, env = process.env) {
  const home = homeDirForEnv(env) || os.homedir();
  const target = String(flags.target || 'codex').trim().toLowerCase();
  const output = { ok: true, installed: [] };
  if (target === 'codex' || target === 'all') {
    const codexHome = path.resolve(env.CODEX_HOME || path.join(home, '.codex'));
    output.installed.push({ target: 'codex', path: await writeTeamMemorySkill(codexHome) });
  }
  if (target === 'claude' || target === 'claude_code' || target === 'claude-code' || target === 'all') {
    const claudeHome = path.resolve(env.CLAUDE_HOME || path.join(home, '.claude'));
    output.installed.push({ target: 'claude_code', path: await writeTeamMemorySkill(claudeHome) });
  }
  output.ok = output.installed.length > 0;
  return output;
}

async function runTeamMemoryCommand(flags = {}, env = process.env) {
  const subcommand = String(flags._?.[0] || 'help').trim();
  if (subcommand === 'help' || flags.help) {
    process.stdout.write([
      'Usage: magclaw memory <command> [options]',
      '',
      'Commands:',
      '  login   Save a scoped team-memory token in the user profile',
      '  init    Write .magclaw/team-memory.json for the current project',
      '  doctor  Check local and server-side team-memory configuration',
      '  install-hooks  Install Codex/Claude hook commands for this project',
      '  install-skill  Install the MagClaw team-memory skill locally',
      '  search  Query shared team memory through /api/team-memory/search',
      '  context Read original context around a session anchor',
      '  share-artifact Create a public MagClaw share link from a local file',
      '  sync    Upload one transcript file through /api/team-memory/sync',
      '',
    ].join('\n'));
    return;
  }
  switch (subcommand) {
    case 'login':
      printJson(await loginTeamMemoryProfile(flags, env));
      break;
    case 'init':
      printJson(await initTeamMemoryProject(flags, env));
      break;
    case 'doctor':
      printJson(await doctorTeamMemory(flags, env));
      break;
    case 'install-hooks':
    case 'install':
      printJson(await installTeamMemoryHooks(flags, env));
      break;
    case 'install-skill':
    case 'skill':
      printJson(await installTeamMemorySkill(flags, env));
      break;
    case 'search':
      printJson(await searchTeamMemory(flags, env));
      break;
    case 'context':
      printJson(await readTeamMemoryContext(flags, env));
      break;
    case 'share':
    case 'share-artifact':
    case 'quickshare':
      printJson(await shareTeamMemoryArtifact(flags, env));
      break;
    case 'sync':
      printJson(await syncTeamMemoryTranscript(flags, env));
      break;
    default:
      throw new Error(`Unknown memory command: ${subcommand}`);
  }
}

async function runTeamSharingCommand(flags = {}, env = process.env) {
  const subcommand = String(flags._?.[0] || 'help').trim();
  if (subcommand === 'help' || flags.help) {
    process.stdout.write([
      'Usage: magclaw team-sharing <command> [options]',
      '',
      'Commands:',
      '  setup    Configure login, project channel, hooks, and skill',
      '  login    Browser/device login for scoped team-memory sync token',
      '  logout   Revoke and remove the cached Team Sharing token',
      '  relogin  Force a fresh browser/device login',
      '  whoami   Show the current Team Sharing identity',
      '  projects List configured project paths',
      '  init     Write .magclaw/team-sharing.yaml for this project',
      '  unset    Remove this project Team Sharing config',
      '  enable   Enable this project sync',
      '  disable  Disable this project sync',
      '  status   Show project/login/hook/skill status',
      '  doctor   Check local config, server auth, hooks, skill, and upgrade state',
      '  upgrade  Check npm latest version for team-sharing',
      '  search   Query shared team memory',
      '  context  Read original context around an anchor',
      '  share-artifact Create a public MagClaw share link from a local file',
      '  sync     Upload one transcript file',
      '',
    ].join('\n'));
    return;
  }
  switch (subcommand) {
    case 'setup':
    case 'install':
      printJson({
        ...(await setupTeamSharing(flags, env)),
        cli: flags.noInstallCli ? { ok: true, skipped: true } : await installCliShim(flags, env),
      });
      break;
    case 'login':
      printJson(await loginTeamSharingProfile(flags, env));
      break;
    case 'relogin':
      await logoutTeamSharingProfile(flags, env);
      printJson(await loginTeamSharingProfile(flags, env));
      break;
    case 'logout':
      printJson(await logoutTeamSharingProfile(flags, env));
      break;
    case 'whoami':
      printJson(await whoamiTeamSharingProfile(flags, env));
      break;
    case 'projects':
      printJson(await listTeamSharingProjects(flags, env));
      break;
    case 'init':
      printJson(await initTeamSharingProject(flags, env));
      break;
    case 'unset':
      printJson(await unsetTeamSharingProject(flags, env));
      break;
    case 'enable':
      printJson(await setTeamSharingProjectEnabled(flags, env, true));
      break;
    case 'disable':
      printJson(await setTeamSharingProjectEnabled(flags, env, false));
      break;
    case 'status':
      printJson({
        ok: true,
        project: await statusTeamSharingProject(flags, env),
        hooks: await statusTeamSharingHooks({ ...flags, target: flags.target || 'all' }, env),
        skill: await statusTeamSharingSkill({ ...flags, target: flags.target || 'all' }, env),
      });
      break;
    case 'doctor':
      printJson({
        ok: true,
        project: await statusTeamSharingProject(flags, env),
        hooks: await statusTeamSharingHooks({ ...flags, target: flags.target || 'all' }, env),
        skill: await statusTeamSharingSkill({ ...flags, target: flags.target || 'all' }, env),
        upgrade: await checkTeamSharingUpgrade({ force: Boolean(flags.force) }, env).catch((error) => ({ ok: false, error: error.message })),
      });
      break;
    case 'upgrade':
      printJson(await checkTeamSharingUpgrade({ force: true }, env));
      break;
    case 'search':
      printJson(await searchTeamMemory(flags, env));
      break;
    case 'context':
      printJson(await readTeamMemoryContext(flags, env));
      break;
    case 'share':
    case 'share-artifact':
    case 'quickshare':
      printJson(await shareTeamMemoryArtifact(flags, env));
      break;
    case 'sync':
      printJson(await syncTeamMemoryTranscript({ ...flags, integration: flags.integration || 'team-sharing' }, env));
      break;
    default:
      throw new Error(`Unknown team-sharing command: ${subcommand}`);
  }
}

async function runFeatureInstallCommand(kind, flags = {}, env = process.env) {
  const subcommand = String(flags._?.[0] || 'help').trim();
  const feature = String(flags.feature || flags.name || flags._?.[1] || 'team-sharing').trim();
  if (feature !== 'team-sharing' && feature !== 'team-memory') {
    throw new Error(`${kind} currently supports --feature team-sharing.`);
  }
  if (subcommand === 'help' || flags.help) {
    process.stdout.write(`Usage: magclaw ${kind} <install|remove|enable|disable|status> --feature team-sharing\n`);
    return;
  }
  if (kind === 'skills') {
    if (subcommand === 'install' || subcommand === 'enable') printJson(await installTeamSharingSkill(flags, env));
    else if (subcommand === 'remove') printJson(await removeTeamSharingSkill(flags, env));
    else if (subcommand === 'disable') printJson(await disableTeamSharingSkill(flags, env));
    else if (subcommand === 'status') printJson(await statusTeamSharingSkill(flags, env));
    else throw new Error(`Unknown skills command: ${subcommand}`);
    return;
  }
  if (subcommand === 'install' || subcommand === 'enable') printJson(await installTeamSharingHooks(flags, env));
  else if (subcommand === 'remove' || subcommand === 'disable') printJson(await removeTeamSharingHooks(flags, env));
  else if (subcommand === 'status') printJson(await statusTeamSharingHooks(flags, env));
  else throw new Error(`Unknown hooks command: ${subcommand}`);
}

function hasComputerTarget(flags = {}) {
  return Boolean(flags.profileExplicit || flags.server || flags.serverSlug || flags.slug || flags._?.[1]);
}

function profileFromComputerTarget(value = '') {
  return safeProfileName(normalizeSetupServerSlug(value) || value || DEFAULT_PROFILE);
}

function computerTargetProfile(flags = {}, fallback = DEFAULT_PROFILE) {
  return profileFromComputerTarget(flags.server || flags.serverSlug || flags.slug || flags._?.[1] || flags.profile || fallback);
}

function savedComputerSetupMatches(config = {}, target = {}) {
  const token = String(config.token || config.machineToken || config.apiKey || '').trim();
  const computerId = String(config.computerId || '').trim();
  if (!token || !computerId) return false;
  if (normalizeSetupServerUrl(config.serverUrl) !== normalizeSetupServerUrl(target.serverUrl)) return false;

  const targetProfile = safeProfileName(target.profile || target.serverSlug || DEFAULT_PROFILE);
  const configProfile = safeProfileName(config.profile || targetProfile);
  if (configProfile !== targetProfile) return false;

  const targetSlug = normalizeSetupServerSlug(target.serverSlug);
  const configSlug = normalizeSetupServerSlug(config.serverSlug || config.slug || '');
  if (configSlug && targetSlug && configSlug !== targetSlug) return false;
  return true;
}

async function reusableComputerSetupProfile(target = {}, env = process.env) {
  if (target.force || target.relogin || target.reauthorize) return null;
  const profile = safeProfileName(target.profile || target.serverSlug || DEFAULT_PROFILE);
  const config = await readProfile(profile, env);
  if (!savedComputerSetupMatches(config, { ...target, profile })) return null;
  const service = await readServiceState(profile, env);
  if (service.remoteClosed) return null;
  return {
    config: {
      ...config,
      profile,
      serverUrl: normalizeSetupServerUrl(config.serverUrl || target.serverUrl),
      token: String(config.token || config.machineToken || config.apiKey || '').trim(),
      pairToken: '',
    },
    service,
    serviceStatus: backgroundServiceStatus(profile, env),
  };
}

async function finishReusableComputerSetup(existing, flags = {}, env = process.env) {
  const requestedSlug = normalizeSetupServerSlug(flags._?.[1] || flags.server || flags.serverSlug || flags.slug);
  const serverSlug = existing.config.serverSlug || requestedSlug;
  const config = await buildConfig({
    ...flags,
    profile: existing.config.profile,
    serverUrl: existing.config.serverUrl,
    apiKey: existing.config.token,
    computerId: existing.config.computerId,
    workspaceId: existing.config.workspaceId || existing.config.workspace,
    name: existing.config.name,
    serverName: existing.config.serverName || serverSlug,
    serverSlug,
    fingerprint: existing.config.fingerprint,
  }, env);
  await saveProfile(config.profile, config, env);
  const cli = await tryInstallCliShim(flags, env);
  const computerName = config.computerName || config.name || os.hostname();
  const basePayload = {
    cli,
    computerId: config.computerId,
    computerName,
    profile: config.profile,
    serverName: config.serverName,
    serverSlug: config.serverSlug,
    reused: true,
    reason: 'already_configured',
  };
  if (flags.noStart || flags.noRun) {
    printJson({
      ok: true,
      started: false,
      ...basePayload,
      next: `Run magclaw-computer start ${config.profile} when ready.`,
    });
    return;
  }

  const serviceStatus = existing.serviceStatus || backgroundServiceStatus(config.profile, env);
  let result;
  if (serviceStatus.active) {
    result = {
      ok: true,
      mode: serviceStatus.mode,
      active: true,
      alreadyRunning: true,
      started: false,
      label: serviceStatus.label,
      serviceName: serviceStatus.serviceName,
      taskName: serviceStatus.taskName,
      file: serviceStatus.file,
      status: serviceStatus.status,
      state: serviceStatus.state,
    };
  } else {
    const started = await startBackground(config.profile, env);
    result = {
      ...started,
      started: Boolean(started.ok),
    };
  }
  printJson({
    ...result,
    ...basePayload,
  });
  if (!result.ok) {
    logWarning('daemon', 'Falling back to foreground mode.');
    await runForegroundDaemon(config, env);
  }
}

async function runComputerSetup(flags, env = process.env) {
  const subcommand = String(flags._?.[0] || '').trim();
  if (!['setup', 'attach', 'login'].includes(subcommand)) {
    throw new Error('Usage: magclaw-computer setup /<server-slug> --server-url <url>');
  }
  const serverSlug = normalizeSetupServerSlug(flags._?.[1] || flags.server || flags.serverSlug || flags.slug);
  if (!serverSlug) throw new Error('Run computer setup with a server slug, for example: magclaw computer setup /my-server');
  const serverUrl = normalizeSetupServerUrl(flags.serverUrl || env.MAGCLAW_PUBLIC_URL || DEFAULT_SERVER_URL);
  const profile = safeProfileName(flags.profile && flags.profile !== DEFAULT_PROFILE ? flags.profile : serverSlug);
  const existing = await reusableComputerSetupProfile({
    ...flags,
    profile,
    serverSlug,
    serverUrl,
  }, env);
  if (existing) {
    await finishReusableComputerSetup(existing, flags, env);
    return;
  }
  const owner = await ensureMachineFingerprint(profile, env);
  const displayName = String(flags.displayName || flags.name || os.hostname()).trim();
  const packageInfo = runtimePackageInfo(env);
  const started = await postSetupJson(serverUrl, '/api/cloud/computer/setup/start', {
    serverSlug,
    machineFingerprint: owner.fingerprint,
    displayName,
    hostname: os.hostname(),
    os: os.platform(),
    arch: os.arch(),
    daemonVersion: packageInfo.version || DAEMON_VERSION,
    packageName: packageInfo.name,
    packageVersion: packageInfo.version,
    packageKind: packageInfo.kind,
    packageSpec: packageInfo.spec,
    packageBin: packageInfo.bin,
    cliCoreVersion: CLI_CORE_VERSION,
  });
  process.stdout.write(`To finish login, open: ${started.verificationUri}\n`);
  process.stdout.write(`and enter the code:   ${started.userCode}\n`);
  process.stdout.write(`Waiting for approval (expires at ${started.expiresAt})...\n`);

  const intervalMs = Math.max(1000, Math.min(10_000, Number(started.intervalMs || 2000) || 2000));
  const expiresAtMs = Date.parse(started.expiresAt || '') || (Date.now() + 10 * 60_000);
  let approved = null;
  while (Date.now() < expiresAtMs) {
    await sleep(intervalMs);
    const status = await postSetupJson(serverUrl, '/api/cloud/computer/setup/token', {
      deviceCode: started.deviceCode,
    });
    if (status.status === 'approved') {
      approved = status;
      break;
    }
    if (status.status === 'expired') {
      throw new Error(status.error || 'Computer setup expired.');
    }
  }
  if (!approved) throw new Error('Computer setup approval timed out.');

  const config = await buildConfig({
    ...flags,
    profile: safeProfileName(approved.profile || profile),
    serverUrl,
    apiKey: approved.machineToken,
    computerId: approved.computerId,
    workspaceId: approved.workspaceId,
    name: displayName,
    serverName: approved.serverName || approved.serverSlug || serverSlug,
    serverSlug: approved.serverSlug || serverSlug,
    fingerprint: owner.fingerprint,
  }, env);
  await saveProfile(config.profile, config, env);
  await clearRemoteClosedServiceState(config.profile, env);
  const cli = await tryInstallCliShim(flags, env);
  if (flags.noStart || flags.noRun) {
    printJson({
      ok: true,
      started: false,
      cli,
      computerId: config.computerId,
      computerName: config.computerName || config.name || displayName,
      profile: config.profile,
      serverName: config.serverName,
      serverSlug: approved.serverSlug || serverSlug,
      next: `Run magclaw-computer start ${config.profile} when ready.`,
    });
    return;
  }
  const result = await startBackground(config.profile, env);
  printJson({
    ...result,
    cli,
    computerId: config.computerId,
    computerName: config.computerName || config.name || displayName,
    profile: config.profile,
    serverName: config.serverName,
    serverSlug: approved.serverSlug || serverSlug,
  });
  if (!result.ok) {
    logWarning('daemon', 'Falling back to foreground mode.');
    await runForegroundDaemon(config, env);
  }
}

async function renderComputerAggregateStatus(env = process.env) {
  const report = await listProfiles(env);
  return {
    ok: true,
    root: report.root,
    loggedIn: report.profiles.some((profile) => profile.configured),
    supervisor: {
      model: 'per-profile-service',
      running: report.profiles.some((profile) => profile.running || profile.service?.active),
      managedProfiles: report.profiles.length,
    },
    profiles: report.profiles,
  };
}

function formatComputerStatus(report = {}) {
  const profiles = report.profiles || [];
  if (report.profile) {
    return [
      `Profile:      ${report.profile}`,
      `Configured:   ${report.configured ? 'yes' : 'no'}`,
      `Daemon:       ${report.running ? `running (pid ${report.pid})` : 'stopped'}`,
      `Service:      ${report.service?.mode || 'foreground'}${report.service?.active ? ' active' : ''}`,
      `Server URL:   ${report.serverUrl || '-'}`,
      `Computer ID:  ${report.computerId || '-'}`,
      `Config:       ${report.configPath}`,
      '',
    ].join('\n');
  }
  return [
    'MagClaw Computers',
    `Profiles: ${profiles.length}  Running: ${profiles.filter((profile) => profile.running || profile.service?.active).length}`,
    `Root: ${report.root || '-'}`,
    '',
    ...profiles.map((profile) => [
      `${profile.running || profile.service?.active ? 'online ' : 'offline'}  ${profile.profile}`,
      `  server=${profile.serverSlug || profile.serverName || '-'} computer=${profile.computerId || '-'} service=${profile.service?.mode || 'foreground'}`,
    ].join('\n')),
    profiles.length ? '' : 'No profiles. Run `magclaw-computer setup /<serverSlug>` first.',
    '',
  ].join('\n');
}

async function computerStatus(flags = {}, env = process.env) {
  if (hasComputerTarget(flags)) return status(computerTargetProfile(flags, flags.profile || DEFAULT_PROFILE));
  return renderComputerAggregateStatus(env);
}

async function startAllComputerProfiles(env = process.env) {
  const report = await listProfiles(env);
  const results = [];
  for (const profile of report.profiles) {
    if (!profile.configured) continue;
    results.push({ profile: profile.profile, ...(await startSavedBackground({ profile: profile.profile }, env)) });
  }
  return { ok: results.every((item) => item.ok), count: results.length, results };
}

async function stopAllComputerProfiles(flags = {}, env = process.env) {
  const report = await listProfiles(env);
  const results = [];
  for (const profile of report.profiles) {
    results.push({ profile: profile.profile, ...(await stopDaemon(profile.profile, env, { disable: Boolean(flags.disable) })) });
  }
  return { ok: results.every((item) => item.ok), count: results.length, results };
}

async function detachComputerProfile(flags = {}, env = process.env) {
  const profile = computerTargetProfile(flags);
  if (!profile || profile === DEFAULT_PROFILE && !hasComputerTarget(flags)) {
    throw new Error('Usage: magclaw-computer detach <serverSlug>');
  }
  const paths = profilePaths(profile, env);
  const stopped = await uninstallBackground(profile, env);
  await rm(paths.dir, { recursive: true, force: true });
  return { ok: true, profile, detached: true, stopped };
}

async function cleanupComputerResidue(env = process.env) {
  const report = await listProfiles(env);
  const cleaned = [];
  await activeComputerLock(env);
  for (const profile of report.profiles) {
    const paths = profilePaths(profile.profile, env);
    const before = existsSync(paths.lockFile);
    await activeDaemonLock(profile.profile, env);
    if (before && !existsSync(paths.lockFile)) cleaned.push(paths.lockFile);
  }
  return cleaned;
}

async function computerDoctor(flags = {}, env = process.env) {
  const cleanup = Boolean(flags.cleanup || flags.fix);
  const target = hasComputerTarget(flags) ? computerTargetProfile(flags, flags.profile || DEFAULT_PROFILE) : '';
  const runtime = await doctor(env);
  const aggregate = await renderComputerAggregateStatus(env);
  const selected = target ? await status(target) : null;
  const cleaned = cleanup ? await cleanupComputerResidue(env) : [];
  const checks = [
    { name: 'MAGCLAW_DAEMON_HOME', ok: true, detail: aggregate.root },
    { name: 'profiles', ok: aggregate.profiles.length > 0, detail: `${aggregate.profiles.length} configured` },
    { name: 'runtime', ok: runtime.runtimes.some((item) => item.available), detail: runtime.runtimes.filter((item) => item.available).map((item) => item.id).join(', ') || 'none detected' },
  ];
  if (selected) {
    checks.push(
      { name: `profile ${target}`, ok: selected.configured, detail: selected.configPath },
      { name: `daemon ${target}`, ok: selected.running || selected.service?.active, detail: selected.running ? `running (pid ${selected.pid})` : (selected.service?.active ? 'service active' : 'stopped') },
    );
  }
  return {
    ok: checks.every((check) => check.ok !== false),
    checks,
    runtime,
    aggregate,
    ...(selected ? { profile: selected } : {}),
    cleanup: { requested: cleanup, staleLocksCleared: cleaned },
  };
}

async function readComputerChannel(env = process.env) {
  const file = computerChannelPath(env);
  const value = existsSync(file) ? String(await readFile(file, 'utf8')).trim() : 'latest';
  return value || 'latest';
}

function validateComputerChannel(value = '') {
  const channel = String(value || '').trim();
  if (channel === 'latest' || channel === 'alpha' || /^pinned:[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(channel)) return channel;
  throw new Error('Channel must be latest, alpha, or pinned:<semver>.');
}

async function setComputerChannel(value, env = process.env) {
  const channel = validateComputerChannel(value);
  const file = computerChannelPath(env);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${channel}\n`);
  return channel;
}

async function computerChannel(flags = {}, env = process.env) {
  const action = String(flags._?.[1] || flags._?.[0] || '').trim();
  const value = String(flags._?.[2] || flags.channel || '').trim();
  if (action === 'set') {
    const channel = await setComputerChannel(value, env);
    return { ok: true, channel };
  }
  return { ok: true, channel: await readComputerChannel(env), file: computerChannelPath(env) };
}

async function computerRunners(flags = {}, env = process.env) {
  const action = String(flags._?.[1] || 'list').trim();
  if (action === 'list') {
    const aggregate = await renderComputerAggregateStatus(env);
    return {
      ok: true,
      note: 'MagClaw local CLI can list Computer profiles. Per-agent runner stop/list remains a cloud console or agent-tool operation.',
      profiles: aggregate.profiles.map((profile) => ({
        profile: profile.profile,
        serverSlug: profile.serverSlug,
        computerId: profile.computerId,
        running: profile.running || profile.service?.active,
      })),
    };
  }
  if (action === 'stop') {
    throw new Error('Local runner stop is not available yet. Stop Agents from the MagClaw web console or agent runtime controls.');
  }
  throw new Error(`Unknown runners command: ${action}`);
}

async function computerUpgrade(flags = {}, env = process.env) {
  const channel = flags.channel ? validateComputerChannel(flags.channel) : await readComputerChannel(env);
  const targetVersion = flags.targetVersion || flags.to || flags.version || (String(channel).startsWith('pinned:') ? String(channel).slice('pinned:'.length) : channel);
  await runManualUpgrade({
    ...flags,
    to: targetVersion,
    targetVersion,
    packageName: COMPUTER_PACKAGE_NAME,
    packageBin: 'magclaw-computer',
  }, {
    ...env,
    MAGCLAW_ENTRY_PACKAGE_NAME: COMPUTER_PACKAGE_NAME,
    MAGCLAW_DAEMON_PACKAGE_NAME: COMPUTER_PACKAGE_NAME,
    MAGCLAW_DAEMON_PACKAGE_KIND: 'computer',
    MAGCLAW_DAEMON_PACKAGE_BIN: 'magclaw-computer',
  });
}

async function runComputerCommand(flags, env = process.env) {
  const subcommand = String(flags._?.[0] || 'help').trim();
  if (subcommand === 'help' || flags.help) {
    process.stdout.write(renderComputerHelp(subcommand === 'help' ? flags._?.[1] : subcommand));
    return;
  }
  switch (subcommand) {
    case 'login':
    case 'attach':
    case 'setup':
      await runComputerSetup(flags, env);
      break;
    case 'adopt-legacy':
      throw new Error('MagClaw legacy adoption is handled by `magclaw-computer setup /<serverSlug>` or `magclaw connect --pair-token <token>`.');
    case 'detach':
      printJson(await detachComputerProfile(flags, env));
      break;
    case 'status': {
      const report = await computerStatus(flags, env);
      if (flags.json) printJson(report);
      else process.stdout.write(formatComputerStatus(report));
      break;
    }
    case 'start':
      if (hasComputerTarget(flags)) {
        if (flags.foreground) {
          await runForegroundDaemon(await buildConfig({ ...flags, profile: computerTargetProfile(flags) }, env), env);
        } else {
          printJson(await startSavedBackground({ ...flags, profile: computerTargetProfile(flags) }, env));
        }
      } else {
        printJson(await startAllComputerProfiles(env));
      }
      break;
    case 'stop':
      if (hasComputerTarget(flags)) printJson(await stopDaemon(computerTargetProfile(flags), env, { disable: Boolean(flags.disable) }));
      else printJson(await stopAllComputerProfiles(flags, env));
      break;
    case 'doctor': {
      const report = await computerDoctor(flags, env);
      if (flags.json) printJson(report);
      else process.stdout.write(`${report.checks.map((check) => `${check.ok ? 'ok' : 'fail'}  ${check.name}: ${check.detail}`).join('\n')}\n`);
      break;
    }
    case 'logs':
      await logs(computerTargetProfile(flags), { lines: flags.lines || flags.lineCount });
      break;
    case 'runners':
      printJson(await computerRunners(flags, env));
      break;
    case 'channel':
      printJson(await computerChannel(flags, env));
      break;
    case 'upgrade':
      await computerUpgrade(flags, env);
      break;
    default:
      throw new Error(`Unknown computer command: ${subcommand}`);
  }
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
  await markDaemonRunServiceState(config.profile, env);
  const daemon = new MagClawDaemon(config, env);
  let forceExitTimer = null;
  const shutdown = (signal) => {
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    daemon.close({ reason: signal === 'SIGINT' ? 'sigint' : 'sigterm' });
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
  await clearRemoteClosedServiceState(config.profile, env);
  const cli = await tryInstallCliShim(flags, env);
  if (flags.background) {
    const result = await startBackground(config.profile, env);
    printJson({ ...result, cli });
    if (!result.ok) {
      logWarning('daemon', 'Falling back to foreground mode.');
      await runForegroundDaemon(config, env);
    }
    return;
  }
  if (cli.ok && cli.installed) {
    const pathHint = cli.pathReady ? cli.path : `${cli.path} (add ${cli.binDir} to PATH)`;
    logInfo('cli', `Installed MagClaw CLI command: ${pathHint}`);
  } else if (!cli.ok) {
    logWarning('cli', `MagClaw CLI command was not installed: ${cli.error}`);
  }
  await runForegroundDaemon(config, env);
}

async function startSavedBackground(flags, env = process.env) {
  const config = await buildConfig(flags, env);
  if (!config.pairToken && !config.token) {
    throw new Error(`No saved MagClaw daemon credentials for profile "${config.profile}". Run "magclaw connect --api-key <key> --profile ${config.profile}" first.`);
  }
  await saveProfile(config.profile, config, env);
  const cli = await tryInstallCliShim(flags, env);
  const result = await startBackground(config.profile, env);
  return { ...result, cli };
}

async function restartSavedBackground(flags, env = process.env) {
  const config = await buildConfig(flags, env);
  if (!config.pairToken && !config.token) {
    throw new Error(`No saved MagClaw daemon credentials for profile "${config.profile}". Run "magclaw connect --api-key <key> --profile ${config.profile}" first.`);
  }
  await stopDaemon(config.profile, env);
  await saveProfile(config.profile, config, env);
  const cli = await tryInstallCliShim(flags, env);
  const result = await startBackground(config.profile, env);
  return { ...result, command: 'restart', cli };
}

function requireExplicitProfile(command, flags = {}) {
  if (flags.profileExplicit) return;
  throw new Error(`Usage: magclaw ${command} --profile <name>`);
}

export async function main(argv = process.argv, env = process.env) {
  const { command, flags } = parseCli(argv);
  if (flags.version) {
    process.stdout.write(`${DAEMON_VERSION}\n`);
    return;
  }
  if (command === 'computer' && flags.help) {
    process.stdout.write(renderComputerHelp(flags._?.[0] || ''));
    return;
  }
  if (command === 'help' || flags.help) {
    process.stdout.write(renderHelp());
    return;
  }
  switch (command) {
    case 'connect':
      await runConnect(flags, env);
      break;
    case 'computer':
      await runComputerCommand(flags, env);
      break;
    case 'memory':
      await runTeamMemoryCommand(flags, env);
      break;
    case 'team-sharing':
      await runTeamSharingCommand(flags, env);
      break;
    case 'skills':
      await runFeatureInstallCommand('skills', flags, env);
      break;
    case 'hooks':
      await runFeatureInstallCommand('hooks', flags, env);
      break;
    case 'start': {
      printJson(await startSavedBackground(flags, env));
      break;
    }
    case 'stop':
      requireExplicitProfile('stop', flags);
      printJson(await stopDaemon(flags.profile, env, { disable: Boolean(flags.disable) }));
      break;
    case 'restart':
      printJson(await restartSavedBackground(flags, env));
      break;
    case 'restore':
      printJson({ ...(await restartSavedBackground(flags, env)), alias: 'restore' });
      break;
    case 'status':
      printJson(await status(flags.profile));
      break;
    case 'list':
      if (flags.json) {
        printJson(await listProfiles(env));
      } else {
        process.stdout.write(renderListProfiles(await listProfiles(env), {
          color: shouldUseColor({ env, stream: process.stdout, flags }),
        }));
      }
      break;
    case 'logs':
      await logs(flags.profile);
      break;
    case 'doctor':
      printJson(await doctor(env));
      break;
    case 'install-cli':
      printJson(await installCliShim(flags, env));
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
