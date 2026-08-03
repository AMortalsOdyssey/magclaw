import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  createNotifyAuditLog,
  LOCAL_NOTIFY_AUDIT_MAX_FILE_BYTES,
  LOCAL_NOTIFY_AUDIT_MAX_FILES,
} from '../../notify/src/audit.js';
import { resolveNotifyExecutable } from './executable.js';
import { notifyInstanceFromFlags } from './instance.js';
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
  configureNotifyHandler,
  confirmNotifyMapping,
  expireNotifyConfirmations,
  handleNotifyCardAction,
  inspectNotifyCardAction,
  installNotifyHandlerSkill,
  listNotifyTargetGrants,
  notifyHandlerStatus,
  notifyOpenClawApprovalHandlerPath,
  prepareNotifyDelivery,
  processAuthorizedNotifyDelivery,
  revokeNotifyTargetGrant,
  sendNotifyConfirmationPrompt,
  syncNotifyDirectory,
  updateNotifyApprovalCard,
} from './handler.js';

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_PATH = path.join(PACKAGE_ROOT, 'bin', 'magclaw-notify-daemon.js');
const DEFAULT_RECONNECT_MIN_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const ownerAuditLogs = new Map();

function clean(value = '', max = 2000) {
  return String(value || '').replace(/\u0000/g, '').trim().slice(0, max);
}

function notifyHome(env = process.env) {
  return path.resolve(env.MAGCLAW_NOTIFY_HOME || path.join(os.homedir(), '.magclaw', 'notify'));
}

function notifyEnvironment(flags = {}) {
  if (!flags.notifyHome) return process.env;
  return { ...process.env, MAGCLAW_NOTIFY_HOME: path.resolve(clean(flags.notifyHome, 1000)) };
}

function notifyControlSocketPath(root) {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\magclaw-notify-${crypto.createHash('sha256').update(root).digest('hex').slice(0, 20)}`;
  }
  const local = path.join(root, 'run', 'control.sock');
  if (Buffer.byteLength(local) <= 96) return local;
  return path.join(os.tmpdir(), `magclaw-notify-${process.getuid?.() ?? 'user'}`, `${crypto.createHash('sha256').update(root).digest('hex').slice(0, 24)}.sock`);
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
    controlSocket: notifyControlSocketPath(root),
    stdout: path.join(root, 'logs', 'daemon.log'),
    stderr: path.join(root, 'logs', 'daemon.error.log'),
    auditDir: path.join(root, 'audit'),
    handler: { dir: root, config: path.join(root, 'config.json'), profile: instance },
  };
}

export async function startNotifyDaemonControlServer(paths, signal, dependencies = {}) {
  const processApproval = dependencies.processApproval || processNotifyApprovalEvent;
  if (process.platform !== 'win32') {
    await mkdir(path.dirname(paths.controlSocket), { recursive: true, mode: 0o700 });
    await chmod(path.dirname(paths.controlSocket), 0o700).catch(() => {});
    await rm(paths.controlSocket, { force: true });
  }
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.setEncoding('utf8');
    let body = '';
    socket.on('data', (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) socket.destroy(new Error('Notify daemon control request is too large.'));
    });
    socket.on('end', async () => {
      try {
        const request = JSON.parse(body || '{}');
        if (request.action !== 'confirm') throw new Error('Unsupported Notify daemon control action.');
        const confirmationId = clean(request.confirmationId || '', 120);
        const decision = clean(request.decision || '', 20);
        const operatorOpenId = clean(request.operatorOpenId || '', 220);
        if (!/^ncf_[a-f0-9]+$/.test(confirmationId)) throw new Error('Invalid Notify confirmation id.');
        if (!['approve', 'once', 'always', 'reject'].includes(decision)) throw new Error('Invalid Notify confirmation decision.');
        if (!/^ou_[A-Za-z0-9]+$/.test(operatorOpenId)) throw new Error('A valid Notify owner open id is required.');
        const result = await processApproval(paths.handler, {
          action_value: { source: 'magclaw_notify', instance: paths.instance, confirmationId, decision },
          operator_id: operatorOpenId,
        });
        socket.end(`${JSON.stringify({ ok: true, result })}\n`);
      } catch (error) {
        socket.end(`${JSON.stringify({ ok: false, error: clean(error.message, 1000) })}\n`);
      }
    });
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(paths.controlSocket);
  });
  if (process.platform !== 'win32') await chmod(paths.controlSocket, 0o600);
  const stop = () => {
    server.close();
    if (process.platform !== 'win32') rm(paths.controlSocket, { force: true }).catch(() => {});
  };
  signal?.addEventListener('abort', stop, { once: true });
  return { running: true, address: paths.controlSocket, server, stop };
}

export async function requestNotifyDaemonControl(paths, request, options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 30_000));
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(paths.controlSocket);
    let response = '';
    const fail = (error) => {
      socket.destroy();
      reject(error);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => fail(new Error('Notify Daemon control request timed out.')));
    socket.once('error', (error) => fail(new Error(`Notify Daemon is not running or its control socket is unavailable: ${error.message}`)));
    socket.on('data', (chunk) => { response += chunk; });
    socket.once('connect', () => socket.end(`${JSON.stringify(request)}\n`));
    socket.once('close', () => {
      if (!response.trim()) return;
      try {
        const parsed = JSON.parse(response.trim());
        if (!parsed.ok) reject(new Error(parsed.error || 'Notify Daemon rejected the control request.'));
        else resolve(parsed.result);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function ownerAudit(paths) {
  if (!ownerAuditLogs.has(paths.auditDir)) {
    ownerAuditLogs.set(paths.auditDir, createNotifyAuditLog({
      dir: paths.auditDir,
      scope: 'owner',
      base: { instance: paths.instance },
      maxFileBytes: LOCAL_NOTIFY_AUDIT_MAX_FILE_BYTES,
      maxFiles: LOCAL_NOTIFY_AUDIT_MAX_FILES,
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
  const instance = notifyInstanceFromFlags(flags);
  const paths = notifyDaemonPaths(notifyEnvironment(flags), instance);
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
    headers: flags.bootstrapToken ? { 'x-magclaw-notify-bootstrap': String(flags.bootstrapToken) } : {},
    body: {
      relayId: requestedRelayId,
      relayName: requestedName,
      instance,
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

async function connectOnce(paths, config, signal) {
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
  const handlerConfig = await readJson(path.join(paths.handler.dir, 'notify', 'config.json'), {});
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
  const instance = notifyInstanceFromFlags(flags);
  const paths = notifyDaemonPaths(notifyEnvironment(flags), instance);
  const config = await readJson(paths.config, {});
  if (!config.relayUrl || !config.relayId || !config.token) throw new Error('Notify Daemon is not logged in. Run magclaw-notify daemon login first.');
  await ensureNotifyRuntimeLogs(paths);
  const controller = new AbortController();
  const audit = ownerAudit(paths);
  await audit.append({ event: 'owner.daemon.started', outcome: 'succeeded', relayId: config.relayId, metadata: { pid: process.pid, configPath: paths.config, auditDir: paths.auditDir, eventConsumer: (await readJson(path.join(paths.handler.dir, 'notify', 'config.json'), {})).confirmationProvider?.eventConsumer || 'openclaw' } });
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  await mkdir(path.dirname(paths.pid), { recursive: true });
  await writeFile(paths.pid, `${process.pid}\n`, { mode: 0o600 });
  const controlServer = await startNotifyDaemonControlServer(paths, controller.signal);
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
    controlServer.stop();
    approvalListener.stop();
    const recordedPid = Number(String(await readFile(paths.pid, 'utf8').catch(() => '')).trim());
    if (recordedPid === process.pid) await rm(paths.pid, { force: true });
    await audit.append({ event: 'owner.daemon.stopped', outcome: 'succeeded', relayId: config.relayId, metadata: { pid: process.pid } });
  }
  return { stopped: true, instance };
}

async function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function notifyDaemonStatus(flags = {}) {
  const instance = notifyInstanceFromFlags(flags);
  const paths = notifyDaemonPaths(notifyEnvironment(flags), instance);
  const config = await readJson(paths.config, {});
  const pid = Number(String(await readFile(paths.pid, 'utf8').catch(() => '')).trim());
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
    instance,
    configured: Boolean(config.relayUrl && config.relayId && config.token),
    running: await processIsRunning(pid),
    pid: await processIsRunning(pid) ? pid : null,
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
  const instance = notifyInstanceFromFlags(flags);
  const paths = notifyDaemonPaths(notifyEnvironment(flags), instance);
  const status = await notifyDaemonStatus({ ...flags, instance });
  if (status.running) return status;
  await mkdir(path.dirname(paths.pid), { recursive: true });
  await ensureNotifyRuntimeLogs(paths);
  if (flags.noAutostart !== true) {
    const service = notifyDaemonServiceSpec({ instance, notifyHome: paths.home, binPath: BIN_PATH, logPath: paths.stdout, errorLogPath: paths.stderr });
    await enableNotifyDaemonAutostart(service);
    await sleep(500);
    return notifyDaemonStatus({ ...flags, instance });
  }
  const stdout = await open(paths.stdout, 'a', 0o600);
  const stderr = await open(paths.stderr, 'a', 0o600);
  const child = spawn(process.execPath, [BIN_PATH, 'daemon', 'run', '--instance', instance, '--notify-home', paths.home], {
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
  return notifyDaemonStatus({ ...flags, instance });
}

export async function stopNotifyDaemon(flags = {}) {
  const instance = notifyInstanceFromFlags(flags);
  const paths = notifyDaemonPaths(notifyEnvironment(flags), instance);
  const service = notifyDaemonServiceSpec({ instance, notifyHome: paths.home, binPath: BIN_PATH, logPath: paths.stdout, errorLogPath: paths.stderr });
  await stopNotifyDaemonService(service);
  const pid = Number(String(await readFile(paths.pid, 'utf8').catch(() => '')).trim());
  if (await processIsRunning(pid)) process.kill(pid, 'SIGTERM');
  await rm(paths.pid, { force: true });
  return { stopped: true, instance, pid: Number.isInteger(pid) ? pid : null, autostartPreserved: true };
}

async function manageNotifyDaemonAutostart(paths, positional, flags = {}) {
  const action = positional[1] || 'status';
  const instance = paths.instance;
  const spec = notifyDaemonServiceSpec({ instance, notifyHome: paths.home, binPath: BIN_PATH, logPath: paths.stdout, errorLogPath: paths.stderr });
  if (action === 'status') return { instance, ...(await notifyDaemonAutostartStatus(spec)) };
  if (action === 'enable') {
    await ensureNotifyRuntimeLogs(paths);
    return { instance, ...(await enableNotifyDaemonAutostart(spec)) };
  }
  if (action === 'disable') return { instance, ...(await disableNotifyDaemonAutostart(spec)) };
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
      else reject(new Error(`OpenClaw approvals command failed: ${clean(stderr || stdout, 1000)}`));
    });
  });
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

async function manageOpenClawApproval(paths, positional) {
  const action = positional[1] || 'status';
  const config = await readJson(path.join(paths.handler.dir, 'notify', 'config.json'), {});
  const agentId = await resolveOpenClawApprovalAgent(config);
  const openclawCommand = clean(config.agentProvider?.command || process.env.OPENCLAW_PATH || 'openclaw', 500);
  const handlerPath = notifyOpenClawApprovalHandlerPath(paths.instance);
  if (action === 'enable') {
    if (!await readFile(handlerPath, 'utf8').then(Boolean).catch(() => false)) {
      throw new Error('Install the OpenClaw Notify handler Skill before enabling its approval rule.');
    }
    await runOpenClawCommand(openclawCommand, ['approvals', 'allowlist', 'add', '--agent', agentId, '--json', handlerPath]);
    return { enabled: true, instance: paths.instance, agentId, handlerPath };
  }
  if (action === 'disable') {
    await runOpenClawCommand(openclawCommand, ['approvals', 'allowlist', 'remove', '--agent', agentId, '--json', handlerPath]);
    return { enabled: false, instance: paths.instance, agentId, handlerPath };
  }
  if (action === 'status') {
    const result = await runOpenClawCommand(openclawCommand, ['approvals', 'get', '--json']);
    const snapshot = JSON.parse(result.stdout || '{}');
    const policy = openClawApprovalPolicy(snapshot, agentId, handlerPath);
    let execPolicy = {};
    try {
      const policyResult = await runOpenClawCommand(openclawCommand, ['exec-policy', 'show', '--json']);
      const policySnapshot = JSON.parse(policyResult.stdout || '{}');
      const scope = policySnapshot?.effectivePolicy?.scopes?.find((item) => item?.agentId === agentId) || {};
      execPolicy = {
        execSecurity: scope?.security?.effective || scope?.security?.requested || 'unknown',
        execAsk: scope?.ask?.effective || scope?.ask?.requested || 'unknown',
      };
    } catch (error) {
      execPolicy = { execSecurity: 'unknown', execAsk: 'unknown', policyError: clean(error.message, 300) };
    }
    return { enabled: policy.allowlistMatched, instance: paths.instance, approvalAgentId: agentId, agentId, handlerPath, ...policy, ...execPolicy };
  }
  throw new Error(`Unknown OpenClaw approval command: ${action}`);
}

async function executeNotifyDaemonCommand(positional = [], flags = {}) {
  const command = positional[0] || 'status';
  const instance = notifyInstanceFromFlags(flags);
  const paths = notifyDaemonPaths(notifyEnvironment(flags), instance);
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
    if (action === 'disable') return disableNotifySetupToken(paths, flags);
    throw new Error(`Unknown Notify setup-token command: ${action || '[missing]'}`);
  }
  if (command === 'login' || command === 'setup') return loginNotifyDaemon(flags);
  if (command === 'run') return runNotifyDaemon(flags);
  if (command === 'start') return startNotifyDaemonBackground(flags);
  if (command === 'restart') {
    await stopNotifyDaemon(flags);
    return startNotifyDaemonBackground(flags);
  }
  if (command === 'stop') return stopNotifyDaemon(flags);
  if (command === 'status') return notifyDaemonStatus(flags);
  if (command === 'autostart') return manageNotifyDaemonAutostart(paths, positional, flags);
  if (command === 'openclaw-approval') return manageOpenClawApproval(paths, positional);
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
        ...(flags.deliveryEnabled !== undefined ? { enabled: flags.deliveryEnabled !== 'false' } : {}),
        ...(flags.dryRun !== undefined ? { dryRun: flags.dryRun !== 'false' } : {}),
      },
      confirmationProvider: {
        ...(flags.confirmationProvider ? { kind: flags.confirmationProvider } : {}),
        ...(flags.confirmationCommand ? { command: flags.confirmationCommand } : {}),
        ...(flags.confirmationAccount !== undefined ? { account: flags.confirmationAccount } : {}),
        ...(flags.confirmationTarget !== undefined ? { target: flags.confirmationTarget } : {}),
        ...(flags.ownerOpenId !== undefined ? { ownerOpenId: flags.ownerOpenId } : {}),
        ...(flags.approvalAgentId !== undefined ? { approvalAgentId: flags.approvalAgentId } : {}),
        ...(flags.eventConsumer !== undefined ? { eventConsumer: flags.eventConsumer } : {}),
        ...(flags.confirmationEnabled !== undefined ? { enabled: flags.confirmationEnabled !== 'false' } : {}),
      },
    });
    const installedHandlerSkills = config.confirmationProvider.eventConsumer === 'openclaw'
      ? await installNotifyHandlerSkill({
          targets: ['openclaw'],
          approvalHandler: {
            instance,
            notifyHome: paths.home,
            nodePath: process.execPath,
            binPath: BIN_PATH,
          },
        })
      : [];
    return { ...config, installedHandlerSkills };
  }
  if (command === 'add-group') return addNotifyGroup(paths.handler, { name: flags.name, chatId: flags.chatId, aliases: commaList(flags.aliases || flags.alias) });
  if (command === 'add-person') return addNotifyPerson(paths.handler, { name: flags.name, openId: flags.openId, aliases: commaList(flags.aliases || flags.alias), groupChatIds: commaList(flags.groupChatIds || flags.groupChatId) });
  if (command === 'sync-directory') return syncNotifyDirectory(paths.handler);
  if (command === 'install-handler-skill') return installNotifyHandlerSkill({
    targets: commaList(flags.targets || flags.target || 'openclaw'),
    approvalHandler: {
      instance,
      notifyHome: paths.home,
      nodePath: process.execPath,
      binPath: BIN_PATH,
    },
  });
  if (command === 'confirm') {
    const decisions = [['approve', flags.approve], ['once', flags.once], ['always', flags.always], ['reject', flags.reject]].filter(([, enabled]) => enabled === true);
    if (decisions.length !== 1) throw new Error('Choose exactly one of --approve, --once, --always, or --reject.');
    if (flags.personMap || flags.personMaps) throw new Error('Person mappings are owner-local operations and are not accepted by the daemon control socket.');
    return requestNotifyDaemonControl(paths, {
      action: 'confirm',
      confirmationId: flags.id,
      decision: decisions[0][0],
      operatorOpenId: flags.operatorOpenId || '',
    });
  }
  throw new Error(`Unknown Notify Daemon command: ${command}`);
}

export async function runNotifyDaemonCommand(positional = [], flags = {}) {
  const command = positional[0] || 'status';
  const subcommand = positional[1] || '';
  const instance = notifyInstanceFromFlags(flags);
  const paths = notifyDaemonPaths(notifyEnvironment(flags), instance);
  const audit = ownerAudit(paths);
  const event = `owner.command.${clean(command, 60)}${subcommand ? `.${clean(subcommand, 60)}` : ''}`;
  const metadata = {
    configPath: paths.config,
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
        enabled: result?.enabled,
      },
    });
    return result;
  } catch (error) {
    await audit.append({ event, outcome: 'failed', severity: 'error', confirmationId: flags.id || '', metadata: { ...metadata, ...auditError(error) } });
    throw error;
  }
}
