import {
  buildFanoutDecisionCards,
  renderFanoutDecisionToasts as renderFanoutDecisionToastsHtml,
} from './fanout-toast.js';

const root = document.querySelector('#root');
const UI_STATE_KEY = 'magclawUiState';
const PANE_SCROLL_KEY = 'magclawPaneScroll';
const TASK_COLUMN_COLLAPSE_KEY = 'magclawTaskColumnCollapse';
const SIDEBAR_SECTION_COLLAPSE_KEY = 'magclawSidebarSectionCollapse';
const SKILL_SECTION_COLLAPSE_KEY = 'magclawSkillSectionCollapse';
const NOTIFICATION_PREF_KEY = 'magclawNotificationPrefs';
const NOTIFICATION_ICON = '/favicon.svg';
const NOTIFICATION_PREVIEW_LIMIT = 140;
const DEFAULT_COLLAPSED_TASK_COLUMNS = { done: true };
const initialUiState = readStoredUiState();

let appState = null;
let selectedSpaceType = initialUiState.selectedSpaceType || 'channel';
let selectedSpaceId = initialUiState.selectedSpaceId || 'chan_all';
let activeView = initialUiState.activeView || 'space';
let activeTab = initialUiState.activeTab || 'chat';
let railTab = initialUiState.railTab || localStorage.getItem('railTab') || 'spaces'; // 'spaces', 'members', 'computers', or 'settings'
let threadMessageId = initialUiState.threadMessageId || null;
let inspectorReturnThreadId = null;
let selectedAgentId = null; // selected agent for detail panel
let selectedTaskId = null;
let selectedSavedRecordId = null;
let modal = null;
let agentStartState = { agentId: null };
let agentRestartState = { agentId: null, mode: 'restart' };
let searchQuery = '';
let searchIsComposing = false;
let composerIsComposing = false;
let searchMineOnly = false;
let searchTimeRange = 'any';
let searchTimeMenuOpen = false;
let searchVisibleCount = 20;
let addMemberSearchQuery = '';
let createChannelMemberSearchQuery = '';
let taskFilter = 'all';
let taskViewMode = 'board';
let taskChannelFilterIds = [];
let taskChannelMenuOpen = false;
let collapsedTaskColumns = readCollapsedTaskColumns();
let stagedByComposer = {};
let composerDrafts = {};
let composerTaskFlags = {};
let composerMentionMaps = {};
let installedRuntimes = [];
let selectedRuntimeId = null;
const BOTTOM_THRESHOLD = 72;
let backBottomVisible = { main: false, thread: false };
let pendingBottomScroll = { main: false, thread: false };
let pendingComposerFocusId = null;
let paneScrollPositions = readStoredPaneScrolls();
let mentionLookupSeq = 0;
let expandedProjectTrees = {};
let projectTreeCache = {};
let projectFilePreviews = {};
let selectedProjectFile = null;
let expandedAgentWorkspaceTrees = {};
let agentWorkspaceTreeCache = {};
let agentWorkspaceFilePreviews = {};
let selectedAgentWorkspaceFile = null;
let agentWorkspacePreviewMode = 'preview';
let agentSkillsCache = {};
let agentWarmRequests = new Set();
let agentDetailTab = 'profile';
let agentDetailEditState = { field: null };
let agentEnvEditState = null;
let settingsTab = initialUiState.settingsTab || 'account';
let collapsedSidebarSections = readJsonStorage(SIDEBAR_SECTION_COLLAPSE_KEY, {});
let collapsedSkillSections = readJsonStorage(SKILL_SECTION_COLLAPSE_KEY, {});
let avatarCropState = null;
let notificationPrefs = normalizeNotificationPrefs(readJsonStorage(NOTIFICATION_PREF_KEY, {}));
let windowFocused = document.hasFocus();

const MAX_ATTACHMENTS_PER_COMPOSER = 20;
const AGENT_AVATAR_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const AGENT_ACTIVITY_EVENT_LIMIT = 5000;
const SEARCH_PAGE_SIZE = 20;
const SEARCH_RESULT_LIMIT = 200;
const SEARCH_SNIPPET_RADIUS = 88;
const AVATAR_CROP_SIZE = 256;
const AVATAR_CROP_STAGE_SIZE = 320;
const AVATAR_CROP_VIEW_SIZE = 220;
const AGENT_RECEIPT_VISIBLE_LIMIT = 10;

function isImeComposing(event) {
  return Boolean(
    event?.isComposing ||
    event?.keyCode === 229 ||
    event?.which === 229 ||
    composerIsComposing,
  );
}

// Track known agent receipts per message to only animate new arrivals
const knownMessageReceipts = new Map(); // messageId -> Set of agentIds
let activeReceiptPopover = null; // currently open receipt popover trigger element
let initialLoadComplete = false; // Skip animation on initial page load
let fanoutDecisionCards = [];
const seenFanoutRouteEventIds = new Set();
const seenAgentNotificationRecordIds = new Set();
const RAIL_WIDTH_KEY = 'magclawRailWidth';
const RAIL_MIN_WIDTH = 260;
const RAIL_MAX_WIDTH = 460;
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

function editPencilIcon() {
  return '<svg class="agent-edit-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M4 20h4l11-11-4-4L4 16z"/><path d="M13 7l4 4"/></svg>';
}

function refreshIcon() {
  return '<svg class="agent-edit-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M20 6v6h-6"/><path d="M4 18v-6h6"/><path d="M19 10a7 7 0 0 0-12-3"/><path d="M5 14a7 7 0 0 0 12 3"/></svg>';
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

function backBottomButton(targetName, extraClass = '') {
  const visibleClass = backBottomVisible[targetName] ? '' : ' hidden';
  const className = `back-bottom ${extraClass}${visibleClass}`.trim();
  return `
    <button class="${className}" type="button" data-action="back-to-bottom" data-target="${targetName}" aria-label="Back to bottom">
      <svg class="back-bottom-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 4v15" />
        <path d="m5 12 7 7 7-7" />
      </svg>
    </button>
  `;
}

const taskColumns = [
  ['todo', 'Todo'],
  ['in_progress', 'In Progress'],
  ['in_review', 'In Review'],
  ['done', 'Done'],
];

function taskIsClosedStatus(status) {
  return status === 'done';
}

const taskStatusMeta = {
  todo: { label: 'Todo', icon: '□', tone: 'todo' },
  in_progress: { label: 'In Progress', icon: '↻', tone: 'in_progress' },
  in_review: { label: 'In Review', icon: '👀', tone: 'in_review' },
  done: { label: 'Done', icon: '✓', tone: 'done' },
};

function taskStatusInfo(status) {
  return taskStatusMeta[status] || taskStatusMeta.todo;
}

function taskStatusClass(status) {
  return String(taskStatusMeta[status] ? status : 'todo').replace(/[^a-z0-9_-]/gi, '_');
}

function taskStatusIcon(status) {
  return taskStatusInfo(status).icon;
}

function taskStatusLabel(status) {
  return taskStatusInfo(status).label;
}

function renderTaskStatusBadge(status, options = {}) {
  const info = taskStatusInfo(status);
  const compact = options.compact ? ' compact' : '';
  return `
    <span class="task-status-icon-badge task-status-${escapeHtml(taskStatusClass(status))}${compact}" title="${escapeHtml(info.label)}" aria-label="${escapeHtml(info.label)}">
      <span class="task-status-symbol">${escapeHtml(taskStatusIcon(status))}</span>
      ${options.compact ? '' : `<span>${escapeHtml(info.label)}</span>`}
    </span>
  `;
}

function renderTaskColumnChip(status, label) {
  const info = taskStatusInfo(status);
  return `
    <span class="task-status-chip task-status-${escapeHtml(taskStatusClass(status))}" title="${escapeHtml(info.label)}">
      <span class="task-status-symbol">${escapeHtml(taskStatusIcon(status))}</span>
      <span>${escapeHtml(label || info.label)}</span>
    </span>
  `;
}

function taskAssigneeLabel(task) {
  const assigneeIds = task?.assigneeIds?.length ? task.assigneeIds : (task?.assigneeId ? [task.assigneeId] : []);
  return assigneeIds[0] ? displayName(assigneeIds[0]) : '';
}

function renderTaskHoverCard(task) {
  if (!task) return '';
  const number = task.number || shortId(task.id);
  const assigneeIds = task.assigneeIds?.length ? task.assigneeIds : (task.assigneeId ? [task.assigneeId] : []);
  const assignees = assigneeIds.length ? assigneeIds.map(displayName).join(', ') : 'unassigned';
  const creator = task.createdBy ? displayName(task.createdBy) : 'Unknown';
  return `
    <span class="task-hover-card" role="tooltip">
      <strong>#${escapeHtml(number)} ${escapeHtml(taskStatusLabel(task.status))}</strong>
      <span>${escapeHtml(plainMentionText(task.title || 'Untitled task')).slice(0, 92)}</span>
      <small>${escapeHtml(spaceName(task.spaceType, task.spaceId))} · ${fmtTime(task.updatedAt || task.createdAt)}</small>
      <small>creator @${escapeHtml(creator)} · assignee @${escapeHtml(assignees)}</small>
    </span>
  `;
}

function renderTaskInlineBadge(task, options = {}) {
  if (!task) return '';
  const number = task.number || shortId(task.id);
  const assignee = taskAssigneeLabel(task);
  const showAssignee = options.showAssignee !== false && assignee;
  const showHover = options.hover !== false;
  const label = `Task #${number} · ${taskStatusLabel(task.status)}${assignee ? ` · @${assignee}` : ''}`;
  return `
    <span class="task-inline-badge task-status-${escapeHtml(taskStatusClass(task.status))}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">
      ${renderTaskStatusBadge(task.status, { compact: true })}
      <span>#${escapeHtml(number)}</span>
      ${showAssignee ? `<span>@${escapeHtml(assignee)}</span>` : ''}
      ${showHover ? renderTaskHoverCard(task) : ''}
    </span>
  `;
}

function renderThreadKindBadge(message, task) {
  if (task) return renderTaskInlineBadge(task);
  return `
    <span class="thread-kind-badge" title="Channel thread" aria-label="Channel thread">
      <span>↩</span>
      <span>Thread</span>
    </span>
  `;
}

function renderThreadRowAvatar(message) {
  return `
    <span class="avatar thread-list-avatar" aria-hidden="true">
      ${getAvatarHtml(message.authorId, message.authorType, 'avatar-inner')}
      ${agentStatusDot(message.authorId, message.authorType)}
    </span>
  `;
}

function renderTaskStateFlow(task) {
  const status = taskStatusMeta[task?.status] ? task.status : 'todo';
  const currentIndex = Math.max(0, taskColumns.findIndex(([value]) => value === status));
  return `
    <div class="task-state-flow" aria-label="Task status: ${escapeHtml(taskStatusLabel(status))}">
      ${taskColumns.map(([value]) => {
        const index = taskColumns.findIndex(([item]) => item === value);
        const state = index < currentIndex ? 'complete' : (index === currentIndex ? 'current' : 'pending');
        return `
          <span class="task-state-node ${state} task-status-${escapeHtml(taskStatusClass(value))}" title="${escapeHtml(taskStatusLabel(value))}">
            <span>${escapeHtml(taskStatusIcon(value))}</span>
            <em>${escapeHtml(taskStatusLabel(value))}</em>
          </span>
        `;
      }).join('<span class="task-state-link" aria-hidden="true"></span>')}
    </div>
  `;
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

function readJsonStorage(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || 'null');
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Browser storage can be disabled; keep the live UI working without persistence.
  }
}

function normalizeNotificationPrefs(value = {}) {
  return {
    enabled: Boolean(value.enabled),
    dismissedPrompt: Boolean(value.dismissedPrompt),
    enabledAt: value.enabledAt || null,
    dismissedAt: value.dismissedAt || null,
  };
}

function saveNotificationPrefs(nextPrefs = notificationPrefs) {
  notificationPrefs = normalizeNotificationPrefs(nextPrefs);
  writeJsonStorage(NOTIFICATION_PREF_KEY, notificationPrefs);
}

function notificationApiSupported() {
  return 'Notification' in window;
}

function browserNotificationPermission() {
  if (!notificationApiSupported()) return 'unsupported';
  return Notification.permission || 'default';
}

function agentNotificationsEnabled() {
  return notificationPrefs.enabled && browserNotificationPermission() === 'granted';
}

function notificationPromptVisible() {
  return notificationApiSupported()
    && browserNotificationPermission() === 'default'
    && !notificationPrefs.enabled
    && !notificationPrefs.dismissedPrompt;
}

function notificationStatusLabel() {
  const permission = browserNotificationPermission();
  if (permission === 'unsupported') return 'Unsupported';
  if (permission === 'denied') return 'Blocked';
  if (permission === 'granted' && notificationPrefs.enabled) return 'On';
  if (permission === 'granted') return 'Off';
  return 'Ask first';
}

function notificationStatusDetail() {
  const permission = browserNotificationPermission();
  if (permission === 'unsupported') return 'This browser does not expose desktop notifications.';
  if (permission === 'denied') return 'Notifications are blocked in the browser site settings.';
  if (permission === 'granted' && notificationPrefs.enabled) return 'Agent replies will notify you while Magclaw is in the background.';
  if (permission === 'granted') return 'Browser permission is granted; app notifications are currently off.';
  return 'Chrome will ask for permission before turning this on.';
}

function notificationBellIcon(size = 16) {
  return `<svg class="notification-bell-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/></svg>`;
}

function renderNotificationPromptBanner() {
  if (!notificationPromptVisible()) return '';
  return `
    <section class="notification-banner" aria-label="Enable agent notifications">
      <div class="notification-banner-copy">
        ${notificationBellIcon(18)}
        <strong>Enable agent notifications</strong>
        <span>Get agent replies while Magclaw is in the background.</span>
      </div>
      <div class="notification-banner-actions">
        <button class="primary-btn" type="button" data-action="enable-agent-notifications">Enable Notifications</button>
        <button class="secondary-btn" type="button" data-action="dismiss-agent-notifications">Not Now</button>
      </div>
    </section>
  `;
}

function renderNotificationConfigCard() {
  const permission = browserNotificationPermission();
  const enabled = agentNotificationsEnabled();
  const canEnable = permission === 'default' || permission === 'granted';
  return `
    <div class="pixel-panel cloud-card notification-config-card">
      <div class="panel-title"><span>Agent Notifications</span><span>${escapeHtml(notificationStatusLabel())}</span></div>
      <div class="notification-card-body">
        <div class="notification-card-icon">${notificationBellIcon(20)}</div>
        <div>
          <strong>${enabled ? 'Browser notifications are on' : 'Browser notifications are off'}</strong>
          <p>${escapeHtml(notificationStatusDetail())}</p>
          <small>Delivered for new agent messages and thread replies while this tab is not focused.</small>
        </div>
      </div>
      <div class="notification-card-actions">
        ${enabled
          ? '<button class="secondary-btn" type="button" data-action="disable-agent-notifications">Turn Off</button>'
          : `<button class="primary-btn" type="button" data-action="enable-agent-notifications" ${canEnable ? '' : 'disabled'}>Turn On</button>`}
      </div>
    </div>
  `;
}

async function enableAgentNotifications() {
  if (!notificationApiSupported()) {
    toast('Browser notifications are not supported here');
    return false;
  }
  let permission = browserNotificationPermission();
  if (permission === 'default') {
    permission = await Notification.requestPermission();
  }
  if (permission === 'granted') {
    saveNotificationPrefs({
      ...notificationPrefs,
      enabled: true,
      dismissedPrompt: true,
      enabledAt: new Date().toISOString(),
    });
    toast('Agent notifications enabled');
    render();
    return true;
  }
  saveNotificationPrefs({ ...notificationPrefs, enabled: false, dismissedPrompt: true });
  toast(permission === 'denied' ? 'Notifications are blocked in browser settings' : 'Notifications were not enabled');
  render();
  return false;
}

function disableAgentNotifications() {
  saveNotificationPrefs({ ...notificationPrefs, enabled: false });
  toast('Agent notifications off');
  render();
}

function dismissAgentNotifications() {
  saveNotificationPrefs({
    ...notificationPrefs,
    enabled: false,
    dismissedPrompt: true,
    dismissedAt: new Date().toISOString(),
  });
  render();
}

function readStoredUiState() {
  const parsed = readJsonStorage(UI_STATE_KEY, {});
  const validSpaceType = ['channel', 'dm'].includes(parsed.selectedSpaceType) ? parsed.selectedSpaceType : 'channel';
  const validView = ['space', 'tasks', 'threads', 'saved', 'search', 'missions', 'cloud', 'computers'].includes(parsed.activeView)
    ? parsed.activeView
    : 'space';
  const validTab = ['chat', 'tasks'].includes(parsed.activeTab) ? parsed.activeTab : 'chat';
  const validRailTab = ['spaces', 'members', 'computers', 'settings'].includes(parsed.railTab) ? parsed.railTab : '';
  const validSettingsTab = ['account', 'browser', 'server', 'system', 'release'].includes(parsed.settingsTab) ? parsed.settingsTab : 'account';
  return {
    selectedSpaceType: validSpaceType,
    selectedSpaceId: String(parsed.selectedSpaceId || ''),
    activeView: validView,
    activeTab: validTab,
    railTab: validRailTab,
    settingsTab: validSettingsTab,
    threadMessageId: parsed.threadMessageId ? String(parsed.threadMessageId) : null,
  };
}

function persistUiState() {
  const payload = {
    selectedSpaceType,
    selectedSpaceId,
    activeView,
    activeTab,
    railTab,
    settingsTab,
    threadMessageId,
  };
  writeJsonStorage(UI_STATE_KEY, payload);
  try {
    localStorage.setItem('railTab', railTab);
  } catch {
    // Non-critical compatibility write for older saved sessions.
  }
}

function readStoredPaneScrolls() {
  const parsed = readJsonStorage(PANE_SCROLL_KEY, {});
  return Object.fromEntries(Object.entries(parsed)
    .map(([key, value]) => {
      const normalized = normalizeStoredPaneScroll(value);
      return normalized ? [key, normalized] : null;
    })
    .filter(Boolean));
}

function normalizeStoredPaneScroll(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) return null;
    return {
      top: value,
      atBottom: value <= BOTTOM_THRESHOLD,
      legacy: true,
    };
  }
  if (!value || typeof value !== 'object') return null;
  const top = Number(value.top);
  if (!Number.isFinite(top) || top < 0) return null;
  return {
    top,
    atBottom: Boolean(value.atBottom),
    scrollHeight: Number.isFinite(Number(value.scrollHeight)) ? Number(value.scrollHeight) : null,
    clientHeight: Number.isFinite(Number(value.clientHeight)) ? Number(value.clientHeight) : null,
    updatedAt: value.updatedAt || null,
  };
}

function persistPaneScroll(targetName, node) {
  const key = paneKey(targetName);
  if (!key || !node) return;
  paneScrollPositions[key] = {
    top: Math.max(0, Math.round(node.scrollTop || 0)),
    atBottom: paneIsAtBottom(node),
    scrollHeight: Math.max(0, Math.round(node.scrollHeight || 0)),
    clientHeight: Math.max(0, Math.round(node.clientHeight || 0)),
    updatedAt: new Date().toISOString(),
  };
  const entries = Object.entries(paneScrollPositions);
  if (entries.length > 120) {
    paneScrollPositions = Object.fromEntries(entries.slice(entries.length - 120));
  }
  writeJsonStorage(PANE_SCROLL_KEY, paneScrollPositions);
}

function readCollapsedTaskColumns() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TASK_COLUMN_COLLAPSE_KEY) || '{}');
    if (parsed && typeof parsed === 'object') {
      return { ...DEFAULT_COLLAPSED_TASK_COLUMNS, ...parsed };
    }
    return { ...DEFAULT_COLLAPSED_TASK_COLUMNS };
  } catch {
    return { ...DEFAULT_COLLAPSED_TASK_COLUMNS };
  }
}

function toggleTaskColumn(status) {
  collapsedTaskColumns = {
    ...collapsedTaskColumns,
    [status]: !collapsedTaskColumns[status],
  };
  localStorage.setItem(TASK_COLUMN_COLLAPSE_KEY, JSON.stringify(collapsedTaskColumns));
}

function toggleSidebarSection(section) {
  collapsedSidebarSections = {
    ...collapsedSidebarSections,
    [section]: !collapsedSidebarSections[section],
  };
  writeJsonStorage(SIDEBAR_SECTION_COLLAPSE_KEY, collapsedSidebarSections);
}

function toggleSkillSection(section) {
  collapsedSkillSections = {
    ...collapsedSkillSections,
    [section]: !collapsedSkillSections[section],
  };
  writeJsonStorage(SKILL_SECTION_COLLAPSE_KEY, collapsedSkillSections);
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

function agentWarmRequestKey(agent) {
  return [
    agent?.id || '',
    agent?.runtimeLastStartedAt || '',
    agent?.runtimeWarmAt || '',
    agent?.runtimeLastTurnAt || '',
  ].join(':');
}

function selectedWarmableAgent() {
  if (!appState) return null;
  if (selectedAgentId) return byId(appState.agents, selectedAgentId);
  if (activeView === 'space' && selectedSpaceType === 'dm') {
    const peer = currentDmPeer();
    if (peer?.type === 'agent') return peer.item;
  }
  return null;
}

function maybeWarmAgent(agent, { spaceType = selectedSpaceType, spaceId = selectedSpaceId } = {}) {
  if (!agent?.id) return;
  const runtime = String(agent.runtime || '').toLowerCase();
  if (runtime && !runtime.includes('codex')) return;
  if (['thinking', 'working', 'starting', 'running', 'queued'].includes(String(agent.status || '').toLowerCase())) return;
  const key = agentWarmRequestKey(agent);
  if (agentWarmRequests.has(key)) return;
  agentWarmRequests.add(key);
  api(`/api/agents/${encodeURIComponent(agent.id)}/warm`, {
    method: 'POST',
    body: JSON.stringify({ spaceType, spaceId }),
  }).catch((error) => {
    agentWarmRequests.delete(key);
    console.warn('Agent warmup failed', error);
  });
}

function maybeWarmCurrentAgent() {
  const agent = selectedWarmableAgent();
  if (!agent) return;
  maybeWarmAgent(agent, { spaceType: selectedSpaceType, spaceId: selectedSpaceId });
}

function readAvatarFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Could not read avatar file.'));
    reader.readAsDataURL(file);
  });
}

function loadAvatarImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not load avatar image.'));
    image.src = src;
  });
}

function avatarCropBaseSize(width, height) {
  const safeWidth = Math.max(1, Number(width) || AVATAR_CROP_VIEW_SIZE);
  const safeHeight = Math.max(1, Number(height) || AVATAR_CROP_VIEW_SIZE);
  const scale = Math.max(AVATAR_CROP_VIEW_SIZE / safeWidth, AVATAR_CROP_VIEW_SIZE / safeHeight);
  return {
    baseWidth: safeWidth * scale,
    baseHeight: safeHeight * scale,
  };
}

function clampAvatarCropScale(scale) {
  return Math.min(4, Math.max(1, Number(scale) || 1));
}

function clampAvatarCropOffset(state = avatarCropState) {
  if (!state) return null;
  const scale = clampAvatarCropScale(state.scale);
  const displayWidth = (state.baseWidth || AVATAR_CROP_VIEW_SIZE) * scale;
  const displayHeight = (state.baseHeight || AVATAR_CROP_VIEW_SIZE) * scale;
  const maxX = Math.max(0, (displayWidth - AVATAR_CROP_VIEW_SIZE) / 2);
  const maxY = Math.max(0, (displayHeight - AVATAR_CROP_VIEW_SIZE) / 2);
  state.scale = scale;
  state.offsetX = Math.min(maxX, Math.max(-maxX, Number(state.offsetX) || 0));
  state.offsetY = Math.min(maxY, Math.max(-maxY, Number(state.offsetY) || 0));
  return state;
}

function updateAvatarCropPreview() {
  const image = document.querySelector('.avatar-crop-image');
  if (!image || !avatarCropState) return;
  clampAvatarCropOffset();
  image.style.width = `${avatarCropState.baseWidth}px`;
  image.style.height = `${avatarCropState.baseHeight}px`;
  image.style.setProperty('--avatar-crop-x', `${avatarCropState.offsetX}px`);
  image.style.setProperty('--avatar-crop-y', `${avatarCropState.offsetY}px`);
  image.style.setProperty('--avatar-crop-scale', String(avatarCropState.scale));
}

async function openAvatarCropModal({ agentId, source, target = 'agent-detail' }) {
  const image = await loadAvatarImage(source);
  const { baseWidth, baseHeight } = avatarCropBaseSize(image.naturalWidth, image.naturalHeight);
  avatarCropState = clampAvatarCropOffset({
    agentId,
    target,
    source,
    naturalWidth: image.naturalWidth,
    naturalHeight: image.naturalHeight,
    baseWidth,
    baseHeight,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
  });
  modal = 'avatar-crop';
  render();
}

async function drawCroppedAvatarToDataUrl(state = avatarCropState) {
  if (!state?.source) throw new Error('No avatar crop is active.');
  const image = await loadAvatarImage(state.source);
  clampAvatarCropOffset(state);
  const canvas = document.createElement('canvas');
  canvas.width = AVATAR_CROP_SIZE;
  canvas.height = AVATAR_CROP_SIZE;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Could not crop avatar.');

  const displayWidth = state.baseWidth * state.scale;
  const displayHeight = state.baseHeight * state.scale;
  const stageCenter = AVATAR_CROP_STAGE_SIZE / 2;
  const cropLeft = (AVATAR_CROP_STAGE_SIZE - AVATAR_CROP_VIEW_SIZE) / 2;
  const cropTop = (AVATAR_CROP_STAGE_SIZE - AVATAR_CROP_VIEW_SIZE) / 2;
  const imageLeft = stageCenter + state.offsetX - (displayWidth / 2);
  const imageTop = stageCenter + state.offsetY - (displayHeight / 2);
  const sx = ((cropLeft - imageLeft) / displayWidth) * image.naturalWidth;
  const sy = ((cropTop - imageTop) / displayHeight) * image.naturalHeight;
  const sw = (AVATAR_CROP_VIEW_SIZE / displayWidth) * image.naturalWidth;
  const sh = (AVATAR_CROP_VIEW_SIZE / displayHeight) * image.naturalHeight;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, AVATAR_CROP_SIZE, AVATAR_CROP_SIZE);
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, AVATAR_CROP_SIZE, AVATAR_CROP_SIZE);
  return canvas.toDataURL('image/png');
}

async function uploadAgentAvatar(input) {
  const target = input?.dataset?.target || 'agent-detail';
  const agentId = input?.dataset?.id || selectedAgentId;
  const file = input?.files?.[0];
  if (!file) return;
  if (file.size > AGENT_AVATAR_UPLOAD_MAX_BYTES) {
    toast('Avatar must be 10 MB or smaller');
    input.value = '';
    return;
  }
  if (target === 'agent-create') {
    saveAgentFormState();
  } else if (!agentId) {
    input.value = '';
    return;
  }
  const avatar = await readAvatarFileAsDataUrl(file);
  input.value = '';
  await openAvatarCropModal({ agentId, source: avatar, target });
}

function byId(list, id) {
  return (list || []).find((item) => item.id === id) || null;
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
  return String(id || '').split('_').pop()?.slice(0, 6) || 'local';
}

function displayName(id) {
  if (id === 'agt_codex') return 'Codex Local';
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
    return `<div class="avatar agent-avatar-cell">${renderAgentIdentityButton(authorId, 'agent-avatar-button')}${agentStatusDot(authorId, authorType)}</div>`;
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
    const name = agent?.name || (id === 'agt_codex' ? displayName(id) : '');
    return name
      ? `<span class="mention-tag mention-identity" data-mention-id="${id}">@${escapeHtml(name)}</span>`
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
    .replace(/\b(agt_\w+|hum_\w+)\b/g, (_, id) => displayName(id))
    .replace(/\s+/g, ' ')
    .trim();
}

function plainActorText(text) {
  return String(text || '').replace(/\b(agt_\w+|hum_\w+)\b/g, (_, id) => displayName(id));
}

function displayNameFromState(stateSnapshot, id) {
  if (id === 'agt_codex') return 'Codex Local';
  const human = byId(stateSnapshot?.humans, id);
  if (human) return human.name;
  const agent = byId(stateSnapshot?.agents, id);
  if (agent) return agent.name;
  return id === 'system' ? 'Magclaw' : 'Unknown';
}

function spaceNameFromState(stateSnapshot, spaceType, spaceId) {
  if (spaceType === 'channel') return `#${byId(stateSnapshot?.channels, spaceId)?.name || 'missing'}`;
  const dm = byId(stateSnapshot?.dms, spaceId);
  const other = dm?.participantIds?.find((id) => id !== 'hum_local');
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
    const peerId = (dm.participantIds || []).find((id) => id !== 'hum_local') || dm.participantIds?.[0];
    const label = displayName(peerId);
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

function spaceTasks(spaceType = selectedSpaceType, spaceId = selectedSpaceId) {
  return (appState?.tasks || [])
    .filter((task) => task.spaceType === spaceType && task.spaceId === spaceId)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
}

function isVisibleChannelTask(task) {
  return task?.spaceType === 'channel';
}

function taskMatchesChannelFilter(task) {
  return !taskChannelFilterIds.length || taskChannelFilterIds.includes(task.spaceId);
}

function taskCountLabel(total, filtered) {
  return filtered === total ? `${total} channel tasks` : `${filtered} of ${total} channel tasks`;
}

function sortTasks(tasks) {
  return [...tasks].sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
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

function avatarStatusDot(status, label = 'Status') {
  const value = status || 'offline';
  return `<span class="avatar-status-dot ${presenceClass(value)}" title="${escapeHtml(value)}" aria-label="${escapeHtml(label)}: ${escapeHtml(value)}"></span>`;
}

function agentStatusDot(authorId, authorType) {
  if (authorType !== 'agent') return '';
  const agent = byId(appState?.agents, authorId);
  return avatarStatusDot(agent?.status || 'offline', 'Agent status');
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

function snapshotComposerState(form, composerId, { includeTask = false } = {}) {
  const textarea = form?.querySelector('textarea[name="body"]');
  const taskInput = form?.querySelector('input[name="asTask"]');
  return {
    body: textarea?.value ?? composerDrafts[composerId] ?? '',
    attachments: [...stagedFor(composerId).attachments],
    mentionMap: { ...(composerMentionMaps[composerId] || {}) },
    task: includeTask ? Boolean(taskInput?.checked || composerTaskFlags[composerId]) : false,
  };
}

function clearComposerForSubmit(form, composerId, { clearTask = false } = {}) {
  const textarea = form?.querySelector('textarea[name="body"]');
  if (textarea) {
    textarea.value = '';
    textarea.defaultValue = '';
  }
  const taskInput = form?.querySelector('input[name="asTask"]');
  if (clearTask && taskInput) taskInput.checked = false;
  clearStagedFor(composerId);
  updateComposerAttachmentStrip(composerId);
  delete composerDrafts[composerId];
  delete composerMentionMaps[composerId];
  if (clearTask) delete composerTaskFlags[composerId];
}

function restoreComposerAfterFailedSubmit(form, composerId, snapshot, { restoreTask = false } = {}) {
  const body = snapshot?.body || '';
  if (body) composerDrafts[composerId] = body;
  else delete composerDrafts[composerId];
  if (snapshot?.attachments?.length) setStagedFor(composerId, snapshot.attachments);
  else clearStagedFor(composerId);
  updateComposerAttachmentStrip(composerId);
  if (snapshot?.mentionMap && Object.keys(snapshot.mentionMap).length) composerMentionMaps[composerId] = snapshot.mentionMap;
  else delete composerMentionMaps[composerId];
  if (restoreTask) composerTaskFlags[composerId] = Boolean(snapshot?.task);
  const textarea = form?.querySelector('textarea[name="body"]');
  if (textarea) {
    textarea.value = body;
    textarea.defaultValue = body;
  }
  const taskInput = form?.querySelector('input[name="asTask"]');
  if (restoreTask && taskInput) taskInput.checked = Boolean(snapshot?.task);
}

function paneSelector(targetName) {
  return targetName === 'thread' ? '#thread-context' : '#message-list';
}

function paneKey(targetName) {
  if (targetName === 'thread') return threadMessageId ? `thread:${threadMessageId}` : '';
  return `main:${activeView}:${activeTab}:${selectedSpaceType}:${selectedSpaceId}`;
}

function storedPaneScroll(key) {
  return key ? normalizeStoredPaneScroll(paneScrollPositions[key]) : null;
}

function targetDefaultAtBottom(targetName) {
  return targetName === 'main' || targetName === 'thread';
}

function paneIsAtBottom(node) {
  if (!node) return true;
  return node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_THRESHOLD;
}

function paneScrollSnapshot(targetName) {
  const node = document.querySelector(paneSelector(targetName));
  const key = paneKey(targetName);
  const stored = storedPaneScroll(key);
  if (!node) {
    return {
      key,
      top: stored?.top || 0,
      atBottom: stored ? stored.atBottom : targetDefaultAtBottom(targetName),
      hasPosition: Boolean(stored),
    };
  }
  return {
    key,
    top: node.scrollTop || 0,
    atBottom: paneIsAtBottom(node),
    hasPosition: true,
  };
}

function persistVisiblePaneScrolls() {
  const main = document.querySelector(paneSelector('main'));
  if (main) persistPaneScroll('main', main);
  const thread = document.querySelector(paneSelector('thread'));
  if (thread) persistPaneScroll('thread', thread);
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
  const currentKey = paneKey(targetName);
  const stored = storedPaneScroll(currentKey);
  const candidate = snapshot?.key === currentKey
    ? snapshot
    : (stored ? { key: currentKey, ...stored, hasPosition: true } : null);
  const forceBottom = pendingBottomScroll[targetName];
  pendingBottomScroll[targetName] = false;
  const hasPosition = Boolean(candidate?.hasPosition);
  const shouldFollowBottom = forceBottom || (hasPosition ? candidate.atBottom : targetDefaultAtBottom(targetName));
  if (!shouldFollowBottom && hasPosition) {
    const maxTop = Math.max(0, node.scrollHeight - node.clientHeight);
    node.scrollTop = Math.min(Math.max(0, candidate.top || 0), maxTop);
    persistPaneScroll(targetName, node);
  } else {
    node.scrollTop = node.scrollHeight;
    persistPaneScroll(targetName, node);
    window.setTimeout(() => {
      const current = document.querySelector(paneSelector(targetName));
      if (!current) return;
      current.scrollTop = current.scrollHeight;
      persistPaneScroll(targetName, current);
      updateBackBottomVisibility(targetName);
    }, 40);
    window.setTimeout(() => {
      const current = document.querySelector(paneSelector(targetName));
      if (!current) return;
      current.scrollTop = current.scrollHeight;
      persistPaneScroll(targetName, current);
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

function scrollToReply(replyId) {
  window.setTimeout(() => {
    const node = document.querySelector(`#thread-context #reply-${CSS.escape(replyId)}`);
    const pane = document.querySelector('#thread-context');
    if (node && pane) {
      const targetTop = node.offsetTop - (pane.clientHeight / 2) + (node.offsetHeight / 2);
      pane.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
      updateBackBottomVisibility('thread');
      node.classList.add('focus-pulse');
      window.setTimeout(() => node.classList.remove('focus-pulse'), 1200);
    }
  }, 80);
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

function focusComposerTextarea(composerId) {
  if (!composerId) return false;
  const textarea = document.querySelector(`textarea[data-composer-id="${CSS.escape(composerId)}"]`);
  if (!textarea) return false;
  try {
    textarea.focus({ preventScroll: true });
  } catch {
    textarea.focus();
  }
  const end = textarea.value.length;
  textarea.setSelectionRange(end, end);
  return document.activeElement === textarea;
}

function requestComposerFocus(composerId) {
  pendingComposerFocusId = composerId || null;
}

function restorePendingComposerFocus() {
  if (!pendingComposerFocusId) return;
  const composerId = pendingComposerFocusId;
  pendingComposerFocusId = null;
  focusComposerTextarea(composerId);
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

function renderFanoutDecisionToasts() {
  return renderFanoutDecisionToastsHtml(fanoutDecisionCards);
}

function patchFanoutDecisionToasts() {
  const next = htmlToElement(renderFanoutDecisionToasts());
  const current = document.querySelector('.fanout-toast-stack');
  if (current && next) {
    current.replaceWith(next);
    return;
  }
  if (next) root.appendChild(next);
}

function removeFanoutDecisionCard(id) {
  fanoutDecisionCards = fanoutDecisionCards.filter((card) => card.id !== id);
  patchFanoutDecisionToasts();
}

function dismissFanoutDecisionCard(id) {
  fanoutDecisionCards = fanoutDecisionCards.map((card) => (
    card.id === id ? { ...card, exiting: true } : card
  ));
  patchFanoutDecisionToasts();
  window.setTimeout(() => removeFanoutDecisionCard(id), 220);
}

function addFanoutDecisionCard(card) {
  fanoutDecisionCards = [card];
  patchFanoutDecisionToasts();
  window.setTimeout(() => dismissFanoutDecisionCard(card.id), 5000);
}

function enqueueFanoutDecisionCards(routeEvent, stateSnapshot = appState) {
  if (!routeEvent?.id) return;
  buildFanoutDecisionCards(routeEvent, stateSnapshot)
    .forEach((card, index) => {
      window.setTimeout(() => addFanoutDecisionCard(card), index * 240);
    });
}

function appIsInBackground() {
  return document.visibilityState === 'hidden' || !windowFocused;
}

function agentNotificationRecords(stateSnapshot) {
  return [...(stateSnapshot?.messages || []), ...(stateSnapshot?.replies || [])]
    .filter((record) => record?.id && record.authorType === 'agent')
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
}

function notificationRootRecord(record, stateSnapshot = appState) {
  return record?.parentMessageId ? byId(stateSnapshot?.messages, record.parentMessageId) : record;
}

function notificationTitle(record, stateSnapshot = appState) {
  const agentName = displayNameFromState(stateSnapshot, record?.authorId);
  const root = notificationRootRecord(record, stateSnapshot);
  const space = spaceNameFromState(stateSnapshot, root?.spaceType || record?.spaceType, root?.spaceId || record?.spaceId);
  return record?.parentMessageId ? `${agentName} replied in ${space}` : `${agentName} in ${space}`;
}

function notificationBody(record, stateSnapshot = appState) {
  const text = plainNotificationText(record?.body || '(attachment)', stateSnapshot);
  if (!text) return '(attachment)';
  return text.length > NOTIFICATION_PREVIEW_LIMIT ? `${text.slice(0, NOTIFICATION_PREVIEW_LIMIT - 1)}…` : text;
}

function openNotificationRecord(recordId) {
  const record = conversationRecord(recordId);
  if (!record) return;
  openSearchResult(record);
}

function showAgentNotification(record, stateSnapshot = appState) {
  if (!agentNotificationsEnabled() || !appIsInBackground()) return;
  try {
    const agent = byId(stateSnapshot?.agents, record.authorId);
    const notification = new Notification(notificationTitle(record, stateSnapshot), {
      body: notificationBody(record, stateSnapshot),
      icon: agent?.avatar || NOTIFICATION_ICON,
      badge: NOTIFICATION_ICON,
      tag: `magclaw:${record.id}`,
    });
    notification.onclick = () => {
      window.focus();
      window.setTimeout(() => openNotificationRecord(record.id), 20);
      notification.close();
    };
  } catch {
    // Browser notification failures should not interrupt live chat rendering.
  }
}

function trackAgentNotifications(nextState, { silent = false } = {}) {
  const fresh = [];
  for (const record of agentNotificationRecords(nextState)) {
    if (seenAgentNotificationRecordIds.has(record.id)) continue;
    seenAgentNotificationRecordIds.add(record.id);
    if (!silent) fresh.push(record);
  }
  fresh.slice(-3).forEach((record) => showAgentNotification(record, nextState));
}

function trackFanoutRouteEvents(nextState, { silent = false } = {}) {
  const newLlmEvents = [];
  for (const event of nextState?.routeEvents || []) {
    if (!event?.id || seenFanoutRouteEventIds.has(event.id)) continue;
    seenFanoutRouteEventIds.add(event.id);
    if (!event.llmUsed) continue;
    newLlmEvents.push(event);
  }
  if (!silent && initialLoadComplete && newLlmEvents.length) {
    enqueueFanoutDecisionCards(newLlmEvents.at(-1), nextState);
  }
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
  if (selectedTaskId && !byId(appState.tasks, selectedTaskId)) {
    selectedTaskId = null;
  }
  if (threadMessageId && !byId(appState.messages, threadMessageId)) {
    threadMessageId = null;
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
  persistUiState();
  const inspectorHtml = renderInspector();
  const notificationBanner = renderNotificationPromptBanner();
  root.innerHTML = `
    ${notificationBanner}
    <div class="app-frame collab-frame${inspectorHtml ? '' : ' no-inspector'}${notificationBanner ? ' notification-banner-active' : ''}" style="${appFrameStyle()}">
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
    ${renderFanoutDecisionToasts()}
  `;
  window.requestAnimationFrame(() => {
    restorePaneScrolls(scrollSnapshot);
    restorePendingComposerFocus();
  });
}

function renderRail() {
  const channels = appState.channels || [];
  const dms = appState.dms || [];
  const unreadThreads = (appState.messages || []).filter((message) => message.replyCount > 0 || message.taskId).length;
  const openTasks = (appState.tasks || []).filter((task) => !taskIsClosedStatus(task.status)).length;
  const saved = savedRecords().length;
  const normalAgents = channelAssignableAgents();
  const localHuman = byId(appState.humans, 'hum_local') || appState.humans?.[0] || { name: 'You' };
  const railMode = activeView === 'tasks'
    ? 'tasks'
    : activeView === 'cloud'
      ? 'settings'
      : activeView === 'computers' || (activeView === 'missions' && railTab === 'computers')
        ? 'desktop'
        : railTab === 'members'
          ? 'members'
          : 'chat';
  const railHeading = railMode === 'tasks'
    ? 'Tasks'
    : railMode === 'members'
      ? 'Members'
      : railMode === 'settings'
        ? 'Settings'
        : railMode === 'desktop'
          ? 'Computers'
          : 'Chat';
  const sidebarBody = railMode === 'settings'
    ? renderSettingsRail()
    : railMode === 'desktop'
      ? renderComputersRail()
      : railTab === 'spaces'
        ? renderChatRail({ channels, dms, unreadThreads, openTasks, saved })
        : renderMembersRail({ normalAgents });

  return `
    <aside class="rail collab-rail slock-rail">
      <div class="slock-left-rail">
        <button class="left-rail-avatar" type="button" data-action="set-left-nav" data-nav="chat" title="${escapeHtml(localHuman.name || 'You')}">${escapeHtml((localHuman.name || 'Y').trim().slice(0, 1).toUpperCase())}</button>
        ${renderLeftRailButton('chat', railMode, 'Chat', '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>')}
        ${renderLeftRailButton('tasks', railMode, 'Tasks', '<path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>', openTasks || '')}
        ${renderLeftRailButton('members', railMode, 'Members', '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/>', normalAgents.length || '')}
        ${renderLeftRailButton('desktop', railMode, 'Computers', '<rect x="3" y="4" width="18" height="13" rx="1"/><path d="M8 21h8"/><path d="M12 17v4"/>')}
        <span class="left-rail-spacer"></span>
        ${renderLeftRailButton('settings', railMode, 'Settings', '<circle cx="12" cy="12" r="3"/><path d="M12 3v3"/><path d="M12 18v3"/><path d="M3 12h3"/><path d="M18 12h3"/><path d="M5.6 5.6l2.1 2.1"/><path d="M16.3 16.3l2.1 2.1"/><path d="M18.4 5.6l-2.1 2.1"/><path d="M7.7 16.3l-2.1 2.1"/>')}
      </div>
      <div class="slock-sidebar">
        <div class="slock-sidebar-header">
          <h2>${escapeHtml(railHeading)}</h2>
        </div>

      ${sidebarBody}

      <div class="runtime-chip">
        <span class="status-dot ${appState.connection?.mode === 'cloud' ? 'online' : ''}"></span>
        <div>
          <strong>${escapeHtml(appState.runtime?.host || 'local')}</strong>
          <small>${escapeHtml(appState.connection?.mode === 'cloud' ? 'Connected' : 'Local')}</small>
        </div>
      </div>
      </div>
    </aside>
  `;
}

function renderChatRail({ channels, dms, unreadThreads, openTasks, saved }) {
  return `
    <div class="nav-list">
      ${renderNavItem('search', 'Search', 'search', searchQuery ? '⌘K' : '⌘K')}
      ${renderNavItem('threads', 'Threads', 'message', unreadThreads || '')}
      ${renderNavItem('tasks', 'Tasks', 'file', openTasks || '')}
      ${renderNavItem('saved', 'Saved', 'bookmark', saved || '')}
    </div>

    <div class="rail-section">
      ${renderRailSectionTitle('channels', 'Channels', channels.length, { modal: 'channel' })}
      ${collapsedSidebarSections.channels ? '' : channels.map((channel) => renderChannelItem(channel)).join('')}
    </div>

    <div class="rail-section">
      ${renderRailSectionTitle('dms', 'DIRECT MESSAGES', dms.length, { modal: 'dm' })}
      ${collapsedSidebarSections.dms ? '' : dms.map((dm) => {
        const other = dm.participantIds.find((id) => id !== 'hum_local');
        const agent = byId(appState.agents, other);
        const human = byId(appState.humans, other);
        const status = agent?.status || human?.status || '';
        return renderDmItem(dm.id, displayName(other), status, agent?.avatar || human?.avatar);
      }).join('')}
    </div>
  `;
}

function renderMembersRail({ normalAgents }) {
  return `
    <div class="rail-section">
      ${renderRailSectionTitle('agents', 'Agents', normalAgents.length, { modal: 'agent' })}
      ${collapsedSidebarSections.agents ? '' : normalAgents.map((agent) => renderAgentListItem(agent)).join('')}
    </div>

    <div class="rail-section">
      ${renderRailSectionTitle('humans', 'Humans', (appState.humans || []).length, { modal: 'human' })}
      ${collapsedSidebarSections.humans ? '' : (appState.humans || []).map((human) => renderHumanListItem(human)).join('')}
    </div>
  `;
}

function renderComputersRail() {
  const computers = appState.computers || [];
  return `
    <div class="rail-section">
      ${renderRailSectionTitle('computers', 'Computers', computers.length, { modal: 'computer' })}
      ${collapsedSidebarSections.computers ? '' : computers.map((computer) => renderComputerListItem(computer)).join('')}
    </div>

    <div class="rail-section">
      ${renderRailSectionTitle('computer-features', 'Feature Entrances', 3)}
      ${collapsedSidebarSections['computer-features'] ? '' : `
        <button class="space-btn computer-feature-entry${activeView === 'computers' ? ' active' : ''}" type="button" data-action="set-view" data-view="computers">
          <span class="channel-icon">PC</span>
          <span class="dm-name">Computer Overview</span>
        </button>
        <button class="space-btn computer-feature-entry${activeView === 'missions' ? ' active' : ''}" type="button" data-action="set-view" data-view="missions">
          <span class="channel-icon">RUN</span>
          <span class="dm-name">Codex Missions</span>
        </button>
        <button class="space-btn computer-feature-entry" type="button" data-action="open-modal" data-modal="computer">
          <span class="channel-icon">+</span>
          <span class="dm-name">Add Computer</span>
        </button>
      `}
    </div>
  `;
}

function renderSettingsRail() {
  const items = settingsNavItems();
  return `
    <nav class="settings-nav-list" aria-label="Settings sections">
      ${items.map((item) => `
        <button class="settings-nav-item${settingsTab === item.id ? ' active' : ''}" type="button" data-action="set-settings-tab" data-tab="${escapeHtml(item.id)}">
          ${settingsIcon(item.icon, 20)}
          <span>${escapeHtml(item.label)}</span>
          ${item.meta ? `<em>${escapeHtml(item.meta)}</em>` : ''}
        </button>
      `).join('')}
    </nav>
  `;
}

function renderLeftRailButton(nav, activeNav, label, icon, badge = '') {
  return `
    <button class="left-rail-btn${activeNav === nav ? ' active' : ''}" type="button" data-action="set-left-nav" data-nav="${escapeHtml(nav)}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">${icon}</svg>
      ${badge ? `<em>${escapeHtml(badge)}</em>` : ''}
    </button>
  `;
}

function renderRailSectionTitle(section, label, count, { modal = '' } = {}) {
  const collapsed = Boolean(collapsedSidebarSections[section]);
  const countLabel = count === undefined || count === null ? '' : `<em>${escapeHtml(count)}</em>`;
  return `
    <div class="rail-title">
      <button class="rail-collapse-btn" type="button" data-action="toggle-sidebar-section" data-section="${escapeHtml(section)}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${escapeHtml(label)}">
        <span aria-hidden="true">${collapsed ? '›' : '⌄'}</span>
      </button>
      <span>${escapeHtml(label)} ${countLabel}</span>
      ${modal ? `<button class="rail-add-btn" type="button" data-action="open-modal" data-modal="${escapeHtml(modal)}">+</button>` : '<span class="rail-title-spacer"></span>'}
    </div>
  `;
}

function settingsNavItems() {
  const fanoutConfigured = appState.settings?.fanoutApi?.configured;
  return [
    { id: 'account', label: 'Account', icon: 'account' },
    { id: 'browser', label: 'Browser', icon: 'browser', meta: notificationStatusLabel() },
    { id: 'server', label: 'Server', icon: 'server', meta: appState.connection?.mode || 'local' },
    { id: 'system', label: 'System Config', icon: 'system', meta: fanoutConfigured ? 'LLM' : 'rules' },
    { id: 'release', label: 'Release Notes', icon: 'release' },
  ];
}

function settingsIcon(name, size = 20) {
  const icons = {
    account: '<path d="M20 21v-2a5 5 0 0 0-5-5H9a5 5 0 0 0-5 5v2"/><circle cx="12" cy="7" r="4"/>',
    browser: '<rect x="3" y="5" width="18" height="14" rx="1"/><path d="M3 9h18"/>',
    server: '<rect x="5" y="3" width="14" height="18" rx="1"/><path d="M9 7h6"/><path d="M9 12h6"/><path d="M9 17h.01"/><path d="M15 17h.01"/>',
    system: '<path d="M4 7h16"/><path d="M4 17h16"/><path d="M8 3v8"/><path d="M16 13v8"/>',
    release: '<path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h5"/><path d="M9 13h6"/><path d="M9 17h6"/>',
    computer: '<rect x="3" y="4" width="18" height="13" rx="1"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  };
  return `<svg class="settings-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="square" stroke-linejoin="miter" aria-hidden="true">${icons[name] || icons.system}</svg>`;
}

function renderNavItem(view, label, icon, badge) {
  const active = activeView === view ? ' active' : '';
  const icons = {
    search: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>',
    message: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M13 8H7"/><path d="M17 12H7"/></svg>',
    file: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14,2 14,8 20,8"/></svg>',
    bookmark: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
    settings: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 3v3"/><path d="M12 18v3"/><path d="M3 12h3"/><path d="M18 12h3"/><path d="M5.6 5.6l2.1 2.1"/><path d="M16.3 16.3l2.1 2.1"/><path d="M18.4 5.6l-2.1 2.1"/><path d="M7.7 16.3l-2.1 2.1"/></svg>',
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
      <span class="dm-avatar-wrap">
        <span class="dm-avatar">${avatar ? `<img src="${escapeHtml(avatar)}" alt="">` : escapeHtml(initials)}</span>
        ${avatarStatusDot(status, 'DM status')}
      </span>
      <span class="dm-name">${escapeHtml(name)}</span>
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

function currentDmPeer() {
  const dm = selectedSpaceType === 'dm' ? currentSpace() : null;
  const participantIds = dm?.participantIds || [];
  const peerId = participantIds.find((id) => id !== 'hum_local') || participantIds[0];
  const agent = byId(appState?.agents, peerId);
  if (agent) return { item: agent, type: 'agent', status: agent.status || 'offline', avatar: agent.avatar };
  const human = byId(appState?.humans, peerId);
  if (human) return { item: human, type: 'human', status: human.status || 'offline', avatar: human.avatar };
  return null;
}

function renderMain() {
  if (activeView === 'tasks') return renderGlobalTasks();
  if (activeView === 'threads') return renderThreads();
  if (activeView === 'saved') return renderSaved();
  if (activeView === 'search') return renderSearch();
  if (activeView === 'missions') return renderMissions();
  if (activeView === 'cloud') return renderCloud();
  if (activeView === 'computers') return renderComputers();
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

function agentReceiptStatus(item) {
  if (item?.status === 'cancelled') return 'cancelled';
  if (item?.respondedAt || item?.status === 'responded' || Number(item?.sendCount || 0) > 0) return 'responded';
  if (item?.deliveredAt || item?.status === 'delivered') return 'delivered';
  return 'queued';
}

function agentReceiptRank(status) {
  return { responded: 4, delivered: 3, queued: 2, cancelled: 1 }[status] || 0;
}

function agentReceiptTime(item) {
  const parsed = Date.parse(item?.deliveredAt || item?.respondedAt || item?.updatedAt || item?.createdAt || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function deliveryReceiptItemsForRecord(record) {
  if (!record?.id || record.authorType !== 'human' || record.authorId !== 'hum_local') return [];
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
    cancelled: 'Stopped',
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
    <article class="message-card slock-message author-${authorClass}${highlighted}${compact}${receiptTray ? ' has-agent-receipts' : ''}" id="message-${escapeHtml(message.id)}" data-message-id="${escapeHtml(message.id)}" data-render-key="${escapeHtml(renderRecordKey(message))}"${agentAuthorAttr}>
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
    <section class="list-panel thread-list-panel slock-thread-list">
      ${threaded.length ? threaded.map((message) => {
        const replies = threadReplies(message.id);
        const lastReply = replies.at(-1);
        const author = displayName(message.authorId);
        const lastReplyAuthor = lastReply ? displayName(lastReply.authorId) : author;
        const task = message.taskId ? byId(appState.tasks, message.taskId) : null;
        const active = threadMessageId === message.id ? ' active' : '';
        return `
        <button class="thread-row slock-thread-row${active}" type="button" data-action="open-thread" data-id="${message.id}">
          <span class="thread-row-avatar">
            ${renderThreadRowAvatar(message)}
          </span>
          <span class="thread-row-main">
            <span class="thread-row-meta-line">
              <span>${escapeHtml(spaceName(message.spaceType, message.spaceId))}</span>
              ${renderThreadKindBadge(message, task)}
              <span>${escapeHtml(author)}</span>
              <time>${fmtTime(lastReply?.createdAt || message.updatedAt || message.createdAt)}</time>
            </span>
            <strong>${escapeHtml(plainMentionText(message.body).slice(0, 120) || '(attachment)')}</strong>
            <small>latest ${escapeHtml(lastReplyAuthor)} · ${message.replyCount || 0} ${(message.replyCount || 0) === 1 ? 'reply' : 'replies'}</small>
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

const searchTimeRangeOptions = [
  ['any', 'Any Time'],
  ['today', 'Today'],
  ['7d', 'Last 7 Days'],
  ['30d', 'Last 30 Days'],
];

function searchTimeRangeLabel() {
  return searchTimeRangeOptions.find(([value]) => value === searchTimeRange)?.[1] || 'Any Time';
}

function renderSearchLensIcon(size = 18) {
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-4.2-4.2"/></svg>`;
}

function renderSearchEntityResult(item, activeKey) {
  const active = activeKey === item.id ? ' active' : '';
  return `
    <button class="search-result-card search-entity-card${active}" type="button" data-action="open-search-entity" data-target-type="${escapeHtml(item.targetType)}" data-target-id="${escapeHtml(item.targetId)}">
      <span class="search-entity-icon">${item.type === 'channel' ? '#' : item.type === 'dm' ? '@' : 'AG'}</span>
      <span class="search-entity-copy">
        <span class="search-result-meta">
          <strong>${escapeHtml(item.label)}</strong>
          <em>${escapeHtml(item.meta)}</em>
        </span>
        <span class="search-result-snippet">${highlightSearchText(item.body, searchQuery)}</span>
      </span>
    </button>
  `;
}

function renderSearchResult(record) {
  const parent = record.parentMessageId ? byId(appState?.messages, record.parentMessageId) : null;
  const task = byId(appState?.tasks, record.taskId || parent?.taskId);
  const isReply = Boolean(parent);
  const snippet = searchSnippet(searchRecordBody(record) || '(attachment)', searchQuery);
  const active = selectedSavedRecordId === record.id ? ' active' : '';
  return `
    <button class="search-result-card${active}" type="button" data-action="open-search-result" data-id="${escapeHtml(record.id)}">
      <span class="search-result-meta">
        <strong>${escapeHtml(recordSpaceName(record))}</strong>
        ${isReply ? '<em>thread</em>' : ''}
        ${task ? renderTaskInlineBadge(task, { showAssignee: false }) : ''}
        <span>${escapeHtml(displayName(record.authorId))}</span>
        <time>${fmtTime(record.createdAt)}</time>
      </span>
      <span class="search-result-snippet">${highlightSearchText(snippet, searchQuery)}</span>
    </button>
  `;
}

function renderSearchEmptyState(kind, query = '') {
  if (kind === 'empty') {
    return `
      <div class="search-center-state">
        <span class="search-center-icon">${renderSearchLensIcon(58)}</span>
        <strong>Search everything</strong>
        <span>Search channels, DIRECT MESSAGES, people, agents, and message history.</span>
      </div>
    `;
  }
  return `
    <div class="search-center-state search-no-results">
      <span class="search-center-icon">${renderSearchLensIcon(58)}</span>
      <strong>No results for "${escapeHtml(query)}"</strong>
      <span>Try different keywords or a shorter phrase.</span>
    </div>
  `;
}

function renderSearchFilters() {
  const filtersActive = searchMineOnly || searchTimeRange !== 'any';
  return `
    <div class="search-filter-row" data-search-filters>
      <button class="search-filter-btn${searchMineOnly ? ' active' : ''}" type="button" data-action="toggle-search-mine">My Messages</button>
      <div class="search-time-filter${searchTimeMenuOpen ? ' open' : ''}">
        <button class="search-filter-btn search-time-btn${searchTimeRange !== 'any' ? ' active cyan' : ''}" type="button" data-action="toggle-search-range-menu" aria-expanded="${searchTimeMenuOpen ? 'true' : 'false'}">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M8 2v4"/><path d="M16 2v4"/><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M3 10h18"/></svg>
          <span>${escapeHtml(searchTimeRangeLabel())}</span>
          <span aria-hidden="true">⌄</span>
        </button>
        ${searchTimeMenuOpen ? `
          <div class="search-time-menu" role="menu">
            ${searchTimeRangeOptions.map(([value, label]) => `
              <button class="${searchTimeRange === value ? 'active' : ''}" type="button" data-action="set-search-range" data-range="${escapeHtml(value)}" role="menuitem">${escapeHtml(label)}</button>
            `).join('')}
          </div>
        ` : ''}
      </div>
      ${filtersActive || searchQuery.trim() ? '<button class="search-clear-all" type="button" data-action="clear-search-all">Clear All</button>' : ''}
    </div>
  `;
}

function renderSearchResults() {
  const query = searchQuery.trim();
  if (!query) return renderSearchEmptyState('empty');

  const entities = searchMineOnly || searchTimeRange !== 'any' ? [] : searchEntityResults(query);
  const messageResults = currentSearchMessageResults();
  const visibleMessages = messageResults.slice(0, searchVisibleCount);
  const total = entities.length + messageResults.length;
  if (!total) {
    return `
      <div class="search-summary">0 results</div>
      ${renderSearchEmptyState('none', query)}
    `;
  }
  return `
    <div class="search-summary">${total} ${total === 1 ? 'result' : 'results'}</div>
    ${entities.length ? `
      <div class="search-section-label">People & Places</div>
      ${entities.map(renderSearchEntityResult).join('')}
    ` : ''}
    ${messageResults.length ? `
      <div class="search-section-label">Messages</div>
      ${visibleMessages.map(renderSearchResult).join('')}
      ${visibleMessages.length < messageResults.length ? `
        <div class="search-load-row">
          <button class="search-load-more" type="button" data-action="load-more-search">Load More</button>
        </div>
      ` : ''}
    ` : ''}
  `;
}

function updateSearchResults() {
  const input = document.getElementById('search-input');
  if (input && input.value !== searchQuery && !searchIsComposing) input.value = searchQuery;
  const container = document.querySelector('[data-search-results]');
  if (container) container.innerHTML = renderSearchResults();
  const filters = document.querySelector('[data-search-filters]');
  if (filters) filters.outerHTML = renderSearchFilters();
  const clearButton = document.querySelector('[data-search-clear]');
  if (clearButton) clearButton.hidden = !searchQuery.trim();
}

function openSearchResult(record) {
  const parent = record.parentMessageId ? byId(appState?.messages, record.parentMessageId) : null;
  const root = parent || record;
  selectedSavedRecordId = record.id;
  selectedAgentId = null;
  selectedTaskId = null;
  selectedProjectFile = null;
  inspectorReturnThreadId = null;
  const opensThread = Boolean(parent || root.replyCount > 0 || root.taskId);
  if (activeView === 'search' && opensThread) {
    threadMessageId = root.id;
    render();
    if (record.parentMessageId) scrollToReply(record.id);
    focusSearchInputEnd();
    return;
  }
  selectedSpaceType = root.spaceType;
  selectedSpaceId = root.spaceId;
  activeView = 'space';
  activeTab = 'chat';
  threadMessageId = opensThread ? root.id : null;
  render();
  scrollToMessage(root.id);
  if (record.parentMessageId) scrollToReply(record.id);
}

function openSearchEntity(targetType, targetId) {
  if (targetType === 'channel' || targetType === 'dm') {
    selectedSpaceType = targetType;
    selectedSpaceId = targetId;
    activeView = 'space';
    activeTab = 'chat';
    threadMessageId = null;
    selectedSavedRecordId = null;
    render();
    scrollPaneToBottom('#message-list', 'auto');
    return;
  }
  if (targetType === 'agent') {
    selectedAgentId = targetId;
    selectedTaskId = null;
    selectedProjectFile = null;
    threadMessageId = null;
    render();
  }
}

function focusSearchInputEnd() {
  const focusInput = () => {
    const input = document.getElementById('search-input');
    if (!input) return false;
    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
    return true;
  };

  focusInput();
  window.requestAnimationFrame(focusInput);
  window.setTimeout(focusInput, 40);
  window.setTimeout(focusInput, 120);
}

function openSearchView() {
  activeView = 'search';
  activeTab = 'chat';
  threadMessageId = null;
  inspectorReturnThreadId = null;
  selectedProjectFile = null;
  selectedAgentId = null;
  selectedTaskId = null;
  render();
  focusSearchInputEnd();
}

function renderSearch() {
  return `
    <section class="search-page">
      <div class="search-topbar">
        <button class="search-top-icon" type="button" aria-label="Search">${renderSearchLensIcon(18)}</button>
        <div class="search-input-shell">
          <input id="search-input" value="${escapeHtml(searchQuery)}" placeholder="Search channels, DIRECT MESSAGES, messages..." autocomplete="off" autofocus />
          <button class="search-clear-btn" type="button" data-action="clear-search-query" data-search-clear aria-label="Clear search" ${searchQuery.trim() ? '' : 'hidden'}>×</button>
        </div>
      </div>
      ${renderSearchFilters()}
      <div class="search-results" data-search-results>
        ${renderSearchResults()}
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

function renderComputers() {
  const computers = appState.computers || [];
  const connected = computers.filter((computer) => computer.status === 'connected').length;
  return `
    <section class="computers-page">
      <header class="settings-page-header">
        <div class="settings-page-heading">
          <div class="settings-page-icon">${settingsIcon('computer', 24)}</div>
          <h2>Computers</h2>
        </div>
        <div class="action-row">
          <button class="primary-btn" type="button" data-action="open-modal" data-modal="computer">Add Computer</button>
        </div>
      </header>
      <div class="settings-section-label">
        ${settingsIcon('computer', 18)}
        <span>LOCAL RUNNERS</span>
      </div>
      <section class="cloud-layout">
        ${renderComputerConfigCard()}
        <div class="pixel-panel cloud-card">
          <div class="panel-title"><span>Feature Entrances</span><span>${connected}/${computers.length || 0} connected</span></div>
          <div class="mode-cards">
            <button class="mode-card active" type="button" data-action="set-view" data-view="computers">
              <strong>Computer Overview</strong>
              <span>Review registered local and remote runners without mixing them into member management.</span>
            </button>
            <button class="mode-card" type="button" data-action="set-view" data-view="missions">
              <strong>Codex Missions</strong>
              <span>Open the local runner history for task-backed Codex runs.</span>
            </button>
            <button class="mode-card" type="button" data-action="open-modal" data-modal="agent">
              <strong>Create Agent</strong>
              <span>Bind a new agent to an available computer and runtime.</span>
            </button>
          </div>
        </div>
      </section>
    </section>
  `;
}

function renderComputerConfigCard() {
  const computers = appState.computers || [];
  return `
    <div class="pixel-panel cloud-card">
      <div class="panel-title"><span>Computers</span><span>${computers.length}</span></div>
      <div class="computer-config-list">
        ${computers.map((computer) => `
          <div class="computer-config-row">
            <strong>${escapeHtml(computer.name || 'Computer')}</strong>
            <span>${escapeHtml(computer.os || 'unknown')} / ${escapeHtml(computer.status || 'offline')}</span>
            <small>${escapeHtml((computer.runtimeIds || []).join(', ') || 'no runtimes')}</small>
          </div>
        `).join('') || '<div class="empty-box small">No computers configured.</div>'}
      </div>
      <button class="secondary-btn" type="button" data-action="open-modal" data-modal="computer">Add Computer</button>
    </div>
  `;
}

function renderFanoutApiConfigCard() {
  const config = appState.settings?.fanoutApi || {};
  const status = config.configured ? 'LLM enabled' : 'Rules fallback';
  return `
    <div class="pixel-panel cloud-card fanout-config-card">
      <form id="fanout-config-form" class="modal-form">
        <div class="panel-title"><span>Fan-out API</span><span>${escapeHtml(status)}</span></div>
        <p class="fanout-api-note">Local rules always route immediately. When a message is ambiguous, this API can add a supplemental LLM route after the rules route has already been delivered.</p>
        <label class="checkline"><input type="checkbox" name="enabled" ${config.enabled ? 'checked' : ''} /> Enable async LLM supplement for ambiguous routing</label>
        <label><span>Base URL</span><input name="baseUrl" value="${escapeHtml(config.baseUrl || '')}" placeholder="https://api.openai.com/v1" /></label>
        <label><span>Model</span><input name="model" value="${escapeHtml(config.model || '')}" placeholder="gpt-5.4-mini-2026-03-17" /></label>
        <label>
          <span>Force LLM Keywords</span>
          <textarea name="forceKeywords" rows="3" placeholder="">${escapeHtml((config.forceKeywords || []).join('\n'))}</textarea>
          <small>Optional. Matching messages still route by rules first, then queue an LLM supplement.</small>
        </label>
        <label>
          <span>API Key</span>
          <input name="apiKey" type="password" autocomplete="off" placeholder="${escapeHtml(config.hasApiKey ? `${config.apiKeyPreview} configured - leave blank to keep` : 'paste API key')}" />
          <small>${escapeHtml(config.hasApiKey ? `Stored key preview: ${config.apiKeyPreview}` : 'No key stored yet.')}</small>
        </label>
        ${config.hasApiKey ? '<label class="checkline"><input type="checkbox" name="clearApiKey" /> Clear saved API key</label>' : ''}
        <button class="primary-btn" type="submit">Save Fan-out API</button>
      </form>
    </div>
  `;
}

function settingsPageMeta(tab = settingsTab) {
  const metas = {
    account: { title: 'Account', icon: 'account', section: 'ACCOUNT' },
    browser: { title: 'Browser', icon: 'browser', section: 'BROWSER' },
    server: { title: 'Server', icon: 'server', section: 'SERVER' },
    system: { title: 'System Config', icon: 'system', section: 'SYSTEM CONFIG' },
    release: { title: 'Release Notes', icon: 'release', section: "WHAT'S NEW" },
  };
  return metas[tab] || metas.account;
}

function renderSettingsChrome(body, actions = '') {
  const meta = settingsPageMeta();
  return `
    <section class="settings-page">
      <header class="settings-page-header">
        <div class="settings-page-heading">
          <div class="settings-page-icon">${settingsIcon(meta.icon, 24)}</div>
          <h2>${escapeHtml(meta.title)}</h2>
        </div>
        ${actions ? `<div class="action-row">${actions}</div>` : ''}
      </header>
      <div class="settings-section-label">
        ${settingsIcon(meta.icon, 18)}
        <span>${escapeHtml(meta.section)}</span>
      </div>
      ${body}
    </section>
  `;
}

function renderAccountSettingsTab() {
  const human = byId(appState.humans, 'hum_local') || appState.humans?.[0] || {};
  const c = appState.connection || {};
  return `
    <section class="settings-layout">
      <div class="pixel-panel cloud-card settings-account-card">
        <div class="settings-account-hero">
          <span class="settings-account-avatar">${escapeHtml(displayAvatar(human.id || 'hum_local', 'human'))}</span>
          <div>
            <strong>${escapeHtml(human.name || 'You')}</strong>
            <small>${escapeHtml(human.email || 'Local MagClaw user')}</small>
          </div>
        </div>
        <div class="cloud-status settings-status-grid">
          <div><span>Name</span><strong>${escapeHtml(human.name || 'You')}</strong><small>${escapeHtml(human.role || 'owner')}</small></div>
          <div><span>Profile</span><strong>${escapeHtml(human.email || 'local user')}</strong><small>${escapeHtml(human.id || 'hum_local')}</small></div>
          <div><span>Workspace</span><strong>${escapeHtml(c.workspaceId || 'local')}</strong><small>${escapeHtml(appState.settings?.defaultWorkspace || '')}</small></div>
          <div><span>Device</span><strong>${escapeHtml(c.deviceName || appState.runtime?.host || 'local')}</strong><small>${escapeHtml(c.deviceId || '')}</small></div>
        </div>
      </div>
      <div class="pixel-panel cloud-card">
        <div class="panel-title"><span>Identity Boundary</span><span>v1</span></div>
        <div class="boundary-grid single">
          <div><strong>Humans</strong><p>Human identity stays in MagClaw state and is used for channels, DMs, notifications, task ownership, and read receipts.</p></div>
          <div><strong>Agents</strong><p>Agents keep isolated workspaces and Codex homes while sharing allowed local skills and MagClaw tools.</p></div>
        </div>
      </div>
    </section>
  `;
}

function renderBrowserSettingsTab() {
  return `
    <section class="settings-layout">
      ${renderNotificationConfigCard()}
      <div class="pixel-panel cloud-card">
        <div class="panel-title"><span>Browser Runtime</span><span>${escapeHtml(browserNotificationPermission())}</span></div>
        <div class="boundary-grid single">
          <div><strong>Background Replies</strong><p>Desktop notifications are browser-controlled and can be turned on or off here without changing agent routing.</p></div>
          <div><strong>Local UI State</strong><p>Collapsed sidebar sections, task boards, settings tabs, and skills panels are saved in browser local storage.</p></div>
        </div>
      </div>
    </section>
  `;
}

function renderServerSettingsTab() {
  const c = appState.connection || {};
  const isCloud = c.mode === 'cloud';
  return `
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
            <span>Use a MagClaw control plane URL for sync while local runner keeps executing Codex.</span>
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
          <div><strong>Synced</strong><p>channels, DMs, messages, replies, tasks, agents, humans, computers, missions, run metadata and attachment metadata.</p></div>
          <div><strong>Local only</strong><p>Codex execution, filesystem access, attachment binaries, shell environment, secrets and process control.</p></div>
          <div><strong>Runtime</strong><p>Chat agents use isolated Codex homes, MagClaw MCP tools, and hidden warmup turns so visible replies can reuse an idle Codex session.</p></div>
        </div>
      </div>
    </section>
  `;
}

function renderSystemSettingsTab() {
  const config = appState.settings?.fanoutApi || {};
  const routerMode = config.configured ? 'llm_fanout' : 'rules_fallback';
  return `
    <section class="cloud-layout">
      ${renderFanoutApiConfigCard()}
      <div class="pixel-panel cloud-card">
        <div class="panel-title"><span>Routing Boundary</span><span>${escapeHtml(routerMode)}</span></div>
        <div class="cloud-status">
          <div><span>Fan-out API</span><strong>${escapeHtml(config.configured ? 'Configured' : 'Rules only')}</strong><small>${escapeHtml(config.model || 'no model')}</small></div>
          <div><span>Endpoint</span><strong>${escapeHtml(config.baseUrl || '--')}</strong><small>${escapeHtml(config.hasApiKey ? `key ${config.apiKeyPreview}` : 'no key stored')}</small></div>
          <div><span>Force Keywords</span><strong>${escapeHtml((config.forceKeywords || []).length)}</strong><small>${escapeHtml((config.forceKeywords || []).join(', ') || 'none')}</small></div>
          <div><span>Delivery</span><strong>Rules first</strong><small>LLM supplements queue only when routing is ambiguous or forced.</small></div>
        </div>
        <div class="boundary-grid single system-boundary-copy">
          <div><strong>Local rules stay immediate</strong><p>Messages still route by deterministic MagClaw rules before an optional LLM supplement is delivered.</p></div>
          <div><strong>Secrets stay server-side</strong><p>The browser only receives a masked API key preview; saved keys are never rendered back into the form.</p></div>
        </div>
      </div>
    </section>
  `;
}

function renderReleaseNotesSettingsTab() {
  const notes = [
    ['NEW', 'Agent skill and tool panels list MagClaw function calls, global Codex skills, plugin skills, and agent-local skills with collapsible sections.'],
    ['IMPROVED', 'Codex chat agents now warm their app-server session in the background, keeping everyday DM replies on the low-latency path after startup.'],
  ];
  return `
    <section class="settings-release">
      <article class="pixel-panel release-card">
        <h3>2026-05-04</h3>
        <div class="release-note-list">
          ${notes.map(([type, text]) => `
            <div class="release-note-row">
              <span class="release-badge release-${type.toLowerCase()}">${escapeHtml(type)}</span>
              <p>${escapeHtml(text)}</p>
            </div>
          `).join('')}
        </div>
      </article>
    </section>
  `;
}

function renderCloud() {
  const c = appState.connection || {};
  const isCloud = c.mode === 'cloud';
  const statusTone = c.pairingStatus === 'paired' ? 'green' : isCloud ? 'amber' : 'blue';
  const body = settingsTab === 'account'
    ? renderAccountSettingsTab()
    : settingsTab === 'browser'
      ? renderBrowserSettingsTab()
      : settingsTab === 'system'
        ? renderSystemSettingsTab()
      : settingsTab === 'release'
        ? renderReleaseNotesSettingsTab()
        : renderServerSettingsTab();
  return renderSettingsChrome(body, `
    ${pill(c.mode || 'local', isCloud ? 'cyan' : 'blue')}
    ${pill(c.pairingStatus || 'local', statusTone)}
  `);
}

function renderInspector() {
  const thread = threadMessageId ? byId(appState.messages, threadMessageId) : null;
  if (thread) return renderThreadDrawer(thread);

  if (selectedProjectFile) return renderProjectFilePreview();

  if (selectedAgentId) {
    const agent = byId(appState.agents, selectedAgentId);
    if (agent) return renderAgentDetail(agent);
  }

  if (selectedTaskId) {
    const task = byId(appState.tasks, selectedTaskId);
    if (task) return renderTaskDetail(task);
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
  if (!selectedAgentWorkspaceFile || selectedAgentWorkspaceFile.agentId !== agent.id) {
    return `
      <div class="agent-workspace-preview empty">
        <div class="empty-box small">Select a file to preview.</div>
      </div>
    `;
  }
  const key = agentWorkspaceKey(agent.id, selectedAgentWorkspaceFile.path);
  const preview = agentWorkspaceFilePreviews[key] || { loading: true };
  const file = preview.file;
  const mode = agentWorkspacePreviewMode === 'preview' ? 'preview' : 'raw';
  const showPreview = file?.previewKind === 'markdown' && agentWorkspacePreviewMode === 'preview';
  return `
    <div class="agent-workspace-preview">
      <div class="agent-workspace-filebar">
        <span>${file ? escapeHtml(file.path) : 'File Preview'}</span>
        <div class="agent-workspace-file-actions">
          ${file?.previewKind === 'markdown' ? `
            <button type="button" class="${mode === 'raw' ? 'active' : ''}" data-action="set-agent-workspace-preview-mode" data-mode="raw">Raw</button>
            <button type="button" class="${mode === 'preview' ? 'active' : ''}" data-action="set-agent-workspace-preview-mode" data-mode="preview">Preview</button>
          ` : ''}
          <button type="button" data-action="close-agent-workspace-file">×</button>
        </div>
      </div>
      ${preview.loading ? '<div class="empty-box small">Loading file...</div>' : ''}
      ${preview.error ? `<div class="empty-box small error">${escapeHtml(preview.error)}</div>` : ''}
      ${file ? `
        <div class="file-preview-meta">
          <strong title="${escapeHtml(file.absolutePath)}">${escapeHtml(file.name)}</strong>
          <small>${escapeHtml(file.absolutePath)} / ${bytes(file.bytes)}</small>
        </div>
        ${showPreview
          ? `<div class="markdown-preview">${renderMarkdown(file.content || '')}</div>`
          : file.previewKind === 'markdown' || file.previewKind === 'text'
            ? `<pre class="text-file-preview"><code>${escapeHtml(file.content || '')}</code></pre>`
            : '<div class="empty-box small">This file type cannot be previewed as text yet.</div>'}
      ` : ''}
    </div>
  `;
}

function renderAgentWorkspaceTab(agent) {
  const rootKey = agentWorkspaceKey(agent.id, '');
  const tree = agentWorkspaceTreeCache[rootKey];
  return `
    <div class="agent-workspace-tab">
      <div class="agent-workspace-path">
        <code>${escapeHtml(agent.workspacePath || agent.workspace || '--')}</code>
        <button type="button" data-action="refresh-agent-workspace" data-agent-id="${escapeHtml(agent.id)}">Refresh</button>
      </div>
      <div class="agent-workspace-layout">
        <aside class="agent-workspace-sidebar">
          <div class="agent-workspace-sidebar-title">
            <span>Workspace</span>
            <button type="button" data-action="refresh-agent-workspace" data-agent-id="${escapeHtml(agent.id)}">↻</button>
          </div>
          ${tree ? renderAgentWorkspaceTree(agent, '', 0) : '<div class="project-tree-note">Loading workspace...</div>'}
        </aside>
        <section class="agent-workspace-viewer">
          ${renderAgentWorkspacePreview(agent)}
        </section>
      </div>
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

function agentStatusLabel(agent) {
  const status = agent?.status || 'offline';
  return `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}

function shouldCelebrateAgentBorn(value, today = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf()) || Number.isNaN(today.valueOf())) return false;
  return date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate()
    && date.getFullYear() !== today.getFullYear();
}

function formatAgentBorn(value) {
  if (!value) return '--';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '--';
  const formatted = date.toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  return `${shouldCelebrateAgentBorn(date) ? '🎂 ' : ''}${formatted}`;
}

function renderAgentDetailTabs() {
  const tabs = [
    ['profile', 'Profile'],
    ['skills', 'Skills'],
    ['dms', 'Agent DIRECT MESSAGES'],
    ['reminders', 'Reminders'],
    ['workspace', 'Workspace'],
    ['activity', 'Activity'],
  ];
  return `
    <div class="agent-detail-tabs" role="tablist">
      ${tabs.map(([id, label]) => `
        <button type="button" class="${agentDetailTab === id ? 'active' : ''}" data-action="set-agent-detail-tab" data-tab="${id}">${escapeHtml(label)}</button>
      `).join('')}
    </div>
  `;
}

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
        <label class="secondary-btn file-btn">
          Upload
          <input class="visually-hidden agent-avatar-upload" type="file" accept="image/*" data-action="upload-agent-avatar" data-id="${escapeHtml(agent.id)}" />
        </label>
      </div>
    </section>
  `;
}

function renderAgentInfoSection(agent) {
  const computer = byId(appState.computers, agent.computerId);
  const reasoningOptions = agentReasoningOptions(agent);
  return `
    <section class="agent-profile-field agent-info-section">
      <span class="detail-label">Info</span>
      <div class="agent-computer-line">
        <span class="agent-info-caption">Computer</span>
        <strong>${escapeHtml(computer?.name || agent.computerId || '--')}</strong>
        <span class="avatar-status-dot inline ${presenceClass(computer?.status || 'offline')}"></span>
        <small>${escapeHtml(computer?.status || 'Disconnected')}</small>
      </div>
      <div class="agent-info-grid">
        <div>
          <span class="agent-info-caption">Runtime</span>
          <span class="runtime-badge">${escapeHtml(agent.runtime || '--')}</span>
        </div>
        <label>
          <span class="agent-info-caption">Model</span>
          <select class="agent-auto-select model-select" data-action="update-agent-model" data-agent-id="${escapeHtml(agent.id)}">
            ${agentModelOptions(agent)}
          </select>
        </label>
        ${reasoningOptions ? `
        <label>
          <span class="agent-info-caption">Reasoning</span>
          <select class="agent-auto-select reasoning-select" data-action="update-agent-reasoning" data-agent-id="${escapeHtml(agent.id)}">
            ${agentReasoningOptions(agent)}
          </select>
        </label>
        ` : ''}
        <div>
          <span class="agent-info-caption">Born</span>
          <strong>${escapeHtml(formatAgentBorn(agent.createdAt))}</strong>
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

function renderSkillChips(skills = [], { limit = 10 } = {}) {
  const visible = skills.slice(0, limit);
  if (!visible.length) return '<span class="muted">No skills found</span>';
  return `
    <div class="skill-chip-row">
      ${visible.map((skill) => `<span class="skill-chip" title="${escapeHtml(skill.path || '')}">${escapeHtml(skill.name || 'skill')}</span>`).join('')}
      ${skills.length > visible.length ? `<span class="skill-chip muted">+${skills.length - visible.length}</span>` : ''}
    </div>
  `;
}

function renderAgentCapabilitiesSection(agent) {
  const skills = agentSkillsFor(agent);
  return `
    <section class="agent-profile-field agent-capabilities-section">
      <div class="agent-field-head">
        <span class="detail-label">Function Calls / Tools</span>
        <button class="agent-edit-pencil" type="button" data-action="refresh-agent-skills" data-agent-id="${escapeHtml(agent.id)}" aria-label="Rescan skills and tools" title="Rescan skills and tools">${refreshIcon()}</button>
      </div>
      ${skills?.loading ? '<div class="agent-field-value muted">Loading tools...</div>' : renderAgentToolCapsules(skills?.tools || [])}
    </section>
    <section class="agent-profile-field agent-capabilities-section">
      <span class="detail-label">Skills</span>
      ${skills?.error ? `<div class="agent-field-value error-text">${escapeHtml(skills.error)}</div>` : ''}
      ${skills?.loading ? '<div class="agent-field-value muted">Scanning skills...</div>' : `
        <div class="agent-skill-summary-grid">
          <div><strong>Agent</strong>${renderSkillChips(skills?.workspace || [], { limit: 6 })}</div>
          <div><strong>Global</strong>${renderSkillChips([...(skills?.global || []), ...(skills?.plugin || [])], { limit: 10 })}</div>
        </div>
      `}
    </section>
  `;
}

function renderSkillList(title, skills = [], empty = 'No skills found.', sectionKey = title.toLowerCase().replace(/[^a-z0-9]+/g, '-')) {
  const collapsed = Boolean(collapsedSkillSections[sectionKey]);
  return `
    <section class="skill-list-section">
      <div class="skill-list-title">
        <button class="skill-collapse-btn" type="button" data-action="toggle-agent-skill-section" data-section="${escapeHtml(sectionKey)}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${escapeHtml(title)}">
          <span aria-hidden="true">${collapsed ? '›' : '⌄'}</span>
        </button>
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
          <button class="skill-collapse-btn" type="button" data-action="toggle-agent-skill-section" data-section="magclaw-tools" aria-label="${collapsedSkillSections['magclaw-tools'] ? 'Expand' : 'Collapse'} MagClaw Function Calls">
            <span aria-hidden="true">${collapsedSkillSections['magclaw-tools'] ? '›' : '⌄'}</span>
          </button>
          <span>MagClaw Function Calls</span>
          <em>${(skills.tools || []).length}</em>
        </div>
        ${collapsedSkillSections['magclaw-tools'] ? '' : renderAgentToolCapsules(skills.tools || [])}
      </section>
      ${renderSkillList('Agent-Isolated Skills', skills.workspace || [], 'No agent-local skills installed yet.', 'agent-skills')}
      ${renderSkillList('Global Codex Skills', skills.global || [], 'No global Codex skills found.', 'global-skills')}
      ${renderSkillList('Plugin Skills', skills.plugin || [], 'No plugin skills found.', 'plugin-skills')}
    </div>
  `;
}

function renderAgentProfileTab(agent) {
  return `
    <div class="agent-profile-tab">
      <div class="agent-profile-hero">
        <span class="agent-detail-avatar-frame hero-avatar">${getAvatarHtml(agent.id, 'agent', 'agent-detail-avatar-preview')}</span>
        <div>
          <h3>${escapeHtml(agent.name)}</h3>
          <p><span class="avatar-status-dot inline ${presenceClass(agent.status)}"></span>${escapeHtml(agentStatusLabel(agent))} <span>${escapeHtml(agentHandle(agent))}</span></p>
        </div>
      </div>
      ${renderAgentAvatarEditor(agent)}
      ${renderAgentInlineField(agent, 'name', 'Display Name', { placeholder: 'Display name' })}
      ${renderAgentInlineField(agent, 'description', 'Description', { multiline: true, placeholder: 'Describe this agent...' })}
      ${renderAgentInfoSection(agent)}
      ${renderAgentCapabilitiesSection(agent)}
      ${renderAgentEnvVarsSection(agent)}
      <section class="agent-profile-field agent-actions-section">
        <span class="detail-label">Actions</span>
        <div class="agent-detail-actions">
          <button class="secondary-btn disabled-action" type="button" data-action="agent-stop-unavailable" data-id="${escapeHtml(agent.id)}" aria-disabled="true">Stop Agent</button>
          ${agentIsRunning(agent)
            ? `<button class="secondary-btn" type="button" data-action="open-agent-restart" data-id="${escapeHtml(agent.id)}">Restart / Reset</button>`
            : `<button class="secondary-btn" type="button" data-action="start-agent" data-id="${escapeHtml(agent.id)}">Start Agent</button>`}
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
              : `<button class="secondary-btn" type="button" data-action="start-agent" data-id="${escapeHtml(agent.id)}">Start Agent</button>`}
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
  const status = agent.status;
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

function renderHumanListItem(human) {
  return `
    <div class="space-btn member-btn">
      <span class="dm-avatar-wrap">
        <span class="dm-avatar">${escapeHtml(displayAvatar(human.id, 'human'))}</span>
      </span>
      <div class="member-info">
        <span class="dm-name">${escapeHtml(human.name)}</span>
      </div>
      <span class="member-status-side">${avatarStatusDot(human.status, 'Human status')}</span>
    </div>
  `;
}

function renderComputerListItem(computer) {
  return `
    <div class="space-btn member-btn">
      <span class="dm-avatar-wrap">
        <span class="dm-avatar">PC</span>
      </span>
      <div class="member-info">
        <span class="dm-name">${escapeHtml(computer.name)}</span>
      </div>
      <span class="member-status-side">${avatarStatusDot(computer.status, 'Computer status')}</span>
    </div>
  `;
}

function renderReply(reply) {
  const authorClass = ['agent', 'human', 'system'].includes(reply.authorType) ? reply.authorType : 'unknown';
  const agentAuthorAttr = reply.authorType === 'agent' ? ` data-agent-author-id="${escapeHtml(reply.authorId)}"` : '';
  const highlighted = selectedSavedRecordId === reply.id ? ' highlighted' : '';
  const receiptTray = renderAgentReceiptTray(reply);
  const footer = renderMessageFooter({ receiptTray });
  return `
    <article class="message-card slock-message reply-card author-${authorClass}${highlighted}${receiptTray ? ' has-agent-receipts' : ''}" id="reply-${escapeHtml(reply.id)}" data-reply-id="${escapeHtml(reply.id)}" data-render-key="${escapeHtml(renderRecordKey(reply))}"${agentAuthorAttr}>
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
  return !isBrainAgent(agent) && !['offline', 'error'].includes(String(agent?.status || '').toLowerCase());
}

function isBrainAgent(agent) {
  return Boolean(agent?.isBrain || String(agent?.systemRole || '').toLowerCase() === 'brain');
}

function channelAssignableAgents() {
  return (appState.agents || []).filter((agent) => !isBrainAgent(agent));
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
    forceKeywords: data?.get('forceKeywords') ?? current.forceKeywords ?? [],
    clearApiKey: data ? Boolean(data.get('clearApiKey')) : false,
  };
  if (apiKey) payload.apiKey = apiKey;
  return payload;
}

async function refreshState() {
  rememberPinnedBottomBeforeStateChange();
  const nextState = await api('/api/state');
  trackFanoutRouteEvents(nextState, { silent: !initialLoadComplete || !appState });
  trackAgentNotifications(nextState, { silent: !initialLoadComplete || !appState });
  appState = nextState;
  render();
  maybeWarmCurrentAgent();
}

function htmlToElement(html) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content.firstElementChild;
}

function syncRecordList(container, records, renderRecord, datasetName, emptyHtml) {
  if (!container) return false;
  if (!records.length) {
    if (container.innerHTML.trim() !== emptyHtml.trim()) {
      container.innerHTML = emptyHtml;
    }
    return true;
  }

  const wantedIds = new Set(records.map((record) => record.id));
  for (const child of [...container.children]) {
    const id = child.dataset?.[datasetName];
    if (!id || !wantedIds.has(id)) child.remove();
  }

  records.forEach((record, index) => {
    let node = [...container.children].find((child) => child.dataset?.[datasetName] === record.id);
    const key = renderRecordKey(record);
    if (!node || node.dataset.renderKey !== key) {
      const next = htmlToElement(renderRecord(record));
      if (!next) return;
      if (node) {
        node.replaceWith(next);
      } else {
        container.insertBefore(next, container.children[index] || null);
      }
      node = next;
    }
    if (container.children[index] !== node) {
      container.insertBefore(node, container.children[index] || null);
    }
  });
  return true;
}

function patchRailSurface() {
  const rail = document.querySelector('.collab-rail');
  if (rail) rail.replaceWith(htmlToElement(renderRail()));
}

function patchThreadParentCard(message) {
  const card = document.querySelector('.thread-parent-card');
  const current = card?.firstElementChild;
  if (!card || !message) return false;
  const key = renderRecordKey(message);
  if (!current || current.dataset.renderKey !== key) {
    const next = htmlToElement(renderMessage(message, { compact: true }));
    if (next) card.replaceChildren(next);
  }
  return true;
}

function patchThreadTaskLifecycle(card, task) {
  const current = document.querySelector('.thread-context .task-lifecycle');
  if (!task) {
    if (current) current.remove();
    return true;
  }
  const next = htmlToElement(renderTaskLifecycle(task));
  if (!next) return false;
  if (current) {
    if (current.outerHTML !== next.outerHTML) current.replaceWith(next);
    return true;
  }
  if (card) card.insertAdjacentElement('afterend', next);
  return true;
}

function patchThreadReplyList(context, replies) {
  let list = context.querySelector('.reply-list');
  if (!replies.length) {
    if (list) list.remove();
    return true;
  }
  if (!list) {
    const divider = context.querySelector('.thread-reply-divider');
    list = document.createElement('div');
    list.className = 'reply-list';
    divider?.insertAdjacentElement('afterend', list);
  }
  return syncRecordList(list, replies, renderReply, 'replyId', '');
}

function patchActiveThreadSurface(scrollSnapshot) {
  if (modal || activeView !== 'space' || activeTab !== 'chat') return false;
  if (!threadMessageId || selectedProjectFile || selectedAgentId || selectedTaskId) return false;
  const message = byId(appState.messages, threadMessageId);
  const context = document.querySelector('#thread-context');
  const panel = document.querySelector('.thread-drawer');
  if (!message || !context || !panel) return false;

  const replies = threadReplies(message.id);
  const task = message.taskId ? byId(appState.tasks, message.taskId) : null;
  const replyWord = replies.length === 1 ? 'reply' : 'replies';
  const replyCountText = `${replies.length} ${replyWord}`;
  const card = context.querySelector('.thread-parent-card');

  patchThreadParentCard(message);
  patchThreadTaskLifecycle(card, task);
  const dividerCount = context.querySelector('.thread-reply-divider strong');
  if (dividerCount) dividerCount.textContent = replyCountText;
  patchThreadReplyList(context, replies);

  const tools = panel.querySelector('.thread-tools');
  if (tools) {
    tools.innerHTML = `
      <span>${escapeHtml(replyCountText)}</span>
      ${task ? renderTaskInlineBadge(task, { showAssignee: false }) : ''}
    `;
  }

  const list = document.querySelector('#message-list');
  if (list) {
    const emptyHtml = selectedSpaceType === 'dm'
      ? '<div class="dm-empty-state">No messages yet. Start the conversation!</div>'
      : '<div class="empty-box">No messages here yet.</div>';
    syncRecordList(list, spaceMessages(), renderMessage, 'messageId', emptyHtml);
  }
  patchRailSurface();
  window.requestAnimationFrame(() => restorePaneScrolls(scrollSnapshot));
  return true;
}

function patchActiveConversationSurface(scrollSnapshot) {
  if (modal || activeView !== 'space' || activeTab !== 'chat') return false;
  if (threadMessageId || selectedProjectFile || selectedAgentId || selectedTaskId) return false;
  const list = document.querySelector('#message-list');
  const panel = document.querySelector('.chat-panel');
  if (!list || !panel) return false;

  const emptyHtml = selectedSpaceType === 'dm'
    ? '<div class="dm-empty-state">No messages yet. Start the conversation!</div>'
    : '<div class="empty-box">No messages here yet.</div>';
  syncRecordList(list, spaceMessages(), renderMessage, 'messageId', emptyHtml);
  patchRailSurface();
  window.requestAnimationFrame(() => restorePaneScrolls(scrollSnapshot));
  return true;
}

function applyStateUpdate(nextState) {
  trackFanoutRouteEvents(nextState, { silent: !initialLoadComplete });
  trackAgentNotifications(nextState, { silent: !initialLoadComplete });
  const scrollSnapshot = {
    main: paneScrollSnapshot('main'),
    thread: paneScrollSnapshot('thread'),
  };
  const selectionBefore = `${selectedSpaceType}:${selectedSpaceId}`;
  rememberPinnedBottomBeforeStateChange();
  appState = nextState;
  if (modal) return;
  ensureSelection();
  const selectionChanged = selectionBefore !== `${selectedSpaceType}:${selectedSpaceId}`;
  if (selectionChanged) {
    render();
    return;
  }
  if (patchActiveThreadSurface(scrollSnapshot)) return;
  if (patchActiveConversationSurface(scrollSnapshot)) return;
  render();
}

function applyRunEventUpdate(incoming) {
  if (!appState || appState.events.some((item) => item.id === incoming.id)) return;
  const scrollSnapshot = {
    main: paneScrollSnapshot('main'),
    thread: paneScrollSnapshot('thread'),
  };
  rememberPinnedBottomBeforeStateChange();
  appState.events.push(incoming);
  if (modal) return;
  if (patchActiveThreadSurface(scrollSnapshot)) return;
  if (patchActiveConversationSurface(scrollSnapshot)) return;
  render();
}

function applyPresenceHeartbeat(heartbeat) {
  if (!appState || !Array.isArray(heartbeat?.agents)) return;
  const incomingById = new Map(heartbeat.agents.map((agent) => [agent.id, agent]));
  let changed = false;
  const agents = (appState.agents || []).map((agent) => {
    const incoming = incomingById.get(agent.id);
    if (!incoming) return agent;
    const next = {
      ...agent,
      status: incoming.status || agent.status,
      runtimeLastStartedAt: incoming.runtimeLastStartedAt || agent.runtimeLastStartedAt || null,
      runtimeLastTurnAt: incoming.runtimeLastTurnAt || agent.runtimeLastTurnAt || null,
      runtimeWarmAt: incoming.runtimeWarmAt || agent.runtimeWarmAt || null,
    };
    if (
      next.status !== agent.status
      || next.runtimeLastStartedAt !== agent.runtimeLastStartedAt
      || next.runtimeLastTurnAt !== agent.runtimeLastTurnAt
      || next.runtimeWarmAt !== agent.runtimeWarmAt
    ) {
      changed = true;
    }
    return next;
  });
  if (!changed) return;
  applyStateUpdate({
    ...appState,
    agents,
    updatedAt: heartbeat.updatedAt || appState.updatedAt,
  });
}

function connectEvents() {
  const source = new EventSource('/api/events');
  source.addEventListener('state', (event) => {
    applyStateUpdate(JSON.parse(event.data));
  });
  source.addEventListener('run-event', (event) => {
    const incoming = JSON.parse(event.data);
    applyRunEventUpdate(incoming);
  });
  source.addEventListener('heartbeat', (event) => {
    applyPresenceHeartbeat(JSON.parse(event.data));
  });
}

document.addEventListener('scroll', (event) => {
  if (event.target?.id === 'message-list') {
    updateBackBottomVisibility('main');
    persistPaneScroll('main', event.target);
  }
  if (event.target?.id === 'thread-context') {
    updateBackBottomVisibility('thread');
    persistPaneScroll('thread', event.target);
  }
}, true);

window.addEventListener('focus', () => {
  windowFocused = true;
});

window.addEventListener('blur', () => {
  windowFocused = false;
});

document.addEventListener('visibilitychange', () => {
  windowFocused = document.visibilityState === 'visible' && document.hasFocus();
});

document.addEventListener('compositionstart', (event) => {
  if (event.target?.id === 'search-input') {
    searchIsComposing = true;
  }
  if (event.target?.closest?.('textarea[data-mention-input]')) {
    composerIsComposing = true;
  }
});

document.addEventListener('compositionend', (event) => {
  if (event.target?.id === 'search-input') {
    searchIsComposing = false;
    searchQuery = event.target.value;
    searchVisibleCount = SEARCH_PAGE_SIZE;
    updateSearchResults();
  }
  if (event.target?.closest?.('textarea[data-mention-input]')) {
    composerIsComposing = false;
  }
});

document.addEventListener('keydown', async (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key?.toLowerCase() === 'k') {
    event.preventDefault();
    openSearchView();
    return;
  }

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
  if (textarea && isImeComposing(event)) return;

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
  const cropStage = event.target.closest('.avatar-crop-stage');
  if (cropStage && avatarCropState) {
    event.preventDefault();
    cropStage.setPointerCapture?.(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const startOffsetX = avatarCropState.offsetX;
    const startOffsetY = avatarCropState.offsetY;
    const onPointerMove = (moveEvent) => {
      avatarCropState.offsetX = startOffsetX + (moveEvent.clientX - startX);
      avatarCropState.offsetY = startOffsetY + (moveEvent.clientY - startY);
      clampAvatarCropOffset();
      updateAvatarCropPreview();
    };
    const finish = () => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', finish);
      document.removeEventListener('pointercancel', finish);
    };
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
    return;
  }

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
  if (event.target.matches?.('[data-action="avatar-crop-scale"]') && avatarCropState) {
    avatarCropState.scale = clampAvatarCropScale(event.target.value);
    clampAvatarCropOffset();
    updateAvatarCropPreview();
    return;
  }

  if (event.target.matches?.('[data-agent-description-input]')) {
    const count = event.target.closest('.agent-inline-edit')?.querySelector('[data-agent-description-count]');
    if (count) count.textContent = `${event.target.value.length}/3000`;
    return;
  }

  const agentEnvIndex = event.target.dataset.agentEnvIndex;
  const agentEnvField = event.target.dataset.agentEnvField;
  if (agentEnvIndex !== undefined && agentEnvField && agentEnvEditState?.items) {
    const idx = parseInt(agentEnvIndex, 10);
    if (!Number.isNaN(idx) && agentEnvEditState.items[idx]) {
      agentEnvEditState.items[idx][agentEnvField] = event.target.value;
    }
    return;
  }

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
    searchVisibleCount = SEARCH_PAGE_SIZE;
    if (!searchIsComposing && !event.isComposing && event.inputType !== 'insertCompositionText') {
      updateSearchResults();
    }
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

  if (event.target.id === 'create-channel-member-search') {
    createChannelMemberSearchQuery = event.target.value;
    render();
    const input = document.querySelector('#create-channel-member-search');
    input?.focus();
    input?.setSelectionRange(createChannelMemberSearchQuery.length, createChannelMemberSearchQuery.length);
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

  const target = event.target;
  if (target.dataset?.action === 'update-agent-model') {
    await api(`/api/agents/${encodeURIComponent(target.dataset.agentId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ model: target.value || null }),
    }).then(() => toast('Model updated')).catch((error) => toast(error.message));
    await refreshState().catch(() => {});
    return;
  }

  if (target.dataset?.action === 'update-agent-reasoning') {
    await api(`/api/agents/${encodeURIComponent(target.dataset.agentId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ reasoningEffort: target.value || null }),
    }).then(() => toast('Reasoning updated')).catch((error) => toast(error.message));
    await refreshState().catch(() => {});
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
  // Handle agent receipt popover toggle (Feishu-style click to open/close)
  const receiptButton = event.target.closest('[data-action="toggle-receipt-popover"]');
  const receiptTrigger = event.target.closest('.agent-receipt-trigger');
  const receiptPopover = event.target.closest('.agent-receipt-popover');

  if (receiptButton) {
    event.preventDefault();
    event.stopPropagation();
    const trigger = receiptButton.closest('.agent-receipt-trigger');
    if (trigger) {
      const isOpen = trigger.classList.contains('popover-open');
      // Close any other open popovers
      document.querySelectorAll('.agent-receipt-trigger.popover-open').forEach((el) => {
        el.classList.remove('popover-open');
      });
      // Toggle this one
      if (!isOpen) {
        trigger.classList.add('popover-open');
        activeReceiptPopover = trigger;
      } else {
        activeReceiptPopover = null;
      }
    }
    return;
  }

  // Click inside popover - keep it open but allow clicking items
  if (receiptPopover) {
    // Don't close on clicks inside the popover content
    return;
  }

  // Click outside any receipt trigger/popover - close active popover
  if (activeReceiptPopover && !receiptTrigger) {
    activeReceiptPopover.classList.remove('popover-open');
    activeReceiptPopover = null;
  }

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

  const clickedTaskChannelFilter = event.target.closest('.task-channel-filter');
  const clickedSearchFilter = event.target.closest('.search-time-filter');
  const target = event.target.closest('[data-action]');
  if (taskChannelMenuOpen && !clickedTaskChannelFilter) {
    taskChannelMenuOpen = false;
    if (!target) {
      render();
      return;
    }
  }
  if (searchTimeMenuOpen && !clickedSearchFilter) {
    searchTimeMenuOpen = false;
    if (activeView === 'search') {
      updateSearchResults();
      if (!target) return;
    }
  }
  if (!target) return;
  const action = target.dataset.action;
  if (action === 'none') return;
  const localOnlyActions = new Set([
    'set-view',
    'set-settings-tab',
    'set-rail-tab',
    'toggle-sidebar-section',
    'select-agent',
    'close-agent-detail',
    'set-agent-detail-tab',
    'toggle-agent-skill-section',
    'edit-agent-field',
    'cancel-agent-field',
    'update-agent-model',
    'update-agent-reasoning',
    'edit-agent-env',
    'cancel-agent-env',
    'add-agent-env-var',
    'remove-agent-env-var',
    'avatar-crop-zoom-in',
    'avatar-crop-zoom-out',
    'avatar-crop-reset',
    'avatar-crop-scale',
    'set-agent-workspace-preview-mode',
    'refresh-agent-workspace',
    'select-space',
    'set-tab',
    'task-filter',
    'set-task-view',
    'toggle-search-mine',
    'toggle-search-range-menu',
    'set-search-range',
    'clear-search-query',
    'clear-search-all',
    'load-more-search',
    'enable-agent-notifications',
    'disable-agent-notifications',
    'dismiss-agent-notifications',
    'toggle-task-channel-menu',
    'toggle-task-channel-filter',
    'clear-task-channel-filters',
    'toggle-task-column',
    'select-task',
    'close-task-detail',
    'open-modal',
    'close-modal',
    'open-thread',
    'open-search-result',
    'open-search-entity',
    'open-saved-message',
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
    'start-agent',
    'open-agent-restart',
    'select-agent-restart-mode',
    'upload-agent-avatar',
    'toggle-receipt-popover',
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
    try {
      await api(`/api/agents/${encodeURIComponent(target.dataset.id || selectedAgentId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ avatar }),
      });
      toast('Avatar updated');
      await refreshState().catch(() => {});
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (action === 'avatar-crop-zoom-in' && avatarCropState) {
    avatarCropState.scale = clampAvatarCropScale(avatarCropState.scale + 0.15);
    clampAvatarCropOffset();
    render();
    return;
  }
  if (action === 'avatar-crop-zoom-out' && avatarCropState) {
    avatarCropState.scale = clampAvatarCropScale(avatarCropState.scale - 0.15);
    clampAvatarCropOffset();
    render();
    return;
  }
  if (action === 'avatar-crop-reset' && avatarCropState) {
    avatarCropState.scale = 1;
    avatarCropState.offsetX = 0;
    avatarCropState.offsetY = 0;
    clampAvatarCropOffset();
    render();
    return;
  }
  if (action === 'enable-agent-notifications') {
    await enableAgentNotifications();
    return;
  }
  if (action === 'disable-agent-notifications') {
    disableAgentNotifications();
    return;
  }
  if (action === 'dismiss-agent-notifications') {
    dismissAgentNotifications();
    return;
  }
  try {
    if (action === 'set-view') {
      activeView = target.dataset.view;
      if (activeView === 'cloud') railTab = 'settings';
      if (activeView === 'computers' || activeView === 'missions') railTab = 'computers';
      if (activeView === 'tasks' || activeView === 'threads' || activeView === 'saved' || activeView === 'search') railTab = 'spaces';
      localStorage.setItem('railTab', railTab);
      threadMessageId = null;
      inspectorReturnThreadId = null;
      selectedProjectFile = null;
      selectedAgentId = null;
      selectedTaskId = null;
      selectedSavedRecordId = null;
      render();
      if (activeView === 'search') focusSearchInputEnd();
    }
    if (action === 'set-settings-tab') {
      settingsTab = target.dataset.tab || 'account';
      activeView = 'cloud';
      railTab = 'settings';
      localStorage.setItem('railTab', railTab);
      render();
    }
    if (action === 'toggle-sidebar-section') {
      toggleSidebarSection(target.dataset.section || '');
      render();
    }
    if (action === 'toggle-search-mine') {
      searchMineOnly = !searchMineOnly;
      searchVisibleCount = SEARCH_PAGE_SIZE;
      updateSearchResults();
      focusSearchInputEnd();
    }
    if (action === 'toggle-search-range-menu') {
      searchTimeMenuOpen = !searchTimeMenuOpen;
      updateSearchResults();
      focusSearchInputEnd();
    }
    if (action === 'set-search-range') {
      searchTimeRange = target.dataset.range || 'any';
      searchTimeMenuOpen = false;
      searchVisibleCount = SEARCH_PAGE_SIZE;
      updateSearchResults();
      focusSearchInputEnd();
    }
    if (action === 'clear-search-query') {
      searchQuery = '';
      searchVisibleCount = SEARCH_PAGE_SIZE;
      updateSearchResults();
      focusSearchInputEnd();
    }
    if (action === 'clear-search-all') {
      searchQuery = '';
      searchMineOnly = false;
      searchTimeRange = 'any';
      searchTimeMenuOpen = false;
      searchVisibleCount = SEARCH_PAGE_SIZE;
      updateSearchResults();
      focusSearchInputEnd();
    }
    if (action === 'load-more-search') {
      searchVisibleCount += SEARCH_PAGE_SIZE;
      updateSearchResults();
      focusSearchInputEnd();
    }
    if (action === 'set-rail-tab') {
      railTab = target.dataset.railTab;
      localStorage.setItem('railTab', railTab);
      if (railTab === 'spaces') {
        selectedAgentId = null;
      }
      selectedTaskId = null;
      render();
    }
    if (action === 'set-left-nav') {
      const nav = target.dataset.nav || 'chat';
      if (nav === 'chat') {
        railTab = 'spaces';
        activeView = 'space';
        selectedAgentId = null;
      } else if (nav === 'tasks') {
        railTab = 'spaces';
        activeView = 'tasks';
        selectedAgentId = null;
      } else if (nav === 'members') {
        railTab = 'members';
        activeView = 'space';
        if (!selectedAgentId && channelAssignableAgents()[0]) {
          selectedAgentId = channelAssignableAgents()[0].id;
          loadAgentSkills(selectedAgentId).catch((error) => toast(error.message));
        }
      } else if (nav === 'desktop') {
        railTab = 'computers';
        activeView = 'computers';
        selectedAgentId = null;
      } else if (nav === 'settings') {
        railTab = 'settings';
        activeView = 'cloud';
        selectedAgentId = null;
      }
      localStorage.setItem('railTab', railTab);
      selectedTaskId = null;
      render();
    }
    if (action === 'select-agent') {
      if (!installedRuntimes.length) await loadInstalledRuntimes();
      if (threadMessageId) inspectorReturnThreadId = threadMessageId;
      selectedAgentId = target.dataset.id;
      agentDetailTab = 'profile';
      agentDetailEditState = { field: null };
      agentEnvEditState = null;
      threadMessageId = null;
      selectedTaskId = null;
      selectedProjectFile = null;
      selectedAgentWorkspaceFile = null;
      modal = null;
      render();
      maybeWarmCurrentAgent();
      loadAgentSkills(selectedAgentId).catch((error) => toast(error.message));
    }
    if (action === 'close-agent-detail') {
      if (inspectorReturnThreadId && byId(appState.messages, inspectorReturnThreadId)) {
        threadMessageId = inspectorReturnThreadId;
      }
      inspectorReturnThreadId = null;
      selectedAgentId = null;
      agentDetailEditState = { field: null };
      agentEnvEditState = null;
      render();
    }
    if (action === 'set-agent-detail-tab') {
      agentDetailTab = target.dataset.tab || 'profile';
      agentDetailEditState = { field: null };
      agentEnvEditState = null;
      if (agentDetailTab === 'workspace') {
        await prepareAgentWorkspaceTab(selectedAgentId);
      } else if (agentDetailTab === 'skills' || agentDetailTab === 'profile') {
        await loadAgentSkills(selectedAgentId);
      } else {
        render();
      }
    }
    if (action === 'toggle-agent-skill-section') {
      toggleSkillSection(target.dataset.section || '');
      render();
    }
    if (action === 'edit-agent-field') {
      agentDetailEditState = { field: target.dataset.field };
      render();
    }
    if (action === 'cancel-agent-field') {
      agentDetailEditState = { field: null };
      render();
    }
    if (action === 'save-agent-field') {
      const field = target.dataset.field;
      const editor = target.closest('.agent-inline-edit');
      const agentId = editor?.dataset.agentId || selectedAgentId;
      const input = editor?.querySelector(`[name="${CSS.escape(field || '')}"]`);
      const value = field === 'description'
        ? String(input?.value || '').slice(0, 3000)
        : String(input?.value || '').trim();
      if (field === 'name' && !value) {
        toast('Name is required');
        return;
      }
      await api(`/api/agents/${encodeURIComponent(agentId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ [field]: value }),
      });
      agentDetailEditState = { field: null };
      toast('Agent updated');
    }
    if (action === 'refresh-agent-skills') {
      await loadAgentSkills(target.dataset.agentId || selectedAgentId, { force: true });
      toast('Skills rescanned');
    }
    if (action === 'edit-agent-env') {
      const agent = byId(appState.agents, target.dataset.agentId || selectedAgentId);
      agentEnvEditState = {
        agentId: agent?.id || selectedAgentId,
        items: (agent?.envVars?.length ? agent.envVars : [{ key: '', value: '' }])
          .map((item) => ({ key: item.key || '', value: item.value || '' })),
      };
      render();
    }
    if (action === 'add-agent-env-var') {
      if (agentEnvEditState?.items) agentEnvEditState.items.push({ key: '', value: '' });
      render();
    }
    if (action === 'remove-agent-env-var') {
      const index = parseInt(target.dataset.index, 10);
      if (!Number.isNaN(index) && agentEnvEditState?.items) {
        agentEnvEditState.items.splice(index, 1);
        if (!agentEnvEditState.items.length) agentEnvEditState.items.push({ key: '', value: '' });
      }
      render();
    }
    if (action === 'cancel-agent-env') {
      agentEnvEditState = null;
      render();
    }
    if (action === 'save-agent-env') {
      const agentId = target.dataset.agentId || selectedAgentId;
      const envVars = (agentEnvEditState?.items || [])
        .map((item) => ({ key: String(item.key || '').trim(), value: String(item.value || '') }))
        .filter((item) => item.key);
      await api(`/api/agents/${encodeURIComponent(agentId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ envVars }),
      });
      agentEnvEditState = null;
      toast('Environment variables updated');
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
        selectedTaskId = null;
        render();
        maybeWarmCurrentAgent();
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
        selectedTaskId = null;
        maybeWarmAgent(byId(appState.agents, agentId), { spaceType: 'dm', spaceId: result.dm.id });
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
      persistVisiblePaneScrolls();
      selectedAgentId = null;
      selectedTaskId = null;
      inspectorReturnThreadId = null;
      agentDetailEditState = { field: null };
      agentEnvEditState = null;
      selectedSpaceType = target.dataset.type;
      selectedSpaceId = target.dataset.id;
      activeView = 'space';
      activeTab = 'chat';
      threadMessageId = null;
      selectedSavedRecordId = null;
      selectedProjectFile = null;
      selectedAgentWorkspaceFile = null;
      render();
      maybeWarmCurrentAgent();
    }
    if (action === 'set-tab') {
      persistVisiblePaneScrolls();
      activeTab = target.dataset.tab;
      if (activeTab !== 'tasks') selectedTaskId = null;
      render();
    }
    if (action === 'task-filter') {
      taskFilter = target.dataset.status;
      render();
    }
    if (action === 'set-task-view') {
      taskViewMode = target.dataset.view === 'list' ? 'list' : 'board';
      taskChannelMenuOpen = false;
      render();
    }
    if (action === 'toggle-task-channel-menu') {
      taskChannelMenuOpen = !taskChannelMenuOpen;
      render();
    }
    if (action === 'toggle-task-channel-filter') {
      const channelId = target.dataset.id;
      if (channelId) {
        taskChannelFilterIds = taskChannelFilterIds.includes(channelId)
          ? taskChannelFilterIds.filter((id) => id !== channelId)
          : [...taskChannelFilterIds, channelId];
      }
      taskChannelMenuOpen = true;
      render();
    }
    if (action === 'clear-task-channel-filters') {
      taskChannelFilterIds = [];
      taskChannelMenuOpen = false;
      render();
    }
    if (action === 'toggle-task-column') {
      toggleTaskColumn(target.dataset.status);
      render();
    }
    if (action === 'select-task') {
      const task = byId(appState.tasks, target.dataset.id);
      const thread = task ? taskThreadMessage(task) : null;
      if (thread) {
        selectedTaskId = null;
        threadMessageId = thread.id;
      } else {
        selectedTaskId = target.dataset.id;
        threadMessageId = null;
      }
      inspectorReturnThreadId = null;
      selectedAgentId = null;
      selectedProjectFile = null;
      selectedSavedRecordId = null;
      render();
    }
    if (action === 'close-task-detail') {
      selectedTaskId = null;
      render();
    }
    if (action === 'open-modal') {
      modal = target.dataset.modal;
      if (modal === 'channel') {
        createChannelMemberSearchQuery = '';
      }
      if (modal === 'add-channel-member' || modal === 'channel-members') {
        addMemberSearchQuery = '';
      }
      if (modal === 'agent') {
        resetAgentFormState();
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
      agentStartState = { agentId: target.dataset.id };
      modal = 'agent-start';
      render();
    }
    if (action === 'confirm-agent-start') {
      if (!agentStartState.agentId) return;
      await api(`/api/agents/${agentStartState.agentId}/start`, { method: 'POST', body: '{}' });
      agentStartState = { agentId: null };
      modal = null;
      toast('Agent start requested');
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
        if (modal === 'channel') {
          createChannelMemberSearchQuery = '';
        }
        if (modal === 'agent-start') {
          agentStartState = { agentId: null };
        }
        if (modal === 'agent-restart') {
          agentRestartState = { agentId: null, mode: 'restart' };
        }
        let nextModal = null;
        if (modal === 'avatar-crop') {
          if (avatarCropState?.target === 'agent-create') nextModal = 'agent';
          avatarCropState = null;
        }
        modal = nextModal;
        render();
      }
    }
    if (action === 'open-thread') {
      threadMessageId = target.dataset.id;
      inspectorReturnThreadId = null;
      selectedSavedRecordId = null;
      selectedAgentId = null;
      selectedTaskId = null;
      selectedProjectFile = null;
      render();
      scrollToMessage(threadMessageId);
    }
    if (action === 'open-search-result') {
      const record = conversationRecord(target.dataset.id);
      if (record) openSearchResult(record);
    }
    if (action === 'open-search-entity') {
      openSearchEntity(target.dataset.targetType, target.dataset.targetId);
    }
    if (action === 'close-thread') {
      threadMessageId = null;
      selectedSavedRecordId = null;
      render();
    }
    if (action === 'view-in-channel') {
      const message = byId(appState.messages, target.dataset.id);
      if (message) {
        persistVisiblePaneScrolls();
        selectedSpaceType = message.spaceType;
        selectedSpaceId = message.spaceId;
        activeView = 'space';
        activeTab = 'chat';
        threadMessageId = message.id;
        selectedTaskId = null;
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
    if (action === 'refresh-agent-workspace') {
      await refreshAgentWorkspace(target.dataset.agentId || selectedAgentId);
    }
    if (action === 'set-agent-workspace-preview-mode') {
      agentWorkspacePreviewMode = target.dataset.mode || 'preview';
      render();
    }
    if (action === 'close-agent-workspace-file') {
      selectedAgentWorkspaceFile = null;
      render();
    }
    if (action === 'confirm-avatar-crop') {
      const crop = avatarCropState;
      const avatar = await drawCroppedAvatarToDataUrl(crop);
      if (crop?.target === 'agent-detail' && crop.agentId) {
        await api(`/api/agents/${encodeURIComponent(crop.agentId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ avatar }),
        });
        toast('Avatar updated');
      }
      if (crop?.target === 'agent-create') {
        agentFormState.avatar = avatar;
        toast('Avatar selected');
      }
      avatarCropState = null;
      modal = crop?.target === 'agent-create' ? 'agent' : null;
    }
    if (action === 'remove-project') {
      clearProjectCaches(target.dataset.id);
      await api(`/api/projects/${target.dataset.id}`, { method: 'DELETE' });
      toast('Project folder removed');
    }
    if (action === 'save-message') {
      await api(`/api/messages/${target.dataset.id}/save`, { method: 'POST', body: '{}' });
    }
    if (action === 'remove-saved-message') {
      await api(`/api/messages/${target.dataset.id}/save`, { method: 'POST', body: '{}' });
      if (selectedSavedRecordId === target.dataset.id) {
        selectedSavedRecordId = null;
        threadMessageId = null;
      }
      toast('Removed from saved');
    }
    if (action === 'open-saved-message') {
      const record = conversationRecord(target.dataset.id);
      if (record) {
        const threadRoot = savedRecordThreadRoot(record);
        selectedSavedRecordId = record.id;
        selectedAgentId = null;
        selectedTaskId = null;
        selectedProjectFile = null;
        inspectorReturnThreadId = null;
        if (threadRoot) {
          threadMessageId = threadRoot.id;
          render();
        } else {
          selectedSpaceType = record.spaceType;
          selectedSpaceId = record.spaceId;
          activeView = 'space';
          activeTab = 'chat';
          threadMessageId = null;
          render();
          scrollToMessage(record.id);
        }
      }
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
  let focusComposerId = null;

  try {
    if (form.id === 'message-form') {
      const composerId = form.dataset.composerId || composerIdFor('message');
      const rawBody = composerDrafts[composerId] ?? data.get('body');
      const shouldOpenTaskThread = Boolean(composerTaskFlags[composerId] ?? data.get('asTask'));
      const attachmentIds = stagedFor(composerId).ids;
      const messageSnapshot = snapshotComposerState(form, composerId, { includeTask: true });
      clearComposerForSubmit(form, composerId, { clearTask: true });
      let result;
      try {
        result = await api(`/api/spaces/${selectedSpaceType}/${selectedSpaceId}/messages`, {
          method: 'POST',
          body: JSON.stringify({
            body: encodeComposerMentions(rawBody, composerId),
            asTask: shouldOpenTaskThread,
            attachmentIds,
          }),
        });
      } catch (error) {
        restoreComposerAfterFailedSubmit(form, composerId, messageSnapshot, { restoreTask: true });
        throw error;
      }
      if (shouldOpenTaskThread && result.message?.id) threadMessageId = result.message.id;
      requestPaneBottomScroll('main');
      submittedBottomTarget = '#message-list';
      focusComposerId = shouldOpenTaskThread && result.message?.id ? composerIdFor('thread', result.message.id) : composerId;
      toast('Message sent');
    }
    if (form.id === 'reply-form') {
      const composerId = form.dataset.composerId || composerIdFor('thread', threadMessageId);
      const rawBody = composerDrafts[composerId] ?? data.get('body');
      const attachmentIds = stagedFor(composerId).ids;
      const replySnapshot = snapshotComposerState(form, composerId);
      clearComposerForSubmit(form, composerId);
      try {
        await api(`/api/messages/${threadMessageId}/replies`, {
          method: 'POST',
          body: JSON.stringify({ body: encodeComposerMentions(rawBody, composerId), attachmentIds }),
        });
      } catch (error) {
        restoreComposerAfterFailedSubmit(form, composerId, replySnapshot);
        throw error;
      }
      requestPaneBottomScroll('thread');
      submittedBottomTarget = '#thread-context';
      focusComposerId = composerId;
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
      createChannelMemberSearchQuery = '';
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
      resetAgentFormState();
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
    if (form.id === 'fanout-config-form') {
      await api('/api/settings/fanout', {
        method: 'POST',
        body: JSON.stringify(fanoutFormPayload()),
      });
      toast('Fan-out API saved');
    }
  } catch (error) {
    toast(error.message);
  } finally {
    if (focusComposerId) requestComposerFocus(focusComposerId);
    await refreshState().catch(() => {});
    if (submittedBottomTarget) scrollPaneToBottom(submittedBottomTarget, 'auto');
  }
});

render();
refreshState().then(() => {
  initialLoadComplete = true;
  return connectEvents();
}).catch((error) => {
  root.innerHTML = `<div class="boot">MAGCLAW LOCAL / ${escapeHtml(error.message)}</div>`;
});
