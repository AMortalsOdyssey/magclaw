import os from 'node:os';

// Cloud connection and sync API routes.
// Pairing, import/export, and manual push/pull live here so the main server
// does not mix deployment transport concerns with chat, task, or Agent runtime
// routes. State mutation remains explicit through the injected dependencies.

export async function handleCloudApi(req, res, url, deps) {
  const {
    addSystemEvent,
    applyCloudSnapshot,
    broadcastState,
    cloudFetch,
    cloudSnapshot,
    dataDir,
    getState,
    host,
    normalizeCloudUrl,
    now,
    persistState,
    port,
    protocolVersion,
    publicConnection,
    pullStateFromCloud,
    pushStateToCloud,
    readJson,
    requireCloudAccess,
    sendError,
    sendJson,
  } = deps;
  const state = getState();

  if (req.method === 'GET' && url.pathname === '/api/cloud/health') {
    if (!requireCloudAccess(req, res)) return true;
    sendJson(res, 200, {
      ok: true,
      name: 'Magclaw Control Plane',
      deployment: state.connection?.deployment || 'local',
      protocolVersion,
      workspaceId: url.searchParams.get('workspaceId') || state.connection?.workspaceId || 'local',
      time: now(),
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/cloud/status') {
    sendJson(res, 200, {
      connection: publicConnection(),
      health: {
        localUrl: `http://${host}:${port}`,
        dataDir,
        protocolVersion,
      },
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/config') {
    const body = await readJson(req);
    const previousMode = state.connection.mode;
    state.connection = {
      ...state.connection,
      mode: body.mode === 'cloud' ? 'cloud' : 'local',
      deployment: body.deployment ? String(body.deployment) : state.connection.deployment,
      controlPlaneUrl: normalizeCloudUrl(body.controlPlaneUrl ?? state.connection.controlPlaneUrl),
      relayUrl: normalizeCloudUrl(body.relayUrl ?? state.connection.relayUrl),
      cloudToken: body.cloudToken !== undefined ? String(body.cloudToken || '').trim() : state.connection.cloudToken,
      workspaceId: String(body.workspaceId || state.connection.workspaceId || 'local'),
      deviceName: String(body.deviceName || state.connection.deviceName || os.hostname()),
      autoSync: Boolean(body.autoSync),
      protocolVersion,
    };
    if (state.connection.mode === 'local') {
      state.connection.pairingStatus = 'local';
    } else if (previousMode !== 'cloud' && state.connection.pairingStatus === 'local') {
      state.connection.pairingStatus = 'configured';
    }
    addSystemEvent('cloud_configured', `Connection mode set to ${state.connection.mode}.`);
    await persistState();
    broadcastState();
    sendJson(res, 200, { connection: publicConnection() });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/pair') {
    const body = await readJson(req);
    if (body.controlPlaneUrl !== undefined) state.connection.controlPlaneUrl = normalizeCloudUrl(body.controlPlaneUrl);
    if (body.relayUrl !== undefined) state.connection.relayUrl = normalizeCloudUrl(body.relayUrl);
    if (body.cloudToken !== undefined) state.connection.cloudToken = String(body.cloudToken || '').trim();
    if (body.workspaceId !== undefined) state.connection.workspaceId = String(body.workspaceId || 'local');
    if (body.deviceName !== undefined) state.connection.deviceName = String(body.deviceName || os.hostname());
    state.connection.mode = 'cloud';
    state.connection.pairingStatus = 'pairing';
    await persistState();

    try {
      const health = await cloudFetch(`/api/cloud/health?workspaceId=${encodeURIComponent(state.connection.workspaceId || 'local')}`);
      state.connection.pairingStatus = 'paired';
      state.connection.pairedAt = now();
      state.connection.lastError = '';
      addSystemEvent('cloud_paired', `Paired with ${state.connection.controlPlaneUrl}.`, { health });
      await persistState();
      broadcastState();
      sendJson(res, 200, { connection: publicConnection(), health });
    } catch (error) {
      state.connection.pairingStatus = 'configured';
      state.connection.lastError = error.message;
      await persistState();
      broadcastState();
      sendError(res, 502, error.message);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/disconnect') {
    state.connection.mode = 'local';
    state.connection.pairingStatus = 'local';
    state.connection.pairedAt = null;
    state.connection.lastSyncAt = null;
    state.connection.lastSyncDirection = null;
    state.connection.lastError = '';
    state.connection.autoSync = false;
    addSystemEvent('cloud_disconnected', 'Switched back to local-only mode.');
    await persistState();
    broadcastState();
    sendJson(res, 200, { connection: publicConnection() });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/cloud/export-state') {
    if (!requireCloudAccess(req, res)) return true;
    sendJson(res, 200, { snapshot: cloudSnapshot() });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/import-state') {
    if (!requireCloudAccess(req, res)) return true;
    const body = await readJson(req);
    const snapshot = body.snapshot || body;
    applyCloudSnapshot(snapshot);
    state.connection.lastSyncAt = now();
    state.connection.lastSyncDirection = 'import';
    state.connection.lastError = '';
    addSystemEvent('cloud_imported', `Cloud snapshot imported${body.reason ? ` (${body.reason})` : ''}.`);
    await persistState();
    broadcastState();
    sendJson(res, 200, { ok: true, importedAt: state.connection.lastSyncAt });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/sync/push') {
    const result = await pushStateToCloud('manual_push');
    broadcastState();
    sendJson(res, 200, { ok: true, result, connection: publicConnection() });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/cloud/sync/pull') {
    const result = await pullStateFromCloud();
    broadcastState();
    sendJson(res, 200, { ok: true, result, connection: publicConnection() });
    return true;
  }

  return false;
}
