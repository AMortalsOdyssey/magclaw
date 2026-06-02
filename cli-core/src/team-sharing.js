import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { installTeamMemoryHookConfig } from './team-memory-hooks.js';

export const TEAM_SHARING_PACKAGE_NAME = '@magclaw/team-sharing';
export const TEAM_SHARING_INTEGRATION = 'team-sharing';
const DEFAULT_PROFILE = 'default';
const DEFAULT_SERVER_URL = 'http://127.0.0.1:6543';

function now() {
  return new Date().toISOString();
}

function homeDirForEnv(env = process.env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

function safeProfileName(value = DEFAULT_PROFILE) {
  return String(value || DEFAULT_PROFILE).trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || DEFAULT_PROFILE;
}

function normalizeServerUrl(value = '') {
  return String(value || DEFAULT_SERVER_URL).trim().replace(/\/+$/, '') || DEFAULT_SERVER_URL;
}

function normalizeRuntime(value = '') {
  const runtime = String(value || '').trim().toLowerCase();
  if (runtime === 'claude' || runtime === 'claude-code') return 'claude_code';
  if (runtime === 'claude_code') return 'claude_code';
  if (runtime === 'codex') return 'codex';
  return runtime || 'codex';
}

function boolFlag(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function yamlScalar(value) {
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (!text) return '';
  if (/^[A-Za-z0-9_./:@?=&%+\-]+$/.test(text)) return text;
  return JSON.stringify(text);
}

function writeYamlLines(value, indent = 0) {
  const pad = ' '.repeat(indent);
  const lines = [];
  for (const [key, item] of Object.entries(value || {})) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      lines.push(`${pad}${key}:`);
      lines.push(...writeYamlLines(item, indent + 2));
    } else {
      lines.push(`${pad}${key}: ${yamlScalar(item)}`);
    }
  }
  return lines;
}

export function stringifyTeamSharingYaml(value = {}) {
  return `${writeYamlLines(value).join('\n')}\n`;
}

function parseScalar(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text === 'true') return true;
  if (text === 'false') return false;
  if (text === 'null') return null;
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  return text;
}

export function parseTeamSharingYaml(text = '') {
  const root = {};
  const stack = [{ indent: -1, value: root }];
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    const match = rawLine.match(/^(\s*)([^:]+):(.*)$/);
    if (!match) continue;
    const indent = match[1].length;
    const key = match[2].trim();
    const rest = match[3].trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].value;
    if (!rest) {
      const child = {};
      parent[key] = child;
      stack.push({ indent, value: child });
    } else {
      parent[key] = parseScalar(rest);
    }
  }
  return root;
}

async function readYamlFile(file, fallback = null) {
  try {
    return parseTeamSharingYaml(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeYamlFile(file, value, { privateFile = false } = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, stringifyTeamSharingYaml(value));
  if (privateFile) await chmod(file, 0o600).catch(() => {});
}

export function teamSharingPaths({ profile = DEFAULT_PROFILE, cwd = process.cwd(), env = process.env } = {}) {
  const home = homeDirForEnv(env);
  const sharingHome = path.resolve(env.MAGCLAW_TEAM_SHARING_HOME || path.join(home, '.magclaw', 'team-sharing'));
  const projectDir = path.resolve(cwd || process.cwd());
  const cleanProfile = safeProfileName(profile || env.MAGCLAW_TEAM_SHARING_PROFILE || env.MAGCLAW_MEMORY_PROFILE || DEFAULT_PROFILE);
  return {
    profile: cleanProfile,
    sharingHome,
    profileConfig: path.join(sharingHome, 'profiles', cleanProfile, 'config.yaml'),
    projectsConfig: path.join(sharingHome, 'projects.yaml'),
    versionCache: path.join(sharingHome, 'version-cache.json'),
    projectConfig: path.join(projectDir, '.magclaw', 'team-sharing.yaml'),
    legacyProjectConfig: path.join(projectDir, '.magclaw', 'team-memory.json'),
    projectCursor: path.join(projectDir, '.magclaw', 'team-memory-cursor.json'),
  };
}

export async function readTeamSharingProfileConfig(profile = DEFAULT_PROFILE, env = process.env) {
  const paths = teamSharingPaths({ profile, env });
  return {
    paths,
    config: await readYamlFile(paths.profileConfig, {}),
  };
}

async function writeTeamSharingProfileConfig(profile, config, env = process.env) {
  const paths = teamSharingPaths({ profile, env });
  await writeYamlFile(paths.profileConfig, config, { privateFile: true });
  return paths.profileConfig;
}

export async function readTeamSharingProjectConfig({ profile = DEFAULT_PROFILE, cwd = process.cwd(), env = process.env } = {}) {
  const paths = teamSharingPaths({ profile, cwd, env });
  return {
    paths,
    config: await readYamlFile(paths.projectConfig, null),
  };
}

export function convertTeamSharingProjectToMemoryConfig(config = {}) {
  if (!config) return null;
  return {
    version: Number(config.version || 1),
    enabled: config.enabled !== false,
    profile: safeProfileName(config.profile || DEFAULT_PROFILE),
    serverUrl: normalizeServerUrl(config.server_url || config.serverUrl),
    workspaceId: String(config.workspace_id || config.workspaceId || 'local'),
    channelId: String(config.channel?.id || ''),
    channelPath: String(config.channel?.path || ''),
    routingMode: String(config.routing_mode || config.routingMode || 'fixed_single_channel'),
    projectKey: String(config.project_key || config.projectKey || 'default'),
    enabledSince: String(config.enabled_since || config.enabledSince || ''),
    runtimes: {
      codex: {
        hooksEnabled: config.runtimes?.codex?.hooks_enabled !== false,
        skillsEnabled: config.runtimes?.codex?.skills_enabled !== false,
      },
      claude_code: {
        hooksEnabled: config.runtimes?.claude_code?.hooks_enabled !== false,
        skillsEnabled: config.runtimes?.claude_code?.skills_enabled !== false,
      },
    },
  };
}

async function registerTeamSharingProject(paths, config) {
  const registry = await readYamlFile(paths.projectsConfig, {});
  registry.version = 1;
  registry.projects = registry.projects && typeof registry.projects === 'object' ? registry.projects : {};
  const key = String(config.project_key || config.projectKey || path.basename(path.dirname(path.dirname(paths.projectConfig)))).replace(/[^a-zA-Z0-9._-]+/g, '-');
  registry.projects[key || 'default'] = {
    path: path.dirname(path.dirname(paths.projectConfig)),
    project_key: config.project_key || key || 'default',
    channel_path: config.channel?.path || '',
    channel_id: config.channel?.id || '',
    profile: config.profile || DEFAULT_PROFILE,
    updated_at: now(),
  };
  await writeYamlFile(paths.projectsConfig, registry, { privateFile: true });
}

export async function initTeamSharingProject(flags = {}, env = process.env) {
  const cwd = path.resolve(flags.cwd || process.cwd());
  const profile = safeProfileName(flags.profile || env.MAGCLAW_TEAM_SHARING_PROFILE || env.MAGCLAW_MEMORY_PROFILE || DEFAULT_PROFILE);
  const paths = teamSharingPaths({ profile, cwd, env });
  const existing = await readYamlFile(paths.projectConfig, {});
  const channel = String(flags.channel || flags.channelPath || flags.channelId || flags._?.[1] || existing.channel?.path || existing.channel?.id || '').trim();
  if (!channel) throw new Error('Usage: magclaw team-sharing init --channel <channelPathOrId>');
  const channelIsPath = /^(https?|feishu|lark|mc):/i.test(channel);
  const projectKey = String(flags.projectKey || flags.project || existing.project_key || path.basename(cwd)).trim();
  const config = {
    version: 1,
    enabled: boolFlag(flags.enabled, existing.enabled !== false),
    profile,
    server_url: normalizeServerUrl(flags.serverUrl || existing.server_url || env.MAGCLAW_PUBLIC_URL || DEFAULT_SERVER_URL),
    workspace_id: String(flags.workspaceId || flags.workspace || existing.workspace_id || env.MAGCLAW_WORKSPACE_ID || 'local').trim(),
    project_key: projectKey,
    routing_mode: 'fixed_single_channel',
    channel: {
      id: String(flags.channelId || (!channelIsPath ? channel : existing.channel?.id || '')).trim(),
      path: String(flags.channelPath || (channelIsPath ? channel : existing.channel?.path || '')).trim(),
    },
    runtimes: {
      codex: {
        hooks_enabled: boolFlag(flags.codexHooksEnabled, existing.runtimes?.codex?.hooks_enabled !== false),
        skills_enabled: boolFlag(flags.codexSkillsEnabled, existing.runtimes?.codex?.skills_enabled !== false),
      },
      claude_code: {
        hooks_enabled: boolFlag(flags.claudeHooksEnabled, existing.runtimes?.claude_code?.hooks_enabled !== false),
        skills_enabled: boolFlag(flags.claudeSkillsEnabled, existing.runtimes?.claude_code?.skills_enabled !== false),
      },
    },
    enabled_since: String(flags.enabledSince || existing.enabled_since || now()),
    upgrade: {
      check_interval_hours: String(flags.upgradeCheckIntervalHours || existing.upgrade?.check_interval_hours || 24),
    },
    created_at: existing.created_at || now(),
    updated_at: now(),
  };
  await writeYamlFile(paths.projectConfig, config);
  await registerTeamSharingProject(paths, config);
  return {
    ok: true,
    projectConfig: paths.projectConfig,
    projectsConfig: paths.projectsConfig,
    profile,
    serverUrl: config.server_url,
    workspaceId: config.workspace_id,
    channelId: config.channel.id,
    channelPath: config.channel.path,
    projectKey,
  };
}

export async function listTeamSharingProjects(flags = {}, env = process.env) {
  const paths = teamSharingPaths({ profile: flags.profile || env.MAGCLAW_TEAM_SHARING_PROFILE || DEFAULT_PROFILE, env });
  const registry = await readYamlFile(paths.projectsConfig, { version: 1, projects: {} });
  return { ok: true, projectsConfig: paths.projectsConfig, projects: registry.projects || {} };
}

export async function statusTeamSharingProject(flags = {}, env = process.env) {
  const profile = safeProfileName(flags.profile || env.MAGCLAW_TEAM_SHARING_PROFILE || DEFAULT_PROFILE);
  const project = await readTeamSharingProjectConfig({ profile, cwd: flags.cwd || process.cwd(), env });
  const profileState = await readTeamSharingProfileConfig(profile, env);
  return {
    ok: Boolean(project.config),
    projectConfig: project.paths.projectConfig,
    profileConfig: profileState.paths.profileConfig,
    configured: Boolean(project.config),
    loggedIn: Boolean(profileState.config?.token),
    config: project.config || null,
  };
}

export async function setTeamSharingProjectEnabled(flags = {}, env = process.env, enabled = true) {
  const profile = safeProfileName(flags.profile || env.MAGCLAW_TEAM_SHARING_PROFILE || DEFAULT_PROFILE);
  const project = await readTeamSharingProjectConfig({ profile, cwd: flags.cwd || process.cwd(), env });
  if (!project.config) throw new Error('Run `magclaw team-sharing init --channel <channel>` first.');
  project.config.enabled = Boolean(enabled);
  project.config.updated_at = now();
  if (enabled && !project.config.enabled_since) project.config.enabled_since = now();
  await writeYamlFile(project.paths.projectConfig, project.config);
  return { ok: true, enabled: Boolean(enabled), projectConfig: project.paths.projectConfig };
}

export async function unsetTeamSharingProject(flags = {}, env = process.env) {
  const profile = safeProfileName(flags.profile || env.MAGCLAW_TEAM_SHARING_PROFILE || DEFAULT_PROFILE);
  const project = await readTeamSharingProjectConfig({ profile, cwd: flags.cwd || process.cwd(), env });
  await rm(project.paths.projectConfig, { force: true });
  return { ok: true, removed: Boolean(project.config), projectConfig: project.paths.projectConfig };
}

async function teamSharingRequestJson({ serverUrl, token = '', method = 'GET', pathname = '/', body = null } = {}) {
  const response = await fetch(`${normalizeServerUrl(serverUrl)}${pathname}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || data.message || `${response.status} ${response.statusText}`);
  return data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maybeOpenUrl(url, flags = {}, env = process.env) {
  if (!url || flags.noOpen || flags.open === false || env.MAGCLAW_TEAM_SHARING_OPEN_BROWSER === '0') return;
  if (process.platform === 'darwin') spawnSync('open', [url], { stdio: 'ignore' });
  else if (process.platform === 'win32') spawnSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
  else spawnSync('xdg-open', [url], { stdio: 'ignore' });
}

export async function loginTeamSharingProfile(flags = {}, env = process.env) {
  const profile = safeProfileName(flags.profile || env.MAGCLAW_TEAM_SHARING_PROFILE || env.MAGCLAW_MEMORY_PROFILE || DEFAULT_PROFILE);
  const existing = (await readTeamSharingProfileConfig(profile, env)).config || {};
  const serverUrl = normalizeServerUrl(flags.serverUrl || existing.server_url || env.MAGCLAW_PUBLIC_URL || DEFAULT_SERVER_URL);
  const workspaceId = String(flags.workspaceId || flags.workspace || existing.workspace_id || env.MAGCLAW_WORKSPACE_ID || 'local').trim();
  const manualToken = String(flags.token || flags.apiKey || flags.memoryToken || env.MAGCLAW_TEAM_SHARING_TOKEN || env.MAGCLAW_MEMORY_TOKEN || '').trim();
  let token = manualToken;
  let user = {};
  if (!token) {
    const started = await teamSharingRequestJson({
      serverUrl,
      method: 'POST',
      pathname: '/api/team-memory/auth/start',
      body: { workspaceId, profile, packageName: TEAM_SHARING_PACKAGE_NAME },
    });
    maybeOpenUrl(started.verificationUri, flags, env);
    const intervalMs = Math.max(1, Math.min(10_000, Number(started.intervalMs || 2000) || 2000));
    const deadline = Date.now() + Math.max(1000, Number(flags.pollTimeoutMs || 10 * 60_000) || 10 * 60_000);
    while (Date.now() < deadline) {
      const status = await teamSharingRequestJson({
        serverUrl,
        method: 'POST',
        pathname: '/api/team-memory/auth/token',
        body: { deviceCode: started.deviceCode },
      });
      if (status.status === 'approved' && status.token) {
        token = status.token;
        user = status.user || {};
        break;
      }
      if (status.status === 'expired') throw new Error(status.error || 'Team Sharing login expired.');
      await sleep(intervalMs);
    }
    if (!token) throw new Error('Team Sharing login timed out.');
  }
  const config = {
    version: 1,
    profile,
    server_url: serverUrl,
    workspace_id: workspaceId,
    token,
    token_scope: 'team_memory:sync,team_memory:search,team_memory:context,team_memory:feedback,team_memory:share',
    user_id: user.id || existing.user_id || '',
    user_email: user.email || existing.user_email || '',
    created_at: existing.created_at || now(),
    updated_at: now(),
  };
  const profileConfig = await writeTeamSharingProfileConfig(profile, config, env);
  return { ok: true, profile, serverUrl, workspaceId, hasToken: Boolean(token), profileConfig, user };
}

export async function logoutTeamSharingProfile(flags = {}, env = process.env) {
  const profile = safeProfileName(flags.profile || env.MAGCLAW_TEAM_SHARING_PROFILE || env.MAGCLAW_MEMORY_PROFILE || DEFAULT_PROFILE);
  const { paths, config } = await readTeamSharingProfileConfig(profile, env);
  const token = String(config?.token || '').trim();
  if (token) {
    await teamSharingRequestJson({
      serverUrl: config.server_url || flags.serverUrl || DEFAULT_SERVER_URL,
      token,
      method: 'POST',
      pathname: '/api/team-memory/auth/revoke',
      body: { profile },
    }).catch(() => null);
  }
  await rm(paths.profileConfig, { force: true });
  return { ok: true, profile, revoked: Boolean(token), profileConfig: paths.profileConfig };
}

export async function whoamiTeamSharingProfile(flags = {}, env = process.env) {
  const profile = safeProfileName(flags.profile || env.MAGCLAW_TEAM_SHARING_PROFILE || env.MAGCLAW_MEMORY_PROFILE || DEFAULT_PROFILE);
  const { config } = await readTeamSharingProfileConfig(profile, env);
  const token = String(config?.token || env.MAGCLAW_TEAM_SHARING_TOKEN || '').trim();
  if (!token) throw new Error('Run `magclaw team-sharing login` first.');
  return teamSharingRequestJson({
    serverUrl: flags.serverUrl || config.server_url || DEFAULT_SERVER_URL,
    token,
    pathname: '/api/team-memory/auth/whoami',
  });
}

function selectedTargets(flags = {}, env = process.env) {
  const raw = String(flags.target || flags.runtime || '').trim().toLowerCase();
  const parts = raw ? raw.split(',').map((item) => normalizeRuntime(item)).filter(Boolean) : [];
  const requested = new Set(parts.length ? parts : ['all']);
  if (requested.has('all')) {
    const home = homeDirForEnv(env);
    const detected = [];
    if (env.CODEX_HOME || existsSync(path.join(home, '.codex'))) detected.push('codex');
    if (env.CLAUDE_HOME || existsSync(path.join(home, '.claude'))) detected.push('claude_code');
    return detected.length ? detected : ['codex', 'claude_code'];
  }
  return [...requested].map(normalizeRuntime);
}

async function promptSetupTarget(flags = {}, env = process.env) {
  if (flags.target || flags.runtime || flags.yes || flags.nonInteractive || env.CI) return flags;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return flags;
  const detected = selectedTargets({ ...flags, target: 'all' }, env);
  if (detected.length < 2) return { ...flags, target: detected[0] || 'all' };
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Install Team Sharing for [a]ll, [c]odex, or c[l]aude? ');
    const clean = String(answer || '').trim().toLowerCase();
    if (clean === 'c' || clean === 'codex') return { ...flags, target: 'codex' };
    if (clean === 'l' || clean === 'claude' || clean === 'claude_code') return { ...flags, target: 'claude_code' };
    return { ...flags, target: 'all' };
  } finally {
    rl.close();
  }
}

function targetConfigPath(runtime, flags = {}, env = process.env) {
  const home = homeDirForEnv(env);
  if (runtime === 'claude_code') return flags.claudeConfig || path.join(home, '.claude', 'settings.json');
  return flags.codexConfig || path.join(home, '.codex', 'hooks.json');
}

async function readJsonFile(file, fallback = {}) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function hookEventsForRuntime(runtime) {
  return normalizeRuntime(runtime) === 'claude_code'
    ? ['Stop', 'SessionEnd', 'PreCompact', 'SessionStart']
    : ['Stop', 'PreCompact', 'SessionStart'];
}

export async function installTeamSharingHooks(flags = {}, env = process.env) {
  const cwd = path.resolve(flags.cwd || process.cwd());
  const output = { ok: true };
  for (const runtime of selectedTargets(flags, env)) {
    const key = runtime === 'claude_code' ? 'claude' : 'codex';
    output[key] = await installTeamMemoryHookConfig({
      runtime,
      configPath: targetConfigPath(runtime, flags, env),
      projectDir: cwd,
      integration: TEAM_SHARING_INTEGRATION,
    });
  }
  output.ok = Object.values(output).every((item) => item === true || item?.ok !== false);
  return output;
}

export async function statusTeamSharingHooks(flags = {}, env = process.env) {
  const output = { ok: true };
  for (const runtime of selectedTargets(flags, env)) {
    const key = runtime === 'claude_code' ? 'claude' : 'codex';
    const configPath = targetConfigPath(runtime, flags, env);
    const config = await readJsonFile(configPath, {});
    const installed = [];
    for (const eventName of hookEventsForRuntime(runtime)) {
      for (const entry of Array.isArray(config.hooks?.[eventName]) ? config.hooks[eventName] : []) {
        for (const hook of Array.isArray(entry.hooks) ? entry.hooks : []) {
          if (String(hook.command || '').includes('--integration team-sharing')) installed.push(eventName);
        }
      }
    }
    output[key] = { ok: true, runtime, configPath, installed };
  }
  return output;
}

export async function removeTeamSharingHooks(flags = {}, env = process.env) {
  const output = { ok: true };
  for (const runtime of selectedTargets(flags, env)) {
    const key = runtime === 'claude_code' ? 'claude' : 'codex';
    const configPath = targetConfigPath(runtime, flags, env);
    const config = await readJsonFile(configPath, {});
    const removed = [];
    for (const eventName of hookEventsForRuntime(runtime)) {
      const entries = Array.isArray(config.hooks?.[eventName]) ? config.hooks[eventName] : [];
      for (const entry of entries) {
        const before = Array.isArray(entry.hooks) ? entry.hooks : [];
        entry.hooks = before.filter((hook) => {
          const remove = String(hook.command || '').includes('--integration team-sharing');
          if (remove) removed.push(eventName);
          return !remove;
        });
      }
    }
    await writeJsonFile(configPath, config);
    output[key] = { ok: true, runtime, configPath, removed };
  }
  return output;
}

function teamSharingSkillMarkdown() {
  return [
    '---',
    'name: magclaw-team-memory',
    'description: Search, read, and cite MagClaw Team Sharing memory from Codex and Claude Code sessions.',
    '---',
    '',
    '# MagClaw Team Sharing',
    '',
    'Use this skill when the user asks what teammates discussed, wants to align with another AI session, or needs original MagClaw conversation context.',
    '',
    '## Workflow',
    '',
    '1. Run `magclaw team-sharing search --query "<question>" --limit 5` from the configured project directory.',
    '2. Use returned L0/L1 evidence for rough answers.',
    '3. For deep follow-up, run `magclaw team-sharing context --session-id <sessionId> --anchor-event-id <eventId> --direction around --limit 20`.',
    '4. Cite session titles, source refs, and context URLs.',
    '',
    '## Rules',
    '',
    '- Do not upload local secrets or raw tool output.',
    '- Prefer concise synthesis before pulling original context.',
    '- If confidence is low, ask the user for a narrower date, channel, or topic.',
    '',
  ].join('\n');
}

function skillRootForTarget(runtime, env = process.env) {
  const home = homeDirForEnv(env);
  if (runtime === 'claude_code') return path.resolve(env.CLAUDE_HOME || path.join(home, '.claude'));
  return path.resolve(env.CODEX_HOME || path.join(home, '.codex'));
}

async function writeTeamSharingSkill(rootDir) {
  const skillDir = path.join(rootDir, 'skills', 'magclaw-team-memory');
  await mkdir(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, 'SKILL.md');
  await writeFile(skillPath, teamSharingSkillMarkdown());
  return skillPath;
}

export async function installTeamSharingSkill(flags = {}, env = process.env) {
  const output = { ok: true, installed: [] };
  for (const runtime of selectedTargets(flags, env)) {
    output.installed.push({ target: runtime, path: await writeTeamSharingSkill(skillRootForTarget(runtime, env)) });
  }
  output.ok = output.installed.length > 0;
  return output;
}

export async function statusTeamSharingSkill(flags = {}, env = process.env) {
  const installed = [];
  for (const runtime of selectedTargets(flags, env)) {
    const skillPath = path.join(skillRootForTarget(runtime, env), 'skills', 'magclaw-team-memory', 'SKILL.md');
    if (existsSync(skillPath)) installed.push({ target: runtime, path: skillPath });
  }
  return { ok: true, installed };
}

export async function removeTeamSharingSkill(flags = {}, env = process.env) {
  const removed = [];
  for (const runtime of selectedTargets(flags, env)) {
    const skillDir = path.join(skillRootForTarget(runtime, env), 'skills', 'magclaw-team-memory');
    if (existsSync(skillDir)) {
      await rm(skillDir, { recursive: true, force: true });
      removed.push({ target: runtime, path: skillDir });
    }
  }
  return { ok: true, removed };
}

export async function disableTeamSharingSkill(flags = {}, env = process.env) {
  const disabled = [];
  for (const runtime of selectedTargets(flags, env)) {
    const skillPath = path.join(skillRootForTarget(runtime, env), 'skills', 'magclaw-team-memory', 'SKILL.md');
    const disabledPath = `${skillPath}.disabled`;
    if (existsSync(skillPath)) {
      await rename(skillPath, disabledPath);
      disabled.push({ target: runtime, path: disabledPath });
    }
  }
  return { ok: true, disabled };
}

export async function setupTeamSharing(flags = {}, env = process.env) {
  flags = await promptSetupTarget(flags, env);
  const profile = safeProfileName(flags.profile || env.MAGCLAW_TEAM_SHARING_PROFILE || env.MAGCLAW_MEMORY_PROFILE || DEFAULT_PROFILE);
  const profileConfig = await readTeamSharingProfileConfig(profile, env);
  if (!flags.noLogin && !profileConfig.config?.token) {
    await loginTeamSharingProfile(flags, env);
  }
  const project = await initTeamSharingProject(flags, env);
  const hooks = await installTeamSharingHooks(flags, env);
  const skill = await installTeamSharingSkill(flags, env);
  return {
    ok: Boolean(project.ok && hooks.ok && skill.ok),
    project,
    hooks,
    skill,
  };
}

function semverParts(value = '') {
  return String(value || '').replace(/^[^\d]*/, '').split(/[.-]/).slice(0, 3).map((part) => Number(part) || 0);
}

function semverGreater(left = '', right = '') {
  const a = semverParts(left);
  const b = semverParts(right);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] > b[index]) return true;
    if (a[index] < b[index]) return false;
  }
  return false;
}

export async function checkTeamSharingUpgrade(options = {}, env = process.env) {
  const paths = teamSharingPaths({ env });
  const nowMs = typeof options.nowMs === 'function' ? options.nowMs() : Date.now();
  const ttlMs = Math.max(60_000, Number(options.ttlMs || env.MAGCLAW_TEAM_SHARING_UPGRADE_TTL_MS || 24 * 60 * 60 * 1000) || 24 * 60 * 60 * 1000);
  const currentVersion = String(options.currentVersion || env.MAGCLAW_TEAM_SHARING_VERSION || env.MAGCLAW_ENTRY_PACKAGE_VERSION || '0.0.0');
  const cached = await readJsonFile(paths.versionCache, null);
  if (!options.force && cached?.checkedAtMs && nowMs - Number(cached.checkedAtMs) < ttlMs) {
    return {
      ok: true,
      fromCache: true,
      currentVersion,
      latestVersion: cached.latestVersion || currentVersion,
      upgradeAvailable: semverGreater(cached.latestVersion || currentVersion, currentVersion),
      checkedAtMs: cached.checkedAtMs,
    };
  }
  const encodedPackageName = encodeURIComponent(TEAM_SHARING_PACKAGE_NAME);
  const response = await fetch(`https://registry.npmjs.org/${encodedPackageName}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `npm registry returned ${response.status}`);
  const latestVersion = String(data?.['dist-tags']?.latest || currentVersion);
  const result = {
    ok: true,
    fromCache: false,
    currentVersion,
    latestVersion,
    upgradeAvailable: semverGreater(latestVersion, currentVersion),
    checkedAtMs: nowMs,
  };
  await writeJsonFile(paths.versionCache, result);
  return result;
}
