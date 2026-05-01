import path from 'node:path';

// Shared path, text-list, and MIME helpers for server-side filesystem work.
// Keep traversal checks and display-path normalization here so project files,
// attachments, Agent workspaces, and static serving all follow the same rules.

export const CONTENT_TYPES = new Map([
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

export function splitLines(value) {
  if (Array.isArray(value)) return value.map(String).map((line) => line.trim()).filter(Boolean);
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function safeFileName(name) {
  return String(name || 'attachment')
    .replace(/[/\\?%*:|"<>]/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 120);
}

export function safePathWithin(base, target = '.') {
  const basePath = path.resolve(base);
  const resolved = path.resolve(basePath, target || '.');
  const relative = path.relative(basePath, resolved);
  if (relative && (relative.startsWith('..') || path.isAbsolute(relative))) return null;
  return resolved;
}

export function toPosixPath(value) {
  return String(value || '').replace(/\\/g, '/').split(path.sep).join('/');
}

export function decodePathSegment(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    return String(value || '');
  }
}

export function normalizeProjectRelPath(value) {
  return toPosixPath(decodePathSegment(value))
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/^\.\//, '');
}

export function baseNameFromProjectPath(value, fallback = 'project') {
  const parts = normalizeProjectRelPath(value).split('/').filter(Boolean);
  return parts.pop() || fallback;
}

export function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

export function mimeForPath(filePath, fallback = 'application/octet-stream') {
  const ext = path.extname(filePath).toLowerCase();
  if (CONTENT_TYPES.has(ext)) return CONTENT_TYPES.get(ext).replace(/;.*$/, '');
  if (ext === '.txt' || ext === '.md' || ext === '.log') return 'text/plain';
  if (ext === '.pdf') return 'application/pdf';
  if (ext === '.csv') return 'text/csv';
  if (ext === '.json') return 'application/json';
  if (ext === '.zip') return 'application/zip';
  return fallback;
}
