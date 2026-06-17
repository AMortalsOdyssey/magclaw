import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
const MISSING_CREDENTIALS_CODE = 'missing_vertex_credentials';
const MISSING_CREDENTIALS_MESSAGE =
  `Gemini Live credentials are not configured. Mount a Vertex secret at ${DEFAULT_VERTEX_SECRET_PATH} or set GOOGLE_APPLICATION_CREDENTIALS.`;

class GeminiLiveConfigWarning extends Error {
  constructor(message, code = 'gemini_live_config_warning') {
    super(message);
    this.name = 'GeminiLiveConfigWarning';
    this.code = code;
    this.severity = 'warning';
  }
}

function isGeminiLiveConfigWarning(error) {
  return error?.name === 'GeminiLiveConfigWarning' || error?.severity === 'warning';
}

const SYSTEM_INSTRUCTION = `
You are a realtime voice demo host for MagClaw's Gemini Live demo page.
Understand both Chinese and English, but always answer only in Simplified Chinese.
Do not reply in English even when the user speaks English, except for unavoidable proper
nouns, code identifiers, search keywords, or tool names.

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
4. calculate_expression: safe arithmetic for explicit math requests.
5. convert_units: safe unit conversion for explicit conversion requests.
6. random_choice: pick one option when the user asks you to choose from a short list.
7. create_demo_task: create a mock task for explicit task-creation requests.
8. list_demo_tasks: list mock tasks only when the user clearly asks for demo tasks.
9. get_public_holidays: public holiday lookup by country code and optional year.

Always use natural Mainland Mandarin Chinese. Treat very short isolated English-looking
fragments as possible ASR noise. Ask the user to repeat instead of turning an unclear word
into a search query.
Do not call google_search for greetings, chitchat, one-word ambiguous utterances, or unclear
transcripts. Only search when the user explicitly asks to search, look up, Google, find
current information, or research a topic.
Only call tools when the user explicitly asks for that tool-like action. Do not call tools
for interruption/control phrases such as "等一下", "停一下", "wait", or "stop", and do not
call tools for casual chat, explanations, advice, or long-form speaking requests.

Voice style: relaxed, concise, and conversational. Do not sound like a scripted support bot.
For Chinese output, use natural Mainland Mandarin phrasing, Simplified Chinese characters in
transcripts, and short sentences. After using a tool, report only the useful result, not the raw JSON.
After receiving a tool result, start the spoken answer immediately with one short sentence.
Do not restate the request, explain the tool, or add filler before the result.
If a function response contains spoken_summary, say that spoken_summary verbatim as the first sentence.
For create_demo_task, the first sentence must include the created task title and priority.
For short follow-ups that mention a new city or entity but omit the verb, inherit the previous
tool intent and call the same relevant tool with the newly mentioned city/entity instead of
asking what the user means. Treat any placeholder examples in these instructions as examples,
not as user requests.
For task follow-ups asking to list, show, or query tasks that were just created in this demo
session, call list_demo_tasks immediately instead of asking for clarification.
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
const defaultDemoTasks = new Map();
const weatherCache = new Map();
const WEATHER_CACHE_TTL_MS = 5 * 60 * 1000;
const WEATHER_FETCH_TIMEOUT_MS = 700;
const COMMON_CITY_COORDINATES = new Map([
  ['hangzhou', { name: '杭州', country: 'China', latitude: 30.2741, longitude: 120.1551 }],
  ['杭州', { name: '杭州', country: 'China', latitude: 30.2741, longitude: 120.1551 }],
  ['beijing', { name: '北京', country: 'China', latitude: 39.9042, longitude: 116.4074 }],
  ['北京', { name: '北京', country: 'China', latitude: 39.9042, longitude: 116.4074 }],
  ['shanghai', { name: '上海', country: 'China', latitude: 31.2304, longitude: 121.4737 }],
  ['上海', { name: '上海', country: 'China', latitude: 31.2304, longitude: 121.4737 }],
  ['shenzhen', { name: '深圳', country: 'China', latitude: 22.5431, longitude: 114.0579 }],
  ['深圳', { name: '深圳', country: 'China', latitude: 22.5431, longitude: 114.0579 }],
  ['guangzhou', { name: '广州', country: 'China', latitude: 23.1291, longitude: 113.2644 }],
  ['广州', { name: '广州', country: 'China', latitude: 23.1291, longitude: 113.2644 }],
]);

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

function clampNumber(value, fallback, options = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(options.max ?? number, Math.max(options.min ?? number, number));
}

function enumValue(value, allowed, fallback) {
  const raw = String(value || '').trim();
  return allowed.includes(raw) ? raw : fallback;
}

function normalizeRealtimeMode(value = '') {
  return String(value || '').trim() === 'native_vad' ? 'native_vad' : 'manual';
}

function normalizeRealtimeTuning(value = {}) {
  const realtimeMode = normalizeRealtimeMode(value.realtimeMode || value.mode || value.activityMode);
  const envSilenceDurationMs = numberFromEnv('GEMINI_LIVE_DEMO_SILENCE_DURATION_MS', 700, {
    min: 100,
    max: 3000,
  });
  const envPrefixPaddingMs = numberFromEnv('GEMINI_LIVE_DEMO_PREFIX_PADDING_MS', 180, {
    min: 0,
    max: 1000,
  });
  return {
    realtimeMode,
    startSensitivity: enumValue(
      value.startSensitivity || process.env.GEMINI_LIVE_DEMO_START_SENSITIVITY,
      ['START_SENSITIVITY_HIGH', 'START_SENSITIVITY_LOW'],
      'START_SENSITIVITY_LOW',
    ),
    endSensitivity: enumValue(
      value.endSensitivity || process.env.GEMINI_LIVE_DEMO_END_SENSITIVITY,
      ['END_SENSITIVITY_HIGH', 'END_SENSITIVITY_LOW'],
      'END_SENSITIVITY_LOW',
    ),
    prefixPaddingMs: clampNumber(value.prefixPaddingMs, envPrefixPaddingMs, {
      min: 0,
      max: 1000,
    }),
    silenceDurationMs: clampNumber(value.silenceDurationMs, envSilenceDurationMs, {
      min: 100,
      max: 3000,
    }),
    manualActivity: realtimeMode === 'manual',
    activityHandling: enumValue(
      value.activityHandling,
      ['START_OF_ACTIVITY_INTERRUPTS', 'NO_INTERRUPTION'],
      'START_OF_ACTIVITY_INTERRUPTS',
    ),
    turnCoverage: enumValue(
      value.turnCoverage,
      ['TURN_INCLUDES_ONLY_ACTIVITY', 'TURN_INCLUDES_ALL_INPUT'],
      'TURN_INCLUDES_ONLY_ACTIVITY',
    ),
  };
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

function sanitizeEndpointMetrics(value) {
  if (!value || typeof value !== 'object') return null;
  const numericKeys = [
    'turnId',
    'waitMs',
    'silenceMs',
    'speechDurationMs',
    'transcriptChars',
    'transcriptAgeMs',
    'audioFrames',
    'audioBytes',
    'audioDurationMs',
    'audioStreamed',
  ];
  const metrics = {};
  for (const key of numericKeys) {
    if (value[key] === null) {
      metrics[key] = null;
      continue;
    }
    const number = Number(value[key]);
    if (Number.isFinite(number)) metrics[key] = Math.round(number);
  }
  if (['responsive', 'balanced', 'patient'].includes(value.profile)) metrics.profile = value.profile;
  return metrics;
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
    credentialsConfigured: isReadableFile(credentialsPath),
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
  if (!config.credentialsConfigured) {
    throw new GeminiLiveConfigWarning(MISSING_CREDENTIALS_MESSAGE, MISSING_CREDENTIALS_CODE);
  }
  if (!config.project) {
    throw new GeminiLiveConfigWarning(
      'Gemini Live project is not configured. Set GOOGLE_CLOUD_PROJECT or include project_id in the Vertex credentials JSON.',
      'missing_vertex_project',
    );
  }
  return config;
}

function geminiLiveConfigWarningPayload(error) {
  return {
    type: 'warning',
    code: error?.code || 'gemini_live_config_warning',
    message: error?.message || String(error),
  };
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
  const realtimeTuning = normalizeRealtimeTuning({
    ...(sessionOptions.realtimeTuning || {}),
    realtimeMode: sessionOptions.realtimeMode || sessionOptions.realtimeTuning?.realtimeMode,
  });
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
        disabled: realtimeTuning.manualActivity,
        startOfSpeechSensitivity: realtimeTuning.startSensitivity,
        endOfSpeechSensitivity: realtimeTuning.endSensitivity,
        prefixPaddingMs: realtimeTuning.prefixPaddingMs,
        silenceDurationMs: realtimeTuning.silenceDurationMs,
      },
      activityHandling: realtimeTuning.activityHandling,
      turnCoverage: realtimeTuning.turnCoverage,
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

export function calculateGeminiLiveMicGateFrame(input = {}) {
  const stats = input.stats || {};
  const tuning = input.tuning || {};
  const noiseState = input.noiseState || {};
  const turnStormState = input.turnStormState || {};
  const nowMs = Number(input.nowMs) || 0;
  const frameMs = Number(input.frameMs) || 1;
  const micSpeechFrames = Number(input.micSpeechFrames) || 0;
  const assistantAudioPlaying = Boolean(input.assistantAudioPlaying);
  const acceptedBargeIn = Boolean(input.acceptedBargeIn);
  const noiseGuardActive = Boolean(turnStormState.active)
    || (Number(turnStormState.guardUntilMs) > 0 && nowMs > 0 && Number(turnStormState.guardUntilMs) > nowMs);
  const baseRmsThreshold = Number(assistantAudioPlaying && !acceptedBargeIn ? tuning.bargeInRms : tuning.idleRms) || 0;
  const basePeakThreshold = Number(assistantAudioPlaying && !acceptedBargeIn ? tuning.bargeInPeak : tuning.idlePeak) || 0;
  const noiseRms = Math.max(0, Number(noiseState.rms) || 0);
  const noisePeak = Math.max(0, Number(noiseState.peak) || 0);
  const rmsMultiplier = Number(tuning.noiseRmsMultiplier) || (assistantAudioPlaying ? 3.4 : 2.6);
  const peakMultiplier = Number(tuning.noisePeakMultiplier) || (assistantAudioPlaying ? 3.2 : 2.4);
  const guardMultiplier = noiseGuardActive ? (Number(tuning.noiseGuardMultiplier) || 1.35) : 1;
  const rmsThreshold = Math.max(baseRmsThreshold, noiseRms * rmsMultiplier) * guardMultiplier;
  const peakThreshold = Math.max(basePeakThreshold, noisePeak * peakMultiplier) * guardMultiplier;
  const requiredStartFrames = assistantAudioPlaying && !acceptedBargeIn
    ? Math.max(1, Math.ceil((Number(tuning.bargeInMs) || 1) / frameMs))
    : Math.max(1, Number(tuning.startFrames) || 1);
  const guardedStartFrames = noiseGuardActive
    ? Math.max(requiredStartFrames + 2, Math.ceil(requiredStartFrames * 1.6))
    : requiredStartFrames;
  const aboveRms = Number(stats.rms) >= rmsThreshold;
  const abovePeak = Number(stats.peak) >= peakThreshold;
  const active = noiseGuardActive ? aboveRms && abovePeak : aboveRms || abovePeak;
  const nextSpeechFrames = active ? micSpeechFrames + 1 : 0;
  const candidateBargeIn = assistantAudioPlaying && !acceptedBargeIn && nextSpeechFrames > 0;
  const shouldDeferForBargeIn = assistantAudioPlaying && !acceptedBargeIn && nextSpeechFrames < guardedStartFrames;
  const shouldAcceptBargeIn = assistantAudioPlaying && !acceptedBargeIn && nextSpeechFrames >= guardedStartFrames;
  const shouldStartUserSpeech = nextSpeechFrames >= guardedStartFrames;
  return {
    active,
    nextSpeechFrames,
    requiredStartFrames: guardedStartFrames,
    baseRequiredStartFrames: requiredStartFrames,
    rmsThreshold,
    peakThreshold,
    baseRmsThreshold,
    basePeakThreshold,
    noiseRms,
    noisePeak,
    noiseGuardActive,
    candidateBargeIn,
    heardMs: Math.round(nextSpeechFrames * frameMs),
    shouldDeferForBargeIn,
    shouldAcceptBargeIn,
    shouldStartUserSpeech,
  };
}

export function updateGeminiLiveNoiseBaseline(input = {}) {
  const previous = input.state || {};
  const stats = input.stats || {};
  const canUpdate = !input.userSpeaking
    && !input.assistantAudioPlaying
    && !input.acceptedBargeIn
    && !input.candidateBargeIn;
  const sampleRms = Math.max(0, Number(stats.rms) || 0);
  const samplePeak = Math.max(0, Number(stats.peak) || 0);
  const initialized = Boolean(previous.initialized);
  const currentRms = initialized ? Math.max(0, Number(previous.rms) || 0) : sampleRms;
  const currentPeak = initialized ? Math.max(0, Number(previous.peak) || 0) : samplePeak;
  const rise = Math.min(1, Math.max(0.01, Number(input.rise) || 0.16));
  const fall = Math.min(1, Math.max(0.005, Number(input.fall) || 0.035));
  const blend = (current, sample) => {
    const alpha = sample > current ? rise : fall;
    return current + ((sample - current) * alpha);
  };
  if (!canUpdate) {
    return {
      ...previous,
      initialized,
      updated: false,
      rms: currentRms,
      peak: currentPeak,
    };
  }
  return {
    initialized: true,
    updated: true,
    samples: Math.min(10_000, (Number(previous.samples) || 0) + 1),
    rms: initialized ? blend(currentRms, sampleRms) : sampleRms,
    peak: initialized ? blend(currentPeak, samplePeak) : samplePeak,
  };
}

export function updateGeminiLiveTurnStorm(input = {}) {
  const previous = input.state || {};
  const nowMs = Math.max(0, Number(input.nowMs) || 0);
  const windowMs = Math.max(500, Number(input.windowMs) || 3000);
  const guardMs = Math.max(1000, Number(input.guardMs) || 8000);
  const threshold = Math.max(1, Number(input.threshold) || 3);
  const event = String(input.event || '').trim();
  const existingEvents = Array.isArray(previous.events) ? previous.events : [];
  let events = existingEvents
    .map((value) => Number(value) || 0)
    .filter((value) => value > 0 && nowMs - value <= windowMs);
  let guardUntilMs = Math.max(0, Number(previous.guardUntilMs) || 0);
  let entered = false;
  let exited = false;

  if (event === 'success') {
    events = [];
    exited = guardUntilMs > nowMs || Boolean(previous.active);
    guardUntilMs = 0;
  } else if (event === 'noise') {
    events.push(nowMs);
    if (events.length >= threshold && guardUntilMs <= nowMs) {
      guardUntilMs = nowMs + guardMs;
      entered = true;
    } else if (events.length >= threshold) {
      guardUntilMs = Math.max(guardUntilMs, nowMs + guardMs);
    }
  }

  const active = guardUntilMs > nowMs;
  if (!active && previous.active && !entered && event !== 'success') exited = true;
  return {
    active,
    entered,
    exited,
    events,
    guardUntilMs,
    remainingMs: active ? Math.max(0, Math.round(guardUntilMs - nowMs)) : 0,
  };
}

export function decideGeminiLiveEndpoint(input = {}) {
  const transcript = String(input.transcript || '').trim();
  const speechDurationMs = Math.max(0, Number(input.speechDurationMs) || 0);
  const audioDurationMs = Math.max(0, Number(input.audioDurationMs) || 0);
  const effectiveSpeechMs = Math.max(speechDurationMs, audioDurationMs);
  const silenceMs = Math.max(0, Number(input.silenceMs) || 0);
  const waitMs = Math.max(0, Number(input.waitMs) || 0);
  const minNoTranscriptSpeechMs = Math.max(0, Number(input.minNoTranscriptSpeechMs) || 1000);
  const noTranscriptGraceMs = Math.max(waitMs, Number(input.noTranscriptGraceMs) || 1400);

  if (silenceMs < waitMs) {
    return {
      action: 'hold',
      reason: 'waiting_for_silence',
      remainingMs: Math.max(0, Math.round(waitMs - silenceMs)),
    };
  }
  if (transcript.length > 0) {
    return {
      action: 'send',
      reason: 'speech_with_transcript',
      remainingMs: 0,
    };
  }
  if (effectiveSpeechMs >= minNoTranscriptSpeechMs) {
    return {
      action: 'send',
      reason: 'audio_without_transcript_fallback',
      remainingMs: 0,
    };
  }
  if (silenceMs < noTranscriptGraceMs) {
    return {
      action: 'hold',
      reason: 'waiting_for_transcript',
      remainingMs: Math.max(0, Math.round(noTranscriptGraceMs - silenceMs)),
    };
  }
  return {
    action: 'drop',
    reason: 'short_audio_without_transcript',
    remainingMs: 0,
  };
}

function responseDelayWarningMs() {
  return numberFromEnv('GEMINI_LIVE_DEMO_RESPONSE_DELAY_WARNING_MS', 2000, {
    min: 500,
    max: 15000,
  });
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

async function fetchJson(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs) || 2500;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'user-agent': 'MagClaw Gemini Live local demo/1.0',
      },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function weatherCacheKey(city) {
  return String(city || '').trim().toLowerCase();
}

function getCachedWeather(city) {
  const item = weatherCache.get(weatherCacheKey(city));
  if (!item) return null;
  if (Date.now() - item.cachedAt > WEATHER_CACHE_TTL_MS) {
    weatherCache.delete(weatherCacheKey(city));
    return null;
  }
  return { ...item.value, cache: 'hit' };
}

function setCachedWeather(city, value) {
  weatherCache.set(weatherCacheKey(city), { cachedAt: Date.now(), value });
}

function fallbackWeather(city, reason) {
  return {
    city,
    condition: '多云',
    temperature_c: 24,
    humidity_percent: 58,
    wind_kmh: 9,
    observed_at: new Date().toISOString(),
    source: 'demo fallback weather',
    fallback_reason: reason,
  };
}

async function getWeather(rawArgs = {}) {
  const city = String(rawArgs.city || '').trim();
  if (!city) return { error: 'city is required' };
  const cached = getCachedWeather(city);
  if (cached) return cached;

  let place = COMMON_CITY_COORDINATES.get(weatherCacheKey(city));
  try {
    if (!place) {
      const geoUrl = new URL('https://geocoding-api.open-meteo.com/v1/search');
      geoUrl.searchParams.set('name', city);
      geoUrl.searchParams.set('count', '1');
      geoUrl.searchParams.set('language', 'zh');
      geoUrl.searchParams.set('format', 'json');
      const geo = await fetchJson(geoUrl, { timeoutMs: WEATHER_FETCH_TIMEOUT_MS });
      place = geo.results?.[0];
    }
    if (!place) {
      return { city, error: 'city_not_found', source: 'Open-Meteo' };
    }

    const weatherUrl = new URL('https://api.open-meteo.com/v1/forecast');
    weatherUrl.searchParams.set('latitude', String(place.latitude));
    weatherUrl.searchParams.set('longitude', String(place.longitude));
    weatherUrl.searchParams.set('current', 'temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code');
    weatherUrl.searchParams.set('timezone', 'auto');
    const weather = await fetchJson(weatherUrl, { timeoutMs: WEATHER_FETCH_TIMEOUT_MS });
    const current = weather.current || {};
    const result = {
      city,
      resolved_name: [place.name, place.admin1, place.country].filter(Boolean).join(', '),
      temperature_c: current.temperature_2m,
      humidity_percent: current.relative_humidity_2m,
      wind_kmh: current.wind_speed_10m,
      weather_code: current.weather_code,
      observed_at: current.time,
      source: 'Open-Meteo public API',
    };
    setCachedWeather(city, result);
    return result;
  } catch (error) {
    const reason = error?.name === 'AbortError' ? 'timeout' : 'fetch_failed';
    const result = fallbackWeather(city, reason);
    setCachedWeather(city, result);
    return result;
  }
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

function demoPriorityLabel(priority) {
  if (priority === 'high') return '高';
  if (priority === 'low') return '低';
  return '中等';
}

function createDemoTask(rawArgs = {}, store = defaultDemoTasks) {
  const title = String(rawArgs.title || '').trim().slice(0, 160);
  if (!title) return { error: 'title is required' };
  const id = `TASK-${String(store.size + 1).padStart(4, '0')}`;
  const priority = ['low', 'medium', 'high'].includes(String(rawArgs.priority || '').toLowerCase())
    ? String(rawArgs.priority).toLowerCase()
    : 'medium';
  const task = {
    id,
    title,
    assignee: String(rawArgs.assignee || 'unassigned').trim().slice(0, 80),
    priority,
    priority_label_zh: demoPriorityLabel(priority),
    status: 'open',
    created_at: new Date().toISOString(),
  };
  task.spoken_summary = `已创建任务：“${task.title}”，优先级${task.priority_label_zh}。`;
  store.set(id, task);
  return task;
}

function listDemoTasks(rawArgs = {}, store = defaultDemoTasks) {
  const limit = Math.min(Math.max(Number(rawArgs.limit) || 5, 1), 20);
  return {
    count: store.size,
    tasks: [...store.values()].slice(-limit).reverse(),
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

async function runDemoTool(name, args, context = {}) {
  const taskStore = context.demoTasks || defaultDemoTasks;
  if (name === 'get_weather') return getWeather(args);
  if (name === 'google_search') return googleSearch(args);
  if (name === 'lookup_demo_ticket') return lookupDemoTicket(args);
  if (name === 'calculate_expression') return calculateExpression(args);
  if (name === 'convert_units') return convertUnits(args);
  if (name === 'random_choice') return randomChoice(args);
  if (name === 'create_demo_task') return createDemoTask(args, taskStore);
  if (name === 'list_demo_tasks') return listDemoTasks(args, taskStore);
  if (name === 'get_public_holidays') return getPublicHolidays(args);
  return { error: `Unknown tool: ${name}` };
}

function toolResponseForModel(output) {
  if (output && typeof output === 'object' && typeof output.spoken_summary === 'string') {
    return { spoken_summary: output.spoken_summary };
  }
  return { output };
}

function compactToolText(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '');
}

function normalizeChineseDisplayText(value) {
  let text = String(value || '');
  const replacements = [
    ['為', '为'],
    ['經', '经'],
    ['創', '创'],
    ['務', '务'],
    ['檢', '检'],
    ['語', '语'],
    ['遲', '迟'],
    ['優', '优'],
    ['級', '级'],
    ['氣', '气'],
    ['溫', '温'],
    ['雲', '云'],
    ['於', '于'],
    ['後', '后'],
    ['請', '请'],
    ['這', '这'],
    ['個', '个'],
    ['臺', '台'],
    ['灣', '湾'],
    ['讓', '让'],
  ];
  for (const [from, to] of replacements) {
    text = text.split(from).join(to);
  }
  return text
    .replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, '$1$2')
    .replace(/([\u3400-\u9fff])\s+([，。！？；：、])/g, '$1$2')
    .replace(/([（《“])\s+([\u3400-\u9fff])/g, '$1$2');
}

function controlIntentText(value) {
  return compactToolText(value).replace(/[，。！？；：、,.!?;:~～…'"“”‘’()（）[\]{}]/g, '');
}

function isControlOnlyUtterance(value) {
  const text = controlIntentText(value);
  return /^(等一下|等下|等等|稍等|让一下|停一下|停下|先停|暂停|打住|别说了|不要说了|先别说|先别讲|停|stop|wait|pause|holdon|onemoment|waitasecond|hangon)$/.test(text);
}

function hasWeatherIntent(text) {
  return /天气|气温|温度|下雨|降雨|刮风|多云|晴|阴|weather|forecast|temperature|rain|wind/.test(
    compactToolText(text),
  );
}

function hasMathIntent(text) {
  return /(\d|一|二|两|三|四|五|六|七|八|九|十|百|千|万).*(加|减|乘|除|乘以|除以|算|等于|等於|\+|-|\*|×|x|\/|÷|percent|percentage|calculate|math|plus|minus|times|divided)/i.test(
    compactToolText(text),
  );
}

function hasTaskIntent(text) {
  return /任务|待办|事项|清单|todo|task/i.test(compactToolText(text));
}

function hasTaskCreateIntent(text) {
  const compacted = compactToolText(text);
  return hasTaskIntent(compacted) && /创建|新建|新增|添加|记下|記下|create|add/i.test(compacted);
}

function hasTaskListIntent(text) {
  const compacted = compactToolText(text);
  return hasTaskIntent(compacted) && /列|查|看|显示|展示|list|show/i.test(compacted);
}

function shouldBlockDemoToolCall(name, args = {}, latestInputTranscript = '') {
  const text = compactToolText(latestInputTranscript);
  const argText = Object.values(args || {}).join(' ');
  if (isControlOnlyUtterance(latestInputTranscript) || isControlOnlyUtterance(argText)) {
    return {
      blocked: true,
      reason: 'control_utterance_without_tool_intent',
      latestInputTranscript,
    };
  }
  if (!text) return { blocked: false };
  if (name === 'get_weather') {
    const city = compactToolText(args.city);
    const cityMentioned = Boolean(city && text.includes(city));
    if (!hasWeatherIntent(text) && !cityMentioned) {
      return {
        blocked: true,
        reason: 'weather_without_user_intent',
        latestInputTranscript,
      };
    }
  }
  if (name === 'google_search') {
    const hasSearchIntent = /搜索|搜一下|查一下|查找|google|谷歌|search|look up|find|research/.test(text);
    if (!hasSearchIntent) {
      return {
        blocked: true,
        reason: 'search_without_user_intent',
        latestInputTranscript,
      };
    }
  }
  if (name === 'calculate_expression' && !hasMathIntent(text)) {
    return {
      blocked: true,
      reason: 'math_without_user_intent',
      latestInputTranscript,
    };
  }
  if (name === 'create_demo_task' && !hasTaskCreateIntent(text)) {
    return {
      blocked: true,
      reason: 'task_create_without_user_intent',
      latestInputTranscript,
    };
  }
  if (name === 'list_demo_tasks' && !hasTaskListIntent(text)) {
    return {
      blocked: true,
      reason: 'task_list_without_user_intent',
      latestInputTranscript,
    };
  }
  return { blocked: false };
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
  if (!config.credentialsConfigured || !isReadableFile(config.credentialsPath)) {
    throw new GeminiLiveConfigWarning(MISSING_CREDENTIALS_MESSAGE, MISSING_CREDENTIALS_CODE);
  }
  if (!config.project) {
    throw new GeminiLiveConfigWarning(
      'Gemini Live project is not configured. Set GOOGLE_CLOUD_PROJECT or include project_id in the Vertex credentials JSON.',
      'missing_vertex_project',
    );
  }
  let session = null;
  let closed = false;
  let readySent = false;
  let firstClientAudioAt = 0;
  let lastFlushAt = 0;
  let lastFlushReason = '';
  let lastEndpointMetrics = null;
  let lastToolResponseSentAt = 0;
  let lastNonBlockedToolResponseSentAt = 0;
  let lastToolNames = [];
  let responseWaitSequence = 0;
  let responseDelayTimer = null;
  let latestInputTranscript = '';
  let latestInputTranscriptAt = 0;
  let loggedFirstInputTranscript = false;
  let loggedFirstOutputAudioAfterFlush = false;
  let clientAudioTurnOpen = false;
  let activeClientTurnId = 0;
  const traceId = randomUUID().slice(0, 8);
  const voiceName = normalizeVoiceName(sessionOptions.voiceName);
  const realtimeTuning = normalizeRealtimeTuning({
    ...(sessionOptions.realtimeTuning || {}),
    realtimeMode: sessionOptions.realtimeMode || sessionOptions.realtimeTuning?.realtimeMode,
  });
  const sessionDemoTasks = new Map();
  const client = new GoogleGenAI({
    vertexai: true,
    project: config.project,
    location: config.location,
  });
  const logTrace = (event, fields = {}) => {
    console.info(`[GeminiLiveDemo] trace=${traceId} ${event} ${JSON.stringify(fields)}`);
  };
  const clearResponseDelayTimer = () => {
    if (responseDelayTimer) {
      clearTimeout(responseDelayTimer);
      responseDelayTimer = null;
    }
  };
  const responseLatencyPayload = () => ({
    endpointToAudioMs: lastFlushAt ? Date.now() - lastFlushAt : null,
    toolResponseToAudioMs: lastToolResponseSentAt ? Date.now() - lastToolResponseSentAt : null,
    reason: lastFlushReason || null,
    endpointMetrics: lastEndpointMetrics,
    toolNames: lastToolNames,
  });
  const scheduleResponseDelayWarning = (trigger) => {
    clearResponseDelayTimer();
    if (!lastFlushAt) return;
    const sequence = responseWaitSequence;
    const thresholdMs = responseDelayWarningMs();
    responseDelayTimer = setTimeout(() => {
      responseDelayTimer = null;
      if (closed || sequence !== responseWaitSequence || loggedFirstOutputAudioAfterFlush) return;
      const payload = {
        type: 'response_delay_warning',
        trigger,
        thresholdMs,
        ...responseLatencyPayload(),
      };
      console.warn(`[GeminiLiveDemo] trace=${traceId} response_delay_warning ${JSON.stringify(payload)}`);
      sendWsJson(ws, payload);
    }, thresholdMs);
    responseDelayTimer.unref?.();
  };
  const waitForGuardTranscript = async () => {
    const startedAt = Date.now();
    while (!latestInputTranscript && Date.now() - startedAt < 500) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return {
      text: latestInputTranscript,
      ageMs: latestInputTranscriptAt ? Date.now() - latestInputTranscriptAt : null,
      waitedMs: Date.now() - startedAt,
    };
  };
  const resetInputTranscriptForClientTurn = () => {
    firstClientAudioAt = 0;
    latestInputTranscript = '';
    latestInputTranscriptAt = 0;
    loggedFirstInputTranscript = false;
  };

  const close = () => {
    if (closed) return;
    closed = true;
    clearResponseDelayTimer();
    try {
      session?.close?.();
    } catch {
      // best effort
    }
  };

  session = await client.live.connect({
    model: config.model,
    config: makeLiveConfig({ ...sessionOptions, voiceName, realtimeMode: realtimeTuning.realtimeMode }),
    callbacks: {
      onopen: () => {
        logTrace('session_opened', { model: config.model, voiceName });
        logTrace('realtime_mode', {
          realtimeMode: realtimeTuning.realtimeMode,
          manualActivity: realtimeTuning.manualActivity,
          activityHandling: realtimeTuning.activityHandling,
          turnCoverage: realtimeTuning.turnCoverage,
        });
      },
      onmessage: (message) => {
        if (message.setupComplete) {
          const sessionId = message.setupComplete.sessionId || null;
          logTrace('setup_complete', { sessionId });
          sendWsJson(ws, { type: 'setup_complete', sessionId });
          if (!readySent) {
            readySent = true;
            sendWsJson(ws, {
              type: 'ready',
              model: config.model,
              voiceName,
              outputSampleRate: OUTPUT_SAMPLE_RATE,
              tools: publicToolCards(),
            });
          }
        }
        if (message.serverContent?.inputTranscription?.text) {
          latestInputTranscript = message.serverContent.inputTranscription.text;
          latestInputTranscriptAt = Date.now();
          const turnId = activeClientTurnId || lastEndpointMetrics?.turnId || null;
          if (!loggedFirstInputTranscript) {
            loggedFirstInputTranscript = true;
            logTrace('first_input_transcript', {
              turnId,
              chars: message.serverContent.inputTranscription.text.length,
              fromFirstClientAudioMs: firstClientAudioAt ? Date.now() - firstClientAudioAt : null,
              fromEndpointMs: lastFlushAt ? Date.now() - lastFlushAt : null,
            });
          }
          sendWsJson(ws, {
            type: 'input_transcript',
            turnId,
            text: message.serverContent.inputTranscription.text,
            finished: Boolean(message.serverContent.inputTranscription.finished),
          });
        }
        if (message.serverContent?.outputTranscription?.text) {
          sendWsJson(ws, {
            type: 'output_transcript',
            turnId: lastEndpointMetrics?.turnId || activeClientTurnId || null,
            text: normalizeChineseDisplayText(message.serverContent.outputTranscription.text),
          });
        }
        if (message.serverContent?.interrupted) {
          sendWsJson(ws, { type: 'interrupted' });
        }
        if (message.serverContent?.generationComplete) {
          sendWsJson(ws, { type: 'generation_complete' });
        }
        if (message.serverContent?.turnComplete) {
          if (!loggedFirstOutputAudioAfterFlush && !lastNonBlockedToolResponseSentAt) {
            clearResponseDelayTimer();
          }
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
          sendWsJson(ws, {
            type: 'text',
            turnId: lastEndpointMetrics?.turnId || activeClientTurnId || null,
            text: normalizeChineseDisplayText(text),
          });
        }
        for (const audio of extractAudioParts(message)) {
          if (lastFlushAt && !loggedFirstOutputAudioAfterFlush) {
            loggedFirstOutputAudioAfterFlush = true;
            logTrace('first_output_audio_after_endpoint', {
              bytes: audio.length,
              reason: lastFlushReason || null,
              endpointToAudioMs: Date.now() - lastFlushAt,
              toolResponseToAudioMs: lastToolResponseSentAt ? Date.now() - lastToolResponseSentAt : null,
              toolNames: lastToolNames,
            });
            sendWsJson(ws, {
              type: 'response_latency',
              ...responseLatencyPayload(),
            });
            clearResponseDelayTimer();
          }
          sendWsJson(ws, {
            type: 'audio',
            turnId: lastEndpointMetrics?.turnId || activeClientTurnId || null,
            audio,
            sampleRate: OUTPUT_SAMPLE_RATE,
          });
        }

        const calls = message.toolCall?.functionCalls || [];
        for (const call of calls) {
          const name = call.name || 'unknown';
          const callArgs = call.args || {};
          void (async () => {
            const guardTranscript = await waitForGuardTranscript();
            const guard = shouldBlockDemoToolCall(name, callArgs, guardTranscript.text);
            logTrace('tool_call', {
              name,
              fromEndpointMs: lastFlushAt ? Date.now() - lastFlushAt : null,
              transcriptWaitMs: guardTranscript.waitedMs,
              transcriptAgeMs: guardTranscript.ageMs,
              blocked: guard.blocked || undefined,
              reason: guard.blocked ? guard.reason : undefined,
            });
            if (guard.blocked) {
              const output = {
                error: 'blocked_tool_call',
                reason: guard.reason,
                message: 'The tool call was blocked because the latest user utterance did not clearly request it.',
              };
              const toolStartedAt = Date.now();
              sendWsJson(ws, {
                type: 'tool_blocked',
                id: call.id || null,
                name,
                args: callArgs,
                reason: guard.reason,
              });
              sendWsJson(ws, {
                type: 'tool_result',
                id: call.id || null,
                name,
                result: output,
                blocked: true,
                durationMs: 0,
              });
              try {
                session.sendToolResponse({
                  functionResponses: [
                    {
                      id: call.id,
                      name,
                      response: toolResponseForModel(output),
                    },
                  ],
                });
                lastToolResponseSentAt = Date.now();
                lastToolNames = [`blocked:${name}`];
                scheduleResponseDelayWarning('blocked_tool_response');
                logTrace('tool_response_sent', {
                  name,
                  blocked: true,
                  responseBytes: Buffer.byteLength(JSON.stringify(output), 'utf8'),
                  durationMs: Date.now() - toolStartedAt,
                });
              } catch (error) {
                sendWsJson(ws, { type: 'error', message: `Tool response failed: ${error.message || error}` });
              }
              return;
            }
            sendWsJson(ws, {
              type: 'tool_call',
              id: call.id || null,
              name,
              args: callArgs,
            });
            let output;
            const toolStartedAt = Date.now();
            try {
              output = await runDemoTool(name, callArgs, { demoTasks: sessionDemoTasks });
            } catch (error) {
              output = { error: error.message || String(error) };
            }
            const toolDurationMs = Date.now() - toolStartedAt;
            sendWsJson(ws, {
              type: 'tool_result',
              id: call.id || null,
              name,
              result: output,
              durationMs: toolDurationMs,
            });
            if (output && typeof output === 'object' && typeof output.spoken_summary === 'string') {
              sendWsJson(ws, {
                type: 'tool_summary',
                id: call.id || null,
                name,
                text: output.spoken_summary,
              });
            }
            try {
              const responseBytes = Buffer.byteLength(JSON.stringify(output || {}), 'utf8');
              session.sendToolResponse({
                functionResponses: [
                  {
                    id: call.id,
                    name,
                    response: toolResponseForModel(output),
                  },
                ],
              });
              lastToolResponseSentAt = Date.now();
              lastNonBlockedToolResponseSentAt = lastToolResponseSentAt;
              lastToolNames = [name];
              scheduleResponseDelayWarning('tool_response');
              logTrace('tool_response_sent', { name, responseBytes, durationMs: toolDurationMs });
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
      if (!clientAudioTurnOpen) {
        clientAudioTurnOpen = true;
        resetInputTranscriptForClientTurn();
        logTrace('client_audio_turn_start', { bytes: chunk.length });
      }
      if (!firstClientAudioAt) {
        firstClientAudioAt = Date.now();
        logTrace('first_client_audio', { bytes: chunk.length });
      }
      session.sendRealtimeInput({ audio: makeAudioPayload(chunk) });
    },
    sendEnd() {
      if (closed || !session) return;
      clientAudioTurnOpen = false;
      session.sendRealtimeInput({ audioStreamEnd: true });
    },
    flushAudioStream(meta = {}) {
      if (closed || !session) return;
      clientAudioTurnOpen = false;
      lastFlushAt = Date.now();
      lastFlushReason = String(meta.reason || 'client_silence').slice(0, 80);
      lastEndpointMetrics = meta.metrics || null;
      lastToolResponseSentAt = 0;
      lastNonBlockedToolResponseSentAt = 0;
      lastToolNames = [];
      responseWaitSequence += 1;
      loggedFirstOutputAudioAfterFlush = false;
      logTrace('client_endpoint', {
        reason: lastFlushReason,
        metrics: meta.metrics || null,
      });
      scheduleResponseDelayWarning('endpoint');
      session.sendRealtimeInput({ audioStreamEnd: true });
    },
    activityStart(meta = {}) {
      if (closed || !session) return;
      clientAudioTurnOpen = true;
      const metrics = meta.metrics || {};
      activeClientTurnId = Number(metrics.turnId) || 0;
      resetInputTranscriptForClientTurn();
      logTrace('client_activity_start', {
        reason: String(meta.reason || 'manual_activity').slice(0, 80),
        metrics,
      });
      session.sendRealtimeInput({ activityStart: {} });
    },
    activityEnd(meta = {}) {
      if (closed || !session) return;
      clientAudioTurnOpen = false;
      lastFlushAt = Date.now();
      lastFlushReason = String(meta.reason || 'manual_activity').slice(0, 80);
      lastEndpointMetrics = meta.metrics || null;
      lastToolResponseSentAt = 0;
      lastNonBlockedToolResponseSentAt = 0;
      lastToolNames = [];
      responseWaitSequence += 1;
      loggedFirstOutputAudioAfterFlush = false;
      logTrace('client_activity_end', {
        reason: lastFlushReason,
        metrics: meta.metrics || null,
      });
      scheduleResponseDelayWarning('endpoint');
      session.sendRealtimeInput({ activityEnd: {} });
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
    credentialsConfigured: Boolean(config.credentialsConfigured),
    projectConfigured: Boolean(config.project),
    warning: config.credentialsConfigured ? null : MISSING_CREDENTIALS_CODE,
    inputSampleRate: INPUT_SAMPLE_RATE,
    outputSampleRate: OUTPUT_SAMPLE_RATE,
    micGate: makeMicGateConfig(),
    responseDelayWarningMs: responseDelayWarningMs(),
    realtimeTuning: normalizeRealtimeTuning(),
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
    .mode-switch {
      margin-top: 14px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px;
      padding: 4px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: #eef2f7;
    }
    .mode-switch button {
      min-height: 36px;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      font-size: 13px;
      font-weight: 720;
    }
    .mode-switch button.active {
      background: var(--panel);
      color: var(--accent-strong);
      box-shadow: 0 2px 7px rgba(23, 33, 50, 0.12);
    }
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
    .tuning {
      margin-top: 16px;
      padding-top: 14px;
      border-top: 1px solid var(--line);
      display: grid;
      gap: 12px;
    }
    .tuning-title {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 10px;
    }
    .tuning-title strong {
      font-size: 13px;
      font-weight: 760;
    }
    .tuning-title span {
      color: var(--muted);
      font-size: 12px;
    }
    .segmented {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 6px;
    }
    .segment {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fbfcfe;
      color: var(--text);
      cursor: pointer;
      min-height: 42px;
      display: grid;
      place-items: center;
      font-size: 13px;
      font-weight: 680;
    }
    .segment.active {
      border-color: var(--accent);
      background: #f3f7ff;
      color: var(--accent-strong);
    }
    .tuning-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .mini-field {
      display: grid;
      gap: 6px;
    }
    .mini-field label {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.3;
    }
    .mini-field input {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      color: var(--text);
      padding: 8px 9px;
      outline: none;
    }
    .mini-field input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(23, 105, 224, 0.12);
    }
    .tuning-note {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }
    .metric-row {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 8px;
    }
    .metric {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px;
      background: #fbfcfe;
      min-width: 0;
    }
    .metric span {
      display: block;
      color: var(--muted);
      font-size: 11px;
      line-height: 1.25;
    }
    .metric strong {
      display: block;
      margin-top: 4px;
      font-size: 13px;
      line-height: 1.25;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
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
    .entry.warning { border-left: 4px solid var(--warn); color: #7a3d00; background: #fff8ed; }
    .entry.error { border-left: 4px solid var(--danger); color: var(--danger); background: #fff7f5; }
    .entry .label {
      display: block;
      color: var(--muted);
      font-size: 12px;
      margin-bottom: 4px;
      font-weight: 700;
    }
    .entry .timestamp {
      color: #667085;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-weight: 600;
      margin-right: 6px;
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
      .tuning-grid { grid-template-columns: 1fr; }
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
          <div class="mode-switch" id="realtimeModeButtons" role="group" aria-label="实时模式">
            <button type="button" data-mode="manual">当前模式</button>
            <button type="button" data-mode="native_vad">原生 VAD</button>
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
          <div class="tuning" aria-label="实时对话调节">
            <div class="tuning-title">
              <strong>对话节奏</strong>
              <span id="profileSummary">均衡</span>
            </div>
            <div class="segmented" id="turnProfileButtons" role="group" aria-label="对话节奏">
              <button class="segment" type="button" data-profile="responsive">灵敏</button>
              <button class="segment" type="button" data-profile="balanced">均衡</button>
              <button class="segment" type="button" data-profile="patient">耐心</button>
            </div>
            <div class="tuning-grid">
              <div class="mini-field">
                <label for="shortPauseMs">短句结束等待 ms</label>
                <input id="shortPauseMs" type="number" min="200" max="900" step="20">
              </div>
              <div class="mini-field">
                <label for="thinkingPauseMs">思考停顿等待 ms</label>
                <input id="thinkingPauseMs" type="number" min="700" max="2200" step="50">
              </div>
              <div class="mini-field">
                <label for="bargeInMs">打断需连续说话 ms</label>
                <input id="bargeInMs" type="number" min="220" max="900" step="20">
              </div>
              <div class="mini-field">
                <label for="bargeInRms">打断音量阈值 RMS</label>
                <input id="bargeInRms" type="number" min="0.015" max="0.09" step="0.001">
              </div>
            </div>
            <div class="metric-row">
              <div class="metric"><span>语音状态</span><strong id="speechStateText">空闲</strong></div>
              <div class="metric"><span>端点等待</span><strong id="endpointWaitText">--</strong></div>
              <div class="metric"><span>最近延迟</span><strong id="latencyText">--</strong></div>
            </div>
            <div class="metric-row">
              <div class="metric"><span>噪声底 RMS</span><strong id="noiseFloorText">--</strong></div>
              <div class="metric"><span>动态阈值</span><strong id="noiseThresholdText">--</strong></div>
              <div class="metric"><span>抗噪保护</span><strong id="noiseGuardText">关闭</strong></div>
            </div>
            <div class="tuning-note">
              自适应端点会根据 ASR 片段判断短句、长句和思考停顿；分级打断会过滤环境声，只有连续人声或明确打断词才停止当前回复。
            </div>
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
    const calculateGeminiLiveMicGateFrame = ${calculateGeminiLiveMicGateFrame.toString()};
    const updateGeminiLiveNoiseBaseline = ${updateGeminiLiveNoiseBaseline.toString()};
    const updateGeminiLiveTurnStorm = ${updateGeminiLiveTurnStorm.toString()};
    const decideGeminiLiveEndpoint = ${decideGeminiLiveEndpoint.toString()};
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
    const realtimeModeButtons = document.getElementById('realtimeModeButtons');
    const turnProfileButtons = document.getElementById('turnProfileButtons');
    const profileSummary = document.getElementById('profileSummary');
    const shortPauseMsInput = document.getElementById('shortPauseMs');
    const thinkingPauseMsInput = document.getElementById('thinkingPauseMs');
    const bargeInMsInput = document.getElementById('bargeInMs');
    const bargeInRmsInput = document.getElementById('bargeInRms');
    const speechStateText = document.getElementById('speechStateText');
    const endpointWaitText = document.getElementById('endpointWaitText');
    const latencyText = document.getElementById('latencyText');
    const noiseFloorText = document.getElementById('noiseFloorText');
    const noiseThresholdText = document.getElementById('noiseThresholdText');
    const noiseGuardText = document.getElementById('noiseGuardText');

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
    let activeProfile = localStorage.getItem('gemini-live-demo-turn-profile') || 'balanced';
    let realtimeMode = localStorage.getItem('gemini-live-demo-realtime-mode') === 'native_vad' ? 'native_vad' : 'manual';
    let sessionRealtimeMode = realtimeMode;
    let userSpeaking = false;
    let acceptedBargeIn = false;
    let utteranceStartedAt = 0;
    let lastVoiceAt = 0;
    let lastEndpointAt = 0;
    let latestInputTranscript = '';
    let latestInputTranscriptAt = 0;
    let firstAudioRequestedAt = 0;
    let assistantSpeakingAt = 0;
    let lastBargeInNoticeAt = 0;
    let lastNoiseNoticeAt = 0;
    let observedTurnCounter = 0;
    let currentTurnId = 0;
    let currentTurnAudioStarted = false;
    let currentTurnAudioFrames = 0;
    let currentTurnAudioBytes = 0;
    let currentTurnSubmitted = false;
    let pendingResponseTurnId = 0;
    let adaptiveNoiseState = { initialized: false, rms: 0, peak: 0, samples: 0 };
    let turnStormState = { active: false, events: [], guardUntilMs: 0, remainingMs: 0 };
    let reconnectState = { attempts: 0, firstAttemptAt: 0, pending: false, timer: null, manualStop: false };
    let conversationMemory = [];
    let nativeVadStreamStarted = false;
    let nativeVadTailFrames = 0;
    const turnTimings = new Map();

    // TODO(phase-2): add multi-speaker diarization or voice verification before
    // supporting "only follow the primary speaker" in mixed-room conversations.
    const TURN_PROFILES = {
      responsive: {
        label: '灵敏',
        summary: '短句优先，适合命令和快问快答',
        shortPauseMs: 320,
        thinkingPauseMs: 900,
        bargeInMs: 320,
        idleRms: 0.01,
        idlePeak: 0.045,
        bargeInRms: 0.038,
        bargeInPeak: 0.145,
        minNoTranscriptSpeechMs: 650,
        noTranscriptGraceMs: 1100,
        serverSilenceMs: 450,
        prefixPaddingMs: 140,
        startSensitivity: 'START_SENSITIVITY_LOW',
        endSensitivity: 'END_SENSITIVITY_HIGH',
      },
      balanced: {
        label: '均衡',
        summary: '兼顾思考停顿和响应速度',
        shortPauseMs: 460,
        thinkingPauseMs: 1250,
        bargeInMs: 420,
        idleRms: 0.01,
        idlePeak: 0.045,
        bargeInRms: 0.042,
        bargeInPeak: 0.16,
        minNoTranscriptSpeechMs: 750,
        noTranscriptGraceMs: 1400,
        serverSilenceMs: 650,
        prefixPaddingMs: 180,
        startSensitivity: 'START_SENSITIVITY_LOW',
        endSensitivity: 'END_SENSITIVITY_LOW',
      },
      patient: {
        label: '耐心',
        summary: '更愿意等待长句和犹豫停顿',
        shortPauseMs: 620,
        thinkingPauseMs: 1650,
        bargeInMs: 540,
        idleRms: 0.011,
        idlePeak: 0.05,
        bargeInRms: 0.048,
        bargeInPeak: 0.18,
        minNoTranscriptSpeechMs: 900,
        noTranscriptGraceMs: 1700,
        serverSilenceMs: 950,
        prefixPaddingMs: 220,
        startSensitivity: 'START_SENSITIVITY_LOW',
        endSensitivity: 'END_SENSITIVITY_LOW',
      },
    };

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

    function clamp(value, min, max, fallback) {
      const number = Number(value);
      if (!Number.isFinite(number)) return fallback;
      return Math.min(max, Math.max(min, number));
    }

    function profileDefaults() {
      return TURN_PROFILES[activeProfile] || TURN_PROFILES.balanced;
    }

    function storageKey(name) {
      return 'gemini-live-demo-' + activeProfile + '-' + name;
    }

    function readTuning() {
      const defaults = profileDefaults();
      return {
        profile: activeProfile,
        label: defaults.label,
        summary: defaults.summary,
        shortPauseMs: clamp(shortPauseMsInput.value, 200, 900, defaults.shortPauseMs),
        thinkingPauseMs: clamp(thinkingPauseMsInput.value, 700, 2200, defaults.thinkingPauseMs),
        bargeInMs: clamp(bargeInMsInput.value, 220, 900, defaults.bargeInMs),
        idleRms: defaults.idleRms ?? MIC_GATE.idleRms ?? 0.01,
        idlePeak: defaults.idlePeak ?? MIC_GATE.idlePeak ?? 0.045,
        bargeInRms: clamp(bargeInRmsInput.value, 0.015, 0.09, defaults.bargeInRms),
        bargeInPeak: defaults.bargeInPeak ?? MIC_GATE.bargeInPeak ?? 0.16,
        minNoTranscriptSpeechMs: defaults.minNoTranscriptSpeechMs ?? 1000,
        noTranscriptGraceMs: defaults.noTranscriptGraceMs ?? 1400,
        startFrames: MIC_GATE.startFrames || 3,
        holdFrames: MIC_GATE.holdFrames || 16,
        preRollFrames: MIC_GATE.preRollFrames || 4,
        noiseRmsMultiplier: 2.6,
        noisePeakMultiplier: 2.4,
        noiseGuardMultiplier: 1.35,
        serverSilenceMs: defaults.serverSilenceMs,
        prefixPaddingMs: defaults.prefixPaddingMs,
        startSensitivity: defaults.startSensitivity,
        endSensitivity: defaults.endSensitivity,
      };
    }

    function renderTuning() {
      if (!TURN_PROFILES[activeProfile]) activeProfile = 'balanced';
      const defaults = profileDefaults();
      const fields = [
        ['shortPauseMs', shortPauseMsInput],
        ['thinkingPauseMs', thinkingPauseMsInput],
        ['bargeInMs', bargeInMsInput],
        ['bargeInRms', bargeInRmsInput],
      ];
      for (const [name, input] of fields) {
        input.value = localStorage.getItem(storageKey(name)) || defaults[name];
      }
      for (const button of turnProfileButtons.querySelectorAll('[data-profile]')) {
        button.classList.toggle('active', button.dataset.profile === activeProfile);
      }
      profileSummary.textContent = defaults.label + ' · ' + defaults.summary;
      updateSpeechMetrics('空闲', '--');
      updateNoiseMetrics();
      renderRealtimeMode();
    }

    function renderRealtimeMode() {
      for (const button of realtimeModeButtons.querySelectorAll('[data-mode]')) {
        button.classList.toggle('active', button.dataset.mode === realtimeMode);
      }
    }

    function saveTuningField(event) {
      const input = event.target;
      if (!input?.id) return;
      localStorage.setItem(storageKey(input.id), input.value);
      profileSummary.textContent = readTuning().label + ' · ' + readTuning().summary;
    }

    function makeRealtimeTuning(mode = realtimeMode) {
      const tuning = readTuning();
      const nativeVad = mode === 'native_vad';
      return {
        realtimeMode: mode,
        manualActivity: !nativeVad,
        activityMode: nativeVad ? 'native_vad' : 'manual',
        silenceDurationMs: tuning.serverSilenceMs,
        prefixPaddingMs: tuning.prefixPaddingMs,
        startSensitivity: tuning.startSensitivity,
        endSensitivity: tuning.endSensitivity,
        activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
        turnCoverage: nativeVad ? 'TURN_INCLUDES_ALL_INPUT' : 'TURN_INCLUDES_ONLY_ACTIVITY',
      };
    }

    function selectedSessionOptions(options = {}) {
      const mode = options.mode || realtimeMode;
      const baseInstruction = promptInput.value || CONFIG.defaultSystemInstruction;
      const contextSuffix = options.includeReconnectContext && conversationMemory.length
        ? '\\n\\nRecent conversation context before reconnect:\\n' + conversationMemory
          .slice(-6)
          .map((item) => '- ' + item.role + ': ' + item.text)
          .join('\\n')
        : '';
      return {
        voiceName: voiceSelect.value || CONFIG.defaultVoiceName,
        systemInstruction: baseInstruction + contextSuffix,
        realtimeMode: mode,
        realtimeTuning: makeRealtimeTuning(mode),
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

    realtimeModeButtons.addEventListener('click', (event) => {
      const button = event.target.closest('[data-mode]');
      if (!button) return;
      realtimeMode = button.dataset.mode === 'native_vad' ? 'native_vad' : 'manual';
      localStorage.setItem('gemini-live-demo-realtime-mode', realtimeMode);
      renderRealtimeMode();
      if (running) {
        addEntry('system', '模式切换', '已切换为“' + (realtimeMode === 'native_vad' ? '原生 VAD' : '当前模式') + '”，下次开始实时对话时生效。');
      }
    });

    turnProfileButtons.addEventListener('click', (event) => {
      const button = event.target.closest('[data-profile]');
      if (!button) return;
      activeProfile = button.dataset.profile;
      localStorage.setItem('gemini-live-demo-turn-profile', activeProfile);
      renderTuning();
    });

    for (const input of [shortPauseMsInput, thinkingPauseMsInput, bargeInMsInput, bargeInRmsInput]) {
      input.addEventListener('change', saveTuningField);
      input.addEventListener('input', saveTuningField);
    }

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

    function updateSpeechMetrics(state, endpointWait) {
      speechStateText.textContent = state;
      endpointWaitText.textContent = endpointWait;
    }

    function updateNoiseMetrics(gate = null) {
      noiseFloorText.textContent = adaptiveNoiseState.initialized
        ? adaptiveNoiseState.rms.toFixed(4)
        : '--';
      noiseThresholdText.textContent = gate && Number.isFinite(Number(gate.rmsThreshold))
        ? Number(gate.rmsThreshold).toFixed(4)
        : '--';
      noiseGuardText.textContent = turnStormState.active
        ? Math.ceil((turnStormState.remainingMs || 0) / 1000) + 's'
        : '关闭';
    }

    function markLatency(text) {
      latencyText.textContent = text;
    }

    function timestampLabel(date = new Date()) {
      const pad = (value, length = 2) => String(value).padStart(length, '0');
      return [
        pad(date.getHours()),
        pad(date.getMinutes()),
        pad(date.getSeconds()),
      ].join(':') + '.' + pad(date.getMilliseconds(), 3);
    }

    function formatMs(value) {
      const number = Number(value);
      return Number.isFinite(number) ? Math.max(0, Math.round(number)) + 'ms' : '--';
    }

    function formatBytes(bytes) {
      const number = Number(bytes) || 0;
      if (number >= 1024 * 1024) return (number / 1024 / 1024).toFixed(1) + ' MB';
      if (number >= 1024) return Math.round(number / 1024) + ' KB';
      return Math.round(number) + ' B';
    }

    function turnLabel(turnId = currentTurnId) {
      return turnId ? '#' + turnId : '#?';
    }

    function endpointSummary(metrics = {}) {
      const parts = [];
      if (Number.isFinite(Number(metrics.audioBytes))) parts.push('音频 ' + formatBytes(metrics.audioBytes));
      if (Number.isFinite(Number(metrics.audioDurationMs))) parts.push('音频约 ' + Math.round(metrics.audioDurationMs) + 'ms');
      if (Number.isFinite(Number(metrics.speechDurationMs))) parts.push('语音 ' + Math.round(metrics.speechDurationMs) + 'ms');
      if (Number.isFinite(Number(metrics.transcriptChars))) parts.push('转写字符 ' + Math.round(metrics.transcriptChars));
      return parts.join('，') || '暂无 metrics';
    }

    function currentAudioDurationMs() {
      const bytesPerSecond = Number(CONFIG.inputSampleRate || 16000) * 2;
      return bytesPerSecond > 0 ? (currentTurnAudioBytes / bytesPerSecond) * 1000 : 0;
    }

    function ensureTurnTiming(turnId = currentTurnId) {
      const id = Number(turnId);
      if (!Number.isFinite(id) || id <= 0) return null;
      if (!turnTimings.has(id)) turnTimings.set(id, { turnId: id });
      return turnTimings.get(id);
    }

    function markTurnStage(turnId, stage, now = performance.now()) {
      const timing = ensureTurnTiming(turnId);
      if (!timing) return null;
      if (!Number.isFinite(timing[stage])) timing[stage] = now;
      return timing;
    }

    function timingText(turnId, segments = []) {
      const timing = ensureTurnTiming(turnId);
      if (!timing) return '';
      const parts = [];
      for (const [label, from, to] of segments) {
        if (Number.isFinite(timing[from]) && Number.isFinite(timing[to])) {
          parts.push(label + ' ' + formatMs(timing[to] - timing[from]));
        }
      }
      return parts.length ? '耗时：' + parts.join('，') + '。' : '';
    }

    function endpointTimingText(turnId) {
      return timingText(turnId, [
        ['检测→首帧', 'detectedAt', 'firstPcmAt'],
        ['首帧→端点', 'firstPcmAt', 'endpointSentAt'],
        ['检测→端点', 'detectedAt', 'endpointSentAt'],
      ]);
    }

    function beginObservedTurn(now, source, options = {}) {
      const sendActivityStart = options.sendActivityStart !== false;
      observedTurnCounter += 1;
      currentTurnId = observedTurnCounter;
      currentTurnAudioStarted = false;
      currentTurnAudioFrames = 0;
      currentTurnAudioBytes = 0;
      currentTurnSubmitted = false;
      latestInputTranscript = '';
      latestInputTranscriptAt = 0;
      turnTimings.set(currentTurnId, { turnId: currentTurnId, detectedAt: now });
      while (turnTimings.size > MAX_LOG_ENTRIES) {
        turnTimings.delete(turnTimings.keys().next().value);
      }
      addEntry('system', '实时输入', turnLabel() + ' 本地检测到' + source + '，接下来 PCM 音频会边说边流式发送到 Gemini。');
      if (sendActivityStart && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'activity_start',
          reason: source,
          metrics: { turnId: currentTurnId },
        }));
        addEntry('system', '活动开始', turnLabel() + ' 已发送 activityStart；Gemini 将把后续 PCM 视为这一轮用户语音。');
      }
    }

    function currentEndpointMetrics(metrics = {}) {
      return {
        ...metrics,
        turnId: currentTurnId,
        audioFrames: currentTurnAudioFrames,
        audioBytes: currentTurnAudioBytes,
        audioDurationMs: currentAudioDurationMs(),
        audioStreamed: currentTurnAudioStarted ? 1 : 0,
      };
    }

    function latencyLabel(message) {
      const endpointMs = Number(message?.endpointToAudioMs);
      const toolMs = Number(message?.toolResponseToAudioMs);
      const parts = [];
      if (Number.isFinite(endpointMs)) parts.push('端点 ' + endpointMs + 'ms');
      if (Number.isFinite(toolMs)) parts.push('工具后 ' + toolMs + 'ms');
      return parts.join(' · ') || '--';
    }

    function delayWarningLabel(message) {
      const thresholdMs = Number(message?.thresholdMs || CONFIG.responseDelayWarningMs || 2500);
      return '>' + Math.round(thresholdMs / 100) / 10 + 's';
    }

    function containsInterruptionPhrase(text) {
      return /(等一下|停一下|先停|打住|别说了|暂停|stop|wait|hold on|不是|不对|等等)/i.test(String(text || ''));
    }

    function looksLikeThinkingPause(text, speechDurationMs, transcriptAgeMs) {
      const normalized = String(text || '')
        .replace(/\s+/g, '')
        .replace(/[。！？?!]+$/g, '');
      if (!normalized) return speechDurationMs > 4500;
      if (transcriptAgeMs > 1500 && speechDurationMs < 6500) return false;
      if (/[，、,;；:：]$/.test(String(text || '').trim())) return true;
      return /(然后|就是|比如|我想|我觉得|那个|呃|嗯|额|还有|接着|因为|如果|但是|以及|或者|先|帮我|你能不能|我希望|怎么说)$/.test(normalized);
    }

    function endpointWaitForTranscript(text, speechDurationMs) {
      const tuning = readTuning();
      const transcriptAgeMs = latestInputTranscriptAt > 0 ? performance.now() - latestInputTranscriptAt : Infinity;
      if (looksLikeThinkingPause(text, speechDurationMs, transcriptAgeMs)) return tuning.thinkingPauseMs;
      if (speechDurationMs > 6500 && !/[。！？?!]$/.test(String(text || '').trim())) {
        return Math.max(tuning.shortPauseMs, Math.round(tuning.thinkingPauseMs * 0.75));
      }
      return tuning.shortPauseMs;
    }

    function sendEndpoint(reason, metrics = {}) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const now = performance.now();
      if (now - lastEndpointAt < 600) return;
      lastEndpointAt = now;
      firstAudioRequestedAt = now;
      const enrichedMetrics = currentEndpointMetrics(metrics);
      currentTurnSubmitted = true;
      pendingResponseTurnId = currentTurnId;
      markTurnStage(currentTurnId, 'endpointSentAt', now);
      ws.send(JSON.stringify({ type: 'activity_end', reason, metrics: enrichedMetrics }));
      addEntry(
        'system',
        '提交给 Gemini',
        turnLabel() + ' 已发送 activityEnd；' + endpointSummary(enrichedMetrics) + '。' + endpointTimingText(currentTurnId) + '等待 Gemini 输出。',
      );
      updateSpeechMetrics('等待模型', reason);
    }

    function notifyNoiseGuard(reason, active, state = turnStormState) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'noise_guard',
          active: Boolean(active),
          reason,
          remainingMs: state.remainingMs || 0,
          events: Array.isArray(state.events) ? state.events.length : 0,
        }));
      }
    }

    function recordTurnStormEvent(event, metrics = {}, reason = '') {
      const previousActive = Boolean(turnStormState.active);
      turnStormState = updateGeminiLiveTurnStorm({
        state: turnStormState,
        event,
        nowMs: performance.now(),
      });
      updateNoiseMetrics();
      if (!previousActive && turnStormState.active) {
        addEntry('warning', '抗噪保护', '检测到连续短音频或无转写输入，已进入 ' + Math.ceil(turnStormState.remainingMs / 1000) + ' 秒抗噪保护。');
        notifyNoiseGuard(reason || 'turn_storm', true);
      } else if (previousActive && !turnStormState.active) {
        addEntry('system', '抗噪保护', '已收到有效语音或模型输出，抗噪保护解除。');
        notifyNoiseGuard(reason || 'success', false);
      }
    }

    function rememberConversation(role, text) {
      const normalized = String(text || '').replace(/\\s+/g, ' ').trim();
      if (!normalized) return;
      conversationMemory.push({ role, text: normalized.slice(0, 220) });
      if (conversationMemory.length > 6) conversationMemory = conversationMemory.slice(-6);
    }

    function addEntry(kind, label, text) {
      const entry = document.createElement('div');
      entry.className = 'entry ' + kind;
      const labelEl = document.createElement('span');
      labelEl.className = 'label';
      const timestampEl = document.createElement('span');
      timestampEl.className = 'timestamp';
      timestampEl.textContent = timestampLabel();
      labelEl.append(timestampEl, document.createTextNode(label));
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
      userSpeaking = false;
      acceptedBargeIn = false;
      utteranceStartedAt = 0;
      lastVoiceAt = 0;
      lastEndpointAt = 0;
      latestInputTranscript = '';
      latestInputTranscriptAt = 0;
      firstAudioRequestedAt = 0;
      assistantSpeakingAt = 0;
      currentTurnId = 0;
      currentTurnAudioStarted = false;
      currentTurnAudioFrames = 0;
      currentTurnAudioBytes = 0;
      currentTurnSubmitted = false;
      pendingResponseTurnId = 0;
      adaptiveNoiseState = { initialized: false, rms: 0, peak: 0, samples: 0 };
      turnStormState = { active: false, events: [], guardUntilMs: 0, remainingMs: 0 };
      nativeVadStreamStarted = false;
      nativeVadTailFrames = 0;
      updateSpeechMetrics('空闲', '--');
      updateNoiseMetrics();
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
        const now = performance.now();
        const tuning = readTuning();
        const input = event.inputBuffer.getChannelData(0);
        const stats = measureAudio(input);
        meterFill.style.width = Math.min(100, Math.round(stats.peak * 140)) + '%';
        const downsampled = downsampleBuffer(input, context.sampleRate, CONFIG.inputSampleRate);
        const pcm = float32ToInt16Pcm(downsampled);
        const assistantAudioPlaying = isAssistantAudioPlaying(context);
        const frameMs = (event.inputBuffer.length / context.sampleRate) * 1000;
        const wasNoiseGuardActive = Boolean(turnStormState.active);
        turnStormState = updateGeminiLiveTurnStorm({
          state: turnStormState,
          event: 'tick',
          nowMs: now,
        });
        if (wasNoiseGuardActive && !turnStormState.active) {
          addEntry('system', '抗噪保护', '保护窗口已结束，恢复常规收音。');
          notifyNoiseGuard('expired', false);
        }
        const gate = calculateGeminiLiveMicGateFrame({
          stats,
          tuning,
          noiseState: adaptiveNoiseState,
          turnStormState,
          nowMs: now,
          frameMs,
          micSpeechFrames,
          assistantAudioPlaying,
          acceptedBargeIn,
        });
        const active = gate.active;
        adaptiveNoiseState = updateGeminiLiveNoiseBaseline({
          state: adaptiveNoiseState,
          stats,
          userSpeaking,
          assistantAudioPlaying,
          acceptedBargeIn,
          candidateBargeIn: gate.candidateBargeIn || gate.active,
        });
        updateNoiseMetrics(gate);
        if (sessionRealtimeMode === 'native_vad') {
          const tailFrames = Math.max(
            tuning.holdFrames,
            Math.ceil((tuning.serverSilenceMs + 350) / frameMs),
          );
          if (!nativeVadStreamStarted) {
            nativeVadStreamStarted = true;
            addEntry('system', '原生 VAD', '已启用本地噪声门控；只把高置信人声交给 Gemini Live，由 Gemini 判断说话开始和结束。');
          }
          micSpeechFrames = gate.nextSpeechFrames;
          if (!userSpeaking && gate.shouldStartUserSpeech) {
            beginObservedTurn(now, '原生 VAD 人声', { sendActivityStart: false });
            userSpeaking = true;
            utteranceStartedAt = now - (gate.requiredStartFrames * frameMs);
            lastVoiceAt = now;
            nativeVadTailFrames = tailFrames;
            if (micPreRoll.length > 0) {
              for (const frame of micPreRoll) ws.send(frame);
              micPreRoll = [];
            }
            addEntry('system', '原生 VAD 音频门控', '检测到连续人声，开始向 Gemini Live 发送真实音频。');
          }
          if (active && userSpeaking) {
            lastVoiceAt = now;
            nativeVadTailFrames = tailFrames;
            updateSpeechMetrics('原生 VAD 收音中', '--');
          }
          if (userSpeaking) {
            if (active) {
              ws.send(pcm);
            } else if (nativeVadTailFrames > 0) {
              ws.send(new ArrayBuffer(pcm.byteLength));
              nativeVadTailFrames -= 1;
              updateSpeechMetrics('原生 VAD 静音收尾', Math.round(nativeVadTailFrames * frameMs) + 'ms');
            } else {
              userSpeaking = false;
              acceptedBargeIn = false;
              micSpeechFrames = 0;
              nativeVadTailFrames = 0;
              micPreRoll = [];
              updateSpeechMetrics('等待 Gemini 原生 VAD', '--');
              addEntry('system', '原生 VAD 音频门控', '已停止发送环境音，等待 Gemini Live 判定本轮结束并回复。');
            }
          } else {
            micPreRoll.push(pcm);
            while (micPreRoll.length > tuning.preRollFrames) micPreRoll.shift();
          }
          return;
        }
        const sendPcm = (buffer) => {
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          if (!currentTurnAudioStarted) {
            currentTurnAudioStarted = true;
            markTurnStage(currentTurnId, 'firstPcmAt', now);
            addEntry(
              'system',
              '音频流',
              turnLabel() + ' 首段 PCM 已通过服务端实时转发给 Gemini；' + timingText(currentTurnId, [
                ['检测→首帧', 'detectedAt', 'firstPcmAt'],
              ]) + 'Gemini 若识别到内容，会返回 inputTranscription。',
            );
          }
          currentTurnAudioFrames += 1;
          currentTurnAudioBytes += buffer?.byteLength || 0;
          ws.send(buffer);
        };

        micSpeechFrames = gate.nextSpeechFrames;

        if (gate.candidateBargeIn) {
          updateSpeechMetrics('候选打断', gate.heardMs + '/' + tuning.bargeInMs + 'ms');
        }

        if (gate.shouldDeferForBargeIn) {
          micPreRoll.push(pcm);
          while (micPreRoll.length > tuning.preRollFrames) micPreRoll.shift();
          return;
        }

        if (gate.shouldAcceptBargeIn) {
          if (!userSpeaking) beginObservedTurn(now, '打断语音');
          acceptedBargeIn = true;
          userSpeaking = true;
          utteranceStartedAt = now - (gate.requiredStartFrames * frameMs);
          lastVoiceAt = now;
          clearPlayback();
          if (now - lastBargeInNoticeAt > 1200) {
            addEntry('system', '分级打断', '检测到连续人声，已停止当前回复并开始听你说。');
            lastBargeInNoticeAt = now;
          }
        }

        if (!userSpeaking && gate.shouldStartUserSpeech) {
          beginObservedTurn(now, '人声');
          userSpeaking = true;
          utteranceStartedAt = now;
          lastEndpointAt = 0;
          updateSpeechMetrics('正在听你说', '--');
        }

        if (active && userSpeaking) {
          lastVoiceAt = now;
          updateSpeechMetrics(acceptedBargeIn ? '打断中' : '正在听你说', '--');
        }

        let shouldSend = micHoldFrames > 0;
        if (gate.shouldStartUserSpeech) {
          if (micHoldFrames === 0 && micPreRoll.length > 0) {
            for (const frame of micPreRoll) sendPcm(frame);
          }
          shouldSend = true;
          micHoldFrames = tuning.holdFrames;
          micPreRoll = [];
        }

        if (userSpeaking && !active && lastVoiceAt > 0) {
          const speechDurationMs = Math.max(0, lastVoiceAt - utteranceStartedAt);
          const waitMs = endpointWaitForTranscript(latestInputTranscript, speechDurationMs);
          const silenceMs = now - lastVoiceAt;
          const transcriptAgeMs = latestInputTranscriptAt > 0
            ? Math.round(now - latestInputTranscriptAt)
            : null;
          const endpointDecision = decideGeminiLiveEndpoint({
            transcript: latestInputTranscript,
            speechDurationMs,
            audioDurationMs: currentAudioDurationMs(),
            silenceMs,
            waitMs,
            minNoTranscriptSpeechMs: tuning.minNoTranscriptSpeechMs,
            noTranscriptGraceMs: tuning.noTranscriptGraceMs,
          });
          endpointWaitText.textContent = endpointDecision.remainingMs + 'ms';
          if (endpointDecision.action === 'hold') {
            if (endpointDecision.reason === 'waiting_for_transcript') {
              updateSpeechMetrics('等待有效转写', endpointDecision.remainingMs + 'ms');
            }
          } else if (endpointDecision.action === 'drop') {
            markTurnStage(currentTurnId, 'filterAt', now);
            if (now - lastNoiseNoticeAt > 1800) {
              addEntry(
                'warning',
                '低置信语音',
                turnLabel() + ' 已流式发送 ' + formatBytes(currentTurnAudioBytes) + ' / 约 ' + Math.round(currentAudioDurationMs()) + 'ms 音频，但 Gemini 暂未返回 inputTranscription；手动活动模式会发送 activityEnd 关闭这一轮，避免后续输入被卡住。' + timingText(currentTurnId, [
                  ['检测→过滤', 'detectedAt', 'filterAt'],
                  ['首帧→过滤', 'firstPcmAt', 'filterAt'],
                ]),
              );
              lastNoiseNoticeAt = now;
            }
            sendEndpoint('low_confidence_audio:' + Math.round(waitMs) + 'ms', {
              waitMs: Math.round(waitMs),
              silenceMs: Math.round(silenceMs),
              speechDurationMs: Math.round(speechDurationMs),
              transcriptChars: latestInputTranscript.length,
              transcriptAgeMs,
              filtered: 1,
              profile: activeProfile,
            });
            recordTurnStormEvent('noise', {
              speechDurationMs,
              transcriptChars: latestInputTranscript.length,
            }, 'low_confidence_audio');
            userSpeaking = false;
            acceptedBargeIn = false;
            micSpeechFrames = 0;
            micHoldFrames = 0;
            micPreRoll = [];
            latestInputTranscript = '';
            latestInputTranscriptAt = 0;
            updateSpeechMetrics('低置信已提交', '等待模型');
            return;
          } else if (endpointDecision.action === 'send') {
            const reason = endpointDecision.reason === 'audio_without_transcript_fallback'
              ? 'audio_fallback'
              : (waitMs > tuning.shortPauseMs ? 'thinking_pause' : 'short_pause');
            sendEndpoint(reason + ':' + Math.round(waitMs) + 'ms', {
              waitMs: Math.round(waitMs),
              silenceMs: Math.round(silenceMs),
              speechDurationMs: Math.round(speechDurationMs),
              transcriptChars: latestInputTranscript.length,
              transcriptAgeMs,
              profile: activeProfile,
            });
            recordTurnStormEvent(
              latestInputTranscript.length > 0 ? 'success' : 'noise',
              {
                speechDurationMs,
                transcriptChars: latestInputTranscript.length,
              },
              reason,
            );
            userSpeaking = false;
            acceptedBargeIn = false;
            micSpeechFrames = 0;
            micHoldFrames = 0;
            micPreRoll = [];
            return;
          }
        }

        if (shouldSend) {
          sendPcm(pcm);
          if (!active && micHoldFrames > 0) micHoldFrames -= 1;
        } else {
          micPreRoll.push(pcm);
          while (micPreRoll.length > tuning.preRollFrames) micPreRoll.shift();
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
        addEntry('system', '系统', '连接成功。音色：' + (message.voiceName || voiceSelect.value) + '，节奏：' + readTuning().label + '。现在可以直接说话。');
        pendingReadyResolve?.(message);
        pendingReadyResolve = null;
        pendingReadyReject = null;
      } else if (message.type === 'awaiting_start') {
        setStatus('等待开始配置', false);
      } else if (message.type === 'starting') {
        setStatus('连接 Gemini Live', false);
      } else if (message.type === 'input_transcript') {
        let turnId = message.turnId || currentTurnId;
        if (!message.turnId || message.turnId === currentTurnId) {
          latestInputTranscript = message.text || latestInputTranscript;
        }
        if (sessionRealtimeMode === 'native_vad' && !currentTurnId) {
          observedTurnCounter += 1;
          currentTurnId = observedTurnCounter;
          turnId = currentTurnId;
          turnTimings.set(currentTurnId, { turnId: currentTurnId, detectedAt: performance.now() });
        }
        const now = performance.now();
        if (!message.turnId || message.turnId === currentTurnId) {
          latestInputTranscriptAt = now;
        }
        if (message.text) {
          rememberConversation('user', message.text);
          recordTurnStormEvent('success', { transcriptChars: String(message.text).length }, 'input_transcription');
        }
        markTurnStage(turnId, 'inputTranscriptAt', now);
        addEntry('user', 'Gemini inputTranscription', turnLabel(turnId) + ' ' + message.text + '。' + timingText(turnId, [
          ['检测→转写', 'detectedAt', 'inputTranscriptAt'],
          ['首帧→转写', 'firstPcmAt', 'inputTranscriptAt'],
          ['端点→转写', 'endpointSentAt', 'inputTranscriptAt'],
        ]));
        if (containsInterruptionPhrase(message.text) && isAssistantAudioPlaying(audioContext || { currentTime: 0 })) {
          clearPlayback();
          addEntry('system', '明确打断词', '识别到“等一下/停一下”这类打断意图，已立即停止当前播放。');
        }
      } else if (message.type === 'output_transcript' || message.type === 'text') {
        const now = performance.now();
        const turnId = message.turnId || pendingResponseTurnId || currentTurnId;
        markTurnStage(turnId, message.type === 'output_transcript' ? 'outputTranscriptAt' : 'textAt', now);
        rememberConversation('assistant', message.text);
        addEntry('assistant', message.type === 'output_transcript' ? 'Gemini outputTranscription' : 'Gemini text', message.text + '。' + timingText(turnId, [
          ['端点→输出文本', 'endpointSentAt', message.type === 'output_transcript' ? 'outputTranscriptAt' : 'textAt'],
          ['首音频→输出文本', 'firstAudioAt', message.type === 'output_transcript' ? 'outputTranscriptAt' : 'textAt'],
        ]));
      } else if (message.type === 'audio') {
        if (firstAudioRequestedAt > 0) {
          const now = performance.now();
          const turnId = message.turnId || pendingResponseTurnId || currentTurnId;
          markLatency(Math.round(now - firstAudioRequestedAt) + 'ms');
          markTurnStage(turnId, 'firstAudioAt', now);
          addEntry('assistant', 'Gemini 音频', turnLabel(turnId) + ' 首段音频已返回并开始播放。' + timingText(turnId, [
            ['端点→首音频', 'endpointSentAt', 'firstAudioAt'],
            ['输入转写→首音频', 'inputTranscriptAt', 'firstAudioAt'],
            ['服务端确认→首音频', 'serverAckAt', 'firstAudioAt'],
          ]));
          firstAudioRequestedAt = 0;
        }
        assistantSpeakingAt = performance.now();
        recordTurnStormEvent('success', {}, 'first_audio');
        void playPcm(message.audio, message.sampleRate);
      } else if (message.type === 'response_latency') {
        markLatency(latencyLabel(message));
        const turnId = message.endpointMetrics?.turnId || pendingResponseTurnId || currentTurnId;
        addEntry('system', '服务端延迟汇总', turnLabel(turnId) + ' ' + latencyLabel(message) + '；reason=' + (message.reason || '--') + '。');
      } else if (message.type === 'response_delay_warning') {
        markLatency(delayWarningLabel(message));
        const endpointMetrics = message.endpointMetrics || {};
        const transcriptChars = Number(endpointMetrics.transcriptChars);
        const turnId = endpointMetrics.turnId || pendingResponseTurnId || currentTurnId;
        markTurnStage(turnId, 'delayWarningAt', performance.now());
        if (Number.isFinite(transcriptChars) && transcriptChars === 0) {
          addEntry(
            'warning',
            'Gemini 暂无输入转写',
            turnLabel(turnId) + ' 已提交给 Gemini，但暂未收到 inputTranscription 或首段音频；' + endpointSummary(endpointMetrics) + '。' + timingText(turnId, [
              ['端点→当前', 'endpointSentAt', 'delayWarningAt'],
              ['首帧→当前', 'firstPcmAt', 'delayWarningAt'],
            ]) + '继续说话会作为新一轮实时输入。',
          );
        } else {
          addEntry('warning', '模型响应偏慢', '已等待 ' + latencyLabel(message) + '，仍在等待首段音频。' + timingText(turnId, [
            ['端点→当前', 'endpointSentAt', 'delayWarningAt'],
          ]));
        }
      } else if (message.type === 'tool_call') {
        const turnId = pendingResponseTurnId || currentTurnId;
        markTurnStage(turnId, 'toolCallAt', performance.now());
        addEntry('tool', 'Function Call', message.name + '(' + JSON.stringify(message.args) + ')。' + timingText(turnId, [
          ['端点→工具调用', 'endpointSentAt', 'toolCallAt'],
          ['输入转写→工具调用', 'inputTranscriptAt', 'toolCallAt'],
        ]));
      } else if (message.type === 'tool_result') {
        const turnId = pendingResponseTurnId || currentTurnId;
        markTurnStage(turnId, 'toolResultAt', performance.now());
        addEntry('tool', 'Tool Result', message.name + ' → ' + JSON.stringify(message.result) + '。' + timingText(turnId, [
          ['工具调用→工具结果', 'toolCallAt', 'toolResultAt'],
          ['端点→工具结果', 'endpointSentAt', 'toolResultAt'],
        ]));
      } else if (message.type === 'tool_summary') {
        rememberConversation('assistant', message.text);
        addEntry('assistant', '确认', message.text);
      } else if (message.type === 'interrupted') {
        clearPlayback();
        acceptedBargeIn = false;
        pendingResponseTurnId = 0;
        addEntry('system', '打断', '已停止当前回复音频，继续听你说。');
      } else if (message.type === 'turn_complete') {
        setStatus('正在听', true);
        pendingResponseTurnId = 0;
        if (sessionRealtimeMode === 'native_vad') currentTurnId = 0;
      } else if (message.type === 'endpoint') {
        const turnId = message.metrics?.turnId || pendingResponseTurnId || currentTurnId;
        markTurnStage(turnId, 'serverAckAt', performance.now());
        addEntry(
          'system',
          '服务端确认',
          turnLabel(turnId) + ' 服务端已收到 activityEnd：' + message.reason + '；' + endpointSummary(message.metrics || {}) + '。' + timingText(turnId, [
            ['端点→服务端确认', 'endpointSentAt', 'serverAckAt'],
            ['检测→服务端确认', 'detectedAt', 'serverAckAt'],
          ]),
        );
      } else if (message.type === 'error') {
        addEntry('error', '错误', message.message);
        pendingReadyReject?.(new Error(message.message));
        pendingReadyResolve = null;
        pendingReadyReject = null;
      } else if (message.type === 'warning') {
        addEntry('warning', 'Warning', message.message);
        setStatus('缺少 Gemini 凭证', false);
        const warning = new Error(message.message);
        warning.isWarning = true;
        pendingReadyReject?.(warning);
        pendingReadyResolve = null;
        pendingReadyReject = null;
      } else if (message.type === 'closed') {
        if (shouldReconnectClosed(message) && scheduleReconnect(message)) return;
        addEntry('system', '系统', '连接已关闭。');
        void stopConversation();
      }
    }

    function resetReconnectState() {
      if (reconnectState.timer) clearTimeout(reconnectState.timer);
      reconnectState = { attempts: 0, firstAttemptAt: 0, pending: false, timer: null, manualStop: false };
    }

    function shouldReconnectClosed(message = {}) {
      if (reconnectState.manualStop || reconnectState.pending) return false;
      const code = Number(message.code);
      const reason = String(message.reason || '');
      return code === 1011 || code === 1006 || /internal error|encountered|abnormal/i.test(reason);
    }

    function scheduleReconnect(message = {}) {
      if (!running || reconnectState.manualStop) return false;
      const now = performance.now();
      if (!reconnectState.firstAttemptAt) reconnectState.firstAttemptAt = now;
      if (reconnectState.attempts >= 2 || now - reconnectState.firstAttemptAt > 60000) {
        addEntry('error', '重连失败', 'Gemini Live 会话连续关闭，已停止自动恢复。请重新点击开始。');
        if (ws && ws.readyState === WebSocket.OPEN) ws.close(1011, 'reconnect exhausted');
        stopMic();
        clearPlayback();
        setRunning(false);
        setStatus('已断开', false);
        ws = null;
        return false;
      }
      const delay = reconnectState.attempts === 0 ? 500 : 1500;
      reconnectState.attempts += 1;
      reconnectState.pending = true;
      setStatus('会话重连中', false);
      addEntry('warning', '会话重连', 'Gemini Live 会话关闭（' + (message.code || 'unknown') + ' ' + (message.reason || '') + '），' + delay + 'ms 后自动重连。');
      const oldWs = ws;
      ws = null;
      if (oldWs && oldWs.readyState === WebSocket.OPEN) {
        oldWs.onclose = null;
        oldWs.send(JSON.stringify({ type: 'reconnect_event', status: 'requested', reason: message.reason || '', code: message.code || null }));
        oldWs.close(1012, 'client reconnecting');
      }
      stopMic();
      clearPlayback();
      setRunning(false);
      reconnectState.timer = setTimeout(() => {
        reconnectState.timer = null;
        void startConversation({ reconnect: true }).catch((error) => {
          reconnectState.pending = false;
          addEntry('error', '重连失败', error.message || String(error));
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'reconnect_event', status: 'failed', reason: error.message || String(error) }));
          }
          stopMic();
          clearPlayback();
          setRunning(false);
          setStatus('已断开', false);
        });
      }, delay);
      return true;
    }

    async function startConversation(options = {}) {
      startButton.disabled = true;
      if (!options.reconnect) resetReconnectState();
      reconnectState.manualStop = false;
      sessionRealtimeMode = options.reconnect ? sessionRealtimeMode : realtimeMode;
      setStatus(options.reconnect ? '会话重连中' : '连接中', false);
      await ensureAudioContext();
      ws = new WebSocket(makeWsUrl());
      ws.binaryType = 'arraybuffer';
      ws.onmessage = handleMessage;
      ws.onclose = () => {
        if (!reconnectState.pending) setStatus('已断开', false);
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
      const tuning = readTuning();
      addEntry(
        'system',
        options.reconnect ? '重连配置' : '调节',
        '本轮使用“' + tuning.label + '”节奏，实时模式：' + (sessionRealtimeMode === 'native_vad' ? '原生 VAD' : '当前模式') + '。短句 ' + tuning.shortPauseMs + 'ms，思考 ' + tuning.thinkingPauseMs + 'ms，打断 ' + tuning.bargeInMs + 'ms。',
      );
      const readyPromise = new Promise((resolve, reject) => {
        pendingReadyResolve = resolve;
        pendingReadyReject = reject;
        setTimeout(() => reject(new Error('Gemini Live 会话启动超时。')), 20000);
      });
      ws.send(JSON.stringify({
        type: 'start',
        ...selectedSessionOptions({
          includeReconnectContext: Boolean(options.reconnect),
          mode: sessionRealtimeMode,
        }),
      }));
      await readyPromise;
      await startMic();
      setRunning(true);
      setStatus('正在听', true);
      if (options.reconnect) {
        reconnectState.pending = false;
        reconnectState.attempts = 0;
        reconnectState.firstAttemptAt = 0;
        addEntry('system', '重连成功', '已恢复 Gemini Live 会话，并保留最近几轮文本上下文。');
      }
    }

    async function stopConversation() {
      if (!running && !ws) return;
      reconnectState.manualStop = true;
      if (reconnectState.timer) clearTimeout(reconnectState.timer);
      reconnectState.pending = false;
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
        if (!error?.isWarning) addEntry('error', '错误', error.message || String(error));
        await stopConversation();
      }
    });

    renderVoices();
    renderTuning();
    renderTools();
    if (!CONFIG.credentialsConfigured) {
      addEntry('warning', 'Warning', 'Gemini Live 凭证未配置。页面可以正常打开，但开始实时对话会失败；请在环境中挂载 Vertex secret 或配置 GOOGLE_APPLICATION_CREDENTIALS。');
      setStatus('缺少 Gemini 凭证', false);
    }
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
              realtimeMode: message.realtimeMode,
              realtimeTuning: message.realtimeTuning,
            });
          } catch (error) {
            if (isGeminiLiveConfigWarning(error)) {
              console.warn(`[GeminiLiveDemo] ${error.code || 'config_warning'}: ${error.message || error}`);
              sendWsJson(ws, geminiLiveConfigWarningPayload(error));
              ws.close(1000, 'Gemini Live configuration warning');
            } else {
              console.error('[GeminiLiveDemo] connect failed:', error?.stack || error?.message || error);
              sendWsJson(ws, { type: 'error', message: error?.message || String(error) });
              ws.close(1011, 'Gemini Live connect failed');
            }
          }
        })();
        return;
      }
      if (message.type === 'stop') {
        live?.sendEnd();
        live?.close();
      }
      if (message.type === 'audio_stream_end') {
        const reason = String(message.reason || 'client_silence').slice(0, 80);
        const metrics = sanitizeEndpointMetrics(message.metrics);
        live?.flushAudioStream({
          reason,
          metrics,
        });
        sendWsJson(ws, {
          type: 'endpoint',
          reason,
          metrics,
        });
      }
      if (message.type === 'activity_start') {
        live?.activityStart({
          reason: String(message.reason || 'manual_activity').slice(0, 80),
          metrics: sanitizeEndpointMetrics(message.metrics),
        });
      }
      if (message.type === 'activity_end') {
        const reason = String(message.reason || 'manual_activity').slice(0, 80);
        const metrics = sanitizeEndpointMetrics(message.metrics);
        live?.activityEnd({
          reason,
          metrics,
        });
        sendWsJson(ws, {
          type: 'endpoint',
          reason,
          metrics,
        });
      }
      if (message.type === 'noise_guard') {
        console.info(`[GeminiLiveDemo] ${message.active ? 'noise_guard_entered' : 'noise_guard_exited'} ${JSON.stringify({
          reason: String(message.reason || '').slice(0, 80),
          remainingMs: Number(message.remainingMs) || 0,
          events: Number(message.events) || 0,
        })}`);
      }
      if (message.type === 'reconnect_event') {
        console.info(`[GeminiLiveDemo] ${message.status === 'failed' ? 'session_reconnect_failed' : 'session_reconnect_requested'} ${JSON.stringify({
          code: message.code ?? null,
          reason: String(message.reason || '').slice(0, 120),
        })}`);
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
  return /^\/s\/[^/]+\/channels\/[^/]+\/gemini-live\/?$/.test(pathname);
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
  return target.startsWith('/') && !target.startsWith('//')
    ? target
    : '/s/gemini-live/channels/chan_c7452e995b/gemini-live';
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
    warning: config.credentialsConfigured ? null : MISSING_CREDENTIALS_CODE,
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
              realtimeMode: message.realtimeMode,
              realtimeTuning: message.realtimeTuning,
            });
          } catch (error) {
            if (isGeminiLiveConfigWarning(error)) {
              console.warn(`[GeminiLiveDemo] ${error.code || 'config_warning'}: ${error.message || error}`);
              sendWsJson(ws, geminiLiveConfigWarningPayload(error));
              ws.close(1000, 'Gemini Live configuration warning');
            } else {
              console.error('[GeminiLiveDemo] connect failed:', error?.stack || error?.message || error);
              sendWsJson(ws, { type: 'error', message: error?.message || String(error) });
              ws.close(1011, 'Gemini Live connect failed');
            }
          }
        })();
        return;
      }
      if (message.type === 'stop') {
        live?.sendEnd();
        live?.close();
      }
      if (message.type === 'audio_stream_end') {
        const reason = String(message.reason || 'client_silence').slice(0, 80);
        const metrics = sanitizeEndpointMetrics(message.metrics);
        live?.flushAudioStream({
          reason,
          metrics,
        });
        sendWsJson(ws, {
          type: 'endpoint',
          reason,
          metrics,
        });
      }
      if (message.type === 'activity_start') {
        live?.activityStart({
          reason: String(message.reason || 'manual_activity').slice(0, 80),
          metrics: sanitizeEndpointMetrics(message.metrics),
        });
      }
      if (message.type === 'activity_end') {
        const reason = String(message.reason || 'manual_activity').slice(0, 80);
        const metrics = sanitizeEndpointMetrics(message.metrics);
        live?.activityEnd({
          reason,
          metrics,
        });
        sendWsJson(ws, {
          type: 'endpoint',
          reason,
          metrics,
        });
      }
      if (message.type === 'noise_guard') {
        console.info(`[GeminiLiveDemo] ${message.active ? 'noise_guard_entered' : 'noise_guard_exited'} ${JSON.stringify({
          reason: String(message.reason || '').slice(0, 80),
          remainingMs: Number(message.remainingMs) || 0,
          events: Number(message.events) || 0,
        })}`);
      }
      if (message.type === 'reconnect_event') {
        console.info(`[GeminiLiveDemo] ${message.status === 'failed' ? 'session_reconnect_failed' : 'session_reconnect_requested'} ${JSON.stringify({
          code: message.code ?? null,
          reason: String(message.reason || '').slice(0, 120),
        })}`);
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
  normalizeChineseDisplayText,
  publicToolCards,
  resolveCredentialsPath,
  shouldBlockDemoToolCall,
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
