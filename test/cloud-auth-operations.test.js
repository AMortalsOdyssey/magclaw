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

function request(cookie = '') {
  return {
    headers: {
      cookie,
      'user-agent': 'node-test',
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

test('console server switch returns before full cloud persistence completes', async () => {
  let persistStarted = false;
  let persistCompleted = false;
  let releasePersist;
  const persistStartedPromise = new Promise((resolve) => {
    releasePersist = () => {
      persistCompleted = true;
      resolve();
    };
  });
  const repository = {
    isEnabled: () => true,
    async persistFromState() {
      persistStarted = true;
      await persistStartedPromise;
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

  const result = await Promise.race([
    auth.switchConsoleServer('second-team', request(`${SESSION_COOKIE}=${token}`)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('switch waited for persistence')), 25)),
  ]);

  assert.equal(result.server.id, 'wsp_second');
  assert.equal(state.connection.workspaceId, 'wsp_second');
  assert.equal(persistStarted, true);
  assert.equal(persistCompleted, false);

  releasePersist();
  await persistStartedPromise;
});

test('console server creation returns before full cloud persistence completes', async () => {
  let authPersistStarted = false;
  let fullPersistStarted = false;
  let releaseAuthPersist;
  let releaseFullPersist;
  const authPersistPromise = new Promise((resolve) => {
    releaseAuthPersist = () => resolve();
  });
  const fullPersistPromise = new Promise((resolve) => {
    releaseFullPersist = () => resolve();
  });
  const repository = {
    isEnabled: () => true,
    async persistAuthFromState() {
      authPersistStarted = true;
      await authPersistPromise;
    },
    async persistFromState() {
      fullPersistStarted = true;
      await fullPersistPromise;
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

  const result = await Promise.race([
    auth.createConsoleServer(
      { name: 'Created Team', slug: 'created-team' },
      request(`${SESSION_COOKIE}=${token}`),
    ),
    new Promise((_, reject) => setTimeout(() => reject(new Error('create waited for full persistence')), 25)),
  ]);

  assert.equal(result.server.slug, 'created-team');
  assert.equal(state.connection.workspaceId, result.server.id);
  assert.equal(state.cloud.workspaces.some((workspace) => workspace.slug === 'created-team'), true);
  assert.equal(authPersistStarted, true);
  assert.equal(fullPersistStarted, true);

  releaseAuthPersist();
  releaseFullPersist();
  await Promise.all([authPersistPromise, fullPersistPromise]);
});
