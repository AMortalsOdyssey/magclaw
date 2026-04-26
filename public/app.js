const root = document.querySelector('#root');

let appState = null;
let selectedSpaceType = 'channel';
let selectedSpaceId = 'chan_all';
let activeView = 'space';
let activeTab = 'chat';
let railTab = 'spaces'; // 'spaces' or 'members'
let threadMessageId = null;
let selectedAgentId = null; // selected agent for detail panel
let modal = null;
let searchQuery = '';
let taskFilter = 'all';
let stagedAttachments = [];
let stagedAttachmentIds = [];
let installedRuntimes = [];
let selectedRuntimeId = null;

// Agent modal form state
let agentFormState = {
  computerId: '',
  name: '',
  description: '',
  model: '',
  reasoningEffort: '',
  avatar: '',
  envVars: [], // [{key: '', value: ''}]
};

// Avatar list (200 avatars)
const AVATAR_COUNT = 200;
function getRandomAvatar() {
  const idx = Math.floor(Math.random() * AVATAR_COUNT) + 1;
  return `/avatars/avatar_${String(idx).padStart(3, '0')}.svg`;
}

const taskColumns = [
  ['todo', 'Todo'],
  ['in_progress', 'In Progress'],
  ['in_review', 'In Review'],
  ['done', 'Done'],
];

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
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
    if (!response.ok) throw new Error(data.error || response.statusText);
    return data;
  });
}

function byId(list, id) {
  return (list || []).find((item) => item.id === id) || null;
}

function fmtTime(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '--';
  return date.toLocaleString([], { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function bytes(value) {
  const size = Number(value || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function shortId(id) {
  return String(id || '').split('_').pop()?.slice(0, 6) || 'local';
}

function displayName(id) {
  const human = byId(appState?.humans, id);
  if (human) return human.name;
  const agent = byId(appState?.agents, id);
  if (agent) return agent.name;
  return id === 'system' ? 'Magclaw' : 'Unknown';
}

function displayAvatar(id, type) {
  const name = displayName(id);
  if (type === 'system') return 'MC';
  return name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

function getAvatarHtml(id, type, cssClass = '') {
  if (type === 'system') {
    return `<span class="${cssClass}">MC</span>`;
  }
  const agent = byId(appState?.agents, id);
  if (agent?.avatar) {
    return `<img src="${escapeHtml(agent.avatar)}" class="${cssClass} avatar-img" alt="${escapeHtml(agent.name)}" />`;
  }
  const initials = displayAvatar(id, type);
  return `<span class="${cssClass}">${escapeHtml(initials)}</span>`;
}

function currentSpace() {
  const list = selectedSpaceType === 'channel' ? appState?.channels : appState?.dms;
  return byId(list, selectedSpaceId) || appState?.channels?.[0] || null;
}

function spaceName(spaceType, spaceId) {
  if (spaceType === 'channel') return `#${byId(appState?.channels, spaceId)?.name || 'missing'}`;
  const dm = byId(appState?.dms, spaceId);
  const other = dm?.participantIds?.find((id) => id !== 'hum_local');
  return `@${displayName(other || 'unknown')}`;
}

function spaceMessages(spaceType = selectedSpaceType, spaceId = selectedSpaceId) {
  return (appState?.messages || [])
    .filter((message) => message.spaceType === spaceType && message.spaceId === spaceId)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

function spaceTasks(spaceType = selectedSpaceType, spaceId = selectedSpaceId) {
  return (appState?.tasks || [])
    .filter((task) => task.spaceType === spaceType && task.spaceId === spaceId)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
}

function threadReplies(messageId) {
  return (appState?.replies || [])
    .filter((reply) => reply.parentMessageId === messageId)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

function taskThreadMessage(task) {
  return byId(appState?.messages, task?.threadMessageId || task?.messageId);
}

function taskTone(status) {
  if (status === 'done') return 'green';
  if (status === 'in_review') return 'amber';
  if (status === 'in_progress') return 'cyan';
  return 'blue';
}

function attachmentLinks(ids = []) {
  return ids
    .map((id) => byId(appState?.attachments, id))
    .filter(Boolean)
    .map((item) => `<a class="mini-attachment" href="${item.url}" target="_blank" rel="noreferrer">${escapeHtml(item.name)} <small>${bytes(item.bytes)}</small></a>`)
    .join('');
}

function pill(value, tone = 'blue') {
  return `<span class="pill tone-${tone}">${escapeHtml(value)}</span>`;
}

function toast(message) {
  let node = document.querySelector('.toast');
  if (!node) {
    node = document.createElement('div');
    node.className = 'toast';
    document.body.appendChild(node);
  }
  node.textContent = message;
  node.classList.add('show');
  window.setTimeout(() => node.classList.remove('show'), 2600);
}

function ensureSelection() {
  if (!appState) return;
  if (!byId(appState.channels, selectedSpaceId) && selectedSpaceType === 'channel') {
    selectedSpaceId = appState.channels[0]?.id || 'chan_all';
  }
  if (!byId(appState.dms, selectedSpaceId) && selectedSpaceType === 'dm') {
    selectedSpaceType = 'channel';
    selectedSpaceId = appState.channels[0]?.id || 'chan_all';
  }
}

function render() {
  if (!appState) {
    root.innerHTML = '<div class="boot">MAGCLAW LOCAL / BOOTING</div>';
    return;
  }
  ensureSelection();
  root.innerHTML = `
    <div class="app-frame collab-frame">
      ${renderRail()}
      <main class="workspace collab-main">
        ${renderMain()}
      </main>
      <aside class="inspector collab-inspector">
        ${renderInspector()}
      </aside>
    </div>
    ${modal ? renderModal() : ''}
  `;
}

function renderRail() {
  const channels = appState.channels || [];
  const dms = appState.dms || [];
  const unreadThreads = (appState.messages || []).filter((message) => message.replyCount > 0).length;
  const openTasks = (appState.tasks || []).filter((task) => task.status !== 'done').length;
  const saved = (appState.messages || []).filter((message) => message.savedBy?.includes('hum_local')).length;

  return `
    <aside class="rail collab-rail">
      <div class="view-switcher">
        <button class="view-tab${railTab === 'spaces' ? ' active' : ''}" type="button" data-action="set-rail-tab" data-rail-tab="spaces" title="Channels & DMs">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        </button>
        <button class="view-tab${railTab === 'members' ? ' active' : ''}" type="button" data-action="set-rail-tab" data-rail-tab="members" title="Members">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        </button>
      </div>

      ${railTab === 'spaces' ? `
      <div class="nav-list">
        ${renderNavItem('search', 'Search', 'search', searchQuery ? '⌘K' : '⌘K')}
        ${renderNavItem('threads', 'Threads', 'message', unreadThreads || '')}
        ${renderNavItem('tasks', 'Tasks', 'file', openTasks || '')}
        ${renderNavItem('saved', 'Saved', 'bookmark', saved || '')}
      </div>

      <div class="rail-section">
        <div class="rail-title">
          <span>Channels <em>${channels.length}</em></span>
          <button type="button" data-action="open-modal" data-modal="channel">+</button>
        </div>
        ${channels.map((channel) => renderChannelItem(channel)).join('')}
      </div>

      <div class="rail-section">
        <div class="rail-title">
          <span>DMs <em>${dms.length}</em></span>
          <button type="button" data-action="open-modal" data-modal="dm">+</button>
        </div>
        ${dms.map((dm) => {
          const other = dm.participantIds.find((id) => id !== 'hum_local');
          const agent = byId(appState.agents, other);
          const human = byId(appState.humans, other);
          const status = agent?.status || human?.status || '';
          return renderDmItem(dm.id, displayName(other), status, agent?.avatar || human?.avatar);
        }).join('')}
      </div>
      ` : `
      <div class="rail-section">
        <div class="rail-title">
          <span>Agents <em>${(appState.agents || []).length}</em></span>
          <button type="button" data-action="open-modal" data-modal="agent">+</button>
        </div>
        ${(appState.agents || []).map((agent) => renderAgentListItem(agent)).join('')}
      </div>

      <div class="rail-section">
        <div class="rail-title">
          <span>Humans <em>${(appState.humans || []).length}</em></span>
          <button type="button" data-action="open-modal" data-modal="human">+</button>
        </div>
        ${(appState.humans || []).map((human) => renderHumanListItem(human)).join('')}
      </div>

      <div class="rail-section">
        <div class="rail-title">
          <span>Computers <em>${(appState.computers || []).length}</em></span>
          <button type="button" data-action="open-modal" data-modal="computer">+</button>
        </div>
        ${(appState.computers || []).map((computer) => renderComputerListItem(computer)).join('')}
      </div>
      `}

      <div class="runtime-chip">
        <span class="status-dot ${appState.connection?.mode === 'cloud' ? 'online' : ''}"></span>
        <div>
          <strong>${escapeHtml(appState.runtime?.host || 'local')}</strong>
          <small>${escapeHtml(appState.connection?.mode === 'cloud' ? 'Connected' : 'Local')}</small>
        </div>
      </div>
    </aside>
  `;
}

function renderNavItem(view, label, icon, badge) {
  const active = activeView === view ? ' active' : '';
  const icons = {
    search: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>',
    message: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M13 8H7"/><path d="M17 12H7"/></svg>',
    file: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14,2 14,8 20,8"/></svg>',
    bookmark: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  };
  return `
    <button class="nav-item${active}" type="button" data-action="set-view" data-view="${view}">
      ${icons[icon] || ''}
      <span>${escapeHtml(label)}</span>
      ${badge ? `<em>${escapeHtml(badge)}</em>` : ''}
    </button>
  `;
}

function renderChannelItem(channel) {
  const active = activeView === 'space' && selectedSpaceType === 'channel' && selectedSpaceId === channel.id ? ' active' : '';
  return `
    <button class="space-btn${active}" type="button" data-action="select-space" data-type="channel" data-id="${channel.id}">
      <span class="channel-icon">#</span>
      <span class="channel-name">${escapeHtml(channel.name)}</span>
    </button>
  `;
}

function renderDmItem(id, name, status, avatar) {
  const active = activeView === 'space' && selectedSpaceType === 'dm' && selectedSpaceId === id ? ' active' : '';
  const statusClass = status === 'online' || status === 'idle' ? 'online' : '';
  const initials = name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  return `
    <button class="space-btn dm-btn${active}" type="button" data-action="select-space" data-type="dm" data-id="${id}">
      <span class="dm-avatar">${avatar ? `<img src="${avatar}" alt="">` : initials}</span>
      <span class="dm-name">${escapeHtml(name)}</span>
      <span class="dm-status ${statusClass}"></span>
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

function renderMain() {
  if (activeView === 'tasks') return renderGlobalTasks();
  if (activeView === 'threads') return renderThreads();
  if (activeView === 'saved') return renderSaved();
  if (activeView === 'search') return renderSearch();
  if (activeView === 'missions') return renderMissions();
  if (activeView === 'cloud') return renderCloud();
  return renderSpace();
}

function renderHeader(title, subtitle, actions = '') {
  return `
    <header class="space-header pixel-panel">
      <div>
        <p class="eyebrow">${escapeHtml(subtitle)}</p>
        <h2>${escapeHtml(title)}</h2>
      </div>
      <div class="action-row">${actions}</div>
    </header>
  `;
}

function getChannelMembers(channelId) {
  const channel = byId(appState?.channels, channelId);
  if (!channel) return { agents: [], humans: [] };
  const memberIds = channel.memberIds || [];
  const agents = (appState.agents || []).filter((a) => memberIds.includes(a.id));
  const humans = (appState.humans || []).filter((h) => memberIds.includes(h.id));
  return { agents, humans };
}

function renderSpace() {
  const space = currentSpace();
  if (!space) return renderHeader('No conversation', 'Local', '');
  const title = spaceName(selectedSpaceType, selectedSpaceId);
  const members = selectedSpaceType === 'channel' ? getChannelMembers(selectedSpaceId) : null;
  const memberCount = members ? members.agents.length + members.humans.length : 0;
  const actions = `
    ${selectedSpaceType === 'channel' ? `<button class="secondary-btn" type="button" data-action="open-modal" data-modal="channel-members">MEMBERS <strong>${memberCount}</strong></button>` : ''}
    <button class="secondary-btn" type="button" data-action="open-modal" data-modal="task">New Task</button>
    ${selectedSpaceType === 'channel' ? '<button class="secondary-btn" type="button" data-action="open-modal" data-modal="edit-channel">Edit</button>' : ''}
    <button class="danger-btn" type="button" data-action="stop-all">Stop Agents</button>
  `;

  return `
    ${renderHeader(title, selectedSpaceType === 'channel' ? (space.description || 'Channel') : 'Direct mission link', actions)}
    <div class="tabbar">
      <button class="${activeTab === 'chat' ? 'active' : ''}" type="button" data-action="set-tab" data-tab="chat">CHAT</button>
      <button class="${activeTab === 'tasks' ? 'active' : ''}" type="button" data-action="set-tab" data-tab="tasks">TASKS</button>
    </div>
    ${activeTab === 'tasks' ? renderTaskBoard(spaceTasks()) : renderChat()}
  `;
}

function renderChat() {
  const messages = spaceMessages();
  return `
    <section class="chat-panel pixel-panel">
      <div class="message-list">
        ${messages.length ? messages.map(renderMessage).join('') : '<div class="empty-box">No messages here yet.</div>'}
      </div>
      ${renderComposer()}
    </section>
  `;
}

function renderMessage(message) {
  const task = message.taskId ? byId(appState.tasks, message.taskId) : null;
  const saved = message.savedBy?.includes('hum_local');
  return `
    <article class="message-card">
      <div class="avatar">${getAvatarHtml(message.authorId, message.authorType, 'avatar-inner')}</div>
      <div class="message-body">
        <div class="message-meta">
          <strong>${escapeHtml(displayName(message.authorId))}</strong>
          <time>${fmtTime(message.createdAt)}</time>
          ${task ? pill(task.status, task.status === 'done' ? 'green' : 'amber') : ''}
        </div>
        <p>${escapeHtml(message.body || '(attachment)')}</p>
        <div class="message-attachments">${attachmentLinks(message.attachmentIds)}</div>
        <div class="message-actions">
          <button type="button" data-action="open-thread" data-id="${message.id}">Thread ${message.replyCount ? `(${message.replyCount})` : ''}</button>
          <button type="button" data-action="save-message" data-id="${message.id}">${saved ? 'Unsave' : 'Save'}</button>
          ${task ? '' : `<button type="button" data-action="message-task" data-id="${message.id}">As Task</button>`}
        </div>
      </div>
    </article>
  `;
}

function renderComposer() {
  return `
    <form id="message-form" class="chat-composer">
      <textarea name="body" rows="3" placeholder="Message ${escapeHtml(spaceName(selectedSpaceType, selectedSpaceId))}"></textarea>
      <div class="composer-row">
        <label class="file-btn small">
          <input id="chat-attachment-input" type="file" multiple />
          Attach
        </label>
        <label class="checkline"><input type="checkbox" name="asTask" /> As Task</label>
        <div class="attachment-strip compact">
          ${stagedAttachments.length ? stagedAttachments.map((item) => `<span>${escapeHtml(item.name)} <small>${bytes(item.bytes)}</small></span>`).join('') : '<span class="muted">No attachments</span>'}
        </div>
        <button class="primary-btn" type="submit">Send</button>
      </div>
    </form>
  `;
}

function renderTaskBoard(tasks) {
  const visibleColumns = taskFilter === 'all'
    ? taskColumns
    : taskColumns.filter(([status]) => status === taskFilter);
  const filteredTasks = taskFilter === 'all'
    ? tasks
    : tasks.filter((task) => task.status === taskFilter);
  return `
    <div class="task-filter pixel-panel">
      ${[['all', 'All'], ...taskColumns].map(([status, label]) => `
        <button class="${taskFilter === status ? 'active' : ''}" type="button" data-action="task-filter" data-status="${status}">
          ${escapeHtml(label)}
          <strong>${status === 'all' ? tasks.length : tasks.filter((task) => task.status === status).length}</strong>
        </button>
      `).join('')}
    </div>
    <section class="task-board">
      ${visibleColumns.map(([status, label]) => `
        <div class="task-column pixel-panel">
          <div class="panel-title"><span>${label}</span><span>${filteredTasks.filter((task) => task.status === status).length}</span></div>
          ${filteredTasks.filter((task) => task.status === status).map(renderTaskCard).join('') || '<div class="empty-box small">Empty</div>'}
        </div>
      `).join('')}
    </section>
  `;
}

function renderTaskCard(task) {
  const assignee = task.assigneeId ? displayName(task.assigneeId) : 'unassigned';
  const claimed = task.claimedBy ? displayName(task.claimedBy) : 'unclaimed';
  const history = Array.isArray(task.history) ? task.history.slice(-3).reverse() : [];
  const thread = taskThreadMessage(task);
  const canClaim = task.status !== 'done' && !task.claimedBy;
  const canUnclaim = task.status !== 'done' && Boolean(task.claimedBy);
  const canReview = task.status === 'in_progress' && Boolean(task.claimedBy);
  const canApprove = task.status === 'in_review';
  const canRun = task.status !== 'done' && (!task.claimedBy || task.claimedBy === 'agt_codex');
  return `
    <article class="task-card">
      <div class="task-card-head">
        <strong>${escapeHtml(task.title)}</strong>
        ${pill(task.status, taskTone(task.status))}
      </div>
      <p>${escapeHtml(task.body || '')}</p>
      <small>${escapeHtml(spaceName(task.spaceType, task.spaceId))} / assignee ${escapeHtml(assignee)} / claim ${escapeHtml(claimed)}</small>
      <div class="task-proof">
        <span>thread ${thread ? `#${shortId(thread.id)}` : 'missing'}</span>
        <span>${task.runIds?.length || 0} runs</span>
        <span>${task.history?.length || 0} history</span>
      </div>
      <div class="task-actions">
        ${canClaim ? `<button type="button" data-action="task-claim" data-id="${task.id}">Claim Codex</button>` : ''}
        ${canUnclaim ? `<button type="button" data-action="task-unclaim" data-id="${task.id}">Unclaim</button>` : ''}
        ${canRun ? `<button type="button" data-action="run-task-codex" data-id="${task.id}">Run Codex</button>` : ''}
        ${canReview ? `<button type="button" data-action="task-review" data-id="${task.id}">Request Review</button>` : ''}
        ${canApprove ? `<button type="button" data-action="task-approve" data-id="${task.id}">Approve Done</button>` : ''}
        ${task.status === 'done' ? `<button type="button" data-action="task-reopen" data-id="${task.id}">Reopen</button>` : ''}
        ${thread ? `<button type="button" data-action="open-thread" data-id="${thread.id}">Thread</button>` : ''}
        <button type="button" data-action="delete-task" data-id="${task.id}">Delete</button>
      </div>
      <div class="task-history">
        ${history.length ? history.map((item) => `<span>${escapeHtml(item.type)} · ${fmtTime(item.createdAt)}</span>`).join('') : '<span>No history yet</span>'}
      </div>
    </article>
  `;
}

function renderGlobalTasks() {
  return `
    ${renderHeader('Task Board', 'All channels and DMs', '<button class="primary-btn" type="button" data-action="open-modal" data-modal="task">New Task</button>')}
    ${renderTaskBoard(appState.tasks || [])}
  `;
}

function renderThreads() {
  const threaded = (appState.messages || []).filter((message) => message.replyCount > 0);
  return `
    ${renderHeader('Threads', 'Active reply trails', '')}
    <section class="list-panel pixel-panel">
      ${threaded.length ? threaded.map((message) => `
        <button class="thread-row" type="button" data-action="open-thread" data-id="${message.id}">
          <strong>${escapeHtml(message.body.slice(0, 110) || '(attachment)')}</strong>
          <span>${escapeHtml(spaceName(message.spaceType, message.spaceId))} / ${message.replyCount} replies</span>
        </button>
      `).join('') : '<div class="empty-box">No active threads.</div>'}
    </section>
  `;
}

function renderSaved() {
  const saved = (appState.messages || []).filter((message) => message.savedBy?.includes('hum_local'));
  return `
    ${renderHeader('Saved', 'Pinned local references', '')}
    <section class="list-panel pixel-panel">
      ${saved.length ? saved.map(renderMessage).join('') : '<div class="empty-box">No saved messages.</div>'}
    </section>
  `;
}

function renderSearch() {
  const q = searchQuery.trim().toLowerCase();
  const results = q
    ? (appState.messages || []).filter((message) => message.body.toLowerCase().includes(q))
    : [];
  return `
    ${renderHeader('Search', 'Messages, tasks, DMs', '')}
    <section class="search-panel pixel-panel">
      <input id="search-input" value="${escapeHtml(searchQuery)}" placeholder="Search messages..." autofocus />
      <div class="search-results">
        ${results.length ? results.map(renderMessage).join('') : '<div class="empty-box">Type to search local messages.</div>'}
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

function renderCloud() {
  const c = appState.connection || {};
  const isCloud = c.mode === 'cloud';
  const statusTone = c.pairingStatus === 'paired' ? 'green' : isCloud ? 'amber' : 'blue';
  return `
    ${renderHeader('Connection Mode', 'Local-first or cloud-connected', `
      ${pill(c.mode || 'local', isCloud ? 'cyan' : 'blue')}
      ${pill(c.pairingStatus || 'local', statusTone)}
    `)}
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
            <span>Use a Magclaw control plane URL for sync while local runner keeps executing Codex.</span>
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
          <label><span>Control Plane URL</span><input name="controlPlaneUrl" value="${escapeHtml(c.controlPlaneUrl || '')}" placeholder="https://app.magclaw.ai or http://127.0.0.1:4317" /></label>
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
          <div><strong>Synced</strong><p>channels, DMs, messages, replies, tasks, task history, agents, humans, computers, missions, run metadata and attachment metadata.</p></div>
          <div><strong>Local only</strong><p>Codex execution, local filesystem access, attachment binary files, shell environment, secrets and process control.</p></div>
          <div><strong>Next cloud step</strong><p>Replace manual snapshot sync with authenticated account login, cloud database, relay envelopes and object storage for attachments.</p></div>
        </div>
      </div>
    </section>
  `;
}

function renderInspector() {
  const thread = threadMessageId ? byId(appState.messages, threadMessageId) : null;
  if (thread) return renderThreadDrawer(thread);

  // If in members tab with agent selected, show agent detail
  if (railTab === 'members' && selectedAgentId) {
    const agent = byId(appState.agents, selectedAgentId);
    if (agent) return renderAgentDetail(agent);
  }

  // Default empty state
  return `
    <section class="pixel-panel inspector-panel">
      <div class="panel-title">
        <span>Inspector</span>
      </div>
      <div class="empty-box">
        <p>Select an agent to view details</p>
      </div>
    </section>
  `;
}

function renderAgentDetail(agent) {
  const computer = byId(appState.computers, agent.computerId);
  const envVars = agent.envVars || [];

  return `
    <section class="pixel-panel inspector-panel agent-detail">
      <div class="panel-title">
        <span>Agent Profile</span>
        <button type="button" data-action="close-agent-detail">×</button>
      </div>

      <div class="agent-profile-header">
        ${getAvatarHtml(agent.id, 'agent', 'avatar')}
        <div class="agent-profile-info">
          <strong>${escapeHtml(agent.name)}</strong>
          <span class="agent-status ${agent.status === 'idle' || agent.status === 'online' ? 'online' : ''}">${escapeHtml(agent.status)}</span>
        </div>
      </div>

      <div class="agent-detail-section">
        <div class="detail-label">Description</div>
        <p class="detail-value">${escapeHtml(agent.description || 'No description')}</p>
      </div>

      <div class="agent-detail-section">
        <div class="detail-label">Runtime</div>
        <div class="detail-value">${escapeHtml(agent.runtime || '--')}</div>
      </div>

      <div class="agent-detail-section">
        <div class="detail-label">Model</div>
        <div class="detail-value">${escapeHtml(agent.model || '--')}</div>
      </div>

      ${agent.reasoningEffort ? `
      <div class="agent-detail-section">
        <div class="detail-label">Reasoning Effort</div>
        <div class="detail-value">${escapeHtml(agent.reasoningEffort)}</div>
      </div>
      ` : ''}

      <div class="agent-detail-section">
        <div class="detail-label">Computer</div>
        <div class="detail-value">${escapeHtml(computer?.name || agent.computerId || '--')}</div>
      </div>

      <div class="agent-detail-section">
        <div class="detail-label">Workspace</div>
        <div class="detail-value">${escapeHtml(agent.workspace || '--')}</div>
      </div>

      ${envVars.length ? `
      <div class="agent-detail-section">
        <div class="detail-label">Environment Variables</div>
        <div class="env-vars-display">
          ${envVars.map((item) => `
            <div class="env-var-item">
              <span class="env-key-display">${escapeHtml(item.key)}</span>
              <span class="env-eq">=</span>
              <span class="env-value-display">${escapeHtml(item.value)}</span>
            </div>
          `).join('')}
        </div>
      </div>
      ` : ''}

      <div class="agent-detail-actions">
        <button class="secondary-btn" type="button" data-action="open-dm-with-agent" data-id="${agent.id}">Message</button>
        <button class="danger-btn" type="button" data-action="delete-agent" data-id="${agent.id}">Delete</button>
      </div>
    </section>
  `;
}

function renderAgent(agent) {
  return `
    <div class="agent-card">
      <div class="member-row">
        ${getAvatarHtml(agent.id, 'agent', 'avatar small-avatar')}
        <div><strong>${escapeHtml(agent.name)}</strong><small>${escapeHtml(agent.status)} / ${escapeHtml(agent.runtime)}</small></div>
      </div>
      <p>${escapeHtml(agent.description || 'No description')}</p>
      <small>${escapeHtml(agent.workspace || '')}</small>
    </div>
  `;
}

function renderAgentListItem(agent) {
  const active = selectedAgentId === agent.id ? ' active' : '';
  const statusClass = agent.status === 'online' || agent.status === 'idle' ? 'online' : '';
  return `
    <button class="space-btn member-btn${active}" type="button" data-action="select-agent" data-id="${agent.id}">
      ${getAvatarHtml(agent.id, 'agent', 'dm-avatar')}
      <span class="dm-name">${escapeHtml(agent.name)}</span>
      <span class="dm-status ${statusClass}"></span>
    </button>
  `;
}

function renderHumanListItem(human) {
  const statusClass = human.status === 'online' || human.status === 'idle' ? 'online' : '';
  return `
    <div class="space-btn member-btn">
      <span class="dm-avatar">${escapeHtml(displayAvatar(human.id, 'human'))}</span>
      <span class="dm-name">${escapeHtml(human.name)}</span>
      <span class="dm-status ${statusClass}"></span>
    </div>
  `;
}

function renderComputerListItem(computer) {
  const statusClass = computer.status === 'connected' ? 'online' : '';
  return `
    <div class="space-btn member-btn">
      <span class="dm-avatar">💻</span>
      <span class="dm-name">${escapeHtml(computer.name)}</span>
      <span class="dm-status ${statusClass}"></span>
    </div>
  `;
}

function renderThreadDrawer(message) {
  const replies = threadReplies(message.id);
  const task = message.taskId ? byId(appState.tasks, message.taskId) : null;
  return `
    <section class="pixel-panel inspector-panel thread-drawer">
      <div class="panel-title">
        <span>Thread</span>
        <button type="button" data-action="close-thread">x</button>
      </div>
      ${renderMessage(message)}
      ${task ? renderTaskLifecycle(task) : ''}
      <div class="reply-list">
        ${replies.length ? replies.map((reply) => `
          <article class="reply-card">
            <strong>${escapeHtml(displayName(reply.authorId))}</strong>
            <time>${fmtTime(reply.createdAt)}</time>
            <p>${escapeHtml(reply.body)}</p>
          </article>
        `).join('') : '<div class="empty-box small">No replies yet.</div>'}
      </div>
      <form id="reply-form" class="reply-form">
        <textarea name="body" rows="3" placeholder="Reply in thread"></textarea>
        <button class="primary-btn" type="submit">Reply</button>
      </form>
    </section>
  `;
}

function renderTaskLifecycle(task) {
  const history = Array.isArray(task.history) ? task.history.slice().reverse() : [];
  return `
    <div class="task-lifecycle">
      <div class="panel-title mini-title">
        <span>Task Lifecycle</span>
        <span>${escapeHtml(task.status)}</span>
      </div>
      <div class="task-actions">
        ${!task.claimedBy && task.status !== 'done' ? `<button type="button" data-action="task-claim" data-id="${task.id}">Claim Codex</button>` : ''}
        ${task.claimedBy && task.status !== 'done' ? `<button type="button" data-action="task-unclaim" data-id="${task.id}">Unclaim</button>` : ''}
        ${task.status === 'in_progress' ? `<button type="button" data-action="task-review" data-id="${task.id}">Request Review</button>` : ''}
        ${task.status === 'in_review' ? `<button type="button" data-action="task-approve" data-id="${task.id}">Approve Done</button>` : ''}
        ${task.status === 'done' ? `<button type="button" data-action="task-reopen" data-id="${task.id}">Reopen</button>` : ''}
      </div>
      <div class="history-list">
        ${history.length ? history.map((item) => `
          <div class="history-item">
            <strong>${escapeHtml(item.type)}</strong>
            <small>${fmtTime(item.createdAt)} / ${escapeHtml(displayName(item.actorId))}</small>
            <p>${escapeHtml(item.message)}</p>
          </div>
        `).join('') : '<div class="empty-box small">No task history.</div>'}
      </div>
    </div>
  `;
}

function renderModal() {
  const map = {
    channel: renderChannelModal,
    'edit-channel': renderEditChannelModal,
    'channel-members': renderChannelMembersModal,
    'add-channel-member': renderAddChannelMemberModal,
    dm: renderDmModal,
    task: renderTaskModal,
    agent: renderAgentModal,
    'avatar-picker': renderAvatarPickerModal,
    computer: renderComputerModal,
    human: renderHumanModal,
  };
  const content = map[modal]?.() || '';
  const isAvatarPicker = modal === 'avatar-picker';
  return `
    <div class="modal-backdrop" data-action="close-modal">
      <div class="modal-card pixel-panel ${isAvatarPicker ? 'modal-wide' : ''}" data-action="none">
        ${content}
      </div>
    </div>
  `;
}

function modalHeader(title, subtitle) {
  return `<div class="modal-head"><div><p class="eyebrow">${escapeHtml(subtitle)}</p><h3>${escapeHtml(title)}</h3></div><button type="button" data-action="close-modal">x</button></div>`;
}

function renderChannelModal() {
  const agents = appState.agents || [];
  return `
    ${modalHeader('Create Channel', 'Local collaboration')}
    <form id="channel-form" class="modal-form">
      <label><span>Name</span><input name="name" placeholder="frontend-war-room" required /></label>
      <label><span>Description</span><textarea name="description" rows="3"></textarea></label>
      <div class="form-field">
        <span>Add Agents</span>
        <div class="agent-checkboxes">
          ${agents.map((agent) => `
            <label class="checkbox-item">
              <input type="checkbox" name="agentIds" value="${agent.id}" />
              ${getAvatarHtml(agent.id, 'agent', 'dm-avatar')}
              <span>${escapeHtml(agent.name)}</span>
            </label>
          `).join('')}
          ${!agents.length ? '<div class="empty-box small">No agents available</div>' : ''}
        </div>
      </div>
      <button class="primary-btn" type="submit">Create</button>
    </form>
  `;
}

function renderEditChannelModal() {
  const channel = selectedSpaceType === 'channel' ? currentSpace() : null;
  return `
    ${modalHeader('Edit Channel', channel ? `#${channel.name}` : 'No channel')}
    <form id="edit-channel-form" class="modal-form">
      <label><span>Name</span><input name="name" value="${escapeHtml(channel?.name || '')}" required /></label>
      <label><span>Description</span><textarea name="description" rows="3">${escapeHtml(channel?.description || '')}</textarea></label>
      <button class="primary-btn" type="submit">Save</button>
    </form>
  `;
}

function renderChannelMembersModal() {
  const channel = selectedSpaceType === 'channel' ? currentSpace() : null;
  const members = getChannelMembers(selectedSpaceId);
  const isAllChannel = channel?.id === 'chan_all';

  return `
    ${modalHeader('Channel Members', channel ? `#${channel.name}` : 'No channel')}
    <div class="members-modal-content">
      <div class="members-section">
        <div class="members-section-title">Agents <em>${members.agents.length}</em></div>
        <div class="members-list">
          ${members.agents.length ? members.agents.map((agent) => `
            <div class="member-list-item">
              ${getAvatarHtml(agent.id, 'agent', 'dm-avatar')}
              <span class="member-name">${escapeHtml(agent.name)}</span>
              <span class="member-status ${agent.status === 'online' || agent.status === 'idle' ? 'online' : ''}">${escapeHtml(agent.status || 'offline')}</span>
              ${!isAllChannel ? `<button class="member-remove-btn" type="button" data-action="remove-channel-member" data-member-id="${agent.id}">×</button>` : ''}
            </div>
          `).join('') : '<div class="empty-box small">No agents in this channel</div>'}
        </div>
      </div>

      <div class="members-section">
        <div class="members-section-title">Humans <em>${members.humans.length}</em></div>
        <div class="members-list">
          ${members.humans.length ? members.humans.map((human) => `
            <div class="member-list-item">
              <span class="dm-avatar">${escapeHtml(displayAvatar(human.id, 'human'))}</span>
              <span class="member-name">${escapeHtml(human.name)}</span>
              <span class="member-status ${human.status === 'online' || human.status === 'idle' ? 'online' : ''}">${escapeHtml(human.status || 'offline')}</span>
              ${!isAllChannel && human.id !== 'hum_local' ? `<button class="member-remove-btn" type="button" data-action="remove-channel-member" data-member-id="${human.id}">×</button>` : ''}
            </div>
          `).join('') : '<div class="empty-box small">No humans in this channel</div>'}
        </div>
      </div>

      <div class="members-actions">
        <button class="secondary-btn" type="button" data-action="open-modal" data-modal="add-channel-member">Add Member</button>
        ${!isAllChannel ? `<button class="danger-btn" type="button" data-action="leave-channel">Leave Channel</button>` : ''}
      </div>
    </div>
  `;
}

function renderAddChannelMemberModal() {
  const channel = selectedSpaceType === 'channel' ? currentSpace() : null;
  const members = getChannelMembers(selectedSpaceId);
  const memberIds = [...members.agents.map((a) => a.id), ...members.humans.map((h) => h.id)];
  const availableAgents = (appState.agents || []).filter((a) => !memberIds.includes(a.id));
  const availableHumans = (appState.humans || []).filter((h) => !memberIds.includes(h.id) && h.id !== 'hum_local');

  return `
    ${modalHeader('Add Member', channel ? `#${channel.name}` : 'No channel')}
    <form id="add-member-form" class="modal-form">
      <label>
        <span>Select Member</span>
        <select name="memberId">
          <optgroup label="Agents">
            ${availableAgents.map((a) => `<option value="${a.id}">${escapeHtml(a.name)}</option>`).join('')}
          </optgroup>
          <optgroup label="Humans">
            ${availableHumans.map((h) => `<option value="${h.id}">${escapeHtml(h.name)}</option>`).join('')}
          </optgroup>
        </select>
      </label>
      <div class="modal-actions">
        <button type="button" class="secondary-btn" data-action="open-modal" data-modal="channel-members">Back</button>
        <button class="primary-btn" type="submit">Add</button>
      </div>
    </form>
  `;
}

function renderDmModal() {
  const options = [...(appState.agents || []), ...(appState.humans || []).filter((human) => human.id !== 'hum_local')];
  return `
    ${modalHeader('Open DM', 'Direct control line')}
    <form id="dm-form" class="modal-form">
      <label>
        <span>Participant</span>
        <select name="participantId">
          ${options.map((item) => `<option value="${item.id}">${escapeHtml(item.name)}</option>`).join('')}
        </select>
      </label>
      <button class="primary-btn" type="submit">Open</button>
    </form>
  `;
}

function renderTaskModal() {
  return `
    ${modalHeader('New Task', spaceName(selectedSpaceType, selectedSpaceId))}
    <form id="task-form" class="modal-form">
      <label><span>Title</span><input name="title" required /></label>
      <label><span>Body</span><textarea name="body" rows="4"></textarea></label>
      <label><span>Assignee</span><select name="assigneeId"><option value="">Unassigned</option>${(appState.agents || []).map((agent) => `<option value="${agent.id}">${escapeHtml(agent.name)}</option>`).join('')}</select></label>
      <label class="checkline"><input type="checkbox" name="addAnother" /> Add another after create</label>
      <button class="primary-btn" type="submit">Create Task</button>
    </form>
  `;
}

function renderEnvVarsList() {
  if (!agentFormState.envVars.length) {
    return '<div class="env-empty">No environment variables defined</div>';
  }
  return agentFormState.envVars.map((item, index) => `
    <div class="env-var-row" data-index="${index}">
      <input type="text" class="env-key" placeholder="KEY" value="${escapeHtml(item.key)}" data-env-index="${index}" data-env-field="key" />
      <span class="env-eq">=</span>
      <input type="text" class="env-value" placeholder="value" value="${escapeHtml(item.value)}" data-env-index="${index}" data-env-field="value" />
      <button type="button" class="env-remove-btn" data-action="remove-env-var" data-index="${index}">×</button>
    </div>
  `).join('');
}

function renderAgentModal() {
  const availableRuntimes = installedRuntimes.filter((rt) => rt.installed);
  const currentRuntime = availableRuntimes.find((rt) => rt.id === selectedRuntimeId) || availableRuntimes[0];
  const models = currentRuntime?.models || [];
  const modelNames = currentRuntime?.modelNames || models.map(m => ({ slug: m, name: m }));
  const defaultModel = agentFormState.model || currentRuntime?.defaultModel || '';
  const hasReasoningEffort = Boolean(currentRuntime?.reasoningEffort?.length);
  const reasoningEfforts = currentRuntime?.reasoningEffort || [];
  const defaultReasoningEffort = agentFormState.reasoningEffort || currentRuntime?.defaultReasoningEffort || 'medium';
  const defaultComputer = agentFormState.computerId || appState.computers?.[0]?.id || '';

  // Initialize avatar if not set
  if (!agentFormState.avatar) {
    agentFormState.avatar = getRandomAvatar();
  }

  return `
    ${modalHeader('CREATE AGENT', 'Local runtime profile')}
    <form id="agent-form" class="modal-form">
      <div class="avatar-picker">
        <span class="form-label">AVATAR</span>
        <div class="avatar-picker-row">
          <img src="${agentFormState.avatar}" class="avatar-preview" alt="Avatar" />
          <input type="hidden" name="avatar" value="${agentFormState.avatar}" />
          <button type="button" class="secondary-btn" data-action="randomize-avatar">🎲 Random</button>
          <button type="button" class="secondary-btn" data-action="pick-avatar">Browse</button>
        </div>
      </div>
      <label>
        <span>COMPUTER <span class="required">*</span></span>
        <select name="computerId">
          ${(appState.computers || []).map((c) => `<option value="${c.id}" ${c.id === defaultComputer ? 'selected' : ''}>${escapeHtml(c.name)} (${escapeHtml(c.name)})</option>`).join('')}
        </select>
      </label>
      <label>
        <span>NAME <span class="required">*</span></span>
        <input name="name" placeholder="e.g. Alice" value="${escapeHtml(agentFormState.name)}" required />
      </label>
      <label>
        <span>DESCRIPTION <span class="optional">(optional)</span></span>
        <textarea name="description" rows="3" placeholder="Leave blank for a general-purpose agent, or describe a role...">${escapeHtml(agentFormState.description)}</textarea>
        <small class="char-count">${agentFormState.description.length}/3000</small>
      </label>
      <div class="form-field">
        <span>RUNTIME</span>
        <select name="runtime" id="agent-runtime-select">
          ${installedRuntimes.map((rt) => {
            const label = rt.installed
              ? `${rt.name}${rt.version ? ` (${rt.version})` : ''}`
              : `${rt.name} (not installed)`;
            return `<option value="${rt.id}" ${!rt.installed ? 'disabled' : ''} ${rt.id === selectedRuntimeId ? 'selected' : ''}>${escapeHtml(label)}</option>`;
          }).join('')}
        </select>
      </div>
      <div class="form-field">
        <span>MODEL</span>
        <select name="model" id="agent-model-select">
          ${modelNames.map((m) => {
            const slug = typeof m === 'string' ? m : m.slug;
            const name = typeof m === 'string' ? m : m.name;
            return `<option value="${slug}" ${slug === defaultModel ? 'selected' : ''}>${escapeHtml(name)}</option>`;
          }).join('')}
        </select>
      </div>
      ${hasReasoningEffort ? `
      <div class="form-field">
        <span>REASONING EFFORT</span>
        <select name="reasoningEffort" id="agent-reasoning-select">
          ${reasoningEfforts.map((e) => `<option value="${e}" ${e === defaultReasoningEffort ? 'selected' : ''}>${escapeHtml(e.charAt(0).toUpperCase() + e.slice(1))}</option>`).join('')}
        </select>
      </div>
      ` : ''}
      <details class="advanced-section">
        <summary>ADVANCED</summary>
        <div class="advanced-content">
          <label>
            <span>ENVIRONMENT VARIABLES</span>
            <small>These will be injected into the runtime command environment.</small>
            <div id="env-vars-list">${renderEnvVarsList()}</div>
            <button type="button" class="add-var-btn" data-action="add-env-var">+ Add Variable</button>
          </label>
        </div>
      </details>
      <div class="modal-actions">
        <button type="button" class="secondary-btn" data-action="close-modal">Cancel</button>
        <button class="primary-btn" type="submit">Create Agent</button>
      </div>
    </form>
  `;
}

function renderAvatarPickerModal() {
  let html = `${modalHeader('SELECT AVATAR', 'Choose an avatar for your agent')}
    <div class="avatar-grid">`;
  for (let i = 1; i <= AVATAR_COUNT; i++) {
    const src = `/avatars/avatar_${String(i).padStart(3, '0')}.svg`;
    const selected = agentFormState.avatar === src ? 'selected' : '';
    html += `<img src="${src}" class="avatar-option ${selected}" data-avatar="${src}" />`;
  }
  html += `</div>
    <div class="modal-actions">
      <button type="button" class="secondary-btn" data-action="back-to-agent-modal">Back</button>
    </div>`;
  return html;
}

function renderComputerModal() {
  return `
    ${modalHeader('Add Computer', 'Local or remote runner')}
    <form id="computer-form" class="modal-form">
      <label><span>Name</span><input name="name" placeholder="Mac Studio" required /></label>
      <label><span>OS</span><input name="os" placeholder="darwin arm64" /></label>
      <label><span>Status</span><select name="status"><option>offline</option><option>connected</option></select></label>
      <button class="primary-btn" type="submit">Add Computer</button>
    </form>
  `;
}

function renderHumanModal() {
  return `
    ${modalHeader('Invite Human', 'Local team placeholder')}
    <form id="human-form" class="modal-form">
      <label><span>Name</span><input name="name" placeholder="Teammate" /></label>
      <label><span>Email</span><input name="email" type="email" placeholder="person@example.com" /></label>
      <button class="primary-btn" type="submit">Invite</button>
    </form>
  `;
}

async function loadInstalledRuntimes() {
  try {
    const response = await api('/api/runtimes');
    installedRuntimes = response.runtimes || [];
    const firstInstalled = installedRuntimes.find((rt) => rt.installed);
    if (firstInstalled && !selectedRuntimeId) {
      selectedRuntimeId = firstInstalled.id;
    }
  } catch (error) {
    console.error('Failed to load runtimes:', error);
    installedRuntimes = [];
  }
}

function saveAgentFormState() {
  const form = document.getElementById('agent-form');
  if (!form) return;
  const data = new FormData(form);
  agentFormState.computerId = data.get('computerId') || '';
  agentFormState.name = data.get('name') || '';
  agentFormState.description = data.get('description') || '';
  agentFormState.model = data.get('model') || '';
  agentFormState.reasoningEffort = data.get('reasoningEffort') || '';
  agentFormState.avatar = data.get('avatar') || agentFormState.avatar;
}

function resetAgentFormState() {
  agentFormState = {
    computerId: '',
    name: '',
    description: '',
    model: '',
    reasoningEffort: '',
    avatar: '',
    envVars: [],
  };
  selectedRuntimeId = null;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({
      name: file.name,
      type: file.type || 'application/octet-stream',
      dataUrl: reader.result,
    });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadFiles(files) {
  const payload = await Promise.all([...files].map(readFileAsDataUrl));
  const result = await api('/api/attachments', {
    method: 'POST',
    body: JSON.stringify({ files: payload }),
  });
  stagedAttachments = result.attachments || [];
  stagedAttachmentIds = stagedAttachments.map((item) => item.id);
  toast(`${stagedAttachments.length} attachment(s) staged`);
  await refreshState();
}

function cloudFormPayload(forcedMode) {
  const form = document.querySelector('#cloud-config-form');
  const current = appState?.connection || {};
  const data = form ? new FormData(form) : null;
  const cloudToken = String(data?.get('cloudToken') || '').trim();
  const payload = {
    mode: forcedMode || data?.get('mode') || current.mode || 'local',
    controlPlaneUrl: data?.get('controlPlaneUrl') ?? current.controlPlaneUrl ?? '',
    relayUrl: data?.get('relayUrl') ?? current.relayUrl ?? '',
    workspaceId: data?.get('workspaceId') ?? current.workspaceId ?? 'local',
    deviceName: data?.get('deviceName') ?? current.deviceName ?? '',
    autoSync: data ? Boolean(data.get('autoSync')) : Boolean(current.autoSync),
  };
  if (cloudToken) payload.cloudToken = cloudToken;
  return payload;
}

async function refreshState() {
  appState = await api('/api/state');
  render();
}

function connectEvents() {
  const source = new EventSource('/api/events');
  source.addEventListener('state', (event) => {
    appState = JSON.parse(event.data);
    // When modal is open, don't re-render to avoid interrupting form input
    if (!modal) {
      render();
    }
  });
  source.addEventListener('run-event', (event) => {
    const incoming = JSON.parse(event.data);
    if (!appState.events.some((item) => item.id === incoming.id)) {
      appState.events.push(incoming);
      // When modal is open, don't re-render
      if (!modal) {
        render();
      }
    }
  });
}

document.addEventListener('keydown', (event) => {
  const textarea = event.target.closest('#message-form textarea[name="body"]');
  if (textarea && event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    const form = document.getElementById('message-form');
    if (form) form.requestSubmit();
  }
});

document.addEventListener('input', (event) => {
  if (event.target.id === 'search-input') {
    searchQuery = event.target.value;
    render();
    const input = document.querySelector('#search-input');
    input?.focus();
    input?.setSelectionRange(searchQuery.length, searchQuery.length);
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

document.addEventListener('change', async (event) => {
  // Save agent form select state
  const form = event.target.closest('#agent-form');
  if (form) {
    const name = event.target.name;
    if (name === 'computerId') agentFormState.computerId = event.target.value;
    if (name === 'model') agentFormState.model = event.target.value;
    if (name === 'reasoningEffort') agentFormState.reasoningEffort = event.target.value;
  }

  if (event.target.id === 'agent-runtime-select') {
    // Save current form state
    saveAgentFormState();
    selectedRuntimeId = event.target.value;
    // Reset model selection (runtime changed)
    agentFormState.model = '';
    agentFormState.reasoningEffort = '';
    render();
    return;
  }
  if (event.target.id !== 'chat-attachment-input') return;
  if (!event.target.files?.length) return;
  try {
    await uploadFiles(event.target.files);
  } catch (error) {
    toast(error.message);
  }
});

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'none') return;

  // Environment variable actions: don't trigger refreshState
  if (action === 'add-env-var') {
    agentFormState.envVars.push({ key: '', value: '' });
    const listEl = document.getElementById('env-vars-list');
    if (listEl) listEl.innerHTML = renderEnvVarsList();
    return;
  }
  if (action === 'remove-env-var') {
    const index = parseInt(target.dataset.index, 10);
    if (!Number.isNaN(index)) {
      agentFormState.envVars.splice(index, 1);
      const listEl = document.getElementById('env-vars-list');
      if (listEl) listEl.innerHTML = renderEnvVarsList();
    }
    return;
  }

  // Avatar picker actions
  if (action === 'randomize-avatar') {
    agentFormState.avatar = getRandomAvatar();
    const preview = document.querySelector('.avatar-preview');
    const input = document.querySelector('input[name="avatar"]');
    if (preview) preview.src = agentFormState.avatar;
    if (input) input.value = agentFormState.avatar;
    return;
  }
  if (action === 'pick-avatar') {
    saveAgentFormState();
    modal = 'avatar-picker';
    render();
    return;
  }
  if (action === 'back-to-agent-modal') {
    modal = 'agent';
    render();
    return;
  }
  if (target.classList.contains('avatar-option')) {
    const avatarSrc = target.dataset.avatar;
    if (avatarSrc) {
      agentFormState.avatar = avatarSrc;
      document.querySelectorAll('.avatar-option').forEach((el) => el.classList.remove('selected'));
      target.classList.add('selected');
    }
    return;
  }

  try {
    if (action === 'set-view') {
      activeView = target.dataset.view;
      threadMessageId = null;
      render();
    }
    if (action === 'set-rail-tab') {
      railTab = target.dataset.railTab;
      if (railTab === 'spaces') {
        selectedAgentId = null;
      }
      render();
    }
    if (action === 'select-agent') {
      selectedAgentId = target.dataset.id;
      render();
    }
    if (action === 'close-agent-detail') {
      selectedAgentId = null;
      render();
    }
    if (action === 'open-dm-with-agent') {
      const agentId = target.dataset.id;
      const existingDm = (appState.dms || []).find((dm) => dm.participantIds.includes(agentId));
      if (existingDm) {
        selectedSpaceType = 'dm';
        selectedSpaceId = existingDm.id;
        activeView = 'space';
        railTab = 'spaces';
        selectedAgentId = null;
        render();
      } else {
        const result = await api('/api/dms', {
          method: 'POST',
          body: JSON.stringify({ participantId: agentId }),
        });
        selectedSpaceType = 'dm';
        selectedSpaceId = result.dm.id;
        activeView = 'space';
        railTab = 'spaces';
        selectedAgentId = null;
      }
    }
    if (action === 'delete-agent') {
      if (!window.confirm('Delete this agent?')) return;
      await api(`/api/agents/${target.dataset.id}`, { method: 'DELETE' });
      selectedAgentId = null;
      toast('Agent deleted');
    }
    if (action === 'select-space') {
      selectedSpaceType = target.dataset.type;
      selectedSpaceId = target.dataset.id;
      activeView = 'space';
      activeTab = 'chat';
      threadMessageId = null;
      render();
    }
    if (action === 'set-tab') {
      activeTab = target.dataset.tab;
      render();
    }
    if (action === 'task-filter') {
      taskFilter = target.dataset.status;
      render();
    }
    if (action === 'open-modal') {
      modal = target.dataset.modal;
      if (modal === 'agent') {
        await loadInstalledRuntimes();
      }
      render();
    }
    if (action === 'close-modal') {
      const isBackdrop = event.target.classList.contains('modal-backdrop');
      const isCloseBtn = event.target.closest('.modal-head button[data-action="close-modal"]');
      const isCancelBtn = event.target.closest('.modal-actions .secondary-btn[data-action="close-modal"]');
      if (isBackdrop || isCloseBtn || isCancelBtn) {
        if (modal === 'agent') {
          resetAgentFormState();
        }
        modal = null;
        render();
      }
    }
    if (action === 'open-thread') {
      threadMessageId = target.dataset.id;
      render();
    }
    if (action === 'close-thread') {
      threadMessageId = null;
      render();
    }
    if (action === 'save-message') {
      await api(`/api/messages/${target.dataset.id}/save`, { method: 'POST', body: '{}' });
    }
    if (action === 'message-task') {
      await api(`/api/messages/${target.dataset.id}/task`, { method: 'POST', body: '{}' });
      toast('Task created from message');
    }
    if (action === 'task-claim') {
      await api(`/api/tasks/${target.dataset.id}/claim`, { method: 'POST', body: JSON.stringify({ actorId: 'agt_codex' }) });
      toast('Task claimed');
    }
    if (action === 'task-unclaim') {
      await api(`/api/tasks/${target.dataset.id}/unclaim`, { method: 'POST', body: '{}' });
      toast('Task unclaimed');
    }
    if (action === 'task-review') {
      await api(`/api/tasks/${target.dataset.id}/request-review`, { method: 'POST', body: '{}' });
      toast('Review requested');
    }
    if (action === 'task-approve') {
      await api(`/api/tasks/${target.dataset.id}/approve`, { method: 'POST', body: '{}' });
      toast('Task approved');
    }
    if (action === 'task-reopen') {
      await api(`/api/tasks/${target.dataset.id}/reopen`, { method: 'POST', body: '{}' });
      toast('Task reopened');
    }
    if (action === 'delete-task') {
      await api(`/api/tasks/${target.dataset.id}`, { method: 'DELETE' });
      toast('Task deleted');
    }
    if (action === 'run-task-codex') {
      await api(`/api/tasks/${target.dataset.id}/run-codex`, { method: 'POST', body: '{}' });
      activeView = 'missions';
      toast('Codex mission started');
    }
    if (action === 'stop-all') {
      await api('/api/agents/stop-all', { method: 'POST', body: '{}' });
      toast('Stop all requested');
    }
    if (action === 'cloud-local' || action === 'cloud-disconnect') {
      await api('/api/cloud/disconnect', { method: 'POST', body: '{}' });
      toast('Local-only mode enabled');
    }
    if (action === 'cloud-configure') {
      await api('/api/cloud/config', {
        method: 'POST',
        body: JSON.stringify(cloudFormPayload('cloud')),
      });
      toast('Cloud mode configured');
    }
    if (action === 'cloud-pair') {
      const payload = cloudFormPayload('cloud');
      await api('/api/cloud/config', { method: 'POST', body: JSON.stringify(payload) });
      await api('/api/cloud/pair', { method: 'POST', body: JSON.stringify(payload) });
      toast('Cloud endpoint paired');
    }
    if (action === 'cloud-push') {
      await api('/api/cloud/sync/push', { method: 'POST', body: '{}' });
      toast('Local state pushed');
    }
    if (action === 'cloud-pull') {
      if (!window.confirm('Pull cloud state and replace the synced local state?')) return;
      await api('/api/cloud/sync/pull', { method: 'POST', body: '{}' });
      toast('Cloud state pulled');
    }
    if (action === 'leave-channel') {
      if (!window.confirm('Leave this channel?')) return;
      await api(`/api/channels/${selectedSpaceId}/leave`, { method: 'POST', body: '{}' });
      selectedSpaceType = 'channel';
      selectedSpaceId = 'chan_all';
      modal = null;
      toast('Left channel');
    }
    if (action === 'remove-channel-member') {
      const memberId = target.dataset.memberId;
      await api(`/api/channels/${selectedSpaceId}/members/${memberId}`, { method: 'DELETE' });
      toast('Member removed');
    }
  } catch (error) {
    toast(error.message);
  } finally {
    await refreshState().catch(() => {});
  }
});

document.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);

  try {
    if (form.id === 'message-form') {
      await api(`/api/spaces/${selectedSpaceType}/${selectedSpaceId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          body: data.get('body'),
          asTask: Boolean(data.get('asTask')),
          attachmentIds: stagedAttachmentIds,
        }),
      });
      stagedAttachments = [];
      stagedAttachmentIds = [];
      form.reset();
      toast('Message sent');
    }
    if (form.id === 'reply-form') {
      await api(`/api/messages/${threadMessageId}/replies`, {
        method: 'POST',
        body: JSON.stringify({ body: data.get('body') }),
      });
      form.reset();
      toast('Reply added');
    }
    if (form.id === 'channel-form') {
      const agentIds = [...form.querySelectorAll('input[name="agentIds"]:checked')].map((el) => el.value);
      const result = await api('/api/channels', {
        method: 'POST',
        body: JSON.stringify({
          name: data.get('name'),
          description: data.get('description'),
          agentIds: agentIds,
        }),
      });
      selectedSpaceType = 'channel';
      selectedSpaceId = result.channel.id;
      activeView = 'space';
      modal = null;
    }
    if (form.id === 'edit-channel-form') {
      await api(`/api/channels/${selectedSpaceId}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: data.get('name'), description: data.get('description') }),
      });
      modal = null;
    }
    if (form.id === 'add-member-form') {
      const memberId = data.get('memberId');
      if (memberId) {
        await api(`/api/channels/${selectedSpaceId}/members`, {
          method: 'POST',
          body: JSON.stringify({ memberId }),
        });
        toast('Member added');
      }
      modal = 'channel-members';
    }
    if (form.id === 'dm-form') {
      const result = await api('/api/dms', {
        method: 'POST',
        body: JSON.stringify({ participantId: data.get('participantId') }),
      });
      selectedSpaceType = 'dm';
      selectedSpaceId = result.dm.id;
      activeView = 'space';
      modal = null;
    }
    if (form.id === 'task-form') {
      await api('/api/tasks', {
        method: 'POST',
        body: JSON.stringify({
          title: data.get('title'),
          body: data.get('body'),
          assigneeId: data.get('assigneeId'),
          spaceType: selectedSpaceType,
          spaceId: selectedSpaceId,
        }),
      });
      if (data.get('addAnother')) {
        form.reset();
      } else {
        modal = null;
      }
      activeTab = 'tasks';
    }
    if (form.id === 'agent-form') {
      const selectedRuntime = installedRuntimes.find((rt) => rt.id === data.get('runtime'));
      // Filter out empty environment variables
      const envVars = agentFormState.envVars.filter((item) => item.key.trim());
      await api('/api/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: data.get('name'),
          description: data.get('description'),
          runtime: selectedRuntime?.name || data.get('runtime'),
          model: data.get('model'),
          computerId: data.get('computerId'),
          reasoningEffort: data.get('reasoningEffort') || null,
          envVars: envVars.length ? envVars : null,
          avatar: data.get('avatar') || agentFormState.avatar || getRandomAvatar(),
        }),
      });
      selectedRuntimeId = null;
      modal = null;
    }
    if (form.id === 'computer-form') {
      await api('/api/computers', {
        method: 'POST',
        body: JSON.stringify({ name: data.get('name'), os: data.get('os'), status: data.get('status') }),
      });
      modal = null;
    }
    if (form.id === 'human-form') {
      await api('/api/humans', {
        method: 'POST',
        body: JSON.stringify({ name: data.get('name'), email: data.get('email') }),
      });
      modal = null;
    }
    if (form.id === 'cloud-config-form') {
      await api('/api/cloud/config', {
        method: 'POST',
        body: JSON.stringify(cloudFormPayload()),
      });
      toast('Connection saved');
    }
  } catch (error) {
    toast(error.message);
  } finally {
    await refreshState().catch(() => {});
  }
});

render();
refreshState().then(connectEvents).catch((error) => {
  root.innerHTML = `<div class="boot">MAGCLAW LOCAL / ${escapeHtml(error.message)}</div>`;
});
