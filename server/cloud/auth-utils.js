export function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function parseCookies(req) {
  const header = String(req.headers?.cookie || '');
  const cookies = new Map();
  for (const item of header.split(';')) {
    const index = item.indexOf('=');
    if (index === -1) continue;
    const key = item.slice(0, index).trim();
    const value = item.slice(index + 1).trim();
    if (key) cookies.set(key, decodeURIComponent(value));
  }
  return cookies;
}

export function requestOrigin(req) {
  const proto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim()
    || (req.socket?.encrypted ? 'https' : 'http');
  const host = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '').split(',')[0].trim();
  return host ? `${proto}://${host}` : '';
}

export function httpOriginFromValue(value) {
  const raw = String(value || '').split(',')[0].trim();
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.origin;
  } catch {
    return '';
  }
}

export function publicLinkOrigin(req) {
  const configured = String(process.env.MAGCLAW_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  if (!req) return '';
  const forwardedHost = String(req.headers?.['x-forwarded-host'] || '').split(',')[0].trim();
  if (forwardedHost) {
    const proto = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim()
      || (req.socket?.encrypted ? 'https' : 'http');
    return `${proto}://${forwardedHost}`;
  }
  return httpOriginFromValue(req.headers?.origin) || requestOrigin(req);
}
