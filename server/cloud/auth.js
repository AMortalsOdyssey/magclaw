import crypto from 'node:crypto';
import {
  canInviteRole,
  canRemoveRole,
  canUpdateMemberRole,
  cloudCapabilitiesForRole,
  normalizeCloudRole,
  roleAllows,
} from './roles.js';

const SESSION_COOKIE = 'magclaw_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const INVITATION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const PASSWORD_RESET_TTL_MS = 1000 * 60 * 60 * 24;
const HUMAN_PRESENCE_TIMEOUT_MS = Number(process.env.MAGCLAW_HUMAN_PRESENCE_TIMEOUT_MS || 1000 * 60 * 2);
const HUMAN_PRESENCE_PERSIST_INTERVAL_MS = 1000 * 60;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 30;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WORKSPACE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function token(prefix) {
  return `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
}

function scryptPassword(password) {
  const salt = crypto.randomBytes(16).toString('base64url');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('base64url');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, expected] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  const actual = crypto.scryptSync(String(password), salt, 64).toString('base64url');
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(req) {
  const header = String(req.headers?.cookie || '');
  const cookies = new Map();
  for (const item of header.split(';')) {
    const index = item.indexOf('=');
    if (index === -1) continue;
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    if (key) cookies.set(key, decodeURIComponent(value));
  }
  return cookies;
}

function requestOrigin(req) {
  const proto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim()
    || (req.socket?.encrypted ? 'https' : 'http');
  const host = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}

function httpOriginFromValue(value) {
  const raw = String(value || '').split(',')[0].trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin;
  } catch {
    return '';
  }
}

function publicLinkOrigin(req) {
  const configured = String(process.env.MAGCLAW_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const forwardedHost = String(req.headers?.['x-forwarded-host'] || '').split(',')[0].trim();
  if (forwardedHost) {
    const proto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim()
      || (req.socket?.encrypted ? 'https' : 'http');
    return `${proto}://${forwardedHost}`;
  }
  return httpOriginFromValue(req.headers?.origin) || requestOrigin(req);
}

function sessionCookie(rawToken, req) {
  const secure = requestOrigin(req).startsWith('https://') || process.env.MAGCLAW_SECURE_COOKIES === '1';
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(rawToken)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

function clearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function normalizeEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidEmail(value) {
  return EMAIL_PATTERN.test(normalizeEmail(value));
}

function slugifyWorkspace(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function normalizeWorkspaceSlug(value, fallback = '') {
  return slugifyWorkspace(value) || slugifyWorkspace(fallback);
}

function validatePassword(password) {
  const value = String(password || '');
  if (value.length < PASSWORD_MIN_LENGTH || value.length > PASSWORD_MAX_LENGTH) {
    const error = new Error(`Password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters.`);
    error.status = 400;
    throw error;
  }
  if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) {
    const error = new Error('Password must include both letters and numbers.');
    error.status = 400;
    throw error;
  }
  return value;
}

function configuredAdminCredentials() {
  const email = normalizeEmail(process.env.MAGCLAW_ADMIN_EMAIL || '');
  const password = String(process.env.MAGCLAW_ADMIN_PASSWORD || '');
  if (!email || !password) return null;
  return {
    email,
    password,
    name: String(process.env.MAGCLAW_ADMIN_NAME || email.split('@')[0]).trim(),
  };
}

function publicUser(user) {
  if (!user) return null;
  const { passwordHash, ...safe } = user;
  void passwordHash;
  return safe;
}

function publicInvitation(invitation) {
  if (!invitation) return null;
  const { tokenHash, ...safe } = invitation;
  void tokenHash;
  const metadata = safe.metadata && typeof safe.metadata === 'object' ? safe.metadata : {};
  const expiresAt = new Date(safe.expiresAt || 0).getTime();
  const status = safe.acceptedAt
    ? 'accepted'
    : metadata.declinedAt
      ? 'declined'
      : safe.revokedAt
        ? 'revoked'
        : expiresAt && expiresAt <= Date.now()
          ? 'expired'
          : 'pending';
  return { ...safe, status, metadata };
}

function publicJoinLink(link, rawToken = '', req = null) {
  if (!link) return null;
  const { tokenHash, ...safe } = link;
  void tokenHash;
  const expiresAt = safe.expiresAt ? new Date(safe.expiresAt).getTime() : 0;
  const status = safe.revokedAt
    ? 'revoked'
    : expiresAt && expiresAt <= Date.now()
      ? 'expired'
      : safe.maxUses && Number(safe.usedCount || 0) >= Number(safe.maxUses)
        ? 'exhausted'
        : 'active';
  const url = rawToken
    ? `${publicLinkOrigin(req).replace(/\/+$/, '')}/join/${encodeURIComponent(rawToken)}`
    : '';
  return { ...safe, status, url };
}

function publicPasswordReset(reset, user = null) {
  if (!reset) return null;
  const { tokenHash, ...safe } = reset;
  void tokenHash;
  return {
    ...safe,
    email: user?.email || safe.email || '',
    name: user?.name || safe.name || '',
  };
}

function publicSystemNotification(notification) {
  return notification ? { ...notification } : null;
}

function basicAuthCredentials(req) {
  const header = String(req.headers?.authorization || '');
  const match = header.match(/^Basic\s+(.+)$/i);
  if (!match) return null;
  try {
    const decoded = Buffer.from(match[1], 'base64').toString('utf8');
    const separator = decoded.indexOf(':');
    if (separator === -1) return null;
    return {
      email: normalizeEmail(decoded.slice(0, separator)),
      password: decoded.slice(separator + 1),
    };
  } catch {
    return null;
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
    normalizeIds,
  } = deps;

  const state = new Proxy({}, {
    get(_target, prop) { return getState()?.[prop]; },
    set(_target, prop, value) { getState()[prop] = value; return true; },
  });

  function ensureCloudState() {
    const createdAt = now();
    const workspaceId = String(state.connection?.workspaceId || 'local');
    if (!state.cloud || typeof state.cloud !== 'object') state.cloud = {};
    state.cloud.schemaVersion = Number(state.cloud.schemaVersion || 1);
    state.cloud.auth = {
      ...(state.cloud.auth || {}),
      allowSignups: process.env.MAGCLAW_ALLOW_SIGNUPS === '1',
      passwordLogin: true,
    };
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
      state.humans = safeArray(state.humans);
      for (const human of state.humans) {
        human.role = normalizeCloudRole(human.role);
      }
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
        const id = `usr_${String(crypto.randomInt(0, 100_000_000)).padStart(8, '0')}`;
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

  async function persistCloudState() {
    try {
      if (cloudRepository?.isEnabled?.()) await cloudRepository.persistFromState(getState());
      await persistState();
    } catch (error) {
      if (cloudRepository?.isEnabled?.()) await cloudRepository.loadIntoState(getState()).catch(() => {});
      throw error;
    }
  }

  function primaryWorkspace() {
    const cloud = ensureCloudState();
    const preferred = String(state.connection?.workspaceId || 'local');
    return cloud.workspaces.find((workspace) => workspace.id === preferred)
      || cloud.workspaces[0];
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
    return state.humans.find((human) => human.id === member?.humanId)
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
      const member = user ? memberForUser(user.id) : null;
      return user && member ? { user, member } : null;
    }

  function isLoginRequired() {
    const cloud = ensureCloudState();
    return process.env.MAGCLAW_REQUIRE_LOGIN === '1'
      || process.env.MAGCLAW_DEPLOYMENT === 'cloud'
      || Boolean(configuredAdminCredentials())
      || cloud.users.length > 0;
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
      let human = options.humanId
        ? state.humans.find((item) => item.id === options.humanId)
        : null;
      if (!human) human = state.humans.find((item) => item.authUserId === user.id);
      if (!human && normalizedRole === 'admin') human = state.humans.find((item) => item.id === 'hum_local');
      if (!human) {
        human = state.humans.find((item) => (
          normalizeEmail(item.email) === user.email
          && item.status !== 'removed'
          && !item.authUserId
        ));
      }
      if (!human) {
        human = {
          id: makeId('hum'),
          name: user.name || user.email.split('@')[0],
          email: user.email,
          role: normalizedRole,
          status: 'online',
          createdAt: now(),
        };
      state.humans.push(human);
    }
      human.authUserId = user.id;
      human.name = user.name || human.name || user.email.split('@')[0];
      human.email = user.email;
      human.role = normalizedRole;
      human.status = 'online';
      human.lastSeenAt = now();
      human.presenceUpdatedAt = human.lastSeenAt;
      delete human.removedAt;
      return human;
    }

  function addHumanToAllChannel(human) {
    const allChannel = safeArray(state.channels).find((channel) => channel.id === 'chan_all');
    if (!allChannel || !human?.id) return;
    allChannel.humanIds = normalizeIds([...(allChannel.humanIds || []), human.id]);
    allChannel.memberIds = normalizeIds([...(allChannel.memberIds || []), human.id]);
    allChannel.updatedAt = now();
  }

  async function ensureConfiguredAdmin() {
    const credentials = configuredAdminCredentials();
    if (!credentials) return { configured: false };
    try {
      validatePassword(credentials.password);
    } catch {
      const error = new Error(`MAGCLAW_ADMIN_PASSWORD must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters and include letters and numbers.`);
      error.status = 500;
      throw error;
    }

    const cloud = ensureCloudState();
    const workspace = primaryWorkspace();
    let changed = false;
    const adminMember = cloud.workspaceMembers.find((member) => member.workspaceId === workspace.id && member.role === 'admin');
    let user = cloud.users.find((item) => item.email === credentials.email)
      || cloud.users.find((item) => item.id === adminMember?.userId);

      if (!user) {
        user = {
          id: makeUserId(),
        email: credentials.email,
        name: credentials.name || credentials.email.split('@')[0],
        passwordHash: scryptPassword(credentials.password),
        emailVerifiedAt: now(),
        createdAt: now(),
        updatedAt: now(),
        lastLoginAt: null,
      };
      cloud.users.push(user);
      changed = true;
    }

    if (user.email !== credentials.email) {
      user.email = credentials.email;
      changed = true;
    }
    if (credentials.name && user.name !== credentials.name) {
      user.name = credentials.name;
      changed = true;
    }
      if (!user.emailVerifiedAt) {
        user.emailVerifiedAt = now();
        changed = true;
      }
      if (user.disabledAt) {
        delete user.disabledAt;
        changed = true;
      }
    if (!verifyPassword(credentials.password, user.passwordHash)) {
      user.passwordHash = scryptPassword(credentials.password);
      changed = true;
    }
    if (changed) user.updatedAt = now();

    const human = ensureHumanForUser(user, 'admin');
    addHumanToAllChannel(human);
    let member = memberForUser(user.id, workspace.id);
    if (!member) {
      member = {
        id: makeId('wmem'),
        workspaceId: workspace.id,
        userId: user.id,
        humanId: human.id,
        role: 'admin',
        status: 'active',
        joinedAt: now(),
        createdAt: now(),
      };
      cloud.workspaceMembers.push(member);
      changed = true;
    } else {
      for (const [key, value] of Object.entries({ humanId: human.id, role: 'admin', status: 'active' })) {
        if (member[key] !== value) {
          member[key] = value;
          changed = true;
        }
      }
      if (!member.joinedAt) {
        member.joinedAt = now();
        changed = true;
      }
    }

    if (changed) await persistCloudState();
    return { configured: true, user: publicUser(user), member, workspace };
  }

    async function login(body, req, res) {
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
        const human = humanForMember(member, user) || ensureHumanForUser(user, member.role, { humanId: member.humanId });
        if (!member.humanId && human?.id) member.humanId = human.id;
        markHumanPresence(human, 'online');
      }
    const issued = issueSession(user, req);
      await persistCloudState();
      res.setHeader('Set-Cookie', issued.cookie);
      return { user: publicUser(user), member, workspace: primaryWorkspace() };
    }

    async function registerOpenAccount(body, req, res) {
      const cloud = ensureCloudState();
      if (!cloud.auth.allowSignups) {
        const error = new Error('Account creation is disabled.');
        error.status = 403;
        throw error;
      }
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
        emailVerifiedAt: null,
        createdAt,
        updatedAt: createdAt,
        lastLoginAt: null,
      };
      cloud.users.push(user);
      console.info(`[cloud-auth] open account registered email=${email} user=${user.id}`);
      const issued = issueSession(user, req);
      await persistCloudState();
      res.setHeader('Set-Cookie', issued.cookie);
      return { user: publicUser(user), member: null, workspace: null };
    }

  async function logout(req, res) {
    const auth = currentActor(req);
    const session = currentSession(req);
    if (session) session.revokedAt = now();
    if (auth) markHumanPresence(humanForMember(auth.member, auth.user), 'offline');
    res.setHeader('Set-Cookie', clearSessionCookie());
    await persistCloudState();
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
        || ensureHumanForUser(auth.user, auth.member.role, { humanId: auth.member.humanId });
      if (!auth.member.humanId && human?.id) auth.member.humanId = human.id;
      const previousSeen = Date.parse(human.lastSeenAt || '');
      const changed = markHumanPresence(human, 'online');
      const shouldPersist = changed || !previousSeen || Date.now() - previousSeen > HUMAN_PRESENCE_PERSIST_INTERVAL_MS;
      if (shouldPersist) await persistCloudState();
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
          name: String(body.name || email.split('@')[0]).trim(),
          email,
          role,
          status: 'invited',
          createdAt: now(),
        };
        state.humans.push(human);
        addHumanToAllChannel(human);
      } else if (!registeredUser) {
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
      await persistCloudState();
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
      await persistCloudState();
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
      return cloud.workspaces.filter((workspace) => workspaceIds.has(workspace.id));
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
      if (slug.length < 2 || slug.length > 63 || !WORKSPACE_SLUG_PATTERN.test(slug)) {
        const error = new Error('Server slug must be 2-63 lowercase letters, numbers, or hyphens.');
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
      const human = ensureHumanForUser(user, 'admin');
      addHumanToAllChannel(human);
      cloud.workspaceMembers.push({
        id: makeId('wmem'),
        workspaceId: workspace.id,
        userId: user.id,
        humanId: human.id,
        role: 'admin',
        status: 'active',
        joinedAt: createdAt,
        createdAt,
      });
      state.connection.workspaceId = workspace.id;
      console.info(`[cloud-auth] console server created workspace=${workspace.id} slug=${workspace.slug} owner=${user.id}`);
      await persistCloudState();
      return { server: workspace, member: memberForUser(user.id, workspace.id) };
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
      const member = memberForUser(user.id, workspace.id);
      if (!member || (member.status && member.status !== 'active')) {
        const error = new Error('You are not a member of this server.');
        error.status = 403;
        throw error;
      }
      state.connection.workspaceId = workspace.id;
      console.info(`[cloud-auth] console server switched workspace=${workspace.id} slug=${workspace.slug || workspace.id} user=${user.id}`);
      await persistCloudState();
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
      cloud.workspaces = cloud.workspaces.filter((item) => item.id !== workspace.id);
      cloud.workspaceMembers = cloud.workspaceMembers.filter((item) => item.workspaceId !== workspace.id);
      cloud.invitations = cloud.invitations.filter((item) => item.workspaceId !== workspace.id);
      cloud.joinLinks = safeArray(cloud.joinLinks).filter((item) => item.workspaceId !== workspace.id);
      cloud.pairingTokens = cloud.pairingTokens.filter((item) => item.workspaceId !== workspace.id);
      cloud.computerTokens = cloud.computerTokens.filter((item) => item.workspaceId !== workspace.id);
      const nextWorkspace = workspacesForUser(auth.user).find((item) => item.id !== workspace.id) || cloud.workspaces[0] || null;
      state.connection.workspaceId = nextWorkspace?.id || 'local';
      console.info(`[cloud-auth] console server deleted workspace=${workspace.id} slug=${workspace.slug || workspace.id} actor=${auth.user.id}`);
      await persistCloudState();
      return { deleted: workspace, nextWorkspace };
    }

    async function updateServerProfile(body, req) {
      const auth = currentActor(req);
      if (!auth || normalizeCloudRole(auth.member.role) !== 'admin') {
        const error = new Error(auth ? 'Workspace role is not allowed.' : 'Login is required.');
        error.status = auth ? 403 : 401;
        throw error;
      }
      const workspace = primaryWorkspace();
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
      console.info(`[cloud-auth] server profile updated workspace=${workspace.id} actor=${auth.user.id}`);
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
      if (body.expiresAt) {
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

    async function acceptConsoleInvitation(invitationId, req) {
      const user = requireAuthenticatedUser(req);
      const cloud = ensureCloudState();
      const invitation = consoleInvitationForUser(String(invitationId || ''), user);
      const acceptedAt = now();
      const role = normalizeCloudRole(invitation.role || 'member');
      let member = memberForUser(user.id, invitation.workspaceId);
      if (!member) {
        const human = ensureHumanForUser(user, role, { humanId: invitation.humanId });
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
      await persistCloudState();
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
      const workspace = primaryWorkspace();
      const raw = String(body.inviteToken || body.token || '').trim();
      const email = normalizeEmail(body.email);
      const invitation = raw ? invitationForToken(raw) : null;
      if (!invitation && !cloud.auth.allowSignups) {
        const error = new Error('A valid invitation token is required.');
        error.status = 403;
        throw error;
      }
      if (invitation) assertInvitationCanBeAccepted(invitation);
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
      if (activeUserWithEmail(finalEmail)) {
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
        emailVerifiedAt: invitation ? now() : null,
        createdAt: now(),
        updatedAt: now(),
        lastLoginAt: null,
      };
      cloud.users.push(user);
      const role = normalizeCloudRole(invitation?.role || 'member');
      const human = ensureHumanForUser(user, role, { humanId: invitation?.humanId });
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
      await persistCloudState();
      res.setHeader('Set-Cookie', issued.cookie);
      return { user: publicUser(user), member: memberForUser(user.id, workspace.id), workspace };
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
      if (!auth || !roleAllows(auth.member.role, ['core_member'])) {
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
      if (role === 'admin' && normalizeCloudRole(auth.member.role) !== 'admin') {
        const error = new Error('Only admins can promote another admin.');
        error.status = 403;
        throw error;
      }
      if (previousRole === 'admin' && role !== 'admin' && activeAdminCount(workspace.id) <= 1) {
        const error = new Error('At least one admin must remain.');
        error.status = 403;
        throw error;
      }
      if (role !== 'admin' && !canUpdateMemberRole(auth.member.role, previousRole, role)) {
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
      await persistCloudState();
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
      systemNotification('member_password_reset', {
        actorUserId: auth.user.id,
        actorHumanId: auth.member.humanId,
        targetUserId: user.id,
        targetHumanId: member.humanId,
        targetRole: normalizeCloudRole(member.role),
        message: `${auth.user.name || auth.user.email} reset a member password.`,
      });
      console.info(`[cloud-auth] password reset created user=${user.id} actor=${auth.user.id}`);
      await persistCloudState();
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
      ensureCloudState().passwordResetTokens.push(reset);
      await persistCloudState();
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
      user.passwordHash = scryptPassword(password);
      user.emailVerifiedAt = user.emailVerifiedAt || completedAt;
      user.updatedAt = completedAt;
      reset.consumedAt = completedAt;
      if (member) {
        const human = humanForMember(member, user) || ensureHumanForUser(user, member.role, { humanId: member.humanId });
        if (!member.humanId && human?.id) member.humanId = human.id;
        markHumanPresence(human, 'online');
      }
      const issued = issueSession(user, req);
      console.info(`[cloud-auth] password reset completed user=${user.id}`);
      await persistCloudState();
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
      await persistCloudState();
      return { member: publicMember(member) };
    }

    function publicCloudState(req) {
      const cloud = ensureCloudState();
      refreshHumanPresence();
      const user = req ? currentUser(req) : null;
      const member = user ? memberForUser(user.id) : null;
      const session = req ? currentSession(req) : null;
      const capabilities = member ? cloudCapabilitiesForRole(member.role) : {};
      const canManageCloud = Boolean(capabilities.manage_cloud_connection);
      const canSeeDirectory = !cloud.users.length || Boolean(member);
      const ownConsoleState = user ? consoleStateForUser(user) : { workspaces: [], invitations: [] };
      return {
        schemaVersion: cloud.schemaVersion,
        auth: {
        initialized: cloud.users.length > 0,
        adminConfigured: Boolean(configuredAdminCredentials()),
        loginRequired: isLoginRequired(),
        allowSignups: Boolean(cloud.auth.allowSignups),
        passwordLogin: true,
          storageBackend: storageBackend(),
          currentUser: publicUser(user),
          currentMember: member || null,
          capabilities,
          sessionTtlMs: SESSION_TTL_MS,
          sessionExpiresAt: session?.expiresAt || null,
          humanPresenceTimeoutMs: HUMAN_PRESENCE_TIMEOUT_MS,
        },
        workspace: primaryWorkspace(),
        workspaces: ownConsoleState.workspaces,
        members: canSeeDirectory ? cloud.workspaceMembers.map(publicMember) : [],
        invitations: member ? cloud.invitations.map(publicInvitation) : ownConsoleState.invitations,
        joinLinks: canManageCloud ? safeArray(cloud.joinLinks)
          .filter((item) => item.workspaceId === primaryWorkspace()?.id)
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
    ensureConfiguredAdmin,
      ensureCloudState,
    primaryWorkspace,
    initializeStorage,
    isLoginRequired,
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
      updateServerProfile,
      createJoinLink,
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
      publicCloudState,
    publicInvitation,
    publicJoinLink,
    requireUser,
    persistCloudState,
    sha256,
    token,
  };
}
