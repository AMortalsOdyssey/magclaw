import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, chmod, cp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  buildTeamSharingHookCommand,
  buildTeamSharingWindowsHookCommand,
  buildTeamSharingSyncPackageFromTranscript,
  installTeamSharingHookConfig,
  parseTeamSharingTranscript,
} from './team-sharing-hooks.js';
import { buildTeamSharingOnboardingFeedback } from './onboarding-feedback.js';
import {
  buildTeamSharingPrivacyContext,
  redactTeamSharingLocalText,
  sanitizeTeamSharingValue,
} from './team-sharing-privacy.js';

export const TEAM_SHARING_PACKAGE_NAME = '@magclaw/team-sharing';
export const TEAM_SHARING_INTEGRATION = 'team-sharing';
const DEFAULT_PROFILE = 'default';
const DEFAULT_SERVER_URL = 'https://magclaw.multiego.me';
const TEAM_SHARING_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEAM_SHARING_PLUGIN_NAME = 'magclaw-team-sharing';
const TEAM_SHARING_MARKETPLACE_NAME = 'magclaw';
const TEAM_SHARING_CODEX_PLUGIN_SOURCE_ROOT = path.join(TEAM_SHARING_PACKAGE_ROOT, 'codex-plugin');
const TEAM_SHARING_SOURCE_COMMAND = path.join(TEAM_SHARING_PACKAGE_ROOT, 'bin', 'team-sharing.js');
const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;
const TEAM_SHARING_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const TEAM_SHARING_AGENT_SKILL_IDS = Object.freeze([
  'setup',
  'session-reporting',
  'search',
  'read-link',
  'share-artifact',
  'edit-link',
  'manage-links',
  'import-consensus',
  'ask-consensus',
  'edit-consensus',
  'align-consensus',
  'export-consensus',
]);

function now() {
  return new Date().toISOString();
}

function runtimePlatform(env = process.env) {
  return String(env.MAGCLAW_TEAM_SHARING_PLATFORM || process.platform || '').trim().toLowerCase();
}

function homeDirForEnv(env = process.env) {
  if (runtimePlatform(env) === 'win32') return env.USERPROFILE || env.HOME || os.homedir();
  return env.HOME || env.USERPROFILE || os.homedir();
}

export function teamSharingMachineFingerprint(env = process.env) {
  const platform = runtimePlatform(env);
  const arch = String(env.MAGCLAW_TEAM_SHARING_ARCH || os.arch() || '').trim().toLowerCase();
  const hostname = String(env.MAGCLAW_TEAM_SHARING_HOSTNAME || os.hostname() || '').trim().toLowerCase();
  const home = path.normalize(String(homeDirForEnv(env) || '').trim()).replace(/\\/g, '/').toLowerCase();
  const source = JSON.stringify({ version: 1, hostname, platform, arch, home });
  return `mfp_${crypto.createHash('sha256').update(source).digest('hex')}`;
}

function safeProfileName(value = DEFAULT_PROFILE) {
  return String(value || DEFAULT_PROFILE).trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || DEFAULT_PROFILE;
}

function numberFlag(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function byteLength(value = '') {
  return Buffer.byteLength(String(value || ''), 'utf8');
}

function stableHash(value = '') {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeSearchMode(value = '') {
  const clean = String(value || '').trim().toLowerCase();
  if (['exact', 'keyword', 'keywords', 'bm25', 'lexical'].includes(clean)) return 'keyword';
  if (['fuzzy', 'semantic', 'vector', 'dense'].includes(clean)) return 'semantic';
  return 'hybrid';
}

function normalizeSearchScope(value = '') {
  const clean = String(value || '').trim().toLowerCase();
  if (['channel', 'current-channel', 'current_channel', 'local'].includes(clean)) return 'channel';
  if (['server', 'workspace', 'all', 'all-server', 'server-wide', 'server_wide'].includes(clean)) return 'server';
  return 'hybrid';
}

function normalizeSearchSort(value = '') {
  const clean = String(value || '').trim().toLowerCase();
  if (['recent', 'recency', 'latest', 'time', 'updated_at', 'updated-at'].includes(clean)) return 'recent';
  if (['keyword', 'bm25', 'exact'].includes(clean)) return 'keyword';
  if (['semantic', 'vector', 'rerank'].includes(clean)) return 'semantic';
  if (['hot', 'hotness', 'popular', 'feedback'].includes(clean)) return 'hotness';
  return 'relevance';
}

function booleanFlag(value) {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  return /^(1|true|yes|y|on)$/i.test(String(value).trim());
}

function normalizeTimePreference(value = '') {
  const clean = String(value || '').trim().toLowerCase();
  if (['today', '今天'].includes(clean)) return 'today';
  if (['yesterday', '昨天'].includes(clean)) return 'yesterday';
  if (['week', 'this-week', 'thisweek', '本周', '这周'].includes(clean)) return 'this-week';
  if (['last-week', 'lastweek', '上周'].includes(clean)) return 'last-week';
  return '';
}

function normalizeSearchList(value = []) {
  const values = Array.isArray(value) ? value : [value];
  const items = [];
  for (const item of values) {
    if (item === undefined || item === null || item === false || item === true) continue;
    const text = String(item || '').trim();
    if (!text) continue;
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          items.push(...normalizeSearchList(parsed));
          continue;
        }
      } catch {}
    }
    items.push(...text.split(/[\n,，、;；|]+/g).map((part) => part.trim()).filter(Boolean));
  }
  return items;
}

function uniqueSearchList(values = [], limit = 24) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 120) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function inferTimePreferenceFromQuery(query = '') {
  const text = String(query || '').toLowerCase();
  if (/(今天|今日|\btoday\b)/i.test(text)) return 'today';
  if (/(昨天|昨日|\byesterday\b)/i.test(text)) return 'yesterday';
  if (/(这周|本周|\bthis\s*week\b)/i.test(text)) return 'this-week';
  if (/(上周|\blast\s*week\b)/i.test(text)) return 'last-week';
  return '';
}

function splitTopicText(value = '') {
  return String(value || '')
    .replace(/\b(and|or)\b/gi, '、')
    .replace(/(?:以及|或者|还有|和|与|及|跟|、|\/)+/g, '、')
    .split(/[、,，;；]+/g)
    .map((part) => part.replace(/^(关于|围绕|讲的|聊的|讨论|话题|topic)\s*/i, '').trim())
    .filter((part) => part && !/^(昨天|今天|本周|这周|上周|what|who|when|where|why|how)$/i.test(part));
}

function extractQuotedPhrases(query = '') {
  const phrases = [];
  const text = String(query || '');
  const pattern = /["'`“”‘’]([^"'`“”‘’]{2,80})["'`“”‘’]/g;
  for (const match of text.matchAll(pattern)) phrases.push(match[1]);
  return phrases;
}

function extractIntentTopics(query = '') {
  const text = String(query || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const topics = [];
  topics.push(...extractQuotedPhrases(text));
  const topicPatterns = [
    /(?:关于|围绕|讲的|聊的|讨论|提到|看看|看一下)\s*([^。！？!?；;\n]{2,140})/gi,
    /(?:topic|topics|subject|subjects)\s*(?:of|about|:|：)?\s*([^。！？!?；;\n]{2,140})/gi,
  ];
  for (const pattern of topicPatterns) {
    for (const match of text.matchAll(pattern)) {
      topics.push(...splitTopicText(match[1]));
    }
  }
  const enumMatch = text.match(/([A-Z0-9_\-.一-龥]{1,40}(?:[、,，/]\s*[A-Z0-9_\-.一-龥]{1,40}){1,12})/);
  if (enumMatch) topics.push(...splitTopicText(enumMatch[1]));
  return uniqueSearchList(topics, 16);
}

function extractIntentKeywords(query = '') {
  const text = String(query || '');
  const quoted = extractQuotedPhrases(text);
  const technicalTokens = text.match(/[A-Za-z][A-Za-z0-9_.:/-]{2,}|[A-Z][A-Z0-9_-]{1,}/g) || [];
  const codeTokens = text.match(/`([^`]{2,80})`/g)?.map((item) => item.replace(/^`|`$/g, '')) || [];
  return uniqueSearchList([...quoted, ...technicalTokens, ...codeTokens], 24);
}

function buildSearchIntent({ query = '', flags = {}, env = process.env } = {}) {
  const explicitTime = normalizeTimePreference(flags.time || flags.when || flags.period || '');
  const inferredTime = inferTimePreferenceFromQuery(query);
  const timePreference = explicitTime || inferredTime || '';
  const modeBias = normalizeSearchMode(flags.searchMode || flags.mode || flags.retrievalMode || (flags.exact ? 'keyword' : flags.fuzzy ? 'semantic' : 'hybrid'));
  const keywordOnly = booleanFlag(flags.keywordOnly || flags.keywordsOnly || flags.exactOnly);
  const semanticOnly = booleanFlag(flags.semanticOnly || flags.vectorOnly || flags.fuzzyOnly);
  const retrievalMode = keywordOnly ? 'keyword' : semanticOnly ? 'semantic' : 'hybrid';
  const scope = normalizeSearchScope(flags.searchScope || flags.retrievalScope || flags.scope || flags.channelScope || '');
  const topics = uniqueSearchList([
    ...normalizeSearchList(flags.topics),
    ...normalizeSearchList(flags.topic),
    ...extractIntentTopics(query),
  ], 24);
  const keywords = uniqueSearchList([
    ...normalizeSearchList(flags.keywords),
    ...normalizeSearchList(flags.keyword),
    ...normalizeSearchList(flags.exactKeyword),
    ...normalizeSearchList(flags.exactKeywords),
    ...topics,
    ...extractIntentKeywords(query),
  ], 32);
  const semanticQuery = String(flags.semanticQuery || flags.semantic || flags.fuzzyQuery || query || '').replace(/\s+/g, ' ').trim() || query;
  const dateRange = normalizeSearchDateRange({
    ...flags,
    ...(timePreference && !flags.time && !flags.when && !flags.period ? { time: timePreference } : {}),
  }, env);
  return {
    query,
    semanticQuery,
    keywords,
    topics,
    timePreference: timePreference || null,
    dateRange,
    searchMode: retrievalMode,
    modeBias,
    scope,
    useKeyword: retrievalMode !== 'semantic',
    useSemantic: retrievalMode !== 'keyword',
    keywordQuery: uniqueSearchList([
      ...keywords,
      ...topics,
      query,
    ], 40).join('\n'),
  };
}

function explicitMemberFilters(flags = {}) {
  const memberNames = uniqueSearchList([
    ...normalizeSearchList(flags.member),
    ...normalizeSearchList(flags.memberName),
    ...normalizeSearchList(flags.memberNames),
    ...normalizeSearchList(flags.members),
    ...normalizeSearchList(flags.uploader),
    ...normalizeSearchList(flags.uploaders),
  ], 24);
  const memberIds = uniqueSearchList([
    ...normalizeSearchList(flags.memberId),
    ...normalizeSearchList(flags.memberIds),
    ...normalizeSearchList(flags.uploaderId),
    ...normalizeSearchList(flags.uploaderIds),
  ], 24);
  const memberQuery = String(flags.memberQuery || flags.member_query || '').trim();
  return { memberNames, memberIds, memberQuery };
}

function searchTimeZoneOffsetMinutes(flags = {}, env = process.env) {
  return numberFlag(
    flags.timezoneOffsetMinutes
      || flags.timeZoneOffsetMinutes
      || env.MAGCLAW_TEAM_SHARING_TIMEZONE_OFFSET_MINUTES,
    480,
  );
}

function isoFromMs(ms) {
  return new Date(ms).toISOString();
}

function localDayStartUtcMs(nowMs, offsetMinutes = 480) {
  const offsetMs = offsetMinutes * 60 * 1000;
  const shifted = new Date(nowMs + offsetMs);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - offsetMs;
}

function relativeDateRange(period = '', flags = {}, env = process.env) {
  const preference = normalizeTimePreference(period);
  if (!preference) return null;
  const nowMs = new Date(flags.now || env.MAGCLAW_TEAM_SHARING_NOW || Date.now()).getTime();
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const offsetMinutes = searchTimeZoneOffsetMinutes(flags, env);
  const todayStart = localDayStartUtcMs(safeNowMs, offsetMinutes);
  const oneDayMs = 24 * 60 * 60 * 1000;
  if (preference === 'today') return { from: isoFromMs(todayStart), to: isoFromMs(todayStart + oneDayMs) };
  if (preference === 'yesterday') return { from: isoFromMs(todayStart - oneDayMs), to: isoFromMs(todayStart) };
  const shifted = new Date(safeNowMs + offsetMinutes * 60 * 1000);
  const localDay = shifted.getUTCDay() || 7;
  const weekStart = todayStart - ((localDay - 1) * oneDayMs);
  if (preference === 'this-week') return { from: isoFromMs(weekStart), to: isoFromMs(weekStart + 7 * oneDayMs) };
  return { from: isoFromMs(weekStart - 7 * oneDayMs), to: isoFromMs(weekStart) };
}

function parseDateRangeValue(value = '', flags = {}, env = process.env) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  const text = String(value || '').trim();
  if (!text) return null;
  const relative = relativeDateRange(text, flags, env);
  if (relative) return relative;
  if (text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  const separator = text.includes('..') ? '..' : text.includes(',') ? ',' : '';
  if (separator) {
    const [from = '', to = ''] = text.split(separator).map((part) => part.trim());
    return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
  }
  return { from: text };
}

function normalizeSearchDateRange(flags = {}, env = process.env) {
  const explicit = parseDateRangeValue(flags.dateRange, flags, env);
  if (explicit) return explicit;
  const timePreference = flags.time || flags.when || flags.period
    || (flags.today ? 'today' : '')
    || (flags.yesterday ? 'yesterday' : '')
    || (flags.thisWeek || flags.week ? 'this-week' : '')
    || (flags.lastWeek ? 'last-week' : '');
  const relative = relativeDateRange(timePreference, flags, env);
  if (relative) return relative;
  const from = flags.from || flags.since || flags.start || flags.updatedAfter || flags.updated_after || '';
  const to = flags.to || flags.until || flags.end || flags.updatedBefore || flags.updated_before || '';
  return from || to ? { ...(from ? { from: String(from) } : {}), ...(to ? { to: String(to) } : {}) } : null;
}

function normalizeServerUrl(value = '') {
  return String(value || DEFAULT_SERVER_URL).trim().replace(/\/+$/, '') || DEFAULT_SERVER_URL;
}

function normalizeOptionalServerUrl(value = '') {
  const clean = String(value || '').trim();
  return clean ? normalizeServerUrl(clean) : '';
}

function parseMagClawChannelPath(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'mc:' || parsed.hostname !== 'magclaw') return null;
    const parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'server' || parts[2] !== 'channel') return null;
    const workspaceId = String(parts[1] || '').trim();
    const channelId = String(parts[3] || '').trim();
    return workspaceId || channelId ? { workspaceId, channelId } : null;
  } catch {
    return null;
  }
}

function channelPathFromFlags(flags = {}, existing = {}) {
  return String(
    flags.channel
      || flags.channelPath
      || flags.channelId
      || flags._?.[1]
      || existing.channel?.path
      || existing.channel?.id
      || '',
  ).trim();
}

function resolveVerificationUrl(value = '', serverUrl = DEFAULT_SERVER_URL) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    return new URL(raw).toString();
  } catch {
    try {
      return new URL(raw, `${normalizeServerUrl(serverUrl)}/`).toString();
    } catch {
      return raw;
    }
  }
}

function shellQuote(value = '') {
  return `'${String(value || '').replace(/'/g, "'\\''")}'`;
}

function cmdQuote(value = '') {
  return `"${String(value || '').replace(/(["^&|<>])/g, '^$1')}"`;
}

function powershellQuote(value = '') {
  return `'${String(value || '').replace(/'/g, "''")}'`;
}

function teamSharingShimBinDir(flags = {}, env = process.env) {
  const explicit = String(flags.teamSharingBinDir || flags.binDir || env.MAGCLAW_TEAM_SHARING_BIN_DIR || '').trim();
  if (explicit) return path.resolve(explicit);
  const platform = String(flags.platform || env.MAGCLAW_TEAM_SHARING_PLATFORM || process.platform).toLowerCase();
  if (platform === 'win32') {
    const localAppData = String(env.LOCALAPPDATA || '').trim()
      || path.join(homeDirForEnv(env), 'AppData', 'Local');
    return path.join(localAppData, 'MagClaw', 'bin');
  }
  return path.join(homeDirForEnv(env), '.local', 'bin');
}

function normalizeInstallScope(value = '') {
  const clean = String(value || '').trim().toLowerCase();
  if (['global', 'user'].includes(clean)) return 'user';
  if (['project', 'local'].includes(clean)) return 'project';
  return 'auto';
}

function gitCommand(cwd = process.cwd(), args = []) {
  return spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function gitProjectRoot(cwd = process.cwd()) {
  const result = gitCommand(cwd, ['rev-parse', '--show-toplevel']);
  if (result.status !== 0) return '';
  return String(result.stdout || '').trim();
}

function currentProjectDir(flags = {}) {
  const cwd = path.resolve(flags.cwd || process.cwd());
  const gitRoot = gitProjectRoot(cwd);
  if (gitRoot) return path.resolve(gitRoot);
  const markers = [
    path.join(cwd, '.magclaw', 'team-sharing.yaml'),
    path.join(cwd, 'package.json'),
    path.join(cwd, 'AGENTS.md'),
    path.join(cwd, '.codex'),
    path.join(cwd, '.agents'),
    path.join(cwd, '.claude'),
  ];
  return markers.some((marker) => existsSync(marker)) ? cwd : '';
}

async function registeredTeamSharingProjects(env = process.env) {
  const paths = teamSharingPaths({ env });
  const registry = await readYamlFile(paths.projectsConfig, {});
  return Object.entries(registry.projects || {})
    .map(([key, item]) => {
      const projectPath = String(item?.path || '').trim();
      return {
        key,
        path: projectPath ? path.resolve(projectPath) : '',
        channelPath: String(item?.channel_path || '').trim(),
      };
    })
    .filter((item) => item.path && existsSync(item.path));
}

async function promptProjectInstallTarget(flags = {}, env = process.env) {
  if (flags.yes || flags.nonInteractive || env.CI) return null;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  const projects = await registeredTeamSharingProjects(env);
  if (!projects.length) return null;
  const lines = [
    'No current project was detected. Choose a Team Sharing project:',
    ...projects.map((project, index) => `  [${index + 1}] ${project.key} ${project.path}`),
    '  [g] install globally',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question('Project number: ');
    const clean = String(answer || '').trim().toLowerCase();
    if (clean === 'g' || clean === 'global') return null;
    const index = Number(clean) - 1;
    return projects[index]?.path || null;
  } finally {
    rl.close();
  }
}

async function resolveInstallTarget(flags = {}, env = process.env, { prompt = false } = {}) {
  const explicitProject = String(flags.projectDir || flags.projectPath || '').trim();
  const explicitScope = normalizeInstallScope(flags.installScope || flags.scope || env.MAGCLAW_TEAM_SHARING_INSTALL_SCOPE);
  if (explicitScope === 'user') return { scope: 'user', projectDir: '' };
  if (explicitProject) return { scope: 'project', projectDir: path.resolve(explicitProject) };
  const projectDir = currentProjectDir(flags);
  if (projectDir) return { scope: 'project', projectDir };
  if (explicitScope === 'project') throw new Error('No current project detected. Pass --project-dir <path> or run from a project directory.');
  const selectedProject = prompt ? await promptProjectInstallTarget(flags, env) : '';
  if (selectedProject) return { scope: 'project', projectDir: selectedProject };
  return { scope: 'user', projectDir: '' };
}

function gitInfoExcludePath(projectDir = '') {
  if (!projectDir) return '';
  const result = gitCommand(projectDir, ['rev-parse', '--git-dir']);
  if (result.status !== 0) return '';
  const gitDir = String(result.stdout || '').trim();
  if (!gitDir) return '';
  return path.join(path.isAbsolute(gitDir) ? gitDir : path.resolve(projectDir, gitDir), 'info', 'exclude');
}

async function ensureProjectInstallIgnored(projectDir = '', runtimes = []) {
  const excludePath = gitInfoExcludePath(projectDir);
  if (!excludePath) return [];
  const entries = new Set(['.magclaw/']);
  for (const runtime of runtimes.map(normalizeRuntime)) {
    if (runtime === 'claude_code') {
      entries.add('.claude/settings.local.json');
      entries.add('.claude/skills/magclaw-team-sharing-*/');
    } else {
      entries.add('.codex/hooks.json');
    }
  }
  let existing = '';
  try {
    existing = await readFile(excludePath, 'utf8');
  } catch {}
  const missing = [...entries].filter((entry) => !existing.split(/\r?\n/).includes(entry));
  if (!missing.length) return [];
  await mkdir(path.dirname(excludePath), { recursive: true });
  await appendFile(excludePath, `${existing.endsWith('\n') || !existing ? '' : '\n'}${missing.join('\n')}\n`);
  return missing;
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

async function writeJsonFile(file, value, { privateFile = false } = {}) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
  if (privateFile) await chmod(file, 0o600).catch(() => {});
}

function auditCharCount(value = '') {
  return Array.from(String(value || '')).length;
}

function redactAuditText(value = '') {
  return redactTeamSharingLocalText(value, buildTeamSharingPrivacyContext({ env: process.env }));
}

function sanitizeAuditValue(value, key = '') {
  return sanitizeTeamSharingValue(value, key, buildTeamSharingPrivacyContext({ env: process.env }));
}

function compactAuditError(error) {
  if (!error) return null;
  return sanitizeAuditValue({
    name: error.name || 'Error',
    message: error.message || String(error),
    code: error.code || '',
    status: error.status || 0,
    statusText: error.statusText || '',
    timeout: Boolean(error.timeout),
    durationMs: Number(error.durationMs || 0) || 0,
    response: error.responseData || null,
  });
}

function profileProjectMismatch(profileConfig = {}, projectConfig = {}) {
  const profileServerUrl = normalizeOptionalServerUrl(profileConfig?.server_url || profileConfig?.serverUrl || '');
  const projectServerUrl = normalizeOptionalServerUrl(projectConfig?.serverUrl || projectConfig?.server_url || '');
  if (profileServerUrl && projectServerUrl && profileServerUrl !== projectServerUrl) {
    return { reason: 'server_mismatch', profileServerUrl, projectServerUrl };
  }
  const profileWorkspaceId = String(profileConfig?.workspace_id || profileConfig?.workspaceId || '').trim();
  const projectWorkspaceId = String(projectConfig?.workspaceId || projectConfig?.workspace_id || '').trim();
  if (profileWorkspaceId && projectWorkspaceId && profileWorkspaceId !== projectWorkspaceId) {
    return { reason: 'workspace_mismatch', profileWorkspaceId, projectWorkspaceId };
  }
  return null;
}

function loginAuditInfo({ profileName = DEFAULT_PROFILE, profileConfig = {}, projectConfig = {} } = {}) {
  const mismatch = profileProjectMismatch(profileConfig, projectConfig);
  return sanitizeAuditValue({
    profile: safeProfileName(profileName),
    loggedIn: Boolean(profileConfig?.token) && !mismatch,
    issue: mismatch?.reason || '',
    userId: profileConfig?.user_id || '',
    userEmail: profileConfig?.user_email || '',
    workspaceId: profileConfig?.workspace_id || projectConfig?.workspaceId || '',
    serverUrl: profileConfig?.server_url || projectConfig?.serverUrl || '',
    tokenScope: profileConfig?.token_scope || '',
  });
}

function buildUploadAuditContent(body = {}, { includeContent = true } = {}) {
  const safeBody = sanitizeAuditValue(body || {});
  const serialized = JSON.stringify(safeBody || {});
  const events = Array.isArray(body?.events) ? body.events : [];
  const eventText = events.map((event) => event?.text || event?.displayText || '').join('\n');
  return {
    contentHash: stableHash(serialized),
    charCount: auditCharCount(serialized),
    byteCount: byteLength(serialized),
    eventCount: events.length,
    eventTextCharCount: auditCharCount(eventText),
    optionalLocalDigestCharCount: auditCharCount(body?.optionalLocalDigest || ''),
    fromOrdinal: Number(body?.fromOrdinal || 0),
    toOrdinal: Number(body?.toOrdinal || 0),
    ...(includeContent ? { content: safeBody } : {}),
  };
}

async function appendTeamSharingAuditRecord(file, record = {}, flags = {}, env = process.env) {
  if (!boolFlag(flags.audit ?? env.MAGCLAW_TEAM_SHARING_AUDIT, true) || boolFlag(flags.noAudit, false)) return { ok: true, skipped: true };
  const safeRecord = sanitizeAuditValue({
    version: 1,
    recordedAt: now(),
    ...record,
  });
  try {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(safeRecord)}\n`);
    await chmod(file, 0o600).catch(() => {});
    return { ok: true, auditLog: file };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

async function readTeamSharingAuditTail(file, limit = 5) {
  try {
    const text = await readFile(file, 'utf8');
    const records = text
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-Math.max(1, Number(limit) || 5))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return {
      ok: true,
      auditLog: file,
      recordCount: text.split(/\r?\n/).filter(Boolean).length,
      latest: records[records.length - 1] || null,
      records,
    };
  } catch {
    return {
      ok: false,
      auditLog: file,
      recordCount: 0,
      latest: null,
      records: [],
    };
  }
}

let cachedTeamSharingPackageJson = null;

async function readTeamSharingPackageJson() {
  if (cachedTeamSharingPackageJson) return cachedTeamSharingPackageJson;
  cachedTeamSharingPackageJson = await readJsonFile(path.join(TEAM_SHARING_PACKAGE_ROOT, 'package.json'), {});
  return cachedTeamSharingPackageJson;
}

function cleanTemplateVersion(value = '') {
  return String(value || '').trim().replace(/[^a-zA-Z0-9._+-]+/g, '-').replace(/^-+|-+$/g, '') || '0.0.0';
}

function cleanTemplateCommit(value = '') {
  return String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function currentTeamSharingSourceCommit(env = process.env) {
  const explicit = cleanTemplateCommit(env.MAGCLAW_TEAM_SHARING_SOURCE_COMMIT || '');
  if (explicit !== 'unknown') return explicit;
  const result = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    cwd: TEAM_SHARING_PACKAGE_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.status === 0) return cleanTemplateCommit(result.stdout);
  return 'unknown';
}

async function teamSharingTemplateVars(env = process.env, overrides = {}) {
  const packageJson = await readTeamSharingPackageJson();
  const explicitSourceCommit = cleanTemplateCommit(env.MAGCLAW_TEAM_SHARING_SOURCE_COMMIT || '');
  return {
    TEAM_SHARING_VERSION: cleanTemplateVersion(env.MAGCLAW_TEAM_SHARING_VERSION || packageJson.version || ''),
    TEAM_SHARING_SOURCE_COMMIT: explicitSourceCommit !== 'unknown'
      ? explicitSourceCommit
      : cleanTemplateCommit(packageJson.gitHead || currentTeamSharingSourceCommit(env)),
    TEAM_SHARING_SKILL_NAME_PREFIX: '',
    TEAM_SHARING_SURFACE: 'template',
    ...overrides,
  };
}

function renderTeamSharingTemplate(text = '', vars = {}) {
  return String(text || '').replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
  ));
}

async function renderTeamSharingTemplateFile(sourcePath, targetPath, vars = {}) {
  const template = await readFile(sourcePath, 'utf8');
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, renderTeamSharingTemplate(template, vars));
  return targetPath;
}

async function renderTeamSharingTemplateDirectory(sourceDir, targetDir, vars = {}) {
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });
  const written = [];
  async function visit(sourceRoot, targetRoot) {
    const entries = await readdir(sourceRoot, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = path.join(sourceRoot, entry.name);
      const targetPath = path.join(targetRoot, entry.name);
      if (entry.isDirectory()) {
        await mkdir(targetPath, { recursive: true });
        await visit(sourcePath, targetPath);
      } else if (entry.isFile()) {
        written.push(await renderTeamSharingTemplateFile(sourcePath, targetPath, vars));
      }
    }
  }
  await visit(sourceDir, targetDir);
  return written;
}

function jsonStringContent(value = '') {
  const encoded = JSON.stringify(String(value || ''));
  return encoded.slice(1, -1);
}

async function readTeamSharingHookTemplateConfig(runtime, hookOptions = {}, env = process.env) {
  const normalized = normalizeRuntime(runtime);
  const fileName = normalized === 'claude_code'
    ? 'claude-settings.local.json.template'
    : 'codex-hooks.json.template';
  const vars = await teamSharingTemplateVars(env);
  const template = await readFile(path.join(TEAM_SHARING_PACKAGE_ROOT, 'hooks', fileName), 'utf8');
  const withCommands = template.replace(/\{\{TEAM_SHARING_HOOK_COMMAND:([^}]+)\}\}/g, (_match, hookEventName) => jsonStringContent(buildTeamSharingHookCommand({
    ...hookOptions,
      runtime: normalized,
      hookEventName,
    })));
  const config = JSON.parse(renderTeamSharingTemplate(withCommands, vars));
  const platform = String(hookOptions.platform || env.MAGCLAW_TEAM_SHARING_PLATFORM || process.platform).toLowerCase();
  if (normalized === 'codex' && platform === 'win32') {
    for (const [hookEventName, entries] of Object.entries(config.hooks || {})) {
      for (const entry of Array.isArray(entries) ? entries : []) {
        for (const hook of Array.isArray(entry?.hooks) ? entry.hooks : []) {
          if (hook?.type === 'command' && hook.command) {
            hook.commandWindows = buildTeamSharingWindowsHookCommand({
              ...hookOptions,
              runtime: normalized,
              hookEventName,
            });
          }
        }
      }
    }
  }
  return config;
}

function explicitTeamSharingHookCommand(flags = {}, env = process.env) {
  return String(
    flags.teamSharingCommand
      || flags.commandPath
      || env.MAGCLAW_TEAM_SHARING_COMMAND
      || env.MAGCLAW_TEAM_SHARING_HOOK_COMMAND
      || '',
  ).trim();
}

function defaultTeamSharingHookCommand(flags = {}, env = process.env) {
  const explicit = explicitTeamSharingHookCommand(flags, env);
  if (explicit) return explicit;
  return TEAM_SHARING_SOURCE_COMMAND;
}

function teamSharingShimFiles({ npmPath = 'npm', packageSpec = `${TEAM_SHARING_PACKAGE_NAME}@latest` } = {}) {
  const cleanNpmPath = String(npmPath || 'npm').trim() || 'npm';
  const cleanPackageSpec = String(packageSpec || `${TEAM_SHARING_PACKAGE_NAME}@latest`).trim() || `${TEAM_SHARING_PACKAGE_NAME}@latest`;
  const activeBinScript = "try{const fs=require('fs');const data=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));const active=data.active?data.active.bin:'';process.stdout.write(active?active:(data.bin?data.bin:''))}catch(e){}";
  return [
    {
      name: 'team-sharing',
      content: [
        '#!/bin/sh',
        'TEAM_SHARING_HOME="${MAGCLAW_TEAM_SHARING_HOME:-$HOME/.magclaw/team-sharing}"',
        'ACTIVE_JSON="$TEAM_SHARING_HOME/updates/active.json"',
        '# Active packages live under "$TEAM_SHARING_HOME/versions/<version>/".',
        'if [ -f "$ACTIVE_JSON" ]; then',
        `  ACTIVE_BIN="$(node -e ${shellQuote(activeBinScript)} "$ACTIVE_JSON" 2>/dev/null || true)"`,
        '  if [ -n "$ACTIVE_BIN" ] && [ -f "$ACTIVE_BIN" ]; then',
        '    exec node "$ACTIVE_BIN" "$@"',
        '  fi',
        'fi',
        `exec ${shellQuote(cleanNpmPath)} exec --yes --package ${shellQuote(cleanPackageSpec)} -- team-sharing "$@"`,
        '',
      ].join('\n'),
    },
    {
      name: 'team-sharing.cmd',
      content: [
        '@echo off',
        'set "TEAM_SHARING_HOME=%MAGCLAW_TEAM_SHARING_HOME%"',
        'if "%TEAM_SHARING_HOME%"=="" set "TEAM_SHARING_HOME=%USERPROFILE%\\.magclaw\\team-sharing"',
        'set "ACTIVE_JSON=%TEAM_SHARING_HOME%\\updates\\active.json"',
        'set "ACTIVE_BIN="',
        'if exist "%ACTIVE_JSON%" (',
        `  for /f "usebackq delims=" %%i in (\`node -e ${cmdQuote(activeBinScript)} "%ACTIVE_JSON%"\`) do set "ACTIVE_BIN=%%i"`,
        ')',
        'if not "%ACTIVE_BIN%"=="" if exist "%ACTIVE_BIN%" (',
        '  node "%ACTIVE_BIN%" %*',
        '  exit /b %ERRORLEVEL%',
        ')',
        `${cmdQuote(cleanNpmPath)} exec --yes --package ${cmdQuote(cleanPackageSpec)} -- team-sharing %*`,
        '',
      ].join('\r\n'),
    },
    {
      name: 'team-sharing.ps1',
      content: [
        '$ErrorActionPreference = "Stop"',
        '$teamSharingHome = if ($env:MAGCLAW_TEAM_SHARING_HOME) { $env:MAGCLAW_TEAM_SHARING_HOME } else { Join-Path $HOME ".magclaw/team-sharing" }',
        '$activeJson = Join-Path $teamSharingHome "updates/active.json"',
        '$activeBin = ""',
        'if (Test-Path $activeJson) {',
        `  $activeBin = & node -e ${powershellQuote(activeBinScript)} $activeJson`,
        '}',
        'if ($activeBin -and (Test-Path $activeBin)) {',
        '  & node $activeBin @args',
        '  exit $LASTEXITCODE',
        '}',
        `& ${powershellQuote(cleanNpmPath)} exec --yes --package ${powershellQuote(cleanPackageSpec)} -- team-sharing @args`,
        'exit $LASTEXITCODE',
        '',
      ].join('\n'),
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
  const sharedRuntime = await ensureTeamSharingSharedRuntime(flags, env);
  return {
    ok: Boolean(sharedRuntime.ok),
    command: 'team-sharing',
    installed: changed,
    updated: changed,
    binDir,
    path: path.join(binDir, String(flags.platform || env.MAGCLAW_TEAM_SHARING_PLATFORM || process.platform).toLowerCase() === 'win32' ? 'team-sharing.cmd' : 'team-sharing'),
    files: files.map((file) => file.file),
    sharedRuntime,
    reason: changed ? 'installed_or_updated' : 'already_current',
  };
}

async function activeTeamSharingRuntimeStatus(paths, expectedVersion = '', env = process.env, expectedSourceCommit = '') {
  const state = await readJsonFile(paths.updateActive, {});
  const active = state?.active && typeof state.active === 'object' ? state.active : state;
  const version = cleanTemplateVersion(active?.version || '');
  const bin = String(active?.bin || '').trim();
  if (!version || !bin) return { ok: false, reason: 'missing_active_package' };
  if (!existsSync(bin)) return { ok: false, reason: 'active_bin_missing', active };
  const expected = cleanTemplateVersion(expectedVersion || '');
  if (expected && version !== expected && !semverGreater(version, expected)) {
    return { ok: false, reason: 'active_version_older', active };
  }
  const verify = spawnSync(process.execPath, [bin, '-V'], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (verify.status !== 0) {
    return { ok: false, reason: 'active_verify_failed', active, error: String(verify.stderr || verify.stdout || '').trim() };
  }
  const stdoutVersion = cleanTemplateVersion(String(verify.stdout || '').trim());
  if (stdoutVersion && stdoutVersion !== version) {
    return { ok: false, reason: 'active_version_mismatch', active, stdoutVersion };
  }
  const expectedCommit = cleanTemplateCommit(expectedSourceCommit || '');
  if (expectedCommit !== 'unknown' && version === expected) {
    const packageJson = active?.packageRoot
      ? await readJsonFile(path.join(active.packageRoot, 'package.json'), {})
      : {};
    const activeCommit = cleanTemplateCommit(active?.sourceCommit || packageJson.gitHead || '');
    if (activeCommit !== expectedCommit) {
      return { ok: false, reason: 'active_source_commit_mismatch', active, activeCommit, expectedCommit };
    }
  }
  return {
    ok: true,
    reason: version === expected ? 'already_active' : 'newer_active_available',
    active,
  };
}

async function currentTeamSharingPackageVersion(env = process.env) {
  const packageJson = await readTeamSharingPackageJson();
  return cleanTemplateVersion(env.MAGCLAW_TEAM_SHARING_VERSION || packageJson.version || '');
}

function currentPackageAlreadyUnderVersions(paths) {
  const versionsRoot = path.resolve(paths.versionsDir);
  const packageRoot = path.resolve(TEAM_SHARING_PACKAGE_ROOT);
  return packageRoot === versionsRoot || packageRoot.startsWith(`${versionsRoot}${path.sep}`);
}

async function activateCurrentTeamSharingPackage(flags = {}, env = process.env) {
  const paths = teamSharingPaths({ env });
  const version = await currentTeamSharingPackageVersion(env);
  const sourceCommit = currentTeamSharingSourceCommit(env);
  const existing = await activeTeamSharingRuntimeStatus(paths, version, env, sourceCommit);
  if (existing.ok) return { ok: true, activated: false, reason: existing.reason, active: existing.active, activePath: paths.updateActive };
  const stage = currentPackageAlreadyUnderVersions(paths)
    ? {
      version,
      versionDir: path.dirname(TEAM_SHARING_PACKAGE_ROOT),
      packageRoot: TEAM_SHARING_PACKAGE_ROOT,
      bin: TEAM_SHARING_SOURCE_COMMAND,
      source: 'currentPackage',
      sourceCommit,
    }
    : await stageTeamSharingPackage({
      ...flags,
      latestVersion: version,
      sourceDir: TEAM_SHARING_PACKAGE_ROOT,
      sourceCommit,
    }, env);
  const verify = verifyStagedTeamSharingPackage(stage, env);
  const state = await activateTeamSharingPackage(stage, verify, {
    releaseNotesMarkdown: flags.releaseNotesMarkdown || '',
    sourceCommit,
  }, env);
  return {
    ok: true,
    activated: true,
    reason: existing.reason || 'bootstrapped_current_package',
    active: state.active,
    activePath: paths.updateActive,
  };
}

async function ensureTeamSharingSharedRuntime(flags = {}, env = process.env) {
  if (env.MAGCLAW_TEAM_SHARING_BOOTSTRAP_ACTIVE === '0' || flags.bootstrapActive === false || flags.noBootstrapActive) {
    return { ok: true, skipped: true, reason: 'disabled' };
  }
  try {
    return await activateCurrentTeamSharingPackage(flags, env);
  } catch (error) {
    return {
      ok: false,
      reason: 'bootstrap_active_failed',
      error: error?.message || String(error),
    };
  }
}

export function teamSharingPaths({ profile = DEFAULT_PROFILE, cwd = process.cwd(), env = process.env } = {}) {
  const home = homeDirForEnv(env);
  const sharingHome = path.resolve(env.MAGCLAW_TEAM_SHARING_HOME || path.join(home, '.magclaw', 'team-sharing'));
  const projectDir = path.resolve(cwd || process.cwd());
  const cleanProfile = safeProfileName(profile || env.MAGCLAW_TEAM_SHARING_PROFILE || DEFAULT_PROFILE);
  const updatesDir = path.join(sharingHome, 'updates');
  return {
    profile: cleanProfile,
    sharingHome,
    profileConfig: path.join(sharingHome, 'profiles', cleanProfile, 'config.yaml'),
    sessionOverrides: path.join(sharingHome, 'session-overrides.json'),
    projectsConfig: path.join(sharingHome, 'projects.yaml'),
    versionCache: path.join(sharingHome, 'version-cache.json'),
    updatesDir,
    updateState: path.join(updatesDir, 'state.json'),
    updateActive: path.join(updatesDir, 'active.json'),
    updateNotifications: path.join(updatesDir, 'notifications.json'),
    updateLock: path.join(updatesDir, 'lock'),
    versionsDir: path.join(sharingHome, 'versions'),
    projectConfig: path.join(projectDir, '.magclaw', 'team-sharing.yaml'),
    projectCursor: path.join(projectDir, '.magclaw', 'team-sharing-cursor.json'),
    projectAuditLog: path.join(projectDir, '.magclaw', 'team-sharing-audit.jsonl'),
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
  const projectPath = path.dirname(path.dirname(paths.projectConfig));
  const readableKey = String(config.project_key || config.projectKey || path.basename(projectPath))
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'default';
  const key = `${readableKey}-${stableHash(projectPath)}`;
  for (const [existingKey, existingProject] of Object.entries(registry.projects)) {
    const existingPath = String(existingProject?.path || '').trim();
    if (existingPath && path.resolve(existingPath) === projectPath && existingKey !== key) {
      delete registry.projects[existingKey];
    }
  }
  registry.projects[key] = {
    path: projectPath,
    project_key: config.project_key || readableKey,
    projectKey: config.project_key || readableKey,
    channel_path: config.channel?.path || '',
    channel_id: config.channel?.id || '',
    profile: config.profile || DEFAULT_PROFILE,
    registry_key: key,
    updated_at: now(),
  };
  await writeYamlFile(paths.projectsConfig, registry, { privateFile: true });
  return key;
}

export async function initTeamSharingProject(flags = {}, env = process.env) {
  const cwd = path.resolve(flags.cwd || process.cwd());
  const profile = safeProfileName(flags.profile || env.MAGCLAW_TEAM_SHARING_PROFILE || DEFAULT_PROFILE);
  const paths = teamSharingPaths({ profile, cwd, env });
  const existing = await readYamlFile(paths.projectConfig, {});
  const channel = channelPathFromFlags(flags, existing);
  if (!channel) throw new Error('Usage: team-sharing init --channel <channelPathOrId>');
  const parsedChannelPath = parseMagClawChannelPath(channel);
  const channelIsPath = /^(https?|feishu|lark|mc):/i.test(channel);
  const projectKey = String(flags.projectKey || flags.project || existing.project_key || path.basename(cwd)).trim();
  const config = {
    version: 1,
    enabled: boolFlag(flags.enabled, existing.enabled !== false),
    profile,
    server_url: normalizeServerUrl(flags.serverUrl || existing.server_url || env.MAGCLAW_PUBLIC_URL || DEFAULT_SERVER_URL),
    workspace_id: String(flags.workspaceId || flags.workspace || parsedChannelPath?.workspaceId || existing.workspace_id || env.MAGCLAW_WORKSPACE_ID || 'local').trim(),
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
  const registryKey = await registerTeamSharingProject(paths, config);
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
    registryKey,
  };
}

export async function listTeamSharingProjects(flags = {}, env = process.env) {
  const paths = teamSharingPaths({ profile: flags.profile || env.MAGCLAW_TEAM_SHARING_PROFILE || DEFAULT_PROFILE, env });
  const registry = await readYamlFile(paths.projectsConfig, { version: 1, projects: {} });
  const projects = registry.projects || {};
  if (!flags.status) return { ok: true, projectsConfig: paths.projectsConfig, projects };
  return {
    ok: true,
    projectsConfig: paths.projectsConfig,
    projects: Object.fromEntries(Object.entries(projects).map(([key, item]) => {
      const projectPath = String(item?.path || '').trim();
      return [key, {
        ...item,
        exists: Boolean(projectPath && existsSync(projectPath)),
        projectConfig: projectPath ? path.join(projectPath, '.magclaw', 'team-sharing.yaml') : '',
        configured: Boolean(projectPath && existsSync(path.join(projectPath, '.magclaw', 'team-sharing.yaml'))),
      }];
    })),
  };
}

export async function statusTeamSharingProject(flags = {}, env = process.env) {
  const profile = safeProfileName(flags.profile || env.MAGCLAW_TEAM_SHARING_PROFILE || DEFAULT_PROFILE);
  const project = await readTeamSharingProjectConfig({ profile, cwd: flags.cwd || process.cwd(), env });
  const profileState = await readTeamSharingProfileConfig(profile, env);
  const audit = await readTeamSharingAuditTail(project.paths.projectAuditLog, Number(flags.auditLimit || 5) || 5);
  const config = normalizeTeamSharingProjectConfig(project.config);
  const authIssue = env.MAGCLAW_TEAM_SHARING_TOKEN ? null : profileTokenIssue(profileState.config || {}, env, config || {});
  const loggedIn = Boolean(profileState.config?.token || env.MAGCLAW_TEAM_SHARING_TOKEN) && !authIssue;
  return {
    ok: Boolean(project.config) && !authIssue,
    projectConfig: project.paths.projectConfig,
    profileConfig: profileState.paths.profileConfig,
    auditLog: project.paths.projectAuditLog,
    configured: Boolean(project.config),
    loggedIn,
    authIssue,
    config: project.config || null,
    audit,
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

function requestTimeoutMs(flags = {}, env = process.env) {
  const explicit = flags.requestTimeoutMs
    || flags.timeoutMs
    || flags.timeout
    || env.MAGCLAW_TEAM_SHARING_REQUEST_TIMEOUT_MS
    || DEFAULT_REQUEST_TIMEOUT_MS;
  return Math.max(1000, Number(explicit) || DEFAULT_REQUEST_TIMEOUT_MS);
}

function tokenExpiryFromFlags(flags = {}, fallbackMs = Date.now() + TEAM_SHARING_TOKEN_TTL_MS) {
  const explicit = flags.tokenExpiresAt || flags.token_expires_at || flags.expiresAt || flags.expires_at || '';
  const parsed = explicit ? new Date(explicit).getTime() : 0;
  return new Date(Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs).toISOString();
}

function profileTokenIssue(profileConfig = {}, env = process.env, projectConfig = {}) {
  const token = String(profileConfig?.token || '').trim();
  if (!token) return { reason: 'login_required' };
  const expiresAt = String(profileConfig?.token_expires_at || profileConfig?.tokenExpiresAt || '').trim();
  if (expiresAt) {
    const expiryMs = new Date(expiresAt).getTime();
    if (!Number.isFinite(expiryMs) || expiryMs <= Date.now()) return { reason: 'login_expired' };
  }
  const storedFingerprint = String(profileConfig?.machine_fingerprint || profileConfig?.machineFingerprint || '').trim();
  if (storedFingerprint && storedFingerprint !== teamSharingMachineFingerprint(env)) return { reason: 'machine_mismatch' };
  return profileProjectMismatch(profileConfig, projectConfig);
}

function normalizedTeamSharingRequestTimeout(timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
  return Math.max(1000, Number(timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS) || DEFAULT_REQUEST_TIMEOUT_MS);
}

async function teamSharingNodeJsonRequest({ serverUrl, token = '', machineFingerprint = '', method = 'GET', pathname = '/', body = null, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const startedAtMs = Date.now();
  const bodyText = body ? JSON.stringify(body) : '';
  const timeout = normalizedTeamSharingRequestTimeout(timeoutMs);
  const fingerprint = String(machineFingerprint || '').trim();
  let endpoint;
  try {
    endpoint = new URL(pathname, `${normalizeServerUrl(serverUrl)}/`);
  } catch (error) {
    return {
      ok: false,
      status: 0,
      statusText: '',
      data: {},
      durationMs: Date.now() - startedAtMs,
      timeout: false,
      error: String(error?.message || error),
      requestBodyCharCount: auditCharCount(bodyText),
      requestBodyByteCount: byteLength(bodyText),
    };
  }

  return new Promise((resolve) => {
    const transport = endpoint.protocol === 'http:' ? http : https;
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve({
        ...payload,
        durationMs: Date.now() - startedAtMs,
        requestBodyCharCount: auditCharCount(bodyText),
        requestBodyByteCount: byteLength(bodyText),
      });
    };
    const request = transport.request({
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      port: endpoint.port || undefined,
      path: `${endpoint.pathname}${endpoint.search || ''}`,
      method,
      headers: {
        accept: 'application/json',
        ...(body ? {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(bodyText, 'utf8'),
        } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(fingerprint ? { 'x-magclaw-machine-fingerprint': fingerprint } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      response.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data = {};
        if (raw.trim()) {
          try {
            data = JSON.parse(raw);
          } catch {
            data = {};
          }
        }
        finish({
          ok: response.statusCode >= 200 && response.statusCode < 300,
          status: response.statusCode || 0,
          statusText: response.statusMessage || '',
          data,
          timeout: false,
        });
      });
    });
    request.setTimeout(timeout, () => {
      const error = new Error(`Team Sharing request timed out after ${timeout}ms.`);
      error.code = 'MAGCLAW_TEAM_SHARING_TIMEOUT';
      request.destroy(error);
    });
    request.on('error', (error) => {
      const timedOut = error?.code === 'MAGCLAW_TEAM_SHARING_TIMEOUT';
      finish({
        ok: false,
        status: 0,
        statusText: timedOut ? 'timeout' : '',
        data: {},
        timeout: timedOut,
        error: timedOut ? `Team Sharing request timed out after ${timeout}ms.` : String(error?.message || error),
      });
    });
    if (body) request.write(bodyText);
    request.end();
  });
}

async function teamSharingRequest({ serverUrl, token = '', machineFingerprint = '', method = 'GET', pathname = '/', body = null, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, transport = 'fetch' } = {}) {
  if (transport === 'node') {
    return teamSharingNodeJsonRequest({ serverUrl, token, machineFingerprint, method, pathname, body, timeoutMs });
  }
  const startedAtMs = Date.now();
  const controller = new AbortController();
  const timeout = normalizedTeamSharingRequestTimeout(timeoutMs);
  const timer = setTimeout(() => controller.abort(), timeout);
  const bodyText = body ? JSON.stringify(body) : '';
  const fingerprint = String(machineFingerprint || '').trim();
  try {
    const response = await fetch(`${normalizeServerUrl(serverUrl)}${pathname}`, {
      method,
      headers: {
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(fingerprint ? { 'x-magclaw-machine-fingerprint': fingerprint } : {}),
      },
      signal: controller.signal,
      ...(body ? { body: bodyText } : {}),
    });
    const data = await response.json().catch(() => ({}));
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      data,
      durationMs: Date.now() - startedAtMs,
      timeout: false,
      requestBodyCharCount: auditCharCount(bodyText),
      requestBodyByteCount: byteLength(bodyText),
    };
  } catch (error) {
    const timedOut = error?.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      statusText: timedOut ? 'timeout' : '',
      data: {},
      durationMs: Date.now() - startedAtMs,
      timeout: timedOut,
      error: timedOut ? `Team Sharing request timed out after ${timeout}ms.` : String(error?.message || error),
      requestBodyCharCount: auditCharCount(bodyText),
      requestBodyByteCount: byteLength(bodyText),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function teamSharingRequestJson({ serverUrl, token = '', machineFingerprint = '', method = 'GET', pathname = '/', body = null, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, transport = 'fetch' } = {}) {
  const request = await teamSharingRequest({ serverUrl, token, machineFingerprint, method, pathname, body, timeoutMs, transport });
  const data = request.data || {};
  if (!request.ok) {
    const error = new Error(data.error || data.message || request.error || `${request.status} ${request.statusText}`);
    error.status = request.status;
    error.statusText = request.statusText;
    error.responseData = data;
    error.durationMs = request.durationMs;
    error.timeout = request.timeout;
    throw error;
  }
  return data;
}

async function teamSharingRequestBytes({ serverUrl, token = '', machineFingerprint = '', pathname = '/', timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS) || DEFAULT_REQUEST_TIMEOUT_MS));
  try {
    const fingerprint = String(machineFingerprint || '').trim();
    const response = await fetch(`${normalizeServerUrl(serverUrl)}${pathname}`, {
      method: 'GET',
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(fingerprint ? { 'x-magclaw-machine-fingerprint': fingerprint } : {}),
      },
      signal: controller.signal,
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!response.ok) {
      const error = new Error(`${response.status} ${response.statusText}`);
      error.status = response.status;
      throw error;
    }
    return {
      ok: true,
      status: response.status,
      contentType: String(response.headers.get('content-type') || '').trim(),
      bytes: buffer.length,
      buffer,
    };
  } finally {
    clearTimeout(timer);
  }
}

function absoluteTeamSharingWebUrl(serverUrl = '', value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  try {
    return new URL(raw, `${normalizeServerUrl(serverUrl)}/`).toString();
  } catch {
    return raw;
  }
}

function enrichTeamSharingContextWebLinks(data = {}, { serverUrl = '', fallbackContextUrl = '' } = {}) {
  if (!data || typeof data !== 'object') return data;
  const enrichItem = (item = {}) => {
    if (!item || typeof item !== 'object') return item;
    const contextUrl = String(item.contextUrl || fallbackContextUrl || '').trim();
    const contextWebUrl = String(item.contextWebUrl || item.contextPageUrl || '').trim()
      || absoluteTeamSharingWebUrl(serverUrl, contextUrl);
    if (!contextWebUrl) return item;
    return {
      ...item,
      ...(contextUrl && !item.contextUrl ? { contextUrl } : {}),
      contextWebUrl,
      contextPageUrl: item.contextPageUrl || contextWebUrl,
    };
  };
  return {
    ...enrichItem(data),
    ...(Array.isArray(data.results) ? { results: data.results.map(enrichItem) } : {}),
  };
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

function maybePrintVerificationUrl(url, flags = {}, env = process.env) {
  if (!url || flags.quiet || flags.noPrintLoginUrl || env.MAGCLAW_TEAM_SHARING_PRINT_LOGIN_URL === '0') return;
  if (env.MAGCLAW_TEAM_SHARING_PRINT_LOGIN_URL !== '1' && !process.stderr?.isTTY) return;
  process.stderr.write(`Open this URL to approve MagClaw Team Sharing login:\n${url}\n`);
}

export async function loginTeamSharingProfile(flags = {}, env = process.env) {
  const profile = safeProfileName(flags.profile || env.MAGCLAW_TEAM_SHARING_PROFILE || DEFAULT_PROFILE);
  const existing = (await readTeamSharingProfileConfig(profile, env)).config || {};
  const existingProject = await readTeamSharingProjectConfig({ profile, cwd: flags.cwd || process.cwd(), env });
  const existingProjectConfig = normalizeTeamSharingProjectConfig(existingProject.config);
  const serverUrl = normalizeServerUrl(flags.serverUrl || existingProjectConfig?.serverUrl || existing.server_url || env.MAGCLAW_PUBLIC_URL || DEFAULT_SERVER_URL);
  let workspaceId = String(flags.workspaceId || flags.workspace || existingProjectConfig?.workspaceId || existing.workspace_id || env.MAGCLAW_WORKSPACE_ID || 'local').trim();
  const machineFingerprint = teamSharingMachineFingerprint(env);
  const manualToken = String(flags.token || flags.apiKey || flags.teamSharingToken || env.MAGCLAW_TEAM_SHARING_TOKEN || '').trim();
  const requestedChannelPath = channelPathFromFlags(flags, existingProject.config || {});
  const loginChannelPath = parseMagClawChannelPath(requestedChannelPath) ? requestedChannelPath : '';
  let token = manualToken;
  let tokenExpiresAt = tokenExpiryFromFlags(flags);
  let user = {};
  let onboardingTarget = null;
  let verificationUrl = '';
  if (!token) {
    const started = await teamSharingRequestJson({
      serverUrl,
      method: 'POST',
      pathname: '/api/team-sharing/auth/start',
      body: {
        workspaceId,
        profile,
        packageName: TEAM_SHARING_PACKAGE_NAME,
        machineFingerprint,
        channelPath: loginChannelPath,
        projectKey: String(flags.projectKey || flags.project || '').trim(),
        client: {
          hostname: String(env.MAGCLAW_TEAM_SHARING_HOSTNAME || os.hostname() || '').trim(),
          platform: runtimePlatform(env),
          arch: String(env.MAGCLAW_TEAM_SHARING_ARCH || os.arch() || '').trim(),
        },
      },
    });
    verificationUrl = resolveVerificationUrl(started.verificationUri, serverUrl);
    maybePrintVerificationUrl(verificationUrl, flags, env);
    maybeOpenUrl(verificationUrl, flags, env);
    const intervalMs = Math.max(1, Math.min(10_000, Number(started.intervalMs || 2000) || 2000));
    const deadline = Date.now() + Math.max(1000, Number(flags.pollTimeoutMs || 10 * 60_000) || 10 * 60_000);
    while (Date.now() < deadline) {
      const status = await teamSharingRequestJson({
        serverUrl,
        method: 'POST',
        pathname: '/api/team-sharing/auth/token',
        body: { deviceCode: started.deviceCode, machineFingerprint },
      });
      if (status.status === 'approved' && status.token) {
        token = status.token;
        tokenExpiresAt = tokenExpiryFromFlags({
          tokenExpiresAt: status.tokenExpiresAt || status.expiresAt,
        });
        user = status.user || {};
        workspaceId = String(status.workspaceId || workspaceId || '').trim();
        onboardingTarget = status.onboardingTarget || status.target || null;
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
    token_expires_at: tokenExpiresAt,
    machine_fingerprint: machineFingerprint,
    token_scope: 'team_sharing:sync,team_sharing:search,team_sharing:context,team_sharing:feedback,team_sharing:share',
    user_id: user.id || existing.user_id || '',
    user_email: user.email || existing.user_email || '',
    created_at: existing.created_at || now(),
    updated_at: now(),
  };
  const profileConfig = await writeTeamSharingProfileConfig(profile, config, env);
  return { ok: true, profile, serverUrl, workspaceId, hasToken: Boolean(token), tokenExpiresAt, machineFingerprint, profileConfig, user, verificationUrl, onboardingTarget };
}

export async function logoutTeamSharingProfile(flags = {}, env = process.env) {
  const profile = safeProfileName(flags.profile || env.MAGCLAW_TEAM_SHARING_PROFILE || DEFAULT_PROFILE);
  const { paths, config } = await readTeamSharingProfileConfig(profile, env);
  const token = String(config?.token || '').trim();
  const machineFingerprint = String(config?.machine_fingerprint || '').trim() || teamSharingMachineFingerprint(env);
  if (token) {
    await teamSharingRequestJson({
      serverUrl: config.server_url || flags.serverUrl || DEFAULT_SERVER_URL,
      token,
      machineFingerprint,
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
  const machineFingerprint = String(config?.machine_fingerprint || '').trim() || teamSharingMachineFingerprint(env);
  return teamSharingRequestJson({
    serverUrl: flags.serverUrl || config.server_url || DEFAULT_SERVER_URL,
    token,
    machineFingerprint,
    pathname: '/api/team-sharing/auth/whoami',
  });
}

async function readTeamSharingProfile(profile, env = process.env) {
  return readTeamSharingProfileConfig(profile, env);
}

async function resolveTeamSharingClient(flags = {}, env = process.env, options = {}) {
  const profileName = safeProfileName(flags.profile || env.MAGCLAW_TEAM_SHARING_PROFILE || DEFAULT_PROFILE);
  const project = await readTeamSharingProjectConfig({ profile: profileName, cwd: flags.cwd || process.cwd(), env });
  const config = normalizeTeamSharingProjectConfig(project.config);
  if (!config) throw new Error('Run `team-sharing init --channel <channel>` in this project first.');
  const resolvedProfileName = safeProfileName(flags.profile || config.profile || DEFAULT_PROFILE);
  let profile = await readTeamSharingProfile(resolvedProfileName, env);
  const intended = {
    serverUrl: flags.serverUrl || config.serverUrl || profile.config?.server_url || DEFAULT_SERVER_URL,
    workspaceId: flags.workspaceId || flags.workspace || config.workspaceId || profile.config?.workspace_id || 'local',
  };
  let authIssue = env.MAGCLAW_TEAM_SHARING_TOKEN ? null : profileTokenIssue(profile.config || {}, env, intended);
  if (authIssue && options.allowLogin) {
    const login = await loginTeamSharingProfile({
      ...flags,
      profile: resolvedProfileName,
      serverUrl: intended.serverUrl,
      workspaceId: intended.workspaceId,
    }, env);
    profile = await readTeamSharingProfile(login.profile || resolvedProfileName, env);
    authIssue = profileTokenIssue(profile.config || {}, env, intended);
  }
  const token = String(profile.config?.token || env.MAGCLAW_TEAM_SHARING_TOKEN || '').trim();
  const machineFingerprint = String(profile.config?.machine_fingerprint || '').trim() || teamSharingMachineFingerprint(env);
  return {
    project: {
      paths: project.paths,
      config,
    },
    profile,
    serverUrl: intended.serverUrl,
    token,
    machineFingerprint,
    authIssue,
  };
}

function cursorLastOrdinal(cursor = {}, runtime = 'codex', sessionId = '') {
  return Number(cursor?.sessions?.[runtime]?.[sessionId]?.lastOrdinal || 0);
}

function stringFlagValue(value) {
  if (value === undefined || value === null || value === true || value === false) return '';
  return String(value).trim();
}

function parseHookPayload(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  const text = String(value || '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function nestedStringValue(object, paths = []) {
  for (const keys of paths) {
    let current = object;
    for (const key of keys) {
      if (!current || typeof current !== 'object') {
        current = null;
        break;
      }
      current = current[key];
    }
    const value = stringFlagValue(current);
    if (value) return value;
  }
  return '';
}

function sessionTitleFromMetadata(object = {}) {
  return nestedStringValue(object || {}, [
    ['session_title'],
    ['sessionTitle'],
    ['session_name'],
    ['sessionName'],
    ['thread_name'],
    ['threadName'],
    ['conversation_title'],
    ['conversationTitle'],
    ['thread_title'],
    ['threadTitle'],
    ['title'],
    ['name'],
    ['event_payload', 'session_title'],
    ['event_payload', 'sessionTitle'],
    ['event_payload', 'session_name'],
    ['event_payload', 'sessionName'],
    ['event_payload', 'thread_name'],
    ['event_payload', 'threadName'],
    ['event_payload', 'conversation_title'],
    ['event_payload', 'conversationTitle'],
    ['payload', 'session_title'],
    ['payload', 'sessionTitle'],
    ['payload', 'session_name'],
    ['payload', 'sessionName'],
    ['payload', 'thread_name'],
    ['payload', 'threadName'],
    ['payload', 'conversation_title'],
    ['payload', 'conversationTitle'],
    ['payload', 'thread_title'],
    ['payload', 'threadTitle'],
    ['payload', 'title'],
    ['payload', 'name'],
  ]);
}

function codexHomeDir(env = process.env) {
  const explicit = stringFlagValue(env.CODEX_HOME || env.CODEX_CONFIG_HOME);
  return path.resolve(explicit || path.join(homeDirForEnv(env), '.codex'));
}

function normalizedPathValue(value = '') {
  const clean = stringFlagValue(value);
  if (!clean) return '';
  try {
    return path.resolve(clean);
  } catch {
    return clean;
  }
}

function codexSessionIndexRecordMatches(record = {}, { sessionId = '', transcriptPath = '' } = {}) {
  if (!record || typeof record !== 'object') return false;
  const cleanSessionId = stringFlagValue(sessionId);
  const idCandidates = [
    record.id,
    record.session_id,
    record.sessionId,
    record.thread_id,
    record.threadId,
    record.conversation_id,
    record.conversationId,
  ].map(stringFlagValue).filter(Boolean);
  if (cleanSessionId && idCandidates.includes(cleanSessionId)) return true;

  const cleanTranscriptPath = normalizedPathValue(transcriptPath);
  if (!cleanTranscriptPath) return false;
  const pathCandidates = [
    record.transcript_path,
    record.transcriptPath,
    record.session_file,
    record.sessionFile,
    record.path,
    record.file,
  ].map(normalizedPathValue).filter(Boolean);
  return pathCandidates.includes(cleanTranscriptPath);
}

async function resolveCodexSessionTitleFromIndex({ sessionId = '', transcriptPath = '' } = {}, env = process.env) {
  const indexFile = path.join(codexHomeDir(env), 'session_index.jsonl');
  let text = '';
  try {
    text = await readFile(indexFile, 'utf8');
  } catch {
    return '';
  }
  let best = null;
  let ordinal = 0;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    ordinal += 1;
    let record = null;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!codexSessionIndexRecordMatches(record, { sessionId, transcriptPath })) continue;
    const title = sessionTitleFromMetadata(record);
    if (!title) continue;
    const updatedAtMs = Date.parse(record.updated_at || record.updatedAt || '');
    const comparableUpdatedAt = Number.isFinite(updatedAtMs) ? updatedAtMs : 0;
    if (!best || comparableUpdatedAt > best.updatedAtMs || (comparableUpdatedAt === best.updatedAtMs && ordinal > best.ordinal)) {
      best = { title, updatedAtMs: comparableUpdatedAt, ordinal };
    }
  }
  return best?.title || '';
}

async function resolveRuntimeSessionTitle({ runtime = 'codex', sessionId = '', transcriptPath = '' } = {}, env = process.env) {
  if (normalizeRuntime(runtime) === 'codex') {
    return resolveCodexSessionTitleFromIndex({ sessionId, transcriptPath }, env);
  }
  return '';
}

export function resolveTeamSharingTranscriptPath(flags = {}, env = process.env) {
  const runtime = normalizeRuntime(flags.runtime || 'codex');
  const explicit = stringFlagValue(flags.transcript)
    || stringFlagValue(flags.file)
    || stringFlagValue(flags.transcriptPath)
    || stringFlagValue(flags._?.[1]);
  if (explicit) return { path: explicit, source: 'flag' };

  const envPath = runtime === 'claude_code'
    ? stringFlagValue(env.CLAUDE_TRANSCRIPT_PATH || env.CLAUDE_SESSION_FILE)
    : stringFlagValue(env.CODEX_SESSION_FILE || env.CODEX_TRANSCRIPT_PATH);
  if (envPath) return { path: envPath, source: 'env' };

  const hookPayload = parseHookPayload(flags.hookPayload || flags.hookInput || env.MAGCLAW_TEAM_SHARING_HOOK_PAYLOAD);
  const payloadPath = nestedStringValue(hookPayload, [
    ['transcript_path'],
    ['transcriptPath'],
    ['agent_transcript_path'],
    ['agentTranscriptPath'],
    ['event_payload', 'transcript_path'],
    ['event_payload', 'transcriptPath'],
    ['payload', 'transcript_path'],
    ['payload', 'transcriptPath'],
  ]);
  return { path: payloadPath, source: payloadPath ? 'hook_payload' : '', hookPayload };
}

export function resolveTeamSharingSessionTitle(flags = {}, env = process.env, hookPayload = null) {
  const runtime = normalizeRuntime(flags.runtime || 'codex');
  const explicit = stringFlagValue(flags.sessionTitle)
    || stringFlagValue(flags.title)
    || stringFlagValue(env.MAGCLAW_SESSION_TITLE)
    || (runtime === 'claude_code'
      ? stringFlagValue(env.CLAUDE_SESSION_TITLE)
      : stringFlagValue(env.CODEX_SESSION_TITLE));
  if (explicit) return explicit;
  return sessionTitleFromMetadata(hookPayload || {});
}

function sessionIdFromHookPayload(hookPayload = null) {
  return nestedStringValue(hookPayload || {}, [
    ['session_id'],
    ['sessionId'],
    ['event_payload', 'session_id'],
    ['event_payload', 'sessionId'],
    ['payload', 'session_id'],
    ['payload', 'sessionId'],
  ]);
}

function explicitSessionReportingFlag(flags = {}, env = process.env) {
  if (flags.noReport || flags.noReporting || flags.skipReport || flags.skipReporting) return false;
  if (flags.report !== undefined) return boolFlag(flags.report, true);
  if (flags.reporting !== undefined) return boolFlag(flags.reporting, true);
  if (env.MAGCLAW_TEAM_SHARING_REPORT !== undefined) return boolFlag(env.MAGCLAW_TEAM_SHARING_REPORT, true);
  if (env.MAGCLAW_TEAM_SHARING_REPORTING !== undefined) return boolFlag(env.MAGCLAW_TEAM_SHARING_REPORTING, true);
  return null;
}

function sessionReportingIdentity({ runtime = 'codex', sessionId = '', transcript = '', transcriptPath = '', cwd = process.cwd() } = {}) {
  const cleanSessionId = stringFlagValue(sessionId);
  const cleanTranscriptPath = stringFlagValue(transcript || transcriptPath);
  return {
    runtime: normalizeRuntime(runtime),
    sessionIdHash: cleanSessionId ? sha256Hex(cleanSessionId) : '',
    transcriptPathHash: cleanTranscriptPath ? sha256Hex(path.resolve(cleanTranscriptPath)) : '',
    cwdHash: stableHash(path.resolve(cwd || process.cwd())),
  };
}

function sessionReportingIdentityPresent(identity = {}) {
  return Boolean(identity.sessionIdHash || identity.transcriptPathHash);
}

function sessionReportingOverrideMatches(record = {}, identity = {}) {
  if (!record || record.runtime !== identity.runtime) return false;
  if (identity.sessionIdHash && record.sessionIdHash === identity.sessionIdHash) return true;
  if (identity.transcriptPathHash && record.transcriptPathHash === identity.transcriptPathHash) return true;
  return false;
}

function activeSessionReportingOverrides(store = {}) {
  return (Array.isArray(store.overrides) ? store.overrides : [])
    .filter((record) => record && typeof record === 'object')
    .map(({ expiresAt: _expiresAt, ...record }) => record);
}

async function readSessionReportingStore(file) {
  const store = await readJsonFile(file, { version: 1, overrides: [] });
  return {
    version: 1,
    overrides: activeSessionReportingOverrides(store),
  };
}

function compactSessionReportingStatus(record = null, paths = {}) {
  return {
    ok: true,
    profile: paths.profile || DEFAULT_PROFILE,
    sessionOverrides: paths.sessionOverrides || '',
    report: record ? record.report !== false : true,
    matched: Boolean(record),
    reason: record?.reason || '',
    expiresAt: '',
  };
}

function compactSessionIntentText(value = '') {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
    .toLowerCase();
}

function detectTeamSharingSessionReportingIntent(text = '') {
  const clean = compactSessionIntentText(text);
  if (!clean) return null;
  const mentionsSession = /(session|会话|本轮|本次|当前|这个|这次)/i.test(clean);
  const mentionsReporting = /(magclaw|team sharing|上报|同步|report|reporting|upload|sync)/i.test(clean);
  if (!mentionsSession || !mentionsReporting) return null;
  const disable = /(?:不进行|不再|不要|别|停止|暂停|关闭|禁用|不|no|do not|don't|dont|disable|skip|mute|turn off)/i.test(clean)
    && /(上报|同步|report|reporting|upload|sync|magclaw|team sharing)/i.test(clean);
  if (disable) return { report: false, intent: 'disable', reason: 'user_disabled' };
  const enable = /(?:开始|恢复|继续|可以|允许|打开|开启|启用|enable|resume|start|turn on|allow|report on)/i.test(clean)
    && /(上报|同步|report|reporting|upload|sync|magclaw|team sharing)/i.test(clean);
  if (enable) return { report: true, intent: 'enable', reason: 'user_enabled' };
  return null;
}

function latestTeamSharingSessionReportingIntent(events = []) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.role !== 'user') continue;
    const detected = detectTeamSharingSessionReportingIntent(event.text || '');
    if (detected) {
      return {
        ...detected,
        ordinal: Number(event.ordinal || 0) || 0,
        eventId: event.eventId || '',
        eventTextHash: stableHash(event.text || ''),
      };
    }
  }
  return null;
}

function lastParsedTeamSharingOrdinal(parsed = {}) {
  const events = Array.isArray(parsed.events) ? parsed.events : [];
  return Math.max(0, ...events.map((event) => Number(event?.ordinal || 0) || 0));
}

export async function getTeamSharingSessionReporting(flags = {}, env = process.env) {
  const profile = safeProfileName(flags.profile || env.MAGCLAW_TEAM_SHARING_PROFILE || DEFAULT_PROFILE);
  const paths = teamSharingPaths({ profile, cwd: flags.cwd || process.cwd(), env });
  const identity = sessionReportingIdentity({
    runtime: flags.runtime || 'codex',
    sessionId: flags.sessionId || flags.session_id || '',
    transcript: flags.transcript || flags.file || flags.transcriptPath || '',
    cwd: flags.cwd || process.cwd(),
  });
  const store = await readSessionReportingStore(paths.sessionOverrides);
  const record = sessionReportingIdentityPresent(identity)
    ? store.overrides.find((item) => sessionReportingOverrideMatches(item, identity))
    : null;
  return compactSessionReportingStatus(record, paths);
}

export async function setTeamSharingSessionReporting(flags = {}, env = process.env) {
  const profile = safeProfileName(flags.profile || env.MAGCLAW_TEAM_SHARING_PROFILE || DEFAULT_PROFILE);
  const paths = teamSharingPaths({ profile, cwd: flags.cwd || process.cwd(), env });
  const identity = sessionReportingIdentity({
    runtime: flags.runtime || 'codex',
    sessionId: flags.sessionId || flags.session_id || '',
    transcript: flags.transcript || flags.file || flags.transcriptPath || '',
    cwd: flags.cwd || process.cwd(),
  });
  if (!sessionReportingIdentityPresent(identity)) {
    throw new Error('Usage: team-sharing session-reporting <off|on|status> --session-id <id> or --transcript <path>');
  }
  const report = boolFlag(flags.report, true);
  const store = await readSessionReportingStore(paths.sessionOverrides);
  const remaining = store.overrides.filter((item) => !sessionReportingOverrideMatches(item, identity));
  let record = null;
  if (!report) {
    const nowIso = now();
    record = {
      runtime: identity.runtime,
      sessionIdHash: identity.sessionIdHash,
      transcriptPathHash: identity.transcriptPathHash,
      cwdHash: identity.cwdHash,
      report: false,
      reason: String(flags.reason || 'user_disabled').replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'user_disabled',
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    remaining.push(record);
  }
  await writeJsonFile(paths.sessionOverrides, {
    version: 1,
    updatedAt: now(),
    overrides: remaining,
  }, { privateFile: true });
  return compactSessionReportingStatus(record, paths);
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
  const auditStartedAtMs = Date.now();
  const auditStartedAt = now();
  const runtime = normalizeRuntime(flags.runtime || 'codex');
  const auditPaths = teamSharingPaths({
    profile: flags.profile || env.MAGCLAW_TEAM_SHARING_PROFILE || DEFAULT_PROFILE,
    cwd: flags.cwd || process.cwd(),
    env,
  });
  let auditFile = auditPaths.projectAuditLog;
  const baseAudit = {
    operation: 'sync',
    startedAt: auditStartedAt,
    cwdHash: stableHash(path.resolve(flags.cwd || process.cwd())),
    trigger: {
      runtime,
      hookEvent: stringFlagValue(flags.hookEvent || flags.hookEventName),
      integration: String(flags.integration || '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, ''),
      dryRun: Boolean(flags.dryRun || flags.dry_run),
    },
  };
  const writeAudit = async (patch = {}) => appendTeamSharingAuditRecord(auditFile, {
    ...baseAudit,
    ...patch,
    completedAt: now(),
    durationMs: Date.now() - auditStartedAtMs,
  }, flags, env);

  const resolvedTranscript = resolveTeamSharingTranscriptPath(flags, env);
  const transcriptPath = resolvedTranscript.path;
  const hookPayload = resolvedTranscript.hookPayload || {};
  const hookEvent = stringFlagValue(flags.hookEvent || flags.hookEventName)
    || nestedStringValue(hookPayload, [
      ['hook_event_name'],
      ['hookEventName'],
      ['event_payload', 'hook_event_name'],
      ['payload', 'hook_event_name'],
    ]);
  const initialSessionId = stringFlagValue(flags.sessionId || flags.session_id) || sessionIdFromHookPayload(hookPayload);
  baseAudit.trigger.hookEvent = hookEvent || baseAudit.trigger.hookEvent;
  baseAudit.transcript = {
    pathSource: resolvedTranscript.source || '',
    pathHash: transcriptPath ? stableHash(path.resolve(transcriptPath)) : '',
  };
  const sessionReportingTarget = {
    profile: flags.profile || env.MAGCLAW_TEAM_SHARING_PROFILE || DEFAULT_PROFILE,
    cwd: flags.cwd || process.cwd(),
    runtime,
    sessionId: initialSessionId,
    transcript: transcriptPath,
  };
  const sessionReportingAudit = (reporting = {}, patch = {}) => ({
    report: reporting.report !== false,
    matched: Boolean(reporting.matched),
    reason: reporting.reason || '',
    expiresAt: reporting.expiresAt || '',
    sessionOverrides: reporting.sessionOverrides || '',
    persisted: reporting.ok !== false,
    ...patch,
  });
  const skipForSessionReporting = async (reporting = {}, patch = {}) => {
    await writeAudit({
      ok: true,
      status: 'skipped',
      phase: 'session_reporting',
      reason: 'session_reporting_disabled',
      sessionReporting: sessionReportingAudit(reporting, patch),
    });
    return {
      ok: true,
      empty: true,
      reason: 'session_reporting_disabled',
      report: false,
      sessionReporting: sessionReportingAudit(reporting, patch),
    };
  };
  const explicitReporting = explicitSessionReportingFlag(flags, env);
  if (explicitReporting === false) {
    let reporting = { ok: false, report: false, reason: 'user_disabled' };
    try {
      reporting = await setTeamSharingSessionReporting({
        ...sessionReportingTarget,
        report: false,
        reason: 'user_disabled',
      }, env);
    } catch (error) {
      reporting = {
        ok: false,
        report: false,
        reason: 'user_disabled',
        error: String(error?.message || error),
      };
    }
    return skipForSessionReporting(reporting, { explicit: true, error: reporting.error || '' });
  }
  if (explicitReporting === true) {
    await setTeamSharingSessionReporting({
      ...sessionReportingTarget,
      report: true,
    }, env).catch(() => {});
  }
  if (!transcriptPath) {
    if (hookEvent) {
      await writeAudit({
        ok: true,
        status: 'skipped',
        phase: 'resolve_transcript',
        reason: 'missing_transcript_path',
      });
      return { ok: true, empty: true, reason: 'missing_transcript_path' };
    }
    throw new Error('Usage: team-sharing sync --transcript <path>');
  }
  let content = '';
  try {
    content = await readFile(path.resolve(transcriptPath), 'utf8');
  } catch (error) {
    if (hookEvent && error?.code === 'ENOENT') {
      await writeAudit({
        ok: true,
        status: 'skipped',
        phase: 'read_transcript',
        reason: 'transcript_file_missing',
      });
      return { ok: true, empty: true, reason: 'transcript_file_missing' };
    }
    throw error;
  }
  baseAudit.transcript.charCount = auditCharCount(content);
  baseAudit.transcript.byteCount = byteLength(content);
  baseAudit.transcript.hash = stableHash(content);
  const explicitSessionTitle = resolveTeamSharingSessionTitle({ ...flags, runtime }, env, hookPayload);
  const parsed = parseTeamSharingTranscript(content, {
    runtime,
    sessionId: flags.sessionId || sessionIdFromHookPayload(hookPayload) || '',
    title: explicitSessionTitle,
    projectDir: flags.cwd || process.cwd(),
  });
  sessionReportingTarget.sessionId = parsed.sessionId;
  const currentSessionTitle = explicitSessionTitle
    || await resolveRuntimeSessionTitle({
      runtime: parsed.runtime,
      sessionId: parsed.sessionId,
      transcriptPath,
    }, env)
    || parsed.title
    || path.basename(transcriptPath);
  baseAudit.session = {
    runtime: parsed.runtime,
    sessionId: parsed.sessionId,
    titleHash: stableHash(currentSessionTitle),
    parsedEventCount: parsed.events.length,
    parsedEventTextCharCount: auditCharCount(parsed.events.map((event) => event.text || '').join('\n')),
  };
  const lastParsedOrdinal = lastParsedTeamSharingOrdinal(parsed);
  const sessionIntent = latestTeamSharingSessionReportingIntent(parsed.events);
  let forcedLastOrdinal = null;
  if (sessionIntent?.report === false) {
    const reporting = await setTeamSharingSessionReporting({
      ...sessionReportingTarget,
      report: false,
      reason: sessionIntent.reason || 'user_disabled',
    }, env);
    if (lastParsedOrdinal > 0) {
      await writeTeamSharingCursor(auditPaths.projectCursor, parsed.runtime, {
        sessionId: parsed.sessionId,
        lastOrdinal: lastParsedOrdinal,
        updatedAt: now(),
      });
    }
    return skipForSessionReporting(reporting, {
      intent: sessionIntent.intent,
      eventOrdinal: sessionIntent.ordinal,
      eventId: sessionIntent.eventId,
    });
  }
  if (sessionIntent?.report === true) {
    await setTeamSharingSessionReporting({
      ...sessionReportingTarget,
      report: true,
    }, env);
    forcedLastOrdinal = Math.max(0, Number(sessionIntent.ordinal || 0) - 1);
  } else if (explicitReporting !== true) {
    const reporting = await getTeamSharingSessionReporting(sessionReportingTarget, env);
    if (reporting.report === false) {
      if (lastParsedOrdinal > 0) {
        await writeTeamSharingCursor(auditPaths.projectCursor, parsed.runtime, {
          sessionId: parsed.sessionId,
          lastOrdinal: lastParsedOrdinal,
          updatedAt: now(),
        });
      }
      return skipForSessionReporting(reporting);
    }
  }
  try {
  const client = await resolveTeamSharingClient(flags, env, { allowLogin: !hookEvent });
  const { project, profile, serverUrl, token, machineFingerprint, authIssue } = client;
  auditFile = project.paths.projectAuditLog || auditFile;
  baseAudit.project = {
    projectKey: project.config.projectKey,
    workspaceId: project.config.workspaceId,
    channelId: project.config.channelId,
    hasChannelPath: Boolean(project.config.channelPath),
    serverUrl: flags.serverUrl || serverUrl || profile.config?.server_url || DEFAULT_SERVER_URL,
  };
  baseAudit.login = loginAuditInfo({
    profileName: flags.profile || project.config.profile || DEFAULT_PROFILE,
    profileConfig: profile.config || {},
    projectConfig: project.config || {},
  });
  if (authIssue) {
    await writeAudit({
      ok: true,
      status: 'skipped',
      phase: 'auth',
      reason: authIssue.reason || 'login_required',
    });
    if (hookEvent) return { ok: true, empty: true, reason: authIssue.reason || 'login_required' };
    const error = new Error(authIssue.reason === 'login_expired'
      ? 'Team Sharing login expired. Run `team-sharing login` again.'
      : 'Run `team-sharing login` first.');
    error.auditRecorded = true;
    throw error;
  }
  if (project.config.enabled === false) {
    await writeAudit({
      ok: true,
      status: 'skipped',
      phase: 'config',
      reason: 'project_disabled',
    });
    if (hookEvent) return { ok: true, empty: true, reason: 'project_disabled' };
    const error = new Error('Team Sharing is disabled for this project.');
    error.auditRecorded = true;
    throw error;
  }
  const runtimeConfig = project.config.runtimes?.[runtime];
  if (hookEvent && runtimeConfig && runtimeConfig.hooksEnabled === false) {
    await writeAudit({
      ok: true,
      status: 'skipped',
      phase: 'config',
      reason: 'runtime_hooks_disabled',
    });
    return { ok: true, empty: true, reason: 'runtime_hooks_disabled' };
  }
  const cursor = await readJsonFile(project.paths.projectCursor, {});
  const cursorOrdinal = Number(flags.full ? 0 : cursorLastOrdinal(cursor, parsed.runtime, parsed.sessionId));
  const lastOrdinal = forcedLastOrdinal !== null
    ? Math.max(0, Number(forcedLastOrdinal || 0))
    : cursorOrdinal;
  const syncPackage = buildTeamSharingSyncPackageFromTranscript(content, {
    runtime: parsed.runtime,
    sessionId: parsed.sessionId,
    title: currentSessionTitle,
    projectKey: project.config.projectKey,
    workspaceId: project.config.workspaceId,
    channelId: project.config.channelId,
    channelPath: project.config.channelPath,
    projectDir: flags.cwd || process.cwd(),
    lastOrdinal,
    minCreatedAt: project.config.enabledSince || '',
    hookEvent,
  });
  if (syncPackage.body) {
    const templateVars = await teamSharingTemplateVars(env);
    const metadata = Object.fromEntries(Object.entries({
      integration: String(flags.integration || '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, ''),
      packageVersion: flags.packageVersion ? cleanTemplateVersion(flags.packageVersion) : templateVars.TEAM_SHARING_VERSION,
      sourceCommit: flags.sourceCommit ? cleanTemplateCommit(flags.sourceCommit) : (
        templateVars.TEAM_SHARING_SOURCE_COMMIT === 'unknown' ? '' : templateVars.TEAM_SHARING_SOURCE_COMMIT
      ),
    }).filter(([, value]) => Boolean(value)));
    if (Object.keys(metadata).length) {
      syncPackage.body.metadata = {
        ...(syncPackage.body.metadata || {}),
        ...metadata,
      };
    }
  }
  const includeAuditContent = boolFlag(flags.auditContent ?? env.MAGCLAW_TEAM_SHARING_AUDIT_CONTENT, false);
  if (syncPackage.empty || !syncPackage.body) {
    const emptyReason = syncPackage.reason || 'no_incremental_events';
    await writeAudit({
      ok: true,
      status: 'skipped',
      phase: 'build_package',
      reason: emptyReason,
      cursor: syncPackage.cursor,
      upload: buildUploadAuditContent(syncPackage.body || {}, { includeContent: false }),
      summary: {
        localPackageBuilt: false,
        cloudAbstractRevision: 0,
        cloudIndexedDocumentCount: 0,
      },
    });
    return { ok: true, empty: true, reason: emptyReason, cursor: syncPackage.cursor };
  }
  const uploadAudit = buildUploadAuditContent(syncPackage.body, { includeContent: includeAuditContent });
  if (flags.dryRun || flags.dry_run) {
    await writeAudit({
      ok: true,
      status: 'dry_run',
      phase: 'upload',
      cursor: syncPackage.cursor,
      upload: uploadAudit,
      summary: {
        localPackageBuilt: true,
        cloudAbstractRevision: 0,
        cloudIndexedDocumentCount: 0,
      },
    });
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
  const request = await teamSharingRequest({
    serverUrl: flags.serverUrl || serverUrl || profile.config?.server_url || DEFAULT_SERVER_URL,
    token,
    machineFingerprint,
    method: 'POST',
    pathname: '/api/team-sharing/sync',
    body: syncPackage.body,
    timeoutMs: requestTimeoutMs(flags, env),
  });
  const result = request.data || {};
  if (!request.ok) {
    const error = new Error(result.error || result.message || request.error || `${request.status} ${request.statusText}`);
    error.status = request.status;
    error.statusText = request.statusText;
    error.responseData = result;
    error.durationMs = request.durationMs;
    error.timeout = request.timeout;
    await writeAudit({
      ok: false,
      status: request.timeout ? 'timeout' : 'error',
      phase: 'upload',
      cursor: syncPackage.cursor,
      upload: uploadAudit,
      request: {
        method: 'POST',
        pathname: '/api/team-sharing/sync',
        statusCode: request.status,
        statusText: request.statusText,
        durationMs: request.durationMs,
        timeout: request.timeout,
        requestBodyCharCount: request.requestBodyCharCount,
        requestBodyByteCount: request.requestBodyByteCount,
      },
      cloud: {
        ok: false,
        statusCode: request.status,
        response: result,
      },
      summary: {
        localPackageBuilt: true,
        cloudAbstractRevision: Number(result?.abstractRevision || 0),
        cloudIndexedDocumentCount: Number(result?.indexedDocumentCount || 0),
      },
      error: compactAuditError(error),
    });
    error.auditRecorded = true;
    throw error;
  }
  if (result?.ok !== false) {
    await writeTeamSharingCursor(project.paths.projectCursor, parsed.runtime, syncPackage.cursor);
  }
  await writeAudit({
    ok: result?.ok !== false,
    status: result?.ok === false ? 'error' : 'uploaded',
    phase: 'upload',
    cursor: syncPackage.cursor,
    upload: uploadAudit,
    request: {
      method: 'POST',
      pathname: '/api/team-sharing/sync',
      statusCode: request.status,
      statusText: request.statusText,
      durationMs: request.durationMs,
      timeout: request.timeout,
      requestBodyCharCount: request.requestBodyCharCount,
      requestBodyByteCount: request.requestBodyByteCount,
    },
    cloud: {
      ok: result?.ok !== false,
      statusCode: request.status,
      duplicate: Boolean(result?.duplicate),
      appendedEventCount: Number(result?.appendedEventCount || 0),
      response: result,
    },
    summary: {
      localPackageBuilt: true,
      cloudAbstractRevision: Number(result?.abstractRevision || 0),
      cloudIndexedDocumentCount: Number(result?.indexedDocumentCount || 0),
      generated: Number(result?.abstractRevision || 0) > 0,
    },
  });
  return {
    ...result,
    cursor: syncPackage.cursor,
  };
  } catch (error) {
    if (!error?.auditRecorded) {
      await writeAudit({
        ok: false,
        status: error?.timeout ? 'timeout' : 'error',
        phase: error?.status || error?.responseData ? 'upload' : 'sync',
        error: compactAuditError(error),
      });
    }
    throw error;
  }
}

export async function searchTeamSharing(flags = {}, env = process.env) {
  const query = String(flags.query || flags._?.slice(1).join(' ') || '').trim();
  const memberFilters = explicitMemberFilters(flags);
  if (!query && !memberFilters.memberNames.length && !memberFilters.memberIds.length && !memberFilters.memberQuery) {
    throw new Error('Usage: team-sharing search --query <text> [--member <name>]');
  }
  const { project, serverUrl, token, machineFingerprint } = await resolveTeamSharingClient(flags, env, { allowLogin: true });
  const intent = buildSearchIntent({ query, flags, env });
  const retrievalMember = memberFilters.memberNames.length || memberFilters.memberIds.length
    ? { names: memberFilters.memberNames, ids: memberFilters.memberIds }
    : undefined;
  const result = await teamSharingRequestJson({
    serverUrl,
    token,
    machineFingerprint,
    method: 'POST',
    pathname: '/api/team-sharing/search',
    body: {
      query,
      semanticQuery: intent.semanticQuery,
      keywordQuery: intent.keywordQuery,
      keywords: intent.keywords,
      topics: intent.topics,
      memberQuery: memberFilters.memberQuery || undefined,
      memberNames: memberFilters.memberNames,
      memberIds: memberFilters.memberIds,
      workspaceId: flags.workspaceId || flags.workspace || project.config.workspaceId || '',
      channelId: flags.channelId || project.config.channelId || '',
      projectKey: flags.projectKey || project.config.projectKey || '',
      dateRange: intent.dateRange,
      timePreference: intent.timePreference,
      scope: intent.scope,
      searchMode: intent.searchMode,
      modeBias: intent.modeBias,
      retrievalIntent: {
        useKeyword: intent.useKeyword,
        useSemantic: intent.useSemantic,
        modeBias: intent.modeBias,
        scope: intent.scope,
        source: 'team-sharing-cli',
        ...(retrievalMember ? { member: retrievalMember } : {}),
      },
      sortBy: normalizeSearchSort(flags.sortBy || flags.sort || flags.orderBy),
      candidateK: flags.candidateK ? numberFlag(flags.candidateK) : undefined,
      minScore: flags.minScore !== undefined ? numberFlag(flags.minScore) : undefined,
      limit: numberFlag(flags.limit, 5),
    },
  });
  return enrichTeamSharingContextWebLinks(result, { serverUrl });
}

export async function readTeamSharingContext(flags = {}, env = process.env) {
  const sessionId = String(flags.sessionId || flags.session || flags._?.[1] || '').trim();
  if (!sessionId) throw new Error('Usage: team-sharing context --session-id <sessionId>');
  const { serverUrl, token, machineFingerprint } = await resolveTeamSharingClient(flags, env, { allowLogin: true });
  const params = new URLSearchParams();
  if (flags.anchorEventId || flags.anchor) params.set('anchorEventId', String(flags.anchorEventId || flags.anchor));
  if (flags.direction) params.set('direction', String(flags.direction));
  params.set('limit', String(flags.limit || 21));
  params.set('order', String(flags.order || 'asc'));
  const suffix = params.toString() ? `?${params.toString()}` : '';
  const result = await teamSharingRequestJson({
    serverUrl,
    token,
    machineFingerprint,
    pathname: `/api/team-sharing/context/${encodeURIComponent(sessionId)}${suffix}`,
  });
  return enrichTeamSharingContextWebLinks(result, {
    serverUrl,
    fallbackContextUrl: `/team-sharing/context/${encodeURIComponent(sessionId)}${suffix}`,
  });
}

function parseTeamSharingReadableLink(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return { ok: false, reason: 'unsupported_link' };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'unsupported_link' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported_link' };
  }
  const scopedContextMatch = url.pathname.match(/^\/s\/([^/]+)\/team-sharing\/context\/([^/]+)\/?$/);
  if (scopedContextMatch) {
    return {
      ok: true,
      type: 'context',
      url,
      serverUrl: url.origin,
      serverSlug: decodeURIComponent(scopedContextMatch[1] || ''),
      sessionId: decodeURIComponent(scopedContextMatch[2] || ''),
    };
  }
  const contextMatch = url.pathname.match(/^\/team-sharing\/context\/([^/]+)\/?$/);
  if (contextMatch) {
    return {
      ok: true,
      type: 'context',
      url,
      serverUrl: url.origin,
      sessionId: decodeURIComponent(contextMatch[1] || ''),
    };
  }
  const knowledgeDocMatch = url.pathname.match(/^\/s\/([^/]+)\/knowledge\/docs\/([^/]+)\/?$/);
  if (knowledgeDocMatch) {
    return {
      ok: true,
      type: 'knowledge_doc',
      url,
      serverUrl: url.origin,
      serverSlug: decodeURIComponent(knowledgeDocMatch[1] || ''),
      docId: decodeURIComponent(knowledgeDocMatch[2] || ''),
    };
  }
  const shareMatch = url.pathname.match(/^\/s\/([^/]+)\/?$/) || url.pathname.match(/^\/share\/([^/]+)\/?$/);
  if (shareMatch) {
    return {
      ok: true,
      type: 'share',
      url,
      serverUrl: url.origin,
      shareId: decodeURIComponent(shareMatch[1] || ''),
    };
  }
  return { ok: false, reason: 'unsupported_link' };
}

function contextLinkApiPath(parsed = {}) {
  const params = new URLSearchParams();
  const inputParams = parsed.url?.searchParams || new URLSearchParams();
  for (const key of ['anchorEventId', 'anchor', 'direction', 'limit', 'order']) {
    const value = inputParams.get(key);
    if (value) params.set(key, value);
  }
  if (!params.has('limit')) params.set('limit', '21');
  if (!params.has('order')) params.set('order', 'asc');
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return `/api/team-sharing/context/${encodeURIComponent(parsed.sessionId)}${suffix}`;
}

async function inspectTeamSharingReadableLink({ serverUrl, token = '', machineFingerprint = '', linkUrl = '', timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  return teamSharingRequest({
    serverUrl,
    token,
    machineFingerprint,
    pathname: `/api/team-sharing/links/inspect?url=${encodeURIComponent(linkUrl)}`,
    timeoutMs,
  });
}

function inspectUnavailableForReadLink(request = {}) {
  if (!request) return true;
  if (request.status === 0) return true;
  if (request.status === 404 && !request.data?.reason && !request.data?.linkType) return true;
  if (request.status === 405) return true;
  return false;
}

function teamSharingReadLinkLoginAction(reason = 'login_required', serverUrl = '') {
  const cleanReason = String(reason || 'login_required').trim();
  const message = cleanReason === 'machine_mismatch'
    ? 'Re-login to MagClaw Team Sharing on this machine.'
    : cleanReason === 'login_expired'
      ? 'Team Sharing CLI login expired; login again.'
      : 'Team Sharing CLI login is required.';
  return {
    type: 'login',
    command: `team-sharing login --server-url ${normalizeServerUrl(serverUrl)}`,
    message,
  };
}

function localReadLinkAccessFailure({ parsed = {}, serverUrl = '', reason = 'login_required', inspection = null } = {}) {
  const inspectData = inspection?.data && typeof inspection.data === 'object' ? inspection.data : {};
  return {
    ok: false,
    kind: inspectData.kind || parsed.type || '',
    linkType: 'magclaw_team_sharing',
    supported: true,
    reason,
    linkUrl: parsed.url?.toString() || '',
    serverUrl,
    target: inspectData.target || (
      parsed.type === 'share'
        ? { shareId: parsed.shareId || '' }
        : parsed.type === 'knowledge_doc'
          ? { docId: parsed.docId || '', serverSlug: parsed.serverSlug || '' }
          : { sessionId: parsed.sessionId || '', serverSlug: parsed.serverSlug || '' }
    ),
    auth: {
      ...(inspectData.auth || {}),
      loggedIn: false,
    },
    access: {
      ok: false,
      reason,
      joinRequired: false,
    },
    action: teamSharingReadLinkLoginAction(reason, serverUrl),
  };
}

function readLinkAccessResultFromInspection(inspection = {}, parsed = {}, serverUrl = '') {
  const data = inspection?.data && typeof inspection.data === 'object' ? inspection.data : {};
  const reason = String(data.reason || data.access?.reason || (inspection?.ok ? 'ok' : 'login_required')).trim();
  return {
    ...data,
    ok: Boolean(data.ok),
    kind: data.kind || parsed.type || '',
    linkType: data.linkType || 'magclaw_team_sharing',
    supported: data.supported !== false,
    reason,
    linkUrl: parsed.url?.toString() || '',
    serverUrl,
    access: data.access || { ok: Boolean(data.ok), reason, joinRequired: reason === 'server_membership_required' },
    action: data.action || (
      reason === 'server_membership_required'
        ? {
            type: 'open_browser_to_join',
            url: parsed.url?.toString() || '',
            message: 'Open this MagClaw link in the browser, sign in, and join the server.',
          }
        : teamSharingReadLinkLoginAction(reason, serverUrl)
    ),
  };
}

export async function readTeamSharingLink(flags = {}, env = process.env) {
  const link = String(flags.url || flags.link || flags.href || flags._?.[1] || '').trim();
  const parsed = parseTeamSharingReadableLink(link);
  if (!parsed.ok) {
    const error = new Error('Unsupported MagClaw Team Sharing link.');
    error.reason = parsed.reason || 'unsupported_link';
    error.status = 400;
    throw error;
  }
  const requestServerUrl = normalizeServerUrl(flags.serverUrl || parsed.serverUrl);
  const { token, machineFingerprint, authIssue } = await resolveTeamSharingClient({
    ...flags,
    serverUrl: requestServerUrl,
  }, env, { allowLogin: false });
  const usableToken = authIssue ? '' : token;
  const inspect = await inspectTeamSharingReadableLink({
    serverUrl: requestServerUrl,
    token: usableToken,
    machineFingerprint: usableToken ? machineFingerprint : '',
    linkUrl: parsed.url.toString(),
    timeoutMs: requestTimeoutMs(flags, env),
  });
  if (authIssue) {
    return localReadLinkAccessFailure({
      parsed,
      serverUrl: requestServerUrl,
      reason: authIssue.reason || 'login_required',
      inspection: inspectUnavailableForReadLink(inspect) ? null : inspect,
    });
  }
  if (!inspectUnavailableForReadLink(inspect)) {
    const inspectionResult = readLinkAccessResultFromInspection(inspect, parsed, requestServerUrl);
    if (!inspect.ok || inspectionResult.access?.ok === false || inspectionResult.ok === false) {
      return inspectionResult;
    }
  }
  if (parsed.type === 'share') {
    const result = await teamSharingRequestJson({
      serverUrl: requestServerUrl,
      token,
      machineFingerprint,
      pathname: `/api/team-sharing/shares/${encodeURIComponent(parsed.shareId)}`,
      timeoutMs: requestTimeoutMs(flags, env),
    });
    const shareResult = {
      ...result,
      kind: result.kind || 'share',
      linkUrl: parsed.url.toString(),
      serverUrl: requestServerUrl,
      ...(!inspectUnavailableForReadLink(inspect) ? {
        inspection: inspect.data,
        access: inspect.data?.access,
        target: inspect.data?.target,
      } : {}),
    };
    if (booleanFlag(flags.includeAssets || flags.include_assets)) {
      shareResult.assetContents = await readTeamSharingAssetContents({
        result: shareResult,
        serverUrl: requestServerUrl,
        token,
        machineFingerprint,
        timeoutMs: requestTimeoutMs(flags, env),
      });
    }
    return shareResult;
  }
  if (parsed.type === 'knowledge_doc') {
    const result = await teamSharingRequestJson({
      serverUrl: requestServerUrl,
      token,
      machineFingerprint,
      pathname: `/api/team-sharing/knowledge/${encodeURIComponent(parsed.serverSlug)}/docs/${encodeURIComponent(parsed.docId)}`,
      timeoutMs: requestTimeoutMs(flags, env),
    });
    return {
      ...result,
      kind: result.kind || 'knowledge_doc',
      linkUrl: parsed.url.toString(),
      serverUrl: requestServerUrl,
      serverSlug: parsed.serverSlug,
      docId: parsed.docId,
      ...(!inspectUnavailableForReadLink(inspect) ? {
        inspection: inspect.data,
        access: inspect.data?.access,
        target: inspect.data?.target,
      } : {}),
    };
  }
  const apiPath = contextLinkApiPath(parsed);
  const result = await teamSharingRequestJson({
    serverUrl: requestServerUrl,
    token,
    machineFingerprint,
    pathname: apiPath,
    timeoutMs: requestTimeoutMs(flags, env),
  });
  return enrichTeamSharingContextWebLinks({
    ...result,
    kind: 'context',
    linkUrl: parsed.url.toString(),
    serverUrl: requestServerUrl,
    ...(parsed.serverSlug ? { serverSlug: parsed.serverSlug } : {}),
    ...(!inspectUnavailableForReadLink(inspect) ? {
      inspection: inspect.data,
      access: inspect.data?.access,
      target: inspect.data?.target,
    } : {}),
  }, {
    serverUrl: requestServerUrl,
    fallbackContextUrl: apiPath.replace('/api/team-sharing/context/', '/team-sharing/context/'),
  });
}

async function readTeamSharingAssetContents({ result = {}, serverUrl = '', token = '', machineFingerprint = '', timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const contents = [];
  for (const asset of Array.isArray(result.assetRefs) ? result.assetRefs : []) {
    const rawUrl = String(asset.url || '').trim();
    if (!rawUrl) continue;
    let pathname = rawUrl;
    try {
      const parsed = new URL(rawUrl);
      pathname = `${parsed.pathname}${parsed.search || ''}`;
    } catch {}
    const bytes = await teamSharingRequestBytes({
      serverUrl,
      token,
      machineFingerprint,
      pathname,
      timeoutMs,
    });
    const contentType = bytes.contentType || asset.mimeType || 'application/octet-stream';
    contents.push({
      id: asset.id,
      filename: asset.filename,
      mimeType: contentType,
      bytes: bytes.bytes,
      checksumSha256: asset.checksumSha256 || '',
      dataUrl: `data:${contentType};base64,${bytes.buffer.toString('base64')}`,
    });
  }
  return contents;
}

export async function editTeamSharingLink(flags = {}, env = process.env) {
  const link = String(flags.url || flags.link || flags.href || flags._?.[1] || '').trim();
  const parsed = parseTeamSharingReadableLink(link);
  if (!parsed.ok || parsed.type !== 'share') {
    const error = new Error('Usage: team-sharing edit-link <share-url> --patch <patch.json>');
    error.reason = parsed.reason || 'unsupported_link';
    error.status = 400;
    throw error;
  }
  const requestServerUrl = normalizeServerUrl(flags.serverUrl || parsed.serverUrl);
  const { token, machineFingerprint } = await resolveTeamSharingClient({
    ...flags,
    serverUrl: requestServerUrl,
  }, env, { allowLogin: true });
  const sections = await teamSharingRequestJson({
    serverUrl: requestServerUrl,
    token,
    machineFingerprint,
    pathname: `/api/team-sharing/shares/${encodeURIComponent(parsed.shareId)}/sections`,
    timeoutMs: requestTimeoutMs(flags, env),
  });
  const patch = readPatchPayload(flags);
  const operations = Array.isArray(patch.operations)
    ? patch.operations
    : Array.isArray(patch)
      ? patch
      : [];
  if (!operations.length) {
    const error = new Error('Patch must include an operations array.');
    error.status = 400;
    throw error;
  }
  const sectionsById = new Map((sections.sections || []).map((section) => [String(section.sectionId || ''), section]));
  const sectionsBySelector = new Map((sections.sections || []).map((section) => [String(section.selector || ''), section]));
  const normalizedOperations = operations.map((operation) => {
    const type = String(operation?.op || operation?.type || '').trim();
    if (type !== 'replace_section') return operation;
    const section = sectionsById.get(String(operation.sectionId || operation.section_id || ''))
      || sectionsBySelector.get(String(operation.selector || ''));
    return {
      ...operation,
      op: type,
      ...(section && !operation.sectionId && !operation.section_id ? { sectionId: section.sectionId } : {}),
      expectedHash: operation.expectedHash || operation.expected_hash || section?.hash || '',
    };
  });
  const payload = {
    ...patch,
    baseVersionId: patch.baseVersionId || patch.base_version_id || sections.versionId,
    operations: normalizedOperations,
  };
  if (booleanFlag(flags.dryRun || flags.dry_run)) {
    return {
      ok: true,
      dryRun: true,
      shareId: parsed.shareId,
      url: parsed.url.toString(),
      versionId: sections.versionId,
      changedSections: normalizedOperations.map((operation) => ({
        type: String(operation?.op || operation?.type || '').trim(),
        sectionId: String(operation?.sectionId || operation?.section_id || '').trim(),
        selector: String(operation?.selector || '').trim(),
        expectedHash: String(operation?.expectedHash || operation?.expected_hash || '').trim(),
      })),
    };
  }
  return teamSharingRequestJson({
    serverUrl: requestServerUrl,
    token,
    machineFingerprint,
    method: 'PATCH',
    pathname: `/api/team-sharing/shares/${encodeURIComponent(parsed.shareId)}`,
    timeoutMs: requestTimeoutMs(flags, env),
    body: payload,
  });
}

export async function listTeamSharingLinks(flags = {}, env = process.env) {
  const { project, serverUrl, token, machineFingerprint } = await resolveTeamSharingClient(flags, env, { allowLogin: true });
  const params = new URLSearchParams();
  const workspaceId = stringFlagValue(
    flags.workspaceId
    || flags.workspace
    || flags.serverId
    || flags.serverSlug
    || flags.server
    || project.config.workspaceId
    || '',
  );
  if (workspaceId) params.set('workspaceId', workspaceId);
  if (booleanFlag(flags.includeRevoked || flags.include_revoked)) params.set('includeRevoked', '1');
  const suffix = params.toString() ? `?${params.toString()}` : '';
  return teamSharingRequestJson({
    serverUrl,
    token,
    machineFingerprint,
    pathname: `/api/team-sharing/shares${suffix}`,
    timeoutMs: requestTimeoutMs(flags, env),
  });
}

export async function deleteTeamSharingLink(flags = {}, env = process.env) {
  const target = String(flags.url || flags.link || flags.href || flags.shareId || flags.share || flags._?.[1] || '').trim();
  if (!target) {
    const error = new Error('Usage: team-sharing delete-link <share-url|share-id>');
    error.status = 400;
    throw error;
  }
  let shareId = '';
  let parsedServerUrl = '';
  if (/^https?:\/\//i.test(target)) {
    const parsed = parseTeamSharingReadableLink(target);
    if (!parsed.ok || parsed.type !== 'share') {
      const error = new Error('Usage: team-sharing delete-link <share-url|share-id>');
      error.reason = parsed.reason || 'unsupported_link';
      error.status = 400;
      throw error;
    }
    shareId = parsed.shareId;
    parsedServerUrl = parsed.serverUrl;
  } else {
    shareId = target;
  }
  const { serverUrl, token, machineFingerprint } = await resolveTeamSharingClient({
    ...flags,
    ...(parsedServerUrl ? { serverUrl: flags.serverUrl || parsedServerUrl } : {}),
  }, env, { allowLogin: true });
  return teamSharingRequestJson({
    serverUrl,
    token,
    machineFingerprint,
    method: 'DELETE',
    pathname: `/api/team-sharing/shares/${encodeURIComponent(shareId)}`,
    timeoutMs: requestTimeoutMs(flags, env),
  });
}

function displayTeamSharingEventText(event = {}) {
  return String(
    event.displayText
    || event.cleanText
    || event.text
    || event.content
    || '',
  ).trim();
}

function formatTeamSharingContextMarkdown(result = {}) {
  const session = result.session || {};
  const title = String(session.title || result.sessionId || 'MagClaw Team Sharing Context').trim();
  const lines = [
    `# ${title}`,
    '',
    `Session: ${session.sessionId || result.sessionId || ''}`,
    result.contextWebUrl ? `Link: ${result.contextWebUrl}` : '',
    '',
    '## Events',
  ].filter((line, index) => line || index === 1 || index === 4);
  for (const event of Array.isArray(result.events) ? result.events : []) {
    const label = String(event.actor?.name || event.role || 'event').trim();
    const time = String(event.createdAt || '').trim();
    lines.push('', `### ${label}${time ? ` · ${time}` : ''}`, '', displayTeamSharingEventText(event));
  }
  return lines.join('\n').trim();
}

function formatTeamSharingShareMarkdown(result = {}) {
  const title = String(result.title || result.shareId || 'MagClaw Shared Page').trim();
  const content = String(result.content || '').trim();
  const meta = [
    result.url ? `Link: ${result.url}` : '',
    result.contentType ? `Type: ${result.contentType}` : '',
    result.createdAt ? `Created: ${result.createdAt}` : '',
  ].filter(Boolean);
  return [
    `# ${title}`,
    '',
    ...meta,
    ...(meta.length ? [''] : []),
    content,
  ].join('\n').trim();
}

function formatTeamSharingKnowledgeMarkdown(result = {}) {
  const doc = result.document || {};
  const title = String(doc.title || result.docId || 'MagClaw Knowledge Document').trim();
  const content = String(doc.sourceMarkdown || doc.markdown || doc.summary || '').trim();
  const meta = [
    result.url ? `Link: ${result.url}` : '',
    doc.currentVersionId ? `Version: ${doc.currentVersionId}` : '',
    doc.updatedAt ? `Updated: ${doc.updatedAt}` : '',
  ].filter(Boolean);
  return [
    `# ${title}`,
    '',
    ...meta,
    ...(meta.length ? [''] : []),
    content,
  ].join('\n').trim();
}

function formatTeamSharingReadLinkAccessMarkdown(result = {}) {
  const reason = String(result.reason || result.access?.reason || 'access_required').trim();
  const target = result.target || {};
  const server = target.server || {};
  const action = result.action || {};
  const lines = [
    '# MagClaw Team Sharing link access required',
    '',
    `Reason: ${reason}`,
    target.title ? `Title: ${target.title}` : '',
    server.name || server.slug || server.id ? `Server: ${server.name || server.slug || server.id}` : '',
    target.shareId ? `Share: ${target.shareId}` : '',
    target.sessionId ? `Session: ${target.sessionId}` : '',
    '',
    action.type ? `Action: ${action.type}` : '',
    action.message ? action.message : '',
    action.command ? `Command: ${action.command}` : '',
    action.url ? `URL: ${action.url}` : '',
  ].filter((line, index) => line || index === 1 || index === 7);
  return lines.join('\n').trim();
}

export function formatTeamSharingReadLinkResult(result = {}, format = 'markdown') {
  const cleanFormat = String(format || 'markdown').trim().toLowerCase();
  if (cleanFormat === 'json') return JSON.stringify(result, null, 2);
  if (result?.ok === false || result?.access?.ok === false) {
    const markdown = formatTeamSharingReadLinkAccessMarkdown(result);
    if (cleanFormat === 'text') {
      return markdown
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 <$2>')
        .trim();
    }
    return markdown;
  }
  const markdown = result.kind === 'context'
    ? formatTeamSharingContextMarkdown(result)
    : result.kind === 'knowledge_doc'
      ? formatTeamSharingKnowledgeMarkdown(result)
    : formatTeamSharingShareMarkdown(result);
  if (cleanFormat === 'text') {
    return markdown
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 <$2>')
      .trim();
  }
  return markdown;
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

function mimeExtension(mimeType = '') {
  const clean = String(mimeType || '').trim().toLowerCase();
  if (clean === 'image/jpeg') return 'jpg';
  if (clean === 'image/png') return 'png';
  if (clean === 'image/gif') return 'gif';
  if (clean === 'image/webp') return 'webp';
  if (clean === 'image/svg+xml') return 'svg';
  if (clean === 'video/mp4') return 'mp4';
  if (clean === 'video/webm') return 'webm';
  if (clean === 'audio/mpeg') return 'mp3';
  if (clean === 'audio/wav') return 'wav';
  return clean.split('/').pop()?.replace(/[^a-z0-9.+-]+/g, '') || 'bin';
}

function shareAssetPathFromUrl(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    return `${url.pathname}${url.search || ''}`;
  } catch {
    return raw;
  }
}

function optimizeAssetsEnabled(flags = {}) {
  const value = flags.optimizeAssets ?? flags.optimize_assets;
  if (value === undefined || value === null || value === true) return true;
  if (value === false) return false;
  return !/^(0|false|no|off|none|inline)$/i.test(String(value).trim());
}

async function resolveOrUploadTeamSharingAsset({
  serverUrl,
  token,
  machineFingerprint,
  workspaceId = '',
  mimeType = '',
  buffer,
  timeoutMs,
} = {}) {
  const sha256 = sha256Hex(buffer);
  const bytes = buffer.length;
  const filename = `team-sharing-${sha256.slice(0, 16)}.${mimeExtension(mimeType)}`;
  const resolve = await teamSharingRequestJson({
    serverUrl,
    token,
    machineFingerprint,
    method: 'POST',
    pathname: '/api/team-sharing/assets/resolve',
    timeoutMs,
    body: { workspaceId, sha256, bytes, mimeType },
  });
  if (resolve?.found && resolve.asset?.url) return { asset: resolve.asset, reused: true };
  const uploaded = await teamSharingRequestJson({
    serverUrl,
    token,
    machineFingerprint,
    method: 'POST',
    pathname: '/api/team-sharing/assets',
    timeoutMs,
    body: {
      workspaceId,
      filename,
      mimeType,
      sha256,
      bytes,
      dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
    },
  });
  return { asset: uploaded.asset, reused: Boolean(uploaded.reused) };
}

async function optimizeShareArtifactAssets({
  content = '',
  contentType = '',
  serverUrl,
  token,
  machineFingerprint,
  workspaceId = '',
  flags = {},
  env = process.env,
} = {}) {
  const text = String(content || '');
  if (!optimizeAssetsEnabled(flags) || !['html', 'svg'].includes(String(contentType || '').trim().toLowerCase())) {
    return { content: text, assetIds: [], assetRefs: [], optimized: false, fallback: false };
  }
  const threshold = Math.max(1024, Number(flags.assetThresholdBytes || env.MAGCLAW_TEAM_SHARING_ASSET_THRESHOLD_BYTES || 64 * 1024) || 64 * 1024);
  const pattern = /\b(src|href)=(["'])data:((?:image|video|audio)\/[a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)\2/gi;
  let output = '';
  let lastIndex = 0;
  let match;
  const assetRefs = [];
  let fallback = false;
  while ((match = pattern.exec(text))) {
    output += text.slice(lastIndex, match.index);
    lastIndex = pattern.lastIndex;
    const [full, attr, quote, mimeType, base64Body] = match;
    let replacement = full;
    const buffer = Buffer.from(String(base64Body || '').replace(/\s+/g, ''), 'base64');
    if (buffer.length >= threshold) {
      try {
        const { asset } = await resolveOrUploadTeamSharingAsset({
          serverUrl,
          token,
          machineFingerprint,
          workspaceId,
          mimeType,
          buffer,
          timeoutMs: requestTimeoutMs(flags, env),
        });
        if (asset?.url) {
          assetRefs.push(asset);
          replacement = `${attr}=${quote}${shareAssetPathFromUrl(asset.url)}${quote}`;
        }
      } catch {
        fallback = true;
      }
    }
    output += replacement;
  }
  output += text.slice(lastIndex);
  return {
    content: output,
    assetIds: Array.from(new Set(assetRefs.map((asset) => String(asset.id || '').trim()).filter(Boolean))),
    assetRefs,
    optimized: assetRefs.length > 0,
    fallback,
  };
}

function readPatchPayload(flags = {}) {
  const raw = flags.patch || flags.patchFile || flags.patchJson || flags._?.[2] || '';
  if (!raw) return {};
  const text = String(raw);
  const filePath = path.resolve(flags.cwd || process.cwd(), text);
  if (existsSync(filePath)) return JSON.parse(readFileSync(filePath, 'utf8'));
  return JSON.parse(text);
}

function teamSharingConsensusServerUrl(flags = {}, fallback = '') {
  const server = stringFlagValue(flags.server);
  if (/^https?:\/\//i.test(server)) return normalizeServerUrl(flags.serverUrl || server);
  return normalizeServerUrl(flags.serverUrl || fallback || DEFAULT_SERVER_URL);
}

function teamSharingConsensusWorkspace(flags = {}, projectConfig = {}) {
  const server = stringFlagValue(flags.server);
  return stringFlagValue(
    flags.workspace
    || flags.workspaceId
    || flags.serverSlug
    || flags.serverId
    || (!/^https?:\/\//i.test(server) ? server : '')
    || projectConfig.workspaceId
    || 'local',
  );
}

async function readMarkdownInput(flags = {}, usage = 'Markdown content is required.') {
  const cwd = path.resolve(flags.cwd || process.cwd());
  const fileArg = stringFlagValue(flags.file || flags.path || flags.markdownFile || flags._?.[1]);
  const inline = flags.markdown ?? flags.content ?? flags.text ?? '';
  if (fileArg) return readFile(path.resolve(cwd, fileArg), 'utf8');
  if (inline !== undefined && inline !== null && String(inline).trim()) return String(inline);
  const error = new Error(usage);
  error.status = 400;
  throw error;
}

async function resolveTeamSharingConsensusClient(flags = {}, env = process.env) {
  const base = await resolveTeamSharingClient({
    ...flags,
    server: undefined,
    workspace: undefined,
    workspaceId: flags.loginWorkspaceId || flags.loginWorkspace || undefined,
    serverSlug: undefined,
    serverId: undefined,
    serverUrl: teamSharingConsensusServerUrl(flags, flags.serverUrl),
  }, env, { allowLogin: true });
  const serverUrl = teamSharingConsensusServerUrl(flags, base.serverUrl);
  const workspace = teamSharingConsensusWorkspace(flags, base.project.config);
  return { ...base, serverUrl, workspace };
}

export async function importKnowledgeConsensus(flags = {}, env = process.env) {
  const { serverUrl, workspace, token, machineFingerprint } = await resolveTeamSharingConsensusClient(flags, env);
  const markdown = await readMarkdownInput(flags, 'Usage: team-sharing import-consensus --server <server> --workspace <workspace> --file <markdown-file>');
  return teamSharingRequestJson({
    serverUrl,
    token,
    machineFingerprint,
    method: 'POST',
    pathname: `/api/team-sharing/knowledge/${encodeURIComponent(workspace)}/import`,
    timeoutMs: requestTimeoutMs(flags, env),
    transport: 'node',
    body: {
      workspaceId: workspace,
      markdown,
      sourceName: flags.sourceName || flags.title || '',
      sourceUrl: flags.sourceUrl || '',
    },
  });
}

export async function askKnowledgeConsensusCommand(flags = {}, env = process.env) {
  const { serverUrl, workspace, token, machineFingerprint } = await resolveTeamSharingConsensusClient(flags, env);
  const query = stringFlagValue(flags.query || flags.question || flags._?.[1]);
  if (!query) {
    const error = new Error('Usage: team-sharing ask-consensus --server <server> --workspace <workspace> --query <question>');
    error.status = 400;
    throw error;
  }
  return teamSharingRequestJson({
    serverUrl,
    token,
    machineFingerprint,
    method: 'POST',
    pathname: `/api/team-sharing/knowledge/${encodeURIComponent(workspace)}/ask`,
    timeoutMs: requestTimeoutMs(flags, env),
    transport: 'node',
    body: { workspaceId: workspace, query },
  });
}

export async function editKnowledgeConsensus(flags = {}, env = process.env) {
  const { serverUrl, workspace, token, machineFingerprint } = await resolveTeamSharingConsensusClient(flags, env);
  const docId = stringFlagValue(flags.doc || flags.docId || flags.document || flags._?.[1]);
  if (!docId) {
    const error = new Error('Usage: team-sharing edit-consensus --server <server> --workspace <workspace> --doc <docId> --file <markdown-file>');
    error.status = 400;
    throw error;
  }
  const markdown = await readMarkdownInput({ ...flags, _: flags._?.slice(1) || [] }, 'Knowledge edit requires Markdown content.');
  return teamSharingRequestJson({
    serverUrl,
    token,
    machineFingerprint,
    method: 'POST',
    pathname: `/api/team-sharing/knowledge/${encodeURIComponent(workspace)}/edit`,
    timeoutMs: requestTimeoutMs(flags, env),
    transport: 'node',
    body: {
      workspaceId: workspace,
      docId,
      markdown,
      summary: flags.summary || flags.title || '',
    },
  });
}

export async function alignKnowledgeConsensus(flags = {}, env = process.env) {
  const { serverUrl, workspace, token, machineFingerprint } = await resolveTeamSharingConsensusClient(flags, env);
  const text = flags.file || flags.path
    ? await readMarkdownInput(flags, 'Knowledge align requires --text or --file.')
    : stringFlagValue(flags.text || flags.query || flags._?.[1]);
  if (!String(text || '').trim()) {
    const error = new Error('Usage: team-sharing align-consensus --server <server> --workspace <workspace> --text <text>');
    error.status = 400;
    throw error;
  }
  return teamSharingRequestJson({
    serverUrl,
    token,
    machineFingerprint,
    method: 'POST',
    pathname: `/api/team-sharing/knowledge/${encodeURIComponent(workspace)}/align`,
    timeoutMs: requestTimeoutMs(flags, env),
    transport: 'node',
    body: { workspaceId: workspace, text },
  });
}

export async function exportKnowledgeConsensus(flags = {}, env = process.env) {
  const { serverUrl, workspace, token, machineFingerprint } = await resolveTeamSharingConsensusClient(flags, env);
  const consensusId = stringFlagValue(flags.consensusId || flags.consensusID || flags.consensus || flags.id || flags._?.[1]);
  const rootDocId = stringFlagValue(flags.rootDocId || flags.docId || flags.doc || flags.document);
  const title = stringFlagValue(flags.title || flags.rootTitle);
  if (!consensusId && !rootDocId && !title) {
    const error = new Error('Usage: team-sharing export-consensus --server <server> --workspace <workspace> --consensus-id <consensusId>');
    error.status = 400;
    throw error;
  }
  const params = new URLSearchParams();
  if (consensusId) params.set('consensusId', consensusId);
  if (rootDocId) params.set('docId', rootDocId);
  if (title) params.set('title', title);
  const exported = await teamSharingRequestJson({
    serverUrl,
    token,
    machineFingerprint,
    method: 'GET',
    pathname: `/api/team-sharing/knowledge/${encodeURIComponent(workspace)}/export?${params.toString()}`,
    timeoutMs: requestTimeoutMs(flags, env),
    transport: 'node',
  });
  const output = stringFlagValue(flags.output || flags.out || flags.o);
  if (output) {
    const cwd = path.resolve(flags.cwd || process.cwd());
    const outputPath = path.resolve(cwd, output);
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, String(exported.markdown || ''), 'utf8');
    return { ...exported, outputPath, markdown: flags.includeMarkdown ? exported.markdown : undefined };
  }
  return exported;
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
  const { project, serverUrl, token, machineFingerprint } = await resolveTeamSharingClient(flags, env, { allowLogin: true });
  const contentType = inferShareArtifactType(flags.type || flags.contentType, filePath);
  const optimized = await optimizeShareArtifactAssets({
    content,
    contentType,
    serverUrl,
    token,
    machineFingerprint,
    workspaceId: flags.workspaceId || project.config.workspaceId || '',
    flags,
    env,
  });
  const shareContent = optimized.content;
  const title = String(flags.title || flags.name || pickShareArtifactTitle(shareContent, contentType, filePath)).trim() || 'MagClaw shared page';
  return teamSharingRequestJson({
    serverUrl,
    token,
    machineFingerprint,
    method: 'POST',
    pathname: '/api/team-sharing/shares',
    body: {
      title,
      description: flags.description || '',
      contentType,
      content: shareContent,
      assetIds: optimized.assetIds,
      workspaceId: flags.workspaceId || project.config.workspaceId || '',
      channelId: flags.channelId || project.config.channelId || '',
      channelPath: flags.channelPath || project.config.channelPath || '',
      projectKey: flags.projectKey || project.config.projectKey || '',
      optimizeAssets: optimizeAssetsEnabled(flags),
      source: {
        kind: 'cli_artifact',
        runtime: flags.runtime || '',
        file: filePath ? path.basename(filePath) : '',
        assetOptimization: {
          optimized: optimized.optimized,
          fallback: optimized.fallback,
          assetCount: optimized.assetRefs.length,
        },
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

function targetConfigPath(runtime, flags = {}, env = process.env, installTarget = null) {
  const home = homeDirForEnv(env);
  if (runtime === 'claude_code') {
    if (flags.claudeConfig) return path.resolve(flags.claudeConfig);
    if (installTarget?.scope === 'project') return path.join(installTarget.projectDir, '.claude', 'settings.local.json');
    return path.join(home, '.claude', 'settings.json');
  }
  if (flags.codexConfig) return path.resolve(flags.codexConfig);
  if (installTarget?.scope === 'project') return path.join(installTarget.projectDir, '.codex', 'hooks.json');
  return flags.codexConfig || path.join(home, '.codex', 'hooks.json');
}

function hookEventsForRuntime(runtime) {
  return normalizeRuntime(runtime) === 'claude_code'
    ? ['Stop', 'SessionEnd', 'PreCompact', 'SessionStart']
    : ['Stop', 'PreCompact', 'SessionStart'];
}

function firstCommandToken(command = '') {
  let text = String(command || '').trim();
  if (text.startsWith('&')) text = text.slice(1).trim();
  if (!text) return '';
  const quote = text[0];
  if (quote === '"' || quote === "'") {
    let token = '';
    for (let index = 1; index < text.length; index += 1) {
      const char = text[index];
      if (char === quote) return token;
      token += char;
    }
    return token;
  }
  return text.split(/\s+/)[0] || '';
}

function commandExistsInPath(commandName = '', env = process.env) {
  const paths = String(env.PATH || '').split(path.delimiter).filter(Boolean);
  const platform = String(env.MAGCLAW_TEAM_SHARING_PLATFORM || process.platform).toLowerCase();
  const extensions = platform === 'win32'
    ? String(env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];
  for (const dir of paths) {
    for (const extension of extensions) {
      const candidate = path.join(dir, platform === 'win32' && path.extname(commandName) ? commandName : `${commandName}${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return '';
}

function hookCommandStatus(command = '', env = process.env) {
  const token = firstCommandToken(command);
  if (!token) return { command: '', executable: false, reason: 'missing_command' };
  const hasPathSeparator = token.includes('/') || token.includes('\\');
  const resolved = hasPathSeparator
    ? path.resolve(token)
    : commandExistsInPath(token, env);
  const executable = Boolean(resolved && existsSync(resolved));
  return {
    command: token,
    executable,
    resolvedPath: executable ? resolved : '',
    reason: executable ? 'ok' : (hasPathSeparator ? 'command_path_missing' : 'command_not_found_in_path'),
  };
}

function hookCommandCandidates(hook = {}) {
  return [
    hook?.command,
    hook?.commandWindows,
    hook?.command_windows,
  ].map((value) => String(value || '').trim()).filter(Boolean);
}

function hookHasTeamSharingIntegration(hook = {}) {
  return hookCommandCandidates(hook).some((command) => command.includes('--integration team-sharing')
    || command.includes("--integration 'team-sharing'")
    || command.includes('--integration "team-sharing"'));
}

function activeHookCommandForPlatform(hook = {}, env = process.env) {
  const platform = String(env.MAGCLAW_TEAM_SHARING_PLATFORM || process.platform).toLowerCase();
  if (platform === 'win32') {
    return String(hook.commandWindows || hook.command_windows || hook.command || '').trim();
  }
  return String(hook.command || '').trim();
}

export async function installTeamSharingHooks(flags = {}, env = process.env) {
  const installTarget = await resolveInstallTarget(flags, env, { prompt: true });
  const cwd = path.resolve(installTarget.projectDir || flags.cwd || process.cwd());
  const targets = selectedTargets(flags, env);
  const explicitHookCommand = explicitTeamSharingHookCommand(flags, env);
  const shim = explicitHookCommand ? null : await installTeamSharingShim(flags, env);
  const hookCommand = explicitHookCommand || shim?.path || defaultTeamSharingHookCommand(flags, env);
  const ignored = installTarget.scope === 'project' ? await ensureProjectInstallIgnored(cwd, targets) : [];
  const output = { ok: true, scope: installTarget.scope, projectDir: installTarget.projectDir || '', ignored, ...(shim ? { shim } : {}) };
  for (const runtime of targets) {
    const key = runtime === 'claude_code' ? 'claude' : 'codex';
    const templateConfig = await readTeamSharingHookTemplateConfig(runtime, {
      projectDir: cwd,
      integration: TEAM_SHARING_INTEGRATION,
      teamSharingCommand: hookCommand,
      platform: flags.platform || env.MAGCLAW_TEAM_SHARING_PLATFORM,
    }, env);
    output[key] = await installTeamSharingHookConfig({
      runtime,
      configPath: targetConfigPath(runtime, flags, env, installTarget),
      projectDir: cwd,
      integration: TEAM_SHARING_INTEGRATION,
      teamSharingCommand: hookCommand,
      templateConfig,
    });
  }
  output.ok = Object.values(output).every((item) => item === true || item?.ok !== false);
  output.feedback = buildTeamSharingOnboardingFeedback({
    operation: 'hooks',
    ok: output.ok,
    hooks: output,
  });
  return output;
}

export async function statusTeamSharingHooks(flags = {}, env = process.env) {
  const installTarget = await resolveInstallTarget(flags, env, { prompt: false });
  const output = { ok: true, scope: installTarget.scope, projectDir: installTarget.projectDir || '' };
  for (const runtime of selectedTargets(flags, env)) {
    const key = runtime === 'claude_code' ? 'claude' : 'codex';
    const configPath = targetConfigPath(runtime, flags, env, installTarget);
    const config = await readJsonFile(configPath, {});
    const installed = [];
    const commandChecks = [];
    for (const eventName of hookEventsForRuntime(runtime)) {
      for (const entry of Array.isArray(config.hooks?.[eventName]) ? config.hooks[eventName] : []) {
        for (const hook of Array.isArray(entry.hooks) ? entry.hooks : []) {
          if (hookHasTeamSharingIntegration(hook)) {
            installed.push(eventName);
            commandChecks.push({
              eventName,
              ...hookCommandStatus(activeHookCommandForPlatform(hook, env), env),
            });
          }
        }
      }
    }
    output[key] = {
      ok: installed.length > 0 && commandChecks.every((check) => check.executable),
      runtime,
      configPath,
      installed,
      commandChecks,
    };
  }
  output.ok = Object.values(output).every((item) => item === true || typeof item !== 'object' || item.ok !== false);
  output.feedback = buildTeamSharingOnboardingFeedback({
    operation: 'hooks',
    ok: output.ok,
    hooks: output,
  });
  return output;
}

export async function removeTeamSharingHooks(flags = {}, env = process.env) {
  const installTarget = await resolveInstallTarget(flags, env, { prompt: false });
  const output = { ok: true, scope: installTarget.scope, projectDir: installTarget.projectDir || '' };
  for (const runtime of selectedTargets(flags, env)) {
    const key = runtime === 'claude_code' ? 'claude' : 'codex';
    const configPath = targetConfigPath(runtime, flags, env, installTarget);
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

function skillRootForTarget(runtime, flags = {}, env = process.env, installTarget = null) {
  const home = homeDirForEnv(env);
  if (runtime === 'claude_code') {
    if (flags.claudeSkillRoot) return path.resolve(flags.claudeSkillRoot);
    if (installTarget?.scope === 'project') return path.join(installTarget.projectDir, '.claude');
    return path.resolve(env.CLAUDE_HOME || path.join(home, '.claude'));
  }
  if (flags.codexSkillRoot) return path.resolve(flags.codexSkillRoot);
  if (installTarget?.scope === 'project') return path.join(installTarget.projectDir, '.agents');
  return path.resolve(env.CODEX_HOME || path.join(home, '.codex'));
}

function teamSharingCodexPluginPaths(flags = {}, env = process.env) {
  const paths = teamSharingPaths({ env });
  const marketplaceRoot = path.resolve(
    flags.codexMarketplaceRoot
      || flags.marketplaceRoot
      || env.MAGCLAW_TEAM_SHARING_CODEX_MARKETPLACE_ROOT
      || path.join(paths.sharingHome, 'codex-marketplace'),
  );
  return {
    marketplaceName: TEAM_SHARING_MARKETPLACE_NAME,
    marketplaceRoot,
    marketplacePath: path.join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'),
    pluginPath: path.join(marketplaceRoot, 'plugins', TEAM_SHARING_PLUGIN_NAME),
  };
}

function codexCommandForTeamSharing(flags = {}, env = process.env) {
  return String(flags.codexCommand || env.MAGCLAW_TEAM_SHARING_CODEX_COMMAND || 'codex').trim() || 'codex';
}

function codexCommandResultOk(result = {}) {
  if (result.ok) return true;
  const text = `${result.stdout || ''}\n${result.stderr || ''}\n${result.error || ''}`;
  return /already|exists|configured|installed/i.test(text);
}

function runCodexPluginCommand(args = [], flags = {}, env = process.env) {
  const command = codexCommandForTeamSharing(flags, env);
  if (flags.skipCodexPluginCommand || flags.skipCodexPluginCommands || env.MAGCLAW_TEAM_SHARING_SKIP_CODEX_PLUGIN_COMMAND === '1') {
    return { ok: true, skipped: true, command, args };
  }
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    ok: result.status === 0,
    command,
    args,
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    ...(result.error ? { error: result.error.message || String(result.error) } : {}),
  };
}

function codexPluginInstalledInList(stdout = '') {
  try {
    const parsed = JSON.parse(stdout);
    return [...(Array.isArray(parsed.installed) ? parsed.installed : []), ...(Array.isArray(parsed.available) ? parsed.available : [])]
      .some((item) => item?.name === TEAM_SHARING_PLUGIN_NAME
        && item?.marketplaceName === TEAM_SHARING_MARKETPLACE_NAME
        && item?.installed !== false);
  } catch {
    return false;
  }
}

async function writeTeamSharingCodexMarketplace(paths = {}, options = {}) {
  const includePlugin = options.includePlugin !== false;
  await mkdir(path.join(paths.marketplaceRoot, 'plugins'), { recursive: true });
  await mkdir(path.dirname(paths.marketplacePath), { recursive: true });
  const marketplace = {
    name: TEAM_SHARING_MARKETPLACE_NAME,
    interface: {
      displayName: 'MagClaw',
    },
    plugins: includePlugin
      ? [
        {
          name: TEAM_SHARING_PLUGIN_NAME,
          source: {
            source: 'local',
            path: `./plugins/${TEAM_SHARING_PLUGIN_NAME}`,
          },
          policy: {
            installation: 'AVAILABLE',
            authentication: 'ON_INSTALL',
          },
          category: 'Developer Tools',
        },
      ]
      : [],
  };
  await writeFile(paths.marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);
  return paths.marketplacePath;
}

function renderedPluginSkillPaths(pluginPath = '') {
  return TEAM_SHARING_AGENT_SKILL_IDS.map((id) => ({
    id,
    name: id,
    path: path.join(pluginPath, 'skills', id, 'SKILL.md'),
  }));
}

function renderedClaudeSkillPaths(rootDir = '') {
  return TEAM_SHARING_AGENT_SKILL_IDS.map((id) => ({
    id,
    name: `${TEAM_SHARING_PLUGIN_NAME}-${id}`,
    path: path.join(rootDir, 'skills', `${TEAM_SHARING_PLUGIN_NAME}-${id}`, 'SKILL.md'),
  }));
}

async function cleanupLegacyCodexTeamSharingSkill(rootDir) {
  const legacyDir = path.join(rootDir, 'skills', TEAM_SHARING_PLUGIN_NAME);
  const legacySkill = path.join(legacyDir, 'SKILL.md');
  if (!existsSync(legacySkill)) return null;
  const text = await readFile(legacySkill, 'utf8').catch(() => '');
  if (!text.includes('package: @magclaw/team-sharing')) {
    return { path: legacyDir, removed: false, reason: 'non_generated_skill_preserved' };
  }
  await rm(legacyDir, { recursive: true, force: true });
  return { path: legacyDir, removed: true, reason: 'legacy_generated_skill_removed' };
}

async function installCodexTeamSharingPlugin(flags = {}, env = process.env, installTarget = null) {
  const paths = teamSharingCodexPluginPaths(flags, env);
  const vars = await teamSharingTemplateVars(env, {
    TEAM_SHARING_SKILL_NAME_PREFIX: '',
    TEAM_SHARING_SURFACE: 'codex-plugin',
  });
  const files = await renderTeamSharingTemplateDirectory(TEAM_SHARING_CODEX_PLUGIN_SOURCE_ROOT, paths.pluginPath, vars);
  const marketplacePath = await writeTeamSharingCodexMarketplace(paths);
  const legacySkill = await cleanupLegacyCodexTeamSharingSkill(skillRootForTarget('codex', flags, env, installTarget));
  const marketplaceAdd = runCodexPluginCommand(['plugin', 'marketplace', 'add', paths.marketplaceRoot], flags, env);
  const pluginAdd = codexCommandResultOk(marketplaceAdd)
    ? runCodexPluginCommand(['plugin', 'add', `${TEAM_SHARING_PLUGIN_NAME}@${TEAM_SHARING_MARKETPLACE_NAME}`], flags, env)
    : { ok: false, skipped: true, reason: 'marketplace_add_failed' };
  const ok = files.length > 0 && codexCommandResultOk(marketplaceAdd) && codexCommandResultOk(pluginAdd);
  return {
    ok,
    target: 'codex',
    runtime: 'codex',
    type: 'codex_plugin',
    pluginName: TEAM_SHARING_PLUGIN_NAME,
    marketplaceName: TEAM_SHARING_MARKETPLACE_NAME,
    marketplaceRoot: paths.marketplaceRoot,
    marketplacePath,
    pluginPath: paths.pluginPath,
    installedSkills: renderedPluginSkillPaths(paths.pluginPath),
    fileCount: files.length,
    legacySkill,
    commands: {
      marketplaceAdd,
      pluginAdd,
    },
  };
}

async function statusCodexTeamSharingPlugin(flags = {}, env = process.env, installTarget = null) {
  const paths = teamSharingCodexPluginPaths(flags, env);
  const installedSkills = renderedPluginSkillPaths(paths.pluginPath);
  const localOk = existsSync(paths.marketplacePath)
    && existsSync(path.join(paths.pluginPath, '.codex-plugin', 'plugin.json'))
    && installedSkills.every((item) => existsSync(item.path));
  const legacySkillPath = path.join(skillRootForTarget('codex', flags, env, installTarget), 'skills', TEAM_SHARING_PLUGIN_NAME, 'SKILL.md');
  const list = runCodexPluginCommand(['plugin', 'list', '--json'], flags, env);
  const installedInCodex = list.ok ? codexPluginInstalledInList(list.stdout) : false;
  return {
    ok: localOk && (list.ok && !list.skipped ? installedInCodex : true),
    target: 'codex',
    runtime: 'codex',
    type: 'codex_plugin',
    pluginName: TEAM_SHARING_PLUGIN_NAME,
    marketplaceName: TEAM_SHARING_MARKETPLACE_NAME,
    marketplaceRoot: paths.marketplaceRoot,
    marketplacePath: paths.marketplacePath,
    pluginPath: paths.pluginPath,
    installedSkills: installedSkills.filter((item) => existsSync(item.path)),
    expectedSkills: TEAM_SHARING_AGENT_SKILL_IDS,
    legacySkillPresent: existsSync(legacySkillPath),
    codexList: list,
    installedInCodex,
  };
}

async function removeCodexTeamSharingPlugin(flags = {}, env = process.env, installTarget = null) {
  const paths = teamSharingCodexPluginPaths(flags, env);
  const pluginRemove = runCodexPluginCommand(['plugin', 'remove', `${TEAM_SHARING_PLUGIN_NAME}@${TEAM_SHARING_MARKETPLACE_NAME}`], flags, env);
  const legacySkill = await cleanupLegacyCodexTeamSharingSkill(skillRootForTarget('codex', flags, env, installTarget));
  const removed = [];
  if (existsSync(paths.pluginPath)) {
    await rm(paths.pluginPath, { recursive: true, force: true });
    removed.push({ target: 'codex', type: 'codex_plugin', path: paths.pluginPath });
  }
  const marketplacePath = await writeTeamSharingCodexMarketplace(paths, { includePlugin: false });
  if (legacySkill?.removed) removed.push({ target: 'codex', type: 'legacy_skill', path: legacySkill.path });
  return {
    ok: codexCommandResultOk(pluginRemove),
    target: 'codex',
    runtime: 'codex',
    type: 'codex_plugin',
    pluginName: TEAM_SHARING_PLUGIN_NAME,
    marketplaceName: TEAM_SHARING_MARKETPLACE_NAME,
    marketplaceRoot: paths.marketplaceRoot,
    marketplacePath,
    pluginPath: paths.pluginPath,
    removed,
    legacySkill,
    command: pluginRemove,
  };
}

async function disableCodexTeamSharingPlugin(flags = {}, env = process.env) {
  const paths = teamSharingCodexPluginPaths(flags, env);
  const pluginRemove = runCodexPluginCommand(['plugin', 'remove', `${TEAM_SHARING_PLUGIN_NAME}@${TEAM_SHARING_MARKETPLACE_NAME}`], flags, env);
  return {
    ok: codexCommandResultOk(pluginRemove),
    target: 'codex',
    runtime: 'codex',
    type: 'codex_plugin',
    pluginName: TEAM_SHARING_PLUGIN_NAME,
    marketplaceName: TEAM_SHARING_MARKETPLACE_NAME,
    marketplaceRoot: paths.marketplaceRoot,
    pluginPath: paths.pluginPath,
    disabled: [{ target: 'codex', type: 'codex_plugin', pluginName: TEAM_SHARING_PLUGIN_NAME }],
    command: pluginRemove,
  };
}

async function installClaudeTeamSharingSkills(rootDir, env = process.env) {
  const vars = await teamSharingTemplateVars(env, {
    TEAM_SHARING_SKILL_NAME_PREFIX: `${TEAM_SHARING_PLUGIN_NAME}-`,
    TEAM_SHARING_SURFACE: 'claude-standalone',
  });
  const installedSkills = [];
  for (const id of TEAM_SHARING_AGENT_SKILL_IDS) {
    const targetDir = path.join(rootDir, 'skills', `${TEAM_SHARING_PLUGIN_NAME}-${id}`);
    await renderTeamSharingTemplateDirectory(path.join(TEAM_SHARING_CODEX_PLUGIN_SOURCE_ROOT, 'skills', id), targetDir, vars);
    installedSkills.push({ id, name: `${TEAM_SHARING_PLUGIN_NAME}-${id}`, path: path.join(targetDir, 'SKILL.md') });
  }
  return installedSkills;
}

export async function installTeamSharingSkill(flags = {}, env = process.env) {
  const installTarget = await resolveInstallTarget(flags, env, { prompt: true });
  const targets = selectedTargets(flags, env);
  const ignored = installTarget.scope === 'project' ? await ensureProjectInstallIgnored(installTarget.projectDir, targets) : [];
  const output = { ok: true, scope: installTarget.scope, projectDir: installTarget.projectDir || '', ignored, installed: [], surfaces: [] };
  for (const runtime of targets) {
    if (runtime === 'codex') {
      const surface = await installCodexTeamSharingPlugin(flags, env, installTarget);
      output.surfaces.push(surface);
      if (surface.ok) output.installed.push({ target: runtime, type: surface.type, path: surface.pluginPath, pluginName: surface.pluginName });
      continue;
    }
    if (runtime === 'claude_code') {
      const root = skillRootForTarget(runtime, flags, env, installTarget);
      const installedSkills = await installClaudeTeamSharingSkills(root, env);
      const surface = {
        ok: installedSkills.length === TEAM_SHARING_AGENT_SKILL_IDS.length,
        target: runtime,
        runtime,
        type: 'standalone_skills',
        root,
        installedSkills,
      };
      output.surfaces.push(surface);
      if (surface.ok) output.installed.push({ target: runtime, type: surface.type, paths: installedSkills.map((item) => item.path) });
    }
  }
  output.ok = output.surfaces.length > 0 && output.surfaces.every((surface) => surface.ok);
  output.feedback = buildTeamSharingOnboardingFeedback({
    operation: 'skills',
    ok: output.ok,
    skill: output,
  });
  return output;
}

export async function statusTeamSharingSkill(flags = {}, env = process.env) {
  const installTarget = await resolveInstallTarget(flags, env, { prompt: false });
  const targets = selectedTargets(flags, env);
  const installed = [];
  const surfaces = [];
  for (const runtime of targets) {
    if (runtime === 'codex') {
      const surface = await statusCodexTeamSharingPlugin(flags, env, installTarget);
      surfaces.push(surface);
      if (surface.ok) installed.push({ target: runtime, type: surface.type, path: surface.pluginPath, pluginName: surface.pluginName });
      continue;
    }
    if (runtime === 'claude_code') {
      const root = skillRootForTarget(runtime, flags, env, installTarget);
      const expected = renderedClaudeSkillPaths(root);
      const installedSkills = expected.filter((item) => existsSync(item.path));
      const surface = {
        ok: installedSkills.length === expected.length,
        target: runtime,
        runtime,
        type: 'standalone_skills',
        root,
        expectedSkills: expected.map((item) => item.name),
        installedSkills,
      };
      surfaces.push(surface);
      if (surface.ok) installed.push({ target: runtime, type: surface.type, paths: installedSkills.map((item) => item.path) });
    }
  }
  const ok = surfaces.length > 0 && surfaces.every((surface) => surface.ok);
  return {
    ok,
    scope: installTarget.scope,
    projectDir: installTarget.projectDir || '',
    expectedTargets: targets,
    installed,
    surfaces,
    feedback: buildTeamSharingOnboardingFeedback({
      operation: 'skills',
      ok,
      skill: { ok, installed, surfaces },
    }),
  };
}

export async function removeTeamSharingSkill(flags = {}, env = process.env) {
  const installTarget = await resolveInstallTarget(flags, env, { prompt: false });
  const removed = [];
  const surfaces = [];
  for (const runtime of selectedTargets(flags, env)) {
    if (runtime === 'codex') {
      const surface = await removeCodexTeamSharingPlugin(flags, env, installTarget);
      surfaces.push(surface);
      removed.push(...surface.removed);
      continue;
    }
    if (runtime === 'claude_code') {
      const root = skillRootForTarget(runtime, flags, env, installTarget);
      const surface = { ok: true, target: runtime, runtime, type: 'standalone_skills', root, removed: [] };
      for (const item of renderedClaudeSkillPaths(root)) {
        const skillDir = path.dirname(item.path);
        if (existsSync(skillDir)) {
          await rm(skillDir, { recursive: true, force: true });
          surface.removed.push({ target: runtime, type: 'standalone_skill', path: skillDir, name: item.name });
        }
      }
      surfaces.push(surface);
      removed.push(...surface.removed);
    }
  }
  return { ok: surfaces.every((surface) => surface.ok), scope: installTarget.scope, projectDir: installTarget.projectDir || '', removed, surfaces };
}

export async function disableTeamSharingSkill(flags = {}, env = process.env) {
  const installTarget = await resolveInstallTarget(flags, env, { prompt: false });
  const disabled = [];
  const surfaces = [];
  for (const runtime of selectedTargets(flags, env)) {
    if (runtime === 'codex') {
      const surface = await disableCodexTeamSharingPlugin(flags, env);
      surfaces.push(surface);
      disabled.push(...surface.disabled);
      continue;
    }
    if (runtime === 'claude_code') {
      const root = skillRootForTarget(runtime, flags, env, installTarget);
      const surface = { ok: true, target: runtime, runtime, type: 'standalone_skills', root, disabled: [] };
      for (const item of renderedClaudeSkillPaths(root)) {
        const disabledPath = `${item.path}.disabled`;
        if (existsSync(item.path)) {
          await rename(item.path, disabledPath);
          surface.disabled.push({ target: runtime, type: 'standalone_skill', path: disabledPath, name: item.name });
        }
      }
      surfaces.push(surface);
      disabled.push(...surface.disabled);
    }
  }
  return { ok: surfaces.every((surface) => surface.ok), scope: installTarget.scope, projectDir: installTarget.projectDir || '', disabled, surfaces };
}

export async function setupTeamSharing(flags = {}, env = process.env) {
  flags = await promptSetupTarget(flags, env);
  const installTarget = await resolveInstallTarget(flags, env, { prompt: true });
  const setupFlags = installTarget.scope === 'project' ? { ...flags, cwd: installTarget.projectDir } : flags;
  const profile = safeProfileName(flags.profile || env.MAGCLAW_TEAM_SHARING_PROFILE || DEFAULT_PROFILE);
  const profileConfig = await readTeamSharingProfileConfig(profile, env);
  const existingProject = await readTeamSharingProjectConfig({ profile, cwd: setupFlags.cwd || process.cwd(), env });
  const existingProjectConfig = normalizeTeamSharingProjectConfig(existingProject.config);
  const requestedChannelPath = channelPathFromFlags(setupFlags, existingProject.config || {});
  const parsedChannelPath = parseMagClawChannelPath(requestedChannelPath);
  const intendedLogin = {
    serverUrl: flags.serverUrl || setupFlags.serverUrl || existingProjectConfig?.serverUrl || profileConfig.config?.server_url || env.MAGCLAW_PUBLIC_URL || DEFAULT_SERVER_URL,
    workspaceId: flags.workspaceId || flags.workspace || setupFlags.workspaceId || setupFlags.workspace || parsedChannelPath?.workspaceId || existingProjectConfig?.workspaceId || profileConfig.config?.workspace_id || env.MAGCLAW_WORKSPACE_ID || 'local',
  };
  let login = null;
  if (!flags.noLogin && profileTokenIssue(profileConfig.config || {}, env, intendedLogin)) {
    login = await loginTeamSharingProfile({
      ...flags,
      channelPath: requestedChannelPath,
      serverUrl: intendedLogin.serverUrl,
      workspaceId: intendedLogin.workspaceId,
    }, env);
  }
  const project = await initTeamSharingProject(setupFlags, env);
  if (login?.onboardingTarget) project.onboardingTarget = login.onboardingTarget;
  const shim = await installTeamSharingShim(setupFlags, env);
  const hookFlags = shim.path ? { ...setupFlags, teamSharingCommand: shim.path } : setupFlags;
  const hooks = await installTeamSharingHooks(hookFlags, env);
  const skill = await installTeamSharingSkill(setupFlags, env);
  const finalProjectDir = skill.projectDir || hooks.projectDir || installTarget.projectDir || '';
  const finalScope = skill.scope === 'project' || hooks.scope === 'project'
    ? 'project'
    : installTarget.scope;
  const result = {
    ok: Boolean(project.ok && shim.ok && hooks.ok && skill.ok),
    scope: finalScope,
    projectDir: finalScope === 'project' ? finalProjectDir : '',
    project,
    shim,
    hooks,
    skill,
  };
  result.feedback = buildTeamSharingOnboardingFeedback({
    operation: 'setup',
    ok: result.ok,
    project,
    shim,
    hooks,
    skill,
  });
  return result;
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

const TEAM_SHARING_UPDATE_CACHE_TTL_MS = 12 * 60 * 60 * 1000;

function teamSharingUpdateServerUrl(options = {}, env = process.env) {
  const explicit = String(
    options.serverUrl
      || env.MAGCLAW_TEAM_SHARING_UPDATE_SERVER_URL
      || env.MAGCLAW_PUBLIC_URL
      || '',
  ).trim();
  return explicit ? normalizeServerUrl(explicit) : '';
}

function teamSharingPackageUpdateUrl(serverUrl = '', currentVersion = '', force = false) {
  const url = new URL('/api/package-updates', normalizeServerUrl(serverUrl));
  url.searchParams.set('packageName', TEAM_SHARING_PACKAGE_NAME);
  url.searchParams.set('currentVersion', currentVersion);
  if (force) url.searchParams.set('refresh', '1');
  return url.toString();
}

async function checkTeamSharingUpgradeFromServer(options = {}, env = process.env) {
  const serverUrl = teamSharingUpdateServerUrl(options, env);
  if (!serverUrl) return null;
  const currentVersion = String(options.currentVersion || env.MAGCLAW_TEAM_SHARING_VERSION || env.MAGCLAW_ENTRY_PACKAGE_VERSION || '0.0.0');
  const response = await fetch(teamSharingPackageUpdateUrl(serverUrl, currentVersion, Boolean(options.force)));
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.ok === false) throw new Error(data?.error || `package update API returned ${response.status}`);
  const packageInfo = data.package || {};
  const latestVersion = String(packageInfo.latestVersion || packageInfo.version || currentVersion);
  return {
    ok: true,
    fromCache: false,
    source: 'server',
    currentVersion: String(packageInfo.currentVersion || currentVersion),
    latestVersion,
    upgradeAvailable: packageInfo.updateAvailable === undefined
      ? semverGreater(latestVersion, currentVersion)
      : Boolean(packageInfo.updateAvailable),
    updateMode: String(packageInfo.updateMode || 'silent'),
    cacheTtlSeconds: Number(packageInfo.cacheTtlSeconds || TEAM_SHARING_UPDATE_CACHE_TTL_MS / 1000),
    releaseNotesMarkdown: String(data.releaseNotesMarkdown || ''),
    releaseNotes: data.releaseNotes || null,
    packageUpdate: data,
  };
}

async function checkTeamSharingUpgradeFromNpm(options = {}, env = process.env) {
  const currentVersion = String(options.currentVersion || env.MAGCLAW_TEAM_SHARING_VERSION || env.MAGCLAW_ENTRY_PACKAGE_VERSION || '0.0.0');
  const encodedPackageName = encodeURIComponent(TEAM_SHARING_PACKAGE_NAME);
  const response = await fetch(`https://registry.npmjs.org/${encodedPackageName}`);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `npm registry returned ${response.status}`);
  const latestVersion = String(data?.['dist-tags']?.latest || currentVersion);
  return {
    ok: true,
    fromCache: false,
    source: 'npm',
    currentVersion,
    latestVersion,
    upgradeAvailable: semverGreater(latestVersion, currentVersion),
    releaseNotesMarkdown: '',
    releaseNotes: null,
  };
}

export async function checkTeamSharingUpgrade(options = {}, env = process.env) {
  const paths = teamSharingPaths({ env });
  const nowMs = typeof options.nowMs === 'function' ? options.nowMs() : Date.now();
  const ttlMs = Math.max(60_000, Number(options.ttlMs || env.MAGCLAW_TEAM_SHARING_UPGRADE_TTL_MS || TEAM_SHARING_UPDATE_CACHE_TTL_MS) || TEAM_SHARING_UPDATE_CACHE_TTL_MS);
  const currentVersion = String(options.currentVersion || env.MAGCLAW_TEAM_SHARING_VERSION || env.MAGCLAW_ENTRY_PACKAGE_VERSION || '0.0.0');
  const cached = await readJsonFile(paths.versionCache, null);
  if (!options.force && cached?.checkedAtMs && nowMs - Number(cached.checkedAtMs) < ttlMs) {
    return {
      ok: true,
      fromCache: true,
      source: cached.source || 'cache',
      currentVersion,
      latestVersion: cached.latestVersion || currentVersion,
      upgradeAvailable: semverGreater(cached.latestVersion || currentVersion, currentVersion),
      updateMode: cached.updateMode || '',
      cacheTtlSeconds: cached.cacheTtlSeconds || Math.ceil(ttlMs / 1000),
      releaseNotesMarkdown: cached.releaseNotesMarkdown || '',
      releaseNotes: cached.releaseNotes || null,
      packageUpdate: cached.packageUpdate || null,
      checkedAtMs: cached.checkedAtMs,
    };
  }
  let result = null;
  try {
    result = await checkTeamSharingUpgradeFromServer({ ...options, currentVersion }, env);
  } catch {
    result = null;
  }
  if (!result) result = await checkTeamSharingUpgradeFromNpm({ ...options, currentVersion }, env);
  result.checkedAtMs = nowMs;
  await writeJsonFile(paths.versionCache, result);
  return result;
}

async function acquireTeamSharingUpdateLock(paths) {
  await mkdir(paths.updatesDir, { recursive: true });
  try {
    await mkdir(paths.updateLock);
    await writeJsonFile(path.join(paths.updateLock, 'owner.json'), {
      pid: process.pid,
      acquiredAt: now(),
    }, { privateFile: true });
    return {
      acquired: true,
      async release() {
        await rm(paths.updateLock, { recursive: true, force: true }).catch(() => {});
      },
    };
  } catch (error) {
    if (error?.code === 'EEXIST') {
      return { acquired: false, reason: 'update_in_progress', release: async () => {} };
    }
    throw error;
  }
}

async function stageTeamSharingPackage(flags = {}, env = process.env) {
  const paths = teamSharingPaths({ env });
  const version = cleanTemplateVersion(flags.latestVersion || flags.targetVersion || flags.version || '');
  if (!version || version === '0.0.0') throw new Error('A target Team Sharing version is required.');
  const versionDir = path.join(paths.versionsDir, version);
  await rm(versionDir, { recursive: true, force: true });
  await mkdir(versionDir, { recursive: true });
  if (flags.sourceDir) {
    const packageRoot = path.join(versionDir, 'package');
    await cp(path.resolve(flags.sourceDir), packageRoot, { recursive: true, force: true });
    const sourceCommit = cleanTemplateCommit(flags.sourceCommit || currentTeamSharingSourceCommit(env));
    if (sourceCommit !== 'unknown') {
      const packageJsonPath = path.join(packageRoot, 'package.json');
      const packageJson = await readJsonFile(packageJsonPath, {});
      await writeJsonFile(packageJsonPath, {
        ...packageJson,
        gitHead: sourceCommit,
      });
    }
    const bin = path.join(packageRoot, 'bin', 'team-sharing.js');
    await chmod(bin, 0o755).catch(() => {});
    return { version, versionDir, packageRoot, bin, source: 'sourceDir', sourceCommit };
  }
  const npmPath = String(flags.npmPath || env.MAGCLAW_TEAM_SHARING_NPM_PATH || 'npm').trim() || 'npm';
  const install = spawnSync(npmPath, [
    'install',
    '--prefix',
    versionDir,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--no-save',
    `${TEAM_SHARING_PACKAGE_NAME}@${version}`,
  ], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (install.status !== 0) {
    throw new Error(String(install.stderr || install.stdout || `npm install exited ${install.status}`).trim());
  }
  const packageRoot = path.join(versionDir, 'node_modules', '@magclaw', 'team-sharing');
  const bin = path.join(packageRoot, 'bin', 'team-sharing.js');
  await chmod(bin, 0o755).catch(() => {});
  return { version, versionDir, packageRoot, bin, source: 'npm' };
}

function verifyStagedTeamSharingPackage(stage, env = process.env) {
  const checkedAt = now();
  if (!existsSync(stage.bin)) throw new Error(`Staged Team Sharing binary is missing: ${stage.bin}`);
  const result = spawnSync(process.execPath, [stage.bin, '-V'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env,
      MAGCLAW_TEAM_SHARING_VERSION: stage.version,
    },
  });
  if (result.status !== 0) {
    throw new Error(String(result.stderr || result.stdout || `Team Sharing verify exited ${result.status}`).trim());
  }
  const stdout = String(result.stdout || '').trim();
  if (stdout && stdout !== stage.version) {
    throw new Error(`Team Sharing verify returned ${stdout}, expected ${stage.version}.`);
  }
  return {
    ok: true,
    status: 'healthy',
    method: 'smoke',
    version: stage.version,
    bin: stage.bin,
    checkedAt,
    stdout,
  };
}

async function writeTeamSharingUpdateState(paths, nextState) {
  await writeJsonFile(paths.updateState, nextState, { privateFile: true });
  await writeJsonFile(paths.updateActive, nextState, { privateFile: true });
}

async function activateTeamSharingPackage(stage, verify, metadata = {}, env = process.env) {
  const paths = teamSharingPaths({ env });
  const previousState = await readJsonFile(paths.updateState, {});
  const active = {
    version: stage.version,
    bin: stage.bin,
    packageRoot: stage.packageRoot,
    versionDir: stage.versionDir,
    source: stage.source,
    ...(metadata.sourceCommit || stage.sourceCommit ? { sourceCommit: metadata.sourceCommit || stage.sourceCommit } : {}),
    activatedAt: now(),
    verifiedAt: verify.checkedAt || now(),
    lastHealthyAt: verify.checkedAt || now(),
    health: verify,
    verify,
  };
  const state = {
    version: 1,
    active,
    previousActive: previousState.active || null,
    lastUpdate: {
      ok: true,
      version: stage.version,
      source: stage.source,
      ...(metadata.sourceCommit || stage.sourceCommit ? { sourceCommit: metadata.sourceCommit || stage.sourceCommit } : {}),
      releaseNotesMarkdown: metadata.releaseNotesMarkdown || '',
      updatedAt: now(),
    },
  };
  await writeTeamSharingUpdateState(paths, state);
  return state;
}

async function recordTeamSharingUpdateNotification(paths, notification) {
  const existing = await readJsonFile(paths.updateNotifications, { version: 1, notifications: [] });
  const notifications = [
    {
      id: `team-sharing-update-${stableHash(`${notification.version || ''}:${notification.createdAt || now()}`)}`,
      createdAt: now(),
      ...notification,
    },
    ...(Array.isArray(existing.notifications) ? existing.notifications : []),
  ].slice(0, 20);
  await writeJsonFile(paths.updateNotifications, { version: 1, notifications }, { privateFile: true });
}

function previousTeamSharingHealth(previousActive) {
  const health = previousActive?.health && typeof previousActive.health === 'object'
    ? previousActive.health
    : null;
  if (!previousActive) return { ok: false, status: 'missing', reason: 'missing_previous_active' };
  if (!previousActive.bin || !existsSync(previousActive.bin)) {
    return {
      ok: false,
      status: health?.status || 'missing',
      version: previousActive.version || health?.version || '',
      checkedAt: health?.checkedAt || '',
      reason: 'previous_bin_missing',
    };
  }
  if (!health) {
    return {
      ok: false,
      status: 'unknown',
      version: previousActive.version || '',
      reason: 'missing_health_record',
    };
  }
  const healthy = health.ok === true && health.status === 'healthy' && Boolean(health.checkedAt);
  return {
    ok: healthy,
    status: health.status || (healthy ? 'healthy' : 'unhealthy'),
    version: health.version || previousActive.version || '',
    checkedAt: health.checkedAt || '',
    method: health.method || '',
    reason: healthy ? 'healthy' : (health.reason || health.error || 'health_record_not_healthy'),
  };
}

async function restorePreviousTeamSharingActive(paths, previousActive, error) {
  const previousHealth = previousTeamSharingHealth(previousActive);
  const rollbackAvailable = Boolean(previousHealth.ok);
  const state = {
    version: 1,
    active: rollbackAvailable ? previousActive : null,
    previousActive: rollbackAvailable ? null : previousActive || null,
    lastUpdate: {
      ok: false,
      error: error?.message || String(error),
      failedAt: now(),
      rolledBack: rollbackAvailable,
      phase: 'verify',
      previousHealth,
    },
  };
  await writeTeamSharingUpdateState(paths, state);
  return { rolledBack: rollbackAvailable, previousHealth, state };
}

async function recordTeamSharingStageFailure(paths, previousState, error) {
  const activePreserved = Boolean(previousState?.active);
  const state = {
    version: 1,
    active: previousState?.active || null,
    previousActive: previousState?.previousActive || null,
    lastUpdate: {
      ok: false,
      phase: 'stage',
      error: error?.message || String(error),
      failedAt: now(),
      activePreserved,
    },
  };
  await writeTeamSharingUpdateState(paths, state);
  return { ok: false, activated: false, phase: 'stage', activePreserved, state, error: error?.message || String(error) };
}

async function syncRegisteredTeamSharingProjectsForUpdate(flags = {}, env = process.env, stage) {
  const listed = await listTeamSharingProjects({ ...flags, status: true }, env);
  const syncedProjects = [];
  const failedProjects = [];
  const skippedProjects = [];
  const projectEnv = {
    ...env,
    MAGCLAW_TEAM_SHARING_VERSION: stage.version,
    MAGCLAW_TEAM_SHARING_PACKAGE_SPEC: `${TEAM_SHARING_PACKAGE_NAME}@${stage.version}`,
  };
  for (const [key, project] of Object.entries(listed.projects || {})) {
    const projectPath = String(project?.path || '').trim();
    if (!projectPath || !existsSync(projectPath)) {
      skippedProjects.push({ key, path: projectPath, reason: 'missing_project' });
      continue;
    }
    const projectFlags = {
      ...flags,
      cwd: projectPath,
      projectDir: projectPath,
      installScope: 'project',
      target: flags.target || 'all',
      yes: true,
      nonInteractive: true,
      noLogin: true,
      packageSpec: `${TEAM_SHARING_PACKAGE_NAME}@${stage.version}`,
    };
    try {
      const shim = await installTeamSharingShim(projectFlags, projectEnv);
      const hooks = await installTeamSharingHooks({
        ...projectFlags,
        teamSharingCommand: shim.path || projectFlags.teamSharingCommand,
      }, projectEnv);
      const skill = await installTeamSharingSkill(projectFlags, projectEnv);
      syncedProjects.push({
        key,
        path: projectPath,
        ok: Boolean(shim.ok && hooks.ok && skill.ok),
        shim,
        hooks,
        skill,
      });
    } catch (error) {
      failedProjects.push({
        key,
        path: projectPath,
        ok: false,
        error: error?.message || String(error),
      });
    }
  }
  return { syncedProjects, failedProjects, skippedProjects };
}

export async function updateTeamSharingPackage(flags = {}, env = process.env) {
  const manual = Boolean(flags.manual || flags.yes || flags.force || flags.check || flags.checkOnly);
  if (env.MAGCLAW_TEAM_SHARING_AUTO_UPDATE === '0' && !manual) {
    return { ok: true, skipped: true, reason: 'auto_update_disabled' };
  }
  const currentVersion = String(flags.currentVersion || env.MAGCLAW_TEAM_SHARING_VERSION || env.MAGCLAW_ENTRY_PACKAGE_VERSION || '0.0.0');
  const check = flags.latestVersion
    ? {
      ok: true,
      currentVersion,
      latestVersion: String(flags.latestVersion),
      upgradeAvailable: semverGreater(flags.latestVersion, currentVersion),
      releaseNotesMarkdown: flags.releaseNotesMarkdown || '',
    }
    : await checkTeamSharingUpgrade({
      force: Boolean(flags.force),
      currentVersion,
      serverUrl: flags.serverUrl,
      nowMs: flags.nowMs,
    }, env);
  if (flags.check || flags.checkOnly) return check;
  if (!check.latestVersion || !semverGreater(check.latestVersion, currentVersion)) {
    return {
      ok: true,
      updated: false,
      currentVersion,
      latestVersion: check.latestVersion || currentVersion,
      upgradeAvailable: false,
      releaseNotesMarkdown: check.releaseNotesMarkdown || '',
    };
  }
  const paths = teamSharingPaths({ env });
  const lock = await acquireTeamSharingUpdateLock(paths);
  if (!lock.acquired) return { ok: true, skipped: true, reason: lock.reason || 'update_in_progress' };
  let stage = null;
  try {
    const previousState = await readJsonFile(paths.updateState, {});
    try {
      stage = await stageTeamSharingPackage({ ...flags, latestVersion: check.latestVersion }, env);
    } catch (error) {
      return await recordTeamSharingStageFailure(paths, previousState, error);
    }
    let verify = null;
    try {
      verify = verifyStagedTeamSharingPackage(stage, env);
    } catch (error) {
      const rollback = await restorePreviousTeamSharingActive(paths, previousState.active, error);
      return {
        ok: false,
        activated: false,
        currentVersion,
        latestVersion: check.latestVersion,
        error: error?.message || String(error),
        ...rollback,
      };
    }
    const state = await activateTeamSharingPackage(stage, verify, {
      releaseNotesMarkdown: check.releaseNotesMarkdown || '',
    }, env);
    const sync = flags.all ? await syncRegisteredTeamSharingProjectsForUpdate(flags, env, stage) : {
      syncedProjects: [],
      failedProjects: [],
      skippedProjects: [],
    };
    await recordTeamSharingUpdateNotification(paths, {
      packageName: TEAM_SHARING_PACKAGE_NAME,
      version: stage.version,
      releaseNotesMarkdown: check.releaseNotesMarkdown || '',
      syncedProjectCount: sync.syncedProjects.length,
      failedProjectCount: sync.failedProjects.length,
    });
    return {
      ok: true,
      activated: true,
      updated: true,
      currentVersion,
      latestVersion: stage.version,
      statePath: paths.updateState,
      activePath: paths.updateActive,
      active: state.active,
      releaseNotesMarkdown: check.releaseNotesMarkdown || '',
      ...sync,
    };
  } finally {
    await lock.release();
  }
}

const TEAM_SHARING_CODEX_RESTART_HINT = 'Open a new Codex thread or restart Codex to pick up refreshed plugin skills.';

function teamSharingUpdateApplyCommand(latestVersion = '') {
  const cleanVersion = cleanTemplateVersion(latestVersion);
  return cleanVersion && cleanVersion !== '0.0.0'
    ? `team-sharing update --target-version ${cleanVersion}`
    : 'team-sharing update';
}

function teamSharingCheckedAt(check = {}) {
  const checkedAtMs = Number(check.checkedAtMs || 0);
  if (Number.isFinite(checkedAtMs) && checkedAtMs > 0) return new Date(checkedAtMs).toISOString();
  return now();
}

async function readTeamSharingLastUpdate(env = process.env) {
  const paths = teamSharingPaths({ env });
  const state = await readJsonFile(paths.updateState, {});
  return state?.lastUpdate || null;
}

function teamSharingPackageUpdateSummary(check = {}, overrides = {}) {
  const currentVersion = String(check.currentVersion || overrides.currentVersion || '').trim();
  const latestVersion = String(check.latestVersion || overrides.latestVersion || currentVersion || '').trim();
  const updateAvailable = check.upgradeAvailable === undefined
    ? semverGreater(latestVersion, currentVersion)
    : Boolean(check.upgradeAvailable);
  const action = String(overrides.action || (updateAvailable ? 'notice' : 'skipped')).trim();
  return {
    ok: overrides.ok !== undefined ? Boolean(overrides.ok) : true,
    packageName: TEAM_SHARING_PACKAGE_NAME,
    currentVersion,
    latestVersion,
    updateAvailable,
    updateMode: String(check.updateMode || overrides.updateMode || 'silent'),
    action,
    applyCommand: updateAvailable ? teamSharingUpdateApplyCommand(latestVersion) : '',
    checkedAt: overrides.checkedAt || teamSharingCheckedAt(check),
    lastUpdate: overrides.lastUpdate || null,
    releaseNotesMarkdown: String(check.releaseNotesMarkdown || overrides.releaseNotesMarkdown || ''),
    ...(overrides.reason ? { reason: overrides.reason } : {}),
    ...(overrides.error ? { error: overrides.error } : {}),
    ...(overrides.restartHint ? { restartHint: overrides.restartHint } : {}),
    ...(overrides.result ? { result: overrides.result } : {}),
  };
}

export async function maybeAutoUpdateTeamSharingPackage(flags = {}, env = process.env) {
  const trigger = String(flags.trigger || 'manual').trim().toLowerCase() || 'manual';
  const manual = Boolean(flags.manual || flags.yes || flags.force || trigger === 'manual');
  const currentVersion = String(
    flags.currentVersion
      || env.MAGCLAW_TEAM_SHARING_VERSION
      || env.MAGCLAW_ENTRY_PACKAGE_VERSION
      || await currentTeamSharingPackageVersion(env)
      || '0.0.0',
  ).trim();
  const directLatestVersion = String(flags.latestVersion || flags.targetVersion || flags.version || '').trim();
  const checkedAt = now();
  let check = directLatestVersion
    ? {
      ok: true,
      source: 'provided',
      currentVersion,
      latestVersion: directLatestVersion,
      upgradeAvailable: semverGreater(directLatestVersion, currentVersion),
      updateMode: 'silent',
      checkedAt,
      releaseNotesMarkdown: String(flags.releaseNotesMarkdown || ''),
    }
    : null;
  const readLastUpdate = () => readTeamSharingLastUpdate(env);
  try {
    if (!check) {
      check = await checkTeamSharingUpgrade({
        force: Boolean(flags.force),
        currentVersion,
        serverUrl: flags.serverUrl,
        ttlMs: flags.ttlMs,
        nowMs: flags.nowMs,
      }, env);
    }
    const lastUpdate = await readLastUpdate();
    const summaryBase = { checkedAt, lastUpdate };
    if (env.MAGCLAW_TEAM_SHARING_AUTO_UPDATE === '0' && !manual) {
      return teamSharingPackageUpdateSummary(check, {
        ...summaryBase,
        action: 'skipped',
        reason: 'auto_update_disabled',
      });
    }
    const updateAvailable = check.upgradeAvailable === undefined
      ? semverGreater(check.latestVersion || currentVersion, currentVersion)
      : Boolean(check.upgradeAvailable);
    if (!updateAvailable) {
      return teamSharingPackageUpdateSummary(check, {
        ...summaryBase,
        action: 'skipped',
      });
    }
    const updateMode = String(check.updateMode || 'silent').trim().toLowerCase();
    if (updateMode !== 'silent' && !manual) {
      return teamSharingPackageUpdateSummary(check, {
        ...summaryBase,
        action: 'notice',
        updateMode,
      });
    }
    const result = await updateTeamSharingPackage({
      ...flags,
      currentVersion,
      latestVersion: check.latestVersion,
      releaseNotesMarkdown: check.releaseNotesMarkdown || flags.releaseNotesMarkdown || '',
      all: flags.all !== undefined ? Boolean(flags.all) : true,
      target: flags.target || 'all',
      check: false,
      checkOnly: false,
      manual,
    }, env);
    const afterLastUpdate = await readLastUpdate();
    if (result?.ok && result?.updated) {
      return teamSharingPackageUpdateSummary(check, {
        checkedAt,
        lastUpdate: afterLastUpdate,
        action: 'applied',
        restartHint: TEAM_SHARING_CODEX_RESTART_HINT,
        result,
      });
    }
    if (result?.ok) {
      return teamSharingPackageUpdateSummary(check, {
        checkedAt,
        lastUpdate: afterLastUpdate || lastUpdate,
        action: result.skipped ? 'skipped' : 'notice',
        reason: result.reason || '',
        result,
      });
    }
    return teamSharingPackageUpdateSummary(check, {
      ok: false,
      checkedAt,
      lastUpdate: afterLastUpdate || lastUpdate,
      action: 'failed',
      error: result?.error || result?.reason || 'Team Sharing update failed.',
      result,
    });
  } catch (error) {
    return teamSharingPackageUpdateSummary(check || { currentVersion, latestVersion: currentVersion, upgradeAvailable: false }, {
      ok: false,
      checkedAt,
      lastUpdate: await readLastUpdate().catch(() => null),
      action: 'failed',
      error: error?.message || String(error),
    });
  }
}
