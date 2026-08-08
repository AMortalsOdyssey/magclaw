import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createNotifyAuditLog,
  LOCAL_NOTIFY_AUDIT_MAX_FILE_BYTES,
  LOCAL_NOTIFY_AUDIT_MAX_FILES,
} from './audit.js';
import { normalizeNotifySummary, renderNotifySummaryMarkdown } from './summary.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_SOURCE = path.join(PACKAGE_ROOT, 'skills', 'magclaw-notify');
const PACKAGE_JSON = path.join(PACKAGE_ROOT, 'package.json');
const DEFAULT_RELAY_URL = 'https://magclaw.multiego.me';
const senderAuditLogs = new Map();

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 2; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      positional.push(value);
      continue;
    }
    const key = value.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) flags[key] = true;
    else { flags[key] = next; index += 1; }
  }
  return { command: positional[0] || 'help', positional: positional.slice(1), flags };
}

function profileName(value = 'default') {
  return String(value || 'default').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80) || 'default';
}

function home(env = process.env) {
  return path.resolve(env.MAGCLAW_NOTIFY_HOME || path.join(os.homedir(), '.magclaw', 'notify'));
}

function pathsFor(profile, env = process.env) {
  const root = path.join(home(env), 'profiles', profileName(profile));
  return { root, config: path.join(root, 'config.json'), auditDir: path.join(root, 'audit') };
}

export function notifySenderAudit(flags = {}, env = process.env) {
  const profile = profileName(flags.profile || 'default');
  const paths = pathsFor(profile, env);
  if (!senderAuditLogs.has(paths.auditDir)) {
    senderAuditLogs.set(paths.auditDir, createNotifyAuditLog({
      dir: paths.auditDir,
      scope: 'sender',
      base: { instance: profile },
      maxFileBytes: LOCAL_NOTIFY_AUDIT_MAX_FILE_BYTES,
      maxFiles: LOCAL_NOTIFY_AUDIT_MAX_FILES,
    }));
  }
  return senderAuditLogs.get(paths.auditDir);
}

async function readJson(file, fallback = {}) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
}

async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.magclaw-notify.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await chmod(temporary, 0o600).catch(() => {});
    await rename(temporary, file);
    await chmod(file, 0o600).catch(() => {});
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function machineFingerprint() {
  return `mfp_${crypto.createHash('sha256').update([os.hostname(), os.platform(), os.arch(), os.homedir()].join('|')).digest('hex')}`;
}

function normalizeRelayUrl(value = '') {
  const url = new URL(String(value || DEFAULT_RELAY_URL));
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Notify Relay URL must use HTTPS or HTTP.');
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopback) throw new Error('Notify Relay URL must use HTTPS outside local loopback development.');
  return url.toString().replace(/\/+$/, '');
}

async function requestJson(relayUrl, pathname, options = {}) {
  const response = await fetch(new URL(pathname, `${relayUrl}/`), {
    method: options.method || 'GET',
    headers: {
      accept: 'application/json',
      ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      ...(options.fingerprint ? { 'x-magclaw-machine-fingerprint': options.fingerprint } : {}),
      ...(options.headers || {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text }; }
  if (!response.ok) throw new Error(data.error || data.reason || `Notify Relay returned HTTP ${response.status}.`);
  return data;
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function copyTree(source, target) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await copyFile(from, to);
  }
}

async function commandExists(command) {
  for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, process.platform === 'win32' ? `${command}.cmd` : command);
    if (await stat(candidate).then((info) => info.isFile()).catch(() => false)) return true;
  }
  return false;
}

export function claudeDesktopConfigPath(options = {}) {
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  if (platform === 'darwin') return path.join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (platform === 'win32') return path.join(env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return path.join(env.XDG_CONFIG_HOME || path.join(homeDir, '.config'), 'Claude', 'claude_desktop_config.json');
}

async function installClaudeDesktopTool(options = {}) {
  const configPath = claudeDesktopConfigPath(options);
  const existing = await readFile(configPath, 'utf8').catch((error) => {
    if (error?.code === 'ENOENT') return '';
    throw error;
  });
  let config = {};
  if (existing.trim()) {
    try {
      config = JSON.parse(existing);
    } catch (error) {
      const snippet = '"mcpServers": { "magclaw-notify": { "command": "npx", "args": ["--yes", "@magclaw/notify@latest", "mcp"] } }';
      throw new Error(`Claude Desktop config is not valid JSON; no changes were made. Fix ${configPath} or add this entry manually: ${snippet}. Parse error: ${error.message}`);
    }
  }
  const packageJson = await readJson(PACKAGE_JSON, { name: '@magclaw/notify', version: 'latest' });
  const spec = `${packageJson.name}@${packageJson.version}`;
  const platform = options.platform || process.platform;
  const server = platform === 'win32'
    ? { command: 'cmd.exe', args: ['/d', '/s', '/c', 'npx', '--yes', spec, 'mcp'] }
    : { command: 'npx', args: ['--yes', spec, 'mcp'] };
  config.mcpServers = config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {};
  config.mcpServers['magclaw-notify'] = server;
  const backupPath = `${configPath}.magclaw-notify.bak`;
  if (existing) {
    await mkdir(path.dirname(backupPath), { recursive: true });
    await writeFile(backupPath, existing, { mode: 0o600 });
    await chmod(backupPath, 0o600).catch(() => {});
  }
  await writeJsonAtomic(configPath, config);
  return { kind: 'claude-desktop', type: 'mcp', path: configPath, backupPath: existing ? backupPath : null, restartRequired: true, server };
}

async function loadNotifyOwnerCommand() {
  try {
    return (await import('@magclaw/notify-owner')).runNotifyOwnerCommand;
  } catch (packageError) {
    try {
      return (await import('../../notify-owner/src/owner.js')).runNotifyOwnerCommand;
    } catch {
      throw new Error('Notify owner commands require @magclaw/notify-owner. Install it with npm install --global @magclaw/notify-owner.');
    }
  }
}

function skillRoot(kind, homeDir) {
  const roots = {
    codex: path.join(homeDir, '.codex', 'skills', 'magclaw-notify'),
    'claude-code': path.join(homeDir, '.claude', 'skills', 'magclaw-notify'),
    openclaw: path.join(homeDir, '.openclaw', 'skills', 'magclaw-notify'),
    hermes: path.join(homeDir, '.hermes', 'skills', 'magclaw-notify'),
  };
  return roots[kind] || '';
}

async function installHostSkill(kind, target) {
  await rm(target, { recursive: true, force: true });
  await copyTree(SKILL_SOURCE, target);
  if (['claude-code', 'openclaw', 'hermes'].includes(kind)) {
    const skillFile = path.join(target, 'SKILL.md');
    const skill = await readFile(skillFile, 'utf8');
    const hostSkill = skill.replace(/^(---\n[\s\S]*?)(\n---\n)/, (_match, frontmatter, closing) => (
      frontmatter.includes('disable-model-invocation:')
        ? `${frontmatter}${closing}`
        : `${frontmatter}\ndisable-model-invocation: true${closing}`
    ));
    await writeFile(skillFile, hostSkill);
  }
  return { kind, type: 'skill', path: target };
}

export async function installNotifyIntegrations(flags = {}, options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const requested = String(flags.targets || flags.target || '').split(',').map((item) => item.trim()).filter(Boolean);
  const targets = requested.length ? requested : [
    'codex',
    'claude-code',
    ...(platform === 'darwin' && await stat('/Applications/Claude.app').then((info) => info.isDirectory()).catch(() => false) ? ['claude-desktop'] : []),
    ...(await commandExists('openclaw') ? ['openclaw'] : []),
    ...(await commandExists('hermes') ? ['hermes'] : []),
  ];
  const installed = [];
  for (const kind of [...new Set(targets)]) {
    if (kind === 'claude-desktop') {
      installed.push(await installClaudeDesktopTool({ homeDir, platform, env }));
      continue;
    }
    const root = skillRoot(kind, homeDir);
    if (!root) continue;
    installed.push(await installHostSkill(kind, root));
  }
  return installed;
}

async function login(flags, positional) {
  const profile = profileName(flags.profile || 'default');
  const paths = pathsFor(profile);
  const previous = await readJson(paths.config, {});
  const relayUrl = normalizeRelayUrl(flags.relayUrl || positional[0] || previous.relayUrl || DEFAULT_RELAY_URL);
  const inviteToken = String(flags.token || flags.inviteToken || flags.setupToken || positional[1] || '').trim();
  if (!inviteToken) throw new Error('Notify login requires --token with the owner-provided Notify setup token.');
  const fingerprint = machineFingerprint();
  const started = await requestJson(relayUrl, '/api/notify/auth/start', {
    method: 'POST',
    body: {
      inviteToken,
      profile,
      machineFingerprint: fingerprint,
      client: { hostname: os.hostname(), platform: os.platform(), arch: os.arch() },
    },
  });
  const verificationUrl = new URL(started.verificationUri, `${relayUrl}/`).toString();
  process.stderr.write(`Approve MagClaw Notify login:\n${verificationUrl}\nCode: ${started.userCode}\n`);
  if (!flags.noOpen) openBrowser(verificationUrl);
  const deadline = Date.now() + Math.max(30_000, Number(flags.timeoutSeconds || 600) * 1000);
  const interval = Math.max(1000, Number(started.intervalMs || 2000));
  let approved;
  while (Date.now() < deadline) {
    approved = await requestJson(relayUrl, '/api/notify/auth/token', {
      method: 'POST',
      body: { deviceCode: started.deviceCode, machineFingerprint: fingerprint },
    });
    if (approved.status === 'approved') break;
    if (approved.status === 'expired' || approved.status === 'rejected') throw new Error(`Notify login ${approved.status}.`);
    await sleep(interval);
  }
  if (approved?.status !== 'approved' || !approved.token) throw new Error('Notify login timed out.');
  const config = {
    version: 1,
    profile,
    relayUrl,
    relayHandle: approved.relayHandle,
    machineFingerprint: fingerprint,
    token: approved.token,
    tokenExpiresAt: approved.tokenExpiresAt,
    user: approved.user,
    createdAt: previous.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeJson(paths.config, config);
  if (!flags.noSkill) {
    const requestedTargets = String(flags.targets || flags.target || 'auto-detected hosts');
    process.stderr.write(`Installing MagClaw Notify integrations for ${requestedTargets}. Existing host configuration will be preserved; Claude Desktop is backed up before modification.\n`);
  }
  const installedIntegrations = flags.noSkill ? [] : await installNotifyIntegrations(flags);
  return { profile, relayUrl, relayHandle: config.relayHandle, user: config.user, installedIntegrations };
}

async function authenticated(flags) {
  const profile = profileName(flags.profile || 'default');
  const paths = pathsFor(profile);
  const config = await readJson(paths.config, {});
  if (!config.relayUrl || !config.token) throw new Error(`Profile ${profile} is not logged in. Run magclaw-notify login first.`);
  return { profile, paths, config };
}

async function readMarkdown(flags) {
  if (flags.markdownFile || flags.summaryFile) return String(await readFile(path.resolve(flags.markdownFile || flags.summaryFile), 'utf8')).trim();
  return String(flags.markdown || flags.summary || '').trim();
}

async function readStructuredSummary(flags) {
  if (flags.summaryJsonFile || flags.structuredFile) {
    return normalizeNotifySummary(JSON.parse(await readFile(path.resolve(flags.summaryJsonFile || flags.structuredFile), 'utf8')), { required: true });
  }
  if (flags.summaryJson || flags.structured) return normalizeNotifySummary(JSON.parse(String(flags.summaryJson || flags.structured)), { required: true });
  return null;
}

export function notifyIdempotencyKey(value) {
  return `mcn_${crypto.createHash('sha256').update(String(value || '')).digest('base64url')}`;
}

export function notifyRequestIdempotencyKey(flags = {}, group = '', randomUUID = crypto.randomUUID) {
  const explicit = String(flags.idempotencyKey || '').trim();
  if (explicit) return notifyIdempotencyKey(explicit);
  const sessionId = String(flags.sessionId || '').trim();
  const turnId = String(flags.turnId || '').trim();
  const source = sessionId || turnId
    ? [sessionId, turnId, group].join(':')
    : randomUUID();
  return notifyIdempotencyKey(source);
}

export async function sendNotify(flags) {
  if (flags.authorizedCurrentTurn !== true) throw new Error('Refusing to submit: --authorized-current-turn is required for the current user-instructed turn.');
  const auth = await authenticated(flags);
  const group = String(flags.group || '').trim();
  if (!group) throw new Error('--group with the user-specified target group name is required.');
  const summary = await readStructuredSummary(flags);
  const markdown = summary ? renderNotifySummaryMarkdown(summary) : await readMarkdown(flags);
  if (!markdown) throw new Error('--summary-json-file, --markdown, or --markdown-file is required.');
  const idempotencyKey = notifyRequestIdempotencyKey(flags, group);
  return requestJson(auth.config.relayUrl, '/api/notify/requests', {
    method: 'POST',
    token: auth.config.token,
    fingerprint: auth.config.machineFingerprint,
    headers: { 'idempotency-key': idempotencyKey },
    body: {
      explicitUserAuthorization: true,
      target: { group },
      content: { title: flags.title || summary?.headline || '工作进展通知', markdown, ...(summary ? { summary } : {}) },
      instruction: flags.instruction || '',
      mentions: String(flags.mentions || flags.mention || '').split(',').map((item) => item.trim()).filter(Boolean),
      context: {
        sourceAgent: flags.sourceAgent || '', sessionId: flags.sessionId || '', turnId: flags.turnId || '', repository: flags.repository || '',
      },
    },
  });
}

async function status(flags, positional) {
  const auth = await authenticated(flags);
  const requestId = String(flags.requestId || positional[0] || '').trim();
  if (!requestId) throw new Error('Notify request id is required.');
  return requestJson(auth.config.relayUrl, `/api/notify/requests/${encodeURIComponent(requestId)}`, {
    token: auth.config.token,
    fingerprint: auth.config.machineFingerprint,
  });
}

async function targets(flags) {
  const auth = await authenticated(flags);
  return requestJson(auth.config.relayUrl, '/api/notify/targets', {
    token: auth.config.token,
    fingerprint: auth.config.machineFingerprint,
  });
}

async function whoami(flags) {
  const auth = await authenticated(flags);
  return requestJson(auth.config.relayUrl, '/api/notify/auth/whoami', { token: auth.config.token, fingerprint: auth.config.machineFingerprint });
}

async function logout(flags) {
  const auth = await authenticated(flags);
  await requestJson(auth.config.relayUrl, '/api/notify/auth/revoke', {
    method: 'POST', token: auth.config.token, fingerprint: auth.config.machineFingerprint, body: {},
  }).catch(() => {});
  await rm(auth.paths.config, { force: true });
  return { profile: auth.profile, loggedOut: true };
}

function help() {
  return [
    'MagClaw Notify', '',
    '  magclaw-notify login RELAY_URL --token SETUP_TOKEN',
    '  magclaw-notify send --group NAME --summary-json-file FILE --authorized-current-turn',
    '  magclaw-notify send --group NAME --markdown-file FILE --authorized-current-turn',
    '  magclaw-notify status REQUEST_ID',
    '  magclaw-notify targets',
    '  magclaw-notify whoami',
    '  magclaw-notify install [--targets codex,claude-code,claude-desktop]',
    '  magclaw-notify mcp',
    '  magclaw-notify logout',
    '  magclaw-notify audit status|tail [--profile NAME] [--limit 100]', '',
    'Notify never lists available groups and never submits without --authorized-current-turn.',
  ].join('\n');
}

async function executeNotifyCli(command, positional, flags) {
  let result;
  if (['owner', 'daemon'].includes(command)) {
    if (command === 'daemon') process.stderr.write('magclaw-notify daemon is deprecated; use magclaw-notify-owner.\n');
    result = await (await loadNotifyOwnerCommand())(positional, flags);
  }
  else if (['login', 'setup'].includes(command)) result = await login(flags, positional);
  else if (command === 'send') result = await sendNotify(flags);
  else if (command === 'status') result = await status(flags, positional);
  else if (command === 'targets') result = await targets(flags);
  else if (command === 'whoami') result = await whoami(flags);
  else if (command === 'logout') result = await logout(flags);
  else if (['install', 'install-skill'].includes(command)) result = { installedIntegrations: await installNotifyIntegrations(flags) };
  else if (command === 'audit') {
    const action = positional[0] || 'status';
    const audit = notifySenderAudit(flags);
    if (action === 'status') result = await audit.status();
    else if (action === 'tail') result = { records: await audit.readTail(flags.limit || 100) };
    else throw new Error(`Unknown Notify audit command: ${action}`);
  }
  else if (command === 'mcp') {
    const { runNotifyMcpServer } = await import('./mcp.js');
    await runNotifyMcpServer();
    return;
  }
  else { process.stdout.write(`${help()}\n`); return null; }
  return result;
}

export async function runNotifyCli(argv = process.argv) {
  const { command, positional, flags } = parseArgs(argv);
  if (['owner', 'daemon'].includes(command)) {
    const result = await executeNotifyCli(command, positional, flags);
    if (result !== null && result !== undefined) process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
    return;
  }
  const audit = notifySenderAudit(flags);
  const event = `sender.command.${String(command || 'help').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80)}`;
  const metadata = {
    profile: profileName(flags.profile || 'default'),
    auditDir: audit.dir,
    authorizedCurrentTurn: flags.authorizedCurrentTurn === true,
    ...(flags.group ? { targetGroup: flags.group } : {}),
    ...(flags.sourceAgent ? { sourceAgent: flags.sourceAgent } : {}),
    ...(flags.repository ? { repository: flags.repository } : {}),
    ...(flags.markdownFile || flags.summaryFile ? { inputFile: path.resolve(flags.markdownFile || flags.summaryFile) } : {}),
    ...(flags.summaryJsonFile || flags.structuredFile ? { structuredInputFile: path.resolve(flags.summaryJsonFile || flags.structuredFile) } : {}),
  };
  await audit.append({ event, outcome: 'started', metadata });
  try {
    const result = await executeNotifyCli(command, positional, flags);
    await audit.append({
      event,
      outcome: 'succeeded',
      requestId: result?.request?.id || result?.requestId || '',
      relayId: result?.relayId || '',
      metadata: { ...metadata, resultStatus: result?.status || '', installedCount: result?.installedIntegrations?.length },
    });
    if (result !== null && result !== undefined) process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
  } catch (error) {
    await audit.append({ event, outcome: 'failed', severity: 'error', metadata: { ...metadata, error: String(error?.message || error).slice(0, 500) } });
    throw error;
  }
}
