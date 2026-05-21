import { fanoutApiEndpoint, fanoutApiResponseText, parseFanoutApiJson } from './fanout-api.js';
import { normalizeCloudUrl } from './runtime-config.js';

export const DEFAULT_LLM_TIMEOUT_MS = 30_000;

export function llmConfigFromEnv(env = process.env) {
  const timeoutMs = Number(env.MAGCLAW_LLM_TIMEOUT_MS || DEFAULT_LLM_TIMEOUT_MS);
  return {
    baseUrl: normalizeCloudUrl(env.MAGCLAW_LLM_BASE_URL || env.MAGCLAW_LLM_URL || ''),
    apiKey: String(env.MAGCLAW_LLM_API_KEY || ''),
    model: String(env.MAGCLAW_LLM_MODEL || '').trim(),
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(1000, Math.min(120_000, timeoutMs)) : DEFAULT_LLM_TIMEOUT_MS,
  };
}

export function llmConfigReady(config = {}) {
  return Boolean(config.baseUrl && config.apiKey && config.model);
}

export async function requestLlmJson({ config = llmConfigFromEnv(), system = '', user = '', maxTokens = 2000 }) {
  if (!llmConfigReady(config)) throw new Error('Global LLM config is not fully configured.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs || DEFAULT_LLM_TIMEOUT_MS);
  try {
    const response = await fetch(fanoutApiEndpoint(config.baseUrl), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
      }),
    });
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(data?.error?.message || data?.message || response.statusText);
    return parseFanoutApiJson(fanoutApiResponseText(data));
  } finally {
    clearTimeout(timeout);
  }
}
