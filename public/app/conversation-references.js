const CONVERSATION_REFERENCE_LIMITS_UI = {
  referencesPerMessage: 12,
  selectedTextChars: 4000,
  previewChars: 1200,
  recordsPerReference: 50,
};
const REFERENCE_JUMP_MAX_AUTO_LOAD_PAGES = 30;
const referenceTargetPulseTimers = new WeakMap();

function cleanReferenceText(value, limit = 0) {
  const text = String(value || '').replace(/\r\n?/g, '\n').trim();
  if (!limit || text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function referenceRecordSpace(record) {
  const parent = record?.parentMessageId ? byId(appState?.messages, record.parentMessageId) : null;
  return {
    root: parent || record,
    spaceType: record?.spaceType || parent?.spaceType || selectedSpaceType,
    spaceId: record?.spaceId || parent?.spaceId || selectedSpaceId,
  };
}

function referenceRecordLabel(record) {
  const space = referenceRecordSpace(record);
  return spaceName(space.spaceType, space.spaceId);
}

function normalizeConversationReferenceDraft(input) {
  const raw = input && typeof input === 'object' ? input : {};
  const kind = ['message', 'selection', 'thread', 'conversation'].includes(raw.kind) ? raw.kind : 'message';
  const mode = ['quote', 'context'].includes(raw.mode) ? raw.mode : 'context';
  const selectedText = cleanReferenceText(raw.selectedText, CONVERSATION_REFERENCE_LIMITS_UI.selectedTextChars);
  const recordIds = [...new Set((Array.isArray(raw.recordIds) ? raw.recordIds : [])
    .map(String)
    .filter(Boolean))]
    .slice(0, CONVERSATION_REFERENCE_LIMITS_UI.recordsPerReference);
  const reference = {
    id: String(raw.id || `ref_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
    mode,
    kind,
    sourceRecordId: String(raw.sourceRecordId || ''),
    sourceKind: String(raw.sourceKind || ''),
    parentMessageId: String(raw.parentMessageId || ''),
    spaceType: String(raw.spaceType || ''),
    spaceId: String(raw.spaceId || ''),
    authorType: String(raw.authorType || ''),
    authorId: String(raw.authorId || ''),
    authorName: cleanReferenceText(raw.authorName, 120),
    createdAt: String(raw.createdAt || ''),
    bodyPreview: cleanReferenceText(raw.bodyPreview, CONVERSATION_REFERENCE_LIMITS_UI.previewChars),
    selectedText,
    recordIds,
    truncated: Boolean(raw.truncated),
  };
  if (kind === 'selection' && !reference.selectedText) return null;
  if ((kind === 'message' || kind === 'selection') && !reference.sourceRecordId) return null;
  return reference;
}

function normalizeConversationReferenceDrafts(input) {
  const references = (Array.isArray(input) ? input : [])
    .map(normalizeConversationReferenceDraft)
    .filter(Boolean);
  return mergeConversationReferenceDraftsBySource(references)
    .slice(-CONVERSATION_REFERENCE_LIMITS_UI.referencesPerMessage);
}

function referenceConflictIds(reference) {
  const ids = new Set();
  if (!reference || reference.kind === 'conversation') return ids;
  if (reference.kind === 'thread') {
    for (const id of reference.recordIds || []) ids.add(id);
    if (reference.sourceRecordId) ids.add(reference.sourceRecordId);
    if (reference.parentMessageId) ids.add(reference.parentMessageId);
    return ids;
  }
  if (reference.sourceRecordId) ids.add(reference.sourceRecordId);
  return ids;
}

function conversationReferenceSignature(reference) {
  return [
    reference.kind || '',
    reference.sourceRecordId || '',
    reference.spaceType || '',
    reference.spaceId || '',
    (reference.recordIds || []).join(','),
  ].join(':');
}

function conversationReferencesConflict(existing, incoming) {
  if (!existing || !incoming) return false;
  if (existing.kind === 'conversation' || incoming.kind === 'conversation') {
    return existing.kind === incoming.kind
      && conversationReferenceSignature(existing) === conversationReferenceSignature(incoming);
  }
  const existingIds = referenceConflictIds(existing);
  for (const id of referenceConflictIds(incoming)) {
    if (existingIds.has(id)) return true;
  }
  return false;
}

function mergeConversationReferenceDraftsBySource(references) {
  const merged = [];
  for (const reference of references) {
    for (let index = merged.length - 1; index >= 0; index -= 1) {
      if (conversationReferencesConflict(merged[index], reference)) merged.splice(index, 1);
    }
    merged.push(reference);
  }
  return merged;
}

function composerReferences(composerId) {
  return normalizeConversationReferenceDrafts(composerReferenceDrafts[composerId]);
}

function setComposerReferences(composerId, references) {
  const normalized = normalizeConversationReferenceDrafts(references);
  if (normalized.length) composerReferenceDrafts[composerId] = normalized;
  else delete composerReferenceDrafts[composerId];
}

function clearComposerReferences(composerId) {
  delete composerReferenceDrafts[composerId];
}

function referencePreviewText(reference) {
  return cleanReferenceText(reference.selectedText || reference.bodyPreview || 'Message unavailable', 220);
}

function referencePreviewDisplayText(reference) {
  const text = referencePreviewText(reference);
  return typeof plainMentionText === 'function' ? plainMentionText(text) : text;
}

function referenceModeLabel(reference) {
  if (reference.mode === 'quote') return t('Quote');
  return t('Context');
}

function referenceKindLabel(reference) {
  const labels = {
    message: 'message',
    selection: 'selection',
    thread: 'thread',
    conversation: 'conversation',
  };
  return labels[reference.kind] || 'message';
}

function referenceMetaKey(part) {
  const text = String(part || '').trim();
  if (text.startsWith('@')) return `actor:${text.slice(1).trim().toLowerCase()}`;
  return `literal:${text.toLowerCase()}`;
}

function uniqueReferenceMetaParts(parts) {
  const seen = new Set();
  const result = [];
  for (const part of parts) {
    if (!part) continue;
    const key = referenceMetaKey(part);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(part);
  }
  return result;
}

function renderConversationReferenceChip(reference, composerId, index = 0) {
  const source = reference.authorName || (reference.authorId ? displayName(reference.authorId) : '');
  const meta = uniqueReferenceMetaParts([
    source ? `@${source}` : '',
    referenceRecordLabel(reference),
    reference.createdAt ? fmtTime(reference.createdAt) : '',
  ]).join(' · ');
  return `
    <span class="composer-reference-chip" data-reference-id="${escapeHtml(reference.id)}">
      <button type="button" class="composer-reference-jump" data-action="jump-to-reference-source" data-source-record-id="${escapeHtml(reference.sourceRecordId)}" data-parent-message-id="${escapeHtml(reference.parentMessageId)}" data-source-space-type="${escapeHtml(reference.spaceType || '')}" data-source-space-id="${escapeHtml(reference.spaceId || '')}" data-source-kind="${escapeHtml(reference.sourceKind || '')}" aria-label="Jump to reference source">
        <strong>${escapeHtml(referenceModeLabel(reference))}</strong>
        <small>${escapeHtml(referenceKindLabel(reference))}${meta ? ` · ${meta}` : ''}</small>
        <span>${escapeHtml(referencePreviewDisplayText(reference))}</span>
      </button>
      <button type="button" class="composer-reference-remove" data-action="remove-composer-reference" data-composer-id="${escapeHtml(composerId)}" data-reference-id="${escapeHtml(reference.id)}" aria-label="Remove reference ${index + 1}">×</button>
    </span>
  `;
}

function renderComposerReferenceStrip(composerId) {
  const references = composerReferences(composerId);
  if (!references.length) return '';
  return `
    <div class="composer-reference-strip" data-reference-strip="${escapeHtml(composerId)}" aria-label="${escapeHtml(t('Conversation references'))}">
      ${references.map((reference, index) => renderConversationReferenceChip(reference, composerId, index)).join('')}
    </div>
  `;
}

function renderMessageReferences(record) {
  const references = normalizeConversationReferenceDrafts(record?.references || record?.metadata?.references);
  if (!references.length) return '';
  return `
    <div class="message-reference-stack" aria-label="${escapeHtml(t('Message references'))}">
      ${references.map((reference) => {
        const source = reference.authorName || (reference.authorId ? displayName(reference.authorId) : '');
        const meta = uniqueReferenceMetaParts([
          source ? `@${source}` : '',
          referenceRecordLabel(reference),
          reference.createdAt ? fmtTime(reference.createdAt) : '',
          reference.truncated ? 'truncated' : '',
        ]).join(' · ');
        const disabled = !reference.sourceRecordId && !reference.recordIds?.length;
        return `
          <button class="message-reference-card${disabled ? ' unavailable' : ''}" type="button"
            data-action="jump-to-reference-source"
            data-source-record-id="${escapeHtml(reference.sourceRecordId || reference.recordIds?.[0] || '')}"
            data-parent-message-id="${escapeHtml(reference.parentMessageId || '')}"
            data-source-space-type="${escapeHtml(reference.spaceType || '')}"
            data-source-space-id="${escapeHtml(reference.spaceId || '')}"
            data-source-kind="${escapeHtml(reference.sourceKind || '')}"
            ${disabled ? 'disabled' : ''}>
            <span class="message-reference-kicker">${escapeHtml(referenceModeLabel(reference))} · ${escapeHtml(referenceKindLabel(reference))}</span>
            ${meta ? `<span class="message-reference-meta">${escapeHtml(meta)}</span>` : ''}
            <span class="message-reference-preview">${escapeHtml(referencePreviewDisplayText(reference))}</span>
          </button>
        `;
      }).join('')}
    </div>
  `;
}

function updateComposerReferenceStrip(composerId) {
  const form = document.querySelector(`form[data-composer-id="${CSS.escape(composerId)}"]`);
  if (!form) return;
  const existing = form.querySelector(`[data-reference-strip="${CSS.escape(composerId)}"]`);
  const html = renderComposerReferenceStrip(composerId);
  if (existing) {
    if (html) existing.outerHTML = html;
    else existing.remove();
    return;
  }
  if (!html) return;
  form.insertAdjacentHTML('afterbegin', html);
}

function referenceFromRecord(record, { mode = 'quote', kind = 'message', selectedText = '', recordIds = [] } = {}) {
  if (!record) return null;
  const space = referenceRecordSpace(record);
  const isReply = Boolean(record.parentMessageId);
  const bodyPreview = cleanReferenceText(plainMentionText(record.body || ''), CONVERSATION_REFERENCE_LIMITS_UI.previewChars);
  const cleanSelectedText = cleanReferenceText(selectedText, CONVERSATION_REFERENCE_LIMITS_UI.selectedTextChars);
  return normalizeConversationReferenceDraft({
    mode,
    kind,
    sourceRecordId: kind === 'thread' ? space.root?.id || record.id : record.id,
    sourceKind: isReply ? 'reply' : 'message',
    parentMessageId: isReply ? record.parentMessageId : (kind === 'thread' ? space.root?.id || record.id : ''),
    spaceType: space.spaceType,
    spaceId: space.spaceId,
    authorType: record.authorType || '',
    authorId: record.authorId || '',
    authorName: displayName(record.authorId),
    createdAt: record.createdAt || '',
    bodyPreview,
    selectedText: cleanSelectedText,
    recordIds: recordIds.length ? recordIds : [record.id],
    truncated: recordIds.length > CONVERSATION_REFERENCE_LIMITS_UI.recordsPerReference || selectedText.length > CONVERSATION_REFERENCE_LIMITS_UI.selectedTextChars,
  });
}

function threadReferenceFromRecord(record, mode = 'context') {
  if (!record) return null;
  const root = record.parentMessageId ? byId(appState?.messages, record.parentMessageId) : record;
  if (!root) return null;
  const records = [root, ...threadReplies(root.id)];
  return referenceFromRecord(root, {
    mode,
    kind: 'thread',
    recordIds: records.map((item) => item.id).slice(0, CONVERSATION_REFERENCE_LIMITS_UI.recordsPerReference),
  });
}

function recordTargetsThreadComposer(record) {
  return Boolean(threadMessageId && record && (record.id === threadMessageId || record.parentMessageId === threadMessageId));
}

function targetComposerIdForRecord(record) {
  if (recordTargetsThreadComposer(record)) {
    return composerIdFor('thread', threadMessageId);
  }
  return composerIdFor('message');
}

function channelContextRecordIdsForRecord(record) {
  if (!record?.id) return [];
  const ids = [];
  if (record.parentMessageId) {
    const parent = byId(appState?.messages, record.parentMessageId);
    ids.push(parent?.id || record.parentMessageId);
  }
  ids.push(record.id);
  return [...new Set(ids.filter(Boolean))];
}

function rememberReferenceAuthorMention(composerId, record) {
  if (!record?.authorId || !['agent', 'human'].includes(record.authorType)) return false;
  const name = displayName(record.authorId);
  if (!name || name === 'Unknown') return false;
  const item = { id: record.authorId, name, type: record.authorType };
  if (typeof rememberComposerMention === 'function') rememberComposerMention(composerId, item);
  const label = `@${name}`;
  const selector = `textarea[data-composer-id="${CSS.escape(composerId)}"]`;
  const textarea = document.querySelector(selector);
  const current = textarea?.value ?? composerDrafts[composerId] ?? '';
  const hasMention = current.includes(label) || current.includes(`<@${record.authorId}>`);
  if (hasMention) return true;
  const next = current.trim() ? `${label} ${current}` : `${label} `;
  composerDrafts[composerId] = next;
  if (textarea) {
    textarea.value = next;
    textarea.defaultValue = next;
    textarea.focus();
    textarea.setSelectionRange(next.length, next.length);
  }
  return true;
}

function rememberReferenceAuthorMentions(composerId, records = []) {
  const authors = [];
  const seen = new Set();
  for (const record of records) {
    if (!record?.authorId || !['agent', 'human'].includes(record.authorType)) continue;
    const key = `${record.authorType}:${record.authorId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    authors.push(record);
  }
  let changed = false;
  for (const record of authors.slice().reverse()) {
    changed = rememberReferenceAuthorMention(composerId, record) || changed;
  }
  return changed;
}

function addConversationReferenceToComposer(composerId, reference, { mentionRecord = null, mentionRecords = [] } = {}) {
  const normalized = normalizeConversationReferenceDraft(reference);
  if (!composerId || !normalized) return false;
  const references = composerReferences(composerId);
  const replacesExisting = references.some((existing) => conversationReferencesConflict(existing, normalized));
  if (!replacesExisting && references.length >= CONVERSATION_REFERENCE_LIMITS_UI.referencesPerMessage) {
    toast(`You can attach up to ${CONVERSATION_REFERENCE_LIMITS_UI.referencesPerMessage} references.`);
    return false;
  }
  setComposerReferences(composerId, [...references, normalized]);
  if (mentionRecord) rememberReferenceAuthorMention(composerId, mentionRecord);
  if (mentionRecords.length) rememberReferenceAuthorMentions(composerId, mentionRecords);
  updateComposerReferenceStrip(composerId);
  pendingComposerFocusId = composerId;
  toast(normalized.mode === 'quote' ? 'Quote added' : 'Context added');
  return true;
}

function removeComposerReference(composerId, referenceId) {
  const references = composerReferences(composerId).filter((reference) => reference.id !== referenceId);
  setComposerReferences(composerId, references);
  updateComposerReferenceStrip(composerId);
}

function selectedMessageTextForEvent(event) {
  const selection = window.getSelection?.();
  const text = cleanReferenceText(selection?.toString?.() || '', CONVERSATION_REFERENCE_LIMITS_UI.selectedTextChars);
  if (!selection || !text || selection.rangeCount < 1) return null;
  const row = event.target.closest?.('.magclaw-message');
  if (!row) return null;
  const body = row.querySelector('.message-markdown');
  if (!body) return null;
  const anchor = selection.anchorNode?.nodeType === Node.ELEMENT_NODE ? selection.anchorNode : selection.anchorNode?.parentElement;
  const focus = selection.focusNode?.nodeType === Node.ELEMENT_NODE ? selection.focusNode : selection.focusNode?.parentElement;
  if (!anchor || !focus || !body.contains(anchor) || !body.contains(focus)) return null;
  const recordId = row.dataset.messageId || row.dataset.replyId || '';
  if (!recordId) return null;
  return { recordId, text };
}

function quoteRecordToComposer(record, mode = 'quote', selectedText = '') {
  const kind = selectedText ? 'selection' : 'message';
  const composerId = targetComposerIdForRecord(record);
  const reference = referenceFromRecord(record, { mode, kind, selectedText });
  return addConversationReferenceToComposer(composerId, reference, {
    mentionRecord: record,
  });
}

function addChannelContextReferenceToComposer(record, selectedText = '') {
  const kind = selectedText ? 'selection' : 'message';
  const reference = referenceFromRecord(record, {
    mode: 'context',
    kind,
    selectedText,
    recordIds: channelContextRecordIdsForRecord(record),
  });
  return addConversationReferenceToComposer(composerIdFor('message'), reference, {
    mentionRecord: record,
  });
}

function addThreadReferenceToComposer(record) {
  const reference = threadReferenceFromRecord(record, 'context');
  return addConversationReferenceToComposer(targetComposerIdForRecord(record), reference, {
    mentionRecord: record,
  });
}

function addSelectedMessagesReferenceToComposer() {
  const records = shareSelectionRecords();
  if (!records.length) return false;
  const latest = records[records.length - 1];
  const reference = normalizeConversationReferenceDraft({
    mode: 'context',
    kind: records.length === 1 ? 'message' : 'conversation',
    sourceRecordId: latest.id,
    sourceKind: latest.parentMessageId ? 'reply' : 'message',
    parentMessageId: latest.parentMessageId || '',
    spaceType: latest.spaceType || selectedSpaceType,
    spaceId: latest.spaceId || selectedSpaceId,
    authorType: latest.authorType || '',
    authorId: latest.authorId || '',
    authorName: displayName(latest.authorId),
    createdAt: latest.createdAt || '',
    bodyPreview: `${records.length} selected message${records.length === 1 ? '' : 's'}`,
    recordIds: records.map((record) => record.id),
    truncated: records.length > CONVERSATION_REFERENCE_LIMITS_UI.recordsPerReference,
  });
  return addConversationReferenceToComposer(composerIdFor('message'), reference, {
    mentionRecords: records,
  });
}

function referenceJumpAfterRender(callback) {
  const run = () => {
    callback();
    if (typeof window !== 'undefined' && typeof window.setTimeout === 'function') {
      window.setTimeout(callback, 220);
    }
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(run);
    return;
  }
  run();
}

function referenceJumpRootRecord(sourceRecord, parentMessageId) {
  if (sourceRecord?.parentMessageId) {
    return conversationRecord(sourceRecord.parentMessageId) || null;
  }
  if (parentMessageId) return conversationRecord(parentMessageId) || sourceRecord || null;
  return sourceRecord || null;
}

function referenceJumpTargetsReply(sourceRecord, sourceRecordId, parentMessageId) {
  if (sourceRecord?.parentMessageId) return true;
  return Boolean(sourceRecordId && parentMessageId && sourceRecordId !== parentMessageId);
}

function referenceJumpOpensThread(sourceRecord, sourceRecordId, parentMessageId) {
  if (referenceJumpTargetsReply(sourceRecord, sourceRecordId, parentMessageId)) return true;
  if (!sourceRecord) return Boolean(parentMessageId);
  return Boolean(parentMessageId && parentMessageId === sourceRecord.id);
}

function referenceJumpSelectedRecordId(sourceRecord, rootRecord, sourceRecordId, parentMessageId) {
  if (referenceJumpTargetsReply(sourceRecord, sourceRecordId, parentMessageId)) return sourceRecordId;
  return (sourceRecord || rootRecord)?.id || '';
}

function referenceJumpThreadRootId(sourceRecord, sourceRecordId, parentMessageId) {
  if (sourceRecord?.parentMessageId) return sourceRecord.parentMessageId;
  if (parentMessageId) return parentMessageId;
  if (sourceRecordId && sourceRecord?.id === sourceRecordId && parentMessageId === sourceRecordId) return sourceRecordId;
  return '';
}

function referenceJumpIsInOpenThread(sourceRecord, sourceRecordId, parentMessageId) {
  const rootId = referenceJumpThreadRootId(sourceRecord, sourceRecordId, parentMessageId);
  return Boolean(threadMessageId && rootId && threadMessageId === rootId);
}

function scrollToReferenceRecord(sourceRecord, rootRecord, opensThread, sourceRecordId = '') {
  const replyId = sourceRecord?.parentMessageId
    ? sourceRecord.id
    : (opensThread && sourceRecordId && rootRecord?.id !== sourceRecordId ? sourceRecordId : '');
  if (replyId && typeof scrollToReply === 'function') {
    scrollToReply(replyId);
    return;
  }
  if (!opensThread && rootRecord?.id && typeof scrollToMessage === 'function') {
    scrollToMessage(rootRecord.id);
  }
}

function referenceJumpTargetNode(sourceRecord, rootRecord, opensThread, sourceRecordId = '') {
  const replyId = sourceRecord?.parentMessageId
    ? sourceRecord.id
    : (opensThread && sourceRecordId && rootRecord?.id !== sourceRecordId ? sourceRecordId : '');
  const selector = replyId
    ? `#thread-context #reply-${CSS.escape(replyId)}`
    : (opensThread && rootRecord?.id)
      ? `#thread-context .thread-parent-card #message-${CSS.escape(rootRecord.id)}`
    : (rootRecord?.id ? `#message-list #message-${CSS.escape(rootRecord.id)}` : '');
  return selector ? document.querySelector(selector) : null;
}

function pulseReferenceJumpTarget(sourceRecord, rootRecord, opensThread, sourceRecordId = '') {
  const node = referenceJumpTargetNode(sourceRecord, rootRecord, opensThread, sourceRecordId);
  if (!node?.classList) return false;
  const previousTimer = referenceTargetPulseTimers.get(node);
  if (previousTimer && typeof window.clearTimeout === 'function') window.clearTimeout(previousTimer);
  node.classList.remove('reference-target-pulse');
  // Restart the CSS animation when users click the same reference repeatedly.
  void node.offsetWidth;
  node.classList.add('reference-target-pulse');
  if (typeof window.setTimeout === 'function') {
    const timer = window.setTimeout(() => {
      node.classList.remove('reference-target-pulse');
      referenceTargetPulseTimers.delete(node);
    }, 5400);
    referenceTargetPulseTimers.set(node, timer);
  }
  return true;
}

function scheduleReferenceJumpScroll(sourceRecord, rootRecord, opensThread, sourceRecordId = '') {
  let pulsed = false;
  referenceJumpAfterRender(() => {
    scrollToReferenceRecord(sourceRecord, rootRecord, opensThread, sourceRecordId);
    if (!pulsed) pulsed = pulseReferenceJumpTarget(sourceRecord, rootRecord, opensThread, sourceRecordId);
  });
}

function normalizeReferenceJumpOptions(options = {}) {
  const raw = options && typeof options === 'object' ? options : {};
  return {
    spaceType: String(raw.spaceType || '').trim(),
    spaceId: String(raw.spaceId || '').trim(),
    sourceKind: String(raw.sourceKind || '').trim(),
  };
}

function referenceJumpPageInfo(kind, key = '') {
  if (kind === 'thread') {
    if (typeof currentThreadHistoryPage === 'function') return currentThreadHistoryPage(key);
    const pages = typeof conversationHistoryPages !== 'undefined' ? conversationHistoryPages : null;
    return pages?.thread?.[String(key || '')] || null;
  }
  if (typeof currentMainHistoryPage === 'function') return currentMainHistoryPage();
  const pages = typeof conversationHistoryPages !== 'undefined' ? conversationHistoryPages : null;
  const keyName = typeof conversationPageKey === 'function' ? conversationPageKey() : `${selectedSpaceType || 'channel'}:${selectedSpaceId || ''}`;
  return pages?.main?.[keyName] || null;
}

function referenceJumpCanLoadOlder(kind, key = '') {
  const pageInfo = referenceJumpPageInfo(kind, key);
  const loader = kind === 'thread'
    ? (typeof loadOlderThreadReplies === 'function' ? loadOlderThreadReplies : null)
    : (typeof loadOlderMainMessages === 'function' ? loadOlderMainMessages : null);
  return Boolean(
    loader
    && pageInfo?.hasMore
    && pageInfo?.nextBefore
  );
}

async function autoLoadOlderReferencePages(kind, key, findTarget) {
  for (let index = 0; index < REFERENCE_JUMP_MAX_AUTO_LOAD_PAGES; index += 1) {
    if (findTarget()) return true;
    if (!referenceJumpCanLoadOlder(kind, key)) return false;
    const loaded = kind === 'thread'
      ? await loadOlderThreadReplies()
      : await loadOlderMainMessages();
    if (!loaded) return Boolean(findTarget());
  }
  return Boolean(findTarget());
}

function applyReferenceJumpRoute({ spaceType, spaceId, threadId = null, selectedRecordId = '' }) {
  selectedSpaceType = spaceType || selectedSpaceType;
  selectedSpaceId = spaceId || selectedSpaceId;
  activeView = 'space';
  activeTab = 'chat';
  mobileHomeOpen = false;
  workspaceActivityDrawerOpen = false;
  selectedAgentId = null;
  selectedTaskId = null;
  selectedProjectFile = null;
  threadMessageId = threadId || null;
  selectedSavedRecordId = selectedRecordId || '';
  render();
}

async function jumpToConversationReferenceSource(sourceRecordId, parentMessageId = '', options = {}) {
  const id = String(sourceRecordId || '').trim();
  const parentId = String(parentMessageId || '').trim();
  const jumpOptions = normalizeReferenceJumpOptions(options);
  let sourceRecord = id ? conversationRecord(id) : null;
  let rootRecord = referenceJumpRootRecord(sourceRecord, parentId);
  const targetRecord = sourceRecord || rootRecord;
  const targetSpace = targetRecord ? referenceRecordSpace(targetRecord) : {
    spaceType: jumpOptions.spaceType || selectedSpaceType,
    spaceId: jumpOptions.spaceId || selectedSpaceId,
  };
  if (!targetSpace.spaceType || !targetSpace.spaceId) {
    toast('Reference source is unavailable');
    return false;
  }

  if (referenceJumpIsInOpenThread(sourceRecord, id, parentId)) {
    let opensThread = referenceJumpOpensThread(sourceRecord, id, parentId);
    const selectedRecordId = referenceJumpSelectedRecordId(sourceRecord, rootRecord, id, parentId);
    selectedSavedRecordId = selectedRecordId;
    if (opensThread && id && rootRecord?.id && !conversationRecord(id)) {
      await autoLoadOlderReferencePages('thread', rootRecord.id, () => Boolean(conversationRecord(id)));
      sourceRecord = conversationRecord(id);
      rootRecord = referenceJumpRootRecord(sourceRecord, parentId);
      opensThread = referenceJumpOpensThread(sourceRecord, id, parentId);
    }
    scheduleReferenceJumpScroll(sourceRecord || rootRecord, rootRecord, opensThread, id);
    return true;
  }

  const initialThreadId = referenceJumpOpensThread(sourceRecord, id, parentId) && rootRecord?.id
    ? rootRecord.id
    : null;
  applyReferenceJumpRoute({
    spaceType: targetSpace.spaceType,
    spaceId: targetSpace.spaceId,
    threadId: initialThreadId,
    selectedRecordId: id || parentId,
  });

  const rootRecordId = parentId || (!sourceRecord?.parentMessageId ? id : sourceRecord.parentMessageId);
  if (rootRecordId && !conversationRecord(rootRecordId)) {
    await autoLoadOlderReferencePages('main', '', () => Boolean(conversationRecord(rootRecordId)));
  }

  sourceRecord = id ? conversationRecord(id) : null;
  rootRecord = referenceJumpRootRecord(sourceRecord, parentId);
  if (!sourceRecord && !rootRecord) {
    toast('Reference source is unavailable');
    return false;
  }

  let opensThread = referenceJumpOpensThread(sourceRecord, id, parentId);
  const selectedRecordId = referenceJumpSelectedRecordId(sourceRecord, rootRecord, id, parentId);
  applyReferenceJumpRoute({
    spaceType: targetSpace.spaceType,
    spaceId: targetSpace.spaceId,
    threadId: opensThread && rootRecord?.id ? rootRecord.id : null,
    selectedRecordId,
  });
  if (threadMessageId) {
    if (typeof refreshOpenThreadReplies === 'function') {
      await refreshOpenThreadReplies(threadMessageId).catch((error) => {
        console.warn('Failed to refresh reference thread before jump:', error);
        return false;
      });
    } else {
      refreshThreadSelection(threadMessageId);
    }
  } else {
    refreshThreadSelection(null, { loadReplies: false });
  }

  sourceRecord = id ? conversationRecord(id) : null;
  rootRecord = referenceJumpRootRecord(sourceRecord, parentId);
  opensThread = referenceJumpOpensThread(sourceRecord, id, parentId);
  if (opensThread && id && rootRecord?.id && !conversationRecord(id)) {
    await autoLoadOlderReferencePages('thread', rootRecord.id, () => Boolean(conversationRecord(id)));
    sourceRecord = conversationRecord(id);
    rootRecord = referenceJumpRootRecord(sourceRecord, parentId);
    opensThread = referenceJumpOpensThread(sourceRecord, id, parentId);
  }

  scheduleReferenceJumpScroll(sourceRecord || rootRecord, rootRecord, opensThread, id);
  return true;
}

function outgoingComposerReferences(composerId) {
  return composerReferences(composerId);
}
