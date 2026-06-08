import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  buildTeamSharingHookCommand,
  buildTeamSharingSyncPackageFromTranscript,
  installTeamSharingHookConfig,
  parseTeamSharingTranscript,
  shouldRunTeamSharingHook,
} from '../team-sharing/src/team-sharing-hooks.js';

test('team sharing hook parser extracts Codex user and assistant messages while dropping tool output', () => {
  const transcript = [
    {
      timestamp: '2026-06-01T12:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: 'codex-session-1',
        cwd: '/repo/magclaw',
        originator: 'Codex Desktop',
      },
    },
    {
      timestamp: '2026-06-01T12:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: '请总结 rerank 方案，token=secret-123' }],
      },
    },
    {
      timestamp: '2026-06-01T12:00:02.000Z',
      type: 'response_item',
      payload: { type: 'function_call', name: 'exec_command', arguments: '{"cmd":"cat secret"}' },
    },
    {
      timestamp: '2026-06-01T12:00:03.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '结论：向量召回后 rerank top5。' }],
      },
    },
    {
      timestamp: '2026-06-01T12:00:04.000Z',
      type: 'response_item',
      payload: { type: 'function_call_output', output: 'secret command output should not upload' },
    },
  ].map((item) => JSON.stringify(item)).join('\n');

  const parsed = parseTeamSharingTranscript(transcript, { runtime: 'codex' });

  assert.equal(parsed.sessionId, 'codex-session-1');
  assert.equal(parsed.projectPath, '/repo/magclaw');
  assert.deepEqual(parsed.toolNames, ['exec_command']);
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.events[0].role, 'user');
  assert.doesNotMatch(parsed.events[0].text, /secret-123|token=/);
  assert.equal(parsed.events[1].role, 'assistant');
  assert.match(parsed.events[1].text, /rerank top5/);
  assert.doesNotMatch(JSON.stringify(parsed), /secret command output|cat secret/);
});

test('team sharing hook parser uses explicit session title and keeps only final assistant reply', () => {
  const transcript = [
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess-title', cwd: '/repo/magclaw' } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '首条用户消息不应该当标题' }] } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '中间进展，不进 Team Sharing' }] } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:03.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '最终回复，进入 Team Sharing' }] } }),
  ].join('\n');

  const parsed = parseTeamSharingTranscript(transcript, { runtime: 'codex', title: '验收会话总结共享' });

  assert.equal(parsed.title, '验收会话总结共享');
  assert.deepEqual(parsed.events.map((event) => event.text), ['首条用户消息不应该当标题', '最终回复，进入 Team Sharing']);
  assert.deepEqual(parsed.events.map((event) => event.ordinal), [1, 3]);
  assert.equal(parsed.events[1].rawEventId, parsed.events[1].eventId);
});

test('team sharing hook parser marks Codex goal replies and preserves each progress reply', () => {
  const transcript = [
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess-goal-progress', cwd: '/repo/magclaw' } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '帮我修复 Team Sharing 登录态' }] } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:02.000Z', type: 'response_item', payload: { type: 'function_call', name: 'create_goal', call_id: 'call_goal_progress', arguments: JSON.stringify({ objective: '修复 Team Sharing 登录态' }) } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:03.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_goal_progress', output: JSON.stringify({ objective: '修复 Team Sharing 登录态', status: 'active' }) } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '我会先改三个核心点：SESSION_TTL_MS、fingerprint、链接保护。' }] } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:05.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已完成并推送：登录态 TTL 和链接鉴权已修复。' }] } }),
  ].join('\n');

  const parsed = parseTeamSharingTranscript(transcript, { runtime: 'codex' });

  assert.deepEqual(parsed.events.map((event) => event.text), [
    '帮我修复 Team Sharing 登录态',
    '我会先改三个核心点：SESSION_TTL_MS、fingerprint、链接保护。',
    '已完成并推送：登录态 TTL 和链接鉴权已修复。',
  ]);
  assert.deepEqual(parsed.events.map((event) => event.ordinal), [1, 4, 5]);
  assert.equal(parsed.events[0].presentation.mode, 'goal');
  assert.equal(parsed.events[1].presentation.mode, 'goal');
  assert.equal(parsed.events[1].presentation.goal.reply, true);
  assert.equal(parsed.events[1].presentation.goal.objective, '修复 Team Sharing 登录态');
  assert.equal(parsed.events[2].presentation.mode, 'goal');
  assert.equal(parsed.events[2].presentation.goal.reply, true);
});

test('team sharing hook parser preserves user guidance while dropping intermediate Codex replies', () => {
  const transcript = [
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess-guidance', cwd: '/repo/magclaw' } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '调研 multica 助手入口' }] } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '这里出现一个值得注意的中间判断，不应该上报。' }] } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:03.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '你把 GitHub 链接也返回给我' }] } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '最终结论：Multica 通过 agent_task_queue 和 provider adapter 接入 Codex。' }] } }),
  ].join('\n');

  const parsed = parseTeamSharingTranscript(transcript, { runtime: 'codex' });

  assert.deepEqual(parsed.events.map((event) => event.role), ['user', 'user', 'assistant']);
  assert.deepEqual(parsed.events.map((event) => event.ordinal), [1, 3, 4]);
  assert.deepEqual(parsed.events.map((event) => event.text), [
    '调研 multica 助手入口',
    '你把 GitHub 链接也返回给我',
    '最终结论：Multica 通过 agent_task_queue 和 provider adapter 接入 Codex。',
  ]);
  assert.doesNotMatch(JSON.stringify(parsed.events), /中间判断/);
});

test('team sharing sync uploads guidance and final reply after an old intermediate cursor', () => {
  const transcript = [
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess-guidance-cursor', cwd: '/repo/magclaw' } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '调研 multica 助手入口' }] } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '中间进展，不再继续上传。' }] } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:03.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '你把 GitHub 链接也返回给我' }] } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '最终回复：GitHub 链接已返回。' }] } }),
  ].join('\n');

  const pkg = buildTeamSharingSyncPackageFromTranscript(transcript, {
    runtime: 'codex',
    projectKey: 'magclaw',
    channelId: 'chan_team',
    lastOrdinal: 2,
    now: () => '2026-06-01T12:00:05.000Z',
  });

  assert.equal(pkg.ok, true);
  assert.deepEqual(pkg.body.events.map((event) => event.text), [
    '你把 GitHub 链接也返回给我',
    '最终回复：GitHub 链接已返回。',
  ]);
  assert.equal(pkg.body.fromOrdinal, 3);
  assert.equal(pkg.body.toOrdinal, 4);
  assert.equal(pkg.cursor.lastOrdinal, 4);
  assert.doesNotMatch(JSON.stringify(pkg.body.events), /中间进展/);
});

test('team sharing hook parser preserves user guidance while dropping intermediate Claude Code replies', () => {
  const transcript = [
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'system', subtype: 'init', session_id: 'claude-guidance', cwd: '/repo/magclaw' }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:01.000Z', type: 'user', message: { content: [{ type: 'text', text: '验收 Team Sharing hook' }] } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:02.000Z', type: 'assistant', message: { content: [{ type: 'text', text: '中间同步状态，不应该上报。' }] } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:03.000Z', type: 'user', message: { content: [{ type: 'text', text: '继续把最后结果整理好' }] } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:04.000Z', type: 'assistant', message: { content: [{ type: 'text', text: '最终回复：hook 已兼容 Claude Code 引导会话。' }] } }),
  ].join('\n');

  const parsed = parseTeamSharingTranscript(transcript, { runtime: 'claude_code' });

  assert.deepEqual(parsed.events.map((event) => event.role), ['user', 'user', 'assistant']);
  assert.deepEqual(parsed.events.map((event) => event.ordinal), [1, 3, 4]);
  assert.deepEqual(parsed.events.map((event) => event.text), [
    '验收 Team Sharing hook',
    '继续把最后结果整理好',
    '最终回复：hook 已兼容 Claude Code 引导会话。',
  ]);
  assert.doesNotMatch(JSON.stringify(parsed.events), /中间同步状态/);
});

test('team sharing hook parser strips Claude Code skill wrappers and keeps project identity', () => {
  const skillPrompt = [
    'Base directory for this skill: /repo/magclaw/.claude/skills/magclaw-team-sharing',
    '<!-- package: @magclaw/team-sharing@0.1.50 sourceCommit=26e0d2432d49 -->',
    '# MagClaw Team Sharing',
    '',
    'Use this skill when the user asks what teammates discussed.',
    '',
    '## Workflow',
    '',
    '1. If the user gives a MagClaw Team Sharing share URL, run `team-sharing read-link "<url>" --format json`.',
    '',
    'ARGUMENTS: In one short sentence, what command should be run first when a MagClaw Team Sharing share URL needs to be read? Do not run tools.',
  ].join('\n');
  const transcript = [
    JSON.stringify({
      timestamp: '2026-06-01T12:00:00.000Z',
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: skillPrompt }] },
      cwd: '/repo/magclaw',
      sessionId: 'baaf80f3-bd6f-4649-81ac-96b013bf7d91',
    }),
    JSON.stringify({
      timestamp: '2026-06-01T12:00:01.000Z',
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Run `team-sharing read-link "<url>" --format json` from the configured project directory.' }] },
      cwd: '/repo/magclaw',
      sessionId: 'baaf80f3-bd6f-4649-81ac-96b013bf7d91',
    }),
  ].join('\n');

  const parsed = parseTeamSharingTranscript(transcript, { runtime: 'claude_code' });

  assert.equal(parsed.sessionId, 'baaf80f3-bd6f-4649-81ac-96b013bf7d91');
  assert.equal(parsed.projectPath, '/repo/magclaw');
  assert.doesNotMatch(parsed.title, /^claude_code session /);
  assert.deepEqual(parsed.events.map((event) => event.role), ['user', 'assistant']);
  assert.match(parsed.events[0].text, /^In one short sentence, what command should be run first/);
  assert.doesNotMatch(parsed.events[0].text, /Base directory|sourceCommit|## Workflow/);
  assert.match(parsed.events[1].text, /team-sharing read-link/);
});

test('team sharing hook parser preserves Claude Code string-content user prompts', () => {
  const transcript = [
    JSON.stringify({
      timestamp: '2026-06-01T12:00:00.000Z',
      type: 'user',
      message: { role: 'user', content: '请只回复这一行：MAGCLAW_CLAUDE_SMOKE_123' },
      cwd: '/repo/magclaw',
      sessionId: '0d4bab5d-8030-4430-b263-c68c2623f9b1',
    }),
    JSON.stringify({
      timestamp: '2026-06-01T12:00:01.000Z',
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'MAGCLAW_CLAUDE_SMOKE_123' }] },
      cwd: '/repo/magclaw',
      sessionId: '0d4bab5d-8030-4430-b263-c68c2623f9b1',
    }),
  ].join('\n');

  const parsed = parseTeamSharingTranscript(transcript, { runtime: 'claude_code' });

  assert.equal(parsed.sessionId, '0d4bab5d-8030-4430-b263-c68c2623f9b1');
  assert.deepEqual(parsed.events.map((event) => event.role), ['user', 'assistant']);
  assert.deepEqual(parsed.events.map((event) => event.text), [
    '请只回复这一行：MAGCLAW_CLAUDE_SMOKE_123',
    'MAGCLAW_CLAUDE_SMOKE_123',
  ]);
});

test('team sharing hook parser extracts Codex plan events and hides implementation prompts', () => {
  const transcript = [
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess-plan', cwd: '/repo/magclaw' } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '帮我为 Team Sharing hooks 写一个计划' }] } }),
    JSON.stringify({
      timestamp: '2026-06-01T12:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{
          type: 'output_text',
          text: '<proposed_plan>\n# Hook Plan\n\n1. 解析 Plan 事件。\n2. 上报结构化 metadata。\n</proposed_plan>',
        }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-01T12:00:03.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: [
            '# In app browser:',
            '- Current URL: https://magclaw-testing.example/channel',
            '',
            '## My request for Codex:',
            'PLEASE IMPLEMENT THIS PLAN:',
            '# Hook Plan',
            '',
            '1. 解析 Plan 事件。',
          ].join('\n'),
        }],
      },
    }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '已完成计划中的 hook 解析。' }] } }),
  ].join('\n');

  const parsed = parseTeamSharingTranscript(transcript, { runtime: 'codex' });

  assert.deepEqual(parsed.events.map((event) => event.role), ['user', 'assistant', 'assistant']);
  assert.equal(parsed.events[1].presentation.mode, 'plan');
  assert.equal(parsed.events[1].presentation.source, 'codex');
  assert.match(parsed.events[1].text, /^# Hook Plan/);
  assert.doesNotMatch(JSON.stringify(parsed.events), /PLEASE IMPLEMENT THIS PLAN|<proposed_plan>/);
});

test('team sharing hook parser pairs Codex request_user_input prompts with answers', () => {
  const transcript = [
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess-interaction', cwd: '/repo/magclaw' } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '先问我计划选项' }] } }),
    JSON.stringify({
      timestamp: '2026-06-01T12:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call',
        name: 'request_user_input',
        call_id: 'call_input_1',
        arguments: JSON.stringify({
          questions: [{
            id: 'scope',
            header: '范围',
            question: '这次先做哪一层？',
            options: [
              { label: 'Hook only', description: '只改 hook 上报。' },
              { label: 'Full stack', description: '连云端展示一起做。' },
            ],
          }],
        }),
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-01T12:00:03.000Z',
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call_input_1',
        output: JSON.stringify({ answers: { scope: { answers: ['Full stack'] } } }),
      },
    }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '我会按 Full stack 继续。' }] } }),
  ].join('\n');

  const parsed = parseTeamSharingTranscript(transcript, { runtime: 'codex' });
  const interaction = parsed.events.find((event) => event.presentation?.mode === 'interaction');

  assert.ok(interaction);
  assert.equal(interaction.role, 'assistant');
  assert.match(interaction.text, /这次先做哪一层/);
  assert.equal(interaction.presentation.source, 'codex');
  assert.equal(interaction.presentation.interaction.questions[0].id, 'scope');
  assert.deepEqual(interaction.presentation.interaction.answers[0].values, ['Full stack']);
  assert.doesNotMatch(JSON.stringify(parsed.events), /function_call_output|call_input_1/);
});

test('team sharing hook parser marks matching Codex goal requests and separates generated goals', () => {
  const matchingTranscript = [
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess-goal-match', cwd: '/repo/magclaw' } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '/goal 调研 Team Sharing Plan Goal 模式并写实现计划' }] } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:02.000Z', type: 'response_item', payload: { type: 'function_call', name: 'create_goal', call_id: 'call_goal_match', arguments: JSON.stringify({ objective: '调研 Team Sharing Plan Goal 模式并写实现计划' }) } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:03.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_goal_match', output: JSON.stringify({ objective: '调研 Team Sharing Plan Goal 模式并写实现计划', status: 'active' }) } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '第一轮执行结果：已定位 hook parser。' }] } }),
  ].join('\n');

  const matching = parseTeamSharingTranscript(matchingTranscript, { runtime: 'codex' });
  assert.equal(matching.events[0].role, 'user');
  assert.equal(matching.events[0].text, '调研 Team Sharing Plan Goal 模式并写实现计划');
  assert.equal(matching.events[0].presentation.mode, 'goal');
  assert.equal(matching.events[0].presentation.goal.source, 'user');
  assert.equal(matching.events[0].presentation.goal.objectiveMatchesUser, true);
  const matchingReply = matching.events.find((event) => event.text === '第一轮执行结果：已定位 hook parser。');
  assert.equal(matchingReply.role, 'assistant');
  assert.equal(matchingReply.presentation.mode, 'goal');
  assert.equal(matchingReply.presentation.goal.reply, true);
  assert.equal(matchingReply.presentation.goal.objective, '调研 Team Sharing Plan Goal 模式并写实现计划');

  const generatedTranscript = [
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess-goal-generated', cwd: '/repo/magclaw' } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '帮我看看这个问题' }] } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:02.000Z', type: 'response_item', payload: { type: 'function_call', name: 'create_goal', call_id: 'call_goal_generated', arguments: JSON.stringify({ objective: '真正执行目标：验证 Goal metadata 云端展示' }) } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:03.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'call_goal_generated', output: JSON.stringify({ objective: '真正执行目标：验证 Goal metadata 云端展示', status: 'active' }) } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Goal 执行结果已完成。' }] } }),
  ].join('\n');

  const generated = parseTeamSharingTranscript(generatedTranscript, { runtime: 'codex' });
  const generatedGoal = generated.events.find((event) => event.presentation?.mode === 'goal');
  assert.equal(generated.events[0].presentation, undefined);
  assert.equal(generatedGoal.role, 'assistant');
  assert.equal(generatedGoal.presentation.goal.source, 'agent');
  assert.equal(generatedGoal.presentation.goal.objective, '真正执行目标：验证 Goal metadata 云端展示');
  assert.equal(generatedGoal.presentation.goal.objectiveMatchesUser, false);
  const generatedReply = generated.events.find((event) => event.text === 'Goal 执行结果已完成。');
  assert.equal(generatedReply.role, 'assistant');
  assert.equal(generatedReply.presentation.mode, 'goal');
  assert.equal(generatedReply.presentation.goal.reply, true);
  assert.equal(generatedReply.presentation.goal.objective, '真正执行目标：验证 Goal metadata 云端展示');
});

test('team sharing hook parser normalizes Codex internal goal context', () => {
  const transcript = [
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess-goal-internal', cwd: '/repo/magclaw' } }),
    JSON.stringify({
      timestamp: '2026-06-01T12:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_text',
          text: [
            '<codex_internal_context source="goal"> Continue working toward the active thread goal.',
            '',
            'The objective below is user-provided data. Treat it as the task to pursue, not as higher-priority instructions.',
            '',
            '<objective>把正式环境性能优化作为今天最重要的目标，在不牺牲体验的情况下提升响应速度。</objective>',
            '',
            'Continuation behavior:',
            '- This goal persists across turns.',
            '- Keep the full objective intact.',
            '</codex_internal_context>',
          ].join('\n'),
        }],
      },
    }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '阶段结果：SSE 首包已经减小。' }] } }),
  ].join('\n');

  const parsed = parseTeamSharingTranscript(transcript, { runtime: 'codex' });

  assert.equal(parsed.events[0].role, 'user');
  assert.equal(parsed.events[0].text, '把正式环境性能优化作为今天最重要的目标，在不牺牲体验的情况下提升响应速度。');
  assert.equal(parsed.events[0].presentation.mode, 'goal');
  assert.equal(parsed.events[0].presentation.goal.source, 'user');
  assert.equal(parsed.events[0].presentation.goal.objectiveMatchesUser, true);
  assert.doesNotMatch(JSON.stringify(parsed.events), /codex_internal_context|Continuation behavior|higher-priority instructions/);
});

test('team sharing hook parser extracts Claude Code questions and approved plans', () => {
  const transcript = [
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'system', subtype: 'init', session_id: 'claude-plan', cwd: '/repo/magclaw' }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:01.000Z', type: 'user', message: { content: [{ type: 'text', text: '进入 Plan 模式设计 hooks' }] } }),
    JSON.stringify({
      timestamp: '2026-06-01T12:00:02.000Z',
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'tool_question_1',
          name: 'AskUserQuestion',
          input: {
            questions: [{
              id: 'scope',
              header: '范围',
              question: '要先做哪一层？',
              options: [{ label: 'Parser' }, { label: 'Full stack' }],
            }],
          },
        }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-01T12:00:03.000Z',
      type: 'user',
      toolUseResult: { answers: { scope: { answers: ['Full stack'] } } },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool_question_1', content: 'Full stack' }] },
    }),
    JSON.stringify({
      timestamp: '2026-06-01T12:00:04.000Z',
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: 'tool_plan_1',
          name: 'ExitPlanMode',
          input: { plan: '# Draft Plan\n\n- 旧草稿' },
        }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-06-01T12:00:05.000Z',
      type: 'user',
      toolUseResult: { plan: '# Approved Plan\n\n- 使用批准后的计划' },
      message: { content: [{ type: 'tool_result', tool_use_id: 'tool_plan_1', content: 'approved' }] },
    }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:06.000Z', type: 'assistant', message: { content: [{ type: 'text', text: '按批准计划执行完成。' }] } }),
  ].join('\n');

  const parsed = parseTeamSharingTranscript(transcript, { runtime: 'claude_code' });
  const interaction = parsed.events.find((event) => event.presentation?.mode === 'interaction');
  const plan = parsed.events.find((event) => event.presentation?.mode === 'plan');

  assert.ok(interaction);
  assert.equal(interaction.presentation.source, 'claude_code');
  assert.match(interaction.text, /要先做哪一层/);
  assert.deepEqual(interaction.presentation.interaction.answers[0].values, ['Full stack']);
  assert.ok(plan);
  assert.equal(plan.presentation.source, 'claude_code');
  assert.match(plan.text, /^# Approved Plan/);
  assert.doesNotMatch(JSON.stringify(parsed.events), /旧草稿|tool_question_1|tool_plan_1/);
});

test('team sharing hook parser preserves Codex final markdown layout', () => {
  const transcript = [
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess-markdown', cwd: '/repo/magclaw' } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '验收一下' }] } }),
    JSON.stringify({
      timestamp: '2026-06-01T12:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{
          type: 'output_text',
          text: [
            '搞定并验收通过了。',
            '',
            '验证结果：',
            '- `node --check` 通过。',
            '- `git diff --check` 通过。',
          ].join('\n'),
        }],
      },
    }),
  ].join('\n');

  const parsed = parseTeamSharingTranscript(transcript, { runtime: 'codex' });

  assert.match(parsed.events[1].text, /搞定并验收通过了。\n\n验证结果：\n- `node --check` 通过。/);
});

test('team sharing hook parser falls back to runtime session title instead of first user message', () => {
  const sessionId = '019e9678-51fb-78e3-8404-1d564fe0924b';
  const transcript = [
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: sessionId, cwd: '/repo/magclaw' } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '这不是标题' }] } }),
  ].join('\n');

  const parsed = parseTeamSharingTranscript(transcript, { runtime: 'codex' });

  assert.match(parsed.title, /^codex session 019e9678\*+e0924b$/);
  assert.doesNotMatch(parsed.title, new RegExp(sessionId));
  assert.doesNotMatch(parsed.title, /这不是标题/);
});

test('team sharing hook parser accepts Codex session names from session metadata', () => {
  const transcript = [
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess-named', cwd: '/repo/magclaw', thread_name: '确认 Zilliz BM25 支持' } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '这仍然不是标题' }] } }),
  ].join('\n');

  const parsed = parseTeamSharingTranscript(transcript, { runtime: 'codex' });

  assert.equal(parsed.title, '确认 Zilliz BM25 支持');
});

test('team sharing sync package creates an empty SessionStart upload for channel visibility', () => {
  const transcript = [
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess-start', cwd: '/repo/magclaw' } }),
  ].join('\n');

  const pkg = buildTeamSharingSyncPackageFromTranscript(transcript, {
    runtime: 'codex',
    projectKey: 'magclaw',
    channelId: 'chan_team',
    hookEvent: 'SessionStart',
    title: '启动可见 session',
    now: () => '2026-06-01T12:00:05.000Z',
  });

  assert.equal(pkg.ok, true);
  assert.equal(pkg.empty, false);
  assert.equal(pkg.sessionStart, true);
  assert.equal(pkg.body.sessionId, 'sess-start');
  assert.equal(pkg.body.events.length, 0);
  assert.equal(pkg.body.fromOrdinal, 0);
  assert.equal(pkg.body.toOrdinal, 0);
  assert.match(pkg.body.idempotencyKey, /^codex:magclaw:sess-start:session-start:/);
  assert.equal(pkg.cursor.lastOrdinal, 0);
});

test('team sharing sync package uploads hook title-only changes without new transcript events', () => {
  const transcript = [
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess-title-only', cwd: '/repo/magclaw' } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '旧消息已经同步过' }] } }),
  ].join('\n');

  const pkg = buildTeamSharingSyncPackageFromTranscript(transcript, {
    runtime: 'codex',
    projectKey: 'magclaw',
    channelId: 'chan_team',
    hookEvent: 'Stop',
    lastOrdinal: 1,
    title: '确认 Zilliz BM25 支持 renamed',
    now: () => '2026-06-01T12:00:05.000Z',
  });

  assert.equal(pkg.ok, true);
  assert.equal(pkg.empty, false);
  assert.equal(pkg.body.sessionId, 'sess-title-only');
  assert.equal(pkg.body.title, '确认 Zilliz BM25 支持 renamed');
  assert.equal(pkg.body.events.length, 0);
  assert.equal(pkg.body.fromOrdinal, 1);
  assert.equal(pkg.body.toOrdinal, 1);
  assert.equal(pkg.body.metadata.titleOnly, true);
  assert.match(pkg.body.idempotencyKey, /^codex:magclaw:sess-title-only:title:1:/);
  assert.equal(pkg.cursor.lastOrdinal, 1);
});

test('team sharing sync package is incremental and idempotent from local cursor', () => {
  const transcript = [
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess-inc', cwd: '/repo/magclaw' } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '第一轮' }] } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '第一轮结论' }] } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:03.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '第二轮' }] } }),
  ].join('\n');

  const pkg = buildTeamSharingSyncPackageFromTranscript(transcript, {
    runtime: 'codex',
    projectKey: 'magclaw',
    channelId: 'chan_team',
    lastOrdinal: 2,
    now: () => '2026-06-01T12:00:05.000Z',
  });

  assert.equal(pkg.ok, true);
  assert.equal(pkg.body.sessionId, 'sess-inc');
  assert.equal(pkg.body.fromOrdinal, 3);
  assert.equal(pkg.body.toOrdinal, 3);
  assert.equal(pkg.body.events.length, 1);
  assert.equal(pkg.body.events[0].text, '第二轮');
  assert.match(pkg.body.idempotencyKey, /^codex:magclaw:sess-inc:3:3:/);
  assert.equal(pkg.cursor.sessionId, 'sess-inc');
  assert.equal(pkg.cursor.lastOrdinal, 3);
  assert.equal(pkg.cursor.lastEventId, pkg.body.events[0].eventId);
});

test('team sharing sync package uploads each Codex goal continuation after cursor advances', () => {
  const goalContext = (createdAt, suffix) => JSON.stringify({
    timestamp: createdAt,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{
        type: 'input_text',
        text: [
          '<codex_internal_context source="goal"> Continue working toward the active thread goal.',
          '<objective>持续优化正式环境响应速度</objective>',
          `Continuation behavior: ${suffix}`,
          '</codex_internal_context>',
        ].join('\n'),
      }],
    },
  });
  const session = JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess-goal-continuations', cwd: '/repo/magclaw' } });
  const firstTranscript = [
    session,
    goalContext('2026-06-01T12:00:01.000Z', 'first run'),
    JSON.stringify({ timestamp: '2026-06-01T12:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '第一阶段结果：SSE 首包只保留 heartbeat。' }] } }),
  ].join('\n');
  const firstPkg = buildTeamSharingSyncPackageFromTranscript(firstTranscript, {
    runtime: 'codex',
    projectKey: 'magclaw',
    channelId: 'chan_team',
    now: () => '2026-06-01T12:00:03.000Z',
  });

  assert.deepEqual(firstPkg.body.events.map((event) => event.text), [
    '持续优化正式环境响应速度',
    '第一阶段结果：SSE 首包只保留 heartbeat。',
  ]);
  assert.equal(firstPkg.body.events[1].presentation.mode, 'goal');
  assert.equal(firstPkg.body.events[1].presentation.goal.reply, true);
  assert.equal(firstPkg.cursor.lastOrdinal, 2);

  const secondTranscript = [
    firstTranscript,
    goalContext('2026-06-01T12:00:04.000Z', 'second run'),
    JSON.stringify({ timestamp: '2026-06-01T12:00:05.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '第二阶段结果：resync 只在必要时触发。' }] } }),
  ].join('\n');
  const secondPkg = buildTeamSharingSyncPackageFromTranscript(secondTranscript, {
    runtime: 'codex',
    projectKey: 'magclaw',
    channelId: 'chan_team',
    lastOrdinal: firstPkg.cursor.lastOrdinal,
    now: () => '2026-06-01T12:00:06.000Z',
  });

  assert.deepEqual(secondPkg.body.events.map((event) => event.text), [
    '持续优化正式环境响应速度',
    '第二阶段结果：resync 只在必要时触发。',
  ]);
  assert.equal(secondPkg.body.events[1].presentation.mode, 'goal');
  assert.equal(secondPkg.body.events[1].presentation.goal.reply, true);
  assert.equal(secondPkg.body.fromOrdinal, 3);
  assert.equal(secondPkg.body.toOrdinal, 4);
  assert.equal(secondPkg.cursor.lastOrdinal, 4);
  assert.doesNotMatch(JSON.stringify(secondPkg.body.events), /第一阶段结果|codex_internal_context|Continuation behavior/);
});

test('team sharing hook command and config installer preserve existing hooks', async () => {
  assert.equal(shouldRunTeamSharingHook({ runtime: 'codex', hookEventName: 'Stop' }), true);
  assert.equal(shouldRunTeamSharingHook({ runtime: 'codex', hookEventName: 'PostToolUse' }), false);
  assert.equal(shouldRunTeamSharingHook({ runtime: 'claude_code', hookEventName: 'SessionEnd' }), true);

  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-hooks-'));
  const hookConfig = path.join(home, '.codex', 'hooks.json');
  await mkdir(path.dirname(hookConfig), { recursive: true });
  await writeFile(hookConfig, JSON.stringify({
    hooks: {
      Stop: [
        {
          hooks: [
            { type: 'command', command: 'echo existing', timeout: 1 },
          ],
        },
      ],
    },
  }, null, 2));

  const command = buildTeamSharingHookCommand({
    runtime: 'codex',
    projectDir: '/repo/magclaw',
    transcriptPath: '/tmp/session.jsonl',
    sessionTitle: 'explicit title',
  });
  assert.match(command, /team-sharing sync/);
  assert.match(command, /--runtime codex/);
  assert.match(command, /--transcript/);
  assert.match(command, /--session-title/);
  assert.doesNotMatch(command, /\n|secret/);

  const defaultHookCommand = buildTeamSharingHookCommand({
    runtime: 'codex',
    projectDir: '/repo/magclaw',
  });
  assert.doesNotMatch(defaultHookCommand, /--transcript|--session-title|\$\{/);

  const windowsCommand = buildTeamSharingHookCommand({
    runtime: 'codex',
    hookEventName: 'Stop',
    platform: 'win32',
    teamSharingCommand: 'C:\\Users\\Agent User\\bin\\team-sharing.cmd',
    projectDir: 'C:\\Users\\Agent User\\repo\\magclaw',
    packageVersion: '0.1.41',
    sourceCommit: 'abc123def456',
  });
  assert.match(windowsCommand, /^"C:\\Users\\Agent User\\bin\\team-sharing\.cmd" sync/);
  assert.match(windowsCommand, /--cwd "C:\\Users\\Agent User\\repo\\magclaw"/);
  assert.match(windowsCommand, /--package-version "0\.1\.41"/);
  assert.doesNotMatch(windowsCommand, /\$\{|'/);

  const result = await installTeamSharingHookConfig({
    runtime: 'codex',
    configPath: hookConfig,
    projectDir: '/repo/magclaw',
    transcriptPath: '/tmp/session.jsonl',
  });
  const installed = JSON.parse(await readFile(hookConfig, 'utf8'));

  assert.equal(result.ok, true);
  assert.equal(installed.hooks.Stop[0].hooks[0].command, 'echo existing');
  assert.ok(installed.hooks.Stop[0].hooks.some((item) => item.command.includes('team-sharing sync')));
  assert.ok(installed.hooks.PreCompact[0].hooks.some((item) => item.command.includes('--hook-event PreCompact')));
  assert.ok(installed.hooks.SessionStart[0].hooks.some((item) => item.command.includes('--hook-event SessionStart')));
});
