const CONNECTION_TOKEN_PREFIX = 'mcn_setup_';

function normalizeEmbeddedRelayUrl(value = '') {
  const url = new URL(String(value || ''));
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Notify connection token Relay URL must use HTTP or HTTPS.');
  if (url.protocol !== 'https:' && !loopback) throw new Error('Notify connection token Relay URL must use HTTPS outside local development.');
  return url.toString().replace(/\/+$/, '');
}

export function encodeNotifyConnectionToken({ relayUrl, setupToken } = {}) {
  const normalizedRelayUrl = normalizeEmbeddedRelayUrl(relayUrl);
  const rawSetupToken = String(setupToken || '').trim();
  if (!rawSetupToken.startsWith('mcn_inv_')) throw new Error('Notify Setup Token is invalid.');
  const payload = Buffer.from(JSON.stringify({ v: 1, relayUrl: normalizedRelayUrl, setupToken: rawSetupToken })).toString('base64url');
  return `${CONNECTION_TOKEN_PREFIX}${payload}`;
}

export function decodeNotifyConnectionToken(value = '') {
  const token = String(value || '').trim();
  if (token.length > 2000) throw new Error('Notify connection token is too long. Ask the Owner for a new Token.');
  if (!token.startsWith(CONNECTION_TOKEN_PREFIX)) return { setupToken: token, relayUrl: '', format: 'legacy' };
  try {
    const payload = JSON.parse(Buffer.from(token.slice(CONNECTION_TOKEN_PREFIX.length), 'base64url').toString('utf8'));
    const setupToken = String(payload?.setupToken || '').trim();
    if (payload?.v !== 1 || !setupToken.startsWith('mcn_inv_')) throw new Error('invalid payload');
    return { setupToken, relayUrl: normalizeEmbeddedRelayUrl(payload.relayUrl), format: 'connection-token' };
  } catch {
    throw new Error('Notify connection token is invalid or damaged. Ask the Owner for a new Token.');
  }
}
