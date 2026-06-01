import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  installTeamMemoryHooks,
  installTeamMemorySkill,
  initTeamMemoryProject,
  loginTeamMemoryProfile,
  parseCli,
  readTeamMemoryContext,
  searchTeamMemory,
  syncTeamMemoryTranscript,
  teamMemoryPaths,
} from '../cli-core/src/cli.js';

test('team memory cli init writes project config without storing token in repository', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-memory-cli-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-memory-cli-home-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
  const parsed = parseCli([
    'node',
    'magclaw',
    'memory',
    'init',
    '--channel',
    'chan_team',
    '--server-url',
    'https://magclaw.example',
    '--workspace-id',
    'ws_team',
    '--project-key',
    'magclaw',
    '--token',
    'must-not-enter-project',
  ]);
  assert.equal(parsed.command, 'memory');
  assert.deepEqual(parsed.flags._, ['init']);

  const result = await initTeamMemoryProject({ ...parsed.flags, cwd }, env);
  const projectConfig = JSON.parse(await readFile(path.join(cwd, '.magclaw', 'team-memory.json'), 'utf8'));

  assert.equal(result.ok, true);
  assert.equal(projectConfig.serverUrl, 'https://magclaw.example');
  assert.equal(projectConfig.workspaceId, 'ws_team');
  assert.equal(projectConfig.channelId, 'chan_team');
  assert.equal(projectConfig.projectKey, 'magclaw');
  assert.equal(projectConfig.token, undefined);
  assert.doesNotMatch(JSON.stringify(projectConfig), /must-not-enter-project/);
});

test('team memory cli init treats signed MagClaw channel paths as channelPath, not channelId', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-memory-cli-path-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-memory-cli-path-home-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
  await initTeamMemoryProject({
    cwd,
    channel: 'mc://magclaw/server/ws_team/channel/chan_team?key=route-key',
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
  }, env);
  const projectConfig = JSON.parse(await readFile(path.join(cwd, '.magclaw', 'team-memory.json'), 'utf8'));

  assert.equal(projectConfig.channelId, '');
  assert.equal(projectConfig.channelPath, 'mc://magclaw/server/ws_team/channel/chan_team?key=route-key');
});

test('team memory cli login stores scoped token in user profile only', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-memory-cli-login-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
  const result = await loginTeamMemoryProfile({
    profile: 'team-alpha',
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    token: 'memory-token-secret',
  }, env);
  const paths = teamMemoryPaths({ profile: 'team-alpha', env });
  const profile = JSON.parse(await readFile(paths.profileConfig, 'utf8'));

  assert.equal(result.ok, true);
  assert.equal(profile.serverUrl, 'https://magclaw.example');
  assert.equal(profile.workspaceId, 'ws_team');
  assert.equal(profile.token, 'memory-token-secret');
  assert.equal(paths.projectConfig.includes('.magclaw/team-memory.json'), true);
});

test('team memory cli sync uploads only new transcript events and saves cursor', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-memory-cli-sync-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-memory-cli-sync-home-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
  await loginTeamMemoryProfile({
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    token: 'memory-token-secret',
  }, env);
  await initTeamMemoryProject({
    cwd,
    channel: 'chan_team',
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    projectKey: 'magclaw',
  }, env);
  const transcript = path.join(cwd, 'session.jsonl');
  await writeFile(transcript, [
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess_cli', cwd } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '同步第一轮' }] } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '第一轮完成' }] } }),
  ].join('\n'));

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init, body: JSON.parse(init.body || '{}') });
    return {
      ok: true,
      json: async () => ({ ok: true, appendedEventCount: calls[calls.length - 1].body.events.length }),
    };
  };
  try {
    const first = await syncTeamMemoryTranscript({ cwd, transcript, runtime: 'codex' }, env);
    const second = await syncTeamMemoryTranscript({ cwd, transcript, runtime: 'codex' }, env);
    const cursor = JSON.parse(await readFile(path.join(cwd, '.magclaw', 'team-memory-cursor.json'), 'utf8'));

    assert.equal(first.ok, true);
    assert.equal(first.appendedEventCount, 2);
    assert.equal(second.ok, true);
    assert.equal(second.empty, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.sessionId, 'sess_cli');
    assert.equal(calls[0].body.fromOrdinal, 1);
    assert.equal(calls[0].body.toOrdinal, 2);
    assert.equal(cursor.sessions.codex.sess_cli.lastOrdinal, 2);
    assert.equal(calls[0].init.headers.authorization, 'Bearer memory-token-secret');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('team memory cli installs Codex and Claude hook configs without overwriting existing entries', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-memory-cli-hooks-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-memory-cli-hooks-home-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
  const codexHooks = path.join(home, '.codex', 'hooks.json');
  const claudeSettings = path.join(home, '.claude', 'settings.json');

  const result = await installTeamMemoryHooks({
    cwd,
    codexConfig: codexHooks,
    claudeConfig: claudeSettings,
  }, env);
  const codex = JSON.parse(await readFile(codexHooks, 'utf8'));
  const claude = JSON.parse(await readFile(claudeSettings, 'utf8'));

  assert.equal(result.ok, true);
  assert.equal(result.codex.ok, true);
  assert.equal(result.claude.ok, true);
  assert.ok(codex.hooks.Stop[0].hooks.some((hook) => hook.command.includes('--runtime codex')));
  assert.ok(claude.hooks.SessionEnd[0].hooks.some((hook) => hook.command.includes('--runtime claude_code')));
});

test('team memory cli search and context use configured profile token', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-memory-cli-search-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-memory-cli-search-home-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
  await loginTeamMemoryProfile({
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    token: 'memory-token-secret',
  }, env);
  await initTeamMemoryProject({
    cwd,
    channel: 'chan_team',
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    projectKey: 'magclaw',
  }, env);

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init, body: init.body ? JSON.parse(init.body) : null });
    return {
      ok: true,
      json: async () => (
        String(url).includes('/context/')
          ? { ok: true, sessionId: 'sess_1', events: [{ eventId: 'evt_1', cleanText: '原文片段' }] }
          : { ok: true, results: [{ sessionId: 'sess_1', title: 'Rerank', evidence: 'top5 结论' }] }
      ),
    };
  };
  try {
    const search = await searchTeamMemory({ cwd, query: 'rerank 结论', limit: 5 }, env);
    const context = await readTeamMemoryContext({
      cwd,
      sessionId: 'sess_1',
      anchorEventId: 'evt_1',
      direction: 'around',
      limit: 3,
    }, env);

    assert.equal(search.ok, true);
    assert.equal(search.results[0].evidence, 'top5 结论');
    assert.equal(context.events[0].cleanText, '原文片段');
    assert.equal(calls[0].url, 'https://magclaw.example/api/team-memory/search');
    assert.equal(calls[0].body.channelId, 'chan_team');
    assert.equal(calls[0].body.projectKey, 'magclaw');
    assert.equal(calls[0].init.headers.authorization, 'Bearer memory-token-secret');
    assert.match(calls[1].url, /\/api\/team-memory\/context\/sess_1\?/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('team memory cli installs a local skill without writing token into skill files', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-memory-skill-home-'));
  const env = { HOME: home, CODEX_HOME: path.join(home, '.codex') };
  const result = await installTeamMemorySkill({ target: 'codex' }, env);
  const skill = await readFile(path.join(home, '.codex', 'skills', 'magclaw-team-memory', 'SKILL.md'), 'utf8');

  assert.equal(result.ok, true);
  assert.match(skill, /magclaw memory search/);
  assert.match(skill, /magclaw memory context/);
  assert.doesNotMatch(skill, /memory-token-secret|api_key|Bearer/i);
});
