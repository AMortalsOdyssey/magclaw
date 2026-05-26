const CONVERSATION_REFERENCE_LIMITS_UI = {
  referencesPerMessage: 12,
  selectedTextChars: 4000,
  previewChars: 1200,
  recordsPerReference: 50,
};

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

function renderConversationReferenceChip(reference, composerId, index = 0) {
  const source = reference.authorName || (reference.authorId ? displayName(reference.authorId) : '');
  const meta = [
    source ? `@${source}` : '',
    referenceRecordLabel(reference),
    reference.createdAt ? fmtTime(reference.createdAt) : '',
  ].filter(Boolean).join(' · ');
  return `
    <span class="composer-reference-chip" data-reference-id="${escapeHtml(reference.id)}">
      <button type="button" class="composer-reference-jump" data-action="jump-to-reference-source" data-source-record-id="${escapeHtml(reference.sourceRecordId)}" data-parent-message-id="${escapeHtml(reference.parentMessageId)}" aria-label="Jump to reference source">
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
        const meta = [
          source ? `@${source}` : '',
          referenceRecordLabel(reference),
          reference.createdAt ? fmtTime(reference.createdAt) : '',
          reference.truncated ? 'truncated' : '',
        ].filter(Boolean).join(' · ');
        const disabled = !reference.sourceRecordId && !reference.recordIds?.length;
        return `
          <button class="message-reference-card${disabled ? ' unavailable' : ''}" type="button"
            data-action="jump-to-reference-source"
            data-source-record-id="${escapeHtml(reference.sourceRecordId || reference.recordIds?.[0] || '')}"
            data-parent-message-id="${escapeHtml(reference.parentMessageId || '')}"
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

function targetComposerIdForRecord(record) {
  if (threadMessageId && record && (record.id === threadMessageId || record.parentMessageId === threadMessageId)) {
    return composerIdFor('thread', threadMessageId);
  }
  return composerIdFor('message');
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

function addConversationReferenceToComposer(composerId, reference, { mentionRecord = null } = {}) {
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
  return addConversationReferenceToComposer(composerIdFor('message'), reference);
}

function jumpToConversationReferenceSource(sourceRecordId, parentMessageId = '') {
  const id = String(sourceRecordId || '').trim();
  const parentId = String(parentMessageId || '').trim();
  const record = conversationRecord(id) || (parentId ? conversationRecord(parentId) : null);
  if (!record) {
    toast('Reference source is unavailable');
    return false;
  }
  const space = referenceRecordSpace(record);
  selectedSpaceType = space.spaceType;
  selectedSpaceId = space.spaceId;
  activeView = 'space';
  activeTab = 'chat';
  if (record.parentMessageId || parentId) threadMessageId = record.parentMessageId || parentId;
  selectedSavedRecordId = record.id;
  render();
  requestAnimationFrame(() => {
    const elementId = record.parentMessageId ? `reply-${record.id}` : `message-${record.id}`;
    document.getElementById(elementId)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  });
  return true;
}

function outgoingComposerReferences(composerId) {
  return composerReferences(composerId);
}
