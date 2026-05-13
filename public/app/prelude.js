function readJsonStorage(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || 'null');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Browser storage can be disabled; keep the live UI working without persistence.
  }
}

function workspaceActivityCacheScope() {
  const pathSlug = String(window.location.pathname || '').match(/^\/s\/([^/]+)/)?.[1] || '';
  const workspaceId = String(appState?.connection?.workspaceId || appState?.cloud?.workspaces?.[0]?.id || '').trim();
  const workspaceKey = workspaceId && !(workspaceId === 'local' && pathSlug) ? workspaceId : '';
  const serverKey = workspaceKey || pathSlug || 'local';
  const scope = [window.location.host, serverKey].filter(Boolean).join(':') || 'local';
  return encodeURIComponent(scope);
}

function workspaceActivityCacheStorageKey() {
  const baseKey = typeof WORKSPACE_ACTIVITY_CACHE_KEY === 'string'
    ? WORKSPACE_ACTIVITY_CACHE_KEY
    : 'magclawWorkspaceActivityCache';
  return `${baseKey}:${workspaceActivityCacheScope()}`;
}

function workspaceActivityReadStorageKey(humanId = '') {
  const baseKey = typeof WORKSPACE_ACTIVITY_READ_KEY === 'string'
    ? WORKSPACE_ACTIVITY_READ_KEY
    : 'magclawWorkspaceActivityReadAt';
  return `${baseKey}:${workspaceActivityCacheScope()}:${encodeURIComponent(String(humanId || 'local'))}`;
}

function workspaceActivityCacheLimit() {
  const limit = Number(typeof WORKSPACE_ACTIVITY_CACHE_LIMIT === 'number' ? WORKSPACE_ACTIVITY_CACHE_LIMIT : 300);
  return Number.isFinite(limit) && limit > 0 ? limit : 300;
}

function normalizeWorkspaceActivityCacheRecord(record = {}) {
  if (!record || typeof record !== 'object') return null;
  const id = String(record.id || '').trim();
  const parsedCreatedAt = Date.parse(record.createdAt || '');
  if (!id || !Number.isFinite(parsedCreatedAt)) return null;
  return {
    id,
    source: String(record.source || 'event').slice(0, 40),
    kind: String(record.kind || 'system').slice(0, 40),
    type: String(record.type || 'activity').slice(0, 120),
    title: String(record.title || record.type || 'Workspace activity').slice(0, 300),
    detail: String(record.detail || '').slice(0, 600),
    createdAt: new Date(parsedCreatedAt).toISOString(),
  };
}

function readWorkspaceActivityCache() {
  const parsed = readJsonStorage(workspaceActivityCacheStorageKey(), {});
  const records = Array.isArray(parsed) ? parsed : parsed.records;
  return (Array.isArray(records) ? records : [])
    .map(normalizeWorkspaceActivityCacheRecord)
    .filter(Boolean)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
}

function writeWorkspaceActivityCache(records = []) {
  const byId = new Map();
  for (const record of records) {
    const normalized = normalizeWorkspaceActivityCacheRecord(record);
    if (normalized) byId.set(normalized.id, normalized);
  }
  const limited = [...byId.values()]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(-workspaceActivityCacheLimit());
  writeJsonStorage(workspaceActivityCacheStorageKey(), {
    version: 1,
    updatedAt: new Date().toISOString(),
    records: limited,
  });
  return limited;
}

function mergeWorkspaceActivityCache(records = []) {
  const cached = readWorkspaceActivityCache();
  const byId = new Map(cached.map((record) => [record.id, record]));
  let changed = false;
  for (const record of records) {
    const normalized = normalizeWorkspaceActivityCacheRecord(record);
    if (!normalized) continue;
    const previous = byId.get(normalized.id);
    if (!previous || JSON.stringify(previous) !== JSON.stringify(normalized)) {
      byId.set(normalized.id, normalized);
      changed = true;
    }
  }
  const merged = [...byId.values()]
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(-workspaceActivityCacheLimit());
  if (changed || merged.length !== cached.length) {
    return writeWorkspaceActivityCache(merged);
  }
  return merged;
}

function readStoredWorkspaceActivityReadAt(humanId = '') {
  try {
    const value = localStorage.getItem(workspaceActivityReadStorageKey(humanId)) || '';
    return Number.isFinite(Date.parse(value)) ? value : '';
  } catch {
    return '';
  }
}

function writeStoredWorkspaceActivityReadAt(humanId = '', value = '') {
  const parsed = Date.parse(value || '');
  if (!Number.isFinite(parsed)) return false;
  try {
    localStorage.setItem(workspaceActivityReadStorageKey(humanId), new Date(parsed).toISOString());
    return true;
  } catch {
    return false;
  }
}

function normalizeNotificationPrefs(value = {}) {
  const mutedServerSlugs = Array.isArray(value.mutedServerSlugs)
    ? value.mutedServerSlugs.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean)
    : [];
  return {
    enabled: Boolean(value.enabled),
    dismissedPrompt: Boolean(value.dismissedPrompt),
    enabledAt: value.enabledAt || null,
    dismissedAt: value.dismissedAt || null,
    mutedServerSlugs,
  };
}

function readStoredUiState() {
  const parsed = readJsonStorage(UI_STATE_KEY, {});
  const validSpaceType = ['channel', 'dm'].includes(parsed.selectedSpaceType) ? parsed.selectedSpaceType : 'channel';
  const rawView = String(parsed.activeView || '');
  const validView = rawView === 'system-notifications'
    ? 'inbox'
    : ['space', 'members', 'tasks', 'inbox', 'threads', 'saved', 'search', 'missions', 'cloud', 'computers', 'console'].includes(rawView)
      ? rawView
    : 'space';
  const validTab = ['chat', 'tasks'].includes(parsed.activeTab) ? parsed.activeTab : 'chat';
  const validRailTab = ['spaces', 'members', 'computers', 'settings'].includes(parsed.railTab) ? parsed.railTab : '';
  const validSettingsTab = ['account', 'browser', 'server', 'members', 'lost-space', 'language', 'release'].includes(parsed.settingsTab) ? parsed.settingsTab : 'account';
  const validConsoleTab = ['overview', 'invitations', 'servers', 'lost-space'].includes(parsed.consoleTab) ? parsed.consoleTab : 'overview';
  return {
    selectedSpaceType: validSpaceType,
    selectedSpaceId: String(parsed.selectedSpaceId || ''),
    activeView: validView,
    activeTab: validTab,
    railTab: validRailTab,
    settingsTab: validSettingsTab,
    consoleTab: validConsoleTab,
    threadMessageId: parsed.threadMessageId ? String(parsed.threadMessageId) : null,
    selectedAgentId: parsed.selectedAgentId ? String(parsed.selectedAgentId) : null,
    selectedHumanId: parsed.selectedHumanId ? String(parsed.selectedHumanId) : null,
    selectedComputerId: parsed.selectedComputerId ? String(parsed.selectedComputerId) : null,
    membersLayout: normalizeMembersLayout(parsed.membersLayout),
  };
}

function normalizeMembersLayout(value = {}) {
  const mode = MEMBERS_LAYOUT_MODES.has(value?.mode) ? value.mode : 'channel';
  const agentId = value?.agentId ? String(value.agentId) : null;
  const humanId = value?.humanId ? String(value.humanId) : null;
  if ((mode === 'agent' || mode === 'split') && agentId) return { mode, agentId };
  if (mode === 'human' && humanId) return { mode, agentId: null, humanId };
  if (mode === 'directory') return { mode: 'directory', agentId: null, humanId: null };
  return { mode: 'channel', agentId: null, humanId: null };
}

function readStoredPaneScrolls() {
  const parsed = readJsonStorage(PANE_SCROLL_KEY, {});
  return Object.fromEntries(Object.entries(parsed)
    .map(([key, value]) => {
      const normalized = normalizeStoredPaneScroll(value);
      return normalized ? [key, normalized] : null;
    })
    .filter(Boolean));
}

function normalizeStoredPaneScroll(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    return {
      top: value,
      atBottom: value <= BOTTOM_THRESHOLD,
      legacy: true,
    };
  }
  if (!value || typeof value !== 'object') return null;
  const top = Number(value.top);
  if (!Number.isFinite(top) || top < 0) return null;
  return {
    top,
    atBottom: Boolean(value.atBottom),
    scrollHeight: Number.isFinite(Number(value.scrollHeight)) ? Number(value.scrollHeight) : null,
    clientHeight: Number.isFinite(Number(value.clientHeight)) ? Number(value.clientHeight) : null,
    updatedAt: value.updatedAt || null,
  };
}

function readCollapsedTaskColumns() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TASK_COLUMN_COLLAPSE_KEY) || '{}');
    if (parsed && typeof parsed === 'object') {
      return { ...DEFAULT_COLLAPSED_TASK_COLUMNS, ...parsed };
    }
    return { ...DEFAULT_COLLAPSED_TASK_COLUMNS };
  } catch {
    return { ...DEFAULT_COLLAPSED_TASK_COLUMNS };
  }
}

function readStoredInspectorWidth() {
  const raw = localStorage.getItem(INSPECTOR_WIDTH_KEY);
  if (raw === null) return 360;
  const saved = Number(raw);
  if (!Number.isFinite(saved)) return 360;
  return Math.min(INSPECTOR_MAX_WIDTH, Math.max(INSPECTOR_MIN_WIDTH, saved));
}

function readStoredRailWidth() {
  const raw = localStorage.getItem(RAIL_WIDTH_KEY);
  if (raw === null) return 236;
  const saved = Number(raw);
  if (!Number.isFinite(saved)) return 236;
  return Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, saved));
}
