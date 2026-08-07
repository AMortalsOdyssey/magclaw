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
