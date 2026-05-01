const VALID_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);

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

export function normalizeFanoutApiConfig(config = {}, defaultTimeoutMs = 2500) {
  const fallbackTimeout = Number.isFinite(Number(defaultTimeoutMs)) ? Number(defaultTimeoutMs) : 2500;
  const timeoutMs = Number(config.timeoutMs || fallbackTimeout);
  return {
    enabled: Boolean(config.enabled),
    baseUrl: normalizeCloudUrl(config.baseUrl || ''),
    apiKey: String(config.apiKey || ''),
    model: String(config.model || '').trim(),
    timeoutMs: Number.isFinite(timeoutMs) ? Math.max(500, Math.min(30_000, timeoutMs)) : fallbackTimeout,
  };
}

export function fanoutApiConfigReady(config = {}, defaultTimeoutMs = 2500) {
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
