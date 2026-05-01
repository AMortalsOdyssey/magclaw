import { createReadStream } from 'node:fs';

// Project and attachment API routes.
// This route group owns local project folder registration, project search/tree
// previews, and attachment upload/download. It receives app state and side
// effects through dependencies so index.js can stay a thin HTTP dispatcher.

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
  } = deps;
  const state = getState();

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
      });
      state.attachments.push(attachment);
      created.push(attachment);
    }

    addSystemEvent('attachments_added', `${created.length} attachment(s) added.`);
    await persistState();
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
    res.writeHead(200, {
      'content-type': attachment.type || 'application/octet-stream',
      'content-length': attachment.bytes,
      'cache-control': 'private, max-age=3600',
    });
    createReadStream(attachment.path).pipe(res);
    return true;
  }

  return false;
}
