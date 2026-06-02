import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import {
  buildTeamSharingSyncPackageFromTranscript,
  installTeamSharingHookConfig,
  parseTeamSharingTranscript,
} from './team-sharing-hooks.js';

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

function shellQuote(value = '') {
  return `'${String(value || '').replace(/'/g, "'\\''")}'`;
}

function teamSharingShimBinDir(flags = {}, env = process.env) {
  const explicit = String(flags.teamSharingBinDir || flags.binDir || env.MAGCLAW_TEAM_SHARING_BIN_DIR || '').trim();
  if (explicit) return path.resolve(explicit);
  return path.join(homeDirForEnv(env), '.local', 'bin');
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
  if (!text) return '""';
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
  const lines = String(text || '').split(/\r?\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex];
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) continue;
    const match = rawLine.match(/^(\s*)([^:]+):(.*)$/);
    if (!match) continue;
    const indent = match[1].length;
    const key = match[2].trim();
    const rest = match[3].trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1].value;
    if (!rest) {
      let hasChild = false;
      for (let nextIndex = lineIndex + 1; nextIndex < lines.length; nextIndex += 1) {
        const nextLine = lines[nextIndex];
        if (!nextLine.trim() || nextLine.trimStart().startsWith('#')) continue;
        const nextMatch = nextLine.match(/^(\s*)([^:]+):(.*)$/);
        hasChild = Boolean(nextMatch && nextMatch[1].length > indent);
        break;
      }
      if (hasChild) {
        const child = {};
        parent[key] = child;
        stack.push({ indent, value: child });
      } else {
        parent[key] = '';
      }
    } else {
      parent[key] = parseScalar(rest);
    }
  }
  return root;
}

function stringConfigValue(value, fallback = '') {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'object') return fallback;
  return String(value);
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

function teamSharingShimFiles({ npmPath = 'npm', packageSpec = `${TEAM_SHARING_PACKAGE_NAME}@latest` } = {}) {
  const cleanNpmPath = String(npmPath || 'npm').trim() || 'npm';
  const cleanPackageSpec = String(packageSpec || `${TEAM_SHARING_PACKAGE_NAME}@latest`).trim() || `${TEAM_SHARING_PACKAGE_NAME}@latest`;
  return [
    {
      name: 'team-sharing',
      content: [
        '#!/bin/sh',
        `exec ${shellQuote(cleanNpmPath)} exec --yes --package ${shellQuote(cleanPackageSpec)} -- team-sharing "$@"`,
        '',
      ].join('\n'),
    },
    {
      name: 'team-sharing.cmd',
      content: [
        '@echo off',
        `"${cleanNpmPath}" exec --yes --package "${cleanPackageSpec}" -- team-sharing %*`,
        '',
      ].join('\r\n'),
    },
  ];
}

async function writeTeamSharingShimFile(file, content) {
  let previous = '';
  try {
    previous = await readFile(file, 'utf8');
  } catch {}
  if (previous === content) {
    await chmod(file, 0o755).catch(() => {});
    return { file, changed: false };
  }
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  await chmod(file, 0o755).catch(() => {});
  return { file, changed: true };
}

export async function installTeamSharingShim(flags = {}, env = process.env) {
  if (env.MAGCLAW_TEAM_SHARING_INSTALL_SHIM === '0' || flags.installShim === false || flags.noInstallShim) {
    return { ok: true, installed: false, skipped: true, reason: 'disabled' };
  }
  const binDir = teamSharingShimBinDir(flags, env);
  const npmPath = String(flags.npmPath || env.MAGCLAW_TEAM_SHARING_NPM_PATH || 'npm').trim() || 'npm';
  const packageSpec = String(flags.packageSpec || flags.teamSharingPackageSpec || env.MAGCLAW_TEAM_SHARING_PACKAGE_SPEC || `${TEAM_SHARING_PACKAGE_NAME}@latest`).trim() || `${TEAM_SHARING_PACKAGE_NAME}@latest`;
  const files = [];
  for (const shim of teamSharingShimFiles({ npmPath, packageSpec })) {
    files.push(await writeTeamSharingShimFile(path.join(binDir, shim.name), shim.content));
  }
  const changed = files.some((file) => file.changed);
  return {
    ok: true,
    command: 'team-sharing',
    installed: changed,
    updated: changed,
    binDir,
    path: path.join(binDir, process.platform === 'win32' ? 'team-sharing.cmd' : 'team-sharing'),
    files: files.map((file) => file.file),
    reason: changed ? 'installed_or_updated' : 'already_current',
  };
}

export function teamSharingPaths({ profile = DEFAULT_PROFILE, cwd = process.cwd(), env = process.env } = {}) {
  const home = homeDirForEnv(env);
  const sharingHome = path.resolve(env.MAGCLAW_TEAM_SHARING_HOME || path.join(home, '.magclaw', 'team-sharing'));
  const projectDir = path.resolve(cwd || process.cwd());
  const cleanProfile = safeProfileName(profile || env.MAGCLAW_TEAM_SHARING_PROFILE || DEFAULT_PROFILE);
  return {
    profile: cleanProfile,
    sharingHome,
    profileConfig: path.join(sharingHome, 'profiles', cleanProfile, 'config.yaml'),
    projectsConfig: path.join(sharingHome, 'projects.yaml'),
    versionCache: path.join(sharingHome, 'version-cache.json'),
    projectConfig: path.join(projectDir, '.magclaw', 'team-sharing.yaml'),
    projectCursor: path.join(projectDir, '.magclaw', 'team-sharing-cursor.json'),
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

export function normalizeTeamSharingProjectConfig(config = {}) {
  if (!config) return null;
  return {
    version: Number(config.version || 1),
    enabled: config.enabled !== false,
    profile: safeProfileName(config.profile || DEFAULT_PROFILE),
    serverUrl: normalizeServerUrl(config.server_url || config.serverUrl),
    workspaceId: stringConfigValue(config.workspace_id || config.workspaceId, 'local'),
    channelId: stringConfigValue(config.channel?.id, ''),
    channelPath: stringConfigValue(config.channel?.path, ''),
    routingMode: String(config.routing_mode || config.routingMode || 'fixed_single_channel'),
    projectKey: stringConfigValue(config.project_key || config.projectKey, 'default'),
    enabledSince: stringConfigValue(config.enabled_since || config.enabledSince, ''),
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
  const profile = safeProfileName(flags.profile || env.MAGCLAW_TEAM_SHARING_PROFILE || DEFAULT_PROFILE);
  const paths = teamSharingPaths({ profile, cwd, env });
  const existing = await readYamlFile(paths.projectConfig, {});
  const channel = String(flags.channel || flags.channelPath || flags.channelId || flags._?.[1] || existing.channel?.path || existing.channel?.id || '').trim();
  if (!channel) throw new Error('Usage: team-sharing init --channel <channelPathOrId>');
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
  if (!project.config) throw new Error('Run `team-sharing init --channel <channel>` first.');
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
  const profile = safeProfileName(flags.profile || env.MAGCLAW_TEAM_SHARING_PROFILE || DEFAULT_PROFILE);
  const existing = (await readTeamSharingProfileConfig(profile, env)).config || {};
  const serverUrl = normalizeServerUrl(flags.serverUrl || existing.server_url || env.MAGCLAW_PUBLIC_URL || DEFAULT_SERVER_URL);
  const workspaceId = String(flags.workspaceId || flags.workspace || existing.workspace_id || env.MAGCLAW_WORKSPACE_ID || 'local').trim();
  const manualToken = String(flags.token || flags.apiKey || flags.teamSharingToken || env.MAGCLAW_TEAM_SHARING_TOKEN || '').trim();
  let token = manualToken;
  let user = {};
  if (!token) {
    const started = await teamSharingRequestJson({
      serverUrl,
      method: 'POST',
      pathname: '/api/team-sharing/auth/start',
      body: { workspaceId, profile, packageName: TEAM_SHARING_PACKAGE_NAME },
    });
    maybeOpenUrl(started.verificationUri, flags, env);
    const intervalMs = Math.max(1, Math.min(10_000, Number(started.intervalMs || 2000) || 2000));
    const deadline = Date.now() + Math.max(1000, Number(flags.pollTimeoutMs || 10 * 60_000) || 10 * 60_000);
    while (Date.now() < deadline) {
      const status = await teamSharingRequestJson({
        serverUrl,
        method: 'POST',
        pathname: '/api/team-sharing/auth/token',
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
    token_scope: 'team_sharing:sync,team_sharing:search,team_sharing:context,team_sharing:feedback,team_sharing:share',
    user_id: user.id || existing.user_id || '',
    user_email: user.email || existing.user_email || '',
    created_at: existing.created_at || now(),
    updated_at: now(),
  };
  const profileConfig = await writeTeamSharingProfileConfig(profile, config, env);
  return { ok: true, profile, serverUrl, workspaceId, hasToken: Boolean(token), profileConfig, user };
}

export async function logoutTeamSharingProfile(flags = {}, env = process.env) {
  const profile = safeProfileName(flags.profile || env.MAGCLAW_TEAM_SHARING_PROFILE || DEFAULT_PROFILE);
  const { paths, config } = await readTeamSharingProfileConfig(profile, env);
  const token = String(config?.token || '').trim();
  if (token) {
    await teamSharingRequestJson({
      serverUrl: config.server_url || flags.serverUrl || DEFAULT_SERVER_URL,
      token,
      method: 'POST',
      pathname: '/api/team-sharing/auth/revoke',
      body: { profile },
    }).catch(() => null);
  }
  await rm(paths.profileConfig, { force: true });
  return { ok: true, profile, revoked: Boolean(token), profileConfig: paths.profileConfig };
}

export async function whoamiTeamSharingProfile(flags = {}, env = process.env) {
  const profile = safeProfileName(flags.profile || env.MAGCLAW_TEAM_SHARING_PROFILE || DEFAULT_PROFILE);
  const { config } = await readTeamSharingProfileConfig(profile, env);
  const token = String(config?.token || env.MAGCLAW_TEAM_SHARING_TOKEN || '').trim();
  if (!token) throw new Error('Run `team-sharing login` first.');
  return teamSharingRequestJson({
    serverUrl: flags.serverUrl || config.server_url || DEFAULT_SERVER_URL,
    token,
    pathname: '/api/team-sharing/auth/whoami',
  });
}

async function readTeamSharingProfile(profile, env = process.env) {
  return readTeamSharingProfileConfig(profile, env);
}

async function resolveTeamSharingClient(flags = {}, env = process.env) {
  const profileName = safeProfileName(flags.profile || env.MAGCLAW_TEAM_SHARING_PROFILE || DEFAULT_PROFILE);
  const project = await readTeamSharingProjectConfig({ profile: profileName, cwd: flags.cwd || process.cwd(), env });
  const config = normalizeTeamSharingProjectConfig(project.config);
  if (!config) throw new Error('Run `team-sharing init --channel <channel>` in this project first.');
  const profile = await readTeamSharingProfile(flags.profile || config.profile || DEFAULT_PROFILE, env);
  const token = String(profile.config?.token || env.MAGCLAW_TEAM_SHARING_TOKEN || '').trim();
  return {
    project: {
      paths: project.paths,
      config,
    },
    profile,
    serverUrl: flags.serverUrl || config.serverUrl || profile.config?.server_url || DEFAULT_SERVER_URL,
    token,
  };
}

function cursorLastOrdinal(cursor = {}, runtime = 'codex', sessionId = '') {
  return Number(cursor?.sessions?.[runtime]?.[sessionId]?.lastOrdinal || 0);
}

async function writeTeamSharingCursor(file, runtime, cursor) {
  const existing = await readJsonFile(file, {});
  const sessions = existing.sessions && typeof existing.sessions === 'object' ? existing.sessions : {};
  sessions[runtime] = sessions[runtime] && typeof sessions[runtime] === 'object' ? sessions[runtime] : {};
  sessions[runtime][cursor.sessionId] = {
    ...(sessions[runtime][cursor.sessionId] || {}),
    ...cursor,
  };
  await writeJsonFile(file, {
    version: 1,
    sessions,
    updatedAt: now(),
  });
}

export async function syncTeamSharingTranscript(flags = {}, env = process.env) {
  const transcriptPath = String(flags.transcript || flags.file || flags._?.[1] || '').trim();
  if (!transcriptPath) {
    if (flags.hookEvent) return { ok: true, empty: true, reason: 'missing_transcript_path' };
    throw new Error('Usage: team-sharing sync --transcript <path>');
  }
  const runtime = normalizeRuntime(flags.runtime || 'codex');
  const { project, profile, serverUrl, token } = await resolveTeamSharingClient(flags, env);
  if (project.config.enabled === false) {
    if (flags.hookEvent) return { ok: true, empty: true, reason: 'project_disabled' };
    throw new Error('Team Sharing is disabled for this project.');
  }
  const runtimeConfig = project.config.runtimes?.[runtime];
  if (flags.hookEvent && runtimeConfig && runtimeConfig.hooksEnabled === false) {
    return { ok: true, empty: true, reason: 'runtime_hooks_disabled' };
  }
  const content = await readFile(path.resolve(transcriptPath), 'utf8');
  const parsed = parseTeamSharingTranscript(content, {
    runtime,
    sessionId: flags.sessionId || '',
    title: flags.title || '',
    projectDir: flags.cwd || process.cwd(),
  });
  const cursor = await readJsonFile(project.paths.projectCursor, {});
  const lastOrdinal = Number(flags.full ? 0 : cursorLastOrdinal(cursor, parsed.runtime, parsed.sessionId));
  const syncPackage = buildTeamSharingSyncPackageFromTranscript(content, {
    runtime: parsed.runtime,
    sessionId: parsed.sessionId,
    title: flags.title || parsed.title || path.basename(transcriptPath),
    projectKey: project.config.projectKey,
    workspaceId: project.config.workspaceId,
    channelId: project.config.channelId,
    channelPath: project.config.channelPath,
    projectDir: flags.cwd || process.cwd(),
    lastOrdinal,
    minCreatedAt: project.config.enabledSince || '',
  });
  if (syncPackage.empty || !syncPackage.body) return { ok: true, empty: true, cursor: syncPackage.cursor };
  if (flags.dryRun || flags.dry_run) {
    return {
      ok: true,
      dryRun: true,
      duplicate: false,
      sessionId: syncPackage.body.sessionId,
      title: syncPackage.body.title,
      fromOrdinal: syncPackage.body.fromOrdinal,
      toOrdinal: syncPackage.body.toOrdinal,
      eventCount: syncPackage.body.events.length,
      cursor: syncPackage.cursor,
    };
  }
  const result = await teamSharingRequestJson({
    serverUrl: flags.serverUrl || serverUrl || profile.config?.server_url || DEFAULT_SERVER_URL,
    token,
    method: 'POST',
    pathname: '/api/team-sharing/sync',
    body: syncPackage.body,
  });
  if (result?.ok !== false) {
    await writeTeamSharingCursor(project.paths.projectCursor, parsed.runtime, syncPackage.cursor);
  }
  return {
    ...result,
    cursor: syncPackage.cursor,
  };
}

export async function searchTeamSharing(flags = {}, env = process.env) {
  const query = String(flags.query || flags._?.slice(1).join(' ') || '').trim();
  if (!query) throw new Error('Usage: team-sharing search --query <text>');
  const { project, serverUrl, token } = await resolveTeamSharingClient(flags, env);
  return teamSharingRequestJson({
    serverUrl,
    token,
    method: 'POST',
    pathname: '/api/team-sharing/search',
    body: {
      query,
      channelId: flags.channelId || project.config.channelId || '',
      projectKey: flags.projectKey || project.config.projectKey || '',
      dateRange: flags.dateRange || null,
      candidateK: flags.candidateK || undefined,
      limit: flags.limit || 5,
    },
  });
}

export async function readTeamSharingContext(flags = {}, env = process.env) {
  const sessionId = String(flags.sessionId || flags.session || flags._?.[1] || '').trim();
  if (!sessionId) throw new Error('Usage: team-sharing context --session-id <sessionId>');
  const { serverUrl, token } = await resolveTeamSharingClient(flags, env);
  const params = new URLSearchParams();
  if (flags.anchorEventId || flags.anchor) params.set('anchorEventId', String(flags.anchorEventId || flags.anchor));
  if (flags.direction) params.set('direction', String(flags.direction));
  if (flags.limit) params.set('limit', String(flags.limit));
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return teamSharingRequestJson({
    serverUrl,
    token,
    pathname: `/api/team-sharing/context/${encodeURIComponent(sessionId)}${suffix}`,
  });
}

function inferShareArtifactType(explicit = '', filePath = '') {
  const clean = String(explicit || '').trim().toLowerCase();
  if (['html', 'markdown', 'md', 'svg', 'mermaid', 'mmd'].includes(clean)) {
    return clean === 'md' ? 'markdown' : clean === 'mmd' ? 'mermaid' : clean;
  }
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.html' || ext === '.htm') return 'html';
  if (ext === '.svg') return 'svg';
  if (ext === '.mmd' || ext === '.mermaid') return 'mermaid';
  return 'markdown';
}

function stripHtmlForTitle(value = '') {
  return String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function pickShareArtifactTitle(content = '', sourceType = 'markdown', filePath = '') {
  const text = String(content || '');
  if (sourceType === 'html') {
    const title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
      || text.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
    if (title) return stripHtmlForTitle(title);
  }
  if (sourceType === 'svg') {
    const title = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    if (title) return stripHtmlForTitle(title);
  }
  if (sourceType === 'markdown' || sourceType === 'mermaid') {
    const heading = text.match(/^#\s+(.+)$/m)?.[1];
    if (heading) return heading.replace(/\s+/g, ' ').trim();
  }
  const fallback = filePath ? path.basename(filePath, path.extname(filePath)) : '';
  return fallback || 'MagClaw shared page';
}

export async function shareTeamSharingArtifact(flags = {}, env = process.env) {
  const fileArg = String(flags.file || flags.path || flags.artifact || flags._?.[1] || '').trim();
  const inlineContent = flags.content ?? flags.markdown ?? flags.html ?? '';
  if (!fileArg && !inlineContent) {
    throw new Error('Usage: team-sharing share-artifact --file <path> [--title <title>] [--type markdown|html|svg|mermaid]');
  }
  const cwd = path.resolve(flags.cwd || process.cwd());
  const filePath = fileArg ? path.resolve(cwd, fileArg) : '';
  const content = filePath ? await readFile(filePath, 'utf8') : String(inlineContent);
  const { project, serverUrl, token } = await resolveTeamSharingClient(flags, env);
  const contentType = inferShareArtifactType(flags.type || flags.contentType, filePath);
  const title = String(flags.title || flags.name || pickShareArtifactTitle(content, contentType, filePath)).trim() || 'MagClaw shared page';
  return teamSharingRequestJson({
    serverUrl,
    token,
    method: 'POST',
    pathname: '/api/team-sharing/shares',
    body: {
      title,
      description: flags.description || '',
      contentType,
      content,
      workspaceId: flags.workspaceId || project.config.workspaceId || '',
      channelId: flags.channelId || project.config.channelId || '',
      channelPath: flags.channelPath || project.config.channelPath || '',
      projectKey: flags.projectKey || project.config.projectKey || '',
      source: {
        kind: 'cli_artifact',
        runtime: flags.runtime || '',
        file: filePath ? path.basename(filePath) : '',
      },
    },
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
    output[key] = await installTeamSharingHookConfig({
      runtime,
      configPath: targetConfigPath(runtime, flags, env),
      projectDir: cwd,
      integration: TEAM_SHARING_INTEGRATION,
      teamSharingCommand: flags.teamSharingCommand,
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
    'name: magclaw-team-sharing',
    'description: Search, read, and publicly share MagClaw Team Sharing artifacts from Codex and Claude Code sessions.',
    '---',
    '',
    '# MagClaw Team Sharing',
    '',
    'Use this skill when the user asks what teammates discussed, wants to align with another AI session, needs original MagClaw conversation context, or asks to publish a generated summary as a share link.',
    '',
    '## Workflow',
    '',
    '1. Run `team-sharing search --query "<question>" --limit 5` from the configured project directory.',
    '2. Answer from the returned L0/L1 evidence when the user only needs a rough understanding.',
    '3. For deep follow-up, run `team-sharing context --session-id <sessionId> --anchor-event-id <eventId> --direction around --limit 20`.',
    '4. Cite session titles, source refs, and context URLs from the command output.',
    '5. When the user wants to share the synthesis, prefer a standalone HTML artifact using the Default Share HTML Style below, then run `team-sharing share-artifact --file <path> --title "<title>" --type html`.',
    '6. Return the public URL from the command output. The shared page is public by design and includes the creator and creation time in the footer.',
    '',
    '## Default Share HTML Style',
    '',
    'Use this style whenever the user asks to share something with the team, use MagClaw sharing, or create a public share link, unless the user explicitly asks for another visual direction.',
    '',
    '- Format: produce one self-contained `<!doctype html>` file with inline CSS, `lang="zh-CN"` by default, `meta viewport`, smooth anchor scrolling, and no external assets unless they are already public and intentional.',
    '- Hero: start with a deep blue-black technical hero using a subtle cyan dot-grid or radial pattern over a dark linear background. Include a compact eyebrow label, an emerald pulse/status mark, a clear H1, a short subtitle, and 3-4 metric tiles for the most important facts.',
    '- Layout: use a max-width content shell around 1160px. On desktop, use a two-column layout with a 240-260px sticky table of contents on the left and report content on the right. On small screens, collapse to a single column and make the nav static.',
    '- Body surface: use a pale wash page background and white report cards for major sections. Cards should use 8px radius, 1px neutral borders, subtle slate shadows, and generous but compact padding. Do not nest cards inside cards.',
    '- Palette: use neutral ink/muted/line/paper/wash colors, with cyan as the primary technical accent, emerald for success/confirmed states, amber for warnings/tradeoffs, and rose for danger/risk. Avoid one-note blue, purple, beige, or heavy gradient pages.',
    '- Typography: use system sans-serif fonts, `letter-spacing: 0`, strong line-height for Chinese text, hero-scale type only in the hero, and compact headings inside report sections.',
    '- Components: use lead paragraphs for conclusion sentences, callouts with a 4px colored left border, small rounded tags for states, metric tiles in the hero, 3-column cards for runtime/option summaries, and simple step blocks for flows.',
    '- Tables: use full-width comparison or checklist tables with clear headers, 1px borders, readable 14px text, and horizontal overflow handling when needed.',
    '- Code and commands: render inline code with a light chip style. Render command blocks in a dark terminal panel with cyan-tinted text, rounded 8px corners, overflow-x auto, and copy-friendly plain commands.',
    '- Diagrams: prefer CSS grid flow diagrams, compact architecture maps, or Mermaid blocks when they communicate the logic faster than prose. Every diagram should have labels that make sense without the surrounding chat transcript.',
    '- Responsive rules: mobile viewports must not overflow. Collapse hero metrics, cards, and flow grids to one column below tablet width; keep tables scrollable; ensure long commands and URLs wrap or scroll without breaking layout.',
    '- Content structure: write for reporting, not chat replay. Start each section with a conclusion sentence, then provide technical detail, commands, tradeoffs, and verification steps. Use numbered sections, clear anchors, and a table of contents for anything longer than a short note.',
    '- Share footer: rely on MagClaw to add creator and creation time. Do not duplicate credentials, local machine paths, hidden reasoning, raw tool output, or private configuration in the shared artifact.',
    '',
    '## Rules',
    '',
    '- Do not upload local secrets or raw tool output.',
    '- Before sharing, remove tokens, private URLs, personal paths, hidden reasoning, and sensitive customer data from the artifact.',
    '- Prefer concise synthesis first, then pull original context only when needed.',
    '- If search returns low confidence or too few results, ask a narrower question or date range.',
    '',
  ].join('\n');
}

function skillRootForTarget(runtime, env = process.env) {
  const home = homeDirForEnv(env);
  if (runtime === 'claude_code') return path.resolve(env.CLAUDE_HOME || path.join(home, '.claude'));
  return path.resolve(env.CODEX_HOME || path.join(home, '.codex'));
}

async function writeTeamSharingSkill(rootDir) {
  const skillDir = path.join(rootDir, 'skills', 'magclaw-team-sharing');
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
    const skillPath = path.join(skillRootForTarget(runtime, env), 'skills', 'magclaw-team-sharing', 'SKILL.md');
    if (existsSync(skillPath)) installed.push({ target: runtime, path: skillPath });
  }
  return { ok: true, installed };
}

export async function removeTeamSharingSkill(flags = {}, env = process.env) {
  const removed = [];
  for (const runtime of selectedTargets(flags, env)) {
    const skillDir = path.join(skillRootForTarget(runtime, env), 'skills', 'magclaw-team-sharing');
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
    const skillPath = path.join(skillRootForTarget(runtime, env), 'skills', 'magclaw-team-sharing', 'SKILL.md');
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
  const profile = safeProfileName(flags.profile || env.MAGCLAW_TEAM_SHARING_PROFILE || DEFAULT_PROFILE);
  const profileConfig = await readTeamSharingProfileConfig(profile, env);
  if (!flags.noLogin && !profileConfig.config?.token) {
    await loginTeamSharingProfile(flags, env);
  }
  const project = await initTeamSharingProject(flags, env);
  const shim = await installTeamSharingShim(flags, env);
  const hookFlags = shim.path ? { ...flags, teamSharingCommand: shim.path } : flags;
  const hooks = await installTeamSharingHooks(hookFlags, env);
  const skill = await installTeamSharingSkill(flags, env);
  return {
    ok: Boolean(project.ok && shim.ok && hooks.ok && skill.ok),
    project,
    shim,
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
