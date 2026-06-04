import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CODEX_HOOK_EVENTS = Object.freeze(['Stop', 'PreCompact', 'SessionStart']);
const CLAUDE_HOOK_EVENTS = Object.freeze(['Stop', 'SessionEnd', 'PreCompact', 'SessionStart']);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function stableHash(value = '') {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function redactTeamSharingText(value = '') {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/(?:api[_-]?key|token|secret|password|密钥|秘钥|口令|令牌)\s*[：:=]\s*["']?[^\s"',;，。)）]+/gi, '[redacted-secret]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, 'Bearer [redacted-secret]')
    .replace(/([?&](?:key|api[_-]?key|token|access_token|secret)=)[^\s"'&)）]+/gi, '$1[redacted-secret]')
    .replace(/(App Secret|app_secret|client_secret)(\s*[：:=]\s*)[^\s"',;，。)）]+/gi, '$1$2[redacted-secret]')
    .trim();
}

function iso(value, fallback = new Date().toISOString()) {
  const date = new Date(value || fallback);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function parseJsonOrJsonl(text = '') {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      // Fall through to JSONL parsing. Codex transcripts are newline-delimited
      // JSON objects and usually start with "{".
    }
  }
  return trimmed.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function isInjectedCodexContext(text = '') {
  const clean = String(text || '').trim();
  return clean.startsWith('# AGENTS.md instructions for ')
    || clean.startsWith('<environment_context>')
    || clean.startsWith('<permissions instructions>')
    || clean.startsWith('<skills_instructions>')
    || clean.startsWith('<plugins_instructions>');
}

function textFromContentBlocks(content) {
  const blocks = asArray(content);
  if (!blocks.length && typeof content === 'string') return content;
  return blocks
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      return block.text || block.content || '';
    })
    .filter((text) => text && !isInjectedCodexContext(text))
    .join('\n\n');
}

function pushUnique(target, value) {
  const clean = String(value || '').trim();
  if (clean && !target.includes(clean)) target.push(clean);
}

function normalizeRuntime(value = '') {
  const runtime = String(value || '').trim().toLowerCase();
  if (runtime === 'claude' || runtime === 'claude-code') return 'claude_code';
  if (runtime === 'codex') return 'codex';
  return runtime || 'codex';
}

function codexTextEvent(item, context) {
  if (item?.type === 'session_meta' && item.payload) {
    context.sessionId = context.sessionId || item.payload.id || item.payload.session_id || '';
    context.projectPath = context.projectPath || item.payload.cwd || '';
    context.title = context.title || item.payload.title || item.payload.thread_title || '';
    return null;
  }
  if (item?.type !== 'response_item') return null;
  const payload = item.payload || {};
  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
    pushUnique(context.toolNames, payload.name);
    return null;
  }
  if (payload.type !== 'message') return null;
  const role = String(payload.role || '').toLowerCase();
  if (!['user', 'assistant'].includes(role)) return null;
  const text = redactTeamSharingText(textFromContentBlocks(payload.content));
  if (!text) return null;
  return {
    role,
    text,
    createdAt: iso(item.timestamp),
    toolCalls: role === 'assistant' && context.toolNames.length
      ? context.toolNames.map((name) => ({ name }))
      : [],
  };
}

function claudeTextEvent(item, context) {
  const raw = item?.payload && typeof item.payload === 'object' ? item.payload : item;
  if (raw?.type === 'system' && raw.subtype === 'init') {
    context.sessionId = context.sessionId || raw.session_id || raw.sessionId || '';
    context.projectPath = context.projectPath || raw.cwd || '';
    return null;
  }
  if (raw?.type === 'assistant' || raw?.type === 'user') {
    const textBlocks = asArray(raw.message?.content)
      .map((block) => (block?.type === 'text' ? block.text : ''))
      .filter(Boolean);
    const text = redactTeamSharingText(textBlocks.join('\n\n'));
    if (!text) return null;
    return {
      role: raw.type === 'assistant' ? 'assistant' : 'user',
      text,
      createdAt: iso(item.timestamp || raw.timestamp),
      toolCalls: raw.type === 'assistant' && context.toolNames.length
        ? context.toolNames.map((name) => ({ name }))
        : [],
    };
  }
  for (const block of asArray(raw?.message?.content)) {
    if (block?.type === 'tool_use') pushUnique(context.toolNames, block.name);
  }
  return null;
}

export function parseTeamSharingTranscript(text = '', options = {}) {
  const runtime = normalizeRuntime(options.runtime);
  const parsed = parseJsonOrJsonl(text);
  const context = {
    runtime,
    sessionId: String(options.sessionId || '').trim(),
    projectPath: String(options.projectPath || options.projectDir || '').trim(),
    title: String(options.title || '').trim(),
    toolNames: [],
  };
  const extractedEvents = [];
  for (const item of parsed) {
    const extracted = runtime === 'claude_code'
      ? claudeTextEvent(item, context)
      : codexTextEvent(item, context);
    if (!extracted) continue;
    extractedEvents.push(extracted);
  }
  const visibleEvents = [];
  let pendingAssistant = null;
  const flushAssistant = () => {
    if (!pendingAssistant) return;
    visibleEvents.push(pendingAssistant);
    pendingAssistant = null;
  };
  for (const event of extractedEvents) {
    if (event.role === 'assistant') {
      pendingAssistant = event;
      continue;
    }
    flushAssistant();
    visibleEvents.push(event);
  }
  flushAssistant();
  const sessionSeed = context.sessionId || options.sessionId || 'session';
  const events = visibleEvents.map((event, index) => {
    const ordinal = index + 1;
    const eventId = `${sessionSeed}:${ordinal}:${stableHash(`${event.role}:${event.text}`)}`;
    return {
      eventId,
      rawEventId: eventId,
      ordinal,
      role: event.role,
      text: event.text,
      createdAt: event.createdAt,
      sourceHash: stableHash(event.text),
      sourceAnchor: `${sessionSeed}#${eventId}`,
      toolCalls: event.toolCalls,
    };
  });
  if (!context.title) {
    context.title = `${runtime} session ${context.sessionId || stableHash(text)}`;
  }
  if (!context.sessionId) context.sessionId = stableHash(`${runtime}:${context.projectPath}:${text}`);
  return {
    runtime,
    sessionId: context.sessionId,
    projectPath: context.projectPath,
    title: context.title,
    toolNames: context.toolNames,
    events,
  };
}

export function buildTeamSharingSyncPackageFromTranscript(text = '', options = {}) {
  const runtime = normalizeRuntime(options.runtime);
  const parsed = parseTeamSharingTranscript(text, options);
  const lastOrdinal = Math.max(0, Number(options.lastOrdinal || 0));
  const minCreatedAt = String(options.minCreatedAt || '').trim();
  const projectKey = String(options.projectKey || path.basename(parsed.projectPath || process.cwd()) || 'default').trim();
  const incrementalEvents = parsed.events
    .filter((event) => Number(event.ordinal || 0) > lastOrdinal)
    .filter((event) => !minCreatedAt || String(event.createdAt || '') >= minCreatedAt);
  const hookEvent = String(options.hookEvent || options.hookEventName || '').trim();
  const shouldCreateSessionStart = hookEvent === 'SessionStart' && lastOrdinal === 0;
  if (!incrementalEvents.length) {
    if (shouldCreateSessionStart) {
      const createdAt = options.now?.() || new Date().toISOString();
      const body = {
        runtime,
        projectKey,
        projectPathHash: stableHash(parsed.projectPath || projectKey),
        sessionId: parsed.sessionId,
        title: options.title || parsed.title,
        workspaceId: options.workspaceId || '',
        channelId: options.channelId || '',
        channelPath: options.channelPath || '',
        fromOrdinal: 0,
        toOrdinal: 0,
        idempotencyKey: `${runtime}:${projectKey}:${parsed.sessionId}:session-start:${stableHash(options.title || parsed.title || '')}`,
        optionalLocalDigest: '',
        events: [],
        createdAt,
        metadata: {
          hookEvent,
          emptySessionStart: true,
        },
      };
      return {
        ok: true,
        empty: false,
        sessionStart: true,
        body,
        cursor: {
          runtime,
          sessionId: parsed.sessionId,
          lastOrdinal,
          updatedAt: createdAt,
        },
      };
    }
    return {
      ok: true,
      empty: true,
      body: null,
      cursor: {
        runtime,
        sessionId: parsed.sessionId,
        lastOrdinal,
      },
    };
  }
  const fromOrdinal = incrementalEvents[0].ordinal;
  const toOrdinal = incrementalEvents[incrementalEvents.length - 1].ordinal;
  const batchHash = stableHash(JSON.stringify(incrementalEvents.map((event) => ({
    eventId: event.eventId,
    sourceHash: event.sourceHash,
  }))));
  const body = {
    runtime,
    projectKey,
    projectPathHash: stableHash(parsed.projectPath || projectKey),
    sessionId: parsed.sessionId,
    title: options.title || parsed.title,
    workspaceId: options.workspaceId || '',
    channelId: options.channelId || '',
    channelPath: options.channelPath || '',
    fromOrdinal,
    toOrdinal,
    idempotencyKey: `${runtime}:${projectKey}:${parsed.sessionId}:${fromOrdinal}:${toOrdinal}:${batchHash}`,
    optionalLocalDigest: [
      options.localDigest || '',
      parsed.toolNames.length ? `Tool summary: ${parsed.toolNames.join(', ')}` : '',
    ].filter(Boolean).join('\n'),
    events: incrementalEvents,
    createdAt: options.now?.() || new Date().toISOString(),
  };
  return {
    ok: true,
    empty: false,
    body,
    cursor: {
      runtime,
      sessionId: parsed.sessionId,
      lastOrdinal: toOrdinal,
      lastEventId: incrementalEvents[incrementalEvents.length - 1].eventId,
      updatedAt: body.createdAt,
    },
  };
}

export function shouldRunTeamSharingHook({ runtime = 'codex', hookEventName = '' } = {}) {
  const normalized = normalizeRuntime(runtime);
  const event = String(hookEventName || '').trim();
  const allowed = normalized === 'claude_code' ? CLAUDE_HOOK_EVENTS : CODEX_HOOK_EVENTS;
  return allowed.includes(event);
}

function normalizeCommandPlatform(value = process.platform) {
  return String(value || '').toLowerCase() === 'win32' ? 'win32' : 'posix';
}

function posixShellQuote(value = '') {
  return `'${String(value || '').replace(/'/g, "'\\''")}'`;
}

function windowsCmdQuote(value = '') {
  const text = String(value || '');
  return `"${text.replace(/(["^&|<>])/g, '^$1')}"`;
}

function shellQuote(value = '', platform = process.platform) {
  return normalizeCommandPlatform(platform) === 'win32'
    ? windowsCmdQuote(value)
    : posixShellQuote(value);
}

function shouldQuoteCommandPath(value = '', platform = process.platform) {
  const text = String(value || '');
  if (!text) return false;
  if (normalizeCommandPlatform(platform) === 'win32') {
    return /[\s"&|<>^]/.test(text) || /[\\/]/.test(text);
  }
  return /[\s'"$`\\]/.test(text);
}

export function buildTeamSharingHookCommand(options = {}) {
  const runtime = normalizeRuntime(options.runtime);
  const platform = options.platform || process.platform;
  const hookEventName = String(options.hookEventName || (runtime === 'claude_code' ? 'SessionEnd' : 'Stop')).trim();
  const transcriptPath = String(options.transcriptPath || '').trim();
  const sessionTitle = String(options.sessionTitle ?? '').trim();
  const commandPath = String(options.teamSharingCommand || options.commandPath || 'team-sharing').trim() || 'team-sharing';
  const parts = [
    shouldQuoteCommandPath(commandPath, platform) ? shellQuote(commandPath, platform) : commandPath,
    'sync',
    '--runtime',
    runtime,
    '--hook-event',
    hookEventName,
  ];
  if (transcriptPath) parts.push('--transcript', shellQuote(transcriptPath, platform));
  if (sessionTitle) parts.push('--session-title', shellQuote(sessionTitle, platform));
  if (options.integration) parts.push('--integration', String(options.integration).replace(/[^a-zA-Z0-9._-]+/g, '-'));
  if (options.packageVersion) parts.push('--package-version', shellQuote(String(options.packageVersion).replace(/[^a-zA-Z0-9._+-]+/g, '-'), platform));
  if (options.sourceCommit) parts.push('--source-commit', shellQuote(String(options.sourceCommit).replace(/[^a-zA-Z0-9._-]+/g, '-'), platform));
  if (options.projectDir) parts.push('--cwd', shellQuote(options.projectDir, platform));
  return parts.join(' ');
}

function isTeamSharingHookCommand(command, runtime, hookEventName) {
  const text = String(command || '');
  const hasTeamSharingSync = (text.includes('team-sharing') && text.includes(' sync '))
    || text.includes('magclaw team-sharing sync');
  return hasTeamSharingSync
    && text.includes(`--runtime ${runtime}`)
    && text.includes(`--hook-event ${hookEventName}`);
}

function hookEventsForRuntime(runtime, templateConfig = null) {
  const templateEvents = templateConfig?.hooks && typeof templateConfig.hooks === 'object'
    ? Object.keys(templateConfig.hooks).filter(Boolean)
    : [];
  return templateEvents.length ? templateEvents : (normalizeRuntime(runtime) === 'claude_code' ? CLAUDE_HOOK_EVENTS : CODEX_HOOK_EVENTS);
}

async function readJson(file, fallback = {}) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function desiredTeamSharingHook(options = {}, runtime = 'codex', hookEventName = 'Stop') {
  const entries = asArray(options.templateConfig?.hooks?.[hookEventName]);
  for (const entry of entries) {
    for (const hook of asArray(entry?.hooks)) {
      const command = String(hook?.command || '').trim();
      if (!command) continue;
      return {
        type: hook.type || 'command',
        command,
        timeout: Number(hook.timeout || 0) || (hookEventName === 'SessionStart' ? 3 : 15),
      };
    }
  }
  return {
    type: 'command',
    command: buildTeamSharingHookCommand({ ...options, runtime, hookEventName }),
    timeout: hookEventName === 'SessionStart' ? 3 : 15,
  };
}

export async function installTeamSharingHookConfig(options = {}) {
  const runtime = normalizeRuntime(options.runtime);
  const configPath = String(options.configPath || '').trim();
  if (!configPath) throw new Error('configPath is required.');
  const config = await readJson(configPath, {});
  config.hooks = config.hooks && typeof config.hooks === 'object' ? config.hooks : {};
  const installed = [];
  for (const hookEventName of hookEventsForRuntime(runtime, options.templateConfig)) {
    const desiredHook = desiredTeamSharingHook(options, runtime, hookEventName);
    const command = desiredHook.command;
    const entries = asArray(config.hooks[hookEventName]);
    const entry = entries[0] || { hooks: [] };
    entry.hooks = asArray(entry.hooks);
    const existingHookIndex = entry.hooks.findIndex((hook) => isTeamSharingHookCommand(hook?.command, runtime, hookEventName));
    if (existingHookIndex >= 0) {
      entry.hooks[existingHookIndex] = {
        ...entry.hooks[existingHookIndex],
        type: entry.hooks[existingHookIndex].type || desiredHook.type || 'command',
        command,
        timeout: entry.hooks[existingHookIndex].timeout || desiredHook.timeout,
      };
    } else {
      entry.hooks.push(desiredHook);
      installed.push(hookEventName);
    }
    config.hooks[hookEventName] = entries.length ? entries : [entry];
  }
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return {
    ok: true,
    runtime,
    configPath,
    installed,
  };
}
