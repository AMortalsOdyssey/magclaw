const root = document.querySelector('#root');
const TASK_COLUMN_COLLAPSE_KEY = 'magclawTaskColumnCollapse';

let appState = null;
let selectedSpaceType = 'channel';
let selectedSpaceId = 'chan_all';
let activeView = 'space';
let activeTab = 'chat';
let railTab = localStorage.getItem('railTab') || 'spaces'; // 'spaces' or 'members'
let threadMessageId = null;
let selectedAgentId = null; // selected agent for detail panel
let modal = null;
let agentRestartState = { agentId: null, mode: 'restart' };
let searchQuery = '';
let addMemberSearchQuery = '';
let taskFilter = 'all';
let collapsedTaskColumns = readCollapsedTaskColumns();
let stagedByComposer = {};
let composerDrafts = {};
let composerTaskFlags = {};
let composerMentionMaps = {};
let installedRuntimes = [];
let selectedRuntimeId = null;
let backBottomVisible = { main: false, thread: false };
let pendingBottomScroll = { main: false, thread: false };
let mentionLookupSeq = 0;
let expandedProjectTrees = {};
let projectTreeCache = {};
let projectFilePreviews = {};
let selectedProjectFile = null;
let expandedAgentWorkspaceTrees = {};
let agentWorkspaceTreeCache = {};
let agentWorkspaceFilePreviews = {};
let selectedAgentWorkspaceFile = null;

const BOTTOM_THRESHOLD = 72;
const MAX_ATTACHMENTS_PER_COMPOSER = 20;
const AGENT_AVATAR_UPLOAD_MAX_BYTES = 2 * 1024 * 1024;
const RAIL_WIDTH_KEY = 'magclawRailWidth';
const RAIL_MIN_WIDTH = 176;
const RAIL_MAX_WIDTH = 360;
const INSPECTOR_WIDTH_KEY = 'magclawInspectorWidth';
const INSPECTOR_MIN_WIDTH = 260;
const INSPECTOR_MAX_WIDTH = 620;
let railWidth = readStoredRailWidth();
let inspectorWidth = readStoredInspectorWidth();

// @ mention autocomplete state
let mentionPopup = {
  active: false,
  query: '',
  items: [],
  selectedIndex: 0,
  triggerPosition: null,
  composerId: null,
};

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

// Avatar list (2000 avatars: 1-1000 faces, 1001-2000 objects)
const AVATAR_COUNT = 2000;
function getRandomAvatar() {
  const idx = Math.floor(Math.random() * AVATAR_COUNT) + 1;
  return `/avatars/avatar_${String(idx).padStart(4, '0')}.svg`;
}

function trashIcon() {
  return '<svg class="project-remove-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 15h10l1-15"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
}

function folderIcon() {
  return '<svg class="project-folder-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M3 6h7l2 3h9v10H3z"/><path d="M3 9h18"/></svg>';
}

function treeIcon() {
  return '<svg class="project-tree-icon-svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M6 3v18"/><path d="M6 7h8"/><path d="M6 17h8"/><path d="M14 5h6v4h-6z"/><path d="M14 15h6v4h-6z"/></svg>';
}

function channelActionIcon(name) {
  const icons = {
    stop: '<rect x="7" y="7" width="10" height="10" />',
    settings: '<circle cx="12" cy="12" r="3" /><path d="M12 3v3" /><path d="M12 18v3" /><path d="M3 12h3" /><path d="M18 12h3" /><path d="M5.6 5.6l2.1 2.1" /><path d="M16.3 16.3l2.1 2.1" /><path d="M18.4 5.6l-2.1 2.1" /><path d="M7.7 16.3l-2.1 2.1" />',
    leave: '<path d="M10 6H5v12h5" /><path d="M13 8l4 4-4 4" /><path d="M8 12h9" />',
    members: '<circle cx="9" cy="8" r="3" /><path d="M3 19c.8-3 2.7-5 6-5s5.2 2 6 5" /><circle cx="17" cy="10" r="2" /><path d="M15.5 15.5c2.4.3 4 1.7 4.5 3.5" />',
    folder: '<path d="M3 7h7l2 3h9v9H3z" /><path d="M3 10h18" />',
    task: '<path d="M6 4h12v16H6z" /><path d="M9 9h6" /><path d="M9 13h6" /><path d="M9 17h4" />',
  };
  return `<svg class="channel-action-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">${icons[name] || ''}</svg>`;
}

const taskColumns = [
  ['todo', 'Todo'],
  ['in_progress', 'In Progress'],
  ['in_review', 'In Review'],
  ['done', 'Done'],
  ['cancelled', 'Cancelled'],
];

function taskIsClosedStatus(status) {
  return ['done', 'cancelled'].includes(status);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function safeMarkdownHref(value) {
  const href = String(value || '').trim();
  if (/^(https?:|mailto:|#)/i.test(href)) return href;
  return '#';
}

function renderMarkdownInline(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, href) => `<a href="${escapeHtml(safeMarkdownHref(href))}" target="_blank" rel="noreferrer">${label}</a>`);
}

function renderMarkdown(content) {
  const lines = String(content || '').split(/\r?\n/);
  const blocks = [];
  let paragraph = [];
  let list = [];
  let tableRows = [];
  let inCode = false;
  let codeLines = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push(`<p>${renderMarkdownInline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    blocks.push(`<ul>${list.map((item) => `<li>${renderMarkdownInline(item)}</li>`).join('')}</ul>`);
    list = [];
  };
  const isTableRow = (line) => {
    const trimmed = line.trim();
    return trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.slice(1, -1).includes('|');
  };
  const isTableSeparator = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
  const splitTableCells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
  const flushTable = () => {
    if (!tableRows.length) return;
    const [header, separator, ...body] = tableRows;
    if (tableRows.length >= 2 && isTableSeparator(separator)) {
      const headers = splitTableCells(header);
      const rows = body.map(splitTableCells);
      blocks.push(`
        <div class="message-table-wrap">
          <table class="message-table">
            <thead><tr>${headers.map((cell) => `<th>${renderMarkdownInline(cell)}</th>`).join('')}</tr></thead>
            <tbody>${rows.map((row) => `<tr>${headers.map((_, index) => `<td>${renderMarkdownInline(row[index] || '')}</td>`).join('')}</tr>`).join('')}</tbody>
          </table>
        </div>
      `);
    } else {
      paragraph.push(...tableRows.map((line) => line.trim()));
    }
    tableRows = [];
  };

  for (const line of lines) {
    const fence = line.match(/^```/);
    if (fence) {
      if (inCode) {
        blocks.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else {
        flushParagraph();
        flushList();
        flushTable();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      flushTable();
      continue;
    }
    if (isTableRow(line) || (tableRows.length && isTableSeparator(line))) {
      flushParagraph();
      flushList();
      tableRows.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      flushTable();
      const level = Math.min(6, heading[1].length);
      blocks.push(`<h${level}>${renderMarkdownInline(heading[2])}</h${level}>`);
      continue;
    }
    const listItem = line.match(/^\s*(?:[-*+]|\d+\.)\s+(.+)$/);
    if (listItem) {
      flushParagraph();
      flushTable();
      list.push(listItem[1]);
      continue;
    }
    const quote = line.match(/^>\s?(.+)$/);
    if (quote) {
      flushParagraph();
      flushList();
      flushTable();
      blocks.push(`<blockquote>${renderMarkdownInline(quote[1])}</blockquote>`);
      continue;
    }
    if (/^---+$/.test(line.trim())) {
      flushParagraph();
      flushList();
      flushTable();
      blocks.push('<hr />');
      continue;
    }
    flushTable();
    paragraph.push(line.trim());
  }
  if (inCode) blocks.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  flushParagraph();
  flushList();
  flushTable();
  return blocks.join('');
}

function renderMarkdownWithMentions(content) {
  const tokens = [];
  const markerPrefix = 'MAGCLAWMENTION';
  const marked = String(content || '').replace(/<(@|!|#)[^>]+>/g, (token) => {
    const marker = `${markerPrefix}${tokens.length}TOKEN`;
    tokens.push(token);
    return marker;
  });
  let html = renderMarkdown(marked);
  tokens.forEach((token, index) => {
    const marker = `${markerPrefix}${index}TOKEN`;
    html = html.replaceAll(marker, parseMentions(token));
  });
  return html;
}

function readCollapsedTaskColumns() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TASK_COLUMN_COLLAPSE_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function toggleTaskColumn(status) {
  collapsedTaskColumns = {
    ...collapsedTaskColumns,
    [status]: !collapsedTaskColumns[status],
  };
  localStorage.setItem(TASK_COLUMN_COLLAPSE_KEY, JSON.stringify(collapsedTaskColumns));
}

function readStoredInspectorWidth() {
  const raw = localStorage.getItem(INSPECTOR_WIDTH_KEY);
  if (raw === null) return 360;
  const saved = Number(raw);
  if (!Number.isFinite(saved)) return 360;
  return Math.min(INSPECTOR_MAX_WIDTH, Math.max(INSPECTOR_MIN_WIDTH, saved));
}

function readStoredRailWidth() {
  const raw = localStorage.getItem(RAIL_WIDTH_KEY);
  if (raw === null) return 236;
  const saved = Number(raw);
  if (!Number.isFinite(saved)) return 236;
  return Math.min(RAIL_MAX_WIDTH, Math.max(RAIL_MIN_WIDTH, saved));
}

function workspaceMinWidth() {
  return window.matchMedia('(max-width: 1200px)').matches ? 300 : 360;
}

function railWidthMax(frame) {
  if (!frame) return RAIL_MAX_WIDTH;
  const frameWidth = frame.getBoundingClientRect().width;
  if (!frameWidth) return RAIL_MAX_WIDTH;
  const inspectorActualWidth = frame?.querySelector('.inspector')?.getBoundingClientRect().width || inspectorWidth;
  const railSplitterWidth = frame?.querySelector('.rail-resizer')?.getBoundingClientRect().width || 8;
  const inspectorSplitterWidth = frame?.querySelector('.inspector-resizer')?.getBoundingClientRect().width || 8;
  return Math.max(
    RAIL_MIN_WIDTH,
    Math.min(RAIL_MAX_WIDTH, frameWidth - inspectorActualWidth - railSplitterWidth - inspectorSplitterWidth - workspaceMinWidth()),
  );
}

function clampRailWidth(width, frame = document.querySelector('.app-frame')) {
  const maxWidth = railWidthMax(frame);
  return Math.round(Math.min(maxWidth, Math.max(RAIL_MIN_WIDTH, Number(width) || 236)));
}

function setRailWidth(width, { persist = false, frame = document.querySelector('.app-frame') } = {}) {
  railWidth = clampRailWidth(width, frame);
  frame?.style.setProperty('--rail-width', `${railWidth}px`);
  if (persist) localStorage.setItem(RAIL_WIDTH_KEY, String(railWidth));
}

function inspectorWidthMax(frame) {
  if (!frame) return INSPECTOR_MAX_WIDTH;
  const frameWidth = frame.getBoundingClientRect().width;
  if (!frameWidth) return INSPECTOR_MAX_WIDTH;
  const railActualWidth = frame?.querySelector('.rail')?.getBoundingClientRect().width || railWidth;
  const railSplitterWidth = frame?.querySelector('.rail-resizer')?.getBoundingClientRect().width || 8;
  const inspectorSplitterWidth = frame?.querySelector('.inspector-resizer')?.getBoundingClientRect().width || 8;
  return Math.max(
    INSPECTOR_MIN_WIDTH,
    Math.min(INSPECTOR_MAX_WIDTH, frameWidth - railActualWidth - railSplitterWidth - inspectorSplitterWidth - workspaceMinWidth()),
  );
}

function clampInspectorWidth(width, frame = document.querySelector('.app-frame')) {
  const maxWidth = inspectorWidthMax(frame);
  return Math.round(Math.min(maxWidth, Math.max(INSPECTOR_MIN_WIDTH, Number(width) || 360)));
}

function setInspectorWidth(width, { persist = false, frame = document.querySelector('.app-frame') } = {}) {
  inspectorWidth = clampInspectorWidth(width, frame);
  frame?.style.setProperty('--inspector-width', `${inspectorWidth}px`);
  if (persist) localStorage.setItem(INSPECTOR_WIDTH_KEY, String(inspectorWidth));
}

function appFrameStyle() {
  return `--rail-width: ${railWidth}px; --inspector-width: ${inspectorWidth}px;`;
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

function readAvatarFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read avatar file.'));
    reader.readAsDataURL(file);
  });
}

async function uploadAgentAvatar(input) {
  const agentId = input?.dataset?.id || selectedAgentId;
  const file = input?.files?.[0];
  if (!agentId || !file) return;
  if (file.size > AGENT_AVATAR_UPLOAD_MAX_BYTES) {
    toast('Avatar must be 2 MB or smaller');
    input.value = '';
    return;
  }
  const avatar = await readAvatarFileAsDataUrl(file);
  await api(`/api/agents/${encodeURIComponent(agentId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ avatar }),
  });
  const form = input.closest('#agent-detail-form');
  const preview = form?.querySelector('.agent-detail-avatar-preview');
  const hidden = form?.querySelector('input[name="avatar"]');
  if (preview) preview.src = avatar;
  if (hidden) hidden.value = avatar;
  toast('Avatar updated');
  await refreshState().catch(() => {});
}

function byId(list, id) {
  return (list || []).find((item) => item.id === id) || null;
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

function agentHandle(agent) {
  return `@${String(agent?.name || 'agent').replace(/\s+/g, '')}`;
}

function renderAgentHoverCard(agent) {
  const status = agent?.status || 'offline';
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

function renderActorAvatar(authorId, authorType) {
  if (authorType === 'agent') {
    return `<div class="avatar agent-avatar-cell">${renderAgentIdentityButton(authorId, 'agent-avatar-button')}</div>`;
  }
  return `<div class="avatar">${getAvatarHtml(authorId, authorType, 'avatar-inner')}</div>`;
}

function renderActorName(authorId, authorType) {
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
    return agent
      ? `<span class="mention-tag mention-identity" data-mention-id="${id}">@${escapeHtml(agent.name)}</span>`
      : match;
  });
  // Replace human mentions: <@hum_xxx> -> styled span
  result = result.replace(/&lt;@(hum_\w+)&gt;/g, (match, id) => {
    const human = byId(appState?.humans, id);
    return human
      ? `<span class="mention-tag mention-identity" data-mention-id="${id}">@${escapeHtml(human.name)}</span>`
      : match;
  });
  // Replace special mentions: <!all>, <!here> -> styled span
  result = result.replace(/&lt;!(all|here|channel|everyone)&gt;/g, (match, type) => {
    return `<span class="mention-tag mention-special" data-mention-type="${type}">@${type}</span>`;
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
    .replace(/\s+/g, ' ')
    .trim();
}

function plainActorText(text) {
  return String(text || '').replace(/\b(agt_\w+|hum_\w+)\b/g, (_, id) => displayName(id));
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

function getMentionCandidates(query, spaceType = selectedSpaceType, spaceId = selectedSpaceId) {
  const inMembers = spaceType === 'channel'
    ? getChannelMembers(spaceId)
    : {
      agents: (appState.agents || []).filter((agent) => byId(appState.dms, spaceId)?.participantIds?.includes(agent.id)),
      humans: (appState.humans || []).filter((human) => byId(appState.dms, spaceId)?.participantIds?.includes(human.id)),
    };
  const inIds = new Set([...inMembers.agents.map((a) => a.id), ...inMembers.humans.map((h) => h.id)]);
  const allItems = [
    ...(appState.agents || []).map((agent) => ({
      id: agent.id,
      name: agent.name,
      type: 'agent',
      avatar: agent.avatar,
      status: agent.status || 'offline',
      description: agent.description || agent.runtime || 'Agent',
      group: inIds.has(agent.id) ? 'in' : 'out',
    })),
    ...(appState.humans || []).map((human) => ({
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
  const other = dm?.participantIds?.find((id) => id !== 'hum_local');
  return `@${displayName(other || 'unknown')}`;
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

function threadUpdatedAt(message) {
  const replies = threadReplies(message.id);
  const lastReply = replies.at(-1);
  return new Date(lastReply?.createdAt || message.updatedAt || message.createdAt || 0).getTime();
}

function taskThreadMessage(task) {
  return byId(appState?.messages, task?.threadMessageId || task?.messageId);
}

function taskTone(status) {
  if (status === 'cancelled') return 'red';
  if (status === 'done') return 'green';
  if (status === 'in_review') return 'amber';
  if (status === 'in_progress') return 'cyan';
  return 'blue';
}

function presenceTone(status) {
  const value = String(status || '').toLowerCase();
  if (['working', 'running', 'starting', 'thinking', 'busy'].includes(value)) return 'busy';
  if (['queued', 'pending'].includes(value)) return 'queued';
  if (['error', 'failed'].includes(value)) return 'error';
  if (['online', 'idle', 'connected'].includes(value)) return 'online';
  return 'offline';
}

function presenceClass(status) {
  return `status-${presenceTone(status)}`;
}

function agentStatusDot(authorId, authorType) {
  if (authorType !== 'agent') return '';
  const agent = byId(appState?.agents, authorId);
  const status = agent?.status || 'offline';
  return `<span class="message-author-status ${presenceClass(status)}" title="${escapeHtml(status)}" aria-label="Agent status: ${escapeHtml(status)}"></span>`;
}

function attachmentLinks(ids = []) {
  return ids
    .map((id) => byId(appState?.attachments, id))
    .filter(Boolean)
    .map((item) => `
      <a class="mini-attachment ${String(item.type || '').startsWith('image/') ? 'image-attachment' : ''}" href="${item.url}" target="_blank" rel="noreferrer">
        ${String(item.type || '').startsWith('image/') ? `<img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.name)}" />` : '<span class="file-glyph">□</span>'}
        <span>${escapeHtml(item.name)}</span>
        <small>${bytes(item.bytes)}</small>
      </a>
    `)
    .join('');
}

function composerIdFor(kind, id = '') {
  if (kind === 'thread') return `thread:${id || threadMessageId || 'none'}`;
  return `message:${selectedSpaceType}:${selectedSpaceId}`;
}

function stagedFor(composerId) {
  return stagedByComposer[composerId] || { attachments: [], ids: [] };
}

function setStagedFor(composerId, attachments) {
  const unique = [];
  const seen = new Set();
  for (const item of attachments) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  stagedByComposer[composerId] = {
    attachments: unique,
    ids: unique.map((item) => item.id),
  };
}

function clearStagedFor(composerId) {
  delete stagedByComposer[composerId];
}

function renderAttachmentStrip(composerId) {
  const staged = stagedFor(composerId).attachments;
  return staged.map((item) => {
    const isImage = String(item.type || '').startsWith('image/');
    return `
      <span class="composer-attachment-chip ${isImage ? 'is-image' : ''}" data-attachment-id="${escapeHtml(item.id)}">
        ${isImage
          ? `<img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.name)}" />`
          : '<span class="composer-file-icon">FILE</span>'}
        <span class="composer-attachment-meta">
          <strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong>
          <small>${escapeHtml(item.type || 'file')} · ${bytes(item.bytes)}</small>
        </span>
        <button type="button" data-action="remove-staged-attachment" data-composer-id="${escapeHtml(composerId)}" data-id="${escapeHtml(item.id)}" title="Remove attachment" aria-label="Remove ${escapeHtml(item.name)}">&times;</button>
      </span>
    `;
  }).join('');
}

function updateComposerAttachmentStrip(composerId) {
  const strip = document.querySelector(`[data-attachment-strip="${CSS.escape(composerId)}"]`);
  if (!strip) return;
  const hasAttachments = stagedFor(composerId).attachments.length > 0;
  strip.innerHTML = renderAttachmentStrip(composerId);
  strip.classList.toggle('hidden', !hasAttachments);
}

function removeStagedAttachment(composerId, attachmentId) {
  const next = stagedFor(composerId).attachments.filter((item) => item.id !== attachmentId);
  setStagedFor(composerId, next);
  updateComposerAttachmentStrip(composerId);
}

function paneSelector(targetName) {
  return targetName === 'thread' ? '#thread-context' : '#message-list';
}

function paneKey(targetName) {
  if (targetName === 'thread') return threadMessageId ? `thread:${threadMessageId}` : '';
  return `main:${activeView}:${activeTab}:${selectedSpaceType}:${selectedSpaceId}`;
}

function paneIsAtBottom(node) {
  if (!node) return true;
  return node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_THRESHOLD;
}

function paneScrollSnapshot(targetName) {
  const node = document.querySelector(paneSelector(targetName));
  return {
    key: paneKey(targetName),
    top: node?.scrollTop || 0,
    atBottom: paneIsAtBottom(node),
  };
}

function rememberPinnedBottomBeforeStateChange() {
  for (const targetName of ['main', 'thread']) {
    const node = document.querySelector(paneSelector(targetName));
    if (node && paneIsAtBottom(node)) requestPaneBottomScroll(targetName);
  }
}

function setBackBottomVisible(targetName, visible) {
  backBottomVisible[targetName] = Boolean(visible);
  const button = document.querySelector(`.back-bottom[data-target="${targetName}"]`);
  if (button) button.classList.toggle('hidden', !backBottomVisible[targetName]);
}

function updateBackBottomVisibility(targetName) {
  const node = document.querySelector(paneSelector(targetName));
  const canScroll = Boolean(node && node.scrollHeight > node.clientHeight + BOTTOM_THRESHOLD);
  setBackBottomVisible(targetName, canScroll && !paneIsAtBottom(node));
}

function restorePaneScroll(targetName, snapshot) {
  const node = document.querySelector(paneSelector(targetName));
  if (!node) return;
  const forceBottom = pendingBottomScroll[targetName];
  pendingBottomScroll[targetName] = false;
  const shouldFollowBottom = forceBottom || snapshot?.atBottom;
  if (!shouldFollowBottom && snapshot?.key === paneKey(targetName)) {
    node.scrollTop = snapshot.top;
  } else {
    node.scrollTop = node.scrollHeight;
    window.setTimeout(() => {
      const current = document.querySelector(paneSelector(targetName));
      if (!current) return;
      current.scrollTop = current.scrollHeight;
      updateBackBottomVisibility(targetName);
    }, 40);
    window.setTimeout(() => {
      const current = document.querySelector(paneSelector(targetName));
      if (!current) return;
      current.scrollTop = current.scrollHeight;
      updateBackBottomVisibility(targetName);
    }, 160);
  }
  updateBackBottomVisibility(targetName);
}

function restorePaneScrolls(snapshot) {
  restorePaneScroll('main', snapshot.main);
  restorePaneScroll('thread', snapshot.thread);
}

function requestPaneBottomScroll(targetName) {
  pendingBottomScroll[targetName] = true;
}

function scrollToMessage(messageId) {
  window.setTimeout(() => {
    const node = document.querySelector(`#message-list #message-${CSS.escape(messageId)}`);
    const pane = document.querySelector('#message-list');
    if (node && pane) {
      const targetTop = node.offsetTop - (pane.clientHeight / 2) + (node.offsetHeight / 2);
      pane.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
      updateBackBottomVisibility('main');
      node.classList.add('focus-pulse');
      window.setTimeout(() => node.classList.remove('focus-pulse'), 1200);
    }
  }, 40);
}

function scrollPaneToBottom(selector, behavior = 'smooth') {
  const targetName = selector === '#thread-context' ? 'thread' : 'main';
  const scroll = () => {
    const node = document.querySelector(selector);
    if (node) {
      node.scrollTo({ top: node.scrollHeight, behavior });
      window.setTimeout(() => updateBackBottomVisibility(targetName), behavior === 'smooth' ? 260 : 20);
    }
  };
  window.setTimeout(scroll, 20);
  if (behavior !== 'smooth') window.setTimeout(scroll, 120);
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
  const scrollSnapshot = {
    main: paneScrollSnapshot('main'),
    thread: paneScrollSnapshot('thread'),
  };
  ensureSelection();
  const inspectorHtml = renderInspector();
  root.innerHTML = `
    <div class="app-frame collab-frame${inspectorHtml ? '' : ' no-inspector'}" style="${appFrameStyle()}">
      ${renderRail()}
      <div class="rail-resizer" data-action="none" role="separator" aria-label="Resize sidebar" aria-orientation="vertical" tabindex="0"></div>
      <main class="workspace collab-main">
        ${renderMain()}
      </main>
      ${inspectorHtml ? `
        <div class="inspector-resizer" data-action="none" role="separator" aria-label="Resize inspector panel" aria-orientation="vertical" tabindex="0"></div>
        <aside class="inspector collab-inspector">
          ${inspectorHtml}
        </aside>
      ` : ''}
    </div>
    ${modal ? renderModal() : ''}
  `;
  window.requestAnimationFrame(() => restorePaneScrolls(scrollSnapshot));
}

function renderRail() {
  const channels = appState.channels || [];
  const dms = appState.dms || [];
  const unreadThreads = (appState.messages || []).filter((message) => message.replyCount > 0 || message.taskId).length;
  const openTasks = (appState.tasks || []).filter((task) => !taskIsClosedStatus(task.status)).length;
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
  const initials = name.split(/\s+/).map((part) => part[0]).join('').slice(0, 2).toUpperCase();
  return `
    <button class="space-btn dm-btn${active}" type="button" data-action="select-space" data-type="dm" data-id="${id}">
      <span class="dm-avatar">${avatar ? `<img src="${avatar}" alt="">` : initials}</span>
      <span class="dm-name">${escapeHtml(name)}</span>
      <span class="dm-status ${presenceClass(status)}"></span>
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
  // "All" channel always includes all agents and humans
  if (channelId === 'chan_all') {
    return {
      agents: appState.agents || [],
      humans: appState.humans || [],
    };
  }
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
        <button class="back-bottom main-back-bottom${backBottomVisible.main ? '' : ' hidden'}" type="button" data-action="back-to-bottom" data-target="main">Back to Bottom</button>
      </div>
      ${renderComposer({ id: composerId, kind: 'message', placeholder: `Message ${spaceName(selectedSpaceType, selectedSpaceId)}`, showTaskToggle: true })}
    </section>
  `;
}

function actorSubtitle(authorId, authorType, message) {
  if (authorType === 'agent') {
    const agent = byId(appState.agents, authorId);
    return agent?.description || agent?.runtime || 'Agent';
  }
  if (authorType === 'human') {
    const human = byId(appState.humans, authorId);
    const owner = message?.spaceType === 'channel' ? byId(appState.channels, message.spaceId)?.ownerId : null;
    return human?.id === owner ? 'owner' : human?.role || 'human';
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

function renderSystemEvent(message) {
  return `
    <div class="system-event-row" id="message-${escapeHtml(message.id)}" data-message-id="${escapeHtml(message.id)}">
      <span>${parseMentions(message.body || '')}</span>
      <time>${fmtTime(message.createdAt)}</time>
    </div>
  `;
}

function renderMessage(message, options = {}) {
  if (message.authorType === 'system' && message.eventType) return renderSystemEvent(message);
  const task = message.taskId ? byId(appState.tasks, message.taskId) : null;
  const taskAssigneeIds = task ? (task.assigneeIds?.length ? task.assigneeIds : (task.assigneeId ? [task.assigneeId] : [])) : [];
  const taskBadgeName = taskAssigneeIds[0] ? ` @${displayName(taskAssigneeIds[0])}` : '';
  const saved = message.savedBy?.includes('hum_local');
  const replyCount = Number(message.replyCount || 0);
  const highlighted = threadMessageId === message.id ? ' highlighted' : '';
  const compact = options.compact ? ' compact' : '';
  const authorClass = ['agent', 'human', 'system'].includes(message.authorType) ? message.authorType : 'unknown';
  const replyActionLabel = replyCount ? `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}` : 'Reply';
  const agentAuthorAttr = message.authorType === 'agent' ? ` data-agent-author-id="${escapeHtml(message.authorId)}"` : '';
  return `
    <article class="message-card slock-message author-${authorClass}${highlighted}${compact}" id="message-${escapeHtml(message.id)}" data-message-id="${escapeHtml(message.id)}"${agentAuthorAttr}>
      ${renderActorAvatar(message.authorId, message.authorType)}
      <div class="message-body">
        <div class="message-meta">
          ${renderActorName(message.authorId, message.authorType)}${agentStatusDot(message.authorId, message.authorType)}
          <span class="sender-role">${escapeHtml(actorSubtitle(message.authorId, message.authorType, message))}</span>
          <time>${fmtTime(message.createdAt)}</time>
          ${task ? `<span class="task-number">#${escapeHtml(task.number || shortId(task.id))}${escapeHtml(taskBadgeName)}</span>${pill(task.status, taskTone(task.status))}` : ''}
        </div>
        <div class="message-markdown">${renderMarkdownWithMentions(message.body || '(attachment)')}</div>
        <div class="message-attachments">${attachmentLinks(message.attachmentIds)}</div>
        <div class="message-actions${replyCount ? ' has-replies' : ''}">
          <button class="reply-action${replyCount ? ' has-replies' : ''}" type="button" data-action="open-thread" data-id="${message.id}">${replyActionLabel}</button>
          <button type="button" data-action="save-message" data-id="${message.id}">${saved ? 'Unsave' : 'Save'}</button>
          ${task ? '' : `<button type="button" data-action="message-task" data-id="${message.id}">As Task</button>`}
        </div>
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
      ${visibleColumns.map(([status, label]) => {
        const columnTasks = filteredTasks.filter((task) => task.status === status);
        const collapsed = Boolean(collapsedTaskColumns[status]);
        return `
        <div class="task-column pixel-panel ${collapsed ? 'collapsed' : ''}">
          <div class="panel-title task-column-title">
            <button class="column-toggle" type="button" data-action="toggle-task-column" data-status="${status}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${escapeHtml(label)}">${collapsed ? '▸' : '▾'}</button>
            <span>${label}</span>
            <strong>${columnTasks.length}</strong>
          </div>
          ${collapsed ? '' : (columnTasks.map(renderTaskCard).join('') || '<div class="empty-box small">Empty</div>')}
        </div>
      `;
      }).join('')}
    </section>
  `;
}

function renderTaskCard(task) {
  const assigneeIds = task.assigneeIds?.length ? task.assigneeIds : (task.assigneeId ? [task.assigneeId] : []);
  const assignee = assigneeIds.length ? assigneeIds.map(displayName).join(', ') : 'unassigned';
  const claimed = task.claimedBy ? displayName(task.claimedBy) : 'unclaimed';
  const creator = task.createdBy ? displayName(task.createdBy) : 'Unknown';
  const history = Array.isArray(task.history) ? task.history.slice(-3).reverse() : [];
  const thread = taskThreadMessage(task);
  const canClaim = !taskIsClosedStatus(task.status) && !task.claimedBy;
  const canUnclaim = !taskIsClosedStatus(task.status) && Boolean(task.claimedBy);
  const canReview = task.status === 'in_progress' && Boolean(task.claimedBy);
  const canApprove = task.status === 'in_review';
  const canRun = !taskIsClosedStatus(task.status) && (!task.claimedBy || task.claimedBy === 'agt_codex');
  return `
    <article class="task-card">
      <div class="task-card-head">
        <strong><span class="task-number">#${escapeHtml(task.number || shortId(task.id))}</span> ${escapeHtml(plainMentionText(task.title || 'Untitled task'))}</strong>
        ${pill(task.status, taskTone(task.status))}
      </div>
      <div class="message-markdown">${renderMarkdownWithMentions(task.body || '')}</div>
      <small>${escapeHtml(spaceName(task.spaceType, task.spaceId))} #${escapeHtml(task.number || shortId(task.id))} / creator @${escapeHtml(creator)} / assignee @${escapeHtml(assignee)} / claim ${escapeHtml(claimed)}</small>
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
        ${taskIsClosedStatus(task.status) ? `<button type="button" data-action="task-reopen" data-id="${task.id}">Reopen</button>` : ''}
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
  const threaded = (appState.messages || [])
    .filter((message) => message.replyCount > 0 || message.taskId)
    .sort((a, b) => threadUpdatedAt(b) - threadUpdatedAt(a));
  return `
    ${renderHeader('Threads', 'Active reply trails', '')}
    <section class="list-panel pixel-panel thread-list-panel">
      ${threaded.length ? threaded.map((message) => {
        const replies = threadReplies(message.id);
        const lastReply = replies.at(-1);
        const author = displayName(message.authorId);
        const lastReplyAuthor = lastReply ? displayName(lastReply.authorId) : author;
        const task = message.taskId ? byId(appState.tasks, message.taskId) : null;
        return `
        <button class="thread-row" type="button" data-action="open-thread" data-id="${message.id}">
          <span class="thread-row-main">
            <strong>${escapeHtml(plainMentionText(message.body).slice(0, 120) || '(attachment)')}</strong>
            <small>${escapeHtml(spaceName(message.spaceType, message.spaceId))} · ${escapeHtml(author)} · latest ${escapeHtml(lastReplyAuthor)} · ${fmtTime(lastReply?.createdAt || message.updatedAt || message.createdAt)}</small>
          </span>
          <span class="thread-row-meta">
            ${task ? `<span class="task-number">#${escapeHtml(task.number || shortId(task.id))}</span>` : ''}
            <span>${message.replyCount || 0} ${(message.replyCount || 0) === 1 ? 'reply' : 'replies'}</span>
          </span>
        </button>
      `;
      }).join('') : '<div class="empty-box">No active threads.</div>'}
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
          <label><span>Control Plane URL</span><input name="controlPlaneUrl" value="${escapeHtml(c.controlPlaneUrl || '')}" placeholder="https://app.magclaw.ai or http://127.0.0.1:6543" /></label>
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

  if (selectedProjectFile) return renderProjectFilePreview();

  if (selectedAgentId) {
    const agent = byId(appState.agents, selectedAgentId);
    if (agent) return renderAgentDetail(agent);
  }

  return '';
}

function renderProjectFilePreview() {
  const key = projectPreviewKey(selectedProjectFile.projectId, selectedProjectFile.path);
  const preview = projectFilePreviews[key] || { loading: true };
  const file = preview.file;
  return `
    <section class="pixel-panel inspector-panel file-preview-panel">
      <div class="panel-title file-preview-title">
        <span>File Preview</span>
        <button type="button" data-action="close-project-preview">×</button>
      </div>
      ${preview.loading ? '<div class="empty-box small">Loading file...</div>' : ''}
      ${preview.error ? `<div class="empty-box small error">${escapeHtml(preview.error)}</div>` : ''}
      ${file ? `
        <div class="file-preview-meta">
          <strong title="${escapeHtml(file.path)}">${escapeHtml(file.name)}</strong>
          <small>${escapeHtml(file.projectName)} / ${escapeHtml(file.path)} / ${bytes(file.bytes)}</small>
        </div>
        ${file.previewKind === 'markdown'
          ? `<div class="markdown-preview">${renderMarkdown(file.content || '')}</div>`
          : file.previewKind === 'text'
            ? `<pre class="text-file-preview"><code>${escapeHtml(file.content || '')}</code></pre>`
            : '<div class="empty-box small">This file type cannot be previewed as text yet.</div>'}
      ` : ''}
    </section>
  `;
}

function renderAgentWorkspaceTree(agent, relPath = '', depth = 0) {
  const key = agentWorkspaceKey(agent.id, relPath);
  const tree = agentWorkspaceTreeCache[key];
  if (!tree || tree.loading) return '<div class="project-tree-note">Loading workspace...</div>';
  if (tree.error) return `<div class="project-tree-note error">${escapeHtml(tree.error)}</div>`;
  if (!tree.entries?.length) return '<div class="project-tree-note">Empty folder.</div>';
  return `
    <div class="project-tree-list agent-workspace-tree">
      ${tree.entries.map((entry) => {
        const isFolder = entry.kind === 'folder';
        const expanded = isFolder && agentWorkspaceIsExpanded(agent.id, entry.path);
        const active = selectedAgentWorkspaceFile?.agentId === agent.id && selectedAgentWorkspaceFile?.path === entry.path;
        return `
          <div class="project-tree-node">
            <button
              type="button"
              class="project-tree-row ${isFolder ? 'is-folder' : 'is-file'} ${active ? 'active' : ''}"
              style="--depth: ${depth}"
              data-action="${isFolder ? 'toggle-agent-workspace' : 'open-agent-workspace-file'}"
              data-agent-id="${escapeHtml(agent.id)}"
              data-path="${escapeHtml(entry.path)}"
              title="${escapeHtml(entry.path)}"
            >
              <span class="project-tree-caret">${isFolder ? (expanded ? '▾' : '▸') : '·'}</span>
              <span class="project-tree-icon">${isFolder ? 'DIR' : 'FILE'}</span>
              <span class="project-tree-name">${escapeHtml(entry.name)}</span>
              ${!isFolder ? `<small>${bytes(entry.bytes || 0)}</small>` : ''}
            </button>
            ${isFolder && expanded ? renderAgentWorkspaceTree(agent, entry.path, depth + 1) : ''}
          </div>
        `;
      }).join('')}
    </div>
  `;
}

function renderAgentWorkspacePreview(agent) {
  if (!selectedAgentWorkspaceFile || selectedAgentWorkspaceFile.agentId !== agent.id) return '';
  const key = agentWorkspaceKey(agent.id, selectedAgentWorkspaceFile.path);
  const preview = agentWorkspaceFilePreviews[key] || { loading: true };
  const file = preview.file;
  return `
    <div class="agent-workspace-preview">
      <div class="file-preview-title inline-title">
        <span>${file ? escapeHtml(file.path) : 'File Preview'}</span>
        <button type="button" data-action="close-agent-workspace-file">×</button>
      </div>
      ${preview.loading ? '<div class="empty-box small">Loading file...</div>' : ''}
      ${preview.error ? `<div class="empty-box small error">${escapeHtml(preview.error)}</div>` : ''}
      ${file ? `
        <div class="file-preview-meta">
          <strong title="${escapeHtml(file.absolutePath)}">${escapeHtml(file.name)}</strong>
          <small>${escapeHtml(file.absolutePath)} / ${bytes(file.bytes)}</small>
        </div>
        ${file.previewKind === 'markdown'
          ? `<div class="markdown-preview">${renderMarkdown(file.content || '')}</div>`
          : file.previewKind === 'text'
            ? `<pre class="text-file-preview"><code>${escapeHtml(file.content || '')}</code></pre>`
            : '<div class="empty-box small">This file type cannot be previewed as text yet.</div>'}
      ` : ''}
    </div>
  `;
}

function renderAgentWorkspaceSection(agent) {
  const rootKey = agentWorkspaceKey(agent.id, '');
  const expanded = agentWorkspaceIsExpanded(agent.id, '');
  const tree = agentWorkspaceTreeCache[rootKey];
  return `
    <div class="agent-detail-section agent-workspace-section">
      <div class="detail-label">Workspace</div>
      <div class="agent-workspace-head">
        <code>${escapeHtml(agent.workspacePath || '--')}</code>
        <button type="button" data-action="toggle-agent-workspace" data-agent-id="${escapeHtml(agent.id)}" data-path="">${expanded ? 'Hide' : 'Open'}</button>
      </div>
      ${expanded ? `
        <div class="agent-workspace-browser">
          ${tree ? renderAgentWorkspaceTree(agent, '', 0) : '<div class="project-tree-note">Loading workspace...</div>'}
          ${renderAgentWorkspacePreview(agent)}
        </div>
      ` : ''}
    </div>
  `;
}

function runtimeForAgent(agent) {
  const runtime = String(agent?.runtime || '').toLowerCase();
  return installedRuntimes.find((rt) => (
    String(rt.id || '').toLowerCase() === runtime
    || String(rt.name || '').toLowerCase() === runtime
    || String(rt.name || '').toLowerCase().includes(runtime)
  )) || installedRuntimes.find((rt) => rt.installed) || null;
}

function agentModelOptions(agent) {
  const runtime = runtimeForAgent(agent);
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

function agentReasoningOptions(agent) {
  const runtime = runtimeForAgent(agent);
  const efforts = runtime?.reasoningEffort || [];
  const current = agent?.reasoningEffort || runtime?.defaultReasoningEffort || '';
  const options = current && !efforts.includes(current) ? [current, ...efforts] : efforts;
  return options.map((effort) => `<option value="${escapeHtml(effort)}" ${effort === current ? 'selected' : ''}>${escapeHtml(effort.charAt(0).toUpperCase() + effort.slice(1))}</option>`).join('');
}

function agentIsRunning(agent) {
  return ['starting', 'thinking', 'working', 'running', 'busy', 'queued'].includes(String(agent?.status || '').toLowerCase());
}

function renderAgentDetail(agent) {
  const computer = byId(appState.computers, agent.computerId);
  const envVars = agent.envVars || [];
  const reasoningOptions = agentReasoningOptions(agent);
  const running = agentIsRunning(agent);

  return `
    <section class="pixel-panel inspector-panel agent-detail">
      <div class="panel-title">
        <span>${escapeHtml(agent.name)}</span>
        <button type="button" data-action="close-agent-detail">×</button>
      </div>

      <div class="agent-profile-header">
        ${getAvatarHtml(agent.id, 'agent', 'avatar')}
        <div class="agent-profile-info">
          <strong>${escapeHtml(agent.name)}</strong>
          <span class="agent-status ${presenceClass(agent.status)}">${escapeHtml(agent.status)}</span>
        </div>
        <div class="agent-header-actions">
          <button class="secondary-btn" type="button" data-action="open-dm-with-agent" data-id="${escapeHtml(agent.id)}">Message</button>
          <button class="secondary-btn disabled-action" type="button" data-action="agent-stop-unavailable" data-id="${escapeHtml(agent.id)}" aria-disabled="true">Stop Agent</button>
          ${running
            ? `<button class="secondary-btn" type="button" data-action="open-agent-restart" data-id="${escapeHtml(agent.id)}">Restart</button>`
            : `<button class="secondary-btn" type="button" data-action="start-agent" data-id="${escapeHtml(agent.id)}">Start</button>`}
        </div>
      </div>

      <form id="agent-detail-form" class="agent-profile-form" data-id="${escapeHtml(agent.id)}">
        <div class="agent-detail-section agent-avatar-edit">
          <div class="detail-label">Avatar</div>
          <div class="agent-avatar-edit-row">
            <img class="avatar-preview agent-detail-avatar-preview" src="${escapeHtml(agent.avatar || getRandomAvatar())}" alt="${escapeHtml(agent.name)} avatar" />
            <input type="hidden" name="avatar" value="${escapeHtml(agent.avatar || '')}" />
            <button class="secondary-btn" type="button" data-action="randomize-agent-detail-avatar">Random</button>
            <label class="secondary-btn file-btn">
              Upload
              <input class="visually-hidden agent-avatar-upload" type="file" accept="image/*" data-action="upload-agent-avatar" data-id="${escapeHtml(agent.id)}" />
            </label>
          </div>
        </div>

        <label class="agent-detail-section">
          <span class="detail-label">Display Name</span>
          <input name="name" value="${escapeHtml(agent.name)}" required />
        </label>

        <label class="agent-detail-section">
          <span class="detail-label">Description</span>
          <textarea name="description" rows="3">${escapeHtml(agent.description || '')}</textarea>
        </label>

        <div class="agent-detail-grid">
          <div class="agent-detail-section">
            <div class="detail-label">Runtime</div>
            <div class="detail-value runtime-badge">${escapeHtml(agent.runtime || '--')}</div>
          </div>
          <label class="agent-detail-section">
            <span class="detail-label">Model</span>
            <select name="model">${agentModelOptions(agent)}</select>
          </label>
          ${reasoningOptions ? `
          <label class="agent-detail-section">
            <span class="detail-label">Thinking</span>
            <select name="reasoningEffort">${agentReasoningOptions(agent)}</select>
          </label>
          ` : ''}
        </div>

        <div class="agent-detail-actions form-actions">
          <button class="primary-btn" type="submit">Save Profile</button>
        </div>
      </form>

      <div class="agent-detail-section">
        <div class="detail-label">Runtime Session</div>
        <div class="detail-value"><code>${escapeHtml(agent.runtimeSessionId || '--')}</code></div>
      </div>

      <div class="agent-detail-section">
        <div class="detail-label">Computer</div>
        <div class="detail-value">${escapeHtml(computer?.name || agent.computerId || '--')}</div>
      </div>

      <div class="agent-detail-section">
        <div class="detail-label">Runtime Workspace</div>
        <div class="detail-value">${escapeHtml(agent.workspace || '--')}</div>
      </div>

      ${renderAgentWorkspaceSection(agent)}

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
        <button class="danger-btn" type="button" data-action="delete-agent" data-id="${escapeHtml(agent.id)}">Delete</button>
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
  return `
    <button class="space-btn member-btn${active}" type="button" data-action="select-agent" data-id="${escapeHtml(agent.id)}">
      ${getAvatarHtml(agent.id, 'agent', 'dm-avatar')}
      <div class="member-info">
        <span class="dm-name">${escapeHtml(agent.name)}</span>
        ${desc}
      </div>
      <span class="dm-status ${presenceClass(agent.status)}"></span>
      ${renderAgentHoverCard(agent)}
    </button>
  `;
}

function renderHumanListItem(human) {
  return `
    <div class="space-btn member-btn">
      <span class="dm-avatar">${escapeHtml(displayAvatar(human.id, 'human'))}</span>
      <span class="dm-name">${escapeHtml(human.name)}</span>
      <span class="dm-status ${presenceClass(human.status)}"></span>
    </div>
  `;
}

function renderComputerListItem(computer) {
  return `
    <div class="space-btn member-btn">
      <span class="dm-avatar">💻</span>
      <span class="dm-name">${escapeHtml(computer.name)}</span>
      <span class="dm-status ${presenceClass(computer.status)}"></span>
    </div>
  `;
}

function renderReply(reply) {
  const authorClass = ['agent', 'human', 'system'].includes(reply.authorType) ? reply.authorType : 'unknown';
  const agentAuthorAttr = reply.authorType === 'agent' ? ` data-agent-author-id="${escapeHtml(reply.authorId)}"` : '';
  return `
    <article class="message-card slock-message reply-card author-${authorClass}"${agentAuthorAttr}>
      ${renderActorAvatar(reply.authorId, reply.authorType)}
      <div class="message-body">
        <div class="message-meta">
          ${renderActorName(reply.authorId, reply.authorType)}${agentStatusDot(reply.authorId, reply.authorType)}
          <span class="sender-role">${escapeHtml(actorSubtitle(reply.authorId, reply.authorType, reply))}</span>
          <time>${fmtTime(reply.createdAt)}</time>
        </div>
        <div class="message-markdown">${renderMarkdownWithMentions(reply.body || '(attachment)')}</div>
        <div class="message-attachments">${attachmentLinks(reply.attachmentIds)}</div>
      </div>
    </article>
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
        <button class="back-bottom thread-back-bottom${backBottomVisible.thread ? '' : ' hidden'}" type="button" data-action="back-to-bottom" data-target="thread">Back to Bottom</button>
      </div>
      <div class="thread-tools">
        <span>${replies.length} ${replyWord}</span>
        ${task ? `<span class="task-number">#${escapeHtml(task.number || shortId(task.id))} ${escapeHtml(task.status)}</span>` : ''}
      </div>
      ${renderComposer({ id: composerId, kind: 'thread', placeholder: 'Message thread' })}
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
        ${!task.claimedBy && !taskIsClosedStatus(task.status) ? `<button type="button" data-action="task-claim" data-id="${task.id}">Claim Codex</button>` : ''}
        ${task.claimedBy && !taskIsClosedStatus(task.status) ? `<button type="button" data-action="task-unclaim" data-id="${task.id}">Unclaim</button>` : ''}
        ${task.status === 'in_progress' ? `<button type="button" data-action="task-review" data-id="${task.id}">Request Review</button>` : ''}
        ${task.status === 'in_review' ? `<button type="button" data-action="task-approve" data-id="${task.id}">Approve Done</button>` : ''}
        ${taskIsClosedStatus(task.status) ? `<button type="button" data-action="task-reopen" data-id="${task.id}">Reopen</button>` : ''}
      </div>
      <div class="history-list">
        ${history.length ? history.map((item) => `
          <div class="history-item">
            <strong>${escapeHtml(item.type)}</strong>
            <small>${fmtTime(item.createdAt)} / ${escapeHtml(displayName(item.actorId))}</small>
            <p>${escapeHtml(plainActorText(item.message))}</p>
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
    'confirm-stop-all': renderStopAllConfirmModal,
    project: renderProjectModal,
    dm: renderDmModal,
    task: renderTaskModal,
    agent: renderAgentModal,
    'avatar-picker': renderAvatarPickerModal,
    'agent-restart': renderAgentRestartModal,
    computer: renderComputerModal,
    human: renderHumanModal,
  };
  const content = map[modal]?.() || '';
  const isAvatarPicker = modal === 'avatar-picker';
  const modalClass = `modal-${String(modal || '').replace(/[^a-z0-9-]/gi, '-')}`;
  return `
    <div class="modal-backdrop ${modalClass}-backdrop" data-action="close-modal">
      <div class="modal-card pixel-panel ${modalClass} ${isAvatarPicker ? 'modal-wide' : ''}" data-action="none">
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
  const availableAgents = (appState.agents || []).filter((a) => !memberIds.includes(a.id) && matches(a));
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
      <label><span>Assignees</span><select name="assigneeIds" multiple size="4">${(appState.agents || []).map((agent) => `<option value="${agent.id}">${escapeHtml(agent.name)}</option>`).join('')}</select></label>
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
    const src = `/avatars/avatar_${String(i).padStart(4, '0')}.svg`;
    const selected = agentFormState.avatar === src ? 'selected' : '';
    html += `<img src="${src}" class="avatar-option ${selected}" data-avatar="${src}" />`;
  }
  html += `</div>
    <div class="modal-actions">
      <button type="button" class="secondary-btn" data-action="back-to-agent-modal">Back</button>
      <button type="button" class="primary-btn" data-action="confirm-avatar">Select</button>
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

async function refreshState() {
  rememberPinnedBottomBeforeStateChange();
  appState = await api('/api/state');
  render();
}

function connectEvents() {
  const source = new EventSource('/api/events');
  source.addEventListener('state', (event) => {
    rememberPinnedBottomBeforeStateChange();
    appState = JSON.parse(event.data);
    // When modal is open, don't re-render to avoid interrupting form input
    if (!modal) {
      render();
    }
  });
  source.addEventListener('run-event', (event) => {
    const incoming = JSON.parse(event.data);
    if (!appState.events.some((item) => item.id === incoming.id)) {
      rememberPinnedBottomBeforeStateChange();
      appState.events.push(incoming);
      // When modal is open, don't re-render
      if (!modal) {
        render();
      }
    }
  });
}

document.addEventListener('scroll', (event) => {
  if (event.target?.id === 'message-list') updateBackBottomVisibility('main');
  if (event.target?.id === 'thread-context') updateBackBottomVisibility('thread');
}, true);

document.addEventListener('keydown', async (event) => {
  const railResizer = event.target.closest?.('.rail-resizer');
  if (railResizer && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault();
    const delta = event.key === 'ArrowRight' ? 24 : -24;
    setRailWidth(railWidth + delta, { persist: true, frame: railResizer.closest('.app-frame') });
    return;
  }

  const inspectorResizer = event.target.closest?.('.inspector-resizer');
  if (inspectorResizer && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
    event.preventDefault();
    const delta = event.key === 'ArrowLeft' ? 24 : -24;
    setInspectorWidth(inspectorWidth + delta, { persist: true, frame: inspectorResizer.closest('.app-frame') });
    return;
  }

  const textarea = event.target.closest('textarea[data-mention-input]');

  // Handle mention popup keyboard navigation
  if (textarea && mentionPopup.active && mentionPopup.composerId === textarea.dataset.composerId) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      mentionPopup.selectedIndex = Math.min(mentionPopup.selectedIndex + 1, mentionPopup.items.length - 1);
      updateMentionPopupSelection();
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      mentionPopup.selectedIndex = Math.max(mentionPopup.selectedIndex - 1, 0);
      updateMentionPopupSelection();
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      const item = mentionPopup.items[mentionPopup.selectedIndex];
      if (item) {
        await insertMention(textarea, item);
        const existingPopup = document.getElementById('mention-popup');
        if (existingPopup) existingPopup.remove();
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      mentionPopup.active = false;
      mentionPopup.items = [];
      const existingPopup = document.getElementById('mention-popup');
      if (existingPopup) existingPopup.remove();
      return;
    }
  }

  // Regular Enter to submit message (only when popup not active)
  if (textarea && event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    const form = textarea.closest('form');
    if (form) form.requestSubmit();
  }
});

document.addEventListener('pointerdown', (event) => {
  const resizer = event.target.closest('.rail-resizer, .inspector-resizer');
  if (!resizer) return;

  event.preventDefault();
  const frame = resizer.closest('.app-frame');
  const isRail = resizer.classList.contains('rail-resizer');
  document.body.classList.add(isRail ? 'is-resizing-rail' : 'is-resizing-inspector');
  resizer.setPointerCapture?.(event.pointerId);

  const updateWidth = (clientX) => {
    const rect = frame?.getBoundingClientRect();
    if (isRail) {
      setRailWidth(clientX - (rect?.left || 0), { frame });
      return;
    }
    const frameRight = rect?.right || window.innerWidth;
    setInspectorWidth(frameRight - clientX, { frame });
  };
  const onPointerMove = (moveEvent) => updateWidth(moveEvent.clientX);
  const finish = () => {
    document.removeEventListener('pointermove', onPointerMove);
    document.removeEventListener('pointerup', finish);
    document.removeEventListener('pointercancel', finish);
    document.body.classList.remove(isRail ? 'is-resizing-rail' : 'is-resizing-inspector');
    localStorage.setItem(isRail ? RAIL_WIDTH_KEY : INSPECTOR_WIDTH_KEY, String(isRail ? railWidth : inspectorWidth));
  };

  updateWidth(event.clientX);
  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', finish);
  document.addEventListener('pointercancel', finish);
});

// Update mention popup selection highlight without full re-render
function updateMentionPopupSelection() {
  const popup = document.getElementById('mention-popup');
  if (!popup) return;
  popup.querySelectorAll('.mention-item').forEach((el, idx) => {
    el.classList.toggle('selected', idx === mentionPopup.selectedIndex);
  });
}

document.addEventListener('input', async (event) => {
  // Handle @ mention autocomplete in message textarea
  const messageTextarea = event.target.closest('textarea[data-mention-input]');
  if (messageTextarea) {
    const { selectionStart, value } = messageTextarea;
    if (messageTextarea.dataset.composerId) composerDrafts[messageTextarea.dataset.composerId] = value;
    const atMatch = findMentionTrigger(value, selectionStart);
    if (atMatch) {
      const lookupSeq = ++mentionLookupSeq;
      const { query, triggerPosition } = atMatch;
      const form = messageTextarea.closest('form');
      const isThread = form?.id === 'reply-form';
      const threadRoot = isThread ? byId(appState.messages, threadMessageId) : null;
      const spaceType = threadRoot?.spaceType || selectedSpaceType;
      const spaceId = threadRoot?.spaceId || selectedSpaceId;
      const peopleItems = getMentionCandidates(query, spaceType, spaceId);
      let projectItems = [];
      try {
        projectItems = await getProjectMentionCandidates(query, spaceType, spaceId);
      } catch (error) {
        console.warn('Project mention search failed', error);
      }
      if (lookupSeq !== mentionLookupSeq) return;
      const items = [...peopleItems, ...projectItems];
      mentionPopup = {
        active: items.length > 0,
        query,
        items,
        selectedIndex: 0,
        triggerPosition,
        composerId: messageTextarea.dataset.composerId,
      };
      // Re-render just the popup without full render to keep focus
      const popupContainer = messageTextarea.closest('.composer-input-wrapper');
      if (popupContainer) {
        const existingPopup = document.getElementById('mention-popup');
        if (existingPopup) existingPopup.remove();
        if (mentionPopup.active) {
          popupContainer.insertAdjacentHTML('beforeend', renderMentionPopup());
        }
      }
    } else if (mentionPopup.active) {
      mentionLookupSeq += 1;
      mentionPopup.active = false;
      mentionPopup.items = [];
      mentionPopup.composerId = null;
      const existingPopup = document.getElementById('mention-popup');
      if (existingPopup) existingPopup.remove();
    }
    return;
  }

  if (event.target.id === 'search-input') {
    searchQuery = event.target.value;
    render();
    const input = document.querySelector('#search-input');
    input?.focus();
    input?.setSelectionRange(searchQuery.length, searchQuery.length);
    return;
  }

  if (event.target.id === 'add-member-search') {
    addMemberSearchQuery = event.target.value;
    render();
    const input = document.querySelector('#add-member-search');
    input?.focus();
    input?.setSelectionRange(addMemberSearchQuery.length, addMemberSearchQuery.length);
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
  if (event.target.matches?.('.agent-avatar-upload')) {
    await uploadAgentAvatar(event.target).catch((error) => toast(error.message));
    return;
  }

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
  if (event.target.name === 'asTask') {
    const composerId = event.target.closest('form')?.dataset.composerId;
    if (composerId) composerTaskFlags[composerId] = event.target.checked;
  }
  const attachmentInput = event.target.closest('.composer-attachment-input');
  if (!attachmentInput) return;
  if (!attachmentInput.files?.length) return;
  try {
    await uploadFiles(attachmentInput.files, attachmentInput.dataset.composerId, 'upload');
    attachmentInput.value = '';
  } catch (error) {
    toast(error.message);
  }
});

document.addEventListener('paste', async (event) => {
  const textarea = event.target.closest?.('textarea[data-mention-input]');
  if (!textarea) return;
  const files = [...(event.clipboardData?.files || [])]
    .filter((file) => String(file.type || '').startsWith('image/'))
    .map(normalizeClipboardFile);
  if (!files.length) return;
  event.preventDefault();
  try {
    await uploadFiles(files, textarea.dataset.composerId, 'clipboard');
  } catch (error) {
    toast(error.message);
  }
});

document.addEventListener('click', async (event) => {
  // Handle mention item clicks
  const mentionItem = event.target.closest('.mention-item');
  if (mentionItem) {
    const idx = parseInt(mentionItem.dataset.mentionIdx, 10);
    if (!Number.isNaN(idx) && mentionPopup.items[idx]) {
      const textarea = document.querySelector(`textarea[data-composer-id="${CSS.escape(mentionPopup.composerId || '')}"]`);
      if (textarea) {
        await insertMention(textarea, mentionPopup.items[idx]);
        const existingPopup = document.getElementById('mention-popup');
        if (existingPopup) existingPopup.remove();
        textarea.focus();
      }
    }
    return;
  }

  // Handle avatar option clicks separately (no data-action attribute)
  const avatarOption = event.target.closest('.avatar-option');
  if (avatarOption) {
    const avatarSrc = avatarOption.dataset.avatar;
    if (avatarSrc) {
      agentFormState.avatar = avatarSrc;
      document.querySelectorAll('.avatar-option').forEach((el) => el.classList.remove('selected'));
      avatarOption.classList.add('selected');
    }
    return;
  }

  const target = event.target.closest('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'none') return;
  const localOnlyActions = new Set([
    'set-view',
    'set-rail-tab',
    'select-agent',
    'close-agent-detail',
    'select-space',
    'set-tab',
    'task-filter',
    'toggle-task-column',
    'open-modal',
    'close-modal',
    'open-thread',
    'close-thread',
    'view-in-channel',
    'back-to-bottom',
    'remove-staged-attachment',
    'toggle-project-tree',
    'open-project-file',
    'close-project-preview',
    'toggle-agent-workspace',
    'open-agent-workspace-file',
    'close-agent-workspace-file',
    'agent-stop-unavailable',
    'open-agent-restart',
    'select-agent-restart-mode',
    'randomize-agent-detail-avatar',
    'upload-agent-avatar',
  ]);

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
  if (action === 'back-to-agent-modal' || action === 'confirm-avatar') {
    modal = 'agent';
    render();
    return;
  }
  if (action === 'randomize-agent-detail-avatar') {
    const avatar = getRandomAvatar();
    const form = target.closest('#agent-detail-form');
    const preview = form?.querySelector('.agent-detail-avatar-preview');
    const input = form?.querySelector('input[name="avatar"]');
    if (preview) preview.src = avatar;
    if (input) input.value = avatar;
    return;
  }
  try {
    if (action === 'set-view') {
      activeView = target.dataset.view;
      threadMessageId = null;
      selectedProjectFile = null;
      selectedAgentId = null;
      render();
    }
    if (action === 'set-rail-tab') {
      railTab = target.dataset.railTab;
      localStorage.setItem('railTab', railTab);
      if (railTab === 'spaces') {
        selectedAgentId = null;
      }
      render();
    }
    if (action === 'select-agent') {
      if (!installedRuntimes.length) await loadInstalledRuntimes();
      selectedAgentId = target.dataset.id;
      threadMessageId = null;
      selectedProjectFile = null;
      selectedAgentWorkspaceFile = null;
      modal = null;
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
      clearAgentWorkspaceCaches(target.dataset.id);
      await api(`/api/agents/${target.dataset.id}`, { method: 'DELETE' });
      selectedAgentId = null;
      toast('Agent deleted');
    }
    if (action === 'select-space') {
      selectedAgentId = null;
      selectedSpaceType = target.dataset.type;
      selectedSpaceId = target.dataset.id;
      activeView = 'space';
      activeTab = 'chat';
      threadMessageId = null;
      selectedProjectFile = null;
      selectedAgentWorkspaceFile = null;
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
    if (action === 'toggle-task-column') {
      toggleTaskColumn(target.dataset.status);
      render();
    }
    if (action === 'open-modal') {
      modal = target.dataset.modal;
      if (modal === 'add-channel-member' || modal === 'channel-members') {
        addMemberSearchQuery = '';
      }
      if (modal === 'agent') {
        await loadInstalledRuntimes();
      }
      render();
    }
    if (action === 'agent-stop-unavailable') {
      toast('暂时不可用');
    }
    if (action === 'open-agent-restart') {
      agentRestartState = { agentId: target.dataset.id, mode: 'restart' };
      modal = 'agent-restart';
      render();
    }
    if (action === 'select-agent-restart-mode') {
      agentRestartState = {
        ...agentRestartState,
        mode: target.dataset.mode || 'restart',
      };
      render();
    }
    if (action === 'start-agent') {
      await api(`/api/agents/${target.dataset.id}/start`, { method: 'POST', body: '{}' });
      toast('Agent starting');
    }
    if (action === 'confirm-agent-restart') {
      if (!agentRestartState.agentId) return;
      await api(`/api/agents/${agentRestartState.agentId}/restart`, {
        method: 'POST',
        body: JSON.stringify({ mode: agentRestartState.mode || 'restart' }),
      });
      modal = null;
      toast('Agent restart requested');
    }
    if (action === 'close-modal') {
      const isBackdrop = event.target.classList.contains('modal-backdrop');
      const isCloseBtn = event.target.closest('.modal-head button[data-action="close-modal"]');
      const isCancelBtn = event.target.closest('.modal-actions .secondary-btn[data-action="close-modal"]');
      if (isBackdrop || isCloseBtn || isCancelBtn) {
        if (modal === 'agent') {
          resetAgentFormState();
        }
        if (modal === 'add-channel-member' || modal === 'channel-members') {
          addMemberSearchQuery = '';
        }
        if (modal === 'agent-restart') {
          agentRestartState = { agentId: null, mode: 'restart' };
        }
        modal = null;
        render();
      }
    }
    if (action === 'open-thread') {
      threadMessageId = target.dataset.id;
      selectedAgentId = null;
      selectedProjectFile = null;
      render();
      scrollToMessage(threadMessageId);
    }
    if (action === 'close-thread') {
      threadMessageId = null;
      render();
    }
    if (action === 'view-in-channel') {
      const message = byId(appState.messages, target.dataset.id);
      if (message) {
        selectedSpaceType = message.spaceType;
        selectedSpaceId = message.spaceId;
        activeView = 'space';
        activeTab = 'chat';
        threadMessageId = message.id;
        render();
        scrollToMessage(message.id);
      }
    }
    if (action === 'back-to-bottom') {
      const targetPane = target.dataset.target === 'thread' ? '#thread-context' : '#message-list';
      scrollPaneToBottom(targetPane);
    }
    if (action === 'remove-staged-attachment') {
      removeStagedAttachment(target.dataset.composerId, target.dataset.id);
    }
    if (action === 'pick-project-folder') {
      const result = await api('/api/projects/pick-folder', {
        method: 'POST',
        body: JSON.stringify({
          spaceType: selectedSpaceType,
          spaceId: selectedSpaceId,
          defaultPath: appState.settings?.defaultWorkspace || '',
        }),
      });
      if (result.canceled) {
        toast('Folder picker canceled');
        return;
      }
      modal = null;
      toast('Project folder added');
    }
    if (action === 'toggle-project-tree') {
      await toggleProjectTree(target.dataset.projectId, target.dataset.path || '');
    }
    if (action === 'open-project-file') {
      await openProjectFile(target.dataset.projectId, target.dataset.path || '');
    }
    if (action === 'close-project-preview') {
      selectedProjectFile = null;
      render();
    }
    if (action === 'toggle-agent-workspace') {
      await toggleAgentWorkspace(target.dataset.agentId, target.dataset.path || '');
    }
    if (action === 'open-agent-workspace-file') {
      await openAgentWorkspaceFile(target.dataset.agentId, target.dataset.path || '');
    }
    if (action === 'close-agent-workspace-file') {
      selectedAgentWorkspaceFile = null;
      render();
    }
    if (action === 'remove-project') {
      clearProjectCaches(target.dataset.id);
      await api(`/api/projects/${target.dataset.id}`, { method: 'DELETE' });
      toast('Project folder removed');
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
    if (action === 'add-channel-member') {
      const memberId = target.dataset.memberId;
      if (memberId) {
        await api(`/api/channels/${selectedSpaceId}/members`, {
          method: 'POST',
          body: JSON.stringify({ memberId }),
        });
        modal = 'add-channel-member';
        toast('Member added');
      }
    }
  } catch (error) {
    toast(error.message);
  } finally {
    if (!localOnlyActions.has(action)) {
      await refreshState().catch(() => {});
    }
    if (action === 'open-thread') scrollToMessage(threadMessageId);
    if (action === 'view-in-channel') scrollToMessage(target.dataset.id);
    if (action === 'back-to-bottom') {
      const targetPane = target.dataset.target === 'thread' ? '#thread-context' : '#message-list';
      scrollPaneToBottom(targetPane);
    }
    if (action === 'add-channel-member') {
      const input = document.querySelector('#add-member-search');
      input?.focus();
      input?.setSelectionRange(addMemberSearchQuery.length, addMemberSearchQuery.length);
    }
  }
});

document.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  let submittedBottomTarget = null;

  try {
    if (form.id === 'message-form') {
      const composerId = form.dataset.composerId || composerIdFor('message');
      const rawBody = composerDrafts[composerId] ?? data.get('body');
      const shouldOpenTaskThread = Boolean(composerTaskFlags[composerId] ?? data.get('asTask'));
      const result = await api(`/api/spaces/${selectedSpaceType}/${selectedSpaceId}/messages`, {
        method: 'POST',
        body: JSON.stringify({
          body: encodeComposerMentions(rawBody, composerId),
          asTask: shouldOpenTaskThread,
          attachmentIds: stagedFor(composerId).ids,
        }),
      });
      if (shouldOpenTaskThread && result.message?.id) threadMessageId = result.message.id;
      clearStagedFor(composerId);
      delete composerDrafts[composerId];
      delete composerTaskFlags[composerId];
      delete composerMentionMaps[composerId];
      requestPaneBottomScroll('main');
      submittedBottomTarget = '#message-list';
      form.reset();
      toast('Message sent');
    }
    if (form.id === 'reply-form') {
      const composerId = form.dataset.composerId || composerIdFor('thread', threadMessageId);
      const rawBody = composerDrafts[composerId] ?? data.get('body');
      await api(`/api/messages/${threadMessageId}/replies`, {
        method: 'POST',
        body: JSON.stringify({ body: encodeComposerMentions(rawBody, composerId), attachmentIds: stagedFor(composerId).ids }),
      });
      clearStagedFor(composerId);
      delete composerDrafts[composerId];
      delete composerMentionMaps[composerId];
      requestPaneBottomScroll('thread');
      submittedBottomTarget = '#thread-context';
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
    if (form.id === 'project-form') {
      await api('/api/projects', {
        method: 'POST',
        body: JSON.stringify({
          path: data.get('path'),
          name: data.get('name'),
          spaceType: selectedSpaceType,
          spaceId: selectedSpaceId,
        }),
      });
      modal = null;
      toast('Project folder added');
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
          assigneeIds: [...form.querySelectorAll('select[name="assigneeIds"] option:checked')].map((option) => option.value),
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
    if (form.id === 'agent-detail-form') {
      const agentId = form.dataset.id;
      await api(`/api/agents/${agentId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: data.get('name'),
          description: data.get('description'),
          model: data.get('model'),
          reasoningEffort: data.get('reasoningEffort') || null,
          avatar: data.get('avatar') || null,
        }),
      });
      toast('Agent updated');
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
    if (submittedBottomTarget) scrollPaneToBottom(submittedBottomTarget, 'auto');
  }
});

render();
refreshState().then(connectEvents).catch((error) => {
  root.innerHTML = `<div class="boot">MAGCLAW LOCAL / ${escapeHtml(error.message)}</div>`;
});
