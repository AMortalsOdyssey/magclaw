import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import {
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, '.magclaw');
const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
const RUNS_DIR = path.join(DATA_DIR, 'runs');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const PORT = Number(process.env.PORT || 4317);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_JSON_BYTES = 40 * 1024 * 1024;
const CLOUD_PROTOCOL_VERSION = 1;

const runningProcesses = new Map();
const sseClients = new Set();
let cloudPushTimer = null;
let syncInProgress = false;

const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
]);

let state = null;
let saveChain = Promise.resolve();

function now() {
  return new Date().toISOString();
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

function normalizeCloudUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.replace(/\/+$/, '');
}

function defaultState() {
  const seededAt = now();
  const hostName = os.hostname();
  return {
    version: 4,
    createdAt: seededAt,
    updatedAt: seededAt,
    settings: {
      codexPath: process.env.CODEX_PATH || '/Applications/Codex.app/Contents/Resources/codex',
      defaultWorkspace: ROOT,
      model: process.env.CODEX_MODEL || '',
      sandbox: process.env.CODEX_SANDBOX || 'workspace-write',
    },
    connection: {
      mode: process.env.MAGCLAW_MODE === 'cloud' ? 'cloud' : 'local',
      deployment: process.env.MAGCLAW_DEPLOYMENT || 'local',
      controlPlaneUrl: normalizeCloudUrl(process.env.MAGCLAW_CLOUD_URL || ''),
      relayUrl: normalizeCloudUrl(process.env.MAGCLAW_RELAY_URL || ''),
      cloudToken: process.env.MAGCLAW_CLOUD_TOKEN || '',
      workspaceId: process.env.MAGCLAW_WORKSPACE_ID || 'local',
      deviceId: process.env.MAGCLAW_DEVICE_ID || makeId('dev'),
      deviceName: hostName,
      pairingStatus: process.env.MAGCLAW_MODE === 'cloud' ? 'configured' : 'local',
      pairedAt: null,
      lastSyncAt: null,
      lastSyncDirection: null,
      lastError: '',
      autoSync: process.env.MAGCLAW_AUTO_SYNC === '1',
      protocolVersion: CLOUD_PROTOCOL_VERSION,
    },
    humans: [
      {
        id: 'hum_local',
        name: 'You',
        email: 'local@magclaw.dev',
        role: 'owner',
        status: 'online',
        createdAt: seededAt,
      },
    ],
    computers: [
      {
        id: 'cmp_local',
        name: hostName,
        os: `${os.platform()} ${os.arch()}`,
        daemonVersion: 'local-dev',
        status: 'connected',
        runtimeIds: ['codex'],
        createdAt: seededAt,
      },
    ],
    agents: [
      {
        id: 'agt_codex',
        name: 'Codex Local',
        description: 'Local Codex CLI agent bound to this machine.',
        runtime: 'Codex CLI',
        model: process.env.CODEX_MODEL || 'default',
        status: 'idle',
        computerId: 'cmp_local',
        workspace: ROOT,
        createdAt: seededAt,
      },
    ],
    channels: [
      {
        id: 'chan_all',
        name: 'all',
        description: 'Default local coordination channel.',
        humanIds: ['hum_local'],
        agentIds: ['agt_codex'],
        archived: false,
        createdAt: seededAt,
        updatedAt: seededAt,
      },
    ],
    dms: [
      {
        id: 'dm_codex',
        participantIds: ['hum_local', 'agt_codex'],
        createdAt: seededAt,
        updatedAt: seededAt,
      },
    ],
    messages: [
      {
        id: 'msg_welcome',
        spaceType: 'channel',
        spaceId: 'chan_all',
        authorType: 'system',
        authorId: 'system',
        body: 'Magclaw local is ready. Create a task, start a Codex mission, or open a thread.',
        attachmentIds: [],
        replyCount: 0,
        savedBy: [],
        createdAt: seededAt,
        updatedAt: seededAt,
      },
    ],
    replies: [],
    tasks: [],
    missions: [],
    runs: [],
    attachments: [],
    events: [],
  };
}

async function ensureStorage() {
  await mkdir(ATTACHMENTS_DIR, { recursive: true });
  await mkdir(RUNS_DIR, { recursive: true });

  if (!existsSync(STATE_FILE)) {
    state = defaultState();
    await persistState();
    return;
  }

  try {
    state = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    migrateState();
    await persistState();
  } catch {
    state = defaultState();
    addSystemEvent('state_recovered', 'State file was unreadable, Magclaw started with a clean state.');
    await persistState();
  }
}

function migrateState() {
  const fresh = defaultState();
  state.version = 4;
  state.settings = { ...fresh.settings, ...(state.settings || {}) };
  state.connection = { ...fresh.connection, ...(state.connection || {}) };
  state.connection.mode = state.connection.mode === 'cloud' ? 'cloud' : 'local';
  state.connection.controlPlaneUrl = normalizeCloudUrl(state.connection.controlPlaneUrl || '');
  state.connection.relayUrl = normalizeCloudUrl(state.connection.relayUrl || '');
  state.connection.cloudToken = String(state.connection.cloudToken || process.env.MAGCLAW_CLOUD_TOKEN || '');
  state.connection.protocolVersion = CLOUD_PROTOCOL_VERSION;
  for (const key of ['humans', 'computers', 'agents', 'channels', 'dms', 'messages', 'replies', 'tasks', 'missions', 'runs', 'attachments', 'events']) {
    if (!Array.isArray(state[key])) state[key] = fresh[key] || [];
  }
  if (!state.humans.length) state.humans = fresh.humans;
  if (!state.computers.length) state.computers = fresh.computers;
  if (!state.agents.length) state.agents = fresh.agents;
  if (!state.channels.length) state.channels = fresh.channels;
  if (!state.dms.length) state.dms = fresh.dms;
  if (!state.messages.length) state.messages = fresh.messages;
  for (const task of state.tasks) {
    task.history = Array.isArray(task.history) ? task.history : [];
    task.attachmentIds = Array.isArray(task.attachmentIds) ? task.attachmentIds : [];
    task.threadMessageId = task.threadMessageId || task.messageId || null;
    task.claimedBy = task.claimedBy || task.assigneeId || null;
    task.claimedAt = task.claimedAt || null;
    task.reviewRequestedAt = task.reviewRequestedAt || null;
    task.completedAt = task.completedAt || null;
    task.runIds = Array.isArray(task.runIds) ? task.runIds : [];
  }
}

function persistState() {
  if (!state) return Promise.resolve();
  state.updatedAt = now();
  const payload = JSON.stringify(state, null, 2);
  saveChain = saveChain.then(async () => {
    const tmp = `${STATE_FILE}.tmp`;
    await writeFile(tmp, payload);
    await rename(tmp, STATE_FILE);
  });
  return saveChain;
}

function addSystemEvent(type, message, extra = {}) {
  if (!state) return;
  state.events.push({
    id: makeId('evt'),
    type,
    message,
    createdAt: now(),
    ...extra,
  });
  trimEvents();
}

function addRunEvent(runId, type, message, extra = {}) {
  const event = {
    id: makeId('evt'),
    runId,
    type,
    message,
    createdAt: now(),
    ...extra,
  };
  state.events.push(event);
  trimEvents();
  broadcast('run-event', event);
  return event;
}

function trimEvents() {
  if (state.events.length > 1200) {
    state.events = state.events.slice(state.events.length - 1200);
  }
}

function broadcast(type, payload) {
  const packet = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    res.write(packet);
  }
}

function broadcastState() {
  broadcast('state', publicState());
  queueCloudPush('state_changed');
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

function cloudBearerToken(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function safeTokenEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireCloudAccess(req, res) {
  const expected = process.env.MAGCLAW_CLOUD_TOKEN || '';
  if (!expected) return true;
  if (safeTokenEqual(cloudBearerToken(req), expected)) return true;
  sendError(res, 401, 'Cloud access token is required.');
  return false;
}

function requireCloudDeploymentApi(req, res, url) {
  if (state?.connection?.deployment !== 'cloud') return true;
  if (!process.env.MAGCLAW_CLOUD_TOKEN) return true;
  const syncPaths = new Set(['/api/cloud/health', '/api/cloud/export-state', '/api/cloud/import-state']);
  if (syncPaths.has(url.pathname)) return true;
  if (safeTokenEqual(cloudBearerToken(req), process.env.MAGCLAW_CLOUD_TOKEN)) return true;
  sendError(res, 401, 'Cloud deployment API requires a bearer token.');
  return false;
}

function collectBody(req, maxBytes = MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await collectBody(req);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function splitLines(value) {
  if (Array.isArray(value)) return value.map(String).map((line) => line.trim()).filter(Boolean);
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function safeFileName(name) {
  return String(name || 'attachment')
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 120);
}

function safePathWithin(base, target) {
  const resolved = path.resolve(base, target);
  if (!resolved.startsWith(base)) return null;
  return resolved;
}

function findMission(id) {
  return state.missions.find((mission) => mission.id === id);
}

function findRun(id) {
  return state.runs.find((run) => run.id === id);
}

function findChannel(id) {
  return state.channels.find((channel) => channel.id === id);
}

function findMessage(id) {
  return state.messages.find((message) => message.id === id);
}

function findAgent(id) {
  return state.agents.find((agent) => agent.id === id);
}

function findComputer(id) {
  return state.computers.find((computer) => computer.id === id);
}

function findTask(id) {
  return state.tasks.find((task) => task.id === id);
}

function normalizeName(value, fallback) {
  return String(value || fallback || '')
    .trim()
    .replace(/^#/, '')
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 48);
}

function addCollabEvent(type, message, extra = {}) {
  addSystemEvent(type, message, extra);
}

function addTaskHistory(task, type, message, actorId = 'hum_local', extra = {}) {
  task.history = Array.isArray(task.history) ? task.history : [];
  const item = {
    id: makeId('hist'),
    type,
    message,
    actorId,
    createdAt: now(),
    ...extra,
  };
  task.history.push(item);
  task.updatedAt = now();
  return item;
}

function addSystemReply(parentMessageId, body) {
  const parent = findMessage(parentMessageId);
  if (!parent) return null;
  const reply = {
    id: makeId('rep'),
    parentMessageId,
    authorType: 'system',
    authorId: 'system',
    body,
    attachmentIds: [],
    createdAt: now(),
    updatedAt: now(),
  };
  state.replies.push(reply);
  parent.replyCount = state.replies.filter((item) => item.parentMessageId === parentMessageId).length;
  parent.updatedAt = now();
  return reply;
}

function cloudSnapshot() {
  const allowedKeys = ['humans', 'computers', 'agents', 'channels', 'dms', 'messages', 'replies', 'tasks', 'missions', 'runs', 'attachments', 'events'];
  const snapshot = {
    version: state.version,
    exportedAt: now(),
    workspaceId: state.connection?.workspaceId || 'local',
    protocolVersion: CLOUD_PROTOCOL_VERSION,
  };
  for (const key of allowedKeys) {
    snapshot[key] = Array.isArray(state[key]) ? state[key] : [];
  }
  return snapshot;
}

function applyCloudSnapshot(snapshot) {
  const allowedKeys = ['humans', 'computers', 'agents', 'channels', 'dms', 'messages', 'replies', 'tasks', 'missions', 'runs', 'attachments', 'events'];
  for (const key of allowedKeys) {
    if (Array.isArray(snapshot?.[key])) state[key] = snapshot[key];
  }
  migrateState();
}

function cloudEndpoint(pathname) {
  const base = normalizeCloudUrl(state.connection?.controlPlaneUrl || '');
  if (!base) throw new Error('Cloud control plane URL is not configured.');
  return `${base}${pathname}`;
}

async function cloudFetch(pathname, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  const cloudToken = String(state.connection?.cloudToken || process.env.MAGCLAW_CLOUD_TOKEN || '');
  const headers = {
    'content-type': 'application/json',
    'x-magclaw-device-id': state.connection?.deviceId || '',
    'x-magclaw-workspace-id': state.connection?.workspaceId || '',
    ...(cloudToken ? { authorization: `Bearer ${cloudToken}` } : {}),
    ...(options.headers || {}),
  };
  try {
    const response = await fetch(cloudEndpoint(pathname), {
      ...options,
      signal: controller.signal,
      headers,
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

async function pushStateToCloud(reason = 'manual') {
  if (!state.connection?.controlPlaneUrl) throw new Error('Cloud control plane URL is not configured.');
  syncInProgress = true;
  try {
    const result = await cloudFetch('/api/cloud/import-state', {
      method: 'POST',
      body: JSON.stringify({
        workspaceId: state.connection.workspaceId || 'local',
        deviceId: state.connection.deviceId,
        reason,
        snapshot: cloudSnapshot(),
      }),
    });
    state.connection.lastSyncAt = now();
    state.connection.lastSyncDirection = 'push';
    state.connection.lastError = '';
    await persistState();
    return result;
  } catch (error) {
    state.connection.lastError = error.message;
    await persistState();
    throw error;
  } finally {
    syncInProgress = false;
  }
}

async function pullStateFromCloud() {
  if (!state.connection?.controlPlaneUrl) throw new Error('Cloud control plane URL is not configured.');
  syncInProgress = true;
  try {
    const result = await cloudFetch(`/api/cloud/export-state?workspaceId=${encodeURIComponent(state.connection.workspaceId || 'local')}`);
    applyCloudSnapshot(result.snapshot || result);
    state.connection.lastSyncAt = now();
    state.connection.lastSyncDirection = 'pull';
    state.connection.lastError = '';
    await persistState();
    return result;
  } catch (error) {
    state.connection.lastError = error.message;
    await persistState();
    throw error;
  } finally {
    syncInProgress = false;
  }
}

function queueCloudPush(reason) {
  if (syncInProgress) return;
  if (state?.connection?.mode !== 'cloud') return;
  if (!state.connection.autoSync) return;
  if (!state.connection.controlPlaneUrl) return;
  if (!['paired', 'connected'].includes(state.connection.pairingStatus)) return;
  clearTimeout(cloudPushTimer);
  cloudPushTimer = setTimeout(() => {
    pushStateToCloud(reason).catch(() => {});
  }, 900);
}

function ensureTaskThread(task) {
  if (task.threadMessageId && findMessage(task.threadMessageId)) return findMessage(task.threadMessageId);
  if (task.messageId && findMessage(task.messageId)) {
    task.threadMessageId = task.messageId;
    return findMessage(task.messageId);
  }

  const message = {
    id: makeId('msg'),
    spaceType: task.spaceType,
    spaceId: task.spaceId,
    authorType: 'human',
    authorId: task.createdBy || 'hum_local',
    body: `Task: ${task.title}${task.body ? `\n\n${task.body}` : ''}`,
    attachmentIds: Array.isArray(task.attachmentIds) ? task.attachmentIds : [],
    replyCount: 0,
    savedBy: [],
    taskId: task.id,
    createdAt: task.createdAt || now(),
    updatedAt: now(),
  };
  state.messages.push(message);
  task.messageId = message.id;
  task.threadMessageId = message.id;
  return message;
}

function publicState() {
  return {
    ...state,
    connection: publicConnection(),
    runtime: runtimeSnapshot(),
    runningRunIds: [...runningProcesses.keys()],
  };
}

function publicConnection() {
  const { cloudToken, ...connection } = state?.connection || {};
  return {
    ...connection,
    hasControlPlane: Boolean(state?.connection?.controlPlaneUrl),
    hasRelay: Boolean(state?.connection?.relayUrl),
    hasCloudToken: Boolean(cloudToken || process.env.MAGCLAW_CLOUD_TOKEN),
  };
}

function runtimeSnapshot() {
  return {
    node: process.version,
    platform: `${os.platform()} ${os.arch()}`,
    host: os.hostname(),
    codexPath: state?.settings?.codexPath || 'codex',
  };
}

async function getRuntimeInfo() {
  const codexPath = state.settings.codexPath || 'codex';
  const version = await execText(codexPath, ['--version']).catch((error) => error.message);
  return {
    ...runtimeSnapshot(),
    codexVersion: version.trim(),
    port: PORT,
    dataDir: DATA_DIR,
  };
}

function execText(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 10_000 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
  });
}

function createPrompt(mission, run, attachments) {
  const contract = {
    goal: mission.goal,
    workspace: mission.workspace,
    scopeAllow: mission.scopeAllow,
    scopeDeny: mission.scopeDeny,
    gates: mission.gates,
    evidenceRequired: mission.evidenceRequired,
    humanCheckpoints: mission.humanCheckpoints,
  };

  const attachmentLines = attachments.length
    ? attachments.map((item) => `- ${item.name} (${item.type || 'file'}): ${item.path}`).join('\n')
    : '- none';

  return [
    'You are Codex running under Magclaw local mission control.',
    '',
    'Mission contract:',
    JSON.stringify(contract, null, 2),
    '',
    'Operating rules:',
    '- Stay inside the mission scope unless the user explicitly asks otherwise.',
    '- Prefer small, verifiable changes.',
    '- Run the requested gates when practical.',
    '- End with a concise evidence report: changed files, tests run, residual risks.',
    '- Do not claim completion if evidence is missing.',
    '',
    `Run id: ${run.id}`,
    `Mission id: ${mission.id}`,
    '',
    'Attachments saved locally:',
    attachmentLines,
    '',
    'User request:',
    mission.goal,
  ].join('\n');
}

function summarizeCodexEvent(event) {
  if (!event || typeof event !== 'object') return String(event || '');
  const candidates = [
    event.message,
    event.text,
    event.output,
    event.delta,
    event.type,
    event.msg?.message,
    event.msg?.text,
    event.item?.text,
    event.item?.message,
  ].filter(Boolean);

  if (candidates.length) return String(candidates[0]);
  return JSON.stringify(event).slice(0, 600);
}

function handleCodexLine(run, line) {
  if (!line.trim()) return;
  try {
    const event = JSON.parse(line);
    addRunEvent(run.id, 'codex', summarizeCodexEvent(event), { raw: event });
  } catch {
    addRunEvent(run.id, 'stdout', line);
  }
}

function startCodexRun(mission, run) {
  const workspace = path.resolve(mission.workspace || state.settings.defaultWorkspace || ROOT);
  const attachments = state.attachments.filter((item) => mission.attachmentIds.includes(item.id));
  const imageAttachments = attachments.filter((item) => String(item.type || '').startsWith('image/'));
  const outputFile = path.join(RUNS_DIR, `${run.id}-last-message.txt`);
  const args = [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--sandbox',
    state.settings.sandbox || 'workspace-write',
    '-C',
    workspace,
    '-o',
    outputFile,
  ];

  if (state.settings.model) {
    args.push('-m', state.settings.model);
  }

  for (const image of imageAttachments) {
    args.push('-i', image.path);
  }

  args.push('-');

  run.status = 'running';
  run.startedAt = now();
  run.workspace = workspace;
  run.command = `${state.settings.codexPath} ${args.map((arg) => (arg.includes(' ') ? JSON.stringify(arg) : arg)).join(' ')}`;
  mission.status = 'running';
  mission.updatedAt = now();
  addRunEvent(run.id, 'runner', `Starting Codex in ${workspace}`);
  persistState().then(broadcastState);

  const child = spawn(state.settings.codexPath || 'codex', args, {
    cwd: workspace,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

  runningProcesses.set(run.id, child);

  let stdoutBuffer = '';
  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) handleCodexLine(run, line);
    persistState();
  });

  child.stderr.on('data', (chunk) => {
    const message = chunk.toString().trim();
    if (message) addRunEvent(run.id, 'stderr', message);
    persistState();
  });

  child.on('error', (error) => {
    runningProcesses.delete(run.id);
    run.status = 'failed';
    run.completedAt = now();
    run.exitCode = null;
    mission.status = 'failed';
    mission.updatedAt = now();
    addRunEvent(run.id, 'runner-error', error.message);
    persistState().then(broadcastState);
  });

  child.on('close', async (code) => {
    runningProcesses.delete(run.id);
    if (stdoutBuffer.trim()) handleCodexLine(run, stdoutBuffer.trim());
    run.exitCode = code;
    run.completedAt = now();

    let finalMessage = '';
    try {
      finalMessage = (await readFile(outputFile, 'utf8')).trim();
    } catch {
      finalMessage = '';
    }

    run.finalMessage = finalMessage;
    if (run.cancelRequested) {
      run.status = 'cancelled';
      mission.status = 'ready';
    } else {
      run.status = code === 0 ? 'succeeded' : 'failed';
      mission.status = code === 0 ? 'review' : 'failed';
    }
    if (run.taskId) {
      const task = findTask(run.taskId);
      if (task) {
        if (run.status === 'succeeded') {
          task.status = 'in_review';
          task.reviewRequestedAt = now();
          addTaskHistory(task, 'review_requested', `Codex run ${run.id} succeeded; moved to review.`, task.claimedBy || 'agt_codex', { runId: run.id });
          addSystemReply(ensureTaskThread(task).id, `Codex run ${run.id} finished. Review requested.`);
        } else if (run.status === 'failed') {
          addTaskHistory(task, 'run_failed', `Codex run ${run.id} failed.`, task.claimedBy || 'agt_codex', { runId: run.id });
          addSystemReply(ensureTaskThread(task).id, `Codex run ${run.id} failed. Check evidence.`);
        } else if (run.status === 'cancelled') {
          addTaskHistory(task, 'run_cancelled', `Codex run ${run.id} cancelled.`, task.claimedBy || 'agt_codex', { runId: run.id });
          addSystemReply(ensureTaskThread(task).id, `Codex run ${run.id} cancelled.`);
        }
      }
    }
    mission.updatedAt = now();
    addRunEvent(run.id, 'runner', `Codex exited with code ${code ?? 'unknown'}.`);
    await persistState();
    broadcastState();
  });

  child.stdin.write(createPrompt(mission, run, attachments));
  child.stdin.end();
}

function createTaskFromMessage(message, title) {
  if (message.taskId) {
    const existing = findTask(message.taskId);
    if (existing) return existing;
  }

  const task = {
    id: makeId('task'),
    title: String(title || message.body || 'Untitled task').trim().slice(0, 180),
    body: message.body,
    status: 'todo',
    spaceType: message.spaceType,
    spaceId: message.spaceId,
    messageId: message.id,
    threadMessageId: message.id,
    assigneeId: null,
    claimedBy: null,
    claimedAt: null,
    reviewRequestedAt: null,
    completedAt: null,
    runIds: [],
    attachmentIds: Array.isArray(message.attachmentIds) ? message.attachmentIds : [],
    createdBy: 'hum_local',
    createdAt: now(),
    updatedAt: now(),
    history: [],
  };
  addTaskHistory(task, 'created', 'Task created from message.');
  state.tasks.unshift(task);
  message.taskId = task.id;
  addCollabEvent('task_created', `Task created: ${task.title}`, { taskId: task.id, messageId: message.id });
  return task;
}

async function handleApi(req, res, url) {
  if (!requireCloudDeploymentApi(req, res, url)) return true;

  if (req.method === 'GET' && url.pathname === '/api/state') {
    sendJson(res, 200, publicState());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/cloud/health') {
    if (!requireCloudAccess(req, res)) return true;
    sendJson(res, 200, {
      ok: true,
      name: 'Magclaw Control Plane',
      deployment: state.connection?.deployment || 'local',
      protocolVersion: CLOUD_PROTOCOL_VERSION,
      workspaceId: url.searchParams.get('workspaceId') || state.connection?.workspaceId || 'local',
      time: now(),
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/cloud/status') {
    sendJson(res, 200, {
      connection: publicConnection(),
      health: {
        localUrl: `http://${HOST}:${PORT}`,
        dataDir: DATA_DIR,
        protocolVersion: CLOUD_PROTOCOL_VERSION,
      },
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/config') {
    const body = await readJson(req);
    const previousMode = state.connection.mode;
    state.connection = {
      ...state.connection,
      mode: body.mode === 'cloud' ? 'cloud' : 'local',
      deployment: body.deployment ? String(body.deployment) : state.connection.deployment,
      controlPlaneUrl: normalizeCloudUrl(body.controlPlaneUrl ?? state.connection.controlPlaneUrl),
      relayUrl: normalizeCloudUrl(body.relayUrl ?? state.connection.relayUrl),
      cloudToken: body.cloudToken !== undefined ? String(body.cloudToken || '').trim() : state.connection.cloudToken,
      workspaceId: String(body.workspaceId || state.connection.workspaceId || 'local'),
      deviceName: String(body.deviceName || state.connection.deviceName || os.hostname()),
      autoSync: Boolean(body.autoSync),
      protocolVersion: CLOUD_PROTOCOL_VERSION,
    };
    if (state.connection.mode === 'local') {
      state.connection.pairingStatus = 'local';
    } else if (previousMode !== 'cloud' && state.connection.pairingStatus === 'local') {
      state.connection.pairingStatus = 'configured';
    }
    addSystemEvent('cloud_configured', `Connection mode set to ${state.connection.mode}.`);
    await persistState();
    broadcastState();
    sendJson(res, 200, { connection: publicConnection() });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/pair') {
    const body = await readJson(req);
    if (body.controlPlaneUrl !== undefined) state.connection.controlPlaneUrl = normalizeCloudUrl(body.controlPlaneUrl);
    if (body.relayUrl !== undefined) state.connection.relayUrl = normalizeCloudUrl(body.relayUrl);
    if (body.cloudToken !== undefined) state.connection.cloudToken = String(body.cloudToken || '').trim();
    if (body.workspaceId !== undefined) state.connection.workspaceId = String(body.workspaceId || 'local');
    if (body.deviceName !== undefined) state.connection.deviceName = String(body.deviceName || os.hostname());
    state.connection.mode = 'cloud';
    state.connection.pairingStatus = 'pairing';
    await persistState();

    try {
      const health = await cloudFetch(`/api/cloud/health?workspaceId=${encodeURIComponent(state.connection.workspaceId || 'local')}`);
      state.connection.pairingStatus = 'paired';
      state.connection.pairedAt = now();
      state.connection.lastError = '';
      addSystemEvent('cloud_paired', `Paired with ${state.connection.controlPlaneUrl}.`, { health });
      await persistState();
      broadcastState();
      sendJson(res, 200, { connection: publicConnection(), health });
    } catch (error) {
      state.connection.pairingStatus = 'configured';
      state.connection.lastError = error.message;
      await persistState();
      broadcastState();
      sendError(res, 502, error.message);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/disconnect') {
    state.connection.mode = 'local';
    state.connection.pairingStatus = 'local';
    state.connection.pairedAt = null;
    state.connection.lastSyncAt = null;
    state.connection.lastSyncDirection = null;
    state.connection.lastError = '';
    state.connection.autoSync = false;
    addSystemEvent('cloud_disconnected', 'Switched back to local-only mode.');
    await persistState();
    broadcastState();
    sendJson(res, 200, { connection: publicConnection() });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/cloud/export-state') {
    if (!requireCloudAccess(req, res)) return true;
    sendJson(res, 200, { snapshot: cloudSnapshot() });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/import-state') {
    if (!requireCloudAccess(req, res)) return true;
    const body = await readJson(req);
    const snapshot = body.snapshot || body;
    applyCloudSnapshot(snapshot);
    state.connection.lastSyncAt = now();
    state.connection.lastSyncDirection = 'import';
    state.connection.lastError = '';
    addSystemEvent('cloud_imported', `Cloud snapshot imported${body.reason ? ` (${body.reason})` : ''}.`);
    await persistState();
    broadcastState();
    sendJson(res, 200, { ok: true, importedAt: state.connection.lastSyncAt });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/sync/push') {
    const result = await pushStateToCloud('manual_push');
    broadcastState();
    sendJson(res, 200, { ok: true, result, connection: publicConnection() });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/sync/pull') {
    const result = await pullStateFromCloud();
    broadcastState();
    sendJson(res, 200, { ok: true, result, connection: publicConnection() });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/runtime') {
    sendJson(res, 200, await getRuntimeInfo());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/settings') {
    const body = await readJson(req);
    state.settings = {
      ...state.settings,
      codexPath: String(body.codexPath || state.settings.codexPath || 'codex'),
      defaultWorkspace: path.resolve(String(body.defaultWorkspace || state.settings.defaultWorkspace || ROOT)),
      model: String(body.model || ''),
      sandbox: ['read-only', 'workspace-write', 'danger-full-access'].includes(body.sandbox)
        ? body.sandbox
        : state.settings.sandbox,
    };
    addSystemEvent('settings_updated', 'Runtime settings updated.');
    await persistState();
    broadcastState();
    sendJson(res, 200, publicState());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/attachments') {
    const body = await readJson(req);
    const files = Array.isArray(body.files) ? body.files : [];
    const created = [];

    for (const file of files) {
      const match = String(file.dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
      if (!match) continue;
      const id = makeId('att');
      const name = safeFileName(file.name);
      const type = match[1];
      const buffer = Buffer.from(match[2], 'base64');
      const diskName = `${id}-${name}`;
      const filePath = path.join(ATTACHMENTS_DIR, diskName);
      await writeFile(filePath, buffer);
      const attachment = {
        id,
        name,
        type,
        bytes: buffer.length,
        path: filePath,
        url: `/api/attachments/${id}/${encodeURIComponent(name)}`,
        createdAt: now(),
      };
      state.attachments.push(attachment);
      created.push(attachment);
    }

    addSystemEvent('attachments_added', `${created.length} attachment(s) added.`);
    await persistState();
    broadcastState();
    sendJson(res, 201, { attachments: created });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/channels') {
    const body = await readJson(req);
    const name = normalizeName(body.name, 'new-channel');
    if (!name) {
      sendError(res, 400, 'Channel name is required.');
      return true;
    }
    if (state.channels.some((channel) => channel.name === name && !channel.archived)) {
      sendError(res, 409, 'Channel already exists.');
      return true;
    }
    const channel = {
      id: makeId('chan'),
      name,
      description: String(body.description || '').trim(),
      humanIds: Array.isArray(body.humanIds) && body.humanIds.length ? body.humanIds.map(String) : ['hum_local'],
      agentIds: Array.isArray(body.agentIds) ? body.agentIds.map(String) : ['agt_codex'],
      archived: false,
      createdAt: now(),
      updatedAt: now(),
    };
    state.channels.push(channel);
    state.messages.push({
      id: makeId('msg'),
      spaceType: 'channel',
      spaceId: channel.id,
      authorType: 'system',
      authorId: 'system',
      body: `Channel #${channel.name} created.`,
      attachmentIds: [],
      replyCount: 0,
      savedBy: [],
      createdAt: now(),
      updatedAt: now(),
    });
    addCollabEvent('channel_created', `Channel #${channel.name} created.`, { channelId: channel.id });
    await persistState();
    broadcastState();
    sendJson(res, 201, { channel });
    return true;
  }

  const channelMatch = url.pathname.match(/^\/api\/channels\/([^/]+)$/);
  if (['PATCH', 'POST'].includes(req.method) && channelMatch) {
    const channel = findChannel(channelMatch[1]);
    if (!channel) {
      sendError(res, 404, 'Channel not found.');
      return true;
    }
    const body = await readJson(req);
    if (body.name !== undefined) channel.name = normalizeName(body.name, channel.name);
    if (body.description !== undefined) channel.description = String(body.description || '').trim();
    if (Array.isArray(body.agentIds)) channel.agentIds = body.agentIds.map(String);
    if (Array.isArray(body.humanIds)) channel.humanIds = body.humanIds.map(String);
    if (body.archived !== undefined) channel.archived = Boolean(body.archived);
    channel.updatedAt = now();
    addCollabEvent('channel_updated', `Channel #${channel.name} updated.`, { channelId: channel.id });
    await persistState();
    broadcastState();
    sendJson(res, 200, { channel });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/dms') {
    const body = await readJson(req);
    const participantId = String(body.participantId || '').trim();
    if (!participantId) {
      sendError(res, 400, 'Participant is required.');
      return true;
    }
    let dm = state.dms.find((item) => item.participantIds.includes(participantId));
    if (!dm) {
      dm = {
        id: makeId('dm'),
        participantIds: ['hum_local', participantId],
        createdAt: now(),
        updatedAt: now(),
      };
      state.dms.push(dm);
    }
    addCollabEvent('dm_opened', 'DM opened.', { dmId: dm.id });
    await persistState();
    broadcastState();
    sendJson(res, 200, { dm });
    return true;
  }

  const messageMatch = url.pathname.match(/^\/api\/spaces\/(channel|dm)\/([^/]+)\/messages$/);
  if (req.method === 'POST' && messageMatch) {
    const body = await readJson(req);
    const [, spaceType, spaceId] = messageMatch;
    const targetExists = spaceType === 'channel'
      ? state.channels.some((channel) => channel.id === spaceId)
      : state.dms.some((dm) => dm.id === spaceId);
    if (!targetExists) {
      sendError(res, 404, 'Conversation not found.');
      return true;
    }
    const text = String(body.body || '').trim();
    const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds.map(String) : [];
    if (!text && !attachmentIds.length) {
      sendError(res, 400, 'Message body or attachment is required.');
      return true;
    }
    const message = {
      id: makeId('msg'),
      spaceType,
      spaceId,
      authorType: body.authorType === 'agent' ? 'agent' : 'human',
      authorId: String(body.authorId || 'hum_local'),
      body: text,
      attachmentIds,
      replyCount: 0,
      savedBy: [],
      createdAt: now(),
      updatedAt: now(),
    };
    state.messages.push(message);

    let task = null;
    if (body.asTask) {
      task = createTaskFromMessage(message, body.taskTitle || text);
      message.taskId = task.id;
    }

    addCollabEvent('message_sent', 'Message sent.', { messageId: message.id, spaceType, spaceId });
    await persistState();
    broadcastState();
    sendJson(res, 201, { message, task });
    return true;
  }

  const replyMatch = url.pathname.match(/^\/api\/messages\/([^/]+)\/replies$/);
  if (req.method === 'POST' && replyMatch) {
    const message = findMessage(replyMatch[1]);
    if (!message) {
      sendError(res, 404, 'Message not found.');
      return true;
    }
    const body = await readJson(req);
    const text = String(body.body || '').trim();
    if (!text) {
      sendError(res, 400, 'Reply body is required.');
      return true;
    }
    const reply = {
      id: makeId('rep'),
      parentMessageId: message.id,
      authorType: body.authorType === 'agent' ? 'agent' : 'human',
      authorId: String(body.authorId || 'hum_local'),
      body: text,
      attachmentIds: Array.isArray(body.attachmentIds) ? body.attachmentIds.map(String) : [],
      createdAt: now(),
      updatedAt: now(),
    };
    state.replies.push(reply);
    message.replyCount = state.replies.filter((item) => item.parentMessageId === message.id).length;
    message.updatedAt = now();
    addCollabEvent('thread_reply', 'Thread reply added.', { messageId: message.id, replyId: reply.id });
    await persistState();
    broadcastState();
    sendJson(res, 201, { reply });
    return true;
  }

  const saveMatch = url.pathname.match(/^\/api\/messages\/([^/]+)\/save$/);
  if (req.method === 'POST' && saveMatch) {
    const message = findMessage(saveMatch[1]);
    if (!message) {
      sendError(res, 404, 'Message not found.');
      return true;
    }
    const userId = 'hum_local';
    message.savedBy = Array.isArray(message.savedBy) ? message.savedBy : [];
    if (message.savedBy.includes(userId)) {
      message.savedBy = message.savedBy.filter((id) => id !== userId);
    } else {
      message.savedBy.push(userId);
    }
    message.updatedAt = now();
    await persistState();
    broadcastState();
    sendJson(res, 200, { message });
    return true;
  }

  const taskFromMessageMatch = url.pathname.match(/^\/api\/messages\/([^/]+)\/task$/);
  if (req.method === 'POST' && taskFromMessageMatch) {
    const message = findMessage(taskFromMessageMatch[1]);
    if (!message) {
      sendError(res, 404, 'Message not found.');
      return true;
    }
    const body = await readJson(req);
    const task = createTaskFromMessage(message, body.title || message.body);
    message.taskId = task.id;
    await persistState();
    broadcastState();
    sendJson(res, 201, { task });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/tasks') {
    const body = await readJson(req);
    const title = String(body.title || '').trim();
    if (!title) {
      sendError(res, 400, 'Task title is required.');
      return true;
    }
    const task = {
      id: makeId('task'),
      title,
      body: String(body.body || '').trim(),
      status: body.status || 'todo',
      spaceType: body.spaceType === 'dm' ? 'dm' : 'channel',
      spaceId: String(body.spaceId || 'chan_all'),
      messageId: body.messageId ? String(body.messageId) : null,
      threadMessageId: body.messageId ? String(body.messageId) : null,
      assigneeId: body.assigneeId ? String(body.assigneeId) : null,
      claimedBy: null,
      claimedAt: null,
      reviewRequestedAt: null,
      completedAt: null,
      runIds: [],
      attachmentIds: Array.isArray(body.attachmentIds) ? body.attachmentIds.map(String) : [],
      createdBy: 'hum_local',
      createdAt: now(),
      updatedAt: now(),
      history: [],
    };
    addTaskHistory(task, 'created', 'Task created manually.');
    state.tasks.unshift(task);
    const thread = ensureTaskThread(task);
    thread.taskId = task.id;
    addCollabEvent('task_created', `Task created: ${task.title}`, { taskId: task.id });
    await persistState();
    broadcastState();
    sendJson(res, 201, { task });
    return true;
  }

  const claimMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/claim$/);
  if (req.method === 'POST' && claimMatch) {
    const task = findTask(claimMatch[1]);
    if (!task) {
      sendError(res, 404, 'Task not found.');
      return true;
    }
    if (task.status === 'done') {
      sendError(res, 409, 'Done task cannot be claimed.');
      return true;
    }
    const body = await readJson(req);
    const actorId = String(body.actorId || body.assigneeId || 'agt_codex');
    if (task.claimedBy && task.claimedBy !== actorId && !body.force) {
      sendError(res, 409, `Task is already claimed by ${task.claimedBy}.`);
      return true;
    }
    task.claimedBy = actorId;
    task.assigneeId = actorId;
    task.claimedAt = task.claimedAt || now();
    task.status = 'in_progress';
    addTaskHistory(task, 'claimed', `Claimed by ${actorId}.`, actorId);
    const thread = ensureTaskThread(task);
    addSystemReply(thread.id, `Task claimed by ${actorId}.`);
    addCollabEvent('task_claimed', `Task claimed: ${task.title}`, { taskId: task.id, actorId });
    await persistState();
    broadcastState();
    sendJson(res, 200, { task });
    return true;
  }

  const unclaimMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/unclaim$/);
  if (req.method === 'POST' && unclaimMatch) {
    const task = findTask(unclaimMatch[1]);
    if (!task) {
      sendError(res, 404, 'Task not found.');
      return true;
    }
    if (task.status === 'done') {
      sendError(res, 409, 'Done task cannot be unclaimed.');
      return true;
    }
    const actorId = task.claimedBy || 'hum_local';
    task.claimedBy = null;
    task.assigneeId = null;
    task.claimedAt = null;
    task.status = 'todo';
    task.reviewRequestedAt = null;
    addTaskHistory(task, 'unclaimed', 'Claim released.', actorId);
    const thread = ensureTaskThread(task);
    addSystemReply(thread.id, 'Task claim released.');
    await persistState();
    broadcastState();
    sendJson(res, 200, { task });
    return true;
  }

  const reviewMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/request-review$/);
  if (req.method === 'POST' && reviewMatch) {
    const task = findTask(reviewMatch[1]);
    if (!task) {
      sendError(res, 404, 'Task not found.');
      return true;
    }
    if (!task.claimedBy) {
      sendError(res, 409, 'Task must be claimed before requesting review.');
      return true;
    }
    task.status = 'in_review';
    task.reviewRequestedAt = now();
    addTaskHistory(task, 'review_requested', 'Review requested.', task.claimedBy);
    const thread = ensureTaskThread(task);
    addSystemReply(thread.id, 'Review requested. Waiting for human approval.');
    await persistState();
    broadcastState();
    sendJson(res, 200, { task });
    return true;
  }

  const approveMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/approve$/);
  if (req.method === 'POST' && approveMatch) {
    const task = findTask(approveMatch[1]);
    if (!task) {
      sendError(res, 404, 'Task not found.');
      return true;
    }
    if (task.status !== 'in_review') {
      sendError(res, 409, 'Task must be in review before approval.');
      return true;
    }
    task.status = 'done';
    task.completedAt = now();
    addTaskHistory(task, 'approved', 'Human review approved; task marked done.');
    const thread = ensureTaskThread(task);
    addSystemReply(thread.id, 'Human review approved. Task marked done.');
    await persistState();
    broadcastState();
    sendJson(res, 200, { task });
    return true;
  }

  const reopenMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/reopen$/);
  if (req.method === 'POST' && reopenMatch) {
    const task = findTask(reopenMatch[1]);
    if (!task) {
      sendError(res, 404, 'Task not found.');
      return true;
    }
    task.status = 'todo';
    task.claimedBy = null;
    task.assigneeId = null;
    task.claimedAt = null;
    task.reviewRequestedAt = null;
    task.completedAt = null;
    addTaskHistory(task, 'reopened', 'Task reopened by human.');
    const thread = ensureTaskThread(task);
    addSystemReply(thread.id, 'Task reopened.');
    await persistState();
    broadcastState();
    sendJson(res, 200, { task });
    return true;
  }

  const runTaskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)\/run-codex$/);
  if (req.method === 'POST' && runTaskMatch) {
    const task = findTask(runTaskMatch[1]);
    if (!task) {
      sendError(res, 404, 'Task not found.');
      return true;
    }
    if (task.status === 'done') {
      sendError(res, 409, 'Done task cannot start a Codex run.');
      return true;
    }
    const actorId = 'agt_codex';
    if (task.claimedBy && task.claimedBy !== actorId) {
      sendError(res, 409, `Task is already claimed by ${task.claimedBy}.`);
      return true;
    }
    if (!task.claimedBy) {
      task.claimedBy = actorId;
      task.assigneeId = actorId;
      task.claimedAt = now();
      task.status = 'in_progress';
      addTaskHistory(task, 'claimed', 'Auto-claimed before Codex run.', actorId);
      addSystemReply(ensureTaskThread(task).id, 'Task auto-claimed by Codex before run.');
    }

    const mission = {
      id: makeId('mis'),
      title: task.title,
      goal: `${task.title}\n\n${task.body || ''}\n\nTask id: ${task.id}`,
      status: 'ready',
      priority: 'normal',
      workspace: path.resolve(state.settings.defaultWorkspace || ROOT),
      scopeAllow: ['**/*'],
      scopeDeny: ['.env*', 'node_modules/**', '.git/**'],
      gates: ['npm run check'],
      evidenceRequired: ['diff summary', 'test output', 'risk notes'],
      humanCheckpoints: ['before dangerous command', 'before deploy'],
      attachmentIds: Array.isArray(task.attachmentIds) ? task.attachmentIds : [],
      taskId: task.id,
      createdAt: now(),
      updatedAt: now(),
    };
    state.missions.unshift(mission);
    const run = {
      id: makeId('run'),
      missionId: mission.id,
      taskId: task.id,
      runtime: 'codex',
      status: 'queued',
      createdAt: now(),
      startedAt: null,
      completedAt: null,
      exitCode: null,
      finalMessage: '',
    };
    state.runs.unshift(run);
    task.runIds = Array.isArray(task.runIds) ? task.runIds : [];
    task.runIds.unshift(run.id);
    addTaskHistory(task, 'run_started', `Codex run started: ${run.id}`, actorId, { runId: run.id, missionId: mission.id });
    addSystemReply(ensureTaskThread(task).id, `Codex run started: ${run.id}.`);
    await persistState();
    broadcastState();
    startCodexRun(mission, run);
    sendJson(res, 201, { task, mission, run });
    return true;
  }

  const taskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (['PATCH', 'POST'].includes(req.method) && taskMatch) {
    const task = findTask(taskMatch[1]);
    if (!task) {
      sendError(res, 404, 'Task not found.');
      return true;
    }
    const body = await readJson(req);
    if (body.title !== undefined) task.title = String(body.title || task.title).trim();
    if (body.body !== undefined) task.body = String(body.body || '').trim();
    if (body.status !== undefined && body.status !== task.status) {
      const nextStatus = String(body.status || task.status);
      if (nextStatus === 'done' && task.status !== 'in_review') {
        sendError(res, 409, 'Task must be in review before done.');
        return true;
      }
      task.status = nextStatus;
      if (nextStatus === 'in_review') task.reviewRequestedAt = now();
      if (nextStatus === 'done') task.completedAt = now();
      addTaskHistory(task, 'status_changed', `Status changed to ${nextStatus}.`);
    }
    if (body.assigneeId !== undefined) {
      task.assigneeId = body.assigneeId ? String(body.assigneeId) : null;
      addTaskHistory(task, 'assigned', task.assigneeId ? `Assigned to ${task.assigneeId}.` : 'Assignee cleared.');
    }
    task.updatedAt = now();
    addCollabEvent('task_updated', `Task updated: ${task.title}`, { taskId: task.id });
    await persistState();
    broadcastState();
    sendJson(res, 200, { task });
    return true;
  }

  const deleteTaskMatch = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (req.method === 'DELETE' && deleteTaskMatch) {
    const taskId = deleteTaskMatch[1];
    state.tasks = state.tasks.filter((task) => task.id !== taskId);
    for (const message of state.messages) {
      if (message.taskId === taskId) delete message.taskId;
    }
    addCollabEvent('task_deleted', 'Task deleted.', { taskId });
    await persistState();
    broadcastState();
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/agents') {
    const body = await readJson(req);
    const agent = {
      id: makeId('agt'),
      name: String(body.name || 'New Agent').trim().slice(0, 80),
      description: String(body.description || '').trim(),
      runtime: String(body.runtime || 'Codex CLI'),
      model: String(body.model || state.settings.model || 'default'),
      status: 'idle',
      computerId: String(body.computerId || 'cmp_local'),
      workspace: path.resolve(String(body.workspace || state.settings.defaultWorkspace || ROOT)),
      createdAt: now(),
    };
    state.agents.push(agent);
    addCollabEvent('agent_created', `Agent created: ${agent.name}`, { agentId: agent.id });
    await persistState();
    broadcastState();
    sendJson(res, 201, { agent });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/agents/stop-all') {
    for (const agent of state.agents) agent.status = 'idle';
    for (const [runId, child] of runningProcesses.entries()) {
      const run = findRun(runId);
      if (run) run.cancelRequested = true;
      child.kill('SIGTERM');
    }
    addCollabEvent('agents_stopped', 'Stop all agents requested.');
    await persistState();
    broadcastState();
    sendJson(res, 200, { ok: true });
    return true;
  }

  const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (['PATCH', 'POST'].includes(req.method) && agentMatch) {
    const agent = findAgent(agentMatch[1]);
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    const body = await readJson(req);
    for (const key of ['name', 'description', 'runtime', 'model', 'status', 'computerId', 'workspace']) {
      if (body[key] !== undefined) agent[key] = String(body[key] || '').trim();
    }
    addCollabEvent('agent_updated', `Agent updated: ${agent.name}`, { agentId: agent.id });
    await persistState();
    broadcastState();
    sendJson(res, 200, { agent });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/computers') {
    const body = await readJson(req);
    const computer = {
      id: makeId('cmp'),
      name: String(body.name || os.hostname()).trim(),
      os: String(body.os || `${os.platform()} ${os.arch()}`),
      daemonVersion: String(body.daemonVersion || 'manual'),
      status: body.status || 'offline',
      runtimeIds: Array.isArray(body.runtimeIds) ? body.runtimeIds.map(String) : ['codex'],
      createdAt: now(),
    };
    state.computers.push(computer);
    addCollabEvent('computer_added', `Computer added: ${computer.name}`, { computerId: computer.id });
    await persistState();
    broadcastState();
    sendJson(res, 201, { computer });
    return true;
  }

  const computerMatch = url.pathname.match(/^\/api\/computers\/([^/]+)$/);
  if (['PATCH', 'POST'].includes(req.method) && computerMatch) {
    const computer = findComputer(computerMatch[1]);
    if (!computer) {
      sendError(res, 404, 'Computer not found.');
      return true;
    }
    const body = await readJson(req);
    for (const key of ['name', 'os', 'daemonVersion', 'status']) {
      if (body[key] !== undefined) computer[key] = String(body[key] || '').trim();
    }
    await persistState();
    broadcastState();
    sendJson(res, 200, { computer });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/humans') {
    const body = await readJson(req);
    const email = String(body.email || '').trim();
    const human = {
      id: makeId('hum'),
      name: String(body.name || email.split('@')[0] || 'Human').trim(),
      email,
      role: body.role || 'member',
      status: 'invited',
      createdAt: now(),
    };
    state.humans.push(human);
    addCollabEvent('human_invited', `Human invited: ${human.email || human.name}`, { humanId: human.id });
    await persistState();
    broadcastState();
    sendJson(res, 201, { human });
    return true;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/attachments/')) {
    const [, , , id] = url.pathname.split('/');
    const attachment = state.attachments.find((item) => item.id === id);
    if (!attachment) {
      sendError(res, 404, 'Attachment not found.');
      return true;
    }
    res.writeHead(200, {
      'content-type': attachment.type || 'application/octet-stream',
      'content-length': attachment.bytes,
      'cache-control': 'private, max-age=3600',
    });
    createReadStream(attachment.path).pipe(res);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/missions') {
    const body = await readJson(req);
    const mission = {
      id: makeId('mis'),
      title: String(body.title || 'Untitled mission').slice(0, 140),
      goal: String(body.goal || '').trim(),
      status: 'ready',
      priority: body.priority || 'normal',
      workspace: path.resolve(String(body.workspace || state.settings.defaultWorkspace || ROOT)),
      scopeAllow: splitLines(body.scopeAllow || '**/*'),
      scopeDeny: splitLines(body.scopeDeny || '.env*\nnode_modules/**\n.git/**'),
      gates: splitLines(body.gates),
      evidenceRequired: splitLines(body.evidenceRequired || 'diff summary\ntest output\nrisk notes'),
      humanCheckpoints: splitLines(body.humanCheckpoints || 'before dangerous command\nbefore deploy'),
      attachmentIds: Array.isArray(body.attachmentIds) ? body.attachmentIds.map(String) : [],
      createdAt: now(),
      updatedAt: now(),
    };

    if (!mission.goal) {
      sendError(res, 400, 'Mission goal is required.');
      return true;
    }

    state.missions.unshift(mission);
    addSystemEvent('mission_created', `Mission created: ${mission.title}`, { missionId: mission.id });
    await persistState();
    broadcastState();
    sendJson(res, 201, { mission });
    return true;
  }

  const runMatch = url.pathname.match(/^\/api\/missions\/([^/]+)\/runs$/);
  if (req.method === 'POST' && runMatch) {
    const mission = findMission(runMatch[1]);
    if (!mission) {
      sendError(res, 404, 'Mission not found.');
      return true;
    }
    const run = {
      id: makeId('run'),
      missionId: mission.id,
      runtime: 'codex',
      status: 'queued',
      createdAt: now(),
      startedAt: null,
      completedAt: null,
      exitCode: null,
      finalMessage: '',
    };
    state.runs.unshift(run);
    await persistState();
    broadcastState();
    startCodexRun(mission, run);
    sendJson(res, 201, { run });
    return true;
  }

  const cancelMatch = url.pathname.match(/^\/api\/runs\/([^/]+)\/cancel$/);
  if (req.method === 'POST' && cancelMatch) {
    const run = findRun(cancelMatch[1]);
    const child = runningProcesses.get(cancelMatch[1]);
    if (!run || !child) {
      sendError(res, 404, 'Running Codex process not found.');
      return true;
    }
    run.cancelRequested = true;
    child.kill('SIGTERM');
    addRunEvent(run.id, 'runner', 'Cancellation requested.');
    await persistState();
    broadcastState();
    sendJson(res, 200, { run });
    return true;
  }

  return false;
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const requestedPath = safePathWithin(PUBLIC_DIR, pathname.replace(/^\/+/, ''));
  if (!requestedPath) {
    sendError(res, 403, 'Forbidden.');
    return;
  }

  let filePath = requestedPath;
  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    filePath = path.join(PUBLIC_DIR, 'index.html');
  }

  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'content-type': contentTypes.get(ext) || 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
  });
  createReadStream(filePath).pipe(res);
}

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);

  try {
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url);
      if (!handled) sendError(res, 404, 'API route not found.');
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    sendError(res, 500, error.message || 'Internal server error.');
  }
}

await ensureStorage();

const server = http.createServer(handleRequest);
server.listen(PORT, HOST, () => {
  addSystemEvent('server_started', `Magclaw local server started at http://${HOST}:${PORT}`);
  persistState().then(broadcastState);
  console.log(`Magclaw local is running at http://${HOST}:${PORT}`);
  console.log(`Data directory: ${DATA_DIR}`);
});

process.on('SIGINT', () => {
  for (const child of runningProcesses.values()) child.kill('SIGTERM');
  server.close(() => process.exit(0));
});
