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

test('task cards are compact selectable blocks with detail inspector and no delete action', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const cardSource = app.slice(app.indexOf('function renderTaskCard'), app.indexOf('function renderTaskActionButtons'));

  assert.match(app, /function renderTaskDetail\(task\)/);
  assert.match(app, /data-action="select-task" data-id="\$\{escapeHtml\(task\.id\)\}"/);
  assert.match(app, /class="task-card compact-task-card\$\{selectedTaskId === task\.id \? ' active' : ''\}"/);
  assert.match(app, /if \(selectedTaskId\)[\s\S]*renderTaskDetail\(task\)/);
  assert.equal(app.includes('data-action="delete-task"'), false);
  assert.equal(cardSource.includes('pill(task.status'), false);
  assert.match(styles, /\.compact-task-card/);
  assert.match(styles, /\.task-detail-panel/);
});

test('global task board follows Slock board list channel filtering without cancelled task state', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.equal(app.includes("['cancelled', 'Cancelled']"), false);
  assert.match(app, /let taskViewMode = 'board'/);
  assert.match(app, /let taskChannelFilterIds = \[\]/);
  assert.match(app, /function renderTaskToolbar\(tasks, filteredTasks\)/);
  assert.match(app, /function renderTaskViewToggle\(\)/);
  assert.match(app, /function renderTaskChannelFilter\(\)/);
  assert.match(app, /function renderTaskListView\(tasks\)/);
  assert.match(app, /const channelTasks = \(appState\.tasks \|\| \[\]\)\.filter\(isVisibleChannelTask\)/);
  assert.match(app, /task\.status !== 'cancelled'/);
  assert.match(app, /taskViewMode === 'list' \? renderTaskListView\(filteredTasks\) : renderTaskBoard\(filteredTasks\)/);
  assert.match(styles, /\.task-page-header/);
  assert.match(styles, /\.task-view-toggle/);
  assert.match(styles, /\.task-channel-menu/);
  assert.match(styles, /\.task-list-view/);
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

test('selected thread rows keep the active highlight while the drawer is open', async () => {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');

  assert.match(app, /const active = threadMessageId === message\.id \? ' active' : ''/);
  assert.match(app, /class="thread-row\$\{active\}"/);
  assert.match(styles, /\.thread-row\.active/);
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
