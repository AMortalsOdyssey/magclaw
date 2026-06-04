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
  assert.deepEqual(parsed.events.map((event) => event.ordinal), [1, 2]);
  assert.equal(parsed.events[1].rawEventId, parsed.events[1].eventId);
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
  const transcript = [
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess-no-title', cwd: '/repo/magclaw' } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '这不是标题' }] } }),
  ].join('\n');

  const parsed = parseTeamSharingTranscript(transcript, { runtime: 'codex' });

  assert.equal(parsed.title, 'codex session sess-no-title');
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
