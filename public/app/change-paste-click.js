async function generateFreshComputerPairingCommand(body = {}) {
  computerPairingCommandError = '';
  pairingCommandCopyAcknowledged = false;
  if (pairingCommandCopyResetTimer) {
    window.clearTimeout(pairingCommandCopyResetTimer);
    pairingCommandCopyResetTimer = null;
  }
  const requestedDisplayName = String(body.displayName || body.name || body.label || '').trim();
  try {
    latestPairingCommand = await api('/api/cloud/computers/pairing-tokens', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    latestPairingCommand.displayName = requestedDisplayName || latestPairingCommand.displayName || '';
    latestPairingCommand.provisional = !body.computerId;
    try {
      appState = await api('/api/state');
    } catch (error) {
      console.warn('Failed to refresh state after creating computer pairing command:', error);
    }
    return latestPairingCommand;
  } catch (error) {
    computerPairingCommandError = error.message || 'Failed to create connect command.';
    if (modal === 'computer') renderShellOrModal();
    throw error;
  }
}

function selectedOfflineComputerForCommand() {
  if (modal || activeView !== 'computers' || !selectedComputerId) return null;
  const computer = byId(appState?.computers, selectedComputerId);
  if (!computer || computerIsDisabled(computer) || computerIsDeleted(computer)) return null;
  if (String(computer.status || '').toLowerCase() === 'connected') return null;
  if (latestPairingCommand?.computer?.id === computer.id && pairingCommandIsUsable(latestPairingCommand)) return null;
  return computer;
}

async function ensureOfflineComputerConnectCommand() {
  if (offlineComputerCommandInFlight) return;
  const computer = selectedOfflineComputerForCommand();
  if (!computer) return;
  const requestKey = [
    currentServerSlug(),
    computer.id,
    computer.status || 'offline',
    computer.updatedAt || '',
    computer.lastSeenAt || '',
  ].join('|');
  if (offlineComputerCommandRequestKey === requestKey) return;
  offlineComputerCommandRequestKey = requestKey;
  offlineComputerCommandInFlight = true;
  const displayName = defaultComputerPairingName(computer);
  try {
    await generateFreshComputerPairingCommand({ computerId: computer.id, name: displayName, displayName });
    if (!modal && activeView === 'computers' && selectedComputerId === computer.id) render();
  } catch (error) {
    console.warn('Failed to generate offline computer connect command:', error);
  } finally {
    offlineComputerCommandInFlight = false;
  }
}

async function switchConsoleServerAndLoadState(slug) {
  if (!slug) throw new Error('Server slug is missing.');
  const result = await api(`/api/console/servers/${encodeURIComponent(slug)}/switch`, { method: 'POST', body: '{}' });
  try {
    appState = await api('/api/state');
    if (typeof applyMagclawAccountLanguage === 'function') applyMagclawAccountLanguage(appState);
  } catch (error) {
    if (result?.cloud && appState) appState = { ...appState, cloud: result.cloud };
    console.warn('Failed to refresh state after switching server:', error);
  }
  return result;
}

document.addEventListener('change', async (event) => {
  if (event.target.id === 'profile-avatar-library') {
    setProfileAvatarInput(event.target.value);
    return;
  }
  if (event.target.matches?.('[data-avatar-upload-target], .agent-avatar-upload, .human-avatar-upload, #profile-avatar-file, #cloud-auth-avatar-file, #server-avatar-file')) {
    await uploadAvatarFromInput(event.target).catch((error) => toast(error.message));
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
    if (name === 'computerId') {
      saveAgentFormState();
      agentFormState.computerId = event.target.value;
      const nextRuntime = runtimeOptionsForComputer(agentFormState.computerId)
        .find((runtime) => runtime.installed && runtime.createSupported !== false);
      selectedRuntimeId = nextRuntime?.id || '';
      agentFormState.model = '';
      agentFormState.reasoningEffort = '';
      render();
      return;
    }
    if (name === 'runtime') {
      saveAgentFormState();
      const nextRuntimeId = event.target.value;
      const runtime = runtimeOptionsForComputer(agentFormState.computerId)
        .find((item) => item.id === nextRuntimeId && item.installed && item.createSupported !== false);
      selectedRuntimeId = runtime ? nextRuntimeId : '';
      agentFormState.model = '';
      agentFormState.reasoningEffort = '';
      render();
      return;
    }
    if (name === 'model') agentFormState.model = event.target.value;
    if (name === 'reasoningEffort') agentFormState.reasoningEffort = event.target.value;
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
    if (action === 'select-agent-runtime') {
      const form = target.closest('#agent-form');
      if (!form || target.disabled) return;
      saveAgentFormState();
      const nextRuntimeId = target.dataset.value || '';
      const runtime = runtimeOptionsForComputer(agentFormState.computerId).find((rt) => rt.id === nextRuntimeId);
      if (!runtime || !runtime.installed || runtime.createSupported === false) return;
      selectedRuntimeId = nextRuntimeId;
      agentFormState.model = '';
      agentFormState.reasoningEffort = '';
      render();
      return;
    }
    if (action === 'select-agent-model') {
      const form = target.closest('#agent-form');
      if (!form || target.disabled) return;
      saveAgentFormState();
      agentFormState.model = target.dataset.value || '';
      render();
      return;
    }
    if (action === 'select-agent-reasoning') {
      const form = target.closest('#agent-form');
      if (!form || target.disabled) return;
      saveAgentFormState();
      agentFormState.reasoningEffort = target.dataset.value || '';
      render();
      return;
    }
    if (action === 'set-view') {
      if (railTab === 'members') rememberMembersLayoutFromCurrent();
      activeView = target.dataset.view;
      if (activeView === 'cloud') railTab = 'settings';
      if (activeView === 'console') consoleTab = consoleTab || 'overview';
      if (activeView === 'computers' || activeView === 'missions') railTab = 'computers';
      if (activeView === 'tasks' || activeView === 'inbox' || activeView === 'threads' || activeView === 'saved' || activeView === 'search') railTab = 'spaces';
      localStorage.setItem('railTab', railTab);
      threadMessageId = null;
      workspaceActivityDrawerOpen = false;
      inspectorReturnThreadId = null;
      selectedProjectFile = null;
      selectedAgentId = null;
      selectedHumanId = null;
      selectedComputerId = null;
      selectedTaskId = null;
      selectedSavedRecordId = null;
      render();
      syncBrowserRouteForActiveView();
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
      selectedHumanId = null;
      selectedComputerId = null;
      selectedTaskId = null;
      selectedProjectFile = null;
      selectedSavedRecordId = null;
      localStorage.setItem('railTab', railTab);
      render();
      syncBrowserRouteForActiveView();
    }
    if (action === 'set-ui-language') {
      if (typeof setMagclawLanguage === 'function') {
        const language = setMagclawLanguage(target.dataset.language || 'zh-CN');
        if (typeof persistMagclawAccountLanguage === 'function') {
          await persistMagclawAccountLanguage(language).catch((error) => toast(error.message));
        }
      }
      return;
    }
    if (action === 'set-console-tab') {
      consoleTab = target.dataset.tab || 'overview';
      activeView = 'console';
      modal = null;
      threadMessageId = null;
      workspaceActivityDrawerOpen = false;
      inspectorReturnThreadId = null;
      selectedAgentId = null;
      selectedHumanId = null;
      selectedComputerId = null;
      selectedTaskId = null;
      selectedProjectFile = null;
      selectedSavedRecordId = null;
      render();
      syncBrowserRouteForActiveView();
    }
    if (action === 'toggle-server-switcher') {
      serverSwitcherOpen = !serverSwitcherOpen;
      render();
    }
    if (action === 'reset-server-avatar') {
      serverProfileAvatarDraft = '';
      const input = document.querySelector('[data-server-avatar-input]');
      if (input) input.value = '';
      const preview = document.querySelector('.server-profile-avatar');
      if (preview) preview.innerHTML = renderServerAvatar({ ...currentServerProfile(), avatar: '' }, 'server-profile-avatar-img');
      toast('Server avatar reset');
    }
    if (action === 'open-console-server-switcher') {
      serverSwitcherOpen = false;
      activeView = 'console';
      consoleTab = 'servers';
      railTab = 'console';
      modal = null;
      threadMessageId = null;
      workspaceActivityDrawerOpen = false;
      inspectorReturnThreadId = null;
      selectedAgentId = null;
      selectedHumanId = null;
      selectedComputerId = null;
      selectedTaskId = null;
      selectedProjectFile = null;
      selectedSavedRecordId = null;
      render();
      syncBrowserRouteForActiveView();
    }
    if (action === 'switch-server') {
      const slug = target.dataset.slug || '';
      await switchConsoleServerAndLoadState(slug);
      serverSwitcherOpen = false;
      activeView = 'space';
      railTab = 'spaces';
      selectedSpaceType = 'channel';
      selectedSpaceId = defaultChannelIdFromState() || selectedSpaceId || 'chan_all';
      threadMessageId = null;
      workspaceActivityDrawerOpen = false;
      inspectorReturnThreadId = null;
      selectedAgentId = null;
      selectedHumanId = null;
      selectedComputerId = null;
      selectedTaskId = null;
      selectedProjectFile = null;
      selectedSavedRecordId = null;
      toast('Server switched');
      render();
      syncBrowserRouteForActiveView();
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
        const agentId = openMembersNav({ preserveSpace: activeView === 'space' });
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
        selectedHumanId = null;
        selectedComputerId = null;
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
        selectedSpaceType = selectedSpaceType || 'channel';
        selectedSpaceId = selectedSpaceId || appState?.channels?.[0]?.id || 'chan_all';
        selectedAgentId = null;
        selectedHumanId = null;
        selectedComputerId = null;
        workspaceActivityDrawerOpen = false;
      } else if (nav === 'tasks') {
        railTab = 'spaces';
        activeView = 'tasks';
        selectedAgentId = null;
        selectedHumanId = null;
        selectedComputerId = null;
        workspaceActivityDrawerOpen = false;
      } else if (nav === 'members') {
        const agentId = openMembersNav({ preserveSpace: activeView === 'space' });
        if (agentId) loadAgentSkills(agentId).catch((error) => toast(error.message));
      } else if (nav === 'desktop') {
        railTab = 'computers';
        activeView = 'computers';
        selectedAgentId = null;
        selectedHumanId = null;
        selectedComputerId = null;
        workspaceActivityDrawerOpen = false;
      } else if (nav === 'console') {
        railTab = 'console';
        activeView = 'console';
        consoleTab = consoleTab || 'overview';
        selectedAgentId = null;
        selectedHumanId = null;
        selectedComputerId = null;
        workspaceActivityDrawerOpen = false;
      } else if (nav === 'settings') {
        railTab = 'settings';
        activeView = 'cloud';
        selectedAgentId = null;
        selectedHumanId = null;
        selectedComputerId = null;
        workspaceActivityDrawerOpen = false;
      }
      localStorage.setItem('railTab', railTab);
      selectedTaskId = null;
      render();
      syncBrowserRouteForActiveView();
    }
    if (action === 'select-agent') {
      if (!installedRuntimes.length) await loadInstalledRuntimes();
      if (threadMessageId) inspectorReturnThreadId = threadMessageId;
      selectedAgentId = target.dataset.id;
      selectedHumanId = null;
      selectedComputerId = null;
      agentDetailTab = 'profile';
      agentDetailEditState = { field: null };
      agentEnvEditState = null;
      humanDescriptionEditState = { humanId: null };
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
      syncBrowserRouteForActiveView();
      loadAgentSkills(selectedAgentId).catch((error) => toast(error.message));
    }
    if (action === 'select-human-inspector') {
      if (threadMessageId) inspectorReturnThreadId = threadMessageId;
      selectedHumanId = target.dataset.id;
      selectedAgentId = null;
      selectedComputerId = null;
      agentDetailEditState = { field: null };
      agentEnvEditState = null;
      humanDescriptionEditState = { humanId: null };
      threadMessageId = null;
      workspaceActivityDrawerOpen = false;
      selectedTaskId = null;
      selectedProjectFile = null;
      selectedAgentWorkspaceFile = null;
      modal = null;
      if (activeView !== 'space') {
        activeView = 'members';
        railTab = 'members';
      }
      render();
      if (activeView === 'members') syncBrowserRouteForActiveView();
    }
    if (action === 'select-human') {
      selectedHumanId = target.dataset.id;
      selectedAgentId = null;
      selectedComputerId = null;
      agentDetailEditState = { field: null };
      agentEnvEditState = null;
      humanDescriptionEditState = { humanId: null };
      activeView = 'members';
      railTab = 'members';
      threadMessageId = null;
      workspaceActivityDrawerOpen = false;
      selectedTaskId = null;
      selectedProjectFile = null;
      selectedAgentWorkspaceFile = null;
      modal = null;
      rememberMembersLayoutFromCurrent();
      render();
      syncBrowserRouteForActiveView();
    }
    if (action === 'select-computer') {
      selectedComputerId = target.dataset.id;
      selectedAgentId = null;
      selectedHumanId = null;
      humanDescriptionEditState = { humanId: null };
      activeView = 'computers';
      railTab = 'computers';
      threadMessageId = null;
      workspaceActivityDrawerOpen = false;
      selectedTaskId = null;
      selectedProjectFile = null;
      selectedAgentWorkspaceFile = null;
      modal = null;
      render();
      syncBrowserRouteForActiveView();
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
    if (action === 'close-human-detail') {
      if (activeView === 'members') {
        selectedHumanId = null;
        humanDescriptionEditState = { humanId: null };
        activeView = 'space';
        membersLayout = normalizeMembersLayout({ mode: 'channel' });
        render();
        syncBrowserRouteForActiveView();
        return;
      }
      if (inspectorReturnThreadId && byId(appState.messages, inspectorReturnThreadId)) {
        threadMessageId = inspectorReturnThreadId;
      }
      inspectorReturnThreadId = null;
      selectedHumanId = null;
      humanDescriptionEditState = { humanId: null };
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
      clearAgentDetailFieldDraft();
      agentDetailEditState = { field: target.dataset.field };
      render();
    }
    if (action === 'cancel-agent-field') {
      clearAgentDetailFieldDraft();
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
      clearAgentDetailFieldDraft();
      agentDetailEditState = { field: null };
      toast('Agent updated');
    }
    if (action === 'edit-human-description') {
      humanDescriptionEditState = { humanId: target.dataset.id || selectedHumanId };
      render();
    }
    if (action === 'cancel-human-description') {
      humanDescriptionEditState = { humanId: null };
      render();
    }
    if (action === 'save-human-description') {
      const editor = target.closest('.human-description-edit');
      const humanId = editor?.dataset.humanId || selectedHumanId;
      const input = editor?.querySelector('textarea[name="description"]');
      if (!humanId) throw new Error('Human profile is missing.');
      await api(`/api/humans/${encodeURIComponent(humanId)}`, {
        method: 'PATCH',
        body: JSON.stringify({ description: String(input?.value || '').slice(0, 3000) }),
      });
      humanDescriptionEditState = { humanId: null };
      toast('Description saved');
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
      const humanId = currentHumanId();
      const existingDm = (appState.dms || []).find((dm) => (
        dm.participantIds.includes(humanId)
        && dm.participantIds.includes(agentId)
      ));
      if (existingDm) {
        selectedSpaceType = 'dm';
        selectedSpaceId = existingDm.id;
        activeView = 'space';
        railTab = 'spaces';
        selectedAgentId = null;
        selectedHumanId = null;
        selectedComputerId = null;
        selectedTaskId = null;
        render();
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
        selectedHumanId = null;
        selectedComputerId = null;
        selectedTaskId = null;
      }
      syncBrowserRouteForActiveView();
    }
    if (action === 'open-dm-with-human') {
      const humanId = target.dataset.id;
      const actorId = currentHumanId();
      const existingDm = (appState.dms || []).find((dm) => (
        dm.participantIds.includes(actorId)
        && dm.participantIds.includes(humanId)
      ));
      if (existingDm) {
        selectedSpaceId = existingDm.id;
      } else {
        const result = await api('/api/dms', {
          method: 'POST',
          body: JSON.stringify({ participantId: humanId }),
        });
        selectedSpaceId = result.dm.id;
      }
      selectedSpaceType = 'dm';
      activeView = 'space';
      railTab = 'spaces';
      selectedAgentId = null;
      selectedHumanId = null;
      selectedComputerId = null;
      selectedTaskId = null;
      render();
      syncBrowserRouteForActiveView();
    }
    if (action === 'delete-agent') {
      if (!window.confirm('Delete this agent?')) return;
      clearAgentWorkspaceCaches(target.dataset.id);
      await api(`/api/agents/${target.dataset.id}`, { method: 'DELETE' });
      selectedAgentId = null;
      toast('Agent moved to Lost Space');
    }
    if (action === 'restore-agent') {
      await api(`/api/agents/${encodeURIComponent(target.dataset.id || '')}/restore`, { method: 'POST', body: '{}' });
      toast('Agent restored');
    }
    if (action === 'restore-console-server') {
      await api(`/api/console/servers/${encodeURIComponent(target.dataset.slug || '')}/restore`, { method: 'POST', body: '{}' });
      activeView = 'console';
      consoleTab = 'servers';
      railTab = 'console';
      toast('Server restored');
    }
    if (action === 'select-space') {
      persistVisiblePaneScrolls();
      selectedAgentId = null;
      selectedHumanId = null;
      selectedComputerId = null;
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
      syncBrowserRouteForActiveView();
    }
    if (action === 'open-console-server') {
      const slug = target.dataset.slug || '';
      await switchConsoleServerAndLoadState(slug);
      serverSwitcherOpen = false;
      activeView = 'space';
      railTab = 'spaces';
      selectedSpaceType = 'channel';
      selectedSpaceId = defaultChannelIdFromState() || selectedSpaceId || 'chan_all';
      threadMessageId = null;
      selectedAgentId = null;
      selectedHumanId = null;
      selectedComputerId = null;
      selectedTaskId = null;
      workspaceActivityDrawerOpen = false;
      render();
      syncBrowserRouteForActiveView();
    }
    if (action === 'accept-console-invitation' || action === 'decline-console-invitation') {
      const id = target.dataset.id || '';
      const verb = action === 'accept-console-invitation' ? 'accept' : 'decline';
      await api(`/api/console/invitations/${encodeURIComponent(id)}/${verb}`, { method: 'POST', body: '{}' });
      toast(verb === 'accept' ? 'Server joined' : 'Invitation declined');
      consoleTab = verb === 'accept' ? 'servers' : 'invitations';
      activeView = 'console';
      render();
      syncBrowserRouteForActiveView();
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
        render();
        await loadInstalledRuntimes();
        if (modal === 'agent') render();
        return;
      }
      if (modal === 'computer' && cloudCan('manage_computers')) {
        latestPairingCommand = null;
        computerPairingDisplayName = '';
        computerPairingCommandError = '';
        render();
        await generateFreshComputerPairingCommand({ name: defaultComputerPairingName() });
        if (modal === 'computer') render();
        return;
      }
      if (modal === 'member-invite') {
        cloudInviteEmails = [];
        cloudInviteDraft = '';
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
      agentRestartState = { agentId: null, mode: 'restart' };
      modal = null;
      toast('Agent restart requested');
    }
    if (action === 'close-modal') {
      const isBackdrop = event.target.classList.contains('modal-backdrop');
      const isCloseBtn = event.target.closest('.modal-head button[data-action="close-modal"]');
      const isCancelBtn = event.target.closest('.modal-actions .secondary-btn[data-action="close-modal"]');
      const isAnyCloseBtn = event.target.closest('button[data-action="close-modal"]');
      const closeOnlyByHeader = ['member-invite', 'member-invite-links'].includes(modal);
      if ((closeOnlyByHeader && isCloseBtn) || (!closeOnlyByHeader && (isBackdrop || isCloseBtn || isCancelBtn || isAnyCloseBtn))) {
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
        if (modal === 'member-invite') {
          cloudInviteEmails = [];
          cloudInviteDraft = '';
        }
        if (modal === 'member-manage') {
          memberManageState = { memberId: null };
        }
        if (modal === 'member-action-confirm') {
          memberActionConfirmState = { memberId: null, action: null };
          memberManageState = { memberId: null };
        }
        if (modal === 'member-reset-link') {
          memberResetLinkState = { email: '', link: '' };
        }
        if (modal === 'computer') {
          const pendingComputer = latestPairingCommand?.computer || null;
          let refreshedPairingState = false;
          if (latestPairingCommand?.provisional && pendingComputer?.id) {
            try {
              await refreshState();
              refreshedPairingState = true;
            } catch (error) {
              console.warn('Failed to refresh computer pairing state before closing modal:', error);
            }
          }
          const liveComputer = pendingComputer?.id ? byId(appState.computers, pendingComputer.id) : null;
          const pairingComputer = liveComputer || pendingComputer;
          const pendingStatus = String(pairingComputer?.status || '').toLowerCase();
          const hasBoundAgents = (appState.agents || []).some((agent) => agent?.computerId === pairingComputer?.id && !agent.deletedAt);
          const shouldDiscardPairingComputer = Boolean(
            latestPairingCommand?.provisional
            && refreshedPairingState
            && pairingComputer?.id
            && pendingStatus !== 'connected'
            && !hasBoundAgents
          );
          if (shouldDiscardPairingComputer) {
            try {
              await api(`/api/computers/${encodeURIComponent(pairingComputer.id)}`, { method: 'DELETE' });
              await refreshState();
            } catch (error) {
              console.warn('Failed to discard unpaired computer:', error);
            }
          }
          latestPairingCommand = null;
          computerPairingDisplayName = '';
          computerPairingCommandError = '';
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
        renderShellOrModal();
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
      await confirmAvatarCropSelection();
      return;
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
    if (action === 'toggle-task-status-menu') {
      const taskId = target.dataset.id || '';
      openTaskStatusMenuId = openTaskStatusMenuId === taskId ? null : taskId;
      render();
    }
    if (action === 'task-status-set') {
      const taskId = target.dataset.id || '';
      const nextStatus = target.dataset.status || '';
      if (!taskId || !taskColumns.some(([status]) => status === nextStatus)) throw new Error('Task status is invalid.');
      openTaskStatusMenuId = null;
      await api(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      });
      toast(`Task moved to ${taskStatusLabel(nextStatus)}`);
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
    if (action === 'task-close') {
      await api(`/api/tasks/${target.dataset.id}/close`, { method: 'POST', body: '{}' });
      toast('Task closed');
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
      toast('Offline mode enabled');
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
      toast('State pushed');
    }
    if (action === 'cloud-pull') {
      if (!window.confirm('Pull cloud state and replace the synced state?')) return;
      await api('/api/cloud/sync/pull', { method: 'POST', body: '{}' });
      toast('Cloud state pulled');
    }
    if (action === 'create-computer-pairing') {
      computerPairingCommandError = '';
      await generateFreshComputerPairingCommand({ name: defaultComputerPairingName() });
      activeView = 'computers';
      railTab = 'computers';
      toast('Pairing command created');
    }
    if (action === 'generate-computer-command') {
      const computer = byId(appState.computers, target.dataset.id);
      const displayName = defaultComputerPairingName(computer);
      selectedComputerId = target.dataset.id || selectedComputerId;
      activeView = 'computers';
      railTab = 'computers';
      latestPairingCommand = null;
      computerPairingDisplayName = displayName;
      computerPairingCommandError = '';
      render();
      await generateFreshComputerPairingCommand({ computerId: target.dataset.id, name: displayName, displayName: displayName });
      render();
      toast('Connect command generated');
    }
    if (action === 'regenerate-computer-command') {
      const computer = byId(appState.computers, target.dataset.id);
      const displayName = defaultComputerPairingName(computer);
      selectedComputerId = target.dataset.id || selectedComputerId;
      activeView = 'computers';
      railTab = 'computers';
      modal = 'computer';
      latestPairingCommand = null;
      computerPairingDisplayName = displayName;
      computerPairingCommandError = '';
      renderShellOrModal();
      await generateFreshComputerPairingCommand({ computerId: target.dataset.id, name: displayName, displayName: displayName });
      if (modal === 'computer') renderShellOrModal();
      toast('Connect command regenerated');
    }
    if (action === 'refresh-computer-pairing-command') {
      const selectedComputer = selectedComputerId ? byId(appState.computers, selectedComputerId) : null;
      const typedDisplayName = computerPairingDisplayName.trim();
      const displayName = typedDisplayName || defaultComputerPairingName(selectedComputer);
      const body = selectedComputer && !computerIsDisabled(selectedComputer)
        ? { computerId: selectedComputer.id, name: displayName, displayName: displayName }
        : { name: displayName, displayName: displayName };
      computerPairingCommandError = '';
      renderShellOrModal();
      await generateFreshComputerPairingCommand(body);
      modal = 'computer';
      renderShellOrModal();
      toast('Connect command regenerated');
    }
    if (action === 'copy-join-link') {
      const copied = await tryCopyTextToClipboard(target.dataset.url || '');
      toast(copied ? 'Join link copied' : 'Copy is unavailable');
    }
    if (action === 'revoke-join-link') {
      await api(`/api/cloud/join-links/${encodeURIComponent(target.dataset.id || '')}/revoke`, { method: 'POST', body: '{}' });
      toast('Join link revoked');
    }
    if (action === 'start-all-computer-agents') {
      const agents = computerAgents(target.dataset.id || '');
      for (const agent of agents) {
        await api(`/api/agents/${encodeURIComponent(agent.id)}/start`, { method: 'POST', body: '{}' });
      }
      toast(`Start requested for ${agents.length} agent${agents.length === 1 ? '' : 's'}`);
    }
    if (action === 'scan-computer-workspaces') {
      toast('Workspace scan requested');
    }
    if (action === 'disable-computer') {
      if (!window.confirm('Disable this computer?')) return;
      await api(`/api/computers/${encodeURIComponent(target.dataset.id || '')}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'disabled' }),
      });
      await refreshState();
      renderShellOrModal();
      toast('Computer disabled');
    }
    if (action === 'enable-computer') {
      await api(`/api/computers/${encodeURIComponent(target.dataset.id || '')}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'offline' }),
      });
      await refreshState();
      renderShellOrModal();
      toast('Computer enabled');
    }
      if (action === 'confirm-cloud-auth-logout') {
        await api('/api/cloud/auth/logout', { method: 'POST', body: '{}' });
        modal = null;
        toast('Signed out');
      }
      if (action === 'confirm-member-action') {
        const memberId = memberActionConfirmState?.memberId || '';
        const memberAction = memberActionConfirmState?.action || '';
        if (!memberId || !memberAction) throw new Error('Member operation is missing.');
        if (memberAction === 'remove') {
          await api(`/api/cloud/members/${encodeURIComponent(memberId)}`, { method: 'DELETE', body: '{}' });
          memberActionConfirmState = { memberId: null, action: null };
          memberManageState = { memberId: null };
          modal = null;
          toast('Member removed');
        }
        if (memberAction === 'reset-password') {
          const reset = await api('/api/cloud/password-resets', {
            method: 'POST',
            body: JSON.stringify({ memberId }),
          });
          const link = inviteLinkForCurrentOrigin(reset.resetUrl || '');
          if (!link) throw new Error('Password reset link was not returned.');
          memberResetLinkState = { email: reset.email || '', link };
          memberActionConfirmState = { memberId: null, action: null };
          memberManageState = { memberId: null };
          modal = 'member-reset-link';
          settingsTab = 'members';
          activeView = 'cloud';
        }
      }
      if (action === 'update-cloud-member-role') {
        const roleForm = target.closest('.member-manage-role-form') || document.querySelector('.member-manage-role-form');
        const memberId = target.dataset.id || roleForm?.dataset?.id || memberManageState?.memberId || '';
        const role = roleForm?.querySelector('[data-member-role-select]')?.value || '';
        const currentRole = roleForm?.dataset?.currentRole || '';
        if (!memberId || !role) throw new Error('Member role is missing.');
        if (role === currentRole) {
          toast('Member role is already up to date');
          return;
        }
        await api(`/api/cloud/members/${encodeURIComponent(memberId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ role }),
        });
        memberManageState = { memberId };
        modal = 'member-manage';
        settingsTab = 'members';
        activeView = 'cloud';
        toast('Member role updated');
      }
      if (action === 'leave-channel') {
      if (!window.confirm('Leave this channel?')) return;
      await api(`/api/channels/${selectedSpaceId}/leave`, { method: 'POST', body: '{}' });
      selectedSpaceType = 'channel';
      selectedSpaceId = defaultChannelIdFromState();
      modal = null;
      toast('Left channel');
    }
    if (action === 'join-channel') {
      const channelId = target.dataset.id || selectedSpaceId;
      if (!channelId) throw new Error('Channel is missing.');
      await api(`/api/channels/${encodeURIComponent(channelId)}/join`, { method: 'POST', body: '{}' });
      selectedSpaceType = 'channel';
      selectedSpaceId = channelId;
      activeView = 'space';
      modal = null;
      toast('Channel joined');
      render();
      syncBrowserRouteForActiveView();
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
    if (action === 'accept-member-proposal' || action === 'decline-member-proposal') {
      const proposalId = target.dataset.proposalId;
      if (proposalId) {
        const reviewAction = action === 'accept-member-proposal' ? 'accept' : 'decline';
        const reviewPath = action === 'accept-member-proposal'
          ? `/api/channel-member-proposals/${proposalId}/accept`
          : `/api/channel-member-proposals/${proposalId}/decline`;
        await api(reviewPath, {
          method: 'POST',
          body: JSON.stringify({ reviewerId: 'hum_local' }),
        });
        modal = 'channel-members';
        toast(reviewAction === 'accept' ? 'Member proposal accepted' : 'Member proposal declined');
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
