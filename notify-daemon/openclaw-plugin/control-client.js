import { createHash } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const CONTROL_TIMEOUT_MS = 10_000;

export function notifyPluginHome(configuredHome) {
  const raw = String(configuredHome || '').trim();
  return raw ? path.resolve(raw) : path.join(os.homedir(), '.magclaw', 'notify');
}

/** Mirrors notifyControlSocketPath in the Daemon so both sides agree on the path. */
export function notifyControlSocketPath(home, instance = 'default') {
  const root = instance === 'default'
    ? path.join(home, 'daemon')
    : path.join(home, 'daemons', instance);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\magclaw-notify-${createHash('sha256').update(root).digest('hex').slice(0, 20)}`;
  }
  const local = path.join(root, 'run', 'control.sock');
  if (Buffer.byteLength(local) <= 96) return local;
  return path.join(os.tmpdir(), `magclaw-notify-${process.getuid?.() ?? 'user'}`, `${createHash('sha256').update(root).digest('hex').slice(0, 24)}.sock`);
}

/** Submits one already-validated decision to the owner Daemon control socket. */
export function submitNotifyDecision(socketPath, request, options = {}) {
  const timeoutMs = Number(options.timeoutMs || CONTROL_TIMEOUT_MS);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let response = '';
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.setEncoding('utf8');
    socket.setTimeout(timeoutMs, () => fail(new Error('Notify Daemon control request timed out.')));
    socket.once('error', (error) => fail(new Error(`Notify Daemon control socket unavailable: ${error.message}`)));
    socket.once('connect', () => socket.end(`${JSON.stringify(request)}\n`));
    socket.on('data', (chunk) => { response += chunk; });
    socket.once('close', () => {
      if (settled) return;
      settled = true;
      try {
        const parsed = JSON.parse(response.trim() || '{}');
        if (!parsed.ok) reject(new Error(parsed.error || 'Notify Daemon rejected the decision.'));
        else resolve(parsed.result || {});
      } catch (error) {
        reject(error);
      }
    });
  });
}
