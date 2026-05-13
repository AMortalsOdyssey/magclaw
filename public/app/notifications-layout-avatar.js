

function saveNotificationPrefs(nextPrefs = notificationPrefs) {
  notificationPrefs = normalizeNotificationPrefs(nextPrefs);
  writeJsonStorage(NOTIFICATION_PREF_KEY, notificationPrefs);
}

function notificationApiSupported() {
  return 'Notification' in window;
}

function browserNotificationPermission() {
  if (!notificationApiSupported()) return 'unsupported';
  return Notification.permission || 'default';
}

function notificationServerKey() {
  return String(currentServerSlug() || currentServerProfile()?.slug || currentServerProfile()?.id || '').trim().toLowerCase();
}

function serverNotificationsMuted() {
  const key = notificationServerKey();
  return Boolean(key && (notificationPrefs.mutedServerSlugs || []).includes(key));
}

function toggleServerNotificationsMuted() {
  const key = notificationServerKey();
  if (!key) return;
  const muted = new Set(notificationPrefs.mutedServerSlugs || []);
  if (muted.has(key)) {
    muted.delete(key);
    toast('Server notifications unmuted');
  } else {
    muted.add(key);
    toast('Server notifications muted');
  }
  saveNotificationPrefs({
    ...notificationPrefs,
    mutedServerSlugs: [...muted],
  });
  render();
}

function agentNotificationsEnabled() {
  return notificationPrefs.enabled && browserNotificationPermission() === 'granted' && !serverNotificationsMuted();
}

function notificationPromptVisible() {
  return notificationApiSupported()
    && browserNotificationPermission() === 'default'
    && !notificationPrefs.enabled
    && !notificationPrefs.dismissedPrompt;
}

function notificationStatusLabel() {
  const permission = browserNotificationPermission();
  if (permission === 'unsupported') return 'Unsupported';
  if (permission === 'denied') return 'Blocked';
  if (serverNotificationsMuted()) return 'Muted';
  if (permission === 'granted' && notificationPrefs.enabled) return 'On';
  if (permission === 'granted') return 'Off';
  return 'Ask first';
}

function notificationStatusDetail() {
  const permission = browserNotificationPermission();
  if (permission === 'unsupported') return 'This browser does not expose desktop notifications.';
  if (permission === 'denied') return 'Notifications are blocked in the browser site settings.';
  if (serverNotificationsMuted()) return 'This server is muted for this browser.';
  if (permission === 'granted' && notificationPrefs.enabled) return 'Agent replies will notify you while Magclaw is in the background.';
  if (permission === 'granted') return 'Browser permission is granted; app notifications are currently off.';
  return 'Chrome will ask for permission before turning this on.';
}

function notificationBellIcon(size = 16) {
  return `<svg class="notification-bell-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>`;
}

function renderNotificationPromptBanner() {
  if (!notificationPromptVisible()) return '';
  return `
    <section class="notification-banner" aria-label="Enable agent notifications">
      <div class="notification-banner-copy">
        ${notificationBellIcon(18)}
        <strong>Enable agent notifications</strong>
        <span>Get agent replies while Magclaw is in the background.</span>
      </div>
      <div class="notification-banner-actions">
        <button class="primary-btn" type="button" data-action="enable-agent-notifications">Enable Notifications</button>
        <button class="secondary-btn" type="button" data-action="dismiss-agent-notifications">Not Now</button>
      </div>
    </section>
  `;
}

function renderNotificationConfigCard() {
  const permission = browserNotificationPermission();
  const globallyEnabled = notificationPrefs.enabled && permission === 'granted';
  const muted = serverNotificationsMuted();
  const canEnable = permission === 'default' || permission === 'granted';
  const serverName = currentServerProfile()?.name || currentServerSlug() || 'this server';
  return `
    <div class="pixel-panel cloud-card notification-config-card">
      <div class="panel-title"><span>Push Notifications</span><span>${escapeHtml(notificationStatusLabel())}</span></div>
      <div class="notification-card-body">
        <div class="notification-card-icon">${notificationBellIcon(20)}</div>
        <div>
          <strong>${globallyEnabled ? 'Browser notifications are on' : 'Browser notifications are off'}</strong>
          <p>${escapeHtml(notificationStatusDetail())}</p>
          <small>Delivered for DMs, direct mentions, and followed thread replies while this tab is in the background.</small>
        </div>
      </div>
      <div class="notification-card-actions">
        ${globallyEnabled
          ? '<button class="secondary-btn" type="button" data-action="disable-agent-notifications">Turn Off</button>'
          : `<button class="primary-btn" type="button" data-action="enable-agent-notifications" ${canEnable ? '' : 'disabled'}>Turn On</button>`}
      </div>
      <div class="notification-card-body notification-server-mute">
        <div class="notification-card-icon">${settingsIcon('server', 18)}</div>
        <div>
          <strong>${muted ? 'This server is muted' : 'Mute this server'}</strong>
          <p>${muted ? `Web push notifications from ${serverName} are muted for this browser.` : `Stops web push notifications from ${serverName} without changing other servers.`}</p>
        </div>
        <button class="${muted ? 'primary-btn' : 'secondary-btn'}" type="button" data-action="toggle-server-notification-mute">${muted ? 'Unmute Server' : 'Mute Server'}</button>
      </div>
    </div>
  `;
}

async function enableAgentNotifications() {
  if (!notificationApiSupported()) {
    toast('Browser notifications are not supported here');
    return false;
  }
  let permission = browserNotificationPermission();
  if (permission === 'default') {
    permission = await Notification.requestPermission();
  }
  if (permission === 'granted') {
    saveNotificationPrefs({
      ...notificationPrefs,
      enabled: true,
      dismissedPrompt: true,
      enabledAt: new Date().toISOString(),
    });
    toast('Agent notifications enabled');
    render();
    return true;
  }
  saveNotificationPrefs({ ...notificationPrefs, enabled: false, dismissedPrompt: true });
  toast(permission === 'denied' ? 'Notifications are blocked in browser settings' : 'Notifications were not enabled');
  render();
  return false;
}

function disableAgentNotifications() {
  saveNotificationPrefs({ ...notificationPrefs, enabled: false });
  toast('Agent notifications off');
  render();
}

function dismissAgentNotifications() {
  saveNotificationPrefs({
    ...notificationPrefs,
    enabled: false,
    dismissedPrompt: true,
    dismissedAt: new Date().toISOString(),
  });
  render();
}

function profileFormFocusSnapshot() {
  const active = document.activeElement;
  if (!active?.closest?.('#profile-form')) return null;
  if (!['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName)) return null;
  return {
    name: active.name || '',
    id: active.id || '',
    selectionStart: typeof active.selectionStart === 'number' ? active.selectionStart : null,
    selectionEnd: typeof active.selectionEnd === 'number' ? active.selectionEnd : null,
    selectionDirection: active.selectionDirection || 'none',
  };
}

function shouldDeferProfileFormRender() {
  return Boolean(
    profileFormIsComposing
    && document.getElementById('profile-form')
    && document.activeElement?.closest?.('#profile-form')
  );
}

function restoreProfileFormFocus(snapshot) {
  if (!snapshot) return;
  const fields = [...document.querySelectorAll('#profile-form input, #profile-form textarea, #profile-form select')];
  const target = fields.find((field) => (
    (snapshot.name && field.name === snapshot.name)
    || (snapshot.id && field.id === snapshot.id)
  ));
  if (!target) return;
  target.focus({ preventScroll: true });
  if (
    typeof target.setSelectionRange === 'function'
    && snapshot.selectionStart !== null
    && snapshot.selectionEnd !== null
  ) {
    target.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd, snapshot.selectionDirection);
  }
}

function captureProfileFormDraft(form = document.getElementById('profile-form')) {
  if (!form) return profileFormDraft;
  profileFormDraft = {
    humanId: form.dataset.humanId || '',
    displayName: form.querySelector('[name="displayName"]')?.value || '',
    description: form.querySelector('[name="description"]')?.value || '',
    avatar: form.querySelector('[name="avatar"]')?.value || '',
  };
  return profileFormDraft;
}

function clearProfileFormDraft() {
  profileFormDraft = null;
}

function profileFormValuesForRender(human = {}, currentUser = {}) {
  const humanId = human.id || '';
  if (profileFormDraft && profileFormDraft.humanId === humanId) {
    return {
      displayName: profileFormDraft.displayName,
      description: profileFormDraft.description,
      avatar: profileFormDraft.avatar,
    };
  }
  return {
    displayName: human.name || currentUser?.name || '',
    description: human.description || '',
    avatar: human.avatar || '',
  };
}

function profileAvatarInnerHtml({ human = {}, avatar = '', displayName = '', cssClass = '' } = {}) {
  const src = String(avatar || '').trim();
  if (src) return `<img src="${escapeHtml(src)}" class="${escapeHtml(cssClass)} avatar-img" alt="">`;
  const label = String(displayName || human.name || 'You').trim();
  const initial = label.slice(0, 1).toUpperCase() || 'Y';
  return `<span class="${escapeHtml(cssClass)}">${escapeHtml(initial)}</span>`;
}

function persistUiState() {
  const payload = {
    selectedSpaceType,
    selectedSpaceId,
    activeView,
    activeTab,
    railTab,
    settingsTab,
    consoleTab,
    threadMessageId,
    selectedAgentId,
    selectedHumanId,
    selectedComputerId,
    membersLayout,
  };
  writeJsonStorage(UI_STATE_KEY, payload);
  try {
    localStorage.setItem('railTab', railTab);
  } catch {
    // Non-critical compatibility write for older saved sessions.
  }
}

function rememberMembersLayoutFromCurrent() {
  if (activeView === 'members' && selectedHumanId) {
    membersLayout = normalizeMembersLayout({ mode: 'human', humanId: selectedHumanId });
    return membersLayout;
  }
  if (activeView === 'members' && selectedAgentId) {
    membersLayout = normalizeMembersLayout({ mode: 'agent', agentId: selectedAgentId });
    return membersLayout;
  }
  if (activeView === 'members') {
    membersLayout = normalizeMembersLayout({ mode: 'directory' });
    return membersLayout;
  }
  if (activeView === 'space' && selectedAgentId) {
    membersLayout = normalizeMembersLayout({ mode: 'split', agentId: selectedAgentId });
    return membersLayout;
  }
  if (activeView === 'space') {
    membersLayout = normalizeMembersLayout({ mode: 'channel' });
  }
  return membersLayout;
}

function firstMembersAgent() {
  const agents = typeof channelAssignableAgents === 'function'
    ? channelAssignableAgents()
    : (appState?.agents || []).filter((agent) => (
      typeof agentIsActiveInWorkspace === 'function' ? agentIsActiveInWorkspace(agent) : !agentIsDeleted(agent)
    ));
  return agents[0] || null;
}

function firstMembersHuman() {
  const humans = typeof workspaceHumans === 'function'
    ? workspaceHumans()
    : (appState?.humans || []).filter((human) => human.status !== 'removed');
  return humans[0] || null;
}

function selectMembersDefault() {
  const agent = firstMembersAgent();
  if (agent?.id) {
    selectedAgentId = agent.id;
    selectedHumanId = null;
    selectedComputerId = null;
    membersLayout = normalizeMembersLayout({ mode: 'agent', agentId: agent.id });
    clearNonAgentInspectors();
    return selectedAgentId;
  }

  const human = firstMembersHuman();
  if (human?.id) {
    selectedHumanId = human.id;
    selectedAgentId = null;
    selectedComputerId = null;
    membersLayout = normalizeMembersLayout({ mode: 'human', humanId: human.id });
    clearNonAgentInspectors();
    return null;
  }

  selectedAgentId = null;
  selectedHumanId = null;
  selectedComputerId = null;
  membersLayout = normalizeMembersLayout({ mode: 'directory' });
  clearNonAgentInspectors();
  return null;
}

function clearNonAgentInspectors() {
  threadMessageId = null;
  inspectorReturnThreadId = null;
  selectedTaskId = null;
  selectedSavedRecordId = null;
  selectedProjectFile = null;
  selectedAgentWorkspaceFile = null;
}

function restoreMembersLayout() {
  railTab = 'members';
  membersLayout = normalizeMembersLayout(membersLayout);
  const restoredAgent = membersLayout.agentId ? byId(appState?.agents, membersLayout.agentId) : null;
  const restoredHuman = membersLayout.humanId && typeof humanByIdAny === 'function'
    ? humanByIdAny(membersLayout.humanId)
    : null;

  if (membersLayout.mode === 'agent' && restoredAgent) {
    activeView = 'members';
    selectedAgentId = restoredAgent.id;
    selectedHumanId = null;
    clearNonAgentInspectors();
    return selectedAgentId;
  }

  if (membersLayout.mode === 'human' && restoredHuman) {
    activeView = 'members';
    selectedHumanId = restoredHuman.id;
    selectedAgentId = null;
    selectedComputerId = null;
    clearNonAgentInspectors();
    return null;
  }

  if (membersLayout.mode === 'split' && restoredAgent) {
    activeView = 'space';
    selectedAgentId = restoredAgent.id;
    selectedHumanId = null;
    clearNonAgentInspectors();
    return selectedAgentId;
  }

  activeView = 'members';
  return selectMembersDefault();
}

function openMembersNav({ preserveSpace = false } = {}) {
  railTab = 'members';
  selectedAgentId = null;
  selectedHumanId = null;
  selectedComputerId = null;
  clearNonAgentInspectors();
  if (preserveSpace && activeView === 'space') {
    membersLayout = normalizeMembersLayout({ mode: 'channel' });
  } else {
    return restoreMembersLayout();
  }
  return null;
}

function persistPaneScroll(targetName, node) {
  const key = paneKey(targetName);
  if (!key || !node) return;
  paneScrollPositions[key] = {
    top: Math.max(0, Math.round(node.scrollTop || 0)),
    atBottom: paneIsAtBottom(node),
    scrollHeight: Math.max(0, Math.round(node.scrollHeight || 0)),
    clientHeight: Math.max(0, Math.round(node.clientHeight || 0)),
    updatedAt: new Date().toISOString(),
  };
  const entries = Object.entries(paneScrollPositions);
  if (entries.length > 120) {
    paneScrollPositions = Object.fromEntries(entries.slice(entries.length - 120));
  }
  writeJsonStorage(PANE_SCROLL_KEY, paneScrollPositions);
}

function toggleTaskColumn(status) {
  collapsedTaskColumns = {
    ...collapsedTaskColumns,
    [status]: !collapsedTaskColumns[status],
  };
  localStorage.setItem(TASK_COLUMN_COLLAPSE_KEY, JSON.stringify(collapsedTaskColumns));
}

function toggleSidebarSection(section) {
  collapsedSidebarSections = {
    ...collapsedSidebarSections,
    [section]: !collapsedSidebarSections[section],
  };
  writeJsonStorage(SIDEBAR_SECTION_COLLAPSE_KEY, collapsedSidebarSections);
}

function toggleSkillSection(section) {
  collapsedSkillSections = {
    ...collapsedSkillSections,
    [section]: !collapsedSkillSections[section],
  };
  writeJsonStorage(SKILL_SECTION_COLLAPSE_KEY, collapsedSkillSections);
}

function workspaceMinWidth() {
  return window.matchMedia('(max-width: 1200px)').matches ? 300 : 360;
}

function railWidthMax(frame) {
  if (!frame) return RAIL_MAX_WIDTH;
  const frameWidth = frame.getBoundingClientRect().width;
  if (!frameWidth) return RAIL_MAX_WIDTH;
  const inspectorActualWidth = frame?.querySelector('.inspector')?.getBoundingClientRect().width || inspectorWidth;
  const railSplitterWidth = frame?.querySelector('.rail-resizer')?.getBoundingClientRect().width || 8;
  const inspectorSplitterWidth = frame?.querySelector('.inspector-resizer')?.getBoundingClientRect().width || 8;
  return Math.max(
    RAIL_MIN_WIDTH,
    Math.min(RAIL_MAX_WIDTH, frameWidth - inspectorActualWidth - railSplitterWidth - inspectorSplitterWidth - workspaceMinWidth()),
  );
}

function clampRailWidth(width, frame = document.querySelector('.app-frame')) {
  const maxWidth = railWidthMax(frame);
  return Math.round(Math.min(maxWidth, Math.max(RAIL_MIN_WIDTH, Number(width) || 236)));
}

function setRailWidth(width, { persist = false, frame = document.querySelector('.app-frame') } = {}) {
  railWidth = clampRailWidth(width, frame);
  frame?.style.setProperty('--rail-width', `${railWidth}px`);
  if (persist) localStorage.setItem(RAIL_WIDTH_KEY, String(railWidth));
}

function inspectorWidthMax(frame) {
  if (!frame) return INSPECTOR_MAX_WIDTH;
  const frameWidth = frame.getBoundingClientRect().width;
  if (!frameWidth) return INSPECTOR_MAX_WIDTH;
  const railActualWidth = frame?.querySelector('.rail')?.getBoundingClientRect().width || railWidth;
  const railSplitterWidth = frame?.querySelector('.rail-resizer')?.getBoundingClientRect().width || 8;
  const inspectorSplitterWidth = frame?.querySelector('.inspector-resizer')?.getBoundingClientRect().width || 8;
  return Math.max(
    INSPECTOR_MIN_WIDTH,
    Math.min(INSPECTOR_MAX_WIDTH, frameWidth - railActualWidth - railSplitterWidth - inspectorSplitterWidth - workspaceMinWidth()),
  );
}

function clampInspectorWidth(width, frame = document.querySelector('.app-frame')) {
  const maxWidth = inspectorWidthMax(frame);
  return Math.round(Math.min(maxWidth, Math.max(INSPECTOR_MIN_WIDTH, Number(width) || 360)));
}

function setInspectorWidth(width, { persist = false, frame = document.querySelector('.app-frame') } = {}) {
  inspectorWidth = clampInspectorWidth(width, frame);
  frame?.style.setProperty('--inspector-width', `${inspectorWidth}px`);
  if (persist) localStorage.setItem(INSPECTOR_WIDTH_KEY, String(inspectorWidth));
}

function appFrameStyle() {
  return `--rail-width: ${railWidth}px; --inspector-width: ${inspectorWidth}px;`;
}

function api(path, options = {}) {
  const serverSlug = String(
    (typeof serverSlugFromPath === 'function' && serverSlugFromPath())
    || (typeof currentServerSlug === 'function' && currentServerSlug())
    || '',
  ).trim();
  return fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(serverSlug ? { 'x-magclaw-server-slug': serverSlug } : {}),
      ...(options.headers || {}),
    },
  }).then(async (response) => {
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || response.statusText);
      error.status = response.status;
      throw error;
    }
    return data;
  });
}

function agentWarmRequestKey(agent) {
  return [
    agent?.id || '',
    agent?.runtimeLastStartedAt || '',
    agent?.runtimeLastTurnAt || '',
  ].join(':');
}

function timestampMs(value) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function agentHasWarmRuntimeSession(agent) {
  const startedAt = timestampMs(agent?.runtimeLastStartedAt);
  const warmAt = timestampMs(agent?.runtimeWarmAt);
  const lastTurnAt = timestampMs(agent?.runtimeLastTurnAt);
  const warmEnoughAt = Math.max(warmAt, lastTurnAt);
  if (!warmEnoughAt) return false;
  return !startedAt || warmEnoughAt >= startedAt;
}

function selectedWarmableAgent() {
  if (!appState) return null;
  if (selectedAgentId) return byId(appState.agents, selectedAgentId);
  if (activeView === 'space' && selectedSpaceType === 'dm') {
    const peer = currentDmPeer();
    if (peer?.type === 'agent') return peer.item;
  }
  return null;
}

function maybeWarmAgent(agent, { spaceType = selectedSpaceType, spaceId = selectedSpaceId } = {}) {
  if (!agent?.id) return;
  const runtime = String(agent.runtime || '').toLowerCase();
  if (runtime && !runtime.includes('codex')) return;
  if (['thinking', 'working', 'starting', 'running', 'queued', 'warming'].includes(String(agent.status || '').toLowerCase())) return;
  if (agentHasWarmRuntimeSession(agent)) return;
  const key = agentWarmRequestKey(agent);
  if (agentWarmRequests.has(key)) return;
  agentWarmRequests.add(key);
  api(`/api/agents/${encodeURIComponent(agent.id)}/warm`, {
    method: 'POST',
    body: JSON.stringify({ spaceType, spaceId }),
  }).catch((error) => {
    agentWarmRequests.delete(key);
    console.warn('Agent warmup failed', error);
  });
}

function maybeWarmCurrentAgent() {
  const agent = selectedWarmableAgent();
  if (!agent) return;
  maybeWarmAgent(agent, { spaceType: selectedSpaceType, spaceId: selectedSpaceId });
}
