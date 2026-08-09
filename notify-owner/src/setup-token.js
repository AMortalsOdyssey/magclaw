const CONNECTION_TOKEN_PREFIX = 'mcn_setup_';

function normalizeRelayUrl(value = '') {
  const url = new URL(String(value || ''));
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Notify connection token Relay URL must use HTTP or HTTPS.');
  if (url.protocol !== 'https:' && !loopback) throw new Error('Notify connection token Relay URL must use HTTPS outside local development.');
  return url.toString().replace(/\/+$/, '');
}

export function encodeNotifyConnectionToken({ relayUrl, setupToken } = {}) {
  const rawSetupToken = String(setupToken || '').trim();
  if (!rawSetupToken.startsWith('mcn_inv_')) throw new Error('Notify Setup Token is invalid.');
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    relayUrl: normalizeRelayUrl(relayUrl),
    setupToken: rawSetupToken,
  })).toString('base64url');
  return `${CONNECTION_TOKEN_PREFIX}${payload}`;
}
