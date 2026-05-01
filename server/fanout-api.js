import { normalizeCloudUrl } from './runtime-config.js';

export function fanoutApiEndpoint(baseUrl) {
  const base = normalizeCloudUrl(baseUrl || '');
  if (!base) return '';
  if (/\/(chat\/completions|responses)$/i.test(base)) return base;
  return `${base}/chat/completions`;
}

export function fanoutApiResponseText(data) {
  if (typeof data?.output_text === 'string') return data.output_text;
  const choice = data?.choices?.[0]?.message?.content;
  if (typeof choice === 'string') return choice;
  if (Array.isArray(choice)) {
    return choice.map((part) => part?.text || part?.content || '').join('');
  }
  if (Array.isArray(data?.output)) {
    return data.output
      .flatMap((item) => item?.content || [])
      .map((part) => part?.text || '')
      .join('');
  }
  return '';
}

export function parseFanoutApiJson(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Fan-out API returned an empty response.');
  try {
    return JSON.parse(raw);
  } catch {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(raw.slice(start, end + 1));
    throw new Error('Fan-out API did not return valid JSON.');
  }
}
