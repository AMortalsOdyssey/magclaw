import crypto from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { applyMarkdownOperation } from './markdown-document.js';
import { normalizeProjectRelPath, safePathWithin, toPosixPath } from './path-utils.js';

export const DEFAULT_MARKDOWN_OPLOG_SEGMENT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_MARKDOWN_OPLOG_SEGMENT_MAX_OPS = 10_000;

export function markdownContentHash(content) {
  return crypto.createHash('sha256').update(String(content || '')).digest('hex');
}

export function markdownSegmentFileName(index) {
  return `log-${String(Math.max(1, Number(index) || 1)).padStart(6, '0')}.jsonl`;
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

function normalizeRelPath(relPath) {
  const normalized = normalizeProjectRelPath(relPath || 'MEMORY.md');
  return normalized || 'MEMORY.md';
}

export function markdownOplogDir(root, relPath) {
  const normalized = normalizeRelPath(relPath);
  const target = path.join('.magclaw-ops', 'markdown', ...normalized.split('/'));
  return safePathWithin(root, target);
}

function manifestPath(root, relPath) {
  const dir = markdownOplogDir(root, relPath);
  return dir ? path.join(dir, 'manifest.json') : null;
}

async function atomicWriteFile(filePath, content) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, content);
  await rename(tmp, filePath);
}

export async function atomicWriteMarkdownFile(filePath, content) {
  await atomicWriteFile(filePath, content);
}

async function readJsonFile(filePath) {
  const text = await readFile(filePath, 'utf8');
  return JSON.parse(text);
}

async function writeManifest(root, relPath, manifest) {
  const filePath = manifestPath(root, relPath);
  if (!filePath) throw new Error('Invalid Markdown oplog manifest path.');
  await atomicWriteFile(filePath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export async function readMarkdownOplogManifest(root, relPath) {
  const filePath = manifestPath(root, relPath);
  if (!filePath) return null;
  return readJsonFile(filePath).catch(() => null);
}

function segmentIndexFromFile(name) {
  const match = String(name || '').match(/^log-(\d+)\.jsonl$/);
  return match ? Number(match[1]) : 0;
}

async function listSegmentFiles(root, relPath) {
  const dir = markdownOplogDir(root, relPath);
  if (!dir) return [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && /^log-\d+\.jsonl$/.test(entry.name))
    .map((entry) => ({ index: segmentIndexFromFile(entry.name), fileName: entry.name, filePath: path.join(dir, entry.name) }))
    .filter((entry) => entry.index > 0)
    .sort((a, b) => a.index - b.index);
}

export async function readMarkdownOperationRecords(root, relPath) {
  const records = [];
  for (const segment of await listSegmentFiles(root, relPath)) {
    const text = await readFile(segment.filePath, 'utf8').catch(() => '');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      records.push({ ...record, segmentIndex: record.segmentIndex || segment.index });
    }
  }
  return records.sort((a, b) => Number(a.sequence || 0) - Number(b.sequence || 0));
}

export async function rebuildMarkdownFromOplog(root, relPath) {
  let content = '';
  let revision = 0;
  let lastRecord = null;
  const records = await readMarkdownOperationRecords(root, relPath);
  for (const record of records) {
    content = applyMarkdownOperation(content, record.operation || {});
    revision = Number(record.revision || record.sequence || revision + 1);
    lastRecord = record;
  }
  return {
    content,
    revision,
    hash: markdownContentHash(content),
    records,
    lastRecord,
  };
}

function initialManifest({ relPath, initialContent, now, segmentMaxBytes, segmentMaxOps, lineBytes }) {
  const createdAt = now();
  return {
    version: 1,
    relPath: normalizeRelPath(relPath),
    revision: 1,
    documentHash: markdownContentHash(initialContent),
    currentSegment: 1,
    segmentMaxBytes,
    segmentMaxOps,
    segments: [{
      index: 1,
      fileName: markdownSegmentFileName(1),
      firstSequence: 1,
      lastSequence: 1,
      opCount: 1,
      bytes: lineBytes,
      createdAt,
      sealedAt: null,
    }],
    createdAt,
    updatedAt: createdAt,
  };
}

export async function ensureMarkdownDocumentLog(options = {}) {
  const root = options.root;
  const relPath = normalizeRelPath(options.relPath);
  const dir = markdownOplogDir(root, relPath);
  if (!dir) throw new Error('Invalid Markdown oplog directory.');
  await mkdir(dir, { recursive: true });
  const existing = await readMarkdownOplogManifest(root, relPath);
  if (existing) return existing;

  const existingRecords = await readMarkdownOperationRecords(root, relPath);
  if (existingRecords.length) {
    const rebuilt = await rebuildMarkdownFromOplog(root, relPath);
    const segmentFiles = await listSegmentFiles(root, relPath);
    const segments = [];
    for (const segment of segmentFiles) {
      const segmentRecords = existingRecords.filter((record) => Number(record.segmentIndex) === segment.index);
      const fileStat = await stat(segment.filePath).catch(() => ({ size: 0 }));
      segments.push({
        index: segment.index,
        fileName: segment.fileName,
        firstSequence: Number(segmentRecords[0]?.sequence || 0),
        lastSequence: Number(segmentRecords.at(-1)?.sequence || 0),
        opCount: segmentRecords.length,
        bytes: Number(fileStat.size || 0),
        createdAt: segmentRecords[0]?.createdAt || options.now?.() || new Date().toISOString(),
        sealedAt: segment.index === segmentFiles.at(-1)?.index ? null : (segmentRecords.at(-1)?.createdAt || null),
      });
    }
    const manifest = {
      version: 1,
      relPath,
      revision: rebuilt.revision,
      documentHash: rebuilt.hash,
      currentSegment: segmentFiles.at(-1)?.index || 1,
      segmentMaxBytes: normalizePositiveInteger(options.segmentMaxBytes, DEFAULT_MARKDOWN_OPLOG_SEGMENT_MAX_BYTES),
      segmentMaxOps: normalizePositiveInteger(options.segmentMaxOps, DEFAULT_MARKDOWN_OPLOG_SEGMENT_MAX_OPS),
      segments,
      createdAt: segments[0]?.createdAt || options.now?.() || new Date().toISOString(),
      updatedAt: options.now?.() || new Date().toISOString(),
    };
    await writeManifest(root, relPath, manifest);
    return manifest;
  }

  const now = options.now || (() => new Date().toISOString());
  const initialContent = String(options.initialContent || '');
  const record = {
    sequence: 1,
    revision: 1,
    segmentIndex: 1,
    operationId: options.initialOperationId || `op_initial_${crypto.randomBytes(6).toString('hex')}`,
    workspaceId: String(options.workspaceId || ''),
    agentId: String(options.agentId || ''),
    relPath,
    idempotencyKey: `initial:${relPath}`,
    operation: { type: 'initial_snapshot', markdown: initialContent },
    beforeHash: markdownContentHash(''),
    afterHash: markdownContentHash(initialContent),
    sourceTrigger: 'initial_snapshot',
    createdAt: now(),
    appliedAt: now(),
  };
  const line = `${JSON.stringify(record)}\n`;
  await writeFile(path.join(dir, markdownSegmentFileName(1)), line);
  const manifest = initialManifest({
    relPath,
    initialContent,
    now,
    segmentMaxBytes: normalizePositiveInteger(options.segmentMaxBytes, DEFAULT_MARKDOWN_OPLOG_SEGMENT_MAX_BYTES),
    segmentMaxOps: normalizePositiveInteger(options.segmentMaxOps, DEFAULT_MARKDOWN_OPLOG_SEGMENT_MAX_OPS),
    lineBytes: Buffer.byteLength(line),
  });
  await writeManifest(root, relPath, manifest);
  return manifest;
}

export async function findMarkdownOperationByIdempotencyKey(root, relPath, idempotencyKey) {
  const key = String(idempotencyKey || '').trim();
  if (!key) return null;
  const records = await readMarkdownOperationRecords(root, relPath);
  return records.find((record) => String(record.idempotencyKey || '') === key) || null;
}

function normalizedSegments(manifest) {
  return Array.isArray(manifest?.segments) ? manifest.segments : [];
}

export async function appendMarkdownOperationRecord(options = {}) {
  const root = options.root;
  const relPath = normalizeRelPath(options.relPath);
  const now = options.now || (() => new Date().toISOString());
  let manifest = await ensureMarkdownDocumentLog(options);
  const maxBytes = normalizePositiveInteger(manifest.segmentMaxBytes || options.segmentMaxBytes, DEFAULT_MARKDOWN_OPLOG_SEGMENT_MAX_BYTES);
  const maxOps = normalizePositiveInteger(manifest.segmentMaxOps || options.segmentMaxOps, DEFAULT_MARKDOWN_OPLOG_SEGMENT_MAX_OPS);
  let segmentIndex = normalizePositiveInteger(manifest.currentSegment, 1);
  let segments = normalizedSegments(manifest);
  let segment = segments.find((item) => Number(item.index) === segmentIndex);
  if (!segment) {
    segment = {
      index: segmentIndex,
      fileName: markdownSegmentFileName(segmentIndex),
      firstSequence: Number(manifest.revision || 0) + 1,
      lastSequence: 0,
      opCount: 0,
      bytes: 0,
      createdAt: now(),
      sealedAt: null,
    };
    segments = [...segments, segment];
  }

  const sequence = Number(manifest.revision || 0) + 1;
  const draft = {
    ...options.record,
    sequence,
    revision: sequence,
    segmentIndex,
    relPath,
    createdAt: options.record?.createdAt || now(),
    appliedAt: options.record?.appliedAt || now(),
  };
  let line = `${JSON.stringify(draft)}\n`;
  if (segment.opCount >= maxOps || (segment.bytes > 0 && segment.bytes + Buffer.byteLength(line) > maxBytes)) {
    segment.sealedAt = now();
    segmentIndex += 1;
    segment = {
      index: segmentIndex,
      fileName: markdownSegmentFileName(segmentIndex),
      firstSequence: sequence,
      lastSequence: 0,
      opCount: 0,
      bytes: 0,
      createdAt: now(),
      sealedAt: null,
    };
    segments = [...segments, segment];
    draft.segmentIndex = segmentIndex;
    line = `${JSON.stringify(draft)}\n`;
  }

  const dir = markdownOplogDir(root, relPath);
  if (!dir) throw new Error('Invalid Markdown oplog directory.');
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, segment.fileName), line);
  segment.opCount += 1;
  segment.bytes += Buffer.byteLength(line);
  segment.lastSequence = sequence;
  if (!segment.firstSequence) segment.firstSequence = sequence;
  manifest = {
    ...manifest,
    revision: sequence,
    documentHash: draft.afterHash || manifest.documentHash || '',
    currentSegment: segmentIndex,
    segmentMaxBytes: maxBytes,
    segmentMaxOps: maxOps,
    segments,
    updatedAt: now(),
  };
  await writeManifest(root, relPath, manifest);
  return { record: draft, manifest };
}

export function publicOplogPath(root, filePath) {
  return toPosixPath(path.relative(root, filePath));
}
