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

function channelAgentIsActive(agent) {
  if (typeof agentIsActiveInWorkspace === 'function') return agentIsActiveInWorkspace(agent);
  return !agent?.deletedAt && !agent?.archivedAt && agent?.status !== 'deleted' && agent?.status !== 'disabled';
}

function getChannelMembers(channelId) {
  const channel = byId(appState?.channels, channelId);
  if (!channel) return { agents: [], humans: [] };
  const humansInWorkspace = typeof workspaceHumans === 'function'
    ? workspaceHumans()
    : (appState.humans || []).filter((human) => human.status !== 'removed');
  // "All" channel always includes all agents and humans
  if (channelId === 'chan_all') {
    return {
      agents: (appState.agents || []).filter(channelAgentIsActive),
      humans: humansInWorkspace,
    };
  }
  const memberIds = [...new Set([...(channel.memberIds || []), ...(channel.humanIds || [])])];
  const humanIds = new Set(memberIds.filter((id) => String(id).startsWith('hum_')));
  const agents = (appState.agents || []).filter((a) => memberIds.includes(a.id) && channelAgentIsActive(a));
  const humans = [];
  const seenHumans = new Set();
  for (const id of humanIds) {
    const human = (typeof humanByIdAny === 'function' ? humanByIdAny(id) : null)
      || humansInWorkspace.find((item) => (
      item.id === id
      || item.cloudMemberId === id
      || item.authUserId === id
      || (id === 'hum_local' && typeof humanIsCurrent === 'function' && humanIsCurrent(item))
    )) || byId(appState.humans, id);
    if (!human) continue;
    const key = human.authUserId || human.email || human.id;
    if (seenHumans.has(key)) continue;
    seenHumans.add(key);
    humans.push(human);
  }
  return { agents, humans };
}

function renderSpace() {
  const space = currentSpace();
  if (!space) return renderHeader('No conversation', 'Local', '');
  if (selectedSpaceType === 'dm') {
    return `
      ${renderDmHeader()}
      <div class="tabbar dm-tabbar">
        <button class="${activeTab === 'chat' ? 'active' : ''}" type="button" data-action="set-tab" data-tab="chat">CHAT</button>
        <button class="${activeTab === 'tasks' ? 'active' : ''}" type="button" data-action="set-tab" data-tab="tasks">TASKS</button>
      </div>
      ${activeTab === 'tasks' ? renderDmTasks(spaceTasks()) : renderDmChat()}
    `;
  }
  const title = spaceName(selectedSpaceType, selectedSpaceId);
  const members = selectedSpaceType === 'channel' ? getChannelMembers(selectedSpaceId) : null;
  const memberCount = members ? members.agents.length + members.humans.length : 0;
  const isAllChannel = selectedSpaceType === 'channel' && selectedSpaceId === 'chan_all';
  const actions = selectedSpaceType === 'channel' ? `
    <button class="channel-action channel-action-icon-only channel-action-project" type="button" data-action="open-modal" data-modal="project" data-tooltip="Project folders" aria-label="Open project folders">${channelActionIcon('folder')}</button>
    <button class="channel-action channel-action-task" type="button" data-action="open-modal" data-modal="task" data-tooltip="Create task" aria-label="Create task">${channelActionIcon('task')}<span>Task</span></button>
    <button class="channel-action channel-action-icon-only channel-action-edit" type="button" data-action="open-modal" data-modal="edit-channel" data-tooltip="Edit channel" aria-label="Edit channel">${channelActionIcon('settings')}</button>
    ${isAllChannel ? '' : `<button class="channel-action channel-action-leave" type="button" data-action="leave-channel" data-tooltip="Leave channel" aria-label="Leave channel">${channelActionIcon('leave')}<span>Leave</span></button>`}
    <button class="channel-action channel-action-members" type="button" data-action="open-modal" data-modal="channel-members" data-tooltip="Members" aria-label="View ${memberCount} participants">${channelActionIcon('members')}<strong>${memberCount}</strong></button>
    <button class="channel-action channel-action-icon-only channel-action-danger" type="button" data-action="open-modal" data-modal="confirm-stop-all" data-tooltip="Stop All Agents - Stop all Agent actions in this channel (temporarily unavailable)" title="Stop All Agents - Stop all Agent actions in this channel (temporarily unavailable)" aria-label="Stop All Agents - Stop all Agent actions in this channel (temporarily unavailable)">${channelActionIcon('stop')}</button>
  ` : `
    <button class="channel-action channel-action-task" type="button" data-action="open-modal" data-modal="task" data-tooltip="Create task" aria-label="Create task">${channelActionIcon('task')}<span>Task</span></button>
    <button class="channel-action channel-action-icon-only channel-action-danger" type="button" data-action="open-modal" data-modal="confirm-stop-all" data-tooltip="Stop All Agents - Stop all Agent actions in this DM (temporarily unavailable)" title="Stop All Agents - Stop all Agent actions in this DM (temporarily unavailable)" aria-label="Stop All Agents - Stop all Agent actions in this DM (temporarily unavailable)">${channelActionIcon('stop')}</button>
  `;

  return `
    ${renderHeader(title, selectedSpaceType === 'channel' ? (space.description || 'Channel') : 'Direct mission link', actions)}
    <div class="tabbar">
      <button class="${activeTab === 'chat' ? 'active' : ''}" type="button" data-action="set-tab" data-tab="chat">CHAT</button>
      <button class="${activeTab === 'tasks' ? 'active' : ''}" type="button" data-action="set-tab" data-tab="tasks">TASKS</button>
    </div>
    ${selectedSpaceType === 'channel' ? renderProjectStrip() : ''}
    ${activeTab === 'tasks' ? renderTaskBoard(spaceTasks()) : renderChat()}
  `;
}

function renderDmHeader() {
  const peer = currentDmPeer();
  const name = peer?.item?.name || spaceName(selectedSpaceType, selectedSpaceId);
  const status = peer?.status || 'offline';
  const avatar = `
    <span class="dm-avatar-wrap dm-header-avatar">
      <span class="dm-avatar">${peer?.avatar ? `<img src="${escapeHtml(peer.avatar)}" alt="">` : escapeHtml(displayAvatar(peer?.item?.id || name, peer?.type || 'human'))}</span>
      ${avatarStatusDot(status, 'DM status')}
    </span>
  `;
  const copy = `
    <span class="dm-peer-copy">
      <strong>${escapeHtml(name)}</strong>
      <small>${escapeHtml(status)}</small>
    </span>
  `;
  const head = peer?.type === 'agent'
    ? `<button class="dm-peer-head dm-peer-button" type="button" data-action="select-agent" data-id="${escapeHtml(peer.item.id)}">${avatar}${copy}</button>`
    : `<div class="dm-peer-head">${avatar}${copy}</div>`;
  return `
    <header class="dm-space-header pixel-panel">
      ${head}
    </header>
  `;
}

function renderProjectStrip() {
  const projects = projectsForSpace();
  return `
    <section class="project-strip pixel-panel">
      <div class="project-strip-title">
        <span>Projects</span>
        <button type="button" data-action="open-modal" data-modal="project">Add Folder</button>
      </div>
      <div class="project-chip-row">
        ${projects.length ? projects.map((project) => `
          <span class="project-chip" title="${escapeHtml(project.path)}">
            <span class="project-chip-main">
              <span class="project-folder-badge">${folderIcon()}</span>
              <span class="project-chip-text">
                <strong class="project-chip-name">${escapeHtml(project.name)}</strong>
                <small class="project-chip-path" title="${escapeHtml(project.path)}">${escapeHtml(project.path)}</small>
              </span>
            </span>
            <button class="project-tree-btn" type="button" data-action="toggle-project-tree" data-project-id="${escapeHtml(project.id)}" data-path="" title="Browse ${escapeHtml(project.name)}" aria-label="Browse ${escapeHtml(project.name)}">${treeIcon()}</button>
            <button class="project-icon-btn danger-icon" type="button" data-action="remove-project" data-id="${escapeHtml(project.id)}" title="Remove ${escapeHtml(project.name)}" aria-label="Remove ${escapeHtml(project.name)}">${trashIcon()}</button>
          </span>
        `).join('') : '<span class="project-empty">No project folders linked to this channel.</span>'}
      </div>
      ${projects.length ? `<div class="project-tree-shell">${projects.map(renderProjectTreeRoot).join('')}</div>` : ''}
    </section>
  `;
}

function renderProjectTreeRoot(project) {
  if (!projectTreeIsExpanded(project.id)) return '';
  return `
    <div class="project-tree-block">
      <div class="project-tree-heading">
        <strong>${escapeHtml(project.name)}</strong>
        <small>${escapeHtml(project.path)}</small>
      </div>
      ${renderProjectTree(project, '', 0)}
    </div>
  `;
}

function renderProjectTree(project, relPath = '', depth = 0) {
  const key = projectTreeKey(project.id, relPath);
  const tree = projectTreeCache[key];
  if (!tree || tree.loading) {
    return '<div class="project-tree-note">Loading files...</div>';
  }
  if (tree.error) {
    return `<div class="project-tree-note error">${escapeHtml(tree.error)}</div>`;
  }
  if (!tree.entries?.length) {
    return '<div class="project-tree-note">Empty folder.</div>';
  }
  return `
    <div class="project-tree-list">
      ${tree.entries.map((entry) => {
        const isFolder = entry.kind === 'folder';
        const expanded = isFolder && projectTreeIsExpanded(project.id, entry.path);
        return `
          <div class="project-tree-node">
            <button
              type="button"
              class="project-tree-row ${isFolder ? 'is-folder' : 'is-file'} ${selectedProjectFile?.projectId === project.id && selectedProjectFile?.path === entry.path ? 'active' : ''}"
              style="--depth: ${depth}"
              data-action="${isFolder ? 'toggle-project-tree' : 'open-project-file'}"
              data-project-id="${escapeHtml(project.id)}"
              data-path="${escapeHtml(entry.path)}"
              title="${escapeHtml(entry.path)}"
            >
              <span class="project-tree-caret">${isFolder ? (expanded ? '▾' : '▸') : '·'}</span>
              <span class="project-tree-icon">${isFolder ? 'DIR' : 'FILE'}</span>
              <span class="project-tree-name">${escapeHtml(entry.name)}</span>
              ${!isFolder ? `<small>${bytes(entry.bytes || 0)}</small>` : ''}
            </button>
            ${isFolder && expanded ? renderProjectTree(project, entry.path, depth + 1) : ''}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderChat() {
  const messages = spaceMessages();
  const composerId = composerIdFor('message');
  return `
    <section class="chat-panel pixel-panel">
      <div class="message-area">
        <div class="message-list" id="message-list">
          ${messages.length ? messages.map(renderMessage).join('') : '<div class="empty-box">No messages here yet.</div>'}
        </div>
        ${backBottomButton('main', 'main-back-bottom')}
      </div>
      ${renderComposer({ id: composerId, kind: 'message', placeholder: `Message ${spaceName(selectedSpaceType, selectedSpaceId)}`, showTaskToggle: true })}
    </section>
  `;
}

function renderDmChat() {
  const messages = spaceMessages();
  const composerId = composerIdFor('message');
  return `
    <section class="chat-panel dm-chat-panel pixel-panel">
      <div class="message-area">
        <div class="message-list dm-message-list" id="message-list">
          ${messages.length ? messages.map(renderMessage).join('') : '<div class="dm-empty-state">No messages yet. Start the conversation!</div>'}
        </div>
        ${backBottomButton('main', 'main-back-bottom')}
      </div>
      ${renderComposer({ id: composerId, kind: 'message', placeholder: `Message ${spaceName(selectedSpaceType, selectedSpaceId)}`, showTaskToggle: true })}
    </section>
  `;
}

function renderDmTasks(tasks) {
  const visibleTasks = taskFilter === 'all' ? tasks : tasks.filter((task) => task.status === taskFilter);
  return `
    <section class="dm-task-view pixel-panel">
      <div class="dm-task-toolbar">
        <div class="dm-task-filters">
          ${[['all', 'All'], ...taskColumns].map(([status, label]) => `
            <button class="${taskFilter === status ? 'active' : ''}" type="button" data-action="task-filter" data-status="${status}">${escapeHtml(label)}</button>
          `).join('')}
        </div>
        <button class="primary-btn" type="button" data-action="open-modal" data-modal="task">+ New Task</button>
      </div>
      ${visibleTasks.length ? `<div class="dm-task-list">${visibleTasks.map(renderTaskCard).join('')}</div>` : '<div class="dm-task-empty">No tasks yet. Create one to get started!</div>'}
    </section>
  `;
}

function actorSubtitle(authorId, authorType, message) {
  if (authorType === 'agent') {
    const agent = byId(appState.agents, authorId);
    return agent?.description || agent?.runtime || 'Agent';
  }
  if (authorType === 'human') {
    const human = typeof humanByIdAny === 'function' ? humanByIdAny(authorId) : byId(appState.humans, authorId);
    const member = human && typeof cloudMemberForHuman === 'function' ? cloudMemberForHuman(human) : null;
    const role = member && typeof cloudMemberDisplayRole === 'function'
      ? cloudMemberDisplayRole(member)
      : human?.role || 'human';
    return String(role || 'human').toLowerCase();
  }
  return 'system';
}

function renderMentionChips(record) {
  const ids = [...(record.mentionedAgentIds || []), ...(record.mentionedHumanIds || [])];
  if (!ids.length) return '';
  return `
    <div class="mention-chip-row">
      ${ids.map((id) => {
        const item = byId(appState.agents, id) || byId(appState.humans, id);
        return item ? `<span class="mention-chip">@${escapeHtml(item.name)}</span>` : '';
      }).join('')}
    </div>
  `;
}

function agentReceiptStatus(item) {
  if (item?.status === 'stopped') return 'stopped';
  if (item?.respondedAt || item?.status === 'responded' || Number(item?.sendCount || 0) > 0) return 'responded';
  if (item?.deliveredAt || item?.status === 'delivered') return 'delivered';
  return 'queued';
}

function agentReceiptRank(status) {
  return { responded: 4, delivered: 3, queued: 2, stopped: 1 }[status] || 0;
}

function agentReceiptTime(item) {
  const parsed = Date.parse(item?.deliveredAt || item?.respondedAt || item?.updatedAt || item?.createdAt || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function deliveryReceiptItemsForRecord(record) {
  if (!record?.id) return [];
  const canShowReceipts = (record.authorType === 'human' && record.authorId === 'hum_local')
    || record.authorType === 'agent';
  if (!canShowReceipts) return [];
  const firstOrder = new Map();
  const byAgent = new Map();
  (appState?.workItems || [])
    .filter((item) => item?.sourceMessageId === record.id && item.agentId)
    .forEach((item, index) => {
      const agent = byId(appState?.agents, item.agentId);
      if (!agent) return;
      if (!firstOrder.has(item.agentId)) firstOrder.set(item.agentId, index);
      const status = agentReceiptStatus(item);
      const current = byAgent.get(item.agentId);
      const next = {
        agent,
        item,
        status,
        order: firstOrder.get(item.agentId),
      };
      if (!current) {
        byAgent.set(item.agentId, next);
        return;
      }
      const nextRank = agentReceiptRank(status);
      const currentRank = agentReceiptRank(current.status);
      if (nextRank > currentRank || (nextRank === currentRank && agentReceiptTime(item) >= agentReceiptTime(current.item))) {
        byAgent.set(item.agentId, { ...next, order: current.order });
      }
    });
  return [...byAgent.values()].sort((a, b) => a.order - b.order);
}

function deliveryReceiptSignature(record) {
  return deliveryReceiptItemsForRecord(record)
    .map((receipt) => [
      receipt.agent.id,
      receipt.agent.avatar || '',
      receipt.agent.status || '',
      receipt.status,
      receipt.item.deliveredAt || '',
      receipt.item.respondedAt || '',
      receipt.item.updatedAt || '',
      receipt.item.sendCount || 0,
    ].join(':'))
    .join('|');
}

function agentReceiptLabel(status) {
  return {
    responded: 'Responded',
    delivered: 'Received',
    queued: 'Pending',
    stopped: 'Stopped',
  }[status] || 'Pending';
}

function agentReceiptMeta(receipt) {
  if (receipt.status === 'responded') return receipt.item.respondedAt || receipt.item.updatedAt || receipt.item.deliveredAt || receipt.item.createdAt;
  if (receipt.status === 'delivered') return receipt.item.deliveredAt || receipt.item.updatedAt || receipt.item.createdAt;
  return receipt.item.updatedAt || receipt.item.createdAt;
}

function renderAgentReceiptAvatar(receipt, index, messageId) {
  const name = receipt.agent.name || displayName(receipt.agent.id);
  const label = `${name} / ${agentReceiptLabel(receipt.status)}`;
  const knownAgents = knownMessageReceipts.get(messageId) || new Set();
  const isNewAgent = initialLoadComplete && !knownAgents.has(receipt.agent.id);
  const animateClass = isNewAgent ? ' animate-in' : '';
  return `
    <span class="agent-receipt-avatar receipt-${escapeHtml(receipt.status)}${animateClass}" style="--receipt-index: ${index}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}" data-agent-id="${escapeHtml(receipt.agent.id)}">
      ${getAvatarHtml(receipt.agent.id, 'agent', 'agent-receipt-avatar-inner')}
    </span>
  `;
}

function renderAgentReceiptColumn(title, receipts) {
  return `
    <span class="agent-receipt-column">
      <strong>${escapeHtml(title)} <em>${receipts.length}</em></strong>
      <span class="agent-receipt-list">
        ${receipts.length ? receipts.map((receipt) => `
          <span class="agent-receipt-row receipt-${escapeHtml(receipt.status)}">
            ${getAvatarHtml(receipt.agent.id, 'agent', 'agent-receipt-row-avatar')}
            <span class="agent-receipt-row-main">
              <span>${escapeHtml(receipt.agent.name || displayName(receipt.agent.id))}</span>
              <small>${escapeHtml(agentReceiptLabel(receipt.status))} / ${escapeHtml(fmtTime(agentReceiptMeta(receipt)))}</small>
            </span>
          </span>
        `).join('') : '<span class="agent-receipt-empty">None</span>'}
      </span>
    </span>
  `;
}

function renderAgentReceiptPopover(receipts) {
  const received = receipts.filter((receipt) => receipt.status === 'delivered' || receipt.status === 'responded');
  const pending = receipts.filter((receipt) => receipt.status !== 'delivered' && receipt.status !== 'responded');
  return `
    <span class="agent-receipt-popover" role="tooltip">
      <span class="agent-receipt-popover-head">
        <span>Agent pickup</span>
        <strong>${received.length}/${receipts.length}</strong>
      </span>
      <span class="agent-receipt-columns">
        ${renderAgentReceiptColumn('Received', received)}
        ${renderAgentReceiptColumn('Pending', pending)}
      </span>
    </span>
  `;
}

function renderAgentReceiptTray(record) {
  const receipts = deliveryReceiptItemsForRecord(record);
  if (!receipts.length) return '';
  const hasOverflow = receipts.length > AGENT_RECEIPT_VISIBLE_LIMIT;
  const visibleLimit = hasOverflow ? AGENT_RECEIPT_VISIBLE_LIMIT - 1 : AGENT_RECEIPT_VISIBLE_LIMIT;
  const visible = receipts.slice(0, visibleLimit);
  const receivedCount = receipts.filter((receipt) => receipt.status === 'delivered' || receipt.status === 'responded').length;
  const label = `${receivedCount} of ${receipts.length} agents received this message`;

  // Determine which agents are new (for animation)
  const knownAgents = knownMessageReceipts.get(record.id) || new Set();
  const currentAgentIds = new Set(receipts.map((r) => r.agent.id));
  const hasNewAgents = receipts.some((r) => !knownAgents.has(r.agent.id));
  const overflowAnimateClass = hasNewAgents && !knownAgents.size ? ' animate-in' : '';

  // Update known agents after render
  setTimeout(() => {
    knownMessageReceipts.set(record.id, currentAgentIds);
  }, 0);

  return `
    <div class="agent-receipt-tray" data-message-id="${escapeHtml(record.id)}">
      <span class="agent-receipt-trigger">
        <button class="agent-receipt-button" type="button" aria-label="${escapeHtml(label)}" data-action="toggle-receipt-popover">
          <span class="agent-receipt-stack">
            ${visible.map((receipt, index) => renderAgentReceiptAvatar(receipt, index, record.id)).join('')}
            ${hasOverflow ? `<span class="agent-receipt-overflow${overflowAnimateClass}" style="--receipt-index: ${visible.length}" title="${escapeHtml(`${receipts.length - visible.length} more agents`)}" aria-label="${escapeHtml(`${receipts.length - visible.length} more agents`)}">...</span>` : ''}
          </span>
        </button>
        ${renderAgentReceiptPopover(receipts)}
      </span>
    </div>
  `;
}

function renderRecordKey(record) {
  const task = record?.taskId ? byId(appState?.tasks, record.taskId) : null;
  const author = record?.authorType === 'agent'
    ? byId(appState?.agents, record.authorId)
    : record?.authorType === 'human'
      ? byId(appState?.humans, record.authorId)
      : null;
  return JSON.stringify({
    id: record?.id || '',
    authorId: record?.authorId || '',
    authorType: record?.authorType || '',
    authorStatus: author?.status || '',
    body: record?.body || '',
    createdAt: record?.createdAt || '',
    updatedAt: record?.updatedAt || '',
    replyCount: record?.replyCount || 0,
    taskId: record?.taskId || '',
    taskStatus: task?.status || '',
    taskUpdatedAt: task?.updatedAt || '',
    attachmentIds: record?.attachmentIds || [],
    savedBy: record?.savedBy || [],
    receipts: deliveryReceiptSignature(record),
    highlighted: threadMessageId === record?.id || selectedSavedRecordId === record?.id,
  });
}

function renderSystemEvent(message) {
  return `
    <div class="system-event-row" id="message-${escapeHtml(message.id)}" data-message-id="${escapeHtml(message.id)}" data-render-key="${escapeHtml(renderRecordKey(message))}">
      <span>${parseMentions(plainActorText(message.body || ''))}</span>
      <time>${fmtTime(message.createdAt)}</time>
    </div>
  `;
}

function replyThreadIcon() {
  return '<svg class="message-action-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M21 15a3 3 0 0 1-3 3H8l-5 4V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3z"/></svg>';
}

function saveMessageIcon(saved = false) {
  return `<svg class="message-action-icon" width="14" height="14" viewBox="0 0 24 24" fill="${saved ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2.2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M6 4h12v17l-6-4-6 4z"/></svg>`;
}

function renderMessageActions(record, options = {}) {
  const saved = record.savedBy?.includes('hum_local');
  const threadContext = Boolean(options.threadContext || options.compact || record.parentMessageId);
  const saveLabel = saved ? 'Remove from saved' : 'Save message';
  return `
    <div class="message-hover-actions${threadContext ? ' thread-only' : ''}">
      ${threadContext ? '' : `
        <button class="message-icon-action" type="button" data-action="open-thread" data-id="${escapeHtml(record.id)}" title="Reply in thread" aria-label="Reply in thread">
          ${replyThreadIcon()}
        </button>
      `}
      <button class="message-icon-action${saved ? ' saved' : ''}" type="button" data-action="save-message" data-id="${escapeHtml(record.id)}" title="${escapeHtml(saveLabel)}" aria-label="${escapeHtml(saveLabel)}">
        ${saveMessageIcon(saved)}
      </button>
    </div>
  `;
}

function renderMessageFooter({ replyCountChip = '', receiptTray = '' } = {}) {
  if (!replyCountChip && !receiptTray) return '';
  return `
    <div class="message-footer${replyCountChip ? ' has-reply-chip' : ''}${receiptTray ? ' has-agent-receipt-tray' : ''}">
      ${replyCountChip}
      <span class="message-footer-fill"></span>
      ${receiptTray}
    </div>
  `;
}

function renderMessage(message, options = {}) {
  if (message.authorType === 'system' && message.eventType) return renderSystemEvent(message);
  const task = message.taskId ? byId(appState.tasks, message.taskId) : null;
  const replyCount = Number(message.replyCount || 0);
  const highlighted = threadMessageId === message.id || selectedSavedRecordId === message.id ? ' highlighted' : '';
  const compact = options.compact ? ' compact' : '';
  const authorClass = ['agent', 'human', 'system'].includes(message.authorType) ? message.authorType : 'unknown';
  const replyActionLabel = replyCount ? `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}` : 'Reply';
  const agentAuthorAttr = message.authorType === 'agent' ? ` data-agent-author-id="${escapeHtml(message.authorId)}"` : '';
  const receiptTray = renderAgentReceiptTray(message);
  const replyCountChip = !options.compact && replyCount ? `<button class="reply-count-chip" type="button" data-action="open-thread" data-id="${escapeHtml(message.id)}">${replyActionLabel}</button>` : '';
  const footer = renderMessageFooter({ replyCountChip, receiptTray });
  return `
    <article class="message-card magclaw-message author-${authorClass}${highlighted}${compact}${receiptTray ? ' has-agent-receipts' : ''}" id="message-${escapeHtml(message.id)}" data-message-id="${escapeHtml(message.id)}" data-render-key="${escapeHtml(renderRecordKey(message))}"${agentAuthorAttr}>
      ${renderActorAvatar(message.authorId, message.authorType)}
      <div class="message-body">
        <div class="message-meta">
          ${renderActorName(message.authorId, message.authorType)}
          <span class="sender-role">${escapeHtml(actorSubtitle(message.authorId, message.authorType, message))}</span>
          <time>${fmtTime(message.createdAt)}</time>
          ${task ? renderTaskInlineBadge(task) : ''}
        </div>
        <div class="message-markdown">${renderMarkdownWithMentions(message.body || '(attachment)')}</div>
        <div class="message-attachments">${attachmentLinks(message.attachmentIds)}</div>
        ${renderMessageActions(message, options)}
        ${footer}
      </div>
    </article>
  `;
}

function renderComposer({ id, kind, placeholder, showTaskToggle = false }) {
  const hasAttachments = stagedFor(id).attachments.length > 0;
  return `
    <form id="${kind === 'thread' ? 'reply-form' : 'message-form'}" class="chat-composer ${kind === 'thread' ? 'thread-composer' : ''}" data-composer-id="${escapeHtml(id)}">
      <div class="composer-attachments ${hasAttachments ? '' : 'hidden'}" data-attachment-strip="${escapeHtml(id)}">
        ${renderAttachmentStrip(id)}
      </div>
      <div class="composer-input-wrapper">
        <textarea name="body" rows="3" placeholder="${escapeHtml(placeholder)}" data-mention-input data-composer-id="${escapeHtml(id)}">${escapeHtml(composerDrafts[id] || '')}</textarea>
        ${mentionPopup.composerId === id ? renderMentionPopup() : ''}
      </div>
      <div class="composer-row">
        <label class="file-btn icon-btn small" title="Add attachment">
          <input class="composer-attachment-input" data-composer-id="${escapeHtml(id)}" type="file" multiple />
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="m21.4 11.6-8.5 8.5a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/></svg>
        </label>
        ${showTaskToggle ? `<label class="checkline"><input type="checkbox" name="asTask" ${composerTaskFlags[id] ? 'checked' : ''} /> As Task</label>` : '<span></span>'}
        <button class="primary-btn" type="submit">Send</button>
      </div>
    </form>
  `;
}

function renderTaskBoard(tasks) {
  return `
    <section class="task-board">
      ${taskColumns.map(([status, label]) => {
        const columnTasks = sortTasks(tasks.filter((task) => task.status === status));
        const collapsed = Boolean(collapsedTaskColumns[status]);
        return `
        <div class="task-column pixel-panel ${collapsed ? 'collapsed' : ''}">
          <div class="task-column-title">
            ${renderTaskColumnChip(status, label)}
            <strong>${columnTasks.length}</strong>
            <button class="column-toggle" type="button" data-action="toggle-task-column" data-status="${status}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${escapeHtml(label)}">${collapsed ? '›' : '⌄'}</button>
          </div>
          ${collapsed ? '' : `<div class="task-column-body">${columnTasks.map(renderTaskCard).join('') || '<div class="empty-box small task-empty-box">No tasks.</div>'}</div>`}
        </div>
      `;
      }).join('')}
    </section>
  `;
}

function renderTaskListView(tasks) {
  return `
    <section class="task-list-view">
      ${taskColumns.map(([status, label]) => {
        const sectionTasks = sortTasks(tasks.filter((task) => task.status === status));
        const collapsed = Boolean(collapsedTaskColumns[status]);
        return `
          <div class="task-list-section ${collapsed ? 'collapsed' : ''}">
            <div class="task-column-title task-list-title">
              ${renderTaskColumnChip(status, label)}
              <strong>${sectionTasks.length}</strong>
              <button class="column-toggle" type="button" data-action="toggle-task-column" data-status="${status}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${escapeHtml(label)}">${collapsed ? '›' : '⌄'}</button>
            </div>
            ${collapsed ? '' : `<div class="task-list-body">${sectionTasks.map(renderTaskCard).join('') || '<div class="empty-box small task-empty-box">No tasks.</div>'}</div>`}
          </div>
        `;
      }).join('')}
    </section>
  `;
}

function renderTaskViewToggle() {
  return `
    <div class="task-view-toggle" role="group" aria-label="Task view">
      <button class="${taskViewMode === 'board' ? 'active' : ''}" type="button" data-action="set-task-view" data-view="board">▥ Board</button>
      <button class="${taskViewMode === 'list' ? 'active' : ''}" type="button" data-action="set-task-view" data-view="list">☷ List</button>
    </div>
  `;
}

function renderTaskChannelFilter() {
  const channels = appState?.channels || [];
  const selectedCount = taskChannelFilterIds.length;
  return `
    <div class="task-channel-filter">
      <button class="task-channel-button ${selectedCount ? 'active' : ''}" type="button" data-action="toggle-task-channel-menu" aria-expanded="${taskChannelMenuOpen ? 'true' : 'false'}">
        <span>#</span>
        <strong>CHANNEL</strong>
        ${selectedCount ? `<em>${selectedCount}</em>` : ''}
        <span>⌄</span>
      </button>
      ${taskChannelMenuOpen ? `
        <div class="task-channel-menu pixel-panel">
          <div class="task-channel-menu-head">
            <span>CHANNELS</span>
            ${selectedCount ? '<button type="button" data-action="clear-task-channel-filters">CLEAR</button>' : ''}
          </div>
          ${channels.map((channel) => {
            const selected = taskChannelFilterIds.includes(channel.id);
            return `
              <button class="${selected ? 'selected' : ''}" type="button" data-action="toggle-task-channel-filter" data-id="${escapeHtml(channel.id)}">
                <span>#${escapeHtml(channel.name)}</span>
                ${selected ? '<strong>✓</strong>' : ''}
              </button>
            `;
          }).join('')}
        </div>
      ` : ''}
    </div>
  `;
}

function renderTaskToolbar(tasks, filteredTasks) {
  return `
    <div class="task-toolbar">
      ${renderTaskChannelFilter()}
      ${taskChannelFilterIds.length ? '<button class="secondary-btn task-clear-filter" type="button" data-action="clear-task-channel-filters">CLEAR ALL</button>' : ''}
      <span class="task-toolbar-count">${escapeHtml(taskCountLabel(tasks.length, filteredTasks.length))}</span>
    </div>
  `;
}

function renderTaskCard(task) {
  const assigneeIds = task.assigneeIds?.length ? task.assigneeIds : (task.assigneeId ? [task.assigneeId] : []);
  const assignee = assigneeIds.length ? assigneeIds.map(displayName).join(', ') : 'unassigned';
  const creator = task.createdBy ? displayName(task.createdBy) : 'Unknown';
  const thread = taskThreadMessage(task);
  const active = threadMessageId === thread?.id ? ' active' : '';
  return `
    <button class="task-card compact-task-card${active}" type="button" data-action="select-task" data-id="${escapeHtml(task.id)}">
      <div class="task-card-head">
        <span>${escapeHtml(spaceName(task.spaceType, task.spaceId))}</span>
        ${renderTaskInlineBadge(task, { showAssignee: false, hover: false })}
      </div>
      <strong class="task-card-title">${escapeHtml(plainMentionText(task.title || 'Untitled task'))}</strong>
      <div class="task-card-foot">
        <small>creator @${escapeHtml(creator)}</small>
        <small>assignee @${escapeHtml(assignee)}</small>
      </div>
    </button>
  `;
}

function renderTaskActionButtons(task, options = {}) {
  const canClaim = !taskIsClosedStatus(task.status) && !task.claimedBy;
  const canUnclaim = !taskIsClosedStatus(task.status) && Boolean(task.claimedBy);
  const canReview = task.status === 'in_progress' && Boolean(task.claimedBy);
  const canApprove = task.status === 'in_review';
  const canRun = !taskIsClosedStatus(task.status) && (!task.claimedBy || task.claimedBy === 'agt_codex');
  const includeThread = options.includeThread !== false;
  const thread = taskThreadMessage(task);
  return `
    ${canClaim ? `<button class="task-action-btn tone-claim" type="button" data-action="task-claim" data-id="${escapeHtml(task.id)}">Claim</button>` : ''}
    ${canUnclaim ? `<button class="task-action-btn tone-neutral" type="button" data-action="task-unclaim" data-id="${escapeHtml(task.id)}">Unclaim</button>` : ''}
    ${canRun ? `<button class="task-action-btn tone-run" type="button" data-action="run-task-codex" data-id="${escapeHtml(task.id)}">Run Codex</button>` : ''}
    ${canReview ? `<button class="task-action-btn tone-review" type="button" data-action="task-review" data-id="${escapeHtml(task.id)}">Review</button>` : ''}
    ${canApprove ? `<button class="task-action-btn tone-done" type="button" data-action="task-approve" data-id="${escapeHtml(task.id)}">Done</button>` : ''}
    ${taskIsClosedStatus(task.status) ? `<button class="task-action-btn tone-reopen" type="button" data-action="task-reopen" data-id="${escapeHtml(task.id)}">Reopen</button>` : ''}
    ${includeThread && thread ? `<button class="task-action-btn tone-thread" type="button" data-action="open-thread" data-id="${escapeHtml(thread.id)}">Thread</button>` : ''}
  `;
}

function renderTaskDetail(task) {
  const assigneeIds = task.assigneeIds?.length ? task.assigneeIds : (task.assigneeId ? [task.assigneeId] : []);
  const history = Array.isArray(task.history) ? task.history.slice().reverse() : [];
  const thread = taskThreadMessage(task);
  return `
    <section class="pixel-panel inspector-panel task-detail-panel">
      <div class="thread-head">
        <div>
          <strong>Task #${escapeHtml(task.number || shortId(task.id))}</strong>
          <span>${escapeHtml(spaceName(task.spaceType, task.spaceId))}</span>
        </div>
        <button class="icon-btn small" type="button" data-action="close-task-detail" aria-label="Close task detail">×</button>
      </div>
      <div class="task-detail-body">
        <div class="task-detail-status">
          ${renderTaskStatusBadge(task.status)}
          <span>${escapeHtml(task.claimedBy ? `claimed by ${displayName(task.claimedBy)}` : 'unclaimed')}</span>
        </div>
        ${renderTaskStateFlow(task)}
        <h3>${escapeHtml(plainMentionText(task.title || 'Untitled task'))}</h3>
        ${task.body ? `<div class="message-markdown task-detail-markdown">${renderMarkdownWithMentions(task.body)}</div>` : ''}
        <dl class="task-detail-meta">
          <div><dt>Creator</dt><dd>${escapeHtml(displayName(task.createdBy))}</dd></div>
          <div><dt>Assignee</dt><dd>${escapeHtml(assigneeIds.length ? assigneeIds.map(displayName).join(', ') : 'unassigned')}</dd></div>
          <div><dt>Thread</dt><dd>${thread ? `#${escapeHtml(shortId(thread.id))}` : 'missing'}</dd></div>
          <div><dt>Updated</dt><dd>${fmtTime(task.updatedAt || task.createdAt)}</dd></div>
        </dl>
        <div class="task-actions task-detail-actions">
          ${renderTaskActionButtons(task)}
        </div>
        <div class="history-list task-detail-history">
          ${history.length ? history.map((item) => `
            <div class="history-item">
              <strong>${escapeHtml(item.type)}</strong>
              <small>${fmtTime(item.createdAt)} / ${escapeHtml(displayName(item.actorId))}</small>
              <p>${escapeHtml(plainActorText(item.message))}</p>
            </div>
          `).join('') : '<div class="empty-box small">No task history.</div>'}
        </div>
      </div>
    </section>
  `;
}

function renderGlobalTasks() {
  const channelTasks = (appState.tasks || []).filter(isVisibleChannelTask);
  const filteredTasks = channelTasks.filter(taskMatchesChannelFilter);
  const subtitle = taskCountLabel(channelTasks.length, filteredTasks.length);
  return `
    <section class="task-page">
      <header class="task-page-header pixel-panel">
        <div class="task-page-title">
          <span class="task-page-icon">${channelActionIcon('task')}</span>
          <div>
            <h2>Tasks</h2>
            <small>${escapeHtml(subtitle)}</small>
          </div>
        </div>
        ${renderTaskViewToggle()}
      </header>
      ${renderTaskToolbar(channelTasks, filteredTasks)}
      ${taskViewMode === 'list' ? renderTaskListView(filteredTasks) : renderTaskBoard(filteredTasks)}
    </section>
  `;
}

function renderThreads() {
  const threaded = (appState.messages || [])
    .filter((message) => message.replyCount > 0 || message.taskId)
    .sort((a, b) => threadUpdatedAt(b) - threadUpdatedAt(a));
  return `
    ${renderHeader('Threads', 'Active reply trails', '')}
    <section class="list-panel thread-list-panel magclaw-thread-list">
      ${threaded.length ? threaded.map((message) => {
        const replies = threadReplies(message.id);
        const lastReply = replies.at(-1);
        const previewRecord = threadPreviewRecord(message);
        const author = displayName(message.authorId);
        const task = message.taskId ? byId(appState.tasks, message.taskId) : null;
        const active = threadMessageId === message.id ? ' active' : '';
        return `
        <button class="thread-row magclaw-thread-row${active}" type="button" data-action="open-thread" data-id="${message.id}">
          <span class="thread-row-avatar">
            ${renderThreadRowAvatar(previewRecord)}
          </span>
          <span class="thread-row-main">
            <span class="thread-row-meta-line">
              <span>${escapeHtml(spaceName(message.spaceType, message.spaceId))}</span>
              ${renderThreadKindBadge(message, task)}
              <span>${escapeHtml(author)}</span>
              <time>${fmtTime(lastReply?.createdAt || message.updatedAt || message.createdAt)}</time>
            </span>
            <strong>${escapeHtml(plainMentionText(message.body).slice(0, 120) || '(attachment)')}</strong>
            <small>${escapeHtml(threadPreviewText(message))}</small>
          </span>
          <span class="thread-row-side">
            <span>${message.replyCount || 0}</span>
            <span class="thread-row-check" title="Open thread">✓</span>
          </span>
        </button>
      `;
      }).join('') : '<div class="empty-box">No active threads.</div>'}
    </section>
  `;
}

function renderSaved() {
  const saved = savedRecords();
  return `
    <section class="saved-page">
      <header class="task-page-header saved-page-header pixel-panel">
        <div class="task-page-title">
          <span class="task-page-icon">${saveMessageIcon(true)}</span>
          <div>
            <h2>Saved</h2>
            <small>${saved.length} saved</small>
          </div>
        </div>
      </header>
      <section class="saved-list-panel pixel-panel">
        ${saved.length ? saved.map(renderSavedRecord).join('') : '<div class="empty-box">No saved messages.</div>'}
      </section>
    </section>
  `;
}

function renderSavedRecord(record) {
  const root = savedRecordThreadRoot(record);
  const isThreadRecord = Boolean(root);
  const task = (root?.taskId ? byId(appState.tasks, root.taskId) : null) || (record?.taskId ? byId(appState.tasks, record.taskId) : null);
  const active = selectedSavedRecordId === record.id ? ' active' : '';
  return `
    <div class="saved-row${active}">
      <button class="saved-row-open" type="button" data-action="open-saved-message" data-id="${escapeHtml(record.id)}">
        <span class="saved-avatar">${getAvatarHtml(record.authorId, record.authorType, 'avatar-inner')}</span>
        <span class="saved-row-body">
          <span class="saved-row-meta">
            <strong>${escapeHtml(recordSpaceName(record))}</strong>
            ${task ? renderTaskInlineBadge(task, { showAssignee: false }) : (isThreadRecord ? '<em>thread</em>' : '')}
            <span>${escapeHtml(displayName(record.authorId))}</span>
            <time>${fmtTime(record.createdAt)}</time>
          </span>
          <span class="saved-row-text">${escapeHtml(plainMentionText(record.body || '(attachment)'))}</span>
        </span>
      </button>
      <button class="saved-remove" type="button" data-action="remove-saved-message" data-id="${escapeHtml(record.id)}" title="Remove from saved" aria-label="Remove from saved">
        ${saveMessageIcon(true)}
      </button>
    </div>
  `;
}
