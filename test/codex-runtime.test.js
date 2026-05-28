import test from 'node:test';
import assert from 'node:assert/strict';
import {
  codexRuntimeOverrideForDelivery,
  codexRuntimeOverrideForMessages,
  codexStreamRetryLimit,
  codexThreadConfig,
  codexTurnInputForPrompt,
  parseCodexStreamRetry,
  resolveCodexRuntime,
} from '../server/codex-runtime.js';

test('codex runtime helpers parse retry warnings and retry limits', () => {
  assert.equal(codexStreamRetryLimit('0'), 1);
  assert.equal(codexStreamRetryLimit('4'), 4);
  assert.equal(codexStreamRetryLimit('bad'), 6);
  assert.equal(codexStreamRetryLimit('bad', 2), 2);
  assert.deepEqual(parseCodexStreamRetry('stream disconnected - retrying sampling request (1/5 in 20ms)...'), {
    count: 1,
    total: 5,
  });
  assert.deepEqual(parseCodexStreamRetry('(1/5) stream disconnected - retrying sampling request (3/5 in 20ms)...'), {
    count: 3,
    total: 5,
  });
  assert.equal(parseCodexStreamRetry('ordinary stderr'), null);
});

test('codex runtime helpers select fast chat overrides only for ordinary chat', () => {
  const intents = {
    taskCreationIntent: (text) => /task/.test(text),
    autoTaskMessageIntent: (text) => /fix/.test(text),
  };
  const config = { enabled: true, model: 'gpt-fast', reasoningEffort: 'low' };
  assert.deepEqual(codexRuntimeOverrideForDelivery({ authorType: 'human', body: 'hi' }, null, config, intents), {
    reason: 'chat_fast_path',
    model: 'gpt-fast',
    reasoningEffort: 'low',
  });
  assert.equal(codexRuntimeOverrideForDelivery({ authorType: 'human', body: 'fix this' }, null, config, intents), null);
  assert.equal(codexRuntimeOverrideForDelivery({ authorType: 'agent', body: 'hi' }, null, config, intents), null);
});

test('codex runtime helpers resolve consistent batched overrides', () => {
  const messages = [
    { runtimeOverride: { reason: 'chat_fast_path', model: 'gpt-fast', reasoningEffort: 'low' } },
    { runtimeOverride: { reason: 'chat_fast_path', model: 'gpt-fast', reasoningEffort: 'low' } },
  ];
  assert.deepEqual(codexRuntimeOverrideForMessages(messages), {
    reason: 'chat_fast_path',
    model: 'gpt-fast',
    reasoningEffort: 'low',
  });
  assert.equal(codexRuntimeOverrideForMessages([...messages, {}]), null);
  assert.deepEqual(resolveCodexRuntime({ model: 'gpt-agent', reasoningEffort: 'xhigh' }, messages, {
    settingsModel: 'gpt-default',
    normalizeModelName: (model) => model,
  }), {
    model: 'gpt-fast',
    reasoningEffort: 'low',
    overrideReason: 'chat_fast_path',
    fastChat: true,
  });
  assert.deepEqual(codexThreadConfig({ reasoningEffort: 'low' }), { model_reasoning_effort: 'low' });
});

test('codex turn input carries visible image attachments as local images', () => {
  const input = codexTurnInputForPrompt('Inspect the attached screenshot.', [{
    contextPack: {
      attachments: [
        { id: 'att_img', type: 'image/png', path: '/tmp/screen.png' },
        { id: 'att_file', type: 'text/plain', path: '/tmp/readme.txt' },
        { id: 'att_remote', type: 'image/webp', url: 'https://example.test/screen.webp' },
      ],
    },
  }]);

  assert.deepEqual(input, [
    { type: 'text', text: 'Inspect the attached screenshot.' },
    { type: 'localImage', path: '/tmp/screen.png' },
    { type: 'image', url: 'https://example.test/screen.webp' },
  ]);
});

test('codex turn input carries the target agent avatar as visual context', () => {
  const avatarDataUrl = `data:image/png;base64,${Buffer.from('avatar-png').toString('base64')}`;
  const input = codexTurnInputForPrompt('What is shown in my profile picture?', [{
    contextPack: {
      targetAgent: {
        id: 'agt_self',
        name: 'Self',
        avatar: {
          kind: 'data_url',
          type: 'image/png',
          dataUrl: avatarDataUrl,
          description: 'image/png data URL',
        },
      },
      attachments: [
        { id: 'att_clip', type: 'image/png', path: '/tmp/clipboard.png' },
      ],
    },
  }]);

  assert.deepEqual(input, [
    { type: 'text', text: 'What is shown in my profile picture?' },
    { type: 'localImage', path: '/tmp/clipboard.png' },
    { type: 'image', url: avatarDataUrl },
  ]);
});

test('codex turn input carries the target agent library avatar URL as visual context', () => {
  const input = codexTurnInputForPrompt('What is shown in my profile picture?', [{
    contextPack: {
      targetAgent: {
        id: 'agt_self',
        name: 'Self',
        avatar: {
          kind: 'path',
          type: 'image/svg+xml',
          url: 'http://127.0.0.1:6543/avatars/avatar_0001.svg',
          visualInput: true,
        },
      },
      attachments: [],
    },
  }]);

  assert.deepEqual(input, [
    { type: 'text', text: 'What is shown in my profile picture?' },
    { type: 'image', url: 'http://127.0.0.1:6543/avatars/avatar_0001.svg' },
  ]);
});
