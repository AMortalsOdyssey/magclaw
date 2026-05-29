function spaceTasks(spaceType = selectedSpaceType, spaceId = selectedSpaceId) {
  return (appState?.tasks || [])
    .filter((task) => task.spaceType === spaceType && task.spaceId === spaceId)
    .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
}

function isVisibleChannelTask(task) {
  return task?.spaceType === 'channel';
}

function taskMatchesChannelFilter(task) {
  return !taskChannelFilterIds.length || taskChannelFilterIds.includes(task.spaceId);
}

function taskCountLabel(total, filtered) {
  return filtered === total ? `${total} channel tasks` : `${filtered} of ${total} channel tasks`;
}

function sortTasks(tasks) {
  return [...tasks].sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
}

function threadReplies(messageId) {
  return (appState?.replies || [])
    .filter((reply) => reply.parentMessageId === messageId)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

function threadUpdatedAt(message) {
  const replies = threadReplies(message.id);
  const lastReply = replies.at(-1);
  return new Date(lastReply?.createdAt || message.updatedAt || message.createdAt || 0).getTime();
}

function threadPreviewRecord(message) {
  if (!message) return null;
  return threadReplies(message.id).at(-1) || message;
}

function threadPreviewText(message) {
  const previewRecord = threadPreviewRecord(message);
  if (!previewRecord) return '';
  const lastReplyAuthor = displayName(previewRecord.authorId);
  const previewBody = plainMentionText(previewRecord.body).slice(0, 140) || '(attachment)';
  const replyCount = Number(message?.replyCount || 0);
  return `${lastReplyAuthor}：${previewBody} · ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`;
}

function currentHumanId(stateSnapshot = appState) {
  return stateSnapshot?.cloud?.auth?.currentMember?.humanId || 'hum_local';
}

function recordUpdatedAt(record) {
  return new Date(record?.updatedAt || record?.createdAt || 0).getTime();
}

function recordUnreadForHuman(record, humanId = currentHumanId()) {
  if (!record?.id || record.authorType !== 'agent') return false;
  return !(Array.isArray(record.readBy) ? record.readBy : []).map(String).includes(String(humanId));
}

function spaceUnreadKey(spaceType, spaceId) {
  return `${spaceType || 'channel'}:${spaceId || ''}`;
}

function recordSpaceKey(record, stateSnapshot = appState) {
  if (!record) return '';
  if (record.spaceType && record.spaceId) return spaceUnreadKey(record.spaceType, record.spaceId);
  if (!record.parentMessageId) return '';
  const parent = byId(stateSnapshot?.messages, record.parentMessageId);
  return parent ? spaceUnreadKey(parent.spaceType, parent.spaceId) : '';
}

function buildSpaceUnreadCounts(humanId = currentHumanId(), stateSnapshot = appState) {
  const counts = new Map();
  const addUnread = (record) => {
    if (!recordUnreadForHuman(record, humanId)) return;
    const key = recordSpaceKey(record, stateSnapshot);
    if (!key) return;
    counts.set(key, (counts.get(key) || 0) + 1);
  };
  (stateSnapshot?.messages || []).forEach(addUnread);
  (stateSnapshot?.replies || []).forEach(addUnread);
  return counts;
}

function unreadCountForSpace(counts, spaceType, spaceId) {
  return counts?.get(spaceUnreadKey(spaceType, spaceId)) || 0;
}

function chatUnreadCountFromSpaces(spaceUnreadCounts) {
  let total = 0;
  for (const [key, count] of spaceUnreadCounts?.entries?.() || []) {
    if (key.startsWith('channel:') || key.startsWith('dm:')) total += Number(count || 0);
  }
  return total;
}

function spaceUnreadRecordIds(spaceType, spaceId, humanId = currentHumanId()) {
  const key = spaceUnreadKey(spaceType, spaceId);
  const ids = [];
  for (const record of appState?.messages || []) {
    if (recordSpaceKey(record) === key && recordUnreadForHuman(record, humanId)) ids.push(record.id);
  }
  for (const record of appState?.replies || []) {
    if (recordSpaceKey(record) === key && recordUnreadForHuman(record, humanId)) ids.push(record.id);
  }
  return ids;
}

function railUnreadSignature(stateSnapshot = appState) {
  const counts = buildSpaceUnreadCounts(currentHumanId(stateSnapshot), stateSnapshot);
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, count]) => `${key}:${count}`)
    .join('|');
}

function threadRecordIds(messageId) {
  const message = byId(appState?.messages, messageId);
  if (!message) return [];
  return [message.id, ...threadReplies(message.id).map((reply) => reply.id)];
}

function threadUnreadRecords(message, humanId = currentHumanId()) {
  if (!message) return [];
  return [message, ...threadReplies(message.id)].filter((record) => recordUnreadForHuman(record, humanId));
}

function markRecordsReadLocally(recordIds = [], humanId = currentHumanId()) {
  const ids = new Set((recordIds || []).map(String).filter(Boolean));
  if (!ids.size || !appState) return;
  for (const collection of [appState.messages || [], appState.replies || []]) {
    for (const record of collection) {
      if (!ids.has(record?.id)) continue;
      const readBy = new Set((record.readBy || []).map(String));
      readBy.add(String(humanId));
      record.readBy = [...readBy];
    }
  }
}

function workspaceActivityReadAt(humanId = currentHumanId()) {
  return readStoredWorkspaceActivityReadAt(humanId)
    || appState?.inboxReads?.[humanId]?.workspaceActivityReadAt
    || '';
}

function setWorkspaceActivityReadAtLocally(value, humanId = currentHumanId()) {
  if (!appState || !value) return;
  writeStoredWorkspaceActivityReadAt(humanId, value);
  appState.inboxReads = appState.inboxReads && typeof appState.inboxReads === 'object' ? appState.inboxReads : {};
  appState.inboxReads[humanId] = {
    ...(appState.inboxReads[humanId] || {}),
    workspaceActivityReadAt: value,
  };
}

function unreadRecordIdsForThread(messageId, humanId = currentHumanId()) {
  return threadRecordIds(messageId)
    .filter((id) => recordUnreadForHuman(conversationRecord(id), humanId));
}

async function markInboxRead({
  recordIds = [],
  workspaceActivityReadAt: activityReadAt = null,
  spaceType = '',
  spaceId = '',
  threadMessageId = '',
} = {}) {
  const humanId = currentHumanId();
  const ids = [...new Set((recordIds || []).map(String).filter(Boolean))];
  markRecordsReadLocally(ids, humanId);
  if (activityReadAt) setWorkspaceActivityReadAtLocally(activityReadAt, humanId);
  const body = {
    recordIds: ids,
  };
  if (spaceType && spaceId) {
    body.spaceType = spaceType;
    body.spaceId = spaceId;
  }
  if (threadMessageId) body.threadMessageId = threadMessageId;
  if (activityReadAt) body.workspaceActivityReadAt = activityReadAt;
  if (!ids.length && !body.spaceId && !body.threadMessageId && !activityReadAt) return null;
  return api('/api/inbox/read', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

function markThreadRead(messageId, { forceScope = true } = {}) {
  const recordIds = forceScope ? threadRecordIds(messageId) : unreadRecordIdsForThread(messageId);
  if (!recordIds.length && !forceScope) return;
  markInboxRead({ recordIds, threadMessageId: messageId }).catch((error) => toast(error.message));
}

function markConversationRecordRead(record) {
  if (!record) return;
  const root = record.parentMessageId ? byId(appState?.messages, record.parentMessageId) : record;
  const isThread = Boolean(root && (root.replyCount > 0 || root.taskId || record.parentMessageId));
  const recordIds = isThread
    ? threadRecordIds(root.id)
    : [record.id];
  markInboxRead({ recordIds, threadMessageId: isThread ? root.id : '' }).catch((error) => toast(error.message));
}

function markSpaceRead(spaceType, spaceId, { forceScope = true } = {}) {
  const recordIds = spaceUnreadRecordIds(spaceType, spaceId);
  if (!recordIds.length && !forceScope) return;
  markInboxRead({ recordIds, spaceType, spaceId }).catch((error) => toast(error.message));
}

function markVisibleConversationRead() {
  if (modal || activeView !== 'space' || activeTab !== 'chat') return;
  if (threadMessageId) {
    markThreadRead(threadMessageId, { forceScope: false });
    return;
  }
  if (selectedSpaceType && selectedSpaceId) {
    markSpaceRead(selectedSpaceType, selectedSpaceId, { forceScope: false });
  }
}

function taskThreadMessage(task) {
  return byId(appState?.messages, task?.threadMessageId || task?.messageId);
}

function taskTone(status) {
  if (status === 'done') return 'green';
  if (status === 'in_review') return 'amber';
  if (status === 'in_progress') return 'cyan';
  return 'blue';
}

function agentIsWarming(agent) {
  const activity = agent?.runtimeActivity || {};
  const status = String(agent?.status || '').toLowerCase();
  const mode = String(activity.mode || '').toLowerCase();
  const detail = String(activity.detail || '').toLowerCase();
  return status === 'warming'
    || status === 'warmup'
    || status === 'warming-up'
    || status === 'warming_up'
    || (status === 'thinking' && (activity.warmup === true || mode === 'warmup' || detail.includes('hidden warmup')));
}

function agentIsStandby(agent) {
  const status = String(agent?.status || '').toLowerCase();
  return status === 'idle'
    && typeof agentHasWarmRuntimeSession === 'function'
    && agentHasWarmRuntimeSession(agent);
}

function agentDisplayStatus(agent, stateSnapshot = appState) {
  if (!agent) return 'offline';
  if (agent.deletedAt || agent.archivedAt) return 'deleted';
  const computer = agent.computerId ? byId(stateSnapshot?.computers, agent.computerId) : null;
  if (computer && typeof computerIsDisabled === 'function' && computerIsDisabled(computer)) return 'disabled';
  if (computer?.deletedAt || computer?.archivedAt) return 'deleted';
  if (agentIsWarming(agent)) return 'warming';
  if (computer && agent.computerId !== 'cmp_local' && typeof computerIsConnected === 'function' && !computerIsConnected(computer)) {
    const status = String(agent?.status || '').toLowerCase();
    if (typeof computerUpgradeBlocksAgentDelivery === 'function' && computerUpgradeBlocksAgentDelivery(computer)) return 'waiting_for_upgrade';
    if (!['waiting_for_computer', 'waiting_for_upgrade', 'queued', 'starting', 'thinking', 'working', 'running', 'busy', 'warming', 'error'].includes(status)) return 'offline';
  }
  if (agentIsStandby(agent)) return 'standby';
  return agent?.status || 'offline';
}

function actorStatusRenderKey(authorId, authorType, stateSnapshot = appState) {
  if (authorType !== 'agent') return '';
  const agent = byId(stateSnapshot?.agents, authorId);
  return agent ? agentDisplayStatus(agent, stateSnapshot) : 'offline';
}

function presenceTone(status) {
  const value = String(status || '').toLowerCase();
  if (value === 'warming') return 'warming';
  if (value === 'standby') return 'standby';
  if (value === 'idle') return 'idle';
  if (value === 'disabled') return 'disabled';
  if (value === 'deleted') return 'disabled';
  if (['working', 'running', 'starting', 'thinking', 'busy'].includes(value)) return 'busy';
  if (['restarting'].includes(value)) return 'busy';
  if (['upgrade_pending', 'upgrading', 'waiting_for_upgrade'].includes(value)) return 'crystal';
  if (['queued', 'pending', 'waiting_for_computer'].includes(value)) return 'queued';
  if (['error', 'failed'].includes(value)) return 'error';
  if (['online', 'connected'].includes(value)) return 'online';
  return 'offline';
}

function presenceClass(status) {
  return `status-${presenceTone(status)}`;
}

function avatarStatusDot(status, label = 'Status') {
  const value = status || 'offline';
  return `<span class="avatar-status-dot ${presenceClass(value)}" title="${escapeHtml(value)}" aria-label="${escapeHtml(label)}: ${escapeHtml(value)}"></span>`;
}

function agentStatusDot(authorId, authorType) {
  if (authorType !== 'agent') return '';
  const agent = byId(appState?.agents, authorId);
  return avatarStatusDot(agent ? agentDisplayStatus(agent) : 'offline', 'Agent status');
}

function humanStatusDot(authorId, authorType) {
  if (authorType !== 'human') return '';
  const human = typeof humanByIdAny === 'function' ? humanByIdAny(authorId) : byId(appState?.humans, authorId);
  return avatarStatusDot(human?.status || 'offline', 'Human status');
}

function fallbackAttachmentPreviewKind(attachment = {}) {
  const type = String(attachment.type || '').toLowerCase();
  const name = String(attachment.name || '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type === 'video/mp4' || name.endsWith('.mp4')) return 'video';
  if (type === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (type === 'text/markdown' || type === 'text/x-markdown' || name.endsWith('.md') || name.endsWith('.markdown')) return 'markdown';
  if (type === 'text/html' || name.endsWith('.html') || name.endsWith('.htm')) return 'html';
  return 'file';
}

function attachmentPreviewIcon(item = {}, variant = 'message') {
  const kind = typeof attachmentPreviewKind === 'function'
    ? attachmentPreviewKind(item)
    : fallbackAttachmentPreviewKind(item);
  const baseClass = variant === 'composer' ? 'composer-file-icon' : 'file-glyph';
  if (kind === 'markdown') {
    return `
      <span class="${baseClass} markdown-file-icon" role="img" aria-label="${escapeHtml(t('Markdown file'))}">
        <span class="markdown-file-icon-letter">M</span>
        <span class="markdown-file-icon-arrow" aria-hidden="true"></span>
      </span>
    `;
  }
  if (kind === 'pdf') return `<span class="${baseClass}">PDF</span>`;
  if (kind === 'video') return `<span class="${baseClass}">MP4</span>`;
  if (kind === 'html') return `<span class="${baseClass}">HTML</span>`;
  return `<span class="${baseClass}">FILE</span>`;
}

function attachmentLinks(ids = []) {
  const items = ids
    .map((id) => byId(appState?.attachments, id))
    .filter(Boolean)
    .map((item) => {
      const isImage = String(item.type || '').startsWith('image/');
      const url = item.url || '#';
      return `
        <button class="message-attachment-preview ${isImage ? 'image-attachment' : 'file-attachment'}" type="button" data-action="open-attachment-preview" data-id="${escapeHtml(item.id)}">
          ${isImage
            ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(item.name)}" loading="lazy" />`
            : attachmentPreviewIcon(item)}
          <span class="message-attachment-meta">
            <strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong>
            <small>${escapeHtml(item.type || 'file')} · ${bytes(item.bytes)}</small>
          </span>
        </button>
      `;
    });
  return items.length ? `<div class="message-attachment-list">${items.join('')}</div>` : '';
}

function composerIdFor(kind, id = '') {
  if (kind === 'thread') return `thread:${id || threadMessageId || 'none'}`;
  return `message:${selectedSpaceType}:${selectedSpaceId}`;
}

function stagedFor(composerId) {
  return stagedByComposer[composerId] || { attachments: [], ids: [] };
}

function pendingAttachmentUploadCount(composerId) {
  return (pendingAttachmentUploadsByComposer[composerId] || []).length;
}

function updateComposerUploadState(composerId) {
  const form = document.querySelector(`form[data-composer-id="${CSS.escape(composerId || '')}"]`);
  if (form) form.classList.toggle('is-uploading-attachments', pendingAttachmentUploadCount(composerId) > 0);
  updateComposerAttachmentStrip(composerId);
}

function trackComposerAttachmentUpload(composerId, promise) {
  if (!composerId || !promise) return Promise.resolve(promise);
  pendingAttachmentUploadsByComposer[composerId] = pendingAttachmentUploadsByComposer[composerId] || [];
  const tracked = Promise.resolve(promise).finally(() => {
    const pending = pendingAttachmentUploadsByComposer[composerId] || [];
    pendingAttachmentUploadsByComposer[composerId] = pending.filter((item) => item !== tracked);
    if (!pendingAttachmentUploadsByComposer[composerId].length) delete pendingAttachmentUploadsByComposer[composerId];
    updateComposerUploadState(composerId);
  });
  pendingAttachmentUploadsByComposer[composerId].push(tracked);
  updateComposerUploadState(composerId);
  return tracked;
}

async function waitForComposerAttachments(composerId) {
  const pending = [...(pendingAttachmentUploadsByComposer[composerId] || [])];
  if (!pending.length) return;
  const results = await Promise.allSettled(pending);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw new Error(failed.reason?.message || 'Attachment upload failed. Please retry before sending.');
  if ((pendingAttachmentUploadsByComposer[composerId] || []).length) {
    await waitForComposerAttachments(composerId);
  }
}

function setStagedFor(composerId, attachments) {
  const unique = [];
  const seen = new Set();
  for (const item of attachments) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    unique.push(item);
  }
  stagedByComposer[composerId] = {
    attachments: unique,
    ids: unique.map((item) => item.id),
  };
}

function clearStagedFor(composerId) {
  delete stagedByComposer[composerId];
}

function renderAttachmentStrip(composerId) {
  const staged = stagedFor(composerId).attachments;
  const uploading = Array.from({ length: pendingAttachmentUploadCount(composerId) }, (_, index) => `
    <span class="composer-attachment-chip is-uploading" data-attachment-uploading="${index + 1}">
      <span class="composer-file-icon">IMG</span>
      <span class="composer-attachment-meta">
        <strong>Uploading attachment...</strong>
        <small>Please wait before sending</small>
      </span>
      <span></span>
    </span>
  `);
  return [...uploading, ...staged.map((item) => {
    const isImage = String(item.type || '').startsWith('image/');
    const isMarkdown = typeof attachmentPreviewKind === 'function' && attachmentPreviewKind(item) === 'markdown';
    return `
      <span class="composer-attachment-chip ${isImage ? 'is-image' : ''} ${isMarkdown ? 'is-markdown' : ''}" data-attachment-id="${escapeHtml(item.id)}">
        <button class="composer-attachment-preview-btn" type="button" data-action="open-attachment-preview" data-id="${escapeHtml(item.id)}" title="Preview ${escapeHtml(item.name)}" aria-label="Preview ${escapeHtml(item.name)}">
          ${isImage
            ? `<img src="${escapeHtml(item.url)}" alt="${escapeHtml(item.name)}" />`
            : attachmentPreviewIcon(item, 'composer')}
          <span class="composer-attachment-meta">
            <strong title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</strong>
            <small>${escapeHtml(item.type || 'file')} · ${bytes(item.bytes)}</small>
          </span>
        </button>
        <button class="composer-attachment-remove" type="button" data-action="remove-staged-attachment" data-composer-id="${escapeHtml(composerId)}" data-id="${escapeHtml(item.id)}" title="Remove attachment" aria-label="Remove ${escapeHtml(item.name)}">&times;</button>
      </span>
    `;
  })].join('');
}

function updateComposerAttachmentStrip(composerId) {
  const strip = document.querySelector(`[data-attachment-strip="${CSS.escape(composerId)}"]`);
  if (!strip) return;
  const hasAttachments = stagedFor(composerId).attachments.length > 0 || pendingAttachmentUploadCount(composerId) > 0;
  strip.innerHTML = renderAttachmentStrip(composerId);
  strip.classList.toggle('hidden', !hasAttachments);
}

function autosizeComposerTextarea(textarea) {
  if (!textarea?.matches?.('textarea[data-composer-autosize]')) return false;
  const maxHeight = Number(textarea.dataset.maxHeight || 220);
  const minHeight = Number(textarea.dataset.minHeight || 42);
  textarea.style.height = 'auto';
  const nextHeight = Math.max(minHeight, Math.min(textarea.scrollHeight || minHeight, maxHeight));
  textarea.style.height = `${nextHeight}px`;
  textarea.style.overflowY = (textarea.scrollHeight || 0) > maxHeight ? 'auto' : 'hidden';
  return true;
}

function autosizeAllComposerTextareas(rootNode = document) {
  rootNode.querySelectorAll?.('textarea[data-composer-autosize]').forEach((textarea) => autosizeComposerTextarea(textarea));
}

function maybeAutosizeComposerTextarea(textarea) {
  if (typeof autosizeComposerTextarea === 'function') autosizeComposerTextarea(textarea);
}

function maybeAutosizeAllComposerTextareas(rootNode = document) {
  if (typeof autosizeAllComposerTextareas === 'function') autosizeAllComposerTextareas(rootNode);
}

function removeStagedAttachment(composerId, attachmentId) {
  const next = stagedFor(composerId).attachments.filter((item) => item.id !== attachmentId);
  setStagedFor(composerId, next);
  updateComposerAttachmentStrip(composerId);
}

function snapshotComposerState(form, composerId, { includeTask = false } = {}) {
  const textarea = form?.querySelector('textarea[name="body"]');
  const taskInput = form?.querySelector('input[name="asTask"]');
	  return {
	    body: textarea?.value ?? composerDrafts[composerId] ?? '',
	    attachments: [...stagedFor(composerId).attachments],
	    references: typeof outgoingComposerReferences === 'function' ? outgoingComposerReferences(composerId) : [],
	    mentionMap: { ...(composerMentionMaps[composerId] || {}) },
	    task: includeTask ? Boolean(taskInput?.checked || composerTaskFlags[composerId]) : false,
	  };
}

function clearComposerForSubmit(form, composerId, { clearTask = false } = {}) {
  const textarea = form?.querySelector('textarea[name="body"]');
  if (textarea) {
    textarea.value = '';
    textarea.defaultValue = '';
    if (typeof maybeAutosizeComposerTextarea === 'function') maybeAutosizeComposerTextarea(textarea);
  }
  const taskInput = form?.querySelector('input[name="asTask"]');
  if (clearTask && taskInput) taskInput.checked = false;
	  clearStagedFor(composerId);
	  updateComposerAttachmentStrip(composerId);
	  if (typeof clearComposerReferences === 'function') clearComposerReferences(composerId);
	  if (typeof updateComposerReferenceStrip === 'function') updateComposerReferenceStrip(composerId);
	  delete composerDrafts[composerId];
	  delete composerMentionMaps[composerId];
  if (clearTask) delete composerTaskFlags[composerId];
}

function restoreComposerAfterFailedSubmit(form, composerId, snapshot, { restoreTask = false } = {}) {
  const body = snapshot?.body || '';
  if (body) composerDrafts[composerId] = body;
  else delete composerDrafts[composerId];
	  if (snapshot?.attachments?.length) setStagedFor(composerId, snapshot.attachments);
	  else clearStagedFor(composerId);
	  updateComposerAttachmentStrip(composerId);
	  if (typeof setComposerReferences === 'function') setComposerReferences(composerId, snapshot?.references || []);
	  if (typeof updateComposerReferenceStrip === 'function') updateComposerReferenceStrip(composerId);
	  if (snapshot?.mentionMap && Object.keys(snapshot.mentionMap).length) composerMentionMaps[composerId] = snapshot.mentionMap;
  else delete composerMentionMaps[composerId];
  if (restoreTask) composerTaskFlags[composerId] = Boolean(snapshot?.task);
  const textarea = form?.querySelector('textarea[name="body"]');
  if (textarea) {
    textarea.value = body;
    textarea.defaultValue = body;
    if (typeof maybeAutosizeComposerTextarea === 'function') maybeAutosizeComposerTextarea(textarea);
  }
  const taskInput = form?.querySelector('input[name="asTask"]');
  if (restoreTask && taskInput) taskInput.checked = Boolean(snapshot?.task);
}

function paneSelector(targetName) {
  return targetName === 'thread' ? '#thread-context' : '#message-list';
}

function paneKey(targetName) {
  if (targetName === 'thread') return threadMessageId ? `thread:${threadMessageId}` : '';
  return `main:${activeView}:${activeTab}:${selectedSpaceType}:${selectedSpaceId}`;
}

function storedPaneScroll(key) {
  return key ? normalizeStoredPaneScroll(paneScrollPositions[key]) : null;
}

function targetDefaultAtBottom(targetName) {
  return targetName === 'main' || targetName === 'thread';
}

function paneIsAtBottom(node) {
  if (!node) return true;
  return node.scrollHeight - node.scrollTop - node.clientHeight <= BOTTOM_THRESHOLD;
}

function paneScrollSnapshot(targetName) {
  const node = document.querySelector(paneSelector(targetName));
  const key = paneKey(targetName);
  const stored = storedPaneScroll(key);
  if (!node) {
    return {
      key,
      top: stored?.top || 0,
      atBottom: stored ? stored.atBottom : targetDefaultAtBottom(targetName),
      hasPosition: Boolean(stored),
    };
  }
  return {
    key,
    top: node.scrollTop || 0,
    atBottom: paneIsAtBottom(node),
    hasPosition: true,
  };
}

function workspaceActivityScrollSnapshot() {
  const node = document.querySelector('#workspace-activity-list');
  if (!workspaceActivityDrawerOpen || !node) {
    return {
      top: 0,
      atBottom: true,
      hasPosition: false,
    };
  }
  return {
    top: node.scrollTop || 0,
    atBottom: paneIsAtBottom(node),
    hasPosition: true,
  };
}

function persistVisiblePaneScrolls() {
  const main = document.querySelector(paneSelector('main'));
  if (main) persistPaneScroll('main', main);
  const thread = document.querySelector(paneSelector('thread'));
  if (thread) persistPaneScroll('thread', thread);
}

function rememberPinnedBottomBeforeStateChange() {
  for (const targetName of ['main', 'thread']) {
    const node = document.querySelector(paneSelector(targetName));
    if (node && paneIsAtBottom(node)) requestPaneBottomScroll(targetName);
  }
}

function setBackBottomVisible(targetName, visible) {
  backBottomVisible[targetName] = Boolean(visible);
  const button = document.querySelector(`.back-bottom[data-target="${targetName}"]`);
  if (button) button.classList.toggle('hidden', !backBottomVisible[targetName]);
}

function updateBackBottomVisibility(targetName) {
  const node = document.querySelector(paneSelector(targetName));
  const canScroll = Boolean(node && node.scrollHeight > node.clientHeight + BOTTOM_THRESHOLD);
  setBackBottomVisible(targetName, canScroll && !paneIsAtBottom(node));
}

function restorePaneScroll(targetName, snapshot) {
  const node = document.querySelector(paneSelector(targetName));
  if (!node) return;
  const currentKey = paneKey(targetName);
  const stored = storedPaneScroll(currentKey);
  const candidate = snapshot?.key === currentKey
    ? snapshot
    : (stored ? { key: currentKey, ...stored, hasPosition: true } : null);
  const forceBottom = pendingBottomScroll[targetName];
  pendingBottomScroll[targetName] = false;
  const hasPosition = Boolean(candidate?.hasPosition);
  const shouldFollowBottom = forceBottom || (hasPosition ? candidate.atBottom : targetDefaultAtBottom(targetName));
  if (!shouldFollowBottom && hasPosition) {
    const maxTop = Math.max(0, node.scrollHeight - node.clientHeight);
    node.scrollTop = Math.min(Math.max(0, candidate.top || 0), maxTop);
    persistPaneScroll(targetName, node);
  } else {
    node.scrollTop = node.scrollHeight;
    persistPaneScroll(targetName, node);
    window.setTimeout(() => {
      const current = document.querySelector(paneSelector(targetName));
      if (!current) return;
      current.scrollTop = current.scrollHeight;
      persistPaneScroll(targetName, current);
      updateBackBottomVisibility(targetName);
    }, 40);
    window.setTimeout(() => {
      const current = document.querySelector(paneSelector(targetName));
      if (!current) return;
      current.scrollTop = current.scrollHeight;
      persistPaneScroll(targetName, current);
      updateBackBottomVisibility(targetName);
    }, 160);
  }
  updateBackBottomVisibility(targetName);
}

function restorePaneScrolls(snapshot) {
  restorePaneScroll('main', snapshot.main);
  restorePaneScroll('thread', snapshot.thread);
}

function pageScrollSurface() {
  return document.querySelector('[data-page-scroll-surface]');
}

function pageScrollSnapshot() {
  const node = pageScrollSurface();
  if (!node) return { key: '', top: 0, hasPosition: false };
  return {
    key: node.dataset?.scrollKey || '',
    top: node.scrollTop || 0,
    hasPosition: true,
  };
}

function restorePageScroll(snapshot) {
  const node = pageScrollSurface();
  if (!node || !snapshot?.hasPosition || !snapshot.key || node.dataset?.scrollKey !== snapshot.key) return;
  const maxTop = Math.max(0, node.scrollHeight - node.clientHeight);
  node.scrollTop = Math.min(Math.max(0, snapshot.top || 0), maxTop);
}

function railScrollSnapshot() {
  const sections = [...document.querySelectorAll('[data-rail-scroll-section][data-scroll-key]')];
  return sections.map((node) => ({
    key: node.dataset?.scrollKey || '',
    top: node.scrollTop || 0,
    hasPosition: true,
  }));
}

function restoreRailScroll(snapshot) {
  const entries = Array.isArray(snapshot) ? snapshot : [];
  for (const entry of entries) {
    if (!entry?.hasPosition || !entry.key) continue;
    const node = document.querySelector(`[data-rail-scroll-section][data-scroll-key="${CSS.escape(entry.key)}"]`);
    if (!node) continue;
    const maxTop = Math.max(0, node.scrollHeight - node.clientHeight);
    node.scrollTop = Math.min(Math.max(0, entry.top || 0), maxTop);
  }
}

function restoreWorkspaceActivityScroll(snapshot) {
  if (!workspaceActivityDrawerOpen || workspaceActivityScrollToBottom) return;
  const node = document.querySelector('#workspace-activity-list');
  if (!node || !snapshot?.hasPosition) return;
  if (snapshot.atBottom) {
    node.scrollTop = node.scrollHeight;
    return;
  }
  const maxTop = Math.max(0, node.scrollHeight - node.clientHeight);
  node.scrollTop = Math.min(Math.max(0, snapshot.top || 0), maxTop);
}

function requestPaneBottomScroll(targetName) {
  pendingBottomScroll[targetName] = true;
}

function scrollToMessage(messageId) {
  window.setTimeout(() => {
    const node = document.querySelector(`#message-list #message-${CSS.escape(messageId)}`);
    const pane = document.querySelector('#message-list');
    if (node && pane) {
      const targetTop = node.offsetTop - (pane.clientHeight / 2) + (node.offsetHeight / 2);
      pane.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
      updateBackBottomVisibility('main');
      node.classList.add('focus-pulse');
      window.setTimeout(() => node.classList.remove('focus-pulse'), 1200);
    }
  }, 40);
}

function scrollToReply(replyId) {
  window.setTimeout(() => {
    const node = document.querySelector(`#thread-context #reply-${CSS.escape(replyId)}`);
    const pane = document.querySelector('#thread-context');
    if (node && pane) {
      const targetTop = node.offsetTop - (pane.clientHeight / 2) + (node.offsetHeight / 2);
      pane.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
      updateBackBottomVisibility('thread');
      node.classList.add('focus-pulse');
      window.setTimeout(() => node.classList.remove('focus-pulse'), 1200);
    }
  }, 80);
}

function scrollPaneToBottom(selector, behavior = 'smooth') {
  const targetName = selector === '#thread-context' ? 'thread' : 'main';
  const scroll = () => {
    const node = document.querySelector(selector);
    if (node) {
      node.scrollTo({ top: node.scrollHeight, behavior });
      window.setTimeout(() => updateBackBottomVisibility(targetName), behavior === 'smooth' ? 260 : 20);
    }
  };
  window.setTimeout(scroll, 20);
  if (behavior !== 'smooth') window.setTimeout(scroll, 120);
}

function scrollWorkspaceActivityToBottom(behavior = 'auto') {
  const scroll = () => {
    const node = document.querySelector('#workspace-activity-list');
    if (node) node.scrollTo({ top: node.scrollHeight, behavior });
  };
  window.setTimeout(scroll, 20);
  window.setTimeout(scroll, 120);
}

function composerFocusSnapshot() {
  const textarea = document.activeElement;
  if (!textarea?.matches?.('textarea[data-composer-id]')) return null;
  const composerId = textarea.dataset?.composerId || '';
  if (!composerId) return null;
  const value = textarea.value || '';
  const end = value.length;
  const selectionStart = Number.isFinite(textarea.selectionStart) ? textarea.selectionStart : end;
  const selectionEnd = Number.isFinite(textarea.selectionEnd) ? textarea.selectionEnd : selectionStart;
  return {
    composerId,
    value,
    selectionStart,
    selectionEnd,
  };
}

function restoreComposerFocus(snapshot) {
  if (!snapshot?.composerId) return false;
  const textarea = document.querySelector(`textarea[data-composer-id="${CSS.escape(snapshot.composerId)}"]`);
  if (!textarea) return false;
  const value = String(snapshot.value ?? composerDrafts[snapshot.composerId] ?? textarea.value ?? '');
  if (textarea.value !== value) textarea.value = value;
  if (typeof maybeAutosizeComposerTextarea === 'function') maybeAutosizeComposerTextarea(textarea);
  composerDrafts[snapshot.composerId] = value;
  try {
    textarea.focus({ preventScroll: true });
  } catch {
    textarea.focus();
  }
  const max = textarea.value.length;
  const selectionStart = Math.max(0, Math.min(Number(snapshot.selectionStart ?? max), max));
  const selectionEnd = Math.max(0, Math.min(Number(snapshot.selectionEnd ?? selectionStart), max));
  if (typeof textarea.setSelectionRange === 'function') textarea.setSelectionRange(selectionStart, selectionEnd);
  return document.activeElement === textarea;
}

function focusComposerTextarea(composerId) {
  if (!composerId) return false;
  const textarea = document.querySelector(`textarea[data-composer-id="${CSS.escape(composerId)}"]`);
  if (!textarea) return false;
  try {
    textarea.focus({ preventScroll: true });
  } catch {
    textarea.focus();
  }
  const end = textarea.value.length;
  if (typeof maybeAutosizeComposerTextarea === 'function') maybeAutosizeComposerTextarea(textarea);
  textarea.setSelectionRange(end, end);
  return document.activeElement === textarea;
}

function requestComposerFocus(composerId) {
  pendingComposerFocusId = composerId || null;
}

function restorePendingComposerFocus() {
  if (!pendingComposerFocusId) return;
  const composerId = pendingComposerFocusId;
  pendingComposerFocusId = null;
  focusComposerTextarea(composerId);
}

function pill(value, tone = 'blue') {
  return `<span class="pill tone-${tone}">${escapeHtml(value)}</span>`;
}

function toast(message) {
  let node = document.querySelector('.toast');
  if (!node) {
    node = document.createElement('div');
    node.className = 'toast';
    document.body.appendChild(node);
  }
  node.textContent = typeof t === 'function' ? t(message) : message;
  node.classList.add('show');
  window.setTimeout(() => node.classList.remove('show'), 3000);
}

function renderFanoutDecisionToasts() {
  return renderFanoutDecisionToastsHtml(fanoutDecisionCards);
}

function patchFanoutDecisionToasts() {
  const current = document.querySelector('.fanout-toast-stack');
  if (!fanoutDecisionCards.length) {
    if (current) current.remove();
    return;
  }
  const next = htmlToElement(renderFanoutDecisionToasts());
  if (!next) {
    if (current) current.remove();
    return;
  }
  if (current && next) {
    current.replaceWith(next);
    return;
  }
  document.body.appendChild(next);
}

function removeFanoutDecisionCard(id) {
  fanoutDecisionCards = fanoutDecisionCards.filter((card) => card.id !== id);
  patchFanoutDecisionToasts();
}

function dismissFanoutDecisionCard(id) {
  fanoutDecisionCards = fanoutDecisionCards.map((card) => (
    card.id === id ? { ...card, exiting: true } : card
  ));
  patchFanoutDecisionToasts();
  window.setTimeout(() => removeFanoutDecisionCard(id), 220);
}

function addFanoutDecisionCard(card) {
  fanoutDecisionCards = [card];
  patchFanoutDecisionToasts();
  window.setTimeout(() => dismissFanoutDecisionCard(card.id), 5000);
}

function enqueueFanoutDecisionCards(routeEvent, stateSnapshot = appState) {
  if (!routeEvent?.id) return;
  buildFanoutDecisionCards(routeEvent, stateSnapshot)
    .forEach((card, index) => {
      window.setTimeout(() => addFanoutDecisionCard(card), index * 240);
    });
}

function appIsInBackground() {
  return document.visibilityState === 'hidden' || !windowFocused;
}

function agentNotificationRecords(stateSnapshot) {
  return [...(stateSnapshot?.messages || []), ...(stateSnapshot?.replies || [])]
    .filter((record) => record?.id && record.authorType === 'agent')
    .filter((record) => recordShouldNotifyHuman(record, stateSnapshot))
    .sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
}

function notificationRootRecord(record, stateSnapshot = appState) {
  return record?.parentMessageId ? byId(stateSnapshot?.messages, record.parentMessageId) : record;
}

function recordShouldNotifyHuman(record, stateSnapshot = appState, humanId = currentHumanId()) {
  const targetHumanId = String(humanId || '').trim();
  if (!targetHumanId || record?.authorType !== 'agent') return false;
  const root = notificationRootRecord(record, stateSnapshot);
  if ((root?.spaceType || record?.spaceType) === 'dm') return true;
  const mentioned = (record?.mentionedHumanIds || []).map(String).includes(targetHumanId)
    || (root?.mentionedHumanIds || []).map(String).includes(targetHumanId);
  const followedThreadReply = Boolean(
    record?.parentMessageId
    && (root?.followedBy || []).map(String).includes(targetHumanId)
  );
  return mentioned || followedThreadReply;
}

function notificationServerLabel(stateSnapshot = appState) {
  const workspace = stateSnapshot?.cloud?.workspace || {};
  return workspace.name || workspace.slug || workspace.id || 'MagClaw';
}

function notificationSurfaceLabel(record, stateSnapshot = appState) {
  const root = notificationRootRecord(record, stateSnapshot);
  const space = spaceNameFromState(stateSnapshot, root?.spaceType || record?.spaceType, root?.spaceId || record?.spaceId);
  if (record?.parentMessageId) return `Thread in ${space}`;
  if ((root?.spaceType || record?.spaceType) === 'dm') return `DM ${space}`;
  return space;
}

function notificationTitle(record, stateSnapshot = appState) {
  const serverLabel = notificationServerLabel(stateSnapshot);
  return `MagClaw - ${serverLabel}`;
}

function notificationBody(record, stateSnapshot = appState) {
  const text = plainNotificationText(record?.body || '(attachment)', stateSnapshot);
  const preview = text
    ? (text.length > NOTIFICATION_PREVIEW_LIMIT ? `${text.slice(0, NOTIFICATION_PREVIEW_LIMIT - 1)}…` : text)
    : '(attachment)';
  const surfaceLabel = notificationSurfaceLabel(record, stateSnapshot);
  const agentName = displayNameFromState(stateSnapshot, record?.authorId);
  return `[${surfaceLabel}] ${agentName}: ${preview}`;
}

function openNotificationRecord(recordId) {
  const record = conversationRecord(recordId);
  if (!record) return;
  openSearchResult(record);
}

function showAgentNotification(record, stateSnapshot = appState) {
  if (!agentNotificationsEnabled() || serverNotificationsMuted() || !appIsInBackground()) return;
  try {
    const agent = byId(stateSnapshot?.agents, record.authorId);
    const notification = new Notification(notificationTitle(record, stateSnapshot), {
      body: notificationBody(record, stateSnapshot),
      icon: agent?.avatar || NOTIFICATION_ICON,
      badge: NOTIFICATION_ICON,
      tag: `magclaw:${record.id}`,
      data: {
        recordId: record.id,
        serverLabel: notificationServerLabel(stateSnapshot),
        surfaceLabel: notificationSurfaceLabel(record, stateSnapshot),
      },
    });
    notification.onclick = () => {
      window.focus();
      window.setTimeout(() => openNotificationRecord(record.id), 20);
      notification.close();
    };
  } catch {
    // Browser notification failures should not interrupt live chat rendering.
  }
}

function trackAgentNotifications(nextState, { silent = false } = {}) {
  const fresh = [];
  for (const record of agentNotificationRecords(nextState)) {
    if (seenAgentNotificationRecordIds.has(record.id)) continue;
    seenAgentNotificationRecordIds.add(record.id);
    if (!silent) fresh.push(record);
  }
  fresh.slice(-3).forEach((record) => showAgentNotification(record, nextState));
}

function trackFanoutRouteEvents(nextState, { silent = false } = {}) {
  const newLlmEvents = [];
  for (const event of nextState?.routeEvents || []) {
    if (!event?.id || seenFanoutRouteEventIds.has(event.id)) continue;
    seenFanoutRouteEventIds.add(event.id);
    if (!event.llmUsed) continue;
    newLlmEvents.push(event);
  }
  if (!silent && initialLoadComplete && newLlmEvents.length) {
    enqueueFanoutDecisionCards(newLlmEvents.at(-1), nextState);
  }
}

function ensureSelection() {
  if (!appState) return;
  if (!byId(appState.channels, selectedSpaceId) && selectedSpaceType === 'channel') {
    selectedSpaceId = defaultChannelIdFromState();
  }
  if (!byId(appState.dms, selectedSpaceId) && selectedSpaceType === 'dm') {
    selectedSpaceType = 'channel';
    selectedSpaceId = defaultChannelIdFromState();
  }
  if (selectedTaskId && !byId(appState.tasks, selectedTaskId)) {
    selectedTaskId = null;
  }
  if (threadMessageId && !byId(appState.messages, threadMessageId)) {
    threadMessageId = null;
  }
  if (selectedAgentId && !byId(appState.agents, selectedAgentId)) {
    selectedAgentId = null;
    agentDetailEditState = { field: null };
    agentEnvEditState = null;
    selectedAgentWorkspaceFile = null;
  }
  if (selectedHumanId && !(typeof humanByIdAny === 'function' ? humanByIdAny(selectedHumanId) : byId(appState.humans, selectedHumanId))) {
    selectedHumanId = null;
  }
  if (selectedComputerId && !byId(appState.computers, selectedComputerId)) {
    selectedComputerId = null;
  }
  membersLayout = normalizeMembersLayout(membersLayout);
  if (membersLayout.agentId && !byId(appState.agents, membersLayout.agentId)) {
    membersLayout = normalizeMembersLayout({ mode: 'channel' });
  }
  if (membersLayout.humanId && typeof humanByIdAny === 'function' && !humanByIdAny(membersLayout.humanId)) {
    membersLayout = normalizeMembersLayout({ mode: 'channel' });
  }
  if (activeView === 'members' && !selectedAgentId && !selectedHumanId && !(typeof isMobileViewport === 'function' && isMobileViewport())) {
    selectMembersDefault();
  }
}
