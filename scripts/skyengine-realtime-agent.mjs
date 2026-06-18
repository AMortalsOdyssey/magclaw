#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_ENV_FILE = path.join(__dirname, 'skyengine-realtime-agent.env.local');
const DEFAULT_BASE_URL = 'https://model-api.skyengine.com.cn';
const DEFAULT_MODEL = 'gpt-realtime-2.0';
const DEFAULT_VOICE = 'sage';
const DEFAULT_SPEED = 1.04;
const SAMPLE_RATE = 24_000;
const VOICE_TEST_VOICES = [
  'cedar',
  'marin',
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'sage',
  'shimmer',
  'verse',
];
const DEFAULT_VOICE_TEST_TEXT =
  '你好，我在测试中文普通话。今天状态不错，我们慢慢聊。';
const DEFAULT_PERSONA = `
You are a realtime bilingual Chinese/English voice operator for phase-one testing.
Detect the user's language automatically on every turn. If the user speaks Chinese,
reply in Chinese; if the user speaks English, reply in English. If the user mixes
languages, keep the main reply in the dominant language and preserve technical terms.

Voice style: sound like a real person in a quick voice chat, not a narrator,
customer-service script, audiobook, or formal assistant. Use short spoken sentences.
Avoid canned phrases like "尊贵的您", "很荣幸", "马上为您效劳", "as you requested",
and avoid reading long lists unless the user asks for detail.

For Chinese output, use standard Mainland Mandarin Putonghua with native Chinese
prosody, tones, rhythm, and pauses. It should sound like a Chinese person chatting
normally, not like a foreign-accented speaker reading Chinese with English prosody.

Personality: warm, attentive, lightly flattering, and fast to execute. The flattery
should be subtle, like "这个问题抓得很准" or "我懂你的意思", not exaggerated.
When the user asks for an action and a tool is available, call the tool immediately.
After a tool finishes, report the result casually in one or two sentences. For long
tool results, summarize the important part first and offer to expand.
Never claim that a local action is complete until you have received the tool result.
`;

function usage() {
  console.log(`Usage:
  node scripts/skyengine-realtime-agent.mjs
  npm run skyengine:realtime

Setup:
  cp scripts/skyengine-realtime-agent.env.example scripts/skyengine-realtime-agent.env.local
  # Fill SKYENGINE_API_KEY in the local ignored env file.

Options:
  --text <prompt>      Send one text turn, useful for quick tool-call testing.
  --once               Exit after the current turn completes. Default for --text.
  --text-response      Use text output instead of audio output.
  --audio-response     Use audio output, default for microphone mode.
  --voice <name>       Output voice, default: ${DEFAULT_VOICE}. Known: ${VOICE_TEST_VOICES.join(', ')}.
  --speed <n>          Output speech speed, default: ${DEFAULT_SPEED}.
  --voice-test         Play the same test sentence with each known voice, then exit.
  --voice-test-text <text>
                       Sentence used by --voice-test.
  --voice-test-voices <csv>
                       Voices used by --voice-test, default: ${VOICE_TEST_VOICES.join(',')}.
  --voice-test-out <path>
                       Save all voice-test samples into one combined WAV file.
  --voice-test-strict Stop voice test on the first failed voice.
  --allow-incomplete  Treat an incomplete response as success. Used by --voice-test.
  --mic-device <dev>   ffmpeg avfoundation input, default: env or :0.
  --list-devices       List macOS avfoundation audio devices and exit.
  --chunk-ms <n>       Microphone packet duration, default: 40.
  --vad-silence-ms <n> Server VAD silence duration, default: 500.
  --barge-in           Allow user speech to interrupt assistant responses. Default on.
  --no-barge-in        Disable interruption while the assistant is speaking.
  --wait-playback      Wait for audio playback to drain before printing Listening. Default on.
  --no-wait-playback   Print Listening as soon as the model response is done.
  --no-tools           Disable local tool calling.
  --play               Play returned audio, default for audio response.
  --no-play            Disable returned audio playback.
  --model <id>         Model id, default: ${DEFAULT_MODEL}.
  --base-url <url>     Base URL, default: ${DEFAULT_BASE_URL}.
  --env <path>         Env file, default: scripts/skyengine-realtime-agent.env.local.
  --dry-run            Validate config and local dependencies without connecting.

Voice test phrases:
  查询电脑名称
  查询本机正在运行的进程
  帮我打开 Chrome 浏览器的一个标签页
  Tell me the computer name in English
`);
}

function parseArgs(argv) {
  const args = {
    envFile: DEFAULT_ENV_FILE,
    chunkMs: 40,
    vadSilenceMs: 500,
    tools: true,
    play: undefined,
    responseMode: undefined,
    voice: undefined,
    speed: undefined,
    bargeIn: true,
    waitPlayback: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };

    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--text') args.text = next();
    else if (arg === '--once') args.once = true;
    else if (arg === '--text-response') args.responseMode = 'text';
    else if (arg === '--audio-response') args.responseMode = 'audio';
    else if (arg === '--voice') args.voice = next();
    else if (arg === '--speed') args.speed = Number(next());
    else if (arg === '--voice-test') args.voiceTest = true;
    else if (arg === '--voice-test-text') args.voiceTestText = next();
    else if (arg === '--voice-test-voices') args.voiceTestVoices = next();
    else if (arg === '--voice-test-out') {
      args.voiceTest = true;
      args.voiceTestOut = next();
    }
    else if (arg === '--voice-test-strict') args.voiceTestStrict = true;
    else if (arg === '--allow-incomplete') args.allowIncomplete = true;
    else if (arg === '--mic-device') args.micDevice = next();
    else if (arg === '--list-devices') args.listDevices = true;
    else if (arg === '--chunk-ms') args.chunkMs = Number(next());
    else if (arg === '--vad-silence-ms') args.vadSilenceMs = Number(next());
    else if (arg === '--barge-in') args.bargeIn = true;
    else if (arg === '--no-barge-in') args.bargeIn = false;
    else if (arg === '--wait-playback') args.waitPlayback = true;
    else if (arg === '--no-wait-playback') args.waitPlayback = false;
    else if (arg === '--no-tools') args.tools = false;
    else if (arg === '--play') args.play = true;
    else if (arg === '--no-play') args.play = false;
    else if (arg === '--model') args.model = next();
    else if (arg === '--base-url') args.baseUrl = next();
    else if (arg === '--env') args.envFile = next();
    else if (arg === '--dry-run') args.dryRun = true;
    else throw new Error(`Unknown option: ${arg}`);
  }

  if (args.text && args.once === undefined) args.once = true;
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
  const result =
    process.platform === 'win32'
      ? spawnSync('where', [command], { encoding: 'utf8' })
      : spawnSync('sh', ['-lc', `command -v ${JSON.stringify(command)} >/dev/null 2>&1`], {
          encoding: 'utf8',
        });
  return result.status === 0;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: options.timeoutMs || 8_000,
  });
  return {
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    error: result.error?.message,
  };
}

function ensurePositiveNumber(name, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
}

function buildRealtimeUrl(baseUrl, model) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
  url.pathname = `${url.pathname.replace(/\/$/, '')}/v1/realtime`;
  url.searchParams.set('model', model);
  return url.toString();
}

function getConfig(args) {
  const apiKey = process.env.SKYENGINE_API_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error(`Missing SKYENGINE_API_KEY. Put it in ${args.envFile} or export it.`);
  }

  const baseUrl = args.baseUrl || process.env.SKYENGINE_BASE_URL || DEFAULT_BASE_URL;
  const model = args.model || process.env.SKYENGINE_REALTIME_MODEL || DEFAULT_MODEL;
  const responseMode = args.responseMode || (args.text ? 'text' : 'audio');
  const voice = args.voice || process.env.SKYENGINE_REALTIME_VOICE || DEFAULT_VOICE;
  const speed = args.speed ?? Number(process.env.SKYENGINE_REALTIME_SPEED || DEFAULT_SPEED);
  const inputTranscriptionModel =
    process.env.SKYENGINE_REALTIME_INPUT_TRANSCRIPTION_MODEL || 'whisper-1';
  ensurePositiveNumber('--speed', speed);

  return {
    apiKey,
    baseUrl,
    model,
    realtimeUrl: buildRealtimeUrl(baseUrl, model),
    micDevice: args.micDevice || process.env.SKYENGINE_REALTIME_MIC_DEVICE || ':0',
    responseMode,
    voice,
    speed,
    inputTranscriptionModel:
      inputTranscriptionModel && inputTranscriptionModel.toLowerCase() !== 'none'
        ? inputTranscriptionModel
        : null,
    instructions: process.env.SKYENGINE_REALTIME_SYSTEM_PROMPT || DEFAULT_PERSONA.trim(),
  };
}

function listDevices() {
  if (!commandExists('ffmpeg')) throw new Error('--list-devices requires ffmpeg');
  const result = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
    { encoding: 'utf8' },
  );
  console.log(result.stderr || result.stdout || 'No device output from ffmpeg.');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function wavHeader(dataBytes, sampleRate, channels = 1, bitsPerSample = 16) {
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

function writeWav(filePath, pcmChunks, sampleRate = SAMPLE_RATE) {
  const dataBytes = pcmChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, Buffer.concat([wavHeader(dataBytes, sampleRate), ...pcmChunks]));
}

function silencePcm(ms) {
  return Buffer.alloc(Math.round(SAMPLE_RATE * 2 * (ms / 1000)));
}

function cleanProcessLog(data) {
  return String(data)
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '')
    .trim();
}

function isExpectedPipeCloseError(error) {
  return ['EPIPE', 'ERR_STREAM_DESTROYED', 'ECONNRESET'].includes(error?.code);
}

function warnUnexpectedPlaybackError(error) {
  if (!error || isExpectedPipeCloseError(error)) return;
  console.warn(`[Playback] ${error.message || error}`);
}

function startPlaybackProcess(onClose) {
  if (!commandExists('ffplay')) {
    console.warn('ffplay not found; audio playback disabled.');
    return null;
  }

  const child = spawn(
    'ffplay',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nodisp',
      '-autoexit',
      '-fflags',
      'nobuffer',
      '-flags',
      'low_delay',
      '-probesize',
      '32',
      '-analyzeduration',
      '0',
      '-f',
      's16le',
      '-ar',
      String(SAMPLE_RATE),
      '-ch_layout',
      'mono',
      '-i',
      'pipe:0',
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );

  child.stderr.on('data', (data) => {
    const text = cleanProcessLog(data);
    if (text) console.warn(`[ffplay] ${text}`);
  });
  child.stdin.on('error', warnUnexpectedPlaybackError);
  child.on('error', warnUnexpectedPlaybackError);
  child.on('close', () => onClose?.(child));
  return child;
}

function createPlayback(enabled) {
  const bytesPerMs = (SAMPLE_RATE * 2) / 1000;
  let child = null;
  let drainAt = 0;

  const ensureChild = () => {
    if (!enabled) return null;
    if (child && child.exitCode === null && !child.killed && child.stdin?.writable) return child;
    child = startPlaybackProcess((closedChild) => {
      if (child === closedChild) child = null;
    });
    return child;
  };

  return {
    write(audio) {
      if (!enabled || !audio.length) return;
      const player = ensureChild();
      if (!player?.stdin?.writable) return;
      try {
        player.stdin.write(audio, warnUnexpectedPlaybackError);
      } catch (error) {
        warnUnexpectedPlaybackError(error);
        if (player === child) child = null;
        drainAt = 0;
        return;
      }

      const now = Date.now();
      const audioMs = audio.length / bytesPerMs;
      drainAt = Math.max(drainAt, now + 120) + audioMs;
    },
    drainDelayMs() {
      return Math.max(0, Math.ceil(drainAt - Date.now()));
    },
    isDraining() {
      return this.drainDelayMs() > 80;
    },
    interrupt() {
      const pendingMs = this.drainDelayMs();
      drainAt = 0;
      closeProcess(child);
      child = null;
      return pendingMs;
    },
    close() {
      drainAt = 0;
      closeProcess(child);
      child = null;
    },
  };
}

function closeProcess(child) {
  if (!child) return;
  try {
    if (child.stdin?.writable) child.stdin.destroy();
  } catch {
    // best effort
  }
  try {
    if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
  } catch {
    // best effort
  }
}

function startMicrophone(config, args, state, send) {
  if (process.platform !== 'darwin') {
    throw new Error('Microphone mode currently uses ffmpeg avfoundation and is supported on macOS.');
  }
  if (!commandExists('ffmpeg')) throw new Error('Microphone mode requires ffmpeg.');
  const chunkBytes = Math.max(2, Math.round(SAMPLE_RATE * 2 * (args.chunkMs / 1000)));
  const recorder = spawn(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'avfoundation',
      '-i',
      config.micDevice,
      '-ac',
      '1',
      '-ar',
      String(SAMPLE_RATE),
      '-f',
      's16le',
      'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let pending = Buffer.alloc(0);
  let sentChunks = 0;
  let droppedChunks = 0;

  recorder.stdout.on('data', (data) => {
    if (state.micUploadSuppressed) {
      droppedChunks += Math.max(1, Math.ceil(data.length / chunkBytes));
      return;
    }
    pending = Buffer.concat([pending, data]);
    while (pending.length >= chunkBytes) {
      const chunk = pending.subarray(0, chunkBytes);
      pending = pending.subarray(chunkBytes);
      send({ type: 'input_audio_buffer.append', audio: chunk.toString('base64') });
      sentChunks += 1;
    }
  });

  recorder.stderr.on('data', (data) => {
    const text = cleanProcessLog(data);
    if (text) console.warn(`[ffmpeg] ${text}`);
  });

  recorder.on('close', (code) => {
    if (state.stopping) return;
    console.warn(`[Mic] ffmpeg exited with code ${code}. Sent chunks=${sentChunks}, dropped=${droppedChunks}.`);
  });

  console.log(`[Mic] listening on avfoundation device ${config.micDevice}. Press Ctrl+C to stop.`);
  return recorder;
}

function appleScriptString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function getComputerName() {
  const computerName =
    process.platform === 'darwin' ? run('scutil', ['--get', 'ComputerName']).stdout : '';
  const localHostName =
    process.platform === 'darwin' ? run('scutil', ['--get', 'LocalHostName']).stdout : '';
  const hostResult = run('hostname', []);
  return {
    computer_name: computerName || os.hostname(),
    local_hostname: localHostName || null,
    hostname: hostResult.stdout || os.hostname(),
    platform: process.platform,
  };
}

function listRunningProcesses(rawArgs = {}) {
  const limit = Math.min(Math.max(Number(rawArgs.limit) || 15, 1), 50);
  const filter = String(rawArgs.filter || '').trim().toLowerCase();

  if (process.platform === 'win32') {
    const result = run('powershell', [
      '-NoProfile',
      '-Command',
      'Get-Process | Sort-Object CPU -Descending | Select-Object -First 50 Id,ProcessName,CPU,WorkingSet | ConvertTo-Json -Compress',
    ]);
    if (result.status !== 0) return { error: result.stderr || result.error || 'Get-Process failed' };
    return { platform: process.platform, raw: result.stdout.slice(0, 12_000) };
  }

  const result = run('ps', ['-axo', 'pid=,ppid=,pcpu=,pmem=,comm=']);
  if (result.status !== 0) return { error: result.stderr || result.error || 'ps failed' };

  const processes = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(.+)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        cpu_percent: Number(match[3]),
        mem_percent: Number(match[4]),
        command: match[5],
      };
    })
    .filter(Boolean)
    .filter((item) => !filter || item.command.toLowerCase().includes(filter))
    .sort((a, b) => b.cpu_percent - a.cpu_percent || b.mem_percent - a.mem_percent)
    .slice(0, limit);

  return {
    platform: process.platform,
    filter: filter || null,
    count: processes.length,
    processes,
  };
}

function openChromeNewTab(rawArgs = {}) {
  const targetUrl = String(rawArgs.url || 'chrome://newtab/').trim() || 'chrome://newtab/';
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      error: 'chrome_new_tab currently uses AppleScript and is implemented for macOS only.',
    };
  }
  if (!commandExists('osascript')) {
    return { ok: false, error: 'osascript not found.' };
  }

  const script = [
    'tell application "Google Chrome"',
    'activate',
    'if (count of windows) = 0 then',
    'make new window',
    'end if',
    'tell front window',
    `make new tab at end of tabs with properties {URL:${appleScriptString(targetUrl)}}`,
    'set active tab index to (count of tabs)',
    'end tell',
    'end tell',
  ];
  const osaArgs = script.flatMap((line) => ['-e', line]);
  const result = run('osascript', osaArgs, { timeoutMs: 10_000 });
  return {
    ok: result.status === 0,
    url: targetUrl,
    stdout: result.stdout || undefined,
    error: result.status === 0 ? undefined : result.stderr || result.error || 'osascript failed',
  };
}

function getCurrentTime(rawArgs = {}) {
  const timeZone = String(rawArgs.timezone || 'Asia/Shanghai');
  const now = new Date();
  return {
    iso_time: now.toISOString(),
    timezone: timeZone,
    local_time: new Intl.DateTimeFormat('zh-CN', {
      timeZone,
      dateStyle: 'medium',
      timeStyle: 'medium',
    }).format(now),
  };
}

function getVoiceTestVoices(args) {
  if (!args.voiceTestVoices) return VOICE_TEST_VOICES;
  return args.voiceTestVoices
    .split(',')
    .map((voice) => voice.trim())
    .filter(Boolean);
}

function runVoiceTest(args) {
  const voices = getVoiceTestVoices(args);
  const text = args.voiceTestText || DEFAULT_VOICE_TEST_TEXT;
  if (!voices.length) throw new Error('--voice-test-voices must include at least one voice.');

  console.log(`Voice test text: ${text}`);
  console.log(`Voices: ${voices.join(', ')}`);
  console.log(`Mode: ${args.voiceTestStrict ? 'strict' : 'continue on failed voice'}`);
  console.log('Tip: use --voice-test-voices sage,coral,marin to narrow a second pass.\n');

  const failures = [];
  for (let index = 0; index < voices.length; index += 1) {
    const voice = voices[index];
    console.log(`\n=== Voice ${index + 1}/${voices.length}: ${voice} ===`);
    const childArgs = [
      __filename,
      '--audio-response',
      '--text',
      text,
      '--voice',
      voice,
      '--speed',
      String(args.speed ?? (process.env.SKYENGINE_REALTIME_SPEED || DEFAULT_SPEED)),
      '--no-tools',
      '--env',
      args.envFile,
      '--allow-incomplete',
    ];

    if (args.play === false) childArgs.push('--no-play');
    if (args.play === true) childArgs.push('--play');
    if (args.dryRun) childArgs.push('--dry-run');
    if (!args.waitPlayback) childArgs.push('--no-wait-playback');
    if (!args.bargeIn) childArgs.push('--no-barge-in');

    const result = spawnSync(process.execPath, childArgs, {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      const failure = `Voice test failed for ${voice} with exit code ${result.status}`;
      failures.push(failure);
      console.warn(failure);
      if (args.voiceTestStrict) throw new Error(failure);
    }
  }

  if (failures.length) {
    console.warn(`\nVoice test completed with ${failures.length} failed voice(s):`);
    for (const failure of failures) console.warn(`- ${failure}`);
  } else {
    console.log('\nVoice test completed.');
  }
}

function generateVoiceSample(config, args, voice, text, index, total) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let transcript = '';
    let settled = false;
    let ws;

    const settle = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
      } catch {
        // best effort
      }
      if (error) reject(error);
      else resolve(result);
    };

    const send = (payload) => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    };

    const prompt = `音色 ${voice}。${text}`;

    const timer = setTimeout(() => {
      settle(new Error(`Timed out generating voice ${voice}`));
    }, 45_000);

    ws = new WebSocket(config.realtimeUrl, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        'OpenAI-Beta': 'realtime=v1',
      },
      handshakeTimeout: 10_000,
    });

    ws.on('message', (buffer) => {
      let event;
      try {
        event = JSON.parse(buffer.toString());
      } catch {
        return;
      }

      if (event.type === 'session.created') {
        send({
          type: 'session.update',
          session: {
            type: 'realtime',
            output_modalities: ['audio'],
            instructions: `
You are recording a voice comparison sample.
The next user message is the exact script to speak aloud, character for character.
Speak only that script. Do not paraphrase, translate, explain, add labels, or omit
the voice name. For Chinese, use standard Mainland Mandarin Putonghua with native
Chinese rhythm, tones, and pauses, like a Chinese person chatting naturally.
`.trim(),
            audio: {
              input: {
                format: { type: 'audio/pcm', rate: SAMPLE_RATE },
              },
              output: {
                voice,
                speed: args.speed ?? config.speed,
              },
            },
          },
        });
        return;
      }

      if (event.type === 'session.updated') {
        send({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: prompt }],
          },
        });
        send({ type: 'response.create', response: {} });
        return;
      }

      if (event.type === 'response.output_audio.delta') {
        const audio = Buffer.from(event.delta || '', 'base64');
        if (audio.length) chunks.push(audio);
        return;
      }

      if (event.type === 'response.output_audio_transcript.delta') {
        transcript += event.delta || '';
        return;
      }

      if (event.type === 'response.output_audio_transcript.done') {
        transcript = event.transcript || transcript;
        return;
      }

      if (event.type === 'error') {
        settle(new Error(`Voice ${voice} failed: ${JSON.stringify(event.error || event)}`));
        return;
      }

      if (event.type === 'response.done') {
        const status = event.response?.status;
        if (!chunks.length) {
          settle(new Error(`Voice ${voice} returned no audio; status=${status || 'unknown'}`));
          return;
        }
        if (status !== 'completed' && !(args.allowIncomplete || status === 'incomplete')) {
          settle(new Error(`Voice ${voice} response ${status || 'unknown'}`));
          return;
        }
        settle(null, {
          voice,
          index,
          total,
          status,
          transcript,
          pcm: Buffer.concat(chunks),
        });
      }
    });

    ws.on('error', (error) => settle(error));
    ws.on('unexpected-response', (_request, response) => {
      let body = '';
      response.on('data', (chunk) => {
        body += chunk.toString();
      });
      response.on('end', () => {
        settle(new Error(`Voice ${voice} handshake failed: HTTP ${response.statusCode} ${body}`.trim()));
      });
    });
  });
}

async function exportVoiceTest(config, args) {
  const voices = getVoiceTestVoices(args);
  const text = args.voiceTestText || DEFAULT_VOICE_TEST_TEXT;
  const outputPath = path.resolve(args.voiceTestOut);
  if (!voices.length) throw new Error('--voice-test-voices must include at least one voice.');

  console.log(`Voice test text: ${text}`);
  console.log(`Voices: ${voices.join(', ')}`);
  console.log(`Output WAV: ${outputPath}`);
  if (args.dryRun) {
    console.log('Dry run complete. Voice-test WAV was not generated.');
    return;
  }

  const wavParts = [];
  const failures = [];
  for (let index = 0; index < voices.length; index += 1) {
    const voice = voices[index];
    console.log(`Generating ${index + 1}/${voices.length}: ${voice}`);
    try {
      const sample = await generateVoiceSample(config, args, voice, text, index + 1, voices.length);
      console.log(`[${voice}] ${sample.status}; transcript=${sample.transcript || '(none)'}`);
      if (wavParts.length) wavParts.push(silencePcm(900));
      wavParts.push(sample.pcm);
    } catch (error) {
      const failure = `${voice}: ${error.message || error}`;
      failures.push(failure);
      console.warn(`Voice export failed for ${failure}`);
      if (args.voiceTestStrict) throw error;
    }
  }

  if (!wavParts.length) {
    throw new Error(`No voice-test audio was generated. Failures: ${failures.join('; ')}`);
  }

  writeWav(outputPath, wavParts);
  console.log(`Saved combined voice-test WAV: ${outputPath}`);
  if (failures.length) {
    console.warn(`Completed with ${failures.length} failed voice(s):`);
    for (const failure of failures) console.warn(`- ${failure}`);
  }
}

function getToolDefinitions() {
  return [
    {
      type: 'function',
      name: 'get_computer_name',
      description: 'Query the local computer name and host name. Use when the user asks for this computer name.',
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'list_running_processes',
      description:
        'List local running processes, sorted by CPU usage. Use when the user asks what is running on this machine.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Maximum number of processes to return, from 1 to 50. Default 15.',
          },
          filter: {
            type: 'string',
            description: 'Optional command-name filter, for example Chrome or node.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'chrome_new_tab',
      description:
        'Open a new Google Chrome tab on this Mac. Use when the user asks to open Chrome, create a new browser tab, or open a URL in Chrome.',
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Optional URL. If omitted, open a blank Chrome new tab page.',
          },
        },
        additionalProperties: false,
      },
    },
    {
      type: 'function',
      name: 'get_current_time',
      description: 'Get the current local time. Useful as a simple latency and tool-call smoke test.',
      parameters: {
        type: 'object',
        properties: {
          timezone: {
            type: 'string',
            description: 'IANA timezone. Default Asia/Shanghai.',
          },
        },
        additionalProperties: false,
      },
    },
  ];
}

async function executeToolCall(call) {
  let args = {};
  if (call.arguments) {
    try {
      args = JSON.parse(call.arguments);
    } catch (error) {
      return { error: `Invalid JSON arguments: ${error.message}`, raw_arguments: call.arguments };
    }
  }

  if (call.name === 'get_computer_name') return getComputerName();
  if (call.name === 'list_running_processes') return listRunningProcesses(args);
  if (call.name === 'chrome_new_tab') return openChromeNewTab(args);
  if (call.name === 'get_current_time') return getCurrentTime(args);
  return { error: `Unknown tool: ${call.name}` };
}

function buildSessionUpdate(config, args) {
  const input = {
    format: { type: 'audio/pcm', rate: SAMPLE_RATE },
    turn_detection: {
      type: 'server_vad',
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: args.vadSilenceMs,
      create_response: true,
      interrupt_response: args.bargeIn,
    },
  };
  if (config.inputTranscriptionModel) {
    input.transcription = { model: config.inputTranscriptionModel };
  }

  const session = {
    type: 'realtime',
    output_modalities: [config.responseMode],
    instructions: config.instructions,
    audio: {
      input,
      output: {
        voice: config.voice,
        speed: config.speed,
      },
    },
  };

  if (args.tools) {
    session.tools = getToolDefinitions();
    session.tool_choice = 'auto';
  }

  return { type: 'session.update', session };
}

function parseFunctionCall(item) {
  return {
    name: item.name,
    call_id: item.call_id,
    arguments: item.arguments || '{}',
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (args.listDevices) {
    listDevices();
    return;
  }
  ensurePositiveNumber('--chunk-ms', args.chunkMs);
  ensurePositiveNumber('--vad-silence-ms', args.vadSilenceMs);
  loadEnvFile(args.envFile);
  const config = getConfig(args);

  if (args.voiceTest) {
    if (args.voiceTestOut) {
      await exportVoiceTest(config, args);
      return;
    }
    runVoiceTest(args);
    return;
  }

  const playbackEnabled = args.play ?? config.responseMode === 'audio';
  if (config.responseMode === 'audio' && playbackEnabled && !commandExists('ffplay')) {
    console.warn('ffplay not found; continuing without live playback.');
  }
  if (!args.text && !commandExists('ffmpeg')) {
    throw new Error('Microphone mode requires ffmpeg. Run --text for a no-mic smoke test.');
  }

  console.log(`Model: ${config.model}`);
  console.log(`Endpoint: ${config.realtimeUrl.replace(/([?&]model=)[^&]+/, `$1${config.model}`)}`);
  console.log(`Response: ${config.responseMode}`);
  if (config.responseMode === 'audio') {
    console.log(`Voice: ${config.voice}, speed=${config.speed}`);
  }
  console.log(`Tools: ${args.tools ? 'enabled' : 'disabled'}`);
  console.log(`Language: auto-detect by model instructions${config.inputTranscriptionModel ? `, input transcription=${config.inputTranscriptionModel}` : ''}`);
  console.log(`Persona: natural voice-chat executor`);
  console.log(`Barge-in: ${args.bargeIn ? 'enabled' : 'disabled'}`);
  console.log(`Playback sync: ${args.waitPlayback ? 'wait for drain' : 'do not wait'}`);

  if (args.dryRun) {
    console.log('Dry run complete. WebSocket was not opened.');
    return;
  }

  const state = {
    stopping: false,
    sessionReady: false,
    micUploadSuppressed: false,
    pendingToolCalls: [],
    currentAssistantTextOpen: false,
    handledResponses: 0,
    assistantResponseActive: false,
    cancelSent: false,
    interruptedThisTurn: false,
    dropCurrentResponseOutput: false,
  };

  let ws;
  let recorder = null;
  let player = null;

  const cleanup = () => {
    state.stopping = true;
    closeProcess(recorder);
    player?.close?.();
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      try {
        ws.close();
      } catch {
        // best effort
      }
    }
  };

  process.on('SIGINT', () => {
    console.log('\nStopping realtime agent...');
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  const send = (payload) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  };

  const flushAssistantLine = () => {
    if (state.currentAssistantTextOpen) {
      process.stdout.write('\n');
      state.currentAssistantTextOpen = false;
    }
  };

  const waitForPlaybackDrain = async () => {
    if (!args.waitPlayback || !player?.isDraining?.()) return;
    const initialDelay = player.drainDelayMs();
    if (initialDelay > 150) {
      console.log(`[Playback] waiting for audio to finish (${(initialDelay / 1000).toFixed(1)}s).`);
    }
    while (!state.stopping && player.isDraining()) {
      await sleep(Math.min(100, Math.max(20, player.drainDelayMs())));
    }
  };

  const handleToolCalls = async () => {
    if (!state.pendingToolCalls.length) return false;
    const calls = state.pendingToolCalls.splice(0);
    state.micUploadSuppressed = true;

    for (const call of calls) {
      console.log(`[Tool] ${call.name}(${call.arguments || '{}'})`);
      const result = await executeToolCall(call);
      console.log(`[ToolResult] ${JSON.stringify(result).slice(0, 2000)}`);
      send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: call.call_id,
          output: JSON.stringify(result),
        },
      });
    }
    send({ type: 'response.create', response: {} });
    return true;
  };

  ws = new WebSocket(config.realtimeUrl, {
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'OpenAI-Beta': 'realtime=v1',
    },
    handshakeTimeout: 10_000,
  });

  ws.on('open', () => {
    console.log('Connected. Waiting for session...');
    player = createPlayback(playbackEnabled && config.responseMode === 'audio');
  });

  ws.on('message', async (buffer) => {
    let event;
    try {
      event = JSON.parse(buffer.toString());
    } catch {
      console.warn(`[Event] non-JSON message ${buffer.length} bytes`);
      return;
    }

    if (event.type === 'session.created') {
      console.log(`Session: ${event.session?.id || '(unknown)'} model=${event.session?.model || config.model}`);
      send(buildSessionUpdate(config, args));
      return;
    }

    if (event.type === 'session.updated') {
      state.sessionReady = true;
      console.log('Session ready.');
      if (args.text) {
        send({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: args.text }],
          },
        });
        send({ type: 'response.create', response: {} });
      } else {
        recorder = startMicrophone(config, args, state, send);
      }
      return;
    }

    if (event.type === 'input_audio_buffer.speech_started') {
      if (args.bargeIn && (state.assistantResponseActive || player?.isDraining?.())) {
        flushAssistantLine();
        const droppedMs = player?.interrupt?.() || 0;
        state.interruptedThisTurn = true;
        state.dropCurrentResponseOutput = true;
        state.micUploadSuppressed = false;
        if (state.assistantResponseActive && !state.cancelSent) {
          send({ type: 'response.cancel' });
          state.cancelSent = true;
        }
        console.log(
          `[Interrupt] user speech detected; stopped assistant audio${droppedMs ? `, cleared ${(droppedMs / 1000).toFixed(1)}s queued playback` : ''}.`,
        );
      }
      console.log('[You] speech started');
      return;
    }

    if (event.type === 'input_audio_buffer.speech_stopped') {
      console.log('[You] speech stopped');
      return;
    }

    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      if (event.transcript) console.log(`[You] ${event.transcript}`);
      return;
    }

    if (event.type === 'conversation.item.input_audio_transcription.failed') {
      console.warn(`[InputTranscript] failed: ${JSON.stringify(event.error || {})}`);
      return;
    }

    if (event.type === 'response.created') {
      state.assistantResponseActive = true;
      state.cancelSent = false;
      state.interruptedThisTurn = false;
      state.dropCurrentResponseOutput = false;
      state.micUploadSuppressed = !args.bargeIn;
      return;
    }

    if (event.type === 'response.output_audio.delta') {
      if (state.dropCurrentResponseOutput) return;
      const audio = Buffer.from(event.delta || '', 'base64');
      if (audio.length) player?.write?.(audio);
      return;
    }

    if (
      event.type === 'response.output_audio_transcript.delta' ||
      event.type === 'response.output_text.delta'
    ) {
      if (state.dropCurrentResponseOutput) return;
      if (!state.currentAssistantTextOpen) {
        process.stdout.write('[Assistant] ');
        state.currentAssistantTextOpen = true;
      }
      process.stdout.write(event.delta || '');
      return;
    }

    if (
      event.type === 'response.output_audio_transcript.done' ||
      event.type === 'response.output_text.done'
    ) {
      if (state.dropCurrentResponseOutput) return;
      flushAssistantLine();
      return;
    }

    if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
      if (state.dropCurrentResponseOutput) return;
      state.pendingToolCalls.push(parseFunctionCall(event.item));
      return;
    }

    if (event.type === 'response.done') {
      flushAssistantLine();
      state.handledResponses += 1;
      state.assistantResponseActive = false;
      const wasInterrupted = state.interruptedThisTurn;
      state.dropCurrentResponseOutput = false;
      const hasMoreWork = await handleToolCalls();
      if (!hasMoreWork) {
        if (!args.bargeIn) state.micUploadSuppressed = true;
        await waitForPlaybackDrain();
        state.micUploadSuppressed = false;
        console.log(
          `[Turn] response ${event.response?.status || 'done'}${wasInterrupted ? ' after interruption' : ''}. Listening.`,
        );
        if (args.once) {
          cleanup();
          const status = event.response?.status;
          process.exit(status === 'completed' || (args.allowIncomplete && status === 'incomplete') ? 0 : 1);
        }
      }
      return;
    }

    if (event.type === 'error') {
      flushAssistantLine();
      console.error(`[RealtimeError] ${JSON.stringify(event.error || event)}`);
      return;
    }
  });

  ws.on('unexpected-response', (_request, response) => {
    let body = '';
    response.on('data', (chunk) => {
      body += chunk.toString();
      if (body.length > 2000) response.destroy();
    });
    response.on('end', () => {
      console.error(`WebSocket handshake failed: HTTP ${response.statusCode} ${body}`.trim());
      cleanup();
      process.exit(1);
    });
  });

  ws.on('close', (code, reason) => {
    if (state.stopping) return;
    console.log(`Connection closed: code=${code} reason=${reason.toString()}`);
    cleanup();
  });

  ws.on('error', (error) => {
    console.error(`WebSocket error: ${error.message}`);
    cleanup();
    process.exitCode = 1;
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
