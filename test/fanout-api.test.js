import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fanoutApiEndpoint,
  fanoutApiResponseText,
  parseFanoutApiJson,
} from '../server/fanout-api.js';
import {
  DEFAULT_FANOUT_API_BASE_URL,
  DEFAULT_FANOUT_API_FALLBACK_MODEL,
  DEFAULT_FANOUT_API_MODEL,
  DEFAULT_FANOUT_API_TIMEOUT_MS,
  fanoutApiConfigReady,
  normalizeChatRuntimeConfig,
  normalizeCloudUrl,
  normalizeCodexModelName,
  normalizeFanoutApiConfig,
  normalizeFanoutForceKeywords,
  publicApiKeyPreview,
} from '../server/runtime-config.js';

test('runtime config helpers normalize fan-out and chat settings', () => {
  assert.equal(normalizeCloudUrl(' https://api.example.com/v1// '), 'https://api.example.com/v1');
  assert.deepEqual(normalizeFanoutApiConfig({
    enabled: true,
    baseUrl: 'https://api.example.com/v1/',
    apiKey: 'secret',
    model: ' router ',
    fallbackModel: ' fallback-router ',
    timeoutMs: 50_000,
    forceKeywords: ' /llm\n强制LLM，/LLM ',
  }, 2500), {
    enabled: true,
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'secret',
    model: 'router',
    fallbackModel: 'fallback-router',
    timeoutMs: 30_000,
    forceKeywords: ['/llm', '强制LLM'],
  });
  assert.deepEqual({
    baseUrl: DEFAULT_FANOUT_API_BASE_URL,
    model: DEFAULT_FANOUT_API_MODEL,
    fallbackModel: DEFAULT_FANOUT_API_FALLBACK_MODEL,
    timeoutMs: DEFAULT_FANOUT_API_TIMEOUT_MS,
  }, {
    baseUrl: 'https://model-api.skyengine.com.cn/v1',
    model: 'qwen3.5-flash',
    fallbackModel: 'deepseek-v4-flash',
    timeoutMs: 5000,
  });
  assert.deepEqual(normalizeFanoutForceKeywords(['  alpha  ', '', 'ALPHA', 'beta;gamma']), ['alpha', 'beta;gamma']);
  assert.equal(fanoutApiConfigReady({ enabled: true, baseUrl: 'x', apiKey: 'k', model: 'm' }), true);
  assert.equal(fanoutApiConfigReady({ enabled: true, baseUrl: 'x', apiKey: '', model: 'm' }), false);
  assert.equal(publicApiKeyPreview('sk-abcdef'), 'sk-abc****');
  assert.deepEqual(normalizeChatRuntimeConfig({ reasoningEffort: 'XHIGH', model: 'fast' }), {
    enabled: true,
    model: 'fast',
    reasoningEffort: 'xhigh',
  });
  assert.equal(normalizeCodexModelName('default', 'gpt-5.4-mini', 'gpt-5.5'), 'gpt-5.4-mini');
});

test('fan-out API helpers support OpenAI-compatible and responses shapes', () => {
  assert.equal(fanoutApiEndpoint('https://api.example.com/v1'), 'https://api.example.com/v1/chat/completions');
  assert.equal(fanoutApiEndpoint('https://api.example.com/v1/responses'), 'https://api.example.com/v1/responses');
  assert.equal(fanoutApiResponseText({ choices: [{ message: { content: '{"mode":"directed"}' } }] }), '{"mode":"directed"}');
  assert.equal(fanoutApiResponseText({ output_text: '{"mode":"broadcast"}' }), '{"mode":"broadcast"}');
  assert.deepEqual(parseFanoutApiJson('```json\n{"targetAgentIds":["agt_a"]}\n```'), { targetAgentIds: ['agt_a'] });
  assert.throws(() => parseFanoutApiJson(''), /empty response/);
});
