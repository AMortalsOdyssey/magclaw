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
  const allChannel = typeof isAllChannel === 'function'
    ? isAllChannel(channel)
    : (channel.id === 'chan_all' || String(channel.name || '').toLowerCase() === 'all');
  if (allChannel) {
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

function channelMemberIdSet(channel) {
  return new Set([
    ...(Array.isArray(channel?.memberIds) ? channel.memberIds : []),
    ...(Array.isArray(channel?.humanIds) ? channel.humanIds : []),
  ].map(String).filter(Boolean));
}

function currentUserIsChannelMember(channelOrId) {
  const channel = typeof channelOrId === 'string' ? byId(appState?.channels, channelOrId) : channelOrId;
  if (!channel) return false;
  if (isAllChannel(channel)) return true;
  const memberIds = channelMemberIdSet(channel);
  const currentKeys = typeof currentHumanIdentityKeys === 'function'
    ? currentHumanIdentityKeys()
    : new Set([currentHumanId()]);
  for (const key of currentKeys) {
    if (memberIds.has(String(key))) return true;
  }
  return false;
}

function currentChannelIsReadOnly() {
  return selectedSpaceType === 'channel' && !currentUserIsChannelMember(currentSpace());
}

function renderChannelJoinPanel(channelOrId, options = {}) {
  const channel = typeof channelOrId === 'string' ? byId(appState?.channels, channelOrId) : channelOrId;
  if (!channel || isAllChannel(channel)) return '';
  const label = options.thread ? `Join #${channel.name} to reply` : `Join #${channel.name}`;
  return `
    <div class="channel-join-panel${options.thread ? ' thread-join-panel' : ''}">
      <button class="primary-btn channel-join-btn" type="button" data-action="join-channel" data-id="${escapeHtml(channel.id)}">
        ${channelActionIcon('join')}<span>${escapeHtml(label)}</span>
      </button>
    </div>
  `;
}

function renderSpace() {
  const space = currentSpace();
  if (!space) return renderHeader('No conversation', 'MagClaw', '');
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
  const allChannelSelected = selectedSpaceType === 'channel' && isAllChannel(space);
  const canWriteChannel = selectedSpaceType !== 'channel' || currentUserIsChannelMember(space);
  const actions = selectedSpaceType === 'channel' ? `
    ${canWriteChannel ? `
	      <button class="channel-action channel-action-icon-only channel-action-project" type="button" data-action="open-modal" data-modal="project" data-tooltip="Project folders" aria-label="Open project folders">${channelActionIcon('folder')}</button>
	      <button class="channel-action channel-action-context" type="button" data-action="add-visible-conversation-context" data-tooltip="Add visible conversation to composer" aria-label="Add visible conversation to composer">${channelActionIcon('quote')}<span>Context</span></button>
	      <button class="channel-action channel-action-task" type="button" data-action="open-modal" data-modal="task" data-tooltip="Create task" aria-label="Create task">${channelActionIcon('task')}<span>Task</span></button>
      <button class="channel-action channel-action-icon-only channel-action-edit" type="button" data-action="open-modal" data-modal="edit-channel" data-tooltip="Edit channel" aria-label="Edit channel">${channelActionIcon('settings')}</button>
      ${allChannelSelected ? '' : `<button class="channel-action channel-action-leave" type="button" data-action="leave-channel" data-tooltip="Leave channel" aria-label="Leave channel">${channelActionIcon('leave')}<span>Leave</span></button>`}
    ` : ''}
    <button class="channel-action channel-action-members" type="button" data-action="open-modal" data-modal="channel-members" data-tooltip="Members" aria-label="View ${memberCount} participants">${channelActionIcon('members')}<strong>${memberCount}</strong></button>
    ${canWriteChannel ? `<button class="channel-action channel-action-icon-only channel-action-danger" type="button" data-action="open-modal" data-modal="confirm-stop-all" data-tooltip="Stop All Agents - Stop all Agent actions in this channel (temporarily unavailable)" title="Stop All Agents - Stop all Agent actions in this channel (temporarily unavailable)" aria-label="Stop All Agents - Stop all Agent actions in this channel (temporarily unavailable)">${channelActionIcon('stop')}</button>` : ''}
  ` : `
	    <button class="channel-action channel-action-context" type="button" data-action="add-visible-conversation-context" data-tooltip="Add visible conversation to composer" aria-label="Add visible conversation to composer">${channelActionIcon('quote')}<span>Context</span></button>
	    <button class="channel-action channel-action-task" type="button" data-action="open-modal" data-modal="task" data-tooltip="Create task" aria-label="Create task">${channelActionIcon('task')}<span>Task</span></button>
    <button class="channel-action channel-action-icon-only channel-action-danger" type="button" data-action="open-modal" data-modal="confirm-stop-all" data-tooltip="Stop All Agents - Stop all Agent actions in this DM (temporarily unavailable)" title="Stop All Agents - Stop all Agent actions in this DM (temporarily unavailable)" aria-label="Stop All Agents - Stop all Agent actions in this DM (temporarily unavailable)">${channelActionIcon('stop')}</button>
  `;

  return `
    ${renderHeader(title, selectedSpaceType === 'channel' ? (space.description || 'Channel') : 'Direct mission link', actions)}
    <div class="tabbar">
      <button class="${activeTab === 'chat' ? 'active' : ''}" type="button" data-action="set-tab" data-tab="chat">CHAT</button>
      <button class="${activeTab === 'tasks' ? 'active' : ''}" type="button" data-action="set-tab" data-tab="tasks">TASKS</button>
    </div>
    ${selectedSpaceType === 'channel' ? renderProjectStrip({ canWrite: canWriteChannel }) : ''}
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

function renderProjectStrip(options = {}) {
  const projects = projectsForSpace();
  const canWrite = options.canWrite !== false;
  return `
    <section class="project-strip pixel-panel">
      <div class="project-strip-title">
        <span>Projects</span>
        ${canWrite ? '<button type="button" data-action="open-modal" data-modal="project">Add Folder</button>' : ''}
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
  const readOnlyChannel = currentChannelIsReadOnly();
  const pageInfo = typeof currentMainHistoryPage === 'function' ? currentMainHistoryPage() : null;
  const historyMarker = pageInfo?.hasMore ? '<div class="history-page-status" data-history-target="main">Scroll up for earlier messages</div>' : '';
  return `
    <section class="chat-panel pixel-panel">
      <div class="message-area">
        <div class="message-list" id="message-list">
          ${historyMarker}
          ${messages.length ? messages.map(renderMessage).join('') : '<div class="empty-box">No messages here yet.</div>'}
        </div>
        ${backBottomButton('main', 'main-back-bottom')}
      </div>
      ${readOnlyChannel
        ? renderChannelJoinPanel(selectedSpaceId)
        : renderComposer({ id: composerId, kind: 'message', placeholder: `Message ${spaceName(selectedSpaceType, selectedSpaceId)}`, showTaskToggle: true })}
    </section>
  `;
}

function renderDmChat() {
  const messages = spaceMessages();
  const composerId = composerIdFor('message');
  const pageInfo = typeof currentMainHistoryPage === 'function' ? currentMainHistoryPage() : null;
  const historyMarker = pageInfo?.hasMore ? '<div class="history-page-status" data-history-target="main">Scroll up for earlier messages</div>' : '';
  return `
    <section class="chat-panel dm-chat-panel pixel-panel">
      <div class="message-area">
        <div class="message-list dm-message-list" id="message-list">
          ${historyMarker}
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

function agentSubtitle(agent) {
  if (!agent) return 'Agent';
  const runtime = typeof runtimeConfigurationLabel === 'function'
    ? runtimeConfigurationLabel(agent)
    : (agent.runtime || 'Agent');
  const description = String(agent.description || '').trim();
  return description && runtime
    ? `${description} · ${runtime}`
    : (description || runtime || 'Agent');
}

function actorSubtitle(authorId, authorType, message) {
  if (authorType === 'agent') {
    const agent = byId(appState.agents, authorId);
    return agentSubtitle(agent);
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
  const human = record.authorType === 'human'
    ? (typeof humanByIdAny === 'function' ? humanByIdAny(record.authorId) : byId(appState?.humans, record.authorId))
    : null;
  const canShowReceipts = (record.authorType === 'human' && (
    record.authorId === 'hum_local'
    || record.authorId === currentHumanId()
    || humanMatchesCurrentAccount(human || { id: record.authorId })
  ))
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

function messageReactionOption(key) {
  return MAGCLAW_MESSAGE_REACTIONS.find((reaction) => reaction.key === key) || null;
}

function normalizedMessageReactions(record) {
  const seen = new Set();
  return (Array.isArray(record?.reactions) ? record.reactions : [])
    .map((reaction) => {
      const option = messageReactionOption(reaction?.key) || MAGCLAW_MESSAGE_REACTIONS.find((item) => item.emoji === reaction?.emoji) || null;
      const key = option?.key || String(reaction?.key || '').trim();
      return {
        key,
        emoji: option?.emoji || String(reaction?.emoji || '').trim(),
        actorId: String(reaction?.actorId || '').trim(),
        actorType: String(reaction?.actorType || 'human').trim() || 'human',
        actorName: String(reaction?.actorName || '').trim(),
        createdAt: reaction?.createdAt || '',
      };
    })
    .filter((reaction) => reaction.key && reaction.emoji && reaction.actorId)
    .filter((reaction) => {
      const signature = `${reaction.key}:${reaction.actorType}:${reaction.actorId}`;
      if (seen.has(signature)) return false;
      seen.add(signature);
      return true;
    });
}

function reactionActorName(reaction) {
  if (reaction.actorName) return reaction.actorName;
  return displayName(reaction.actorId) || reaction.actorId;
}

function groupedMessageReactions(record) {
  const groups = new Map();
  for (const reaction of normalizedMessageReactions(record)) {
    const group = groups.get(reaction.key) || {
      key: reaction.key,
      emoji: reaction.emoji,
      actors: [],
      currentUserReacted: false,
    };
    group.actors.push(reaction);
    if (reaction.actorId === currentHumanId()) group.currentUserReacted = true;
    groups.set(reaction.key, group);
  }
  return [...groups.values()].sort((a, b) => {
    const ai = MAGCLAW_MESSAGE_REACTIONS.findIndex((reaction) => reaction.key === a.key);
    const bi = MAGCLAW_MESSAGE_REACTIONS.findIndex((reaction) => reaction.key === b.key);
    return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
  });
}

function renderMessageReactionTray(record) {
  const groups = groupedMessageReactions(record);
  if (!groups.length) return '';
  return `
    <div class="message-reaction-tray" aria-label="Message reactions">
      ${groups.map((group) => {
        const names = group.actors.map(reactionActorName).join(', ');
        return `
          <button class="message-reaction-chip${group.currentUserReacted ? ' reacted' : ''}" type="button"
            data-action="toggle-message-reaction"
            data-id="${escapeHtml(record.id)}"
            data-reaction-key="${escapeHtml(group.key)}"
            title="${escapeHtml(names)}"
            aria-label="${escapeHtml(`${group.emoji} reaction from ${names}`)}">
            <span>${escapeHtml(group.emoji)}</span>
            <strong>${group.actors.length}</strong>
          </button>
        `;
      }).join('')}
    </div>
  `;
}

const SHARE_MESSAGE_SELECTION_LIMIT = 100;
const SHARE_IMAGE_RENDER_MIN_MS = 240;

function shareSelectionLimitMessage() {
  return `You can select up to ${SHARE_MESSAGE_SELECTION_LIMIT} messages.`;
}

function shareSelectedIds() {
  const seen = new Set();
  return (Array.isArray(messageShareState.selectedIds) ? messageShareState.selectedIds : [])
    .map(String)
    .filter((id) => {
      if (!id || seen.has(id)) return false;
      seen.add(id);
      return true;
    })
    .slice(0, SHARE_MESSAGE_SELECTION_LIMIT);
}

function emptyMessageShareState() {
  return { active: false, selectedIds: [], scope: 'all', threadRootId: '' };
}

function normalizedMessageShareState(next = {}) {
  const selectedIds = [...new Set((Array.isArray(next.selectedIds) ? next.selectedIds : [])
    .map(String)
    .filter(Boolean))]
    .slice(0, SHARE_MESSAGE_SELECTION_LIMIT);
  const scope = next.scope === 'thread' && next.threadRootId ? 'thread' : 'all';
  return {
    active: Boolean(next.active && selectedIds.length),
    selectedIds,
    scope,
    threadRootId: scope === 'thread' ? String(next.threadRootId || '') : '',
  };
}

function messageShareStateForRecord(record) {
  if (!record?.id) return emptyMessageShareState();
  const root = messageThreadRoot(record);
  const threadRootId = root?.id || '';
  const isThreadScope = Boolean(
    threadRootId
    && (record.parentMessageId || threadMessageId === threadRootId)
  );
  return normalizedMessageShareState({
    active: true,
    selectedIds: [record.id],
    scope: isThreadScope ? 'thread' : 'all',
    threadRootId: isThreadScope ? threadRootId : '',
  });
}

function recordMatchesShareScope(record) {
  if (!record?.id) return false;
  if (messageShareState.scope !== 'thread') return true;
  const threadRootId = String(messageShareState.threadRootId || '');
  return Boolean(threadRootId && (String(record.id) === threadRootId || String(record.parentMessageId || '') === threadRootId));
}

function shareSelectableRecords() {
  if (messageShareState.scope === 'thread') {
    const threadRootId = String(messageShareState.threadRootId || '');
    const root = byId(appState?.messages, threadRootId);
    if (!root) return [];
    return [root, ...threadReplies(threadRootId)].filter((record) => recordMatchesShareScope(record));
  }
  return [...(appState?.messages || []), ...(appState?.replies || [])];
}

function shareSelectAllTargetIds() {
  return shareSelectableRecords().slice(0, SHARE_MESSAGE_SELECTION_LIMIT)
    .map((record) => String(record?.id || ''))
    .filter(Boolean);
}

function shareAllSelectableMessagesSelected() {
  const targetIds = shareSelectAllTargetIds();
  if (!targetIds.length) return false;
  const selected = new Set(shareSelectedIds());
  return targetIds.every((id) => selected.has(id));
}

function normalizeShareReplacementEntry(value) {
  if (value === null || value === undefined) return [];
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = plainMentionText(String(value)).trim();
    return text ? [text] : [];
  }
  if (Array.isArray(value)) return value.flatMap(normalizeShareReplacementEntry);
  if (typeof value !== 'object') return [];
  const direct = value.text ?? value.content ?? value.body ?? value.value ?? null;
  if (direct !== null && direct !== undefined) return normalizeShareReplacementEntry(direct);
  const nested = value.replace ?? value.replacement ?? value.replaceContent ?? value.replacementContent ?? null;
  if (nested !== null && nested !== undefined) return normalizeShareReplacementEntry(nested);
  const before = value.before ?? value.old ?? value.from ?? null;
  const after = value.after ?? value.new ?? value.to ?? null;
  if (before !== null || after !== null) {
    const beforeText = plainMentionText(String(before ?? '')).trim();
    const afterText = plainMentionText(String(after ?? '')).trim();
    const text = [beforeText, afterText].filter(Boolean).join(' -> ');
    return text ? [text] : [];
  }
  return [];
}

function shareReplacementLines(record) {
  const metadata = record?.metadata && typeof record.metadata === 'object' ? record.metadata : {};
  const state = metadata.state && typeof metadata.state === 'object' ? metadata.state : {};
  const sources = [
    record?.replace,
    record?.replacement,
    record?.replacements,
    record?.replaceContent,
    record?.replacementContent,
    metadata.replace,
    metadata.replacement,
    metadata.replacements,
    metadata.replaceContent,
    metadata.replacementContent,
    state.replace,
    state.replacement,
    state.replacements,
    state.replaceContent,
    state.replacementContent,
  ];
  const seen = new Set();
  return sources.flatMap(normalizeShareReplacementEntry)
    .filter((line) => {
      if (!line || seen.has(line)) return false;
      seen.add(line);
      return true;
    })
    .map((line) => `Replace: ${line}`);
}

function shareRecordPlainText(record) {
  const body = plainMentionText(record?.body || '').trim();
  const replacementLines = shareReplacementLines(record);
  const lines = [
    body,
    ...replacementLines,
  ].filter(Boolean);
  return lines.length ? lines.join('\n') : '(attachment)';
}

function shareSelectionRecords() {
  const selected = new Set(shareSelectedIds());
  const source = messageShareState.scope === 'thread' ? shareSelectableRecords() : [...(appState?.messages || []), ...(appState?.replies || [])];
  const records = source.filter((record) => selected.has(String(record?.id || '')));
  if (messageShareState.scope === 'thread') return records;
  return records.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
}

function shareBodyToggleAttrs(record, { selectable = messageShareState.active && recordMatchesShareScope(record) } = {}) {
  if (!selectable) return '';
  return ` data-action="toggle-share-selection" data-id="${escapeHtml(record.id)}" data-share-body-toggle="1"`;
}

function renderShareSelector(record, { selectable = messageShareState.active && recordMatchesShareScope(record) } = {}) {
  if (!selectable) return '';
  const selected = shareSelectedIds().includes(String(record.id));
  return `
    <button class="message-share-selector${selected ? ' selected' : ''}" type="button"
      data-action="toggle-share-selection"
      data-id="${escapeHtml(record.id)}"
      aria-label="${escapeHtml(t(selected ? 'Deselect message' : 'Select message'))}">
      <span>${selected ? '✓' : ''}</span>
    </button>
  `;
}

function contextMenuRecord() {
  return messageContextMenu?.recordId ? conversationRecord(messageContextMenu.recordId) : null;
}

function messageThreadRoot(record) {
  if (!record) return null;
  return record.parentMessageId ? byId(appState?.messages, record.parentMessageId) : record;
}

function messageRecordLink(record) {
  if (!record) return '';
  const root = messageThreadRoot(record) || record;
  const spaceType = root.spaceType || record.spaceType || selectedSpaceType || 'channel';
  const spaceId = root.spaceId || record.spaceId || selectedSpaceId || '';
  const kind = spaceType === 'dm' ? 'dms' : 'channels';
  const slug = encodeURIComponent(currentServerSlug());
  const url = new URL(`/s/${slug}/${kind}/${encodeURIComponent(spaceId)}`, window.location.origin);
  if (record.parentMessageId) url.searchParams.set('threadMessageId', root.id);
  url.hash = record.parentMessageId ? `reply-${record.id}` : `message-${record.id}`;
  return url.toString();
}

function attachmentMarkdownLines(record) {
  return (record?.attachmentIds || [])
    .map((id) => byId(appState?.attachments, id))
    .filter(Boolean)
    .map((attachment) => `- Attachment: ${attachment.filename || attachment.name || attachment.id}`);
}

function messageRecordMarkdown(record) {
  if (!record) return '';
  const root = messageThreadRoot(record) || record;
  const surface = spaceName(root.spaceType || record.spaceType, root.spaceId || record.spaceId);
  const author = displayName(record.authorId) || record.authorId || 'Unknown';
  const body = shareRecordPlainText(record);
  const lines = [
    `**${author}** · ${surface} · ${fmtTime(record.createdAt)}`,
    '',
    body,
    ...attachmentMarkdownLines(record),
  ];
  return lines.filter((line, index) => line || index < 2).join('\n');
}

function selectedMessagesMarkdown() {
  return shareSelectionRecords().map(messageRecordMarkdown).join('\n\n---\n\n');
}

function renderMessageReactionGrid(record) {
  if (!record) return '';
  const active = new Set(normalizedMessageReactions(record)
    .filter((reaction) => reaction.actorId === currentHumanId())
    .map((reaction) => reaction.key));
  return `
    <div class="message-reaction-grid" role="group" aria-label="Add reaction">
      ${MAGCLAW_MESSAGE_REACTIONS.map((reaction) => `
        <button class="${active.has(reaction.key) ? 'active' : ''}" type="button"
          data-action="toggle-message-reaction"
          data-id="${escapeHtml(record.id)}"
          data-reaction-key="${escapeHtml(reaction.key)}"
          title="${escapeHtml(reaction.label)}"
          aria-label="${escapeHtml(reaction.label)}">${escapeHtml(reaction.emoji)}</button>
      `).join('')}
    </div>
  `;
}

function renderContextMenuItem(action, label, recordId, extra = {}) {
  const attrs = Object.entries(extra)
    .map(([key, value]) => ` data-${escapeHtml(key)}="${escapeHtml(value)}"`)
    .join('');
  return `<button type="button" data-action="${escapeHtml(action)}" data-id="${escapeHtml(recordId)}"${attrs}>${escapeHtml(label)}</button>`;
}

function renderMessageContextMenu() {
  const record = contextMenuRecord();
  if (!record || !messageContextMenu) return '';
  const scope = messageContextMenu.scope === 'saved' ? 'saved' : 'message';
  const root = messageThreadRoot(record);
  const saved = (record.savedBy || []).map(String).includes(currentHumanId());
  const followed = (root?.followedBy || []).map(String).includes(currentHumanId());
  const left = Number.isFinite(messageContextMenu.x) ? messageContextMenu.x : 120;
  const top = Number.isFinite(messageContextMenu.y) ? messageContextMenu.y : 120;
  const positionStyle = `--menu-x: ${Math.max(8, left)}px; --menu-y: ${Math.max(8, top)}px;`;
	  if (scope === 'saved') {
    return `
      <div class="message-context-menu pixel-panel" data-context-scope="saved" style="${positionStyle}" role="menu">
        ${renderContextMenuItem('copy-message-link', 'Copy link', record.id)}
        ${renderContextMenuItem('copy-message-markdown', 'Copy markdown', record.id)}
        <div class="message-menu-separator"></div>
        ${renderContextMenuItem('remove-saved-message', 'Remove from saved', record.id)}
      </div>
    `;
	  }
	  if (messageContextMenu.selectionText) {
	    return `
	      <div class="message-context-menu pixel-panel selection-menu" data-context-scope="selection" style="${positionStyle}" role="menu">
	        ${renderContextMenuItem('quote-selected-text', '引用到', record.id)}
	        ${renderContextMenuItem('add-selected-text-context', '添加到对话', record.id)}
	        ${renderContextMenuItem('copy-selected-message-text', 'Copy', record.id)}
	      </div>
	    `;
	  }
	  const threadLabel = record.parentMessageId ? 'View in channel' : 'Open thread';
  const threadAction = record.parentMessageId ? 'view-in-channel' : 'open-thread';
  const threadId = record.parentMessageId ? root?.id || record.parentMessageId : record.id;
  return `
    <div class="message-context-menu pixel-panel" data-context-scope="message" style="${positionStyle}" role="menu">
	      ${renderMessageReactionGrid(record)}
	      <div class="message-menu-separator"></div>
	      ${renderContextMenuItem('quote-message-reply', '引用消息回复', record.id)}
	      ${renderContextMenuItem('add-message-context', '添加到对话', record.id)}
	      ${root ? renderContextMenuItem('add-thread-context', 'Add thread to conversation', record.id) : ''}
	      <div class="message-menu-separator"></div>
	      ${renderContextMenuItem('copy-message-link', 'Copy link', record.id)}
      ${renderContextMenuItem('copy-message-markdown', 'Copy markdown', record.id)}
      <button type="button" data-action="start-message-share" data-id="${escapeHtml(record.id)}">Share messages...</button>
      <div class="message-menu-separator"></div>
      ${threadId ? renderContextMenuItem(threadAction, threadLabel, threadId) : ''}
      ${renderContextMenuItem(saved ? 'remove-saved-message' : 'save-message', saved ? 'Remove from saved' : 'Save message', record.id)}
      ${root ? renderContextMenuItem('toggle-thread-follow', followed ? 'Unfollow Thread' : 'Follow Thread', record.id) : ''}
      ${record.parentMessageId ? '' : '<div class="message-menu-separator"></div>'}
      ${record.parentMessageId ? '' : renderContextMenuItem('message-task', 'Convert to Task', record.id)}
    </div>
  `;
}

function renderShareSelectionBar() {
  if (!messageShareState.active) return '';
  const count = shareSelectedIds().length;
  const threadMode = messageShareState.scope === 'thread';
  const selectableCount = threadMode ? shareSelectableRecords().length : 0;
  const allSelectableSelected = shareAllSelectableMessagesSelected();
  const selectAllLabel = allSelectableSelected ? 'Deselect all' : 'Select all';
  const selectAllAria = allSelectableSelected ? 'Deselect all thread messages' : 'Select all thread messages';
  return `
    <div class="share-selection-bar" role="status" aria-live="polite">
      <strong>${escapeHtml(t(`${count} selected`))}</strong>
      <div class="share-selection-actions">
        ${threadMode ? `<button type="button" data-action="toggle-share-select-all" ${selectableCount ? '' : 'disabled'} aria-label="${escapeHtml(t(selectAllAria))}">${escapeHtml(t(selectAllLabel))}</button>` : ''}
        <button type="button" data-action="cancel-message-share" aria-label="${escapeHtml(t('Cancel'))}">${escapeHtml(t('Cancel'))}</button>
	        <button class="share-image-action" type="button" data-action="download-selected-image" ${count ? '' : 'disabled'} aria-label="${escapeHtml(t('Download as image'))}">${escapeHtml(t('Download as image'))}</button>
	        <button type="button" data-action="add-selected-messages-context" ${count ? '' : 'disabled'} aria-label="${escapeHtml(t('Add to conversation'))}">${escapeHtml(t('Add to conversation'))}</button>
	        <button type="button" data-action="copy-selected-markdown" ${count ? '' : 'disabled'} aria-label="${escapeHtml(t('Copy as Markdown'))}">${escapeHtml(t('Copy as Markdown'))}</button>
      </div>
    </div>
  `;
}

function renderSharePreviewModal() {
  if (!sharePreviewState.open) return '';
  const previewLabel = escapeHtml(t('Share preview'));
  return `
    <div class="modal-backdrop share-preview-backdrop">
      <section class="modal-card pixel-panel share-preview-modal" role="dialog" aria-modal="true" aria-label="${previewLabel}">
        <div class="modal-head">
          <h2>${previewLabel}</h2>
          <button class="icon-btn small" type="button" data-action="close-share-preview" aria-label="${escapeHtml(t('Close'))}">×</button>
        </div>
        <div class="share-preview-frame">
          ${sharePreviewState.imageUrl ? `<img src="${escapeHtml(sharePreviewState.imageUrl)}" alt="${previewLabel}" />` : `
            <div class="share-preview-loading" role="status" aria-live="polite">
              <span class="share-preview-spinner" aria-hidden="true"></span>
              <strong>${escapeHtml(t('Rendering...'))}</strong>
            </div>
          `}
        </div>
        <div class="modal-actions">
          <button class="secondary-btn" type="button" data-action="close-share-preview">${escapeHtml(t('Cancel'))}</button>
          <button class="primary-btn" type="button" data-action="save-share-image" ${sharePreviewState.imageUrl ? '' : 'disabled'}>${escapeHtml(t('Save image'))}</button>
        </div>
      </section>
    </div>
  `;
}

function renderMessageInteractionOverlays() {
  return `
    ${renderMessageContextMenu()}
    ${renderShareSelectionBar()}
    ${renderSharePreviewModal()}
  `;
}

function wrapCanvasText(ctx, text, maxWidth) {
  const value = String(text || '');
  const words = value.includes(' ') ? value.split(/\s+/) : [...value];
  const lines = [];
  let line = '';
  for (const word of words) {
    const glue = value.includes(' ') && line ? ' ' : '';
    const candidate = `${line}${glue}${word}`;
    if (line && ctx.measureText(candidate).width > maxWidth) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function fitCanvasText(ctx, text, maxWidth) {
  const value = String(text || '').trim();
  if (!value || ctx.measureText(value).width <= maxWidth) return value;
  let next = value;
  while (next.length > 1 && ctx.measureText(`${next}...`).width > maxWidth) {
    next = next.slice(0, -1);
  }
  return `${next || value.slice(0, 1)}...`;
}

function shareInlineTokenRuns(text = '') {
  const value = String(text || '');
  const pattern = /(https?:\/\/[^\s<>()]+|@[^\s,，.。;；:：!?！？()\[\]{}]+|#[^\s,，.。;；:：!?！？()\[\]{}]+)/g;
  const tokens = [];
  let lastIndex = 0;
  for (const match of value.matchAll(pattern)) {
    if (match.index > lastIndex) tokens.push({ type: 'text', text: value.slice(lastIndex, match.index) });
    const raw = match[0];
    const type = raw.startsWith('http') ? 'link' : raw.startsWith('@') ? 'mention' : (/^#\d+$/.test(raw) ? 'task' : 'channel');
    tokens.push({ type, text: raw });
    lastIndex = match.index + raw.length;
  }
  if (lastIndex < value.length) tokens.push({ type: 'text', text: value.slice(lastIndex) });
  return tokens.filter((token) => token.text);
}

function drawShareInlineText(ctx, text, x, y, maxWidth) {
  const tokens = shareInlineTokenRuns(text);
  let cursor = x;
  for (const token of tokens) {
    const label = token.text;
    const textWidth = ctx.measureText(label).width;
    const tokenWidth = token.type === 'text' || token.type === 'link' ? textWidth : textWidth + 8;
    if (cursor + tokenWidth > x + maxWidth + 4) break;
    if (token.type === 'text') {
      ctx.fillStyle = '#111111';
      ctx.fillText(label, cursor, y);
      cursor += textWidth;
      continue;
    }
    if (token.type === 'link') {
      ctx.fillStyle = '#1269B7';
      ctx.fillText(label, cursor, y);
      ctx.strokeStyle = '#1269B7';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cursor, y + 2);
      ctx.lineTo(cursor + textWidth, y + 2);
      ctx.stroke();
      cursor += textWidth;
      continue;
    }
    const background = token.type === 'mention' ? '#FFE1F0' : token.type === 'task' ? '#FFE7A8' : '#FFE15A';
    const textColor = token.type === 'mention' ? '#4A1032' : '#1A1A1A';
    ctx.fillStyle = background;
    ctx.fillRect(cursor, y - 14, tokenWidth, 18);
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 1;
    ctx.strokeRect(cursor, y - 14, tokenWidth, 18);
    ctx.fillStyle = textColor;
    ctx.fillText(label, cursor + 4, y);
    cursor += tokenWidth;
  }
}

function shareReactionChipRows(ctx, groups = [], maxWidth = 0) {
  const chips = groups.map((group) => {
    const label = `${group.emoji} ${group.actors.length}`;
    return {
      label,
      width: Math.ceil(ctx.measureText(label).width) + 18,
    };
  });
  const rows = [];
  let row = [];
  let rowWidth = 0;
  for (const chip of chips) {
    const gap = row.length ? 6 : 0;
    if (row.length && rowWidth + gap + chip.width > maxWidth) {
      rows.push(row);
      row = [chip];
      rowWidth = chip.width;
    } else {
      row.push(chip);
      rowWidth += gap + chip.width;
    }
  }
  if (row.length) rows.push(row);
  return rows;
}

function shareImageFileName(date = new Date()) {
  return `magclaw-share-${date.toISOString().slice(0, 19).replace(/:/g, '-')}.png`;
}

function shareCanvasImageSource(src) {
  const value = String(src || '').trim();
  if (!value) return '';
  if (value.startsWith('data:image/')) return value;
  try {
    const url = new URL(value, window.location.href);
    return url.origin === window.location.origin ? url.href : '';
  } catch {
    return '';
  }
}

function shareAvatarProxyUrl(src) {
  const value = String(src || '').trim();
  if (!value) return '';
  try {
    const url = new URL(value, window.location.href);
    if (!['http:', 'https:'].includes(url.protocol) || url.origin === window.location.origin) return '';
    return `/api/share-images/avatar?src=${encodeURIComponent(url.href)}`;
  } catch {
    return '';
  }
}

function wrapShareRecordText(ctx, text, maxWidth) {
  const lines = [];
  for (const rawLine of String(text || '').split(/\n+/)) {
    lines.push(...wrapCanvasText(ctx, rawLine, maxWidth));
  }
  return lines.length ? lines : [''];
}

function loadCanvasImage(src) {
  const safeSrc = shareCanvasImageSource(src) || shareAvatarProxyUrl(src);
  if (!safeSrc) return Promise.resolve(null);
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = safeSrc;
  });
}

function shareActorProfile(record) {
  const id = record?.authorId || 'system';
  const type = record?.authorType || 'unknown';
  const agent = type === 'agent' ? byId(appState?.agents, id) : null;
  const human = type === 'human'
    ? (typeof humanByIdAny === 'function' ? humanByIdAny(id) : byId(appState?.humans, id))
    : null;
  const avatar = type === 'system'
    ? BRAND_LOGO_SRC
    : (agent?.avatar || agent?.avatarUrl || human?.avatar || human?.avatarUrl || '');
  return {
    id,
    type,
    name: displayName(id),
    subtitle: actorSubtitle(id, type, record),
    initials: displayAvatar(id, type),
    avatar,
  };
}

function shareTaskLabel(record) {
  const task = record?.taskId ? byId(appState?.tasks, record.taskId) : null;
  if (!task) return '';
  return `#${task.number || shortId(task.id)}`;
}

function drawShareAvatar(ctx, profile, image, x, y, size) {
  ctx.fillStyle = profile.type === 'human' ? '#80E4F2' : profile.type === 'agent' ? '#C9B5FF' : '#FFE1F0';
  ctx.fillRect(x, y, size, size);
  ctx.strokeStyle = '#111111';
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, size, size);
  if (image) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 2, y + 2, size - 4, size - 4);
    ctx.clip();
    ctx.drawImage(image, x + 2, y + 2, size - 4, size - 4);
    ctx.restore();
    return;
  }
  ctx.fillStyle = '#111111';
  ctx.font = '900 13px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(profile.initials || 'MC', x + size / 2, y + size / 2);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

function shareServerProfile() {
  const server = typeof currentServerProfile === 'function'
    ? currentServerProfile()
    : (appState?.cloud?.workspace || appState?.cloud?.workspaces?.[0] || {});
  const name = String(server?.name || server?.slug || currentServerSlug() || 'MagClaw').trim() || 'MagClaw';
  const fallbackInitial = name.match(/[a-zA-Z0-9]/)?.[0]?.toUpperCase() || 'M';
  return {
    name,
    avatar: String(server?.avatar || '').trim(),
    initial: typeof serverAvatarInitial === 'function' ? serverAvatarInitial(server) : fallbackInitial,
  };
}

function sharePublicDomain() {
  const configured = String(appState?.connection?.publicUrl || '').trim();
  const fallback = window.location?.host || currentServerSlug();
  const value = configured || fallback;
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    return url.host || url.hostname || '';
  } catch {
    return String(value || '')
      .replace(/^https?:\/\//i, '')
      .replace(/\/.*$/, '')
      .trim();
  }
}

function drawShareServerAvatar(ctx, profile, image, x, y, size) {
  ctx.fillStyle = '#fffefb';
  ctx.fillRect(x, y, size, size);
  ctx.strokeStyle = '#111111';
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, size, size);
  if (image) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 2, y + 2, size - 4, size - 4);
    ctx.clip();
    ctx.drawImage(image, x + 2, y + 2, size - 4, size - 4);
    ctx.restore();
    return;
  }
  ctx.fillStyle = '#111111';
  ctx.font = '900 11px ui-monospace, SFMono-Regular, Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(profile.initial || 'M', x + size / 2, y + size / 2);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
}

async function generateShareImageDataUrl(records = shareSelectionRecords()) {
  const canvas = document.createElement('canvas');
  const scale = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const width = 1040;
  const padding = 28;
  const headerHeight = 56;
  const avatarSize = 40;
  const contentWidth = width - padding * 2 - avatarSize - 16;
  const SHARE_LINE_HEIGHT = 20;
  const SHARE_DETAIL_ROW_HEIGHT = 22;
  const SHARE_REACTION_TOP_GAP = 12;
  const ctx = canvas.getContext('2d');
  const serverProfile = shareServerProfile();
  const publicDomain = sharePublicDomain();
  const threadRootId = messageShareState.scope === 'thread' ? String(messageShareState.threadRootId || '') : '';
  const logoImagePromise = loadCanvasImage(BRAND_LOGO_SRC);
  const serverImagePromise = loadCanvasImage(serverProfile.avatar);
  ctx.font = '15px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  const rows = await Promise.all(records.map(async (record) => {
    const profile = shareActorProfile(record);
    const text = shareRecordPlainText(record);
    const isThreadReply = Boolean(threadRootId && record.parentMessageId === threadRootId);
    const lineWidth = contentWidth - (isThreadReply ? 32 : 0);
    const lines = wrapShareRecordText(ctx, text, lineWidth);
    const attachments = (record.attachmentIds || []).length;
    ctx.font = '700 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    const reactionRows = shareReactionChipRows(ctx, groupedMessageReactions(record), contentWidth);
    const taskLabel = shareTaskLabel(record);
    ctx.font = '15px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    return {
      record,
      profile,
      avatarImage: await loadCanvasImage(profile.avatar),
      lines,
      reactionRows,
      taskLabel,
      sourceLabel: recordSpaceName(record),
      isThreadRoot: Boolean(threadRootId && record.id === threadRootId),
      isThreadReply,
      height: (taskLabel ? 70 : 50)
        + lines.length * SHARE_LINE_HEIGHT
        + (attachments ? SHARE_DETAIL_ROW_HEIGHT : 0)
        + (reactionRows.length
          ? (attachments ? 4 : -12) + reactionRows.length * SHARE_DETAIL_ROW_HEIGHT
          : 0)
        + 14,
    };
  }));
  const logoImage = await logoImagePromise;
  const serverImage = await serverImagePromise;
  const height = Math.max(176, headerHeight + 24 + rows.reduce((sum, row) => sum + row.height, 0) + 22);
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.scale(scale, scale);
  ctx.fillStyle = '#fff8fc';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#fffefb';
  ctx.fillRect(0, headerHeight, width, height - headerHeight);
  ctx.fillStyle = '#ff66cc';
  ctx.fillRect(0, 0, width, headerHeight);
  ctx.strokeStyle = '#111111';
  ctx.lineWidth = 3;
  ctx.strokeRect(1.5, 1.5, width - 3, height - 3);
  ctx.beginPath();
  ctx.moveTo(0, headerHeight);
  ctx.lineTo(width, headerHeight);
  ctx.stroke();
  if (logoImage) {
    ctx.fillStyle = '#fffefb';
    ctx.fillRect(padding, 12, 32, 32);
    ctx.strokeStyle = '#111111';
    ctx.lineWidth = 2;
    ctx.strokeRect(padding, 12, 32, 32);
    ctx.drawImage(logoImage, padding + 3, 15, 26, 26);
  }
  ctx.fillStyle = '#111111';
  ctx.font = '900 18px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  const brandX = padding + 42;
  ctx.fillText('MagClaw', brandX, 34);
  const brandWidth = ctx.measureText('MagClaw').width;
  ctx.font = '700 13px ui-monospace, SFMono-Regular, Menlo, monospace';
  const domainText = fitCanvasText(ctx, publicDomain, 280);
  ctx.textAlign = 'right';
  ctx.fillText(domainText, width - padding, 33);
  ctx.textAlign = 'left';
  const domainWidth = publicDomain ? ctx.measureText(domainText).width + 34 : 0;
  const serverAvatarSize = 24;
  const serverX = brandX + brandWidth + 20;
  const serverNameX = serverX + serverAvatarSize + 10;
  const serverNameMaxWidth = Math.max(80, width - padding - domainWidth - serverNameX);
  drawShareServerAvatar(ctx, serverProfile, serverImage, serverX, 16, serverAvatarSize);
  ctx.fillStyle = '#111111';
  ctx.font = '800 13px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.fillText(fitCanvasText(ctx, serverProfile.name, serverNameMaxWidth), serverNameX, 33);
  let y = headerHeight + 24;
  for (const row of rows) {
    const { record, lines, profile } = row;
    const rowX = padding + (row.isThreadRoot ? 0 : 4) + (row.isThreadReply ? 32 : 0);
    drawShareAvatar(ctx, profile, row.avatarImage, rowX, y, avatarSize);
    const contentX = rowX + avatarSize + 16;
    const rowContentWidth = contentWidth - (row.isThreadReply ? 32 : 0);
    ctx.fillStyle = '#111111';
    ctx.font = '900 15px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    const nameMaxWidth = Math.min(260, Math.max(80, rowContentWidth * 0.45));
    const fittedName = fitCanvasText(ctx, profile.name, nameMaxWidth);
    ctx.fillText(fittedName, contentX, y + 15);
    ctx.fillStyle = '#8b8790';
    ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, monospace';
    const nameWidth = Math.min(nameMaxWidth, ctx.measureText(fittedName).width);
    const metaGap = profile.type === 'human' ? 28 : 16;
    const metaText = `${profile.subtitle ? `${profile.subtitle} · ` : ''}${row.sourceLabel} · ${fmtTime(record.createdAt)}`;
    const metaX = contentX + nameWidth + metaGap;
    const metaWidth = Math.max(60, rowContentWidth - nameWidth - metaGap);
    ctx.fillText(fitCanvasText(ctx, metaText, metaWidth), metaX, y + 15);
    if (row.taskLabel) {
      const chipWidth = Math.ceil(ctx.measureText(row.taskLabel).width) + 14;
      ctx.fillStyle = '#ffe7a8';
      ctx.fillRect(contentX, y + 24, chipWidth, 18);
      ctx.strokeStyle = '#111111';
      ctx.strokeRect(contentX, y + 24, chipWidth, 18);
      ctx.fillStyle = '#111111';
      ctx.font = '900 11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(row.taskLabel, contentX + 7, y + 37);
    }
    ctx.fillStyle = '#111111';
    ctx.font = '15px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    const bodyY = row.taskLabel ? y + 58 : y + 38;
    lines.forEach((line, index) => {
      drawShareInlineText(ctx, line, contentX, bodyY + index * SHARE_LINE_HEIGHT, rowContentWidth);
    });
    const hasAttachments = (record.attachmentIds || []).length > 0;
    let detailY = bodyY + 4 + lines.length * SHARE_LINE_HEIGHT;
    if (hasAttachments) {
      ctx.fillStyle = '#e7fbff';
      ctx.fillRect(contentX, detailY, 132, 18);
      ctx.strokeStyle = '#111111';
      ctx.strokeRect(contentX, detailY, 132, 18);
      ctx.fillStyle = '#111111';
      ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(`${record.attachmentIds.length} attachment(s)`, contentX + 6, detailY + 13);
      detailY += SHARE_DETAIL_ROW_HEIGHT;
    }
    if (row.reactionRows.length) {
      detailY = hasAttachments
        ? detailY + 4
        : bodyY + Math.max(0, lines.length - 1) * SHARE_LINE_HEIGHT + SHARE_REACTION_TOP_GAP;
      ctx.font = '700 12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      for (const reactionRow of row.reactionRows) {
        let chipX = contentX;
        for (const chip of reactionRow) {
          ctx.fillStyle = '#ffe8f5';
          ctx.fillRect(chipX, detailY, chip.width, 18);
          ctx.strokeStyle = '#111111';
          ctx.strokeRect(chipX, detailY, chip.width, 18);
          ctx.fillStyle = '#111111';
          ctx.fillText(chip.label, chipX + 8, detailY + 13);
          chipX += chip.width + 6;
        }
        detailY += SHARE_DETAIL_ROW_HEIGHT;
      }
    }
    y += row.height;
  }
  return canvas.toDataURL('image/png');
}

function shareImageDataUrlToBlob(dataUrl) {
  const value = String(dataUrl || '');
  const match = value.match(/^data:([^;,]+);base64,(.*)$/);
  if (!match) return null;
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: match[1] || 'image/png' });
}

async function saveBlobWithFilePicker(blob, fileName) {
  if (typeof window.showSaveFilePicker !== 'function') return false;
  const fileHandle = await window.showSaveFilePicker({
    id: 'magclaw-share-image-file',
    suggestedName: fileName,
    types: [{
      description: 'PNG image',
      accept: { 'image/png': ['.png'] },
    }],
  });
  const writable = await fileHandle.createWritable();
  await writable.write(blob);
  await writable.close();
  return true;
}

function downloadShareImageFallback(dataUrl, fileName) {
  if (!dataUrl) return false;
  const link = document.createElement('a');
  link.href = dataUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  return true;
}

function canSaveShareImageViaServer() {
  const hostname = window.location?.hostname || '';
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === '127.0.0.1'
    || hostname === '0.0.0.0'
    || hostname === '::1'
    || hostname === '[::1]';
}

async function saveShareImageViaServer(dataUrl, fileName) {
  if (!canSaveShareImageViaServer()) return null;
  try {
    const result = await api('/api/share-images/save', {
      method: 'POST',
      body: JSON.stringify({ imageUrl: dataUrl, fileName }),
    });
    if (!result?.ok) return null;
    return {
      ok: true,
      method: 'server',
      fileName: result.fileName || fileName,
      path: result.path || '',
    };
  } catch (error) {
    console.warn('[share-image] local server save failed; falling back to browser download', error);
    return null;
  }
}

async function saveShareImage() {
  if (!sharePreviewState.imageUrl) return { ok: false };
  const fileName = shareImageFileName();
  const blob = shareImageDataUrlToBlob(sharePreviewState.imageUrl);
  if (!blob) return { ok: false };
  try {
    if (await saveBlobWithFilePicker(blob, fileName)) return { ok: true, method: 'file-picker', fileName };
  } catch (error) {
    if (error?.name === 'AbortError') return { ok: false, cancelled: true };
    console.warn('[share-image] picker save failed; falling back to browser download', error);
  }
  const serverResult = await saveShareImageViaServer(sharePreviewState.imageUrl, fileName);
  if (serverResult?.ok) return serverResult;
  if (downloadShareImageFallback(sharePreviewState.imageUrl, fileName)) return { ok: true, method: 'download', fileName };
  return { ok: false };
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
    reactions: record?.reactions || [],
    followedBy: record?.followedBy || [],
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
  const saved = record.savedBy?.includes(currentHumanId());
  const threadContext = Boolean(options.threadContext || options.compact || record.parentMessageId);
  const saveLabel = saved ? 'Remove from saved' : 'Save message';
  const threadActionLabel = record?.spaceType === 'channel' && !currentUserIsChannelMember(record.spaceId)
    ? 'View thread'
    : 'Reply in thread';
  return `
    <div class="message-hover-actions${threadContext ? ' thread-only' : ''}">
      ${threadContext ? '' : `
        <button class="message-icon-action" type="button" data-action="open-thread" data-id="${escapeHtml(record.id)}" title="${escapeHtml(threadActionLabel)}" aria-label="${escapeHtml(threadActionLabel)}">
          ${replyThreadIcon()}
        </button>
      `}
      <button class="message-icon-action${saved ? ' saved' : ''}" type="button" data-action="save-message" data-id="${escapeHtml(record.id)}" title="${escapeHtml(saveLabel)}" aria-label="${escapeHtml(saveLabel)}">
        ${saveMessageIcon(saved)}
      </button>
      <button class="message-icon-action" type="button" data-action="open-message-context-menu" data-id="${escapeHtml(record.id)}" title="More message actions" aria-label="More message actions">
        <span aria-hidden="true">⋯</span>
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
  const shareSelectable = !options.compact && messageShareState.active && recordMatchesShareScope(message);
  const shareSelecting = shareSelectable ? ' share-selecting' : '';
  const shareSelected = shareSelectable && shareSelectedIds().includes(String(message.id)) ? ' share-selected' : '';
  const authorClass = ['agent', 'human', 'system'].includes(message.authorType) ? message.authorType : 'unknown';
  const replyActionLabel = replyCount ? `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}` : 'Reply';
  const agentAuthorAttr = message.authorType === 'agent' ? ` data-agent-author-id="${escapeHtml(message.authorId)}"` : '';
  const receiptTray = renderAgentReceiptTray(message);
  const replyCountChip = !options.compact && replyCount ? `<button class="reply-count-chip" type="button" data-action="open-thread" data-id="${escapeHtml(message.id)}">${replyActionLabel}</button>` : '';
  const footer = renderMessageFooter({ replyCountChip, receiptTray });
  return `
	    <article class="message-card magclaw-message author-${authorClass}${highlighted}${compact}${shareSelecting}${shareSelected}${receiptTray ? ' has-agent-receipts' : ''}" id="message-${escapeHtml(message.id)}" data-message-id="${escapeHtml(message.id)}" data-context-scope="message" data-render-key="${escapeHtml(renderRecordKey(message))}"${agentAuthorAttr}>
      ${renderShareSelector(message, { selectable: shareSelectable })}
      ${renderActorAvatar(message.authorId, message.authorType)}
      <div class="message-body"${shareBodyToggleAttrs(message, { selectable: shareSelectable })}>
        <div class="message-meta">
          ${renderActorName(message.authorId, message.authorType)}
          <span class="sender-role">${escapeHtml(actorSubtitle(message.authorId, message.authorType, message))}</span>
          <time>${fmtTime(message.createdAt)}</time>
          ${task ? renderTaskInlineBadge(task) : ''}
        </div>
	        ${renderMessageReferences(message)}
	        <div class="message-markdown">${renderMarkdownWithMentions(message.body || (message.references?.length ? '' : '(attachment)'))}</div>
        <div class="message-attachments">${attachmentLinks(message.attachmentIds)}</div>
        ${renderMessageReactionTray(message)}
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
	      ${renderComposerReferenceStrip(id)}
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
        ${renderTaskInlineBadge(task, { showAssignee: false, hover: false, interactive: false })}
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
  const canWriteTask = task?.spaceType !== 'channel' || currentUserIsChannelMember(task.spaceId);
  const canClaim = !taskIsClosedStatus(task.status) && !task.claimedBy;
  const canUnclaim = !taskIsClosedStatus(task.status) && Boolean(task.claimedBy);
  const canReview = task.status === 'in_progress' && Boolean(task.claimedBy);
  const canApprove = task.status === 'in_review';
  const canRun = !taskIsClosedStatus(task.status) && (!task.claimedBy || task.claimedBy === 'agt_codex');
  const canClose = !taskIsClosedStatus(task.status);
  const includeThread = options.includeThread !== false;
  const thread = taskThreadMessage(task);
  if (!canWriteTask) {
    return includeThread && thread
      ? `<button class="task-action-btn tone-thread" type="button" data-action="open-thread" data-id="${escapeHtml(thread.id)}">Thread</button>`
      : '';
  }
  return `
    ${canClaim ? `<button class="task-action-btn tone-claim" type="button" data-action="task-claim" data-id="${escapeHtml(task.id)}">Claim</button>` : ''}
    ${canUnclaim ? `<button class="task-action-btn tone-neutral" type="button" data-action="task-unclaim" data-id="${escapeHtml(task.id)}">Unclaim</button>` : ''}
    ${canRun ? `<button class="task-action-btn tone-run" type="button" data-action="run-task-codex" data-id="${escapeHtml(task.id)}">Run Codex</button>` : ''}
    ${canReview ? `<button class="task-action-btn tone-review" type="button" data-action="task-review" data-id="${escapeHtml(task.id)}">Review</button>` : ''}
    ${canApprove ? `<button class="task-action-btn tone-done" type="button" data-action="task-approve" data-id="${escapeHtml(task.id)}">Done</button>` : ''}
    ${canClose ? `<button class="task-action-btn tone-close" type="button" data-action="task-close" data-id="${escapeHtml(task.id)}">Close</button>` : ''}
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
    <div class="saved-row${active}" data-context-scope="saved" data-message-id="${escapeHtml(record.id)}">
      <button class="saved-row-open" type="button" data-action="open-saved-message" data-id="${escapeHtml(record.id)}">
        <span class="saved-avatar">${getAvatarHtml(record.authorId, record.authorType, 'avatar-inner')}</span>
        <span class="saved-row-body">
          <span class="saved-row-meta">
            <strong>${escapeHtml(recordSpaceName(record))}</strong>
            ${task ? renderTaskInlineBadge(task, { showAssignee: false, interactive: false }) : (isThreadRecord ? '<em>thread</em>' : '')}
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
