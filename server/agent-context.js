// Compact context-pack builder for Agent prompts.
// Delivery code uses this to provide the current message plus bounded recent
// channel/thread/task/attachment context without dumping the entire workspace
// into every Codex turn.
import { isWorkspaceAllChannel } from './workspace-defaults.js';
import {
  CONVERSATION_REFERENCE_LIMITS,
  conversationReferenceText,
  normalizeStoredConversationReferences,
} from './conversation-references.js';
import {
  maskedFeishuIdDetail,
  maskFeishuId,
  safeFeishuDisplayName,
} from './integrations/feishu-connect/identity-display.js';

const DEFAULT_LIMITS = {
  recentMessages: 12,
  threadReplies: 8,
  recentEvents: 8,
  tasks: 8,
  attachments: 10,
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function byId(items, id) {
  return asArray(items).find((item) => item?.id === id) || null;
}

function humansForWorkspace(state, workspaceId) {
  const targetWorkspaceId = String(workspaceId || state?.connection?.workspaceId || 'local');
  const humans = new Map();
  for (const human of asArray(state?.humans)) {
    const humanWorkspaceId = String(human?.workspaceId || 'local');
    if (humanWorkspaceId === targetWorkspaceId || (!human?.workspaceId && targetWorkspaceId === 'local')) {
      humans.set(human.id, human);
    }
  }
  const usersById = new Map(asArray(state?.cloud?.users).map((user) => [user.id, user]));
  for (const member of asArray(state?.cloud?.workspaceMembers)) {
    if ((member.status || 'active') !== 'active') continue;
    if (String(member.workspaceId || 'local') !== targetWorkspaceId) continue;
    if (!member.humanId || humans.has(member.humanId)) continue;
    const user = usersById.get(member.userId) || {};
    humans.set(member.humanId, {
      id: member.humanId,
      workspaceId: member.workspaceId,
      name: user.name || user.email?.split('@')[0] || member.humanId.replace(/^hum_/, ''),
      email: user.email || '',
      role: member.role || 'member',
      status: 'offline',
    });
  }
  return [...humans.values()];
}

function agentsForWorkspace(state, workspaceId) {
  const targetWorkspaceId = String(workspaceId || state?.connection?.workspaceId || 'local');
  return asArray(state?.agents).filter((agent) => {
    const agentWorkspaceId = String(agent?.workspaceId || 'local');
    return agentWorkspaceId === targetWorkspaceId || (!agent?.workspaceId && targetWorkspaceId === 'local');
  });
}

function actorById(state, id) {
  return byId(state?.agents, id)
    || byId(state?.humans, id)
    || humansForWorkspace(state).find((human) => human.id === id)
    || null;
}

function actorName(state, id) {
  return actorById(state, id)?.name || (id === 'system' ? 'System' : 'Unknown');
}

function actorType(state, id) {
  if (byId(state?.agents, id)) return 'agent';
  if (byId(state?.humans, id)) return 'human';
  if (humansForWorkspace(state).some((human) => human.id === id)) return 'human';
  return id === 'system' ? 'system' : 'unknown';
}

function uniqueById(items) {
  const seen = new Set();
  const result = [];
  for (const item of asArray(items)) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function sortByCreatedAt(records) {
  return [...asArray(records)].sort((a, b) => {
    const left = new Date(a?.createdAt || 0).getTime();
    const right = new Date(b?.createdAt || 0).getTime();
    if (left !== right) return left - right;
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  });
}

function takeLast(records, limit) {
  const value = Number.isFinite(Number(limit)) ? Number(limit) : records.length;
  return records.slice(Math.max(0, records.length - value));
}

function compactText(value, limit = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trim()}...`;
}

function compactBlockText(value, limit = 240) {
  const text = String(value || '').trim();
  if (!text || text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function spaceRecord(state, spaceType, spaceId) {
  if (spaceType === 'channel') return byId(state?.channels, spaceId);
  if (spaceType === 'dm') return byId(state?.dms, spaceId);
  return null;
}

function spaceName(state, spaceType, spaceId) {
  const space = spaceRecord(state, spaceType, spaceId);
  if (spaceType === 'channel') return space?.name ? `#${space.name}` : '#channel';
  if (spaceType === 'dm') return space?.name ? `dm:${space.name}` : 'DM';
  return `${spaceType || 'space'}:${spaceId || ''}`;
}

function participantIdsForSpace(state, spaceType, spaceId) {
  const space = spaceRecord(state, spaceType, spaceId);
  if (!space) return [];
  if (spaceType === 'channel') {
    if (isWorkspaceAllChannel(space)) {
      const workspaceId = space.workspaceId || state?.connection?.workspaceId || 'local';
      return [
        ...humansForWorkspace(state, workspaceId).map((human) => human.id),
        ...agentsForWorkspace(state, workspaceId).map((agent) => agent.id),
      ];
    }
    return [
      ...asArray(space.memberIds),
      ...asArray(space.humanIds),
      ...asArray(space.agentIds),
    ];
  }
  if (spaceType === 'dm') return asArray(space.participantIds);
  return [];
}

function participantsForSpace(state, spaceType, spaceId, toolBaseUrl = '') {
  return uniqueById(
    participantIdsForSpace(state, spaceType, spaceId)
      .map((id) => actorById(state, id))
      .filter(Boolean),
  ).map((actor) => ({
    id: actor.id,
    name: actor.name,
    type: actorType(state, actor.id),
    role: actor.role || '',
    description: actor.description || '',
    runtime: actor.runtime || '',
    runtimeId: actor.runtimeId || '',
    status: actor.status || '',
    creator: actor.creatorName || actor.createdByName || actor.createdBy || '',
    createdAt: actor.createdAt || '',
    avatar: avatarContext(avatarValue(actor), toolBaseUrl),
  }));
}

function imageMimeFromName(value = '') {
  const name = String(value || '').toLowerCase();
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.webp')) return 'image/webp';
  if (name.endsWith('.gif')) return 'image/gif';
  if (name.endsWith('.svg')) return 'image/svg+xml';
  return '';
}

function dataUrlMime(value = '') {
  return String(value || '').match(/^data:([^;,]+)[;,]/i)?.[1] || '';
}

function contextUrl(value = '', toolBaseUrl = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw) || /^data:image\//i.test(raw)) return raw;
  if (raw.startsWith('/') && toolBaseUrl) {
    try {
      return new URL(raw, toolBaseUrl).toString();
    } catch {
      return raw;
    }
  }
  return raw;
}

function avatarValue(actor = {}) {
  return String(actor.avatar || actor.avatarUrl || '').trim();
}

function avatarContext(value = '', toolBaseUrl = '') {
  const avatar = String(value || '').trim();
  if (!avatar) return { kind: 'none', description: '', visualInput: false };
  if (/^data:image\//i.test(avatar)) {
    const type = dataUrlMime(avatar) || 'image';
    return {
      kind: 'data_url',
      type,
      dataUrl: avatar,
      description: `${type} data URL (${avatar.length} chars)`,
      visualInput: true,
    };
  }
  if (/^https?:\/\//i.test(avatar)) {
    return {
      kind: 'url',
      type: imageMimeFromName(avatar) || 'image',
      url: avatar,
      description: avatar,
      visualInput: true,
    };
  }
  if (avatar.startsWith('/avatars/') || avatar.startsWith('/brand/') || avatar.startsWith('/api/')) {
    const url = contextUrl(avatar, toolBaseUrl);
    return {
      kind: 'path',
      type: imageMimeFromName(avatar) || 'image',
      url,
      description: avatar,
      visualInput: /^https?:\/\//i.test(url),
    };
  }
  if (avatar.startsWith('/')) {
    return {
      kind: 'file',
      type: imageMimeFromName(avatar) || 'image',
      path: avatar,
      description: avatar,
      visualInput: true,
    };
  }
  return {
    kind: 'value',
    type: imageMimeFromName(avatar) || '',
    description: avatar,
    visualInput: false,
  };
}

function targetAgentForContext(state, agentId, toolBaseUrl = '') {
  const agent = byId(state?.agents, agentId);
  if (!agent) return null;
  return {
    id: agent.id,
    name: agent.name || agent.id,
    description: agent.description || '',
    runtime: agent.runtime || '',
    runtimeId: agent.runtimeId || '',
    status: agent.status || '',
    model: agent.model || '',
    reasoningEffort: agent.reasoningEffort || '',
    avatar: avatarContext(avatarValue(agent), toolBaseUrl),
  };
}

function suggestedMembersForSpace(state, spaceType, spaceId, targetAgentId) {
  if (spaceType !== 'channel') return [];
  const space = spaceRecord(state, spaceType, spaceId);
  if (!space || isWorkspaceAllChannel(space)) return [];
  const workspaceId = space.workspaceId || state?.connection?.workspaceId || 'local';
  const existing = new Set(participantIdsForSpace(state, spaceType, spaceId));
  return uniqueById([
    ...humansForWorkspace(state, workspaceId).filter((human) => !existing.has(human.id)),
    ...agentsForWorkspace(state, workspaceId).filter((agent) => agent.id !== targetAgentId && !existing.has(agent.id)),
  ])
    .slice(0, 20)
    .map((actor) => ({
      id: actor.id,
      name: actor.name,
      type: actorType(state, actor.id),
      email: actor.email || '',
      role: actor.role || '',
      description: actor.description || '',
      runtime: actor.runtime || '',
      runtimeId: actor.runtimeId || '',
      status: actor.status || '',
      creator: actor.creatorName || actor.createdByName || actor.createdBy || '',
      createdAt: actor.createdAt || '',
    }));
}

function spaceVisibility(spaceType, space) {
  if (spaceType === 'dm') return 'private';
  const raw = String(space?.visibility || space?.privacy || '').trim().toLowerCase();
  if (['public', 'secret', 'private'].includes(raw)) return raw;
  if (space?.secret) return 'secret';
  if (space?.private || space?.isPrivate) return 'private';
  return 'public';
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return '';
}

function feishuKindForIdentity(identity = {}) {
  const type = String(identity.senderType || identity.type || '').trim().toLowerCase();
  if (identity.isBot || identity.appId || ['app', 'bot'].includes(type)) return 'bot';
  if (identity.openId || identity.unionId || identity.userId || ['user', 'human'].includes(type)) return 'user';
  return type || 'external';
}

function sanitizeFeishuIdentity(identity = {}) {
  const senderId = firstText(identity.senderId, identity.authorId, identity.id);
  const appId = firstText(identity.appId, identity.senderAppId, senderId.startsWith('cli_') ? senderId : '');
  const openId = firstText(identity.openId, identity.open_id, identity.senderOpenId, senderId.startsWith('ou_') ? senderId : '');
  const userId = firstText(identity.userId, identity.user_id);
  const unionId = firstText(identity.unionId, identity.union_id);
  const kind = feishuKindForIdentity({ ...identity, appId, openId });
  const result = {
    name: safeFeishuDisplayName(firstText(identity.name, identity.author, identity.senderName, identity.displayName), {
      fallbackId: openId || userId || unionId || appId || senderId,
      kind,
      fallback: kind === 'bot' ? 'Feishu Bot' : 'Feishu user',
    }),
    kind,
    openId,
    unionId,
    userId,
    appId,
    id: senderId,
    text: compactText(identity.text || identity.body || identity.content || '', 180),
    attachmentIds: asArray(identity.attachmentIds).map(String).filter(Boolean),
  };
  if (!result.name && !result.openId && !result.userId && !result.appId && !result.id) return null;
  return result;
}

function sanitizeExternalImportMetadata(metadata = {}) {
  const origin = metadata.origin || {};
  const externalImport = metadata.externalImport || {};
  const provider = firstText(externalImport.provider, origin.provider, metadata.provider).toLowerCase();
  const systemKind = firstText(metadata.systemKind);
  if (provider !== 'feishu' && !['external_import', 'external_import_reply'].includes(systemKind)) return null;
  const feishu = metadata.feishu || {};
  return {
    provider: provider || 'feishu',
    systemKind,
    traceId: firstText(origin.traceId, externalImport.traceId, metadata.traceId),
    chatId: firstText(origin.chatId, feishu.chatId),
    chatName: firstText(origin.chatName, feishu.chatName),
    chatType: firstText(origin.chatType, feishu.chatType),
    triggerMessageId: firstText(origin.triggerMessageId, feishu.triggerMessageId),
    rootId: firstText(origin.rootId, feishu.rootId),
    threadId: firstText(origin.threadId, feishu.threadId),
    sender: sanitizeFeishuIdentity({
      name: origin.senderName,
      senderName: origin.senderName,
      senderId: origin.senderId,
      senderType: origin.senderType,
      openId: origin.senderOpenId,
      userId: origin.senderUserId,
      unionId: origin.senderUnionId,
      appId: origin.senderAppId,
    }),
    contextRecords: asArray(feishu.contextRecords || externalImport.contextRecords)
      .map(sanitizeFeishuIdentity)
      .filter(Boolean)
      .slice(0, 12),
    mentions: asArray(feishu.mentions || externalImport.mentions)
      .map(sanitizeFeishuIdentity)
      .filter(Boolean)
      .slice(0, 12),
  };
}

function sanitizeRecord(record) {
  if (!record) return null;
  const references = normalizeStoredConversationReferences(record.references || record.metadata?.references);
  return {
    id: record.id,
    parentMessageId: record.parentMessageId || null,
    spaceType: record.spaceType || null,
    spaceId: record.spaceId || null,
    authorType: record.authorType || 'unknown',
    authorId: record.authorId || 'unknown',
    body: String(record.body || ''),
    attachmentIds: asArray(record.attachmentIds).map(String),
    localReferences: asArray(record.localReferences),
    taskId: record.taskId || null,
    target: record.target || null,
    passiveAwareness: Boolean(record.passiveAwareness),
    workItemId: record.workItemId || null,
    replyCount: Number(record.replyCount || 0),
    createdAt: record.createdAt || '',
    updatedAt: record.updatedAt || '',
    mentionedAgentIds: asArray(record.mentionedAgentIds).map(String),
    mentionedHumanIds: asArray(record.mentionedHumanIds).map(String),
    references,
    externalImport: sanitizeExternalImportMetadata(record.metadata || {}),
  };
}

function messageBelongsToSpace(record, spaceType, spaceId) {
  return record?.spaceType === spaceType && record?.spaceId === spaceId;
}

function recentMessagesForSpace(state, spaceType, spaceId, currentMessage, limit) {
  const records = sortByCreatedAt(asArray(state?.messages).filter((record) => messageBelongsToSpace(record, spaceType, spaceId)));
  const currentTime = currentMessage?.createdAt ? new Date(currentMessage.createdAt).getTime() : null;
  const visible = Number.isFinite(currentTime)
    ? records.filter((record) => new Date(record.createdAt || 0).getTime() <= currentTime || record.id === currentMessage.id)
    : records;
  const selected = takeLast(visible, limit);
  if (currentMessage && !selected.some((record) => record.id === currentMessage.id) && messageBelongsToSpace(currentMessage, spaceType, spaceId)) {
    selected.push(currentMessage);
  }
  return sortByCreatedAt(uniqueById(selected)).map(sanitizeRecord);
}

function threadContextFor(state, parentMessageId, currentMessage, limit) {
  const parentId = parentMessageId || currentMessage?.parentMessageId || null;
  if (!parentId) return null;
  const parent = byId(state?.messages, parentId);
  if (!parent) return null;
  const replies = sortByCreatedAt(asArray(state?.replies).filter((reply) => reply.parentMessageId === parentId));
  const selected = takeLast(replies, limit);
  if (currentMessage?.parentMessageId === parentId && !selected.some((record) => record.id === currentMessage.id)) {
    selected.push(currentMessage);
  }
  return {
    parentMessage: sanitizeRecord(parent),
    recentReplies: sortByCreatedAt(uniqueById(selected)).map(sanitizeRecord),
  };
}

function taskMatchesContext(task, { spaceType, spaceId, messageIds }) {
  if (task?.spaceType === spaceType && task?.spaceId === spaceId && !['done', 'closed'].includes(task.status)) return true;
  const ids = new Set(messageIds);
  return [
    task?.messageId,
    task?.sourceMessageId,
    task?.threadMessageId,
  ].some((id) => id && ids.has(id));
}

function tasksForContext(state, spaceType, spaceId, records, limit) {
  const messageIds = asArray(records).map((record) => record?.id).filter(Boolean);
  return asArray(state?.tasks)
    .filter((task) => taskMatchesContext(task, { spaceType, spaceId, messageIds }))
    .sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0))
    .slice(0, limit)
    .map((task) => ({
      id: task.id,
      number: task.number,
      title: String(task.title || 'Untitled task'),
      body: String(task.body || ''),
      status: String(task.status || 'todo'),
      claimedBy: task.claimedBy || '',
      assigneeIds: asArray(task.assigneeIds?.length ? task.assigneeIds : [task.assigneeId]).filter(Boolean),
      messageId: task.messageId || task.sourceMessageId || task.threadMessageId || '',
      threadMessageId: task.threadMessageId || '',
    }));
}

function attachmentContextUrl(attachment, toolBaseUrl = '') {
  const url = String(attachment?.url || attachment?.downloadUrl || '').trim();
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  if (url.startsWith('/') && toolBaseUrl) {
    try {
      return new URL(url, toolBaseUrl).toString();
    } catch {
      return url;
    }
  }
  return url;
}

function attachmentsForContext(state, records, limit, toolBaseUrl = '') {
  const messageByAttachment = new Map();
  const attachmentById = new Map(asArray(state?.attachments).map((attachment) => [String(attachment?.id || ''), attachment]));
  const ordered = [];
  for (const record of asArray(records)) {
    for (const id of asArray(record?.attachmentIds)) {
      const attachmentId = String(id || '').trim();
      if (!attachmentId || messageByAttachment.has(attachmentId)) continue;
      messageByAttachment.set(attachmentId, record.id);
      const attachment = attachmentById.get(attachmentId);
      if (attachment) ordered.push(attachment);
    }
  }
  return ordered
    .slice(0, limit)
    .map((attachment) => ({
      id: attachment.id,
      name: attachment.name || attachment.filename || attachment.id,
      type: attachment.type || attachment.mime || 'file',
      bytes: Number(attachment.bytes || attachment.sizeBytes || 0),
      path: attachment.path || '',
      url: attachmentContextUrl(attachment, toolBaseUrl),
      source: attachment.source || '',
      messageId: messageByAttachment.get(attachment.id),
    }));
}

function sanitizeEvent(event) {
  if (!event) return null;
  return {
    id: event.id,
    type: String(event.type || ''),
    message: String(event.message || ''),
    channelId: event.channelId || null,
    spaceType: event.spaceType || null,
    spaceId: event.spaceId || null,
    memberId: event.memberId || null,
    memberIds: asArray(event.memberIds).map(String),
    agentId: event.agentId || null,
    actorId: event.actorId || event.reviewerId || event.createdBy || null,
    proposalId: event.proposalId || null,
    createdAt: event.createdAt || '',
  };
}

function eventBelongsToSpace(event, spaceType, spaceId) {
  if (!event) return false;
  if (event.spaceType && event.spaceId) return event.spaceType === spaceType && event.spaceId === spaceId;
  if (spaceType === 'channel') return event.channelId === spaceId;
  return false;
}

function recentEventsForSpace(state, spaceType, spaceId, currentMessage, limit) {
  const currentTime = currentMessage?.createdAt ? new Date(currentMessage.createdAt).getTime() : null;
  const records = sortByCreatedAt(asArray(state?.events).filter((event) => eventBelongsToSpace(event, spaceType, spaceId)));
  const visible = Number.isFinite(currentTime)
    ? records.filter((event) => {
      const eventTime = new Date(event.createdAt || 0).getTime();
      return !Number.isFinite(eventTime) || eventTime <= currentTime;
    })
    : records;
  return takeLast(visible, limit).map(sanitizeEvent).filter(Boolean);
}

export function buildAgentContextPack({
  state,
  agentId,
  spaceType,
  spaceId,
  currentMessage,
  parentMessageId = null,
  workItem = null,
  peerMemorySearch = null,
  toolBaseUrl = '',
  limits = {},
}) {
  const effectiveLimits = { ...DEFAULT_LIMITS, ...limits };
  const current = sanitizeRecord(currentMessage);
  const recentMessages = recentMessagesForSpace(state, spaceType, spaceId, current, effectiveLimits.recentMessages);
  const thread = threadContextFor(state, parentMessageId, current, effectiveLimits.threadReplies);
  const visibleRecords = uniqueById([
    current,
    thread?.parentMessage,
    ...asArray(thread?.recentReplies),
    ...recentMessages,
  ].filter(Boolean));
  const space = spaceRecord(state, spaceType, spaceId);

  return {
    targetAgentId: agentId,
    space: {
      type: spaceType,
      id: spaceId,
      name: space?.name || spaceName(state, spaceType, spaceId),
      label: spaceName(state, spaceType, spaceId),
      description: space?.description || '',
      visibility: spaceVisibility(spaceType, space),
      workspaceId: space?.workspaceId || state?.connection?.workspaceId || 'local',
      defaultChannel: Boolean(spaceType === 'channel' && isWorkspaceAllChannel(space)),
    },
    participants: participantsForSpace(state, spaceType, spaceId, toolBaseUrl),
    suggestedMembers: suggestedMembersForSpace(state, spaceType, spaceId, agentId),
    targetAgent: targetAgentForContext(state, agentId, toolBaseUrl),
    currentMessage: current,
    workItem: workItem ? {
      id: workItem.id,
      target: workItem.target,
      taskId: workItem.taskId || null,
      status: workItem.status || '',
    } : null,
    recentMessages,
    thread,
    recentEvents: recentEventsForSpace(state, spaceType, spaceId, current, effectiveLimits.recentEvents),
    tasks: tasksForContext(state, spaceType, spaceId, visibleRecords, effectiveLimits.tasks),
    attachments: attachmentsForContext(state, visibleRecords, effectiveLimits.attachments, toolBaseUrl),
    peerMemorySearch,
    historyTools: {
      baseUrl: toolBaseUrl,
      agentId,
    },
  };
}

function renderMentions(state, text) {
  return String(text || '').replace(/<@(agt_\w+|hum_\w+)>/g, (_, id) => `@${actorName(state, id)}`);
}

function renderActor(state, id) {
  return `@${actorName(state, id)}`;
}

function renderTaskActor(state, id, targetAgentId) {
  return `${renderActor(state, id)}${id && id === targetAgentId ? ' (you)' : ''}`;
}

function renderTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().replace('T', ' ').slice(0, 16);
}

function renderFeishuIdentity(identity) {
  if (!identity) return '';
  const details = [
    identity.kind || 'external',
    identity.openId ? maskedFeishuIdDetail('open_id', identity.openId) : '',
    identity.userId ? maskedFeishuIdDetail('user_id', identity.userId) : '',
    identity.unionId ? maskedFeishuIdDetail('union_id', identity.unionId) : '',
    identity.appId ? maskedFeishuIdDetail('app_id', identity.appId) : '',
    identity.attachmentIds?.length ? `attachments=${identity.attachmentIds.length}` : '',
  ].filter(Boolean).join(' ');
  return `@${identity.name || identity.openId || identity.userId || identity.appId || identity.id}${details ? ` [${details}]` : ''}`;
}

function uniqueFeishuIdentities(identities) {
  const byKey = new Map();
  const result = [];
  for (const identity of asArray(identities)) {
    if (!identity) continue;
    const key = identity.openId || identity.userId || identity.unionId || identity.appId || identity.id || identity.name;
    if (!key) continue;
    const existing = byKey.get(key);
    if (existing) {
      existing.attachmentIds = [...new Set([...asArray(existing.attachmentIds), ...asArray(identity.attachmentIds)])];
      if (!existing.text && identity.text) existing.text = identity.text;
      continue;
    }
    byKey.set(key, identity);
    result.push(identity);
  }
  return result;
}

function renderExternalImportDetails(record) {
  const external = record?.externalImport;
  if (!external || external.provider !== 'feishu') return '';
  const sender = renderFeishuIdentity(external.sender);
  const chatName = safeFeishuDisplayName(external.chatName, {
    fallbackId: external.chatId,
    kind: 'chat',
    fallback: 'Feishu chat',
  });
  const header = [
    `trace=${external.traceId || '-'}`,
    external.chatName ? `chat="${chatName}"` : external.chatId ? `chat=${maskFeishuId(external.chatId) || external.chatId}` : '',
    external.chatType ? `type=${external.chatType}` : '',
    sender ? `sender=${external.sender?.name || sender}` : '',
    external.rootId ? `root=${external.rootId}` : '',
    external.threadId ? `thread=${external.threadId}` : '',
  ].filter(Boolean).join(' ');
  const speakers = uniqueFeishuIdentities([
    external.sender,
    ...asArray(external.contextRecords),
  ]);
  const lines = [`  external Feishu: ${header}`];
  if (speakers.length) {
    lines.push(`  speakers=${speakers.map(renderFeishuIdentity).join(', ')}`);
  }
  if (external.mentions?.length) {
    lines.push(`  mentions=${external.mentions.map(renderFeishuIdentity).join(', ')}`);
  }
  lines.push('  Feishu reply guidance: If addressing a Feishu participant, use their display name (for example @JHB) when it prevents ambiguity. Keep route keys and internal routing hidden.');
  return `\n${lines.join('\n')}`;
}

function messageLine(state, record, targetAgentId) {
  const addressed = asArray(record?.mentionedAgentIds).includes(targetAgentId) ? ' mentioned you' : '';
  const refs = asArray(record?.localReferences);
  const conversationRefs = normalizeStoredConversationReferences(record?.references);
  const refText = refs.length
    ? `\n  local refs: ${refs.map((ref) => `${ref.kind || 'ref'} ${ref.path || ref.absolutePath || ''}`).join('; ')}`
    : '';
  const conversationRefText = conversationRefs.length
    ? `\n  conversation refs: ${conversationRefs.map((ref) => `${ref.mode}/${ref.kind}${ref.sourceRecordId ? ` ${ref.sourceRecordId}` : ''}`).join('; ')}`
    : '';
  const header = [
    record?.target ? `target=${record.target}` : '',
    record?.passiveAwareness ? 'awareness=passive' : '',
    record?.workItemId ? `workItem=${record.workItemId}` : '',
    `msg=${record.id}`,
    record?.taskId ? `task=${record.taskId}` : '',
    `time=${renderTime(record.createdAt)}`,
    `type=${record.authorType}`,
  ].filter(Boolean).join(' ');
  return `[${header}] ${renderActor(state, record.authorId)}${addressed}: ${renderMentions(state, compactText(record.body, 420))}${refText}${conversationRefText}${renderExternalImportDetails(record)}`;
}

function conversationRecordById(state, id) {
  return byId(state?.messages, id) || byId(state?.replies, id);
}

function recordsForConversationReference(state, reference) {
  const ref = reference || {};
  const recordIds = asArray(ref.recordIds).map(String).filter(Boolean);
  if (recordIds.length) {
    return recordIds.map((id) => conversationRecordById(state, id)).filter(Boolean);
  }
  if (ref.sourceRecordId) {
    const source = conversationRecordById(state, ref.sourceRecordId);
    return source ? [source] : [];
  }
  return [];
}

function referenceSpaceLabel(state, reference) {
  if (!reference?.spaceType || !reference?.spaceId) return 'unknown space';
  return spaceName(state, reference.spaceType, reference.spaceId);
}

function referenceSourceLocationParts(reference) {
  const parts = [];
  if (reference?.sourceKind) parts.push(`source=${reference.sourceKind}`);
  if (reference?.parentMessageId) {
    parts.push(reference.sourceKind === 'reply'
      ? `thread=${reference.parentMessageId}`
      : `parent=${reference.parentMessageId}`);
  }
  return parts;
}

function renderConversationReferenceBlock(state, reference, targetAgentId, remainingChars) {
  const records = recordsForConversationReference(state, reference);
  const header = [
    `- ${reference.mode || 'context'}/${reference.kind || 'message'}`,
    ...referenceSourceLocationParts(reference),
    reference.authorName ? `from @${reference.authorName}` : '',
    referenceSpaceLabel(state, reference),
    reference.createdAt ? `at ${renderTime(reference.createdAt)}` : '',
    reference.truncated ? '(truncated)' : '',
  ].filter(Boolean).join(' ');
  const selected = conversationReferenceText(reference);
  const bodyLines = [];
  if (selected && reference.kind === 'selection') {
    bodyLines.push(`  selected text: ${renderMentions(state, compactText(selected, Math.min(remainingChars, 1200)))}`);
  }
  if (records.length) {
    bodyLines.push(...records.map((record) => `  ${messageLine(state, sanitizeRecord(record), targetAgentId)}`));
  } else if (reference.bodyPreview) {
    bodyLines.push(`  preview: ${renderMentions(state, compactText(reference.bodyPreview, Math.min(remainingChars, 1200)))}`);
  } else {
    bodyLines.push('  source: Message unavailable');
  }
  return compactBlockText([header, ...bodyLines].join('\n'), remainingChars);
}

function renderReferencedContext(state, references, targetAgentId) {
  const refs = normalizeStoredConversationReferences(references);
  if (!refs.length) return '';
  const lines = [
    'Referenced context supplied with the current message:',
    'Treat these references as visible content attached by the user; do not ask the user to resend content that appears below.',
  ];
  let used = lines.join('\n').length;
  for (const reference of refs) {
    const remaining = CONVERSATION_REFERENCE_LIMITS.agentContextChars - used;
    if (remaining <= 120) {
      lines.push('- (additional references omitted after context budget)');
      break;
    }
    const block = renderConversationReferenceBlock(state, reference, targetAgentId, remaining);
    used += block.length;
    lines.push(block);
  }
  return lines.join('\n');
}

function compactParticipants(pack, targetAgentId = pack?.targetAgentId) {
  const participants = asArray(pack.participants);
  const importantIds = new Set([
    targetAgentId,
    pack?.currentMessage?.authorId,
    ...asArray(pack?.currentMessage?.mentionedAgentIds),
    ...asArray(pack?.currentMessage?.mentionedHumanIds),
  ].filter(Boolean));
  for (const record of asArray(pack?.recentMessages).slice(-4)) {
    if (record?.authorId) importantIds.add(record.authorId);
    for (const id of asArray(record?.mentionedAgentIds)) importantIds.add(id);
    for (const id of asArray(record?.mentionedHumanIds)) importantIds.add(id);
  }
  const selected = [];
  for (const item of participants) {
    if (importantIds.has(item.id)) selected.push(item);
  }
  for (const item of participants) {
    if (selected.length >= 10) break;
    if (!selected.some((existing) => existing.id === item.id)) selected.push(item);
  }
  const selectedIds = new Set(selected.map((item) => item.id));
  return {
    total: participants.length,
    selected: participants.filter((item) => selectedIds.has(item.id)),
    omitted: Math.max(0, participants.length - selected.length),
  };
}

function renderParticipants(pack, targetAgentId = pack?.targetAgentId) {
  return compactParticipants(pack, targetAgentId).selected
    .map((item) => {
      const self = item.id === targetAgentId ? ' (you)' : '';
      const details = [
        item.type || '',
        item.role ? `role=${item.role}` : '',
        item.runtime ? `runtime=${item.runtime}` : '',
        item.status ? `status=${item.status}` : '',
        item.description ? `description=${compactText(item.description, 96)}` : '',
      ].filter(Boolean);
      return `@${item.name}${self}${details.length ? ` - ${details.join('; ')}` : ''}`;
    })
    .join(', ');
}

function renderSuggestedMembers(pack) {
  const members = asArray(pack.suggestedMembers);
  if (!members.length) return '- (none)';
  return members
    .map((item) => {
      const detail = [
        item.type,
        item.email,
        item.role ? `role=${item.role}` : '',
        item.runtime ? `runtime=${item.runtime}` : '',
        item.status ? `status=${item.status}` : '',
        item.description ? `description=${item.description}` : '',
      ].filter(Boolean).join('; ');
      return `- @${item.name} (${item.id}${detail ? `; ${detail}` : ''})`;
    })
    .join('\n');
}

function renderTasks(state, tasks, targetAgentId = null) {
  if (!tasks.length) return '- (none)';
  return tasks.map((task) => {
    const supportingTeammates = task.assigneeIds.filter((id) => id !== task.claimedBy);
    const lead = task.claimedBy
      ? ` lead: ${renderTaskActor(state, task.claimedBy, targetAgentId)};`
      : ' lead: open;';
    const collaboratorText = supportingTeammates.length
      ? ` supporting teammates: ${supportingTeammates.map((id) => renderTaskActor(state, id, targetAgentId)).join(', ')};`
      : ' supporting teammates: none;';
    const msg = task.messageId ? ` msg=${task.messageId};` : '';
    return `- task #${task.number || '?'} [${task.status}] ${task.title} (${lead}${collaboratorText}${msg} thread=${task.threadMessageId || '-'})`;
  }).join('\n');
}

function renderAttachments(attachments) {
  if (!attachments.length) return '- (none)';
  return attachments
    .map((item) => {
      const details = [
        `id=${item.id}`,
        `from msg=${item.messageId}`,
        item.source ? `source=${item.source}` : '',
        item.path ? `path=${item.path}` : '',
        item.url ? `url=${item.url}` : '',
        `tool=read_attachment(attachmentId="${item.id}")`,
      ].filter(Boolean).join(', ');
      return `- ${item.name} ${item.type} ${item.bytes} bytes (${details})`;
    })
    .join('\n');
}

function renderTargetAgentAvatar(pack) {
  const avatar = pack?.targetAgent?.avatar;
  if (!avatar || avatar.kind === 'none') return '';
  const description = avatar.description ? ` (${avatar.description})` : '';
  if (avatar.visualInput) {
    return `- Your profile avatar: image supplied as visual input${description}. Use it when the user asks what your avatar shows.`;
  }
  return `- Your profile avatar: ${avatar.description || 'configured'}, but no visual input is available.`;
}

function participantAvatarVisualInputs(pack, targetAgentId) {
  return compactParticipants(pack, targetAgentId).selected.filter((item) => (
    item.id !== targetAgentId
    && item.type === 'agent'
    && item.avatar
    && item.avatar.kind !== 'none'
    && item.avatar.visualInput !== false
  ));
}

function renderParticipantAvatarInputs(pack, targetAgentId) {
  const visible = participantAvatarVisualInputs(pack, targetAgentId);
  if (!visible.length) return '';
  const names = visible.map((item) => `@${item.name || item.id}`).join(', ');
  return `- Participant avatar visual inputs: ${names}. Use these when comparing an uploaded image to another Agent avatar; call read_agent_avatar if the relevant Agent is omitted.`;
}

function renderEventMemberList(state, event) {
  const ids = uniqueById([
    ...asArray(event?.memberIds).map((id) => ({ id })),
    event?.memberId ? { id: event.memberId } : null,
  ].filter(Boolean)).map((item) => item.id);
  if (!ids.length) return '';
  return ids.map((id) => renderActor(state, id)).join(', ');
}

function eventLine(state, event) {
  const header = [
    `event=${event.id}`,
    event.type ? `type=${event.type}` : '',
    `time=${renderTime(event.createdAt)}`,
  ].filter(Boolean).join(' ');
  const members = renderEventMemberList(state, event);
  if (event.type === 'channel_member_added' && members) {
    return `[${header}] ${members} joined ${event.channelId || 'this channel'}.`;
  }
  if (event.type === 'channel_member_removed' && members) {
    return `[${header}] ${members} left or was removed from ${event.channelId || 'this channel'}.`;
  }
  if (event.type === 'channel_member_proposal_accepted' && members) {
    return `[${header}] Human review accepted adding ${members} to this channel.`;
  }
  return `[${header}] ${renderMentions(state, compactText(event.message, 300))}`;
}

function renderRecentEvents(state, events) {
  const records = asArray(events);
  if (!records.length) return '- (none)';
  return records.map((event) => eventLine(state, event)).join('\n');
}

function renderPeerMemorySearch(search) {
  if (!search?.required && !search?.results?.length) return '';
  const lines = [
    'Peer memory search:',
    `- Required for this turn: ${search.required ? 'yes' : 'no'}`,
    search.reason ? `- Reason: ${search.reason}` : '',
    search.query ? `- Query: ${search.query}` : '',
  ].filter(Boolean);
  if (!search.results?.length) {
    lines.push('- Results: no matches. If the question asks what another agent specializes in or who is best suited, call search_message_history/read_history for prior role assignments and search_agent_memory with narrower keywords before answering.');
    return lines.join('\n');
  }
  lines.push('- Results:');
  for (const item of search.results) {
    const location = `${item.path || 'MEMORY.md'}:${item.line || 1}`;
    const matched = item.matchedTerms?.length ? `; matched=${item.matchedTerms.join(', ')}` : '';
    lines.push(`  - @${item.agentName} (${item.agentId}) ${location}${matched}: ${item.preview || ''}`);
  }
  lines.push('- Use these matches as grounding when recommending which agent is best suited. If they are insufficient or contradictory, call search_agent_memory/read_agent_memory and search_message_history/read_history before answering.');
  return lines.join('\n');
}

function renderHistoryToolHints(pack) {
  const baseUrl = pack.historyTools?.baseUrl;
  const agentId = pack.historyTools?.agentId || pack.targetAgentId;
  if (!baseUrl || !agentId) return '';
  const target = pack.thread?.parentMessage?.id
    ? `${pack.space.label}:${pack.thread.parentMessage.id}`
    : pack.space.label;
  const encodedTarget = encodeURIComponent(target);
  const currentTarget = pack.currentMessage?.target || pack.workItem?.target || target;
  const currentWorkItemId = pack.currentMessage?.workItemId || pack.workItem?.id || '';
  const hints = [
    'Progressive history tools:',
    '- The recent context above is only a compact snapshot. Do not assume it is the whole conversation.',
    `- list_agents(target="${target}", limit=10): curl -s "${baseUrl}/api/agent-tools/agents?agentId=${encodeURIComponent(agentId)}&target=${encodedTarget}&limit=10"`,
    `- read_agent_profile(targetAgentId="agt_xxx"): curl -s "${baseUrl}/api/agent-tools/agents/read?agentId=${encodeURIComponent(agentId)}&targetAgentId=agt_xxx"`,
    `- read_agent_avatar(targetAgentId="agt_xxx"): curl -s "${baseUrl}/api/agent-tools/agents/avatar/read?agentId=${encodeURIComponent(agentId)}&targetAgentId=agt_xxx"`,
    `- read_history(target="${target}", limit=30): curl -s "${baseUrl}/api/agent-tools/history?agentId=${encodeURIComponent(agentId)}&target=${encodedTarget}&limit=30"`,
    `- search_message_history(query="<query>", target="${target}", limit=10): curl -s "${baseUrl}/api/agent-tools/search?agentId=${encodeURIComponent(agentId)}&target=${encodedTarget}&q=<query>&limit=10"`,
    `- list_attachments(target="${target}", limit=20): curl -s "${baseUrl}/api/agent-tools/attachments?agentId=${encodeURIComponent(agentId)}&target=${encodedTarget}&limit=20"`,
    `- read_attachment(attachmentId="att_xxx"): curl -s "${baseUrl}/api/agent-tools/attachments/read?agentId=${encodeURIComponent(agentId)}&attachmentId=att_xxx"`,
    `- search_agent_memory(query="<query>", limit=10): curl -s "${baseUrl}/api/agent-tools/memory/search?agentId=${encodeURIComponent(agentId)}&q=<query>&limit=10"`,
    `- read_agent_memory(targetAgentId="agt_xxx", path="MEMORY.md|notes/profile.md"): curl -s "${baseUrl}/api/agent-tools/memory/read?agentId=${encodeURIComponent(agentId)}&targetAgentId=agt_xxx&path=MEMORY.md"`,
  ];
  if (currentTarget && currentWorkItemId) {
    hints.push(
      `- send_message(target="${currentTarget}", workItemId="${currentWorkItemId}", content="..."): curl -sS -X POST ${baseUrl}/api/agent-tools/messages/send -H 'content-type: application/json' -d '${JSON.stringify({ agentId, workItemId: currentWorkItemId, target: currentTarget, content: '...' })}'`,
    );
  }
  if (asArray(pack.tasks).some((task) => ['todo', 'in_progress', 'in_review'].includes(task.status))) {
    hints.push(
      `- update_task(taskId="<task_id>", status="todo|in_progress|in_review|done|closed"): curl -sS -X POST ${baseUrl}/api/agent-tools/tasks/update -H 'content-type: application/json' -d '${JSON.stringify({ agentId, taskId: '<task_id>', status: 'in_review' })}'. Use done only for completed/accepted work; use closed for close/stop/cancel requests. If closing an unclaimed task, include force=true instead of claiming it first. Do not use synonyms such as completed.`,
    );
  }
  if (pack.space.type === 'channel' && asArray(pack.suggestedMembers).length) {
    hints.push(
      `- propose_channel_members(channelId="${pack.space.id}", memberIds=["hum_xxx"], reason="..."): curl -sS -X POST ${baseUrl}/api/agent-tools/channel-member-proposals -H 'content-type: application/json' -d '${JSON.stringify({ agentId, channelId: pack.space.id, memberIds: ['hum_xxx'], reason: 'Why this member is needed.' })}'`,
    );
  }
  hints.push(
    pack.peerMemorySearch?.required
      ? '- For agent capability or suitability questions, use the peer memory search results above first. If they are missing or weak, call search_agent_memory/read_agent_memory and search_message_history/read_history before giving a recommendation.'
      : '- Use history/search only when the visible snapshot is not enough. Use send_message for explicit routed replies or proactive messages to visible targets such as dm:@Agent.',
  );
  return hints.join('\n');
}

export function renderAgentContextPack(pack, { state, targetAgentId = pack?.targetAgentId } = {}) {
  if (!pack?.currentMessage) return '';
  const sourceState = state || {
    agents: pack.participants.filter((item) => item.type === 'agent'),
    humans: pack.participants.filter((item) => item.type === 'human'),
  };
  const participants = compactParticipants(pack, targetAgentId);
  const recentMessages = pack.recentMessages.slice(-4);
  const recentReplies = pack.thread?.recentReplies?.slice(-3) || [];
  const lines = [
    `Context snapshot for ${pack.space.label}`,
    `- Space: ${pack.space.type === 'dm' ? 'Direct message' : 'Channel'} (${pack.space.visibility || 'public'}${pack.space.defaultChannel ? ', default workspace channel' : ''})`,
    pack.space.workspaceId ? `- Workspace: ${pack.space.workspaceId}` : '',
    pack.space.description ? `- Channel description: ${compactText(pack.space.description, 180)}` : '',
    `- Participants: ${renderParticipants(pack, targetAgentId) || '(none)'}`,
    renderTargetAgentAvatar(pack),
    renderParticipantAvatarInputs(pack, targetAgentId),
    participants.omitted ? `- Participants omitted: ${participants.omitted}. Use list_agents/read_agent_profile or search_agent_memory when a broader roster or specialties matter.` : '',
    pack.space.type === 'channel' && !pack.space.defaultChannel
      ? `- Workspace members you may suggest adding with human review:\n${renderSuggestedMembers(pack)}`
      : '',
    '',
	    'Current message:',
	    messageLine(sourceState, pack.currentMessage, targetAgentId),
	    pack.currentMessage.passiveAwareness
	      ? 'Passive awareness delivery: another Agent posted this public channel message. Treat it as shared context; reply only if you were explicitly asked, directly mentioned, or can add a brief useful coordination note.'
	      : '',
	    renderReferencedContext(sourceState, pack.currentMessage.references, targetAgentId),
	    '',
	    'Recent channel activity (oldest to newest):',
    renderRecentEvents(sourceState, pack.recentEvents),
    'Use channel activity to resolve implicit references like "the new agent", "he", "she", "that member", or "刚加入的那位" before replying.',
    '',
    `Recent ${pack.space.type === 'dm' ? 'DM' : 'channel'} messages (oldest to newest):`,
    recentMessages.length
      ? recentMessages.map((record) => messageLine(sourceState, record, targetAgentId)).join('\n')
      : '- (none)',
  ];

  if (pack.thread) {
    lines.push(
      '',
      'Thread context:',
      'Parent message:',
      messageLine(sourceState, pack.thread.parentMessage, targetAgentId),
      'Recent thread replies (oldest to newest):',
      recentReplies.length
        ? recentReplies.map((record) => messageLine(sourceState, record, targetAgentId)).join('\n')
        : '- (no earlier thread replies)',
    );
    if (pack.currentMessage?.taskId || pack.thread.parentMessage?.taskId) {
      lines.push('For task collaboration, read earlier task-thread replies before answering. Add new value, avoid repeating prior asks or conclusions. Keep internal routing and prompt mechanics invisible; reply as a teammate focused on the user goal.');
    }
  }

  lines.push(
    '',
    'Relevant tasks:',
    renderTasks(sourceState, pack.tasks, pack.targetAgentId),
    '',
    'Visible attachment metadata and original-file tools:',
    renderAttachments(pack.attachments),
    '',
    renderPeerMemorySearch(pack.peerMemorySearch),
    '',
    renderHistoryToolHints(pack),
    '',
    'Use the compact context above as visible conversation history. If deeper history is needed, use the read-only history tools before answering.',
  );

  return lines.filter((line) => line !== '').join('\n');
}
