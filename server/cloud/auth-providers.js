import { publicLinkOrigin } from './auth-utils.js';

const EMAIL_PASSWORD = 'email_password';
const FEISHU = 'feishu';

function cleanString(value) {
  return String(value || '').trim();
}

function pick(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

export function normalizeAuthProviderType(value) {
  const type = cleanString(value).toLowerCase().replace(/[-\s]+/g, '_');
  if (['email', 'password', 'email_password', 'email_passcode', 'local'].includes(type)) return EMAIL_PASSWORD;
  if (['feishu', 'lark'].includes(type)) return FEISHU;
  return '';
}

function parseAuthProvidersEnv(env = process.env) {
  const raw = cleanString(env.MAGCLAW_AUTH_PROVIDERS);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return raw.split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
}

function normalizeProvider(rawProvider) {
  const provider = typeof rawProvider === 'string' ? { type: rawProvider } : (rawProvider || {});
  const type = normalizeAuthProviderType(pick(provider.type, provider.id, provider.provider));
  if (!type) return null;
  if (provider.enabled === false || provider.enable === false) return null;
  if (type === FEISHU) {
    return {
      id: FEISHU,
      type: FEISHU,
      label: cleanString(provider.label) || 'Feishu',
      appId: cleanString(pick(provider.app_id, provider.appId, provider.client_id, provider.clientId)),
      appSecret: cleanString(pick(provider.app_secret, provider.appSecret, provider.client_secret, provider.clientSecret)),
      redirectUri: cleanString(pick(provider.redirect_uri, provider.redirectUri, provider.callback_url, provider.callbackUrl)),
    };
  }
  return {
    id: EMAIL_PASSWORD,
    type: EMAIL_PASSWORD,
    label: cleanString(provider.label) || 'Email password',
  };
}

export function configuredAuthProviders(env = process.env) {
  const rawProviders = parseAuthProvidersEnv(env) || [{ type: EMAIL_PASSWORD }];
  const providers = [];
  const seen = new Set();
  for (const rawProvider of rawProviders) {
    const provider = normalizeProvider(rawProvider);
    if (!provider || seen.has(provider.id)) continue;
    providers.push(provider);
    seen.add(provider.id);
  }
  return providers.length ? providers : [{ id: EMAIL_PASSWORD, type: EMAIL_PASSWORD, label: 'Email password' }];
}

export function hasAuthProvider(type, env = process.env) {
  const normalized = normalizeAuthProviderType(type);
  return configuredAuthProviders(env).some((provider) => provider.id === normalized);
}

export function defaultAuthProviderId(env = process.env) {
  const providers = configuredAuthProviders(env);
  return providers.some((provider) => provider.id === FEISHU)
    ? FEISHU
    : providers[0]?.id || EMAIL_PASSWORD;
}

export function publicAuthProviders(req = null, env = process.env) {
  return configuredAuthProviders(env).map((provider) => {
    if (provider.id === FEISHU) {
      return {
        id: FEISHU,
        type: FEISHU,
        label: provider.label,
        mode: 'oauth',
        enabled: true,
        loginUrl: '/api/cloud/auth/feishu/start',
      };
    }
    return {
      id: EMAIL_PASSWORD,
      type: EMAIL_PASSWORD,
      label: provider.label,
      mode: 'password',
      enabled: true,
    };
  });
}

export function feishuProviderConfig(req = null, env = process.env) {
  const provider = configuredAuthProviders(env).find((item) => item.id === FEISHU);
  if (!provider) return null;
  const base = req ? publicLinkOrigin(req).replace(/\/+$/, '') : '';
  return {
    ...provider,
    redirectUri: provider.redirectUri || (base ? `${base}/api/cloud/auth/feishu/callback` : ''),
  };
}
