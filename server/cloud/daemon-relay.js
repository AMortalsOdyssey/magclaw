import crypto from 'node:crypto';
import os from 'node:os';
import { conversationLaneKeyForMessage } from '../conversation-session.js';

const MACHINE_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 365;
const MAX_DAEMON_EVENT_LOG = 300;
const SENT_DELIVERY_RETRY_TTL_MS = Math.max(1000, Number(process.env.MAGCLAW_DAEMON_SENT_RETRY_TTL_MS || 1000 * 60 * 2));
const DAEMON_PING_MS = readMsEnv('MAGCLAW_DAEMON_PING_MS', 30_000, { min: 0, max: 10 * 60_000 });
const DAEMON_INBOUND_WATCHDOG_MS = readMsEnv('MAGCLAW_DAEMON_INBOUND_WATCHDOG_MS', 70_000, { min: 0, max: 10 * 60_000 });
const ACTIVITY_PROBE_TIMEOUT_MS = readMsEnv('MAGCLAW_DAEMON_ACTIVITY_PROBE_TIMEOUT_MS', 5_000, { min: 250, max: 60_000 });
const DAEMON_RUNTIME_COALESCE_MS = readMsEnv('MAGCLAW_DAEMON_RUNTIME_COALESCE_MS', 3_000, { min: 250, max: 60_000 });
const DAEMON_ACTIVITY_BROADCAST_MIN_MS = readMsEnv('MAGCLAW_DAEMON_ACTIVITY_BROADCAST_MIN_MS', 2_000, { min: 0, max: 60_000 });
const DEFAULT_DAEMON_RECONNECT_GRACE_MS = readMsEnv('MAGCLAW_DAEMON_RECONNECT_GRACE_MS', 60_000, { min: 0, max: 5 * 60_000 });
const ACTIVE_DELIVERY_STATUSES = new Set(['queued', 'sent', 'acked']);
const TERMINAL_DELIVERY_STATUSES = new Set(['completed', 'failed', 'stopped']);
const VALID_DELIVERY_STATUSES = new Set([...ACTIVE_DELIVERY_STATUSES, ...TERMINAL_DELIVERY_STATUSES]);

function readMsEnv(name, fallback, { min = 0, max = Number.POSITIVE_INFINITY } = {}) {
  const parsed = Number(process.env[name]);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(parsed)));
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function normalizeDeliveryStatus(status, fallback = 'queued') {
  const value = String(status || '').trim().toLowerCase();
  if (value === 'error') return 'failed';
  return VALID_DELIVERY_STATUSES.has(value) ? value : fallback;
}

function clearPairingProvisionalMetadata(computer) {
  if (!computer) return;
  const metadata = { ...objectValue(computer.metadata) };
  delete metadata.pairingProvisional;
  computer.metadata = metadata;
}

function websocketAcceptKey(key) {
  return crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
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
    header[1] = length;
  } else if (length < 65536) {
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, data]);
}

function decodeFrames(connection, chunk) {
  connection.buffer = Buffer.concat([connection.buffer, chunk]);
  const frames = [];

  while (connection.buffer.length >= 2) {
    const first = connection.buffer[0];
    const second = connection.buffer[1];
    const opcode = first & 0x0f;
    const masked = Boolean(second & 0x80);
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

    const maskOffset = offset;
    if (masked) offset += 4;
    if (connection.buffer.length < offset + length) break;

    const payload = Buffer.from(connection.buffer.subarray(offset, offset + length));
    if (masked) {
      const mask = connection.buffer.subarray(maskOffset, maskOffset + 4);
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] ^= mask[index % 4];
      }
    }
    connection.buffer = connection.buffer.subarray(offset + length);
    frames.push({ opcode, text: payload.toString('utf8') });
  }

  return frames;
}

function toWsUrl(serverUrl) {
  const value = String(serverUrl || '').replace(/\/+$/, '');
  if (value.startsWith('https://')) return `wss://${value.slice('https://'.length)}`;
  if (value.startsWith('http://')) return `ws://${value.slice('http://'.length)}`;
  return value;
}

function shellArg(value) {
  return JSON.stringify(String(value || ''));
}

function normalizeDisplayName(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text.slice(0, 120);
  }
  return '';
}

function bearerToken(req) {
  const header = String(req.headers?.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function publicComputerToken(item) {
  if (!item) return null;
  const { tokenHash, ...safe } = item;
  void tokenHash;
  return safe;
}

function expectedSocketClose(error) {
  const code = String(error?.code || error?.errno || '');
  return code === 'ECONNRESET' || code === 'EPIPE' || code === 'ERR_STREAM_PREMATURE_CLOSE';
}

function socketErrorCode(error) {
  return String(error?.code || error?.errno || 'UNKNOWN');
}

function socketErrorMessage(error) {
  return String(error?.message || error || 'Socket error').replace(/\s+/g, ' ').slice(0, 300);
}

function safeSocketWrite(socket, chunk) {
  try {
    if (socket?.destroyed) return false;
    socket.write(chunk);
    return true;
  } catch {
    return false;
  }
}

function safeSocketEnd(socket, chunk = '') {
  try {
    if (socket?.destroyed) return false;
    socket.end(chunk);
    return true;
  } catch {
    try {
      socket?.destroy?.();
    } catch {
      // Ignore cleanup failures on already-reset sockets.
    }
    return false;
  }
}

function safeSocketDestroy(socket) {
  try {
    socket?.destroy?.();
  } catch {
    // Ignore cleanup failures on already-reset sockets.
  }
}

export function createDaemonRelay(deps) {
  const {
    addSystemEvent,
    AGENT_STATUS_STALE_MS = 45_000,
    broadcastState,
    cloudAuth,
    findAgent,
    findComputer,
    getState,
    host,
    isDraining = () => false,
    makeId,
    normalizeConversationRecord,
    now,
    persistCloudState = null,
    persistState,
    port,
    recordRealtimeEvent = null,
    DAEMON_RECONNECT_GRACE_MS = DEFAULT_DAEMON_RECONNECT_GRACE_MS,
    setAgentStatus,
  } = deps;

  const state = new Proxy({}, {
    get(_target, prop) { return getState()?.[prop]; },
    set(_target, prop, value) { getState()[prop] = value; return true; },
  });
  const connections = new Map();
  const pendingDisconnects = new Map();
  const pendingActivityProbes = new Map();
  const pendingSkillRequests = new Map();
  const pendingWorkspaceRequests = new Map();
  const pendingRuntimePersists = new Map();
  const lastRuntimeBroadcastAt = new Map();
  const handlers = {
    onAgentMessage: null,
  };

  function nowMs() {
    const parsed = Date.parse(now());
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  function deliveryRetryReady(delivery) {
    if (delivery.status === 'queued') return true;
    if (delivery.status !== 'sent') return false;
    if (delivery.ackedAt) return false;
    const sentAt = Date.parse(delivery.sentAt || delivery.updatedAt || delivery.createdAt || '');
    if (!Number.isFinite(sentAt)) return true;
    return nowMs() - sentAt >= SENT_DELIVERY_RETRY_TTL_MS;
  }

  function activeDeliveryMatches(delivery, agentId, messageId, workItemId) {
    if (!delivery || delivery.agentId !== agentId || !ACTIVE_DELIVERY_STATUSES.has(delivery.status)) return false;
    if (workItemId && delivery.workItemId === workItemId) return true;
    if (messageId && delivery.messageId === messageId) return true;
    return Boolean(workItemId && messageId && delivery.workItemId === workItemId && delivery.messageId === messageId);
  }

  function persistAllState(options = {}) {
    return (persistCloudState || persistState)(options);
  }

  function workspaceIdForRuntime(record = null, fallback = '') {
    return String(
      record?.workspaceId
      || fallback
      || state.connection?.workspaceId
      || cloud().workspaces?.[0]?.id
      || '',
    ).trim();
  }

  function workspaceIdForAgent(agent = null, fallback = '') {
    return workspaceIdForRuntime(agent, fallback);
  }

  function workspaceIdForComputer(computer = null, connection = null) {
    return workspaceIdForRuntime(computer, connection?.workspaceId || '');
  }

  function persistRuntimeState(workspaceId, reason = 'daemon_runtime_changed') {
    const cleanWorkspaceId = String(workspaceId || '').trim();
    const options = { reason };
    if (cleanWorkspaceId) options.workspaceId = cleanWorkspaceId;
    return persistState(options);
  }

  async function persistRuntimeStateAndBroadcast(workspaceId, reason, broadcastOptions) {
    await persistRuntimeState(workspaceId, reason);
    broadcastState(broadcastOptions);
  }

  function broadcastRuntimeStateThrottled(key, minIntervalMs = DAEMON_ACTIVITY_BROADCAST_MIN_MS, broadcastOptions) {
    if (!minIntervalMs) {
      broadcastState(broadcastOptions);
      return true;
    }
    const nowTime = nowMs();
    const last = lastRuntimeBroadcastAt.get(key) || 0;
    if (nowTime - last < minIntervalMs) return false;
    lastRuntimeBroadcastAt.set(key, nowTime);
    broadcastState(broadcastOptions);
    return true;
  }

  function scheduleRuntimePersist(workspaceId, reason, options = {}) {
    const cleanWorkspaceId = String(workspaceId || '').trim();
    const key = `${cleanWorkspaceId || 'global'}:${reason}`;
    const existing = pendingRuntimePersists.get(key);
    if (existing) {
      existing.reason = reason;
      existing.broadcast = existing.broadcast || Boolean(options.broadcast);
      return;
    }
    const delayMs = options.delayMs ?? DAEMON_RUNTIME_COALESCE_MS;
    const pending = {
      reason,
      broadcast: Boolean(options.broadcast),
      timer: setTimeout(() => {
        pendingRuntimePersists.delete(key);
        persistRuntimeState(cleanWorkspaceId, pending.reason)
          .then(() => {
            if (pending.broadcast) {
              broadcastRuntimeStateThrottled(options.broadcastKey || key, options.minBroadcastMs, options.broadcastOptions);
            }
          })
          .catch(() => {});
      }, delayMs),
    };
    pending.timer.unref?.();
    pendingRuntimePersists.set(key, pending);
  }

  function cloud() {
    return cloudAuth.ensureCloudState();
  }

  function findWorkItemRecord(id) {
    const value = String(id || '').trim();
    if (!value) return null;
    return safeArray(state.workItems).find((item) => item.id === value) || null;
  }

  function markWorkItemDeliveredFromDelivery(delivery) {
    const item = findWorkItemRecord(delivery?.workItemId);
    if (!item || item.status === 'stopped' || item.status === 'responded') return false;
    item.status = 'delivered';
    item.deliveryMode = 'daemon';
    item.deliveredAt = item.deliveredAt || now();
    item.updatedAt = now();
    return true;
  }

  function markWorkItemQueuedFromDelivery(delivery) {
    const item = findWorkItemRecord(delivery?.workItemId);
    if (!item || item.status === 'stopped' || item.status === 'responded') return false;
    item.status = 'queued_remote';
    item.deliveryMode = 'daemon';
    item.updatedAt = now();
    return true;
  }

  function compactLogText(value, limit = 120) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function contextPackLogSummary(pack) {
    const participants = safeArray(pack?.participants);
    return {
      hasContextPack: Boolean(pack),
      participantCount: participants.length,
      participants: participants.map((item) => ({
        id: item.id,
        name: item.name,
        type: item.type,
        runtime: item.runtime || '',
        status: item.status || '',
        description: compactLogText(item.description || item.role || ''),
      })),
      recentMessages: safeArray(pack?.recentMessages).length,
      threadReplies: safeArray(pack?.thread?.recentReplies).length,
      recentEvents: safeArray(pack?.recentEvents).length,
      tasks: safeArray(pack?.tasks).length,
      peerMemoryRequired: Boolean(pack?.peerMemorySearch?.required),
      peerMemoryResults: safeArray(pack?.peerMemorySearch?.results).length,
    };
  }

  function primaryWorkspaceId() {
    const workspace = typeof cloudAuth.primaryWorkspace === 'function'
      ? cloudAuth.primaryWorkspace()
      : cloud().workspaces?.[0];
    return workspace?.id || null;
  }

  function daemonEventComputerId(event = {}) {
    return String(event.computerId || event.meta?.computerId || '').trim();
  }

  function daemonEventWorkspaceId(event = {}) {
    const explicit = String(event.workspaceId || event.meta?.workspaceId || '').trim();
    if (explicit) return explicit;
    const computerId = daemonEventComputerId(event);
    if (computerId) {
      const computer = findComputer(computerId);
      if (computer?.workspaceId) return computer.workspaceId;
    }
    return primaryWorkspaceId();
  }

  function recordDaemonEvent(type, message, meta = {}) {
    const computerId = String(meta.computerId || '').trim();
    const computer = computerId ? findComputer(computerId) : null;
    const workspaceId = String(meta.workspaceId || computer?.workspaceId || primaryWorkspaceId() || '').trim();
    const safeMeta = {
      ...meta,
      ...(workspaceId ? { workspaceId } : {}),
    };
    const event = {
      id: makeId('devt'),
      workspaceId: workspaceId || null,
      computerId: computerId || null,
      type,
      message,
      meta: safeMeta,
      createdAt: now(),
    };
    const store = cloud();
    store.daemonEvents.unshift(event);
    store.daemonEvents = store.daemonEvents.slice(0, MAX_DAEMON_EVENT_LOG);
    addSystemEvent(type, message, safeMeta);
    return event;
  }

  function recordAgentRealtimeSnapshot(agent) {
    if (typeof recordRealtimeEvent !== 'function' || !agent?.id) return;
    recordRealtimeEvent('agent_status_changed', {
      agent: {
        id: agent.id,
        status: agent.status || 'offline',
        previousStatus: agent.previousStatus || null,
        statusUpdatedAt: agent.statusUpdatedAt || null,
        heartbeatAt: agent.heartbeatAt || null,
        runtimeActivity: agent.runtimeActivity || null,
        activeWorkItemIds: agent.activeWorkItemIds || [],
      },
    }, { scopeType: 'agent', scopeId: agent.id });
  }

  function publicUrlFromRequest(req) {
    const proto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim()
      || (req.socket?.encrypted ? 'https' : 'http');
    const forwardedHost = String(req.headers?.['x-forwarded-host'] || '').split(',')[0].trim();
    const requestHost = forwardedHost || req.headers?.host || `${host}:${port}`;
    return process.env.MAGCLAW_PUBLIC_URL || `${proto}://${requestHost}`;
  }

  function workspaceForRequest(req) {
    return (req && typeof cloudAuth.workspaceForRequest === 'function'
      ? cloudAuth.workspaceForRequest(req)
      : null)
      || (
        typeof cloudAuth.primaryWorkspace === 'function'
          ? cloudAuth.primaryWorkspace()
          : cloud().workspaces[0]
      )
      || {};
  }

  function safeDaemonProfilePart(value, fallback = 'local') {
    const text = String(value || '').trim() || fallback;
    return text.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80) || fallback;
  }

  function daemonProfileForConnection(workspace, computer = null) {
    const workspacePart = safeDaemonProfilePart(workspace?.slug || workspace?.id || 'local');
    const computerPart = computer?.id ? safeDaemonProfilePart(computer.id, '') : '';
    return computerPart ? `${workspacePart}-${computerPart}`.slice(0, 80) : workspacePart;
  }

  function connectCommand(credential, req, options = {}) {
    const publicUrl = publicUrlFromRequest(req);
    const workspace = options.workspace || workspaceForRequest(req);
    const profile = daemonProfileForConnection(workspace, options.computer);
    const comment = String(workspace.name || workspace.slug || workspace.id || 'local').trim() || profile;
    const displayName = normalizeDisplayName(options.displayName);
    const credentialFlag = options.credentialFlag || 'api-key';
    const template = process.env.MAGCLAW_DAEMON_CONNECT_COMMAND || '';
    if (template) {
      const rendered = template
        .replaceAll('{serverUrl}', publicUrl)
        .replaceAll('{apiKey}', credential)
        .replaceAll('{machineToken}', credential)
        .replaceAll('{pairToken}', credential)
        .replaceAll('{credential}', credential)
        .replaceAll('{credentialFlag}', `--${credentialFlag}`)
        .replaceAll('{profile}', profile)
        .replaceAll('{displayName}', displayName)
        .replaceAll('{serverName}', comment);
      return credentialFlag === 'api-key' ? rendered.replace(/--pair-token\b/g, '--api-key') : rendered;
    }
    const commandMode = String(process.env.MAGCLAW_DAEMON_COMMAND_MODE || 'local-repo').trim().toLowerCase();
    const useNpmCommand = ['npm', 'npx', 'package', 'cloud', 'remote'].includes(commandMode);
    const useLocalRepoCommand = ['', 'local', 'local-repo', 'repo', 'source'].includes(commandMode);
    if (!useNpmCommand && !useLocalRepoCommand) {
      console.warn(`[daemon-relay] unknown daemon command mode mode=${commandMode}; falling back to local-repo`);
    }
    const localRepoDir = process.env.MAGCLAW_DAEMON_LOCAL_REPO_PLACEHOLDER || '/path/to/magclaw';
    const launcher = useNpmCommand
      ? 'npx @magclaw/daemon@latest'
      : `MAGCLAW_REPO_DIR=${shellArg(localRepoDir)}; node "$MAGCLAW_REPO_DIR/daemon/bin/magclaw-daemon.js"`;
    return [
      launcher,
      `--server-url ${shellArg(publicUrl)}`,
      `--${credentialFlag} ${shellArg(credential)}`,
      `--profile ${shellArg(profile)}`,
      displayName ? `--display-name ${shellArg(displayName)}` : '',
      `# ${comment}`,
    ].filter(Boolean).join(' ');
  }

  function createPairingToken(body = {}, req) {
    const workspace = workspaceForRequest(req);
    const createdAt = now();
    const requestedDisplayName = normalizeDisplayName(body.displayName, body.name);
    const computerName = normalizeDisplayName(requestedDisplayName, body.label, 'My computer');
    let computer = null;
    let provisional = false;
    if (body.computerId) computer = findComputer(String(body.computerId));
    if (!computer) {
      provisional = true;
      computer = {
        id: makeId('cmp'),
        workspaceId: workspace.id,
        name: computerName || 'New Computer',
        hostname: '',
        os: '',
        arch: '',
        daemonVersion: '',
        status: 'pairing',
        runtimeIds: [],
        capabilities: [],
        connectedVia: 'daemon',
        metadata: { pairingProvisional: true },
        createdBy: body.createdBy || null,
        createdAt,
        updatedAt: createdAt,
      };
      state.computers.push(computer);
      console.info(`[daemon-relay] connection computer created computer=${computer.id} workspace=${workspace.id}`);
    }
    const tokenLabel = String(body.label || computer.name || 'daemon api key').trim();
    const issued = issueMachineToken(computer, {
      workspaceId: workspace.id,
      label: tokenLabel,
      createdAt,
    });
    const displayName = requestedDisplayName || computerName || computer.name || 'My computer';
    const command = connectCommand(issued.raw, req, { displayName, workspace, computer, credentialFlag: 'api-key' });
    return {
      computer,
      provisional,
      pairingToken: null,
      pairToken: '',
      machineToken: issued.raw,
      apiKey: issued.raw,
      machineTokenRecord: {
        id: issued.record.id,
        computerId: issued.record.computerId,
        workspaceId: issued.record.workspaceId,
        label: issued.record.label,
        createdAt: issued.record.createdAt,
        expiresAt: issued.record.expiresAt,
      },
      displayName,
      command,
      wsUrl: `${toWsUrl(publicUrlFromRequest(req))}/daemon/connect?token=${encodeURIComponent(issued.raw)}`,
    };
  }

  function validatePairToken(raw) {
    const hash = cloudAuth.sha256(raw);
    const pair = cloud().pairingTokens.find((item) => item.tokenHash === hash && !item.consumedAt && !item.revokedAt);
    if (!pair) return null;
    if (new Date(pair.expiresAt).getTime() <= Date.now()) return null;
    return pair;
  }

  function validateMachineToken(raw) {
    const hash = cloudAuth.sha256(raw);
    const record = cloud().computerTokens.find((item) => item.tokenHash === hash && !item.revokedAt);
    if (!record) return null;
    if (record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()) return null;
    return record;
  }

  function authenticateHttpRequest(req) {
    const raw = bearerToken(req);
    if (!raw) return null;
    const tokenRecord = validateMachineToken(raw);
    if (!tokenRecord) return null;
    const computer = findComputer(tokenRecord.computerId);
    if (!computer) return null;
    const at = now();
    tokenRecord.lastUsedAt = at;
    computer.lastSeenAt = at;
    persistAllState({
      workspaceId: tokenRecord.workspaceId || computer.workspaceId || '',
      reason: 'daemon_http_auth_seen',
    }).catch(() => {});
    return {
      type: 'daemon',
      workspaceId: tokenRecord.workspaceId || computer.workspaceId || null,
      computerId: computer.id,
      tokenId: tokenRecord.id,
    };
  }

  function issueMachineToken(computer, source = {}) {
    const raw = cloudAuth.token('mc_machine');
    const createdAt = source.createdAt || now();
    const record = {
      id: makeId('ctok'),
      workspaceId: source.workspaceId || source.workspace?.id || computer.workspaceId || cloud().workspaces[0]?.id || null,
      computerId: computer.id,
      label: source.label || computer.name || 'daemon token',
      tokenHash: cloudAuth.sha256(raw),
      createdAt,
      lastUsedAt: createdAt,
      revokedAt: null,
      expiresAt: new Date(Date.now() + MACHINE_TOKEN_TTL_MS).toISOString(),
    };
    cloud().computerTokens.push(record);
    return { raw, record };
  }

  function send(connection, payload) {
    if (!connection || connection.closed) return false;
    try {
      connection.socket.write(encodeFrame(payload));
      return true;
    } catch {
      connection.closed = true;
      return false;
    }
  }

  function sendToComputer(computerId, payload) {
    return send(connections.get(computerId), payload);
  }

  function requestAgentSkills(agent, { timeoutMs = 5_000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!agent?.id) {
        reject(new Error('Agent is required.'));
        return;
      }
      if (!agentShouldUseRelay(agent)) {
        reject(new Error('Agent is not connected through a daemon.'));
        return;
      }
      const connection = connections.get(agent.computerId);
      if (!connection || connection.closed || connection.socket?.destroyed) {
        reject(new Error('Agent daemon is not connected.'));
        return;
      }
      const commandId = makeId('ask');
      const timer = setTimeout(() => {
        pendingSkillRequests.delete(commandId);
        reject(new Error('Timed out waiting for daemon skills.'));
      }, Math.max(250, Number(timeoutMs) || 5_000));
      timer.unref?.();
      pendingSkillRequests.set(commandId, {
        agentId: agent.id,
        resolve,
        reject,
        timer,
      });
      const sent = send(connection, {
        type: 'agent:skills:list',
        commandId,
        agentId: agent.id,
        payload: {
          agent: {
            id: agent.id,
            name: agent.name,
            description: agent.description || '',
            runtime: agent.runtime,
            runtimeId: agent.runtimeId || null,
            model: agent.model || '',
            reasoningEffort: agent.reasoningEffort || null,
            envVars: safeArray(agent.envVars),
          },
        },
      });
      if (!sent) {
        clearTimeout(timer);
        pendingSkillRequests.delete(commandId);
        reject(new Error('Could not send skills request to daemon.'));
      }
    });
  }

  function requestAgentWorkspace(agent, { path = '', frameType, resultLabel, timeoutMs = 5_000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!agent?.id) {
        reject(new Error('Agent is required.'));
        return;
      }
      if (!agentShouldUseRelay(agent)) {
        reject(new Error('Agent is not connected through a daemon.'));
        return;
      }
      const connection = connections.get(agent.computerId);
      if (!connection || connection.closed || connection.socket?.destroyed) {
        reject(new Error('Agent daemon is not connected.'));
        return;
      }
      const commandId = makeId('awk');
      const timer = setTimeout(() => {
        pendingWorkspaceRequests.delete(commandId);
        reject(new Error(`Timed out waiting for daemon ${resultLabel}.`));
      }, Math.max(250, Number(timeoutMs) || 5_000));
      timer.unref?.();
      pendingWorkspaceRequests.set(commandId, {
        agentId: agent.id,
        resolve,
        reject,
        timer,
        resultLabel,
      });
      const sent = send(connection, {
        type: frameType,
        commandId,
        agentId: agent.id,
        path,
        payload: {
          path,
          agent: {
            id: agent.id,
            name: agent.name,
            description: agent.description || '',
            runtime: agent.runtime,
            runtimeId: agent.runtimeId || null,
            model: agent.model || '',
            reasoningEffort: agent.reasoningEffort || null,
            envVars: safeArray(agent.envVars),
          },
        },
      });
      if (!sent) {
        clearTimeout(timer);
        pendingWorkspaceRequests.delete(commandId);
        reject(new Error(`Could not send ${resultLabel} request to daemon.`));
      }
    });
  }

  function requestAgentWorkspaceList(agent, path = '', options = {}) {
    return requestAgentWorkspace(agent, {
      ...options,
      path,
      frameType: 'agent:workspace:list',
      resultLabel: 'workspace list',
    });
  }

  function requestAgentWorkspaceFile(agent, path = 'MEMORY.md', options = {}) {
    return requestAgentWorkspace(agent, {
      ...options,
      path,
      frameType: 'agent:workspace:file',
      resultLabel: 'workspace file',
    });
  }

  function stopConnectionTimers(connection) {
    if (!connection) return;
    if (connection.pingTimer) {
      clearInterval(connection.pingTimer);
      connection.pingTimer = null;
    }
    if (connection.watchdogTimer) {
      clearTimeout(connection.watchdogTimer);
      connection.watchdogTimer = null;
    }
  }

  function refreshConnectionWatchdog(connection) {
    if (!connection || connection.closed) return;
    connection.lastSeenAt = now();
    connection.lastInboundAtMs = nowMs();
    if (!DAEMON_INBOUND_WATCHDOG_MS) return;
    if (connection.watchdogTimer) clearTimeout(connection.watchdogTimer);
    connection.watchdogTimer = setTimeout(() => {
      if (connection.closed) return;
      const computer = findComputer(connection.computerId);
      recordDaemonEvent('computer_watchdog_timeout', `Computer connection timed out: ${computer?.name || connection.computerId || 'unknown'}`, {
        computerId: connection.computerId,
        lastSeenAt: connection.lastSeenAt || null,
      });
      safeSocketDestroy(connection.socket);
    }, DAEMON_INBOUND_WATCHDOG_MS);
    connection.watchdogTimer.unref?.();
  }

  function startConnectionPing(connection) {
    if (!connection || !DAEMON_PING_MS) return;
    if (connection.pingTimer) clearInterval(connection.pingTimer);
    connection.pingTimer = setInterval(() => {
      if (connection.closed || connection.socket?.destroyed) {
        stopConnectionTimers(connection);
        return;
      }
      if (!send(connection, { type: 'ping', time: now() })) {
        stopConnectionTimers(connection);
        safeSocketDestroy(connection.socket);
      }
    }, DAEMON_PING_MS);
    connection.pingTimer.unref?.();
  }

  function computerIsDisabled(computer) {
    return String(computer?.status || '').toLowerCase() === 'disabled' || Boolean(computer?.disabledAt);
  }

  function agentStatusIsBusy(status) {
    return ['starting', 'thinking', 'working', 'running', 'busy', 'queued', 'warming'].includes(String(status || '').toLowerCase());
  }

  function agentIsUnavailable(agent) {
    const status = String(agent?.status || '').toLowerCase();
    return !agent
      || Boolean(agent.deletedAt || agent.archivedAt || agent.disabledAt)
      || status === 'deleted'
      || status === 'disabled';
  }

  function deliveryWaitsForComputer(delivery, computerId, agentId = '') {
    if (!delivery || delivery.computerId !== computerId) return false;
    if (agentId && delivery.agentId !== agentId) return false;
    return ['queued', 'sent'].includes(String(delivery.status || '').toLowerCase()) && !delivery.ackedAt;
  }

  function agentHasQueuedComputerDelivery(agent, computerId) {
    return safeArray(cloud().agentDeliveries).some((delivery) => deliveryWaitsForComputer(delivery, computerId, agent.id));
  }

  function statusForReplayedDelivery(delivery) {
    const type = String(delivery?.commandType || delivery?.type || '');
    if (type === 'agent:start') return delivery?.payload?.reason === 'warmup' ? 'warming' : 'starting';
    if (type === 'agent:restart') return 'starting';
    return 'queued';
  }

  function markAgentStatusForDelivery(delivery, reason) {
    const agent = findAgent(delivery?.agentId);
    if (agentIsUnavailable(agent)) return false;
    setAgentStatus(agent, statusForReplayedDelivery(delivery), reason, {
      forceEvent: true,
      event: { computerId: delivery.computerId, deliveryId: delivery.id },
    });
    return true;
  }

  function agentRuntimeSessions() {
    state.agentRuntimeSessions = Array.isArray(state.agentRuntimeSessions) ? state.agentRuntimeSessions : [];
    return state.agentRuntimeSessions;
  }

  function ensureAgentRuntimeSession(agent, deliveryMessage = {}, sessionKey = '') {
    const key = sessionKey || conversationLaneKeyForMessage(state, {
      agent,
      spaceType: deliveryMessage.spaceType || 'channel',
      spaceId: deliveryMessage.spaceId || 'chan_all',
      message: deliveryMessage,
      parentMessageId: deliveryMessage.parentMessageId || null,
      workspaceId: deliveryMessage.workspaceId || '',
    });
    let session = agentRuntimeSessions().find((item) => item.agentId === agent.id && item.sessionKey === key);
    const timestamp = now();
    if (!session) {
      session = {
        id: makeId('ars'),
        workspaceId: deliveryMessage.workspaceId || agent.workspaceId || state.connection?.workspaceId || state.cloud?.workspace?.id || 'local',
        agentId: agent.id,
        computerId: agent.computerId || null,
        sessionKey: key,
        target: deliveryMessage.target || '',
        spaceType: deliveryMessage.spaceType || 'channel',
        spaceId: deliveryMessage.spaceId || 'chan_all',
        parentMessageId: deliveryMessage.parentMessageId || null,
        codexThreadId: null,
        status: 'queued',
        activeTurnIds: [],
        activeTargetKeys: [],
        lastTurnAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        metadata: {},
      };
      agentRuntimeSessions().push(session);
    }
    session.updatedAt = timestamp;
    return session;
  }

  function markAgentsForComputerDisconnected(computerId) {
    let changed = 0;
    for (const agent of safeArray(state.agents)) {
      if (agentIsUnavailable(agent) || agent.computerId !== computerId) continue;
      if (agent.status === 'offline') continue;
      setAgentStatus(agent, 'offline', 'daemon_computer_disconnected', {
        forceEvent: true,
        event: { computerId },
      });
      changed += 1;
    }
    return changed;
  }

  function markAgentsForComputerReady(computerId) {
    let changed = 0;
    for (const agent of safeArray(state.agents)) {
      if (agentIsUnavailable(agent) || agent.computerId !== computerId) continue;
      if (agentHasQueuedComputerDelivery(agent, computerId)) continue;
      if (!['offline', 'waiting_for_computer'].includes(String(agent.status || '').toLowerCase())) continue;
      setAgentStatus(agent, 'idle', 'daemon_computer_ready', {
        forceEvent: true,
        event: { computerId },
      });
      changed += 1;
    }
    return changed;
  }

  function requeueUnackedSentDeliveries(computerId, errorMessage) {
    const requeued = [];
    for (const delivery of safeArray(cloud().agentDeliveries)) {
      if (delivery.computerId !== computerId) continue;
      if (delivery.status !== 'sent' || delivery.ackedAt) continue;
      delivery.status = 'queued';
      delivery.error = errorMessage;
      delivery.updatedAt = now();
      requeued.push(delivery);
      markWorkItemQueuedFromDelivery(delivery);
    }
    if (requeued.length) {
      recordDaemonEvent('agent_delivery_requeued', `Requeued ${requeued.length} unacknowledged daemon delivery${requeued.length === 1 ? '' : 'ies'}.`, {
        computerId,
        deliveryIds: requeued.map((delivery) => delivery.id),
      });
    }
    return requeued;
  }

  function clearPendingDisconnect(computerId, { requeue = true } = {}) {
    const pending = pendingDisconnects.get(computerId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    pendingDisconnects.delete(computerId);
    if (requeue) {
      requeueUnackedSentDeliveries(computerId, 'Connection re-established before daemon acknowledgement.');
    }
    return true;
  }

  function probeStaleAgentHeartbeats() {
    const threshold = nowMs() - Math.max(1000, Number(AGENT_STATUS_STALE_MS || 45_000));
    let waitingForProbe = false;
    let changed = false;
    for (const agent of safeArray(state.agents)) {
      if (!agentStatusIsBusy(agent.status)) {
        pendingActivityProbes.delete(agent.id);
        continue;
      }
      if (!agentShouldUseRelay(agent)) continue;
      const connection = connections.get(agent.computerId);
      if (!connection || connection.closed || connection.socket?.destroyed) continue;
      const updatedAt = Date.parse(agent.heartbeatAt || agent.statusUpdatedAt || agent.updatedAt || agent.createdAt || '');
      if (Number.isFinite(updatedAt) && updatedAt >= threshold) {
        pendingActivityProbes.delete(agent.id);
        continue;
      }
      const pending = pendingActivityProbes.get(agent.id);
      if (pending && nowMs() < pending.deadlineMs) {
        waitingForProbe = true;
        continue;
      }
      if (pending) {
        pendingActivityProbes.delete(agent.id);
        continue;
      }
      const probeId = makeId('aprb');
      if (!send(connection, {
        type: 'agent:activity_probe',
        agentId: agent.id,
        probeId,
        purpose: 'stale_status_check',
      })) continue;
      pendingActivityProbes.set(agent.id, {
        probeId,
        sentAtMs: nowMs(),
        deadlineMs: nowMs() + ACTIVITY_PROBE_TIMEOUT_MS,
      });
      waitingForProbe = true;
      changed = true;
      recordDaemonEvent('activity_probe', `Probing ${agent.name} daemon activity before stale recovery.`, {
        agentId: agent.id,
        computerId: agent.computerId,
        probeId,
      });
    }
    return { waitingForProbe, changed };
  }

  function finalizeComputerDisconnected(connection) {
    if (!connection?.computerId) return;
    const pending = pendingDisconnects.get(connection.computerId);
    if (pending?.connection === connection) {
      clearTimeout(pending.timer);
      pendingDisconnects.delete(connection.computerId);
    }
    const current = connections.get(connection.computerId);
    if (current && current !== connection && !current.closed) return;
    if (connections.get(connection.computerId) === connection) connections.delete(connection.computerId);
    const computer = findComputer(connection.computerId);
    if (computer) {
      if (!computerIsDisabled(computer)) computer.status = 'offline';
      computer.reconnectingSince = null;
      computer.disconnectedAt = now();
      computer.updatedAt = now();
    }
    requeueUnackedSentDeliveries(connection.computerId, 'Connection dropped before daemon acknowledgement.');
    const affectedAgents = markAgentsForComputerDisconnected(connection.computerId);
    if (affectedAgents) {
      recordDaemonEvent('agent_computer_offline', `Marked ${affectedAgents} Agent${affectedAgents === 1 ? '' : 's'} offline because the computer disconnected.`, {
        computerId: connection.computerId,
        affectedAgents,
      });
    }
    recordDaemonEvent('computer_disconnected', `Computer disconnected: ${computer?.name || connection.computerId}`, {
      computerId: connection.computerId,
    });
    persistRuntimeStateAndBroadcast(
      workspaceIdForComputer(computer, connection),
      'daemon_computer_disconnected',
    ).catch(() => {});
  }

  function markComputerDisconnected(connection) {
    if (!connection?.computerId) return;
    if (connection.disconnected) return;
    connection.disconnected = true;
    connection.closed = true;
    stopConnectionTimers(connection);
    if (connections.get(connection.computerId) === connection) connections.delete(connection.computerId);
    if (connection.forceOffline || !DAEMON_RECONNECT_GRACE_MS) {
      finalizeComputerDisconnected(connection);
      return;
    }
    const computer = findComputer(connection.computerId);
    if (computer && !computerIsDisabled(computer)) {
      computer.status = 'connected';
      computer.reconnectingSince = now();
      computer.updatedAt = now();
    }
    const timer = setTimeout(() => finalizeComputerDisconnected(connection), DAEMON_RECONNECT_GRACE_MS);
    timer.unref?.();
    pendingDisconnects.set(connection.computerId, { connection, timer });
    recordDaemonEvent('computer_reconnect_grace', `Computer reconnect grace started: ${computer?.name || connection.computerId}`, {
      computerId: connection.computerId,
      graceMs: DAEMON_RECONNECT_GRACE_MS,
    });
    persistRuntimeStateAndBroadcast(
      workspaceIdForComputer(computer, connection),
      'daemon_computer_reconnect_grace',
    ).catch(() => {});
  }

  function adoptConnection(connection, computer, tokenRecord) {
    clearPendingDisconnect(computer.id);
    const previous = connections.get(computer.id);
    if (previous && previous !== connection) {
      previous.disconnected = true;
      previous.closed = true;
      stopConnectionTimers(previous);
      previous.socket.end();
      requeueUnackedSentDeliveries(computer.id, 'Connection replaced before daemon acknowledgement.');
    }
    connection.computerId = computer.id;
    connection.workspaceId = tokenRecord.workspaceId || computer.workspaceId || cloud().workspaces[0]?.id;
    connection.tokenId = tokenRecord.id;
    connections.set(computer.id, connection);
    if (!computerIsDisabled(computer)) computer.status = 'connected';
    computer.connectedVia = 'daemon';
    clearPairingProvisionalMetadata(computer);
    computer.lastSeenAt = now();
    computer.daemonConnectedAt = now();
    computer.reconnectingSince = null;
    computer.updatedAt = now();
    tokenRecord.lastUsedAt = now();
  }

  async function replayQueued(computerId) {
    const pending = safeArray(cloud().agentDeliveries)
      .filter((delivery) => delivery.computerId === computerId && deliveryRetryReady(delivery))
      .sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
    const replayed = [];
    for (const delivery of pending) {
      if (sendDelivery(delivery)) {
        replayed.push(delivery);
        markAgentStatusForDelivery(delivery, 'daemon_replay_queued_delivery');
      }
    }
    if (pending.length) {
      await persistRuntimeState(
        workspaceIdForComputer(findComputer(computerId)),
        'daemon_delivery_replayed',
      );
    }
    return replayed;
  }

  function nextDeliverySeq(agentId, computerId) {
    return safeArray(cloud().agentDeliveries)
      .filter((delivery) => delivery.agentId === agentId && delivery.computerId === computerId)
      .reduce((max, delivery) => Math.max(max, Number(delivery.seq || 0)), 0) + 1;
  }

  function deliveryIdempotencyKey(commandType, computerId, agentId, messageId, workItemId, payload = {}) {
    const core = [
      String(commandType || ''),
      String(computerId || ''),
      String(agentId || ''),
      String(messageId || ''),
      String(workItemId || ''),
    ];
    if (!messageId && !workItemId) {
      core.push(crypto.createHash('sha256').update(stableJson(payload)).digest('hex').slice(0, 16));
    }
    return core.join(':');
  }

  function sendDelivery(delivery) {
    const ok = sendToComputer(delivery.computerId, {
      type: delivery.commandType || delivery.type,
      commandId: delivery.id,
      seq: delivery.seq,
      agentId: delivery.agentId,
      workspaceId: delivery.workspaceId,
      idempotencyKey: delivery.idempotencyKey || null,
      payload: delivery.payload || {},
    });
    if (ok) {
      delivery.status = 'sent';
      delivery.sentAt = now();
      delivery.attempts = Number(delivery.attempts || 0) + 1;
      delivery.updatedAt = now();
    }
    return ok;
  }

  function markDeliveryFinished(id, status = 'completed', error = '') {
    if (!id) return null;
    const delivery = safeArray(cloud().agentDeliveries).find((item) => item.id === id);
    if (!delivery) return null;
    delivery.status = normalizeDeliveryStatus(status, 'completed');
    delivery.completedAt = delivery.completedAt || now();
    delivery.updatedAt = now();
    delivery.error = error || '';
    return delivery;
  }

  function queuedCommandPresenceStatus(agent, delivery) {
    const computer = findComputer(delivery?.computerId || agent?.computerId);
    if (!computer || computerIsDisabled(computer)) return 'offline';
    const status = String(computer.status || '').toLowerCase();
    if (status === 'pairing' || computer.reconnectingSince || pendingDisconnects.has(computer.id)) return 'waiting_for_computer';
    return 'offline';
  }

  function agentShouldUseRelay(agent) {
    if (!agent?.computerId || agent.computerId === 'cmp_local') return false;
    const computer = findComputer(agent.computerId);
    if (!computer) return false;
    if (computerIsDisabled(computer)) return false;
    return computer.connectedVia === 'daemon'
      || Boolean(cloud().computerTokens.some((item) => item.computerId === computer.id && !item.revokedAt))
      || computer.status === 'connected';
  }

  function queueAgentCommand(agent, commandType, payload = {}) {
    const store = cloud();
    const computer = findComputer(agent.computerId);
    if (!computer) return { queued: false, error: 'Computer not found.' };
    if (computerIsDisabled(computer)) return { queued: false, error: 'Computer is disabled.' };
    const workspace = store.workspaces[0];
    const messageId = payload.message?.id || payload.messageId || null;
    const workItemId = payload.workItem?.id || payload.workItemId || null;
    if (commandType === 'agent:deliver') {
      const existing = safeArray(store.agentDeliveries).find((delivery) => (
        delivery.commandType === commandType
        && delivery.computerId === computer.id
        && activeDeliveryMatches(delivery, agent.id, messageId, workItemId)
      ));
      if (existing) {
        recordDaemonEvent('agent_delivery_deduped', `Skipped duplicate delivery for ${agent.name}.`, {
          agentId: agent.id,
          computerId: computer.id,
          deliveryId: existing.id,
          messageId,
          workItemId,
        });
        return { queued: true, sent: existing.status === 'sent', delivery: existing, deduped: true };
      }
    }
    const delivery = {
      id: makeId('adl'),
      workspaceId: workspace.id,
      agentId: agent.id,
      computerId: computer.id,
      messageId,
      workItemId,
      seq: nextDeliverySeq(agent.id, computer.id),
      type: commandType,
      commandType,
      status: 'queued',
      idempotencyKey: deliveryIdempotencyKey(commandType, computer.id, agent.id, messageId, workItemId, payload),
      attempts: 0,
      payload,
      createdAt: now(),
      updatedAt: now(),
      sentAt: null,
      ackedAt: null,
      completedAt: null,
      error: '',
    };
    store.agentDeliveries.push(delivery);
    const sent = sendDelivery(delivery);
    return { queued: true, sent, delivery };
  }

  async function startAgent(agent, options = {}) {
    const result = queueAgentCommand(agent, 'agent:start', {
      agent: {
        id: agent.id,
        name: agent.name,
        description: agent.description || '',
        runtime: agent.runtime,
        runtimeId: agent.runtimeId || null,
        runtimeSessionId: agent.runtimeSessionId || null,
        model: agent.model,
        reasoningEffort: agent.reasoningEffort || null,
        workspace: agent.workspace || null,
        envVars: safeArray(agent.envVars),
      },
      reason: options.reason || 'manual',
    });
    if (result.queued) {
      const nextStatus = options.reason === 'warmup'
        ? (result.sent ? 'warming' : queuedCommandPresenceStatus(agent, result.delivery))
        : (result.sent ? 'starting' : queuedCommandPresenceStatus(agent, result.delivery));
      setAgentStatus(agent, nextStatus, 'daemon_relay_start', { forceEvent: true });
      await persistRuntimeState(workspaceIdForAgent(agent), 'daemon_agent_start_queued');
      broadcastState();
    }
    return result;
  }

  async function restartAgent(agent, options = {}) {
    const mode = ['restart', 'reset-session', 'full-reset'].includes(options.mode) ? options.mode : 'restart';
    if (mode === 'reset-session' || mode === 'full-reset') {
      agent.runtimeSessionId = null;
      agent.runtimeLastTurnAt = null;
    }
    if (mode === 'full-reset') {
      agent.runtimeSessionHome = null;
      agent.runtimeConfigVersion = 0;
      agent.runtimeLastStartedAt = null;
      agent.workspacePath = null;
    }
    const result = queueAgentCommand(agent, 'agent:restart', {
      agent: {
        id: agent.id,
        name: agent.name,
        description: agent.description || '',
        runtime: agent.runtime,
        runtimeId: agent.runtimeId || null,
        runtimeSessionId: agent.runtimeSessionId || null,
        model: agent.model,
        reasoningEffort: agent.reasoningEffort || null,
        workspace: agent.workspace || null,
        envVars: safeArray(agent.envVars),
      },
      mode,
      reason: options.reason || 'manual_restart',
    });
    if (result.queued) {
      setAgentStatus(agent, result.sent ? 'starting' : queuedCommandPresenceStatus(agent, result.delivery), 'daemon_relay_restart', { forceEvent: true });
      await persistRuntimeState(workspaceIdForAgent(agent), 'daemon_agent_restart_queued');
      broadcastState();
    }
    return result;
  }

  async function deliverToAgent(agent, deliveryMessage, workItem = null) {
    const runtimeSession = ensureAgentRuntimeSession(agent, deliveryMessage);
    const result = queueAgentCommand(agent, 'agent:deliver', {
      agent: {
        id: agent.id,
        name: agent.name,
        description: agent.description || '',
        runtime: agent.runtime,
        runtimeId: agent.runtimeId || null,
        runtimeSessionId: agent.runtimeSessionId || null,
        runtimeSessions: agentRuntimeSessions().filter((session) => session.agentId === agent.id),
        model: agent.model,
        reasoningEffort: agent.reasoningEffort || null,
        workspace: agent.workspace || null,
        envVars: safeArray(agent.envVars),
      },
      message: deliveryMessage,
      workItem,
      sessionKey: runtimeSession.sessionKey,
      runtimeSession,
    });
    if (!result.queued) return false;
    console.info('[daemon-relay] agent_delivery_queued', JSON.stringify({
      deliveryId: result.delivery?.id || null,
      deduped: Boolean(result.deduped),
      sent: Boolean(result.sent),
      agentId: agent.id,
      agentName: agent.name,
      runtime: agent.runtime || '',
      messageId: deliveryMessage?.id || null,
      workItemId: workItem?.id || deliveryMessage?.workItemId || null,
      ...contextPackLogSummary(deliveryMessage?.contextPack),
    }));
    if (result.deduped) {
      if (workItem) {
        workItem.status = result.sent ? 'sent_remote' : 'queued_remote';
        workItem.updatedAt = now();
      }
      await persistRuntimeState(workspaceIdForAgent(agent), 'daemon_agent_delivery_deduped');
      broadcastState();
      return true;
    }
    if (workItem) {
      workItem.status = result.sent ? 'sent_remote' : 'queued_remote';
      workItem.updatedAt = now();
    }
    setAgentStatus(agent, result.sent ? 'queued' : queuedCommandPresenceStatus(agent, result.delivery), 'daemon_relay_delivery', { forceEvent: true });
    await persistRuntimeState(workspaceIdForAgent(agent), 'daemon_agent_delivery_queued');
    broadcastState();
    return true;
  }

  async function revokeComputerToken(computerId, tokenId = '') {
    const matches = cloud().computerTokens.filter((item) => (
      item.computerId === computerId
      && !item.revokedAt
      && (!tokenId || item.id === tokenId)
    ));
    for (const item of matches) item.revokedAt = now();
    const connection = connections.get(computerId);
    if (connection) {
      send(connection, { type: 'token:revoked' });
      connection.socket.end();
    }
    await persistAllState({
      workspaceId: workspaceIdForComputer(findComputer(computerId)),
      reason: 'daemon_computer_token_revoked',
    });
    broadcastState();
    return { revoked: matches.map(publicComputerToken) };
  }

  async function handleReady(connection, message) {
    const computer = findComputer(connection.computerId);
    if (!computer) return;
    if (computerIsDisabled(computer)) {
      computer.status = 'disabled';
      computer.lastSeenAt = now();
      computer.updatedAt = now();
      send(connection, {
        type: 'error',
        error: 'This computer is disabled in MagClaw Cloud.',
      });
      connection.socket.end();
      await persistRuntimeState(workspaceIdForComputer(computer, connection), 'daemon_computer_disabled');
      broadcastState();
      return;
    }
    computer.hostname = String(message.hostname || computer.hostname || '');
    computer.name = String(message.name || computer.name || computer.hostname || os.hostname());
    if (message.machineFingerprint) computer.machineFingerprint = String(message.machineFingerprint);
    computer.os = String(message.os || computer.os || '');
    computer.arch = String(message.arch || computer.arch || '');
    computer.daemonVersion = String(message.daemonVersion || computer.daemonVersion || '');
    computer.runtimeIds = safeArray(message.runtimes || message.runtimeIds).map(String);
    computer.runtimeDetails = safeArray(message.runtimeDetails);
    computer.runningAgents = safeArray(message.runningAgents);
    computer.capabilities = safeArray(message.capabilities).map(String);
    computer.status = 'connected';
    computer.lastSeenAt = now();
    computer.updatedAt = now();
    recordDaemonEvent('computer_ready', `Computer ready: ${computer.name}`, {
      computerId: computer.id,
      runtimes: computer.runtimeIds,
    });
    send(connection, {
      type: 'ready:ack',
      computerId: computer.id,
      workspaceId: connection.workspaceId,
      time: now(),
    });
    await replayQueued(computer.id);
    markAgentsForComputerReady(computer.id);
    await persistRuntimeState(workspaceIdForComputer(computer, connection), 'daemon_computer_ready');
    broadcastState();
  }

  async function handleAck(connection, message) {
    const id = String(message.commandId || message.deliveryId || '');
    const delivery = safeArray(cloud().agentDeliveries).find((item) => item.id === id);
    if (delivery) {
      if (!TERMINAL_DELIVERY_STATUSES.has(normalizeDeliveryStatus(delivery.status))) {
        delivery.status = 'acked';
      }
      delivery.ackedAt = now();
      delivery.updatedAt = now();
      delivery.error = '';
      markWorkItemDeliveredFromDelivery(delivery);
      recordDaemonEvent('agent_delivery_acked', `Daemon acknowledged ${delivery.commandType || delivery.type}.`, {
        agentId: delivery.agentId,
        computerId: delivery.computerId,
        deliveryId: delivery.id,
        messageId: delivery.messageId || null,
        workItemId: delivery.workItemId || null,
      });
    }
    const agent = delivery ? findAgent(delivery.agentId) : findAgent(message.agentId);
    if (agent && message.status) setAgentStatus(agent, String(message.status), 'daemon_relay_ack');
    await persistRuntimeState(
      workspaceIdForAgent(agent, workspaceIdForComputer(findComputer(connection.computerId), connection)),
      'daemon_delivery_acked',
    );
    broadcastState();
  }

  async function handleAgentStatus(message) {
    const agent = findAgent(message.agentId);
    if (!agent) return;
    if (message.probeId) pendingActivityProbes.delete(agent.id);
    const runtimeActivity = message.activity || agent.runtimeActivity || null;
    setAgentStatus(agent, String(message.status || 'idle'), 'daemon_status', {
      forceEvent: true,
      runtimeActivity,
    });
    const nextStatus = String(message.status || '').toLowerCase();
    if (message.deliveryId && ['idle', 'offline'].includes(nextStatus)) {
      markDeliveryFinished(message.deliveryId, 'completed');
    } else if (message.deliveryId && nextStatus === 'error') {
      markDeliveryFinished(message.deliveryId, 'failed', message.activity?.error || message.activity?.detail || 'Agent delivery failed.');
    }
    if (message.sessionId !== undefined) {
      agent.runtimeSessionId = message.sessionId || null;
      if (message.sessionKey) {
        const session = ensureAgentRuntimeSession(agent, {}, String(message.sessionKey));
        session.codexThreadId = message.sessionId || null;
        session.status = String(message.status || 'idle');
        session.updatedAt = now();
      }
    }
    agent.runtimeActivity = runtimeActivity;
    agent.heartbeatAt = now();
    if (!message.status) recordAgentRealtimeSnapshot(agent);
    const immediate = Boolean(
      message.sessionId !== undefined
      || (message.deliveryId && ['idle', 'offline', 'error'].includes(nextStatus))
    );
    if (immediate) {
      await persistRuntimeState(workspaceIdForAgent(agent), 'daemon_agent_status_terminal');
      broadcastState();
    } else if (message.deliveryId) {
      await persistRuntimeState(workspaceIdForAgent(agent), 'daemon_agent_status');
      broadcastState();
    } else {
      scheduleRuntimePersist(workspaceIdForAgent(agent), 'daemon_agent_status', {
        broadcast: true,
        broadcastKey: `agent:${agent.id}`,
        broadcastOptions: { realtimeOnly: true },
      });
    }
  }

  async function handleAgentActivity(message) {
    const agent = findAgent(message.agentId);
    if (!agent) return;
    if (message.probeId) pendingActivityProbes.delete(agent.id);
    const runtimeActivity = message.activity || agent.runtimeActivity || null;
    if (message.status) {
      setAgentStatus(agent, String(message.status), 'daemon_activity', {
        forceEvent: true,
        runtimeActivity,
      });
    }
    agent.runtimeActivity = runtimeActivity;
    agent.heartbeatAt = now();
    if (!message.status) recordAgentRealtimeSnapshot(agent);
    recordDaemonEvent('agent_activity', `${agent.name} reported daemon activity.`, {
      agentId: agent.id,
      computerId: message.computerId || agent.computerId || null,
      activity: message.activity || null,
      deliveryId: message.deliveryId || null,
    });
    if (message.deliveryId) {
      await persistRuntimeState(workspaceIdForAgent(agent), 'daemon_agent_activity');
      broadcastState();
      return;
    }
    scheduleRuntimePersist(workspaceIdForAgent(agent), 'daemon_agent_activity', {
      broadcast: true,
      broadcastKey: `agent:${agent.id}`,
      broadcastOptions: { realtimeOnly: true },
    });
  }

  async function handleAgentMessage(message) {
    const agent = findAgent(message.agentId);
    if (!agent) return;
    const payload = message.payload || message;
    markDeliveryFinished(message.deliveryId || payload.deliveryId || null, 'completed');
    if (handlers.onAgentMessage) {
      await handlers.onAgentMessage({
        agent,
        body: String(payload.body || payload.content || ''),
        spaceType: payload.spaceType || payload.message?.spaceType || 'channel',
        spaceId: payload.spaceId || payload.message?.spaceId || 'chan_all',
        parentMessageId: payload.parentMessageId || payload.message?.parentMessageId || null,
        sourceMessage: payload.sourceMessage || payload.message || null,
        attachments: safeArray(payload.attachmentIds),
        deliveryId: message.deliveryId || payload.deliveryId || null,
        idempotencyKey: payload.idempotencyKey || message.idempotencyKey || message.deliveryId || payload.deliveryId || null,
      });
    } else {
      state.messages.push(normalizeConversationRecord({
        id: makeId('msg'),
        workspaceId: payload.workspaceId || payload.message?.workspaceId || agent.workspaceId || state.connection?.workspaceId || 'local',
        spaceType: payload.spaceType || 'channel',
        spaceId: payload.spaceId || 'chan_all',
        authorType: 'agent',
        authorId: agent.id,
        body: String(payload.body || payload.content || ''),
        attachmentIds: safeArray(payload.attachmentIds),
        deliveryId: message.deliveryId || payload.deliveryId || null,
        idempotencyKey: payload.idempotencyKey || message.idempotencyKey || message.deliveryId || payload.deliveryId || null,
        replyCount: 0,
        savedBy: [],
        createdAt: now(),
        updatedAt: now(),
      }));
      await persistRuntimeState(workspaceIdForAgent(agent, payload.workspaceId || payload.message?.workspaceId || ''), 'daemon_agent_message_created');
      broadcastState();
    }
  }

  async function handleDaemonMessage(connection, raw) {
    let message = null;
    try {
      message = JSON.parse(raw);
    } catch {
      send(connection, { type: 'error', error: 'Invalid JSON frame.' });
      return;
    }
    connection.lastSeenAt = now();
    refreshConnectionWatchdog(connection);
    const computer = findComputer(connection.computerId);
    if (computer) {
      if (!computerIsDisabled(computer)) computer.status = 'connected';
      computer.lastSeenAt = now();
      computer.updatedAt = now();
    }
    switch (message.type) {
      case 'ready':
        await handleReady(connection, message);
        break;
      case 'pong':
        if (computer) {
          computer.lastSeenAt = now();
          scheduleRuntimePersist(
            workspaceIdForComputer(computer, connection),
            'daemon_pong',
            { delayMs: DAEMON_RUNTIME_COALESCE_MS },
          );
        }
        break;
      case 'heartbeat':
        if (computer) {
          if (!computerIsDisabled(computer)) computer.status = 'connected';
          if (message.daemonVersion) computer.daemonVersion = String(message.daemonVersion);
          computer.runningAgents = safeArray(message.runningAgents);
          computer.lastSeenAt = now();
          computer.updatedAt = now();
          scheduleRuntimePersist(
            workspaceIdForComputer(computer, connection),
            'daemon_heartbeat',
            {
              broadcast: true,
              broadcastKey: `computer:${computer.id}`,
              minBroadcastMs: DAEMON_ACTIVITY_BROADCAST_MIN_MS,
            },
          );
        }
        break;
      case 'agent:start:ack':
      case 'agent:deliver:ack':
      case 'agent:ack':
        await handleAck(connection, message);
        break;
      case 'daemon:release_notice:ack':
        recordDaemonEvent('daemon_release_notice_acked', 'Daemon acknowledged release notice.', {
          computerId: connection.computerId,
          commandId: message.commandId || null,
          version: message.version || null,
          receivedAt: message.receivedAt || null,
        });
        await persistRuntimeState(
          workspaceIdForComputer(findComputer(connection.computerId), connection),
          'daemon_release_notice_acked',
        );
        broadcastState();
        break;
      case 'agent:status':
      case 'agent:session':
        await handleAgentStatus(message);
        break;
      case 'agent:activity':
        await handleAgentActivity(message);
        break;
      case 'agent:message':
        await handleAgentMessage(message);
        break;
      case 'agent:skills:list_result':
        {
          const agent = findAgent(message.agentId);
          if (agent) {
            agent.skillSnapshot = {
              ...(message.skills && typeof message.skills === 'object' ? message.skills : {}),
              loading: false,
              updatedAt: now(),
              computerId: connection.computerId,
            };
          }
          const pending = pendingSkillRequests.get(message.commandId);
          if (pending) {
            clearTimeout(pending.timer);
            pendingSkillRequests.delete(message.commandId);
            pending.resolve(agent?.skillSnapshot || message.skills || {});
          }
          recordDaemonEvent('daemon_result', `Daemon returned ${message.type}.`, {
            computerId: connection.computerId,
            agentId: message.agentId || null,
            commandId: message.commandId || null,
            resultType: message.type,
          });
          await persistRuntimeState(
            workspaceIdForAgent(agent, workspaceIdForComputer(findComputer(connection.computerId), connection)),
            'daemon_agent_skills_list_result',
          );
          broadcastState();
        }
        break;
      case 'agent:workspace:list_result':
      case 'agent:workspace:file_result':
        {
          const agent = findAgent(message.agentId);
          const pending = pendingWorkspaceRequests.get(message.commandId);
          if (pending) {
            clearTimeout(pending.timer);
            pendingWorkspaceRequests.delete(message.commandId);
            pending.resolve(message.type === 'agent:workspace:list_result'
              ? (message.tree || { entries: [] })
              : { file: message.file || null });
          }
          recordDaemonEvent('daemon_result', `Daemon returned ${message.type}.`, {
            computerId: connection.computerId,
            agentId: message.agentId || null,
            commandId: message.commandId || null,
            resultType: message.type,
          });
          await persistRuntimeState(
            workspaceIdForAgent(agent, workspaceIdForComputer(findComputer(connection.computerId), connection)),
            message.type === 'agent:workspace:list_result' ? 'daemon_agent_workspace_list_result' : 'daemon_agent_workspace_file_result',
          );
          broadcastState();
        }
        break;
      case 'machine:runtime_models:result':
        recordDaemonEvent('daemon_result', `Daemon returned ${message.type}.`, {
          computerId: connection.computerId,
          agentId: message.agentId || null,
          commandId: message.commandId || null,
          resultType: message.type,
        });
        await persistRuntimeState(
          workspaceIdForComputer(findComputer(connection.computerId), connection),
          'daemon_machine_runtime_models_result',
        );
        broadcastState();
        break;
      case 'agent:error':
        {
          const agent = findAgent(message.agentId);
          const pendingSkill = pendingSkillRequests.get(message.commandId);
          if (pendingSkill) {
            clearTimeout(pendingSkill.timer);
            pendingSkillRequests.delete(message.commandId);
            pendingSkill.reject(new Error(String(message.error || 'Agent error')));
          }
          const pendingWorkspace = pendingWorkspaceRequests.get(message.commandId);
          if (pendingWorkspace) {
            clearTimeout(pendingWorkspace.timer);
            pendingWorkspaceRequests.delete(message.commandId);
            pendingWorkspace.reject(new Error(String(message.error || 'Agent error')));
          }
          if (agent) {
            setAgentStatus(agent, 'error', 'daemon_error', { forceEvent: true });
            markDeliveryFinished(message.commandId || message.deliveryId || null, 'failed', String(message.error || 'Agent error'));
            agent.runtimeActivity = {
              source: '@magclaw/daemon',
              error: String(message.error || 'Agent error'),
              at: now(),
            };
            agent.heartbeatAt = now();
          }
          recordDaemonEvent('agent_error', String(message.error || 'Agent error'), {
            agentId: message.agentId || null,
            computerId: connection.computerId,
          });
          await persistRuntimeState(
            workspaceIdForAgent(agent, workspaceIdForComputer(findComputer(connection.computerId), connection)),
            'daemon_agent_error',
          );
          broadcastState();
        }
        break;
      default:
        send(connection, { type: 'error', error: `Unsupported daemon event: ${message.type || 'unknown'}` });
        break;
    }
  }

  async function authenticateConnection(req, url) {
    const rawPair = String(url.searchParams.get('pair_token') || url.searchParams.get('pairToken') || '').trim();
    const rawToken = String(url.searchParams.get('token') || url.searchParams.get('api_key') || url.searchParams.get('apiKey') || url.searchParams.get('key') || '').trim();
    if (rawPair) {
      const pair = validatePairToken(rawPair);
      if (!pair) return { error: 'Invalid or expired pair token.' };
      let computer = findComputer(pair.computerId);
      if (!computer) {
        const provisionalComputer = pair.metadata?.provisionalComputer && pair.metadata?.computer;
        if (!provisionalComputer) {
          pair.revokedAt = now();
          await persistAllState({
            workspaceId: pair.workspaceId || '',
            reason: 'daemon_pairing_token_revoked',
          });
          broadcastState();
          return { error: 'Paired computer was not found.' };
        }
        const createdAt = now();
        computer = {
          ...provisionalComputer,
          id: pair.computerId,
          workspaceId: pair.workspaceId,
          status: 'pairing',
          createdAt: provisionalComputer.createdAt || pair.createdAt || createdAt,
          updatedAt: createdAt,
        };
        state.computers.push(computer);
      }
      if (computerIsDisabled(computer)) return { error: 'Computer is disabled.' };
      const issued = issueMachineToken(computer, pair);
      pair.consumedAt = now();
      return {
        computer,
        tokenRecord: issued.record,
        welcome: {
          type: 'pairing:accepted',
          computerId: computer.id,
          workspaceId: pair.workspaceId,
          machineToken: issued.raw,
        },
      };
    }
    if (rawToken) {
      const tokenRecord = validateMachineToken(rawToken);
      if (!tokenRecord) return { error: 'Invalid or revoked machine token.' };
      const computer = findComputer(tokenRecord.computerId);
      if (!computer) return { error: 'Computer token is not linked to a computer.' };
      if (computerIsDisabled(computer)) return { error: 'Computer is disabled.' };
      return {
        computer,
        tokenRecord,
        welcome: {
          type: 'connected',
          computerId: computer.id,
          workspaceId: tokenRecord.workspaceId,
        },
      };
    }
    return { error: 'A pair token or machine token is required.' };
  }

  async function handleUpgrade(req, socket) {
    const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
    if (url.pathname !== '/daemon/connect') return false;
    if (isDraining()) {
      safeSocketEnd(socket, 'HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nMagClaw server is draining.');
      return true;
    }
    let connection = null;
    socket.on('error', (error) => {
      if (connection) {
        markComputerDisconnected(connection);
        return;
      }
      if (!expectedSocketClose(error)) {
        console.warn(`[daemon-relay] websocket socket error before connection code=${socketErrorCode(error)} message=${socketErrorMessage(error)}`);
      }
    });
    const key = String(req.headers['sec-websocket-key'] || '');
    if (!key) {
      safeSocketWrite(socket, 'HTTP/1.1 400 Bad Request\r\n\r\n');
      safeSocketDestroy(socket);
      return true;
    }
    const auth = await authenticateConnection(req, url);
    if (auth.error) {
      safeSocketEnd(socket, `HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\n\r\n${auth.error}`);
      return true;
    }

    const accepted = safeSocketWrite(socket, [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${websocketAcceptKey(key)}`,
      '\r\n',
    ].join('\r\n'));
    if (!accepted) return true;

    connection = {
      id: makeId('ws'),
      socket,
      buffer: Buffer.alloc(0),
      closed: false,
      computerId: null,
      workspaceId: null,
      tokenId: null,
      lastSeenAt: now(),
      lastInboundAtMs: nowMs(),
      pingTimer: null,
      watchdogTimer: null,
    };
    adoptConnection(connection, auth.computer, auth.tokenRecord);
    refreshConnectionWatchdog(connection);
    startConnectionPing(connection);
    send(connection, auth.welcome);
    recordDaemonEvent('computer_connected', `Computer connected: ${auth.computer.name}`, {
      computerId: auth.computer.id,
    });
    await persistAllState({
      workspaceId: auth.tokenRecord.workspaceId || auth.computer.workspaceId || '',
      reason: 'daemon_computer_connected',
    });
    broadcastState();

    socket.on('data', (chunk) => {
      for (const frame of decodeFrames(connection, chunk)) {
        if (frame.opcode === 0x8) {
          connection.closed = true;
          stopConnectionTimers(connection);
          safeSocketEnd(socket);
          return;
        }
        if (frame.opcode === 0x9) {
          refreshConnectionWatchdog(connection);
          send(connection, { type: 'pong', time: now() });
          continue;
        }
        if (frame.opcode === 0x1) {
          handleDaemonMessage(connection, frame.text).catch((error) => {
            send(connection, { type: 'error', error: error.message });
          });
        }
      }
    });
    socket.on('close', () => markComputerDisconnected(connection));
    socket.on('end', () => markComputerDisconnected(connection));
    return true;
  }

  function setHandlers(nextHandlers = {}) {
    Object.assign(handlers, nextHandlers);
  }

  function publicRelayState() {
    const workspaceId = primaryWorkspaceId();
    const daemonEvents = safeArray(cloud().daemonEvents)
      .filter((event) => {
        const eventWorkspaceId = daemonEventWorkspaceId(event);
        if (workspaceId && eventWorkspaceId && eventWorkspaceId !== workspaceId) return false;
        const computerId = daemonEventComputerId(event);
        return !computerId || Boolean(findComputer(computerId));
      })
      .slice(0, 50);
    return {
      onlineComputerIds: [...connections.keys()].filter((computerId) => !computerIsDisabled(findComputer(computerId))),
      daemonEvents,
    };
  }

  function disconnectComputer(computerId, reason = 'Computer disconnected.') {
    const connection = connections.get(computerId);
    if (!connection) return false;
    connection.forceOffline = true;
    send(connection, { type: 'error', error: reason });
    connection.socket.end();
    return true;
  }

  function beginDrain(reason = 'draining') {
    for (const connection of connections.values()) {
      send(connection, {
        type: 'server:draining',
        reason,
        reconnect: true,
        time: now(),
      });
      connection.socket.end();
    }
  }

  function sendDaemonReleaseNotice(computerId, notice = {}) {
    const commandId = makeId('dnotice');
    const sent = sendToComputer(computerId, {
      type: 'daemon:release_notice',
      commandId,
      notice: {
        version: String(notice.version || ''),
        title: String(notice.title || 'Daemon release notice'),
        body: String(notice.body || notice.message || ''),
        severity: String(notice.severity || 'info'),
      },
    });
    recordDaemonEvent(sent ? 'daemon_release_notice_sent' : 'daemon_release_notice_queued', 'Daemon release notice dispatched.', {
      computerId,
      commandId,
      version: notice.version || null,
      sent,
    });
    return { commandId, sent };
  }

  return {
    agentShouldUseRelay,
    authenticateHttpRequest,
    beginDrain,
    createPairingToken,
    deliverToAgent,
    disconnectComputer,
    handleUpgrade,
    probeStaleAgentHeartbeats,
    publicRelayState,
    requestAgentSkills,
    requestAgentWorkspaceFile,
    requestAgentWorkspaceList,
    revokeComputerToken,
    sendDaemonReleaseNotice,
    setHandlers,
    startAgent,
    restartAgent,
  };
}
