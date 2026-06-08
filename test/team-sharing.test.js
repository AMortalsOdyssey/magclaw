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
    humanId: 'hum_jhb',
    humanName: '蒋海波',
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
        text: '我们要给团队共享加入 rerank，并且不要泄漏 API_KEY=secret-123，秘钥：zh-secret-456，也不要显示 mc://magclaw/server/ws/channel/chan?key=route-secret。',
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
  assert.equal(state.messages[0].authorType, 'human');
  assert.equal(state.messages[0].authorId, 'hum_jhb');
  assert.equal(state.messages[0].metadata.teamSharing.runtime, 'codex');
  assert.equal(state.messages[0].metadata.teamSharing.uploader.name, '蒋海波');
  assert.equal(state.messages[0].spaceId, 'chan_team');
  assert.equal(state.messages[0].replyCount, 2);
  assert.equal(state.replies.length, 2);
  assert.equal(state.replies[0].authorType, 'human');
  assert.equal(state.replies[0].authorId, 'hum_jhb');
  assert.equal(state.replies[1].authorType, 'agent');
  assert.equal(state.replies[1].authorId, 'team_sharing_codex');
  assert.match(state.replies[0].body, /我们要给团队共享加入 rerank/);
  assert.doesNotMatch(state.replies[0].body, /secret-123|zh-secret-456|route-secret|API_KEY|秘钥/);
  assert.doesNotMatch(state.replies[1].body, /used_tools=rg/);
  assert.deepEqual(state.replies[1].metadata.teamSharing.uploader.name, '蒋海波');
  assert.doesNotMatch(state.replies[1].body, /private output|arguments/);

  const session = state.teamSharing.sessions.sess_rerank_design;
  assert.equal(session.messageId, state.messages[0].id);
  assert.equal(session.lastEventOrdinal, 2);
  assert.equal(session.indexStatus, 'ready');
  assert.match(state.teamSharing.abstracts.sess_rerank_design.abstractMarkdown, /^# MagClaw rerank feedback design/m);
  assert.doesNotMatch(state.teamSharing.abstracts.sess_rerank_design.abstractMarkdown, /Source Anchors/);
  assert.doesNotMatch(state.teamSharing.abstracts.sess_rerank_design.abstractMarkdown, /Raw IDs/);
  assert.ok(state.teamSharing.activities.some((item) => item.summary.includes('同步 2 条清洗事件')));
  assert.ok(state.teamSharing.vectorDocuments.some((doc) => doc.layer === 'L0' && doc.sessionId === 'sess_rerank_design'));
  assert.ok(state.teamSharing.vectorDocuments.some((doc) => doc.layer === 'L1' && doc.topicId === 'rerank-feedback' && doc.rawEventId && /topics\/rerank-feedback\.md#/.test(doc.sourceRef)));
  assert.ok(state.teamSharing.vectorDocuments.some((doc) => doc.layer === 'L2' && doc.rawEventId === 'evt_1' && /我们要给团队共享加入 rerank/.test(doc.text || '')));
  for (const doc of state.teamSharing.vectorDocuments.filter((item) => item.sessionId === 'sess_rerank_design')) {
    assert.equal(doc.uploaderId, 'hum_jhb');
    assert.equal(doc.uploaderName, '蒋海波');
    assert.match(doc.uploaderSearchText, /hum_jhb/);
    assert.match(doc.uploaderSearchText, /蒋海波/);
  }
});

test('team sharing sync deduplicates the same transcript event when parser ordinals change', async () => {
  const state = baseState();
  const makeId = makeIdFactory();
  const first = await syncTeamSharingBatch(sampleSyncPackage({
    sessionId: 'sess_stable_identity',
    idempotencyKey: 'codex:magclaw:sess_stable_identity:1:1:old',
    fromOrdinal: 1,
    toOrdinal: 1,
    events: [{
      eventId: 'sess_stable_identity:1:oldid',
      ordinal: 1,
      role: 'assistant',
      text: 'Agent 提问：链接范围？\n用户回答：内容+工作区',
      sourceHash: 'same-source-hash',
      createdAt: '2026-06-01T08:05:00.000Z',
      presentation: {
        mode: 'interaction',
        source: 'codex',
        interaction: {
          questions: [{ id: 'scope', header: '链接范围', question: '链接保护到哪一类？' }],
          answers: [{ id: 'scope', values: ['内容+工作区'] }],
        },
      },
    }],
  }), {
    state,
    makeId,
    now: () => '2026-06-01T08:06:00.000Z',
  });
  const second = await syncTeamSharingBatch(sampleSyncPackage({
    sessionId: 'sess_stable_identity',
    idempotencyKey: 'codex:magclaw:sess_stable_identity:2:2:new',
    fromOrdinal: 2,
    toOrdinal: 2,
    events: [{
      eventId: 'sess_stable_identity:2:newid',
      ordinal: 2,
      role: 'assistant',
      text: 'Agent 提问：链接范围？\n用户回答：内容+工作区',
      sourceHash: 'same-source-hash',
      createdAt: '2026-06-01T08:05:00.000Z',
      presentation: {
        mode: 'interaction',
        source: 'codex',
        interaction: {
          questions: [{ id: 'scope', header: '链接范围', question: '链接保护到哪一类？' }],
          answers: [{ id: 'scope', values: ['内容+工作区'] }],
        },
      },
    }],
  }), {
    state,
    makeId,
    now: () => '2026-06-01T08:07:00.000Z',
  });

  assert.equal(first.ok, true);
  assert.equal(first.appendedEventCount, 1);
  assert.equal(second.ok, true);
  assert.equal(second.appendedEventCount, 0);
  assert.equal(state.replies.length, 1);
  assert.equal(state.messages[0].replyCount, 1);
  assert.equal(state.teamSharing.events.sess_stable_identity.length, 1);
});

test('team sharing context summary hint prefers uploaded activity summary', async () => {
  const state = baseState();
  const activitySummary = `hooks summary：这次完成了长回复便签的 Markdown preview，并确认超过 1000 字才截断。${'摘要补充。'.repeat(240)}`;
  await syncTeamSharingBatch(sampleSyncPackage({
    idempotencyKey: 'codex:magclaw:sess_summary_hint:1:2:abc',
    sessionId: 'sess_summary_hint',
  }), {
    state,
    makeId: makeIdFactory(),
    now: () => '2026-06-01T08:04:00.000Z',
    summarizeSession: async () => ({
      l0: 'abstract 摘要：这段内容不应该优先显示在便签里。',
      activity: {
        summary: activitySummary,
      },
      topics: [{
        topicId: 'summary-hint',
        title: 'summary-hint',
        overview: 'summary hint source priority',
        sourceEventIds: ['evt_1', 'evt_2'],
      }],
    }),
  });

  const context = contextWindowForTeamSharingSession(state.teamSharing, 'sess_summary_hint', {
    anchorEventId: 'evt_2',
    direction: 'around',
    limit: 2,
  });

  assert.equal(context.ok, true);
  assert.equal(Array.from(context.session.summaryHint).length, 1000);
  assert.equal(context.session.summaryHint, Array.from(activitySummary).slice(0, 1000).join(''));
});

test('team sharing sync preserves presentation metadata on events, replies, and context windows', async () => {
  const state = baseState();
  const result = await syncTeamSharingBatch(sampleSyncPackage({
    idempotencyKey: 'codex:magclaw:sess_presentation:1:3:presentation',
    sessionId: 'sess_presentation',
    title: 'Plan Goal presentation metadata',
    events: [
      {
        eventId: 'evt_plan',
        ordinal: 1,
        role: 'assistant',
        text: '# 实施计划\n\n1. 解析 hooks。',
        createdAt: '2026-06-01T08:00:00.000Z',
        presentation: {
          mode: 'plan',
          source: 'codex',
          title: 'Plan',
        },
      },
      {
        eventId: 'evt_goal',
        ordinal: 2,
        role: 'user',
        text: '把 Goal 模式接入 Team Sharing',
        createdAt: '2026-06-01T08:01:00.000Z',
        presentation: {
          mode: 'goal',
          source: 'codex',
          goal: {
            objective: '把 Goal 模式接入 Team Sharing',
            status: 'active',
            source: 'user',
            objectiveMatchesUser: true,
          },
        },
      },
      {
        eventId: 'evt_interaction',
        ordinal: 3,
        role: 'assistant',
        text: 'Agent 提问：要先做哪一层？\n用户回答：Full stack',
        createdAt: '2026-06-01T08:02:00.000Z',
        presentation: {
          mode: 'interaction',
          source: 'codex',
          interaction: {
            questions: [{ id: 'scope', header: '范围', question: '要先做哪一层？', options: [{ label: 'Parser' }, { label: 'Full stack', description: '连云端展示一起做。' }] }],
            answers: [{ id: 'scope', values: ['Full stack'] }],
          },
        },
      },
    ],
  }), {
    state,
    makeId: makeIdFactory(),
    now: () => '2026-06-01T08:03:00.000Z',
  });

  assert.equal(result.ok, true);
  assert.equal(state.teamSharing.events.sess_presentation[0].presentation.mode, 'plan');
  assert.equal(state.teamSharing.events.sess_presentation[1].presentation.goal.source, 'user');
  assert.deepEqual(state.teamSharing.events.sess_presentation[2].presentation.interaction.answers[0].values, ['Full stack']);
  assert.equal(state.replies[0].metadata.teamSharing.presentation.mode, 'plan');
  assert.equal(state.replies[1].metadata.teamSharing.presentation.goal.objectiveMatchesUser, true);
  assert.equal(state.replies[2].metadata.teamSharing.presentation.interaction.questions[0].question, '要先做哪一层？');
  assert.match(state.replies[2].body, /\*\*Agent 提问：范围\*\*：要先做哪一层？/);
  assert.match(state.replies[2].body, /\*\*用户回答：\*\* Full stack `（连云端展示一起做。）`/);
  assert.doesNotMatch(state.replies[2].body, /^Agent 提问：/m);
  const l0Document = state.teamSharing.vectorDocuments.find((doc) => doc.sessionId === 'sess_presentation' && doc.layer === 'L0');
  assert.deepEqual(l0Document.presentationModes, ['plan', 'goal', 'interaction']);
  assert.equal(l0Document.presentations[1].goal.objective, '把 Goal 模式接入 Team Sharing');

  const context = contextWindowForTeamSharingSession(state.teamSharing, 'sess_presentation', {
    anchorEventId: 'evt_goal',
    direction: 'around',
    limit: 3,
  });
  assert.equal(context.ok, true);
  assert.deepEqual(context.events.map((event) => event.presentation?.mode), ['plan', 'goal', 'interaction']);
});

test('team sharing sync records whitelisted local hook package metadata', async () => {
  const state = baseState();
  const result = await syncTeamSharingBatch(sampleSyncPackage({
    idempotencyKey: 'codex:magclaw:sess_metadata:1:2:metadata',
    sessionId: 'sess_metadata',
    metadata: {
      integration: 'team-sharing',
      packageVersion: '0.1.41',
      sourceCommit: 'abc123def456',
      token: 'should-not-be-kept',
    },
  }), {
    state,
    makeId: makeIdFactory(),
    now: () => '2026-06-01T08:02:00.000Z',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(state.messages[0].metadata.teamSharing.sync, {
    integration: 'team-sharing',
    packageVersion: '0.1.41',
    sourceCommit: 'abc123def456',
  });
  assert.doesNotMatch(JSON.stringify(state.messages[0].metadata.teamSharing.sync), /should-not-be-kept/);

  await syncTeamSharingBatch(sampleSyncPackage({
    idempotencyKey: 'codex:magclaw:sess_metadata:1:2:metadata',
    sessionId: 'sess_metadata',
  }), {
    state,
    makeId: makeIdFactory(),
    now: () => '2026-06-01T08:03:00.000Z',
  });
  assert.equal(state.messages[0].metadata.teamSharing.sync.sourceCommit, 'abc123def456');
});

test('team sharing abstracts format long summary links and keep raw ids beside content', async () => {
  const state = baseState();
  const result = await syncTeamSharingBatch(sampleSyncPackage({
    idempotencyKey: 'codex:magclaw:sess_md_format:1:4:format',
    sessionId: 'sess_md_format',
    title: '验收会话总结共享',
    events: [
      {
        eventId: 'evt_url_1',
        ordinal: 1,
        role: 'user',
        text: '部署好了 页面位置：https://magclaw-testing.multiego.me/s/share_6929a2251b',
      },
      {
        eventId: 'evt_url_2',
        ordinal: 2,
        role: 'assistant',
        text: '确认 R150 已部署，搜索结果标题已经规范化。',
      },
      {
        eventId: 'evt_url_3',
        ordinal: 3,
        role: 'user',
        text: 'workspace 下 abstract.md 的 Summary 不要写成一大段。',
      },
      {
        eventId: 'evt_url_4',
        ordinal: 4,
        role: 'assistant',
        text: '已改成分层 Markdown，并让 Raw ID 跟关键点绑定。 used_tools=exec_command,apply_patch',
      },
    ],
    optionalLocalDigest: 'Tool summary: exec_command, apply_patch',
  }), {
    state,
    makeId: makeIdFactory(),
    now: () => '2026-06-01T08:04:00.000Z',
    summarizeSession: async () => ({
      ok: true,
      l0: '部署页面已确认：https://magclaw-testing.multiego.me/s/share_6929a2251b后续需要修复摘要结构；Workspace Markdown 必须分层展示；线上验收结果：- readyz 返回 200。- 未登录访问 dynamic context 会跳转登录并带 returnTo。Raw ID 要和具体总结点绑定。本地摘要补充：Tool summary: exec_command,apply_patch',
      topics: [
        {
          topicId: 'rerank-feedback',
          title: 'Rerank Feedback',
          overview: '搜索结果标题已经规范化；Key Changes 不能混成一个长段落；链接必须单独成行；Raw ID 只需要定位一条代表性上下文。Tool summary: exec_command,apply_patch',
          decisions: ['当前 Key Changes 层级全部混在一起，链接也连在一起；必须分层级、分子模块、分列表来展示。', 'Raw ID 跟关键点绑定'],
          sourceEventIds: ['evt_url_1', 'evt_url_2', 'evt_url_3'],
        },
      ],
    }),
  });

  assert.equal(result.ok, true);
  const abstract = state.teamSharing.abstracts.sess_md_format;
  assert.match(abstract.abstractMarkdown, /^# 验收会话总结共享/m);
  assert.match(abstract.abstractMarkdown, /1\. \*\*部署页面已确认\*\*：（\[原文\]\(\/team-sharing\/context\/sess_md_format\?anchorEventId=evt_url_1&limit=21&order=asc\)）\nhttps:\/\/magclaw-testing\.multiego\.me\/s\/share_6929a2251b/);
  assert.match(abstract.abstractMarkdown, /2\. \*\*线上验收结果\*\*：\n\s+- readyz 返回 200/);
  assert.match(abstract.abstractMarkdown, /\n\s+- Workspace Markdown 必须分层展示。/);
  assert.match(abstract.abstractMarkdown, /### \[Rerank Feedback\]\(topics\/rerank-feedback\.md\)/);
  assert.doesNotMatch(abstract.abstractMarkdown, /打开 Topic 文档/);
  assert.doesNotMatch(abstract.abstractMarkdown, /\| Topic \| Summary \|/);
  assert.match(abstract.abstractMarkdown, /1\. \*\*部署页面已确认\*\*：（\[原文\]\(\/team-sharing\/context\/sess_md_format\?anchorEventId=evt_url_1&limit=21&order=asc\)）/);
  assert.match(abstract.abstractMarkdown, /点击正文里的 \[原文\]\(\/team-sharing\/context\/sess_md_format\?anchorEventId=evt_url_1&limit=21&order=asc\) 可以打开动态原始上下文。/);
  assert.doesNotMatch(abstract.abstractMarkdown, /\n\[围绕首条来源打开\]/);
  assert.doesNotMatch(abstract.abstractMarkdown, /\n\s*\[打开原文\]/);
  assert.doesNotMatch(abstract.abstractMarkdown, /\n- Raw ID:/);
  assert.doesNotMatch(abstract.abstractMarkdown, /Source Anchors|Raw IDs|Tool summary|used_tools/);
  const topicMarkdown = abstract.topics['rerank-feedback'].overviewMarkdown;
  assert.doesNotMatch(topicMarkdown, /evt_url_2|evt_url_3/);
  assert.match(topicMarkdown, /- 当前 Key Changes 层级全部混在一起.*\[原文\]\(\/team-sharing\/context\/sess_md_format\?anchorEventId=evt_url_1&limit=21&order=asc\)/);
  assert.match(topicMarkdown, /\n\s+- 必须分层级、分子模块、分列表来展示。/);
  assert.match(topicMarkdown, /点击正文里的 \[原文\]\(\/team-sharing\/context\/sess_md_format\?anchorEventId=evt_url_1&limit=21&order=asc\) 可以打开动态原始上下文。/);
  assert.match(topicMarkdown, /\[原文\]\(\/team-sharing\/context\/sess_md_format\?anchorEventId=evt_url_1&limit=21&order=asc\)/);
  assert.doesNotMatch(topicMarkdown, /Raw ID:/);
  assert.doesNotMatch(topicMarkdown, /\n\s*\[打开原文\]/);
  assert.doesNotMatch(topicMarkdown, /Raw IDs|Tool summary|used_tools/);
  assert.match(abstract.debugLogMarkdown, /Hook Prompt Summary/);
  assert.match(abstract.debugLogMarkdown, /Agent Reply Summary/);
  assert.match(abstract.debugLogMarkdown, /Cloud Merge/);
  assert.match(abstract.debugLogMarkdown, /Topics Folder Changes/);
});

test('team sharing duplicate sync still updates mutable session title everywhere', async () => {
  const state = baseState();
  const makeId = makeIdFactory();
  const first = await syncTeamSharingBatch(sampleSyncPackage({
    sessionId: 'sess_title_update',
    idempotencyKey: 'codex:magclaw:sess_title_update:1:2:title',
    title: '旧标题',
  }), {
    state,
    makeId,
    now: () => '2026-06-01T08:02:00.000Z',
  });
  const second = await syncTeamSharingBatch(sampleSyncPackage({
    sessionId: 'sess_title_update',
    idempotencyKey: 'codex:magclaw:sess_title_update:1:2:title',
    title: '验收会话总结共享',
  }), {
    state,
    makeId,
    now: () => '2026-06-01T08:03:00.000Z',
  });

  assert.equal(first.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(second.titleChanged, true);
  assert.equal(state.teamSharing.sessions.sess_title_update.title, '验收会话总结共享');
  assert.equal(state.messages[0].body, '验收会话总结共享');
  assert.equal(state.messages[0].metadata.teamSharing.title, '验收会话总结共享');
  assert.match(state.teamSharing.abstracts.sess_title_update.abstractMarkdown, /^# 验收会话总结共享/m);
  assert.ok(state.teamSharing.vectorDocuments.every((doc) => doc.sessionId !== 'sess_title_update' || doc.title === '验收会话总结共享'));
});

test('team sharing sync ignores generated session-id titles without downgrading existing titles', async () => {
  const state = baseState();
  const makeId = makeIdFactory();
  await syncTeamSharingBatch(sampleSyncPackage({
    sessionId: 'sess_title_guard',
    idempotencyKey: 'codex:magclaw:sess_title_guard:1:2:initial',
    title: '验收会话总结共享',
  }), {
    state,
    makeId,
    now: () => '2026-06-01T08:02:00.000Z',
  });
  const placeholder = await syncTeamSharingBatch(sampleSyncPackage({
    sessionId: 'sess_title_guard',
    idempotencyKey: 'codex:magclaw:sess_title_guard:1:2:placeholder',
    title: 'codex session sess_title_guard',
  }), {
    state,
    makeId,
    now: () => '2026-06-01T08:03:00.000Z',
  });
  assert.equal(placeholder.ok, true);
  assert.equal(state.teamSharing.sessions.sess_title_guard.title, '验收会话总结共享');
  assert.equal(state.messages[0].body, '验收会话总结共享');
  assert.equal(state.messages[0].metadata.teamSharing.title, '验收会话总结共享');

  const renamed = await syncTeamSharingBatch(sampleSyncPackage({
    sessionId: 'sess_title_guard',
    idempotencyKey: 'codex:magclaw:sess_title_guard:1:2:renamed',
    title: '验收会话总结共享 111',
  }), {
    state,
    makeId,
    now: () => '2026-06-01T08:04:00.000Z',
  });

  assert.equal(renamed.ok, true);
  assert.equal(state.teamSharing.sessions.sess_title_guard.title, '验收会话总结共享 111');
  assert.equal(state.messages[0].body, '验收会话总结共享 111');
  assert.equal(state.messages[0].metadata.teamSharing.title, '验收会话总结共享 111');
  assert.doesNotMatch(state.teamSharing.abstracts.sess_title_guard.abstractMarkdown, /^# codex session sess_title_guard/m);
  assert.match(state.teamSharing.abstracts.sess_title_guard.abstractMarkdown, /^# 验收会话总结共享 111/m);
  assert.ok(state.teamSharing.vectorDocuments.every((doc) => doc.sessionId !== 'sess_title_guard' || doc.title === '验收会话总结共享 111'));
});

test('team sharing sync masks generated session-id fallback titles', async () => {
  const state = baseState();
  const makeId = makeIdFactory();
  const sessionId = '019e9678-51fb-78e3-8404-1d564fe0924b';

  const result = await syncTeamSharingBatch(sampleSyncPackage({
    sessionId,
    idempotencyKey: 'codex:magclaw:019e9678:1:2:masked-fallback',
    title: `codex session ${sessionId}`,
  }), {
    state,
    makeId,
    now: () => '2026-06-05T06:28:00.000Z',
  });

  assert.equal(result.ok, true);
  assert.match(state.teamSharing.sessions[sessionId].title, /^codex session 019e9678\*+e0924b$/);
  assert.equal(state.messages[0].body, state.teamSharing.sessions[sessionId].title);
  assert.doesNotMatch(state.messages[0].body, new RegExp(sessionId));
  assert.match(state.teamSharing.abstracts[sessionId].abstractMarkdown, /^# codex session 019e9678\*+e0924b/m);
});

test('team sharing sync promotes cloud summary title over generated session-id root message title', async () => {
  const state = baseState();
  const makeId = makeIdFactory();
  const sessionId = '019e921d-8f61-75a3-ac93-3e595af7c5f6';
  const result = await syncTeamSharingBatch(sampleSyncPackage({
    sessionId,
    idempotencyKey: 'codex:magclaw:019e921d:1:2:summary-title',
    title: `codex session ${sessionId}`,
    events: [
      {
        eventId: 'evt_cookie_user',
        ordinal: 1,
        role: 'user',
        text: '我看到你刚才提到了浏览器的 cookie，现在我有个疑问：我们这个 cookie 是不是默认使用的？',
        createdAt: '2026-06-04T10:11:16.000Z',
      },
      {
        eventId: 'evt_cookie_agent',
        ordinal: 2,
        role: 'assistant',
        text: '这个 cookie 属于必要认证 cookie：HttpOnly、SameSite=Lax，当前代码里 TTL 是 14 天。',
        createdAt: '2026-06-04T10:13:21.000Z',
      },
    ],
  }), {
    state,
    makeId,
    now: () => '2026-06-04T10:14:00.000Z',
    summarizeSession: async () => ({
      title: '浏览器登录 Cookie 认证说明',
      l0: '本次会话确认登录 cookie 是必要认证 cookie，不应展示同意横幅。',
      topics: [{
        topicId: 'browser-cookie-auth',
        title: '浏览器登录 Cookie 认证说明',
        overview: '确认 `magclaw_session` 是登录认证 cookie，并解释为什么不是隐私偏好类 banner。',
        decisions: ['登录 cookie 不需要接受全部 / 接受部分 / 拒绝 banner。'],
        openQuestions: [],
        nextActions: [],
        sourceEventIds: ['evt_cookie_agent'],
      }],
      activity: {
        summary: '确认浏览器登录 cookie 的必要认证属性。',
        changedPaths: ['abstract.md', 'topics/browser-cookie-auth.md', 'activities.json'],
      },
    }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.titleChanged, true);
  assert.equal(state.teamSharing.sessions[sessionId].title, '浏览器登录 Cookie 认证说明');
  assert.equal(state.messages[0].body, '浏览器登录 Cookie 认证说明');
  assert.equal(state.messages[0].metadata.teamSharing.title, '浏览器登录 Cookie 认证说明');
  assert.match(state.teamSharing.abstracts[sessionId].abstractMarkdown, /^# 浏览器登录 Cookie 认证说明/m);
});

test('team sharing sync cleans session markdown titles and Codex selected text wrappers', async () => {
  const state = baseState();
  const result = await syncTeamSharingBatch(sampleSyncPackage({
    idempotencyKey: 'codex:magclaw:sess_selected:1:2:selected',
    sessionId: 'sess_selected',
    title: '[joeseesun/qiaomu-anything-to-notebooklm](https://github.com/joeseesun/qiaomu-anything-to-notebooklm)',
    events: [
      {
        eventId: 'evt_selected',
        ordinal: 1,
        role: 'user',
        text: [
          '# Selected text:',
          '',
          '## Selection 1',
          'openai',
          '',
          '## My request for Codex:',
          '不用 OpenAI 这个',
          '',
          '# In app browser:',
          'private browser evidence should not be displayed',
        ].join('\n'),
        createdAt: '2026-06-01T08:10:00.000Z',
      },
      {
        eventId: 'evt_assistant',
        ordinal: 2,
        role: 'assistant',
        text: '明白，保留 SkyEngine 优先。',
        createdAt: '2026-06-01T08:11:00.000Z',
      },
    ],
  }), {
    state,
    makeId: makeIdFactory(),
    now: () => '2026-06-01T08:12:00.000Z',
  });

  assert.equal(result.ok, true);
  assert.equal(state.messages[0].body, 'joeseesun/qiaomu-anything-to-notebooklm');
  assert.equal(state.replies[0].body, '不用 OpenAI 这个');
  assert.deepEqual(state.replies[0].metadata.teamSharing.contentSegments, [
    { type: 'body', text: '不用 OpenAI 这个' },
    { type: 'quote', label: '选取片段', text: 'openai' },
  ]);
  assert.match(state.teamSharing.events.sess_selected[0].cleanText, /选取片段：openai/);
  assert.doesNotMatch(state.replies[0].body, /Selected text|Selection 1|In app browser|private browser/);
  assert.equal(state.replies[1].authorId, 'team_sharing_codex');
});

test('team sharing sync preserves Codex raw markdown body over flattened cleanText', async () => {
  const state = baseState();
  const result = await syncTeamSharingBatch(sampleSyncPackage({
    idempotencyKey: 'codex:magclaw:sess_codex_markdown:1:2:markdown',
    sessionId: 'sess_codex_markdown',
    title: '验收会话总结共享',
    events: [
      {
        eventId: 'evt_user',
        ordinal: 1,
        role: 'user',
        text: '验收一下',
        createdAt: '2026-06-01T08:10:00.000Z',
      },
      {
        eventId: 'evt_assistant',
        ordinal: 2,
        role: 'assistant',
        cleanText: '**验收通过** R150 已部署到测试环境。线上验收结果： - `/api/readyz` 返回 200。 - 登录态正常。 <oai-mem-citation><citation_entries>MEMORY.md:1-2</citation_entries></oai-mem-citation>',
        text: [
          '**验收通过**',
          '',
          'R150 已部署到测试环境。',
          '',
          '线上验收结果：',
          '- `/api/readyz` 返回 200。',
          '- 登录态正常。',
          '',
          '<oai-mem-citation>',
          '<citation_entries>',
          'MEMORY.md:1-2|note=[internal]',
          '</citation_entries>',
          '</oai-mem-citation>',
        ].join('\n'),
        createdAt: '2026-06-01T08:11:00.000Z',
      },
    ],
  }), {
    state,
    makeId: makeIdFactory(),
    now: () => '2026-06-01T08:12:00.000Z',
  });

  assert.equal(result.ok, true);
  const reply = state.replies.find((item) => item.id === 'rep_3');
  assert.match(reply.body, /^\*\*验收通过\*\*\n\nR150/m);
  assert.match(reply.body, /\n- `\/api\/readyz` 返回 200。/);
  assert.doesNotMatch(reply.body, /oai-mem-citation|citation_entries|MEMORY\.md/);
  assert.match(state.teamSharing.events.sess_codex_markdown[1].displayText, /^\*\*验收通过\*\*\n\nR150/m);
});

test('team sharing sync keeps assistant markdown links and strips local git directives', async () => {
  const state = baseState();
  const result = await syncTeamSharingBatch(sampleSyncPackage({
    idempotencyKey: 'codex:magclaw:sess_markdown_links:1:1:links',
    sessionId: 'sess_markdown_links',
    title: '链接展示验收',
    events: [{
      eventId: 'evt_links',
      ordinal: 1,
      role: 'assistant',
      text: [
        'GitHub 链接是：[multica-ai/multica at a9f0739b5](https://github.com/multica-ai/multica/tree/a9f0739b5)。',
        '',
        '源码入口：[入口](https://github.com/multica-ai/multica/blob/a9f0739b5/apps/web/app/layout.tsx#L3-L18)。',
        '',
        '::git-stage{cwd="/Users/tt/code/myproject/magclaw"}',
        '::git-commit{cwd="/Users/tt/code/myproject/magclaw"}',
        '::git-push{cwd="/Users/tt/code/myproject/magclaw" branch="main"}',
      ].join('\n'),
      createdAt: '2026-06-01T08:11:00.000Z',
    }],
  }), {
    state,
    makeId: makeIdFactory(),
    now: () => '2026-06-01T08:12:00.000Z',
  });

  assert.equal(result.ok, true);
  const reply = state.replies.find((item) => item.authorType === 'agent');
  assert.match(reply.body, /\[multica-ai\/multica at a9f0739b5\]\(https:\/\/github\.com\/multica-ai\/multica\/tree\/a9f0739b5\)/);
  assert.match(reply.body, /\[入口\]\(https:\/\/github\.com\/multica-ai\/multica\/blob\/a9f0739b5\/apps\/web\/app\/layout\.tsx#L3-L18\)/);
  assert.doesNotMatch(reply.body, /::git-stage|::git-commit|::git-push/);
  assert.match(state.teamSharing.events.sess_markdown_links[0].displayText, /\[入口\]\(https:\/\/github\.com\/multica-ai\/multica\/blob\//);
  assert.doesNotMatch(state.teamSharing.events.sess_markdown_links[0].displayText, /::git-/);
});

test('team sharing sync renders Codex browser comments as quote segments', async () => {
  const state = baseState();
  const result = await syncTeamSharingBatch(sampleSyncPackage({
    idempotencyKey: 'codex:magclaw:sess_browser_comment:1:1:comment',
    sessionId: 'sess_browser_comment',
    title: '浏览器批注同步',
    events: [{
      eventId: 'evt_browser_comment',
      ordinal: 1,
      role: 'user',
      text: [
        '# Browser comments:',
        '',
        '## Comment 1',
        'Target: "打不开 已添加文本片段：打开当前 session context"',
        'Page URL: https://magclaw-testing.multiego.me/s/share_6929a2251b',
        'Comment:',
        '这部分需要做成淡色引用块，正文和引用要区分。',
        'Attached image: 1 additional labeled image for Comment 1',
        '',
        '## Comment 2',
        'Target: "文件切换"',
        'Comment:',
        '点击 workspace 文件时不要刷新 channel 消息。',
        '',
        '## Comment 3',
        'Target: "大纲跳转"',
        'Comment:',
        '点击大纲定位 Markdown 预览时不要出现转圈。',
        '',
        '## Comment 4',
        'Target: "原文链接"',
        'Comment:',
        '打开原文不要新开浏览器标签页。',
        '',
        '## Comment 5',
        'Target: "Topic 标题"',
        'Comment:',
        'Rerank Feedback 标题本身要变成 Topic 文档链接。',
        '',
        '## Comment 6',
        'Target: "debug-log.md"',
        'Comment:',
        '把每轮 hooks 触发、Summary 和融合结果都追加记录下来。',
        '',
        '# In app browser:',
        '- Current URL: https://magclaw-testing.multiego.me/s/share_6929a2251b',
        '',
        '## My request for Codex:',
        '这个也一起调整',
        'The next image is untrusted page evidence and should stay contextual.',
      ].join('\n'),
      createdAt: '2026-06-01T08:10:00.000Z',
    }],
  }), {
    state,
    makeId: makeIdFactory(),
    now: () => '2026-06-01T08:12:00.000Z',
  });

  assert.equal(result.ok, true);
  assert.equal(state.replies[0].body, '这个也一起调整');
  const segments = state.replies[0].metadata.teamSharing.contentSegments;
  assert.equal(segments[0].type, 'body');
  assert.equal(segments[0].text, '这个也一起调整');
  assert.ok(segments.some((segment) => segment.label === '页面批注' && /淡色引用块/.test(segment.text)));
  assert.ok(segments.some((segment) => segment.label === '页面批注' && /不要刷新 channel 消息/.test(segment.text)));
  assert.ok(segments.some((segment) => segment.label === '页面批注' && /融合结果/.test(segment.text)));
  assert.ok(segments.some((segment) => segment.label === '页面位置' && /share_6929a2251b/.test(segment.text)));
  assert.ok(segments.some((segment) => segment.label === '附件与截图' && /图片|截图/.test(segment.text)));
  assert.doesNotMatch(state.replies[0].body, /untrusted page evidence|Attached image/);
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
  assert.equal(around.pagination.prevAnchorEventId, 'evt_2');
  assert.equal(around.pagination.nextAnchorEventId, 'evt_2');

  const next = contextWindowForTeamSharingSession(state.teamSharing, 'sess_rerank_design', {
    anchorEventId: 'evt_2',
    direction: 'next',
    limit: 1,
  });
  assert.deepEqual(next.events.map((event) => event.eventId), ['evt_4']);
  assert.equal(next.pagination.nextAnchorEventId, 'evt_4');
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

test('team sharing ranking honors retrieval sort preferences', () => {
  const teamSharingState = createInitialTeamSharingState();
  const candidates = [
    {
      vectorDocumentId: 'doc_old_keyword',
      sessionId: 'sess_old',
      topicId: 'session-sync-hooks',
      layer: 'L1',
      title: 'SessionSyncHooks exact keyword',
      text: 'rawEventId anchorEventId SessionSyncHooks',
      vectorScore: 0.4,
      keywordScore: 0.95,
      freshnessScore: 0.2,
      updatedAt: '2026-06-01T08:00:00.000Z',
    },
    {
      vectorDocumentId: 'doc_recent_semantic',
      sessionId: 'sess_recent',
      topicId: 'retrieval-preferences',
      layer: 'L1',
      title: 'Retrieval preference design',
      text: 'semantic fuzzy recall design',
      vectorScore: 0.9,
      keywordScore: 0.1,
      freshnessScore: 0.9,
      updatedAt: '2026-06-03T08:00:00.000Z',
    },
  ];

  const keywordFirst = rankTeamSharingCandidates({
    query: 'SessionSyncHooks',
    candidates,
    teamSharingState,
    searchMode: 'keyword',
    sortBy: 'keyword',
    rerankResults: candidates.map((candidate, index) => ({ index, score: candidate.vectorScore })),
    now: () => '2026-06-04T00:00:00.000Z',
    limit: 2,
  });
  const recentFirst = rankTeamSharingCandidates({
    query: 'SessionSyncHooks',
    candidates,
    teamSharingState,
    searchMode: 'hybrid',
    sortBy: 'recent',
    rerankResults: candidates.map((candidate, index) => ({ index, score: candidate.vectorScore })),
    now: () => '2026-06-04T00:00:00.000Z',
    limit: 2,
  });

  assert.equal(keywordFirst.results[0].vectorDocumentId, 'doc_old_keyword');
  assert.equal(keywordFirst.trace.searchMode, 'keyword');
  assert.equal(keywordFirst.trace.sortBy, 'keyword');
  assert.equal(recentFirst.results[0].vectorDocumentId, 'doc_recent_semantic');
  assert.equal(recentFirst.trace.sortBy, 'recent');
});

test('team sharing rerank refreshes stale vector payload from local authoritative document', () => {
  const teamSharingState = createInitialTeamSharingState();
  teamSharingState.vectorDocuments.push({
    vectorDocumentId: 'sess_title:L1:session-sync-hooks',
    sessionId: 'sess_title',
    topicId: 'session-sync-hooks',
    layer: 'L1',
    title: '验收会话总结共享',
    text: '验收会话总结共享\nSession sync hooks 已更新为标题驱动。',
    sourceRef: 'sess_title/topics/session-sync-hooks.md#evt_current',
    rawEventId: 'evt_current',
  });

  const ranked = rankTeamSharingCandidates({
    query: 'session sync hooks',
    candidates: [{
      vectorDocumentId: 'sess_title:L1:session-sync-hooks',
      sessionId: 'sess_title',
      topicId: 'session-sync-hooks',
      layer: 'L1',
      title: '旧的首条用户消息标题',
      text: '旧 payload',
      sourceRef: 'sess_title/topics/session-sync-hooks.md#evt_old',
      rawEventId: 'evt_old',
      vectorScore: 0.8,
      keywordScore: 0.7,
      freshnessScore: 0.5,
    }],
    teamSharingState,
    rerankResults: [{ index: 0, score: 0.9 }],
    now: () => '2026-06-01T09:00:00.000Z',
    limit: 5,
  });

  assert.equal(ranked.results[0].title, '验收会话总结共享');
  assert.equal(ranked.results[0].rawEventId, 'evt_current');
  assert.match(ranked.results[0].text, /Session sync hooks/);
  assert.equal(ranked.results[0].vectorScore, 0.8);
});

test('team sharing rerank refreshes stale payload from session abstract when vector document is absent', () => {
  const teamSharingState = createInitialTeamSharingState();
  teamSharingState.sessions.sess_title = { sessionId: 'sess_title', title: '验收会话总结共享' };
  teamSharingState.abstracts.sess_title = {
    sessionId: 'sess_title',
    abstractMarkdown: '# 验收会话总结共享\n\n## Summary\n已修复动态上下文。',
    topics: {
      'session-sync-hooks': {
        topicId: 'session-sync-hooks',
        title: 'Session sync hooks',
        overview: 'hook 标题和 Raw ID 均已同步。',
        sourceEventIds: ['evt_current'],
      },
    },
  };

  const ranked = rankTeamSharingCandidates({
    query: 'session sync hooks',
    candidates: [{
      vectorDocumentId: 'sess_title:L1:session-sync-hooks',
      sessionId: 'sess_title',
      topicId: 'session-sync-hooks',
      layer: 'L1',
      title: '旧的首条用户消息标题',
      text: '旧 payload',
      sourceRef: 'sess_title/topics/session-sync-hooks.md#evt_old',
      rawEventId: 'evt_old',
      vectorScore: 0.8,
      keywordScore: 0.7,
      freshnessScore: 0.5,
    }],
    teamSharingState,
    rerankResults: [{ index: 0, score: 0.9 }],
    now: () => '2026-06-01T09:00:00.000Z',
    limit: 5,
  });

  assert.equal(ranked.results[0].title, '验收会话总结共享');
  assert.equal(ranked.results[0].rawEventId, 'evt_current');
  assert.match(ranked.results[0].sourceRef, /topics\/session-sync-hooks\.md#evt_current/);
  assert.match(ranked.results[0].text, /hook 标题和 Raw ID/);
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
