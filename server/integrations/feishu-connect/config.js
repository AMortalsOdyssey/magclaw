function envFlag(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function clean(value, fallback = '') {
  return String(value || fallback || '').trim();
}

export function feishuConnectConfigFromEnv(env = process.env) {
  const enabled = envFlag(env.MAGCLAW_FEISHU_CONNECT_ENABLED);
  const appId = clean(env.MAGCLAW_FEISHU_CONNECT_APP_ID);
  const appSecret = clean(env.MAGCLAW_FEISHU_CONNECT_APP_SECRET);
  return {
    enabled,
    ready: enabled && Boolean(appId && appSecret),
    tenant: clean(env.MAGCLAW_FEISHU_CONNECT_TENANT, 'feishu'),
    appId,
    appSecret,
    messageMode: clean(env.MAGCLAW_FEISHU_CONNECT_MESSAGE_MODE, 'long_connection'),
    replyMode: clean(env.MAGCLAW_FEISHU_CONNECT_REPLY_MODE, 'card'),
  };
}

export function redactedFeishuConnectConfig(config = {}) {
  return {
    ...config,
    appSecret: config.appSecret ? '[redacted]' : '',
  };
}
