// Shared conversation reference primitives.
// References are persisted as metadata but normalized into first-class message
// fields so UI, routing, history, and Agent context can all speak one shape.

export const CONVERSATION_REFERENCE_LIMITS = Object.freeze({
  referencesPerMessage: 12,
  selectedTextChars: 4000,
  previewChars: 1200,
  agentContextChars: 16000,
  recordsPerReference: 50,
});

const REFERENCE_MODES = new Set(['quote', 'context']);
const REFERENCE_KINDS = new Set(['message', 'selection', 'thread', 'conversation']);
const SOURCE_KINDS = new Set(['message', 'reply']);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cleanString(value, limit = 0) {
  const text = String(value || '').replace(/\r\n?/g, '\n').trim();
  if (!limit || text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`;
}

function cleanId(value) {
  return String(value || '').trim();
}

function cleanIds(values, limit = CONVERSATION_REFERENCE_LIMITS.recordsPerReference) {
  const seen = new Set();
  const ids = [];
  for (const value of Array.isArray(values) ? values : []) {
    const id = cleanId(value);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= limit) break;
  }
  return ids;
}

function normalizedMode(value) {
  const mode = cleanString(value).toLowerCase();
  return REFERENCE_MODES.has(mode) ? mode : 'context';
}

function normalizedKind(value) {
  const kind = cleanString(value).toLowerCase();
  return REFERENCE_KINDS.has(kind) ? kind : 'message';
}

function normalizedSourceKind(value, fallback = '') {
  const kind = cleanString(value || fallback).toLowerCase();
  return SOURCE_KINDS.has(kind) ? kind : '';
}

function normalizedReference(input, index = 0, options = {}) {
  const raw = asObject(input);
  const kind = normalizedKind(raw.kind);
  const mode = normalizedMode(raw.mode);
  const sourceRecordId = cleanId(raw.sourceRecordId || raw.recordId || raw.messageId || raw.replyId);
  const selectedText = cleanString(raw.selectedText || raw.quote || raw.text, CONVERSATION_REFERENCE_LIMITS.selectedTextChars);
  const recordIds = cleanIds(raw.recordIds || raw.messageIds || raw.records);
  const id = cleanId(raw.id)
    || (typeof options.makeId === 'function' ? options.makeId('ref') : '')
    || `ref_${sourceRecordId || kind}_${index}`;

  if (kind === 'selection' && !selectedText) return null;
  if ((kind === 'message' || kind === 'selection') && !sourceRecordId) return null;

  const reference = {
    id,
    mode,
    kind,
    sourceRecordId,
    sourceKind: normalizedSourceKind(raw.sourceKind, raw.parentMessageId ? 'reply' : ''),
    parentMessageId: cleanId(raw.parentMessageId),
    spaceType: cleanString(raw.spaceType).toLowerCase(),
    spaceId: cleanId(raw.spaceId),
    authorType: cleanString(raw.authorType).toLowerCase(),
    authorId: cleanId(raw.authorId),
    authorName: cleanString(raw.authorName, 120),
    createdAt: cleanString(raw.createdAt),
    bodyPreview: cleanString(raw.bodyPreview || raw.preview || raw.body, CONVERSATION_REFERENCE_LIMITS.previewChars),
    selectedText,
    recordIds,
    truncated: Boolean(raw.truncated),
  };

  if (!reference.sourceKind) delete reference.sourceKind;
  if (!reference.parentMessageId) delete reference.parentMessageId;
  if (!reference.spaceType) delete reference.spaceType;
  if (!reference.spaceId) delete reference.spaceId;
  if (!reference.authorType) delete reference.authorType;
  if (!reference.authorId) delete reference.authorId;
  if (!reference.authorName) delete reference.authorName;
  if (!reference.createdAt) delete reference.createdAt;
  if (!reference.bodyPreview) delete reference.bodyPreview;
  if (!reference.selectedText) delete reference.selectedText;
  if (!reference.recordIds.length) delete reference.recordIds;
  if (!reference.truncated) delete reference.truncated;

  return reference;
}

export function normalizeStoredConversationReferences(input, options = {}) {
  const references = (Array.isArray(input) ? input : [])
    .map((item, index) => normalizedReference(item, index, options))
    .filter(Boolean);
  return mergeConversationReferencesBySource(references)
    .slice(-CONVERSATION_REFERENCE_LIMITS.referencesPerMessage);
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

function referencesConflict(existing, incoming) {
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

function mergeConversationReferencesBySource(references) {
  const merged = [];
  for (const reference of references) {
    for (let index = merged.length - 1; index >= 0; index -= 1) {
      if (referencesConflict(merged[index], reference)) merged.splice(index, 1);
    }
    merged.push(reference);
  }
  return merged;
}

export function conversationReferenceText(reference) {
  const ref = asObject(reference);
  return cleanString(ref.selectedText || ref.bodyPreview || '', CONVERSATION_REFERENCE_LIMITS.selectedTextChars);
}

export function compactConversationReferenceText(value, limit = CONVERSATION_REFERENCE_LIMITS.previewChars) {
  return cleanString(value, limit);
}
