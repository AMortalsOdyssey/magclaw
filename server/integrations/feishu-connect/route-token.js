import crypto from 'node:crypto';

export const FEISHU_IMPORT_ROUTE_PREFIX = 'mcch_';
export const INVALID_CHANNEL_PATH_MESSAGE = '未识别到该路径，请使用正确的路径';

function safeString(value) {
  return String(value || '').trim();
}

function metadataObject(target = {}) {
  if (!target.metadata || typeof target.metadata !== 'object' || Array.isArray(target.metadata)) {
    target.metadata = {};
  }
  return target.metadata;
}

function randomRouteKey() {
  return `${FEISHU_IMPORT_ROUTE_PREFIX}${crypto.randomBytes(18).toString('base64url')}`;
}

export function ensureChannelFeishuRouteKey(channel, options = {}) {
  if (!channel || typeof channel !== 'object') return '';
  const metadata = metadataObject(channel);
  metadata.integrations = metadata.integrations && typeof metadata.integrations === 'object' && !Array.isArray(metadata.integrations)
    ? metadata.integrations
    : {};
  metadata.integrations.feishuImport = metadata.integrations.feishuImport
    && typeof metadata.integrations.feishuImport === 'object'
    && !Array.isArray(metadata.integrations.feishuImport)
    ? metadata.integrations.feishuImport
    : {};
  const existing = safeString(metadata.integrations.feishuImport.routeKey);
  if (existing) return existing;
  const next = typeof options.randomId === 'function' ? options.randomId() : randomRouteKey();
  metadata.integrations.feishuImport.routeKey = safeString(next) || randomRouteKey();
  return metadata.integrations.feishuImport.routeKey;
}

export function channelFeishuRouteKey(channel) {
  return safeString(channel?.metadata?.integrations?.feishuImport?.routeKey);
}

export function buildChannelImportPath({ serverId, channelId, routeKey }) {
  const cleanServerId = encodeURIComponent(safeString(serverId));
  const cleanChannelId = encodeURIComponent(safeString(channelId));
  const cleanRouteKey = encodeURIComponent(safeString(routeKey));
  return `mc://magclaw/server/${cleanServerId}/channel/${cleanChannelId}?key=${cleanRouteKey}`;
}

export function parseChannelImportPath(value = '') {
  const raw = safeString(value);
  if (!raw) return { ok: false, raw, error: 'missing_path' };
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'mc:' || parsed.hostname !== 'magclaw') {
      return { ok: false, raw, error: 'invalid_scheme' };
    }
    const parts = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'server' || parts[2] !== 'channel') {
      return { ok: false, raw, error: 'invalid_path' };
    }
    const serverId = safeString(parts[1]);
    const channelId = safeString(parts[3]);
    const routeKey = safeString(parsed.searchParams.get('key'));
    if (!serverId || !channelId || !routeKey) return { ok: false, raw, error: 'missing_parts', serverId, channelId, routeKey };
    return { ok: true, raw, serverId, channelId, routeKey };
  } catch {
    return { ok: false, raw, error: 'invalid_url' };
  }
}

export function extractChannelImportPath(text = '') {
  const match = String(text || '').match(/mc:\/\/magclaw\/server\/[^\s<>"'`]+\/channel\/[^\s<>"'`?]+(?:\?[^\s<>"'`]+)?/);
  return match ? match[0] : '';
}

export function invalidChannelPathReply(rawPath = '') {
  const suffix = safeString(rawPath) ? `：${safeString(rawPath)}` : '';
  return `${INVALID_CHANNEL_PATH_MESSAGE}${suffix}`;
}

export function validateChannelImportPath(value, deps = {}) {
  const parsed = typeof value === 'object' && value?.raw ? value : parseChannelImportPath(value);
  const invalid = (reason = parsed.error || 'invalid_path') => ({
    ok: false,
    reason,
    raw: parsed.raw || safeString(value),
    message: invalidChannelPathReply(parsed.raw || value),
  });
  if (!parsed.ok) return invalid();
  const state = typeof deps.getState === 'function' ? deps.getState() : deps.state || {};
  const serverId = safeString(parsed.serverId);
  const currentServerIds = [
    state.connection?.workspaceId,
    state.connection?.serverId,
    state.cloud?.workspace?.id,
    state.cloud?.workspaces?.[0]?.id,
    state.workspaceId,
    'local',
  ].map(safeString).filter(Boolean);
  if (currentServerIds.length && !currentServerIds.includes(serverId)) return invalid('server_not_found');
  const channel = typeof deps.findChannel === 'function'
    ? deps.findChannel(parsed.channelId)
    : (state.channels || []).find((item) => safeString(item?.id) === parsed.channelId);
  if (!channel) return invalid('channel_not_found');
  const expectedKey = channelFeishuRouteKey(channel);
  if (!expectedKey || expectedKey !== parsed.routeKey) return invalid('route_key_mismatch');
  return {
    ok: true,
    ...parsed,
    channel,
    serverId,
    channelId: parsed.channelId,
    routeKey: parsed.routeKey,
  };
}
