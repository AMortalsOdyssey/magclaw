function renderAgentInlineField(agent, field, label, { multiline = false, placeholder = '' } = {}) {
  const value = String(agent?.[field] || '');
  const isEditing = agentDetailEditState?.field === field;
  if (!isEditing) {
    const displayValue = value || (field === 'description' ? 'No description' : '--');
    return `
      <section class="agent-profile-field">
        <div class="agent-field-head">
          <span class="detail-label">${escapeHtml(label)}</span>
          <button class="agent-edit-pencil" type="button" data-action="edit-agent-field" data-field="${escapeHtml(field)}" aria-label="Edit ${escapeHtml(label)}" title="Edit ${escapeHtml(label)}">${editPencilIcon()}</button>
        </div>
        <div class="agent-field-value ${value ? '' : 'muted'}">${escapeHtml(displayValue)}</div>
      </section>
    `;
  }

  const descriptionValue = field === 'description' ? value.slice(0, 3000) : value;
  return `
    <section class="agent-profile-field editing">
      <div class="agent-field-head">
        <span class="detail-label">${escapeHtml(label)}</span>
      </div>
      <div class="agent-inline-edit" data-agent-id="${escapeHtml(agent.id)}" data-field="${escapeHtml(field)}">
        ${multiline
          ? `<textarea name="${escapeHtml(field)}" rows="3" maxlength="3000" placeholder="${escapeHtml(placeholder)}" data-agent-description-input>${escapeHtml(descriptionValue)}</textarea><small class="char-count" data-agent-description-count>${descriptionValue.length}/3000</small>`
          : `<input name="${escapeHtml(field)}" value="${escapeHtml(value)}" maxlength="80" placeholder="${escapeHtml(placeholder)}" />`}
        <div class="agent-inline-actions">
          <button class="primary-btn" type="button" data-action="save-agent-field" data-field="${escapeHtml(field)}">Save</button>
          <button class="secondary-btn" type="button" data-action="cancel-agent-field" data-field="${escapeHtml(field)}">Cancel</button>
        </div>
      </div>
    </section>
  `;
}

function renderAgentAvatarEditor(agent) {
  return `
    <section class="agent-profile-field agent-avatar-edit">
      <span class="detail-label">Avatar</span>
      <div class="agent-avatar-edit-row">
        <span class="agent-detail-avatar-frame">${getAvatarHtml(agent.id, 'agent', 'agent-detail-avatar-preview')}</span>
        <button class="secondary-btn" type="button" data-action="randomize-agent-detail-avatar" data-id="${escapeHtml(agent.id)}">Random</button>
        <button class="secondary-btn" type="button" data-action="pick-agent-detail-avatar" data-id="${escapeHtml(agent.id)}">Browse</button>
        <label class="secondary-btn file-btn">
          Upload
          <input class="visually-hidden agent-avatar-upload" type="file" accept="image/*" data-action="upload-agent-avatar" data-avatar-upload-target="agent-detail" data-id="${escapeHtml(agent.id)}" />
        </label>
      </div>
    </section>
  `;
}

function agentCreatorInfo(agent = {}) {
  const members = appState.cloud?.members || [];
  const byHuman = agent.createdByHumanId ? members.find((member) => member.humanId === agent.createdByHumanId) : null;
  const byUser = agent.createdByUserId ? members.find((member) => member.userId === agent.createdByUserId) : null;
  const member = byHuman || byUser || null;
  const human = byId(appState.humans, agent.createdByHumanId || member?.humanId) || member?.human || null;
  const user = member?.user || null;
  return {
    name: human?.displayName || human?.name || user?.name || agent.creatorName || '--',
    username: user?.email || human?.email || agent.creatorEmail || '--',
    userId: user?.id || agent.createdByUserId || '--',
  };
}

function canonicalRuntimeId(value = '') {
  const text = String(value || '').toLowerCase().trim().replace(/[\s_]+/g, '-');
  if (!text) return '';
  if (text === 'codex-cli' || text.startsWith('codex')) return 'codex';
  if (text === 'claude' || text === 'claude-cli' || text === 'claude-code' || text.startsWith('claude-code')) return 'claude-code';
  if (text === 'kimi-cli' || text.startsWith('kimi')) return 'kimi';
  if (text === 'cursor-cli' || text === 'cursor-agent' || text.startsWith('cursor')) return 'cursor';
  if (text === 'gemini-cli' || text.startsWith('gemini')) return 'gemini';
  if (text === 'copilot-cli' || text.startsWith('copilot')) return 'copilot';
  if (text.startsWith('opencode') || text === 'open-code') return 'opencode';
  return text;
}

function runtimeOptionsForAgent(agent = {}) {
  const options = runtimeOptionsForComputer(agent.computerId);
  const currentId = canonicalRuntimeId(agent.runtimeId || agent.runtime || '');
  if (currentId && !options.some((runtime) => canonicalRuntimeId(runtime.id || runtime.name || '') === currentId)) {
    options.unshift({
      id: currentId,
      name: agent.runtime || runtimeNameForId(currentId),
      installed: true,
      createSupported: true,
      models: agent.model ? [agent.model] : [],
      modelNames: agent.model ? [{ slug: agent.model, name: agent.model }] : [],
      defaultModel: agent.model || '',
      reasoningEffort: agent.reasoningEffort ? [agent.reasoningEffort] : [],
      defaultReasoningEffort: agent.reasoningEffort || '',
    });
  }
  return options;
}

function runtimeForAgent(agent) {
  const runtime = canonicalRuntimeId(agent?.runtimeId || agent?.runtime || '');
  return runtimeOptionsForAgent(agent).find((rt) => (
    canonicalRuntimeId(rt.id || rt.name || '') === runtime
  )) || runtimeOptionsForAgent(agent).find((rt) => rt.installed && rt.createSupported !== false) || null;
}

function renderAgentInfoSection(agent) {
  const computer = byId(appState.computers, agent.computerId);
  const creator = agentCreatorInfo(agent);
  const computerDisabled = typeof computerIsDisabled === 'function' ? computerIsDisabled(computer) : false;
  const computerStatus = computerDisabled ? 'disabled' : (computer?.status || 'offline');
  const daemonVersion = typeof renderDaemonVersionValue === 'function'
    ? renderDaemonVersionValue(computer?.daemonVersion, computer?.version, appState.runtime?.daemonPackageVersion)
    : escapeHtml(computer?.daemonVersion || computer?.version || appState.runtime?.daemonPackageVersion || '--');
  return `
    <section class="agent-profile-field agent-info-section">
      <span class="detail-label">Info</span>
      <div class="agent-compact-info">
        <div class="agent-compact-computer-row">
          <span class="agent-info-caption">Computer</span>
          <button class="agent-computer-linkline" type="button" data-action="select-computer" data-id="${escapeHtml(computer?.id || '')}" ${computer ? '' : 'disabled'}>
            <strong>${escapeHtml(computer?.name || agent.computerId || '--')}</strong>
            <span class="avatar-status-dot inline ${presenceClass(computerStatus)}"></span>
            <small>${escapeHtml(computerStatus === 'connected' ? 'Connected' : computerStatus || 'Disconnected')}</small>
            <span class="daemon-inline">daemon ${daemonVersion}</span>
          </button>
        </div>
        <div>
          <span class="agent-info-caption">Created</span>
          <strong>${escapeHtml(formatAgentBorn(agent.createdAt))}</strong>
        </div>
        <div>
          <span class="agent-info-caption">Creator</span>
          <strong>${escapeHtml(creator.name)}</strong>
        </div>
        <div>
          <span class="agent-info-caption">User</span>
          <strong>${escapeHtml(creator.username)} · ${escapeHtml(creator.userId)}</strong>
        </div>
      </div>
    </section>
  `;
}

function currentAgentEnvEditItems(agent) {
  if (!agentEnvEditState || agentEnvEditState.agentId !== agent.id) return null;
  return agentEnvEditState.items;
}

function renderAgentEnvVarsSection(agent) {
  const editingItems = currentAgentEnvEditItems(agent);
  const envVars = editingItems || agent.envVars || [];
  if (editingItems) {
    return `
      <section class="agent-profile-field agent-env-section editing">
        <div class="agent-field-head">
          <span class="detail-label">Environment Variables</span>
        </div>
        <div class="agent-env-edit-list">
          ${envVars.map((item, index) => `
            <div class="agent-env-row" data-index="${index}">
              <input type="text" placeholder="KEY" value="${escapeHtml(item.key || '')}" data-agent-env-index="${index}" data-agent-env-field="key" />
              <span class="env-eq">=</span>
              <input type="text" placeholder="value" value="${escapeHtml(item.value || '')}" data-agent-env-index="${index}" data-agent-env-field="value" />
              <button type="button" class="env-remove-btn" data-action="remove-agent-env-var" data-index="${index}">${trashIcon()}</button>
            </div>
          `).join('')}
        </div>
        <button class="agent-add-var" type="button" data-action="add-agent-env-var">+ Add Variable</button>
        <div class="agent-inline-actions align-end">
          <button class="primary-btn" type="button" data-action="save-agent-env" data-agent-id="${escapeHtml(agent.id)}">Save</button>
          <button class="secondary-btn" type="button" data-action="cancel-agent-env">Cancel</button>
        </div>
      </section>
    `;
  }
  return `
    <section class="agent-profile-field agent-env-section">
      <div class="agent-field-head">
        <span class="detail-label">Environment Variables</span>
        <button class="agent-edit-pencil" type="button" data-action="edit-agent-env" data-agent-id="${escapeHtml(agent.id)}" aria-label="Edit environment variables" title="Edit environment variables">${editPencilIcon()}</button>
      </div>
      ${envVars.length ? `
        <div class="env-vars-display">
          ${envVars.map((item) => `
            <div class="env-var-item">
              <span class="env-key-display">${escapeHtml(item.key)}</span>
              <span class="env-eq">=</span>
              <span class="env-value-display">${escapeHtml(item.value)}</span>
            </div>
          `).join('')}
        </div>
      ` : '<div class="agent-field-value muted">No environment variables configured</div>'}
    </section>
  `;
}

function runtimeModelOptionsForSelect(agent, runtime) {
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

function renderAgentRuntimeConfigSection(agent) {
  const runtimes = runtimeOptionsForAgent(agent);
  const currentRuntime = runtimeForAgent(agent) || runtimes[0] || null;
  const currentRuntimeId = currentRuntime?.id || agent.runtimeId || agent.runtime || '';
  const efforts = currentRuntime?.reasoningEffort || [];
  const currentEffort = agent.reasoningEffort || currentRuntime?.defaultReasoningEffort || '';
  const effortOptions = currentEffort && !efforts.includes(currentEffort) ? [currentEffort, ...efforts] : efforts;
  return `
    <section class="agent-profile-field agent-runtime-config-section">
      <div class="agent-field-head">
        <span class="detail-label">Runtime Configuration</span>
        <span class="runtime-restart-hint">RESTART TO APPLY RUNTIME CONFIGURATION</span>
      </div>
      <form id="agent-runtime-config-form" class="agent-runtime-config-form" data-agent-id="${escapeHtml(agent.id)}">
        <label>
          <span class="agent-info-caption">Runtime</span>
          <select name="runtimeId" class="agent-auto-select runtime-select">
            ${runtimes.map((runtime) => {
              const disabled = runtime.installed === false || runtime.createSupported === false;
              const suffix = runtime.installed === false ? ' (not installed)' : runtime.createSupported === false ? ' (not supported yet)' : '';
              return `<option value="${escapeHtml(runtime.id)}" ${disabled ? 'disabled' : ''} ${runtime.id === currentRuntimeId ? 'selected' : ''}>${escapeHtml((runtime.name || runtimeNameForId(runtime.id)) + suffix)}</option>`;
            }).join('')}
          </select>
        </label>
        <label>
          <span class="agent-info-caption">Model</span>
          <select name="model" class="agent-auto-select model-select">
            ${runtimeModelOptionsForSelect(agent, currentRuntime)}
          </select>
        </label>
        ${effortOptions.length ? `
        <label>
          <span class="agent-info-caption">Reasoning</span>
          <select name="reasoningEffort" class="agent-auto-select reasoning-select">
            ${effortOptions.map((effort) => `<option value="${escapeHtml(effort)}" ${effort === currentEffort ? 'selected' : ''}>${escapeHtml(effort.charAt(0).toUpperCase() + effort.slice(1))}</option>`).join('')}
          </select>
        </label>
        ` : ''}
        <button class="primary-btn compact" type="submit">Save</button>
      </form>
    </section>
  `;
}

function agentSkillsFor(agent) {
  return agentSkillsCache[agent.id] || null;
}

function renderAgentToolCapsules(tools = []) {
  if (!tools.length) return '<div class="agent-field-value muted">No MagClaw tools exposed yet</div>';
  return `
    <div class="agent-tool-grid">
      ${tools.map((tool) => `<span class="agent-tool-pill">${escapeHtml(tool)}</span>`).join('')}
    </div>
  `;
}

function agentSkillCount(skills) {
  return (skills?.workspace || []).length + (skills?.global || []).length + (skills?.plugin || []).length;
}

function renderSkillCollapseButton(sectionKey, title) {
  const collapsed = Boolean(collapsedSkillSections[sectionKey]);
  return `
    <button class="skill-collapse-btn" type="button" data-action="toggle-agent-skill-section" data-section="${escapeHtml(sectionKey)}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${escapeHtml(title)}" aria-expanded="${collapsed ? 'false' : 'true'}">
      <span aria-hidden="true">${collapsed ? '›' : '⌄'}</span>
    </button>
  `;
}

function renderAgentSkillSections(skills, { compact = false } = {}) {
  return `
    <div class="agent-skill-section-stack ${compact ? 'compact' : ''}">
      ${renderSkillList('Agent-Isolated Skills', skills?.workspace || [], 'No agent skills installed yet.', 'agent-skills')}
      ${renderSkillList('Global Codex Skills', skills?.global || [], 'No global Codex skills found.', 'global-skills')}
      ${renderSkillList('Plugin Skills', skills?.plugin || [], 'No plugin skills found.', 'plugin-skills')}
    </div>
  `;
}

function renderAgentCapabilitiesSection(agent) {
  const skills = agentSkillsFor(agent);
  const profileSkillsCollapsed = Boolean(collapsedSkillSections['profile-skills']);
  return `
    <section class="agent-profile-field agent-capabilities-section agent-skills-profile-section">
      <div class="agent-field-head agent-skills-profile-head">
        ${renderSkillCollapseButton('profile-skills', 'Skills')}
        <span class="detail-label">Skills${skills && !skills.loading && !skills.error ? ` (${agentSkillCount(skills)})` : ''}</span>
        <button class="agent-edit-pencil" type="button" data-action="refresh-agent-skills" data-agent-id="${escapeHtml(agent.id)}" aria-label="Rescan skills and tools" title="Rescan skills and tools">${refreshIcon()}</button>
      </div>
      ${skills?.error ? `<div class="agent-field-value error-text">${escapeHtml(skills.error)}</div>` : ''}
      ${!skills || skills.loading ? '<div class="agent-field-value muted">Scanning skills...</div>' : (profileSkillsCollapsed ? '' : renderAgentSkillSections(skills, { compact: true }))}
    </section>
  `;
}

function renderSkillList(title, skills = [], empty = 'No skills found.', sectionKey = title.toLowerCase().replace(/[^a-z0-9]+/g, '-')) {
  const collapsed = Boolean(collapsedSkillSections[sectionKey]);
  return `
    <section class="skill-list-section">
      <div class="skill-list-title">
        ${renderSkillCollapseButton(sectionKey, title)}
        <span>${escapeHtml(title)}</span>
        <em>${skills.length}</em>
      </div>
      ${collapsed ? '' : (skills.length ? `
        <div class="skill-list">
          ${skills.map((skill) => `
            <article class="skill-row">
              <div>
                <strong>${escapeHtml(skill.name || 'skill')}</strong>
                <p>${escapeHtml(skill.description || 'No description provided.')}</p>
              </div>
              <small>${escapeHtml(skill.plugin || skill.scope || '')} ${escapeHtml(skill.path || '')}</small>
            </article>
          `).join('')}
        </div>
      ` : `<div class="empty-box small">${escapeHtml(empty)}</div>`)}
    </section>
  `;
}

function renderAgentSkillsTab(agent) {
  const skills = agentSkillsFor(agent);
  if (!skills || skills.loading) return '<div class="empty-box small">Scanning Codex skills for this agent...</div>';
  if (skills.error) return `<div class="empty-box small error-text">${escapeHtml(skills.error)}</div>`;
  return `
    <div class="agent-skills-tab">
      <section class="skill-list-section">
        <div class="skill-list-title">
          ${renderSkillCollapseButton('magclaw-tools', 'MagClaw Function Calls')}
          <span>MagClaw Function Calls</span>
          <em>${(skills.tools || []).length}</em>
        </div>
        ${collapsedSkillSections['magclaw-tools'] ? '' : renderAgentToolCapsules(skills.tools || [])}
      </section>
      ${renderAgentSkillSections(skills)}
    </div>
  `;
}

function renderAgentProfileTab(agent) {
  return `
    <div class="agent-profile-tab">
      <div class="agent-profile-hero">
        <span class="agent-detail-avatar-frame hero-avatar">${getAvatarHtml(agent.id, 'agent', 'agent-detail-avatar-preview')}</span>
        <div>
          <h3>
            <span>${escapeHtml(agent.name)}</span>
            <span class="agent-hero-status"><span class="avatar-status-dot inline ${presenceClass(agentDisplayStatus(agent))}"></span>${escapeHtml(agentStatusLabel(agent))}</span>
          </h3>
          <p>${escapeHtml(agentHandle(agent))}</p>
        </div>
      </div>
      ${renderAgentAvatarEditor(agent)}
      ${renderAgentInlineField(agent, 'name', 'Display Name', { placeholder: 'Display name' })}
      ${renderAgentInlineField(agent, 'description', 'Description', { multiline: true, placeholder: 'Describe this agent...' })}
      ${renderAgentInfoSection(agent)}
      ${renderAgentRuntimeConfigSection(agent)}
      ${renderAgentEnvVarsSection(agent)}
      ${renderAgentCapabilitiesSection(agent)}
      <section class="agent-profile-field agent-actions-section">
        <span class="detail-label">Actions</span>
        <div class="agent-detail-actions">
          <button class="secondary-btn disabled-action" type="button" data-action="agent-stop-unavailable" data-id="${escapeHtml(agent.id)}" aria-disabled="true">Stop Agent</button>
          ${agentIsRunning(agent)
            ? `<button class="secondary-btn" type="button" data-action="open-agent-restart" data-id="${escapeHtml(agent.id)}">Restart / Reset</button>`
            : `<button class="secondary-btn" type="button" data-action="open-agent-restart" data-id="${escapeHtml(agent.id)}">Start / Restart</button>`}
          <button class="danger-btn" type="button" data-action="delete-agent" data-id="${escapeHtml(agent.id)}">Delete Agent</button>
        </div>
      </section>
    </div>
  `;
}

function renderAgentDmsTab(agent) {
  const dmIds = (appState.dms || [])
    .filter((dm) => dm.participantIds?.includes(agent.id))
    .map((dm) => dm.id);
  const messages = (appState.messages || [])
    .filter((message) => message.spaceType === 'dm' && dmIds.includes(message.spaceId))
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, 100);
  return `
    <div class="agent-dms-tab">
      ${messages.length ? messages.map((message) => `
        <article class="agent-dm-row">
          <time>${fmtTime(message.createdAt)}</time>
          <strong>${escapeHtml(displayName(message.authorId))}</strong>
          <div class="message-markdown">${renderMarkdownWithMentions(message.body || '')}</div>
        </article>
      `).join('') : '<div class="empty-box small">No DIRECT MESSAGES yet.</div>'}
    </div>
  `;
}

function renderAgentRemindersTab() {
  return '<div class="empty-box small">No reminders configured.</div>';
}

function agentActivityEvents(agent) {
  return (appState?.events || [])
    .filter((event) => event.agentId === agent.id || event.meta?.agentId === agent.id || event.raw?.agentId === agent.id)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .slice(0, AGENT_ACTIVITY_EVENT_LIMIT);
}

function agentActivityLabel(event) {
  const rawType = event?.raw?.type || event?.raw?.event || event?.type || 'activity';
  return String(rawType)
    .replace(/^agent_/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function agentActivityTone(event) {
  const text = `${event?.type || ''} ${event?.message || ''} ${event?.raw?.type || ''}`.toLowerCase();
  if (text.includes('error') || text.includes('failed')) return 'error';
  if (text.includes('output') || text.includes('message')) return 'output';
  if (text.includes('warming')) return 'warming';
  if (text.includes('thinking') || text.includes('working') || text.includes('running')) return 'busy';
  if (text.includes('idle') || text.includes('connected')) return 'online';
  return 'queued';
}

function renderAgentActivityTab(agent) {
  const events = agentActivityEvents(agent);
  return `
    <div class="agent-activity-tab">
      ${events.length ? `
        <div class="agent-activity-list">
          ${events.map((event) => `
            <div class="agent-activity-row">
              <time>${fmtTime(event.createdAt)}</time>
              <span class="agent-activity-dot ${presenceClass(agentActivityTone(event))}"></span>
              <div>
                <strong>${escapeHtml(agentActivityLabel(event))}</strong>
                <span>${escapeHtml(event.message || '')}</span>
              </div>
            </div>
          `).join('')}
        </div>
      ` : '<div class="empty-box small">No activity recorded yet.</div>'}
    </div>
  `;
}

function renderAgentDetailBody(agent) {
  if (agentDetailTab === 'skills') return renderAgentSkillsTab(agent);
  if (agentDetailTab === 'workspace') return renderAgentWorkspaceTab(agent);
  if (agentDetailTab === 'activity') return renderAgentActivityTab(agent);
  if (agentDetailTab === 'dms') return renderAgentDmsTab(agent);
  if (agentDetailTab === 'reminders') return renderAgentRemindersTab(agent);
  return renderAgentProfileTab(agent);
}

function renderAgentDetail(agent) {
  const running = agentIsRunning(agent);

  return `
    <section class="pixel-panel inspector-panel agent-detail agent-detail-shell">
      <div class="agent-detail-topbar">
        <div class="agent-detail-title">
          <span class="agent-detail-avatar-frame mini">${getAvatarHtml(agent.id, 'agent', 'agent-detail-avatar-preview')}</span>
          <div>
            <strong>${escapeHtml(agent.name)}</strong>
            <small>${escapeHtml(agent.description || agent.runtime || 'Agent')}</small>
          </div>
        </div>
        <div class="agent-header-actions">
          <button class="secondary-btn" type="button" data-action="open-dm-with-agent" data-id="${escapeHtml(agent.id)}">Message</button>
          <button class="secondary-btn disabled-action" type="button" data-action="agent-stop-unavailable" data-id="${escapeHtml(agent.id)}" aria-disabled="true">Stop Agent</button>
          ${running
              ? `<button class="secondary-btn" type="button" data-action="open-agent-restart" data-id="${escapeHtml(agent.id)}">Restart</button>`
              : `<button class="secondary-btn" type="button" data-action="open-agent-restart" data-id="${escapeHtml(agent.id)}">Start / Restart</button>`}
          <button class="icon-btn small" type="button" data-action="close-agent-detail" aria-label="Close agent detail">×</button>
        </div>
      </div>
      ${renderAgentDetailTabs()}
      <div class="agent-detail-content">
        ${renderAgentDetailBody(agent)}
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
  const desc = agent.description ? `<span class="agent-desc">${escapeHtml(agent.description)}</span>` : '';
  const status = agentDisplayStatus(agent);
  return `
    <button class="space-btn member-btn${active}" type="button" data-action="select-agent" data-id="${escapeHtml(agent.id)}">
      <span class="dm-avatar-wrap">
        ${getAvatarHtml(agent.id, 'agent', 'dm-avatar')}
      </span>
      <div class="member-info">
        <span class="dm-name">${escapeHtml(agent.name)}</span>
        ${desc}
      </div>
      <span class="member-status-side">${avatarStatusDot(status, 'Agent status')}</span>
    </button>
  `;
}

function renderAgentGroupsByComputer(agents = []) {
  const computers = appState.computers || [];
  const groups = new Map();
  for (const computer of computers) {
    if (computerIsDisabled(computer) || computerIsDeleted(computer)) continue;
    groups.set(computer.id, { id: computer.id, label: computer.name || computer.hostname || 'Computer', meta: computer.status || '', agents: [] });
  }
  groups.set('unassigned', { id: 'unassigned', label: 'Unassigned', meta: '', agents: [] });
  for (const agent of agents) {
    if (!agentIsActiveInWorkspace(agent)) continue;
    const key = agent.computerId && groups.has(agent.computerId) ? agent.computerId : 'unassigned';
    groups.get(key).agents.push(agent);
  }
  const visibleGroups = [...groups.values()].filter((group) => group.agents.length);
  if (!visibleGroups.length) return '<div class="empty-box small">No agents yet.</div>';
  return visibleGroups.map((group) => `
    <div class="agent-computer-group">
      <div class="agent-computer-group-title">
        <span>${escapeHtml(group.label)}</span>
        ${group.meta ? `<small>${avatarStatusDot(group.meta, 'Computer status')}</small>` : ''}
      </div>
      ${group.agents.map((agent) => renderAgentListItem(agent)).join('')}
    </div>
  `).join('');
}

function renderHumanListItem(human) {
  const active = selectedHumanId === human.id ? ' active' : '';
  const youLabel = humanIsCurrent(human) ? ' <em class="human-you-label">(you)</em>' : '';
  return `
    <button class="space-btn member-btn${active}" type="button" data-action="select-human" data-id="${escapeHtml(human.id)}">
      <span class="dm-avatar-wrap">
        ${renderHumanAvatar(human, 'dm-avatar')}
      </span>
      <div class="member-info">
        <span class="dm-name">${escapeHtml(human.name)}${youLabel}</span>
      </div>
      <span class="member-status-side">${avatarStatusDot(human.status, 'Human status')}</span>
    </button>
  `;
}

function renderComputerListItem(computer) {
  const active = selectedComputerId === computer.id ? ' active' : '';
  return `
    <button class="space-btn member-btn${active}" type="button" data-action="select-computer" data-id="${escapeHtml(computer.id)}">
      <span class="dm-avatar-wrap">
        ${typeof renderComputerIcon === 'function' ? renderComputerIcon(computer, 16) : `<span class="dm-avatar">${settingsIcon('computer', 16)}</span>`}
      </span>
      <div class="member-info">
        <span class="dm-name">${escapeHtml(computer.name)}</span>
      </div>
      <span class="member-status-side">${avatarStatusDot(computer.status, 'Computer status')}</span>
    </button>
  `;
}

function cloudMemberForHuman(human) {
  const email = String(human?.email || '').toLowerCase();
  return (appState.cloud?.members || []).find((member) => (
    member.humanId === human?.id
    || member.human?.id === human?.id
    || member.userId === human?.authUserId
    || (email && String(member.user?.email || member.email || '').toLowerCase() === email)
  )) || null;
}

function humanCreatedAgents(human) {
  const member = cloudMemberForHuman(human);
  return (appState.agents || []).filter((agent) => (
    !agentIsDeleted(agent)
    && (
      agent.createdBy === human?.id
      || agent.createdByHumanId === human?.id
      || agent.ownerHumanId === human?.id
      || agent.createdByUserId === human?.authUserId
      || agent.createdByUserId === member?.userId
    )
  ));
}

function humanIsCurrent(human = {}) {
  return humanMatchesCurrentAccount(human);
}

function humanJoinedLabel(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '--';
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}年${month}月${day}日 ${hour}:${minute}`;
}

function humanCanEditProfile(human = {}, member = null) {
  return humanIsCurrent(human) || Boolean(member && cloudCan('manage_member_roles'));
}

function renderHumanAvatarEditor(human, member) {
  if (!humanCanEditProfile(human, member)) return '';
  return `
    <section class="agent-profile-field human-avatar-edit">
      <span class="detail-label">Avatar</span>
      <div class="agent-avatar-edit-row">
        <span class="agent-detail-avatar-frame">${renderHumanAvatar(human, 'agent-detail-avatar-preview')}</span>
        <button class="secondary-btn" type="button" data-action="randomize-human-avatar" data-id="${escapeHtml(human.id)}">Random</button>
        <button class="secondary-btn" type="button" data-action="pick-human-avatar" data-id="${escapeHtml(human.id)}">Browse</button>
        <label class="secondary-btn file-btn">
          Upload
          <input class="visually-hidden human-avatar-upload" type="file" accept="image/*" data-avatar-upload-target="human-detail" data-id="${escapeHtml(human.id)}" />
        </label>
      </div>
    </section>
  `;
}

function renderHumanDescriptionField(human = {}, member = null) {
  const canEdit = humanCanEditProfile(human, member);
  const value = String(human.description || '').slice(0, 3000);
  const isEditing = canEdit && humanDescriptionEditState?.humanId === human.id;
  if (!isEditing) {
    return `
      <section class="agent-profile-field">
        <div class="agent-field-head">
          <span class="detail-label">Description</span>
          ${canEdit ? `<button class="agent-edit-pencil" type="button" data-action="edit-human-description" data-id="${escapeHtml(human.id)}" aria-label="Edit Description" title="Edit Description">${editPencilIcon()}</button>` : ''}
        </div>
        <div class="agent-field-value ${value ? '' : 'muted'}">${escapeHtml(value || 'No description')}</div>
      </section>
    `;
  }
  return `
    <section class="agent-profile-field editing">
      <div class="agent-field-head">
        <span class="detail-label">Description</span>
      </div>
      <div class="agent-inline-edit human-description-edit" data-human-id="${escapeHtml(human.id)}">
        <textarea name="description" rows="3" maxlength="3000" placeholder="Add a short profile description...">${escapeHtml(value)}</textarea>
        <small class="char-count">${value.length}/3000</small>
        <div class="agent-inline-actions">
          <button class="primary-btn" type="button" data-action="save-human-description">Save</button>
          <button class="secondary-btn" type="button" data-action="cancel-human-description">Cancel</button>
        </div>
      </div>
    </section>
  `;
}

function renderHumanDetail(human) {
  const member = cloudMemberForHuman(human);
  const createdAgents = humanCreatedAgents(human);
  const email = human.email || member?.user?.email || member?.email || '';
  const isCurrent = humanIsCurrent(human);
  const role = member ? cloudMemberDisplayRole(member) : human.role || 'member';
  const canManageThisMember = Boolean(member && !isCurrent && role !== 'owner' && (cloudCan('manage_member_roles') || cloudCanRemoveMemberRole(role)));
  const youLabel = isCurrent ? ' <em class="human-you-label">(you)</em>' : '';
  const displayName = escapeHtml(human.name || member?.user?.name || 'Human');
  const nameWithYouLabel = `${displayName}${youLabel}`;
  return `
    <section class="pixel-panel inspector-panel human-detail-page magclaw-profile-detail ${isCurrent ? 'is-current-human' : 'is-other-human'}">
      <div class="agent-detail-topbar">
        <div class="agent-detail-title">
          <span class="agent-detail-avatar-frame mini">${renderHumanAvatar(human, 'agent-detail-avatar-preview')}</span>
          <div>
            <strong class="human-detail-name">${nameWithYouLabel}</strong>
          </div>
        </div>
        <div class="agent-header-actions">
          <button class="secondary-btn" type="button" data-action="open-dm-with-human" data-id="${escapeHtml(human.id)}">Message</button>
          <button class="icon-btn small" type="button" data-action="close-human-detail" aria-label="Close human detail">×</button>
        </div>
      </div>
      <div class="human-detail-grid">
        ${renderHumanAvatarEditor(human, member)}
        ${renderHumanDescriptionField(human, member)}
        <section class="agent-profile-field human-info-section">
          <span class="detail-label">Info</span>
          <div class="human-info-list">
            <div><span>Role</span><strong class="role-pill">${escapeHtml(cloudRoleLabel(role))}</strong></div>
            <div><span>Email</span><strong>${escapeHtml(email || '--')}</strong></div>
            <div><span>Joined</span><strong>${escapeHtml(humanJoinedLabel(member?.joinedAt || human.joinedAt || human.createdAt))}</strong></div>
            <div><span>User ID</span><strong>${escapeHtml(member?.userId || human.authUserId || '--')}</strong></div>
          </div>
        </section>
        ${canManageThisMember ? `<section class="agent-profile-field human-actions-section">
          <span class="detail-label">Actions</span>
          <div class="agent-detail-actions">
            ${cloudCan('manage_member_roles') ? `<button class="secondary-btn" type="button" data-action="open-member-manage" data-id="${escapeHtml(member.id)}">Manage Role</button>` : ''}
            ${cloudCanRemoveMemberRole(role) ? `<button class="danger-btn" type="button" data-action="open-member-action-confirm" data-id="${escapeHtml(member.id)}" data-member-action="remove">Remove Member</button>` : ''}
          </div>
        </section>` : ''}
        <section class="agent-profile-field human-created-agents">
          <span class="detail-label">Created Agents (${createdAgents.length})</span>
          ${createdAgents.length ? `
            <div class="human-created-agent-list">
              ${createdAgents.map((agent) => (
                typeof renderComputerAgentCard === 'function'
                  ? renderComputerAgentCard(agent)
                  : `<button class="created-agent-row" type="button" data-action="select-agent" data-id="${escapeHtml(agent.id)}">${escapeHtml(agent.name || 'Agent')}</button>`
              )).join('')}
            </div>
          ` : '<div class="agent-field-value muted">No created agents</div>'}
        </section>
      </div>
    </section>
  `;
}

function renderReply(reply) {
  const authorClass = ['agent', 'human', 'system'].includes(reply.authorType) ? reply.authorType : 'unknown';
  const agentAuthorAttr = reply.authorType === 'agent' ? ` data-agent-author-id="${escapeHtml(reply.authorId)}"` : '';
  const highlighted = selectedSavedRecordId === reply.id ? ' highlighted' : '';
  const receiptTray = renderAgentReceiptTray(reply);
  const footer = renderMessageFooter({ receiptTray });
  return `
    <article class="message-card magclaw-message reply-card author-${authorClass}${highlighted}${receiptTray ? ' has-agent-receipts' : ''}" id="reply-${escapeHtml(reply.id)}" data-reply-id="${escapeHtml(reply.id)}" data-render-key="${escapeHtml(renderRecordKey(reply))}"${agentAuthorAttr}>
      ${renderActorAvatar(reply.authorId, reply.authorType)}
      <div class="message-body">
        <div class="message-meta">
          ${renderActorName(reply.authorId, reply.authorType)}
          <span class="sender-role">${escapeHtml(actorSubtitle(reply.authorId, reply.authorType, reply))}</span>
          <time>${fmtTime(reply.createdAt)}</time>
        </div>
        <div class="message-markdown">${renderMarkdownWithMentions(reply.body || '(attachment)')}</div>
        <div class="message-attachments">${attachmentLinks(reply.attachmentIds)}</div>
        ${renderMessageActions(reply, { threadContext: true })}
        ${footer}
      </div>
    </article>
  `;
}

function renderWorkspaceActivityDrawer() {
  const records = workspaceActivityRecords();
  const visible = records.slice(Math.max(0, records.length - workspaceActivityVisibleCount));
  const hiddenCount = Math.max(0, records.length - visible.length);
  return `
    <section class="pixel-panel inspector-panel workspace-activity-drawer">
      <div class="thread-head workspace-activity-head">
        <div>
          <strong>Workspace Activity</strong>
          <span>Members · Computers · System</span>
        </div>
        <div class="thread-head-actions">
          <button class="icon-btn small" type="button" data-action="close-workspace-activity" aria-label="Close workspace activity">×</button>
        </div>
      </div>
      <div class="workspace-activity-list" id="workspace-activity-list">
        ${hiddenCount ? `
          <button class="workspace-activity-load" type="button" data-action="load-more-workspace-activity">
            Load ${Math.min(WORKSPACE_ACTIVITY_VISIBLE_STEP, hiddenCount)} older
          </button>
        ` : ''}
        ${visible.length ? visible.map((item, index) => {
          const popoverId = `workspace-activity-popover-${index}`;
          const detail = item.detail || item.type || item.source;
          return `
            <article class="workspace-activity-row activity-${escapeHtml(item.kind)}">
              <span class="workspace-activity-icon">${escapeHtml(item.kind.slice(0, 2).toUpperCase())}</span>
              <div>
                <div class="workspace-activity-row-head">
                  <span class="workspace-activity-title-wrap">
                    <strong class="workspace-activity-title-trigger" tabindex="0" aria-describedby="${escapeHtml(popoverId)}">${escapeHtml(item.title)}</strong>
                    <span class="workspace-activity-popover" id="${escapeHtml(popoverId)}" role="tooltip">
                      <span class="workspace-activity-popover-title">${escapeHtml(item.title)}</span>
                      ${detail ? `<span class="workspace-activity-popover-detail">${escapeHtml(detail)}</span>` : ''}
                    </span>
                  </span>
                  <time>${fmtTime(item.createdAt)}</time>
                </div>
                <p class="workspace-activity-detail">${escapeHtml(detail)}</p>
                <div class="workspace-activity-tags">
                  <span>${escapeHtml(item.kind)}</span>
                  <span>${escapeHtml(item.source)}</span>
                </div>
              </div>
            </article>
          `;
        }).join('') : '<div class="empty-box small">No workspace activity yet.</div>'}
      </div>
    </section>
  `;
}

function renderThreadDrawer(message) {
  const replies = threadReplies(message.id);
  const task = message.taskId ? byId(appState.tasks, message.taskId) : null;
  const composerId = composerIdFor('thread', message.id);
  const replyWord = replies.length === 1 ? 'reply' : 'replies';
  return `
    <section class="pixel-panel inspector-panel thread-drawer">
      <div class="thread-head">
        <div>
          <strong>Thread</strong>
          <span>${escapeHtml(spaceName(message.spaceType, message.spaceId))}</span>
        </div>
        <div class="thread-head-actions">
          <button type="button" data-action="view-in-channel" data-id="${message.id}">View in channel</button>
          <button class="icon-btn small" type="button" data-action="close-thread" aria-label="Close thread">×</button>
        </div>
      </div>
      <div class="thread-context-wrap">
        <div class="thread-context" id="thread-context">
          <div class="thread-parent-card">
            ${renderMessage(message, { compact: true })}
          </div>
          ${task ? renderTaskLifecycle(task) : ''}
          <div class="thread-reply-divider">
            <span>Beginning of replies</span>
            <strong>${replies.length} ${replyWord}</strong>
          </div>
          ${replies.length ? `
            <div class="reply-list">
              ${replies.map(renderReply).join('')}
            </div>
          ` : ''}
        </div>
        ${backBottomButton('thread', 'thread-back-bottom')}
      </div>
      <div class="thread-tools">
        <span>${replies.length} ${replyWord}</span>
        ${task ? renderTaskInlineBadge(task, { showAssignee: false }) : ''}
      </div>
      ${renderComposer({ id: composerId, kind: 'thread', placeholder: 'Message thread' })}
    </section>
  `;
}

function renderTaskLifecycle(task) {
  return `
    <div class="task-lifecycle">
      <div class="task-lifecycle-top">
        <div>
          <span class="eyebrow">Task</span>
          <strong>#${escapeHtml(task.number || shortId(task.id))}</strong>
        </div>
        ${renderTaskStatusBadge(task.status)}
      </div>
      ${renderTaskStateFlow(task)}
      <div class="task-actions task-lifecycle-actions">
        ${renderTaskActionButtons(task, { includeThread: false })}
      </div>
      ${renderTaskHistoryCompact(task)}
    </div>
  `;
}

function taskHistoryIcon(type) {
  const value = String(type || '');
  if (value.includes('done') || value.includes('ended') || value.includes('approve')) return '✓';
  if (value.includes('review')) return '👀';
  if (value.includes('claim')) return '↗';
  if (value.includes('stop')) return '■';
  if (value.includes('create')) return '+';
  return '•';
}

function taskHistoryLabel(type) {
  const value = String(type || '').replace(/^agent_/, '').replace(/_/g, ' ');
  return value || 'updated';
}

function renderTaskHistoryCompact(task) {
  const history = Array.isArray(task.history) ? task.history.slice().reverse().slice(0, 4) : [];
  if (!history.length) return '<div class="empty-box small task-history-empty">No task history.</div>';
  return `
    <div class="task-lifecycle-events" aria-label="Task timeline">
      ${history.map((item) => `
        <div class="task-event-chip">
          <span class="task-event-icon">${escapeHtml(taskHistoryIcon(item.type))}</span>
          <span>${escapeHtml(taskHistoryLabel(item.type))}</span>
          <time>${fmtTime(item.createdAt)}</time>
          <strong>@${escapeHtml(displayName(item.actorId))}</strong>
        </div>
      `).join('')}
    </div>
  `;
}
