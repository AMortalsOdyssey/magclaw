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
    'set-inbox-category',
    'set-inbox-filter',
    'open-inbox-item',
    'open-workspace-activity',
    'load-more-workspace-activity',
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
    'copy-pairing-command',
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
      'random-profile-avatar',
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
      await navigator.clipboard?.writeText(latestPairingCommand.command);
      toast('Connect command copied');
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
    if (action === 'random-profile-avatar') {
      const avatar = getRandomAvatar();
      setProfileAvatarInput(avatar);
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
      }
    }
    modal = picker.returnModal || null;
    avatarPickerState = null;
    render();
    if (picker.target === 'agent-detail' && action === 'confirm-avatar') {
      await refreshStateOrAuthGate().catch(() => {});
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
  return { action, target, localOnlyActions };
}
