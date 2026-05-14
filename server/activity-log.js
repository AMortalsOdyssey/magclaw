import { appendFile, mkdir, readFile, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_MAX_FILES = 14;

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function dateKey(value) {
  const parsed = new Date(value || Date.now());
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString().slice(0, 10) : parsed.toISOString().slice(0, 10);
}

function activityFileName(date, index = 0) {
  return index > 0 ? `activity-${date}-${String(index).padStart(3, '0')}.jsonl` : `activity-${date}.jsonl`;
}

function isActivityFile(name) {
  return /^activity-\d{4}-\d{2}-\d{2}(?:-\d{3})?\.jsonl$/.test(String(name || ''));
}

function normalizeLimit(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

export function createActivityLog(options = {}) {
  const {
    dir,
    now = () => new Date().toISOString(),
    maxFileBytes = DEFAULT_MAX_FILE_BYTES,
    maxFiles = DEFAULT_MAX_FILES,
    warn = (...args) => console.warn(...args),
  } = options;
  const logDir = dir ? path.resolve(dir) : '';
  let writeChain = Promise.resolve();

  async function ensureDir() {
    if (!logDir) return false;
    await mkdir(logDir, { recursive: true });
    return true;
  }

  async function listFiles() {
    if (!await ensureDir()) return [];
    const entries = await readdir(logDir);
    const files = [];
    for (const name of entries.filter(isActivityFile)) {
      const file = path.join(logDir, name);
      try {
        const info = await stat(file);
        files.push({ name, file, mtimeMs: info.mtimeMs, size: info.size });
      } catch {
        // File disappeared during rotation/pruning; ignore it.
      }
    }
    return files.sort((a, b) => a.name.localeCompare(b.name));
  }

  async function currentFile(createdAt) {
    const date = dateKey(createdAt || now());
    for (let index = 0; index < 1000; index += 1) {
      const file = path.join(logDir, activityFileName(date, index));
      try {
        const info = await stat(file);
        if (info.size < maxFileBytes) return file;
      } catch {
        return file;
      }
    }
    return path.join(logDir, activityFileName(date, Date.now() % 1000));
  }

  async function prune() {
    const files = await listFiles();
    const keep = normalizeLimit(maxFiles, DEFAULT_MAX_FILES);
    const extra = files.length - keep;
    if (extra <= 0) return;
    for (const item of files.slice(0, extra)) {
      await unlink(item.file).catch(() => {});
    }
  }

  function append(record) {
    if (!logDir || !record) return Promise.resolve();
    writeChain = writeChain
      .then(async () => {
        await ensureDir();
        const payload = {
          ...record,
          createdAt: record.createdAt || now(),
        };
        const file = await currentFile(payload.createdAt);
        await appendFile(file, `${JSON.stringify(payload)}\n`);
        await prune();
      })
      .catch((error) => {
        warn(`[activity-log] write failed: ${error.message}`);
      });
    return writeChain;
  }

  async function readTail(limit = 1200) {
    const files = await listFiles();
    const lines = [];
    for (const item of files.slice(-normalizeLimit(maxFiles, DEFAULT_MAX_FILES))) {
      const text = await readFile(item.file, 'utf8').catch(() => '');
      if (!text) continue;
      lines.push(...text.split(/\r?\n/).filter(Boolean));
    }
    const records = lines
      .slice(-normalizeLimit(limit, 1200))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return safeArray(records);
  }

  function flush() {
    return writeChain;
  }

  return {
    append,
    flush,
    readTail,
  };
}
