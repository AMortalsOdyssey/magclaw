import crypto from 'node:crypto';
import { canInviteRole, canRemoveRole, canUpdateMemberRole, cloudCapabilitiesForRole, normalizeCloudRole, roleAllows } from './roles.js';
import { parseCookies, publicLinkOrigin, requestOrigin, safeArray } from './auth-utils.js';
import {
  defaultAuthProviderId,
  feishuProviderConfig,
  hasAuthProvider,
  publicAuthProviders,
} from './auth-providers.js';
import {
  basicAuthCredentials,
  clearSessionCookie,
  HUMAN_PRESENCE_PERSIST_INTERVAL_MS,
  HUMAN_PRESENCE_TIMEOUT_MS,
  INVITATION_TTL_MS,
  isValidEmail,
  normalizeEmail,
  normalizeWorkspaceSlug,
  numericToken,
  PASSWORD_RESET_TTL_MS,
  publicInvitation,
  publicJoinLink,
  publicPasswordReset,
  publicSystemNotification,
  publicUser,
  scryptPassword,
  SESSION_COOKIE,
  SESSION_TTL_MS,
  sessionCookie,
  sha256,
  token,
  validatePassword,
  verifyPassword,
  WORKSPACE_SLUG_MAX_LENGTH,
  WORKSPACE_SLUG_MIN_LENGTH,
  WORKSPACE_SLUG_PATTERN,
} from './auth-primitives.js';
import { normalizeFanoutApiConfig } from '../runtime-config.js';
import { ensureWorkspaceAllChannel } from '../workspace-defaults.js';

function normalizeLanguagePreference(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'zh' || raw === 'zh-cn' || raw === 'cn' || raw === 'chinese') return 'zh-CN';
  if (raw === 'en' || raw === 'en-us' || raw === 'english') return 'en';
  return 'en';
}

const FEISHU_OAUTH_STATE_COOKIE = 'magclaw_feishu_oauth_state';
const FEISHU_OAUTH_RETURN_COOKIE = 'magclaw_feishu_oauth_return';
const FEISHU_LINK_COOKIE = 'magclaw_feishu_link';
const FEISHU_OAUTH_COOKIE_TTL_SECONDS = 10 * 60;

function jsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function safeRelativeReturnPath(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 512) return '';
  if (!raw.startsWith('/') || raw.startsWith('//')) return '';
  try {
    const parsed = new URL(raw, 'https://magclaw.local');
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return '';
  }
}

export function createCloudAuth(deps) {
  const {
    cloudRepository = null,
    getState,
    mailService = null,
    makeId,
    now,
    persistState,
    realtimeSourceId = '',
  } = deps;

  const state = new Proxy({}, {
    get(_target, prop) { return getState()?.[prop]; },
    set(_target, prop, value) { getState()[prop] = value; return true; },
  });

  function cleanupLegacyConfiguredAdminMembers() {
    const cloud = state.cloud;
    const removedAt = now();
    for (const member of safeArray(cloud.workspaceMembers)) {
      if (member.status && member.status !== 'active') continue;
      if (member.humanId !== 'hum_local') continue;
      const workspace = safeArray(cloud.workspaces).find((item) => item.id === member.workspaceId);
      if (!workspace?.ownerUserId || workspace.ownerUserId === member.userId) continue;
      member.status = 'removed';
      member.removedAt = member.removedAt || removedAt;
      member.updatedAt = removedAt;
    }
  }

  function ensureCloudState() {
    const createdAt = now();
    const workspaceId = String(state.connection?.workspaceId || 'local');
    if (!state.cloud || typeof state.cloud !== 'object') state.cloud = {};
    state.cloud.schemaVersion = Number(state.cloud.schemaVersion || 1);
    state.cloud.auth = {
      ...(state.cloud.auth || {}),
      passwordLogin: hasAuthProvider('email_password'),
    };
    delete state.cloud.auth.allowSignups;
    delete state.cloud.auth.ownerInviteOnly;
    state.cloud.workspaces = safeArray(state.cloud.workspaces);
    if (!state.cloud.workspaces.length) {
      state.cloud.workspaces.push({
        id: workspaceId,
        slug: workspaceId,
        name: process.env.MAGCLAW_DEFAULT_WORKSPACE_NAME || 'MagClaw',
        createdAt,
      });
    }
    state.cloud.workspaceMembers = safeArray(state.cloud.workspaceMembers);
    state.cloud.users = safeArray(state.cloud.users);
    for (const user of state.cloud.users) {
      user.language = normalizeLanguagePreference(user.language);
    }
    state.cloud.sessions = safeArray(state.cloud.sessions);
    state.cloud.invitations = safeArray(state.cloud.invitations);
    state.cloud.joinLinks = safeArray(state.cloud.joinLinks);
    state.cloud.passwordResetTokens = safeArray(state.cloud.passwordResetTokens);
    state.cloud.pairingTokens = safeArray(state.cloud.pairingTokens);
    state.cloud.computerTokens = safeArray(state.cloud.computerTokens);
      state.cloud.agentDeliveries = safeArray(state.cloud.agentDeliveries);
      state.cloud.daemonEvents = safeArray(state.cloud.daemonEvents);
      state.systemNotifications = safeArray(state.systemNotifications);
      for (const member of state.cloud.workspaceMembers) {
        member.role = normalizeCloudRole(member.role);
        if (!member.status) member.status = 'active';
      }
      for (const invitation of state.cloud.invitations) {
        invitation.role = normalizeCloudRole(invitation.role);
      }
      state.agents = safeArray(state.agents);
      state.channels = safeArray(state.channels);
      state.messages = safeArray(state.messages);
      state.humans = safeArray(state.humans);
      for (const human of state.humans) {
        human.role = normalizeCloudRole(human.role);
      }
      for (const workspace of state.cloud.workspaces) {
        workspace.updatedAt = workspace.updatedAt || workspace.createdAt || createdAt;
        if (!workspace.ownerUserId) {
          const ownerMember = state.cloud.workspaceMembers
            .filter((member) => member.workspaceId === workspace.id && member.status !== 'removed' && member.role === 'admin')
            .sort((a, b) => Date.parse(a.joinedAt || a.createdAt || 0) - Date.parse(b.joinedAt || b.createdAt || 0))[0];
          if (ownerMember?.userId) workspace.ownerUserId = ownerMember.userId;
        }
        const activeHumanIds = state.cloud.workspaceMembers
          .filter((member) => (
            member.workspaceId === workspace.id
            && member.status !== 'removed'
            && member.humanId
          ))
          .map((member) => member.humanId);
        const workspaceAgentIds = state.agents
          .filter((agent) => (
            agent?.id
            && !agent.deletedAt
            && !agent.archivedAt
            && String(agent.status || '').toLowerCase() !== 'disabled'
            && agent.workspaceId === workspace.id
          ))
          .map((agent) => agent.id);
        ensureWorkspaceAllChannel({
          state,
          workspaceId: workspace.id,
          workspace,
          humanIds: activeHumanIds,
          agentIds: workspaceAgentIds,
          makeId,
          now,
        });
      }
      cleanupLegacyConfiguredAdminMembers();
      return state.cloud;
    }

    function storageBackend() {
      return cloudRepository?.isEnabled?.() ? 'postgres' : 'state';
    }

    function activeUserWithEmail(email) {
      const normalized = normalizeEmail(email);
      if (!normalized) return null;
      return ensureCloudState().users.find((user) => (
        user.email === normalized
        && !user.disabledAt
        && memberForUser(user.id)
      )) || null;
    }

    function userWithEmail(email) {
      const normalized = normalizeEmail(email);
      if (!normalized) return null;
      return ensureCloudState().users.find((user) => (
        user.email === normalized
        && !user.disabledAt
      )) || null;
    }

    function revokeActiveInvitationsForEmail(email, workspaceId = primaryWorkspace()?.id, options = {}) {
      const normalized = normalizeEmail(email);
      if (!normalized) return 0;
      const revokedAt = options.revokedAt || now();
      const nowMs = Date.now();
      let revokedCount = 0;
      for (const invitation of ensureCloudState().invitations) {
        if (invitation.workspaceId !== workspaceId) continue;
        if (normalizeEmail(invitation.email) !== normalized) continue;
        if (invitation.acceptedAt || invitation.revokedAt) continue;
        if (invitation.expiresAt && Date.parse(invitation.expiresAt) <= nowMs) continue;
        invitation.revokedAt = revokedAt;
        invitation.revokedBy = options.actorUserId || null;
        invitation.updatedAt = revokedAt;
        revokedCount += 1;
      }
      return revokedCount;
    }

    function revokeActivePasswordResetsForUser(userId, workspaceId = primaryWorkspace()?.id, options = {}) {
      const normalizedUserId = String(userId || '').trim();
      if (!normalizedUserId) return 0;
      const revokedAt = options.revokedAt || now();
      const nowMs = Date.now();
      let revokedCount = 0;
      for (const reset of ensureCloudState().passwordResetTokens) {
        if (reset.workspaceId !== workspaceId) continue;
        if (reset.userId !== normalizedUserId) continue;
        if (reset.consumedAt || reset.revokedAt) continue;
        if (reset.expiresAt && Date.parse(reset.expiresAt) <= nowMs) continue;
        reset.revokedAt = revokedAt;
        reset.revokedBy = options.actorUserId || null;
        reset.updatedAt = revokedAt;
        revokedCount += 1;
      }
      return revokedCount;
    }

    function uniqueCloudToken(prefix) {
      const cloud = ensureCloudState();
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const raw = token(prefix);
        const hash = sha256(raw);
        const exists = [
          ...cloud.sessions,
          ...cloud.invitations,
          ...cloud.joinLinks,
          ...cloud.passwordResetTokens,
          ...cloud.pairingTokens,
          ...cloud.computerTokens,
        ].some((item) => item.tokenHash === hash);
        if (!exists) return raw;
      }
      const error = new Error('Unable to generate a unique token.');
      error.status = 500;
      throw error;
    }

    function makeUserId() {
      const cloud = ensureCloudState();
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const id = numericToken('usr');
        if (!cloud.users.some((user) => user.id === id)) return id;
      }
      let id = '';
      do {
        id = makeId('usr');
      } while (cloud.users.some((user) => user.id === id));
      return id;
    }

    function systemNotification(event, payload = {}) {
      state.systemNotifications = safeArray(state.systemNotifications);
      const item = {
        id: makeId('sys'),
        type: 'member_notification',
        event,
        createdAt: now(),
        ...payload,
      };
      state.systemNotifications.push(item);
      if (state.systemNotifications.length > 500) {
        state.systemNotifications.splice(0, state.systemNotifications.length - 500);
      }
      return item;
    }

  async function initializeStorage() {
    const cloud = ensureCloudState();
    cloud.storageBackend = storageBackend();
    if (!cloudRepository?.isEnabled?.()) return { enabled: false, backend: 'state' };
    const result = await cloudRepository.initialize(getState());
    ensureCloudState().storageBackend = 'postgres';
    return { ...result, backend: 'postgres' };
  }

  async function persistCloudState(options = {}) {
    try {
      const workspaceId = String(options.workspaceId || options.workspace?.id || '').trim();
      const reason = String(options.reason || 'cloud_auth_changed');
      if (cloudRepository?.isEnabled?.()) {
        if (typeof cloudRepository.persistAuthFromState === 'function') {
          await cloudRepository.persistAuthFromState(getState());
        } else {
          await cloudRepository.persistFromState(getState());
        }
        if (workspaceId && typeof cloudRepository.persistWorkspaceFromState === 'function') {
          await cloudRepository.persistWorkspaceFromState(getState(), workspaceId);
        }
        await cloudRepository.publishRealtimeEvent?.({
          ...(realtimeSourceId ? { sourceId: realtimeSourceId } : {}),
          reason,
          authReload: true,
          ...(workspaceId ? { workspaceId } : {}),
        });
      }
      await persistState({ skipExternal: true });
    } catch (error) {
      if (cloudRepository?.isEnabled?.() && typeof cloudRepository.loadIntoState === 'function') {
        await cloudRepository.loadIntoState(getState()).catch(() => {});
      }
      throw error;
    }
  }

  function cloneRecord(value) {
    return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
  }

  function authUserRecord(user) {
    return cloneRecord(user);
  }

  function loginUserRecord(user) {
    return {
      id: user.id,
      lastLoginAt: user.lastLoginAt,
    };
  }

  function passwordUserRecord(user) {
    return {
      id: user.id,
      passwordHash: user.passwordHash,
      emailVerifiedAt: user.emailVerifiedAt || null,
      updatedAt: user.updatedAt,
      lastLoginAt: user.lastLoginAt || null,
    };
  }

  function removeArrayItem(items, item) {
    const index = items.indexOf(item);
    if (index >= 0) items.splice(index, 1);
  }

  async function persistAuthOperation(operation) {
    try {
      if (cloudRepository?.isEnabled?.() && typeof cloudRepository.persistAuthOperation === 'function') {
        const payload = cloneRecord(operation);
        payload.stateSnapshot = cloneRecord(getState());
        await cloudRepository.persistAuthOperation(payload);
        await persistState({ skipExternal: true });
        await cloudRepository.publishRealtimeEvent?.({
          ...(realtimeSourceId ? { sourceId: realtimeSourceId } : {}),
          reason: `cloud_auth_${operation?.type || 'operation'}`,
          authReload: true,
        });
        return;
      }
      if (cloudRepository?.isEnabled?.() && typeof cloudRepository.persistAuthFromState === 'function') {
        await cloudRepository.persistAuthFromState(cloneRecord(getState()));
        await persistState({ skipExternal: true });
        await cloudRepository.publishRealtimeEvent?.({
          ...(realtimeSourceId ? { sourceId: realtimeSourceId } : {}),
          reason: 'cloud_auth_changed',
          authReload: true,
        });
        return;
      }
      await persistCloudState();
    } catch (error) {
      if (cloudRepository?.isEnabled?.() && typeof cloudRepository.loadIntoState === 'function') {
        await cloudRepository.loadIntoState(getState()).catch(() => {});
      }
      throw error;
    }
  }

  async function persistAuthState(options = {}) {
    await persistCloudState(options);
  }

  function persistCloudStateSoon(reason = 'cloud-auth') {
    persistCloudState().catch((error) => {
      console.error(`[cloud-auth] background persist failed reason=${reason}`, error);
    });
  }

  function persistAuthStateSoon(reason = 'cloud-auth') {
    persistAuthState().catch((error) => {
      console.error(`[cloud-auth] background auth persist failed reason=${reason}`, error);
    });
  }

  function primaryWorkspace() {
    const cloud = ensureCloudState();
    const preferred = String(state.connection?.workspaceId || 'local');
    return cloud.workspaces.find((workspace) => workspace.id === preferred && !workspace.deletedAt)
      || cloud.workspaces.find((workspace) => !workspace.deletedAt)
      || cloud.workspaces[0];
  }

  function requestWorkspaceRef(req) {
    const headers = req?.headers || {};
    const headerRef = String(
      headers['x-magclaw-workspace-id']
      || headers['x-magclaw-server-slug']
      || '',
    ).trim();
    if (headerRef) return headerRef;
    try {
      const url = new URL(req?.url || '/', 'http://magclaw.local');
      const queryRef = String(url.searchParams.get('workspaceId') || url.searchParams.get('serverSlug') || '').trim();
      if (queryRef) return queryRef;
      const pathSlug = String(url.pathname || '').match(/^\/s\/([^/]+)/)?.[1] || '';
      if (pathSlug) return decodeURIComponent(pathSlug);
    } catch {
      // Ignore malformed request URLs and fall back to the process default.
    }
    return '';
  }

  function workspaceForRequest(req) {
    const ref = requestWorkspaceRef(req).toLowerCase();
    if (!ref) return primaryWorkspace();
    return ensureCloudState().workspaces.find((workspace) => (
      !workspace.deletedAt
      && (
        String(workspace.id || '').toLowerCase() === ref
        || String(workspace.slug || '').toLowerCase() === ref
      )
    )) || primaryWorkspace();
  }

  function workspaceForSlug(slug) {
    const normalized = String(slug || '').trim().toLowerCase();
    if (!normalized) return primaryWorkspace();
    return ensureCloudState().workspaces.find((workspace) => (
      !workspace.deletedAt
      && String(workspace.slug || workspace.id || '').toLowerCase() === normalized
    )) || null;
  }

  function applyWorkspaceScopedSettings(workspace = primaryWorkspace()) {
    state.settings = state.settings || {};
    state.settings.fanoutApi = normalizeFanoutApiConfig(workspace?.metadata?.fanoutApi || {});
  }

  function currentSession(req) {
    const cloud = ensureCloudState();
    const raw = parseCookies(req).get(SESSION_COOKIE) || '';
    if (!raw) return null;
    const hash = sha256(raw);
    const session = cloud.sessions.find((item) => item.tokenHash === hash && !item.revokedAt);
    if (!session) return null;
    if (new Date(session.expiresAt).getTime() <= Date.now()) return null;
    return session;
  }

    function currentUser(req) {
      const session = currentSession(req);
      if (session) {
        const user = ensureCloudState().users.find((item) => item.id === session.userId) || null;
        return user && !user.disabledAt ? user : null;
      }
      if (!hasAuthProvider('email_password')) return null;
      const credentials = basicAuthCredentials(req);
      if (!credentials?.email || !credentials.password) return null;
      const user = ensureCloudState().users.find((item) => item.email === credentials.email && !item.disabledAt);
      if (!user || !verifyPassword(credentials.password, user.passwordHash)) return null;
      return user;
    }

  function memberForUser(userId, workspaceId = primaryWorkspace()?.id) {
    return ensureCloudState().workspaceMembers.find((member) => (
      member.userId === userId
      && member.workspaceId === workspaceId
      && member.status === 'active'
    )) || null;
  }

  function humanForMember(member, user = null) {
    state.humans = safeArray(state.humans);
    const direct = state.humans.find((human) => human.id === member?.humanId);
    if (direct && direct.id === 'hum_local' && user?.id && direct.authUserId !== user.id) {
      return state.humans.find((human) => human.authUserId === user.id && human.status !== 'removed') || null;
    }
    return direct
      || (user ? state.humans.find((human) => human.authUserId === user.id && human.status !== 'removed') : null)
      || null;
  }

  function markHumanPresence(human, status = 'online') {
    if (!human) return false;
    const timestamp = now();
    const nextStatus = status === 'offline' ? 'offline' : 'online';
    const changed = human.status !== nextStatus;
    human.status = nextStatus;
    human.lastSeenAt = timestamp;
    human.presenceUpdatedAt = timestamp;
    return changed;
  }

  function refreshHumanPresence() {
    let changed = false;
    const cutoff = Date.now() - HUMAN_PRESENCE_TIMEOUT_MS;
    for (const human of safeArray(state.humans)) {
      if (!human?.authUserId || human.status !== 'online') continue;
      const seenAt = Date.parse(human.lastSeenAt || human.presenceUpdatedAt || human.updatedAt || human.createdAt || '');
      if (!seenAt || seenAt < cutoff) {
        human.status = 'offline';
        human.presenceUpdatedAt = now();
        changed = true;
      }
    }
    return changed;
  }

    function currentActor(req) {
      const user = currentUser(req);
      const workspace = workspaceForRequest(req);
      const member = user ? memberForUser(user.id, workspace?.id) : null;
      return user && member ? { user, member } : null;
    }

  function isLoginRequired() {
    const cloud = ensureCloudState();
    return process.env.MAGCLAW_DEPLOYMENT === 'cloud' || cloud.users.length > 0;
  }

    function requireUser(req, res, sendError, allowedRoles = []) {
      const auth = currentActor(req);
      if (!auth) {
        sendError(res, 401, 'Login is required.');
        return null;
      }
      if (!roleAllows(auth.member.role, allowedRoles)) {
        sendError(res, 403, 'Workspace role is not allowed.');
        return null;
      }
      return auth;
    }

    function requireAuthenticatedUser(req) {
      const user = currentUser(req);
      if (!user) {
        const error = new Error('Login is required.');
        error.status = 401;
        throw error;
      }
      return user;
    }

  function issueSession(user, req) {
    const cloud = ensureCloudState();
    const raw = token('mc_sess');
    const createdAt = now();
    const session = {
      id: makeId('sess'),
      userId: user.id,
      tokenHash: sha256(raw),
      createdAt,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
      userAgent: String(req.headers?.['user-agent'] || '').slice(0, 240),
      ipHash: sha256(req.socket?.remoteAddress || ''),
      revokedAt: null,
    };
    cloud.sessions.push(session);
    user.lastLoginAt = createdAt;
    return { session, cookie: sessionCookie(raw, req) };
  }

  function oauthCookie(name, value, req, maxAgeSeconds = FEISHU_OAUTH_COOKIE_TTL_SECONDS) {
    const secure = requestOrigin(req).startsWith('https://') || process.env.MAGCLAW_SECURE_COOKIES === '1';
    return [
      `${name}=${encodeURIComponent(value)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${maxAgeSeconds}`,
      secure ? 'Secure' : '',
    ].filter(Boolean).join('; ');
  }

  function oauthStateCookie(rawState, req) {
    return oauthCookie(FEISHU_OAUTH_STATE_COOKIE, rawState, req);
  }

  function oauthReturnCookie(returnTo, req) {
    return oauthCookie(FEISHU_OAUTH_RETURN_COOKIE, returnTo, req);
  }

  function feishuLinkCookie(value, req) {
    return oauthCookie(FEISHU_LINK_COOKIE, value, req);
  }

  function clearOauthCookie(name) {
    return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  function clearOauthStateCookie() {
    return clearOauthCookie(FEISHU_OAUTH_STATE_COOKIE);
  }

  function clearOauthReturnCookie() {
    return clearOauthCookie(FEISHU_OAUTH_RETURN_COOKIE);
  }

  function clearFeishuLinkCookie() {
    return clearOauthCookie(FEISHU_LINK_COOKIE);
  }

  function feishuOauthReturnTo(req) {
    return safeRelativeReturnPath(parseCookies(req).get(FEISHU_OAUTH_RETURN_COOKIE) || '');
  }

  function feishuAuthErrorRedirect(message) {
    const params = new URLSearchParams({ authError: message || 'Feishu sign-in failed.' });
    return `/?${params.toString()}`;
  }

  function requireFeishuProvider(req) {
    const provider = feishuProviderConfig(req);
    if (!provider) {
      const error = new Error('Feishu sign-in is not enabled.');
      error.status = 404;
      throw error;
    }
    if (!provider.appId || !provider.appSecret || !provider.redirectUri) {
      const error = new Error('Feishu sign-in is not fully configured.');
      error.status = 503;
      throw error;
    }
    return provider;
  }

  function signFeishuPayload(payload, provider) {
    const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto.createHmac('sha256', provider.appSecret).update(data).digest('base64url');
    return `${data}.${signature}`;
  }

  function verifyFeishuPayload(value, provider) {
    const [data, signature] = String(value || '').split('.');
    if (!data || !signature) return null;
    const expected = crypto.createHmac('sha256', provider.appSecret).update(data).digest('base64url');
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (actualBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(actualBuffer, expectedBuffer)) return null;
    try {
      const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
      if (!payload || typeof payload !== 'object') return null;
      if (Number(payload.expiresAt || 0) <= Date.now()) return null;
      return payload;
    } catch {
      return null;
    }
  }

  function createFeishuAuthorization(req, options = {}) {
    const provider = requireFeishuProvider(req);
    const rawState = `mc_feishu_${crypto.randomBytes(24).toString('base64url')}`;
    const returnTo = safeRelativeReturnPath(options.returnTo);
    const authorizationUrl = new URL('https://open.feishu.cn/open-apis/authen/v1/index');
    authorizationUrl.searchParams.set('app_id', provider.appId);
    authorizationUrl.searchParams.set('redirect_uri', provider.redirectUri);
    authorizationUrl.searchParams.set('state', rawState);
    const cookies = [oauthStateCookie(rawState, req)];
    if (returnTo) cookies.push(oauthReturnCookie(returnTo, req));
    return {
      redirectUrl: authorizationUrl.toString(),
      cookie: cookies,
      cookies,
    };
  }

  async function fetchFeishuJson(label, url, options = {}) {
    console.info(`[cloud-auth] feishu request start action=${label}`);
    const response = await fetch(url, options);
    const body = await response.json().catch(() => ({}));
    const code = body?.code;
    console.info(`[cloud-auth] feishu request complete action=${label} status=${response.status} code=${code ?? 'n/a'}`);
    if (!response.ok || (code !== undefined && code !== 0)) {
      const message = body?.msg || body?.message || `Feishu ${label} failed.`;
      const error = new Error(message);
      error.status = response.ok ? 502 : response.status;
      throw error;
    }
    return body;
  }

  async function feishuUserInfoForCode(code, provider) {
    const appTokenBody = await fetchFeishuJson('app_access_token', 'https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        app_id: provider.appId,
        app_secret: provider.appSecret,
      }),
    });
    const appAccessToken = appTokenBody?.app_access_token || appTokenBody?.data?.app_access_token || '';
    if (!appAccessToken) throw new Error('Feishu app_access_token was not returned.');

    const userTokenBody = await fetchFeishuJson('user_access_token', 'https://open.feishu.cn/open-apis/authen/v1/access_token', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${appAccessToken}`,
      },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
      }),
    });
    const userAccessToken = userTokenBody?.data?.access_token || userTokenBody?.data?.user_access_token || '';
    if (!userAccessToken) throw new Error('Feishu user_access_token was not returned.');

    const userInfoBody = await fetchFeishuJson('user_info', 'https://open.feishu.cn/open-apis/authen/v1/user_info', {
      headers: { authorization: `Bearer ${userAccessToken}` },
    });
    return userInfoBody?.data || {};
  }

  function normalizeFeishuUserInfo(info) {
    const email = normalizeEmail(info.email || info.enterprise_email);
    if (email && !isValidEmail(email)) {
      const error = new Error('Feishu returned an invalid email address.');
      error.status = 400;
      throw error;
    }
    const providerAccountId = String(info.union_id || info.open_id || info.user_id || email).trim();
    if (!providerAccountId) {
      const error = new Error('Feishu did not return a stable account identifier.');
      error.status = 400;
      throw error;
    }
    const name = String(info.name || info.en_name || (email ? email.split('@')[0] : 'Feishu user')).trim();
    return {
      email,
      name,
      avatarUrl: String(info.avatar_url || info.avatar_big || info.avatar_middle || info.avatar_thumb || '').trim(),
      providerAccountId,
      tenantKey: String(info.tenant_key || '').trim(),
      openId: String(info.open_id || '').trim(),
      unionId: String(info.union_id || '').trim(),
      userId: String(info.user_id || '').trim(),
    };
  }

  function feishuMetadata(user) {
    return jsonObject(jsonObject(user?.metadata).oauth)?.feishu || {};
  }

  function userWithFeishuIdentity(profile) {
    const providerAccountId = String(profile?.providerAccountId || '').trim();
    if (!providerAccountId) return null;
    return ensureCloudState().users.find((user) => (
      !user.disabledAt
      && String(feishuMetadata(user).providerAccountId || '').trim() === providerAccountId
    )) || null;
  }

  function feishuLinkDiffers(user, profile) {
    const existing = String(feishuMetadata(user).providerAccountId || '').trim();
    return Boolean(existing && existing !== String(profile?.providerAccountId || '').trim());
  }

  function applyFeishuProfileToUser(user, profile, timestamp) {
    if (profile.email && !user.email) user.email = profile.email;
    user.name = user.name || profile.name;
    user.avatarUrl = user.avatarUrl || profile.avatarUrl || '';
    if (profile.email) user.emailVerifiedAt = user.emailVerifiedAt || timestamp;
    user.updatedAt = timestamp;
    user.metadata = {
      ...jsonObject(user.metadata),
      oauth: {
        ...jsonObject(user.metadata?.oauth),
        feishu: {
          providerAccountId: profile.providerAccountId,
          tenantKey: profile.tenantKey,
          openId: profile.openId,
          unionId: profile.unionId,
          userId: profile.userId,
          linkedAt: user.metadata?.oauth?.feishu?.linkedAt || timestamp,
          lastLoginAt: timestamp,
        },
      },
    };
  }

  function beginFeishuLinkConfirmation(user, profile, req, res, options = {}) {
    const provider = requireFeishuProvider(req);
    const payload = {
      provider: 'feishu',
      userId: user.id,
      profile,
      returnTo: safeRelativeReturnPath(options.returnTo),
      expiresAt: Date.now() + FEISHU_OAUTH_COOKIE_TTL_SECONDS * 1000,
    };
    res.setHeader('Set-Cookie', [
      feishuLinkCookie(signFeishuPayload(payload, provider), req),
      clearOauthStateCookie(),
      clearOauthReturnCookie(),
    ]);
    console.info(`[cloud-auth] feishu link confirmation required email=${profile.email} user=${user.id}`);
    return {
      pendingLink: true,
      provider: 'feishu',
      account: publicUser(user),
      profile,
      returnTo: payload.returnTo,
    };
  }

  function pendingFeishuLink(req) {
    const provider = requireFeishuProvider(req);
    const payload = verifyFeishuPayload(parseCookies(req).get(FEISHU_LINK_COOKIE) || '', provider);
    if (!payload || payload.provider !== 'feishu') {
      const error = new Error('Feishu link confirmation has expired.');
      error.status = 401;
      throw error;
    }
    const profile = payload.profile || {};
    const user = ensureCloudState().users.find((item) => item.id === payload.userId && !item.disabledAt);
    if (!user) {
      const error = new Error('MagClaw account was not found.');
      error.status = 404;
      throw error;
    }
    if (profile.email && normalizeEmail(user.email) !== normalizeEmail(profile.email)) {
      const error = new Error('Feishu email no longer matches this MagClaw account.');
      error.status = 409;
      throw error;
    }
    if (feishuLinkDiffers(user, profile)) {
      const error = new Error('This MagClaw account is already linked to another Feishu account.');
      error.status = 409;
      throw error;
    }
    return { user, profile, returnTo: safeRelativeReturnPath(payload.returnTo) };
  }

  function feishuLinkStatus(req) {
    const pending = pendingFeishuLink(req);
    return {
      provider: 'feishu',
      account: publicUser(pending.user),
      profile: {
        email: pending.profile.email || '',
        name: pending.profile.name || '',
        avatarUrl: pending.profile.avatarUrl || '',
      },
      returnTo: pending.returnTo,
    };
  }

  async function loginWithFeishuProfile(profile, req, res, options = {}) {
    const cloud = ensureCloudState();
    const createdAt = now();
    const providerUser = userWithFeishuIdentity(profile);
    const emailUser = profile.email ? userWithEmail(profile.email) : null;
    if (providerUser && emailUser && providerUser.id !== emailUser.id) {
      const error = new Error('This Feishu account is already linked to a different MagClaw account.');
      error.status = 409;
      throw error;
    }
    let user = options.forceLinkUserId
      ? cloud.users.find((item) => item.id === options.forceLinkUserId && !item.disabledAt)
      : (providerUser || null);
    if (!user && emailUser) {
      if (feishuLinkDiffers(emailUser, profile)) {
        const error = new Error('This MagClaw account is already linked to another Feishu account.');
        error.status = 409;
        throw error;
      }
      return beginFeishuLinkConfirmation(emailUser, profile, req, res, options);
    }
    const previousUser = user ? cloneRecord(user) : null;
    let createdUser = false;
    if (!user) {
      user = {
        id: makeUserId(),
        email: profile.email || '',
        name: profile.name,
        passwordHash: '',
        avatarUrl: profile.avatarUrl,
        language: normalizeLanguagePreference(req.headers?.['accept-language'] || 'en'),
        emailVerifiedAt: createdAt,
        createdAt,
        updatedAt: createdAt,
        lastLoginAt: null,
        metadata: {},
      };
      cloud.users.push(user);
      createdUser = true;
      console.info(`[cloud-auth] feishu account created email=${profile.email || '[none]'} user=${user.id}`);
    }
    if (!user) {
      const error = new Error('MagClaw account was not found.');
      error.status = 404;
      throw error;
    }
    applyFeishuProfileToUser(user, profile, createdAt);

    const member = memberForUser(user.id);
    if (member) {
      const human = humanForMember(member, user) || ensureHumanForUser(user, member.role, {
        humanId: member.humanId,
        workspaceId: member.workspaceId,
      });
      if (human?.id && member.humanId !== human.id) member.humanId = human.id;
      markHumanPresence(human, 'online');
    }

    const previousLastLoginAt = user.lastLoginAt || null;
    const issued = issueSession(user, req);
    try {
      await persistAuthOperation({
        type: 'oauth-login',
        provider: 'feishu',
        user: authUserRecord(user),
        session: cloneRecord(issued.session),
      });
    } catch (error) {
      removeArrayItem(cloud.sessions, issued.session);
      if (createdUser) {
        removeArrayItem(cloud.users, user);
      } else if (previousUser) {
        const index = cloud.users.findIndex((item) => item.id === previousUser.id);
        if (index >= 0) cloud.users[index] = previousUser;
        else Object.assign(user, previousUser);
      }
      user.lastLoginAt = previousLastLoginAt;
      console.error(`[cloud-auth] feishu login persist failed email=${profile.email} user=${user.id}`, error);
      throw error;
    }
    res.setHeader('Set-Cookie', [
      issued.cookie,
      clearOauthStateCookie(),
      clearOauthReturnCookie(),
      ...(options.clearLink ? [clearFeishuLinkCookie()] : []),
    ]);
    return { user: publicUser(user), member, workspace: primaryWorkspace(), returnTo: safeRelativeReturnPath(options.returnTo) };
  }

  async function loginWithFeishuCallback(url, req, res) {
    const provider = requireFeishuProvider(req);
    const returnTo = feishuOauthReturnTo(req);
    const code = String(url.searchParams.get('code') || '').trim();
    const stateParam = String(url.searchParams.get('state') || '').trim();
    const stateCookie = parseCookies(req).get(FEISHU_OAUTH_STATE_COOKIE) || '';
    if (!code) {
      const error = new Error('Feishu authorization code is missing.');
      error.status = 400;
      throw error;
    }
    if (!stateParam || !stateCookie || stateParam !== stateCookie) {
      const error = new Error('Feishu sign-in state is invalid.');
      error.status = 400;
      throw error;
    }
    const profile = normalizeFeishuUserInfo(await feishuUserInfoForCode(code, provider));
    return loginWithFeishuProfile(profile, req, res, { returnTo });
  }

  async function confirmFeishuLink(req, res) {
    const pending = pendingFeishuLink(req);
    return loginWithFeishuProfile(pending.profile, req, res, {
      forceLinkUserId: pending.user.id,
      returnTo: pending.returnTo,
      clearLink: true,
    });
  }

  function cancelFeishuLink(req, res) {
    pendingFeishuLink(req);
    res.setHeader('Set-Cookie', clearFeishuLinkCookie());
    return { ok: true };
  }

  function inviteUrlForToken(raw, req, email = '') {
    const base = publicLinkOrigin(req);
    const params = new URLSearchParams({
      email: normalizeEmail(email),
      token: String(raw || ''),
    });
    return base ? `${base}/activate?${params.toString()}` : '';
  }

  function resetUrlForToken(raw, req) {
    const base = publicLinkOrigin(req);
    return base ? `${base}/reset-password?token=${encodeURIComponent(raw)}` : '';
  }

    function ensureHumanForUser(user, role = 'member', options = {}) {
      state.humans = safeArray(state.humans);
      const normalizedRole = normalizeCloudRole(role);
      const workspaceId = String(options.workspaceId || state.connection?.workspaceId || primaryWorkspace()?.id || 'local').trim();
      let human = options.humanId
        ? state.humans.find((item) => item.id === options.humanId)
        : null;
      if (human && human.id === 'hum_local' && human.authUserId !== user.id) {
        human = null;
      }
      if (human?.workspaceId && human.workspaceId !== workspaceId && !options.humanId) human = null;
      if (!human) {
        human = state.humans.find((item) => (
          item.authUserId === user.id
          && item.workspaceId === workspaceId
          && item.status !== 'removed'
        ));
      }
      if (!human) {
        human = state.humans.find((item) => (
          item.userId === user.id
          && item.workspaceId === workspaceId
          && item.status !== 'removed'
        ));
      }
      if (!human) {
        human = state.humans.find((item) => (
          item.authUserId === user.id
          && !item.workspaceId
          && item.status !== 'removed'
        ));
      }
      if (!human) {
        human = state.humans.find((item) => (
          normalizeEmail(item.email) === user.email
          && item.status !== 'removed'
          && !item.authUserId
          && (!item.workspaceId || item.workspaceId === workspaceId)
        ));
      }
      if (!human) {
        human = {
          id: makeId('hum'),
          workspaceId,
          name: user.name || user.email.split('@')[0],
          email: user.email,
          role: normalizedRole,
          status: 'online',
          createdAt: now(),
        };
      state.humans.push(human);
      }
      human.authUserId = user.id;
      human.userId = human.userId || user.id;
      if (!human.workspaceId) human.workspaceId = workspaceId;
      human.name = user.name || human.name || user.email.split('@')[0];
      human.email = user.email;
      human.role = normalizedRole;
      if (user.avatarUrl && !human.avatarUrl && !human.avatar) {
        human.avatarUrl = user.avatarUrl;
        human.avatar = user.avatarUrl;
      }
      human.status = 'online';
      human.lastSeenAt = now();
      human.presenceUpdatedAt = human.lastSeenAt;
      delete human.removedAt;
      return human;
    }

  function addHumanToAllChannel(human) {
    if (!human?.id) return null;
    return ensureWorkspaceAllChannel({
      state,
      workspaceId: human.workspaceId || state.connection?.workspaceId || primaryWorkspace()?.id || 'local',
      humanIds: [human.id],
      makeId,
      now,
    }).channel;
  }

    async function login(body, req, res) {
      if (!hasAuthProvider('email_password')) {
        const error = new Error('Email password sign-in is not enabled.');
        error.status = 403;
        throw error;
      }
      const cloud = ensureCloudState();
      const email = normalizeEmail(body.email);
      const user = cloud.users.find((item) => item.email === email && !item.disabledAt);
      const member = user ? memberForUser(user.id) : null;
      if (!user || !verifyPassword(body.password || '', user.passwordHash)) {
        const error = new Error('Invalid email or password.');
        error.status = 401;
        throw error;
    }
      if (member) {
        const human = humanForMember(member, user) || ensureHumanForUser(user, member.role, {
          humanId: member.humanId,
          workspaceId: member.workspaceId,
        });
        if (human?.id && member.humanId !== human.id) member.humanId = human.id;
        markHumanPresence(human, 'online');
      }
      const previousLastLoginAt = user.lastLoginAt || null;
      const issued = issueSession(user, req);
      try {
        await persistAuthOperation({
          type: 'login',
          user: loginUserRecord(user),
          session: cloneRecord(issued.session),
        });
      } catch (error) {
        removeArrayItem(cloud.sessions, issued.session);
        user.lastLoginAt = previousLastLoginAt;
        console.error(`[cloud-auth] login persist failed user=${user.id}`, error);
        throw error;
      }
      res.setHeader('Set-Cookie', issued.cookie);
      return { user: publicUser(user), member, workspace: primaryWorkspace() };
    }

    async function registerOpenAccount(body, req, res) {
      if (!hasAuthProvider('email_password')) {
        const error = new Error('Email password account creation is not enabled.');
        error.status = 403;
        throw error;
      }
      const cloud = ensureCloudState();
      const email = normalizeEmail(body.email);
      if (!isValidEmail(email)) {
        const error = new Error('A valid email is required.');
        error.status = 400;
        throw error;
      }
      if (userWithEmail(email)) {
        const error = new Error('User already exists.');
        error.status = 409;
        throw error;
      }
      const password = validatePassword(body.password);
      const createdAt = now();
      const user = {
        id: makeUserId(),
        email,
        name: String(body.name || email.split('@')[0]).trim(),
        passwordHash: scryptPassword(password),
        avatarUrl: '',
        language: normalizeLanguagePreference(body.language),
        emailVerifiedAt: null,
        createdAt,
        updatedAt: createdAt,
        lastLoginAt: null,
      };
      cloud.users.push(user);
      console.info(`[cloud-auth] open account registered email=${email} user=${user.id}`);
      const issued = issueSession(user, req);
      try {
        await persistAuthOperation({
          type: 'register-open-account',
          user: authUserRecord(user),
          session: cloneRecord(issued.session),
        });
      } catch (error) {
        removeArrayItem(cloud.sessions, issued.session);
        removeArrayItem(cloud.users, user);
        console.error(`[cloud-auth] open account persist failed email=${email} user=${user.id}`, error);
        if (error?.code === '23505') {
          const duplicate = new Error('User already exists.');
          duplicate.status = 409;
          throw duplicate;
        }
        throw error;
      }
      res.setHeader('Set-Cookie', issued.cookie);
      return { user: publicUser(user), member: null, workspace: null };
    }

  async function logout(req, res) {
    const auth = currentActor(req);
    const session = currentSession(req);
    const previousRevokedAt = session?.revokedAt || null;
    if (session) session.revokedAt = now();
    if (auth) markHumanPresence(humanForMember(auth.member, auth.user), 'offline');
    if (session) {
      try {
        await persistAuthOperation({
          type: 'logout',
          session: cloneRecord(session),
        });
      } catch (error) {
        session.revokedAt = previousRevokedAt;
        console.error(`[cloud-auth] logout persist failed session=${session.id}`, error);
        throw error;
      }
    }
    res.setHeader('Set-Cookie', clearSessionCookie());
    return { ok: true };
  }

    async function touchPresence(req) {
      const auth = currentActor(req);
      if (!auth) {
        const error = new Error('Login is required.');
        error.status = 401;
        throw error;
      }
      const human = humanForMember(auth.member, auth.user)
        || ensureHumanForUser(auth.user, auth.member.role, {
          humanId: auth.member.humanId,
          workspaceId: auth.member.workspaceId,
        });
      if (human?.id && auth.member.humanId !== human.id) auth.member.humanId = human.id;
      const previousSeen = Date.parse(human.lastSeenAt || '');
      const changed = markHumanPresence(human, 'online');
      const shouldPersist = changed || !previousSeen || Date.now() - previousSeen > HUMAN_PRESENCE_PERSIST_INTERVAL_MS;
      if (shouldPersist) await persistState({ workspaceId: auth.member.workspaceId });
      return { human, member: auth.member, timeoutMs: HUMAN_PRESENCE_TIMEOUT_MS };
    }

    function requireInviteActor(req) {
      const auth = currentActor(req);
      if (!auth) {
        const error = new Error('Login is required.');
        error.status = 401;
        throw error;
      }
      return auth;
    }

    function normalizedInviteEmails(value) {
      const rawItems = Array.isArray(value)
        ? value.flatMap((item) => String(item || '').split(/[\s,;，；]+/))
        : String(value || '').split(/[\s,;，；]+/);
      const emails = [];
      const seen = new Set();
      const invalid = [];
      for (const item of rawItems) {
        const email = normalizeEmail(item);
        if (!email || seen.has(email)) continue;
        if (!isValidEmail(email)) {
          invalid.push(email);
          continue;
        }
        seen.add(email);
        emails.push(email);
      }
      if (invalid.length) {
        const error = new Error(`Invalid invite email: ${invalid.join(', ')}`);
        error.status = 400;
        throw error;
      }
      return emails;
    }

    function assertInvitationRequest(auth, email, role) {
      if (!email || !isValidEmail(email)) {
        const error = new Error('A valid invite email is required.');
        error.status = 400;
        throw error;
      }
      if (!canInviteRole(auth.member.role, role)) {
        const error = new Error('Workspace role is not allowed.');
        error.status = 403;
        throw error;
      }
    }

    function createInvitationRecord(auth, body, req) {
      const cloud = ensureCloudState();
      const workspace = primaryWorkspace();
      const email = normalizeEmail(body.email);
      const role = normalizeCloudRole(body.role, null);
      assertInvitationRequest(auth, email, role);
      const createdAt = now();
      const raw = uniqueCloudToken('mc_inv');
      const registeredUser = activeUserWithEmail(email);
      const registeredMember = registeredUser ? memberForUser(registeredUser.id, workspace.id) : null;
      let human = registeredMember ? humanForMember(registeredMember, registeredUser) : null;
      if (!human) {
        human = safeArray(state.humans).find((item) => (
          normalizeEmail(item.email) === email
          && item.status !== 'removed'
          && !item.authUserId
        ));
      }
      if (!human) {
        human = {
          id: makeId('hum'),
          workspaceId: workspace.id,
          name: String(body.name || email.split('@')[0]).trim(),
          email,
          role,
          status: 'invited',
          createdAt: now(),
        };
        state.humans.push(human);
        addHumanToAllChannel(human);
      } else if (!registeredUser) {
        if (!human.workspaceId) human.workspaceId = workspace.id;
        human.role = role;
        human.status = 'invited';
        human.updatedAt = now();
      }
      const ttlMs = Number(body.ttlMs || INVITATION_TTL_MS);
      const invitation = {
        id: makeId('inv'),
        workspaceId: workspace.id,
        humanId: human?.id || null,
        email,
        role,
        tokenHash: sha256(raw),
        invitedBy: auth.user.id,
        expiresAt: new Date(Date.now() + (Number.isFinite(ttlMs) ? ttlMs : INVITATION_TTL_MS)).toISOString(),
        acceptedAt: null,
        revokedAt: null,
        createdAt,
      };
      cloud.invitations.push(invitation);
      systemNotification('member_invited', {
        actorUserId: auth.user.id,
        actorHumanId: auth.member.humanId,
        targetEmail: email,
        targetHumanId: human.id,
        targetRole: role,
        message: `${auth.user.name || auth.user.email} invited ${email} as ${role}.`,
      });
      console.info(`[cloud-auth] member invited email=${email} role=${role} actor=${auth.user.id}`);
      return {
        invitation: publicInvitation(invitation),
        inviteToken: raw,
        inviteUrl: inviteUrlForToken(raw, req, email),
      };
    }

    async function createInvitation(body, req) {
      const auth = requireInviteActor(req);
      const result = createInvitationRecord(auth, body, req);
      await persistCloudState({ workspaceId: auth.member.workspaceId, reason: 'cloud_invitation_created' });
      return result;
    }

    async function batchCreateInvitations(body, req) {
      const auth = requireInviteActor(req);
      const emails = normalizedInviteEmails(body.emails || body.email);
      if (!emails.length) {
        const error = new Error('At least one invite email is required.');
        error.status = 400;
        throw error;
      }
      const role = normalizeCloudRole(body.role, null);
      for (const email of emails) assertInvitationRequest(auth, email, role);
      const invitations = emails.map((email) => {
        const result = createInvitationRecord(auth, { ...body, email, role }, req);
        return { ...result.invitation, inviteToken: result.inviteToken, inviteUrl: result.inviteUrl };
      });
      await persistCloudState({ workspaceId: auth.member.workspaceId, reason: 'cloud_invitations_created' });
      return { invitations };
    }

    function invitationsForUser(user) {
      const email = normalizeEmail(user?.email);
      if (!email) return [];
      return ensureCloudState().invitations
        .filter((item) => normalizeEmail(item.email) === email)
        .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
    }

    function workspacesForUser(user) {
      const cloud = ensureCloudState();
      const memberships = cloud.workspaceMembers.filter((member) => (
        member.userId === user?.id
        && member.status === 'active'
      ));
      const workspaceIds = new Set(memberships.map((member) => member.workspaceId));
      return cloud.workspaces.filter((workspace) => workspaceIds.has(workspace.id) && !workspace.deletedAt);
    }

    function deletedWorkspacesForUser(user) {
      const cloud = ensureCloudState();
      const memberships = cloud.workspaceMembers.filter((member) => (
        member.userId === user?.id
        && member.status === 'active'
      ));
      const workspaceIds = new Set(memberships.map((member) => member.workspaceId));
      return cloud.workspaces.filter((workspace) => workspaceIds.has(workspace.id) && workspace.deletedAt);
    }

    function consoleInvitationForUser(invitationId, user) {
      const invitation = invitationsForUser(user).find((item) => item.id === invitationId) || null;
      if (!invitation) {
        const error = new Error('Invitation was not found.');
        error.status = 404;
        throw error;
      }
      if (invitation.acceptedAt || invitation.revokedAt || invitation.metadata?.declinedAt) {
        const error = new Error('Invitation has already been used.');
        error.status = 409;
        throw error;
      }
      if (new Date(invitation.expiresAt).getTime() <= Date.now()) {
        const error = new Error('Invitation has expired.');
        error.status = 410;
        throw error;
      }
      return invitation;
    }

    function consoleStateForUser(user) {
      return {
        workspaces: workspacesForUser(user),
        deletedWorkspaces: deletedWorkspacesForUser(user),
        invitations: invitationsForUser(user).map(publicInvitation),
      };
    }

    async function createConsoleServer(body, req) {
      const user = requireAuthenticatedUser(req);
      const cloud = ensureCloudState();
      const name = String(body.name || '').trim();
      if (!name) {
        const error = new Error('Server name is required.');
        error.status = 400;
        throw error;
      }
      const slug = normalizeWorkspaceSlug(body.slug, name);
      if (slug.length < WORKSPACE_SLUG_MIN_LENGTH || slug.length > WORKSPACE_SLUG_MAX_LENGTH || !WORKSPACE_SLUG_PATTERN.test(slug)) {
        const error = new Error(`Server slug must be ${WORKSPACE_SLUG_MIN_LENGTH}-${WORKSPACE_SLUG_MAX_LENGTH} lowercase letters, numbers, or hyphens.`);
        error.status = 400;
        throw error;
      }
      if (cloud.workspaces.some((workspace) => String(workspace.slug || '').toLowerCase() === slug)) {
        const error = new Error('Server slug is already taken.');
        error.status = 409;
        throw error;
      }
      const createdAt = now();
      const workspace = {
        id: makeId('wsp'),
        slug,
        name,
        ownerUserId: user.id,
        avatar: '',
        onboardingAgentId: '',
        newAgentGreetingEnabled: true,
        createdAt,
        updatedAt: createdAt,
      };
      cloud.workspaces.push(workspace);
      const human = ensureHumanForUser(user, 'admin', { workspaceId: workspace.id });
      const member = {
        id: makeId('wmem'),
        workspaceId: workspace.id,
        userId: user.id,
        humanId: human.id,
        role: 'admin',
        status: 'active',
        joinedAt: createdAt,
        createdAt,
      };
      cloud.workspaceMembers.push(member);
      addHumanToAllChannel(human);
      state.connection.workspaceId = workspace.id;
      applyWorkspaceScopedSettings(workspace);
      console.info(`[cloud-auth] console server created workspace=${workspace.id} slug=${workspace.slug} owner=${user.id}`);
      await persistAuthState({ workspaceId: workspace.id, reason: 'console_server_created' });
      return { server: workspace, member };
    }

    async function switchConsoleServer(slug, req) {
      const user = requireAuthenticatedUser(req);
      const normalizedSlug = String(slug || '').trim().toLowerCase();
      const cloud = ensureCloudState();
      const workspace = cloud.workspaces.find((item) => (
        String(item.slug || item.id || '').toLowerCase() === normalizedSlug
      ));
      if (!workspace) {
        const error = new Error('Server was not found.');
        error.status = 404;
        throw error;
      }
      if (workspace.deletedAt) {
        const error = new Error('Server is in Lost Space.');
        error.status = 410;
        throw error;
      }
      const member = memberForUser(user.id, workspace.id);
      if (!member || (member.status && member.status !== 'active')) {
        const error = new Error('You are not a member of this server.');
        error.status = 403;
        throw error;
      }
      state.connection.workspaceId = workspace.id;
      applyWorkspaceScopedSettings(workspace);
      console.info(`[cloud-auth] console server switched workspace=${workspace.id} slug=${workspace.slug || workspace.id} user=${user.id}`);
      return { server: workspace, member };
    }

    async function deleteConsoleServer(slug, req) {
      const auth = currentActor(req);
      if (!auth || normalizeCloudRole(auth.member.role) !== 'admin') {
        const error = new Error(auth ? 'Workspace role is not allowed.' : 'Login is required.');
        error.status = auth ? 403 : 401;
        throw error;
      }
      const normalizedSlug = String(slug || '').trim().toLowerCase();
      const cloud = ensureCloudState();
      const workspace = primaryWorkspace();
      if (String(workspace.slug || workspace.id || '').toLowerCase() !== normalizedSlug) {
        const error = new Error('Type the current server slug to delete it.');
        error.status = 400;
        throw error;
      }
      const deletedAt = now();
      workspace.deletedAt = deletedAt;
      workspace.deletedBy = auth.user.id;
      workspace.updatedAt = deletedAt;
      const workspaceComputers = safeArray(state.computers).filter((computer) => computer.workspaceId === workspace.id);
      const workspaceComputerIds = new Set(workspaceComputers.map((computer) => computer.id));
      for (const computer of workspaceComputers) {
        computer.status = 'disabled';
        computer.disabledAt = computer.disabledAt || deletedAt;
        computer.disconnectedAt = computer.disconnectedAt || deletedAt;
        computer.disabledByServerDeletedAt = deletedAt;
        computer.updatedAt = deletedAt;
      }
      for (const agent of safeArray(state.agents)) {
        if (!workspaceComputerIds.has(agent.computerId)) continue;
        agent.status = 'disabled';
        agent.disabledByServerDeletedAt = deletedAt;
        agent.statusUpdatedAt = deletedAt;
        agent.updatedAt = deletedAt;
      }
      for (const joinLink of safeArray(cloud.joinLinks)) {
        if (joinLink.workspaceId === workspace.id && !joinLink.revokedAt) {
          joinLink.revokedAt = deletedAt;
          joinLink.revokedBy = auth.user.id;
          joinLink.updatedAt = deletedAt;
        }
      }
      for (const pair of safeArray(cloud.pairingTokens)) {
        if (pair.workspaceId === workspace.id && !pair.revokedAt && !pair.consumedAt) pair.revokedAt = deletedAt;
      }
      for (const token of safeArray(cloud.computerTokens)) {
        if (token.workspaceId === workspace.id && !token.revokedAt) token.revokedAt = deletedAt;
      }
      const nextWorkspace = workspacesForUser(auth.user).find((item) => item.id !== workspace.id) || null;
      state.connection.workspaceId = nextWorkspace?.id || 'local';
      applyWorkspaceScopedSettings(nextWorkspace);
      console.info(`[cloud-auth] console server soft-deleted workspace=${workspace.id} slug=${workspace.slug || workspace.id} actor=${auth.user.id}`);
      await persistCloudState({ workspaceId: workspace.id, reason: 'console_server_deleted' });
      return { deleted: workspace, nextWorkspace };
    }

    async function restoreConsoleServer(slug, req) {
      const user = requireAuthenticatedUser(req);
      const normalizedSlug = String(slug || '').trim().toLowerCase();
      const cloud = ensureCloudState();
      const workspace = cloud.workspaces.find((item) => (
        String(item.slug || item.id || '').toLowerCase() === normalizedSlug
      ));
      if (!workspace || !workspace.deletedAt) {
        const error = new Error('Server was not found in Lost Space.');
        error.status = 404;
        throw error;
      }
      const member = memberForUser(user.id, workspace.id);
      if (!member || (member.status && member.status !== 'active')) {
        const error = new Error('You are not a member of this server.');
        error.status = 403;
        throw error;
      }
      const restoredAt = now();
      workspace.deletedAt = null;
      workspace.deletedBy = null;
      workspace.restoredAt = restoredAt;
      workspace.updatedAt = restoredAt;
      const workspaceComputers = safeArray(state.computers).filter((computer) => computer.workspaceId === workspace.id);
      const workspaceComputerIds = new Set(workspaceComputers.map((computer) => computer.id));
      for (const computer of workspaceComputers) {
        if (!computer.disabledByServerDeletedAt) continue;
        computer.status = 'offline';
        computer.disabledAt = null;
        computer.disabledByServerDeletedAt = null;
        computer.updatedAt = restoredAt;
      }
      for (const agent of safeArray(state.agents)) {
        if (!workspaceComputerIds.has(agent.computerId) || !agent.disabledByServerDeletedAt) continue;
        agent.status = 'idle';
        agent.disabledByServerDeletedAt = null;
        agent.statusUpdatedAt = restoredAt;
        agent.updatedAt = restoredAt;
      }
      state.connection.workspaceId = workspace.id;
      applyWorkspaceScopedSettings(workspace);
      console.info(`[cloud-auth] console server restored workspace=${workspace.id} slug=${workspace.slug || workspace.id} user=${user.id}`);
      await persistCloudState({ workspaceId: workspace.id, reason: 'console_server_restored' });
      return { server: workspace, member };
    }

    async function updateServerProfile(body, req) {
      const user = currentUser(req);
      if (!user) {
        const error = new Error('Login is required.');
        error.status = 401;
        throw error;
      }
      const workspace = workspaceForSlug(body.workspaceSlug || body.slug || body.workspaceId);
      if (!workspace) {
        const error = new Error('Server was not found.');
        error.status = 404;
        throw error;
      }
      const member = memberForUser(user.id, workspace.id);
      if (!member || normalizeCloudRole(member.role) !== 'admin') {
        const error = new Error('Workspace role is not allowed.');
        error.status = 403;
        throw error;
      }
      const name = String(body.name ?? workspace.name ?? '').trim();
      if (!name) {
        const error = new Error('Server name is required.');
        error.status = 400;
        throw error;
      }
      const onboardingAgentId = body.onboardingAgentId === undefined
        ? workspace.onboardingAgentId || ''
        : String(body.onboardingAgentId || '').trim();
      if (onboardingAgentId && !safeArray(state.agents).some((agent) => agent.id === onboardingAgentId)) {
        const error = new Error('Onboarding agent was not found.');
        error.status = 404;
        throw error;
      }
      workspace.name = name;
      if (body.avatar !== undefined) workspace.avatar = String(body.avatar || '');
      workspace.onboardingAgentId = onboardingAgentId;
      workspace.newAgentGreetingEnabled = body.newAgentGreetingEnabled === undefined
        ? workspace.newAgentGreetingEnabled !== false
        : Boolean(body.newAgentGreetingEnabled);
      workspace.updatedAt = now();
      console.info(`[cloud-auth] server profile updated workspace=${workspace.id} actor=${user.id}`);
      await persistCloudState();
      return { workspace: { ...workspace } };
    }

    async function createJoinLink(body, req) {
      const auth = currentActor(req);
      if (!auth || normalizeCloudRole(auth.member.role) !== 'admin') {
        const error = new Error(auth ? 'Workspace role is not allowed.' : 'Login is required.');
        error.status = auth ? 403 : 401;
        throw error;
      }
      const cloud = ensureCloudState();
      const workspace = primaryWorkspace();
      const rawMaxUses = Number(body.maxUses || 0);
      const maxUses = Number.isFinite(rawMaxUses) && rawMaxUses > 0 ? Math.floor(rawMaxUses) : 0;
      let expiresAt = null;
      if (body.expiresIn && body.expiresIn !== 'never') {
        const ttlByKey = {
          '1h': 60 * 60 * 1000,
          '12h': 12 * 60 * 60 * 1000,
          '24h': 24 * 60 * 60 * 1000,
          '30d': 30 * 24 * 60 * 60 * 1000,
          '365d': 365 * 24 * 60 * 60 * 1000,
        };
        const ttlMs = ttlByKey[String(body.expiresIn || '').trim()];
        if (!ttlMs) {
          const error = new Error('Join link expiry duration is invalid.');
          error.status = 400;
          throw error;
        }
        expiresAt = new Date(Date.now() + ttlMs).toISOString();
      } else if (body.expiresAt) {
        const expires = new Date(body.expiresAt);
        if (Number.isNaN(expires.getTime())) {
          const error = new Error('Join link expiry is invalid.');
          error.status = 400;
          throw error;
        }
        expiresAt = expires.toISOString();
      }
      const raw = uniqueCloudToken('mc_join');
      const createdAt = now();
      const joinLink = {
        id: makeId('jlink'),
        workspaceId: workspace.id,
        tokenHash: sha256(raw),
        maxUses,
        usedCount: 0,
        expiresAt,
        revokedAt: null,
        createdBy: auth.user.id,
        createdAt,
        updatedAt: createdAt,
        metadata: { rawToken: raw },
      };
      cloud.joinLinks.push(joinLink);
      console.info(`[cloud-auth] join link created workspace=${workspace.id} actor=${auth.user.id} maxUses=${maxUses}`);
      await persistCloudState();
      return { joinLink: publicJoinLink(joinLink, raw, req) };
    }

    async function revokeJoinLink(joinLinkId, req) {
      const auth = currentActor(req);
      if (!auth || normalizeCloudRole(auth.member.role) !== 'admin') {
        const error = new Error(auth ? 'Workspace role is not allowed.' : 'Login is required.');
        error.status = auth ? 403 : 401;
        throw error;
      }
      const workspace = primaryWorkspace();
      const joinLink = safeArray(ensureCloudState().joinLinks).find((item) => (
        item.id === String(joinLinkId || '')
        && item.workspaceId === workspace.id
      ));
      if (!joinLink) {
        const error = new Error('Join link was not found.');
        error.status = 404;
        throw error;
      }
      joinLink.revokedAt = now();
      joinLink.revokedBy = auth.user.id;
      joinLink.updatedAt = joinLink.revokedAt;
      console.info(`[cloud-auth] join link revoked id=${joinLink.id} actor=${auth.user.id}`);
      await persistCloudState();
      return { joinLink: publicJoinLink(joinLink) };
    }

    function joinLinkForToken(raw) {
      const tokenValue = String(raw || '').trim();
      if (!tokenValue) return null;
      const hash = sha256(tokenValue);
      return safeArray(ensureCloudState().joinLinks).find((item) => item.tokenHash === hash) || null;
    }

    function assertJoinLinkCanBeUsed(joinLink) {
      if (!joinLink) {
        const error = new Error('Join link was not found.');
        error.status = 404;
        throw error;
      }
      if (joinLink.revokedAt) {
        const error = new Error('Join link has been revoked.');
        error.status = 410;
        throw error;
      }
      if (joinLink.expiresAt && new Date(joinLink.expiresAt).getTime() <= Date.now()) {
        const error = new Error('Join link has expired.');
        error.status = 410;
        throw error;
      }
      if (joinLink.maxUses && Number(joinLink.usedCount || 0) >= Number(joinLink.maxUses)) {
        const error = new Error('Join link has no uses left.');
        error.status = 409;
        throw error;
      }
      return joinLink;
    }

    function publicJoinWorkspace(workspace) {
      if (!workspace) return null;
      return {
        id: workspace.id,
        slug: workspace.slug || workspace.id,
        name: workspace.name || workspace.slug || 'Server',
        avatar: workspace.avatar || '',
        ownerUserId: workspace.ownerUserId || '',
      };
    }

    function joinLinkStatus(raw, req) {
      const joinLink = assertJoinLinkCanBeUsed(joinLinkForToken(raw));
      const workspace = ensureCloudState().workspaces.find((item) => item.id === joinLink.workspaceId) || null;
      if (!workspace) {
        const error = new Error('Server was not found.');
        error.status = 404;
        throw error;
      }
      const user = currentUser(req);
      const existingMember = user ? memberForUser(user.id, workspace.id) : null;
      return {
        joinLink: publicJoinLink(joinLink, raw, req),
        workspace: publicJoinWorkspace(workspace),
        alreadyMember: Boolean(existingMember),
      };
    }

    async function acceptJoinLink(body, req) {
      const user = requireAuthenticatedUser(req);
      const raw = String(body.token || body.joinToken || '').trim();
      const joinLink = assertJoinLinkCanBeUsed(joinLinkForToken(raw));
      const cloud = ensureCloudState();
      const workspace = cloud.workspaces.find((item) => item.id === joinLink.workspaceId) || null;
      if (!workspace) {
        const error = new Error('Server was not found.');
        error.status = 404;
        throw error;
      }
      const joinedAt = now();
      let member = memberForUser(user.id, workspace.id);
      if (!member) {
        const human = ensureHumanForUser(user, 'member', { workspaceId: workspace.id });
        addHumanToAllChannel(human);
        member = {
          id: makeId('wmem'),
          workspaceId: workspace.id,
          userId: user.id,
          humanId: human?.id || '',
          role: 'member',
          status: 'active',
          joinedAt,
          createdAt: joinedAt,
          updatedAt: joinedAt,
        };
        cloud.workspaceMembers.push(member);
        joinLink.usedCount = Number(joinLink.usedCount || 0) + 1;
      } else {
        member.status = 'active';
        member.joinedAt ||= joinedAt;
        member.updatedAt = joinedAt;
      }
      joinLink.updatedAt = joinedAt;
      state.connection.workspaceId = workspace.id;
      applyWorkspaceScopedSettings(workspace);
      console.info(`[cloud-auth] join link accepted workspace=${workspace.id} user=${user.id}`);
      await persistCloudState({ workspaceId: workspace.id, reason: 'cloud_join_link_accepted' });
      return {
        server: workspace,
        workspace,
        member: publicMember(member),
        joinLink: publicJoinLink(joinLink, raw, req),
      };
    }

    async function acceptConsoleInvitation(invitationId, req) {
      const user = requireAuthenticatedUser(req);
      const cloud = ensureCloudState();
      const invitation = consoleInvitationForUser(String(invitationId || ''), user);
      const acceptedAt = now();
      const role = normalizeCloudRole(invitation.role || 'member');
      let member = memberForUser(user.id, invitation.workspaceId);
      if (!member) {
        const human = ensureHumanForUser(user, role, {
          humanId: invitation.humanId,
          workspaceId: invitation.workspaceId,
        });
        if (human) {
          human.role = role;
          human.status = 'online';
          human.updatedAt = acceptedAt;
          addHumanToAllChannel(human);
        }
        member = {
          id: makeId('wmem'),
          workspaceId: invitation.workspaceId,
          userId: user.id,
          humanId: human?.id || '',
          role,
          status: 'active',
          joinedAt: acceptedAt,
          createdAt: acceptedAt,
          updatedAt: acceptedAt,
        };
        cloud.workspaceMembers.push(member);
      } else {
        member.status = 'active';
        member.role = normalizeCloudRole(member.role || role);
        member.joinedAt ||= acceptedAt;
        member.updatedAt = acceptedAt;
      }
      invitation.acceptedAt = acceptedAt;
      invitation.acceptedBy = user.id;
      invitation.metadata = {
        ...(invitation.metadata || {}),
        consoleAction: 'accepted',
        resolvedAt: acceptedAt,
        resolvedBy: user.id,
      };
      systemNotification('member_joined', {
        actorUserId: user.id,
        actorHumanId: member.humanId,
        targetEmail: user.email,
        targetUserId: user.id,
        targetHumanId: member.humanId,
        targetRole: role,
        message: `${user.name || user.email} accepted an invitation from Console.`,
      });
      await persistCloudState({ workspaceId: invitation.workspaceId, reason: 'cloud_invitation_accepted' });
      return {
        invitation: publicInvitation(invitation),
        member: publicMember(member),
        console: consoleStateForUser(user),
      };
    }

    async function declineConsoleInvitation(invitationId, req) {
      const user = requireAuthenticatedUser(req);
      const invitation = consoleInvitationForUser(String(invitationId || ''), user);
      const declinedAt = now();
      invitation.revokedAt = declinedAt;
      invitation.metadata = {
        ...(invitation.metadata || {}),
        consoleAction: 'declined',
        declinedAt,
        declinedBy: user.id,
        resolvedAt: declinedAt,
        resolvedBy: user.id,
      };
      await persistCloudState();
      return {
        invitation: publicInvitation(invitation),
        console: consoleStateForUser(user),
      };
    }

    function invitationForToken(raw) {
      const value = String(raw || '').trim();
      if (!value) return null;
      const hash = sha256(value);
      return ensureCloudState().invitations.find((item) => item.tokenHash === hash) || null;
    }

    function assertInvitationCanBeAccepted(invitation) {
      if (!invitation) {
        const error = new Error('A valid invitation token is required.');
        error.status = 404;
        throw error;
      }
      if (invitation.revokedAt) {
        const error = new Error('Invitation has been revoked.');
        error.status = 410;
        throw error;
      }
      if (activeUserWithEmail(invitation.email)) {
        const error = new Error('User already exists.');
        error.status = 409;
        throw error;
      }
      if (invitation.acceptedAt) {
        const error = new Error('Invitation has already been used.');
        error.status = 409;
        throw error;
      }
      if (new Date(invitation.expiresAt).getTime() <= Date.now()) {
        const error = new Error('Invitation has expired.');
        error.status = 410;
        throw error;
      }
      return invitation;
    }

    function invitationStatus(raw) {
      const invitation = assertInvitationCanBeAccepted(invitationForToken(raw));
      const human = safeArray(state.humans).find((item) => item.id === invitation.humanId) || null;
      return {
        invitation: {
          ...publicInvitation(invitation),
          name: human?.name || invitation.email.split('@')[0],
          avatarUrl: human?.avatarUrl || human?.avatar || '',
          status: 'pending',
        },
      };
    }

	    async function registerWithInvite(body, req, res) {
      const cloud = ensureCloudState();
      const raw = String(body.inviteToken || body.token || '').trim();
      const email = normalizeEmail(body.email);
      const invitation = raw ? invitationForToken(raw) : null;
      if (invitation) assertInvitationCanBeAccepted(invitation);
      const workspace = invitation
        ? ensureCloudState().workspaces.find((item) => item.id === invitation.workspaceId) || primaryWorkspace()
        : primaryWorkspace();
      if (invitation && Object.prototype.hasOwnProperty.call(body, 'role')) {
        const error = new Error('Role is controlled by the invitation.');
        error.status = 400;
        throw error;
      }
      const finalEmail = invitation?.email || email;
      if (!finalEmail || (invitation && email && email !== invitation.email)) {
        const error = new Error('Email must match the invitation.');
        error.status = 400;
        throw error;
      }
      if (!isValidEmail(finalEmail)) {
        const error = new Error('A valid email is required.');
        error.status = 400;
        throw error;
      }
      if (userWithEmail(finalEmail)) {
        const error = new Error('User already exists.');
        error.status = 409;
        throw error;
      }
      const password = validatePassword(body.password);
      const user = {
        id: makeUserId(),
        email: finalEmail,
        name: String(body.name || finalEmail.split('@')[0]).trim(),
	        passwordHash: scryptPassword(password),
	        avatarUrl: String(body.avatarUrl || body.avatar || '').trim(),
	        language: normalizeLanguagePreference(body.language),
	        emailVerifiedAt: invitation ? now() : null,
        createdAt: now(),
        updatedAt: now(),
        lastLoginAt: null,
      };
      cloud.users.push(user);
      const role = normalizeCloudRole(invitation?.role || 'member');
      const human = ensureHumanForUser(user, role, {
        humanId: invitation?.humanId,
        workspaceId: workspace.id,
      });
      if (user.avatarUrl) {
        human.avatarUrl = user.avatarUrl;
        human.avatar = user.avatarUrl;
      }
      addHumanToAllChannel(human);
      cloud.workspaceMembers.push({
        id: makeId('wmem'),
        workspaceId: workspace.id,
        userId: user.id,
        humanId: human.id,
        role,
        status: 'active',
        joinedAt: now(),
        createdAt: now(),
      });
      if (invitation) {
        invitation.acceptedAt = now();
        invitation.acceptedBy = user.id;
      }
      systemNotification('member_joined', {
        actorUserId: user.id,
        actorHumanId: human.id,
        targetEmail: user.email,
        targetUserId: user.id,
        targetHumanId: human.id,
        targetRole: role,
        message: `${user.name || user.email} accepted an invitation and joined as ${role}.`,
      });
      console.info(`[cloud-auth] invitation accepted email=${user.email} role=${role} user=${user.id}`);
      const issued = issueSession(user, req);
      await persistCloudState({ workspaceId: workspace.id, reason: 'cloud_invite_registration' });
      res.setHeader('Set-Cookie', issued.cookie);
	      return { user: publicUser(user), member: memberForUser(user.id, workspace.id), workspace };
	    }

	    async function updateUserPreferences(body, req) {
	      const user = requireAuthenticatedUser(req);
	      let changed = false;
	      if (Object.prototype.hasOwnProperty.call(body || {}, 'language')) {
	        const nextLanguage = normalizeLanguagePreference(body.language);
	        if (user.language !== nextLanguage) {
	          user.language = nextLanguage;
	          changed = true;
	        }
	      }
	      if (changed) {
	        user.updatedAt = now();
	        console.info(`[cloud-auth] user preferences updated user=${user.id}`);
	        await persistCloudState();
	      }
	      return { user: publicUser(user) };
	    }

    function publicMember(member) {
      if (!member) return null;
      const cloud = ensureCloudState();
      return {
        ...member,
        user: publicUser(cloud.users.find((user) => user.id === member.userId)),
        human: safeArray(state.humans).find((human) => human.id === member.humanId) || null,
      };
    }

    function activeAdminCount(workspaceId = primaryWorkspace()?.id) {
      return ensureCloudState().workspaceMembers.filter((member) => (
        member.workspaceId === workspaceId
        && member.status === 'active'
        && normalizeCloudRole(member.role) === 'admin'
      )).length;
    }

    async function updateMemberRole(memberId, body, req) {
      const auth = currentActor(req);
      if (!auth || normalizeCloudRole(auth.member.role) !== 'admin') {
        const error = new Error(auth ? 'Workspace role is not allowed.' : 'Login is required.');
        error.status = auth ? 403 : 401;
        throw error;
      }
      const cloud = ensureCloudState();
      const workspace = primaryWorkspace();
      const member = cloud.workspaceMembers.find((item) => (
        item.id === memberId
        && item.workspaceId === workspace.id
        && item.status === 'active'
      ));
      if (!member) {
        const error = new Error('Member was not found.');
        error.status = 404;
        throw error;
      }
      const role = normalizeCloudRole(body.role, null);
      if (!role) {
        const error = new Error('Role is not allowed.');
        error.status = 400;
        throw error;
      }
      const previousRole = normalizeCloudRole(member.role);
      if (workspace.ownerUserId && member.userId === workspace.ownerUserId && role !== 'admin') {
        const error = new Error('Owner role cannot be changed.');
        error.status = 403;
        throw error;
      }
      if (previousRole === 'admin' && role !== 'admin' && activeAdminCount(workspace.id) <= 1) {
        const error = new Error('At least one admin must remain.');
        error.status = 403;
        throw error;
      }
      if (!canUpdateMemberRole(auth.member.role, previousRole, role)) {
        const error = new Error('Workspace role is not allowed.');
        error.status = 403;
        throw error;
      }
      member.role = role;
      member.updatedAt = now();
      const human = safeArray(state.humans).find((item) => item.id === member.humanId);
      if (human) {
        human.role = role;
        human.updatedAt = member.updatedAt;
      }
      systemNotification('member_role_changed', {
        actorUserId: auth.user.id,
        actorHumanId: auth.member.humanId,
        targetUserId: member.userId,
        targetHumanId: member.humanId,
        previousRole,
        targetRole: role,
        message: `${auth.user.name || auth.user.email} changed a member role from ${previousRole} to ${role}.`,
      });
      console.info(`[cloud-auth] member role changed member=${member.id} from=${previousRole} to=${role} actor=${auth.user.id}`);
      await persistCloudState({ workspaceId: workspace.id, reason: 'cloud_member_role_changed' });
      return { member: publicMember(member) };
    }

    function passwordResetForToken(raw) {
      const value = String(raw || '').trim();
      if (!value) return null;
      const hash = sha256(value);
      return ensureCloudState().passwordResetTokens.find((item) => item.tokenHash === hash) || null;
    }

    function assertPasswordResetCanBeUsed(reset) {
      if (!reset) {
        const error = new Error('A valid reset token is required.');
        error.status = 404;
        throw error;
      }
      if (reset.revokedAt || reset.consumedAt || new Date(reset.expiresAt).getTime() <= Date.now()) {
        const error = new Error('Password reset link has expired.');
        error.status = 410;
        throw error;
      }
      const user = ensureCloudState().users.find((item) => item.id === reset.userId && !item.disabledAt);
      const member = user ? memberForUser(user.id, reset.workspaceId) : null;
      if (!user) {
        const error = new Error('Password reset user was not found.');
        error.status = 404;
        throw error;
      }
      return { reset, user, member };
    }

    async function createPasswordReset(body, req) {
      const auth = currentActor(req);
      if (!auth || normalizeCloudRole(auth.member.role) !== 'admin') {
        const error = new Error(auth ? 'Workspace role is not allowed.' : 'Login is required.');
        error.status = auth ? 403 : 401;
        throw error;
      }
      const cloud = ensureCloudState();
      const workspace = primaryWorkspace();
      const targetId = String(body.memberId || body.userId || '').trim();
      const member = cloud.workspaceMembers.find((item) => (
        item.workspaceId === workspace.id
        && item.status === 'active'
        && (item.id === targetId || item.userId === targetId)
      ));
      if (!member) {
        const error = new Error('Member was not found.');
        error.status = 404;
        throw error;
      }
      if (normalizeCloudRole(member.role) === 'admin') {
        const error = new Error('Admin password cannot be reset here.');
        error.status = 403;
        throw error;
      }
      const user = cloud.users.find((item) => item.id === member.userId && !item.disabledAt);
      if (!user) {
        const error = new Error('Member user was not found.');
        error.status = 404;
        throw error;
      }
      const createdAt = now();
      const previousPasswordHash = user.passwordHash;
      const previousUpdatedAt = user.updatedAt;
      const previousResetState = cloud.passwordResetTokens
        .filter((item) => item.userId === user.id && item.workspaceId === workspace.id)
        .map((item) => ({ item, revokedAt: item.revokedAt || null }));
      const previousSessionState = cloud.sessions
        .filter((session) => session.userId === user.id)
        .map((session) => ({ session, revokedAt: session.revokedAt || null }));
      const revokedCount = revokeActivePasswordResetsForUser(user.id, workspace.id, { actorUserId: auth.user.id, revokedAt: createdAt });
      if (revokedCount) console.info(`[cloud-auth] revoked previous password resets user=${user.id} count=${revokedCount} actor=${auth.user.id}`);
      const raw = uniqueCloudToken('mc_reset');
      const reset = {
        id: makeId('preset'),
        workspaceId: workspace.id,
        userId: user.id,
        tokenHash: sha256(raw),
        createdBy: auth.user.id,
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS).toISOString(),
        consumedAt: null,
        revokedAt: null,
        createdAt,
      };
      cloud.passwordResetTokens.push(reset);
      user.passwordHash = '';
      user.updatedAt = createdAt;
      for (const session of cloud.sessions) {
        if (session.userId === user.id && !session.revokedAt) session.revokedAt = createdAt;
      }
      const notification = systemNotification('member_password_reset', {
        actorUserId: auth.user.id,
        actorHumanId: auth.member.humanId,
        targetUserId: user.id,
        targetHumanId: member.humanId,
        targetRole: normalizeCloudRole(member.role),
        message: `${auth.user.name || auth.user.email} reset a member password.`,
      });
      console.info(`[cloud-auth] password reset created user=${user.id} actor=${auth.user.id}`);
      try {
        await persistAuthOperation({
          type: 'password-reset-request',
          user: passwordUserRecord(user),
          passwordResetTokens: cloud.passwordResetTokens
            .filter((item) => item.userId === user.id && item.workspaceId === workspace.id)
            .map(cloneRecord),
          sessions: cloud.sessions
            .filter((session) => session.userId === user.id && session.revokedAt === createdAt)
            .map(cloneRecord),
        });
      } catch (error) {
        removeArrayItem(cloud.passwordResetTokens, reset);
        removeArrayItem(state.systemNotifications, notification);
        user.passwordHash = previousPasswordHash;
        user.updatedAt = previousUpdatedAt;
        for (const entry of previousResetState) entry.item.revokedAt = entry.revokedAt;
        for (const entry of previousSessionState) entry.session.revokedAt = entry.revokedAt;
        console.error(`[cloud-auth] password reset create persist failed user=${user.id} actor=${auth.user.id}`, error);
        throw error;
      }
      try {
        await persistCloudState({ workspaceId: workspace.id, reason: 'cloud_password_reset_requested' });
      } catch (error) {
        console.error(`[cloud-auth] password reset notification persist failed user=${user.id} actor=${auth.user.id}`, error);
      }
      return {
        reset: publicPasswordReset(reset, user),
        email: user.email,
        resetToken: raw,
        resetUrl: resetUrlForToken(raw, req),
      };
    }

    function resetStatus(raw) {
      const { reset, user } = assertPasswordResetCanBeUsed(passwordResetForToken(raw));
      return { reset: publicPasswordReset(reset, user) };
    }

    async function requestPasswordReset(body, req) {
      const email = normalizeEmail(body.email);
      if (!isValidEmail(email)) {
        const error = new Error('A valid email is required.');
        error.status = 400;
        throw error;
      }
      const user = userWithEmail(email);
      if (!user) {
        console.info(`[cloud-auth] password reset requested for unknown email=${email}`);
        return { ok: true, sent: false };
      }
      const workspace = primaryWorkspace();
      const createdAt = now();
      const cloud = ensureCloudState();
      const previousResetState = cloud.passwordResetTokens
        .filter((item) => item.userId === user.id && item.workspaceId === workspace.id)
        .map((item) => ({ item, revokedAt: item.revokedAt || null }));
      const revokedCount = revokeActivePasswordResetsForUser(user.id, workspace.id, { actorUserId: null, revokedAt: createdAt });
      if (revokedCount) console.info(`[cloud-auth] revoked previous password resets user=${user.id} count=${revokedCount} actor=self-service`);
      const raw = uniqueCloudToken('mc_reset');
      const reset = {
        id: makeId('preset'),
        workspaceId: workspace.id,
        userId: user.id,
        tokenHash: sha256(raw),
        createdBy: null,
        expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS).toISOString(),
        consumedAt: null,
        revokedAt: null,
        createdAt,
      };
      cloud.passwordResetTokens.push(reset);
      try {
        await persistAuthOperation({
          type: 'password-reset-request',
          user: { id: user.id },
          passwordResetTokens: cloud.passwordResetTokens
            .filter((item) => item.userId === user.id && item.workspaceId === workspace.id)
            .map(cloneRecord),
        });
      } catch (error) {
        removeArrayItem(cloud.passwordResetTokens, reset);
        for (const entry of previousResetState) entry.item.revokedAt = entry.revokedAt;
        console.error(`[cloud-auth] password reset request persist failed user=${user.id}`, error);
        throw error;
      }
      const resetUrl = resetUrlForToken(raw, req);
      const sent = mailService
        ? await mailService.sendPasswordReset({ to: user.email, name: user.name, resetUrl })
        : { sent: false, reason: 'mail-service-unavailable' };
      console.info(`[cloud-auth] password reset requested user=${user.id} sent=${Boolean(sent?.sent)}`);
      return { ok: true, sent: Boolean(sent?.sent) };
    }

    async function resetPassword(body, req, res) {
      const resetToken = String(body.resetToken || body.token || '').trim();
      const { reset, user, member } = assertPasswordResetCanBeUsed(passwordResetForToken(resetToken));
      const password = validatePassword(body.password);
      const completedAt = now();
      const previousPasswordHash = user.passwordHash;
      const previousEmailVerifiedAt = user.emailVerifiedAt || null;
      const previousUpdatedAt = user.updatedAt;
      const previousLastLoginAt = user.lastLoginAt || null;
      user.passwordHash = scryptPassword(password);
      user.emailVerifiedAt = user.emailVerifiedAt || completedAt;
      user.updatedAt = completedAt;
      const previousConsumedAt = reset.consumedAt || null;
      reset.consumedAt = completedAt;
      if (member) {
        const human = humanForMember(member, user) || ensureHumanForUser(user, member.role, {
          humanId: member.humanId,
          workspaceId: member.workspaceId,
        });
        if (human?.id && member.humanId !== human.id) member.humanId = human.id;
        markHumanPresence(human, 'online');
      }
      const issued = issueSession(user, req);
      console.info(`[cloud-auth] password reset completed user=${user.id}`);
      try {
        await persistAuthOperation({
          type: 'password-reset-complete',
          user: passwordUserRecord(user),
          reset: cloneRecord(reset),
          session: cloneRecord(issued.session),
        });
      } catch (error) {
        removeArrayItem(ensureCloudState().sessions, issued.session);
        user.passwordHash = previousPasswordHash;
        user.emailVerifiedAt = previousEmailVerifiedAt;
        user.updatedAt = previousUpdatedAt;
        user.lastLoginAt = previousLastLoginAt;
        reset.consumedAt = previousConsumedAt;
        console.error(`[cloud-auth] password reset complete persist failed user=${user.id}`, error);
        throw error;
      }
      res.setHeader('Set-Cookie', issued.cookie);
      return { user: publicUser(user), member, workspace: primaryWorkspace() };
    }

    async function removeMember(memberId, req) {
      const auth = currentActor(req);
      if (!auth) {
        const error = new Error('Login is required.');
        error.status = 401;
        throw error;
      }
      const cloud = ensureCloudState();
      const workspace = primaryWorkspace();
      const member = cloud.workspaceMembers.find((item) => (
        item.id === memberId
        && item.workspaceId === workspace.id
        && item.status === 'active'
      ));
      if (!member) {
        const error = new Error('Member was not found.');
        error.status = 404;
        throw error;
      }
      if (member.userId === auth.user.id) {
        const error = new Error('You cannot remove yourself.');
        error.status = 400;
        throw error;
      }
      if (workspace.ownerUserId && member.userId === workspace.ownerUserId) {
        const error = new Error('Owner cannot be removed.');
        error.status = 403;
        throw error;
      }
      if (!canRemoveRole(auth.member.role, member.role)) {
        const error = new Error('Workspace role is not allowed.');
        error.status = 403;
        throw error;
      }
      if (normalizeCloudRole(member.role) === 'admin' && activeAdminCount(workspace.id) <= 1) {
        const error = new Error('At least one Admin is required.');
        error.status = 400;
        throw error;
      }
      const removedAt = now();
      member.status = 'removed';
      member.removedAt = removedAt;
      member.removedBy = auth.user.id;
      member.updatedAt = removedAt;
      const user = cloud.users.find((item) => item.id === member.userId);
      if (user) {
        user.disabledAt = removedAt;
        user.updatedAt = removedAt;
      }
      for (const session of cloud.sessions) {
        if (session.userId === member.userId && !session.revokedAt) session.revokedAt = removedAt;
      }
      const human = safeArray(state.humans).find((item) => item.id === member.humanId);
      if (human) {
        human.status = 'removed';
        human.removedAt = removedAt;
        human.updatedAt = removedAt;
      }
      for (const channel of safeArray(state.channels)) {
        const nextHumanIds = safeArray(channel.humanIds).filter((id) => id !== member.humanId);
        const nextMemberIds = safeArray(channel.memberIds).filter((id) => id !== member.humanId);
        if (nextHumanIds.length !== safeArray(channel.humanIds).length || nextMemberIds.length !== safeArray(channel.memberIds).length) {
          channel.humanIds = nextHumanIds;
          channel.memberIds = nextMemberIds;
          channel.updatedAt = removedAt;
        }
      }
      systemNotification('member_removed', {
        actorUserId: auth.user.id,
        actorHumanId: auth.member.humanId,
        targetUserId: member.userId,
        targetHumanId: member.humanId,
        targetRole: normalizeCloudRole(member.role),
        message: `${auth.user.name || auth.user.email} removed a member from the workspace.`,
      });
      await persistCloudState({ workspaceId: workspace.id, reason: 'cloud_member_removed' });
      return { member: publicMember(member) };
    }

    function publicCloudState(req) {
      const cloud = ensureCloudState();
      refreshHumanPresence();
      const workspace = req ? workspaceForRequest(req) : primaryWorkspace();
      const user = req ? currentUser(req) : null;
      const member = user ? memberForUser(user.id, workspace?.id) : null;
      const session = req ? currentSession(req) : null;
      const capabilities = member ? cloudCapabilitiesForRole(member.role) : {};
      const canManageCloud = Boolean(capabilities.manage_cloud_connection);
      const canSeeDirectory = !cloud.users.length || Boolean(member);
      const ownConsoleState = user ? consoleStateForUser(user) : { workspaces: [], deletedWorkspaces: [], invitations: [] };
      const workspaceMembers = workspace
        ? cloud.workspaceMembers.filter((item) => item.workspaceId === workspace.id)
        : [];
      return {
        schemaVersion: cloud.schemaVersion,
        auth: {
          initialized: cloud.users.length > 0,
          loginRequired: isLoginRequired(),
          passwordLogin: hasAuthProvider('email_password'),
          providers: publicAuthProviders(req),
          defaultProvider: defaultAuthProviderId(),
          storageBackend: storageBackend(),
          currentUser: publicUser(user),
          currentMember: member || null,
          capabilities,
          sessionTtlMs: SESSION_TTL_MS,
          sessionExpiresAt: session?.expiresAt || null,
          humanPresenceTimeoutMs: HUMAN_PRESENCE_TIMEOUT_MS,
        },
        workspace,
        workspaces: ownConsoleState.workspaces,
        deletedWorkspaces: ownConsoleState.deletedWorkspaces || [],
        members: canSeeDirectory ? workspaceMembers.map(publicMember) : [],
        invitations: member ? cloud.invitations.map(publicInvitation) : ownConsoleState.invitations,
        joinLinks: canManageCloud ? safeArray(cloud.joinLinks)
          .filter((item) => item.workspaceId === workspace?.id)
          .map((item) => publicJoinLink(item)) : [],
        myInvitations: ownConsoleState.invitations,
        systemNotifications: member ? safeArray(state.systemNotifications).map(publicSystemNotification) : [],
        pairingTokens: canManageCloud ? cloud.pairingTokens.map((item) => {
          const { tokenHash, ...safe } = item;
          void tokenHash;
          return safe;
        }) : [],
        computerTokens: canManageCloud ? cloud.computerTokens.map((item) => {
          const { tokenHash, ...safe } = item;
          void tokenHash;
          return safe;
        }) : [],
        agentDeliveries: canManageCloud ? safeArray(cloud.agentDeliveries).map((item) => {
          const { payload, ...safe } = item;
          void payload;
        return safe;
      }) : [],
    };
  }

  return {
    clearSessionCookie,
      close: () => cloudRepository?.close?.(),
      currentActor,
      currentUser,
      ensureCloudState,
    primaryWorkspace,
    workspaceForRequest,
    initializeStorage,
    isLoginRequired,
    createFeishuAuthorization,
    feishuAuthErrorRedirect,
    loginWithFeishuCallback,
    feishuLinkStatus,
    confirmFeishuLink,
    cancelFeishuLink,
    login,
      logout,
      touchPresence,
      createInvitation,
      batchCreateInvitations,
      acceptConsoleInvitation,
      declineConsoleInvitation,
      createConsoleServer,
      switchConsoleServer,
      deleteConsoleServer,
      restoreConsoleServer,
      updateServerProfile,
      createJoinLink,
      joinLinkStatus,
      acceptJoinLink,
      revokeJoinLink,
      consoleStateForUser,
      invitationStatus,
      registerOpenAccount,
      registerWithInvite,
      createPasswordReset,
      requestPasswordReset,
      resetStatus,
      resetPassword,
	      removeMember,
	      updateMemberRole,
	      updateUserPreferences,
	      publicCloudState,
    publicInvitation,
    publicJoinLink,
    requireUser,
    persistCloudState,
    sha256,
    token,
  };
}
