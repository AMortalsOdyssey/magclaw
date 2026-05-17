const MOBILE_VIEWPORT_QUERY = '(max-width: 767px)';
const mobileViewportMedia = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia(MOBILE_VIEWPORT_QUERY)
  : null;
let mobileViewport = mobileViewportMedia
  ? mobileViewportMedia.matches
  : (typeof window !== 'undefined' ? window.innerWidth <= 767 : false);

function isMobileViewport() {
  return Boolean(mobileViewport);
}

function applyVisualViewportVars() {
  if (typeof document === 'undefined') return;
  const viewport = window.visualViewport;
  const height = Math.max(320, Math.round(viewport?.height || window.innerHeight || 0));
  const width = Math.max(320, Math.round(viewport?.width || window.innerWidth || 0));
  document.documentElement.style.setProperty('--vv-height', `${height}px`);
  document.documentElement.style.setProperty('--vv-width', `${width}px`);
}

function syncMobileViewport() {
  const next = mobileViewportMedia
    ? mobileViewportMedia.matches
    : (typeof window !== 'undefined' ? window.innerWidth <= 767 : false);
  const changed = next !== mobileViewport;
  mobileViewport = next;
  applyVisualViewportVars();
  if (changed && appState) render();
}

if (mobileViewportMedia?.addEventListener) {
  mobileViewportMedia.addEventListener('change', syncMobileViewport);
} else if (mobileViewportMedia?.addListener) {
  mobileViewportMedia.addListener(syncMobileViewport);
}
window.addEventListener('resize', syncMobileViewport);
window.addEventListener('orientationchange', () => window.setTimeout(syncMobileViewport, 80));
window.visualViewport?.addEventListener('resize', applyVisualViewportVars);
window.visualViewport?.addEventListener('scroll', applyVisualViewportVars);
applyVisualViewportVars();

function mobileIcon(name) {
  const icons = {
    home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10.5V21h5v-6h4v6h5V10.5"/>',
    tasks: '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
    members: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3"/><path d="M12 18v3"/><path d="M3 12h3"/><path d="M18 12h3"/><path d="M5.6 5.6l2.1 2.1"/><path d="M16.3 16.3l2.1 2.1"/><path d="M18.4 5.6l-2.1 2.1"/><path d="M7.7 16.3l-2.1 2.1"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4.2-4.2"/>',
    inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.5 5h13L22 12v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6L5.5 5z"/>',
    message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    saved: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
    computer: '<rect x="3" y="4" width="18" height="13" rx="1"/><path d="M8 21h8"/><path d="M12 17v4"/>',
    hash: '<path d="M5 9h14"/><path d="M4 15h14"/><path d="M10 3 8 21"/><path d="m16 3-2 18"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="1"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    folder: '<path d="M3 6h7l2 2h9v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
    sort: '<path d="M7 4v16"/><path d="m4 7 3-3 3 3"/><path d="M17 20V4"/><path d="m14 17 3 3 3-3"/>',
    square: '<rect x="5" y="5" width="14" height="14" rx="1"/>',
    leave: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>',
    menu: '<path d="M4 7h16"/><path d="M4 12h16"/><path d="M4 17h16"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    activity: '<path d="M22 12h-4l-3 8L9 4l-3 8H2"/>',
    send: '<path d="m22 2-7 20-4-9-9-4 20-7z"/>',
  };
  return `<svg class="mobile-icon" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">${icons[name] || icons.home}</svg>`;
}

function mobileResetTransientDetail() {
  threadMessageId = null;
  workspaceActivityDrawerOpen = false;
  inspectorReturnThreadId = null;
  selectedTaskId = null;
  selectedSavedRecordId = null;
  selectedProjectFile = null;
  selectedAgentWorkspaceFile = null;
}

function openMobileRoot(nav = 'home') {
  if (typeof persistVisiblePaneScrolls === 'function') persistVisiblePaneScrolls();
  mobileResetTransientDetail();
  selectedAgentId = null;
  selectedHumanId = null;
  selectedComputerId = null;
  if (nav === 'tasks') {
    railTab = 'spaces';
    activeView = 'tasks';
    mobileHomeOpen = false;
  } else if (nav === 'members') {
    railTab = 'members';
    activeView = 'members';
    membersLayout = normalizeMembersLayout({ mode: 'directory' });
    mobileHomeOpen = false;
  } else if (nav === 'settings') {
    railTab = 'settings';
    activeView = 'cloud';
    settingsTab = 'root';
    mobileHomeOpen = false;
  } else if (nav === 'computers') {
    railTab = 'computers';
    activeView = 'computers';
    mobileHomeOpen = false;
  } else {
    railTab = 'spaces';
    activeView = 'space';
    activeTab = 'chat';
    mobileHomeOpen = true;
  }
  localStorage.setItem('railTab', railTab);
  render();
  syncBrowserRouteForActiveView();
}

function mobileNavigateBack() {
  if (threadMessageId) {
    threadMessageId = null;
    selectedSavedRecordId = null;
    render();
    syncBrowserRouteForActiveView();
    return;
  }
  if (selectedTaskId) {
    selectedTaskId = null;
    render();
    syncBrowserRouteForActiveView();
    return;
  }
  if (workspaceActivityDrawerOpen) {
    workspaceActivityDrawerOpen = false;
    activeView = 'inbox';
    render();
    syncBrowserRouteForActiveView();
    return;
  }
  if (selectedAgentId || selectedHumanId) {
    selectedAgentId = null;
    selectedHumanId = null;
    selectedProjectFile = null;
    selectedAgentWorkspaceFile = null;
    agentDetailEditState = { field: null };
    agentEnvEditState = null;
    humanDescriptionEditState = { humanId: null };
    if (activeView !== 'members') activeView = 'space';
    if (activeView === 'members') membersLayout = normalizeMembersLayout({ mode: 'directory' });
    if (activeView === 'space') mobileHomeOpen = true;
    render();
    syncBrowserRouteForActiveView();
    return;
  }
  if (selectedComputerId) {
    selectedComputerId = null;
    render();
    syncBrowserRouteForActiveView();
    return;
  }
  if (activeView === 'cloud' && settingsTab !== 'root') {
    settingsTab = 'root';
    render();
    syncBrowserRouteForActiveView();
    return;
  }
  if (activeView === 'space' && !mobileHomeOpen) {
    mobileHomeOpen = true;
    render();
    syncBrowserRouteForActiveView();
    return;
  }
  if (activeView === 'computers') {
    openMobileRoot('settings');
    return;
  }
  openMobileRoot('home');
}

function mobileDetailActive() {
  if (threadMessageId || selectedTaskId || selectedAgentId || selectedHumanId || selectedComputerId || workspaceActivityDrawerOpen) return true;
  if (activeView === 'space') return !mobileHomeOpen;
  if (activeView === 'cloud') return settingsTab !== 'root';
  return ['search', 'inbox', 'threads', 'saved', 'missions', 'console', 'computers'].includes(activeView);
}

function renderMobileTopbar(title, subtitle = '', actions = '', leading = '') {
  return `
    <header class="mobile-topbar">
      <button class="mobile-back-btn" type="button" data-action="mobile-back" aria-label="Back">
        <span aria-hidden="true">‹</span>
      </button>
      <div class="mobile-topbar-identity">
        ${leading ? `<span class="mobile-topbar-leading">${leading}</span>` : ''}
        <div class="mobile-topbar-title">
          <strong>${escapeHtml(title || 'MagClaw')}</strong>
          ${subtitle ? `<small>${escapeHtml(subtitle)}</small>` : ''}
        </div>
      </div>
      <div class="mobile-topbar-actions">${actions}</div>
    </header>
  `;
}

function renderMobileTopbarAction({ action = '', modal = '', id = '', label = '', icon = 'menu', className = '', extra = '' } = {}) {
  const attrs = [
    action ? `data-action="${escapeHtml(action)}"` : '',
    modal ? `data-modal="${escapeHtml(modal)}"` : '',
    id ? `data-id="${escapeHtml(id)}"` : '',
    extra,
  ].filter(Boolean).join(' ');
  return `
    <button class="mobile-topbar-action ${escapeHtml(className)}" type="button" ${attrs} aria-label="${escapeHtml(label || icon)}" title="${escapeHtml(label || icon)}">
      ${mobileIcon(icon)}
      ${label && className.includes('with-label') ? `<span>${escapeHtml(label)}</span>` : ''}
    </button>
  `;
}

function renderMobileHomeHeader(serverProfile) {
  const serverName = serverProfile.name || displayServerSlug(serverProfile.slug) || 'MagClaw';
  return `
    <header class="mobile-home-header">
      <div class="server-switcher-anchor mobile-server-switcher">
        <button class="mobile-server-switch-btn" type="button" data-action="toggle-server-switcher" aria-label="Switch server">
          <span>${escapeHtml(serverName)}</span>
          <strong aria-hidden="true">⌄</strong>
        </button>
        ${renderServerSwitcherMenu()}
      </div>
      <button class="mobile-alert-btn" type="button" data-action="set-view" data-view="inbox" aria-label="Open inbox">
        ${mobileIcon('bell')}
      </button>
    </header>
  `;
}

function renderMobileRootHeader(title, subtitle = '', actions = '') {
  return `
    <header class="mobile-root-header">
      <div>
        <h1>${escapeHtml(title)}</h1>
        ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ''}
      </div>
      ${actions ? `<div class="mobile-root-actions">${actions}</div>` : ''}
    </header>
  `;
}

function renderMobileBottomNav() {
  const items = [
    { id: 'home', label: 'HOME', icon: 'home', active: activeView === 'space' && mobileHomeOpen },
    { id: 'tasks', label: 'TASKS', icon: 'tasks', active: activeView === 'tasks' },
    { id: 'members', label: 'MEMBERS', icon: 'members', active: activeView === 'members' },
    { id: 'settings', label: 'SETTINGS', icon: 'settings', active: activeView === 'cloud' && settingsTab === 'root' },
  ];
  return `
    <nav class="mobile-bottom-nav" aria-label="Primary navigation">
      ${items.map((item) => `
        <button class="${item.active ? 'active' : ''}" type="button" data-action="mobile-nav" data-nav="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.label)}">
          ${mobileIcon(item.icon)}
          <span>${escapeHtml(item.label)}</span>
        </button>
      `).join('')}
    </nav>
  `;
}

function renderMobileQuickAction(view, label, icon, count = '', hint = '') {
  return `
    <button class="mobile-quick-action" type="button" data-action="set-view" data-view="${escapeHtml(view)}">
      ${mobileIcon(icon)}
      <span>${escapeHtml(label)}${hint ? `<small>${escapeHtml(hint)}</small>` : ''}</span>
      ${count ? `<strong>${escapeHtml(count)}</strong>` : ''}
    </button>
  `;
}

function renderMobileSectionTitle(label, count = '', actions = '') {
  return `
    <div class="mobile-section-title">
      <span>${escapeHtml(label)}${count !== '' ? `<em>${escapeHtml(count)}</em>` : ''}</span>
      ${actions ? `<div class="mobile-section-tools">${actions}</div>` : ''}
    </div>
  `;
}

function renderMobileHome() {
  const channels = appState.channels || [];
  const dms = appState.dms || [];
  const inbox = buildInboxModel();
  const spaceUnreadCounts = buildSpaceUnreadCounts(inbox.humanId);
  const saved = savedRecords().length;
  const serverProfile = currentServerProfile();
  const dmPeers = dms
    .map((dm) => dmPeerInfo(dm))
    .filter((item) => item?.dm?.id && item?.peer);
  return `
    <section class="mobile-root mobile-home">
      ${renderMobileHomeHeader(serverProfile)}
      <div class="mobile-shortcut-list">
        ${renderMobileQuickAction('search', 'Search', 'search')}
        ${renderMobileQuickAction('inbox', 'Inbox', 'inbox', inbox.unreadCount || '')}
        ${renderMobileQuickAction('threads', 'Threads', 'message', inbox.threadItems.length || '')}
        ${renderMobileQuickAction('saved', 'Saved', 'saved', saved || '')}
      </div>
      <section class="mobile-list-section">
        ${renderMobileSectionTitle('Channels', channels.length, `
          <button type="button" data-action="set-view" data-view="threads" aria-label="Threads">${mobileIcon('sort')}</button>
          <button type="button" data-action="open-modal" data-modal="channel" aria-label="Add channel">${mobileIcon('plus')}</button>
        `)}
        <div class="mobile-list">
          ${channels.length ? channels.map((channel) => renderChannelItem(channel, unreadCountForSpace(spaceUnreadCounts, 'channel', channel.id))).join('') : '<div class="empty-box small">No channels yet.</div>'}
        </div>
      </section>
      <section class="mobile-list-section">
        ${renderMobileSectionTitle('Direct Messages', dmPeers.length, `
          <button type="button" data-action="set-view" data-view="inbox" aria-label="Inbox">${mobileIcon('sort')}</button>
          <button type="button" data-action="open-modal" data-modal="dm" aria-label="New direct message">${mobileIcon('plus')}</button>
        `)}
        <div class="mobile-list">
          ${dmPeers.length ? dmPeers.map(({ dm, peer }) => (
            renderDmItem(dm.id, peer.name || displayName(peer.id), peer.status || 'offline', peer.avatar || '', unreadCountForSpace(spaceUnreadCounts, 'dm', dm.id))
          )).join('') : '<div class="empty-box small">No direct messages yet.</div>'}
        </div>
      </section>
    </section>
  `;
}

function renderMobileTaskToolbar(tasks, filteredTasks, options = {}) {
  return `
    <div class="mobile-task-toolbar">
      <div class="mobile-task-toolbar-row">
        ${options.showChannelFilter === false ? '<span></span>' : renderTaskChannelFilter()}
        ${renderTaskViewToggle()}
      </div>
      <div class="mobile-task-toolbar-row compact">
        ${options.showNew ? '<button class="primary-btn compact mobile-new-task-btn" type="button" data-action="open-modal" data-modal="task">+ New Task</button>' : '<span></span>'}
        <span class="task-toolbar-count">${escapeHtml(taskCountLabel(tasks.length, filteredTasks.length))}</span>
      </div>
    </div>
  `;
}

function renderMobileTaskSurface(tasks, options = {}) {
  const visibleTasks = Array.isArray(options.filteredTasks)
    ? options.filteredTasks
    : options.useStatusFilter
    ? (taskFilter === 'all' ? tasks : tasks.filter((task) => task.status === taskFilter))
    : tasks;
  return `
    <section class="mobile-task-surface task-page">
      ${renderMobileTaskToolbar(tasks, visibleTasks, options)}
      <div class="mobile-task-view ${taskViewMode === 'list' ? 'is-list' : 'is-board'}">
        ${taskViewMode === 'list' ? renderTaskListView(visibleTasks) : renderTaskBoard(visibleTasks)}
      </div>
    </section>
  `;
}

function renderMobileTasksHome() {
  const channelTasks = (appState.tasks || []).filter(isVisibleChannelTask);
  const filteredTasks = channelTasks.filter(taskMatchesChannelFilter);
  const subtitle = taskCountLabel(channelTasks.length, filteredTasks.length);
  return `
    <section class="mobile-root mobile-tasks-root task-page">
      ${renderMobileRootHeader('Tasks', subtitle)}
      ${renderMobileTaskSurface(channelTasks, { filteredTasks, showChannelFilter: true })}
    </section>
  `;
}

function renderMobileMembersHome() {
  const normalAgents = channelAssignableAgents();
  const humans = humansByJoinOrder();
  const canCreateAgent = cloudCan('manage_agents');
  return `
    <section class="mobile-root mobile-members-root">
      ${renderMobileRootHeader('Members', '')}
      <section class="mobile-list-section">
        ${renderMobileSectionTitle('Agents', normalAgents.length, canCreateAgent ? `<button type="button" data-action="open-modal" data-modal="agent" aria-label="Create agent">${mobileIcon('plus')}</button>` : '')}
        <div class="mobile-list mobile-member-list">${renderAgentGroupsByComputer(normalAgents)}</div>
      </section>
      <section class="mobile-list-section">
        ${renderMobileSectionTitle('Humans', humans.length, `<button type="button" data-action="open-modal" data-modal="member-invite" aria-label="Invite human">${mobileIcon('plus')}</button>`)}
        <div class="mobile-list mobile-member-list">${humans.length ? humans.map((human) => renderHumanListItem(human)).join('') : '<div class="empty-box small">No humans yet.</div>'}</div>
      </section>
    </section>
  `;
}

function renderMobileSettingsHome() {
  const items = settingsNavItems();
  return `
    <section class="mobile-root mobile-settings-root">
      ${renderMobileRootHeader('Settings', '')}
      <nav class="mobile-settings-list" aria-label="Settings">
        ${items.map((item) => `
          <button class="mobile-settings-row" type="button" data-action="set-settings-tab" data-tab="${escapeHtml(item.id)}">
            ${settingsIcon(item.icon, 18)}
            <span>${escapeHtml(item.label)}</span>
            ${item.meta ? `<em>${escapeHtml(item.meta)}</em>` : ''}
          </button>
        `).join('')}
        <button class="mobile-settings-row" type="button" data-action="set-left-nav" data-nav="console">
          ${settingsIcon('console', 18)}
          <span>Console</span>
        </button>
      </nav>
    </section>
  `;
}

function renderMobileComputersList() {
  const computers = sortComputersByAvailability(appState.computers || []);
  const canManageComputers = cloudCan('manage_computers');
  return `
    <section class="mobile-detail mobile-computers-list-detail">
      ${renderMobileTopbar('Computers', '', canManageComputers ? renderMobileTopbarAction({ action: 'open-modal', modal: 'computer', label: 'Add computer', icon: 'plus' }) : '')}
      <div class="mobile-detail-body mobile-list mobile-computer-list">
        ${computers.length ? computers.map((computer) => renderComputerListItem(computer)).join('') : '<div class="empty-box small">No computers connected yet.</div>'}
      </div>
    </section>
  `;
}

function renderMobileDetailPage(title, subtitle, body, className = '') {
  return `
    <section class="mobile-detail ${escapeHtml(className)}">
      ${renderMobileTopbar(title, subtitle)}
      <div class="mobile-detail-body">
        ${body}
      </div>
    </section>
  `;
}

function renderMobileSpaceTabs() {
  const tabs = [
    ['chat', 'Chat', 'message'],
    ['tasks', 'Tasks', 'tasks'],
    ['files', 'Files', 'file'],
  ];
  return `
    <nav class="mobile-space-tabs" aria-label="Conversation sections">
      ${tabs.map(([id, label, icon]) => `
        <button class="${activeTab === id ? 'active' : ''}" type="button" data-action="set-tab" data-tab="${escapeHtml(id)}">
          ${mobileIcon(icon)}
          <span>${escapeHtml(label)}</span>
        </button>
      `).join('')}
    </nav>
  `;
}

function renderMobileFilesPanel(canWrite = true) {
  if (selectedSpaceType !== 'channel') {
    return '<section class="mobile-files-panel"><div class="empty-box small">No shared files in this direct message yet.</div></section>';
  }
  return `
    <section class="mobile-files-panel">
      ${renderProjectStrip({ canWrite })}
    </section>
  `;
}

function renderMobileSpaceDetail() {
  const space = currentSpace();
  if (!space) return renderMobileDetailPage('No conversation', 'MagClaw', '', 'mobile-space-detail');
  const title = spaceName(selectedSpaceType, selectedSpaceId);
  const isDm = selectedSpaceType === 'dm';
  const canWriteChannel = selectedSpaceType !== 'channel' || currentUserIsChannelMember(space);
  const members = selectedSpaceType === 'channel' ? getChannelMembers(selectedSpaceId) : null;
  const memberCount = members ? members.agents.length + members.humans.length : 0;
  const allChannelSelected = selectedSpaceType === 'channel' && isAllChannel(space);
  const peer = isDm ? currentDmPeer() : null;
  const leading = isDm
    ? `<span class="mobile-dm-avatar">${peer?.avatar ? `<img src="${escapeHtml(peer.avatar)}" alt="">` : escapeHtml(displayAvatar(peer?.item?.id || title, peer?.type || 'human'))}${avatarStatusDot(peer?.status || 'offline', 'DM status')}</span>`
    : `<span class="mobile-space-glyph">${mobileIcon(space.private ? 'lock' : 'hash')}</span>`;
  const actions = isDm ? `
      ${renderMobileTopbarAction({ action: 'open-modal', modal: 'task', label: 'New task', icon: 'tasks' })}
      ${renderMobileTopbarAction({ action: 'open-modal', modal: 'confirm-stop-all', label: 'Stop all', icon: 'square' })}
    ` : `
      ${canWriteChannel ? renderMobileTopbarAction({ action: 'open-modal', modal: 'project', label: 'Projects', icon: 'folder' }) : ''}
      ${canWriteChannel ? renderMobileTopbarAction({ action: 'open-modal', modal: 'edit-channel', label: 'Edit channel', icon: 'settings' }) : ''}
      ${canWriteChannel && !allChannelSelected ? renderMobileTopbarAction({ action: 'leave-channel', label: 'Leave channel', icon: 'leave' }) : ''}
      ${renderMobileTopbarAction({ action: 'open-modal', modal: 'channel-members', label: `${memberCount} members`, icon: 'members', className: 'with-count', extra: `data-count="${escapeHtml(memberCount)}"` })}
      ${canWriteChannel ? renderMobileTopbarAction({ action: 'open-modal', modal: 'confirm-stop-all', label: 'Stop all', icon: 'square' }) : ''}
    `;
  const subtitle = isDm
    ? `${peer?.status || 'offline'}`
    : (space.description || 'Channel');
  return `
    <section class="mobile-detail mobile-space-detail">
      ${renderMobileTopbar(title, subtitle, actions, leading)}
      ${renderMobileSpaceTabs()}
      <div class="mobile-space-content ${activeTab === 'tasks' ? 'is-tasks' : activeTab === 'files' ? 'is-files' : 'is-chat'}">
        ${activeTab === 'tasks'
          ? renderMobileTaskSurface(spaceTasks(), { showNew: true, showChannelFilter: false })
          : activeTab === 'files'
            ? renderMobileFilesPanel(canWriteChannel)
            : (isDm ? renderDmChat() : renderChat())}
      </div>
    </section>
  `;
}

function renderMobileAgentDetail(agent) {
  const running = agentIsRunning(agent);
  const actions = `
    ${renderMobileTopbarAction({ action: 'open-dm-with-agent', id: agent.id, label: 'Message', icon: 'message', className: 'with-label' })}
    ${renderMobileTopbarAction({ action: 'open-agent-restart', id: agent.id, label: running ? 'Restart' : 'Start / Restart', icon: 'activity' })}
  `;
  return `
    <section class="mobile-detail mobile-agent-detail">
      ${renderMobileTopbar(agent.name || 'Agent', agent.description || runtimeConfigurationLabel(agent) || 'Agent', actions, `<span class="agent-detail-avatar-frame mini">${getAvatarHtml(agent.id, 'agent', 'agent-detail-avatar-preview')}</span>`)}
      <div class="mobile-detail-body">
        ${renderAgentDetail(agent)}
      </div>
    </section>
  `;
}

function renderMobileHumanDetail(human) {
  return `
    <section class="mobile-detail mobile-human-detail">
      ${renderMobileTopbar(human.name || 'Human', humanIsCurrent(human) ? 'You' : 'Human', renderMobileTopbarAction({ action: 'open-dm-with-human', id: human.id, label: 'Message', icon: 'message', className: 'with-label' }), `<span class="agent-detail-avatar-frame mini">${renderHumanAvatar(human, 'agent-detail-avatar-preview')}</span>`)}
      <div class="mobile-detail-body">
        ${renderHumanDetail(human)}
      </div>
    </section>
  `;
}

function renderMobileComputerDetail(computer) {
  return `
    <section class="mobile-detail mobile-computer-detail">
      ${renderMobileTopbar(computer.name || computer.hostname || 'Computer', computer.hostname || computer.localHostname || '', '', renderComputerIcon(computer, 18))}
      <div class="mobile-detail-body">
        ${renderComputerDetail(computer)}
      </div>
    </section>
  `;
}

function renderMobileMain() {
  const thread = threadMessageId ? byId(appState.messages, threadMessageId) : null;
  if (thread) return renderMobileDetailPage('Thread', spaceName(thread.spaceType, thread.spaceId), renderThreadDrawer(thread), 'mobile-thread-detail');

  const task = selectedTaskId ? byId(appState.tasks, selectedTaskId) : null;
  if (task) return renderMobileDetailPage(`Task #${task.number || shortId(task.id)}`, spaceName(task.spaceType, task.spaceId), renderTaskDetail(task), 'mobile-task-detail');

  if (workspaceActivityDrawerOpen) return renderMobileDetailPage('Workspace Activity', 'Members · Computers · System', renderWorkspaceActivityDrawer(), 'mobile-activity-detail');

  const selectedAgent = selectedAgentId ? byId(appState.agents, selectedAgentId) : null;
  if (selectedAgent) return renderMobileAgentDetail(selectedAgent);

  const selectedHuman = selectedHumanId ? humanByIdAny(selectedHumanId) : null;
  if (selectedHuman) return renderMobileHumanDetail(selectedHuman);

  const selectedComputer = selectedComputerId ? byId(appState.computers, selectedComputerId) : null;
  if (selectedComputer) return renderMobileComputerDetail(selectedComputer);

  if (activeView === 'space') return mobileHomeOpen ? renderMobileHome() : renderMobileSpaceDetail();
  if (activeView === 'tasks') return renderMobileTasksHome();
  if (activeView === 'members') return renderMobileMembersHome();
  if (activeView === 'cloud') {
    return settingsTab === 'root'
      ? renderMobileSettingsHome()
      : renderMobileDetailPage(settingsPageMeta().title, 'Settings', renderCloud(), 'mobile-settings-detail');
  }
  if (activeView === 'computers') return renderMobileComputersList();
  if (activeView === 'search') return renderMobileDetailPage('Search', '', renderSearch(), 'mobile-search-detail');
  if (activeView === 'inbox') return renderMobileDetailPage('Inbox', '', renderInbox(), 'mobile-inbox-detail');
  if (activeView === 'threads') return renderMobileDetailPage('Threads', '', renderThreads(), 'mobile-threads-detail');
  if (activeView === 'saved') return renderMobileDetailPage('Saved', '', renderSaved(), 'mobile-saved-detail');
  if (activeView === 'missions') return renderMobileDetailPage('Codex Missions', '', renderMissions(), 'mobile-missions-detail');
  if (activeView === 'console') return renderMobileDetailPage('Console', '', renderConsole(), 'mobile-console-detail');
  return renderMobileHome();
}

function renderMobileShell() {
  applyVisualViewportVars();
  const detail = mobileDetailActive();
  return `
    <div class="mobile-app-shell${detail ? ' is-detail' : ' is-root'}">
      <main class="mobile-page">
        ${renderMobileMain()}
      </main>
      ${detail ? '' : renderMobileBottomNav()}
    </div>
  `;
}
