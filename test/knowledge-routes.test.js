import assert from 'node:assert/strict';
import test from 'node:test';

import { handleKnowledgeApi } from '../server/api/knowledge-routes.js';
import { assertKnowledgeDeploySafe, assertKnowledgeSecretConfigured } from '../server/deploy-guard.js';

const SAMPLE_MARKDOWN = `# Team Consensus

## Memory Module

Memory should be retrievable.

### Recall Boundary

Return stable anchors.
`;

function makeResponse() {
  return {
    statusCode: null,
    data: null,
    error: null,
    headers: {},
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
    },
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
    },
    end(body = '') {
      this.body = String(body || '');
    },
  };
}

function routeDeps(overrides = {}) {
  const state = {
    connection: { workspaceId: 'ws_knowledge' },
    cloud: {
      workspace: { id: 'ws_knowledge', slug: 'knowledge-test', name: 'Knowledge Test' },
      workspaces: [{ id: 'ws_knowledge', slug: 'knowledge-test', name: 'Knowledge Test' }],
      workspaceMembers: [
        { workspaceId: 'ws_knowledge', humanId: 'hum_owner', userId: 'user_owner', role: 'owner' },
        { workspaceId: 'ws_knowledge', humanId: 'hum_editor', userId: 'user_editor', role: 'member' },
        { workspaceId: 'ws_knowledge', humanId: 'hum_reader', userId: 'user_reader', role: 'member' },
      ],
      users: [
        { id: 'user_owner', name: 'Owner', email: 'owner@example.test' },
        { id: 'user_editor', name: 'Editor', email: 'editor@example.test' },
        { id: 'user_reader', name: 'Reader', email: 'reader@example.test' },
      ],
    },
    humans: [
      { id: 'hum_owner', workspaceId: 'ws_knowledge', name: 'Owner' },
      { id: 'hum_editor', workspaceId: 'ws_knowledge', name: 'Editor' },
      { id: 'hum_reader', workspaceId: 'ws_knowledge', name: 'Reader' },
    ],
    knowledgeSpace: { spaces: {} },
  };
  const events = [];
  const persistCalls = [];
  let actor = { member: { workspaceId: 'ws_knowledge', humanId: 'hum_owner', role: 'owner' }, user: { id: 'user_owner' } };
  return {
    addSystemEvent: (type, message, metadata = {}) => events.push({ type, message, metadata }),
    broadcastState: () => {},
    currentActor: () => actor,
    currentUser: () => actor?.user || null,
    env: { MAGCLAW_KNOWLEDGE_SECRET_KEY: 'route-key' },
    fetchImpl: async (url) => {
      if (String(url).includes('/auth/')) return { ok: true, status: 200, json: async () => ({ tenant_access_token: 'tenant' }) };
      return { ok: true, status: 200, json: async () => ({ code: 991, msg: 'mock feishu failure' }) };
    },
    getState: () => state,
    isLoginRequired: () => true,
    now: () => '2026-06-10T12:00:00.000Z',
    persistState: async (options) => persistCalls.push(options || {}),
    readJson: async () => ({}),
    sendError: (res, statusCode, message) => {
      res.statusCode = statusCode;
      res.error = message;
    },
    sendJson: (res, statusCode, data) => {
      res.statusCode = statusCode;
      res.data = data;
    },
    state,
    events,
    persistCalls,
    setActor: (nextActor) => {
      actor = nextActor;
    },
    ...overrides,
  };
}

async function callRoute(deps, method, path, body = {}) {
  const res = makeResponse();
  const handled = await handleKnowledgeApi(
    { method, headers: { host: 'magclaw.test' } },
    res,
    new URL(path, 'http://magclaw.test'),
    { ...deps, readJson: async () => body },
  );
  assert.equal(handled, true);
  return res;
}

test('Knowledge routes require Server membership for reads', async () => {
  const deps = routeDeps();
  deps.setActor(null);
  const res = await callRoute(deps, 'GET', '/api/knowledge/space');
  assert.equal(res.statusCode, 401);
  assert.match(res.error, /signed-in Server member/);
});

test('owner imports, manages whitelist/settings, editor publishes, and Feishu failure is audited', async () => {
  const deps = routeDeps();
  const importRes = await callRoute(deps, 'POST', '/api/knowledge/import', {
    markdown: SAMPLE_MARKDOWN,
    sourceName: 'Team Consensus',
  });
  assert.equal(importRes.statusCode, 201);
  assert.equal(importRes.data.mode, 'published');
  assert.equal(importRes.data.imported.documents, 2);

  const settingsRes = await callRoute(deps, 'PATCH', '/api/knowledge/settings', {
    whitelistHumanIds: ['hum_editor'],
    feishu: { appId: 'cli_test', chatId: 'oc_test', appSecret: 'fake-secret' },
  });
  assert.equal(settingsRes.statusCode, 200);
  assert.equal(settingsRes.data.settings.feishu.appSecretConfigured, true);
  assert.equal('appSecretEncrypted' in settingsRes.data.settings.feishu, false);

  deps.setActor({ member: { workspaceId: 'ws_knowledge', humanId: 'hum_reader', role: 'member' }, user: { id: 'user_reader' } });
  const blocked = await callRoute(deps, 'POST', '/api/knowledge/change-sessions', {
    summary: 'Reader attempt',
    changes: [],
  });
  assert.equal(blocked.statusCode, 403);
  assert.match(blocked.error, /whitelist/);

  deps.setActor({ member: { workspaceId: 'ws_knowledge', humanId: 'hum_editor', role: 'member' }, user: { id: 'user_editor' } });
  const doc = deps.state.knowledgeSpace.spaces.ws_knowledge.documents.find((item) => item.title === 'Memory Module');
  const draft = await callRoute(deps, 'POST', '/api/knowledge/change-sessions', {
    summary: 'Editor update',
    changes: [{ docId: doc.id, proposedMarkdown: `${doc.sourceMarkdown}\n\nEditor note.` }],
  });
  assert.equal(draft.statusCode, 201);
  assert.equal(draft.data.session.status, 'draft');

  const sessionId = draft.data.session.id;
  assert.equal((await callRoute(deps, 'POST', `/api/knowledge/change-sessions/${encodeURIComponent(sessionId)}/to-diff`)).data.session.status, 'diff');
  assert.equal((await callRoute(deps, 'POST', `/api/knowledge/change-sessions/${encodeURIComponent(sessionId)}/to-preview`)).data.session.status, 'preview');
  const publish = await callRoute(deps, 'POST', `/api/knowledge/change-sessions/${encodeURIComponent(sessionId)}/publish`);
  assert.equal(publish.statusCode, 200);
  assert.equal(publish.data.published, true);
  assert.equal(publish.data.notification.status, 'failed');
  assert.equal(deps.state.knowledgeSpace.spaces.ws_knowledge.changelogEvents.some((event) => event.type === 'notification_failed'), true);
  assert.equal(deps.persistCalls.length >= 5, true);
});

test('ask and align return matched anchors with MagClaw links', async () => {
  const deps = routeDeps();
  await callRoute(deps, 'POST', '/api/knowledge/import', { markdown: SAMPLE_MARKDOWN });

  const ask = await callRoute(deps, 'POST', '/api/knowledge/ask', { query: 'stable anchors' });
  assert.equal(ask.statusCode, 200);
  assert.equal(ask.data.matches[0].title, 'Recall Boundary');
  assert.match(ask.data.matches[0].href, /\/knowledge\/docs\//);

  const align = await callRoute(deps, 'POST', '/api/knowledge/align', { text: 'Need memory to be retrievable.' });
  assert.equal(align.statusCode, 200);
  assert.equal(align.data.rules.length > 0, true);
  assert.deepEqual(align.data.alignmentGaps, []);
});

test('re-import route reports draft mode for existing roots', async () => {
  const deps = routeDeps();
  await callRoute(deps, 'POST', '/api/knowledge/import', {
    markdown: SAMPLE_MARKDOWN,
    sourceName: 'Team Consensus',
  });

  const reimport = await callRoute(deps, 'POST', '/api/knowledge/import', {
    markdown: SAMPLE_MARKDOWN.replace('Memory should be retrievable.', 'Memory should be retrievable and reviewed.'),
    sourceName: 'Team Consensus',
  });

  assert.equal(reimport.statusCode, 201);
  assert.equal(reimport.data.mode, 'draft');
  assert.equal(reimport.data.session.status, 'draft');
  assert.equal(deps.events.at(-1).type, 'knowledge_import_drafted');
});

test('knowledge deploy guard rejects open cloud deployments and warns on missing secret', () => {
  assert.throws(() => assertKnowledgeDeploySafe({
    isCloudDeploy: true,
    isLoginRequired: () => false,
    env: {},
  }), /login.*required/i);
  assert.doesNotThrow(() => assertKnowledgeDeploySafe({
    isCloudDeploy: false,
    isLoginRequired: () => false,
    env: {},
  }));

  const warnings = [];
  assertKnowledgeDeploySafe({
    isCloudDeploy: true,
    isLoginRequired: () => false,
    env: { MAGCLAW_ALLOW_OPEN_KNOWLEDGE: '1' },
    warn: (message) => warnings.push(message),
  });
  assert.match(warnings[0], /open knowledge/i);

  assertKnowledgeSecretConfigured({
    isCloudDeploy: true,
    env: {},
    warn: (message) => warnings.push(message),
  });
  assert.match(warnings.at(-1), /MAGCLAW_KNOWLEDGE_SECRET_KEY/);
});
