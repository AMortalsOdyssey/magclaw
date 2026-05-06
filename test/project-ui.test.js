import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('project remove buttons render as icons instead of rem text', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.equal(/data-action="remove-project"[\s\S]*?>rem<\/button>/.test(app), false);
  assert.match(app, /class="project-remove-icon"/);
});

test('cloud account settings expose role-aware invitation controls', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const accountSettingsSource = app.slice(app.indexOf('function renderAccountSettingsTab()'), app.indexOf('function renderBrowserSettingsTab()'));

  assert.match(app, /function cloudRoleAllows\(role, allowedRole\)/);
  assert.match(app, /function cloudCan\(capability\)/);
  assert.match(accountSettingsSource, /const canInviteCloud = cloudCan\('invite_member'\)/);
  assert.match(accountSettingsSource, /const inviteRoleOptions = cloudInviteRoleOptions\(\)/);
  assert.match(accountSettingsSource, /\$\{canInviteCloud \? `[\s\S]*id="cloud-invite-form"/);
  assert.match(app, /function cloudInviteRoleOptions\(\)/);
  assert.match(app, /'core_member', 'Core Member'/);
  assert.match(app, /'member', 'Member'/);
  assert.doesNotMatch(accountSettingsSource, /value="viewer"|value="agent_admin"|value="computer_admin"|value="owner"/);
});

test('account profile uses a focused role layout with avatar picker controls', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const accountSettingsSource = app.slice(app.indexOf('function renderAccountSettingsTab()'), app.indexOf('function renderBrowserSettingsTab()'));

  assert.match(accountSettingsSource, /class="account-role-badge role-\$\{escapeHtml\(role\)\}"/);
  assert.match(accountSettingsSource, /data-action="pick-profile-avatar"/);
  assert.match(accountSettingsSource, /class="account-permission-chips"/);
  assert.doesNotMatch(accountSettingsSource, /Identity Boundary|<span>Device<\/span>|id="profile-avatar-library"/);
  assert.match(styles, /\.account-overview-card/);
  assert.match(styles, /\.account-role-badge strong/);
  assert.match(styles, /\.account-permission-chips span/);
  assert.match(styles, /\.profile-upload-btn,\n\.file-btn \{/);
});

test('sign out uses a confirmation modal before logging out', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const accountSettingsSource = app.slice(app.indexOf('function renderAccountSettingsTab()'), app.indexOf('function renderBrowserSettingsTab()'));

  assert.match(accountSettingsSource, /data-action="open-modal" data-modal="confirm-sign-out"[\s\S]*>Sign Out<\/button>/);
  assert.match(app, /'confirm-sign-out': renderSignOutConfirmModal/);
  assert.match(app, /function renderSignOutConfirmModal\(\)/);
  assert.match(app, /data-action="confirm-cloud-auth-logout"/);
  assert.match(app, /if \(action === 'confirm-cloud-auth-logout'\)/);
  assert.doesNotMatch(accountSettingsSource, /data-action="cloud-auth-logout"/);
  assert.match(styles, /\.modal-confirm-sign-out/);
  assert.match(styles, /\.modal-confirm-sign-out-backdrop/);
});

test('cloud account settings use server-configured sign-in without owner bootstrap UI', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const accountSettingsSource = app.slice(app.indexOf('function renderAccountSettingsTab()'), app.indexOf('function renderBrowserSettingsTab()'));

  assert.equal(accountSettingsSource.includes('id="cloud-owner-form"'), false);
  assert.equal(app.includes('/api/cloud/auth/bootstrap-owner'), false);
  assert.equal(app.includes('ownerConfigured'), false);
  assert.doesNotMatch(accountSettingsSource, /\bOwner\b/);
  assert.match(accountSettingsSource, /Sign-in Account/);
  assert.match(accountSettingsSource, /The initial sign-in account is configured on the server/);
  assert.doesNotMatch(accountSettingsSource, /Admin Login/);
  assert.match(app, /function renderCloudAuthGate/);
});

test('cloud auth gate only shows invite registration when an invite token is present', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const authGateSource = app.slice(app.indexOf('function renderCloudAuthGate('), app.indexOf('function renderBrowserSettingsTab()'));

  assert.match(authGateSource, /inviteTokenFromUrl \? `/);
  assert.match(authGateSource, /id="cloud-register-form"/);
  assert.doesNotMatch(authGateSource, /owner invite/);
  assert.doesNotMatch(authGateSource, /admin account configured|Admin access required|Admin login/i);
  assert.match(authGateSource, /Sign in to continue to your MagClaw workspace/);
  assert.match(authGateSource, /cloud-login-error/);
  assert.match(authGateSource, /role="alert" aria-live="polite"/);
  assert.match(authGateSource, /value="\$\{escapeHtml\(cloudLoginDraftEmail\)\}"/);
  assert.match(app, /Email or password is incorrect/);
  assert.match(app, /showCloudAuthGate\(error, \{ interactive: true \}\)/);
  assert.match(authGateSource, /<img src="\/favicon\.svg" alt="" \/>/);
  assert.match(authGateSource, /class="cloud-auth-shell"/);
  assert.match(authGateSource, /class="pixel-panel cloud-login-card"/);
  assert.match(authGateSource, /id="cloud-login-title">Welcome back!/);
  assert.match(styles, /\.cloud-auth-stage/);
  assert.match(styles, /\.cloud-login-card,/);
  assert.match(styles, /\.cloud-login-error/);
  assert.match(styles, /\.cloud-login-submit/);
});

test('cloud account settings prefill invite tokens from invite URLs', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const accountSettingsSource = app.slice(app.indexOf('function renderAccountSettingsTab()'), app.indexOf('function renderBrowserSettingsTab()'));

  assert.match(accountSettingsSource, /const inviteTokenFromUrl = new URLSearchParams\(window\.location\.search\)\.get\('token'\) \|\| ''/);
  assert.match(accountSettingsSource, /name="inviteToken"[\s\S]*value="\$\{escapeHtml\(inviteTokenFromUrl\)\}"/);
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
  assert.match(app, /const lastReplyAuthor = displayName\(previewRecord\?\.authorId \|\| message\.authorId\)/);
  assert.match(app, /const lastReplyAuthor = displayName\(previewRecord\.authorId\)/);
  assert.match(app, /function plainMentionText\(text\)/);
  assert.match(app, /function plainActorText\(text\)/);
  assert.match(app, /plainMentionText\(message\.body\)/);
});

test('thread rows use the last reply actor avatar and prefix the preview with the actor name', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const inboxItemSource = app.slice(app.indexOf('function buildThreadInboxItem('), app.indexOf('function buildDirectInboxItem('));
  const threadsSource = app.slice(app.indexOf('function renderThreads()'), app.indexOf('function renderSaved()'));

  assert.match(app, /function threadPreviewRecord\(message\)/);
  assert.match(app, /function threadPreviewText\(message\)/);
  assert.match(inboxItemSource, /const previewRecord = threadPreviewRecord\(message\)/);
  assert.match(inboxItemSource, /previewRecord,/);
  assert.match(inboxItemSource, /preview: threadPreviewText\(message\)/);
  assert.match(threadsSource, /const previewRecord = threadPreviewRecord\(message\)/);
  assert.match(threadsSource, /renderThreadRowAvatar\(previewRecord\)/);
  assert.match(threadsSource, /threadPreviewText\(message\)/);
  assert.match(app, /\$\{lastReplyAuthor\}：\$\{previewBody\}/);
  assert.doesNotMatch(app, /\$\{lastReply \? plainMentionText\(previewRecord\.body\)\.slice\(0, 140\) : 'latest'\} · \$\{lastReplyAuthor\}/);
});

test('chat rail keeps Threads and adds Inbox without a System notification tab', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const chatRailSource = app.slice(app.indexOf('function renderChatRail('), app.indexOf('function renderMembersRail('));

  assert.match(chatRailSource, /renderNavItem\('inbox', 'Inbox', 'inbox', inboxUnread \|\| '', \{ badgeKind: 'unread' \}\)/);
  assert.match(chatRailSource, /renderNavItem\('threads', 'Threads', 'message'/);
  assert.match(chatRailSource, /renderChannelItem\(channel, unreadCountForSpace\(spaceUnreadCounts, 'channel', channel\.id\)\)/);
  assert.match(chatRailSource, /renderDmItem\(dm\.id, displayName\(other\), status, agent\?\.avatar \|\| human\?\.avatar, unreadCountForSpace\(spaceUnreadCounts, 'dm', dm\.id\)\)/);
  assert.match(app, /function renderRailUnreadBadge\(count, label = 'unread messages'\)/);
  assert.match(app, /function buildSpaceUnreadCounts\(humanId = currentHumanId\(\), stateSnapshot = appState\)/);
  assert.match(app, /function markSpaceRead\(spaceType, spaceId\)/);
  assert.doesNotMatch(chatRailSource, /system-notifications|System Notification List/);
  assert.match(app, /if \(activeView === 'inbox'\) return renderInbox\(\)/);
  assert.doesNotMatch(app, /function renderSystemNotifications\(\)/);
  assert.match(styles, /\.rail-unread-badge/);
  assert.match(styles, /\.space-btn \.rail-unread-badge/);
});

test('inbox reuses thread rows and renders workspace activity drawer', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(app, /function renderInbox\(\)/);
  assert.match(app, /function buildInboxModel\(\)/);
  assert.match(app, /function renderWorkspaceActivityDrawer\(\)/);
  assert.match(app, /class="thread-row slock-thread-row inbox-row/);
  assert.match(app, /data-action="open-workspace-activity"/);
  assert.match(styles, /\.inbox-shell/);
  assert.match(styles, /\.workspace-activity-drawer/);
  assert.match(styles, /\.inbox-row\.unread::before/);
});

test('workspace uses dark icon rail, pink chat sidebar, and white main surfaces', async () => {
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const colorPass = styles.slice(styles.indexOf('Inbox redesign color pass'));
  const densityPass = styles.slice(styles.indexOf('Workspace density pass'));

  assert.match(colorPass, /\.slock-left-rail,[\s\S]*\.rail-icon-only \{[\s\S]*background: var\(--magclaw-rail\)/);
  assert.match(colorPass, /\.slock-sidebar,[\s\S]*background: var\(--bg-chat\)/);
  assert.match(colorPass, /\.workspace,[\s\S]*\.thread-list-panel,[\s\S]*\.search-results,[\s\S]*\.inbox-page[\s\S]*background: #ffffff/);
  assert.match(colorPass, /\.thread-row:hover,[\s\S]*background: var\(--accent-soft\)/);
  assert.match(densityPass, /\.collab-frame \{[\s\S]*font-family: -apple-system/);
  assert.match(densityPass, /\.collab-frame \.slock-left-rail \{[\s\S]*border-right: 1px solid var\(--workspace-line-strong\)/);
  assert.match(densityPass, /\.collab-frame \.space-header,[\s\S]*\.collab-frame \.task-page-header,[\s\S]*\.collab-frame \.agent-detail-topbar,[\s\S]*border-bottom: 1px solid var\(--workspace-line-strong\)/);
  assert.match(densityPass, /\.collab-frame \.nav-item,[\s\S]*\.collab-frame \.space-btn \{[\s\S]*font-size: 13px/);
  assert.match(densityPass, /\.collab-frame \.computers-page > \.cloud-layout \{[\s\S]*padding: 0 20px 22px/);
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

test('human mention chips use a distinct color from agent mentions', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(app, /mention-identity mention-agent/);
  assert.match(app, /mention-human/);
  assert.match(styles, /\.mention-tag\.mention-human/);
  assert.match(styles, /background: #9FE3D1/);
  assert.match(styles, /color: #0B302A/);
});

test('channel mention chips render in yellow', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(app, /mention-special\$\{channelClass\}/);
  assert.match(app, /mention-tag mention-channel/);
  assert.match(app, /function renderPlainChannelMentions\(html\)/);
  assert.match(app, /renderPlainChannelMentions\(html\)/);
  assert.match(styles, /\.mention-tag\.mention-channel/);
  assert.match(styles, /background: #FFE15A/);
  assert.match(styles, /color: #1A1A1A/);
});

test('human messages and thread replies render agent pickup avatars from work items', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(app, /const AGENT_RECEIPT_VISIBLE_LIMIT = 10/);
  assert.match(app, /function deliveryReceiptItemsForRecord\(record\)/);
  assert.match(app, /item\?\.sourceMessageId === record\.id/);
  assert.match(app, /function renderAgentReceiptTray\(record\)/);
  assert.match(app, /function renderMessageFooter\(\{ replyCountChip = '', receiptTray = '' \} = \{\}\)/);
  assert.match(app, /record\.authorType === 'agent'/);
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
  assert.match(app, /class="app-frame collab-frame\$\{inspectorHtml \? '' : ' no-inspector'\}\$\{taskFocusLayout \? ' task-focus' : ''\}[\s\S]*\$\{notificationBanner \? ' notification-banner-active' : ''\}"/);
  assert.match(app, /let selectedTaskId = null/);
  assert.match(app, /function renderInspector\(\)[\s\S]*if \(selectedAgentId\)/);
  assert.match(app, /selectedAgentId = null;[\s\S]*selectedSpaceType = target\.dataset\.type/);
  assert.match(styles, /\.app-frame\.no-inspector/);
});

test('members navigation preserves chat layout until an agent is explicitly selected', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const leftNavSource = app.slice(app.indexOf("if (action === 'set-left-nav')"), app.indexOf("if (action === 'select-agent')"));
  const selectAgentSource = app.slice(app.indexOf("if (action === 'select-agent')"), app.indexOf("if (action === 'close-agent-detail')"));

  assert.match(app, /let membersLayout = normalizeMembersLayout\(initialUiState\.membersLayout\)/);
  assert.match(app, /function rememberMembersLayoutFromCurrent\(\)/);
  assert.match(app, /function restoreMembersLayout\(\)/);
  assert.match(app, /function openMembersNav\(\)/);
  assert.match(app, /if \(activeView === 'members'\) return renderMembersMain\(\)/);
  assert.match(app, /function renderInspector\(\) \{\s*if \(activeView === 'members'\) return '';/);
  assert.match(leftNavSource, /const agentId = openMembersNav\(\)/);
  assert.doesNotMatch(leftNavSource, /channelAssignableAgents\(\)\[0\]/);
  assert.match(selectAgentSource, /if \(railTab === 'members'\) \{[\s\S]*activeView = 'members'[\s\S]*rememberMembersLayoutFromCurrent\(\)/);
  assert.match(styles, /\.workspace > \.agent-detail-shell/);
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
  assert.match(app, /function snapshotComposerState\(form, composerId/);
  assert.match(app, /function clearComposerForSubmit\(form, composerId/);
  assert.match(app, /function restoreComposerAfterFailedSubmit\(form, composerId/);
  assert.match(renderSource, /restorePendingComposerFocus\(\)/);
  assert.match(submitSource, /let focusComposerId = null/);
  assert.match(submitSource, /const messageSnapshot = snapshotComposerState\(form, composerId, \{ includeTask: true \}\);[\s\S]*clearComposerForSubmit\(form, composerId, \{ clearTask: true \}\);[\s\S]*const result = await api/);
  assert.match(submitSource, /const replySnapshot = snapshotComposerState\(form, composerId\);[\s\S]*clearComposerForSubmit\(form, composerId\);[\s\S]*await api/);
  assert.match(submitSource, /`\/api\/messages\/\$\{threadMessageId\}\/replies`/);
  assert.match(submitSource, /restoreComposerAfterFailedSubmit\(form, composerId, messageSnapshot, \{ restoreTask: true \}\)/);
  assert.match(submitSource, /restoreComposerAfterFailedSubmit\(form, composerId, replySnapshot\)/);
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
  const selectSpaceSource = app.slice(app.indexOf("if (action === 'select-space')"), app.indexOf("if (action === 'set-tab')"));
  const setTabSource = app.slice(app.indexOf("if (action === 'set-tab')"), app.indexOf("if (action === 'task-filter')"));

  assert.match(app, /const UI_STATE_KEY = 'magclawUiState'/);
  assert.match(app, /const PANE_SCROLL_KEY = 'magclawPaneScroll'/);
  assert.match(app, /function readStoredUiState\(\)/);
  assert.match(app, /function persistUiState\(\)/);
  assert.match(app, /function readStoredPaneScrolls\(\)/);
  assert.match(app, /function normalizeStoredPaneScroll\(value\)/);
  assert.match(app, /function persistPaneScroll\(targetName, node\)/);
  assert.match(app, /atBottom: paneIsAtBottom\(node\)/);
  assert.match(app, /function persistVisiblePaneScrolls\(\)/);
  assert.match(app, /function targetDefaultAtBottom\(targetName\)/);
  assert.match(renderSource, /persistUiState\(\)/);
  assert.match(scrollListenerSource, /persistPaneScroll\('main', event\.target\)/);
  assert.match(scrollListenerSource, /persistPaneScroll\('thread', event\.target\)/);
  assert.match(selectSpaceSource, /persistVisiblePaneScrolls\(\);[\s\S]*selectedSpaceType = target\.dataset\.type/);
  assert.match(setTabSource, /persistVisiblePaneScrolls\(\);[\s\S]*activeTab = target\.dataset\.tab/);
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

test('global task board follows Slock board list channel filtering without stopped task state', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const server = await readFile(new URL('../server/index.js', import.meta.url), 'utf8');

  assert.equal(app.includes("['stopped', 'Stopped']"), false);
  assert.equal(app.includes("task.status !== 'stopped'"), false);
  assert.equal(app.includes("['done', 'stopped']"), false);
  assert.equal(server.includes("task.status = 'stopped'"), false);
  assert.equal(server.includes('stopped_from_thread'), false);
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

test('thread list rows keep the latest actor avatar at the far left', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const threadsSource = app.slice(app.indexOf('function renderThreads'), app.indexOf('function renderSaved'));

  assert.match(threadsSource, /class="thread-row-avatar"/);
  assert.match(app, /function renderThreadRowAvatar\(record\)/);
  assert.match(threadsSource, /const previewRecord = threadPreviewRecord\(message\)/);
  assert.match(threadsSource, /renderThreadRowAvatar\(previewRecord\)/);
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
  assert.match(app, /const incomingHumansById = new Map/);
  assert.match(app, /humans,\n    updatedAt: heartbeat\.updatedAt/);
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
  const openThreadSource = app.slice(app.indexOf("if (action === 'open-thread')"), app.indexOf("if (action === 'open-search-result'"));

  assert.match(app, /function renderMessageActions\(record, options = \{\}\)/);
  assert.match(app, /Reply in thread/);
  assert.match(app, /Save message/);
  assert.match(app, /Remove from saved/);
  assert.match(openThreadSource, /requestComposerFocus\(composerIdFor\('thread', threadMessageId\)\)/);
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
  assert.match(app, /\['skills', 'Skills'\]/);
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
  assert.match(app, /'update-agent-model',/);
  assert.match(app, /'update-agent-reasoning',/);
  assert.match(app, /body: JSON\.stringify\(\{ model: target\.value \|\| null \}\)/);
  assert.match(app, /body: JSON\.stringify\(\{ reasoningEffort: target\.value \|\| null \}\)/);
  assert.match(app, />Reasoning</);
  assert.equal(app.includes('>Thinking</span>'), false);
  assert.match(app, /type="file"[\s\S]*data-action="upload-agent-avatar"/);
  assert.match(app, /data-action="pick-agent-detail-avatar"/);
  assert.match(app, /data-action="start-agent"/);
  assert.match(app, /function renderAgentStartModal\(\)/);
  assert.match(app, /data-action="confirm-agent-start"/);
  assert.match(app, /data-action="open-agent-restart"/);
  assert.match(app, /data-action="agent-stop-unavailable"/);
  assert.match(app, /function renderAgentRestartModal\(\)/);
  assert.match(app, /function renderAgentSkillsTab\(agent\)/);
  assert.match(app, /data-action="refresh-agent-skills"/);
  assert.match(app, /Function Calls \/ Tools/);
  assert.match(app, /renderAgentToolCapsules/);
  assert.match(app, /function agentSkillCount\(skills\)/);
  assert.match(app, /renderSkillCollapseButton\('profile-skills', 'Skills'\)/);
  assert.match(app, /renderAgentSkillSections\(skills, \{ compact: true \}\)/);
  assert.equal(app.includes('renderSkillChips'), false);
  assert.match(styles, /\.agent-detail-tabs/);
  assert.match(styles, /\.skill-row/);
  assert.match(styles, /\.agent-skill-section-stack\.compact/);
  assert.match(styles, /\.agent-tool-pill/);
  assert.match(styles, /\.agent-inline-edit/);
  assert.match(styles, /\.agent-restart-option/);
});

test('sidebar settings and skill panels support collapsible MagClaw UI sections', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(app, /const SIDEBAR_SECTION_COLLAPSE_KEY = 'magclawSidebarSectionCollapse'/);
  assert.match(app, /const SKILL_SECTION_COLLAPSE_KEY = 'magclawSkillSectionCollapse'/);
  assert.match(app, /function renderRailSectionTitle\(section, label, count/);
  assert.match(app, /data-action="toggle-sidebar-section"/);
  assert.match(app, /data-action="toggle-agent-skill-section"/);
  assert.match(app, /Agent-Isolated Skills/);
  assert.match(app, /Global Codex Skills/);
  assert.match(app, /Plugin Skills/);
  assert.match(app, /function renderSettingsRail\(\)/);
  assert.match(app, /function renderSettingsChrome\(body, actions = ''\)/);
  assert.match(app, /function renderComputersRail\(\)/);
  assert.match(app, /data-action="set-settings-tab"/);
  assert.match(app, /System Config/);
  assert.match(app, /Release Notes/);
  assert.match(app, /hidden warmup turns/);
  assert.match(styles, /\.rail-collapse-btn/);
  assert.match(styles, /\.skill-collapse-btn/);
  assert.match(styles, /\.settings-nav-list/);
  assert.match(styles, /\.settings-page-header/);
  assert.match(styles, /\.settings-release/);
  assert.match(styles, /\.release-note-row/);
});

test('left rail and active shell controls use the MagClaw pink accent', async () => {
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(styles, /--magclaw-rail:\s*var\(--accent\)/);
  assert.match(styles, /--magclaw-rail-badge:\s*#FFE15A/);
  assert.match(styles, /\.rail > \.slock-left-rail \{[\s\S]*?background:\s*var\(--magclaw-rail\)/);
  assert.match(styles, /\.left-rail-avatar \{[\s\S]*?color:\s*var\(--magclaw-rail\)/);
  assert.match(styles, /\.left-rail-btn em \{[\s\S]*?background:\s*var\(--magclaw-rail-badge\)[\s\S]*?color:\s*var\(--magclaw-rail-badge-text\)/);
  assert.match(styles, /\.agent-detail-tabs button\.active \{[\s\S]*?background:\s*var\(--accent\)/);
  assert.equal(/background:\s*var\(--slock-sun\)/.test(styles), false);
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

test('human presence uses browser heartbeat and settings clears agent detail', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(app, /const HUMAN_PRESENCE_HEARTBEAT_MS = 30 \* 1000/);
  assert.match(app, /function sendHumanPresenceHeartbeat\(\)/);
  assert.match(app, /api\('\/api\/cloud\/auth\/heartbeat', \{ method: 'POST', body: '\{\}' \}\)/);
  assert.match(app, /function humanStatusDot\(authorId, authorType\)/);
  assert.match(app, /getAvatarHtml\(authorId, authorType, 'avatar-inner'\)\}\$\{humanStatusDot\(authorId, authorType\)\}/);
  assert.match(app, /if \(action === 'set-settings-tab'\)[\s\S]*selectedAgentId = null/);
});

test('create agent opens with a fresh form state every time', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

  assert.match(app, /function resetAgentFormState\(\)/);
  assert.match(app, /if \(modal === 'agent'\) \{\s*resetAgentFormState\(\);\s*await loadInstalledRuntimes\(\);/);
  assert.match(app, /if \(form\.id === 'agent-form'\)[\s\S]*resetAgentFormState\(\);\s*modal = null/);
});

test('Fan-out API config owns the routing settings UI', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const railSource = app.slice(app.indexOf('function renderRail'), app.indexOf('function renderNavItem'));
  const submitSource = app.slice(app.indexOf("document.addEventListener('submit'"), app.indexOf('refreshState().then'));

  assert.match(railSource, /const normalAgents = channelAssignableAgents\(\)/);
  assert.match(railSource, /normalAgents\.map\(\(agent\) => renderAgentListItem\(agent\)\)/);
  assert.match(railSource, /System Config/);
  assert.match(app, /function renderSystemSettingsTab\(\)/);
  assert.match(app, /settingsTab === 'system'/);
  assert.match(app, /function renderComputersRail\(\)/);
  assert.doesNotMatch(app.slice(app.indexOf('function renderComputersRail'), app.indexOf('function renderSettingsRail')), /Fan-out API/);
  assert.doesNotMatch(railSource, /renderNavItem\('cloud', 'System'/);
  assert.match(app, /function renderFanoutApiConfigCard\(\)/);
  assert.match(app.slice(app.indexOf('function renderSystemSettingsTab'), app.indexOf('function renderReleaseNotesSettingsTab')), /renderFanoutApiConfigCard\(\)/);
  assert.match(app, /id="fanout-config-form"/);
  assert.match(app, /Base URL/);
  assert.match(app, /Fallback Model/);
  assert.match(app, /Timeout/);
  assert.match(app, /API Key/);
  assert.match(app, /apiKeyPreview/);
  assert.match(app, /Enable async LLM supplement for ambiguous routing/);
  assert.match(app, /Force LLM Keywords/);
  assert.match(app, /fallbackModel: data\?\.get\('fallbackModel'\)/);
  assert.match(app, /timeoutMs: data\?\.get\('timeoutMs'\)/);
  assert.match(app, /forceKeywords: data\?\.get\('forceKeywords'\)/);
  assert.match(submitSource, /form\.id === 'fanout-config-form'/);
  assert.match(submitSource, /\/api\/settings\/fanout/);
  assert.match(styles, /\.fanout-api-note/);
});

test('LLM fan-out decisions render one concise route toast only when LLM is used', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const fanoutToast = await readFile(new URL('../public/fanout-toast.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(app, /from '\.\/fanout-toast\.js'/);
  assert.match(app, /let fanoutDecisionCards = \[\]/);
  assert.match(app, /const seenFanoutRouteEventIds = new Set\(\)/);
  assert.match(app, /function trackFanoutRouteEvents\(nextState/);
  assert.match(app, /function enqueueFanoutDecisionCards\(routeEvent/);
  assert.match(app, /function renderFanoutDecisionToasts\(\)/);
  assert.match(app, /renderFanoutDecisionToastsHtml\(fanoutDecisionCards\)/);
  assert.match(app, /document\.body\.appendChild\(next\)/);
  assert.doesNotMatch(app, /\$\{renderFanoutDecisionToasts\(\)\}/);
  assert.match(fanoutToast, /LLM fan-out/);
  assert.match(fanoutToast, /路由到：/);
  assert.match(fanoutToast, /原因：/);
  assert.match(fanoutToast, /export function buildFanoutDecisionCards/);
  assert.match(fanoutToast, /export function renderFanoutDecisionToasts/);
  assert.match(app, /fanoutDecisionCards = \[card\]/);
  assert.match(app, /const newLlmEvents = \[\]/);
  assert.match(app, /enqueueFanoutDecisionCards\(newLlmEvents\.at\(-1\), nextState\)/);
  assert.doesNotMatch(fanoutToast, /Fan-out API \/ Trigger/);
  assert.doesNotMatch(fanoutToast, /Fan-out API \/ Decision/);
  assert.doesNotMatch(fanoutToast, /Fan-out API \/ Validation/);
  assert.match(app, /if \(!event\.llmUsed\) continue/);
  assert.match(app, /trackFanoutRouteEvents\(nextState, \{ silent: !initialLoadComplete \|\| !appState \}\)/);
  assert.match(app, /trackFanoutRouteEvents\(nextState, \{ silent: !initialLoadComplete \}\)/);
  assert.match(styles, /\.fanout-toast-stack/);
  assert.match(styles, /\.fanout-toast-card/);
  assert.match(styles, /@keyframes fanoutToastIn/);
  assert.match(styles, /@keyframes fanoutToastOut/);
});

test('browser agent notifications can be enabled from a Slock-style prompt and settings card', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(app, /const NOTIFICATION_PREF_KEY = 'magclawNotificationPrefs'/);
  assert.match(app, /function renderNotificationPromptBanner\(\)/);
  assert.match(app, /function renderNotificationConfigCard\(\)/);
  assert.match(app, /Notification\.requestPermission\(\)/);
  assert.match(app, /new Notification\(notificationTitle\(record, stateSnapshot\)/);
  assert.match(app, /trackAgentNotifications\(nextState, \{ silent: !initialLoadComplete \|\| !appState \}\)/);
  assert.match(app, /trackAgentNotifications\(nextState, \{ silent: !initialLoadComplete \}\)/);
  assert.match(app, /data-action="enable-agent-notifications"/);
  assert.match(app, /data-action="disable-agent-notifications"/);
  assert.match(app, /data-action="dismiss-agent-notifications"/);
  assert.match(app, /renderNotificationConfigCard\(\)/);
  assert.match(styles, /\.notification-banner/);
  assert.match(styles, /\.notification-config-card/);
  assert.match(styles, /\.app-frame\.notification-banner-active/);
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
