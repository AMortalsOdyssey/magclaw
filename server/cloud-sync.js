import { normalizeCloudUrl } from './runtime-config.js';

// Cloud sync helpers.
// The local server stays authoritative, and this module handles optional
// snapshot import/export when a deployment is paired to a control plane.
export function createCloudSync(deps) {
  const {
    getState,
    migrateState,
    now,
    persistState,
    CLOUD_PROTOCOL_VERSION,
  } = deps;
  let cloudPushTimer = null;
  let syncInProgress = false;
  const state = new Proxy({}, {
    get(_target, prop) { return getState()[prop]; },
    set(_target, prop, value) { getState()[prop] = value; return true; },
  });

  const SNAPSHOT_ARRAY_KEYS = Object.freeze([
    'humans',
    'computers',
    'agents',
    'channels',
    'dms',
    'messages',
    'replies',
    'tasks',
    'reminders',
    'missions',
    'runs',
    'attachments',
    'projects',
    'workItems',
  ]);

  function cloudSnapshot() {
    const snapshot = {
      version: state.version,
      exportedAt: now(),
      workspaceId: state.connection?.workspaceId || 'local',
      protocolVersion: CLOUD_PROTOCOL_VERSION,
      router: state.router || {},
    };
    for (const key of SNAPSHOT_ARRAY_KEYS) {
      snapshot[key] = Array.isArray(state[key]) ? state[key] : [];
    }
    return snapshot;
  }
  
  function applyCloudSnapshot(snapshot) {
    for (const key of SNAPSHOT_ARRAY_KEYS) {
      if (Array.isArray(snapshot?.[key])) state[key] = snapshot[key];
    }
    if (snapshot?.router && typeof snapshot.router === 'object') state.router = snapshot.router;
    migrateState();
  }
  
  function cloudEndpoint(pathname) {
    const base = normalizeCloudUrl(state.connection?.controlPlaneUrl || '');
    if (!base) throw new Error('Cloud control plane URL is not configured.');
    return `${base}${pathname}`;
  }
  
  async function cloudFetch(pathname, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    const cloudToken = String(state.connection?.cloudToken || process.env.MAGCLAW_CLOUD_TOKEN || '');
    const headers = {
      'content-type': 'application/json',
      'x-magclaw-device-id': state.connection?.deviceId || '',
      'x-magclaw-workspace-id': state.connection?.workspaceId || '',
      ...(cloudToken ? { authorization: `Bearer ${cloudToken}` } : {}),
      ...(options.headers || {}),
    };
    try {
      const response = await fetch(cloudEndpoint(pathname), {
        ...options,
        signal: controller.signal,
        headers,
      });
      const text = await response.text();
      const data = text ? JSON.parse(text) : {};
      if (!response.ok) throw new Error(data.error || response.statusText);
      return data;
    } finally {
      clearTimeout(timeout);
    }
  }
  
  async function pushStateToCloud(reason = 'manual') {
    if (!state.connection?.controlPlaneUrl) throw new Error('Cloud control plane URL is not configured.');
    syncInProgress = true;
    try {
      const result = await cloudFetch('/api/cloud/import-state', {
        method: 'POST',
        body: JSON.stringify({
          workspaceId: state.connection.workspaceId || 'local',
          deviceId: state.connection.deviceId,
          reason,
          snapshot: cloudSnapshot(),
        }),
      });
      state.connection.lastSyncAt = now();
      state.connection.lastSyncDirection = 'push';
      state.connection.lastError = '';
      await persistState();
      return result;
    } catch (error) {
      state.connection.lastError = error.message;
      await persistState();
      throw error;
    } finally {
      syncInProgress = false;
    }
  }
  
  async function pullStateFromCloud() {
    if (!state.connection?.controlPlaneUrl) throw new Error('Cloud control plane URL is not configured.');
    syncInProgress = true;
    try {
      const result = await cloudFetch(`/api/cloud/export-state?workspaceId=${encodeURIComponent(state.connection.workspaceId || 'local')}`);
      applyCloudSnapshot(result.snapshot || result);
      state.connection.lastSyncAt = now();
      state.connection.lastSyncDirection = 'pull';
      state.connection.lastError = '';
      await persistState();
      return result;
    } catch (error) {
      state.connection.lastError = error.message;
      await persistState();
      throw error;
    } finally {
      syncInProgress = false;
    }
  }
  
  function queueCloudPush(reason) {
    if (syncInProgress) return;
    if (state?.connection?.mode !== 'cloud') return;
    if (!state.connection.autoSync) return;
    if (!state.connection.controlPlaneUrl) return;
    if (!['paired', 'connected'].includes(state.connection.pairingStatus)) return;
    clearTimeout(cloudPushTimer);
    cloudPushTimer = setTimeout(() => {
      pushStateToCloud(reason).catch(() => {});
    }, 900);
  }

  return {
    applyCloudSnapshot,
    cloudFetch,
    cloudSnapshot,
    pullStateFromCloud,
    pushStateToCloud,
    queueCloudPush,
  };
}
