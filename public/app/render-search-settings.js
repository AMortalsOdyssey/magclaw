const searchTimeRangeOptions = [
  ['any', 'Any Time'],
  ['today', 'Today'],
  ['7d', 'Last 7 Days'],
  ['30d', 'Last 30 Days'],
];

function searchTimeRangeLabel() {
  return searchTimeRangeOptions.find(([value]) => value === searchTimeRange)?.[1] || 'Any Time';
}

function renderSearchLensIcon(size = 18) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4.2-4.2"/></svg>`;
}

function renderSearchEntityResult(item, activeKey) {
  const active = activeKey === item.id ? ' active' : '';
  return `
    <button class="search-result-card search-entity-card${active}" type="button" data-action="open-search-entity" data-target-type="${escapeHtml(item.targetType)}" data-target-id="${escapeHtml(item.targetId)}">
      <span class="search-entity-icon">${item.type === 'channel' ? '#' : item.type === 'dm' ? '@' : 'AG'}</span>
      <span class="search-entity-copy">
        <span class="search-result-meta">
          <strong>${escapeHtml(item.label)}</strong>
          <em>${escapeHtml(item.meta)}</em>
        </span>
        <span class="search-result-snippet">${highlightSearchText(item.body, searchQuery)}</span>
      </span>
    </button>
  `;
}

function renderSearchResult(record) {
  const parent = record.parentMessageId ? byId(appState?.messages, record.parentMessageId) : null;
  const task = byId(appState?.tasks, record.taskId || parent?.taskId);
  const isReply = Boolean(parent);
  const snippet = searchSnippet(searchRecordBody(record) || '(attachment)', searchQuery);
  const active = selectedSavedRecordId === record.id ? ' active' : '';
  return `
    <button class="search-result-card${active}" type="button" data-action="open-search-result" data-id="${escapeHtml(record.id)}">
      <span class="search-result-meta">
        <strong>${escapeHtml(recordSpaceName(record))}</strong>
        ${isReply ? '<em>thread</em>' : ''}
        ${task ? renderTaskInlineBadge(task, { showAssignee: false }) : ''}
        <span>${escapeHtml(displayName(record.authorId))}</span>
        <time>${fmtTime(record.createdAt)}</time>
      </span>
      <span class="search-result-snippet">${highlightSearchText(snippet, searchQuery)}</span>
    </button>
  `;
}

function renderSearchEmptyState(kind, query = '') {
  if (kind === 'empty') {
    return `
      <div class="search-center-state">
        <span class="search-center-icon">${renderSearchLensIcon(58)}</span>
        <strong>Search everything</strong>
        <span>Search channels, DIRECT MESSAGES, people, agents, and message history.</span>
      </div>
    `;
  }
  return `
    <div class="search-center-state search-no-results">
      <span class="search-center-icon">${renderSearchLensIcon(58)}</span>
      <strong>No results for "${escapeHtml(query)}"</strong>
      <span>Try different keywords or a shorter phrase.</span>
    </div>
  `;
}

function renderSearchFilters() {
  const filtersActive = searchMineOnly || searchTimeRange !== 'any';
  return `
    <div class="search-filter-row" data-search-filters>
      <button class="search-filter-btn${searchMineOnly ? ' active' : ''}" type="button" data-action="toggle-search-mine">My Messages</button>
      <div class="search-time-filter${searchTimeMenuOpen ? ' open' : ''}">
        <button class="search-filter-btn search-time-btn${searchTimeRange !== 'any' ? ' active cyan' : ''}" type="button" data-action="toggle-search-range-menu" aria-expanded="${searchTimeMenuOpen ? 'true' : 'false'}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M8 2v4"/><path d="M16 2v4"/><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18"/></svg>
          <span>${escapeHtml(searchTimeRangeLabel())}</span>
          <span aria-hidden="true">⌄</span>
        </button>
        ${searchTimeMenuOpen ? `
          <div class="search-time-menu" role="menu">
            ${searchTimeRangeOptions.map(([value, label]) => `
              <button class="${searchTimeRange === value ? 'active' : ''}" type="button" data-action="set-search-range" data-range="${escapeHtml(value)}" role="menuitem">${escapeHtml(label)}</button>
            `).join('')}
          </div>
        ` : ''}
      </div>
      ${filtersActive || searchQuery.trim() ? '<button class="search-clear-all" type="button" data-action="clear-search-all">Clear All</button>' : ''}
    </div>
  `;
}

function renderSearchResults() {
  const query = searchQuery.trim();
  if (!query) return renderSearchEmptyState('empty');

  const entities = searchMineOnly || searchTimeRange !== 'any' ? [] : searchEntityResults(query);
  const messageResults = currentSearchMessageResults();
  const visibleMessages = messageResults.slice(0, searchVisibleCount);
  const total = entities.length + messageResults.length;
  if (!total) {
    return `
      <div class="search-summary">0 results</div>
      ${renderSearchEmptyState('none', query)}
    `;
  }
  return `
    <div class="search-summary">${total} ${total === 1 ? 'result' : 'results'}</div>
    ${entities.length ? `
      <div class="search-section-label">People & Places</div>
      ${entities.map(renderSearchEntityResult).join('')}
    ` : ''}
    ${messageResults.length ? `
      <div class="search-section-label">Messages</div>
      ${visibleMessages.map(renderSearchResult).join('')}
      ${visibleMessages.length < messageResults.length ? `
        <div class="search-load-row">
          <button class="search-load-more" type="button" data-action="load-more-search">Load More</button>
        </div>
      ` : ''}
    ` : ''}
  `;
}

function updateSearchResults() {
  const input = document.getElementById('search-input');
  if (input && input.value !== searchQuery && !searchIsComposing) input.value = searchQuery;
  const container = document.querySelector('[data-search-results]');
  if (container) container.innerHTML = renderSearchResults();
  const filters = document.querySelector('[data-search-filters]');
  if (filters) filters.outerHTML = renderSearchFilters();
  const clearButton = document.querySelector('[data-search-clear]');
  if (clearButton) clearButton.hidden = !searchQuery.trim();
}

function openSearchResult(record) {
  const parent = record.parentMessageId ? byId(appState?.messages, record.parentMessageId) : null;
  const root = parent || record;
  markConversationRecordRead(record);
  workspaceActivityDrawerOpen = false;
  selectedSavedRecordId = record.id;
  selectedAgentId = null;
  selectedTaskId = null;
  selectedProjectFile = null;
  inspectorReturnThreadId = null;
  const opensThread = Boolean(parent || root.replyCount > 0 || root.taskId);
  if (activeView === 'search' && opensThread) {
    threadMessageId = root.id;
    render();
    if (record.parentMessageId) scrollToReply(record.id);
    focusSearchInputEnd();
    return;
  }
  selectedSpaceType = root.spaceType;
  selectedSpaceId = root.spaceId;
  activeView = 'space';
  activeTab = 'chat';
  threadMessageId = opensThread ? root.id : null;
  render();
  scrollToMessage(root.id);
  if (record.parentMessageId) scrollToReply(record.id);
}

function openSearchEntity(targetType, targetId) {
  if (targetType === 'channel' || targetType === 'dm') {
    selectedSpaceType = targetType;
    selectedSpaceId = targetId;
    activeView = 'space';
    activeTab = 'chat';
    threadMessageId = null;
    selectedSavedRecordId = null;
    render();
    scrollPaneToBottom('#message-list', 'auto');
    return;
  }
  if (targetType === 'agent') {
    selectedAgentId = targetId;
    selectedTaskId = null;
    selectedProjectFile = null;
    threadMessageId = null;
    render();
  }
}

function focusSearchInputEnd() {
  const focusInput = () => {
    const input = document.getElementById('search-input');
    if (!input) return false;
    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
    return true;
  };

  focusInput();
  window.requestAnimationFrame(focusInput);
  window.setTimeout(focusInput, 40);
  window.setTimeout(focusInput, 120);
}

function openSearchView() {
  activeView = 'search';
  activeTab = 'chat';
  threadMessageId = null;
  inspectorReturnThreadId = null;
  selectedProjectFile = null;
  selectedAgentId = null;
  selectedTaskId = null;
  render();
  focusSearchInputEnd();
}

function renderSearch() {
  return `
    <section class="search-page">
      <div class="search-topbar">
        <button class="search-top-icon" type="button" aria-label="Search">${renderSearchLensIcon(18)}</button>
        <div class="search-input-shell">
          <input id="search-input" value="${escapeHtml(searchQuery)}" placeholder="Search channels, DIRECT MESSAGES, messages..." autocomplete="off" autofocus />
          <button class="search-clear-btn" type="button" data-action="clear-search-query" data-search-clear aria-label="Clear search" ${searchQuery.trim() ? '' : 'hidden'}>×</button>
        </div>
      </div>
      ${renderSearchFilters()}
      <div class="search-results" data-search-results>
        ${renderSearchResults()}
      </div>
    </section>
  `;
}

function renderMissions() {
  const missions = appState.missions || [];
  return `
    ${renderHeader('Codex Missions', 'Local runner history', '')}
    <section class="list-panel pixel-panel">
      ${missions.length ? missions.map((mission) => {
        const run = (appState.runs || []).find((item) => item.missionId === mission.id);
        return `
          <article class="mission-mini">
            <strong>${escapeHtml(mission.title)}</strong>
            <p>${escapeHtml(mission.goal)}</p>
            <small>${escapeHtml(mission.status)} / ${run ? escapeHtml(run.status) : 'no run'}</small>
          </article>
        `;
      }).join('') : '<div class="empty-box">No Codex missions yet. Use Run Codex from a task.</div>'}
    </section>
  `;
}

function renderComputers() {
  const computers = appState.computers || [];
  const connected = computers.filter((computer) => computer.status === 'connected').length;
  return `
    <section class="computers-page">
      <header class="settings-page-header">
        <div class="settings-page-heading">
          <div class="settings-page-icon">${settingsIcon('computer', 24)}</div>
          <h2>Computers</h2>
        </div>
        <div class="action-row">
          <button class="secondary-btn" type="button" data-action="create-computer-pairing">Pair Computer</button>
          <button class="primary-btn" type="button" data-action="open-modal" data-modal="computer">Add Computer</button>
        </div>
      </header>
      <div class="settings-section-label">
        ${settingsIcon('computer', 18)}
        <span>LOCAL RUNNERS</span>
      </div>
      <section class="cloud-layout">
        ${renderComputerConfigCard()}
        <div class="pixel-panel cloud-card">
          <div class="panel-title"><span>Feature Entrances</span><span>${connected}/${computers.length || 0} connected</span></div>
          <div class="mode-cards">
            <button class="mode-card active" type="button" data-action="set-view" data-view="computers">
              <strong>Computer Overview</strong>
              <span>Review registered local and remote runners without mixing them into member management.</span>
            </button>
            <button class="mode-card" type="button" data-action="set-view" data-view="missions">
              <strong>Codex Missions</strong>
              <span>Open the local runner history for task-backed Codex runs.</span>
            </button>
            <button class="mode-card" type="button" data-action="open-modal" data-modal="agent">
              <strong>Create Agent</strong>
              <span>Bind a new agent to an available computer and runtime.</span>
            </button>
          </div>
        </div>
      </section>
    </section>
  `;
}

function renderComputerConfigCard() {
  const computers = appState.computers || [];
  return `
    <div class="pixel-panel cloud-card">
      <div class="panel-title"><span>Computers</span><span>${computers.length}</span></div>
      <div class="computer-config-list">
        ${computers.map((computer) => `
          <div class="computer-config-row">
            <strong>${escapeHtml(computer.name || 'Computer')}</strong>
            <span>${escapeHtml(computer.os || computer.hostname || 'unknown')} / ${escapeHtml(computer.status || 'offline')}</span>
            <small>${escapeHtml((computer.runtimeIds || []).join(', ') || computer.connectedVia || 'no runtimes')}</small>
          </div>
        `).join('') || '<div class="empty-box small">No computers configured.</div>'}
      </div>
      ${latestPairingCommand ? `
        <div class="pair-command-box">
          <span>Connect Command</span>
          <code>${escapeHtml(latestPairingCommand.command || '')}</code>
          <button class="secondary-btn" type="button" data-action="copy-pairing-command">Copy</button>
        </div>
      ` : ''}
      <button class="secondary-btn" type="button" data-action="open-modal" data-modal="computer">Add Computer</button>
      <button class="secondary-btn" type="button" data-action="create-computer-pairing">Pair Computer</button>
    </div>
  `;
}

function renderFanoutApiConfigCard() {
  const config = appState.settings?.fanoutApi || {};
  const status = config.configured ? 'LLM enabled' : 'Rules fallback';
  return `
    <div class="pixel-panel cloud-card fanout-config-card">
      <form id="fanout-config-form" class="modal-form">
        <div class="panel-title"><span>Fan-out API</span><span>${escapeHtml(status)}</span></div>
        <p class="fanout-api-note">Local rules always route immediately. When a message is ambiguous, this API can add a supplemental LLM route after the rules route has already been delivered.</p>
        <label class="checkline"><input type="checkbox" name="enabled" ${config.enabled ? 'checked' : ''} /> Enable async LLM supplement for ambiguous routing</label>
        <label><span>Base URL</span><input name="baseUrl" value="${escapeHtml(config.baseUrl || '')}" placeholder="https://model-api.skyengine.com.cn/v1" /></label>
        <label><span>Model</span><input name="model" value="${escapeHtml(config.model || '')}" placeholder="qwen3.5-flash" /></label>
        <label><span>Fallback Model</span><input name="fallbackModel" value="${escapeHtml(config.fallbackModel || '')}" placeholder="deepseek-v4-flash" /></label>
        <label><span>Timeout</span><input name="timeoutMs" type="number" min="500" max="30000" step="500" value="${escapeHtml(config.timeoutMs || 5000)}" /></label>
        <label>
          <span>Force LLM Keywords</span>
          <textarea name="forceKeywords" rows="3" placeholder="">${escapeHtml((config.forceKeywords || []).join('\n'))}</textarea>
          <small>Optional. Matching messages still route by rules first, then queue an LLM supplement.</small>
        </label>
        <label>
          <span>API Key</span>
          <input name="apiKey" type="password" autocomplete="off" placeholder="${escapeHtml(config.hasApiKey ? `${config.apiKeyPreview} configured - leave blank to keep` : 'paste API key')}" />
          <small>${escapeHtml(config.hasApiKey ? `Stored key preview: ${config.apiKeyPreview}` : 'No key stored yet.')}</small>
        </label>
        ${config.hasApiKey ? '<label class="checkline"><input type="checkbox" name="clearApiKey" /> Clear saved API key</label>' : ''}
        <button class="primary-btn" type="submit">Save Fan-out API</button>
      </form>
    </div>
  `;
}

function settingsPageMeta(tab = settingsTab) {
  const metas = {
    account: { title: 'Account', icon: 'account', section: 'ACCOUNT' },
    browser: { title: 'Browser', icon: 'browser', section: 'BROWSER' },
    server: { title: 'Server', icon: 'server', section: 'SERVER' },
    system: { title: 'System Config', icon: 'system', section: 'SYSTEM CONFIG' },
    members: { title: 'Members', icon: 'members', section: 'MEMBERS' },
    release: { title: 'Release Notes', icon: 'release', section: "WHAT'S NEW" },
  };
  return metas[tab] || metas.account;
}

function renderSettingsChrome(body, actions = '') {
  const meta = settingsPageMeta();
  const mobileTabs = settingsNavItems().map((item) => `
    <button class="${settingsTab === item.id ? 'active' : ''}" type="button" data-action="set-settings-tab" data-tab="${escapeHtml(item.id)}">
      ${settingsIcon(item.icon, 16)}
      <span>${escapeHtml(item.label)}</span>
    </button>
  `).join('');
  return `
    <section class="settings-page">
      <header class="settings-page-header">
        <div class="settings-page-heading">
          <div class="settings-page-icon">${settingsIcon(meta.icon, 24)}</div>
          <h2>${escapeHtml(meta.title)}</h2>
        </div>
        ${actions ? `<div class="action-row">${actions}</div>` : ''}
      </header>
      <div class="settings-section-label">
        ${settingsIcon(meta.icon, 18)}
        <span>${escapeHtml(meta.section)}</span>
      </div>
      <nav class="settings-page-mobile-tabs" aria-label="Settings sections">
        ${mobileTabs}
      </nav>
      ${body}
    </section>
  `;
}

function renderAccountSettingsTab() {
  const c = appState.connection || {};
  const cloud = appState.cloud || {};
  const auth = cloud.auth || {};
  const currentUser = auth.currentUser;
  const currentMember = auth.currentMember;
  const human = currentAccountHuman();
  const role = currentMember?.role || human.role || 'member';
  const roleLabel = cloudRoleLabel(role);
  const capabilityLabels = cloudCapabilityLabels(auth.capabilities || {});
  const joinedAt = fmtTime(currentMember?.joinedAt || currentMember?.createdAt);
  const sessionLabel = durationDays(auth.sessionTtlMs);
  const sessionExpiresAt = fmtTime(auth.sessionExpiresAt);
  const authPanel = !auth.initialized ? `
      <div class="pixel-panel cloud-card">
        <div class="panel-title"><span>Sign-in Account</span><span>server config</span></div>
        <div class="empty-box small">The initial sign-in account is configured on the server. Restart MagClaw after updating the server environment.</div>
      </div>
    ` : '';
    return `
      <section class="settings-layout account-layout">
        <div class="pixel-panel cloud-card account-overview-card">
          <div class="account-profile-main">
            <span class="settings-account-avatar account-avatar-lg">${getAvatarHtml(human.id || 'hum_local', 'human', 'settings-account-avatar-inner')}</span>
          <div>
              <p class="eyebrow">Human Profile</p>
              <h3>${escapeHtml(human.name || currentUser?.name || 'You')}</h3>
              <p>${escapeHtml(human.email || currentUser?.email || 'Local MagClaw user')}</p>
            </div>
          </div>
          <div class="account-role-badge role-${escapeHtml(role)}">
            <span>Role</span>
            <strong>${escapeHtml(roleLabel)}</strong>
            <small>${escapeHtml(humanPresenceText(human))}</small>
          </div>
          ${currentUser ? `<button class="secondary-btn account-signout-btn" type="button" data-action="open-modal" data-modal="confirm-sign-out">Sign Out</button>` : ''}
          </div>
        ${currentUser ? `
        <div class="account-grid">
          <div class="pixel-panel cloud-card account-edit-card">
            <form id="profile-form" class="modal-form account-profile-form" data-human-id="${escapeHtml(human.id || '')}">
              <div class="panel-title"><span>Personal Profile</span><span>${escapeHtml(roleLabel)}</span></div>
              <div class="profile-avatar-row">
                <span class="settings-account-avatar">${getAvatarHtml(human.id || 'hum_local', 'human', 'settings-account-avatar-inner')}</span>
              <input id="profile-avatar-input" type="hidden" name="avatar" value="${escapeHtml(human.avatar || '')}" />
                <div class="account-avatar-actions">
                  <button class="secondary-btn" type="button" data-action="random-profile-avatar">Random</button>
                  <button class="secondary-btn" type="button" data-action="pick-profile-avatar">Browse</button>
                  <label class="secondary-btn profile-upload-btn">Upload<input id="profile-avatar-file" class="visually-hidden" type="file" accept="image/*" /></label>
                </div>
              </div>
              <label><span>Display Name</span><input name="displayName" value="${escapeHtml(human.name || currentUser.name || '')}" /></label>
              <label><span>Description</span><textarea name="description" rows="3">${escapeHtml(human.description || '')}</textarea></label>
              <button class="primary-btn" type="submit">Save</button>
            </form>
          </div>
          <div class="pixel-panel cloud-card account-access-card">
            <div class="panel-title"><span>Access</span><span>${escapeHtml(c.workspaceId || 'local')}</span></div>
            <div class="account-meta-grid">
              <div><span>Joined</span><strong>${escapeHtml(joinedAt)}</strong></div>
              <div><span>User ID</span><strong>${escapeHtml(currentUser.id || human.authUserId || human.id || '--')}</strong></div>
              <div><span>Session</span><strong>${escapeHtml(sessionLabel)}</strong><small>${escapeHtml(sessionExpiresAt)}</small></div>
            </div>
            <div class="account-permission-chips">
              ${(capabilityLabels.length ? capabilityLabels : ['Invite members']).map((label) => `<span>${escapeHtml(label)}</span>`).join('')}
            </div>
          </div>
        </div>
        ` : ''}
        ${authPanel}
    </section>
  `;
}

function normalizeInviteEmailValue(value) {
  return String(value || '').trim().toLowerCase();
}

function validInviteEmailsFromValue(value) {
  return String(value || '')
    .split(/[\s,;，；]+/)
    .map(normalizeInviteEmailValue)
    .filter((email, index, list) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && list.indexOf(email) === index);
}

function memberInviteEmailsForSubmit() {
  return [...new Set([...cloudInviteEmails, ...validInviteEmailsFromValue(cloudInviteDraft)])];
}

function memberInviteValidCount() {
  return memberInviteEmailsForSubmit().length;
}

function commitMemberInviteDraft(value = cloudInviteDraft) {
  const emails = validInviteEmailsFromValue(value);
  if (!emails.length) return false;
  cloudInviteEmails = [...new Set([...cloudInviteEmails, ...emails])];
  cloudInviteDraft = '';
  return true;
}

function relativeMemberTime(value) {
  const timestamp = Date.parse(value || '');
  if (!timestamp) return '--';
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} 个月前`;
  return `${Math.floor(months / 12)} 年前`;
}

function memberDisplayName(member) {
  return member?.user?.name || member?.human?.name || member?.user?.email || member?.humanId || 'Member';
}

function memberEmail(member) {
  return member?.user?.email || member?.human?.email || member?.userId || '';
}

function memberAvatar(member, pending = false) {
  const name = pending ? (member.name || member.email || 'I') : memberDisplayName(member);
  const avatar = pending ? member.avatarUrl : (member.user?.avatarUrl || member.human?.avatarUrl || member.human?.avatar || '');
  if (avatar) return `<span class="member-avatar"><img src="${escapeHtml(avatar)}" alt="" /></span>`;
  return `<span class="member-avatar">${escapeHtml(String(name || 'M').trim().slice(0, 1).toUpperCase())}</span>`;
}

function buildMembersRows() {
  const cloud = appState.cloud || {};
  const activeMembers = (cloud.members || [])
    .filter((member) => (member.status || 'active') === 'active')
    .sort((a, b) => new Date(b.joinedAt || b.createdAt || 0) - new Date(a.joinedAt || a.createdAt || 0))
    .map((member) => ({ type: 'member', member, sortAt: member.joinedAt || member.createdAt || '' }));
  const pendingInvitations = (cloud.invitations || [])
    .filter((invitation) => !invitation.acceptedAt && !invitation.revokedAt)
    .filter((invitation) => !invitation.expiresAt || Date.parse(invitation.expiresAt) > Date.now())
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .map((invitation) => ({ type: 'invitation', invitation, sortAt: invitation.createdAt || '' }));
  return [...pendingInvitations, ...activeMembers];
}

function generatedLinkText(item) {
  return `Email: ${item.email}\nLink: ${item.link}`;
}

function generatedLinksText(items = cloudGeneratedLinks) {
  return items.map(generatedLinkText).join('\n\n');
}

function renderGeneratedLinksPanel() {
  if (!cloudGeneratedLinks.length) return '';
  return `
    <div class="pixel-panel cloud-card member-generated-links">
      <div class="panel-title">
        <span>Generated Links</span>
        <button class="secondary-btn compact-btn" type="button" data-action="copy-all-member-generated-links">Copy All</button>
      </div>
      <div class="member-link-list">
        ${cloudGeneratedLinks.map((item, index) => `
          <div class="member-link-row">
            <div>
              <span>Email:</span>
              <code>${escapeHtml(item.email)}</code>
              <span>Link:</span>
              <code>${escapeHtml(item.link)}</code>
            </div>
            <button class="secondary-btn compact-btn" type="button" data-action="copy-member-generated-link" data-index="${escapeHtml(index)}">Copy</button>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function renderMemberInviteForm() {
  const inviteRoleOptions = cloudInviteRoleOptions();
  if (!cloudCan('invite_member') || !inviteRoleOptions.length) return '';
  const count = memberInviteValidCount();
  return `
    <div class="pixel-panel cloud-card member-invite-card">
      <form id="member-invite-form" class="modal-form">
        <div class="panel-title"><span>Invite Members</span><span>${escapeHtml(count)} ready</span></div>
        <div class="member-invite-box" data-action="focus-member-invite-input">
          <div class="member-email-token-list">
            ${cloudInviteEmails.map((email) => `
              <span class="member-email-token">${escapeHtml(email)}<button type="button" data-action="remove-member-invite-email" data-email="${escapeHtml(email)}" aria-label="Remove ${escapeHtml(email)}">×</button></span>
            `).join('')}
            <textarea id="member-invite-input" name="emailsDraft" rows="3" placeholder="name@example.com">${escapeHtml(cloudInviteDraft)}</textarea>
          </div>
          <span id="member-invite-count" class="member-invite-count">${escapeHtml(count)}</span>
        </div>
        <label><span>Role</span><select name="role">
          ${inviteRoleOptions.map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join('')}
        </select></label>
        <button class="primary-btn" type="submit">Create Invitation</button>
      </form>
    </div>
  `;
}

function renderMemberRow(row) {
  const auth = appState.cloud?.auth || {};
  const currentMember = auth.currentMember;
  if (row.type === 'invitation') {
    const invitation = row.invitation;
    return `
      <div class="members-row pending" data-member-kind="invitation">
        <div class="members-person">
          ${memberAvatar(invitation, true)}
          <div><strong>${escapeHtml(invitation.name || invitation.email.split('@')[0])}</strong><small>${escapeHtml(invitation.email)}</small></div>
        </div>
        <span class="member-status-pill">邀请中</span>
        <span>${escapeHtml(cloudRoleLabel(invitation.role))}</span>
        <span>${escapeHtml(relativeMemberTime(invitation.createdAt))}</span>
        <div class="member-row-actions"></div>
      </div>
    `;
  }
  const member = row.member;
  const role = member.role || 'member';
  const isCurrent = currentMember?.id === member.id;
  const isAdminRow = role === 'admin';
  const canEditRole = cloudCan('manage_member_roles') && !isAdminRow && !isCurrent;
  const canResetPassword = auth.currentMember?.role === 'admin' && !isAdminRow && !isCurrent;
  return `
    <div class="members-row" data-member-kind="active">
      <div class="members-person">
        ${memberAvatar(member)}
        <div>
          <strong>${escapeHtml(memberDisplayName(member))}${isCurrent ? ' <span class="member-you">(you)</span>' : ''}</strong>
          <small>${escapeHtml(memberEmail(member))}</small>
        </div>
      </div>
      <span class="member-status-pill">active</span>
      <span>${escapeHtml(cloudRoleLabel(role))}</span>
      <span>${escapeHtml(relativeMemberTime(member.human?.lastSeenAt || member.human?.presenceUpdatedAt || member.user?.lastLoginAt || member.joinedAt || member.createdAt))}</span>
      <div class="member-row-actions">
        ${canEditRole ? `<select data-action="update-cloud-member-role" data-id="${escapeHtml(member.id)}" aria-label="Change member role">
          ${['core_member', 'member'].map((optionRole) => `<option value="${optionRole}" ${role === optionRole ? 'selected' : ''}>${escapeHtml(cloudRoleLabel(optionRole))}</option>`).join('')}
        </select>` : ''}
        ${canResetPassword ? `<button class="secondary-btn compact-btn" type="button" data-action="reset-cloud-member-password" data-id="${escapeHtml(member.id)}">Reset Password</button>` : ''}
        ${cloudCanRemoveMemberRole(role) && !isAdminRow && !isCurrent ? `<button class="danger-btn compact-btn" type="button" data-action="remove-cloud-member" data-id="${escapeHtml(member.id)}">Remove</button>` : ''}
      </div>
    </div>
  `;
}

function renderMembersSettingsTab() {
  const rows = buildMembersRows();
  const activeCount = (appState.cloud?.members || []).filter((member) => (member.status || 'active') === 'active').length;
  return `
    <section class="settings-layout members-settings-layout">
      <div class="members-summary-strip">
        <div><strong>${escapeHtml(activeCount)}</strong><span>members</span></div>
        <div><strong>${escapeHtml(rows.length - activeCount)}</strong><span>pending</span></div>
      </div>
      ${renderMemberInviteForm()}
      ${renderGeneratedLinksPanel()}
      <div class="pixel-panel cloud-card members-settings-list">
        <div class="panel-title"><span>Workspace Members</span><span>${escapeHtml(rows.length)} total</span></div>
        <div class="members-table-head">
          <span>Name</span>
          <span>Status</span>
          <span>Role</span>
          <span>Heartbeat</span>
          <span></span>
        </div>
        <div class="members-table-body">
          ${rows.map(renderMemberRow).join('') || '<div class="empty-box small">No members yet.</div>'}
        </div>
      </div>
    </section>
  `;
}

function renderCloudAuthGate(cloud = {}, errorMessage = '', tokenContext = {}) {
  const auth = cloud.auth || {};
  const loginError = String(errorMessage || '').trim();
  const loginErrorHtml = loginError
    ? `<div class="cloud-login-error" role="alert" aria-live="polite">${escapeHtml(loginError)}</div>`
    : '';
  const legalHtml = `
    <div class="cloud-auth-legal">
      <p>使用即代表您同意我们的 <a href="/terms" target="_blank" rel="noreferrer">使用协议</a> 和 <a href="/privacy" target="_blank" rel="noreferrer">隐私政策</a></p>
      <p>如果你还没有注册过账号，请联系你的管理员获取邀请。</p>
      <small>© 2026 MagClaw. All Rights Reserved.</small>
    </div>
  `;
  const tokenError = tokenContext.error || '';
  const tokenErrorHtml = tokenError
    ? `<div class="cloud-login-error" role="alert" aria-live="polite">${escapeHtml(tokenError)}</div>`
    : '';
  const invitation = tokenContext.invitation || {};
  const reset = tokenContext.reset || {};
  const avatarPreview = cloudAuthAvatar
    ? `<img src="${escapeHtml(cloudAuthAvatar)}" alt="" />`
    : escapeHtml(String(invitation.name || invitation.email || 'M').slice(0, 1).toUpperCase());
  const registerPanel = tokenContext.mode === 'invite' ? `
      <section class="pixel-panel cloud-login-card cloud-token-card" aria-labelledby="cloud-login-title">
        <div class="cloud-login-brand"><span class="cloud-login-logo" aria-hidden="true"><img src="${BRAND_LOGO_SRC}" alt="" /></span></div>
        <div class="cloud-login-heading">
          <p>MagClaw</p>
          <h1 id="cloud-login-title">Join workspace</h1>
          <span>Set up your MagClaw account from this invitation.</span>
        </div>
        ${tokenErrorHtml || `
        <form id="cloud-register-form" class="cloud-login-form">
          <input type="hidden" name="inviteToken" value="${escapeHtml(tokenContext.token || '')}" />
          <input type="hidden" name="email" value="${escapeHtml(invitation.email || '')}" />
          <input id="cloud-auth-avatar-input" type="hidden" name="avatar" value="${escapeHtml(cloudAuthAvatar)}" />
          <label class="cloud-login-field"><span>Email address</span><input type="email" value="${escapeHtml(invitation.email || '')}" disabled /></label>
          <label class="cloud-login-field"><span>Role</span><input value="${escapeHtml(cloudRoleLabel(invitation.role || 'member'))}" disabled /></label>
          <label class="cloud-login-field"><span>Display name</span><input name="name" autocomplete="name" placeholder="Display name" value="${escapeHtml(invitation.name || '')}" /></label>
          <div class="cloud-auth-avatar-row">
            <span class="cloud-auth-avatar-preview">${avatarPreview}</span>
            <button class="secondary-btn" type="button" data-action="random-cloud-auth-avatar">Random</button>
            <label class="secondary-btn profile-upload-btn">Upload<input id="cloud-auth-avatar-file" class="visually-hidden" type="file" accept="image/*" /></label>
          </div>
          <label class="cloud-login-field"><span>Password</span><input name="password" type="password" autocomplete="new-password" placeholder="Password" minlength="8" maxlength="30" required /></label>
          <label class="cloud-login-field"><span>Confirm password</span><input name="passwordConfirm" type="password" autocomplete="new-password" placeholder="Confirm password" minlength="8" maxlength="30" required /></label>
          <p class="cloud-password-rule">密码需要 8 到 30 位，并且必须同时包含字母和数字。</p>
          ${loginErrorHtml}
          <button class="primary-btn cloud-login-submit" type="submit">Set Account</button>
        </form>`}
      </section>
    ` : '';
  const resetPanel = tokenContext.mode === 'reset' ? `
      <section class="pixel-panel cloud-login-card cloud-token-card" aria-labelledby="cloud-login-title">
        <div class="cloud-login-brand"><span class="cloud-login-logo" aria-hidden="true"><img src="${BRAND_LOGO_SRC}" alt="" /></span></div>
        <div class="cloud-login-heading">
          <p>MagClaw</p>
          <h1 id="cloud-login-title">Reset password</h1>
          <span>Your password was reset by an administrator. Set a new password to continue.</span>
        </div>
        ${tokenErrorHtml || `
        <form id="cloud-reset-form" class="cloud-login-form">
          <input type="hidden" name="resetToken" value="${escapeHtml(tokenContext.token || '')}" />
          <label class="cloud-login-field"><span>Email address</span><input type="email" value="${escapeHtml(reset.email || '')}" disabled /></label>
          <label class="cloud-login-field"><span>New password</span><input name="password" type="password" autocomplete="new-password" placeholder="Password" minlength="8" maxlength="30" required /></label>
          <label class="cloud-login-field"><span>Confirm password</span><input name="passwordConfirm" type="password" autocomplete="new-password" placeholder="Confirm password" minlength="8" maxlength="30" required /></label>
          <p class="cloud-password-rule">密码需要 8 到 30 位，并且必须同时包含字母和数字。</p>
          ${loginErrorHtml}
          <button class="primary-btn cloud-login-submit" type="submit">Reset Password</button>
        </form>`}
      </section>
    ` : '';
  const loginPanel = auth.initialized ? `
      <section class="pixel-panel cloud-login-card" aria-labelledby="cloud-login-title">
        <div class="cloud-login-brand">
          <span class="cloud-login-logo" aria-hidden="true"><img src="${BRAND_LOGO_SRC}" alt="" /></span>
        </div>
        <div class="cloud-login-heading">
          <p>MagClaw</p>
          <h1 id="cloud-login-title">Welcome back!</h1>
          <span>Sign in to continue to your MagClaw workspace.</span>
        </div>
        <form id="cloud-login-form" class="cloud-login-form">
          <label class="cloud-login-field"><span>Email address</span><input name="email" type="email" autocomplete="email" placeholder="Email address" value="${escapeHtml(cloudLoginDraftEmail)}" required /></label>
          <label class="cloud-login-field"><span>Password</span><input name="password" type="password" autocomplete="current-password" placeholder="Password" required /></label>
          ${loginErrorHtml}
          <button class="primary-btn cloud-login-submit" type="submit">Log in</button>
        </form>
      </section>
    ` : `
      <section class="pixel-panel cloud-login-card" aria-labelledby="cloud-login-title">
        <div class="cloud-login-brand">
          <span class="cloud-login-logo" aria-hidden="true"><img src="${BRAND_LOGO_SRC}" alt="" /></span>
        </div>
        <div class="cloud-login-heading">
          <p>MagClaw</p>
          <h1 id="cloud-login-title">Sign in is not ready</h1>
          <span>The server needs a configured sign-in account before this workspace can be opened. Update the server environment and restart MagClaw.</span>
        </div>
      </section>
    `;
  const loginPanels = tokenContext.mode === 'invite'
    ? registerPanel
    : tokenContext.mode === 'reset'
      ? resetPanel
      : loginPanel;

  root.innerHTML = `
    <main class="cloud-auth-shell">
      <div class="cloud-auth-stage">
        ${loginPanels}
        ${legalHtml}
      </div>
    </main>
  `;
}

function renderBrowserSettingsTab() {
  return `
    <section class="settings-layout">
      ${renderNotificationConfigCard()}
      <div class="pixel-panel cloud-card">
        <div class="panel-title"><span>Browser Runtime</span><span>${escapeHtml(browserNotificationPermission())}</span></div>
        <div class="boundary-grid single">
          <div><strong>Background Replies</strong><p>Desktop notifications are browser-controlled and can be turned on or off here without changing agent routing.</p></div>
          <div><strong>Local UI State</strong><p>Collapsed sidebar sections, task boards, settings tabs, and skills panels are saved in browser local storage.</p></div>
        </div>
      </div>
    </section>
  `;
}

function renderServerSettingsTab() {
  const c = appState.connection || {};
  const isCloud = c.mode === 'cloud';
  return `
    <section class="cloud-layout">
      <div class="pixel-panel cloud-card">
        <div class="panel-title"><span>Mode</span><span>${escapeHtml(c.deployment || 'local')}</span></div>
        <div class="mode-cards">
          <button class="mode-card ${!isCloud ? 'active' : ''}" type="button" data-action="cloud-local">
            <strong>Local Only</strong>
            <span>State, attachments, Codex runs, tasks and threads stay on this machine.</span>
          </button>
          <button class="mode-card ${isCloud ? 'active' : ''}" type="button" data-action="cloud-configure">
            <strong>Cloud Connected</strong>
            <span>Use a MagClaw control plane URL for sync while local runner keeps executing Codex.</span>
          </button>
        </div>
        <div class="cloud-status">
          <div><span>Device</span><strong>${escapeHtml(c.deviceName || 'local')}</strong><small>${escapeHtml(c.deviceId || '')}</small></div>
          <div><span>Workspace</span><strong>${escapeHtml(c.workspaceId || 'local')}</strong><small>protocol v${escapeHtml(c.protocolVersion || 1)}</small></div>
          <div><span>Access</span><strong>${escapeHtml(c.hasCloudToken ? 'Token Set' : 'Open')}</strong><small>${escapeHtml(c.hasCloudToken ? 'server-side' : 'no token')}</small></div>
          <div><span>Last Sync</span><strong>${escapeHtml(c.lastSyncAt ? fmtTime(c.lastSyncAt) : '--')}</strong><small>${escapeHtml(c.lastSyncDirection || 'none')}</small></div>
        </div>
        ${c.lastError ? `<div class="cloud-error">${escapeHtml(c.lastError)}</div>` : ''}
      </div>

      <div class="pixel-panel cloud-card">
        <form id="cloud-config-form" class="modal-form">
          <div class="panel-title"><span>Control Plane</span><span>${escapeHtml(c.mode || 'local')}</span></div>
          <label><span>Mode</span><select name="mode"><option value="local" ${c.mode !== 'cloud' ? 'selected' : ''}>local</option><option value="cloud" ${c.mode === 'cloud' ? 'selected' : ''}>cloud</option></select></label>
          <label><span>Control Plane URL</span><input name="controlPlaneUrl" value="${escapeHtml(c.controlPlaneUrl || '')}" placeholder="https://app.magclaw.ai or http://127.0.0.1:6543" /></label>
          <label><span>Relay URL</span><input name="relayUrl" value="${escapeHtml(c.relayUrl || '')}" placeholder="wss://relay.magclaw.ai" /></label>
          <label><span>Access Token</span><input name="cloudToken" type="password" autocomplete="off" placeholder="${escapeHtml(c.hasCloudToken ? 'configured - leave blank to keep' : 'optional bearer token')}" /></label>
          <div class="form-grid">
            <label><span>Workspace ID</span><input name="workspaceId" value="${escapeHtml(c.workspaceId || 'local')}" /></label>
            <label><span>Device Name</span><input name="deviceName" value="${escapeHtml(c.deviceName || '')}" /></label>
          </div>
          <label class="checkline"><input type="checkbox" name="autoSync" ${c.autoSync ? 'checked' : ''} /> Auto push local changes to cloud</label>
          <button class="primary-btn" type="submit">Save Connection</button>
        </form>
        <div class="cloud-actions">
          <button class="secondary-btn" type="button" data-action="cloud-pair">Pair / Probe</button>
          <button class="secondary-btn" type="button" data-action="cloud-push">Push Local</button>
          <button class="secondary-btn" type="button" data-action="cloud-pull">Pull Cloud</button>
          <button class="danger-btn" type="button" data-action="cloud-disconnect">Local Only</button>
        </div>
      </div>

      <div class="pixel-panel cloud-card wide">
        <div class="panel-title"><span>Sync Boundary</span><span>v1</span></div>
        <div class="boundary-grid">
          <div><strong>Synced</strong><p>channels, DMs, messages, replies, tasks, agents, humans, computers, missions, run metadata and attachment metadata.</p></div>
          <div><strong>Local only</strong><p>Codex execution, filesystem access, attachment binaries, shell environment, secrets and process control.</p></div>
          <div><strong>Runtime</strong><p>Chat agents use isolated Codex homes, MagClaw MCP tools, and hidden warmup turns so visible replies can reuse an idle Codex session.</p></div>
        </div>
      </div>
    </section>
  `;
}

function renderSystemSettingsTab() {
  const config = appState.settings?.fanoutApi || {};
  const routerMode = config.configured ? 'llm_fanout' : 'rules_fallback';
  return `
    <section class="cloud-layout">
      ${renderFanoutApiConfigCard()}
      <div class="pixel-panel cloud-card">
        <div class="panel-title"><span>Routing Boundary</span><span>${escapeHtml(routerMode)}</span></div>
        <div class="cloud-status">
          <div><span>Fan-out API</span><strong>${escapeHtml(config.configured ? 'Configured' : 'Rules only')}</strong><small>${escapeHtml(config.model || 'no model')}</small></div>
          <div><span>Endpoint</span><strong>${escapeHtml(config.baseUrl || '--')}</strong><small>${escapeHtml(config.hasApiKey ? `key ${config.apiKeyPreview}` : 'no key stored')}</small></div>
          <div><span>Force Keywords</span><strong>${escapeHtml((config.forceKeywords || []).length)}</strong><small>${escapeHtml((config.forceKeywords || []).join(', ') || 'none')}</small></div>
          <div><span>Delivery</span><strong>Rules first</strong><small>LLM supplements queue only when routing is ambiguous or forced.</small></div>
        </div>
        <div class="boundary-grid single system-boundary-copy">
          <div><strong>Local rules stay immediate</strong><p>Messages still route by deterministic MagClaw rules before an optional LLM supplement is delivered.</p></div>
          <div><strong>Secrets stay server-side</strong><p>The browser only receives a masked API key preview; saved keys are never rendered back into the form.</p></div>
        </div>
      </div>
    </section>
  `;
}

function renderReleaseNotesSettingsTab() {
  const notes = [
    ['NEW', 'Agent skill and tool panels list MagClaw function calls, global Codex skills, plugin skills, and agent-local skills with collapsible sections.'],
    ['IMPROVED', 'Codex chat agents now warm their app-server session in the background, keeping everyday DM replies on the low-latency path after startup.'],
  ];
  return `
    <section class="settings-release">
      <article class="pixel-panel release-card">
        <h3>2026-05-04</h3>
        <div class="release-note-list">
          ${notes.map(([type, text]) => `
            <div class="release-note-row">
              <span class="release-badge release-${type.toLowerCase()}">${escapeHtml(type)}</span>
              <p>${escapeHtml(text)}</p>
            </div>
          `).join('')}
        </div>
      </article>
    </section>
  `;
}

function renderCloud() {
  const c = appState.connection || {};
  const isCloud = c.mode === 'cloud';
  const statusTone = c.pairingStatus === 'paired' ? 'green' : isCloud ? 'amber' : 'blue';
  const body = settingsTab === 'account'
    ? renderAccountSettingsTab()
    : settingsTab === 'browser'
      ? renderBrowserSettingsTab()
      : settingsTab === 'system'
        ? renderSystemSettingsTab()
        : settingsTab === 'members'
          ? renderMembersSettingsTab()
          : settingsTab === 'release'
            ? renderReleaseNotesSettingsTab()
            : renderServerSettingsTab();
  return renderSettingsChrome(body, `
    ${pill(c.mode || 'local', isCloud ? 'cyan' : 'blue')}
    ${pill(c.pairingStatus || 'local', statusTone)}
  `);
}

function renderInspector() {
  if (activeView === 'members') return '';
  if (workspaceActivityDrawerOpen) return renderWorkspaceActivityDrawer();

  const thread = threadMessageId ? byId(appState.messages, threadMessageId) : null;
  if (thread) return renderThreadDrawer(thread);

  if (selectedProjectFile) return renderProjectFilePreview();

  if (selectedAgentId) {
    const agent = byId(appState.agents, selectedAgentId);
    if (agent) return renderAgentDetail(agent);
  }

  if (selectedTaskId) {
    const task = byId(appState.tasks, selectedTaskId);
    if (task) return renderTaskDetail(task);
  }

  return '';
}

function renderProjectFilePreview() {
  const key = projectPreviewKey(selectedProjectFile.projectId, selectedProjectFile.path);
  const preview = projectFilePreviews[key] || { loading: true };
  const file = preview.file;
  return `
    <section class="pixel-panel inspector-panel file-preview-panel">
      <div class="panel-title file-preview-title">
        <span>File Preview</span>
        <button type="button" data-action="close-project-preview">×</button>
      </div>
      ${preview.loading ? '<div class="empty-box small">Loading file...</div>' : ''}
      ${preview.error ? `<div class="empty-box small error">${escapeHtml(preview.error)}</div>` : ''}
      ${file ? `
        <div class="file-preview-meta">
          <strong title="${escapeHtml(file.path)}">${escapeHtml(file.name)}</strong>
          <small>${escapeHtml(file.projectName)} / ${escapeHtml(file.path)} / ${bytes(file.bytes)}</small>
        </div>
        ${file.previewKind === 'markdown'
          ? `<div class="markdown-preview">${renderMarkdown(file.content || '')}</div>`
          : file.previewKind === 'text'
            ? `<pre class="text-file-preview"><code>${escapeHtml(file.content || '')}</code></pre>`
            : '<div class="empty-box small">This file type cannot be previewed as text yet.</div>'}
      ` : ''}
    </section>
  `;
}

function renderAgentWorkspaceTree(agent, relPath = '', depth = 0) {
  const key = agentWorkspaceKey(agent.id, relPath);
  const tree = agentWorkspaceTreeCache[key];
  if (!tree || tree.loading) return '<div class="project-tree-note">Loading workspace...</div>';
  if (tree.error) return `<div class="project-tree-note error">${escapeHtml(tree.error)}</div>`;
  if (!tree.entries?.length) return '<div class="project-tree-note">Empty folder.</div>';
  return `
    <div class="project-tree-list agent-workspace-tree">
      ${tree.entries.map((entry) => {
        const isFolder = entry.kind === 'folder';
        const expanded = isFolder && agentWorkspaceIsExpanded(agent.id, entry.path);
        const active = selectedAgentWorkspaceFile?.agentId === agent.id && selectedAgentWorkspaceFile?.path === entry.path;
        return `
          <div class="project-tree-node">
            <button
              type="button"
              class="project-tree-row ${isFolder ? 'is-folder' : 'is-file'} ${active ? 'active' : ''}"
              style="--depth: ${depth}"
              data-action="${isFolder ? 'toggle-agent-workspace' : 'open-agent-workspace-file'}"
              data-agent-id="${escapeHtml(agent.id)}"
              data-path="${escapeHtml(entry.path)}"
              title="${escapeHtml(entry.path)}"
            >
              <span class="project-tree-caret">${isFolder ? (expanded ? '▾' : '▸') : '·'}</span>
              <span class="project-tree-icon">${isFolder ? 'DIR' : 'FILE'}</span>
              <span class="project-tree-name">${escapeHtml(entry.name)}</span>
              ${!isFolder ? `<small>${bytes(entry.bytes || 0)}</small>` : ''}
            </button>
            ${isFolder && expanded ? renderAgentWorkspaceTree(agent, entry.path, depth + 1) : ''}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderAgentWorkspacePreview(agent) {
  if (!selectedAgentWorkspaceFile || selectedAgentWorkspaceFile.agentId !== agent.id) {
    return `
      <div class="agent-workspace-preview empty">
        <div class="empty-box small">Select a file to preview.</div>
      </div>
    `;
  }
  const key = agentWorkspaceKey(agent.id, selectedAgentWorkspaceFile.path);
  const preview = agentWorkspaceFilePreviews[key] || { loading: true };
  const file = preview.file;
  const mode = agentWorkspacePreviewMode === 'preview' ? 'preview' : 'raw';
  const showPreview = file?.previewKind === 'markdown' && agentWorkspacePreviewMode === 'preview';
  return `
    <div class="agent-workspace-preview">
      <div class="agent-workspace-filebar">
        <span>${file ? escapeHtml(file.path) : 'File Preview'}</span>
        <div class="agent-workspace-file-actions">
          ${file?.previewKind === 'markdown' ? `
            <button type="button" class="${mode === 'raw' ? 'active' : ''}" data-action="set-agent-workspace-preview-mode" data-mode="raw">Raw</button>
            <button type="button" class="${mode === 'preview' ? 'active' : ''}" data-action="set-agent-workspace-preview-mode" data-mode="preview">Preview</button>
          ` : ''}
          <button type="button" data-action="close-agent-workspace-file">×</button>
        </div>
      </div>
      ${preview.loading ? '<div class="empty-box small">Loading file...</div>' : ''}
      ${preview.error ? `<div class="empty-box small error">${escapeHtml(preview.error)}</div>` : ''}
      ${file ? `
        <div class="file-preview-meta">
          <strong title="${escapeHtml(file.absolutePath)}">${escapeHtml(file.name)}</strong>
          <small>${escapeHtml(file.absolutePath)} / ${bytes(file.bytes)}</small>
        </div>
        ${showPreview
          ? `<div class="markdown-preview">${renderMarkdown(file.content || '')}</div>`
          : file.previewKind === 'markdown' || file.previewKind === 'text'
            ? `<pre class="text-file-preview"><code>${escapeHtml(file.content || '')}</code></pre>`
            : '<div class="empty-box small">This file type cannot be previewed as text yet.</div>'}
      ` : ''}
    </div>
  `;
}

function renderAgentWorkspaceTab(agent) {
  const rootKey = agentWorkspaceKey(agent.id, '');
  const tree = agentWorkspaceTreeCache[rootKey];
  return `
    <div class="agent-workspace-tab">
      <div class="agent-workspace-path">
        <code>${escapeHtml(agent.workspacePath || agent.workspace || '--')}</code>
        <button type="button" data-action="refresh-agent-workspace" data-agent-id="${escapeHtml(agent.id)}">Refresh</button>
      </div>
      <div class="agent-workspace-layout">
        <aside class="agent-workspace-sidebar">
          <div class="agent-workspace-sidebar-title">
            <span>Workspace</span>
            <button type="button" data-action="refresh-agent-workspace" data-agent-id="${escapeHtml(agent.id)}">↻</button>
          </div>
          ${tree ? renderAgentWorkspaceTree(agent, '', 0) : '<div class="project-tree-note">Loading workspace...</div>'}
        </aside>
        <section class="agent-workspace-viewer">
          ${renderAgentWorkspacePreview(agent)}
        </section>
      </div>
    </div>
  `;
}

function runtimeForAgent(agent) {
  const runtime = String(agent?.runtime || '').toLowerCase();
  return installedRuntimes.find((rt) => (
    String(rt.id || '').toLowerCase() === runtime
    || String(rt.name || '').toLowerCase() === runtime
    || String(rt.name || '').toLowerCase().includes(runtime)
  )) || installedRuntimes.find((rt) => rt.installed) || null;
}

function agentModelOptions(agent) {
  const runtime = runtimeForAgent(agent);
  const modelNames = runtime?.modelNames || (runtime?.models || []).map((model) => ({ slug: model, name: model }));
  const current = agent?.model || runtime?.defaultModel || '';
  const options = [...modelNames];
  if (current && !options.some((model) => (typeof model === 'string' ? model : model.slug) === current)) {
    options.unshift({ slug: current, name: current });
  }
  return options.map((model) => {
    const slug = typeof model === 'string' ? model : model.slug;
    const name = typeof model === 'string' ? model : model.name;
    return `<option value="${escapeHtml(slug)}" ${slug === current ? 'selected' : ''}>${escapeHtml(name)}</option>`;
  }).join('');
}

function agentReasoningOptions(agent) {
  const runtime = runtimeForAgent(agent);
  const efforts = runtime?.reasoningEffort || [];
  const current = agent?.reasoningEffort || runtime?.defaultReasoningEffort || '';
  const options = current && !efforts.includes(current) ? [current, ...efforts] : efforts;
  return options.map((effort) => `<option value="${escapeHtml(effort)}" ${effort === current ? 'selected' : ''}>${escapeHtml(effort.charAt(0).toUpperCase() + effort.slice(1))}</option>`).join('');
}

function agentIsRunning(agent) {
  return ['starting', 'thinking', 'working', 'running', 'busy', 'queued'].includes(String(agent?.status || '').toLowerCase());
}

function agentStatusLabel(agent) {
  const status = agentDisplayStatus(agent);
  const value = String(status || 'offline').toLowerCase();
  if (value === 'warming') return 'Warming';
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function shouldCelebrateAgentBorn(value, today = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf()) || Number.isNaN(today.valueOf())) return false;
  return date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate()
    && date.getFullYear() !== today.getFullYear();
}

function formatAgentBorn(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '--';
  const formatted = date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  return `${shouldCelebrateAgentBorn(date) ? '🎂 ' : ''}${formatted}`;
}

function renderAgentDetailTabs() {
  const tabs = [
    ['profile', 'Profile'],
    ['skills', 'Skills'],
    ['dms', 'Agent DIRECT MESSAGES'],
    ['reminders', 'Reminders'],
    ['workspace', 'Workspace'],
    ['activity', 'Activity'],
  ];
  return `
    <div class="agent-detail-tabs" role="tablist">
      ${tabs.map(([id, label]) => `
        <button type="button" class="${agentDetailTab === id ? 'active' : ''}" data-action="set-agent-detail-tab" data-tab="${id}">${escapeHtml(label)}</button>
      `).join('')}
    </div>
  `;
}
