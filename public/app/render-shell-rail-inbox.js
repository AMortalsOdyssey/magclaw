function renderAppFlashBanner() {
  if (!appFlash?.message) return '';
  const tone = String(appFlash.tone || 'info').replace(/[^a-z0-9-]/gi, '');
  return `
    <div class="app-flash app-flash-${escapeHtml(tone)}" role="status" aria-live="polite">
      <div>
        <strong>${escapeHtml(appFlash.message)}</strong>
        ${appFlash.detail ? `<span>${escapeHtml(appFlash.detail)}</span>` : ''}
      </div>
      <button class="app-flash-close" type="button" data-action="dismiss-app-flash" aria-label="Dismiss notification">×</button>
    </div>
  `;
}

function spaceOrderWorkspaceKey() {
  return String(appState?.cloud?.workspace?.id || appState?.connection?.workspaceId || currentServerSlug?.() || 'local').trim() || 'local';
}

function spaceOrderStorageKey() {
  const humanId = typeof currentHumanId === 'function' ? currentHumanId() : 'local';
  return `magclawSpaceOrder:${window.location.host}:${spaceOrderWorkspaceKey()}:${humanId}`;
}

function accountSpaceOrderPreference() {
  const user = appState?.cloud?.auth?.currentUser || {};
  const byWorkspace = user.metadata?.ui?.spaceOrderByWorkspace || {};
  return byWorkspace[spaceOrderWorkspaceKey()] || {};
}

function localSpaceOrderPreference() {
  return readJsonStorage(spaceOrderStorageKey(), {});
}

function currentSpaceOrderPreference() {
  return {
    ...localSpaceOrderPreference(),
    ...accountSpaceOrderPreference(),
  };
}

function normalizeRailOrder(ids = [], availableIds = []) {
  const available = new Set(availableIds.map(String));
  const seen = new Set();
  const ordered = [];
  for (const id of ids || []) {
    const clean = String(id || '').trim();
    if (!available.has(clean) || seen.has(clean)) continue;
    seen.add(clean);
    ordered.push(clean);
  }
  for (const id of availableIds) {
    const clean = String(id || '');
    if (!seen.has(clean)) ordered.push(clean);
  }
  return ordered;
}

function isPinnedAllChannelForRail(channel) {
  return typeof isAllChannel === 'function'
    ? isAllChannel(channel)
    : String(channel?.id || '') === 'chan_all' || String(channel?.name || '').toLowerCase() === 'all';
}

function orderedChannelsForRail(channels = []) {
  const all = channels.find(isPinnedAllChannelForRail) || null;
  const movable = channels.filter((channel) => channel && channel !== all);
  const order = normalizeRailOrder(currentSpaceOrderPreference().channels || [], movable.map((channel) => channel.id));
  const byId = new Map(movable.map((channel) => [channel.id, channel]));
  return [...(all ? [all] : []), ...order.map((id) => byId.get(id)).filter(Boolean)];
}

function orderedDmsForRail(dms = []) {
  const order = normalizeRailOrder(currentSpaceOrderPreference().dms || [], dms.map((dm) => dm.id));
  const byId = new Map(dms.map((dm) => [dm.id, dm]));
  return order.map((id) => byId.get(id)).filter(Boolean);
}

function updateCurrentUserSpaceOrderPreference(order) {
  const user = appState?.cloud?.auth?.currentUser;
  if (!user) return;
  user.metadata = user.metadata && typeof user.metadata === 'object' ? user.metadata : {};
  const ui = user.metadata.ui && typeof user.metadata.ui === 'object' ? user.metadata.ui : {};
  const byWorkspace = ui.spaceOrderByWorkspace && typeof ui.spaceOrderByWorkspace === 'object' ? ui.spaceOrderByWorkspace : {};
  byWorkspace[spaceOrderWorkspaceKey()] = {
    channels: order.channels || [],
    dms: order.dms || [],
    updatedAt: new Date().toISOString(),
  };
  user.metadata.ui = { ...ui, spaceOrderByWorkspace: byWorkspace };
}

function persistSpaceOrderPreference(kind, ids) {
  const previous = currentSpaceOrderPreference();
  const next = {
    channels: kind === 'channel' ? ids : (previous.channels || []),
    dms: kind === 'dm' ? ids : (previous.dms || []),
  };
  writeJsonStorage(spaceOrderStorageKey(), next);
  updateCurrentUserSpaceOrderPreference(next);
  if (appState?.cloud?.auth?.currentUser) {
    api('/api/cloud/auth/preferences', {
      method: 'PATCH',
      body: JSON.stringify({
        ui: {
          spaceOrder: {
            workspaceId: spaceOrderWorkspaceKey(),
            channels: next.channels,
            dms: next.dms,
          },
        },
      }),
    }).catch((error) => toast(error.message));
  }
}

function reorderSpaceOrderForDrag(kind, draggedId, targetId, beforeTarget = false) {
  const dragKind = kind === 'dm' ? 'dm' : 'channel';
  const source = dragKind === 'dm'
    ? orderedDmsForRail(appState?.dms || [])
    : orderedChannelsForRail(appState?.channels || []).filter((channel) => !isPinnedAllChannelForRail(channel));
  const availableIds = source.map((item) => item.id);
  if (!availableIds.includes(draggedId) || !availableIds.includes(targetId) || draggedId === targetId) return false;
  const next = availableIds.filter((id) => id !== draggedId);
  const targetIndex = next.indexOf(targetId);
  next.splice(beforeTarget ? targetIndex : targetIndex + 1, 0, draggedId);
  persistSpaceOrderPreference(dragKind, next);
  return true;
}

function render() {
  if (!appState) {
    root.innerHTML = '<div class="boot">MAGCLAW / BOOTING</div>';
    return;
  }
  if (shouldDeferProfileFormRender()) {
    pendingProfileFormRender = true;
    return;
  }
  captureProfileFormDraft();
  captureAgentDetailFieldDraft();
  captureComputerNameFieldDraft();
  const profileFocus = profileFormFocusSnapshot();
  const agentDetailFocus = agentDetailFieldFocusSnapshot();
  const computerNameFocus = computerNameFieldFocusSnapshot();
  const composerFocus = composerFocusSnapshot();
  const scrollSnapshot = {
    main: paneScrollSnapshot('main'),
    thread: paneScrollSnapshot('thread'),
    page: pageScrollSnapshot(),
    workspaceActivity: workspaceActivityScrollSnapshot(),
    rail: railScrollSnapshot(),
  };
  ensureSelection();
  persistUiState();
  const mobileLayout = typeof isMobileViewport === 'function' && isMobileViewport() && typeof renderMobileShell === 'function';
  const inspectorHtml = renderInspector();
  const notificationBanner = renderNotificationPromptBanner();
  const appFlashBanner = renderAppFlashBanner();
  if (mobileLayout) {
    root.innerHTML = `
      ${notificationBanner}
      ${appFlashBanner}
      ${renderMobileShell()}
      ${modal ? renderModal() : ''}
      ${typeof renderTaskThreadModal === 'function' ? renderTaskThreadModal() : ''}
      ${typeof renderMessageInteractionOverlays === 'function' ? renderMessageInteractionOverlays() : ''}
    `;
    if (typeof translatePage === 'function') translatePage(root);
    if (typeof ensureOfflineComputerConnectCommand === 'function') {
      window.setTimeout(ensureOfflineComputerConnectCommand, 0);
    }
    window.requestAnimationFrame(() => {
      restorePaneScrolls(scrollSnapshot);
      restorePageScroll(scrollSnapshot.page);
      restoreWorkspaceActivityScroll(scrollSnapshot.workspaceActivity);
      restoreRailScroll(scrollSnapshot.rail);
      restoreProfileFormFocus(profileFocus);
      restoreAgentDetailFieldFocus(agentDetailFocus);
      restoreComputerNameFieldFocus(computerNameFocus);
      restoreComposerFocus(composerFocus);
      restorePendingComposerFocus();
      if (typeof maybeAutosizeAllComposerTextareas === 'function') maybeAutosizeAllComposerTextareas();
      if (typeof requestAttachmentPreviewOutlineSync === 'function') requestAttachmentPreviewOutlineSync();
      if (workspaceActivityDrawerOpen && workspaceActivityScrollToBottom) {
        workspaceActivityScrollToBottom = false;
        scrollWorkspaceActivityToBottom('auto');
      }
    });
    return;
  }
  const taskFocusLayout = activeView === 'tasks';
  const settingsLayout = activeView === 'cloud' || activeView === 'console';
  const consoleLayout = activeView === 'console';
  root.innerHTML = `
    ${notificationBanner}
    ${appFlashBanner}
    <div class="app-frame collab-frame${inspectorHtml ? '' : ' no-inspector'}${threadMessageId ? `${inspectorHtml ? ' tablet-inspector-main' : ''} thread-open` : ''}${taskFocusLayout ? ' task-focus' : ''}${settingsLayout ? ' settings-layout-frame' : ''}${consoleLayout ? ' console-layout-frame' : ''}${notificationBanner ? ' notification-banner-active' : ''}" style="${appFrameStyle()}">
      ${renderRail()}
      ${taskFocusLayout ? '' : '<div class="rail-resizer" data-action="none" role="separator" aria-label="Resize sidebar" aria-orientation="vertical" tabindex="0"></div>'}
      <main class="workspace collab-main">
        ${renderMain()}
        ${renderClickLoadingSurface('main')}
      </main>
      ${inspectorHtml ? `
        <div class="inspector-resizer" data-action="none" role="separator" aria-label="Resize inspector panel" aria-orientation="vertical" tabindex="0"></div>
        <aside class="inspector collab-inspector">
          ${inspectorHtml}
          ${renderClickLoadingSurface('inspector')}
        </aside>
      ` : ''}
    </div>
    ${modal ? renderModal() : ''}
    ${typeof renderTaskThreadModal === 'function' ? renderTaskThreadModal() : ''}
    ${typeof renderMessageInteractionOverlays === 'function' ? renderMessageInteractionOverlays() : ''}
  `;
  if (typeof translatePage === 'function') translatePage(root);
  if (typeof ensureOfflineComputerConnectCommand === 'function') {
    window.setTimeout(ensureOfflineComputerConnectCommand, 0);
  }
  window.requestAnimationFrame(() => {
    restorePaneScrolls(scrollSnapshot);
    restorePageScroll(scrollSnapshot.page);
    restoreWorkspaceActivityScroll(scrollSnapshot.workspaceActivity);
    restoreRailScroll(scrollSnapshot.rail);
    restoreProfileFormFocus(profileFocus);
    restoreAgentDetailFieldFocus(agentDetailFocus);
    restoreComputerNameFieldFocus(computerNameFocus);
    restoreComposerFocus(composerFocus);
    restorePendingComposerFocus();
    if (typeof maybeAutosizeAllComposerTextareas === 'function') maybeAutosizeAllComposerTextareas();
    if (typeof requestAttachmentPreviewOutlineSync === 'function') requestAttachmentPreviewOutlineSync();
    if (workspaceActivityDrawerOpen && workspaceActivityScrollToBottom) {
      workspaceActivityScrollToBottom = false;
      scrollWorkspaceActivityToBottom('auto');
    }
  });
}

function renderRail() {
  const channels = orderedChannelsForRail(appState.channels || []);
  const dms = orderedDmsForRail(appState.dms || []);
  const inbox = buildInboxModel();
  const spaceUnreadCounts = buildSpaceUnreadCounts(inbox.humanId);
  const unreadThreads = (appState.messages || []).filter((message) => message.replyCount > 0 || message.taskId).length;
  const openTasks = (appState.tasks || []).filter((task) => task && !taskIsClosedStatus(task.status)).length;
  const saved = savedRecords().length;
  const normalAgents = channelAssignableAgents();
  const serverProfile = currentServerProfile();
  const packageUpdateCount = typeof connectedComputerPackageUpdateCount === 'function'
    ? connectedComputerPackageUpdateCount()
    : 0;
  const railMode = activeView === 'search'
    ? 'search'
    : activeView === 'tasks'
    ? 'tasks'
    : activeView === 'console'
      ? 'console'
      : activeView === 'cloud'
      ? 'settings'
      : activeView === 'computers' || (activeView === 'missions' && railTab === 'computers')
        ? 'desktop'
        : railTab === 'members'
          ? 'members'
          : 'chat';
  const railHeading = railMode === 'search'
    ? 'Search'
    : railMode === 'tasks'
    ? 'Tasks'
    : railMode === 'members'
      ? 'Members'
      : railMode === 'console'
        ? 'Console'
        : railMode === 'settings'
        ? 'Settings'
        : railMode === 'desktop'
          ? 'Computers'
          : 'Chat';
  const sidebarBody = railMode === 'console'
      ? renderConsoleRail()
      : railMode === 'settings'
      ? renderSettingsRail()
      : railMode === 'desktop'
        ? renderComputersRail()
      : railTab === 'spaces'
        ? renderChatRail({ channels, dms, inboxUnread: inbox.unreadCount, unreadThreads, openTasks, saved, spaceUnreadCounts })
        : renderMembersRail({ normalAgents });
  const railClass = `rail collab-rail magclaw-rail${railMode === 'settings' ? ' settings-rail' : ''}${railMode === 'console' ? ' console-rail' : ''}`;
  const leftRailHtml = `
    <div class="magclaw-left-rail">
      <div class="server-switcher-anchor">
        <button class="left-rail-avatar server-switcher-trigger" type="button" data-action="toggle-server-switcher" title="${escapeHtml(serverProfile.name || displayServerSlug(serverProfile.slug) || 'Server')}" aria-label="Switch server">
          ${renderServerAvatar(serverProfile, 'left-rail-server-avatar')}
        </button>
        ${renderServerSwitcherMenu()}
      </div>
      ${renderLeftRailButton('search', railMode, 'Search', '<circle cx="11" cy="11" r="7"/><path d="m20 20-4.2-4.2"/>')}
      ${renderLeftRailButton('chat', railMode, 'Chat', '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>')}
      ${renderLeftRailButton('tasks', railMode, 'Tasks', '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>')}
      ${renderLeftRailButton('members', railMode, 'Members', '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>')}
      ${renderLeftRailButton('desktop', railMode, 'Computers', '<rect x="3" y="4" width="18" height="13" rx="1"/><path d="M8 21h8"/><path d="M12 17v4"/>', packageUpdateCount ? '!' : '')}
      <span class="left-rail-spacer"></span>
      ${renderLeftRailButton('console', railMode, 'Console', '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M8 8h8"/><path d="M8 12h4"/><path d="M14 12h2"/><path d="M8 16h8"/>')}
      ${renderAccountRailButton(railMode)}
    </div>
  `;

  if (activeView === 'tasks' || activeView === 'search') {
    return `
      <aside class="${railClass} rail-icon-only">
        ${leftRailHtml}
      </aside>
    `;
  }

  if (activeView === 'console') {
    return `
      <aside class="${railClass}">
        <div class="magclaw-sidebar">
          <div class="magclaw-sidebar-header">
            <h2>${escapeHtml(railHeading)}</h2>
          </div>
          ${sidebarBody}
        </div>
      </aside>
    `;
  }

  return `
    <aside class="${railClass}">
      ${leftRailHtml}
      <div class="magclaw-sidebar">
        <div class="magclaw-sidebar-header">
          <h2>${escapeHtml(railHeading)}</h2>
        </div>

      ${sidebarBody}
      </div>
    </aside>
  `;
}

function accountRailInitial(user = {}, human = {}) {
  const label = String(user.email || human.email || user.name || human.name || 'M').trim();
  const match = label.match(/[a-zA-Z0-9\u4e00-\u9fff]/);
  return (match?.[0] || 'M').toUpperCase();
}

function accountRailAvatarHtml(user = {}, human = {}) {
  const avatar = String(human.avatar || human.avatarUrl || user.avatarUrl || '').trim();
  if (avatar) return `<img src="${escapeHtml(avatar)}" alt="">`;
  return `<span>${escapeHtml(accountRailInitial(user, human))}</span>`;
}

function renderAccountRailButton(activeNav) {
  const user = appState?.cloud?.auth?.currentUser || null;
  if (!user) {
    return renderLeftRailButton('settings', activeNav, 'Settings', '<circle cx="12" cy="12" r="3"/><path d="M12 3v3"/><path d="M12 18v3"/><path d="M3 12h3"/><path d="M18 12h3"/><path d="M5.6 5.6l2.1 2.1"/><path d="M16.3 16.3l2.1 2.1"/><path d="M18.4 5.6l-2.1 2.1"/><path d="M7.7 16.3l-2.1 2.1"/>');
  }
  const human = currentAccountHuman();
  const label = user.email || human.email || user.name || human.name || 'MagClaw user';
  const name = user.name || human.name || label;
  const provider = user.metadata?.oauth?.feishu ? 'Feishu' : 'Email password';
  const thirdPartyName = typeof thirdPartyNameForHuman === 'function' ? thirdPartyNameForHuman(human) : '';
  return `
    <button class="left-rail-btn account-rail-button${activeNav === 'settings' ? ' active' : ''}" type="button" data-action="open-account-settings" title="${escapeHtml(label)}" aria-label="Open account settings">
      <span class="account-rail-avatar" aria-hidden="true">${accountRailAvatarHtml(user, human)}</span>
      <span class="account-rail-popover" role="tooltip">
        <strong>${escapeHtml(name)}</strong>
        ${thirdPartyName ? `<small>${escapeHtml(thirdPartyName)}</small>` : ''}
        <small>${escapeHtml(label)}</small>
        <em>${escapeHtml(provider)}</em>
      </span>
    </button>
  `;
}

function currentServerProfile() {
  const current = appState?.cloud?.workspace || {};
  const slug = currentServerSlug();
  return (appState?.cloud?.workspaces || []).find((server) => String(server.slug || server.id) === slug)
    || current
    || { name: 'MagClaw', slug: 'local' };
}

function serverAvatarInitial(server = {}) {
  const label = String(server.name || server.slug || server.id || 'M').trim();
  const match = label.match(/[a-zA-Z0-9]/);
  return (match?.[0] || 'M').toUpperCase();
}

function renderServerAvatar(server = {}, cssClass = '') {
  const avatar = String(server.avatar || '').trim();
  if (avatar) return `<img class="${escapeHtml(cssClass)}" src="${escapeHtml(avatar)}" alt="">`;
  return `<span class="${escapeHtml(cssClass)}">${escapeHtml(serverAvatarInitial(server))}</span>`;
}

function renderServerSwitcherMenu() {
  if (!serverSwitcherOpen) return '';
  const servers = consoleServers();
  const currentSlug = String(currentServerProfile().slug || currentServerSlug());
  return `
    <div class="server-switcher-menu pixel-panel" role="menu">
      <div class="server-switcher-list">
        ${servers.length ? servers.map((server) => {
          const slug = String(server.slug || server.id || 'local');
          const labelSlug = displayServerSlug(slug);
          const active = slug === currentSlug ? ' active' : '';
          return `
            <button class="server-switcher-row${active}" type="button" data-action="switch-server" data-slug="${escapeHtml(slug)}" role="menuitem">
              ${active ? '<span class="server-switcher-check">✓</span>' : '<span class="server-switcher-check"></span>'}
              ${renderServerAvatar(server, 'server-switcher-avatar')}
              <span>
                <strong>${escapeHtml(server.name || displayServerSlug(slug) || 'Server')}</strong>
                ${labelSlug ? `<small>/${escapeHtml(labelSlug)}</small>` : ''}
              </span>
            </button>
          `;
        }).join('') : '<div class="server-switcher-empty">No servers yet</div>'}
      </div>
      <button class="server-switcher-create" type="button" data-action="open-console-server-switcher" role="menuitem">
        <span>＋</span>
        <strong>Switch or create server</strong>
      </button>
    </div>
  `;
}

function renderChatRail({ channels, dms, inboxUnread, unreadThreads, openTasks, saved, spaceUnreadCounts }) {
  const dmPeers = dms
    .map((dm) => dmPeerInfo(dm))
    .filter((item) => item?.dm?.id && item?.peer);
  return `
    <div class="nav-list">
      ${renderNavItem('inbox', 'Activities', 'inbox', inboxUnread || '', { badgeKind: 'unread' })}
      ${renderNavItem('threads', 'Threads', 'message', unreadThreads || '')}
      ${renderNavItem('tasks', 'Tasks', 'file', openTasks || '')}
      ${renderNavItem('saved', 'Saved', 'bookmark', saved || '')}
    </div>

    <div class="rail-section" data-rail-scroll-section="channels" data-scroll-key="rail:spaces:channels">
      ${renderRailSectionTitle('channels', 'Channels', channels.length, { createMenu: true })}
      ${collapsedSidebarSections.channels ? '' : channels.map((channel) => renderChannelItem(channel, unreadCountForSpace(spaceUnreadCounts, 'channel', channel.id))).join('')}
    </div>

      <div class="rail-section" data-rail-scroll-section="dms" data-scroll-key="rail:spaces:dms">
        ${renderRailSectionTitle('dms', 'DIRECT MESSAGES', dmPeers.length, { modal: 'dm' })}
        ${collapsedSidebarSections.dms ? '' : dmPeers.map(({ dm, peer }) => (
          renderDmItem(dm.id, peer.name || displayName(peer.id), peer.status || 'offline', peer.avatar || '', unreadCountForSpace(spaceUnreadCounts, 'dm', dm.id))
        )).join('')}
      </div>

    `;
}

function renderMembersRail({ normalAgents }) {
  const humans = humansByJoinOrder();
  const agentModal = cloudCan('manage_agents') ? 'agent' : '';
  const humanModal = cloudCan('invite_member') ? 'member-invite' : '';
  return `
    <div class="rail-section" data-rail-scroll-section="agents" data-scroll-key="rail:members:agents">
      ${renderRailSectionTitle('agents', 'Agents', normalAgents.length, { modal: agentModal })}
      ${collapsedSidebarSections.agents ? '' : renderAgentGroupsByComputer(normalAgents)}
    </div>

      <div class="rail-section" data-rail-scroll-section="humans" data-scroll-key="rail:members:humans">
        ${renderRailSectionTitle('humans', 'Humans', humans.length, { modal: humanModal })}
        ${collapsedSidebarSections.humans ? '' : humans.map((human) => renderHumanListItem(human)).join('')}
      </div>
    `;
}

function humansByJoinOrder() {
  return workspaceHumans();
}

function renderComputersRail() {
  const computers = typeof sortComputersByAvailability === 'function'
    ? sortComputersByAvailability(appState.computers || [])
    : (appState.computers || []);
  const canManageComputers = cloudCan('manage_computers');
  return `
    <div class="rail-section" data-rail-scroll-section="computers" data-scroll-key="rail:computers:computers">
      ${renderRailSectionTitle('computers', 'Computers', computers.length, { modal: canManageComputers ? 'computer' : '' })}
      ${collapsedSidebarSections.computers ? '' : computers.map((computer) => renderComputerListItem(computer)).join('')}
    </div>
  `;
}

function renderSettingsRail() {
  const items = settingsNavItems();
  return `
    <nav class="settings-nav-list" aria-label="Settings sections">
      ${items.map((item) => `
        <button class="settings-nav-item${settingsTab === item.id ? ' active' : ''}" type="button" data-action="set-settings-tab" data-tab="${escapeHtml(item.id)}">
          ${settingsIcon(item.icon, 20)}
          <span>${escapeHtml(item.label)}</span>
        </button>
      `).join('')}
    </nav>
  `;
}

function sessionSummaryLlmIssueNotifications() {
  const items = [...(appState?.cloud?.systemNotifications || []), ...(appState?.systemNotifications || [])];
  const seen = new Set();
  return items.filter((item) => {
    const type = String(item?.event || item?.type || '');
    const id = String(item?.id || `${type}:${item?.createdAt || ''}`);
    if (type !== 'session_summary_llm_error' || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function renderConsoleRail() {
  const pendingCount = consoleInvitationRows().filter((item) => item?.status === 'pending').length;
  const serversCount = consoleServers().length;
  const lostCount = consoleDeletedServers().length;
  const issueCount = sessionSummaryLlmIssueNotifications().length;
  const items = [
    { id: 'overview', label: 'Overview', meta: issueCount ? '!' : 'home' },
    { id: 'invitations', label: 'Invitations', meta: pendingCount ? `${pendingCount}` : '' },
    { id: 'servers', label: 'Servers', meta: `${serversCount}` },
    { id: 'lost-space', label: 'Lost Space', meta: lostCount ? `${lostCount}` : '' },
  ];
  return `
    <nav class="settings-nav-list console-nav-list" aria-label="Console sections">
      ${items.map((item) => `
        <button class="settings-nav-item${consoleTab === item.id ? ' active' : ''}" type="button" data-action="set-console-tab" data-tab="${escapeHtml(item.id)}">
          ${settingsIcon(item.id === 'servers' ? 'server' : item.id === 'invitations' ? 'members' : item.id === 'lost-space' ? 'lost' : 'system', 20)}
          <span>${escapeHtml(item.label)}</span>
          ${item.meta ? `<em>${escapeHtml(item.meta)}</em>` : ''}
        </button>
      `).join('')}
    </nav>
  `;
}

function renderLeftRailButton(nav, activeNav, label, icon, badge = '') {
  return `
    <button class="left-rail-btn${activeNav === nav ? ' active' : ''}" type="button" data-action="set-left-nav" data-nav="${escapeHtml(nav)}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">${icon}</svg>
      ${badge ? `<em>${escapeHtml(badge)}</em>` : ''}
    </button>
  `;
}

function renderRailUnreadBadge(count, label = 'unread messages') {
  const value = Math.max(0, Number(count) || 0);
  if (!value) return '';
  const text = value > 99 ? '99+' : String(value);
  return `<span class="rail-unread-badge" aria-label="${escapeHtml(`${text} ${label}`)}">${escapeHtml(text)}</span>`;
}

function renderRailMessageCount(count, label = 'messages') {
  const value = Math.max(0, Number(count) || 0);
  if (!value) return '';
  const text = value > 99 ? '99+' : String(value);
  return `<span class="rail-unread-badge rail-message-count" aria-label="${escapeHtml(`${text} ${label}`)}">${escapeHtml(text)}</span>`;
}

function renderRailMutedCount(count, label = 'unread discovery hints') {
  const value = Math.max(0, Number(count) || 0);
  if (!value) return '';
  const text = value > 99 ? '99+' : String(value);
  return `<span class="rail-muted-count" aria-label="${escapeHtml(`${text} ${label}`)}">${escapeHtml(text)}</span>`;
}

function renderRailSectionTitle(section, label, count, { modal = '', badge = '', createMenu = false } = {}) {
  const collapsed = Boolean(collapsedSidebarSections[section]);
  const countLabel = count === undefined || count === null ? '' : `<em>${escapeHtml(count)}</em>`;
  const addControl = createMenu
    ? `
      <span class="channel-create-anchor">
        <button class="rail-add-btn" type="button" data-action="toggle-channel-create-menu" aria-expanded="${channelCreateMenuOpen ? 'true' : 'false'}">+</button>
        ${channelCreateMenuOpen ? `
          <span class="channel-create-menu pixel-panel" role="menu">
            <button class="channel-create-menu-item" type="button" data-action="open-channel-create" role="menuitem">+ Create Channel</button>
          </span>
        ` : ''}
      </span>
    `
    : (modal ? `<button class="rail-add-btn" type="button" data-action="open-modal" data-modal="${escapeHtml(modal)}">+</button>` : '<span class="rail-title-spacer"></span>');
  return `
    <div class="rail-title">
      <button class="rail-collapse-btn" type="button" data-action="toggle-sidebar-section" data-section="${escapeHtml(section)}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${escapeHtml(label)}">
        <span aria-hidden="true">${collapsed ? '›' : '⌄'}</span>
      </button>
      <span>${escapeHtml(label)}${badge} ${countLabel}</span>
      ${addControl}
    </div>
  `;
}

function settingsNavItems() {
  return [
    { id: 'account', label: 'Account', icon: 'account' },
    { id: 'browser', label: 'Browser', icon: 'browser', meta: notificationStatusLabel() },
    { id: 'server', label: 'Server', icon: 'server', meta: currentServerProfile().slug || '' },
    { id: 'members', label: 'Members', icon: 'members' },
    { id: 'lost-space', label: 'Lost Space', icon: 'lost' },
    { id: 'language', label: 'Language', icon: 'language', meta: typeof magclawLanguageLabel === 'function' ? magclawLanguageLabel() : '' },
    { id: 'release', label: 'Release Notes', icon: 'release' },
  ];
}

function settingsIcon(name, size = 20) {
  const icons = {
    account: '<path d="M20 21v-2a5 5 0 0 0-5-5H9a5 5 0 0 0-5 5v2"/><circle cx="12" cy="7" r="4"/>',
    members: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    browser: '<rect x="3" y="5" width="18" height="14" rx="1"/><path d="M3 9h18"/>',
    server: '<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M9 7h6"/><path d="M9 12h6"/><path d="M9 17h.01"/><path d="M15 17h.01"/>',
    system: '<path d="M4 7h16"/><path d="M4 17h16"/><path d="M8 3v8"/><path d="M16 13v8"/>',
    console: '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M8 8h8"/><path d="M8 12h4"/><path d="M14 12h2"/><path d="M8 16h8"/>',
    release: '<path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h5"/><path d="M9 13h6"/><path d="M9 17h6"/>',
    language: '<path d="M3 5h12"/><path d="M9 3v2"/><path d="M5 5c1.2 4.4 3.7 7.4 8 9"/><path d="M13 5c-.9 3.2-2.7 5.8-5.4 7.8"/><path d="M14 21l4-9 4 9"/><path d="M15.5 18h5"/>',
    lost: '<path d="M3 7h18"/><path d="M5 7l1 14h12l1-14"/><path d="M9 7V4h6v3"/><path d="M10 12h4"/><path d="M10 16h4"/>',
    computer: '<rect x="3" y="4" width="18" height="13" rx="1"/><path d="M8 21h8"/><path d="M12 17v4"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.1 0l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1 0l-2 2a5 5 0 0 0 7.1 7.1l1.1-1.1"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="1"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    x: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
    alert: '<path d="M12 3l10 18H2L12 3z"/><path d="M12 9v5"/><path d="M12 17h.01"/>',
  };
  return `<svg class="settings-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">${icons[name] || icons.system}</svg>`;
}

function renderNavItem(view, label, icon, badge, { badgeKind = 'meta' } = {}) {
  const active = activeView === view ? ' active' : '';
  const icons = {
    search: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>',
    inbox: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6L5.5 5z"/></svg>',
    message: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M13 8H7"/><path d="M17 12H7"/></svg>',
    file: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14,2 14,8 20,8"/></svg>',
    bookmark: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
    settings: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 3v3"/><path d="M12 18v3"/><path d="M3 12h3"/><path d="M18 12h3"/><path d="M5.6 5.6l2.1 2.1"/><path d="M16.3 16.3l2.1 2.1"/><path d="M18.4 5.6l-2.1 2.1"/><path d="M7.7 16.3l-2.1 2.1"/></svg>',
  };
  const badgeHtml = badgeKind === 'unread'
    ? renderRailUnreadBadge(badge, `${label} unread messages`)
    : (badge ? `<em class="nav-item-meta">${escapeHtml(badge)}</em>` : '');
  return `
    <button class="nav-item${active}" type="button" data-action="set-view" data-view="${view}">
      ${icons[icon] || ''}
      <span>${escapeHtml(label)}</span>
      ${badgeHtml}
    </button>
  `;
}

function renderChannelItem(channel, messageCount = 0) {
  const active = activeView === 'space' && selectedSpaceType === 'channel' && selectedSpaceId === channel.id ? ' active' : '';
  const unreadEntry = typeof serverUnreadEntryForSpace === 'function' ? serverUnreadEntryForSpace('channel', channel.id) : null;
  const readable = typeof currentUserCanReadChannel === 'function' ? currentUserCanReadChannel(channel) : true;
  const unjoined = unreadEntry ? (unreadEntry.joined === false || unreadEntry.muted === true) : !readable;
  const weak = unjoined ? ' unjoined-channel' : '';
  const pinned = isPinnedAllChannelForRail(channel);
  const draggable = !pinned;
  return `
    <button class="space-btn${active}${weak}${pinned ? ' pinned-space' : ''}" type="button" data-action="select-space" data-type="channel" data-id="${channel.id}" draggable="${draggable ? 'true' : 'false'}" data-space-drag-kind="channel" data-space-drag-id="${escapeHtml(channel.id)}">
      <span class="channel-icon">#</span>
      <span class="channel-name">${escapeHtml(channel.name)}</span>
      ${unjoined ? renderRailMutedCount(messageCount, `new public messages in #${channel.name}`) : renderRailUnreadBadge(messageCount, `unread messages in #${channel.name}`)}
    </button>
  `;
}

function renderDmItem(id, name, status, avatar, unreadCount = 0) {
  const active = activeView === 'space' && selectedSpaceType === 'dm' && selectedSpaceId === id ? ' active' : '';
  const label = String(name || 'Unknown').trim() || 'Unknown';
  const initials = label.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  return `
    <button class="space-btn dm-btn${active}" type="button" data-action="select-space" data-type="dm" data-id="${id}" draggable="true" data-space-drag-kind="dm" data-space-drag-id="${escapeHtml(id)}">
      <span class="dm-avatar-wrap">
        <span class="dm-avatar">${avatar ? `<img src="${escapeHtml(avatar)}" alt="">` : escapeHtml(initials)}</span>
        ${avatarStatusDot(status, 'DM status')}
      </span>
      <span class="dm-name">${escapeHtml(label)}</span>
      ${renderRailUnreadBadge(unreadCount, `unread direct messages from ${label}`)}
    </button>
  `;
}

function renderQuick(view, label, count) {
  const active = activeView === view ? ' active' : '';
  return `
    <button class="quick-item${active}" type="button" data-action="set-view" data-view="${view}">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(count)}</strong>
    </button>
  `;
}

function renderSpaceButton(type, id, label, meta) {
  const active = activeView === 'space' && selectedSpaceType === type && selectedSpaceId === id ? ' active' : '';
  return `
    <button class="space-btn${active}" type="button" data-action="select-space" data-type="${type}" data-id="${id}">
      <span>${escapeHtml(label)}</span>
      <small>${escapeHtml(meta || '')}</small>
    </button>
  `;
}

function currentDmPeer() {
  const dm = selectedSpaceType === 'dm' ? currentSpace() : null;
  return dmPeerInfo(dm)?.peer || null;
}

function dmPeerInfo(dm) {
  if (!dm) return null;
  const participantIds = (dm.participantIds || []).map(String).filter(Boolean);
  for (const id of participantIds) {
    const agent = byId(appState?.agents, id);
    if (agent && (typeof agentIsActiveInWorkspace === 'function' ? agentIsActiveInWorkspace(agent) : !agent.deletedAt && !agent.archivedAt)) {
      return {
        dm,
        peer: {
          item: agent,
          type: 'agent',
          id: agent.id,
          name: agent.name || displayName(agent.id),
          status: agentDisplayStatus(agent),
          avatar: agent.avatar || '',
        },
      };
    }
  }
  const humans = participantIds
    .map((id) => humanByIdAny(id))
    .filter(Boolean);
  const peerHuman = humans.find((human) => !humanMatchesCurrentAccount(human)) || null;
  if (!peerHuman) return null;
  return {
    dm,
    peer: {
      item: peerHuman,
      type: 'human',
      id: peerHuman.id,
      name: peerHuman.name || displayName(peerHuman.id),
      status: peerHuman.status || 'offline',
      avatar: peerHuman.avatar || peerHuman.avatarUrl || '',
    },
  };
}

function renderMain() {
  if (activeView === 'members') return renderMembersMain();
  if (activeView === 'tasks') return renderGlobalTasks();
  if (activeView === 'inbox') return renderInbox();
  if (activeView === 'threads') return renderThreads();
  if (activeView === 'saved') return renderSaved();
  if (activeView === 'search') return renderSearch();
  if (activeView === 'missions') return renderMissions();
  if (activeView === 'cloud') return renderCloud();
  if (activeView === 'console') return renderConsole();
  if (activeView === 'computers') return renderComputers();
  return renderSpace();
}

function workspaceActivityKind(type = '') {
  const value = String(type || '').toLowerCase();
  if (/computer|daemon|device|pairing|runtime/.test(value)) return 'computer';
  if (/member|human|invite|invitation|role|auth/.test(value)) return 'member';
  return 'system';
}

function workspaceActivityTitle(type = '', fallback = '') {
  const text = String(fallback || '').trim();
  if (text) return text;
  const label = String(type || 'system_activity')
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
  return label || 'Workspace activity';
}

function workspaceActivityDetail(item = {}) {
  const parts = [];
  if (item.agentId) parts.push(`Agent: ${displayName(item.agentId)}`);
  if (item.humanId) parts.push(`Member: ${displayName(item.humanId)}`);
  if (item.memberId) parts.push(`Member: ${displayName(item.memberId)}`);
  if (item.computerId) parts.push(`Computer: ${byId(appState?.computers, item.computerId)?.name || item.computerId}`);
  if (item.workspaceId) parts.push(`Workspace: ${item.workspaceId}`);
  if (item.role || item.targetRole) parts.push(`Role: ${cloudRoleLabel(item.role || item.targetRole)}`);
  return parts.join(' · ');
}

function liveWorkspaceActivityRecords() {
  const records = [];
  for (const item of appState?.events || []) {
    const type = item.type || 'system_event';
    records.push({
      id: item.id || `event:${type}:${item.createdAt}`,
      source: 'event',
      kind: workspaceActivityKind(type),
      type,
      title: workspaceActivityTitle(type, item.message),
      detail: workspaceActivityDetail(item),
      createdAt: item.createdAt || item.updatedAt,
    });
  }
  for (const item of appState?.cloud?.daemonEvents || []) {
    const type = item.type || item.event || 'daemon_event';
    records.push({
      id: item.id || `daemon:${type}:${item.createdAt}`,
      source: 'daemon',
      kind: workspaceActivityKind(type),
      type,
      title: workspaceActivityTitle(type, item.message || item.detail),
      detail: workspaceActivityDetail(item),
      createdAt: item.createdAt || item.updatedAt,
    });
  }
  for (const item of [...(appState?.cloud?.systemNotifications || []), ...(appState?.systemNotifications || [])]) {
    const type = item.event || item.type || 'member_notification';
    records.push({
      id: item.id || `notification:${type}:${item.createdAt}`,
      source: 'notification',
      kind: workspaceActivityKind(type),
      type,
      title: workspaceActivityTitle(type, item.message || 'Member notification'),
      detail: workspaceActivityDetail(item),
      createdAt: item.createdAt || item.updatedAt,
    });
  }

  const seen = new Set();
  return records
    .filter((item) => item.id && item.createdAt && !seen.has(item.id) && seen.add(item.id))
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
}

function workspaceActivityRecords() {
  return mergeWorkspaceActivityCache(liveWorkspaceActivityRecords());
}

function workspaceActivityUnreadCount(records = workspaceActivityRecords(), humanId = currentHumanId()) {
  const readAt = Date.parse(workspaceActivityReadAt(humanId) || '');
  return records.filter((item) => {
    const createdAt = Date.parse(item.createdAt || '');
    return createdAt && (!readAt || createdAt > readAt);
  }).length;
}

function buildThreadInboxItem(message, humanId = currentHumanId()) {
  const replies = threadReplies(message.id);
  const lastReply = replies.at(-1);
  const previewRecord = threadPreviewRecord(message);
  const author = displayName(message.authorId);
  const lastReplyAuthor = displayName(previewRecord?.authorId || message.authorId);
  const task = message.taskId ? byId(appState.tasks, message.taskId) : null;
  const unreadRecords = threadUnreadRecords(message, humanId);
  return {
    id: `thread:${message.id}`,
    type: 'thread',
    recordId: message.id,
    message,
    task,
    author,
    previewRecord,
    lastReply,
    lastReplyAuthor,
    unreadCount: unreadRecords.length,
    updatedAt: threadUpdatedAt(message),
    title: plainMentionText(message.body).slice(0, 140) || '(attachment)',
    preview: threadPreviewText(message),
  };
}

function buildDirectInboxItem(record, humanId = currentHumanId()) {
  const author = displayName(record.authorId);
  return {
    id: `record:${record.id}`,
    type: 'direct',
    recordId: record.id,
    message: record,
    author,
    unreadCount: recordUnreadForHuman(record, humanId) ? 1 : 0,
    updatedAt: recordUpdatedAt(record),
    title: `${author}: ${plainMentionText(record.body).slice(0, 140) || '(attachment)'}`,
    preview: `${spaceName(record.spaceType, record.spaceId)} · ${fmtTime(record.createdAt)}`,
  };
}

function buildInboxModel() {
  const humanId = currentHumanId();
  const threadItems = (appState.messages || [])
    .filter((message) => message.replyCount > 0 || message.taskId)
    .map((message) => buildThreadInboxItem(message, humanId));
  const threadedMessageIds = new Set(threadItems.map((item) => item.recordId));
  const directItems = (appState.messages || [])
    .filter((message) => message.authorType === 'agent' && !threadedMessageIds.has(message.id))
    .map((message) => buildDirectInboxItem(message, humanId));
  const activityRecords = workspaceActivityRecords();
  const workspacePreview = activityRecords.slice(-2).map((item) => item.title).join(' · ');
  const workspaceItem = {
    id: 'workspace-activity',
    type: 'workspace',
    unreadCount: 0,
    updatedAt: new Date(activityRecords.at(-1)?.createdAt || 0).getTime(),
    title: 'Server Activity',
    preview: workspacePreview || 'Members, computers, and system changes will appear here.',
    records: activityRecords,
  };
  const normalItems = [...threadItems, ...directItems]
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const allItems = [workspaceItem, ...normalItems];
  const unreadCount = normalItems.reduce((sum, item) => sum + item.unreadCount, 0);
  return {
    humanId,
    normalItems,
    allItems,
    threadItems,
    directItems,
    workspaceItem,
    activeCount: normalItems.length,
    unreadCount,
  };
}

function inboxVisibleItems(model) {
  let items = model.allItems;
  if (inboxCategory === 'threads') items = model.threadItems;
  if (inboxCategory === 'direct') items = model.directItems;
  if (inboxCategory === 'workspace') items = [model.workspaceItem];
  if (inboxCategory === 'unread' || inboxFilter === 'unread') items = items.filter((item) => item.unreadCount > 0);
  return items;
}

function renderInboxCategoryButton(id, label, count) {
  const active = inboxCategory === id ? ' active' : '';
  return `
    <button class="inbox-category-btn${active}" type="button" data-action="set-inbox-category" data-category="${id}">
      <span>${escapeHtml(label)}</span>
      ${count === null || count === undefined ? '' : `<em>${escapeHtml(count)}</em>`}
    </button>
  `;
}

function renderInboxItem(item) {
  if (item.type === 'workspace') return renderWorkspaceActivityInboxItem(item);
  const message = item.message;
  const active = threadMessageId === item.recordId ? ' active' : '';
  const unread = item.unreadCount ? ' unread' : '';
  const task = item.task || (message.taskId ? byId(appState.tasks, message.taskId) : null);
  const action = item.type === 'thread' ? 'open-inbox-item' : 'open-inbox-item';
  return `
    <button class="thread-row magclaw-thread-row inbox-row inbox-${escapeHtml(item.type)}${active}${unread}" type="button" data-action="${action}" data-id="${escapeHtml(item.recordId)}" data-inbox-type="${escapeHtml(item.type)}">
      <span class="thread-row-avatar">
        ${renderThreadRowAvatar(item.previewRecord || message)}
      </span>
      <span class="thread-row-main">
        <span class="thread-row-meta-line">
          <span>${escapeHtml(spaceName(message.spaceType, message.spaceId))}</span>
          ${item.type === 'thread' ? renderThreadKindBadge(message, task) : '<span class="thread-kind-badge">Direct</span>'}
          <span>${escapeHtml(item.author)}</span>
          <time>${fmtTime(item.lastReply?.createdAt || message.updatedAt || message.createdAt)}</time>
        </span>
        <strong>${escapeHtml(item.title)}</strong>
        <small>${escapeHtml(item.preview)}</small>
      </span>
      <span class="thread-row-side">
        ${item.unreadCount ? `<span class="inbox-unread-count">${escapeHtml(item.unreadCount)}</span>` : '<span>0</span>'}
        <span class="thread-row-check" title="Open">✓</span>
      </span>
    </button>
  `;
}

function renderWorkspaceActivityInboxItem(item) {
  const active = workspaceActivityDrawerOpen ? ' active' : '';
  return `
    <button class="thread-row magclaw-thread-row inbox-row inbox-workspace${active}" type="button" data-action="open-workspace-activity">
      <span class="thread-row-avatar workspace-activity-avatar">WA</span>
      <span class="thread-row-main">
        <span class="thread-row-meta-line">
          <span>Members · Computers · System</span>
          <time>${item.records.at(-1) ? fmtTime(item.records.at(-1).createdAt) : 'No activity'}</time>
        </span>
        <strong>${escapeHtml(item.title)}</strong>
        <small>${escapeHtml(item.preview)}</small>
      </span>
      <span class="thread-row-side">
        <span class="thread-row-check" title="Open activity">LOG</span>
      </span>
    </button>
  `;
}

function renderInbox() {
  const model = buildInboxModel();
  const visibleItems = inboxVisibleItems(model);
  const actions = `
    <button class="secondary-btn compact" type="button" data-action="mark-inbox-read">Mark all read</button>
  `;
  return `
    <section class="inbox-page">
      ${renderHeader('Activities', `${model.activeCount} active · ${model.unreadCount} unread`, actions)}
      <div class="inbox-shell">
        <aside class="inbox-category-panel pixel-panel">
          ${renderInboxCategoryButton('all', 'All', model.activeCount)}
          ${renderInboxCategoryButton('unread', 'Unread', model.unreadCount)}
          ${renderInboxCategoryButton('threads', 'Threads', model.threadItems.length)}
          ${renderInboxCategoryButton('direct', 'Direct Messages', model.directItems.length)}
          ${renderInboxCategoryButton('workspace', 'Server Activity', null)}
        </aside>
        <section class="inbox-list-wrap">
          <div class="inbox-toolbar pixel-panel">
            <div class="inbox-filter-tabs">
              ${['all', 'unread'].map((filter) => `
                <button class="${inboxFilter === filter ? 'active' : ''}" type="button" data-action="set-inbox-filter" data-filter="${filter}">${filter === 'all' ? 'All' : 'Unread'}</button>
              `).join('')}
            </div>
            <span>${escapeHtml(visibleItems.length)} shown</span>
          </div>
          <div class="list-panel thread-list-panel magclaw-thread-list inbox-list-panel">
            ${visibleItems.length ? visibleItems.map(renderInboxItem).join('') : '<div class="empty-box small">No activities for this filter.</div>'}
          </div>
        </section>
      </div>
    </section>
  `;
}

function renderMembersMain() {
  const agent = selectedAgentId ? byId(appState.agents, selectedAgentId) : null;
  const human = selectedHumanId ? humanByIdAny(selectedHumanId) : null;
  if (human) return renderHumanDetail(human);
  if (agent) return renderAgentDetail(agent);
  return `
    <section class="members-empty-page">
      ${renderHeader('Members', 'Select an Agent or Human from the sidebar.', cloudCan('manage_agents') ? '<button class="primary-btn" type="button" data-action="open-modal" data-modal="agent">+ Create Agent</button>' : '')}
      <div class="pixel-panel cloud-card empty-box">Choose a Human to view profile details, or choose an Agent to inspect runtime, tools, and workspaces.</div>
    </section>
  `;
}
