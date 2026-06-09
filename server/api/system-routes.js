import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

// System-level API routes.
// This group handles public state snapshots, SSE, runtime discovery, global
// settings, and Fan-out API settings. Keeping these routes together makes the
// main dispatcher easier to scan before deeper Agent/task routing begins.

function expectedStreamClose(error) {
  const code = String(error?.code || error?.errno || '');
  return code === 'ECONNRESET' || code === 'EPIPE' || code === 'ERR_STREAM_PREMATURE_CLOSE';
}

const SHARE_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const SHARE_AVATAR_MAX_BYTES = 5 * 1024 * 1024;
const SHARE_AVATAR_FETCH_TIMEOUT_MS = 8000;
const PNG_SIGNATURE_HEX = '89504e470d0a1a0a';
const BOOTSTRAP_ROUTE_CACHE_TTL_MS = 1000;
const BOOTSTRAP_ROUTE_CACHE_MAX_ENTRIES = 64;
const bootstrapRouteCaches = new WeakMap();

function formatServerTimingDuration(ms) {
  const safeMs = Math.max(0, Number(ms) || 0);
  if (safeMs < 10) return safeMs.toFixed(1);
  if (safeMs < 1000) return safeMs.toFixed(0);
  return safeMs.toFixed(0);
}

function createServerTiming() {
  const started = performance.now();
  const entries = [];
  return {
    start() {
      return performance.now();
    },
    mark(name, markStarted) {
      entries.push(`${name};dur=${formatServerTimingDuration(performance.now() - markStarted)}`);
    },
    header() {
      return [...entries, `total;dur=${formatServerTimingDuration(performance.now() - started)}`].join(', ');
    },
    headers() {
      return { 'server-timing': this.header() };
    },
  };
}

function collectionLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

function headerValue(req, name) {
  return String(req?.headers?.[name] || '').trim();
}

function bootstrapWorkspaceRef(req, url) {
  return String(
    headerValue(req, 'x-magclaw-workspace-id')
    || headerValue(req, 'x-magclaw-server-slug')
    || url.searchParams.get('workspaceId')
    || url.searchParams.get('serverSlug')
    || '',
  ).trim();
}

function canonicalSearchParams(searchParams) {
  return [...searchParams.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => (
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
    ));
}

function bootstrapRouteStateToken(state = {}) {
  const cloud = state.cloud || {};
  return [
    `v:${String(state.version || '')}`,
    `u:${String(state.updatedAt || '')}`,
    `c:${collectionLength(state.channels)}`,
    `d:${collectionLength(state.dms)}`,
    `m:${collectionLength(state.messages)}`,
    `r:${collectionLength(state.replies)}`,
    `t:${collectionLength(state.tasks)}`,
    `a:${collectionLength(state.agents)}`,
    `h:${collectionLength(state.humans)}`,
    `cm:${collectionLength(cloud.members || cloud.workspaceMembers)}`,
  ].join('|');
}

function bootstrapRouteActorKey(req, deps, url) {
  const actor = typeof deps?.cloudAuth?.currentActor === 'function'
    ? deps.cloudAuth.currentActor(req)
    : null;
  const user = actor?.user || {};
  const member = actor?.member || {};
  const workspaceRef = bootstrapWorkspaceRef(req, url);
  return [
    `user:${String(user.id || '')}`,
    `member:${String(member.id || '')}`,
    `workspace:${String(member.workspaceId || workspaceRef || '')}`,
    `human:${String(member.humanId || '')}`,
    `role:${String(member.role || '')}`,
  ].join('|');
}

function bootstrapRouteCacheKey(req, url, deps, state) {
  return JSON.stringify({
    actor: bootstrapRouteActorKey(req, deps, url),
    workspaceRef: bootstrapWorkspaceRef(req, url),
    query: canonicalSearchParams(url.searchParams),
    state: bootstrapRouteStateToken(state),
  });
}

function bootstrapRouteCacheForState(state) {
  if (!state || typeof state !== 'object') return null;
  let cache = bootstrapRouteCaches.get(state);
  if (!cache) {
    cache = new Map();
    bootstrapRouteCaches.set(state, cache);
  }
  return cache;
}

function getCachedBootstrapRouteSnapshot(state, key) {
  const cache = bootstrapRouteCacheForState(state);
  if (!cache) return null;
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= performance.now()) {
    cache.delete(key);
    return null;
  }
  return entry.snapshot;
}

function setCachedBootstrapRouteSnapshot(state, key, snapshot) {
  const cache = bootstrapRouteCacheForState(state);
  if (!cache) return;
  const nowMs = performance.now();
  for (const [entryKey, entry] of cache) {
    if (entry.expiresAt <= nowMs) cache.delete(entryKey);
  }
  while (cache.size >= BOOTSTRAP_ROUTE_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
  cache.set(key, {
    snapshot,
    expiresAt: nowMs + BOOTSTRAP_ROUTE_CACHE_TTL_MS,
  });
}

function isLoopbackRequest(req) {
  const remoteAddress = String(req.socket?.remoteAddress || '');
  const forwardedFor = String(req.headers?.['x-forwarded-for'] || '').trim();
  return !forwardedFor && (
    remoteAddress === '127.0.0.1'
    || remoteAddress === '::1'
    || remoteAddress === '::ffff:127.0.0.1'
    || remoteAddress === ''
  );
}

function safeShareImageFileName(value) {
  const fallbackStamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
  const fallback = `magclaw-share-${fallbackStamp}.png`;
  const baseName = path.basename(String(value || fallback));
  if (!/^magclaw-share-[A-Za-z0-9._-]+\.png$/.test(baseName)) return fallback;
  return baseName;
}

function decodeShareImageDataUrl(value) {
  const match = String(value || '').match(/^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) return null;
  const buffer = Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
  if (!buffer.length || buffer.length > SHARE_IMAGE_MAX_BYTES) return null;
  if (buffer.subarray(0, 8).toString('hex') !== PNG_SIGNATURE_HEX) return null;
  return buffer;
}

function normalizedShareAvatarUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.startsWith('data:') || raw.startsWith('/')) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.href;
  } catch {
    return '';
  }
}

function addShareAvatarUrl(urls, value) {
  const normalized = normalizedShareAvatarUrl(value);
  if (normalized) urls.add(normalized);
}

function collectShareAvatarUrls(state = {}) {
  const urls = new Set();
  for (const agent of state.agents || []) {
    addShareAvatarUrl(urls, agent?.avatar);
    addShareAvatarUrl(urls, agent?.avatarUrl);
  }
  for (const human of state.humans || []) {
    addShareAvatarUrl(urls, human?.avatar);
    addShareAvatarUrl(urls, human?.avatarUrl);
  }
  const cloud = state.cloud || {};
  addShareAvatarUrl(urls, cloud.workspace?.avatar);
  for (const workspace of cloud.workspaces || []) addShareAvatarUrl(urls, workspace?.avatar);
  for (const user of cloud.users || []) addShareAvatarUrl(urls, user?.avatarUrl || user?.avatar);
  for (const member of cloud.members || cloud.workspaceMembers || []) {
    addShareAvatarUrl(urls, member?.avatarUrl || member?.avatar);
    addShareAvatarUrl(urls, member?.user?.avatarUrl || member?.user?.avatar);
    addShareAvatarUrl(urls, member?.human?.avatar || member?.human?.avatarUrl);
  }
  return urls;
}

function blockedShareAvatarHost(hostname = '') {
  const host = String(hostname || '').toLowerCase();
  if (!host || host === 'localhost') return true;
  const ipVersion = net.isIP(host);
  if (!ipVersion) return false;
  if (ipVersion === 4) {
    const parts = host.split('.').map((part) => Number(part));
    if (parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    return false;
  }
  return host === '::1'
    || host === '::'
    || host.startsWith('fc')
    || host.startsWith('fd')
    || host.startsWith('fe80:');
}

function allowedShareAvatarUrl(state, value) {
  const normalized = normalizedShareAvatarUrl(value);
  if (!normalized) return '';
  const parsed = new URL(normalized);
  if (blockedShareAvatarHost(parsed.hostname)) return '';
  return collectShareAvatarUrls(state).has(normalized) ? normalized : '';
}

async function writeUniqueShareImage(dir, fileName, buffer) {
  await mkdir(dir, { recursive: true });
  const parsed = path.parse(fileName);
  for (let index = 0; index < 100; index += 1) {
    const nextName = index === 0 ? fileName : `${parsed.name}-${index}${parsed.ext}`;
    const filePath = path.join(dir, nextName);
    try {
      await writeFile(filePath, buffer, { flag: 'wx' });
      return { fileName: nextName, path: filePath };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Could not allocate a unique share image filename.');
}

export async function handleSystemApi(req, res, url, deps) {
  const {
    addSystemEvent,
    beginDrain,
    broadcastState,
    cloudAuth,
    deploymentHealth,
    defaultWorkspace,
    detectInstalledRuntimes,
    fanoutApiConfigured,
    getRuntimeInfo,
    getState,
    hydrateBootstrapWindow,
    isDraining,
    persistState,
    presenceHeartbeat,
    packageUpdateSnapshot,
    packageVersionSnapshot,
    publicBootstrapState,
    publicDirectoryState,
    publicDirectorySearchState,
    publicMembersDirectoryState,
    publicState,
    readJson,
    sendError,
    sendJson,
    shareImageDownloadDir,
    realtimeEventsForRequest,
    sseClients,
    updateFanoutApiConfig,
    writePresenceHeartbeat,
  } = deps;
  const state = getState();

  function requireSystemRole(allowedRoles = []) {
    if (!cloudAuth?.isLoginRequired?.()) return true;
    return Boolean(cloudAuth.requireUser(req, res, sendError, allowedRoles));
  }

  if (req.method === 'GET' && url.pathname === '/api/healthz') {
    sendJson(res, 200, {
      ok: true,
      service: 'magclaw-web',
      time: new Date().toISOString(),
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/readyz') {
    const timing = createServerTiming();
    const healthStarted = timing.start();
    const ready = typeof deploymentHealth === 'function'
      ? await deploymentHealth()
      : { ok: true };
    timing.mark('health', healthStarted);
    sendJson(res, ready.ok ? 200 : 503, ready, timing.headers());
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/internal/drain') {
    if (!isLoopbackRequest(req)) {
      sendError(res, 403, 'Drain endpoint is only available from loopback.');
      return true;
    }
    const result = typeof beginDrain === 'function'
      ? beginDrain('internal_api')
      : { ok: false, draining: false };
    sendJson(res, result.ok ? 200 : 500, result);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/share-images/save') {
    if (!isLoopbackRequest(req)) {
      sendError(res, 403, 'Share image saving is only available from loopback.');
      return true;
    }
    const body = await readJson(req);
    const buffer = decodeShareImageDataUrl(body.imageUrl || body.dataUrl);
    if (!buffer) {
      sendError(res, 400, 'A valid PNG data URL is required.');
      return true;
    }
    const configuredDownloadDir = String(shareImageDownloadDir || '').trim();
    if (!configuredDownloadDir) {
      sendError(res, 500, 'Share image download directory is not configured.');
      return true;
    }
    const downloadDir = path.resolve(configuredDownloadDir);
    const fileName = safeShareImageFileName(body.fileName);
    const saved = await writeUniqueShareImage(downloadDir, fileName, buffer);
    sendJson(res, 200, { ok: true, ...saved });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/share-images/avatar') {
    const avatarUrl = allowedShareAvatarUrl(state, url.searchParams.get('src'));
    if (!avatarUrl) {
      sendError(res, 403, 'Avatar URL is not available for share export.');
      return true;
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), SHARE_AVATAR_FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(avatarUrl, {
        redirect: 'follow',
        signal: controller.signal,
        headers: { accept: 'image/avif,image/webp,image/png,image/jpeg,image/svg+xml,image/*;q=0.8' },
      });
      if (!response.ok) {
        sendError(res, 502, 'Avatar image could not be loaded.');
        return true;
      }
      const contentType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      if (!contentType.startsWith('image/')) {
        sendError(res, 415, 'Avatar URL did not return an image.');
        return true;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.length || buffer.length > SHARE_AVATAR_MAX_BYTES) {
        sendError(res, 413, 'Avatar image is too large for share export.');
        return true;
      }
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'private, max-age=300',
      });
      res.end(buffer);
      return true;
    } catch {
      sendError(res, 502, 'Avatar image could not be loaded.');
      return true;
    } finally {
      clearTimeout(timeout);
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    sendJson(res, 200, publicState(req));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
    const timing = createServerTiming();
    const options = {
      spaceType: url.searchParams.get('spaceType') || '',
      spaceId: url.searchParams.get('spaceId') || '',
      threadMessageId: url.searchParams.get('threadMessageId') || '',
      messageLimit: url.searchParams.get('messageLimit') || '',
      threadRootLimit: url.searchParams.get('threadRootLimit') || '',
      eventLimit: url.searchParams.get('eventLimit') || '',
      taskLimit: url.searchParams.get('taskLimit') || '',
    };
    const directoryFormat = url.searchParams.get('directoryFormat') || '';
    if (directoryFormat) options.directoryFormat = directoryFormat;
    const directoryScope = url.searchParams.get('directoryScope') || '';
    if (directoryScope) options.directoryScope = directoryScope;
    const selectedAgentId = url.searchParams.get('selectedAgentId') || '';
    if (selectedAgentId) options.selectedAgentId = selectedAgentId;
    const selectedHumanId = url.searchParams.get('selectedHumanId') || '';
    if (selectedHumanId) options.selectedHumanId = selectedHumanId;
    const cacheKey = bootstrapRouteCacheKey(req, url, deps, state);
    const cacheStarted = timing.start();
    const cachedSnapshot = getCachedBootstrapRouteSnapshot(state, cacheKey);
    if (cachedSnapshot) {
      timing.mark('cache', cacheStarted);
      sendJson(res, 200, cachedSnapshot, timing.headers());
      return true;
    }
    const hydrateStarted = timing.start();
    const hydration = typeof hydrateBootstrapWindow === 'function'
      ? await hydrateBootstrapWindow(req, options)
      : null;
    timing.mark('hydrate', hydrateStarted);
    if (hydration) req.magclawBootstrapHydration = hydration;
    const bootstrapOptions = hydration ? { ...options, hydration } : options;
    const hydratedCacheKey = bootstrapRouteCacheKey(req, url, deps, state);
    if (hydratedCacheKey !== cacheKey) {
      const hydratedCachedSnapshot = getCachedBootstrapRouteSnapshot(state, hydratedCacheKey);
      if (hydratedCachedSnapshot) {
        const hydratedCacheStarted = timing.start();
        timing.mark('cache', hydratedCacheStarted);
        sendJson(res, 200, hydratedCachedSnapshot, timing.headers());
        return true;
      }
    }
    const projectStarted = timing.start();
    const snapshot = (publicBootstrapState || publicState)(req, bootstrapOptions);
    timing.mark('project', projectStarted);
    setCachedBootstrapRouteSnapshot(state, bootstrapRouteCacheKey(req, url, deps, state), snapshot);
    sendJson(res, 200, snapshot, timing.headers());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/directory/search') {
    const timing = createServerTiming();
    const options = {};
    const directoryFormat = url.searchParams.get('directoryFormat') || '';
    if (directoryFormat) options.directoryFormat = directoryFormat;
    const query = url.searchParams.get('query') || '';
    if (query) options.query = query;
    const limit = url.searchParams.get('limit') || '';
    if (limit) options.limit = limit;
    const types = url.searchParams.get('types') || '';
    if (types) options.types = types;
    const searchStarted = timing.start();
    const snapshot = (publicDirectorySearchState || publicDirectoryState || publicState)(req, options);
    timing.mark('search', searchStarted);
    sendJson(res, 200, snapshot, timing.headers());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/directory') {
    const timing = createServerTiming();
    const options = {};
    const directoryFormat = url.searchParams.get('directoryFormat') || '';
    if (directoryFormat) options.directoryFormat = directoryFormat;
    const limit = url.searchParams.get('limit') || '';
    if (limit) options.limit = limit;
    const cursor = url.searchParams.get('cursor') || '';
    if (cursor) options.cursor = cursor;
    const directoryStarted = timing.start();
    const snapshot = (publicDirectoryState || publicState)(req, options);
    timing.mark('directory', directoryStarted);
    sendJson(res, 200, snapshot, timing.headers());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/members/directory') {
    const timing = createServerTiming();
    const options = {};
    const page = url.searchParams.get('page') || '';
    if (page) options.page = page;
    const pageSize = url.searchParams.get('pageSize') || '';
    if (pageSize) options.pageSize = pageSize;
    const query = url.searchParams.get('q') || url.searchParams.get('query') || '';
    if (query) options.query = query;
    const membersStarted = timing.start();
    const snapshot = (publicMembersDirectoryState || publicState)(req, options);
    timing.mark('members', membersStarted);
    sendJson(res, 200, snapshot, timing.headers());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/package-versions') {
    const snapshot = typeof packageVersionSnapshot === 'function'
      ? await packageVersionSnapshot({ force: url.searchParams.get('refresh') === '1' })
      : { ok: true, cacheTtlMs: 0, packages: {} };
    sendJson(res, 200, snapshot);
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/package-updates') {
    const packageName = String(url.searchParams.get('packageName') || '').trim();
    if (!packageName) {
      sendError(res, 400, 'packageName is required.');
      return true;
    }
    const snapshot = typeof packageUpdateSnapshot === 'function'
      ? await packageUpdateSnapshot({
        packageName,
        currentVersion: String(url.searchParams.get('currentVersion') || '').trim(),
        force: url.searchParams.get('refresh') === '1',
      })
      : {
        ok: true,
        package: {
          name: packageName,
          packageName,
          currentVersion: String(url.searchParams.get('currentVersion') || '').trim(),
          latestVersion: String(url.searchParams.get('currentVersion') || '').trim(),
          updateAvailable: false,
          updateMode: 'manual',
          cacheTtlSeconds: 0,
        },
        releaseNotesMarkdown: '',
        releaseNotes: { releases: [] },
      };
    sendJson(res, snapshot.ok === false ? 400 : 200, snapshot);
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/runtime') {
    if (!requireSystemRole(['admin'])) return true;
    sendJson(res, 200, await getRuntimeInfo());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/runtimes') {
    if (!requireSystemRole(['admin'])) return true;
    sendJson(res, 200, { runtimes: await detectInstalledRuntimes() });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    const timing = createServerTiming();
    if (typeof isDraining === 'function' && isDraining()) {
      sendJson(res, 503, { ok: false, draining: true }, timing.headers());
      return true;
    }
    res.magclawRequest = req;
    const scopeStarted = timing.start();
    if (!req.magclawPresenceWorkspaceId) {
      const actor = typeof cloudAuth?.currentActor === 'function' ? cloudAuth.currentActor(req) : null;
      req.magclawPresenceWorkspaceId = String(
        actor?.member?.workspaceId
        || state.connection?.workspaceId
        || state.cloud?.workspace?.id
        || '',
      ).trim();
    }
    const selectedHumanId = String(url.searchParams.get('selectedHumanId') || '').trim();
    req.magclawPresenceDetailHumanIds = selectedHumanId ? [selectedHumanId] : [];
    timing.mark('scope', scopeStarted);
    const replayPackets = [];
    const lastSeq = Number(url.searchParams.get('lastSeq') || 0);
    const replayStarted = timing.start();
    if (lastSeq > 0 && typeof realtimeEventsForRequest === 'function') {
      const replay = realtimeEventsForRequest(req, lastSeq);
      if (replay.gap) {
        replayPackets.push(`event: state-resync-required\ndata: ${JSON.stringify({
          type: 'state_resync_required',
          seq: replay.currentSeq,
          lastSeq,
          minSeq: replay.minSeq,
          currentSeq: replay.currentSeq,
          createdAt: new Date().toISOString(),
        })}\n\n`);
      } else {
        for (const event of replay.events) {
          replayPackets.push(`event: realtime-event\ndata: ${JSON.stringify(event)}\n\n`);
        }
      }
    }
    timing.mark('replay', replayStarted);
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...timing.headers(),
    });
    for (const packet of replayPackets) res.write(packet);
    const deferPresence = url.searchParams.get('presence') === 'defer';
    if (typeof writePresenceHeartbeat === 'function') {
      writePresenceHeartbeat(res, req, deferPresence ? { seedOnly: true } : { force: true });
    } else {
      res.write(`event: heartbeat\ndata: ${JSON.stringify(presenceHeartbeat(req))}\n\n`);
    }
    sseClients.add(res);
    const cleanup = () => sseClients.delete(res);
    req.on('close', cleanup);
    req.on('error', cleanup);
    res.on('close', cleanup);
    res.on('error', (error) => {
      cleanup();
      if (expectedStreamClose(error)) return;
      const code = String(error?.code || error?.errno || 'UNKNOWN');
      const message = String(error?.message || error || 'SSE stream error').replace(/\s+/g, ' ').slice(0, 300);
      console.warn(`[system-api] sse stream error code=${code} message=${message}`);
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/settings') {
    if (!requireSystemRole(['admin'])) return true;
    const body = await readJson(req);
    state.settings = {
      ...state.settings,
      codexPath: String(body.codexPath || state.settings.codexPath || 'codex'),
      defaultWorkspace: path.resolve(String(body.defaultWorkspace || state.settings.defaultWorkspace || defaultWorkspace)),
      model: String(body.model || ''),
      sandbox: ['read-only', 'workspace-write', 'danger-full-access'].includes(body.sandbox)
        ? body.sandbox
        : state.settings.sandbox,
    };
    addSystemEvent('settings_updated', 'Runtime settings updated.');
    await persistState();
    broadcastState();
    sendJson(res, 200, publicState(req));
    return true;
  }

  if (['POST', 'PATCH'].includes(req.method) && url.pathname === '/api/settings/fanout') {
    if (!requireSystemRole(['admin'])) return true;
    const body = await readJson(req);
    const workspace = cloudAuth?.primaryWorkspace?.() || null;
    const fanoutApi = updateFanoutApiConfig(body, workspace);
    addSystemEvent('fanout_api_settings_updated', 'Fan-out API settings updated.', {
      configured: fanoutApiConfigured(),
      workspaceId: workspace?.id || null,
      baseUrl: fanoutApi.baseUrl,
      model: fanoutApi.model,
      fallbackModel: fanoutApi.fallbackModel,
      timeoutMs: fanoutApi.timeoutMs,
      hasApiKey: Boolean(fanoutApi.apiKey),
    });
    if (cloudAuth?.persistCloudState) {
      await cloudAuth.persistCloudState();
    } else {
      await persistState();
    }
    broadcastState();
    sendJson(res, 200, publicState(req));
    return true;
  }

  return false;
}
