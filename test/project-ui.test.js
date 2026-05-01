import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('project remove buttons render as icons instead of rem text', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.equal(/data-action="remove-project"[\s\S]*?>rem<\/button>/.test(app), false);
  assert.match(app, /class="project-remove-icon"/);
});

test('project picker keeps only the native folder action and polished chip icons', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.equal(app.includes('Add Workspace'), false);
  assert.equal(app.includes('add-default-workspace'), false);
  assert.match(app, /class="project-folder-icon"/);
  assert.match(app, /class="project-tree-icon-svg"/);
  assert.match(styles, /\.project-chip-name/);
  assert.match(styles, /\.project-tree-btn/);
  assert.match(styles, /\.project-icon-btn\.danger-icon/);
});

test('project chip paths stay readable with horizontal scrolling', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(app, /class="project-chip-path"/);
  assert.match(styles, /\.project-chip-path \{/);
  assert.match(styles, /overflow-x: auto/);
  assert.match(styles, /text-overflow: clip/);
});

test('project mentions show full local paths in the candidate list', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(app, /absolutePath: item\.absolutePath/);
  assert.match(app, /item\.absolutePath \|\| item\.path/);
  assert.match(app, /class="mention-handle" title="\$\{escapeHtml\(handle\)\}"/);
  assert.match(styles, /grid-template-columns: 28px 8px minmax\(120px, 0\.55fr\) minmax\(260px, 1\.45fr\)/);
  assert.match(styles, /\.mention-type-file \.mention-handle,\n\.mention-type-folder \.mention-handle/);
  assert.match(styles, /overflow-wrap: anywhere/);
});

test('threads render newest first with display names instead of raw ids', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(app, /function threadUpdatedAt\(message\)/);
  assert.match(app, /\.sort\(\(a, b\) => threadUpdatedAt\(b\) - threadUpdatedAt\(a\)\)/);
  assert.match(app, /const author = displayName\(message\.authorId\)/);
  assert.match(app, /const lastReplyAuthor = lastReply \? displayName\(lastReply\.authorId\) : author/);
  assert.match(app, /function plainMentionText\(text\)/);
  assert.match(app, /function plainActorText\(text\)/);
  assert.match(app, /plainMentionText\(message\.body\)/);
});

test('messages and replies render markdown while preserving mention chips', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(app, /function renderMarkdownWithMentions\(content\)/);
  assert.match(app, /message-table/);
  assert.match(app, /renderMarkdownWithMentions\(message\.body \|\| '\(attachment\)'\)/);
  assert.match(app, /renderMarkdownWithMentions\(reply\.body \|\| '\(attachment\)'\)/);
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(styles, /\.message-table/);
  assert.match(styles, /\.message-table-wrap/);
});

test('human messages and thread replies render agent pickup avatars from work items', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(app, /const AGENT_RECEIPT_VISIBLE_LIMIT = 10/);
  assert.match(app, /function deliveryReceiptItemsForRecord\(record\)/);
  assert.match(app, /item\?\.sourceMessageId === record\.id/);
  assert.match(app, /function renderAgentReceiptTray\(record\)/);
  assert.match(app, /function renderMessageFooter\(\{ replyCountChip = '', receiptTray = '' \} = \{\}\)/);
  assert.match(app, /renderAgentReceiptTray\(message\)/);
  assert.match(app, /renderAgentReceiptTray\(reply\)/);
  assert.match(app, /renderMessageFooter\(\{ replyCountChip, receiptTray \}\)/);
  assert.match(app, /agent-receipt-overflow/);
  assert.match(app, /receipts: deliveryReceiptSignature\(record\)/);
  assert.match(styles, /\.message-footer/);
  assert.match(styles, /\.agent-receipt-tray/);
  assert.match(styles, /\.agent-receipt-trigger:hover \.agent-receipt-popover/);
  assert.match(styles, /@keyframes agent-receipt-pop/);
});

test('task columns can be collapsed from the board header', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(app, /let collapsedTaskColumns = readCollapsedTaskColumns\(\)/);
  assert.match(app, /const DEFAULT_COLLAPSED_TASK_COLUMNS = \{ done: true \}/);
  assert.match(app, /return \{ \.\.\.DEFAULT_COLLAPSED_TASK_COLUMNS, \.\.\.parsed \}/);
  assert.match(app, /data-action="toggle-task-column"/);
  assert.match(app, /function toggleTaskColumn\(status\)/);
  assert.match(styles, /\.task-column\.collapsed/);
  assert.match(styles, /\.column-toggle/);
});

test('stop all agents channel action is labelled but temporarily unavailable', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(app, /title="Stop All Agents - Stop all Agent actions in this channel \(temporarily unavailable\)"/);
  assert.match(app, /data-tooltip="Stop All Agents[\s\S]*temporarily unavailable/);
  assert.match(app, /该功能暂时不可用/);
  assert.equal(app.includes('data-action="confirm-stop-all"'), false);
  assert.equal(app.includes("/api/agents/stop-all"), false);
});

test('all visible frontend timestamps include seconds', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(app, /function fmtTime\(value\)/);
  assert.match(app, /second: '2-digit'/);
  assert.match(app, /hour12: false/);
});

test('agent born date shows a cake on same-month-day anniversaries only', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(app, /function shouldCelebrateAgentBorn\(value, today = new Date\(\)\)/);
  assert.match(app, /date\.getMonth\(\) === today\.getMonth\(\)/);
  assert.match(app, /date\.getDate\(\) === today\.getDate\(\)/);
  assert.match(app, /date\.getFullYear\(\) !== today\.getFullYear\(\)/);
  assert.match(app, /shouldCelebrateAgentBorn\(date\) \? '🎂 ' : ''/);
});

test('agent messages and thread replies render live status dots on avatar corners', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(app, /function agentStatusDot\(authorId, authorType\)/);
  assert.match(app, /renderAgentIdentityButton\(authorId, 'agent-avatar-button'\)\}\$\{agentStatusDot\(authorId, authorType\)\}/);
  assert.equal(app.includes('renderActorName(message.authorId, message.authorType)}${agentStatusDot(message.authorId, message.authorType)}'), false);
  assert.equal(app.includes('renderActorName(reply.authorId, reply.authorType)}${agentStatusDot(reply.authorId, reply.authorType)}'), false);
  assert.match(styles, /\.avatar-status-dot/);
  assert.match(styles, /\.avatar-status-dot\.status-error/);
});

test('empty thread replies keep the count without rendering a no-replies placeholder', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.equal(app.includes('No replies yet'), false);
  assert.match(app, /<strong>\$\{replies\.length\} \$\{replyWord\}<\/strong>/);
  assert.match(app, /replies\.length \? `[\s\S]*<div class="reply-list">/);
});

test('channel navigation hides the inspector until an agent, task, or thread is selected', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(app, /const inspectorHtml = renderInspector\(\)/);
  assert.match(app, /inspectorHtml \? `[\s\S]*collab-inspector/);
  assert.match(app, /class="app-frame collab-frame\$\{inspectorHtml \? '' : ' no-inspector'\}"/);
  assert.match(app, /let selectedTaskId = null/);
  assert.match(app, /function renderInspector\(\)[\s\S]*if \(selectedAgentId\)/);
  assert.match(app, /selectedAgentId = null;[\s\S]*selectedSpaceType = target\.dataset\.type/);
  assert.match(styles, /\.app-frame\.no-inspector/);
});

test('dm chat and task empty states use Slock-style simple surfaces', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(app, /function renderDmHeader\(\)/);
  assert.match(app, /data-action="select-agent" data-id="\$\{escapeHtml\(peer\.item\.id\)\}"/);
  assert.match(app, /class="dm-peer-head dm-peer-button"/);
  assert.match(app, /function renderDmChat\(\)/);
  assert.match(app, /function renderDmTasks\(tasks\)/);
  assert.match(app, /No messages yet\. Start the conversation!/);
  assert.match(app, /No tasks yet\. Create one to get started!/);
  assert.match(styles, /\.dm-empty-state/);
  assert.match(styles, /\.dm-task-empty/);
  assert.match(styles, /\.dm-peer-button/);
});

test('create channel keeps agent members optional and manually selected', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const channelModalSource = app.slice(app.indexOf('function renderChannelModal'), app.indexOf('function renderEditChannelModal'));
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(app, /function agentCanJoinNewChannel\(agent\)/);
  assert.match(channelModalSource, /Members <small>\(optional\)<\/small>/);
  assert.match(channelModalSource, /id="create-channel-member-search"/);
  assert.doesNotMatch(channelModalSource, /checked/);
  assert.match(styles, /\.create-channel-member-row:has\(input\[type="checkbox"\]:checked\)/);
});

test('message composers refocus after enter-submit sends', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const renderSource = app.slice(app.indexOf('function render()'), app.indexOf('function renderRail()'));
  const submitSource = app.slice(app.indexOf("document.addEventListener('submit'"), app.indexOf('refreshState().then'));

  assert.match(app, /let pendingComposerFocusId = null/);
  assert.match(app, /function focusComposerTextarea\(composerId\)/);
  assert.match(app, /function requestComposerFocus\(composerId\)/);
  assert.match(app, /function restorePendingComposerFocus\(\)/);
  assert.match(renderSource, /restorePendingComposerFocus\(\)/);
  assert.match(submitSource, /let focusComposerId = null/);
  assert.match(submitSource, /focusComposerId = shouldOpenTaskThread && result\.message\?\.id \? composerIdFor\('thread', result\.message\.id\) : composerId/);
  assert.match(submitSource, /focusComposerId = composerId/);
  assert.match(submitSource, /if \(focusComposerId\) requestComposerFocus\(focusComposerId\)/);
});

test('message composers do not submit while IME composition is active', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const compositionStartSource = app.slice(app.indexOf("document.addEventListener('compositionstart'"), app.indexOf("document.addEventListener('compositionend'"));
  const compositionEndSource = app.slice(app.indexOf("document.addEventListener('compositionend'"), app.indexOf("document.addEventListener('keydown'"));
  const keydownSource = app.slice(app.indexOf("document.addEventListener('keydown'"), app.indexOf("document.addEventListener('pointerdown'"));

  assert.match(app, /let composerIsComposing = false/);
  assert.match(app, /function isImeComposing\(event\)/);
  assert.match(app, /event\?\.keyCode === 229/);
  assert.match(compositionStartSource, /textarea\[data-mention-input\]/);
  assert.match(compositionStartSource, /composerIsComposing = true/);
  assert.match(compositionEndSource, /textarea\[data-mention-input\]/);
  assert.match(compositionEndSource, /composerIsComposing = false/);
  assert.match(keydownSource, /if \(textarea && isImeComposing\(event\)\) return/);
});

test('workspace location and scroll position survive refreshes', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const renderSource = app.slice(app.indexOf('function render()'), app.indexOf('function renderRail()'));
  const scrollListenerSource = app.slice(
    app.indexOf("document.addEventListener('scroll'"),
    app.indexOf("document.addEventListener('compositionstart'"),
  );

  assert.match(app, /const UI_STATE_KEY = 'magclawUiState'/);
  assert.match(app, /const PANE_SCROLL_KEY = 'magclawPaneScroll'/);
  assert.match(app, /function readStoredUiState\(\)/);
  assert.match(app, /function persistUiState\(\)/);
  assert.match(app, /function readStoredPaneScrolls\(\)/);
  assert.match(app, /function persistPaneScroll\(targetName, node\)/);
  assert.match(renderSource, /persistUiState\(\)/);
  assert.match(scrollListenerSource, /persistPaneScroll\('main', event\.target\)/);
  assert.match(scrollListenerSource, /persistPaneScroll\('thread', event\.target\)/);
});

test('task cards open their thread conversation and keep compact blocks without delete action', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const cardSource = app.slice(app.indexOf('function renderTaskCard'), app.indexOf('function renderTaskActionButtons'));
  const selectTaskSource = app.slice(app.indexOf("if (action === 'select-task')"), app.indexOf("if (action === 'close-task-detail')"));

  assert.match(app, /function renderTaskDetail\(task\)/);
  assert.match(app, /data-action="select-task" data-id="\$\{escapeHtml\(task\.id\)\}"/);
  assert.match(app, /const thread = taskThreadMessage\(task\)/);
  assert.match(app, /const active = threadMessageId === thread\?\.id \? ' active' : ''/);
  assert.match(selectTaskSource, /const task = byId\(appState\.tasks, target\.dataset\.id\)/);
  assert.match(selectTaskSource, /const thread = task \? taskThreadMessage\(task\) : null/);
  assert.match(selectTaskSource, /threadMessageId = thread\.id/);
  assert.match(app, /if \(selectedTaskId\)[\s\S]*renderTaskDetail\(task\)/);
  assert.equal(app.includes('data-action="delete-task"'), false);
  assert.equal(cardSource.includes('pill(task.status'), false);
  assert.match(styles, /\.compact-task-card/);
  assert.match(styles, /\.task-detail-panel/);
});

test('global task board follows Slock board list channel filtering without cancelled task state', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const server = await readFile(new URL('../server/index.js', import.meta.url), 'utf8');

  assert.equal(app.includes("['cancelled', 'Cancelled']"), false);
  assert.equal(app.includes("task.status !== 'cancelled'"), false);
  assert.equal(app.includes("['done', 'cancelled']"), false);
  assert.equal(server.includes("task.status = 'cancelled'"), false);
  assert.equal(server.includes('cancelled_from_thread'), false);
  assert.match(app, /let taskViewMode = 'board'/);
  assert.match(app, /let taskChannelFilterIds = \[\]/);
  assert.match(app, /function renderTaskToolbar\(tasks, filteredTasks\)/);
  assert.match(app, /function renderTaskViewToggle\(\)/);
  assert.match(app, /function renderTaskChannelFilter\(\)/);
  assert.match(app, /function renderTaskListView\(tasks\)/);
  assert.match(app, /const channelTasks = \(appState\.tasks \|\| \[\]\)\.filter\(isVisibleChannelTask\)/);
  assert.match(app, /taskViewMode === 'list' \? renderTaskListView\(filteredTasks\) : renderTaskBoard\(filteredTasks\)/);
  assert.match(styles, /\.task-page-header/);
  assert.match(styles, /\.task-view-toggle/);
  assert.match(styles, /\.task-channel-menu/);
  assert.match(styles, /\.task-list-view/);
});

test('task status icons sync across messages threads saved and task detail', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const messageSource = app.slice(app.indexOf('function renderMessage'), app.indexOf('function renderComposer'));
  const threadsSource = app.slice(app.indexOf('function renderThreads'), app.indexOf('function renderSaved'));
  const savedSource = app.slice(app.indexOf('function renderSavedRecord'), app.indexOf('function renderSearch'));
  const taskCardSource = app.slice(app.indexOf('function renderTaskCard'), app.indexOf('function renderTaskActionButtons'));
  const lifecycleSource = app.slice(app.indexOf('function renderTaskLifecycle'), app.indexOf('function renderModal'));

  assert.match(app, /function taskStatusIcon\(status\)/);
  assert.match(app, /function renderTaskStatusBadge\(status, options = \{\}\)/);
  assert.match(app, /function renderTaskInlineBadge\(task, options = \{\}\)/);
  assert.match(app, /function renderTaskHoverCard\(task\)/);
  assert.match(app, /function renderTaskStateFlow\(task\)/);
  assert.match(app, /function renderTaskHistoryCompact\(task\)/);
  assert.match(messageSource, /renderTaskInlineBadge\(task/);
  assert.equal(messageSource.includes('pill(task.status'), false);
  assert.match(threadsSource, /renderThreadKindBadge\(message, task\)/);
  assert.match(savedSource, /renderTaskInlineBadge\(task/);
  assert.match(taskCardSource, /renderTaskInlineBadge\(task, \{ showAssignee: false, hover: false \}\)/);
  assert.match(lifecycleSource, /renderTaskStateFlow\(task\)/);
  assert.match(lifecycleSource, /renderTaskHistoryCompact\(task\)/);
  assert.equal(lifecycleSource.includes('<span>${escapeHtml(task.status)}</span>'), false);
  assert.equal(lifecycleSource.includes('<p>${escapeHtml(plainActorText(item.message))}</p>'), false);
  assert.match(styles, /\.task-status-icon-badge/);
  assert.match(styles, /\.task-inline-badge/);
  assert.match(styles, /\.task-hover-card/);
  assert.match(styles, /\.task-inline-badge:hover \.task-hover-card/);
  assert.match(styles, /\.task-state-flow/);
  assert.match(styles, /\.task-state-node\.current > span::before/);
  assert.match(styles, /@keyframes taskAutocastSpin/);
  assert.match(styles, /\.task-lifecycle-events/);
  assert.match(styles, /\.task-action-btn/);
  assert.match(styles, /\.thread-kind-badge/);
});

test('search input preserves IME composition and updates results without full rerender', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const searchInputSource = app.slice(app.indexOf("if (event.target.id === 'search-input')"), app.indexOf("if (event.target.id === 'add-member-search')"));

  assert.match(app, /let searchIsComposing = false/);
  assert.match(app, /document\.addEventListener\('compositionstart'/);
  assert.match(app, /document\.addEventListener\('compositionend'/);
  assert.match(searchInputSource, /updateSearchResults\(\)/);
  assert.equal(searchInputSource.includes('render();'), false);
  assert.match(app, /data-search-results/);
  assert.match(app, /searchVisibleCount = SEARCH_PAGE_SIZE/);
  assert.match(styles, /\.search-result-card/);
  assert.match(styles, /\.search-highlight/);
});

test('search covers messages and replies with local ranking helpers', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(app, /function searchRecords\(query\)/);
  assert.match(app, /\.\.\.\(appState\?\.messages \|\| \[\]\), \.\.\.\(appState\?\.replies \|\| \[\]\)/);
  assert.match(app, /function searchScore\(record, query\)/);
  assert.match(app, /function highlightSearchText\(text, query\)/);
  assert.match(app, /data-action="open-search-result"/);
  assert.match(app, /function openSearchResult\(record\)/);
  assert.match(app, /function scrollToReply\(replyId\)/);
});

test('search page matches Slock shortcuts filters persistence and thread drawer behavior', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const keydownSource = app.slice(app.indexOf("document.addEventListener('keydown'"), app.indexOf("document.addEventListener('pointerdown'"));
  const setViewSource = app.slice(app.indexOf("if (action === 'set-view')"), app.indexOf("if (action === 'set-rail-tab')"));
  const searchResultSource = app.slice(app.indexOf('function openSearchResult'), app.indexOf('function openSearchEntity'));

  assert.match(keydownSource, /event\.key\?\.toLowerCase\(\) === 'k'/);
  assert.match(keydownSource, /openSearchView\(\)/);
  assert.match(app, /function focusSearchInputEnd\(\)/);
  assert.match(setViewSource, /if \(activeView === 'search'\) focusSearchInputEnd\(\)/);
  assert.match(app, /data-action="toggle-search-mine"/);
  assert.match(app, /data-action="toggle-search-range-menu"/);
  assert.match(app, /data-action="clear-search-all"/);
  assert.match(app, /data-action="load-more-search"/);
  assert.match(app, /placeholder="Search channels, DIRECT MESSAGES, messages\.\.\."/);
  assert.match(searchResultSource, /activeView === 'search' && opensThread/);
  assert.match(searchResultSource, /threadMessageId = root\.id/);
  assert.equal(searchResultSource.includes("activeView = 'space';\n  activeTab = 'chat';\n  threadMessageId = opensThread"), true);
  assert.match(styles, /\.search-topbar/);
  assert.match(styles, /\.search-filter-row/);
  assert.match(styles, /\.search-center-state/);
  assert.match(styles, /\.search-time-menu/);
});

test('thread list rows keep the top-message avatar at the far left', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const threadsSource = app.slice(app.indexOf('function renderThreads'), app.indexOf('function renderSaved'));

  assert.match(threadsSource, /class="thread-row-avatar"/);
  assert.match(app, /function renderThreadRowAvatar\(message\)/);
  assert.match(threadsSource, /renderThreadRowAvatar\(message\)/);
  assert.match(styles, /\.thread-row \{[\s\S]*grid-template-columns: 32px minmax\(0, 1fr\) auto/);
  assert.match(styles, /\.thread-row-avatar/);
  assert.match(styles, /\.thread-list-avatar/);
});

test('task filter popover closes on outside clicks and list cards fit their content', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(app, /const clickedTaskChannelFilter = event\.target\.closest\('\.task-channel-filter'\)/);
  assert.match(app, /taskChannelMenuOpen && !clickedTaskChannelFilter/);
  assert.match(app, /taskChannelMenuOpen = false;[\s\S]*if \(!target\) \{[\s\S]*render\(\);[\s\S]*return;/);
  assert.match(styles, /\.task-list-body \.compact-task-card \{[\s\S]*max-height: none/);
  assert.match(styles, /\.task-list-body \.task-card-title \{[\s\S]*min-height: auto/);
  assert.match(styles, /\.task-list-body \.task-card-foot \{[\s\S]*line-height: 1\.15/);
});

test('member rail lists keep status dots on the far right only in the agent tab', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const agentListSource = app.slice(app.indexOf('function renderAgentListItem'), app.indexOf('function renderHumanListItem'));
  const humanListSource = app.slice(app.indexOf('function renderHumanListItem'), app.indexOf('function renderComputerListItem'));
  const computerListSource = app.slice(app.indexOf('function renderComputerListItem'), app.indexOf('function renderReply'));

  assert.match(agentListSource, /member-status-side/);
  assert.match(humanListSource, /member-status-side/);
  assert.match(computerListSource, /member-status-side/);
  assert.equal(agentListSource.includes("avatarStatusDot(agent.status"), false);
  assert.match(styles, /\.member-status-side/);
  assert.match(styles, /\.member-btn \.dm-avatar-wrap \.avatar-status-dot/);
  assert.match(styles, /\.message-card \.avatar-status-dot/);
});

test('message rows re-render when author presence changes from heartbeat', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const renderKeySource = app.slice(app.indexOf('function renderRecordKey'), app.indexOf('function renderSystemEvent'));

  assert.match(renderKeySource, /authorStatus: author\?\.status \|\| ''/);
  assert.match(renderKeySource, /record\?\.authorType === 'agent'/);
  assert.match(app, /function applyPresenceHeartbeat\(heartbeat\)/);
});

test('agent detail opened from a thread returns to that thread when closed', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(app, /let inspectorReturnThreadId = null/);
  assert.match(app, /if \(threadMessageId\) inspectorReturnThreadId = threadMessageId/);
  assert.match(app, /if \(inspectorReturnThreadId && byId\(appState\.messages, inspectorReturnThreadId\)\) \{[\s\S]*threadMessageId = inspectorReturnThreadId/);
  assert.match(app, /inspectorReturnThreadId = null;[\s\S]*render\(\);/);
});

test('selected thread rows keep the active highlight while the drawer is open', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(app, /const active = threadMessageId === message\.id \? ' active' : ''/);
  assert.match(app, /class="thread-row slock-thread-row\$\{active\}"/);
  assert.match(styles, /\.thread-row\.active/);
  assert.match(styles, /\.thread-list-panel/);
  assert.match(styles, /border: 1px solid #d4d1c8/);
});

test('messages use Slock-style hover save actions and saved messages open context', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(app, /function renderMessageActions\(record, options = \{\}\)/);
  assert.match(app, /Reply in thread/);
  assert.match(app, /Save message/);
  assert.match(app, /Remove from saved/);
  assert.match(app, /function renderSavedRecord\(record\)/);
  assert.match(app, /function savedRecords\(\)/);
  assert.match(app, /data-action="open-saved-message"/);
  assert.match(app, /data-action="remove-saved-message"/);
  assert.match(app, /if \(action === 'open-saved-message'\)/);
  assert.equal(app.includes('Unsave'), false);
  assert.match(styles, /\.message-hover-actions/);
  assert.match(styles, /\.saved-list-panel/);
  assert.match(styles, /\.saved-row/);
  assert.match(styles, /\.saved-remove/);
});

test('agent identities are clickable and expose Slock-style hover summaries', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const agentListSource = app.slice(app.indexOf('function renderAgentListItem'), app.indexOf('function renderHumanListItem'));

  assert.match(app, /function renderAgentHoverCard\(agent\)/);
  assert.match(app, /function renderAgentIdentityButton\(agentId, className = ''\)/);
  assert.match(app, /data-action="select-agent" data-id="\$\{escapeHtml\(agent\.id\)\}"/);
  assert.match(app, /data-agent-author-id="\$\{escapeHtml\(message\.authorId\)\}"/);
  assert.match(app, /data-agent-author-id="\$\{escapeHtml\(reply\.authorId\)\}"/);
  assert.equal(agentListSource.includes('renderAgentHoverCard'), false);
  assert.match(styles, /\.agent-hover-card/);
  assert.match(styles, /\.agent-hover-status-dot/);
  assert.equal(styles.includes('.member-btn:hover .agent-hover-card'), false);
});

test('agent detail uses Slock-style tabs with inline profile editing and autosaved model controls', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.equal(app.includes('id="agent-detail-form"'), false);
  assert.equal(app.includes('Save Profile'), false);
  assert.match(app, /let agentDetailTab = 'profile'/);
  assert.match(app, /function renderAgentProfileTab\(agent\)/);
  assert.match(app, /\['workspace', 'Workspace'\]/);
  assert.match(app, /data-action="set-agent-detail-tab" data-tab="\$\{id\}"/);
  assert.match(app, /renderAgentInlineField\(agent, 'name'/);
  assert.match(app, /renderAgentInlineField\(agent, 'description'/);
  assert.match(app, /function editPencilIcon\(\)/);
  assert.match(app, /class="agent-edit-icon"/);
  assert.match(app, /data-action="edit-agent-field" data-field="\$\{escapeHtml\(field\)\}"/);
  assert.match(app, /data-action="save-agent-field" data-field="\$\{escapeHtml\(field\)\}"/);
  assert.equal(app.includes('>Edit</button>'), false);
  assert.match(app, /maxlength="3000"[\s\S]*\$\{descriptionValue\.length\}\/3000/);
  assert.match(app, /data-action="update-agent-model"/);
  assert.match(app, /data-action="update-agent-reasoning"/);
  assert.match(app, /body: JSON\.stringify\(\{ model: target\.value \|\| null \}\)/);
  assert.match(app, /body: JSON\.stringify\(\{ reasoningEffort: target\.value \|\| null \}\)/);
  assert.match(app, />Reasoning</);
  assert.equal(app.includes('>Thinking</span>'), false);
  assert.match(app, /type="file"[\s\S]*data-action="upload-agent-avatar"/);
  assert.match(app, /data-action="start-agent"/);
  assert.match(app, /function renderAgentStartModal\(\)/);
  assert.match(app, /data-action="confirm-agent-start"/);
  assert.match(app, /data-action="open-agent-restart"/);
  assert.match(app, /data-action="agent-stop-unavailable"/);
  assert.match(app, /function renderAgentRestartModal\(\)/);
  assert.match(styles, /\.agent-detail-tabs/);
  assert.match(styles, /\.agent-inline-edit/);
  assert.match(styles, /\.agent-restart-option/);
});

test('agent avatar uploads open a square crop modal and persist a cropped image', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(app, /const AVATAR_CROP_SIZE = 256/);
  assert.match(app, /const AGENT_AVATAR_UPLOAD_MAX_BYTES = 10 \* 1024 \* 1024/);
  assert.match(app, /Avatar must be 10 MB or smaller/);
  assert.match(app, /let avatarCropState = null/);
  assert.match(app, /function openAvatarCropModal/);
  assert.match(app, /function renderAvatarCropModal\(\)/);
  assert.match(app, /function drawCroppedAvatarToDataUrl/);
  assert.match(app, /modal = 'avatar-crop'/);
  assert.match(app, /data-target="agent-create"/);
  assert.match(app, /target === 'agent-create'/);
  assert.match(app, /agentFormState\.avatar = avatar/);
  assert.match(app, /modal = crop\?\.target === 'agent-create' \? 'agent' : null/);
  assert.match(app, /data-action="avatar-crop-zoom-in"/);
  assert.match(app, /data-action="avatar-crop-zoom-out"/);
  assert.match(app, /data-action="confirm-avatar-crop"/);
  assert.match(app, /class="avatar-crop-overlay"/);
  assert.match(styles, /\.avatar-crop-square/);
  assert.match(styles, /\.avatar-crop-shade/);
  assert.match(styles, /aspect-ratio: 1 \/ 1/);
  assert.match(styles, /\.avatar-preview[\s\S]*object-fit: cover/);
  assert.match(styles, /\.avatar-option[\s\S]*object-fit: cover/);
});

test('create agent opens with a fresh form state every time', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(app, /function resetAgentFormState\(\)/);
  assert.match(app, /if \(modal === 'agent'\) \{\s*resetAgentFormState\(\);\s*await loadInstalledRuntimes\(\);/);
  assert.match(app, /if \(form\.id === 'agent-form'\)[\s\S]*resetAgentFormState\(\);\s*modal = null/);
});

test('Fan-out API config replaces the Brain Agent UI module', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const railSource = app.slice(app.indexOf('function renderRail'), app.indexOf('function renderNavItem'));
  const submitSource = app.slice(app.indexOf("document.addEventListener('submit'"), app.indexOf('refreshState().then'));

  assert.doesNotMatch(app, /function renderBrainAgentPanel\(\)/);
  assert.doesNotMatch(app, /function renderBrainAgentModal\(\)/);
  assert.doesNotMatch(app, /'brain-agent': renderBrainAgentModal/);
  assert.doesNotMatch(app, /id="brain-runtime-select"/);
  assert.doesNotMatch(styles, /\.brain-agent-row/);
  assert.doesNotMatch(styles, /\.brain-agent-use-btn/);
  assert.match(railSource, /const normalAgents = channelAssignableAgents\(\)/);
  assert.match(railSource, /normalAgents\.map\(\(agent\) => renderAgentListItem\(agent\)\)/);
  assert.match(railSource, /System Config/);
  assert.match(app, /function renderFanoutApiConfigCard\(\)/);
  assert.match(app, /id="fanout-config-form"/);
  assert.match(app, /Base URL/);
  assert.match(app, /API Key/);
  assert.match(app, /apiKeyPreview/);
  assert.match(app, /Enable LLM fan-out for ambiguous routing/);
  assert.match(submitSource, /form\.id === 'fanout-config-form'/);
  assert.match(submitSource, /\/api\/settings\/fanout/);
  assert.match(styles, /\.fanout-api-note/);
});

test('LLM fan-out decisions render stacked diagnostic cards only when LLM is used', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(app, /let fanoutDecisionCards = \[\]/);
  assert.match(app, /const seenFanoutRouteEventIds = new Set\(\)/);
  assert.match(app, /function trackFanoutRouteEvents\(nextState/);
  assert.match(app, /function enqueueFanoutDecisionCards\(routeEvent/);
  assert.match(app, /function renderFanoutDecisionToasts\(\)/);
  assert.match(app, /Fan-out API \/ Trigger/);
  assert.match(app, /Fan-out API \/ Decision/);
  assert.match(app, /Fan-out API \/ Validation/);
  assert.match(app, /if \(!event\.llmUsed\) continue/);
  assert.match(app, /trackFanoutRouteEvents\(nextState, \{ silent: !initialLoadComplete \|\| !appState \}\)/);
  assert.match(app, /trackFanoutRouteEvents\(nextState, \{ silent: !initialLoadComplete \}\)/);
  assert.match(styles, /\.fanout-toast-stack/);
  assert.match(styles, /\.fanout-toast-card/);
  assert.match(styles, /@keyframes fanoutToastIn/);
  assert.match(styles, /@keyframes fanoutToastOut/);
});

test('agent workspace tab has split tree and raw/preview markdown controls', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(app, /function renderAgentWorkspaceTab\(agent\)/);
  assert.match(app, /class="agent-workspace-tab"/);
  assert.match(app, /data-action="refresh-agent-workspace"/);
  assert.match(app, /data-action="set-agent-workspace-preview-mode" data-mode="raw"/);
  assert.match(app, /data-action="set-agent-workspace-preview-mode" data-mode="preview"/);
  assert.match(app, /agentWorkspacePreviewMode === 'preview'/);
  assert.match(app, /renderMarkdown\(file\.content \|\| ''\)/);
  assert.match(styles, /\.agent-workspace-layout/);
  assert.match(styles, /\.agent-workspace-sidebar/);
  assert.match(styles, /\.agent-workspace-viewer/);
});

test('agent activity tab renders newest first with second-level timestamps and a 5000 item cap', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(app, /const AGENT_ACTIVITY_EVENT_LIMIT = 5000/);
  assert.match(app, /function agentActivityEvents\(agent\)/);
  assert.match(app, /\.sort\(\(a, b\) => new Date\(b\.createdAt\) - new Date\(a\.createdAt\)\)/);
  assert.match(app, /\.slice\(0, AGENT_ACTIVITY_EVENT_LIMIT\)/);
  assert.match(app, /fmtTime\(event\.createdAt\)/);
  assert.match(app, /function renderAgentActivityTab\(agent\)/);
  assert.match(styles, /\.agent-activity-list/);
  assert.match(styles, /\.agent-activity-dot/);
});
