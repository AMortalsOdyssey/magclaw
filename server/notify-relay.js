import crypto from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { notifyTokenForRaw } from './notify.js';

function clean(value = '', max = 500) {
  return String(value || '').replace(/[\r\n\u0000]+/g, ' ').trim().slice(0, max);
}

function commandId() {
  return `ndl_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`;
}

export function createNotifyRelay(options = {}) {
  const getState = options.getState || (() => ({}));
  const now = options.now || (() => new Date().toISOString());
  const persistState = options.persistState || (async () => {});
  const audit = typeof options.audit === 'function' ? options.audit : async () => {};
  const connections = new Map();
  const pendingAcks = new Map();
  const wss = new WebSocketServer({ noServer: true, clientTracking: false });
  let onResult = async () => {};
  let draining = false;

  async function record(event, details = {}) {
    try { await audit({ event, ...details }); } catch (error) {
      console.warn(`[notify-audit] relay event failed event=${clean(event)} error=${clean(error.message)}`);
    }
  }

  function connectionFor(relayId) {
    const connection = connections.get(String(relayId || '').trim());
    return connection?.socket?.readyState === WebSocket.OPEN ? connection : null;
  }

  async function handleMessage(connection, raw) {
    let message;
    try { message = JSON.parse(String(raw)); } catch {
      await record('relay.websocket.message_rejected', { outcome: 'invalid_json', relayId: connection.relayId, severity: 'warning' });
      return;
    }
    connection.lastSeenAt = now();
    if (message.type === 'notify:deliver:ack' || message.type === 'notify:targets:result') {
      const pending = pendingAcks.get(String(message.commandId || ''));
      if (!pending || pending.connection !== connection) return;
      clearTimeout(pending.timer);
      pendingAcks.delete(String(message.commandId || ''));
      await record('relay.command.acknowledged', {
        outcome: 'acknowledged', relayId: connection.relayId, commandId: message.commandId,
        requestId: pending.requestId || '', metadata: { commandType: pending.commandType || message.type },
      });
      pending.resolve(message);
      return;
    }
    if (message.type === 'notify:pong' || message.type === 'notify:daemon:ready') return;
    if (message.type !== 'notify:result') return;
    await record('relay.delivery.result_received', {
      outcome: message.status || 'received', relayId: connection.relayId, requestId: message.requestId,
      metadata: { resultStatus: message.status || '' },
    });
    await onResult({
      ...message,
      relayId: connection.relayId,
      daemonTokenId: connection.tokenId,
    });
  }

  async function handleUpgrade(req, socket, head = Buffer.alloc(0)) {
    const url = new URL(req.url || '/', 'http://notify-relay.local');
    if (url.pathname !== '/notify/connect') return false;
    if (draining) {
      await record('relay.websocket.connection_rejected', { outcome: 'draining', networkAddress: req.socket?.remoteAddress || '', userAgent: req.headers['user-agent'] || '' });
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return true;
    }
    const rawToken = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1] || '';
    const token = notifyTokenForRaw(getState(), rawToken, 'notify:daemon', {
      headers: { 'x-magclaw-machine-fingerprint': req.headers['x-magclaw-machine-fingerprint'] || '' },
    });
    if (!token?.relayId) {
      await record('relay.websocket.connection_rejected', { outcome: 'unauthorized', severity: 'warning', networkAddress: req.socket?.remoteAddress || '', userAgent: req.headers['user-agent'] || '' });
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return true;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const previous = connections.get(token.relayId);
      if (previous?.socket?.readyState === WebSocket.OPEN) {
        void record('relay.websocket.connection_replaced', { outcome: 'replaced', relayId: token.relayId, workspaceId: token.workspaceId || '' });
        previous.socket.close(4000, 'Replaced by a newer Notify Daemon connection');
      }
      const connection = {
        relayId: token.relayId,
        tokenId: token.id,
        socket: ws,
        connectedAt: now(),
        lastSeenAt: now(),
      };
      connections.set(token.relayId, connection);
      token.lastUsedAt = now();
      token.updatedAt = now();
      void record('relay.websocket.connected', {
        outcome: 'connected', relayId: token.relayId, workspaceId: token.workspaceId || '',
        networkAddress: req.socket?.remoteAddress || '', userAgent: req.headers['user-agent'] || '',
      });
      persistState({ workspaceId: token.workspaceId || '', reason: 'notify_daemon_connected' }).catch(() => {});
      ws.on('message', (raw) => handleMessage(connection, raw).catch((error) => {
        console.warn(`[notify-relay] message failed relay=${clean(connection.relayId)} error=${clean(error.message)}`);
      }));
      ws.on('close', () => {
        if (connections.get(connection.relayId) === connection) connections.delete(connection.relayId);
        for (const [id, pending] of pendingAcks) {
          if (pending.connection !== connection) continue;
          clearTimeout(pending.timer);
          pendingAcks.delete(id);
          pending.resolve(null);
        }
        void record('relay.websocket.disconnected', { outcome: 'disconnected', relayId: connection.relayId });
      });
      ws.on('error', (error) => {
        console.warn(`[notify-relay] socket error relay=${clean(connection.relayId)} error=${clean(error.message)}`);
        void record('relay.websocket.error', { outcome: 'failed', severity: 'error', relayId: connection.relayId, metadata: { error: clean(error.message) } });
      });
      ws.send(JSON.stringify({ type: 'notify:connected', relayId: token.relayId, connectedAt: connection.connectedAt }));
    });
    return true;
  }

  async function deliverNotifyRequest(request) {
    const connection = connectionFor(request?.relayId);
    if (!connection) {
      await record('relay.delivery.dispatch_completed', { outcome: 'daemon_offline', relayId: request?.relayId, requestId: request?.id });
      return { queued: false, reason: 'notify_daemon_offline' };
    }
    const id = commandId();
    const queuedAt = now();
    await record('relay.delivery.dispatch_started', { outcome: 'started', relayId: request.relayId, requestId: request.id, commandId: id });
    const ack = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingAcks.delete(id);
        resolve(null);
      }, Math.max(250, Number(options.ackTimeoutMs || 5_000)));
      pendingAcks.set(id, { connection, resolve, timer, requestId: request.id, commandType: 'notify:deliver' });
      connection.socket.send(JSON.stringify({ type: 'notify:deliver', commandId: id, request }), (error) => {
        if (!error) return;
        const pending = pendingAcks.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingAcks.delete(id);
        resolve(null);
      });
    });
    await record('relay.delivery.dispatch_completed', {
      outcome: ack ? 'acknowledged' : 'ack_timeout', severity: ack ? 'info' : 'warning',
      relayId: request.relayId, requestId: request.id, commandId: id,
    });
    return { queued: true, acknowledged: Boolean(ack), ack, delivery: { id, queuedAt } };
  }

  async function listNotifyTargets(relayId, requester) {
    const connection = connectionFor(relayId);
    if (!connection) {
      await record('relay.targets.query_completed', { outcome: 'daemon_offline', relayId });
      return { available: false, reason: 'notify_daemon_offline', targets: [] };
    }
    const id = commandId();
    await record('relay.targets.query_started', { outcome: 'started', relayId, commandId: id });
    const response = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        pendingAcks.delete(id);
        resolve(null);
      }, Math.max(250, Number(options.ackTimeoutMs || 5_000)));
      pendingAcks.set(id, { connection, resolve, timer, commandType: 'notify:targets:list' });
      connection.socket.send(JSON.stringify({ type: 'notify:targets:list', commandId: id, requester }), (error) => {
        if (!error) return;
        const pending = pendingAcks.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        pendingAcks.delete(id);
        resolve(null);
      });
    });
    const result = response
      ? { available: true, targets: Array.isArray(response.targets) ? response.targets : [] }
      : { available: false, reason: 'notify_daemon_ack_timeout', targets: [] };
    await record('relay.targets.query_completed', {
      outcome: response ? 'acknowledged' : 'ack_timeout', severity: response ? 'info' : 'warning', relayId, commandId: id,
      metadata: { targetCount: result.targets.length },
    });
    return result;
  }

  function setResultHandler(handler) {
    onResult = typeof handler === 'function' ? handler : async () => {};
  }

  function status(relayId = '') {
    if (relayId) {
      const connection = connectionFor(relayId);
      return { connected: Boolean(connection), connectedAt: connection?.connectedAt || null, lastSeenAt: connection?.lastSeenAt || null };
    }
    return { connections: connections.size, draining };
  }

  function beginDrain() {
    draining = true;
    void record('relay.lifecycle.draining', { outcome: 'started', metadata: { connectionCount: connections.size } });
    for (const connection of connections.values()) connection.socket.close(1001, 'Notify Relay draining');
    connections.clear();
    for (const [id, pending] of pendingAcks) {
      clearTimeout(pending.timer);
      pendingAcks.delete(id);
      pending.resolve(null);
    }
  }

  const heartbeat = setInterval(() => {
    for (const connection of connections.values()) {
      if (connection.socket.readyState === WebSocket.OPEN) connection.socket.send(JSON.stringify({ type: 'notify:ping', at: now() }));
    }
  }, 25_000);
  heartbeat.unref?.();

  return { beginDrain, deliverNotifyRequest, handleUpgrade, listNotifyTargets, setResultHandler, status };
}
