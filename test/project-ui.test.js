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

test('project remove buttons render as icons instead of rem text', async () => {
  const app = await readAppSource();

  assert.equal(/data-action="remove-project"[\s\S]*?>rem<\/button>/.test(app), false);
  assert.match(app, /class="project-remove-icon"/);
});

test('members settings expose role-aware invitation controls', async () => {
  const app = await readAppSource();
  const accountSettingsSource = app.slice(app.indexOf('function renderAccountSettingsTab()'), app.indexOf('function normalizeInviteEmailValue(value)'));
  const membersSettingsSource = app.slice(app.indexOf('function normalizeInviteEmailValue(value)'), app.indexOf('function renderCloudAuthGate('));
  const railSource = app.slice(app.indexOf('function settingsNavItems()'), app.indexOf('function settingsIcon('));

  assert.match(app, /function cloudRoleAllows\(role, allowedRole\)/);
  assert.match(app, /function cloudCan\(capability\)/);
  assert.doesNotMatch(railSource, /System Config/);
  assert.match(railSource, /Server[\s\S]*Release Notes/);
  assert.doesNotMatch(railSource, /id: 'members'/);
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
  assert.match(manageRoleOptionsSource, /options\.push\(\['member', 'Member'\]\)[\s\S]*options\.push\(\['admin', 'Admin'\]\)/);
  assert.match(manageRoleOptionsSource, /manage_member_roles/);
  assert.match(app, /let latestInvitationLink = null/);
  assert.match(app, /let cloudGeneratedLinks = \[\]/);
  assert.match(app, /function generatedLinkText\(item\)/);
  assert.match(app, /async function tryCopyTextToClipboard\(text\)[\s\S]*catch/);
  assert.match(app, /tryCopyTextToClipboard\(generatedLinksText\(\)\)/);
  assert.match(app, /'admin', 'Admin'/);
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
  const modalSource = app.slice(app.indexOf('function pairingCommandIsUsable'), app.indexOf('function renderHumanModal()'));
  const clickSource = app.slice(app.indexOf('async function generateFreshComputerPairingCommand'), app.indexOf("if (action === 'agent-stop-unavailable')"));
  const closeModalSource = app.slice(app.indexOf("if (action === 'close-modal')"), app.indexOf("if (localOnlyActions.has(action))"));
  const pairingActionsSource = app.slice(app.indexOf("if (action === 'create-computer-pairing')"), app.indexOf("if (action === 'copy-join-link')"));
  const stateUpdateSource = app.slice(app.indexOf('function applyStateUpdate(nextState)'), app.indexOf('function applyRunEventUpdate'));

  assert.match(app, /async function generateFreshComputerPairingCommand\(body = \{\}\)/);
  assert.match(app, /appState = await api\('\/api\/state'\)/);
  assert.match(clickSource, /await generateFreshComputerPairingCommand\(\{ name: appState\.runtime\?\.host \|\| 'Computer' \}\)/);
  assert.match(pairingActionsSource, /await generateFreshComputerPairingCommand\(body\)/);
  assert.match(modalSource, /function pairingCommandIsUsable/);
  assert.match(modalSource, /function pairingCommandText/);
  assert.match(modalSource, /id="computer-display-name-input"/);
  assert.match(modalSource, /--display-name/);
  assert.match(modalSource, /token\.consumedAt \|\| token\.revokedAt/);
  assert.match(modalSource, /expiresAtMs <= Date\.now\(\)/);
  assert.match(modalSource, /const stale = Boolean\(command && !pairingCommandIsUsable\(latestPairingCommand\)\)/);
  assert.match(modalSource, /presenceClass\(connected \? 'connected' : stale \? 'offline' : 'queued'\)/);
  assert.doesNotMatch(modalSource, /pendingComputerId && !liveComputer/);
  assert.match(clickSource, /latestPairingCommand\.provisional = !body\.computerId/);
  assert.match(clickSource, /computerPairingDisplayName = ''/);
  assert.match(app, /'computer-display-name'/);
  assert.match(closeModalSource, /shouldDiscardPairingComputer/);
  assert.match(closeModalSource, /await refreshState\(\)/);
  assert.match(app, /function computerPairingModalRenderSignature/);
  assert.match(stateUpdateSource, /computerModalBefore !== computerPairingModalRenderSignature\(appState\)/);
  assert.doesNotMatch(stateUpdateSource, /if \(modal === 'computer'\) render\(\);/);
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
  assert.match(app, /data-action="members-page-prev"/);
  assert.match(app, /data-action="members-page-next"/);
  assert.match(app, /data-action="members-page-go"/);
  assert.match(app, /id="members-page-input"/);
  assert.doesNotMatch(membersSettingsSource, /members-workspace-card|members-workspace-avatar/);
  assert.match(modalSource, /'member-invite': renderMemberInviteModal/);
  assert.match(modalSource, /'member-invite-links': renderMemberInviteLinksModal/);
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
  assert.match(manageSource, /data-member-role-select/);
  assert.match(manageSource, /data-action="update-cloud-member-role"/);
  assert.match(manageSource, /data-action="open-member-action-confirm"[\s\S]*data-member-action="reset-password"/);
  assert.match(manageSource, /data-action="open-member-action-confirm"[\s\S]*data-member-action="remove"/);
  assert.doesNotMatch(manageSource, /reset-cloud-member-password|remove-cloud-member/);
  assert.match(app, /if \(action === 'update-cloud-member-role'\)/);
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
        origin: 'https://cloud.magclaw.example',
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context);

  assert.equal(
    context.inviteLinkForCurrentOrigin('http://127.0.0.1:6543/activate?email=a%40example.com&token=mc_inv_123'),
    'https://cloud.magclaw.example/activate?email=a%40example.com&token=mc_inv_123',
  );
  assert.equal(
    context.inviteLinkForCurrentOrigin('http://localhost:6543/activate?email=a%40example.com&token=mc_inv_123'),
    'https://cloud.magclaw.example/activate?email=a%40example.com&token=mc_inv_123',
  );
  assert.equal(
    context.inviteLinkForCurrentOrigin('https://public.magclaw.example/activate?email=a%40example.com&token=mc_inv_123'),
    'https://public.magclaw.example/activate?email=a%40example.com&token=mc_inv_123',
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
});

test('cloud auth gate uses token context for invite and reset forms', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const authGateSource = app.slice(app.indexOf('function renderCloudAuthGate('), app.indexOf('function renderBrowserSettingsTab()'));
  const openRegisterSource = authGateSource.slice(authGateSource.indexOf('id="cloud-open-register-form"'), authGateSource.indexOf('id="cloud-forgot-form"'));
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
  assert.match(authGateSource, /Where humans and AI agents collaborate/);
  assert.match(authGateSource, /cloud-login-error/);
  assert.match(authGateSource, /role="alert" aria-live="polite"/);
  assert.match(authGateSource, /value="\$\{escapeHtml\(cloudLoginDraftEmail\)\}"/);
  assert.match(app, /Email or password is incorrect/);
  assert.match(app, /showCloudAuthGate\(error, \{ interactive: true \}\)/);
  assert.match(app, /const BRAND_LOGO_SRC = '\/brand\/magclaw-logo\.png'/);
  assert.match(authGateSource, /<img src="\$\{BRAND_LOGO_SRC\}" alt="" \/>/);
  assert.match(authGateSource, /class="cloud-auth-shell"/);
  assert.match(authGateSource, /class="pixel-panel cloud-login-card"/);
  assert.match(authGateSource, /id="cloud-login-title">Sign in/);
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

test('browser favicon and shared brand assets use the selected Modular Claw logo', async () => {
  const index = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
  const app = await readAppSource();

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

test('login legal links have built-in terms and privacy pages', async () => {
  const terms = await readFile(new URL('../public/terms/index.html', import.meta.url), 'utf8');
  const privacy = await readFile(new URL('../public/privacy/index.html', import.meta.url), 'utf8');

  assert.match(terms, /MagClaw 使用条款/);
  assert.match(terms, /© 2026 MagClaw\. 版权所有。/);
  assert.match(privacy, /MagClaw 隐私政策/);
  assert.match(privacy, /密码绝不会以明文存储/);
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

test('project picker keeps only the native folder action and polished chip icons', async () => {
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

test('project chip paths stay readable with horizontal scrolling', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();

  assert.match(app, /class="project-chip-path"/);
  assert.match(styles, /\.project-chip-path \{/);
  assert.match(styles, /overflow-x: auto/);
  assert.match(styles, /text-overflow: clip/);
});

test('project mentions show full local paths in the candidate list', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();

  assert.match(app, /absolutePath: item\.absolutePath/);
  assert.match(app, /item\.absolutePath \|\| item\.path/);
  assert.match(app, /class="mention-handle" title="\$\{escapeHtml\(handle\)\}"/);
  assert.match(styles, /grid-template-columns: 28px 8px minmax\(120px, 0\.55fr\) minmax\(260px, 1\.45fr\)/);
  assert.match(styles, /\.mention-type-file \.mention-handle,\n\.mention-type-folder \.mention-handle/);
  assert.match(styles, /overflow-wrap: anywhere/);
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

test('chat rail keeps Threads and adds Inbox without a System notification tab', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
  const chatRailSource = app.slice(app.indexOf('function renderChatRail('), app.indexOf('function renderMembersRail('));

  assert.match(chatRailSource, /renderNavItem\('inbox', 'Inbox', 'inbox', inboxUnread \|\| '', \{ badgeKind: 'unread' \}\)/);
  assert.match(chatRailSource, /renderNavItem\('threads', 'Threads', 'message'/);
  assert.match(chatRailSource, /renderChannelItem\(channel, unreadCountForSpace\(spaceUnreadCounts, 'channel', channel\.id\)\)/);
  assert.match(chatRailSource, /const dmPeers = dms/);
  assert.match(chatRailSource, /\.map\(\(dm\) => dmPeerInfo\(dm\)\)/);
  assert.match(chatRailSource, /\.filter\(\(item\) => item\?\.dm\?\.id && item\?\.peer\)/);
  assert.match(chatRailSource, /renderDmItem\(dm\.id, peer\.name \|\| displayName\(peer\.id\), peer\.status \|\| 'offline', peer\.avatar \|\| '', unreadCountForSpace\(spaceUnreadCounts, 'dm', dm\.id\)\)/);
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
  const app = await readAppSource();
  const styles = await readStylesSource();
  const renderSource = app.slice(app.indexOf('function render()'), app.indexOf('function renderRail()'));
  const drawerSource = app.slice(app.indexOf('function renderWorkspaceActivityDrawer()'), app.indexOf('function renderThreadDrawer(message)'));

  assert.match(app, /function renderInbox\(\)/);
  assert.match(app, /function buildInboxModel\(\)/);
  assert.match(app, /function renderWorkspaceActivityDrawer\(\)/);
  assert.match(app, /function workspaceActivityScrollSnapshot\(\)/);
  assert.match(app, /function restoreWorkspaceActivityScroll\(snapshot\)/);
  assert.match(app, /unreadCount: 0,[\s\S]*title: 'Workspace Activity'/);
  assert.match(app, /const allItems = \[workspaceItem, \.\.\.normalItems\]/);
  assert.match(app, /activeCount: normalItems\.length/);
  assert.match(app, /renderInboxCategoryButton\('workspace', 'Workspace Activity', null\)/);
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
  assert.match(app, /renderMarkdownWithMentions\(message\.body \|\| '\(attachment\)'\)/);
  assert.match(app, /renderMarkdownWithMentions\(reply\.body \|\| '\(attachment\)'\)/);
  const styles = await readStylesSource();
  assert.match(styles, /\.message-table/);
  assert.match(styles, /\.message-table-wrap/);
});

test('human mention chips use a distinct color from agent mentions', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();

  assert.match(app, /mention-identity mention-agent/);
  assert.match(app, /mention-human/);
  assert.match(styles, /\.mention-tag\.mention-human/);
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
  const app = await readAppSource();
  const styles = await readStylesSource();

  assert.match(app, /let collapsedTaskColumns = readCollapsedTaskColumns\(\)/);
  assert.match(app, /const DEFAULT_COLLAPSED_TASK_COLUMNS = \{ done: true \}/);
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
  assert.match(app, /<strong>\$\{replies\.length\} \$\{replyWord\}<\/strong>/);
  assert.match(app, /replies\.length \? `[\s\S]*<div class="reply-list">/);
});

test('channel navigation hides the inspector until an agent, task, or thread is selected', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();

  assert.match(app, /const inspectorHtml = renderInspector\(\)/);
  assert.match(app, /inspectorHtml \? `[\s\S]*collab-inspector/);
  assert.match(app, /class="app-frame collab-frame\$\{inspectorHtml \? '' : ' no-inspector'\}\$\{taskFocusLayout \? ' task-focus' : ''\}[\s\S]*\$\{notificationBanner \? ' notification-banner-active' : ''\}"/);
  assert.match(app, /let selectedTaskId = null/);
  assert.match(app, /function renderInspector\(\)[\s\S]*if \(selectedAgentId\)/);
  assert.match(app, /selectedAgentId = null;[\s\S]*selectedSpaceType = target\.dataset\.type/);
  assert.match(styles, /\.app-frame\.no-inspector/);
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
  const inspectorSource = app.slice(app.indexOf('function renderInspector()'), app.indexOf('function renderProjectFilePreview()'));
  const clickSource = app.slice(app.indexOf("if (action === 'select-human-inspector')"), app.indexOf("if (action === 'select-human')"));
  const subtitleSource = app.slice(app.indexOf('function actorSubtitle'), app.indexOf('function renderMentionChips'));

  assert.match(avatarSource, /data-action="select-human-inspector"/);
  assert.match(clickSource, /if \(activeView !== 'space'\)/);
  assert.match(clickSource, /if \(activeView === 'members'\) syncBrowserRouteForActiveView\(\)/);
  assert.match(inspectorSource, /if \(selectedHumanId\)/);
  assert.match(subtitleSource, /humanByIdAny/);
  assert.match(subtitleSource, /cloudMemberForHuman/);
  assert.match(subtitleSource, /cloudMemberDisplayRole/);
  assert.doesNotMatch(subtitleSource, /channelOwnerId[\s\S]*admin/);
  assert.match(styles, /\.avatar\.human-avatar-cell/);
  assert.match(styles, /\.human-identity-button/);
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
  const styles = await readStylesSource();

  assert.match(app, /function agentCanJoinNewChannel\(agent\)/);
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
  assert.match(styles, /\.member-btn \.dm-avatar-wrap \.avatar-status-dot/);
  assert.match(styles, /\.message-card \.avatar-status-dot/);
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
  assert.match(app, /if \(value === 'warming'\) return 'Warming'/);
  assert.match(agentListSource, /const status = agentDisplayStatus\(agent\)/);
  assert.match(profileSource, /presenceClass\(agentDisplayStatus\(agent\)\)/);
  assert.match(styles, /\.avatar-status-dot\.status-warming \{[\s\S]*background: var\(--magclaw-pink\)/);
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

test('codex agent startup repairs stale configured Codex paths before spawning', async () => {
  const source = await readFile(new URL('../server/agent-runtime/process-start.js', import.meta.url), 'utf8');

  assert.match(source, /async function resolveCodexSpawnCommand\(agent\)/);
  assert.match(source, /process\.env\.CODEX_PATH/);
  assert.match(source, /state\.settings\.codexPath = command/);
  assert.match(source, /codex_path_repaired/);
  assert.match(source, /const codexCommand = await resolveCodexSpawnCommand\(agent\)/);
  assert.match(source, /spawn\(codexCommand, args/);
});

test('message rows re-render when author presence changes from heartbeat', async () => {
  const app = await readAppSource();
  const renderKeySource = app.slice(app.indexOf('function renderRecordKey'), app.indexOf('function renderSystemEvent'));

  assert.match(renderKeySource, /authorStatus: author\?\.status \|\| ''/);
  assert.match(renderKeySource, /record\?\.authorType === 'agent'/);
  assert.match(app, /function applyPresenceHeartbeat\(heartbeat\)/);
  assert.match(app, /const incomingHumansById = new Map/);
  assert.match(app, /humans,\n    updatedAt: heartbeat\.updatedAt/);
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

test('agent identities are clickable and expose MagClaw-style hover summaries', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();
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
  assert.match(app, /renderAgentInlineField\(agent, 'name'/);
  assert.match(app, /renderAgentInlineField\(agent, 'description'/);
  assert.match(app, /function editPencilIcon\(\)/);
  assert.match(app, /class="agent-edit-icon"/);
  assert.match(app, /data-action="edit-agent-field" data-field="\$\{escapeHtml\(field\)\}"/);
  assert.match(app, /data-action="save-agent-field" data-field="\$\{escapeHtml\(field\)\}"/);
  assert.equal(app.includes('>Edit</button>'), false);
  assert.match(app, /maxlength="3000"[\s\S]*\$\{descriptionValue\.length\}\/3000/);
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
  assert.match(app, /MAGCLAW_WEB_PACKAGE_VERSION = '0\.2\.0'/);
  assert.match(app, /function renderReleaseVersionCard\(release\)/);
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
  const styles = await readStylesSource();

  assert.match(styles, /--magclaw-rail:\s*var\(--accent\)/);
  assert.match(styles, /--magclaw-rail-badge:\s*#FFE15A/);
  assert.match(styles, /\.rail > \.magclaw-left-rail \{[\s\S]*?background:\s*var\(--magclaw-rail\)/);
  assert.match(styles, /\.left-rail-avatar \{[\s\S]*?color:\s*var\(--magclaw-rail\)/);
  assert.match(styles, /\.left-rail-btn em \{[\s\S]*?background:\s*var\(--magclaw-rail-badge\)[\s\S]*?color:\s*var\(--magclaw-rail-badge-text\)/);
  assert.match(styles, /\.agent-detail-tabs button\.active \{[\s\S]*?background:\s*var\(--accent\)/);
  assert.equal(/background:\s*var\(--magclaw-sun\)/.test(styles), false);
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
  assert.match(consoleRailSource, /magclaw-sidebar/);
  assert.doesNotMatch(consoleRailSource, /leftRailHtml|magclaw-left-rail|runtime-chip/);
  assert.match(app, /id="console-server-form"/);
  assert.match(app, /data-console-server-name/);
  assert.match(app, /data-console-server-slug/);
  assert.match(app, /data-auto-slug="1"/);
  assert.match(app, /minlength="5"/);
  assert.match(app, /Slug must be at least 5 characters/);
  assert.match(app, /function validateConsoleServerForm\(form\)/);
  assert.match(app, /function consoleServerSlugFromName\(value\)/);
  assert.match(app, /syncConsoleServerSlug\(consoleServerForm\)/);
  assert.match(app, /event\.target\.dataset\.autoSlug = '0'/);
  assert.match(app, /setConsoleServerFormError\(form, message\)/);
  assert.match(app, /This URL slug is already taken\./);
  assert.match(app, /let appFlash = null/);
  assert.match(app, /function renderAppFlashBanner\(\)/);
  assert.match(app, /Server created/);
  assert.match(app, /data-modal="server-create"/);
  assert.match(app, /\/api\/console\/servers/);
  assert.match(app, /Choose a server to continue\. If you do not have one yet, create a new server\./);
  assert.doesNotMatch(app, /console-create-server" type="button" disabled/);
  assert.match(styles, /\.app-flash/);
  assert.match(styles, /\.console-page/);
  assert.match(styles, /\.console-grid/);
  assert.match(styles, /\.console-row/);
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
  assert.match(app, /data-action="open-console-server-switcher"/);
  assert.match(app, /Switch or create server/);
  assert.match(app, /\.filter\(Boolean\)[\s\S]*normalizeInviteEmailValue\(item\.email/);
  for (const marker of visibleLocalMarkers) {
    assert.doesNotMatch(app, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(railSource, /runtime-chip/);
  assert.doesNotMatch(settingsNavSource, /id: 'members'/);
  assert.doesNotMatch(app, /Local Only[\s\S]*State, attachments, Codex runs/);
  assert.match(styles, /\.server-switcher-menu/);
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
  assert.match(app, /Join Links/);
  assert.match(app, /Onboarding Behavior/);
  assert.match(app, /Danger Zone/);
  assert.match(app, /function renderHumanDetail\(/);
  assert.match(app, /data-action="select-human"/);
  assert.match(app, /human-you-label/);
  assert.match(app, /data-action="randomize-human-avatar"/);
  assert.match(app, /data-action="pick-human-avatar"/);
  assert.match(app, /class="visually-hidden human-avatar-upload"/);
  assert.match(app, /function renderHumanDescriptionField\(/);
  assert.match(app, /data-action="edit-human-description"/);
  assert.match(app, /class="agent-inline-edit human-description-edit"/);
  assert.match(app, /data-action="save-human-description"/);
  assert.match(app, /data-action="cancel-human-description"/);
  assert.match(app, /Created Agents/);
  assert.match(app, /Created Agents \(\$\{createdAgents\.length\}\)/);
  assert.match(app, /const nameWithYouLabel = `\$\{displayName\}\$\{youLabel\}`/);
  assert.doesNotMatch(app, /const nameWithBadge = `\$\{displayName\}\$\{humanBadgeHtml\(\)\}\$\{youLabel\}`/);
  assert.doesNotMatch(app, /<small>\$\{escapeHtml\(email \|\| 'Server member'\)\}<\/small>/);
  assert.doesNotMatch(app, /human-role-/);
  assert.match(app, /function renderAgentGroupsByComputer\(/);
  assert.match(app, /function agentIsDisabled\(agent = \{\}\)/);
  assert.match(app, /agentIsActiveInWorkspace\(agent = \{\}\)[\s\S]*!agentIsDisabled\(agent\)/);
  assert.match(app, /function renderComputerDetail\(/);
  assert.match(app, /data-action="select-computer"/);
  assert.match(app, /Agents on this computer/);
  assert.match(app, /Agents on this computer \(\$\{agents\.length\}\)/);
  assert.match(app, /computer-agent-tooltip/);
  assert.match(app, /data-action="regenerate-computer-command"/);
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
});

test('agent workspace tab has split tree and raw/preview markdown controls', async () => {
  const app = await readAppSource();
  const styles = await readStylesSource();

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
  const app = await readAppSource();
  const styles = await readStylesSource();

  assert.match(app, /const AGENT_ACTIVITY_EVENT_LIMIT = 5000/);
  assert.match(app, /function agentActivityEvents\(agent\)/);
  assert.match(app, /\.sort\(\(a, b\) => new Date\(b\.createdAt\) - new Date\(a\.createdAt\)\)/);
  assert.match(app, /\.slice\(0, AGENT_ACTIVITY_EVENT_LIMIT\)/);
  assert.match(app, /fmtTime\(event\.createdAt\)/);
  assert.match(app, /function renderAgentActivityTab\(agent\)/);
  assert.match(styles, /\.agent-activity-list/);
  assert.match(styles, /\.agent-activity-dot/);
});
