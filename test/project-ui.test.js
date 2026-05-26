import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';


async function readStylesSource() {
  const publicRoot = new URL('../public/', import.meta.url);
  const entry = await readFile(new URL('styles.css', publicRoot), 'utf8');
  const imports = [...entry.matchAll(/@import url\("\.\/([^"\)]+)"\);/g)].map((match) => match[1]);
  const imported = await Promise.all(imports.map((name) => readFile(new URL(name, publicRoot), 'utf8')));
  return [entry, ...imported].join('\n');
}

async function readAppSource() {
  const app = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
  const appDir = new URL('../public/app/', import.meta.url);
  const chunks = [...app.matchAll(/['"]\/app\/([^'"]+)['"]/g)]
    .map((match) => match[1]);
  if (!chunks.length) chunks.push(...(await readdir(appDir)).filter((name) => name.endsWith('.js')).sort());
  const chunkSources = await Promise.all(
    chunks
      .map((name) => readFile(new URL(name, appDir), 'utf8')),
  );
  return [app, ...chunkSources].join('\n');
}

// Local project folder linking is temporarily hidden until cloud-safe access exists.
test.skip('project remove buttons render as icons instead of rem text', async () => {
  const app = await readAppSource();

  assert.equal(/data-action="remove-project"[\s\S]*?>rem<\/button>/.test(app), false);
  assert.match(app, /class="project-remove-icon"/);
});

test('task board exposes closed state and member proposal review controls', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const taskSource = app.slice(app.indexOf('const taskColumns = ['), app.indexOf('function renderTaskDetail'));
  const modalSource = app.slice(app.indexOf('function renderChannelMembersModal()'), app.indexOf('function renderAddChannelMemberModal()'));
  const clickSource = app.slice(app.indexOf("if (action === 'task-claim')"), app.indexOf("if (action === 'leave-channel')"));

  assert.match(taskSource, /\['closed', 'Closed'\]/);
  assert.match(taskSource, /function taskIsClosedStatus\(status\)[\s\S]*status === 'closed'/);
  assert.match(taskSource, /const flowColumns = taskColumns/);
  assert.match(taskSource, /status !== 'closed' && index < currentIndex/);
  assert.match(taskSource, /data-action="task-close"/);
  assert.match(clickSource, /\/api\/tasks\/\$\{target\.dataset\.id\}\/close/);
  assert.match(app, /channelMemberProposals/);
  assert.match(app, /data-action="accept-member-proposal"/);
  assert.match(app, /data-action="decline-member-proposal"/);
  assert.match(app, /\/api\/channel-member-proposals\/\$\{proposalId\}\/accept/);
  assert.match(app, /\/api\/channel-member-proposals\/\$\{proposalId\}\/decline/);
  assert.match(styles, /\.task-status-closed/);
  assert.match(styles, /\.member-proposal-card/);
});

test('create task modal uses a title-only form and multi-agent picker rows', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const taskModalSource = app.slice(app.indexOf('function renderTaskAssigneeOption('), app.indexOf('function renderEnvVarsList()'));
  const taskSubmitSource = app.slice(app.indexOf("if (form.id === 'task-form')"), app.indexOf("if (form.id === 'agent-form')"));

  assert.match(taskModalSource, /modalHeader\('CREATE TASK'/);
  assert.match(taskModalSource, /name="title"[\s\S]*required/);
  assert.doesNotMatch(taskModalSource, />Body</);
  assert.doesNotMatch(taskModalSource, /textarea name="body"/);
  assert.doesNotMatch(taskModalSource, /select name="assigneeIds"/);
  assert.match(taskModalSource, /task-assignee-picker/);
  assert.match(taskModalSource, /task-assignee-option/);
  assert.match(taskModalSource, /type="checkbox" name="assigneeIds"/);
  assert.match(taskModalSource, /getAvatarHtml\(agent\.id, 'agent', 'dm-avatar[^']*'\)/);
  assert.match(taskModalSource, /Add another after create/);
  assert.match(taskModalSource, /data-action="close-modal"[\s\S]*Cancel/);
  assert.match(taskSubmitSource, /input\[name="assigneeIds"\]:checked/);
  assert.doesNotMatch(taskSubmitSource, /body:\s*data\.get\('body'\)/);
  assert.match(styles, /\.task-assignee-picker/);
  assert.match(styles, /\.task-assignee-option:has\(input\[type="checkbox"\]:checked\)/);
});

test('unjoined channels render read-only chat controls with a join action', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();

  assert.match(app, /function currentUserIsChannelMember\(channelOrId\)/);
  assert.match(app, /function renderChannelJoinPanel\(channelOrId/);
  assert.match(app, /data-action="join-channel"/);
  assert.match(app, /\/api\/channels\/\$\{encodeURIComponent\(channelId\)\}\/join/);
  assert.match(app, /Join this channel before sending messages/);
  assert.match(app, /Join this channel before replying in the thread/);
  assert.match(styles, /\.channel-join-panel/);
  assert.match(styles, /\.channel-join-btn/);
});

test('members settings expose role-aware invitation controls', async () => {
  const app = await readAppSource();
  const accountSettingsSource = app.slice(app.indexOf('function renderAccountSettingsTab()'), app.indexOf('function normalizeInviteEmailValue(value)'));
  const membersSettingsSource = app.slice(app.indexOf('function normalizeInviteEmailValue(value)'), app.indexOf('function renderCloudAuthGate('));
  const railSource = app.slice(app.indexOf('function settingsNavItems()'), app.indexOf('function settingsIcon('));

  assert.match(app, /function cloudRoleAllows\(role, allowedRole\)/);
  assert.match(app, /function cloudCan\(capability\)/);
  assert.doesNotMatch(railSource, /System Config/);
  assert.match(railSource, /Server[\s\S]*Members[\s\S]*Release Notes/);
  assert.match(railSource, /id: 'members'/);
  assert.match(membersSettingsSource, /id="member-invite-form"/);
  assert.match(membersSettingsSource, /memberInviteValidCount\(\)/);
  assert.match(membersSettingsSource, /data-action="copy-member-generated-link"/);
  assert.match(membersSettingsSource, /data-action="copy-all-member-generated-links"/);
  assert.match(membersSettingsSource, /Email:[\s\S]*Link:/);
  assert.match(app, /\/api\/cloud\/invitations\/batch/);
  assert.match(app, /\/api\/cloud\/password-resets/);
  assert.match(app, /function cloudInviteRoleOptions\(\)/);
  assert.match(app, /function cloudMemberManageRoleOptions\(\)/);
  const inviteRoleOptionsSource = app.slice(app.indexOf('function cloudInviteRoleOptions()'), app.indexOf('function cloudMemberManageRoleOptions'));
  const manageRoleOptionsSource = app.slice(app.indexOf('function cloudMemberManageRoleOptions()'), app.indexOf('function cloudCanRemoveMemberRole'));
  assert.doesNotMatch(inviteRoleOptionsSource, /invite_admin/);
  assert.match(inviteRoleOptionsSource, /options\.push\(\['member', 'Member'\]\)[\s\S]*options\.push\(\['admin', 'Admin'\]\)/);
  assert.match(manageRoleOptionsSource, /options\.push\(\['member', 'Member'\]\)[\s\S]*options\.push\(\['admin', 'Admin'\]\)[\s\S]*options\.push\(\['owner', 'Owner'\]\)/);
  assert.match(manageRoleOptionsSource, /manage_member_roles/);
  assert.match(manageRoleOptionsSource, /manage_owner_role/);
  assert.match(app, /let latestInvitationLink = null/);
  assert.match(app, /let cloudGeneratedLinks = \[\]/);
  assert.match(app, /function generatedLinkText\(item\)/);
  assert.match(app, /async function tryCopyTextToClipboard\(text\)[\s\S]*catch/);
  assert.match(app, /tryCopyTextToClipboard\(generatedLinksText\(\)\)/);
  assert.match(app, /'admin', 'Admin'/);
  assert.match(app, /'owner', 'Owner'/);
  assert.match(app, /'member', 'Member'/);
  assert.match(membersSettingsSource, /member-role-badge/);
  assert.doesNotMatch(accountSettingsSource, /id="cloud-invite-form"|Workspace Members/);
  assert.doesNotMatch(accountSettingsSource, /value="viewer"|value="agent_admin"|value="computer_admin"|value="owner"/);
});

test('computer and agent creation entrances honor cloud capabilities', async () => {
  const app = await readAppSource();
  const computersSource = app.slice(app.indexOf('function renderComputers()'), app.indexOf('function renderComputerConfigCard()'));
  const computerCardSource = app.slice(app.indexOf('function renderComputerConfigCard()'), app.indexOf('function renderFanoutApiConfigCard()'));
  const computerRailSource = app.slice(app.indexOf('function renderComputersRail()'), app.indexOf('function renderSettingsRail()'));
  const modalSource = app.slice(app.indexOf('function renderAgentModal()'), app.indexOf('function renderHumanModal()'));

  assert.match(computersSource, /cloudCan\('manage_computers'\)/);
  assert.match(computersSource, /cloudCan\('manage_agents'\)/);
  assert.match(computerCardSource, /cloudCan\('manage_computers'\)/);
  assert.match(computerRailSource, /cloudCan\('manage_computers'\)/);
  assert.match(modalSource, /!cloudCan\('manage_agents'\)/);
  assert.match(modalSource, /!cloudCan\('manage_computers'\)/);
});

test('computer connect modal creates a fresh command before rendering stale state', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const modalSource = app.slice(app.indexOf('function pairingCommandIsUsable'), app.indexOf('function renderHumanModal()'));
  const detailSource = app.slice(app.indexOf('function renderComputerDetail(computer)'), app.indexOf('function renderComputerConfigCard()'));
  const clickSource = app.slice(app.indexOf('async function generateFreshComputerPairingCommand'), app.indexOf("if (action === 'agent-stop-unavailable')"));
  const closeModalSource = app.slice(app.indexOf("if (action === 'close-modal')"), app.indexOf("if (localOnlyActions.has(action))"));
  const pairingActionsSource = app.slice(app.indexOf("if (action === 'create-computer-pairing')"), app.indexOf("if (action === 'copy-join-link')"));
  const regenerateActionSource = app.slice(app.indexOf("if (action === 'regenerate-computer-command')"), app.indexOf("if (action === 'refresh-computer-pairing-command')"));
  const refreshActionSource = app.slice(app.indexOf("if (action === 'refresh-computer-pairing-command')"), app.indexOf("if (action === 'copy-join-link')"));
  const stateUpdateSource = app.slice(app.indexOf('function applyStateUpdate(nextState)'), app.indexOf('function applyRunEventUpdate'));
  const offlineCommandSource = app.slice(app.indexOf('function selectedOfflineComputerForCommand'), app.indexOf('async function switchConsoleServerAndLoadState'));
  const discardSource = app.slice(app.indexOf('async function discardProvisionalPairingComputer'), app.indexOf('async function switchConsoleServerAndLoadState'));

  assert.match(app, /async function generateFreshComputerPairingCommand\(body = \{\}\)/);
  assert.match(app, /async function discardProvisionalPairingComputer\(pairingCommand = latestPairingCommand\)/);
  assert.match(app, /latestPairingCommand\.displayName = requestedDisplayName/);
  assert.match(app, /appState = await api\('\/api\/state'\)/);
  assert.match(app, /let offlineComputerCommandRequestKey = ''/);
  assert.match(app, /window\.setTimeout\(ensureOfflineComputerConnectCommand, 0\)/);
  assert.match(offlineCommandSource, /activeView !== 'computers'/);
  assert.match(offlineCommandSource, /String\(computer\.status \|\| ''\)\.toLowerCase\(\) === 'connected'/);
  assert.match(offlineCommandSource, /pairingCommandIsUsable\(latestPairingCommand\)/);
  assert.match(offlineCommandSource, /await generateFreshComputerPairingCommand\(\{ computerId: computer\.id, name: displayName, displayName \}\)/);
  assert.match(clickSource, /await generateFreshComputerPairingCommand\(\{ name: defaultComputerPairingName\(\) \}\)/);
  assert.match(clickSource, /const pairingCommand = await generateFreshComputerPairingCommand\(\{ name: defaultComputerPairingName\(\) \}\)/);
  assert.match(pairingActionsSource, /await generateFreshComputerPairingCommand\(body\)/);
  assert.match(regenerateActionSource, /modal = 'computer'/);
  assert.match(regenerateActionSource, /displayName:/);
  assert.match(refreshActionSource, /computerPairingDisplayName\.trim\(\)/);
  assert.match(modalSource, /function pairingCommandIsUsable/);
  assert.match(modalSource, /function pairingCommandText/);
  assert.match(modalSource, /function pairingCommandDisplayText/);
  assert.match(modalSource, /function setupCommandDisplayText/);
  assert.match(modalSource, /function renderPairingCommandOption/);
  assert.match(modalSource, /id="computer-display-name-input"/);
  assert.match(modalSource, /--display-name/);
  assert.match(modalSource, /connect-options-frame/);
  assert.match(modalSource, /reconnectingExistingComputer/);
  assert.match(modalSource, /Connect Command/);
  assert.match(modalSource, /title: 'Computer'/);
  assert.doesNotMatch(modalSource, /badge: 'Beta'/);
  assert.match(modalSource, /latestPairingCommand\?\.computerCommand/);
  assert.match(modalSource, /different machines create their own Computers for this server/);
  assert.match(modalSource, /targets the selected Computer/);
  assert.match(modalSource, /Optional: add <code>--background<\/code>/);
  assert.doesNotMatch(modalSource, /registers its daemon as a background service\./);
  assert.match(app, /let computerPairingCommandError = ''/);
  assert.match(app, /let pairingCommandCopyAcknowledgedKind = ''/);
  assert.doesNotMatch(app, /let pairingCommandCopyAcknowledged = false/);
  assert.match(app, /function normalizedPairingCommandKind/);
  assert.match(app, /function resetPairingCommandCopyAcknowledgement/);
  assert.match(app, /function updatePairingCommandCopyButtons/);
  assert.match(app, /button\.classList\.toggle\('is-copied', copied\)/);
  assert.match(app, /icon\.textContent = copied \? '✓' : '⧉'/);
  assert.match(app, /pairingCommandCopyAcknowledgedKind === normalizedKind/);
  assert.match(app, /pairingCommandCopyAcknowledgedKind = commandKind/);
  assert.match(app, /if \(pairingCommandCopyAcknowledgedKind === commandKind\) pairingCommandCopyAcknowledgedKind = ''/);
  const copyPairingSource = app.slice(app.indexOf("if (action === 'copy-pairing-command')"), app.indexOf("if (action === 'dismiss-app-flash')"));
  assert.match(copyPairingSource, /updatePairingCommandCopyButtons\(\)/);
  assert.doesNotMatch(copyPairingSource, /render\(\)/);
  assert.match(app, /connect-option-card\[data-command-kind="connect"\]/);
  assert.match(app, /code\.textContent = pairingCommandDisplayText\(\)/);
  assert.match(app, /data-command-kind="\$\{escapeHtml\(normalizedKind\)\}"/);
  assert.match(app, /target\.dataset\.commandKind/);
  assert.match(app, /latestPairingCommand\?\.computerCommand \|\| latestPairingCommand\?\.setupCommand/);
  assert.match(detailSource, /Connection Options/);
  assert.match(detailSource, /computer-detail-connect-options/);
  assert.match(detailSource, /renderPairingCommandOption\(\{\s*title: 'Connect Command'/);
  assert.match(detailSource, /renderPairingCommandOption\(\{\s*title: 'Computer'/);
  assert.match(detailSource, /currentPairingCommand\?\.computerCommand \|\| currentPairingCommand\?\.setupCommand/);
  assert.match(styles, /\.connect-option-card:hover/);
  assert.match(styles, /\.connect-options-frame:has\(\.connect-option-card:hover\) \.connect-option-card:not\(:hover\)/);
  assert.match(styles, /filter: grayscale\(0\.55\)/);
  assert.match(styles, /background: rgba\(230, 230, 230, 0\.56\)/);
  const connectOptionHoverSource = styles.slice(styles.indexOf('.connect-option-card:hover'), styles.indexOf('.connect-options-frame:has(.connect-option-card:hover)'));
  const connectCopyHoverSource = styles.slice(styles.indexOf('.connect-copy-btn:hover'), styles.indexOf('.connect-copy-btn.is-copied'));
  assert.doesNotMatch(connectOptionHoverSource, /transform:/);
  assert.doesNotMatch(connectCopyHoverSource, /transform:/);
  assert.match(modalSource, /computerPairingCommandError \|\| 'Generating command\.\.\.'/);
  assert.match(clickSource, /if \(modal === 'computer'\) renderShellOrModal\(\)/);
  assert.match(clickSource, /if \(modal !== 'computer'\) \{\s*await discardProvisionalPairingComputer\(pairingCommand\);\s*return;\s*\}\s*render\(\);/);
  assert.match(modalSource, /function defaultComputerPairingName/);
  assert.match(modalSource, /computerNameLooksLikeCloudHost/);
  assert.match(modalSource, /token\.consumedAt \|\| token\.revokedAt/);
  assert.match(modalSource, /expiresAtMs <= Date\.now\(\)/);
  assert.match(modalSource, /const stale = Boolean\(command && !pairingCommandIsUsable\(latestPairingCommand\)\)/);
  assert.match(modalSource, /presenceClass\(connected \? 'connected' : \(stale \|\| commandError\) \? 'offline' : 'queued'\)/);
  assert.doesNotMatch(modalSource, /pendingComputerId && !liveComputer/);
  assert.match(clickSource, /latestPairingCommand\.provisional = !body\.computerId/);
  assert.match(clickSource, /computerPairingDisplayName = ''/);
  assert.match(app, /'computer-display-name'/);
  assert.match(discardSource, /shouldDiscardPairingComputer/);
  assert.match(discardSource, /await refreshState\(\)/);
  assert.ok(
    discardSource.indexOf('await refreshState()') < discardSource.indexOf('const liveComputer'),
    'computer provisional discard must refresh server state before deciding whether the computer is still unpaired',
  );
  assert.match(discardSource, /await api\(`\/api\/computers\/\$\{encodeURIComponent\(pairingComputer\.id\)\}`,\s*\{ method: 'DELETE' \}\)/);
  assert.match(discardSource, /latestPairingCommand\?\.computer\?\.id === pairingComputer\.id/);
  assert.match(closeModalSource, /await discardProvisionalPairingComputer\(latestPairingCommand\)/);
  assert.match(app, /function computerPairingModalRenderSignature/);
  assert.match(stateUpdateSource, /computerModalBefore !== computerPairingModalRenderSignature\(appState\)/);
  assert.doesNotMatch(stateUpdateSource, /if \(modal === 'computer'\) render\(\);/);
});

test('computer name editor survives realtime rerenders', async () => {
  const app = await readAppSource();
  const stateSource = app.slice(app.indexOf('let selectedComputerId'), app.indexOf('let serverSwitcherOpen'));
  const computerSource = app.slice(app.indexOf('function renderComputerDetail'), app.indexOf('function renderComputerConfigCard()'));
  const clickSource = app.slice(app.indexOf("if (action === 'edit-computer-name'"), app.indexOf("if (action === 'open-agent-restart'"));
  const inputSource = app.slice(app.indexOf("document.addEventListener('input'"));
  const updateSource = app.slice(app.indexOf('function applyStateUpdate'), app.indexOf('function applyRunEventUpdate'));

  assert.match(stateSource, /let computerNameEditState = \{ computerId: null \}/);
  assert.match(stateSource, /let computerNameFieldDraft = null/);
  assert.match(app, /function computerNameEditIsActive\(\)/);
  assert.match(app, /function captureComputerNameFieldDraft/);
  assert.match(app, /function computerNameFieldValueForRender/);
  assert.match(computerSource, /const nameIsEditing = computerNameEditState\?\.computerId === computer\.id/);
  assert.match(computerSource, /data-action="edit-computer-name"/);
  assert.match(computerSource, /data-action="cancel-computer-name"/);
  assert.doesNotMatch(computerSource, /<details class="pixel-panel cloud-card wide computer-name-card">/);
  assert.match(clickSource, /computerNameEditState = \{ computerId: target\.dataset\.id \|\| selectedComputerId \}/);
  assert.match(clickSource, /clearComputerNameFieldDraft\(\)/);
  assert.match(inputSource, /computer-name-line/);
  assert.match(updateSource, /computerNameEditIsActive\(\)/);
  assert.match(updateSource, /captureComputerNameFieldDraft\(\)/);
});

test('computer daemon upgrade UI only appears when actionable and shows one state', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const upgradeSource = app.slice(app.indexOf('function computerUpgradeStatusLabel'), app.indexOf('function renderComputerAgentCard'));
  const computerSource = app.slice(app.indexOf('function renderComputerDetail'), app.indexOf('function renderComputerConfigCard()'));
  const clickSource = app.slice(app.indexOf("if (action === 'upgrade-computer-daemon'"), app.indexOf("if (action === 'regenerate-computer-command'"));
  const confirmClickStart = app.indexOf("if (action === 'confirm-daemon-upgrade'");
  const confirmClickSource = app.slice(confirmClickStart, app.indexOf("if (action === 'close-modal'", confirmClickStart));

  assert.match(app, /function computerDaemonUpgradeState\(/);
  assert.match(app, /function computerUpgradeStatusLabel\(/);
  assert.match(app, /function activeComputerUpgradeStatusLabel\(/);
  assert.match(app, /if \(upgradeLabel === 'Updated'\) return ''/);
  assert.doesNotMatch(app, /if \(upgradeLabel === 'Updated' && updateAvailable\) return ''/);
  assert.match(app, /function computerDaemonServiceReady\(/);
  assert.match(app, /function daemonUpdateAvailable\(/);
  assert.match(app, /function renderDaemonUpgradePanel\(/);
  assert.match(app, /function daemonUpgradeDisabledMessage\(/);
  assert.match(app, /service\.background === true/);
  assert.match(app, /service\.active === true/);
  assert.match(app, /const shouldShowUpgradePanel = updateAvailable \|\| upgradeVisible/);
  assert.match(upgradeSource, /const activeUpgradeLabel = activeComputerUpgradeStatusLabel\(upgradeLabel, updateAvailable\)/);
  assert.match(app, /data-action="upgrade-computer-daemon"/);
  assert.match(app, /let daemonUpgradeConfirmState = \{ computerId: null \}/);
  assert.match(app, /'daemon-upgrade-confirm': renderDaemonUpgradeConfirmModal/);
  assert.match(app, /function renderDaemonUpgradeConfirmModal\(\)/);
  assert.match(app, /data-action="confirm-daemon-upgrade"/);
  assert.match(app, /if \(action === 'confirm-daemon-upgrade'\)/);
  assert.match(computerSource, /renderDaemonUpgradePanel\(computer/);
  assert.match(computerSource, /\$\{escapeHtml\(computerPackageLabel\(computer\)\)\} Version[\s\S]*\$\{daemonUpgradePanel\}/);
  assert.match(app, /'Update manually': '请手动更新'/);
  assert.match(upgradeSource, /Waiting for update/);
  assert.match(upgradeSource, /Updating/);
  assert.match(upgradeSource, /Update manually/);
  assert.doesNotMatch(upgradeSource, /请手动更新|等待更新|升级中|已回退/);
  assert.doesNotMatch(computerSource, /sr-only[\s\S]*Waiting for update[\s\S]*Updating[\s\S]*Rolled back/);
  assert.match(confirmClickSource, /\/api\/computers\/\$\{encodeURIComponent\(computerId\)\}\/daemon-upgrade/);
  assert.match(confirmClickSource, /daemonUpgradeConfirmState = \{ computerId: null \};[\s\S]*modal = null;[\s\S]*render\(\);[\s\S]*const result = await api/);
  assert.match(clickSource, /dataset\.upgradeDisabledReason/);
  assert.doesNotMatch(clickSource, /window\.confirm/);
  assert.doesNotMatch(confirmClickSource, /window\.confirm/);
  assert.match(app, /waiting_for_upgrade/);
  assert.match(app, /upgrade_pending/);
  assert.match(styles, /\.status-crystal/);
  assert.match(styles, /\.daemon-upgrade-panel/);
  assert.match(styles, /\.daemon-upgrade-panel\.available/);
  assert.match(styles, /\.daemon-upgrade-panel\.blocked/);
  assert.match(styles, /\.daemon-version-value\.upgrade-pending/);
  assert.match(styles, /\.daemon-version-value\.upgrading/);
});

test('computer upgrade UI is package-aware for daemon and computer entry packages', async () => {
  const app = await readAppSource();
  const computerSource = app.slice(app.indexOf('function renderComputerDetail'), app.indexOf('function renderComputerConfigCard()'));
  const listSource = app.slice(app.indexOf('function renderComputerListItem'), app.indexOf('function renderReply'));
  const confirmClickStart = app.indexOf("if (action === 'confirm-daemon-upgrade'");
  const confirmClickSource = app.slice(confirmClickStart, app.indexOf("if (action === 'close-modal'", confirmClickStart));

  assert.match(app, /function computerPackageKind\(/);
  assert.match(app, /function computerPackageName\(/);
  assert.match(app, /function computerPackageLatestVersion\(/);
  assert.match(app, /function computerPackageVersionLabel\(/);
  assert.match(app, /appState\.runtime\?\.computerLatestVersion/);
  assert.match(computerSource, /\$\{escapeHtml\(computerPackageLabel\(computer\)\)\} Version/);
  assert.match(listSource, /computerPackageVersionLabel\(computer\)/);
  assert.match(confirmClickSource, /packageName: computerPackageName\(computer\)/);
  assert.match(confirmClickSource, /targetVersion: computerPackageLatestVersion\(computer\)/);
  assert.match(app, /MagClaw will ask the \$\{escapeHtml\(packageLabel\.toLowerCase\(\)\)\} package to upgrade/);
  assert.doesNotMatch(app, /computer \$\{escapeHtml\(packageLabel\.toLowerCase\(\)\)\} package/);
  assert.match(app, /Queue \$\{escapeHtml\(packageLabel\.toLowerCase\(\)\)\} upgrade/);
});

test('left rail navigation refreshes shared package versions and renders update reminders', async () => {
  const app = await readAppSource();
  const refreshStateSource = app.slice(app.indexOf('async function refreshState()'), app.indexOf('function cloudAuthErrorMessage'));
  const applyStateSource = app.slice(app.indexOf('function applyStateUpdate'), app.indexOf('function applyRunEventUpdate'));
  const computerDetailSignatureSource = app.slice(app.indexOf('function computerDetailRenderSignature'), app.indexOf('function applyStateUpdate'));
  const packageCacheSource = app.slice(app.indexOf('let packageVersionRefreshInFlight'), app.indexOf('async function refreshState()'));
  const railSource = app.slice(app.indexOf('function renderRail()'), app.indexOf('function accountRailInitial'));
  const computerRailSource = app.slice(app.indexOf('function renderComputersRail()'), app.indexOf('function renderSettingsRail()'));
  const computerSource = app.slice(app.indexOf('function renderComputerDetail'), app.indexOf('function renderComputerConfigCard()'));
  const computerListSource = app.slice(app.indexOf('function renderComputerListItem'), app.indexOf('function cloudMemberForHuman'));
  const navSource = app.slice(app.indexOf("if (action === 'set-left-nav'"), app.indexOf("if (action === 'select-agent'"));
  const selectComputerSource = app.slice(app.indexOf("if (action === 'select-computer'"), app.indexOf("if (action === 'edit-computer-name'"));

  assert.match(app, /const PACKAGE_VERSION_CACHE_KEY = 'magclawPackageVersions:v1'/);
  assert.match(app, /const PACKAGE_VERSION_CACHE_TTL_MS = 10 \* 60_000/);
  assert.match(app, /function readCachedPackageVersionSnapshot\(/);
  assert.match(app, /function applyPackageVersionSnapshot\(/);
  assert.match(app, /async function ensurePackageVersionsForCurrentServer/);
  assert.match(app, /function connectedComputerPackageUpdateCount\(/);
  assert.match(app, /function computerPackageUpdateBadge\(/);
  assert.match(app, /function refreshPackageVersionReminders\(/);
  assert.match(app, /api\('\/api\/package-versions'\)/);
  assert.doesNotMatch(packageCacheSource, /serverSlug/);
  assert.doesNotMatch(packageCacheSource, /activeView === 'computers'/);
  assert.match(refreshStateSource, /await ensurePackageVersionsForCurrentServer\(\{ renderAfter: false \}\)/);
  assert.match(navSource, /refreshPackageVersionReminders\(\)/);
  assert.match(selectComputerSource, /refreshPackageVersionReminders\(\)/);
  assert.match(applyStateSource, /if \(activeView === 'computers'\) \{[\s\S]*render\(\);[\s\S]*return;/);
  assert.match(railSource, /const packageUpdateCount = typeof connectedComputerPackageUpdateCount === 'function'[\s\S]*?connectedComputerPackageUpdateCount\(\)/);
  assert.doesNotMatch(railSource, /server-switcher-trigger[^`]+has-package-update/);
  assert.doesNotMatch(railSource, /server-switcher-trigger[\s\S]*computerPackageUpdateBadge\(\{ count: packageUpdateCount/);
  assert.match(railSource, /renderLeftRailButton\('desktop'[\s\S]*packageUpdateCount \? '!' : ''/);
  assert.doesNotMatch(railSource, /renderLeftRailButton\('console'[\s\S]*sessionSummaryLlmIssueNotifications\(\)\.length \? '!' : ''/);
  assert.doesNotMatch(computerRailSource, /computerPackageUpdateBadge\(\{ count: updateCount/);
  assert.match(computerListSource, /computerPackageUpdateBadge\(computer/);
  assert.match(computerListSource, /title="\$\{escapeHtml\(name\)\}"/);
  assert.match(computerSource, /computerPackageUpdateBadge\(computer/);
  assert.match(app, /function railComputerSignature\(/);
  assert.match(applyStateSource, /const railComputersBefore = railComputerSignature\(appState\)/);
  assert.match(applyStateSource, /const railComputersChanged = railComputersBefore !== railComputerSignature\(appState\)/);
  assert.match(applyStateSource, /const railNeedsPatch = unreadChanged \|\| railComputersChanged/);
  assert.match(applyStateSource, /if \(railNeedsPatch\) patchRailSurface\(\)/);
  assert.match(computerDetailSignatureSource, /selected\.packageVersion/);
  assert.match(computerDetailSignatureSource, /selected\.service\?\.mode/);
});

test('computer rail rows truncate long names without horizontal scrolling', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const rootStyles = await readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
  const computerListSource = app.slice(app.indexOf('function renderComputerListItem'), app.indexOf('function cloudMemberForHuman'));

  assert.match(computerListSource, /title="\$\{escapeHtml\(name\)\}"/);
  assert.match(styles, /\.rail-section \{[\s\S]*overflow-x: hidden;[\s\S]*overflow-y: auto;/);
  assert.match(styles, /\.rail-title span \{[\s\S]*overflow: hidden;[\s\S]*text-overflow: ellipsis;/);
  assert.match(styles, /\.member-info \{[\s\S]*min-width: 0;[\s\S]*overflow: hidden;/);
  assert.match(styles, /\.computer-row-name \{[\s\S]*min-width: 0;[\s\S]*max-width: 100%;[\s\S]*overflow: hidden;/);
  assert.match(styles, /\.computer-row-name \.dm-name \{[\s\S]*text-overflow: ellipsis;/);
  assert.match(styles, /\.computer-row-meta \{[\s\S]*max-width: 100%;[\s\S]*text-overflow: ellipsis;/);
  assert.doesNotMatch(rootStyles, /\.computer-row-name/);
});

test('computer close UI uses a mode-aware confirmation modal', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const modalSource = app.slice(app.indexOf('function renderModal()'), app.indexOf('function renderServerCreateModal()'));
  const computerSource = app.slice(app.indexOf('function renderComputerDetail'), app.indexOf('function renderComputerConfigCard()'));
  const confirmStart = app.indexOf("if (action === 'confirm-computer-close'");
  const confirmSource = app.slice(confirmStart, app.indexOf("if (action === 'close-modal'", confirmStart));
  const closeModalSource = app.slice(app.indexOf("if (action === 'close-modal'"), app.indexOf("if (localOnlyActions.has(action))"));

  assert.match(app, /let computerCloseConfirmState = \{ computerId: null \}/);
  assert.match(app, /function computerRunModeLabel\(/);
  assert.match(app, /function renderComputerCloseConfirmModal\(\)/);
  assert.match(modalSource, /'computer-close-confirm': renderComputerCloseConfirmModal/);
  assert.match(computerSource, /data-action="open-computer-close-confirm"/);
  assert.match(computerSource, /Close Computer/);
  const closeActionIndex = computerSource.indexOf('<strong>Close Computer</strong>');
  const disableActionIndex = computerSource.indexOf("<strong>${disabled ? 'Enable Computer' : 'Disable Computer'}</strong>");
  assert.ok(closeActionIndex !== -1);
  assert.ok(disableActionIndex !== -1);
  assert.ok(closeActionIndex < disableActionIndex, 'Close Computer should appear before Disable Computer');
  assert.match(app, /Runtime mode/);
  assert.match(app, /Foreground terminal/);
  assert.match(app, /Background service/);
  assert.match(app, /Computer mode/);
  assert.match(app, /computer-close-mode-list/);
  assert.match(app, /computer-close-mode-row/);
  assert.match(app, /data-action="confirm-computer-close"/);
  assert.match(confirmSource, /\/api\/computers\/\$\{encodeURIComponent\(computerId\)\}\/close/);
  assert.match(confirmSource, /method: 'POST'/);
  assert.doesNotMatch(confirmSource, /window\.confirm/);
  assert.match(closeModalSource, /computerCloseConfirmState = \{ computerId: null \}/);
  assert.match(styles, /\.modal-computer-close-confirm/);
  assert.match(styles, /\.modal-computer-close-confirm \.computer-close-mode-list/);
  assert.match(styles, /\.modal-computer-close-confirm \.computer-close-mode-row/);
  assert.match(styles, /grid-template-columns: minmax\(104px, 0\.34fr\) minmax\(0, 1fr\)/);
});

test('computer runtime fallback cannot downgrade computer-reported installed runtimes', async () => {
  const app = await readAppSource();
  const runtimeSource = app.slice(app.indexOf('function computerRuntimeDetails'), app.indexOf('function runtimeNameForId'));

  assert.match(runtimeSource, /function mergeComputerRuntimeDetail/);
  assert.match(runtimeSource, /const baseInstalled = Object\.prototype\.hasOwnProperty\.call\(base, 'installed'\)[\s\S]*base\.installed !== false/);
  assert.match(runtimeSource, /installed: runtime\.installed !== false \|\| baseInstalled/);
  assert.match(runtimeSource, /version: runtime\.version \|\| base\.version \|\| ''/);
  assert.match(runtimeSource, /path: runtime\.path \|\| base\.path \|\| ''/);
});

test('computer detail shows a one-line connection summary', async () => {
  const app = await readAppSource();
  const computerSource = app.slice(app.indexOf('function renderComputerDetail'), app.indexOf('function renderComputerConfigCard()'));

  assert.match(app, /function computerConnectionSummary\(/);
  assert.match(app, /Connection:/);
  assert.match(app, /Daemon · Background service/);
  assert.match(app, /Daemon · Foreground terminal/);
  assert.match(app, /Computer · Browser-paired background/);
  assert.match(computerSource, /const connectionSummary = computerConnectionSummary\(computer\)/);
  assert.match(computerSource, /class="computer-connection-line"/);
  assert.match(computerSource, /connectionSummary\.label/);
});

test('computer connection summary treats launchd as foreground when background flag is false', async () => {
  const app = await readAppSource();
  const source = app.slice(app.indexOf('function computerRunModeLabel'), app.indexOf('function renderComputerCloseConfirmModal'));
  const helpers = vm.runInNewContext(`${source}; ({ computerRunModeLabel, computerConnectionSummary });`, {
    computerPackageKind: (computer = {}) => String(computer.packageKind || computer.connectedVia || 'daemon').toLowerCase(),
  });

  const foregroundComputer = {
    connectedVia: 'daemon',
    packageKind: 'daemon',
    service: { mode: 'launchd', background: false, active: false },
  };
  assert.equal(helpers.computerRunModeLabel(foregroundComputer).label, 'Foreground terminal');
  assert.equal(helpers.computerConnectionSummary(foregroundComputer).label, 'Daemon · Foreground terminal');

  const backgroundComputer = {
    connectedVia: 'daemon',
    packageKind: 'daemon',
    service: { mode: 'launchd', background: true, active: true },
  };
  assert.equal(helpers.computerRunModeLabel(backgroundComputer).label, 'Background service');
  assert.equal(helpers.computerConnectionSummary(backgroundComputer).label, 'Daemon · Background service (launchd)');
});

test('computers detail page preserves scroll through background renders', async () => {
  const app = await readAppSource();
  const computersSource = app.slice(app.indexOf('function renderComputers()'), app.indexOf('function fmtFullDateTime'));
  const renderSource = app.slice(app.indexOf('function render()'), app.indexOf('function renderRail()'));

  assert.match(computersSource, /const scrollKey = selected\?\.id \? `computers:\$\{selected\.id\}` : 'computers:list'/);
  assert.match(computersSource, /<section class="computers-page" data-page-scroll-surface data-scroll-key="\$\{escapeHtml\(scrollKey\)\}">/);
  assert.match(renderSource, /page: pageScrollSnapshot\(\)/);
  assert.match(renderSource, /restorePageScroll\(scrollSnapshot\.page\)/);
});

test('agent creation guard prevents duplicate submit rerenders', async () => {
  const app = await readAppSource();
  const stateSource = app.slice(app.indexOf('let selectedComputerId'), app.indexOf('let serverSwitcherOpen'));
  const submitSource = app.slice(app.indexOf("if (form.id === 'agent-form')"), app.indexOf("if (form.id === 'agent-runtime-config-form')"));
  const modalSource = app.slice(app.indexOf('function renderAgentModal()'), app.indexOf('function renderAvatarPickerModal()'));

  assert.match(stateSource, /let agentCreateInFlight = false/);
  assert.match(modalSource, /agentCreateInFlight \? 'Creating\.\.\.' : 'Create Agent'/);
  assert.match(submitSource, /if \(agentCreateInFlight\)/);
  assert.match(submitSource, /agentCreateInFlight = true/);
  assert.match(submitSource, /agentCreateInFlight = false/);
});

test('members page uses a join-ordered directory with invite modals', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const membersSettingsSource = app.slice(app.indexOf('function normalizeInviteEmailValue(value)'), app.indexOf('function renderCloudAuthGate('));
  const membersMainSource = app.slice(app.indexOf('function renderMembersMain()'));
  const modalSource = app.slice(app.indexOf('function renderModal()'), app.indexOf('function modalHeader('));

  assert.match(app, /function renderMembersDirectory/);
  assert.doesNotMatch(membersMainSource, /renderMembersDirectory\(\{ context: 'main' \}\)/);
  assert.match(membersMainSource, /renderHumanDetail\(human\)/);
  assert.match(membersMainSource, /renderAgentDetail\(agent\)/);
  assert.match(membersSettingsSource, /renderMembersDirectory\(\{ context: 'settings' \}\)/);
  assert.match(app, /const MEMBERS_PAGE_SIZE = 50/);
  assert.match(app, /function compareMemberDirectoryRows\(a, b\)/);
  assert.match(app, /function membersPaginationModel\(rows = buildMembersRows\(\)\)/);
  assert.match(app, /<span>Name<\/span>[\s\S]*<span>Status<\/span>[\s\S]*<span>Last active<\/span>[\s\S]*<span>Role<\/span>/);
  assert.doesNotMatch(membersSettingsSource, />Heartbeat<\/span>|上次活动时间|已加入|邀请中|刚刚|分钟前|小时前|个月前|添加团队成员|发送邀请|邀请链接|无限制/);
  assert.match(app, /data-modal="member-invite"[\s\S]*>Invite<\/button>/);
  assert.match(app, /const humanModal = cloudCan\('invite_member'\) \? 'member-invite' : ''/);
  assert.doesNotMatch(app, /renderRailSectionTitle\('humans', 'Humans', humans\.length, \{ modal: 'human' \}\)/);
  assert.match(app, /data-action="members-page-prev"/);
  assert.match(app, /data-action="members-page-next"/);
  assert.match(app, /data-action="members-page-go"/);
  assert.match(app, /id="members-page-input"/);
  assert.doesNotMatch(membersSettingsSource, /members-workspace-card|members-workspace-avatar/);
  assert.match(modalSource, /'member-invite': renderMemberInviteModal/);
  assert.match(modalSource, /'member-invite-links': renderMemberInviteLinksModal/);
  assert.match(modalSource, /if \(!String\(content\)\.trim\(\)\) \{[\s\S]*modal = null/);
  assert.match(styles, /\.members-directory-shell/);
  assert.match(styles, /\.members-page-header/);
  assert.match(styles, /\.members-pagination/);
  assert.match(styles, /\.modal-member-invite/);
  assert.match(styles, /\.member-invite-links-list/);
});

test('members directory separates roles from top-centered manage actions', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const rowSource = app.slice(app.indexOf('function renderMemberRow(row)'), app.indexOf('function renderMemberInviteTrigger()'));
  const manageSource = app.slice(app.indexOf('function renderMemberManageModal()'), app.indexOf('function renderMemberRow(row)'));
  const modalSource = app.slice(app.indexOf('function renderModal()'), app.indexOf('function modalHeader('));
  const roleUpdateSource = app.slice(app.lastIndexOf("if (action === 'update-cloud-member-role')"), app.indexOf("if (action === 'leave-channel')"));

  assert.match(app, /let memberManageState = \{ memberId: null \}/);
  assert.match(app, /let memberActionConfirmState = \{ memberId: null, action: null \}/);
  assert.match(app, /let memberResetLinkState = \{ email: '', link: '' \}/);
  assert.match(app, /function renderMemberManageModal\(\)/);
  assert.match(app, /function renderMemberActionConfirmModal\(\)/);
  assert.match(app, /function renderMemberResetLinkModal\(\)/);
  assert.match(modalSource, /'member-manage': renderMemberManageModal/);
  assert.match(modalSource, /'member-action-confirm': renderMemberActionConfirmModal/);
  assert.match(modalSource, /'member-reset-link': renderMemberResetLinkModal/);
  assert.match(app, /<span>Role<\/span>\s*<span>Manage<\/span>/);
  assert.match(rowSource, /class="member-role-badge"/);
  assert.match(rowSource, /data-action="open-member-manage"/);
  assert.doesNotMatch(rowSource, /reset-cloud-member-password|remove-cloud-member|update-cloud-member-role/);
  assert.match(manageSource, /class="member-manage-role-form"/);
  assert.match(manageSource, /data-member-role-form/);
  assert.match(manageSource, /data-member-role-context="modal"/);
  assert.match(manageSource, /data-member-role-select/);
  assert.match(manageSource, /data-action="update-cloud-member-role"/);
  assert.match(app, /You cannot remove your own Owner role/);
  assert.match(app, /Only another Owner can change this Owner role/);
  assert.match(manageSource, /data-action="open-member-action-confirm"[\s\S]*data-member-action="reset-password"/);
  assert.match(manageSource, /data-action="open-member-action-confirm"[\s\S]*data-member-action="remove"/);
  assert.doesNotMatch(manageSource, /reset-cloud-member-password|remove-cloud-member/);
  assert.match(app, /if \(action === 'update-cloud-member-role'\)/);
  assert.match(app, /if \(action === 'promote-cloud-member-role'\)/);
  assert.match(app, /action === 'update-cloud-member-role' && target\.matches\?\.\('select'\)/);
  assert.match(roleUpdateSource, /memberRoleContext/);
  assert.match(roleUpdateSource, /context === 'server'[\s\S]*settingsTab = 'server'/);
  assert.match(roleUpdateSource, /context === 'human'[\s\S]*membersLayout = normalizeMembersLayout/);
  assert.match(roleUpdateSource, /settingsTab = 'members'[\s\S]*syncBrowserRouteForActiveView\(\)/);
  assert.match(app, /function cloudMemberCanRemove/);
  assert.match(app, /normalized === 'owner'[\s\S]*remove_owner/);
  assert.match(app, /data-action="confirm-member-action"/);
  assert.match(app, /data-action="copy-member-reset-link"/);
  assert.match(app, /memberResetLinkText\(\)/);
  assert.match(styles, /\.modal-member-manage-backdrop/);
  assert.match(styles, /\.modal-member-action-confirm-backdrop/);
  assert.match(styles, /\.modal-member-reset-link/);
  assert.match(styles, /\.member-manage-role-form/);
  assert.match(styles, /\.member-manage-role-controls/);
  assert.match(styles, /\.member-manage-actions/);
  assert.match(styles, /\.member-reset-link-modal/);
});

test('members directory sorts active before pending by invite time and paginates at 50 rows', async () => {
  const source = await readFile(new URL('../public/app/render-search-settings.js', import.meta.url), 'utf8');
  const context = {
    Date,
    Math,
    Number,
    String,
    Set,
    appState: {
      cloud: {
        members: [
          {
            id: 'm-late-invite',
            userId: 'u-late',
            role: 'member',
            status: 'active',
            joinedAt: '2026-01-02T00:00:00.000Z',
            createdAt: '2026-01-02T00:00:00.000Z',
            user: { id: 'u-late', email: 'late@example.com', name: 'Late Invite' },
          },
          {
            id: 'm-early-invite',
            userId: 'u-early',
            role: 'member',
            status: 'active',
            joinedAt: '2026-03-01T00:00:00.000Z',
            createdAt: '2026-03-01T00:00:00.000Z',
            user: { id: 'u-early', email: 'early@example.com', name: 'Early Invite' },
          },
          {
            id: 'm-reset',
            userId: 'u-reset',
            role: 'member',
            status: 'active',
            joinedAt: '2026-04-01T00:00:00.000Z',
            createdAt: '2026-04-01T00:00:00.000Z',
            user: { id: 'u-reset', email: 'reset@example.com', name: 'Reset Member' },
          },
        ],
        invitations: [
          { id: 'inv-member-late', email: 'late@example.com', acceptedAt: '2026-01-02T00:00:00.000Z', acceptedBy: 'u-late', createdAt: '2026-02-01T00:00:00.000Z' },
          { id: 'inv-member-early', email: 'early@example.com', acceptedAt: '2026-03-01T00:00:00.000Z', acceptedBy: 'u-early', createdAt: '2026-01-01T00:00:00.000Z' },
          { id: 'inv-member-reset', email: 'reset@example.com', acceptedAt: '2026-04-01T00:00:00.000Z', acceptedBy: 'u-reset', createdAt: '2026-01-15T00:00:00.000Z' },
          { id: 'inv-registered-later', email: 'early@example.com', createdAt: '2026-05-01T00:00:00.000Z' },
          { id: 'inv-pending-b', email: 'pending-b@example.com', role: 'member', createdAt: '2026-01-01T00:00:00.000Z' },
          { id: 'inv-pending-a', email: 'pending-a@example.com', role: 'member', createdAt: '2026-01-01T00:00:00.000Z' },
        ],
      },
    },
    memberDirectoryPage: 2,
  };
  vm.createContext(context);
  vm.runInContext(source, context);

  const rows = context.buildMembersRows();
  const orderedIds = JSON.parse(JSON.stringify(rows.map((row) => row.member?.id || row.invitation?.id)));
  assert.deepEqual(orderedIds, [
    'm-early-invite',
    'm-reset',
    'm-late-invite',
    'inv-pending-a',
    'inv-pending-b',
  ]);
  assert.equal(rows[0].member.joinedAt, '2026-03-01T00:00:00.000Z');

  const manyRows = Array.from({ length: 123 }, (_, index) => ({ type: 'member', member: { id: `m-${index}` } }));
  const page = context.membersPaginationModel(manyRows);
  assert.equal(page.totalPages, 3);
  assert.equal(page.page, 2);
  assert.equal(page.rows.length, 50);
  assert.equal(page.rows[0].member.id, 'm-50');
});

test('member invitations dedupe input and show registered-user invite errors', async () => {
  const app = await readAppSource();
  const auth = await readFile(new URL('../server/cloud/auth.js', import.meta.url), 'utf8');

  assert.match(app, /event\.key === ' ' \|\| event\.code === 'Space'/);
  assert.match(app, /function dedupeInviteEmails\(emails = \[\]\)/);
  assert.match(app, /throw new Error\(`Remove invalid email/);
  assert.doesNotMatch(app, /Already invited or already a member/);
  assert.match(app, /User already registered\./);
  assert.match(auth, /function revokeActiveInvitationsForEmail\(email, workspaceId = primaryWorkspace\(\)\?\.id/);
  assert.match(auth, /function uniqueCloudToken\(prefix\)/);
  assert.match(auth, /activeUserWithEmail\(invitation\.email\)/);
  assert.match(auth, /Invalid invite email/);
  assert.match(auth, /\/activate\?\$\{params\.toString\(\)\}/);
});

test('generated invitation links use the current browser origin for loopback API URLs', async () => {
  const source = await readFile(new URL('../public/app/render-search-settings.js', import.meta.url), 'utf8');
  const context = {
    URL,
    window: {
      location: {
        origin: 'https://magclaw.multiego.me',
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);

  assert.equal(
    context.inviteLinkForCurrentOrigin('http://127.0.0.1:6543/activate?email=a%40example.com&token=mc_inv_123'),
    'https://magclaw.multiego.me/activate?email=a%40example.com&token=mc_inv_123',
  );
  assert.equal(
    context.inviteLinkForCurrentOrigin('http://localhost:6543/activate?email=a%40example.com&token=mc_inv_123'),
    'https://magclaw.multiego.me/activate?email=a%40example.com&token=mc_inv_123',
  );
  assert.equal(
    context.inviteLinkForCurrentOrigin('https://magclaw.multiego.me/activate?email=a%40example.com&token=mc_inv_123'),
    'https://magclaw.multiego.me/activate?email=a%40example.com&token=mc_inv_123',
  );

  const localContext = {
    URL,
    window: {
      location: {
        origin: 'http://127.0.0.1:6573',
      },
    },
  };
  vm.createContext(localContext);
  vm.runInContext(source, localContext);
  assert.equal(
    localContext.inviteLinkForCurrentOrigin('http://127.0.0.1:6543/join/mc_join_123'),
    'http://127.0.0.1:6573/join/mc_join_123',
  );
});

test('account profile uses a MagClaw-style waterfall layout with avatar picker controls', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const accountSettingsSource = app.slice(app.indexOf('function renderAccountSettingsTab()'), app.indexOf('function normalizeInviteEmailValue(value)'));

  assert.match(accountSettingsSource, /account-waterfall/);
  assert.doesNotMatch(accountSettingsSource, /account-role-badge/);
  assert.match(app, /let profileFormDraft = null/);
  assert.match(app, /let profileFormIsComposing = false/);
  assert.match(app, /let pendingProfileFormRender = false/);
  assert.match(app, /function captureProfileFormDraft/);
  assert.match(app, /function profileFormFocusSnapshot/);
  assert.match(app, /function shouldDeferProfileFormRender/);
  assert.match(app, /function restoreProfileFormFocus/);
  assert.match(app, /profileFormValuesForRender\(human, currentUser\)/);
  assert.match(accountSettingsSource, /data-action="pick-profile-avatar"/);
  assert.match(accountSettingsSource, /data-action="reset-profile-avatar"[\s\S]*Reset to Default/);
  assert.match(accountSettingsSource, /account-session-card/);
  assert.match(app, /const profileFocus = profileFormFocusSnapshot\(\)/);
  assert.match(app, /shouldDeferProfileFormRender\(\)[\s\S]*pendingProfileFormRender = true/);
  assert.match(app, /restoreProfileFormFocus\(profileFocus\)/);
  assert.match(app, /compositionstart[\s\S]*#profile-form[\s\S]*profileFormIsComposing = true/);
  assert.match(app, /compositionend[\s\S]*#profile-form[\s\S]*profileFormIsComposing = false/);
  assert.match(app, /if \(profileFormIsComposing \|\| event\.isComposing \|\| event\.inputType === 'insertCompositionText'\) return/);
  assert.match(app, /pendingProfileFormRender[\s\S]*window\.requestAnimationFrame\(\(\) => render\(\)\)/);
  assert.match(app, /if \(profileForm\) \{[\s\S]*captureProfileFormDraft\(profileForm\)/);
  assert.match(app, /clearProfileFormDraft\(\)/);
  assert.doesNotMatch(accountSettingsSource, /Identity Boundary|<span>Device<\/span>|id="profile-avatar-library"|sessionTtlMs|sessionExpiresAt/);
  assert.match(styles, /\.account-overview-card/);
  assert.match(styles, /\.account-session-card/);
  assert.match(styles, /\.profile-upload-btn,\n\.file-btn \{/);
});

test('sign out uses a confirmation modal before logging out', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const accountSettingsSource = app.slice(app.indexOf('function renderAccountSettingsTab()'), app.indexOf('function normalizeInviteEmailValue(value)'));
  const signOutModalSource = app.slice(app.indexOf('function renderSignOutConfirmModal()'), app.indexOf('function renderAgentStartModal()'));

  assert.match(accountSettingsSource, /data-action="open-modal" data-modal="confirm-sign-out"[\s\S]*>Sign Out<\/button>/);
  assert.match(app, /'confirm-sign-out': renderSignOutConfirmModal/);
  assert.match(app, /function renderSignOutConfirmModal\(\)/);
  assert.match(signOutModalSource, /settingsIcon\('account'\)/);
  assert.doesNotMatch(signOutModalSource, /navIcon\(/);
  assert.match(app, /data-action="confirm-cloud-auth-logout"/);
  assert.match(app, /if \(action === 'confirm-cloud-auth-logout'\)/);
  assert.doesNotMatch(accountSettingsSource, /data-action="cloud-auth-logout"/);
  assert.match(styles, /\.modal-confirm-sign-out/);
  assert.match(styles, /\.modal-confirm-sign-out-backdrop/);
});

test('cloud account settings use server-configured sign-in without owner bootstrap UI', async () => {
  const app = await readAppSource();
  const accountSettingsSource = app.slice(app.indexOf('function renderAccountSettingsTab()'), app.indexOf('function normalizeInviteEmailValue(value)'));

  assert.equal(accountSettingsSource.includes('id="cloud-owner-form"'), false);
  assert.equal(app.includes('/api/cloud/auth/bootstrap-owner'), false);
  assert.equal(app.includes('ownerConfigured'), false);
  assert.doesNotMatch(accountSettingsSource, /\bOwner\b/);
  assert.match(accountSettingsSource, /Sign-in Account/);
  assert.match(accountSettingsSource, /The initial sign-in account is configured on the server/);
  assert.doesNotMatch(accountSettingsSource, /Admin Login/);
  assert.match(app, /function renderCloudAuthGate/);
  assert.match(app, /function renderCloudAuthCallbackGate\(provider = 'feishu'\)/);
  assert.match(app, /function cloudAuthCallbackFromLocation\(\)/);
  assert.match(app, /if \(callbackProvider\) renderCloudAuthCallbackGate\(callbackProvider\)/);
});

test('cloud auth gate uses token context for invite and reset forms', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const authGateSource = app.slice(app.indexOf('function renderCloudAuthGate('), app.indexOf('function renderBrowserSettingsTab()'));
  const openRegisterSource = authGateSource.slice(authGateSource.indexOf('id="cloud-open-register-form"'), authGateSource.indexOf('id="cloud-forgot-form"'));
  const loginFormSource = authGateSource.slice(authGateSource.indexOf('id="cloud-login-form"'), authGateSource.indexOf('id="cloud-join-link-form"'));
  const submitStyles = styles.slice(styles.indexOf('.cloud-login-submit {'), styles.indexOf('.cloud-login-switch {'));
  const checkCardButtonStyles = styles.slice(styles.indexOf('.cloud-check-email-card .cloud-login-submit {'), styles.indexOf('.cloud-check-icon {'));
  const checkIconStyles = styles.slice(styles.indexOf('.cloud-check-icon {'), styles.indexOf('.console-page {'));

  assert.match(app, /function cloudAuthTokenFromLocation\(\)/);
  assert.match(app, /if \(cloudAuthTokenFromLocation\(\)\.mode\)[\s\S]*showCloudAuthGate\(null\)/);
  assert.match(app, /\/api\/cloud\/auth\/invitation-status\?token=/);
  assert.match(app, /\/api\/cloud\/auth\/reset-status\?token=/);
  assert.match(authGateSource, /tokenContext\.mode === 'invite'/);
  assert.match(authGateSource, /tokenContext\.mode === 'reset'/);
  assert.match(authGateSource, /id="cloud-register-form"/);
  assert.match(authGateSource, /id="cloud-reset-form"/);
  assert.match(authGateSource, /id="cloud-open-register-form"/);
  assert.match(authGateSource, /id="cloud-forgot-form"/);
  assert.match(authGateSource, /id="cloud-login-form"/);
  assert.doesNotMatch(authGateSource, /Sign in is not ready/);
  assert.match(openRegisterSource, /id="cloud-open-register-form" class="cloud-login-form" novalidate/);
  assert.match(loginFormSource, /id="cloud-login-form" class="cloud-login-form" novalidate/);
  assert.doesNotMatch(openRegisterSource, /minlength|maxlength/);
  assert.match(app, /function assertCloudPasswordPolicy\(password\)/);
  assert.match(app, /const password = assertCloudPasswordPolicy\(data\.get\('password'\)\)/);
  assert.match(authGateSource, /passwordConfirm/);
  assert.match(authGateSource, /Password must be 8-30 characters and include letters and numbers\./);
  assert.doesNotMatch(authGateSource, /<span>Avatar<\/span>/);
  assert.doesNotMatch(authGateSource, /data-action="reset-cloud-auth-avatar"[\s\S]*Reset to Default/);
  assert.doesNotMatch(authGateSource, /<input type="hidden" name="email"/);
  assert.match(authGateSource, /By using MagClaw, you agree to our/);
  assert.match(authGateSource, /Terms of Use/);
  assert.match(authGateSource, /Privacy Policy/);
  assert.match(app, /'By using MagClaw, you agree to our': '使用即代表您同意我们的'/);
  assert.match(app, /'Terms of Use': '使用条款'/);
  assert.match(app, /'and': '和'/);
  assert.match(authGateSource, /<a href="\/terms">Terms of Use<\/a>/);
  assert.match(authGateSource, /<a href="\/privacy">Privacy Policy<\/a>/);
  assert.doesNotMatch(authGateSource, /target="_blank"|rel="noreferrer"/);
  assert.doesNotMatch(authGateSource, /使用即代表|使用协议|隐私政策/);
  assert.match(authGateSource, /© 2026 MagClaw\. All Rights Reserved\./);
  assert.match(submitStyles, /display: inline-flex;/);
  assert.match(submitStyles, /align-items: center;/);
  assert.match(submitStyles, /justify-content: center;/);
  assert.match(submitStyles, /color: var\(--accent-text\);/);
  assert.match(submitStyles, /text-decoration: none;/);
  assert.match(checkCardButtonStyles, /margin-bottom: 4px;/);
  assert.match(checkCardButtonStyles, /color: var\(--accent-text\);/);
  assert.match(checkIconStyles, /background: var\(--accent\);/);
  assert.match(checkIconStyles, /color: var\(--accent-text\);/);
  assert.doesNotMatch(checkIconStyles, /#ffd743|--magclaw-sun|#FFD800/i);
  assert.doesNotMatch(authGateSource, /owner invite/);
  assert.doesNotMatch(authGateSource, /admin account configured|Admin access required|Admin login/i);
  assert.match(authGateSource, /Welcome to MagClaw/);
  assert.doesNotMatch(authGateSource, /Use your organization account to continue/);
  assert.match(authGateSource, /cloud-login-error/);
  assert.match(authGateSource, /role="alert" aria-live="polite"/);
  assert.match(authGateSource, /value="\$\{escapeHtml\(cloudLoginDraftEmail\)\}"/);
  assert.match(app, /Email or password is incorrect/);
  assert.match(app, /function validateCloudLoginForm\(form, data\)/);
  assert.match(app, /throw new Error\('Email is required\.'\)/);
  assert.match(app, /throw new Error\('Password is required\.'\)/);
  assert.match(app, /showCloudAuthGate\(error, \{ interactive: true \}\)/);
  assert.match(app, /const BRAND_LOGO_SRC = '\/brand\/magclaw-logo\.png'/);
  assert.match(authGateSource, /<img src="\$\{BRAND_LOGO_SRC\}" alt="" \/>/);
  assert.match(authGateSource, /class="cloud-auth-shell"/);
  assert.match(authGateSource, /class="pixel-panel cloud-login-card"/);
  assert.match(authGateSource, /id="cloud-login-title">Welcome to MagClaw/);
  assert.match(styles, /\.cloud-auth-stage/);
  assert.match(styles, /\.cloud-auth-shell \{[\s\S]*background: #fffaf7/);
  assert.match(styles, /\.cloud-login-card,/);
  assert.match(styles, /\.cloud-login-error/);
  assert.match(styles, /\.cloud-login-submit/);
  assert.match(styles, /\.cloud-auth-legal/);
  assert.match(styles, /\.cloud-password-rule/);
  assert.match(styles, /\.cloud-login-switch/);
  assert.match(app, /let cloudAuthAvatarToken = ''/);
  assert.match(app, /cloudAuthAvatarToken !== context\.token/);
  assert.match(app, /if \(action === 'reset-cloud-auth-avatar'\)/);
  assert.match(app, /if \(action === 'reset-profile-avatar'\)/);
  assert.doesNotMatch(app.slice(app.indexOf("if (form.id === 'cloud-register-form')"), app.indexOf("if (form.id === 'cloud-reset-form')")), /email: data\.get\('email'\)/);
});

test('cloud auth gate renders configured login providers with Feishu prioritized', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const authGateSource = app.slice(app.indexOf('function renderCloudAuthGate('), app.indexOf('function renderBrowserSettingsTab()'));

  assert.match(app, /function cloudAuthProviders\(auth\)/);
  assert.match(app, /function cloudDefaultAuthProvider\(auth\)/);
  assert.match(authGateSource, /auth\.providers/);
  assert.match(authGateSource, /auth\.defaultProvider/);
  assert.match(authGateSource, /showFeishuProvider/);
  assert.match(authGateSource, /showPasswordProvider/);
  assert.match(authGateSource, /cloud-login-divider/);
  assert.match(app, /Continue with Feishu/);
  assert.match(app, /\/brand\/feishu-logo\.svg/);
  assert.match(authGateSource, /samlee\.mobbin@gmail\.com/);
  assert.match(app, /href="\$\{escapeHtml\(feishuLoginUrl\(feishuProvider/);
  assert.match(app, /Log In/);
  assert.match(authGateSource, /cloud-login-label-row/);
  assert.doesNotMatch(authGateSource, /Feishu authorization/);
  assert.doesNotMatch(authGateSource, /Scan with the Feishu app/);
  assert.match(authGateSource, /auth\.passwordLogin/);
  assert.match(styles, /\.cloud-login-divider/);
  assert.match(styles, /\.cloud-oauth-panel/);
  assert.match(styles, /\.cloud-oauth-button/);
  assert.match(styles, /\.cloud-oauth-button img/);
});

test('join-link auth keeps Feishu login on the join return path', async () => {
  const app = await readAppSource();
  const authGateSource = app.slice(app.indexOf('function renderCloudAuthGate('), app.indexOf('function renderBrowserSettingsTab()'));

  assert.match(authGateSource, /loginReturnTo/);
  assert.match(authGateSource, /\/join\/\$\{encodeURIComponent\(tokenContext\.token/);
  assert.match(app, /function feishuLoginUrl\(provider, returnTo = ''\)/);
  assert.match(app, /returnTo/);
});

test('left rail settings entry renders as the signed-in user account avatar with hover details', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const railSource = app.slice(app.indexOf('function renderRail()'), app.indexOf('function currentServerProfile()'));

  assert.match(app, /function renderAccountRailButton\(activeNav\)/);
  assert.match(railSource, /renderAccountRailButton\(railMode\)/);
  assert.match(app, /data-action="open-account-settings"/);
  assert.match(app, /account-rail-popover/);
  assert.match(app, /accountRailAvatarHtml/);
  assert.match(styles, /\.account-rail-button/);
  assert.match(styles, /\.account-rail-popover/);
});

test('browser favicon and shared brand assets use the selected Modular Claw logo', async () => {
  const index = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = await readAppSource();

  assert.match(index, /<title>MagClaw<\/title>/);
  assert.match(index, /<link rel="icon" type="image\/png" sizes="16x16" href="\/brand\/magclaw-favicon-16\.png\?v=modular-claw-v2" \/>/);
  assert.match(index, /<link rel="icon" type="image\/png" sizes="32x32" href="\/brand\/magclaw-favicon-32\.png\?v=modular-claw-v2" \/>/);
  assert.match(index, /<link rel="icon" type="image\/png" sizes="64x64" href="\/brand\/magclaw-favicon\.png\?v=modular-claw-v2" \/>/);
  assert.match(index, /<link rel="shortcut icon" href="\/favicon\.ico\?v=modular-claw-v2" \/>/);
  assert.match(index, /<link rel="apple-touch-icon" href="\/brand\/magclaw-logo\.png\?v=modular-claw-v2" \/>/);
  assert.match(app, /const BRAND_FAVICON_SRC = '\/brand\/magclaw-favicon\.png'/);
  assert.match(app, /const NOTIFICATION_ICON = BRAND_FAVICON_SRC/);
  assert.equal((await stat(new URL('../public/brand/magclaw-logo.png', import.meta.url))).isFile(), true);
  assert.equal((await stat(new URL('../public/brand/magclaw-favicon-16.png', import.meta.url))).isFile(), true);
  assert.equal((await stat(new URL('../public/brand/magclaw-favicon-32.png', import.meta.url))).isFile(), true);
  assert.equal((await stat(new URL('../public/brand/magclaw-favicon.png', import.meta.url))).isFile(), true);
  assert.equal((await stat(new URL('../public/brand/magclaw-logo-concepts.png', import.meta.url))).isFile(), true);
  assert.equal((await stat(new URL('../public/favicon.ico', import.meta.url))).isFile(), true);
  assert.deepEqual(
    [...(await readFile(new URL('../public/favicon.ico', import.meta.url))).subarray(0, 4)],
    [0, 0, 1, 0],
  );
});

test('login legal links have localized built-in terms and privacy pages', async () => {
  const terms = await readFile(new URL('../public/terms/index.html', import.meta.url), 'utf8');
  const privacy = await readFile(new URL('../public/privacy/index.html', import.meta.url), 'utf8');
  const legalLanguage = await readFile(new URL('../public/legal-language.js', import.meta.url), 'utf8');

  assert.match(terms, /<html lang="en">/);
  assert.match(terms, /<title>MagClaw Terms of Use<\/title>/);
  assert.match(terms, /data-legal-title-en="MagClaw Terms of Use"/);
  assert.match(terms, /data-legal-title-zh="MagClaw 使用条款"/);
  assert.match(terms, /data-legal-copy="en"/);
  assert.match(terms, /<h1>Terms of Use<\/h1>/);
  assert.match(terms, /Workspace Access/);
  assert.match(terms, /MagClaw 使用条款/);
  assert.match(terms, /data-legal-copy="zh-CN" hidden/);
  assert.match(terms, /© 2026 MagClaw\. 版权所有。/);

  assert.match(privacy, /<html lang="en">/);
  assert.match(privacy, /<title>MagClaw Privacy Policy<\/title>/);
  assert.match(privacy, /data-legal-title-en="MagClaw Privacy Policy"/);
  assert.match(privacy, /data-legal-title-zh="MagClaw 隐私政策"/);
  assert.match(privacy, /data-legal-copy="en"/);
  assert.match(privacy, /<h1>Privacy Policy<\/h1>/);
  assert.match(privacy, /Passwords are never stored in plaintext/);
  assert.match(privacy, /MagClaw 隐私政策/);
  assert.match(privacy, /data-legal-copy="zh-CN" hidden/);
  assert.match(privacy, /密码绝不会以明文存储/);

  assert.match(terms, /<script src="\/legal-language\.js" defer><\/script>/);
  assert.match(privacy, /<script src="\/legal-language\.js" defer><\/script>/);
  assert.match(legalLanguage, /MAGCLAW_LANGUAGE_KEY = 'magclawLanguage'/);
  assert.match(legalLanguage, /localStorage\.getItem\(MAGCLAW_LANGUAGE_KEY\)/);
  assert.match(legalLanguage, /\[data-legal-copy\]/);
});

test('legal page language script follows stored MagClaw language', async () => {
  const legalLanguage = await readFile(new URL('../public/legal-language.js', import.meta.url), 'utf8');
  const sections = [
    { dataset: { legalCopy: 'en' }, hidden: false },
    { dataset: { legalCopy: 'zh-CN' }, hidden: true },
  ];
  const listeners = {};
  const context = {
    URLSearchParams,
    document: {
      documentElement: { lang: 'en' },
      title: 'MagClaw Terms of Use',
      body: {
        dataset: {
          legalTitleEn: 'MagClaw Terms of Use',
          legalTitleZh: 'MagClaw 使用条款',
        },
      },
      querySelectorAll(selector) {
        return selector === '[data-legal-copy]' ? sections : [];
      },
    },
    localStorage: {
      getItem(key) {
        return key === 'magclawLanguage' ? 'zh-CN' : '';
      },
    },
    window: {
      location: { search: '' },
      addEventListener(type, callback) {
        listeners[type] = callback;
      },
    },
  };

  vm.runInNewContext(legalLanguage, context);

  assert.equal(context.document.documentElement.lang, 'zh-CN');
  assert.equal(context.document.title, 'MagClaw 使用条款');
  assert.equal(sections[0].hidden, true);
  assert.equal(sections[1].hidden, false);
  assert.equal(typeof listeners.storage, 'function');
});

test('settings exposes browser language switching and loads i18n before render chunks', async () => {
  const app = await readAppSource();
  const shellSource = app.slice(app.indexOf('function settingsNavItems()'), app.indexOf('function settingsIcon('));
  const settingsSource = app.slice(app.indexOf('function settingsPageMeta'), app.indexOf('function renderAccountSettingsTab()'));
  const i18nIndex = app.indexOf('/app/i18n.js');
  const preludeIndex = app.indexOf('/app/prelude.js');

  assert.ok(i18nIndex >= 0 && preludeIndex > i18nIndex);
  assert.match(shellSource, /id: 'language'[\s\S]*label: 'Language'/);
  assert.match(settingsSource, /language: \{ title: 'Language'/);
  assert.match(app, /data-action="set-ui-language"/);
  assert.match(app, /persistMagclawAccountLanguage/);
  assert.match(app, /\/api\/cloud\/auth\/preferences/);
  assert.match(app, /applyMagclawAccountLanguage\(appState\)/);
  assert.match(app, /Saved to your account when signed in\./);
  assert.match(app, /function renderLanguageSettingsTab\(\)/);
});

test('cloud auth gate loads invite tokens from invite URLs', async () => {
  const app = await readAppSource();

  assert.match(app, /const params = new URLSearchParams\(window\.location\.search\)/);
  assert.match(app, /path\.includes\('reset-password'\) \|\| token\.startsWith\('mc_reset_'\)/);
  assert.match(app, /name="inviteToken" value="\$\{escapeHtml\(tokenContext\.token \|\| ''\)\}"/);
  assert.match(app, /window\.history\.replaceState\(\{\}, '', '\/'\)/);
});

// Local project folder linking is temporarily hidden until cloud-safe access exists.
test.skip('project picker keeps only the native folder action and polished chip icons', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();

  assert.equal(app.includes('Add Workspace'), false);
  assert.equal(app.includes('add-default-workspace'), false);
  assert.match(app, /class="project-folder-icon"/);
  assert.match(app, /class="project-tree-icon-svg"/);
  assert.match(styles, /\.project-chip-name/);
  assert.match(styles, /\.project-tree-btn/);
  assert.match(styles, /\.project-icon-btn\.danger-icon/);
});

// Local project folder linking is temporarily hidden until cloud-safe access exists.
test.skip('project chip paths stay readable with horizontal scrolling', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();

  assert.match(app, /class="project-chip-path"/);
  assert.match(styles, /\.project-chip-path \{/);
  assert.match(styles, /overflow-x: auto/);
  assert.match(styles, /text-overflow: clip/);
});

// Local project folder linking is temporarily hidden until cloud-safe access exists.
test.skip('project mentions show full local paths in the candidate list', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();

  assert.match(app, /absolutePath: item\.absolutePath/);
  assert.match(app, /item\.absolutePath \|\| item\.path/);
  assert.match(app, /class="mention-handle mention-detail" title="\$\{escapeHtml\(detail\)\}"/);
  assert.match(styles, /grid-template-columns: 28px 8px minmax\(104px, 0\.46fr\) minmax\(160px, 0\.54fr\)/);
  assert.match(styles, /\.mention-type-file \.mention-handle,\n\.mention-type-folder \.mention-handle/);
  assert.match(styles, /overflow-wrap: anywhere/);
});

test('mention popup differentiates humans and agents without the channel heading', async () => {
  const source = await readFile(new URL('../public/app/data-search-mentions.js', import.meta.url), 'utf8');
  const appState = {
    agents: [
      {
        id: 'agt_codex',
        name: 'Ka',
        runtime: 'codex',
        description: 'Handles code changes and release checks',
        status: 'online',
        createdAt: '2026-01-02T00:00:00.000Z',
      },
    ],
    humans: [
      {
        id: 'hum_recent',
        name: 'JJJJ',
        email: 'jjjj@example.test',
        status: 'online',
        avatarUrl: 'data:image/png;base64,real-avatar',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    channels: [{ id: 'chan_all', name: 'all', memberIds: ['agt_codex', 'hum_recent'], humanIds: ['hum_recent'], agentIds: ['agt_codex'] }],
    messages: [{ id: 'msg_recent', authorId: 'hum_recent', spaceType: 'channel', spaceId: 'chan_all', createdAt: '2026-01-03T00:00:00.000Z' }],
    replies: [],
    projects: [],
  };
  const context = {
    BRAND_LOGO_SRC: '',
    appState,
    selectedSpaceType: 'channel',
    selectedSpaceId: 'chan_all',
    mentionPopup: {
      active: false,
      items: [],
      selectedIndex: 0,
      composerId: 'composer',
    },
    escapeHtml(value) {
      return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
    },
    presenceClass(status) {
      return `status-${status || 'offline'}`;
    },
    humanBadgeHtml() {
      return '<img class="human-script-badge" src="/brand/humans-script-badge.png" alt="humans" />';
    },
    getChannelMembers() {
      return {
        agents: appState.agents,
        humans: appState.humans,
      };
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);

  const candidates = context.getMentionCandidates('', 'channel', 'chan_all');
  context.mentionPopup = {
    active: true,
    items: candidates,
    selectedIndex: 0,
    composerId: 'composer',
  };
  const html = context.renderMentionPopup();

  assert.doesNotMatch(html, /PEOPLE IN THIS CHANNEL/);
  assert.match(html, /human-script-badge/);
  assert.match(html, /data:image\/png;base64,real-avatar/);
  assert.match(html, /Codex · Handles code changes and release checks/);
  assert.equal(context.getMentionCandidates('codex', 'channel', 'chan_all')[0].id, 'agt_codex');
});

test('thread mentions include active workspace humans outside the current channel', async () => {
  const source = await readFile(new URL('../public/app/data-search-mentions.js', import.meta.url), 'utf8');
  const appState = {
    agents: [],
    humans: [{ id: 'hum_local', name: 'You', email: 'you@example.com', status: 'online' }],
    channels: [{ id: 'chan_private', memberIds: ['hum_local'], humanIds: ['hum_local'], agentIds: [] }],
    dms: [],
    projects: [],
    cloud: {
      members: [
        {
          id: 'mem_other',
          humanId: 'hum_other',
          role: 'member',
          status: 'active',
          user: { id: 'usr_other', email: 'other@example.com', name: 'Other Human' },
        },
        {
          id: 'mem_removed',
          humanId: 'hum_removed',
          role: 'member',
          status: 'removed',
          user: { id: 'usr_removed', email: 'removed@example.com', name: 'Removed Human' },
        },
      ],
    },
  };
  const context = {
    BRAND_LOGO_SRC: '',
    appState,
    selectedSpaceType: 'channel',
    selectedSpaceId: 'chan_private',
    getChannelMembers(channelId) {
      const channel = appState.channels.find((item) => item.id === channelId);
      const ids = channel?.memberIds || [];
      return {
        agents: [],
        humans: appState.humans.filter((human) => ids.includes(human.id)),
      };
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);

  const candidates = context.getMentionCandidates('', 'channel', 'chan_private');

  assert.ok(candidates.some((item) => item.id === 'hum_other' && item.name === 'Other Human' && item.group === 'out'));
  assert.equal(candidates.some((item) => item.id === 'hum_removed'), false);
});

test('channel members use active workspace humans and profile avatars', async () => {
  const source = await readFile(new URL('../public/app/render-space-chat-tasks.js', import.meta.url), 'utf8');
  const modalSource = await readFile(new URL('../public/app/render-modals-uploads.js', import.meta.url), 'utf8');
  const appState = {
    agents: [{ id: 'agt_one', name: 'Agent One' }],
    humans: [
      { id: 'hum_legacy', name: 'Legacy Admin', status: 'online' },
      { id: 'hum_current', name: 'Current User', status: 'online', avatar: 'data:image/png;base64,current' },
    ],
    channels: [{ id: 'chan_all', memberIds: ['agt_one', 'hum_legacy', 'hum_current'], humanIds: ['hum_legacy', 'hum_current'] }],
  };
  const context = {
    appState,
    byId(items, id) { return (items || []).find((item) => item.id === id) || null; },
    workspaceHumans() { return [appState.humans[1]]; },
    humanByIdAny(id) { return appState.humans.find((item) => item.id === id) || null; },
    humanIsCurrent(human) { return human?.id === 'hum_current'; },
  };
  vm.createContext(context);
  vm.runInContext(source, context);

  const members = context.getChannelMembers('chan_all');

  assert.deepEqual(members.humans.map((human) => human.id), ['hum_current']);
  assert.match(modalSource, /renderHumanAvatar\(member, 'dm-avatar member-avatar'\)/);
  assert.match(modalSource, /workspaceHumans\(\)\.filter/);
  assert.match(await readFile(new URL('../public/app/data-search-mentions.js', import.meta.url), 'utf8'), /return workspaceHumans\(\)/);
});

test('threads render newest first with display names instead of raw ids', async () => {
  const app = await readAppSource();

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
  const app = await readAppSource();
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

test('chat rail keeps Threads and adds Activities without a System notification tab', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const chatRailSource = app.slice(app.indexOf('function renderChatRail('), app.indexOf('function renderMembersRail('));

  assert.match(chatRailSource, /renderNavItem\('inbox', 'Activities', 'inbox', inboxUnread \|\| '', \{ badgeKind: 'unread' \}\)/);
  assert.match(chatRailSource, /renderNavItem\('threads', 'Threads', 'message'/);
  assert.match(chatRailSource, /renderChannelItem\(channel, unreadCountForSpace\(spaceUnreadCounts, 'channel', channel\.id\)\)/);
  assert.match(chatRailSource, /const dmPeers = dms/);
  assert.match(chatRailSource, /\.map\(\(dm\) => dmPeerInfo\(dm\)\)/);
  assert.match(chatRailSource, /\.filter\(\(item\) => item\?\.dm\?\.id && item\?\.peer\)/);
  assert.match(chatRailSource, /renderDmItem\(dm\.id, peer\.name \|\| displayName\(peer\.id\), peer\.status \|\| 'offline', peer\.avatar \|\| '', unreadCountForSpace\(spaceUnreadCounts, 'dm', dm\.id\)\)/);
  assert.match(app, /function renderRailUnreadBadge\(count, label = 'unread messages'\)/);
  assert.match(app, /function buildSpaceUnreadCounts\(humanId = currentHumanId\(\), stateSnapshot = appState\)/);
  assert.match(app, /function chatUnreadCountFromSpaces\(spaceUnreadCounts\)/);
  assert.match(app, /renderLeftRailButton\('chat'[\s\S]*chatUnreadCount \|\| inbox\.unreadCount \|\| ''/);
  assert.match(app, /function markSpaceRead\(spaceType, spaceId, \{ forceScope = true \} = \{\}\)/);
  assert.match(app, /markInboxRead\(\{ recordIds, spaceType, spaceId \}\)/);
  assert.doesNotMatch(chatRailSource, /system-notifications|System Notification List/);
  assert.match(app, /if \(activeView === 'inbox'\) return renderInbox\(\)/);
  assert.doesNotMatch(app, /function renderSystemNotifications\(\)/);
  assert.match(styles, /\.rail-unread-badge/);
  assert.match(styles, /\.space-btn \.rail-unread-badge/);
});

test('inbox reuses thread rows and renders workspace activity drawer', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const renderSource = app.slice(app.indexOf('function render()'), app.indexOf('function renderRail()'));
  const drawerSource = app.slice(app.indexOf('function renderWorkspaceActivityDrawer()'), app.indexOf('function renderThreadDrawer(message)'));

  assert.match(app, /function renderInbox\(\)/);
  assert.match(app, /function buildInboxModel\(\)/);
  assert.match(app, /function renderWorkspaceActivityDrawer\(\)/);
  assert.match(app, /function workspaceActivityScrollSnapshot\(\)/);
  assert.match(app, /function restoreWorkspaceActivityScroll\(snapshot\)/);
  assert.match(app, /unreadCount: 0,[\s\S]*title: 'Server Activity'/);
  assert.match(app, /const allItems = \[workspaceItem, \.\.\.normalItems\]/);
  assert.match(app, /activeCount: normalItems\.length/);
  assert.match(app, /renderInboxCategoryButton\('workspace', 'Server Activity', null\)/);
  assert.match(app, /renderHeader\('Activities'/);
  assert.match(app, /title="Open activity">LOG/);
  assert.match(renderSource, /workspaceActivity: workspaceActivityScrollSnapshot\(\)/);
  assert.match(renderSource, /restoreWorkspaceActivityScroll\(scrollSnapshot\.workspaceActivity\)/);
  assert.match(app, /class="thread-row magclaw-thread-row inbox-row/);
  assert.match(app, /data-action="open-workspace-activity"/);
  assert.match(drawerSource, /class="workspace-activity-title-trigger"/);
  assert.match(drawerSource, /class="workspace-activity-popover"/);
  assert.match(drawerSource, /tabindex="0"/);
  assert.match(styles, /\.inbox-shell/);
  assert.match(styles, /\.workspace-activity-drawer/);
  assert.match(styles, /\.workspace-activity-popover/);
  assert.match(styles, /\.workspace-activity-popover \{[\s\S]*border: 1px solid/);
  assert.match(styles, /\.workspace-activity-popover \{[\s\S]*border-radius: 6px/);
  assert.doesNotMatch(styles, /\.workspace-activity-popover \{[\s\S]*box-shadow: var\(--shadow-pixel\)/);
  assert.match(styles, /\.workspace-activity-row:hover \.workspace-activity-popover/);
  assert.match(styles, /\.workspace-activity-title-wrap:focus-within \.workspace-activity-popover/);
  assert.match(styles, /\.inbox-row\.unread::before/);
});

test('workspace uses dark icon rail, pink chat sidebar, and white main surfaces', async () => {
  const styles = await readStylesSource();
  const colorPass = styles.slice(styles.indexOf('Inbox redesign color pass'));
  const densityPass = styles.slice(styles.indexOf('Workspace density pass'));

  assert.match(colorPass, /\.magclaw-left-rail,[\s\S]*\.rail-icon-only \{[\s\S]*background: var\(--magclaw-rail\)/);
  assert.match(colorPass, /\.magclaw-sidebar,[\s\S]*background: var\(--bg-chat\)/);
  assert.match(colorPass, /\.workspace,[\s\S]*\.thread-list-panel,[\s\S]*\.search-results,[\s\S]*\.inbox-page[\s\S]*background: #ffffff/);
  assert.match(colorPass, /\.thread-row:hover,[\s\S]*background: var\(--accent-soft\)/);
  assert.match(densityPass, /\.collab-frame \{[\s\S]*font-family: -apple-system/);
  assert.match(densityPass, /\.collab-frame \.magclaw-left-rail \{[\s\S]*border-right: 1px solid var\(--workspace-line-strong\)/);
  assert.match(densityPass, /\.collab-frame \.space-header,[\s\S]*\.collab-frame \.task-page-header,[\s\S]*\.collab-frame \.agent-detail-topbar,[\s\S]*border-bottom: 1px solid var\(--workspace-line-strong\)/);
  assert.match(densityPass, /\.collab-frame \.nav-item,[\s\S]*\.collab-frame \.space-btn \{[\s\S]*font-size: 13px/);
  assert.match(densityPass, /\.collab-frame \.computers-page > \.cloud-layout \{[\s\S]*padding: 0 20px 22px/);
});

test('messages and replies render markdown while preserving mention chips', async () => {
  const app = await readAppSource();

  assert.match(app, /function renderMarkdownWithMentions\(content\)/);
  assert.match(app, /message-table/);
  assert.match(app, /renderMarkdownWithMentions\(message\.body \|\| \(message\.references\?\.length \? '' : '\(attachment\)'\)\)/);
  assert.match(app, /renderMarkdownWithMentions\(reply\.body \|\| \(reply\.references\?\.length \? '' : '\(attachment\)'\)\)/);
  const styles = await readStylesSource();
  assert.match(styles, /\.message-table/);
  assert.match(styles, /\.message-table-wrap/);
});

test('message mention and reply chips stay compact in narrow chat panes', async () => {
  const styles = await readStylesSource();
  const mentionSource = styles.slice(styles.indexOf('/* Mention tags in messages */'), styles.indexOf('.project-strip'));
  const replyChipSource = styles.slice(styles.indexOf('.reply-count-chip {'), styles.indexOf('.agent-receipt-tray'));

  assert.match(mentionSource, /\.mention-tag \{[\s\S]*display: inline-flex/);
  assert.match(mentionSource, /\.mention-tag \{[\s\S]*align-items: center/);
  assert.match(mentionSource, /\.mention-tag \{[\s\S]*padding: 0 3px/);
  assert.match(mentionSource, /\.mention-tag \{[\s\S]*line-height: 1\.05/);
  assert.match(mentionSource, /button\.mention-tag \{[\s\S]*appearance: none/);
  assert.match(mentionSource, /button\.mention-tag \{[\s\S]*line-height: 1\.05/);
  assert.match(replyChipSource, /\.reply-count-chip \{[\s\S]*min-height: 18px/);
  assert.match(replyChipSource, /\.reply-count-chip \{[\s\S]*padding: 0 6px/);
  assert.match(replyChipSource, /\.reply-count-chip \{[\s\S]*line-height: 1\.05/);
  assert.match(replyChipSource, /\.reply-count-chip \{[\s\S]*appearance: none/);
});

test('human mention chips use a distinct color from agent mentions', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();

  assert.match(app, /mention-identity mention-agent/);
  assert.match(app, /data-action="select-agent" data-id="\$\{escapeHtml\(id\)\}"/);
  assert.match(app, /mention-identity mention-human/);
  assert.match(app, /data-action="select-human-inspector" data-id="\$\{escapeHtml\(human\.id\)\}"/);
  assert.match(app, /renderHumanHoverCard\(human\)/);
  assert.match(styles, /\.mention-tag\.mention-human/);
  assert.match(styles, /\.mention-identity:hover \.agent-hover-card/);
  assert.match(styles, /button\.mention-tag \{[\s\S]*display: inline-flex/);
  assert.match(styles, /button\.mention-tag \{[\s\S]*white-space: nowrap/);
  assert.match(styles, /\.mention-tag\.mention-identity \.agent-hover-card \{[\s\S]*display: none/);
  assert.match(styles, /\.mention-tag\.mention-identity:hover \.agent-hover-card,[\s\S]*\.mention-tag\.mention-identity:focus-visible \.agent-hover-card \{[\s\S]*display: grid/);
  assert.match(styles, /background: #9FE3D1/);
  assert.match(styles, /color: #0B302A/);
});

test('channel mention chips render in yellow', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();

  assert.match(app, /mention-special\$\{channelClass\}/);
  assert.match(app, /mention-tag mention-channel/);
  assert.match(app, /function renderPlainChannelMentions\(html\)/);
  assert.match(app, /renderPlainChannelMentions\(html\)/);
  assert.match(styles, /\.mention-tag\.mention-channel/);
  assert.match(styles, /background: #FFE15A/);
  assert.match(styles, /color: #1A1A1A/);
});

test('human messages and thread replies render agent pickup avatars from work items', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();

  assert.match(app, /const AGENT_RECEIPT_VISIBLE_LIMIT = 10/);
  assert.match(app, /function deliveryReceiptItemsForRecord\(record\)/);
  assert.match(app, /item\?\.sourceMessageId === record\.id/);
  assert.match(app, /record\.authorId === currentHumanId\(\)/);
  assert.match(app, /humanMatchesCurrentAccount\(human \|\| \{ id: record\.authorId \}\)/);
  assert.match(app, /function renderAgentReceiptTray\(record\)/);
  assert.match(app, /function renderMessageFooter\(\{ replyCountChip = '', receiptTray = '' \} = \{\}\)/);
  assert.match(app, /record\.authorType === 'agent'/);
  assert.match(app, /item\?\.status === 'queued_remote'/);
  assert.match(app, /queued_remote: 'Queued'/);
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
  const app = await readAppSource();
  const styles = await readStylesSource();

  assert.match(app, /let collapsedTaskColumns = readCollapsedTaskColumns\(\)/);
  assert.match(app, /const DEFAULT_COLLAPSED_TASK_COLUMNS = \{ done: true, closed: true \}/);
  assert.match(app, /return \{ \.\.\.DEFAULT_COLLAPSED_TASK_COLUMNS, \.\.\.parsed \}/);
  assert.match(app, /data-action="toggle-task-column"/);
  assert.match(app, /function toggleTaskColumn\(status\)/);
  assert.match(styles, /\.task-column\.collapsed/);
  assert.match(styles, /\.column-toggle/);
});

test('stop all agents channel action is labelled but temporarily unavailable', async () => {
  const app = await readAppSource();

  assert.match(app, /title="Stop All Agents - Stop all Agent actions in this channel \(temporarily unavailable\)"/);
  assert.match(app, /data-tooltip="Stop All Agents[\s\S]*temporarily unavailable/);
  assert.match(app, /该功能暂时不可用/);
  assert.equal(app.includes('data-action="confirm-stop-all"'), false);
  assert.equal(app.includes("/api/agents/stop-all"), false);
});

test('all visible frontend timestamps include seconds', async () => {
  const app = await readAppSource();

  assert.match(app, /function fmtTime\(value\)/);
  assert.match(app, /second: '2-digit'/);
  assert.match(app, /hour12: false/);
});

test('system messages render the browser tab logo as the avatar', async () => {
  const app = await readAppSource();

  assert.match(app, /const SYSTEM_AVATAR_SRC = BRAND_LOGO_SRC/);
  assert.match(app, /<img src="\$\{SYSTEM_AVATAR_SRC\}" class="\$\{cssClass\} avatar-img system-avatar-img" alt="Magclaw" \/>/);
  assert.equal(app.includes('return `<span class="${cssClass}">MC</span>`;'), false);
});

test('channel views hide internal new-agent greeting tasks', async () => {
  const app = await readAppSource();
  const spaceMessagesSource = app.slice(app.indexOf('function spaceMessages('), app.indexOf('function projectsForSpace('));

  assert.match(app, /function isInternalOnboardingTaskMessage\(message\)/);
  assert.match(app, /message\?\.eventType === 'agent_onboarding_greeting_task'/);
  assert.match(spaceMessagesSource, /\.filter\(\(message\) => !isInternalOnboardingTaskMessage\(message\)\)/);
});

test('agent born date shows a cake on same-month-day anniversaries only', async () => {
  const app = await readAppSource();

  assert.match(app, /function shouldCelebrateAgentBorn\(value, today = new Date\(\)\)/);
  assert.match(app, /date\.getMonth\(\) === today\.getMonth\(\)/);
  assert.match(app, /date\.getDate\(\) === today\.getDate\(\)/);
  assert.match(app, /date\.getFullYear\(\) !== today\.getFullYear\(\)/);
  assert.match(app, /shouldCelebrateAgentBorn\(date\) \? '🎂 ' : ''/);
});

test('agent messages and thread replies render live status dots on avatar corners', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();

  assert.match(app, /function agentStatusDot\(authorId, authorType\)/);
  assert.match(app, /renderAgentIdentityButton\(authorId, 'agent-avatar-button'\)\}\$\{agentStatusDot\(authorId, authorType\)\}/);
  assert.equal(app.includes('renderActorName(message.authorId, message.authorType)}${agentStatusDot(message.authorId, message.authorType)}'), false);
  assert.equal(app.includes('renderActorName(reply.authorId, reply.authorType)}${agentStatusDot(reply.authorId, reply.authorType)}'), false);
  assert.match(styles, /\.avatar-status-dot/);
  assert.match(styles, /\.avatar-status-dot\.status-error/);
});

test('empty thread replies keep the count without rendering a no-replies placeholder', async () => {
  const app = await readAppSource();

  assert.equal(app.includes('No replies yet'), false);
  assert.match(app, /const replyCountText = pageInfo\?\.hasMore && totalReplies > replies\.length/);
  assert.match(app, /<strong>\$\{replyCountText\}<\/strong>/);
  assert.match(app, /replies\.length \? `[\s\S]*<div class="reply-list">/);
});

test('channel navigation hides the inspector until an agent, task, or thread is selected', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();

  assert.match(app, /const inspectorHtml = renderInspector\(\)/);
  assert.match(app, /inspectorHtml \? `[\s\S]*collab-inspector/);
  assert.match(app, /class="app-frame collab-frame\$\{inspectorHtml \? '' : ' no-inspector'\}\$\{threadMessageId \? `\$\{inspectorHtml \? ' tablet-inspector-main' : ''\} thread-open` : ''\}\$\{taskFocusLayout \? ' task-focus' : ''\}[\s\S]*\$\{notificationBanner \? ' notification-banner-active' : ''\}"/);
  assert.match(app, /let selectedTaskId = null/);
  assert.match(app, /function renderInspector\(\)[\s\S]*if \(selectedAgentId\)/);
  assert.match(app, /selectedAgentId = null;[\s\S]*selectedSpaceType = target\.dataset\.type/);
  assert.match(styles, /\.app-frame\.no-inspector/);
});

test('tablet thread layout promotes the thread inspector into the main content column', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();

  assert.match(app, /\$\{threadMessageId \? `\$\{inspectorHtml \? ' tablet-inspector-main' : ''\} thread-open` : ''\}/);
  assert.match(styles, /@media \(min-width: 768px\) and \(max-width: 1099px\)[\s\S]*\.app-frame\.tablet-inspector-main \{/);
  assert.match(styles, /\.app-frame\.tablet-inspector-main \.workspace \{[\s\S]*display: none/);
  assert.match(styles, /\.app-frame\.tablet-inspector-main \.inspector \{[\s\S]*display: grid[\s\S]*align-content: stretch/);
  assert.match(styles, /\.app-frame\.tablet-inspector-main \.thread-drawer \{[\s\S]*border-left: 2px solid var\(--border\)/);
});

test('desktop thread inspector can expand to a Slock-like reading width', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();

  assert.match(app, /\$\{threadMessageId \? `\$\{inspectorHtml \? ' tablet-inspector-main' : ''\} thread-open` : ''\}/);
  assert.match(app, /const INSPECTOR_MAX_WIDTH = 1800/);
  assert.match(styles, /\.collab-frame \{[\s\S]*grid-template-columns: minmax\(240px, min\(var\(--rail-width, 300px\), 420px\)\) 4px minmax\(360px, 1fr\) 4px minmax\(260px, min\(var\(--inspector-width, 340px\), 40vw\)\)/);
  assert.match(styles, /\.collab-frame\.thread-open \{[\s\S]*grid-template-columns: minmax\(240px, min\(var\(--rail-width, 300px\), 420px\)\) 4px minmax\(360px, 1fr\) 4px minmax\(260px, min\(var\(--inspector-width, 340px\), 60vw\)\)/);
  assert.match(styles, /@media \(max-width: 1200px\)[\s\S]*\.collab-frame\.thread-open \{[\s\S]*grid-template-columns: minmax\(180px, min\(var\(--rail-width, 220px\), 320px\)\) 4px minmax\(300px, 1fr\) 4px minmax\(240px, min\(var\(--inspector-width, 320px\), 52vw\)\)/);
});

test('members navigation restores the last detail and falls back to the first agent', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const leftNavSource = app.slice(app.indexOf("if (action === 'set-left-nav')"), app.indexOf("if (action === 'select-agent')"));
  const setRailSource = app.slice(app.indexOf("if (action === 'set-rail-tab')"), app.indexOf("if (action === 'set-left-nav')"));
  const selectAgentSource = app.slice(app.indexOf("if (action === 'select-agent')"), app.indexOf("if (action === 'close-agent-detail')"));

  assert.match(app, /const MEMBERS_LAYOUT_MODES = new Set\(\['directory', 'channel', 'split', 'agent', 'human'\]\)/);
  assert.match(app, /function rememberMembersLayoutFromCurrent\(\)/);
  assert.match(app, /function restoreMembersLayout\(\)/);
  assert.match(app, /function selectMembersDefault\(\)/);
  assert.match(app, /function openMembersNav\(\{ preserveSpace = false \} = \{\}\)/);
  assert.match(app, /if \(activeView === 'members'\) return renderMembersMain\(\)/);
  assert.match(app, /function renderInspector\(\) \{\s*if \(activeView === 'members'\) return '';/);
  assert.doesNotMatch(app, /if \(activeView === 'members' && !selectedAgentId\) \{\s*activeView = 'space'/);
  assert.match(leftNavSource, /const agentId = openMembersNav\(\{ preserveSpace: activeView === 'space' \}\)/);
  assert.match(setRailSource, /const agentId = openMembersNav\(\{ preserveSpace: activeView === 'space' \}\)/);
  assert.match(app, /membersLayout = normalizeMembersLayout\(\{ mode: 'human', humanId: selectedHumanId \}\)/);
  assert.match(app, /membersLayout = normalizeMembersLayout\(\{ mode: 'agent', agentId: agent\.id \}\)/);
  assert.match(app, /membersLayout = normalizeMembersLayout\(\{ mode: 'channel' \}\)/);
  assert.doesNotMatch(leftNavSource, /channelAssignableAgents\(\)\[0\]/);
  assert.match(selectAgentSource, /if \(railTab === 'members'\) \{[\s\S]*activeView = 'members'[\s\S]*rememberMembersLayoutFromCurrent\(\)/);
  assert.match(styles, /\.members-page/);
  assert.match(styles, /\.workspace > \.agent-detail-shell/);
});

test('message human avatars open right-side human details without changing the chat route', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const avatarSource = app.slice(app.indexOf('function renderHumanIdentityButton'), app.indexOf('function renderActorName'));
  const actorNameSource = app.slice(app.indexOf('function renderActorName'), app.indexOf('// Parse <@id>'));
  const inspectorSource = app.slice(app.indexOf('function renderInspector()'), app.indexOf('function renderProjectFilePreview()'));
  const clickSource = app.slice(app.indexOf("if (action === 'select-human-inspector')"), app.indexOf("if (action === 'select-human')"));
  const subtitleSource = app.slice(app.indexOf('function actorSubtitle'), app.indexOf('function renderMentionChips'));

  assert.match(avatarSource, /data-action="select-human-inspector"/);
  assert.match(avatarSource, /renderHumanHoverCard\(human\)/);
  assert.match(actorNameSource, /class="human-author-name"/);
  assert.match(actorNameSource, /data-action="select-human-inspector"/);
  assert.match(actorNameSource, /<strong>@\$\{escapeHtml\(displayName\(authorId\)\)\}<\/strong>/);
  assert.match(actorNameSource, /renderHumanHoverCard\(human\)/);
  assert.match(clickSource, /if \(activeView !== 'space'\)/);
  assert.match(clickSource, /if \(activeView === 'members'\) syncBrowserRouteForActiveView\(\)/);
  assert.match(inspectorSource, /if \(selectedHumanId\)/);
  assert.match(subtitleSource, /humanByIdAny/);
  assert.match(subtitleSource, /cloudMemberForHuman/);
  assert.match(subtitleSource, /cloudMemberDisplayRole/);
  assert.match(subtitleSource, /agentSubtitle\(agent\)/);
  assert.match(app, /agent\.description \? `\$\{agent\.description\} · \$\{runtimeConfigurationLabel\(agent\)\}`/);
  assert.doesNotMatch(subtitleSource, /channelOwnerId[\s\S]*admin/);
  assert.match(styles, /\.avatar\.human-avatar-cell/);
  assert.match(styles, /\.human-identity-button/);
  assert.match(styles, /\.human-author-name/);
  assert.match(styles, /\.agent-hover-detail/);
});

test('dm chat and task empty states use MagClaw-style simple surfaces', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();

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
  const app = await readAppSource();
  const channelModalSource = app.slice(app.indexOf('function renderChannelModal'), app.indexOf('function renderEditChannelModal'));
  const joinHelperSource = app.slice(app.indexOf('function agentCanJoinNewChannel'), app.indexOf('function channelAssignableAgents'));
  const styles = await readStylesSource();

  assert.match(app, /function agentCanJoinNewChannel\(agent\)/);
  assert.match(joinHelperSource, /return agentIsActiveInWorkspace\(agent\);/);
  assert.doesNotMatch(joinHelperSource, /agentDisplayStatus|offline|error/);
  assert.match(channelModalSource, /<form id="channel-form" class="modal-form" autocomplete="off"/);
  assert.match(channelModalSource, /<input name="name"[^>]*autocomplete="off"/);
  assert.match(channelModalSource, /<textarea name="description"[^>]*autocomplete="off"/);
  assert.match(channelModalSource, /Members <small>\(optional\)<\/small>/);
  assert.match(channelModalSource, /id="create-channel-member-search"/);
  assert.doesNotMatch(channelModalSource, /checked/);
  assert.match(styles, /\.create-channel-member-row:has\(input\[type="checkbox"\]:checked\)/);
});

test('message composers refocus after enter-submit sends', async () => {
  const app = await readAppSource();
  const renderSource = app.slice(app.indexOf('function render()'), app.indexOf('function renderRail()'));
  const submitSource = app.slice(app.indexOf("document.addEventListener('submit'"), app.indexOf('refreshState().then'));

  assert.match(app, /let pendingComposerFocusId = null/);
  assert.match(app, /function focusComposerTextarea\(composerId\)/);
  assert.match(app, /function requestComposerFocus\(composerId\)/);
  assert.match(app, /function restorePendingComposerFocus\(\)/);
	  assert.match(app, /function snapshotComposerState\(form, composerId/);
	  assert.match(app, /function clearComposerForSubmit\(form, composerId/);
	  assert.match(app, /function restoreComposerAfterFailedSubmit\(form, composerId/);
	  assert.match(app, /references: typeof outgoingComposerReferences === 'function' \? outgoingComposerReferences\(composerId\) : \[\]/);
	  assert.match(app, /clearComposerReferences\(composerId\)/);
	  assert.match(app, /setComposerReferences\(composerId, snapshot\?\.references \|\| \[\]\)/);
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
  const app = await readAppSource();
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
  const app = await readAppSource();
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
  assert.match(selectSpaceSource, /markSpaceRead\(selectedSpaceType, selectedSpaceId\)/);
  assert.match(setTabSource, /persistVisiblePaneScrolls\(\);[\s\S]*activeTab = target\.dataset\.tab/);
});

test('task cards open their thread conversation and keep compact blocks without delete action', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
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

test('global task board follows MagClaw board list channel filtering without stopped task state', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
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
  const app = await readAppSource();
  const styles = await readStylesSource();
  const messageSource = app.slice(app.indexOf('function renderMessage'), app.indexOf('function renderComposer'));
  const inlineBadgeSource = app.slice(app.indexOf('function renderTaskStatusMenu'), app.indexOf('function renderThreadKindBadge'));
  const threadsSource = app.slice(app.indexOf('function renderThreads'), app.indexOf('function renderSaved'));
  const savedSource = app.slice(app.indexOf('function renderSavedRecord'), app.indexOf('function renderSearch'));
  const taskCardSource = app.slice(app.indexOf('function renderTaskCard'), app.indexOf('function renderTaskActionButtons'));
  const clickSource = app.slice(app.indexOf("if (action === 'toggle-task-status-menu')"), app.indexOf("if (action === 'message-task')"));
  const lifecycleSource = app.slice(app.indexOf('function renderTaskLifecycle'), app.indexOf('function renderModal'));

  assert.match(app, /function taskStatusIcon\(status\)/);
  assert.match(app, /function renderTaskStatusBadge\(status, options = \{\}\)/);
  assert.match(app, /function renderTaskInlineBadge\(task, options = \{\}\)/);
  assert.match(app, /function renderTaskStatusMenu\(task\)/);
  assert.match(app, /function renderTaskStateFlow\(task\)/);
  assert.match(app, /function renderTaskHistoryCompact\(task\)/);
  assert.match(messageSource, /renderTaskInlineBadge\(task/);
  assert.match(inlineBadgeSource, /data-action="toggle-task-status-menu"/);
  assert.match(inlineBadgeSource, /data-action="task-status-set"/);
  assert.equal(messageSource.includes('pill(task.status'), false);
  assert.match(threadsSource, /renderThreadKindBadge\(message, task\)/);
  assert.match(savedSource, /renderTaskInlineBadge\(task/);
  assert.match(savedSource, /renderTaskInlineBadge\(task, \{ showAssignee: false, interactive: false \}\)/);
  assert.match(taskCardSource, /renderTaskInlineBadge\(task, \{ showAssignee: false, hover: false, interactive: false \}\)/);
  assert.match(clickSource, /openTaskStatusMenuId = openTaskStatusMenuId === taskId \? null : taskId/);
  assert.match(clickSource, /if \(action === 'task-status-set'\)/);
  assert.match(clickSource, /\/api\/tasks\/\$\{taskId\}/);
  assert.match(clickSource, /body: JSON\.stringify\(\{ status: nextStatus \}\)/);
  assert.match(lifecycleSource, /renderTaskStateFlow\(task\)/);
  assert.match(lifecycleSource, /renderTaskHistoryCompact\(task\)/);
  assert.equal(lifecycleSource.includes('<span>${escapeHtml(task.status)}</span>'), false);
  assert.equal(lifecycleSource.includes('<p>${escapeHtml(plainActorText(item.message))}</p>'), false);
  assert.match(styles, /\.task-status-icon-badge/);
  assert.match(styles, /\.task-inline-badge/);
  assert.match(styles, /\.task-status-menu/);
  assert.match(styles, /\.task-inline-badge\.open \.task-status-menu/);
  assert.doesNotMatch(styles, /\.task-inline-badge:hover \.task-hover-card/);
  assert.match(styles, /\.task-state-flow/);
  assert.match(styles, /\.task-state-node\.current > span::before/);
  assert.match(styles, /@keyframes taskAutocastSpin/);
  assert.match(styles, /\.task-lifecycle-events/);
  assert.match(styles, /\.task-action-btn/);
  assert.match(styles, /\.thread-kind-badge/);
});

test('search input preserves IME composition and updates results without full rerender', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
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
  const app = await readAppSource();

  assert.match(app, /function searchRecords\(query\)/);
  assert.match(app, /\.\.\.\(appState\?\.messages \|\| \[\]\), \.\.\.\(appState\?\.replies \|\| \[\]\)/);
  assert.match(app, /function searchScore\(record, query\)/);
  assert.match(app, /function highlightSearchText\(text, query\)/);
  assert.match(app, /data-action="open-search-result"/);
  assert.match(app, /function openSearchResult\(record\)/);
  assert.match(app, /function scrollToReply\(replyId\)/);
});

test('search page matches MagClaw shortcuts filters persistence and thread drawer behavior', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
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
  const app = await readAppSource();
  const styles = await readStylesSource();
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
  const app = await readAppSource();
  const styles = await readStylesSource();

  assert.match(app, /const clickedTaskChannelFilter = event\.target\.closest\('\.task-channel-filter'\)/);
  assert.match(app, /taskChannelMenuOpen && !clickedTaskChannelFilter/);
  assert.match(app, /taskChannelMenuOpen = false;[\s\S]*if \(!target\) \{[\s\S]*render\(\);[\s\S]*return;/);
  assert.match(styles, /\.task-list-body \.compact-task-card \{[\s\S]*max-height: none/);
  assert.match(styles, /\.task-list-body \.task-card-title \{[\s\S]*min-height: auto/);
  assert.match(styles, /\.task-list-body \.task-card-foot \{[\s\S]*line-height: 1\.15/);
});

test('member rail lists keep status dots on the far right only in the agent tab', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const agentListSource = app.slice(app.indexOf('function renderAgentListItem'), app.indexOf('function renderHumanListItem'));
  const humanListSource = app.slice(app.indexOf('function renderHumanListItem'), app.indexOf('function renderComputerListItem'));
  const computerListSource = app.slice(app.indexOf('function renderComputerListItem'), app.indexOf('function renderReply'));

  assert.match(agentListSource, /member-status-side/);
  assert.match(humanListSource, /member-status-side/);
  assert.match(computerListSource, /member-status-side/);
  assert.equal(agentListSource.includes("avatarStatusDot(agent.status"), false);
  assert.match(styles, /\.member-status-side/);
  assert.match(styles, /\.member-info \.agent-live-activity-bar\.compact \{[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(styles, /\.member-info \.agent-live-activity-bar\.compact \.agent-activity-dot \{[\s\S]*display: none/);
  assert.match(styles, /\.member-btn \.dm-avatar-wrap \.avatar-status-dot/);
  assert.match(styles, /\.message-card \.avatar-status-dot/);
});

test('human identity UI shows third-party names only as secondary identity metadata', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const accountSettingsSource = app.slice(app.indexOf('function renderAccountSettingsTab()'), app.indexOf('function normalizeInviteEmailValue(value)'));
  const hoverSource = app.slice(app.indexOf('function renderHumanHoverCard'), app.indexOf('const identityHoverTriggerSelector'));
  const humanListSource = app.slice(app.indexOf('function renderHumanListItem'), app.indexOf('function renderComputerListItem'));
  const mentionSource = app.slice(app.indexOf('function mentionHandle'), app.indexOf('function mentionSearchValue'));
  const addMemberSource = app.slice(app.indexOf('function renderAddMemberCandidateGroup'), app.indexOf('function channelMemberProposalCards'));

  assert.match(app, /function thirdPartyNameForUser/);
  assert.match(app, /function thirdPartyNameForHuman/);
  assert.match(app, /thirdPartyNameForUser\(user\)/);
  assert.match(app, /const enrichedMember = \(appState\?\.cloud\?\.members \|\| \[\]\)\.find/);
  assert.match(accountSettingsSource, /currentUserThirdPartyName/);
  assert.match(accountSettingsSource, /Third-party Name[\s\S]*disabled/);
  assert.match(hoverSource, /renderHoverDetail\('Third-party Name'/);
  assert.match(mentionSource, /mention-third-party-name/);
  assert.match(mentionSource, /thirdPartyName/);
  assert.match(addMemberSource, /humanSecondaryIdentityText/);
  assert.match(humanListSource, /member-third-party-name/);
  assert.match(styles, /\.member-third-party-name/);
  assert.match(styles, /\.mention-third-party-name/);
  assert.match(styles, /\.add-member-third-party-name/);
});

test('agent warmup renders as Warming with a distinct pink status dot', async () => {
  const app = await readAppSource();
  const serverWarmSource = await readFile(new URL('../server/agent-runtime/app-server-turns.js', import.meta.url), 'utf8');
  const styles = await readStylesSource();
  const agentListSource = app.slice(app.indexOf('function renderAgentListItem'), app.indexOf('function renderHumanListItem'));
  const profileSource = app.slice(app.indexOf('function renderAgentProfileTab'), app.indexOf('function renderAgentDmsTab'));

  assert.match(app, /function agentIsWarming\(agent\)/);
  assert.match(app, /agent\?\.runtimeActivity/);
  assert.match(app, /function agentDisplayStatus\(agent\)/);
  assert.match(serverWarmSource, /isWarmup \? 'warming' : 'thinking'/);
  assert.match(app, /if \(agentIsWarming\(agent\)\) return 'warming'/);
  assert.match(app, /!computerIsConnected\(computer\)/);
  assert.match(app, /function computerUpgradeBlocksAgentDelivery\(computer = \{\}\)/);
  assert.match(app, /computerUpgradeBlocksAgentDelivery\(computer\)\) return 'waiting_for_upgrade'/);
  assert.match(app, /waiting_for_computer/);
  assert.doesNotMatch(app, /agent\.computerId && !computer && agent\.computerId !== 'cmp_local'[\s\S]*return 'deleted'/);
  assert.match(app, /if \(value === 'warming'\) return 'Warming'/);
  assert.match(app, /return 'Waiting for computer'/);
  assert.match(agentListSource, /const status = agentDisplayStatus\(agent\)/);
  assert.match(profileSource, /presenceClass\(agentDisplayStatus\(agent\)\)/);
  assert.match(styles, /\.avatar-status-dot\.status-warming \{[\s\S]*background: var\(--magclaw-pink\)/);
});

test('idle agents stay green while warmed standby renders purple', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();

  assert.match(app, /if \(value === 'idle'\) return 'idle'/);
  assert.match(app, /function agentIsStandby\(agent\)/);
  assert.match(app, /if \(agentIsStandby\(agent\)\) return 'standby'/);
  assert.match(app, /if \(value === 'standby'\) return 'standby'/);
  assert.match(app, /if \(value === 'standby'\) return 'Standby'/);
  assert.doesNotMatch(app, /\['online', 'idle', 'connected'\]\.includes\(value\)/);
  assert.doesNotMatch(styles, /--resting: #14532d/);
  assert.match(styles, /--standby: #C9B5FF/);
  assert.match(styles, /\.avatar-status-dot\.status-idle \{[\s\S]*background: var\(--success\)/);
  assert.match(styles, /\.avatar-status-dot\.status-standby \{[\s\S]*background: var\(--standby\)/);
  assert.match(styles, /\.agent-hover-status-dot\.status-idle \{[\s\S]*background: var\(--success\)/);
  assert.match(styles, /\.agent-hover-status-dot\.status-standby \{[\s\S]*background: var\(--standby\)/);
  assert.match(styles, /\.add-member-status-dot\.status-idle \{[\s\S]*background: var\(--success\)/);
  assert.match(styles, /\.add-member-status-dot\.status-standby \{[\s\S]*background: var\(--standby\)/);
});

test('agent warmup is session-scoped and not retriggered by every state refresh', async () => {
  const app = await readAppSource();
  const refreshSource = app.slice(app.indexOf('async function refreshState()'), app.indexOf('function cloudAuthErrorMessage'));
  const warmSource = app.slice(app.indexOf('function agentWarmRequestKey'), app.indexOf('function readAvatarFileAsDataUrl'));

  assert.match(warmSource, /function agentHasWarmRuntimeSession\(agent\)/);
  assert.match(warmSource, /agent\?\.runtimeWarmAt/);
  assert.match(warmSource, /agent\?\.runtimeLastTurnAt/);
  assert.match(warmSource, /if \(agentHasWarmRuntimeSession\(agent\)\) return;/);
  assert.doesNotMatch(refreshSource, /maybeWarmCurrentAgent\(\)/);
});

test('state refresh replaces inaccessible server routes with the active workspace route', async () => {
  const app = await readAppSource();
  const refreshSource = app.slice(app.indexOf('async function refreshState()'), app.indexOf('function cloudAuthErrorMessage'));

  assert.match(refreshSource, /workspaceAccess\?\.denied/);
  assert.match(refreshSource, /syncBrowserRouteForActiveView\(\{ replace: true \}\)/);
  assert.ok(
    refreshSource.indexOf('workspaceAccess?.denied') < refreshSource.indexOf('render()'),
    'route correction must happen before rendering the fallback workspace',
  );
});

test('event stream follows the selected conversation bootstrap window', async () => {
  const app = await readAppSource();
  const eventSource = app.slice(app.indexOf('function eventStreamPathForCurrentSelection()'), app.indexOf('function disconnectEvents()'));

  assert.match(eventSource, /new URLSearchParams\(\)/);
  assert.match(eventSource, /params\.set\('spaceType', selectedSpaceType/);
  assert.match(eventSource, /params\.set\('spaceId', selectedSpaceId/);
  assert.match(eventSource, /params\.set\('messageLimit', '80'\)/);
  assert.match(eventSource, /return `\/api\/events\?\$\{params\.toString\(\)\}`/);
  assert.match(eventSource, /eventSourcePath === eventPath/);
  const routeSource = app.slice(app.indexOf('function syncBrowserRouteForActiveView'), app.indexOf('function isImeComposing'));
  assert.match(routeSource, /eventSource && typeof connectEvents === 'function'/);
});

test('codex agent startup repairs stale configured Codex paths before spawning', async () => {
  const source = await readFile(new URL('../server/agent-runtime/process-start.js', import.meta.url), 'utf8');
  const legacySource = await readFile(new URL('../server/agent-runtime/legacy-stop.js', import.meta.url), 'utf8');

  assert.match(source, /async function resolveCodexSpawnCommand\(agent\)/);
  assert.match(source, /process\.env\.CODEX_PATH/);
  assert.match(source, /state\.settings\.codexPath = command/);
  assert.match(source, /codex_path_repaired/);
  assert.match(source, /function runtimeCommandNeedsShell\(command\)/);
  assert.equal(source.includes('/\\.(cmd|bat)$/i'), true);
  assert.match(source, /shell: runtimeCommandNeedsShell\(value\)/);
  assert.match(source, /const codexCommand = await resolveCodexSpawnCommand\(agent\)/);
  assert.match(source, /spawn\(codexCommand, args/);
  assert.match(source, /shell: runtimeCommandNeedsShell\(codexCommand\)/);
  assert.match(legacySource, /shell: runtimeCommandNeedsShell\(state\.settings\.codexPath \|\| 'codex'\)/);
});

test('message rows re-render when author presence changes from heartbeat', async () => {
  const app = await readAppSource();
  const renderKeySource = app.slice(app.indexOf('function renderRecordKey'), app.indexOf('function renderSystemEvent'));
  const humanStatusSource = app.slice(app.indexOf('function humanStatusDot'), app.indexOf('function attachmentLinks'));

  assert.match(renderKeySource, /authorStatus: author\?\.status \|\| ''/);
  assert.match(renderKeySource, /record\?\.authorType === 'agent'/);
  assert.match(app, /function applyPresenceHeartbeat\(heartbeat\)/);
  assert.match(app, /const incomingHumansById = new Map/);
  assert.match(app, /humans,\n    updatedAt: heartbeat\.updatedAt/);
  assert.match(humanStatusSource, /humanByIdAny\(authorId\)/);
});

test('mention candidates hide deleted agents', async () => {
  const app = await readAppSource();
  const mentionSource = app.slice(app.indexOf('function getMentionCandidates'), app.indexOf('async function getProjectMentionCandidates'));

  assert.match(mentionSource, /agentIsActiveInWorkspace\(agent\)/);
  assert.match(mentionSource, /String\(agent\?\.status \|\| ''\)\.toLowerCase\(\) !== 'deleted'/);
});

test('agent detail opened from a thread returns to that thread when closed', async () => {
  const app = await readAppSource();

  assert.match(app, /let inspectorReturnThreadId = null/);
  assert.match(app, /if \(threadMessageId\) inspectorReturnThreadId = threadMessageId/);
  assert.match(app, /if \(inspectorReturnThreadId && byId\(appState\.messages, inspectorReturnThreadId\)\) \{[\s\S]*threadMessageId = inspectorReturnThreadId/);
  assert.match(app, /inspectorReturnThreadId = null;[\s\S]*render\(\);/);
});

test('selected thread rows keep the active highlight while the drawer is open', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();

  assert.match(app, /const active = threadMessageId === message\.id \? ' active' : ''/);
  assert.match(app, /class="thread-row magclaw-thread-row\$\{active\}"/);
  assert.match(styles, /\.thread-row\.active/);
  assert.match(styles, /\.thread-list-panel/);
  assert.match(styles, /border: 1px solid #d4d1c8/);
});

test('messages use MagClaw-style hover save actions and saved messages open context', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
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

test('message reactions, context menus, and share mode expose Slock-style interactions with MagClaw styling', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const renderKeySource = app.slice(app.indexOf('function renderRecordKey'), app.indexOf('function renderSystemEvent'));
  const localOnlySource = app.slice(app.indexOf('const localOnlyActions = new Set'), app.indexOf('// Environment variable actions'));
  const shareImageSource = app.slice(app.indexOf('async function generateShareImageDataUrl'), app.indexOf('function saveShareImage'));
  const messageContextMenuSource = app.slice(app.indexOf('function renderMessageContextMenu()'), app.indexOf('function renderShareSelectionBar()'));

  assert.match(app, /const MAGCLAW_MESSAGE_REACTIONS = \[/);
  assert.match(app, /key: 'rocket'/);
  assert.match(app, /key: 'pin'/);
  assert.match(app, /function renderMessageReactionTray\(record\)/);
  assert.match(app, /const SHARE_MESSAGE_SELECTION_LIMIT = 100/);
  assert.match(app, /const SHARE_IMAGE_RENDER_MIN_MS = 240/);
  assert.match(app, /function shareSelectionLimitMessage\(\)/);
  assert.match(app, /function renderMessageContextMenu\(\)/);
  assert.match(app, /function messageContextMenuPlacement\(menu = messageContextMenu\)/);
  assert.match(app, /data-menu-placement="\$\{escapeHtml\(placement\.placement\)\}"/);
  assert.match(app, /--menu-max-height: \$\{placement\.maxHeight\}px/);
  assert.match(app, /viewportHeight: Number\.isFinite\(window\.innerHeight\) \? window\.innerHeight : 0/);
  assert.match(app, /const MESSAGE_LONG_PRESS_MS = 520/);
  assert.match(app, /function messageRecordIdFromInteractionTarget\(target\)/);
  assert.match(app, /document\.addEventListener\('touchstart', handleMessageLongPressStart/);
  assert.match(app, /openMessageContextMenu\(recordId, payload, 'message', \{ source: 'message-long-press' \}\)/);
  assert.match(app, /function renderShareSelectionBar\(\)/);
  assert.match(app, /function renderSharePreviewModal\(\)/);
  assert.match(app, /function messageShareStateForRecord\(record\)/);
  assert.match(app, /function recordMatchesShareScope\(record\)/);
  assert.match(app, /function shareSelectableRecords\(\)/);
  assert.match(app, /function shareSelectAllTargetIds\(\)/);
  assert.match(app, /function shareAllSelectableMessagesSelected\(\)/);
  assert.match(app, /function shareReplacementLines\(record\)/);
  assert.match(app, /function shareRecordPlainText\(record\)/);
  assert.match(app, /function shareBodyToggleAttrs\(record,/);
  assert.doesNotMatch(app, /function isThreadShareRoot\(messageId\)/);
  assert.match(app, /function messageRecordLink\(record\)/);
  assert.match(app, /function messageRecordMarkdown\(record\)/);
  assert.match(app, /async function generateShareImageDataUrl/);
  assert.match(app, /function shareInlineTokenRuns\(text = ''\)/);
  assert.match(app, /function drawShareInlineText\(ctx, text, x, y, maxWidth\)/);
  assert.match(app, /function shareReactionChipRows\(ctx, groups = \[\], maxWidth = 0\)/);
  assert.match(app, /function shareActorProfile\(record\)/);
  assert.match(app, /function shareAvatarProxyUrl\(src\)/);
  assert.match(app, /function drawShareAvatar\(ctx, profile, image, x, y, size\)/);
  assert.match(app, /loadCanvasImage\(BRAND_LOGO_SRC\)/);
  assert.match(shareImageSource, /groupedMessageReactions\(record\)/);
  assert.match(shareImageSource, /shareRecordPlainText\(record\)/);
  assert.match(shareImageSource, /reactionRows/);
  assert.match(shareImageSource, /const width = 1040/);
  assert.match(shareImageSource, /const threadRootId = messageShareState\.scope === 'thread'/);
  assert.match(shareImageSource, /isThreadReply/);
  assert.match(shareImageSource, /drawShareInlineText\(ctx, line, contentX/);
  assert.match(shareImageSource, /drawShareAvatar\(ctx, profile, row\.avatarImage/);
  assert.match(shareImageSource, /const SHARE_REACTION_TOP_GAP = 12/);
  assert.match(shareImageSource, /Math\.max\(0, lines\.length - 1\) \* SHARE_LINE_HEIGHT \+ SHARE_REACTION_TOP_GAP/);
  assert.doesNotMatch(shareImageSource, /detailY \+= 8/);
  assert.match(shareImageSource, /MagClaw/);
  assert.match(app, /function shareServerProfile\(\)/);
  assert.match(app, /function sharePublicDomain\(\)/);
  assert.match(app, /appState\?\.connection\?\.publicUrl/);
  assert.match(app, /function drawShareServerAvatar\(ctx, profile, image, x, y, size\)/);
  assert.doesNotMatch(shareImageSource, /MESSAGE/);
  assert.doesNotMatch(shareImageSource, /strokeRect\(rowX/);
  assert.doesNotMatch(app, /SHARE_IMAGE_DIRECTORY_PICKER_ID/);
  assert.doesNotMatch(app, /window\.showDirectoryPicker/);
  assert.match(app, /window\.showSaveFilePicker/);
  assert.match(app, /function canSaveShareImageViaServer\(\)/);
  assert.match(app, /async function saveShareImageViaServer/);
  assert.match(app, /\/api\/share-images\/save/);
  assert.match(app, /method: 'file-picker'/);
  assert.match(app, /method: 'server'/);
  assert.match(app, /method: 'download'/);
  assert.match(app, /async function saveShareImage\(\)/);
  assert.match(app, /Share image saved to/);
  assert.doesNotMatch(app, /SHARE_IMAGE_DIRECTORY_DB|openShareImageDirectoryDb|rememberShareImageDirectoryHandle|storedShareImageDirectoryHandle/);
  assert.match(renderKeySource, /reactions: record\?\.reactions \|\| \[\]/);
  assert.match(renderKeySource, /followedBy: record\?\.followedBy \|\| \[\]/);
  assert.match(app, /data-action="open-message-context-menu"/);
  assert.match(app, /data-action="toggle-message-reaction"/);
  assert.match(app, /data-action="start-message-share"/);
  assert.match(app, /data-action="toggle-share-selection"/);
	  assert.match(app, /data-action="toggle-share-select-all"/);
	  assert.match(app, /const shareSelectable = !options\.compact && messageShareState\.active/);
	  assert.match(app, /const shareSelectable = messageShareState\.active && recordMatchesShareScope\(reply\)/);
	  assert.match(app, /data-share-body-toggle="1"/);
	  assert.match(app, /data-action="copy-selected-markdown"/);
	  assert.match(app, /data-action="add-selected-messages-context"/);
	  assert.match(app, /data-action="download-selected-image"/);
  assert.match(app, /data-action="save-share-image"/);
  assert.match(app, /selected\.size >= SHARE_MESSAGE_SELECTION_LIMIT/);
  assert.match(app, /shareSelectableRecords\(\)\.length > SHARE_MESSAGE_SELECTION_LIMIT/);
  assert.match(app, /shareSelectableRecords\(\)\.slice\(0, SHARE_MESSAGE_SELECTION_LIMIT\)/);
  assert.match(app, /const allSelectableSelected = shareAllSelectableMessagesSelected\(\)/);
  assert.match(app, /allSelectableSelected \? 'Deselect all' : 'Select all'/);
  assert.doesNotMatch(app, /loadShareSelectAllThreadWindow|order=oldest/);
  assert.match(app, /if \(shareAllSelectableMessagesSelected\(\)\) \{[\s\S]*messageShareState = emptyMessageShareState\(\);[\s\S]*sharePreviewState = \{ open: false, imageUrl: '', recordIds: \[\] \};/);
  assert.match(app, /escapeHtml\(t\('Share preview'\)\)/);
  assert.match(app, /escapeHtml\(t\('Rendering\.\.\.'\)\)/);
  assert.match(app, /escapeHtml\(t\('Save image'\)\)/);
  assert.match(app, /'Deselect all': '取消全选'/);
  assert.match(app, /'Share preview': '分享预览'/);
  assert.match(app, /'Save image': '保存图片'/);
  assert.match(app, /\[\s*\/\^You can select up to \(\\d\+\) messages\\\.\$\/,\s*'最多只能选择 \$1 条消息'/);
  assert.match(app, /requestAnimationFrame\(\(\) => resolve\(\)\)/);
  assert.match(app, /remainingRenderMs > 0/);
  assert.match(app, /share-preview-loading/);
  assert.match(app, /share-preview-spinner/);
  assert.match(app, /messageShareState = emptyMessageShareState\(\)/);
  assert.match(app, /sharePreviewState = \{ open: false, imageUrl: '', recordIds: \[\] \}/);
  assert.match(app, /upsertConversationRecord\(appState\.messages, result\.message\)/);
  assert.match(app, /data-context-scope="saved"/);
	  assert.match(app, /Copy markdown/);
	  assert.match(app, /Share messages\.\.\./);
			  assert.doesNotMatch(messageContextMenuSource, /引用消息回复|添加到对话/);
			  assert.doesNotMatch(messageContextMenuSource, /renderContextMenuItem\('quote-message-reply'/);
			  assert.doesNotMatch(messageContextMenuSource, /renderContextMenuItem\('quote-selected-text'/);
			  assert.match(messageContextMenuSource, /renderContextMenuItem\('add-message-context', t\('Add to context'\), record\.id\)/);
			  assert.match(messageContextMenuSource, /renderContextMenuItem\('add-selected-text-context', t\('Add to context'\), record\.id\)/);
			  assert.match(messageContextMenuSource, /recordHasThreadContext\(record\)/);
			  assert.match(messageContextMenuSource, /renderContextMenuItem\('add-thread-context', t\('Add thread to context'\), record\.id\)/);
		  assert.match(app, /renderContextMenuItem\('add-selected-text-context'/);
		  assert.match(app, /function selectedMessageTextForEvent\(event\)/);
		  assert.match(app, /function renderComposerReferenceStrip\(composerId\)/);
	  assert.match(app, /function renderMessageReferences\(record\)/);
	  assert.match(app, /referencePreviewDisplayText\(reference\)/);
	  assert.match(app, /escapeHtml\(referencePreviewDisplayText\(reference\)\)/);
	  assert.match(app, /references: typeof normalizeConversationReferenceDrafts === 'function'/);
	  assert.match(app, /Follow Thread/);
  assert.doesNotMatch(app, /shareThreadClass/);
  assert.match(localOnlySource, /'open-message-context-menu'/);
  assert.match(localOnlySource, /'start-message-share'/);
  assert.match(localOnlySource, /'toggle-share-selection'/);
	  assert.match(localOnlySource, /'toggle-share-select-all'/);
		  assert.doesNotMatch(localOnlySource, /'quote-message-reply'/);
		  assert.doesNotMatch(localOnlySource, /'quote-selected-text'/);
		  assert.match(localOnlySource, /'add-selected-text-context'/);
		  assert.doesNotMatch(localOnlySource, /'add-visible-conversation-context'/);
	  assert.match(localOnlySource, /'toggle-message-reaction'/);
	  assert.match(styles, /\.message-context-menu/);
	  assert.match(styles, /\.message-context-menu \{[\s\S]*left: clamp\(var\(--menu-margin\), var\(--menu-x\), calc\(100vw - var\(--menu-width\) - var\(--menu-margin\)\)\);[\s\S]*max-height: var\(--menu-max-height\);[\s\S]*overflow-y: auto;/);
	  assert.match(styles, /\.message-context-menu\[data-menu-placement="above"\] \{[\s\S]*top: auto;[\s\S]*bottom: max\(var\(--menu-margin\), calc\(100vh - var\(--menu-y\)\)\);/);
	  assert.match(styles, /\.magclaw-message \{[\s\S]*-webkit-touch-callout: none;/);
	  assert.match(styles, /\.composer-reference-strip/);
	  assert.match(styles, /\.message-reference-card/);
  assert.match(styles, /\.message-reaction-grid/);
  assert.match(styles, /\.message-reaction-tray/);
  assert.match(styles, /\.share-selection-bar/);
  assert.match(styles, /\.message-card\.share-selecting \.message-body\[data-share-body-toggle="1"\][\s\S]*user-select: none/);
  assert.match(styles, /\.human-author-name \+ \.sender-role/);
  assert.doesNotMatch(styles, /\.message-card\.share-selecting \.message-body\[data-share-body-toggle="1"\]:hover \.message-markdown/);
  assert.doesNotMatch(styles, /\.thread-context\.share-thread-mode/);
  assert.match(styles, /\.message-markdown a[\s\S]*color: #1269B7/);
  assert.match(styles, /\.share-preview-modal/);
  assert.match(styles, /\.modal-card\.share-preview-modal[\s\S]*max-height: calc\(100vh - 48px\)/);
  assert.match(styles, /\.share-preview-frame[\s\S]*overflow: auto/);
  assert.match(styles, /\.share-preview-loading/);
  assert.match(styles, /\.share-preview-spinner[\s\S]*animation: share-preview-spin/);
  assert.match(styles, /@keyframes share-preview-spin/);
  assert.match(styles, /\.modal-card\.share-preview-modal[\s\S]*border: 2px solid var\(--border\)/);
  assert.match(styles, /\.message-share-selector\.selected[\s\S]*background: #168CFF/);
  assert.match(styles, /\.message-card\.share-selecting/);
  assert.match(styles, /\.collab-frame \.message-card\.share-selecting[\s\S]*grid-template-columns: 26px 34px minmax\(0, 1fr\)/);
  assert.doesNotMatch(styles, /#ffd43b/);
});

test('conversation panes expose upward history loading affordances', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();

  assert.match(app, /CONVERSATION_HISTORY_PAGE_SIZE = 80/);
  assert.match(app, /CONVERSATION_HISTORY_TOP_THRESHOLD = 96/);
  assert.match(app, /history-page-status/);
  assert.match(app, /Scroll up for earlier messages/);
  assert.match(app, /Scroll up for earlier replies/);
  assert.match(app, /currentMainHistoryPage\(\)/);
  assert.match(app, /currentThreadHistoryPage\(message\.id\)/);
  assert.match(styles, /\.history-page-status/);
});

test('agent identities are clickable and expose MagClaw-style hover summaries', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const agentListSource = app.slice(app.indexOf('function renderAgentListItem'), app.indexOf('function renderHumanListItem'));

  assert.match(app, /function renderAgentHoverCard\(agent\)/);
  assert.match(app, /function renderAgentIdentityButton\(agentId, className = ''\)/);
  assert.match(app, /function positionIdentityHoverCard\(trigger\)/);
  assert.match(app, /handleIdentityHoverCardPointerOver/);
  assert.match(app, /data-action="select-agent" data-id="\$\{escapeHtml\(agent\.id\)\}"/);
  assert.match(app, /data-agent-author-id="\$\{escapeHtml\(message\.authorId\)\}"/);
  assert.match(app, /data-agent-author-id="\$\{escapeHtml\(reply\.authorId\)\}"/);
  assert.equal(agentListSource.includes('renderAgentHoverCard'), false);
  assert.match(styles, /\.agent-hover-card/);
  assert.match(styles, /\.agent-hover-status-dot/);
  assert.match(styles, /\.agent-hover-card \{[\s\S]*position: fixed/);
  assert.match(styles, /--agent-hover-x/);
  assert.match(styles, /visibility: hidden/);
  assert.equal(styles.includes('.member-btn:hover .agent-hover-card'), false);
});

test('agent detail uses MagClaw-style tabs with inline profile editing and runtime configuration', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const profileSource = app.slice(app.indexOf('function renderAgentProfileTab(agent)'), app.indexOf('function renderAgentDmsTab(agent)'));

  assert.equal(app.includes('id="agent-detail-form"'), false);
  assert.equal(app.includes('Save Profile'), false);
  assert.match(app, /let agentDetailTab = 'profile'/);
  assert.match(app, /function renderAgentProfileTab\(agent\)/);
  assert.match(app, /\['skills', 'Skills'\]/);
  assert.match(app, /\['workspace', 'Workspace'\]/);
  assert.match(app, /data-action="set-agent-detail-tab" data-tab="\$\{id\}"/);
  assert.match(app, /let agentDetailTabLoading = \{ agentId: null, tab: null, token: 0 \}/);
  assert.match(app, /let clickLoadingState = \{ token: 0, action: '', key: '', label: '', surface: '', startedAt: 0 \}/);
  assert.match(app, /function beginClickLoading\(action, target, localOnlyActions = new Set\(\)\)/);
  assert.match(app, /function finishClickLoading\(token, target\)/);
  assert.match(app, /function renderClickLoadingSurface\(surface\)/);
  assert.match(app, /const clickLoadingToken = beginClickLoading\(action, target, localOnlyActions\)/);
  assert.match(app, /finishClickLoading\(clickLoadingToken, target\)/);
  assert.match(app, /renderClickLoadingSurface\('main'\)/);
  assert.match(app, /renderClickLoadingSurface\('inspector'\)/);
  assert.match(app, /renderClickLoadingSurface\('modal'\)/);
  assert.match(app, /Loading server\.\.\./);
  assert.match(app, /Loading connect command\.\.\./);
  assert.match(app, /Updating task\.\.\./);
  assert.match(app, /function switchAgentDetailTab\(agentId, tab\)/);
  assert.match(app, /await switchAgentDetailTab\(selectedAgentId, target\.dataset\.tab \|\| 'profile'\)/);
  assert.match(app, /function renderAgentDetailLoading\(tab\)/);
  assert.match(app, /Loading agent DMs\.\.\./);
  assert.match(app, /Loading reminders\.\.\./);
  assert.match(app, /Loading activity\.\.\./);
  assert.doesNotMatch(app, /if \(agentDetailTab === 'workspace'\) \{\s*await prepareAgentWorkspaceTab\(selectedAgentId\);/);
  assert.match(app, /renderAgentInlineField\(agent, 'name'/);
  assert.match(app, /renderAgentInlineField\(agent, 'description'/);
  assert.match(app, /function editPencilIcon\(\)/);
  assert.match(app, /class="agent-edit-icon"/);
  assert.match(app, /data-action="edit-agent-field" data-field="\$\{escapeHtml\(field\)\}"/);
  assert.match(app, /data-action="save-agent-field" data-field="\$\{escapeHtml\(field\)\}"/);
  assert.equal(app.includes('>Edit</button>'), false);
  assert.match(app, /maxlength="3000"[\s\S]*\$\{descriptionValue\.length\}\/3000/);
  assert.match(app, /let agentDetailFieldDraft = null/);
  assert.match(app, /function captureAgentDetailFieldDraft/);
  assert.match(app, /function agentDetailFieldFocusSnapshot/);
  assert.match(app, /function restoreAgentDetailFieldFocus/);
  assert.match(app, /if \(agentDetailInlineEditIsActive\(\)\)/);
  assert.match(app, /id="agent-runtime-config-form"/);
  assert.match(app, /Runtime Configuration/);
  assert.match(app, /RESTART TO APPLY RUNTIME CONFIGURATION/);
  assert.match(app, /selectedAgentId \|\| activeView === 'members' \|\| activeView === 'computers'/);
  assert.match(app, /form\.id === 'agent-runtime-config-form'/);
  assert.match(app, /body: JSON\.stringify\(\{[\s\S]*runtimeId: runtime\.id \|\| data\.get\('runtimeId'\)/);
  assert.match(app, /Environment Variables/);
  assert.match(app, /Creator/);
  assert.match(app, /User/);
  assert.match(app, />Reasoning</);
  assert.equal(app.includes('>Thinking</span>'), false);
  assert.match(app, /type="file"[\s\S]*data-action="upload-agent-avatar"/);
  assert.match(app, /data-action="pick-agent-detail-avatar"/);
  assert.match(app, /data-action="open-agent-restart"/);
  assert.match(app, /agent-compact-info/);
  assert.match(app, /daemon \$\{daemonVersion\}/);
  assert.match(app, /data-action="select-computer" data-id="\$\{escapeHtml\(computer\?\.id \|\| ''\)\}"/);
  assert.doesNotMatch(profileSource, /Detected Runtimes|Last Seen/);
  assert.match(app, /function renderAgentStartModal\(\)/);
  assert.match(app, /data-action="confirm-agent-start"/);
  assert.match(app, /data-action="open-agent-restart"/);
  assert.match(app, /data-action="agent-stop-unavailable"/);
  assert.match(app, /function renderAgentRestartModal\(\)/);
  assert.match(app, /function markAgentRestartStarting\(agentId\)/);
  assert.match(app, /agent\.status = 'starting'/);
  assert.match(app, /markAgentRestartStarting\(agentRestartState\.agentId\);\s*await api\(`\/api\/agents\/\$\{agentRestartState\.agentId\}\/restart`/);
  assert.match(app, /RESET SESSION & RESTART/);
  assert.match(app, /Clear the runtime session and restart/);
  assert.match(app, /function renderAgentSkillsTab\(agent\)/);
  assert.match(app, /data-action="refresh-agent-skills"/);
  assert.doesNotMatch(profileSource, /Function Calls \/ Tools/);
  assert.match(app, /renderAgentToolCapsules/);
  assert.match(app, /function agentSkillCount\(skills\)/);
  assert.match(app, /renderSkillCollapseButton\('profile-skills', 'Skills'\)/);
  assert.match(app, /renderAgentSkillSections\(skills, \{ compact: true \}\)/);
  assert.equal(app.includes('renderSkillChips'), false);
  assert.match(styles, /\.agent-detail-tabs/);
  assert.match(styles, /\.agent-detail-loading/);
  assert.match(styles, /\.agent-tab-loading-dot/);
  assert.match(styles, /\.click-loading-surface/);
  assert.match(styles, /button\.is-loading::after/);
  assert.match(styles, /\.skill-row/);
  assert.match(styles, /\.agent-skill-section-stack\.compact/);
  assert.match(styles, /\.agent-tool-pill/);
  assert.match(styles, /\.agent-inline-edit/);
  assert.match(styles, /\.agent-restart-option/);
  assert.match(styles, /\.agent-compact-info/);
  assert.match(styles, /\.agent-computer-linkline/);
  assert.match(styles, /\.daemon-version-value[\s\S]*text-transform: none/);
  assert.match(styles, /\.agent-hero-status/);
  assert.match(styles, /\.agent-runtime-config-form/);
});

test('sidebar settings and skill panels support collapsible MagClaw UI sections', async () => {
  const app = await readAppSource();
  const index = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const styles = await readStylesSource();
  const releaseStyles = await readFile(new URL('../public/app/release-settings.css', import.meta.url), 'utf8');

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
  assert.doesNotMatch(app, /id: 'system'/);
  assert.doesNotMatch(app, /System Config/);
  assert.match(app, /Release Notes/);
  assert.match(app, /MAGCLAW_WEB_PACKAGE_VERSION = '0\.3\.8'/);
  assert.match(app, /function renderReleaseVersionCard\(release\)/);
  assert.match(app, /bugFix: 'bug-fix'/);
  assert.match(app, /features: 'feature'/);
  assert.match(app, /Versioned changelog/);
  assert.match(app, /Agent warmup/);
  assert.match(index, /<link rel="stylesheet" href="\/app\/release-settings\.css" \/>/);
  assert.match(styles, /\.rail-collapse-btn/);
  assert.match(styles, /\.skill-collapse-btn/);
  assert.match(styles, /\.settings-nav-list/);
  assert.match(styles, /\.settings-page-header/);
  assert.match(releaseStyles, /\.settings-release/);
  assert.match(releaseStyles, /\.release-version-card/);
  assert.match(releaseStyles, /\.release-summary-card/);
  assert.match(releaseStyles, /\.release-note-row/);
});

test('left rail and active shell controls use the MagClaw pink accent', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const railSource = app.slice(app.indexOf('function renderRail()'), app.indexOf('function currentServerProfile()'));

  assert.match(styles, /--magclaw-rail:\s*var\(--accent\)/);
  assert.match(styles, /--magclaw-rail-badge:\s*#FFE15A/);
  assert.match(styles, /\.rail > \.magclaw-left-rail \{[\s\S]*?background:\s*var\(--magclaw-rail\)/);
  assert.match(styles, /\.left-rail-avatar \{[\s\S]*?color:\s*var\(--magclaw-rail\)/);
  assert.match(styles, /\.left-rail-btn em \{[\s\S]*?background:\s*var\(--magclaw-rail-badge\)[\s\S]*?color:\s*var\(--magclaw-rail-badge-text\)/);
  assert.match(styles, /\.agent-detail-tabs button\.active \{[\s\S]*?background:\s*var\(--accent\)/);
  assert.equal(/background:\s*var\(--magclaw-sun\)/.test(styles), false);
  assert.match(railSource, /renderLeftRailButton\('chat'[\s\S]*chatUnreadCount \|\| inbox\.unreadCount \|\| ''/);
  assert.match(railSource, /renderLeftRailButton\('tasks', railMode, 'Tasks', [\s\S]*?\)\}/);
  assert.doesNotMatch(railSource, /renderLeftRailButton\('tasks'[\s\S]*openTasks \|\| ''/);
  assert.doesNotMatch(railSource, /renderLeftRailButton\('members'[\s\S]*normalAgents\.length \|\| ''/);
});

test('console surfaces show session summary LLM alerts without exposing internals', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const railSource = app.slice(app.indexOf('function renderRail()'), app.indexOf('function currentServerProfile()'));
  const consoleSource = app.slice(app.indexOf('function renderConsoleOverview()'), app.indexOf('function renderConsoleInvitations()'));

  assert.match(app, /function sessionSummaryLlmIssueNotifications\(\)/);
  assert.doesNotMatch(railSource, /renderLeftRailButton\('console'[\s\S]*sessionSummaryLlmIssueNotifications\(\)\.length \? '!' : ''/);
  assert.match(consoleSource, /会话总结的 LLM 异常/);
  assert.doesNotMatch(consoleSource, /detail|stack|error/i);
  assert.match(styles, /\.console-alert-card/);
  assert.match(styles, /\.console-alert-mark/);
});

test('agent create modal uses native selects for runtime, model, and reasoning choices', async () => {
  const app = await readAppSource();
  const agentModalSource = app.slice(
    app.indexOf('function renderAgentModal()'),
    app.indexOf('function renderAvatarPickerModal()'),
  );
  const selectSource = app.slice(
    app.indexOf('function renderAgentChoiceSelect'),
    app.indexOf('function runtimeOptionsForComputer'),
  );
  const changeSource = app.slice(
    app.indexOf("// Save agent form select state"),
    app.indexOf("if (event.target.name === 'asTask')"),
  );

  assert.match(selectSource, /<select name="\$\{escapeHtml\(name\)\}"/);
  assert.match(agentModalSource, /renderAgentChoiceSelect\(\{[\s\S]*name: 'runtime'/);
  assert.match(agentModalSource, /renderAgentChoiceSelect\(\{[\s\S]*name: 'model'/);
  assert.match(agentModalSource, /renderAgentChoiceSelect\(\{[\s\S]*name: 'reasoningEffort'/);
  assert.doesNotMatch(app, /renderAgentChoiceButtons/);
  assert.doesNotMatch(app, /agent-choice-grid|agent-choice-option|agent-choice-empty/);
  assert.doesNotMatch(agentModalSource, /renderAgentChoiceButtons/);
  assert.doesNotMatch(agentModalSource, /agent-choice-grid/);
  assert.match(changeSource, /if \(name === 'runtime'\)/);
  assert.match(changeSource, /selectedRuntimeId = runtime \? nextRuntimeId : ''/);
});

test('agent avatar uploads open a square crop modal and persist a cropped image', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();

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
  assert.match(app, /function avatarCropReturnModal\(crop\)/);
  assert.match(app, /if \(crop\?\.target === 'agent-create'\) return 'agent'/);
  assert.match(app, /return null/);
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

test('join avatar upload reuses the avatar crop confirmation flow', async () => {
  const app = await readAppSource();
  const cropSource = app.slice(
    app.indexOf('async function applyCroppedAvatar'),
    app.indexOf('function avatarCropReturnModal'),
  );

  assert.match(app, /input\?\.id === 'cloud-auth-avatar-file' \? 'cloud-auth' : ''/);
  assert.match(app, /const avatar = await readAvatarFileAsDataUrl\(file\)/);
  assert.match(app, /await openAvatarCropModal\(\{ \.\.\.context, source: avatar \}\)/);
  assert.match(cropSource, /crop\?\.target === 'cloud-auth'/);
  assert.match(cropSource, /cloudAuthAvatar = avatar/);
});

test('human presence uses browser heartbeat and settings clears agent detail', async () => {
  const app = await readAppSource();

  assert.match(app, /const HUMAN_PRESENCE_HEARTBEAT_MS = 30 \* 1000/);
  assert.match(app, /function sendHumanPresenceHeartbeat\(\)/);
  assert.match(app, /api\('\/api\/cloud\/auth\/heartbeat', \{ method: 'POST', body: '\{\}' \}\)/);
  assert.match(app, /function humanStatusDot\(authorId, authorType\)/);
  assert.match(app, /getAvatarHtml\(authorId, authorType, 'avatar-inner'\)\}\$\{humanStatusDot\(authorId, authorType\)\}/);
  assert.match(app, /if \(action === 'set-settings-tab'\)[\s\S]*selectedAgentId = null/);
});

test('create agent opens with a fresh form state every time', async () => {
  const app = await readAppSource();

  assert.match(app, /function resetAgentFormState\(\)/);
  assert.match(app, /name: ''/);
  assert.match(app, /placeholder="e\.g\. Kael"/);
  assert.match(app, /Connect a Computer before creating cloud Agents/);
  assert.match(app, /No connected Computer is available/);
  assert.match(app, /const connectedComputers = computerOptions\.filter/);
  assert.match(app, /status === 'connected' \|\| status === 'offline'/);
  assert.match(app, /<option value="\$\{c\.id\}" \$\{connected \? '' : 'disabled'\}/);
  assert.match(app, /if \(modal === 'agent'\) \{\s*resetAgentFormState\(\);\s*render\(\);\s*await loadInstalledRuntimes\(\);\s*if \(modal === 'agent'\) render\(\);\s*return;/);
  assert.match(app, /if \(form\.id === 'agent-form'\)[\s\S]*resetAgentFormState\(\);\s*modal = null/);
});

test('Fan-out API config is server-scoped in Server settings', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const railSource = app.slice(app.indexOf('function renderRail'), app.indexOf('function renderNavItem'));
  const submitSource = app.slice(app.indexOf("document.addEventListener('submit'"), app.indexOf('refreshState().then'));
  const serverSettingsSource = app.slice(app.indexOf('function renderServerSettingsTab()'), app.indexOf('function consoleInvitationRows()'));
  const fanoutSource = app.slice(app.indexOf('function renderFanoutApiConfigCard()'), app.indexOf('function settingsPageMeta'));

  assert.match(railSource, /const normalAgents = channelAssignableAgents\(\)/);
  assert.match(railSource, /renderAgentGroupsByComputer\(normalAgents\)/);
  assert.doesNotMatch(railSource, /System Config/);
  assert.doesNotMatch(app, /function renderSystemSettingsTab\(\)/);
  assert.doesNotMatch(app, /id: 'system'/);
  assert.match(app, /function renderComputersRail\(\)/);
  assert.doesNotMatch(app.slice(app.indexOf('function renderComputersRail'), app.indexOf('function renderSettingsRail')), /Fan-out API/);
  assert.doesNotMatch(railSource, /renderNavItem\('cloud', 'System'/);
  assert.match(app, /function renderFanoutApiConfigCard\(\)/);
  assert.match(serverSettingsSource, /renderFanoutApiConfigCard\(\)/);
  assert.match(fanoutSource, /cloudCan\('manage_system'\)/);
  assert.match(fanoutSource, /Only Owner and Admin members can modify this server configuration/);
  assert.match(fanoutSource, /Configure this server's supplemental LLM route/);
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

test('server join links use Slack-style rows and a revoke confirmation modal', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const serverSettingsSource = app.slice(app.indexOf('function renderServerSettingsTab()'), app.indexOf('function consoleInvitationRows()'));
  const modalSource = app.slice(app.indexOf('function renderModal()'), app.indexOf('function modalHeader'));
  const clickSource = app.slice(app.indexOf("if (action === 'copy-join-link'"), app.indexOf("if (action === 'open-account-settings'"));
  const confirmSource = app.slice(app.indexOf("if (action === 'confirm-revoke-join-link'"), app.indexOf("if (action === 'start-all-computer-agents'"));

  assert.match(app, /let joinLinkRevokeConfirmState = \{ joinLinkId: null \}/);
  assert.match(app, /function renderJoinLinkRevokeConfirmModal\(\)/);
  assert.match(modalSource, /'join-link-revoke-confirm': renderJoinLinkRevokeConfirmModal/);
  assert.match(serverSettingsSource, /class="pixel-panel cloud-card wide server-join-link-card"/);
  assert.match(serverSettingsSource, /server-join-link-form-grid/);
  assert.match(serverSettingsSource, /server-join-link-create-btn/);
  assert.match(serverSettingsSource, /server-join-link-divider/);
  assert.match(serverSettingsSource, /server-join-link-url-line/);
  assert.match(serverSettingsSource, /server-join-link-icon-btn copy/);
  assert.match(serverSettingsSource, /server-join-link-icon-btn revoke/);
  assert.match(serverSettingsSource, /joinLinkMetaText\(link\)/);
  assert.match(serverSettingsSource, /Expires In[\s\S]*name="expiresIn"/);
  assert.doesNotMatch(serverSettingsSource, /Expires At|Create a shareable link for people to join this server after signing in\./);
  assert.match(clickSource, /modal = 'join-link-revoke-confirm'/);
  assert.match(confirmSource, /\/api\/cloud\/join-links\/\$\{encodeURIComponent\(joinLinkId\)\}\/revoke/);
  assert.doesNotMatch(confirmSource, /window\.confirm/);
  assert.match(styles, /\.server-join-link-card/);
  assert.match(styles, /\.server-join-link-form-grid/);
  assert.match(styles, /\.server-join-link-icon-btn/);
  assert.match(styles, /\.modal-join-link-revoke-confirm/);
  assert.match(styles, /\.join-link-revoke-warning/);
});

test('LLM fan-out decisions render one concise route toast only when LLM is used', async () => {
  const app = await readAppSource();
  const fanoutToast = await readFile(new URL('../public/fanout-toast.js', import.meta.url), 'utf8');
  const styles = await readStylesSource();

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

test('browser agent notifications can be enabled from a MagClaw-style prompt and settings card', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();

  assert.match(app, /const NOTIFICATION_PREF_KEY = 'magclawNotificationPrefs'/);
  assert.match(app, /function renderNotificationPromptBanner\(\)/);
  assert.match(app, /function renderNotificationConfigCard\(\)/);
  assert.match(app, /Notification\.requestPermission\(\)/);
  assert.match(app, /function notificationServerLabel\(stateSnapshot = appState\)/);
  assert.match(app, /function notificationSurfaceLabel\(record, stateSnapshot = appState\)/);
  assert.match(app, /return `MagClaw - \$\{serverLabel\}`/);
  assert.match(app, /`\[\$\{surfaceLabel\}\] \$\{agentName\}: \$\{preview\}`/);
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

test('console has routed sections, invitation actions, and no human heartbeat', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();

  assert.match(app, /function consoleTabFromPath\(path = window\.location\.pathname \|\| ''\)/);
  assert.match(app, /path\.startsWith\('\/console\/invitations'\)/);
  assert.match(app, /path\.startsWith\('\/console\/servers'\)/);
  assert.match(app, /activeView === 'console'/);
  assert.match(app, /function renderConsole\(\)/);
  assert.match(app, /function renderConsoleInvitations\(\)/);
  assert.match(app, /data-action="set-console-tab"/);
  assert.match(app, /data-action="accept-console-invitation"/);
  assert.match(app, /\/api\/console\/invitations\/\$\{encodeURIComponent\(id\)\}\/\$\{verb\}/);
  assert.match(app, /activeView === 'console' \|\| \(window\.location\.pathname \|\| ''\)\.startsWith\('\/console'\)/);
  assert.match(app, /console-layout-frame/);
  assert.match(app, /console-rail/);
  const consoleSidebarStart = app.indexOf('const sidebarBody = railMode ===');
  const consoleSidebarSource = app.slice(consoleSidebarStart, app.indexOf('const railClass =', consoleSidebarStart));
  assert.match(consoleSidebarSource, /railMode === 'console'[\s\S]*renderConsoleRail\(\)/);
  const consoleRailStart = app.indexOf("if (activeView === 'console') {");
  const consoleRailSource = app.slice(consoleRailStart, app.indexOf('return `\n    <aside class="${railClass}">', consoleRailStart));
  const consoleServerSubmitStart = app.indexOf("if (form.id === 'console-server-form') {");
  const consoleServerSubmitSource = app.slice(consoleServerSubmitStart, app.indexOf("if (form.id === 'fanout-config-form')", consoleServerSubmitStart));
  assert.match(consoleRailSource, /magclaw-sidebar/);
  assert.doesNotMatch(consoleRailSource, /leftRailHtml|magclaw-left-rail|runtime-chip/);
  assert.match(app, /id="console-server-form"/);
  assert.match(app, /data-console-server-name/);
  assert.match(app, /data-console-server-slug/);
  assert.match(app, /data-auto-slug="1"/);
  assert.match(app, /minlength="5"/);
  assert.match(app, /Slug must be at least 5 characters/);
  assert.match(app, /function validateConsoleServerForm\(form, \{ report = true \} = \{\}\)/);
  assert.match(app, /function consoleServerSlugFromName\(value\)/);
  assert.match(app, /syncConsoleServerSlug\(consoleServerForm\)/);
  assert.match(app, /event\.target\.dataset\.autoSlug = '0'/);
  assert.match(app, /setConsoleServerFormError\(form, message\)/);
  assert.match(app, /This URL slug is already taken\./);
  assert.doesNotMatch(consoleServerSubmitSource, /appFlash\s*=/);
  assert.match(consoleServerSubmitSource, /window\.history\.replaceState\(\{\}, '', `\/s\/\$\{encodeURIComponent\(slug\)\}\/channels\/\$\{encodeURIComponent\(selectedSpaceId\)\}`\)/);
  assert.match(consoleServerSubmitSource, /await refreshStateOrAuthGate\(\);\s*skipFinalRefresh = true;\s*toast\(serverCreatedToastMessage\(serverName, slug\)\)/);
  assert.match(consoleServerSubmitSource, /toast\(serverCreatedToastMessage\(serverName, slug\)\)/);
  assert.match(app, /Server created/);
  assert.match(app, /setTimeout\(\(\) => node\.classList\.remove\('show'\), 3000\)/);
  assert.match(app, /data-modal="server-create"/);
  assert.match(app, /\/api\/console\/servers/);
  assert.match(app, /Choose a server to continue\. If you do not have one yet, create a new server\./);
  assert.match(app, /renderServerAvatar\(server, 'console-switch-server-avatar'\)/);
  assert.match(app, /console-switch-server-label/);
  assert.doesNotMatch(app, /console-create-server" type="button" disabled/);
  assert.match(styles, /\.toast \{[\s\S]*z-index: 120/);
  assert.match(styles, /\.toast \{[\s\S]*pointer-events: none/);
  assert.match(styles, /\.toast \{[\s\S]*border: 2px solid var\(--accent\)/);
  assert.match(styles, /\.toast \{[\s\S]*background: var\(--accent-soft\)/);
  assert.match(styles, /\.console-page/);
  assert.match(styles, /\.console-grid/);
  assert.match(styles, /\.console-row/);
  assert.match(styles, /\.console-switch-server-avatar/);
  assert.match(styles, /\.console-switch-server-label/);
  assert.match(styles, /\.modal-form \.form-error/);
});

test('cloud server shell uses MagClaw-style switcher and removes local-only chrome', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const railSource = app.slice(app.indexOf('function renderRail()'), app.indexOf('function renderChatRail'));
  const settingsNavSource = app.slice(app.indexOf('function settingsNavItems()'), app.indexOf('function settingsIcon('));
  const visibleLocalMarkers = [
    'MAGCLAW LOCAL',
    'Magclaw Local',
    'Codex Local',
    'Open Local Folder',
    'Local collaboration',
    'Local runtime profile',
    'Local team placeholder',
    'Local-only mode enabled',
    'Local state pushed',
    'Local MagClaw user',
    'Local runner history',
  ];

  assert.match(app, /let serverSwitcherOpen = false/);
  assert.match(app, /function currentServerProfile\(\)/);
  assert.match(app, /function displayServerSlug\(value, fallback = ''\)/);
  assert.match(app, /function renderServerSwitcherMenu\(\)/);
  assert.match(railSource, /data-action="toggle-server-switcher"/);
  assert.match(railSource, /renderServerSwitcherMenu\(\)/);
  assert.match(app, /data-action="switch-server"/);
  assert.match(app, /renderServerAvatar\(server, 'server-switcher-avatar'\)/);
  assert.match(app, /data-action="open-console-server-switcher"/);
  assert.match(app, /Switch or create server/);
  assert.match(app, /\.filter\(Boolean\)[\s\S]*normalizeInviteEmailValue\(item\.email/);
  for (const marker of visibleLocalMarkers) {
    assert.doesNotMatch(app, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(railSource, /runtime-chip/);
  assert.match(settingsNavSource, /id: 'members'/);
  assert.doesNotMatch(app, /Local Only[\s\S]*State, attachments, Codex runs/);
  assert.match(styles, /\.server-switcher-menu/);
  assert.match(styles, /\.server-switcher-avatar/);
  assert.match(styles, /\.server-switcher-row \{[\s\S]*grid-template-columns:\s*20px 34px minmax\(0, 1fr\)/);
  assert.match(styles, /\.console-switch-page/);
});

test('server settings, human detail, and computer detail mirror MagClaw structure', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const computerRailSource = app.slice(app.indexOf('function renderComputersRail()'), app.indexOf('function renderSettingsRail()'));
  const computerPageSource = app.slice(app.indexOf('function renderComputers()'), app.indexOf('function renderComputerConfigCard()'));

  assert.match(app, /function routeStateFromLocation/);
  assert.match(app, /human\\\/\(\[\^\/\]\+\)/);
  assert.match(app, /computer\\\/\(\[\^\/\]\+\)/);
  assert.match(app, /agent\\\/\(\[\^\/\]\+\)/);
  assert.match(app, /let selectedHumanId = /);
  assert.match(app, /let selectedComputerId = /);
  assert.match(app, /function renderServerSettingsTab\(\)/);
  assert.match(app, /id="server-profile-form"/);
  assert.match(app, /let serverProfileAvatarDraft = null/);
  assert.match(app, /workspaceSlug: currentServerSlug\(\)/);
  assert.match(app, /serverProfileAvatarDraft === null \? \(server\.avatar \|\| ''\) : serverProfileAvatarDraft/);
  assert.match(app, /serverProfileAvatarDraft = avatar/);
  assert.match(app, /serverProfileAvatarDraft = null/);
  assert.match(app, /function renderServerAdminsPanel/);
  assert.match(app, /Owners & Admins/);
  assert.match(app, /data-server-admin-promote-form/);
  assert.match(app, /data-action="promote-cloud-member-role"/);
  assert.match(app, /class="server-admin-role-form"/);
  assert.match(app, /data-member-role-context="server"/);
  assert.match(app, /Join Links/);
  assert.match(app, /Onboarding Behavior/);
  assert.match(app, /Disabled \(no automatic onboarding\)/);
  assert.match(app, /<select name="newAgentGreetingEnabled">/);
  assert.match(app, /<option value="true" \$\{server\.newAgentGreetingEnabled === false \? '' : 'selected'\}>Yes<\/option>/);
  assert.match(app, /<option value="false" \$\{server\.newAgentGreetingEnabled === false \? 'selected' : ''\}>No<\/option>/);
  assert.match(app, /Danger Zone/);
  assert.match(app, /<details class="pixel-panel cloud-card danger-card server-danger-accordion" open>/);
  assert.match(app, /function renderHumanDetail\(/);
  assert.match(app, /data-action="select-human"/);
  assert.match(app, /human-you-label/);
  assert.match(app, /data-action="randomize-human-avatar"/);
  assert.match(app, /data-action="pick-human-avatar"/);
  assert.match(app, /class="visually-hidden human-avatar-upload"/);
  assert.match(app, /function renderHumanDescriptionField\(/);
  const humanCanEditSource = app.slice(app.indexOf('function humanCanEditProfile'), app.indexOf('function renderHumanAvatarEditor'));
  assert.match(humanCanEditSource, /return humanIsCurrent\(human\)/);
  assert.doesNotMatch(humanCanEditSource, /manage_member_roles/);
  assert.match(app, /data-action="edit-human-description"/);
  assert.match(app, /class="agent-inline-edit human-description-edit"/);
  assert.match(app, /data-action="save-human-description"/);
  assert.match(app, /data-action="cancel-human-description"/);
  assert.match(app, /Created Agents/);
  assert.match(app, /Created Agents \(\$\{createdAgents\.length\}\)/);
  assert.match(app, /const nameWithYouLabel = `\$\{displayName\}\$\{youLabel\}`/);
  assert.doesNotMatch(app, /const nameWithBadge = `\$\{displayName\}\$\{humanBadgeHtml\(\)\}\$\{youLabel\}`/);
  assert.doesNotMatch(app, /<small>\$\{escapeHtml\(email \|\| 'Server member'\)\}<\/small>/);
  assert.match(app, /function renderHumanRoleManagement/);
  assert.match(app, /class="member-manage-role-form human-role-form"/);
  assert.match(app, /data-member-role-context="human"/);
  assert.match(app, /Cannot remove self/);
  assert.match(app, /function renderAgentGroupsByComputer\(/);
  assert.match(app, /function agentIsDisabled\(agent = \{\}\)/);
  assert.match(app, /agentIsActiveInWorkspace\(agent = \{\}\)[\s\S]*!agentIsDisabled\(agent\)/);
  assert.match(app, /function renderComputerDetail\(/);
  assert.match(app, /data-action="select-computer"/);
  assert.match(app, /Agents on this computer/);
  assert.match(app, /Agents on this computer \(\$\{agents\.length\}\)/);
  assert.match(app, /computer-agent-tooltip/);
  assert.match(app, /data-action="generate-computer-command"/);
  assert.match(app, /function pairingCommandCopyButtonHtml/);
  assert.match(app, /computer-detail-connect-options/);
  assert.match(app, /connect-options-frame/);
  assert.match(app, /computer setup/);
  assert.match(app, /Generate Connect Command/);
  assert.match(app, /pairingCommandCopyAcknowledgedKind/);
  assert.doesNotMatch(app, /<span>Connect Command<\/span><span>api key<\/span>/);
  assert.doesNotMatch(app, /Generate a fresh API-key command when you need to reconnect this computer\./);
  assert.doesNotMatch(app, /<span>Connect Command<\/span><span>short lived<\/span>/);
  assert.doesNotMatch(app, /Generate a fresh one-time command when you need to reconnect this computer\./);
  assert.match(app, /function renderDaemonVersionValue/);
  assert.match(app, /update available/);
  assert.match(app, /function sortComputersByAvailability/);
  assert.match(app, /Disable Computer/);
  assert.match(app, /Enable Computer/);
  assert.doesNotMatch(app, /Delete Computer/);
  assert.doesNotMatch(computerRailSource, /Feature Entrances/);
  assert.doesNotMatch(computerPageSource, /Feature Entrances/);
  assert.match(app, /runtimeOptionsForComputer/);
  assert.match(app, /computer\.connectedVia !== 'daemon'/);
  assert.match(app, /seen\.has\(id\)/);
  assert.match(styles, /\.human-detail-page/);
  assert.match(styles, /\.computer-detail-page/);
  assert.match(styles, /\.server-profile-avatar/);
  assert.match(styles, /\.server-admin-promote-form/);
  assert.match(styles, /\.server-admin-role-form/);
  assert.match(styles, /\.human-permissions-section/);
});

test('server profile saves patch settings and open thread surfaces without full render', async () => {
  const app = await readAppSource();
  const stateUpdateSource = app.slice(app.indexOf('function applyStateUpdate(nextState)'), app.indexOf('function applyRunEventUpdate'));
  const submitSource = app.slice(app.indexOf("if (form.id === 'server-profile-form')"), app.indexOf("if (form.id === 'server-onboarding-form')"));
  const renderSource = app.slice(app.indexOf('function render()'), app.indexOf('function renderRail()'));

  assert.match(app, /let pendingServerProfilePatchSignature = ''/);
  assert.match(app, /function serverProfilePatchSignature\(stateSnapshot = appState\)/);
  assert.match(app, /function serverSettingsSupportSignature\(stateSnapshot = appState\)/);
  assert.match(app, /function fanoutApiSettingsSignature\(stateSnapshot = appState\)/);
  assert.match(app, /function serverSettingsVisibleSignature\(stateSnapshot = appState\)/);
  assert.match(app, /function patchOpenThreadDrawerSurface\(scrollSnapshot\)/);
  assert.match(app, /function patchServerProfileSettingsSurface\(\)/);
  assert.match(app, /function pageScrollSnapshot\(\)/);
  assert.match(app, /function restorePageScroll\(snapshot\)/);
  assert.match(app, /data-page-scroll-surface data-scroll-key="settings:\$\{escapeHtml\(currentServerSlug\(\)\)\}:\$\{escapeHtml\(settingsTab\)\}"/);
  assert.match(renderSource, /page: pageScrollSnapshot\(\)/);
  assert.match(renderSource, /restorePageScroll\(scrollSnapshot\.page\)/);
  assert.match(stateUpdateSource, /const serverProfileBefore = serverProfilePatchSignature\(\)/);
  assert.match(stateUpdateSource, /const serverSettingsVisibleBefore = serverSettingsVisibleSignature\(\)/);
  assert.match(stateUpdateSource, /const serverSettingsUnchanged = activeView === 'cloud'[\s\S]*settingsTab === 'server'[\s\S]*serverSettingsVisibleBefore === serverSettingsVisibleAfter/);
  assert.match(stateUpdateSource, /if \(serverSettingsUnchanged\) \{[\s\S]*if \(railNeedsPatch\) patchRailSurface\(\);[\s\S]*patchServerProfileSettingsSurface\(\);[\s\S]*return;/);
  assert.match(stateUpdateSource, /const serverProfileOnlyChanged = activeView === 'cloud'[\s\S]*serverSettingsSupportBefore === serverSettingsSupportSignature\(\)/);
  assert.match(stateUpdateSource, /patchServerProfileSettingsSurface\(\);[\s\S]*patchOpenThreadDrawerSurface\(scrollSnapshot\);[\s\S]*return;/);
  assert.match(submitSource, /pendingServerProfilePatchSignature = serverProfilePatchSignature\(\)/);
  assert.match(submitSource, /skipFinalRefresh = true/);
});

test('agent workspace tab has split tree and raw/preview markdown controls', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const workspaceActionSource = app.slice(
    app.indexOf('async function loadAgentWorkspace'),
    app.indexOf('function clearAgentWorkspaceCaches'),
  );

  assert.match(app, /function displayHomePath\(value = ''\)/);
  assert.match(app, /function renderAgentDetailUpdate\(agentId\)/);
  assert.match(app, /function renderAgentWorkspaceUpdate\(agentId\)/);
  assert.match(app, /patchAgentDetailSurface\(\)/);
  assert.match(workspaceActionSource, /async function loadAgentWorkspace\(agentId, relPath = '', \{ renderLoading = true, renderAfter = true \} = \{\}\)/);
  assert.match(workspaceActionSource, /async function openAgentWorkspaceFile\(agentId, relPath = '', \{ renderLoading = true, renderAfter = true \} = \{\}\)/);
  assert.match(workspaceActionSource, /await Promise\.all\(\[/);
  assert.doesNotMatch(workspaceActionSource, /\n\s*render\(\);/);
  assert.match(app, /function renderAgentWorkspaceTab\(agent\)/);
  assert.match(app, /class="agent-workspace-tab"/);
  assert.match(app, /data-action="refresh-agent-workspace"/);
  assert.match(app, /data-action="set-agent-workspace-preview-mode" data-mode="raw"/);
  assert.match(app, /data-action="set-agent-workspace-preview-mode" data-mode="preview"/);
  assert.match(app, /agentWorkspacePreviewMode === 'preview'/);
  assert.match(app, /renderMarkdown\(file\.content \|\| ''\)/);
  assert.match(app, /const displayAbsolutePath = displayHomePath\(file\?\.absolutePath \|\| ''\)/);
  assert.match(app, /const displayWorkspacePath = displayHomePath\(workspacePath\)/);
  assert.doesNotMatch(app, /escapeHtml\(file\.absolutePath\)} \/ \$\{bytes\(file\.bytes\)\}/);
  assert.match(app, /function agentWorkspaceSourceBadge/);
  assert.match(app, /Computer local/);
  assert.match(app, /Cloud mirror/);
  assert.match(app, /Mirror stale/);
  assert.match(app, /class="agent-workspace-source-badge/);
  assert.match(styles, /\.agent-workspace-layout/);
  assert.match(styles, /\.agent-workspace-source-badge/);
  assert.match(styles, /\.agent-workspace-sidebar/);
  assert.match(styles, /\.agent-workspace-viewer/);
});

test('agent activity tab renders newest first with second-level timestamps and a 5000 item cap', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const profileSource = app.slice(app.indexOf('function renderAgentProfileTab'), app.indexOf('function renderAgentDmsTab'));
  const agentListSource = app.slice(app.indexOf('function renderAgentListItem'), app.indexOf('function renderAgentGroupsByComputer'));
  const liveActivitySource = app.slice(app.indexOf('function agentLiveActivitySummary'), app.indexOf('function renderAgentLiveActivityBar'));

  assert.match(app, /const AGENT_ACTIVITY_EVENT_LIMIT = 5000/);
  assert.match(app, /function agentActivityEvents\(agent\)/);
  assert.match(app, /\.sort\(\(a, b\) => new Date\(b\.createdAt\) - new Date\(a\.createdAt\)\)/);
  assert.match(app, /\.slice\(0, AGENT_ACTIVITY_EVENT_LIMIT\)/);
  assert.match(app, /fmtTime\(event\.createdAt\)/);
  assert.match(app, /function agentLiveActivitySummary\(agent\)/);
  assert.match(app, /agent\?\.runtimeActivity && typeof agent\.runtimeActivity === 'object'/);
  assert.match(app, /function agentActivityIsUserVisible\(event\)/);
  assert.match(app, /rawType === 'daemon_result'/);
  assert.match(app, /resultType === 'agent:skills:list_result'/);
  assert.match(app, /agentActivityEvents\(agent\)\.find\(agentActivityIsUserVisible\)/);
  assert.match(liveActivitySource, /latestEvent\?\.raw\?\.activity\?\.detail/);
  assert.match(app, /function renderAgentLiveActivityBar\(agent, \{ compact = false \} = \{\}\)/);
  assert.match(app, /data-action="set-agent-detail-tab" data-tab="activity"/);
  assert.match(profileSource, /renderAgentLiveActivityBar\(agent\)/);
  assert.match(agentListSource, /renderAgentLiveActivityBar\(agent, \{ compact: true \}\)/);
  assert.match(app, /function renderAgentActivityTab\(agent\)/);
  assert.match(styles, /\.agent-activity-list/);
  assert.match(styles, /\.agent-activity-dot/);
  assert.match(styles, /\.agent-live-activity-bar/);
  assert.match(styles, /\.agent-live-activity-bar\.compact/);
});

test('mobile shell renders root tabs, detail pages, and safe-area navigation', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

  assert.match(html, /viewport-fit=cover/);
  assert.match(app, /const MOBILE_VIEWPORT_QUERY = '\(max-width: 767px\)'/);
  assert.match(app, /function isMobileViewport\(\)/);
  assert.match(app, /function renderMobileShell\(\)/);
  assert.match(app, /function renderMobileBottomNav\(\)/);
  assert.match(app, /function renderMobileHome\(\)/);
  assert.match(app, /function renderMobileSettingsHome\(\)/);
  assert.match(app, /function renderMobileComputersSettingsRow\(\)/);
  const mobileSettingsSource = app.slice(app.indexOf('function renderMobileSettingsHome()'), app.indexOf('function renderMobileComputersList()'));
  assert.match(mobileSettingsSource, /mobileSettingsItemsInPreferredOrder\(settingsNavItems\(\)\)/);
  assert.match(mobileSettingsSource, /renderMobileComputersSettingsRow\(\)/);
  assert.match(app, /data-action="set-left-nav" data-nav="desktop"/);
  assert.match(mobileSettingsSource, /data-action="set-left-nav" data-nav="console"/);
  assert.match(app, /console: '<rect x="4" y="4" width="16" height="16" rx="1"/);
  assert.doesNotMatch(mobileSettingsSource, /Language & Region/);
  assert.match(app, /function renderMobileMembersHome\(\)/);
  assert.match(app, /function renderMobileTaskSurface\(/);
  assert.match(app, /function renderMobileFilesPanel\(/);
  assert.match(app, /function renderMobileAgentDetail\(/);
  assert.match(app, /function renderMobileComputerDetail\(/);
  assert.match(app, /function renderMobileTopbar/);
  assert.match(app, /function mobileDetailActive\(\)/);
  assert.match(app, /renderMobileShell\(\)/);
  assert.match(app, /\['files', 'Files', 'file'\]/);
  assert.match(app, /mobile-space-tabs/);
  assert.match(app, /mobile-task-toolbar/);
  assert.match(app, /renderMobileQuickAction\('inbox', 'Activities', 'inbox', inbox\.unreadCount \|\| ''\)/);
  assert.match(app, /renderMobileQuickAction\('threads', 'Threads', 'message', inbox\.threadItems\.length \|\| ''\)/);
  assert.match(app, /data-action="mobile-nav"/);
  assert.match(app, /data-action="mobile-back"/);
  assert.match(app, /settingsTab === 'root'/);
  assert.match(app, /mobileHomeOpen/);
  assert.match(styles, /\.mobile-app-shell/);
  assert.match(styles, /\.mobile-bottom-nav/);
  assert.match(styles, /--mobile-nav-height:\s*62px/);
  assert.match(styles, /--mobile-border-width:\s*1\.5px/);
  assert.match(styles, /--mobile-font:\s*-apple-system/);
  assert.match(styles, /\.mobile-app-shell \{[\s\S]*?font-size:\s*13px/);
  assert.match(styles, /\.mobile-app-shell \{[\s\S]*?font-family:\s*var\(--mobile-font\)/);
  assert.match(styles, /\.mobile-app-shell \.dm-name \{[\s\S]*?font-size:\s*13px/);
  assert.match(styles, /\.mobile-app-shell \.task-view-toggle button \{[\s\S]*?font-size:\s*11px/);
  assert.match(styles, /\.mobile-home-header/);
  assert.match(styles, /\.mobile-root \{[\s\S]*?background:\s*var\(--mobile-surface\)/);
  assert.match(styles, /\.mobile-home-header \{[\s\S]*?background:\s*var\(--mobile-surface\)[\s\S]*?color:\s*var\(--text-primary\)/);
  assert.match(styles, /\.mobile-members-root,\s*[\r\n]+\.mobile-settings-root \{[\s\S]*?background:\s*var\(--mobile-surface\)/);
  assert.match(styles, /\.mobile-members-root \.mobile-root-header,\s*[\r\n]+\.mobile-settings-root \.mobile-root-header \{[\s\S]*?background:\s*var\(--mobile-surface\)[\s\S]*?color:\s*var\(--text-primary\)/);
  assert.match(styles, /\.mobile-space-tabs/);
  assert.match(styles, /\.mobile-task-surface/);
  assert.match(styles, /\.mobile-agent-detail \.agent-runtime-config-form/);
  assert.match(styles, /\.mobile-settings-row em/);
  assert.match(styles, /--mobile-rail:\s*var\(--magclaw-rail/);
  assert.match(styles, /--mobile-active:\s*var\(--accent-soft/);
  assert.match(styles, /--mobile-control-active:\s*var\(--accent/);
  assert.doesNotMatch(styles, /--mobile-home-surface/);
  assert.doesNotMatch(styles, /--mobile-[^;]+var\(--magclaw-rail-badge/);
  assert.match(styles, /env\(safe-area-inset-bottom\)/);
  assert.match(styles, /--vv-height/);
  assert.match(styles, /@media \(max-width: 767px\)/);
  assert.match(styles, /@media \(min-width: 768px\) and \(max-width: 1099px\)/);
});
