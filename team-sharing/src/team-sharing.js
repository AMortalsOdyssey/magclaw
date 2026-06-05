import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile, chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import {
  buildTeamSharingHookCommand,
  buildTeamSharingSyncPackageFromTranscript,
  installTeamSharingHookConfig,
  parseTeamSharingTranscript,
} from './team-sharing-hooks.js';

export const TEAM_SHARING_PACKAGE_NAME = '@magclaw/team-sharing';
export const TEAM_SHARING_INTEGRATION = 'team-sharing';
const DEFAULT_PROFILE = 'default';
const DEFAULT_SERVER_URL = 'https://magclaw.multiego.me';
const TEAM_SHARING_PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEAM_SHARING_SKILL_TEMPLATE = path.join(TEAM_SHARING_PACKAGE_ROOT, 'skills', 'magclaw-team-sharing', 'SKILL.md');
const DEFAULT_REQUEST_TIMEOUT_MS = 12_000;
const TEAM_SHARING_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30;

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

function normalizeSearchMode(value = '') {
  const clean = String(value || '').trim().toLowerCase();
  if (['exact', 'keyword', 'keywords', 'bm25', 'lexical'].includes(clean)) return 'keyword';
  if (['fuzzy', 'semantic', 'vector', 'dense'].includes(clean)) return 'semantic';
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
    useKeyword: retrievalMode !== 'semantic',
    useSemantic: retrievalMode !== 'keyword',
    keywordQuery: uniqueSearchList([
      ...keywords,
      ...topics,
      query,
    ], 40).join('\n'),
  };
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
      entries.add('.claude/skills/magclaw-team-sharing/');
    } else {
      entries.add('.codex/hooks.json');
      entries.add('.agents/skills/magclaw-team-sharing/');
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

async function writeJsonFile(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function auditCharCount(value = '') {
  return Array.from(String(value || '')).length;
}

function redactAuditText(value = '') {
  return String(value || '')
    .replace(/([?&](?:key|token|api_key|secret)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/\b((?:api[_-]?key|token|secret|password|passwd)\s*[:=]\s*)[^\s,;'"<>]+/gi, '$1[redacted]');
}

function sanitizeAuditValue(value, key = '') {
  const cleanKey = String(key || '').toLowerCase();
  if (/token|authorization|secret|password|api[_-]?key/.test(cleanKey)) return '[redacted]';
  if (typeof value === 'string') return redactAuditText(value);
  if (Array.isArray(value)) return value.map((item) => sanitizeAuditValue(item, key));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeAuditValue(childValue, childKey),
    ]));
  }
  return value;
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

async function teamSharingTemplateVars(env = process.env) {
  const packageJson = await readTeamSharingPackageJson();
  const explicitSourceCommit = cleanTemplateCommit(env.MAGCLAW_TEAM_SHARING_SOURCE_COMMIT || '');
  return {
    TEAM_SHARING_VERSION: cleanTemplateVersion(env.MAGCLAW_TEAM_SHARING_VERSION || packageJson.version || ''),
    TEAM_SHARING_SOURCE_COMMIT: explicitSourceCommit !== 'unknown'
      ? explicitSourceCommit
      : cleanTemplateCommit(packageJson.gitHead || currentTeamSharingSourceCommit(env)),
  };
}

function renderTeamSharingTemplate(text = '', vars = {}) {
  return String(text || '').replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) => (
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match
  ));
}

function jsonStringContent(value = '') {
  const encoded = JSON.stringify(String(value || ''));
  return encoded.slice(1, -1);
}

async function teamSharingSkillMarkdown(env = process.env) {
  const template = await readFile(TEAM_SHARING_SKILL_TEMPLATE, 'utf8');
  return renderTeamSharingTemplate(template, await teamSharingTemplateVars(env));
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
    packageVersion: vars.TEAM_SHARING_VERSION,
    sourceCommit: vars.TEAM_SHARING_SOURCE_COMMIT,
  })));
  return JSON.parse(renderTeamSharingTemplate(withCommands, vars));
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
        `${cmdQuote(cleanNpmPath)} exec --yes --package ${cmdQuote(cleanPackageSpec)} -- team-sharing %*`,
        '',
      ].join('\r\n'),
    },
    {
      name: 'team-sharing.ps1',
      content: [
        '$ErrorActionPreference = "Stop"',
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
  return {
    ok: true,
    command: 'team-sharing',
    installed: changed,
    updated: changed,
    binDir,
    path: path.join(binDir, String(flags.platform || env.MAGCLAW_TEAM_SHARING_PLATFORM || process.platform).toLowerCase() === 'win32' ? 'team-sharing.cmd' : 'team-sharing'),
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
  return Math.max(1000, Number(flags.requestTimeoutMs || env.MAGCLAW_TEAM_SHARING_REQUEST_TIMEOUT_MS || DEFAULT_REQUEST_TIMEOUT_MS) || DEFAULT_REQUEST_TIMEOUT_MS);
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

async function teamSharingRequest({ serverUrl, token = '', machineFingerprint = '', method = 'GET', pathname = '/', body = null, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const startedAtMs = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS) || DEFAULT_REQUEST_TIMEOUT_MS));
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
    const timeout = error?.name === 'AbortError';
    return {
      ok: false,
      status: 0,
      statusText: timeout ? 'timeout' : '',
      data: {},
      durationMs: Date.now() - startedAtMs,
      timeout,
      error: timeout ? `Team Sharing request timed out after ${timeoutMs}ms.` : String(error?.message || error),
      requestBodyCharCount: auditCharCount(bodyText),
      requestBodyByteCount: byteLength(bodyText),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function teamSharingRequestJson({ serverUrl, token = '', machineFingerprint = '', method = 'GET', pathname = '/', body = null, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
  const request = await teamSharingRequest({ serverUrl, token, machineFingerprint, method, pathname, body, timeoutMs });
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
  const serverUrl = normalizeServerUrl(flags.serverUrl || existing.server_url || env.MAGCLAW_PUBLIC_URL || DEFAULT_SERVER_URL);
  const workspaceId = String(flags.workspaceId || flags.workspace || existing.workspace_id || env.MAGCLAW_WORKSPACE_ID || 'local').trim();
  const machineFingerprint = teamSharingMachineFingerprint(env);
  const manualToken = String(flags.token || flags.apiKey || flags.teamSharingToken || env.MAGCLAW_TEAM_SHARING_TOKEN || '').trim();
  let token = manualToken;
  let tokenExpiresAt = tokenExpiryFromFlags(flags);
  let user = {};
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
  return { ok: true, profile, serverUrl, workspaceId, hasToken: Boolean(token), tokenExpiresAt, machineFingerprint, profileConfig, user, verificationUrl };
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
  return nestedStringValue(hookPayload || {}, [
    ['session_title'],
    ['sessionTitle'],
    ['conversation_title'],
    ['conversationTitle'],
    ['event_payload', 'session_title'],
    ['event_payload', 'sessionTitle'],
    ['payload', 'session_title'],
    ['payload', 'sessionTitle'],
  ]);
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
      runtime: normalizeRuntime(flags.runtime || 'codex'),
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
  baseAudit.trigger.hookEvent = hookEvent || baseAudit.trigger.hookEvent;
  baseAudit.transcript = {
    pathSource: resolvedTranscript.source || '',
    pathHash: transcriptPath ? stableHash(path.resolve(transcriptPath)) : '',
  };
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
  try {
  const runtime = normalizeRuntime(flags.runtime || 'codex');
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
  const content = await readFile(path.resolve(transcriptPath), 'utf8');
  baseAudit.transcript.charCount = auditCharCount(content);
  baseAudit.transcript.byteCount = byteLength(content);
  baseAudit.transcript.hash = stableHash(content);
  const explicitSessionTitle = resolveTeamSharingSessionTitle({ ...flags, runtime }, env, hookPayload);
  const parsed = parseTeamSharingTranscript(content, {
    runtime,
    sessionId: flags.sessionId || nestedStringValue(hookPayload, [['session_id'], ['sessionId']]) || '',
    title: explicitSessionTitle,
    projectDir: flags.cwd || process.cwd(),
  });
  baseAudit.session = {
    runtime: parsed.runtime,
    sessionId: parsed.sessionId,
    titleHash: stableHash(explicitSessionTitle || parsed.title || path.basename(transcriptPath)),
    parsedEventCount: parsed.events.length,
    parsedEventTextCharCount: auditCharCount(parsed.events.map((event) => event.text || '').join('\n')),
  };
  const cursor = await readJsonFile(project.paths.projectCursor, {});
  const lastOrdinal = Number(flags.full ? 0 : cursorLastOrdinal(cursor, parsed.runtime, parsed.sessionId));
  const syncPackage = buildTeamSharingSyncPackageFromTranscript(content, {
    runtime: parsed.runtime,
    sessionId: parsed.sessionId,
    title: explicitSessionTitle || parsed.title || path.basename(transcriptPath),
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
    const metadata = Object.fromEntries(Object.entries({
      integration: String(flags.integration || '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, ''),
      packageVersion: flags.packageVersion ? cleanTemplateVersion(flags.packageVersion) : '',
      sourceCommit: flags.sourceCommit ? cleanTemplateCommit(flags.sourceCommit) : '',
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
    await writeAudit({
      ok: true,
      status: 'skipped',
      phase: 'build_package',
      reason: 'no_incremental_events',
      cursor: syncPackage.cursor,
      upload: buildUploadAuditContent(syncPackage.body || {}, { includeContent: false }),
      summary: {
        localPackageBuilt: false,
        cloudAbstractRevision: 0,
        cloudIndexedDocumentCount: 0,
      },
    });
    return { ok: true, empty: true, cursor: syncPackage.cursor };
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
  if (!query) throw new Error('Usage: team-sharing search --query <text>');
  const { project, serverUrl, token, machineFingerprint } = await resolveTeamSharingClient(flags, env, { allowLogin: true });
  const intent = buildSearchIntent({ query, flags, env });
  return teamSharingRequestJson({
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
      channelId: flags.channelId || project.config.channelId || '',
      projectKey: flags.projectKey || project.config.projectKey || '',
      dateRange: intent.dateRange,
      timePreference: intent.timePreference,
      searchMode: intent.searchMode,
      modeBias: intent.modeBias,
      retrievalIntent: {
        useKeyword: intent.useKeyword,
        useSemantic: intent.useSemantic,
        modeBias: intent.modeBias,
        source: 'team-sharing-cli',
      },
      sortBy: normalizeSearchSort(flags.sortBy || flags.sort || flags.orderBy),
      candidateK: flags.candidateK ? numberFlag(flags.candidateK) : undefined,
      minScore: flags.minScore !== undefined ? numberFlag(flags.minScore) : undefined,
      limit: numberFlag(flags.limit, 5),
    },
  });
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
  return teamSharingRequestJson({
    serverUrl,
    token,
    machineFingerprint,
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
  const { project, serverUrl, token, machineFingerprint } = await resolveTeamSharingClient(flags, env, { allowLogin: true });
  const contentType = inferShareArtifactType(flags.type || flags.contentType, filePath);
  const title = String(flags.title || flags.name || pickShareArtifactTitle(content, contentType, filePath)).trim() || 'MagClaw shared page';
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
  const text = String(command || '').trim();
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
    command: sanitizeAuditValue(token),
    executable,
    resolvedPath: executable ? sanitizeAuditValue(resolved) : '',
    reason: executable ? 'ok' : (hasPathSeparator ? 'command_path_missing' : 'command_not_found_in_path'),
  };
}

export async function installTeamSharingHooks(flags = {}, env = process.env) {
  const installTarget = await resolveInstallTarget(flags, env, { prompt: true });
  const cwd = path.resolve(installTarget.projectDir || flags.cwd || process.cwd());
  const targets = selectedTargets(flags, env);
  const ignored = installTarget.scope === 'project' ? await ensureProjectInstallIgnored(cwd, targets) : [];
  const output = { ok: true, scope: installTarget.scope, projectDir: installTarget.projectDir || '', ignored };
  for (const runtime of targets) {
    const key = runtime === 'claude_code' ? 'claude' : 'codex';
    const templateConfig = await readTeamSharingHookTemplateConfig(runtime, {
      projectDir: cwd,
      integration: TEAM_SHARING_INTEGRATION,
      teamSharingCommand: flags.teamSharingCommand,
      platform: flags.platform || env.MAGCLAW_TEAM_SHARING_PLATFORM,
    }, env);
    output[key] = await installTeamSharingHookConfig({
      runtime,
      configPath: targetConfigPath(runtime, flags, env, installTarget),
      projectDir: cwd,
      integration: TEAM_SHARING_INTEGRATION,
      teamSharingCommand: flags.teamSharingCommand,
      templateConfig,
    });
  }
  output.ok = Object.values(output).every((item) => item === true || item?.ok !== false);
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
          if (String(hook.command || '').includes('--integration team-sharing')) {
            installed.push(eventName);
            commandChecks.push({
              eventName,
              ...hookCommandStatus(hook.command, env),
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

async function writeTeamSharingSkill(rootDir, env = process.env) {
  const skillDir = path.join(rootDir, 'skills', 'magclaw-team-sharing');
  await mkdir(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, 'SKILL.md');
  await writeFile(skillPath, await teamSharingSkillMarkdown(env));
  return skillPath;
}

export async function installTeamSharingSkill(flags = {}, env = process.env) {
  const installTarget = await resolveInstallTarget(flags, env, { prompt: true });
  const targets = selectedTargets(flags, env);
  const ignored = installTarget.scope === 'project' ? await ensureProjectInstallIgnored(installTarget.projectDir, targets) : [];
  const output = { ok: true, scope: installTarget.scope, projectDir: installTarget.projectDir || '', ignored, installed: [] };
  for (const runtime of targets) {
    output.installed.push({ target: runtime, path: await writeTeamSharingSkill(skillRootForTarget(runtime, flags, env, installTarget), env) });
  }
  output.ok = output.installed.length > 0;
  return output;
}

export async function statusTeamSharingSkill(flags = {}, env = process.env) {
  const installTarget = await resolveInstallTarget(flags, env, { prompt: false });
  const targets = selectedTargets(flags, env);
  const installed = [];
  for (const runtime of targets) {
    const skillPath = path.join(skillRootForTarget(runtime, flags, env, installTarget), 'skills', 'magclaw-team-sharing', 'SKILL.md');
    if (existsSync(skillPath)) installed.push({ target: runtime, path: skillPath });
  }
  return {
    ok: installed.length === targets.length,
    scope: installTarget.scope,
    projectDir: installTarget.projectDir || '',
    expectedTargets: targets,
    installed,
  };
}

export async function removeTeamSharingSkill(flags = {}, env = process.env) {
  const installTarget = await resolveInstallTarget(flags, env, { prompt: false });
  const removed = [];
  for (const runtime of selectedTargets(flags, env)) {
    const skillDir = path.join(skillRootForTarget(runtime, flags, env, installTarget), 'skills', 'magclaw-team-sharing');
    if (existsSync(skillDir)) {
      await rm(skillDir, { recursive: true, force: true });
      removed.push({ target: runtime, path: skillDir });
    }
  }
  return { ok: true, scope: installTarget.scope, projectDir: installTarget.projectDir || '', removed };
}

export async function disableTeamSharingSkill(flags = {}, env = process.env) {
  const installTarget = await resolveInstallTarget(flags, env, { prompt: false });
  const disabled = [];
  for (const runtime of selectedTargets(flags, env)) {
    const skillPath = path.join(skillRootForTarget(runtime, flags, env, installTarget), 'skills', 'magclaw-team-sharing', 'SKILL.md');
    const disabledPath = `${skillPath}.disabled`;
    if (existsSync(skillPath)) {
      await rename(skillPath, disabledPath);
      disabled.push({ target: runtime, path: disabledPath });
    }
  }
  return { ok: true, scope: installTarget.scope, projectDir: installTarget.projectDir || '', disabled };
}

export async function setupTeamSharing(flags = {}, env = process.env) {
  flags = await promptSetupTarget(flags, env);
  const installTarget = await resolveInstallTarget(flags, env, { prompt: true });
  const setupFlags = installTarget.scope === 'project' ? { ...flags, cwd: installTarget.projectDir } : flags;
  const profile = safeProfileName(flags.profile || env.MAGCLAW_TEAM_SHARING_PROFILE || DEFAULT_PROFILE);
  const profileConfig = await readTeamSharingProfileConfig(profile, env);
  const existingProject = await readTeamSharingProjectConfig({ profile, cwd: setupFlags.cwd || process.cwd(), env });
  const existingProjectConfig = normalizeTeamSharingProjectConfig(existingProject.config);
  const parsedChannelPath = parseMagClawChannelPath(channelPathFromFlags(setupFlags, existingProject.config || {}));
  const intendedLogin = {
    serverUrl: flags.serverUrl || setupFlags.serverUrl || existingProjectConfig?.serverUrl || profileConfig.config?.server_url || env.MAGCLAW_PUBLIC_URL || DEFAULT_SERVER_URL,
    workspaceId: flags.workspaceId || flags.workspace || setupFlags.workspaceId || setupFlags.workspace || parsedChannelPath?.workspaceId || existingProjectConfig?.workspaceId || profileConfig.config?.workspace_id || env.MAGCLAW_WORKSPACE_ID || 'local',
  };
  if (!flags.noLogin && profileTokenIssue(profileConfig.config || {}, env, intendedLogin)) {
    await loginTeamSharingProfile({ ...flags, serverUrl: intendedLogin.serverUrl, workspaceId: intendedLogin.workspaceId }, env);
  }
  const project = await initTeamSharingProject(setupFlags, env);
  const shim = await installTeamSharingShim(setupFlags, env);
  const hookFlags = shim.path ? { ...setupFlags, teamSharingCommand: shim.path } : setupFlags;
  const hooks = await installTeamSharingHooks(hookFlags, env);
  const skill = await installTeamSharingSkill(setupFlags, env);
  const finalProjectDir = skill.projectDir || hooks.projectDir || installTarget.projectDir || '';
  const finalScope = skill.scope === 'project' || hooks.scope === 'project'
    ? 'project'
    : installTarget.scope;
  return {
    ok: Boolean(project.ok && shim.ok && hooks.ok && skill.ok),
    scope: finalScope,
    projectDir: finalScope === 'project' ? finalProjectDir : '',
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
