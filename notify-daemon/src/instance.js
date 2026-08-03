const DEFAULT_NOTIFY_INSTANCE = 'default';

export function normalizeNotifyInstance(value = DEFAULT_NOTIFY_INSTANCE) {
  const raw = String(value || DEFAULT_NOTIFY_INSTANCE).trim().toLowerCase();
  const normalized = raw
    .normalize('NFKC')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  if (!normalized) throw new Error('Notify instance must contain letters or numbers.');
  return normalized;
}

export function notifyInstanceFromFlags(flags = {}) {
  return normalizeNotifyInstance(flags.instance || flags.project || DEFAULT_NOTIFY_INSTANCE);
}

export { DEFAULT_NOTIFY_INSTANCE };
