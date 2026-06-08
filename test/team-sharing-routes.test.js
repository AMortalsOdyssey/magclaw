import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Writable } from 'node:stream';
import test from 'node:test';
import vm from 'node:vm';

import { handleTeamSharingApi } from '../server/api/team-sharing-routes.js';
import { createInitialTeamSharingState } from '../server/team-sharing.js';
import { TEAM_SHARING_COMMON_LINK_ICONS } from '../server/team-sharing-link-icons.js';
import { buildChannelImportPath } from '../server/integrations/feishu-connect/route-token.js';

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

function makeStreamResponse() {
  const chunks = [];
  const res = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(Buffer.from(chunk));
      callback();
    },
  });
  res.statusCode = null;
  res.headers = {};
  res.body = '';
  res.setHeader = function setHeader(name, value) {
    this.headers[String(name).toLowerCase()] = value;
  };
  res.writeHead = function writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value);
  };
  res.end = function end(body = '') {
    if (body) chunks.push(Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
    Writable.prototype.end.call(this);
  };
  res.bodyBuffer = () => Buffer.concat(chunks);
  return res;
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
    { method: 'POST', headers: { host: 'magclaw.example', 'x-forwarded-proto': 'https' } },
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
  assert.match(searchRes.data.results[0].contextWebUrl, /^https:\/\/magclaw\.example\/s\/server-route\/team-sharing\/context\/sess_route/);
  assert.match(searchRes.data.results[0].contextWebUrl, /anchorEventId=evt_1/);
  assert.equal(searchRes.data.results[0].contextPageUrl, searchRes.data.results[0].contextWebUrl);
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
  const fingerprint = 'mfp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const deps = routeDeps({
    currentActor: () => ({ member: { workspaceId: 'ws_route', humanId: 'hum_route', email: 'team@example.com' } }),
    readJson: async () => ({ machineFingerprint: fingerprint }),
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
    readJson: async () => ({ deviceCode: startRes.data.deviceCode, machineFingerprint: fingerprint }),
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
  assert.match(tokenRes.data.tokenExpiresAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(JSON.stringify(deps.state.teamSharing).includes(tokenRes.data.token), false);
  const tokenRecord = Object.values(deps.state.teamSharing.auth.tokens)[0];
  assert.equal(tokenRecord.machineFingerprint, fingerprint);
  assert.ok(Date.parse(tokenRecord.expiresAt) > Date.now() + 29 * 24 * 60 * 60 * 1000);

  const whoamiRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: { authorization: `Bearer ${tokenRes.data.token}`, 'x-magclaw-machine-fingerprint': fingerprint } },
    whoamiRes,
    new URL('http://local/api/team-sharing/auth/whoami'),
    { ...deps, currentActor: () => null },
  ), true);
  assert.equal(whoamiRes.statusCode, 200);
  assert.equal(whoamiRes.data.user.email, 'team@example.com');

  const syncRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'POST', headers: { authorization: `Bearer ${tokenRes.data.token}`, 'x-magclaw-machine-fingerprint': fingerprint } },
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
  const syncedMessage = deps.state.messages.find((message) => message.metadata?.teamSharing?.sessionId === 'sess_route');
  const syncedHumanReply = deps.state.replies.find((reply) => reply.metadata?.teamSharing?.eventId === 'evt_1');
  assert.equal(syncedMessage?.authorId, 'hum_route');
  assert.equal(syncedMessage?.metadata?.teamSharing?.uploader?.id, 'hum_route');
  assert.equal(syncedHumanReply?.authorId, 'hum_route');
  assert.equal(syncedHumanReply?.metadata?.teamSharing?.uploader?.id, 'hum_route');

  const revokeRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'POST', headers: { authorization: `Bearer ${tokenRes.data.token}`, 'x-magclaw-machine-fingerprint': fingerprint } },
    revokeRes,
    new URL('http://local/api/team-sharing/auth/revoke'),
    { ...deps, currentActor: () => null },
  ), true);
  assert.equal(revokeRes.statusCode, 200);
  assert.equal(revokeRes.data.revoked, true);

  const rejectedAfterRevoke = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'POST', headers: { authorization: `Bearer ${tokenRes.data.token}`, 'x-magclaw-machine-fingerprint': fingerprint } },
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

test('team sharing scoped token rejects machine mismatch and expiration', async () => {
  const fingerprint = 'mfp_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const deps = routeDeps({
    currentActor: () => ({ member: { workspaceId: 'ws_route', humanId: 'hum_route', email: 'team@example.com' } }),
    readJson: async () => ({ machineFingerprint: fingerprint }),
  });
  const startRes = makeResponse();
  await handleTeamSharingApi(
    { method: 'POST' },
    startRes,
    new URL('http://local/api/team-sharing/auth/start'),
    deps,
  );
  const tokenRes = makeResponse();
  await handleTeamSharingApi(
    { method: 'POST' },
    tokenRes,
    new URL('http://local/api/team-sharing/auth/token'),
    {
      ...deps,
      currentActor: () => null,
      readJson: async () => ({ deviceCode: startRes.data.deviceCode, machineFingerprint: fingerprint }),
    },
  );

  const mismatch = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: { authorization: `Bearer ${tokenRes.data.token}`, 'x-magclaw-machine-fingerprint': 'mfp_cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' } },
    mismatch,
    new URL('http://local/api/team-sharing/auth/whoami'),
    { ...deps, currentActor: () => null },
  ), true);
  assert.equal(mismatch.statusCode, 401);

  Object.values(deps.state.teamSharing.auth.tokens)[0].expiresAt = '2000-01-01T00:00:00.000Z';
  const expired = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: { authorization: `Bearer ${tokenRes.data.token}`, 'x-magclaw-machine-fingerprint': fingerprint } },
    expired,
    new URL('http://local/api/team-sharing/auth/whoami'),
    { ...deps, currentActor: () => null },
  ), true);
  assert.equal(expired.statusCode, 401);
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
  assert.match(approveRes.headers['content-type'], /text\/html/);
  assert.match(approveRes.body, /<title>Team Sharing login successful<\/title>/);
  assert.match(approveRes.body, /<div class="status">Successful<\/div>/);
  assert.match(approveRes.body, /<h1 id="team-sharing-auth-title">Team Sharing login successful<\/h1>/);
  assert.match(approveRes.body, /place-items: center/);
  assert.match(approveRes.body, /\/brand\/magclaw-logo\.png/);
  assert.doesNotMatch(approveRes.body, /<body>\s*<p>/);

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

test('team sharing setup approval auto-joins a logged-in user to the target server and channel', async () => {
  const fingerprint = 'mfp_dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
  const routeKey = 'mcch_auto_join_route_key';
  const user = { id: 'usr_new', email: 'new@example.com', name: 'New User', avatarUrl: 'https://avatar.example/new.png' };
  const upserts = [];
  const deps = routeDeps({
    currentActor: () => null,
    currentUser: () => user,
    upsertChannelMember: async (record) => upserts.push(record),
  });
  deps.state.cloud.users = [user];
  deps.state.cloud.workspaceMembers = [];
  deps.state.channels = [{
    id: 'chan_team',
    workspaceId: 'ws_route',
    name: 'team-sharing',
    memberIds: [],
    humanIds: [],
    metadata: { integrations: { feishuImport: { routeKey } } },
  }];
  deps.currentActor = (req = {}) => {
    const workspaceId = req.headers?.['x-magclaw-workspace-id'];
    const member = deps.state.cloud.workspaceMembers.find((item) => (
      item.workspaceId === workspaceId
      && item.userId === user.id
      && item.status === 'active'
    ));
    return member ? { user, member } : null;
  };
  const channelPath = buildChannelImportPath({ serverId: 'ws_route', channelId: 'chan_team', routeKey });
  const startRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.1' } },
    startRes,
    new URL('http://local/api/team-sharing/auth/start'),
    {
      ...deps,
      readJson: async () => ({
        workspaceId: 'ws_route',
        profile: 'default',
        packageName: '@magclaw/team-sharing',
        machineFingerprint: fingerprint,
        channelPath,
        client: { hostname: 'setup-host.local', platform: 'darwin', arch: 'arm64' },
      }),
    },
  ), true);
  assert.equal(startRes.statusCode, 201);
  assert.equal(startRes.data.status, 'pending');

  const approveRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: { host: 'magclaw.test', 'x-forwarded-proto': 'https' } },
    approveRes,
    new URL(`http://local${startRes.data.verificationUri}`),
    deps,
  ), true);
  assert.equal(approveRes.statusCode, 200);
  assert.match(approveRes.body, /https:\/\/magclaw\.test\/s\/server-route\/channels\/chan_team/);

  const human = deps.state.humans.find((item) => item.authUserId === user.id);
  const member = deps.state.cloud.workspaceMembers.find((item) => item.userId === user.id && item.workspaceId === 'ws_route');
  assert.equal(member?.role, 'member');
  assert.equal(member?.humanId, human?.id);
  assert.equal(deps.state.channels.find((item) => item.id === 'chan_team')?.memberIds.includes(human.id), true);
  assert.equal(deps.state.channels.find((item) => item.name === 'all')?.memberIds.includes(human.id), true);
  assert.ok(upserts.some((item) => item.channelId === 'chan_team' && item.humanId === human.id));
  assert.ok(deps.events.some((event) => event.type === 'team_sharing_setup_auto_joined'));
  assert.doesNotMatch(JSON.stringify(deps.events), new RegExp(routeKey));

  const tokenRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'POST' },
    tokenRes,
    new URL('http://local/api/team-sharing/auth/token'),
    {
      ...deps,
      currentActor: () => null,
      readJson: async () => ({ deviceCode: startRes.data.deviceCode, machineFingerprint: fingerprint }),
    },
  ), true);
  assert.equal(tokenRes.statusCode, 200);
  assert.equal(tokenRes.data.status, 'approved');
  assert.equal(tokenRes.data.user.email, 'new@example.com');
  assert.equal(tokenRes.data.onboardingTarget.joinedServer, true);
  assert.equal(tokenRes.data.onboardingTarget.joinedChannel, true);
  assert.equal(tokenRes.data.onboardingTarget.channelName, 'team-sharing');
  assert.equal(tokenRes.data.onboardingTarget.channelUrl, 'https://magclaw.test/s/server-route/channels/chan_team');
});

test('team sharing setup approval rejects leaked or stale channel paths before joining', async () => {
  const routeKey = 'mcch_real_route_key';
  const user = { id: 'usr_leaked', email: 'leaked@example.com', name: 'Leaked User' };
  const deps = routeDeps({
    currentActor: () => null,
    currentUser: () => user,
  });
  deps.state.cloud.users = [user];
  deps.state.cloud.workspaceMembers = [];
  deps.state.channels = [{
    id: 'chan_team',
    workspaceId: 'ws_route',
    name: 'team-sharing',
    memberIds: [],
    humanIds: [],
    metadata: { integrations: { feishuImport: { routeKey } } },
  }];
  const stalePath = buildChannelImportPath({ serverId: 'ws_route', channelId: 'chan_team', routeKey: 'mcch_wrong_route_key' });
  const startRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.2' } },
    startRes,
    new URL('http://local/api/team-sharing/auth/start'),
    {
      ...deps,
      readJson: async () => ({
        workspaceId: 'ws_route',
        profile: 'default',
        packageName: '@magclaw/team-sharing',
        channelPath: stalePath,
      }),
    },
  ), true);

  const approveRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: { host: 'magclaw.test' } },
    approveRes,
    new URL(`http://local${startRes.data.verificationUri}`),
    deps,
  ), true);
  assert.equal(approveRes.statusCode, 403);
  assert.equal(deps.state.cloud.workspaceMembers.length, 0);
  assert.equal(deps.state.channels[0].memberIds.length, 0);
});

test('team sharing setup approval rejects archived target channels before joining', async () => {
  const routeKey = 'mcch_archived_route_key';
  const user = { id: 'usr_archived', email: 'archived@example.com', name: 'Archived User' };
  const deps = routeDeps({
    currentActor: () => null,
    currentUser: () => user,
  });
  deps.state.cloud.users = [user];
  deps.state.cloud.workspaceMembers = [];
  deps.state.channels = [{
    id: 'chan_archived',
    workspaceId: 'ws_route',
    name: 'archived',
    archived: true,
    memberIds: [],
    humanIds: [],
    metadata: { integrations: { feishuImport: { routeKey } } },
  }];
  const channelPath = buildChannelImportPath({ serverId: 'ws_route', channelId: 'chan_archived', routeKey });
  const startRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'POST', headers: {}, socket: { remoteAddress: '127.0.0.3' } },
    startRes,
    new URL('http://local/api/team-sharing/auth/start'),
    {
      ...deps,
      readJson: async () => ({
        workspaceId: 'ws_route',
        profile: 'default',
        packageName: '@magclaw/team-sharing',
        channelPath,
      }),
    },
  ), true);

  const approveRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: { host: 'magclaw.test' } },
    approveRes,
    new URL(`http://local${startRes.data.verificationUri}`),
    deps,
  ), true);
  assert.equal(approveRes.statusCode, 400);
  assert.equal(deps.state.cloud.workspaceMembers.length, 0);
  assert.equal(deps.state.channels[0].memberIds.length, 0);
});

test('team sharing auth approval redirects unauthenticated browsers with returnTo', async () => {
  const deps = routeDeps({
    currentActor: () => null,
    readJson: async () => ({
      workspaceId: 'ws_route',
      profile: 'default',
      packageName: '@magclaw/team-sharing',
      machineFingerprint: 'mfp_dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    }),
  });
  const startRes = makeResponse();
  await handleTeamSharingApi(
    { method: 'POST' },
    startRes,
    new URL('http://local/api/team-sharing/auth/start'),
    deps,
  );

  const approveRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: {} },
    approveRes,
    new URL(`http://local${startRes.data.verificationUri}`),
    deps,
  ), true);

  assert.equal(approveRes.statusCode, 302);
  assert.match(decodeURIComponent(approveRes.headers.location), /returnTo=\/team-sharing\/auth\/approve\?user_code=/);
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
    { method: 'GET', headers: { host: 'magclaw.example', 'x-forwarded-proto': 'https' } },
    contextRes,
    new URL('http://local/api/team-sharing/context/sess_route?anchorEventId=evt_1&direction=next&limit=1'),
    deps,
  ), true);
  assert.equal(contextRes.statusCode, 200);
  assert.deepEqual(contextRes.data.events.map((event) => event.eventId), ['evt_2']);
  assert.match(contextRes.data.session.summaryHint, /Zilliz/);
  assert.equal(contextRes.data.contextUrl, '/team-sharing/context/sess_route?anchorEventId=evt_1&limit=1&order=asc');
  assert.equal(contextRes.data.contextWebUrl, 'https://magclaw.example/s/server-route/team-sharing/context/sess_route?anchorEventId=evt_1&limit=1&order=asc');
  assert.equal(contextRes.data.contextPageUrl, contextRes.data.contextWebUrl);
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

test('team sharing route creates an authenticated share and protects it by workspace', async () => {
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
  const rejectedShare = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: {} },
    rejectedShare,
    new URL(`https://magclaw.example/s/${shareId}`),
    { ...deps, currentActor: () => null, teamSharingAuthRequired: () => true },
  ), true);

  assert.equal(rejectedShare.statusCode, 302);
  assert.match(decodeURIComponent(rejectedShare.headers.location), new RegExp(`returnTo=/s/${shareId}`));

  const wrongServerShare = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: {} },
    wrongServerShare,
    new URL(`https://magclaw.example/s/${shareId}`),
    { ...deps, currentActor: () => ({ member: { workspaceId: 'ws_other', humanId: 'hum_other' } }) },
  ), true);
  assert.equal(wrongServerShare.statusCode, 403);

  const joinRedirectShare = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: {} },
    joinRedirectShare,
    new URL(`https://magclaw.example/s/${shareId}`),
    {
      ...deps,
      currentActor: () => null,
      currentUser: () => ({ id: 'usr_guest', email: 'guest@example.com', name: 'Guest' }),
    },
  ), true);
  assert.equal(joinRedirectShare.statusCode, 302);
  assert.match(joinRedirectShare.headers.location, /^\/join\/mc_join_/);
  assert.match(decodeURIComponent(joinRedirectShare.headers.location), new RegExp(`returnTo=/s/${shareId}`));
  assert.equal(deps.state.cloud.joinLinks.length, 1);
  assert.equal(deps.state.cloud.joinLinks[0].workspaceId, 'ws_route');
  assert.equal(deps.state.cloud.joinLinks[0].maxUses, 1);
  assert.equal(deps.state.cloud.joinLinks[0].createdBy, 'usr_guest');
  assert.equal(deps.state.cloud.joinLinks[0].metadata.purpose, 'team_sharing_access');
  assert.equal(deps.state.cloud.joinLinks[0].metadata.boundUserId, 'usr_guest');

  const shareRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: {} },
    shareRes,
    new URL(`https://magclaw.example/s/${shareId}`),
    deps,
  ), true);

  assert.equal(shareRes.statusCode, 200);
  assert.match(shareRes.headers['content-type'], /text\/html/);
  assert.match(shareRes.headers['content-security-policy'], /sandbox/);
  assert.match(shareRes.body, /Team Shares/);
  assert.match(shareRes.body, /<h1>Rerank 方案摘要<\/h1>/);
  assert.match(shareRes.body, /团队结论/);
  assert.match(shareRes.body, /Created by Ada PM/);
  assert.match(shareRes.body, /2026年06月01日 18:00:00/);

  const fingerprint = `mfp_${'a'.repeat(64)}`;
  const authStart = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'POST' },
    authStart,
    new URL('https://magclaw.example/api/team-sharing/auth/start'),
    {
      ...deps,
      readJson: async () => ({ machineFingerprint: fingerprint }),
    },
  ), true);
  const authToken = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'POST' },
    authToken,
    new URL('https://magclaw.example/api/team-sharing/auth/token'),
    {
      ...deps,
      currentActor: () => null,
      readJson: async () => ({ deviceCode: authStart.data.deviceCode, machineFingerprint: fingerprint }),
    },
  ), true);
  const apiRead = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: { authorization: `Bearer ${authToken.data.token}`, 'x-magclaw-machine-fingerprint': fingerprint, host: 'magclaw.example', 'x-forwarded-proto': 'https' } },
    apiRead,
    new URL(`https://magclaw.example/api/team-sharing/shares/${shareId}`),
    { ...deps, currentActor: () => null },
  ), true);
  assert.equal(apiRead.statusCode, 200);
  assert.equal(apiRead.data.kind, 'share');
  assert.equal(apiRead.data.shareId, shareId);
  assert.equal(apiRead.data.title, 'Rerank 方案摘要');
  assert.equal(apiRead.data.contentType, 'markdown');
  assert.match(apiRead.data.content, /团队结论/);
  assert.equal(apiRead.data.creator.name, 'Ada PM');
  assert.equal(apiRead.data.url, `https://magclaw.example/s/${shareId}`);
  assert.equal(apiRead.data.source, undefined);
  assert.doesNotMatch(JSON.stringify(apiRead.data), /rawToken|tokenHash|metadata/i);

  const apiNoToken = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: {} },
    apiNoToken,
    new URL(`https://magclaw.example/api/team-sharing/shares/${shareId}`),
    { ...deps, currentActor: () => null },
  ), true);
  assert.equal(apiNoToken.statusCode, 401);
  assert.equal(apiNoToken.data.reason, 'login_required');

  const apiMismatch = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: { authorization: `Bearer ${authToken.data.token}`, 'x-magclaw-machine-fingerprint': `mfp_${'b'.repeat(64)}` } },
    apiMismatch,
    new URL(`https://magclaw.example/api/team-sharing/shares/${shareId}`),
    { ...deps, currentActor: () => null },
  ), true);
  assert.equal(apiMismatch.statusCode, 401);
  assert.equal(apiMismatch.data.reason, 'login_required');

  const tokenRecord = Object.values(deps.state.teamSharing.auth.tokens)[0];
  tokenRecord.expiresAt = '2000-01-01T00:00:00.000Z';
  const apiExpired = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: { authorization: `Bearer ${authToken.data.token}`, 'x-magclaw-machine-fingerprint': fingerprint } },
    apiExpired,
    new URL(`https://magclaw.example/api/team-sharing/shares/${shareId}`),
    { ...deps, currentActor: () => null },
  ), true);
  assert.equal(apiExpired.statusCode, 401);

  tokenRecord.expiresAt = '2099-01-01T00:00:00.000Z';
  tokenRecord.revoked = true;
  const apiRevoked = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: { authorization: `Bearer ${authToken.data.token}`, 'x-magclaw-machine-fingerprint': fingerprint } },
    apiRevoked,
    new URL(`https://magclaw.example/api/team-sharing/shares/${shareId}`),
    { ...deps, currentActor: () => null },
  ), true);
  assert.equal(apiRevoked.statusCode, 401);

  tokenRecord.revoked = false;
  tokenRecord.workspaceId = 'ws_other';
  const apiWrongWorkspace = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: { authorization: `Bearer ${authToken.data.token}`, 'x-magclaw-machine-fingerprint': fingerprint } },
    apiWrongWorkspace,
    new URL(`https://magclaw.example/api/team-sharing/shares/${shareId}`),
    { ...deps, currentActor: () => null },
  ), true);
  assert.equal(apiWrongWorkspace.statusCode, 403);
  assert.equal(apiWrongWorkspace.data.reason, 'server_membership_required');

  tokenRecord.workspaceId = 'ws_route';
  const apiMissing = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: { authorization: `Bearer ${authToken.data.token}`, 'x-magclaw-machine-fingerprint': fingerprint } },
    apiMissing,
    new URL('https://magclaw.example/api/team-sharing/shares/share_missing'),
    { ...deps, currentActor: () => null },
  ), true);
  assert.equal(apiMissing.statusCode, 404);
  assert.equal(apiMissing.data.reason, 'not_found');

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

test('team sharing share assets are deduped, protected, and range-readable', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-assets-'));
  const saveAttachmentBuffer = async ({ name, type, buffer, source, extra = {} }) => {
    const id = `att_${extra.createdBy || 'asset'}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
    const storageKey = `2026/06/${id}-${name}`;
    const filePath = path.join(tmp, storageKey);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, buffer);
    return {
      id,
      name,
      type,
      bytes: buffer.length,
      path: filePath,
      storageKey,
      relativePath: storageKey,
      storageMode: 'pvc',
      checksumSha256: 'stored-by-test',
      source,
      createdAt: '2026-06-01T10:00:00.000Z',
      ...extra,
    };
  };
  const videoBytes = Buffer.concat([
    Buffer.from('video-start-'),
    Buffer.alloc(70 * 1024, 7),
    Buffer.from('-video-end'),
  ]);
  const dataUrl = `data:video/mp4;base64,${videoBytes.toString('base64')}`;
  const html = `<!doctype html><html><body><section id="demo"><h2>演示</h2><video src="${dataUrl}"></video></section></body></html>`;
  const deps = routeDeps({
    saveAttachmentBuffer,
    attachmentStorageDir: tmp,
    currentActor: () => ({ member: { workspaceId: 'ws_route', humanId: 'hum_creator', role: 'owner', name: 'Creator' } }),
    readJson: async () => ({
      title: '含视频分享',
      contentType: 'html',
      content: html,
      workspaceId: 'ws_route',
    }),
  });

  const first = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'POST', headers: { host: 'magclaw.example', 'x-forwarded-proto': 'https' } },
    first,
    new URL('https://magclaw.example/api/team-sharing/shares'),
    deps,
  ), true);
  assert.equal(first.statusCode, 201);
  assert.equal(deps.state.teamSharing.assets.length, 1);
  assert.equal(deps.state.teamSharing.shareContents.length, 1);
  assert.equal(first.data.share.assetRefs.length, 1);
  assert.doesNotMatch(deps.state.teamSharing.shareContents[0].content, /data:video\/mp4;base64/);
  assert.match(deps.state.teamSharing.shareContents[0].content, /\/api\/team-sharing\/assets\/asset_/);

  const second = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'POST', headers: { host: 'magclaw.example', 'x-forwarded-proto': 'https' } },
    second,
    new URL('https://magclaw.example/api/team-sharing/shares'),
    deps,
  ), true);
  assert.equal(second.statusCode, 201);
  assert.equal(deps.state.teamSharing.assets.length, 1);
  assert.equal(second.data.share.assetRefs[0].id, first.data.share.assetRefs[0].id);

  const asset = deps.state.teamSharing.assets[0];
  const denied = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: {} },
    denied,
    new URL(`https://magclaw.example/api/team-sharing/assets/${asset.id}/${asset.filename}`),
    { ...deps, currentActor: () => null, teamSharingAuthRequired: () => true },
  ), true);
  assert.equal(denied.statusCode, 401);

  const rangeRes = makeStreamResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: { range: 'bytes=0-10' } },
    rangeRes,
    new URL(`https://magclaw.example/api/team-sharing/assets/${asset.id}/${asset.filename}`),
    deps,
  ), true);
  if (!rangeRes.writableFinished) await once(rangeRes, 'finish');
  assert.equal(rangeRes.statusCode, 206);
  assert.equal(rangeRes.headers['content-type'], 'video/mp4');
  assert.match(rangeRes.headers['cache-control'], /immutable/);
  assert.match(rangeRes.headers.etag, /"/);
  assert.equal(rangeRes.bodyBuffer().toString(), videoBytes.slice(0, 11).toString());

  const notModified = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: { 'if-none-match': rangeRes.headers.etag } },
    notModified,
    new URL(`https://magclaw.example/api/team-sharing/assets/${asset.id}/${asset.filename}`),
    deps,
  ), true);
  assert.equal(notModified.statusCode, 304);
});

test('team sharing share patch updates one section in place with creator/admin permissions', async () => {
  const html = [
    '<!doctype html><html><body>',
    '<nav><a id="toc-alpha" href="#alpha">Alpha</a><a id="toc-beta" href="#beta">Beta</a></nav>',
    '<section id="alpha"><h2>Alpha</h2><p>旧内容。</p></section>',
    '<section id="beta"><h2>Beta</h2><p>保持不变。</p></section>',
    '</body></html>',
  ].join('');
  const deps = routeDeps({
    currentActor: () => ({ member: { workspaceId: 'ws_route', humanId: 'hum_creator', role: 'member', name: 'Creator' } }),
    readJson: async () => ({
      title: '局部编辑分享',
      contentType: 'html',
      content: html,
      workspaceId: 'ws_route',
    }),
  });
  deps.state.cloud.workspaceMembers = [
    { workspaceId: 'ws_route', humanId: 'hum_creator', userId: 'usr_creator', role: 'member', status: 'active' },
    { workspaceId: 'ws_route', humanId: 'hum_member', userId: 'usr_member', role: 'member', status: 'active' },
    { workspaceId: 'ws_route', humanId: 'hum_owner', userId: 'usr_owner', role: 'owner', status: 'active' },
    { workspaceId: 'ws_route', humanId: 'hum_admin', userId: 'usr_admin', role: 'admin', status: 'active' },
  ];

  const created = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'POST', headers: { host: 'magclaw.example', 'x-forwarded-proto': 'https' } },
    created,
    new URL('https://magclaw.example/api/team-sharing/shares'),
    deps,
  ), true);
  const shareId = created.data.shareId;

  const sections = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: {} },
    sections,
    new URL(`https://magclaw.example/api/team-sharing/shares/${shareId}/sections`),
    deps,
  ), true);
  const alpha = sections.data.sections.find((section) => section.sectionId === 'alpha');
  const beta = sections.data.sections.find((section) => section.sectionId === 'beta');
  assert.ok(alpha);
  assert.ok(beta);

  const memberDenied = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'PATCH', headers: {}, url: `/api/team-sharing/shares/${shareId}` },
    memberDenied,
    new URL(`https://magclaw.example/api/team-sharing/shares/${shareId}`),
    {
      ...deps,
      currentActor: () => ({ member: { workspaceId: 'ws_route', humanId: 'hum_member', role: 'member' } }),
      readJson: async () => ({
        baseVersionId: sections.data.versionId,
        operations: [{ op: 'replace_section', sectionId: 'alpha', expectedHash: alpha.hash, content: '<section id="alpha"><h2>Alpha</h2><p>新内容。</p></section>' }],
      }),
    },
  ), true);
  assert.equal(memberDenied.statusCode, 403);
  assert.equal(memberDenied.data.reason, 'share_edit_forbidden');

  const ownerPatch = makeResponse();
  const patchBody = {
    baseVersionId: sections.data.versionId,
    operations: [
      { op: 'replace_section', sectionId: 'alpha', expectedHash: alpha.hash, content: '<section id="alpha"><h2>Alpha</h2><p>新内容。</p></section>' },
      { op: 'replace_selector_text', selector: '#toc-alpha', text: 'Alpha 新版' },
    ],
  };
  assert.equal(await handleTeamSharingApi(
    { method: 'PATCH', headers: { host: 'magclaw.example', 'x-forwarded-proto': 'https' }, url: `/api/team-sharing/shares/${shareId}` },
    ownerPatch,
    new URL(`https://magclaw.example/api/team-sharing/shares/${shareId}`),
    {
      ...deps,
      currentActor: () => ({ member: { workspaceId: 'ws_route', humanId: 'hum_owner', role: 'owner' } }),
      readJson: async () => patchBody,
    },
  ), true);
  assert.equal(ownerPatch.statusCode, 200);
  assert.equal(ownerPatch.data.url, `https://magclaw.example/s/${shareId}`);
  assert.notEqual(ownerPatch.data.versionId, sections.data.versionId);

  const after = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: {} },
    after,
    new URL(`https://magclaw.example/api/team-sharing/shares/${shareId}`),
    { ...deps, currentActor: () => ({ member: { workspaceId: 'ws_route', humanId: 'hum_admin', role: 'admin' } }) },
  ), true);
  assert.match(after.data.content, /Alpha 新版/);
  assert.match(after.data.content, /新内容/);
  assert.match(after.data.content, /保持不变/);
  const betaAfter = after.data.sections.find((section) => section.sectionId === 'beta');
  assert.equal(betaAfter.hash, beta.hash);
  assert.equal(deps.state.teamSharing.shares[0].versions.length, 2);

  const conflict = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'PATCH', headers: {}, url: `/api/team-sharing/shares/${shareId}` },
    conflict,
    new URL(`https://magclaw.example/api/team-sharing/shares/${shareId}`),
    {
      ...deps,
      currentActor: () => ({ member: { workspaceId: 'ws_route', humanId: 'hum_admin', role: 'admin' } }),
      readJson: async () => patchBody,
    },
  ), true);
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.data.reason, 'version_conflict');
});

test('team sharing share list and delete links are scoped and role gated', async () => {
  let nextBody = {};
  const deps = routeDeps({
    currentActor: () => ({ member: { workspaceId: 'ws_route', humanId: 'hum_creator', role: 'member', name: 'Creator' } }),
    readJson: async () => nextBody,
  });
  deps.state.cloud.workspaceMembers = [
    { workspaceId: 'ws_route', humanId: 'hum_creator', userId: 'usr_creator', role: 'member', status: 'active' },
    { workspaceId: 'ws_route', humanId: 'hum_member', userId: 'usr_member', role: 'member', status: 'active' },
    { workspaceId: 'ws_route', humanId: 'hum_admin', userId: 'usr_admin', role: 'admin', status: 'active' },
    { workspaceId: 'ws_route', humanId: 'hum_owner', userId: 'usr_owner', role: 'owner', status: 'active' },
  ];

  nextBody = {
    title: '需要保留的分享',
    description: '保留项描述',
    contentType: 'markdown',
    content: '# 需要保留的分享\n\n正文 A',
    workspaceId: 'ws_route',
    channelPath: 'testing/share-list',
  };
  const first = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'POST', headers: { host: 'magclaw.example', 'x-forwarded-proto': 'https' } },
    first,
    new URL('https://magclaw.example/api/team-sharing/shares'),
    deps,
  ), true);
  const firstShareId = first.data.shareId;

  nextBody = {
    title: '可以删除的分享',
    description: '删除项描述',
    contentType: 'markdown',
    content: '# 可以删除的分享\n\n正文 B',
    workspaceId: 'ws_route',
    channelPath: 'testing/share-list',
  };
  const second = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'POST', headers: { host: 'magclaw.example', 'x-forwarded-proto': 'https' } },
    second,
    new URL('https://magclaw.example/api/team-sharing/shares'),
    deps,
  ), true);
  const secondShareId = second.data.shareId;

  deps.state.teamSharing.shares.push({
    ...deps.state.teamSharing.shares[0],
    id: 'share_other_server',
    workspaceId: 'ws_other',
    title: 'Other server share',
  });

  const memberList = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: { host: 'magclaw.example', 'x-forwarded-proto': 'https' } },
    memberList,
    new URL('https://magclaw.example/api/team-sharing/shares?workspaceId=ws_route'),
    { ...deps, currentActor: () => ({ member: { workspaceId: 'ws_route', humanId: 'hum_member', role: 'member' } }) },
  ), true);
  assert.equal(memberList.statusCode, 200);
  assert.equal(memberList.data.kind, 'share_list');
  assert.equal(memberList.data.count, 2);
  assert.deepEqual(memberList.data.shares.map((share) => share.shareId).sort(), [firstShareId, secondShareId].sort());
  assert.equal(memberList.data.shares.every((share) => share.workspaceId === 'ws_route'), true);
  assert.equal(memberList.data.shares.every((share) => share.canEdit === false), true);
  assert.equal(memberList.data.shares.every((share) => share.content === undefined), true);
  assert.doesNotMatch(JSON.stringify(memberList.data), /正文 A|正文 B|Other server share/);

  const memberDelete = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'DELETE', headers: { host: 'magclaw.example', 'x-forwarded-proto': 'https' } },
    memberDelete,
    new URL(`https://magclaw.example/api/team-sharing/shares/${secondShareId}`),
    { ...deps, currentActor: () => ({ member: { workspaceId: 'ws_route', humanId: 'hum_member', role: 'member' } }) },
  ), true);
  assert.equal(memberDelete.statusCode, 403);
  assert.equal(memberDelete.data.reason, 'share_delete_forbidden');
  assert.equal(deps.state.teamSharing.shares.find((share) => share.id === secondShareId).revokedAt, undefined);

  const adminDelete = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'DELETE', headers: { host: 'magclaw.example', 'x-forwarded-proto': 'https' } },
    adminDelete,
    new URL(`https://magclaw.example/api/team-sharing/shares/${secondShareId}`),
    { ...deps, currentActor: () => ({ member: { workspaceId: 'ws_route', humanId: 'hum_admin', role: 'admin' } }) },
  ), true);
  assert.equal(adminDelete.statusCode, 200);
  assert.equal(adminDelete.data.deleted, true);
  assert.equal(deps.state.teamSharing.shares.find((share) => share.id === secondShareId).revokedAt, '2026-06-01T10:00:00.000Z');

  const readDeleted = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: {} },
    readDeleted,
    new URL(`https://magclaw.example/api/team-sharing/shares/${secondShareId}`),
    deps,
  ), true);
  assert.equal(readDeleted.statusCode, 404);

  const activeList = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: { host: 'magclaw.example', 'x-forwarded-proto': 'https' } },
    activeList,
    new URL('https://magclaw.example/api/team-sharing/shares?workspaceId=ws_route'),
    { ...deps, currentActor: () => ({ member: { workspaceId: 'ws_route', humanId: 'hum_owner', role: 'owner' } }) },
  ), true);
  assert.deepEqual(activeList.data.shares.map((share) => share.shareId), [firstShareId]);
  assert.equal(activeList.data.shares[0].canEdit, true);

  const auditList = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: { host: 'magclaw.example', 'x-forwarded-proto': 'https' } },
    auditList,
    new URL('https://magclaw.example/api/team-sharing/shares?workspaceId=ws_route&includeRevoked=1'),
    { ...deps, currentActor: () => ({ member: { workspaceId: 'ws_route', humanId: 'hum_owner', role: 'owner' } }) },
  ), true);
  assert.equal(auditList.data.count, 2);
  assert.equal(auditList.data.shares.find((share) => share.shareId === secondShareId).status, 'revoked');

  const creatorDelete = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'DELETE', headers: { host: 'magclaw.example', 'x-forwarded-proto': 'https' } },
    creatorDelete,
    new URL(`https://magclaw.example/api/team-sharing/shares/${firstShareId}`),
    deps,
  ), true);
  assert.equal(creatorDelete.statusCode, 200);
  assert.equal(creatorDelete.data.deleted, true);

  const deleteAgain = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'DELETE', headers: { host: 'magclaw.example', 'x-forwarded-proto': 'https' } },
    deleteAgain,
    new URL(`https://magclaw.example/api/team-sharing/shares/${firstShareId}`),
    deps,
  ), true);
  assert.equal(deleteAgain.statusCode, 200);
  assert.equal(deleteAgain.data.alreadyDeleted, true);
});

test('team sharing link inspection reports server access actions and token user memberships', async () => {
  const deps = routeDeps({
    currentActor: () => ({ member: { workspaceId: 'ws_route', humanId: 'hum_route', name: 'Ada PM', email: 'ada@example.com' } }),
  });
  deps.state.cloud.workspaces.push({ id: 'ws_removed', slug: 'removed-server', name: 'Removed Server' });
  deps.state.cloud.workspaceMembers = [
    { workspaceId: 'ws_route', humanId: 'hum_route', userId: 'usr_route', email: 'ada@example.com', role: 'owner', status: 'active' },
    { workspaceId: 'ws_other', humanId: 'hum_route', userId: 'usr_route', email: 'ada@example.com', role: 'member', status: 'active' },
    { workspaceId: 'ws_removed', humanId: 'hum_route', userId: 'usr_route', email: 'ada@example.com', role: 'member', status: 'removed' },
  ];
  deps.state.teamSharing.shares = [];
  deps.state.teamSharing.sessions = {};
  deps.state.teamSharing.shares.push({
    id: 'share_other_server',
    workspaceId: 'ws_other',
    title: 'Other server summary',
    description: 'Other server protected page',
    contentType: 'markdown',
    content: '# Other server summary\n\n跨 server 内容。',
    creator: { id: 'hum_route', name: 'Ada PM', email: 'ada@example.com' },
    createdAt: '2026-06-01T10:00:00.000Z',
    updatedAt: '2026-06-01T10:00:00.000Z',
  });
  deps.state.teamSharing.sessions.sess_other = {
    sessionId: 'sess_other',
    workspaceId: 'ws_other',
    title: 'Other server context',
    runtime: 'codex',
  };
  deps.state.teamSharing.events = {
    sess_other: [
      { eventId: 'evt_other_1', ordinal: 1, role: 'user', text: 'Other server question', cleanText: 'Other server question', createdAt: '2026-06-01T10:01:00.000Z' },
    ],
  };

  const fingerprint = `mfp_${'c'.repeat(64)}`;
  const authStart = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'POST' },
    authStart,
    new URL('https://magclaw.example/api/team-sharing/auth/start'),
    { ...deps, readJson: async () => ({ machineFingerprint: fingerprint }) },
  ), true);
  const authToken = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'POST' },
    authToken,
    new URL('https://magclaw.example/api/team-sharing/auth/token'),
    {
      ...deps,
      currentActor: () => null,
      readJson: async () => ({ deviceCode: authStart.data.deviceCode, machineFingerprint: fingerprint }),
    },
  ), true);
  const authHeaders = {
    authorization: `Bearer ${authToken.data.token}`,
    'x-magclaw-machine-fingerprint': fingerprint,
    host: 'magclaw.example',
    'x-forwarded-proto': 'https',
  };

  const serversRes = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: authHeaders },
    serversRes,
    new URL('https://magclaw.example/api/team-sharing/auth/servers'),
    { ...deps, currentActor: () => null },
  ), true);
  assert.equal(serversRes.statusCode, 200);
  assert.deepEqual(serversRes.data.servers.map((server) => server.id).sort(), ['ws_other', 'ws_route']);
  assert.equal(serversRes.data.servers.find((server) => server.id === 'ws_route').current, true);
  assert.equal(serversRes.data.servers.find((server) => server.id === 'ws_other').role, 'member');
  assert.doesNotMatch(JSON.stringify(serversRes.data), /rawToken|tokenHash|mc_join|Bearer/i);

  const serversNoToken = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: {} },
    serversNoToken,
    new URL('https://magclaw.example/api/team-sharing/auth/servers'),
    { ...deps, currentActor: () => null },
  ), true);
  assert.equal(serversNoToken.statusCode, 401);
  assert.equal(serversNoToken.data.reason, 'login_required');

  const noAuthInspect = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: { host: 'magclaw.example', 'x-forwarded-proto': 'https' } },
    noAuthInspect,
    new URL('https://magclaw.example/api/team-sharing/links/inspect?url=https%3A%2F%2Fmagclaw.example%2Fs%2Fshare_other_server'),
    { ...deps, currentActor: () => null },
  ), true);
  assert.equal(noAuthInspect.statusCode, 200);
  assert.equal(noAuthInspect.data.ok, false);
  assert.equal(noAuthInspect.data.reason, 'login_required');
  assert.equal(noAuthInspect.data.action.type, 'login');
  assert.match(noAuthInspect.data.action.command, /team-sharing login --server-url https:\/\/magclaw\.example/);

  const shareInspect = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: authHeaders },
    shareInspect,
    new URL('https://magclaw.example/api/team-sharing/links/inspect?url=https%3A%2F%2Fmagclaw.example%2Fs%2Fshare_other_server'),
    { ...deps, currentActor: () => null },
  ), true);
  assert.equal(shareInspect.statusCode, 200);
  assert.equal(shareInspect.data.ok, true);
  assert.equal(shareInspect.data.reason, 'ok');
  assert.equal(shareInspect.data.kind, 'share');
  assert.equal(shareInspect.data.target.workspaceId, 'ws_other');
  assert.equal(shareInspect.data.target.server.slug, 'other-server');
  assert.equal(shareInspect.data.auth.via, 'token_membership');
  assert.equal(shareInspect.data.action.type, 'read_link');

  const shareRead = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: authHeaders },
    shareRead,
    new URL('https://magclaw.example/api/team-sharing/shares/share_other_server'),
    { ...deps, currentActor: () => null },
  ), true);
  assert.equal(shareRead.statusCode, 200);
  assert.equal(shareRead.data.workspaceId, 'ws_other');
  assert.match(shareRead.data.content, /跨 server 内容/);

  const contextInspect = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: authHeaders },
    contextInspect,
    new URL('https://magclaw.example/api/team-sharing/links/inspect?url=https%3A%2F%2Fmagclaw.example%2Fs%2Fother-server%2Fteam-sharing%2Fcontext%2Fsess_other%3FanchorEventId%3Devt_1'),
    { ...deps, currentActor: () => null },
  ), true);
  assert.equal(contextInspect.statusCode, 200);
  assert.equal(contextInspect.data.ok, true);
  assert.equal(contextInspect.data.kind, 'context');
  assert.equal(contextInspect.data.target.sessionId, 'sess_other');
  assert.equal(contextInspect.data.auth.via, 'token_membership');

  const contextRead = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: authHeaders },
    contextRead,
    new URL('https://magclaw.example/api/team-sharing/context/sess_other?limit=1&order=asc'),
    { ...deps, currentActor: () => null },
  ), true);
  assert.equal(contextRead.statusCode, 200);
  assert.equal(contextRead.data.session.workspaceId, 'ws_other');

  deps.state.cloud.workspaceMembers.find((member) => member.workspaceId === 'ws_other').status = 'removed';
  const memberRequired = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: authHeaders },
    memberRequired,
    new URL('https://magclaw.example/api/team-sharing/links/inspect?url=https%3A%2F%2Fmagclaw.example%2Fs%2Fother-server%2Fteam-sharing%2Fcontext%2Fsess_other'),
    { ...deps, currentActor: () => null },
  ), true);
  assert.equal(memberRequired.statusCode, 200);
  assert.equal(memberRequired.data.ok, false);
  assert.equal(memberRequired.data.reason, 'server_membership_required');
  assert.equal(memberRequired.data.access.joinRequired, true);
  assert.equal(memberRequired.data.action.type, 'open_browser_to_join');
  assert.equal(memberRequired.data.action.url, 'https://magclaw.example/s/other-server/team-sharing/context/sess_other');

  const rejectedRead = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: authHeaders },
    rejectedRead,
    new URL('https://magclaw.example/api/team-sharing/shares/share_other_server'),
    { ...deps, currentActor: () => null },
  ), true);
  assert.equal(rejectedRead.statusCode, 403);
  assert.equal(rejectedRead.data.reason, 'server_membership_required');

  const missingInspect = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: authHeaders },
    missingInspect,
    new URL('https://magclaw.example/api/team-sharing/links/inspect?url=https%3A%2F%2Fmagclaw.example%2Fs%2Fshare_missing'),
    { ...deps, currentActor: () => null },
  ), true);
  assert.equal(missingInspect.statusCode, 404);
  assert.equal(missingInspect.data.reason, 'not_found');

  const unsupportedInspect = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET', headers: authHeaders },
    unsupportedInspect,
    new URL('https://magclaw.example/api/team-sharing/links/inspect?url=https%3A%2F%2Fmagclaw.example%2Fconsole'),
    { ...deps, currentActor: () => null },
  ), true);
  assert.equal(unsupportedInspect.statusCode, 400);
  assert.equal(unsupportedInspect.data.reason, 'unsupported_link');
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
  assert.match(res.body, /eventPresentation/);
  assert.match(res.body, /presentationBody/);
  assert.match(res.body, /context-event-head/);
  assert.match(res.body, /roleAvatarHtml/);
  assert.match(res.body, /context-avatar-codex/);
  assert.match(res.body, /\/brand\/codex-logo\.png/);
  assert.doesNotMatch(res.body, /fill="#0b0d12"/);
  assert.match(res.body, /context-avatar-claude/);
  assert.match(res.body, /context-plan-panel/);
  assert.match(res.body, /context-goal-panel/);
  assert.match(res.body, /context-interaction-panel/);
  assert.match(res.body, /--plan-bg:#f3f4f6/);
  assert.match(res.body, /--plan-line:#d1d5db/);
  assert.match(res.body, /--plan-accent:#6b7280/);
  assert.match(res.body, /#f0fdf4/);
  assert.match(res.body, /#bbf7d0/);
  assert.match(res.body, /contentSegments/);
  assert.match(res.body, /context-event-user/);
  assert.match(res.body, /article\.context-event-user/);
  assert.match(res.body, /--user-bg:#fff7ed/);
  assert.match(res.body, /--user-line:#fed7aa/);
  assert.match(res.body, /--user-ink:#9a3412/);
  assert.match(res.body, /article\.context-event-user \{ background:var\(--user-bg\); border-color:var\(--user-line\); \}/);
  assert.match(res.body, /article\.context-event-user \.role \{ border:1px solid #fdba74; background:#ffedd5; color:var\(--user-ink\); \}/);
  assert.match(res.body, /article\.context-event-user \.context-avatar \{ border-color:#fdba74; background:#fff7ed; color:var\(--user-ink\); \}/);
  assert.doesNotMatch(res.body, /color:#9f1239/);
  assert.match(res.body, /context-file-ref/);
  assert.match(res.body, /function isContextWebHref/);
  assert.match(res.body, /function stripContextMetadata/);
  assert.match(res.body, /function renderContextMarkdown/);
  assert.match(res.body, /renderContextMarkdown\(text\)/);
  assert.match(res.body, /CONTEXT_NOTE_MIN_CHARS = 1200/);
  assert.match(res.body, /CONTEXT_NOTE_MAX_CHARS = 1000/);
  assert.match(res.body, /context-note/);
  assert.match(res.body, />Abstract</);
  assert.doesNotMatch(res.body, /核心便签/);
  assert.match(res.body, /function contextNoteSummary/);
  assert.match(res.body, /function observeContextNotes/);
  assert.match(res.body, /contextNoteUnfold/);
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

test('team sharing context api enriches user events with the latest profile avatar', async () => {
  const deps = routeDeps({
    readJson: async () => ({
      ...syncBody(),
      humanId: 'hum_route',
      humanName: 'Old Name',
      humanAvatar: 'data:image/png;base64,old-avatar',
    }),
  });
  await handleTeamSharingApi(
    { method: 'POST' },
    makeResponse(),
    new URL('http://local/api/team-sharing/sync'),
    deps,
  );
  deps.state.humans = [{ id: 'hum_route', name: 'Latest Name', avatar: 'data:image/png;base64,latest-avatar' }];

  const res = makeResponse();
  assert.equal(await handleTeamSharingApi(
    { method: 'GET' },
    res,
    new URL('http://local/api/team-sharing/context/sess_route?anchorEventId=evt_1'),
    deps,
  ), true);

  assert.equal(res.statusCode, 200);
  assert.equal(res.data.session.uploader.name, 'Latest Name');
  assert.equal(res.data.session.uploader.avatar, 'data:image/png;base64,latest-avatar');
  assert.equal(res.data.events[0].actor.name, 'Latest Name');
  assert.equal(res.data.events[0].actor.avatar, 'data:image/png;base64,latest-avatar');
  assert.equal(res.data.events[0].metadata.uploader.avatar, 'data:image/png;base64,latest-avatar');
  assert.equal(res.data.events[1].actor.type, 'runtime');
  assert.equal(res.data.events[1].actor.name, 'Codex');
});

test('team sharing context page adds note summaries only for long agent replies', async () => {
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
  assert.match(
    context.renderContextInline('[server/team-sharing-clients.js](/Users/tt/code/myproject/magclaw/server/team-sharing-clients.js:316)'),
    /<span class="context-file-ref">server\/team-sharing-clients\.js<\/span>/,
  );
  assert.doesNotMatch(
    context.renderContextInline('[server/team-sharing-clients.js](/Users/tt/code/myproject/magclaw/server/team-sharing-clients.js:316)'),
    /href="\/Users\/tt/,
  );
  assert.match(
    context.renderContextInline('[原文](/team-sharing/context/sess_route?anchorEventId=evt_1)'),
    /href="\/team-sharing\/context\/sess_route\?anchorEventId=evt_1"/,
  );
  const directHookSummary = [
    '**上下文与索引**（原文）',
    '- **用户主要提出**：CODEX_SESSION_FILE 是干嘛的？',
    '- **Agent 回复**：解释 hook stdin JSON 里的 `transcript_path`。',
    '- [原文](https://example.com/team-sharing/context/sess_route)',
    '',
    '补充说明：' + '这段内容用于验证 Abstract markdown preview 的 1000 字截断上限。'.repeat(80),
  ].join('\n');
  context.window.__teamSharingSession = {
    summaryHint: directHookSummary,
    runtime: 'codex',
  };
  const longReply = [
    '已完成：我把上下文页的文件引用改成不可点击文本。',
    '验收结果：本地 UI 测试通过，说明链接渲染 contract 生效。',
    '核心结论：只有 Web 链接需要跳转，本地代码文件不再生成 href。',
    '重要发现：旧记录缺少头像属于历史 hook 数据问题，不是当前刷新逻辑问题。',
    '',
    '实现细节：' + '内容展示、滚动触发、摘要截断、三行打字动画。'.repeat(80),
  ].join('\n');
  const noteSummary = context.contextNoteSummary({ role: 'assistant', text: longReply });
  assert.match(noteSummary, /具体做了什么/);
  assert.match(noteSummary, /验收说明/);
  assert.match(noteSummary, /当前结论/);
  assert.match(noteSummary, /重要发现/);
  assert.doesNotMatch(noteSummary, /上下文与索引/);
  assert.ok(Array.from(noteSummary).length <= 1000);

  const html = context.eventHtml({
    eventId: 'evt_long',
    role: 'assistant',
    text: longReply,
    createdAt: '2026-06-01T10:02:00.000Z',
  });
  assert.match(html, /has-context-note/);
  assert.match(html, /data-context-note/);
  assert.match(html, /class="context-note-body"/);
  assert.match(html, /<strong>具体做了什么<\/strong>/);
  assert.match(html, /<strong>验收说明<\/strong>/);
  assert.doesNotMatch(html, /href="https:\/\/example\.com\/team-sharing\/context\/sess_route"/);
  assert.doesNotMatch(html, /data-full-text="[^"]*Team Sharing hooks/);

  const shortReply = '结论：短回复直接读正文即可。'.repeat(20);
  assert.equal(context.contextNoteSummary({ role: 'assistant', text: shortReply }), '');
  assert.equal(context.contextNoteSummary({ role: 'user', text: longReply }), '');

  const noConclusion = '过程记录：' + '逐项检查页面渲染与交互。'.repeat(120);
  assert.match(context.contextNoteSummary({ role: 'assistant', text: noConclusion }), /上下文与索引/);
});

test('team sharing context page renders plan goal and interaction presentation panels', async () => {
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
  context.window.__teamSharingSession = { runtime: 'codex', uploader: { name: 'JHB' } };

  const planHtml = context.eventHtml({
    eventId: 'evt_plan',
    role: 'assistant',
    text: '# Plan\n\n1. 展示步骤。',
    createdAt: '2026-06-01T10:02:00.000Z',
    presentation: { mode: 'plan', source: 'codex', title: 'Plan' },
  });
  assert.match(planHtml, /context-plan-panel/);
  assert.match(planHtml, /context-event-head/);
  assert.match(planHtml, /context-avatar-codex/);
  assert.match(planHtml, /\/brand\/codex-logo\.png/);
  assert.match(planHtml, />Codex</);
  assert.match(planHtml, /展示步骤/);
  assert.doesNotMatch(planHtml, /data-context-note/);

  const goalHtml = context.eventHtml({
    eventId: 'evt_goal',
    role: 'user',
    text: '把 Goal 模式接入 Team Sharing',
    createdAt: '2026-06-01T10:03:00.000Z',
    presentation: {
      mode: 'goal',
      source: 'codex',
      goal: { objective: '把 Goal 模式接入 Team Sharing', source: 'user', objectiveMatchesUser: true },
    },
  });
  assert.match(goalHtml, /context-goal-panel/);
  assert.match(goalHtml, /context-avatar/);
  assert.match(goalHtml, />JHB</);
  assert.match(goalHtml, /把 Goal 模式接入 Team Sharing/);

  const customAvatarHtml = context.eventHtml({
    eventId: 'evt_custom_avatar',
    role: 'user',
    text: '使用最新头像',
    createdAt: '2026-06-01T10:03:30.000Z',
    actor: { name: 'Latest JHB', avatar: 'data:image/png;base64,latest-avatar' },
  });
  assert.match(customAvatarHtml, /data:image\/png;base64,latest-avatar/);
  assert.match(customAvatarHtml, />Latest JHB</);

  const interactionHtml = context.eventHtml({
    eventId: 'evt_interaction',
    role: 'assistant',
    text: 'Agent 提问：要先做哪一层？\n用户回答：Full stack',
    createdAt: '2026-06-01T10:04:00.000Z',
    presentation: {
      mode: 'interaction',
      source: 'codex',
      interaction: {
        questions: [{
          id: 'scope',
          header: '范围',
          question: '要先做哪一层？',
          options: [{ label: 'Parser' }, { label: 'Full stack', description: '连云端展示一起做。' }],
        }],
        answers: [{ id: 'scope', values: ['Full stack'] }],
      },
    },
  });
  assert.match(interactionHtml, /context-interaction-panel/);
  assert.match(interactionHtml, /要先做哪一层/);
  assert.match(interactionHtml, /Full stack/);
  assert.match(interactionHtml, /context-answer-chip/);
  assert.match(interactionHtml, /context-answer-description/);
  assert.match(interactionHtml, /连云端展示一起做。/);
  assert.ok(interactionHtml.indexOf('要先做哪一层') < interactionHtml.indexOf('Full stack'));
  assert.ok(interactionHtml.indexOf('Full stack') < interactionHtml.indexOf('连云端展示一起做。'));
  assert.doesNotMatch(interactionHtml, /Agent 提问：要先做哪一层？/);
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

test('team sharing context page adds color swatches for hex colors', async () => {
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
  const html = context.renderContextMarkdown('Plan 用 `#eecfff`，Goal 用 #f0fdf4，Issue #123 不要误判。');

  assert.match(html, /<code>#eecfff<\/code><span class="context-color-swatch" style="background-color: #eecfff"/);
  assert.match(html, /#f0fdf4<span class="context-color-swatch" style="background-color: #f0fdf4"/);
  assert.doesNotMatch(html, /#123<span class="context-color-swatch"/);
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

test('team sharing context page redirects signed-in nonmembers to server join with returnTo', async () => {
  const deps = routeDeps({
    currentActor: () => null,
    currentUser: () => ({ id: 'usr_guest', email: 'guest@example.com', name: 'Guest' }),
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
    new URL('https://magclaw.example/s/server-route/team-sharing/context/sess_route?anchorEventId=evt_1&limit=21&order=asc'),
    deps,
  ), true);

  assert.equal(res.statusCode, 302);
  assert.match(res.headers.location, /^\/join\/mc_join_/);
  assert.match(decodeURIComponent(res.headers.location), /returnTo=\/s\/server-route\/team-sharing\/context\/sess_route\?anchorEventId=evt_1&limit=21&order=asc/);
  assert.equal(deps.state.cloud.joinLinks.length, 1);
  assert.equal(deps.state.cloud.joinLinks[0].workspaceId, 'ws_route');
  assert.equal(deps.state.cloud.joinLinks[0].createdBy, 'usr_guest');
  assert.equal(deps.state.cloud.joinLinks[0].metadata.purpose, 'team_sharing_access');
  assert.equal(deps.state.cloud.joinLinks[0].metadata.boundUserId, 'usr_guest');
});
