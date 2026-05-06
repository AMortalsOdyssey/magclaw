import crypto from 'node:crypto';

const SESSION_COOKIE = 'magclaw_session';
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const INVITATION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const PASSWORD_MIN_LENGTH = 8;

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

function configuredOwnerCredentials() {
  const email = normalizeEmail(process.env.MAGCLAW_OWNER_EMAIL || process.env.MAGCLAW_ADMIN_EMAIL || '');
  const password = String(process.env.MAGCLAW_OWNER_PASSWORD || process.env.MAGCLAW_ADMIN_PASSWORD || '');
  if (!email || !password) return null;
  return {
    email,
    password,
    name: String(process.env.MAGCLAW_OWNER_NAME || process.env.MAGCLAW_ADMIN_NAME || email.split('@')[0]).trim(),
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
  return safe;
}

export function createCloudAuth(deps) {
  const {
    getState,
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
      allowSignups: process.env.MAGCLAW_ALLOW_SIGNUPS === '1',
      passwordLogin: true,
      ownerInviteOnly: process.env.MAGCLAW_ALLOW_SIGNUPS !== '1',
      ...(state.cloud.auth || {}),
    };
    state.cloud.workspaces = safeArray(state.cloud.workspaces);
    if (!state.cloud.workspaces.length) {
      state.cloud.workspaces.push({
        id: workspaceId,
        slug: workspaceId,
        name: process.env.MAGCLAW_DEFAULT_WORKSPACE_NAME || 'MagClaw',
        ownerUserId: null,
        createdAt,
      });
    }
    state.cloud.workspaceMembers = safeArray(state.cloud.workspaceMembers);
    state.cloud.users = safeArray(state.cloud.users);
    state.cloud.sessions = safeArray(state.cloud.sessions);
    state.cloud.invitations = safeArray(state.cloud.invitations);
    state.cloud.pairingTokens = safeArray(state.cloud.pairingTokens);
    state.cloud.computerTokens = safeArray(state.cloud.computerTokens);
    state.cloud.agentDeliveries = safeArray(state.cloud.agentDeliveries);
    state.cloud.daemonEvents = safeArray(state.cloud.daemonEvents);
    return state.cloud;
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
    if (!session) return null;
    return ensureCloudState().users.find((user) => user.id === session.userId) || null;
  }

  function memberForUser(userId, workspaceId = primaryWorkspace()?.id) {
    return ensureCloudState().workspaceMembers.find((member) => (
      member.userId === userId
      && member.workspaceId === workspaceId
      && member.status === 'active'
    )) || null;
  }

  function roleAllows(role, allowedRoles = []) {
    if (!allowedRoles.length) return true;
    const hierarchy = ['viewer', 'member', 'agent_admin', 'computer_admin', 'admin', 'owner'];
    const roleIndex = hierarchy.indexOf(String(role || 'viewer'));
    return allowedRoles.some((allowed) => roleIndex >= hierarchy.indexOf(allowed));
  }

  function isLoginRequired() {
    const cloud = ensureCloudState();
    return process.env.MAGCLAW_REQUIRE_LOGIN === '1'
      || process.env.MAGCLAW_DEPLOYMENT === 'cloud'
      || Boolean(configuredOwnerCredentials())
      || cloud.users.length > 0;
  }

  function requireUser(req, res, sendError, allowedRoles = []) {
    const user = currentUser(req);
    if (!user) {
      sendError(res, 401, 'Login is required.');
      return null;
    }
    const member = memberForUser(user.id);
    if (!member || !roleAllows(member.role, allowedRoles)) {
      sendError(res, 403, 'Workspace role is not allowed.');
      return null;
    }
    return { user, member };
  }

  function issueSession(user, req, res) {
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
    res.setHeader('Set-Cookie', sessionCookie(raw, req));
    return session;
  }

  function ensureHumanForUser(user, role = 'member') {
    state.humans = safeArray(state.humans);
    let human = state.humans.find((item) => item.authUserId === user.id)
      || state.humans.find((item) => normalizeEmail(item.email) === user.email);
    if (!human && role === 'owner') human = state.humans.find((item) => item.id === 'hum_local');
    if (!human) {
      human = {
        id: makeId('hum'),
        name: user.name || user.email.split('@')[0],
        email: user.email,
        role,
        status: 'online',
        createdAt: now(),
      };
      state.humans.push(human);
    }
    human.authUserId = user.id;
    human.name = user.name || human.name || user.email.split('@')[0];
    human.email = user.email;
    human.role = role;
    human.status = 'online';
    return human;
  }

  function addHumanToAllChannel(human) {
    const allChannel = safeArray(state.channels).find((channel) => channel.id === 'chan_all');
    if (!allChannel || !human?.id) return;
    allChannel.humanIds = normalizeIds([...(allChannel.humanIds || []), human.id]);
    allChannel.memberIds = normalizeIds([...(allChannel.memberIds || []), human.id]);
    allChannel.updatedAt = now();
  }

  async function ensureConfiguredOwner() {
    const credentials = configuredOwnerCredentials();
    if (!credentials) return { configured: false };
    if (credentials.password.length < PASSWORD_MIN_LENGTH) {
      const error = new Error(`MAGCLAW_OWNER_PASSWORD must be at least ${PASSWORD_MIN_LENGTH} characters.`);
      error.status = 500;
      throw error;
    }

    const cloud = ensureCloudState();
    const workspace = primaryWorkspace();
    let changed = false;
    const ownerMember = cloud.workspaceMembers.find((member) => member.workspaceId === workspace.id && member.role === 'owner');
    let user = cloud.users.find((item) => item.email === credentials.email)
      || cloud.users.find((item) => item.id === workspace.ownerUserId)
      || cloud.users.find((item) => item.id === ownerMember?.userId);

    if (!user) {
      user = {
        id: makeId('usr'),
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
    if (!verifyPassword(credentials.password, user.passwordHash)) {
      user.passwordHash = scryptPassword(credentials.password);
      changed = true;
    }
    if (changed) user.updatedAt = now();

    const human = ensureHumanForUser(user, 'owner');
    addHumanToAllChannel(human);
    let member = memberForUser(user.id, workspace.id);
    if (!member) {
      member = {
        id: makeId('wmem'),
        workspaceId: workspace.id,
        userId: user.id,
        humanId: human.id,
        role: 'owner',
        status: 'active',
        joinedAt: now(),
        createdAt: now(),
      };
      cloud.workspaceMembers.push(member);
      changed = true;
    } else {
      for (const [key, value] of Object.entries({ humanId: human.id, role: 'owner', status: 'active' })) {
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
    if (workspace.ownerUserId !== user.id) {
      workspace.ownerUserId = user.id;
      changed = true;
    }

    if (changed) await persistState();
    return { configured: true, user: publicUser(user), member, workspace };
  }

  async function bootstrapOwner(body, req, res) {
    void body;
    void req;
    void res;
    const error = new Error('Owner is provisioned from MAGCLAW_OWNER_EMAIL and MAGCLAW_OWNER_PASSWORD on the server.');
    error.status = 410;
    throw error;
  }

  async function login(body, req, res) {
    const cloud = ensureCloudState();
    const email = normalizeEmail(body.email);
    const user = cloud.users.find((item) => item.email === email);
    if (!user || !verifyPassword(body.password || '', user.passwordHash)) {
      const error = new Error('Invalid email or password.');
      error.status = 401;
      throw error;
    }
    issueSession(user, req, res);
    await persistState();
    return { user: publicUser(user), member: memberForUser(user.id), workspace: primaryWorkspace() };
  }

  async function logout(req, res) {
    const session = currentSession(req);
    if (session) session.revokedAt = now();
    res.setHeader('Set-Cookie', clearSessionCookie());
    await persistState();
    return { ok: true };
  }

  async function createInvitation(body, req) {
    const auth = requireUser(req, { setHeader() {} }, () => {}, ['admin']);
    if (!auth) {
      const error = new Error('Admin role is required.');
      error.status = 403;
      throw error;
    }
    const cloud = ensureCloudState();
    const workspace = primaryWorkspace();
    const email = normalizeEmail(body.email);
    if (!email) {
      const error = new Error('Invite email is required.');
      error.status = 400;
      throw error;
    }
    const raw = token('mc_inv');
    const role = ['owner', 'admin', 'member', 'viewer', 'computer_admin', 'agent_admin'].includes(body.role)
      ? body.role
      : 'member';
    const invitation = {
      id: makeId('inv'),
      workspaceId: workspace.id,
      email,
      role,
      tokenHash: sha256(raw),
      invitedBy: auth.user.id,
      expiresAt: new Date(Date.now() + Number(body.ttlMs || INVITATION_TTL_MS)).toISOString(),
      acceptedAt: null,
      revokedAt: null,
      createdAt: now(),
    };
    cloud.invitations.push(invitation);
    let human = safeArray(state.humans).find((item) => normalizeEmail(item.email) === email);
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
    }
    const base = process.env.MAGCLAW_PUBLIC_URL || requestOrigin(req);
    await persistState();
    return {
      invitation: publicInvitation(invitation),
      inviteToken: raw,
      inviteUrl: base ? `${base}/invite?token=${encodeURIComponent(raw)}` : '',
    };
  }

  async function registerWithInvite(body, req, res) {
    const cloud = ensureCloudState();
    const workspace = primaryWorkspace();
    const raw = String(body.inviteToken || body.token || '').trim();
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    const invitation = raw
      ? cloud.invitations.find((item) => item.tokenHash === sha256(raw) && !item.acceptedAt && !item.revokedAt)
      : null;
    if (!invitation && !cloud.auth.allowSignups) {
      const error = new Error('A valid invitation token is required.');
      error.status = 403;
      throw error;
    }
    if (invitation && new Date(invitation.expiresAt).getTime() <= Date.now()) {
      const error = new Error('Invitation has expired.');
      error.status = 410;
      throw error;
    }
    const finalEmail = invitation?.email || email;
    if (!finalEmail || (invitation && email && email !== invitation.email)) {
      const error = new Error('Email must match the invitation.');
      error.status = 400;
      throw error;
    }
    if (cloud.users.some((user) => user.email === finalEmail)) {
      const error = new Error('User already exists.');
      error.status = 409;
      throw error;
    }
    if (password.length < PASSWORD_MIN_LENGTH) {
      const error = new Error(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
      error.status = 400;
      throw error;
    }
    const user = {
      id: makeId('usr'),
      email: finalEmail,
      name: String(body.name || finalEmail.split('@')[0]).trim(),
      passwordHash: scryptPassword(password),
      emailVerifiedAt: invitation ? now() : null,
      createdAt: now(),
      updatedAt: now(),
      lastLoginAt: null,
    };
    cloud.users.push(user);
    const role = invitation?.role || 'member';
    const human = ensureHumanForUser(user, role);
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
    if (invitation) invitation.acceptedAt = now();
    issueSession(user, req, res);
    await persistState();
    return { user: publicUser(user), member: memberForUser(user.id, workspace.id), workspace };
  }

  function publicCloudState(req) {
    const cloud = ensureCloudState();
    const user = req ? currentUser(req) : null;
    const member = user ? memberForUser(user.id) : null;
    const canManage = member && roleAllows(member.role, ['admin']);
    const canSeeDirectory = !cloud.users.length || Boolean(member);
    return {
      schemaVersion: cloud.schemaVersion,
      auth: {
        initialized: cloud.users.length > 0,
        ownerConfigured: Boolean(configuredOwnerCredentials()),
        loginRequired: isLoginRequired(),
        allowSignups: Boolean(cloud.auth.allowSignups),
        ownerInviteOnly: Boolean(cloud.auth.ownerInviteOnly),
        passwordLogin: true,
        currentUser: publicUser(user),
        currentMember: member || null,
      },
      workspace: primaryWorkspace(),
      members: canSeeDirectory ? cloud.workspaceMembers.map((item) => ({
        ...item,
        user: publicUser(cloud.users.find((userItem) => userItem.id === item.userId)),
      })) : [],
      invitations: canManage ? cloud.invitations.map(publicInvitation) : [],
      pairingTokens: canManage ? cloud.pairingTokens.map((item) => {
        const { tokenHash, ...safe } = item;
        void tokenHash;
        return safe;
      }) : [],
      computerTokens: canManage ? cloud.computerTokens.map((item) => {
        const { tokenHash, ...safe } = item;
        void tokenHash;
        return safe;
      }) : [],
      agentDeliveries: canManage ? safeArray(cloud.agentDeliveries).map((item) => {
        const { payload, ...safe } = item;
        void payload;
        return safe;
      }) : [],
    };
  }

  return {
    clearSessionCookie,
    currentUser,
    ensureConfiguredOwner,
    ensureCloudState,
    isLoginRequired,
    login,
    logout,
    bootstrapOwner,
    createInvitation,
    registerWithInvite,
    publicCloudState,
    publicInvitation,
    requireUser,
    sha256,
    token,
  };
}
