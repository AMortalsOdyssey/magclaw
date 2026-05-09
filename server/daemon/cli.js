#!/usr/bin/env node
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function readDaemonVersion() {
  try {
    const packageUrl = new URL('../../daemon/package.json', import.meta.url);
    const pkg = JSON.parse(readFileSync(packageUrl, 'utf8'));
    return String(pkg.version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

const DAEMON_VERSION = readDaemonVersion();

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2).replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      index += 1;
    }
  }
  return args;
}

function configPath(args) {
  return path.resolve(args.config || path.join(os.homedir(), '.magclaw', 'daemon.json'));
}

async function readConfig(args) {
  const file = configPath(args);
  if (!existsSync(file)) return {};
  return JSON.parse(await readFile(file, 'utf8'));
}

async function saveConfig(args, config) {
  const file = configPath(args);
  await mkdir(path.dirname(file), { recursive: true });
  const safeConfig = {
    serverUrl: config.serverUrl,
    workspace: config.workspace || config.workspaceId || 'local',
    workspaceId: config.workspaceId || config.workspace || 'local',
    computerId: config.computerId || null,
    token: config.token,
    name: config.name || os.hostname(),
  };
  await writeFile(file, `${JSON.stringify(safeConfig, null, 2)}\n`);
}

function wsUrl(serverUrl, args) {
  const base = String(serverUrl || '').replace(/\/+$/, '');
  const wsBase = base.startsWith('https://')
    ? `wss://${base.slice('https://'.length)}`
    : base.startsWith('http://')
      ? `ws://${base.slice('http://'.length)}`
      : base;
  const url = new URL(`${wsBase}/daemon/connect`);
  if (args.pairToken) url.searchParams.set('pair_token', args.pairToken);
  else url.searchParams.set('token', args.token);
  if (args.workspace) url.searchParams.set('workspace', args.workspace);
  return url;
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
    header[1] = 0x80 | length;
  } else if (length < 65536) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const mask = crypto.randomBytes(4);
  const masked = Buffer.from(data);
  for (let index = 0; index < masked.length; index += 1) {
    masked[index] ^= mask[index % 4];
  }
  return Buffer.concat([header, mask, masked]);
}

function decodeFrames(connection, chunk) {
  connection.buffer = Buffer.concat([connection.buffer, chunk]);
  const frames = [];
  while (connection.buffer.length >= 2) {
    const first = connection.buffer[0];
    const second = connection.buffer[1];
    const opcode = first & 0x0f;
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
    if (connection.buffer.length < offset + length) break;
    const payload = connection.buffer.subarray(offset, offset + length);
    connection.buffer = connection.buffer.subarray(offset + length);
    frames.push({ opcode, text: payload.toString('utf8') });
  }
  return frames;
}

function send(socket, payload) {
  socket.write(encodeFrame(payload));
}

async function detectRuntimes() {
  const runtimes = [];
  for (const [id, command] of [['codex', 'codex'], ['claude-code', 'claude'], ['gemini', 'gemini']]) {
    runtimes.push({ id, name: command, installed: true });
  }
  return runtimes;
}

async function readyPayload(config) {
  const runtimes = await detectRuntimes();
  return {
    type: 'ready',
    computerId: config.computerId || null,
    workspaceId: config.workspaceId || 'local',
    name: config.name || os.hostname(),
    hostname: os.hostname(),
    os: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    daemonVersion: DAEMON_VERSION,
    runtimes: runtimes.map((runtime) => runtime.id),
    runningAgents: [],
    capabilities: [
      'agent:start',
      'agent:deliver',
      'agent:stop',
      'agent:skills:list',
      'machine:runtime_models:detect',
    ],
  };
}

async function handleCommand(socket, message, config) {
  switch (message.type) {
    case 'pairing:accepted':
      config.computerId = message.computerId;
      config.workspaceId = message.workspaceId || config.workspaceId || 'local';
      config.token = message.machineToken;
      await saveConfig(config.args, config);
      console.log(`Paired computer ${message.computerId}. Machine token saved to ${configPath(config.args)}.`);
      send(socket, await readyPayload(config));
      break;
    case 'connected':
      config.computerId = message.computerId || config.computerId;
      config.workspaceId = message.workspaceId || config.workspaceId;
      send(socket, await readyPayload(config));
      break;
    case 'ping':
      send(socket, { type: 'pong', time: new Date().toISOString() });
      break;
    case 'agent:start':
      send(socket, {
        type: 'agent:start:ack',
        commandId: message.commandId,
        agentId: message.agentId,
        status: 'idle',
      });
      send(socket, {
        type: 'agent:status',
        agentId: message.agentId,
        status: 'idle',
        activity: { source: 'magclaw-daemon', note: 'start command accepted' },
      });
      break;
    case 'agent:deliver':
      send(socket, {
        type: 'agent:deliver:ack',
        commandId: message.commandId,
        agentId: message.agentId,
        status: 'idle',
      });
      break;
    case 'agent:skills:list':
      send(socket, {
        type: 'agent:skills:list_result',
        commandId: message.commandId,
        agentId: message.agentId,
        skills: [],
      });
      break;
    case 'machine:runtime_models:detect':
      send(socket, {
        type: 'machine:runtime_models:result',
        commandId: message.commandId,
        runtimes: await detectRuntimes(),
      });
      break;
    case 'ready:ack':
      console.log(`Ready acknowledged for ${message.computerId}.`);
      break;
    case 'token:revoked':
      console.error('Machine token was revoked by the server.');
      process.exitCode = 2;
      break;
    default:
      console.log(`Unhandled server frame: ${message.type || 'unknown'}`);
      break;
  }
}

async function connect(config) {
  const url = wsUrl(config.serverUrl, config);
  const requestModule = url.protocol === 'wss:' ? https : http;
  const requestUrl = new URL(url.href.replace(/^ws/, 'http'));
  const key = crypto.randomBytes(16).toString('base64');
  const options = {
    method: 'GET',
    headers: {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': key,
    },
  };

  return new Promise((resolve, reject) => {
    const req = requestModule.request(requestUrl, options);
    req.on('upgrade', (res, socket) => {
      if (res.statusCode !== 101) {
        reject(new Error(`WebSocket upgrade failed: ${res.statusCode}`));
        return;
      }
      const connection = { socket, buffer: Buffer.alloc(0) };
      socket.on('data', (chunk) => {
        for (const frame of decodeFrames(connection, chunk)) {
          if (frame.opcode === 0x8) {
            socket.end();
            return;
          }
          if (frame.opcode !== 0x1) continue;
          try {
            const message = JSON.parse(frame.text);
            handleCommand(socket, message, config).catch((error) => {
              console.error(error.message);
            });
          } catch (error) {
            console.error(`Invalid server frame: ${error.message}`);
          }
        }
      });
      socket.on('close', () => {
        console.error('Disconnected from MagClaw cloud.');
        process.exitCode = process.exitCode || 0;
        resolve();
      });
      socket.on('error', reject);
    });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk.toString(); });
      res.on('end', () => reject(new Error(body || `HTTP ${res.statusCode}`)));
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const diskConfig = await readConfig(args).catch(() => ({}));
  const config = {
    ...diskConfig,
    ...args,
    args,
    serverUrl: args.serverUrl || diskConfig.serverUrl || process.env.MAGCLAW_PUBLIC_URL || 'http://127.0.0.1:6543',
    token: args.token || args.machineToken || diskConfig.token || '',
    pairToken: args.pairToken || '',
    workspace: args.workspace || diskConfig.workspace || 'local',
  };
  if (!config.pairToken && !config.token) {
    throw new Error('Run with --pair-token for first pairing, or --token after pairing.');
  }
  console.log(`Connecting MagClaw daemon to ${config.serverUrl}...`);
  await connect(config);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
