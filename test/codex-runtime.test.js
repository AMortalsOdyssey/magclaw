import test from 'node:test';
import assert from 'node:assert/strict';
import {
  codexRuntimeOverrideForDelivery,
  codexRuntimeOverrideForMessages,
  codexStreamRetryLimit,
  codexThreadConfig,
  parseCodexStreamRetry,
  resolveCodexRuntime,
} from '../server/codex-runtime.js';

test('codex runtime helpers parse retry warnings and retry limits', () => {
  assert.equal(codexStreamRetryLimit('0'), 1);
  assert.equal(codexStreamRetryLimit('4'), 4);
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
