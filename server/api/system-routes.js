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
    publicBootstrapState,
    publicState,
    readJson,
    sendError,
    sendJson,
    realtimeEventsForRequest,
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

  if (req.method === 'POST' && url.pathname === '/api/internal/drain') {
    const remoteAddress = String(req.socket?.remoteAddress || '');
    const forwardedFor = String(req.headers?.['x-forwarded-for'] || '').trim();
    const loopback = !forwardedFor && (
      remoteAddress === '127.0.0.1'
      || remoteAddress === '::1'
      || remoteAddress === '::ffff:127.0.0.1'
      || remoteAddress === ''
    );
    if (!loopback) {
      sendError(res, 403, 'Drain endpoint is only available from loopback.');
      return true;
    }
    const result = typeof beginDrain === 'function'
      ? beginDrain('internal_api')
      : { ok: false, draining: false };
    sendJson(res, result.ok ? 200 : 500, result);
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
    const hydration = typeof hydrateBootstrapWindow === 'function'
      ? await hydrateBootstrapWindow(req, options)
      : null;
    if (hydration) req.magclawBootstrapHydration = hydration;
    const bootstrapOptions = hydration ? { ...options, hydration } : options;
    sendJson(res, 200, (publicBootstrapState || publicState)(req, bootstrapOptions));
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
    const streamOptions = {
      spaceType: url.searchParams.get('spaceType') || '',
      spaceId: url.searchParams.get('spaceId') || '',
      threadMessageId: url.searchParams.get('threadMessageId') || '',
      messageLimit: url.searchParams.get('messageLimit') || '',
      threadRootLimit: url.searchParams.get('threadRootLimit') || '',
      eventLimit: url.searchParams.get('eventLimit') || '',
    };
    if (typeof hydrateBootstrapWindow === 'function') {
      req.magclawBootstrapHydration = await hydrateBootstrapWindow(req, streamOptions);
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.magclawRequest = req;
    const lastSeq = Number(url.searchParams.get('lastSeq') || 0);
    if (lastSeq > 0 && typeof realtimeEventsForRequest === 'function') {
      const replay = realtimeEventsForRequest(req, lastSeq);
      if (replay.gap) {
        res.write(`event: state-resync-required\ndata: ${JSON.stringify({
          type: 'state_resync_required',
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
