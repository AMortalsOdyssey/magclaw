import assert from 'node:assert/strict';
import test from 'node:test';

import { handleTeamMemoryApi } from '../server/api/team-memory-routes.js';
import { createInitialTeamMemoryState } from '../server/team-memory.js';

function makeResponse() {
  return {
    statusCode: null,
    data: null,
    error: null,
    headers: {},
    body: '',
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
    connection: { workspaceId: 'ws_route' },
    channels: [{ id: 'chan_team', name: 'team-memory' }],
    messages: [],
    replies: [],
    teamMemory: createInitialTeamMemoryState(),
  };
  const persistCalls = [];
  const events = [];
  return {
    addSystemEvent: (type, message, metadata = {}) => events.push({ type, message, metadata }),
    broadcastState: () => {},
    currentActor: () => ({ member: { workspaceId: 'ws_route', humanId: 'hum_route' } }),
    getState: () => state,
    makeId: (() => {
      let counter = 0;
      return (prefix) => `${prefix}_${++counter}`;
    })(),
    now: () => '2026-06-01T10:00:00.000Z',
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
    vectorSearch: async ({ memory }) => ({
      ok: true,
      candidates: memory.vectorDocuments.map((doc) => ({
        ...doc,
        vectorScore: doc.topicId === 'rerank-feedback' ? 0.8 : 0.2,
        keywordScore: doc.topicId === 'rerank-feedback' ? 0.9 : 0.1,
        freshnessScore: 0.5,
      })),
    }),
    rerank: async ({ candidates }) => candidates.map((candidate, index) => ({
      index,
      score: candidate.topicId === 'rerank-feedback' ? 0.92 : 0.2,
    })),
    zillizReady: () => true,
    rerankReady: () => true,
    persistCalls,
    events,
    state,
    ...overrides,
  };
}

function syncBody() {
  return {
    runtime: 'codex',
    projectKey: 'magclaw',
    sessionId: 'sess_route',
    title: 'MagClaw rerank route session',
    channelId: 'chan_team',
    idempotencyKey: 'route:sync:1',
    events: [
      {
        eventId: 'evt_1',
        ordinal: 1,
        role: 'user',
        text: '查一下团队记忆 rerank 反馈。',
        createdAt: '2026-06-01T09:58:00.000Z',
      },
      {
        eventId: 'evt_2',
        ordinal: 2,
        role: 'assistant',
        text: '结论：先 Zilliz 召回，再 rerank，打开原文后写 feedback。',
        createdAt: '2026-06-01T09:59:00.000Z',
      },
    ],
  };
}

test('team memory route syncs a batch and search returns reranked top results', async () => {
  const indexed = [];
  const deps = routeDeps({
    readJson: async () => syncBody(),
    indexTeamMemoryDocuments: async ({ documents }) => indexed.push(...documents),
  });
  const syncRes = makeResponse();
  assert.equal(await handleTeamMemoryApi(
    { method: 'POST' },
    syncRes,
    new URL('http://local/api/team-memory/sync'),
    deps,
  ), true);
  assert.equal(syncRes.statusCode, 202);
  assert.equal(syncRes.data.appendedEventCount, 2);
  assert.equal(deps.persistCalls[0].workspaceId, 'ws_route');
  assert.ok(indexed.some((doc) => doc.layer === 'L0' && doc.sessionId === 'sess_route'));
  assert.ok(indexed.some((doc) => doc.layer === 'L1' && doc.topicId === 'rerank-feedback'));

  const searchRes = makeResponse();
  const searchDeps = {
    ...deps,
    readJson: async () => ({ query: 'rerank 反馈', channelId: 'chan_team', limit: 5 }),
  };
  assert.equal(await handleTeamMemoryApi(
    { method: 'POST' },
    searchRes,
    new URL('http://local/api/team-memory/search'),
    searchDeps,
  ), true);
  assert.equal(searchRes.statusCode, 200);
  assert.equal(searchRes.data.ok, true);
  assert.equal(searchRes.data.results[0].topicId, 'rerank-feedback');
  assert.equal(searchRes.data.results.length, 2);
  assert.equal(searchRes.data.rerankUsed, true);
  assert.ok(searchRes.data.traceId);
  assert.equal(searchRes.data.results[0].anchorEventId, 'evt_1');
  assert.match(searchRes.data.results[0].contextUrl, /anchorEventId=evt_1/);
  assert.match(searchRes.data.results[0].contextUrl, /vectorDocumentId=sess_route%3AL1%3Arerank-feedback/);
  assert.doesNotMatch(searchRes.data.results[0].contextUrl, /anchor=sess_route%2Ftopics/);
  assert.ok(deps.state.teamMemory.feedback.some((item) => item.eventType === 'served' && item.queryId === searchRes.data.queryId));
});

test('team memory route rejects unauthenticated cloud sync unless scoped token is valid', async () => {
  const unauthorized = routeDeps({
    currentActor: () => null,
    readJson: async () => syncBody(),
    teamMemoryAuthRequired: () => true,
    validTeamMemoryToken: () => false,
  });
  const rejected = makeResponse();
  assert.equal(await handleTeamMemoryApi(
    { method: 'POST', headers: {} },
    rejected,
    new URL('http://local/api/team-memory/sync'),
    unauthorized,
  ), true);
  assert.equal(rejected.statusCode, 401);

  const authorized = routeDeps({
    currentActor: () => null,
    readJson: async () => syncBody(),
    teamMemoryAuthRequired: () => true,
    validTeamMemoryToken: () => true,
  });
  const accepted = makeResponse();
  assert.equal(await handleTeamMemoryApi(
    { method: 'POST', headers: { authorization: 'Bearer scoped-token' } },
    accepted,
    new URL('http://local/api/team-memory/sync'),
    authorized,
  ), true);
  assert.equal(accepted.statusCode, 202);
});

test('team memory auth issues scoped token, supports whoami, and revokes token', async () => {
  const deps = routeDeps({
    currentActor: () => ({ member: { workspaceId: 'ws_route', humanId: 'hum_route', email: 'team@example.com' } }),
  });
  const startRes = makeResponse();
  assert.equal(await handleTeamMemoryApi(
    { method: 'POST' },
    startRes,
    new URL('http://local/api/team-memory/auth/start'),
    deps,
  ), true);
  assert.equal(startRes.statusCode, 201);
  assert.equal(startRes.data.ok, true);
  assert.ok(startRes.data.deviceCode);
  assert.match(startRes.data.verificationUri, /user_code=/);

  const tokenDeps = {
    ...deps,
    currentActor: () => null,
    readJson: async () => ({ deviceCode: startRes.data.deviceCode }),
  };
  const tokenRes = makeResponse();
  assert.equal(await handleTeamMemoryApi(
    { method: 'POST' },
    tokenRes,
    new URL('http://local/api/team-memory/auth/token'),
    tokenDeps,
  ), true);
  assert.equal(tokenRes.statusCode, 200);
  assert.equal(tokenRes.data.status, 'approved');
  assert.match(tokenRes.data.token, /^tm_/);
  assert.equal(JSON.stringify(deps.state.teamMemory).includes(tokenRes.data.token), false);

  const whoamiRes = makeResponse();
  assert.equal(await handleTeamMemoryApi(
    { method: 'GET', headers: { authorization: `Bearer ${tokenRes.data.token}` } },
    whoamiRes,
    new URL('http://local/api/team-memory/auth/whoami'),
    { ...deps, currentActor: () => null },
  ), true);
  assert.equal(whoamiRes.statusCode, 200);
  assert.equal(whoamiRes.data.user.email, 'team@example.com');

  const syncRes = makeResponse();
  assert.equal(await handleTeamMemoryApi(
    { method: 'POST', headers: { authorization: `Bearer ${tokenRes.data.token}` } },
    syncRes,
    new URL('http://local/api/team-memory/sync'),
    {
      ...deps,
      currentActor: () => null,
      teamMemoryAuthRequired: () => true,
      validTeamMemoryToken: null,
      readJson: async () => syncBody(),
    },
  ), true);
  assert.equal(syncRes.statusCode, 202);

  const revokeRes = makeResponse();
  assert.equal(await handleTeamMemoryApi(
    { method: 'POST', headers: { authorization: `Bearer ${tokenRes.data.token}` } },
    revokeRes,
    new URL('http://local/api/team-memory/auth/revoke'),
    { ...deps, currentActor: () => null },
  ), true);
  assert.equal(revokeRes.statusCode, 200);
  assert.equal(revokeRes.data.revoked, true);

  const rejectedAfterRevoke = makeResponse();
  assert.equal(await handleTeamMemoryApi(
    { method: 'POST', headers: { authorization: `Bearer ${tokenRes.data.token}` } },
    rejectedAfterRevoke,
    new URL('http://local/api/team-memory/sync'),
    {
      ...deps,
      currentActor: () => null,
      teamMemoryAuthRequired: () => true,
      validTeamMemoryToken: null,
      readJson: async () => syncBody(),
    },
  ), true);
  assert.equal(rejectedAfterRevoke.statusCode, 401);
});

test('team memory local search fallback filters by vector document updatedAt date range', async () => {
  const deps = routeDeps({ readJson: async () => syncBody(), vectorSearch: null, rerank: null });
  await handleTeamMemoryApi(
    { method: 'POST' },
    makeResponse(),
    new URL('http://local/api/team-memory/sync'),
    deps,
  );
  for (const doc of deps.state.teamMemory.vectorDocuments) {
    doc.updatedAt = doc.layer === 'L1' ? '2026-06-01T09:59:00.000Z' : '2026-05-31T23:59:00.000Z';
  }

  const searchRes = makeResponse();
  const searchDeps = {
    ...deps,
    readJson: async () => ({
      query: 'rerank 反馈',
      channelId: 'chan_team',
      dateRange: { from: '2026-06-01T00:00:00.000Z' },
      limit: 5,
    }),
  };
  assert.equal(await handleTeamMemoryApi(
    { method: 'POST' },
    searchRes,
    new URL('http://local/api/team-memory/search'),
    searchDeps,
  ), true);

  assert.equal(searchRes.statusCode, 200);
  assert.deepEqual(searchRes.data.results.map((item) => item.layer), ['L1']);
});

test('team memory route records feedback and serves context windows', async () => {
  const deps = routeDeps({ readJson: async () => syncBody() });
  await handleTeamMemoryApi(
    { method: 'POST' },
    makeResponse(),
    new URL('http://local/api/team-memory/sync'),
    deps,
  );
  const vectorDocumentId = deps.state.teamMemory.vectorDocuments.find((doc) => doc.layer === 'L1').vectorDocumentId;
  const feedbackDeps = {
    ...deps,
    readJson: async () => ({
      queryId: 'tmq_route',
      vectorDocumentId,
      sessionId: 'sess_route',
      eventType: 'opened',
    }),
  };
  const feedbackRes = makeResponse();
  assert.equal(await handleTeamMemoryApi(
    { method: 'POST' },
    feedbackRes,
    new URL('http://local/api/team-memory/feedback'),
    feedbackDeps,
  ), true);
  assert.equal(feedbackRes.statusCode, 200);
  assert.equal(feedbackRes.data.ok, true);
  assert.equal(deps.state.teamMemory.feedback.length, 1);

  const contextRes = makeResponse();
  assert.equal(await handleTeamMemoryApi(
    { method: 'GET' },
    contextRes,
    new URL('http://local/api/team-memory/context/sess_route?anchorEventId=evt_1&direction=next&limit=1'),
    deps,
  ), true);
  assert.equal(contextRes.statusCode, 200);
  assert.deepEqual(contextRes.data.events.map((event) => event.eventId), ['evt_2']);
});

test('team memory route doctor exposes missing recall dependencies without secrets', async () => {
  const deps = routeDeps({
    zillizReady: () => false,
    rerankReady: () => false,
  });
  const res = makeResponse();
  assert.equal(await handleTeamMemoryApi(
    { method: 'GET' },
    res,
    new URL('http://local/api/team-memory/doctor'),
    deps,
  ), true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.data.ok, false);
  assert.equal(res.data.checks.zilliz.ready, false);
  assert.equal(res.data.checks.rerank.ready, false);
  assert.equal(res.data.checks.llm.ready, false);
  assert.doesNotMatch(JSON.stringify(res.data), /secret|token|api_key/i);
});

test('team memory route doctor can probe embedding dimension on demand', async () => {
  const deps = routeDeps({
    embeddingReady: () => true,
    embeddingProbe: async () => ({ ok: true, dimension: 1536 }),
  });
  const res = makeResponse();
  assert.equal(await handleTeamMemoryApi(
    { method: 'GET' },
    res,
    new URL('http://local/api/team-memory/doctor?probe=1'),
    deps,
  ), true);

  assert.equal(res.statusCode, 200);
  assert.equal(res.data.checks.embedding.ready, true);
  assert.equal(res.data.checks.embedding.dimension, 1536);
});

test('team memory route creates a public share and serves it without authentication', async () => {
  const deps = routeDeps({
    currentActor: () => ({ member: { workspaceId: 'ws_route', humanId: 'hum_route', name: 'Ada PM', email: 'ada@example.com' } }),
    readJson: async () => ({
      title: 'Rerank 方案摘要',
      contentType: 'markdown',
      content: '# Rerank 方案摘要\n\n团队结论：先召回，再重排，最后记录反馈。',
    }),
  });
  const createRes = makeResponse();
  assert.equal(await handleTeamMemoryApi(
    { method: 'POST', headers: { host: 'magclaw.example', 'x-forwarded-proto': 'https' } },
    createRes,
    new URL('https://magclaw.example/api/team-memory/shares'),
    deps,
  ), true);

  assert.equal(createRes.statusCode, 201);
  assert.equal(createRes.data.ok, true);
  assert.match(createRes.data.url, /^https:\/\/magclaw\.example\/s\/share_/);
  assert.equal(deps.state.teamMemory.shares.length, 1);

  const shareId = createRes.data.shareId;
  const publicRes = makeResponse();
  assert.equal(await handleTeamMemoryApi(
    { method: 'GET', headers: {} },
    publicRes,
    new URL(`https://magclaw.example/s/${shareId}`),
    { ...deps, currentActor: () => null, teamMemoryAuthRequired: () => true },
  ), true);

  assert.equal(publicRes.statusCode, 200);
  assert.match(publicRes.headers['content-type'], /text\/html/);
  assert.match(publicRes.headers['content-security-policy'], /sandbox/);
  assert.match(publicRes.body, /MagClaw QuickShare/);
  assert.match(publicRes.body, /<h1>Rerank 方案摘要<\/h1>/);
  assert.match(publicRes.body, /团队结论/);
  assert.match(publicRes.body, /Created by Ada PM/);
  assert.match(publicRes.body, /2026-06-01T10:00:00.000Z/);

  const indexRes = makeResponse();
  assert.equal(await handleTeamMemoryApi(
    { method: 'GET', headers: {} },
    indexRes,
    new URL('https://magclaw.example/share'),
    { ...deps, currentActor: () => null, teamMemoryAuthRequired: () => true },
  ), true);
  assert.equal(indexRes.statusCode, 200);
  assert.match(indexRes.body, /Rerank 方案摘要/);
  assert.match(indexRes.body, new RegExp(`/s/${shareId}`));
});

test('team memory route serves a dynamic context html page without creating static files', async () => {
  const deps = routeDeps();
  const res = makeResponse();
  assert.equal(await handleTeamMemoryApi(
    { method: 'GET' },
    res,
    new URL('http://local/team-memory/context/sess_route?anchorEventId=evt_2&vectorDocumentId=vec_1&queryId=tmq_1'),
    deps,
  ), true);

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.body, /MagClaw Team Memory Context/);
  assert.match(res.body, /\/api\/team-memory\/context\/sess_route/);
  assert.match(res.body, /\/api\/team-memory\/feedback/);
  assert.match(res.body, /load_more/);
  assert.match(res.body, /vec_1/);
  assert.match(res.body, /load-more-prev/);
  assert.match(res.body, /load-more-next/);
});
