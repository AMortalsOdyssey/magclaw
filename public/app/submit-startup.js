async function tryCopyTextToClipboard(text) {
  const value = String(text || '');
  if (!value) return false;
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall through to the textarea copy path for browsers that block Clipboard API writes.
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, value.length);
  try {
    return Boolean(document.execCommand?.('copy'));
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

function assertCloudPasswordPolicy(password) {
  const value = String(password || '');
  if (value.length < 8 || value.length > 30 || !/[A-Za-z]/.test(value) || !/\d/.test(value)) {
    throw new Error('Password must be 8-30 characters and include letters and numbers.');
  }
  return value;
}

function validateCloudLoginForm(form, data) {
  const email = String(data.get('email') || '').trim();
  const password = String(data.get('password') || '');
  if (!email) throw new Error('Email is required.');
  if (!password) throw new Error('Password is required.');
  return { email, password };
}

function serverCreatedToastMessage(serverName, slug) {
  const name = String(serverName || 'Server').trim() || 'Server';
  const cleanSlug = String(slug || '').trim();
  return cleanSlug ? `Server created: ${name} /${cleanSlug}` : `Server created: ${name}`;
}

function sortConversationRecords(records = []) {
  return [...records].sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
}

function upsertConversationRecord(records = [], record = null) {
  if (!record?.id) return records || [];
  const next = [...(records || [])];
  const index = next.findIndex((item) => item?.id === record.id);
  if (index >= 0) {
    next[index] = { ...next[index], ...record };
    return sortConversationRecords(next);
  }
  next.push(record);
  return sortConversationRecords(next);
}

function upsertStateRecord(records = [], record = null) {
  if (!record?.id) return records || [];
  const next = [...(records || [])];
  const index = next.findIndex((item) => item?.id === record.id);
  if (index >= 0) {
    next[index] = { ...next[index], ...record };
  } else {
    next.unshift(record);
  }
  return next;
}

function mergeSubmittedReplyParent(messages = [], reply = null, replyWasPresent = false) {
  if (!reply?.parentMessageId || replyWasPresent) return messages;
  return (messages || []).map((message) => {
    if (message?.id !== reply.parentMessageId) return message;
    return {
      ...message,
      replyCount: Number(message.replyCount || 0) + 1,
      updatedAt: reply.createdAt || reply.updatedAt || message.updatedAt,
    };
  });
}

function applySubmittedConversationResult(result = {}) {
  if (!appState || typeof applyStateUpdate !== 'function') return false;
  let changed = false;
  const nextState = {
    ...appState,
    messages: [...(appState.messages || [])],
    replies: [...(appState.replies || [])],
    tasks: [...(appState.tasks || [])],
  };
  const taskRecords = [
    result.task,
    result.createdTask,
    result.endedTask,
    result.stoppedTask,
  ].filter(Boolean);

  for (const task of taskRecords) {
    nextState.tasks = upsertStateRecord(nextState.tasks, task);
    changed = true;
  }
  if (result.message) {
    nextState.messages = upsertConversationRecord(nextState.messages, result.message);
    changed = true;
  }
  if (result.createdTaskMessage) {
    nextState.messages = upsertConversationRecord(nextState.messages, result.createdTaskMessage);
    changed = true;
  }
  if (result.reply) {
    const replyWasPresent = nextState.replies.some((item) => item?.id === result.reply.id);
    nextState.replies = upsertConversationRecord(nextState.replies, result.reply);
    nextState.messages = mergeSubmittedReplyParent(nextState.messages, result.reply, replyWasPresent);
    changed = true;
  }
  if (!changed) return false;
  applyStateUpdate(nextState);
  return true;
}

function mergeServerWorkspaceProfile(workspace) {
  if (!workspace || !appState) return false;
  appState.cloud = appState.cloud || {};
  appState.cloud.workspace = { ...(appState.cloud.workspace || {}), ...workspace };
  let matchedWorkspace = false;
  appState.cloud.workspaces = (appState.cloud.workspaces || []).map((server) => {
    const matched = server.id === workspace.id || server.slug === workspace.slug;
    if (matched) matchedWorkspace = true;
    return matched ? { ...server, ...workspace } : server;
  });
  if (!matchedWorkspace) {
    appState.cloud.workspaces = [
      ...(appState.cloud.workspaces || []),
      workspace,
    ];
  }
  return true;
}

document.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  let submittedBottomTarget = null;
  let focusComposerId = null;
  let skipFinalRefresh = false;

  try {
    if (form.id === 'message-form') {
      if (selectedSpaceType === 'channel' && !currentUserIsChannelMember(selectedSpaceId)) {
        throw new Error('Join this channel before sending messages.');
      }
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
      applySubmittedConversationResult(result);
      requestPaneBottomScroll('main');
      submittedBottomTarget = '#message-list';
      focusComposerId = shouldOpenTaskThread && result.message?.id ? composerIdFor('thread', result.message.id) : composerId;
      toast('Message sent');
    }
    if (form.id === 'reply-form') {
      const parentMessage = byId(appState?.messages, threadMessageId);
      if (parentMessage?.spaceType === 'channel' && !currentUserIsChannelMember(parentMessage.spaceId)) {
        throw new Error('Join this channel before replying in the thread.');
      }
      const composerId = form.dataset.composerId || composerIdFor('thread', threadMessageId);
      const rawBody = composerDrafts[composerId] ?? data.get('body');
      const attachmentIds = stagedFor(composerId).ids;
      const replySnapshot = snapshotComposerState(form, composerId);
      clearComposerForSubmit(form, composerId);
      let result;
      try {
        result = await api(`/api/messages/${threadMessageId}/replies`, {
          method: 'POST',
          body: JSON.stringify({ body: encodeComposerMentions(rawBody, composerId), attachmentIds }),
        });
      } catch (error) {
        restoreComposerAfterFailedSubmit(form, composerId, replySnapshot);
        throw error;
      }
      applySubmittedConversationResult(result);
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
      const selectedRuntime = runtimeOptionsForComputer(data.get('computerId')).find((rt) => rt.id === data.get('runtime'));
      if (!selectedRuntime || selectedRuntime.installed === false || selectedRuntime.createSupported === false) {
        throw new Error('Selected computer does not report a supported runtime.');
      }
      // Filter out empty environment variables
      const envVars = agentFormState.envVars.filter((item) => item.key.trim());
      await api('/api/agents', {
        method: 'POST',
        body: JSON.stringify({
          name: data.get('name'),
          description: data.get('description'),
          runtime: selectedRuntime?.name || data.get('runtime'),
          runtimeId: selectedRuntime?.id || data.get('runtime'),
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
    if (form.id === 'agent-runtime-config-form') {
      const agentId = form.dataset.agentId || selectedAgentId;
      const agent = byId(appState.agents, agentId);
      if (!agent) throw new Error('Agent is missing.');
      const runtime = runtimeOptionsForComputer(agent.computerId).find((rt) => rt.id === data.get('runtimeId'));
      if (!runtime || runtime.installed === false || runtime.createSupported === false) {
        throw new Error('Selected runtime is not available for this computer.');
      }
      await api(`/api/agents/${encodeURIComponent(agentId)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          runtime: runtime.name || data.get('runtimeId'),
          runtimeId: runtime.id || data.get('runtimeId'),
          model: data.get('model') || null,
          reasoningEffort: data.get('reasoningEffort') || null,
        }),
      });
      toast('Runtime configuration saved. Restart agent to apply.');
    }
    if (form.id === 'computer-form') {
      await api('/api/computers', {
        method: 'POST',
        body: JSON.stringify({ name: data.get('name'), os: data.get('os'), status: data.get('status') }),
      });
      modal = null;
    }
    if (form.id === 'computer-name-form') {
      const computerId = form.dataset.computerId || selectedComputerId;
      if (!computerId) throw new Error('Computer is missing.');
      await api(`/api/computers/${encodeURIComponent(computerId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: data.get('name') }),
      });
      clearComputerNameFieldDraft();
      computerNameEditState = { computerId: null };
      toast('Computer name saved');
    }
      if (form.id === 'human-form') {
        await api('/api/humans', {
          method: 'POST',
          body: JSON.stringify({ name: data.get('name'), email: data.get('email') }),
        });
        modal = null;
      }
      if (form.id === 'profile-form') {
        const humanId = form.dataset.humanId;
        if (!humanId) throw new Error('Profile identity is missing.');
        await api(`/api/humans/${encodeURIComponent(humanId)}`, {
          method: 'PATCH',
          body: JSON.stringify({
            displayName: data.get('displayName'),
            description: data.get('description'),
            avatar: data.get('avatar'),
          }),
        });
        clearProfileFormDraft();
        toast('Profile saved');
      }
      if (form.id === 'cloud-config-form') {
      await api('/api/cloud/config', {
        method: 'POST',
        body: JSON.stringify(cloudFormPayload()),
      });
      toast('Connection saved');
    }
    if (form.id === 'server-profile-form') {
      const avatar = serverProfileAvatarDraft === null ? data.get('avatar') : serverProfileAvatarDraft;
      const result = await api('/api/cloud/server/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          workspaceSlug: currentServerSlug(),
          name: data.get('name'),
          avatar,
          onboardingAgentId: data.get('onboardingAgentId') || currentServerProfile().onboardingAgentId || '',
          newAgentGreetingEnabled: data.get('newAgentGreetingEnabled') !== 'false',
        }),
      });
      const workspace = result?.workspace;
      if (mergeServerWorkspaceProfile(workspace)) {
        pendingServerProfilePatchSignature = serverProfilePatchSignature();
        patchRailSurface();
        patchServerProfileSettingsSurface();
        patchOpenThreadDrawerSurface({
          main: paneScrollSnapshot('main'),
          thread: paneScrollSnapshot('thread'),
        });
        skipFinalRefresh = true;
      }
      serverProfileAvatarDraft = null;
      toast('Server profile saved');
    }
    if (form.id === 'server-onboarding-form') {
      await api('/api/cloud/server/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          workspaceSlug: currentServerSlug(),
          name: currentServerProfile().name,
          avatar: currentServerProfile().avatar || '',
          onboardingAgentId: data.get('onboardingAgentId') || '',
          newAgentGreetingEnabled: Boolean(data.get('newAgentGreetingEnabled')),
        }),
      });
      toast('Onboarding saved');
    }
    if (form.id === 'server-join-link-form') {
      await api('/api/cloud/join-links', {
        method: 'POST',
        body: JSON.stringify({
          maxUses: data.get('maxUses'),
          expiresIn: data.get('expiresIn') || '24h',
        }),
      });
      form.reset();
      toast('Join link created');
    }
    if (form.id === 'delete-server-form') {
      const slug = String(currentServerProfile().slug || '').trim();
      if (String(data.get('slugConfirm') || '').trim() !== slug) throw new Error('Type the server slug to confirm.');
      await api(`/api/console/servers/${encodeURIComponent(slug)}`, { method: 'DELETE', body: '{}' });
      activeView = 'console';
      consoleTab = 'servers';
      railTab = 'console';
      selectedAgentId = null;
      selectedHumanId = null;
      selectedComputerId = null;
      window.history.replaceState({}, '', '/console/servers');
      toast('Server moved to Lost Space');
    }
    if (form.id === 'cloud-login-form') {
      cloudLoginDraftEmail = String(data.get('email') || '').trim();
      const credentials = validateCloudLoginForm(form, data);
      await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: credentials.email,
          password: credentials.password,
        }),
      });
      cloudLoginDraftEmail = '';
      toast('Signed in');
    }
    if (form.id === 'cloud-open-register-form') {
      const password = assertCloudPasswordPolicy(data.get('password'));
      await api('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          name: data.get('name'),
          email: data.get('email'),
          password,
          language: typeof magclawLanguage === 'function' ? magclawLanguage() : 'en',
        }),
      });
      activeView = 'console';
      consoleTab = 'overview';
      window.history.replaceState({}, '', '/console');
      toast('Account created');
    }
    if (form.id === 'cloud-forgot-form') {
      cloudLoginDraftEmail = String(data.get('email') || '').trim();
      await api('/api/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email: cloudLoginDraftEmail }),
      });
      const params = new URLSearchParams({ email: cloudLoginDraftEmail });
      window.history.replaceState({}, '', `/forgot-password/check-email?${params.toString()}`);
      toast('Reset link sent');
    }
    if (form.id === 'cloud-register-form') {
      const password = assertCloudPasswordPolicy(data.get('password'));
      const passwordConfirm = String(data.get('passwordConfirm') || password);
      if (password !== passwordConfirm) throw new Error('Passwords do not match.');
      await api('/api/cloud/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          inviteToken: data.get('inviteToken'),
          name: data.get('name'),
          avatar: data.get('avatar'),
          password,
          language: typeof magclawLanguage === 'function' ? magclawLanguage() : 'en',
        }),
      });
      window.history.replaceState({}, '', '/');
      toast('Account created');
    }
    if (form.id === 'cloud-reset-form') {
      const password = assertCloudPasswordPolicy(data.get('password'));
      const passwordConfirm = String(data.get('passwordConfirm') || password);
      if (password !== passwordConfirm) throw new Error('Passwords do not match.');
      await api('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({
          resetToken: data.get('resetToken'),
          password,
        }),
      });
      window.history.replaceState({}, '', '/');
      toast('Password reset');
    }
    if (form.id === 'cloud-join-link-form') {
      const result = await api('/api/cloud/join-links/accept', {
        method: 'POST',
        body: JSON.stringify({ token: data.get('joinToken') }),
      });
      const slug = String(result.server?.slug || result.workspace?.slug || '').trim();
      activeView = 'space';
      railTab = 'spaces';
      selectedSpaceType = 'channel';
      selectedSpaceId = defaultChannelIdFromState() || selectedSpaceId || 'chan_all';
      if (slug && window.history?.replaceState) window.history.replaceState({}, '', `/s/${encodeURIComponent(slug)}`);
      toast('Server joined');
    }
    if (form.id === 'member-invite-form') {
      cloudInviteDraft = String(data.get('emailsDraft') || '');
      sanitizeMemberInviteTokens();
      const invalidEmails = memberInviteInvalidEmailsForSubmit();
      if (invalidEmails.length) throw new Error(`Remove invalid email: ${invalidEmails.join(', ')}`);
      const emails = memberInviteEmailsForSubmit();
      if (!emails.length) throw new Error('Enter at least one valid email.');
      const result = await api('/api/cloud/invitations/batch', {
        method: 'POST',
        body: JSON.stringify({
          emails,
          role: data.get('role'),
        }),
      });
      cloudGeneratedLinks = (result.invitations || []).map((item) => ({
        email: item.email,
        link: inviteLinkForCurrentOrigin(item.inviteUrl),
      })).filter((item) => item.email && item.link);
      latestInvitationLink = cloudGeneratedLinks[0]?.link || null;
      cloudInviteEmails = [];
      cloudInviteDraft = '';
      modal = 'member-invite-links';
      toast(`Created ${cloudGeneratedLinks.length} invitation${cloudGeneratedLinks.length === 1 ? '' : 's'}`);
    }
    if (form.id === 'cloud-invite-form') {
      const invite = await api('/api/cloud/invitations', {
        method: 'POST',
        body: JSON.stringify({
          email: data.get('email'),
          role: data.get('role'),
        }),
      });
      if (invite.inviteUrl) {
        latestInvitationLink = inviteLinkForCurrentOrigin(invite.inviteUrl);
        const copied = await tryCopyTextToClipboard(latestInvitationLink);
        toast(copied ? 'Invitation link copied' : 'Invitation created - copy the link below');
      } else {
        toast('Invitation created');
      }
      form.reset();
    }
    if (form.id === 'console-server-form') {
      syncConsoleServerSlug(form);
      if (!validateConsoleServerForm(form)) {
        skipFinalRefresh = true;
        return;
      }
      const result = await api('/api/console/servers', {
        method: 'POST',
        body: JSON.stringify({
          name: data.get('name'),
          slug: form.querySelector('[name="slug"]')?.value || data.get('slug'),
        }),
      });
      const slug = String(result.server?.slug || '').trim();
      const serverName = String(result.server?.name || data.get('name') || 'Server').trim();
      modal = null;
      activeView = 'space';
      railTab = 'spaces';
      consoleTab = 'servers';
      selectedSpaceType = 'channel';
      selectedSpaceId = defaultChannelIdFromState() || selectedSpaceId || 'chan_all';
      threadMessageId = null;
      selectedAgentId = null;
      selectedTaskId = null;
      workspaceActivityDrawerOpen = false;
      if (slug && window.history?.replaceState) {
        window.history.replaceState({}, '', `/s/${encodeURIComponent(slug)}/channels/${encodeURIComponent(selectedSpaceId)}`);
      }
      await refreshStateOrAuthGate();
      skipFinalRefresh = true;
      toast(serverCreatedToastMessage(serverName, slug));
    }
    if (form.id === 'fanout-config-form') {
      await api('/api/settings/fanout', {
        method: 'POST',
        body: JSON.stringify(fanoutFormPayload()),
      });
      toast('Fan-out API saved');
    }
  } catch (error) {
    if (form.id === 'cloud-login-form') {
      skipFinalRefresh = true;
      await showCloudAuthGate(error, { interactive: true });
    } else if (form.id === 'console-server-form') {
      skipFinalRefresh = true;
      const message = error.status === 409 ? 'This URL slug is already taken.' : error.message;
      setConsoleServerFormError(form, message);
      toast(message);
    } else {
      toast(error.message);
    }
  } finally {
    if (focusComposerId) requestComposerFocus(focusComposerId);
    if (!skipFinalRefresh) await refreshStateOrAuthGate().catch(() => {});
    if (submittedBottomTarget) scrollPaneToBottom(submittedBottomTarget, 'auto');
  }
});

render();
refreshStateOrAuthGate().catch((error) => {
  root.innerHTML = `<div class="boot">MAGCLAW / ${escapeHtml(error.message)}</div>`;
});
