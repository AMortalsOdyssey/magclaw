import {
  maskedFeishuIdDetail,
  maskedFeishuIdPathSegment,
  safeFeishuDisplayName,
} from './integrations/feishu-connect/identity-display.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value) {
  return String(value || '').trim();
}

function compact(value, max = 220) {
  const text = clean(value).replace(/\s+/g, ' ');
  if (!text || text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function datePart(value, fallback = '') {
  const date = new Date(value || fallback || Date.now());
  if (Number.isNaN(date.getTime())) return clean(value || fallback).slice(0, 10) || 'unknown-date';
  return date.toISOString().slice(0, 10);
}

function timestamp(value, fallback = '') {
  const date = new Date(value || fallback || Date.now());
  if (Number.isNaN(date.getTime())) return clean(value || fallback) || 'unknown-time';
  return date.toISOString();
}

function stableHash(value) {
  let hash = 2166136261;
  const text = String(value || '');
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function safeSegment(value, fallback = 'item') {
  const text = clean(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return text || `${fallback}-${stableHash(value).slice(0, 8)}`;
}

function identityKey({ id = '', name = '', kind = 'item' } = {}) {
  const maskedSegment = maskedFeishuIdPathSegment(id);
  const base = maskedSegment || safeSegment(name, kind);
  const hashSource = id || name || kind;
  return `feishu_${safeSegment(base, kind)}_${stableHash(hashSource).slice(0, 8)}`;
}

function senderKind(record = {}) {
  const type = clean(record.senderType || record.type || record.sender?.type).toLowerCase();
  if (record.isBot || record.appId || record.sender?.appId || type === 'app' || type === 'bot') return 'bot';
  return 'user';
}

function identityId(record = {}) {
  const kind = senderKind(record);
  if (kind === 'bot') return clean(record.appId || record.senderAppId || record.authorId || record.id || record.sender?.appId || record.sender?.id);
  return clean(record.openId || record.senderOpenId || record.authorId || record.id || record.sender?.openId || record.sender?.id || record.userId || record.senderUserId || record.unionId || record.senderUnionId);
}

function idTypeFor(identity = {}) {
  if (identity.kind === 'bot') return 'app_id';
  if (identity.openId || identity.id.startsWith('ou_')) return 'open_id';
  if (identity.unionId || identity.id.startsWith('on_')) return 'union_id';
  if (identity.userId) return 'user_id';
  return 'external_id';
}

function normalizeIdentity(record = {}, defaults = {}) {
  const kind = senderKind(record);
  const id = identityId(record);
  const rawName = clean(record.name || record.author || record.senderName || record.displayName || record.sender?.name || defaults.name);
  const name = safeFeishuDisplayName(rawName, {
    fallbackId: id,
    kind,
    fallback: kind === 'bot' ? 'Feishu Bot' : 'Feishu user',
  });
  if (!name && !id) return null;
  return {
    id,
    key: identityKey({ id, name, kind }),
    idType: id ? idTypeFor({
      kind,
      id,
      openId: record.openId || record.senderOpenId,
      userId: record.userId || record.senderUserId,
      unionId: record.unionId || record.senderUnionId,
    }) : 'display_name',
    kind,
    name: name || id,
    text: compact(record.text || record.body || record.content || defaults.text || ''),
    sourceMessageId: clean(record.id || record.messageId || defaults.sourceMessageId),
    createdAt: clean(record.createdAt || defaults.createdAt),
    attachmentIds: asArray(record.attachmentIds).map(String).filter(Boolean),
  };
}

function mergeIdentities(records) {
  const byKey = new Map();
  for (const identity of records.filter(Boolean)) {
    const key = identity.id || identity.name;
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...identity, attachmentIds: [...identity.attachmentIds] });
      continue;
    }
    existing.attachmentIds = [...new Set([...existing.attachmentIds, ...identity.attachmentIds])];
    if (!existing.text && identity.text) existing.text = identity.text;
    if (!existing.sourceMessageId && identity.sourceMessageId) existing.sourceMessageId = identity.sourceMessageId;
  }
  return [...byKey.values()];
}

function instructionFromBody(body = '') {
  const text = String(body || '');
  const match = text.match(/Instruction:\s*\n([\s\S]*?)(?:\n\n[A-Z][A-Za-z ]+:\n|$)/);
  if (match?.[1]) return compact(match[1], 180);
  return compact(text.replace(/^Trace ID[:：].*$/m, '').replace(/Feishu identities:[\s\S]*?(?=\n\n|$)/, ''), 180);
}

function originFromPayload(payload = {}) {
  const message = payload.message || {};
  const metadata = message.metadata || {};
  const origin = metadata.origin || {};
  const externalImport = metadata.externalImport || {};
  return {
    provider: clean(origin.provider || externalImport.provider || payload.externalImport?.provider || 'feishu'),
    traceId: clean(origin.traceId || externalImport.traceId || payload.externalImport?.traceId),
    chatId: clean(origin.chatId || externalImport.chatId),
    chatName: clean(origin.chatName || payload.chatName),
    chatType: clean(origin.chatType),
    triggerMessageId: clean(origin.triggerMessageId || externalImport.triggerMessageId),
    rootMessageId: clean(origin.rootMessageId),
    threadId: clean(origin.threadId || externalImport.threadId),
  };
}

export function normalizeFeishuExternalMemoryPayload({ trigger = 'external_import', payload = {}, now = () => new Date().toISOString() } = {}) {
  const message = payload.message || {};
  const metadata = message.metadata || {};
  const feishu = metadata.feishu || {};
  const origin = originFromPayload(payload);
  if (origin.provider !== 'feishu' || !origin.traceId) return null;
  const createdAt = timestamp(message.createdAt, now());
  const day = datePart(createdAt);
  const task = payload.task || {};
  const channel = payload.channel || {};
  const sender = normalizeIdentity({
    name: metadata.origin?.senderName,
    senderName: metadata.origin?.senderName,
    senderType: metadata.origin?.senderType,
    openId: metadata.origin?.senderOpenId || metadata.origin?.senderId,
    userId: metadata.origin?.senderUserId,
    unionId: metadata.origin?.senderUnionId,
    appId: metadata.origin?.senderAppId,
    id: metadata.origin?.senderId,
  }, {
    sourceMessageId: origin.triggerMessageId,
    createdAt,
  });
  const contextRecords = asArray(feishu.contextRecords).map((record) => normalizeIdentity(record, { createdAt })).filter(Boolean);
  const mentions = asArray(feishu.mentions).map((record) => normalizeIdentity(record, { createdAt })).filter(Boolean);
  const participants = mergeIdentities([sender, ...contextRecords, ...mentions]);
  const instruction = instructionFromBody(message.body) || compact(task.title || '');
  const taskNumber = task.number ? `#${task.number}` : '';
  return {
    trigger,
    createdAt,
    day,
    traceId: origin.traceId,
    chatId: origin.chatId,
    chatName: safeFeishuDisplayName(origin.chatName, {
      fallbackId: origin.chatId,
      kind: 'chat',
      fallback: 'Feishu chat',
    }),
    chatType: origin.chatType || 'unknown',
    channelName: channel.name ? `#${channel.name}` : clean(channel.id || message.spaceId || 'channel'),
    messageId: clean(message.id),
    replyId: trigger === 'external_import_reply' ? clean(message.id) : '',
    taskId: clean(task.id),
    taskNumber,
    taskTitle: compact(task.title || instruction || origin.traceId, 120),
    instruction,
    sender,
    contextRecords,
    mentions,
    participants,
    attachmentCount: Number(feishu.attachmentCount || asArray(message.attachmentIds).length || 0),
    rootMessageId: origin.rootMessageId,
    triggerMessageId: origin.triggerMessageId,
    threadId: origin.threadId,
  };
}

function op(relPath, heading, text, maxItems = 12) {
  return {
    type: 'upsert_bullet',
    target: { relPath, heading },
    text,
    maxItems,
  };
}

function identityLabel(identity = {}) {
  if (!identity) return '';
  const id = identity.id ? ` ${maskedFeishuIdDetail(identity.idType, identity.id)}` : '';
  const attachments = identity.attachmentIds?.length ? ` attachments=${identity.attachmentIds.length}` : '';
  return `${identity.name} (${identity.kind}${id}${attachments})`;
}

function identityDisplayTitle(identity = {}) {
  const name = clean(identity.name);
  if (!name) return `Feishu ${identity.kind || 'identity'}`;
  const prefix = `Feishu ${identity.kind || 'identity'}`;
  return name.toLowerCase().startsWith(prefix.toLowerCase()) ? name : `${prefix} ${name}`;
}

function personSummary(identity, memory) {
  const sample = identity.text || memory.instruction || memory.taskTitle;
  return `- \`${personRelPath(identity)}\` - ${identityDisplayTitle(identity)} in ${memory.chatName}: ${compact(sample, 90)}`;
}

function personRelPath(identity) {
  return `notes/feishu/people/${identity.key}.md`;
}

function taskRelPath(memory) {
  return `notes/feishu/tasks/${safeSegment(memory.traceId, 'trace')}.md`;
}

function dailyRelPath(memory) {
  return `notes/feishu/daily/${memory.day}.md`;
}

export function buildFeishuExternalMemoryOperations(params = {}) {
  const memory = normalizeFeishuExternalMemoryPayload(params);
  if (!memory) return [];
  const taskRel = taskRelPath(memory);
  const dailyRel = dailyRelPath(memory);
  const participantText = memory.participants.map((item) => item.name).filter(Boolean).join(', ') || 'none';
  const senderName = memory.sender?.name || 'unknown';
  const operations = [
    op('MEMORY.md', 'Key Knowledge', `- \`${dailyRel}\` - Feishu imports for ${memory.day}; latest ${memory.traceId} from ${memory.chatName}: ${compact(memory.instruction || memory.taskTitle, 90)}`, 16),
    op('MEMORY.md', 'Key Knowledge', `- \`${taskRel}\` - Feishu task ${memory.taskNumber || memory.traceId} from ${memory.chatName} by ${senderName}: ${compact(memory.instruction || memory.taskTitle, 90)} participants=${compact(participantText, 120)}`, 16),
    op(dailyRel, 'Feishu Imports', `- ${memory.createdAt} [${memory.trigger}] trace=${memory.traceId} task=${memory.taskNumber || memory.taskId || '-'} channel=${memory.channelName} chat=${memory.chatName} sender=${senderName} instruction=${compact(memory.instruction || memory.taskTitle, 120)} participants=${compact(participantText, 160)} attachments=${memory.attachmentCount}`, 80),
    op(taskRel, 'Trace Summary', `- Trace ID: ${memory.traceId}; task=${memory.taskNumber || memory.taskId || '-'}; channel=${memory.channelName}; chat=${memory.chatName}; type=${memory.chatType}; sender=${identityLabel(memory.sender)}; instruction=${compact(memory.instruction || memory.taskTitle, 180)}; message=${memory.messageId}; root=${memory.rootMessageId || '-'}; thread=${memory.threadId || '-'}; attachments=${memory.attachmentCount}`, 8),
  ];
  const senderLine = memory.sender
    ? `- ${memory.createdAt} [${memory.trigger}] ${identityLabel(memory.sender)}: ${compact(memory.instruction || memory.taskTitle, 180)} source=${memory.triggerMessageId || memory.messageId || '-'}`
    : '';
  if (senderLine) operations.push(op(taskRel, 'Conversation Timeline', senderLine, 120));
  for (const record of memory.contextRecords) {
    operations.push(op(
      taskRel,
      'Conversation Timeline',
      `- ${timestamp(record.createdAt, memory.createdAt)} [context] ${identityLabel(record)}: ${compact(record.text, 220)} source=${record.sourceMessageId || '-'} trace=${memory.traceId}`,
      120,
    ));
  }
  for (const identity of memory.participants) {
    operations.push(op('MEMORY.md', 'Key Knowledge', personSummary(identity, memory), 20));
    const personRel = personRelPath(identity);
    operations.push(op(
      personRel,
      'Profile',
      `- ${identityDisplayTitle(identity)}${identity.id ? ` (${maskedFeishuIdDetail(identity.idType, identity.id)})` : ''}; seen in ${memory.chatName}; latest trace=${memory.traceId}; related task=${memory.taskNumber || memory.taskId || '-'}`,
      8,
    ));
    if (identity.text || identity === memory.sender) {
      const text = identity.text || memory.instruction || memory.taskTitle;
      operations.push(op(
        personRel,
        'Observed Messages',
        `- ${timestamp(identity.createdAt, memory.createdAt)} [${memory.traceId}] chat=${memory.chatName} task=${memory.taskNumber || memory.taskId || '-'} ${identity.name}: ${compact(text, 220)}${identity.attachmentIds?.length ? ` attachments=${identity.attachmentIds.length}` : ''}`,
        80,
      ));
    }
  }
  return operations;
}

function documentEntries(documents = {}) {
  if (documents instanceof Map) return [...documents.entries()].map(([relPath, content]) => ({ relPath, content }));
  return Object.entries(documents).map(([relPath, content]) => ({ relPath, content }));
}

function queryTerms(query) {
  return String(query || '')
    .toLowerCase()
    .split(/[\s,，。.;；:：!?！？()[\]{}"'`]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function searchFeishuExternalMemoryDocuments(documents = {}, query = '', options = {}) {
  const terms = queryTerms(query);
  if (!terms.length) return [];
  const results = [];
  for (const { relPath, content } of documentEntries(documents)) {
    const pathBoost = relPath.includes('/people/') ? 8 : relPath.includes('/tasks/') ? 4 : relPath === 'MEMORY.md' ? 2 : 0;
    const lines = String(content || '').split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const value = line.toLowerCase();
      const matchedTerms = terms.filter((term) => value.includes(term));
      if (!matchedTerms.length) continue;
      const score = matchedTerms.reduce((sum, term) => sum + Math.min(6, Math.max(1, term.length)), 0) + pathBoost;
      results.push({
        relPath,
        line: index + 1,
        score,
        matchedTerms,
        preview: line.trim().slice(0, 260),
      });
    }
  }
  const limit = Math.max(1, Math.min(50, Number(options.limit || 10)));
  return results
    .sort((a, b) => b.score - a.score || a.relPath.localeCompare(b.relPath) || a.line - b.line)
    .slice(0, limit);
}
