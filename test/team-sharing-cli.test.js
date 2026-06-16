import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
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
  deleteTeamSharingLink,
  editTeamSharingLink,
  alignKnowledgeConsensus,
  askKnowledgeConsensusCommand,
  editKnowledgeConsensus,
  exportKnowledgeConsensus,
  importKnowledgeConsensus,
  installTeamSharingHooks,
  installTeamSharingSkill,
  initTeamSharingProject,
  listTeamSharingProjects,
  listTeamSharingLinks,
  loginTeamSharingProfile,
  logoutTeamSharingProfile,
  normalizeTeamSharingProjectConfig,
  parseTeamSharingYaml,
  removeTeamSharingHooks,
  removeTeamSharingSkill,
  readTeamSharingLink,
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
  updateTeamSharingPackage,
  maybeAutoUpdateTeamSharingPackage,
  getTeamSharingSessionReporting,
  setTeamSharingSessionReporting,
  teamSharingMachineFingerprint,
  teamSharingPaths,
  formatTeamSharingReadLinkResult,
  whoamiTeamSharingProfile,
} from '../team-sharing/src/team-sharing.js';

function escapeRegExp(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server.address());
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function startJsonServer(handler) {
  const server = http.createServer(async (req, res) => {
    try {
      await handler(req, res, await readRequestBody(req));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(error?.message || error) }));
    }
  });
  const address = await listen(server);
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => closeServer(server),
  };
}

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
      installed: [{ target: 'codex', type: 'codex_plugin', path: '/Users/secret/plugin/magclaw-team-sharing' }],
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
  assert.match(markdown, /Codex 已安装 `magclaw-team-sharing` 插件集合/);
  assert.match(markdown, /新开一个 Codex thread/);
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

test('team sharing cli help lists Knowledge consensus commands', () => {
  const result = spawnSync(process.execPath, [
    path.resolve('team-sharing', 'bin', 'team-sharing.js'),
    'help',
  ], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /import-consensus/);
  assert.match(result.stdout, /ask-consensus/);
  assert.match(result.stdout, /edit-consensus/);
  assert.match(result.stdout, /align-consensus/);
  assert.match(result.stdout, /export-consensus/);
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
    MAGCLAW_TEAM_SHARING_SKIP_CODEX_PLUGIN_COMMAND: '1',
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
    MAGCLAW_TEAM_SHARING_SKIP_CODEX_PLUGIN_COMMAND: '1',
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

test('team sharing session reporting override persists only hashed local identifiers', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-session-reporting-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-session-reporting-home-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
  const transcript = path.join(cwd, 'private-session.jsonl');

  const disabled = await setTeamSharingSessionReporting({
    cwd,
    runtime: 'codex',
    sessionId: 'sess_private_optout',
    transcript,
    report: false,
    ttlHours: 24,
  }, env);
  const paths = teamSharingPaths({ cwd, env });
  const raw = await readFile(paths.sessionOverrides, 'utf8');
  const status = await getTeamSharingSessionReporting({
    cwd,
    runtime: 'codex',
    sessionId: 'sess_private_optout',
    transcript,
  }, env);

  assert.equal(disabled.ok, true);
  assert.equal(disabled.report, false);
  assert.equal(disabled.expiresAt, '');
  assert.equal(status.ok, true);
  assert.equal(status.report, false);
  assert.equal(status.reason, 'user_disabled');
  assert.match(raw, /"sessionIdHash"/);
  assert.match(raw, /"transcriptPathHash"/);
  assert.doesNotMatch(raw, /expiresAt|ttl/i);
  assert.doesNotMatch(raw, /sess_private_optout|private-session|magclaw-team-sharing-session-reporting-project/);
});

test('team sharing session reporting store is stable across profile switches', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-session-reporting-profile-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-session-reporting-profile-home-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
  const transcript = path.join(cwd, 'profile-independent-session.jsonl');

  const alpha = teamSharingPaths({ profile: 'alpha', cwd, env });
  const beta = teamSharingPaths({ profile: 'beta', cwd, env });
  const disabled = await setTeamSharingSessionReporting({
    profile: 'alpha',
    cwd,
    runtime: 'codex',
    sessionId: 'sess_profile_independent',
    transcript,
    report: false,
  }, env);
  const status = await getTeamSharingSessionReporting({
    profile: 'beta',
    cwd,
    runtime: 'codex',
    sessionId: 'sess_profile_independent',
    transcript,
  }, env);
  const raw = await readFile(beta.sessionOverrides, 'utf8');

  assert.equal(alpha.sessionOverrides, beta.sessionOverrides);
  assert.equal(alpha.sessionOverrides, path.join(home, '.magclaw', 'team-sharing', 'session-overrides.json'));
  assert.equal(disabled.sessionOverrides, alpha.sessionOverrides);
  assert.equal(status.report, false);
  assert.equal(status.reason, 'user_disabled');
  assert.doesNotMatch(raw, /alpha|beta|sess_profile_independent|profile-independent-session/);
});

test('team sharing hook sync reads the same session override store after a profile switch', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-session-hook-profile-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-session-hook-profile-home-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
  await loginTeamSharingProfile({
    profile: 'hook-alpha',
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    token: 'team-sharing-token-alpha',
  }, env);
  await loginTeamSharingProfile({
    profile: 'hook-beta',
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    token: 'team-sharing-token-beta',
  }, env);
  await initTeamSharingProject({
    profile: 'hook-beta',
    cwd,
    channel: 'chan_team',
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    projectKey: 'magclaw',
    enabledSince: '2026-06-01T00:00:00.000Z',
  }, env);
  const transcript = path.join(cwd, 'session.jsonl');
  await writeFile(transcript, [
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess_profile_hook', cwd } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '这一轮应该被本地配置跳过。' }] } }),
  ].join('\n'));
  await setTeamSharingSessionReporting({
    profile: 'hook-alpha',
    cwd,
    runtime: 'codex',
    sessionId: 'sess_profile_hook',
    transcript,
    report: false,
  }, env);

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    throw new Error('profile-independent session override should skip before upload');
  };
  try {
    const result = await syncTeamSharingTranscript({
      profile: 'hook-beta',
      cwd,
      transcript,
      runtime: 'codex',
      hookEvent: 'Stop',
      integration: 'team-sharing',
    }, env);
    const paths = teamSharingPaths({ profile: 'hook-beta', cwd, env });
    const auditRecord = JSON.parse((await readFile(paths.projectAuditLog, 'utf8')).trim());

    assert.equal(result.ok, true);
    assert.equal(result.empty, true);
    assert.equal(result.reason, 'session_reporting_disabled');
    assert.equal(calls.length, 0);
    assert.equal(auditRecord.phase, 'session_reporting');
    assert.equal(auditRecord.sessionReporting.matched, true);
    assert.equal(result.sessionReporting.sessionOverrides, path.join(home, '.magclaw', 'team-sharing', 'session-overrides.json'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('team sharing hook sync understands natural-language session opt-out before upload', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-natural-no-report-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-natural-no-report-home-'));
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
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess_natural_no_report', cwd } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '这个 session 不上报就可以了。' }] } }),
  ].join('\n'));

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    throw new Error('natural-language session opt-out should not upload');
  };
  try {
    const result = await syncTeamSharingTranscript({
      cwd,
      transcript,
      runtime: 'codex',
      hookEvent: 'Stop',
      integration: 'team-sharing',
    }, env);
    const paths = teamSharingPaths({ cwd, env });
    const auditRecord = JSON.parse((await readFile(paths.projectAuditLog, 'utf8')).trim());
    const overrideRaw = await readFile(paths.sessionOverrides, 'utf8');

    assert.equal(result.ok, true);
    assert.equal(result.empty, true);
    assert.equal(result.reason, 'session_reporting_disabled');
    assert.equal(result.sessionReporting.intent, 'disable');
    assert.equal(calls.length, 0);
    assert.equal(auditRecord.status, 'skipped');
    assert.equal(auditRecord.phase, 'session_reporting');
    assert.equal(auditRecord.sessionReporting.intent, 'disable');
    assert.doesNotMatch(overrideRaw, /sess_natural_no_report|session\.jsonl|team-sharing-token-secret/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('team sharing hook sync resumes from natural-language report-on message only', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-natural-report-on-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-natural-report-on-home-'));
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
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess_natural_report_on', cwd } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '先讨论一个不会上报的隐私方案。' }] } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '这段仍然不应该进入 MagClaw。' }] } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:03.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '这个 session 可以进行 magclaw 上报。' }] } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:04.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '恢复后第一条回答。' }] } }),
  ].join('\n'));
  await setTeamSharingSessionReporting({
    cwd,
    transcript,
    runtime: 'codex',
    sessionId: 'sess_natural_report_on',
    report: false,
  }, env);

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init, body: JSON.parse(init.body || '{}') });
    return {
      ok: true,
      status: 202,
      statusText: 'Accepted',
      json: async () => ({ ok: true, appendedEventCount: calls[calls.length - 1].body.events.length }),
    };
  };
  try {
    const result = await syncTeamSharingTranscript({
      cwd,
      transcript,
      runtime: 'codex',
      hookEvent: 'Stop',
      integration: 'team-sharing',
    }, env);
    const paths = teamSharingPaths({ cwd, env });
    const cursor = JSON.parse(await readFile(paths.projectCursor, 'utf8'));
    const reporting = await getTeamSharingSessionReporting({
      cwd,
      transcript,
      runtime: 'codex',
      sessionId: 'sess_natural_report_on',
    }, env);

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.fromOrdinal, 3);
    assert.deepEqual(calls[0].body.events.map((event) => event.text), [
      '这个 session 可以进行 magclaw 上报。',
      '恢复后第一条回答。',
    ]);
    assert.doesNotMatch(JSON.stringify(calls[0].body.events), /隐私方案|仍然不应该进入/);
    assert.equal(cursor.sessions.codex.sess_natural_report_on.lastOrdinal, 4);
    assert.equal(reporting.report, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('team sharing hook sync disables reporting for the current session before upload', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-session-no-report-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-session-no-report-home-'));
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
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess_no_report', cwd } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '这轮不要上报' }] } }),
  ].join('\n'));

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init });
    throw new Error('session opt-out hook sync should not upload');
  };
  try {
    const first = await syncTeamSharingTranscript({
      cwd,
      transcript,
      runtime: 'codex',
      hookEvent: 'SessionStart',
      integration: 'team-sharing',
    }, { ...env, MAGCLAW_TEAM_SHARING_REPORT: '0' });
    const second = await syncTeamSharingTranscript({
      cwd,
      transcript,
      runtime: 'codex',
      hookEvent: 'Stop',
      integration: 'team-sharing',
    }, env);
    const paths = teamSharingPaths({ cwd, env });
    const auditText = await readFile(paths.projectAuditLog, 'utf8');
    const auditRecords = auditText.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const overrideRaw = await readFile(paths.sessionOverrides, 'utf8');

    assert.equal(first.ok, true);
    assert.equal(first.empty, true);
    assert.equal(first.reason, 'session_reporting_disabled');
    assert.equal(second.ok, true);
    assert.equal(second.empty, true);
    assert.equal(second.reason, 'session_reporting_disabled');
    assert.equal(calls.length, 0);
    assert.equal(auditRecords.length, 2);
    assert.equal(auditRecords[0].status, 'skipped');
    assert.equal(auditRecords[0].phase, 'session_reporting');
    assert.equal(auditRecords[0].reason, 'session_reporting_disabled');
    assert.equal(auditRecords[1].phase, 'session_reporting');
    assert.doesNotMatch(overrideRaw, /sess_no_report|session\.jsonl|team-sharing-token-secret/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('team sharing session-reporting command toggles a local session override', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-session-reporting-command-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-session-reporting-command-home-'));
  const env = {
    ...process.env,
    HOME: home,
    MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon'),
  };
  const transcript = path.join(cwd, 'session.jsonl');
  await writeFile(transcript, '');

  const off = spawnSync(process.execPath, [
    path.resolve('team-sharing', 'bin', 'team-sharing.js'),
    'session-reporting',
    'off',
    '--runtime',
    'codex',
    '--session-id',
    'sess_cli_optout',
    '--transcript',
    transcript,
    '--cwd',
    cwd,
  ], { cwd: path.resolve('.'), env, encoding: 'utf8' });
  const status = spawnSync(process.execPath, [
    path.resolve('team-sharing', 'bin', 'team-sharing.js'),
    'session-reporting',
    'status',
    '--runtime',
    'codex',
    '--session-id',
    'sess_cli_optout',
    '--transcript',
    transcript,
    '--cwd',
    cwd,
  ], { cwd: path.resolve('.'), env, encoding: 'utf8' });
  const on = spawnSync(process.execPath, [
    path.resolve('team-sharing', 'bin', 'team-sharing.js'),
    'session-reporting',
    'on',
    '--runtime',
    'codex',
    '--session-id',
    'sess_cli_optout',
    '--transcript',
    transcript,
    '--cwd',
    cwd,
  ], { cwd: path.resolve('.'), env, encoding: 'utf8' });

  assert.equal(off.status, 0, off.stderr);
  assert.equal(status.status, 0, status.stderr);
  assert.equal(on.status, 0, on.stderr);
  assert.equal(JSON.parse(off.stdout).report, false);
  assert.equal(JSON.parse(status.stdout).report, false);
  assert.equal(JSON.parse(on.stdout).report, true);
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
  assert.equal(path.normalize(paths.projectConfig).endsWith(path.join('.magclaw', 'team-sharing.yaml')), true);
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
  const registryConfig = parseTeamSharingYaml(registry);
  assert.ok(Object.values(registryConfig.projects || {}).some((project) => project.path === cwd));
});

test('team sharing project registry keeps same-name projects as distinct entries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-registry-root-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-registry-home-'));
  const left = path.join(root, 'left', 'app');
  const right = path.join(root, 'right', 'app');
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
  await mkdir(left, { recursive: true });
  await mkdir(right, { recursive: true });

  await initTeamSharingProject({
    cwd: left,
    channel: 'chan_left',
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    projectKey: 'app',
  }, env);
  await initTeamSharingProject({
    cwd: right,
    channel: 'chan_right',
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    projectKey: 'app',
  }, env);

  const listed = await listTeamSharingProjects({}, env);
  const projects = Object.values(listed.projects);
  assert.equal(projects.length, 2);
  assert.deepEqual(projects.map((item) => item.path).sort(), [left, right].sort());
  assert.equal(new Set(Object.keys(listed.projects)).size, 2);
  assert.ok(Object.keys(listed.projects).every((key) => /^app-[a-f0-9]{8,16}$/.test(key)));
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

test('team sharing browser login carries configured project channel path for approval onboarding', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-login-project-path-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-login-project-path-home-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
  const channelPath = 'mc://magclaw/server/ws_team/channel/chan_team?key=route-key';
  await initTeamSharingProject({
    cwd,
    channel: channelPath,
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    projectKey: 'magclaw',
  }, env);

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    if (String(url).endsWith('/api/team-sharing/auth/start')) {
      assert.equal(String(url).startsWith('https://magclaw.example/'), true);
      assert.equal(calls.at(-1).body.workspaceId, 'ws_team');
      assert.equal(calls.at(-1).body.channelPath, channelPath);
      return { ok: true, json: async () => ({ ok: true, deviceCode: 'dev_project_path', userCode: 'PATH-1234', verificationUri: '/team-sharing/auth/approve?user_code=PATH-1234', expiresAt: '2026-06-02T00:10:00.000Z', intervalMs: 1 }) };
    }
    if (String(url).endsWith('/api/team-sharing/auth/token')) {
      return { ok: true, json: async () => ({
        ok: true,
        status: 'approved',
        token: 'tm_project_path_secret',
        tokenExpiresAt: '2026-07-02T00:00:00.000Z',
        workspaceId: 'ws_team',
        profile: 'default',
        user: { id: 'hum_1', email: 'team@example.com' },
        onboardingTarget: {
          serverId: 'ws_team',
          serverSlug: 'team-server',
          channelId: 'chan_team',
          channelName: 'team-sharing',
          channelUrl: 'https://magclaw.example/s/team-server/channels/chan_team',
        },
      }) };
    }
    throw new Error(`unexpected url ${url}`);
  };
  try {
    const login = await loginTeamSharingProfile({ cwd, noOpen: true, pollTimeoutMs: 50 }, env);

    assert.equal(login.ok, true);
    assert.equal(login.serverUrl, 'https://magclaw.example');
    assert.equal(login.workspaceId, 'ws_team');
    assert.equal(login.onboardingTarget.channelUrl, 'https://magclaw.example/s/team-server/channels/chan_team');
    assert.deepEqual(calls.map((call) => call.url.replace('https://magclaw.example', '')), [
      '/api/team-sharing/auth/start',
      '/api/team-sharing/auth/token',
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

test('team sharing hook sync skips Claude transcript paths that are not written yet', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-missing-claude-transcript-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-missing-claude-transcript-home-'));
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
  const transcript = path.join(cwd, 'claude-session-not-yet-written.jsonl');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error('missing transcript hook sync should not make network requests');
  };
  try {
    const result = await syncTeamSharingTranscript({
      cwd,
      runtime: 'claude_code',
      hookEvent: 'SessionEnd',
      hookPayload: {
        hook_event_name: 'SessionEnd',
        session_id: 'sess_missing_claude_transcript',
        transcript_path: transcript,
      },
    }, env);
    const auditText = await readFile(path.join(cwd, '.magclaw', 'team-sharing-audit.jsonl'), 'utf8');
    const auditRecord = JSON.parse(auditText.trim());

    assert.equal(result.ok, true);
    assert.equal(result.empty, true);
    assert.equal(result.reason, 'transcript_file_missing');
    assert.equal(auditRecord.status, 'skipped');
    assert.equal(auditRecord.phase, 'read_transcript');
    assert.equal(auditRecord.reason, 'transcript_file_missing');
    assert.equal(auditRecord.trigger.runtime, 'claude_code');
    assert.equal(auditRecord.trigger.hookEvent, 'SessionEnd');
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
    const packageJson = JSON.parse(await readFile(path.resolve('team-sharing', 'package.json'), 'utf8'));

    assert.equal(first.ok, true);
    assert.equal(first.appendedEventCount, 2);
    assert.equal(second.ok, true);
    assert.equal(second.empty, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.sessionId, 'sess_cli');
    assert.equal(calls[0].body.title, '验收会话总结共享');
    assert.equal(calls[0].body.fromOrdinal, 1);
    assert.equal(calls[0].body.toOrdinal, 2);
    assert.equal(calls[0].body.metadata.packageVersion, packageJson.version);
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

test('team sharing cli sync skips empty SessionStart before transcript messages exist', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-empty-session-start-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-empty-session-start-home-'));
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
    throw new Error('empty SessionStart should not upload before any transcript event exists');
  };
  try {
    const result = await syncTeamSharingTranscript({
      cwd,
      transcript,
      runtime: 'codex',
      hookEvent: 'SessionStart',
      sessionTitle: '启动可见 session',
    }, env);
    const auditRecord = JSON.parse((await readFile(path.join(cwd, '.magclaw', 'team-sharing-audit.jsonl'), 'utf8')).trim());

    assert.equal(result.ok, true);
    assert.equal(result.empty, true);
    assert.equal(result.reason, 'empty_session_start');
    assert.equal(calls.length, 0);
    assert.equal(auditRecord.status, 'skipped');
    assert.equal(auditRecord.phase, 'build_package');
    assert.equal(auditRecord.reason, 'empty_session_start');
    await assert.rejects(
      () => readFile(path.join(cwd, '.magclaw', 'team-sharing-cursor.json'), 'utf8'),
      /ENOENT/,
    );
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

test('team sharing cli sync redacts local paths and accounts from uploads and audit content', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-privacy-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-privacy-home-'));
  const env = { HOME: home, USERPROFILE: String.raw`C:\Users\tt`, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
  const windowsProject = String.raw`D:\公司\正式项目\memory-experiment`;
  const macProject = '/Users/tt/code/myproject/magclaw';
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
    projectKey: 'memory-experiment',
    enabledSince: '2026-06-01T00:00:00.000Z',
  }, env);
  const transcript = path.join(cwd, 'session.jsonl');
  await writeFile(transcript, [
    JSON.stringify({ timestamp: '2026-06-01T12:00:00.000Z', type: 'session_meta', payload: { id: 'sess_cli_privacy', cwd: windowsProject, thread_name: `Hook check in ${windowsProject}` } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `当前项目 ${windowsProject}，配置 ${windowsProject}\\.codex\\hooks.json，账号 tt@MacBook-Pro，邮箱 tt@example.com，token=secret-123` }] } }),
    JSON.stringify({ timestamp: '2026-06-01T12:00:02.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: `我会检查 ${macProject}/team-sharing/src/team-sharing.js` }] } }),
  ].join('\n'));

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url, init, body: JSON.parse(init.body || '{}') });
    return {
      ok: true,
      status: 202,
      statusText: 'Accepted',
      json: async () => ({ ok: true, appendedEventCount: calls[calls.length - 1].body.events.length, abstractRevision: 1, indexedDocumentCount: 2, messageId: 'msg_privacy' }),
    };
  };
  try {
    const result = await syncTeamSharingTranscript({ cwd, transcript, runtime: 'codex', hookEvent: 'Stop', integration: 'team-sharing', auditContent: true }, env);
    const auditText = await readFile(path.join(cwd, '.magclaw', 'team-sharing-audit.jsonl'), 'utf8');
    const serializedUpload = JSON.stringify(calls[0].body);

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.match(serializedUpload, /\[local-project\]|\[local-path\]/);
    assert.match(auditText, /\[local-project\]|\[local-path\]/);
    assert.doesNotMatch(serializedUpload, /D:\\公司\\正式项目\\memory-experiment|D:\\\\公司\\\\正式项目\\\\memory-experiment/);
    assert.doesNotMatch(serializedUpload, /\/Users\/tt\/code\/myproject\/magclaw/);
    assert.doesNotMatch(serializedUpload, /tt@MacBook-Pro|tt@example\.com|secret-123|token=/);
    assert.doesNotMatch(auditText, /D:\\公司\\正式项目\\memory-experiment|D:\\\\公司\\\\正式项目\\\\memory-experiment|\/Users\/tt\/code\/myproject\/magclaw|tt@MacBook-Pro|tt@example\.com|secret-123|token=/);
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

test('team sharing hook install defaults to the shared active shim and bootstraps current package', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-hooks-source-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-hooks-source-home-'));
  const binDir = path.join(home, 'bin');
  await writeFile(path.join(cwd, 'package.json'), '{"name":"team-sharing-source-fixture"}\n');
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon'), PATH: '' };
  const codexHooks = path.join(home, '.codex', 'hooks.json');

  const result = await installTeamSharingHooks({
    cwd,
    target: 'codex',
    codexConfig: codexHooks,
    binDir,
  }, env);
  const codex = JSON.parse(await readFile(codexHooks, 'utf8'));
  const command = codex.hooks.Stop[0].hooks.find((hook) => hook.command.includes('--runtime codex')).command;
  const paths = teamSharingPaths({ cwd, env });
  const activeState = JSON.parse(await readFile(paths.updateActive, 'utf8'));
  const packageJson = JSON.parse(await readFile(path.resolve('team-sharing', 'package.json'), 'utf8'));
  const activePackageJson = JSON.parse(await readFile(path.join(activeState.active.packageRoot, 'package.json'), 'utf8'));
  const gitHead = String(spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    cwd: path.resolve('team-sharing'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).stdout || '').trim();

  assert.equal(result.ok, true);
  assert.equal(result.shim.ok, true);
  assert.equal(result.shim.sharedRuntime.ok, true);
  assert.equal(result.shim.sharedRuntime.activated, true);
  assert.equal(activeState.active.version, packageJson.version);
  if (gitHead) {
    assert.equal(activeState.active.sourceCommit, gitHead);
    assert.equal(activePackageJson.gitHead, gitHead);
  }
  assert.match(activeState.active.bin, /versions/);
  assert.match(command, new RegExp(`^"?${escapeRegExp(result.shim.path)}"? sync`));
  assert.doesNotMatch(command, /^team-sharing sync/);
  assert.doesNotMatch(command, /--package-version|--source-commit/);

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
  const stopHook = codex.hooks.Stop[0].hooks.find((hook) => hook.command.includes('--runtime codex'));
  const command = stopHook.command;

  assert.equal(result.ok, true);
  assert.match(command, /^"C:\\Users\\Agent User\\bin\\team-sharing\.cmd" sync/);
  assert.match(command, /--cwd "/);
  assert.match(stopHook.commandWindows, /^& 'C:\\Users\\Agent User\\bin\\team-sharing\.cmd' sync/);
  assert.match(stopHook.commandWindows, /--runtime 'codex'/);
  assert.match(stopHook.commandWindows, /--cwd '.*magclaw-team-sharing-cli-hooks-windows-project-/);
  assert.doesNotMatch(command, /\$\{|'/);
  assert.doesNotMatch(stopHook.commandWindows, /\$\{|"/);
  assert.doesNotMatch(command, /--transcript|--session-title/);
});

test('team sharing hook status checks Windows commandWindows overrides', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-hooks-windows-status-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-hooks-windows-status-home-'));
  const binDir = path.join(home, 'bin');
  const commandPath = path.join(binDir, 'team-sharing.cmd');
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(cwd, 'package.json'), '{"name":"team-sharing-windows-status-fixture"}\n');
  await writeFile(commandPath, '@echo off\r\n');
  const env = {
    HOME: home,
    MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon'),
    MAGCLAW_TEAM_SHARING_PLATFORM: 'win32',
  };
  const codexHooks = path.join(home, '.codex', 'hooks.json');

  const result = await installTeamSharingHooks({
    cwd,
    target: 'codex',
    codexConfig: codexHooks,
    platform: 'win32',
    teamSharingCommand: commandPath,
  }, env);
  const status = await statusTeamSharingHooks({
    cwd,
    target: 'codex',
    codexConfig: codexHooks,
  }, env);

  assert.equal(result.ok, true);
  assert.equal(status.codex.ok, true);
  assert.equal(status.codex.commandChecks.every((check) => check.executable), true);
  assert.ok(status.codex.commandChecks.every((check) => check.command === commandPath));
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
    MAGCLAW_TEAM_SHARING_SKIP_CODEX_PLUGIN_COMMAND: '1',
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
  assert.match(shim, /updates\/active\.json|active\.json/);
  assert.match(shim, /versions/);
  assert.doesNotMatch(shim, /^exec npm exec --yes --package '@magclaw\/team-sharing@latest'/m);
  assert.match(cmdShim, /team-sharing %\*/);
  assert.doesNotMatch(cmdShim, /\^\&\^\&|\^\|\^\|/);
  assert.match(cmdShim, /const active=data\.active\?data\.active\.bin:''/);
  assert.match(ps1Shim, /team-sharing @args/);
  assert.equal(hooks.codex.installed.length, 3);
  assert.equal(hooks.claude.installed.length, 4);
  assert.equal(hooks.codex.commandChecks.every((check) => check.executable), true);
  assert.equal(hooks.claude.commandChecks.every((check) => check.executable), true);
  assert.equal(skill.installed.length, 2);
  const codexSurface = skill.surfaces.find((item) => item.target === 'codex');
  const claudeSurface = skill.surfaces.find((item) => item.target === 'claude_code');
  assert.equal(codexSurface.type, 'codex_plugin');
  assert.equal(codexSurface.pluginName, 'magclaw-team-sharing');
  assert.equal(codexSurface.marketplaceName, 'magclaw');
  assert.equal(codexSurface.installedSkills.length, 12);
  assert.equal(claudeSurface.type, 'standalone_skills');
  assert.equal(claudeSurface.installedSkills.length, 12);
  assert.ok(skill.installed.some((item) => item.type === 'codex_plugin' && item.path === path.join(home, '.magclaw', 'team-sharing', 'codex-marketplace', 'plugins', 'magclaw-team-sharing')));
  assert.ok(skill.installed.some((item) => item.type === 'standalone_skills' && item.paths.includes(path.join(cwd, '.claude', 'skills', 'magclaw-team-sharing-search', 'SKILL.md'))));
  const packageJson = JSON.parse(await readFile(path.resolve('team-sharing', 'package.json'), 'utf8'));
  const skillTemplate = await readFile(path.resolve('team-sharing', 'codex-plugin', 'skills', 'search', 'SKILL.md'), 'utf8');
  const installedPluginSkill = await readFile(path.join(home, '.magclaw', 'team-sharing', 'codex-marketplace', 'plugins', 'magclaw-team-sharing', 'skills', 'search', 'SKILL.md'), 'utf8');
  const installedClaudeSkill = await readFile(path.join(cwd, '.claude', 'skills', 'magclaw-team-sharing-search', 'SKILL.md'), 'utf8');
  const marketplace = JSON.parse(await readFile(path.join(home, '.magclaw', 'team-sharing', 'codex-marketplace', '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  assert.match(skillTemplate, /\{\{TEAM_SHARING_VERSION\}\}/);
  assert.equal(marketplace.name, 'magclaw');
  assert.equal(marketplace.plugins[0].name, 'magclaw-team-sharing');
  assert.doesNotMatch(installedPluginSkill, /\{\{TEAM_SHARING_VERSION\}\}|\{\{TEAM_SHARING_SOURCE_COMMIT\}\}|\{\{TEAM_SHARING_SKILL_NAME_PREFIX\}\}/);
  assert.doesNotMatch(installedClaudeSkill, /\{\{TEAM_SHARING_VERSION\}\}|\{\{TEAM_SHARING_SOURCE_COMMIT\}\}|\{\{TEAM_SHARING_SKILL_NAME_PREFIX\}\}/);
  assert.match(installedPluginSkill, new RegExp(`package: @magclaw/team-sharing@${escapeRegExp(packageJson.version)} sourceCommit=`));
  assert.match(installedPluginSkill, /name: search/);
  assert.match(installedClaudeSkill, /name: magclaw-team-sharing-search/);
  assert.match(await readFile(path.join(home, '.magclaw', 'team-sharing', 'codex-marketplace', 'plugins', 'magclaw-team-sharing', 'skills', 'search', 'references', 'answer-style.md'), 'utf8'), /Answer Style For Search Results/);
  await assert.rejects(() => readFile(path.join(cwd, '.agents', 'skills', 'magclaw-team-sharing', 'SKILL.md'), 'utf8'), /ENOENT/);
  assert.ok(codexConfig.hooks.Stop[0].hooks.some((hook) => hook.command.includes(path.join(binDir, 'team-sharing'))));
  assert.ok(codexConfig.hooks.Stop[0].hooks.some((hook) => /team-sharing(?:\.cmd)?"? sync/.test(hook.command)));
  assert.ok(codexConfig.hooks.Stop[0].hooks.every((hook) => !hook.command.includes('${')));
  assert.ok(codexConfig.hooks.Stop[0].hooks.some((hook) => hook.command.includes('--integration team-sharing')));
  assert.ok(codexConfig.hooks.Stop[0].hooks.every((hook) => !hook.command.includes('--package-version')));
  assert.ok(codexConfig.hooks.Stop[0].hooks.every((hook) => !hook.command.includes('--source-commit')));
  assert.ok(claudeConfig.hooks.SessionEnd[0].hooks.some((hook) => hook.command.includes('--runtime claude_code')));

  const removedHooks = await removeTeamSharingHooks({ cwd, target: 'codex' }, env);
  const afterRemove = JSON.parse(await readFile(path.join(cwd, '.codex', 'hooks.json'), 'utf8'));
  assert.equal(removedHooks.codex.removed.length, 3);
  assert.equal(JSON.stringify(afterRemove).includes('--integration team-sharing'), false);

  const removedSkill = await removeTeamSharingSkill({ cwd, target: 'codex' }, env);
  assert.equal(removedSkill.removed.length, 1);
  await assert.rejects(() => readFile(path.join(home, '.magclaw', 'team-sharing', 'codex-marketplace', 'plugins', 'magclaw-team-sharing', '.codex-plugin', 'plugin.json'), 'utf8'), /ENOENT/);
  const marketplaceAfterRemove = JSON.parse(await readFile(path.join(home, '.magclaw', 'team-sharing', 'codex-marketplace', '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  assert.deepEqual(marketplaceAfterRemove.plugins, []);
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
    MAGCLAW_TEAM_SHARING_SKIP_CODEX_PLUGIN_COMMAND: '1',
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
    MAGCLAW_TEAM_SHARING_SKIP_CODEX_PLUGIN_COMMAND: '1',
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
    const third = await checkTeamSharingUpgrade({ nowMs: () => nowMs + 13 * 60 * 60 * 1000 }, env);
    assert.equal(first.upgradeAvailable, true);
    assert.equal(first.latestVersion, '0.1.38');
    assert.equal(second.fromCache, true);
    assert.equal(third.fromCache, false);
    assert.equal(fetchCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('team sharing update check prefers server package update API and records compact notes', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-update-api-home-'));
  const env = {
    HOME: home,
    MAGCLAW_TEAM_SHARING_VERSION: '0.1.55',
    MAGCLAW_PUBLIC_URL: 'https://magclaw.example',
  };
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    assert.match(String(url), /\/api\/package-updates\?/);
    return {
      ok: true,
      json: async () => ({
        ok: true,
        package: {
          name: '@magclaw/team-sharing',
          currentVersion: '0.1.55',
          latestVersion: '0.1.56',
          updateAvailable: true,
          updateMode: 'silent',
          cacheTtlSeconds: 43200,
        },
        releaseNotesMarkdown: '- Team Sharing can now silently update registered projects.',
      }),
    };
  };
  try {
    const result = await checkTeamSharingUpgrade({ nowMs: () => 1000, serverUrl: 'https://magclaw.example' }, env);
    assert.equal(result.ok, true);
    assert.equal(result.latestVersion, '0.1.56');
    assert.equal(result.upgradeAvailable, true);
    assert.match(result.releaseNotesMarkdown, /registered projects/);
    assert.equal(calls.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function writeFakeTeamSharingPackage(packageRoot, version, options = {}) {
  await mkdir(path.join(packageRoot, 'bin'), { recursive: true });
  await mkdir(path.join(packageRoot, 'src'), { recursive: true });
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({
    name: '@magclaw/team-sharing',
    version,
    type: 'module',
    bin: { 'team-sharing': 'bin/team-sharing.js' },
  }));
  const mode = String(options.mode || 'ok');
  const versionLine = mode === 'wrong-version'
    ? `console.log(${JSON.stringify(options.reportedVersion || '9.9.9')});`
    : `console.log(${JSON.stringify(version)});`;
  const commandLines = mode === 'exit'
    ? ['console.error("verify failed"); process.exit(42);']
    : [
      'if (process.argv.includes("-V") || process.argv.includes("--version")) {',
      `  ${versionLine}`,
      '  process.exit(0);',
      '}',
      'console.log(JSON.stringify({ ok: true, args: process.argv.slice(2) }));',
    ];
  await writeFile(path.join(packageRoot, 'bin', 'team-sharing.js'), [
    '#!/usr/bin/env node',
    ...commandLines,
  ].join('\n'));
  return {
    version,
    packageRoot,
    bin: path.join(packageRoot, 'bin', 'team-sharing.js'),
  };
}

async function writeUpdateState(paths, active) {
  const state = { version: 1, active, previousActive: null, lastUpdate: null };
  await mkdir(path.dirname(paths.updateState), { recursive: true });
  await writeFile(paths.updateState, `${JSON.stringify(state, null, 2)}\n`);
  await writeFile(paths.updateActive, `${JSON.stringify(state, null, 2)}\n`);
  return state;
}

test('team sharing update stages a source package, activates it, and syncs registered projects best-effort', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-update-project-'));
  const source = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-update-source-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-update-home-'));
  const binDir = path.join(home, 'bin');
  const env = {
    HOME: home,
    CODEX_HOME: path.join(home, '.codex'),
    MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon'),
    MAGCLAW_TEAM_SHARING_VERSION: '0.1.55',
    MAGCLAW_TEAM_SHARING_SKIP_CODEX_PLUGIN_COMMAND: '1',
  };
  await mkdir(path.join(source, 'bin'), { recursive: true });
  await mkdir(path.join(source, 'src'), { recursive: true });
  await cp(path.resolve('team-sharing', 'codex-plugin'), path.join(source, 'codex-plugin'), { recursive: true });
  await writeFile(path.join(source, 'package.json'), JSON.stringify({ name: '@magclaw/team-sharing', version: '0.1.56', type: 'module', bin: { 'team-sharing': 'bin/team-sharing.js' } }));
  await writeFile(path.join(source, 'bin', 'team-sharing.js'), [
    '#!/usr/bin/env node',
    'if (process.argv.includes("-V") || process.argv.includes("--version")) { console.log("0.1.56"); process.exit(0); }',
    'console.log(JSON.stringify({ ok: true, args: process.argv.slice(2) }));',
  ].join('\n'));
  await writeFile(path.join(cwd, 'package.json'), '{"name":"team-sharing-update-fixture"}\n');
  await loginTeamSharingProfile({ token: 'tm_secret', serverUrl: 'https://magclaw.example', workspaceId: 'ws_team' }, env);
  await setupTeamSharing({
    cwd,
    yes: true,
    target: 'codex',
    channel: 'chan_team',
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    projectKey: 'fixture',
    noLogin: true,
    binDir,
  }, env);

  const result = await updateTeamSharingPackage({
    currentVersion: '0.1.55',
    latestVersion: '0.1.56',
    sourceDir: source,
    all: true,
    yes: true,
    target: 'codex',
    binDir,
  }, env);
  const paths = teamSharingPaths({ cwd, env });
  const state = JSON.parse(await readFile(paths.updateState, 'utf8'));
  const notifications = JSON.parse(await readFile(paths.updateNotifications, 'utf8'));
  const skill = await readFile(path.join(home, '.magclaw', 'team-sharing', 'codex-marketplace', 'plugins', 'magclaw-team-sharing', 'skills', 'search', 'SKILL.md'), 'utf8');

  assert.equal(result.ok, true);
  assert.equal(result.activated, true);
  assert.equal(result.syncedProjects.length, 1);
  assert.equal(state.active.version, '0.1.56');
  assert.equal(state.active.health.ok, true);
  assert.equal(state.active.health.status, 'healthy');
  assert.equal(state.active.health.version, '0.1.56');
  assert.equal(state.active.health.method, 'smoke');
  assert.match(state.active.bin, /versions/);
  assert.equal(notifications.notifications[0].version, '0.1.56');
  assert.match(skill, /@magclaw\/team-sharing@0\.1\.56/);
});

test('team sharing update rolls back to the previous active package only when its health record is healthy', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-update-rollback-home-'));
  const oldPackage = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-update-rollback-old-'));
  const badNewPackage = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-update-rollback-new-'));
  const env = { HOME: home, MAGCLAW_TEAM_SHARING_VERSION: '0.1.55' };
  const old = await writeFakeTeamSharingPackage(oldPackage, '0.1.55');
  await writeFakeTeamSharingPackage(badNewPackage, '0.1.56', { mode: 'exit' });
  const paths = teamSharingPaths({ env });
  await writeUpdateState(paths, {
    version: '0.1.55',
    bin: old.bin,
    packageRoot: old.packageRoot,
    versionDir: old.packageRoot,
    health: {
      ok: true,
      status: 'healthy',
      version: '0.1.55',
      method: 'smoke',
      checkedAt: '2026-06-08T00:00:00.000Z',
    },
    lastHealthyAt: '2026-06-08T00:00:00.000Z',
  });

  const result = await updateTeamSharingPackage({
    currentVersion: '0.1.55',
    latestVersion: '0.1.56',
    sourceDir: badNewPackage,
    yes: true,
  }, env);
  const state = JSON.parse(await readFile(paths.updateState, 'utf8'));

  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, true);
  assert.equal(result.previousHealth.ok, true);
  assert.equal(state.active.version, '0.1.55');
  assert.equal(state.active.health.status, 'healthy');
  assert.equal(state.lastUpdate.rolledBack, true);
  assert.equal(state.lastUpdate.previousHealth.ok, true);
});

test('team sharing update does not roll back to an unhealthy previous active package', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-update-no-rollback-home-'));
  const oldPackage = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-update-no-rollback-old-'));
  const badNewPackage = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-update-no-rollback-new-'));
  const env = { HOME: home, MAGCLAW_TEAM_SHARING_VERSION: '0.1.55' };
  const old = await writeFakeTeamSharingPackage(oldPackage, '0.1.55');
  await writeFakeTeamSharingPackage(badNewPackage, '0.1.56', { mode: 'wrong-version', reportedVersion: '0.1.54' });
  const paths = teamSharingPaths({ env });
  await writeUpdateState(paths, {
    version: '0.1.55',
    bin: old.bin,
    packageRoot: old.packageRoot,
    versionDir: old.packageRoot,
    health: {
      ok: false,
      status: 'unhealthy',
      version: '0.1.55',
      method: 'smoke',
      checkedAt: '2026-06-08T00:00:00.000Z',
      error: 'previous smoke failed',
    },
  });

  const result = await updateTeamSharingPackage({
    currentVersion: '0.1.55',
    latestVersion: '0.1.56',
    sourceDir: badNewPackage,
    yes: true,
  }, env);
  const state = JSON.parse(await readFile(paths.updateState, 'utf8'));

  assert.equal(result.ok, false);
  assert.equal(result.rolledBack, false);
  assert.equal(result.previousHealth.ok, false);
  assert.equal(state.active, null);
  assert.equal(state.lastUpdate.rolledBack, false);
  assert.equal(state.lastUpdate.previousHealth.status, 'unhealthy');
});

test('team sharing update records staging failure without switching the active package', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-update-stage-fail-home-'));
  const oldPackage = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-update-stage-fail-old-'));
  const missingSource = path.join(os.tmpdir(), `missing-team-sharing-${Date.now()}`);
  const env = { HOME: home, MAGCLAW_TEAM_SHARING_VERSION: '0.1.55' };
  const old = await writeFakeTeamSharingPackage(oldPackage, '0.1.55');
  const paths = teamSharingPaths({ env });
  await writeUpdateState(paths, {
    version: '0.1.55',
    bin: old.bin,
    packageRoot: old.packageRoot,
    versionDir: old.packageRoot,
    health: {
      ok: true,
      status: 'healthy',
      version: '0.1.55',
      method: 'smoke',
      checkedAt: '2026-06-08T00:00:00.000Z',
    },
  });

  const result = await updateTeamSharingPackage({
    currentVersion: '0.1.55',
    latestVersion: '0.1.56',
    sourceDir: missingSource,
    yes: true,
  }, env);
  const state = JSON.parse(await readFile(paths.updateState, 'utf8'));

  assert.equal(result.ok, false);
  assert.equal(result.phase, 'stage');
  assert.equal(result.activePreserved, true);
  assert.equal(state.active.version, '0.1.55');
  assert.equal(state.lastUpdate.phase, 'stage');
  assert.equal(state.lastUpdate.activePreserved, true);
});

test('team sharing update all skips missing projects and isolates project sync failures', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-update-all-root-'));
  const goodProject = path.join(root, 'good');
  const missingProject = path.join(root, 'missing');
  const badProject = path.join(root, 'bad');
  const source = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-update-all-source-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-update-all-home-'));
  const env = {
    HOME: home,
    CODEX_HOME: path.join(home, '.codex'),
    MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon'),
    MAGCLAW_TEAM_SHARING_VERSION: '0.1.55',
    MAGCLAW_TEAM_SHARING_SKIP_CODEX_PLUGIN_COMMAND: '1',
  };
  await mkdir(goodProject, { recursive: true });
  await mkdir(missingProject, { recursive: true });
  await mkdir(badProject, { recursive: true });
  await writeFile(path.join(goodProject, 'package.json'), '{"name":"good"}\n');
  await writeFile(path.join(missingProject, 'package.json'), '{"name":"missing"}\n');
  await writeFile(path.join(badProject, 'package.json'), '{"name":"bad"}\n');
  await writeFile(path.join(badProject, '.codex'), 'not a directory\n');
  await writeFakeTeamSharingPackage(source, '0.1.56');
  await initTeamSharingProject({ cwd: goodProject, channel: 'chan_good', serverUrl: 'https://magclaw.example', workspaceId: 'ws_team', projectKey: 'good' }, env);
  await initTeamSharingProject({ cwd: missingProject, channel: 'chan_missing', serverUrl: 'https://magclaw.example', workspaceId: 'ws_team', projectKey: 'missing' }, env);
  await initTeamSharingProject({ cwd: badProject, channel: 'chan_bad', serverUrl: 'https://magclaw.example', workspaceId: 'ws_team', projectKey: 'bad' }, env);
  await rm(missingProject, { recursive: true, force: true });

  const result = await updateTeamSharingPackage({
    currentVersion: '0.1.55',
    latestVersion: '0.1.56',
    sourceDir: source,
    all: true,
    yes: true,
    target: 'codex',
  }, env);

  assert.equal(result.ok, true);
  assert.equal(result.syncedProjects.length, 1);
  assert.equal(result.syncedProjects[0].path, goodProject);
  assert.equal(result.skippedProjects.length, 1);
  assert.equal(result.skippedProjects[0].path, missingProject);
  assert.equal(result.skippedProjects[0].reason, 'missing_project');
  assert.equal(result.failedProjects.length, 1);
  assert.equal(result.failedProjects[0].path, badProject);
});

test('team sharing auto update applies silent updates and reports a stable summary', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-auto-update-project-'));
  const source = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-auto-update-source-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-auto-update-home-'));
  const binDir = path.join(home, 'bin');
  const env = {
    HOME: home,
    CODEX_HOME: path.join(home, '.codex'),
    MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon'),
    MAGCLAW_TEAM_SHARING_VERSION: '0.1.55',
    MAGCLAW_TEAM_SHARING_SKIP_CODEX_PLUGIN_COMMAND: '1',
  };
  await mkdir(path.join(source, 'bin'), { recursive: true });
  await cp(path.resolve('team-sharing', 'codex-plugin'), path.join(source, 'codex-plugin'), { recursive: true });
  await writeFile(path.join(source, 'package.json'), JSON.stringify({
    name: '@magclaw/team-sharing',
    version: '0.1.56',
    type: 'module',
    bin: { 'team-sharing': 'bin/team-sharing.js' },
  }));
  await writeFile(path.join(source, 'bin', 'team-sharing.js'), [
    '#!/usr/bin/env node',
    'if (process.argv.includes("-V") || process.argv.includes("--version")) { console.log("0.1.56"); process.exit(0); }',
    'console.log(JSON.stringify({ ok: true, args: process.argv.slice(2) }));',
  ].join('\n'));
  await writeFile(path.join(cwd, 'package.json'), '{"name":"team-sharing-auto-update"}\n');
  await loginTeamSharingProfile({ token: 'tm_secret', serverUrl: 'https://magclaw.example', workspaceId: 'ws_team' }, env);
  await setupTeamSharing({
    cwd,
    yes: true,
    target: 'codex',
    channel: 'chan_team',
    serverUrl: 'https://magclaw.example',
    workspaceId: 'ws_team',
    projectKey: 'auto-update',
    noLogin: true,
    binDir,
  }, env);

  const beforeHooks = await readFile(path.join(cwd, '.codex', 'hooks.json'), 'utf8');
  const result = await maybeAutoUpdateTeamSharingPackage({
    trigger: 'doctor',
    currentVersion: '0.1.55',
    latestVersion: '0.1.56',
    sourceDir: source,
    all: true,
    target: 'codex',
    binDir,
  }, env);
  const paths = teamSharingPaths({ cwd, env });
  const state = JSON.parse(await readFile(paths.updateActive, 'utf8'));
  const skill = await readFile(path.join(home, '.magclaw', 'team-sharing', 'codex-marketplace', 'plugins', 'magclaw-team-sharing', 'skills', 'search', 'SKILL.md'), 'utf8');
  const afterHooks = await readFile(path.join(cwd, '.codex', 'hooks.json'), 'utf8');

  assert.equal(result.ok, true);
  assert.equal(result.packageName, '@magclaw/team-sharing');
  assert.equal(result.action, 'applied');
  assert.equal(result.currentVersion, '0.1.55');
  assert.equal(result.latestVersion, '0.1.56');
  assert.equal(result.updateAvailable, true);
  assert.equal(result.updateMode, 'silent');
  assert.match(result.applyCommand, /team-sharing update/);
  assert.equal(result.restartHint, 'Open a new Codex thread or restart Codex to pick up refreshed plugin skills.');
  assert.equal(state.active.version, '0.1.56');
  assert.equal(state.active.health.status, 'healthy');
  assert.match(skill, /@magclaw\/team-sharing@0\.1\.56/);
  assert.equal(afterHooks, beforeHooks);
});

test('team sharing auto update can be disabled for non-manual triggers', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-auto-disabled-home-'));
  const env = {
    HOME: home,
    MAGCLAW_TEAM_SHARING_VERSION: '0.1.55',
    MAGCLAW_TEAM_SHARING_AUTO_UPDATE: '0',
  };

  const result = await maybeAutoUpdateTeamSharingPackage({
    trigger: 'hook',
    currentVersion: '0.1.55',
    latestVersion: '0.1.56',
  }, env);

  assert.equal(result.ok, true);
  assert.equal(result.action, 'skipped');
  assert.equal(result.reason, 'auto_update_disabled');
  assert.equal(result.packageName, '@magclaw/team-sharing');
  assert.equal(result.updateAvailable, true);
});

test('team sharing update check falls back to npm registry when server package update API fails', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-update-fallback-home-'));
  const env = {
    HOME: home,
    MAGCLAW_TEAM_SHARING_VERSION: '0.1.55',
    MAGCLAW_PUBLIC_URL: 'https://magclaw.example',
  };
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/api/package-updates')) {
      return {
        ok: false,
        status: 503,
        json: async () => ({ ok: false, error: 'server unavailable' }),
      };
    }
    assert.match(String(url), /registry\.npmjs\.org\/%40magclaw%2Fteam-sharing/i);
    return {
      ok: true,
      json: async () => ({ 'dist-tags': { latest: '0.1.56' } }),
    };
  };
  try {
    const result = await checkTeamSharingUpgrade({ nowMs: () => 1000, serverUrl: 'https://magclaw.example' }, env);
    assert.equal(result.ok, true);
    assert.equal(result.source, 'npm');
    assert.equal(result.latestVersion, '0.1.56');
    assert.equal(result.upgradeAvailable, true);
    assert.equal(calls.length, 2);
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
          : { ok: true, results: [{ sessionId: 'sess_1', title: 'Rerank', evidence: 'top5 结论', contextUrl: '/team-sharing/context/sess_1?anchorEventId=evt_1' }] }
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
      member: '蒋海波',
      members: '张三、李四',
      uploader: '王五',
      uploaders: ['赵六'],
      memberId: 'hum_jhb',
      memberIds: 'hum_zhang,hum_li',
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
    assert.equal(search.results[0].contextWebUrl, 'https://magclaw.example/team-sharing/context/sess_1?anchorEventId=evt_1');
    assert.equal(search.results[0].contextPageUrl, search.results[0].contextWebUrl);
    assert.equal(context.events[0].cleanText, '原文片段');
    assert.equal(context.contextWebUrl, 'https://magclaw.example/team-sharing/context/sess_1?anchorEventId=evt_1&direction=around&limit=3&order=asc');
    assert.equal(context.contextPageUrl, context.contextWebUrl);
    assert.equal(calls[0].url, 'https://magclaw.example/api/team-sharing/search');
    assert.equal(calls[0].body.workspaceId, 'ws_team');
    assert.equal(calls[0].body.channelId, 'chan_team');
    assert.equal(calls[0].body.projectKey, 'magclaw');
    assert.equal(calls[0].body.scope, 'hybrid');
    assert.equal(calls[0].body.searchMode, 'hybrid');
    assert.equal(calls[0].body.modeBias, 'keyword');
    assert.equal(calls[0].body.semanticQuery, '昨天关于 rerank 结论和 BM25 的验收');
    assert.deepEqual(calls[0].body.retrievalIntent, {
      useKeyword: true,
      useSemantic: true,
      modeBias: 'keyword',
      scope: 'hybrid',
      source: 'team-sharing-cli',
      member: {
        names: ['蒋海波', '张三', '李四', '王五', '赵六'],
        ids: ['hum_jhb', 'hum_zhang', 'hum_li'],
      },
    });
    assert.ok(calls[0].body.keywords.includes('rerank'));
    assert.ok(calls[0].body.keywords.includes('BM25'));
    assert.ok(calls[0].body.topics.includes('rerank 结论'));
    assert.deepEqual(calls[0].body.memberNames, ['蒋海波', '张三', '李四', '王五', '赵六']);
    assert.deepEqual(calls[0].body.memberIds, ['hum_jhb', 'hum_zhang', 'hum_li']);
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

test('team sharing cli search forwards explicit retrieval scope', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-search-scope-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-cli-search-scope-home-'));
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
    return { ok: true, json: async () => ({ ok: true, results: [] }) };
  };
  try {
    await searchTeamSharing({ cwd, query: 'BM25', scope: 'server' }, env);
    assert.equal(calls[0].url, 'https://magclaw.example/api/team-sharing/search');
    assert.equal(calls[0].body.scope, 'server');
    assert.equal(calls[0].body.retrievalIntent.scope, 'server');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('team sharing cli read-link reads protected share and context links with profile token', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-read-link-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-read-link-home-'));
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
    calls.push({ url: String(url), init });
    assert.equal(init.headers.authorization, 'Bearer team-sharing-token-secret');
    assert.match(init.headers['x-magclaw-machine-fingerprint'], /^mfp_[a-f0-9]{64}$/);
    if (String(url).includes('/api/team-sharing/links/inspect')) {
      const inspected = new URL(String(url)).searchParams.get('url') || '';
      if (inspected.includes('/s/share_cli')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            kind: 'share',
            linkType: 'magclaw_team_sharing',
            supported: true,
            reason: 'ok',
            target: { shareId: 'share_cli', workspaceId: 'ws_team', server: { id: 'ws_team', slug: 'team-server', name: 'Team Server' }, title: 'Rerank 分享页' },
            auth: { loggedIn: true, via: 'token', currentWorkspaceId: 'ws_team', servers: [] },
            access: { ok: true, reason: 'ok', joinRequired: false },
            action: { type: 'read_link' },
          }),
        };
      }
      if (inspected.includes('/team-sharing/context/sess_1')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            kind: 'context',
            linkType: 'magclaw_team_sharing',
            supported: true,
            reason: 'ok',
            target: { sessionId: 'sess_1', workspaceId: 'ws_team', server: { id: 'ws_team', slug: 'team-server', name: 'Team Server' }, title: '原始上下文' },
            auth: { loggedIn: true, via: 'token_membership', currentWorkspaceId: 'ws_team', servers: [] },
            access: { ok: true, reason: 'ok', joinRequired: false },
            action: { type: 'read_link' },
          }),
        };
      }
      if (inspected.includes('/knowledge/docs/doc_1')) {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            kind: 'knowledge_doc',
            linkType: 'magclaw_team_sharing',
            supported: true,
            reason: 'ok',
            target: { docId: 'doc_1', workspaceId: 'ws_team', serverSlug: 'team-server', server: { id: 'ws_team', slug: 'team-server', name: 'Team Server' }, title: 'Memory Module' },
            auth: { loggedIn: true, via: 'token', currentWorkspaceId: 'ws_team', servers: [] },
            access: { ok: true, reason: 'ok', joinRequired: false },
            action: { type: 'read_link' },
          }),
        };
      }
      if (inspected.includes('/s/share_denied')) {
        return {
          ok: true,
          json: async () => ({
            ok: false,
            kind: 'share',
            linkType: 'magclaw_team_sharing',
            supported: true,
            reason: 'server_membership_required',
            target: { shareId: 'share_denied', workspaceId: 'ws_other', server: { id: 'ws_other', slug: 'other-server', name: 'Other Server' }, title: 'Denied share' },
            auth: { loggedIn: true, via: 'token', currentWorkspaceId: 'ws_team', servers: [] },
            access: { ok: false, reason: 'server_membership_required', joinRequired: true },
            action: { type: 'open_browser_to_join', url: 'https://magclaw.example/s/share_denied', message: 'Open this MagClaw link in the browser, sign in, and join the server.' },
          }),
        };
      }
      if (inspected.includes('/s/share_legacy')) {
        return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
      }
    }
    if (String(url).includes('/api/team-sharing/shares/share_cli')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          kind: 'share',
          shareId: 'share_cli',
          title: 'Rerank 分享页',
          description: '团队总结',
          contentType: 'markdown',
          content: '# Rerank 分享页\n\n先召回，再重排。',
          workspaceId: 'ws_team',
          channelId: 'chan_team',
          channelPath: 'mc://magclaw/server/ws_team/channel/chan_team',
          creator: { id: 'hum_1', name: 'Ada' },
          createdAt: '2026-06-06T10:00:00.000Z',
          url: 'https://magclaw.example/s/share_cli',
        }),
      };
    }
    if (String(url).includes('/api/team-sharing/shares/share_legacy')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          kind: 'share',
          shareId: 'share_legacy',
          title: 'Legacy server share',
          contentType: 'markdown',
          content: '旧服务端 fallback 正文。',
          workspaceId: 'ws_team',
          creator: { id: 'hum_1', name: 'Ada' },
          createdAt: '2026-06-06T10:00:00.000Z',
          url: 'https://magclaw.example/s/share_legacy',
        }),
      };
    }
    if (String(url).includes('/api/team-sharing/context/sess_1')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          sessionId: 'sess_1',
          session: { sessionId: 'sess_1', title: '原始上下文', runtime: 'codex' },
          events: [
            { eventId: 'evt_1', role: 'user', createdAt: '2026-06-06T10:00:00.000Z', cleanText: '用户问题' },
            { eventId: 'evt_2', role: 'assistant', createdAt: '2026-06-06T10:01:00.000Z', cleanText: 'Agent 回答' },
          ],
          contextUrl: '/team-sharing/context/sess_1?anchorEventId=evt_1&limit=2&order=asc',
        }),
      };
    }
    if (String(url).includes('/api/team-sharing/knowledge/team-server/docs/doc_1')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          kind: 'knowledge_doc',
          serverSlug: 'team-server',
          docId: 'doc_1',
          document: {
            id: 'doc_1',
            title: 'Memory Module',
            sourceMarkdown: 'Memory should be retrievable.',
            currentVersionId: 'ver_1',
            updatedAt: '2026-06-06T10:02:00.000Z',
          },
          url: 'https://magclaw.example/s/team-server/knowledge/docs/doc_1',
        }),
      };
    }
    throw new Error(`unexpected url ${url}`);
  };
  try {
    const parsed = parseCli(['node', 'magclaw', 'team-sharing', 'read-link', 'https://magclaw.example/s/share_cli', '--format', 'markdown']);
    assert.deepEqual(parsed.flags._, ['read-link', 'https://magclaw.example/s/share_cli']);

    const share = await readTeamSharingLink({ ...parsed.flags, cwd }, env);
    const shareMarkdown = formatTeamSharingReadLinkResult(share, 'markdown');
    const shareText = formatTeamSharingReadLinkResult(share, 'text');
    const shareJson = formatTeamSharingReadLinkResult(share, 'json');

    assert.equal(share.kind, 'share');
    assert.match(calls[0].url, /https:\/\/magclaw\.example\/api\/team-sharing\/links\/inspect\?/);
    assert.equal(new URL(calls[0].url).searchParams.get('url'), 'https://magclaw.example/s/share_cli');
    assert.equal(calls[1].url, 'https://magclaw.example/api/team-sharing/shares/share_cli');
    assert.equal(share.access.ok, true);
    assert.match(shareMarkdown, /# Rerank 分享页/);
    assert.match(shareMarkdown, /先召回，再重排/);
    assert.match(shareText, /Rerank 分享页/);
    assert.doesNotMatch(shareText, /^#/m);
    assert.match(shareJson, /"kind": "share"/);
    assert.doesNotMatch(shareJson, /team-sharing-token-secret|Bearer/i);

    const context = await readTeamSharingLink({
      cwd,
      _: ['read-link', 'https://magclaw.example/s/team-server/team-sharing/context/sess_1?anchorEventId=evt_1&limit=2&order=asc'],
    }, env);
    const contextMarkdown = formatTeamSharingReadLinkResult(context, 'markdown');
    assert.equal(context.kind, 'context');
    assert.match(calls[2].url, /https:\/\/magclaw\.example\/api\/team-sharing\/links\/inspect\?/);
    assert.match(calls[3].url, /https:\/\/magclaw\.example\/api\/team-sharing\/context\/sess_1\?/);
    assert.match(calls[3].url, /anchorEventId=evt_1/);
    assert.match(calls[3].url, /limit=2/);
    assert.match(context.contextWebUrl, /https:\/\/magclaw\.example\/team-sharing\/context\/sess_1/);
    assert.match(contextMarkdown, /# 原始上下文/);
    assert.match(contextMarkdown, /用户问题/);
    assert.match(contextMarkdown, /Agent 回答/);

    const knowledge = await readTeamSharingLink({
      cwd,
      _: ['read-link', 'https://magclaw.example/s/team-server/knowledge/docs/doc_1'],
    }, env);
    const knowledgeMarkdown = formatTeamSharingReadLinkResult(knowledge, 'markdown');
    assert.equal(knowledge.kind, 'knowledge_doc');
    assert.equal(knowledge.docId, 'doc_1');
    assert.match(knowledgeMarkdown, /# Memory Module/);
    assert.match(knowledgeMarkdown, /Memory should be retrievable/);
    assert.doesNotMatch(formatTeamSharingReadLinkResult(knowledge, 'json'), /team-sharing-token-secret|Bearer/i);

    const denied = await readTeamSharingLink({ cwd, _: ['read-link', 'https://magclaw.example/s/share_denied'] }, env);
    const deniedMarkdown = formatTeamSharingReadLinkResult(denied, 'markdown');
    const deniedText = formatTeamSharingReadLinkResult(denied, 'text');
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'server_membership_required');
    assert.equal(denied.action.type, 'open_browser_to_join');
    assert.match(deniedMarkdown, /MagClaw Team Sharing link access required/);
    assert.match(deniedMarkdown, /open_browser_to_join/);
    assert.match(deniedText, /Other Server/);
    assert.equal(calls.some((call) => String(call.url).includes('/api/team-sharing/shares/share_denied')), false);

    const legacy = await readTeamSharingLink({ cwd, _: ['read-link', 'https://magclaw.example/s/share_legacy'] }, env);
    assert.equal(legacy.kind, 'share');
    assert.equal(legacy.shareId, 'share_legacy');
    assert.match(legacy.content, /fallback/);

    await assert.rejects(
      () => readTeamSharingLink({ cwd, _: ['read-link', 'https://magclaw.example/console'] }, env),
      /Unsupported MagClaw Team Sharing link/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('team sharing cli read-link returns structured login action when CLI token is missing', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-read-link-login-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-read-link-login-home-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
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
    calls.push({ url: String(url), init });
    assert.equal(init.headers.authorization, undefined);
    assert.equal(init.headers['x-magclaw-machine-fingerprint'], undefined);
    assert.match(String(url), /\/api\/team-sharing\/links\/inspect\?/);
    return {
      ok: true,
      json: async () => ({
        ok: false,
        kind: 'share',
        linkType: 'magclaw_team_sharing',
        supported: true,
        reason: 'login_required',
        target: { shareId: 'share_cli', workspaceId: 'ws_team', server: { id: 'ws_team', slug: 'team-server', name: 'Team Server' } },
        auth: { loggedIn: false, via: 'none', currentWorkspaceId: '', servers: [] },
        access: { ok: false, reason: 'login_required', joinRequired: false },
        action: { type: 'login', command: 'team-sharing login --server-url https://magclaw.example', message: 'Team Sharing CLI login is required.' },
      }),
    };
  };
  try {
    const result = await readTeamSharingLink({ cwd, _: ['read-link', 'https://magclaw.example/s/share_cli'] }, env);
    const markdown = formatTeamSharingReadLinkResult(result, 'markdown');
    const json = formatTeamSharingReadLinkResult(result, 'json');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'login_required');
    assert.equal(result.action.type, 'login');
    assert.match(result.action.command, /team-sharing login --server-url https:\/\/magclaw\.example/);
    assert.match(markdown, /MagClaw Team Sharing link access required/);
    assert.match(markdown, /login_required/);
    assert.equal(calls.length, 1);
    assert.doesNotMatch(json, /team-sharing-token-secret|Bearer/i);
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

test('team sharing cli knowledge consensus commands call protected routes without leaking tokens', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-consensus-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-consensus-home-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
  const calls = [];
  const server = await startJsonServer((req, res, bodyText) => {
    const body = JSON.parse(bodyText || '{}');
    calls.push({ url: `${server.url}${req.url}`, headers: req.headers, body });
    assert.equal(req.headers.authorization, 'Bearer team-sharing-token-secret');
    if (req.method !== 'GET') {
      assert.equal(req.headers['content-type'], 'application/json');
      assert.equal(Number(req.headers['content-length']) > 0, true);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      pathname: req.url,
      body,
      consensusId: 'cns_team',
      markdown: '# Team Consensus\n\n## Memory Module\n\nMemory should be retrievable.\n',
      session: { id: 'chg_1', status: 'draft' },
      imported: { documents: 2, anchors: 1 },
      answer: 'Matched 1 consensus item.',
      matches: [{ title: 'Memory Module' }],
      rules: [{ title: 'Memory Module' }],
      alignmentGaps: [],
    }));
  });
  await loginTeamSharingProfile({
    serverUrl: server.url,
    workspaceId: 'ws_team',
    token: 'team-sharing-token-secret',
  }, env);
  await initTeamSharingProject({
    cwd,
    channel: 'chan_team',
    serverUrl: server.url,
    workspaceId: 'ws_team',
    projectKey: 'magclaw',
  }, env);
  const markdownFile = path.join(cwd, 'consensus.md');
  await writeFile(markdownFile, '# Team Consensus\n\n## Memory Module\n\nMemory should be retrievable.\n');
  const editFile = path.join(cwd, 'edit.md');
  await writeFile(editFile, 'Memory should be retrievable with stable anchors.\n');

  try {
    const imported = await importKnowledgeConsensus({
      cwd,
      server: server.url,
      workspace: 'team-server',
      file: markdownFile,
      title: 'Team Consensus',
    }, env);
    const asked = await askKnowledgeConsensusCommand({
      cwd,
      server: server.url,
      workspace: 'team-server',
      query: 'stable anchors',
    }, env);
    const edited = await editKnowledgeConsensus({
      cwd,
      server: server.url,
      workspace: 'team-server',
      doc: 'doc_memory',
      file: editFile,
    }, env);
    const aligned = await alignKnowledgeConsensus({
      cwd,
      server: server.url,
      workspace: 'team-server',
      text: 'We need stable anchors.',
    }, env);
    const exported = await exportKnowledgeConsensus({
      cwd,
      server: server.url,
      workspace: 'team-server',
      consensusId: 'cns_team',
    }, env);

    assert.equal(calls[0].url, `${server.url}/api/team-sharing/knowledge/team-server/import`);
    assert.equal(calls[0].body.workspaceId, 'team-server');
    assert.match(calls[0].body.markdown, /Team Consensus/);
    assert.equal(calls[1].url, `${server.url}/api/team-sharing/knowledge/team-server/ask`);
    assert.equal(calls[1].body.query, 'stable anchors');
    assert.equal(calls[2].url, `${server.url}/api/team-sharing/knowledge/team-server/edit`);
    assert.equal(calls[2].body.docId, 'doc_memory');
    assert.match(calls[2].body.markdown, /stable anchors/);
    assert.equal(calls[3].url, `${server.url}/api/team-sharing/knowledge/team-server/align`);
    assert.equal(calls[3].body.text, 'We need stable anchors.');
    assert.equal(calls[4].url, `${server.url}/api/team-sharing/knowledge/team-server/export?consensusId=cns_team`);
    assert.match(exported.markdown, /^# Team Consensus/m);
    assert.doesNotMatch(JSON.stringify({ imported, asked, edited, aligned, exported }), /team-sharing-token-secret|Bearer/i);
  } finally {
    await server.close();
  }
});

test('team sharing knowledge consensus commands honor timeout-ms alias with bounded node transport', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-consensus-timeout-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-consensus-timeout-home-'));
  const env = { HOME: home, MAGCLAW_DAEMON_HOME: path.join(home, '.magclaw-daemon') };
  const server = await startJsonServer(() => {});
  await loginTeamSharingProfile({
    serverUrl: server.url,
    workspaceId: 'ws_team',
    token: 'team-sharing-token-secret',
  }, env);
  await initTeamSharingProject({
    cwd,
    channel: 'chan_team',
    serverUrl: server.url,
    workspaceId: 'ws_team',
    projectKey: 'magclaw',
  }, env);
  const startedAt = Date.now();
  try {
    await assert.rejects(
      askKnowledgeConsensusCommand({
        cwd,
        server: server.url,
        workspace: 'team-server',
        query: 'will timeout',
        timeoutMs: '5',
      }, env),
      (error) => {
        assert.equal(error.timeout, true);
        assert.equal(error.statusText, 'timeout');
        return true;
      },
    );
    assert.equal(Date.now() - startedAt < 2500, true);
  } finally {
    await server.close();
  }
});

test('team sharing cli optimizes large inline share assets before upload', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-share-assets-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-share-assets-home-'));
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
  const video = Buffer.concat([Buffer.from('video-start'), Buffer.alloc(70 * 1024, 3)]);
  const artifact = path.join(cwd, 'video-share.html');
  await writeFile(artifact, `<!doctype html><html><body><section id="demo"><video src="data:video/mp4;base64,${video.toString('base64')}"></video></section></body></html>`);

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ url: String(url), init, body });
    if (String(url).endsWith('/api/team-sharing/assets/resolve')) {
      assert.equal(body.workspaceId, 'ws_team');
      assert.equal(body.mimeType, 'video/mp4');
      assert.equal(body.bytes, video.length);
      assert.equal(body.dataUrl, undefined);
      return { ok: true, json: async () => ({ ok: true, found: false, asset: null }) };
    }
    if (String(url).endsWith('/api/team-sharing/assets')) {
      assert.match(body.dataUrl, /^data:video\/mp4;base64,/);
      return {
        ok: true,
        json: async () => ({
          ok: true,
          reused: false,
          asset: {
            id: 'asset_video',
            filename: 'team-sharing-video.mp4',
            mimeType: 'video/mp4',
            bytes: video.length,
            checksumSha256: body.sha256,
            url: 'https://magclaw.example/api/team-sharing/assets/asset_video/team-sharing-video.mp4',
          },
        }),
      };
    }
    if (String(url).endsWith('/api/team-sharing/shares')) {
      assert.doesNotMatch(body.content, /data:video\/mp4;base64/);
      assert.match(body.content, /\/api\/team-sharing\/assets\/asset_video\/team-sharing-video\.mp4/);
      assert.deepEqual(body.assetIds, ['asset_video']);
      assert.equal(body.source.assetOptimization.optimized, true);
      assert.doesNotMatch(JSON.stringify(body), /team-sharing-token-secret|Bearer/i);
      return { ok: true, json: async () => ({ ok: true, shareId: 'share_asset', url: 'https://magclaw.example/s/share_asset' }) };
    }
    throw new Error(`unexpected url ${url}`);
  };
  try {
    const result = await shareTeamSharingArtifact({ file: artifact, cwd, type: 'html' }, env);
    assert.equal(result.ok, true);
    assert.equal(calls.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('team sharing cli edit-link fills section hashes and patches the same share URL', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-edit-link-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-edit-link-home-'));
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
  const patchFile = path.join(cwd, 'patch.json');
  await writeFile(patchFile, JSON.stringify({
    operations: [
      { op: 'replace_section', sectionId: 'alpha', content: '<section id="alpha"><h2>Alpha</h2><p>新版</p></section>' },
    ],
  }));

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    calls.push({ url: String(url), init, body });
    if (String(url).includes('/api/team-sharing/shares/share_edit/sections')) {
      return {
        ok: true,
        json: async () => ({
          ok: true,
          shareId: 'share_edit',
          versionId: 'shv_1',
          sections: [{ sectionId: 'alpha', selector: 'section#alpha', title: 'Alpha', hash: 'hash_alpha' }],
        }),
      };
    }
    if (String(url).includes('/api/team-sharing/shares/share_edit')) {
      assert.equal(init.method, 'PATCH');
      assert.equal(body.baseVersionId, 'shv_1');
      assert.equal(body.operations[0].expectedHash, 'hash_alpha');
      assert.doesNotMatch(JSON.stringify(body), /team-sharing-token-secret|Bearer/i);
      return {
        ok: true,
        json: async () => ({
          ok: true,
          shareId: 'share_edit',
          url: 'https://magclaw.example/s/share_edit',
          versionId: 'shv_2',
          changedSections: [{ sectionId: 'alpha' }],
        }),
      };
    }
    throw new Error(`unexpected url ${url}`);
  };
  try {
    const dryRun = await editTeamSharingLink({ cwd, _: ['edit-link', 'https://magclaw.example/s/share_edit'], patch: patchFile, dryRun: true }, env);
    assert.equal(dryRun.ok, true);
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.changedSections[0].expectedHash, 'hash_alpha');
    assert.equal(calls.length, 1);

    const result = await editTeamSharingLink({ cwd, _: ['edit-link', 'https://magclaw.example/s/share_edit'], patch: patchFile }, env);
    assert.equal(result.ok, true);
    assert.equal(result.url, 'https://magclaw.example/s/share_edit');
    assert.equal(calls.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('team sharing cli lists and deletes share links with profile token', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-manage-links-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-manage-links-home-'));
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

  const parsedList = parseCli(['node', 'magclaw', 'team-sharing', 'list-links', '--include-revoked']);
  assert.deepEqual(parsedList.flags._, ['list-links']);
  const parsedDelete = parseCli(['node', 'magclaw', 'team-sharing', 'delete-link', 'https://magclaw.example/s/share_cli']);
  assert.deepEqual(parsedDelete.flags._, ['delete-link', 'https://magclaw.example/s/share_cli']);

  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init, body: init.body ? JSON.parse(init.body) : null });
    assert.equal(init.headers.authorization, 'Bearer team-sharing-token-secret');
    assert.match(init.headers['x-magclaw-machine-fingerprint'], /^mfp_[a-f0-9]{64}$/);
    if (String(url).includes('/api/team-sharing/shares?')) {
      const parsed = new URL(String(url));
      assert.equal(parsed.searchParams.get('workspaceId'), 'ws_team');
      return {
        ok: true,
        json: async () => ({
          ok: true,
          kind: 'share_list',
          workspaceId: 'ws_team',
          count: 1,
          shares: [{
            shareId: 'share_cli',
            title: 'Rerank 分享页',
            url: 'https://magclaw.example/s/share_cli',
            canEdit: true,
            status: 'active',
          }],
        }),
      };
    }
    if (String(url).endsWith('/api/team-sharing/shares/share_cli')) {
      assert.equal(init.method, 'DELETE');
      return {
        ok: true,
        json: async () => ({
          ok: true,
          kind: 'share_deleted',
          shareId: 'share_cli',
          deleted: true,
          revokedAt: '2026-06-06T10:00:00.000Z',
        }),
      };
    }
    if (String(url).endsWith('/api/team-sharing/shares/share_old')) {
      assert.equal(init.method, 'DELETE');
      return {
        ok: true,
        json: async () => ({
          ok: true,
          kind: 'share_deleted',
          shareId: 'share_old',
          deleted: false,
          alreadyDeleted: true,
        }),
      };
    }
    throw new Error(`unexpected url ${url}`);
  };
  try {
    const listed = await listTeamSharingLinks({ cwd }, env);
    assert.equal(listed.ok, true);
    assert.equal(listed.shares[0].shareId, 'share_cli');

    const deleted = await deleteTeamSharingLink({ cwd, _: ['delete-link', 'https://magclaw.example/s/share_cli'] }, env);
    assert.equal(deleted.ok, true);
    assert.equal(deleted.deleted, true);

    const deletedById = await deleteTeamSharingLink({ cwd, _: ['delete-link', 'share_old'] }, env);
    assert.equal(deletedById.alreadyDeleted, true);
    assert.deepEqual(calls.map((call) => new URL(call.url).pathname), [
      '/api/team-sharing/shares',
      '/api/team-sharing/shares/share_cli',
      '/api/team-sharing/shares/share_old',
    ]);
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

test('team sharing codex plugin source exposes valid plugin and trigger-focused skills', async () => {
  const packageJson = JSON.parse(await readFile(path.resolve('team-sharing', 'package.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(path.resolve('team-sharing', 'codex-plugin', '.codex-plugin', 'plugin.json'), 'utf8'));
  const expectedSkills = ['setup', 'session-reporting', 'search', 'read-link', 'share-artifact', 'edit-link', 'manage-links', 'import-consensus', 'ask-consensus', 'edit-consensus', 'align-consensus', 'export-consensus'];

  assert.equal(manifest.name, 'magclaw-team-sharing');
  assert.equal(manifest.version, packageJson.version);
  assert.equal(manifest.skills, './skills/');
  assert.equal(Object.prototype.hasOwnProperty.call(manifest, 'hooks'), false);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);

  for (const skill of expectedSkills) {
    const body = await readFile(path.resolve('team-sharing', 'codex-plugin', 'skills', skill, 'SKILL.md'), 'utf8');
    assert.match(body, new RegExp(`name: \\{\\{TEAM_SHARING_SKILL_NAME_PREFIX\\}\\}${escapeRegExp(skill)}`));
    assert.match(body, /description: Use when /);
    assert.match(body, /sourceCommit=\{\{TEAM_SHARING_SOURCE_COMMIT\}\}/);
  }
});

test('align-consensus skill covers broad Chinese and English Knowledge Space intent variants', async () => {
  const skill = await readFile(path.resolve('team-sharing', 'codex-plugin', 'skills', 'align-consensus', 'SKILL.md'), 'utf8');
  const intentMap = await readFile(path.resolve('team-sharing', 'codex-plugin', 'skills', 'align-consensus', 'references', 'knowledge-intent.md'), 'utf8');
  const positiveSection = intentMap.split('## Positive Coverage Cases')[1].split('## Non-trigger Cases')[0];
  const negativeSection = intentMap.split('## Non-trigger Cases')[1];
  const positives = [...positiveSection.matchAll(/^- `([^`]+)`/gm)].map((match) => match[1]);
  const negatives = [...negativeSection.matchAll(/^- `([^`]+)`/gm)].map((match) => match[1]);
  const knowledgeTarget = /(共识库|共识文档|团队共识|共识体系|共识|历史决策|之前说的|基础文档|指引|必做项|推广前必做|落地计划|Agent-only 工作流|agent-only workflow|agreed workflow|工作流|知识空间|知识库|知识管理|知识图谱|知识沉淀|标准|规范|准则|原则|约定|口径|规则|红线|底线|SOP|事实源|TeamShare|Team Sharing|Knowledge Space|knowledge management|knowledge base|knowledge doc|canonical knowledge|source[- ]of[- ]truth|policy|spec|standard|principle|team rule|rule|agreed wording|wording|consensus)/i;
  const alignmentConcern = /(对齐|对得上|对不对|有没有问题|哪里有问题|看一下|判断|确认|能不能|是否可以|是否需要|合理|对照|比一下|比较|相比|校验|检查|核对|复核|审查|审一下|符合|违背|违反|冲突|矛盾|打架|偏离|一致|差异|踩|越界|风险|diff|gap|risk|boundary|compliance|compliant|align|match|check|compare|validate|consistent|conflict|contradict|violate|violation|bypass|review|divergence)/i;
  const writeOnlyIntent = /(导入|导出|修改|发布|设置|白名单|通知配置|复制|创建|删除|搜索|翻译|部署|npm|import|export|edit|publish|settings)/i;

  assert.match(skill, /references\/knowledge-intent\.md/);
  assert.match(skill, /共识库.*知识空间.*知识库.*知识管理.*标准.*规范.*准则.*原则.*口径.*红线/s);
  assert.ok(positives.length >= 120, `expected at least 120 positive coverage cases, got ${positives.length}`);
  assert.ok(negatives.length >= 20, `expected at least 20 non-trigger cases, got ${negatives.length}`);
  for (const phrase of positives) {
    assert.match(phrase, knowledgeTarget, `positive case should mention a Knowledge Space synonym: ${phrase}`);
    assert.match(phrase, alignmentConcern, `positive case should mention alignment/compliance intent: ${phrase}`);
  }
  for (const phrase of negatives) {
    assert.ok(!knowledgeTarget.test(phrase) || !alignmentConcern.test(phrase) || writeOnlyIntent.test(phrase), `negative case should not look like pure alignment intent: ${phrase}`);
  }
});

test('team sharing cli installs a Codex plugin bundle without writing token into skill files', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-skill-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-skill-home-'));
  await writeFile(path.join(cwd, 'package.json'), '{"name":"team-sharing-skill-fixture"}\n');
  const env = { HOME: home, CODEX_HOME: path.join(home, '.codex'), MAGCLAW_TEAM_SHARING_SKIP_CODEX_PLUGIN_COMMAND: '1' };
  const result = await installTeamSharingSkill({ cwd, target: 'codex' }, env);
  const pluginRoot = path.join(home, '.magclaw', 'team-sharing', 'codex-marketplace', 'plugins', 'magclaw-team-sharing');
  const manifest = JSON.parse(await readFile(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  const setupSkill = await readFile(path.join(pluginRoot, 'skills', 'setup', 'SKILL.md'), 'utf8');
  const setupRef = await readFile(path.join(pluginRoot, 'skills', 'setup', 'references', 'setup.md'), 'utf8');
  const readLinkSkill = await readFile(path.join(pluginRoot, 'skills', 'read-link', 'SKILL.md'), 'utf8');
  const readLinkRef = await readFile(path.join(pluginRoot, 'skills', 'read-link', 'references', 'read-link.md'), 'utf8');
  const searchSkill = await readFile(path.join(pluginRoot, 'skills', 'search', 'SKILL.md'), 'utf8');
  const searchRef = await readFile(path.join(pluginRoot, 'skills', 'search', 'references', 'search.md'), 'utf8');
  const answerStyle = await readFile(path.join(pluginRoot, 'skills', 'search', 'references', 'answer-style.md'), 'utf8');
  const shareRef = await readFile(path.join(pluginRoot, 'skills', 'share-artifact', 'references', 'share-artifact.md'), 'utf8');
  const htmlStyle = await readFile(path.join(pluginRoot, 'skills', 'share-artifact', 'references', 'default-html-style.md'), 'utf8');
  const editRef = await readFile(path.join(pluginRoot, 'skills', 'edit-link', 'references', 'edit-link.md'), 'utf8');
  const manageRef = await readFile(path.join(pluginRoot, 'skills', 'manage-links', 'references', 'manage-links.md'), 'utf8');
  const importConsensusSkill = await readFile(path.join(pluginRoot, 'skills', 'import-consensus', 'SKILL.md'), 'utf8');
  const askConsensusSkill = await readFile(path.join(pluginRoot, 'skills', 'ask-consensus', 'SKILL.md'), 'utf8');
  const editConsensusSkill = await readFile(path.join(pluginRoot, 'skills', 'edit-consensus', 'SKILL.md'), 'utf8');
  const alignConsensusSkill = await readFile(path.join(pluginRoot, 'skills', 'align-consensus', 'SKILL.md'), 'utf8');
  const alignConsensusIntent = await readFile(path.join(pluginRoot, 'skills', 'align-consensus', 'references', 'knowledge-intent.md'), 'utf8');
  const exportConsensusSkill = await readFile(path.join(pluginRoot, 'skills', 'export-consensus', 'SKILL.md'), 'utf8');
  const skill = [
    setupSkill,
    setupRef,
    readLinkSkill,
    readLinkRef,
    searchSkill,
    searchRef,
    answerStyle,
    shareRef,
    htmlStyle,
    editRef,
    manageRef,
    importConsensusSkill,
    askConsensusSkill,
    editConsensusSkill,
    alignConsensusSkill,
    alignConsensusIntent,
    exportConsensusSkill,
  ].join('\n');

  assert.equal(result.ok, true);
  assert.equal(result.scope, 'project');
  assert.equal(result.surfaces[0].type, 'codex_plugin');
  assert.equal(result.surfaces[0].installedSkills.length, 12);
  assert.equal(manifest.name, 'magclaw-team-sharing');
  assert.equal(manifest.skills, './skills/');
  assert.equal(Object.prototype.hasOwnProperty.call(manifest, 'hooks'), false);
  assert.equal(result.feedback.status, 'ready');
  assert.match(result.feedback.sections.map((section) => section.title).join(','), /Skill 说明/);
  assert.match(skill, /team-sharing read-link "<url>" --format json/);
  assert.match(skill, /current project/i);
  assert.match(skill, /语义|intent|说法/);
  assert.match(skill, /接入 Team Sharing|团队共享|hooks|同步到 MagClaw/);
  assert.match(skill, /reason.*access.*action/);
  assert.match(skill, /CLI\/server preflight state/);
  assert.match(skill, /machine_mismatch/);
  assert.match(skill, /not browser cookies/);
  assert.match(skill, /open_browser_to_join/);
  assert.match(skill, /current CLI profile may point at server A/);
  assert.match(skill, /link belongs to server B/);
  assert.match(skill, /Trust the server-side preflight result/);
  assert.match(skill, /server_membership_required/);
  assert.match(skill, /not_found/);
  assert.match(skill, /unsupported_link/);
  assert.match(skill, /team-sharing search/);
  assert.match(skill, /team-sharing context/);
  assert.match(skill, /team-sharing share-artifact/);
  assert.match(skill, /team-sharing edit-link "<url>" --patch <patch\.json>/);
  assert.match(skill, /sections.*versionId.*contentHash.*assetRefs/s);
  assert.match(skill, /replace_section/);
  assert.match(skill, /version_conflict/);
  assert.match(skill, /team-sharing list-links --format json/);
  assert.match(skill, /team-sharing delete-link "<url-or-shareId>"/);
  assert.match(skill, /workspace Owner, or workspace Admin/);
  assert.match(skill, /--include-revoked/);
  assert.match(skill, /team-sharing import-consensus --server <server> --workspace <workspace> --file <markdown-file>/);
  assert.match(skill, /team-sharing ask-consensus --server <server> --workspace <workspace> --query "<question>"/);
  assert.match(skill, /team-sharing edit-consensus --server <server> --workspace <workspace> --doc <docId> --file <markdown-file>/);
  assert.match(skill, /team-sharing align-consensus --server <server> --workspace <workspace> --text "<discussion text>"/);
  assert.match(skill, /team-sharing export-consensus --server <server> --workspace <workspace> --consensus-id <consensusId>/);
  assert.match(skill, /Knowledge Alignment Intent Map/);
  assert.match(skill, /共识库/);
  assert.match(skill, /知识空间/);
  assert.match(skill, /知识管理/);
  assert.match(skill, /标准/);
  assert.match(skill, /口径/);
  assert.match(skill, /TeamShare/);
  assert.match(skill, /Positive Coverage Cases/);
  assert.match(skill, /Web import UI/);
  assert.match(skill, /Web ask UI/);
  assert.match(skill, /Web draft editor UI/);
  assert.match(skill, /automatic turn hook/);
  assert.match(skill, /Knowledge document links use `\/s\/<serverSlug>\/knowledge\/docs\/<docId>`/);
  assert.match(skill, /protected Team Sharing asset references/);
  assert.match(skill, /--time today/);
  assert.match(skill, /--time yesterday/);
  assert.match(skill, /--keyword/);
  assert.match(skill, /--topics/);
  assert.match(skill, /--semantic-query/);
  assert.match(skill, /--member "蒋海波"/);
  assert.match(skill, /--members "蒋海波,张三"/);
  assert.match(skill, /--member-id hum_/);
  assert.match(skill, /memberResolution/);
  assert.match(skill, /needsClarification/);
  assert.match(skill, /uploader/);
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
  assert.match(skill, /`contextWebUrl` first/);
  assert.match(skill, /contextWebUrl/);
  assert.match(skill, /Do not show bare `\/team-sharing\/context\/\.\.\.` paths/);
  assert.match(skill, /访问遵循当前 MagClaw 服务的登录和权限策略/);
  assert.doesNotMatch(skill, /public by design|publicly share/);
  assert.match(skill, /Default Share HTML Style/);
  assert.match(skill, /deep blue-black technical hero/);
  assert.match(skill, /sticky table of contents/);
  assert.match(skill, /white report cards/);
  assert.match(skill, /cyan.*emerald.*amber.*rose/i);
  assert.match(skill, /mobile viewports must not overflow/i);
  assert.doesNotMatch(skill, /team-sharing-token-secret|api_key|Bearer/i);
  await assert.rejects(() => readFile(path.join(cwd, '.agents', 'skills', 'magclaw-team-sharing', 'SKILL.md'), 'utf8'), /ENOENT/);
});

test('team sharing install falls back to user scope when no project can be detected or selected', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-no-project-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'magclaw-team-sharing-no-project-home-'));
  const env = { HOME: home, CODEX_HOME: path.join(home, '.codex'), CI: '1', MAGCLAW_TEAM_SHARING_SKIP_CODEX_PLUGIN_COMMAND: '1' };
  const result = await installTeamSharingSkill({ cwd, target: 'codex' }, env);
  const skill = await readFile(path.join(home, '.magclaw', 'team-sharing', 'codex-marketplace', 'plugins', 'magclaw-team-sharing', 'skills', 'search', 'SKILL.md'), 'utf8');

  assert.equal(result.ok, true);
  assert.equal(result.scope, 'user');
  assert.equal(result.projectDir, '');
  assert.match(skill, /team-sharing search/);
});
