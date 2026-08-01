import crypto from 'node:crypto';
import {
  NOTIFY_DEVICE_TTL_MS,
  NOTIFY_TOKEN_TTL_MS,
  applyNotifyResult,
  compactNotifyText,
  hashNotifySecret,
  normalizeMachineFingerprint,
  normalizeNotifySubmission,
  notifyRecords,
  notifyRecordsForWorkspace,
  notifyRequest,
  notifyTokenForRequest,
  pruneNotifyRecords,
  publicNotifyRequest,
  randomNotifySecret,
} from '../notify.js';

const START_LIMIT = 20;
const SUBMIT_LIMIT = 30;
const RATE_WINDOW_MS = 10 * 60_000;

function htmlEscape(value = '') {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function approvalHtml(request = {}) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MagClaw Notify</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#fffaf7;color:#1a1a1a;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.card{width:min(440px,calc(100% - 40px));padding:30px;border:2px solid #1a1a1a;border-radius:8px;box-shadow:5px 5px 0 #1a1a1a;background:#fff}.mark{color:#ff3faa;font-weight:900;letter-spacing:.08em}h1{font-size:22px}p{color:#67515f;line-height:1.55}</style></head><body><main class="card"><div class="mark">MAGCLAW NOTIFY</div><h1>已批准这台设备</h1><p>登录身份：${htmlEscape(request.approvedUser?.name || request.approvedUser?.email || 'MagClaw member')}</p><p>可以回到终端继续。这个授权只允许显式提交 Notify 请求，不会公开本地群聊或飞书身份目录。</p></main></body></html>`;
}

function requestIp(req) {
  return String(req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '').split(',')[0].trim();
}

function consumeRate(state, { workspaceId, key, limit, now }) {
  const id = `notify_rate_${crypto.createHash('sha256').update(`${workspaceId}:${key}`).digest('hex').slice(0, 24)}`;
  const records = notifyRecords(state);
  let record = records.find((item) => item.type === 'rate' && item.id === id);
  const timestamp = Date.parse(now());
  if (!record || !Number.isFinite(Date.parse(record.windowStartedAt)) || timestamp - Date.parse(record.windowStartedAt) >= RATE_WINDOW_MS) {
    if (record) records.splice(records.indexOf(record), 1);
    record = { id, type: 'rate', workspaceId, count: 0, windowStartedAt: now(), createdAt: now(), updatedAt: now() };
    records.push(record);
  }
  record.count += 1;
  record.updatedAt = now();
  return record.count <= limit;
}

function workspaceIdFromActor(actor, state) {
  return String(actor?.member?.workspaceId || state.connection?.workspaceId || state.cloud?.workspaces?.[0]?.id || 'local').trim();
}

function resolveNotifyWorkspaceId(state, requested, fallback) {
  const clean = String(requested || '').trim().toLowerCase();
  if (!clean) return String(fallback || '').trim();
  const workspace = (Array.isArray(state.cloud?.workspaces) ? state.cloud.workspaces : []).find((item) => (
    !item.deletedAt
      && [item.id, item.slug].some((value) => String(value || '').trim().toLowerCase() === clean)
  ));
  return String(workspace?.id || '').trim();
}

function requestUser(actor) {
  return {
    id: actor?.member?.humanId || actor?.user?.id || '',
    authUserId: actor?.user?.id || '',
    name: compactNotifyText(actor?.user?.name || actor?.user?.email || '', 120),
    email: compactNotifyText(actor?.user?.email || '', 180),
  };
}

function chooseNotifyComputer(state, workspaceId) {
  const records = notifyRecordsForWorkspace(state, workspaceId);
  const route = records.find((item) => item.type === 'route') || null;
  if (route?.enabled === false) return null;
  const computers = (Array.isArray(state.computers) ? state.computers : []).filter((computer) => (
    String(computer.workspaceId || '') === workspaceId
      && !computer.disabledAt
      && String(computer.status || '').toLowerCase() !== 'disabled'
  ));
  if (route?.computerId) {
    const configured = computers.find((computer) => computer.id === route.computerId);
    if (configured) return configured;
  }
  return computers.find((computer) => String(computer.status || '').toLowerCase() === 'connected')
    || computers.find((computer) => computer.connectedVia === 'daemon')
    || null;
}

function findDeviceRequest(state, deviceCode = '', userCode = '') {
  const deviceHash = deviceCode ? hashNotifySecret(deviceCode) : '';
  const cleanUserCode = String(userCode || '').trim().toUpperCase();
  return notifyRecords(state).find((record) => (
    record.type === 'auth_device'
      && ((deviceHash && record.deviceCodeHash === deviceHash) || (cleanUserCode && record.userCode === cleanUserCode))
  )) || null;
}

export async function handleNotifyApi(req, res, url, deps) {
  const {
    currentActor = () => null,
    currentUser = () => null,
    authenticateDaemonRequest = () => null,
    daemonRelay,
    getState,
    makeId,
    now,
    persistState,
    readJson,
    sendError,
    sendJson,
  } = deps;
  const state = getState();
  pruneNotifyRecords(state);
  const actor = currentActor(req);
  const browserUser = currentUser(req) || actor?.user || null;
  const actorWorkspaceId = workspaceIdFromActor(actor, state);

  if (req.method === 'POST' && url.pathname === '/api/notify/internal/result') {
    const daemonAuth = authenticateDaemonRequest(req);
    if (!daemonAuth) {
      sendError(res, 401, 'Notify result reporting requires a machine token.');
      return true;
    }
    const body = await readJson(req);
    const request = notifyRequest(state, compactNotifyText(body.requestId || '', 160));
    if (
      !request
      || request.workspaceId !== daemonAuth.workspaceId
      || (request.computerId && request.computerId !== daemonAuth.computerId)
    ) {
      sendError(res, 404, 'Notify request not found.');
      return true;
    }
    const updated = applyNotifyResult(state, body, now);
    await persistState({ workspaceId: request.workspaceId, reason: 'notify_local_confirmation_result' });
    sendJson(res, 200, { ok: true, request: publicNotifyRequest(updated) });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/notify/internal/route') {
    const daemonAuth = authenticateDaemonRequest(req);
    if (!daemonAuth) {
      sendError(res, 401, 'Notify route registration requires a machine token.');
      return true;
    }
    const computer = (Array.isArray(state.computers) ? state.computers : []).find((item) => (
      item.id === daemonAuth.computerId && item.workspaceId === daemonAuth.workspaceId && !item.disabledAt
    ));
    if (!computer) {
      sendError(res, 404, 'Notify delivery computer is unavailable.');
      return true;
    }
    const records = notifyRecords(state);
    let route = records.find((item) => item.type === 'route' && item.workspaceId === daemonAuth.workspaceId);
    if (route?.computerId && route.computerId !== computer.id) {
      sendError(res, 409, 'Notify already has another delivery computer. An owner must change it in MagClaw.');
      return true;
    }
    if (!route) {
      route = { id: makeId('nrt'), type: 'route', workspaceId: daemonAuth.workspaceId, createdAt: now() };
      records.push(route);
    }
    route.computerId = computer.id;
    route.enabled = true;
    route.updatedBy = `computer:${computer.id}`;
    route.updatedAt = now();
    await persistState({ workspaceId: daemonAuth.workspaceId, reason: 'notify_machine_route_registered' });
    sendJson(res, 200, { ok: true, route: { registered: true, enabled: true, updatedAt: route.updatedAt } });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/notify/admin/route') {
    if (!actor || !['owner', 'admin'].includes(String(actor.member?.role || ''))) {
      sendError(res, 403, 'Notify route configuration requires a workspace owner or admin.');
      return true;
    }
    const body = await readJson(req);
    const computerId = compactNotifyText(body.computerId || '', 160);
    const computer = (Array.isArray(state.computers) ? state.computers : []).find((item) => (
      item.id === computerId && item.workspaceId === actorWorkspaceId && !item.disabledAt
    ));
    if (!computer) {
      sendError(res, 404, 'Notify delivery computer is unavailable.');
      return true;
    }
    const records = notifyRecords(state);
    let route = records.find((item) => item.type === 'route' && item.workspaceId === actorWorkspaceId);
    if (!route) {
      route = { id: makeId('nrt'), type: 'route', workspaceId: actorWorkspaceId, createdAt: now() };
      records.push(route);
    }
    route.computerId = computer.id;
    route.enabled = body.enabled !== false;
    route.updatedBy = actor.member?.humanId || actor.user?.id || '';
    route.updatedAt = now();
    await persistState({ workspaceId: actorWorkspaceId, reason: 'notify_route_configured' });
    sendJson(res, 200, { ok: true, route: { computerId: route.computerId, enabled: route.enabled, updatedAt: route.updatedAt } });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/notify/auth/start') {
    const body = await readJson(req);
    const workspaceId = resolveNotifyWorkspaceId(state, body.workspaceId, actorWorkspaceId);
    if (!workspaceId) {
      sendError(res, 404, 'Notify workspace is unavailable.');
      return true;
    }
    if (!consumeRate(state, { workspaceId, key: `auth:${requestIp(req)}`, limit: START_LIMIT, now })) {
      sendError(res, 429, 'Too many Notify login attempts.');
      return true;
    }
    const deviceCode = randomNotifySecret('mcn_dev');
    const userCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    const request = {
      id: makeId('nau'),
      type: 'auth_device',
      workspaceId,
      deviceCodeHash: hashNotifySecret(deviceCode),
      userCode,
      machineFingerprint: normalizeMachineFingerprint(body.machineFingerprint || body.machine_fingerprint || ''),
      profile: compactNotifyText(body.profile || 'default', 80),
      client: {
        hostname: compactNotifyText(body.client?.hostname || '', 120),
        platform: compactNotifyText(body.client?.platform || '', 40),
        arch: compactNotifyText(body.client?.arch || '', 40),
      },
      status: actor?.member?.workspaceId === workspaceId ? 'approved' : 'pending',
      approvedUser: actor?.member?.workspaceId === workspaceId ? requestUser(actor) : null,
      createdAt: now(),
      updatedAt: now(),
      expiresAt: new Date(Date.now() + NOTIFY_DEVICE_TTL_MS).toISOString(),
    };
    notifyRecords(state).push(request);
    await persistState({ workspaceId, reason: 'notify_auth_start' });
    sendJson(res, 201, {
      ok: true,
      deviceCode,
      userCode,
      verificationUri: `/notify/auth/approve?user_code=${encodeURIComponent(userCode)}&workspaceId=${encodeURIComponent(workspaceId)}`,
      expiresAt: request.expiresAt,
      intervalMs: 2000,
      status: request.status,
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/notify/auth/approve') {
    const request = findDeviceRequest(state, '', url.searchParams.get('user_code'));
    if (!request || Date.parse(request.expiresAt || '') <= Date.now()) {
      sendError(res, 404, 'Notify login request not found or expired.');
      return true;
    }
    const workspaceReq = {
      ...req,
      headers: { ...(req.headers || {}), 'x-magclaw-workspace-id': request.workspaceId },
    };
    const actorForWorkspace = actor?.member?.workspaceId === request.workspaceId ? actor : currentActor(workspaceReq);
    const approvalActor = actorForWorkspace?.member?.workspaceId === request.workspaceId ? actorForWorkspace : null;
    const approvalUser = browserUser || currentUser(workspaceReq);
    if (!approvalActor) {
      if (approvalUser) {
        sendError(res, 403, 'Join this MagClaw workspace before approving Notify login.');
      } else {
        const returnTo = encodeURIComponent(url.pathname + url.search);
        res.writeHead(302, { location: `/?returnTo=${returnTo}`, 'cache-control': 'no-store' });
        res.end();
      }
      return true;
    }
    request.status = 'approved';
    request.approvedUser = requestUser(approvalActor);
    request.approvedAt = now();
    request.updatedAt = now();
    await persistState({ workspaceId: request.workspaceId, reason: 'notify_auth_approve' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(approvalHtml(request));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/notify/auth/token') {
    const body = await readJson(req);
    const request = findDeviceRequest(state, body.deviceCode || body.device_code || '', '');
    if (!request) {
      sendJson(res, 200, { ok: true, status: 'pending' });
      return true;
    }
    if (Date.parse(request.expiresAt || '') <= Date.now()) {
      request.status = 'expired';
      sendJson(res, 200, { ok: true, status: 'expired' });
      return true;
    }
    if (request.status !== 'approved') {
      sendJson(res, 200, { ok: true, status: request.status || 'pending' });
      return true;
    }
    const fingerprint = normalizeMachineFingerprint(body.machineFingerprint || body.machine_fingerprint || '');
    if (request.machineFingerprint && request.machineFingerprint !== fingerprint) {
      sendError(res, 401, 'Notify login was requested from another machine.');
      return true;
    }
    const token = randomNotifySecret('mcn');
    const tokenRecord = {
      id: makeId('nat'),
      type: 'auth_token',
      workspaceId: request.workspaceId,
      tokenHash: hashNotifySecret(token),
      machineFingerprint: request.machineFingerprint || fingerprint,
      profile: request.profile || 'default',
      user: request.approvedUser,
      scopes: ['notify:submit', 'notify:status'],
      createdAt: now(),
      updatedAt: now(),
      expiresAt: new Date(Date.now() + NOTIFY_TOKEN_TTL_MS).toISOString(),
    };
    notifyRecords(state).push(tokenRecord);
    notifyRecords(state).splice(notifyRecords(state).indexOf(request), 1);
    await persistState({ workspaceId: tokenRecord.workspaceId, reason: 'notify_auth_token' });
    sendJson(res, 200, {
      ok: true,
      status: 'approved',
      token,
      tokenExpiresAt: tokenRecord.expiresAt,
      workspaceId: tokenRecord.workspaceId,
      profile: tokenRecord.profile,
      user: tokenRecord.user,
      scopes: tokenRecord.scopes,
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/notify/auth/whoami') {
    const token = notifyTokenForRequest(state, req);
    if (!token) {
      sendError(res, 401, 'Notify login is required.');
      return true;
    }
    token.lastUsedAt = now();
    token.updatedAt = now();
    sendJson(res, 200, { ok: true, workspaceId: token.workspaceId, profile: token.profile, user: token.user, scopes: token.scopes });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/notify/auth/revoke') {
    const token = notifyTokenForRequest(state, req);
    if (!token) {
      sendError(res, 401, 'Notify login is required.');
      return true;
    }
    token.revokedAt = now();
    token.updatedAt = now();
    await persistState({ workspaceId: token.workspaceId, reason: 'notify_auth_revoke' });
    sendJson(res, 200, { ok: true, revoked: true });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/notify/requests') {
    const token = notifyTokenForRequest(state, req, 'notify:submit');
    if (!token) {
      sendError(res, 401, 'Notify submit authorization is required.');
      return true;
    }
    if (!consumeRate(state, { workspaceId: token.workspaceId, key: `submit:${token.id}`, limit: SUBMIT_LIMIT, now })) {
      sendError(res, 429, 'Too many Notify requests.');
      return true;
    }
    let payload;
    try {
      payload = normalizeNotifySubmission(await readJson(req));
    } catch (error) {
      sendJson(res, error.status || 400, { ok: false, reason: error.code || 'invalid_request', error: error.message });
      return true;
    }
    const idempotencyKey = compactNotifyText(req.headers?.['idempotency-key'] || '', 200);
    const duplicate = idempotencyKey && notifyRecordsForWorkspace(state, token.workspaceId).find((record) => (
      record.type === 'request'
        && record.requesterTokenId === token.id
        && record.idempotencyKey === idempotencyKey
    ));
    if (duplicate) {
      sendJson(res, 200, { ok: true, deduped: true, request: publicNotifyRequest(duplicate) });
      return true;
    }
    const computer = chooseNotifyComputer(state, token.workspaceId);
    const request = {
      id: makeId('nreq'),
      type: 'request',
      workspaceId: token.workspaceId,
      requesterTokenId: token.id,
      requester: token.user,
      computerId: computer?.id || '',
      idempotencyKey,
      status: computer ? 'queued' : 'awaiting_configuration',
      publicReason: computer ? '' : 'Notify delivery computer is not configured.',
      payload,
      createdAt: now(),
      updatedAt: now(),
      completedAt: computer ? null : now(),
    };
    notifyRecords(state).push(request);
    if (computer) {
      const delivery = await daemonRelay.deliverNotifyRequest(computer, request);
      request.deliveryId = delivery?.delivery?.id || '';
      // A fast local handler can report its terminal/configuration result before
      // deliverNotifyRequest resolves. Do not replace that newer result with the
      // transport-level queued state from this submission path.
      if (!request.result) {
        request.status = delivery?.queued ? 'queued' : 'awaiting_configuration';
        if (!delivery?.queued) {
          request.publicReason = 'Notify delivery computer is unavailable.';
          request.completedAt = now();
        }
      }
    }
    token.lastUsedAt = now();
    token.updatedAt = now();
    await persistState({ workspaceId: token.workspaceId, reason: 'notify_request_submitted' });
    sendJson(res, 202, { ok: true, request: publicNotifyRequest(request) });
    return true;
  }

  const requestMatch = url.pathname.match(/^\/api\/notify\/requests\/([^/]+)$/);
  if (req.method === 'GET' && requestMatch) {
    const token = notifyTokenForRequest(state, req, 'notify:status');
    const request = notifyRequest(state, decodeURIComponent(requestMatch[1]));
    if (!token || !request || request.workspaceId !== token.workspaceId || request.requesterTokenId !== token.id) {
      sendError(res, 404, 'Notify request not found.');
      return true;
    }
    sendJson(res, 200, { ok: true, request: publicNotifyRequest(request) });
    return true;
  }

  return false;
}

export function applyNotifyDaemonResult(state, message, now) {
  return applyNotifyResult(state, message, now);
}
