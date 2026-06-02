import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyTeamSharingFeedback,
  contextWindowForTeamSharingSession,
  createInitialTeamSharingState,
  rankTeamSharingCandidates,
  syncTeamSharingBatch,
} from '../server/team-sharing.js';

function baseState() {
  return {
    connection: { workspaceId: 'ws_test' },
    channels: [
      { id: 'chan_team', name: 'team-sharing', memberIds: ['hum_jhb', 'agt_codex'] },
    ],
    messages: [],
    replies: [],
    teamSharing: createInitialTeamSharingState(),
  };
}

function makeIdFactory() {
  let counter = 0;
  return (prefix) => `${prefix}_${++counter}`;
}

function sampleSyncPackage(overrides = {}) {
  return {
    runtime: 'codex',
    projectKey: 'magclaw',
    projectPathHash: 'proj_hash',
    sessionId: 'sess_rerank_design',
    title: 'MagClaw rerank feedback design',
    workspaceId: 'ws_test',
    channelId: 'chan_team',
    idempotencyKey: 'codex:magclaw:sess_rerank_design:1:3:abc',
    fromOrdinal: 1,
    toOrdinal: 3,
    events: [
      {
        eventId: 'evt_1',
        ordinal: 1,
        role: 'user',
        text: '我们要给团队共享加入 rerank，并且不要泄漏 API_KEY=secret-123。',
        createdAt: '2026-06-01T08:00:00.000Z',
      },
      {
        eventId: 'evt_2',
        ordinal: 2,
        role: 'assistant',
        text: '结论：先用 Zilliz 召回候选，再用 rerank 压缩到 top5，并记录 opened/helpful 反馈。',
        toolCalls: [
          { name: 'rg', arguments: { pattern: 'RERANK_API_KEY=secret-123' }, output: 'very long private output' },
        ],
        createdAt: '2026-06-01T08:01:00.000Z',
      },
      {
        eventId: 'evt_3',
        ordinal: 3,
        role: 'tool',
        text: 'internal raw command output should be dropped',
        createdAt: '2026-06-01T08:01:20.000Z',
      },
    ],
    optionalLocalDigest: '本轮确定 rerank 需要热度反馈，但必须封顶和衰减。',
    ...overrides,
  };
}

test('team sharing sync creates one channel message, clean thread replies, abstract docs, and is idempotent', async () => {
  const state = baseState();
  const makeId = makeIdFactory();
  const first = await syncTeamSharingBatch(sampleSyncPackage(), {
    state,
    makeId,
    now: () => '2026-06-01T08:02:00.000Z',
  });
  const duplicate = await syncTeamSharingBatch(sampleSyncPackage(), {
    state,
    makeId,
    now: () => '2026-06-01T08:03:00.000Z',
  });

  assert.equal(first.ok, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.appendedEventCount, 2);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.appendedEventCount, 0);

  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].body, 'MagClaw rerank feedback design');
  assert.equal(state.messages[0].spaceId, 'chan_team');
  assert.equal(state.messages[0].replyCount, 2);
  assert.equal(state.replies.length, 2);
  assert.match(state.replies[0].body, /我们要给团队共享加入 rerank/);
  assert.doesNotMatch(state.replies[0].body, /secret-123|API_KEY/);
  assert.match(state.replies[1].body, /used_tools=rg/);
  assert.doesNotMatch(state.replies[1].body, /private output|arguments/);

  const session = state.teamSharing.sessions.sess_rerank_design;
  assert.equal(session.messageId, state.messages[0].id);
  assert.equal(session.lastEventOrdinal, 2);
  assert.equal(session.indexStatus, 'ready');
  assert.ok(state.teamSharing.abstracts.sess_rerank_design.abstractMarkdown.includes('MagClaw rerank feedback design'));
  assert.ok(state.teamSharing.activities.some((item) => item.summary.includes('同步 2 条清洗事件')));
  assert.ok(state.teamSharing.vectorDocuments.some((doc) => doc.layer === 'L0' && doc.sessionId === 'sess_rerank_design'));
  assert.ok(state.teamSharing.vectorDocuments.some((doc) => doc.layer === 'L1' && doc.topicId === 'rerank-feedback'));
});

test('team sharing sync resolves signed MagClaw channel path when channelId is omitted', async () => {
  const state = baseState();
  state.channels[0].metadata = { integrations: { feishuImport: { routeKey: 'fixed-route-key' } } };
  const result = await syncTeamSharingBatch(sampleSyncPackage({
    channelId: '',
    channelPath: 'mc://magclaw/server/ws_test/channel/chan_team?key=fixed-route-key',
    idempotencyKey: 'codex:magclaw:sess_path:1:2:path',
    sessionId: 'sess_path',
  }), {
    state,
    makeId: makeIdFactory(),
    now: () => '2026-06-01T08:02:00.000Z',
  });

  assert.equal(result.ok, true);
  assert.equal(state.teamSharing.sessions.sess_path.channelId, 'chan_team');
});

test('team sharing context window anchors on an event and paginates both directions', async () => {
  const state = baseState();
  await syncTeamSharingBatch(sampleSyncPackage({
    idempotencyKey: 'codex:magclaw:sess_rerank_design:1:4:def',
    toOrdinal: 4,
    events: [
      ...sampleSyncPackage().events.slice(0, 2),
      {
        eventId: 'evt_4',
        ordinal: 4,
        role: 'assistant',
        text: '后续：动态上下文页要支持向上和向下加载更多。',
        createdAt: '2026-06-01T08:04:00.000Z',
      },
    ],
  }), {
    state,
    makeId: makeIdFactory(),
    now: () => '2026-06-01T08:05:00.000Z',
  });

  const around = contextWindowForTeamSharingSession(state.teamSharing, 'sess_rerank_design', {
    anchorEventId: 'evt_2',
    direction: 'around',
    limit: 1,
  });
  assert.equal(around.ok, true);
  assert.deepEqual(around.events.map((event) => event.eventId), ['evt_2']);
  assert.equal(around.pagination.hasPrev, true);
  assert.equal(around.pagination.hasNext, true);

  const next = contextWindowForTeamSharingSession(state.teamSharing, 'sess_rerank_design', {
    anchorEventId: 'evt_2',
    direction: 'next',
    limit: 1,
  });
  assert.deepEqual(next.events.map((event) => event.eventId), ['evt_4']);
});

test('team sharing context next page without anchor starts from the first event', () => {
  const teamSharingState = createInitialTeamSharingState();
  teamSharingState.events.sess_context = [
    { eventId: 'evt_1', ordinal: 1, role: 'user', cleanText: '第一条' },
    { eventId: 'evt_2', ordinal: 2, role: 'assistant', cleanText: '第二条' },
  ];

  const next = contextWindowForTeamSharingSession(teamSharingState, 'sess_context', {
    direction: 'next',
    limit: 1,
  });

  assert.equal(next.ok, true);
  assert.deepEqual(next.events.map((event) => event.eventId), ['evt_1']);
  assert.equal(next.pagination.hasNext, true);
});

test('team sharing context supports newest-first windows for context pages', () => {
  const teamSharingState = createInitialTeamSharingState();
  teamSharingState.events.sess_context = [
    { eventId: 'evt_1', ordinal: 1, role: 'user', cleanText: '第一条' },
    { eventId: 'evt_2', ordinal: 2, role: 'assistant', cleanText: '第二条' },
    { eventId: 'evt_3', ordinal: 3, role: 'user', cleanText: '第三条' },
  ];

  const latest = contextWindowForTeamSharingSession(teamSharingState, 'sess_context', {
    direction: 'around',
    order: 'desc',
    limit: 2,
  });
  assert.equal(latest.ok, true);
  assert.deepEqual(latest.events.map((event) => event.eventId), ['evt_3', 'evt_2']);
  assert.equal(latest.pagination.hasPrev, true);
  assert.equal(latest.pagination.hasNext, false);

  const older = contextWindowForTeamSharingSession(teamSharingState, 'sess_context', {
    anchorEventId: latest.pagination.prevAnchorEventId,
    direction: 'prev',
    order: 'desc',
    limit: 1,
  });
  assert.deepEqual(older.events.map((event) => event.eventId), ['evt_1']);
});

test('team sharing rerank returns diverse top5 and feedback changes later ordering within cap', () => {
  const teamSharingState = createInitialTeamSharingState();
  const candidates = [
    {
      vectorDocumentId: 'doc_a',
      sessionId: 'sess_a',
      topicId: 'rerank-feedback',
      layer: 'L1',
      title: 'Rerank feedback design',
      text: 'Zilliz 候选经过 rerank 后返回 top5，opened/helpful 会提升 hotness。',
      vectorScore: 0.82,
      keywordScore: 0.8,
      freshnessScore: 0.4,
      updatedAt: '2026-06-01T08:00:00.000Z',
    },
    {
      vectorDocumentId: 'doc_b',
      sessionId: 'sess_b',
      topicId: 'claude-adapter',
      layer: 'L1',
      title: 'Claude Code adapter',
      text: 'Claude Code hook 需要归一化为同一 sync package。',
      vectorScore: 0.79,
      keywordScore: 0.1,
      freshnessScore: 0.8,
      updatedAt: '2026-06-01T08:10:00.000Z',
    },
    {
      vectorDocumentId: 'doc_c',
      sessionId: 'sess_a',
      topicId: 'rerank-feedback',
      layer: 'L1',
      title: 'Duplicate same topic',
      text: '同一 topic 的另一个重复候选，不应该挤占 top5。',
      vectorScore: 0.81,
      keywordScore: 0.7,
      freshnessScore: 0.4,
      updatedAt: '2026-06-01T08:01:00.000Z',
    },
  ];

  const rerankScores = new Map([
    ['doc_a', 0.7],
    ['doc_b', 0.95],
    ['doc_c', 0.72],
  ]);
  const first = rankTeamSharingCandidates({
    query: 'rerank 反馈怎么做',
    candidates,
    teamSharingState,
    rerankResults: candidates.map((candidate, index) => ({ index, score: rerankScores.get(candidate.vectorDocumentId) })),
    now: () => '2026-06-01T09:00:00.000Z',
    limit: 5,
  });

  assert.equal(first.results[0].vectorDocumentId, 'doc_b');
  assert.equal(first.results.some((item) => item.vectorDocumentId === 'doc_c'), false);
  assert.equal(first.trace.selectedTop5.length, 2);
  assert.ok(first.trace.rerankScores.doc_a > 0);

  applyTeamSharingFeedback(teamSharingState, {
    actorId: 'hum_jhb',
    queryId: first.queryId,
    vectorDocumentId: 'doc_a',
    sessionId: 'sess_a',
    eventType: 'opened',
    createdAt: '2026-06-01T09:01:00.000Z',
  });
  applyTeamSharingFeedback(teamSharingState, {
    actorId: 'hum_jhb',
    queryId: first.queryId,
    vectorDocumentId: 'doc_a',
    sessionId: 'sess_a',
    eventType: 'helpful',
    createdAt: '2026-06-01T09:02:00.000Z',
  });

  const second = rankTeamSharingCandidates({
    query: 'rerank 反馈怎么做',
    candidates,
    teamSharingState,
    rerankResults: candidates.map((candidate, index) => ({ index, score: rerankScores.get(candidate.vectorDocumentId) })),
    now: () => '2026-06-01T09:03:00.000Z',
    limit: 5,
  });
  const boosted = second.results.find((item) => item.vectorDocumentId === 'doc_a');
  assert.equal(second.results[0].vectorDocumentId, 'doc_a');
  assert.ok(boosted.hotnessScore <= 0.18);

  applyTeamSharingFeedback(teamSharingState, {
    actorId: 'hum_jhb',
    queryId: second.queryId,
    vectorDocumentId: 'doc_a',
    sessionId: 'sess_a',
    eventType: 'unhelpful',
    createdAt: '2026-06-01T09:04:00.000Z',
  });
  const third = rankTeamSharingCandidates({
    query: 'rerank 反馈怎么做',
    candidates,
    teamSharingState,
    rerankResults: candidates.map((candidate, index) => ({ index, score: rerankScores.get(candidate.vectorDocumentId) })),
    now: () => '2026-06-01T09:05:00.000Z',
    limit: 5,
  });
  assert.ok(third.results.find((item) => item.vectorDocumentId === 'doc_a').hotnessScore < boosted.hotnessScore);
});

test('team sharing hotness dedupes repeated feedback from the same actor before capping', () => {
  const teamSharingState = createInitialTeamSharingState();
  const base = {
    vectorDocumentId: 'doc_repeat',
    sessionId: 'sess_repeat',
    eventType: 'helpful',
    actorId: 'hum_same',
    createdAt: '2026-06-01T10:00:00.000Z',
  };

  applyTeamSharingFeedback(teamSharingState, { ...base, feedbackId: 'fb_1' });
  applyTeamSharingFeedback(teamSharingState, { ...base, feedbackId: 'fb_2', createdAt: '2026-06-01T10:01:00.000Z' });
  const repeated = applyTeamSharingFeedback(teamSharingState, { ...base, feedbackId: 'fb_3', createdAt: '2026-06-01T10:02:00.000Z' });

  assert.equal(repeated.ok, true);
  assert.equal(repeated.hotnessScore, 0.12);

  const secondActor = applyTeamSharingFeedback(teamSharingState, {
    ...base,
    feedbackId: 'fb_4',
    actorId: 'hum_other',
    createdAt: '2026-06-01T10:03:00.000Z',
  });
  assert.equal(secondActor.hotnessScore, 0.18);
});
