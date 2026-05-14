async function refreshState() {
  rememberPinnedBottomBeforeStateChange();
  const nextState = await api('/api/state');
  trackFanoutRouteEvents(nextState, { silent: !initialLoadComplete || !appState });
  trackAgentNotifications(nextState, { silent: !initialLoadComplete || !appState });
  appState = nextState;
  if (typeof applyMagclawAccountLanguage === 'function') applyMagclawAccountLanguage(appState);
  const routeSlug = serverSlugFromPath();
  if (
    routeSlug
    && routeSlug !== currentServerSlug()
    && !routeServerSwitchAttempted
    && appState.cloud?.auth?.currentUser
    && (appState.cloud?.workspaces || []).some((server) => String(server.slug || server.id) === routeSlug)
  ) {
    routeServerSwitchAttempted = true;
    await api(`/api/console/servers/${encodeURIComponent(routeSlug)}/switch`, { method: 'POST', body: '{}' });
    appState = await api('/api/state');
    if (typeof applyMagclawAccountLanguage === 'function') applyMagclawAccountLanguage(appState);
  }
  startHumanPresenceHeartbeat();
  if (!installedRuntimes.length && (selectedAgentId || activeView === 'members' || activeView === 'computers')) {
    await loadInstalledRuntimes().catch(() => {});
  }
  render();
}

function cloudAuthErrorMessage(error, { interactive = false } = {}) {
  if (!error) return '';
  if (error.status === 401) return interactive ? 'Email or password is incorrect.' : '';
  return error.message || '';
}

function cloudAuthTokenFromLocation() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || '';
  const path = window.location.pathname || '';
  if (path.startsWith('/create-account')) return { mode: 'create', token: '' };
  if (path.startsWith('/forgot-password/check-email')) {
    return { mode: 'forgot-sent', token: '', email: params.get('email') || '' };
  }
  if (path.startsWith('/forgot-password')) return { mode: 'forgot', token: '' };
  const joinMatch = path.match(/^\/join\/([^/]+)/);
  if (joinMatch) return { mode: 'join', token: decodeURIComponent(joinMatch[1] || '') };
  if (!token) return { mode: '', token: '' };
  if (path.includes('reset-password') || token.startsWith('mc_reset_')) return { mode: 'reset', token };
  return { mode: 'invite', token };
}

async function loadCloudAuthTokenContext() {
  const context = cloudAuthTokenFromLocation();
  if (!context.mode || !context.token) return context;
  try {
    if (context.mode === 'reset') {
      const status = await api(`/api/cloud/auth/reset-status?token=${encodeURIComponent(context.token)}`);
      return { ...context, reset: status.reset || {} };
    }
    if (context.mode === 'join') {
      const status = await api(`/api/cloud/join-links/status?token=${encodeURIComponent(context.token)}`);
      return { ...context, joinLink: status.joinLink || {}, joinWorkspace: status.workspace || {}, alreadyMember: Boolean(status.alreadyMember) };
    }
    const status = await api(`/api/cloud/auth/invitation-status?token=${encodeURIComponent(context.token)}`);
    if (cloudAuthAvatarToken !== context.token) {
      cloudAuthAvatar = status.invitation?.avatarUrl || '';
      cloudAuthAvatarToken = context.token;
    }
    return { ...context, invitation: status.invitation || {} };
  } catch (error) {
    const alreadyRegistered = error.status === 409 && /User already exists/i.test(error.message || '');
    const alreadyUsed = error.status === 409;
    return {
      ...context,
      error: alreadyRegistered
        ? 'User already registered.'
        : alreadyUsed
          ? 'Invitation link already used.'
          : (error.message || 'This link is no longer available.'),
    };
  }
}

async function showCloudAuthGate(error = null, options = {}) {
  disconnectEvents();
  stopHumanPresenceHeartbeat();
  appState = null;
  let cloud = { auth: { initialized: false, loginRequired: true } };
  try {
    cloud = await api('/api/cloud/auth/status');
  } catch {
    // Keep the login shell available even if auth status is temporarily unavailable.
  }
  const authErrorMessage = cloudAuthErrorMessage(error, options);
  const tokenContext = await loadCloudAuthTokenContext();
  renderCloudAuthGate(cloud, authErrorMessage, tokenContext);
}

async function refreshStateOrAuthGate() {
  if (cloudAuthTokenFromLocation().mode) {
    await showCloudAuthGate(null);
    return false;
  }
  try {
    await refreshState();
    initialLoadComplete = true;
    connectEvents();
    return true;
  } catch (error) {
    if (error.status === 401) {
      await showCloudAuthGate(error);
      return false;
    }
    throw error;
  }
}

function htmlToElement(html) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

function syncRecordList(container, records, renderRecord, datasetName, emptyHtml) {
  if (!container) return false;
  if (!records.length) {
    if (container.innerHTML.trim() !== emptyHtml.trim()) {
      container.innerHTML = emptyHtml;
    }
    return true;
  }

  const wantedIds = new Set(records.map((record) => record.id));
  for (const child of [...container.children]) {
    const id = child.dataset?.[datasetName];
    if (!id || !wantedIds.has(id)) child.remove();
  }

  records.forEach((record, index) => {
    let node = [...container.children].find((child) => child.dataset?.[datasetName] === record.id);
    const key = renderRecordKey(record);
    if (!node || node.dataset.renderKey !== key) {
      const next = htmlToElement(renderRecord(record));
      if (!next) return;
      if (node) {
        node.replaceWith(next);
      } else {
        container.insertBefore(next, container.children[index] || null);
      }
      node = next;
    }
    if (container.children[index] !== node) {
      container.insertBefore(node, container.children[index] || null);
    }
  });
  return true;
}

function patchRailSurface() {
  const rail = document.querySelector('.collab-rail');
  if (rail) rail.replaceWith(htmlToElement(renderRail()));
}

function patchThreadParentCard(message) {
  const card = document.querySelector('.thread-parent-card');
  const current = card?.firstElementChild;
  if (!card || !message) return false;
  const key = renderRecordKey(message);
  if (!current || current.dataset.renderKey !== key) {
    const next = htmlToElement(renderMessage(message, { compact: true }));
    if (next) card.replaceChildren(next);
  }
  return true;
}

function patchThreadTaskLifecycle(card, task) {
  const current = document.querySelector('.thread-context .task-lifecycle');
  if (!task) {
    if (current) current.remove();
    return true;
  }
  const next = htmlToElement(renderTaskLifecycle(task));
  if (!next) return false;
  if (current) {
    if (current.outerHTML !== next.outerHTML) current.replaceWith(next);
    return true;
  }
  if (card) card.insertAdjacentElement('afterend', next);
  return true;
}

function patchThreadReplyList(context, replies) {
  let list = context.querySelector('.reply-list');
  if (!replies.length) {
    if (list) list.remove();
    return true;
  }
  if (!list) {
    const divider = context.querySelector('.thread-reply-divider');
    list = document.createElement('div');
    list.className = 'reply-list';
    divider?.insertAdjacentElement('afterend', list);
  }
  return syncRecordList(list, replies, renderReply, 'replyId', '');
}

function stateSpaceMessages(stateSnapshot, spaceType = selectedSpaceType, spaceId = selectedSpaceId) {
  return (stateSnapshot?.messages || [])
    .filter((message) => message.spaceType === spaceType && message.spaceId === spaceId)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

function stateThreadReplies(stateSnapshot, messageId) {
  return (stateSnapshot?.replies || [])
    .filter((reply) => reply.parentMessageId === messageId)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

function recordPatchSignature(record) {
  return [
    record?.id || '',
    record?.updatedAt || '',
    record?.createdAt || '',
    record?.body || '',
    record?.replyCount || 0,
    record?.taskId || '',
    (record?.attachmentIds || []).join(','),
    (record?.savedBy || []).join(','),
    (record?.readBy || []).join(','),
    deliveryReceiptSignature(record),
  ].join('::');
}

function activeConversationSignature(stateSnapshot = appState) {
  if (!stateSnapshot || activeView !== 'space' || activeTab !== 'chat') return '';
  if (threadMessageId) {
    const root = byId(stateSnapshot.messages, threadMessageId);
    const records = root ? [root, ...stateThreadReplies(stateSnapshot, root.id)] : [];
    return records.map(recordPatchSignature).join('|');
  }
  return stateSpaceMessages(stateSnapshot)
    .map(recordPatchSignature)
    .join('|');
}

function currentServerProfileFromState(stateSnapshot = appState) {
  const cloud = stateSnapshot?.cloud || {};
  const targetSlug = String(serverSlugFromPath() || cloud.workspace?.slug || cloud.workspace?.id || stateSnapshot?.connection?.workspaceId || '').trim();
  return (cloud.workspaces || []).find((server) => (
    targetSlug
    && String(server.slug || server.id || '') === targetSlug
  ))
    || cloud.workspace
    || {};
}

function serverProfilePatchSignature(stateSnapshot = appState) {
  const server = currentServerProfileFromState(stateSnapshot);
  return JSON.stringify([
    server?.id || '',
    server?.slug || '',
    server?.name || '',
    server?.avatar || '',
    server?.onboardingAgentId || '',
    server?.newAgentGreetingEnabled === false ? 'false' : 'true',
    server?.updatedAt || '',
  ]);
}

function serverSettingsSupportSignature(stateSnapshot = appState) {
  const cloud = stateSnapshot?.cloud || {};
  const canManage = Boolean(cloud.auth?.capabilities?.manage_cloud_connection);
  const members = (cloud.members || []).map((member) => [
    member?.id || '',
    member?.workspaceId || '',
    member?.role || '',
    member?.status || '',
    member?.user?.id || '',
    member?.user?.name || '',
    member?.user?.email || '',
  ]);
  const invitations = (cloud.invitations || []).map((item) => [
    item?.id || '',
    item?.workspaceId || '',
    item?.email || '',
    item?.role || '',
    item?.status || '',
    item?.acceptedAt || '',
    item?.declinedAt || '',
    item?.createdAt || '',
  ]);
  const joinLinks = (cloud.joinLinks || []).map((item) => [
    item?.id || '',
    item?.workspaceId || '',
    item?.url || '',
    item?.status || '',
    item?.usedCount || 0,
    item?.maxUses || '',
    item?.expiresAt || '',
    item?.revokedAt || '',
  ]);
  const agents = (stateSnapshot?.agents || []).map((agent) => [
    agent?.id || '',
    agent?.workspaceId || '',
    agent?.name || '',
    agent?.disabledAt || '',
    agent?.deletedAt || '',
  ]);
  return JSON.stringify({ canManage, members, invitations, joinLinks, agents });
}

function patchOpenThreadDrawerSurface(scrollSnapshot) {
  if (!threadMessageId || selectedProjectFile || selectedAgentId || selectedTaskId) return false;
  const message = byId(appState.messages, threadMessageId);
  const context = document.querySelector('#thread-context');
  const panel = document.querySelector('.thread-drawer');
  if (!message || !context || !panel) return false;

  const replies = threadReplies(message.id);
  const task = message.taskId ? byId(appState.tasks, message.taskId) : null;
  const replyWord = replies.length === 1 ? 'reply' : 'replies';
  const replyCountText = `${replies.length} ${replyWord}`;
  const card = context.querySelector('.thread-parent-card');

  patchThreadParentCard(message);
  patchThreadTaskLifecycle(card, task);
  const dividerCount = context.querySelector('.thread-reply-divider strong');
  if (dividerCount) dividerCount.textContent = replyCountText;
  patchThreadReplyList(context, replies);

  const tools = panel.querySelector('.thread-tools');
  if (tools) {
    tools.innerHTML = `
      <span>${escapeHtml(replyCountText)}</span>
      ${task ? renderTaskInlineBadge(task, { showAssignee: false }) : ''}
    `;
  }

  const list = document.querySelector('#message-list');
  if (list) {
    const emptyHtml = selectedSpaceType === 'dm'
      ? '<div class="dm-empty-state">No messages yet. Start the conversation!</div>'
      : '<div class="empty-box">No messages here yet.</div>';
    syncRecordList(list, spaceMessages(), renderMessage, 'messageId', emptyHtml);
  }
  patchRailSurface();
  window.requestAnimationFrame(() => restorePaneScrolls(scrollSnapshot));
  return true;
}

function patchActiveThreadSurface(scrollSnapshot) {
  if (modal || activeView !== 'space' || activeTab !== 'chat') return false;
  return patchOpenThreadDrawerSurface(scrollSnapshot);
}

function patchActiveConversationSurface(scrollSnapshot, { allowInspector = false } = {}) {
  if (modal || activeView !== 'space' || activeTab !== 'chat') return false;
  const inspectorOpen = selectedProjectFile || selectedAgentId || selectedTaskId;
  if (threadMessageId || (!allowInspector && inspectorOpen)) return false;
  const list = document.querySelector('#message-list');
  const panel = document.querySelector('.chat-panel');
  if (!list || !panel) return false;

  const emptyHtml = selectedSpaceType === 'dm'
    ? '<div class="dm-empty-state">No messages yet. Start the conversation!</div>'
    : '<div class="empty-box">No messages here yet.</div>';
  syncRecordList(list, spaceMessages(), renderMessage, 'messageId', emptyHtml);
  patchRailSurface();
  window.requestAnimationFrame(() => restorePaneScrolls(scrollSnapshot));
  return true;
}

function patchServerProfileSettingsSurface() {
  if (activeView !== 'cloud' || settingsTab !== 'server') return false;
  const profileForm = document.getElementById('server-profile-form');
  if (!profileForm) return false;
  const server = currentServerProfile();
  const avatar = serverProfileAvatarDraft === null ? (server.avatar || '') : serverProfileAvatarDraft;
  const avatarPreview = profileForm.querySelector('.server-profile-avatar');
  if (avatarPreview) {
    avatarPreview.innerHTML = renderServerAvatar({ ...server, avatar }, 'server-profile-avatar-img');
  }
  const avatarInput = profileForm.querySelector('[data-server-avatar-input]');
  if (avatarInput) avatarInput.value = avatar;
  const nameInput = profileForm.querySelector('input[name="name"]');
  if (nameInput && document.activeElement !== nameInput) nameInput.value = server.name || '';
  const onboardingInput = profileForm.querySelector('input[name="onboardingAgentId"]');
  if (onboardingInput) onboardingInput.value = server.onboardingAgentId || '';
  const greetingInput = profileForm.querySelector('input[name="newAgentGreetingEnabled"]');
  if (greetingInput) greetingInput.value = server.newAgentGreetingEnabled === false ? 'false' : 'true';

  const onboardingForm = document.getElementById('server-onboarding-form');
  if (onboardingForm) {
    const select = onboardingForm.querySelector('select[name="onboardingAgentId"]');
    if (select && document.activeElement !== select) select.value = server.onboardingAgentId || '';
    const checkbox = onboardingForm.querySelector('input[name="newAgentGreetingEnabled"]');
    if (checkbox) checkbox.checked = server.newAgentGreetingEnabled !== false;
    const mode = onboardingForm.querySelector('.panel-title span:last-child');
    if (mode) mode.textContent = server.newAgentGreetingEnabled === false ? 'quiet' : 'greeting';
  }
  return true;
}

function computerPairingModalRenderSignature(stateSnapshot = appState) {
  const pendingComputerId = latestPairingCommand?.computer?.id || '';
  const command = latestPairingCommand?.command || '';
  const liveComputer = pendingComputerId ? byId(stateSnapshot?.computers, pendingComputerId) : null;
  const pairingComputer = liveComputer || latestPairingCommand?.computer || null;
  return [
    pendingComputerId,
    command,
    String(pairingComputer?.status || '').toLowerCase(),
    pairingComputer?.daemonVersion || '',
    pairingComputer?.lastSeenAt || '',
    pairingCommandIsUsable(latestPairingCommand) ? 'usable' : 'stale',
  ].join('|');
}

function applyStateUpdate(nextState) {
  trackFanoutRouteEvents(nextState, { silent: !initialLoadComplete });
  trackAgentNotifications(nextState, { silent: !initialLoadComplete });
  const scrollSnapshot = {
    main: paneScrollSnapshot('main'),
    thread: paneScrollSnapshot('thread'),
  };
  const selectionBefore = `${selectedSpaceType}:${selectedSpaceId}`;
  const unreadBefore = railUnreadSignature();
  const activeConversationBefore = activeConversationSignature();
  const serverProfileBefore = serverProfilePatchSignature();
  const serverSettingsSupportBefore = serverSettingsSupportSignature();
  const computerModalBefore = modal === 'computer' ? computerPairingModalRenderSignature(appState) : '';
  rememberPinnedBottomBeforeStateChange();
  appState = nextState;
  if (typeof applyMagclawAccountLanguage === 'function') applyMagclawAccountLanguage(appState);
  startHumanPresenceHeartbeat();
  if (modal) {
    if (modal === 'computer' && computerModalBefore !== computerPairingModalRenderSignature(appState)) render();
    return;
  }
  ensureSelection();
  const selectionChanged = selectionBefore !== `${selectedSpaceType}:${selectedSpaceId}`;
  const unreadChanged = unreadBefore !== railUnreadSignature();
  const activeConversationChanged = activeConversationBefore !== activeConversationSignature();
  const serverProfileAfter = serverProfilePatchSignature();
  const serverProfileOnlyChanged = activeView === 'cloud'
    && settingsTab === 'server'
    && serverProfileBefore !== serverProfileAfter
    && serverSettingsSupportBefore === serverSettingsSupportSignature()
    && !selectionChanged
    && !unreadChanged
    && !activeConversationChanged;
  const serverProfileEcho = activeView === 'cloud'
    && settingsTab === 'server'
    && pendingServerProfilePatchSignature
    && pendingServerProfilePatchSignature === serverProfileAfter
    && serverSettingsSupportBefore === serverSettingsSupportSignature()
    && !selectionChanged
    && !unreadChanged
    && !activeConversationChanged;
  if (selectionChanged) {
    pendingServerProfilePatchSignature = '';
    render();
    return;
  }
  if (serverProfileOnlyChanged || serverProfileEcho) {
    pendingServerProfilePatchSignature = '';
    patchRailSurface();
    patchServerProfileSettingsSurface();
    patchOpenThreadDrawerSurface(scrollSnapshot);
    return;
  }
  if (pendingServerProfilePatchSignature && pendingServerProfilePatchSignature !== serverProfileAfter) {
    pendingServerProfilePatchSignature = '';
  }
  if (computerNameEditIsActive()) {
    captureComputerNameFieldDraft();
    if (unreadChanged) patchRailSurface();
    window.requestAnimationFrame(() => restorePaneScrolls(scrollSnapshot));
    return;
  }
  if (agentDetailInlineEditIsActive()) {
    captureAgentDetailFieldDraft();
    if (unreadChanged) patchRailSurface();
    window.requestAnimationFrame(() => restorePaneScrolls(scrollSnapshot));
    return;
  }
  if (patchActiveThreadSurface(scrollSnapshot)) return;
  if (patchActiveConversationSurface(scrollSnapshot, { allowInspector: activeConversationChanged || unreadChanged })) return;
  if (unreadChanged) patchRailSurface();
  render();
}

function applyRunEventUpdate(incoming) {
  if (!appState || appState.events.some((item) => item.id === incoming.id)) return;
  appState.events.push(incoming);
  if (modal) return;
  if (agentDetailInlineEditIsActive()) {
    patchRailSurface();
    return;
  }
  if (computerNameEditIsActive()) {
    patchRailSurface();
    return;
  }
  if (workspaceActivityDrawerOpen || selectedAgentId) {
    render();
    return;
  }
  patchRailSurface();
}

function applyPresenceHeartbeat(heartbeat) {
  if (!appState || !Array.isArray(heartbeat?.agents)) return;
  const incomingById = new Map(heartbeat.agents.map((agent) => [agent.id, agent]));
  const incomingHumansById = new Map((heartbeat.humans || []).map((human) => [human.id, human]));
  let changed = false;
  const agents = (appState.agents || []).map((agent) => {
    const incoming = incomingById.get(agent.id);
    if (!incoming) return agent;
    const next = {
      ...agent,
      status: incoming.status || agent.status,
      runtimeLastStartedAt: incoming.runtimeLastStartedAt || agent.runtimeLastStartedAt || null,
      runtimeLastTurnAt: incoming.runtimeLastTurnAt || agent.runtimeLastTurnAt || null,
      runtimeWarmAt: incoming.runtimeWarmAt || agent.runtimeWarmAt || null,
    };
    if (
      next.status !== agent.status
      || next.runtimeLastStartedAt !== agent.runtimeLastStartedAt
      || next.runtimeLastTurnAt !== agent.runtimeLastTurnAt
      || next.runtimeWarmAt !== agent.runtimeWarmAt
    ) {
      changed = true;
    }
    return next;
  });
  const humans = (appState.humans || []).map((human) => {
    const incoming = incomingHumansById.get(human.id);
    if (!incoming) return human;
    const next = {
      ...human,
      status: incoming.status || human.status || 'offline',
      lastSeenAt: incoming.lastSeenAt || human.lastSeenAt || null,
      presenceUpdatedAt: incoming.presenceUpdatedAt || human.presenceUpdatedAt || null,
    };
    if (
      next.status !== human.status
      || next.lastSeenAt !== human.lastSeenAt
      || next.presenceUpdatedAt !== human.presenceUpdatedAt
    ) {
      changed = true;
    }
    return next;
  });
  if (!changed) return;
  applyStateUpdate({
    ...appState,
    agents,
    humans,
    updatedAt: heartbeat.updatedAt || appState.updatedAt,
  });
}

function connectEvents() {
  if (eventSource) return;
  const serverSlug = String(serverSlugFromPath() || currentServerSlug() || '').trim();
  const eventPath = serverSlug
    ? `/api/events?serverSlug=${encodeURIComponent(serverSlug)}`
    : '/api/events';
  eventSource = new EventSource(eventPath);
  eventSource.addEventListener('state', (event) => {
    applyStateUpdate(JSON.parse(event.data));
  });
  eventSource.addEventListener('run-event', (event) => {
    const incoming = JSON.parse(event.data);
    applyRunEventUpdate(incoming);
  });
  eventSource.addEventListener('heartbeat', (event) => {
    applyPresenceHeartbeat(JSON.parse(event.data));
  });
}

function disconnectEvents() {
  if (!eventSource) return;
  eventSource.close();
  eventSource = null;
}

async function sendHumanPresenceHeartbeat() {
  if (activeView === 'console' || (window.location.pathname || '').startsWith('/console')) return;
  if (humanPresenceInFlight || !appState?.cloud?.auth?.currentUser) return;
  humanPresenceInFlight = true;
  try {
    const result = await api('/api/cloud/auth/heartbeat', { method: 'POST', body: '{}' });
    if (result?.human?.id && appState?.humans) {
      let changed = false;
      const humans = appState.humans.map((human) => {
        if (human.id !== result.human.id) return human;
        changed = human.status !== result.human.status || human.lastSeenAt !== result.human.lastSeenAt;
        return { ...human, ...result.human };
      });
      if (changed) applyStateUpdate({ ...appState, humans });
    }
  } catch (error) {
    if (error.status === 401) stopHumanPresenceHeartbeat();
  } finally {
    humanPresenceInFlight = false;
  }
}

function startHumanPresenceHeartbeat() {
  if (activeView === 'console' || (window.location.pathname || '').startsWith('/console')) {
    stopHumanPresenceHeartbeat();
    return;
  }
  if (!appState?.cloud?.auth?.currentUser) {
    stopHumanPresenceHeartbeat();
    return;
  }
  if (!humanPresenceTimer) {
    humanPresenceTimer = window.setInterval(() => {
      sendHumanPresenceHeartbeat();
    }, HUMAN_PRESENCE_HEARTBEAT_MS);
    sendHumanPresenceHeartbeat();
  }
}

function stopHumanPresenceHeartbeat() {
  if (humanPresenceTimer) {
    window.clearInterval(humanPresenceTimer);
    humanPresenceTimer = null;
  }
}

document.addEventListener('scroll', (event) => {
  if (event.target?.id === 'message-list') {
    updateBackBottomVisibility('main');
    persistPaneScroll('main', event.target);
  }
  if (event.target?.id === 'thread-context') {
    updateBackBottomVisibility('thread');
    persistPaneScroll('thread', event.target);
  }
  if (event.target?.id === 'workspace-activity-list' && event.target.scrollTop <= 24) {
    const total = workspaceActivityRecords().length;
    if (workspaceActivityDrawerOpen && workspaceActivityVisibleCount < total) {
      workspaceActivityVisibleCount += WORKSPACE_ACTIVITY_VISIBLE_STEP;
      workspaceActivityScrollToBottom = false;
      render();
    }
  }
}, true);

window.addEventListener('focus', () => {
  windowFocused = true;
  sendHumanPresenceHeartbeat();
});

window.addEventListener('blur', () => {
  windowFocused = false;
});

document.addEventListener('visibilitychange', () => {
  windowFocused = document.visibilityState === 'visible' && document.hasFocus();
  if (document.visibilityState === 'visible') sendHumanPresenceHeartbeat();
});

document.addEventListener('compositionstart', (event) => {
  if (event.target?.id === 'search-input') {
    searchIsComposing = true;
  }
  if (event.target?.closest?.('textarea[data-mention-input]')) {
    composerIsComposing = true;
  }
  if (event.target?.closest?.('#profile-form')) {
    profileFormIsComposing = true;
  }
});

document.addEventListener('compositionend', (event) => {
  if (event.target?.id === 'search-input') {
    searchIsComposing = false;
    searchQuery = event.target.value;
    searchVisibleCount = SEARCH_PAGE_SIZE;
    updateSearchResults();
  }
  if (event.target?.closest?.('textarea[data-mention-input]')) {
    composerIsComposing = false;
  }
  const profileForm = event.target?.closest?.('#profile-form');
  if (profileForm) {
    profileFormIsComposing = false;
    captureProfileFormDraft(profileForm);
    if (event.target.name === 'displayName' && !profileForm.querySelector('[name="avatar"]')?.value) {
      setProfileAvatarInput('');
    }
    if (pendingProfileFormRender) {
      pendingProfileFormRender = false;
      window.requestAnimationFrame(() => render());
    }
  }
  const consoleServerForm = event.target?.closest?.('#console-server-form');
  if (consoleServerForm && event.target.matches?.('[data-console-server-name]')) {
    syncConsoleServerSlug(consoleServerForm);
  }
});

document.addEventListener('keydown', async (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key?.toLowerCase() === 'k') {
    event.preventDefault();
    openSearchView();
    return;
  }

  const railResizer = event.target.closest?.('.rail-resizer');
  if (railResizer && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault();
    const delta = event.key === 'ArrowRight' ? 24 : -24;
    setRailWidth(railWidth + delta, { persist: true, frame: railResizer.closest('.app-frame') });
    return;
  }

  const inspectorResizer = event.target.closest?.('.inspector-resizer');
  if (inspectorResizer && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault();
    const delta = event.key === 'ArrowLeft' ? 24 : -24;
    setInspectorWidth(inspectorWidth + delta, { persist: true, frame: inspectorResizer.closest('.app-frame') });
    return;
  }

  const textarea = event.target.closest('textarea[data-mention-input]');
  if (textarea && isImeComposing(event)) return;

  if (event.target.id === 'member-invite-input' && !isImeComposing(event)) {
    if (event.key === 'Enter' || event.key === ' ' || event.code === 'Space' || event.key === ',' || event.key === '，' || event.key === ';' || event.key === '；' || event.key === 'Tab') {
      event.preventDefault();
      cloudInviteDraft = event.target.value;
      commitMemberInviteDraft();
      render();
      const input = document.getElementById('member-invite-input');
      input?.focus();
      input?.setSelectionRange(input.value.length, input.value.length);
      return;
    }
  }

  if (event.target.id === 'members-page-input' && event.key === 'Enter') {
    event.preventDefault();
    memberDirectoryPage = Number.parseInt(event.target.value, 10) || 1;
    render();
    document.getElementById('members-page-input')?.focus();
    return;
  }

  // Handle mention popup keyboard navigation
  if (textarea && mentionPopup.active && mentionPopup.composerId === textarea.dataset.composerId) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      mentionPopup.selectedIndex = Math.min(mentionPopup.selectedIndex + 1, mentionPopup.items.length - 1);
      updateMentionPopupSelection();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      mentionPopup.selectedIndex = Math.max(mentionPopup.selectedIndex - 1, 0);
      updateMentionPopupSelection();
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      const item = mentionPopup.items[mentionPopup.selectedIndex];
      if (item) {
        await insertMention(textarea, item);
        const existingPopup = document.getElementById('mention-popup');
        if (existingPopup) existingPopup.remove();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      mentionPopup.active = false;
      mentionPopup.items = [];
      const existingPopup = document.getElementById('mention-popup');
      if (existingPopup) existingPopup.remove();
      return;
    }
  }

  // Regular Enter to submit message (only when popup not active)
  if (textarea && event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    const form = textarea.closest('form');
    if (form) form.requestSubmit();
  }
});

document.addEventListener('pointerdown', (event) => {
  const cropStage = event.target.closest('.avatar-crop-stage');
  if (cropStage && avatarCropState) {
    event.preventDefault();
    cropStage.setPointerCapture?.(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const startOffsetX = avatarCropState.offsetX;
    const startOffsetY = avatarCropState.offsetY;
    const onPointerMove = (moveEvent) => {
      avatarCropState.offsetX = startOffsetX + (moveEvent.clientX - startX);
      avatarCropState.offsetY = startOffsetY + (moveEvent.clientY - startY);
      clampAvatarCropOffset();
      updateAvatarCropPreview();
    };
    const finish = () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', finish);
      document.removeEventListener('pointercancel', finish);
    };
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
    return;
  }

  const resizer = event.target.closest('.rail-resizer, .inspector-resizer');
  if (!resizer) return;

  event.preventDefault();
  const frame = resizer.closest('.app-frame');
  const isRail = resizer.classList.contains('rail-resizer');
  document.body.classList.add(isRail ? 'is-resizing-rail' : 'is-resizing-inspector');
  resizer.setPointerCapture?.(event.pointerId);

  const updateWidth = (clientX) => {
    const rect = frame?.getBoundingClientRect();
    if (isRail) {
      setRailWidth(clientX - (rect?.left || 0), { frame });
      return;
    }
    const frameRight = rect?.right || window.innerWidth;
    setInspectorWidth(frameRight - clientX, { frame });
  };
  const onPointerMove = (moveEvent) => updateWidth(moveEvent.clientX);
  const finish = () => {
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', finish);
    document.removeEventListener('pointercancel', finish);
    document.body.classList.remove(isRail ? 'is-resizing-rail' : 'is-resizing-inspector');
    localStorage.setItem(isRail ? RAIL_WIDTH_KEY : INSPECTOR_WIDTH_KEY, String(isRail ? railWidth : inspectorWidth));
  };

  updateWidth(event.clientX);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', finish);
  document.addEventListener('pointercancel', finish);
});

// Update mention popup selection highlight without full re-render
function updateMentionPopupSelection() {
  const popup = document.getElementById('mention-popup');
  if (!popup) return;
  popup.querySelectorAll('.mention-item').forEach((el, idx) => {
    el.classList.toggle('selected', idx === mentionPopup.selectedIndex);
  });
}

const CONSOLE_SERVER_SLUG_MIN_LENGTH = 5;
const CONSOLE_SERVER_SLUG_MAX_LENGTH = 63;
const CONSOLE_SERVER_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

function consoleServerSlugFromName(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63)
    .replace(/-$/g, '');
}

function clearConsoleServerFormError(form = document.getElementById('console-server-form')) {
  const errorNode = form?.querySelector?.('[data-console-server-error]');
  if (!errorNode) return;
  errorNode.textContent = '';
  errorNode.hidden = true;
}

function setConsoleServerFormError(form, message) {
  const errorNode = form?.querySelector?.('[data-console-server-error]');
  if (!errorNode) return;
  errorNode.textContent = message;
  errorNode.hidden = false;
}

function consoleServerSlugValidationMessage(slug) {
  const value = String(slug || '').trim();
  if (!value) return 'URL slug is required.';
  if (value.length < CONSOLE_SERVER_SLUG_MIN_LENGTH) return 'Slug must be at least 5 characters.';
  if (value.length > CONSOLE_SERVER_SLUG_MAX_LENGTH) return 'Slug must be 63 characters or fewer.';
  if (!CONSOLE_SERVER_SLUG_PATTERN.test(value)) return 'Use lowercase letters, numbers, and hyphens. Slugs cannot start or end with a hyphen.';
  return '';
}

function validateConsoleServerForm(form, { report = true } = {}) {
  const nameInput = form?.querySelector?.('[data-console-server-name]');
  const slugInput = form?.querySelector?.('[data-console-server-slug]');
  if (!nameInput || !slugInput) return true;
  const name = String(nameInput.value || '').trim();
  const slug = String(slugInput.value || '').trim();
  const message = name ? consoleServerSlugValidationMessage(slug) : 'Server name is required.';
  nameInput.setCustomValidity?.(name ? '' : message);
  slugInput.setCustomValidity?.(name ? message : '');
  if (message) {
    setConsoleServerFormError(form, message);
    if (report) (name ? slugInput : nameInput).reportValidity?.();
    return false;
  }
  clearConsoleServerFormError(form);
  return true;
}

function syncConsoleServerSlug(form, { force = false } = {}) {
  const nameInput = form?.querySelector?.('[data-console-server-name]');
  const slugInput = form?.querySelector?.('[data-console-server-slug]');
  if (!nameInput || !slugInput) return;
  if (!force && slugInput.dataset.autoSlug === '0') return;
  slugInput.value = consoleServerSlugFromName(nameInput.value);
  slugInput.dataset.autoSlug = '1';
}

document.addEventListener('input', async (event) => {
  if (event.target.matches?.('[data-action="avatar-crop-scale"]') && avatarCropState) {
    avatarCropState.scale = clampAvatarCropScale(event.target.value);
    clampAvatarCropOffset();
    updateAvatarCropPreview();
    return;
  }

  if (event.target.matches?.('[data-agent-description-input]')) {
    captureAgentDetailFieldDraft(event.target.closest('.agent-inline-edit'));
    const count = event.target.closest('.agent-inline-edit')?.querySelector('[data-agent-description-count]');
    if (count) count.textContent = `${event.target.value.length}/3000`;
    return;
  }
  if (event.target.closest?.('.agent-inline-edit[data-agent-id][data-field]')) {
    captureAgentDetailFieldDraft(event.target.closest('.agent-inline-edit'));
    return;
  }
  if (event.target.closest?.('.computer-name-line[data-computer-id]')) {
    captureComputerNameFieldDraft(event.target.closest('.computer-name-line'));
    return;
  }

  const agentEnvIndex = event.target.dataset.agentEnvIndex;
  const agentEnvField = event.target.dataset.agentEnvField;
  if (agentEnvIndex !== undefined && agentEnvField && agentEnvEditState?.items) {
    const idx = parseInt(agentEnvIndex, 10);
    if (!Number.isNaN(idx) && agentEnvEditState.items[idx]) {
      agentEnvEditState.items[idx][agentEnvField] = event.target.value;
    }
    return;
  }

  const consoleServerForm = event.target.closest?.('#console-server-form');
  if (consoleServerForm) {
    clearConsoleServerFormError(consoleServerForm);
    if (event.target.matches?.('[data-console-server-name]')) {
      if (!event.isComposing && event.inputType !== 'insertCompositionText') {
        syncConsoleServerSlug(consoleServerForm);
      }
      validateConsoleServerForm(consoleServerForm, { report: false });
      return;
    }
    if (event.target.matches?.('[data-console-server-slug]')) {
      event.target.dataset.autoSlug = '0';
      const normalized = consoleServerSlugFromName(event.target.value);
      if (event.target.value !== normalized) event.target.value = normalized;
      if (!normalized) syncConsoleServerSlug(consoleServerForm, { force: true });
      validateConsoleServerForm(consoleServerForm, { report: false });
      return;
    }
  }

  // Handle @ mention autocomplete in message textarea
  const messageTextarea = event.target.closest('textarea[data-mention-input]');
  if (messageTextarea) {
    const { selectionStart, value } = messageTextarea;
    if (messageTextarea.dataset.composerId) composerDrafts[messageTextarea.dataset.composerId] = value;
    const atMatch = findMentionTrigger(value, selectionStart);
    if (atMatch) {
      const lookupSeq = ++mentionLookupSeq;
      const { query, triggerPosition } = atMatch;
      const form = messageTextarea.closest('form');
      const isThread = form?.id === 'reply-form';
      const threadRoot = isThread ? byId(appState.messages, threadMessageId) : null;
      const spaceType = threadRoot?.spaceType || selectedSpaceType;
      const spaceId = threadRoot?.spaceId || selectedSpaceId;
      const peopleItems = getMentionCandidates(query, spaceType, spaceId);
      let projectItems = [];
      try {
        projectItems = await getProjectMentionCandidates(query, spaceType, spaceId);
      } catch (error) {
        console.warn('Project mention search failed', error);
      }
      if (lookupSeq !== mentionLookupSeq) return;
      const items = sortMentionItems([...peopleItems, ...projectItems], query, spaceType, spaceId);
      mentionPopup = {
        active: items.length > 0,
        query,
        items,
        selectedIndex: 0,
        triggerPosition,
        composerId: messageTextarea.dataset.composerId,
      };
      // Re-render just the popup without full render to keep focus
      const popupContainer = messageTextarea.closest('.composer-input-wrapper');
      if (popupContainer) {
        const existingPopup = document.getElementById('mention-popup');
        if (existingPopup) existingPopup.remove();
        if (mentionPopup.active) {
          popupContainer.insertAdjacentHTML('beforeend', renderMentionPopup());
        }
      }
    } else if (mentionPopup.active) {
      mentionLookupSeq += 1;
      mentionPopup.active = false;
      mentionPopup.items = [];
      mentionPopup.composerId = null;
      const existingPopup = document.getElementById('mention-popup');
      if (existingPopup) existingPopup.remove();
    }
    return;
  }

  if (event.target.id === 'search-input') {
    searchQuery = event.target.value;
    searchVisibleCount = SEARCH_PAGE_SIZE;
    if (!searchIsComposing && !event.isComposing && event.inputType !== 'insertCompositionText') {
      updateSearchResults();
    }
    return;
  }

  if (event.target.id === 'add-member-search') {
    addMemberSearchQuery = event.target.value;
    render();
    const input = document.querySelector('#add-member-search');
    input?.focus();
    input?.setSelectionRange(addMemberSearchQuery.length, addMemberSearchQuery.length);
    return;
  }

  if (event.target.id === 'member-invite-input') {
    cloudInviteDraft = event.target.value;
    sanitizeMemberInviteTokens();
    const draftEmails = validInviteEmailsFromValue(cloudInviteDraft);
    if (draftEmails.length === 1 && cloudInviteEmails.includes(draftEmails[0])) {
      cloudInviteDraft = '';
      event.target.value = '';
    }
    const count = document.getElementById('member-invite-count');
    if (count) count.textContent = `${memberInviteValidCount()}/unlimited`;
    const submit = event.target.closest('form')?.querySelector('.member-invite-submit');
    if (submit) submit.disabled = memberInviteValidCount() === 0;
    return;
  }

  if (event.target.id === 'computer-display-name-input') {
    computerPairingDisplayName = String(event.target.value || '').slice(0, 30);
    const code = document.querySelector('.connect-command-shell code');
    if (code) code.textContent = pairingCommandDisplayText();
    return;
  }

  if (event.target.id === 'create-channel-member-search') {
    createChannelMemberSearchQuery = event.target.value;
    render();
    const input = document.querySelector('#create-channel-member-search');
    input?.focus();
    input?.setSelectionRange(createChannelMemberSearchQuery.length, createChannelMemberSearchQuery.length);
    return;
  }

  const profileForm = event.target.closest('#profile-form');
  if (profileForm) {
    if (profileFormIsComposing || event.isComposing || event.inputType === 'insertCompositionText') return;
    captureProfileFormDraft(profileForm);
    if (event.target.name === 'displayName') {
      const hiddenAvatar = profileForm.querySelector('[name="avatar"]')?.value || '';
      if (!hiddenAvatar) setProfileAvatarInput('');
    }
    return;
  }

  // Save agent form state
  const form = event.target.closest('#agent-form');
  if (form) {
    const name = event.target.name;
    if (name === 'name') agentFormState.name = event.target.value;
    if (name === 'description') agentFormState.description = event.target.value;
  }
  // Environment variable input
  const envIndex = event.target.dataset.envIndex;
  const envField = event.target.dataset.envField;
  if (envIndex !== undefined && envField) {
    const idx = parseInt(envIndex, 10);
    if (!Number.isNaN(idx) && agentFormState.envVars[idx]) {
      agentFormState.envVars[idx][envField] = event.target.value;
    }
  }
});
