document.addEventListener('change', async (event) => {
  if (event.target.id === 'profile-avatar-library') {
    setProfileAvatarInput(event.target.value);
    return;
  }
  if (event.target.id === 'profile-avatar-file') {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > AGENT_AVATAR_UPLOAD_MAX_BYTES) {
      toast('Avatar must be 10 MB or smaller');
      event.target.value = '';
      return;
    }
    const avatar = await readAvatarFileAsDataUrl(file);
    event.target.value = '';
    setProfileAvatarInput(avatar);
    return;
  }
  if (event.target.id === 'cloud-auth-avatar-file') {
    const file = event.target.files?.[0];
    if (!file) return;
    if (file.size > AGENT_AVATAR_UPLOAD_MAX_BYTES) {
      toast('Avatar must be 10 MB or smaller');
      event.target.value = '';
      return;
    }
    cloudAuthAvatar = await readAvatarFileAsDataUrl(file);
    event.target.value = '';
    showCloudAuthGate(null).catch((error) => toast(error.message));
    return;
  }
  if (event.target.matches?.('.agent-avatar-upload')) {
    await uploadAgentAvatar(event.target).catch((error) => toast(error.message));
    return;
  }
  const target = event.target;
  if (target.dataset?.action === 'update-cloud-member-role') {
    await api(`/api/cloud/members/${encodeURIComponent(target.dataset.id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ role: target.value }),
    }).then(() => toast('Member role updated')).catch((error) => toast(error.message));
    await refreshStateOrAuthGate().catch(() => {});
    return;
  }
  if (target.dataset?.action === 'update-agent-model') {
    await api(`/api/agents/${encodeURIComponent(target.dataset.agentId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ model: target.value || null }),
    }).then(() => toast('Model updated')).catch((error) => toast(error.message));
    await refreshStateOrAuthGate().catch(() => {});
    return;
  }
  if (target.dataset?.action === 'update-agent-reasoning') {
    await api(`/api/agents/${encodeURIComponent(target.dataset.agentId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ reasoningEffort: target.value || null }),
    }).then(() => toast('Reasoning updated')).catch((error) => toast(error.message));
    await refreshStateOrAuthGate().catch(() => {});
    return;
  }
  // Save agent form select state
  const form = event.target.closest('#agent-form');
  if (form) {
    const name = event.target.name;
    if (name === 'computerId') agentFormState.computerId = event.target.value;
    if (name === 'model') agentFormState.model = event.target.value;
    if (name === 'reasoningEffort') agentFormState.reasoningEffort = event.target.value;
  }
  if (event.target.id === 'agent-runtime-select') {
    // Save current form state
    saveAgentFormState();
    selectedRuntimeId = event.target.value;
    // Reset model selection (runtime changed)
    agentFormState.model = '';
    agentFormState.reasoningEffort = '';
    render();
    return;
  }
  if (event.target.name === 'asTask') {
    const composerId = event.target.closest('form')?.dataset.composerId;
    if (composerId) composerTaskFlags[composerId] = event.target.checked;
  }
  const attachmentInput = event.target.closest('.composer-attachment-input');
  if (!attachmentInput) return;
  if (!attachmentInput.files?.length) return;
  try {
    await uploadFiles(attachmentInput.files, attachmentInput.dataset.composerId, 'upload');
    attachmentInput.value = '';
  } catch (error) {
    toast(error.message);
  }
});
document.addEventListener('paste', async (event) => {
  const textarea = event.target.closest?.('textarea[data-mention-input]');
  if (!textarea) return;
  const files = [...(event.clipboardData?.files || [])]
    .filter((file) => String(file.type || '').startsWith('image/'))
    .map(normalizeClipboardFile);
  if (!files.length) return;
  event.preventDefault();
  try {
    await uploadFiles(files, textarea.dataset.composerId, 'clipboard');
  } catch (error) {
    toast(error.message);
  }
});

document.addEventListener('click', async (event) => {
  const prepared = await prepareDocumentClick(event);
  if (!prepared) return;
  const { action, target, localOnlyActions } = prepared;
  try {
    if (action === 'set-view') {
      if (railTab === 'members') rememberMembersLayoutFromCurrent();
      activeView = target.dataset.view;
      if (activeView === 'cloud') railTab = 'settings';
      if (activeView === 'computers' || activeView === 'missions') railTab = 'computers';
      if (activeView === 'tasks' || activeView === 'inbox' || activeView === 'threads' || activeView === 'saved' || activeView === 'search') railTab = 'spaces';
      localStorage.setItem('railTab', railTab);
      threadMessageId = null;
      workspaceActivityDrawerOpen = false;
      inspectorReturnThreadId = null;
      selectedProjectFile = null;
      selectedAgentId = null;
      selectedTaskId = null;
      selectedSavedRecordId = null;
      render();
      if (activeView === 'search') focusSearchInputEnd();
    }
    if (action === 'set-settings-tab') {
      settingsTab = target.dataset.tab || 'account';
      activeView = 'cloud';
      railTab = 'settings';
      modal = null;
      threadMessageId = null;
      workspaceActivityDrawerOpen = false;
      inspectorReturnThreadId = null;
      selectedAgentId = null;
      selectedTaskId = null;
      selectedProjectFile = null;
      selectedSavedRecordId = null;
      localStorage.setItem('railTab', railTab);
      render();
    }
    if (action === 'toggle-sidebar-section') {
      toggleSidebarSection(target.dataset.section || '');
      render();
    }
    if (action === 'toggle-search-mine') {
      searchMineOnly = !searchMineOnly;
      searchVisibleCount = SEARCH_PAGE_SIZE;
      updateSearchResults();
      focusSearchInputEnd();
    }
    if (action === 'toggle-search-range-menu') {
      searchTimeMenuOpen = !searchTimeMenuOpen;
      updateSearchResults();
      focusSearchInputEnd();
    }
    if (action === 'set-search-range') {
      searchTimeRange = target.dataset.range || 'any';
      searchTimeMenuOpen = false;
      searchVisibleCount = SEARCH_PAGE_SIZE;
      updateSearchResults();
      focusSearchInputEnd();
    }
    if (action === 'clear-search-query') {
      searchQuery = '';
      searchVisibleCount = SEARCH_PAGE_SIZE;
      updateSearchResults();
      focusSearchInputEnd();
    }
    if (action === 'clear-search-all') {
      searchQuery = '';
      searchMineOnly = false;
      searchTimeRange = 'any';
      searchTimeMenuOpen = false;
      searchVisibleCount = SEARCH_PAGE_SIZE;
      updateSearchResults();
      focusSearchInputEnd();
    }
    if (action === 'load-more-search') {
      searchVisibleCount += SEARCH_PAGE_SIZE;
      updateSearchResults();
      focusSearchInputEnd();
    }
    if (action === 'set-inbox-category') {
      inboxCategory = ['all', 'unread', 'threads', 'direct', 'workspace'].includes(target.dataset.category)
        ? target.dataset.category
        : 'all';
      render();
    }
    if (action === 'set-inbox-filter') {
      inboxFilter = target.dataset.filter === 'unread' ? 'unread' : 'all';
      render();
    }
    if (action === 'open-inbox-item') {
      const record = conversationRecord(target.dataset.id);
      if (record) {
        workspaceActivityDrawerOpen = false;
        openSearchResult(record);
      }
    }
    if (action === 'open-workspace-activity') {
      activeView = 'inbox';
      railTab = 'spaces';
      threadMessageId = null;
      selectedSavedRecordId = null;
      selectedAgentId = null;
      selectedTaskId = null;
      selectedProjectFile = null;
      workspaceActivityDrawerOpen = true;
      workspaceActivityVisibleCount = WORKSPACE_ACTIVITY_VISIBLE_STEP;
      workspaceActivityScrollToBottom = true;
      render();
    }
    if (action === 'load-more-workspace-activity') {
      workspaceActivityVisibleCount += WORKSPACE_ACTIVITY_VISIBLE_STEP;
      workspaceActivityScrollToBottom = false;
      render();
    }
    if (action === 'close-workspace-activity') {
      workspaceActivityDrawerOpen = false;
      await markInboxRead({ workspaceActivityReadAt: new Date().toISOString() });
      render();
    }
    if (action === 'mark-inbox-read') {
      const model = buildInboxModel();
      const recordIds = model.normalItems.flatMap((item) => (
        item.type === 'thread' ? threadRecordIds(item.recordId) : [item.recordId]
      ));
      await markInboxRead({
        recordIds,
        workspaceActivityReadAt: new Date().toISOString(),
      });
      toast('Inbox marked read');
    }
    if (action === 'set-rail-tab') {
      if (target.dataset.railTab === 'members') {
        const agentId = openMembersNav();
        localStorage.setItem('railTab', railTab);
        render();
        if (agentId) loadAgentSkills(agentId).catch((error) => toast(error.message));
        return;
      }
      if (railTab === 'members') rememberMembersLayoutFromCurrent();
      railTab = target.dataset.railTab;
      localStorage.setItem('railTab', railTab);
      if (railTab === 'spaces') {
        selectedAgentId = null;
      }
      selectedTaskId = null;
      render();
    }
    if (action === 'set-left-nav') {
      const nav = target.dataset.nav || 'chat';
      if (nav !== 'members' && railTab === 'members') rememberMembersLayoutFromCurrent();
      if (nav === 'chat') {
        railTab = 'spaces';
        activeView = 'space';
        selectedAgentId = null;
        workspaceActivityDrawerOpen = false;
      } else if (nav === 'tasks') {
        railTab = 'spaces';
        activeView = 'tasks';
        selectedAgentId = null;
        workspaceActivityDrawerOpen = false;
      } else if (nav === 'members') {
        const agentId = openMembersNav();
        if (agentId) loadAgentSkills(agentId).catch((error) => toast(error.message));
      } else if (nav === 'desktop') {
        railTab = 'computers';
        activeView = 'computers';
        selectedAgentId = null;
        workspaceActivityDrawerOpen = false;
      } else if (nav === 'settings') {
        railTab = 'settings';
        activeView = 'cloud';
        selectedAgentId = null;
        workspaceActivityDrawerOpen = false;
      }
      localStorage.setItem('railTab', railTab);
      selectedTaskId = null;
      render();
    }
    if (action === 'select-agent') {
      if (!installedRuntimes.length) await loadInstalledRuntimes();
      if (threadMessageId) inspectorReturnThreadId = threadMessageId;
      selectedAgentId = target.dataset.id;
      agentDetailTab = 'profile';
      agentDetailEditState = { field: null };
      agentEnvEditState = null;
      threadMessageId = null;
      workspaceActivityDrawerOpen = false;
      selectedTaskId = null;
      selectedProjectFile = null;
      selectedAgentWorkspaceFile = null;
      if (railTab === 'members') {
        activeView = 'members';
        rememberMembersLayoutFromCurrent();
      }
      modal = null;
      render();
      maybeWarmCurrentAgent();
      loadAgentSkills(selectedAgentId).catch((error) => toast(error.message));
    }
    if (action === 'close-agent-detail') {
      if (activeView === 'members') {
        selectedAgentId = null;
        agentDetailEditState = { field: null };
        agentEnvEditState = null;
        selectedAgentWorkspaceFile = null;
        activeView = 'space';
        membersLayout = normalizeMembersLayout({ mode: 'channel' });
        render();
        return;
      }
      if (inspectorReturnThreadId && byId(appState.messages, inspectorReturnThreadId)) {
        threadMessageId = inspectorReturnThreadId;
      }
      inspectorReturnThreadId = null;
      selectedAgentId = null;
      agentDetailEditState = { field: null };
      agentEnvEditState = null;
      render();
    }
    if (action === 'set-agent-detail-tab') {
      agentDetailTab = target.dataset.tab || 'profile';
      agentDetailEditState = { field: null };
      agentEnvEditState = null;
      if (agentDetailTab === 'workspace') {
        await prepareAgentWorkspaceTab(selectedAgentId);
      } else if (agentDetailTab === 'skills' || agentDetailTab === 'profile') {
        await loadAgentSkills(selectedAgentId);
      } else {
        render();
      }
    }
    if (action === 'toggle-agent-skill-section') {
      toggleSkillSection(target.dataset.section || '');
      render();
    }
    if (action === 'edit-agent-field') {
      agentDetailEditState = { field: target.dataset.field };
      render();
    }
    if (action === 'cancel-agent-field') {
      agentDetailEditState = { field: null };
      render();
    }
    if (action === 'save-agent-field') {
      const field = target.dataset.field;
      const editor = target.closest('.agent-inline-edit');
      const agentId = editor?.dataset.agentId || selectedAgentId;
      const input = editor?.querySelector(`[name="${CSS.escape(field || '')}"]`);
      const value = field === 'description'
        ? String(input?.value || '').slice(0, 3000)
        : String(input?.value || '').trim();
      if (field === 'name' && !value) {
        toast('Name is required');
        return;
      }
      await api(`/api/agents/${encodeURIComponent(agentId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ [field]: value }),
      });
      agentDetailEditState = { field: null };
      toast('Agent updated');
    }
    if (action === 'refresh-agent-skills') {
      await loadAgentSkills(target.dataset.agentId || selectedAgentId, { force: true });
      toast('Skills rescanned');
    }
    if (action === 'edit-agent-env') {
      const agent = byId(appState.agents, target.dataset.agentId || selectedAgentId);
      agentEnvEditState = {
        agentId: agent?.id || selectedAgentId,
        items: (agent?.envVars?.length ? agent.envVars : [{ key: '', value: '' }])
          .map((item) => ({ key: item.key || '', value: item.value || '' })),
      };
      render();
    }
    if (action === 'add-agent-env-var') {
      if (agentEnvEditState?.items) agentEnvEditState.items.push({ key: '', value: '' });
      render();
    }
    if (action === 'remove-agent-env-var') {
      const index = parseInt(target.dataset.index, 10);
      if (!Number.isNaN(index) && agentEnvEditState?.items) {
        agentEnvEditState.items.splice(index, 1);
        if (!agentEnvEditState.items.length) agentEnvEditState.items.push({ key: '', value: '' });
      }
      render();
    }
    if (action === 'cancel-agent-env') {
      agentEnvEditState = null;
      render();
    }
    if (action === 'save-agent-env') {
      const agentId = target.dataset.agentId || selectedAgentId;
      const envVars = (agentEnvEditState?.items || [])
        .map((item) => ({ key: String(item.key || '').trim(), value: String(item.value || '') }))
        .filter((item) => item.key);
      await api(`/api/agents/${encodeURIComponent(agentId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ envVars }),
      });
      agentEnvEditState = null;
      toast('Environment variables updated');
    }
    if (action === 'open-dm-with-agent') {
      const agentId = target.dataset.id;
      const existingDm = (appState.dms || []).find((dm) => dm.participantIds.includes(agentId));
      if (existingDm) {
        selectedSpaceType = 'dm';
        selectedSpaceId = existingDm.id;
        activeView = 'space';
        railTab = 'spaces';
        selectedAgentId = null;
        selectedTaskId = null;
        render();
        maybeWarmCurrentAgent();
      } else {
        const result = await api('/api/dms', {
          method: 'POST',
          body: JSON.stringify({ participantId: agentId }),
        });
        selectedSpaceType = 'dm';
        selectedSpaceId = result.dm.id;
        activeView = 'space';
        railTab = 'spaces';
        selectedAgentId = null;
        selectedTaskId = null;
        maybeWarmAgent(byId(appState.agents, agentId), { spaceType: 'dm', spaceId: result.dm.id });
      }
    }
    if (action === 'delete-agent') {
      if (!window.confirm('Delete this agent?')) return;
      clearAgentWorkspaceCaches(target.dataset.id);
      await api(`/api/agents/${target.dataset.id}`, { method: 'DELETE' });
      selectedAgentId = null;
      toast('Agent deleted');
    }
    if (action === 'select-space') {
      persistVisiblePaneScrolls();
      selectedAgentId = null;
      selectedTaskId = null;
      inspectorReturnThreadId = null;
      agentDetailEditState = { field: null };
      agentEnvEditState = null;
      selectedSpaceType = target.dataset.type;
      selectedSpaceId = target.dataset.id;
      activeView = 'space';
      activeTab = 'chat';
      threadMessageId = null;
      workspaceActivityDrawerOpen = false;
      selectedSavedRecordId = null;
      selectedProjectFile = null;
      selectedAgentWorkspaceFile = null;
      markSpaceRead(selectedSpaceType, selectedSpaceId);
      render();
      maybeWarmCurrentAgent();
    }
    if (action === 'set-tab') {
      persistVisiblePaneScrolls();
      activeTab = target.dataset.tab;
      if (activeTab !== 'tasks') selectedTaskId = null;
      render();
    }
    if (action === 'task-filter') {
      taskFilter = target.dataset.status;
      render();
    }
    if (action === 'set-task-view') {
      taskViewMode = target.dataset.view === 'list' ? 'list' : 'board';
      taskChannelMenuOpen = false;
      render();
    }
    if (action === 'toggle-task-channel-menu') {
      taskChannelMenuOpen = !taskChannelMenuOpen;
      render();
    }
    if (action === 'toggle-task-channel-filter') {
      const channelId = target.dataset.id;
      if (channelId) {
        taskChannelFilterIds = taskChannelFilterIds.includes(channelId)
          ? taskChannelFilterIds.filter((id) => id !== channelId)
          : [...taskChannelFilterIds, channelId];
      }
      taskChannelMenuOpen = true;
      render();
    }
    if (action === 'clear-task-channel-filters') {
      taskChannelFilterIds = [];
      taskChannelMenuOpen = false;
      render();
    }
    if (action === 'toggle-task-column') {
      toggleTaskColumn(target.dataset.status);
      render();
    }
    if (action === 'select-task') {
      const task = byId(appState.tasks, target.dataset.id);
      const thread = task ? taskThreadMessage(task) : null;
      if (thread) {
        selectedTaskId = null;
        threadMessageId = thread.id;
        workspaceActivityDrawerOpen = false;
      } else {
        selectedTaskId = target.dataset.id;
        threadMessageId = null;
        workspaceActivityDrawerOpen = false;
      }
      inspectorReturnThreadId = null;
      selectedAgentId = null;
      selectedProjectFile = null;
      selectedSavedRecordId = null;
      render();
    }
    if (action === 'close-task-detail') {
      selectedTaskId = null;
      render();
    }
    if (action === 'open-modal') {
      modal = target.dataset.modal;
      if (modal === 'channel') {
        createChannelMemberSearchQuery = '';
      }
      if (modal === 'add-channel-member' || modal === 'channel-members') {
        addMemberSearchQuery = '';
      }
      if (modal === 'agent') {
        resetAgentFormState();
        await loadInstalledRuntimes();
      }
      render();
    }
    if (action === 'agent-stop-unavailable') {
      toast('暂时不可用');
    }
    if (action === 'open-agent-restart') {
      agentRestartState = { agentId: target.dataset.id, mode: 'restart' };
      modal = 'agent-restart';
      render();
    }
    if (action === 'select-agent-restart-mode') {
      agentRestartState = {
        ...agentRestartState,
        mode: target.dataset.mode || 'restart',
      };
      render();
    }
    if (action === 'start-agent') {
      agentStartState = { agentId: target.dataset.id };
      modal = 'agent-start';
      render();
    }
    if (action === 'confirm-agent-start') {
      if (!agentStartState.agentId) return;
      await api(`/api/agents/${agentStartState.agentId}/start`, { method: 'POST', body: '{}' });
      agentStartState = { agentId: null };
      modal = null;
      toast('Agent start requested');
    }
    if (action === 'confirm-agent-restart') {
      if (!agentRestartState.agentId) return;
      await api(`/api/agents/${agentRestartState.agentId}/restart`, {
        method: 'POST',
        body: JSON.stringify({ mode: agentRestartState.mode || 'restart' }),
      });
      modal = null;
      toast('Agent restart requested');
    }
    if (action === 'close-modal') {
      const isBackdrop = event.target.classList.contains('modal-backdrop');
      const isCloseBtn = event.target.closest('.modal-head button[data-action="close-modal"]');
      const isCancelBtn = event.target.closest('.modal-actions .secondary-btn[data-action="close-modal"]');
      if (isBackdrop || isCloseBtn || isCancelBtn) {
        if (modal === 'agent') {
          resetAgentFormState();
        }
        if (modal === 'add-channel-member' || modal === 'channel-members') {
          addMemberSearchQuery = '';
        }
        if (modal === 'channel') {
          createChannelMemberSearchQuery = '';
        }
        if (modal === 'agent-start') {
          agentStartState = { agentId: null };
        }
        if (modal === 'agent-restart') {
          agentRestartState = { agentId: null, mode: 'restart' };
        }
        let nextModal = null;
        if (modal === 'avatar-crop') {
          if (avatarCropState?.target === 'agent-create') nextModal = 'agent';
          avatarCropState = null;
        }
        if (modal === 'avatar-picker') {
          nextModal = avatarPickerState?.returnModal || null;
          avatarPickerState = null;
        }
        modal = nextModal;
        render();
      }
    }
    if (action === 'open-thread') {
      threadMessageId = target.dataset.id;
      workspaceActivityDrawerOpen = false;
      inspectorReturnThreadId = null;
      selectedSavedRecordId = null;
      selectedAgentId = null;
      selectedTaskId = null;
      selectedProjectFile = null;
      markThreadRead(threadMessageId);
      requestComposerFocus(composerIdFor('thread', threadMessageId));
      render();
      scrollToMessage(threadMessageId);
    }
    if (action === 'open-search-result') {
      const record = conversationRecord(target.dataset.id);
      if (record) openSearchResult(record);
    }
    if (action === 'open-search-entity') {
      openSearchEntity(target.dataset.targetType, target.dataset.targetId);
    }
    if (action === 'close-thread') {
      threadMessageId = null;
      selectedSavedRecordId = null;
      render();
    }
    if (action === 'view-in-channel') {
      const message = byId(appState.messages, target.dataset.id);
      if (message) {
        persistVisiblePaneScrolls();
        selectedSpaceType = message.spaceType;
        selectedSpaceId = message.spaceId;
        activeView = 'space';
        activeTab = 'chat';
        threadMessageId = message.id;
        workspaceActivityDrawerOpen = false;
        selectedTaskId = null;
        markThreadRead(message.id);
        render();
        scrollToMessage(message.id);
      }
    }
    if (action === 'back-to-bottom') {
      const targetPane = target.dataset.target === 'thread' ? '#thread-context' : '#message-list';
      scrollPaneToBottom(targetPane);
    }
    if (action === 'remove-staged-attachment') {
      removeStagedAttachment(target.dataset.composerId, target.dataset.id);
    }
    if (action === 'pick-project-folder') {
      const result = await api('/api/projects/pick-folder', {
        method: 'POST',
        body: JSON.stringify({
          spaceType: selectedSpaceType,
          spaceId: selectedSpaceId,
          defaultPath: appState.settings?.defaultWorkspace || '',
        }),
      });
      if (result.canceled) {
        toast('Folder picker canceled');
        return;
      }
      modal = null;
      toast('Project folder added');
    }
    if (action === 'toggle-project-tree') {
      await toggleProjectTree(target.dataset.projectId, target.dataset.path || '');
    }
    if (action === 'open-project-file') {
      await openProjectFile(target.dataset.projectId, target.dataset.path || '');
    }
    if (action === 'close-project-preview') {
      selectedProjectFile = null;
      render();
    }
    if (action === 'toggle-agent-workspace') {
      await toggleAgentWorkspace(target.dataset.agentId, target.dataset.path || '');
    }
    if (action === 'open-agent-workspace-file') {
      await openAgentWorkspaceFile(target.dataset.agentId, target.dataset.path || '');
    }
    if (action === 'refresh-agent-workspace') {
      await refreshAgentWorkspace(target.dataset.agentId || selectedAgentId);
    }
    if (action === 'set-agent-workspace-preview-mode') {
      agentWorkspacePreviewMode = target.dataset.mode || 'preview';
      render();
    }
    if (action === 'close-agent-workspace-file') {
      selectedAgentWorkspaceFile = null;
      render();
    }
    if (action === 'confirm-avatar-crop') {
      const crop = avatarCropState;
      const avatar = await drawCroppedAvatarToDataUrl(crop);
      if (crop?.target === 'agent-detail' && crop.agentId) {
        await api(`/api/agents/${encodeURIComponent(crop.agentId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ avatar }),
        });
        toast('Avatar updated');
      }
      if (crop?.target === 'agent-create') {
        agentFormState.avatar = avatar;
        toast('Avatar selected');
      }
      avatarCropState = null;
      modal = crop?.target === 'agent-create' ? 'agent' : null;
    }
    if (action === 'remove-project') {
      clearProjectCaches(target.dataset.id);
      await api(`/api/projects/${target.dataset.id}`, { method: 'DELETE' });
      toast('Project folder removed');
    }
    if (action === 'save-message') {
      await api(`/api/messages/${target.dataset.id}/save`, { method: 'POST', body: '{}' });
    }
    if (action === 'remove-saved-message') {
      await api(`/api/messages/${target.dataset.id}/save`, { method: 'POST', body: '{}' });
      if (selectedSavedRecordId === target.dataset.id) {
        selectedSavedRecordId = null;
        threadMessageId = null;
      }
      toast('Removed from saved');
    }
    if (action === 'open-saved-message') {
      const record = conversationRecord(target.dataset.id);
      if (record) {
        const threadRoot = savedRecordThreadRoot(record);
        selectedSavedRecordId = record.id;
        selectedAgentId = null;
        selectedTaskId = null;
        selectedProjectFile = null;
        inspectorReturnThreadId = null;
        if (threadRoot) {
          threadMessageId = threadRoot.id;
          render();
        } else {
          selectedSpaceType = record.spaceType;
          selectedSpaceId = record.spaceId;
          activeView = 'space';
          activeTab = 'chat';
          threadMessageId = null;
          render();
          scrollToMessage(record.id);
        }
      }
    }
    if (action === 'message-task') {
      await api(`/api/messages/${target.dataset.id}/task`, { method: 'POST', body: '{}' });
      toast('Task created from message');
    }
    if (action === 'task-claim') {
      await api(`/api/tasks/${target.dataset.id}/claim`, { method: 'POST', body: JSON.stringify({ actorId: 'agt_codex' }) });
      toast('Task claimed');
    }
    if (action === 'task-unclaim') {
      await api(`/api/tasks/${target.dataset.id}/unclaim`, { method: 'POST', body: '{}' });
      toast('Task unclaimed');
    }
    if (action === 'task-review') {
      await api(`/api/tasks/${target.dataset.id}/request-review`, { method: 'POST', body: '{}' });
      toast('Review requested');
    }
    if (action === 'task-approve') {
      await api(`/api/tasks/${target.dataset.id}/approve`, { method: 'POST', body: '{}' });
      toast('Task approved');
    }
    if (action === 'task-reopen') {
      await api(`/api/tasks/${target.dataset.id}/reopen`, { method: 'POST', body: '{}' });
      toast('Task reopened');
    }
    if (action === 'run-task-codex') {
      await api(`/api/tasks/${target.dataset.id}/run-codex`, { method: 'POST', body: '{}' });
      activeView = 'missions';
      toast('Codex mission started');
    }
    if (action === 'cloud-local' || action === 'cloud-disconnect') {
      await api('/api/cloud/disconnect', { method: 'POST', body: '{}' });
      toast('Local-only mode enabled');
    }
    if (action === 'cloud-configure') {
      await api('/api/cloud/config', {
        method: 'POST',
        body: JSON.stringify(cloudFormPayload('cloud')),
      });
      toast('Cloud mode configured');
    }
    if (action === 'cloud-pair') {
      const payload = cloudFormPayload('cloud');
      await api('/api/cloud/config', { method: 'POST', body: JSON.stringify(payload) });
      await api('/api/cloud/pair', { method: 'POST', body: JSON.stringify(payload) });
      toast('Cloud endpoint paired');
    }
    if (action === 'cloud-push') {
      await api('/api/cloud/sync/push', { method: 'POST', body: '{}' });
      toast('Local state pushed');
    }
    if (action === 'cloud-pull') {
      if (!window.confirm('Pull cloud state and replace the synced local state?')) return;
      await api('/api/cloud/sync/pull', { method: 'POST', body: '{}' });
      toast('Cloud state pulled');
    }
    if (action === 'create-computer-pairing') {
      latestPairingCommand = await api('/api/cloud/computers/pairing-tokens', {
        method: 'POST',
        body: JSON.stringify({ name: appState.runtime?.host || 'Computer' }),
      });
      activeView = 'computers';
      railTab = 'computers';
      toast('Pairing command created');
    }
      if (action === 'confirm-cloud-auth-logout') {
        await api('/api/cloud/auth/logout', { method: 'POST', body: '{}' });
        modal = null;
        toast('Signed out');
      }
      if (action === 'remove-cloud-member') {
        if (!window.confirm('Remove this member?')) return;
        await api(`/api/cloud/members/${encodeURIComponent(target.dataset.id)}`, { method: 'DELETE', body: '{}' });
        toast('Member removed');
      }
      if (action === 'reset-cloud-member-password') {
        const reset = await api('/api/cloud/password-resets', {
          method: 'POST',
          body: JSON.stringify({ memberId: target.dataset.id }),
        });
        cloudGeneratedLinks = reset.resetUrl ? [{ email: reset.email, link: reset.resetUrl }] : [];
        settingsTab = 'members';
        activeView = 'cloud';
        toast('Password reset link created');
      }
      if (action === 'leave-channel') {
      if (!window.confirm('Leave this channel?')) return;
      await api(`/api/channels/${selectedSpaceId}/leave`, { method: 'POST', body: '{}' });
      selectedSpaceType = 'channel';
      selectedSpaceId = 'chan_all';
      modal = null;
      toast('Left channel');
    }
    if (action === 'remove-channel-member') {
      const memberId = target.dataset.memberId;
      await api(`/api/channels/${selectedSpaceId}/members/${memberId}`, { method: 'DELETE' });
      toast('Member removed');
    }
    if (action === 'add-channel-member') {
      const memberId = target.dataset.memberId;
      if (memberId) {
        await api(`/api/channels/${selectedSpaceId}/members`, {
          method: 'POST',
          body: JSON.stringify({ memberId }),
        });
        modal = 'add-channel-member';
        toast('Member added');
      }
    }
  } catch (error) {
    toast(error.message);
  } finally {
    if (!localOnlyActions.has(action)) {
      await refreshStateOrAuthGate().catch(() => {});
    }
    if (action === 'open-thread') scrollToMessage(threadMessageId);
    if (action === 'view-in-channel') scrollToMessage(target.dataset.id);
    if (action === 'back-to-bottom') {
      const targetPane = target.dataset.target === 'thread' ? '#thread-context' : '#message-list';
      scrollPaneToBottom(targetPane);
    }
    if (action === 'add-channel-member') {
      const input = document.querySelector('#add-member-search');
      input?.focus();
      input?.setSelectionRange(addMemberSearchQuery.length, addMemberSearchQuery.length);
    }
  }
});
