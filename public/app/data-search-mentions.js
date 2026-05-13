function byId(list, id) {
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
  const human = typeof humanByIdAny === 'function' ? humanByIdAny(id) : byId(appState?.humans, id);
  if (human) return human.name;
  const agent = byId(appState?.agents, id);
  if (agent) return agent.name;
  return id === 'system' ? 'Magclaw' : 'Unknown';
}

const SYSTEM_AVATAR_SRC = BRAND_LOGO_SRC;

function displayAvatar(id, type) {
  const name = displayName(id);
  if (type === 'system') return 'MC';
  return name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
}

function getAvatarHtml(id, type, cssClass = '') {
  if (type === 'system') {
    return `<img src="${SYSTEM_AVATAR_SRC}" class="${cssClass} avatar-img system-avatar-img" alt="Magclaw" />`;
  }
    const agent = byId(appState?.agents, id);
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

function renderAgentHoverCard(agent) {
  const status = agent ? agentDisplayStatus(agent) : 'offline';
  const description = agent?.description || agent?.runtime || 'Agent';
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
    </span>
  `;
}

function renderAgentIdentityButton(agentId, className = '') {
  const agent = byId(appState?.agents, agentId);
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
    </button>
  `;
}

function renderActorAvatar(authorId, authorType) {
  if (authorType === 'agent') {
    return `<div class="avatar agent-avatar-cell">${renderAgentIdentityButton(authorId, 'agent-avatar-button')}${agentStatusDot(authorId, authorType)}</div>`;
  }
  if (authorType === 'human') {
    return `<div class="avatar human-avatar-cell">${renderHumanIdentityButton(authorId, 'human-avatar-button')}${humanStatusDot(authorId, authorType)}</div>`;
  }
  return `<div class="avatar">${getAvatarHtml(authorId, authorType, 'avatar-inner')}${humanStatusDot(authorId, authorType)}</div>`;
}

function renderActorName(authorId, authorType) {
  if (authorType === 'human') {
    return `<strong class="human-author-name">${escapeHtml(displayName(authorId))}${humanBadgeHtml()}</strong>`;
  }
  if (authorType !== 'agent') return `<strong>${escapeHtml(displayName(authorId))}</strong>`;
  const agent = byId(appState?.agents, authorId);
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
    const agent = byId(appState?.agents, id);
    const name = agent?.name || (id === 'agt_codex' ? displayName(id) : '');
    return name
      ? `<span class="mention-tag mention-identity mention-agent" data-mention-id="${id}">@${escapeHtml(name)}</span>`
      : match;
  });
  // Replace human mentions: <@hum_xxx> -> styled span
  result = result.replace(/&lt;@(hum_\w+)&gt;/g, (match, id) => {
    const human = byId(appState?.humans, id);
    return human
      ? `<span class="mention-tag mention-human" data-mention-id="${id}">@${escapeHtml(human.name)}</span>`
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
  const human = byId(stateSnapshot?.humans, id);
  if (human) return human.name;
  const agent = byId(stateSnapshot?.agents, id);
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
  const task = byId(appState?.tasks, record?.taskId || parent?.taskId);
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

function searchRecordMatchesFilters(record) {
  if (searchMineOnly && record?.authorId !== 'hum_local') return false;
  const bounds = searchRangeBounds(searchTimeRange);
  if (bounds.after) {
    const created = new Date(record?.createdAt || 0).getTime();
    if (!created || created < bounds.after) return false;
  }
  return true;
}

function currentSearchMessageResults() {
  return searchRecords(searchQuery).filter(searchRecordMatchesFilters);
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
  if (item.type === 'agent' && item.avatar) return `<img src="${escapeHtml(item.avatar)}" class="mention-avatar" alt="" />`;
  if (item.type === 'file') return '<span class="mention-avatar-text mention-file-avatar">FILE</span>';
  if (item.type === 'folder') return '<span class="mention-avatar-text mention-folder-avatar">DIR</span>';
  return `<span class="mention-avatar-text">${escapeHtml(item.name.slice(0, 2).toUpperCase())}</span>`;
}

function mentionHandle(item) {
  if (item.type === 'human') return `@${item.handle || item.id}`;
  if (item.type === 'file' || item.type === 'folder') return item.absolutePath || item.path || item.projectName || item.name;
  return `@${item.name}`;
}

function mentionDisplay(item) {
  return `@${item.name}`;
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
      role: member.role || member.human?.role || 'member',
      status: member.human?.status || 'offline',
      avatar: member.human?.avatar || member.human?.avatarUrl || '',
    });
  }
  return [...humans.values()];
}

function getMentionCandidates(query, spaceType = selectedSpaceType, spaceId = selectedSpaceId) {
  const inMembers = spaceType === 'channel'
    ? getChannelMembers(spaceId)
    : {
      agents: (appState.agents || []).filter((agent) => byId(appState.dms, spaceId)?.participantIds?.includes(agent.id)),
      humans: mentionWorkspaceHumans().filter((human) => byId(appState.dms, spaceId)?.participantIds?.includes(human.id)),
    };
  const inIds = new Set([...inMembers.agents.map((a) => a.id), ...inMembers.humans.map((h) => h.id)]);
  const allItems = [
    ...(appState.agents || []).filter((agent) => (
      typeof agentIsActiveInWorkspace === 'function'
        ? agentIsActiveInWorkspace(agent)
        : !agent?.deletedAt && !agent?.archivedAt && String(agent?.status || '').toLowerCase() !== 'deleted'
    )).map((agent) => ({
      id: agent.id,
      name: agent.name,
      type: 'agent',
      avatar: agent.avatar,
      status: agent.status || 'offline',
      description: agent.description || agent.runtime || 'Agent',
      group: inIds.has(agent.id) ? 'in' : 'out',
    })),
    ...mentionWorkspaceHumans().map((human) => ({
      id: human.id,
      name: human.name,
      type: 'human',
      avatar: human.avatar,
      status: human.status || 'offline',
      handle: human.email ? human.email.split('@')[0] : human.id.replace(/^hum_/, ''),
      description: human.role || 'Human',
      group: inIds.has(human.id) ? 'in' : 'out',
    })),
  ];
  const q = String(query || '').toLowerCase();
  return allItems
    .filter((item) => !q || item.name.toLowerCase().includes(q) || mentionHandle(item).toLowerCase().includes(q))
    .sort((a, b) => (a.group === b.group ? a.name.localeCompare(b.name) : a.group === 'in' ? -1 : 1));
}

async function getProjectMentionCandidates(query, spaceType = selectedSpaceType, spaceId = selectedSpaceId) {
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
  const groups = [
    ['in', 'PEOPLE IN THIS CHANNEL'],
    ['folders', 'FOLDERS'],
    ['files', 'FILES'],
    ['out', 'OTHER PEOPLE'],
  ];
  let cursor = 0;
  return `
    <div class="mention-popup" id="mention-popup" data-composer-id="${escapeHtml(mentionPopup.composerId || '')}">
      ${groups.map(([group, label]) => {
        const items = mentionPopup.items.filter((item) => item.group === group);
        if (!items.length) return '';
        const section = `
          <div class="mention-section-title">${escapeHtml(label)}</div>
          ${items.map((item) => {
            const idx = cursor;
            const handle = mentionHandle(item);
            cursor += 1;
            return `
              <div class="mention-item mention-type-${escapeHtml(item.type)} ${idx === mentionPopup.selectedIndex ? 'selected' : ''}" data-mention-idx="${idx}">
                ${mentionAvatar(item)}
                <span class="mention-status ${item.type === 'file' ? 'mention-status-file' : item.type === 'folder' ? 'mention-status-folder' : presenceClass(item.status)}"></span>
                <span class="mention-name">${escapeHtml(item.name)}</span>
                <span class="mention-handle" title="${escapeHtml(handle)}">${escapeHtml(handle)}</span>
              </div>
            `;
          }).join('')}
        `;
        return section;
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
    composerDrafts[textarea.dataset.composerId] = textarea.value;
    rememberComposerMention(textarea.dataset.composerId, item);
    if (item.type === 'file' || item.type === 'folder') {
      toast(`${item.type === 'file' ? 'File' : 'Folder'} referenced from project`);
    }
  }
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
  return [...(appState?.messages || []), ...(appState?.replies || [])]
    .filter((record) => record.savedBy?.includes('hum_local'))
    .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
}

function savedRecordThreadRoot(record) {
  if (!record) return null;
  if (record.parentMessageId) return byId(appState?.messages, record.parentMessageId);
  if (record.replyCount > 0 || record.taskId) return record;
  return null;
}

function spaceMessages(spaceType = selectedSpaceType, spaceId = selectedSpaceId) {
  return (appState?.messages || [])
    .filter((message) => message.spaceType === spaceType && message.spaceId === spaceId)
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

async function loadAgentWorkspace(agentId, relPath = '') {
  const key = agentWorkspaceKey(agentId, relPath);
  agentWorkspaceTreeCache[key] = { loading: true, entries: [], error: '' };
  render();
  try {
    const params = new URLSearchParams();
    if (relPath) params.set('path', relPath);
    const suffix = params.toString() ? `?${params.toString()}` : '';
    agentWorkspaceTreeCache[key] = await api(`/api/agents/${encodeURIComponent(agentId)}/workspace${suffix}`);
  } catch (error) {
    agentWorkspaceTreeCache[key] = { loading: false, entries: [], error: error.message };
  }
  render();
}

async function toggleAgentWorkspace(agentId, relPath = '') {
  const key = agentWorkspaceKey(agentId, relPath);
  if (expandedAgentWorkspaceTrees[key]) {
    delete expandedAgentWorkspaceTrees[key];
    render();
    return;
  }
  expandedAgentWorkspaceTrees[key] = true;
  if (!agentWorkspaceTreeCache[key]) await loadAgentWorkspace(agentId, relPath);
  else render();
}

async function openAgentWorkspaceFile(agentId, relPath = '') {
  const key = agentWorkspaceKey(agentId, relPath);
  selectedAgentWorkspaceFile = { agentId, path: relPath };
  agentWorkspaceFilePreviews[key] = agentWorkspaceFilePreviews[key] || { loading: true, file: null, error: '' };
  render();
  try {
    const params = new URLSearchParams({ path: relPath });
    agentWorkspaceFilePreviews[key] = await api(`/api/agents/${encodeURIComponent(agentId)}/workspace/file?${params.toString()}`);
  } catch (error) {
    agentWorkspaceFilePreviews[key] = { loading: false, file: null, error: error.message };
  }
  render();
}

async function prepareAgentWorkspaceTab(agentId) {
  if (!agentId) return;
  const rootKey = agentWorkspaceKey(agentId, '');
  expandedAgentWorkspaceTrees[rootKey] = true;
  if (!agentWorkspaceTreeCache[rootKey]) await loadAgentWorkspace(agentId, '');
  if (!selectedAgentWorkspaceFile || selectedAgentWorkspaceFile.agentId !== agentId) {
    await openAgentWorkspaceFile(agentId, 'MEMORY.md');
  } else {
    render();
  }
}

async function refreshAgentWorkspace(agentId) {
  if (!agentId) return;
  clearAgentWorkspaceCaches(agentId);
  expandedAgentWorkspaceTrees[agentWorkspaceKey(agentId, '')] = true;
  await loadAgentWorkspace(agentId, '');
  await openAgentWorkspaceFile(agentId, 'MEMORY.md');
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

async function loadAgentSkills(agentId, { force = false } = {}) {
  if (!agentId) return;
  if (!force && agentSkillsCache[agentId] && !agentSkillsCache[agentId].error) return;
  agentSkillsCache[agentId] = { loading: true, global: [], workspace: [], plugin: [], tools: [], error: '' };
  render();
  try {
    agentSkillsCache[agentId] = await api(`/api/agents/${encodeURIComponent(agentId)}/skills`);
  } catch (error) {
    agentSkillsCache[agentId] = { loading: false, global: [], workspace: [], plugin: [], tools: [], error: error.message };
  }
  render();
}
