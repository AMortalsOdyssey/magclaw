import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  parseCli,
} from '../team-sharing/src/cli.js';
import {
  checkTeamSharingUpgrade,
  installTeamSharingHooks,
  installTeamSharingSkill,
  initTeamSharingProject,
  loginTeamSharingProfile,
  logoutTeamSharingProfile,
  normalizeTeamSharingProjectConfig,
  parseTeamSharingYaml,
  removeTeamSharingHooks,
  removeTeamSharingSkill,
  readTeamSharingContext,
  shareTeamSharingArtifact,
  searchTeamSharing,
  setupTeamSharing,
  statusTeamSharingHooks,
  statusTeamSharingSkill,
  syncTeamSharingTranscript,
  teamSharingPaths,
  whoamiTeamSharingProfile,
} from '../team-sharing/src/team-sharing.js';

test('team sharing cli init writes project config without storing token in repository', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-home-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
  const parsed = parseCli([
    'node',
    'magclaw',
    'team-sharing',
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
  assert.equal(parsed.command, 'team-sharing');
  assert.deepEqual(parsed.flags._, ['init']);

  const result = await initTeamSharingProject({ ...parsed.flags, cwd }, env);
  const yaml = await readFile(path.join(cwd, '.magclaw', 'team-sharing.yaml'), 'utf8');

  assert.equal(result.ok, true);
  assert.match(yaml, /server_url: https:\/\/magclaw\.example/);
  assert.match(yaml, /workspace_id: ws_team/);
  assert.match(yaml, /id: chan_team/);
  assert.match(yaml, /project_key: magclaw/);
  assert.doesNotMatch(yaml, /token|must-not-enter-project/i);
});

test('team sharing cli init treats signed MagClaw channel paths as channelPath, not channelId', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-path-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-path-home-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
  await initTeamSharingProject({
    cwd,
    channel: 'mc://magclaw/server/ws_team/channel/chan_team?key=route-key',
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
  }, env);
  const yaml = await readFile(path.join(cwd, '.magclaw', 'team-sharing.yaml'), 'utf8');
  const parsed = normalizeTeamSharingProjectConfig(parseTeamSharingYaml(yaml));
  const legacyBlankId = normalizeTeamSharingProjectConfig(parseTeamSharingYaml([
    'version: 1',
    'channel:',
    '  id:',
    '  path: mc://magclaw/server/ws_team/channel/chan_team?key=route-key',
  ].join('\n')));

  assert.match(yaml, /id: ""/);
  assert.match(yaml, /path: mc:\/\/magclaw\/server\/ws_team\/channel\/chan_team\?key=route-key/);
  assert.equal(parsed.channelId, '');
  assert.equal(parsed.channelPath, 'mc://magclaw/server/ws_team/channel/chan_team?key=route-key');
  assert.equal(legacyBlankId.channelId, '');
});

test('team sharing cli login stores scoped token in user profile only', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-login-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
  const result = await loginTeamSharingProfile({
    profile: 'team-alpha',
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    token: 'team-sharing-token-secret',
  }, env);
  const paths = teamSharingPaths({ profile: 'team-alpha', env });
  const profileYaml = await readFile(paths.profileConfig, 'utf8');

  assert.equal(result.ok, true);
  assert.match(profileYaml, /server_url: https:\/\/magclaw\.example/);
  assert.match(profileYaml, /workspace_id: ws_team/);
  assert.match(profileYaml, /token: team-sharing-token-secret/);
  assert.equal(paths.projectConfig.includes('.magclaw/team-sharing.yaml'), true);
});

test('team sharing init writes editable yaml config and user project registry', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-init-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-init-home-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };

  const result = await initTeamSharingProject({
    cwd,
    channel: 'mc://magclaw/server/ws_team/channel/chan_team?key=route-key',
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    projectKey: 'magclaw',
    profile: 'team-alpha',
    enabledSince: '2026-06-02T00:00:00.000Z',
  }, env);
  const paths = teamSharingPaths({ profile: 'team-alpha', cwd, env });
  const yaml = await readFile(paths.projectConfig, 'utf8');
  const registry = await readFile(paths.projectsConfig, 'utf8');

  assert.equal(result.ok, true);
  assert.match(yaml, /project_key: magclaw/);
  assert.match(yaml, /channel:/);
  assert.match(yaml, /path: mc:\/\/magclaw\/server\/ws_team\/channel\/chan_team\?key=route-key/);
  assert.match(yaml, /enabled_since: 2026-06-02T00:00:00.000Z/);
  assert.doesNotMatch(yaml, /token|api_key|secret/i);
  assert.match(registry, /magclaw/);
  assert.match(registry, new RegExp(cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('team sharing browser login caches scoped token, whoami reads it, and logout removes it', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-login-home-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith('/api/team-sharing/auth/start')) {
      return { ok: true, json: async () => ({ ok: true, deviceCode: 'dev_1', userCode: 'ABCD-1234', verificationUri: 'https://magclaw.example/login/device', expiresAt: '2026-06-02T00:10:00.000Z', intervalMs: 1 }) };
    }
    if (String(url).endsWith('/api/team-sharing/auth/token')) {
      return { ok: true, json: async () => ({ ok: true, status: 'approved', token: 'tm_scoped_secret', workspaceId: 'ws_team', profile: 'default', user: { id: 'hum_1', email: 'team@example.com' } }) };
    }
    if (String(url).endsWith('/api/team-sharing/auth/whoami')) {
      assert.equal(init.headers.authorization, 'Bearer tm_scoped_secret');
      return { ok: true, json: async () => ({ ok: true, user: { id: 'hum_1', email: 'team@example.com' }, workspaceId: 'ws_team' }) };
    }
    if (String(url).endsWith('/api/team-sharing/auth/revoke')) {
      assert.equal(init.headers.authorization, 'Bearer tm_scoped_secret');
      return { ok: true, json: async () => ({ ok: true, revoked: true }) };
    }
    throw new Error(`unexpected url ${url}`);
  };
  try {
    const login = await loginTeamSharingProfile({
      serverUrl: 'https://magclaw.example',
      workspaceId: 'ws_team',
      noOpen: true,
      pollTimeoutMs: 50,
    }, env);
    const paths = teamSharingPaths({ env });
    const cachedProfile = await readFile(paths.profileConfig, 'utf8');
    const whoami = await whoamiTeamSharingProfile({}, env);
    const logout = await logoutTeamSharingProfile({}, env);

    assert.equal(login.ok, true);
    assert.equal(login.hasToken, true);
    assert.match(cachedProfile, /team_sharing:sync,team_sharing:search,team_sharing:context,team_sharing:feedback,team_sharing:share/);
    assert.equal(whoami.user.email, 'team@example.com');
    assert.equal(logout.ok, true);
    await assert.rejects(() => readFile(paths.profileConfig, 'utf8'), /ENOENT/);
    assert.deepEqual(calls.map((call) => call.url.replace('https://magclaw.example', '')), [
      '/api/team-sharing/auth/start',
      '/api/team-sharing/auth/token',
      '/api/team-sharing/auth/whoami',
      '/api/team-sharing/auth/revoke',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('team sharing cli sync uploads only new transcript events and saves cursor', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-sync-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-sync-home-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
  await loginTeamSharingProfile({
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    token: 'team-sharing-token-secret',
  }, env);
  await initTeamSharingProject({
    cwd,
    channel: 'chan_team',
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    projectKey: 'magclaw',
    enabledSince: '2026-06-01T00:00:00.000Z',
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
    const first = await syncTeamSharingTranscript({ cwd, transcript, runtime: 'codex' }, env);
    const second = await syncTeamSharingTranscript({ cwd, transcript, runtime: 'codex' }, env);
    const cursor = JSON.parse(await readFile(path.join(cwd, '.magclaw', 'team-sharing-cursor.json'), 'utf8'));

    assert.equal(first.ok, true);
    assert.equal(first.appendedEventCount, 2);
    assert.equal(second.ok, true);
    assert.equal(second.empty, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.sessionId, 'sess_cli');
    assert.equal(calls[0].body.fromOrdinal, 1);
    assert.equal(calls[0].body.toOrdinal, 2);
    assert.equal(cursor.sessions.codex.sess_cli.lastOrdinal, 2);
    assert.equal(calls[0].init.headers.authorization, 'Bearer team-sharing-token-secret');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('team sharing sync skips pre-enable history and uploads only new events from old sessions', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-no-backfill-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-no-backfill-home-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
  await loginTeamSharingProfile({
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    token: 'team-sharing-token-secret',
  }, env);
  await initTeamSharingProject({
    cwd,
    channel: 'chan_team',
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    projectKey: 'magclaw',
    enabledSince: '2026-06-02T00:00:00.000Z',
  }, env);
  const transcript = path.join(cwd, 'session.jsonl');
  await writeFile(transcript, [
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess_old', cwd } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '安装前的问题' }] } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '安装前的回答' }] } }),
    JSON.stringify({ timestamp: '2026-06-02T00:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '安装后的新问题' }] } }),
    JSON.stringify({ timestamp: '2026-06-02T00:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '安装后的新回答' }] } }),
  ].join('\n'));

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init, body: JSON.parse(init.body || '{}') });
    return { ok: true, json: async () => ({ ok: true, appendedEventCount: calls[calls.length - 1].body.events.length }) };
  };
  try {
    const result = await syncTeamSharingTranscript({ cwd, transcript, runtime: 'codex', hookEvent: 'Stop', integration: 'team-sharing' }, env);
    const second = await syncTeamSharingTranscript({ cwd, transcript, runtime: 'codex', hookEvent: 'Stop', integration: 'team-sharing' }, env);
    const cursor = JSON.parse(await readFile(path.join(cwd, '.magclaw', 'team-sharing-cursor.json'), 'utf8'));

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body.events.map((event) => event.text), ['安装后的新问题', '安装后的新回答']);
    assert.equal(calls[0].body.fromOrdinal, 3);
    assert.equal(calls[0].body.toOrdinal, 4);
    assert.equal(second.empty, true);
    assert.equal(cursor.sessions.codex.sess_old.lastOrdinal, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('team sharing cli installs Codex and Claude hook configs without overwriting existing entries', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-hooks-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-hooks-home-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
  const codexHooks = path.join(home, '.codex', 'hooks.json');
  const claudeSettings = path.join(home, '.claude', 'settings.json');

  const result = await installTeamSharingHooks({
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

test('team sharing setup installs selected runtimes and hook removal only removes team-sharing entries', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-setup-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-setup-home-'));
  const binDir = path.join(home, 'bin');
  const env = {
    HOME: home,
    CODEX_HOME: path.join(home, '.codex'),
    CLAUDE_HOME: path.join(home, '.claude'),
    MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon'),
  };
  await loginTeamSharingProfile({ token: 'tm_secret', serverUrl: 'https://magclaw.example', workspaceId: 'ws_team' }, env);
  const result = await setupTeamSharing({
    cwd,
    yes: true,
    target: 'all',
    channel: 'chan_team',
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    projectKey: 'magclaw',
    noLogin: true,
    binDir,
  }, env);
  const hooks = await statusTeamSharingHooks({ cwd, target: 'all' }, env);
  const skill = await statusTeamSharingSkill({ target: 'all' }, env);
  const codexConfig = JSON.parse(await readFile(path.join(home, '.codex', 'hooks.json'), 'utf8'));
  const shim = await readFile(path.join(binDir, 'team-sharing'), 'utf8');

  assert.equal(result.ok, true);
  assert.equal(result.shim.installed, true);
  assert.match(shim, /@magclaw\/team-sharing@latest/);
  assert.equal(hooks.codex.installed.length, 3);
  assert.equal(hooks.claude.installed.length, 4);
  assert.equal(skill.installed.length, 2);
  assert.ok(codexConfig.hooks.Stop[0].hooks.some((hook) => hook.command.includes(path.join(binDir, 'team-sharing'))));
  assert.ok(codexConfig.hooks.Stop[0].hooks.some((hook) => hook.command.includes('team-sharing sync')));
  assert.ok(codexConfig.hooks.Stop[0].hooks.some((hook) => hook.command.includes('--integration team-sharing')));

  const removedHooks = await removeTeamSharingHooks({ target: 'codex' }, env);
  const afterRemove = JSON.parse(await readFile(path.join(home, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(removedHooks.codex.removed.length, 3);
  assert.equal(JSON.stringify(afterRemove).includes('--integration team-sharing'), false);

  const removedSkill = await removeTeamSharingSkill({ target: 'codex' }, env);
  assert.equal(removedSkill.removed.length, 1);
  await assert.rejects(() => readFile(path.join(home, '.codex', 'skills', 'magclaw-team-sharing', 'SKILL.md'), 'utf8'), /ENOENT/);
});

test('team sharing upgrade check uses npm cache ttl and reports newer versions', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-upgrade-home-'));
  const env = { HOME: home, MAGCLAW_TEAM_SHARING_VERSION: '0.1.37' };
  let nowMs = 1000;
  let fetchCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCount += 1;
    assert.match(String(url), /registry\.npmjs\.org\/%40magclaw%2Fteam-sharing/i);
    return { ok: true, json: async () => ({ 'dist-tags': { latest: '0.1.38' } }) };
  };
  try {
    const first = await checkTeamSharingUpgrade({ nowMs: () => nowMs }, env);
    const second = await checkTeamSharingUpgrade({ nowMs: () => nowMs + 60_000 }, env);
    const third = await checkTeamSharingUpgrade({ nowMs: () => nowMs + 25 * 60 * 60 * 1000 }, env);
    assert.equal(first.upgradeAvailable, true);
    assert.equal(first.latestVersion, '0.1.38');
    assert.equal(second.fromCache, true);
    assert.equal(third.fromCache, false);
    assert.equal(fetchCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('team sharing cli search and context use configured profile token', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-search-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-search-home-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
  await loginTeamSharingProfile({
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    token: 'team-sharing-token-secret',
  }, env);
  await initTeamSharingProject({
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
    const search = await searchTeamSharing({ cwd, query: 'rerank 结论', limit: 5 }, env);
    const context = await readTeamSharingContext({
      cwd,
      sessionId: 'sess_1',
      anchorEventId: 'evt_1',
      direction: 'around',
      limit: 3,
    }, env);

    assert.equal(search.ok, true);
    assert.equal(search.results[0].evidence, 'top5 结论');
    assert.equal(context.events[0].cleanText, '原文片段');
    assert.equal(calls[0].url, 'https://magclaw.example/api/team-sharing/search');
    assert.equal(calls[0].body.channelId, 'chan_team');
    assert.equal(calls[0].body.projectKey, 'magclaw');
    assert.equal(calls[0].init.headers.authorization, 'Bearer team-sharing-token-secret');
    assert.match(calls[1].url, /\/api\/team-sharing\/context\/sess_1\?/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('team sharing cli uploads an artifact share and returns a public link', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-share-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-share-home-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
  await loginTeamSharingProfile({
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    token: 'team-sharing-token-secret',
  }, env);
  await initTeamSharingProject({
    cwd,
    channel: 'chan_team',
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    projectKey: 'magclaw',
  }, env);
  const artifact = path.join(cwd, 'rerank-summary.md');
  await writeFile(artifact, '# Rerank 总结\n\n先召回，再重排。');
  const parsed = parseCli([
    'node',
    'magclaw',
    'team-sharing',
    'share-artifact',
    '--file',
    artifact,
    '--title',
    'Rerank 总结',
    '--type',
    'markdown',
  ]);
  assert.equal(parsed.command, 'team-sharing');
  assert.deepEqual(parsed.flags._, ['share-artifact']);

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body || '{}') });
    return {
      ok: true,
      json: async () => ({ ok: true, shareId: 'share_cli', url: 'https://magclaw.example/s/share_cli' }),
    };
  };
  try {
    const result = await shareTeamSharingArtifact({
      ...parsed.flags,
      cwd,
    }, env);

    assert.equal(result.ok, true);
    assert.equal(result.url, 'https://magclaw.example/s/share_cli');
    assert.equal(calls[0].url, 'https://magclaw.example/api/team-sharing/shares');
    assert.equal(calls[0].init.headers.authorization, 'Bearer team-sharing-token-secret');
    assert.equal(calls[0].body.title, 'Rerank 总结');
    assert.equal(calls[0].body.contentType, 'markdown');
    assert.match(calls[0].body.content, /先召回/);
    assert.equal(calls[0].body.projectKey, 'magclaw');
    assert.equal(calls[0].body.channelId, 'chan_team');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('team sharing cli infers artifact title and type from local documents', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-share-infer-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-share-infer-home-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
  await loginTeamSharingProfile({
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    token: 'team-sharing-token-secret',
  }, env);
  await initTeamSharingProject({
    cwd,
    channel: 'mc://magclaw/server/ws_team/channel/chan_team?key=route-key',
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    projectKey: 'magclaw',
  }, env);
  const artifact = path.join(cwd, 'discussion.md');
  await writeFile(artifact, '# 团队分享总结\n\n这是一份 Markdown 文档。');

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body || '{}') });
    return {
      ok: true,
      json: async () => ({ ok: true, shareId: 'share_infer', url: 'https://magclaw.example/s/share_infer' }),
    };
  };
  try {
    const result = await shareTeamSharingArtifact({ file: artifact, cwd }, env);
    assert.equal(result.ok, true);
    assert.equal(calls[0].body.title, '团队分享总结');
    assert.equal(calls[0].body.contentType, 'markdown');
    assert.equal(calls[0].body.channelPath, 'mc://magclaw/server/ws_team/channel/chan_team?key=route-key');
    assert.equal(calls[0].body.channelId, '');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('team sharing cli installs a local skill without writing token into skill files', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-skill-home-'));
  const env = { HOME: home, CODEX_HOME: path.join(home, '.codex') };
  const result = await installTeamSharingSkill({ target: 'codex' }, env);
    const skill = await readFile(path.join(home, '.codex', 'skills', 'magclaw-team-sharing', 'SKILL.md'), 'utf8');

  assert.equal(result.ok, true);
  assert.match(skill, /team-sharing search/);
  assert.match(skill, /team-sharing context/);
  assert.match(skill, /team-sharing share-artifact/);
  assert.match(skill, /Default Share HTML Style/);
  assert.match(skill, /deep blue-black technical hero/);
  assert.match(skill, /sticky table of contents/);
  assert.match(skill, /white report cards/);
  assert.match(skill, /cyan.*emerald.*amber.*rose/i);
  assert.match(skill, /mobile viewports must not overflow/i);
  assert.doesNotMatch(skill, /team-sharing-token-secret|api_key|Bearer/i);
});
