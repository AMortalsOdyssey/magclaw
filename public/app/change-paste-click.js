async function generateFreshComputerPairingCommand(body = {}) {
  computerPairingCommandError = '';
  resetPairingCommandCopyAcknowledgement();
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

async function discardProvisionalPairingComputer(pairingCommand = latestPairingCommand) {
  const pendingComputer = pairingCommand?.computer || null;
  if (!pairingCommand?.provisional || !pendingComputer?.id) return false;
  try {
    await refreshState();
  } catch (error) {
    console.warn('Failed to refresh computer pairing state before discarding provisional computer:', error);
    return false;
  }
  const liveComputer = pendingComputer.id ? byId(appState.computers, pendingComputer.id) : null;
  const pairingComputer = liveComputer || pendingComputer;
  const pendingStatus = String(pairingComputer?.status || '').toLowerCase();
  const hasBoundAgents = (appState.agents || []).some((agent) => agent?.computerId === pairingComputer?.id && !agent.deletedAt);
  const shouldDiscardPairingComputer = Boolean(
    pairingComputer?.id
    && pendingStatus !== 'connected'
    && !hasBoundAgents
  );
  if (!shouldDiscardPairingComputer) return false;
  try {
    await api(`/api/computers/${encodeURIComponent(pairingComputer.id)}`, { method: 'DELETE' });
    await refreshState();
    if (latestPairingCommand?.computer?.id === pairingComputer.id) latestPairingCommand = null;
    return true;
  } catch (error) {
    console.warn('Failed to discard unpaired computer:', error);
    return false;
  }
}

function findStagedAttachment(attachmentId) {
  const id = String(attachmentId || '');
  if (!id) return null;
  for (const staged of Object.values(stagedByComposer || {})) {
    const attachment = (staged?.attachments || []).find((item) => item?.id === id);
    if (attachment) return attachment;
  }
  return null;
}

function findAttachmentForPreview(attachmentId) {
  return byId(appState?.attachments, attachmentId) || findStagedAttachment(attachmentId);
}

async function openAttachmentPreview(attachmentId) {
  const attachment = findAttachmentForPreview(attachmentId);
  if (!attachment) throw new Error('Attachment is missing.');
  const kind = attachmentPreviewKind(attachment);
  attachmentPreviewState = {
    attachmentId: attachment.id,
    loading: kind === 'markdown',
    content: '',
    error: '',
  };
  modal = 'attachment-preview';
  renderShellOrModal();
  if (kind !== 'markdown') return;
  const maxPreviewBytes = 1024 * 1024;
  if (Number(attachment.bytes || 0) > maxPreviewBytes) {
    attachmentPreviewState = {
      ...attachmentPreviewState,
      loading: false,
      error: 'Markdown preview is limited to 1 MB. Open the original file to inspect the full attachment.',
    };
    if (modal === 'attachment-preview') renderShellOrModal();
    return;
  }
  try {
    const response = await fetch(attachment.url || '', {
      headers: { accept: 'text/markdown,text/plain,*/*' },
    });
    if (!response.ok) throw new Error(`Preview request failed (${response.status}).`);
    const content = await response.text();
    attachmentPreviewState = {
      ...attachmentPreviewState,
      loading: false,
      content,
      error: '',
    };
  } catch (error) {
    attachmentPreviewState = {
      ...attachmentPreviewState,
      loading: false,
      error: error.message || 'Preview failed.',
    };
  }
  if (modal === 'attachment-preview' && attachmentPreviewState.attachmentId === attachment.id) renderShellOrModal();
}

async function switchConsoleServerAndLoadState(slug) {
  const nextSlug = String(slug || '').trim();
  if (!nextSlug) throw new Error('Server slug is missing.');
  if (typeof persistActiveComposerDraftBeforeNavigation === 'function') persistActiveComposerDraftBeforeNavigation();
  const nextServerHeaders = { 'x-magclaw-server-slug': nextSlug };
  const result = await api(`/api/console/servers/${encodeURIComponent(nextSlug)}/switch`, {
    method: 'POST',
    body: '{}',
    headers: nextServerHeaders,
  });
  try {
    appState = await api('/api/state', { headers: nextServerHeaders });
    if (typeof loadStoredComposerDrafts === 'function') loadStoredComposerDrafts({ force: true });
    if (typeof applyMagclawAccountLanguage === 'function') applyMagclawAccountLanguage(appState);
  } catch (error) {
    if (result?.cloud && appState) appState = { ...appState, cloud: result.cloud };
    console.warn('Failed to refresh state after switching server:', error);
  }
  return result;
}

function markAgentRestartStarting(agentId) {
  const agent = byId(appState?.agents, agentId);
  if (!agent) return false;
  agent.status = 'starting';
  agent.statusReason = 'agent_restart_requested';
  agent.statusUpdatedAt = new Date().toISOString();
  render();
  return true;
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
function clipboardImageFiles(clipboardData) {
  const clipboardFiles = Array.from(clipboardData?.files || []);
  const clipboardItems = Array.from(clipboardData?.items || []);
  let files = clipboardFiles.filter((file) => String(file.type || '').startsWith('image/'));
  if (!files.length) {
    files = clipboardItems
      .filter((item) => String(item.type || '').startsWith('image/'))
      .map((item) => item.getAsFile?.())
      .filter((file) => file && String(file.type || '').startsWith('image/'));
  }
  const seen = new Set();
  return files
    .filter((file) => {
      const key = clipboardImageSignature(file);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((file, index) => normalizeClipboardFile(file, index));
}

function clipboardImageSignature(file) {
  const type = String(file?.type || '').toLowerCase();
  const size = Number(file?.size || 0);
  const name = String(file?.name || '').trim().toLowerCase();
  if (!type.startsWith('image/')) return `${name}:${type}:${size}`;
  const genericName = !name || /^(image\.(png|jpe?g|webp|gif|bmp|tiff?)$|screenshot[-_\s.]|screen shot[-_\s.])/i.test(name);
  return genericName ? `${type}:${size}` : `${name}:${type}:${size}`;
}

function clipboardPasteBatchSignature(files = []) {
  return files.map((file) => clipboardImageSignature(file)).filter(Boolean).join('|');
}

function clipboardDataMayContainImage(clipboardData) {
  return Array.from(clipboardData?.types || [])
    .some((type) => type === 'Files' || String(type || '').startsWith('image/'));
}

function composerTextareaFromPasteTarget(target) {
  const textarea = target?.closest?.('textarea[data-mention-input]');
  if (textarea) return textarea;
  const active = document.activeElement;
  return active?.closest?.('textarea[data-mention-input]') || null;
}

async function clipboardImageFilesFromNavigator() {
  if (!navigator.clipboard?.read) return [];
  try {
    const items = await navigator.clipboard.read();
    const files = [];
    for (const item of items || []) {
      for (const type of item.types || []) {
        if (!String(type || '').startsWith('image/')) continue;
        const blob = await item.getType(type);
        files.push(new File([blob], clipboardScreenshotName(files.length, type), {
          type,
          lastModified: Date.now(),
        }));
      }
    }
    return files;
  } catch {
    return [];
  }
}

let recentClipboardPasteBatchesByComposer = {};

document.addEventListener('paste', async (event) => {
  const textarea = composerTextareaFromPasteTarget(event.target);
  const composerId = textarea?.dataset?.composerId;
  if (!composerId) return;
  const clipboardTypes = Array.from(event.clipboardData?.types || []);
  const mayContainImage = clipboardDataMayContainImage(event.clipboardData);
  if (mayContainImage) event.preventDefault();
  let files = clipboardImageFiles(event.clipboardData);
  if (!files.length && (mayContainImage || !clipboardTypes.length)) {
    files = await clipboardImageFilesFromNavigator();
  }
  if (!files.length) return;
  if (!event.defaultPrevented) event.preventDefault();
  const batchSignature = clipboardPasteBatchSignature(files);
  const previousBatch = recentClipboardPasteBatchesByComposer[composerId];
  const nowMs = Date.now();
  if (batchSignature && previousBatch?.signature === batchSignature && nowMs - previousBatch.at < 1500) {
    return;
  }
  recentClipboardPasteBatchesByComposer[composerId] = { signature: batchSignature, at: nowMs };
  try {
    await uploadFiles(files, composerId, 'clipboard');
  } catch (error) {
    toast(error.message);
  }
});

function openMessageContextMenu(recordId, event, scope = 'message', options = {}) {
  const id = String(recordId || '').trim();
  if (!id || !conversationRecord(id)) return false;
  const rect = event?.currentTarget?.getBoundingClientRect?.() || event?.target?.getBoundingClientRect?.();
  const surface = options.surface || messageContextSurfaceFromTarget(event?.target) || messageContextSurfaceFromTarget(event?.currentTarget);
  messageContextMenu = {
    recordId: id,
	    scope,
	    surface,
	    selectionText: cleanReferenceText(options.selectionText || '', CONVERSATION_REFERENCE_LIMITS_UI?.selectedTextChars || 4000),
	    x: Number.isFinite(event?.clientX) ? event.clientX : (rect ? rect.right - 8 : 120),
    y: Number.isFinite(event?.clientY) ? event.clientY : (rect ? rect.top + 24 : 120),
    source: options.source || '',
    viewportWidth: Number.isFinite(window.innerWidth) ? window.innerWidth : 0,
    viewportHeight: Number.isFinite(window.innerHeight) ? window.innerHeight : 0,
  };
  render();
  return true;
}

function messageContextSurfaceFromTarget(target) {
  if (target?.closest?.('#thread-context')) return 'thread';
  if (target?.closest?.('#message-list')) return 'channel';
  return '';
}

const MESSAGE_LONG_PRESS_MS = 520;
const MESSAGE_LONG_PRESS_MOVE_TOLERANCE = 12;
let messageLongPressTimer = null;
let messageLongPressStart = null;
let messageLongPressSuppressClickUntil = 0;

function clearMessageLongPressTimer() {
  if (messageLongPressTimer) clearTimeout(messageLongPressTimer);
  messageLongPressTimer = null;
  messageLongPressStart = null;
}

function messageRecordIdFromInteractionTarget(target) {
  const message = target?.closest?.('.magclaw-message');
  if (!message) return '';
  return message.dataset.messageId || message.dataset.replyId || '';
}

function messageLongPressIgnoredTarget(target) {
  return Boolean(target?.closest?.('button, a, input, textarea, select, label, .message-context-menu, .share-selection-bar, .share-preview-modal'));
}

function messageLongPressPoint(event) {
  const touch = event?.changedTouches?.[0] || event?.touches?.[0];
  if (!touch) return null;
  return {
    clientX: touch.clientX,
    clientY: touch.clientY,
  };
}

function handleMessageLongPressStart(event) {
  if (messageLongPressIgnoredTarget(event.target)) return;
  const recordId = messageRecordIdFromInteractionTarget(event.target);
  const point = messageLongPressPoint(event);
  if (!recordId || !point) return;
  clearMessageLongPressTimer();
  const target = event.target;
  messageLongPressStart = { ...point, recordId };
  messageLongPressTimer = setTimeout(() => {
    const payload = { ...point, target, currentTarget: target };
    messageLongPressTimer = null;
    messageLongPressSuppressClickUntil = Date.now() + 700;
    openMessageContextMenu(recordId, payload, 'message', { source: 'message-long-press' });
  }, MESSAGE_LONG_PRESS_MS);
}

function handleMessageLongPressMove(event) {
  if (!messageLongPressStart) return;
  const point = messageLongPressPoint(event);
  if (!point) return;
  const moved = Math.hypot(point.clientX - messageLongPressStart.clientX, point.clientY - messageLongPressStart.clientY);
  if (moved > MESSAGE_LONG_PRESS_MOVE_TOLERANCE) clearMessageLongPressTimer();
}

function handleMessageLongPressClick(event) {
  if (Date.now() > messageLongPressSuppressClickUntil) return;
  if (!messageRecordIdFromInteractionTarget(event.target)) return;
  event.preventDefault();
  event.stopPropagation();
}

document.addEventListener('touchstart', handleMessageLongPressStart, { passive: true });
document.addEventListener('touchmove', handleMessageLongPressMove, { passive: true });
document.addEventListener('touchend', clearMessageLongPressTimer, { passive: true });
document.addEventListener('touchcancel', clearMessageLongPressTimer, { passive: true });
document.addEventListener('click', handleMessageLongPressClick, true);

document.addEventListener('contextmenu', (event) => {
  const savedRow = event.target.closest?.('.saved-row[data-message-id]');
  if (savedRow) {
    if (openMessageContextMenu(savedRow.dataset.messageId, event, 'saved')) event.preventDefault();
    return;
	  }
	  const messageRow = event.target.closest?.('.magclaw-message');
	  const recordId = messageRow?.dataset?.messageId || messageRow?.dataset?.replyId || '';
	  const selection = typeof selectedMessageTextForEvent === 'function' ? selectedMessageTextForEvent(event) : null;
	  if (selection?.recordId && openMessageContextMenu(selection.recordId, event, 'message', { selectionText: selection.text })) {
	    event.preventDefault();
	    return;
	  }
	  if (recordId && openMessageContextMenu(recordId, event, 'message')) event.preventDefault();
	});

document.addEventListener('click', async (event) => {
  const prepared = await prepareDocumentClick(event);
  if (!prepared) return;
  const { action, target, localOnlyActions } = prepared;
  const clickLoadingToken = beginClickLoading(action, target, localOnlyActions);
  let skipFinalRefresh = false;
  try {
    if (action === 'copy-feishu-import-path') {
      const channelId = target.dataset.id || selectedSpaceId;
      const result = await api(`/api/channels/${encodeURIComponent(channelId)}/feishu-import-path`, {
        method: 'POST',
        body: '{}',
      });
      const copied = await tryCopyTextToClipboard(result.path || result.copyText || '');
      toast(copied ? 'MagClaw Channel path copied' : 'Copy failed');
      return;
    }
    if (action === 'open-external-import-context') {
      externalImportContextState = { recordId: target.dataset.id || '' };
      modal = 'external-import-context';
      renderShellOrModal();
      return;
    }
    if (action === 'open-message-context-menu') {
      openMessageContextMenu(target.dataset.id, event, target.dataset.contextScope || 'message');
      return;
    }
    if (action === 'close-message-context-menu') {
      messageContextMenu = null;
      render();
      return;
    }
    if (action === 'copy-message-link') {
      const record = conversationRecord(target.dataset.id);
      const copied = await tryCopyTextToClipboard(messageRecordLink(record));
      messageContextMenu = null;
      toast(copied ? 'Message link copied' : 'Copy failed');
      render();
      return;
    }
	    if (action === 'copy-message-markdown') {
	      const record = conversationRecord(target.dataset.id);
	      const copied = await tryCopyTextToClipboard(messageRecordMarkdown(record));
	      messageContextMenu = null;
	      toast(copied ? 'Message markdown copied' : 'Copy failed');
	      render();
	      return;
	    }
    if (action === 'copy-selected-message-text') {
      const copied = await tryCopyTextToClipboard(messageContextMenu?.selectionText || '');
      messageContextMenu = null;
      toast(copied ? 'Selected text copied' : 'Copy failed');
      render();
      return;
    }
    if (action === 'copy-agent-activity-diagnostic') {
      const agent = byId(appState.agents, target.dataset.agentId || selectedAgentId);
      const copied = await tryCopyTextToClipboard(agentActivityDiagnosticText(agent));
      toast(copied ? 'Diagnostic info copied' : 'Copy failed');
      return;
    }
	    if (action === 'add-selected-text-context') {
	      const record = conversationRecord(target.dataset.id);
	      const selectedText = messageContextMenu?.selectionText || '';
	      if (record && typeof quoteRecordToComposer === 'function') quoteRecordToComposer(record, 'context', selectedText, { surface: messageContextMenu?.surface || '' });
	      messageContextMenu = null;
	      render();
	      return;
	    }
	    if (action === 'add-selected-text-channel-context') {
	      const record = conversationRecord(target.dataset.id);
	      const selectedText = messageContextMenu?.selectionText || '';
	      if (record && typeof addChannelContextReferenceToComposer === 'function') addChannelContextReferenceToComposer(record, selectedText);
	      messageContextMenu = null;
	      render();
	      return;
	    }
	    if (action === 'add-message-context') {
	      const record = conversationRecord(target.dataset.id);
	      if (record && typeof quoteRecordToComposer === 'function') quoteRecordToComposer(record, 'context', '', { surface: messageContextMenu?.surface || '' });
	      messageContextMenu = null;
	      render();
	      return;
	    }
	    if (action === 'add-message-channel-context') {
	      const record = conversationRecord(target.dataset.id);
	      if (record && typeof addChannelContextReferenceToComposer === 'function') addChannelContextReferenceToComposer(record);
	      messageContextMenu = null;
	      render();
	      return;
	    }
	    if (action === 'add-thread-context') {
	      const record = conversationRecord(target.dataset.id);
	      if (record && typeof addThreadReferenceToComposer === 'function') addThreadReferenceToComposer(record, { surface: messageContextMenu?.surface || '' });
	      messageContextMenu = null;
	      render();
	      return;
	    }
	    if (action === 'start-message-share') {
      const id = target.dataset.id || '';
      const record = conversationRecord(id);
      messageShareState = messageShareStateForRecord(record);
      messageContextMenu = null;
      render();
      return;
    }
    if (action === 'toggle-share-selection') {
      const id = target.dataset.id || '';
      const record = conversationRecord(id);
      if (!recordMatchesShareScope(record)) return;
      const selected = new Set(shareSelectedIds());
      if (selected.has(id)) selected.delete(id);
      else if (id) {
        if (selected.size >= SHARE_MESSAGE_SELECTION_LIMIT) {
          toast(shareSelectionLimitMessage());
          return;
        }
        selected.add(id);
      }
      messageShareState = selected.size
        ? normalizedMessageShareState({ ...messageShareState, active: true, selectedIds: [...selected] })
        : emptyMessageShareState();
      render();
      return;
    }
    if (action === 'toggle-share-select-all') {
      if (shareAllSelectableMessagesSelected()) {
        messageShareState = emptyMessageShareState();
        sharePreviewState = { open: false, imageUrl: '', recordIds: [] };
        render();
        return;
      }
      const targetIds = shareSelectAllTargetIds();
      if (shareSelectableRecords().length > SHARE_MESSAGE_SELECTION_LIMIT) toast(shareSelectionLimitMessage());
      messageShareState = normalizedMessageShareState({
        ...messageShareState,
        active: targetIds.length > 0,
        selectedIds: targetIds,
      });
      render();
      return;
    }
    if (action === 'cancel-message-share') {
      messageShareState = emptyMessageShareState();
      sharePreviewState = { open: false, imageUrl: '', recordIds: [] };
      render();
      return;
    }
	    if (action === 'copy-selected-markdown') {
      const copied = await tryCopyTextToClipboard(selectedMessagesMarkdown());
      toast(copied ? 'Selected messages copied as Markdown' : 'Copy failed');
	      return;
	    }
	    if (action === 'add-selected-messages-context') {
	      if (typeof addSelectedMessagesReferenceToComposer === 'function' && addSelectedMessagesReferenceToComposer()) {
	        messageShareState = emptyMessageShareState();
	      }
	      render();
	      return;
	    }
    if (action === 'download-selected-image') {
      const records = shareSelectionRecords();
      sharePreviewState = { open: true, imageUrl: '', recordIds: records.map((record) => record.id) };
      const renderStartedAt = Date.now();
      render();
      await new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const imageUrl = await generateShareImageDataUrl(records);
      const remainingRenderMs = SHARE_IMAGE_RENDER_MIN_MS - (Date.now() - renderStartedAt);
      if (remainingRenderMs > 0) await new Promise((resolve) => setTimeout(resolve, remainingRenderMs));
      sharePreviewState = { open: true, imageUrl, recordIds: records.map((record) => record.id) };
      render();
      return;
    }
    if (action === 'close-share-preview') {
      sharePreviewState = { open: false, imageUrl: '', recordIds: [] };
      render();
      return;
    }
    if (action === 'save-share-image') {
      const result = await saveShareImage();
      if (result?.ok) {
        toast(result.path ? `Share image saved to ${result.path}` : 'Share image saved');
        messageShareState = emptyMessageShareState();
        sharePreviewState = { open: false, imageUrl: '', recordIds: [] };
        render();
      } else {
        toast(result?.cancelled ? 'Image save cancelled' : 'Image save failed');
      }
      return;
    }
    if (action === 'mobile-nav') {
      openMobileRoot(target.dataset.nav || 'home');
      return;
    }
    if (action === 'mobile-back') {
      mobileNavigateBack();
      return;
    }
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
      const wasSearchView = activeView === 'search';
      const nextView = target.dataset.view;
      if (nextView === 'search') {
        openSearchView();
        return;
      }
      activeView = nextView;
      mobileHomeOpen = false;
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
      if (!wasSearchView) selectedSavedRecordId = null;
      render();
      syncBrowserRouteForActiveView();
      if (activeView === 'search') focusSearchInputEnd();
    }
    if (action === 'set-settings-tab') {
      settingsTab = target.dataset.tab || 'account';
      activeView = 'cloud';
      mobileHomeOpen = false;
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
      refreshPackageVersionReminders();
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
      refreshPackageVersionReminders();
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
    if (action === 'toggle-channel-create-menu') {
      channelCreateMenuOpen = !channelCreateMenuOpen;
      render();
    }
    if (action === 'open-channel-create') {
      channelCreateMenuOpen = false;
      modal = 'channel';
      renderShellOrModal();
    }
    if (action === 'toggle-search-mine') {
      searchMineOnly = !searchMineOnly;
      if (searchMineOnly) searchSenderId = '';
      searchSenderMenuOpen = false;
      searchVisibleCount = SEARCH_PAGE_SIZE;
      queueSearchResultsRefresh();
      focusSearchInputEnd();
    }
    if (action === 'toggle-search-sender-menu') {
      searchSenderMenuOpen = !searchSenderMenuOpen;
      searchChannelMenuOpen = false;
      searchTimeMenuOpen = false;
      updateSearchResults();
      if (searchSenderMenuOpen) {
        window.setTimeout(() => document.getElementById('search-sender-input')?.focus({ preventScroll: true }), 0);
      } else {
        focusSearchInputEnd();
      }
    }
    if (action === 'set-search-sender') {
      searchSenderId = target.dataset.senderId || '';
      searchSenderQuery = '';
      searchSenderMenuOpen = false;
      searchMineOnly = false;
      searchVisibleCount = SEARCH_PAGE_SIZE;
      queueSearchResultsRefresh();
      focusSearchInputEnd();
    }
    if (action === 'clear-search-sender') {
      searchSenderId = '';
      searchSenderQuery = '';
      searchSenderMenuOpen = false;
      searchVisibleCount = SEARCH_PAGE_SIZE;
      queueSearchResultsRefresh();
      focusSearchInputEnd();
    }
    if (action === 'toggle-search-channel-menu') {
      searchChannelMenuOpen = !searchChannelMenuOpen;
      searchSenderMenuOpen = false;
      searchTimeMenuOpen = false;
      updateSearchResults();
      if (searchChannelMenuOpen) {
        window.setTimeout(() => document.getElementById('search-channel-input')?.focus({ preventScroll: true }), 0);
      } else {
        focusSearchInputEnd();
      }
    }
    if (action === 'set-search-channel') {
      searchChannelId = target.dataset.channelId || '';
      searchChannelQuery = '';
      searchChannelMenuOpen = false;
      searchVisibleCount = SEARCH_PAGE_SIZE;
      queueSearchResultsRefresh();
      focusSearchInputEnd();
    }
    if (action === 'clear-search-channel') {
      searchChannelId = '';
      searchChannelQuery = '';
      searchChannelMenuOpen = false;
      searchVisibleCount = SEARCH_PAGE_SIZE;
      queueSearchResultsRefresh();
      focusSearchInputEnd();
    }
    if (action === 'toggle-search-range-menu') {
      searchTimeMenuOpen = !searchTimeMenuOpen;
      searchSenderMenuOpen = false;
      searchChannelMenuOpen = false;
      updateSearchResults();
      focusSearchInputEnd();
    }
    if (action === 'set-search-range') {
      searchTimeRange = target.dataset.range || 'any';
      searchTimeMenuOpen = false;
      searchVisibleCount = SEARCH_PAGE_SIZE;
      queueSearchResultsRefresh();
      focusSearchInputEnd();
    }
    if (action === 'clear-search-range') {
      searchTimeRange = 'any';
      searchTimeMenuOpen = false;
      searchVisibleCount = SEARCH_PAGE_SIZE;
      queueSearchResultsRefresh();
      focusSearchInputEnd();
    }
    if (action === 'clear-search-query') {
      searchQuery = '';
      searchVisibleCount = SEARCH_PAGE_SIZE;
      queueSearchResultsRefresh();
      focusSearchInputEnd();
    }
    if (action === 'clear-search-all') {
      searchQuery = '';
      searchMineOnly = false;
      searchSenderId = '';
      searchSenderQuery = '';
      searchSenderMenuOpen = false;
      searchChannelId = '';
      searchChannelQuery = '';
      searchChannelMenuOpen = false;
      searchTimeRange = 'any';
      searchTimeMenuOpen = false;
      searchVisibleCount = SEARCH_PAGE_SIZE;
      queueSearchResultsRefresh();
      focusSearchInputEnd();
    }
    if (action === 'load-more-search') {
      searchVisibleCount += SEARCH_PAGE_SIZE;
      queueSearchResultsRefresh();
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
      toast('Activities marked read');
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
      if (nav === 'share-root') {
        window.location.assign('/share');
        return;
      }
      if (nav !== 'members' && railTab === 'members') rememberMembersLayoutFromCurrent();
      if (nav === 'chat') {
        railTab = 'spaces';
        activeView = 'space';
        mobileHomeOpen = false;
        selectedSpaceType = selectedSpaceType || 'channel';
        selectedSpaceId = selectedSpaceId || appState?.channels?.[0]?.id || 'chan_all';
        selectedAgentId = null;
        selectedHumanId = null;
        selectedComputerId = null;
        workspaceActivityDrawerOpen = false;
      } else if (nav === 'search') {
        railTab = 'spaces';
        openSearchView();
        localStorage.setItem('railTab', railTab);
        syncBrowserRouteForActiveView();
        refreshPackageVersionReminders();
        return;
      } else if (nav === 'tasks') {
        railTab = 'spaces';
        activeView = 'tasks';
        mobileHomeOpen = false;
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
        mobileHomeOpen = false;
        selectedAgentId = null;
        selectedHumanId = null;
        selectedComputerId = null;
        workspaceActivityDrawerOpen = false;
      }
      localStorage.setItem('railTab', railTab);
      selectedTaskId = null;
      render();
      syncBrowserRouteForActiveView();
      refreshPackageVersionReminders();
    }
    if (action === 'select-agent') {
      if (!installedRuntimes.length) await loadInstalledRuntimes();
      if (threadMessageId) inspectorReturnThreadId = threadMessageId;
      selectedAgentId = target.dataset.id;
      mobileHomeOpen = false;
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
      mobileHomeOpen = false;
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
      mobileHomeOpen = false;
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
      mobileHomeOpen = false;
      selectedAgentId = null;
      selectedHumanId = null;
      humanDescriptionEditState = { humanId: null };
      clearComputerNameFieldDraft();
      computerNameEditState = { computerId: null };
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
      refreshPackageVersionReminders();
    }
    if (action === 'edit-computer-name') {
      clearComputerNameFieldDraft();
      computerNameEditState = { computerId: target.dataset.id || selectedComputerId };
      render();
    }
    if (action === 'cancel-computer-name') {
      clearComputerNameFieldDraft();
      computerNameEditState = { computerId: null };
      render();
    }
    if (action === 'close-agent-detail') {
      if (activeView === 'members') {
        selectedAgentId = null;
        agentDetailEditState = { field: null };
        agentEnvEditState = null;
        selectedAgentWorkspaceFile = null;
        if (typeof isMobileViewport === 'function' && isMobileViewport()) {
          membersLayout = normalizeMembersLayout({ mode: 'directory' });
          render();
          syncBrowserRouteForActiveView();
          return;
        }
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
      refreshThreadSelection(threadMessageId, { loadReplies: Boolean(threadMessageId) });
    }
    if (action === 'close-human-detail') {
      if (activeView === 'members') {
        selectedHumanId = null;
        humanDescriptionEditState = { humanId: null };
        if (typeof isMobileViewport === 'function' && isMobileViewport()) {
          membersLayout = normalizeMembersLayout({ mode: 'directory' });
          render();
          syncBrowserRouteForActiveView();
          return;
        }
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
      refreshThreadSelection(threadMessageId, { loadReplies: Boolean(threadMessageId) });
    }
    if (action === 'set-agent-detail-tab') {
      await switchAgentDetailTab(selectedAgentId, target.dataset.tab || 'profile');
      return;
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
        mobileHomeOpen = false;
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
        mobileHomeOpen = false;
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
      mobileHomeOpen = false;
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
      mobileHomeOpen = false;
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
      setTaskViewModeForScope(target.dataset.view);
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
      refreshThreadSelection(threadMessageId, { loadReplies: Boolean(threadMessageId) });
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
        const pairingCommand = await generateFreshComputerPairingCommand({ name: defaultComputerPairingName() });
        if (modal !== 'computer') {
          await discardProvisionalPairingComputer(pairingCommand);
          return;
        }
        render();
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
      markAgentRestartStarting(agentRestartState.agentId);
      await api(`/api/agents/${agentRestartState.agentId}/restart`, {
        method: 'POST',
        body: JSON.stringify({ mode: agentRestartState.mode || 'restart' }),
      });
      agentRestartState = { agentId: null, mode: 'restart' };
      modal = null;
      toast('Agent restart requested');
    }
    if (action === 'confirm-daemon-upgrade') {
      const computerId = daemonUpgradeConfirmState?.computerId || '';
      if (!computerId) return;
      const computer = byId(appState.computers, computerId) || {};
      const packageLabel = typeof computerPackageLabel === 'function' ? computerPackageLabel(computer) : 'Daemon';
      selectedComputerId = computerId;
      activeView = 'computers';
      railTab = 'computers';
      daemonUpgradeConfirmState = { computerId: null };
      modal = null;
      render();
      const result = await api(`/api/computers/${encodeURIComponent(computerId)}/daemon-upgrade`, {
        method: 'POST',
        body: JSON.stringify({
          packageName: computerPackageName(computer),
          targetVersion: computerPackageLatestVersion(computer),
        }),
      });
      if (result?.computer) {
        const existing = byId(appState.computers, result.computer.id);
        if (existing) Object.assign(existing, result.computer);
      }
      await refreshState().catch(() => {});
      render();
      toast(`${packageLabel} upgrade queued`);
    }
    if (action === 'confirm-computer-close') {
      const computerId = computerCloseConfirmState?.computerId || '';
      if (!computerId) throw new Error('Computer is missing.');
      selectedComputerId = computerId;
      activeView = 'computers';
      railTab = 'computers';
      computerCloseConfirmState = { computerId: null };
      modal = null;
      render();
      const result = await api(`/api/computers/${encodeURIComponent(computerId)}/close`, {
        method: 'POST',
        body: JSON.stringify({
          stopAgents: true,
          disableBackground: true,
        }),
      });
      if (result?.computer) {
        const existing = byId(appState.computers, result.computer.id);
        if (existing) Object.assign(existing, result.computer);
      }
      await refreshState().catch(() => {});
      renderShellOrModal();
      toast('Computer close requested');
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
        if (modal === 'attachment-preview') {
          attachmentPreviewState = { attachmentId: null, loading: false, content: '', error: '' };
        }
        if (modal === 'external-import-context') {
          externalImportContextState = { recordId: null };
        }
        if (modal === 'agent-start') {
          agentStartState = { agentId: null };
        }
        if (modal === 'agent-restart') {
          agentRestartState = { agentId: null, mode: 'restart' };
        }
        if (modal === 'daemon-upgrade-confirm') {
          daemonUpgradeConfirmState = { computerId: null };
        }
        if (modal === 'computer-close-confirm') {
          computerCloseConfirmState = { computerId: null };
        }
        if (modal === 'join-link-revoke-confirm') {
          joinLinkRevokeConfirmState = { joinLinkId: null };
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
          await discardProvisionalPairingComputer(latestPairingCommand);
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
    if (action === 'open-attachment-preview') {
      await openAttachmentPreview(target.dataset.id);
    }
    if (action === 'open-thread') {
      threadMessageId = target.dataset.id;
      mobileHomeOpen = false;
      workspaceActivityDrawerOpen = false;
      inspectorReturnThreadId = null;
      selectedSavedRecordId = null;
      selectedAgentId = null;
      selectedTaskId = null;
      selectedProjectFile = null;
      markThreadRead(threadMessageId);
      requestComposerFocus(composerIdFor('thread', threadMessageId));
      render();
      refreshThreadSelection(threadMessageId);
      scrollToMessage(threadMessageId);
    }
    if (action === 'open-search-result') {
      const record = conversationRecord(target.dataset.id);
      if (record) openSearchResult(record);
    }
    if (action === 'open-search-entity') {
      openSearchEntity(target.dataset.targetType, target.dataset.targetId);
    }
    if (action === 'open-search-channel-path') {
      await openSearchChannelPath({
        serverSlug: target.dataset.serverSlug,
        channelId: target.dataset.channelId,
      });
    }
    if (action === 'close-thread') {
      threadMessageId = null;
      selectedSavedRecordId = null;
      render();
      refreshThreadSelection(null, { loadReplies: false });
    }
    if (action === 'view-in-channel') {
      const message = byId(appState.messages, target.dataset.id);
      if (message) {
        persistVisiblePaneScrolls();
        selectedSpaceType = message.spaceType;
        selectedSpaceId = message.spaceId;
        activeView = 'space';
        mobileHomeOpen = false;
        activeTab = 'chat';
        threadMessageId = message.id;
        workspaceActivityDrawerOpen = false;
        selectedTaskId = null;
        markThreadRead(message.id);
        render();
        refreshThreadSelection(message.id);
        scrollToMessage(message.id);
      }
    }
	    if (action === 'back-to-bottom') {
	      const targetPane = target.dataset.target === 'thread' ? '#thread-context' : '#message-list';
	      scrollPaneToBottom(targetPane);
	    }
	    if (action === 'jump-to-reference-source') {
	      if (typeof jumpToConversationReferenceSource === 'function') {
	        jumpToConversationReferenceSource(target.dataset.sourceRecordId, target.dataset.parentMessageId, {
	          spaceType: target.dataset.sourceSpaceType,
	          spaceId: target.dataset.sourceSpaceId,
	          sourceKind: target.dataset.sourceKind,
	        }).catch((error) => {
	          console.warn('Failed to jump to conversation reference source:', error);
	        });
	      }
	    }
	    if (action === 'remove-composer-reference') {
	      if (typeof removeComposerReference === 'function') {
	        removeComposerReference(target.dataset.composerId, target.dataset.referenceId);
	      }
	    }
	    if (action === 'remove-staged-attachment') {
	      removeStagedAttachment(target.dataset.composerId, target.dataset.id);
	    }
    if (action === 'pick-project-folder') {
      if (!(typeof localProjectFoldersEnabled === 'function' && localProjectFoldersEnabled())) {
        toast('Project folders are temporarily disabled');
        return;
      }
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
      if (!(typeof localProjectFoldersEnabled === 'function' && localProjectFoldersEnabled())) return;
      await toggleProjectTree(target.dataset.projectId, target.dataset.path || '');
    }
    if (action === 'open-project-file') {
      if (!(typeof localProjectFoldersEnabled === 'function' && localProjectFoldersEnabled())) return;
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
      renderAgentWorkspaceUpdate(selectedAgentId);
    }
    if (action === 'close-agent-workspace-file') {
      selectedAgentWorkspaceFile = null;
      renderAgentWorkspaceUpdate(selectedAgentId);
    }
    if (action === 'confirm-avatar-crop') {
      await confirmAvatarCropSelection();
      return;
    }
    if (action === 'remove-project') {
      if (!(typeof localProjectFoldersEnabled === 'function' && localProjectFoldersEnabled())) return;
      clearProjectCaches(target.dataset.id);
      await api(`/api/projects/${target.dataset.id}`, { method: 'DELETE' });
      toast('Project folder removed');
    }
    if (action === 'save-message') {
      messageContextMenu = null;
      await api(`/api/messages/${target.dataset.id}/save`, { method: 'POST', body: '{}' });
    }
    if (action === 'remove-saved-message') {
      messageContextMenu = null;
      await api(`/api/messages/${target.dataset.id}/save`, { method: 'POST', body: '{}' });
      if (selectedSavedRecordId === target.dataset.id) {
        selectedSavedRecordId = null;
        threadMessageId = null;
      }
      toast('Removed from saved');
    }
    if (action === 'toggle-message-reaction') {
      const reactionKey = target.dataset.reactionKey || '';
      if (!MAGCLAW_MESSAGE_REACTION_KEYS.has(reactionKey)) throw new Error('Reaction is not supported.');
      messageContextMenu = null;
      const result = await api(`/api/messages/${encodeURIComponent(target.dataset.id)}/reactions`, {
        method: 'POST',
        body: JSON.stringify({ key: reactionKey }),
      });
      if (result?.message?.id) {
        if (result.message.parentMessageId) {
          appState.replies = upsertConversationRecord(appState.replies, result.message);
        } else {
          appState.messages = upsertConversationRecord(appState.messages, result.message);
        }
      }
      render();
    }
    if (action === 'toggle-thread-follow') {
      messageContextMenu = null;
      const result = await api(`/api/messages/${encodeURIComponent(target.dataset.id)}/follow`, {
        method: 'POST',
        body: '{}',
      });
      toast(result.followed ? 'Thread followed' : 'Thread unfollowed');
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
          mobileHomeOpen = false;
          render();
          refreshThreadSelection(threadRoot.id);
        } else {
          selectedSpaceType = record.spaceType;
          selectedSpaceId = record.spaceId;
          activeView = 'space';
          mobileHomeOpen = false;
          activeTab = 'chat';
          threadMessageId = null;
          render();
          refreshThreadSelection(null, { loadReplies: false });
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
      const result = await api(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: nextStatus }),
      });
      if (applySubmittedConversationResult(result)) skipFinalRefresh = true;
      toast(`Task moved to ${taskStatusLabel(nextStatus)}`);
    }
    if (action === 'message-task') {
      messageContextMenu = null;
      const result = await api(`/api/messages/${target.dataset.id}/task`, { method: 'POST', body: '{}' });
      if (applySubmittedConversationResult(result)) skipFinalRefresh = true;
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
    if (action === 'upgrade-computer-daemon') {
      const computerId = target.dataset.id || '';
      if (!computerId) return;
      if (target.dataset.upgradeDisabledReason) {
        toast(target.dataset.upgradeDisabledReason);
        return;
      }
      selectedComputerId = computerId;
      activeView = 'computers';
      railTab = 'computers';
      daemonUpgradeConfirmState = { computerId };
      modal = 'daemon-upgrade-confirm';
      render();
    }
    if (action === 'open-computer-close-confirm') {
      const computerId = target.dataset.id || '';
      if (!computerId) return;
      selectedComputerId = computerId;
      activeView = 'computers';
      railTab = 'computers';
      computerCloseConfirmState = { computerId };
      modal = 'computer-close-confirm';
      render();
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
      const joinLinkId = target.dataset.id || '';
      if (!joinLinkId) return;
      joinLinkRevokeConfirmState = { joinLinkId };
      modal = 'join-link-revoke-confirm';
      renderShellOrModal();
    }
    if (action === 'open-account-settings') {
      railTab = 'settings';
      activeView = 'cloud';
      settingsTab = 'account';
      mobileHomeOpen = false;
      selectedAgentId = null;
      selectedHumanId = null;
      selectedComputerId = null;
      workspaceActivityDrawerOpen = false;
      localStorage.setItem('railTab', railTab);
      render();
      syncBrowserRouteForActiveView();
      refreshPackageVersionReminders();
    }
    if (action === 'confirm-revoke-join-link') {
      const joinLinkId = joinLinkRevokeConfirmState?.joinLinkId || '';
      if (!joinLinkId) throw new Error('Join link is missing.');
      await api(`/api/cloud/join-links/${encodeURIComponent(joinLinkId)}/revoke`, { method: 'POST', body: '{}' });
      joinLinkRevokeConfirmState = { joinLinkId: null };
      modal = null;
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
      if (action === 'promote-cloud-member-role') {
        const roleForm = target.closest('[data-server-admin-promote-form]');
        const memberId = roleForm?.querySelector('[data-server-admin-promote-select]')?.value || '';
        const role = roleForm?.querySelector('[data-server-admin-promote-role]')?.value || '';
        if (!memberId || !role) throw new Error('Member role is missing.');
        await api(`/api/cloud/members/${encodeURIComponent(memberId)}`, {
          method: 'PATCH',
          body: JSON.stringify({ role }),
        });
        memberManageState = { memberId: null };
        modal = null;
        settingsTab = 'server';
        activeView = 'cloud';
        syncBrowserRouteForActiveView();
        toast('Member role updated');
      }
      if (action === 'update-cloud-member-role') {
        const roleForm = target.closest('[data-member-role-form]') || target.closest('.member-manage-role-form') || document.querySelector('.member-manage-role-form');
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
        const context = roleForm?.dataset?.memberRoleContext || 'modal';
        if (context === 'server') {
          memberManageState = { memberId: null };
          modal = null;
          settingsTab = 'server';
          activeView = 'cloud';
        } else if (context === 'human') {
          memberManageState = { memberId: null };
          modal = null;
          activeView = 'members';
          const humanId = roleForm?.dataset?.humanId || target.dataset.humanId || '';
          if (humanId) {
            selectedHumanId = humanId;
            membersLayout = normalizeMembersLayout({ mode: 'human', humanId });
          }
        } else {
          memberManageState = { memberId };
          modal = 'member-manage';
          settingsTab = 'members';
          activeView = 'cloud';
        }
        syncBrowserRouteForActiveView();
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
    if (clickLoadingToken && action !== 'set-agent-detail-tab') {
      await waitForClickLoadingDebugDelay();
    }
    if (!localOnlyActions.has(action) && !skipFinalRefresh) {
      await refreshStateOrAuthGate().catch(() => {});
    }
    finishClickLoading(clickLoadingToken, target);
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
