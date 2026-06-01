function clean(value) {
  return String(value || '').trim();
}

const FEISHU_ID_RE = /^(ou|oc|on|om|omt|cli|user|union|u)_[A-Za-z0-9_-]+$/i;
const FEISHU_ID_IN_TEXT_RE = /\b((?:ou|oc|on|om|omt|cli|user|union|u)_[A-Za-z0-9_-]{3,})\b/g;

export function isLikelyFeishuId(value) {
  return FEISHU_ID_RE.test(clean(value));
}

function splitFeishuId(value) {
  const text = clean(value);
  const match = text.match(/^([A-Za-z]+)_(.+)$/);
  if (!match) return { prefix: '', body: text };
  return { prefix: match[1], body: match[2] };
}

function visibleIdParts(value) {
  const text = clean(value);
  if (!text) return null;
  const { prefix, body } = splitFeishuId(text);
  if (!body) return null;
  const headLength = body.length > 8 ? 4 : Math.max(1, Math.ceil(body.length / 2));
  const tailLength = body.length > 8 ? 4 : Math.max(1, Math.floor(body.length / 2));
  return {
    prefix,
    head: body.slice(0, headLength),
    tail: body.slice(Math.max(headLength, body.length - tailLength)),
  };
}

export function maskFeishuId(value) {
  const parts = visibleIdParts(value);
  if (!parts) return '';
  const masked = `${parts.head}****${parts.tail}`;
  return parts.prefix ? `${parts.prefix}_${masked}` : masked;
}

export function maskedFeishuIdPathSegment(value) {
  const parts = visibleIdParts(value);
  if (!parts) return '';
  const segment = `${parts.head}_${parts.tail}`;
  return parts.prefix ? `${parts.prefix}_${segment}` : segment;
}

export function maskFeishuIdsInText(value) {
  return String(value || '').replace(FEISHU_ID_IN_TEXT_RE, (id) => maskFeishuId(id) || id);
}

export function feishuIdTypeForValue(value, fallback = 'external_id') {
  const text = clean(value);
  if (/^cli_/i.test(text)) return 'app_id';
  if (/^ou_/i.test(text)) return 'open_id';
  if (/^(on|union)_/i.test(text)) return 'union_id';
  if (/^(user|u)_/i.test(text)) return 'user_id';
  if (/^oc_/i.test(text)) return 'chat_id';
  if (/^(om|omt)_/i.test(text)) return 'message_id';
  return fallback;
}

export function feishuDisplayKindForValue(value, fallback = '') {
  const text = clean(value);
  if (/^cli_/i.test(text)) return 'bot';
  if (/^oc_/i.test(text)) return 'chat';
  if (/^(om|omt)_/i.test(text)) return 'message';
  if (/^(ou|on|union|user|u)_/i.test(text)) return 'user';
  return clean(fallback) || 'user';
}

function displayKindLabel(kind = '') {
  const normalized = clean(kind).toLowerCase();
  if (normalized === 'bot' || normalized === 'app') return 'Feishu Bot';
  if (normalized === 'chat' || normalized === 'group' || normalized === 'topic') return 'Feishu chat';
  if (normalized === 'message') return 'Feishu message';
  return 'Feishu user';
}

export function safeFeishuDisplayName(value, options = {}) {
  const text = clean(value);
  if (text && !isLikelyFeishuId(text)) return text;
  const fallbackId = clean(text || options.fallbackId || options.id || '');
  const kind = clean(options.kind || feishuDisplayKindForValue(fallbackId, 'user'));
  const maskedId = maskFeishuId(fallbackId);
  if (maskedId) return `${displayKindLabel(kind)} ${maskedId}`;
  return clean(options.fallback) || displayKindLabel(kind);
}

export function maskedFeishuIdDetail(idType, value) {
  const masked = maskFeishuId(value);
  const type = clean(idType || feishuIdTypeForValue(value));
  if (!masked) return '';
  return `${type}=${masked}`;
}
