import assert from 'node:assert/strict';
import test from 'node:test';

import { handleTeamSharingApi } from '../server/api/team-sharing-routes.js';
import { createInitialTeamSharingState } from '../server/team-sharing.js';

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
        text: '结论：先 Zilliz 召回，再 rerank，打开原文后写 feedback。',
        createdAt: '2026-06-01T09:59:00.000Z',
      },
    ],
  };
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
  assert.match(searchRes.data.results[0].contextUrl, /\/team-sharing\/context\/sess_route/);
  assert.match(searchRes.data.results[0].contextUrl, /anchorEventId=evt_1/);
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
  assert.ok(workspaceRes.data.tree.some((entry) => entry.path === 'activities.json'));
  assert.ok(workspaceRes.data.tree.some((entry) => entry.path === 'topics/rerank-feedback.md'));
  assert.equal(workspaceRes.data.tree.some((entry) => entry.path === 'details/original-context.md'), false);
  const abstractFile = workspaceRes.data.files.find((file) => file.path === 'abstract.md');
  assert.match(abstractFile.content, /L0 Abstract/);
  assert.match(abstractFile.content, /topics\/rerank-feedback\.md/);
  const activityFile = workspaceRes.data.files.find((file) => file.path === 'activities.json');
  const activities = JSON.parse(activityFile.content);
  assert.equal(activityFile.previewKind, 'json');
  assert.equal(activities[0].action, 'merge_summary');
  assert.ok(activities[0].changedPaths.includes('abstract.md'));
  const topicFile = workspaceRes.data.files.find((file) => file.path === 'topics/rerank-feedback.md');
  assert.match(topicFile.content, /主题概览/);
  assert.match(topicFile.content, /Source Anchors/);

  const deniedRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: {} },
    deniedRes,
    new URL('http://local/api/team-sharing/workspace/sess_route'),
    { ...deps, currentActor: () => ({ member: { workspaceId: 'ws_other', humanId: 'hum_other' } }) },
  ), true);
  assert.equal(deniedRes.statusCode, 403);
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
  assert.equal(rejectedIndex.statusCode, 401);

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
  const deps = routeDeps();
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
  assert.match(res.body, /load_more/);
  assert.match(res.body, /vec_1/);
  assert.match(res.body, /newest first/);
  assert.match(res.body, /Load newer/);
  assert.match(res.body, /Load older/);
  assert.match(res.body, /order=' \+ encodeURIComponent\(order\)/);
  assert.match(res.body, /load-more-prev/);
  assert.match(res.body, /load-more-next/);
});
