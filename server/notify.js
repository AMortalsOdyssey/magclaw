import crypto from 'node:crypto';

export const NOTIFY_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30;
export const NOTIFY_DEVICE_TTL_MS = 1000 * 60 * 10;
export const NOTIFY_REQUEST_RETENTION_MS = 1000 * 60 * 60 * 24 * 30;
export const NOTIFY_MAX_MARKDOWN_BYTES = 96 * 1024;

const TERMINAL_STATUSES = new Set([
  'sent',
  'failed',
  'rejected',
  'target_unavailable',
  'awaiting_configuration',
  'awaiting_confirmation',
]);

export function notifyRecords(state = {}) {
  state.notifyRecords = Array.isArray(state.notifyRecords) ? state.notifyRecords : [];
  return state.notifyRecords;
}

export function notifyRecordsForWorkspace(state = {}, workspaceId = '') {
  const cleanWorkspaceId = String(workspaceId || '').trim();
  return notifyRecords(state).filter((record) => String(record?.workspaceId || '').trim() === cleanWorkspaceId);
}

export function notifyRecordsForRelay(state = {}, relayId = '') {
  const cleanRelayId = String(relayId || '').trim();
  return notifyRecords(state).filter((record) => String(record?.relayId || '').trim() === cleanRelayId);
}

export function notifyRecord(state = {}, type = '', id = '') {
  return notifyRecords(state).find((record) => record?.type === type && record?.id === id) || null;
}

export function notifyRequest(state = {}, requestId = '') {
  return notifyRecord(state, 'request', String(requestId || '').trim());
}

export function notifyInstallation(state = {}, relayId = '') {
  return notifyRecords(state).find((record) => (
    record?.type === 'installation'
      && record?.id === String(relayId || '').trim()
      && record?.enabled !== false
  )) || null;
}

export function hashNotifySecret(value = '') {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

export function randomNotifySecret(prefix = 'mcn') {
  return `${prefix}_${crypto.randomBytes(32).toString('base64url')}`;
}

export function normalizeMachineFingerprint(value = '') {
  const clean = String(value || '').trim().toLowerCase();
  return /^mfp_[a-f0-9]{64}$/.test(clean) ? clean : '';
}

export function bearerToken(req) {
  return String(req?.headers?.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1] || '';
}

function safeEqual(left = '', right = '') {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  return leftBuffer.length > 0
    && leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function notifyTokenForRequest(state = {}, req, requiredScope = '') {
  const raw = bearerToken(req);
  return notifyTokenForRaw(state, raw, requiredScope, req);
}

export function notifyTokenForRaw(state = {}, raw = '', requiredScope = '', req = null) {
  if (!raw) return null;
  const tokenHash = hashNotifySecret(raw);
  const fingerprint = normalizeMachineFingerprint(
    req?.headers?.['x-magclaw-machine-fingerprint']
      || req?.headers?.['x-machine-fingerprint']
      || '',
  );
  const record = notifyRecords(state).find((item) => (
    item?.type === 'auth_token'
      && !item.revokedAt
      && safeEqual(item.tokenHash, tokenHash)
      && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now())
  )) || null;
  if (!record) return null;
  if (record.machineFingerprint && record.machineFingerprint !== fingerprint) return null;
  if (requiredScope && !record.scopes?.includes(requiredScope)) return null;
  return record;
}

export function compactNotifyText(value = '', max = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function containsForbiddenAddressing(value, path = '') {
  if (Array.isArray(value)) return value.some((item, index) => containsForbiddenAddressing(item, `${path}[${index}]`));
  if (!value || typeof value !== 'object') return false;
  for (const [key, item] of Object.entries(value)) {
    const normalized = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (['chatid', 'openid', 'userid', 'unionid', 'tenantaccesstoken', 'appid', 'appsecret'].includes(normalized)) return true;
    if (containsForbiddenAddressing(item, path ? `${path}.${key}` : key)) return true;
  }
  return false;
}

export function sanitizeNotifyMarkdown(value = '') {
  let markdown = String(value || '').replace(/\u0000/g, '').trim();
  if (Buffer.byteLength(markdown, 'utf8') > NOTIFY_MAX_MARKDOWN_BYTES) {
    const error = new Error('Notify Markdown is too large.');
    error.status = 413;
    throw error;
  }
  markdown = markdown
    .replace(/<at\b[^>]*>[\s\S]*?<\/at>/gi, '')
    .replace(/<at\b[^>]*\/?\s*>/gi, '')
    .replace(/@all\b/gi, '')
    .replace(/@everyone\b/gi, '')
    .trim();
  return markdown;
}

export function normalizeNotifySubmission(body = {}) {
  if (body.explicitUserAuthorization !== true && body.explicit_user_authorization !== true) {
    const error = new Error('Current-turn explicit user authorization is required.');
    error.status = 400;
    error.code = 'explicit_authorization_required';
    throw error;
  }
  if (containsForbiddenAddressing(body)) {
    const error = new Error('Raw Feishu identifiers and application credentials are not accepted.');
    error.status = 400;
    error.code = 'raw_addressing_forbidden';
    throw error;
  }
  const group = compactNotifyText(body.target?.group || body.group || '', 120);
  if (!group) {
    const error = new Error('An exact target group name is required.');
    error.status = 400;
    error.code = 'target_required';
    throw error;
  }
  const markdown = sanitizeNotifyMarkdown(body.content?.markdown || body.markdown || body.summary || '');
  if (!markdown) {
    const error = new Error('Notify content is required.');
    error.status = 400;
    error.code = 'content_required';
    throw error;
  }
  const mentions = (Array.isArray(body.mentions) ? body.mentions : [])
    .map((item) => compactNotifyText(typeof item === 'string' ? item : item?.name || item?.alias || '', 80))
    .filter(Boolean)
    .slice(0, 20);
  return {
    schemaVersion: 1,
    target: { group },
    content: {
      title: compactNotifyText(body.content?.title || body.title || '工作进展通知', 160),
      markdown,
    },
    instruction: compactNotifyText(body.instruction || '', 2000),
    mentions,
    context: {
      sourceAgent: compactNotifyText(body.context?.sourceAgent || body.sourceAgent || '', 80),
      sessionId: compactNotifyText(body.context?.sessionId || body.sessionId || '', 160),
      turnId: compactNotifyText(body.context?.turnId || body.turnId || '', 160),
      repository: compactNotifyText(body.context?.repository || body.repository || '', 240),
    },
  };
}

export function publicNotifyRequest(record = {}) {
  return {
    id: record.id,
    status: record.status || 'queued',
    target: { group: record.payload?.target?.group || '' },
    title: record.payload?.content?.title || '',
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    completedAt: record.completedAt || null,
    reason: record.publicReason || '',
  };
}

export function applyNotifyResult(state = {}, message = {}, now = () => new Date().toISOString()) {
  const requestId = String(message.requestId || message.payload?.requestId || '').trim();
  const record = notifyRequest(state, requestId);
  if (!record) return null;
  const allowed = new Set([
    'sent',
    'failed',
    'rejected',
    'target_unavailable',
    'awaiting_configuration',
    'awaiting_confirmation',
  ]);
  const status = allowed.has(String(message.status || '')) ? String(message.status) : 'failed';
  record.status = status;
  record.publicReason = compactNotifyText(message.publicReason || message.reason || '', 240);
  record.result = {
    status,
    provider: compactNotifyText(message.provider || '', 80),
    messageId: compactNotifyText(message.messageId || '', 160),
    localReceiptId: compactNotifyText(message.localReceiptId || '', 160),
  };
  record.updatedAt = now();
  if (TERMINAL_STATUSES.has(status)) record.completedAt = record.updatedAt;
  return record;
}

export function pruneNotifyRecords(state = {}, timestamp = Date.now()) {
  const before = notifyRecords(state).length;
  state.notifyRecords = notifyRecords(state).filter((record) => {
    const time = Date.parse(record.updatedAt || record.createdAt || record.expiresAt || '');
    if (record.type === 'installation') return record.enabled !== false;
    if (record.type === 'request') return !time || timestamp - time < NOTIFY_REQUEST_RETENTION_MS;
    if (record.type === 'auth_device') return !record.expiresAt || Date.parse(record.expiresAt) > timestamp - 60_000;
    if (record.type === 'auth_token') {
      if (record.revokedAt) return !time || timestamp - time < NOTIFY_REQUEST_RETENTION_MS;
      return !record.expiresAt || Date.parse(record.expiresAt) > timestamp - 60_000;
    }
    return !time || timestamp - time < NOTIFY_REQUEST_RETENTION_MS;
  });
  return before - state.notifyRecords.length;
}
