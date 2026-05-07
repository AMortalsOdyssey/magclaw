

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

function agentNotificationsEnabled() {
  return notificationPrefs.enabled && browserNotificationPermission() === 'granted';
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
  if (permission === 'granted' && notificationPrefs.enabled) return 'On';
  if (permission === 'granted') return 'Off';
  return 'Ask first';
}

function notificationStatusDetail() {
  const permission = browserNotificationPermission();
  if (permission === 'unsupported') return 'This browser does not expose desktop notifications.';
  if (permission === 'denied') return 'Notifications are blocked in the browser site settings.';
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
  const enabled = agentNotificationsEnabled();
  const canEnable = permission === 'default' || permission === 'granted';
  return `
    <div class="pixel-panel cloud-card notification-config-card">
      <div class="panel-title"><span>Agent Notifications</span><span>${escapeHtml(notificationStatusLabel())}</span></div>
      <div class="notification-card-body">
        <div class="notification-card-icon">${notificationBellIcon(20)}</div>
        <div>
          <strong>${enabled ? 'Browser notifications are on' : 'Browser notifications are off'}</strong>
          <p>${escapeHtml(notificationStatusDetail())}</p>
          <small>Delivered for new agent messages and thread replies while this tab is not focused.</small>
        </div>
      </div>
      <div class="notification-card-actions">
        ${enabled
          ? '<button class="secondary-btn" type="button" data-action="disable-agent-notifications">Turn Off</button>'
          : `<button class="primary-btn" type="button" data-action="enable-agent-notifications" ${canEnable ? '' : 'disabled'}>Turn On</button>`}
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

function persistUiState() {
  const payload = {
    selectedSpaceType,
    selectedSpaceId,
    activeView,
    activeTab,
    railTab,
    settingsTab,
    threadMessageId,
    selectedAgentId,
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
  if (activeView === 'members' && selectedAgentId) {
    membersLayout = normalizeMembersLayout({ mode: 'agent', agentId: selectedAgentId });
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

  if (membersLayout.mode === 'agent' && restoredAgent) {
    activeView = 'members';
    selectedAgentId = restoredAgent.id;
    clearNonAgentInspectors();
    return selectedAgentId;
  }

  if (membersLayout.mode === 'split' && restoredAgent) {
    activeView = 'space';
    selectedAgentId = restoredAgent.id;
    clearNonAgentInspectors();
    return selectedAgentId;
  }

  activeView = 'space';
  selectedAgentId = null;
  clearNonAgentInspectors();
  membersLayout = normalizeMembersLayout({ mode: 'channel' });
  return null;
}

function openMembersNav() {
  if (activeView === 'space') {
    rememberMembersLayoutFromCurrent();
    railTab = 'members';
    clearNonAgentInspectors();
    return selectedAgentId;
  }
  return restoreMembersLayout();
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
  return fetch(path, {
    ...options,
    headers: {
      'content-type': 'application/json',
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
    agent?.runtimeWarmAt || '',
    agent?.runtimeLastTurnAt || '',
  ].join(':');
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
  if (['thinking', 'working', 'starting', 'running', 'queued'].includes(String(agent.status || '').toLowerCase())) return;
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

function readAvatarFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read avatar file.'));
    reader.readAsDataURL(file);
  });
}

function loadAvatarImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load avatar image.'));
    image.src = src;
  });
}

function avatarCropBaseSize(width, height) {
  const safeWidth = Math.max(1, Number(width) || AVATAR_CROP_VIEW_SIZE);
  const safeHeight = Math.max(1, Number(height) || AVATAR_CROP_VIEW_SIZE);
  const scale = Math.max(AVATAR_CROP_VIEW_SIZE / safeWidth, AVATAR_CROP_VIEW_SIZE / safeHeight);
  return {
    baseWidth: safeWidth * scale,
    baseHeight: safeHeight * scale,
  };
}

function clampAvatarCropScale(scale) {
  return Math.min(4, Math.max(1, Number(scale) || 1));
}

function clampAvatarCropOffset(state = avatarCropState) {
  if (!state) return null;
  const scale = clampAvatarCropScale(state.scale);
  const displayWidth = (state.baseWidth || AVATAR_CROP_VIEW_SIZE) * scale;
  const displayHeight = (state.baseHeight || AVATAR_CROP_VIEW_SIZE) * scale;
  const maxX = Math.max(0, (displayWidth - AVATAR_CROP_VIEW_SIZE) / 2);
  const maxY = Math.max(0, (displayHeight - AVATAR_CROP_VIEW_SIZE) / 2);
  state.scale = scale;
  state.offsetX = Math.min(maxX, Math.max(-maxX, Number(state.offsetX) || 0));
  state.offsetY = Math.min(maxY, Math.max(-maxY, Number(state.offsetY) || 0));
  return state;
}

function updateAvatarCropPreview() {
  const image = document.querySelector('.avatar-crop-image');
  if (!image || !avatarCropState) return;
  clampAvatarCropOffset();
  image.style.width = `${avatarCropState.baseWidth}px`;
  image.style.height = `${avatarCropState.baseHeight}px`;
  image.style.setProperty('--avatar-crop-x', `${avatarCropState.offsetX}px`);
  image.style.setProperty('--avatar-crop-y', `${avatarCropState.offsetY}px`);
  image.style.setProperty('--avatar-crop-scale', String(avatarCropState.scale));
}

async function openAvatarCropModal({ agentId, source, target = 'agent-detail' }) {
  const image = await loadAvatarImage(source);
  const { baseWidth, baseHeight } = avatarCropBaseSize(image.naturalWidth, image.naturalHeight);
  avatarCropState = clampAvatarCropOffset({
    agentId,
    target,
    source,
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
    baseWidth,
    baseHeight,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
  });
  modal = 'avatar-crop';
  render();
}

async function drawCroppedAvatarToDataUrl(state = avatarCropState) {
  if (!state?.source) throw new Error('No avatar crop is active.');
  const image = await loadAvatarImage(state.source);
  clampAvatarCropOffset(state);
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_CROP_SIZE;
  canvas.height = AVATAR_CROP_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not crop avatar.');

  const displayWidth = state.baseWidth * state.scale;
  const displayHeight = state.baseHeight * state.scale;
  const stageCenter = AVATAR_CROP_STAGE_SIZE / 2;
  const cropLeft = (AVATAR_CROP_STAGE_SIZE - AVATAR_CROP_VIEW_SIZE) / 2;
  const cropTop = (AVATAR_CROP_STAGE_SIZE - AVATAR_CROP_VIEW_SIZE) / 2;
  const imageLeft = stageCenter + state.offsetX - (displayWidth / 2);
  const imageTop = stageCenter + state.offsetY - (displayHeight / 2);
  const sx = ((cropLeft - imageLeft) / displayWidth) * image.naturalWidth;
  const sy = ((cropTop - imageTop) / displayHeight) * image.naturalHeight;
  const sw = (AVATAR_CROP_VIEW_SIZE / displayWidth) * image.naturalWidth;
  const sh = (AVATAR_CROP_VIEW_SIZE / displayHeight) * image.naturalHeight;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, AVATAR_CROP_SIZE, AVATAR_CROP_SIZE);
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, AVATAR_CROP_SIZE, AVATAR_CROP_SIZE);
  return canvas.toDataURL('image/png');
}

async function uploadAgentAvatar(input) {
  const target = input?.dataset?.target || 'agent-detail';
  const agentId = input?.dataset?.id || selectedAgentId;
  const file = input?.files?.[0];
  if (!file) return;
  if (file.size > AGENT_AVATAR_UPLOAD_MAX_BYTES) {
    toast('Avatar must be 10 MB or smaller');
    input.value = '';
    return;
  }
  if (target === 'agent-create') {
    saveAgentFormState();
  } else if (!agentId) {
    input.value = '';
    return;
  }
  const avatar = await readAvatarFileAsDataUrl(file);
  input.value = '';
  await openAvatarCropModal({ agentId, source: avatar, target });
}

function setProfileAvatarInput(value) {
  const avatar = String(value || '').trim();
  const input = document.getElementById('profile-avatar-input');
  if (input) input.value = avatar;
  const preview = document.querySelector('#profile-form .settings-account-avatar');
  if (!preview) return;
  if (avatar) {
    preview.innerHTML = `<img src="${escapeHtml(avatar)}" class="settings-account-avatar-inner avatar-img" alt="">`;
    return;
  }
  const name = document.querySelector('#profile-form input[name="displayName"]')?.value
    || byId(appState.humans, appState.cloud?.auth?.currentMember?.humanId)?.name
    || 'You';
  preview.textContent = String(name).trim().slice(0, 1).toUpperCase() || 'Y';
}

function openAvatarPicker({ target = 'agent-create', agentId = '', humanId = '', selectedAvatar = '', returnModal = null } = {}) {
  avatarPickerState = {
    target,
    agentId,
    humanId,
    selectedAvatar: selectedAvatar || '',
    returnModal,
  };
  modal = 'avatar-picker';
  render();
}
