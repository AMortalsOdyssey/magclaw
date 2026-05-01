import crypto from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  baseNameFromProjectPath,
  normalizeProjectRelPath,
  safeFileName,
  safePathWithin,
} from './path-utils.js';
import {
  listProjectTree as listProjectTreeBase,
  readProjectFilePreview as readProjectFilePreviewBase,
  searchProject,
  sortProjectSearchResults,
} from './project-files.js';

// HTTP request helpers plus local attachment/project reference utilities.
// API route modules depend on this small surface for JSON IO, cloud-token
// enforcement, uploads, and resolving @file/@folder project references.
export function createServerIo(deps) {
  const {
    addSystemEvent,
    getState,
    makeId,
    now,
    ATTACHMENTS_DIR,
    MAX_JSON_BYTES,
  } = deps;
  const state = new Proxy({}, {
    get(_target, prop) { return getState()[prop]; },
    set(_target, prop, value) { getState()[prop] = value; return true; },
  });

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
  
  function attachmentPeriod(createdAt = new Date()) {
    const date = createdAt instanceof Date ? createdAt : new Date(createdAt);
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, '0');
    return { year, month, relativeDir: `${year}/${month}` };
  }
  
  async function saveAttachmentBuffer({ name, type, buffer, source = 'upload', extra = {} }) {
    const id = makeId('att');
    const createdAt = now();
    const safeName = safeFileName(name);
    const period = attachmentPeriod(new Date(createdAt));
    const diskName = `${id}-${safeName}`;
    const dir = path.join(ATTACHMENTS_DIR, period.relativeDir);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, diskName);
    await writeFile(filePath, buffer);
    return {
      id,
      name: safeName,
      type: type || 'application/octet-stream',
      bytes: buffer.length,
      path: filePath,
      relativePath: `${period.relativeDir}/${diskName}`,
      source,
      url: `/api/attachments/${id}/${encodeURIComponent(safeName)}`,
      createdAt,
      ...extra,
    };
  }
  
  function findProject(id) {
    return state.projects.find((project) => project.id === id);
  }
  
  function projectsForSpace(spaceType, spaceId) {
    return (state.projects || []).filter((project) => (
      project.spaceType === spaceType && project.spaceId === spaceId
    ));
  }
  
  async function searchProjectItems(spaceType, spaceId, query) {
    const projects = projectsForSpace(spaceType, spaceId);
    const batches = await Promise.all(projects.map((project) => searchProject(project, query, {
      onError: addSystemEvent,
    })));
    return sortProjectSearchResults(query, batches.flat());
  }
  
  function projectReferenceFromParts(kind, projectId, rawRelPath) {
    const project = findProject(String(projectId || ''));
    if (!project) return null;
    const referenceKind = kind === 'folder' ? 'folder' : 'file';
    const relPath = normalizeProjectRelPath(rawRelPath);
    const absolutePath = safePathWithin(project.path, relPath || '.');
    if (!absolutePath) return null;
    return {
      id: `${referenceKind}:${project.id}:${relPath}`,
      kind: referenceKind,
      projectId: project.id,
      projectName: project.name,
      name: relPath ? baseNameFromProjectPath(relPath, project.name) : project.name,
      path: relPath,
      absolutePath,
      token: `<#${referenceKind}:${project.id}:${encodeURIComponent(relPath)}>`,
    };
  }
  
  function extractLocalReferences(text) {
    const refs = [];
    const seen = new Set();
    const matches = String(text || '').matchAll(/<#(file|folder):([^:>]+):([^>]*)>/g);
    for (const match of matches) {
      const ref = projectReferenceFromParts(match[1], match[2], match[3]);
      if (!ref || seen.has(ref.id)) continue;
      seen.add(ref.id);
      refs.push(ref);
    }
    return refs;
  }
  
  function localReferenceLines(refs = []) {
    return refs.length
      ? refs.map((ref) => `- ${ref.kind} ${ref.name}: ${ref.absolutePath}`).join('\n')
      : '';
  }
  
  function listProjectTree(project, rawRelPath = '') {
    return listProjectTreeBase(project, rawRelPath, { onError: addSystemEvent });
  }
  
  function readProjectFilePreview(project, rawRelPath = '') {
    return readProjectFilePreviewBase(project, rawRelPath);
  }

  return {
    extractLocalReferences,
    findProject,
    listProjectTree,
    localReferenceLines,
    projectReferenceFromParts,
    projectsForSpace,
    readJson,
    readProjectFilePreview,
    requireCloudAccess,
    requireCloudDeploymentApi,
    saveAttachmentBuffer,
    searchProjectItems,
    sendError,
    sendJson,
  };
}
