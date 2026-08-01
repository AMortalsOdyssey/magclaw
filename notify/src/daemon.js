import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  addNotifyGroup,
  addNotifyPerson,
  configureNotifyHandler,
  confirmNotifyMapping,
  expireNotifyConfirmations,
  handleNotifyCardAction,
  installNotifyHandlerSkill,
  listNotifyTargetGrants,
  notifyHandlerStatus,
  prepareNotifyDelivery,
  processAuthorizedNotifyDelivery,
  revokeNotifyTargetGrant,
  sendNotifyConfirmationPrompt,
  syncNotifyDirectory,
  updateNotifyApprovalCard,
} from './handler.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_PATH = path.join(PACKAGE_ROOT, 'bin', 'magclaw-notify.js');
const DEFAULT_RECONNECT_MIN_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

function clean(value = '', max = 2000) {
  return String(value || '').replace(/\u0000/g, '').trim().slice(0, max);
}

function notifyHome(env = process.env) {
  return path.resolve(env.MAGCLAW_NOTIFY_HOME || path.join(os.homedir(), '.magclaw', 'notify'));
}

export function notifyDaemonPaths(env = process.env) {
  const root = path.join(notifyHome(env), 'daemon');
  return {
    root,
    config: path.join(root, 'config.json'),
    pid: path.join(root, 'run', 'daemon.pid'),
    stdout: path.join(root, 'logs', 'daemon.log'),
    stderr: path.join(root, 'logs', 'daemon.error.log'),
    handler: { dir: root, config: path.join(root, 'config.json'), profile: 'notify' },
  };
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
  return `mfp_${crypto.createHash('sha256').update([os.hostname(), os.platform(), os.arch(), os.homedir(), 'magclaw-notify-daemon'].join('|')).digest('hex')}`;
}

function normalizeRelayUrl(value = '') {
  const url = new URL(clean(value, 1000));
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Notify Relay URL must use HTTP or HTTPS.');
  if (url.protocol !== 'https:' && !loopback) throw new Error('Notify Relay URL must use HTTPS outside loopback development.');
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
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    signal: AbortSignal.timeout(options.timeoutMs || 20_000),
  });
  const text = await response.text();
  let body = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
  if (!response.ok) throw new Error(body.error || body.reason || `Notify Relay returned HTTP ${response.status}.`);
  return body;
}

async function daemonOwnerRequest(paths, pathname, options = {}) {
  const config = await readJson(paths.config, {});
  if (!config.relayUrl || !config.relayId || !config.token) {
    throw new Error('Notify Daemon is not logged in. Run magclaw-notify daemon login first.');
  }
  return {
    config,
    result: await requestJson(config.relayUrl, pathname, {
      ...options,
      token: config.token,
      fingerprint: config.machineFingerprint,
    }),
  };
}

async function listNotifyAccess(paths, flags = {}) {
  const query = flags.all ? '?include_revoked=1' : '';
  const { result } = await daemonOwnerRequest(paths, `/api/notify/daemon/access${query}`);
  return result;
}

async function revokeNotifyAccess(paths, flags = {}) {
  const accessId = clean(flags.accessId || flags.id || '', 160);
  const userId = clean(flags.userId || '', 160);
  if (!accessId && !userId) throw new Error('access revoke requires --access-id ID or --user-id ID --all.');
  if (userId && flags.all !== true) throw new Error('Revoking every device for a user requires --all.');
  const { result } = await daemonOwnerRequest(paths, '/api/notify/daemon/access/revoke', {
    method: 'POST',
    body: { accessId, userId, all: flags.all === true },
  });
  return result;
}

async function rotateNotifySetupToken(paths, flags = {}) {
  const { config, result } = await daemonOwnerRequest(paths, '/api/notify/daemon/setup-token/rotate', {
    method: 'POST',
    body: { revokeExisting: flags.revokeExisting === true },
  });
  config.inviteToken = result.setupToken;
  config.inviteTokenUpdatedAt = result.rotatedAt;
  config.updatedAt = new Date().toISOString();
  await writeJson(paths.config, config);
  return result;
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

export async function loginNotifyDaemon(flags = {}) {
  const paths = notifyDaemonPaths();
  const previous = await readJson(paths.config, {});
  const relayUrl = normalizeRelayUrl(flags.relayUrl || flags.url || previous.relayUrl || '');
  const fingerprint = machineFingerprint();
  const requestedName = clean(flags.name || previous.relayName || 'MagClaw', 120);
  const requestedRelayId = clean(
    flags.relay || flags.relayId || (flags.name ? '' : previous.relayId),
    160,
  );
  const started = await requestJson(relayUrl, '/api/notify/daemon/auth/start', {
    method: 'POST',
    body: {
      relayId: requestedRelayId,
      relayName: requestedName,
      machineFingerprint: fingerprint,
      client: { hostname: os.hostname(), platform: os.platform(), arch: os.arch() },
    },
  });
  const verificationUrl = new URL(started.verificationUri, `${relayUrl}/`).toString();
  process.stderr.write(`Approve independent MagClaw Notify Daemon:\n${verificationUrl}\nCode: ${started.userCode}\n`);
  if (!flags.noOpen) openBrowser(verificationUrl);
  const deadline = Date.now() + Math.max(30_000, Number(flags.timeoutSeconds || 600) * 1000);
  let approved = null;
  while (Date.now() < deadline) {
    approved = await requestJson(relayUrl, '/api/notify/daemon/auth/token', {
      method: 'POST',
      body: { deviceCode: started.deviceCode, machineFingerprint: fingerprint },
    });
    if (approved.status === 'approved') break;
    if (['expired', 'rejected'].includes(approved.status)) throw new Error(`Notify Daemon login ${approved.status}.`);
    await sleep(Math.max(1000, Number(started.intervalMs || 2000)));
  }
  if (approved?.status !== 'approved' || !approved.token || !approved.relayId) throw new Error('Notify Daemon login timed out.');
  const config = {
    ...previous,
    version: 1,
    relayUrl,
    relayId: approved.relayId,
    relayName: requestedName,
    relayHandle: approved.relayHandle || previous.relayHandle || '',
    inviteToken: approved.inviteToken || previous.inviteToken || '',
    token: approved.token,
    tokenExpiresAt: approved.tokenExpiresAt,
    machineFingerprint: fingerprint,
    owner: approved.user || {},
    createdAt: previous.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeJson(paths.config, config);
  return {
    relayUrl,
    relayId: config.relayId,
    relayHandle: config.relayHandle,
    inviteToken: approved.inviteToken || '',
    inviteTokenCreated: Boolean(approved.inviteToken),
    owner: config.owner,
  };
}

function toWebSocketUrl(relayUrl) {
  const url = new URL(relayUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/notify/connect';
  url.search = '';
  return url.toString();
}

async function connectOnce(paths, config, signal) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(toWebSocketUrl(config.relayUrl), {
      headers: {
        authorization: `Bearer ${config.token}`,
        'x-magclaw-machine-fingerprint': config.machineFingerprint || '',
      },
    });
    let opened = false;
    const stop = () => socket.close(1000, 'Notify Daemon stopping');
    signal?.addEventListener('abort', stop, { once: true });
    socket.on('open', () => {
      opened = true;
      socket.send(JSON.stringify({ type: 'notify:daemon:ready', relayId: config.relayId, version: 1 }));
      process.stdout.write(`[magclaw-notify] connected relay=${config.relayId}\n`);
    });
    socket.on('message', async (raw) => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (message.type === 'notify:ping') {
        socket.send(JSON.stringify({ type: 'notify:pong', at: new Date().toISOString() }));
        return;
      }
      if (message.type === 'notify:targets:list') {
        const grants = await listNotifyTargetGrants(paths.handler, { userId: message.requester?.id || '' });
        socket.send(JSON.stringify({
          type: 'notify:targets:result',
          commandId: message.commandId,
          targets: grants.map((grant) => grant.target),
        }));
        return;
      }
      if (message.type !== 'notify:deliver') return;
      try {
        const prepared = await prepareNotifyDelivery(paths.handler, message.request || {});
        socket.send(JSON.stringify({
          type: 'notify:deliver:ack',
          commandId: message.commandId,
          requestId: message.request?.id || '',
          status: prepared.status,
          publicReason: prepared.publicReason || '',
          confirmationExpiresAt: prepared.confirmationExpiresAt || '',
          pendingRequestCount: prepared.pendingRequestCount || 0,
          batchedRequestIds: prepared.batchedRequestIds || [],
          receivedAt: new Date().toISOString(),
        }));
        if (prepared.promptNeeded && prepared.confirmationId) {
          sendNotifyConfirmationPrompt(paths.handler, prepared.confirmationId).catch((error) => {
            process.stderr.write(`[magclaw-notify] approval prompt failed: ${clean(error.message, 500)}\n`);
          });
        }
        if (prepared.shouldProcess) {
          processAuthorizedNotifyDelivery(paths.handler, message.request || {}).then((result) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'notify:result', commandId: message.commandId, ...result }));
          }).catch((error) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
              type: 'notify:result',
              commandId: message.commandId,
              requestId: message.request?.id || '',
              status: 'failed',
              publicReason: 'Notify delivery failed.',
            }));
            process.stderr.write(`[magclaw-notify] delivery failed: ${clean(error.message, 500)}\n`);
          });
        }
      } catch (error) {
        socket.send(JSON.stringify({
          type: 'notify:deliver:ack',
          commandId: message.commandId,
          requestId: message.request?.id || '',
          status: 'failed',
          publicReason: 'Notify delivery failed.',
        }));
        process.stderr.write(`[magclaw-notify] delivery preparation failed: ${clean(error.message, 500)}\n`);
      }
    });
    socket.on('error', (error) => {
      if (!opened) reject(error);
      else process.stderr.write(`[magclaw-notify] relay error: ${clean(error.message, 500)}\n`);
    });
    socket.on('close', (code) => {
      signal?.removeEventListener('abort', stop);
      if (!opened) reject(new Error(`Notify Relay WebSocket closed before ready (${code}).`));
      else resolve();
    });
  });
}

export async function startNotifyApprovalListener(paths, signal) {
  const handlerConfig = await readJson(path.join(paths.handler.dir, 'notify', 'config.json'), {});
  const provider = handlerConfig.confirmationProvider || {};
  if (provider.kind !== 'lark-cli-feishu' || !provider.enabled || !provider.account || !(provider.ownerOpenId || provider.target)) {
    return { running: false, stop() {} };
  }
  const command = clean(provider.command || process.env.LARK_CLI_PATH || 'lark-cli', 500);
  const child = spawn(command, [
    '--profile', String(provider.account),
    'event', 'consume', 'card.action.trigger',
    '--as', 'bot', '--quiet',
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: process.env });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const seenEvents = new Set();
  let chain = Promise.resolve();
  lines.on('line', (line) => {
    chain = chain.then(async () => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.event_id && seenEvents.has(event.event_id)) return;
      if (event.event_id) {
        seenEvents.add(event.event_id);
        if (seenEvents.size > 500) seenEvents.delete(seenEvents.values().next().value);
      }
      const handled = await handleNotifyCardAction(paths.handler, event);
      if (!handled.handled) return;
      await updateNotifyApprovalCard(paths.handler, event, handled).catch((error) => {
        process.stderr.write(`[magclaw-notify] approval card update failed: ${clean(error.message, 500)}\n`);
      });
      process.stdout.write(`[magclaw-notify] owner approval completed id=${clean(handled.confirmation?.id, 120)} decision=${clean(handled.action?.decision, 40)}\n`);
    }).catch((error) => {
      process.stderr.write(`[magclaw-notify] approval event failed: ${clean(error.message, 500)}\n`);
    });
  });
  child.stderr.on('data', (chunk) => {
    const message = clean(chunk, 500);
    if (message) process.stderr.write(`[magclaw-notify] approval listener: ${message}\n`);
  });
  child.on('error', (error) => {
    process.stderr.write(`[magclaw-notify] approval listener failed: ${clean(error.message, 500)}\n`);
  });
  child.on('exit', (code, childSignal) => {
    if (!signal.aborted) process.stderr.write(`[magclaw-notify] approval listener exited code=${code ?? childSignal}\n`);
  });
  const stop = () => {
    lines.close();
    if (!child.killed) child.kill('SIGTERM');
  };
  signal.addEventListener('abort', stop, { once: true });
  process.stdout.write(`[magclaw-notify] Monkey approval listener started account=${clean(provider.account, 80)}\n`);
  return { running: true, child, stop };
}

export async function runNotifyDaemon(flags = {}) {
  const paths = notifyDaemonPaths();
  const config = await readJson(paths.config, {});
  if (!config.relayUrl || !config.relayId || !config.token) throw new Error('Notify Daemon is not logged in. Run magclaw-notify daemon login first.');
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const approvalListener = await startNotifyApprovalListener(paths, controller.signal);
  const expiryTimer = setInterval(() => {
    expireNotifyConfirmations(paths.handler).catch((error) => {
      process.stderr.write(`[magclaw-notify] approval expiry sweep failed: ${clean(error.message, 500)}\n`);
    });
  }, 60_000);
  expiryTimer.unref?.();
  let delay = DEFAULT_RECONNECT_MIN_MS;
  try {
    await expireNotifyConfirmations(paths.handler);
    while (!controller.signal.aborted) {
      try {
        await connectOnce(paths, config, controller.signal);
        delay = DEFAULT_RECONNECT_MIN_MS;
      } catch (error) {
        process.stderr.write(`[magclaw-notify] connection failed: ${clean(error.message, 500)}\n`);
      }
      if (controller.signal.aborted || flags.once) break;
      await sleep(delay);
      delay = Math.min(DEFAULT_RECONNECT_MAX_MS, delay * 2);
    }
  } finally {
    clearInterval(expiryTimer);
    approvalListener.stop();
  }
  return { stopped: true };
}

async function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function notifyDaemonStatus() {
  const paths = notifyDaemonPaths();
  const config = await readJson(paths.config, {});
  const pid = Number(String(await readFile(paths.pid, 'utf8').catch(() => '')).trim());
  const handler = await notifyHandlerStatus(paths.handler);
  return {
    configured: Boolean(config.relayUrl && config.relayId && config.token),
    running: await processIsRunning(pid),
    pid: await processIsRunning(pid) ? pid : null,
    relayUrl: config.relayUrl || '',
    relayId: config.relayId || '',
    relayHandle: config.relayHandle || '',
    inviteTokenConfigured: Boolean(config.inviteToken),
    handler,
  };
}

export async function startNotifyDaemonBackground() {
  const paths = notifyDaemonPaths();
  const status = await notifyDaemonStatus();
  if (status.running) return status;
  await mkdir(path.dirname(paths.pid), { recursive: true });
  await mkdir(path.dirname(paths.stdout), { recursive: true });
  const stdout = await open(paths.stdout, 'a');
  const stderr = await open(paths.stderr, 'a');
  const child = spawn(process.execPath, [BIN_PATH, 'daemon', 'run'], {
    detached: true,
    stdio: ['ignore', stdout.fd, stderr.fd],
    windowsHide: true,
    env: process.env,
  });
  child.unref();
  await stdout.close();
  await stderr.close();
  await writeFile(paths.pid, `${child.pid}\n`, { mode: 0o600 });
  await sleep(500);
  return notifyDaemonStatus();
}

export async function stopNotifyDaemon() {
  const paths = notifyDaemonPaths();
  const pid = Number(String(await readFile(paths.pid, 'utf8').catch(() => '')).trim());
  if (await processIsRunning(pid)) process.kill(pid, 'SIGTERM');
  await rm(paths.pid, { force: true });
  return { stopped: true, pid: Number.isInteger(pid) ? pid : null };
}

function commaList(value = '') {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

export async function runNotifyDaemonCommand(positional = [], flags = {}) {
  const command = positional[0] || 'status';
  const paths = notifyDaemonPaths();
  if (command === 'access') {
    const action = positional[1] || 'list';
    if (action === 'list') return listNotifyAccess(paths, flags);
    if (action === 'revoke') return revokeNotifyAccess(paths, flags);
    throw new Error(`Unknown Notify access command: ${action}`);
  }
  if (command === 'grants') {
    const action = positional[1] || 'list';
    if (action === 'list') return { grants: await listNotifyTargetGrants(paths.handler, { userId: flags.userId, includeRevoked: flags.all === true }) };
    if (action === 'revoke') return revokeNotifyTargetGrant(paths.handler, { grantId: flags.grantId || flags.id, userId: flags.userId, group: flags.group });
    throw new Error(`Unknown Notify grants command: ${action}`);
  }
  if (command === 'setup-token') {
    const action = positional[1] || '';
    if (action === 'rotate') return rotateNotifySetupToken(paths, flags);
    throw new Error(`Unknown Notify setup-token command: ${action || '[missing]'}`);
  }
  if (command === 'login' || command === 'setup') return loginNotifyDaemon(flags);
  if (command === 'run') return runNotifyDaemon(flags);
  if (command === 'start') return startNotifyDaemonBackground();
  if (command === 'stop') return stopNotifyDaemon();
  if (command === 'status') return notifyDaemonStatus();
  if (command === 'configure') {
    return configureNotifyHandler(paths.handler, {
      ...(flags.enabled !== undefined ? { enabled: flags.enabled !== 'false' } : {}),
      agentProvider: {
        ...(flags.agentProvider ? { kind: flags.agentProvider } : {}),
        ...(flags.agentCommand ? { command: flags.agentCommand } : {}),
        ...(flags.agentId ? { agentId: flags.agentId } : {}),
      },
      deliveryProvider: {
        ...(flags.deliveryProvider ? { kind: flags.deliveryProvider } : {}),
        ...(flags.deliveryCommand ? { command: flags.deliveryCommand } : {}),
        ...(flags.deliveryAccount !== undefined ? { account: flags.deliveryAccount } : {}),
        ...(flags.deliveryEnabled !== undefined ? { enabled: flags.deliveryEnabled !== 'false' } : {}),
        ...(flags.dryRun !== undefined ? { dryRun: flags.dryRun !== 'false' } : {}),
      },
      confirmationProvider: {
        ...(flags.confirmationProvider ? { kind: flags.confirmationProvider } : {}),
        ...(flags.confirmationCommand ? { command: flags.confirmationCommand } : {}),
        ...(flags.confirmationAccount !== undefined ? { account: flags.confirmationAccount } : {}),
        ...(flags.confirmationTarget !== undefined ? { target: flags.confirmationTarget } : {}),
        ...(flags.ownerOpenId !== undefined ? { ownerOpenId: flags.ownerOpenId } : {}),
        ...(flags.confirmationEnabled !== undefined ? { enabled: flags.confirmationEnabled !== 'false' } : {}),
      },
    });
  }
  if (command === 'add-group') return addNotifyGroup(paths.handler, { name: flags.name, chatId: flags.chatId, aliases: commaList(flags.aliases || flags.alias) });
  if (command === 'add-person') return addNotifyPerson(paths.handler, { name: flags.name, openId: flags.openId, aliases: commaList(flags.aliases || flags.alias), groupChatIds: commaList(flags.groupChatIds || flags.groupChatId) });
  if (command === 'sync-directory') return syncNotifyDirectory(paths.handler);
  if (command === 'install-handler-skill') return installNotifyHandlerSkill({ targets: commaList(flags.targets || flags.target || 'openclaw') });
  if (command === 'confirm') {
    const decisions = [['approve', flags.approve], ['once', flags.once], ['always', flags.always], ['reject', flags.reject]].filter(([, enabled]) => enabled === true);
    if (decisions.length !== 1) throw new Error('Choose exactly one of --approve, --once, --always, or --reject.');
    return confirmNotifyMapping(paths.handler, flags.id, decisions[0][0], { personMappings: commaList(flags.personMap || flags.personMaps) });
  }
  throw new Error(`Unknown Notify Daemon command: ${command}`);
}
