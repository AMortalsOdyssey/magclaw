import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { attachmentPathWithinStorage } from '../path-utils.js';

// Project and attachment API routes.
// This route group owns local project folder registration, project search/tree
// previews, and attachment upload/download. It receives app state and side
// effects through dependencies so index.js can stay a thin HTTP dispatcher.

function parseAttachmentRange(rangeHeader, size) {
  const value = String(rangeHeader || '').trim();
  if (!value || !Number.isFinite(size) || size < 0) return null;
  const match = value.match(/^bytes=(\d*)-(\d*)$/i);
  if (!match) return { unsatisfiable: true };
  let [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return { unsatisfiable: true };
  if (!size) return { unsatisfiable: true };

  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { unsatisfiable: true };
    const start = Math.max(0, size - suffixLength);
    return { start, end: size - 1 };
  }

  const start = Number(rawStart);
  const end = rawEnd ? Number(rawEnd) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
    return { unsatisfiable: true };
  }
  return { start, end: Math.min(end, size - 1) };
}

export async function handleProjectApi(req, res, url, deps) {
  const {
    addProjectFolder,
    addSystemEvent,
    broadcastState,
    decodePathSegment,
    defaultWorkspace,
    findProject,
    getState,
    listProjectTree,
    maxAttachmentUploads,
    persistState,
    pickFolderPath,
    readJson,
    readProjectFilePreview,
    saveAttachmentBuffer,
    searchProjectItems,
    selectedDefaultSpaceId,
    sendError,
    sendJson,
    attachmentStorageDir,
    currentActor,
  } = deps;
  const state = getState();

  function attachmentFilePath(attachment = {}) {
    return attachmentPathWithinStorage(attachment, attachmentStorageDir);
  }

  function scopedAttachmentUrl(attachment = {}, workspaceId = '') {
    const id = String(attachment.id || '').trim();
    if (!id) return '';
    const name = attachment.name || attachment.filename || 'attachment';
    const base = `/api/attachments/${id}/${encodeURIComponent(name)}`;
    const scope = String(workspaceId || '').trim();
    return scope ? `${base}?workspaceId=${encodeURIComponent(scope)}` : base;
  }

  if (req.method === 'POST' && url.pathname === '/api/projects') {
    const body = await readJson(req);
    try {
      const result = await addProjectFolder({
        rawPath: body.path,
        name: body.name,
        spaceType: body.spaceType,
        spaceId: body.spaceId,
      });
      sendJson(res, result.created ? 201 : 200, result);
    } catch (error) {
      sendError(res, error.status || 500, error.message);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/projects/pick-folder') {
    const body = await readJson(req);
    try {
      const pickedPath = await pickFolderPath(body.defaultPath || state.settings?.defaultWorkspace || defaultWorkspace);
      if (!pickedPath) {
        sendJson(res, 200, { canceled: true });
        return true;
      }
      const result = await addProjectFolder({
        rawPath: pickedPath,
        name: body.name,
        spaceType: body.spaceType,
        spaceId: body.spaceId,
      });
      sendJson(res, result.created ? 201 : 200, { canceled: false, ...result });
    } catch (error) {
      addSystemEvent('project_picker_failed', `Project folder picker failed: ${error.message}`);
      sendError(res, error.status || 500, error.message);
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/projects/search') {
    const spaceType = url.searchParams.get('spaceType') === 'dm' ? 'dm' : 'channel';
    const spaceId = url.searchParams.get('spaceId') || selectedDefaultSpaceId(spaceType);
    const query = url.searchParams.get('q') || '';
    const items = await searchProjectItems(spaceType, spaceId, query);
    sendJson(res, 200, { items });
    return true;
  }

  const projectTreeMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/tree$/);
  if (req.method === 'GET' && projectTreeMatch) {
    const project = findProject(decodePathSegment(projectTreeMatch[1]));
    if (!project) {
      sendError(res, 404, 'Project not found.');
      return true;
    }
    try {
      sendJson(res, 200, await listProjectTree(project, url.searchParams.get('path') || ''));
    } catch (error) {
      addSystemEvent('project_tree_failed', `Project tree failed: ${error.message}`, {
        projectId: project.id,
        path: url.searchParams.get('path') || '',
      });
      sendError(res, error.status || 500, error.message);
    }
    return true;
  }

  const projectFileMatch = url.pathname.match(/^\/api\/projects\/([^/]+)\/file$/);
  if (req.method === 'GET' && projectFileMatch) {
    const project = findProject(decodePathSegment(projectFileMatch[1]));
    if (!project) {
      sendError(res, 404, 'Project not found.');
      return true;
    }
    try {
      sendJson(res, 200, await readProjectFilePreview(project, url.searchParams.get('path') || ''));
    } catch (error) {
      addSystemEvent('project_file_preview_failed', `Project file preview failed: ${error.message}`, {
        projectId: project.id,
        path: url.searchParams.get('path') || '',
      });
      sendError(res, error.status || 500, error.message);
    }
    return true;
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/projects/')) {
    const [, , , id] = url.pathname.split('/');
    const project = findProject(id);
    if (!project) {
      sendError(res, 404, 'Project not found.');
      return true;
    }
    state.projects = state.projects.filter((item) => item.id !== id);
    addSystemEvent('project_removed', `Project folder removed: ${project.name}`, { projectId: project.id });
    await persistState();
    broadcastState();
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/attachments') {
    const body = await readJson(req);
    const files = Array.isArray(body.files) ? body.files : [];
    if (files.length > maxAttachmentUploads) {
      sendError(res, 400, `A single upload can include at most ${maxAttachmentUploads} files.`);
      return true;
    }
    const actor = typeof currentActor === 'function' ? currentActor(req) : null;
    const workspaceId = String(
      actor?.member?.workspaceId
      || body.workspaceId
      || state.connection?.workspaceId
      || state.cloud?.workspace?.id
      || '',
    ).trim();
    const createdBy = String(actor?.member?.humanId || '').trim();
    const created = [];

    for (const file of files) {
      const match = String(file.dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
      if (!match) continue;
      const type = match[1];
      const buffer = Buffer.from(match[2], 'base64');
      const attachment = await saveAttachmentBuffer({
        name: file.name,
        type,
        buffer,
        source: file.source === 'clipboard' ? 'clipboard' : 'upload',
        extra: {
          ...(workspaceId ? { workspaceId, serverId: workspaceId } : {}),
          ...(createdBy ? { createdBy } : {}),
        },
      });
      if (workspaceId) attachment.url = scopedAttachmentUrl(attachment, workspaceId);
      state.attachments.push(attachment);
      created.push(attachment);
    }

    addSystemEvent('attachments_added', `${created.length} attachment(s) added.`);
    await persistState(workspaceId ? { workspaceId, reason: 'attachments_added' } : { reason: 'attachments_added' });
    broadcastState();
    sendJson(res, 201, { attachments: created });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/attachments/reference') {
    addSystemEvent('attachment_reference_rejected', 'Project file references stay local and are not copied into attachments.');
    sendError(res, 410, 'Project file references stay local. Use @ file/folder tokens instead of creating attachment copies.');
    return true;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/attachments/')) {
    const [, , , id] = url.pathname.split('/');
    const attachment = state.attachments.find((item) => item.id === id);
    if (!attachment) {
      sendError(res, 404, 'Attachment not found.');
      return true;
    }
    const filePath = attachmentFilePath(attachment);
    if (!filePath) {
      sendError(res, 404, 'Attachment file is unavailable.');
      return true;
    }
    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch {
      sendError(res, 404, 'Attachment file is unavailable.');
      return true;
    }
    attachment.path = filePath;
    const size = Number(fileStat.size || attachment.bytes || attachment.sizeBytes || attachment.size || 0);
    const baseHeaders = {
      'content-type': attachment.type || 'application/octet-stream',
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=3600',
    };
    const range = parseAttachmentRange(req.headers?.range, size);
    if (range?.unsatisfiable) {
      res.writeHead(416, {
        ...baseHeaders,
        'content-range': `bytes */${size}`,
      });
      res.end?.();
      return true;
    }
    if (range) {
      const contentLength = range.end - range.start + 1;
      res.writeHead(206, {
        ...baseHeaders,
        'content-length': contentLength,
        'content-range': `bytes ${range.start}-${range.end}/${size}`,
      });
      createReadStream(filePath, { start: range.start, end: range.end }).pipe(res);
      return true;
    }
    res.writeHead(200, {
      ...baseHeaders,
      'content-length': size,
    });
    createReadStream(filePath).pipe(res);
    return true;
  }

  return false;
}
