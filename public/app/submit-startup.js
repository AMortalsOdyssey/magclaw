document.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  let submittedBottomTarget = null;
  let focusComposerId = null;
  let authErrorHandled = false;

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
        toast('Profile saved');
      }
      if (form.id === 'cloud-config-form') {
      await api('/api/cloud/config', {
        method: 'POST',
        body: JSON.stringify(cloudFormPayload()),
      });
      toast('Connection saved');
    }
    if (form.id === 'cloud-login-form') {
      cloudLoginDraftEmail = String(data.get('email') || '').trim();
      await api('/api/cloud/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: cloudLoginDraftEmail,
          password: data.get('password'),
        }),
      });
      cloudLoginDraftEmail = '';
      toast('Signed in');
    }
    if (form.id === 'cloud-register-form') {
      await api('/api/cloud/auth/register', {
        method: 'POST',
        body: JSON.stringify({
          inviteToken: data.get('inviteToken'),
          name: data.get('name'),
          email: data.get('email'),
          password: data.get('password'),
        }),
      });
      toast('Account created');
    }
    if (form.id === 'cloud-invite-form') {
      const invite = await api('/api/cloud/invitations', {
        method: 'POST',
        body: JSON.stringify({
          email: data.get('email'),
          role: data.get('role'),
        }),
      });
      if (invite.inviteUrl) await navigator.clipboard?.writeText(invite.inviteUrl);
      toast(invite.inviteUrl ? 'Invitation link copied' : 'Invitation created');
      form.reset();
    }
    if (form.id === 'fanout-config-form') {
      await api('/api/settings/fanout', {
        method: 'POST',
        body: JSON.stringify(fanoutFormPayload()),
      });
      toast('Fan-out API saved');
    }
  } catch (error) {
    if (form.id === 'cloud-login-form' && error.status === 401) {
      authErrorHandled = true;
      await showCloudAuthGate(error, { interactive: true });
    } else {
      toast(error.message);
    }
  } finally {
    if (focusComposerId) requestComposerFocus(focusComposerId);
    if (!authErrorHandled) await refreshStateOrAuthGate().catch(() => {});
    if (submittedBottomTarget) scrollPaneToBottom(submittedBottomTarget, 'auto');
  }
});

render();
refreshStateOrAuthGate().catch((error) => {
  root.innerHTML = `<div class="boot">MAGCLAW LOCAL / ${escapeHtml(error.message)}</div>`;
});
