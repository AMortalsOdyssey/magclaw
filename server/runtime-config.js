// Runtime and external API configuration normalizers.
// Keep environment/input cleanup here so state migration, settings endpoints,
// and runtime startup all interpret config values the same way.

const VALID_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
export const DEFAULT_FANOUT_API_BASE_URL = 'https://model-api.skyengine.com.cn/v1';
export const DEFAULT_FANOUT_API_MODEL = 'qwen3.5-flash';
export const DEFAULT_FANOUT_API_FALLBACK_MODEL = 'deepseek-v4-flash';
export const DEFAULT_FANOUT_API_TIMEOUT_MS = 5_000;

export function normalizeCloudUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw.replace(/\/+$/, '');
}

export function normalizeReasoningEffort(value, fallback = null) {
  const effort = String(value || '').trim().toLowerCase();
  if (VALID_REASONING_EFFORTS.has(effort)) return effort;
  const fallbackEffort = String(fallback || '').trim().toLowerCase();
  return VALID_REASONING_EFFORTS.has(fallbackEffort) ? fallbackEffort : null;
}

export function normalizeFanoutForceKeywords(value = []) {
  const rawItems = Array.isArray(value)
    ? value
    : String(value || '').split(/[\n,，;；]+/);
  const seen = new Set();
  const keywords = [];
  for (const item of rawItems) {
    const keyword = String(item || '').trim().slice(0, 80);
    if (!keyword) continue;
    const key = keyword.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    keywords.push(keyword);
    if (keywords.length >= 50) break;
  }
  return keywords;
}

export function normalizeFanoutApiConfig(config = {}, defaultTimeoutMs = DEFAULT_FANOUT_API_TIMEOUT_MS) {
  const fallbackTimeout = Number.isFinite(Number(defaultTimeoutMs)) ? Number(defaultTimeoutMs) : DEFAULT_FANOUT_API_TIMEOUT_MS;
  const timeoutMs = Number(config.timeoutMs || fallbackTimeout);
  const model = String(config.model || '').trim();
  return {
    enabled: Boolean(config.enabled),
    baseUrl: normalizeCloudUrl(config.baseUrl || ''),
    apiKey: String(config.apiKey || ''),
    model,
    fallbackModel: String(config.fallbackModel || '').trim(),
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(500, Math.min(30_000, timeoutMs)) : fallbackTimeout,
    forceKeywords: normalizeFanoutForceKeywords(config.forceKeywords),
  };
}

export function fanoutApiConfigReady(config = {}, defaultTimeoutMs = DEFAULT_FANOUT_API_TIMEOUT_MS) {
  const normalized = normalizeFanoutApiConfig(config || {}, defaultTimeoutMs);
  return Boolean(normalized.enabled && normalized.baseUrl && normalized.apiKey && normalized.model);
}

export function publicApiKeyPreview(value) {
  const key = String(value || '');
  if (!key) return '';
  return `${key.slice(0, Math.min(6, key.length))}${key.length > 6 ? '****' : ''}`;
}

export function normalizeChatRuntimeConfig(config = {}) {
  return {
    enabled: config.enabled !== false,
    model: String(config.model || '').trim(),
    reasoningEffort: normalizeReasoningEffort(config.reasoningEffort, 'low') || 'low',
  };
}

export function normalizeCodexModelName(model, fallback = '', fallbackModel = 'gpt-5.5') {
  const value = String(model || '').trim();
  if (value && value.toLowerCase() !== 'default') return value;
  const fallbackValue = String(fallback || process.env.CODEX_MODEL || '').trim();
  if (fallbackValue && fallbackValue.toLowerCase() !== 'default') return fallbackValue;
  return fallbackModel;
}
