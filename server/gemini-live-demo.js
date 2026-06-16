import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, Modality, Type } from '@google/genai';
import { WebSocket, WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const DEFAULT_ENV_FILE = path.join(ROOT, 'scripts', 'gemini-live.env.local');
const DEFAULT_VERTEX_SECRET_PATH = '/var/run/secrets/vertex';
const DEFAULT_HOST = '0.0.0.0';
const DEFAULT_PORT = 8787;
const DEFAULT_MODEL = 'gemini-live-2.5-flash-native-audio';
const INPUT_SAMPLE_RATE = 16_000;
const OUTPUT_SAMPLE_RATE = 24_000;
const MAX_SEARCH_RESULTS = 5;
const CREDENTIAL_FILE_CANDIDATES = [
  'service-account.json',
  'service_account.json',
  'google-credentials.json',
  'credentials.json',
  'vertex.json',
  'key.json',
  'gemini-live-service-account.local.json',
];

const SYSTEM_INSTRUCTION = `
You are a realtime bilingual voice demo host for MagClaw's Gemini Live demo page.
Detect Chinese or English automatically and reply in the user's language.

This demo must not expose local machine details. Never ask for, reveal, infer, or summarize
the host computer name, usernames, local file paths, running processes, network addresses,
secrets, tokens, browser tabs, or local app state. If the user asks for local-machine data,
explain briefly that this demo only exposes safe sample tools.

You can use these safe tools:
1. get_weather: weather lookup by city. If the city is missing, ask which city.
2. google_search: online Google search. Use it when the user asks to search, look up,
   research, or find current information. Summarize the top results in two or three short
   spoken sentences and mention that it is a web summary.
3. lookup_demo_ticket: deterministic mock ticket data. Use it for testing structured
   business-function calls without touching real systems.

Default to Mainland Mandarin Chinese unless the user is clearly speaking English. In a
Chinese conversation, treat very short isolated English-looking fragments as possible ASR
noise. Ask the user to repeat instead of turning an unclear word into a search query.
Do not call google_search for greetings, chitchat, one-word ambiguous utterances, or unclear
transcripts. Only search when the user explicitly asks to search, look up, Google, find
current information, or research a topic.

Voice style: relaxed, concise, and conversational. Do not sound like a scripted support bot.
For Chinese output, use natural Mainland Mandarin phrasing and short sentences. After using
a tool, report only the useful result, not the raw JSON.
`.trim();

const GEMINI_LIVE_VOICES = [
  { name: 'Zephyr', style: 'Bright', label: '明亮' },
  { name: 'Puck', style: 'Upbeat', label: '轻快' },
  { name: 'Charon', style: 'Informative', label: '信息型' },
  { name: 'Kore', style: 'Firm', label: '坚定' },
  { name: 'Fenrir', style: 'Excitable', label: '兴奋' },
  { name: 'Leda', style: 'Youthful', label: '年轻' },
  { name: 'Orus', style: 'Firm', label: '坚定' },
  { name: 'Aoede', style: 'Breezy', label: '轻松' },
  { name: 'Callirrhoe', style: 'Easy-going', label: '随和' },
  { name: 'Autonoe', style: 'Bright', label: '明亮' },
  { name: 'Enceladus', style: 'Breathy', label: '气声' },
  { name: 'Iapetus', style: 'Clear', label: '清晰' },
  { name: 'Umbriel', style: 'Easy-going', label: '随和' },
  { name: 'Algieba', style: 'Smooth', label: '顺滑' },
  { name: 'Despina', style: 'Smooth', label: '顺滑' },
  { name: 'Erinome', style: 'Clear', label: '清晰' },
  { name: 'Algenib', style: 'Gravelly', label: '颗粒感' },
  { name: 'Rasalgethi', style: 'Informative', label: '信息型' },
  { name: 'Laomedeia', style: 'Upbeat', label: '轻快' },
  { name: 'Achernar', style: 'Soft', label: '柔和' },
  { name: 'Alnilam', style: 'Firm', label: '坚定' },
  { name: 'Schedar', style: 'Even', label: '平稳' },
  { name: 'Gacrux', style: 'Mature', label: '成熟' },
  { name: 'Pulcherrima', style: 'Forward', label: '直接' },
  { name: 'Achird', style: 'Friendly', label: '友好' },
  { name: 'Zubenelgenubi', style: 'Casual', label: '随意' },
  { name: 'Vindemiatrix', style: 'Gentle', label: '温和' },
  { name: 'Sadachbia', style: 'Lively', label: '活泼' },
  { name: 'Sadaltager', style: 'Knowledgeable', label: '知识型' },
  { name: 'Sulafat', style: 'Warm', label: '温暖' },
];

const DEFAULT_VOICE_NAME = 'Kore';
const demoTasks = new Map();

function parseArgs(argv) {
  const args = {
    envFile: DEFAULT_ENV_FILE,
    host: process.env.GEMINI_LIVE_DEMO_HOST || DEFAULT_HOST,
    port: Number(process.env.GEMINI_LIVE_DEMO_PORT || DEFAULT_PORT),
    httpsKey: process.env.GEMINI_LIVE_DEMO_HTTPS_KEY || '',
    httpsCert: process.env.GEMINI_LIVE_DEMO_HTTPS_CERT || '',
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--env') args.envFile = next();
    else if (arg === '--host') args.host = next();
    else if (arg === '--port') args.port = Number(next());
    else if (arg === '--https-key') args.httpsKey = next();
    else if (arg === '--https-cert') args.httpsCert = next();
    else throw new Error(`Unknown option: ${arg}`);
  }

  return args;
}

function usage() {
  console.log(`Usage:
  node scripts/gemini-live-web-demo.mjs
  npm run gemini-live:web

Setup:
  cp scripts/gemini-live.env.example scripts/gemini-live.env.local
  # Fill GOOGLE_APPLICATION_CREDENTIALS and GOOGLE_CLOUD_PROJECT.

Options:
  --host <host>   Bind host, default ${DEFAULT_HOST}.
  --port <port>   Local web port, default ${DEFAULT_PORT}.
  --env <path>    Env file, default scripts/gemini-live.env.local.
  --https-key <path>
                  Optional HTTPS private key path for LAN microphone demos.
  --https-cert <path>
                  Optional HTTPS certificate path for LAN microphone demos.
`);
}

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Put it in ${DEFAULT_ENV_FILE} or export it.`);
  return value;
}

function safeStat(filePath = '') {
  try {
    return statSync(filePath);
  } catch {
    return null;
  }
}

function isReadableFile(filePath = '') {
  return Boolean(filePath && safeStat(filePath)?.isFile());
}

function isReadableDirectory(filePath = '') {
  return Boolean(filePath && safeStat(filePath)?.isDirectory());
}

function resolveCredentialFileFromDirectory(dirPath = '') {
  if (!isReadableDirectory(dirPath)) return '';
  for (const filename of CREDENTIAL_FILE_CANDIDATES) {
    const candidate = path.join(dirPath, filename);
    if (isReadableFile(candidate)) return candidate;
  }
  try {
    const jsonFiles = readdirSync(dirPath)
      .filter((name) => /^[^./][^/]*\.json$/i.test(name))
      .map((name) => path.join(dirPath, name))
      .filter(isReadableFile);
    if (jsonFiles.length === 1) return jsonFiles[0];
  } catch {
    // Best effort discovery; callers surface a clean configuration error.
  }
  return '';
}

function resolveCredentialsPath(env = process.env) {
  const explicit = [
    env.GOOGLE_APPLICATION_CREDENTIALS,
    env.GEMINI_LIVE_GOOGLE_APPLICATION_CREDENTIALS,
    env.MAGCLAW_VERTEX_CREDENTIALS,
    env.MAGCLAW_VERTEX_CREDENTIALS_PATH,
  ].map((value) => String(value || '').trim()).find(Boolean);
  if (explicit) {
    if (isReadableFile(explicit)) return explicit;
    if (isReadableDirectory(explicit)) return resolveCredentialFileFromDirectory(explicit) || explicit;
    return explicit;
  }

  const mountPath = String(env.MAGCLAW_VERTEX_SECRET_PATH || DEFAULT_VERTEX_SECRET_PATH).trim();
  if (isReadableFile(mountPath)) return mountPath;
  return resolveCredentialFileFromDirectory(mountPath);
}

function credentialProjectId(credentialsPath = '') {
  if (!isReadableFile(credentialsPath)) return '';
  try {
    const data = JSON.parse(readFileSync(credentialsPath, 'utf8'));
    return String(data?.project_id || '').trim();
  } catch {
    return '';
  }
}

function numberFromEnv(name, fallback, options = {}) {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value)) return fallback;
  if (options.min !== undefined && value < options.min) return fallback;
  if (options.max !== undefined && value > options.max) return fallback;
  return value;
}

function voiceNames() {
  return new Set(GEMINI_LIVE_VOICES.map((voice) => voice.name));
}

function normalizeVoiceName(value) {
  const raw = String(value || process.env.GEMINI_LIVE_DEMO_VOICE || DEFAULT_VOICE_NAME).trim();
  return voiceNames().has(raw) ? raw : DEFAULT_VOICE_NAME;
}

function normalizeSystemInstruction(value) {
  const text = String(value || '').trim();
  if (!text) return process.env.GEMINI_LIVE_DEMO_SYSTEM_INSTRUCTION || SYSTEM_INSTRUCTION;
  return text.slice(0, 12_000);
}

function getLanAddresses(port, protocol) {
  const urls = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      urls.push(`${protocol}://${entry.address}:${port}`);
    }
  }
  return urls;
}

function jsonResponse(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendWsJson(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function makeAudioPayload(pcmChunk) {
  return {
    data: pcmChunk.toString('base64'),
    mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`,
  };
}

function isNativeAudioModel(model) {
  return /native-audio/.test(model || '');
}

function getConfig(args) {
  process.env.GOOGLE_GENAI_USE_VERTEXAI ||= 'true';
  const credentialsPath = resolveCredentialsPath();
  if (!existsSync(credentialsPath)) {
    throw new Error(
      `Gemini Live credentials were not found. Set GOOGLE_APPLICATION_CREDENTIALS or mount a Vertex secret at ${DEFAULT_VERTEX_SECRET_PATH}.`,
    );
  }
  if (isReadableFile(credentialsPath)) {
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||= credentialsPath;
  }
  const model = process.env.GEMINI_LIVE_MODEL || DEFAULT_MODEL;
  const hasHttpsConfig = Boolean(args.httpsKey || args.httpsCert);
  if (hasHttpsConfig) {
    if (!args.httpsKey || !args.httpsCert) {
      throw new Error('Both --https-key and --https-cert are required for HTTPS mode.');
    }
    if (!existsSync(args.httpsKey)) throw new Error(`HTTPS key does not exist: ${args.httpsKey}`);
    if (!existsSync(args.httpsCert)) throw new Error(`HTTPS cert does not exist: ${args.httpsCert}`);
  }

  return {
    credentialsPath,
    project: process.env.GOOGLE_CLOUD_PROJECT || credentialProjectId(credentialsPath),
    location:
      process.env.GOOGLE_CLOUD_LOCATION || (isNativeAudioModel(model) ? 'us-central1' : 'global'),
    model,
    host: args.host,
    port: args.port,
    protocol: hasHttpsConfig ? 'https' : 'http',
    tls: hasHttpsConfig
      ? {
          key: readFileSync(args.httpsKey),
          cert: readFileSync(args.httpsCert),
        }
      : null,
  };
}

function publicConfigFromEnv(overrides = {}) {
  loadEnvFile(String(overrides.envFile || process.env.GEMINI_LIVE_ENV_FILE || DEFAULT_ENV_FILE).trim());
  const model = process.env.GEMINI_LIVE_MODEL || DEFAULT_MODEL;
  const credentialsPath = resolveCredentialsPath();
  return {
    credentialsPath,
    credentialsConfigured: isReadableFile(credentialsPath),
    project: process.env.GOOGLE_CLOUD_PROJECT || credentialProjectId(credentialsPath),
    location:
      process.env.GOOGLE_CLOUD_LOCATION || (isNativeAudioModel(model) ? 'us-central1' : 'global'),
    model,
    host: overrides.host || DEFAULT_HOST,
    port: Number(overrides.port || DEFAULT_PORT),
    protocol: overrides.protocol || 'http',
    tls: null,
  };
}

export function resolveGeminiLiveDemoConfig(options = {}) {
  const envFile = String(options.envFile || process.env.GEMINI_LIVE_ENV_FILE || DEFAULT_ENV_FILE).trim();
  loadEnvFile(envFile);
  const config = getConfig({
    host: options.host || DEFAULT_HOST,
    port: Number(options.port || DEFAULT_PORT),
    httpsKey: options.httpsKey || '',
    httpsCert: options.httpsCert || '',
  });
  if (!config.project) {
    throw new Error('Missing GOOGLE_CLOUD_PROJECT and no project_id was found in the Vertex credentials JSON.');
  }
  return config;
}

function getToolDeclarations() {
  return [
    {
      name: 'get_weather',
      description:
        'Look up current weather for a named city. If the user did not provide a city, ask for the city before calling this function.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          city: {
            type: Type.STRING,
            description: 'City name, for example 北京, 上海, Tokyo, San Francisco.',
          },
        },
        required: ['city'],
      },
    },
    {
      name: 'google_search',
      description:
        'Search Google for public web information and return a compact set of titles, snippets, and URLs.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          query: {
            type: Type.STRING,
            description: 'The search query.',
          },
          language: {
            type: Type.STRING,
            description: 'Optional language hint such as zh-CN or en-US.',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'lookup_demo_ticket',
      description:
        'Look up a deterministic mock support ticket. This never touches real business systems and is safe for function-call demos.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          ticket_id: {
            type: Type.STRING,
            description: 'Demo ticket id, for example DEMO-1001 or DEMO-1002.',
          },
        },
        required: ['ticket_id'],
      },
    },
    {
      name: 'calculate_expression',
      description:
        'Calculate a simple arithmetic expression. Use this for math tests such as percentages, addition, multiplication, and parentheses.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          expression: {
            type: Type.STRING,
            description: 'Arithmetic expression using numbers and + - * / % ^ ( ). Example: (128 + 256) * 0.8',
          },
        },
        required: ['expression'],
      },
    },
    {
      name: 'convert_units',
      description:
        'Convert common demo units: temperature, length, weight, and volume. Use when the user asks to convert units.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          value: {
            type: Type.NUMBER,
            description: 'Numeric value to convert.',
          },
          from_unit: {
            type: Type.STRING,
            description: 'Source unit, for example c, f, km, m, cm, mi, ft, kg, g, lb, l, ml.',
          },
          to_unit: {
            type: Type.STRING,
            description: 'Target unit, for example c, f, km, m, cm, mi, ft, kg, g, lb, l, ml.',
          },
        },
        required: ['value', 'from_unit', 'to_unit'],
      },
    },
    {
      name: 'random_choice',
      description:
        'Pick one option from a short list. Use for lightweight decision demos.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          options: {
            type: Type.ARRAY,
            description: 'Candidate options.',
            items: { type: Type.STRING },
          },
        },
        required: ['options'],
      },
    },
    {
      name: 'create_demo_task',
      description:
        'Create a mock task in the in-memory demo task list. This is safe and does not write to real task systems.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          title: {
            type: Type.STRING,
            description: 'Task title.',
          },
          assignee: {
            type: Type.STRING,
            description: 'Optional assignee name.',
          },
          priority: {
            type: Type.STRING,
            description: 'Optional priority: low, medium, high.',
          },
        },
        required: ['title'],
      },
    },
    {
      name: 'list_demo_tasks',
      description:
        'List mock tasks created during this demo server process. Use after create_demo_task.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          limit: {
            type: Type.NUMBER,
            description: 'Maximum tasks to return. Default 5.',
          },
        },
      },
    },
    {
      name: 'get_public_holidays',
      description:
        'Get public holidays for a country and year using a public holidays API. Useful for date/planning function-call demos.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          country_code: {
            type: Type.STRING,
            description: 'ISO 3166-1 alpha-2 country code, for example CN, US, JP.',
          },
          year: {
            type: Type.NUMBER,
            description: 'Four-digit year. Default current year.',
          },
        },
        required: ['country_code'],
      },
    },
  ];
}

function makeLiveConfig(sessionOptions = {}) {
  const voiceName = normalizeVoiceName(sessionOptions.voiceName);
  const systemInstruction = normalizeSystemInstruction(sessionOptions.systemInstruction);
  return {
    responseModalities: [Modality.AUDIO],
    systemInstruction: {
      role: 'system',
      parts: [{ text: systemInstruction }],
    },
    speechConfig: {
      voiceConfig: {
        prebuiltVoiceConfig: {
          voiceName,
        },
      },
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    realtimeInputConfig: {
      automaticActivityDetection: {
        disabled: false,
        startOfSpeechSensitivity:
          process.env.GEMINI_LIVE_DEMO_START_SENSITIVITY || 'START_SENSITIVITY_LOW',
        endOfSpeechSensitivity:
          process.env.GEMINI_LIVE_DEMO_END_SENSITIVITY || 'END_SENSITIVITY_LOW',
        prefixPaddingMs: numberFromEnv('GEMINI_LIVE_DEMO_PREFIX_PADDING_MS', 180, {
          min: 0,
          max: 1000,
        }),
        silenceDurationMs: numberFromEnv('GEMINI_LIVE_DEMO_SILENCE_DURATION_MS', 700, {
          min: 100,
          max: 3000,
        }),
      },
      activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
    },
    tools: [{ functionDeclarations: getToolDeclarations() }],
  };
}

function makeMicGateConfig() {
  return {
    idleRms: numberFromEnv('GEMINI_LIVE_DEMO_IDLE_RMS', 0.01, { min: 0, max: 1 }),
    idlePeak: numberFromEnv('GEMINI_LIVE_DEMO_IDLE_PEAK', 0.045, { min: 0, max: 1 }),
    bargeInRms: numberFromEnv('GEMINI_LIVE_DEMO_BARGE_IN_RMS', 0.028, { min: 0, max: 1 }),
    bargeInPeak: numberFromEnv('GEMINI_LIVE_DEMO_BARGE_IN_PEAK', 0.12, { min: 0, max: 1 }),
    startFrames: numberFromEnv('GEMINI_LIVE_DEMO_START_FRAMES', 3, { min: 1, max: 30 }),
    bargeInStartFrames: numberFromEnv('GEMINI_LIVE_DEMO_BARGE_IN_START_FRAMES', 5, {
      min: 1,
      max: 40,
    }),
    holdFrames: numberFromEnv('GEMINI_LIVE_DEMO_HOLD_FRAMES', 16, { min: 0, max: 80 }),
    preRollFrames: numberFromEnv('GEMINI_LIVE_DEMO_PRE_ROLL_FRAMES', 4, { min: 0, max: 30 }),
  };
}

function sanitizeText(value, maxLength = 1600) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function decodeHtml(value) {
  return String(value || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'MagClaw Gemini Live local demo/1.0',
    },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  return response.json();
}

async function getWeather(rawArgs = {}) {
  const city = String(rawArgs.city || '').trim();
  if (!city) return { error: 'city is required' };

  const geoUrl = new URL('https://geocoding-api.open-meteo.com/v1/search');
  geoUrl.searchParams.set('name', city);
  geoUrl.searchParams.set('count', '1');
  geoUrl.searchParams.set('language', 'zh');
  geoUrl.searchParams.set('format', 'json');
  const geo = await fetchJson(geoUrl);
  const place = geo.results?.[0];
  if (!place) {
    return { city, error: 'city_not_found', source: 'Open-Meteo' };
  }

  const weatherUrl = new URL('https://api.open-meteo.com/v1/forecast');
  weatherUrl.searchParams.set('latitude', String(place.latitude));
  weatherUrl.searchParams.set('longitude', String(place.longitude));
  weatherUrl.searchParams.set('current', 'temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code');
  weatherUrl.searchParams.set('timezone', 'auto');
  const weather = await fetchJson(weatherUrl);
  const current = weather.current || {};
  return {
    city,
    resolved_name: [place.name, place.admin1, place.country].filter(Boolean).join(', '),
    temperature_c: current.temperature_2m,
    humidity_percent: current.relative_humidity_2m,
    wind_kmh: current.wind_speed_10m,
    weather_code: current.weather_code,
    observed_at: current.time,
    source: 'Open-Meteo public API',
  };
}

function parseGoogleResults(html) {
  const results = [];
  const blockPattern = /<a href="\/url\?q=([^"&]+)[\s\S]*?<h3[^>]*>([\s\S]*?)<\/h3>([\s\S]*?)(?=<a href="\/url\?q=|<\/body>)/gi;
  let match;
  while ((match = blockPattern.exec(html)) && results.length < MAX_SEARCH_RESULTS) {
    const url = decodeURIComponent(match[1]);
    if (!/^https?:\/\//i.test(url)) continue;
    if (/google\./i.test(new URL(url).hostname)) continue;
    const title = sanitizeText(decodeHtml(match[2]), 160);
    const snippet = sanitizeText(decodeHtml(match[3]), 260);
    if (!title) continue;
    results.push({ title, url, snippet });
  }
  return results;
}

async function googleSearch(rawArgs = {}) {
  const query = String(rawArgs.query || '').trim();
  if (!query) return { error: 'query is required' };
  const language = String(rawArgs.language || 'zh-CN');
  const url = new URL('https://www.google.com/search');
  url.searchParams.set('q', query);
  url.searchParams.set('hl', language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en');
  url.searchParams.set('num', String(MAX_SEARCH_RESULTS));

  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'accept-language': language,
      'user-agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36',
    },
  });
  const html = await response.text();
  if (!response.ok) {
    return {
      query,
      source: 'Google Search',
      error: `google_http_${response.status}`,
      search_url: url.toString(),
    };
  }

  const results = parseGoogleResults(html);
  return {
    query,
    source: 'Google Search',
    search_url: url.toString(),
    count: results.length,
    results,
    note:
      results.length === 0
        ? 'Google returned a page but no result snippets could be parsed. Open the search_url for manual review.'
        : undefined,
  };
}

function lookupDemoTicket(rawArgs = {}) {
  const id = String(rawArgs.ticket_id || '').trim().toUpperCase();
  const tickets = {
    'DEMO-1001': {
      ticket_id: 'DEMO-1001',
      customer: '示例客户 A',
      priority: 'high',
      status: 'triaged',
      summary: '用户希望在本地网页中验证实时语音和函数调用。',
      next_step: '确认麦克风、播放和工具调用日志都能在页面中展示。',
    },
    'DEMO-1002': {
      ticket_id: 'DEMO-1002',
      customer: 'Demo Corp',
      priority: 'medium',
      status: 'waiting_for_user',
      summary: 'Need a concise web search summary during a live voice demo.',
      next_step: 'Ask the user for the topic, then call google_search.',
    },
  };
  return (
    tickets[id] || {
      ticket_id: id || 'unknown',
      status: 'not_found',
      note: 'This is a mock ticket database for safe function-call demos.',
    }
  );
}

function calculateExpression(rawArgs = {}) {
  const expression = String(rawArgs.expression || '').trim();
  if (!expression) return { error: 'expression is required' };
  if (!/^[\d\s+\-*/%.()^]+$/.test(expression)) {
    return { error: 'Only numbers and + - * / % ^ ( ) are allowed in this demo calculator.' };
  }
  const normalized = expression.replace(/\^/g, '**');
  let value;
  try {
    // The expression is character-whitelisted above and runs without scope access.
    value = Function(`"use strict"; return (${normalized});`)();
  } catch (error) {
    return { expression, error: error.message || String(error) };
  }
  if (!Number.isFinite(value)) return { expression, error: 'Result is not a finite number.' };
  return {
    expression,
    result: Number(value.toFixed(10)),
  };
}

const UNIT_GROUPS = {
  temperature: {
    aliases: {
      c: 'c',
      celsius: 'c',
      '°c': 'c',
      f: 'f',
      fahrenheit: 'f',
      '°f': 'f',
      k: 'k',
      kelvin: 'k',
    },
    toBase(value, unit) {
      if (unit === 'c') return value;
      if (unit === 'f') return ((value - 32) * 5) / 9;
      if (unit === 'k') return value - 273.15;
      return null;
    },
    fromBase(value, unit) {
      if (unit === 'c') return value;
      if (unit === 'f') return (value * 9) / 5 + 32;
      if (unit === 'k') return value + 273.15;
      return null;
    },
  },
  length: {
    factors: {
      mm: 0.001,
      cm: 0.01,
      m: 1,
      meter: 1,
      meters: 1,
      km: 1000,
      in: 0.0254,
      inch: 0.0254,
      inches: 0.0254,
      ft: 0.3048,
      foot: 0.3048,
      feet: 0.3048,
      yd: 0.9144,
      mi: 1609.344,
      mile: 1609.344,
    },
  },
  weight: {
    factors: {
      mg: 0.001,
      g: 1,
      gram: 1,
      grams: 1,
      kg: 1000,
      kilogram: 1000,
      kilograms: 1000,
      oz: 28.349523125,
      lb: 453.59237,
      lbs: 453.59237,
      pound: 453.59237,
      pounds: 453.59237,
    },
  },
  volume: {
    factors: {
      ml: 0.001,
      l: 1,
      liter: 1,
      liters: 1,
      cup: 0.2365882365,
      cups: 0.2365882365,
      pint: 0.473176473,
      qt: 0.946352946,
      gallon: 3.785411784,
    },
  },
};

function normalizeUnit(unit) {
  return String(unit || '').trim().toLowerCase();
}

function findUnitGroup(unit) {
  const normalized = normalizeUnit(unit);
  for (const [groupName, group] of Object.entries(UNIT_GROUPS)) {
    if (group.aliases?.[normalized]) return { groupName, unit: group.aliases[normalized], group };
    if (group.factors?.[normalized]) return { groupName, unit: normalized, group };
  }
  return null;
}

function convertUnits(rawArgs = {}) {
  const value = Number(rawArgs.value);
  if (!Number.isFinite(value)) return { error: 'value must be a number' };
  const from = findUnitGroup(rawArgs.from_unit);
  const to = findUnitGroup(rawArgs.to_unit);
  if (!from || !to) {
    return {
      error: 'Unsupported unit.',
      supported_groups: Object.keys(UNIT_GROUPS),
    };
  }
  if (from.groupName !== to.groupName) {
    return { error: `Cannot convert ${from.groupName} to ${to.groupName}.` };
  }

  let result;
  if (from.groupName === 'temperature') {
    result = from.group.fromBase(from.group.toBase(value, from.unit), to.unit);
  } else {
    const base = value * from.group.factors[from.unit];
    result = base / to.group.factors[to.unit];
  }

  return {
    value,
    from_unit: from.unit,
    to_unit: to.unit,
    group: from.groupName,
    result: Number(result.toFixed(6)),
  };
}

function randomChoice(rawArgs = {}) {
  const options = Array.isArray(rawArgs.options)
    ? rawArgs.options.map((item) => String(item).trim()).filter(Boolean).slice(0, 20)
    : [];
  if (options.length === 0) return { error: 'options must contain at least one item' };
  const index = Math.floor(Math.random() * options.length);
  return {
    options,
    selected: options[index],
    index,
  };
}

function createDemoTask(rawArgs = {}) {
  const title = String(rawArgs.title || '').trim().slice(0, 160);
  if (!title) return { error: 'title is required' };
  const id = `TASK-${String(demoTasks.size + 1).padStart(4, '0')}`;
  const task = {
    id,
    title,
    assignee: String(rawArgs.assignee || 'unassigned').trim().slice(0, 80),
    priority: ['low', 'medium', 'high'].includes(String(rawArgs.priority || '').toLowerCase())
      ? String(rawArgs.priority).toLowerCase()
      : 'medium',
    status: 'open',
    created_at: new Date().toISOString(),
  };
  demoTasks.set(id, task);
  return task;
}

function listDemoTasks(rawArgs = {}) {
  const limit = Math.min(Math.max(Number(rawArgs.limit) || 5, 1), 20);
  return {
    count: demoTasks.size,
    tasks: [...demoTasks.values()].slice(-limit).reverse(),
  };
}

async function getPublicHolidays(rawArgs = {}) {
  const countryCode = String(rawArgs.country_code || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(countryCode)) return { error: 'country_code must be a two-letter country code' };
  const year = Number(rawArgs.year) || new Date().getFullYear();
  if (!Number.isInteger(year) || year < 1970 || year > 2100) return { error: 'year must be between 1970 and 2100' };
  const url = `https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode}`;
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'MagClaw Gemini Live local demo/1.0',
    },
  });
  if (!response.ok) {
    return { country_code: countryCode, year, error: `holiday_http_${response.status}` };
  }
  const holidays = await response.json();
  return {
    country_code: countryCode,
    year,
    count: holidays.length,
    holidays: holidays.slice(0, 12).map((holiday) => ({
      date: holiday.date,
      local_name: holiday.localName,
      name: holiday.name,
    })),
  };
}

async function runDemoTool(name, args) {
  if (name === 'get_weather') return getWeather(args);
  if (name === 'google_search') return googleSearch(args);
  if (name === 'lookup_demo_ticket') return lookupDemoTicket(args);
  if (name === 'calculate_expression') return calculateExpression(args);
  if (name === 'convert_units') return convertUnits(args);
  if (name === 'random_choice') return randomChoice(args);
  if (name === 'create_demo_task') return createDemoTask(args);
  if (name === 'list_demo_tasks') return listDemoTasks(args);
  if (name === 'get_public_holidays') return getPublicHolidays(args);
  return { error: `Unknown tool: ${name}` };
}

function extractAudioParts(message) {
  const parts = message.serverContent?.modelTurn?.parts || [];
  const chunks = [];
  for (const part of parts) {
    const inlineData = part.inlineData;
    if (inlineData?.data && inlineData?.mimeType?.startsWith('audio/')) {
      chunks.push(inlineData.data);
    }
  }
  return chunks;
}

function extractTextParts(message) {
  const parts = message.serverContent?.modelTurn?.parts || [];
  return parts.map((part) => part.text).filter(Boolean);
}

async function createGeminiSession(ws, config, sessionOptions = {}) {
  let session = null;
  let closed = false;
  const voiceName = normalizeVoiceName(sessionOptions.voiceName);
  const client = new GoogleGenAI({
    vertexai: true,
    project: config.project,
    location: config.location,
  });

  const close = () => {
    if (closed) return;
    closed = true;
    try {
      session?.close?.();
    } catch {
      // best effort
    }
  };

  session = await client.live.connect({
    model: config.model,
    config: makeLiveConfig({ ...sessionOptions, voiceName }),
    callbacks: {
      onopen: () => {
        console.info('[GeminiLiveDemo] session opened');
        sendWsJson(ws, {
          type: 'ready',
          model: config.model,
          voiceName,
          outputSampleRate: OUTPUT_SAMPLE_RATE,
          tools: publicToolCards(),
        });
      },
      onmessage: (message) => {
        if (message.setupComplete) {
          sendWsJson(ws, { type: 'setup_complete', sessionId: message.setupComplete.sessionId || null });
        }
        if (message.serverContent?.inputTranscription?.text) {
          sendWsJson(ws, { type: 'input_transcript', text: message.serverContent.inputTranscription.text });
        }
        if (message.serverContent?.outputTranscription?.text) {
          sendWsJson(ws, { type: 'output_transcript', text: message.serverContent.outputTranscription.text });
        }
        if (message.serverContent?.interrupted) {
          sendWsJson(ws, { type: 'interrupted' });
        }
        if (message.serverContent?.generationComplete) {
          sendWsJson(ws, { type: 'generation_complete' });
        }
        if (message.serverContent?.turnComplete) {
          sendWsJson(ws, { type: 'turn_complete' });
        }
        if (message.voiceActivityDetectionSignal || message.voiceActivity) {
          sendWsJson(ws, {
            type: 'voice_activity',
            signal: message.voiceActivityDetectionSignal || message.voiceActivity,
          });
        }
        if (message.usageMetadata) {
          sendWsJson(ws, { type: 'usage', usage: message.usageMetadata });
        }

        for (const text of extractTextParts(message)) {
          sendWsJson(ws, { type: 'text', text });
        }
        for (const audio of extractAudioParts(message)) {
          sendWsJson(ws, { type: 'audio', audio, sampleRate: OUTPUT_SAMPLE_RATE });
        }

        const calls = message.toolCall?.functionCalls || [];
        for (const call of calls) {
          const name = call.name || 'unknown';
          const callArgs = call.args || {};
          sendWsJson(ws, {
            type: 'tool_call',
            id: call.id || null,
            name,
            args: callArgs,
          });
          void (async () => {
            let output;
            try {
              output = await runDemoTool(name, callArgs);
            } catch (error) {
              output = { error: error.message || String(error) };
            }
            sendWsJson(ws, {
              type: 'tool_result',
              id: call.id || null,
              name,
              result: output,
            });
            try {
              session.sendToolResponse({
                functionResponses: [
                  {
                    id: call.id,
                    name,
                    response: { output },
                  },
                ],
              });
            } catch (error) {
              sendWsJson(ws, { type: 'error', message: `Tool response failed: ${error.message || error}` });
            }
          })();
        }
      },
      onerror: (error) => {
        console.error('[GeminiLiveDemo] Live error:', error?.message || error);
        sendWsJson(ws, { type: 'error', message: error?.message || String(error) });
      },
      onclose: (event) => {
        console.info('[GeminiLiveDemo] session closed', event?.code, event?.reason || '');
        sendWsJson(ws, {
          type: 'closed',
          code: event?.code ?? null,
          reason: event?.reason || '',
        });
        close();
      },
    },
  });

  return {
    sendAudio(chunk) {
      if (closed || !session) return;
      session.sendRealtimeInput({ audio: makeAudioPayload(chunk) });
    },
    sendEnd() {
      if (closed || !session) return;
      session.sendRealtimeInput({ audioStreamEnd: true });
    },
    close,
  };
}

function publicToolCards() {
  return [
    {
      name: 'get_weather',
      label: '天气查询',
      description: '按城市查询公开天气数据；如果没有城市，模型会先追问。',
      example: '帮我查一下杭州今天的天气。',
    },
    {
      name: 'google_search',
      label: '联网搜索',
      description: '用 Google 搜索公开网页，并把结果压缩成语音友好的总结。',
      example: '帮我 Google 一下 Gemini Live 最近支持哪些能力。',
    },
    {
      name: 'lookup_demo_ticket',
      label: '模拟工单',
      description: '查询内置 Mock 工单，演示业务系统 Function Call，不访问真实系统。',
      example: '查一下 DEMO-1001 这个工单现在是什么状态。',
    },
    {
      name: 'calculate_expression',
      label: '计算器',
      description: '计算安全的四则运算表达式，适合测试数字提取和结构化参数。',
      example: '帮我算一下 128 加 256 再乘以 0.8。',
    },
    {
      name: 'convert_units',
      label: '单位换算',
      description: '支持温度、长度、重量、体积的常用单位换算。',
      example: '把 72 华氏度换算成摄氏度。',
    },
    {
      name: 'random_choice',
      label: '随机选择',
      description: '从几个候选项里随机选一个，适合测试数组参数。',
      example: '从火锅、寿司、沙拉里面随机帮我选一个晚饭。',
    },
    {
      name: 'create_demo_task',
      label: '创建 Mock 任务',
      description: '创建内存里的模拟任务，不访问真实任务系统。',
      example: '创建一个任务：明天上午整理 Gemini Live 测试反馈，优先级高。',
    },
    {
      name: 'list_demo_tasks',
      label: '查询 Mock 任务',
      description: '查询当前 demo 进程里创建过的模拟任务。',
      example: '列一下刚才创建的任务。',
    },
    {
      name: 'get_public_holidays',
      label: '公共节假日',
      description: '按国家和年份查询公开节假日，适合测试日期和国家代码参数。',
      example: '查一下日本 2026 年前几个公共假期。',
    },
  ];
}

function makeIndexHtml(config) {
  const cards = publicToolCards();
  const escapedConfig = JSON.stringify({
    model: config.model,
    inputSampleRate: INPUT_SAMPLE_RATE,
    outputSampleRate: OUTPUT_SAMPLE_RATE,
    micGate: makeMicGateConfig(),
    voices: GEMINI_LIVE_VOICES,
    defaultVoiceName: normalizeVoiceName(),
    defaultSystemInstruction: process.env.GEMINI_LIVE_DEMO_SYSTEM_INSTRUCTION || SYSTEM_INSTRUCTION,
    tools: cards,
  }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Gemini Live 实时语音 Demo</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #15171c;
      --muted: #656d7a;
      --line: #d9dee8;
      --accent: #1769e0;
      --accent-strong: #0f55bc;
      --ok: #168a4a;
      --warn: #b45f05;
      --danger: #b42318;
      --shadow: 0 8px 22px rgba(23, 33, 50, 0.08);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      letter-spacing: 0;
    }
    button, input, select, textarea { font: inherit; }
    .app {
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto 1fr;
    }
    header {
      background: var(--panel);
      border-bottom: 1px solid var(--line);
      padding: 18px clamp(16px, 4vw, 40px);
    }
    .topbar {
      max-width: 1180px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .title h1 {
      margin: 0;
      font-size: clamp(22px, 3vw, 32px);
      line-height: 1.1;
      font-weight: 750;
    }
    .title p {
      margin: 8px 0 0;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.5;
    }
    .status {
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 180px;
      justify-content: flex-end;
      color: var(--muted);
      font-size: 14px;
      white-space: nowrap;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #9aa3af;
      box-shadow: 0 0 0 4px rgba(154, 163, 175, 0.14);
    }
    .dot.live {
      background: var(--ok);
      box-shadow: 0 0 0 4px rgba(22, 138, 74, 0.14);
    }
    main {
      max-width: 1180px;
      width: 100%;
      margin: 0 auto;
      padding: 22px clamp(16px, 4vw, 40px) 36px;
      display: grid;
      grid-template-columns: minmax(280px, 360px) 1fr;
      gap: 18px;
    }
    section {
      min-width: 0;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      box-shadow: var(--shadow);
    }
    .control {
      padding: 18px;
    }
    .start {
      width: 100%;
      border: 0;
      border-radius: 8px;
      background: var(--accent);
      color: #fff;
      min-height: 54px;
      cursor: pointer;
      font-weight: 720;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
    }
    .start:hover { background: var(--accent-strong); }
    .start.running { background: var(--danger); }
    .start:disabled {
      cursor: wait;
      opacity: 0.72;
    }
    .meta {
      margin-top: 14px;
      display: grid;
      gap: 8px;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
    }
    .meta strong { color: var(--text); font-weight: 650; }
    .field {
      margin-top: 14px;
      display: grid;
      gap: 7px;
    }
    .field label {
      font-size: 13px;
      font-weight: 720;
      color: var(--text);
    }
    .field select,
    .field textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      color: var(--text);
      padding: 10px 11px;
      outline: none;
    }
    .field textarea {
      min-height: 172px;
      resize: vertical;
      line-height: 1.45;
      font-size: 13px;
    }
    .field select:focus,
    .field textarea:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(23, 105, 224, 0.12);
    }
    .voice-list {
      margin-top: 10px;
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 7px;
      max-height: 180px;
      overflow: auto;
      padding-right: 2px;
    }
    .voice-pill {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfcfe;
      padding: 8px;
      display: grid;
      gap: 2px;
      cursor: pointer;
      text-align: left;
    }
    .voice-pill.active {
      border-color: var(--accent);
      background: #f3f7ff;
    }
    .voice-pill strong {
      font-size: 13px;
      line-height: 1.2;
    }
    .voice-pill span {
      color: var(--muted);
      font-size: 12px;
    }
    .privacy {
      margin-top: 14px;
      padding: 12px;
      border-radius: 8px;
      background: #f1f8f4;
      border: 1px solid #cde9d6;
      color: #1d6b3a;
      font-size: 13px;
      line-height: 1.5;
    }
    .tools {
      margin-top: 16px;
      display: grid;
      gap: 10px;
    }
    .tool {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 12px;
      background: #fbfcfe;
    }
    .tool h2 {
      margin: 0;
      font-size: 15px;
      line-height: 1.3;
    }
    .tool p {
      margin: 7px 0 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
    }
    .tool .example {
      margin-top: 8px;
      color: #2f3a4a;
      font-size: 13px;
      line-height: 1.45;
    }
    .chat {
      display: grid;
      grid-template-rows: auto minmax(420px, 1fr) auto;
      min-height: calc(100vh - 190px);
    }
    .meter-panel {
      border-bottom: 1px solid var(--line);
      padding: 12px 16px;
      display: grid;
      gap: 8px;
    }
    .meter-row {
      display: grid;
      grid-template-columns: 72px 1fr;
      gap: 10px;
      align-items: center;
      color: var(--muted);
      font-size: 13px;
    }
    .log {
      padding: 16px;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 10px;
      min-height: 0;
    }
    .entry {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 10px 12px;
      background: #fff;
      line-height: 1.5;
      font-size: 14px;
      word-break: break-word;
    }
    .entry.user { border-left: 4px solid #2e7dd7; }
    .entry.assistant { border-left: 4px solid #18a05e; }
    .entry.tool { border-left: 4px solid #9b6ee9; background: #fcfaff; }
    .entry.system { color: var(--muted); background: #f8fafc; }
    .entry.error { border-left: 4px solid var(--danger); color: var(--danger); background: #fff7f5; }
    .entry .label {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 4px;
      font-weight: 700;
    }
    .bottom {
      border-top: 1px solid var(--line);
      padding: 12px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      color: var(--muted);
      font-size: 13px;
    }
    .meter {
      height: 8px;
      width: 100%;
      border-radius: 999px;
      background: #e5e9f1;
      overflow: hidden;
    }
    .meter span {
      display: block;
      height: 100%;
      width: 0%;
      background: var(--ok);
      transition: width 80ms linear;
    }
    @media (max-width: 840px) {
      .topbar { align-items: flex-start; flex-direction: column; }
      .status { justify-content: flex-start; }
      main { grid-template-columns: 1fr; }
      .chat { min-height: 560px; }
      .voice-list { grid-template-columns: 1fr; max-height: 220px; }
      .field textarea { min-height: 140px; }
    }
  </style>
</head>
<body>
  <div class="app">
    <header>
      <div class="topbar">
        <div class="title">
          <h1>Gemini Live 实时语音 Demo</h1>
          <p>一个开始按钮，直接进行双向实时语音；页面展示转写、模型回复和 Function Call 过程。</p>
        </div>
        <div class="status"><span id="statusDot" class="dot"></span><span id="statusText">未连接</span></div>
      </div>
    </header>
    <main>
      <section>
        <div class="panel control">
          <button id="startButton" class="start" type="button">
            <span id="buttonIcon">▶</span>
            <span id="buttonText">开始实时对话</span>
          </button>
          <div class="meta">
            <div><strong>模型</strong> ${config.model}</div>
            <div><strong>输入</strong> 浏览器麦克风，16 kHz PCM 流</div>
            <div><strong>输出</strong> 实时音频播放 + 文本转写</div>
          </div>
          <div class="field">
            <label for="voiceSelect">音色</label>
            <select id="voiceSelect"></select>
            <div class="voice-list" id="voiceList"></div>
          </div>
          <div class="field">
            <label for="promptInput">系统提示词</label>
            <textarea id="promptInput" spellcheck="false"></textarea>
          </div>
          <div class="privacy">
            当前 demo 只开放安全演示函数，不读取电脑名称、进程、文件、浏览器标签页或任何本机私密信息。
          </div>
        </div>
        <div class="tools" id="tools"></div>
      </section>
      <section class="panel chat">
        <div class="meter-panel">
          <div class="meter-row">
            <span>音频检测</span>
            <div class="meter" aria-hidden="true"><span id="meterFill"></span></div>
          </div>
          <span id="hint">点击开始后直接说话；已启用抗噪声门，明确连续说话才会打断当前回复。</span>
        </div>
        <div class="log" id="log"></div>
        <div class="bottom">
          <span>最新记录在上方，最多保留 200 条。</span>
        </div>
      </section>
    </main>
  </div>
  <script>
    const CONFIG = ${escapedConfig};
    const startButton = document.getElementById('startButton');
    const buttonText = document.getElementById('buttonText');
    const buttonIcon = document.getElementById('buttonIcon');
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const logEl = document.getElementById('log');
    const toolsEl = document.getElementById('tools');
    const meterFill = document.getElementById('meterFill');
    const voiceSelect = document.getElementById('voiceSelect');
    const voiceList = document.getElementById('voiceList');
    const promptInput = document.getElementById('promptInput');

    let ws = null;
    let micStream = null;
    let audioContext = null;
    let micSource = null;
    let processor = null;
    let silentGain = null;
    let playbackTime = 0;
    let playingSources = [];
    let running = false;
    const MAX_LOG_ENTRIES = 200;
    const MIC_GATE = CONFIG.micGate || {};
    let micPreRoll = [];
    let micSpeechFrames = 0;
    let micHoldFrames = 0;
    let pendingReadyResolve = null;
    let pendingReadyReject = null;

    function renderTools() {
      toolsEl.innerHTML = CONFIG.tools.map((tool) => [
        '<article class="tool">',
        '<h2>' + escapeHtml(tool.label) + ' <code>' + escapeHtml(tool.name) + '</code></h2>',
        '<p>' + escapeHtml(tool.description) + '</p>',
        '<div class="example">示例：“' + escapeHtml(tool.example) + '”</div>',
        '</article>',
      ].join('')).join('');
    }

    function renderVoices() {
      const savedVoice = localStorage.getItem('gemini-live-demo-voice') || CONFIG.defaultVoiceName;
      const selectedVoice = CONFIG.voices.some((voice) => voice.name === savedVoice)
        ? savedVoice
        : CONFIG.defaultVoiceName;
      voiceSelect.innerHTML = CONFIG.voices.map((voice) => {
        const selected = voice.name === selectedVoice ? ' selected' : '';
        return '<option value="' + escapeHtml(voice.name) + '"' + selected + '>' +
          escapeHtml(voice.name + ' — ' + voice.label + ' / ' + voice.style) +
          '</option>';
      }).join('');
      renderVoicePills(selectedVoice);
      promptInput.value = localStorage.getItem('gemini-live-demo-prompt') || CONFIG.defaultSystemInstruction;
    }

    function renderVoicePills(selectedVoice) {
      voiceList.innerHTML = CONFIG.voices.map((voice) => {
        const active = voice.name === selectedVoice ? ' active' : '';
        return '<button class="voice-pill' + active + '" type="button" data-voice="' + escapeHtml(voice.name) + '">' +
          '<strong>' + escapeHtml(voice.name) + '</strong>' +
          '<span>' + escapeHtml(voice.label + ' / ' + voice.style) + '</span>' +
          '</button>';
      }).join('');
    }

    function selectedSessionOptions() {
      return {
        voiceName: voiceSelect.value || CONFIG.defaultVoiceName,
        systemInstruction: promptInput.value || CONFIG.defaultSystemInstruction,
      };
    }

    voiceSelect.addEventListener('change', () => {
      localStorage.setItem('gemini-live-demo-voice', voiceSelect.value);
      renderVoicePills(voiceSelect.value);
    });

    voiceList.addEventListener('click', (event) => {
      const button = event.target.closest('[data-voice]');
      if (!button) return;
      voiceSelect.value = button.dataset.voice;
      voiceSelect.dispatchEvent(new Event('change'));
    });

    promptInput.addEventListener('change', () => {
      localStorage.setItem('gemini-live-demo-prompt', promptInput.value);
    });

    function escapeHtml(value) {
      return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }

    function setStatus(text, live = false) {
      statusText.textContent = text;
      statusDot.classList.toggle('live', live);
    }

    function addEntry(kind, label, text) {
      const entry = document.createElement('div');
      entry.className = 'entry ' + kind;
      const labelEl = document.createElement('span');
      labelEl.className = 'label';
      labelEl.textContent = label;
      entry.append(labelEl, document.createTextNode(text));
      logEl.prepend(entry);
      while (logEl.children.length > MAX_LOG_ENTRIES) {
        logEl.removeChild(logEl.lastElementChild);
      }
      logEl.scrollTop = 0;
    }

    function setRunning(nextRunning) {
      running = nextRunning;
      startButton.disabled = false;
      startButton.classList.toggle('running', running);
      buttonText.textContent = running ? '结束实时对话' : '开始实时对话';
      buttonIcon.textContent = running ? '■' : '▶';
    }

    function base64ToArrayBuffer(base64) {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return bytes.buffer;
    }

    function int16PcmToFloat32(arrayBuffer) {
      const view = new DataView(arrayBuffer);
      const samples = new Float32Array(arrayBuffer.byteLength / 2);
      for (let i = 0; i < samples.length; i += 1) {
        const value = view.getInt16(i * 2, true);
        samples[i] = Math.max(-1, Math.min(1, value / 32768));
      }
      return samples;
    }

    function float32ToInt16Pcm(float32) {
      const pcm = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i += 1) {
        const sample = Math.max(-1, Math.min(1, float32[i]));
        pcm[i] = sample < 0 ? sample * 32768 : sample * 32767;
      }
      return pcm.buffer;
    }

    function downsampleBuffer(buffer, inputRate, outputRate) {
      if (inputRate === outputRate) return buffer;
      const ratio = inputRate / outputRate;
      const newLength = Math.max(1, Math.round(buffer.length / ratio));
      const result = new Float32Array(newLength);
      let offsetResult = 0;
      let offsetBuffer = 0;
      while (offsetResult < result.length) {
        const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
        let accum = 0;
        let count = 0;
        for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i += 1) {
          accum += buffer[i];
          count += 1;
        }
        result[offsetResult] = count ? accum / count : 0;
        offsetResult += 1;
        offsetBuffer = nextOffsetBuffer;
      }
      return result;
    }

    function measureAudio(buffer) {
      let peak = 0;
      let sumSquares = 0;
      for (let i = 0; i < buffer.length; i += 1) {
        const sample = Math.abs(buffer[i]);
        peak = Math.max(peak, sample);
        sumSquares += sample * sample;
      }
      return {
        peak,
        rms: Math.sqrt(sumSquares / Math.max(1, buffer.length)),
      };
    }

    function isAssistantAudioPlaying(context) {
      return playingSources.length > 0 || playbackTime > context.currentTime + 0.12;
    }

    function resetMicGate() {
      micPreRoll = [];
      micSpeechFrames = 0;
      micHoldFrames = 0;
    }

    async function ensureAudioContext() {
      if (!audioContext || audioContext.state === 'closed') {
        audioContext = new AudioContext();
      }
      if (audioContext.state === 'suspended') await audioContext.resume();
      return audioContext;
    }

    async function startMic() {
      const context = await ensureAudioContext();
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        const currentUrl = location.href;
        const isLanHttp = location.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
        throw new Error(
          isLanHttp
            ? '当前地址是局域网 HTTP，Chrome 不开放麦克风 API。请在本机用 http://localhost:8787 测试，或者改用 HTTPS/WSS 局域网地址。当前地址：' + currentUrl
            : '当前浏览器没有提供麦克风 API。请确认使用 Chrome、允许麦克风权限，并通过 localhost 或 HTTPS 打开页面。当前地址：' + currentUrl,
        );
      }
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      micSource = context.createMediaStreamSource(micStream);
      processor = context.createScriptProcessor(2048, 1, 1);
      silentGain = context.createGain();
      silentGain.gain.value = 0;
      processor.onaudioprocess = (event) => {
        if (!running || !ws || ws.readyState !== WebSocket.OPEN) return;
        const input = event.inputBuffer.getChannelData(0);
        const stats = measureAudio(input);
        meterFill.style.width = Math.min(100, Math.round(stats.peak * 140)) + '%';
        const downsampled = downsampleBuffer(input, context.sampleRate, CONFIG.inputSampleRate);
        const pcm = float32ToInt16Pcm(downsampled);
        const assistantAudioPlaying = isAssistantAudioPlaying(context);
        const rmsThreshold = assistantAudioPlaying ? MIC_GATE.bargeInRms : MIC_GATE.idleRms;
        const peakThreshold = assistantAudioPlaying ? MIC_GATE.bargeInPeak : MIC_GATE.idlePeak;
        const requiredStartFrames = assistantAudioPlaying
          ? MIC_GATE.bargeInStartFrames
          : MIC_GATE.startFrames;
        const active = stats.rms >= rmsThreshold || stats.peak >= peakThreshold;
        const sendPcm = (buffer) => {
          if (ws && ws.readyState === WebSocket.OPEN) ws.send(buffer);
        };

        if (active) {
          micSpeechFrames += 1;
        } else {
          micSpeechFrames = 0;
        }

        let shouldSend = micHoldFrames > 0;
        if (micSpeechFrames >= requiredStartFrames) {
          if (micHoldFrames === 0 && micPreRoll.length > 0) {
            for (const frame of micPreRoll) sendPcm(frame);
          }
          shouldSend = true;
          micHoldFrames = MIC_GATE.holdFrames;
          micPreRoll = [];
        }

        if (shouldSend) {
          sendPcm(pcm);
          if (!active && micHoldFrames > 0) micHoldFrames -= 1;
        } else {
          micPreRoll.push(pcm);
          while (micPreRoll.length > MIC_GATE.preRollFrames) micPreRoll.shift();
        }
      };
      micSource.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(context.destination);
    }

    function stopMic() {
      if (processor) {
        processor.disconnect();
        processor.onaudioprocess = null;
        processor = null;
      }
      if (silentGain) {
        silentGain.disconnect();
        silentGain = null;
      }
      if (micSource) {
        micSource.disconnect();
        micSource = null;
      }
      if (micStream) {
        for (const track of micStream.getTracks()) track.stop();
        micStream = null;
      }
      resetMicGate();
      meterFill.style.width = '0%';
    }

    function clearPlayback() {
      for (const source of playingSources) {
        try { source.stop(); } catch {}
      }
      playingSources = [];
      playbackTime = audioContext ? audioContext.currentTime : 0;
    }

    async function playPcm(base64, sampleRate) {
      const context = await ensureAudioContext();
      const samples = int16PcmToFloat32(base64ToArrayBuffer(base64));
      const audioBuffer = context.createBuffer(1, samples.length, sampleRate || CONFIG.outputSampleRate);
      audioBuffer.copyToChannel(samples, 0);
      const source = context.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(context.destination);
      source.onended = () => {
        playingSources = playingSources.filter((item) => item !== source);
      };
      const startAt = Math.max(context.currentTime + 0.02, playbackTime);
      source.start(startAt);
      playbackTime = startAt + audioBuffer.duration;
      playingSources.push(source);
    }

    function makeWsUrl() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      return proto + '//' + location.host + '/ws/gemini-live';
    }

    function handleMessage(event) {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === 'ready') {
        setStatus('已连接，正在听', true);
        addEntry('system', '系统', '连接成功。音色：' + (message.voiceName || voiceSelect.value) + '。现在可以直接说话。');
        pendingReadyResolve?.(message);
        pendingReadyResolve = null;
        pendingReadyReject = null;
      } else if (message.type === 'awaiting_start') {
        setStatus('等待开始配置', false);
      } else if (message.type === 'starting') {
        setStatus('连接 Gemini Live', false);
      } else if (message.type === 'input_transcript') {
        addEntry('user', '你', message.text);
      } else if (message.type === 'output_transcript' || message.type === 'text') {
        addEntry('assistant', 'Gemini', message.text);
      } else if (message.type === 'audio') {
        void playPcm(message.audio, message.sampleRate);
      } else if (message.type === 'tool_call') {
        addEntry('tool', 'Function Call', message.name + '(' + JSON.stringify(message.args) + ')');
      } else if (message.type === 'tool_result') {
        addEntry('tool', 'Tool Result', message.name + ' → ' + JSON.stringify(message.result));
      } else if (message.type === 'interrupted') {
        clearPlayback();
        addEntry('system', '打断', '已停止当前回复音频，继续听你说。');
      } else if (message.type === 'turn_complete') {
        setStatus('正在听', true);
      } else if (message.type === 'error') {
        addEntry('error', '错误', message.message);
        pendingReadyReject?.(new Error(message.message));
        pendingReadyResolve = null;
        pendingReadyReject = null;
      } else if (message.type === 'closed') {
        addEntry('system', '系统', '连接已关闭。');
        void stopConversation();
      }
    }

    async function startConversation() {
      startButton.disabled = true;
      setStatus('连接中', false);
      await ensureAudioContext();
      ws = new WebSocket(makeWsUrl());
      ws.binaryType = 'arraybuffer';
      ws.onmessage = handleMessage;
      ws.onclose = () => {
        setStatus('已断开', false);
        stopMic();
        clearPlayback();
        setRunning(false);
      };
      await new Promise((resolve, reject) => {
        ws.onopen = resolve;
        ws.onerror = reject;
      });
      ws.onerror = () => addEntry('error', '错误', 'WebSocket 连接失败。');
      localStorage.setItem('gemini-live-demo-voice', voiceSelect.value);
      localStorage.setItem('gemini-live-demo-prompt', promptInput.value);
      const readyPromise = new Promise((resolve, reject) => {
        pendingReadyResolve = resolve;
        pendingReadyReject = reject;
        setTimeout(() => reject(new Error('Gemini Live 会话启动超时。')), 20000);
      });
      ws.send(JSON.stringify({ type: 'start', ...selectedSessionOptions() }));
      await readyPromise;
      await startMic();
      setRunning(true);
      setStatus('正在听', true);
    }

    async function stopConversation() {
      if (!running && !ws) return;
      setStatus('正在停止', false);
      stopMic();
      clearPlayback();
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'stop' }));
        ws.close(1000, 'user stopped');
      }
      ws = null;
      setRunning(false);
      setStatus('已停止', false);
    }

    startButton.addEventListener('click', async () => {
      try {
        if (running) await stopConversation();
        else await startConversation();
      } catch (error) {
        addEntry('error', '错误', error.message || String(error));
        await stopConversation();
      }
    });

    renderVoices();
    renderTools();
    addEntry('system', '提示', '先选音色、确认提示词，再点击开始。可以试试天气、计算、单位换算、Mock 任务和节假日。');
  </script>
</body>
</html>`;
}

function createServer(config) {
  const handleRequest = (req, res) => {
    if (req.method === 'GET' && req.url === '/') {
      const body = makeIndexHtml(config);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-length': Buffer.byteLength(body),
        'cache-control': 'no-store',
      });
      res.end(body);
      return;
    }
    if (req.method === 'GET' && req.url === '/api/tools') {
      jsonResponse(res, 200, { tools: publicToolCards() });
      return;
    }
    if (req.method === 'GET' && req.url === '/favicon.ico') {
      res.writeHead(204, { 'cache-control': 'public, max-age=86400' });
      res.end();
      return;
    }
    jsonResponse(res, 404, { error: 'not_found' });
  };

  const server = config.tls
    ? https.createServer(config.tls, handleRequest)
    : http.createServer(handleRequest);

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/ws/gemini-live') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', async (ws, req) => {
    const remote = req.socket.remoteAddress || 'unknown';
    console.info(`[GeminiLiveDemo] browser connected from ${remote}`);
    let live = null;
    let starting = false;
    sendWsJson(ws, {
      type: 'awaiting_start',
      model: config.model,
      voices: GEMINI_LIVE_VOICES,
      tools: publicToolCards(),
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        live?.sendAudio(Buffer.from(data));
        return;
      }
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (message.type === 'start') {
        if (live || starting) return;
        starting = true;
        sendWsJson(ws, { type: 'starting' });
        void (async () => {
          try {
            live = await createGeminiSession(ws, config, {
              voiceName: message.voiceName,
              systemInstruction: message.systemInstruction,
            });
          } catch (error) {
            console.error('[GeminiLiveDemo] connect failed:', error?.stack || error?.message || error);
            sendWsJson(ws, { type: 'error', message: error?.message || String(error) });
            ws.close(1011, 'Gemini Live connect failed');
          }
        })();
        return;
      }
      if (message.type === 'stop') {
        live?.sendEnd();
        live?.close();
      }
    });

    ws.on('close', () => {
      console.info(`[GeminiLiveDemo] browser disconnected from ${remote}`);
      live?.close?.();
    });
  });

  return server;
}

function geminiLivePagePath(pathname = '') {
  return pathname === '/gemini-live'
    || pathname === '/gemini-live/'
    || /^\/s\/[^/]+\/gemini-live\/?$/.test(pathname);
}

function geminiLiveApiPath(pathname = '') {
  return pathname === '/api/gemini-live/status'
    || pathname === '/api/gemini-live/tools'
    || pathname === '/api/gemini-live/voices';
}

function geminiLiveLoginRequired(deps = {}) {
  return Boolean(deps.cloudAuth?.isLoginRequired?.());
}

function geminiLiveUser(req, deps = {}) {
  return deps.cloudAuth?.currentUser?.(req) || deps.cloudAuth?.currentActor?.(req)?.user || null;
}

function safeReturnTo(url) {
  const target = `${url?.pathname || '/'}${url?.search || ''}`;
  return target.startsWith('/') && !target.startsWith('//') ? target : '/gemini-live';
}

function redirectToLogin(req, res, url) {
  res.writeHead(302, {
    location: `/?returnTo=${encodeURIComponent(safeReturnTo(url))}`,
    'cache-control': 'no-store',
  });
  res.end('');
}

function requireGeminiLivePageAccess(req, res, url, deps = {}) {
  if (!geminiLiveLoginRequired(deps)) return true;
  if (geminiLiveUser(req, deps)) return true;
  redirectToLogin(req, res, url);
  return false;
}

function requireGeminiLiveApiAccess(req, res, deps = {}) {
  if (!geminiLiveLoginRequired(deps)) return true;
  if (geminiLiveUser(req, deps)) return true;
  jsonResponse(res, 401, { error: 'login_required' });
  return false;
}

function geminiLivePublicStatus(options = {}) {
  const envFile = String(options.envFile || process.env.GEMINI_LIVE_ENV_FILE || DEFAULT_ENV_FILE).trim();
  loadEnvFile(envFile);
  const config = publicConfigFromEnv(options);
  return {
    model: config.model,
    location: config.location,
    credentialsConfigured: config.credentialsConfigured,
    projectConfigured: Boolean(config.project),
    voices: GEMINI_LIVE_VOICES.length,
    tools: publicToolCards().length,
  };
}

export async function handleGeminiLiveDemoHttp(req, res, url, deps = {}) {
  if (!geminiLivePagePath(url.pathname) && !geminiLiveApiPath(url.pathname)) return false;
  if (geminiLivePagePath(url.pathname)) {
    if (!requireGeminiLivePageAccess(req, res, url, deps)) return true;
    const config = publicConfigFromEnv({
      host: deps.host,
      port: deps.port,
      protocol: deps.protocol,
    });
    const body = makeIndexHtml(config);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
      'permissions-policy': 'microphone=(self)',
      'content-security-policy': "default-src 'self'; connect-src 'self' ws: wss: https:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:;",
    });
    res.end(body);
    return true;
  }

  if (!requireGeminiLiveApiAccess(req, res, deps)) return true;
  if (url.pathname === '/api/gemini-live/status') {
    jsonResponse(res, 200, geminiLivePublicStatus({
      host: deps.host,
      port: deps.port,
      protocol: deps.protocol,
    }));
    return true;
  }
  if (url.pathname === '/api/gemini-live/tools') {
    jsonResponse(res, 200, { tools: publicToolCards() });
    return true;
  }
  if (url.pathname === '/api/gemini-live/voices') {
    jsonResponse(res, 200, { voices: GEMINI_LIVE_VOICES });
    return true;
  }
  return false;
}

function safeUpgradeEnd(socket, response) {
  try {
    if (socket?.destroyed) return;
    socket.end(response);
  } catch {
    try {
      socket?.destroy?.();
    } catch {
      // best effort
    }
  }
}

function upgradePath(req) {
  try {
    return new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`).pathname;
  } catch {
    return '';
  }
}

function requireGeminiLiveUpgradeAccess(req, socket, deps = {}) {
  if (!geminiLiveLoginRequired(deps)) return true;
  if (geminiLiveUser(req, deps)) return true;
  safeUpgradeEnd(socket, 'HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\n\r\nMagClaw login is required.');
  return false;
}

function attachGeminiLiveConnectionHandlers(wss, deps = {}) {
  wss.on('connection', async (ws, req) => {
    const remote = req.socket.remoteAddress || 'unknown';
    console.info(`[GeminiLiveDemo] browser connected from ${remote}`);
    let live = null;
    let starting = false;
    const publicConfig = publicConfigFromEnv({
      host: deps.host,
      port: deps.port,
      protocol: deps.protocol,
    });
    sendWsJson(ws, {
      type: 'awaiting_start',
      model: publicConfig.model,
      voices: GEMINI_LIVE_VOICES,
      tools: publicToolCards(),
      credentialsConfigured: publicConfig.credentialsConfigured,
      projectConfigured: Boolean(publicConfig.project),
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        live?.sendAudio(Buffer.from(data));
        return;
      }
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (message.type === 'start') {
        if (live || starting) return;
        starting = true;
        sendWsJson(ws, { type: 'starting' });
        void (async () => {
          try {
            const config = resolveGeminiLiveDemoConfig({
              host: deps.host,
              port: deps.port,
            });
            live = await createGeminiSession(ws, config, {
              voiceName: message.voiceName,
              systemInstruction: message.systemInstruction,
            });
          } catch (error) {
            console.error('[GeminiLiveDemo] connect failed:', error?.stack || error?.message || error);
            sendWsJson(ws, { type: 'error', message: error?.message || String(error) });
            ws.close(1011, 'Gemini Live connect failed');
          }
        })();
        return;
      }
      if (message.type === 'stop') {
        live?.sendEnd();
        live?.close();
      }
    });

    ws.on('close', () => {
      console.info(`[GeminiLiveDemo] browser disconnected from ${remote}`);
      live?.close?.();
    });
  });
}

export function createGeminiLiveDemoUpgradeHandler(deps = {}) {
  const wss = new WebSocketServer({ noServer: true });
  attachGeminiLiveConnectionHandlers(wss, deps);
  return {
    isGeminiLiveUpgrade(req) {
      return upgradePath(req) === '/ws/gemini-live';
    },
    handleUpgrade(req, socket, head) {
      if (upgradePath(req) !== '/ws/gemini-live') return false;
      if (!requireGeminiLiveUpgradeAccess(req, socket, deps)) return true;
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
      return true;
    },
    close() {
      wss.close();
    },
  };
}

export {
  GEMINI_LIVE_VOICES,
  INPUT_SAMPLE_RATE,
  OUTPUT_SAMPLE_RATE,
  createGeminiSession,
  createServer,
  getToolDeclarations,
  makeIndexHtml,
  publicToolCards,
  resolveCredentialsPath,
};

function isDirectRun() {
  return process.argv[1] && path.resolve(process.argv[1]) === __filename;
}

export async function runGeminiLiveDemoCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return;
  }
  if (!Number.isFinite(args.port) || args.port <= 0) {
    throw new Error('--port must be a positive number');
  }

  loadEnvFile(args.envFile);
  const config = getConfig(args);
  const server = createServer(config);

  server.listen(config.port, config.host, () => {
    console.log(`Gemini Live web demo is running.`);
    console.log(`Local: ${config.protocol}://localhost:${config.port}`);
    for (const url of getLanAddresses(config.port, config.protocol)) {
      console.log(`LAN:   ${url}`);
    }
    console.log(`Model: ${config.model}`);
    console.log(`Project: ${config.project}`);
    console.log(`Location: ${config.location}`);
    console.log(`Credentials: ${config.credentialsPath}`);
    console.log('Press Ctrl+C to stop.');
  });

  const shutdown = () => {
    console.log('\nStopping Gemini Live web demo...');
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (isDirectRun()) {
  runGeminiLiveDemoCli().catch((error) => {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  });
}
