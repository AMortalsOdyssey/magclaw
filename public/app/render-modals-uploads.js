function renderModal() {
  const map = {
    channel: renderChannelModal,
    'edit-channel': renderEditChannelModal,
    'channel-members': renderChannelMembersModal,
    'add-channel-member': renderAddChannelMemberModal,
    'confirm-stop-all': renderStopAllConfirmModal,
    'confirm-sign-out': renderSignOutConfirmModal,
    'member-invite': renderMemberInviteModal,
    'member-invite-links': renderMemberInviteLinksModal,
    'member-manage': renderMemberManageModal,
    'member-action-confirm': renderMemberActionConfirmModal,
    'member-reset-link': renderMemberResetLinkModal,
    'server-create': renderServerCreateModal,
    project: renderProjectModal,
    dm: renderDmModal,
    task: renderTaskModal,
    agent: renderAgentModal,
    'avatar-picker': renderAvatarPickerModal,
    'avatar-crop': renderAvatarCropModal,
    'agent-start': renderAgentStartModal,
    'agent-restart': renderAgentRestartModal,
    computer: renderComputerModal,
    human: renderHumanModal,
  };
  const content = map[modal]?.() || '';
  const isWideModal = modal === 'avatar-picker' || modal === 'avatar-crop';
  const modalClass = `modal-${String(modal || '').replace(/[^a-z0-9-]/gi, '-')}`;
  return `
    <div class="modal-backdrop ${modalClass}-backdrop" data-action="close-modal">
      <div class="modal-card pixel-panel ${modalClass} ${isWideModal ? 'modal-wide' : ''}" data-action="none">
        ${content}
      </div>
    </div>
  `;
}

function renderServerCreateModal() {
  return `
    ${modalHeader('Create Server', 'Console')}
    <form id="console-server-form" class="modal-form">
      <label><span>Server name</span><input name="name" placeholder="My Team" autocomplete="off" data-console-server-name required /></label>
      <label><span>URL slug</span><input name="slug" placeholder="my-team" autocomplete="off" spellcheck="false" minlength="5" maxlength="63" pattern="(?=.{5,63}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?" data-console-server-slug data-auto-slug="1" required /></label>
      <small class="form-hint">Generated from the server name unless you edit it. Use 5-63 lowercase letters, numbers, and hyphens.</small>
      <div class="form-error console-server-error" data-console-server-error role="alert" aria-live="polite" hidden></div>
      <div class="modal-actions">
        <button type="button" class="secondary-btn" data-action="close-modal">Cancel</button>
        <button class="primary-btn" type="submit">Create Server</button>
      </div>
    </form>
  `;
}

function renderShellOrModal() {
  if (appState) {
    render();
    return;
  }
  document.querySelector('.modal-backdrop')?.remove();
  if (modal) root.insertAdjacentHTML('beforeend', renderModal());
}

function modalHeader(title, subtitle) {
  return `<div class="modal-head"><div>${subtitle ? `<p class="eyebrow">${escapeHtml(subtitle)}</p>` : ''}<h3>${escapeHtml(title)}</h3></div><button type="button" data-action="close-modal" aria-label="Close">×</button></div>`;
}

function renderStopAllConfirmModal() {
  const targetName = spaceName(selectedSpaceType, selectedSpaceId);
  return `
    ${modalHeader('STOP ALL AGENTS')}
    <div class="confirm-stop-modal stop-unavailable-modal">
      <div class="confirm-stop-icon">${channelActionIcon('stop')}</div>
      <div class="confirm-stop-copy">
        <strong>该功能暂时不可用</strong>
        <p>Stop All Agents in ${escapeHtml(targetName)} is currently disabled.</p>
      </div>
    </div>
    <div class="modal-actions confirm-stop-actions">
      <button type="button" class="secondary-btn" data-action="close-modal">OK</button>
    </div>
  `;
}

function renderSignOutConfirmModal() {
  const currentUser = appState?.cloud?.auth?.currentUser;
  const name = currentUser?.name || currentUser?.email || 'this account';
  return `
    ${modalHeader('SIGN OUT')}
    <div class="confirm-stop-modal signout-confirm-modal">
      <div class="confirm-stop-icon signout-confirm-icon">${settingsIcon('account')}</div>
      <div class="confirm-stop-copy">
        <strong>Sign out of ${escapeHtml(name)}?</strong>
        <p>You will need to sign in again to access this workspace from this browser.</p>
      </div>
    </div>
    <div class="modal-actions confirm-stop-actions">
      <button type="button" class="secondary-btn" data-action="close-modal">Cancel</button>
      <button type="button" class="primary-btn danger-btn" data-action="confirm-cloud-auth-logout">Sign Out</button>
    </div>
  `;
}

function renderAgentStartModal() {
  const agent = byId(appState?.agents, agentStartState.agentId);
  return `
    ${modalHeader(`START ${agent ? agent.name : 'AGENT'}`)}
    <div class="agent-restart-options">
      <div class="agent-restart-option selected info">
        <strong>Start Agent</strong>
        <span>Start the agent process. Keeps conversation history and workspace files.</span>
      </div>
    </div>
    <div class="modal-actions confirm-stop-actions">
      <button type="button" class="secondary-btn" data-action="close-modal">Cancel</button>
      <button type="button" class="primary-btn" data-action="confirm-agent-start">Start Agent</button>
    </div>
  `;
}

function renderAgentRestartModal() {
  const agent = byId(appState?.agents, agentRestartState.agentId);
  const mode = agentRestartState.mode || 'restart';
  const options = [
    {
      id: 'restart',
      title: 'RESTART',
      button: 'Restart',
      body: 'Stop and restart the agent process. Keeps the runtime session and workspace files.',
      tone: 'info',
    },
    {
      id: 'reset-session',
      title: 'RESET SESSION & RESTART',
      button: 'Reset Session & Restart',
      body: 'Clear the runtime session and restart. Workspace files (MEMORY.md, notes/) are preserved.',
      tone: 'warning',
    },
    {
      id: 'full-reset',
      title: 'FULL RESET & RESTART',
      button: 'Full Reset & Restart',
      body: 'Clear the runtime session, delete all workspace files, and restart from scratch.',
      tone: 'danger',
    },
  ];
  const active = options.find((item) => item.id === mode) || options[0];
  return `
    ${modalHeader(`RESTART ${agent ? agent.name : 'AGENT'}`)}
    <div class="agent-restart-options">
      ${options.map((option) => `
        <button class="agent-restart-option ${option.id === mode ? `selected ${option.tone}` : ''}" type="button" data-action="select-agent-restart-mode" data-mode="${option.id}">
          <strong>${escapeHtml(option.title)}</strong>
          <span>${escapeHtml(option.body)}</span>
        </button>
      `).join('')}
    </div>
    ${mode === 'full-reset' ? `
      <div class="agent-restart-warning">
        <strong>This will permanently delete all workspace files including MEMORY.md and notes/. This cannot be undone.</strong>
      </div>
    ` : ''}
    <div class="modal-actions confirm-stop-actions">
      <button type="button" class="secondary-btn" data-action="close-modal">Cancel</button>
      <button type="button" class="primary-btn ${active.tone === 'danger' ? 'danger-btn' : ''}" data-action="confirm-agent-restart">${escapeHtml(active.button || active.title)}</button>
    </div>
  `;
}

function renderProjectModal() {
  const channel = selectedSpaceType === 'channel' ? currentSpace() : null;
  const projects = projectsForSpace();
  return `
    ${modalHeader('Open Project', channel ? `#${channel.name}` : 'Channel project')}
    <div class="folder-picker-panel">
      <button class="primary-btn" type="button" data-action="pick-project-folder">Open Folder</button>
    </div>
    <details class="manual-project-path">
      <summary>Path</summary>
      <form id="project-form" class="modal-form">
        <label>
          <span>Folder path</span>
          <input name="path" placeholder="/Users/tt/code/myproject/magclaw" required />
        </label>
        <label><span>Name</span><input name="name" placeholder="Optional display name" /></label>
        <div class="modal-actions">
          <button class="primary-btn" type="submit">Add Path</button>
        </div>
      </form>
    </details>
    <div class="project-modal-list">
      ${projects.length ? projects.map((project) => `
        <div class="project-modal-item">
          <div class="project-modal-info">
            <span class="project-folder-badge">${folderIcon()}</span>
            <div>
              <strong>${escapeHtml(project.name)}</strong>
              <small>${escapeHtml(project.path)}</small>
            </div>
          </div>
          <button type="button" class="project-icon-btn danger-icon" data-action="remove-project" data-id="${escapeHtml(project.id)}" title="Remove ${escapeHtml(project.name)}" aria-label="Remove ${escapeHtml(project.name)}">${trashIcon()}</button>
        </div>
      `).join('') : '<div class="empty-box small">No folders added yet.</div>'}
    </div>
  `;
}

function agentCanJoinNewChannel(agent) {
  return agentIsActiveInWorkspace(agent);
}

function channelAssignableAgents() {
  return (appState.agents || []).filter(agentIsActiveInWorkspace);
}

function renderChannelModal() {
  const agents = channelAssignableAgents();
  const query = createChannelMemberSearchQuery.trim().toLowerCase();
  const visibleAgents = agents.filter((agent) => {
    if (!query) return true;
    return `${agent.name || ''} ${agent.description || ''} ${agent.runtime || ''}`.toLowerCase().includes(query);
  });
  return `
    ${modalHeader('Create Channel', 'Collaboration')}
    <form id="channel-form" class="modal-form">
      <label><span>Name</span><input name="name" placeholder="frontend-war-room" required /></label>
      <label><span>Description</span><textarea name="description" rows="3"></textarea></label>
      <div class="form-field create-channel-members-field">
        <span>Members <small>(optional)</small></span>
        <label class="create-channel-search-wrap" aria-label="Search members by name">
          <svg class="create-channel-search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5" /><path d="M15 15l5 5" /></svg>
          <input id="create-channel-member-search" value="${escapeHtml(createChannelMemberSearchQuery)}" placeholder="Search members by name" autocomplete="off" />
        </label>
        <div class="agent-checkboxes create-channel-member-list">
          <div class="create-channel-member-group-title">AGENTS</div>
          ${visibleAgents.map((agent) => {
            const canJoin = agentCanJoinNewChannel(agent);
            return `
            <label class="checkbox-item create-channel-member-row${canJoin ? '' : ' disabled'}">
              <input type="checkbox" name="agentIds" value="${agent.id}"${canJoin ? '' : ' disabled'} />
              ${getAvatarHtml(agent.id, 'agent', 'dm-avatar')}
              <span class="create-channel-member-name">${escapeHtml(agent.name)}</span>
              <span class="create-channel-member-check">✓</span>
            </label>
          `;
          }).join('')}
          ${!visibleAgents.length ? '<div class="empty-box small">No matching agents</div>' : ''}
          ${!agents.length ? '<div class="empty-box small">No agents available</div>' : ''}
        </div>
      </div>
      <div class="modal-actions">
        <button class="secondary-btn" type="button" data-action="close-modal">Cancel</button>
        <button class="primary-btn" type="submit">Create Channel</button>
      </div>
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

function renderChannelMemberRow(member, type, isAllChannel) {
  const status = member.status || 'offline';
  const avatar = type === 'agent'
    ? getAvatarHtml(member.id, 'agent', 'dm-avatar member-avatar')
    : renderHumanAvatar(member, 'dm-avatar member-avatar');
  const canRemove = !isAllChannel && (type === 'agent' || member.id !== 'hum_local');
  const profile = type === 'agent' ? `
    <button class="member-profile-btn" type="button" data-action="select-agent" data-id="${escapeHtml(member.id)}">
      ${avatar}
      <span class="member-main">
        <strong class="member-name">${escapeHtml(member.name)}</strong>
        <span class="member-status ${presenceClass(status)}">${escapeHtml(status)}</span>
      </span>
      ${renderAgentHoverCard(member)}
    </button>
  ` : `
    <button class="member-profile-btn" type="button" data-action="select-human-inspector" data-id="${escapeHtml(member.id)}">
      ${avatar}
      <span class="member-main">
        <strong class="member-name">@${escapeHtml(member.name)}</strong>
      </span>
      ${renderHumanHoverCard(member)}
    </button>
  `;
  return `
    <div class="member-list-item member-list-item-${type}">
      ${profile}
      ${canRemove ? `<button class="member-remove-btn" type="button" data-action="remove-channel-member" data-member-id="${member.id}" title="Remove ${escapeHtml(member.name)}" aria-label="Remove ${escapeHtml(member.name)}">×</button>` : ''}
    </div>
  `;
}

function renderAddMemberCandidateGroup(title, items, type) {
  if (!items.length) return '';
  return `
    <div class="add-member-group">
      <div class="add-member-group-title">${escapeHtml(title)}</div>
      ${items.map((item) => `
        <button class="add-member-candidate" type="button" data-action="add-channel-member" data-member-id="${escapeHtml(item.id)}">
          ${type === 'agent' ? getAvatarHtml(item.id, 'agent', 'dm-avatar member-avatar') : renderHumanAvatar(item, 'dm-avatar member-avatar')}
          <span class="add-member-candidate-main">
            <strong>${escapeHtml(item.name)}</strong>
            ${type === 'human' && item.email ? `<small>${escapeHtml(item.email)}</small>` : ''}
          </span>
          ${type === 'agent' ? `<span class="add-member-status-dot ${presenceClass(item.status)}" title="${escapeHtml(item.status || 'offline')}"></span>` : ''}
        </button>
      `).join('')}
    </div>
  `;
}

function channelMemberProposalCards(channelId) {
  const channelMemberProposals = Array.isArray(appState?.channelMemberProposals) ? appState.channelMemberProposals : [];
  return channelMemberProposals
    .filter((proposal) => proposal.channelId === channelId && proposal.status === 'pending')
    .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
}

function renderMemberProposalCard(proposal) {
  const proposer = displayName(proposal.proposedBy || 'agent');
  const members = (proposal.memberIds || [])
    .map((id) => (typeof humanByIdAny === 'function' ? humanByIdAny(id) : null) || byId(appState.agents, id) || { id, name: displayName(id) })
    .filter(Boolean);
  return `
    <div class="member-proposal-card">
      <div class="member-proposal-main">
        <span class="member-proposal-kicker">Agent suggestion</span>
        <strong>${escapeHtml(proposer)} wants to add ${escapeHtml(members.map((member) => member.name || displayName(member.id)).join(', '))}</strong>
        <p>${escapeHtml(proposal.reason || 'No reason provided.')}</p>
        <small>${escapeHtml(fmtTime(proposal.createdAt))}</small>
      </div>
      <div class="member-proposal-actions">
        <button class="secondary-btn compact-btn" type="button" data-action="decline-member-proposal" data-proposal-id="${escapeHtml(proposal.id)}">Decline</button>
        <button class="primary-btn compact-btn" type="button" data-action="accept-member-proposal" data-proposal-id="${escapeHtml(proposal.id)}">Accept</button>
      </div>
    </div>
  `;
}

function renderChannelMembersModal() {
  const channel = selectedSpaceType === 'channel' ? currentSpace() : null;
  const members = getChannelMembers(selectedSpaceId);
  const allChannel = isAllChannel(channel);
  const total = members.agents.length + members.humans.length;
  const proposals = channelMemberProposalCards(selectedSpaceId);

  return `
    ${modalHeader(`MEMBERS (${total})`)}
    <div class="members-modal-content">
      ${proposals.length ? `
        <div class="members-section member-proposals-section">
          <div class="members-section-title">Pending suggestions <em>${proposals.length}</em></div>
          <div class="member-proposal-list">
            ${proposals.map(renderMemberProposalCard).join('')}
          </div>
        </div>
      ` : ''}

      <div class="members-section">
        <div class="members-section-title">Agents</div>
        <div class="members-list">
          ${members.agents.length ? members.agents.map((agent) => renderChannelMemberRow(agent, 'agent', allChannel)).join('') : '<div class="empty-box small">No agents in this channel</div>'}
        </div>
      </div>

      <div class="members-section">
        <div class="members-section-title">Humans</div>
        <div class="members-list">
          ${members.humans.length ? members.humans.map((human) => renderChannelMemberRow(human, 'human', allChannel)).join('') : '<div class="empty-box small">No humans in this channel</div>'}
        </div>
      </div>

      <div class="members-actions">
        ${!allChannel ? `<button class="member-add-btn" type="button" data-action="open-modal" data-modal="add-channel-member">+ Add Member</button>` : ''}
      </div>
    </div>
  `;
}

function renderAddChannelMemberModal() {
  const channel = selectedSpaceType === 'channel' ? currentSpace() : null;
  const members = getChannelMembers(selectedSpaceId);
  const memberIds = [...members.agents.map((a) => a.id), ...members.humans.map((h) => h.id)];
  const q = addMemberSearchQuery.trim().toLowerCase();
  const matches = (item) => {
    const haystack = `${item.name || ''} ${item.email || ''} ${item.status || ''}`.toLowerCase();
    return !q || haystack.includes(q);
  };
  const availableAgents = channelAssignableAgents().filter((a) => !memberIds.includes(a.id) && matches(a));
  const availableHumans = workspaceHumans().filter((h) => !memberIds.includes(h.id) && !humanMatchesCurrentAccount(h) && matches(h));
  const hasCandidates = availableAgents.length || availableHumans.length;

  return `
    ${modalHeader('ADD MEMBER')}
    <div class="add-member-modal">
      <label class="add-member-search-label">
        <span>Search</span>
        <span class="add-member-search-wrap">
          <svg class="add-member-search-icon" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><circle cx="10.5" cy="10.5" r="5.5" /><path d="M15 15l5 5" /></svg>
          <input id="add-member-search" value="${escapeHtml(addMemberSearchQuery)}" placeholder="Name" autocomplete="off" autofocus />
        </span>
      </label>
      <div class="add-member-candidates" role="listbox" aria-label="Available members for ${escapeHtml(channel?.name || 'channel')}">
        ${hasCandidates ? [
          renderAddMemberCandidateGroup('Agents', availableAgents, 'agent'),
          renderAddMemberCandidateGroup('Humans', availableHumans, 'human'),
        ].join('') : '<div class="empty-box small">No available members</div>'}
      </div>
    </div>
  `;
}

function renderDmModal() {
  const options = [...channelAssignableAgents(), ...workspaceHumans().filter((human) => !humanMatchesCurrentAccount(human))];
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
      <label><span>Assignees</span><select name="assigneeIds" multiple size="4">${channelAssignableAgents().map((agent) => `<option value="${agent.id}">${escapeHtml(agent.name)}</option>`).join('')}</select></label>
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

function renderAgentChoiceSelect({ name, options, currentValue, emptyLabel = 'Select...' }) {
  if (!options.length) {
    return `
      <select name="${escapeHtml(name)}" class="agent-auto-select ${escapeHtml(name)}-select" disabled>
        <option value="">${escapeHtml(emptyLabel)}</option>
      </select>
    `;
  }
  const selected = options.some((option) => option.value === currentValue && !option.disabled)
    ? currentValue
    : options.find((option) => !option.disabled)?.value || '';
  return `
    <select name="${escapeHtml(name)}" class="agent-auto-select ${escapeHtml(name)}-select">
      ${options.map((option) => {
        const label = option.meta ? `${option.label} - ${option.meta}` : option.label;
        return `<option value="${escapeHtml(option.value)}" ${option.disabled ? 'disabled' : ''} ${option.value === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`;
      }).join('')}
    </select>
  `;
}

function runtimeOptionsForComputer(computerId) {
  const computer = byId(appState.computers, computerId) || appState.computers?.[0] || {};
  const details = computerRuntimeDetails(computer, { includeLocalFallback: computer.connectedVia !== 'daemon' });
  const normalizeRuntimeOption = (runtime) => {
    const installedRuntime = installedRuntimes.find((item) => item.id === runtime.id || item.name === runtime.name);
    const models = runtime.models || installedRuntime?.models || [];
    const modelNames = runtime.modelNames || installedRuntime?.modelNames || models.map((model) => ({ slug: model, name: model }));
    return {
      ...installedRuntime,
      ...runtime,
      name: runtime.name || installedRuntime?.name || runtimeNameForId(runtime.id),
      installed: runtime.installed !== false,
      createSupported: runtime.createSupported !== false,
      modelNames,
      models,
      defaultModel: runtime.defaultModel || installedRuntime?.defaultModel || models[0] || '',
      reasoningEffort: runtime.reasoningEffort || installedRuntime?.reasoningEffort || [],
      defaultReasoningEffort: runtime.defaultReasoningEffort || installedRuntime?.defaultReasoningEffort || 'medium',
    };
  };
  const options = details.map(normalizeRuntimeOption);
  if (!details.length || computer.connectedVia !== 'daemon') {
    const seen = new Set(options.map((runtime) => String(runtime.id || '').toLowerCase()));
    for (const runtime of installedRuntimes) {
      const id = String(runtime.id || '').toLowerCase();
      if (!id || seen.has(id)) continue;
      options.push(normalizeRuntimeOption(runtime));
      seen.add(id);
    }
  }
  return options;
}

function renderAgentModal() {
  if (!cloudCan('manage_agents')) {
    return `
      ${modalHeader('CREATE AGENT', 'Workspace role required')}
      <div class="modal-form">
        <div class="empty-box small">Your current role can chat with Agents, but cannot create or configure Agent profiles.</div>
        <button type="button" class="primary-btn" data-action="close-modal">Close</button>
      </div>
    `;
  }
  if (!cloudCan('manage_computers') && !(appState.computers || []).length) {
    return `
      ${modalHeader('CREATE AGENT', 'Computer required')}
      <div class="modal-form">
        <div class="empty-box small">Connect a Computer before creating cloud Agents.</div>
        <button type="button" class="primary-btn" data-action="close-modal">Close</button>
      </div>
    `;
  }
  const computerOptions = (typeof sortComputersByAvailability === 'function'
    ? sortComputersByAvailability(appState.computers || [])
    : (appState.computers || [])).filter((computer) => {
      if (typeof computerIsDeleted === 'function' && computerIsDeleted(computer)) return false;
      if (typeof computerIsDisabled === 'function' && computerIsDisabled(computer)) return false;
      const status = String(computer.status || 'offline').toLowerCase();
      return status === 'connected' || status === 'offline';
    });
  const connectedComputers = computerOptions.filter((computer) => (
    typeof computerIsConnected === 'function'
      ? computerIsConnected(computer)
      : String(computer.status || '').toLowerCase() === 'connected'
  ));
  if (!computerOptions.length) {
    return `
      ${modalHeader('CREATE AGENT', 'Computer required')}
      <div class="modal-form">
        <div class="empty-box small">Connect a Computer before creating cloud Agents.</div>
        <button type="button" class="primary-btn" data-action="close-modal">Close</button>
      </div>
    `;
  }
  const defaultComputer = connectedComputers.some((computer) => computer.id === agentFormState.computerId)
    ? agentFormState.computerId
    : connectedComputers[0]?.id || '';
  const availableRuntimes = defaultComputer ? runtimeOptionsForComputer(defaultComputer) : [];
  const selectableRuntimes = availableRuntimes.filter((rt) => rt.installed && rt.createSupported !== false);
  if (!selectableRuntimes.some((rt) => rt.id === selectedRuntimeId)) {
    selectedRuntimeId = selectableRuntimes[0]?.id || '';
  }
  const currentRuntime = selectableRuntimes.find((rt) => rt.id === selectedRuntimeId) || selectableRuntimes[0];
  const models = currentRuntime?.models || [];
  const modelNames = currentRuntime?.modelNames || models.map(m => ({ slug: m, name: m }));
  const defaultModel = agentFormState.model || currentRuntime?.defaultModel || '';
  const hasReasoningEffort = Boolean(currentRuntime?.reasoningEffort?.length);
  const reasoningEfforts = currentRuntime?.reasoningEffort || [];
  const defaultReasoningEffort = agentFormState.reasoningEffort || currentRuntime?.defaultReasoningEffort || 'medium';
  const runtimeChoices = availableRuntimes.map((rt) => ({
    value: rt.id,
    label: rt.name || runtimeNameForId(rt.id),
    meta: !rt.installed
      ? 'not installed'
      : rt.createSupported === false
        ? 'not supported yet'
        : rt.version
          ? String(rt.version).split(/\r?\n/)[0]
          : '',
    disabled: !rt.installed || rt.createSupported === false,
  }));
  const modelChoices = modelNames.map((m) => {
    const slug = typeof m === 'string' ? m : m.slug;
    const name = typeof m === 'string' ? m : m.name;
    return { value: slug, label: name };
  });
  const reasoningChoices = reasoningEfforts.map((effort) => ({
    value: effort,
    label: effort.charAt(0).toUpperCase() + effort.slice(1),
  }));
  const createAgentDisabled = !currentRuntime || !defaultComputer || agentCreateInFlight;
  const createAgentLabel = agentCreateInFlight ? 'Creating...' : 'Create Agent';

  // Initialize avatar if not set
  if (!agentFormState.avatar) {
    agentFormState.avatar = getRandomAvatar();
  }

  return `
    ${modalHeader('CREATE AGENT', 'Runtime profile')}
    <form id="agent-form" class="modal-form">
      ${connectedComputers.length ? '' : '<div class="empty-box small agent-computer-required">No connected Computer is available. Connect one first; offline Computers are shown below for reference.</div>'}
      <div class="avatar-picker">
        <span class="form-label">AVATAR</span>
        <div class="avatar-picker-row">
          <img src="${agentFormState.avatar}" class="avatar-preview" alt="Avatar" />
          <input type="hidden" name="avatar" value="${agentFormState.avatar}" />
          <button type="button" class="secondary-btn" data-action="randomize-avatar">🎲 Random</button>
          <button type="button" class="secondary-btn" data-action="pick-avatar">Browse</button>
          <label class="secondary-btn file-btn">
            Upload
            <input class="visually-hidden agent-avatar-upload" type="file" accept="image/*" data-action="upload-agent-avatar" data-avatar-upload-target="agent-create" data-target="agent-create" />
          </label>
        </div>
      </div>
      <label>
        <span>COMPUTER <span class="required">*</span></span>
        <select name="computerId" id="agent-computer-select">
          ${defaultComputer ? '<option value="" disabled>Select...</option>' : '<option value="" disabled selected>Select...</option>'}
          ${computerOptions.map((c) => {
            const connected = connectedComputers.some((computer) => computer.id === c.id);
            const status = String(c.status || 'offline').toLowerCase();
            const suffix = connected ? '' : ` (${status === 'connected' ? 'offline' : status || 'offline'})`;
            return `<option value="${c.id}" ${connected ? '' : 'disabled'} ${c.id === defaultComputer ? 'selected' : ''}>${escapeHtml(c.name || c.hostname || 'Computer')}${c.hostname && c.hostname !== c.name ? ` (${escapeHtml(c.hostname)})` : ''}${escapeHtml(suffix)}</option>`;
          }).join('')}
        </select>
      </label>
      <label>
        <span>NAME <span class="required">*</span></span>
        <input name="name" placeholder="e.g. Kael" value="${escapeHtml(agentFormState.name)}" required />
      </label>
      <label>
        <span>DESCRIPTION <span class="optional">(optional)</span></span>
        <textarea name="description" rows="3" placeholder="Leave blank for a general-purpose agent, or describe a role...">${escapeHtml(agentFormState.description)}</textarea>
        <small class="char-count">${agentFormState.description.length}/3000</small>
      </label>
      <div class="form-field">
        <span>RUNTIME</span>
        ${renderAgentChoiceSelect({
          name: 'runtime',
          options: runtimeChoices,
          currentValue: selectedRuntimeId,
          emptyLabel: 'No runtimes reported',
        })}
      </div>
      <div class="form-field">
        <span>MODEL</span>
        ${renderAgentChoiceSelect({
          name: 'model',
          options: modelChoices,
          currentValue: defaultModel,
        })}
      </div>
      ${hasReasoningEffort ? `
      <div class="form-field">
        <span>REASONING EFFORT</span>
        ${renderAgentChoiceSelect({
          name: 'reasoningEffort',
          options: reasoningChoices,
          currentValue: defaultReasoningEffort,
        })}
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
        <button class="primary-btn" type="submit" ${createAgentDisabled ? 'disabled' : ''}>${createAgentLabel}</button>
      </div>
    </form>
  `;
}

function renderAvatarPickerModal() {
  const picker = avatarPickerState || { target: 'agent-create', selectedAvatar: agentFormState.avatar };
  const isProfile = picker.target === 'profile';
  const title = 'SELECT AVATAR';
  const subtitle = isProfile ? 'Choose an avatar for your profile' : 'Choose an avatar for your agent';
  const selectedAvatar = picker.selectedAvatar || (picker.target === 'agent-create' ? agentFormState.avatar : '');
  let html = `${modalHeader(title, subtitle)}
    <div class="avatar-grid">`;
  for (let i = 1; i <= AVATAR_COUNT; i++) {
    const src = `/avatars/avatar_${String(i).padStart(4, '0')}.svg`;
    const selected = selectedAvatar === src ? 'selected' : '';
    html += `<img src="${src}" class="avatar-option ${selected}" data-avatar="${src}" />`;
  }
  html += `</div>
    <div class="modal-actions">
      <button type="button" class="secondary-btn" data-action="back-to-agent-modal">Back</button>
      <button type="button" class="primary-btn" data-action="confirm-avatar">Select</button>
    </div>`;
  return html;
}

function renderAvatarCropModal() {
  const state = avatarCropState;
  if (!state) return modalHeader('CROP AVATAR');
  return `
    ${modalHeader('CROP AVATAR', 'Square avatar preview')}
    <div class="avatar-crop-modal">
      <div class="avatar-crop-stage" style="--avatar-crop-stage: ${AVATAR_CROP_STAGE_SIZE}px; --avatar-crop-view: ${AVATAR_CROP_VIEW_SIZE}px;">
        <img
          class="avatar-crop-image"
          src="${escapeHtml(state.source)}"
          alt="Avatar crop source"
          style="width: ${state.baseWidth}px; height: ${state.baseHeight}px; --avatar-crop-x: ${state.offsetX}px; --avatar-crop-y: ${state.offsetY}px; --avatar-crop-scale: ${state.scale};"
        />
        <div class="avatar-crop-shade top"></div>
        <div class="avatar-crop-shade right"></div>
        <div class="avatar-crop-shade bottom"></div>
        <div class="avatar-crop-shade left"></div>
        <div class="avatar-crop-square"></div>
        <div class="avatar-crop-overlay"></div>
      </div>
      <div class="avatar-crop-controls">
        <button type="button" class="secondary-btn" data-action="avatar-crop-zoom-out" aria-label="Zoom avatar out">−</button>
        <input type="range" min="1" max="4" step="0.05" value="${escapeHtml(state.scale)}" data-action="avatar-crop-scale" aria-label="Avatar zoom" />
        <button type="button" class="secondary-btn" data-action="avatar-crop-zoom-in" aria-label="Zoom avatar in">+</button>
        <button type="button" class="secondary-btn" data-action="avatar-crop-reset">Reset</button>
      </div>
    </div>
    <div class="modal-actions">
      <button type="button" class="secondary-btn" data-action="close-modal">Cancel</button>
      <button type="button" class="primary-btn" data-action="confirm-avatar-crop">Confirm</button>
    </div>
  `;
}

function pairingCommandIsUsable(pairingCommand = latestPairingCommand) {
  if (!pairingCommand?.command) return false;
  const token = pairingCommand.pairingToken || {};
  if (token.consumedAt || token.revokedAt) return false;
  if (token.expiresAt) {
    const expiresAtMs = Date.parse(token.expiresAt);
    if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) return false;
  }
  return true;
}

function pairingDisplayNameValue() {
  return String(computerPairingDisplayName || latestPairingCommand?.displayName || '').slice(0, 30);
}

function computerNameLooksLikeCloudHost(value = '') {
  return /^magclaw-web-[a-z0-9-]+$/i.test(String(value || '').trim());
}

function defaultComputerPairingName(computer = null) {
  const name = String(computer?.name || computer?.hostname || '').trim();
  if (name && !computerNameLooksLikeCloudHost(name)) return name.slice(0, 30);
  return 'My computer';
}

function pairingShellArg(value) {
  return `"${String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\$/g, '\\$')
    .replace(/`/g, '\\`')}"`;
}

function pairingCommandText(command = latestPairingCommand?.command || '') {
  const displayName = pairingDisplayNameValue().trim();
  if (!command || !displayName) return command || '';
  const marker = ' # ';
  const commentIndex = command.lastIndexOf(marker);
  const body = commentIndex >= 0 ? command.slice(0, commentIndex) : command;
  const comment = commentIndex >= 0 ? command.slice(commentIndex) : '';
  const bodyWithoutDisplayName = body.replace(/\s--display-name\s+(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s]+)/, '');
  return `${bodyWithoutDisplayName} --display-name ${pairingShellArg(displayName)}${comment}`;
}

function pairingCommandDisplayText(command = latestPairingCommand?.command || '') {
  return pairingCommandText(command) || computerPairingCommandError || 'Generating command...';
}

function renderComputerModal() {
  if (!cloudCan('manage_computers')) {
    return `
      ${modalHeader('Add Computer', 'Workspace role required')}
      <div class="modal-form">
        <div class="empty-box small">Your current role can chat with Agents, but cannot add or configure computers.</div>
        <button type="button" class="primary-btn" data-action="close-modal">Close</button>
      </div>
    `;
  }
  const command = latestPairingCommand?.command || '';
  const pendingComputerId = latestPairingCommand?.computer?.id || '';
  const liveComputer = pendingComputerId ? byId(appState.computers, pendingComputerId) : null;
  const pairingComputer = liveComputer || latestPairingCommand?.computer || null;
  const stale = Boolean(command && !pairingCommandIsUsable(latestPairingCommand));
  const connected = String(pairingComputer?.status || '').toLowerCase() === 'connected';
  const displayName = pairingDisplayNameValue();
  const renderedCommand = pairingCommandText(command);
  const commandError = Boolean(!command && computerPairingCommandError);
  const commandStatusText = commandError ? 'Could not create connect command.' : 'Waiting for computer to connect...';
  const usesLocalRepoPlaceholder = renderedCommand.includes('MAGCLAW_REPO_DIR=');
  return `
    ${modalHeader('CONNECT COMPUTER')}
    <div class="modal-form connect-computer-modal">
      <div class="connect-command-intro">
        <span class="connect-command-prompt" aria-hidden="true">&gt;_</span>
        <strong>Run this command on your computer to connect:</strong>
      </div>
      <label class="connect-display-name-field">
        <span>Display name</span>
        <input id="computer-display-name-input" data-action="computer-display-name" maxlength="30" value="${escapeHtml(displayName)}" placeholder="${escapeHtml(defaultComputerPairingName(pairingComputer))}" />
        <small>Optional. This becomes the computer name after it connects.</small>
      </label>
      <div class="connect-command-shell">
        <pre><code>${escapeHtml(pairingCommandDisplayText(command))}</code></pre>
        ${command ? pairingCommandCopyButtonHtml() : ''}
      </div>
      <p class="connect-command-note">
        ${usesLocalRepoPlaceholder ? 'Set MAGCLAW_REPO_DIR to your MagClaw checkout path before running. ' : ''}
        Keep this process running — it maintains the connection between your computer and MagClaw.
      </p>
      <div class="pairing-wait-box ${connected ? 'connected' : ''} ${stale || commandError ? 'stale' : ''}">
        <span class="avatar-status-dot inline ${presenceClass(connected ? 'connected' : (stale || commandError) ? 'offline' : 'queued')}"></span>
        <strong>${connected ? 'Computer connected.' : stale ? 'This connect command is no longer valid.' : commandStatusText}</strong>
      </div>
      <div class="modal-actions">
        ${stale || commandError ? '<button type="button" class="secondary-btn" data-action="refresh-computer-pairing-command">Generate New Command</button>' : ''}
        <button type="button" class="secondary-btn" data-action="close-modal">Cancel</button>
        <button type="button" class="primary-btn" data-action="close-modal" ${connected ? '' : 'disabled'}>Done</button>
      </div>
    </div>
  `;
}

function renderHumanModal() {
  if (appState.cloud?.auth?.currentUser) {
    return renderMemberInviteModal();
  }
  return `
    ${modalHeader('Invite Human', 'Team placeholder')}
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

function readFileAsDataUrl(file, source = 'upload') {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({
      name: file.name,
      type: file.type || 'application/octet-stream',
      dataUrl: reader.result,
      source,
    });
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadFiles(files, composerId, source = 'upload') {
  const currentCount = stagedFor(composerId).attachments.length;
  const remaining = MAX_ATTACHMENTS_PER_COMPOSER - currentCount;
  if (remaining <= 0) {
    toast(`最多只能暂存 ${MAX_ATTACHMENTS_PER_COMPOSER} 个附件`);
    return;
  }
  const selectedFiles = [...files].slice(0, remaining);
  if (files.length > remaining) {
    toast(`最多只能暂存 ${MAX_ATTACHMENTS_PER_COMPOSER} 个附件，已添加前 ${remaining} 个`);
  }
  const payload = await Promise.all(selectedFiles.map((file) => readFileAsDataUrl(file, source)));
  const result = await api('/api/attachments', {
    method: 'POST',
    body: JSON.stringify({ files: payload }),
  });
  const next = [...stagedFor(composerId).attachments, ...(result.attachments || [])];
  setStagedFor(composerId, next);
  const known = new Set((appState.attachments || []).map((item) => item.id));
  appState.attachments = [
    ...(appState.attachments || []),
    ...(result.attachments || []).filter((item) => !known.has(item.id)),
  ];
  updateComposerAttachmentStrip(composerId);
  toast(`${(result.attachments || []).length} attachment(s) staged`);
}

function clipboardScreenshotName(index = 0, type = 'image/png') {
  const ext = type.includes('jpeg') ? 'jpg' : type.includes('webp') ? 'webp' : 'png';
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-');
  return `screenshot-${stamp}${index ? `-${index + 1}` : ''}.${ext}`;
}

function normalizeClipboardFile(file, index) {
  if (!String(file.type || '').startsWith('image/')) return file;
  if (file.name && !/^image\.(png|jpg|jpeg|webp)$/i.test(file.name)) return file;
  try {
    return new File([file], clipboardScreenshotName(index, file.type), {
      type: file.type || 'image/png',
      lastModified: file.lastModified || Date.now(),
    });
  } catch {
    return file;
  }
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

function fanoutFormPayload() {
  const form = document.querySelector('#fanout-config-form');
  const current = appState?.settings?.fanoutApi || {};
  const data = form ? new FormData(form) : null;
  const apiKey = String(data?.get('apiKey') || '').trim();
  const payload = {
    enabled: data ? Boolean(data.get('enabled')) : Boolean(current.enabled),
    baseUrl: data?.get('baseUrl') ?? current.baseUrl ?? '',
    model: data?.get('model') ?? current.model ?? '',
    fallbackModel: data?.get('fallbackModel') ?? current.fallbackModel ?? '',
    timeoutMs: data?.get('timeoutMs') ?? current.timeoutMs ?? 5000,
    forceKeywords: data?.get('forceKeywords') ?? current.forceKeywords ?? [],
    clearApiKey: data ? Boolean(data.get('clearApiKey')) : false,
  };
  if (apiKey) payload.apiKey = apiKey;
  return payload;
}
