import path from 'node:path';

// System-level API routes.
// This group handles public state snapshots, SSE, runtime discovery, global
// settings, and Fan-out API settings. Keeping these routes together makes the
// main dispatcher easier to scan before deeper Agent/task routing begins.

function expectedStreamClose(error) {
  const code = String(error?.code || error?.errno || '');
  return code === 'ECONNRESET' || code === 'EPIPE' || code === 'ERR_STREAM_PREMATURE_CLOSE';
}

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
    publicBootstrapState,
    publicState,
    readJson,
    sendError,
    sendJson,
    stateDeltaEnvelope,
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

  if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
    const options = {
      spaceType: url.searchParams.get('spaceType') || '',
      spaceId: url.searchParams.get('spaceId') || '',
      threadMessageId: url.searchParams.get('threadMessageId') || '',
      messageLimit: url.searchParams.get('messageLimit') || '',
      threadRootLimit: url.searchParams.get('threadRootLimit') || '',
      eventLimit: url.searchParams.get('eventLimit') || '',
    };
    sendJson(res, 200, (publicBootstrapState || publicState)(req, options));
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
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.magclawRequest = req;
    const initialPayload = typeof stateDeltaEnvelope === 'function'
      ? stateDeltaEnvelope(req)
      : { seq: 0, type: 'state_patch', payload: (publicBootstrapState || publicState)(req) };
    res.write(`event: state-delta\ndata: ${JSON.stringify(initialPayload)}\n\n`);
    res.write(`event: heartbeat\ndata: ${JSON.stringify(presenceHeartbeat())}\n\n`);
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
