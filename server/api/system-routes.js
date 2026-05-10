import path from 'node:path';

// System-level API routes.
// This group handles public state snapshots, SSE, runtime discovery, global
// settings, and Fan-out API settings. Keeping these routes together makes the
// main dispatcher easier to scan before deeper Agent/task routing begins.

export async function handleSystemApi(req, res, url, deps) {
  const {
    addSystemEvent,
    broadcastState,
    cloudAuth,
    deploymentHealth,
    defaultWorkspace,
    detectInstalledRuntimes,
    fanoutApiConfigured,
    getRuntimeInfo,
    getState,
    persistState,
    presenceHeartbeat,
    publicState,
    readJson,
    sendError,
    sendJson,
    sseClients,
    updateFanoutApiConfig,
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

  if (req.method === 'GET' && url.pathname === '/api/state') {
    sendJson(res, 200, publicState(req));
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/runtime') {
    sendJson(res, 200, await getRuntimeInfo());
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/runtimes') {
    sendJson(res, 200, { runtimes: await detectInstalledRuntimes() });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.magclawRequest = req;
    res.write(`event: state\ndata: ${JSON.stringify(publicState(req))}\n\n`);
    res.write(`event: heartbeat\ndata: ${JSON.stringify(presenceHeartbeat())}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
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
