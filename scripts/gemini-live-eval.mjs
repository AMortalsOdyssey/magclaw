#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, Modality, Type } from '@google/genai';
import { WebSocket } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const INPUT_SAMPLE_RATE = 16_000;
const OUTPUT_SAMPLE_RATE = 24_000;
const DEFAULT_MODEL = 'gemini-live-2.5-flash-native-audio';
const DEFAULT_ENV_FILE = path.join(__dirname, 'gemini-live.env.local');
const DEFAULT_OUT_DIR = path.join(ROOT, 'tmp', 'gemini-live-eval');
const DEFAULT_CHUNK_MS = 40;
const DEFAULT_TIMEOUT_MS = 45_000;
const DEFAULT_WS_URL = 'ws://127.0.0.1:8787/ws/gemini-live';
const DEFAULT_TTS_VOICE = 'Tingting';
const DEFAULT_ENGLISH_VOICE = 'Samantha';
const DEFAULT_PRE_SILENCE_MS = 350;
const DEFAULT_POST_SILENCE_MS = 250;

const SYSTEM_INSTRUCTION = `
You are evaluating a realtime voice assistant for MagClaw.
Reply in the same language as the user, keep answers short, and use tools immediately
when a test case asks for weather, math, demo tickets, tasks, or public holidays.
For Chinese replies, use Mainland Mandarin phrasing and Simplified Chinese characters.
For unclear noisy or overlapping speech, ask a concise clarification instead of inventing details.
`.trim();

const CASES = [
  {
    id: 'short_weather_zh',
    label: '短命令：中文天气工具调用',
    mode: 'single',
    segments: [{ text: '帮我查一下杭州今天的天气。', voice: DEFAULT_TTS_VOICE }],
    expectTool: 'get_weather',
    expectToolArgs: { city: /Hangzhou|杭州/i },
    expectSimplifiedChinese: true,
    maxFirstAudioMs: 2800,
  },
  {
    id: 'tiny_command_zh',
    label: '极短交互：几个字',
    mode: 'single',
    segments: [{ text: '等一下。', voice: DEFAULT_TTS_VOICE }],
    expectNoTool: true,
    expectSimplifiedChinese: true,
    maxFirstAudioMs: 2400,
  },
  {
    id: 'thinking_pause_weather_zh',
    label: '思考型说话：短暂停顿后补全指令',
    mode: 'single',
    segments: [
      { text: '帮我查一下', voice: DEFAULT_TTS_VOICE, afterSilenceMs: 900 },
      { text: '杭州今天的天气。', voice: DEFAULT_TTS_VOICE },
    ],
    expectTool: 'get_weather',
    expectToolArgs: { city: /Hangzhou|杭州/i },
    expectSimplifiedChinese: true,
    maxFirstAudioMs: 3200,
  },
  {
    id: 'long_task_zh',
    label: '长句：创建模拟任务',
    mode: 'single',
    segments: [
      {
        text: '我想让你帮我创建一个演示任务，标题是检查实时语音延迟，优先级中等，今天先记下来就行。',
        voice: DEFAULT_TTS_VOICE,
      },
    ],
    expectTool: 'create_demo_task',
    expectToolArgs: { title: /实时语音延迟/ },
    expectSimplifiedChinese: true,
    maxFirstAudioMs: 3600,
  },
  {
    id: 'noisy_math_zh',
    label: '噪声：中文数学工具调用',
    mode: 'single',
    segments: [{ text: '帮我算一下三十七乘以二十四。', voice: DEFAULT_TTS_VOICE }],
    noiseLevel: 0.018,
    expectTool: 'calculate_expression',
    expectToolArgs: { expression: /37\s*[*×x]\s*24/ },
    expectSimplifiedChinese: true,
    maxFirstAudioMs: 3200,
  },
  {
    id: 'short_weather_en',
    label: '短命令：英文天气工具调用',
    mode: 'single',
    segments: [{ text: 'Check the weather in Hangzhou today.', voice: DEFAULT_ENGLISH_VOICE }],
    expectTool: 'get_weather',
    expectToolArgs: { city: /Hangzhou|杭州/i },
    maxFirstAudioMs: 2800,
  },
  {
    id: 'barge_in_stop_zh',
    label: '打断：助手说话中插入停一下',
    mode: 'barge_in',
    firstSegments: [{ text: '请用一分钟介绍一下 Gemini Live 的实时语音能力。', voice: DEFAULT_TTS_VOICE }],
    interruptSegments: [{ text: '等一下，先停一下。', voice: DEFAULT_TTS_VOICE }],
    interruptAfterFirstAudioMs: 450,
    expectInterrupted: true,
    expectSimplifiedChinese: true,
    maxInterruptMs: 1400,
  },
  {
    id: 'overlap_two_speakers_zh',
    label: '二期风险：双人插嘴混音',
    mode: 'single',
    tracks: [
      { offsetMs: 0, segments: [{ text: '帮我查一下北京今天的天气。', voice: DEFAULT_TTS_VOICE }] },
      { offsetMs: 550, segments: [{ text: '等一下我插一句，明天几点开会？', voice: 'Eddy (中文（中国大陆）)' }] },
    ],
    expectNoHardPass: true,
    maxFirstAudioMs: 4200,
  },
];

function usage() {
  console.log(`Usage:
  node scripts/gemini-live-eval.mjs --dry-run --limit 3
  node scripts/gemini-live-eval.mjs --case short_weather_zh
  node scripts/gemini-live-eval.mjs --all

Options:
  --case <id>          Run one case. Can be repeated.
  --all                Run all default cases.
  --limit <n>          Run the first n selected cases.
  --repeat <n>         Repeat each selected case n times, default 1.
  --target <name>      "sdk" calls Google directly; "websocket" calls MagClaw WS. Default sdk.
  --ws-url <url>       WebSocket URL for --target websocket, default ${DEFAULT_WS_URL}.
  --dry-run            Generate audio and report the plan without calling Gemini.
  --out-dir <path>     Output directory, default tmp/gemini-live-eval.
  --env <path>         Env file, default scripts/gemini-live.env.local.
  --credentials <path> Override GOOGLE_APPLICATION_CREDENTIALS.
  --project <id>       Override GOOGLE_CLOUD_PROJECT.
  --location <loc>     Override GOOGLE_CLOUD_LOCATION, default us-central1 for native audio.
  --model <id>         Gemini Live model, default ${DEFAULT_MODEL}.
  --chunk-ms <n>       Streaming chunk duration, default ${DEFAULT_CHUNK_MS}.
  --input-field <name> Send audio through "audio" or "media", default audio.
  --activity-mode <m>  "auto" uses Live VAD; "manual" sends activityStart/activityEnd. Default manual.
  --timeout-ms <n>     Per-case timeout, default ${DEFAULT_TIMEOUT_MS}.
  --keep-audio         Keep synthesized audio files. Default on for --dry-run, off otherwise.
  --list-cases         Print cases and exit.
`);
}

function parseArgs(argv) {
  const args = {
    envFile: DEFAULT_ENV_FILE,
    outDir: DEFAULT_OUT_DIR,
    cases: [],
    chunkMs: DEFAULT_CHUNK_MS,
    inputField: 'audio',
    activityMode: 'manual',
    repeat: 1,
    target: 'sdk',
    wsUrl: DEFAULT_WS_URL,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    keepAudio: undefined,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--case') args.cases.push(next());
    else if (arg === '--all') args.all = true;
    else if (arg === '--limit') args.limit = Number(next());
    else if (arg === '--repeat') args.repeat = Number(next());
    else if (arg === '--target') args.target = next();
    else if (arg === '--ws-url') args.wsUrl = next();
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--out-dir') args.outDir = path.resolve(next());
    else if (arg === '--env') args.envFile = path.resolve(next());
    else if (arg === '--credentials') args.credentials = next();
    else if (arg === '--project') args.project = next();
    else if (arg === '--location') args.location = next();
    else if (arg === '--model') args.model = next();
    else if (arg === '--chunk-ms') args.chunkMs = Number(next());
    else if (arg === '--input-field') args.inputField = next();
    else if (arg === '--activity-mode') args.activityMode = next();
    else if (arg === '--timeout-ms') args.timeoutMs = Number(next());
    else if (arg === '--keep-audio') args.keepAudio = true;
    else if (arg === '--list-cases') args.listCases = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return args;
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

function commandExists(command) {
  const result = spawnSync('sh', ['-lc', `command -v ${JSON.stringify(command)} >/dev/null 2>&1`]);
  return result.status === 0;
}

function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `${label} failed: ${command} ${args.join(' ')}\n${result.stderr || result.stdout || ''}`.trim(),
    );
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampSample(value) {
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}

function silencePcm(ms) {
  const samples = Math.max(0, Math.round((INPUT_SAMPLE_RATE * ms) / 1000));
  return Buffer.alloc(samples * 2);
}

function seededRandom(seedText) {
  let seed = 2166136261;
  for (const char of String(seedText)) {
    seed ^= char.charCodeAt(0);
    seed = Math.imul(seed, 16777619);
  }
  return () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) / 4294967295);
  };
}

function addWhiteNoise(pcm, level, seedText) {
  if (!level) return pcm;
  const random = seededRandom(seedText);
  const output = Buffer.alloc(pcm.length);
  for (let offset = 0; offset < pcm.length; offset += 2) {
    const sample = pcm.readInt16LE(offset);
    const noise = (random() * 2 - 1) * 32767 * level;
    output.writeInt16LE(clampSample(sample + noise), offset);
  }
  return output;
}

function mixPcmTracks(tracks) {
  const outputSamples = Math.max(
    1,
    ...tracks.map((track) => Math.round((track.offsetMs * INPUT_SAMPLE_RATE) / 1000) + track.pcm.length / 2),
  );
  const mixed = new Int32Array(outputSamples);
  for (const track of tracks) {
    const start = Math.round((track.offsetMs * INPUT_SAMPLE_RATE) / 1000);
    for (let offset = 0; offset < track.pcm.length; offset += 2) {
      mixed[start + offset / 2] += track.pcm.readInt16LE(offset);
    }
  }
  const output = Buffer.alloc(outputSamples * 2);
  for (let i = 0; i < outputSamples; i += 1) {
    output.writeInt16LE(clampSample(mixed[i]), i * 2);
  }
  return output;
}

function writeWavHeader(dataBytes, sampleRate, channels = 1, bitsPerSample = 16) {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

function writeWavFile(filePath, pcm) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, Buffer.concat([writeWavHeader(pcm.length, INPUT_SAMPLE_RATE), pcm]));
}

function synthesizeSegment(text, voice, outDir, slug) {
  const aiffPath = path.join(outDir, `${slug}.aiff`);
  const pcmPath = path.join(outDir, `${slug}.pcm`);
  run('say', ['-v', voice || DEFAULT_TTS_VOICE, '-r', '205', '-o', aiffPath, text], `say ${slug}`);
  run(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-y', '-i', aiffPath, '-ac', '1', '-ar', String(INPUT_SAMPLE_RATE), '-f', 's16le', pcmPath],
    `ffmpeg ${slug}`,
  );
  return readFileSync(pcmPath);
}

function synthesizeSegments(segments, outDir, slugPrefix) {
  const buffers = [silencePcm(DEFAULT_PRE_SILENCE_MS)];
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    buffers.push(synthesizeSegment(segment.text, segment.voice, outDir, `${slugPrefix}-${index}`));
    if (segment.afterSilenceMs) buffers.push(silencePcm(segment.afterSilenceMs));
  }
  buffers.push(silencePcm(DEFAULT_POST_SILENCE_MS));
  return Buffer.concat(buffers);
}

function synthesizeCaseAudio(testCase, outDir) {
  const caseDir = path.join(outDir, 'audio', testCase.id);
  mkdirSync(caseDir, { recursive: true });

  const build = (segments, slug) => {
    const pcm = synthesizeSegments(segments, caseDir, slug);
    return addWhiteNoise(pcm, testCase.noiseLevel || 0, `${testCase.id}:${slug}`);
  };

  if (testCase.mode === 'barge_in') {
    const firstPcm = build(testCase.firstSegments, 'first');
    const interruptPcm = build(testCase.interruptSegments, 'interrupt');
    writeWavFile(path.join(caseDir, 'first.wav'), firstPcm);
    writeWavFile(path.join(caseDir, 'interrupt.wav'), interruptPcm);
    return { firstPcm, interruptPcm, files: [path.join(caseDir, 'first.wav'), path.join(caseDir, 'interrupt.wav')] };
  }

  let pcm;
  if (testCase.tracks?.length) {
    const tracks = testCase.tracks.map((track, index) => ({
      offsetMs: track.offsetMs || 0,
      pcm: synthesizeSegments(track.segments, caseDir, `track-${index}`),
    }));
    pcm = addWhiteNoise(mixPcmTracks(tracks), testCase.noiseLevel || 0, testCase.id);
  } else {
    pcm = build(testCase.segments, 'single');
  }
  const wavPath = path.join(caseDir, 'input.wav');
  writeWavFile(wavPath, pcm);
  return { pcm, files: [wavPath] };
}

function makeAudioPayload(pcmChunk) {
  return {
    data: pcmChunk.toString('base64'),
    mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`,
  };
}

function getToolDeclarations() {
  return [
    {
      name: 'get_weather',
      description: 'Return deterministic mock weather for a requested city.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          city: { type: Type.STRING, description: 'City name.' },
        },
        required: ['city'],
      },
    },
    {
      name: 'calculate_expression',
      description: 'Calculate a math expression for voice testing.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          expression: { type: Type.STRING, description: 'Math expression.' },
        },
        required: ['expression'],
      },
    },
    {
      name: 'create_demo_task',
      description: 'Create a deterministic mock task for evaluation.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          priority: { type: Type.STRING },
        },
        required: ['title'],
      },
    },
    {
      name: 'lookup_demo_ticket',
      description: 'Look up a deterministic demo ticket by id.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          ticket_id: { type: Type.STRING },
        },
        required: ['ticket_id'],
      },
    },
    {
      name: 'get_public_holidays',
      description: 'Return deterministic public holiday examples.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          country_code: { type: Type.STRING },
          year: { type: Type.NUMBER },
        },
        required: ['country_code'],
      },
    },
  ];
}

function runEvalTool(name, args) {
  if (name === 'get_weather') {
    return {
      city: args.city || 'unknown',
      condition: '多云',
      temperature_c: 24,
      source: 'eval_mock',
    };
  }
  if (name === 'calculate_expression') {
    const expression = String(args.expression || '').replace(/[×x]/gi, '*').replace(/÷/g, '/');
    if (!/^[\d\s+\-*/().%]+$/.test(expression)) return { error: 'unsupported expression', expression };
    // eslint-disable-next-line no-new-func
    const value = Function(`"use strict"; return (${expression});`)();
    return { expression, value };
  }
  if (name === 'create_demo_task') {
    return {
      id: `TASK-${Date.now().toString().slice(-6)}`,
      title: args.title || 'untitled',
      priority: args.priority || 'medium',
      status: 'created',
      source: 'eval_mock',
    };
  }
  if (name === 'lookup_demo_ticket') {
    return {
      ticket_id: args.ticket_id || 'DEMO-1001',
      status: 'in_progress',
      owner: 'demo',
      source: 'eval_mock',
    };
  }
  if (name === 'get_public_holidays') {
    return {
      country_code: args.country_code || 'CN',
      year: args.year || new Date().getFullYear(),
      holidays: ['New Year', 'National Day'],
      source: 'eval_mock',
    };
  }
  return { error: `unknown tool ${name}` };
}

function makeLiveConfig(args) {
  const manualActivity = args.activityMode === 'manual';
  return {
    responseModalities: [Modality.AUDIO],
    systemInstruction: {
      role: 'system',
      parts: [{ text: SYSTEM_INSTRUCTION }],
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    realtimeInputConfig: {
      automaticActivityDetection: {
        disabled: manualActivity,
        startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
        endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
        prefixPaddingMs: 140,
        silenceDurationMs: 420,
      },
      activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
      turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY',
    },
    tools: [{ functionDeclarations: getToolDeclarations() }],
  };
}

function extractAudioParts(message) {
  const parts = message.serverContent?.modelTurn?.parts || [];
  return parts
    .map((part) => part.inlineData)
    .filter((inlineData) => inlineData?.data && inlineData?.mimeType?.startsWith('audio/'))
    .map((inlineData) => Buffer.from(inlineData.data, 'base64'));
}

function extractTextParts(message) {
  const parts = message.serverContent?.modelTurn?.parts || [];
  return parts.map((part) => part.text).filter(Boolean);
}

async function streamPcm(session, pcm, args, metrics, label) {
  const chunkBytes = Math.max(2, Math.floor((INPUT_SAMPLE_RATE * 2 * args.chunkMs) / 1000));
  const startedAt = Date.now();
  let chunks = 0;
  for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
    const chunk = pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.length));
    const payload = makeAudioPayload(chunk);
    if (args.inputField === 'media') {
      session.sendRealtimeInput({ media: payload });
    } else {
      session.sendRealtimeInput({ audio: payload });
    }
    chunks += 1;
    await sleep(args.chunkMs);
  }
  metrics.streams.push({
    label,
    chunks,
    audioMs: Math.round((pcm.length / 2 / INPUT_SAMPLE_RATE) * 1000),
    wallMs: Date.now() - startedAt,
  });
}

async function streamPcmToWebSocket(ws, pcm, args, metrics, label) {
  const chunkBytes = Math.max(2, Math.floor((INPUT_SAMPLE_RATE * 2 * args.chunkMs) / 1000));
  const startedAt = Date.now();
  let chunks = 0;
  for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
    const chunk = pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.length));
    ws.send(chunk);
    chunks += 1;
    await sleep(args.chunkMs);
  }
  metrics.streams.push({
    label,
    chunks,
    audioMs: Math.round((pcm.length / 2 / INPUT_SAMPLE_RATE) * 1000),
    wallMs: Date.now() - startedAt,
  });
}

function sendWsJson(ws, payload) {
  ws.send(JSON.stringify(payload));
}

function selectedCases(args) {
  if (args.listCases) return [];
  let cases;
  if (args.all || args.cases.length === 0) {
    cases = CASES.filter((testCase) => !testCase.expectNoHardPass);
  } else {
    const wanted = new Set(args.cases);
    cases = CASES.filter((testCase) => wanted.has(testCase.id));
    const found = new Set(cases.map((testCase) => testCase.id));
    for (const id of wanted) {
      if (!found.has(id)) throw new Error(`Unknown case: ${id}`);
    }
  }
  if (Number.isFinite(args.limit) && args.limit > 0) return cases.slice(0, args.limit);
  return cases;
}

function getRuntimeConfig(args) {
  if (args.credentials) process.env.GOOGLE_APPLICATION_CREDENTIALS = args.credentials;
  if (args.project) process.env.GOOGLE_CLOUD_PROJECT = args.project;
  if (args.location) process.env.GOOGLE_CLOUD_LOCATION = args.location;
  process.env.GOOGLE_GENAI_USE_VERTEXAI ||= 'true';

  const model = args.model || process.env.GEMINI_LIVE_MODEL || DEFAULT_MODEL;
  return {
    model,
    project: process.env.GOOGLE_CLOUD_PROJECT,
    location: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
    credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  };
}

function validateConfig(config, dryRun, target) {
  if (dryRun || target === 'websocket') return;
  if (!config.credentialsPath || !existsSync(config.credentialsPath)) {
    throw new Error('Missing GOOGLE_APPLICATION_CREDENTIALS. Use --dry-run for audio-only generation.');
  }
  if (!config.project) {
    throw new Error('Missing GOOGLE_CLOUD_PROJECT.');
  }
}

function nowMs(startedAt) {
  return Date.now() - startedAt;
}

function sendActivityStart(session, metrics, mark, args, phase) {
  if (args.activityMode !== 'manual') return;
  session.sendRealtimeInput({ activityStart: {} });
  mark('activity_start', { phase });
  metrics.manualActivity = true;
}

function sendActivityEnd(session, mark, args, phase) {
  if (args.activityMode === 'manual') {
    session.sendRealtimeInput({ activityEnd: {} });
    mark('activity_end', { phase });
  } else {
    session.sendRealtimeInput({ audioStreamEnd: true });
    mark('audio_stream_end', { phase });
  }
}

async function runSingleCase(client, config, testCase, audio, args) {
  const startedAt = Date.now();
  const metrics = {
    id: testCase.id,
    label: testCase.label,
    mode: testCase.mode,
    target: 'sdk',
    startedAt: new Date(startedAt).toISOString(),
    streams: [],
    events: [],
    toolCalls: [],
    blockedToolCalls: [],
    inputTranscript: '',
    outputTranscript: '',
    text: '',
    audioBytes: 0,
  };

  let session;
  let finished = false;
  let resolveDone;
  let resolveSetup;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const setupReady = new Promise((resolve) => {
    resolveSetup = resolve;
  });
  const mark = (name, extra = {}) => {
    metrics.events.push({ name, atMs: nowMs(startedAt), ...extra });
  };
  let currentTurnAudioBytes = 0;
  let currentTurnTextChars = 0;
  let currentTurnToolCalls = 0;

  session = await client.live.connect({
    model: config.model,
    config: makeLiveConfig(args),
    callbacks: {
      onopen: () => mark('open'),
      onmessage: (message) => {
        if (message.setupComplete) mark('setup_complete', { sessionId: message.setupComplete.sessionId || null });
        if (message.setupComplete) resolveSetup();
        if (message.serverContent?.inputTranscription?.text) {
          if (!metrics.firstInputTranscriptMs) metrics.firstInputTranscriptMs = nowMs(startedAt);
          metrics.inputTranscript += message.serverContent.inputTranscription.text;
        }
        if (message.serverContent?.outputTranscription?.text) {
          if (!metrics.firstOutputTranscriptMs) metrics.firstOutputTranscriptMs = nowMs(startedAt);
          metrics.outputTranscript += message.serverContent.outputTranscription.text;
        }
        for (const text of extractTextParts(message)) {
          if (!metrics.firstTextMs) metrics.firstTextMs = nowMs(startedAt);
          metrics.text += text;
          currentTurnTextChars += text.length;
        }
        const audioChunks = extractAudioParts(message);
        for (const chunk of audioChunks) {
          if (!metrics.firstAudioMs) metrics.firstAudioMs = nowMs(startedAt);
          metrics.audioBytes += chunk.length;
          currentTurnAudioBytes += chunk.length;
        }
        if (message.serverContent?.interrupted) {
          if (!metrics.interruptedMs) metrics.interruptedMs = nowMs(startedAt);
          mark('interrupted');
        }
        const calls = message.toolCall?.functionCalls || [];
        if (calls.length > 0) {
          if (!metrics.firstToolCallMs) metrics.firstToolCallMs = nowMs(startedAt);
          for (const call of calls) {
            const toolCall = {
              name: call.name || 'unknown',
              args: call.args || {},
              atMs: nowMs(startedAt),
            };
            metrics.toolCalls.push(toolCall);
            currentTurnToolCalls += 1;
          }
          session.sendToolResponse({
            functionResponses: calls.map((call) => ({
              id: call.id,
              name: call.name,
              response: { output: runEvalTool(call.name, call.args || {}) },
            })),
          });
          metrics.lastToolResponseSentMs = nowMs(startedAt);
          mark('tool_response_sent', { count: calls.length });
        }
        if (message.serverContent?.generationComplete) mark('generation_complete');
        if (message.serverContent?.turnComplete) {
          mark('turn_complete');
          const hadEmptyTurn =
            currentTurnToolCalls === 0 && currentTurnAudioBytes === 0 && currentTurnTextChars === 0;
          const hadOnlyToolCallsThisTurn =
            currentTurnToolCalls > 0 && currentTurnAudioBytes === 0 && currentTurnTextChars === 0;
          currentTurnAudioBytes = 0;
          currentTurnTextChars = 0;
          currentTurnToolCalls = 0;
          if (
            hadEmptyTurn &&
            testCase.expectTool &&
            !metrics.toolCalls.some((call) => call.name === testCase.expectTool)
          ) {
            mark('empty_turn_complete_waiting_for_tool', { expectedTool: testCase.expectTool });
            return;
          }
          if (hadOnlyToolCallsThisTurn) {
            mark('tool_turn_complete');
            return;
          }
          if (testCase.mode !== 'barge_in' || metrics.interruptedMs || metrics.toolCalls.length > 0) {
            finished = true;
            resolveDone('turn_complete');
          }
        }
        if (message.usageMetadata) metrics.usage = message.usageMetadata;
      },
      onerror: (error) => {
        metrics.error = error?.message || String(error);
        finished = true;
        resolveSetup();
        resolveDone('error');
      },
      onclose: (event) => {
        metrics.closed = { code: event?.code ?? null, reason: event?.reason || '' };
        resolveSetup();
        if (!finished) resolveDone('closed');
      },
    },
  });

  await Promise.race([setupReady, sleep(5000)]);
  if (!metrics.events.some((event) => event.name === 'setup_complete')) {
    metrics.setupWarning = 'setup_complete_not_seen_before_upload';
  }

  mark('upload_start', { phase: 'first' });
  if (testCase.mode === 'barge_in') {
    sendActivityStart(session, metrics, mark, args, 'first');
    await streamPcm(session, audio.firstPcm, args, metrics, 'first');
    sendActivityEnd(session, mark, args, 'first');
    metrics.firstEndpointMs = nowMs(startedAt);
    while (!metrics.firstAudioMs && !metrics.error && nowMs(startedAt) < args.timeoutMs) {
      await sleep(20);
    }
    await sleep(testCase.interruptAfterFirstAudioMs || 400);
    metrics.interruptUploadStartMs = nowMs(startedAt);
    mark('upload_start', { phase: 'interrupt' });
    sendActivityStart(session, metrics, mark, args, 'interrupt');
    await streamPcm(session, audio.interruptPcm, args, metrics, 'interrupt');
    sendActivityEnd(session, mark, args, 'interrupt');
    metrics.interruptEndpointMs = nowMs(startedAt);
  } else {
    sendActivityStart(session, metrics, mark, args, 'single');
    await streamPcm(session, audio.pcm, args, metrics, 'single');
    sendActivityEnd(session, mark, args, 'single');
    metrics.endpointMs = nowMs(startedAt);
  }

  const timeout = sleep(args.timeoutMs).then(() => 'timeout');
  const reason = await Promise.race([done, timeout]);
  metrics.finishReason = reason;
  metrics.finishedAtMs = nowMs(startedAt);
  try {
    session.close();
  } catch {
    // best effort
  }
  return scoreCase(testCase, metrics);
}

function getAudioMessageBytes(audio) {
  if (!audio) return 0;
  if (typeof audio === 'string') return Buffer.byteLength(audio, 'base64');
  if (audio instanceof ArrayBuffer) return audio.byteLength;
  if (ArrayBuffer.isView(audio)) return audio.byteLength;
  if (Array.isArray(audio.data)) return audio.data.length;
  return 0;
}

async function runWebSocketCase(testCase, audio, args) {
  const startedAt = Date.now();
  const metrics = {
    id: testCase.id,
    label: testCase.label,
    mode: testCase.mode,
    target: 'websocket',
    startedAt: new Date(startedAt).toISOString(),
    streams: [],
    events: [],
    toolCalls: [],
    blockedToolCalls: [],
    inputTranscript: '',
    outputTranscript: '',
    text: '',
    audioBytes: 0,
  };
  const mark = (name, extra = {}) => {
    metrics.events.push({ name, atMs: nowMs(startedAt), ...extra });
  };

  let ws;
  let finished = false;
  let resolveReady;
  let resolveDone;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  let currentTurnAudioBytes = 0;
  let currentTurnTextChars = 0;
  let currentTurnToolCalls = 0;

  ws = new WebSocket(args.wsUrl);
  ws.binaryType = 'arraybuffer';
  ws.on('open', () => mark('ws_open'));
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message.type === 'awaiting_start') {
      mark('awaiting_start');
      sendWsJson(ws, {
        type: 'start',
        voiceName: 'Puck',
        systemInstruction: SYSTEM_INSTRUCTION,
        realtimeTuning: {
          manualActivity: args.activityMode === 'manual',
          activityMode: args.activityMode,
          silenceDurationMs: 420,
          prefixPaddingMs: 140,
          startSensitivity: 'START_SENSITIVITY_HIGH',
          endSensitivity: 'END_SENSITIVITY_HIGH',
          activityHandling: 'START_OF_ACTIVITY_INTERRUPTS',
          turnCoverage: 'TURN_INCLUDES_ONLY_ACTIVITY',
        },
      });
      return;
    }
    if (message.type === 'starting') mark('starting');
    if (message.type === 'setup_complete') mark('setup_complete', { sessionId: message.sessionId || null });
    if (message.type === 'ready') {
      mark('ready');
      resolveReady();
    }
    if (message.type === 'endpoint') mark('endpoint', { reason: message.reason || '' });
    if (message.type === 'input_transcript') {
      if (!metrics.firstInputTranscriptMs) metrics.firstInputTranscriptMs = nowMs(startedAt);
      metrics.inputTranscript += message.text || '';
    }
    if (message.type === 'output_transcript') {
      if (!metrics.firstOutputTranscriptMs) metrics.firstOutputTranscriptMs = nowMs(startedAt);
      metrics.outputTranscript += message.text || '';
    }
    if (message.type === 'text') {
      if (!metrics.firstTextMs) metrics.firstTextMs = nowMs(startedAt);
      metrics.text += message.text || '';
      currentTurnTextChars += String(message.text || '').length;
    }
    if (message.type === 'audio') {
      const bytes = getAudioMessageBytes(message.audio);
      if (!metrics.firstAudioMs) metrics.firstAudioMs = nowMs(startedAt);
      metrics.audioBytes += bytes;
      currentTurnAudioBytes += bytes;
    }
    if (message.type === 'tool_call') {
      if (!metrics.firstToolCallMs) metrics.firstToolCallMs = nowMs(startedAt);
      metrics.toolCalls.push({
        name: message.name || 'unknown',
        args: message.args || {},
        atMs: nowMs(startedAt),
      });
      currentTurnToolCalls += 1;
    }
    if (message.type === 'tool_blocked') {
      metrics.blockedToolCalls.push({
        name: message.name || 'unknown',
        args: message.args || {},
        reason: message.reason || '',
        atMs: nowMs(startedAt),
      });
      mark('tool_blocked', { name: message.name || 'unknown', reason: message.reason || '' });
    }
    if (message.type === 'tool_result') {
      metrics.lastToolResponseSentMs = nowMs(startedAt);
      metrics.lastToolDurationMs = Number.isFinite(message.durationMs) ? message.durationMs : undefined;
      const toolCall = [...metrics.toolCalls].reverse().find((call) => call.name === message.name);
      if (toolCall && Number.isFinite(message.durationMs)) toolCall.durationMs = message.durationMs;
      mark('tool_result', { name: message.name || 'unknown' });
    }
    if (message.type === 'interrupted') {
      if (!metrics.interruptedMs) metrics.interruptedMs = nowMs(startedAt);
      mark('interrupted');
    }
    if (message.type === 'turn_complete') {
      mark('turn_complete');
      const hadEmptyTurn =
        currentTurnToolCalls === 0 && currentTurnAudioBytes === 0 && currentTurnTextChars === 0;
      const hadOnlyToolCallsThisTurn =
        currentTurnToolCalls > 0 && currentTurnAudioBytes === 0 && currentTurnTextChars === 0;
      currentTurnAudioBytes = 0;
      currentTurnTextChars = 0;
      currentTurnToolCalls = 0;
      if (
        hadEmptyTurn &&
        testCase.expectTool &&
        !metrics.toolCalls.some((call) => call.name === testCase.expectTool)
      ) {
        mark('empty_turn_complete_waiting_for_tool', { expectedTool: testCase.expectTool });
        return;
      }
      if (hadOnlyToolCallsThisTurn) {
        mark('tool_turn_complete');
        return;
      }
      if (testCase.mode !== 'barge_in' || metrics.interruptedMs || metrics.toolCalls.length > 0) {
        finished = true;
        resolveDone('turn_complete');
      }
    }
    if (message.type === 'error' || message.type === 'warning') {
      metrics.error = message.message || message.code || message.type;
      finished = true;
      resolveReady();
      resolveDone(message.type);
    }
    if (message.type === 'closed') {
      metrics.closed = { code: message.code ?? null, reason: message.reason || '' };
      if (!finished) resolveDone('closed');
    }
  });
  ws.on('error', (error) => {
    metrics.error = error?.message || String(error);
    finished = true;
    resolveReady();
    resolveDone('error');
  });
  ws.on('close', (code, reason) => {
    metrics.closed = { code, reason: String(reason || '') };
    if (!finished) {
      resolveReady();
      resolveDone('closed');
    }
  });

  await Promise.race([ready, sleep(12_000)]);
  if (!metrics.events.some((event) => event.name === 'ready')) {
    metrics.setupWarning = 'ready_not_seen_before_upload';
  }
  if (metrics.error || ws.readyState !== WebSocket.OPEN) {
    metrics.finishReason = metrics.error ? 'error' : 'not_ready';
    metrics.finishedAtMs = nowMs(startedAt);
    return scoreCase(testCase, metrics);
  }

  mark('upload_start', { phase: 'first' });
  if (testCase.mode === 'barge_in') {
    if (args.activityMode === 'manual') sendWsJson(ws, { type: 'activity_start', reason: 'eval_first' });
    await streamPcmToWebSocket(ws, audio.firstPcm, args, metrics, 'first');
    if (args.activityMode === 'manual') {
      sendWsJson(ws, { type: 'activity_end', reason: 'eval_first' });
    } else {
      sendWsJson(ws, { type: 'audio_stream_end', reason: 'eval_first' });
    }
    metrics.firstEndpointMs = nowMs(startedAt);
    while (!metrics.firstAudioMs && !metrics.error && nowMs(startedAt) < args.timeoutMs) {
      await sleep(20);
    }
    await sleep(testCase.interruptAfterFirstAudioMs || 400);
    metrics.interruptUploadStartMs = nowMs(startedAt);
    mark('upload_start', { phase: 'interrupt' });
    if (args.activityMode === 'manual') sendWsJson(ws, { type: 'activity_start', reason: 'eval_interrupt' });
    await streamPcmToWebSocket(ws, audio.interruptPcm, args, metrics, 'interrupt');
    if (args.activityMode === 'manual') {
      sendWsJson(ws, { type: 'activity_end', reason: 'eval_interrupt' });
    } else {
      sendWsJson(ws, { type: 'audio_stream_end', reason: 'eval_interrupt' });
    }
    metrics.interruptEndpointMs = nowMs(startedAt);
  } else {
    if (args.activityMode === 'manual') sendWsJson(ws, { type: 'activity_start', reason: 'eval_single' });
    await streamPcmToWebSocket(ws, audio.pcm, args, metrics, 'single');
    if (args.activityMode === 'manual') {
      sendWsJson(ws, { type: 'activity_end', reason: 'eval_single' });
    } else {
      sendWsJson(ws, { type: 'audio_stream_end', reason: 'eval_single' });
    }
    metrics.endpointMs = nowMs(startedAt);
  }

  const reason = await Promise.race([done, sleep(args.timeoutMs).then(() => 'timeout')]);
  metrics.finishReason = reason;
  metrics.finishedAtMs = nowMs(startedAt);
  try {
    ws.close(1000, 'eval complete');
    await Promise.race([
      new Promise((resolve) => ws.once('close', resolve)),
      sleep(120),
    ]);
    if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
  } catch {
    // best effort
  }
  return scoreCase(testCase, metrics);
}

function scoreCase(testCase, metrics) {
  const failures = [];
  const warnings = [];
  const endpointMs = testCase.mode === 'barge_in' ? metrics.firstEndpointMs : metrics.endpointMs;
  const outputText = `${metrics.outputTranscript || ''}${metrics.text || ''}`;
  if (!metrics.firstAudioMs && !metrics.firstTextMs) failures.push('no_model_response');
  if (testCase.expectTool) {
    const names = metrics.toolCalls.map((call) => call.name);
    if (!names.includes(testCase.expectTool)) failures.push(`missing_tool:${testCase.expectTool}`);
  }
  if (testCase.expectToolArgs && metrics.toolCalls.length > 0) {
    const expectedToolCall =
      metrics.toolCalls.find((call) => !testCase.expectTool || call.name === testCase.expectTool) ||
      metrics.toolCalls[0];
    for (const [key, expected] of Object.entries(testCase.expectToolArgs)) {
      const actual = expectedToolCall?.args?.[key];
      const actualText = actual === undefined || actual === null ? '' : String(actual);
      const matches = expected instanceof RegExp
        ? expected.test(actualText)
        : actualText === String(expected);
      if (!matches) {
        failures.push(`bad_tool_arg:${expectedToolCall?.name || 'unknown'}.${key}=${JSON.stringify(actual)}`);
      }
    }
  }
  if (testCase.expectNoTool && metrics.toolCalls.length > 0) {
    failures.push(`unexpected_tool:${metrics.toolCalls.map((call) => call.name).join(',')}`);
  }
  if (testCase.expectSimplifiedChinese && hasTraditionalChinese(outputText)) {
    failures.push('non_simplified_chinese_output');
  }
  if (testCase.expectInterrupted && !metrics.interruptedMs) failures.push('missing_interrupted_event');
  if (testCase.maxInterruptMs && metrics.interruptedMs && metrics.interruptUploadStartMs) {
    const interruptMs = metrics.interruptedMs - metrics.interruptUploadStartMs;
    metrics.interruptLatencyMs = interruptMs;
    if (interruptMs > testCase.maxInterruptMs) failures.push(`slow_interrupt:${interruptMs}ms`);
  }
  if (testCase.maxFirstAudioMs && metrics.firstAudioMs && endpointMs) {
    const latency = metrics.firstAudioMs - endpointMs;
    metrics.endpointToFirstAudioMs = latency;
    if (metrics.firstInputTranscriptMs) {
      metrics.endpointToInputTranscriptMs = metrics.firstInputTranscriptMs - endpointMs;
    }
    if (metrics.firstToolCallMs) {
      metrics.endpointToToolCallMs = metrics.firstToolCallMs - endpointMs;
    }
    if (metrics.lastToolResponseSentMs) {
      metrics.toolResponseToFirstAudioMs = metrics.firstAudioMs - metrics.lastToolResponseSentMs;
    }
    if (latency > testCase.maxFirstAudioMs) failures.push(`slow_first_audio:${latency}ms`);
  }
  if (testCase.expectNoHardPass) {
    warnings.push('manual_review_only_multi_speaker_case');
  }
  if (metrics.blockedToolCalls?.length > 0) {
    warnings.push(`blocked_tool_call:${metrics.blockedToolCalls.map((call) => call.name).join(',')}`);
  }
  metrics.pass = failures.length === 0 && !testCase.expectNoHardPass;
  metrics.failures = failures;
  metrics.warnings = warnings;
  return metrics;
}

function hasTraditionalChinese(text) {
  return /[為創務檢語遲優級氣溫雲於後請這個臺灣嗎]/.test(String(text || ''));
}

function percentile(values, ratio) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return undefined;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

function msCell(value) {
  return value === undefined ? '-' : `${value}ms`;
}

function summarizeResults(results) {
  const byCase = new Map();
  for (const result of results) {
    if (!byCase.has(result.id)) byCase.set(result.id, []);
    byCase.get(result.id).push(result);
  }
  const cases = [];
  for (const [id, group] of byCase.entries()) {
    const endpointToAudio = group.map((result) => result.endpointToFirstAudioMs);
    const endpointToTool = group.map((result) => result.endpointToToolCallMs);
    const toolToAudio = group.map((result) => result.toolResponseToFirstAudioMs);
    cases.push({
      id,
      label: group[0]?.label || id,
      target: group[0]?.target || 'sdk',
      count: group.length,
      passCount: group.filter((result) => result.pass).length,
      p50EndpointToFirstAudioMs: percentile(endpointToAudio, 0.5),
      p95EndpointToFirstAudioMs: percentile(endpointToAudio, 0.95),
      maxEndpointToFirstAudioMs: percentile(endpointToAudio, 1),
      p50EndpointToToolCallMs: percentile(endpointToTool, 0.5),
      p95ToolResponseToFirstAudioMs: percentile(toolToAudio, 0.95),
      failures: [...new Set(group.flatMap((result) => result.failures || []))],
      warnings: [...new Set(group.flatMap((result) => result.warnings || []))],
    });
  }
  return {
    total: results.length,
    passed: results.filter((result) => result.pass).length,
    failed: results.filter((result) => !result.pass && !(result.warnings || []).includes('manual_review_only_multi_speaker_case')).length,
    cases,
  };
}

function writeReports(outDir, results) {
  const reportJson = path.join(outDir, 'report.json');
  const reportMd = path.join(outDir, 'report.md');
  const summary = summarizeResults(results);
  writeFileSync(reportJson, JSON.stringify({ generatedAt: new Date().toISOString(), summary, results }, null, 2));

  const lines = [
    '# Gemini Live Eval Report',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
    `Total: ${summary.total}, Passed: ${summary.passed}, Failed: ${summary.failed}`,
    '',
    '## Summary',
    '',
    '| Case | Target | Pass | P50 endpoint->audio | P95 endpoint->audio | Max endpoint->audio | P50 endpoint->tool | P95 tool->audio | Failures |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const item of summary.cases) {
    lines.push([
      item.id,
      item.target,
      `${item.passCount}/${item.count}`,
      msCell(item.p50EndpointToFirstAudioMs),
      msCell(item.p95EndpointToFirstAudioMs),
      msCell(item.maxEndpointToFirstAudioMs),
      msCell(item.p50EndpointToToolCallMs),
      msCell(item.p95ToolResponseToFirstAudioMs),
      item.failures.join('; ') || item.warnings.join('; ') || '-',
    ].join(' | '));
  }
  lines.push(
    '',
    '## Runs',
    '',
    '| Case | Pass | Endpoint->First audio | Endpoint->Tool | Tool->Audio | Tools | Blocked | Tool args | Interrupt | Failures |',
    '| --- | --- | ---: | ---: | ---: | --- | --- | --- | ---: | --- |',
  );
  for (const result of results) {
    lines.push([
      result.repeatIndex ? `${result.id} #${result.repeatIndex}` : result.id,
      result.pass ? 'yes' : 'no',
      msCell(result.endpointToFirstAudioMs),
      msCell(result.endpointToToolCallMs),
      msCell(result.toolResponseToFirstAudioMs),
      result.toolCalls.map((call) => call.name).join(', ') || '-',
      result.blockedToolCalls?.map((call) => `${call.name}:${call.reason}`).join(', ') || '-',
      result.toolCalls.map((call) => JSON.stringify(call.args)).join('<br>') || '-',
      msCell(result.interruptLatencyMs),
      result.failures.join('; ') || result.warnings.join('; ') || '-',
    ].join(' | '));
  }
  lines.push('');
  lines.push('## Notes');
  lines.push('');
  lines.push('- Audio files are generated from local TTS and may not represent all real users.');
  lines.push('- Multi-speaker overlap is included as a phase-2 risk probe and is not scored as production-ready.');
  lines.push('- Reports intentionally avoid credentials and host secrets.');
  writeFileSync(reportMd, `${lines.join('\n')}\n`);
  return { reportJson, reportMd };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (args.listCases) {
    for (const testCase of CASES) {
      console.log(`${testCase.id}\t${testCase.label}`);
    }
    return;
  }
  if (!commandExists('say')) throw new Error('macOS say command is required for TTS generation.');
  if (!commandExists('ffmpeg')) throw new Error('ffmpeg is required for audio conversion.');
  if (!Number.isFinite(args.chunkMs) || args.chunkMs <= 0) throw new Error('--chunk-ms must be positive.');
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) throw new Error('--timeout-ms must be positive.');
  if (!Number.isInteger(args.repeat) || args.repeat < 1) throw new Error('--repeat must be a positive integer.');
  if (!['sdk', 'websocket'].includes(args.target)) throw new Error('--target must be sdk or websocket.');
  if (!['audio', 'media'].includes(args.inputField)) throw new Error('--input-field must be audio or media.');
  if (!['auto', 'manual'].includes(args.activityMode)) {
    throw new Error('--activity-mode must be auto or manual.');
  }

  loadEnvFile(args.envFile);
  const config = getRuntimeConfig(args);
  validateConfig(config, args.dryRun, args.target);

  const keepAudio = args.keepAudio ?? Boolean(args.dryRun);
  const runDir = path.join(args.outDir, new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(runDir, { recursive: true });

  const cases = selectedCases(args);
  if (cases.length === 0) throw new Error('No cases selected.');
  console.log(`Gemini Live eval: ${cases.length} case(s), repeat=${args.repeat}, target=${args.target}, model=${config.model}, dryRun=${Boolean(args.dryRun)}, activity=${args.activityMode}`);
  if (args.target === 'websocket') console.log(`WebSocket: ${args.wsUrl}`);
  console.log(`Output: ${runDir}`);

  const prepared = cases.map((testCase) => ({
    testCase,
    audio: synthesizeCaseAudio(testCase, runDir),
  }));

  if (args.dryRun) {
    const results = prepared.flatMap(({ testCase, audio }) =>
      Array.from({ length: args.repeat }, (_, index) => ({
        id: testCase.id,
        label: testCase.label,
        mode: testCase.mode,
        target: args.target,
        repeatIndex: index + 1,
        dryRun: true,
        files: audio.files,
        audioMs: Math.round(((audio.pcm?.length || audio.firstPcm?.length || 0) / 2 / INPUT_SAMPLE_RATE) * 1000),
        expectedTool: testCase.expectTool || null,
        expectedInterrupted: Boolean(testCase.expectInterrupted),
        pass: true,
        failures: [],
        warnings: testCase.expectNoHardPass ? ['manual_review_only_multi_speaker_case'] : [],
        toolCalls: [],
      })),
    );
    const reports = writeReports(runDir, results);
    console.log(`Dry run complete. Report: ${reports.reportMd}`);
    return;
  }

  const client = args.target === 'sdk'
    ? new GoogleGenAI({
        vertexai: true,
        project: config.project,
        location: config.location,
      })
    : null;

  const results = [];
  for (const { testCase, audio } of prepared) {
    for (let repeatIndex = 1; repeatIndex <= args.repeat; repeatIndex += 1) {
      console.log(`\n=== ${testCase.id}: ${testCase.label} (${repeatIndex}/${args.repeat}) ===`);
      const result = args.target === 'websocket'
        ? await runWebSocketCase(testCase, audio, args)
        : await runSingleCase(client, config, testCase, audio, args);
      result.repeatIndex = repeatIndex;
      result.target = args.target;
      results.push(result);
      console.log(
        JSON.stringify({
          pass: result.pass,
          endpointToFirstAudioMs: result.endpointToFirstAudioMs,
          endpointToToolCallMs: result.endpointToToolCallMs,
          toolResponseToFirstAudioMs: result.toolResponseToFirstAudioMs,
          interruptLatencyMs: result.interruptLatencyMs,
          tools: result.toolCalls.map((call) => call.name),
          failures: result.failures,
        }),
      );
    }
  }

  const reports = writeReports(runDir, results);
  console.log(`\nReport: ${reports.reportMd}`);
  console.log(`JSON: ${reports.reportJson}`);
  if (!keepAudio) rmSync(path.join(runDir, 'audio'), { recursive: true, force: true });
  if (results.some((result) => !result.pass && !result.warnings.includes('manual_review_only_multi_speaker_case'))) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});
