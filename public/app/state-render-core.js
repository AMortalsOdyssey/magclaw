const root = document.querySelector('#root');
const UI_STATE_KEY = 'magclawUiState';
const PANE_SCROLL_KEY = 'magclawPaneScroll';
const TASK_COLUMN_COLLAPSE_KEY = 'magclawTaskColumnCollapse';
const SIDEBAR_SECTION_COLLAPSE_KEY = 'magclawSidebarSectionCollapse';
const SKILL_SECTION_COLLAPSE_KEY = 'magclawSkillSectionCollapse';
const NOTIFICATION_PREF_KEY = 'magclawNotificationPrefs';
const BRAND_LOGO_SRC = '/brand/magclaw-logo.png';
const BRAND_FAVICON_SRC = '/brand/magclaw-favicon.png';
const NOTIFICATION_ICON = BRAND_FAVICON_SRC;
const NOTIFICATION_PREVIEW_LIMIT = 140;
const WORKSPACE_ACTIVITY_VISIBLE_STEP = 30;
const WORKSPACE_ACTIVITY_CACHE_KEY = 'magclawWorkspaceActivityCache';
const WORKSPACE_ACTIVITY_CACHE_LIMIT = 300;
const WORKSPACE_ACTIVITY_READ_KEY = 'magclawWorkspaceActivityReadAt';
const DEFAULT_COLLAPSED_TASK_COLUMNS = { done: true };
const MEMBERS_LAYOUT_MODES = new Set(['directory', 'channel', 'split', 'agent', 'human']);
const CLOUD_ROLE_HIERARCHY = ['member', 'admin'];
const CLOUD_ROLE_LABELS = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};
const initialUiState = readStoredUiState();
canonicalizeLegacyRoutePath();
const initialRouteState = routeStateFromLocation(window.location.pathname || '');

let appState = null;
const initialRouteSpace = initialRouteState.space || initialSpaceFromLocation(initialUiState.selectedSpaceType || 'channel', initialUiState.selectedSpaceId || 'chan_all');
let selectedSpaceType = initialRouteSpace.type;
let selectedSpaceId = initialRouteSpace.id;
let activeView = initialRouteState.activeView || initialActiveViewFromLocation(initialUiState.activeView || 'space');
let activeTab = initialUiState.activeTab || 'chat';
let railTab = initialRouteState.railTab || initialUiState.railTab || localStorage.getItem('railTab') || 'spaces'; // 'spaces', 'members', 'computers', or 'settings'
let threadMessageId = initialUiState.threadMessageId || null;
let inspectorReturnThreadId = null;
let inboxCategory = 'all';
let inboxFilter = 'all';
let workspaceActivityDrawerOpen = false;
let workspaceActivityVisibleCount = WORKSPACE_ACTIVITY_VISIBLE_STEP;
let workspaceActivityScrollToBottom = false;
let selectedAgentId = initialRouteState.selectedAgentId || initialUiState.selectedAgentId || null; // selected agent for detail panel
let selectedHumanId = initialRouteState.selectedHumanId || initialUiState.selectedHumanId || null;
let selectedComputerId = initialRouteState.selectedComputerId || initialUiState.selectedComputerId || null;
let membersLayout = normalizeMembersLayout(
  initialRouteState.selectedHumanId
    ? { mode: 'human', humanId: initialRouteState.selectedHumanId }
    : initialRouteState.selectedAgentId
      ? { mode: 'agent', agentId: initialRouteState.selectedAgentId }
      : initialUiState.membersLayout
);
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
let humanDescriptionEditState = { humanId: null };
let settingsTab = initialRouteState.settingsTab || initialUiState.settingsTab || 'account';
let consoleTab = initialRouteState.consoleTab || consoleTabFromPath() || initialUiState.consoleTab || 'overview';
let latestPairingCommand = null;
let computerPairingDisplayName = '';
let computerPairingCommandError = '';
let serverSwitcherOpen = false;
let latestInvitationLink = null;
let cloudInviteEmails = [];
let cloudInviteDraft = '';
let cloudGeneratedLinks = [];
let memberDirectoryPage = 1;
let memberManageState = { memberId: null };
let memberActionConfirmState = { memberId: null, action: null };
let memberResetLinkState = { email: '', link: '' };
let appFlash = null;
let profileFormDraft = null;
let profileFormIsComposing = false;
let pendingProfileFormRender = false;
let cloudAuthAvatar = '';
let cloudAuthAvatarToken = '';
let serverProfileAvatarDraft = null;
let collapsedSidebarSections = readJsonStorage(SIDEBAR_SECTION_COLLAPSE_KEY, {});
let collapsedSkillSections = readJsonStorage(SKILL_SECTION_COLLAPSE_KEY, {});
let avatarCropState = null;
let avatarPickerState = null;
let notificationPrefs = normalizeNotificationPrefs(readJsonStorage(NOTIFICATION_PREF_KEY, {}));
let windowFocused = document.hasFocus();
let eventSource = null;
let cloudLoginDraftEmail = '';
let humanPresenceTimer = null;
let humanPresenceInFlight = false;
let routeServerSwitchAttempted = false;

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
const HUMAN_PRESENCE_HEARTBEAT_MS = 30 * 1000;

function consoleTabFromPath(path = window.location.pathname || '') {
  if (path.startsWith('/console/invitations')) return 'invitations';
  if (path.startsWith('/console/servers')) return 'servers';
  if (path.startsWith('/console/lost-space')) return 'lost-space';
  if (path.startsWith('/console')) return 'overview';
  return '';
}

function serverSlugFromPath(path = window.location.pathname || '') {
  const match = String(path || '').match(/^\/s\/([^/]+)/);
  return match ? decodeURIComponent(match[1] || '') : '';
}

function routeStateFromLocation(path = window.location.pathname || '') {
  const value = String(path || '');
  if (value.startsWith('/console')) {
    return { activeView: 'console', consoleTab: consoleTabFromPath(value), railTab: 'console' };
  }
  const settingsMatch = value.match(/^\/s\/[^/]+\/settings\/([^/]+)/);
  if (settingsMatch) {
    const tab = decodeURIComponent(settingsMatch[1] || 'server');
    return { activeView: 'cloud', settingsTab: tab === 'system' ? 'server' : tab, railTab: 'settings' };
  }
  const humanMatch = value.match(/^\/s\/[^/]+\/human\/([^/]+)/);
  if (humanMatch) {
    return { activeView: 'members', selectedHumanId: decodeURIComponent(humanMatch[1] || ''), railTab: 'members' };
  }
  const agentMatch = value.match(/^\/s\/[^/]+\/agent\/([^/]+)/);
  if (agentMatch) {
    return { activeView: 'members', selectedAgentId: decodeURIComponent(agentMatch[1] || ''), railTab: 'members' };
  }
  const computerMatch = value.match(/^\/s\/[^/]+\/computer\/([^/]+)/);
  if (computerMatch) {
    return { activeView: 'computers', selectedComputerId: decodeURIComponent(computerMatch[1] || ''), railTab: 'computers' };
  }
  if (/^\/s\/[^/]+\/members/.test(value)) return { activeView: 'members', railTab: 'members' };
  if (/^\/s\/[^/]+\/computers/.test(value)) return { activeView: 'computers', railTab: 'computers' };
  if (/^\/s\/[^/]+\/tasks/.test(value)) return { activeView: 'tasks', railTab: 'spaces' };
  const spaceMatch = value.match(/^\/s\/[^/]+\/(channels|dms)\/([^/]+)/);
  if (spaceMatch) {
    return {
      activeView: 'space',
      railTab: 'spaces',
      space: {
        type: spaceMatch[1] === 'dms' ? 'dm' : 'channel',
        id: decodeURIComponent(spaceMatch[2] || 'chan_all'),
      },
    };
  }
  if (value.startsWith('/s/')) return { activeView: 'space', railTab: 'spaces' };
  return {};
}

function canonicalizeLegacyRoutePath() {
  const path = window.location.pathname || '';
  if (!/^\/s\/[^/]+\/settings\/system(?:\/|$)/.test(path)) return;
  if (!window.history?.replaceState) return;
  const nextPath = path.replace(/\/settings\/system(?:\/.*)?$/, '/settings/server');
  window.history.replaceState({}, '', `${nextPath}${window.location.search || ''}${window.location.hash || ''}`);
}

function initialActiveViewFromLocation(savedView = 'space') {
  return routeStateFromLocation(window.location.pathname || '').activeView || savedView || 'space';
}

function initialSpaceFromLocation(defaultType = 'channel', defaultId = 'chan_all') {
  const match = (window.location.pathname || '').match(/^\/s\/[^/]+\/(channels|dms)\/([^/]+)/);
  if (!match) return { type: defaultType, id: defaultId };
  return {
    type: match[1] === 'dms' ? 'dm' : 'channel',
    id: decodeURIComponent(match[2] || defaultId),
  };
}

function currentServerSlug() {
  const workspace = appState?.cloud?.workspace || appState?.cloud?.workspaces?.[0] || {};
  const slug = String(workspace.slug || workspace.id || appState?.connection?.workspaceId || 'local').trim();
  return slug || 'local';
}

function displayServerSlug(value, fallback = '') {
  const slug = String(value || '').trim();
  if (!slug || slug.toLowerCase() === 'local') return fallback;
  return slug;
}

function consolePath(tab = consoleTab) {
  if (tab === 'invitations') return '/console/invitations';
  if (tab === 'servers') return '/console/servers';
  if (tab === 'lost-space') return '/console/lost-space';
  return '/console';
}

function routePathForActiveView() {
  if (activeView === 'console') return consolePath(consoleTab);
  const serverSlug = encodeURIComponent(currentServerSlug());
  if (activeView === 'space') {
    const kind = selectedSpaceType === 'dm' ? 'dms' : 'channels';
    return `/s/${serverSlug}/${kind}/${encodeURIComponent(selectedSpaceId || '')}`;
  }
  if (activeView === 'computers') {
    return selectedComputerId
      ? `/s/${serverSlug}/computer/${encodeURIComponent(selectedComputerId)}`
      : `/s/${serverSlug}/computers`;
  }
  if (activeView === 'members') {
    if (selectedHumanId) return `/s/${serverSlug}/human/${encodeURIComponent(selectedHumanId)}`;
    if (selectedAgentId) return `/s/${serverSlug}/agent/${encodeURIComponent(selectedAgentId)}`;
    return `/s/${serverSlug}/members`;
  }
  if (activeView === 'tasks') return `/s/${serverSlug}/tasks`;
  if (activeView === 'cloud') {
    const safeSettingsTab = settingsTab === 'system' ? 'server' : (settingsTab || 'account');
    return `/s/${serverSlug}/settings/${encodeURIComponent(safeSettingsTab)}`;
  }
  return `/s/${serverSlug}`;
}

function syncBrowserRouteForActiveView({ replace = false } = {}) {
  if (!window.history?.pushState) return;
  const nextPath = routePathForActiveView();
  if (!nextPath || window.location.pathname === nextPath) return;
  window.history[replace ? 'replaceState' : 'pushState']({}, '', nextPath);
}

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
  ['closed', 'Closed'],
];

function taskIsClosedStatus(status) {
  return status === 'done' || status === 'closed';
}

const taskStatusMeta = {
  todo: { label: 'Todo', icon: '□', tone: 'todo' },
  in_progress: { label: 'In Progress', icon: '↻', tone: 'in_progress' },
  in_review: { label: 'In Review', icon: '👀', tone: 'in_review' },
  done: { label: 'Done', icon: '✓', tone: 'done' },
  closed: { label: 'Closed', icon: '×', tone: 'closed' },
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

function renderThreadRowAvatar(record) {
  return `
    <span class="avatar thread-list-avatar" aria-hidden="true">
      ${getAvatarHtml(record?.authorId, record?.authorType, 'avatar-inner')}
      ${agentStatusDot(record?.authorId, record?.authorType)}
      ${humanStatusDot(record?.authorId, record?.authorType)}
    </span>
  `;
}

function renderTaskStateFlow(task) {
  const status = taskStatusMeta[task?.status] ? task.status : 'todo';
  const flowColumns = status === 'closed'
    ? taskColumns.filter(([value]) => value !== 'done')
    : taskColumns.filter(([value]) => value !== 'closed');
  const currentIndex = Math.max(0, flowColumns.findIndex(([value]) => value === status));
  return `
    <div class="task-state-flow" aria-label="Task status: ${escapeHtml(taskStatusLabel(status))}">
      ${flowColumns.map(([value]) => {
        const index = flowColumns.findIndex(([item]) => item === value);
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

function cloudRoleAllows(role, allowedRole) {
  const roleIndex = CLOUD_ROLE_HIERARCHY.indexOf(String(role || 'member'));
  const allowedIndex = CLOUD_ROLE_HIERARCHY.indexOf(String(allowedRole || 'member'));
  return roleIndex >= 0 && allowedIndex >= 0 && roleIndex >= allowedIndex;
}

function cloudCan(capability) {
  const auth = appState?.cloud?.auth || {};
  if (auth.loginRequired === false) return true;
  const capabilities = appState?.cloud?.auth?.capabilities || {};
  return Boolean(capabilities[capability]);
}

function cloudRoleLabel(role) {
  return CLOUD_ROLE_LABELS[String(role || 'member')] || CLOUD_ROLE_LABELS.member;
}

function serverOwnerUserId(workspace = appState?.cloud?.workspace || {}) {
  if (workspace?.ownerUserId) return workspace.ownerUserId;
  const activeAdmins = (appState?.cloud?.members || [])
    .filter((member) => member.workspaceId === workspace?.id && member.status !== 'removed' && member.role === 'admin')
    .sort((a, b) => Date.parse(a.joinedAt || a.createdAt || 0) - Date.parse(b.joinedAt || b.createdAt || 0));
  return activeAdmins[0]?.userId || '';
}

function cloudMemberDisplayRole(member = {}) {
  const ownerUserId = serverOwnerUserId();
  if (ownerUserId && member?.userId === ownerUserId) return 'owner';
  return member?.role || 'member';
}

function humanInitialFromName(value = '') {
  const label = String(value || 'Human').trim();
  const match = label.match(/[a-zA-Z0-9\u4e00-\u9fff]/);
  return (match?.[0] || 'H').toUpperCase();
}

function renderHumanAvatar(human = {}, cssClass = 'dm-avatar') {
  const avatar = String(human.avatar || human.avatarUrl || '').trim();
  if (avatar) return `<span class="${escapeHtml(cssClass)}"><img src="${escapeHtml(avatar)}" alt=""></span>`;
  return `<span class="${escapeHtml(cssClass)}">${escapeHtml(humanInitialFromName(human.name || human.email || human.id))}</span>`;
}

function humanBadgeHtml() {
  return '<img class="human-script-badge" src="/brand/humans-script-badge.png" alt="humans" />';
}

function humanFromCloudMember(member = {}) {
  const human = member.human || byId(appState?.humans, member.humanId) || {};
  const user = member.user || {};
  return {
    ...human,
    id: human.id || member.humanId || `hum_${member.userId || member.id || 'member'}`,
    authUserId: member.userId || human.authUserId || '',
    name: human.name || user.name || user.email || member.email || 'Human',
    email: human.email || user.email || member.email || '',
    avatar: human.avatar || human.avatarUrl || user.avatarUrl || '',
    role: cloudMemberDisplayRole(member),
    status: human.status || member.presenceStatus || 'offline',
    joinedAt: member.joinedAt || member.createdAt || human.createdAt || '',
    cloudMemberId: member.id || '',
    cloudMember: member,
  };
}

function workspaceHumans() {
  const members = (appState?.cloud?.members || [])
    .filter((member) => member && (member.status || 'active') === 'active')
    .sort((a, b) => new Date(a.joinedAt || a.createdAt || 0) - new Date(b.joinedAt || b.createdAt || 0));
  if (members.length) {
    const seen = new Set();
    const humans = [];
    const ownerUserId = serverOwnerUserId();
    const hasNonLegacyMembers = members.some((member) => member.humanId !== 'hum_local');
    for (const member of members) {
      if (hasNonLegacyMembers && member.humanId === 'hum_local' && member.userId !== ownerUserId) continue;
      const human = humanFromCloudMember(member);
      const key = member.userId || human.authUserId || human.email?.toLowerCase() || human.id;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      humans.push(human);
    }
    return humans;
  }
  return (appState?.humans || []).filter((human) => human && human.status !== 'removed');
}

function humanByIdAny(id) {
  const target = String(id || '');
  const cloudHuman = workspaceHumans().find((human) => (
    human.id === target
    || human.cloudMemberId === target
    || human.authUserId === target
  ));
  if (cloudHuman && target !== 'hum_local') return cloudHuman;
  if (target === 'hum_local' && appState?.cloud?.auth?.currentUser) {
    const current = currentAccountHuman();
    const visibleCurrent = workspaceHumans().find((human) => (
      human.id === current.id
      || human.authUserId === current.authUserId
      || (human.email && current.email && human.email.toLowerCase() === current.email.toLowerCase())
    ));
    if (visibleCurrent) return visibleCurrent;
  }
  return byId(appState?.humans, target) || cloudHuman || null;
}

function currentAccountHuman() {
  const auth = appState?.cloud?.auth || {};
  const currentUser = auth.currentUser;
  const currentMember = auth.currentMember;
  if (currentMember) {
    return humanFromCloudMember(currentMember);
  }
  if (currentUser) {
    const human = (appState?.humans || []).find((item) => item.authUserId === currentUser.id && item.status !== 'removed');
    return human || {
      id: `usr_${currentUser.id || 'current'}`,
      authUserId: currentUser.id || '',
      name: currentUser.name || currentUser.email || 'You',
      email: currentUser.email || '',
      avatar: currentUser.avatarUrl || '',
      role: 'member',
      status: 'offline',
      createdAt: currentUser.createdAt || '',
    };
  }
  return byId(appState?.humans, 'hum_local')
    || appState?.humans?.[0]
    || {};
}

function currentHumanIdentityKeys() {
  const human = currentAccountHuman();
  const keys = new Set([
    currentHumanId(),
    human.id,
    human.authUserId,
    appState?.cloud?.auth?.currentUser?.id,
    appState?.cloud?.auth?.currentMember?.humanId,
  ].map((value) => String(value || '').trim()).filter(Boolean));
  const email = String(human.email || appState?.cloud?.auth?.currentUser?.email || '').trim().toLowerCase();
  if (email) keys.add(`email:${email}`);
  return keys;
}

function humanIdentityKeys(human = {}) {
  const keys = new Set([
    human.id,
    human.authUserId,
    human.cloudMemberId,
    human.cloudMember?.humanId,
    human.cloudMember?.userId,
  ].map((value) => String(value || '').trim()).filter(Boolean));
  const email = String(human.email || human.cloudMember?.user?.email || human.cloudMember?.email || '').trim().toLowerCase();
  if (email) keys.add(`email:${email}`);
  return keys;
}

function humanMatchesCurrentAccount(human = {}) {
  const currentKeys = currentHumanIdentityKeys();
  for (const key of humanIdentityKeys(human)) {
    if (currentKeys.has(key)) return true;
  }
  return false;
}

function cloudCapabilityLabels(capabilities = {}) {
  const labels = [
    ['chat_channels', 'Channel chat'],
    ['chat_agent_dm', 'Agent DMs'],
    ['warm_agents', 'Agent warmup'],
    ['invite_member', 'Invite members'],
    ['manage_agents', 'Manage agents'],
    ['manage_computers', 'Add computers'],
    ['pair_computers', 'Pair computers'],
    ['remove_member', 'Remove members'],
    ['manage_member_roles', 'Manage roles'],
    ['manage_system', 'System config'],
  ];
  return labels.filter(([key]) => capabilities[key]).map(([, label]) => label);
}

function humanPresenceText(human) {
  return presenceTone(human?.status) === 'online' ? 'Online' : 'Offline';
}

function cloudInviteRoleOptions() {
  const options = [];
  if (cloudCan('invite_member')) options.push(['member', 'Member']);
  if (cloudCan('manage_member_roles')) options.push(['admin', 'Admin']);
  return options;
}

function cloudMemberManageRoleOptions() {
  const options = [];
  if (!cloudCan('manage_member_roles')) return options;
  options.push(['member', 'Member']);
  options.push(['admin', 'Admin']);
  return options;
}

function cloudCanRemoveMemberRole(role) {
  const normalized = String(role || 'member');
  if (normalized === 'owner') return false;
  if (normalized === 'admin') return cloudCan('remove_admin');
  return cloudCan('remove_member');
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
  return renderPlainChannelMentions(html);
}

function plainChannelMentionCandidates() {
  const channels = Array.isArray(appState?.channels) ? appState.channels : [];
  const seen = new Set();
  return channels
    .filter((channel) => channel?.id && channel?.name)
    .map((channel) => ({
      id: channel.id,
      nameHtml: escapeHtml(channel.name),
    }))
    .filter((channel) => {
      const key = channel.nameHtml.toLowerCase();
      if (!channel.nameHtml || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.nameHtml.length - a.nameHtml.length);
}

function replacePlainChannelMentionsInText(text, channels) {
  if (!channels.length || !String(text || '').includes('#')) return text;
  const byName = new Map(channels.map((channel) => [channel.nameHtml, channel]));
  const names = channels.map((channel) => escapeRegExp(channel.nameHtml)).join('|');
  if (!names) return text;
  const pattern = new RegExp(`(^|[^A-Za-z0-9_@])#(${names})(?=$|[^A-Za-z0-9_-])`, 'g');
  return String(text).replace(pattern, (match, prefix, nameHtml) => {
    const channel = byName.get(nameHtml);
    if (!channel) return match;
    return `${prefix}<span class="mention-tag mention-channel" data-channel-id="${escapeHtml(channel.id)}">#${nameHtml}</span>`;
  });
}

function renderPlainChannelMentions(html) {
  const channels = plainChannelMentionCandidates();
  if (!channels.length || !String(html || '').includes('#')) return html;
  let codeDepth = 0;
  let mentionDepth = 0;
  return String(html).split(/(<[^>]+>)/g).map((part) => {
    if (!part) return part;
    if (part.startsWith('<')) {
      const tag = part.match(/^<\s*\/?\s*([a-z0-9-]+)/i)?.[1]?.toLowerCase();
      const closing = /^<\s*\//.test(part);
      const selfClosing = /\/\s*>$/.test(part);
      if (closing && tag === 'span' && mentionDepth > 0) mentionDepth -= 1;
      if (closing && (tag === 'code' || tag === 'pre') && codeDepth > 0) codeDepth -= 1;
      if (!closing && !selfClosing && (tag === 'code' || tag === 'pre')) codeDepth += 1;
      if (!closing && !selfClosing && tag === 'span' && /\bmention-tag\b/.test(part)) mentionDepth += 1;
      return part;
    }
    return codeDepth || mentionDepth ? part : replacePlainChannelMentionsInText(part, channels);
  }).join('');
}
