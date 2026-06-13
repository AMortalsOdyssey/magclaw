#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
import { gzipSync, gunzipSync } from 'node:zlib';
import WebSocket from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_ENV_FILE = path.join(__dirname, 'volcengine-realtime-dialog.env.local');
const DEFAULT_URL = 'wss://openspeech.bytedance.com/api/v3/realtime/dialogue';
const DEFAULT_RESOURCE_ID = 'volc.speech.dialog';

const CLIENT_FULL_REQUEST = 0b0001;
const CLIENT_AUDIO_ONLY_REQUEST = 0b0010;
const SERVER_FULL_RESPONSE = 0b1001;
const SERVER_ACK = 0b1011;
const SERVER_ERROR_RESPONSE = 0b1111;
const MSG_WITH_EVENT = 0b0100;
const JSON_SERIALIZATION = 0b0001;
const NO_SERIALIZATION = 0b0000;
const NO_COMPRESSION = 0b0000;
const GZIP_COMPRESSION = 0b0001;

const EVENT_NAMES = new Map([
  [1, 'StartConnection'],
  [2, 'FinishConnection'],
  [50, 'ConnectionStarted'],
  [52, 'ConnectionFinished'],
  [100, 'StartSession'],
  [102, 'FinishSession'],
  [150, 'SessionStarted'],
  [152, 'SessionFinished'],
  [153, 'SessionFailed'],
  [154, 'UsageResponse'],
  [200, 'TaskRequest'],
  [250, 'AudioMuted'],
  [350, 'TTSSentenceStart'],
  [351, 'TTSSentenceEnd'],
  [352, 'TTSResponse'],
  [359, 'TTSEnded'],
  [450, 'ASRInfo'],
  [451, 'ASRResponse'],
  [459, 'ASREnded'],
  [500, 'ChatTTSText'],
  [550, 'ChatResponse'],
  [559, 'ChatEnded'],
]);

function usage() {
  console.log(`Usage:
  node scripts/volcengine-realtime-dialog.mjs --audio input.wav --out reply.wav
  node scripts/volcengine-realtime-dialog.mjs --say "hello" --out reply.wav
  node scripts/volcengine-realtime-dialog.mjs --mic --seconds 8

Options:
  --audio <path>       WAV/MP3/etc input. Non-16k mono WAV is converted with ffmpeg/afconvert when available.
  --pcm <path>         Raw 16 kHz, mono, signed 16-bit little-endian PCM input.
  --say <text>         macOS only: synthesize a quick spoken prompt with say + afconvert.
  --mic                macOS + ffmpeg: capture microphone live and stream it while receiving/playing TTS.
  --mic-device <dev>   ffmpeg avfoundation input, default: :0. Use --list-devices to inspect.
  --seconds <n>        Microphone capture duration, default: 8.
  --list-devices       List macOS avfoundation audio devices and exit.
  --play               Play returned 24k PCM while receiving it.
  --no-play            Disable live playback in --mic mode.
  --out <path>         Output WAV for model speech, default: tmp/volcengine-realtime-reply.wav
  --env <path>         Env file, default: scripts/volcengine-realtime-dialog.env.local
  --timeout-ms <n>     Receive timeout after audio upload, default: 45000
  --tail-timeout-ms <n>Stop after this idle time once reply audio starts, default: 1800
  --chunk-ms <n>       Audio packet duration, default: 20
  --gzip              Gzip protocol payloads. Official examples use no compression; keep this off unless needed.
  --dry-run           Validate config and input audio without opening WebSocket.
  --keep-temp         Keep generated/converted input files.
`);
}

function parseArgs(argv) {
  const args = {
    envFile: DEFAULT_ENV_FILE,
    out: path.join(process.cwd(), 'tmp', 'volcengine-realtime-reply.wav'),
    timeoutMs: 45_000,
    tailTimeoutMs: 1800,
    chunkMs: 20,
    seconds: 8,
    micDevice: ':0',
    play: undefined,
    gzip: false,
    dryRun: false,
    keepTemp: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value) throw new Error(`Missing value for ${arg}`);
      return value;
    };

    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--audio') args.audio = next();
    else if (arg === '--pcm') args.pcm = next();
    else if (arg === '--say') args.say = next();
    else if (arg === '--mic') args.mic = true;
    else if (arg === '--mic-device') args.micDevice = next();
    else if (arg === '--seconds') args.seconds = Number(next());
    else if (arg === '--list-devices') args.listDevices = true;
    else if (arg === '--play') args.play = true;
    else if (arg === '--no-play') args.play = false;
    else if (arg === '--out') args.out = next();
    else if (arg === '--env') args.envFile = next();
    else if (arg === '--timeout-ms') args.timeoutMs = Number(next());
    else if (arg === '--tail-timeout-ms') args.tailTimeoutMs = Number(next());
    else if (arg === '--chunk-ms') args.chunkMs = Number(next());
    else if (arg === '--gzip') args.gzip = true;
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

function getConfig() {
  return {
    url: process.env.VOLCENGINE_REALTIME_URL || DEFAULT_URL,
    appId: requiredEnv('VOLCENGINE_REALTIME_APP_ID'),
    accessKey: requiredEnv('VOLCENGINE_REALTIME_ACCESS_KEY'),
    resourceId: process.env.VOLCENGINE_REALTIME_RESOURCE_ID || DEFAULT_RESOURCE_ID,
    appKey: requiredEnv('VOLCENGINE_REALTIME_APP_KEY'),
    botName: process.env.VOLCENGINE_REALTIME_BOT_NAME || 'Doubao',
    systemRole:
      process.env.VOLCENGINE_REALTIME_SYSTEM_ROLE ||
      'You are a natural, concise, friendly voice assistant.',
    speakingStyle:
      process.env.VOLCENGINE_REALTIME_SPEAKING_STYLE || 'Speak naturally and briefly.',
  };
}

function ensureFinitePositiveNumber(name, value) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
}

function run(command, args, label) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(
      `${label} failed: ${command} ${args.join(' ')}\n${result.stderr || result.stdout || ''}`.trim(),
    );
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

function synthesizeWithSay(text, tempDir) {
  if (!commandExists('say')) throw new Error('--say requires macOS say');
  if (!commandExists('afconvert')) throw new Error('--say requires macOS afconvert');
  const aiffPath = path.join(tempDir, 'prompt.aiff');
  const wavPath = path.join(tempDir, 'prompt-16k.wav');
  run('say', ['-o', aiffPath, text], 'say');
  run('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', aiffPath, wavPath], 'afconvert');
  return wavPath;
}

function convertTo16kMonoWav(inputPath, tempDir) {
  const outputPath = path.join(tempDir, 'input-16k.wav');
  if (commandExists('ffmpeg')) {
    run(
      'ffmpeg',
      [
        '-y',
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        inputPath,
        '-ac',
        '1',
        '-ar',
        '16000',
        '-sample_fmt',
        's16',
        outputPath,
      ],
      'ffmpeg',
    );
    return outputPath;
  }
  if (commandExists('afconvert')) {
    run('afconvert', ['-f', 'WAVE', '-d', 'LEI16@16000', inputPath, outputPath], 'afconvert');
    return outputPath;
  }
  throw new Error('Input is not 16k mono s16 WAV, and neither ffmpeg nor afconvert is available.');
}

function readPcmFromWav(filePath, tempDir) {
  let wavPath = filePath;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const buffer = readFileSync(wavPath);
    if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') {
      if (attempt === 0) {
        wavPath = convertTo16kMonoWav(filePath, tempDir);
        continue;
      }
      throw new Error(`${filePath} is not a WAV file`);
    }

    let offset = 12;
    let fmt = null;
    let data = null;
    while (offset + 8 <= buffer.length) {
      const id = buffer.toString('ascii', offset, offset + 4);
      const size = buffer.readUInt32LE(offset + 4);
      const start = offset + 8;
      const end = start + size;
      if (id === 'fmt ') {
        fmt = {
          audioFormat: buffer.readUInt16LE(start),
          channels: buffer.readUInt16LE(start + 2),
          sampleRate: buffer.readUInt32LE(start + 4),
          bitsPerSample: buffer.readUInt16LE(start + 14),
        };
      } else if (id === 'data') {
        data = buffer.subarray(start, end);
      }
      offset = end + (size % 2);
    }

    if (!fmt || !data) throw new Error(`${wavPath} is missing fmt/data chunks`);
    const valid =
      fmt.audioFormat === 1 &&
      fmt.channels === 1 &&
      fmt.sampleRate === 16000 &&
      fmt.bitsPerSample === 16;
    if (valid) return data;
    if (attempt === 0) {
      wavPath = convertTo16kMonoWav(filePath, tempDir);
      continue;
    }
    throw new Error(
      `Expected 16kHz mono signed 16-bit PCM WAV, got format=${fmt.audioFormat} channels=${fmt.channels} rate=${fmt.sampleRate} bits=${fmt.bitsPerSample}`,
    );
  }
  throw new Error(`Unable to read ${filePath}`);
}

function writeWav(filePath, pcm, sampleRate = 24000) {
  const header = wavHeader(pcm.length, sampleRate);
  writeFileSync(filePath, Buffer.concat([header, pcm]));
}

function wavHeader(pcmBytes, sampleRate = 24000) {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * 1 * 16 / 8;
  const blockAlign = 1 * 16 / 8;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmBytes, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcmBytes, 40);
  return header;
}

function makeHeader(messageType, flags, serialization, compression) {
  return Buffer.from([
    (0b0001 << 4) | 0b0001,
    (messageType << 4) | flags,
    (serialization << 4) | compression,
    0,
  ]);
}

function encodeEventMessage({
  event,
  payload,
  sessionId,
  messageType = CLIENT_FULL_REQUEST,
  serialization = JSON_SERIALIZATION,
  gzip = false,
}) {
  let payloadBuffer;
  if (Buffer.isBuffer(payload)) {
    payloadBuffer = payload;
  } else if (typeof payload === 'string') {
    payloadBuffer = Buffer.from(payload);
  } else {
    payloadBuffer = Buffer.from(JSON.stringify(payload ?? {}));
  }
  const compression = gzip ? GZIP_COMPRESSION : NO_COMPRESSION;
  if (gzip) payloadBuffer = gzipSync(payloadBuffer);

  const parts = [
    makeHeader(messageType, MSG_WITH_EVENT, serialization, compression),
    int32be(event),
  ];
  if (sessionId) {
    const sessionBuffer = Buffer.from(sessionId);
    parts.push(int32be(sessionBuffer.length), sessionBuffer);
  }
  parts.push(int32be(payloadBuffer.length), payloadBuffer);
  return Buffer.concat(parts);
}

function int32be(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function decodeServerMessage(data) {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (buffer.length < 4) return { messageType: 'unknown', payload: buffer };

  const headerSize = (buffer[0] & 0x0f) * 4;
  const messageType = buffer[1] >> 4;
  const flags = buffer[1] & 0x0f;
  const serialization = buffer[2] >> 4;
  const compression = buffer[2] & 0x0f;
  let offset = headerSize;
  const result = {
    messageType,
    flags,
    event: undefined,
    eventName: undefined,
    sessionId: undefined,
    payload: undefined,
    payloadSize: 0,
  };

  if (messageType === SERVER_FULL_RESPONSE || messageType === SERVER_ACK) {
    if (flags & MSG_WITH_EVENT) {
      result.event = buffer.readUInt32BE(offset);
      result.eventName = EVENT_NAMES.get(result.event) || `Event${result.event}`;
      offset += 4;
    }

    if (offset + 4 <= buffer.length) {
      const sessionSize = buffer.readUInt32BE(offset);
      offset += 4;
      if (sessionSize > 0 && offset + sessionSize <= buffer.length) {
        result.sessionId = buffer.toString('utf8', offset, offset + sessionSize);
        offset += sessionSize;
      }
    }

    if (offset + 4 <= buffer.length) {
      result.payloadSize = buffer.readUInt32BE(offset);
      offset += 4;
      let payload = buffer.subarray(offset, offset + result.payloadSize);
      if (compression === GZIP_COMPRESSION) payload = gunzipSync(payload);
      result.payload = parsePayload(payload, serialization);
    }
    return result;
  }

  if (messageType === SERVER_ERROR_RESPONSE) {
    result.eventName = 'Error';
    result.code = buffer.length >= offset + 4 ? buffer.readUInt32BE(offset) : undefined;
    offset += 4;
    result.payloadSize = buffer.length >= offset + 4 ? buffer.readUInt32BE(offset) : 0;
    offset += 4;
    let payload = buffer.subarray(offset, offset + result.payloadSize);
    if (compression === GZIP_COMPRESSION) payload = gunzipSync(payload);
    result.payload = parsePayload(payload, serialization);
    return result;
  }

  result.eventName = `MessageType${messageType}`;
  result.payload = buffer.subarray(offset);
  return result;
}

function parsePayload(payload, serialization) {
  if (serialization === JSON_SERIALIZATION) {
    const text = payload.toString('utf8');
    return text ? JSON.parse(text) : {};
  }
  if (serialization === NO_SERIALIZATION) return payload;
  return payload.toString('utf8');
}

function recv(ws, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for server event`));
    }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
      ws.off('close', onClose);
    }
    function onMessage(data) {
      cleanup();
      resolve(decodeServerMessage(data));
    }
    function onError(error) {
      cleanup();
      reject(error);
    }
    function onClose(code, reason) {
      cleanup();
      reject(new Error(`WebSocket closed: ${code} ${reason}`));
    }
    ws.once('message', onMessage);
    ws.once('error', onError);
    ws.once('close', onClose);
  });
}

function openWebSocket(config) {
  return new Promise((resolve, reject) => {
    const connectId = randomUUID();
    const ws = new WebSocket(config.url, {
      perMessageDeflate: false,
      handshakeTimeout: 15_000,
      headers: {
        'X-Api-App-ID': config.appId,
        'X-Api-Access-Key': config.accessKey,
        'X-Api-Resource-Id': config.resourceId,
        'X-Api-App-Key': config.appKey,
        'X-Api-Connect-Id': connectId,
      },
    });
    ws.once('open', () => resolve({ ws, connectId }));
    ws.once('error', reject);
  });
}

function buildStartSessionPayload(config, inputMode = 'audio_file') {
  return {
    tts: {
      audio_config: {
        channel: 1,
        format: 'pcm_s16le',
        sample_rate: 24000,
      },
    },
    dialog: {
      bot_name: config.botName,
      system_role: config.systemRole,
      speaking_style: config.speakingStyle,
      extra: {
        strict_audit: false,
        input_mod: inputMode,
      },
    },
  };
}

function listAvfoundationDevices() {
  if (!commandExists('ffmpeg')) throw new Error('ffmpeg is required to list devices.');
  const result = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''],
    { encoding: 'utf8' },
  );
  const output = result.stderr || result.stdout || '';
  console.log(output.trim());
}

function sendAudioEvent(ws, sessionId, chunk, args) {
  ws.send(
    encodeEventMessage({
      event: 200,
      sessionId,
      payload: chunk,
      messageType: CLIENT_AUDIO_ONLY_REQUEST,
      serialization: NO_SERIALIZATION,
      gzip: args.gzip,
    }),
  );
}

function startPlayback(enabled) {
  if (!enabled) return null;
  if (!commandExists('ffplay')) {
    console.log('ffplay is not available; live playback is disabled, but WAV output will still be saved.');
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
      '-',
    ],
    { stdio: ['pipe', 'ignore', 'pipe'] },
  );
  player.stdin.write(wavHeader(0xffffffff - 36, 24000));
  player.stderr.on('data', chunk => {
    const text = String(chunk).trim();
    if (text) console.log(`[ffplay] ${text}`);
  });
  return player;
}

async function receiveResponses(ws, args, audioParts, playback) {
  const stopEvents = new Set([152, 153, 351, 359, 559]);
  const startedAt = Date.now();
  let lastAudioAt = 0;
  let sawResponseEnd = false;
  while (Date.now() - startedAt < args.timeoutMs) {
    let message;
    const remainingMs = Math.max(1000, args.timeoutMs - (Date.now() - startedAt));
    const nextTimeoutMs = audioParts.length
      ? Math.min(remainingMs, Math.max(250, args.tailTimeoutMs))
      : remainingMs;
    try {
      message = await recv(ws, nextTimeoutMs);
    } catch (error) {
      if (audioParts.length && String(error.message || error).includes('Timed out')) {
        const idleMs = lastAudioAt ? Date.now() - lastAudioAt : args.tailTimeoutMs;
        console.log(`Reply audio idle for ${idleMs}ms; saving what was received.`);
        break;
      }
      throw error;
    }
    printEvent(message);
    if (message.event === 352 && Buffer.isBuffer(message.payload)) {
      audioParts.push(message.payload);
      lastAudioAt = Date.now();
      if (playback?.stdin?.writable) playback.stdin.write(message.payload);
    }
    if (stopEvents.has(message.event)) {
      sawResponseEnd = true;
      if (audioParts.length || message.event === 153 || message.event === 152) break;
    }
  }
  process.stdout.write('\n');
  return sawResponseEnd;
}

function saveReplyAudio(args, audioParts, sawResponseEnd) {
  if (audioParts.length) {
    const outputPath = path.resolve(args.out);
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeWav(outputPath, Buffer.concat(audioParts), 24000);
    console.log(`Saved reply audio: ${outputPath}`);
  } else {
    console.log('No TTS audio chunks were received.');
  }
  if (!sawResponseEnd) {
    console.log('Stopped after timeout before an explicit end event.');
  }
}

async function captureMicAndSend(ws, sessionId, args) {
  if (process.platform !== 'darwin') {
    throw new Error('--mic currently uses ffmpeg avfoundation and is supported on macOS only.');
  }
  if (!commandExists('ffmpeg')) throw new Error('--mic requires ffmpeg.');
  ensureFinitePositiveNumber('--seconds', args.seconds);
  const chunkBytes = Math.max(1, Math.round(16000 * 2 * (args.chunkMs / 1000)));
  const ffmpegArgs = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-f',
    'avfoundation',
    '-i',
    args.micDevice,
    '-t',
    String(args.seconds),
    '-ac',
    '1',
    '-ar',
    '16000',
    '-f',
    's16le',
    '-',
  ];
  const recorder = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  recorder.stderr.on('data', chunk => {
    stderr += String(chunk);
  });

  let pending = Buffer.alloc(0);
  let sentChunks = 0;
  for await (const chunk of recorder.stdout) {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= chunkBytes) {
      sendAudioEvent(ws, sessionId, pending.subarray(0, chunkBytes), args);
      sentChunks += 1;
      pending = pending.subarray(chunkBytes);
    }
  }
  if (pending.length) {
    sendAudioEvent(ws, sessionId, pending, args);
    sentChunks += 1;
  }

  const exitCode = await new Promise(resolve => {
    recorder.once('close', code => resolve(code));
  });
  if (exitCode !== 0) {
    throw new Error(
      `ffmpeg microphone capture failed for ${args.micDevice}. Try --list-devices and --mic-device :<index>.\n${stderr}`.trim(),
    );
  }
  console.log(`Mic capture complete: ${args.seconds}s, ${sentChunks} chunks sent.`);
}

async function runMicSession(args, config) {
  console.log(`Mic mode: device=${args.micDevice}, seconds=${args.seconds}, playback=${args.play !== false}`);
  console.log(`Endpoint: ${config.url}`);
  console.log(`Resource: ${config.resourceId}`);
  if (args.dryRun) {
    console.log('Dry run complete. WebSocket was not opened and microphone was not captured.');
    return;
  }

  let ws;
  const playback = startPlayback(args.play !== false);
  try {
    const { ws: openedWs, connectId } = await openWebSocket(config);
    ws = openedWs;
    console.log(`Connected: ${connectId}`);
    const sessionId = randomUUID();

    ws.send(encodeEventMessage({ event: 1, payload: {}, gzip: args.gzip }));
    printEvent(await recv(ws, args.timeoutMs));

    ws.send(
      encodeEventMessage({
        event: 100,
        sessionId,
        payload: buildStartSessionPayload(config, 'keep_alive'),
        gzip: args.gzip,
      }),
    );
    printEvent(await recv(ws, args.timeoutMs));

    const audioParts = [];
    const receivePromise = receiveResponses(ws, args, audioParts, playback);
    console.log('Speak now...');
    await captureMicAndSend(ws, sessionId, args);
    console.log('Mic upload complete; waiting for model response...');
    const sawResponseEnd = await receivePromise;

    const finish = encodeEventMessage({ event: 102, sessionId, payload: {}, gzip: args.gzip });
    if (ws.readyState === WebSocket.OPEN) ws.send(finish);
    saveReplyAudio(args, audioParts, sawResponseEnd);
  } finally {
    if (playback?.stdin?.writable) playback.stdin.end();
    if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
  }
}

function printEvent(message) {
  const label = message.eventName || `MessageType${message.messageType}`;
  if (message.event === 451 && message.payload?.results) {
    for (const result of message.payload.results) {
      console.log(`[ASR] ${result.is_interim ? 'interim' : 'final'}: ${result.text || ''}`);
    }
    return;
  }
  if (message.event === 550 && message.payload?.content) {
    process.stdout.write(message.payload.content);
    return;
  }
  if (message.event === 352 && Buffer.isBuffer(message.payload)) {
    console.log(`[${label}] audio ${message.payload.length} bytes`);
    return;
  }
  if (message.event === 154 && message.payload) {
    console.log(`[${label}] ${JSON.stringify(message.payload)}`);
    return;
  }
  if (message.messageType === SERVER_ERROR_RESPONSE || message.event === 153) {
    console.log(`[${label}] ${JSON.stringify(message.payload ?? {})}`);
    return;
  }
  console.log(`[${label}]`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  if (args.listDevices) {
    listAvfoundationDevices();
    return;
  }
  ensureFinitePositiveNumber('--timeout-ms', args.timeoutMs);
  ensureFinitePositiveNumber('--chunk-ms', args.chunkMs);
  ensureFinitePositiveNumber('--seconds', args.seconds);
  loadEnvFile(args.envFile);
  const config = getConfig();

  const inputCount = [args.audio, args.pcm, args.say, args.mic].filter(Boolean).length;
  if (inputCount !== 1) {
    throw new Error('Pass exactly one of --audio, --pcm, --say, or --mic.');
  }

  if (args.mic) {
    await runMicSession(args, config);
    return;
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), 'volcengine-realtime-'));
  try {
    let pcm;
    if (args.pcm) {
      pcm = readFileSync(args.pcm);
    } else {
      const audioPath = args.say ? synthesizeWithSay(args.say, tempDir) : args.audio;
      pcm = readPcmFromWav(audioPath, tempDir);
    }
    const chunkBytes = Math.max(1, Math.round(16000 * 2 * (args.chunkMs / 1000)));
    const chunks = [];
    for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
      chunks.push(pcm.subarray(offset, Math.min(offset + chunkBytes, pcm.length)));
    }

    console.log(
      `Input ready: ${(pcm.length / 32000).toFixed(2)}s, ${chunks.length} chunks, ${chunkBytes} bytes/chunk`,
    );
    console.log(`Endpoint: ${config.url}`);
    console.log(`Resource: ${config.resourceId}`);
    if (args.dryRun) {
      console.log('Dry run complete. WebSocket was not opened.');
      return;
    }

    let ws;
    try {
      const { ws: openedWs, connectId } = await openWebSocket(config);
      ws = openedWs;
      console.log(`Connected: ${connectId}`);
      const sessionId = randomUUID();

      ws.send(encodeEventMessage({ event: 1, payload: {}, gzip: args.gzip }));
      printEvent(await recv(ws, args.timeoutMs));

      ws.send(
        encodeEventMessage({
          event: 100,
          sessionId,
          payload: buildStartSessionPayload(config),
          gzip: args.gzip,
        }),
      );
      printEvent(await recv(ws, args.timeoutMs));

      for (const chunk of chunks) {
        ws.send(
          encodeEventMessage({
            event: 200,
            sessionId,
            payload: chunk,
            messageType: CLIENT_AUDIO_ONLY_REQUEST,
            serialization: NO_SERIALIZATION,
            gzip: args.gzip,
          }),
        );
        await new Promise(resolve => setTimeout(resolve, args.chunkMs));
      }
      console.log('Audio upload complete; waiting for model response...');

      const audioParts = [];
      const stopEvents = new Set([152, 153, 351, 359, 559]);
      const startedAt = Date.now();
      let sawResponseEnd = false;
      while (Date.now() - startedAt < args.timeoutMs) {
        let message;
        const remainingMs = Math.max(1000, args.timeoutMs - (Date.now() - startedAt));
        try {
          message = await recv(ws, remainingMs);
        } catch (error) {
          if (audioParts.length && String(error.message || error).includes('Timed out')) {
            console.log('Receive timed out after audio chunks; saving what was received.');
            break;
          }
          throw error;
        }
        printEvent(message);
        if (message.event === 352 && Buffer.isBuffer(message.payload)) {
          audioParts.push(message.payload);
        }
        if (stopEvents.has(message.event)) {
          sawResponseEnd = true;
          if (audioParts.length || message.event === 153 || message.event === 152) break;
        }
      }
      process.stdout.write('\n');

      const finish = encodeEventMessage({ event: 102, sessionId, payload: {}, gzip: args.gzip });
      if (ws.readyState === WebSocket.OPEN) ws.send(finish);
      ws.close();

      if (audioParts.length) {
        const outputPath = path.resolve(args.out);
        mkdirSync(path.dirname(outputPath), { recursive: true });
        writeWav(outputPath, Buffer.concat(audioParts), 24000);
        console.log(`Saved reply audio: ${outputPath}`);
      } else {
        console.log('No TTS audio chunks were received.');
      }
      if (!sawResponseEnd) {
        console.log('Stopped after timeout before an explicit end event.');
      }
    } finally {
      if (ws && ws.readyState !== WebSocket.CLOSED) ws.close();
    }
  } finally {
    if (!args.keepTemp) rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
