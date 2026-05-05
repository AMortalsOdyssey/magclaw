import {
  normalizeChatRuntimeConfig,
  normalizeReasoningEffort,
} from './runtime-config.js';

// Small, testable helpers for Codex runtime selection and stream retry handling.
// Process lifecycle, app-server JSON-RPC, and message delivery still live in
// index.js; this module stays pure so it can be safely reused and unit tested.

export function codexStreamRetryLimit(value = process.env.MAGCLAW_CODEX_STREAM_RETRY_LIMIT, fallback = 6) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, parsed) : fallback;
}

export function parseCodexStreamRetry(text) {
  const matches = [...String(text || '').matchAll(/stream disconnected - retrying sampling request \((\d+)\/(\d+)/gi)];
  if (!matches.length) return null;
  const parsed = matches
    .map((match) => ({ count: Number(match[1]), total: Number(match[2]) }))
    .filter((item) => Number.isFinite(item.count) && Number.isFinite(item.total))
    .sort((a, b) => b.count - a.count);
  return parsed[0] || null;
}

export function shouldUseChatFastRuntime(message, workItem = null, chatRuntimeConfig = {}, intents = {}) {
  const config = normalizeChatRuntimeConfig(chatRuntimeConfig || {});
  if (!config.enabled) return false;
  if (!message || message.authorType !== 'human') return false;
  if (message.taskId || workItem?.taskId) return false;
  const text = String(message.body || '').trim();
  if (!text) return false;
  if (intents.taskCreationIntent?.(text) || intents.autoTaskMessageIntent?.(text)) return false;
  return true;
}

export function codexRuntimeOverrideForDelivery(message, workItem = null, chatRuntimeConfig = {}, intents = {}) {
  if (!shouldUseChatFastRuntime(message, workItem, chatRuntimeConfig, intents)) return null;
  const config = normalizeChatRuntimeConfig(chatRuntimeConfig || {});
  return {
    reason: 'chat_fast_path',
    model: config.model || '',
    reasoningEffort: config.reasoningEffort || 'low',
  };
}

export function codexRuntimeOverrideForMessages(messages = []) {
  const promptMessages = (Array.isArray(messages) ? messages : [messages]).filter(Boolean);
  if (!promptMessages.length) return null;
  const overrides = promptMessages.map((message) => message.runtimeOverride || null);
  if (overrides.some((override) => !override)) return null;
  const first = overrides[0];
  if (!overrides.every((override) => override.reason === first.reason
    && String(override.model || '') === String(first.model || '')
    && String(override.reasoningEffort || '') === String(first.reasoningEffort || ''))) {
    return null;
  }
  return {
    reason: first.reason || null,
    model: String(first.model || '').trim(),
    reasoningEffort: normalizeReasoningEffort(first.reasoningEffort),
  };
}

export function resolveCodexRuntime(agent, messages = [], { settingsModel = '', normalizeModelName } = {}) {
  const override = codexRuntimeOverrideForMessages(messages);
  const modelResolver = typeof normalizeModelName === 'function'
    ? normalizeModelName
    : (model, fallback) => model || fallback || '';
  const model = modelResolver(override?.model || agent?.model, settingsModel);
  const reasoningEffort = normalizeReasoningEffort(override?.reasoningEffort, agent?.reasoningEffort);
  return {
    model,
    reasoningEffort,
    overrideReason: override?.reason || null,
    fastChat: override?.reason === 'chat_fast_path',
  };
}

export function codexThreadConfig(runtime = {}) {
  return runtime.reasoningEffort
    ? { model_reasoning_effort: runtime.reasoningEffort }
    : null;
}
