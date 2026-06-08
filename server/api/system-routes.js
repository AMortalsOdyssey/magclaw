import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';

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
    const ready = typeof deploymentHealth === 'function'
      ? await deploymentHealth()
      : { ok: true };
    sendJson(res, ready.ok ? 200 : 503, ready);
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
    const hydration = typeof hydrateBootstrapWindow === 'function'
      ? await hydrateBootstrapWindow(req, options)
      : null;
    if (hydration) req.magclawBootstrapHydration = hydration;
    const bootstrapOptions = hydration ? { ...options, hydration } : options;
    sendJson(res, 200, (publicBootstrapState || publicState)(req, bootstrapOptions));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/directory') {
    const options = {};
    const directoryFormat = url.searchParams.get('directoryFormat') || '';
    if (directoryFormat) options.directoryFormat = directoryFormat;
    sendJson(res, 200, (publicDirectoryState || publicState)(req, options));
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
    if (typeof isDraining === 'function' && isDraining()) {
      sendJson(res, 503, { ok: false, draining: true });
      return true;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.magclawRequest = req;
    if (!req.magclawPresenceWorkspaceId) {
      const actor = typeof cloudAuth?.currentActor === 'function' ? cloudAuth.currentActor(req) : null;
      req.magclawPresenceWorkspaceId = String(
        actor?.member?.workspaceId
        || state.connection?.workspaceId
        || state.cloud?.workspace?.id
        || '',
      ).trim();
    }
    const lastSeq = Number(url.searchParams.get('lastSeq') || 0);
    if (lastSeq > 0 && typeof realtimeEventsForRequest === 'function') {
      const replay = realtimeEventsForRequest(req, lastSeq);
      if (replay.gap) {
        res.write(`event: state-resync-required\ndata: ${JSON.stringify({
          type: 'state_resync_required',
          seq: replay.currentSeq,
          lastSeq,
          minSeq: replay.minSeq,
          currentSeq: replay.currentSeq,
          createdAt: new Date().toISOString(),
        })}\n\n`);
      } else {
        for (const event of replay.events) {
          res.write(`event: realtime-event\ndata: ${JSON.stringify(event)}\n\n`);
        }
      }
    }
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
