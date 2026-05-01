import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  baseNameFromProjectPath,
  httpError,
  mimeForPath,
  normalizeProjectRelPath,
  safePathWithin,
  toPosixPath,
} from './path-utils.js';

// Project filesystem adapter.
// Routes and UI code ask this module for bounded project search, tree listings,
// and previews. The module does not know about global app state; callers pass a
// project record and optional error hook, which keeps index.js focused on HTTP
// and state orchestration.

const DEFAULT_LIMITS = {
  searchResults: 80,
  scanEntries: 4000,
  searchDepth: 8,
  treeEntries: 300,
  previewBytes: 2 * 1024 * 1024,
};

const PROJECT_SEARCH_EXCLUDES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.magclaw',
  'node_modules',
  '.next',
  'dist',
  'build',
  'target',
  '.venv',
  '__pycache__',
]);

const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd']);
const TEXT_PREVIEW_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.markdown',
  '.mdown',
  '.mkd',
  '.log',
  '.csv',
  '.json',
  '.jsonl',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.css',
  '.html',
  '.xml',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.sh',
  '.zsh',
  '.bash',
  '.py',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.cpp',
  '.h',
  '.hpp',
]);

function projectLimits(overrides = {}) {
  return {
    ...DEFAULT_LIMITS,
    ...Object.fromEntries(Object.entries(overrides).filter(([, value]) => Number.isFinite(value))),
  };
}

export function projectRelativePath(project, absolutePath) {
  return toPosixPath(path.relative(project.path, absolutePath));
}

export function fuzzyIncludes(query, value) {
  const q = String(query || '').toLowerCase();
  const target = String(value || '').toLowerCase();
  if (!q) return true;
  if (target.includes(q)) return true;
  let cursor = 0;
  for (const char of q) {
    cursor = target.indexOf(char, cursor);
    if (cursor < 0) return false;
    cursor += 1;
  }
  return true;
}

export function projectSearchScore(query, item) {
  const q = String(query || '').toLowerCase();
  const name = item.name.toLowerCase();
  const rel = item.path.toLowerCase();
  if (!q) return item.kind === 'folder' ? 1 : 2;
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.includes(q)) return 2;
  if (rel.includes(q)) return 3;
  return 4;
}

export function sortProjectSearchResults(query, results, maxResults = DEFAULT_LIMITS.searchResults) {
  return [...results]
    .sort((a, b) => projectSearchScore(query, a) - projectSearchScore(query, b)
      || (a.kind === b.kind ? a.path.localeCompare(b.path) : a.kind === 'folder' ? -1 : 1))
    .slice(0, maxResults);
}

export async function searchProject(project, query, options = {}) {
  const limits = projectLimits(options.limits);
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const results = [];
  const queue = [{ dir: project.path, depth: 0 }];
  let scanned = 0;

  while (queue.length && scanned < limits.scanEntries && results.length < limits.searchResults * 3) {
    const current = queue.shift();
    let entries = [];
    try {
      entries = await readdir(current.dir, { withFileTypes: true });
    } catch (error) {
      onError('project_scan_skipped', `Could not scan ${project.name}: ${error.message}`, {
        projectId: project.id,
        path: current.dir,
      });
      continue;
    }

    for (const entry of entries) {
      if (scanned >= limits.scanEntries) break;
      if (PROJECT_SEARCH_EXCLUDES.has(entry.name)) continue;
      scanned += 1;

      const absolutePath = path.join(current.dir, entry.name);
      const relPath = projectRelativePath(project, absolutePath);
      const isDirectory = entry.isDirectory();
      if (fuzzyIncludes(query, `${entry.name} ${relPath}`)) {
        results.push({
          id: `${project.id}:${relPath}`,
          projectId: project.id,
          projectName: project.name,
          name: entry.name,
          path: relPath,
          absolutePath,
          kind: isDirectory ? 'folder' : 'file',
        });
      }
      if (isDirectory && current.depth < limits.searchDepth) {
        queue.push({ dir: absolutePath, depth: current.depth + 1 });
      }
    }
  }

  return sortProjectSearchResults(query, results, limits.searchResults);
}

export function projectEntry(project, relPath, info) {
  const isDirectory = info.isDirectory();
  return {
    id: `${project.id}:${relPath}`,
    projectId: project.id,
    projectName: project.name,
    name: baseNameFromProjectPath(relPath, project.name),
    path: relPath,
    kind: isDirectory ? 'folder' : 'file',
    type: isDirectory ? 'folder' : mimeForPath(relPath),
    bytes: isDirectory ? 0 : info.size,
    updatedAt: info.mtime.toISOString(),
  };
}

export async function listProjectTree(project, rawRelPath = '', options = {}) {
  const limits = projectLimits(options.limits);
  const onError = typeof options.onError === 'function' ? options.onError : () => {};
  const relPath = normalizeProjectRelPath(rawRelPath);
  const dirPath = safePathWithin(project.path, relPath || '.');
  if (!dirPath) throw httpError(400, 'Project tree path must stay inside the project folder.');
  const info = await stat(dirPath).catch(() => null);
  if (!info) throw httpError(404, 'Project tree path was not found.');
  if (!info.isDirectory()) throw httpError(400, 'Project tree path must be a directory.');

  const dirEntries = (await readdir(dirPath, { withFileTypes: true }))
    .filter((entry) => !PROJECT_SEARCH_EXCLUDES.has(entry.name))
    .sort((a, b) => (a.isDirectory() === b.isDirectory()
      ? a.name.localeCompare(b.name)
      : a.isDirectory() ? -1 : 1))
    .slice(0, limits.treeEntries);

  const entries = [];
  for (const entry of dirEntries) {
    const childRelPath = toPosixPath(path.join(relPath, entry.name)).replace(/^\/+/, '');
    const childPath = safePathWithin(project.path, childRelPath);
    if (!childPath) continue;
    try {
      entries.push(projectEntry(project, childRelPath, await stat(childPath)));
    } catch (error) {
      onError('project_tree_entry_skipped', `Could not inspect ${entry.name}: ${error.message}`, {
        projectId: project.id,
        path: childRelPath,
      });
    }
  }

  return {
    project: {
      id: project.id,
      name: project.name,
      path: project.path,
    },
    path: relPath,
    entries,
    truncated: dirEntries.length >= limits.treeEntries,
  };
}

export function projectFilePreviewKind(filePath, buffer) {
  const ext = path.extname(filePath).toLowerCase();
  if (MARKDOWN_EXTENSIONS.has(ext)) return 'markdown';
  if (TEXT_PREVIEW_EXTENSIONS.has(ext)) return 'text';
  if (buffer.includes(0)) return 'binary';
  const sample = buffer.subarray(0, Math.min(buffer.length, 2048)).toString('utf8');
  return sample.includes('\uFFFD') ? 'binary' : 'text';
}

export async function readProjectFilePreview(project, rawRelPath = '', options = {}) {
  const limits = projectLimits(options.limits);
  const relPath = normalizeProjectRelPath(rawRelPath);
  const filePath = safePathWithin(project.path, relPath);
  if (!filePath) throw httpError(400, 'Project file path must stay inside the project folder.');
  const info = await stat(filePath).catch(() => null);
  if (!info) throw httpError(404, 'Project file was not found.');
  if (!info.isFile()) throw httpError(400, 'Project preview path must be a file.');
  if (info.size > limits.previewBytes) {
    throw httpError(413, `File preview is limited to ${limits.previewBytes} bytes.`);
  }

  const buffer = await readFile(filePath);
  const previewKind = projectFilePreviewKind(filePath, buffer);
  return {
    file: {
      id: `file:${project.id}:${relPath}`,
      projectId: project.id,
      projectName: project.name,
      name: baseNameFromProjectPath(relPath, project.name),
      path: relPath,
      absolutePath: filePath,
      type: mimeForPath(filePath),
      bytes: info.size,
      updatedAt: info.mtime.toISOString(),
      previewKind,
      content: previewKind === 'binary' ? '' : buffer.toString('utf8'),
    },
  };
}
