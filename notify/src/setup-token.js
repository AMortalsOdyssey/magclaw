const CONNECTION_TOKEN_PREFIX = 'mcn_setup_';
const SHORT_CONNECTION_TOKEN_PREFIX = 'MCN';
const SHORT_SETUP_TOKEN_PATTERN = /^mcn_inv_([0-9A-HJKMNP-TV-Z]{16})$/i;
const SHORT_CONNECTION_CODE_PATTERN = /^MCN-([PT])-([0-9A-HJKMNP-TV-Z]{4})-([0-9A-HJKMNP-TV-Z]{4})-([0-9A-HJKMNP-TV-Z]{4})-([0-9A-HJKMNP-TV-Z]{4})$/i;
const OFFICIAL_RELAY_URLS = Object.freeze({
  P: 'https://magclaw.multiego.me',
  T: 'https://magclaw-testing.multiego.me',
});

function normalizeEmbeddedRelayUrl(value = '') {
  const url = new URL(String(value || ''));
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Notify connection token Relay URL must use HTTP or HTTPS.');
  if (url.protocol !== 'https:' && !loopback) throw new Error('Notify connection token Relay URL must use HTTPS outside local development.');
  return url.toString().replace(/\/+$/, '');
}

function officialRelayCode(relayUrl = '') {
  const normalized = normalizeEmbeddedRelayUrl(relayUrl);
  const entry = Object.entries(OFFICIAL_RELAY_URLS).find(([, url]) => normalized === url);
  return entry?.[0] || '';
}

function shortConnectionCode(relayUrl = '', setupToken = '') {
  const relayCode = officialRelayCode(relayUrl);
  const secret = String(setupToken || '').trim().match(SHORT_SETUP_TOKEN_PATTERN)?.[1]?.toUpperCase() || '';
  if (!relayCode || !secret) return '';
  return [SHORT_CONNECTION_TOKEN_PREFIX, relayCode, ...secret.match(/.{4}/g)].join('-');
}

export function encodeNotifyConnectionToken({ relayUrl, setupToken } = {}) {
  const normalizedRelayUrl = normalizeEmbeddedRelayUrl(relayUrl);
  const rawSetupToken = String(setupToken || '').trim();
  if (!rawSetupToken.startsWith('mcn_inv_')) throw new Error('Notify Setup Token is invalid.');
  const shortCode = shortConnectionCode(normalizedRelayUrl, rawSetupToken);
  if (shortCode) return shortCode;
  const payload = Buffer.from(JSON.stringify({ v: 1, relayUrl: normalizedRelayUrl, setupToken: rawSetupToken })).toString('base64url');
  return `${CONNECTION_TOKEN_PREFIX}${payload}`;
}

export function decodeNotifyConnectionToken(value = '') {
  const token = String(value || '').trim();
  if (token.length > 2000) throw new Error('Notify connection token is too long. Ask the Owner for a new Token.');
  const shortMatch = token.match(SHORT_CONNECTION_CODE_PATTERN);
  if (shortMatch) {
    const relayCode = shortMatch[1].toUpperCase();
    const secret = shortMatch.slice(2).join('').toUpperCase();
    return {
      setupToken: 'mcn_inv_' + secret,
      relayUrl: OFFICIAL_RELAY_URLS[relayCode],
      format: 'short-connection-code',
    };
  }
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
