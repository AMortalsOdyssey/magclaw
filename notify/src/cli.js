import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNotifyDaemonCommand } from './daemon.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILL_SOURCE = path.join(PACKAGE_ROOT, 'skills', 'magclaw-notify');
const DEFAULT_RELAY_URL = 'https://magclaw.multiego.me';

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
  return { root, config: path.join(root, 'config.json') };
}

async function readJson(file, fallback = {}) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
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

async function installSkill(flags = {}) {
  const requested = String(flags.targets || flags.target || '').split(',').map((item) => item.trim()).filter(Boolean);
  const targets = requested.length ? requested : [
    'codex',
    'claude-code',
    ...(await commandExists('openclaw') ? ['openclaw'] : []),
    ...(await commandExists('hermes') ? ['hermes'] : []),
  ];
  const roots = {
    codex: path.join(os.homedir(), '.codex', 'skills', 'magclaw-notify'),
    'claude-code': path.join(os.homedir(), '.claude', 'skills', 'magclaw-notify'),
    openclaw: path.join(os.homedir(), '.openclaw', 'skills', 'magclaw-notify'),
    hermes: path.join(os.homedir(), '.hermes', 'skills', 'magclaw-notify'),
  };
  const installed = [];
  for (const kind of [...new Set(targets)]) {
    if (!roots[kind]) continue;
    await rm(roots[kind], { recursive: true, force: true });
    await copyTree(SKILL_SOURCE, roots[kind]);
    installed.push({ kind, path: roots[kind] });
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
  const installedSkills = flags.noSkill ? [] : await installSkill(flags);
  return { profile, relayUrl, relayHandle: config.relayHandle, user: config.user, installedSkills };
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

export function notifyIdempotencyKey(value) {
  return `mcn_${crypto.createHash('sha256').update(String(value || '')).digest('base64url')}`;
}

async function send(flags) {
  if (flags.authorizedCurrentTurn !== true) throw new Error('Refusing to submit: --authorized-current-turn is required for the current user-instructed turn.');
  const auth = await authenticated(flags);
  const group = String(flags.group || '').trim();
  if (!group) throw new Error('--group with the user-specified target group name is required.');
  const markdown = await readMarkdown(flags);
  if (!markdown) throw new Error('--markdown or --markdown-file is required.');
  const idempotencySource = String(flags.idempotencyKey || [flags.sessionId, flags.turnId, group].filter(Boolean).join(':') || crypto.randomUUID());
  const idempotencyKey = notifyIdempotencyKey(idempotencySource);
  return requestJson(auth.config.relayUrl, '/api/notify/requests', {
    method: 'POST',
    token: auth.config.token,
    fingerprint: auth.config.machineFingerprint,
    headers: { 'idempotency-key': idempotencyKey },
    body: {
      explicitUserAuthorization: true,
      target: { group },
      content: { title: flags.title || '工作进展通知', markdown },
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
    '  magclaw-notify send --group NAME --markdown-file FILE --authorized-current-turn',
    '  magclaw-notify status REQUEST_ID',
    '  magclaw-notify whoami',
    '  magclaw-notify install-skill [--targets codex,claude-code]',
    '  magclaw-notify logout',
    '  magclaw-notify daemon login --relay-url URL [--name NAME]',
    '  magclaw-notify daemon configure --agent-provider openclaw --delivery-provider lark-cli-feishu',
    '  magclaw-notify daemon add-group --name NAME --chat-id CHAT_ID',
    '  magclaw-notify daemon add-person --name NAME --open-id OPEN_ID',
    '  magclaw-notify daemon start|run|status|stop', '',
    'Notify never lists available groups and never submits without --authorized-current-turn.',
  ].join('\n');
}

export async function runNotifyCli(argv = process.argv) {
  const { command, positional, flags } = parseArgs(argv);
  let result;
  if (command === 'daemon') result = await runNotifyDaemonCommand(positional, flags);
  else if (['login', 'setup'].includes(command)) result = await login(flags, positional);
  else if (command === 'send') result = await send(flags);
  else if (command === 'status') result = await status(flags, positional);
  else if (command === 'whoami') result = await whoami(flags);
  else if (command === 'logout') result = await logout(flags);
  else if (command === 'install-skill') result = { installedSkills: await installSkill(flags) };
  else { process.stdout.write(`${help()}\n`); return; }
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
}
