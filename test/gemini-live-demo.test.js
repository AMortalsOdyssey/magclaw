import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  calculateGeminiLiveMicGateFrame,
  createGeminiSession,
  decideGeminiLiveEndpoint,
  handleGeminiLiveDemoHttp,
  normalizeChineseDisplayText,
  resolveGeminiLiveDemoConfig,
  resolveCredentialsPath,
  shouldBlockDemoToolCall,
} from '../server/gemini-live-demo.js';

function makeResponse() {
  return {
    statusCode: null,
    headers: {},
    body: '',
    writeHead(statusCode, headers = {}) {
      this.statusCode = statusCode;
      for (const [name, value] of Object.entries(headers)) {
        this.headers[String(name).toLowerCase()] = value;
      }
    },
    end(body = '') {
      this.body = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
    },
  };
}

function withEnv(patch, fn) {
  const previous = new Map(Object.keys(patch).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [key, value] of previous.entries()) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

test('Gemini Live demo page uses mounted Vertex secret without sandboxing microphone access', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-gemini-live-'));
  try {
    const secretDir = path.join(tmp, 'vertex');
    await mkdir(secretDir);
    const credentialPath = path.join(secretDir, 'vertex.json');
    await writeFile(credentialPath, JSON.stringify({
      type: 'service_account',
      project_id: 'demo-project',
      private_key_id: 'demo',
      private_key: '-----BEGIN PRIVATE KEY-----\\nignored\\n-----END PRIVATE KEY-----\\n',
      client_email: 'demo@example.iam.gserviceaccount.com',
      token_uri: 'https://oauth2.googleapis.com/token',
    }));

    await withEnv({
      GOOGLE_APPLICATION_CREDENTIALS: undefined,
      GOOGLE_CLOUD_PROJECT: undefined,
      MAGCLAW_VERTEX_SECRET_PATH: secretDir,
    }, async () => {
      assert.equal(resolveCredentialsPath(process.env), credentialPath);

      const res = makeResponse();
      const handled = await handleGeminiLiveDemoHttp(
        { method: 'GET', headers: { host: 'magclaw.example' } },
        res,
        new URL('https://magclaw.example/s/demo/gemini-live'),
        {
          cloudAuth: { isLoginRequired: () => false },
          host: '127.0.0.1',
          port: 6543,
        },
      );
      assert.equal(handled, true);
      assert.equal(res.statusCode, 200);
      assert.match(res.body, /id="voiceSelect"/);
      assert.match(res.body, /id="promptInput"/);
      assert.match(res.body, /id="turnProfileButtons"/);
      assert.match(res.body, /data-profile="responsive"/);
      assert.match(res.body, /data-profile="patient"/);
      assert.match(res.body, /audio_stream_end/);
      assert.match(res.body, /decideGeminiLiveEndpoint/);
      assert.match(res.body, /音频流/);
      assert.match(res.body, /提交给 Gemini/);
      assert.match(res.body, /本地过滤/);
      assert.match(res.body, /Gemini inputTranscription/);
      assert.match(res.body, /Gemini 暂无输入转写/);
      assert.match(res.body, /服务端确认/);
      assert.match(res.body, /responseDelayWarningMs/);
      assert.match(res.body, /response_delay_warning/);
      assert.match(res.body, /response_latency/);
      assert.match(res.body, /tool_summary/);
      assert.match(res.body, /TODO\(phase-2\): add multi-speaker diarization/);
      assert.match(res.body, /calculate_expression/);
      assert.match(res.body, /If a function response contains spoken_summary/);
      assert.match(res.body, /For create_demo_task, the first sentence must include the created task title and priority/);
      assert.match(res.body, /For short follow-ups that mention a new city or entity/);
      assert.match(res.body, /音频检测/);
      assert.equal(res.headers['permissions-policy'], 'microphone=(self)');
      assert.doesNotMatch(res.headers['content-security-policy'], /\bsandbox\b/);

      const status = makeResponse();
      assert.equal(await handleGeminiLiveDemoHttp(
        { method: 'GET', headers: { host: 'magclaw.example' } },
        status,
        new URL('https://magclaw.example/api/gemini-live/status'),
        {
          cloudAuth: { isLoginRequired: () => false },
          host: '127.0.0.1',
          port: 6543,
        },
      ), true);
      assert.equal(status.statusCode, 200);
      const payload = JSON.parse(status.body);
      assert.equal(payload.credentialsConfigured, true);
      assert.equal(payload.projectConfigured, true);
      assert.equal(payload.voices, 30);
      assert.equal(payload.tools, 9);
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('Gemini Live demo degrades to warning when Vertex secret is missing', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'magclaw-gemini-live-missing-'));
  try {
    const missingSecretDir = path.join(tmp, 'missing-vertex');
    const emptyEnv = path.join(tmp, 'empty.env');
    await writeFile(emptyEnv, '');

    await withEnv({
      GEMINI_LIVE_ENV_FILE: emptyEnv,
      GOOGLE_APPLICATION_CREDENTIALS: undefined,
      GEMINI_LIVE_GOOGLE_APPLICATION_CREDENTIALS: undefined,
      MAGCLAW_VERTEX_CREDENTIALS: undefined,
      MAGCLAW_VERTEX_CREDENTIALS_PATH: undefined,
      GOOGLE_CLOUD_PROJECT: undefined,
      MAGCLAW_VERTEX_SECRET_PATH: missingSecretDir,
    }, async () => {
      const res = makeResponse();
      assert.equal(await handleGeminiLiveDemoHttp(
        { method: 'GET', headers: { host: 'magclaw.example' } },
        res,
        new URL('https://magclaw.example/gemini-live'),
        {
          cloudAuth: { isLoginRequired: () => false },
          host: '127.0.0.1',
          port: 6543,
        },
      ), true);
      assert.equal(res.statusCode, 200);
      assert.match(res.body, /Gemini Live 凭证未配置/);
      assert.match(res.body, /credentialsConfigured":false/);

      const status = makeResponse();
      assert.equal(await handleGeminiLiveDemoHttp(
        { method: 'GET', headers: { host: 'magclaw.example' } },
        status,
        new URL('https://magclaw.example/api/gemini-live/status'),
        {
          cloudAuth: { isLoginRequired: () => false },
          host: '127.0.0.1',
          port: 6543,
        },
      ), true);
      assert.equal(status.statusCode, 200);
      const payload = JSON.parse(status.body);
      assert.equal(payload.credentialsConfigured, false);
      assert.equal(payload.projectConfigured, false);
      assert.equal(payload.warning, 'missing_vertex_credentials');

      assert.throws(
        () => resolveGeminiLiveDemoConfig({ host: '127.0.0.1', port: 6543 }),
        (error) => error.name === 'GeminiLiveConfigWarning'
          && error.code === 'missing_vertex_credentials',
      );

      await assert.rejects(
        createGeminiSession({ readyState: 0 }, {
          credentialsPath: missingSecretDir,
          credentialsConfigured: false,
          project: '',
          location: 'us-central1',
          model: 'gemini-live-2.5-flash-native-audio',
        }),
        (error) => error.name === 'GeminiLiveConfigWarning'
          && error.code === 'missing_vertex_credentials',
      );
    });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('Gemini Live demo blocks control-only utterances from calling tools', () => {
  const toolNames = [
    'get_weather',
    'google_search',
    'calculate_expression',
    'create_demo_task',
    'list_demo_tasks',
  ];

  for (const toolName of toolNames) {
    const guard = shouldBlockDemoToolCall(toolName, { title: '等一下', expression: '(128 + 256) * 0.8' }, '等一下。');
    assert.equal(guard.blocked, true);
    assert.equal(guard.reason, 'control_utterance_without_tool_intent');
  }

  const misheardStop = shouldBlockDemoToolCall('list_demo_tasks', {}, '让 一 下');
  assert.equal(misheardStop.blocked, true);
  assert.equal(misheardStop.reason, 'control_utterance_without_tool_intent');

  const noTaskIntent = shouldBlockDemoToolCall('calculate_expression', { expression: '(128 + 256) * 0.8' }, '让 一 下');
  assert.equal(noTaskIntent.blocked, true);

  assert.equal(
    shouldBlockDemoToolCall('create_demo_task', { title: '检查实时语音延迟' }, '').blocked,
    false,
  );
  assert.equal(
    shouldBlockDemoToolCall('create_demo_task', { title: '等一下' }, '').reason,
    'control_utterance_without_tool_intent',
  );

  assert.equal(
    shouldBlockDemoToolCall('get_weather', { city: '杭州' }, '帮我查一下杭州今天的天气').blocked,
    false,
  );
  assert.equal(
    shouldBlockDemoToolCall('calculate_expression', { expression: '37 * 24' }, '帮我算一下三十七乘以二十四').blocked,
    false,
  );
  assert.equal(
    shouldBlockDemoToolCall('create_demo_task', { title: '检查实时语音延迟' }, '帮我创建一个任务，标题是检查实时语音延迟').blocked,
    false,
  );
});

test('Gemini Live mic gate ignores short background noise but accepts sustained barge-in speech', () => {
  const tuning = {
    idleRms: 0.01,
    idlePeak: 0.045,
    bargeInRms: 0.042,
    bargeInPeak: 0.16,
    bargeInMs: 420,
    startFrames: 3,
  };
  const frameMs = 42;
  let micSpeechFrames = 0;

  for (let index = 0; index < 4; index += 1) {
    const gate = calculateGeminiLiveMicGateFrame({
      stats: { rms: 0.05, peak: 0.18 },
      tuning,
      frameMs,
      micSpeechFrames,
      assistantAudioPlaying: true,
      acceptedBargeIn: false,
    });
    micSpeechFrames = gate.nextSpeechFrames;
    assert.equal(gate.candidateBargeIn, true);
    assert.equal(gate.shouldDeferForBargeIn, true);
    assert.equal(gate.shouldAcceptBargeIn, false);
  }

  const resetAfterNoise = calculateGeminiLiveMicGateFrame({
    stats: { rms: 0.004, peak: 0.02 },
    tuning,
    frameMs,
    micSpeechFrames,
    assistantAudioPlaying: true,
    acceptedBargeIn: false,
  });
  assert.equal(resetAfterNoise.nextSpeechFrames, 0);
  assert.equal(resetAfterNoise.shouldAcceptBargeIn, false);

  micSpeechFrames = 0;
  let accepted = false;
  for (let index = 0; index < 10; index += 1) {
    const gate = calculateGeminiLiveMicGateFrame({
      stats: { rms: 0.05, peak: 0.18 },
      tuning,
      frameMs,
      micSpeechFrames,
      assistantAudioPlaying: true,
      acceptedBargeIn: false,
    });
    micSpeechFrames = gate.nextSpeechFrames;
    accepted = gate.shouldAcceptBargeIn;
  }
  assert.equal(accepted, true);

  const idleStart = calculateGeminiLiveMicGateFrame({
    stats: { rms: 0.02, peak: 0.06 },
    tuning,
    frameMs,
    micSpeechFrames: 2,
    assistantAudioPlaying: false,
    acceptedBargeIn: false,
  });
  assert.equal(idleStart.shouldStartUserSpeech, true);
  assert.equal(idleStart.requiredStartFrames, 3);
});

test('Gemini Live endpoint decision drops short noise before sending an empty turn', () => {
  const earlySilence = decideGeminiLiveEndpoint({
    transcript: '',
    speechDurationMs: 360,
    audioDurationMs: 360,
    silenceMs: 460,
    waitMs: 460,
    minNoTranscriptSpeechMs: 1000,
    noTranscriptGraceMs: 1400,
  });
  assert.equal(earlySilence.action, 'hold');
  assert.equal(earlySilence.reason, 'waiting_for_transcript');

  const noise = decideGeminiLiveEndpoint({
    transcript: '',
    speechDurationMs: 360,
    audioDurationMs: 360,
    silenceMs: 1500,
    waitMs: 460,
    minNoTranscriptSpeechMs: 1000,
    noTranscriptGraceMs: 1400,
  });
  assert.equal(noise.action, 'drop');
  assert.equal(noise.reason, 'short_audio_without_transcript');

  const realSpeech = decideGeminiLiveEndpoint({
    transcript: '帮我查一下杭州天气',
    speechDurationMs: 520,
    audioDurationMs: 520,
    silenceMs: 470,
    waitMs: 460,
    minNoTranscriptSpeechMs: 1000,
    noTranscriptGraceMs: 1400,
  });
  assert.equal(realSpeech.action, 'send');
  assert.equal(realSpeech.reason, 'speech_with_transcript');

  const fallbackSpeech = decideGeminiLiveEndpoint({
    transcript: '',
    speechDurationMs: 1600,
    audioDurationMs: 1600,
    silenceMs: 1500,
    waitMs: 460,
    minNoTranscriptSpeechMs: 1000,
    noTranscriptGraceMs: 1400,
  });
  assert.equal(fallbackSpeech.action, 'send');
  assert.equal(fallbackSpeech.reason, 'audio_without_transcript_fallback');

  const streamedBrowserSpeech = decideGeminiLiveEndpoint({
    transcript: '',
    speechDurationMs: 420,
    audioDurationMs: 47_000 / 32,
    silenceMs: 470,
    waitMs: 460,
    minNoTranscriptSpeechMs: 750,
    noTranscriptGraceMs: 1400,
  });
  assert.equal(streamedBrowserSpeech.action, 'send');
  assert.equal(streamedBrowserSpeech.reason, 'audio_without_transcript_fallback');
});

test('Gemini Live demo normalizes Chinese output transcript for display', () => {
  assert.equal(
    normalizeChineseDisplayText('好的, 已 經為您 創建 任务: "检查 实时 语音 延迟"。37 乘以 24 等於 888。'),
    '好的, 已经为您创建任务: "检查实时语音延迟"。37 乘以 24 等于 888。',
  );
});
