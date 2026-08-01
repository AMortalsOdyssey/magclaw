import crypto from 'node:crypto';
import {
  NOTIFY_DEVICE_TTL_MS,
  NOTIFY_TOKEN_TTL_MS,
  applyNotifyResult,
  compactNotifyText,
  hashNotifySecret,
  normalizeMachineFingerprint,
  normalizeNotifySubmission,
  notifyInstallation,
  notifyRecords,
  notifyRecordsForRelay,
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

function findDeviceRequest(state, deviceCode = '', userCode = '', authMode = '') {
  const deviceHash = deviceCode ? hashNotifySecret(deviceCode) : '';
  const cleanUserCode = String(userCode || '').trim().toUpperCase();
  return notifyRecords(state).find((record) => (
    record.type === 'auth_device'
      && (!authMode || record.authMode === authMode)
      && ((deviceHash && record.deviceCodeHash === deviceHash) || (cleanUserCode && record.userCode === cleanUserCode))
  )) || null;
}

function publicAuthUser(user = {}) {
  return {
    id: user.id || '',
    authUserId: user.id || '',
    name: compactNotifyText(user.name || user.email || '', 120),
    email: compactNotifyText(user.email || '', 180),
  };
}

function relayHandlePart(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'notify';
}

function relayHandle(name = '', machineFingerprint = '') {
  const label = relayHandlePart(name);
  const suffix = crypto.createHash('sha256').update(`${machineFingerprint}:${label}`).digest('hex').slice(0, 7);
  return `${label}-${suffix}`;
}

function installationForInviteToken(state, rawToken = '') {
  const tokenHash = hashNotifySecret(rawToken);
  return notifyRecords(state).find((record) => (
    record.type === 'installation'
      && record.enabled !== false
      && record.inviteTokenHash === tokenHash
  )) || null;
}

export async function handleNotifyApi(req, res, url, deps) {
  const {
    currentActor = () => null,
    currentUser = () => null,
    notifyRelay,
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

  if (req.method === 'POST' && url.pathname === '/api/notify/daemon/auth/start') {
    const body = await readJson(req);
    const requestedRelayId = compactNotifyText(body.relayId || body.relay_id || '', 160);
    const installation = requestedRelayId ? notifyInstallation(state, requestedRelayId) : null;
    if (requestedRelayId && !installation) {
      sendError(res, 404, 'Notify Relay installation is unavailable.');
      return true;
    }
    const storageWorkspaceId = installation?.workspaceId || actorWorkspaceId;
    if (!consumeRate(state, { workspaceId: storageWorkspaceId || 'notify', key: `daemon-auth:${requestIp(req)}`, limit: START_LIMIT, now })) {
      sendError(res, 429, 'Too many Notify Daemon login attempts.');
      return true;
    }
    const deviceCode = randomNotifySecret('mcn_daemon_dev');
    const userCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    const request = {
      id: makeId('nau'),
      type: 'auth_device',
      authMode: 'daemon',
      workspaceId: storageWorkspaceId,
      relayId: installation?.id || '',
      relayName: compactNotifyText(body.relayName || body.relay_name || 'MagClaw', 120),
      deviceCodeHash: hashNotifySecret(deviceCode),
      userCode,
      machineFingerprint: normalizeMachineFingerprint(body.machineFingerprint || body.machine_fingerprint || ''),
      client: {
        hostname: compactNotifyText(body.client?.hostname || '', 120),
        platform: compactNotifyText(body.client?.platform || '', 40),
        arch: compactNotifyText(body.client?.arch || '', 40),
      },
      status: 'pending',
      createdAt: now(),
      updatedAt: now(),
      expiresAt: new Date(Date.now() + NOTIFY_DEVICE_TTL_MS).toISOString(),
    };
    notifyRecords(state).push(request);
    await persistState(storageWorkspaceId ? { workspaceId: storageWorkspaceId, reason: 'notify_daemon_auth_start' } : undefined);
    sendJson(res, 201, {
      ok: true,
      deviceCode,
      userCode,
      verificationUri: `/notify/daemon/auth/approve?user_code=${encodeURIComponent(userCode)}`,
      expiresAt: request.expiresAt,
      intervalMs: 2000,
      status: request.status,
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/notify/daemon/auth/approve') {
    const request = findDeviceRequest(state, '', url.searchParams.get('user_code'), 'daemon');
    if (!request || Date.parse(request.expiresAt || '') <= Date.now()) {
      sendError(res, 404, 'Notify Daemon login request not found or expired.');
      return true;
    }
    if (!browserUser) {
      const returnTo = encodeURIComponent(url.pathname + url.search);
      res.writeHead(302, { location: `/?returnTo=${returnTo}`, 'cache-control': 'no-store' });
      res.end();
      return true;
    }
    let installation = request.relayId ? notifyInstallation(state, request.relayId) : null;
    if (!installation) {
      installation = notifyRecords(state).find((record) => (
        record.type === 'installation'
          && record.enabled !== false
          && record.ownerUserId === browserUser.id
          && record.machineFingerprint === request.machineFingerprint
          && relayHandlePart(record.name) === relayHandlePart(request.relayName)
      )) || null;
    }
    if (installation && installation.ownerUserId !== browserUser.id) {
      sendError(res, 403, 'Only the Notify Relay owner can approve this Daemon.');
      return true;
    }
    if (!installation) {
      installation = {
        id: makeId('nrl'),
        type: 'installation',
        workspaceId: actorWorkspaceId,
        ownerUserId: browserUser.id || '',
        owner: publicAuthUser(browserUser),
        name: request.relayName || 'MagClaw Notify',
        handle: relayHandle(request.relayName, request.machineFingerprint),
        machineFingerprint: request.machineFingerprint,
        enabled: true,
        createdAt: now(),
        updatedAt: now(),
      };
      notifyRecords(state).push(installation);
    }
    request.workspaceId = installation.workspaceId || actorWorkspaceId;
    request.relayId = installation.id;
    request.status = 'approved';
    request.approvedUser = publicAuthUser(browserUser);
    request.approvedAt = now();
    request.updatedAt = now();
    await persistState(request.workspaceId ? { workspaceId: request.workspaceId, reason: 'notify_daemon_auth_approve' } : undefined);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(approvalHtml(request));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/notify/daemon/auth/token') {
    const body = await readJson(req);
    const request = findDeviceRequest(state, body.deviceCode || body.device_code || '', '', 'daemon');
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
      sendError(res, 401, 'Notify Daemon login was requested from another machine.');
      return true;
    }
    const token = randomNotifySecret('mcn_daemon');
    const installation = notifyInstallation(state, request.relayId);
    if (!installation) {
      sendError(res, 404, 'Notify Relay installation is unavailable.');
      return true;
    }
    let inviteToken = '';
    if (!installation.inviteTokenHash) {
      inviteToken = `mcn_inv_${installation.handle}_${crypto.randomBytes(24).toString('base64url')}`;
      installation.inviteTokenHash = hashNotifySecret(inviteToken);
      installation.updatedAt = now();
    }
    const tokenRecord = {
      id: makeId('nat'),
      type: 'auth_token',
      authMode: 'daemon',
      workspaceId: request.workspaceId,
      relayId: request.relayId,
      tokenHash: hashNotifySecret(token),
      machineFingerprint: request.machineFingerprint || fingerprint,
      user: request.approvedUser,
      scopes: ['notify:daemon'],
      createdAt: now(),
      updatedAt: now(),
      expiresAt: new Date(Date.now() + NOTIFY_TOKEN_TTL_MS).toISOString(),
    };
    notifyRecords(state).push(tokenRecord);
    notifyRecords(state).splice(notifyRecords(state).indexOf(request), 1);
    await persistState({ workspaceId: tokenRecord.workspaceId, reason: 'notify_daemon_auth_token' });
    sendJson(res, 200, {
      ok: true,
      status: 'approved',
      token,
      tokenExpiresAt: tokenRecord.expiresAt,
      relayId: tokenRecord.relayId,
      relayHandle: installation.handle,
      inviteToken,
      user: tokenRecord.user,
      scopes: tokenRecord.scopes,
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/notify/daemon/result') {
    const daemonToken = notifyTokenForRequest(state, req, 'notify:daemon');
    if (!daemonToken?.relayId) {
      sendError(res, 401, 'Notify result reporting requires a Notify Daemon token.');
      return true;
    }
    const body = await readJson(req);
    const request = notifyRequest(state, compactNotifyText(body.requestId || '', 160));
    if (!request || request.relayId !== daemonToken.relayId) {
      sendError(res, 404, 'Notify request not found.');
      return true;
    }
    const updated = applyNotifyResult(state, body, now);
    await persistState({ workspaceId: request.workspaceId, reason: 'notify_daemon_confirmation_result' });
    sendJson(res, 200, { ok: true, request: publicNotifyRequest(updated) });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/notify/auth/start') {
    const body = await readJson(req);
    const inviteToken = compactNotifyText(body.inviteToken || body.invite_token || body.token || '', 500);
    const installation = installationForInviteToken(state, inviteToken);
    if (!installation) {
      sendError(res, 404, 'Notify setup token is invalid or unavailable.');
      return true;
    }
    const relayId = installation.id;
    if (!consumeRate(state, { workspaceId: installation.workspaceId || relayId, key: `auth:${requestIp(req)}`, limit: START_LIMIT, now })) {
      sendError(res, 429, 'Too many Notify login attempts.');
      return true;
    }
    const deviceCode = randomNotifySecret('mcn_dev');
    const userCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    const request = {
      id: makeId('nau'),
      type: 'auth_device',
      authMode: 'client',
      workspaceId: installation.workspaceId,
      relayId,
      deviceCodeHash: hashNotifySecret(deviceCode),
      userCode,
      machineFingerprint: normalizeMachineFingerprint(body.machineFingerprint || body.machine_fingerprint || ''),
      profile: compactNotifyText(body.profile || 'default', 80),
      client: {
        hostname: compactNotifyText(body.client?.hostname || '', 120),
        platform: compactNotifyText(body.client?.platform || '', 40),
        arch: compactNotifyText(body.client?.arch || '', 40),
      },
      status: browserUser ? 'approved' : 'pending',
      approvedUser: browserUser ? publicAuthUser(browserUser) : null,
      createdAt: now(),
      updatedAt: now(),
      expiresAt: new Date(Date.now() + NOTIFY_DEVICE_TTL_MS).toISOString(),
    };
    notifyRecords(state).push(request);
    await persistState({ workspaceId: installation.workspaceId, reason: 'notify_auth_start' });
    sendJson(res, 201, {
      ok: true,
      deviceCode,
      userCode,
      verificationUri: `/notify/auth/approve?user_code=${encodeURIComponent(userCode)}`,
      expiresAt: request.expiresAt,
      intervalMs: 2000,
      status: request.status,
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/notify/auth/approve') {
    const request = findDeviceRequest(state, '', url.searchParams.get('user_code'), 'client');
    if (!request || Date.parse(request.expiresAt || '') <= Date.now()) {
      sendError(res, 404, 'Notify login request not found or expired.');
      return true;
    }
    if (!browserUser) {
      const returnTo = encodeURIComponent(url.pathname + url.search);
      res.writeHead(302, { location: `/?returnTo=${returnTo}`, 'cache-control': 'no-store' });
      res.end();
      return true;
    }
    request.status = 'approved';
    request.approvedUser = publicAuthUser(browserUser);
    request.approvedAt = now();
    request.updatedAt = now();
    await persistState({ workspaceId: request.workspaceId, reason: 'notify_auth_approve' });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(approvalHtml(request));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/notify/auth/token') {
    const body = await readJson(req);
    const request = findDeviceRequest(state, body.deviceCode || body.device_code || '', '', 'client');
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
    const installation = notifyInstallation(state, request.relayId);
    const tokenRecord = {
      id: makeId('nat'),
      type: 'auth_token',
      authMode: 'client',
      workspaceId: request.workspaceId,
      relayId: request.relayId,
      relayHandle: installation?.handle || '',
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
      relayHandle: tokenRecord.relayHandle,
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
    sendJson(res, 200, { ok: true, relayHandle: token.relayHandle, profile: token.profile, user: token.user, scopes: token.scopes });
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
    const duplicate = idempotencyKey && notifyRecordsForRelay(state, token.relayId).find((record) => (
      record.type === 'request'
        && record.requesterTokenId === token.id
        && record.idempotencyKey === idempotencyKey
    ));
    if (duplicate) {
      sendJson(res, 200, { ok: true, deduped: true, request: publicNotifyRequest(duplicate) });
      return true;
    }
    const request = {
      id: makeId('nreq'),
      type: 'request',
      workspaceId: token.workspaceId,
      relayId: token.relayId,
      requesterTokenId: token.id,
      requester: token.user,
      idempotencyKey,
      status: 'queued',
      publicReason: '',
      payload,
      createdAt: now(),
      updatedAt: now(),
      completedAt: null,
    };
    notifyRecords(state).push(request);
    const delivery = await notifyRelay.deliverNotifyRequest(request);
    request.deliveryId = delivery?.delivery?.id || '';
    if (!delivery?.queued) {
      request.status = 'awaiting_configuration';
      request.publicReason = 'Notify Daemon is offline or not configured.';
      request.completedAt = now();
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
    if (!token || !request || request.relayId !== token.relayId || request.requesterTokenId !== token.id) {
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
