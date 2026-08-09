import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
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
import {
  listNotifyConnections,
  notifyProjectPaths,
  readNotifyConnections,
  removeNotifyConnection,
  saveNotifyConnection,
  selectNotifyConnection,
  useNotifyConnection,
} from './connections.js';
import {
  applyNotifyUpdate,
  checkNotifyUpdate,
  readNotifyUpdateState,
  rollbackNotifyUpdate,
  runNotifyBackgroundUpdate,
  scheduleNotifyBackgroundUpdate,
} from './update.js';
import { decodeNotifyConnectionToken } from './setup-token.js';

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

function automaticConnectionName(relayHandle, registry = {}) {
  const handle = String(relayHandle || '').trim();
  if (!handle) throw new Error('Notify Relay did not identify the Bot bound to this Token.');
  const base = profileName(handle);
  const matching = Object.entries(registry.connections || {}).filter(([, connection]) => connection?.relayHandle === handle);
  if (matching.length) {
    const userNamed = matching.find(([name]) => name !== base);
    return (userNamed || matching[0])[0];
  }
  const existing = registry.connections?.[base];
  if (!existing || !existing.relayHandle || existing.relayHandle === handle) return base;
  const suffix = crypto.createHash('sha256').update(handle).digest('hex').slice(0, 8);
  return profileName(`${base}-${suffix}`);
}

function existingConnectionForSetupToken(registry = {}, setupToken = '') {
  return Object.values(registry.connections || {}).find((connection) => (
    connection?.relayHandle
    && String(setupToken || '').startsWith(`mcn_inv_${connection.relayHandle}_`)
  )) || {};
}

function suppliedNotifyToken(flags = {}, positional = []) {
  const positionalToken = /^mcn(?:_|-)/i.test(String(positional[0] || '')) ? positional[0] : positional[1];
  return {
    positionalToken,
    suppliedToken: String(flags.token || flags.inviteToken || flags.setupToken || positionalToken || '').trim(),
  };
}

export async function installGlobalNotifyClient(options = {}) {
  const packageJson = await readJson(PACKAGE_JSON, { name: '@magclaw/notify', version: '' });
  const packageName = String(packageJson.name || '@magclaw/notify');
  const version = String(packageJson.version || '').trim();
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Notify package version is invalid; global installation was not attempted.');
  const platform = options.platform || process.platform;
  const npm = String(options.npmPath || (platform === 'win32' ? 'npm.cmd' : 'npm'));
  const run = options.spawnSync || spawnSync;
  const env = { ...process.env, ...(options.env || {}) };
  const install = run(npm, [
    'install', '--global', '--ignore-scripts', '--no-audit', '--no-fund', `${packageName}@${version}`,
  ], { encoding: 'utf8', windowsHide: true, env });
  if (install.status !== 0) {
    throw new Error(`Unable to install MagClaw Notify ${version}: ${String(install.stderr || install.stdout || `npm exited ${install.status}`).trim()}`);
  }
  const listed = run(npm, ['list', '--global', '--depth=0', '--json', packageName], {
    encoding: 'utf8', windowsHide: true, env,
  });
  let installedVersion = '';
  try { installedVersion = JSON.parse(String(listed.stdout || '{}')).dependencies?.[packageName]?.version || ''; } catch {}
  if (listed.status !== 0 || installedVersion !== version) throw new Error(`MagClaw Notify ${version} was installed but exact-version verification failed.`);
  return { packageName, version, installed: true };
}

function home(env = process.env) {
  return path.resolve(env.MAGCLAW_NOTIFY_HOME || path.join(os.homedir(), '.magclaw', 'notify'));
}

function pathsFor(profile, env = process.env) {
  const root = path.join(home(env), 'profiles', profileName(profile));
  return { root, config: path.join(root, 'config.json'), auditDir: path.join(root, 'audit') };
}

export function notifySenderAudit(flags = {}, env = process.env) {
  const profile = profileName(flags.connection || flags.profile || 'default');
  const paths = notifyProjectPaths({ projectDir: flags.projectDir, env });
  if (!senderAuditLogs.has(paths.auditDir)) {
    senderAuditLogs.set(paths.auditDir, createNotifyAuditLog({
      dir: paths.auditDir,
      scope: 'sender',
      base: { projectKey: paths.projectKey, connection: profile },
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
  const spec = `${packageJson.name}@latest`;
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
  const stateRoot = path.resolve(env.MAGCLAW_NOTIFY_HOME || path.join(homeDir, '.magclaw', 'notify'));
  await writeJsonAtomic(path.join(stateRoot, 'integrations.json'), {
    version: 1,
    targets: installed.map((item) => item.kind),
    updatedAt: new Date().toISOString(),
  });
  return installed;
}

export async function loginNotifyClient(flags = {}, positional = [], options = {}) {
  const explicitConnection = String(flags.connection || flags.profile || '').trim();
  const projectOptions = { projectDir: flags.projectDir, env: options.env || process.env };
  const current = await readNotifyConnections(projectOptions);
  const explicitName = explicitConnection ? profileName(explicitConnection) : '';
  const { positionalToken, suppliedToken } = suppliedNotifyToken(flags, positional);
  const decodedToken = decodeNotifyConnectionToken(suppliedToken);
  const previousBeforeLogin = explicitName
    ? current.registry.connections[explicitName] || {}
    : existingConnectionForSetupToken(current.registry, decodedToken.setupToken);
  const relayUrl = normalizeRelayUrl(
    flags.relayUrl
    || decodedToken.relayUrl
    || (positionalToken === positional[1] ? positional[0] : '')
    || previousBeforeLogin.relayUrl
    || options.env?.MAGCLAW_NOTIFY_RELAY_URL
    || process.env.MAGCLAW_NOTIFY_RELAY_URL
    || DEFAULT_RELAY_URL,
  );
  const inviteToken = decodedToken.setupToken;
  if (!inviteToken.startsWith('mcn_inv_')) throw new Error('Notify login requires --token with a valid Owner-provided Notify Token.');
  const connectionId = previousBeforeLogin.connectionId || `ncn_${crypto.randomUUID()}`;
  const request = options.requestJson || requestJson;
  const started = await request(relayUrl, '/api/notify/auth/start', {
    method: 'POST',
    body: { inviteToken, connectionId },
  });
  const verificationUrl = new URL(started.verificationUri, `${relayUrl}/`).toString();
  const stderr = options.stderr || process.stderr;
  stderr.write(`Approve MagClaw Notify login:\n${verificationUrl}\nCode: ${started.userCode}\n`);
  if (!flags.noOpen) (options.openBrowser || openBrowser)(verificationUrl);
  const deadline = Date.now() + Math.max(30_000, Number(flags.timeoutSeconds || 600) * 1000);
  const interval = Math.max(1000, Number(started.intervalMs || 2000));
  let approved;
  while (Date.now() < deadline) {
    approved = await request(relayUrl, '/api/notify/auth/token', {
      method: 'POST',
      body: { deviceCode: started.deviceCode },
    });
    if (approved.status === 'approved') break;
    if (approved.status === 'expired' || approved.status === 'rejected') throw new Error(`Notify login ${approved.status}.`);
    await (options.sleep || sleep)(interval);
  }
  if (approved?.status !== 'approved' || !approved.token) throw new Error('Notify login timed out.');
  const connectionName = explicitName || automaticConnectionName(approved.relayHandle, current.registry);
  const previous = current.registry.connections[connectionName] || {};
  const config = {
    version: 1,
    name: connectionName,
    connectionId,
    relayUrl,
    relayHandle: approved.relayHandle,
    token: approved.token,
    tokenExpiresAt: approved.tokenExpiresAt,
    user: approved.user,
    createdAt: previous.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  let saved = await saveNotifyConnection(config, {
    ...projectOptions,
    connection: connectionName,
    makeDefault: options.setupMode === true || flags.default === true,
  });
  if (!explicitName) {
    const redundantNames = Object.entries(saved.registry.connections)
      .filter(([name, connection]) => (
        name !== connectionName
        && connection.relayHandle === config.relayHandle
        && connection.connectionId === config.connectionId
      ))
      .map(([name]) => name);
    for (const redundantName of redundantNames) await removeNotifyConnection(redundantName, projectOptions);
    if (redundantNames.length) saved = await readNotifyConnections(projectOptions);
  }
  if (!flags.noSkill) {
    const requestedTargets = String(flags.targets || flags.target || 'auto-detected hosts');
    stderr.write(`Installing MagClaw Notify integrations for ${requestedTargets}. Existing host configuration will be preserved; Claude Desktop is backed up before modification.\n`);
  }
  const install = options.installNotifyIntegrations || installNotifyIntegrations;
  let installedIntegrations = [];
  try {
    installedIntegrations = flags.noSkill ? [] : await install(flags, options.integrationOptions || {});
  } catch (error) {
    throw new Error(`Notify connection ${connectionName} was saved, but Agent integration installation failed: ${error.message}. Fix the host configuration and run setup again.`);
  }
  return {
    projectKey: saved.paths.projectKey,
    connection: connectionName,
    default: saved.registry.defaultConnection === connectionName,
    relayUrl,
    relayHandle: config.relayHandle,
    user: config.user,
    installedIntegrations,
  };
}

export async function setupNotifyClient(flags = {}, positional = [], options = {}) {
  const { suppliedToken } = suppliedNotifyToken(flags, positional);
  const decoded = decodeNotifyConnectionToken(suppliedToken);
  if (!decoded.setupToken.startsWith('mcn_inv_')) throw new Error('Notify setup requires --token with a valid Owner-provided Token.');
  const install = options.installGlobalNotifyClient || installGlobalNotifyClient;
  const clientInstall = flags.noInstall ? { installed: false, skipped: true } : await install({
    platform: options.platform,
    npmPath: flags.npmPath || options.npmPath,
    env: options.env,
    spawnSync: options.spawnSync,
  });
  const result = await loginNotifyClient(flags, positional, { ...options, setupMode: true });
  return { ...result, clientInstall };
}

async function authenticated(flags) {
  try {
    const selected = await selectNotifyConnection({ projectDir: flags.projectDir, connection: flags.connection || flags.profile });
    if (!selected.connection.relayUrl || !selected.connection.token) throw new Error(`Notify connection ${selected.name} is incomplete. Run login again.`);
    return { profile: selected.name, connection: selected.name, paths: selected.paths, config: selected.connection, registry: selected.registry };
  } catch (error) {
    // One release of read-only compatibility for pre-project-scoped profiles.
    const profile = profileName(flags.profile || 'default');
    const legacyPaths = pathsFor(profile);
    const legacy = await readJson(legacyPaths.config, {});
    if (legacy.relayUrl && legacy.token) return { profile, connection: profile, paths: legacyPaths, config: legacy, legacy: true };
    throw error;
  }
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
        sourceAgent: flags.sourceAgent || '', sessionId: flags.sessionId || '', turnId: flags.turnId || '', repository: flags.repository ? path.basename(String(flags.repository)) : '',
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
  if (auth.legacy) await rm(auth.paths.config, { force: true });
  else await removeNotifyConnection(auth.connection, { projectDir: flags.projectDir });
  return { connection: auth.connection, loggedOut: true };
}

function help() {
  return [
    'MagClaw Notify', '',
    '  npx --yes @magclaw/notify@latest setup --token OWNER_TOKEN',
    '  magclaw-notify login [RELAY_URL] --token LEGACY_SETUP_TOKEN [--connection NAME]',
    '  magclaw-notify send --group NAME --summary-json-file FILE --authorized-current-turn',
    '  magclaw-notify send --group NAME --markdown-file FILE --authorized-current-turn',
    '  magclaw-notify status REQUEST_ID',
    '  magclaw-notify targets',
    '  magclaw-notify whoami',
    '  magclaw-notify install [--targets codex,claude-code,claude-desktop]',
    '  magclaw-notify mcp',
    '  magclaw-notify logout',
    '  magclaw-notify connections list|use|remove [NAME]',
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
  else if (command === 'setup') result = await setupNotifyClient(flags, positional);
  else if (command === 'login') result = await loginNotifyClient(flags, positional);
  else if (command === 'send') result = await sendNotify(flags);
  else if (command === 'status') result = await status(flags, positional);
  else if (command === 'targets') result = await targets(flags);
  else if (command === 'whoami') result = await whoami(flags);
  else if (command === 'logout') result = await logout(flags);
  else if (command === 'connections') {
    const action = positional[0] || 'list';
    const name = flags.connection || positional[1] || '';
    if (action === 'list') result = await listNotifyConnections({ projectDir: flags.projectDir });
    else if (action === 'use') result = await useNotifyConnection(name, { projectDir: flags.projectDir });
    else if (action === 'remove') result = await removeNotifyConnection(name, { projectDir: flags.projectDir });
    else throw new Error(`Unknown Notify connections command: ${action}`);
  }
  else if (command === 'update') {
    const action = positional[0] || 'status';
    const packageJson = await readJson(PACKAGE_JSON, { version: '0.0.0' });
    const currentVersion = String(flags.currentVersion || packageJson.version || '0.0.0');
    if (action === 'status') result = { currentVersion, state: await readNotifyUpdateState() };
    else if (action === 'check') result = await checkNotifyUpdate({ currentVersion, timeoutMs: flags.timeoutMs });
    else if (action === 'apply') result = await applyNotifyUpdate(flags.targetVersion || positional[1], { currentVersion, npmPath: flags.npmPath });
    else if (action === 'rollback') result = await rollbackNotifyUpdate({ npmPath: flags.npmPath });
    else if (action === 'background-check') result = await runNotifyBackgroundUpdate(currentVersion, { force: flags.force === true, npmPath: flags.npmPath });
    else throw new Error(`Unknown Notify update command: ${action}`);
  }
  else if (flags.version === true || command === 'version') {
    result = { version: (await readJson(PACKAGE_JSON, { version: '0.0.0' })).version };
  }
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
  const packageVersion = String((await readJson(PACKAGE_JSON, { version: '0.0.0' })).version || '0.0.0');
  if (flags.version === true || command === 'version') {
    process.stdout.write(`${packageVersion}\n`);
    return;
  }
  if (command !== 'update' && process.env.MAGCLAW_NOTIFY_UPDATE_CHILD !== '1') {
    scheduleNotifyBackgroundUpdate(packageVersion);
  }
  if (['owner', 'daemon'].includes(command)) {
    const result = await executeNotifyCli(command, positional, flags);
    if (result !== null && result !== undefined) process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
    return;
  }
  const audit = notifySenderAudit(flags);
  const event = `sender.command.${String(command || 'help').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80)}`;
  const metadata = {
    connection: profileName(flags.connection || flags.profile || 'default'),
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
      metadata: {
        ...metadata,
        resultStatus: result?.status || '',
        installedCount: result?.installedIntegrations?.length,
        ...(result?.connection ? { resultConnection: result.connection } : {}),
      },
    });
    if (result !== null && result !== undefined) process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
  } catch (error) {
    await audit.append({ event, outcome: 'failed', severity: 'error', metadata: { ...metadata, error: String(error?.message || error).slice(0, 500) } });
    throw error;
  }
}
