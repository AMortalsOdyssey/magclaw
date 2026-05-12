import assert from 'node:assert/strict';
import test from 'node:test';
import { createCloudAuth } from '../server/cloud/auth.js';
import { scryptPassword, verifyPassword } from '../server/cloud/auth-primitives.js';

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

test('configured admin password refresh persists an explicit admin sync operation', async (t) => {
  const previousEnv = {
    MAGCLAW_ADMIN_EMAIL: process.env.MAGCLAW_ADMIN_EMAIL,
    MAGCLAW_ADMIN_PASSWORD: process.env.MAGCLAW_ADMIN_PASSWORD,
    MAGCLAW_ADMIN_NAME: process.env.MAGCLAW_ADMIN_NAME,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.MAGCLAW_ADMIN_EMAIL = 'admin@example.test';
  process.env.MAGCLAW_ADMIN_PASSWORD = 'newpass123';
  process.env.MAGCLAW_ADMIN_NAME = 'Admin';

  const calls = [];
  const repository = {
    isEnabled: () => true,
    async persistFromState() {
      calls.push({ type: 'state' });
    },
    async persistAuthOperation(operation) {
      calls.push({ type: 'auth', operation });
    },
  };
  const createdAt = '2026-05-12T00:00:00.000Z';
  const { auth, state } = makeAuth(repository, {
    cloud: {
      users: [{
        id: 'usr_admin',
        email: 'admin@example.test',
        name: 'Admin',
        passwordHash: scryptPassword('oldpass123'),
        language: 'en',
        emailVerifiedAt: createdAt,
        disabledAt: createdAt,
        createdAt,
        updatedAt: createdAt,
      }],
      workspaceMembers: [{
        id: 'wmem_admin',
        workspaceId: 'local',
        userId: 'usr_admin',
        humanId: 'hum_admin',
        role: 'admin',
        status: 'active',
        joinedAt: createdAt,
        createdAt,
        updatedAt: createdAt,
      }],
    },
    humans: [{
      id: 'hum_admin',
      userId: 'usr_admin',
      workspaceId: 'local',
      name: 'Admin',
      role: 'admin',
      createdAt,
      updatedAt: createdAt,
    }],
  });

  await auth.ensureConfiguredAdmin();

  assert.deepEqual(calls.map((call) => call.type), ['state', 'auth']);
  assert.equal(calls[1].operation.type, 'configured-admin-sync');
  assert.equal(calls[1].operation.user.id, 'usr_admin');
  assert.equal(calls[1].operation.user.disabledAt, null);
  assert.equal(verifyPassword('newpass123', calls[1].operation.user.passwordHash), true);
  assert.equal(verifyPassword('newpass123', state.cloud.users[0].passwordHash), true);
  assert.equal(state.cloud.users[0].disabledAt, undefined);
});
