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
  const connections = new Map();
  const wss = new WebSocketServer({ noServer: true, clientTracking: false });
  let onResult = async () => {};
  let draining = false;

  function connectionFor(relayId) {
    const connection = connections.get(String(relayId || '').trim());
    return connection?.socket?.readyState === WebSocket.OPEN ? connection : null;
  }

  async function handleMessage(connection, raw) {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    connection.lastSeenAt = now();
    if (message.type === 'notify:pong' || message.type === 'notify:daemon:ready' || message.type === 'notify:deliver:ack') return;
    if (message.type !== 'notify:result') return;
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
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return true;
    }
    const rawToken = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1] || '';
    const token = notifyTokenForRaw(getState(), rawToken, 'notify:daemon', {
      headers: { 'x-magclaw-machine-fingerprint': req.headers['x-magclaw-machine-fingerprint'] || '' },
    });
    if (!token?.relayId) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return true;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const previous = connections.get(token.relayId);
      if (previous?.socket?.readyState === WebSocket.OPEN) previous.socket.close(4000, 'Replaced by a newer Notify Daemon connection');
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
      persistState({ workspaceId: token.workspaceId || '', reason: 'notify_daemon_connected' }).catch(() => {});
      ws.on('message', (raw) => handleMessage(connection, raw).catch((error) => {
        console.warn(`[notify-relay] message failed relay=${clean(connection.relayId)} error=${clean(error.message)}`);
      }));
      ws.on('close', () => {
        if (connections.get(connection.relayId) === connection) connections.delete(connection.relayId);
      });
      ws.on('error', (error) => {
        console.warn(`[notify-relay] socket error relay=${clean(connection.relayId)} error=${clean(error.message)}`);
      });
      ws.send(JSON.stringify({ type: 'notify:connected', relayId: token.relayId, connectedAt: connection.connectedAt }));
    });
    return true;
  }

  async function deliverNotifyRequest(request) {
    const connection = connectionFor(request?.relayId);
    if (!connection) return { queued: false, reason: 'notify_daemon_offline' };
    const id = commandId();
    connection.socket.send(JSON.stringify({ type: 'notify:deliver', commandId: id, request }));
    return { queued: true, delivery: { id, queuedAt: now() } };
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
    for (const connection of connections.values()) connection.socket.close(1001, 'Notify Relay draining');
    connections.clear();
  }

  const heartbeat = setInterval(() => {
    for (const connection of connections.values()) {
      if (connection.socket.readyState === WebSocket.OPEN) connection.socket.send(JSON.stringify({ type: 'notify:ping', at: now() }));
    }
  }, 25_000);
  heartbeat.unref?.();

  return { beginDrain, deliverNotifyRequest, handleUpgrade, setResultHandler, status };
}
