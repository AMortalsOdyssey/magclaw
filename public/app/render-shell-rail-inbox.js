function render() {
  if (!appState) {
    root.innerHTML = '<div class="boot">MAGCLAW LOCAL / BOOTING</div>';
    return;
  }
  const scrollSnapshot = {
    main: paneScrollSnapshot('main'),
    thread: paneScrollSnapshot('thread'),
    workspaceActivity: workspaceActivityScrollSnapshot(),
  };
  ensureSelection();
  persistUiState();
  const inspectorHtml = renderInspector();
  const notificationBanner = renderNotificationPromptBanner();
  const taskFocusLayout = activeView === 'tasks';
  const settingsLayout = activeView === 'cloud';
  root.innerHTML = `
    ${notificationBanner}
    <div class="app-frame collab-frame${inspectorHtml ? '' : ' no-inspector'}${taskFocusLayout ? ' task-focus' : ''}${settingsLayout ? ' settings-layout-frame' : ''}${notificationBanner ? ' notification-banner-active' : ''}" style="${appFrameStyle()}">
      ${renderRail()}
      ${taskFocusLayout ? '' : '<div class="rail-resizer" data-action="none" role="separator" aria-label="Resize sidebar" aria-orientation="vertical" tabindex="0"></div>'}
      <main class="workspace collab-main">
        ${renderMain()}
      </main>
      ${inspectorHtml ? `
        <div class="inspector-resizer" data-action="none" role="separator" aria-label="Resize inspector panel" aria-orientation="vertical" tabindex="0"></div>
        <aside class="inspector collab-inspector">
          ${inspectorHtml}
        </aside>
      ` : ''}
    </div>
    ${modal ? renderModal() : ''}
  `;
  window.requestAnimationFrame(() => {
    restorePaneScrolls(scrollSnapshot);
    restoreWorkspaceActivityScroll(scrollSnapshot.workspaceActivity);
    restorePendingComposerFocus();
    if (workspaceActivityDrawerOpen && workspaceActivityScrollToBottom) {
      workspaceActivityScrollToBottom = false;
      scrollWorkspaceActivityToBottom('auto');
    }
  });
}

function renderRail() {
  const channels = appState.channels || [];
  const dms = appState.dms || [];
  const inbox = buildInboxModel();
  const spaceUnreadCounts = buildSpaceUnreadCounts(inbox.humanId);
  const unreadThreads = (appState.messages || []).filter((message) => message.replyCount > 0 || message.taskId).length;
  const openTasks = (appState.tasks || []).filter((task) => !taskIsClosedStatus(task.status)).length;
  const saved = savedRecords().length;
  const normalAgents = channelAssignableAgents();
  const localHuman = byId(appState.humans, appState.cloud?.auth?.currentMember?.humanId)
    || byId(appState.humans, 'hum_local')
    || appState.humans?.[0]
    || { name: 'You' };
  const railMode = activeView === 'tasks'
    ? 'tasks'
    : activeView === 'cloud'
      ? 'settings'
      : activeView === 'computers' || (activeView === 'missions' && railTab === 'computers')
        ? 'desktop'
        : railTab === 'members'
          ? 'members'
          : 'chat';
  const railHeading = railMode === 'tasks'
    ? 'Tasks'
    : railMode === 'members'
      ? 'Members'
      : railMode === 'settings'
        ? 'Settings'
        : railMode === 'desktop'
          ? 'Computers'
          : 'Chat';
  const sidebarBody = railMode === 'settings'
      ? renderSettingsRail()
      : railMode === 'desktop'
        ? renderComputersRail()
      : railTab === 'spaces'
        ? renderChatRail({ channels, dms, inboxUnread: inbox.unreadCount, unreadThreads, openTasks, saved, spaceUnreadCounts })
        : renderMembersRail({ normalAgents });
  const railClass = `rail collab-rail slock-rail${railMode === 'settings' ? ' settings-rail' : ''}`;
  const leftRailHtml = `
    <div class="slock-left-rail">
        <button class="left-rail-avatar" type="button" data-action="set-settings-tab" data-tab="account" title="${escapeHtml(localHuman.name || 'You')}">${escapeHtml((localHuman.name || 'Y').trim().slice(0, 1).toUpperCase())}</button>
      ${renderLeftRailButton('chat', railMode, 'Chat', '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>', inbox.unreadCount || '')}
      ${renderLeftRailButton('tasks', railMode, 'Tasks', '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>', openTasks || '')}
      ${renderLeftRailButton('members', railMode, 'Members', '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>', normalAgents.length || '')}
      ${renderLeftRailButton('desktop', railMode, 'Computers', '<rect x="3" y="4" width="18" height="13" rx="1"/><path d="M8 21h8"/><path d="M12 17v4"/>')}
      <span class="left-rail-spacer"></span>
      ${renderLeftRailButton('settings', railMode, 'Settings', '<circle cx="12" cy="12" r="3"/><path d="M12 3v3"/><path d="M12 18v3"/><path d="M3 12h3"/><path d="M18 12h3"/><path d="M5.6 5.6l2.1 2.1"/><path d="M16.3 16.3l2.1 2.1"/><path d="M18.4 5.6l-2.1 2.1"/><path d="M7.7 16.3l-2.1 2.1"/>')}
    </div>
  `;

  if (activeView === 'tasks') {
    return `
      <aside class="${railClass} rail-icon-only">
        ${leftRailHtml}
      </aside>
    `;
  }

  return `
    <aside class="${railClass}">
      ${leftRailHtml}
      <div class="slock-sidebar">
        <div class="slock-sidebar-header">
          <h2>${escapeHtml(railHeading)}</h2>
        </div>

      ${sidebarBody}

      <div class="runtime-chip">
        <span class="status-dot ${appState.connection?.mode === 'cloud' ? 'online' : ''}"></span>
        <div>
          <strong>${escapeHtml(appState.runtime?.host || 'local')}</strong>
          <small>${escapeHtml(appState.connection?.mode === 'cloud' ? 'Connected' : 'Local')}</small>
        </div>
      </div>
      </div>
    </aside>
  `;
}

function renderChatRail({ channels, dms, inboxUnread, unreadThreads, openTasks, saved, spaceUnreadCounts }) {
  return `
    <div class="nav-list">
      ${renderNavItem('search', 'Search', 'search', searchQuery ? '⌘K' : '⌘K')}
      ${renderNavItem('inbox', 'Inbox', 'inbox', inboxUnread || '', { badgeKind: 'unread' })}
      ${renderNavItem('threads', 'Threads', 'message', unreadThreads || '')}
      ${renderNavItem('tasks', 'Tasks', 'file', openTasks || '')}
      ${renderNavItem('saved', 'Saved', 'bookmark', saved || '')}
    </div>

    <div class="rail-section">
      ${renderRailSectionTitle('channels', 'Channels', channels.length, { modal: 'channel' })}
      ${collapsedSidebarSections.channels ? '' : channels.map((channel) => renderChannelItem(channel, unreadCountForSpace(spaceUnreadCounts, 'channel', channel.id))).join('')}
    </div>

      <div class="rail-section">
        ${renderRailSectionTitle('dms', 'DIRECT MESSAGES', dms.length, { modal: 'dm' })}
        ${collapsedSidebarSections.dms ? '' : dms.map((dm) => {
        const other = dm.participantIds.find((id) => id !== 'hum_local');
        const agent = byId(appState.agents, other);
        const human = byId(appState.humans, other);
        const status = agent?.status || human?.status || '';
        return renderDmItem(dm.id, displayName(other), status, agent?.avatar || human?.avatar, unreadCountForSpace(spaceUnreadCounts, 'dm', dm.id));
        }).join('')}
      </div>

    `;
}

function renderMembersRail({ normalAgents }) {
  const humans = humansByJoinOrder();
  return `
    <div class="rail-section">
      ${renderRailSectionTitle('agents', 'Agents', normalAgents.length, { modal: 'agent' })}
      ${collapsedSidebarSections.agents ? '' : normalAgents.map((agent) => renderAgentListItem(agent)).join('')}
    </div>

      <div class="rail-section">
        ${renderRailSectionTitle('humans', 'Humans', humans.length, { modal: 'human' })}
        ${collapsedSidebarSections.humans ? '' : humans.map((human) => renderHumanListItem(human)).join('')}
      </div>
    `;
}

function humansByJoinOrder() {
  const cloudMembers = (appState.cloud?.members || [])
    .filter((member) => (member.status || 'active') === 'active')
    .sort((a, b) => new Date(a.joinedAt || a.createdAt || 0) - new Date(b.joinedAt || b.createdAt || 0));
  if (cloudMembers.length) {
    return cloudMembers
      .map((member) => byId(appState.humans, member.humanId) || member.human)
      .filter(Boolean);
  }
  return (appState.humans || []).filter((human) => human.status !== 'removed');
}

function renderComputersRail() {
  const computers = appState.computers || [];
  return `
    <div class="rail-section">
      ${renderRailSectionTitle('computers', 'Computers', computers.length, { modal: 'computer' })}
      ${collapsedSidebarSections.computers ? '' : computers.map((computer) => renderComputerListItem(computer)).join('')}
    </div>

    <div class="rail-section">
      ${renderRailSectionTitle('computer-features', 'Feature Entrances', 3)}
      ${collapsedSidebarSections['computer-features'] ? '' : `
        <button class="space-btn computer-feature-entry${activeView === 'computers' ? ' active' : ''}" type="button" data-action="set-view" data-view="computers">
          <span class="channel-icon">PC</span>
          <span class="dm-name">Computer Overview</span>
        </button>
        <button class="space-btn computer-feature-entry${activeView === 'missions' ? ' active' : ''}" type="button" data-action="set-view" data-view="missions">
          <span class="channel-icon">RUN</span>
          <span class="dm-name">Codex Missions</span>
        </button>
        <button class="space-btn computer-feature-entry" type="button" data-action="open-modal" data-modal="computer">
          <span class="channel-icon">+</span>
          <span class="dm-name">Add Computer</span>
        </button>
      `}
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

function renderRailSectionTitle(section, label, count, { modal = '' } = {}) {
  const collapsed = Boolean(collapsedSidebarSections[section]);
  const countLabel = count === undefined || count === null ? '' : `<em>${escapeHtml(count)}</em>`;
  return `
    <div class="rail-title">
      <button class="rail-collapse-btn" type="button" data-action="toggle-sidebar-section" data-section="${escapeHtml(section)}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${escapeHtml(label)}">
        <span aria-hidden="true">${collapsed ? '›' : '⌄'}</span>
      </button>
      <span>${escapeHtml(label)} ${countLabel}</span>
      ${modal ? `<button class="rail-add-btn" type="button" data-action="open-modal" data-modal="${escapeHtml(modal)}">+</button>` : '<span class="rail-title-spacer"></span>'}
    </div>
  `;
}

function settingsNavItems() {
  const fanoutConfigured = appState.settings?.fanoutApi?.configured;
  return [
    { id: 'account', label: 'Account', icon: 'account' },
    { id: 'browser', label: 'Browser', icon: 'browser', meta: notificationStatusLabel() },
    { id: 'server', label: 'Server', icon: 'server', meta: appState.connection?.mode || 'local' },
    { id: 'system', label: 'System Config', icon: 'system', meta: fanoutConfigured ? 'LLM' : 'rules' },
    { id: 'members', label: 'Members', icon: 'members', meta: `${(appState.cloud?.members || []).filter((member) => (member.status || 'active') === 'active').length}` },
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
    release: '<path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h5"/><path d="M9 13h6"/><path d="M9 17h6"/>',
    computer: '<rect x="3" y="4" width="18" height="13" rx="1"/><path d="M8 21h8"/><path d="M12 17v4"/>',
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

function renderChannelItem(channel, unreadCount = 0) {
  const active = activeView === 'space' && selectedSpaceType === 'channel' && selectedSpaceId === channel.id ? ' active' : '';
  return `
    <button class="space-btn${active}" type="button" data-action="select-space" data-type="channel" data-id="${channel.id}">
      <span class="channel-icon">#</span>
      <span class="channel-name">${escapeHtml(channel.name)}</span>
      ${renderRailUnreadBadge(unreadCount, `unread messages in #${channel.name}`)}
    </button>
  `;
}

function renderDmItem(id, name, status, avatar, unreadCount = 0) {
  const active = activeView === 'space' && selectedSpaceType === 'dm' && selectedSpaceId === id ? ' active' : '';
  const initials = name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  return `
    <button class="space-btn dm-btn${active}" type="button" data-action="select-space" data-type="dm" data-id="${id}">
      <span class="dm-avatar-wrap">
        <span class="dm-avatar">${avatar ? `<img src="${escapeHtml(avatar)}" alt="">` : escapeHtml(initials)}</span>
        ${avatarStatusDot(status, 'DM status')}
      </span>
      <span class="dm-name">${escapeHtml(name)}</span>
      ${renderRailUnreadBadge(unreadCount, `unread direct messages from ${name}`)}
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
  const participantIds = dm?.participantIds || [];
  const peerId = participantIds.find((id) => id !== 'hum_local') || participantIds[0];
  const agent = byId(appState?.agents, peerId);
  if (agent) return { item: agent, type: 'agent', status: agent.status || 'offline', avatar: agent.avatar };
  const human = byId(appState?.humans, peerId);
  if (human) return { item: human, type: 'human', status: human.status || 'offline', avatar: human.avatar };
  return null;
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

function workspaceActivityRecords() {
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
  const workspaceUnread = workspaceActivityUnreadCount(activityRecords, humanId);
  const workspacePreview = activityRecords.slice(-2).map((item) => item.title).join(' · ');
  const workspaceItem = {
    id: 'workspace-activity',
    type: 'workspace',
    unreadCount: workspaceUnread,
    updatedAt: new Date(activityRecords.at(-1)?.createdAt || 0).getTime(),
    title: 'Workspace Activity',
    preview: workspacePreview || 'Members, computers, and system changes will appear here.',
    records: activityRecords,
  };
  const normalItems = [...threadItems, ...directItems]
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const allItems = [...normalItems, workspaceItem]
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const unreadCount = allItems.reduce((sum, item) => sum + item.unreadCount, 0);
  return {
    humanId,
    normalItems,
    allItems,
    threadItems,
    directItems,
    workspaceItem,
    activeCount: allItems.length,
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
      <em>${escapeHtml(count)}</em>
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
    <button class="thread-row slock-thread-row inbox-row inbox-${escapeHtml(item.type)}${active}${unread}" type="button" data-action="${action}" data-id="${escapeHtml(item.recordId)}" data-inbox-type="${escapeHtml(item.type)}">
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
  const unread = item.unreadCount ? ' unread' : '';
  return `
    <button class="thread-row slock-thread-row inbox-row inbox-workspace${active}${unread}" type="button" data-action="open-workspace-activity">
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
        ${item.unreadCount ? `<span class="inbox-unread-count">${escapeHtml(item.unreadCount)}</span>` : '<span>0</span>'}
        <span class="thread-row-check" title="Open activity">✓</span>
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
      ${renderHeader('Inbox', `${model.activeCount} active · ${model.unreadCount} unread`, actions)}
      <div class="inbox-shell">
        <aside class="inbox-category-panel pixel-panel">
          ${renderInboxCategoryButton('all', 'All', model.activeCount)}
          ${renderInboxCategoryButton('unread', 'Unread', model.unreadCount)}
          ${renderInboxCategoryButton('threads', 'Threads', model.threadItems.length)}
          ${renderInboxCategoryButton('direct', 'Direct Messages', model.directItems.length)}
          ${renderInboxCategoryButton('workspace', 'Workspace Activity', model.workspaceItem.unreadCount || model.workspaceItem.records.length)}
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
          <div class="list-panel thread-list-panel slock-thread-list inbox-list-panel">
            ${visibleItems.length ? visibleItems.map(renderInboxItem).join('') : '<div class="empty-box small">No inbox items for this filter.</div>'}
          </div>
        </section>
      </div>
    </section>
  `;
}

function renderMembersMain() {
  const agent = selectedAgentId ? byId(appState.agents, selectedAgentId) : null;
  return agent ? renderAgentDetail(agent) : renderSpace();
}
