#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, Modality, Type } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_ENV_FILE = path.join(__dirname, 'gemini-live.env.local');
const DEFAULT_MODEL = 'gemini-live-2.5-flash-native-audio';
const INPUT_SAMPLE_RATE = 16_000;
const OUTPUT_SAMPLE_RATE = 24_000;

function usage() {
  console.log(`Usage:
  node scripts/gemini-live-dialog.mjs --text "你好，用中文简单介绍你自己"
  node scripts/gemini-live-dialog.mjs --text "查一下北京现在几点" --tool-demo
  node scripts/gemini-live-dialog.mjs --mic --seconds 12
  node scripts/gemini-live-dialog.mjs --audio input.wav --out tmp/gemini-live-reply.wav

Setup:
  cp scripts/gemini-live.env.example scripts/gemini-live.env.local
  # Put your service account JSON in a local ignored path, then edit GOOGLE_APPLICATION_CREDENTIALS.

Options:
  --text <text>        Send text into a Live session. Defaults to text response unless --audio-response is set.
  --mic                Capture microphone audio with ffmpeg avfoundation and stream it live.
  --audio <path>       Convert an audio file to 16 kHz mono PCM and stream it in realtime.
  --pcm <path>         Raw 16 kHz, mono, signed 16-bit little-endian PCM input.
  --seconds <n>        Microphone capture duration, default: 8.
  --mic-device <dev>   ffmpeg avfoundation input, default: :0. Use --list-devices to inspect.
  --list-devices       List macOS avfoundation audio devices and exit.
  --tool-demo          Enable local demo functions: get_current_time, get_weather, lookup_order_status.
  --audio-response     Ask Gemini Live for audio output.
  --text-response      Ask Gemini Live for text output.
  --play               Play returned 24 kHz PCM while receiving it. Default for --mic/--audio/--pcm audio response.
  --no-play            Disable playback.
  --out <path>         Output WAV for model speech, default: tmp/gemini-live-reply.wav.
  --model <id>         Model id, default: ${DEFAULT_MODEL}.
  --project <id>       Google Cloud project id. Overrides GOOGLE_CLOUD_PROJECT.
  --location <loc>     Google Cloud location, default from env or global.
  --credentials <path> Service account JSON path. Overrides GOOGLE_APPLICATION_CREDENTIALS.
  --env <path>         Env file, default: scripts/gemini-live.env.local.
  --timeout-ms <n>     Overall receive timeout, default: 45000.
  --tail-timeout-ms <n>Stop after this idle time once reply audio starts, default: 1800.
  --chunk-ms <n>       Audio packet duration, default: 40.
  --input-field <name> Send audio through "audio" or "media", default: audio.
  --dry-run            Validate config and local dependencies without calling Google.
  --keep-temp          Keep generated temp PCM files.
`);
}

function parseArgs(argv) {
  const args = {
    envFile: DEFAULT_ENV_FILE,
    out: path.join(process.cwd(), 'tmp', 'gemini-live-reply.wav'),
    timeoutMs: 45_000,
    tailTimeoutMs: 1800,
    chunkMs: 40,
    seconds: 8,
    micDevice: ':0',
    inputField: 'audio',
    keepTemp: false,
    dryRun: false,
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
    else if (arg === '--mic') args.mic = true;
    else if (arg === '--audio') args.audio = next();
    else if (arg === '--pcm') args.pcm = next();
    else if (arg === '--seconds') args.seconds = Number(next());
    else if (arg === '--mic-device') args.micDevice = next();
    else if (arg === '--list-devices') args.listDevices = true;
    else if (arg === '--tool-demo') args.toolDemo = true;
    else if (arg === '--audio-response') args.response = 'audio';
    else if (arg === '--text-response') args.response = 'text';
    else if (arg === '--play') args.play = true;
    else if (arg === '--no-play') args.play = false;
    else if (arg === '--out') args.out = next();
    else if (arg === '--model') args.model = next();
    else if (arg === '--project') args.project = next();
    else if (arg === '--location') args.location = next();
    else if (arg === '--credentials') args.credentials = next();
    else if (arg === '--env') args.envFile = next();
    else if (arg === '--timeout-ms') args.timeoutMs = Number(next());
    else if (arg === '--tail-timeout-ms') args.tailTimeoutMs = Number(next());
    else if (arg === '--chunk-ms') args.chunkMs = Number(next());
    else if (arg === '--input-field') args.inputField = next();
    else if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--keep-temp') args.keepTemp = true;
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

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Put it in ${DEFAULT_ENV_FILE} or export it.`);
  return value;
}

function ensureFinitePositiveNumber(name, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
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

function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `${label} failed: ${command} ${args.join(' ')}\n${result.stderr || result.stdout || ''}`.trim(),
    );
  }
  return result;
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

function convertAudioToPcm(inputPath, tempDir) {
  if (!commandExists('ffmpeg')) throw new Error('--audio requires ffmpeg');
  if (!existsSync(inputPath)) throw new Error(`Input audio not found: ${inputPath}`);
  const outputPath = path.join(tempDir, 'input-16k-mono.pcm');
  run(
    'ffmpeg',
    ['-y', '-i', inputPath, '-ac', '1', '-ar', String(INPUT_SAMPLE_RATE), '-f', 's16le', outputPath],
    'ffmpeg audio conversion',
  );
  return outputPath;
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

function writeWavFile(filePath, pcmBuffers, sampleRate) {
  const dataBytes = pcmBuffers.reduce((sum, chunk) => sum + chunk.length, 0);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, Buffer.concat([writeWavHeader(dataBytes, sampleRate), ...pcmBuffers]));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNativeAudioModel(model) {
  return /native-audio/.test(model || '');
}

function makeAudioPayload(pcmChunk) {
  return {
    data: pcmChunk.toString('base64'),
    mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}`,
  };
}

function sendAudioChunk(session, pcmChunk, inputField) {
  const payload = makeAudioPayload(pcmChunk);
  if (inputField === 'media') {
    session.sendRealtimeInput({ media: payload });
  } else {
    session.sendRealtimeInput({ audio: payload });
  }
}

async function sendPcmFile(session, filePath, args) {
  if (!existsSync(filePath)) throw new Error(`PCM input not found: ${filePath}`);
  const buffer = readFileSync(filePath);
  const chunkBytes = Math.max(2, Math.floor((INPUT_SAMPLE_RATE * 2 * args.chunkMs) / 1000));
  let chunksSent = 0;
  for (let offset = 0; offset < buffer.length; offset += chunkBytes) {
    const chunk = buffer.subarray(offset, Math.min(offset + chunkBytes, buffer.length));
    sendAudioChunk(session, chunk, args.inputField);
    chunksSent += 1;
    await sleep(args.chunkMs);
  }
  session.sendRealtimeInput({ audioStreamEnd: true });
  console.log(`Audio upload complete: ${chunksSent} chunks, ${(buffer.length / 2 / INPUT_SAMPLE_RATE).toFixed(2)}s.`);
}

async function streamMicrophone(session, args) {
  if (!commandExists('ffmpeg')) throw new Error('--mic requires ffmpeg');
  const chunkBytes = Math.max(2, Math.floor((INPUT_SAMPLE_RATE * 2 * args.chunkMs) / 1000));
  let pending = Buffer.alloc(0);
  let chunksSent = 0;
  let bytesSent = 0;

  const ffmpeg = spawn(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'avfoundation',
      '-i',
      args.micDevice,
      '-ac',
      '1',
      '-ar',
      String(INPUT_SAMPLE_RATE),
      '-f',
      's16le',
      'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  ffmpeg.stderr.on('data', (data) => {
    const text = String(data).trim();
    if (text) console.warn(`[ffmpeg] ${text}`);
  });

  ffmpeg.stdout.on('data', (data) => {
    pending = Buffer.concat([pending, data]);
    while (pending.length >= chunkBytes) {
      const chunk = pending.subarray(0, chunkBytes);
      pending = pending.subarray(chunkBytes);
      sendAudioChunk(session, chunk, args.inputField);
      chunksSent += 1;
      bytesSent += chunk.length;
    }
  });

  console.log(`Speak now... capturing ${args.seconds}s from ffmpeg avfoundation device ${args.micDevice}`);
  await sleep(args.seconds * 1000);

  if (ffmpeg.exitCode === null) ffmpeg.kill('SIGTERM');
  if (pending.length > 0) {
    sendAudioChunk(session, pending, args.inputField);
    chunksSent += 1;
    bytesSent += pending.length;
  }
  session.sendRealtimeInput({ audioStreamEnd: true });
  console.log(`Mic upload complete: ${chunksSent} chunks, ${(bytesSent / 2 / INPUT_SAMPLE_RATE).toFixed(2)}s.`);
}

function startPlayback() {
  if (!commandExists('ffplay')) {
    console.warn('ffplay not found; live playback disabled. The WAV file will still be saved.');
    return null;
  }

  const player = spawn(
    'ffplay',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nodisp',
      '-autoexit',
      '-f',
      's16le',
      '-ar',
      String(OUTPUT_SAMPLE_RATE),
      '-ch_layout',
      'mono',
      '-i',
      'pipe:0',
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );

  player.stderr.on('data', (data) => {
    const text = String(data).trim();
    if (text) console.warn(`[ffplay] ${text}`);
  });
  return player;
}

function closePlayback(player) {
  if (!player) return;
  try {
    player.stdin.end();
  } catch {
    // best effort
  }
}

function getToolDeclarations() {
  return [
    {
      name: 'get_current_time',
      description: 'Get the current local time for a city or timezone.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          city: {
            type: Type.STRING,
            description: 'City name, for example Beijing or San Francisco.',
          },
        },
        required: ['city'],
      },
    },
    {
      name: 'get_weather',
      description: 'Get a mock current weather report for latency and function-calling tests.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          city: {
            type: Type.STRING,
            description: 'City name.',
          },
        },
        required: ['city'],
      },
    },
    {
      name: 'lookup_order_status',
      description: 'Look up a mock order status by order id.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          order_id: {
            type: Type.STRING,
            description: 'Order id, for example A10086.',
          },
        },
        required: ['order_id'],
      },
    },
  ];
}

function runDemoTool(name, args) {
  const now = new Date();
  if (name === 'get_current_time') {
    return {
      city: args.city || 'unknown',
      iso_time: now.toISOString(),
      local_time: new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        dateStyle: 'medium',
        timeStyle: 'medium',
      }).format(now),
      timezone: 'Asia/Shanghai',
    };
  }
  if (name === 'get_weather') {
    return {
      city: args.city || 'unknown',
      source: 'local mock tool',
      condition: 'clear',
      temperature_c: 23,
      note: 'This is a deterministic mock response for testing Gemini Live function calling.',
    };
  }
  if (name === 'lookup_order_status') {
    return {
      order_id: args.order_id || 'unknown',
      status: 'in_transit',
      eta: 'tomorrow afternoon',
      source: 'local mock tool',
    };
  }
  return {
    error: `Unknown demo tool: ${name}`,
  };
}

function extractAudioParts(message) {
  const parts = message.serverContent?.modelTurn?.parts || [];
  const chunks = [];
  for (const part of parts) {
    const inlineData = part.inlineData;
    if (inlineData?.data && inlineData?.mimeType?.startsWith('audio/')) {
      chunks.push(Buffer.from(inlineData.data, 'base64'));
    }
  }

  return chunks;
}

function extractTextParts(message) {
  const texts = [];
  const parts = message.serverContent?.modelTurn?.parts || [];
  for (const part of parts) {
    if (part.text) texts.push(part.text);
  }
  return texts;
}

function createLiveHarness(args, responseMode) {
  const audioChunks = [];
  const textChunks = [];
  let session = null;
  let player = null;
  let done = false;
  let gotAudio = false;
  let gotText = false;
  let handledToolCalls = 0;
  let lastActivityAt = Date.now();
  let pendingFinishReason = null;

  const markActivity = () => {
    lastActivityAt = Date.now();
  };

  const finish = (reason) => {
    if (done) return;
    done = true;
    pendingFinishReason = reason;
    closePlayback(player);
  };

  const waitForDone = async () => {
    const startedAt = Date.now();
    while (!done) {
      await sleep(100);
      const elapsed = Date.now() - startedAt;
      const idleMs = Date.now() - lastActivityAt;
      if (elapsed > args.timeoutMs) finish(`timeout after ${args.timeoutMs}ms`);
      if (responseMode === 'audio' && gotAudio && idleMs > args.tailTimeoutMs) {
        finish(`audio tail idle ${args.tailTimeoutMs}ms`);
      }
      if (responseMode === 'text' && gotText && idleMs > 700) {
        finish('text response idle');
      }
    }
    return pendingFinishReason;
  };

  const callbacks = {
    onopen: () => {
      console.log('Connected to Gemini Live.');
      if (args.play) player = startPlayback();
    },
    onmessage: (message) => {
      markActivity();

      if (message.setupComplete) {
        const sessionId = message.setupComplete.sessionId || '(no session id returned)';
        console.log(`[SetupComplete] session=${sessionId}`);
      }

      if (message.serverContent?.inputTranscription?.text) {
        console.log(`[InputTranscript] ${message.serverContent.inputTranscription.text}`);
      }
      if (message.serverContent?.outputTranscription?.text) {
        console.log(`[OutputTranscript] ${message.serverContent.outputTranscription.text}`);
      }

      const texts = extractTextParts(message);
      for (const text of texts) {
        gotText = true;
        textChunks.push(text);
        console.log(`[Text] ${text}`);
      }

      const chunks = extractAudioParts(message);
      for (const chunk of chunks) {
        gotAudio = true;
        audioChunks.push(chunk);
        if (player?.stdin?.writable) player.stdin.write(chunk);
        console.log(`[Audio] ${chunk.length} bytes`);
      }

      const calls = message.toolCall?.functionCalls || [];
      if (calls.length > 0) {
        handledToolCalls += calls.length;
        console.log(`[ToolCall] ${calls.length} call(s)`);
        const functionResponses = calls.map((call) => {
          const name = call.name || 'unknown';
          const callArgs = call.args || {};
          console.log(`  -> ${name}(${JSON.stringify(callArgs)}) id=${call.id || '(none)'}`);
          return {
            id: call.id,
            name,
            scheduling: 'INTERRUPT',
            response: {
              output: runDemoTool(name, callArgs),
            },
          };
        });
        if (!session) {
          console.warn('Tool call arrived before session assignment; cannot send tool response.');
        } else {
          session.sendToolResponse({ functionResponses });
          console.log(`[ToolResponse] sent ${functionResponses.length} response(s)`);
        }
      }

      if (message.toolCallCancellation?.ids?.length) {
        console.log(`[ToolCallCancellation] ${message.toolCallCancellation.ids.join(', ')}`);
      }
      if (message.serverContent?.generationComplete) {
        console.log('[GenerationComplete]');
      }
      if (message.serverContent?.turnComplete) {
        console.log('[TurnComplete]');
        if (responseMode === 'text' && (gotText || handledToolCalls === 0)) {
          finish('turn complete');
        }
        if (responseMode === 'audio' && !gotAudio && handledToolCalls === 0) {
          finish('turn complete');
        }
      }
      if (message.serverContent?.interrupted) {
        console.log('[Interrupted]');
      }
      if (message.goAway?.timeLeft) {
        console.log(`[GoAway] timeLeft=${message.goAway.timeLeft}`);
      }
      if (message.usageMetadata) {
        console.log(`[Usage] ${JSON.stringify(message.usageMetadata)}`);
      }
    },
    onerror: (error) => {
      console.error('[LiveError]', error?.message || error);
      finish('error');
    },
    onclose: (event) => {
      console.log(`[Closed] code=${event?.code ?? 'unknown'} reason=${event?.reason || ''}`);
      finish('closed');
    },
  };

  return {
    callbacks,
    setSession(value) {
      session = value;
    },
    waitForDone,
    audioChunks,
    textChunks,
  };
}

function makeConfig(args, responseMode) {
  const systemInstruction =
    process.env.GEMINI_LIVE_SYSTEM_INSTRUCTION ||
    'You are a concise, natural realtime voice assistant. Reply in the user language.';

  const config = {
    responseModalities: [responseMode === 'audio' ? Modality.AUDIO : Modality.TEXT],
    systemInstruction: {
      role: 'system',
      parts: [{ text: systemInstruction }],
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };

  if (args.toolDemo) {
    config.tools = [{ functionDeclarations: getToolDeclarations() }];
  }

  return config;
}

function validateArgs(args) {
  ensureFinitePositiveNumber('--timeout-ms', args.timeoutMs);
  ensureFinitePositiveNumber('--tail-timeout-ms', args.tailTimeoutMs);
  ensureFinitePositiveNumber('--chunk-ms', args.chunkMs);
  ensureFinitePositiveNumber('--seconds', args.seconds);

  if (!['audio', 'media'].includes(args.inputField)) {
    throw new Error('--input-field must be "audio" or "media"');
  }

  const inputModes = [args.text, args.mic, args.audio, args.pcm].filter(Boolean).length;
  if (args.listDevices) return;
  if (inputModes === 0) {
    if (args.toolDemo) {
      args.text = '请调用工具查询北京现在几点，然后用一句中文告诉我结果。';
    } else {
      args.text = '你好，用中文简短介绍一下你自己。';
    }
  }
  if (inputModes > 1) throw new Error('Use only one input mode: --text, --mic, --audio, or --pcm');

  const configuredModel = args.model || process.env.GEMINI_LIVE_MODEL || DEFAULT_MODEL;
  if (args.mic || args.audio || args.pcm || isNativeAudioModel(configuredModel)) {
    args.response ||= 'audio';
  } else {
    args.response ||= 'text';
  }

  if (args.play === undefined) {
    args.play = args.response === 'audio' && (args.mic || args.audio || args.pcm);
  }
}

function getConfig(args) {
  if (args.credentials) process.env.GOOGLE_APPLICATION_CREDENTIALS = args.credentials;
  if (args.project) process.env.GOOGLE_CLOUD_PROJECT = args.project;
  if (args.location) process.env.GOOGLE_CLOUD_LOCATION = args.location;
  process.env.GOOGLE_GENAI_USE_VERTEXAI ||= 'true';

  const credentialsPath = requiredEnv('GOOGLE_APPLICATION_CREDENTIALS');
  if (!existsSync(credentialsPath)) {
    throw new Error(`GOOGLE_APPLICATION_CREDENTIALS does not exist: ${credentialsPath}`);
  }

  return {
    credentialsPath,
    project: requiredEnv('GOOGLE_CLOUD_PROJECT'),
    model: args.model || process.env.GEMINI_LIVE_MODEL || DEFAULT_MODEL,
    location:
      process.env.GOOGLE_CLOUD_LOCATION ||
      (isNativeAudioModel(args.model || process.env.GEMINI_LIVE_MODEL || DEFAULT_MODEL)
        ? 'us-central1'
        : 'global'),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  loadEnvFile(args.envFile);
  validateArgs(args);

  if (args.listDevices) {
    listDevices();
    return;
  }

  const config = getConfig(args);
  const responseMode = args.response;

  console.log(`Project: ${config.project}`);
  console.log(`Location: ${config.location}`);
  console.log(`Model: ${config.model}`);
  console.log(`Response: ${responseMode}`);
  console.log(`Tool demo: ${args.toolDemo ? 'enabled' : 'disabled'}`);
  console.log(`Credentials: ${config.credentialsPath}`);

  if (args.dryRun) {
    if ((args.mic || args.audio) && !commandExists('ffmpeg')) {
      throw new Error('ffmpeg is required for --mic or --audio');
    }
    if (args.play && !commandExists('ffplay')) {
      console.warn('ffplay not found; playback will be disabled at runtime.');
    }
    console.log('Dry run OK.');
    return;
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), 'gemini-live-'));
  try {
    const harness = createLiveHarness(args, responseMode);
    const client = new GoogleGenAI({
      vertexai: true,
      project: config.project,
      location: config.location,
    });
    const session = await client.live.connect({
      model: config.model,
      config: makeConfig(args, responseMode),
      callbacks: harness.callbacks,
    });
    harness.setSession(session);

    if (args.text) {
      console.log(`[UserText] ${args.text}`);
      session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text: args.text }] }],
        turnComplete: true,
      });
    } else if (args.mic) {
      await streamMicrophone(session, args);
    } else {
      const pcmPath = args.pcm || convertAudioToPcm(args.audio, tempDir);
      await sendPcmFile(session, pcmPath, args);
    }

    const reason = await harness.waitForDone();
    session.close();

    if (harness.audioChunks.length > 0) {
      writeWavFile(args.out, harness.audioChunks, OUTPUT_SAMPLE_RATE);
      console.log(`Saved reply audio: ${args.out}`);
    }
    if (harness.textChunks.length > 0) {
      console.log(`Final text: ${harness.textChunks.join('')}`);
    }
    console.log(`Stopped: ${reason}`);
  } finally {
    if (!args.keepTemp) rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
});
