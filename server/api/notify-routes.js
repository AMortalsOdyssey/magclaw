import crypto from 'node:crypto';
import { normalizeNotifyInstance } from '../../notify/src/instance.js';
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

function notifyRouteAuditEvent(method = '', pathname = '') {
  const normalized = String(pathname || '').replace(/^\/api\//, '').replace(/^\//, '').replace(/\/[^/]+$/, (tail) => (
    String(pathname).startsWith('/api/notify/requests/') ? '/:requestId' : tail
  ));
  const names = {
    'POST notify/daemon/auth/start': 'relay.api.daemon_auth_started',
    'GET notify/daemon/auth/approve': 'relay.api.daemon_auth_approved',
    'POST notify/daemon/auth/token': 'relay.api.daemon_token_polled',
    'GET notify/daemon/access': 'relay.api.sender_access_listed',
    'POST notify/daemon/access/revoke': 'relay.api.sender_access_revoked',
    'POST notify/daemon/setup-token/rotate': 'relay.api.setup_token_rotated',
    'POST notify/daemon/setup-token/disable': 'relay.api.setup_token_disabled',
    'POST notify/daemon/result': 'relay.api.delivery_result_reported',
    'POST notify/auth/start': 'relay.api.sender_auth_started',
    'GET notify/auth/approve': 'relay.api.sender_auth_approved',
    'POST notify/auth/token': 'relay.api.sender_token_polled',
    'GET notify/auth/whoami': 'relay.api.sender_identity_read',
    'POST notify/auth/revoke': 'relay.api.sender_session_revoked',
    'GET notify/targets': 'relay.api.targets_queried',
    'POST notify/requests': 'relay.api.request_submitted',
    'GET notify/requests/:requestId': 'relay.api.request_status_read',
  };
  return names[`${String(method).toUpperCase()} ${normalized}`] || `relay.api.${String(method || 'unknown').toLowerCase()}_${normalized.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
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

function jsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function feishuIdentity(user = {}) {
  user = jsonObject(user);
  const metadata = jsonObject(user.metadata);
  const oauth = jsonObject(metadata.oauth);
  const feishu = jsonObject(oauth.feishu);
  const provider = String(user.thirdPartyProvider || user.third_party_provider || '').trim().toLowerCase();
  const providerAccountId = compactNotifyText(feishu.providerAccountId || '', 180);
  const openId = compactNotifyText(feishu.openId || '', 180);
  const userId = compactNotifyText(feishu.userId || '', 180);
  const unionId = compactNotifyText(feishu.unionId || '', 180);
  if (provider !== 'feishu' && !providerAccountId && !openId && !userId && !unionId) return null;
  return {
    provider: 'feishu',
    providerAccountId: providerAccountId || unionId || userId || openId,
    tenantKey: compactNotifyText(feishu.tenantKey || '', 180),
    openId,
    userId,
    unionId,
    linkedAt: compactNotifyText(feishu.linkedAt || '', 80),
    lastLoginAt: compactNotifyText(feishu.lastLoginAt || user.lastLoginAt || '', 80),
  };
}

function publicAuthUser(user = {}) {
  const identity = feishuIdentity(user);
  return {
    id: user.id || '',
    authUserId: user.id || '',
    name: compactNotifyText(user.name || user.email || '', 120),
    email: compactNotifyText(user.email || '', 180),
    ...(identity ? { identity } : {}),
  };
}

function userForId(state, userId = '') {
  return state.cloud?.users?.find((user) => user.id === String(userId || '').trim()) || null;
}

function ownerIdentityForInstallation(state, installation) {
  return feishuIdentity(userForId(state, installation?.ownerUserId))
    || jsonObject(installation?.owner?.identity);
}

function feishuAccessAllowed(state, installation, user) {
  const senderIdentity = feishuIdentity(user);
  if (!senderIdentity) return { allowed: false, reason: 'A Feishu-authenticated MagClaw login is required.' };
  const ownerIdentity = ownerIdentityForInstallation(state, installation);
  if (
    ownerIdentity?.tenantKey
    && senderIdentity.tenantKey
    && ownerIdentity.tenantKey !== senderIdentity.tenantKey
  ) {
    return { allowed: false, reason: 'This Notify Setup Token is limited to the owner\'s Feishu tenant.' };
  }
  return { allowed: true, identity: senderIdentity };
}

function publicSenderAccess(record = {}, timestamp = Date.now()) {
  const expiresAt = Date.parse(record.expiresAt || '');
  const status = record.revokedAt
    ? 'revoked'
    : Number.isFinite(expiresAt) && expiresAt <= timestamp
      ? 'expired'
      : 'active';
  const fingerprint = String(record.machineFingerprint || '');
  return {
    id: record.id,
    status,
    user: record.user || {},
    profile: record.profile || 'default',
    device: {
      hostname: compactNotifyText(record.client?.hostname || '', 120),
      platform: compactNotifyText(record.client?.platform || '', 40),
      arch: compactNotifyText(record.client?.arch || '', 40),
      fingerprintSuffix: fingerprint ? fingerprint.slice(-8) : '',
    },
    createdAt: record.createdAt || null,
    lastUsedAt: record.lastUsedAt || null,
    expiresAt: record.expiresAt || null,
    revokedAt: record.revokedAt || null,
  };
}

function daemonOwnerToken(state, req) {
  const token = notifyTokenForRequest(state, req, 'notify:daemon');
  const installation = token?.relayId ? notifyInstallation(state, token.relayId) : null;
  if (!token || !installation || installation.ownerUserId !== token.user?.id) return null;
  return { token, installation };
}

function relayHandlePart(value = '') {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'notify';
}

function relayHandle(name = '', machineFingerprint = '', instance = 'default') {
  const label = relayHandlePart(name);
  const seed = instance === 'default'
    ? `${machineFingerprint}:${label}`
    : `${machineFingerprint}:${label}:${instance}`;
  const suffix = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 7);
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

function setupTokenVersion(installation) {
  return Math.max(1, Number(installation?.setupTokenVersion || 1));
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
    readJson: rawReadJson,
    sendError: rawSendError,
    sendJson: rawSendJson,
    audit = async () => {},
  } = deps;
  const state = getState();
  pruneNotifyRecords(state);
  const actor = currentActor(req);
  const browserUser = currentUser(req) || actor?.user || null;
  const actorWorkspaceId = workspaceIdFromActor(actor, state);
  const startedAt = Date.now();
  let capturedBody = {};
  const readJson = async (request) => {
    capturedBody = jsonObject(await rawReadJson(request));
    return capturedBody;
  };
  const emitAudit = (statusCode, responseBody = {}, outcome = '') => {
    const requestFromResponse = jsonObject(responseBody?.request);
    const requestMatch = url.pathname.match(/^\/api\/notify\/requests\/([^/]+)$/);
    const requestId = compactNotifyText(requestFromResponse.id || responseBody?.requestId || capturedBody.requestId || (requestMatch ? decodeURIComponent(requestMatch[1]) : ''), 180);
    const relayId = compactNotifyText(requestFromResponse.relayId || responseBody?.relayId || capturedBody.relayId || '', 180);
    const event = notifyRouteAuditEvent(req.method, url.pathname);
    if (event.endsWith('_token_polled') && responseBody?.status === 'pending') return;
    Promise.resolve(audit({
      event,
      outcome: outcome || (statusCode < 400 ? responseBody?.request?.status || responseBody?.status || 'succeeded' : 'rejected'),
      severity: statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warning' : 'info',
      requestId,
      relayId,
      actorId: browserUser?.id || actor?.user?.id || '',
      workspaceId: requestFromResponse.workspaceId || actorWorkspaceId || '',
      targetType: requestId ? 'notify_request' : relayId ? 'notify_relay' : 'notify_route',
      targetId: requestId || relayId || url.pathname,
      networkAddress: requestIp(req),
      userAgent: req.headers?.['user-agent'] || '',
      metadata: {
        httpMethod: req.method,
        route: url.pathname.replace(/^\/api\/notify\/requests\/[^/]+$/, '/api/notify/requests/:requestId'),
        statusCode,
        durationMs: Date.now() - startedAt,
        deduped: Boolean(responseBody?.deduped),
        resultStatus: responseBody?.request?.status || responseBody?.status || '',
      },
    })).catch(() => {});
  };
  const sendJson = (response, statusCode, body) => {
    emitAudit(statusCode, body);
    return rawSendJson(response, statusCode, body);
  };
  const sendError = (response, statusCode, message) => {
    emitAudit(statusCode, {}, 'rejected');
    return rawSendError(response, statusCode, message);
  };

  if (req.method === 'POST' && url.pathname === '/api/notify/daemon/auth/start') {
    const body = await readJson(req);
    let requestedInstance;
    try {
      requestedInstance = normalizeNotifyInstance(body.instance || 'default');
    } catch (error) {
      sendError(res, 400, error.message);
      return true;
    }
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
      instance: requestedInstance,
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
      emitAudit(302, {}, 'login_required');
      res.writeHead(302, { location: `/?returnTo=${returnTo}`, 'cache-control': 'no-store' });
      res.end();
      return true;
    }
    const feishuAccess = feishuAccessAllowed(state, null, browserUser);
    if (!feishuAccess.allowed) {
      sendError(res, 403, feishuAccess.reason);
      return true;
    }
    let installation = request.relayId ? notifyInstallation(state, request.relayId) : null;
    if (!installation) {
      installation = notifyRecords(state).find((record) => (
        record.type === 'installation'
          && record.enabled !== false
          && record.ownerUserId === browserUser.id
          && record.machineFingerprint === request.machineFingerprint
          && (record.instance || 'default') === (request.instance || 'default')
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
        instance: request.instance || 'default',
        handle: relayHandle(request.relayName, request.machineFingerprint, request.instance || 'default'),
        machineFingerprint: request.machineFingerprint,
        setupTokenVersion: 1,
        enabled: true,
        createdAt: now(),
        updatedAt: now(),
      };
      notifyRecords(state).push(installation);
    }
    request.workspaceId = installation.workspaceId || actorWorkspaceId;
    installation.owner = publicAuthUser(browserUser);
    installation.updatedAt = now();
    request.relayId = installation.id;
    request.status = 'approved';
    request.approvedUser = publicAuthUser(browserUser);
    request.approvedAt = now();
    request.updatedAt = now();
    await persistState(request.workspaceId ? { workspaceId: request.workspaceId, reason: 'notify_daemon_auth_approve' } : undefined);
    emitAudit(200, { relayId: installation.id, status: 'approved' });
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
    if (!installation.inviteTokenHash && !installation.inviteTokenDisabledAt) {
      inviteToken = `mcn_inv_${installation.handle}_${crypto.randomBytes(24).toString('base64url')}`;
      installation.inviteTokenHash = hashNotifySecret(inviteToken);
      installation.setupTokenVersion = setupTokenVersion(installation);
      installation.inviteTokenRotatedAt = now();
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
      client: request.client || {},
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
      instance: installation.instance || 'default',
      inviteToken,
      user: tokenRecord.user,
      scopes: tokenRecord.scopes,
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/notify/daemon/access') {
    const owner = daemonOwnerToken(state, req);
    if (!owner) {
      sendError(res, 401, 'Notify owner authorization is required.');
      return true;
    }
    const includeRevoked = ['1', 'true', 'yes'].includes(String(url.searchParams.get('include_revoked') || '').toLowerCase());
    const access = notifyRecordsForRelay(state, owner.token.relayId)
      .filter((record) => record.type === 'auth_token' && record.authMode === 'client')
      .map((record) => publicSenderAccess(record))
      .filter((record) => includeRevoked || record.status === 'active')
      .sort((left, right) => Date.parse(right.createdAt || '') - Date.parse(left.createdAt || ''));
    console.info(`[notify] owner access list relay=${owner.installation.handle} active=${access.filter((item) => item.status === 'active').length} total=${access.length}`);
    sendJson(res, 200, {
      ok: true,
      relayHandle: owner.installation.handle,
      access,
      counts: {
        active: access.filter((item) => item.status === 'active').length,
        revoked: access.filter((item) => item.status === 'revoked').length,
        expired: access.filter((item) => item.status === 'expired').length,
      },
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/notify/daemon/access/revoke') {
    const owner = daemonOwnerToken(state, req);
    if (!owner) {
      sendError(res, 401, 'Notify owner authorization is required.');
      return true;
    }
    const body = await readJson(req);
    const accessId = compactNotifyText(body.accessId || body.access_id || '', 160);
    const userId = compactNotifyText(body.userId || body.user_id || '', 160);
    const revokeAllForUser = body.all === true || body.revokeAll === true || body.revoke_all === true;
    if (!accessId && !userId) {
      sendError(res, 400, 'accessId or userId is required.');
      return true;
    }
    if (userId && !revokeAllForUser) {
      sendError(res, 400, 'Revoking by userId requires all=true.');
      return true;
    }
    const selected = notifyRecordsForRelay(state, owner.token.relayId).filter((record) => (
      record.type === 'auth_token'
      && record.authMode === 'client'
      && (accessId ? record.id === accessId : record.user?.id === userId)
    ));
    if (!selected.length) {
      sendError(res, 404, 'Notify sender access was not found.');
      return true;
    }
    let revoked = 0;
    for (const record of selected) {
      if (record.revokedAt) continue;
      record.revokedAt = now();
      record.revokedBy = owner.token.user;
      record.updatedAt = now();
      revoked += 1;
    }
    await persistState({ workspaceId: owner.token.workspaceId, reason: 'notify_owner_access_revoke' });
    console.info(`[notify] owner access revoked relay=${owner.installation.handle} access=${accessId || '[user]'} user=${userId || selected[0]?.user?.id || ''} count=${revoked}`);
    sendJson(res, 200, {
      ok: true,
      revoked,
      access: selected.map((record) => publicSenderAccess(record)),
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/notify/daemon/setup-token/rotate') {
    const owner = daemonOwnerToken(state, req);
    if (!owner) {
      sendError(res, 401, 'Notify owner authorization is required.');
      return true;
    }
    const body = await readJson(req);
    const revokeExisting = body.revokeExisting === true || body.revoke_existing === true;
    const setupToken = `mcn_inv_${owner.installation.handle}_${crypto.randomBytes(24).toString('base64url')}`;
    owner.installation.inviteTokenHash = hashNotifySecret(setupToken);
    delete owner.installation.inviteTokenDisabledAt;
    owner.installation.inviteTokenRotatedAt = now();
    owner.installation.setupTokenVersion = setupTokenVersion(owner.installation) + 1;
    owner.installation.updatedAt = now();
    let revoked = 0;
    if (revokeExisting) {
      for (const record of notifyRecordsForRelay(state, owner.token.relayId)) {
        if (record.type !== 'auth_token' || record.authMode !== 'client' || record.revokedAt) continue;
        record.revokedAt = now();
        record.revokedBy = owner.token.user;
        record.updatedAt = now();
        revoked += 1;
      }
    }
    await persistState({ workspaceId: owner.token.workspaceId, reason: 'notify_owner_setup_token_rotate' });
    console.info(`[notify] setup token rotated relay=${owner.installation.handle} revokeExisting=${revokeExisting} revoked=${revoked}`);
    sendJson(res, 200, {
      ok: true,
      relayHandle: owner.installation.handle,
      setupToken,
      setupTokenVersion: owner.installation.setupTokenVersion,
      rotatedAt: owner.installation.inviteTokenRotatedAt,
      revokedExistingAccess: revoked,
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/notify/daemon/setup-token/disable') {
    const owner = daemonOwnerToken(state, req);
    if (!owner) {
      sendError(res, 401, 'Notify owner authorization is required.');
      return true;
    }
    const body = await readJson(req);
    const revokeExisting = body.revokeExisting === true || body.revoke_existing === true;
    delete owner.installation.inviteTokenHash;
    owner.installation.setupTokenVersion = setupTokenVersion(owner.installation) + 1;
    owner.installation.inviteTokenDisabledAt = now();
    owner.installation.updatedAt = now();
    let revoked = 0;
    if (revokeExisting) {
      for (const record of notifyRecordsForRelay(state, owner.token.relayId)) {
        if (record.type !== 'auth_token' || record.authMode !== 'client' || record.revokedAt) continue;
        record.revokedAt = now();
        record.revokedBy = owner.token.user;
        record.updatedAt = now();
        revoked += 1;
      }
    }
    await persistState({ workspaceId: owner.token.workspaceId, reason: 'notify_owner_setup_token_disable' });
    console.info(`[notify] setup token disabled relay=${owner.installation.handle} revokeExisting=${revokeExisting} revoked=${revoked}`);
    sendJson(res, 200, {
      ok: true,
      relayHandle: owner.installation.handle,
      setupTokenEnabled: false,
      setupTokenVersion: owner.installation.setupTokenVersion,
      disabledAt: owner.installation.inviteTokenDisabledAt,
      revokedExistingAccess: revoked,
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
    if (browserUser) {
      const feishuAccess = feishuAccessAllowed(state, installation, browserUser);
      if (!feishuAccess.allowed) {
        sendError(res, 403, feishuAccess.reason);
        return true;
      }
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
      setupTokenVersion: setupTokenVersion(installation),
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
      emitAudit(302, {}, 'login_required');
      res.writeHead(302, { location: `/?returnTo=${returnTo}`, 'cache-control': 'no-store' });
      res.end();
      return true;
    }
    const installation = notifyInstallation(state, request.relayId);
    if (installation && setupTokenVersion(installation) !== Number(request.setupTokenVersion || 1)) {
      request.status = 'rejected';
      request.updatedAt = now();
      await persistState({ workspaceId: request.workspaceId, reason: 'notify_auth_setup_token_rotated' });
      sendError(res, 403, 'Notify Setup Token was rotated. Start login again with the new Setup Token.');
      return true;
    }
    const feishuAccess = feishuAccessAllowed(state, installation, browserUser);
    if (!installation || !feishuAccess.allowed) {
      sendError(res, installation ? 403 : 404, installation ? feishuAccess.reason : 'Notify Relay installation is unavailable.');
      return true;
    }
    request.status = 'approved';
    request.approvedUser = publicAuthUser(browserUser);
    request.approvedAt = now();
    request.updatedAt = now();
    await persistState({ workspaceId: request.workspaceId, reason: 'notify_auth_approve' });
    emitAudit(200, { relayId: request.relayId, status: 'approved' });
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
    const installation = notifyInstallation(state, request.relayId);
    if (!installation || setupTokenVersion(installation) !== Number(request.setupTokenVersion || 1)) {
      request.status = 'rejected';
      request.updatedAt = now();
      await persistState({ workspaceId: request.workspaceId, reason: 'notify_auth_setup_token_rotated' });
      sendJson(res, 200, { ok: true, status: 'rejected', reason: 'setup_token_rotated' });
      return true;
    }
    const token = randomNotifySecret('mcn');
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
      client: request.client || {},
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
    await persistState({ workspaceId: token.workspaceId, reason: 'notify_auth_whoami' });
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

  if (req.method === 'GET' && url.pathname === '/api/notify/targets') {
    const token = notifyTokenForRequest(state, req, 'notify:status');
    if (!token) {
      sendError(res, 401, 'Notify authorization is required.');
      return true;
    }
    const listed = await notifyRelay.listNotifyTargets(token.relayId, token.user || {});
    if (!listed.available) {
      sendJson(res, 200, { ok: true, available: false, targets: [], reason: 'Notify Daemon is offline or unavailable.' });
      return true;
    }
    sendJson(res, 200, { ok: true, available: true, targets: listed.targets });
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
    } else if (delivery.ack) {
      const ackStatuses = new Set(['processing', 'awaiting_owner_approval', 'awaiting_confirmation', 'target_unavailable', 'awaiting_configuration', 'failed', 'rejected']);
      request.status = ackStatuses.has(delivery.ack.status) ? delivery.ack.status : 'queued';
      request.publicReason = compactNotifyText(delivery.ack.publicReason || '', 240);
      request.updatedAt = now();
      if (request.status === 'awaiting_owner_approval') {
        request.approvalExpiresAt = compactNotifyText(delivery.ack.confirmationExpiresAt || '', 80);
        request.pendingRequestCount = Math.max(1, Number(delivery.ack.pendingRequestCount || 1));
        for (const requestId of Array.isArray(delivery.ack.batchedRequestIds) ? delivery.ack.batchedRequestIds : []) {
          const batched = notifyRequest(state, String(requestId || ''));
          if (!batched || batched.relayId !== token.relayId) continue;
          batched.approvalExpiresAt = request.approvalExpiresAt;
          batched.pendingRequestCount = request.pendingRequestCount;
          batched.updatedAt = request.updatedAt;
        }
      }
      if (['target_unavailable', 'awaiting_configuration', 'failed', 'rejected'].includes(request.status)) request.completedAt = request.updatedAt;
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
