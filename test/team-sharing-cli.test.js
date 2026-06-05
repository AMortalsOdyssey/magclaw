import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  parseCli,
} from '../team-sharing/src/cli.js';
import {
  buildTeamSharingOnboardingFeedback,
  renderTeamSharingFeedbackMarkdown,
  renderTeamSharingFeedbackText,
} from '../team-sharing/src/onboarding-feedback.js';
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
  resolveTeamSharingSessionTitle,
  resolveTeamSharingTranscriptPath,
  shareTeamSharingArtifact,
  searchTeamSharing,
  setupTeamSharing,
  statusTeamSharingHooks,
  statusTeamSharingProject,
  statusTeamSharingSkill,
  syncTeamSharingTranscript,
  teamSharingMachineFingerprint,
  teamSharingPaths,
  whoamiTeamSharingProfile,
} from '../team-sharing/src/team-sharing.js';

test('team sharing onboarding feedback renders structured guidance without secrets or local paths', () => {
  const feedback = buildTeamSharingOnboardingFeedback({
    operation: 'setup',
    ok: true,
    project: {
      ok: true,
      configPath: '/Users/secret/project/.magclaw/team-sharing.yaml',
      projectKey: 'magclaw',
      workspaceId: 'ws_team',
      channelPath: 'mc://magclaw/server/ws_team/channel/chan_team?key=route-secret',
      onboardingTarget: {
        serverId: 'ws_team',
        serverSlug: 'team-server',
        serverName: 'Team Server',
        channelId: 'chan_team',
        channelName: 'Team Sharing',
        channelUrl: 'https://magclaw.example/s/team-server/channels/chan_team',
        joinedServer: true,
        joinedChannel: true,
      },
      serverUrl: 'https://magclaw.example',
      loggedIn: true,
    },
    hooks: {
      codex: { ok: true, installed: ['Stop', 'PreCompact', 'SessionStart'] },
      claude: { ok: true, installed: ['Stop', 'SessionEnd', 'PreCompact', 'SessionStart'] },
    },
    skill: {
      ok: true,
      installed: [{ target: 'codex', path: '/Users/secret/project/.agents/skills/magclaw-team-sharing/SKILL.md' }],
    },
    shim: { ok: true, installed: true, path: '/Users/secret/bin/team-sharing' },
  });
  const markdown = renderTeamSharingFeedbackMarkdown(feedback);
  const colored = renderTeamSharingFeedbackText(feedback, { color: true });

  assert.equal(feedback.status, 'ready');
  assert.ok(feedback.sections.some((section) => section.title === '安装结果'));
  assert.ok(feedback.sections.some((section) => section.title === 'Skill 说明'));
  assert.ok(feedback.sections.some((section) => section.title === 'Hooks 功能'));
  assert.ok(feedback.sections.some((section) => section.title === '数据查看'));
  assert.ok(!feedback.sections.some((section) => section.title === 'Usage'));
  assert.deepEqual(feedback.commands, []);
  assert.match(markdown, /^# MagClaw Team Sharing 已安装/m);
  assert.match(markdown, /`magclaw-team-sharing` Skill 已安装/);
  assert.match(markdown, /Hooks 会在会话开始、结束、压缩前等节点自动上报/);
  assert.match(markdown, /\[Team Sharing\]\(https:\/\/magclaw\.example\/s\/team-server\/channels\/chan_team\)/);
  assert.match(markdown, /回到 Codex \/ Claude Code 正常工作/);
  assert.doesNotMatch(markdown, /team-sharing status --target all/);
  assert.doesNotMatch(markdown, /team-sharing whoami/);
  assert.doesNotMatch(markdown, /team-sharing context --session-id <sessionId> --anchor-event-id <eventId>/);
  assert.doesNotMatch(markdown, /--json/);
  assert.doesNotMatch(markdown, /--format markdown/);
  assert.match(markdown, /欢迎使用 MagClaw 的 Team Sharing 功能。$/);
  assert.match(markdown, /Codex: `Stop`, `PreCompact`, `SessionStart`/);
  assert.match(markdown, /Claude Code: `Stop`, `SessionEnd`, `PreCompact`, `SessionStart`/);
  assert.match(colored, /\u001b\[[0-9;]+m/);
  assert.doesNotMatch(markdown, /public by design|route-secret|\/Users\/secret|token|Bearer/i);
});

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

test('team sharing cli parses feedback output format flags', () => {
  const markdown = parseCli([
    'node',
    'team-sharing',
    'setup',
    '--format',
    'markdown',
  ]);
  const json = parseCli([
    'node',
    'team-sharing',
    'doctor',
    '--json',
  ]);

  assert.equal(markdown.flags.format, 'markdown');
  assert.equal(json.flags.format, 'json');
  assert.equal(json.flags.json, true);
});

test('team sharing cli setup prints onboarding guidance by default for piped npm runs', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-setup-output-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-setup-output-home-'));
  await writeFile(path.join(cwd, 'package.json'), '{"name":"setup-output-smoke"}\n');
  const env = {
    ...process.env,
    HOME: home,
    MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon'),
    MAGCLAW_TEAM_SHARING_INSTALL_SHIM: '0',
    CI: '1',
  };

  const result = spawnSync(process.execPath, [
    path.resolve('team-sharing', 'bin', 'team-sharing.js'),
    'setup',
    '--server-url',
    'https://magclaw.example',
    '--workspace-id',
    'ws_team',
    '--channel',
    'chan_team',
    '--no-login',
  ], {
    cwd,
    env,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# MagClaw Team Sharing 已安装/m);
  assert.match(result.stdout, /安装完成后，你已经获得团队上下文检索/);
  assert.doesNotMatch(result.stdout, /team-sharing status --target all/);
  assert.doesNotMatch(result.stdout, /team-sharing whoami/);
  assert.doesNotMatch(result.stdout, /--format markdown/);
  assert.throws(() => JSON.parse(result.stdout));
});

test('team sharing cli setup keeps explicit json output for scripts', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-setup-json-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-setup-json-home-'));
  await writeFile(path.join(cwd, 'package.json'), '{"name":"setup-json-smoke"}\n');
  const env = {
    ...process.env,
    HOME: home,
    MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon'),
    MAGCLAW_TEAM_SHARING_INSTALL_SHIM: '0',
    CI: '1',
  };

  const result = spawnSync(process.execPath, [
    path.resolve('team-sharing', 'bin', 'team-sharing.js'),
    'setup',
    '--server-url',
    'https://magclaw.example',
    '--workspace-id',
    'ws_team',
    '--channel',
    'chan_team',
    '--no-login',
    '--json',
  ], {
    cwd,
    env,
    encoding: 'utf8',
  });
  const parsed = JSON.parse(result.stdout);

  assert.equal(result.status, 0, result.stderr);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.feedback.status, 'ready');
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

test('team sharing cli init infers workspace id from signed MagClaw channel paths', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-path-workspace-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-path-workspace-home-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };

  await initTeamSharingProject({
    cwd,
    channel: 'mc://magclaw/server/ws_from_path/channel/chan_team?key=route-key',
    serverUrl: 'https://magclaw.example',
  }, env);

  const yaml = await readFile(path.join(cwd, '.magclaw', 'team-sharing.yaml'), 'utf8');
  assert.match(yaml, /workspace_id: ws_from_path/);
  assert.match(yaml, /server_url: https:\/\/magclaw\.example/);
});

test('team sharing cli init defaults to MagClaw production server url', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-default-server-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-default-server-home-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };

  const result = await initTeamSharingProject({
    cwd,
    channel: 'mc://magclaw/server/ws_from_path/channel/chan_team?key=route-key',
  }, env);
  const yaml = await readFile(path.join(cwd, '.magclaw', 'team-sharing.yaml'), 'utf8');

  assert.equal(result.serverUrl, 'https://magclaw.multiego.me');
  assert.match(yaml, /server_url: https:\/\/magclaw\.multiego\.me/);
  assert.match(yaml, /workspace_id: ws_from_path/);
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
  assert.match(profileYaml, /token_expires_at: \d{4}-\d{2}-\d{2}T/);
  assert.match(profileYaml, /machine_fingerprint: mfp_[a-f0-9]{64}/);
  assert.equal(paths.projectConfig.includes('.magclaw/team-sharing.yaml'), true);
});

test('team sharing status reports cached login that belongs to another server', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-status-mismatch-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-status-mismatch-home-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };

  await loginTeamSharingProfile({
    token: 'tm_local_secret',
    serverUrl: 'http://127.0.0.1:6543',
    workspaceId: 'local',
  }, env);
  await initTeamSharingProject({
    cwd,
    channel: 'mc://magclaw/server/ws_team/channel/chan_team?key=route-key',
    serverUrl: 'https://magclaw.example',
    projectKey: 'magclaw',
  }, env);

  const status = await statusTeamSharingProject({ cwd }, env);

  assert.equal(status.ok, false);
  assert.equal(status.config.workspace_id, 'ws_team');
  assert.equal(status.loggedIn, false);
  assert.equal(status.authIssue.reason, 'server_mismatch');
  assert.equal(status.authIssue.profileServerUrl, 'http://127.0.0.1:6543');
  assert.equal(status.authIssue.projectServerUrl, 'https://magclaw.example');
});

test('team sharing machine fingerprint is stable across macOS Linux and Windows inputs', () => {
  const darwin = teamSharingMachineFingerprint({
    HOME: '/Users/tester',
    MAGCLAW_TEAM_SHARING_HOSTNAME: 'shared.local',
    MAGCLAW_TEAM_SHARING_PLATFORM: 'darwin',
    MAGCLAW_TEAM_SHARING_ARCH: 'arm64',
  });
  const linux = teamSharingMachineFingerprint({
    HOME: '/home/tester',
    MAGCLAW_TEAM_SHARING_HOSTNAME: 'shared.local',
    MAGCLAW_TEAM_SHARING_PLATFORM: 'linux',
    MAGCLAW_TEAM_SHARING_ARCH: 'x64',
  });
  const windows = teamSharingMachineFingerprint({
    USERPROFILE: 'C:\\Users\\tester',
    MAGCLAW_TEAM_SHARING_HOSTNAME: 'shared.local',
    MAGCLAW_TEAM_SHARING_PLATFORM: 'win32',
    MAGCLAW_TEAM_SHARING_ARCH: 'x64',
  });

  assert.match(darwin, /^mfp_[a-f0-9]{64}$/);
  assert.match(linux, /^mfp_[a-f0-9]{64}$/);
  assert.match(windows, /^mfp_[a-f0-9]{64}$/);
  assert.equal(teamSharingMachineFingerprint({
    HOME: '/home/tester',
    MAGCLAW_TEAM_SHARING_HOSTNAME: 'shared.local',
    MAGCLAW_TEAM_SHARING_PLATFORM: 'linux',
    MAGCLAW_TEAM_SHARING_ARCH: 'x64',
  }), linux);
  assert.notEqual(darwin, linux);
  assert.notEqual(linux, windows);
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
      assert.match(calls.at(-1).body.machineFingerprint, /^mfp_[a-f0-9]{64}$/);
      return { ok: true, json: async () => ({ ok: true, deviceCode: 'dev_1', userCode: 'ABCD-1234', verificationUri: '/team-sharing/auth/approve?user_code=ABCD-1234', expiresAt: '2026-06-02T00:10:00.000Z', intervalMs: 1 }) };
    }
    if (String(url).endsWith('/api/team-sharing/auth/token')) {
      return { ok: true, json: async () => ({ ok: true, status: 'approved', token: 'tm_scoped_secret', tokenExpiresAt: '2026-07-02T00:00:00.000Z', workspaceId: 'ws_team', profile: 'default', user: { id: 'hum_1', email: 'team@example.com' } }) };
    }
    if (String(url).endsWith('/api/team-sharing/auth/whoami')) {
      assert.equal(init.headers.authorization, 'Bearer tm_scoped_secret');
      assert.match(init.headers['x-magclaw-machine-fingerprint'], /^mfp_[a-f0-9]{64}$/);
      return { ok: true, json: async () => ({ ok: true, user: { id: 'hum_1', email: 'team@example.com' }, workspaceId: 'ws_team' }) };
    }
    if (String(url).endsWith('/api/team-sharing/auth/revoke')) {
      assert.equal(init.headers.authorization, 'Bearer tm_scoped_secret');
      assert.match(init.headers['x-magclaw-machine-fingerprint'], /^mfp_[a-f0-9]{64}$/);
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
    assert.equal(login.verificationUrl, 'https://magclaw.example/team-sharing/auth/approve?user_code=ABCD-1234');
    assert.match(cachedProfile, /token_expires_at: 2026-07-02T00:00:00.000Z/);
    assert.match(cachedProfile, /machine_fingerprint: mfp_[a-f0-9]{64}/);
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

test('team sharing interactive commands refresh an expired cached token before requesting data', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-refresh-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-refresh-home-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
  const fingerprint = teamSharingMachineFingerprint(env);
  await loginTeamSharingProfile({
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    token: 'expired-token',
  }, env);
  await initTeamSharingProject({
    cwd,
    channel: 'chan_team',
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    projectKey: 'magclaw',
  }, env);
  const paths = teamSharingPaths({ cwd, env });
  await writeFile(paths.profileConfig, [
    'version: 1',
    'profile: default',
    'server_url: https://magclaw.example',
    'workspace_id: ws_team',
    'token: expired-token',
    'token_expires_at: 2000-01-01T00:00:00.000Z',
    `machine_fingerprint: ${fingerprint}`,
    '',
  ].join('\n'));

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith('/api/team-sharing/auth/start')) {
      assert.equal(calls.at(-1).body.machineFingerprint, fingerprint);
      return { ok: true, json: async () => ({ ok: true, deviceCode: 'dev_refresh', verificationUri: 'https://magclaw.example/team-sharing/auth/approve', expiresAt: '2026-06-02T00:10:00.000Z', intervalMs: 1 }) };
    }
    if (String(url).endsWith('/api/team-sharing/auth/token')) {
      return { ok: true, json: async () => ({ ok: true, status: 'approved', token: 'fresh-token', tokenExpiresAt: '2026-07-02T00:00:00.000Z', workspaceId: 'ws_team', profile: 'default', user: { id: 'hum_1', email: 'team@example.com' } }) };
    }
    if (String(url).endsWith('/api/team-sharing/search')) {
      assert.equal(init.headers.authorization, 'Bearer fresh-token');
      assert.equal(init.headers['x-magclaw-machine-fingerprint'], fingerprint);
      return { ok: true, json: async () => ({ ok: true, results: [], queryId: 'tmq_refresh' }) };
    }
    throw new Error(`unexpected url ${url}`);
  };
  try {
    const result = await searchTeamSharing({ cwd, query: 'rerank', noOpen: true, pollTimeoutMs: 50 }, env);
    const refreshed = await readFile(paths.profileConfig, 'utf8');
    assert.equal(result.ok, true);
    assert.match(refreshed, /token: fresh-token/);
    assert.match(refreshed, /token_expires_at: 2026-07-02T00:00:00.000Z/);
    assert.deepEqual(calls.map((call) => call.url.replace('https://magclaw.example', '')), [
      '/api/team-sharing/auth/start',
      '/api/team-sharing/auth/token',
      '/api/team-sharing/search',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('team sharing interactive commands relogin when cached token belongs to another server', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-mismatch-refresh-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-mismatch-refresh-home-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
  await loginTeamSharingProfile({
    serverUrl: 'http://127.0.0.1:6543',
    workspaceId: 'local',
    token: 'local-token',
  }, env);
  await initTeamSharingProject({
    cwd,
    channel: 'mc://magclaw/server/ws_team/channel/chan_team?key=route-key',
    serverUrl: 'https://magclaw.example',
    projectKey: 'magclaw',
  }, env);

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith('/api/team-sharing/auth/start')) {
      assert.equal(String(url).startsWith('https://magclaw.example/'), true);
      assert.equal(calls.at(-1).body.workspaceId, 'ws_team');
      return { ok: true, json: async () => ({ ok: true, deviceCode: 'dev_mismatch', verificationUri: '/team-sharing/auth/approve?user_code=MISMATCH', intervalMs: 1 }) };
    }
    if (String(url).endsWith('/api/team-sharing/auth/token')) {
      return { ok: true, json: async () => ({ ok: true, status: 'approved', token: 'fresh-remote-token', tokenExpiresAt: '2026-07-02T00:00:00.000Z', workspaceId: 'ws_team', profile: 'default', user: { id: 'hum_1', email: 'team@example.com' } }) };
    }
    if (String(url).endsWith('/api/team-sharing/search')) {
      assert.equal(init.headers.authorization, 'Bearer fresh-remote-token');
      return { ok: true, json: async () => ({ ok: true, results: [], queryId: 'tmq_mismatch' }) };
    }
    throw new Error(`unexpected url ${url}`);
  };
  try {
    const result = await searchTeamSharing({ cwd, query: 'rerank', noOpen: true, pollTimeoutMs: 50 }, env);
    const refreshed = await readFile(teamSharingPaths({ cwd, env }).profileConfig, 'utf8');

    assert.equal(result.ok, true);
    assert.match(refreshed, /server_url: https:\/\/magclaw\.example/);
    assert.match(refreshed, /workspace_id: ws_team/);
    assert.match(refreshed, /token: fresh-remote-token/);
    assert.deepEqual(calls.map((call) => call.url.replace('https://magclaw.example', '')), [
      '/api/team-sharing/auth/start',
      '/api/team-sharing/auth/token',
      '/api/team-sharing/search',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('team sharing hook sync skips expired login without opening browser or uploading', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-expired-sync-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-expired-sync-home-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
  const fingerprint = teamSharingMachineFingerprint(env);
  await loginTeamSharingProfile({
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    token: 'expired-token',
  }, env);
  await initTeamSharingProject({
    cwd,
    channel: 'chan_team',
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    projectKey: 'magclaw',
  }, env);
  const paths = teamSharingPaths({ cwd, env });
  await writeFile(paths.profileConfig, [
    'version: 1',
    'profile: default',
    'server_url: https://magclaw.example',
    'workspace_id: ws_team',
    'token: expired-token',
    'token_expires_at: 2000-01-01T00:00:00.000Z',
    `machine_fingerprint: ${fingerprint}`,
    '',
  ].join('\n'));
  const transcript = path.join(cwd, 'session.jsonl');
  await writeFile(transcript, [
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess_expired', cwd } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '需要同步' }] } }),
  ].join('\n'));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('expired hook sync should not make network requests');
  };
  try {
    const result = await syncTeamSharingTranscript({
      cwd,
      transcript,
      runtime: 'codex',
      hookEvent: 'SessionEnd',
    }, env);
    const auditText = await readFile(paths.projectAuditLog, 'utf8');

    assert.equal(result.ok, true);
    assert.equal(result.empty, true);
    assert.equal(result.reason, 'login_expired');
    assert.match(auditText, /"reason":"login_expired"/);
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
    const first = await syncTeamSharingTranscript({ cwd, transcript, runtime: 'codex' }, { ...env, MAGCLAW_SESSION_TITLE: '验收会话总结共享' });
    const second = await syncTeamSharingTranscript({ cwd, transcript, runtime: 'codex' }, env);
    const cursor = JSON.parse(await readFile(path.join(cwd, '.magclaw', 'team-sharing-cursor.json'), 'utf8'));

    assert.equal(first.ok, true);
    assert.equal(first.appendedEventCount, 2);
    assert.equal(second.ok, true);
    assert.equal(second.empty, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.sessionId, 'sess_cli');
    assert.equal(calls[0].body.title, '验收会话总结共享');
    assert.equal(calls[0].body.fromOrdinal, 1);
    assert.equal(calls[0].body.toOrdinal, 2);
    assert.equal(cursor.sessions.codex.sess_cli.lastOrdinal, 2);
    assert.equal(calls[0].init.headers.authorization, 'Bearer team-sharing-token-secret');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('team sharing cli sync writes local audit records with upload metrics and cloud feedback', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-audit-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-audit-home-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
  await loginTeamSharingProfile({
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    token: 'team-sharing-token-secret',
  }, env);
  await initTeamSharingProject({
    cwd,
    channel: 'mc://magclaw/server/ws_team/channel/chan_team?key=route-secret',
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    projectKey: 'magclaw',
    enabledSince: '2026-06-01T00:00:00.000Z',
  }, env);
  const transcript = path.join(cwd, 'session.jsonl');
  await writeFile(transcript, [
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess_audit', cwd } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '审计上报内容' }] } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '审计上报结果' }] } }),
  ].join('\n'));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    status: 202,
    statusText: 'Accepted',
    json: async () => ({ ok: true, appendedEventCount: 2, abstractRevision: 1, indexedDocumentCount: 2, messageId: 'msg_audit' }),
  });
  try {
    const result = await syncTeamSharingTranscript({ cwd, transcript, runtime: 'codex', hookEvent: 'Stop', integration: 'team-sharing' }, env);
    const auditText = await readFile(path.join(cwd, '.magclaw', 'team-sharing-audit.jsonl'), 'utf8');
    const records = auditText.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const status = await statusTeamSharingProject({ cwd, auditLimit: 1 }, env);

    assert.equal(result.ok, true);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'uploaded');
    assert.equal(records[0].upload.eventCount, 2);
    assert.ok(records[0].upload.charCount > 0);
    assert.equal(records[0].request.statusCode, 202);
    assert.equal(records[0].request.timeout, false);
    assert.equal(records[0].cloud.appendedEventCount, 2);
    assert.equal(records[0].summary.generated, true);
    assert.equal(records[0].summary.cloudAbstractRevision, 1);
    assert.equal(records[0].login.loggedIn, true);
    assert.equal(records[0].login.userEmail, '');
    assert.equal(records[0].upload.content, undefined);
    assert.doesNotMatch(JSON.stringify(records[0]), /team-sharing-token-secret|route-secret/);
    assert.equal(status.audit.latest.status, 'uploaded');
    assert.equal(status.audit.recordCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('team sharing cli sync audits cloud upload failures with status and error detail', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-audit-error-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-audit-error-home-'));
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
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess_audit_error', cwd } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '失败也要审计' }] } }),
  ].join('\n'));

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 504,
    statusText: 'Gateway Timeout',
    json: async () => ({ ok: false, error: 'cloud timeout' }),
  });
  try {
    await assert.rejects(
      () => syncTeamSharingTranscript({ cwd, transcript, runtime: 'codex', hookEvent: 'Stop', integration: 'team-sharing' }, env),
      /cloud timeout/,
    );
    const auditText = await readFile(path.join(cwd, '.magclaw', 'team-sharing-audit.jsonl'), 'utf8');
    const records = auditText.trim().split(/\r?\n/).map((line) => JSON.parse(line));

    assert.equal(records.length, 1);
    assert.equal(records[0].status, 'error');
    assert.equal(records[0].request.statusCode, 504);
    assert.equal(records[0].cloud.response.error, 'cloud timeout');
    assert.equal(records[0].error.status, 504);
    assert.doesNotMatch(JSON.stringify(records[0]), /team-sharing-token-secret/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('team sharing cli sync uploads SessionStart even before transcript messages exist', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-session-start-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-session-start-home-'));
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
  const transcript = path.join(cwd, 'session-start.jsonl');
  await writeFile(transcript, [
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess_session_start', cwd } }),
  ].join('\n'));

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init, body: JSON.parse(init.body || '{}') });
    return {
      ok: true,
      json: async () => ({ ok: true, appendedEventCount: 0, messageId: 'msg_start' }),
    };
  };
  try {
    const result = await syncTeamSharingTranscript({
      cwd,
      transcript,
      runtime: 'codex',
      hookEvent: 'SessionStart',
      sessionTitle: '启动可见 session',
    }, env);
    const cursor = JSON.parse(await readFile(path.join(cwd, '.magclaw', 'team-sharing-cursor.json'), 'utf8'));

    assert.equal(result.ok, true);
    assert.equal(result.empty, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.sessionId, 'sess_session_start');
    assert.equal(calls[0].body.title, '启动可见 session');
    assert.equal(calls[0].body.events.length, 0);
    assert.equal(calls[0].body.metadata.hookEvent, 'SessionStart');
    assert.equal(cursor.sessions.codex.sess_session_start.lastOrdinal, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('team sharing sync falls back to legacy Codex transcript environment variable', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-codex-env-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-codex-env-home-'));
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
  const transcript = path.join(cwd, 'codex-env-session.jsonl');
  await writeFile(transcript, [
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess_codex_env', cwd } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '旧版 env 同步' }] } }),
  ].join('\n'));

  const resolved = resolveTeamSharingTranscriptPath({ runtime: 'codex' }, { ...env, CODEX_SESSION_FILE: transcript });
  const titleEnv = { ...env, CODEX_SESSION_FILE: transcript, CODEX_SESSION_TITLE: 'Codex env title' };
  const result = await syncTeamSharingTranscript({
    cwd,
    runtime: 'codex',
    hookEvent: 'Stop',
    dryRun: true,
  }, titleEnv);

  assert.equal(resolved.path, transcript);
  assert.equal(resolved.source, 'env');
  assert.equal(resolveTeamSharingSessionTitle({ runtime: 'codex' }, titleEnv), 'Codex env title');
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.sessionId, 'sess_codex_env');
  assert.equal(result.title, 'Codex env title');
  assert.equal(result.eventCount, 1);
});

test('team sharing cli sync resolves current Codex session title from session index', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-codex-index-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-codex-index-home-'));
  const codexHome = path.join(home, '.codex');
  const env = {
    HOME: home,
    CODEX_HOME: codexHome,
    MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon'),
  };
  await mkdir(codexHome, { recursive: true });
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
  const sessionId = '019e9678-51fb-78e3-8404-1d564fe0924b';
  const transcript = path.join(cwd, 'codex-index-session.jsonl');
  await writeFile(transcript, [
    JSON.stringify({ timestamp: '2026-06-05T06:28:00.000Z', type: 'session_meta', payload: { id: sessionId, cwd } }),
    JSON.stringify({ timestamp: '2026-06-05T06:28:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '不要拿这句当标题' }] } }),
  ].join('\n'));
  await writeFile(path.join(codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: sessionId, thread_name: '确认 Zilliz BM25 支持', updated_at: '2026-06-05T06:28:55.650242Z' }),
    JSON.stringify({ id: sessionId, thread_name: '确认 Zilliz BM25 支持 renamed', updated_at: '2026-06-05T06:30:00.000000Z' }),
  ].join('\n'));

  const result = await syncTeamSharingTranscript({ cwd, transcript, runtime: 'codex', dryRun: true }, env);

  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.title, '确认 Zilliz BM25 支持 renamed');
  assert.equal(result.eventCount, 1);
});

test('team sharing cli sync reads Codex hook stdin transcript_path when env transcript is empty', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-codex-stdin-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-codex-stdin-home-'));
  const env = {
    ...process.env,
    HOME: home,
    MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon'),
  };
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
  const transcript = path.join(cwd, 'codex-stdin-session.jsonl');
  await writeFile(transcript, [
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess_codex_stdin', cwd } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '新版 stdin 同步' }] } }),
  ].join('\n'));

  const result = spawnSync(process.execPath, [
    path.resolve('team-sharing', 'bin', 'team-sharing.js'),
    'sync',
    '--runtime',
    'codex',
    '--hook-event',
    'Stop',
    '--transcript',
    '',
    '--cwd',
    cwd,
    '--dry-run',
  ], {
    cwd: path.resolve('.'),
    env,
    input: JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'sess_codex_stdin',
      session_title: 'Hook payload title',
      transcript_path: transcript,
      cwd,
    }),
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.sessionId, 'sess_codex_stdin');
  assert.equal(parsed.title, 'Hook payload title');
  assert.equal(parsed.eventCount, 1);
});

test('team sharing cli sync dry-run does not upload or save cursor', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-dry-run-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-dry-run-home-'));
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
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess_dry_run', cwd } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'dry run 问题' }] } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'dry run 回答' }] } }),
  ].join('\n'));

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    throw new Error('dry-run should not upload');
  };
  try {
    const result = await syncTeamSharingTranscript({ cwd, transcript, runtime: 'codex', dryRun: true }, env);
    const auditText = await readFile(path.join(cwd, '.magclaw', 'team-sharing-audit.jsonl'), 'utf8');
    const auditRecord = JSON.parse(auditText.trim());

    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.eventCount, 2);
    assert.equal(result.fromOrdinal, 1);
    assert.equal(result.toOrdinal, 2);
    assert.equal(auditRecord.status, 'dry_run');
    assert.equal(auditRecord.upload.eventCount, 2);
    assert.equal(auditRecord.upload.content, undefined);
    assert.equal(calls.length, 0);
    await assert.rejects(
      readFile(path.join(cwd, '.magclaw', 'team-sharing-cursor.json'), 'utf8'),
      /ENOENT/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('team sharing audit content is opt-in for local debugging', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-audit-content-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-audit-content-home-'));
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
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess_audit_content', cwd } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '需要临时保存审计 payload' }] } }),
  ].join('\n'));

  const result = await syncTeamSharingTranscript({ cwd, transcript, runtime: 'codex', dryRun: true, auditContent: true }, env);
  const auditText = await readFile(path.join(cwd, '.magclaw', 'team-sharing-audit.jsonl'), 'utf8');
  const auditRecord = JSON.parse(auditText.trim());

  assert.equal(result.ok, true);
  assert.equal(auditRecord.status, 'dry_run');
  assert.equal(auditRecord.upload.eventCount, 1);
  assert.equal(auditRecord.upload.content.sessionId, 'sess_audit_content');
  assert.equal(auditRecord.upload.content.events[0].text, '需要临时保存审计 payload');
  assert.doesNotMatch(JSON.stringify(auditRecord), /team-sharing-token-secret/);
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
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].body.events.map((event) => event.text), ['安装后的新问题', '安装后的新回答']);
    assert.equal(calls[0].body.fromOrdinal, 3);
    assert.equal(calls[0].body.toOrdinal, 4);
    assert.equal(second.ok, true);
    assert.equal(calls[1].body.events.length, 0);
    assert.equal(calls[1].body.fromOrdinal, 4);
    assert.equal(calls[1].body.toOrdinal, 4);
    assert.equal(calls[1].body.metadata.titleOnly, true);
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

test('team sharing hook install defaults to the current package binary', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-hooks-source-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-hooks-source-home-'));
  await writeFile(path.join(cwd, 'package.json'), '{"name":"team-sharing-source-fixture"}\n');
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon'), PATH: '' };
  const codexHooks = path.join(home, '.codex', 'hooks.json');
  const sourceCommand = path.resolve('team-sharing', 'bin', 'team-sharing.js');

  const result = await installTeamSharingHooks({
    cwd,
    target: 'codex',
    codexConfig: codexHooks,
  }, env);
  const codex = JSON.parse(await readFile(codexHooks, 'utf8'));
  const command = codex.hooks.Stop[0].hooks.find((hook) => hook.command.includes('--runtime codex')).command;

  assert.equal(result.ok, true);
  assert.match(command, new RegExp(`^${sourceCommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} sync`));
  assert.doesNotMatch(command, /^team-sharing sync/);

  const hooks = await statusTeamSharingHooks({ cwd, target: 'codex', codexConfig: codexHooks }, env);
  assert.equal(hooks.codex.commandChecks.every((check) => check.executable), true);
});

test('team sharing hook install preserves an explicit command override', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-hooks-override-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-hooks-override-home-'));
  await writeFile(path.join(cwd, 'package.json'), '{"name":"team-sharing-override-fixture"}\n');
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
  const codexHooks = path.join(home, '.codex', 'hooks.json');

  const result = await installTeamSharingHooks({
    cwd,
    target: 'codex',
    codexConfig: codexHooks,
    teamSharingCommand: 'team-sharing',
  }, env);
  const codex = JSON.parse(await readFile(codexHooks, 'utf8'));
  const command = codex.hooks.Stop[0].hooks.find((hook) => hook.command.includes('--runtime codex')).command;

  assert.equal(result.ok, true);
  assert.match(command, /^team-sharing sync/);
});

test('team sharing hook install renders Windows-safe command strings', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-hooks-windows-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-hooks-windows-home-'));
  await writeFile(path.join(cwd, 'package.json'), '{"name":"team-sharing-windows-fixture"}\n');
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
  const codexHooks = path.join(home, '.codex', 'hooks.json');

  const result = await installTeamSharingHooks({
    cwd,
    target: 'codex',
    codexConfig: codexHooks,
    platform: 'win32',
    teamSharingCommand: 'C:\\Users\\Agent User\\bin\\team-sharing.cmd',
  }, env);
  const codex = JSON.parse(await readFile(codexHooks, 'utf8'));
  const command = codex.hooks.Stop[0].hooks.find((hook) => hook.command.includes('--runtime codex')).command;

  assert.equal(result.ok, true);
  assert.match(command, /^"C:\\Users\\Agent User\\bin\\team-sharing\.cmd" sync/);
  assert.match(command, /--cwd "/);
  assert.doesNotMatch(command, /\$\{|'/);
  assert.doesNotMatch(command, /--transcript|--session-title/);
});

test('team sharing setup installs selected runtimes and hook removal only removes team-sharing entries', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-setup-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-setup-home-'));
  const binDir = path.join(home, 'bin');
  await writeFile(path.join(cwd, 'package.json'), '{"name":"team-sharing-setup-fixture"}\n');
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
  const skill = await statusTeamSharingSkill({ cwd, target: 'all' }, env);
  const codexConfig = JSON.parse(await readFile(path.join(cwd, '.codex', 'hooks.json'), 'utf8'));
  const claudeConfig = JSON.parse(await readFile(path.join(cwd, '.claude', 'settings.local.json'), 'utf8'));
  const shim = await readFile(path.join(binDir, 'team-sharing'), 'utf8');
  const cmdShim = await readFile(path.join(binDir, 'team-sharing.cmd'), 'utf8');
  const ps1Shim = await readFile(path.join(binDir, 'team-sharing.ps1'), 'utf8');

  assert.equal(result.ok, true);
  assert.equal(result.scope, 'project');
  assert.equal(result.projectDir, cwd);
  assert.equal(result.feedback.status, 'ready');
  assert.ok(result.feedback.sections.some((section) => section.title === 'Skill 说明'));
  assert.ok(result.feedback.sections.some((section) => section.title === 'Hooks 功能'));
  assert.ok(result.feedback.sections.some((section) => section.title === '数据查看'));
  assert.deepEqual(result.feedback.commands, []);
  assert.equal(result.shim.installed, true);
  assert.match(shim, /@magclaw\/team-sharing@latest/);
  assert.match(cmdShim, /team-sharing %\*/);
  assert.match(ps1Shim, /team-sharing @args/);
  assert.equal(hooks.codex.installed.length, 3);
  assert.equal(hooks.claude.installed.length, 4);
  assert.equal(hooks.codex.commandChecks.every((check) => check.executable), true);
  assert.equal(hooks.claude.commandChecks.every((check) => check.executable), true);
  assert.equal(skill.installed.length, 2);
  assert.ok(skill.installed.some((item) => item.path === path.join(cwd, '.agents', 'skills', 'magclaw-team-sharing', 'SKILL.md')));
  assert.ok(skill.installed.some((item) => item.path === path.join(cwd, '.claude', 'skills', 'magclaw-team-sharing', 'SKILL.md')));
  const packageJson = JSON.parse(await readFile(path.resolve('team-sharing', 'package.json'), 'utf8'));
  const skillTemplate = await readFile(path.resolve('team-sharing', 'skills', 'magclaw-team-sharing', 'SKILL.md'), 'utf8');
  const installedSkill = await readFile(path.join(cwd, '.agents', 'skills', 'magclaw-team-sharing', 'SKILL.md'), 'utf8');
  assert.match(skillTemplate, /\{\{TEAM_SHARING_VERSION\}\}/);
  assert.doesNotMatch(installedSkill, /\{\{TEAM_SHARING_VERSION\}\}|\{\{TEAM_SHARING_SOURCE_COMMIT\}\}/);
  assert.match(installedSkill, new RegExp(`package: @magclaw/team-sharing@${packageJson.version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} sourceCommit=`));
  assert.match(installedSkill, /## Answer Style For Search Results/);
  assert.ok(codexConfig.hooks.Stop[0].hooks.some((hook) => hook.command.includes(path.join(binDir, 'team-sharing'))));
  assert.ok(codexConfig.hooks.Stop[0].hooks.some((hook) => hook.command.includes('team-sharing sync')));
  assert.ok(codexConfig.hooks.Stop[0].hooks.every((hook) => !hook.command.includes('${')));
  assert.ok(codexConfig.hooks.Stop[0].hooks.some((hook) => hook.command.includes('--integration team-sharing')));
  assert.ok(codexConfig.hooks.Stop[0].hooks.some((hook) => hook.command.includes('--package-version')));
  assert.ok(codexConfig.hooks.Stop[0].hooks.some((hook) => hook.command.includes('--source-commit')));
  assert.ok(claudeConfig.hooks.SessionEnd[0].hooks.some((hook) => hook.command.includes('--runtime claude_code')));

  const removedHooks = await removeTeamSharingHooks({ cwd, target: 'codex' }, env);
  const afterRemove = JSON.parse(await readFile(path.join(cwd, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(removedHooks.codex.removed.length, 3);
  assert.equal(JSON.stringify(afterRemove).includes('--integration team-sharing'), false);

  const removedSkill = await removeTeamSharingSkill({ cwd, target: 'codex' }, env);
  assert.equal(removedSkill.removed.length, 1);
  await assert.rejects(() => readFile(path.join(cwd, '.agents', 'skills', 'magclaw-team-sharing', 'SKILL.md'), 'utf8'), /ENOENT/);
});

test('team sharing setup logs in against explicit server url and workspace from channel path', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-setup-server-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-setup-server-home-'));
  await writeFile(path.join(cwd, 'package.json'), '{"name":"team-sharing-setup-server-fixture"}\n');
  const env = {
    HOME: home,
    CODEX_HOME: path.join(home, '.codex'),
    MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon'),
    MAGCLAW_TEAM_SHARING_INSTALL_SHIM: '0',
  };
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith('/api/team-sharing/auth/start')) {
      assert.equal(String(url).startsWith('https://magclaw.example/'), true);
      assert.equal(calls.at(-1).body.workspaceId, 'ws_from_path');
      return { ok: true, json: async () => ({ ok: true, deviceCode: 'dev_setup', verificationUri: '/team-sharing/auth/approve?user_code=SETUP', intervalMs: 1 }) };
    }
    if (String(url).endsWith('/api/team-sharing/auth/token')) {
      return { ok: true, json: async () => ({ ok: true, status: 'approved', token: 'tm_setup_secret', tokenExpiresAt: '2026-07-02T00:00:00.000Z', user: { id: 'hum_setup', email: 'team@example.com' } }) };
    }
    throw new Error(`unexpected url ${url}`);
  };
  try {
    const result = await setupTeamSharing({
      cwd,
      yes: true,
      target: 'codex',
      channel: 'mc://magclaw/server/ws_from_path/channel/chan_team?key=route-key',
      serverUrl: 'https://magclaw.example',
      projectKey: 'magclaw',
      noOpen: true,
      pollTimeoutMs: 50,
    }, env);
    const paths = teamSharingPaths({ cwd, env });
    const profileYaml = await readFile(paths.profileConfig, 'utf8');
    const projectYaml = await readFile(paths.projectConfig, 'utf8');

    assert.equal(result.ok, true);
    assert.equal(result.project.serverUrl, 'https://magclaw.example');
    assert.equal(result.project.workspaceId, 'ws_from_path');
    assert.match(profileYaml, /server_url: https:\/\/magclaw\.example/);
    assert.match(profileYaml, /workspace_id: ws_from_path/);
    assert.match(profileYaml, /token: tm_setup_secret/);
    assert.match(projectYaml, /workspace_id: ws_from_path/);
    assert.deepEqual(calls.map((call) => call.url.replace('https://magclaw.example', '')), [
      '/api/team-sharing/auth/start',
      '/api/team-sharing/auth/token',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('team sharing hook status reports missing bare team-sharing command', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-status-command-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-status-command-home-'));
  await writeFile(path.join(cwd, 'package.json'), '{"name":"team-sharing-status-fixture"}\n');
  const env = {
    HOME: home,
    CODEX_HOME: path.join(home, '.codex'),
    MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon'),
    PATH: '',
  };
  await installTeamSharingHooks({
    cwd,
    target: 'codex',
    teamSharingCommand: 'team-sharing',
  }, env);

  const hooks = await statusTeamSharingHooks({ cwd, target: 'codex' }, env);

  assert.equal(hooks.codex.ok, false);
  assert.equal(hooks.codex.installed.length, 3);
  assert.equal(hooks.codex.commandChecks.length, 3);
  assert.equal(hooks.codex.commandChecks[0].executable, false);
  assert.equal(hooks.codex.commandChecks[0].reason, 'command_not_found_in_path');
});

test('team sharing setup reports project scope after init creates a project config', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-setup-new-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-setup-new-home-'));
  const env = {
    HOME: home,
    MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon'),
    MAGCLAW_TEAM_SHARING_INSTALL_SHIM: '0',
  };
  await loginTeamSharingProfile({ token: 'tm_secret', serverUrl: 'https://magclaw.example', workspaceId: 'ws_team' }, env);

  const result = await setupTeamSharing({
    cwd,
    yes: true,
    target: 'codex',
    channel: 'chan_team',
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    projectKey: 'fresh',
    noLogin: true,
  }, env);

  assert.equal(result.ok, true);
  assert.equal(result.scope, 'project');
  assert.equal(result.projectDir, cwd);
  assert.equal(result.hooks.scope, 'project');
  assert.equal(result.skill.scope, 'project');
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
    const search = await searchTeamSharing({
      cwd,
      query: '昨天关于 rerank 结论和 BM25 的验收',
      limit: 5,
      candidateK: 25,
      mode: 'exact',
      keywords: 'rerank、BM25',
      sort: 'recent',
      minScore: 0.2,
      now: '2026-06-04T03:00:00.000Z',
    }, env);
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
    assert.equal(calls[0].body.searchMode, 'hybrid');
    assert.equal(calls[0].body.modeBias, 'keyword');
    assert.equal(calls[0].body.semanticQuery, '昨天关于 rerank 结论和 BM25 的验收');
    assert.deepEqual(calls[0].body.retrievalIntent, {
      useKeyword: true,
      useSemantic: true,
      modeBias: 'keyword',
      source: 'team-sharing-cli',
    });
    assert.ok(calls[0].body.keywords.includes('rerank'));
    assert.ok(calls[0].body.keywords.includes('BM25'));
    assert.ok(calls[0].body.topics.includes('rerank 结论'));
    assert.equal(calls[0].body.timePreference, 'yesterday');
    assert.equal(calls[0].body.sortBy, 'recent');
    assert.equal(calls[0].body.candidateK, 25);
    assert.equal(calls[0].body.minScore, 0.2);
    assert.deepEqual(calls[0].body.dateRange, {
      from: '2026-06-02T16:00:00.000Z',
      to: '2026-06-03T16:00:00.000Z',
    });
    assert.equal(calls[0].init.headers.authorization, 'Bearer team-sharing-token-secret');
    assert.match(calls[1].url, /\/api\/team-sharing\/context\/sess_1\?/);
    assert.match(calls[1].url, /limit=3/);
    assert.match(calls[1].url, /order=asc/);
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
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-skill-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-skill-home-'));
  await writeFile(path.join(cwd, 'package.json'), '{"name":"team-sharing-skill-fixture"}\n');
  const env = { HOME: home, CODEX_HOME: path.join(home, '.codex') };
  const result = await installTeamSharingSkill({ cwd, target: 'codex' }, env);
  const skill = await readFile(path.join(cwd, '.agents', 'skills', 'magclaw-team-sharing', 'SKILL.md'), 'utf8');

  assert.equal(result.ok, true);
  assert.equal(result.scope, 'project');
  assert.equal(result.feedback.status, 'ready');
  assert.match(result.feedback.sections.map((section) => section.title).join(','), /Skill 说明/);
  assert.match(skill, /team-sharing search/);
  assert.match(skill, /team-sharing context/);
  assert.match(skill, /team-sharing share-artifact/);
  assert.match(skill, /--time today/);
  assert.match(skill, /--time yesterday/);
  assert.match(skill, /--keyword/);
  assert.match(skill, /--topics/);
  assert.match(skill, /--semantic-query/);
  assert.match(skill, /--mode keyword/);
  assert.match(skill, /--mode semantic/);
  assert.match(skill, /--keyword-only/);
  assert.match(skill, /keyword\/BM25 and semantic\/vector recall run together/);
  assert.match(skill, /--sort recent/);
  assert.match(skill, /Answer Style For Search Results/);
  assert.match(skill, /Do not expose L0\/L1 as user-facing labels/);
  assert.match(skill, /Markdown table/);
  assert.match(skill, /\*\*验收目标\*\*/);
  assert.match(skill, /\[Abstract\]/);
  assert.match(skill, /\[SessionSyncHooks\]/);
  assert.match(skill, /\[RerankFeedback\]/);
  assert.match(skill, /\[原始会话\]/);
  assert.match(skill, /#team-sharing-workspace-file:abstract\.md/);
  assert.match(skill, /#team-sharing-workspace-file:topics%2Frerank-feedback\.md/);
  assert.match(skill, /Never reuse the original-session `contextUrl`/);
  assert.match(skill, /standalone `\/team-sharing\/context\/<sessionId>` page/);
  assert.match(skill, /访问遵循当前 MagClaw 服务的登录和权限策略/);
  assert.doesNotMatch(skill, /public by design|publicly share/);
  assert.match(skill, /Default Share HTML Style/);
  assert.match(skill, /deep blue-black technical hero/);
  assert.match(skill, /sticky table of contents/);
  assert.match(skill, /white report cards/);
  assert.match(skill, /cyan.*emerald.*amber.*rose/i);
  assert.match(skill, /mobile viewports must not overflow/i);
  assert.doesNotMatch(skill, /team-sharing-token-secret|api_key|Bearer/i);
});

test('team sharing install falls back to user scope when no project can be detected or selected', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-no-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-no-project-home-'));
  const env = { HOME: home, CODEX_HOME: path.join(home, '.codex'), CI: '1' };
  const result = await installTeamSharingSkill({ cwd, target: 'codex' }, env);
  const skill = await readFile(path.join(home, '.codex', 'skills', 'magclaw-team-sharing', 'SKILL.md'), 'utf8');

  assert.equal(result.ok, true);
  assert.equal(result.scope, 'user');
  assert.equal(result.projectDir, '');
  assert.match(skill, /team-sharing search/);
});
