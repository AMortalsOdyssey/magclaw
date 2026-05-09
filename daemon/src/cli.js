import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DAEMON_VERSION = '0.1.0';
export const DEFAULT_PROFILE = 'default';
export const DEFAULT_SERVER_URL = 'http://127.0.0.1:6543';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const MCP_BRIDGE_PATH = path.join(PACKAGE_ROOT, 'src', 'mcp-bridge.js');
const CAPABILITIES = [
  'agent:start',
  'agent:deliver',
  'agent:stop',
  'agent:skills:list',
  'machine:runtime_models:detect',
];

function now() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeProfileName(value) {
  const name = String(value || DEFAULT_PROFILE).trim() || DEFAULT_PROFILE;
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 80) || DEFAULT_PROFILE;
}

function safeFilePart(value) {
  const name = String(value || '').trim() || 'item';
  return name.replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 120) || 'item';
}

function daemonRoot(env = process.env) {
  return path.resolve(env.MAGCLAW_DAEMON_HOME || path.join(os.homedir(), '.magclaw', 'daemon'));
}

function rootLockPaths(env = process.env) {
  const root = daemonRoot(env);
  return {
    runDir: path.join(root, 'run'),
    lockFile: path.join(root, 'run', 'daemon.lock'),
  };
}

export function profilePaths(profile = DEFAULT_PROFILE, env = process.env) {
  const profileName = safeProfileName(profile);
  const dir = path.join(daemonRoot(env), 'profiles', profileName);
  return {
    profile: profileName,
    dir,
    config: path.join(dir, 'config.json'),
    owner: path.join(dir, 'owner.json'),
    lockFile: path.join(dir, 'run', 'daemon.lock'),
    runDir: path.join(dir, 'run'),
    logDir: path.join(dir, 'logs'),
    agentsDir: path.join(dir, 'agents'),
  };
}

function machineFingerprintValue() {
  return `mfp_${crypto.createHash('sha256')
    .update([
      os.hostname(),
      os.platform(),
      os.arch(),
      os.homedir(),
    ].join('|'))
    .digest('hex')}`;
}

export async function ensureMachineFingerprint(profile = DEFAULT_PROFILE, env = process.env) {
  const paths = profilePaths(profile, env);
  const existing = await readJsonFile(paths.owner, null);
  if (existing?.fingerprint) {
    return {
      ...existing,
      profile: paths.profile,
    };
  }
  const owner = {
    profile: paths.profile,
    fingerprint: machineFingerprintValue(),
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    createdAt: now(),
  };
  await writeJsonFile(paths.owner, owner);
  return owner;
}

function pidIsRunning(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function activeLockFile(lockFile, fallback = {}) {
  if (!existsSync(lockFile)) return null;
  const lock = await readJsonFile(lockFile, null);
  if (lock?.pid && pidIsRunning(lock.pid)) {
    return {
      ...fallback,
      ...lock,
      lockFile,
    };
  }
  await rm(lockFile, { force: true }).catch(() => {});
  return null;
}

export async function activeDaemonLock(profile = DEFAULT_PROFILE, env = process.env) {
  const paths = profilePaths(profile, env);
  return activeLockFile(paths.lockFile, { profile: paths.profile });
}

export async function activeComputerLock(env = process.env) {
  const paths = rootLockPaths(env);
  return activeLockFile(paths.lockFile, { scope: 'computer' });
}

async function writeLockFile(file, lock) {
  const handle = await open(file, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(lock, null, 2)}\n`);
  } finally {
    await handle.close();
  }
}

async function acquireDaemonLock(profile = DEFAULT_PROFILE, config = {}, env = process.env) {
  const paths = profilePaths(profile, env);
  await mkdir(paths.runDir, { recursive: true });
  const lock = {
    pid: process.pid,
    profile: paths.profile,
    serverUrl: config.serverUrl || '',
    computerId: config.computerId || null,
    startedAt: now(),
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const active = await activeDaemonLock(paths.profile, env);
    if (active) {
      throw new Error(`MagClaw daemon profile "${paths.profile}" is already running with pid ${active.pid}. Run "magclaw-daemon stop --profile ${paths.profile}" before starting another daemon.`);
    }
    try {
      await writeLockFile(paths.lockFile, lock);
      return async () => {
        const current = await readJsonFile(paths.lockFile, null);
        if (Number(current?.pid) === process.pid) {
          await rm(paths.lockFile, { force: true }).catch(() => {});
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error(`MagClaw daemon profile "${paths.profile}" is already starting.`);
}

function parseFlagKey(item) {
  return item
    .replace(/^--/, '')
    .replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
}

export function parseCli(argv = process.argv) {
  const args = argv.slice(2);
  const command = args[0] && !args[0].startsWith('-') ? args.shift() : 'connect';
  const flags = {};
  for (let index = 0; index < args.length; index += 1) {
    const item = args[index];
    if (!item.startsWith('--')) continue;
    const equalsIndex = item.indexOf('=');
    if (equalsIndex > 2) {
      flags[parseFlagKey(item.slice(0, equalsIndex))] = item.slice(equalsIndex + 1);
      continue;
    }
    const key = parseFlagKey(item);
    const next = args[index + 1];
    if (!next || next.startsWith('--')) {
      flags[key] = true;
    } else {
      flags[key] = next;
      index += 1;
    }
  }
  flags.profile = safeProfileName(flags.profile || process.env.MAGCLAW_DAEMON_PROFILE || DEFAULT_PROFILE);
  return { command, flags };
}

async function readJsonFile(file, fallback = {}) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function readProfile(profile, env = process.env) {
  const paths = profilePaths(profile, env);
  const config = await readJsonFile(paths.config, {});
  return {
    ...config,
    profile: paths.profile,
  };
}

async function saveProfile(profile, config, env = process.env) {
  const paths = profilePaths(profile, env);
  const owner = await ensureMachineFingerprint(paths.profile, env);
  const safeConfig = {
    profile: paths.profile,
    serverUrl: String(config.serverUrl || DEFAULT_SERVER_URL).replace(/\/+$/, ''),
    workspaceId: config.workspaceId || config.workspace || 'local',
    computerId: config.computerId || null,
    name: config.name || os.hostname(),
    fingerprint: config.fingerprint || owner.fingerprint,
    token: config.token || '',
    pairToken: config.pairToken || '',
    createdAt: config.createdAt || now(),
    updatedAt: now(),
  };
  if (safeConfig.token) safeConfig.pairToken = '';
  await writeJsonFile(paths.config, safeConfig);
  return safeConfig;
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function commandOutput(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeoutMs || 3000,
    env: options.env || process.env,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal || '',
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    error: result.error || null,
  };
}

function commandExists(command, env = process.env) {
  const checker = process.platform === 'win32' ? 'where' : 'command';
  const args = process.platform === 'win32' ? [command] : ['-v', command];
  const result = process.platform === 'win32'
    ? commandOutput(checker, args, { env, timeoutMs: 1500 })
    : commandOutput('/bin/sh', ['-lc', `command -v ${JSON.stringify(command)}`], { env, timeoutMs: 1500 });
  return result.ok ? result.stdout.split(/\r?\n/)[0] || command : '';
}

function runtimeVersion(command, env = process.env) {
  const result = commandOutput(command, ['--version'], { env, timeoutMs: 3000 });
  if (!result.ok && result.error?.code === 'ENOENT') return '';
  return result.stdout || result.stderr || '';
}

function codexAppServerCapable(command, env = process.env) {
  const result = commandOutput(command, ['app-server', '--help'], { env, timeoutMs: 3000 });
  if (result.error?.code === 'ENOENT') return false;
  if (result.ok) return true;
  const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return output.includes('app-server') || output.includes('listen') || output.includes('stdio');
}

export async function detectRuntimes(env = process.env) {
  const codexCommand = env.CODEX_PATH || env.MAGCLAW_CODEX_PATH || 'codex';
  const candidates = [
    { id: 'codex', command: codexCommand },
    { id: 'claude-code', command: env.CLAUDE_PATH || 'claude' },
    { id: 'gemini', command: env.GEMINI_PATH || 'gemini' },
  ];
  return candidates.map((item) => {
    const pathValue = item.command.includes(path.sep) ? (existsSync(item.command) ? item.command : '') : commandExists(item.command, env);
    const installed = Boolean(pathValue);
    const version = installed ? runtimeVersion(item.command, env) : '';
    return {
      id: item.id,
      command: item.command,
      path: pathValue,
      installed,
      version,
      appServer: item.id === 'codex' && installed ? codexAppServerCapable(item.command, env) : false,
    };
  });
}

function toWebSocketUrl(serverUrl, config = {}) {
  const base = String(serverUrl || DEFAULT_SERVER_URL).replace(/\/+$/, '');
  const wsBase = base.startsWith('https://')
    ? `wss://${base.slice('https://'.length)}`
    : base.startsWith('http://')
      ? `ws://${base.slice('http://'.length)}`
      : base;
  const url = new URL(`${wsBase}/daemon/connect`);
  if (config.pairToken) url.searchParams.set('pair_token', config.pairToken);
  else url.searchParams.set('token', config.token || config.machineToken || '');
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

function sendJsonFrame(socket, payload) {
  socket.write(encodeFrame(payload));
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

function tomlArray(values) {
  return `[${values.map((value) => tomlString(value)).join(',')}]`;
}

function codexMcpArgs({ agentId, serverUrl }) {
  return [
    '-c', 'wire_api="responses"',
    '-c', `mcp_servers.magclaw.command=${tomlString(process.execPath)}`,
    '-c', `mcp_servers.magclaw.args=${tomlArray([MCP_BRIDGE_PATH, '--agent-id', agentId, '--base-url', serverUrl])}`,
    '-c', 'mcp_servers.magclaw.startup_timeout_sec=30',
    '-c', 'mcp_servers.magclaw.tool_timeout_sec=120',
    '-c', 'mcp_servers.magclaw.enabled=true',
    '-c', 'mcp_servers.magclaw.required=false',
  ];
}

function deliveryPrompt(agent, message = {}, workItem = null) {
  const target = message.target || (message.spaceType && message.spaceId
    ? `${message.spaceType}:${message.spaceId}${message.parentMessageId ? `:${message.parentMessageId}` : ''}`
    : '#all');
  const workItemLine = workItem?.id || message.workItemId
    ? `Work item id: ${workItem?.id || message.workItemId}`
    : 'Work item id: none';
  return [
    `You are ${agent.name || agent.id}, a MagClaw remote agent running on this local computer.`,
    'Use the MagClaw MCP tools when you need to read history, send a routed reply, manage tasks, write memory, or schedule reminders.',
    `Agent id: ${agent.id}`,
    `Conversation target: ${target}`,
    workItemLine,
    message.parentMessageId ? `Parent message id: ${message.parentMessageId}` : '',
    message.id ? `Source message id: ${message.id}` : '',
    '',
    'Incoming message:',
    String(message.body || message.content || '').trim() || '(empty)',
  ].filter(Boolean).join('\n');
}

function agentRuntimeKind(agent = {}) {
  const value = String(agent.runtimeId || agent.runtime || '').toLowerCase();
  if (value.includes('claude')) return 'claude-code';
  if (value.includes('codex')) return 'codex';
  return value || 'codex';
}

function agentEnvironment(agent = {}, env = process.env) {
  const output = { ...env };
  for (const item of Array.isArray(agent.envVars) ? agent.envVars : []) {
    const key = String(item.key || '').trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    output[key] = String(item.value || '');
  }
  return output;
}

class CodexAgentSession {
  constructor({ agent, profile, paths, serverUrl, token, send, env = process.env }) {
    this.agent = agent;
    this.profile = profile;
    this.paths = paths;
    this.serverUrl = serverUrl;
    this.token = token;
    this.send = send;
    this.env = env;
    this.child = null;
    this.requestId = 0;
    this.pending = new Map();
    this.stdoutBuffer = '';
    this.responseBuffer = '';
    this.threadId = agent.runtimeSessionId || '';
    this.activeTurnId = '';
    this.status = 'offline';
    this.started = false;
    this.pendingPrompts = [];
  }

  agentDir() {
    return path.join(this.paths.agentsDir, safeFilePart(this.agent.id));
  }

  codexHome() {
    return path.join(this.agentDir(), 'codex-home');
  }

  workspace() {
    return path.join(this.agentDir(), 'workspace');
  }

  async prepare() {
    await mkdir(this.codexHome(), { recursive: true });
    await mkdir(this.workspace(), { recursive: true });
    await writeFile(path.join(this.codexHome(), 'config.toml'), [
      'wire_api = "responses"',
      'memories = false',
      'plugins = true',
      '',
      '[analytics]',
      'enabled = false',
      '',
    ].join('\n'));
    await writeFile(path.join(this.workspace(), 'AGENTS.md'), [
      '# MagClaw Remote Agent Workspace',
      '',
      'This workspace is isolated for a MagClaw cloud-connected agent.',
      'Do not assume files from the user localhost MagClaw instance are present here.',
      '',
    ].join('\n'));
  }

  sendStatus(status, activity = null) {
    this.status = status;
    this.send({
      type: 'agent:status',
      agentId: this.agent.id,
      status,
      sessionId: this.threadId || null,
      activity: activity || {
        source: '@magclaw/daemon',
        status,
        at: now(),
      },
    });
  }

  sendRequest(method, params = {}) {
    if (!this.child?.stdin?.writable) return null;
    this.requestId += 1;
    const id = this.requestId;
    this.pending.set(id, { method, params, startedAt: Date.now() });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return id;
  }

  sendNotification(method, params = {}) {
    if (!this.child?.stdin?.writable) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async start() {
    if (this.started) return;
    await this.prepare();
    const codexCommand = this.env.CODEX_PATH || this.env.MAGCLAW_CODEX_PATH || 'codex';
    const args = ['app-server', ...codexMcpArgs({
      agentId: this.agent.id,
      serverUrl: this.serverUrl,
    }), '--listen', 'stdio://'];
    this.child = spawn(codexCommand, args, {
      cwd: this.workspace(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...agentEnvironment(this.agent, this.env),
        NO_COLOR: '1',
        CODEX_HOME: this.codexHome(),
        MAGCLAW_AGENT_ID: this.agent.id,
        MAGCLAW_DAEMON_PROFILE: this.profile,
        MAGCLAW_SERVER_URL: this.serverUrl,
        MAGCLAW_MACHINE_TOKEN: this.token,
      },
    });
    this.started = true;
    this.status = 'starting';
    this.sendStatus('starting', { source: '@magclaw/daemon', detail: 'Starting Codex app-server', at: now() });

    this.child.stdout.on('data', (chunk) => this.handleStdout(chunk));
    this.child.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (!text) return;
      this.send({
        type: 'agent:activity',
        agentId: this.agent.id,
        status: this.status || 'working',
        activity: { source: 'codex-stderr', text: text.slice(0, 2000), at: now() },
      });
    });
    this.child.on('error', (error) => {
      this.send({ type: 'agent:error', agentId: this.agent.id, error: error.message });
      this.sendStatus('error', { source: '@magclaw/daemon', error: error.message, at: now() });
    });
    this.child.on('close', (code, signal) => {
      this.started = false;
      this.child = null;
      const stopped = this.status === 'stopping';
      this.sendStatus(stopped ? 'offline' : 'error', {
        source: '@magclaw/daemon',
        detail: `Codex app-server exited with code ${code ?? 'unknown'}`,
        signal: signal || null,
        at: now(),
      });
    });

    this.sendRequest('initialize', { clientInfo: { name: '@magclaw/daemon', version: DAEMON_VERSION } });
    this.sendNotification('initialized', {});
    const method = this.threadId ? 'thread/resume' : 'thread/start';
    const params = this.threadId ? { threadId: this.threadId } : {};
    this.sendRequest(method, params);
  }

  async deliver(message = {}, workItem = null) {
    const prompt = deliveryPrompt(this.agent, message, workItem);
    if (!this.started) await this.start();
    if (!this.threadId) {
      this.pendingPrompts.push({ prompt, message, workItem });
      return;
    }
    this.startTurn(prompt, message, workItem);
  }

  startTurn(prompt, message = {}, workItem = null) {
    if (!this.threadId) return false;
    const model = this.agent.model || undefined;
    const effort = this.agent.reasoningEffort || undefined;
    const params = {
      threadId: this.threadId,
      input: [{ type: 'text', text: prompt }],
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    };
    const requestId = this.activeTurnId
      ? this.sendRequest('turn/steer', { threadId: this.threadId, expectedTurnId: this.activeTurnId, input: params.input })
      : this.sendRequest('turn/start', params);
    if (!requestId) return false;
    this.pending.set(requestId, {
      ...(this.pending.get(requestId) || {}),
      sourceMessage: message,
      workItem,
    });
    this.lastSourceMessage = message;
    this.responseBuffer = '';
    this.sendStatus('thinking', { source: '@magclaw/daemon', detail: 'Turn started', at: now() });
    return true;
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk.toString();
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        this.handleCodexMessage(JSON.parse(line));
      } catch (error) {
        this.send({ type: 'agent:activity', agentId: this.agent.id, status: this.status, activity: { source: 'codex-stdout', error: error.message, at: now() } });
      }
    }
  }

  handleCodexMessage(message) {
    if (message.id !== undefined && (message.result || message.error)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        this.send({ type: 'agent:error', agentId: this.agent.id, error: message.error.message || 'Codex request failed.' });
        this.sendStatus('error', { source: '@magclaw/daemon', error: message.error.message || 'Codex request failed.', at: now() });
        return;
      }
      if (pending?.method === 'thread/start' || pending?.method === 'thread/resume') {
        this.threadId = message.result?.thread?.id || message.result?.threadId || this.threadId;
        this.send({ type: 'agent:session', agentId: this.agent.id, status: 'idle', sessionId: this.threadId });
        this.sendStatus('idle', { source: '@magclaw/daemon', detail: 'Codex session ready', at: now() });
        const queued = this.pendingPrompts.splice(0);
        for (const item of queued) this.startTurn(item.prompt, item.message, item.workItem);
      } else if (pending?.method === 'turn/start' || pending?.method === 'turn/steer') {
        this.activeTurnId = message.result?.turn?.id || message.result?.turnId || this.activeTurnId;
      }
      return;
    }

    const method = message.method || '';
    const params = message.params || {};
    if (method === 'thread/started') {
      this.threadId = params.thread?.id || params.threadId || this.threadId;
      this.send({ type: 'agent:session', agentId: this.agent.id, status: 'idle', sessionId: this.threadId });
      return;
    }
    if (method === 'turn/started') {
      this.activeTurnId = params.turn?.id || params.turnId || this.activeTurnId;
      this.sendStatus('working', { source: '@magclaw/daemon', detail: 'Codex turn running', turnId: this.activeTurnId || null, at: now() });
      return;
    }
    if (method === 'item/agentMessage/delta' || method === 'response/output_text/delta') {
      this.responseBuffer += String(params.delta || params.text || '');
      this.send({
        type: 'agent:activity',
        agentId: this.agent.id,
        status: 'working',
        activity: { source: 'codex-stream', chars: this.responseBuffer.length, at: now() },
      });
      return;
    }
    if (method === 'item/completed') {
      const text = params.item?.text || params.item?.message || params.text || '';
      if (text) this.responseBuffer += String(text);
      return;
    }
    if (method === 'turn/completed' || method === 'turn/failed') {
      const body = this.responseBuffer.trim();
      if (body && method === 'turn/completed') {
        this.send({
          type: 'agent:message',
          agentId: this.agent.id,
          payload: {
            body,
            message: this.lastSourceMessage || null,
            sourceMessage: this.lastSourceMessage || null,
            spaceType: this.lastSourceMessage?.spaceType || 'channel',
            spaceId: this.lastSourceMessage?.spaceId || 'chan_all',
            parentMessageId: this.lastSourceMessage?.parentMessageId || null,
          },
        });
      }
      this.responseBuffer = '';
      this.activeTurnId = '';
      this.sendStatus(method === 'turn/completed' ? 'idle' : 'error', {
        source: '@magclaw/daemon',
        detail: method === 'turn/completed' ? 'Turn completed' : 'Turn failed',
        at: now(),
      });
      return;
    }
    this.send({
      type: 'agent:activity',
      agentId: this.agent.id,
      status: this.status || 'working',
      activity: { source: 'codex-event', method, at: now() },
    });
  }

  stop() {
    this.status = 'stopping';
    if (this.child) this.child.kill('SIGTERM');
  }
}

class ClaudeAgentSession {
  constructor({ agent, profile, paths, serverUrl, token, send, env = process.env }) {
    this.agent = agent;
    this.profile = profile;
    this.paths = paths;
    this.serverUrl = serverUrl;
    this.token = token;
    this.send = send;
    this.env = env;
    this.child = null;
    this.status = 'offline';
    this.started = false;
  }

  agentDir() {
    return path.join(this.paths.agentsDir, safeFilePart(this.agent.id));
  }

  workspace() {
    return path.join(this.agentDir(), 'workspace');
  }

  async prepare() {
    await mkdir(this.workspace(), { recursive: true });
    await writeFile(path.join(this.workspace(), 'AGENTS.md'), [
      '# MagClaw Remote Claude Agent Workspace',
      '',
      'This workspace is isolated for a MagClaw cloud-connected Claude Code agent.',
      '',
    ].join('\n'));
  }

  sendStatus(status, activity = null) {
    this.status = status;
    this.send({
      type: 'agent:status',
      agentId: this.agent.id,
      status,
      sessionId: null,
      activity: activity || {
        source: 'claude-code',
        status,
        at: now(),
      },
    });
  }

  async start() {
    if (this.started) return;
    await this.prepare();
    this.started = true;
    this.sendStatus('idle', { source: 'claude-code', detail: 'Claude Code runner ready', at: now() });
  }

  async deliver(message = {}, workItem = null) {
    await this.start();
    const prompt = deliveryPrompt(this.agent, message, workItem);
    const claudeCommand = this.env.CLAUDE_PATH || 'claude';
    const args = ['--print'];
    if (this.agent.model) args.push('--model', String(this.agent.model));
    args.push(prompt);
    const timeoutMs = Number(this.env.MAGCLAW_DAEMON_RUNTIME_TIMEOUT_MS || 10 * 60 * 1000);
    this.sendStatus('thinking', { source: 'claude-code', detail: 'Claude Code turn started', at: now() });
    await new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (status, detail) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.child = null;
        if (status === 'idle') {
          const body = stdout.trim();
          if (body) {
            this.send({
              type: 'agent:message',
              agentId: this.agent.id,
              payload: {
                body,
                message,
                sourceMessage: message,
                spaceType: message.spaceType || 'channel',
                spaceId: message.spaceId || 'chan_all',
                parentMessageId: message.parentMessageId || null,
              },
            });
          }
          this.sendStatus('idle', { source: 'claude-code', detail: detail || 'Claude Code turn completed', at: now() });
        } else {
          const error = detail || stderr.trim() || 'Claude Code failed.';
          this.send({ type: 'agent:error', agentId: this.agent.id, error });
          this.sendStatus('error', { source: 'claude-code', error, at: now() });
        }
        resolve();
      };
      this.child = spawn(claudeCommand, args, {
        cwd: this.workspace(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...agentEnvironment(this.agent, this.env),
          NO_COLOR: '1',
          MAGCLAW_AGENT_ID: this.agent.id,
          MAGCLAW_DAEMON_PROFILE: this.profile,
          MAGCLAW_SERVER_URL: this.serverUrl,
          MAGCLAW_MACHINE_TOKEN: this.token,
        },
      });
      const timer = setTimeout(() => {
        if (this.child) this.child.kill('SIGTERM');
        finish('error', 'Claude Code session timed out.');
      }, timeoutMs);
      this.child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        this.send({
          type: 'agent:activity',
          agentId: this.agent.id,
          status: 'working',
          activity: { source: 'claude-code', chars: stdout.length, at: now() },
        });
      });
      this.child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      this.child.on('error', (error) => finish('error', error.message));
      this.child.on('close', (code, signal) => {
        if (code === 0) finish('idle');
        else finish('error', stderr.trim() || `Claude Code exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}.`);
      });
    });
  }

  stop() {
    this.status = 'stopping';
    if (this.child) this.child.kill('SIGTERM');
    this.started = false;
  }
}

class MagClawDaemon {
  constructor(config, env = process.env) {
    this.env = env;
    this.config = config;
    this.paths = profilePaths(config.profile, env);
    this.socket = null;
    this.sessions = new Map();
    this.closed = false;
  }

  send(payload) {
    if (!this.socket || this.socket.destroyed) return false;
    sendJsonFrame(this.socket, payload);
    return true;
  }

  async readyPayload() {
    const runtimes = await detectRuntimes(this.env);
    const owner = await ensureMachineFingerprint(this.paths.profile, this.env);
    return {
      type: 'ready',
      computerId: this.config.computerId || null,
      workspaceId: this.config.workspaceId || 'local',
      machineFingerprint: this.config.fingerprint || owner.fingerprint,
      name: this.config.name || os.hostname(),
      hostname: os.hostname(),
      os: `${os.platform()} ${os.release()}`,
      arch: os.arch(),
      daemonVersion: DAEMON_VERSION,
      runtimes: runtimes.filter((runtime) => runtime.installed).map((runtime) => runtime.id),
      runtimeDetails: runtimes,
      runningAgents: [...this.sessions.keys()],
      capabilities: CAPABILITIES,
    };
  }

  async sendReady() {
    this.send(await this.readyPayload());
  }

  async handleFrame(message) {
    switch (message.type) {
      case 'pairing:accepted':
        this.config.computerId = message.computerId;
        this.config.workspaceId = message.workspaceId || this.config.workspaceId || 'local';
        this.config.token = message.machineToken;
        this.config.pairToken = '';
        await saveProfile(this.paths.profile, this.config, this.env);
        console.log(`Paired computer ${message.computerId}.`);
        await this.sendReady();
        break;
      case 'connected':
        this.config.computerId = message.computerId || this.config.computerId;
        this.config.workspaceId = message.workspaceId || this.config.workspaceId;
        await saveProfile(this.paths.profile, this.config, this.env);
        await this.sendReady();
        break;
      case 'ready:ack':
        console.log(`MagClaw daemon ready for computer ${message.computerId || this.config.computerId}.`);
        break;
      case 'ping':
        this.send({ type: 'pong', time: now() });
        break;
      case 'agent:start':
        await this.handleAgentStart(message);
        break;
      case 'agent:deliver':
        await this.handleAgentDeliver(message);
        break;
      case 'agent:stop':
        await this.handleAgentStop(message);
        break;
      case 'agent:skills:list':
        this.send({ type: 'agent:skills:list_result', commandId: message.commandId, agentId: message.agentId, skills: [] });
        this.send({ type: 'agent:ack', commandId: message.commandId, agentId: message.agentId, status: 'idle' });
        break;
      case 'machine:runtime_models:detect':
        this.send({ type: 'machine:runtime_models:result', commandId: message.commandId, runtimes: await detectRuntimes(this.env) });
        break;
      case 'token:revoked':
        console.error('Machine token was revoked by the server.');
        this.close();
        process.exitCode = 2;
        break;
      default:
        console.log(`Unhandled server frame: ${message.type || 'unknown'}`);
        break;
    }
  }

  sessionFor(agent) {
    const existing = this.sessions.get(agent.id);
    if (existing) return existing;
    const kind = agentRuntimeKind(agent);
    const SessionClass = kind === 'codex'
      ? CodexAgentSession
      : kind === 'claude-code'
        ? ClaudeAgentSession
        : null;
    if (!SessionClass) throw new Error(`Unsupported runtime: ${agent.runtime || agent.runtimeId || 'unknown'}`);
    const session = new SessionClass({
      agent,
      profile: this.paths.profile,
      paths: this.paths,
      serverUrl: this.config.serverUrl,
      token: this.config.token,
      send: (payload) => this.send(payload),
      env: this.env,
    });
    this.sessions.set(agent.id, session);
    return session;
  }

  async handleAgentStart(message) {
    const agent = message.payload?.agent || { id: message.agentId, name: message.agentId || 'Agent' };
    this.send({ type: 'agent:start:ack', commandId: message.commandId, agentId: agent.id, status: 'starting' });
    try {
      const session = this.sessionFor(agent);
      await session.start();
    } catch (error) {
      this.send({ type: 'agent:error', commandId: message.commandId, agentId: agent.id, error: error.message });
    }
  }

  async handleAgentDeliver(message) {
    const agent = message.payload?.agent || { id: message.agentId, name: message.agentId || 'Agent' };
    try {
      const session = this.sessionFor(agent);
      this.send({ type: 'agent:deliver:ack', commandId: message.commandId, agentId: agent.id, status: 'queued' });
      await session.deliver(message.payload?.message || {}, message.payload?.workItem || null);
    } catch (error) {
      this.send({ type: 'agent:error', commandId: message.commandId, agentId: agent.id, error: error.message });
    }
  }

  async handleAgentStop(message) {
    const agentId = message.agentId || message.payload?.agentId;
    const session = this.sessions.get(agentId);
    if (session) {
      session.stop();
      this.sessions.delete(agentId);
    }
    this.send({ type: 'agent:ack', commandId: message.commandId, agentId, status: 'offline' });
  }

  close() {
    this.closed = true;
    for (const session of this.sessions.values()) session.stop();
    this.sessions.clear();
    if (this.socket && !this.socket.destroyed) this.socket.end();
  }

  async connectOnce() {
    const url = toWebSocketUrl(this.config.serverUrl, this.config);
    const requestModule = url.protocol === 'wss:' ? https : http;
    const requestUrl = new URL(url.href.replace(/^ws/, 'http'));
    const key = crypto.randomBytes(16).toString('base64');
    console.log(`Connecting MagClaw daemon profile "${this.paths.profile}" to ${this.config.serverUrl}...`);
    return new Promise((resolve, reject) => {
      const req = requestModule.request(requestUrl, {
        method: 'GET',
        headers: {
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': key,
        },
      });
      req.on('upgrade', (res, socket) => {
        if (res.statusCode !== 101) {
          reject(new Error(`WebSocket upgrade failed: ${res.statusCode}`));
          return;
        }
        this.socket = socket;
        const connection = { socket, buffer: Buffer.alloc(0) };
        socket.on('data', (chunk) => {
          for (const frame of decodeFrames(connection, chunk)) {
            if (frame.opcode === 0x8) {
              socket.end();
              return;
            }
            if (frame.opcode !== 0x1) continue;
            try {
              this.handleFrame(JSON.parse(frame.text)).catch((error) => {
                this.send({ type: 'error', error: error.message });
              });
            } catch (error) {
              console.error(`Invalid server frame: ${error.message}`);
            }
          }
        });
        socket.on('close', () => resolve());
        socket.on('end', () => resolve());
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

  async runForever() {
    while (!this.closed) {
      try {
        await this.connectOnce();
      } catch (error) {
        console.error(`MagClaw daemon connection failed: ${error.message}`);
      }
      if (!this.closed) await sleep(2000);
    }
  }
}

function executablePath() {
  return path.join(PACKAGE_ROOT, 'bin', 'magclaw-daemon.js');
}

async function writeLauncher(profile, env = process.env) {
  const paths = profilePaths(profile, env);
  await mkdir(paths.runDir, { recursive: true });
  const npmPath = commandExists('npm', env);
  const launcher = path.join(paths.runDir, 'launcher.js');
  const fallbackBin = executablePath();
  const code = [
    '#!/usr/bin/env node',
    "const { spawn } = require('node:child_process');",
    `const npmPath = ${JSON.stringify(npmPath)};`,
    `const fallbackBin = ${JSON.stringify(fallbackBin)};`,
    `const profile = ${JSON.stringify(paths.profile)};`,
    `const daemonHome = ${JSON.stringify(daemonRoot(env))};`,
    'const command = npmPath || process.execPath;',
    "const args = npmPath",
    "  ? ['exec', '--yes', '--package', '@magclaw/daemon@latest', '--', 'magclaw-daemon', 'connect', '--profile', profile]",
    "  : [fallbackBin, 'connect', '--profile', profile];",
    'const child = spawn(command, args, {',
    "  stdio: 'inherit',",
    '  env: { ...process.env, MAGCLAW_DAEMON_HOME: daemonHome },',
    '});',
    "child.on('exit', (code, signal) => {",
    '  if (signal) process.kill(process.pid, signal);',
    '  process.exit(code || 0);',
    '});',
    "child.on('error', (error) => {",
    '  console.error(error.message);',
    '  process.exit(1);',
    '});',
    '',
  ].join('\n');
  await writeFile(launcher, code);
  await chmod(launcher, 0o755).catch(() => {});
  return launcher;
}

function launchAgentLabel(profile) {
  return `ai.magclaw.daemon.${safeProfileName(profile)}`;
}

function plistEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function ensureExecutable(file) {
  await chmod(file, 0o755).catch(() => {});
}

async function startMacBackground(profile, env = process.env) {
  const paths = profilePaths(profile, env);
  const label = launchAgentLabel(paths.profile);
  const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const plist = path.join(launchAgentsDir, `${label}.plist`);
  await mkdir(paths.logDir, { recursive: true });
  await mkdir(launchAgentsDir, { recursive: true });
  const launcher = await writeLauncher(paths.profile, env);
  await ensureExecutable(launcher);
  const programArguments = [process.execPath, launcher];
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${plistEscape(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...programArguments.map((item) => `    <string>${plistEscape(item)}</string>`),
    '  </array>',
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>',
    '  <true/>',
    '  <key>StandardOutPath</key>',
    `  <string>${plistEscape(path.join(paths.logDir, 'daemon.log'))}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${plistEscape(path.join(paths.logDir, 'daemon.err.log'))}</string>`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
  await writeFile(plist, xml);
  spawnSync('launchctl', ['bootout', `gui/${process.getuid()}`, plist], { stdio: 'ignore' });
  const boot = spawnSync('launchctl', ['bootstrap', `gui/${process.getuid()}`, plist], { encoding: 'utf8' });
  if (boot.status !== 0) {
    const load = spawnSync('launchctl', ['load', plist], { encoding: 'utf8' });
    if (load.status !== 0) throw new Error((boot.stderr || load.stderr || 'launchctl failed').trim());
  }
  return { ok: true, mode: 'launchd', label, file: plist };
}

function systemdServiceName(profile) {
  return `magclaw-daemon-${safeProfileName(profile)}.service`;
}

async function startLinuxBackground(profile, env = process.env) {
  const paths = profilePaths(profile, env);
  const serviceName = systemdServiceName(paths.profile);
  const serviceDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const serviceFile = path.join(serviceDir, serviceName);
  await mkdir(paths.logDir, { recursive: true });
  await mkdir(serviceDir, { recursive: true });
  const launcher = await writeLauncher(paths.profile, env);
  await ensureExecutable(launcher);
  await writeFile(serviceFile, [
    '[Unit]',
    `Description=MagClaw daemon (${paths.profile})`,
    '',
    '[Service]',
    'Type=simple',
    `ExecStart=${process.execPath} ${launcher}`,
    'Restart=always',
    'RestartSec=3',
    `Environment=MAGCLAW_DAEMON_PROFILE=${paths.profile}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n'));
  const reload = spawnSync('systemctl', ['--user', 'daemon-reload'], { encoding: 'utf8' });
  if (reload.status !== 0) throw new Error((reload.stderr || 'systemctl daemon-reload failed').trim());
  const enable = spawnSync('systemctl', ['--user', 'enable', '--now', serviceName], { encoding: 'utf8' });
  if (enable.status !== 0) throw new Error((enable.stderr || 'systemctl enable failed').trim());
  return { ok: true, mode: 'systemd', serviceName, file: serviceFile };
}

async function startBackground(profile, env = process.env) {
  if (process.platform === 'darwin') return startMacBackground(profile, env);
  if (process.platform === 'linux') return startLinuxBackground(profile, env);
  return { ok: false, mode: 'foreground', message: 'Background daemon is only automated on macOS launchd and Linux user systemd.' };
}

function stopBackground(profile) {
  if (process.platform === 'darwin') {
    const paths = profilePaths(profile);
    const label = launchAgentLabel(paths.profile);
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
    spawnSync('launchctl', ['bootout', `gui/${process.getuid()}`, plist], { stdio: 'ignore' });
    return { ok: true, mode: 'launchd', label, file: plist };
  }
  if (process.platform === 'linux') {
    const serviceName = systemdServiceName(profile);
    const result = spawnSync('systemctl', ['--user', 'disable', '--now', serviceName], { encoding: 'utf8' });
    return { ok: result.status === 0, mode: 'systemd', serviceName, error: result.stderr || '' };
  }
  return { ok: false, mode: 'foreground' };
}

async function uninstallBackground(profile) {
  const stopped = stopBackground(profile);
  if (process.platform === 'darwin') {
    const paths = profilePaths(profile);
    const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${launchAgentLabel(paths.profile)}.plist`);
    await rm(plist, { force: true });
  } else if (process.platform === 'linux') {
    await rm(path.join(os.homedir(), '.config', 'systemd', 'user', systemdServiceName(profile)), { force: true });
    spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
  }
  return stopped;
}

async function status(profile) {
  const paths = profilePaths(profile);
  const config = await readProfile(paths.profile);
  const configStat = await stat(paths.config).catch(() => null);
  const lock = await activeDaemonLock(paths.profile);
  const computerLock = await activeComputerLock();
  let service = { mode: 'foreground', active: false };
  if (process.platform === 'darwin') {
    const label = launchAgentLabel(paths.profile);
    const result = spawnSync('launchctl', ['print', `gui/${process.getuid()}/${label}`], { encoding: 'utf8' });
    service = { mode: 'launchd', active: result.status === 0, label };
  } else if (process.platform === 'linux') {
    const serviceName = systemdServiceName(paths.profile);
    const result = spawnSync('systemctl', ['--user', 'is-active', serviceName], { encoding: 'utf8' });
    service = { mode: 'systemd', active: result.status === 0, serviceName, status: String(result.stdout || '').trim() };
  }
  return {
    profile: paths.profile,
    configPath: paths.config,
    configured: Boolean(configStat),
    running: Boolean(lock),
    pid: lock?.pid || null,
    lockFile: paths.lockFile,
    computerRunning: Boolean(computerLock),
    computerPid: computerLock?.pid || null,
    serverUrl: config.serverUrl || '',
    computerId: config.computerId || null,
    hasMachineToken: Boolean(config.token),
    hasPairToken: Boolean(config.pairToken),
    service,
  };
}

async function logs(profile) {
  const paths = profilePaths(profile);
  const files = [path.join(paths.logDir, 'daemon.log'), path.join(paths.logDir, 'daemon.err.log')];
  for (const file of files) {
    if (!existsSync(file)) continue;
    process.stdout.write(`\n==> ${file} <==\n`);
    const text = await readFile(file, 'utf8').catch(() => '');
    process.stdout.write(text.split(/\r?\n/).slice(-120).join('\n'));
    process.stdout.write('\n');
  }
}

async function doctor(env = process.env) {
  const runtimes = await detectRuntimes(env);
  return {
    ok: true,
    daemonVersion: DAEMON_VERSION,
    node: process.version,
    platform: process.platform,
    arch: os.arch(),
    profileRoot: daemonRoot(env),
    runtimes,
  };
}

async function buildConfig(flags, env = process.env) {
  const diskConfig = await readProfile(flags.profile, env);
  const profile = flags.profile || diskConfig.profile || DEFAULT_PROFILE;
  const owner = await ensureMachineFingerprint(profile, env);
  return {
    ...diskConfig,
    ...flags,
    profile,
    serverUrl: String(flags.serverUrl || diskConfig.serverUrl || env.MAGCLAW_PUBLIC_URL || DEFAULT_SERVER_URL).replace(/\/+$/, ''),
    token: flags.token || flags.machineToken || diskConfig.token || '',
    pairToken: flags.pairToken || diskConfig.pairToken || '',
    workspaceId: flags.workspaceId || flags.workspace || diskConfig.workspaceId || 'local',
    name: flags.name || diskConfig.name || os.hostname(),
    fingerprint: flags.fingerprint || diskConfig.fingerprint || owner.fingerprint,
  };
}

async function runConnect(flags, env = process.env) {
  const config = await buildConfig(flags, env);
  if (!config.pairToken && !config.token) {
    throw new Error('Run connect with --pair-token for first pairing, or use a saved profile with a machine token.');
  }
  await saveProfile(config.profile, config, env);
  if (flags.background) {
    const result = await startBackground(config.profile, env);
    printJson(result);
    if (!result.ok) {
      console.log('Falling back to foreground mode.');
      const releaseLock = await acquireDaemonLock(config.profile, config, env);
      const daemon = new MagClawDaemon(config, env);
      const shutdown = () => daemon.close();
      process.once('SIGINT', shutdown);
      process.once('SIGTERM', shutdown);
      try {
        await daemon.runForever();
      } finally {
        process.off('SIGINT', shutdown);
        process.off('SIGTERM', shutdown);
        await releaseLock();
      }
    }
    return;
  }
  const releaseLock = await acquireDaemonLock(config.profile, config, env);
  const daemon = new MagClawDaemon(config, env);
  const shutdown = () => daemon.close();
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    await daemon.runForever();
  } finally {
    process.off('SIGINT', shutdown);
    process.off('SIGTERM', shutdown);
    await releaseLock();
  }
}

export async function main(argv = process.argv, env = process.env) {
  const { command, flags } = parseCli(argv);
  switch (command) {
    case 'connect':
      await runConnect(flags, env);
      break;
    case 'start': {
      const config = await buildConfig(flags, env);
      await saveProfile(config.profile, config, env);
      printJson(await startBackground(config.profile, env));
      break;
    }
    case 'stop':
      printJson(stopBackground(flags.profile));
      break;
    case 'status':
      printJson(await status(flags.profile));
      break;
    case 'logs':
      await logs(flags.profile);
      break;
    case 'doctor':
      printJson(await doctor(env));
      break;
    case 'uninstall':
      printJson(await uninstallBackground(flags.profile));
      break;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}
