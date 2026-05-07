function renderModal() {
  const map = {
    channel: renderChannelModal,
    'edit-channel': renderEditChannelModal,
    'channel-members': renderChannelMembersModal,
    'add-channel-member': renderAddChannelMemberModal,
    'confirm-stop-all': renderStopAllConfirmModal,
    'confirm-sign-out': renderSignOutConfirmModal,
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
      title: 'Restart',
      body: 'Stop and restart the agent process. Keeps conversation history and workspace files.',
      tone: 'info',
    },
    {
      id: 'reset-session',
      title: 'Reset Session & Restart',
      body: 'Clear conversation history and restart. Workspace files (MEMORY.md, notes/) are preserved.',
      tone: 'warning',
    },
    {
      id: 'full-reset',
      title: 'Full Reset & Restart',
      body: 'Clear conversation history, delete all workspace files, and restart from scratch.',
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
        <strong>This will permanently delete all workspace files including MEMORY.md and notes/.</strong>
        <span>This cannot be undone.</span>
      </div>
    ` : ''}
    <div class="modal-actions confirm-stop-actions">
      <button type="button" class="secondary-btn" data-action="close-modal">Cancel</button>
      <button type="button" class="primary-btn ${active.tone === 'danger' ? 'danger-btn' : ''}" data-action="confirm-agent-restart">${escapeHtml(active.title)}</button>
    </div>
  `;
}

function renderProjectModal() {
  const channel = selectedSpaceType === 'channel' ? currentSpace() : null;
  const projects = projectsForSpace();
  return `
    ${modalHeader('Open Project', channel ? `#${channel.name}` : 'Channel project')}
    <div class="folder-picker-panel">
      <button class="primary-btn" type="button" data-action="pick-project-folder">Open Local Folder</button>
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
  return !['offline', 'error'].includes(String(agent?.status || '').toLowerCase());
}

function channelAssignableAgents() {
  return appState.agents || [];
}

function renderChannelModal() {
  const agents = channelAssignableAgents();
  const query = createChannelMemberSearchQuery.trim().toLowerCase();
  const visibleAgents = agents.filter((agent) => {
    if (!query) return true;
    return `${agent.name || ''} ${agent.description || ''} ${agent.runtime || ''}`.toLowerCase().includes(query);
  });
  return `
    ${modalHeader('Create Channel', 'Local collaboration')}
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
    : `<span class="dm-avatar member-avatar">${escapeHtml(displayAvatar(member.id, 'human'))}</span>`;
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
    ${avatar}
    <span class="member-main">
      <strong class="member-name">${escapeHtml(member.name)}</strong>
    </span>
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
          ${type === 'agent' ? getAvatarHtml(item.id, 'agent', 'dm-avatar member-avatar') : `<span class="dm-avatar member-avatar">${escapeHtml(displayAvatar(item.id, 'human'))}</span>`}
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

function renderChannelMembersModal() {
  const channel = selectedSpaceType === 'channel' ? currentSpace() : null;
  const members = getChannelMembers(selectedSpaceId);
  const isAllChannel = channel?.id === 'chan_all';
  const total = members.agents.length + members.humans.length;

  return `
    ${modalHeader(`MEMBERS (${total})`)}
    <div class="members-modal-content">
      <div class="members-section">
        <div class="members-section-title">Agents</div>
        <div class="members-list">
          ${members.agents.length ? members.agents.map((agent) => renderChannelMemberRow(agent, 'agent', isAllChannel)).join('') : '<div class="empty-box small">No agents in this channel</div>'}
        </div>
      </div>

      <div class="members-section">
        <div class="members-section-title">Humans</div>
        <div class="members-list">
          ${members.humans.length ? members.humans.map((human) => renderChannelMemberRow(human, 'human', isAllChannel)).join('') : '<div class="empty-box small">No humans in this channel</div>'}
        </div>
      </div>

      <div class="members-actions">
        ${!isAllChannel ? `<button class="member-add-btn" type="button" data-action="open-modal" data-modal="add-channel-member">+ Add Member</button>` : ''}
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
  const availableHumans = (appState.humans || []).filter((h) => !memberIds.includes(h.id) && h.id !== 'hum_local' && matches(h));
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
  const options = [...channelAssignableAgents(), ...(appState.humans || []).filter((human) => human.id !== 'hum_local')];
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
          <label class="secondary-btn file-btn">
            Upload
            <input class="visually-hidden agent-avatar-upload" type="file" accept="image/*" data-action="upload-agent-avatar" data-target="agent-create" />
          </label>
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
  if (appState.cloud?.auth?.currentUser) {
    return `
      ${modalHeader('Members', 'Cloud workspace directory')}
      <div class="modal-form">
        <div class="empty-box small">Invitations are managed from Settings → Members.</div>
        <button class="primary-btn" type="button" data-action="set-settings-tab" data-tab="members">Open Members</button>
      </div>
    `;
  }
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
