const root = document.querySelector('#root');

let appState = null;
let selectedSpaceType = 'channel';
let selectedSpaceId = 'chan_all';
let activeView = 'space';
let activeTab = 'chat';
let threadMessageId = null;
let modal = null;
let searchQuery = '';
let taskFilter = 'all';
let stagedAttachments = [];
let stagedAttachmentIds = [];

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
      <div class="brand-block">
        <div class="brand-mark">MC</div>
        <div>
          <h1>Magclaw</h1>
          <p>LOCAL TEAM RUNTIME</p>
        </div>
      </div>

      <div class="quick-stack">
        ${renderQuick('search', 'Search', searchQuery ? '*' : '')}
        ${renderQuick('threads', 'Threads', unreadThreads)}
        ${renderQuick('tasks', 'Tasks', openTasks)}
        ${renderQuick('saved', 'Saved', saved)}
        ${renderQuick('missions', 'Missions', appState.missions?.length || 0)}
        ${renderQuick('cloud', 'Cloud', appState.connection?.mode || 'local')}
      </div>

      <div class="rail-section">
        <div class="rail-title">
          <span>Channels</span>
          <button type="button" data-action="open-modal" data-modal="channel">+</button>
        </div>
        ${channels.map((channel) => renderSpaceButton('channel', channel.id, `#${channel.name}`, channel.archived ? 'archived' : '')).join('')}
      </div>

      <div class="rail-section">
        <div class="rail-title">
          <span>DMs</span>
          <button type="button" data-action="open-modal" data-modal="dm">+</button>
        </div>
        ${dms.map((dm) => {
          const other = dm.participantIds.find((id) => id !== 'hum_local');
          return renderSpaceButton('dm', dm.id, `@${displayName(other)}`, byId(appState.agents, other)?.status || byId(appState.humans, other)?.status || '');
        }).join('')}
      </div>

      <div class="runtime-chip">
        <span class="pulse"></span>
        <div>
          <strong>${escapeHtml(appState.runtime?.host || 'local')}</strong>
          <small>${escapeHtml(appState.connection?.mode || 'local')} / ${escapeHtml(appState.connection?.pairingStatus || 'local')}</small>
        </div>
      </div>
    </aside>
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

function renderSpace() {
  const space = currentSpace();
  if (!space) return renderHeader('No conversation', 'Local', '');
  const title = spaceName(selectedSpaceType, selectedSpaceId);
  const actions = `
    <button class="secondary-btn" type="button" data-action="open-modal" data-modal="task">New Task</button>
    ${selectedSpaceType === 'channel' ? '<button class="secondary-btn" type="button" data-action="open-modal" data-modal="edit-channel">Edit Channel</button>' : ''}
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
      <div class="avatar">${escapeHtml(displayAvatar(message.authorId, message.authorType))}</div>
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
  return `
    <section class="pixel-panel inspector-panel">
      <div class="panel-title">
        <span>Agents</span>
        <button type="button" data-action="open-modal" data-modal="agent">+</button>
      </div>
      ${(appState.agents || []).map(renderAgent).join('')}
    </section>
    <section class="pixel-panel inspector-panel">
      <div class="panel-title">
        <span>Humans</span>
        <button type="button" data-action="open-modal" data-modal="human">+</button>
      </div>
      ${(appState.humans || []).map((human) => `
        <div class="member-row">
          <span class="avatar small-avatar">${escapeHtml(displayAvatar(human.id, 'human'))}</span>
          <div><strong>${escapeHtml(human.name)}</strong><small>${escapeHtml(human.status)} / ${escapeHtml(human.role)}</small></div>
        </div>
      `).join('')}
    </section>
    <section class="pixel-panel inspector-panel">
      <div class="panel-title">
        <span>Computers</span>
        <button type="button" data-action="open-modal" data-modal="computer">+</button>
      </div>
      ${(appState.computers || []).map((computer) => `
        <div class="machine-card">
          <strong>${escapeHtml(computer.name)}</strong>
          <span>${escapeHtml(computer.status)} / ${escapeHtml(computer.os)}</span>
          <small>daemon ${escapeHtml(computer.daemonVersion)}</small>
        </div>
      `).join('')}
    </section>
  `;
}

function renderAgent(agent) {
  return `
    <div class="agent-card">
      <div class="member-row">
        <span class="avatar small-avatar">${escapeHtml(displayAvatar(agent.id, 'agent'))}</span>
        <div><strong>${escapeHtml(agent.name)}</strong><small>${escapeHtml(agent.status)} / ${escapeHtml(agent.runtime)}</small></div>
      </div>
      <p>${escapeHtml(agent.description || 'No description')}</p>
      <small>${escapeHtml(agent.workspace || '')}</small>
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
    dm: renderDmModal,
    task: renderTaskModal,
    agent: renderAgentModal,
    computer: renderComputerModal,
    human: renderHumanModal,
  };
  const content = map[modal]?.() || '';
  return `
    <div class="modal-backdrop" data-action="close-modal">
      <div class="modal-card pixel-panel" onclick="event.stopPropagation()">
        ${content}
      </div>
    </div>
  `;
}

function modalHeader(title, subtitle) {
  return `<div class="modal-head"><div><p class="eyebrow">${escapeHtml(subtitle)}</p><h3>${escapeHtml(title)}</h3></div><button type="button" data-action="close-modal">x</button></div>`;
}

function renderChannelModal() {
  return `
    ${modalHeader('Create Channel', 'Local collaboration')}
    <form id="channel-form" class="modal-form">
      <label><span>Name</span><input name="name" placeholder="frontend-war-room" required /></label>
      <label><span>Description</span><textarea name="description" rows="3"></textarea></label>
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

function renderAgentModal() {
  return `
    ${modalHeader('Create Agent', 'Local runtime profile')}
    <form id="agent-form" class="modal-form">
      <label><span>Name</span><input name="name" placeholder="Builder Blue" required /></label>
      <label><span>Description</span><textarea name="description" rows="3"></textarea></label>
      <label><span>Runtime</span><select name="runtime"><option>Codex CLI</option><option>Claude Code</option><option>OpenCode</option><option>Goose</option></select></label>
      <label><span>Model</span><input name="model" placeholder="default" /></label>
      <label><span>Workspace</span><input name="workspace" value="${escapeHtml(appState.settings?.defaultWorkspace || '')}" /></label>
      <button class="primary-btn" type="submit">Create Agent</button>
    </form>
  `;
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
    render();
  });
  source.addEventListener('run-event', (event) => {
    const incoming = JSON.parse(event.data);
    if (!appState.events.some((item) => item.id === incoming.id)) {
      appState.events.push(incoming);
      render();
    }
  });
}

document.addEventListener('input', (event) => {
  if (event.target.id === 'search-input') {
    searchQuery = event.target.value;
    render();
    const input = document.querySelector('#search-input');
    input?.focus();
    input?.setSelectionRange(searchQuery.length, searchQuery.length);
  }
});

document.addEventListener('change', async (event) => {
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

  try {
    if (action === 'set-view') {
      activeView = target.dataset.view;
      threadMessageId = null;
      render();
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
      render();
    }
    if (action === 'close-modal') {
      modal = null;
      render();
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
      const result = await api('/api/channels', {
        method: 'POST',
        body: JSON.stringify({ name: data.get('name'), description: data.get('description') }),
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
      await api('/api/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: data.get('name'),
          description: data.get('description'),
          runtime: data.get('runtime'),
          model: data.get('model'),
          workspace: data.get('workspace'),
        }),
      });
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
