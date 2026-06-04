import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCodexLocalDigestPrompt,
  buildTeamSharingSummaryPrompt,
  buildTeamSharingTopicsPromptSection,
  createTeamSharingSummaryClient,
} from '../server/team-sharing-summary.js';
import {
  createInitialTeamSharingState,
  syncTeamSharingBatch,
} from '../server/team-sharing.js';

test('team sharing summary prompt asks for structured L0/L1/raw ids without hidden reasoning', () => {
  const prompt = buildTeamSharingSummaryPrompt({
    session: { sessionId: 'sess_1', title: 'Rerank design' },
    events: [
      { eventId: 'evt_1', role: 'user', cleanText: '我们要讨论 rerank。' },
      { eventId: 'evt_2', role: 'assistant', cleanText: '结论：top5 + hotness。' },
    ],
  });

  assert.match(prompt, /L0/);
  assert.match(prompt, /L1/);
  assert.match(prompt, /activity/);
  assert.match(prompt, /Topics Contract/);
  assert.match(prompt, /sourceEventIds/);
  assert.match(prompt, /总-分-总/);
  assert.match(prompt, /4-6 个编号要点/);
  assert.match(prompt, /不能输出一整段长文本/);
  assert.match(prompt, /不要输出 Source Anchors 大列表/);
  assert.match(prompt, /链接必须独立成行/);
  assert.match(prompt, /Raw ID 要贴近对应结论/);
  assert.match(prompt, /browser comments/);
  assert.match(prompt, /页面批注/);
  assert.match(prompt, /不要编造隐藏思考/);
  assert.match(prompt, /不是写“本 session 围绕某标题”/);
});

test('team sharing local Codex digest prompt asks for useful context without hidden reasoning', () => {
  const prompt = buildCodexLocalDigestPrompt({
    session: { sessionId: 'sess_1', title: 'Rerank design' },
    events: [{ eventId: 'evt_1', role: 'assistant', cleanText: '用了 rg 和 apply_patch，结论是 top5。' }],
  });

  assert.match(prompt, /local Codex session digest writer/);
  assert.match(prompt, /Important Context/);
  assert.match(prompt, /Source Event IDs/);
  assert.match(prompt, /Do not include hidden reasoning/);
  assert.match(buildTeamSharingTopicsPromptSection(), /Do not create a topic for generic session bookkeeping/);
});

test('team sharing summary client parses JSON response from OpenAI-compatible API', async () => {
  const calls = [];
  const client = createTeamSharingSummaryClient({
    baseUrl: 'https://model.example/v1',
    apiKey: 'summary-secret',
    model: 'gpt-summary',
    fetch: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      return {
        ok: true,
        json: async () => ({
          choices: [
            {
              message: {
                content: '```json\n{"title":"Rerank 反馈机制总结","l0":"一句话摘要","topics":[{"topicId":"rerank-feedback","title":"Rerank","overview":"top5 with feedback","decisions":["返回 top5"],"openQuestions":["是否接入 provider rerank"],"nextActions":["写 feedback"],"sourceEventIds":["evt_1","evt_2"]}],"activity":{"action":"merge_summary","summary":"更新 rerank topic。","changedPaths":["abstract.md","topics/rerank-feedback.md","activities.json"]}}\n```',
              },
            },
          ],
        }),
      };
    },
  });

  const result = await client.summarizeSession({
    session: { sessionId: 'sess_1', title: 'Rerank design' },
    events: [{ eventId: 'evt_1', role: 'user', cleanText: 'rerank' }],
  });

  assert.equal(result.ok, true);
  assert.equal(result.title, 'Rerank 反馈机制总结');
  assert.equal(result.l0, '一句话摘要');
  assert.equal(result.topics[0].topicId, 'rerank-feedback');
  assert.deepEqual(result.topics[0].decisions, ['返回 top5']);
  assert.deepEqual(result.topics[0].sourceEventIds, ['evt_1']);
  assert.deepEqual(result.activity.changedPaths, ['abstract.md', 'topics/rerank-feedback.md', 'activities.json']);
  assert.equal(result.activitySummary, '更新 rerank topic。');
  assert.equal(calls[0].url, 'https://model.example/v1/chat/completions');
  assert.equal(calls[0].body.model, 'gpt-summary');
  assert.equal(calls[0].init.headers.authorization, 'Bearer summary-secret');
  assert.doesNotMatch(JSON.stringify(result), /summary-secret/);
});

test('team sharing sync uses injected authoritative summary and falls back safely', async () => {
  const state = {
    connection: { workspaceId: 'ws_test' },
    channels: [{ id: 'chan_team', name: 'team-sharing' }],
    messages: [],
    replies: [],
    teamSharing: createInitialTeamSharingState(),
  };
  const result = await syncTeamSharingBatch({
    runtime: 'codex',
    projectKey: 'magclaw',
    sessionId: 'sess_summary',
    title: 'Rerank summary session',
    channelId: 'chan_team',
    events: [
      { eventId: 'evt_1', ordinal: 1, role: 'user', text: '讨论 rerank。' },
      { eventId: 'evt_2', ordinal: 2, role: 'assistant', text: '结论：top5。' },
    ],
  }, {
    state,
    makeId: (() => {
      let id = 0;
      return (prefix) => `${prefix}_${++id}`;
    })(),
    now: () => '2026-06-01T12:00:00.000Z',
    summarizeSession: async () => ({
      ok: true,
      l0: '讨论明确了 rerank top5 与反馈热度：先向量召回，再重排，并通过打开、引用和有用反馈调整排序。',
      topics: [
        {
          topicId: 'rerank-feedback',
          title: 'Rerank feedback',
          overview: '先向量召回，再 rerank，最后用反馈热度微调。',
          decisions: ['返回 top5'],
          openQuestions: ['确认 rerank provider'],
          nextActions: ['记录 feedback'],
          sourceEventIds: ['evt_1', 'evt_2'],
        },
      ],
      activity: {
        action: 'merge_summary',
        summary: '合并 rerank-feedback 主题摘要。',
        changedPaths: ['abstract.md', 'topics/rerank-feedback.md', 'activities.json'],
      },
    }),
  });

  assert.equal(result.ok, true);
  const abstract = state.teamSharing.abstracts.sess_summary;
  assert.match(abstract.abstractMarkdown, /^# Rerank summary session/m);
  assert.match(abstract.abstractMarkdown, /1\. \*\*本轮诉求\*\*/);
  assert.match(abstract.abstractMarkdown, /\n\s+- 讨论明确了 rerank top5/);
  assert.match(abstract.abstractMarkdown, /Key Topics/);
  assert.match(abstract.abstractMarkdown, /### \[Rerank feedback\]\(topics\/rerank-feedback\.md\)/);
  assert.doesNotMatch(abstract.abstractMarkdown, /打开 Topic 文档/);
  assert.doesNotMatch(abstract.abstractMarkdown, /\| Topic \| Summary \|/);
  assert.doesNotMatch(abstract.abstractMarkdown, /Source Anchors/);
  assert.doesNotMatch(abstract.topics['rerank-feedback'].overviewMarkdown, /Raw IDs|Raw ID:/);
  assert.doesNotMatch(abstract.topics['rerank-feedback'].overviewMarkdown, /evt_2/);
  assert.match(abstract.topics['rerank-feedback'].overviewMarkdown, /Original Context/);
  assert.match(abstract.topics['rerank-feedback'].overviewMarkdown, /\[原文\]\(\/team-sharing\/context\/sess_summary\?anchorEventId=evt_1&limit=21&order=asc\)/);
  assert.match(abstract.topics['rerank-feedback'].overviewMarkdown, /反馈热度微调/);
  assert.match(abstract.topics['rerank-feedback'].overviewMarkdown, /返回 top5/);
  assert.ok(state.teamSharing.activities.some((item) => item.summary === '合并 rerank-feedback 主题摘要。'));
  assert.ok(state.teamSharing.activities.some((item) => item.changedPaths.includes('debug-log.md')));
  assert.match(abstract.debugLogMarkdown, /Abstract Diff/);
});
