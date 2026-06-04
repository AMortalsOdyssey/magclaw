import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';

import { handleTeamSharingApi } from '../server/api/team-sharing-routes.js';
import { createInitialTeamSharingState } from '../server/team-sharing.js';
import { TEAM_SHARING_COMMON_LINK_ICONS } from '../server/team-sharing-link-icons.js';

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
    cloud: {
      workspaces: [
        { id: 'ws_route', slug: 'server-route', name: 'Server Route' },
        { id: 'ws_other', slug: 'other-server', name: 'Other Server' },
      ],
    },
    channels: [{ id: 'chan_team', name: 'team-sharing' }],
    messages: [],
    replies: [],
    teamSharing: createInitialTeamSharingState(),
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
    vectorSearch: async ({ teamSharingState }) => ({
      ok: true,
      candidates: teamSharingState.vectorDocuments.map((doc) => ({
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
        text: '结论：先 Zilliz 召回，再 rerank，打开 `https://magclaw.example/team-sharing/context/sess_route` 后写 feedback。',
        createdAt: '2026-06-01T09:59:00.000Z',
      },
    ],
  };
}

function createContextPageHarness(html = '', options = {}) {
  const script = String(html || '').match(/<script>([\s\S]*?)<\/script>/)?.[1] || '';
  assert.ok(script, 'context page should embed a script');
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      elements.set(id, {
        id,
        disabled: false,
        hidden: false,
        innerHTML: '',
        textContent: '',
        title: '',
        parentElement: null,
        addEventListener: () => {},
        insertAdjacentHTML(_position, content) {
          this.innerHTML += String(content || '');
        },
        querySelector: () => null,
        closest: () => null,
      });
    }
    return elements.get(id);
  };
  const fetch = options.fetch || (async () => ({
    json: async () => ({ ok: true, session: {}, events: [], pagination: { hasPrev: false, hasNext: false } }),
  }));
  const context = {
    console,
    Date,
    Intl,
    JSON,
    Math,
    Number,
    Set,
    String,
    URLSearchParams,
    encodeURIComponent,
    fetch,
    document: {
      documentElement: { scrollHeight: 0 },
      getElementById: element,
    },
    window: {
      __teamSharingSession: {},
      addEventListener: () => {},
      setTimeout: () => 0,
      scrollTo: () => {},
      scrollY: 0,
      innerHeight: 900,
    },
  };
  vm.createContext(context);
  vm.runInContext(script, context);
  context.__elements = elements;
  context.__flush = () => new Promise((resolve) => setImmediate(resolve));
  return context;
}

test('team sharing route syncs a batch and search returns reranked top results', async () => {
  const indexed = [];
  const deps = routeDeps({
    readJson: async () => syncBody(),
    indexTeamSharingDocuments: async ({ documents }) => indexed.push(...documents),
    summarizeSession: async () => ({
      l0: '云端权威摘要：Team Sharing 先做 Zilliz 召回，再进行 rerank，并把原文打开行为写入 feedback。',
      topics: [{
        topicId: 'rerank-feedback',
        title: 'rerank-feedback',
        overview: '基于云端 LLM 摘要生成的 rerank 与反馈闭环说明。',
        sourceEventIds: ['evt_1', 'evt_2'],
      }],
    }),
  });
  const syncRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'POST' },
    syncRes,
    new URL('http://local/api/team-sharing/sync'),
    deps,
  ), true);
  assert.equal(syncRes.statusCode, 202);
  assert.equal(syncRes.data.appendedEventCount, 2);
  assert.equal(deps.persistCalls[0].workspaceId, 'ws_route');
  assert.equal(deps.state.messages[0].authorType, 'human');
  assert.equal(deps.state.messages[0].authorId, 'hum_route');
  assert.equal(deps.state.replies[1].authorType, 'agent');
  assert.equal(deps.state.replies[1].authorId, 'team_sharing_codex');
  assert.ok(indexed.some((doc) => doc.layer === 'L0' && doc.sessionId === 'sess_route'));
  assert.ok(indexed.some((doc) => doc.layer === 'L0' && /云端权威摘要/.test(doc.text || '')));
  assert.ok(indexed.some((doc) => doc.layer === 'L1' && doc.topicId === 'rerank-feedback'));

  const searchRes = makeResponse();
  const searchDeps = {
    ...deps,
    readJson: async () => ({ query: 'rerank 反馈', channelId: 'chan_team', limit: 5 }),
  };
  assert.equal(await handleTeamSharingApi(
    { method: 'POST' },
    searchRes,
    new URL('http://local/api/team-sharing/search'),
    searchDeps,
  ), true);
  assert.equal(searchRes.statusCode, 200);
  assert.equal(searchRes.data.ok, true);
  assert.equal(searchRes.data.results[0].topicId, 'rerank-feedback');
  assert.equal(searchRes.data.results.length, 2);
  assert.equal(searchRes.data.rerankUsed, true);
  assert.ok(searchRes.data.traceId);
  assert.equal(searchRes.data.results[0].anchorEventId, 'evt_1');
  assert.equal(searchRes.data.results[0].rawEventId, 'evt_1');
  assert.match(searchRes.data.results[0].contextUrl, /\/team-sharing\/context\/sess_route/);
  assert.match(searchRes.data.results[0].contextUrl, /anchorEventId=evt_1/);
  assert.match(searchRes.data.results[0].contextUrl, /limit=21/);
  assert.match(searchRes.data.results[0].contextUrl, /order=asc/);
  assert.match(searchRes.data.results[0].contextUrl, /vectorDocumentId=sess_route%3AL1%3Arerank-feedback/);
  assert.doesNotMatch(searchRes.data.results[0].contextUrl, /anchor=sess_route%2Ftopics/);
  assert.ok(deps.state.teamSharing.feedback.some((item) => item.eventType === 'served' && item.queryId === searchRes.data.queryId));
});

test('team sharing route exposes a session workspace with abstract, topics, and activities JSON', async () => {
  const deps = routeDeps({ readJson: async () => syncBody() });
  await handleTeamSharingApi(
    { method: 'POST' },
    makeResponse(),
    new URL('http://local/api/team-sharing/sync'),
    deps,
  );

  const workspaceRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: {} },
    workspaceRes,
    new URL('http://local/api/team-sharing/workspace/sess_route'),
    deps,
  ), true);
  assert.equal(workspaceRes.statusCode, 200);
  assert.equal(workspaceRes.data.ok, true);
  assert.equal(workspaceRes.data.session.sessionId, 'sess_route');
  assert.equal(workspaceRes.data.session.messageId, deps.state.teamSharing.sessions.sess_route.messageId);
  assert.ok(workspaceRes.data.tree.some((entry) => entry.path === 'abstract.md'));
  assert.ok(workspaceRes.data.tree.some((entry) => entry.path === 'debug-log.md'));
  assert.ok(workspaceRes.data.tree.some((entry) => entry.path === 'activities.json'));
  assert.ok(workspaceRes.data.tree.some((entry) => entry.path === 'topics/rerank-feedback.md'));
  assert.equal(workspaceRes.data.tree.some((entry) => entry.path === 'details/original-context.md'), false);
  const abstractFile = workspaceRes.data.files.find((file) => file.path === 'abstract.md');
  assert.match(abstractFile.content, /^# MagClaw rerank route session/m);
  assert.match(abstractFile.content, /Key Topics/);
  assert.match(abstractFile.content, /topics\/rerank-feedback\.md/);
  assert.doesNotMatch(abstractFile.content, /Source Anchors/);
  const activityFile = workspaceRes.data.files.find((file) => file.path === 'activities.json');
  const activities = JSON.parse(activityFile.content);
  assert.equal(activityFile.previewKind, 'json');
  assert.equal(activities[0].action, 'merge_summary');
  assert.ok(activities[0].changedPaths.includes('abstract.md'));
  assert.ok(activities[0].changedPaths.includes('debug-log.md'));
  const debugFile = workspaceRes.data.files.find((file) => file.path === 'debug-log.md');
  assert.match(debugFile.content, /Hook Prompt Summary/);
  assert.match(debugFile.content, /Cloud Merge/);
  const topicFile = workspaceRes.data.files.find((file) => file.path === 'topics/rerank-feedback.md');
  assert.doesNotMatch(topicFile.content, /Raw IDs/);
  assert.match(topicFile.content, /\[原文\]\(\/team-sharing\/context\/sess_route\?anchorEventId=evt_1&limit=21&order=asc\)/);
  assert.doesNotMatch(topicFile.content, /\n\s*\[打开原文\]/);
  assert.doesNotMatch(topicFile.content, /\n\s*- Raw ID:/);
  assert.match(topicFile.content, /Original Context/);
  assert.doesNotMatch(topicFile.content, /Source Anchors/);

  const deniedRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: {} },
    deniedRes,
    new URL('http://local/api/team-sharing/workspace/sess_route'),
    { ...deps, currentActor: () => ({ member: { workspaceId: 'ws_other', humanId: 'hum_other' } }) },
  ), true);
  assert.equal(deniedRes.statusCode, 403);
});

test('team sharing workspace normalizes legacy standalone original-context links', async () => {
  const deps = routeDeps({ readJson: async () => syncBody() });
  await handleTeamSharingApi(
    { method: 'POST' },
    makeResponse(),
    new URL('http://local/api/team-sharing/sync'),
    deps,
  );
  deps.state.teamSharing.abstracts.sess_route.topics['rerank-feedback'].overviewMarkdown = [
    '# rerank-feedback',
    '',
    '## Summary',
    '- 旧摘要第一条。',
    '  - Raw ID: `evt_1`',
    '  - 原文：',
    '    [打开原文](/team-sharing/context/sess_route?anchorEventId=evt_1&limit=21&order=asc)',
    '- 旧摘要第二条。',
  ].join('\n');

  const workspaceRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: {} },
    workspaceRes,
    new URL('http://local/api/team-sharing/workspace/sess_route'),
    deps,
  ), true);

  const topicFile = workspaceRes.data.files.find((file) => file.path === 'topics/rerank-feedback.md');
  assert.match(topicFile.content, /- 旧摘要第一条。（\[原文\]\(\/team-sharing\/context\/sess_route\?anchorEventId=evt_1&limit=21&order=asc\)）/);
  assert.match(topicFile.content, /- 旧摘要第二条。/);
  assert.doesNotMatch(topicFile.content, /Raw ID: `evt_1`/);
  assert.doesNotMatch(topicFile.content, /\n\s*\[打开原文\]/);
  assert.doesNotMatch(topicFile.content, /\n\s*- 原文：/);
});

test('team sharing route rejects unauthenticated cloud sync unless scoped token is valid', async () => {
  const unauthorized = routeDeps({
    currentActor: () => null,
    readJson: async () => syncBody(),
    teamSharingAuthRequired: () => true,
    validTeamSharingToken: () => false,
  });
  const rejected = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'POST', headers: {} },
    rejected,
    new URL('http://local/api/team-sharing/sync'),
    unauthorized,
  ), true);
  assert.equal(rejected.statusCode, 401);

  const authorized = routeDeps({
    currentActor: () => null,
    readJson: async () => syncBody(),
    teamSharingAuthRequired: () => true,
    validTeamSharingToken: () => true,
  });
  const accepted = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'POST', headers: { authorization: 'Bearer scoped-token' } },
    accepted,
    new URL('http://local/api/team-sharing/sync'),
    authorized,
  ), true);
  assert.equal(accepted.statusCode, 202);
});

test('team sharing auth issues scoped token, supports whoami, and revokes token', async () => {
  const deps = routeDeps({
    currentActor: () => ({ member: { workspaceId: 'ws_route', humanId: 'hum_route', email: 'team@example.com' } }),
  });
  const startRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'POST' },
    startRes,
    new URL('http://local/api/team-sharing/auth/start'),
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
  assert.equal(await handleTeamSharingApi(
    { method: 'POST' },
    tokenRes,
    new URL('http://local/api/team-sharing/auth/token'),
    tokenDeps,
  ), true);
  assert.equal(tokenRes.statusCode, 200);
  assert.equal(tokenRes.data.status, 'approved');
  assert.match(tokenRes.data.token, /^tm_/);
  assert.equal(JSON.stringify(deps.state.teamSharing).includes(tokenRes.data.token), false);

  const whoamiRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: { authorization: `Bearer ${tokenRes.data.token}` } },
    whoamiRes,
    new URL('http://local/api/team-sharing/auth/whoami'),
    { ...deps, currentActor: () => null },
  ), true);
  assert.equal(whoamiRes.statusCode, 200);
  assert.equal(whoamiRes.data.user.email, 'team@example.com');

  const syncRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'POST', headers: { authorization: `Bearer ${tokenRes.data.token}` } },
    syncRes,
    new URL('http://local/api/team-sharing/sync'),
    {
      ...deps,
      currentActor: () => null,
      teamSharingAuthRequired: () => true,
      validTeamSharingToken: null,
      readJson: async () => syncBody(),
    },
  ), true);
  assert.equal(syncRes.statusCode, 202);

  const revokeRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'POST', headers: { authorization: `Bearer ${tokenRes.data.token}` } },
    revokeRes,
    new URL('http://local/api/team-sharing/auth/revoke'),
    { ...deps, currentActor: () => null },
  ), true);
  assert.equal(revokeRes.statusCode, 200);
  assert.equal(revokeRes.data.revoked, true);

  const rejectedAfterRevoke = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'POST', headers: { authorization: `Bearer ${tokenRes.data.token}` } },
    rejectedAfterRevoke,
    new URL('http://local/api/team-sharing/sync'),
    {
      ...deps,
      currentActor: () => null,
      teamSharingAuthRequired: () => true,
      validTeamSharingToken: null,
      readJson: async () => syncBody(),
    },
  ), true);
  assert.equal(rejectedAfterRevoke.statusCode, 401);
});

test('team sharing auth approval resolves the actor from the pending request workspace', async () => {
  const deps = routeDeps({
    currentActor: (req = {}) => {
      if (req.headers?.['x-magclaw-workspace-id'] === 'ws_route') {
        return { member: { workspaceId: 'ws_route', humanId: 'hum_route', email: 'route@example.com' } };
      }
      return null;
    },
    readJson: async () => ({
      workspaceId: 'ws_route',
      profile: 'default',
      packageName: '@magclaw/team-sharing',
    }),
  });
  const startRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'POST' },
    startRes,
    new URL('http://local/api/team-sharing/auth/start'),
    deps,
  ), true);
  assert.equal(startRes.statusCode, 201);
  assert.equal(startRes.data.status, 'pending');
  assert.match(startRes.data.verificationUri, /workspaceId=ws_route/);
  assert.equal(deps.persistCalls[0].workspaceId, 'ws_route');

  const approveRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: {} },
    approveRes,
    new URL(`http://local${startRes.data.verificationUri}`),
    deps,
  ), true);
  assert.equal(approveRes.statusCode, 200);
  assert.match(approveRes.body, /Team Sharing login approved/);

  const tokenRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'POST' },
    tokenRes,
    new URL('http://local/api/team-sharing/auth/token'),
    {
      ...deps,
      currentActor: () => null,
      readJson: async () => ({ deviceCode: startRes.data.deviceCode }),
    },
  ), true);
  assert.equal(tokenRes.statusCode, 200);
  assert.equal(tokenRes.data.status, 'approved');
  assert.equal(tokenRes.data.user.email, 'route@example.com');
  assert.equal(tokenRes.data.workspaceId, 'ws_route');
});

test('team sharing local search fallback filters by vector document updatedAt date range', async () => {
  const deps = routeDeps({ readJson: async () => syncBody(), vectorSearch: null, rerank: null });
  await handleTeamSharingApi(
    { method: 'POST' },
    makeResponse(),
    new URL('http://local/api/team-sharing/sync'),
    deps,
  );
  for (const doc of deps.state.teamSharing.vectorDocuments) {
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
  assert.equal(await handleTeamSharingApi(
    { method: 'POST' },
    searchRes,
    new URL('http://local/api/team-sharing/search'),
    searchDeps,
  ), true);

  assert.equal(searchRes.statusCode, 200);
  assert.deepEqual(searchRes.data.results.map((item) => item.layer), ['L1']);
});

test('team sharing keyword-only mode bypasses unavailable vector index and uses lexical fallback', async () => {
  const deps = routeDeps({ readJson: async () => syncBody(), zillizReady: () => false, keywordSearch: null, rerank: null });
  await handleTeamSharingApi(
    { method: 'POST' },
    makeResponse(),
    new URL('http://local/api/team-sharing/sync'),
    deps,
  );

  const searchRes = makeResponse();
  const searchDeps = {
    ...deps,
    readJson: async () => ({
      query: 'rerank',
      channelId: 'chan_team',
      searchMode: 'keyword',
      keywordOnly: true,
      sortBy: 'keyword',
      limit: 5,
    }),
  };
  assert.equal(await handleTeamSharingApi(
    { method: 'POST' },
    searchRes,
    new URL('http://local/api/team-sharing/search'),
    searchDeps,
  ), true);

  assert.equal(searchRes.statusCode, 200);
  assert.equal(searchRes.data.searchMode, 'keyword');
  assert.equal(searchRes.data.sortBy, 'keyword');
  assert.ok(searchRes.data.results[0].keywordScore > 0);
  assert.ok(searchRes.data.results.some((item) => item.topicId === 'rerank-feedback'));
  assert.ok(searchRes.data.trace.keywordCandidates.length > 0);
});

test('team sharing hybrid search fuses semantic and keyword candidates before rerank', async () => {
  const deps = routeDeps({ readJson: async () => syncBody(), rerank: null });
  await handleTeamSharingApi(
    { method: 'POST' },
    makeResponse(),
    new URL('http://local/api/team-sharing/sync'),
    deps,
  );

  const searchRes = makeResponse();
  const seen = {};
  const searchDeps = {
    ...deps,
    vectorSearch: async ({ teamSharingState, query, keywords, topics }) => {
      seen.semanticQuery = query;
      seen.semanticKeywords = keywords;
      seen.semanticTopics = topics;
      return {
        ok: true,
        candidates: teamSharingState.vectorDocuments
          .filter((doc) => doc.layer === 'L0')
          .map((doc) => ({ ...doc, vectorScore: 0.9, keywordScore: 0, freshnessScore: 0.5 })),
      };
    },
    keywordSearch: async ({ teamSharingState, query, keywordQuery, keywords, topics }) => {
      seen.keywordQuery = query;
      seen.keywordQueryRaw = keywordQuery;
      seen.keywords = keywords;
      seen.topics = topics;
      return {
        ok: true,
        candidates: teamSharingState.vectorDocuments
          .filter((doc) => doc.layer === 'L1')
          .map((doc) => ({ ...doc, vectorScore: 0.05, keywordScore: 0.95, freshnessScore: 0.5 })),
      };
    },
    keywordSearchReady: () => true,
    readJson: async () => ({
      query: '昨天关于 rerank 反馈和 BM25 的融合点',
      channelId: 'chan_team',
      keywords: ['rerank', 'BM25'],
      limit: 5,
    }),
  };
  assert.equal(await handleTeamSharingApi(
    { method: 'POST' },
    searchRes,
    new URL('http://local/api/team-sharing/search'),
    searchDeps,
  ), true);

  assert.equal(searchRes.statusCode, 200);
  assert.equal(searchRes.data.searchMode, 'hybrid');
  assert.equal(searchRes.data.timePreference, 'yesterday');
  assert.deepEqual(searchRes.data.retrievalIntent, { useKeyword: true, useSemantic: true, modeBias: 'hybrid' });
  assert.equal(seen.semanticQuery, '昨天关于 rerank 反馈和 BM25 的融合点');
  assert.ok(seen.keywordQuery.includes('rerank'));
  assert.ok(seen.keywordQueryRaw.includes('BM25'));
  assert.ok(seen.keywords.includes('BM25'));
  assert.ok(seen.topics.includes('rerank 反馈'));
  assert.equal(searchRes.data.candidateCount, 2);
  assert.deepEqual(new Set(searchRes.data.results.map((item) => item.layer)), new Set(['L0', 'L1']));
  assert.ok(searchRes.data.trace.keywordCandidates.some((id) => id.includes(':L1:')));
  assert.ok(searchRes.data.trace.keywords.includes('BM25'));
});

test('team sharing route records feedback and serves context windows', async () => {
  const deps = routeDeps({ readJson: async () => syncBody() });
  await handleTeamSharingApi(
    { method: 'POST' },
    makeResponse(),
    new URL('http://local/api/team-sharing/sync'),
    deps,
  );
  const vectorDocumentId = deps.state.teamSharing.vectorDocuments.find((doc) => doc.layer === 'L1').vectorDocumentId;
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
  assert.equal(await handleTeamSharingApi(
    { method: 'POST' },
    feedbackRes,
    new URL('http://local/api/team-sharing/feedback'),
    feedbackDeps,
  ), true);
  assert.equal(feedbackRes.statusCode, 200);
  assert.equal(feedbackRes.data.ok, true);
  assert.equal(deps.state.teamSharing.feedback.length, 1);

  const contextRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET' },
    contextRes,
    new URL('http://local/api/team-sharing/context/sess_route?anchorEventId=evt_1&direction=next&limit=1'),
    deps,
  ), true);
  assert.equal(contextRes.statusCode, 200);
  assert.deepEqual(contextRes.data.events.map((event) => event.eventId), ['evt_2']);
});

test('team sharing route doctor exposes missing recall dependencies without secrets', async () => {
  const deps = routeDeps({
    zillizReady: () => false,
    rerankReady: () => false,
  });
  const res = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET' },
    res,
    new URL('http://local/api/team-sharing/doctor'),
    deps,
  ), true);
  assert.equal(res.statusCode, 200);
  assert.equal(res.data.ok, false);
  assert.equal(res.data.checks.zilliz.ready, false);
  assert.equal(res.data.checks.rerank.ready, false);
  assert.equal(res.data.checks.llm.ready, false);
  assert.doesNotMatch(JSON.stringify(res.data), /secret|token|api_key/i);
});

test('team sharing route doctor can probe embedding dimension on demand', async () => {
  const deps = routeDeps({
    embeddingReady: () => true,
    embeddingProbe: async () => ({ ok: true, dimension: 1536 }),
  });
  const res = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET' },
    res,
    new URL('http://local/api/team-sharing/doctor?probe=1'),
    deps,
  ), true);

  assert.equal(res.statusCode, 200);
  assert.equal(res.data.checks.embedding.ready, true);
  assert.equal(res.data.checks.embedding.dimension, 1536);
});

test('team sharing route creates a public share and serves it without authentication', async () => {
  const deps = routeDeps({
    currentActor: () => ({ member: { workspaceId: 'ws_route', humanId: 'hum_route', name: 'Ada PM', email: 'ada@example.com' } }),
    readJson: async () => ({
      title: 'Rerank 方案摘要',
      contentType: 'markdown',
      content: '# Rerank 方案摘要\n\n团队结论：先召回，再重排，最后记录反馈。',
      channelPath: 'feishu://docs/team/channel/product-sharing',
      projectKey: 'magclaw',
    }),
  });
  const createRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'POST', headers: { host: 'magclaw.example', 'x-forwarded-proto': 'https' } },
    createRes,
    new URL('https://magclaw.example/api/team-sharing/shares'),
    deps,
  ), true);

  assert.equal(createRes.statusCode, 201);
  assert.equal(createRes.data.ok, true);
  assert.match(createRes.data.url, /^https:\/\/magclaw\.example\/s\/share_/);
  assert.equal(deps.state.teamSharing.shares.length, 1);

  const shareId = createRes.data.shareId;
  const publicRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: {} },
    publicRes,
    new URL(`https://magclaw.example/s/${shareId}`),
    { ...deps, currentActor: () => null, teamSharingAuthRequired: () => true },
  ), true);

  assert.equal(publicRes.statusCode, 200);
  assert.match(publicRes.headers['content-type'], /text\/html/);
  assert.match(publicRes.headers['content-security-policy'], /sandbox/);
  assert.match(publicRes.body, /Team Shares/);
  assert.match(publicRes.body, /<h1>Rerank 方案摘要<\/h1>/);
  assert.match(publicRes.body, /团队结论/);
  assert.match(publicRes.body, /Created by Ada PM/);
  assert.match(publicRes.body, /2026年06月01日 18:00:00/);

  deps.state.teamSharing.shares.push({
    ...deps.state.teamSharing.shares[0],
    id: 'share_other_server',
    workspaceId: 'ws_other',
    title: 'Other server share',
  });
  deps.state.teamSharing.shares.push({
    ...deps.state.teamSharing.shares[0],
    id: 'share_manual_channel',
    channelPath: 'testing/manual-upload',
    title: 'Manual channel share',
  });

  const rejectedIndex = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: {} },
    rejectedIndex,
    new URL('https://magclaw.example/share'),
    { ...deps, currentActor: () => null, teamSharingAuthRequired: () => true },
  ), true);
  assert.equal(rejectedIndex.statusCode, 302);
  assert.match(rejectedIndex.headers.location, /^\/\?returnTo=/);

  const wrongServerIndex = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: {} },
    wrongServerIndex,
    new URL('https://magclaw.example/share'),
    { ...deps, currentActor: () => ({ member: { workspaceId: 'ws_other', humanId: 'hum_other' } }) },
  ), true);
  assert.equal(wrongServerIndex.statusCode, 403);

  const indexRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: {} },
    indexRes,
    new URL('https://magclaw.example/share'),
    deps,
  ), true);
  assert.equal(indexRes.statusCode, 200);
  assert.match(indexRes.body, /Team Shares/);
  assert.match(indexRes.body, /data-share-root-action="expand-all"/);
  assert.match(indexRes.body, /data-share-root-action="collapse-all"/);
  assert.match(indexRes.body, /animateChannel/);
  assert.match(indexRes.body, /<details class="share-channel" open>/);
  assert.match(indexRes.body, /share-channel-caret/);
  assert.match(indexRes.body, /# product-sharing/);
  assert.match(indexRes.body, /# testing/);
  assert.doesNotMatch(indexRes.body, /Share Root/);
  assert.doesNotMatch(indexRes.body, /Server-level share root/);
  assert.doesNotMatch(indexRes.body, /feishu:\/\/docs\/team\/channel\/product-sharing/);
  assert.doesNotMatch(indexRes.body, /Project/);
  assert.doesNotMatch(indexRes.body, /manual-upload/);
  assert.match(indexRes.body, /Rerank 方案摘要/);
  assert.match(indexRes.body, /Manual channel share/);
  assert.match(indexRes.body, new RegExp(`/s/${shareId}`));
  assert.doesNotMatch(indexRes.body, /Other server share/);
  assert.match(indexRes.body, /2026年06月01日 18:00:00/);

  const scopedIndexRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: {} },
    scopedIndexRes,
    new URL('https://magclaw.example/s/server-route/share'),
    deps,
  ), true);
  assert.equal(scopedIndexRes.statusCode, 200);
  assert.match(scopedIndexRes.body, /# product-sharing/);
  assert.doesNotMatch(scopedIndexRes.body, /Other server share/);

  const scopedWrongServerIndex = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: {} },
    scopedWrongServerIndex,
    new URL('https://magclaw.example/s/server-route/share'),
    { ...deps, currentActor: () => ({ member: { workspaceId: 'ws_other', humanId: 'hum_other' } }) },
  ), true);
  assert.equal(scopedWrongServerIndex.statusCode, 403);
});

test('team sharing route serves a dynamic context html page without creating static files', async () => {
  const deps = routeDeps({ readJson: async () => syncBody() });
  await handleTeamSharingApi(
    { method: 'POST' },
    makeResponse(),
    new URL('http://local/api/team-sharing/sync'),
    deps,
  );
  const res = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET' },
    res,
    new URL('http://local/team-sharing/context/sess_route?anchorEventId=evt_2&vectorDocumentId=vec_1&queryId=tmq_1'),
    deps,
  ), true);

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /text\/html/);
  assert.match(res.body, /MagClaw Team Sharing Context/);
  assert.match(res.body, /\/api\/team-sharing\/context\/sess_route/);
  assert.match(res.body, /\/api\/team-sharing\/feedback/);
  assert.match(res.body, /const workspaceId = "ws_route";/);
  assert.match(res.body, /const serverSlug = "";/);
  assert.match(res.body, /params\.set\('workspaceId', workspaceId\)/);
  assert.match(res.body, /teamSharingScopeQuery\('&'\)/);
  assert.match(res.body, /\/api\/team-sharing\/feedback' \+ teamSharingScopeQuery\('\?'\)/);
  assert.match(res.body, /load_more/);
  assert.match(res.body, /load\('next', \{ force: true \}\)/);
  assert.match(res.body, /No newer context yet\. Try again after hooks sync\./);
  assert.match(res.body, /vec_1/);
  assert.match(res.body, /oldest first/);
  assert.match(res.body, /Load previous/);
  assert.match(res.body, /Load next/);
  assert.match(res.body, /order=' \+ encodeURIComponent\(order\)/);
  assert.match(res.body, /limit=21/);
  assert.match(res.body, /chinaTime/);
  assert.match(res.body, /runtimeName/);
  assert.match(res.body, /context-quote/);
  assert.match(res.body, /eventSegments/);
  assert.match(res.body, /contentSegments/);
  assert.match(res.body, /context-event-user/);
  assert.match(res.body, /article\.context-event-user/);
  assert.match(res.body, /background:#fff1f5/);
  assert.match(res.body, /function stripContextMetadata/);
  assert.match(res.body, /function renderContextMarkdown/);
  assert.match(res.body, /renderContextMarkdown\(text\)/);
  assert.match(res.body, /oai-mem-citation/);
  assert.match(res.body, /load-more-prev/);
  assert.match(res.body, /load-more-next/);
  assert.match(res.body, /top-sentinel/);
  assert.match(res.body, /bottom-sentinel/);
  assert.match(res.body, /IntersectionObserver/);
  assert.match(res.body, /preserveScrollForPrepend/);
  assert.match(res.body, /scrollToInitialAnchor/);
  assert.match(res.body, /checkScrollEdges/);
  assert.match(res.body, /addEventListener\('scroll', scheduleScrollCheck/);
  assert.match(res.body, /trailingUrlChars/);
  assert.match(res.body, /String\.fromCharCode\(96\)/);
  assert.match(res.body, /function setContextButtonVisible/);
  assert.match(res.body, /CONTEXT_LINK_ICON_REGISTRY/);

  const scopedRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET' },
    scopedRes,
    new URL('http://local/s/server-route/team-sharing/context/sess_route?anchorEventId=evt_2&vectorDocumentId=vec_1&queryId=tmq_1'),
    deps,
  ), true);
  assert.equal(scopedRes.statusCode, 200);
  assert.match(scopedRes.body, /MagClaw Team Sharing Context/);
  assert.match(scopedRes.body, /\/api\/team-sharing\/context\/sess_route/);
  assert.match(scopedRes.body, /const workspaceId = "ws_route";/);
  assert.match(scopedRes.body, /const serverSlug = "server-route";/);
  assert.match(scopedRes.body, /params\.set\('serverSlug', serverSlug\)/);
});

test('team sharing common link icon registry covers at least 100 common sites', () => {
  assert.ok(TEAM_SHARING_COMMON_LINK_ICONS.length >= 100);
  const byHost = new Map();
  for (const entry of TEAM_SHARING_COMMON_LINK_ICONS) {
    assert.ok(entry.name, 'missing name');
    assert.ok(entry.slug || entry.iconHost, `missing icon source for ${entry.name}`);
    assert.ok(entry.label, `missing label for ${entry.name}`);
    assert.ok(Array.isArray(entry.hosts) && entry.hosts.length, `missing hosts for ${entry.name}`);
    for (const host of entry.hosts) byHost.set(host, entry);
  }
  assert.equal(byHost.get('github.com')?.slug, 'github');
  assert.equal(byHost.get('cloudflare.com')?.slug, 'cloudflare');
  assert.equal(byHost.get('openai.com')?.iconHost, 'openai.com');
  assert.equal(byHost.get('bilibili.com')?.slug, 'bilibili');
  assert.equal(byHost.get('figma.com')?.slug, 'figma');
});

test('team sharing context page renders Codex markdown and hides citation metadata', async () => {
  const deps = routeDeps({ readJson: async () => syncBody() });
  await handleTeamSharingApi(
    { method: 'POST' },
    makeResponse(),
    new URL('http://local/api/team-sharing/sync'),
    deps,
  );
  const res = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET' },
    res,
    new URL('http://local/team-sharing/context/sess_route?anchorEventId=evt_2'),
    deps,
  ), true);
  const context = createContextPageHarness(res.body);
  const html = context.renderContextMarkdown([
    '**验收通过**',
    '',
    'R150 已部署到测试环境。',
    '',
    '线上验收结果：',
    '- `/api/readyz` 返回 200。',
    '- 登录态正常。',
    '',
    '| 问题 | 当前结论 |',
    '|---|---|',
    '| NPM 安装后有没有 `team-sharing` 命令 | **会有。** [包](https://www.npmjs.com/package/@magclaw/team-sharing) 已声明 bin。 |',
    '| Hooks 是否项目本地 | 应默认项目级。 |',
    '',
    'GitHub 链接是：[multica-ai/multica at a9f0739b5](https://github.com/multica-ai/multica/tree/a9f0739b5)。',
    'Cloudflare 文档：[Workers](https://developers.cloudflare.com/workers/)。',
    'Bilibili 视频：[演示](https://www.bilibili.com/video/BV1xx)。',
    '',
    'Sources: [OpenAI Codex manual](https://developers.openai.com/codex/codex-manual.md), [Claude Code hooks](https://code.claude.com/docs/en/hooks).',
    '',
    '::git-stage{cwd="/Users/tt/code/myproject/magclaw"}',
    '::git-commit{cwd="/Users/tt/code/myproject/magclaw"}',
    '::git-push{cwd="/Users/tt/code/myproject/magclaw" branch="main"}',
    '',
    '<oai-mem-citation>',
    '<citation_entries>',
    'MEMORY.md:1-2|note=[internal]',
    '</citation_entries>',
    '</oai-mem-citation>',
  ].join('\n'));

  assert.match(html, /<strong>验收通过<\/strong>/);
  assert.match(html, /<p>R150 已部署到测试环境。<\/p>/);
  assert.match(html, /<ul><li><code>\/api\/readyz<\/code> 返回 200。<\/li><li>登录态正常。<\/li><\/ul>/);
  assert.match(html, /<div class="context-table-wrap"><table class="context-table">/);
  assert.match(html, /<th>问题<\/th>/);
  assert.match(html, /<td>NPM 安装后有没有 <code>team-sharing<\/code> 命令<\/td>/);
  assert.match(html, /<td><strong>会有。<\/strong> <a href="https:\/\/www\.npmjs\.com\/package\/@magclaw\/team-sharing"/);
  assert.match(html, /<a href="https:\/\/github\.com\/multica-ai\/multica\/tree\/a9f0739b5"[^>]*><span class="context-link-icon" title="GitHub"[^>]*><img class="context-link-icon-img" src="https:\/\/cdn\.simpleicons\.org\/github"/);
  assert.match(html, /<a href="https:\/\/developers\.cloudflare\.com\/workers\/"[^>]*><span class="context-link-icon" title="Cloudflare"[^>]*><img class="context-link-icon-img" src="https:\/\/cdn\.simpleicons\.org\/cloudflare"/);
  assert.match(html, /<a href="https:\/\/www\.bilibili\.com\/video\/BV1xx"[^>]*><span class="context-link-icon" title="Bilibili"[^>]*><img class="context-link-icon-img" src="https:\/\/cdn\.simpleicons\.org\/bilibili"/);
  assert.doesNotMatch(html, /\|---\|---\|/);
  assert.match(html, /<p class="context-sources"><span class="context-sources-label">Sources<\/span>/);
  assert.match(html, /class="context-source-link" href="https:\/\/developers\.openai\.com\/codex\/codex-manual\.md"/);
  assert.match(html, /class="context-source-link" href="https:\/\/code\.claude\.com\/docs\/en\/hooks"/);
  assert.doesNotMatch(html, /oai-mem-citation|citation_entries|MEMORY\.md|::git-stage|::git-commit|::git-push/);
});

test('team sharing context page hides pagination controls until more context exists', async () => {
  const deps = routeDeps({ readJson: async () => syncBody() });
  await handleTeamSharingApi(
    { method: 'POST' },
    makeResponse(),
    new URL('http://local/api/team-sharing/sync'),
    deps,
  );
  const res = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET' },
    res,
    new URL('http://local/team-sharing/context/sess_route?anchorEventId=evt_2'),
    deps,
  ), true);

  const withoutMore = createContextPageHarness(res.body, {
    fetch: async () => ({
      json: async () => ({
        ok: true,
        session: { title: 'No more context' },
        events: [{ eventId: 'evt_2', role: 'assistant', displayText: '第二条', createdAt: '2026-06-01T09:59:00.000Z' }],
        pagination: { hasPrev: false, hasNext: false, prevAnchorEventId: 'evt_2', nextAnchorEventId: 'evt_2' },
      }),
    }),
  });
  await withoutMore.__flush();
  assert.equal(withoutMore.__elements.get('load-more-prev').hidden, true);
  assert.equal(withoutMore.__elements.get('load-more-next').hidden, true);

  const withPreviousOnly = createContextPageHarness(res.body, {
    fetch: async () => ({
      json: async () => ({
        ok: true,
        session: { title: 'Has previous context' },
        events: [{ eventId: 'evt_2', role: 'assistant', displayText: '第二条', createdAt: '2026-06-01T09:59:00.000Z' }],
        pagination: { hasPrev: true, hasNext: false, prevAnchorEventId: 'evt_2', nextAnchorEventId: 'evt_2' },
      }),
    }),
  });
  await withPreviousOnly.__flush();
  assert.equal(withPreviousOnly.__elements.get('load-more-prev').hidden, false);
  assert.equal(withPreviousOnly.__elements.get('load-more-next').hidden, true);
});

test('team sharing context page redirects unauthenticated browsers to login with returnTo', async () => {
  const deps = routeDeps({
    currentActor: () => null,
    teamSharingAuthRequired: () => true,
    validTeamSharingToken: () => false,
  });
  deps.state.teamSharing.sessions.sess_route = {
    sessionId: 'sess_route',
    workspaceId: 'ws_route',
    title: '验收会话总结共享',
  };
  const res = makeResponse();

  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: {} },
    res,
    new URL('https://magclaw.example/team-sharing/context/sess_route?anchorEventId=evt_1&limit=21&order=asc'),
    deps,
  ), true);

  assert.equal(res.statusCode, 302);
  assert.match(decodeURIComponent(res.headers.location), /returnTo=\/team-sharing\/context\/sess_route\?anchorEventId=evt_1&limit=21&order=asc/);
});
