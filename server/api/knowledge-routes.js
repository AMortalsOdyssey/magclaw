import {
  alignKnowledgeDiscussion,
  askKnowledgeConsensus,
  createKnowledgeChangeSession,
  ensureKnowledgeSpace,
  getKnowledgeChangelog,
  getKnowledgeDocument,
  getKnowledgeGraph,
  importKnowledgeMarkdown,
  isKnowledgeAdmin,
  isKnowledgeWhitelisted,
  moveKnowledgeSessionToDiff,
  moveKnowledgeSessionToPreview,
  publicKnowledgeSpace,
  publishKnowledgeSession,
  sendKnowledgePublishNotification,
  updateKnowledgeSettings,
} from '../knowledge-space.js';

function cleanString(value) {
  return String(value || '').trim();
}

function actorHumanId(actor) {
  return cleanString(actor?.member?.humanId || actor?.user?.id || actor?.userId || actor?.humanId || 'local');
}

function localOwnerActor(workspaceId = 'local') {
  return {
    user: { id: 'local', name: 'Local User' },
    member: { workspaceId, humanId: 'local', role: 'owner', status: 'active' },
  };
}

function workspaceIdFromRequest(deps, req, actor) {
  const state = deps.getState();
  return cleanString(
    actor?.member?.workspaceId
    || state.connection?.workspaceId
    || state.cloud?.workspace?.id
    || state.cloud?.workspaces?.[0]?.id
    || req?.headers?.['x-magclaw-workspace-id']
    || 'local',
  ) || 'local';
}

function loginRequired(deps) {
  return typeof deps.isLoginRequired === 'function' ? Boolean(deps.isLoginRequired()) : false;
}

function currentKnowledgeActor(deps, req) {
  const actor = typeof deps.currentActor === 'function' ? deps.currentActor(req) : null;
  if (actor?.member) return actor;
  if (!loginRequired(deps)) return localOwnerActor(workspaceIdFromRequest(deps, req, actor));
  return actor;
}

function publicBaseUrlFromRequest(req) {
  const forwardedProto = cleanString(req?.headers?.['x-forwarded-proto']).split(',')[0] || '';
  const proto = forwardedProto || (req?.socket?.encrypted ? 'https' : 'http');
  const host = cleanString(req?.headers?.['x-forwarded-host']).split(',')[0] || cleanString(req?.headers?.host);
  return host ? `${proto}://${host}` : '';
}

function publicMembers(state, workspaceId) {
  const humans = Array.isArray(state.humans) ? state.humans : [];
  const memberships = Array.isArray(state.cloud?.workspaceMembers) ? state.cloud.workspaceMembers : [];
  const cloudUsers = Array.isArray(state.cloud?.users) ? state.cloud.users : [];
  const roleByHuman = new Map();
  for (const member of memberships) {
    if (cleanString(member.workspaceId) !== workspaceId) continue;
    const humanId = cleanString(member.humanId || member.userId);
    if (!humanId) continue;
    roleByHuman.set(humanId, member.role || 'member');
  }
  const rows = humans
    .filter((human) => !human.workspaceId || cleanString(human.workspaceId) === workspaceId)
    .map((human) => ({
      id: human.id,
      name: human.name || human.displayName || human.email || human.id,
      email: human.email || '',
      role: roleByHuman.get(human.id) || 'member',
    }));
  if (!rows.length) {
    for (const member of memberships) {
      if (cleanString(member.workspaceId) !== workspaceId) continue;
      const user = cloudUsers.find((item) => item.id === member.userId) || {};
      rows.push({
        id: member.humanId || member.userId,
        name: user.name || user.email || member.humanId || member.userId,
        email: user.email || '',
        role: member.role || 'member',
      });
    }
  }
  if (!rows.length && workspaceId === 'local') rows.push({ id: 'local', name: 'Local User', email: '', role: 'owner' });
  return rows;
}

function ensureMember(deps, req, res) {
  const actor = currentKnowledgeActor(deps, req);
  if (actor?.member) return actor;
  deps.sendError(res, 401, 'Knowledge Space requires a signed-in Server member.');
  return null;
}

function ensureAdmin(deps, req, res) {
  const actor = ensureMember(deps, req, res);
  if (!actor) return null;
  if (isKnowledgeAdmin(actor)) return actor;
  deps.sendError(res, 403, 'Only Server owners/admins can manage Knowledge Space settings.');
  return null;
}

function ensureEditor(deps, req, res, space) {
  const actor = ensureMember(deps, req, res);
  if (!actor) return null;
  if (isKnowledgeWhitelisted(space, actor)) return actor;
  deps.sendError(res, 403, 'Only Knowledge Space whitelist members can change content.');
  return null;
}

function sendKnowledgeSpace(deps, res, state, space, actor, statusCode = 200, extra = {}) {
  deps.sendJson(res, statusCode, {
    space: publicKnowledgeSpace(space, actor),
    members: publicMembers(state, space.workspaceId),
    ...extra,
  });
}

async function persistAndNotify(deps, eventType, eventMessage, metadata = {}) {
  if (typeof deps.addSystemEvent === 'function') deps.addSystemEvent(eventType, eventMessage, metadata);
  if (typeof deps.persistState === 'function') await deps.persistState({ reason: eventType });
  if (typeof deps.broadcastState === 'function') deps.broadcastState();
}

async function parseBody(deps, req) {
  if (typeof deps.readJson === 'function') return await deps.readJson(req);
  return {};
}

function routeSessionId(pathname, suffix) {
  const match = pathname.match(/^\/api\/knowledge\/change-sessions\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) return '';
  if (suffix && match[2] !== suffix) return '';
  return decodeURIComponent(match[1] || '');
}

export async function handleKnowledgeApi(req, res, url, deps) {
  if (!url.pathname.startsWith('/api/knowledge')) return false;
  const state = deps.getState();
  const actor = currentKnowledgeActor(deps, req);
  const workspaceId = workspaceIdFromRequest(deps, req, actor);
  const space = ensureKnowledgeSpace(state, workspaceId, { now: deps.now });

  try {
    if (req.method === 'GET' && url.pathname === '/api/knowledge/space') {
      const member = ensureMember(deps, req, res);
      if (!member) return true;
      sendKnowledgeSpace(deps, res, state, space, member);
      return true;
    }

    if (req.method === 'GET' && url.pathname.startsWith('/api/knowledge/docs/')) {
      const member = ensureMember(deps, req, res);
      if (!member) return true;
      const docId = decodeURIComponent(url.pathname.slice('/api/knowledge/docs/'.length));
      const doc = getKnowledgeDocument(space, docId);
      if (!doc) {
        deps.sendError(res, 404, 'Knowledge document not found.');
        return true;
      }
      deps.sendJson(res, 200, { document: doc, space: publicKnowledgeSpace(space, member) });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/knowledge/graph') {
      const member = ensureMember(deps, req, res);
      if (!member) return true;
      deps.sendJson(res, 200, { graph: getKnowledgeGraph(space, { now: deps.now?.() }) });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/knowledge/changelog') {
      const member = ensureMember(deps, req, res);
      if (!member) return true;
      deps.sendJson(res, 200, {
        changelog: getKnowledgeChangelog(space, url.searchParams.get('page') || 1, url.searchParams.get('limit') || 100),
      });
      return true;
    }

    if (req.method === 'GET' && url.pathname === '/api/knowledge/settings') {
      const member = ensureMember(deps, req, res);
      if (!member) return true;
      deps.sendJson(res, 200, {
        settings: publicKnowledgeSpace(space, member).settings,
        members: publicMembers(state, space.workspaceId),
      });
      return true;
    }

    if (req.method === 'PATCH' && url.pathname === '/api/knowledge/settings') {
      const admin = ensureAdmin(deps, req, res);
      if (!admin) return true;
      const body = await parseBody(deps, req);
      const result = updateKnowledgeSettings({
        state,
        workspaceId,
        patch: body || {},
        actor: admin,
        now: deps.now,
        env: deps.env || process.env,
      });
      await persistAndNotify(deps, 'knowledge_settings_updated', 'Knowledge Space settings updated.', { workspaceId });
      deps.sendJson(res, 200, { settings: result.settings, space: publicKnowledgeSpace(result.space, admin) });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/knowledge/import') {
      const admin = ensureAdmin(deps, req, res);
      if (!admin) return true;
      const body = await parseBody(deps, req);
      const result = importKnowledgeMarkdown({
        state,
        workspaceId,
        markdown: body.markdown || '',
        sourceName: body.sourceName || body.title || '',
        sourceUrl: body.sourceUrl || '',
        actor: admin,
        now: deps.now,
      });
      await persistAndNotify(
        deps,
        result.mode === 'draft' ? 'knowledge_import_drafted' : 'knowledge_imported',
        result.mode === 'draft'
          ? 'Knowledge Space re-import created a review draft.'
          : 'Knowledge Space Markdown imported.',
        {
          workspaceId,
          mode: result.mode,
          documents: result.imported.documents,
          anchors: result.imported.anchors,
        },
      );
      sendKnowledgeSpace(deps, res, state, result.space, admin, 201, { session: result.session, imported: result.imported, mode: result.mode });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/knowledge/change-sessions') {
      const editor = ensureEditor(deps, req, res, space);
      if (!editor) return true;
      const body = await parseBody(deps, req);
      const result = createKnowledgeChangeSession({
        state,
        workspaceId,
        summary: body.summary || '',
        changes: Array.isArray(body.changes) ? body.changes : [],
        actor: editor,
        now: deps.now,
      });
      await persistAndNotify(deps, 'knowledge_change_session_created', 'Knowledge Space draft created.', { workspaceId, changeSessionId: result.session.id });
      deps.sendJson(res, 201, { session: result.session, space: publicKnowledgeSpace(result.space, editor) });
      return true;
    }

    const toDiffId = req.method === 'POST' ? routeSessionId(url.pathname, 'to-diff') : '';
    if (toDiffId) {
      const editor = ensureEditor(deps, req, res, space);
      if (!editor) return true;
      const result = moveKnowledgeSessionToDiff({ state, workspaceId, sessionId: toDiffId, now: deps.now });
      await persistAndNotify(deps, 'knowledge_change_session_diff', 'Knowledge Space draft moved to diff.', { workspaceId, changeSessionId: toDiffId });
      deps.sendJson(res, 200, { session: result.session, space: publicKnowledgeSpace(result.space, editor) });
      return true;
    }

    const toPreviewId = req.method === 'POST' ? routeSessionId(url.pathname, 'to-preview') : '';
    if (toPreviewId) {
      const editor = ensureEditor(deps, req, res, space);
      if (!editor) return true;
      const result = moveKnowledgeSessionToPreview({ state, workspaceId, sessionId: toPreviewId, now: deps.now });
      await persistAndNotify(deps, 'knowledge_change_session_preview', 'Knowledge Space diff moved to preview.', { workspaceId, changeSessionId: toPreviewId });
      deps.sendJson(res, 200, { session: result.session, space: publicKnowledgeSpace(result.space, editor) });
      return true;
    }

    const publishId = req.method === 'POST' ? routeSessionId(url.pathname, 'publish') : '';
    if (publishId) {
      const editor = ensureEditor(deps, req, res, space);
      if (!editor) return true;
      const result = await publishKnowledgeSession({
        state,
        workspaceId,
        sessionId: publishId,
        actor: editor,
        now: deps.now,
        fetchImpl: deps.fetchImpl,
        env: deps.env || process.env,
        publicBaseUrl: deps.publicBaseUrl || publicBaseUrlFromRequest(req),
      });
      await persistAndNotify(
        deps,
        result.published ? 'knowledge_change_session_published' : 'knowledge_change_session_conflict',
        result.published ? 'Knowledge Space change session published.' : 'Knowledge Space publish conflict detected.',
        { workspaceId, changeSessionId: publishId, conflicts: result.conflicts?.length || 0 },
      );
      deps.sendJson(res, result.published ? 200 : 409, {
        session: result.session,
        published: result.published,
        conflicts: result.conflicts || [],
        notification: result.notification?.attempt || null,
        space: publicKnowledgeSpace(result.space, editor),
      });
      return true;
    }

    const retryId = req.method === 'POST' ? routeSessionId(url.pathname, 'retry-notification') : '';
    if (retryId) {
      const editor = ensureEditor(deps, req, res, space);
      if (!editor) return true;
      const result = await sendKnowledgePublishNotification({
        state,
        workspaceId,
        sessionId: retryId,
        now: deps.now,
        fetchImpl: deps.fetchImpl,
        env: deps.env || process.env,
        publicBaseUrl: deps.publicBaseUrl || publicBaseUrlFromRequest(req),
      });
      await persistAndNotify(deps, 'knowledge_notification_retried', 'Knowledge Space Feishu notification retried.', {
        workspaceId,
        changeSessionId: retryId,
        status: result.attempt.status,
      });
      deps.sendJson(res, result.attempt.status === 'sent' ? 200 : 502, { attempt: result.attempt, result: result.result });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/knowledge/ask') {
      const member = ensureMember(deps, req, res);
      if (!member) return true;
      const body = await parseBody(deps, req);
      deps.sendJson(res, 200, await askKnowledgeConsensus(space, body.query || body.question || '', { env: deps.env || process.env }));
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/knowledge/align') {
      const member = ensureMember(deps, req, res);
      if (!member) return true;
      const body = await parseBody(deps, req);
      deps.sendJson(res, 200, await alignKnowledgeDiscussion(space, body.text || body.query || '', { env: deps.env || process.env }));
      return true;
    }

    deps.sendError(res, 404, 'Knowledge Space route not found.');
    return true;
  } catch (error) {
    const message = error?.message || 'Knowledge Space request failed.';
    if (/not found/i.test(message)) deps.sendError(res, 404, message);
    else if (/only|requires|whitelist|member|admin/i.test(message)) deps.sendError(res, 403, message);
    else deps.sendError(res, 400, message);
    return true;
  }
}
