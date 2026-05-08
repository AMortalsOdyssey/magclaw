import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = path.resolve(new URL('..', import.meta.url).pathname);
const DAEMON_BIN = path.join(ROOT, 'daemon', 'bin', 'magclaw-daemon.js');

function websocketAcceptKey(key) {
  return crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
}

function encodeServerFrame(payload) {
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

function decodeClientFrames(connection, chunk) {
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

function waitFor(fn, timeoutMs = 30000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const value = await fn();
        if (value) {
          resolve(value);
          return;
        }
        if (Date.now() - started > timeoutMs) {
          reject(new Error('timed out waiting for condition'));
          return;
        }
        setTimeout(tick, 60);
      } catch (error) {
        reject(error);
      }
    };
    tick();
  });
}

async function startRelay() {
  const messages = [];
  const sockets = new Set();
  let activeSocket = null;
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    assert.equal(url.pathname, '/daemon/connect');
    assert.equal(url.searchParams.get('pair_token'), 'mc_pair_test');
    const key = String(req.headers['sec-websocket-key'] || '');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${websocketAcceptKey(key)}`,
      '\r\n',
    ].join('\r\n'));
    activeSocket = socket;
    sockets.add(socket);
    const connection = { buffer: Buffer.alloc(0) };
    socket.write(encodeServerFrame({
      type: 'pairing:accepted',
      computerId: 'cmp_remote_test',
      workspaceId: 'wsp_test',
      machineToken: 'mc_machine_test',
    }));
    socket.on('data', (chunk) => {
      for (const frame of decodeClientFrames(connection, chunk)) {
        if (frame.opcode !== 0x1) continue;
        const message = JSON.parse(frame.text);
        messages.push(message);
        if (message.type === 'ready') {
          socket.write(encodeServerFrame({ type: 'ready:ack', computerId: 'cmp_remote_test' }));
          socket.write(encodeServerFrame({
            type: 'agent:deliver',
            commandId: 'adl_test',
            seq: 1,
            agentId: 'agt_remote',
            workspaceId: 'wsp_test',
            payload: {
              agent: {
                id: 'agt_remote',
                name: 'Remote Codex',
                runtime: 'codex',
                model: 'gpt-test',
                reasoningEffort: 'low',
              },
              message: {
                id: 'msg_test',
                body: 'hello from cloud',
                spaceType: 'channel',
                spaceId: 'chan_all',
                parentMessageId: null,
                workItemId: 'wi_test',
              },
              workItem: { id: 'wi_test' },
            },
          }));
        }
      }
    });
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    messages,
    send(payload) {
      activeSocket?.write(encodeServerFrame(payload));
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test('npm daemon pairs, starts fake Codex app-server, and returns an agent message', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-daemon-relay-'));
  const fakeCodex = path.join(tmp, 'codex-fake.js');
  const logPath = path.join(tmp, 'codex-log.jsonl');
  await writeFile(fakeCodex, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const logPath = process.env.FAKE_CODEX_LOG;
function log(value) {
  if (logPath) fs.appendFileSync(logPath, JSON.stringify(value) + '\\n');
}
function send(value) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
}
if (args[0] === '--version') {
  console.log('codex-cli fake-daemon-test');
  process.exit(0);
}
if (args[0] === 'app-server' && args[1] === '--help') {
  console.log('Usage: codex app-server --listen stdio://');
  process.exit(0);
}
if (args[0] !== 'app-server') process.exit(2);
log({ mode: 'app-server', args, env: { CODEX_HOME: process.env.CODEX_HOME, MAGCLAW_SERVER_URL: process.env.MAGCLAW_SERVER_URL } });
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  const lines = buffer.split(/\\r?\\n/);
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    log({ method: message.method, params: message.params });
    if (message.method === 'initialize') {
      send({ id: message.id, result: {} });
    } else if (message.method === 'thread/start') {
      send({ id: message.id, result: { thread: { id: 'thread_remote_fake' } } });
    } else if (message.method === 'turn/start' || message.method === 'turn/steer') {
      send({ id: message.id, result: { turn: { id: 'turn_remote_fake' } } });
      send({ method: 'turn/started', params: { turn: { id: 'turn_remote_fake' } } });
      send({ method: 'item/agentMessage/delta', params: { itemId: 'item_remote_fake', delta: 'remote fake response' } });
      send({ method: 'turn/completed', params: { turn: { id: 'turn_remote_fake', status: 'completed' } } });
    }
  }
});
`);
  await chmod(fakeCodex, 0o755);
  const relay = await startRelay();
  const daemon = spawn(process.execPath, [
    DAEMON_BIN,
    'connect',
    '--server-url',
    relay.baseUrl,
    '--pair-token',
    'mc_pair_test',
    '--profile',
    'cloud-test',
  ], {
    env: {
      ...process.env,
      MAGCLAW_DAEMON_HOME: path.join(tmp, 'daemon-home'),
      CODEX_PATH: fakeCodex,
      FAKE_CODEX_LOG: logPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    const message = await waitFor(() => relay.messages.find((item) => item.type === 'agent:message'));
    assert.equal(message.agentId, 'agt_remote');
    assert.equal(message.payload.body, 'remote fake response');
    assert.equal(message.payload.spaceType, 'channel');
    assert.equal(message.payload.spaceId, 'chan_all');
    assert.ok(relay.messages.some((item) => item.type === 'agent:deliver:ack' && item.commandId === 'adl_test'));
    assert.ok(relay.messages.some((item) => item.type === 'agent:session' && item.sessionId === 'thread_remote_fake'));

    const saved = JSON.parse(await readFile(path.join(tmp, 'daemon-home', 'profiles', 'cloud-test', 'config.json'), 'utf8'));
    assert.equal(saved.token, 'mc_machine_test');
    assert.equal(saved.pairToken, '');
    const duplicate = spawn(process.execPath, [
      DAEMON_BIN,
      'connect',
      '--server-url',
      relay.baseUrl,
      '--pair-token',
      'mc_pair_test',
      '--profile',
      'cloud-test',
    ], {
      env: {
        ...process.env,
        MAGCLAW_DAEMON_HOME: path.join(tmp, 'daemon-home'),
        CODEX_PATH: fakeCodex,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let duplicateOutput = '';
    duplicate.stdout.on('data', (chunk) => { duplicateOutput += chunk.toString(); });
    duplicate.stderr.on('data', (chunk) => { duplicateOutput += chunk.toString(); });
    const duplicateCode = await new Promise((resolve) => duplicate.once('exit', resolve));
    assert.equal(duplicateCode, 1);
    assert.match(duplicateOutput, /already running/);
    const entries = (await readFile(logPath, 'utf8')).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const appServer = entries.find((entry) => entry.mode === 'app-server');
    assert.match(appServer.env.CODEX_HOME, /daemon-home\/profiles\/cloud-test\/agents\/agt_remote\/codex-home$/);
    assert.ok(appServer.args.some((arg) => String(arg).includes('mcp_servers.magclaw.args')));
    assert.equal(appServer.args.some((arg) => String(arg).includes('mc_machine_test')), false);
    assert.ok(entries.some((entry) => entry.method === 'turn/start'));
  } finally {
    daemon.kill('SIGINT');
    await Promise.race([
      new Promise((resolve) => daemon.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 500)),
    ]);
    await relay.close();
    await rm(tmp, { recursive: true, force: true });
  }
});
