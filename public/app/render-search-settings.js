const searchTimeRangeOptions = [
  ['any', 'Any Time'],
  ['today', 'Today'],
  ['7d', 'Last 7 Days'],
  ['30d', 'Last 30 Days'],
];

const MAGCLAW_DAEMON_PACKAGE_VERSION = '0.1.3';
const MAGCLAW_WEB_PACKAGE_VERSION = '0.2.0';

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
        ${task ? renderTaskInlineBadge(task, { showAssignee: false, interactive: false }) : ''}
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
  if (typeof translatePage === 'function') translatePage(document.querySelector('.search-page') || document.body);
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
    ${renderHeader('Codex Missions', 'Runner history', '')}
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
  const computers = sortComputersByAvailability(appState.computers || []);
  const canManageComputers = cloudCan('manage_computers');
  const canManageAgents = cloudCan('manage_agents');
  void canManageComputers;
  void canManageAgents;
  const selected = (selectedComputerId ? byId(computers, selectedComputerId) : null) || computers[0] || null;
  return `
    <section class="computers-page">
      <header class="settings-page-header">
        <div class="settings-page-heading">
          <div class="settings-page-icon">${settingsIcon('computer', 24)}</div>
          <h2>Computers</h2>
        </div>
      </header>
      <div class="settings-section-label">
        ${settingsIcon('computer', 18)}
        <span>COMPUTERS</span>
      </div>
      ${selected ? renderComputerDetail(selected) : `
        <section class="computer-detail-page empty">
          <div class="pixel-panel cloud-card empty-box">No computers connected yet.</div>
        </section>
      `}
    </section>
  `;
}

function fmtFullDateTime(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '--';
  return date.toLocaleString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).replace(/\//g, '-');
}

function renderComputerIcon(computer = {}, size = 16) {
  return `<span class="computer-avatar ${computerIsDisabled(computer) ? 'disabled' : ''}" aria-hidden="true">${settingsIcon('computer', size)}</span>`;
}

function computerRuntimeDetails(computer = {}, options = {}) {
  const known = [
    { id: 'claude-code', name: 'Claude Code' },
    { id: 'codex', name: 'Codex CLI' },
    { id: 'kimi', name: 'Kimi CLI' },
    { id: 'copilot', name: 'Copilot CLI' },
    { id: 'cursor', name: 'Cursor CLI' },
    { id: 'gemini', name: 'Gemini CLI' },
    { id: 'opencode', name: 'OpenCode' },
  ];
  const merged = new Map(known.map((item) => [item.id, { ...item, installed: false, known: true }]));
  const explicit = Array.isArray(computer.runtimeDetails) && computer.runtimeDetails.length
    ? computer.runtimeDetails
    : (computer.runtimeIds || []).map((id) => ({ id, name: runtimeNameForId(id), installed: true }));
  for (const runtime of explicit) {
    const id = String(runtime.id || runtime.name || '').toLowerCase();
    if (!id) continue;
    const base = merged.get(id) || {};
    merged.set(id, {
      ...base,
      ...runtime,
      id: runtime.id || base.id || id,
      name: runtime.name || base.name || runtimeNameForId(id),
      installed: runtime.installed !== false,
    });
  }
  const hasDaemonDetails = Array.isArray(computer.runtimeDetails) && computer.runtimeDetails.length;
  const runtimeHost = String(appState.runtime?.host || '').toLowerCase().replace(/\.local$/, '');
  const computerNames = [computer.hostname, computer.localHostname, computer.name]
    .map((value) => String(value || '').toLowerCase().replace(/\.local$/, ''))
    .filter(Boolean);
  const matchesLocalRuntimeHost = runtimeHost && computerNames.some((value) => value === runtimeHost || runtimeHost.startsWith(`${value}-`) || value.startsWith(`${runtimeHost}-`));
  const includeLocalFallback = options.includeLocalFallback ?? (!hasDaemonDetails || computer.connectedVia !== 'daemon' || matchesLocalRuntimeHost);
  if (includeLocalFallback) {
    for (const runtime of installedRuntimes || []) {
      const id = String(runtime.id || runtime.name || '').toLowerCase();
      if (!id) continue;
      const base = merged.get(id) || {};
      merged.set(id, {
        ...base,
        ...runtime,
        id: runtime.id || base.id || id,
        name: runtime.name || base.name || runtimeNameForId(id),
        installed: runtime.installed !== false,
      });
    }
  }
  return [
    ...known.map((item) => merged.get(item.id)).filter(Boolean),
    ...[...merged.values()].filter((item) => !known.some((knownItem) => knownItem.id === item.id)),
  ];
}

function runtimeNameForId(id = '') {
  const value = String(id || '');
  const labels = {
    codex: 'Codex CLI',
    'claude-code': 'Claude Code',
    kimi: 'Kimi CLI',
    cursor: 'Cursor CLI',
    copilot: 'Copilot CLI',
    gemini: 'Gemini CLI',
    opencode: 'OpenCode',
  };
  return labels[value] || value || 'Runtime';
}

function computerAgents(computerId) {
  return (appState.agents || []).filter((agent) => agent && agent.computerId === computerId && !agentIsDeleted(agent));
}

function renderComputerRuntimeBadges(computer = {}, options = {}) {
  const details = computerRuntimeDetails(computer, options);
  if (!details.length) return '<span class="runtime-badge muted">No runtimes detected</span>';
  return details.map((runtime) => `
    <span class="runtime-badge ${runtime.installed === false ? 'muted' : ''}">
      ${escapeHtml(runtime.name || runtimeNameForId(runtime.id))}
      ${runtime.installed === false ? '<em>not installed</em>' : ''}
      ${runtime.version ? `<small>${escapeHtml(String(runtime.version).split(/\r?\n/)[0])}</small>` : ''}
    </span>
  `).join('');
}

function runtimeConfigurationLabel(agent = {}) {
  return [
    agent.runtime || runtimeNameForId(agent.runtimeId || ''),
    agent.model || '',
    agent.reasoningEffort ? `reasoning ${agent.reasoningEffort}` : '',
  ].filter(Boolean).join(' / ') || '--';
}

function displayDaemonVersion(...values) {
  const invalid = new Set(['', '--', 'daemon', 'local-dev', 'manual']);
  for (const value of values) {
    const text = String(value || '').trim();
    if (!invalid.has(text.toLowerCase())) return text;
  }
  return '--';
}

function daemonVersionParts(value = '') {
  const match = String(value || '').trim().match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/);
  if (!match) return null;
  return [Number(match[1] || 0), Number(match[2] || 0), Number(match[3] || 0)];
}

function compareDaemonVersions(current = '', latest = '') {
  const currentParts = daemonVersionParts(current);
  const latestParts = daemonVersionParts(latest);
  if (!currentParts || !latestParts) return 0;
  for (let index = 0; index < 3; index += 1) {
    if (currentParts[index] !== latestParts[index]) return currentParts[index] - latestParts[index];
  }
  return 0;
}

function daemonLatestVersion() {
  return displayDaemonVersion(
    appState.runtime?.daemonLatestVersion,
    appState.runtime?.daemonPackageVersion,
    MAGCLAW_DAEMON_PACKAGE_VERSION,
  );
}

function renderDaemonVersionValue(...values) {
  const version = displayDaemonVersion(...values);
  if (version === '--') return '<span class="daemon-version-value missing">--</span>';
  const latest = daemonLatestVersion();
  const label = version.startsWith('v') ? version : `v${version}`;
  const updateAvailable = latest !== '--' && compareDaemonVersions(version, latest) < 0;
  return `
    <span class="daemon-version-value ${updateAvailable ? 'update-available' : ''}">
      ${escapeHtml(label)}
      ${updateAvailable ? '<small>(update available)</small>' : ''}
    </span>
  `;
}

function renderComputerAgentCard(agent) {
  const creator = typeof agentCreatorInfo === 'function' ? agentCreatorInfo(agent) : { name: agent.creatorName || '--' };
  return `
    <button class="computer-agent-card" type="button" data-action="select-agent" data-id="${escapeHtml(agent.id)}">
      <span class="dm-avatar-wrap">
        ${getAvatarHtml(agent.id, 'agent', 'dm-avatar')}
      </span>
      <span class="computer-agent-main">
        <strong>${escapeHtml(agent.name || 'Agent')}</strong>
        <small>${escapeHtml(agent.description ? `${agent.description} · ${runtimeConfigurationLabel(agent)}` : runtimeConfigurationLabel(agent))}</small>
      </span>
      <span class="member-status-side">${avatarStatusDot(agentDisplayStatus(agent), 'Agent status')}</span>
      <span class="computer-agent-tooltip" role="tooltip">
        <span><b>Runtime Configuration</b>${escapeHtml(runtimeConfigurationLabel(agent))}</span>
        <span><b>Created</b>${escapeHtml(fmtFullDateTime(agent.createdAt))}</span>
        <span><b>Creator</b>${escapeHtml(creator.name || '--')}</span>
      </span>
    </button>
  `;
}

function renderComputerDetail(computer) {
  const agents = computerAgents(computer.id);
  const currentCommand = latestPairingCommand?.computer?.id === computer.id ? latestPairingCommand.command : '';
  const connected = computerIsConnected(computer);
  const disabled = computerIsDisabled(computer);
  const runtimeDetails = computerRuntimeDetails(computer);
  const installedCount = runtimeDetails.filter((runtime) => runtime.installed !== false).length;
  const daemonVersion = renderDaemonVersionValue(
    computer.daemonVersion,
    computer.version,
    appState.runtime?.daemonPackageVersion,
    MAGCLAW_DAEMON_PACKAGE_VERSION,
  );
  const statusLabel = disabled ? 'disabled' : connected ? 'connected' : 'offline';
  return `
    <section class="computer-detail-page magclaw-computer-detail">
      <div class="pixel-panel cloud-card wide computer-detail-card computer-profile-card">
        <div class="computer-detail-header">
          ${renderComputerIcon(computer, 24)}
          <div>
            <h2>${escapeHtml(computer.name || computer.hostname || 'Computer')}</h2>
            <p><span class="avatar-status-dot inline ${presenceClass(disabled ? 'disabled' : computer.status || 'offline')}"></span>${escapeHtml(statusLabel)}</p>
            <small>${escapeHtml(computer.hostname || computer.localHostname || '')}</small>
          </div>
        </div>
      </div>

      <details class="pixel-panel cloud-card wide computer-name-card">
        <summary>
          <span class="computer-section-label">Name <span class="computer-edit-icon">${settingsIcon('edit', 12)}</span></span>
          <strong>${escapeHtml(computer.name || computer.hostname || 'Computer')}</strong>
        </summary>
        <form id="computer-name-form" class="computer-name-line" data-computer-id="${escapeHtml(computer.id)}">
          <input name="name" value="${escapeHtml(computer.name || '')}" aria-label="Computer name" />
          <button class="secondary-btn compact-btn" type="submit">Save</button>
        </form>
      </details>

      <div class="pixel-panel cloud-card wide computer-info-card magclaw-info-card">
        <div class="computer-section-label">Info</div>
        <dl class="computer-info-list">
          <div class="computer-info-row"><dt>OS</dt><dd>${escapeHtml([computer.os, computer.arch].filter(Boolean).join(' ') || '--')}</dd></div>
          <div class="computer-info-row important"><dt>Daemon Version</dt><dd>${daemonVersion}</dd></div>
          <div class="computer-info-row runtime-row"><dt>Detected Runtimes</dt><dd><span class="runtime-count">${escapeHtml(installedCount)}</span><div class="detected-runtime-list">${renderComputerRuntimeBadges(computer)}</div></dd></div>
          <div class="computer-info-row"><dt>Created</dt><dd>${escapeHtml(fmtFullDateTime(computer.createdAt))}</dd></div>
        </dl>
      </div>

      ${connected || disabled ? '' : `
        <div class="pixel-panel cloud-card wide computer-connect-card">
          <div class="panel-title"><span>Connect Command</span><span>short lived</span></div>
          ${currentCommand ? `
            <div class="pair-command-box">
              <code>${escapeHtml(currentCommand)}</code>
              <button class="secondary-btn compact-btn" type="button" data-action="copy-pairing-command">Copy command</button>
            </div>
            <p class="muted-note">Keep this process running. It maintains the connection between your computer and MagClaw.</p>
          ` : '<div class="empty-box small">Generate a fresh one-time command when you need to reconnect this computer.</div>'}
          <button class="secondary-btn" type="button" data-action="regenerate-computer-command" data-id="${escapeHtml(computer.id)}">${currentCommand ? 'Regenerate command' : 'Connect'}</button>
        </div>
      `}

      <div class="pixel-panel cloud-card wide computer-agents-card">
        <div class="panel-title"><span>Agents on this computer (${agents.length})</span></div>
        ${agents.length ? `<div class="computer-agent-list">${agents.map((agent) => renderComputerAgentCard(agent)).join('')}</div>` : '<div class="empty-box small">No Agents are bound to this computer.</div>'}
        <div class="action-row">
          <button class="secondary-btn" type="button" data-action="start-all-computer-agents" data-id="${escapeHtml(computer.id)}" ${disabled ? 'disabled' : ''}>Start All</button>
          <button class="primary-btn" type="button" data-action="open-modal" data-modal="agent" ${disabled ? 'disabled' : ''}>+ Create</button>
        </div>
      </div>

      <div class="pixel-panel cloud-card wide danger-card computer-actions-card">
        <div class="panel-title"><span>Actions</span></div>
        <div class="danger-row">
          <div>
            <strong>${disabled ? 'Enable Computer' : 'Disable Computer'}</strong>
            <p>${disabled ? 'Allow this computer to reconnect and run Agents again.' : 'Stop this computer from reconnecting or receiving Agent work.'}</p>
          </div>
          <button class="${disabled ? 'secondary-btn' : 'danger-btn'}" type="button" data-action="${disabled ? 'enable-computer' : 'disable-computer'}" data-id="${escapeHtml(computer.id)}">${disabled ? 'Enable Computer' : 'Disable Computer'}</button>
        </div>
      </div>
    </section>
  `;
}

function renderComputerConfigCard() {
  const computers = appState.computers || [];
  const canManageComputers = cloudCan('manage_computers');
  const canPairComputers = cloudCan('pair_computers');
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
      ${canManageComputers ? '<button class="secondary-btn" type="button" data-action="open-modal" data-modal="computer">Add Computer</button>' : ''}
      ${canPairComputers ? '<button class="secondary-btn" type="button" data-action="create-computer-pairing">Pair Computer</button>' : ''}
    </div>
  `;
}

function renderFanoutApiConfigCard() {
  const config = appState.settings?.fanoutApi || {};
  const canManageFanout = cloudCan('manage_system');
  const disabled = canManageFanout ? '' : 'disabled';
  return `
    <div class="pixel-panel cloud-card fanout-config-card">
      <form id="fanout-config-form" class="modal-form">
        <div class="panel-title"><span>Fan-out API</span><span>${config.configured ? 'configured' : 'rules'}</span></div>
        <p class="fanout-api-note">Configure this server's supplemental LLM route for ambiguous fan-out decisions.</p>
        ${canManageFanout ? '' : '<div class="empty-box small">Only Owner and Admin members can modify this server configuration.</div>'}
        <label class="checkline"><input type="checkbox" name="enabled" ${config.enabled ? 'checked' : ''} ${disabled} /> Enable async LLM supplement for ambiguous routing</label>
        <label><span>Base URL</span><input name="baseUrl" value="${escapeHtml(config.baseUrl || '')}" placeholder="https://model-api.skyengine.com.cn/v1" ${disabled} /></label>
        <label><span>Model</span><input name="model" value="${escapeHtml(config.model || '')}" placeholder="qwen3.5-flash" ${disabled} /></label>
        <label><span>Fallback Model</span><input name="fallbackModel" value="${escapeHtml(config.fallbackModel || '')}" placeholder="deepseek-v4-flash" ${disabled} /></label>
        <label><span>Timeout</span><input name="timeoutMs" type="number" min="500" max="30000" step="500" value="${escapeHtml(config.timeoutMs || 5000)}" ${disabled} /></label>
        <label>
          <span>Force LLM Keywords</span>
          <textarea name="forceKeywords" rows="3" placeholder="" ${disabled}>${escapeHtml((config.forceKeywords || []).join('\n'))}</textarea>
          <small>Optional. Matching messages still route by rules first, then queue an LLM supplement.</small>
        </label>
        <label>
          <span>API Key</span>
          <input name="apiKey" type="password" autocomplete="off" placeholder="${escapeHtml(config.hasApiKey ? `${config.apiKeyPreview} configured - leave blank to keep` : 'paste API key')}" ${disabled} />
          <small>${escapeHtml(config.hasApiKey ? `Stored key preview: ${config.apiKeyPreview}` : 'No key stored yet.')}</small>
        </label>
        ${config.hasApiKey ? `<label class="checkline"><input type="checkbox" name="clearApiKey" ${disabled} /> Clear saved API key</label>` : ''}
        <button class="primary-btn" type="submit" ${disabled}>Save Fan-out API</button>
      </form>
    </div>
  `;
}

function settingsPageMeta(tab = settingsTab) {
  const metas = {
    account: { title: 'Account', icon: 'account', section: 'ACCOUNT' },
    browser: { title: 'Browser', icon: 'browser', section: 'BROWSER' },
    server: { title: 'Server', icon: 'server', section: 'SERVER' },
    members: { title: 'Members', icon: 'members', section: 'MEMBERS' },
    'lost-space': { title: 'Lost Space', icon: 'lost', section: 'LOST SPACE' },
    language: { title: 'Language', icon: 'language', section: 'LANGUAGE' },
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
  const cloud = appState.cloud || {};
  const auth = cloud.auth || {};
  const currentUser = auth.currentUser;
  const human = currentAccountHuman();
  const profileValues = profileFormValuesForRender(human, currentUser);
  const authPanel = !auth.initialized ? `
      <div class="pixel-panel cloud-card">
        <div class="panel-title"><span>Sign-in Account</span><span>server config</span></div>
        <div class="empty-box small">The initial sign-in account is configured on the server. Restart MagClaw after updating the server environment.</div>
      </div>
    ` : '';
    return `
      <section class="settings-layout account-layout account-waterfall">
        <div class="pixel-panel cloud-card account-overview-card account-magclaw-card">
          <span class="settings-account-avatar account-avatar-lg">${profileAvatarInnerHtml({ human, avatar: profileValues.avatar, displayName: profileValues.displayName, cssClass: 'settings-account-avatar-inner' })}</span>
          <div class="account-profile-main">
            <div>
              <p class="eyebrow">Account</p>
              <h3>${escapeHtml(profileValues.displayName || currentUser?.name || 'You')}</h3>
              <p>${escapeHtml(human.email || currentUser?.email || 'MagClaw user')}</p>
            </div>
          </div>
          ${currentUser ? `<button class="secondary-btn account-signout-btn" type="button" data-action="open-modal" data-modal="confirm-sign-out">Sign Out</button>` : ''}
        </div>
        ${currentUser ? `
          <form id="profile-form" class="pixel-panel cloud-card modal-form account-profile-form account-magclaw-card" data-human-id="${escapeHtml(human.id || '')}">
            <div class="panel-title"><span>Profile</span><span>${escapeHtml(currentUser.id || human.authUserId || '')}</span></div>
            <div class="profile-avatar-row">
              <span class="settings-account-avatar">${profileAvatarInnerHtml({ human, avatar: profileValues.avatar, displayName: profileValues.displayName, cssClass: 'settings-account-avatar-inner' })}</span>
              <input id="profile-avatar-input" type="hidden" name="avatar" value="${escapeHtml(profileValues.avatar || '')}" />
              <div class="account-avatar-actions">
                <button class="secondary-btn" type="button" data-action="random-profile-avatar">Random</button>
                <button class="secondary-btn" type="button" data-action="pick-profile-avatar">Browse</button>
                <label class="secondary-btn profile-upload-btn">Upload<input id="profile-avatar-file" class="visually-hidden" type="file" accept="image/*" data-avatar-upload-target="profile" /></label>
                <button class="secondary-btn" type="button" data-action="reset-profile-avatar">Reset to Default</button>
              </div>
            </div>
            <label><span>Name</span><input name="displayName" value="${escapeHtml(profileValues.displayName || '')}" /></label>
            <label><span>Email</span><input value="${escapeHtml(human.email || currentUser?.email || '')}" disabled /></label>
            <label><span>Description</span><textarea name="description" rows="3">${escapeHtml(profileValues.description || '')}</textarea></label>
            <button class="primary-btn" type="submit">Save</button>
          </form>
          <div class="pixel-panel cloud-card account-magclaw-card account-session-card">
            <div class="panel-title"><span>Session</span><span>active</span></div>
            <p>Sign out of this browser. Your account and server memberships remain unchanged.</p>
            <button class="secondary-btn" type="button" data-action="open-modal" data-modal="confirm-sign-out">Log out</button>
          </div>
        ` : ''}
        ${authPanel}
    </section>
  `;
}

function normalizeInviteEmailValue(value) {
  return String(value || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim().toLowerCase();
}

function splitInviteEmailValues(value) {
  return String(value || '')
    .split(/[\s,;，；]+/)
    .map(normalizeInviteEmailValue)
    .filter(Boolean);
}

function validInviteEmailsFromValue(value) {
  const seen = new Set();
  return splitInviteEmailValues(value)
    .filter((email) => {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || seen.has(email)) return false;
      seen.add(email);
      return true;
    });
}

function invalidInviteEmailsFromValue(value) {
  return splitInviteEmailValues(value).filter((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
}

function dedupeInviteEmails(emails = []) {
  const seen = new Set();
  const result = [];
  for (const item of emails) {
    const email = normalizeInviteEmailValue(item);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || seen.has(email)) continue;
    seen.add(email);
    result.push(email);
  }
  return result;
}

function memberInviteEmailsForSubmit() {
  return dedupeInviteEmails([...cloudInviteEmails, ...validInviteEmailsFromValue(cloudInviteDraft)]);
}

function memberInviteInvalidEmailsForSubmit() {
  return dedupeInviteEmails(cloudInviteEmails.filter((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeInviteEmailValue(email))))
    .concat(invalidInviteEmailsFromValue(cloudInviteDraft));
}

function memberInviteValidCount() {
  return memberInviteEmailsForSubmit().length;
}

function sanitizeMemberInviteTokens() {
  const next = dedupeInviteEmails(cloudInviteEmails);
  const changed = next.length !== cloudInviteEmails.length || next.some((email, index) => email !== cloudInviteEmails[index]);
  cloudInviteEmails = next;
  return changed;
}

function commitMemberInviteDraft(value = cloudInviteDraft) {
  const invalidEmails = invalidInviteEmailsFromValue(value);
  if (invalidEmails.length) {
    cloudInviteDraft = value;
    return false;
  }
  const emails = validInviteEmailsFromValue(value);
  sanitizeMemberInviteTokens();
  if (!emails.length) {
    cloudInviteDraft = value;
    return false;
  }
  cloudInviteEmails = dedupeInviteEmails([...cloudInviteEmails, ...emails]);
  cloudInviteDraft = '';
  return true;
}

const MEMBERS_PAGE_SIZE = 50;

function relativeMemberTime(value) {
  const timestamp = Date.parse(value || '');
  if (!timestamp) return '--';
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} mo ago`;
  const years = Math.floor(months / 12);
  return `${years} yr${years === 1 ? '' : 's'} ago`;
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

function memberDirectorySortTimestamp(value) {
  const timestamp = Date.parse(value || '');
  return Number.isFinite(timestamp) ? timestamp : Number.MAX_SAFE_INTEGER;
}

function compareMemberDirectorySortParts(a, b) {
  const timeDiff = memberDirectorySortTimestamp(a?.invitedAt) - memberDirectorySortTimestamp(b?.invitedAt);
  if (timeDiff) return timeDiff;
  return String(a?.id || '').localeCompare(String(b?.id || ''));
}

function acceptedInvitationForMember(member, invitations = appState.cloud?.invitations || []) {
  const email = normalizeInviteEmailValue(memberEmail(member));
  const userId = String(member?.user?.id || member?.userId || '').trim();
  const accepted = invitations
    .filter((invitation) => {
      if (!invitation?.acceptedAt) return false;
      if (userId && invitation.acceptedBy === userId) return true;
      return email && normalizeInviteEmailValue(invitation.email) === email;
    })
    .sort((a, b) => compareMemberDirectorySortParts(
      { invitedAt: a.createdAt, id: a.id },
      { invitedAt: b.createdAt, id: b.id },
    ));
  return accepted[0] || null;
}

function memberDirectorySortParts(row) {
  if (row?.type === 'invitation') {
    return {
      group: 1,
      invitedAt: row.invitation?.createdAt,
      id: row.invitation?.id || row.invitation?.email || '',
    };
  }
  return {
    group: 0,
    invitedAt: row?.invitation?.createdAt || row?.member?.createdAt || row?.member?.joinedAt,
    id: row?.invitation?.id || row?.member?.id || row?.member?.userId || memberEmail(row?.member),
  };
}

function compareMemberDirectoryRows(a, b) {
  const left = memberDirectorySortParts(a);
  const right = memberDirectorySortParts(b);
  const groupDiff = left.group - right.group;
  if (groupDiff) return groupDiff;
  return compareMemberDirectorySortParts(left, right);
}

function memberLastActivityAt(member) {
  return member?.human?.lastSeenAt
    || member?.human?.presenceUpdatedAt
    || member?.user?.lastLoginAt
    || member?.joinedAt
    || member?.createdAt;
}

function memberStatusLabel(member) {
  const status = String(member?.status || 'active').toLowerCase();
  if (status === 'active') return 'Active';
  if (status === 'invited' || status === 'pending') return 'Pending';
  return status || 'unknown';
}

function buildMembersRows() {
  const cloud = appState.cloud || {};
  const invitations = cloud.invitations || [];
  const activeEmails = new Set((cloud.members || [])
    .filter((member) => (member.status || 'active') === 'active')
    .map(memberEmail)
    .map(normalizeInviteEmailValue)
    .filter(Boolean));
  const activeMembers = (cloud.members || [])
    .filter((member) => (member.status || 'active') === 'active')
    .map((member) => {
      const invitation = acceptedInvitationForMember(member, invitations);
      return {
        type: 'member',
        member,
        invitation,
        sortAt: invitation?.createdAt || member.createdAt || member.joinedAt || '',
      };
    });
  const pendingInvitations = invitations
    .filter((invitation) => !invitation.acceptedAt && !invitation.revokedAt)
    .filter((invitation) => !invitation.expiresAt || Date.parse(invitation.expiresAt) > Date.now())
    .filter((invitation) => !activeEmails.has(normalizeInviteEmailValue(invitation.email)))
    .map((invitation) => ({
      type: 'invitation',
      invitation,
      sortAt: invitation.createdAt || '',
    }));
  return [...activeMembers, ...pendingInvitations].sort(compareMemberDirectoryRows);
}

function clampMembersPage(page, totalPages) {
  const value = Number.parseInt(page, 10);
  if (!Number.isFinite(value)) return 1;
  return Math.min(Math.max(value, 1), Math.max(totalPages, 1));
}

function membersPaginationModel(rows = buildMembersRows()) {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / MEMBERS_PAGE_SIZE));
  const page = clampMembersPage(memberDirectoryPage, totalPages);
  memberDirectoryPage = page;
  const start = (page - 1) * MEMBERS_PAGE_SIZE;
  return {
    total,
    totalPages,
    page,
    rows: rows.slice(start, start + MEMBERS_PAGE_SIZE),
  };
}

function isLoopbackInviteHostname(hostname) {
  const value = String(hostname || '').toLowerCase();
  return value === 'localhost'
    || value === '[::1]'
    || value === '::1'
    || value === '0.0.0.0'
    || value === '127.0.0.1'
    || value.startsWith('127.');
}

function inviteLinkForCurrentOrigin(link) {
  const raw = String(link || '').trim();
  if (!raw) return '';
  const currentOrigin = typeof window !== 'undefined' ? window.location?.origin : '';
  if (!currentOrigin) return raw;
  try {
    const url = new URL(raw, currentOrigin);
    const current = new URL(currentOrigin);
    if (url.pathname === '/activate' && isLoopbackInviteHostname(url.hostname) && !isLoopbackInviteHostname(current.hostname)) {
      url.protocol = current.protocol;
      url.hostname = current.hostname;
      url.port = current.port;
    }
    return url.toString();
  } catch {
    return raw;
  }
}

function generatedLinkText(item) {
  return `Email: ${item.email}\nLink: ${inviteLinkForCurrentOrigin(item.link)}`;
}

function generatedLinksText(items = cloudGeneratedLinks) {
  return items.map(generatedLinkText).join('\n\n');
}

function renderMemberInviteLinksModal() {
  if (!cloudGeneratedLinks.length) return '';
  return `
    ${modalHeader('Invitation links', 'Copy each link and send it to the matching member.')}
    <div class="member-invite-links-modal">
      <div class="member-invite-links-list">
        ${cloudGeneratedLinks.map((item, index) => `
          <div class="member-link-row">
            <div>
              <span>Email:</span>
              <code>${escapeHtml(item.email)}</code>
              <span>Link:</span>
              <code>${escapeHtml(inviteLinkForCurrentOrigin(item.link))}</code>
            </div>
            <button class="secondary-btn compact-btn" type="button" data-action="copy-member-generated-link" data-index="${escapeHtml(index)}">Copy</button>
          </div>
        `).join('')}
      </div>
      <button class="primary-btn" type="button" data-action="copy-all-member-generated-links">Copy All</button>
    </div>
  `;
}

function renderMemberInviteModal() {
  const inviteRoleOptions = cloudInviteRoleOptions();
  if (!cloudCan('invite_member') || !inviteRoleOptions.length) return '';
  const count = memberInviteValidCount();
  return `
    ${modalHeader('Invite members', 'They can access your workspace after signing in.')}
    <div class="member-invite-card">
      <form id="member-invite-form" class="modal-form">
        <label class="member-invite-label"><span>Email</span></label>
        <div class="member-invite-box" data-action="focus-member-invite-input">
          <div class="member-email-token-list">
            ${cloudInviteEmails.map((email) => `
              <span class="member-email-token">${escapeHtml(email)}<button type="button" data-action="remove-member-invite-email" data-email="${escapeHtml(email)}" aria-label="Remove ${escapeHtml(email)}">×</button></span>
            `).join('')}
            <textarea id="member-invite-input" name="emailsDraft" rows="3" placeholder="name@example.com">${escapeHtml(cloudInviteDraft)}</textarea>
          </div>
        </div>
        <div class="member-invite-count-row"><span id="member-invite-count" class="member-invite-count">${escapeHtml(count)}/unlimited</span></div>
        <label class="member-invite-role"><span>Role</span><select name="role">
          ${inviteRoleOptions.map(([value, label]) => `<option value="${escapeHtml(value)}">${escapeHtml(label)}</option>`).join('')}
        </select></label>
        <button class="primary-btn member-invite-submit" type="submit" ${count ? '' : 'disabled'}>Send invites</button>
      </form>
    </div>
  `;
}

function memberManageTarget() {
  const id = memberManageState?.memberId || '';
  if (!id) return null;
  return (appState.cloud?.members || []).find((member) => member.id === id) || null;
}

function memberActionConfirmTarget() {
  const id = memberActionConfirmState?.memberId || '';
  if (!id) return null;
  return (appState.cloud?.members || []).find((member) => member.id === id) || null;
}

function memberResetLinkText() {
  return `Email: ${memberResetLinkState.email}\nLink: ${memberResetLinkState.link}`;
}

function renderMemberManageModal() {
  const auth = appState.cloud?.auth || {};
  const member = memberManageTarget();
  if (!member) return modalHeader('Manage member', 'Member not found');
  const role = member.role || 'member';
  const displayRole = cloudMemberDisplayRole(member);
  const isAdminRow = role === 'admin';
  const isOwnerRow = displayRole === 'owner';
  const isCurrent = auth.currentMember?.id === member.id;
  const roleOptions = cloudMemberManageRoleOptions();
  const canManageRole = Boolean(roleOptions.length) && !isOwnerRow && !isCurrent;
  const canResetPassword = auth.currentMember?.role === 'admin' && !isAdminRow && !isCurrent;
  const canRemove = cloudCanRemoveMemberRole(role) && !isAdminRow && !isCurrent;
  return `
    ${modalHeader('Manage member', 'Account operations')}
    <div class="member-manage-modal">
      <div class="member-manage-summary">
        ${memberAvatar(member)}
        <div>
          <strong>${escapeHtml(memberDisplayName(member))}</strong>
          <span>${escapeHtml(memberEmail(member))}</span>
        </div>
        <em>${escapeHtml(cloudRoleLabel(role))}</em>
      </div>
      ${canManageRole ? `
        <form class="member-manage-role-form" data-current-role="${escapeHtml(role)}" data-id="${escapeHtml(member.id)}">
          <label for="member-manage-role-select">
            <span>Role</span>
            <small>Change this member's workspace access level.</small>
          </label>
          <div class="member-manage-role-controls">
            <select id="member-manage-role-select" name="role" data-member-role-select>
              ${roleOptions.map(([value, label]) => `<option value="${escapeHtml(value)}" ${value === role ? 'selected' : ''}>${escapeHtml(label)}</option>`).join('')}
            </select>
            <button class="secondary-btn compact-btn" type="button" data-action="update-cloud-member-role" data-id="${escapeHtml(member.id)}">Save Role</button>
          </div>
        </form>
      ` : ''}
      ${(canResetPassword || canRemove || (!canManageRole && !canResetPassword && !canRemove)) ? `
        <div class="member-manage-actions">
          ${canResetPassword ? `
            <button class="member-manage-action" type="button" data-action="open-member-action-confirm" data-member-action="reset-password" data-id="${escapeHtml(member.id)}">
              <strong>Reset Password</strong>
              <span>Create a one-time password reset link for this member.</span>
            </button>
          ` : ''}
          ${canRemove ? `
            <button class="member-manage-action danger" type="button" data-action="open-member-action-confirm" data-member-action="remove" data-id="${escapeHtml(member.id)}">
              <strong>Remove</strong>
              <span>Remove workspace access for this member.</span>
            </button>
          ` : ''}
          ${(!canManageRole && !canResetPassword && !canRemove) ? '<div class="empty-box small">No available operations for this member.</div>' : ''}
        </div>
      ` : ''}
    </div>
  `;
}

function renderMemberActionConfirmModal() {
  const member = memberActionConfirmTarget();
  const action = memberActionConfirmState?.action || '';
  if (!member || !action) return modalHeader('Confirm operation', 'Member not found');
  const isRemove = action === 'remove';
  const title = isRemove ? 'Remove member' : 'Reset password';
  const description = isRemove
    ? 'This member will lose access to the workspace immediately.'
    : 'A one-time password reset link will be created for this member.';
  const confirmLabel = isRemove ? 'Remove' : 'Create Reset Link';
  return `
    ${modalHeader(title, 'Confirm member operation')}
    <div class="member-action-confirm-modal">
      <div class="member-manage-summary">
        ${memberAvatar(member)}
        <div>
          <strong>${escapeHtml(memberDisplayName(member))}</strong>
          <span>${escapeHtml(memberEmail(member))}</span>
        </div>
        <em>${escapeHtml(cloudRoleLabel(member.role || 'member'))}</em>
      </div>
      <p>${escapeHtml(description)}</p>
    </div>
    <div class="modal-actions member-action-confirm-actions">
      <button type="button" class="secondary-btn" data-action="close-modal">Cancel</button>
      <button type="button" class="${isRemove ? 'danger-btn' : 'primary-btn'}" data-action="confirm-member-action">${escapeHtml(confirmLabel)}</button>
    </div>
  `;
}

function renderMemberResetLinkModal() {
  const email = memberResetLinkState.email || '';
  const link = memberResetLinkState.link || '';
  return `
    ${modalHeader('Password reset link', 'Copy and send this link to the member.')}
    <div class="member-reset-link-modal">
      <div class="member-link-row member-reset-link-row">
        <div>
          <span>Email:</span>
          <code>${escapeHtml(email || '--')}</code>
          <span>Link:</span>
          <code>${escapeHtml(link || '--')}</code>
        </div>
        <button class="secondary-btn compact-btn" type="button" data-action="copy-member-reset-link" ${link ? '' : 'disabled'}>Copy</button>
      </div>
    </div>
  `;
}

function renderMemberRow(row) {
  const auth = appState.cloud?.auth || {};
  const currentMember = auth.currentMember;
  if (row.type === 'invitation') {
    const invitation = row.invitation;
    return `
      <div class="members-row" data-member-kind="pending">
        <div class="members-person">
          ${memberAvatar(invitation, true)}
          <div>
            <strong>${escapeHtml(invitation.name || invitation.email || 'Pending member')}</strong>
            <small>${escapeHtml(invitation.email || '')}</small>
          </div>
        </div>
        <span class="member-status-pill is-pending">Pending</span>
        <span>--</span>
        <div class="member-role-cell"><span class="member-role-badge">${escapeHtml(cloudRoleLabel(invitation.role || 'member'))}</span></div>
        <div class="member-manage-cell"><span class="members-empty-action">--</span></div>
      </div>
    `;
  }
  const member = row.member;
  const role = member.role || 'member';
  const isCurrent = currentMember?.id === member.id;
  const displayRole = cloudMemberDisplayRole(member);
  const isAdminRow = role === 'admin';
  const isOwnerRow = displayRole === 'owner';
  const canManageRole = cloudCan('manage_member_roles') && !isOwnerRow && !isCurrent;
  const canResetPassword = auth.currentMember?.role === 'admin' && !isAdminRow && !isCurrent;
  const canRemove = cloudCanRemoveMemberRole(role) && !isAdminRow && !isCurrent;
  const canManage = canManageRole || canResetPassword || canRemove;
  return `
    <div class="members-row" data-member-kind="active">
      <div class="members-person">
        ${memberAvatar(member)}
        <div>
          <strong>${escapeHtml(memberDisplayName(member))}${isCurrent ? ' <span class="member-you">(you)</span>' : ''}</strong>
          <small>${escapeHtml(memberEmail(member))}</small>
        </div>
      </div>
      <span class="member-status-pill is-active">${escapeHtml(memberStatusLabel(member))}</span>
      <span>${escapeHtml(relativeMemberTime(memberLastActivityAt(member)))}</span>
      <div class="member-role-cell">
        <span class="member-role-badge">${escapeHtml(cloudRoleLabel(role))}</span>
      </div>
      <div class="member-manage-cell">
        ${canManage ? `<button class="secondary-btn compact-btn member-manage-btn" type="button" data-action="open-member-manage" data-id="${escapeHtml(member.id)}">Manage</button>` : '<span class="members-empty-action">--</span>'}
      </div>
    </div>
  `;
}

function renderMemberInviteTrigger() {
  if (!cloudCan('invite_member') || !cloudInviteRoleOptions().length) return '';
  return `<button class="primary-btn member-directory-invite-btn" type="button" data-action="open-modal" data-modal="member-invite">Invite</button>`;
}

function renderMembersDirectory({ context = 'main' } = {}) {
  const model = membersPaginationModel();
  return `
    <section class="members-page members-directory-shell members-directory-${escapeHtml(context)}">
      <header class="members-page-header">
        <h2>Members</h2>
        ${renderMemberInviteTrigger()}
      </header>
      <div class="members-table-card">
        <div class="members-table-head">
          <span>Name</span>
          <span>Status</span>
          <span>Last active</span>
          <span>Role</span>
          <span>Manage</span>
        </div>
        <div class="members-table-body">
          ${model.rows.map(renderMemberRow).join('') || '<div class="empty-box small">No members yet.</div>'}
        </div>
        ${renderMembersPagination(model)}
      </div>
    </section>
  `;
}

function renderMembersPagination(model) {
  if (!model || model.totalPages <= 1) {
    return `<div class="members-pagination"><span>${escapeHtml(model?.total || 0)} total</span><span>Page 1 of 1</span></div>`;
  }
  return `
    <div class="members-pagination" aria-label="Members pagination">
      <span>${escapeHtml(model.total)} total</span>
      <button class="secondary-btn compact-btn" type="button" data-action="members-page-prev" data-page="${escapeHtml(model.page - 1)}" ${model.page <= 1 ? 'disabled' : ''}>Previous</button>
      <label>Page
        <input id="members-page-input" type="number" min="1" max="${escapeHtml(model.totalPages)}" value="${escapeHtml(model.page)}" inputmode="numeric" />
      </label>
      <span>of ${escapeHtml(model.totalPages)}</span>
      <button class="secondary-btn compact-btn" type="button" data-action="members-page-go">Go</button>
      <button class="secondary-btn compact-btn" type="button" data-action="members-page-next" data-page="${escapeHtml(model.page + 1)}" ${model.page >= model.totalPages ? 'disabled' : ''}>Next</button>
    </div>
  `;
}

function renderMembersSettingsTab() {
  return renderMembersDirectory({ context: 'settings' });
}

function renderCloudAuthGate(cloud = {}, errorMessage = '', tokenContext = {}) {
  const auth = cloud.auth || {};
  const loginError = String(errorMessage || '').trim();
  const loginErrorHtml = loginError
    ? `<div class="cloud-login-error" role="alert" aria-live="polite">${escapeHtml(loginError)}</div>`
    : '';
  const legalHtml = `
    <div class="cloud-auth-legal">
      <p>By using MagClaw, you agree to our <a href="/terms">Terms of Use</a> and <a href="/privacy">Privacy Policy</a></p>
      <small>© 2026 MagClaw. All Rights Reserved.</small>
    </div>
  `;
  const tokenError = tokenContext.error || '';
  const tokenErrorHtml = tokenError
    ? `<div class="cloud-login-error" role="alert" aria-live="polite">${escapeHtml(tokenError)}</div>`
    : '';
  const invitation = tokenContext.invitation || {};
  const reset = tokenContext.reset || {};
  const joinWorkspace = tokenContext.joinWorkspace || {};
  const brandHtml = `<div class="cloud-login-brand"><span class="cloud-login-logo" aria-hidden="true"><img src="${BRAND_LOGO_SRC}" alt="" /></span></div>`;
  const registerPanel = tokenContext.mode === 'invite' ? `
      <section class="pixel-panel cloud-login-card cloud-token-card" aria-labelledby="cloud-login-title">
        ${brandHtml}
        <div class="cloud-login-heading">
          <p>MagClaw</p>
          <h1 id="cloud-login-title">Join workspace</h1>
          <span>Set up your MagClaw account from this invitation.</span>
        </div>
        ${tokenErrorHtml || `
        <form id="cloud-register-form" class="cloud-login-form" novalidate>
          <input type="hidden" name="inviteToken" value="${escapeHtml(tokenContext.token || '')}" />
          <label class="cloud-login-field"><span>Email address</span><input type="email" value="${escapeHtml(invitation.email || '')}" disabled /></label>
          <label class="cloud-login-field"><span>Role</span><input value="${escapeHtml(cloudRoleLabel(invitation.role || 'member'))}" disabled /></label>
          <label class="cloud-login-field"><span>Display name</span><input name="name" autocomplete="name" placeholder="Display name" value="${escapeHtml(invitation.name || '')}" /></label>
          <label class="cloud-login-field"><span>Password</span><input name="password" type="password" autocomplete="new-password" placeholder="Password" required /></label>
          <label class="cloud-login-field"><span>Confirm password</span><input name="passwordConfirm" type="password" autocomplete="new-password" placeholder="Confirm password" required /></label>
          <p class="cloud-password-rule">Password must be 8-30 characters and include letters and numbers.</p>
          ${loginErrorHtml}
          <button class="primary-btn cloud-login-submit" type="submit">Set Account</button>
        </form>`}
      </section>
    ` : '';
  const createPanel = tokenContext.mode === 'create' ? `
      <section class="pixel-panel cloud-login-card cloud-token-card" aria-labelledby="cloud-login-title">
        ${brandHtml}
        <div class="cloud-login-heading">
          <p>MagClaw</p>
          <h1 id="cloud-login-title">Create account</h1>
          <span>Create a MagClaw account with your email and password.</span>
        </div>
        <form id="cloud-open-register-form" class="cloud-login-form" novalidate>
          <label class="cloud-login-field"><span>Name</span><input name="name" autocomplete="name" placeholder="Letters, numbers, hyphens, underscores" required /></label>
          <label class="cloud-login-field"><span>Email</span><input name="email" type="email" autocomplete="email" required /></label>
          <label class="cloud-login-field"><span>Password</span><input name="password" type="password" autocomplete="new-password" placeholder="Min 8 characters" required /></label>
          <p class="cloud-password-rule">Password must be 8-30 characters and include letters and numbers.</p>
          ${loginErrorHtml}
          <button class="primary-btn cloud-login-submit" type="submit">Create account</button>
          <p class="cloud-login-switch">Already have an account? <a href="/" data-action="none">Sign in</a></p>
        </form>
      </section>
    ` : '';
  const forgotPanel = tokenContext.mode === 'forgot' ? `
      <section class="pixel-panel cloud-login-card cloud-token-card" aria-labelledby="cloud-login-title">
        ${brandHtml}
        <div class="cloud-login-heading">
          <p>MagClaw</p>
          <h1 id="cloud-login-title">Reset password</h1>
          <span>Enter your email and we’ll send a link to reset your password.</span>
        </div>
        <form id="cloud-forgot-form" class="cloud-login-form" novalidate>
          <label class="cloud-login-field"><span>Email</span><input name="email" type="email" autocomplete="email" value="${escapeHtml(cloudLoginDraftEmail)}" required /></label>
          ${loginErrorHtml}
          <button class="primary-btn cloud-login-submit" type="submit">Send reset link</button>
          <p class="cloud-login-switch"><a href="/" data-action="none">Back to sign in</a></p>
        </form>
      </section>
    ` : '';
  const forgotSentPanel = tokenContext.mode === 'forgot-sent' ? `
      <section class="pixel-panel cloud-login-card cloud-token-card cloud-check-email-card" aria-labelledby="cloud-login-title">
        <div class="cloud-check-icon" aria-hidden="true">${settingsIcon('members', 28)}</div>
        <div class="cloud-login-heading">
          <h1 id="cloud-login-title">Check your email</h1>
          <span>If an account exists with <strong>${escapeHtml(tokenContext.email || cloudLoginDraftEmail || 'that email')}</strong>, we’ve sent a password reset link.</span>
        </div>
        <a class="primary-btn cloud-login-submit" href="/">Back to sign in</a>
      </section>
    ` : '';
  const resetPanel = tokenContext.mode === 'reset' ? `
      <section class="pixel-panel cloud-login-card cloud-token-card" aria-labelledby="cloud-login-title">
        ${brandHtml}
        <div class="cloud-login-heading">
          <p>MagClaw</p>
          <h1 id="cloud-login-title">Set new password</h1>
          <span>Choose a new password for your account.</span>
        </div>
        ${tokenErrorHtml || `
        <form id="cloud-reset-form" class="cloud-login-form" novalidate>
          <input type="hidden" name="resetToken" value="${escapeHtml(tokenContext.token || '')}" />
          <label class="cloud-login-field"><span>Email address</span><input type="email" value="${escapeHtml(reset.email || '')}" disabled /></label>
          <label class="cloud-login-field"><span>New password</span><input name="password" type="password" autocomplete="new-password" placeholder="Password" required /></label>
          <label class="cloud-login-field"><span>Confirm password</span><input name="passwordConfirm" type="password" autocomplete="new-password" placeholder="Confirm password" required /></label>
          <p class="cloud-password-rule">Password must be 8-30 characters and include letters and numbers.</p>
          ${loginErrorHtml}
          <button class="primary-btn cloud-login-submit" type="submit">Reset Password</button>
        </form>`}
      </section>
    ` : '';
  const createAccountLink = '<p class="cloud-login-switch">No account? <a href="/create-account" data-action="none">Create one</a></p>';
  const loginPanel = `
      <section class="pixel-panel cloud-login-card" aria-labelledby="cloud-login-title">
        ${brandHtml}
        <div class="cloud-login-heading">
          <p>MagClaw</p>
          <h1 id="cloud-login-title">Sign in</h1>
          <span>Where humans and AI agents collaborate.</span>
        </div>
        <form id="cloud-login-form" class="cloud-login-form" novalidate>
          <label class="cloud-login-field"><span>Email</span><input name="email" type="email" autocomplete="email" value="${escapeHtml(cloudLoginDraftEmail)}" required /></label>
          <label class="cloud-login-field"><span>Password</span><input name="password" type="password" autocomplete="current-password" placeholder="Password" required /></label>
          ${loginErrorHtml}
          <button class="primary-btn cloud-login-submit" type="submit">Sign in</button>
          <p class="cloud-login-switch"><a href="/forgot-password" data-action="none">Forgot password?</a></p>
          ${createAccountLink}
        </form>
      </section>
    `;
  const joinPanel = tokenContext.mode === 'join' ? `
      <section class="pixel-panel cloud-login-card cloud-token-card join-link-card" aria-labelledby="cloud-login-title">
        ${brandHtml}
        <div class="cloud-login-heading">
          <p>MagClaw</p>
          <h1 id="cloud-login-title">${escapeHtml(joinWorkspace.name || 'Join server')}</h1>
          <span>${escapeHtml(joinWorkspace.slug ? `/${joinWorkspace.slug}` : 'Use this link to join a MagClaw server.')}</span>
        </div>
        ${tokenErrorHtml || (auth.currentUser ? `
          <form id="cloud-join-link-form" class="cloud-login-form" novalidate>
            <input type="hidden" name="joinToken" value="${escapeHtml(tokenContext.token || '')}" />
            <div class="join-link-summary">
              ${renderServerAvatar(joinWorkspace, 'join-link-server-avatar')}
              <div>
                <strong>${escapeHtml(joinWorkspace.name || 'Server')}</strong>
                <small>${escapeHtml(tokenContext.alreadyMember ? 'You are already a member.' : 'Joining adds this server to your Console.')}</small>
              </div>
            </div>
            <button class="primary-btn cloud-login-submit" type="submit">${tokenContext.alreadyMember ? 'Open Server' : 'Join Server'}</button>
          </form>
        ` : `
          <div class="join-link-summary">
            ${renderServerAvatar(joinWorkspace, 'join-link-server-avatar')}
            <div>
              <strong>${escapeHtml(joinWorkspace.name || 'Server')}</strong>
              <small>Sign in or create an account, then return to join this server.</small>
            </div>
          </div>
          ${loginPanel}
        `)}
      </section>
    ` : '';
  const loginPanels = tokenContext.mode === 'invite'
    ? registerPanel
    : tokenContext.mode === 'reset'
      ? resetPanel
      : tokenContext.mode === 'create'
        ? createPanel
        : tokenContext.mode === 'forgot'
          ? forgotPanel
          : tokenContext.mode === 'forgot-sent'
            ? forgotSentPanel
            : tokenContext.mode === 'join'
              ? joinPanel
              : loginPanel;

  root.innerHTML = `
    <main class="cloud-auth-shell">
      <div class="cloud-auth-stage">
        ${loginPanels}
        ${legalHtml}
      </div>
    </main>
  `;
  if (typeof translatePage === 'function') translatePage(root);
}

function renderBrowserSettingsTab() {
  return `
    <section class="settings-layout">
      ${renderNotificationConfigCard()}
    </section>
  `;
}

function renderServerSettingsTab() {
  const server = currentServerProfile();
  const serverAvatar = serverProfileAvatarDraft === null ? (server.avatar || '') : serverProfileAvatarDraft;
  const members = appState.cloud?.members || [];
  const admins = members.filter((member) => (
    (member.status || 'active') === 'active'
    && (cloudMemberDisplayRole(member) === 'owner' || (member.role || 'member') === 'admin')
  ));
  const pendingInvites = (appState.cloud?.invitations || []).filter((item) => (item.status || 'pending') === 'pending' && !item.acceptedAt && !item.declinedAt);
  const joinLinks = appState.cloud?.joinLinks || [];
  const agents = appState.agents || [];
  const canManage = cloudCan('manage_cloud_connection');
  return `
    <section class="cloud-layout server-settings-layout">
      <div class="pixel-panel cloud-card wide">
        <form id="server-profile-form" class="modal-form server-profile-form">
          <div class="panel-title"><span>Profile</span><span>${displayServerSlug(server.slug || server.id) ? `/${escapeHtml(displayServerSlug(server.slug || server.id))}` : ''}</span></div>
          <div class="server-profile-row">
            <span class="server-profile-avatar">${renderServerAvatar({ ...server, avatar: serverAvatar }, 'server-profile-avatar-img')}</span>
            <div class="server-profile-avatar-actions">
              <input type="hidden" name="avatar" value="${escapeHtml(serverAvatar)}" data-server-avatar-input />
              <label class="secondary-btn file-btn">
                Upload Avatar
                <input id="server-avatar-file" class="visually-hidden" type="file" accept="image/*" data-avatar-upload-target="server-profile" />
              </label>
              <button class="secondary-btn" type="button" data-action="reset-server-avatar">Use Initial</button>
            </div>
          </div>
          <label><span>Server Name</span><input name="name" value="${escapeHtml(server.name || '')}" ${canManage ? '' : 'disabled'} required /></label>
          <label><span>URL Slug</span><input name="slug" value="${escapeHtml(displayServerSlug(server.slug || server.id))}" disabled /></label>
          <input type="hidden" name="onboardingAgentId" value="${escapeHtml(server.onboardingAgentId || '')}" />
          <input type="hidden" name="newAgentGreetingEnabled" value="${server.newAgentGreetingEnabled === false ? 'false' : 'true'}" />
          <button class="primary-btn" type="submit" ${canManage ? '' : 'disabled'}>Save Server</button>
        </form>
      </div>

      <div class="pixel-panel cloud-card">
        <div class="panel-title"><span>Admins</span><span>${admins.length}</span></div>
        <div class="server-admin-list">
          ${admins.length ? admins.map((member) => `
            <div class="server-admin-row">
              <div>
                <strong>${escapeHtml(member.user?.name || member.user?.email || member.id)}</strong>
                <small>${escapeHtml(member.user?.email || '')}</small>
              </div>
              <select data-action="update-cloud-member-role" data-id="${escapeHtml(member.id)}" ${canManage && admins.length > 1 && cloudMemberDisplayRole(member) !== 'owner' ? '' : 'disabled'}>
                <option value="admin" selected>${cloudMemberDisplayRole(member) === 'owner' ? 'Owner' : 'Admin'}</option>
                <option value="member">Member</option>
              </select>
            </div>
          `).join('') : '<div class="empty-box small">No admins found.</div>'}
        </div>
      </div>

      <div class="pixel-panel cloud-card">
        <div class="panel-title"><span>Pending Invites</span><span>${pendingInvites.length}</span></div>
        <div class="server-invite-list">
          ${pendingInvites.length ? pendingInvites.map((invite) => `
            <div class="server-invite-row">
              <strong>${escapeHtml(invite.email || '')}</strong>
              <small>${escapeHtml(cloudRoleLabel(invite.role || 'member'))} · ${escapeHtml(fmtTime(invite.createdAt))}</small>
            </div>
          `).join('') : '<div class="empty-box small">No pending invites.</div>'}
        </div>
        <button class="secondary-btn" type="button" data-action="open-modal" data-modal="member-invite">Invite Human</button>
      </div>

      <div class="pixel-panel cloud-card wide">
        <form id="server-join-link-form" class="modal-form">
          <div class="panel-title"><span>Join Links</span><span>${joinLinks.length}</span></div>
          <p class="muted-note">Create a shareable link for people to join this server after signing in.</p>
          <div class="form-grid">
            <label><span>Max Uses</span><input name="maxUses" type="number" min="0" step="1" placeholder="Unlimited" /></label>
            <label><span>Expires In</span><select name="expiresIn">
              <option value="1h">1 hour</option>
              <option value="12h">12 hours</option>
              <option value="24h" selected>24 hours</option>
              <option value="30d">1 month</option>
              <option value="365d">1 year</option>
              <option value="never">Never expires</option>
            </select></label>
          </div>
          <button class="primary-btn" type="submit" ${canManage ? '' : 'disabled'}>Create Join Link</button>
        </form>
        <div class="server-join-link-list">
          ${joinLinks.length ? joinLinks.map((link) => `
            <div class="server-join-link-row">
              <div>
                <strong>${escapeHtml(link.url || 'Join link created')}</strong>
                <small>${escapeHtml(link.status || (link.revokedAt ? 'revoked' : 'active'))} · ${escapeHtml(link.usedCount || 0)}/${escapeHtml(link.maxUses || 'unlimited')} uses · ${escapeHtml(link.expiresAt ? `expires ${fmtTime(link.expiresAt)}` : 'no expiry')}</small>
              </div>
              <div class="action-row">
                ${link.url ? `<button class="secondary-btn" type="button" data-action="copy-join-link" data-url="${escapeHtml(link.url)}">Copy</button>` : ''}
                ${!link.revokedAt ? `<button class="danger-btn" type="button" data-action="revoke-join-link" data-id="${escapeHtml(link.id)}">Revoke</button>` : ''}
              </div>
            </div>
          `).join('') : '<div class="empty-box small">No join links yet.</div>'}
        </div>
      </div>

      <div class="pixel-panel cloud-card">
        <form id="server-onboarding-form" class="modal-form">
          <div class="panel-title"><span>Onboarding Behavior</span><span>${server.newAgentGreetingEnabled === false ? 'quiet' : 'greeting'}</span></div>
          <label><span>Human Onboarding Agent</span><select name="onboardingAgentId">
            <option value="">None</option>
            ${agents.map((agent) => `<option value="${escapeHtml(agent.id)}" ${server.onboardingAgentId === agent.id ? 'selected' : ''}>${escapeHtml(agent.name)}</option>`).join('')}
          </select></label>
          <label class="checkline"><input type="checkbox" name="newAgentGreetingEnabled" ${server.newAgentGreetingEnabled === false ? '' : 'checked'} /> Enable new Agent greeting</label>
          <button class="primary-btn" type="submit" ${canManage ? '' : 'disabled'}>Save Onboarding</button>
        </form>
      </div>

      ${renderFanoutApiConfigCard()}

      <details class="pixel-panel cloud-card danger-card server-danger-accordion" open>
        <summary>
          <span>Danger Zone</span>
          <small>Move this server to Lost Space</small>
        </summary>
        <form id="delete-server-form" class="modal-form">
          <p class="muted-note">This is a soft delete. Members, chats, Agents, Computers, invitations, and configuration are preserved, but Computers and Agents are disabled.</p>
          <label><span>Type slug to confirm</span><input name="slugConfirm" placeholder="${escapeHtml(server.slug || '')}" /></label>
          <button class="danger-btn" type="submit" ${canManage ? '' : 'disabled'}>Move Server to Lost Space</button>
        </form>
      </details>
    </section>
  `;
}

function consoleInvitationRows() {
  const currentEmail = normalizeInviteEmailValue(appState?.cloud?.auth?.currentUser?.email || '');
  const rows = appState?.cloud?.myInvitations || appState?.cloud?.invitations || [];
  return rows
    .filter(Boolean)
    .filter((item) => !currentEmail || normalizeInviteEmailValue(item.email || '') === currentEmail)
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
}

function consoleServers() {
  const servers = appState?.cloud?.workspaces || [];
  if (servers.length) return servers;
  const workspace = appState?.cloud?.workspace;
  const currentMember = appState?.cloud?.auth?.currentMember;
  return workspace && currentMember ? [workspace] : [];
}

function consoleServerPath(server = appState?.cloud?.workspace || {}) {
  const slug = encodeURIComponent(String(server.slug || server.id || currentServerSlug()).trim() || 'local');
  return `/s/${slug}`;
}

function renderConsoleOverview() {
  const user = appState?.cloud?.auth?.currentUser || {};
  const pendingCount = consoleInvitationRows().filter((item) => item?.status === 'pending').length;
  const serversCount = consoleServers().length;
  return `
    <section class="console-grid">
      <div class="pixel-panel cloud-card console-hero-card">
        <p class="eyebrow">Console</p>
        <h2>${escapeHtml(user.name || user.email || 'MagClaw account')}</h2>
        <p>${escapeHtml(user.email || 'Manage your servers and invitations from one account.')}</p>
      </div>
      <div class="pixel-panel cloud-card console-stat-card">
        <span>Servers</span>
        <strong>${escapeHtml(serversCount)}</strong>
        <button class="secondary-btn" type="button" data-action="set-console-tab" data-tab="servers">View Servers</button>
      </div>
      <div class="pixel-panel cloud-card console-stat-card">
        <span>Pending invitations</span>
        <strong>${escapeHtml(pendingCount)}</strong>
        <button class="secondary-btn" type="button" data-action="set-console-tab" data-tab="invitations">View Invitations</button>
      </div>
    </section>
  `;
}

function renderConsoleInvitations() {
  const invitations = consoleInvitationRows();
  if (!invitations.length) {
    return '<div class="pixel-panel cloud-card empty-box">No invitations for this account yet.</div>';
  }
  return `
    <section class="console-list">
      ${invitations.map((invitation) => {
        const pending = invitation.status === 'pending';
        return `
          <article class="pixel-panel cloud-card console-row">
            <div>
              <p class="eyebrow">${escapeHtml(invitation.status || 'pending')}</p>
              <h3>${escapeHtml(invitation.email || '')}</h3>
              <p>${escapeHtml(cloudRoleLabel(invitation.role || 'member'))} · invited ${escapeHtml(fmtTime(invitation.createdAt))}</p>
            </div>
            <div class="action-row">
              ${pending ? `
                <button class="secondary-btn" type="button" data-action="decline-console-invitation" data-id="${escapeHtml(invitation.id)}">Decline</button>
                <button class="primary-btn" type="button" data-action="accept-console-invitation" data-id="${escapeHtml(invitation.id)}">Join Server</button>
              ` : `<span class="pill">${escapeHtml(invitation.status || 'used')}</span>`}
            </div>
          </article>
        `;
      }).join('')}
    </section>
  `;
}

function renderConsoleServers() {
  const servers = consoleServers();
  return `
    <section class="console-switch-page">
      <div class="console-switch-head">
        <div>
          <h2>Choose Server</h2>
          <p>Signed in as ${escapeHtml(appState.cloud?.auth?.currentUser?.name || appState.cloud?.auth?.currentUser?.email || 'MagClaw user')}</p>
        </div>
        <button class="secondary-btn" type="button" data-action="confirm-cloud-auth-logout">Sign out</button>
      </div>
      <div class="console-switch-list">
        ${servers.length ? servers.map((server) => `
          <button class="console-switch-server" type="button" data-action="open-console-server" data-slug="${escapeHtml(server.slug || server.id || 'local')}">
            <strong>${escapeHtml(server.name || displayServerSlug(server.slug || server.id) || 'Server')}</strong>
            ${displayServerSlug(server.slug || server.id) ? `<small>/${escapeHtml(displayServerSlug(server.slug || server.id))}</small>` : ''}
          </button>
        `).join('') : '<div class="empty-box small">Choose a server to continue. If you do not have one yet, create a new server.</div>'}
      </div>
      <button class="primary-btn console-create-server" type="button" data-action="open-modal" data-modal="server-create">+ Create new server</button>
    </section>
  `;
}

function renderConsole() {
  const title = consoleTab === 'invitations'
    ? 'Invitations'
    : consoleTab === 'servers'
      ? 'Choose Server'
      : consoleTab === 'lost-space'
      ? 'Lost Space'
      : 'Console';
  const body = consoleTab === 'invitations'
    ? renderConsoleInvitations()
    : consoleTab === 'servers'
      ? renderConsoleServers()
      : consoleTab === 'lost-space'
      ? renderConsoleLostSpace()
      : renderConsoleOverview();
  return `
    <section class="settings-page console-page">
      <header class="settings-page-header">
        <div class="settings-page-heading">
          <div class="settings-page-icon">${settingsIcon('system', 24)}</div>
          <h2>${escapeHtml(title)}</h2>
        </div>
        <div class="action-row">${pill('Console', 'cyan')}</div>
      </header>
      ${body}
    </section>
  `;
}

function renderCloud() {
  const body = settingsTab === 'account'
    ? renderAccountSettingsTab()
    : settingsTab === 'browser'
      ? renderBrowserSettingsTab()
      : settingsTab === 'members'
        ? renderMembersSettingsTab()
        : settingsTab === 'lost-space'
        ? renderLostSpaceSettingsTab()
        : settingsTab === 'language'
          ? renderLanguageSettingsTab()
        : settingsTab === 'release'
          ? renderReleaseNotesSettingsTab()
          : renderServerSettingsTab();
  return renderSettingsChrome(body);
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

  if (selectedHumanId) {
    const human = humanByIdAny(selectedHumanId);
    if (human) return renderHumanDetail(human);
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
  return ['starting', 'thinking', 'working', 'running', 'busy', 'queued', 'warming'].includes(String(agent?.status || '').toLowerCase());
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
