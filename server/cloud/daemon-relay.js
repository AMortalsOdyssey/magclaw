import crypto from 'node:crypto';
import os from 'node:os';

const PAIR_TTL_MS = 1000 * 60 * 15;
const MACHINE_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 365;
const MAX_DAEMON_EVENT_LOG = 300;

function safeArray(value) {
  return Array.isArray(value) ? value : [];
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

function publicPairingToken(item) {
  if (!item) return null;
  const { tokenHash, ...safe } = item;
  void tokenHash;
  return safe;
}

export function createDaemonRelay(deps) {
  const {
    addSystemEvent,
    broadcastState,
    cloudAuth,
    findAgent,
    findComputer,
    getState,
    host,
    makeId,
    normalizeConversationRecord,
    now,
    persistState,
    port,
    setAgentStatus,
  } = deps;

  const state = new Proxy({}, {
    get(_target, prop) { return getState()?.[prop]; },
    set(_target, prop, value) { getState()[prop] = value; return true; },
  });
  const connections = new Map();
  const handlers = {
    onAgentMessage: null,
  };

  function cloud() {
    return cloudAuth.ensureCloudState();
  }

  function recordDaemonEvent(type, message, meta = {}) {
    const event = {
      id: makeId('devt'),
      type,
      message,
      meta,
      createdAt: now(),
    };
    const store = cloud();
    store.daemonEvents.unshift(event);
    store.daemonEvents = store.daemonEvents.slice(0, MAX_DAEMON_EVENT_LOG);
    addSystemEvent(type, message, meta);
    return event;
  }

  function publicUrlFromRequest(req) {
    const proto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim()
      || (req.socket?.encrypted ? 'https' : 'http');
    const forwardedHost = String(req.headers?.['x-forwarded-host'] || '').split(',')[0].trim();
    const requestHost = forwardedHost || req.headers?.host || `${host}:${port}`;
    return process.env.MAGCLAW_PUBLIC_URL || `${proto}://${requestHost}`;
  }

  function connectCommand(pairToken, req) {
    const publicUrl = publicUrlFromRequest(req);
    const workspace = typeof cloudAuth.primaryWorkspace === 'function'
      ? cloudAuth.primaryWorkspace()
      : (cloud().workspaces[0] || {});
    const profile = String(workspace.slug || workspace.id || 'local').trim() || 'local';
    const comment = String(workspace.name || workspace.slug || workspace.id || 'local').trim() || profile;
    const template = process.env.MAGCLAW_DAEMON_CONNECT_COMMAND || '';
    if (template) {
      return template
        .replaceAll('{serverUrl}', publicUrl)
        .replaceAll('{pairToken}', pairToken)
        .replaceAll('{profile}', profile)
        .replaceAll('{serverName}', comment);
    }
    return [
      'npx -y @magclaw/daemon@latest connect',
      `--server-url ${shellArg(publicUrl)}`,
      `--pair-token ${shellArg(pairToken)}`,
      `--profile ${shellArg(profile)}`,
      '--background',
      `# ${comment}`,
    ].join(' ');
  }

  function createPairingToken(body = {}, req) {
    const store = cloud();
    const workspace = typeof cloudAuth.primaryWorkspace === 'function'
      ? cloudAuth.primaryWorkspace()
      : store.workspaces[0];
    const raw = cloudAuth.token('mc_pair');
    const createdAt = now();
    const expiresAt = new Date(Date.now() + Number(body.ttlMs || PAIR_TTL_MS)).toISOString();
    const computerName = String(body.name || body.label || os.hostname()).trim();
    let computer = null;
    if (body.computerId) computer = findComputer(String(body.computerId));
    if (!computer) {
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
        createdBy: body.createdBy || null,
        createdAt,
        updatedAt: createdAt,
      };
      state.computers.push(computer);
    }
    const pair = {
      id: makeId('pair'),
      workspaceId: workspace.id,
      computerId: computer.id,
      label: String(body.label || computer.name || 'Computer pairing').trim(),
      tokenHash: cloudAuth.sha256(raw),
      createdAt,
      expiresAt,
      consumedAt: null,
      revokedAt: null,
      createdBy: body.createdBy || null,
    };
    store.pairingTokens.push(pair);
    const command = connectCommand(raw, req);
    return {
      computer,
      pairingToken: publicPairingToken(pair),
      pairToken: raw,
      command,
      wsUrl: `${toWsUrl(publicUrlFromRequest(req))}/daemon/connect?pair_token=${encodeURIComponent(raw)}`,
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
    persistState().catch(() => {});
    return {
      type: 'daemon',
      workspaceId: tokenRecord.workspaceId || computer.workspaceId || null,
      computerId: computer.id,
      tokenId: tokenRecord.id,
    };
  }

  function issueMachineToken(computer, pair) {
    const raw = cloudAuth.token('mc_machine');
    const createdAt = now();
    const record = {
      id: makeId('ctok'),
      workspaceId: pair.workspaceId,
      computerId: computer.id,
      label: pair.label || computer.name || 'daemon token',
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

  function computerIsDisabled(computer) {
    return String(computer?.status || '').toLowerCase() === 'disabled' || Boolean(computer?.disabledAt);
  }

  function markComputerDisconnected(connection) {
    if (!connection?.computerId) return;
    if (connection.disconnected) return;
    connection.disconnected = true;
    if (connections.get(connection.computerId) === connection) connections.delete(connection.computerId);
    const computer = findComputer(connection.computerId);
    if (computer) {
      if (!computerIsDisabled(computer)) computer.status = 'offline';
      computer.disconnectedAt = now();
      computer.updatedAt = now();
    }
    recordDaemonEvent('computer_disconnected', `Computer disconnected: ${computer?.name || connection.computerId}`, {
      computerId: connection.computerId,
    });
    persistState().then(broadcastState).catch(() => {});
  }

  function adoptConnection(connection, computer, tokenRecord) {
    const previous = connections.get(computer.id);
    if (previous && previous !== connection) {
      previous.disconnected = true;
      previous.socket.end();
    }
    connection.computerId = computer.id;
    connection.workspaceId = tokenRecord.workspaceId || computer.workspaceId || cloud().workspaces[0]?.id;
    connection.tokenId = tokenRecord.id;
    connections.set(computer.id, connection);
    if (!computerIsDisabled(computer)) computer.status = 'connected';
    computer.connectedVia = 'daemon';
    computer.lastSeenAt = now();
    computer.daemonConnectedAt = now();
    computer.updatedAt = now();
    tokenRecord.lastUsedAt = now();
  }

  async function replayQueued(computerId) {
    const pending = safeArray(cloud().agentDeliveries)
      .filter((delivery) => delivery.computerId === computerId && ['queued', 'sent'].includes(delivery.status))
      .sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0));
    for (const delivery of pending) {
      sendDelivery(delivery);
    }
    if (pending.length) await persistState();
  }

  function nextDeliverySeq(agentId, computerId) {
    return safeArray(cloud().agentDeliveries)
      .filter((delivery) => delivery.agentId === agentId && delivery.computerId === computerId)
      .reduce((max, delivery) => Math.max(max, Number(delivery.seq || 0)), 0) + 1;
  }

  function sendDelivery(delivery) {
    const ok = sendToComputer(delivery.computerId, {
      type: delivery.commandType || delivery.type,
      commandId: delivery.id,
      seq: delivery.seq,
      agentId: delivery.agentId,
      workspaceId: delivery.workspaceId,
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
    const delivery = {
      id: makeId('adl'),
      workspaceId: workspace.id,
      agentId: agent.id,
      computerId: computer.id,
      messageId: payload.message?.id || payload.messageId || null,
      workItemId: payload.workItem?.id || payload.workItemId || null,
      seq: nextDeliverySeq(agent.id, computer.id),
      type: commandType,
      commandType,
      status: 'queued',
      attempts: 0,
      payload,
      createdAt: now(),
      updatedAt: now(),
      sentAt: null,
      ackedAt: null,
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
        runtime: agent.runtime,
        model: agent.model,
        reasoningEffort: agent.reasoningEffort || null,
        workspace: agent.workspace || null,
        envVars: safeArray(agent.envVars),
      },
      reason: options.reason || 'manual',
    });
    if (result.queued) {
      setAgentStatus(agent, result.sent ? 'starting' : 'waiting_for_computer', 'daemon_relay_start', { forceEvent: true });
      await persistState();
      broadcastState();
    }
    return result;
  }

  async function deliverToAgent(agent, deliveryMessage, workItem = null) {
    const result = queueAgentCommand(agent, 'agent:deliver', {
      agent: {
        id: agent.id,
        name: agent.name,
        runtime: agent.runtime,
        model: agent.model,
        reasoningEffort: agent.reasoningEffort || null,
        workspace: agent.workspace || null,
        envVars: safeArray(agent.envVars),
      },
      message: deliveryMessage,
      workItem,
    });
    if (!result.queued) return false;
    if (workItem) {
      workItem.status = result.sent ? 'sent_remote' : 'queued_remote';
      workItem.updatedAt = now();
    }
    setAgentStatus(agent, result.sent ? 'queued' : 'waiting_for_computer', 'daemon_relay_delivery', { forceEvent: true });
    await persistState();
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
    await persistState();
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
      await persistState();
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
    await persistState();
    broadcastState();
  }

  async function handleAck(connection, message) {
    const id = String(message.commandId || message.deliveryId || '');
    const delivery = safeArray(cloud().agentDeliveries).find((item) => item.id === id);
    if (delivery) {
      delivery.status = 'acked';
      delivery.ackedAt = now();
      delivery.updatedAt = now();
      delivery.error = '';
    }
    const agent = delivery ? findAgent(delivery.agentId) : findAgent(message.agentId);
    if (agent && message.status) setAgentStatus(agent, String(message.status), 'daemon_relay_ack');
    await persistState();
    broadcastState();
  }

  async function handleAgentStatus(message) {
    const agent = findAgent(message.agentId);
    if (!agent) return;
    setAgentStatus(agent, String(message.status || 'idle'), 'daemon_status', { forceEvent: true });
    if (message.sessionId !== undefined) agent.runtimeSessionId = message.sessionId || null;
    agent.runtimeActivity = message.activity || agent.runtimeActivity || null;
    agent.heartbeatAt = now();
    await persistState();
    broadcastState();
  }

  async function handleAgentActivity(message) {
    const agent = findAgent(message.agentId);
    if (!agent) return;
    if (message.status) setAgentStatus(agent, String(message.status), 'daemon_activity', { forceEvent: true });
    agent.runtimeActivity = message.activity || agent.runtimeActivity || null;
    agent.heartbeatAt = now();
    await persistState();
    broadcastState();
  }

  async function handleAgentMessage(message) {
    const agent = findAgent(message.agentId);
    if (!agent) return;
    const payload = message.payload || message;
    if (handlers.onAgentMessage) {
      await handlers.onAgentMessage({
        agent,
        body: String(payload.body || payload.content || ''),
        spaceType: payload.spaceType || payload.message?.spaceType || 'channel',
        spaceId: payload.spaceId || payload.message?.spaceId || 'chan_all',
        parentMessageId: payload.parentMessageId || payload.message?.parentMessageId || null,
        sourceMessage: payload.sourceMessage || payload.message || null,
        attachments: safeArray(payload.attachmentIds),
      });
    } else {
      state.messages.push(normalizeConversationRecord({
        id: makeId('msg'),
        spaceType: payload.spaceType || 'channel',
        spaceId: payload.spaceId || 'chan_all',
        authorType: 'agent',
        authorId: agent.id,
        body: String(payload.body || payload.content || ''),
        attachmentIds: safeArray(payload.attachmentIds),
        replyCount: 0,
        savedBy: [],
        createdAt: now(),
        updatedAt: now(),
      }));
      await persistState();
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
    const computer = findComputer(connection.computerId);
    if (computer) computer.lastSeenAt = now();
    switch (message.type) {
      case 'ready':
        await handleReady(connection, message);
        break;
      case 'pong':
        if (computer) {
          computer.lastSeenAt = now();
          await persistState();
        }
        break;
      case 'agent:start:ack':
      case 'agent:deliver:ack':
      case 'agent:ack':
        await handleAck(connection, message);
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
      case 'machine:runtime_models:result':
        recordDaemonEvent('daemon_result', `Daemon returned ${message.type}.`, {
          computerId: connection.computerId,
          agentId: message.agentId || null,
          commandId: message.commandId || null,
          resultType: message.type,
        });
        await persistState();
        broadcastState();
        break;
      case 'agent:error':
        {
          const agent = findAgent(message.agentId);
          if (agent) {
            setAgentStatus(agent, 'error', 'daemon_error', { forceEvent: true });
            agent.runtimeActivity = {
              source: '@magclaw/daemon',
              error: String(message.error || 'Agent error'),
              at: now(),
            };
            agent.heartbeatAt = now();
          }
        }
        recordDaemonEvent('agent_error', String(message.error || 'Agent error'), {
          agentId: message.agentId || null,
          computerId: connection.computerId,
        });
        await persistState();
        broadcastState();
        break;
      default:
        send(connection, { type: 'error', error: `Unsupported daemon event: ${message.type || 'unknown'}` });
        break;
    }
  }

  async function authenticateConnection(req, url) {
    const rawPair = String(url.searchParams.get('pair_token') || url.searchParams.get('pairToken') || '').trim();
    const rawToken = String(url.searchParams.get('token') || url.searchParams.get('key') || '').trim();
    if (rawPair) {
      const pair = validatePairToken(rawPair);
      if (!pair) return { error: 'Invalid or expired pair token.' };
      const computer = findComputer(pair.computerId);
      if (!computer) return { error: 'Paired computer was not found.' };
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
    const key = String(req.headers['sec-websocket-key'] || '');
    if (!key) {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return true;
    }
    const auth = await authenticateConnection(req, url);
    if (auth.error) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\n\r\n');
      socket.end(auth.error);
      return true;
    }

    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${websocketAcceptKey(key)}`,
      '\r\n',
    ].join('\r\n'));

    const connection = {
      id: makeId('ws'),
      socket,
      buffer: Buffer.alloc(0),
      closed: false,
      computerId: null,
      workspaceId: null,
      tokenId: null,
      lastSeenAt: now(),
    };
    adoptConnection(connection, auth.computer, auth.tokenRecord);
    send(connection, auth.welcome);
    recordDaemonEvent('computer_connected', `Computer connected: ${auth.computer.name}`, {
      computerId: auth.computer.id,
    });
    await persistState();
    broadcastState();

    socket.on('data', (chunk) => {
      for (const frame of decodeFrames(connection, chunk)) {
        if (frame.opcode === 0x8) {
          connection.closed = true;
          socket.end();
          return;
        }
        if (frame.opcode === 0x9) {
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
    socket.on('error', () => markComputerDisconnected(connection));
    return true;
  }

  function setHandlers(nextHandlers = {}) {
    Object.assign(handlers, nextHandlers);
  }

  function publicRelayState() {
    return {
      onlineComputerIds: [...connections.keys()].filter((computerId) => !computerIsDisabled(findComputer(computerId))),
      daemonEvents: safeArray(cloud().daemonEvents).slice(0, 50),
    };
  }

  function disconnectComputer(computerId, reason = 'Computer disconnected.') {
    const connection = connections.get(computerId);
    if (!connection) return false;
    send(connection, { type: 'error', error: reason });
    connection.socket.end();
    return true;
  }

  return {
    agentShouldUseRelay,
    authenticateHttpRequest,
    createPairingToken,
    deliverToAgent,
    disconnectComputer,
    handleUpgrade,
    publicRelayState,
    revokeComputerToken,
    setHandlers,
    startAgent,
  };
}
