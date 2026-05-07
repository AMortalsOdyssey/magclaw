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

function normalizeNotificationPrefs(value = {}) {
  return {
    enabled: Boolean(value.enabled),
    dismissedPrompt: Boolean(value.dismissedPrompt),
    enabledAt: value.enabledAt || null,
    dismissedAt: value.dismissedAt || null,
  };
}

function readStoredUiState() {
  const parsed = readJsonStorage(UI_STATE_KEY, {});
  const validSpaceType = ['channel', 'dm'].includes(parsed.selectedSpaceType) ? parsed.selectedSpaceType : 'channel';
  const rawView = String(parsed.activeView || '');
  const validView = rawView === 'system-notifications'
    ? 'inbox'
    : ['space', 'members', 'tasks', 'inbox', 'threads', 'saved', 'search', 'missions', 'cloud', 'computers'].includes(rawView)
      ? rawView
    : 'space';
  const validTab = ['chat', 'tasks'].includes(parsed.activeTab) ? parsed.activeTab : 'chat';
  const validRailTab = ['spaces', 'members', 'computers', 'settings'].includes(parsed.railTab) ? parsed.railTab : '';
  const validSettingsTab = ['account', 'browser', 'server', 'system', 'members', 'release'].includes(parsed.settingsTab) ? parsed.settingsTab : 'account';
  return {
    selectedSpaceType: validSpaceType,
    selectedSpaceId: String(parsed.selectedSpaceId || ''),
    activeView: validView,
    activeTab: validTab,
    railTab: validRailTab,
    settingsTab: validSettingsTab,
    threadMessageId: parsed.threadMessageId ? String(parsed.threadMessageId) : null,
    selectedAgentId: parsed.selectedAgentId ? String(parsed.selectedAgentId) : null,
    membersLayout: normalizeMembersLayout(parsed.membersLayout),
  };
}

function normalizeMembersLayout(value = {}) {
  const mode = MEMBERS_LAYOUT_MODES.has(value?.mode) ? value.mode : 'channel';
  const agentId = value?.agentId ? String(value.agentId) : null;
  if ((mode === 'agent' || mode === 'split') && agentId) return { mode, agentId };
  return { mode: 'channel', agentId: null };
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
