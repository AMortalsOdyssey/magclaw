import crypto from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_FILES = 30;
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
  const warn = options.warn || ((message) => process.stderr.write(`${message}\n`));
  let chain = Promise.resolve();

  async function ensureDir() {
    if (!dir) return false;
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700).catch(() => {});
    return true;
  }

  async function files() {
    if (!await ensureDir()) return [];
    const entries = await readdir(dir).catch(() => []);
    const records = [];
    for (const name of entries.filter(isAuditFile)) {
      const file = path.join(dir, name);
      const info = await stat(file).catch(() => null);
      if (info?.isFile()) records.push({ name, file, size: info.size });
    }
    return records.sort((left, right) => {
      const leftOrder = auditFileOrder(left.name);
      const rightOrder = auditFileOrder(right.name);
      return leftOrder.date.localeCompare(rightOrder.date) || leftOrder.index - rightOrder.index;
    });
  }

  async function currentFile(occurredAt) {
    const date = dateKey(occurredAt);
    const dated = (await files()).filter((item) => item.name.startsWith(`notify-audit-${date}`));
    const latest = dated.at(-1);
    if (!latest) return path.join(dir, auditFileName(date));
    if (latest.size < maxFileBytes) return latest.file;
    const suffix = latest.name.match(/-(\d{3})\.jsonl$/)?.[1];
    const nextIndex = suffix ? Number(suffix) + 1 : 1;
    return path.join(dir, auditFileName(date, nextIndex));
  }

  async function prune() {
    const existing = await files();
    for (const item of existing.slice(0, Math.max(0, existing.length - maxFiles))) await unlink(item.file).catch(() => {});
  }

  function append(record = {}) {
    if (!dir) return Promise.resolve({ written: false, reason: 'audit_disabled' });
    const payload = sanitizeNotifyAuditRecord({ ...base, ...record, scope: record.scope || scope, occurredAt: record.occurredAt || now() });
    const operation = chain.then(async () => {
      await ensureDir();
      const file = await currentFile(payload.occurredAt);
      await appendFile(file, `${JSON.stringify(payload)}\n`, { mode: 0o600 });
      await chmod(file, 0o600).catch(() => {});
      await prune();
      return { written: true, file, record: payload };
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
    const existing = await files();
    for (let index = existing.length - 1; index >= 0 && lines.length < wanted; index -= 1) {
      const item = existing[index];
      const text = await readFile(item.file, 'utf8').catch(() => '');
      if (text) lines.unshift(...text.split(/\r?\n/).filter(Boolean));
    }
    return lines.slice(-wanted).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  }

  return {
    append,
    dir,
    readTail,
    status: async () => ({ dir, files: (await files()).map((item) => ({ name: item.name, size: item.size })), maxFileBytes, maxFiles }),
  };
}
