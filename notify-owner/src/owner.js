import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  createNotifyAuditLog,
  LOCAL_NOTIFY_AUDIT_MAX_DAYS,
  LOCAL_NOTIFY_AUDIT_MAX_FILE_BYTES,
  LOCAL_NOTIFY_AUDIT_MAX_FILES,
  LOCAL_NOTIFY_AUDIT_MAX_FILES_PER_DAY,
} from '../../notify/src/audit.js';
import { resolveNotifyExecutable } from './executable.js';
import { notifyInstanceFromFlags } from './instance.js';
import { installNotifyOpenClawPlugin } from './plugin-installer.js';
import {
  applyNotifyOwnerUpdate,
  checkNotifyOwnerUpdate,
  readNotifyOwnerUpdateState,
  rollbackNotifyOwnerUpdate,
  runNotifyOwnerBackgroundUpdate,
  scheduleNotifyOwnerBackgroundUpdate,
} from './update.js';
import {
  addNotifyBinding,
  listNotifyBindings,
  notifyBindingProfile,
  notifyBindingsPaths,
  resolveNotifyBinding,
  setNotifyBindingEnabled,
} from './bindings.js';
import { ensureNotifyStateStore } from './store.js';
import {
  disableNotifyDaemonAutostart,
  enableNotifyDaemonAutostart,
  notifyDaemonAutostartStatus,
  notifyDaemonServiceSpec,
  stopNotifyDaemonService,
} from './service.js';
import {
  addNotifyGroup,
  addNotifyPerson,
  applyNotifyDirectory,
  configureNotifyHandler,
  confirmNotifyMapping,
  ensureNotifyHandlerState,
  expireNotifyConfirmations,
  handleNotifyCardAction,
  inspectNotifyCardAction,
  installNotifyHandlerSkill,
  listNotifyDirectory,
  listNotifyTargetGrants,
  notifyHandlerStatus,
  notifyOpenClawApprovalPluginPath,
  prepareNotifyDelivery,
  processAuthorizedNotifyDelivery,
  removeNotifyDirectoryEntry,
  revokeNotifyTargetGrant,
  sendNotifyConfirmationPrompt,
  syncNotifyDirectory,
  updateNotifyDirectoryAlias,
  updateNotifyApprovalCard,
} from './handler.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_PATH = path.join(PACKAGE_ROOT, 'bin', 'magclaw-notify-owner.js');
const DEFAULT_RECONNECT_MIN_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const ownerAuditLogs = new Map();

function clean(value = '', max = 2000) {
  return String(value || '').replace(/\u0000/g, '').trim().slice(0, max);
}

export function verifiedFeishuRequester(requester = {}) {
  const identity = requester?.identity && typeof requester.identity === 'object' ? requester.identity : {};
  return identity.provider === 'feishu'
    && Boolean(identity.providerAccountId || identity.openId || identity.userId || identity.unionId);
}

function notifyHome(env = process.env) {
  return path.resolve(env.MAGCLAW_NOTIFY_HOME || path.join(os.homedir(), '.magclaw', 'notify'));
}

function notifyEnvironment(flags = {}) {
  if (!flags.notifyHome) return process.env;
  return { ...process.env, MAGCLAW_NOTIFY_HOME: path.resolve(clean(flags.notifyHome, 1000)) };
}

async function existingOpenClawNotifyConfig(flags = {}) {
  const command = clean(flags.openclawPath || process.env.OPENCLAW_PATH || 'openclaw', 500);
  try {
    const result = await runOpenClawCommand(command, ['config', 'get', 'plugins.entries.magclaw-notify.config', '--json']);
    const config = JSON.parse(result.stdout || '{}');
    return config && typeof config === 'object' && !Array.isArray(config) ? config : {};
  } catch { return {}; }
}

async function flagsWithConfiguredNotifyHome(flags = {}) {
  if (flags.notifyHome || process.env.MAGCLAW_NOTIFY_HOME) return flags;
  const config = await existingOpenClawNotifyConfig(flags);
  const configured = clean(config.notifyHome || '', 1000);
  return configured ? { ...flags, notifyHome: configured } : flags;
}

async function ownerPathsFromFlags(flags = {}, options = {}) {
  const env = notifyEnvironment(flags);
  if (flags._paths) return flags._paths;
  // Compatibility only: old scripts may still pass --instance during the
  // migration release. New user-facing flows use --bot and bindings.json.
  if (flags.instance && !flags.bot) return notifyDaemonPaths(env, notifyInstanceFromFlags(flags));
  try { return (await resolveNotifyBinding({ bot: flags.bot, accountId: flags.accountId }, env)).profile; }
  catch (error) {
    if (!options.allowUnconfigured) throw error;
    const home = notifyBindingsPaths(env).home;
    return {
      instance: 'owner', bindingId: '', home, root: path.join(home, 'owner'), config: path.join(home, 'owner', 'config.json'),
      pid: path.join(home, 'owner', 'run', 'daemon.pid'), stdout: path.join(home, 'owner', 'logs', 'daemon.log'), stderr: path.join(home, 'owner', 'logs', 'daemon.error.log'),
      auditDir: path.join(home, 'owner', 'audit'), handler: { dir: path.join(home, 'owner'), config: path.join(home, 'owner', 'config.json'), profile: 'owner' },
    };
  }
}

export function notifyDaemonPaths(env = process.env, instance = 'default') {
  const root = instance === 'default'
    ? path.join(notifyHome(env), 'daemon')
    : path.join(notifyHome(env), 'daemons', instance);
  return {
    instance,
    home: notifyHome(env),
    root,
    config: path.join(root, 'config.json'),
    pid: path.join(root, 'run', 'daemon.pid'),
    stdout: path.join(root, 'logs', 'daemon.log'),
    stderr: path.join(root, 'logs', 'daemon.error.log'),
    auditDir: path.join(root, 'audit'),
    handler: { dir: root, config: path.join(root, 'config.json'), profile: instance },
  };
}

function ownerAudit(paths) {
  if (!ownerAuditLogs.has(paths.auditDir)) {
    ownerAuditLogs.set(paths.auditDir, createNotifyAuditLog({
      dir: paths.auditDir,
      scope: 'owner',
      base: { bot: paths.bindingId || paths.instance },
      maxFileBytes: LOCAL_NOTIFY_AUDIT_MAX_FILE_BYTES,
      maxFiles: LOCAL_NOTIFY_AUDIT_MAX_FILES,
      maxDays: LOCAL_NOTIFY_AUDIT_MAX_DAYS,
      maxFilesPerDay: LOCAL_NOTIFY_AUDIT_MAX_FILES_PER_DAY,
    }));
  }
  return ownerAuditLogs.get(paths.auditDir);
}

function auditError(error) {
  return { errorName: clean(error?.name || 'Error', 80), errorMessage: clean(error?.message || error, 500) };
}

async function readJson(file, fallback = {}) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(file, 0o600).catch(() => {});
}

export async function ensureNotifyRuntimeLogs(paths) {
  const logDir = path.dirname(paths.stdout);
  await mkdir(logDir, { recursive: true, mode: 0o700 });
  await chmod(logDir, 0o700).catch(() => {});
  for (const file of [paths.stdout, paths.stderr]) {
    await writeFile(file, '', { flag: 'a', mode: 0o600 });
    await chmod(file, 0o600).catch(() => {});
  }
}

function newInstallationFingerprint() {
  // This is an opaque installation nonce, not a fingerprint of the machine.
  // Existing profiles retain their legacy value so upgrades do not invalidate
  // the Owner token.
  return `mfp_${crypto.randomBytes(32).toString('hex')}`;
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
      ...(options.headers || {}),
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
    throw new Error('Notify Owner is not logged in. Run magclaw-notify-owner login first.');
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

async function kickNotifyAccess(paths, flags = {}) {
  const userId = clean(flags.userId || '', 160);
  if (!userId) throw new Error('access kick requires --user-id ID.');
  const { result } = await daemonOwnerRequest(paths, '/api/notify/daemon/access/kick', {
    method: 'POST',
    body: { userId },
  });
  return {
    ok: result.ok === true,
    userId,
    cloudLoginsRevoked: Math.max(0, Number(result.cloudLoginsRevoked || 0)),
    localGroupGrantsRevoked: Math.max(0, Number(result.localGroupGrantsRevoked || 0)),
    localDaemonAvailable: result.localDaemonAvailable === true,
  };
}

async function dumpNotifyState(paths, flags = {}) {
  const store = await ensureNotifyStateStore(paths.handler);
  if (flags.legacyDir) {
    const exported = await store.exportLegacyJson(path.resolve(clean(flags.legacyDir, 1000)));
    return { format: 'legacy-json', output: exported.output, fileCount: exported.files.length };
  }
  const dump = store.dump();
  if (flags.output) {
    const output = path.resolve(clean(flags.output, 1000));
    await writeJson(output, dump);
    return { format: 'readable-json', output };
  }
  return dump;
}

async function rotateNotifySetupToken(paths, flags = {}) {
  const { config, result } = await daemonOwnerRequest(paths, '/api/notify/daemon/setup-token/rotate', {
    method: 'POST',
    body: { revokeExisting: flags.revokeExisting === true },
  });
  config.inviteToken = result.setupToken;
  config.inviteTokenUpdatedAt = result.rotatedAt;
  delete config.inviteTokenDisabledAt;
  config.updatedAt = new Date().toISOString();
  await writeJson(paths.config, config);
  return result;
}

async function disableNotifySetupToken(paths, flags = {}) {
  const { config, result } = await daemonOwnerRequest(paths, '/api/notify/daemon/setup-token/disable', {
    method: 'POST',
    body: { revokeExisting: flags.revokeExisting === true },
  });
  delete config.inviteToken;
  config.inviteTokenDisabledAt = result.disabledAt;
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
  const paths = flags._paths || await ownerPathsFromFlags(flags);
  const instance = paths.instance;
  const previous = await readJson(paths.config, {});
  const relayUrl = normalizeRelayUrl(flags.relayUrl || flags.url || previous.relayUrl || '');
  const fingerprint = previous.machineFingerprint || newInstallationFingerprint();
  const requestedName = clean(flags.name || previous.relayName || 'MagClaw', 120);
  const requestedRelayId = clean(
    flags.relay || flags.relayId || (flags.name ? '' : previous.relayId),
    160,
  );
  const started = await requestJson(relayUrl, '/api/notify/daemon/auth/start', {
    method: 'POST',
    headers: flags.bootstrapToken ? { 'x-magclaw-notify-bootstrap': String(flags.bootstrapToken) } : {},
    body: {
      relayId: requestedRelayId,
      relayName: requestedName,
      instance,
      machineFingerprint: fingerprint,
    },
  });
  const verificationUrl = new URL(started.verificationUri, `${relayUrl}/`).toString();
  process.stderr.write(`Approve MagClaw Notify Owner:\n${verificationUrl}\nCode: ${started.userCode}\n`);
  if (!flags.noOpen) openBrowser(verificationUrl);
  const deadline = Date.now() + Math.max(30_000, Number(flags.timeoutSeconds || 600) * 1000);
  let approved = null;
  while (Date.now() < deadline) {
    approved = await requestJson(relayUrl, '/api/notify/daemon/auth/token', {
      method: 'POST',
      body: { deviceCode: started.deviceCode, machineFingerprint: fingerprint },
    });
    if (approved.status === 'approved') break;
    if (['expired', 'rejected'].includes(approved.status)) throw new Error(`Notify Owner login ${approved.status}.`);
    await sleep(Math.max(1000, Number(started.intervalMs || 2000)));
  }
  if (approved?.status !== 'approved' || !approved.token || !approved.relayId) throw new Error('Notify Owner login timed out.');
  const config = {
    ...previous,
    version: 1,
    instance,
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

export async function connectOnce(paths, config, signal) {
  const audit = ownerAudit(paths);
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
      audit.append({ event: 'owner.relay.connected', outcome: 'succeeded', relayId: config.relayId, metadata: { relayUrl: config.relayUrl } });
    });
    socket.on('message', async (raw) => {
      let message;
      try { message = JSON.parse(String(raw)); } catch {
        await audit.append({ event: 'owner.relay.message_rejected', outcome: 'invalid_json', severity: 'warning', relayId: config.relayId });
        return;
      }
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
        await audit.append({
          event: 'owner.targets.query_completed', outcome: 'succeeded', relayId: config.relayId, commandId: message.commandId || '',
          metadata: { requesterPresent: Boolean(message.requester?.id), targetCount: grants.length },
        });
        return;
      }
      if (message.type === 'notify:grants:revoke') {
        try {
          const result = await revokeNotifyTargetGrant(paths.handler, { userId: message.userId || '' });
          socket.send(JSON.stringify({
            type: 'notify:grants:result',
            commandId: message.commandId,
            status: 'succeeded',
            revoked: result.revoked,
          }));
          await audit.append({
            event: 'owner.grants.revoke_completed', outcome: 'succeeded', relayId: config.relayId, commandId: message.commandId || '',
            metadata: { userIdPresent: Boolean(message.userId), revokedCount: result.revoked },
          });
        } catch (error) {
          socket.send(JSON.stringify({ type: 'notify:grants:result', commandId: message.commandId, status: 'failed', revoked: 0 }));
          await audit.append({
            event: 'owner.grants.revoke_completed', outcome: 'failed', severity: 'error', relayId: config.relayId, commandId: message.commandId || '',
            metadata: { userIdPresent: Boolean(message.userId), ...auditError(error) },
          });
        }
        return;
      }
      if (message.type !== 'notify:deliver') return;
      await audit.append({
        event: 'owner.request.received',
        outcome: 'accepted',
        relayId: config.relayId,
        requestId: message.request?.id || '',
        commandId: message.commandId || '',
        metadata: { targetGroup: message.request?.payload?.target?.group || '', requesterName: message.request?.requester?.name || '' },
      });
      try {
        if (!verifiedFeishuRequester(message.request?.requester)) {
          socket.send(JSON.stringify({
            type: 'notify:deliver:ack',
            commandId: message.commandId,
            requestId: message.request?.id || '',
            status: 'rejected',
            publicReason: 'A verified Feishu requester identity is required.',
          }));
          await audit.append({
            event: 'owner.request.identity_rejected', outcome: 'rejected', severity: 'warning',
            requestId: message.request?.id || '', commandId: message.commandId || '',
            metadata: { requesterPresent: Boolean(message.request?.requester?.id) },
          });
          return;
        }
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
        await audit.append({
          event: 'owner.request.acknowledged',
          outcome: prepared.status || 'observed',
          relayId: config.relayId,
          requestId: message.request?.id || '',
          confirmationId: prepared.confirmationId || '',
          commandId: message.commandId || '',
          metadata: { promptNeeded: Boolean(prepared.promptNeeded), shouldProcess: Boolean(prepared.shouldProcess), pendingRequestCount: prepared.pendingRequestCount || 0 },
        });
        if (prepared.promptNeeded && prepared.confirmationId) {
          sendNotifyConfirmationPrompt(paths.handler, prepared.confirmationId).then(() => audit.append({
            event: 'owner.approval.prompt_sent', outcome: 'succeeded', requestId: message.request?.id || '', confirmationId: prepared.confirmationId,
          })).catch((error) => {
            audit.append({ event: 'owner.approval.prompt_sent', outcome: 'failed', severity: 'error', requestId: message.request?.id || '', confirmationId: prepared.confirmationId, metadata: auditError(error) });
            process.stderr.write(`[magclaw-notify] approval prompt failed: ${clean(error.message, 500)}\n`);
          });
        }
        if (prepared.shouldProcess) {
          processAuthorizedNotifyDelivery(paths.handler, message.request || {}).then((result) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'notify:result', commandId: message.commandId, ...result }));
            audit.append({ event: 'owner.request.completed', outcome: result.status || 'unknown', requestId: message.request?.id || '', commandId: message.commandId || '', metadata: { provider: result.provider || '' } });
          }).catch((error) => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({
              type: 'notify:result',
              commandId: message.commandId,
              requestId: message.request?.id || '',
              status: 'failed',
              publicReason: 'Notify delivery failed.',
            }));
            audit.append({ event: 'owner.request.completed', outcome: 'failed', severity: 'error', requestId: message.request?.id || '', commandId: message.commandId || '', metadata: auditError(error) });
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
        await audit.append({ event: 'owner.request.preparation', outcome: 'failed', severity: 'error', requestId: message.request?.id || '', commandId: message.commandId || '', metadata: auditError(error) });
        process.stderr.write(`[magclaw-notify] delivery preparation failed: ${clean(error.message, 500)}\n`);
      }
    });
    socket.on('error', (error) => {
      audit.append({ event: 'owner.relay.socket_error', outcome: 'failed', severity: 'error', relayId: config.relayId, metadata: auditError(error) });
      if (!opened) reject(error);
      else process.stderr.write(`[magclaw-notify] relay error: ${clean(error.message, 500)}\n`);
    });
    socket.on('close', (code) => {
      signal?.removeEventListener('abort', stop);
      if (!opened) reject(new Error(`Notify Relay WebSocket closed before ready (${code}).`));
      else resolve();
      audit.append({ event: 'owner.relay.disconnected', outcome: 'observed', relayId: config.relayId, metadata: { closeCode: code } });
    });
  });
}

export async function startNotifyApprovalListener(paths, signal) {
  const handlerConfig = (await ensureNotifyHandlerState(paths.handler)).config;
  const provider = handlerConfig.confirmationProvider || {};
  if (provider.kind !== 'lark-cli-feishu' || !provider.enabled || provider.eventConsumer !== 'standalone' || !provider.account || !(provider.ownerOpenId || provider.target)) {
    return { running: false, stop() {} };
  }
  const command = clean(provider.command || process.env.LARK_CLI_PATH || 'lark-cli', 500);
  const executable = resolveNotifyExecutable(command);
  const child = spawn(executable, [
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
      const handled = await processNotifyApprovalEvent(paths.handler, event);
      if (!handled.handled) return;
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

export async function processNotifyApprovalEvent(profilePaths, event, dependencies = {}) {
  const inspect = dependencies.inspect || inspectNotifyCardAction;
  const handle = dependencies.handle || handleNotifyCardAction;
  const update = dependencies.update || updateNotifyApprovalCard;
  const onUpdateError = dependencies.onUpdateError || ((error, phase) => {
    process.stderr.write(`[magclaw-notify] approval card ${phase} update failed: ${clean(error.message, 500)}\n`);
  });
  const inspected = await inspect(profilePaths, event);
  if (!inspected.handled) return inspected;
  const decision = inspected.action?.decision || 'reject';
  const shouldShowProgress = inspected.confirmation?.status === 'pending' && ['approve', 'once', 'always'].includes(decision);
  if (shouldShowProgress) {
    await update(profilePaths, event, {
      ...inspected,
      phase: 'processing',
      result: { status: 'processing' },
    }).catch((error) => onUpdateError(error, 'processing'));
  }
  try {
    const handled = await handle(profilePaths, event, { inspection: inspected });
    if (!handled.handled) return handled;
    await update(profilePaths, event, { ...handled, phase: 'completed' }).catch((error) => onUpdateError(error, 'completed'));
    return handled;
  } catch (error) {
    await update(profilePaths, event, {
      ...inspected,
      phase: 'completed',
      result: { status: 'failed', publicReason: clean(error.message, 1000) },
    }).catch((updateError) => onUpdateError(updateError, 'failed'));
    throw error;
  }
}

export async function runNotifyDaemon(flags = {}) {
  const paths = flags._paths || await ownerPathsFromFlags(flags);
  const instance = paths.instance;
  const config = await readJson(paths.config, {});
  if (!config.relayUrl || !config.relayId || !config.token) throw new Error('Notify Owner is not logged in. Run magclaw-notify-owner login first.');
  await ensureNotifyRuntimeLogs(paths);
  const controller = new AbortController();
  const audit = ownerAudit(paths);
  await audit.append({ event: 'owner.daemon.started', outcome: 'succeeded', relayId: config.relayId, metadata: { pid: process.pid, configPath: paths.config, auditDir: paths.auditDir, eventConsumer: (await ensureNotifyHandlerState(paths.handler)).config.confirmationProvider?.eventConsumer || 'openclaw' } });
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await mkdir(path.dirname(paths.pid), { recursive: true });
  await writeFile(paths.pid, `${process.pid}\n`, { mode: 0o600 });
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
        await audit.append({ event: 'owner.relay.connection_failed', outcome: 'failed', severity: 'error', relayId: config.relayId, metadata: { retryDelayMs: delay, ...auditError(error) } });
        process.stderr.write(`[magclaw-notify] connection failed: ${clean(error.message, 500)}\n`);
      }
      if (controller.signal.aborted || flags.once) break;
      await sleep(delay);
      delay = Math.min(DEFAULT_RECONNECT_MAX_MS, delay * 2);
    }
  } finally {
    clearInterval(expiryTimer);
    approvalListener.stop();
    const recordedPid = Number(String(await readFile(paths.pid, 'utf8').catch(() => '')).trim());
    if (recordedPid === process.pid) await rm(paths.pid, { force: true });
    await audit.append({ event: 'owner.daemon.stopped', outcome: 'succeeded', relayId: config.relayId, metadata: { pid: process.pid } });
  }
  return { stopped: true, bot: paths.bindingId || instance };
}

async function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function notifyDaemonStatus(flags = {}) {
  const paths = flags._paths || await ownerPathsFromFlags(flags);
  const instance = paths.instance;
  const config = await readJson(paths.config, {});
  const pid = Number(String(await readFile(paths.pid, 'utf8').catch(() => '')).trim());
  const pluginHost = await readJson(path.join(paths.root, 'run', 'plugin-host.json'), {});
  const pluginHostRunning = pluginHost.mode === 'plugin-hosted' && await processIsRunning(Number(pluginHost.pid));
  const handler = await notifyHandlerStatus(paths.handler);
  let openclawApproval = null;
  if (handler.approvalEventConsumer === 'openclaw') {
    openclawApproval = await manageOpenClawApproval(paths, ['openclaw-approval', 'status']).catch((error) => ({
      enabled: false,
      approvalAgentId: handler.approvalAgentId || '',
      allowlistMatched: false,
      execSecurity: 'unknown',
      execAsk: 'unknown',
      error: clean(error.message, 500),
    }));
  }
  const service = notifyDaemonServiceSpec({ instance, notifyHome: paths.home, binPath: BIN_PATH, logPath: paths.stdout, errorLogPath: paths.stderr });
  const autostart = await notifyDaemonAutostartStatus(service);
  return {
    bot: paths.bindingId || instance,
    mode: pluginHostRunning ? 'plugin-hosted' : 'standalone-daemon',
    configured: Boolean(config.relayUrl && config.relayId && config.token),
    running: pluginHostRunning || await processIsRunning(pid),
    pid: pluginHostRunning ? Number(pluginHost.pid) : await processIsRunning(pid) ? pid : null,
    pluginHost: pluginHostRunning ? { relayEnabled: Boolean(pluginHost.relayEnabled), startedAt: pluginHost.startedAt || '' } : null,
    relayUrl: config.relayUrl || '',
    relayId: config.relayId || '',
    relayHandle: config.relayHandle || '',
    inviteTokenConfigured: Boolean(config.inviteToken),
    setupTokenEnabled: Boolean(config.inviteToken),
    autostart,
    handler,
    openclawApproval,
    audit: await ownerAudit(paths).status(),
  };
}

export async function startNotifyDaemonBackground(flags = {}) {
  const paths = flags._paths || await ownerPathsFromFlags(flags);
  const instance = paths.instance;
  const status = await notifyDaemonStatus({ ...flags, _paths: paths });
  if (status.running) return status;
  await mkdir(path.dirname(paths.pid), { recursive: true });
  await ensureNotifyRuntimeLogs(paths);
  if (flags.noAutostart !== true) {
    const service = notifyDaemonServiceSpec({ instance, notifyHome: paths.home, binPath: BIN_PATH, logPath: paths.stdout, errorLogPath: paths.stderr });
    await enableNotifyDaemonAutostart(service);
    await sleep(500);
    return notifyDaemonStatus({ ...flags, _paths: paths });
  }
  const stdout = await open(paths.stdout, 'a', 0o600);
  const stderr = await open(paths.stderr, 'a', 0o600);
  const selector = paths.bindingId ? ['--bot', paths.bindingId] : ['--instance', instance];
  const child = spawn(process.execPath, [BIN_PATH, 'daemon', 'run', ...selector, '--notify-home', paths.home], {
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
  return notifyDaemonStatus({ ...flags, _paths: paths });
}

export async function stopNotifyDaemon(flags = {}) {
  const paths = flags._paths || await ownerPathsFromFlags(flags);
  const instance = paths.instance;
  const service = notifyDaemonServiceSpec({ instance, notifyHome: paths.home, binPath: BIN_PATH, logPath: paths.stdout, errorLogPath: paths.stderr });
  await stopNotifyDaemonService(service);
  const pid = Number(String(await readFile(paths.pid, 'utf8').catch(() => '')).trim());
  if (await processIsRunning(pid)) process.kill(pid, 'SIGTERM');
  await rm(paths.pid, { force: true });
  return { stopped: true, bot: paths.bindingId || instance, pid: Number.isInteger(pid) ? pid : null, autostartPreserved: true };
}

async function manageNotifyDaemonAutostart(paths, positional, flags = {}) {
  const action = positional[1] || 'status';
  const instance = paths.instance;
  const spec = notifyDaemonServiceSpec({ instance, notifyHome: paths.home, binPath: BIN_PATH, logPath: paths.stdout, errorLogPath: paths.stderr });
  if (action === 'status') return { bot: paths.bindingId || instance, ...(await notifyDaemonAutostartStatus(spec)) };
  if (action === 'enable') {
    await ensureNotifyRuntimeLogs(paths);
    return { bot: paths.bindingId || instance, ...(await enableNotifyDaemonAutostart(spec)) };
  }
  if (action === 'disable') return { bot: paths.bindingId || instance, ...(await disableNotifyDaemonAutostart(spec)) };
  throw new Error(`Unknown Notify autostart command: ${action}`);
}

function commaList(value = '') {
  return String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

function runOpenClawCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    const executable = resolveNotifyExecutable(command || 'openclaw');
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`OpenClaw command failed: ${clean(stderr || stdout, 1000)}`));
    });
  });
}

async function backupOpenClawConfig(command, notifyHomePath) {
  const output = String((await runOpenClawCommand(command, ['config', 'file'])).stdout || '');
  const line = output.split(/\r?\n/).map((item) => item.trim()).reverse().find((item) => item && !item.startsWith('│') && !item.startsWith('◇')) || '';
  const configPath = line.startsWith('~/') ? path.join(os.homedir(), line.slice(2)) : path.resolve(line);
  if (!line || !await readFile(configPath).then(() => true).catch(() => false)) return null;
  const backupDir = path.join(notifyHomePath, 'backups', 'openclaw');
  await mkdir(backupDir, { recursive: true, mode: 0o700 });
  const backupPath = path.join(backupDir, `openclaw-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  await copyFile(configPath, backupPath);
  await chmod(backupPath, 0o600).catch(() => {});
  const backups = (await readdir(backupDir)).filter((name) => /^openclaw-.*\.json$/.test(name)).sort().reverse();
  for (const old of backups.slice(5)) await rm(path.join(backupDir, old), { force: true });
  return { configPath, backupPath };
}

async function restoreOpenClawConfig(backup) {
  if (!backup) return;
  const temporary = `${backup.configPath}.magclaw-restore-${process.pid}`;
  await copyFile(backup.backupPath, temporary);
  await rename(temporary, backup.configPath);
}

async function manageOpenClawNotifyPlugin(paths, positional, flags = {}) {
  const action = positional[1] || 'status';
  const env = notifyEnvironment(flags);
  const existingConfig = await existingOpenClawNotifyConfig(flags);
  const bindingList = await listNotifyBindings(env);
  const selectedStates = await Promise.all(bindingList.bindings.map(async (binding) => {
    const profile = notifyBindingProfile(binding, env);
    return { binding, profile, state: await ensureNotifyHandlerState(profile.handler) };
  }));
  const openclawCommand = clean(selectedStates[0]?.state?.config?.agentProvider?.command || process.env.OPENCLAW_PATH || 'openclaw', 500);
  const pluginPath = notifyOpenClawApprovalPluginPath({ pluginPath: flags.pluginPath });
  const status = async () => {
    let plugins = {};
    let gateway = {};
    try { plugins = JSON.parse((await runOpenClawCommand(openclawCommand, ['plugins', 'list', '--json'])).stdout || '{}'); } catch (error) { plugins = { error: clean(error.message, 500) }; }
    try { gateway = JSON.parse((await runOpenClawCommand(openclawCommand, ['gateway', 'status', '--json'])).stdout || '{}'); } catch (error) { gateway = { error: clean(error.message, 500) }; }
    const pluginEntries = Array.isArray(plugins?.plugins) ? plugins.plugins : Array.isArray(plugins) ? plugins : [];
    const notifyPlugin = pluginEntries.find((entry) => entry?.id === 'magclaw-notify' || entry?.name === 'magclaw-notify');
    const bots = await Promise.all(selectedStates.map(async ({ binding, profile }) => {
      const runtime = await notifyDaemonStatus({ ...flags, _paths: profile }).catch((error) => ({ running: false, error: clean(error.message, 300) }));
      return { id: binding.id, name: binding.name, accountId: binding.accountId, enabled: binding.enabled, running: runtime.mode === 'plugin-hosted' && runtime.running, configured: runtime.configured, ...(runtime.error ? { error: runtime.error } : {}) };
    }));
    return {
      pluginPath,
      installed: await readFile(path.join(pluginPath, 'installation.json'), 'utf8').then(() => true).catch(() => false),
      enabled: notifyPlugin?.enabled === true || notifyPlugin?.status === 'enabled' || notifyPlugin?.state === 'enabled',
      running: bots.some((bot) => bot.running),
      bots,
      gateway,
    };
  };
  if (action === 'status') return status();
  if (!['start', 'stop', 'restart'].includes(action)) throw new Error(`Unknown Notify plugin command: ${action}`);
  if (action === 'restart') {
    await runOpenClawCommand(openclawCommand, ['gateway', 'restart']);
    return status();
  }
  if (action === 'stop') {
    await runOpenClawCommand(openclawCommand, ['plugins', 'disable', 'magclaw-notify']);
    await runOpenClawCommand(openclawCommand, ['gateway', 'restart']);
    return status();
  }
  const installed = await readFile(path.join(pluginPath, 'installation.json'), 'utf8').then(() => true).catch(() => false);
  if (!installed) throw new Error(`Install the fixed MagClaw Notify plugin copy first: magclaw-notify-owner install --target ${pluginPath}`);
  const pluginConfig = {
    ...existingConfig,
    notifyHome: paths.home,
    bindings: selectedStates.map(({ binding }) => ({
      id: binding.id,
      name: binding.name,
      channel: 'feishu',
      accountId: binding.accountId,
      enabled: binding.enabled !== false,
      legacy: binding.legacy === true,
    })),
    relayEnabled: flags.relayEnabled !== 'false',
    autoUpdate: flags.autoUpdate !== 'false',
    ...(flags.relayUrl ? { relayUrl: clean(flags.relayUrl, 1000) } : {}),
    ...(flags.memberAgentId ? { memberAgentId: clean(flags.memberAgentId, 120) } : {}),
    ...(flags.projectName ? { projectName: clean(flags.projectName, 120) } : {}),
    ...(flags.memberReadTools ? { memberReadTools: commaList(flags.memberReadTools) } : {}),
  };
  // Old single-profile selectors are intentionally not written back. The
  // bindings array is the only current routing source of truth.
  delete pluginConfig.instance;
  delete pluginConfig.accountId;
  const backup = await backupOpenClawConfig(openclawCommand, paths.home);
  try {
    await runOpenClawCommand(openclawCommand, ['plugins', 'enable', 'magclaw-notify']);
    await runOpenClawCommand(openclawCommand, ['config', 'set', 'plugins.entries.magclaw-notify.config', JSON.stringify(pluginConfig), '--strict-json']);
    await runOpenClawCommand(openclawCommand, ['config', 'set', 'plugins.entries.magclaw-notify.hooks.allowPromptInjection', 'true', '--strict-json']);
    await runOpenClawCommand(openclawCommand, ['config', 'set', 'plugins.entries.magclaw-notify.hooks.allowConversationAccess', 'true', '--strict-json']);
    await runOpenClawCommand(openclawCommand, ['config', 'validate']);
    await runOpenClawCommand(openclawCommand, ['gateway', 'restart']);
  } catch (error) {
    await restoreOpenClawConfig(backup).catch(() => {});
    throw error;
  }
  return status();
}

async function resolveOpenClawApprovalAgent(config = {}) {
  const configured = clean(config.confirmationProvider?.approvalAgentId || '', 120);
  if (configured) return configured;
  const accountId = clean(config.confirmationProvider?.account || '', 120);
  const ownerOpenId = clean(config.confirmationProvider?.ownerOpenId || config.confirmationProvider?.target || '', 220);
  const configPath = process.env.OPENCLAW_CONFIG_PATH || path.join(os.homedir(), '.openclaw', 'openclaw.json');
  const openclaw = await readJson(configPath, {});
  const binding = Array.isArray(openclaw.bindings) ? openclaw.bindings.find((item) => (
    item?.match?.channel === 'feishu'
      && (!accountId || item?.match?.accountId === accountId)
      && item?.match?.peer?.kind === 'direct'
      && (!ownerOpenId || item?.match?.peer?.id === ownerOpenId)
      && clean(item?.agentId || '', 120)
  )) : null;
  const derived = clean(binding?.agentId || '', 120);
  if (!derived) throw new Error('Notify approval agent is not configured and could not be derived from the owner Feishu direct-message binding. Set confirmationProvider.approvalAgentId.');
  return derived;
}

function openClawApprovalPolicy(snapshot = {}, agentId = '', handlerPath = '') {
  const entries = Array.isArray(snapshot?.file?.agents?.[agentId]?.allowlist)
    ? snapshot.file.agents[agentId].allowlist
    : Array.isArray(snapshot?.agents?.[agentId]?.allowlist)
      ? snapshot.agents[agentId].allowlist
      : [];
  return {
    allowlistMatched: entries.some((entry) => String(entry?.pattern || entry) === handlerPath),
    allowlistEntries: entries.length,
  };
}

/**
 * Reports every initialization requirement as a discrete, checkable item so a new
 * owner can see exactly what is still missing instead of discovering it at
 * delivery time. Ordered from "cannot work at all" to "optional".
 */
async function runNotifyDaemonDoctor(paths, flags = {}) {
  const daemonConfig = await readJson(paths.config, {});
  const handlerState = await ensureNotifyHandlerState(paths.handler);
  const handlerConfig = handlerState.config;
  const directory = handlerState.directory;
  const delivery = handlerConfig.deliveryProvider || {};
  const confirmation = handlerConfig.confirmationProvider || {};
  const agent = handlerConfig.agentProvider || {};
  const groups = Array.isArray(directory.groups) ? directory.groups : [];
  const people = Array.isArray(directory.people) ? directory.people : [];
  const checks = [];
  const add = (id, required, ok, detail, fix) => checks.push({
    id, required, status: ok ? 'ok' : (required ? 'missing' : 'optional'), detail, ...(ok ? {} : { fix }),
  });

  add('relay.login', true, Boolean(daemonConfig.relayUrl && daemonConfig.relayId && daemonConfig.token),
    daemonConfig.relayUrl ? `Relay ${daemonConfig.relayUrl} as ${daemonConfig.relayHandle || daemonConfig.relayId}` : 'No Relay login stored.',
    'magclaw-notify-owner login --relay-url <url> --bot <bot-id>');
  const tokenExpiresAt = Date.parse(daemonConfig.tokenExpiresAt || '');
  add('relay.token_valid', true, Number.isFinite(tokenExpiresAt) && tokenExpiresAt > Date.now(),
    Number.isFinite(tokenExpiresAt) ? `Daemon token expires ${daemonConfig.tokenExpiresAt}` : 'No Daemon token expiry recorded.',
    'magclaw-notify-owner login again to refresh the Owner token');
  add('feishu.delivery_provider', true, Boolean(delivery.enabled && delivery.account),
    delivery.account ? `${delivery.kind} using account/profile ${delivery.account}` : 'No Feishu delivery provider configured.',
    'magclaw-notify-owner configure --delivery-provider feishu-rest --delivery-account <account> --feishu-app-id <app-id> --feishu-app-secret-env FEISHU_APP_SECRET --delivery-enabled true');
  add('feishu.owner_dm', true, Boolean(confirmation.enabled && confirmation.account && (confirmation.ownerOpenId || confirmation.target)),
    confirmation.ownerOpenId || confirmation.target ? 'Owner approval DM target configured.' : 'No owner approval DM target configured.',
    'magclaw-notify-owner configure --confirmation-account <profile> --owner-open-id <ou_...> --confirmation-enabled true');
  const eventConsumer = confirmation.eventConsumer || 'openclaw';
  add('feishu.event_consumer', true, ['openclaw', 'standalone'].includes(eventConsumer),
    eventConsumer === 'standalone'
      ? 'This Daemon consumes card.action.trigger itself. No Agent runtime is required.'
      : 'An Agent runtime owns the Feishu event connection and must forward approval callbacks.',
    'magclaw-notify-owner configure --event-consumer standalone');
  if (eventConsumer === 'openclaw') {
    checks.push({
      id: 'feishu.bot_membership_event',
      required: false,
      status: 'verify',
      detail: 'Feishu permission and long-connection subscription are enabled. OpenClaw 2026.7.x receives bot removal events but does not expose channel lifecycle events to plugins; Notify reconciles configured chats by REST at startup and every 10 minutes, and fails closed on delivery.',
      fix: 'After upgrading OpenClaw, verify whether a channel lifecycle hook is available and replace polling without opening a second Feishu connection.',
    });
    const pluginHost = await readJson(path.join(paths.root, 'run', 'plugin-host.json'), {});
    const pluginForwarderRunning = pluginHost.mode === 'plugin-hosted'
      && await processIsRunning(Number(pluginHost.pid));
    add('agent.approval_forwarder', true, pluginForwarderRunning,
      pluginForwarderRunning
        ? 'The OpenClaw Notify plugin owns approval callbacks for this Bot Binding.'
        : `Enable the complete OpenClaw plugin host: ${notifyOpenClawApprovalPluginPath()}`,
      'Install and start magclaw-notify in the OpenClaw Gateway; do not open a second Feishu event connection.');
    if (!pluginForwarderRunning) checks[checks.length - 1].status = 'verify';
  }
  add('directory.groups', true, groups.some((group) => group && group.chatId && group.enabled !== false),
    `${groups.length} group(s) configured, ${groups.filter((g) => g?.chatId).length} with a Chat ID.`,
    'magclaw-notify-owner add-group --name <name> --chat-id <chat id> --aliases <alias>');
  add('directory.people', false, people.some((person) => person && person.openId && person.enabled !== false),
    `${people.length} person(s) configured. Only needed to @-mention people.`,
    'magclaw-notify-owner add-person --name <name> --open-id <ou_...>');
  add('agent.group_context', false, Boolean(agent.groupContextSync === true && agent.agentId),
    agent.groupContextSync === true && agent.agentId
      ? `Delivered summaries are mirrored into ${agent.kind} agent ${agent.agentId}'s group session.`
      : 'Group context sync is off; delivery is unaffected. Content is always rendered deterministically from the submitted summary.',
    'magclaw-notify-owner configure --agent-provider openclaw --agent-id <agent> --group-context-sync true');
  add('sender.setup_token', false, Boolean(daemonConfig.inviteToken),
    daemonConfig.inviteToken ? 'A Setup Token exists for senders.' : 'No Setup Token issued yet.',
    'magclaw-notify-owner setup-token rotate');

  const blocking = checks.filter((check) => check.status === 'missing');
  const verify = checks.filter((check) => check.status === 'verify');
  return {
    bot: paths.bindingId || paths.instance,
    ready: blocking.length === 0,
    eventConsumer,
    requiresAgentRuntime: eventConsumer === 'openclaw',
    blocking: blocking.map((check) => check.id),
    needsManualVerification: verify.map((check) => check.id),
    checks: flags.all === true ? checks : checks.filter((check) => check.status !== 'ok'),
    summary: blocking.length === 0
      ? 'Every required initialization step is complete.'
      : `${blocking.length} required step(s) still missing.`,
  };
}

async function manageOpenClawApproval(paths, positional, flags = {}) {
  const action = positional[1] || 'status';
  const config = (await ensureNotifyHandlerState(paths.handler)).config;
  const agentId = await resolveOpenClawApprovalAgent(config);
  const openclawCommand = clean(config.agentProvider?.command || process.env.OPENCLAW_PATH || 'openclaw', 500);
  const pluginPath = notifyOpenClawApprovalPluginPath({ pluginPath: flags.pluginPath });
  if (action === 'status') {
    // Approvals no longer run through an Agent-invocable shell command, so the
    // only thing to report is whether the deterministic plugin is loaded and
    // that no stale exec allowlist entry survives.
    let pluginLoaded = false;
    let pluginError = '';
    try {
      const result = await runOpenClawCommand(openclawCommand, ['plugins', 'list', '--json']);
      const snapshot = JSON.parse(result.stdout || '{}');
      pluginLoaded = JSON.stringify(snapshot).includes('magclaw-notify');
    } catch (error) {
      pluginError = clean(error.message, 300);
    }
    let staleAllowlistEntries = [];
    try {
      const result = await runOpenClawCommand(openclawCommand, ['approvals', 'get', '--json']);
      const snapshot = JSON.parse(result.stdout || '{}');
      const agents = snapshot?.file?.agents || snapshot?.agents || {};
      for (const [id, entry] of Object.entries(agents)) {
        for (const item of Array.isArray(entry?.allowlist) ? entry.allowlist : []) {
          const pattern = String(item?.pattern || item || '');
          if (pattern.includes('magclaw-notify')) staleAllowlistEntries.push({ agentId: id, pattern });
        }
      }
    } catch { staleAllowlistEntries = []; }
    return {
      mode: 'plugin',
      approvalAgentId: agentId,
      pluginPath,
      pluginLoaded,
      ...(pluginError ? { pluginError } : {}),
      staleAllowlistEntries,
      agentShellApprovalRequired: false,
    };
  }
  if (action === 'enable' || action === 'disable') {
    throw new Error(`Notify approvals are handled by the OpenClaw plugin at ${pluginPath}. Register it under plugins.load.paths and plugins.entries instead of managing an exec allowlist.`);
  }
  throw new Error(`Unknown OpenClaw approval command: ${action}`);
}

async function executeNotifyDaemonCommand(positional = [], flags = {}) {
  const command = positional[0] || 'status';
  const env = notifyEnvironment(flags);
  if (command === 'install') return installNotifyOpenClawPlugin({ target: flags.target || flags.pluginPath, packageRoot: PACKAGE_ROOT });
  if (command === 'bot') {
    const action = positional[1] || 'list';
    if (action === 'list') return listNotifyBindings(env);
    if (action === 'add') return addNotifyBinding({ id: flags.id || flags.bot, name: flags.name, accountId: flags.accountId, enabled: flags.enabled !== 'false' }, env);
    if (action === 'enable' || action === 'disable') return setNotifyBindingEnabled(flags.bot || flags.id || positional[2], action === 'enable', env);
    throw new Error(`Unknown Notify Bot command: ${action}`);
  }
  if (command === 'update') {
    const action = positional[1] || 'status';
    const packageJson = await readJson(path.join(PACKAGE_ROOT, 'package.json'), { version: flags.currentVersion || '0.0.0' });
    const currentVersion = clean(flags.currentVersion || packageJson.version || '0.0.0', 40);
    if (action === 'status') return { currentVersion, state: await readNotifyOwnerUpdateState(env) };
    if (action === 'check') return checkNotifyOwnerUpdate(currentVersion, { timeoutMs: flags.timeoutMs });
    if (action === 'apply') return applyNotifyOwnerUpdate(flags.targetVersion || positional[2], { currentVersion, npmPath: flags.npmPath, openclawPath: flags.openclawPath, restart: flags.restart !== 'false' }, env);
    if (action === 'rollback') return rollbackNotifyOwnerUpdate({ pluginPath: flags.pluginPath, openclawPath: flags.openclawPath, restart: flags.restart !== 'false' }, env);
    if (action === 'background-check') return runNotifyOwnerBackgroundUpdate(currentVersion, { force: flags.force === true, npmPath: flags.npmPath, openclawPath: flags.openclawPath }, env);
    throw new Error(`Unknown Notify Owner update command: ${action}`);
  }
  const paths = flags._paths || await ownerPathsFromFlags(flags);
  const instance = paths.instance;
  flags = { ...flags, _paths: paths };
  if (command === 'access') {
    const action = positional[1] || 'list';
    if (action === 'list') return listNotifyAccess(paths, flags);
    if (action === 'revoke') return revokeNotifyAccess(paths, flags);
    if (action === 'kick') return kickNotifyAccess(paths, flags);
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
    if (action === 'disable') return disableNotifySetupToken(paths, flags);
    throw new Error(`Unknown Notify setup-token command: ${action || '[missing]'}`);
  }
  if (command === 'state') {
    const action = positional[1] || 'dump';
    if (action === 'dump') return dumpNotifyState(paths, flags);
    throw new Error(`Unknown Notify state command: ${action}`);
  }
  if (command === 'login' || command === 'setup') return loginNotifyDaemon(flags);
  if (command === 'run') return runNotifyDaemon(flags);
  if (command === 'start') {
    // TODO(NTFY-DMN-26808-1): If real demand emerges for a webhook-only Bot,
    // extract a supported standalone host adapter that reuses the Relay,
    // channel adapter, SQLite state machine, and audit pipeline without
    // OpenClaw or Agent conversation hooks. Keep this legacy daemon entrypoint
    // rollback-only until that contract exists, and do not restore a control
    // socket.
    return startNotifyDaemonBackground(flags);
  }
  if (command === 'restart') {
    await stopNotifyDaemon(flags);
    return startNotifyDaemonBackground(flags);
  }
  if (command === 'stop') return stopNotifyDaemon(flags);
  if (command === 'status') return notifyDaemonStatus(flags);
  if (command === 'autostart') return manageNotifyDaemonAutostart(paths, positional, flags);
  if (command === 'plugin') return manageOpenClawNotifyPlugin(paths, positional, flags);
  if (command === 'openclaw-approval') return manageOpenClawApproval(paths, positional, flags);
  if (command === 'doctor') return runNotifyDaemonDoctor(paths, flags);
  if (command === 'audit') {
    const action = positional[1] || 'status';
    if (action === 'status') return ownerAudit(paths).status();
    if (action === 'tail') return { records: await ownerAudit(paths).readTail(flags.limit || 100) };
    throw new Error(`Unknown Notify audit command: ${action}`);
  }
  if (command === 'configure') {
    if (flags.eventConsumer && !['openclaw', 'standalone'].includes(String(flags.eventConsumer))) {
      throw new Error('Notify event consumer must be openclaw or standalone.');
    }
    const config = await configureNotifyHandler(paths.handler, {
      ...(flags.enabled !== undefined ? { enabled: flags.enabled !== 'false' } : {}),
      agentProvider: {
        ...(flags.agentProvider ? { kind: flags.agentProvider } : {}),
        ...(flags.agentCommand ? { command: flags.agentCommand } : {}),
        ...(flags.agentId ? { agentId: flags.agentId } : {}),
        ...(flags.groupContextSync !== undefined ? { groupContextSync: flags.groupContextSync !== 'false' } : {}),
      },
      deliveryProvider: {
        ...(flags.deliveryProvider ? { kind: flags.deliveryProvider } : {}),
        ...(flags.deliveryCommand ? { command: flags.deliveryCommand } : {}),
        ...(flags.deliveryAccount !== undefined ? { account: flags.deliveryAccount } : {}),
        ...(flags.feishuAppId !== undefined ? { appId: flags.feishuAppId } : {}),
        ...(flags.feishuAppIdEnv !== undefined ? { appIdEnv: flags.feishuAppIdEnv } : {}),
        ...(flags.feishuAppSecretEnv !== undefined ? { appSecretEnv: flags.feishuAppSecretEnv } : {}),
        ...(flags.feishuAppSecretFile !== undefined ? { appSecretFile: flags.feishuAppSecretFile } : {}),
        ...(flags.feishuDomain !== undefined ? { domain: flags.feishuDomain } : {}),
        ...(flags.deliveryEnabled !== undefined ? { enabled: flags.deliveryEnabled !== 'false' } : {}),
        ...(flags.dryRun !== undefined ? { dryRun: flags.dryRun !== 'false' } : {}),
      },
      confirmationProvider: {
        ...(flags.confirmationProvider ? { kind: flags.confirmationProvider } : {}),
        ...(flags.confirmationCommand ? { command: flags.confirmationCommand } : {}),
        ...(flags.confirmationAccount !== undefined ? { account: flags.confirmationAccount } : {}),
        ...(flags.feishuAppId !== undefined ? { appId: flags.feishuAppId } : {}),
        ...(flags.feishuAppIdEnv !== undefined ? { appIdEnv: flags.feishuAppIdEnv } : {}),
        ...(flags.feishuAppSecretEnv !== undefined ? { appSecretEnv: flags.feishuAppSecretEnv } : {}),
        ...(flags.feishuAppSecretFile !== undefined ? { appSecretFile: flags.feishuAppSecretFile } : {}),
        ...(flags.feishuDomain !== undefined ? { domain: flags.feishuDomain } : {}),
        ...(flags.confirmationTarget !== undefined ? { target: flags.confirmationTarget } : {}),
        ...(flags.ownerOpenId !== undefined ? { ownerOpenId: flags.ownerOpenId } : {}),
        ...(flags.approvalAgentId !== undefined ? { approvalAgentId: flags.approvalAgentId } : {}),
        ...(flags.eventConsumer !== undefined ? { eventConsumer: flags.eventConsumer } : {}),
        ...(flags.confirmationEnabled !== undefined ? { enabled: flags.confirmationEnabled !== 'false' } : {}),
      },
    });
    const installedHandlerSkills = config.confirmationProvider.eventConsumer === 'openclaw'
      ? await installNotifyHandlerSkill({ targets: ['openclaw'] })
      : [];
    return { ...config, installedHandlerSkills, approvalPluginPath: notifyOpenClawApprovalPluginPath({ pluginPath: flags.pluginPath }) };
  }
  if (command === 'add-group') return addNotifyGroup(paths.handler, {
    id: flags.id, name: flags.name, chatId: flags.chatId, aliases: commaList(flags.aliases || flags.alias),
    routeLabel: flags.routeLabel, ownerName: flags.ownerName, memberCount: flags.memberCount,
  });
  if (command === 'add-person') return addNotifyPerson(paths.handler, { name: flags.name, openId: flags.openId, aliases: commaList(flags.aliases || flags.alias), groupChatIds: commaList(flags.groupChatIds || flags.groupChatId) });
  if (command === 'directory') {
    const action = positional[1] || 'list';
    if (action === 'list' || action === 'export') return listNotifyDirectory(paths.handler);
    if (action === 'apply') return applyNotifyDirectory(paths.handler, { file: flags.file });
    if (action === 'remove') return removeNotifyDirectoryEntry(paths.handler, { kind: flags.kind, id: flags.id, name: flags.name });
    if (action === 'alias') return updateNotifyDirectoryAlias(paths.handler, {
      action: positional[2] || flags.action,
      kind: flags.kind,
      id: flags.id,
      name: flags.name,
      alias: flags.alias,
    });
    throw new Error(`Unknown Notify directory command: ${action}`);
  }
  if (command === 'sync-directory') return syncNotifyDirectory(paths.handler);
  if (command === 'install-handler-skill') return installNotifyHandlerSkill({
    targets: commaList(flags.targets || flags.target || 'openclaw'),
  });
  if (command === 'confirm') {
    const decisions = [['approve', flags.approve], ['once', flags.once], ['always', flags.always], ['reject', flags.reject]].filter(([, enabled]) => enabled === true);
    if (decisions.length !== 1) throw new Error('Choose exactly one of --approve, --once, --always, or --reject.');
    return confirmNotifyMapping(paths.handler, flags.id, decisions[0][0], {
      operatorId: flags.operatorOpenId || '',
      personMappings: commaList(flags.personMap || flags.personMaps || ''),
    });
  }
  throw new Error(`Unknown Notify Owner command: ${command}`);
}

export async function runNotifyOwnerCommand(positional = [], flags = {}) {
  const command = positional[0] || 'status';
  const subcommand = positional[1] || '';
  // Installing the packaged plugin does not read or mutate an Owner profile,
  // so it must also work before ~/.magclaw/notify exists.
  if (command === 'install') return executeNotifyDaemonCommand(positional, flags);
  flags = await flagsWithConfiguredNotifyHome(flags);
  if (command !== 'update' && process.env.MAGCLAW_NOTIFY_OWNER_UPDATE_CHILD !== '1') {
    const packageJson = await readJson(path.join(PACKAGE_ROOT, 'package.json'), { version: '0.0.0' });
    scheduleNotifyOwnerBackgroundUpdate(String(packageJson.version || '0.0.0'), {}, notifyEnvironment(flags));
  }
  const paths = await ownerPathsFromFlags(flags, { allowUnconfigured: command === 'bot' || command === 'update' || command === 'plugin' });
  flags = { ...flags, _paths: paths };
  const audit = ownerAudit(paths);
  const event = `owner.command.${clean(command, 60)}${subcommand ? `.${clean(subcommand, 60)}` : ''}`;
  const metadata = {
    bindingId: paths.bindingId || '',
    auditDir: paths.auditDir,
    ...(flags.name ? { targetName: flags.name } : {}),
    ...(flags.group ? { targetGroup: flags.group } : {}),
    ...(flags.agentProvider ? { agentProvider: flags.agentProvider } : {}),
    ...(flags.deliveryProvider ? { deliveryProvider: flags.deliveryProvider } : {}),
    ...(flags.eventConsumer ? { eventConsumer: flags.eventConsumer } : {}),
  };
  await audit.append({ event, outcome: 'started', metadata });
  try {
    const result = await executeNotifyDaemonCommand(positional, flags);
    await audit.append({
      event,
      outcome: 'succeeded',
      requestId: result?.request?.id || result?.result?.requestId || '',
      confirmationId: result?.confirmation?.id || flags.id || '',
      relayId: result?.relayId || result?.request?.relayId || '',
      metadata: {
        ...metadata,
        resultStatus: result?.status || result?.result?.status || '',
        changedCount: result?.revoked ?? result?.count ?? '',
        cloudLoginsRevoked: result?.cloudLoginsRevoked,
        localGroupGrantsRevoked: result?.localGroupGrantsRevoked,
        enabled: result?.enabled,
      },
    });
    return result;
  } catch (error) {
    await audit.append({ event, outcome: 'failed', severity: 'error', confirmationId: flags.id || '', metadata: { ...metadata, ...auditError(error) } });
    throw error;
  }
}

// One compatibility line for callers that imported the 0.6.x symbol. New
// integrations must use runNotifyOwnerCommand and magclaw-notify-owner.
export const runNotifyDaemonCommand = runNotifyOwnerCommand;
