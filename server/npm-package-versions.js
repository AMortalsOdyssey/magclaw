const DEFAULT_PACKAGE_NAMES = ['@magclaw/daemon', '@magclaw/computer'];
const DEFAULT_TTL_MS = 10 * 60_000;
const DEFAULT_REGISTRY_URL = 'https://registry.npmjs.org';

function registryPackageUrl(packageName, registryUrl = DEFAULT_REGISTRY_URL) {
  const base = String(registryUrl || DEFAULT_REGISTRY_URL).replace(/\/+$/, '');
  const clean = String(packageName || '').trim().toLowerCase();
  if (!clean) return '';
  return `${base}/${clean.replace('/', '%2f')}`;
}

async function defaultFetchJson(url) {
  if (typeof fetch !== 'function') throw new Error('fetch is not available in this Node runtime.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`npm registry returned ${response.status}`);
    return response.json();
  } finally {
    clearTimeout(timer);
  }
}

export function createNpmPackageVersionResolver(options = {}) {
  const packageNames = (options.packageNames || DEFAULT_PACKAGE_NAMES).map(String).filter(Boolean);
  const fetchJson = options.fetchJson || defaultFetchJson;
  const nowMs = typeof options.nowMs === 'function' ? options.nowMs : () => Date.now();
  const ttlMs = Math.max(1000, Number(options.ttlMs || process.env.MAGCLAW_NPM_VERSION_CACHE_MS || DEFAULT_TTL_MS) || DEFAULT_TTL_MS);
  const registryUrl = options.registryUrl || process.env.MAGCLAW_NPM_REGISTRY_URL || DEFAULT_REGISTRY_URL;
  const cache = new Map();
  const inflight = new Map();

  async function refreshPackage(packageName) {
    const name = String(packageName || '').trim();
    if (!name) return null;
    if (inflight.has(name)) return inflight.get(name);
    const task = (async () => {
      try {
        const data = await fetchJson(registryPackageUrl(name, registryUrl));
        const latest = String(data?.['dist-tags']?.latest || '').trim();
        if (!latest) throw new Error(`Missing latest dist-tag for ${name}.`);
        const record = { latest, checkedAtMs: nowMs(), error: '' };
        cache.set(name, record);
        return record;
      } catch (error) {
        const previous = cache.get(name) || {};
        cache.set(name, {
          ...previous,
          checkedAtMs: nowMs(),
          error: error?.message || String(error),
        });
        return null;
      } finally {
        inflight.delete(name);
      }
    })();
    inflight.set(name, task);
    return task;
  }

  async function refreshAll() {
    return Promise.all(packageNames.map((name) => refreshPackage(name)));
  }

  function maybeRefreshAll() {
    const now = nowMs();
    const stale = packageNames.some((name) => {
      const record = cache.get(name);
      return !record?.checkedAtMs || now - record.checkedAtMs >= ttlMs;
    });
    return stale ? refreshAll() : Promise.resolve([]);
  }

  function latest(packageName, fallback = '') {
    const name = String(packageName || '').trim();
    return String(cache.get(name)?.latest || fallback || '').trim();
  }

  return {
    latest,
    maybeRefreshAll,
    refreshAll,
    refreshPackage,
  };
}
