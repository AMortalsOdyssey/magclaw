async function refreshState() {
  rememberPinnedBottomBeforeStateChange();
  const nextState = await api('/api/state');
  trackFanoutRouteEvents(nextState, { silent: !initialLoadComplete || !appState });
  trackAgentNotifications(nextState, { silent: !initialLoadComplete || !appState });
  appState = nextState;
  startHumanPresenceHeartbeat();
  render();
  maybeWarmCurrentAgent();
}

function cloudAuthErrorMessage(error, { interactive = false } = {}) {
  if (!error) return '';
  if (error.status === 401) return interactive ? 'Email or password is incorrect.' : '';
  return error.message || '';
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
  renderCloudAuthGate(cloud, authErrorMessage);
}

async function refreshStateOrAuthGate() {
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

function patchActiveThreadSurface(scrollSnapshot) {
  if (modal || activeView !== 'space' || activeTab !== 'chat') return false;
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

function patchActiveConversationSurface(scrollSnapshot) {
  if (modal || activeView !== 'space' || activeTab !== 'chat') return false;
  if (threadMessageId || selectedProjectFile || selectedAgentId || selectedTaskId) return false;
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

function applyStateUpdate(nextState) {
  trackFanoutRouteEvents(nextState, { silent: !initialLoadComplete });
  trackAgentNotifications(nextState, { silent: !initialLoadComplete });
  const scrollSnapshot = {
    main: paneScrollSnapshot('main'),
    thread: paneScrollSnapshot('thread'),
  };
  const selectionBefore = `${selectedSpaceType}:${selectedSpaceId}`;
  const unreadBefore = railUnreadSignature();
  rememberPinnedBottomBeforeStateChange();
  appState = nextState;
  startHumanPresenceHeartbeat();
  if (modal) return;
  ensureSelection();
  const selectionChanged = selectionBefore !== `${selectedSpaceType}:${selectedSpaceId}`;
  const unreadChanged = unreadBefore !== railUnreadSignature();
  if (selectionChanged || unreadChanged) {
    render();
    return;
  }
  if (patchActiveThreadSurface(scrollSnapshot)) return;
  if (patchActiveConversationSurface(scrollSnapshot)) return;
  render();
}

function applyRunEventUpdate(incoming) {
  if (!appState || appState.events.some((item) => item.id === incoming.id)) return;
  const scrollSnapshot = {
    main: paneScrollSnapshot('main'),
    thread: paneScrollSnapshot('thread'),
  };
  rememberPinnedBottomBeforeStateChange();
  appState.events.push(incoming);
  if (modal) return;
  if (patchActiveThreadSurface(scrollSnapshot)) return;
  if (patchActiveConversationSurface(scrollSnapshot)) return;
  render();
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
  eventSource = new EventSource('/api/events');
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
  if (!appState?.cloud?.auth?.currentUser) {
    stopHumanPresenceHeartbeat();
    return;
  }
  if (!humanPresenceTimer) {
    humanPresenceTimer = window.setInterval(() => {
      sendHumanPresenceHeartbeat();
    }, HUMAN_PRESENCE_HEARTBEAT_MS);
  }
  sendHumanPresenceHeartbeat();
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

document.addEventListener('input', async (event) => {
  if (event.target.matches?.('[data-action="avatar-crop-scale"]') && avatarCropState) {
    avatarCropState.scale = clampAvatarCropScale(event.target.value);
    clampAvatarCropOffset();
    updateAvatarCropPreview();
    return;
  }

  if (event.target.matches?.('[data-agent-description-input]')) {
    const count = event.target.closest('.agent-inline-edit')?.querySelector('[data-agent-description-count]');
    if (count) count.textContent = `${event.target.value.length}/3000`;
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
      const items = [...peopleItems, ...projectItems];
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

  if (event.target.id === 'create-channel-member-search') {
    createChannelMemberSearchQuery = event.target.value;
    render();
    const input = document.querySelector('#create-channel-member-search');
    input?.focus();
    input?.setSelectionRange(createChannelMemberSearchQuery.length, createChannelMemberSearchQuery.length);
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
