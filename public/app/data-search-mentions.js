function byId(list, id) {
  const indexed = typeof stateListItemById === 'function' ? stateListItemById(list, id) : undefined;
  if (indexed !== undefined) return indexed;
  return (list || []).find((item) => item?.id === id) || null;
}

function isAllChannel(channelOrId) {
  const channel = typeof channelOrId === 'string' ? byId(appState?.channels, channelOrId) : channelOrId;
  return Boolean(channel && (
    channel.id === 'chan_all'
    || channel.locked
    || channel.defaultChannel
    || String(channel.name || '').toLowerCase() === 'all'
  ));
}

function defaultChannelIdFromState() {
  const allChannel = (appState?.channels || []).find((channel) => isAllChannel(channel) && !channel.archived);
  return allChannel?.id || appState?.channels?.[0]?.id || 'chan_all';
}

function conversationRecord(id) {
  return byId(appState?.messages, id) || byId(appState?.replies, id);
}

function fmtTime(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '--';
  return date.toLocaleString([], {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function bytes(value) {
  const size = Number(value || 0);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function shortId(id) {
  return String(id || '').split('_').pop()?.slice(0, 6) || 'item';
}

function displayName(id) {
  if (id === 'agt_codex') return 'Codex';
  const runtimeActor = teamSharingRuntimeActorInfo(id);
  if (runtimeActor) return runtimeActor.label;
  const human = typeof humanByIdAny === 'function' ? humanByIdAny(id) : byId(appState?.humans, id);
  if (human) return human.name;
  const agent = typeof agentById === 'function' ? agentById(id) : byId(appState?.agents, id);
  if (agent) return agent.name;
  return id === 'system' ? 'Magclaw' : 'Unknown';
}

const SYSTEM_AVATAR_SRC = BRAND_LOGO_SRC;
const LEGACY_TEAM_SHARING_AUTHOR_IDS = new Set(['hum_local', 'team_sharing', 'team-sharing']);

function isLegacyTeamSharingAuthorId(authorId = '') {
  return LEGACY_TEAM_SHARING_AUTHOR_IDS.has(String(authorId || '').trim());
}

function teamSharingRuntimeActorInfo(idOrRuntime = '') {
  const value = String(idOrRuntime || '').trim().toLowerCase();
  if (!value) return null;
  if (value === 'team_sharing_codex' || value === 'codex') {
    return { id: 'codex', actorId: 'team_sharing_codex', label: 'Codex', sourceLabel: 'from Codex', short: '›_' };
  }
  if (value === 'team_sharing_claude_code' || value === 'claude_code' || value === 'claude-code' || value === 'claude') {
    return { id: 'claude-code', actorId: 'team_sharing_claude_code', label: 'Claude Code', sourceLabel: 'from Claude Code', short: 'CC' };
  }
  if (value.startsWith('team_sharing_')) {
    const label = value.replace(/^team_sharing_/, '').replace(/[_-]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
    return { id: 'runtime', actorId: value, label, sourceLabel: `from ${label}`, short: 'AI' };
  }
  return null;
}

function teamSharingRuntimeInfoForRecord(record = {}) {
  return teamSharingRuntimeActorInfo(record?.metadata?.teamSharing?.runtime)
    || teamSharingRuntimeActorInfo(record?.authorId);
}

function teamSharingSourceLabelForRecord(record = {}) {
  if (!record?.metadata?.teamSharing) return '';
  return teamSharingRuntimeInfoForRecord(record)?.sourceLabel || '';
}

function teamSharingPresentationModeForRecord(record = {}) {
  const mode = String(record?.metadata?.teamSharing?.presentation?.mode || '').trim().toLowerCase();
  return ['plan', 'goal', 'interaction'].includes(mode) ? mode : '';
}

function teamSharingPresentationClass(record = {}) {
  const mode = teamSharingPresentationModeForRecord(record);
  return mode ? ` team-sharing-mode-${mode}` : '';
}

function teamSharingPresentationBadgeLabel(mode = '') {
  if (mode === 'plan') return 'Plan';
  if (mode === 'goal') return 'Goal';
  if (mode === 'interaction') return 'Q&A';
  return '';
}

function teamSharingPresentationBadgeHtml(record = {}, options = {}) {
  const mode = teamSharingPresentationModeForRecord(record);
  const label = teamSharingPresentationBadgeLabel(mode);
  if (!label) return '';
  const compact = options.compact ? ' compact' : '';
  const icon = mode === 'goal'
    ? '<span class="team-sharing-presentation-goal-logo" aria-hidden="true"></span>'
    : '';
  return `<span class="team-sharing-presentation-badge team-sharing-presentation-badge-${escapeHtml(mode)}${compact}" aria-label="${escapeHtml(label)}">${icon}<span>${escapeHtml(label)}</span></span>`;
}

function teamSharingUploaderForRecord(record = {}) {
  const uploader = record?.metadata?.teamSharing?.uploader;
  return uploader && typeof uploader === 'object' ? uploader : null;
}

function teamSharingUploaderNameForRecord(record = {}) {
  return String(teamSharingUploaderForRecord(record)?.name || '').trim();
}

function teamSharingUploaderAvatarForRecord(record = {}) {
  return String(teamSharingUploaderForRecord(record)?.avatar || '').trim();
}

function teamSharingHumanForIdentityId(id = '') {
  const cleanId = String(id || '').trim();
  if (!cleanId || isLegacyTeamSharingAuthorId(cleanId)) return null;
  return typeof humanByIdAny === 'function' ? humanByIdAny(cleanId) : byId(appState?.humans, cleanId);
}

function teamSharingHumanIdentityForRecord(record = {}) {
  if (!record?.metadata?.teamSharing) return null;
  const uploader = teamSharingUploaderForRecord(record) || {};
  const uploaderId = String(uploader.id || uploader.humanId || '').trim();
  const authorId = String(record.authorId || '').trim();
  const human = teamSharingHumanForIdentityId(uploaderId)
    || (!isLegacyTeamSharingAuthorId(authorId)
      ? (typeof humanByIdAny === 'function' ? humanByIdAny(authorId) : byId(appState?.humans, authorId))
      : null);
  const id = uploaderId || human?.id || (!isLegacyTeamSharingAuthorId(authorId) ? authorId : '');
  const name = String(uploader.name || human?.name || '').trim();
  const email = String(uploader.email || uploader.userEmail || human?.email || '').trim();
  const authUserId = String(uploader.authUserId || uploader.userId || human?.authUserId || human?.userId || '').trim();
  const avatar = String(uploader.avatar || uploader.avatarUrl || human?.avatar || human?.avatarUrl || '').trim();
  if (!id && !name && !email && !avatar) return null;
  return {
    id,
    name,
    email,
    authUserId,
    userId: authUserId,
    avatar,
    human,
  };
}

function teamSharingUploaderMatchesCurrentAccount(identity = null) {
  if (!identity || typeof humanMatchesCurrentAccount !== 'function') return false;
  const candidate = identity.human || {
    id: identity.id || '',
    authUserId: identity.authUserId || identity.userId || '',
    email: identity.email || '',
    cloudMember: { userId: identity.userId || identity.authUserId || '' },
  };
  return humanMatchesCurrentAccount(candidate);
}

function teamSharingRuntimeAvatarHtml(info, cssClass = '') {
  const runtimeInfo = info || teamSharingRuntimeActorInfo('runtime');
  if (runtimeInfo.id === 'codex') {
    return `<span class="${cssClass} team-sharing-runtime-avatar team-sharing-runtime-avatar-codex" aria-label="${escapeHtml(runtimeInfo.label)}"><img src="/brand/codex-logo.png" alt="" loading="lazy" decoding="async"></span>`;
  }
  if (runtimeInfo.id === 'claude-code') {
    return `<span class="${cssClass} team-sharing-runtime-avatar team-sharing-runtime-avatar-claude" aria-label="${escapeHtml(runtimeInfo.label)}"><svg viewBox="0 0 64 64" role="img" aria-hidden="true"><rect width="64" height="64" rx="12" fill="#f8f3ed"/><path d="M32 7l4.3 16.7L48.2 11.8 39.1 26.7 56 22.2 41.1 31.8 56 41.4 39.1 36.9 48.2 51.8 36.3 39.9 32 57 27.7 39.9 15.8 51.8 24.9 36.9 8 41.4 22.9 31.8 8 22.2 24.9 26.7 15.8 11.8 27.7 23.7z" fill="#c15f3c"/></svg></span>`;
  }
  return `<span class="${cssClass} team-sharing-runtime-avatar team-sharing-runtime-avatar-${escapeHtml(runtimeInfo.id)}" aria-label="${escapeHtml(runtimeInfo.label)}"><span>${escapeHtml(runtimeInfo.short)}</span></span>`;
}

function legacyTeamSharingUploaderForRecord(record = {}) {
  if (!record?.metadata?.teamSharing) return null;
  const authorId = String(record.authorId || '').trim();
  if (!isLegacyTeamSharingAuthorId(authorId)) return null;
  return teamSharingHumanIdentityForRecord(record);
}

function teamSharingUploaderAvatarHtml(record = {}, cssClass = '') {
  const identity = teamSharingHumanIdentityForRecord(record);
  const avatar = identity?.avatar || '';
  const name = identity?.name || teamSharingUploaderNameForRecord(record) || 'Human';
  if (avatar) return `<img src="${escapeHtml(avatar)}" class="${cssClass} avatar-img" alt="${escapeHtml(name || 'Human')}" />`;
  const initials = String(name || 'HU').split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  return `<span class="${cssClass}">${escapeHtml(initials || 'HU')}</span>`;
}

function displayAvatar(id, type) {
  const name = displayName(id);
  if (type === 'system') return 'MC';
  return name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

function getAvatarHtml(id, type, cssClass = '') {
  if (type === 'system') {
    return `<img src="${SYSTEM_AVATAR_SRC}" class="${cssClass} avatar-img system-avatar-img" alt="Magclaw" />`;
  }
  const runtimeActor = teamSharingRuntimeActorInfo(id);
  if (runtimeActor) return teamSharingRuntimeAvatarHtml(runtimeActor, cssClass);
  const agent = typeof agentById === 'function' ? agentById(id) : byId(appState?.agents, id);
  if (agent?.avatar) {
    return `<img src="${escapeHtml(agent.avatar)}" class="${cssClass} avatar-img" alt="${escapeHtml(agent.name)}" />`;
  }
  const human = typeof humanByIdAny === 'function' ? humanByIdAny(id) : byId(appState?.humans, id);
  if (human?.avatar) {
    return `<img src="${escapeHtml(human.avatar)}" class="${cssClass} avatar-img" alt="${escapeHtml(human.name || 'Human')}" />`;
  }
  const initials = displayAvatar(id, type);
  return `<span class="${cssClass}">${escapeHtml(initials)}</span>`;
}

function agentHandle(agent) {
  return `@${String(agent?.name || 'agent').replace(/\s+/g, '')}`;
}

function detailValue(value, fallback = '-') {
  const text = String(value || '').trim();
  return text || fallback;
}

function agentRuntimeLabel(agent) {
  return typeof runtimeConfigurationLabel === 'function'
    ? runtimeConfigurationLabel(agent)
    : (agent?.runtime || agent?.runtimeId || 'Agent');
}

function actorCreatorLabel(item) {
  return detailValue(
    item?.creatorName
    || item?.createdByName
    || item?.cloudMember?.createdByName
    || (item?.createdBy ? displayName(item.createdBy) : ''),
  );
}

function renderHoverDetail(label, value) {
  return `
    <span class="agent-hover-detail">
      <b>${escapeHtml(label)}</b>
      <span>${escapeHtml(detailValue(value))}</span>
    </span>
  `;
}

function renderAgentHoverCard(agent) {
  const status = agent ? agentDisplayStatus(agent) : 'offline';
  const description = agent?.description || 'Agent';
  const runtime = agentRuntimeLabel(agent);
  return `
    <span class="agent-hover-card" role="tooltip">
      <span class="agent-hover-head">
        ${getAvatarHtml(agent.id, 'agent', 'dm-avatar member-avatar')}
        <span class="agent-hover-title">
          <strong>${escapeHtml(agent.name)}</strong>
          <span><span class="agent-hover-status-dot ${presenceClass(status)}"></span>${escapeHtml(status)}</span>
          <small>${escapeHtml(agentHandle(agent))}</small>
        </span>
      </span>
      <span class="agent-hover-description">${escapeHtml(description)}</span>
      <span class="agent-hover-details">
        ${renderHoverDetail('Name', agent?.name || '')}
        ${renderHoverDetail('Description', description)}
        ${renderHoverDetail('Runtime', runtime)}
        ${renderHoverDetail('Creator', actorCreatorLabel(agent))}
        ${renderHoverDetail('Created', agent?.createdAt ? fmtTime(agent.createdAt) : '')}
      </span>
    </span>
  `;
}

function renderAgentIdentityButton(agentId, className = '') {
  const agent = typeof agentById === 'function' ? agentById(agentId) : byId(appState?.agents, agentId);
  if (!agent) return '';
  return `
    <button class="agent-identity-button ${className}" type="button" data-action="select-agent" data-id="${escapeHtml(agent.id)}" aria-label="View ${escapeHtml(agent.name)}">
      ${getAvatarHtml(agent.id, 'agent', 'avatar-inner')}
      ${renderAgentHoverCard(agent)}
    </button>
  `;
}

function renderHumanIdentityButton(humanId, className = '') {
  const human = typeof humanByIdAny === 'function' ? humanByIdAny(humanId) : byId(appState?.humans, humanId);
  if (!human) return getAvatarHtml(humanId, 'human', 'avatar-inner');
  return `
    <button class="human-identity-button ${className}" type="button" data-action="select-human-inspector" data-id="${escapeHtml(human.id)}" aria-label="View ${escapeHtml(human.name || 'Human')}">
      ${getAvatarHtml(human.id, 'human', 'avatar-inner')}
      ${renderHumanHoverCard(human)}
    </button>
  `;
}

function humanRoleLabel(human) {
  const member = human && typeof cloudMemberForHuman === 'function' ? cloudMemberForHuman(human) : null;
  return member && typeof cloudMemberDisplayRole === 'function'
    ? cloudMemberDisplayRole(member)
    : (human?.role || 'Human');
}

function renderHumanHoverCard(human) {
  const role = humanRoleLabel(human);
  const thirdPartyName = typeof thirdPartyNameForHuman === 'function' ? thirdPartyNameForHuman(human) : '';
  return `
    <span class="agent-hover-card human-hover-card" role="tooltip">
      <span class="agent-hover-head">
        ${getAvatarHtml(human.id, 'human', 'dm-avatar member-avatar')}
        <span class="agent-hover-title">
          <strong>${escapeHtml(human.name || 'Human')}</strong>
          <span>${escapeHtml(role)}</span>
          ${human.email ? `<small>${escapeHtml(human.email)}</small>` : ''}
        </span>
      </span>
      <span class="agent-hover-details">
        ${renderHoverDetail('Name', human.name || 'Human')}
        ${thirdPartyName ? renderHoverDetail('Third-party Name', thirdPartyName) : ''}
        ${renderHoverDetail('Role', role)}
        ${renderHoverDetail('Creator', actorCreatorLabel(human))}
        ${renderHoverDetail('Created', human.createdAt ? fmtTime(human.createdAt) : '')}
      </span>
    </span>
  `;
}

const identityHoverTriggerSelector = [
  '.agent-identity-button',
  '.human-identity-button',
  '.mention-identity',
  '.agent-author-name',
  '.human-author-name',
  '.member-profile-btn',
].join(',');
const identityHoverScrollEventName = 'scroll';

let activeIdentityHoverTrigger = null;

function identityHoverTriggerFromEvent(event) {
  const trigger = event?.target?.closest?.(identityHoverTriggerSelector);
  if (!trigger || !trigger.querySelector?.('.agent-hover-card')) return null;
  return trigger;
}

function positionIdentityHoverCard(trigger) {
  const card = trigger?.querySelector?.('.agent-hover-card');
  if (!card || typeof card.getBoundingClientRect !== 'function') return;
  const triggerRect = trigger.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();
  const margin = 8;
  const gap = 8;
  const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 0;
  const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 0;
  const cardWidth = cardRect.width || card.offsetWidth || 248;
  const cardHeight = cardRect.height || card.offsetHeight || 160;
  let left = triggerRect.left;
  let top = triggerRect.bottom + gap;
  if (top + cardHeight + margin > viewportHeight && triggerRect.top - gap - cardHeight >= margin) {
    top = triggerRect.top - gap - cardHeight;
  }
  if (left + cardWidth + margin > viewportWidth) left = viewportWidth - cardWidth - margin;
  if (top + cardHeight + margin > viewportHeight) top = viewportHeight - cardHeight - margin;
  left = Math.max(margin, left);
  top = Math.max(margin, top);
  card.style.setProperty('--agent-hover-x', `${Math.round(left)}px`);
  card.style.setProperty('--agent-hover-y', `${Math.round(top)}px`);
}

function refreshActiveIdentityHoverCard() {
  if (!activeIdentityHoverTrigger) return;
  if (!document.contains(activeIdentityHoverTrigger)) {
    activeIdentityHoverTrigger = null;
    return;
  }
  positionIdentityHoverCard(activeIdentityHoverTrigger);
}

function handleIdentityHoverCardPointerOver(event) {
  const trigger = identityHoverTriggerFromEvent(event);
  if (!trigger) return;
  if (event.relatedTarget && trigger.contains(event.relatedTarget)) return;
  activeIdentityHoverTrigger = trigger;
  positionIdentityHoverCard(trigger);
}

function handleIdentityHoverCardFocusIn(event) {
  const trigger = identityHoverTriggerFromEvent(event);
  if (!trigger) return;
  activeIdentityHoverTrigger = trigger;
  positionIdentityHoverCard(trigger);
}

function handleIdentityHoverCardPointerOut(event) {
  const trigger = activeIdentityHoverTrigger;
  if (!trigger || (event.relatedTarget && trigger.contains(event.relatedTarget))) return;
  activeIdentityHoverTrigger = null;
}

function handleIdentityHoverCardFocusOut(event) {
  const trigger = activeIdentityHoverTrigger;
  if (!trigger || (event.relatedTarget && trigger.contains(event.relatedTarget))) return;
  activeIdentityHoverTrigger = null;
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  document.addEventListener('pointerover', handleIdentityHoverCardPointerOver);
  document.addEventListener('pointerout', handleIdentityHoverCardPointerOut);
  document.addEventListener('focusin', handleIdentityHoverCardFocusIn);
  document.addEventListener('focusout', handleIdentityHoverCardFocusOut);
  document.addEventListener(identityHoverScrollEventName, refreshActiveIdentityHoverCard, true);
  window.addEventListener('resize', refreshActiveIdentityHoverCard);
}

function renderActorAvatar(authorId, authorType, record = {}) {
  if (authorType === 'agent') {
    const runtimeActor = teamSharingRuntimeInfoForRecord(record) || teamSharingRuntimeActorInfo(authorId);
    if (runtimeActor) {
      return `<div class="avatar agent-avatar-cell team-sharing-runtime-avatar-cell">${teamSharingRuntimeAvatarHtml(runtimeActor, 'avatar-inner')}</div>`;
    }
    return `<div class="avatar agent-avatar-cell">${renderAgentIdentityButton(authorId, 'agent-avatar-button')}${agentStatusDot(authorId, authorType)}</div>`;
  }
  if (authorType === 'human') {
    const human = typeof humanByIdAny === 'function' ? humanByIdAny(authorId) : byId(appState?.humans, authorId);
    const teamSharingIdentity = teamSharingHumanIdentityForRecord(record);
    const legacyTeamSharingRecord = Boolean(record?.metadata?.teamSharing && isLegacyTeamSharingAuthorId(authorId));
    if (legacyTeamSharingRecord || (!human && teamSharingIdentity)) {
      const identityHuman = teamSharingIdentity?.human || null;
      const statusId = identityHuman?.id || teamSharingIdentity?.id || authorId;
      if (identityHuman && typeof renderHumanIdentityButton === 'function') {
        return `<div class="avatar human-avatar-cell">${renderHumanIdentityButton(identityHuman.id, 'human-avatar-button')}${humanStatusDot(identityHuman.id, authorType)}</div>`;
      }
      return `<div class="avatar human-avatar-cell">${teamSharingUploaderAvatarHtml(record, 'avatar-inner')}${statusId ? humanStatusDot(statusId, authorType) : ''}</div>`;
    }
    return `<div class="avatar human-avatar-cell">${renderHumanIdentityButton(authorId, 'human-avatar-button')}${humanStatusDot(authorId, authorType)}</div>`;
  }
  return `<div class="avatar">${getAvatarHtml(authorId, authorType, 'avatar-inner')}${humanStatusDot(authorId, authorType)}</div>`;
}

function renderHumanYouLabel(human) {
  if (!human || typeof humanMatchesCurrentAccount !== 'function') return '';
  return humanMatchesCurrentAccount(human) ? '<em class="human-you-label">(you)</em>' : '';
}

function renderTeamSharingUploaderYouLabel(identity = null) {
  return teamSharingUploaderMatchesCurrentAccount(identity) ? '<em class="human-you-label">(you)</em>' : '';
}

function renderActorName(authorId, authorType, record = {}) {
  if (authorType === 'human') {
    const legacyUploader = legacyTeamSharingUploaderForRecord(record);
    if (legacyUploader) {
      const legacyName = legacyUploader.name || 'Human';
      const youLabel = renderTeamSharingUploaderYouLabel(legacyUploader);
      const badge = typeof humanBadgeHtml === 'function' ? humanBadgeHtml() : '';
      if (legacyUploader.human) {
        return `
          <button class="human-author-name" type="button" data-action="select-human-inspector" data-id="${escapeHtml(legacyUploader.human.id)}">
            <strong>${escapeHtml(legacyName)}</strong>${youLabel}${badge}
            ${renderHumanHoverCard(legacyUploader.human)}
          </button>
        `;
      }
      return `<span class="human-author-name"><strong>${escapeHtml(legacyName)}</strong>${youLabel}${badge}</span>`;
    }
    const human = typeof humanByIdAny === 'function' ? humanByIdAny(authorId) : byId(appState?.humans, authorId);
    const youLabel = renderHumanYouLabel(human);
    const teamSharingIdentity = teamSharingHumanIdentityForRecord(record);
    const fallbackName = teamSharingIdentity?.name || displayName(authorId);
    if (!human && teamSharingIdentity) {
      const teamSharingYouLabel = renderTeamSharingUploaderYouLabel(teamSharingIdentity);
      const badge = typeof humanBadgeHtml === 'function' ? humanBadgeHtml() : '';
      return `<span class="human-author-name"><strong>${escapeHtml(fallbackName)}</strong>${teamSharingYouLabel}${badge}</span>`;
    }
    return `
      <button class="human-author-name" type="button" data-action="select-human-inspector" data-id="${escapeHtml(authorId)}">
        <strong>${escapeHtml(fallbackName)}</strong>${youLabel}${humanBadgeHtml()}
        ${human ? renderHumanHoverCard(human) : ''}
      </button>
    `;
  }
  if (authorType !== 'agent') return `<strong>${escapeHtml(displayName(authorId))}</strong>`;
  const runtimeActor = teamSharingRuntimeInfoForRecord(record) || teamSharingRuntimeActorInfo(authorId);
  if (runtimeActor) return `<strong class="team-sharing-runtime-name">${escapeHtml(runtimeActor.label)}</strong>`;
  const agent = typeof agentById === 'function' ? agentById(authorId) : byId(appState?.agents, authorId);
  if (!agent) return `<strong>${escapeHtml(displayName(authorId))}</strong>`;
  return `
    <button class="agent-author-name" type="button" data-action="select-agent" data-id="${escapeHtml(agent.id)}">
      <strong>${escapeHtml(agent.name)}</strong>
      ${renderAgentHoverCard(agent)}
    </button>
  `;
}

// Parse <@id> and <!special> mentions into styled spans for display
function parseMentions(text) {
  if (!text) return '';
  let result = escapeHtml(text);
  // Replace agent mentions: <@agt_xxx> -> styled span
  result = result.replace(/&lt;@(agt_\w+)&gt;/g, (match, id) => {
    const agent = typeof agentById === 'function' ? agentById(id) : byId(appState?.agents, id);
    const name = agent?.name || (id === 'agt_codex' ? displayName(id) : '');
    return name
      ? `<button class="mention-tag mention-identity mention-agent" type="button" data-action="select-agent" data-id="${escapeHtml(id)}" data-mention-id="${escapeHtml(id)}">@${escapeHtml(name)}${agent ? renderAgentHoverCard(agent) : ''}</button>`
      : match;
  });
  // Replace human mentions: <@hum_xxx> -> styled span
  result = result.replace(/&lt;@(hum_\w+)&gt;/g, (match, id) => {
    const human = typeof humanByIdAny === 'function' ? humanByIdAny(id) : byId(appState?.humans, id);
    return human
      ? `<button class="mention-tag mention-identity mention-human" type="button" data-action="select-human-inspector" data-id="${escapeHtml(human.id)}" data-mention-id="${escapeHtml(id)}">@${escapeHtml(human.name)}${mentionThirdPartyInlineHtml(human)}${renderHumanHoverCard(human)}</button>`
      : match;
  });
  // Replace special mentions: <!all>, <!here> -> styled span
  result = result.replace(/&lt;!(all|here|channel|everyone)&gt;/g, (match, type) => {
    const channelClass = type === 'channel' ? ' mention-channel' : '';
    return `<span class="mention-tag mention-special${channelClass}" data-mention-type="${type}">@${type}</span>`;
  });
  result = result.replace(/&lt;#(chan_\w+)&gt;/g, (match, id) => {
    const channel = byId(appState?.channels, id);
    return channel
      ? `<span class="mention-tag mention-channel" data-channel-id="${escapeHtml(id)}">#${escapeHtml(channel.name)}</span>`
      : match;
  });
  result = result.replace(/&lt;#(file|folder):([^:]+):([^&]*)&gt;/g, (match, kind, projectId, encodedPath) => {
    const relPath = decodeReferencePath(encodedPath);
    const name = referenceDisplayName(projectId, relPath, kind);
    return `<span class="mention-tag mention-${kind}" data-reference-kind="${kind}" data-project-id="${escapeHtml(projectId)}">@${escapeHtml(name)}</span>`;
  });
  return result;
}

function plainMentionText(text) {
  if (!text) return '';
  return String(text)
    .replace(/<@(agt_\w+|hum_\w+)>/g, (_, id) => `@${displayName(id)}`)
    .replace(/<!(all|here|channel|everyone)>/g, (_, type) => `@${type}`)
    .replace(/<#(file|folder):([^:]+):([^>]*)>/g, (_, kind, projectId, encodedPath) => `@${referenceDisplayName(projectId, decodeReferencePath(encodedPath), kind)}`)
    .replace(/\b(agt_\w+|hum_\w+)\b/g, (_, id) => displayName(id))
    .replace(/\s+/g, ' ')
    .trim();
}

function plainActorText(text) {
  return String(text || '').replace(/\b(agt_\w+|hum_\w+)\b/g, (_, id) => displayName(id));
}

function displayNameFromState(stateSnapshot, id) {
  if (id === 'agt_codex') return 'Codex';
  const human = typeof humanById === 'function' ? humanById(id, stateSnapshot) : byId(stateSnapshot?.humans, id);
  if (human) return human.name;
  const agent = typeof agentById === 'function' ? agentById(id, stateSnapshot) : byId(stateSnapshot?.agents, id);
  if (agent) return agent.name;
  return id === 'system' ? 'Magclaw' : 'Unknown';
}

function spaceNameFromState(stateSnapshot, spaceType, spaceId) {
  if (spaceType === 'channel') return `#${byId(stateSnapshot?.channels, spaceId)?.name || 'missing'}`;
  const dm = byId(stateSnapshot?.dms, spaceId);
  const other = typeof dmPeerInfo === 'function' && stateSnapshot === appState
    ? dmPeerInfo(dm)?.peer?.id
    : dm?.participantIds?.find((id) => id !== currentHumanId(stateSnapshot));
  return `@${displayNameFromState(stateSnapshot, other || 'unknown')}`;
}

function plainNotificationText(text, stateSnapshot) {
  return String(text || '')
    .replace(/<@(agt_\w+|hum_\w+)>/g, (_, id) => `@${displayNameFromState(stateSnapshot, id)}`)
    .replace(/<!(all|here|channel|everyone)>/g, (_, type) => `@${type}`)
    .replace(/<#(file|folder):([^:]+):([^>]*)>/g, (_, kind, projectId, encodedPath) => `@${referenceDisplayName(projectId, decodeReferencePath(encodedPath), kind)}`)
    .replace(/\b(agt_\w+|hum_\w+)\b/g, (_, id) => displayNameFromState(stateSnapshot, id))
    .replace(/[`*_>#\[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function searchTerms(query) {
  const normalized = normalizeSearchText(query);
  if (!normalized) return [];
  const parts = normalized.split(/\s+/).filter(Boolean);
  return parts.length > 1 ? parts : [normalized];
}

function countSearchOccurrences(haystack, needle) {
  if (!haystack || !needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + Math.max(1, needle.length));
  }
  return count;
}

function searchRecordBody(record) {
  return plainMentionText(record?.body || '');
}

function searchRecordText(record) {
  const parent = record?.parentMessageId ? byId(appState?.messages, record.parentMessageId) : null;
  const taskId = record?.taskId || parent?.taskId;
  const task = typeof taskById === 'function' ? taskById(taskId) : byId(appState?.tasks, taskId);
  return [
    searchRecordBody(record),
    displayName(record?.authorId),
    actorSubtitle(record?.authorId, record?.authorType, record),
    recordSpaceName(record),
    parent ? searchRecordBody(parent) : '',
    task?.title || '',
    task?.body || '',
  ].filter(Boolean).join(' ');
}

function searchScore(record, query) {
  const normalizedQuery = normalizeSearchText(query);
  const terms = searchTerms(query);
  if (!normalizedQuery || !terms.length) return null;

  const body = normalizeSearchText(searchRecordBody(record));
  const fullText = normalizeSearchText(searchRecordText(record));
  const phraseInBody = body.indexOf(normalizedQuery);
  const phraseInText = fullText.indexOf(normalizedQuery);
  const termsMatch = terms.every((term) => fullText.includes(term));
  if (phraseInBody < 0 && phraseInText < 0 && !termsMatch) return null;

  let score = 0;
  if (phraseInBody >= 0) score += 120;
  else if (phraseInText >= 0) score += 70;
  if (body.startsWith(normalizedQuery)) score += 40;
  if (record?.parentMessageId) score -= 4;

  for (const term of terms) {
    score += countSearchOccurrences(body, term) * 14;
    if (fullText.includes(term)) score += 6;
  }

  const created = new Date(record?.updatedAt || record?.createdAt || 0).getTime();
  return { score, created: Number.isNaN(created) ? 0 : created };
}

function searchRecords(query) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];
  return [...(appState?.messages || []), ...(appState?.replies || [])]
    .map((record) => ({ record, match: searchScore(record, query) }))
    .filter((item) => item.match)
    .sort((a, b) => b.match.score - a.match.score || b.match.created - a.match.created)
    .slice(0, SEARCH_RESULT_LIMIT)
    .map((item) => item.record);
}

function searchRangeBounds(range) {
  if (range === 'today') {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return { after: start.getTime() };
  }
  if (range === '7d' || range === '30d') {
    const days = range === '7d' ? 7 : 30;
    return { after: Date.now() - days * 24 * 60 * 60 * 1000 };
  }
  return {};
}

function actorSearchLabel(id = '') {
  const actorId = String(id || '').trim();
  if (!actorId) return 'Unknown';
  if (actorId === 'system') return 'System';
  return displayName(actorId) || actorId;
}

function actorSearchType(id = '') {
  const actorId = String(id || '').trim();
  if (!actorId) return 'unknown';
  if (actorId === 'system') return 'system';
  if ((appState?.humans || []).some((human) => human.id === actorId)) return 'human';
  if ((appState?.agents || []).some((agent) => agent.id === actorId)) return 'agent';
  return 'unknown';
}

function searchSenderOptions() {
  const seen = new Map();
  const add = (id, type = '') => {
    const actorId = String(id || '').trim();
    if (!actorId || seen.has(actorId)) return;
    seen.set(actorId, {
      id: actorId,
      label: actorSearchLabel(actorId),
      type: type || actorSearchType(actorId),
      isMe: actorId === currentHumanId(),
    });
  };
  add(currentHumanId(), 'human');
  for (const human of appState?.humans || []) add(human.id, 'human');
  for (const agent of appState?.agents || []) add(agent.id, 'agent');
  for (const record of [...(appState?.messages || []), ...(appState?.replies || [])]) {
    add(record?.authorId, record?.authorType || '');
  }
  return [...seen.values()].sort((a, b) => {
    if (a.isMe !== b.isMe) return a.isMe ? -1 : 1;
    const typeRank = { human: 0, agent: 1, system: 2, unknown: 3 };
    const rank = (typeRank[a.type] ?? 9) - (typeRank[b.type] ?? 9);
    return rank || a.label.localeCompare(b.label);
  });
}

function selectedSearchSender() {
  return searchSenderOptions().find((item) => item.id === searchSenderId) || null;
}

function filteredSearchSenderOptions() {
  const query = normalizeSearchText(searchSenderQuery);
  const options = searchSenderOptions();
  if (!query) return options;
  return options.filter((item) => normalizeSearchText(`${item.label} ${item.type}`).includes(query));
}

function searchChannelOptions() {
  return (appState?.channels || [])
    .filter((channel) => channel && !channel.archived && !channel.archivedAt)
    .map((channel) => ({
      id: channel.id,
      label: `#${channel.name || channel.id}`,
      meta: typeof currentUserIsChannelMember === 'function' && currentUserIsChannelMember(channel) ? 'Channel' : 'Channel',
    }))
    .sort((a, b) => {
      if (a.id === 'chan_all') return -1;
      if (b.id === 'chan_all') return 1;
      return a.label.localeCompare(b.label);
    });
}

function selectedSearchChannel() {
  return searchChannelOptions().find((item) => item.id === searchChannelId) || null;
}

function filteredSearchChannelOptions() {
  const query = normalizeSearchText(searchChannelQuery);
  const options = searchChannelOptions();
  if (!query) return options;
  return options.filter((item) => normalizeSearchText(`${item.label} ${item.meta}`).includes(query));
}

function searchHasActiveCriteria() {
  return Boolean(searchQuery.trim() || searchSenderId || searchChannelId || searchTimeRange !== 'any');
}

function searchRecordMatchesFilters(record) {
  const currentUserId = currentHumanId();
  if (searchMineOnly && record?.authorId !== currentUserId) return false;
  if (searchSenderId && record?.authorId !== searchSenderId) return false;
  if (searchChannelId) {
    const root = record?.parentMessageId ? byId(appState?.messages, record.parentMessageId) : record;
    if (root?.spaceType !== 'channel' || root?.spaceId !== searchChannelId) return false;
  }
  const bounds = searchRangeBounds(searchTimeRange);
  if (bounds.after) {
    const created = new Date(record?.createdAt || 0).getTime();
    if (!created || created < bounds.after) return false;
  }
  return true;
}

function currentSearchMessageResults() {
  if (searchRemoteResults.length || searchHasActiveCriteria()) {
    return searchRemoteResults.filter(searchRecordMatchesFilters);
  }
  return searchRecords(searchQuery).filter(searchRecordMatchesFilters);
}

function mergeSearchResponseIntoState(result = {}) {
  const mergeById = (key, records = []) => {
    if (!Array.isArray(appState?.[key])) return;
    const byId = new Map(appState[key].map((record, index) => [record.id, { record, index }]));
    for (const record of records || []) {
      if (!record?.id) continue;
      const existing = byId.get(record.id);
      if (existing) {
        appState[key][existing.index] = { ...existing.record, ...record };
      } else {
        appState[key].push(record);
      }
    }
  };
  mergeById('messages', [...(result.messages || []), ...(result.parents || [])]);
  mergeById('replies', result.replies || []);
}

function searchRequestParams() {
  const params = new URLSearchParams();
  if (searchQuery.trim()) params.set('q', searchQuery.trim());
  if (searchSenderId) params.set('senderId', searchSenderId);
  if (searchChannelId) params.set('channelId', searchChannelId);
  if (searchTimeRange !== 'any') params.set('range', searchTimeRange);
  params.set('limit', String(Math.max(SEARCH_PAGE_SIZE, searchVisibleCount)));
  return params;
}

function searchRouteQueryString() {
  const params = new URLSearchParams();
  if (searchQuery.trim()) params.set('q', searchQuery.trim());
  if (searchMineOnly) params.set('filter', 'mine');
  if (searchSenderId) params.set('sender', searchSenderId);
  if (searchChannelId) params.set('channel', searchChannelId);
  if (searchTimeRange !== 'any') params.set('range', searchTimeRange);
  if (threadMessageId) {
    params.set('open', 'thread');
    params.set('thread', threadMessageId);
  }
  if (selectedSavedRecordId) params.set('msg', selectedSavedRecordId);
  const value = params.toString();
  return value ? `?${value}` : '';
}

function persistSearchState() {
  writeJsonStorage('magclawSearchState', {
    query: searchQuery,
    senderId: searchSenderId,
    channelId: searchChannelId,
    mineOnly: searchMineOnly,
    timeRange: searchTimeRange,
    visibleCount: searchVisibleCount,
    selectedResultId: selectedSavedRecordId,
  });
  if (activeView === 'search') syncBrowserRouteForActiveView({ replace: true });
}

async function fetchSearchResults() {
  const params = searchRequestParams();
  const requestKey = params.toString();
  if (!searchHasActiveCriteria()) {
    searchRemoteResults = [];
    searchRemoteParents = [];
    searchRemoteLoading = false;
    searchRemoteError = '';
    searchLastRequestKey = '';
    updateSearchResults({ skipFetch: true });
    return;
  }
  const seq = searchRequestSeq + 1;
  searchRequestSeq = seq;
  searchRemoteLoading = true;
  searchRemoteError = '';
  searchLastRequestKey = requestKey;
  updateSearchResults({ skipFetch: true });
  try {
    const result = await api(`/api/search/messages?${requestKey}`);
    if (seq !== searchRequestSeq) return;
    mergeSearchResponseIntoState(result);
    searchRemoteResults = Array.isArray(result.results) ? result.results : [];
    searchRemoteParents = Array.isArray(result.parents) ? result.parents : [];
    searchRemoteLoading = false;
    searchRemoteError = '';
  } catch (error) {
    if (seq !== searchRequestSeq) return;
    searchRemoteLoading = false;
    searchRemoteError = error.message || 'Search failed';
  }
  updateSearchResults({ skipFetch: true });
}

function queueSearchResultsRefresh() {
  persistSearchState();
  queueSearchChannelPathResolve();
  if (searchRequestTimer) window.clearTimeout(searchRequestTimer);
  if (!searchHasActiveCriteria()) {
    searchRemoteResults = [];
    searchRemoteParents = [];
    searchRemoteLoading = false;
    searchRemoteError = '';
    searchLastRequestKey = '';
    updateSearchResults({ skipFetch: true });
    return;
  }
  updateSearchResults({ skipFetch: true });
  searchRequestTimer = window.setTimeout(() => {
    fetchSearchResults();
  }, 120);
}

function searchChannelPathCandidate(value = searchQuery) {
  const text = String(value || '').trim();
  if (!text) return null;
  const signed = text.match(/mc:\/\/magclaw\/server\/[^\s<>"'`]+\/channel\/[^\s<>"'`?]+(?:\?[^\s<>"'`]+)?/)?.[0] || '';
  if (signed) return { key: signed, raw: signed, kind: 'signed' };
  let parsed = null;
  try {
    parsed = text.startsWith('/s/')
      ? new URL(text, window.location.origin || 'http://magclaw.local')
      : new URL(text);
  } catch {
    return null;
  }
  const match = String(parsed.pathname || '').match(/^\/s\/([^/]+)\/channels\/([^/]+)/);
  if (!match) return null;
  const raw = `${parsed.pathname}${parsed.search || ''}`;
  return {
    key: raw,
    raw,
    kind: 'route',
  };
}

function searchChannelPathRenderState() {
  const candidate = searchChannelPathCandidate();
  if (!candidate) return null;
  if (searchChannelPathResolveState.key !== candidate.key) {
    return { status: 'loading', raw: candidate.raw, kind: candidate.kind };
  }
  if (searchChannelPathResolveState.result) {
    return {
      ...searchChannelPathResolveState.result,
      status: 'ready',
      raw: candidate.raw,
      kind: candidate.kind,
    };
  }
  if (searchChannelPathResolveState.error) {
    return {
      status: 'invalid',
      raw: candidate.raw,
      kind: candidate.kind,
      error: searchChannelPathResolveState.error,
    };
  }
  return { status: 'loading', raw: candidate.raw, kind: candidate.kind };
}

function clearSearchChannelPathResolve() {
  if (searchChannelPathTimer) {
    window.clearTimeout(searchChannelPathTimer);
    searchChannelPathTimer = null;
  }
  if (!searchChannelPathResolveState.key && !searchChannelPathResolveState.raw) return;
  searchChannelPathResolveState = { key: '', raw: '', loading: false, error: '', result: null };
  updateSearchResults({ skipFetch: true });
}

function queueSearchChannelPathResolve() {
  const candidate = searchChannelPathCandidate();
  if (!candidate) {
    clearSearchChannelPathResolve();
    return;
  }
  if (
    searchChannelPathResolveState.key === candidate.key
    && (searchChannelPathResolveState.loading || searchChannelPathResolveState.result || searchChannelPathResolveState.error)
  ) return;
  if (searchChannelPathTimer) window.clearTimeout(searchChannelPathTimer);
  searchChannelPathResolveState = { key: candidate.key, raw: candidate.raw, loading: true, error: '', result: null };
  updateSearchResults({ skipFetch: true });
  searchChannelPathTimer = window.setTimeout(() => {
    resolveSearchChannelPath();
  }, 80);
}

async function resolveSearchChannelPath() {
  const candidate = searchChannelPathCandidate();
  if (!candidate) {
    clearSearchChannelPathResolve();
    return;
  }
  const seq = searchChannelPathRequestSeq + 1;
  searchChannelPathRequestSeq = seq;
  searchChannelPathResolveState = { key: candidate.key, raw: candidate.raw, loading: true, error: '', result: null };
  updateSearchResults({ skipFetch: true });
  try {
    const params = new URLSearchParams({ path: candidate.raw });
    const result = await api(`/api/channel-path/resolve?${params.toString()}`);
    if (seq !== searchChannelPathRequestSeq) return;
    searchChannelPathResolveState = { key: candidate.key, raw: candidate.raw, loading: false, error: '', result };
  } catch {
    if (seq !== searchChannelPathRequestSeq) return;
    searchChannelPathResolveState = { key: candidate.key, raw: candidate.raw, loading: false, error: 'Not Found', result: null };
  }
  updateSearchResults({ skipFetch: true });
}

function searchEntityScore(text, query) {
  const normalizedText = normalizeSearchText(text);
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedText || !normalizedQuery || !normalizedText.includes(normalizedQuery)) return 0;
  return normalizedText.startsWith(normalizedQuery) ? 2 : 1;
}

function searchEntityResults(query) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return [];
  const results = [];
  for (const channel of appState?.channels || []) {
    const score = searchEntityScore(`#${channel.name} ${channel.description || ''}`, query);
    if (score) {
      results.push({
        id: `channel:${channel.id}`,
        type: 'channel',
        label: `#${channel.name}`,
        meta: 'Channel',
        body: channel.description || 'Channel conversation',
        targetType: 'channel',
        targetId: channel.id,
        score,
      });
    }
  }
  for (const dm of appState?.dms || []) {
    const peer = typeof dmPeerInfo === 'function' ? dmPeerInfo(dm)?.peer : null;
    if (!peer) continue;
    const label = peer.name || displayName(peer.id);
    const score = searchEntityScore(`${label} dm direct message`, query);
    if (score) {
      results.push({
        id: `dm:${dm.id}`,
        type: 'dm',
        label,
        meta: 'Direct Message',
        body: 'Direct message',
        targetType: 'dm',
        targetId: dm.id,
        score,
      });
    }
  }
  for (const agent of appState?.agents || []) {
    const score = searchEntityScore(`${agent.name} ${agent.description || ''}`, query);
    if (score) {
      results.push({
        id: `agent:${agent.id}`,
        type: 'agent',
        label: agent.name,
        meta: 'Agent',
        body: agent.description || agent.runtime || 'Agent',
        targetType: 'agent',
        targetId: agent.id,
        score,
      });
    }
  }
  return results
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, 8);
}

function searchSnippet(text, query) {
  const body = String(text || '');
  if (body.length <= SEARCH_SNIPPET_RADIUS * 2) return body;
  const lowered = body.toLocaleLowerCase();
  const candidates = [normalizeSearchText(query), ...searchTerms(query)].filter(Boolean);
  const hit = candidates
    .map((term) => lowered.indexOf(term.toLocaleLowerCase()))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, hit - SEARCH_SNIPPET_RADIUS);
  const end = Math.min(body.length, hit + SEARCH_SNIPPET_RADIUS);
  return `${start > 0 ? '...' : ''}${body.slice(start, end)}${end < body.length ? '...' : ''}`;
}

function highlightSearchText(text, query) {
  const raw = String(text || '');
  const terms = [...new Set(searchTerms(query))]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  if (!terms.length) return escapeHtml(raw);

  const lower = raw.toLocaleLowerCase();
  const ranges = [];
  for (const term of terms) {
    const needle = term.toLocaleLowerCase();
    let index = lower.indexOf(needle);
    while (index !== -1) {
      ranges.push([index, index + needle.length]);
      index = lower.indexOf(needle, index + Math.max(1, needle.length));
    }
  }
  if (!ranges.length) return escapeHtml(raw);

  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1]) {
      last[1] = Math.max(last[1], range[1]);
    } else {
      merged.push([...range]);
    }
  }

  let html = '';
  let cursor = 0;
  for (const [start, end] of merged) {
    html += escapeHtml(raw.slice(cursor, start));
    html += `<mark class="search-highlight">${escapeHtml(raw.slice(start, end))}</mark>`;
    cursor = end;
  }
  html += escapeHtml(raw.slice(cursor));
  return html;
}

function mentionAvatar(item) {
  const avatar = ['agent', 'human'].includes(item.type) ? String(item.avatar || item.avatarUrl || '').trim() : '';
  if (avatar) return `<img src="${escapeHtml(avatar)}" class="mention-avatar" alt="" />`;
  if (item.type === 'file') return '<span class="mention-avatar-text mention-file-avatar">FILE</span>';
  if (item.type === 'folder') return '<span class="mention-avatar-text mention-folder-avatar">DIR</span>';
  return `<span class="mention-avatar-text">${escapeHtml(item.name.slice(0, 2).toUpperCase())}</span>`;
}

function mentionHandle(item) {
  if (item.type === 'human' && item.thirdPartyName) return item.thirdPartyName;
  if (item.type === 'human') return `@${item.handle || item.id}`;
  if (item.type === 'file' || item.type === 'folder') return item.absolutePath || item.path || item.projectName || item.name;
  return `@${item.name}`;
}

function mentionDisplay(item) {
  return `@${item.name}`;
}

function mentionRuntimeLabel(item = {}) {
  const raw = String(item.runtime || item.runtimeId || '').trim();
  if (!raw) return '';
  const normalized = raw.toLowerCase();
  const labels = {
    codex: 'Codex',
    'claude-code': 'Claude Code',
    kimi: 'Kimi',
    cursor: 'Cursor',
    copilot: 'Copilot',
    gemini: 'Gemini',
    opencode: 'OpenCode',
  };
  if (labels[normalized]) return labels[normalized];
  if (typeof runtimeNameForId === 'function') return runtimeNameForId(raw).replace(/\s+CLI$/i, '');
  return raw.replace(/[-_]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

function mentionDetailText(item, handle) {
  if (item.type === 'agent') {
    return [mentionRuntimeLabel(item), item.description || ''].filter(Boolean).join(' · ') || handle;
  }
  if (item.type === 'human' && item.thirdPartyName) return item.thirdPartyName;
  if (item.type === 'file' || item.type === 'folder') return handle;
  return handle;
}

function mentionHumanBadgeHtml() {
  return typeof humanBadgeHtml === 'function' ? humanBadgeHtml() : '';
}

function mentionNameHtml(item) {
  return `
    <span class="mention-name-text">${escapeHtml(item.name)}</span>
    ${item.type === 'human' && item.thirdPartyName ? `<small class="mention-third-party-name">${escapeHtml(item.thirdPartyName)}</small>` : ''}
    ${item.type === 'human' ? mentionHumanBadgeHtml() : ''}
  `;
}

function mentionThirdPartyInlineHtml(human = {}) {
  const thirdPartyName = typeof thirdPartyNameForHuman === 'function' ? thirdPartyNameForHuman(human) : '';
  return thirdPartyName ? ` <small class="mention-third-party-name">${escapeHtml(thirdPartyName)}</small>` : '';
}

function mentionSearchValue(item) {
  return [
    item.name,
    item.thirdPartyName,
    mentionHandle(item),
    item.handle,
    item.runtime,
    item.runtimeId,
    item.description,
    item.absolutePath,
    item.path,
    item.projectName,
  ].filter(Boolean).join(' ').toLowerCase();
}

function mentionQueryScore(item, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return 8;
  const name = String(item.name || '').toLowerCase();
  const handle = mentionHandle(item).toLowerCase().replace(/^@/, '');
  const runtime = String(item.runtime || item.runtimeId || '').toLowerCase();
  const description = String(item.description || '').toLowerCase();
  if (name === q || handle === q) return 0;
  if (name.startsWith(q) || handle.startsWith(q)) return 1;
  if (name.includes(q) || handle.includes(q)) return 2;
  if (runtime === q || runtime.startsWith(q)) return 3;
  if (runtime.includes(q) || description.includes(q)) return 4;
  if (mentionSearchValue(item).includes(q)) return 5;
  return 9;
}

function mentionGroupPriority(group) {
  const priorities = { in: 0, out: 1, folders: 2, files: 3 };
  return priorities[group] ?? 9;
}

function mentionTypePriority(item) {
  const priorities = { agent: 0, human: 1, folder: 2, file: 3 };
  return priorities[item.type] ?? 9;
}

function mentionStatusPriority(status) {
  const normalized = String(status || '').toLowerCase();
  if (['online', 'thinking', 'working', 'running', 'busy', 'warming'].includes(normalized)) return 0;
  if (['queued', 'starting'].includes(normalized)) return 1;
  if (['idle', 'offline'].includes(normalized)) return 2;
  return 3;
}

function mentionRecordMatchesSpace(record, spaceType, spaceId) {
  if (!record) return false;
  if (record.spaceType === spaceType && record.spaceId === spaceId) return true;
  if (!record.parentMessageId) return false;
  const parent = byId(appState?.messages, record.parentMessageId);
  return parent?.spaceType === spaceType && parent?.spaceId === spaceId;
}

function mentionRecentActorIndexes(spaceType, spaceId) {
  const indexes = new Map();
  const records = [...(appState?.messages || []), ...(appState?.replies || [])]
    .filter((record) => mentionRecordMatchesSpace(record, spaceType, spaceId))
    .sort((a, b) => Date.parse(b.createdAt || b.updatedAt || 0) - Date.parse(a.createdAt || a.updatedAt || 0))
    .slice(0, 80);
  let index = 0;
  for (const record of records) {
    const ids = [
      record.authorId,
      ...(record.mentionedAgentIds || []),
      ...(record.mentionedHumanIds || []),
    ].filter(Boolean);
    for (const id of ids) {
      if (!indexes.has(id)) indexes.set(id, index);
    }
    index += 1;
  }
  return indexes;
}

function sortMentionItems(items, query, spaceType = selectedSpaceType, spaceId = selectedSpaceId) {
  const recentIndexes = mentionRecentActorIndexes(spaceType, spaceId);
  return [...items].sort((a, b) => {
    const queryDiff = mentionQueryScore(a, query) - mentionQueryScore(b, query);
    if (queryDiff) return queryDiff;
    const groupDiff = mentionGroupPriority(a.group) - mentionGroupPriority(b.group);
    if (groupDiff) return groupDiff;
    const recentDiff = (recentIndexes.get(a.id) ?? 9999) - (recentIndexes.get(b.id) ?? 9999);
    if (recentDiff) return recentDiff;
    const typeDiff = mentionTypePriority(a) - mentionTypePriority(b);
    if (typeDiff) return typeDiff;
    const statusDiff = mentionStatusPriority(a.status) - mentionStatusPriority(b.status);
    if (statusDiff) return statusDiff;
    const joinedDiff = Date.parse(a.joinedAt || a.createdAt || 0) - Date.parse(b.joinedAt || b.createdAt || 0);
    if (joinedDiff) return joinedDiff;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
}

function decodeReferencePath(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    return String(value || '');
  }
}

function baseNameFromPath(value, fallback) {
  const clean = String(value || '').split(/[\\/]/).filter(Boolean).pop();
  return clean || fallback || 'reference';
}

function referenceDisplayName(projectId, relPath, kind) {
  const project = byId(appState?.projects, projectId);
  if (relPath) return baseNameFromPath(relPath, kind);
  return project?.name || kind;
}

function contextTokenForItem(item) {
  if (item.token) return item.token;
  if (item.type === 'file' || item.type === 'folder') {
    return `<#${item.type}:${item.projectId}:${encodeURIComponent(item.path || '')}>`;
  }
  return mentionTokenForId(item.id);
}

function rememberComposerMention(composerId, item) {
  if (!composerId || !item) return;
  composerMentionMaps[composerId] = composerMentionMaps[composerId] || {};
  composerMentionMaps[composerId][mentionDisplay(item)] = contextTokenForItem(item);
  persistComposerDraft(composerId);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentionTokenForId(id) {
  return String(id).startsWith('!') ? `<!${String(id).replace(/^!/, '')}>` : `<@${id}>`;
}

function isAsciiMentionWordChar(char) {
  return /[A-Za-z0-9_.-]/.test(char);
}

function isMentionBoundaryChar(char) {
  if (!char) return true;
  if (/\s/.test(char)) return true;
  if (/[，。！？；：、,.!?;:()[\]{}「」『』《》【】"'`“”‘’]/.test(char)) return true;
  return !isAsciiMentionWordChar(char);
}

function mentionCandidatesForComposer(composerId) {
  const isThread = String(composerId || '').startsWith('thread:');
  const threadRoot = isThread ? byId(appState.messages, threadMessageId) : null;
  return getMentionCandidates('', threadRoot?.spaceType || selectedSpaceType, threadRoot?.spaceId || selectedSpaceId);
}

function encodeComposerMentions(text, composerId) {
  let result = String(text || '');
  const mapped = composerMentionMaps[composerId] || {};
  const known = new Map();
  for (const item of mentionCandidatesForComposer(composerId)) {
    known.set(mentionDisplay(item), contextTokenForItem(item));
  }
  for (const [label, token] of Object.entries(mapped)) known.set(label, token);
  const entries = [...known.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [label, token] of entries) {
    const pattern = new RegExp(escapeRegExp(label), 'g');
    result = result.replace(pattern, (match, offset, fullText) => {
      const before = offset > 0 ? fullText[offset - 1] : '';
      const after = fullText[offset + match.length] || '';
      if (!isMentionBoundaryChar(before) || !isMentionBoundaryChar(after)) return match;
      return token;
    });
  }
  return result;
}

function mentionWorkspaceHumans() {
  if (typeof workspaceHumans === 'function' && appState?.cloud?.members?.length) {
    return workspaceHumans();
  }
  const humans = new Map((appState.humans || []).map((human) => [human.id, human]));
  for (const member of appState.cloud?.members || []) {
    if ((member.status || 'active') !== 'active') continue;
    const humanId = member.humanId || member.human?.id;
    if (!humanId || humans.has(humanId)) continue;
    const email = member.human?.email || member.user?.email || '';
    humans.set(humanId, {
      id: humanId,
      name: member.human?.name || member.user?.name || email.split('@')[0] || humanId.replace(/^hum_/, ''),
      email,
      thirdPartyName: member.human?.thirdPartyName || (typeof thirdPartyNameForUser === 'function' ? thirdPartyNameForUser(member.user || {}) : ''),
      thirdPartyProvider: member.human?.thirdPartyProvider || (typeof thirdPartyProviderForUser === 'function' ? thirdPartyProviderForUser(member.user || {}) : ''),
      role: member.role || member.human?.role || 'member',
      status: member.human?.status || 'offline',
      avatar: member.human?.avatar || member.human?.avatarUrl || '',
    });
  }
  return [...humans.values()];
}

function mentionWorkspaceAgents() {
  return typeof workspaceAgents === 'function'
    ? workspaceAgents()
    : (appState.agents || []).filter((agent) => (
      typeof agentIsActiveInWorkspace === 'function'
        ? agentIsActiveInWorkspace(agent)
        : !agent?.deletedAt && !agent?.archivedAt && String(agent?.status || '').toLowerCase() !== 'deleted'
    ));
}

function getMentionCandidates(query, spaceType = selectedSpaceType, spaceId = selectedSpaceId) {
  const inMembers = spaceType === 'channel'
    ? getChannelMembers(spaceId)
    : {
      agents: mentionWorkspaceAgents().filter((agent) => byId(appState.dms, spaceId)?.participantIds?.includes(agent.id)),
      humans: mentionWorkspaceHumans().filter((human) => byId(appState.dms, spaceId)?.participantIds?.includes(human.id)),
    };
  const inIds = new Set([...inMembers.agents.map((a) => a.id), ...inMembers.humans.map((h) => h.id)]);
  const allItems = [
    ...mentionWorkspaceAgents().map((agent) => ({
      id: agent.id,
      name: agent.name,
      type: 'agent',
      avatar: agent.avatar,
      status: agent.status || 'offline',
      runtime: agent.runtime || agent.runtimeId || '',
      runtimeId: agent.runtimeId || '',
      description: agent.description || '',
      createdAt: agent.createdAt || '',
      group: inIds.has(agent.id) ? 'in' : 'out',
    })),
    ...mentionWorkspaceHumans().map((human) => ({
      id: human.id,
      name: human.name,
      thirdPartyName: typeof thirdPartyNameForHuman === 'function' ? thirdPartyNameForHuman(human) : '',
      type: 'human',
      avatar: human.avatar || human.avatarUrl || '',
      status: human.status || 'offline',
      handle: human.email ? human.email.split('@')[0] : human.id.replace(/^hum_/, ''),
      description: human.description || human.role || 'Human',
      joinedAt: human.joinedAt || human.createdAt || '',
      createdAt: human.createdAt || '',
      group: inIds.has(human.id) ? 'in' : 'out',
    })),
  ];
  const q = String(query || '').toLowerCase();
  const filtered = allItems.filter((item) => !q || mentionSearchValue(item).includes(q));
  return sortMentionItems(filtered, q, spaceType, spaceId);
}

async function getProjectMentionCandidates(query, spaceType = selectedSpaceType, spaceId = selectedSpaceId) {
  if (!(typeof localProjectFoldersEnabled === 'function' && localProjectFoldersEnabled())) return [];
  if (!(appState?.projects || []).some((project) => project.spaceType === spaceType && project.spaceId === spaceId)) return [];
  const params = new URLSearchParams({ spaceType, spaceId, q: query || '' });
  const result = await api(`/api/projects/search?${params.toString()}`);
  return (result.items || []).map((item) => ({
    id: `${item.kind}:${item.projectId}:${item.path}`,
    name: item.name,
    type: item.kind,
    projectId: item.projectId,
    projectName: item.projectName,
    path: item.path,
    absolutePath: item.absolutePath,
    group: item.kind === 'folder' ? 'folders' : 'files',
    status: item.kind,
    description: item.projectName,
    token: `<#${item.kind}:${item.projectId}:${encodeURIComponent(item.path || '')}>`,
  }));
}

function findMentionTrigger(value, caretPosition) {
  const textBefore = String(value || '').substring(0, caretPosition);
  const triggerPosition = textBefore.lastIndexOf('@');
  if (triggerPosition < 0) return null;

  const query = textBefore.substring(triggerPosition + 1);
  if (/[\s@<>]/.test(query)) return null;

  const previousChar = triggerPosition > 0 ? textBefore[triggerPosition - 1] : '';
  if (previousChar && !isMentionBoundaryChar(previousChar)) return null;

  return { query, triggerPosition };
}

function renderMentionPopup() {
  if (!mentionPopup.active || !mentionPopup.items.length) return '';
  const labels = {
    folders: 'FOLDERS',
    files: 'FILES',
    out: 'OTHER PEOPLE',
  };
  let previousGroup = '';
  return `
    <div class="mention-popup" id="mention-popup" data-composer-id="${escapeHtml(mentionPopup.composerId || '')}">
      ${mentionPopup.items.map((item, idx) => {
        const handle = mentionHandle(item);
        const detail = mentionDetailText(item, handle);
        const sectionTitle = item.group !== previousGroup && labels[item.group]
          ? `<div class="mention-section-title">${escapeHtml(labels[item.group])}</div>`
          : '';
        previousGroup = item.group;
        return `
          ${sectionTitle}
          <div class="mention-item mention-type-${escapeHtml(item.type)} ${idx === mentionPopup.selectedIndex ? 'selected' : ''}" data-mention-idx="${idx}">
            ${mentionAvatar(item)}
            <span class="mention-status ${item.type === 'file' ? 'mention-status-file' : item.type === 'folder' ? 'mention-status-folder' : presenceClass(item.status)}"></span>
            <span class="mention-name" title="${escapeHtml(item.name)}">${mentionNameHtml(item)}</span>
            <span class="mention-handle mention-detail" title="${escapeHtml(detail)}">${escapeHtml(detail)}</span>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// Insert mention token into textarea
async function insertMention(textarea, item) {
  const { value, selectionStart } = textarea;
  const beforeTrigger = value.substring(0, mentionPopup.triggerPosition);
  const afterCursor = value.substring(selectionStart);
  const mentionToken = mentionDisplay(item);
  textarea.value = beforeTrigger + mentionToken + ' ' + afterCursor;
  const newPosition = beforeTrigger.length + mentionToken.length + 1;
  textarea.setSelectionRange(newPosition, newPosition);
  if (textarea.dataset.composerId) {
    setComposerDraftBody(textarea.dataset.composerId, textarea.value);
    rememberComposerMention(textarea.dataset.composerId, item);
    if (item.type === 'file' || item.type === 'folder') {
      toast(`${item.type === 'file' ? 'File' : 'Folder'} referenced from project`);
    }
  }
  if (typeof maybeAutosizeComposerTextarea === 'function') maybeAutosizeComposerTextarea(textarea);
  mentionPopup.active = false;
  mentionPopup.items = [];
  mentionPopup.selectedIndex = 0;
  mentionPopup.composerId = null;
}

function currentSpace() {
  const list = selectedSpaceType === 'channel' ? appState?.channels : appState?.dms;
  return byId(list, selectedSpaceId) || appState?.channels?.[0] || null;
}

function spaceName(spaceType, spaceId) {
  if (spaceType === 'channel') return `#${byId(appState?.channels, spaceId)?.name || 'missing'}`;
  const dm = byId(appState?.dms, spaceId);
  const peer = typeof dmPeerInfo === 'function' ? dmPeerInfo(dm)?.peer : null;
  return `@${peer?.name || displayName(peer?.id || 'unknown')}`;
}

function recordSpaceName(record) {
  const source = record?.parentMessageId ? byId(appState?.messages, record.parentMessageId) : record;
  return spaceName(source?.spaceType || record?.spaceType, source?.spaceId || record?.spaceId);
}

function savedRecords() {
  const humanId = typeof currentHumanId === 'function' ? currentHumanId() : 'hum_local';
  return [...(appState?.messages || []), ...(appState?.replies || [])]
    .filter((record) => record.savedBy?.includes(humanId))
    .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
}

function savedRecordThreadRoot(record) {
  if (!record) return null;
  if (record.parentMessageId) return byId(appState?.messages, record.parentMessageId);
  if (record.replyCount > 0 || record.taskId) return record;
  return null;
}

function isInternalOnboardingTaskMessage(message) {
  const metadata = message?.metadata && typeof message.metadata === 'object' ? message.metadata : {};
  return Boolean(
    message?.hiddenFromChannel === true
    || metadata.hiddenFromChannel === true
    || metadata.visibility === 'internal'
    || message?.eventType === 'human_onboarding_task'
    || message?.eventType === 'agent_onboarding_greeting_task'
  );
}

function spaceMessages(spaceType = selectedSpaceType, spaceId = selectedSpaceId) {
  return (appState?.messages || [])
    .filter((message) => message.spaceType === spaceType && message.spaceId === spaceId)
    .filter((message) => !isInternalOnboardingTaskMessage(message))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

function projectsForSpace(spaceType = selectedSpaceType, spaceId = selectedSpaceId) {
  return (appState?.projects || []).filter((project) => project.spaceType === spaceType && project.spaceId === spaceId);
}

function projectTreeKey(projectId, relPath = '') {
  return `${projectId}:${relPath || ''}`;
}

function projectPreviewKey(projectId, relPath = '') {
  return `${projectId}:${relPath || ''}`;
}

function projectTreeIsExpanded(projectId, relPath = '') {
  return Boolean(expandedProjectTrees[projectTreeKey(projectId, relPath)]);
}

async function loadProjectTree(projectId, relPath = '') {
  if (!(typeof localProjectFoldersEnabled === 'function' && localProjectFoldersEnabled())) return;
  const key = projectTreeKey(projectId, relPath);
  projectTreeCache[key] = { loading: true, entries: [], error: '' };
  render();
  try {
    const params = new URLSearchParams();
    if (relPath) params.set('path', relPath);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    projectTreeCache[key] = await api(`/api/projects/${encodeURIComponent(projectId)}/tree${suffix}`);
  } catch (error) {
    projectTreeCache[key] = { loading: false, entries: [], error: error.message };
  }
  render();
}

async function toggleProjectTree(projectId, relPath = '') {
  const key = projectTreeKey(projectId, relPath);
  if (expandedProjectTrees[key]) {
    delete expandedProjectTrees[key];
    render();
    return;
  }
  expandedProjectTrees[key] = true;
  if (!projectTreeCache[key]) await loadProjectTree(projectId, relPath);
  else render();
}

async function openProjectFile(projectId, relPath = '') {
  if (!(typeof localProjectFoldersEnabled === 'function' && localProjectFoldersEnabled())) return;
  const key = projectPreviewKey(projectId, relPath);
  selectedProjectFile = { projectId, path: relPath };
  threadMessageId = null;
  selectedAgentId = null;
  projectFilePreviews[key] = projectFilePreviews[key] || { loading: true, file: null, error: '' };
  render();
  try {
    const params = new URLSearchParams({ path: relPath });
    projectFilePreviews[key] = await api(`/api/projects/${encodeURIComponent(projectId)}/file?${params.toString()}`);
  } catch (error) {
    projectFilePreviews[key] = { loading: false, file: null, error: error.message };
  }
  render();
}

function clearProjectCaches(projectId) {
  for (const key of Object.keys(expandedProjectTrees)) {
    if (key.startsWith(`${projectId}:`)) delete expandedProjectTrees[key];
  }
  for (const key of Object.keys(projectTreeCache)) {
    if (key.startsWith(`${projectId}:`)) delete projectTreeCache[key];
  }
  for (const key of Object.keys(projectFilePreviews)) {
    if (key.startsWith(`${projectId}:`)) delete projectFilePreviews[key];
  }
  if (selectedProjectFile?.projectId === projectId) selectedProjectFile = null;
}

function agentWorkspaceKey(agentId, relPath = '') {
  return `${agentId}:${relPath || ''}`;
}

function agentWorkspaceIsExpanded(agentId, relPath = '') {
  return Boolean(expandedAgentWorkspaceTrees[agentWorkspaceKey(agentId, relPath)]);
}

function renderAgentDetailUpdate(agentId) {
  if (selectedAgentId !== agentId) return;
  const shell = document.querySelector('.agent-detail-shell');
  if (shell && typeof patchAgentDetailSurface === 'function' && patchAgentDetailSurface()) return;
  render();
}

function renderAgentWorkspaceUpdate(agentId) {
  if (selectedAgentId !== agentId || normalizeAgentDetailTab(agentDetailTab) !== 'workspace') return;
  renderAgentDetailUpdate(agentId);
}

async function loadAgentWorkspace(agentId, relPath = '', { renderLoading = true, renderAfter = true } = {}) {
  const key = agentWorkspaceKey(agentId, relPath);
  agentWorkspaceTreeCache[key] = { loading: true, entries: [], error: '' };
  if (renderLoading) renderAgentWorkspaceUpdate(agentId);
  try {
    const params = new URLSearchParams();
    if (relPath) params.set('path', relPath);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    agentWorkspaceTreeCache[key] = await api(`/api/agents/${encodeURIComponent(agentId)}/workspace${suffix}`);
  } catch (error) {
    agentWorkspaceTreeCache[key] = { loading: false, entries: [], error: error.message };
  }
  if (renderAfter) renderAgentWorkspaceUpdate(agentId);
}

async function toggleAgentWorkspace(agentId, relPath = '') {
  const key = agentWorkspaceKey(agentId, relPath);
  if (expandedAgentWorkspaceTrees[key]) {
    delete expandedAgentWorkspaceTrees[key];
    renderAgentWorkspaceUpdate(agentId);
    return;
  }
  expandedAgentWorkspaceTrees[key] = true;
  if (!agentWorkspaceTreeCache[key]) await loadAgentWorkspace(agentId, relPath);
  else renderAgentWorkspaceUpdate(agentId);
}

async function openAgentWorkspaceFile(agentId, relPath = '', { renderLoading = true, renderAfter = true } = {}) {
  const key = agentWorkspaceKey(agentId, relPath);
  selectedAgentWorkspaceFile = { agentId, path: relPath };
  agentWorkspaceFilePreviews[key] = agentWorkspaceFilePreviews[key] || { loading: true, file: null, error: '' };
  if (renderLoading) renderAgentWorkspaceUpdate(agentId);
  try {
    const params = new URLSearchParams({ path: relPath });
    agentWorkspaceFilePreviews[key] = await api(`/api/agents/${encodeURIComponent(agentId)}/workspace/file?${params.toString()}`);
  } catch (error) {
    agentWorkspaceFilePreviews[key] = { loading: false, file: null, error: error.message };
  }
  if (renderAfter) renderAgentWorkspaceUpdate(agentId);
}

async function prepareAgentWorkspaceTab(agentId) {
  if (!agentId) return;
  const rootKey = agentWorkspaceKey(agentId, '');
  expandedAgentWorkspaceTrees[rootKey] = true;
  const previewPath = selectedAgentWorkspaceFile?.agentId === agentId
    ? selectedAgentWorkspaceFile.path
    : 'MEMORY.md';
  const previewKey = agentWorkspaceKey(agentId, previewPath);
  const tasks = [];
  if (!agentWorkspaceTreeCache[rootKey]) {
    tasks.push(loadAgentWorkspace(agentId, '', { renderLoading: false }));
  }
  if (!agentWorkspaceFilePreviews[previewKey]) {
    tasks.push(openAgentWorkspaceFile(agentId, previewPath, { renderLoading: false }));
  } else if (!selectedAgentWorkspaceFile || selectedAgentWorkspaceFile.agentId !== agentId) {
    selectedAgentWorkspaceFile = { agentId, path: previewPath };
  }
  renderAgentWorkspaceUpdate(agentId);
  if (tasks.length) await Promise.all(tasks);
}

async function refreshAgentWorkspace(agentId) {
  if (!agentId) return;
  clearAgentWorkspaceCaches(agentId);
  expandedAgentWorkspaceTrees[agentWorkspaceKey(agentId, '')] = true;
  selectedAgentWorkspaceFile = { agentId, path: 'MEMORY.md' };
  renderAgentWorkspaceUpdate(agentId);
  await Promise.all([
    loadAgentWorkspace(agentId, '', { renderLoading: false }),
    openAgentWorkspaceFile(agentId, 'MEMORY.md', { renderLoading: false }),
  ]);
}

function clearAgentWorkspaceCaches(agentId) {
  for (const key of Object.keys(expandedAgentWorkspaceTrees)) {
    if (key.startsWith(`${agentId}:`)) delete expandedAgentWorkspaceTrees[key];
  }
  for (const key of Object.keys(agentWorkspaceTreeCache)) {
    if (key.startsWith(`${agentId}:`)) delete agentWorkspaceTreeCache[key];
  }
  for (const key of Object.keys(agentWorkspaceFilePreviews)) {
    if (key.startsWith(`${agentId}:`)) delete agentWorkspaceFilePreviews[key];
  }
  if (selectedAgentWorkspaceFile?.agentId === agentId) selectedAgentWorkspaceFile = null;
}

function clickLoadingDebugDelayMs() {
  const params = new URLSearchParams(window.location.search || '');
  const raw = params.get('clickLoadingDelayMs')
    || localStorage.getItem('magclawClickLoadingDelayMs')
    || window.__MAGCLAW_CLICK_LOADING_DELAY_MS
    || 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, 5000);
}

function waitForClickLoadingDebugDelay(delayMs = clickLoadingDebugDelayMs()) {
  return delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve();
}

function clickLoadingTargetKey(action, target) {
  const parts = [
    action,
    target?.dataset?.id,
    target?.dataset?.slug,
    target?.dataset?.tab,
    target?.dataset?.modal,
    target?.dataset?.projectId,
    target?.dataset?.agentId,
    target?.dataset?.path,
    target?.dataset?.memberId,
    target?.dataset?.proposalId,
  ].filter(Boolean);
  return parts.join(':') || action || '';
}

function clickLoadingButtonText(target) {
  return String(target?.innerText || target?.textContent || '').replace(/\s+/g, ' ').trim();
}

function clickLoadingMeta(action, target) {
  const modalName = target?.dataset?.modal || '';
  const detailSurface = activeView === 'members' ? 'main' : 'inspector';
  const map = {
    'switch-server': ['Loading server...', 'main'],
    'open-console-server': ['Loading server...', 'main'],
    'accept-console-invitation': ['Accepting invitation...', 'main'],
    'decline-console-invitation': ['Declining invitation...', 'main'],
    'set-ui-language': ['Saving language...', 'main'],
    'mark-inbox-read': ['Marking activities read...', 'main'],
    'close-workspace-activity': ['Closing activity log...', 'inspector'],
    'open-search-channel-path': ['Opening channel...', 'main'],
    'save-agent-field': ['Saving agent profile...', detailSurface],
    'save-agent-env': ['Saving environment...', detailSurface],
    'save-human-description': ['Saving profile...', detailSurface],
    'refresh-agent-skills': ['Loading skills...', detailSurface],
    'open-dm-with-agent': ['Loading DM...', 'main'],
    'open-dm-with-human': ['Loading DM...', 'main'],
    'delete-agent': ['Deleting agent...', detailSurface],
    'restore-agent': ['Restoring agent...', 'main'],
    'restore-console-server': ['Restoring server...', 'main'],
    'confirm-agent-start': ['Requesting agent start...', detailSurface],
    'confirm-agent-restart': ['Requesting agent restart...', detailSurface],
    'confirm-daemon-upgrade': ['Queuing daemon upgrade...', 'modal'],
    'open-computer-close-confirm': ['Preparing close confirmation...', 'main'],
    'confirm-computer-close': ['Closing computer...', 'modal'],
    'pick-project-folder': ['Opening folder picker...', 'main'],
    'toggle-project-tree': ['Loading folder...', 'main'],
    'open-project-file': ['Loading file...', detailSurface],
    'toggle-agent-workspace': ['Loading workspace folder...', detailSurface],
    'open-agent-workspace-file': ['Loading workspace file...', detailSurface],
    'refresh-agent-workspace': ['Loading workspace...', detailSurface],
    'open-team-sharing-workspace': ['Loading workspace...', detailSurface],
    'confirm-avatar-crop': ['Saving avatar...', 'modal'],
    'remove-project': ['Removing folder...', 'main'],
    'save-message': ['Saving message...', 'main'],
    'remove-saved-message': ['Updating saved message...', 'main'],
    'task-status-set': ['Updating task...', 'main'],
    'message-task': ['Creating task...', 'main'],
    'task-claim': ['Claiming task...', 'main'],
    'task-unclaim': ['Unclaiming task...', 'main'],
    'task-review': ['Requesting review...', 'main'],
    'task-approve': ['Approving task...', 'main'],
    'task-close': ['Closing task...', 'main'],
    'task-reopen': ['Reopening task...', 'main'],
    'run-task-codex': ['Starting mission...', 'main'],
    'cloud-local': ['Switching offline...', 'main'],
    'cloud-disconnect': ['Disconnecting cloud...', 'main'],
    'cloud-configure': ['Saving cloud config...', 'main'],
    'cloud-pair': ['Pairing cloud...', 'main'],
    'cloud-push': ['Pushing state...', 'main'],
    'cloud-pull': ['Pulling cloud state...', 'main'],
    'create-computer-pairing': ['Loading connect command...', 'main'],
    'generate-computer-command': ['Loading connect command...', 'main'],
    'upgrade-computer-daemon': ['Queueing daemon upgrade...', 'main'],
    'regenerate-computer-command': ['Loading connect command...', 'modal'],
    'refresh-computer-pairing-command': ['Loading connect command...', 'modal'],
    'confirm-revoke-join-link': ['Revoking join link...', 'modal'],
    'start-all-computer-agents': ['Starting agents...', 'main'],
    'disable-computer': ['Disabling computer...', 'main'],
    'enable-computer': ['Enabling computer...', 'main'],
    'confirm-cloud-auth-logout': ['Signing out...', 'modal'],
    'confirm-member-action': ['Updating member...', 'modal'],
    'promote-cloud-member-role': ['Updating member role...', 'main'],
    'update-cloud-member-role': ['Updating member role...', 'main'],
    'leave-channel': ['Leaving channel...', 'main'],
    'join-channel': ['Joining channel...', 'main'],
    'remove-channel-member': ['Removing member...', 'modal'],
    'add-channel-member': ['Adding member...', 'modal'],
    'accept-member-proposal': ['Accepting proposal...', 'modal'],
    'decline-member-proposal': ['Declining proposal...', 'modal'],
  };
  if (action === 'open-modal' && modalName === 'agent') return { label: 'Loading runtimes...', surface: 'modal' };
  if (action === 'open-modal' && modalName === 'computer') return { label: 'Loading connect command...', surface: 'modal' };
  if (action === 'close-modal' && modal === 'computer') return { label: 'Closing computer setup...', surface: 'modal' };
  const item = map[action];
  if (item) return { label: item[0], surface: item[1] };
  return { label: `${clickLoadingButtonText(target) || 'Loading'}...`, surface: '' };
}

function shouldShowClickLoading(action, target, localOnlyActions = new Set()) {
  const remoteLocalActions = new Set([
    'set-agent-detail-tab',
    'set-ui-language',
    'refresh-agent-workspace',
    'toggle-project-tree',
    'open-project-file',
    'toggle-agent-workspace',
    'open-agent-workspace-file',
    'open-team-sharing-workspace',
    'open-modal',
    'close-modal',
  ]);
  if (action === 'open-modal' && !['agent', 'computer'].includes(target?.dataset?.modal || '')) return false;
  if (action === 'close-modal' && modal !== 'computer') return false;
  return !localOnlyActions.has(action) || remoteLocalActions.has(action);
}

function setClickLoadingButton(target, loading) {
  if (!target?.classList) return;
  if (loading) {
    target.classList.add('is-loading');
    target.setAttribute('aria-busy', 'true');
    if ('disabled' in target) target.disabled = true;
    return;
  }
  target.classList.remove('is-loading');
  target.removeAttribute('aria-busy');
  if ('disabled' in target && target.dataset.action !== 'agent-stop-unavailable') target.disabled = false;
}

function beginClickLoading(action, target, localOnlyActions = new Set()) {
  if (!shouldShowClickLoading(action, target, localOnlyActions)) return 0;
  const meta = clickLoadingMeta(action, target);
  const token = ++clickLoadingSeq;
  clickLoadingState = {
    token,
    action,
    key: clickLoadingTargetKey(action, target),
    label: meta.label,
    surface: meta.surface || '',
    startedAt: Date.now(),
  };
  setClickLoadingButton(target, true);
  if (clickLoadingState.surface) render();
  return token;
}

function finishClickLoading(token, target) {
  if (!token) return;
  setClickLoadingButton(target, false);
  const shouldRender = clickLoadingState.token === token && Boolean(clickLoadingState.surface);
  if (clickLoadingState.token === token) {
    clickLoadingState = { token: 0, action: '', key: '', label: '', surface: '', startedAt: 0 };
  }
  if (shouldRender) render();
}

function renderClickLoadingSurface(surface) {
  if (!clickLoadingState.surface || clickLoadingState.surface !== surface) return '';
  return `
    <div class="click-loading-surface click-loading-${escapeHtml(surface)}" role="status" aria-live="polite">
      <span>${escapeHtml(clickLoadingState.label || 'Loading...')}</span>
    </div>
  `;
}

function normalizeAgentDetailTab(value = '') {
  const tab = String(value || '').trim().toLowerCase();
  return ['profile', 'skills', 'dms', 'reminders', 'workspace', 'activity'].includes(tab) ? tab : 'profile';
}

function agentDetailTabLoadingText(tab) {
  return {
    profile: 'Loading profile...',
    skills: 'Loading skills...',
    dms: 'Loading agent DMs...',
    reminders: 'Loading reminders...',
    workspace: 'Loading workspace...',
    activity: 'Loading activity...',
  }[normalizeAgentDetailTab(tab)] || 'Loading agent detail...';
}

function agentDetailTabDebugDelayMs() {
  const params = new URLSearchParams(window.location.search || '');
  const raw = params.get('agentDetailLoadingDelayMs')
    || params.get('clickLoadingDelayMs')
    || localStorage.getItem('magclawAgentDetailLoadingDelayMs')
    || localStorage.getItem('magclawClickLoadingDelayMs')
    || window.__MAGCLAW_AGENT_DETAIL_LOADING_DELAY_MS
    || window.__MAGCLAW_CLICK_LOADING_DELAY_MS
    || 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, 5000);
}

function waitForAgentDetailTabDebugDelay(delayMs) {
  return delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve();
}

function agentDetailTabDataReady(agentId, tab) {
  const normalized = normalizeAgentDetailTab(tab);
  if (!agentId) return true;
  if (normalized === 'activity') {
    const activity = agentActivityCache[agentId];
    return Boolean(activity && !activity.loading && !activity.error);
  }
  if (normalized === 'skills') {
    const skills = agentSkillsCache[agentId];
    return Boolean(skills && !skills.loading && !skills.error);
  }
  if (normalized === 'workspace') {
    const root = agentWorkspaceTreeCache[agentWorkspaceKey(agentId, '')];
    const previewPath = selectedAgentWorkspaceFile?.agentId === agentId
      ? selectedAgentWorkspaceFile.path
      : 'MEMORY.md';
    const preview = agentWorkspaceFilePreviews[agentWorkspaceKey(agentId, previewPath)];
    return Boolean(root && !root.loading && !root.error && preview && !preview.loading && !preview.error);
  }
  return true;
}

async function warmAgentDetailTab(agentId, tab) {
  const normalized = normalizeAgentDetailTab(tab);
  if (!agentId) return;
  if (normalized === 'workspace') {
    await prepareAgentWorkspaceTab(agentId);
    return;
  }
  if (normalized === 'skills') {
    await loadAgentSkills(agentId);
    return;
  }
  if (normalized === 'activity') {
    await loadAgentActivity(agentId);
    return;
  }
  if (normalized === 'profile') {
    loadAgentSkills(agentId).catch((error) => toast(error.message));
  }
}

async function switchAgentDetailTab(agentId, tab) {
  const nextTab = normalizeAgentDetailTab(tab);
  agentDetailTab = nextTab;
  agentDetailEditState = { field: null };
  agentEnvEditState = null;

  const delayMs = agentDetailTabDebugDelayMs();
  const shouldShowLoading = delayMs > 0 || !agentDetailTabDataReady(agentId, nextTab);
  const token = ++agentDetailTabLoadSeq;

  if (!shouldShowLoading) {
    agentDetailTabLoading = { agentId: null, tab: null, token };
    renderAgentDetailUpdate(agentId);
    await warmAgentDetailTab(agentId, nextTab);
    return;
  }

  agentDetailTabLoading = { agentId, tab: nextTab, token };
  renderAgentDetailUpdate(agentId);

  try {
    await Promise.all([
      warmAgentDetailTab(agentId, nextTab),
      waitForAgentDetailTabDebugDelay(delayMs),
    ]);
  } finally {
    if (
      agentDetailTabLoading.token === token
      && agentDetailTabLoading.agentId === agentId
      && agentDetailTabLoading.tab === nextTab
    ) {
      agentDetailTabLoading = { agentId: null, tab: null, token };
      renderAgentDetailUpdate(agentId);
    }
  }
}

async function loadAgentSkills(agentId, { force = false } = {}) {
  if (!agentId) return;
  if (!force && agentSkillsCache[agentId] && !agentSkillsCache[agentId].error) return;
  agentSkillsCache[agentId] = { loading: true, global: [], workspace: [], plugin: [], tools: [], error: '' };
  renderAgentDetailUpdate(agentId);
  try {
    agentSkillsCache[agentId] = await api(`/api/agents/${encodeURIComponent(agentId)}/skills`);
  } catch (error) {
    agentSkillsCache[agentId] = { loading: false, global: [], workspace: [], plugin: [], tools: [], error: error.message };
  }
  renderAgentDetailUpdate(agentId);
}

function agentActivityCacheFor(agentId) {
  return agentActivityCache[agentId] || null;
}

async function loadAgentActivity(agentId, { force = false } = {}) {
  if (!agentId) return;
  const cached = agentActivityCache[agentId];
  if (!force && cached && !cached.loading && !cached.error) return;
  agentActivityCache[agentId] = {
    loading: true,
    error: '',
    events: cached?.events || [],
    hasMore: false,
    nextBefore: '',
    windowStart: '',
    windowEnd: '',
  };
  renderAgentDetailUpdate(agentId);
  const params = new URLSearchParams();
  params.set('days', String(AGENT_ACTIVITY_HISTORY_DAYS));
  params.set('limit', String(AGENT_ACTIVITY_EVENT_LIMIT));
  try {
    agentActivityCache[agentId] = await api(`/api/agents/${encodeURIComponent(agentId)}/activity?${params.toString()}`);
  } catch (error) {
    agentActivityCache[agentId] = {
      loading: false,
      error: error.message,
      events: cached?.events || [],
      hasMore: false,
      nextBefore: '',
      windowStart: cached?.windowStart || '',
      windowEnd: cached?.windowEnd || '',
    };
  }
  renderAgentDetailUpdate(agentId);
}
