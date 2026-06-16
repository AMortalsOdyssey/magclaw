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
const evalTasks = [];

const SYSTEM_INSTRUCTION = `
You are evaluating a realtime voice assistant for MagClaw.
Reply in the same language as the user, keep answers short, and use tools immediately
when a test case asks for weather, math, demo tickets, tasks, or public holidays.
Only call tools when the user explicitly asks for that tool-like action. Do not call tools
for interruption/control phrases such as "等一下", "停一下", "wait", or "stop", and do not
call tools for casual chat, explanations, advice, or long-form speaking requests.
For Chinese replies, use Mainland Mandarin phrasing and Simplified Chinese characters.
For unclear noisy or overlapping speech, ask a concise clarification instead of inventing details.
After a function response, start the answer immediately with one short spoken sentence.
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

const CASES = [
  {
    id: 'short_weather_zh',
    label: '短命令：中文天气工具调用',
    mode: 'single',
    segments: [{ text: '帮我查一下杭州今天的天气。', voice: DEFAULT_TTS_VOICE }],
    expectTool: 'get_weather',
    expectToolArgs: { city: /Hangzhou|杭州/i },
    expectOutput: [/杭州|Hangzhou/i, /天气|气温|温度|度|摄氏|°|weather|temperature/i],
    expectSimplifiedChinese: true,
    maxFirstAudioMs: 2800,
  },
  {
    id: 'tiny_command_zh',
    label: '极短交互：几个字',
    mode: 'single',
    segments: [{ text: '等一下。', voice: DEFAULT_TTS_VOICE }],
    expectNoTool: true,
    allowNoModelResponse: true,
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
    expectOutput: [/杭州|Hangzhou/i, /天气|气温|温度|度|摄氏|°|weather|temperature/i],
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
    expectOutput: [/任务|创建|记下|created|task/i, /检查实时语音延迟/],
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
    expectOutput: [/888|八百八十八/],
    expectSimplifiedChinese: true,
    maxFirstAudioMs: 3200,
  },
  {
    id: 'short_weather_en',
    label: '短命令：英文天气工具调用',
    mode: 'single',
    segments: [{ text: 'Check the weather in Shanghai, China today.', voice: DEFAULT_ENGLISH_VOICE }],
    expectTool: 'get_weather',
    expectToolArgs: { city: /Shanghai|上海/i },
    expectOutput: [/Shanghai|上海/i, /weather|temperature|degree|celsius|°|天气|气温|温度|度/i],
    maxFirstAudioMs: 2800,
  },
  {
    id: 'multi_turn_weather_followup_zh',
    label: '多轮上下文：天气追问城市',
    mode: 'multi_turn',
    turns: [
      {
        label: '第一轮：杭州天气',
        segments: [{ text: '帮我查一下杭州今天的天气。', voice: DEFAULT_TTS_VOICE }],
        expectTool: 'get_weather',
        expectToolArgs: { city: /Hangzhou|杭州/i },
        expectOutput: [/杭州|Hangzhou/i, /天气|气温|温度|度|摄氏|°|weather|temperature/i],
      },
      {
        label: '第二轮：追问上海',
        segments: [{ text: '那上海呢？', voice: DEFAULT_TTS_VOICE }],
        expectTool: 'get_weather',
        expectToolArgs: { city: /Shanghai|上海/i },
        expectOutput: [/上海|Shanghai/i, /天气|气温|温度|度|摄氏|°|weather|temperature/i],
      },
    ],
    expectSimplifiedChinese: true,
    maxFirstAudioMs: 3200,
  },
  {
    id: 'multi_turn_mixed_tools_zh',
    label: '多轮工具链：计算、创建任务、查询任务',
    mode: 'multi_turn',
    turns: [
      {
        label: '第一轮：计算',
        segments: [{ text: '先帮我算一下三十七乘以二十四。', voice: DEFAULT_TTS_VOICE }],
        expectTool: 'calculate_expression',
        expectToolArgs: { expression: /37\s*[*×x]\s*24/ },
        expectOutput: [/888|八百八十八/],
      },
      {
        label: '第二轮：创建任务',
        segments: [{ text: '再创建一个演示任务，标题是实时语音回归检查，优先级高。', voice: DEFAULT_TTS_VOICE }],
        expectTool: 'create_demo_task',
        expectToolArgs: { title: /实时语音回归/ },
        expectOutput: [/实时语音回归|回归检查/, /任务|创建|created|task/i],
      },
      {
        label: '第三轮：查询刚才任务',
        segments: [{ text: '列一下刚才创建的任务。', voice: DEFAULT_TTS_VOICE }],
        expectTool: 'list_demo_tasks',
        expectOutput: [/实时语音回归|回归检查/, /任务|task/i],
      },
    ],
    expectSimplifiedChinese: true,
    maxFirstAudioMs: 3600,
  },
  {
    id: 'barge_in_stop_zh',
    label: '打断：助手说话中插入停一下',
    mode: 'barge_in',
    firstSegments: [{ text: '请朗读下面这段文字三遍：今天下午风很轻，窗外很安静，我们正在测试实时语音打断效果。', voice: DEFAULT_TTS_VOICE }],
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

function sleep(ms, options = {}) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (options.ref === false) timer.unref?.();
  });
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

  if (testCase.mode === 'multi_turn') {
    const turns = testCase.turns.map((turn, index) => {
      const pcm = addWhiteNoise(
        synthesizeSegments(turn.segments, caseDir, `turn-${index + 1}`),
        turn.noiseLevel ?? testCase.noiseLevel ?? 0,
        `${testCase.id}:turn-${index + 1}`,
      );
      const wavPath = path.join(caseDir, `turn-${index + 1}.wav`);
      writeWavFile(wavPath, pcm);
      return { pcm, file: wavPath };
    });
    return { turns, files: turns.map((turn) => turn.file) };
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
      name: 'list_demo_tasks',
      description: 'List deterministic mock tasks created earlier in this evaluation session.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          limit: { type: Type.NUMBER, description: 'Maximum tasks to return.' },
        },
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
    const priority = args.priority || 'medium';
    const task = {
      id: `TASK-${Date.now().toString().slice(-6)}`,
      title: args.title || 'untitled',
      priority,
      priority_label_zh: priority === 'high' ? '高' : priority === 'low' ? '低' : '中等',
      status: 'created',
      source: 'eval_mock',
      spoken_summary: `已创建任务：“${args.title || 'untitled'}”，优先级${priority === 'high' ? '高' : priority === 'low' ? '低' : '中等'}。`,
    };
    evalTasks.push(task);
    return task;
  }
  if (name === 'list_demo_tasks') {
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
    return {
      count: evalTasks.length,
      tasks: evalTasks.slice(-limit).reverse(),
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

function toolResponseForModel(output) {
  if (output && typeof output === 'object' && typeof output.spoken_summary === 'string') {
    return { spoken_summary: output.spoken_summary };
  }
  return { output };
}

function compactControlText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。！？；：、,.!?;:~～…'"“”‘’()（）[\]{}]/g, '');
}

function isControlOnlyUtterance(value) {
  return /^(等一下|等下|等等|稍等|让一下|停一下|停下|先停|暂停|打住|别说了|不要说了|先别说|先别讲|停|stop|wait|pause|holdon|onemoment|waitasecond|hangon)$/.test(
    compactControlText(value),
  );
}

function shouldBlockEvalToolCall(name, args = {}, latestInputTranscript = '') {
  const argText = Object.values(args || {}).join(' ');
  if (isControlOnlyUtterance(latestInputTranscript) || isControlOnlyUtterance(argText)) {
    return {
      blocked: true,
      name,
      reason: 'control_utterance_without_tool_intent',
      latestInputTranscript,
    };
  }
  return { blocked: false };
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

function audioDurationMs(audio) {
  if (audio?.turns?.length) {
    return audio.turns.reduce((total, turn) => (
      total + Math.round((turn.pcm.length / 2 / INPUT_SAMPLE_RATE) * 1000)
    ), 0);
  }
  const pcm = audio?.pcm || audio?.firstPcm || Buffer.alloc(0);
  return Math.round((pcm.length / 2 / INPUT_SAMPLE_RATE) * 1000);
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

function makeEvalMetrics(testCase, target, startedAt) {
  return {
    id: testCase.id,
    label: testCase.label,
    mode: testCase.mode,
    target,
    startedAt: new Date(startedAt).toISOString(),
    streams: [],
    events: [],
    toolCalls: [],
    blockedToolCalls: [],
    toolSummaries: [],
    responseDelayWarnings: [],
    inputTranscript: '',
    outputTranscript: '',
    text: '',
    audioBytes: 0,
  };
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
  const metrics = makeEvalMetrics(testCase, 'sdk', startedAt);

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
          const allowedCalls = [];
          const functionResponses = calls.map((call) => {
            const guard = shouldBlockEvalToolCall(call.name, call.args || {}, metrics.inputTranscript);
            if (guard.blocked) {
              metrics.blockedToolCalls.push({
                name: call.name || 'unknown',
                args: call.args || {},
                reason: guard.reason,
                atMs: nowMs(startedAt),
              });
              return {
                id: call.id,
                name: call.name,
                response: toolResponseForModel({
                  error: 'blocked_tool_call',
                  reason: guard.reason,
                  message: 'The tool call was blocked because the latest user utterance did not clearly request it.',
                }),
              };
            }
            if (!metrics.firstToolCallMs) metrics.firstToolCallMs = nowMs(startedAt);
            const toolCall = {
              name: call.name || 'unknown',
              args: call.args || {},
              atMs: nowMs(startedAt),
            };
            metrics.toolCalls.push(toolCall);
            allowedCalls.push(toolCall);
            currentTurnToolCalls += 1;
            const output = runEvalTool(call.name, call.args || {});
            if (output && typeof output === 'object' && typeof output.spoken_summary === 'string') {
              metrics.toolSummaries.push({
                name: call.name || 'unknown',
                text: output.spoken_summary,
                atMs: nowMs(startedAt),
              });
            }
            return {
              id: call.id,
              name: call.name,
              response: toolResponseForModel(output),
            };
          });
          session.sendToolResponse({ functionResponses });
          metrics.lastToolResponseSentMs = nowMs(startedAt);
          mark('tool_response_sent', { count: allowedCalls.length, blocked: calls.length - allowedCalls.length });
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

  await Promise.race([setupReady, sleep(5000, { ref: false })]);
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

  const timeout = sleep(args.timeoutMs, { ref: false }).then(() => 'timeout');
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

async function runMultiTurnCase(client, config, testCase, audio, args) {
  const startedAt = Date.now();
  const metrics = makeEvalMetrics(testCase, 'sdk', startedAt);
  metrics.turns = [];

  let session;
  let finished = false;
  let activeTurn = null;
  let resolveTurnDone = null;
  let resolveSetup;
  const setupReady = new Promise((resolve) => {
    resolveSetup = resolve;
  });
  const mark = (name, extra = {}) => {
    metrics.events.push({ name, atMs: nowMs(startedAt), ...extra });
    if (activeTurn) activeTurn.events.push({ name, atMs: nowMs(startedAt), ...extra });
  };
  const resolveActiveTurn = (reason) => {
    if (resolveTurnDone) {
      const resolve = resolveTurnDone;
      resolveTurnDone = null;
      resolve(reason);
    }
  };
  const recordTextForTurn = (field, value) => {
    if (!activeTurn) return;
    activeTurn[field] += value;
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
          if (activeTurn && !activeTurn.firstInputTranscriptMs) activeTurn.firstInputTranscriptMs = nowMs(startedAt);
          metrics.inputTranscript += message.serverContent.inputTranscription.text;
          recordTextForTurn('inputTranscript', message.serverContent.inputTranscription.text);
        }
        if (message.serverContent?.outputTranscription?.text) {
          if (!metrics.firstOutputTranscriptMs) metrics.firstOutputTranscriptMs = nowMs(startedAt);
          if (activeTurn && !activeTurn.firstOutputTranscriptMs) activeTurn.firstOutputTranscriptMs = nowMs(startedAt);
          metrics.outputTranscript += message.serverContent.outputTranscription.text;
          recordTextForTurn('outputTranscript', message.serverContent.outputTranscription.text);
        }
        for (const text of extractTextParts(message)) {
          if (!metrics.firstTextMs) metrics.firstTextMs = nowMs(startedAt);
          if (activeTurn && !activeTurn.firstTextMs) activeTurn.firstTextMs = nowMs(startedAt);
          metrics.text += text;
          recordTextForTurn('text', text);
          currentTurnTextChars += text.length;
        }
        const audioChunks = extractAudioParts(message);
        for (const chunk of audioChunks) {
          if (!metrics.firstAudioMs) metrics.firstAudioMs = nowMs(startedAt);
          if (activeTurn && !activeTurn.firstAudioMs) activeTurn.firstAudioMs = nowMs(startedAt);
          metrics.audioBytes += chunk.length;
          if (activeTurn) activeTurn.audioBytes += chunk.length;
          currentTurnAudioBytes += chunk.length;
        }
        if (message.serverContent?.interrupted) {
          if (!metrics.interruptedMs) metrics.interruptedMs = nowMs(startedAt);
          if (activeTurn && !activeTurn.interruptedMs) activeTurn.interruptedMs = nowMs(startedAt);
          mark('interrupted');
        }
        const calls = message.toolCall?.functionCalls || [];
        if (calls.length > 0) {
          const allowedCalls = [];
          const functionResponses = calls.map((call) => {
            const guard = shouldBlockEvalToolCall(
              call.name,
              call.args || {},
              activeTurn?.inputTranscript || metrics.inputTranscript,
            );
            if (guard.blocked) {
              const blocked = {
                name: call.name || 'unknown',
                args: call.args || {},
                reason: guard.reason,
                atMs: nowMs(startedAt),
              };
              metrics.blockedToolCalls.push(blocked);
              activeTurn?.blockedToolCalls.push(blocked);
              return {
                id: call.id,
                name: call.name,
                response: toolResponseForModel({
                  error: 'blocked_tool_call',
                  reason: guard.reason,
                  message: 'The tool call was blocked because the latest user utterance did not clearly request it.',
                }),
              };
            }
            if (!metrics.firstToolCallMs) metrics.firstToolCallMs = nowMs(startedAt);
            if (activeTurn && !activeTurn.firstToolCallMs) activeTurn.firstToolCallMs = nowMs(startedAt);
            const toolCall = {
              name: call.name || 'unknown',
              args: call.args || {},
              atMs: nowMs(startedAt),
            };
            metrics.toolCalls.push(toolCall);
            activeTurn?.toolCalls.push(toolCall);
            allowedCalls.push(toolCall);
            currentTurnToolCalls += 1;
            const output = runEvalTool(call.name, call.args || {});
            if (output && typeof output === 'object' && typeof output.spoken_summary === 'string') {
              const summary = {
                name: call.name || 'unknown',
                text: output.spoken_summary,
                atMs: nowMs(startedAt),
              };
              metrics.toolSummaries.push(summary);
              activeTurn?.toolSummaries.push(summary);
            }
            return {
              id: call.id,
              name: call.name,
              response: toolResponseForModel(output),
            };
          });
          session.sendToolResponse({ functionResponses });
          metrics.lastToolResponseSentMs = nowMs(startedAt);
          if (activeTurn) activeTurn.lastToolResponseSentMs = nowMs(startedAt);
          mark('tool_response_sent', { count: allowedCalls.length, blocked: calls.length - allowedCalls.length });
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
            activeTurn &&
            hadEmptyTurn &&
            activeTurn.spec?.expectTool &&
            !activeTurn.toolCalls.some((call) => call.name === activeTurn.spec.expectTool)
          ) {
            mark('empty_turn_complete_waiting_for_tool', { expectedTool: activeTurn.spec.expectTool });
            return;
          }
          if (hadOnlyToolCallsThisTurn) {
            mark('tool_turn_complete');
            return;
          }
          resolveActiveTurn('turn_complete');
        }
        if (message.usageMetadata) metrics.usage = message.usageMetadata;
      },
      onerror: (error) => {
        metrics.error = error?.message || String(error);
        activeTurn && (activeTurn.error = metrics.error);
        finished = true;
        resolveSetup();
        resolveActiveTurn('error');
      },
      onclose: (event) => {
        metrics.closed = { code: event?.code ?? null, reason: event?.reason || '' };
        resolveSetup();
        if (!finished) resolveActiveTurn('closed');
      },
    },
  });

  await Promise.race([setupReady, sleep(5000, { ref: false })]);
  if (!metrics.events.some((event) => event.name === 'setup_complete')) {
    metrics.setupWarning = 'setup_complete_not_seen_before_upload';
  }

  for (let index = 0; index < testCase.turns.length; index += 1) {
    const spec = testCase.turns[index];
    activeTurn = makeEvalMetrics(
      { id: `${testCase.id}:turn_${index + 1}`, label: spec.label || `Turn ${index + 1}`, mode: 'single' },
      'sdk',
      startedAt,
    );
    activeTurn.spec = spec;
    activeTurn.turnIndex = index + 1;
    metrics.turns.push(activeTurn);
    const turnDone = new Promise((resolve) => {
      resolveTurnDone = resolve;
    });
    mark('upload_start', { phase: `turn_${index + 1}` });
    sendActivityStart(session, activeTurn, mark, args, `turn_${index + 1}`);
    await streamPcm(session, audio.turns[index].pcm, args, metrics, `turn_${index + 1}`);
    sendActivityEnd(session, mark, args, `turn_${index + 1}`);
    activeTurn.endpointMs = nowMs(startedAt);
    metrics.endpointMs = activeTurn.endpointMs;
    const reason = await Promise.race([
      turnDone,
      sleep(args.timeoutMs, { ref: false }).then(() => 'timeout'),
    ]);
    activeTurn.finishReason = reason;
    activeTurn.finishedAtMs = nowMs(startedAt);
    if (reason === 'timeout' || reason === 'error' || reason === 'closed') {
      if (!metrics.error && reason !== 'timeout') metrics.error = reason;
      break;
    }
    activeTurn = null;
    await sleep(180);
  }

  metrics.finishReason = metrics.error || metrics.turns.length < testCase.turns.length ? 'incomplete' : 'turn_complete';
  metrics.finishedAtMs = nowMs(startedAt);
  try {
    session.close();
  } catch {
    // best effort
  }
  return scoreMultiTurnCase(testCase, metrics);
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
  const metrics = makeEvalMetrics(testCase, 'websocket', startedAt);
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
    if (message.type === 'response_latency') {
      metrics.responseLatency = {
        endpointToAudioMs: Number.isFinite(message.endpointToAudioMs) ? message.endpointToAudioMs : null,
        toolResponseToAudioMs: Number.isFinite(message.toolResponseToAudioMs) ? message.toolResponseToAudioMs : null,
        reason: message.reason || '',
        toolNames: message.toolNames || [],
        atMs: nowMs(startedAt),
      };
      mark('response_latency', metrics.responseLatency);
    }
    if (message.type === 'response_delay_warning') {
      const warning = {
        trigger: message.trigger || '',
        thresholdMs: Number.isFinite(message.thresholdMs) ? message.thresholdMs : null,
        endpointToAudioMs: Number.isFinite(message.endpointToAudioMs) ? message.endpointToAudioMs : null,
        toolResponseToAudioMs: Number.isFinite(message.toolResponseToAudioMs) ? message.toolResponseToAudioMs : null,
        reason: message.reason || '',
        toolNames: message.toolNames || [],
        atMs: nowMs(startedAt),
      };
      metrics.responseDelayWarnings.push(warning);
      mark('response_delay_warning', warning);
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
    if (message.type === 'tool_summary') {
      metrics.toolSummaries.push({
        name: message.name || 'unknown',
        text: message.text || '',
        atMs: nowMs(startedAt),
      });
      mark('tool_summary', { name: message.name || 'unknown' });
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

  await Promise.race([ready, sleep(12_000, { ref: false })]);
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

  const reason = await Promise.race([done, sleep(args.timeoutMs, { ref: false }).then(() => 'timeout')]);
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

async function runWebSocketMultiTurnCase(testCase, audio, args) {
  const startedAt = Date.now();
  const metrics = makeEvalMetrics(testCase, 'websocket', startedAt);
  metrics.turns = [];
  const mark = (name, extra = {}) => {
    metrics.events.push({ name, atMs: nowMs(startedAt), ...extra });
    if (activeTurn) activeTurn.events.push({ name, atMs: nowMs(startedAt), ...extra });
  };

  let ws;
  let finished = false;
  let activeTurn = null;
  let resolveReady;
  let resolveTurnDone;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  const resolveActiveTurn = (reason) => {
    if (resolveTurnDone) {
      const resolve = resolveTurnDone;
      resolveTurnDone = null;
      resolve(reason);
    }
  };
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
      if (activeTurn && !activeTurn.firstInputTranscriptMs) activeTurn.firstInputTranscriptMs = nowMs(startedAt);
      metrics.inputTranscript += message.text || '';
      if (activeTurn) activeTurn.inputTranscript += message.text || '';
    }
    if (message.type === 'output_transcript') {
      if (!metrics.firstOutputTranscriptMs) metrics.firstOutputTranscriptMs = nowMs(startedAt);
      if (activeTurn && !activeTurn.firstOutputTranscriptMs) activeTurn.firstOutputTranscriptMs = nowMs(startedAt);
      metrics.outputTranscript += message.text || '';
      if (activeTurn) activeTurn.outputTranscript += message.text || '';
    }
    if (message.type === 'text') {
      if (!metrics.firstTextMs) metrics.firstTextMs = nowMs(startedAt);
      if (activeTurn && !activeTurn.firstTextMs) activeTurn.firstTextMs = nowMs(startedAt);
      metrics.text += message.text || '';
      if (activeTurn) activeTurn.text += message.text || '';
      currentTurnTextChars += String(message.text || '').length;
    }
    if (message.type === 'audio') {
      const bytes = getAudioMessageBytes(message.audio);
      if (!metrics.firstAudioMs) metrics.firstAudioMs = nowMs(startedAt);
      if (activeTurn && !activeTurn.firstAudioMs) activeTurn.firstAudioMs = nowMs(startedAt);
      metrics.audioBytes += bytes;
      if (activeTurn) activeTurn.audioBytes += bytes;
      currentTurnAudioBytes += bytes;
    }
    if (message.type === 'response_latency') {
      const latency = {
        endpointToAudioMs: Number.isFinite(message.endpointToAudioMs) ? message.endpointToAudioMs : null,
        toolResponseToAudioMs: Number.isFinite(message.toolResponseToAudioMs) ? message.toolResponseToAudioMs : null,
        reason: message.reason || '',
        toolNames: message.toolNames || [],
        atMs: nowMs(startedAt),
      };
      metrics.responseLatency = latency;
      if (activeTurn) activeTurn.responseLatency = latency;
      mark('response_latency', latency);
    }
    if (message.type === 'response_delay_warning') {
      const warning = {
        trigger: message.trigger || '',
        thresholdMs: Number.isFinite(message.thresholdMs) ? message.thresholdMs : null,
        endpointToAudioMs: Number.isFinite(message.endpointToAudioMs) ? message.endpointToAudioMs : null,
        toolResponseToAudioMs: Number.isFinite(message.toolResponseToAudioMs) ? message.toolResponseToAudioMs : null,
        reason: message.reason || '',
        toolNames: message.toolNames || [],
        atMs: nowMs(startedAt),
      };
      metrics.responseDelayWarnings.push(warning);
      activeTurn?.responseDelayWarnings.push(warning);
      mark('response_delay_warning', warning);
    }
    if (message.type === 'tool_call') {
      if (!metrics.firstToolCallMs) metrics.firstToolCallMs = nowMs(startedAt);
      if (activeTurn && !activeTurn.firstToolCallMs) activeTurn.firstToolCallMs = nowMs(startedAt);
      const toolCall = {
        name: message.name || 'unknown',
        args: message.args || {},
        atMs: nowMs(startedAt),
      };
      metrics.toolCalls.push(toolCall);
      activeTurn?.toolCalls.push(toolCall);
      currentTurnToolCalls += 1;
    }
    if (message.type === 'tool_blocked') {
      const blocked = {
        name: message.name || 'unknown',
        args: message.args || {},
        reason: message.reason || '',
        atMs: nowMs(startedAt),
      };
      metrics.blockedToolCalls.push(blocked);
      activeTurn?.blockedToolCalls.push(blocked);
      mark('tool_blocked', { name: blocked.name, reason: blocked.reason });
    }
    if (message.type === 'tool_result') {
      metrics.lastToolResponseSentMs = nowMs(startedAt);
      if (activeTurn) activeTurn.lastToolResponseSentMs = nowMs(startedAt);
      metrics.lastToolDurationMs = Number.isFinite(message.durationMs) ? message.durationMs : undefined;
      const toolCall = [...metrics.toolCalls].reverse().find((call) => call.name === message.name);
      if (toolCall && Number.isFinite(message.durationMs)) toolCall.durationMs = message.durationMs;
      mark('tool_result', { name: message.name || 'unknown' });
    }
    if (message.type === 'tool_summary') {
      const summary = {
        name: message.name || 'unknown',
        text: message.text || '',
        atMs: nowMs(startedAt),
      };
      metrics.toolSummaries.push(summary);
      activeTurn?.toolSummaries.push(summary);
      mark('tool_summary', { name: summary.name });
    }
    if (message.type === 'interrupted') {
      if (!metrics.interruptedMs) metrics.interruptedMs = nowMs(startedAt);
      if (activeTurn && !activeTurn.interruptedMs) activeTurn.interruptedMs = nowMs(startedAt);
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
        activeTurn &&
        hadEmptyTurn &&
        activeTurn.spec?.expectTool &&
        !activeTurn.toolCalls.some((call) => call.name === activeTurn.spec.expectTool)
      ) {
        mark('empty_turn_complete_waiting_for_tool', { expectedTool: activeTurn.spec.expectTool });
        return;
      }
      if (hadOnlyToolCallsThisTurn) {
        mark('tool_turn_complete');
        return;
      }
      resolveActiveTurn('turn_complete');
    }
    if (message.type === 'error' || message.type === 'warning') {
      metrics.error = message.message || message.code || message.type;
      activeTurn && (activeTurn.error = metrics.error);
      finished = true;
      resolveReady();
      resolveActiveTurn(message.type);
    }
    if (message.type === 'closed') {
      metrics.closed = { code: message.code ?? null, reason: message.reason || '' };
      if (!finished) resolveActiveTurn('closed');
    }
  });
  ws.on('error', (error) => {
    metrics.error = error?.message || String(error);
    activeTurn && (activeTurn.error = metrics.error);
    finished = true;
    resolveReady();
    resolveActiveTurn('error');
  });
  ws.on('close', (code, reason) => {
    metrics.closed = { code, reason: String(reason || '') };
    if (!finished) {
      resolveReady();
      resolveActiveTurn('closed');
    }
  });

  await Promise.race([ready, sleep(12_000, { ref: false })]);
  if (!metrics.events.some((event) => event.name === 'ready')) {
    metrics.setupWarning = 'ready_not_seen_before_upload';
  }
  if (metrics.error || ws.readyState !== WebSocket.OPEN) {
    metrics.finishReason = metrics.error ? 'error' : 'not_ready';
    metrics.finishedAtMs = nowMs(startedAt);
    return scoreMultiTurnCase(testCase, metrics);
  }

  for (let index = 0; index < testCase.turns.length; index += 1) {
    const spec = testCase.turns[index];
    activeTurn = makeEvalMetrics(
      { id: `${testCase.id}:turn_${index + 1}`, label: spec.label || `Turn ${index + 1}`, mode: 'single' },
      'websocket',
      startedAt,
    );
    activeTurn.spec = spec;
    activeTurn.turnIndex = index + 1;
    metrics.turns.push(activeTurn);
    const turnDone = new Promise((resolve) => {
      resolveTurnDone = resolve;
    });
    mark('upload_start', { phase: `turn_${index + 1}` });
    if (args.activityMode === 'manual') sendWsJson(ws, { type: 'activity_start', reason: `eval_turn_${index + 1}` });
    await streamPcmToWebSocket(ws, audio.turns[index].pcm, args, metrics, `turn_${index + 1}`);
    if (args.activityMode === 'manual') {
      sendWsJson(ws, { type: 'activity_end', reason: `eval_turn_${index + 1}` });
    } else {
      sendWsJson(ws, { type: 'audio_stream_end', reason: `eval_turn_${index + 1}` });
    }
    activeTurn.endpointMs = nowMs(startedAt);
    metrics.endpointMs = activeTurn.endpointMs;
    const reason = await Promise.race([
      turnDone,
      sleep(args.timeoutMs, { ref: false }).then(() => 'timeout'),
    ]);
    activeTurn.finishReason = reason;
    activeTurn.finishedAtMs = nowMs(startedAt);
    if (reason === 'timeout' || reason === 'error' || reason === 'warning' || reason === 'closed') {
      if (!metrics.error && reason !== 'timeout') metrics.error = reason;
      break;
    }
    activeTurn = null;
    await sleep(180);
  }

  metrics.finishReason = metrics.error || metrics.turns.length < testCase.turns.length ? 'incomplete' : 'turn_complete';
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
  return scoreMultiTurnCase(testCase, metrics);
}

function scoreMultiTurnCase(testCase, metrics) {
  const failures = [];
  const warnings = [];
  const turnScores = [];
  for (let index = 0; index < testCase.turns.length; index += 1) {
    const turnSpec = testCase.turns[index];
    const turnMetrics = metrics.turns?.[index];
    if (!turnMetrics) {
      failures.push(`missing_turn:${index + 1}`);
      continue;
    }
    const turnCase = {
      ...turnSpec,
      id: `${testCase.id}:turn_${index + 1}`,
      label: turnSpec.label || `Turn ${index + 1}`,
      mode: 'single',
      expectSimplifiedChinese: turnSpec.expectSimplifiedChinese ?? testCase.expectSimplifiedChinese,
      maxFirstAudioMs: turnSpec.maxFirstAudioMs ?? testCase.maxFirstAudioMs,
    };
    const scored = scoreCase(turnCase, turnMetrics);
    turnScores.push({
      index: index + 1,
      id: turnCase.id,
      pass: scored.pass,
      endpointToFirstAudioMs: scored.endpointToFirstAudioMs,
      endpointToToolCallMs: scored.endpointToToolCallMs,
      toolResponseToFirstAudioMs: scored.toolResponseToFirstAudioMs,
      toolCalls: scored.toolCalls,
      qualityChecks: scored.qualityChecks,
      failures: scored.failures,
      warnings: scored.warnings,
    });
    for (const failure of scored.failures || []) failures.push(`turn_${index + 1}:${failure}`);
    for (const warning of scored.warnings || []) warnings.push(`turn_${index + 1}:${warning}`);
  }
  if (metrics.error) failures.push(`session_error:${metrics.error}`);
  if ((metrics.turns || []).length < testCase.turns.length) {
    failures.push(`incomplete_turns:${(metrics.turns || []).length}/${testCase.turns.length}`);
  }

  const maxFinite = (values) => {
    const finite = values.filter((value) => Number.isFinite(value));
    return finite.length ? Math.max(...finite) : undefined;
  };
  metrics.turnScores = turnScores;
  metrics.endpointToFirstAudioMs = maxFinite(turnScores.map((turn) => turn.endpointToFirstAudioMs));
  metrics.endpointToToolCallMs = maxFinite(turnScores.map((turn) => turn.endpointToToolCallMs));
  metrics.toolResponseToFirstAudioMs = maxFinite(turnScores.map((turn) => turn.toolResponseToFirstAudioMs));
  metrics.qualityChecks = turnScores.flatMap((turn) =>
    (turn.qualityChecks || []).map((check) => ({
      ...check,
      turn: turn.index,
      label: `turn_${turn.index}:${check.label}`,
    })),
  );
  metrics.normalizedOutputText = (metrics.turns || [])
    .map((turn) => turn.normalizedOutputText || '')
    .join('\n');
  metrics.pass = failures.length === 0;
  metrics.failures = failures;
  metrics.warnings = [...new Set(warnings)];
  return metrics;
}

function scoreCase(testCase, metrics) {
  const failures = [];
  const warnings = [];
  const endpointMs = testCase.mode === 'barge_in' ? metrics.firstEndpointMs : metrics.endpointMs;
  const rawOutputText = `${metrics.outputTranscript || ''}${metrics.text || ''}`;
  const rawToolSummaryText = (metrics.toolSummaries || []).map((item) => item.text || '').join('\n');
  const modelOutputText = normalizeChineseDisplayText(rawOutputText);
  const outputText = normalizeChineseDisplayText(`${rawOutputText}\n${rawToolSummaryText}`);
  metrics.normalizedModelOutputText = modelOutputText;
  metrics.normalizedOutputText = outputText;
  metrics.qualityChecks = [];
  if (!metrics.firstAudioMs && !metrics.firstTextMs) {
    if (testCase.allowNoModelResponse) warnings.push('no_model_response_allowed');
    else failures.push('no_model_response');
  }
  if (testCase.expectOutput?.length) {
    if (!outputText.trim()) failures.push('missing_output_for_quality_check');
    for (const expected of testCase.expectOutput) {
      const matches = expected instanceof RegExp
        ? expected.test(outputText)
        : outputText.includes(String(expected));
      const modelMatches = expected instanceof RegExp
        ? expected.test(modelOutputText)
        : modelOutputText.includes(String(expected));
      const label = expected instanceof RegExp ? expected.toString() : String(expected);
      metrics.qualityChecks.push({ label, pass: matches, modelPass: modelMatches });
      if (!matches) failures.push(`quality_missing:${label}`);
      else if (!modelMatches) warnings.push(`model_audio_missing_quality:${label}`);
    }
  }
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
  if (metrics.responseDelayWarnings?.length > 0) {
    warnings.push(`response_delay_warning:${metrics.responseDelayWarnings.map((item) => item.trigger || 'unknown').join(',')}`);
  }
  if (Number.isFinite(metrics.endpointToToolCallMs) && metrics.endpointToToolCallMs > 2200) {
    warnings.push(`slow_tool_call:${metrics.endpointToToolCallMs}ms`);
  }
  if (Number.isFinite(metrics.toolResponseToFirstAudioMs) && metrics.toolResponseToFirstAudioMs > 2200) {
    warnings.push(`slow_audio_after_tool:${metrics.toolResponseToFirstAudioMs}ms`);
  }
  metrics.pass = failures.length === 0 && !testCase.expectNoHardPass;
  metrics.failures = failures;
  metrics.warnings = warnings;
  return metrics;
}

function hasTraditionalChinese(text) {
  return /[為創務檢語遲優級氣溫雲於後請這個臺灣嗎]/.test(String(text || ''));
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
    const qualityRuns = group.filter((result) => (result.qualityChecks || []).length > 0);
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
      responseDelayWarningCount: group.reduce(
        (count, result) => count + (result.responseDelayWarnings?.length || 0),
        0,
      ),
      qualityApplicableCount: qualityRuns.length,
      qualityPassCount: qualityRuns.filter((result) =>
        (result.qualityChecks || []).every((check) => check.pass),
      ).length,
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
    '| Case | Target | Pass | Quality | Delay warnings | P50 endpoint->audio | P95 endpoint->audio | Max endpoint->audio | P50 endpoint->tool | P95 tool->audio | Findings |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const item of summary.cases) {
    lines.push([
      item.id,
      item.target,
      `${item.passCount}/${item.count}`,
      item.qualityApplicableCount ? `${item.qualityPassCount}/${item.qualityApplicableCount}` : '-',
      String(item.responseDelayWarningCount || 0),
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
    '| Case | Pass | Quality | Delay warnings | Endpoint->First audio | Endpoint->Tool | Tool->Audio | Tools | Blocked | Tool args | Interrupt | Findings |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- | --- | --- | ---: | --- |',
  );
  for (const result of results) {
    const qualityChecks = result.qualityChecks || [];
    lines.push([
      result.repeatIndex ? `${result.id} #${result.repeatIndex}` : result.id,
      result.pass ? 'yes' : 'no',
      qualityChecks.length ? `${qualityChecks.filter((check) => check.pass).length}/${qualityChecks.length}` : '-',
      String(result.responseDelayWarnings?.length || 0),
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
        audioMs: audioDurationMs(audio),
        expectedTool: testCase.expectTool || testCase.turns?.map((turn) => turn.expectTool).filter(Boolean) || null,
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
      evalTasks.length = 0;
      console.log(`\n=== ${testCase.id}: ${testCase.label} (${repeatIndex}/${args.repeat}) ===`);
      const result = testCase.mode === 'multi_turn'
        ? (args.target === 'websocket'
          ? await runWebSocketMultiTurnCase(testCase, audio, args)
          : await runMultiTurnCase(client, config, testCase, audio, args))
        : (args.target === 'websocket'
          ? await runWebSocketCase(testCase, audio, args)
          : await runSingleCase(client, config, testCase, audio, args));
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
