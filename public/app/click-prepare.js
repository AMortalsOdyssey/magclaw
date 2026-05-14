async function prepareDocumentClick(event) {
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
      if (avatarPickerState) {
        avatarPickerState.selectedAvatar = avatarSrc;
      } else {
        agentFormState.avatar = avatarSrc;
      }
      document.querySelectorAll('.avatar-option').forEach((el) => el.classList.remove('selected'));
      avatarOption.classList.add('selected');
    }
    return;
  }
  const clickedTaskChannelFilter = event.target.closest('.task-channel-filter');
  const clickedTaskStatusMenu = event.target.closest('.task-inline-badge');
  const clickedSearchFilter = event.target.closest('.search-time-filter');
  const clickedServerSwitcher = event.target.closest('.server-switcher-anchor');
  const target = event.target.closest('[data-action]');
  if (serverSwitcherOpen && !clickedServerSwitcher) {
    serverSwitcherOpen = false;
    if (!target) {
      render();
      return;
    }
  }
  if (taskChannelMenuOpen && !clickedTaskChannelFilter) {
    taskChannelMenuOpen = false;
    if (!target) {
      render();
      return;
    }
  }
  if (openTaskStatusMenuId && !clickedTaskStatusMenu) {
    openTaskStatusMenuId = null;
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
  if (action === 'update-cloud-member-role' && target.matches?.('select')) return;
  const localOnlyActions = new Set([
    'set-view',
    'set-settings-tab',
    'set-ui-language',
    'dismiss-app-flash',
    'set-console-tab',
    'set-rail-tab',
    'toggle-sidebar-section',
    'toggle-server-switcher',
    'open-console-server-switcher',
    'select-agent',
    'select-human-inspector',
    'select-human',
    'select-computer',
    'close-agent-detail',
    'close-human-detail',
    'set-agent-detail-tab',
    'toggle-agent-skill-section',
    'edit-agent-field',
    'cancel-agent-field',
    'edit-human-description',
    'cancel-human-description',
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
    'set-inbox-category',
    'set-inbox-filter',
    'open-inbox-item',
    'open-workspace-activity',
    'load-more-workspace-activity',
    'enable-agent-notifications',
    'disable-agent-notifications',
    'dismiss-agent-notifications',
    'toggle-server-notification-mute',
    'toggle-task-channel-menu',
    'toggle-task-channel-filter',
    'clear-task-channel-filters',
    'toggle-task-status-menu',
    'toggle-task-column',
    'select-task',
    'close-task-detail',
    'open-modal',
    'close-modal',
    'copy-pairing-command',
    'computer-display-name',
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
    'randomize-human-avatar',
    'pick-human-avatar',
    'random-profile-avatar',
    'reset-profile-avatar',
    'reset-server-avatar',
    'random-cloud-auth-avatar',
    'reset-cloud-auth-avatar',
    'focus-member-invite-input',
    'commit-member-invite-email',
    'remove-member-invite-email',
    'copy-member-generated-link',
    'copy-all-member-generated-links',
    'members-page-prev',
    'members-page-next',
    'members-page-go',
    'open-member-manage',
    'open-member-action-confirm',
    'copy-member-reset-link',
    'copy-join-link',
    'start-all-computer-agents',
    'scan-computer-workspaces',
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
  if (action === 'copy-pairing-command') {
    if (latestPairingCommand?.command) {
      const copied = await tryCopyTextToClipboard(pairingCommandText());
      toast(copied ? 'Connect command copied' : 'Copy is unavailable');
    }
    return;
  }
  if (action === 'dismiss-app-flash') {
    appFlash = null;
    render();
    return;
  }
  if (action === 'toggle-server-notification-mute') {
    toggleServerNotificationsMuted();
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
    if (action === 'random-profile-avatar') {
      const avatar = getRandomAvatar();
      setProfileAvatarInput(avatar);
      return;
    }
    if (action === 'reset-profile-avatar') {
      setProfileAvatarInput('');
      return;
    }
    if (action === 'random-cloud-auth-avatar') {
      cloudAuthAvatar = getRandomAvatar();
      await showCloudAuthGate(null);
      return;
    }
    if (action === 'reset-cloud-auth-avatar') {
      cloudAuthAvatar = '';
      await showCloudAuthGate(null);
      return;
    }
    if (action === 'focus-member-invite-input') {
      const draftInput = document.getElementById('member-invite-input');
      if (draftInput) cloudInviteDraft = draftInput.value;
      if (commitMemberInviteDraft()) {
        render();
        document.getElementById('member-invite-input')?.focus();
        return;
      }
      const input = document.getElementById('member-invite-input');
      input?.focus();
      return;
    }
    if (action === 'remove-member-invite-email') {
      const email = target.dataset.email || '';
      cloudInviteEmails = cloudInviteEmails.filter((item) => item !== email);
      render();
      document.getElementById('member-invite-input')?.focus();
      return;
    }
    if (action === 'copy-member-generated-link') {
      const index = Number(target.dataset.index);
      const item = Number.isInteger(index) ? cloudGeneratedLinks[index] : null;
      if (item) {
        const copied = await tryCopyTextToClipboard(generatedLinkText(item));
        toast(copied ? 'Invitation copied' : 'Copy failed');
      }
      return;
    }
    if (action === 'copy-all-member-generated-links') {
      if (cloudGeneratedLinks.length) {
        const copied = await tryCopyTextToClipboard(generatedLinksText());
        toast(copied ? 'All invitations copied' : 'Copy failed');
      }
      return;
    }
    if (action === 'copy-member-reset-link') {
      if (memberResetLinkState.link) {
        const copied = await tryCopyTextToClipboard(memberResetLinkText());
        toast(copied ? 'Password reset link copied' : 'Copy failed');
      }
      return;
    }
    if (action === 'members-page-prev' || action === 'members-page-next') {
      memberDirectoryPage = Number.parseInt(target.dataset.page, 10) || 1;
      render();
      return;
    }
    if (action === 'members-page-go') {
      const input = document.getElementById('members-page-input');
      memberDirectoryPage = Number.parseInt(input?.value, 10) || 1;
      render();
      document.getElementById('members-page-input')?.focus();
      return;
    }
    if (action === 'open-member-manage') {
      memberManageState = { memberId: target.dataset.id || null };
      modal = 'member-manage';
      render();
      return;
    }
    if (action === 'open-member-action-confirm') {
      memberActionConfirmState = {
        memberId: target.dataset.id || memberManageState?.memberId || null,
        action: target.dataset.memberAction || null,
      };
      modal = 'member-action-confirm';
      render();
      return;
    }
    if (action === 'pick-avatar') {
      saveAgentFormState();
      openAvatarPicker({ target: 'agent-create', selectedAvatar: agentFormState.avatar, returnModal: 'agent' });
      return;
    }
    if (action === 'pick-profile-avatar') {
      const input = document.getElementById('profile-avatar-input');
      openAvatarPicker({
        target: 'profile',
        humanId: document.getElementById('profile-form')?.dataset?.humanId || '',
        selectedAvatar: input?.value || currentAccountHuman().avatar || '',
        returnModal: null,
      });
      return;
    }
    if (action === 'pick-agent-detail-avatar') {
      const agent = byId(appState.agents, target.dataset.id || selectedAgentId);
      openAvatarPicker({
        target: 'agent-detail',
        agentId: agent?.id || '',
        selectedAvatar: agent?.avatar || '',
        returnModal: null,
      });
      return;
    }
    if (action === 'pick-human-avatar') {
      const human = humanByIdAny(target.dataset.id || selectedHumanId);
      openAvatarPicker({
        target: 'human-detail',
        humanId: human?.id || '',
        selectedAvatar: human?.avatar || '',
        returnModal: null,
      });
      return;
    }
  if (action === 'back-to-agent-modal' || action === 'confirm-avatar') {
    const picker = avatarPickerState || { target: 'agent-create', selectedAvatar: agentFormState.avatar, returnModal: 'agent' };
    if (action === 'confirm-avatar') {
      const selectedAvatar = document.querySelector('.avatar-option.selected')?.dataset?.avatar || '';
      const avatar = selectedAvatar || picker.selectedAvatar || getRandomAvatar();
      if (picker.target === 'agent-create') {
        agentFormState.avatar = avatar;
        toast('Avatar selected');
      } else if (picker.target === 'profile') {
        if (picker.humanId && appState?.humans) {
          appState = {
            ...appState,
            humans: appState.humans.map((human) => (
              human.id === picker.humanId ? { ...human, avatar } : human
            )),
          };
        }
        setProfileAvatarInput(avatar);
        toast('Avatar selected');
      } else if (picker.target === 'agent-detail' && picker.agentId) {
        try {
          await api(`/api/agents/${encodeURIComponent(picker.agentId)}`, {
            method: 'PATCH',
            body: JSON.stringify({ avatar }),
          });
          toast('Avatar updated');
        } catch (error) {
          toast(error.message);
        }
      } else if (picker.target === 'human-detail' && picker.humanId) {
        try {
          await api(`/api/humans/${encodeURIComponent(picker.humanId)}`, {
            method: 'PATCH',
            body: JSON.stringify({ avatar }),
          });
          toast('Avatar updated');
        } catch (error) {
          toast(error.message);
        }
      }
    }
    modal = picker.returnModal || null;
    avatarPickerState = null;
    render();
    if ((picker.target === 'agent-detail' || picker.target === 'human-detail') && action === 'confirm-avatar') {
      await refreshStateOrAuthGate().catch(() => {});
    }
    return;
  }
  if (action === 'randomize-human-avatar') {
    const avatar = getRandomAvatar();
    try {
      await api(`/api/humans/${encodeURIComponent(target.dataset.id || selectedHumanId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ avatar }),
      });
      toast('Avatar updated');
      await refreshStateOrAuthGate().catch(() => {});
    } catch (error) {
      toast(error.message);
    }
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
      await refreshStateOrAuthGate().catch(() => {});
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (action === 'avatar-crop-zoom-in' && avatarCropState) {
    avatarCropState.scale = clampAvatarCropScale(avatarCropState.scale + 0.15);
    clampAvatarCropOffset();
    renderShellOrModal();
    return;
  }
  if (action === 'avatar-crop-zoom-out' && avatarCropState) {
    avatarCropState.scale = clampAvatarCropScale(avatarCropState.scale - 0.15);
    clampAvatarCropOffset();
    renderShellOrModal();
    return;
  }
  if (action === 'avatar-crop-reset' && avatarCropState) {
    avatarCropState.scale = 1;
    avatarCropState.offsetX = 0;
    avatarCropState.offsetY = 0;
    clampAvatarCropOffset();
    renderShellOrModal();
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
  return { action, target, localOnlyActions };
}
