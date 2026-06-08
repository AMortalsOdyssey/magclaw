#!/usr/bin/env node

import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';

const DEFAULTS = Object.freeze({
  spaceType: 'channel',
  spaceId: 'chan_all',
  messageLimit: 80,
  threadRootLimit: 160,
  sseMs: 3000,
  timeoutMs: 10000,
});

const JSON_COLLECTION_KEYS = Object.freeze([
  'messages',
  'replies',
  'channels',
  'dms',
  'agents',
  'humans',
  'tasks',
  'computers',
  'attachments',
  'projects',
]);

function numberOption(value, fallback, name) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
  return parsed;
}

function boolEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function normalizeHeaderName(name) {
  return String(name || '').trim().toLowerCase();
}

function assertSafeHeaderValue(value, name) {
  const text = String(value || '');
  if (/[\r\n]/.test(text)) throw new Error(`Header ${name} contains an unsafe newline`);
  return text;
}

export function authHeadersFromEnv(env = process.env) {
  const headers = {};
  const summary = {
    cookie: Boolean(env.MAGCLAW_PERF_COOKIE),
    authorization: Boolean(env.MAGCLAW_PERF_AUTH_HEADER || env.MAGCLAW_PERF_AUTHORIZATION || env.MAGCLAW_PERF_BEARER_TOKEN),
    extraHeaderNames: [],
  };
  if (env.MAGCLAW_PERF_COOKIE) {
    headers.cookie = assertSafeHeaderValue(env.MAGCLAW_PERF_COOKIE, 'Cookie');
  }
  const authorization = env.MAGCLAW_PERF_AUTH_HEADER
    || env.MAGCLAW_PERF_AUTHORIZATION
    || (env.MAGCLAW_PERF_BEARER_TOKEN ? `Bearer ${env.MAGCLAW_PERF_BEARER_TOKEN}` : '');
  if (authorization) {
    headers.authorization = assertSafeHeaderValue(authorization, 'Authorization');
  }
  if (env.MAGCLAW_PERF_EXTRA_HEADERS) {
    let extra;
    try {
      extra = JSON.parse(env.MAGCLAW_PERF_EXTRA_HEADERS);
    } catch (error) {
      throw new Error(`MAGCLAW_PERF_EXTRA_HEADERS must be a JSON object: ${error.message}`);
    }
    if (!extra || typeof extra !== 'object' || Array.isArray(extra)) {
      throw new Error('MAGCLAW_PERF_EXTRA_HEADERS must be a JSON object');
    }
    for (const [rawName, rawValue] of Object.entries(extra)) {
      const name = normalizeHeaderName(rawName);
      if (!name) continue;
      headers[name] = assertSafeHeaderValue(rawValue, rawName);
      summary.extraHeaderNames.push(name);
    }
  }
  summary.extraHeaderNames.sort();
  return { headers, summary };
}

function redactError(error) {
  return {
    name: String(error?.name || 'Error'),
    message: String(error?.message || error || 'Unknown error').replace(/\s+/g, ' ').slice(0, 400),
    code: error?.code ? String(error.code) : undefined,
  };
}

function normalizeBaseUrl(value) {
  const text = String(value || '').trim();
  if (!text) throw new Error('A base URL is required. Pass --base-url or MAGCLAW_PERF_BASE_URL.');
  const url = new URL(text);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Unsupported protocol for ${url.href}`);
  }
  url.username = '';
  url.password = '';
  url.hash = '';
  url.search = '';
  return url;
}

function joinBasePath(baseUrl, pathWithSearch) {
  const target = new URL(baseUrl.href);
  const next = new URL(pathWithSearch, 'http://magclaw.local');
  const prefix = target.pathname.replace(/\/+$/, '');
  const suffix = next.pathname.startsWith('/') ? next.pathname : `/${next.pathname}`;
  target.pathname = `${prefix}${suffix}` || '/';
  target.search = next.search;
  target.hash = '';
  return target;
}

export function buildBootstrapPath(options = {}) {
  const params = new URLSearchParams();
  params.set('spaceType', options.spaceType || DEFAULTS.spaceType);
  params.set('spaceId', options.spaceId || DEFAULTS.spaceId);
  params.set('messageLimit', String(options.messageLimit || DEFAULTS.messageLimit));
  params.set('threadRootLimit', String(options.threadRootLimit || DEFAULTS.threadRootLimit));
  params.set('directoryFormat', 'tuple-v1');
  params.set('directoryScope', 'visible');
  if (options.threadMessageId) params.set('threadMessageId', options.threadMessageId);
  return `/api/bootstrap?${params.toString()}`;
}

export function buildEventsPath(options = {}) {
  const params = new URLSearchParams();
  params.set('spaceType', options.spaceType || DEFAULTS.spaceType);
  params.set('spaceId', options.spaceId || DEFAULTS.spaceId);
  params.set('messageLimit', String(options.messageLimit || DEFAULTS.messageLimit));
  params.set('threadRootLimit', String(options.threadRootLimit || DEFAULTS.threadRootLimit));
  params.set('presence', 'defer');
  if (options.threadMessageId) params.set('threadMessageId', options.threadMessageId);
  return `/api/events?${params.toString()}`;
}

function pickHeaders(headers = {}) {
  return {
    contentType: headers['content-type'] || '',
    contentEncoding: headers['content-encoding'] || '',
    cacheControl: headers['cache-control'] || '',
    serverTiming: headers['server-timing'] || '',
    xRequestId: headers['x-request-id'] || headers['x-correlation-id'] || '',
  };
}

function maybeDecodeBody(buffer, encoding) {
  const normalized = String(encoding || '').toLowerCase().split(',')[0].trim();
  if (!normalized || normalized === 'identity') return buffer;
  if (normalized === 'gzip' || normalized === 'x-gzip') return gunzipSync(buffer);
  if (normalized === 'br') return brotliDecompressSync(buffer);
  if (normalized === 'deflate') return inflateSync(buffer);
  return null;
}

function countArray(value) {
  return Array.isArray(value) ? value.length : undefined;
}

export function summarizeJsonBody(buffer, headers = {}) {
  const encoding = headers['content-encoding'] || '';
  let decoded;
  try {
    decoded = maybeDecodeBody(buffer, encoding);
  } catch (error) {
    return {
      decoded: false,
      decodedBytes: 0,
      json: false,
      error: `decode_failed:${error.message}`,
    };
  }
  if (!decoded) {
    return {
      decoded: false,
      decodedBytes: 0,
      json: false,
      error: `unsupported_encoding:${encoding}`,
    };
  }
  const text = decoded.toString('utf8');
  const contentType = String(headers['content-type'] || '').toLowerCase();
  const likelyJson = contentType.includes('json') || /^[\s\n\r]*[{[]/.test(text);
  if (!likelyJson) {
    return {
      decoded: true,
      decodedBytes: Buffer.byteLength(text, 'utf8'),
      json: false,
    };
  }
  try {
    const value = JSON.parse(text);
    const collections = {};
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const key of JSON_COLLECTION_KEYS) {
        const size = countArray(value[key]);
        if (size !== undefined) collections[key] = size;
      }
      const cloudMembers = countArray(value.cloud?.members);
      if (cloudMembers !== undefined) collections.cloudMembers = cloudMembers;
    }
    return {
      decoded: true,
      decodedBytes: Buffer.byteLength(text, 'utf8'),
      json: true,
      collections,
      bootstrap: value?.bootstrap && typeof value.bootstrap === 'object' ? {
        directoryFormat: value.bootstrap.directoryFormat || '',
        directoryScope: value.bootstrap.directory?.scope || '',
        hasMoreMessages: Boolean(value.bootstrap.hasMoreMessages),
        unreadHydration: value.bootstrap.unreadHydration ? {
          included: value.bootstrap.unreadHydration.included,
          truncated: Boolean(value.bootstrap.unreadHydration.truncated),
        } : null,
        tasks: value.bootstrap.tasks ? {
          spaceHasMore: Boolean(value.bootstrap.tasks.space?.hasMore),
          globalHasMore: Boolean(value.bootstrap.tasks.global?.hasMore),
        } : null,
      } : null,
    };
  } catch (error) {
    return {
      decoded: true,
      decodedBytes: Buffer.byteLength(text, 'utf8'),
      json: false,
      error: `json_parse_failed:${error.message}`,
    };
  }
}

export function requestRaw(targetUrl, options = {}) {
  const url = targetUrl instanceof URL ? targetUrl : new URL(targetUrl);
  const client = url.protocol === 'https:' ? https : http;
  const headers = options.headers || {};
  const timeoutMs = numberOption(options.timeoutMs, DEFAULTS.timeoutMs, 'timeoutMs');
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const req = client.request(url, {
      method: options.method || 'GET',
      headers,
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers || {},
          bytes: body.length,
          body,
          ms: Math.round(performance.now() - started),
        });
      });
    });
    req.on('timeout', () => req.destroy(new Error(`request_timeout_after_${timeoutMs}ms`)));
    req.on('error', reject);
    req.end();
  });
}

export function createSseEventCounter() {
  const state = {
    buffer: '',
    eventName: '',
    dataLines: [],
    counts: {},
    dataBytesByEvent: {},
    comments: 0,
    frames: 0,
  };

  function flushEvent() {
    if (!state.eventName && state.dataLines.length === 0) return;
    const eventName = state.eventName || 'message';
    const data = state.dataLines.join('\n');
    state.counts[eventName] = (state.counts[eventName] || 0) + 1;
    state.dataBytesByEvent[eventName] = (state.dataBytesByEvent[eventName] || 0) + Buffer.byteLength(data, 'utf8');
    state.frames += 1;
    state.eventName = '';
    state.dataLines = [];
  }

  function handleLine(rawLine) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      flushEvent();
      return;
    }
    if (line.startsWith(':')) {
      state.comments += 1;
      return;
    }
    const colonIndex = line.indexOf(':');
    const field = colonIndex >= 0 ? line.slice(0, colonIndex) : line;
    let value = colonIndex >= 0 ? line.slice(colonIndex + 1) : '';
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      state.eventName = value;
    } else if (field === 'data') {
      state.dataLines.push(value);
    }
  }

  return {
    push(chunk) {
      state.buffer += String(chunk);
      for (;;) {
        const newlineIndex = state.buffer.indexOf('\n');
        if (newlineIndex < 0) break;
        const line = state.buffer.slice(0, newlineIndex);
        state.buffer = state.buffer.slice(newlineIndex + 1);
        handleLine(line);
      }
    },
    finish() {
      if (state.buffer) {
        handleLine(state.buffer);
        state.buffer = '';
      }
      flushEvent();
      return {
        events: { ...state.counts },
        dataBytesByEvent: { ...state.dataBytesByEvent },
        comments: state.comments,
        frames: state.frames,
      };
    },
  };
}

export function sampleSse(targetUrl, options = {}) {
  const url = targetUrl instanceof URL ? targetUrl : new URL(targetUrl);
  const client = url.protocol === 'https:' ? https : http;
  const headers = options.headers || {};
  const timeoutMs = numberOption(options.timeoutMs, DEFAULTS.timeoutMs, 'timeoutMs');
  const sampleMs = numberOption(options.sseMs, DEFAULTS.sseMs, 'sseMs');
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const counter = createSseEventCounter();
    let bytes = 0;
    let statusCode = 0;
    let responseHeaders = {};
    let responseReceived = false;
    let settled = false;
    let responseRef = null;

    const settle = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(sampleTimer);
      clearTimeout(timeoutTimer);
      if (error && !responseReceived) {
        reject(error);
        return;
      }
      const summary = counter.finish();
      const headersSummary = pickHeaders(responseHeaders);
      resolve({
        statusCode,
        ok: statusCode >= 200 && statusCode < 300 && String(headersSummary.contentType).includes('text/event-stream'),
        ms: Math.round(performance.now() - started),
        bytes,
        headers: headersSummary,
        opened: responseReceived,
        sampledMs: sampleMs,
        ...summary,
      });
    };

    const req = client.request(url, {
      method: 'GET',
      headers,
    }, (res) => {
      responseReceived = true;
      responseRef = res;
      statusCode = res.statusCode || 0;
      responseHeaders = res.headers || {};
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        bytes += Buffer.byteLength(chunk, 'utf8');
        counter.push(chunk);
      });
      res.on('end', () => settle());
      res.on('close', () => settle());
      res.on('error', (error) => settle(error));
    });

    const sampleTimer = setTimeout(() => {
      if (responseRef) responseRef.destroy();
      else req.destroy();
      settle();
    }, sampleMs);
    const timeoutTimer = setTimeout(() => {
      req.destroy(new Error(`sse_timeout_after_${timeoutMs}ms`));
    }, timeoutMs);
    req.on('error', (error) => {
      if (settled) return;
      if (responseReceived) settle();
      else settle(error);
    });
    req.end();
  });
}

function httpSample(name, path, response) {
  const headers = pickHeaders(response.headers);
  return {
    name,
    path,
    statusCode: response.statusCode,
    ok: response.statusCode >= 200 && response.statusCode < 300,
    ms: response.ms,
    bytes: response.bytes,
    headers,
    body: summarizeJsonBody(response.body, response.headers),
  };
}

async function captureSample(name, fn) {
  const started = performance.now();
  try {
    return await fn();
  } catch (error) {
    return {
      name,
      ok: false,
      ms: Math.round(performance.now() - started),
      error: redactError(error),
    };
  }
}

function sampleOk(sample, options = {}) {
  if (!sample || sample.ok === false || sample.error) return false;
  if (options.requireJson && sample.body?.json !== true) return false;
  if (options.requireSse && sample.opened !== true) return false;
  return true;
}

export async function collectEnvironmentPerformance(rawOptions = {}) {
  const env = rawOptions.env || process.env;
  const baseUrl = normalizeBaseUrl(rawOptions.baseUrl || env.MAGCLAW_PERF_BASE_URL);
  const options = {
    spaceType: rawOptions.spaceType || env.MAGCLAW_PERF_SPACE_TYPE || DEFAULTS.spaceType,
    spaceId: rawOptions.spaceId || env.MAGCLAW_PERF_SPACE_ID || DEFAULTS.spaceId,
    threadMessageId: rawOptions.threadMessageId || env.MAGCLAW_PERF_THREAD_MESSAGE_ID || '',
    messageLimit: numberOption(rawOptions.messageLimit ?? env.MAGCLAW_PERF_MESSAGE_LIMIT, DEFAULTS.messageLimit, 'messageLimit'),
    threadRootLimit: numberOption(rawOptions.threadRootLimit ?? env.MAGCLAW_PERF_THREAD_ROOT_LIMIT, DEFAULTS.threadRootLimit, 'threadRootLimit'),
    sseMs: numberOption(rawOptions.sseMs ?? env.MAGCLAW_PERF_SSE_MS, DEFAULTS.sseMs, 'sseMs'),
    timeoutMs: numberOption(rawOptions.timeoutMs ?? env.MAGCLAW_PERF_TIMEOUT_MS, DEFAULTS.timeoutMs, 'timeoutMs'),
  };
  const { headers: authHeaders, summary: auth } = authHeadersFromEnv(env);
  const commonHeaders = {
    'user-agent': 'MagClaw environment performance smoke',
    ...authHeaders,
  };
  const readyzPath = '/api/readyz';
  const bootstrapPath = buildBootstrapPath(options);
  const eventsPath = buildEventsPath(options);

  const readyz = await captureSample('readyz', async () => httpSample(
    'readyz',
    readyzPath,
    await requestRaw(joinBasePath(baseUrl, readyzPath), {
      timeoutMs: options.timeoutMs,
      headers: { ...commonHeaders, accept: 'application/json' },
    }),
  ));

  const bootstrap = await captureSample('bootstrap', async () => httpSample(
    'bootstrap',
    bootstrapPath,
    await requestRaw(joinBasePath(baseUrl, bootstrapPath), {
      timeoutMs: options.timeoutMs,
      headers: { ...commonHeaders, accept: 'application/json', 'accept-encoding': 'identity' },
    }),
  ));

  const bootstrapCompressed = await captureSample('bootstrapCompressed', async () => httpSample(
    'bootstrapCompressed',
    bootstrapPath,
    await requestRaw(joinBasePath(baseUrl, bootstrapPath), {
      timeoutMs: options.timeoutMs,
      headers: { ...commonHeaders, accept: 'application/json', 'accept-encoding': 'br, gzip, deflate' },
    }),
  ));

  const sse = await captureSample('sse', async () => ({
    name: 'sse',
    path: eventsPath,
    ...(await sampleSse(joinBasePath(baseUrl, eventsPath), {
      timeoutMs: options.timeoutMs,
      sseMs: options.sseMs,
      headers: {
        ...commonHeaders,
        accept: 'text/event-stream',
        'cache-control': 'no-cache',
      },
    })),
  }));

  const samples = {
    readyz,
    bootstrap,
    bootstrapCompressed,
    sse,
  };
  const checks = {
    readyz: sampleOk(readyz, { requireJson: true }),
    bootstrap: sampleOk(bootstrap, { requireJson: true }),
    bootstrapCompressed: sampleOk(bootstrapCompressed, { requireJson: true }),
    sse: sampleOk(sse, { requireSse: true }),
  };
  return {
    ok: Object.values(checks).every(Boolean),
    generatedAt: new Date().toISOString(),
    target: {
      origin: baseUrl.origin,
      pathPrefix: baseUrl.pathname === '/' ? '' : baseUrl.pathname.replace(/\/+$/, ''),
      spaceType: options.spaceType,
      spaceId: options.spaceId,
      threadMessageId: options.threadMessageId || '',
      messageLimit: options.messageLimit,
      threadRootLimit: options.threadRootLimit,
      sseMs: options.sseMs,
    },
    auth,
    checks,
    samples,
  };
}

export function parseEnvironmentPerfArgs(argv = process.argv.slice(2), env = process.env) {
  const options = {
    baseUrl: env.MAGCLAW_PERF_BASE_URL || '',
    spaceType: env.MAGCLAW_PERF_SPACE_TYPE || DEFAULTS.spaceType,
    spaceId: env.MAGCLAW_PERF_SPACE_ID || DEFAULTS.spaceId,
    threadMessageId: env.MAGCLAW_PERF_THREAD_MESSAGE_ID || '',
    messageLimit: env.MAGCLAW_PERF_MESSAGE_LIMIT || DEFAULTS.messageLimit,
    threadRootLimit: env.MAGCLAW_PERF_THREAD_ROOT_LIMIT || DEFAULTS.threadRootLimit,
    sseMs: env.MAGCLAW_PERF_SSE_MS || DEFAULTS.sseMs,
    timeoutMs: env.MAGCLAW_PERF_TIMEOUT_MS || DEFAULTS.timeoutMs,
    allowHttpError: boolEnv(env.MAGCLAW_PERF_ALLOW_HTTP_ERROR),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const readValue = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === '--base-url') options.baseUrl = readValue();
    else if (arg === '--space-type') options.spaceType = readValue();
    else if (arg === '--space-id') options.spaceId = readValue();
    else if (arg === '--thread-message-id') options.threadMessageId = readValue();
    else if (arg === '--message-limit') options.messageLimit = readValue();
    else if (arg === '--thread-root-limit') options.threadRootLimit = readValue();
    else if (arg === '--sse-ms') options.sseMs = readValue();
    else if (arg === '--timeout-ms') options.timeoutMs = readValue();
    else if (arg === '--allow-http-error') options.allowHttpError = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log(`Usage: npm run perf:environment -- --base-url <url> [options]

Options:
  --space-type <type>          Selected space type, default channel
  --space-id <id>              Selected space id, default chan_all
  --thread-message-id <id>     Optional selected thread id
  --message-limit <n>          Bootstrap/SSE message limit, default 80
  --thread-root-limit <n>      Bootstrap/SSE thread root limit, default 160
  --sse-ms <n>                 SSE sample window in ms, default 3000
  --timeout-ms <n>             Per-request timeout in ms, default 10000
  --allow-http-error           Emit JSON but exit 0 even when checks fail

Environment:
  MAGCLAW_PERF_BASE_URL        Base URL when --base-url is omitted
  MAGCLAW_PERF_COOKIE          Cookie header for authenticated environments
  MAGCLAW_PERF_AUTH_HEADER     Authorization header for authenticated environments
  MAGCLAW_PERF_BEARER_TOKEN    Bearer token alternative
  MAGCLAW_PERF_EXTRA_HEADERS   JSON object of extra request headers
`);
}

async function main() {
  const options = parseEnvironmentPerfArgs();
  if (options.help) {
    printHelp();
    return;
  }
  const result = await collectEnvironmentPerformance(options);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok && !options.allowHttpError) process.exitCode = 1;
}

const invokedAsScript = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsScript) {
  main().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exitCode = 1;
  });
}
