import crypto from 'node:crypto';
import { appendFile, chmod, mkdir, open, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_FILES = 30;
const DEFAULT_MAX_DAYS = 30;
const DEFAULT_MAX_FILES_PER_DAY = 8;
export const LOCAL_NOTIFY_AUDIT_MAX_FILE_BYTES = 20 * 1024 * 1024;
export const LOCAL_NOTIFY_AUDIT_MAX_FILES = 30;
export const LOCAL_NOTIFY_AUDIT_MAX_DAYS = 30;
export const LOCAL_NOTIFY_AUDIT_MAX_FILES_PER_DAY = 8;
const TAIL_READ_CHUNK_BYTES = 64 * 1024;
const SENSITIVE_KEY = /(authorization|bearer|token|secret|password|cookie|app.?id|chat.?id|open.?id|union.?id|user.?id|content|markdown|instruction|image.?key)/i;

function clean(value = '', max = 500) {
  return String(value ?? '').replace(/[\r\n\u0000]+/g, ' ').trim().slice(0, max);
}

function redactSensitiveText(value = '', max = 1000) {
  return clean(value, max)
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/(--(?:authorization|access-token|refresh-token|token|secret|password|chat-id|open-id|union-id|app-id)\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(/([?&](?:access_?token|token|secret|password)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/("?(?:authorization|access_?token|refresh_?token|token|secret|password|chat_?id|open_?id|union_?id|app_?id)"?\s*[:=]\s*)"?[^",;\s}]+"?/gi, '$1[redacted]')
    .replace(/\b(?:oc|ou|on|om|cli)_[A-Za-z0-9_-]+\b/g, '[redacted-feishu-id]')
    .replace(/\b(?:mcn|mfp)_[A-Za-z0-9_-]{30,}\b/g, '[redacted-notify-secret]');
}

function dateKey(value) {
  const parsed = new Date(value || Date.now());
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString().slice(0, 10) : parsed.toISOString().slice(0, 10);
}

function auditFileName(date, index = 0) {
  return index > 0 ? `notify-audit-${date}-${String(index).padStart(3, '0')}.jsonl` : `notify-audit-${date}.jsonl`;
}

function isAuditFile(name) {
  return /^notify-audit-\d{4}-\d{2}-\d{2}(?:-\d{3,})?\.jsonl$/.test(String(name || ''));
}

function auditFileOrder(name) {
  const match = String(name || '').match(/^notify-audit-(\d{4}-\d{2}-\d{2})(?:-(\d{3,}))?\.jsonl$/);
  return match ? { date: match[1], index: Number(match[2] || 0) } : { date: '', index: -1 };
}

function limit(value, fallback, max = 10_000) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(max, Math.trunc(parsed)) : fallback;
}

function sanitizedValue(value, key = '', depth = 0) {
  if (SENSITIVE_KEY.test(key)) return '[redacted]';
  if (depth > 5) return '[truncated]';
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactSensitiveText(value, 1000);
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => sanitizedValue(item, key, depth + 1));
  if (typeof value !== 'object') return clean(value, 200);
  return Object.fromEntries(Object.entries(value).slice(0, 80).map(([childKey, childValue]) => [
    clean(childKey, 100),
    sanitizedValue(childValue, childKey, depth + 1),
  ]));
}

export function sanitizeNotifyAuditRecord(record = {}) {
  const occurredAt = clean(record.occurredAt || record.createdAt || new Date().toISOString(), 80);
  return {
    version: 1,
    eventId: clean(record.eventId || `naud_${crypto.randomBytes(10).toString('hex')}`, 80),
    occurredAt,
    scope: clean(record.scope || 'local', 40),
    event: clean(record.event || 'unknown', 120),
    outcome: clean(record.outcome || 'observed', 40),
    severity: clean(record.severity || 'info', 20),
    ...(record.requestId ? { requestId: clean(record.requestId, 160) } : {}),
    ...(record.confirmationId ? { confirmationId: clean(record.confirmationId, 160) } : {}),
    ...(record.relayId ? { relayId: clean(record.relayId, 160) } : {}),
    ...(record.commandId ? { commandId: clean(record.commandId, 160) } : {}),
    ...(record.instance ? { instance: clean(record.instance, 48) } : {}),
    ...(record.actorId ? { actorId: clean(record.actorId, 160) } : {}),
    ...(record.workspaceId ? { workspaceId: clean(record.workspaceId, 160) } : {}),
    metadata: sanitizedValue(record.metadata || {}, 'metadata'),
  };
}

export function createNotifyAuditLog(options = {}) {
  const dir = options.dir ? path.resolve(options.dir) : '';
  const scope = clean(options.scope || 'local', 40);
  const base = options.base && typeof options.base === 'object' ? options.base : {};
  const now = options.now || (() => new Date().toISOString());
  const maxFileBytes = limit(options.maxFileBytes, DEFAULT_MAX_FILE_BYTES, 100 * 1024 * 1024);
  const maxFiles = limit(options.maxFiles, DEFAULT_MAX_FILES, 365);
  const maxDays = limit(options.maxDays, DEFAULT_MAX_DAYS, 3650);
  const maxFilesPerDay = limit(options.maxFilesPerDay, DEFAULT_MAX_FILES_PER_DAY, 1000);
  const warn = options.warn || ((message) => process.stderr.write(`${message}\n`));
  let chain = Promise.resolve();
  let activeDate = '';
  let activeFile = '';
  let activeSize = 0;

  async function ensureDir() {
    if (!dir) return false;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {});
    return true;
  }

  function compareAuditFiles(left, right) {
    const leftOrder = auditFileOrder(left);
    const rightOrder = auditFileOrder(right);
    return leftOrder.date.localeCompare(rightOrder.date) || leftOrder.index - rightOrder.index;
  }

  async function fileNames() {
    if (!await ensureDir()) return [];
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    return entries
      .filter((entry) => entry.isFile() && isAuditFile(entry.name))
      .map((entry) => entry.name)
      .sort(compareAuditFiles);
  }

  async function files() {
    const names = await fileNames();
    const records = [];
    for (const name of names) {
      const file = path.join(dir, name);
      const info = await stat(file).catch(() => null);
      if (info?.isFile()) records.push({ name, file, size: info.size });
    }
    return records;
  }

  function nextFile(date, current = '') {
    const order = auditFileOrder(path.basename(current));
    return path.join(dir, auditFileName(date, order.date === date ? order.index + 1 : 0));
  }

  async function initializeActiveFile(date) {
    const names = await fileNames();
    const latestName = names.filter((name) => auditFileOrder(name).date === date).at(-1);
    activeDate = date;
    activeFile = latestName ? path.join(dir, latestName) : path.join(dir, auditFileName(date));
    const info = latestName ? await stat(activeFile).catch(() => null) : null;
    activeSize = info?.isFile() ? info.size : 0;
    if (activeSize >= maxFileBytes) {
      activeFile = nextFile(date, activeFile);
      activeSize = 0;
    }
  }

  async function prune() {
    const names = await fileNames();
    const cutoff = new Date(Date.parse(`${dateKey(now())}T00:00:00.000Z`) - ((maxDays - 1) * 24 * 60 * 60 * 1000)).toISOString().slice(0, 10);
    const keep = new Set();
    const byDay = new Map();
    for (const name of names) {
      const date = auditFileOrder(name).date;
      if (date < cutoff) continue;
      const day = byDay.get(date) || [];
      day.push(name);
      byDay.set(date, day);
    }
    for (const day of byDay.values()) {
      for (const name of day.slice(-maxFilesPerDay)) keep.add(name);
    }
    const globallyLimited = [...keep].sort(compareAuditFiles).slice(-maxFiles);
    const finalKeep = new Set(globallyLimited);
    for (const name of names) {
      if (finalKeep.has(name)) continue;
      await unlink(path.join(dir, name)).catch(() => {});
    }
  }

  async function rotateFor(lineBytes) {
    let rotated = false;
    while (activeSize > 0 && activeSize + lineBytes > maxFileBytes) {
      activeFile = nextFile(activeDate, activeFile);
      const info = await stat(activeFile).catch(() => null);
      activeSize = info?.isFile() ? info.size : 0;
      rotated = true;
    }
    return rotated;
  }

  function append(record = {}) {
    if (!dir) return Promise.resolve({ written: false, reason: 'audit_disabled' });
    const payload = sanitizeNotifyAuditRecord({ ...base, ...record, scope: record.scope || scope, occurredAt: record.occurredAt || now() });
    const operation = chain.then(async () => {
      await ensureDir();
      const date = dateKey(payload.occurredAt);
      const initialized = activeDate !== date || !activeFile;
      if (initialized) await initializeActiveFile(date);
      else {
        const info = await stat(activeFile).catch(() => null);
        activeSize = info?.isFile() ? info.size : 0;
      }
      const line = `${JSON.stringify(payload)}\n`;
      const lineBytes = Buffer.byteLength(line);
      const rotated = await rotateFor(lineBytes);
      await appendFile(activeFile, line, { mode: 0o600 });
      activeSize += lineBytes;
      await chmod(activeFile, 0o600).catch(() => {});
      if (initialized || rotated) await prune();
      return { written: true, file: activeFile, record: payload };
    });
    chain = operation.catch((error) => {
      warn(`[notify-audit] write failed event=${payload.event} message=${clean(error.message, 300)}`);
    });
    return operation.catch((error) => ({ written: false, error: clean(error.message, 300), record: payload }));
  }

  async function readTail(tailLimit = 100) {
    await chain.catch(() => {});
    const wanted = limit(tailLimit, 100, 1000);
    const lines = [];
    const names = await fileNames();
    for (let index = names.length - 1; index >= 0 && lines.length < wanted; index -= 1) {
      const fileLines = await readTailLines(path.join(dir, names[index]), wanted - lines.length);
      if (fileLines.length > 0) lines.unshift(...fileLines);
    }
    return lines.slice(-wanted).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  }

  return {
    append,
    dir,
    readTail,
    status: async () => ({
      dir,
      files: (await files()).map((item) => ({ name: item.name, size: item.size })),
      maxFileBytes,
      maxFiles,
      maxDays,
      maxFilesPerDay,
      maxTotalBytes: maxFileBytes * maxFiles,
    }),
  };
}

async function readTailLines(file, wanted) {
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) return [];
  try {
    const info = await handle.stat();
    let position = info.size;
    let newlineCount = 0;
    const chunks = [];
    while (position > 0 && newlineCount <= wanted) {
      const length = Math.min(TAIL_READ_CHUNK_BYTES, position);
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      const chunk = buffer.subarray(0, bytesRead);
      chunks.unshift(chunk);
      for (const byte of chunk) if (byte === 10) newlineCount += 1;
    }
    let text = Buffer.concat(chunks).toString('utf8');
    if (position > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
    return text.split(/\r?\n/).filter(Boolean).slice(-wanted);
  } finally {
    await handle.close();
  }
}
