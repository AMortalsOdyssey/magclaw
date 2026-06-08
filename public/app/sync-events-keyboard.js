function bootstrapStatePath() {
  const params = new URLSearchParams();
  params.set('spaceType', selectedSpaceType || 'channel');
  params.set('spaceId', selectedSpaceId || '');
  if (threadMessageId) params.set('threadMessageId', threadMessageId);
  params.set('messageLimit', '80');
  params.set('threadRootLimit', '160');
  params.set('taskLimit', '160');
  params.set('directoryFormat', 'tuple-v1');
  params.set('directoryScope', 'visible');
  if (selectedAgentId) params.set('selectedAgentId', selectedAgentId);
  if (selectedHumanId) params.set('selectedHumanId', selectedHumanId);
  return `/api/bootstrap?${params.toString()}`;
}

function directoryStatePath() {
  const params = new URLSearchParams();
  params.set('directoryFormat', 'tuple-v1');
  return `/api/directory?${params.toString()}`;
}

function normalizeIncomingStateSnapshot(nextState) {
  return typeof normalizeStateDirectorySnapshot === 'function'
    ? normalizeStateDirectorySnapshot(nextState)
    : nextState;
}

function preserveIncomingDirectorySnapshot(previousState, nextState) {
  return typeof preserveLoadedDirectorySnapshot === 'function'
    ? preserveLoadedDirectorySnapshot(previousState, nextState)
    : nextState;
}

let directoryHydrationInFlight = null;
let directoryHydrationScheduled = false;

function currentDirectoryIsFull() {
  return typeof directorySnapshotIsFull === 'function'
    ? directorySnapshotIsFull(appState)
    : appState?.bootstrap?.directory?.scope === 'full';
}

function resetDirectoryLookupCaches() {
  stateEntityLookupCache = null;
  workspaceHumansCache = null;
  workspaceAgentsCache = null;
}

function applyDirectorySnapshot(directorySnapshot, { renderAfter = true } = {}) {
  if (!directorySnapshot || !appState || typeof mergeStateDirectorySnapshot !== 'function') return false;
  const nextState = mergeStateDirectorySnapshot(appState, directorySnapshot);
  if (nextState === appState) return false;
  appState = nextState;
  resetDirectoryLookupCaches();
  if (renderAfter) render();
  return true;
}

async function ensureFullDirectory({ renderAfter = true } = {}) {
  if (!appState || currentDirectoryIsFull()) return false;
  if (directoryHydrationInFlight) return directoryHydrationInFlight;
  directoryHydrationInFlight = (async () => {
    const snapshot = await api(directoryStatePath());
    return applyDirectorySnapshot(normalizeIncomingStateSnapshot(snapshot), { renderAfter });
  })().catch((error) => {
    console.warn('Failed to hydrate member directory:', error);
    return false;
  }).finally(() => {
    directoryHydrationInFlight = null;
  });
  return directoryHydrationInFlight;
}

function scheduleFullDirectoryHydration() {
  if (directoryHydrationScheduled || currentDirectoryIsFull()) return;
  directoryHydrationScheduled = true;
  const hydrate = () => {
    directoryHydrationScheduled = false;
    ensureFullDirectory({ renderAfter: true }).catch(() => {});
  };
  if (typeof window.requestIdleCallback === 'function') {
    window.requestIdleCallback(hydrate, { timeout: 1500 });
  } else {
    window.setTimeout(hydrate, 500);
  }
}

let packageVersionRefreshInFlight = null;

function packageVersionSnapshotIsFresh(snapshot) {
  const fetchedAtMs = Number(snapshot?.fetchedAtMs || 0);
  if (!fetchedAtMs) return false;
  return Date.now() - fetchedAtMs < PACKAGE_VERSION_CACHE_TTL_MS;
}

function readCachedPackageVersionSnapshot() {
  try {
    const raw = localStorage.getItem(PACKAGE_VERSION_CACHE_KEY);
    if (!raw) return null;
    const snapshot = JSON.parse(raw);
    return packageVersionSnapshotIsFresh(snapshot) ? snapshot : null;
  } catch {
    return null;
  }
}

function writeCachedPackageVersionSnapshot(snapshot) {
  if (!snapshot?.packages) return;
  try {
    localStorage.setItem(PACKAGE_VERSION_CACHE_KEY, JSON.stringify({
      ...snapshot,
      fetchedAtMs: Date.now(),
      cacheTtlMs: PACKAGE_VERSION_CACHE_TTL_MS,
    }));
  } catch {
    // Browser storage can be unavailable in private or embedded contexts.
  }
}

function packageLatestFromSnapshot(snapshot, packageName) {
  const record = snapshot?.packages?.[packageName];
  return String(record?.latest || record?.version || '').trim();
}

function applyPackageVersionSnapshot(snapshot, { persist = false } = {}) {
  if (!appState || !snapshot?.packages) return false;
  const daemonLatest = packageLatestFromSnapshot(snapshot, '@magclaw/daemon');
  const computerLatest = packageLatestFromSnapshot(snapshot, '@magclaw/computer');
  if (!daemonLatest && !computerLatest) return false;
  const runtime = { ...(appState.runtime || {}) };
  let changed = false;
  if (daemonLatest && runtime.daemonLatestVersion !== daemonLatest) {
    runtime.daemonLatestVersion = daemonLatest;
    changed = true;
  }
  if (computerLatest && runtime.computerLatestVersion !== computerLatest) {
    runtime.computerLatestVersion = computerLatest;
    changed = true;
  }
  if (changed) appState = { ...appState, runtime };
  if (persist) writeCachedPackageVersionSnapshot(snapshot);
  return changed;
}

async function ensurePackageVersionsForCurrentServer({ renderAfter = true } = {}) {
  const cached = readCachedPackageVersionSnapshot();
  if (cached) {
    const changed = applyPackageVersionSnapshot(cached);
    if (changed && renderAfter) render();
    return changed;
  }
  if (packageVersionRefreshInFlight) return packageVersionRefreshInFlight;
  packageVersionRefreshInFlight = (async () => {
    const snapshot = await api('/api/package-versions');
    const changed = applyPackageVersionSnapshot(snapshot, { persist: true });
    if (changed && renderAfter) render();
    return changed;
  })().catch((error) => {
    console.warn('Failed to load package versions:', error);
    return false;
  }).finally(() => {
    packageVersionRefreshInFlight = null;
  });
  return packageVersionRefreshInFlight;
}

async function ensureComputerPackageVersionsForComputersPage(options = {}) {
  return ensurePackageVersionsForCurrentServer(options);
}

function refreshPackageVersionReminders() {
  ensurePackageVersionsForCurrentServer().catch((error) => console.warn('Failed to load package versions:', error));
}

async function refreshState() {
  rememberPinnedBottomBeforeStateChange();
  const nextState = await api(bootstrapStatePath());
  const normalizedNextState = normalizeIncomingStateSnapshot(nextState);
  if (normalizedNextState !== nextState) Object.assign(nextState, normalizedNextState);
  const preservedNextState = preserveIncomingDirectorySnapshot(appState, nextState);
  if (preservedNextState !== nextState) Object.assign(nextState, preservedNextState);
  trackFanoutRouteEvents(nextState, { silent: !initialLoadComplete || !appState });
  trackAgentNotifications(nextState, { silent: !initialLoadComplete || !appState });
  appState = nextState;
  syncBootstrapPagination(appState);
  if (typeof loadStoredComposerDrafts === 'function') loadStoredComposerDrafts();
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
    const switchedState = await api(bootstrapStatePath());
    appState = normalizeIncomingStateSnapshot(switchedState);
    syncBootstrapPagination(appState);
    if (typeof loadStoredComposerDrafts === 'function') loadStoredComposerDrafts({ force: true });
    if (typeof applyMagclawAccountLanguage === 'function') applyMagclawAccountLanguage(appState);
  }
  if (appState.cloud?.workspaceAccess?.denied) {
    syncBrowserRouteForActiveView({ replace: true });
  }
  startHumanPresenceHeartbeat();
  if (!installedRuntimes.length && (selectedAgentId || activeView === 'members' || activeView === 'computers')) {
    await loadInstalledRuntimes().catch(() => {});
  }
  applyPackageVersionSnapshot(readCachedPackageVersionSnapshot());
  render();
  scheduleFullDirectoryHydration();
  refreshPackageVersionReminders();
}

function cloudAuthErrorMessage(error, { interactive = false } = {}) {
  if (!error) return '';
  if (error.status === 401) return interactive ? 'Email or password is incorrect.' : '';
  return error.message || '';
}

function cloudAuthTokenFromLocation() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token') || '';
  const returnTo = String(params.get('returnTo') || '').trim();
  const path = window.location.pathname || '';
  if (params.get('authLink') === 'feishu') return { mode: 'oauth-link', token: '', returnTo };
  if (path.startsWith('/create-account')) return { mode: 'create', token: '', returnTo };
  if (path.startsWith('/forgot-password/check-email')) {
    return { mode: 'forgot-sent', token: '', email: params.get('email') || '', returnTo };
  }
  if (path.startsWith('/forgot-password')) return { mode: 'forgot', token: '', returnTo };
  const joinMatch = path.match(/^\/join\/([^/]+)/);
  if (joinMatch) return { mode: 'join', token: decodeURIComponent(joinMatch[1] || ''), returnTo };
  if (!token) return { mode: '', token: '', returnTo };
  if (path.includes('reset-password') || token.startsWith('mc_reset_')) return { mode: 'reset', token, returnTo };
  return { mode: 'invite', token, returnTo };
}

function cloudAuthCallbackFromLocation() {
  const params = new URLSearchParams(window.location.search);
  return String(params.get('authCallback') || params.get('auth_callback') || '').trim();
}

function clearCloudAuthCallbackFromLocation() {
  const callbackProvider = cloudAuthCallbackFromLocation();
  if (!callbackProvider || !window.history?.replaceState) return;
  const params = new URLSearchParams(window.location.search);
  params.delete('authCallback');
  params.delete('auth_callback');
  const nextSearch = params.toString();
  window.history.replaceState({}, '', `${window.location.pathname || '/'}${nextSearch ? `?${nextSearch}` : ''}${window.location.hash || ''}`);
}

function cloudAuthErrorFromLocation() {
  const params = new URLSearchParams(window.location.search);
  return String(params.get('authError') || '').trim();
}

async function loadCloudAuthTokenContext() {
  const context = cloudAuthTokenFromLocation();
  if (context.mode === 'oauth-link') {
    try {
      const status = await api('/api/cloud/auth/feishu/link-status');
      return { ...context, oauthLink: status || {} };
    } catch (error) {
      return { ...context, error: error.message || 'Feishu link confirmation is no longer available.' };
    }
  }
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
  const authErrorMessage = cloudAuthErrorMessage(error, options) || cloudAuthErrorFromLocation();
  const tokenContext = await loadCloudAuthTokenContext();
  renderCloudAuthGate(cloud, authErrorMessage, tokenContext);
}

async function refreshStateOrAuthGate() {
  if (cloudAuthTokenFromLocation().mode) {
    await showCloudAuthGate(null);
    return false;
  }
  const callbackProvider = cloudAuthCallbackFromLocation();
  if (callbackProvider) renderCloudAuthCallbackGate(callbackProvider);
  try {
    await refreshState();
    clearCloudAuthCallbackFromLocation();
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

function patchRailSurface(railSnapshot = railScrollSnapshot()) {
  const rail = document.querySelector('.collab-rail');
  if (rail) rail.replaceWith(htmlToElement(renderRail()));
  restoreRailScroll(railSnapshot);
}

function patchDmHeaderSurface() {
  if (activeView !== 'space' || selectedSpaceType !== 'dm') return false;
  const header = document.querySelector('.dm-space-header');
  if (!header) return false;
  const next = htmlToElement(renderDmHeader());
  if (!next) return false;
  if (header.outerHTML !== next.outerHTML) header.replaceWith(next);
  return true;
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

function conversationPageKey(spaceType = selectedSpaceType, spaceId = selectedSpaceId) {
  return `${spaceType || 'channel'}:${spaceId || ''}`;
}

function threadPageKey(messageId = threadMessageId) {
  return String(messageId || '');
}

function taskPageKey(spaceType = selectedSpaceType, spaceId = selectedSpaceId) {
  return `${spaceType || 'channel'}:${spaceId || ''}`;
}

function normalizePageInfo(value = {}, fallbackLimit = CONVERSATION_HISTORY_PAGE_SIZE) {
  return {
    limit: Number(value.limit || fallbackLimit),
    hasMore: Boolean(value.hasMore),
    nextBefore: value.nextBefore || '',
    nextBeforeId: value.nextBeforeId || '',
  };
}

function normalizeTaskPageInfo(value = {}, fallbackLimit = TASK_HISTORY_PAGE_SIZE) {
  return {
    limit: Number(value.limit || fallbackLimit),
    loaded: Number(value.loaded || 0),
    total: Number(value.total || 0),
    hasMore: Boolean(value.hasMore),
    nextBefore: value.nextBefore || '',
    nextBeforeId: value.nextBeforeId || '',
  };
}

function taskPageCursorRank(pageInfo = {}) {
  const time = Date.parse(pageInfo.nextBefore || '');
  return {
    time: Number.isFinite(time) ? time : Number.POSITIVE_INFINITY,
    id: String(pageInfo.nextBeforeId || ''),
  };
}

function mergeTaskPageInfo(existing = null, incoming = {}) {
  const next = normalizeTaskPageInfo(incoming);
  if (!existing) return next;
  const current = normalizeTaskPageInfo(existing);
  if (current.hasMore === false && current.nextBefore) {
    return { ...next, ...current, total: Math.max(next.total, current.total) };
  }
  const currentRank = taskPageCursorRank(current);
  const nextRank = taskPageCursorRank(next);
  const currentIsOlder = currentRank.time < nextRank.time
    || (currentRank.time === nextRank.time && currentRank.id && nextRank.id && currentRank.id.localeCompare(nextRank.id) < 0);
  if (currentIsOlder) {
    return {
      ...next,
      ...current,
      loaded: Math.max(next.loaded, current.loaded),
      total: Math.max(next.total, current.total),
    };
  }
  return next;
}

function updateMainHistoryPage(spaceType, spaceId, pagination = {}) {
  const key = conversationPageKey(spaceType, spaceId);
  conversationHistoryPages.main[key] = normalizePageInfo(pagination);
}

function updateThreadHistoryPage(messageId, pagination = {}) {
  const key = threadPageKey(messageId);
  if (!key) return;
  conversationHistoryPages.thread[key] = normalizePageInfo(pagination);
}

function currentMainHistoryPage() {
  return conversationHistoryPages.main[conversationPageKey()] || {
    limit: CONVERSATION_HISTORY_PAGE_SIZE,
    hasMore: Boolean(appState?.bootstrap?.hasMoreMessages),
    nextBefore: appState?.bootstrap?.nextBefore || '',
    nextBeforeId: appState?.bootstrap?.nextBeforeId || '',
  };
}

function currentThreadHistoryPage(messageId = threadMessageId) {
  return conversationHistoryPages.thread[threadPageKey(messageId)] || {
    limit: CONVERSATION_HISTORY_PAGE_SIZE,
    hasMore: false,
    nextBefore: '',
    nextBeforeId: '',
  };
}

function updateSpaceTaskPage(spaceType, spaceId, pagination = {}) {
  const key = taskPageKey(spaceType, spaceId);
  taskHistoryPages.space[key] = mergeTaskPageInfo(taskHistoryPages.space[key], pagination);
}

function updateGlobalTaskPage(pagination = {}) {
  taskHistoryPages.global = mergeTaskPageInfo(taskHistoryPages.global, pagination);
}

function currentSpaceTaskPage(spaceType = selectedSpaceType, spaceId = selectedSpaceId) {
  const key = taskPageKey(spaceType, spaceId);
  return taskHistoryPages.space[key] || normalizeTaskPageInfo(appState?.bootstrap?.tasks?.space || {});
}

function currentGlobalTaskPage() {
  return taskHistoryPages.global || normalizeTaskPageInfo(appState?.bootstrap?.tasks?.global || {});
}

function currentTaskSurfacePage(scope = '') {
  if (scope === 'global' || activeView === 'tasks') return currentGlobalTaskPage();
  return currentSpaceTaskPage();
}

function syncBootstrapPagination(stateSnapshot = appState) {
  const bootstrap = stateSnapshot?.bootstrap || {};
  if (bootstrap.spaceType && bootstrap.spaceId) {
    updateMainHistoryPage(bootstrap.spaceType, bootstrap.spaceId, {
      limit: bootstrap.messageLimit || CONVERSATION_HISTORY_PAGE_SIZE,
      hasMore: bootstrap.hasMoreMessages,
      nextBefore: bootstrap.nextBefore,
      nextBeforeId: bootstrap.nextBeforeId,
    });
  }
  if (bootstrap.threadReplies && threadMessageId) {
    updateThreadHistoryPage(threadMessageId, bootstrap.threadReplies);
  }
  if (bootstrap.tasks?.space && bootstrap.spaceType && bootstrap.spaceId) {
    updateSpaceTaskPage(bootstrap.spaceType, bootstrap.spaceId, bootstrap.tasks.space);
  }
  if (bootstrap.tasks?.global) {
    updateGlobalTaskPage(bootstrap.tasks.global);
  }
}

function conversationRecordFreshnessTime(record) {
  return Math.max(
    Date.parse(record?.updatedAt || '') || 0,
    Date.parse(record?.createdAt || '') || 0,
  );
}

function mergeConversationRecordKeepingFreshest(existing = null, incoming = null) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  const existingIsFreshest = conversationRecordFreshnessTime(existing) >= conversationRecordFreshnessTime(incoming);
  const merged = existingIsFreshest
    ? { ...incoming, ...existing }
    : { ...existing, ...incoming };
  if (existing.replyCount !== undefined || incoming.replyCount !== undefined) {
    merged.replyCount = Math.max(Number(existing.replyCount || 0), Number(incoming.replyCount || 0));
  }
  return merged;
}

function mergeSpaceMessagePageIntoState(stateSnapshot, spaceType, spaceId, messages = []) {
  if (!stateSnapshot || !spaceType || !spaceId) return stateSnapshot;
  const incoming = (messages || []).filter((message) => (
    message?.id && message.spaceType === spaceType && message.spaceId === spaceId
  ));
  if (!incoming.length) return stateSnapshot;
  const messageById = new Map((stateSnapshot.messages || []).map((message) => [message.id, message]));
  for (const message of incoming) {
    messageById.set(message.id, mergeConversationRecordKeepingFreshest(messageById.get(message.id), message));
  }
  return {
    ...stateSnapshot,
    messages: [...messageById.values()]
      .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)),
  };
}

function mergeThreadReplyPageIntoState(stateSnapshot, parentMessageId, replies = []) {
  if (!stateSnapshot || !parentMessageId) return stateSnapshot;
  const incoming = (replies || []).filter((reply) => reply?.id && reply.parentMessageId === parentMessageId);
  if (!incoming.length) return stateSnapshot;

  const replyById = new Map((stateSnapshot.replies || []).map((reply) => [reply.id, reply]));
  for (const reply of incoming) {
    replyById.set(reply.id, { ...(replyById.get(reply.id) || {}), ...reply });
  }
  const mergedReplies = [...replyById.values()]
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  const parentReplies = mergedReplies.filter((reply) => reply.parentMessageId === parentMessageId);
  const latestReply = parentReplies.at(-1);
  const messages = (stateSnapshot.messages || []).map((message) => {
    if (message?.id !== parentMessageId) return message;
    return {
      ...message,
      replyCount: Math.max(Number(message.replyCount || 0), parentReplies.length),
      updatedAt: latestReply?.createdAt || latestReply?.updatedAt || message.updatedAt,
    };
  });

  return {
    ...stateSnapshot,
    messages,
    replies: mergedReplies,
  };
}

function taskRecordFreshnessTime(record) {
  return Math.max(
    Date.parse(record?.updatedAt || '') || 0,
    Date.parse(record?.createdAt || '') || 0,
  );
}

function mergeTaskRecordKeepingFreshest(existing = null, incoming = null) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  return taskRecordFreshnessTime(existing) >= taskRecordFreshnessTime(incoming)
    ? { ...incoming, ...existing }
    : { ...existing, ...incoming };
}

function mergeTaskPageIntoState(stateSnapshot, tasks = []) {
  if (!stateSnapshot) return stateSnapshot;
  const incoming = (tasks || []).filter((task) => task?.id);
  if (!incoming.length) return stateSnapshot;
  const taskById = new Map((stateSnapshot.tasks || []).map((task) => [task.id, task]));
  for (const task of incoming) {
    taskById.set(task.id, mergeTaskRecordKeepingFreshest(taskById.get(task.id), task));
  }
  const mergedTasks = [...taskById.values()]
    .sort((a, b) => {
      const timeDiff = taskRecordFreshnessTime(b) - taskRecordFreshnessTime(a);
      if (timeDiff) return timeDiff;
      return String(b?.id || '').localeCompare(String(a?.id || ''));
    });
  return { ...stateSnapshot, tasks: mergedTasks };
}

async function refreshOpenThreadReplies(parentMessageId = threadMessageId) {
  const messageId = String(parentMessageId || '').trim();
  if (!messageId || !appState) return false;
  const result = await api(`/api/messages/${encodeURIComponent(messageId)}/replies?limit=${CONVERSATION_HISTORY_PAGE_SIZE}`);
  if (!appState || threadMessageId !== messageId) return false;
  updateThreadHistoryPage(messageId, result.pagination || {});
  const nextState = mergeThreadReplyPageIntoState(appState, messageId, result.replies || []);
  if (nextState === appState) return false;
  applyStateUpdate(nextState);
  return true;
}

async function refreshActiveSpaceMessages(spaceType = selectedSpaceType, spaceId = selectedSpaceId) {
  const targetType = String(spaceType || '').trim();
  const targetId = String(spaceId || '').trim();
  if (!appState || !targetType || !targetId) return false;
  const params = new URLSearchParams();
  params.set('limit', String(CONVERSATION_HISTORY_PAGE_SIZE));
  const result = await api(`/api/spaces/${targetType}/${targetId}/messages?${params.toString()}`);
  if (!appState || selectedSpaceType !== targetType || selectedSpaceId !== targetId) return false;
  updateMainHistoryPage(targetType, targetId, result.pagination || {});
  const nextState = mergeSpaceMessagePageIntoState(appState, targetType, targetId, result.messages || []);
  if (nextState === appState) return false;
  applyStateUpdate(nextState);
  return true;
}

function refreshThreadSelection(messageId = threadMessageId, { loadReplies = true } = {}) {
  if (typeof connectEvents === 'function') connectEvents();
  if (!loadReplies || !messageId) return;
  refreshOpenThreadReplies(messageId).catch((error) => {
    console.warn('Failed to load thread replies:', error);
  });
}

function preserveLoadedConversationHistory(previousState, nextState) {
  if (!previousState || !nextState) return nextState;
  let merged = nextState;
  const mainKey = conversationPageKey();
  const mainPage = conversationHistoryPages.main[mainKey];
  if (mainPage) {
    const previousMessages = stateSpaceMessages(previousState, selectedSpaceType, selectedSpaceId)
      .filter((record) => record.optimistic !== true);
    merged = mergeSpaceMessagePageIntoState(merged, selectedSpaceType, selectedSpaceId, previousMessages);
  }
  const threadKey = threadPageKey();
  const threadPage = conversationHistoryPages.thread[threadKey];
  if (threadKey && threadPage) {
    const previousReplies = stateThreadReplies(previousState, threadKey)
      .filter((record) => record.optimistic !== true);
    merged = mergeThreadReplyPageIntoState(merged, threadKey, previousReplies);
  }
  const taskPages = typeof taskHistoryPages !== 'undefined' ? taskHistoryPages : { space: {}, global: null };
  if (taskPages.global) {
    const previousGlobalTasks = (previousState.tasks || [])
      .filter((task) => task?.spaceType === 'channel');
    merged = mergeTaskPageIntoState(merged, previousGlobalTasks);
  }
  for (const key of Object.keys(taskPages.space || {})) {
    const separator = key.indexOf(':');
    const spaceType = separator >= 0 ? key.slice(0, separator) : '';
    const spaceId = separator >= 0 ? key.slice(separator + 1) : '';
    if (!spaceType || !spaceId) continue;
    const previousSpaceTasks = (previousState.tasks || [])
      .filter((task) => task?.spaceType === spaceType && String(task.spaceId || '') === spaceId);
    merged = mergeTaskPageIntoState(merged, previousSpaceTasks);
  }
  return merged;
}

function restorePrependedScroll(targetName, beforeHeight, beforeTop) {
  const selector = targetName === 'thread' ? '#thread-context' : '#message-list';
  const apply = () => {
    const node = document.querySelector(selector);
    if (!node) return;
    const heightDelta = Math.max(0, node.scrollHeight - beforeHeight);
    node.scrollTop = Math.max(0, beforeTop + heightDelta);
    persistPaneScroll(targetName, node);
    updateBackBottomVisibility(targetName);
  };
  window.requestAnimationFrame(apply);
  window.setTimeout(apply, 40);
}

async function loadOlderMainMessages() {
  if (!appState || activeView !== 'space' || activeTab !== 'chat') return false;
  const key = conversationPageKey();
  const pageInfo = currentMainHistoryPage();
  if (!pageInfo.hasMore || !pageInfo.nextBefore || conversationHistoryLoading.main[key]) return false;
  const node = document.querySelector('#message-list');
  const beforeHeight = node?.scrollHeight || 0;
  const beforeTop = node?.scrollTop || 0;
  conversationHistoryLoading.main[key] = true;
  try {
    const params = new URLSearchParams();
    params.set('limit', String(CONVERSATION_HISTORY_PAGE_SIZE));
    params.set('before', pageInfo.nextBefore);
    if (pageInfo.nextBeforeId) params.set('beforeId', pageInfo.nextBeforeId);
    const result = await api(`/api/spaces/${selectedSpaceType}/${selectedSpaceId}/messages?${params.toString()}`);
    if (key !== conversationPageKey()) return false;
    updateMainHistoryPage(selectedSpaceType, selectedSpaceId, result.pagination || {});
    const nextState = mergeSpaceMessagePageIntoState(appState, selectedSpaceType, selectedSpaceId, result.messages || []);
    if (nextState !== appState) applyStateUpdate(nextState);
    restorePrependedScroll('main', beforeHeight, beforeTop);
    return true;
  } catch (error) {
    console.warn('Failed to load older messages:', error);
    return false;
  } finally {
    conversationHistoryLoading.main[key] = false;
  }
}

async function loadOlderThreadReplies() {
  const messageId = threadPageKey();
  if (!appState || activeView !== 'space' || activeTab !== 'chat' || !messageId) return false;
  const pageInfo = currentThreadHistoryPage(messageId);
  if (!pageInfo.hasMore || !pageInfo.nextBefore || conversationHistoryLoading.thread[messageId]) return false;
  const node = document.querySelector('#thread-context');
  const beforeHeight = node?.scrollHeight || 0;
  const beforeTop = node?.scrollTop || 0;
  conversationHistoryLoading.thread[messageId] = true;
  try {
    const params = new URLSearchParams();
    params.set('limit', String(CONVERSATION_HISTORY_PAGE_SIZE));
    params.set('before', pageInfo.nextBefore);
    if (pageInfo.nextBeforeId) params.set('beforeId', pageInfo.nextBeforeId);
    const result = await api(`/api/messages/${encodeURIComponent(messageId)}/replies?${params.toString()}`);
    if (messageId !== threadPageKey()) return false;
    updateThreadHistoryPage(messageId, result.pagination || {});
    const nextState = mergeThreadReplyPageIntoState(appState, messageId, result.replies || []);
    if (nextState !== appState) applyStateUpdate(nextState);
    restorePrependedScroll('thread', beforeHeight, beforeTop);
    return true;
  } catch (error) {
    console.warn('Failed to load older thread replies:', error);
    return false;
  } finally {
    conversationHistoryLoading.thread[messageId] = false;
  }
}

async function loadOlderTasks(scope = '') {
  if (!appState) return false;
  const targetScope = scope === 'global' || activeView === 'tasks' ? 'global' : 'space';
  const pageInfo = targetScope === 'global' ? currentGlobalTaskPage() : currentSpaceTaskPage();
  const loadingKey = targetScope === 'global' ? 'global' : taskPageKey();
  const isLoading = targetScope === 'global'
    ? taskHistoryLoading.global
    : taskHistoryLoading.space[loadingKey];
  if (!pageInfo.hasMore || !pageInfo.nextBefore || isLoading) return false;
  if (targetScope === 'global') taskHistoryLoading.global = true;
  else taskHistoryLoading.space[loadingKey] = true;
  try {
    const params = new URLSearchParams();
    params.set('limit', String(TASK_HISTORY_PAGE_SIZE));
    params.set('before', pageInfo.nextBefore);
    if (pageInfo.nextBeforeId) params.set('beforeId', pageInfo.nextBeforeId);
    if (targetScope === 'global') {
      params.set('spaceType', 'channel');
    } else {
      params.set('spaceType', selectedSpaceType || 'channel');
      params.set('spaceId', selectedSpaceId || '');
    }
    const result = await api(`/api/tasks?${params.toString()}`);
    if (targetScope === 'space' && loadingKey !== taskPageKey()) return false;
    if (targetScope === 'global') updateGlobalTaskPage(result.pagination || {});
    else updateSpaceTaskPage(selectedSpaceType, selectedSpaceId, result.pagination || {});
    const nextState = mergeTaskPageIntoState(appState, result.tasks || []);
    if (nextState !== appState) applyStateUpdate(nextState);
    return true;
  } catch (error) {
    console.warn('Failed to load older tasks:', error);
    return false;
  } finally {
    if (targetScope === 'global') taskHistoryLoading.global = false;
    else taskHistoryLoading.space[loadingKey] = false;
  }
}

function maybeLoadOlderConversationHistory(targetName, node) {
  if (!node || node.scrollTop > CONVERSATION_HISTORY_TOP_THRESHOLD) return;
  if (targetName === 'thread') {
    loadOlderThreadReplies();
  } else {
    loadOlderMainMessages();
  }
}

function taskVisiblePatchSignature(task) {
  if (!task) return '';
  const history = (Array.isArray(task.history) ? task.history : [])
    .slice(-4)
    .map((item) => [
      item?.type || '',
      item?.actorId || '',
      item?.at || '',
    ]);
  return JSON.stringify({
    id: task.id || '',
    number: task.number || '',
    status: task.status || '',
    claimedBy: task.claimedBy || '',
    assigneeIds: task.assigneeIds || [],
    history,
  });
}

function recordPatchSignature(record, stateSnapshot = appState) {
  const task = record?.taskId ? byId(stateSnapshot?.tasks, record.taskId) : null;
  return [
    record?.id || '',
    record?.updatedAt || '',
    record?.createdAt || '',
    record?.body || '',
    record?.replyCount || 0,
    record?.taskId || '',
    taskVisiblePatchSignature(task),
    actorStatusRenderKey(record?.authorId, record?.authorType, stateSnapshot),
    (record?.attachmentIds || []).join(','),
    (record?.savedBy || []).join(','),
    deliveryReceiptSignature(record),
  ].join('::');
}

function activeConversationSignature(stateSnapshot = appState) {
  if (!stateSnapshot) return '';
  if (threadMessageId) {
    const root = byId(stateSnapshot.messages, threadMessageId);
    const threadRecords = root ? [root, ...stateThreadReplies(stateSnapshot, root.id)] : [];
    const visibleSpaceRecords = activeView === 'space' && activeTab === 'chat'
      ? stateSpaceMessages(stateSnapshot)
      : [];
    const seen = new Set();
    const records = [...visibleSpaceRecords, ...threadRecords].filter((record) => {
      if (!record?.id || seen.has(record.id)) return false;
      seen.add(record.id);
      return true;
    });
    return records.map((record) => recordPatchSignature(record, stateSnapshot)).join('|');
  }
  if (activeView !== 'space' || activeTab !== 'chat') return '';
  return stateSpaceMessages(stateSnapshot)
    .map((record) => recordPatchSignature(record, stateSnapshot))
    .join('|');
}

function taskSurfaceTaskSignature(task) {
  return [
    task?.id || '',
    task?.number || '',
    task?.spaceType || '',
    task?.spaceId || '',
    task?.status || '',
    task?.title || '',
    task?.claimedBy || '',
    (task?.assigneeIds || []).join(','),
  ].join('::');
}

function stateSpaceTasks(stateSnapshot = appState) {
  return (stateSnapshot?.tasks || [])
    .filter((task) => task.spaceType === selectedSpaceType && task.spaceId === selectedSpaceId)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
}

function stateVisibleGlobalTasks(stateSnapshot = appState) {
  return (stateSnapshot?.tasks || [])
    .filter((task) => task?.spaceType === 'channel')
    .filter((task) => !taskChannelFilterIds.length || taskChannelFilterIds.includes(task.spaceId))
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
}

function taskColumnStateSignature() {
  const collapsed = {};
  for (const [status] of taskColumns || []) {
    collapsed[status] = Boolean(collapsedTaskColumns?.[status]);
  }
  return collapsed;
}

function taskViewModeForSignature() {
  if (typeof taskViewModeForScope === 'function') {
    const scope = typeof taskViewScope === 'function' ? taskViewScope() : 'global';
    return taskViewModeForScope(scope);
  }
  return taskViewMode || 'board';
}

function visibleTaskSurfaceSignature(stateSnapshot = appState) {
  if (!stateSnapshot) return '';
  if (activeView === 'space' && activeTab === 'tasks') {
    return JSON.stringify({
      surface: 'space-tasks',
      spaceType: selectedSpaceType || '',
      spaceId: selectedSpaceId || '',
      viewMode: taskViewModeForSignature(),
      collapsed: taskColumnStateSignature(),
      tasks: stateSpaceTasks(stateSnapshot).map(taskSurfaceTaskSignature),
    });
  }
  if (activeView === 'tasks') {
    return JSON.stringify({
      surface: 'global-tasks',
      viewMode: taskViewModeForSignature(),
      filters: [...(taskChannelFilterIds || [])].sort(),
      collapsed: taskColumnStateSignature(),
      tasks: stateVisibleGlobalTasks(stateSnapshot).map(taskSurfaceTaskSignature),
    });
  }
  return '';
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

function fanoutApiSettingsSignature(stateSnapshot = appState) {
  const config = stateSnapshot?.settings?.fanoutApi || {};
  const canManage = Boolean(stateSnapshot?.cloud?.auth?.capabilities?.manage_system);
  return JSON.stringify([
    canManage,
    Boolean(config.configured),
    Boolean(config.enabled),
    config.baseUrl || '',
    config.model || '',
    config.fallbackModel || '',
    config.timeoutMs || '',
    (config.forceKeywords || []).join('\n'),
    Boolean(config.hasApiKey),
    config.apiKeyPreview || '',
  ]);
}

function serverSettingsVisibleSignature(stateSnapshot = appState) {
  return JSON.stringify({
    profile: serverProfilePatchSignature(stateSnapshot),
    support: serverSettingsSupportSignature(stateSnapshot),
    fanoutApi: fanoutApiSettingsSignature(stateSnapshot),
  });
}

function agentDetailProfileSignature(stateSnapshot = appState) {
  if (!selectedAgentId || normalizeAgentDetailTab(agentDetailTab) !== 'profile') return '';
  const agent = byId(stateSnapshot?.agents, selectedAgentId);
  if (!agent || agentDetailTabIsLoading(agent)) return '';
  const computer = agent.computerId ? byId(stateSnapshot?.computers, agent.computerId) : null;
  const creator = agentCreatorInfo(agent);
  const runtimeOptions = runtimeOptionsForAgent(agent).map((runtime) => [
    runtime?.id || '',
    runtime?.name || '',
    runtime?.installed !== false,
    runtime?.createSupported !== false,
    runtime?.defaultModel || '',
    runtime?.defaultReasoningEffort || '',
    (runtime?.models || []).join('\n'),
    (runtime?.modelNames || []).map((model) => `${model?.slug || model}:${model?.name || model}`).join('\n'),
    (runtime?.reasoningEffort || []).join('\n'),
  ]);
  return JSON.stringify({
    agent: [
      agent.id || '',
      agent.name || '',
      agent.description || '',
      agent.avatar || '',
      agent.runtime || '',
      agent.runtimeId || '',
      agent.model || '',
      agent.reasoningEffort || '',
      agent.computerId || '',
      agent.workspace || '',
      agent.createdAt || '',
      agent.createdByHumanId || '',
      agent.createdByUserId || '',
      agent.creatorName || '',
      agent.creatorEmail || '',
      agent.deletedAt || '',
      agent.archivedAt || '',
    ],
    computer: [
      computer?.id || '',
      computer?.name || '',
      computer?.daemonVersion || '',
      computer?.version || '',
      computer?.deletedAt || '',
      computer?.archivedAt || '',
      computer?.disabledAt || '',
    ],
    creator: [creator.name || '', creator.username || '', creator.userId || ''],
    envVars: (agent.envVars || []).map((item) => [item?.key || '', item?.value || '']),
    runtimeOptions,
    editField: agentDetailEditState?.field || '',
    envEditAgentId: agentEnvEditState?.agentId || '',
  });
}

function agentDetailVisibleSignature(stateSnapshot = appState) {
  if (!selectedAgentId) return '';
  const agent = byId(stateSnapshot?.agents, selectedAgentId);
  if (!agent || agentDetailTabIsLoading(agent)) return '';
  const tab = normalizeAgentDetailTab(agentDetailTab);
  if (tab === 'profile') return agentDetailProfileSignature(stateSnapshot);
  return JSON.stringify({
    tab,
    agentId: agent.id || '',
    editField: agentDetailEditState?.field || '',
    envEditAgentId: agentEnvEditState?.agentId || '',
    loading: agentDetailTabLoading.agentId === agent.id ? agentDetailTabLoading.tab || '' : '',
  });
}

function agentDetailRuntimeControlIsActive() {
  const active = document.activeElement;
  return Boolean(
    active?.closest?.('#agent-runtime-config-form')
    && ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(active.tagName)
  );
}

function patchAgentDetailLiveSurfaces(agent) {
  const heroStatus = document.querySelector('.agent-profile-hero .agent-hero-status');
  if (heroStatus) {
    heroStatus.innerHTML = `<span class="avatar-status-dot inline ${presenceClass(agentDisplayStatus(agent))}"></span>${escapeHtml(agentStatusLabel(agent))}`;
  }
  const selector = `.agent-live-activity-bar[data-agent-id="${CSS.escape(agent.id)}"]`;
  document.querySelectorAll(selector).forEach((node) => {
    const compact = node.dataset?.compact === 'true';
    node.outerHTML = renderAgentLiveActivityBar(agent, { compact });
  });
}

function patchAgentDetailChrome(agent) {
  const shell = document.querySelector('.agent-detail-shell');
  if (!agent || !shell) return false;
  const topbar = shell.querySelector('.agent-detail-topbar');
  const nextTopbar = htmlToElement(renderAgentDetailTopbar(agent));
  if (topbar && nextTopbar && topbar.outerHTML !== nextTopbar.outerHTML) topbar.replaceWith(nextTopbar);
  const tabs = shell.querySelector('.agent-detail-tabs');
  const nextTabs = htmlToElement(renderAgentDetailTabs());
  if (tabs && nextTabs && tabs.outerHTML !== nextTabs.outerHTML) tabs.replaceWith(nextTabs);
  return true;
}

function patchAgentDetailBody(agent) {
  const shell = document.querySelector('.agent-detail-shell');
  const content = shell?.querySelector('.agent-detail-content');
  if (!agent || !content) return false;
  const tab = normalizeAgentDetailTab(agentDetailTab);
  if (tab === 'profile' && (agentDetailInlineEditIsActive() || agentDetailRuntimeControlIsActive())) return true;
  const nextBody = renderAgentDetailBody(agent);
  if (content.innerHTML.trim() !== nextBody.trim()) {
    content.innerHTML = nextBody;
  }
  return true;
}

function patchAgentDetailSurface(scrollSnapshot = {}) {
  if (!selectedAgentId) return false;
  const agent = byId(appState.agents, selectedAgentId);
  const shell = document.querySelector('.agent-detail-shell');
  if (!agent || !shell) return false;
  patchRailSurface();
  patchAgentDetailChrome(agent);
  if (!agentDetailRuntimeControlIsActive()) patchAgentDetailLiveSurfaces(agent);
  patchAgentDetailBody(agent);
  window.requestAnimationFrame(() => {
    restorePaneScrolls(scrollSnapshot);
    restorePageScroll(scrollSnapshot.page);
  });
  return true;
}

function patchOpenThreadDrawerSurface(scrollSnapshot) {
  if (!threadMessageId || selectedProjectFile || selectedAgentId || selectedTaskId) return false;
  const message = byId(appState.messages, threadMessageId);
  const context = document.querySelector('#thread-context');
  const panel = document.querySelector('.thread-drawer');
  if (!message || !context || !panel) return false;

  const replies = threadReplies(message.id);
  const task = message.taskId ? byId(appState.tasks, message.taskId) : null;
  const pageInfo = currentThreadHistoryPage(message.id);
  const totalReplies = Math.max(Number(message.replyCount || 0), replies.length);
  const replyWord = totalReplies === 1 ? 'reply' : 'replies';
  const replyCountText = pageInfo?.hasMore && totalReplies > replies.length
    ? `${replies.length} of ${totalReplies} ${replyWord}`
    : `${totalReplies} ${replyWord}`;
  const card = context.querySelector('.thread-parent-card');

  patchThreadParentCard(message);
  patchThreadTaskLifecycle(card, task);
  const dividerLabel = context.querySelector('.thread-reply-divider span');
  if (dividerLabel) dividerLabel.textContent = pageInfo?.hasMore ? 'Scroll up for earlier replies' : 'Beginning of replies';
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
  patchDmHeaderSurface();
  patchRailSurface();
  window.requestAnimationFrame(() => restorePaneScrolls(scrollSnapshot));
  return true;
}

function activeTaskSurfaceIsVisible() {
  return activeView === 'tasks' || (activeView === 'space' && activeTab === 'tasks');
}

function renderActiveTaskSurface() {
  if (activeView === 'space' && activeTab === 'tasks') {
    const tasks = typeof spaceTasks === 'function' ? spaceTasks() : stateSpaceTasks(appState);
    if (selectedSpaceType === 'dm' && typeof renderDmTasks === 'function') return renderDmTasks(tasks);
    return renderTaskSurface(tasks, { emptyVariant: selectedSpaceType === 'channel' ? 'channel' : 'empty' });
  }
  if (activeView === 'tasks') return renderGlobalTasks();
  return '';
}

function activeTaskSurfaceNode() {
  if (activeView === 'tasks') return document.querySelector('.workspace .task-page');
  if (activeView === 'space' && activeTab === 'tasks') {
    return document.querySelector('.workspace .dm-task-view, .workspace .task-board, .workspace .task-list-view, .workspace .task-empty-state');
  }
  return null;
}

function patchVisibleTaskSurface(scrollSnapshot = {}) {
  if (!activeTaskSurfaceIsVisible()) return false;
  const current = activeTaskSurfaceNode();
  const nextHtml = renderActiveTaskSurface();
  const next = nextHtml ? htmlToElement(nextHtml) : null;
  if (!current || !next) return false;
  if (current.outerHTML !== next.outerHTML) current.replaceWith(next);
  window.requestAnimationFrame(() => {
    restorePaneScrolls(scrollSnapshot);
    restorePageScroll(scrollSnapshot.page);
  });
  return true;
}

function activeThreadDrawerIsVisible() {
  return Boolean(threadMessageId && !selectedProjectFile && !selectedAgentId && !selectedTaskId && activeView !== 'members');
}

function patchActiveTaskSurface(scrollSnapshot, { visibleChanged = true, threadVisibleChanged = true } = {}) {
  if (modal || !activeTaskSurfaceIsVisible()) return false;
  const taskPatched = visibleChanged ? patchVisibleTaskSurface(scrollSnapshot) : true;
  if (!taskPatched) return false;
  if (activeThreadDrawerIsVisible() && threadVisibleChanged) return patchOpenThreadDrawerSurface(scrollSnapshot);
  patchRailSurface();
  if (!visibleChanged) window.requestAnimationFrame(() => restorePaneScrolls(scrollSnapshot));
  return true;
}

function patchActiveThreadSurface(scrollSnapshot, { visibleChanged = true } = {}) {
  if (modal || !activeThreadDrawerIsVisible()) return false;
  if (!visibleChanged) {
    patchRailSurface();
    return true;
  }
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
  patchDmHeaderSurface();
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
    const greetingSelect = onboardingForm.querySelector('select[name="newAgentGreetingEnabled"]');
    if (greetingSelect && document.activeElement !== greetingSelect) greetingSelect.value = server.newAgentGreetingEnabled === false ? 'false' : 'true';
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

function railComputerSignature(stateSnapshot = appState) {
  const computers = typeof sortComputersByAvailability === 'function'
    ? sortComputersByAvailability(stateSnapshot?.computers || [])
    : (stateSnapshot?.computers || []);
  return computers.map((computer) => [
    computer?.id || '',
    computer?.name || '',
    computer?.hostname || '',
    computer?.localHostname || '',
    computer?.status || '',
    computer?.disabledAt || '',
    computer?.connectedVia || '',
    computer?.daemonVersion || '',
    computer?.packageName || '',
    computer?.packageVersion || '',
    computer?.packageKind || '',
    computer?.service?.mode || '',
    computer?.service?.background ? 'service-bg' : '',
    computer?.service?.packageVersion || '',
    computer?.metadata?.package?.version || '',
  ].join(':')).join('|');
}

function computerDetailRenderSignature(stateSnapshot = appState) {
  if (modal || activeView !== 'computers') return '';
  const computers = typeof sortComputersByAvailability === 'function'
    ? sortComputersByAvailability(stateSnapshot?.computers || [])
    : (stateSnapshot?.computers || []);
  const selected = (selectedComputerId ? byId(computers, selectedComputerId) : null) || computers[0] || null;
  if (!selected) return 'empty';
  const agents = (stateSnapshot?.agents || [])
    .filter((agent) => agent && agent.computerId === selected.id && !agent.deletedAt)
    .map((agent) => [
      agent.id,
      agent.name || '',
      agent.status || '',
      agent.runtime || '',
      agent.runtimeId || '',
      agent.model || '',
    ].join(':'))
    .sort()
    .join(',');
  const runtimes = JSON.stringify(selected.runtimeDetails || selected.runtimeIds || []);
  const upgrade = selected.metadata?.daemonUpgrade ? JSON.stringify(selected.metadata.daemonUpgrade) : '';
  return [
    selected.id,
    selected.name || '',
    selected.hostname || '',
    selected.localHostname || '',
    selected.os || '',
    selected.arch || '',
    selected.status || '',
    selected.disabledAt || '',
    selected.daemonVersion || selected.version || '',
    selected.packageName || '',
    selected.packageVersion || '',
    selected.packageKind || '',
    selected.service?.mode || '',
    selected.service?.active ? 'service-active' : '',
    selected.service?.background ? 'service-bg' : '',
    selected.service?.packageVersion || '',
    runtimes,
    upgrade,
    agents,
    latestPairingCommand?.computer?.id === selected.id ? latestPairingCommand?.command || '' : '',
    offlineComputerCommandInFlight ? 'command-loading' : '',
  ].join('|');
}

function applyStateUpdate(nextState) {
  nextState = normalizeIncomingStateSnapshot(nextState);
  nextState = preserveIncomingDirectorySnapshot(appState, nextState);
  if (pendingStateUpdate && pendingStateUpdate !== nextState) clearPendingStateUpdate();
  nextState = preserveLoadedConversationHistory(appState, nextState);
  if (appState?.cloud?.unreadCounts && nextState?.cloud && !nextState.cloud.unreadCounts) {
    nextState.cloud.unreadCounts = appState.cloud.unreadCounts;
  }
  syncBootstrapPagination(nextState);
  trackFanoutRouteEvents(nextState, { silent: !initialLoadComplete });
  trackAgentNotifications(nextState, { silent: !initialLoadComplete });
  const scrollSnapshot = {
    main: paneScrollSnapshot('main'),
    thread: paneScrollSnapshot('thread'),
    page: pageScrollSnapshot(),
  };
  const selectionBefore = `${selectedSpaceType}:${selectedSpaceId}`;
  const unreadBefore = railUnreadSignature();
  const railComputersBefore = railComputerSignature(appState);
  const activeConversationBefore = activeConversationSignature();
  const activeTaskSurfaceBefore = visibleTaskSurfaceSignature();
  const serverProfileBefore = serverProfilePatchSignature();
  const serverSettingsSupportBefore = serverSettingsSupportSignature();
  const serverSettingsVisibleBefore = serverSettingsVisibleSignature();
  const agentDetailBefore = agentDetailVisibleSignature();
  const computerModalBefore = modal === 'computer' ? computerPairingModalRenderSignature(appState) : '';
  const computerDetailBefore = computerDetailRenderSignature(appState);
  rememberPinnedBottomBeforeStateChange();
  appState = nextState;
  stateEntityLookupCache = null;
  workspaceHumansCache = null;
  workspaceAgentsCache = null;
  applyPackageVersionSnapshot(readCachedPackageVersionSnapshot());
  if (typeof applyMagclawAccountLanguage === 'function') applyMagclawAccountLanguage(appState);
  startHumanPresenceHeartbeat();
  if (modal) {
    if (modal === 'computer' && computerModalBefore !== computerPairingModalRenderSignature(appState)) render();
    return;
  }
  ensureSelection();
  const selectionChanged = selectionBefore !== `${selectedSpaceType}:${selectedSpaceId}`;
  markVisibleConversationRead();
  const unreadChanged = unreadBefore !== railUnreadSignature();
  const railComputersChanged = railComputersBefore !== railComputerSignature(appState);
  const railNeedsPatch = unreadChanged || railComputersChanged;
  const activeConversationChanged = activeConversationBefore !== activeConversationSignature();
  const activeTaskSurfaceChanged = activeTaskSurfaceBefore !== visibleTaskSurfaceSignature();
  const serverProfileAfter = serverProfilePatchSignature();
  const serverSettingsVisibleAfter = serverSettingsVisibleSignature();
  const agentDetailAfter = agentDetailVisibleSignature();
  const computerDetailAfter = computerDetailRenderSignature(appState);
  const agentDetailVisible = Boolean(
    agentDetailBefore
    && agentDetailAfter
    && !selectionChanged
  );
  const computerDetailUnchanged = Boolean(
    computerDetailBefore
    && computerDetailBefore === computerDetailAfter
    && !selectionChanged
  );
  const serverSettingsUnchanged = activeView === 'cloud'
    && settingsTab === 'server'
    && serverSettingsVisibleBefore === serverSettingsVisibleAfter
    && !selectionChanged;
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
  if (serverSettingsUnchanged) {
    if (pendingServerProfilePatchSignature === serverProfileAfter) pendingServerProfilePatchSignature = '';
    if (railNeedsPatch) patchRailSurface();
    patchServerProfileSettingsSurface();
    return;
  }
  if (serverProfileOnlyChanged || serverProfileEcho) {
    pendingServerProfilePatchSignature = '';
    patchRailSurface();
    patchServerProfileSettingsSurface();
    if (activeConversationChanged) patchOpenThreadDrawerSurface(scrollSnapshot);
    return;
  }
  if (pendingServerProfilePatchSignature && pendingServerProfilePatchSignature !== serverProfileAfter) {
    pendingServerProfilePatchSignature = '';
  }
  if (computerNameEditIsActive()) {
    captureComputerNameFieldDraft();
    if (railNeedsPatch) patchRailSurface();
    window.requestAnimationFrame(() => restorePaneScrolls(scrollSnapshot));
    return;
  }
  if (agentDetailInlineEditIsActive()) {
    captureAgentDetailFieldDraft();
    if (railNeedsPatch) patchRailSurface();
    window.requestAnimationFrame(() => restorePaneScrolls(scrollSnapshot));
    return;
  }
  if (computerDetailUnchanged) {
    if (railNeedsPatch) patchRailSurface();
    window.requestAnimationFrame(() => restorePaneScrolls(scrollSnapshot));
    return;
  }
  if (activeView === 'computers') {
    if (railNeedsPatch) patchRailSurface();
    render();
    return;
  }
  if (activeView === 'search') {
    if (railNeedsPatch) patchRailSurface();
    patchSearchSurface(scrollSnapshot);
    return;
  }
  if (agentDetailVisible) {
    const conversationNeedsPatch = activeView === 'space'
      && activeTab === 'chat'
      && !threadMessageId
      && (activeConversationChanged || unreadChanged);
    const conversationPatched = conversationNeedsPatch
      ? patchActiveConversationSurface(scrollSnapshot, { allowInspector: true })
      : true;
    if (conversationPatched && patchAgentDetailSurface(scrollSnapshot)) return;
  }
  if (patchActiveTaskSurface(scrollSnapshot, { visibleChanged: activeTaskSurfaceChanged, threadVisibleChanged: activeConversationChanged })) return;
  if (patchActiveThreadSurface(scrollSnapshot, { visibleChanged: activeConversationChanged })) return;
  if (patchActiveConversationSurface(scrollSnapshot, { allowInspector: activeConversationChanged || unreadChanged })) return;
  if (railNeedsPatch) patchRailSurface();
  render();
}

function applyRunEventUpdate(incoming) {
  if (!appState || appState.events.some((item) => item.id === incoming.id)) return;
  const scrollSnapshot = {
    main: paneScrollSnapshot('main'),
    thread: paneScrollSnapshot('thread'),
    page: pageScrollSnapshot(),
  };
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
  if (selectedAgentId && patchAgentDetailSurface(scrollSnapshot)) {
    return;
  }
  if (workspaceActivityDrawerOpen) {
    render();
    return;
  }
  patchRailSurface();
}

function applySseSeq(seqInput, seqStartInput = 0) {
  const seq = Number(seqInput || 0);
  if (!seq) return false;
  const seqStart = Math.max(0, Number(seqStartInput || 0) || 0);
  if (lastSseSeq && seq < lastSseSeq) {
    lastSseSeq = seq;
    sessionStorage.setItem(SSE_LAST_SEQ_STORAGE_KEY, String(seq));
    return false;
  }
  const expectedNextSeq = lastSseSeq + 1;
  const hasGap = Boolean(lastSseSeq && (seqStart ? seqStart > expectedNextSeq : seq > expectedNextSeq));
  if (seq > lastSseSeq) {
    lastSseSeq = seq;
    sessionStorage.setItem(SSE_LAST_SEQ_STORAGE_KEY, String(seq));
  }
  return hasGap;
}

function activitySeqFromPayload(payload = {}) {
  const value = Number(payload.activitySeq || payload.agent?.activitySeq || 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function agentActivityDetailFromPayload(payload = {}) {
  const activity = payload.runtimeActivity || payload.agent?.runtimeActivity || {};
  if (!activity || typeof activity !== 'object') return String(payload.detail || '').trim();
  return String(
    payload.detail
    || activity.error
    || activity.detail
    || activity.note
    || activity.text
    || activity.message
    || activity.tool
    || ''
  ).trim();
}

function realtimeAgentActivityEvent(payload = {}, entry = {}, index = 0) {
  const agentId = String(entry.agentId || payload.agentId || payload.agent?.id || '').trim();
  if (!agentId) return null;
  const activity = entry.activity || payload.runtimeActivity || payload.agent?.runtimeActivity || null;
  const detail = String(
    entry.detail
    || entry.message
    || agentActivityDetailFromPayload({ ...payload, runtimeActivity: activity })
    || ''
  ).trim();
  const activitySeq = activitySeqFromPayload(payload);
  const createdAt = entry.createdAt || entry.at || payload.activityAt || payload.agent?.activityAt || new Date().toISOString();
  return {
    id: entry.id || `rte_${agentId}_${activitySeq || 'na'}_${index}`,
    type: entry.type || entry.eventType || entry.kind || payload.type || 'agent_activity_changed',
    message: entry.message || detail,
    agentId,
    activity,
    createdAt,
    raw: {
      ...(entry.raw && typeof entry.raw === 'object' ? entry.raw : {}),
      activity,
      activitySeq,
    },
  };
}

function appendRealtimeAgentActivityEvents(agentId, payload = {}, stateSnapshot = appState) {
  const entries = Array.isArray(payload.entries) && payload.entries.length ? payload.entries : [payload];
  const incomingEvents = entries
    .map((entry, index) => realtimeAgentActivityEvent(payload, entry, index))
    .filter(Boolean);
  if (!incomingEvents.length) return stateSnapshot?.events || [];
  const existingEvents = Array.isArray(stateSnapshot?.events) ? stateSnapshot.events : [];
  const seen = new Set(existingEvents.map((event) => event?.id).filter(Boolean));
  const nextEvents = existingEvents.slice();
  for (const event of incomingEvents) {
    if (event.id && seen.has(event.id)) continue;
    nextEvents.push(event);
    if (event.id) seen.add(event.id);
  }
  const cached = agentActivityCache[agentId];
  if (cached) {
    const cacheSeen = new Set((cached.events || []).map((event) => event?.id).filter(Boolean));
    const merged = incomingEvents
      .filter((event) => !(event.id && cacheSeen.has(event.id)))
      .concat(cached.events || [])
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, AGENT_ACTIVITY_EVENT_LIMIT);
    agentActivityCache[agentId] = {
      ...cached,
      loading: false,
      error: '',
      events: merged,
    };
  }
  return nextEvents;
}

function applyAgentActivityChangedEvent(payload = {}, stateSnapshot = pendingStateUpdateBase()) {
  const agentId = String(payload.agentId || payload.agent?.id || '').trim();
  if (!agentId || !stateSnapshot) return false;
  const incomingSeq = activitySeqFromPayload(payload);
  const existingAgent = byId(stateSnapshot.agents, agentId);
  const lastSeq = Math.max(
    Number(agentActivitySeqById[agentId] || 0),
    Number(existingAgent?.activitySeq || 0),
  );
  if (incomingSeq && lastSeq && incomingSeq <= lastSeq) return false;
  if (incomingSeq) agentActivitySeqById[agentId] = incomingSeq;
  const incomingAgent = payload.agent || {};
  const hasRuntimeActivity = Object.prototype.hasOwnProperty.call(payload, 'runtimeActivity')
    || Object.prototype.hasOwnProperty.call(incomingAgent, 'runtimeActivity');
  const agents = (stateSnapshot.agents || []).map((agent) => (
    agent.id === agentId
      ? {
          ...agent,
          status: payload.status || incomingAgent.status || agent.status,
          previousStatus: incomingAgent.previousStatus || agent.previousStatus,
          statusUpdatedAt: incomingAgent.statusUpdatedAt || agent.statusUpdatedAt || null,
          heartbeatAt: incomingAgent.heartbeatAt || payload.activityAt || agent.heartbeatAt || null,
          runtimeActivity: hasRuntimeActivity
            ? (payload.runtimeActivity ?? incomingAgent.runtimeActivity ?? null)
            : (agent.runtimeActivity || null),
          activeWorkItemIds: incomingAgent.activeWorkItemIds || agent.activeWorkItemIds || [],
          activitySeq: incomingSeq || incomingAgent.activitySeq || agent.activitySeq || 0,
          activityAt: payload.activityAt || incomingAgent.activityAt || agent.activityAt || null,
        }
      : agent
  ));
  const events = appendRealtimeAgentActivityEvents(agentId, payload, stateSnapshot);
  queueStateUpdate({ ...stateSnapshot, agents, events });
  return true;
}

function applyRealtimeJournalEvent(envelope) {
  if (applySseSeq(envelope?.seq, envelope?.seqStart)) {
    refreshAfterSseGap(envelope);
    return;
  }
  const eventType = String(envelope?.eventType || '');
  const payload = envelope?.payload || {};
  if ((eventType === 'system_event' || eventType === 'run_event') && payload.event) {
    applyRunEventUpdate(payload.event);
    return;
  }
  if (eventType === 'unread_counts_invalidated') {
    scheduleUnreadCountsRefresh();
    return;
  }
  if (eventType === 'unread_counts_updated') {
    if (!payload.targetHumanId || payload.targetHumanId === currentHumanId()) {
      scheduleUnreadCountsRefresh({ delay: 80 });
    }
    return;
  }
  const stateSnapshot = pendingStateUpdateBase();
  if (eventType === 'agent_activity_changed') {
    applyAgentActivityChangedEvent(payload, stateSnapshot);
    return;
  }
  if (eventType === 'agent_status_changed' && payload.agent?.id && stateSnapshot) {
    const incoming = payload.agent;
    const agents = (stateSnapshot.agents || []).map((agent) => (
      agent.id === incoming.id
        ? {
            ...agent,
            status: incoming.status || agent.status,
            previousStatus: incoming.previousStatus || agent.previousStatus,
            statusUpdatedAt: incoming.statusUpdatedAt || agent.statusUpdatedAt || null,
            heartbeatAt: incoming.heartbeatAt || agent.heartbeatAt || null,
            runtimeActivity: incoming.runtimeActivity || null,
            activeWorkItemIds: incoming.activeWorkItemIds || agent.activeWorkItemIds || [],
            activitySeq: incoming.activitySeq || agent.activitySeq || 0,
            activityAt: incoming.activityAt || agent.activityAt || null,
          }
        : agent
    ));
    queueStateUpdate({ ...stateSnapshot, agents });
  }
}

function normalizeAgentPresenceEntry(entry = null) {
  if (Array.isArray(entry)) {
    return {
      id: entry[0] || '',
      status: entry[1] || 'offline',
      runtimeLastStartedAt: entry[2] || null,
      runtimeLastTurnAt: entry[3] || null,
      runtimeWarmAt: entry[4] || null,
      runtimeActivity: entry[5] || null,
      activitySeq: entry[6] || 0,
      activityAt: entry[7] || null,
    };
  }
  return entry && typeof entry === 'object' ? entry : {};
}

function normalizeHumanPresenceEntry(entry = null) {
  if (Array.isArray(entry)) {
    return {
      id: entry[0] || '',
      status: entry[1] || 'offline',
      lastSeenAt: entry[2] || null,
      presenceUpdatedAt: entry[3] || null,
    };
  }
  return entry && typeof entry === 'object' ? entry : {};
}

function applyPresenceHeartbeat(heartbeat) {
  const stateSnapshot = pendingStateUpdateBase();
  if (!stateSnapshot || !Array.isArray(heartbeat?.agents)) return;
  const incomingById = new Map(heartbeat.agents
    .map(normalizeAgentPresenceEntry)
    .filter((agent) => agent.id)
    .map((agent) => [agent.id, agent]));
  const incomingHumansById = new Map((heartbeat.humans || [])
    .map(normalizeHumanPresenceEntry)
    .filter((human) => human.id)
    .map((human) => [human.id, human]));
  let changed = false;
  const agents = (stateSnapshot.agents || []).map((agent) => {
    const incoming = incomingById.get(agent.id);
    if (!incoming) return agent;
    const next = {
      ...agent,
      status: incoming.status || agent.status,
      runtimeLastStartedAt: incoming.runtimeLastStartedAt || agent.runtimeLastStartedAt || null,
      runtimeLastTurnAt: incoming.runtimeLastTurnAt || agent.runtimeLastTurnAt || null,
      runtimeWarmAt: incoming.runtimeWarmAt || agent.runtimeWarmAt || null,
    };
    const incomingSeq = activitySeqFromPayload(incoming);
    const lastActivitySeq = Math.max(
      Number(agentActivitySeqById[agent.id] || 0),
      Number(agent.activitySeq || 0),
    );
    if (!incomingSeq || !lastActivitySeq || incomingSeq > lastActivitySeq) {
      if (incomingSeq) agentActivitySeqById[agent.id] = incomingSeq;
      next.runtimeActivity = incoming.runtimeActivity || agent.runtimeActivity || null;
      next.activitySeq = incomingSeq || agent.activitySeq || 0;
      next.activityAt = incoming.activityAt || agent.activityAt || null;
    }
    if (
      next.status !== agent.status
      || next.runtimeLastStartedAt !== agent.runtimeLastStartedAt
      || next.runtimeLastTurnAt !== agent.runtimeLastTurnAt
      || next.runtimeWarmAt !== agent.runtimeWarmAt
      || next.runtimeActivity !== agent.runtimeActivity
      || next.activitySeq !== agent.activitySeq
      || next.activityAt !== agent.activityAt
    ) {
      changed = true;
    }
    return next;
  });
  const humans = (stateSnapshot.humans || []).map((human) => {
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
  queueStateUpdate({
    ...stateSnapshot,
    agents,
    humans,
    updatedAt: heartbeat.updatedAt || stateSnapshot.updatedAt,
  });
}

function realtimeBusinessObjectTarget(envelope = {}) {
  const payload = envelope?.payload || {};
  if (threadMessageId) return { type: 'thread', id: threadMessageId };
  const parentMessageId = payload.reply?.parentMessageId || payload.message?.parentMessageId || '';
  if (parentMessageId) return { type: 'thread', id: parentMessageId };
  if (activeView === 'tasks' || activeTab === 'tasks') {
    return { type: 'tasks', scope: taskViewScope() };
  }
  if (activeView === 'space' && selectedSpaceType && selectedSpaceId) {
    return { type: 'space', spaceType: selectedSpaceType, spaceId: selectedSpaceId };
  }
  return { type: 'bootstrap' };
}

async function refreshRealtimeBusinessObject(target = realtimeBusinessObjectTarget()) {
  if (target?.type === 'thread' && target.id) {
    const refreshed = await refreshOpenThreadReplies(target.id);
    if (refreshed) return true;
  }
  if (target?.type === 'space' && target.spaceType && target.spaceId) {
    const refreshed = await refreshActiveSpaceMessages(target.spaceType, target.spaceId);
    if (refreshed) return true;
  }
  if (target?.type === 'tasks') {
    applyStateUpdate(await api(bootstrapStatePath()));
    return true;
  }
  applyStateUpdate(await api(bootstrapStatePath()));
  return true;
}

async function refreshAfterSseGap(envelope = {}) {
  if (sseGapRefreshInFlight) return;
  sseGapRefreshInFlight = true;
  try {
    await refreshRealtimeBusinessObject(realtimeBusinessObjectTarget(envelope));
  } catch (error) {
    console.warn('Failed to compensate SSE gap:', error);
  } finally {
    sseGapRefreshInFlight = false;
    scheduleUnreadCountsRefresh({ delay: 0 });
  }
}

function applyStateDeltaEnvelope(envelope) {
  if (applySseSeq(envelope?.seq)) {
    refreshAfterSseGap(envelope);
    return;
  }
  if (envelope?.type === 'state_patch' && envelope.payload) {
    queueStateUpdate(envelope.payload);
  }
}

function applyStateResyncRequiredEnvelope(envelope = {}) {
  applySseSeq(envelope?.seq || envelope?.currentSeq);
  refreshAfterSseGap(envelope);
}

function eventStreamPathForCurrentSelection() {
  const params = new URLSearchParams();
  const serverSlug = String(serverSlugFromPath() || currentServerSlug() || '').trim();
  if (serverSlug) params.set('serverSlug', serverSlug);
  params.set('spaceType', selectedSpaceType || 'channel');
  params.set('spaceId', selectedSpaceId || '');
  if (threadMessageId) params.set('threadMessageId', threadMessageId);
  if (lastSseSeq) params.set('lastSeq', String(lastSseSeq));
  params.set('presence', 'defer');
  params.set('messageLimit', '80');
  params.set('threadRootLimit', '160');
  return `/api/events?${params.toString()}`;
}

function connectEvents() {
  const eventPath = eventStreamPathForCurrentSelection();
  if (eventSource && eventSourcePath === eventPath) return;
  if (eventSource) disconnectEvents();
  eventSourcePath = eventPath;
  eventSource = new EventSource(eventPath);
  const currentEventSource = eventSource;
  const eventAppliesToCurrentStream = () => eventSource === currentEventSource && eventSourcePath === eventPath;
  eventSource.addEventListener('state-delta', (event) => {
    if (!eventAppliesToCurrentStream()) return;
    applyStateDeltaEnvelope(JSON.parse(event.data));
  });
  eventSource.addEventListener('realtime-event', (event) => {
    if (!eventAppliesToCurrentStream()) return;
    applyRealtimeJournalEvent(JSON.parse(event.data));
  });
  eventSource.addEventListener('state-resync-required', (event) => {
    if (!eventAppliesToCurrentStream()) return;
    let incoming = {};
    try {
      incoming = JSON.parse(event.data || '{}');
    } catch {
      incoming = {};
    }
    applyStateResyncRequiredEnvelope(incoming);
  });
  eventSource.addEventListener('state', (event) => {
    if (!eventAppliesToCurrentStream()) return;
    queueStateUpdate(JSON.parse(event.data));
  });
  eventSource.addEventListener('run-event', (event) => {
    if (!eventAppliesToCurrentStream()) return;
    const incoming = JSON.parse(event.data);
    applyRunEventUpdate(incoming);
  });
  eventSource.addEventListener('heartbeat', (event) => {
    if (!eventAppliesToCurrentStream()) return;
    applyPresenceHeartbeat(JSON.parse(event.data));
  });
  scheduleUnreadCountsRefresh({ delay: 0 });
}

function disconnectEvents() {
  if (!eventSource) return;
  eventSource.close();
  eventSource = null;
  eventSourcePath = '';
}

function currentHumanPresenceLeaseUserId() {
  const user = appState?.cloud?.auth?.currentUser || {};
  return String(user.id || user.email || '').trim();
}

function readHumanPresenceLease() {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(HUMAN_PRESENCE_LEASE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeHumanPresenceLease(userId, nowMs = Date.now()) {
  if (typeof localStorage === 'undefined') return false;
  try {
    localStorage.setItem(HUMAN_PRESENCE_LEASE_KEY, JSON.stringify({
      tabId: humanPresenceTabId,
      userId,
      expiresAt: nowMs + HUMAN_PRESENCE_LEASE_TTL_MS,
      updatedAt: nowMs,
    }));
    return true;
  } catch {
    return false;
  }
}

function ownsHumanPresenceLease(lease, userId = currentHumanPresenceLeaseUserId()) {
  return Boolean(lease?.tabId === humanPresenceTabId && (!userId || lease.userId === userId));
}

function releaseHumanPresenceLease() {
  if (typeof localStorage === 'undefined') return;
  const lease = readHumanPresenceLease();
  if (!ownsHumanPresenceLease(lease)) return;
  try {
    localStorage.removeItem(HUMAN_PRESENCE_LEASE_KEY);
  } catch {
    // Ignore storage failures; the lease expires quickly.
  }
}

function claimHumanPresenceLease() {
  const userId = currentHumanPresenceLeaseUserId();
  if (!userId) return false;
  if (document.visibilityState === 'hidden') {
    releaseHumanPresenceLease();
    return false;
  }
  if (typeof localStorage === 'undefined') return true;
  const nowMs = Date.now();
  const lease = readHumanPresenceLease();
  const leaseUserId = String(lease?.userId || '').trim();
  const leaseExpiresAt = Number(lease?.expiresAt || 0);
  if (lease && leaseUserId === userId && !ownsHumanPresenceLease(lease, userId) && leaseExpiresAt > nowMs) {
    return false;
  }
  if (!writeHumanPresenceLease(userId, nowMs)) return true;
  return ownsHumanPresenceLease(readHumanPresenceLease(), userId);
}

function applyHumanPresenceResult(human = null) {
  const stateSnapshot = pendingStateUpdateBase();
  if (!human?.id || !stateSnapshot?.humans) return false;
  let changed = false;
  const humans = stateSnapshot.humans.map((item) => {
    if (item.id !== human.id) return item;
    changed = item.status !== human.status || item.lastSeenAt !== human.lastSeenAt || item.presenceUpdatedAt !== human.presenceUpdatedAt;
    return { ...item, ...human };
  });
  if (changed) queueStateUpdate({ ...stateSnapshot, humans });
  return changed;
}

function publishHumanPresenceResult(human = null) {
  if (!human?.id || typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(HUMAN_PRESENCE_STATE_KEY, JSON.stringify({
      tabId: humanPresenceTabId,
      userId: currentHumanPresenceLeaseUserId(),
      human,
      updatedAt: Date.now(),
    }));
  } catch {
    // Other tabs will still receive the next SSE presence snapshot.
  }
}

async function sendHumanPresenceHeartbeat() {
  if (activeView === 'console' || (window.location.pathname || '').startsWith('/console')) return;
  if (humanPresenceInFlight || !appState?.cloud?.auth?.currentUser) return;
  if (!claimHumanPresenceLease()) return;
  humanPresenceInFlight = true;
  try {
    const result = await api('/api/cloud/auth/heartbeat', { method: 'POST', body: '{}' });
    if (result?.human?.id) {
      applyHumanPresenceResult(result.human);
      publishHumanPresenceResult(result.human);
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
  releaseHumanPresenceLease();
}

document.addEventListener('scroll', (event) => {
  if (event.target?.id === 'message-list') {
    updateBackBottomVisibility('main');
    persistPaneScroll('main', event.target);
    maybeLoadOlderConversationHistory('main', event.target);
  }
  if (event.target?.id === 'thread-context') {
    updateBackBottomVisibility('thread');
    persistPaneScroll('thread', event.target);
    maybeLoadOlderConversationHistory('thread', event.target);
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
  else releaseHumanPresenceLease();
});

window.addEventListener('pagehide', () => {
  releaseHumanPresenceLease();
});

window.addEventListener('storage', (event) => {
  if (event.key !== HUMAN_PRESENCE_STATE_KEY || !event.newValue) return;
  try {
    const payload = JSON.parse(event.newValue);
    if (payload?.tabId === humanPresenceTabId) return;
    const userId = currentHumanPresenceLeaseUserId();
    if (payload?.userId && userId && payload.userId !== userId) return;
    applyHumanPresenceResult(payload?.human);
  } catch {
    // Ignore malformed peer-tab presence payloads.
  }
});

function spaceDragRows(kind) {
  const dragKind = kind === 'dm' ? 'dm' : 'channel';
  return [...document.querySelectorAll(`[data-space-drag-kind="${dragKind}"][data-space-drag-id][draggable="true"]`)];
}

function spaceDragOrderFromDom(kind) {
  return spaceDragRows(kind)
    .map((row) => String(row.dataset.spaceDragId || '').trim())
    .filter(Boolean);
}

function sameSpaceDragOrder(left = [], right = []) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function animateSpaceDragRows(beforeRects, rows) {
  const animated = [];
  rows.forEach((row) => {
    const first = beforeRects.get(row);
    if (!first) return;
    const last = row.getBoundingClientRect();
    const deltaX = first.left - last.left;
    const deltaY = first.top - last.top;
    if (!deltaX && !deltaY) return;
    row.classList.remove('drag-animating');
    row.style.transition = 'none';
    row.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
    animated.push(row);
  });
  if (!animated.length) return;
  animated.forEach((row) => row.getBoundingClientRect());
  window.requestAnimationFrame(() => {
    animated.forEach((row) => {
      row.style.transition = '';
      row.classList.add('drag-animating');
      row.style.transform = '';
      window.setTimeout(() => {
        row.classList.remove('drag-animating');
        row.style.transform = '';
      }, 180);
    });
  });
}

function moveSpaceOrderDuringDrag(targetRow, beforeTarget = false) {
  if (!spaceOrderDrag || !targetRow) return false;
  const kind = spaceOrderDrag.kind === 'dm' ? 'dm' : 'channel';
  if (targetRow.dataset.spaceDragKind !== kind) return false;
  const draggedId = String(spaceOrderDrag.id || '');
  const targetId = String(targetRow.dataset.spaceDragId || '');
  if (!draggedId || !targetId || draggedId === targetId) return false;
  const rows = spaceDragRows(kind);
  const rowById = new Map(rows.map((row) => [String(row.dataset.spaceDragId || ''), row]));
  const draggedRow = rowById.get(draggedId);
  if (!draggedRow || !rowById.has(targetId) || draggedRow.parentElement !== targetRow.parentElement) return false;
  const current = rows.map((row) => String(row.dataset.spaceDragId || ''));
  const next = current.filter((id) => id !== draggedId);
  const targetIndex = next.indexOf(targetId);
  if (targetIndex < 0) return false;
  next.splice(beforeTarget ? targetIndex : targetIndex + 1, 0, draggedId);
  if (sameSpaceDragOrder(current, next)) return false;
  const beforeRects = new Map(rows.map((row) => [row, row.getBoundingClientRect()]));
  const nextIndex = next.indexOf(draggedId);
  const nextSibling = next[nextIndex + 1] ? rowById.get(next[nextIndex + 1]) : null;
  targetRow.parentElement.insertBefore(draggedRow, nextSibling || null);
  spaceOrderDrag.order = next;
  animateSpaceDragRows(beforeRects, spaceDragRows(kind));
  return true;
}

function finalizeSpaceOrderDrag() {
  if (!spaceOrderDrag) return false;
  const kind = spaceOrderDrag.kind === 'dm' ? 'dm' : 'channel';
  const order = (spaceOrderDrag.order && spaceOrderDrag.order.length)
    ? spaceOrderDrag.order
    : spaceDragOrderFromDom(kind);
  if (!order.length || sameSpaceDragOrder(spaceOrderDrag.initialOrder || [], order)) return false;
  persistSpaceOrderPreference(kind, order);
  return true;
}

function clearSpaceOrderDragState() {
  document.querySelectorAll('.space-btn.dragging, .space-btn.drag-animating').forEach((item) => {
    item.classList.remove('dragging', 'drag-animating');
    item.style.transform = '';
    item.style.transition = '';
  });
  spaceOrderDrag = null;
}

document.addEventListener('dragstart', (event) => {
  const row = event.target?.closest?.('[data-space-drag-kind][data-space-drag-id]');
  if (!row || row.getAttribute('draggable') !== 'true') return;
  const order = spaceDragOrderFromDom(row.dataset.spaceDragKind);
  spaceOrderDrag = {
    kind: row.dataset.spaceDragKind,
    id: row.dataset.spaceDragId,
    initialOrder: order,
    order,
  };
  row.classList.add('dragging');
  event.dataTransfer?.setData('text/plain', `${spaceOrderDrag.kind}:${spaceOrderDrag.id}`);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
});

document.addEventListener('dragover', (event) => {
  const row = event.target?.closest?.('[data-space-drag-kind][data-space-drag-id]');
  if (!row || !spaceOrderDrag || row.dataset.spaceDragKind !== spaceOrderDrag.kind) return;
  if (row.getAttribute('draggable') !== 'true') return;
  event.preventDefault();
  if (row.dataset.spaceDragId === spaceOrderDrag.id) return;
  const rect = row.getBoundingClientRect();
  const before = event.clientY <= rect.top + rect.height / 2;
  moveSpaceOrderDuringDrag(row, before);
});

document.addEventListener('drop', (event) => {
  if (!spaceOrderDrag) return;
  event.preventDefault();
  finalizeSpaceOrderDrag();
  clearSpaceOrderDragState();
});

document.addEventListener('dragend', () => {
  finalizeSpaceOrderDrag();
  clearSpaceOrderDragState();
});

document.addEventListener('compositionstart', (event) => {
  if (event.target?.id === 'search-input') {
    searchIsComposing = true;
  }
  if (event.target?.closest?.('textarea[data-mention-input]')) {
    composerIsComposing = true;
    composingComposerId = event.target.dataset.composerId || null;
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
    queueSearchResultsRefresh();
  }
  if (event.target?.closest?.('textarea[data-mention-input]')) {
    composerIsComposing = false;
    composingComposerId = null;
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

const ENTER_SUBMIT_COMPOSER_FORM_IDS = new Set(['message-form', 'reply-form']);

function composerFormForEnterSubmit(textarea) {
  const form = textarea?.closest?.('form');
  if (!form || !ENTER_SUBMIT_COMPOSER_FORM_IDS.has(form.id)) return null;
  return form;
}

function mentionPopupHandlesEnter(textarea) {
  if (!textarea || !mentionPopup.active || mentionPopup.composerId !== textarea.dataset?.composerId) return false;
  if (!Array.isArray(mentionPopup.items) || !mentionPopup.items.length) return false;
  return Boolean(document.getElementById('mention-popup'));
}

function composerEnterShouldInsertNewline() {
  return Boolean(window.matchMedia?.('(pointer: coarse) and (orientation: portrait)')?.matches);
}

function composerEnterMode(event, textarea) {
  if (!textarea || event?.key !== 'Enter') return 'none';
  if (!composerFormForEnterSubmit(textarea)) return 'none';
  if (isImeComposing(event, textarea)) return 'ime';
  if (mentionPopupHandlesEnter(textarea)) return 'mention';
  if (event.altKey) return 'newline';
  if (event.shiftKey && (event.metaKey || event.ctrlKey)) return 'force-task';
  if (event.shiftKey || event.metaKey || event.ctrlKey) return 'newline';
  if (composerEnterShouldInsertNewline(event, textarea)) return 'newline';
  return 'send';
}

function shouldSubmitComposerOnEnter(event, textarea) {
  const mode = composerEnterMode(event, textarea);
  return mode === 'send' || mode === 'force-task';
}

function submitComposerFromEnter(textarea, { forceAsTask = false } = {}) {
  const form = composerFormForEnterSubmit(textarea);
  if (!form) return false;
  if (forceAsTask) {
    const composerId = textarea.dataset?.composerId || form.dataset?.composerId || '';
    if (composerId) composerTaskFlags[composerId] = true;
    const taskInput = form.querySelector?.('input[name="asTask"]');
    if (taskInput) taskInput.checked = true;
  }
  if (typeof form.requestSubmit === 'function') {
    form.requestSubmit();
  } else {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }
  return true;
}

document.addEventListener('keydown', async (event) => {
  if (event.key === 'Escape' && modal === 'attachment-preview') {
    event.preventDefault();
    attachmentPreviewState = { attachmentId: null, loading: false, content: '', error: '' };
    modal = null;
    renderShellOrModal();
    return;
  }

  if (event.key === 'Escape' && activeView === 'search' && !modal) {
    event.preventDefault();
    restoreSearchReturnState();
    return;
  }

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
  if (textarea && isImeComposing(event, textarea)) return;

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

  if (textarea && shouldSubmitComposerOnEnter(event, textarea)) {
    event.preventDefault();
    submitComposerFromEnter(textarea, { forceAsTask: composerEnterMode(event, textarea) === 'force-task' });
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
    if ((event.key === 'Enter' || event.key === 'Tab') && mentionPopupHandlesEnter(textarea)) {
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

function normalizeConsoleServerSlugInput(value) {
  return consoleServerSlugFromName(String(value || '').replace(/^\/+/, ''));
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
  validateConsoleServerForm(form, { report: false });
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
      const normalized = normalizeConsoleServerSlugInput(event.target.value);
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
    if (typeof maybeAutosizeComposerTextarea === 'function') maybeAutosizeComposerTextarea(messageTextarea);
    if (!event.isComposing && event.inputType !== 'insertCompositionText' && composingComposerId === messageTextarea.dataset.composerId) {
      composerIsComposing = false;
      composingComposerId = null;
    }
    if (messageTextarea.dataset.composerId) setComposerDraftBody(messageTextarea.dataset.composerId, value);
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
      queueSearchResultsRefresh();
    }
    return;
  }

  if (event.target.id === 'search-sender-input') {
    searchSenderQuery = event.target.value;
    updateSearchResults();
    const input = document.getElementById('search-sender-input');
    input?.focus({ preventScroll: true });
    input?.setSelectionRange(searchSenderQuery.length, searchSenderQuery.length);
    return;
  }

  if (event.target.id === 'search-channel-input') {
    searchChannelQuery = event.target.value;
    updateSearchResults();
    const input = document.getElementById('search-channel-input');
    input?.focus({ preventScroll: true });
    input?.setSelectionRange(searchChannelQuery.length, searchChannelQuery.length);
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
    const code = document.querySelector('.connect-option-card[data-command-kind="connect"] .connect-command-shell code');
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
