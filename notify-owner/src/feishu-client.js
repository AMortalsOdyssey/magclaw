import { readFile } from 'node:fs/promises';

const TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 30_000;

function clean(value = '', max = 2000) {
  return String(value || '').replace(/\u0000/g, '').trim().slice(0, max);
}

function feishuBaseUrl(domain = 'feishu') {
  const value = clean(domain, 500).replace(/\/+$/, '');
  if (!value || value === 'feishu') return 'https://open.feishu.cn';
  if (value === 'lark') return 'https://open.larksuite.com';
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new Error('Feishu REST domain must be an HTTPS URL without embedded credentials.');
  }
  return parsed.toString().replace(/\/+$/, '');
}

function apiError(operation, response, payload) {
  const code = payload && typeof payload === 'object' ? payload.code : undefined;
  const message = payload && typeof payload === 'object' ? payload.msg || payload.message : '';
  return new Error(`${operation} failed: HTTP ${response.status}${code === undefined ? '' : ` code=${code}`}${message ? ` ${clean(message, 300)}` : ''}`);
}

function assertApiSuccess(operation, response, payload) {
  if (!response.ok || (payload && typeof payload === 'object' && payload.code !== undefined && Number(payload.code) !== 0)) {
    throw apiError(operation, response, payload);
  }
  return payload;
}

function messageId(payload) {
  return clean(payload?.data?.message_id || payload?.data?.messageId || payload?.message_id || payload?.messageId || '', 240);
}

function imageKey(payload) {
  return clean(payload?.data?.image_key || payload?.data?.imageKey || payload?.image_key || payload?.imageKey || '', 240);
}

export function createEnvFeishuCredentialProvider(config = {}, env = process.env) {
  return async () => {
    const appId = clean(config.appId || env[clean(config.appIdEnv || 'FEISHU_APP_ID', 120)], 300);
    let appSecret = clean(env[clean(config.appSecretEnv || 'FEISHU_APP_SECRET', 120)], 2000);
    if (!appSecret && config.appSecretFile) {
      appSecret = clean(await readFile(String(config.appSecretFile), 'utf8'), 2000);
    }
    if (!appId || !appSecret) {
      throw new Error('Feishu REST credentials are unavailable. Configure appId plus appSecretEnv or appSecretFile.');
    }
    return { appId, appSecret, domain: config.domain || 'feishu' };
  };
}

export function createFeishuRestClient(options = {}) {
  const credentialProvider = options.credentialProvider;
  if (typeof credentialProvider !== 'function') throw new Error('Feishu REST credentialProvider is required.');
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('Feishu REST requires fetch.');
  const timeoutMs = Math.max(1_000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS));
  let tokenState = null;
  let tokenPromise = null;

  async function credentials() {
    const value = await credentialProvider();
    const appId = clean(value?.appId, 300);
    const appSecret = clean(value?.appSecret, 2000);
    if (!appId || !appSecret) throw new Error('Feishu REST credential provider returned incomplete credentials.');
    return { appId, appSecret, baseUrl: feishuBaseUrl(value?.domain) };
  }

  async function refreshToken() {
    const creds = await credentials();
    const response = await fetchImpl(`${creds.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    assertApiSuccess('Feishu tenant token', response, payload);
    const token = clean(payload.tenant_access_token, 2000);
    if (!token) throw new Error('Feishu tenant token response did not include tenant_access_token.');
    const expireSeconds = Math.max(60, Number(payload.expire || payload.expires_in || 7200));
    tokenState = {
      token,
      baseUrl: creds.baseUrl,
      expiresAt: Date.now() + expireSeconds * 1000,
    };
    return tokenState;
  }

  async function access() {
    if (tokenState && tokenState.expiresAt - TOKEN_REFRESH_SKEW_MS > Date.now()) return tokenState;
    if (!tokenPromise) {
      tokenPromise = refreshToken().finally(() => { tokenPromise = null; });
    }
    return tokenPromise;
  }

  async function request(operation, apiPath, init = {}) {
    const auth = await access();
    const response = await fetchImpl(`${auth.baseUrl}${apiPath}`, {
      ...init,
      headers: {
        authorization: `Bearer ${auth.token}`,
        ...(init.body instanceof FormData ? {} : { 'content-type': 'application/json' }),
        ...init.headers,
      },
      signal: init.signal || AbortSignal.timeout(timeoutMs),
    });
    const payload = await response.json().catch(() => ({}));
    return assertApiSuccess(operation, response, payload);
  }

  return {
    invalidateToken() {
      tokenState = null;
    },
    async sendInteractive({ receiveIdType, receiveId, card, idempotencyKey }) {
      const query = new URLSearchParams({ receive_id_type: String(receiveIdType) });
      if (idempotencyKey) query.set('uuid', clean(idempotencyKey, 120));
      const payload = await request('Feishu interactive message send', `/open-apis/im/v1/messages?${query}`, {
        method: 'POST',
        body: JSON.stringify({ receive_id: receiveId, msg_type: 'interactive', content: JSON.stringify(card) }),
      });
      return { messageId: messageId(payload), payload };
    },
    async updateCard({ token, card }) {
      const payload = await request('Feishu callback card update', '/open-apis/interactive/v1/card/update', {
        method: 'POST',
        body: JSON.stringify({ token, card }),
      });
      return { updated: true, payload };
    },
    async patchMessage({ messageId: targetMessageId, card }) {
      const payload = await request('Feishu message card update', `/open-apis/im/v1/messages/${encodeURIComponent(targetMessageId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ content: JSON.stringify(card) }),
      });
      return { updated: true, payload };
    },
    async uploadImage({ bytes, filename = 'notify-image.png', contentType = 'image/png' }) {
      const form = new FormData();
      form.append('image_type', 'message');
      form.append('image', new Blob([bytes], { type: contentType }), filename);
      const payload = await request('Feishu image upload', '/open-apis/im/v1/images', { method: 'POST', body: form });
      const key = imageKey(payload);
      if (!key) throw new Error('Feishu image upload did not return image_key.');
      return { imageKey: key, payload };
    },
    async listChatMembers({ chatId, pageSize = 100 }) {
      const items = [];
      let pageToken = '';
      do {
        const query = new URLSearchParams({ member_id_type: 'open_id', page_size: String(pageSize) });
        if (pageToken) query.set('page_token', pageToken);
        const payload = await request('Feishu chat member list', `/open-apis/im/v1/chats/${encodeURIComponent(chatId)}/members?${query}`, { method: 'GET' });
        items.push(...(Array.isArray(payload?.data?.items) ? payload.data.items : []));
        pageToken = clean(payload?.data?.page_token, 500);
      } while (pageToken);
      return items;
    },
  };
}

export { feishuBaseUrl };
