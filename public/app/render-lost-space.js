function consoleDeletedServers() {
  return appState?.cloud?.deletedWorkspaces || [];
}

function renderLostSpaceSettingsTab() {
  const deletedAgents = (appState.agents || []).filter(agentIsDeleted);
  return `
    <section class="cloud-layout lost-space-layout">
      <div class="pixel-panel cloud-card wide">
        <div class="panel-title"><span>Lost Space</span><span>${deletedAgents.length}</span></div>
        <p class="muted-note">Deleted Agents stay here with their configuration and history. They cannot run until restored.</p>
        <div class="lost-space-list">
          ${deletedAgents.length ? deletedAgents.map((agent) => {
            const computer = byId(appState.computers, agent.computerId);
            return `
              <article class="lost-space-row">
                <div class="lost-space-main">
                  ${getAvatarHtml(agent.id, 'agent', 'dm-avatar')}
                  <div>
                    <strong>${escapeHtml(agent.name || 'Agent')}</strong>
                    <small>${escapeHtml(runtimeConfigurationLabel(agent))}</small>
                    <span>Computer: ${escapeHtml(computer?.name || agent.computerId || '--')} · Deleted ${escapeHtml(fmtFullDateTime(agent.deletedAt || agent.archivedAt))}</span>
                  </div>
                </div>
                <button class="secondary-btn" type="button" data-action="restore-agent" data-id="${escapeHtml(agent.id)}">Restore Agent</button>
              </article>
            `;
          }).join('') : '<div class="empty-box small">No deleted Agents.</div>'}
        </div>
      </div>
    </section>
  `;
}

function renderConsoleLostSpace() {
  const servers = consoleDeletedServers();
  return `
    <section class="console-switch-page console-lost-space-page">
      <div class="console-switch-head">
        <div>
          <h2>Lost Space</h2>
          <p>Soft-deleted servers stay here with members, chats, Agents, Computer records, and configuration preserved.</p>
        </div>
      </div>
      <div class="console-switch-list">
        ${servers.length ? servers.map((server) => `
          <article class="pixel-panel cloud-card console-row lost-server-row">
            <div>
              <p class="eyebrow">Deleted server</p>
              <h3>${escapeHtml(server.name || server.slug || server.id)}</h3>
              <p>${displayServerSlug(server.slug || server.id) ? `/${escapeHtml(displayServerSlug(server.slug || server.id))} · ` : ''}deleted ${escapeHtml(fmtFullDateTime(server.deletedAt))}</p>
            </div>
            <button class="secondary-btn" type="button" data-action="restore-console-server" data-slug="${escapeHtml(server.slug || server.id || '')}">Restore Server</button>
          </article>
        `).join('') : '<div class="empty-box small">No deleted servers.</div>'}
      </div>
    </section>
  `;
}
