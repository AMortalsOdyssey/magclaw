const HOST_REGISTRY_SYMBOL = Symbol.for('magclaw.notify.plugin-hosts.v1');

function hostRegistry() {
  const existing = globalThis[HOST_REGISTRY_SYMBOL];
  if (existing instanceof Map) return existing;
  const registry = new Map();
  Object.defineProperty(globalThis, HOST_REGISTRY_SYMBOL, {
    value: registry,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return registry;
}

export function notifyPluginHostSlotKey({ home = '', instance = 'default', accountId = 'monkey' } = {}) {
  return JSON.stringify([String(home), String(instance), String(accountId)]);
}

export function publishNotifyPluginHost(key, host) {
  if (!key || !host) throw new Error('Notify plugin host slot and host are required.');
  const owner = Symbol('magclaw-notify-host-owner');
  hostRegistry().set(key, { owner, host });
  return () => {
    if (hostRegistry().get(key)?.owner === owner) hostRegistry().delete(key);
  };
}

export function getNotifyPluginHost(key) {
  return hostRegistry().get(key)?.host || null;
}

/**
 * Resolve the exact Bot Binding named by a trusted, validated approval action.
 *
 * Multiple Owner environments may intentionally share one Feishu Bot account.
 * Account-only lookup would then route every callback to the first Binding and
 * could approve the wrong environment. New cards always carry their Binding id;
 * the single-candidate fallback exists only for legacy `default` cards.
 */
export function selectNotifyApprovalBinding(bindings = [], options = {}) {
  const accountId = String(options.accountId || '');
  const botId = String(options.botId || '');
  const candidates = bindings.filter((binding) => (
    binding?.enabled !== false
      && String(binding?.accountId || '') === accountId
  ));
  const exact = candidates.find((binding) => String(binding?.id || '') === botId);
  if (exact) return exact;
  if ((!botId || botId === 'default') && candidates.length === 1) return candidates[0];
  return null;
}
