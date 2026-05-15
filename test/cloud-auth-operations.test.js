import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudAuth } from '../server/cloud/auth.js';
import { SESSION_COOKIE, sha256, scryptPassword } from '../server/cloud/auth-primitives.js';

function makeAuth(repository, initialState = {}) {
  let id = 0;
  const createdAt = '2026-05-12T00:00:00.000Z';
  const state = {
    connection: { workspaceId: 'local' },
    cloud: {
      workspaces: [{ id: 'local', slug: 'local', name: 'Local', createdAt, updatedAt: createdAt }],
      workspaceMembers: [],
      users: [],
      sessions: [],
      invitations: [],
      joinLinks: [],
      passwordResetTokens: [],
      ...initialState.cloud,
    },
    humans: [],
    ...initialState,
  };
  const auth = createCloudAuth({
    cloudRepository: repository,
    getState: () => state,
    mailService: null,
    makeId: (prefix) => `${prefix}_${++id}`,
    now: () => new Date(Date.UTC(2026, 4, 12, 0, 0, id)).toISOString(),
    persistState: async () => {},
    normalizeIds: () => {},
  });
  auth.ensureCloudState();
  return { auth, state };
}

function request(cookie = '', headers = {}) {
  return {
    headers: {
      cookie,
      'user-agent': 'node-test',
      ...headers,
    },
    socket: { remoteAddress: '127.0.0.1' },
  };
}

function response(assertion = () => {}) {
  const headers = [];
  return {
    headers,
    setHeader(name, value) {
      assertion(name, value);
      headers.push([name, value]);
    },
  };
}

function cookieHeaderFromSetCookie(value) {
  return [value].flat()
    .map((item) => String(item || '').split(';')[0])
    .filter(Boolean)
    .join('; ');
}

test('open account registration durably persists before issuing a session cookie', async () => {
  let persisted = false;
  const operations = [];
  const repository = {
    isEnabled: () => true,
    async persistAuthOperation(operation) {
      operations.push(operation);
      assert.equal(operation.type, 'register-open-account');
      await new Promise((resolve) => setTimeout(resolve, 1));
      persisted = true;
    },
  };
  const { auth } = makeAuth(repository);
  const res = response((name) => {
    assert.equal(name, 'Set-Cookie');
    assert.equal(persisted, true, 'session cookie must be sent only after the auth operation is durable');
  });

  const result = await auth.registerOpenAccount({
    name: 'Durable User',
    email: 'durable@example.test',
    password: 'password123',
  }, request(), res);

  assert.equal(result.user.email, 'durable@example.test');
  assert.equal(operations.length, 1);
  assert.equal(operations[0].user.email, 'durable@example.test');
  assert.equal(operations[0].session.userId, operations[0].user.id);
  assert.match(res.headers[0][1], /magclaw_session=/);
});

test('open account registration rolls back local auth state when durable persistence fails', async () => {
  const repository = {
    isEnabled: () => true,
    async persistAuthOperation() {
      throw new Error('database unavailable');
    },
  };
  const { auth, state } = makeAuth(repository);
  const res = response();

  await assert.rejects(
    () => auth.registerOpenAccount({
      name: 'Rollback User',
      email: 'rollback@example.test',
      password: 'password123',
    }, request(), res),
    /database unavailable/,
  );

  assert.equal(state.cloud.users.length, 0);
  assert.equal(state.cloud.sessions.length, 0);
  assert.equal(res.headers.length, 0);
});

test('login persists a narrow auth operation before issuing a session cookie', async () => {
  let persisted = false;
  const operations = [];
  const repository = {
    isEnabled: () => true,
    async persistAuthOperation(operation) {
      operations.push(operation);
      assert.equal(operation.type, 'login');
      assert.deepEqual(Object.keys(operation.user).sort(), ['id', 'lastLoginAt']);
      await new Promise((resolve) => setTimeout(resolve, 1));
      persisted = true;
    },
  };
  const createdAt = '2026-05-12T00:00:00.000Z';
  const { auth } = makeAuth(repository, {
    cloud: {
      users: [{
        id: 'usr_login',
        email: 'login@example.test',
        name: 'Login User',
        passwordHash: scryptPassword('password123'),
        language: 'en',
        createdAt,
        updatedAt: createdAt,
      }],
    },
  });
  const res = response((name) => {
    assert.equal(name, 'Set-Cookie');
    assert.equal(persisted, true, 'login cookie must be sent only after the session row is durable');
  });

  const result = await auth.login({
    email: 'login@example.test',
    password: 'password123',
  }, request(), res);

  assert.equal(result.user.id, 'usr_login');
  assert.equal(operations.length, 1);
  assert.equal(operations[0].session.userId, 'usr_login');
  assert.match(res.headers[0][1], /magclaw_session=/);
});

test('auth status exposes configured login providers with Feishu as the default provider', () => {
  const previous = process.env.MAGCLAW_AUTH_PROVIDERS;
  process.env.MAGCLAW_AUTH_PROVIDERS = JSON.stringify([
    { type: 'email_password', label: 'Email password' },
    {
      type: 'feishu',
      label: 'Feishu SSO',
      app_id: 'cli_test',
      app_secret: 'super-secret',
      redirect_uri: 'https://magclaw.example.com/api/cloud/auth/feishu/callback',
    },
  ]);
  try {
    const { auth } = makeAuth(null);
    const cloud = auth.publicCloudState(request());

    assert.equal(cloud.auth.passwordLogin, true);
    assert.equal(cloud.auth.defaultProvider, 'feishu');
    assert.deepEqual(cloud.auth.providers, [
      {
        id: 'email_password',
        type: 'email_password',
        label: 'Email password',
        mode: 'password',
        enabled: true,
      },
      {
        id: 'feishu',
        type: 'feishu',
        label: 'Feishu SSO',
        mode: 'oauth',
        enabled: true,
        loginUrl: '/api/cloud/auth/feishu/start',
      },
    ]);
    assert.equal(JSON.stringify(cloud.auth.providers).includes('super-secret'), false);
    assert.equal(JSON.stringify(cloud.auth.providers).includes('cli_test'), false);
  } finally {
    if (previous === undefined) delete process.env.MAGCLAW_AUTH_PROVIDERS;
    else process.env.MAGCLAW_AUTH_PROVIDERS = previous;
  }
});

test('password login is disabled when only Feishu provider is configured', async () => {
  const previous = process.env.MAGCLAW_AUTH_PROVIDERS;
  process.env.MAGCLAW_AUTH_PROVIDERS = JSON.stringify([
    {
      type: 'feishu',
      label: 'Feishu SSO',
      app_id: 'cli_test',
      app_secret: 'super-secret',
      redirect_uri: 'https://magclaw.example.com/api/cloud/auth/feishu/callback',
    },
  ]);
  try {
    const createdAt = '2026-05-12T00:00:00.000Z';
    const { auth } = makeAuth(null, {
      cloud: {
        users: [{
          id: 'usr_login_disabled',
          email: 'login-disabled@example.test',
          name: 'Login Disabled User',
          passwordHash: scryptPassword('password123'),
          language: 'en',
          createdAt,
          updatedAt: createdAt,
        }],
      },
    });

    assert.equal(auth.publicCloudState(request()).auth.passwordLogin, false);
    await assert.rejects(
      () => auth.login({
        email: 'login-disabled@example.test',
        password: 'password123',
      }, request(), response()),
      /Email password sign-in is not enabled/,
    );
  } finally {
    if (previous === undefined) delete process.env.MAGCLAW_AUTH_PROVIDERS;
    else process.env.MAGCLAW_AUTH_PROVIDERS = previous;
  }
});

test('Feishu callback exchanges code, creates a MagClaw session, and persists oauth metadata', async () => {
  const previousProviders = process.env.MAGCLAW_AUTH_PROVIDERS;
  const previousFetch = globalThis.fetch;
  process.env.MAGCLAW_AUTH_PROVIDERS = JSON.stringify([
    {
      type: 'feishu',
      label: 'Feishu SSO',
      app_id: 'cli_test',
      app_secret: 'super-secret',
      redirect_uri: 'https://magclaw.example.com/api/cloud/auth/feishu/callback',
    },
  ]);
  const fetchCalls = [];
  globalThis.fetch = async (url, options = {}) => {
    fetchCalls.push({ url: String(url), options });
    if (String(url).includes('/auth/v3/app_access_token/internal')) {
      const body = JSON.parse(options.body);
      assert.equal(body.app_id, 'cli_test');
      assert.equal(body.app_secret, 'super-secret');
      return Response.json({ code: 0, msg: 'ok', app_access_token: 'app-token' });
    }
    if (String(url).includes('/authen/v1/access_token')) {
      assert.equal(options.headers.authorization, 'Bearer app-token');
      assert.equal(JSON.parse(options.body).code, 'oauth-code');
      return Response.json({ code: 0, data: { access_token: 'user-token' } });
    }
    if (String(url).includes('/authen/v1/user_info')) {
      assert.equal(options.headers.authorization, 'Bearer user-token');
      return Response.json({
        code: 0,
        data: {
          email: 'feishu@example.test',
          name: 'Feishu User',
          avatar_url: 'https://avatar.example.test/u.png',
          open_id: 'ou_test',
          union_id: 'on_test',
          tenant_key: 'tenant_test',
        },
      });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  const operations = [];
  const repository = {
    isEnabled: () => true,
    async persistAuthOperation(operation) {
      operations.push(operation);
      assert.equal(operation.type, 'oauth-login');
      assert.equal(operation.provider, 'feishu');
      assert.equal(operation.user.email, 'feishu@example.test');
      assert.equal(operation.user.metadata.oauth.feishu.openId, 'ou_test');
      assert.equal(operation.user.metadata.oauth.feishu.unionId, 'on_test');
    },
  };
  try {
    const { auth, state } = makeAuth(repository);
    const res = response();
    const result = await auth.loginWithFeishuCallback(
      new URL('https://magclaw.example.com/api/cloud/auth/feishu/callback?code=oauth-code&state=state-token'),
      request('magclaw_feishu_oauth_state=state-token'),
      res,
    );

    assert.equal(result.user.email, 'feishu@example.test');
    assert.equal(state.cloud.users.length, 1);
    assert.equal(state.cloud.users[0].passwordHash, '');
    assert.equal(operations.length, 1);
    assert.equal(fetchCalls.length, 3);
    assert.equal(res.headers.length, 1);
    assert.ok(Array.isArray(res.headers[0][1]));
    assert.match(res.headers[0][1][0], /magclaw_session=/);
    assert.match(res.headers[0][1][1], /magclaw_feishu_oauth_state=;/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousProviders === undefined) delete process.env.MAGCLAW_AUTH_PROVIDERS;
    else process.env.MAGCLAW_AUTH_PROVIDERS = previousProviders;
  }
});

test('Feishu callback without email uses provider account identity and keeps account email empty', async () => {
  const previousProviders = process.env.MAGCLAW_AUTH_PROVIDERS;
  const previousFetch = globalThis.fetch;
  process.env.MAGCLAW_AUTH_PROVIDERS = JSON.stringify([
    {
      type: 'feishu',
      label: 'Feishu SSO',
      app_id: 'cli_test',
      app_secret: 'super-secret',
      redirect_uri: 'https://magclaw.example.com/api/cloud/auth/feishu/callback',
    },
  ]);
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('/auth/v3/app_access_token/internal')) {
      return Response.json({ code: 0, msg: 'ok', app_access_token: 'app-token' });
    }
    if (String(url).includes('/authen/v1/access_token')) {
      return Response.json({ code: 0, data: { access_token: 'user-token' } });
    }
    if (String(url).includes('/authen/v1/user_info')) {
      return Response.json({
        code: 0,
        data: {
          name: 'No Email Feishu',
          avatar_url: 'https://avatar.example.test/no-email.png',
          open_id: 'ou_no_email',
          union_id: 'on_no_email',
          tenant_key: 'tenant_test',
        },
      });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };

  try {
    const { auth, state } = makeAuth(null);
    const first = await auth.loginWithFeishuCallback(
      new URL('https://magclaw.example.com/api/cloud/auth/feishu/callback?code=oauth-code&state=state-token'),
      request('magclaw_feishu_oauth_state=state-token'),
      response(),
    );
    const second = await auth.loginWithFeishuCallback(
      new URL('https://magclaw.example.com/api/cloud/auth/feishu/callback?code=oauth-code&state=state-token-2'),
      request('magclaw_feishu_oauth_state=state-token-2'),
      response(),
    );

    assert.equal(first.user.email, '');
    assert.equal(second.user.id, first.user.id);
    assert.equal(state.cloud.users.length, 1);
    assert.equal(state.cloud.users[0].email, '');
    assert.equal(state.cloud.users[0].metadata.oauth.feishu.providerAccountId, 'on_no_email');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousProviders === undefined) delete process.env.MAGCLAW_AUTH_PROVIDERS;
    else process.env.MAGCLAW_AUTH_PROVIDERS = previousProviders;
  }
});

test('Feishu callback requires explicit link confirmation before attaching to an existing email account', async () => {
  const previousProviders = process.env.MAGCLAW_AUTH_PROVIDERS;
  const previousFetch = globalThis.fetch;
  process.env.MAGCLAW_AUTH_PROVIDERS = JSON.stringify([
    {
      type: 'feishu',
      label: 'Feishu SSO',
      app_id: 'cli_test',
      app_secret: 'super-secret',
      redirect_uri: 'https://magclaw.example.com/api/cloud/auth/feishu/callback',
    },
  ]);
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).includes('/auth/v3/app_access_token/internal')) {
      return Response.json({ code: 0, msg: 'ok', app_access_token: 'app-token' });
    }
    if (String(url).includes('/authen/v1/access_token')) {
      return Response.json({ code: 0, data: { access_token: 'user-token' } });
    }
    if (String(url).includes('/authen/v1/user_info')) {
      return Response.json({
        code: 0,
        data: {
          email: 'linked@example.test',
          name: 'Feishu Linked',
          avatar_url: 'https://avatar.example.test/linked.png',
          open_id: 'ou_linked',
          union_id: 'on_linked',
          tenant_key: 'tenant_test',
        },
      });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  const operations = [];
  const repository = {
    isEnabled: () => true,
    async persistAuthOperation(operation) {
      operations.push(operation);
      assert.equal(operation.type, 'oauth-login');
      assert.equal(operation.user.id, 'usr_existing');
      assert.equal(operation.user.metadata.oauth.feishu.providerAccountId, 'on_linked');
    },
  };
  try {
    const createdAt = '2026-05-12T00:00:00.000Z';
    const { auth, state } = makeAuth(repository, {
      cloud: {
        users: [{
          id: 'usr_existing',
          email: 'linked@example.test',
          name: 'Existing User',
          passwordHash: scryptPassword('password123'),
          language: 'en',
          createdAt,
          updatedAt: createdAt,
        }],
      },
    });
    const pendingRes = response();
    const pending = await auth.loginWithFeishuCallback(
      new URL('https://magclaw.example.com/api/cloud/auth/feishu/callback?code=oauth-code&state=state-token'),
      request('magclaw_feishu_oauth_state=state-token'),
      pendingRes,
    );

    assert.equal(pending.pendingLink, true);
    assert.equal(state.cloud.sessions.length, 0);
    assert.equal(operations.length, 0);
    assert.ok(Array.isArray(pendingRes.headers[0][1]));
    assert.equal(pendingRes.headers[0][1].some((item) => String(item).startsWith('magclaw_session=')), false);

    const linkCookie = cookieHeaderFromSetCookie(pendingRes.headers[0][1]);
    const status = auth.feishuLinkStatus(request(linkCookie));
    assert.equal(status.account.email, 'linked@example.test');
    assert.equal(status.profile.email, 'linked@example.test');

    const confirmRes = response();
    const confirmed = await auth.confirmFeishuLink(request(linkCookie), confirmRes);
    assert.equal(confirmed.user.id, 'usr_existing');
    assert.equal(state.cloud.users[0].metadata.oauth.feishu.providerAccountId, 'on_linked');
    assert.equal(operations.length, 1);
    assert.match(confirmRes.headers[0][1][0], /magclaw_session=/);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousProviders === undefined) delete process.env.MAGCLAW_AUTH_PROVIDERS;
    else process.env.MAGCLAW_AUTH_PROVIDERS = previousProviders;
  }
});

test('Feishu authorization keeps a safe join-link return path through callback login', async () => {
  const previousProviders = process.env.MAGCLAW_AUTH_PROVIDERS;
  const previousFetch = globalThis.fetch;
  process.env.MAGCLAW_AUTH_PROVIDERS = JSON.stringify([
    {
      type: 'feishu',
      label: 'Feishu SSO',
      app_id: 'cli_test',
      app_secret: 'super-secret',
      redirect_uri: 'https://magclaw.example.com/api/cloud/auth/feishu/callback',
    },
  ]);
  globalThis.fetch = async (url) => {
    if (String(url).includes('/auth/v3/app_access_token/internal')) {
      return Response.json({ code: 0, msg: 'ok', app_access_token: 'app-token' });
    }
    if (String(url).includes('/authen/v1/access_token')) {
      return Response.json({ code: 0, data: { access_token: 'user-token' } });
    }
    if (String(url).includes('/authen/v1/user_info')) {
      return Response.json({
        code: 0,
        data: {
          email: 'join-feishu@example.test',
          name: 'Join Feishu',
          open_id: 'ou_join',
          union_id: 'on_join',
        },
      });
    }
    throw new Error(`Unexpected fetch ${url}`);
  };
  try {
    const { auth } = makeAuth(null);
    const authorization = auth.createFeishuAuthorization(request(), { returnTo: '/join/mc_join_safe' });
    assert.ok(authorization.cookies.some((item) => item.startsWith('magclaw_feishu_oauth_state=')));
    assert.ok(authorization.cookies.some((item) => item.startsWith('magclaw_feishu_oauth_return=')));
    const state = new URL(authorization.redirectUrl).searchParams.get('state');
    const callback = await auth.loginWithFeishuCallback(
      new URL(`https://magclaw.example.com/api/cloud/auth/feishu/callback?code=oauth-code&state=${encodeURIComponent(state)}`),
      request(cookieHeaderFromSetCookie(authorization.cookies)),
      response(),
    );
    assert.equal(callback.returnTo, '/join/mc_join_safe');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousProviders === undefined) delete process.env.MAGCLAW_AUTH_PROVIDERS;
    else process.env.MAGCLAW_AUTH_PROVIDERS = previousProviders;
  }
});

test('join link acceptance works for a signed-in Feishu account without email', async () => {
  const createdAt = '2026-05-12T00:00:00.000Z';
  const rawSession = 'no-email-session';
  const rawJoin = 'mc_join_no_email';
  const { auth, state } = makeAuth(null, {
    cloud: {
      users: [{
        id: 'usr_no_email',
        email: '',
        name: 'No Email Feishu',
        passwordHash: '',
        avatarUrl: 'https://avatar.example.test/no-email.png',
        language: 'en',
        createdAt,
        updatedAt: createdAt,
        metadata: {
          oauth: {
            feishu: {
              providerAccountId: 'on_no_email',
              openId: 'ou_no_email',
            },
          },
        },
      }],
      sessions: [{
        id: 'sess_no_email',
        userId: 'usr_no_email',
        tokenHash: sha256(rawSession),
        createdAt,
        expiresAt: '2026-05-26T00:00:00.000Z',
      }],
      workspaces: [
        { id: 'local', slug: 'local', name: 'Local', createdAt, updatedAt: createdAt },
        { id: 'wsp_join', slug: 'join-team', name: 'Join Team', createdAt, updatedAt: createdAt },
      ],
      joinLinks: [{
        id: 'jlink_no_email',
        workspaceId: 'wsp_join',
        tokenHash: sha256(rawJoin),
        maxUses: 1,
        usedCount: 0,
        expiresAt: '2026-05-26T00:00:00.000Z',
        revokedAt: null,
        createdBy: 'usr_owner',
        createdAt,
        updatedAt: createdAt,
      }],
    },
  });

  const result = await auth.acceptJoinLink(
    { token: rawJoin },
    request(`${SESSION_COOKIE}=${rawSession}`),
  );

  assert.equal(result.workspace.id, 'wsp_join');
  assert.equal(result.member.userId, 'usr_no_email');
  assert.equal(state.cloud.joinLinks[0].usedCount, 1);
  assert.equal(state.humans.find((human) => human.authUserId === 'usr_no_email')?.email, '');
});

test('console server switch stays local to the handling process', async () => {
  let persistStarted = false;
  const repository = {
    isEnabled: () => true,
    async persistFromState() {
      persistStarted = true;
    },
  };
  const createdAt = '2026-05-12T00:00:00.000Z';
  const token = 'switch-session-token';
  const { auth, state } = makeAuth(repository, {
    connection: { workspaceId: 'wsp_local' },
    cloud: {
      users: [{
        id: 'usr_switch',
        email: 'switch@example.test',
        name: 'Switch User',
        passwordHash: scryptPassword('password123'),
        language: 'en',
        createdAt,
        updatedAt: createdAt,
      }],
      sessions: [{
        id: 'ses_switch',
        userId: 'usr_switch',
        tokenHash: sha256(token),
        createdAt,
        expiresAt: '2026-05-26T00:00:00.000Z',
      }],
      workspaces: [
        { id: 'wsp_local', slug: 'local', name: 'Local', createdAt, updatedAt: createdAt },
        { id: 'wsp_second', slug: 'second-team', name: 'Second Team', createdAt, updatedAt: createdAt },
      ],
      workspaceMembers: [
        { id: 'wmem_local', workspaceId: 'wsp_local', userId: 'usr_switch', humanId: 'hum_switch', role: 'admin', status: 'active', joinedAt: createdAt, createdAt },
        { id: 'wmem_second', workspaceId: 'wsp_second', userId: 'usr_switch', humanId: 'hum_switch', role: 'admin', status: 'active', joinedAt: createdAt, createdAt },
      ],
    },
    humans: [{
      id: 'hum_switch',
      userId: 'usr_switch',
      workspaceId: 'wsp_local',
      name: 'Switch User',
      email: 'switch@example.test',
      role: 'admin',
      status: 'online',
      createdAt,
      updatedAt: createdAt,
    }],
  });
  auth.ensureCloudState();

  const result = await auth.switchConsoleServer('second-team', request(`${SESSION_COOKIE}=${token}`));

  assert.equal(result.server.id, 'wsp_second');
  assert.equal(state.connection.workspaceId, 'wsp_second');
  assert.equal(persistStarted, false);
});

test('request workspace headers scope current actor and public cloud state', async () => {
  const createdAt = '2026-05-12T00:00:00.000Z';
  const token = 'header-session-token';
  const { auth, state } = makeAuth(null, {
    connection: { workspaceId: 'wsp_local' },
    cloud: {
      users: [{
        id: 'usr_header',
        email: 'header@example.test',
        name: 'Header User',
        passwordHash: scryptPassword('password123'),
        language: 'en',
        createdAt,
        updatedAt: createdAt,
      }],
      sessions: [{
        id: 'ses_header',
        userId: 'usr_header',
        tokenHash: sha256(token),
        createdAt,
        expiresAt: '2026-05-26T00:00:00.000Z',
      }],
      workspaces: [
        { id: 'wsp_local', slug: 'local', name: 'Local', createdAt, updatedAt: createdAt },
        { id: 'wsp_second', slug: 'second-team', name: 'Second Team', createdAt, updatedAt: createdAt },
      ],
      workspaceMembers: [
        { id: 'wmem_local', workspaceId: 'wsp_local', userId: 'usr_header', humanId: 'hum_local', role: 'member', status: 'active', joinedAt: createdAt, createdAt },
        { id: 'wmem_second', workspaceId: 'wsp_second', userId: 'usr_header', humanId: 'hum_second', role: 'admin', status: 'active', joinedAt: createdAt, createdAt },
      ],
    },
  });
  auth.ensureCloudState();

  const req = request(`${SESSION_COOKIE}=${token}`, { 'x-magclaw-server-slug': 'second-team' });
  const actor = auth.currentActor(req);
  const cloud = auth.publicCloudState(req);

  assert.equal(actor.member.workspaceId, 'wsp_second');
  assert.equal(actor.member.role, 'admin');
  assert.equal(cloud.workspace.id, 'wsp_second');
  assert.equal(cloud.auth.currentMember.workspaceId, 'wsp_second');
  assert.equal(state.connection.workspaceId, 'wsp_local');
});

test('console server creation waits for auth persistence before returning', async () => {
  let authPersistStarted = false;
  let workspacePersistStarted = false;
  let workspacePersistedId = '';
  let releaseAuthPersist;
  let releaseWorkspacePersist;
  const authPersistPromise = new Promise((resolve) => {
    releaseAuthPersist = () => resolve();
  });
  const workspacePersistPromise = new Promise((resolve) => {
    releaseWorkspacePersist = () => resolve();
  });
  const realtimeEvents = [];
  const repository = {
    isEnabled: () => true,
    async persistAuthFromState() {
      authPersistStarted = true;
      await authPersistPromise;
    },
    async persistWorkspaceFromState(snapshot, workspaceId) {
      workspacePersistStarted = true;
      workspacePersistedId = workspaceId;
      const allChannel = snapshot.channels.find((channel) => channel.workspaceId === workspaceId && channel.name === 'all');
      assert.ok(allChannel, 'workspace persistence must include the default all channel');
      await workspacePersistPromise;
    },
    async persistFromState() {
      throw new Error('full persistence should be owned by the route broadcast path');
    },
    async publishRealtimeEvent(event) {
      realtimeEvents.push(event);
    },
  };
  const createdAt = '2026-05-12T00:00:00.000Z';
  const token = 'create-session-token';
  const { auth, state } = makeAuth(repository, {
    connection: { workspaceId: 'wsp_local' },
    cloud: {
      users: [{
        id: 'usr_create',
        email: 'create@example.test',
        name: 'Create User',
        passwordHash: scryptPassword('password123'),
        language: 'en',
        createdAt,
        updatedAt: createdAt,
      }],
      sessions: [{
        id: 'ses_create',
        userId: 'usr_create',
        tokenHash: sha256(token),
        createdAt,
        expiresAt: '2026-05-26T00:00:00.000Z',
      }],
      workspaces: [
        { id: 'wsp_local', slug: 'local', name: 'Local', createdAt, updatedAt: createdAt },
      ],
      workspaceMembers: [
        { id: 'wmem_local', workspaceId: 'wsp_local', userId: 'usr_create', humanId: 'hum_create', role: 'admin', status: 'active', joinedAt: createdAt, createdAt },
      ],
    },
    humans: [{
      id: 'hum_create',
      userId: 'usr_create',
      workspaceId: 'wsp_local',
      name: 'Create User',
      email: 'create@example.test',
      role: 'admin',
      status: 'online',
      createdAt,
      updatedAt: createdAt,
    }],
  });
  auth.ensureCloudState();

  let settled = false;
  const creation = auth.createConsoleServer(
    { name: 'Created Team', slug: 'created-team' },
    request(`${SESSION_COOKIE}=${token}`),
  ).then((value) => {
    settled = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(authPersistStarted, true);
  assert.equal(workspacePersistStarted, false);
  assert.equal(settled, false);
  releaseAuthPersist();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(workspacePersistStarted, true);
  assert.equal(settled, false);
  releaseWorkspacePersist();
  const result = await creation;

  assert.equal(result.server.slug, 'created-team');
  assert.equal(result.member.workspaceId, result.server.id);
  assert.equal(state.connection.workspaceId, result.server.id);
  assert.equal(state.cloud.workspaces.some((workspace) => workspace.slug === 'created-team'), true);
  assert.equal(workspacePersistedId, result.server.id);
  const allChannel = state.channels.find((channel) => channel.workspaceId === result.server.id && channel.name === 'all');
  assert.ok(allChannel, 'new console servers must get a workspace-scoped all channel');
  assert.equal(allChannel.locked, true);
  assert.equal(allChannel.humanIds.includes(result.member.humanId), true);
  assert.deepEqual(realtimeEvents.at(-1), {
    reason: 'console_server_created',
    authReload: true,
    workspaceId: result.server.id,
  });
  assert.equal(authPersistStarted, true);
});
