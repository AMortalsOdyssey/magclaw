import { createTaskStartupCollaboration } from '../../task-startup-collaboration.js';
import { importAckPayload, invalidPathPayload, textPayload } from './cards.js';
import {
  extractChannelImportPath,
  invalidChannelPathReply,
  validateChannelImportPath,
} from './route-token.js';

function clean(value) {
  return String(value || '').trim();
}

function stripMarkup(value) {
  return String(value || '')
    .replace(/<at[^>]*>(.*?)<\/at>/gi, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function cleanFeishuText(value) {
  return stripMarkup(value).replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
}

function compact(value, max = 180) {
  const text = cleanFeishuText(value).replace(/\s+/g, ' ');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function traceIdDefault(now = new Date()) {
  const date = now instanceof Date ? now : new Date(now);
  const ymd = Number.isFinite(date.getTime())
    ? `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
    : 'unknown';
  return `fsc_${ymd}_${Math.random().toString(36).slice(2, 10)}`;
}

function metadataObject(record = {}) {
  if (!record.metadata || typeof record.metadata !== 'object' || Array.isArray(record.metadata)) {
    record.metadata = {};
  }
  return record.metadata;
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function feishuContextRecords(records = [], attachments = [], options = {}) {
  const attachmentIdsByMessage = new Map();
  for (const attachment of safeArray(attachments)) {
    const sourceMessageId = clean(attachment?.metadata?.origin?.sourceMessageId || attachment?.sourceMessageId || '');
    if (!sourceMessageId || !attachment?.id) continue;
    const ids = attachmentIdsByMessage.get(sourceMessageId) || [];
    ids.push(attachment.id);
    attachmentIdsByMessage.set(sourceMessageId, ids);
  }
  const sourceMessageId = clean(options.sourceMessageId);
  const routePath = clean(options.routePath);
  return safeArray(records).map((record, index) => {
    const id = clean(record.id || record.messageId);
    const text = textWithoutRoute(record.text || record.body || record.content, routePath);
    if (!text || (sourceMessageId && id === sourceMessageId) || /无法读取飞书引用消息/.test(text)) return null;
    const authorId = clean(record.authorId || record.sender?.id || '');
    const openId = clean(record.openId || record.sender?.openId || '');
    const unionId = clean(record.unionId || record.sender?.unionId || '');
    const userId = clean(record.userId || record.sender?.userId || '');
    const appId = clean(record.appId || record.sender?.appId || '');
    const senderType = clean(record.senderType || record.sender?.type || (appId ? 'bot' : 'user')) || 'user';
    return {
      id,
      author: cleanFeishuText(record.author || record.senderName || record.sender?.name || `Message ${index + 1}`),
      authorId,
      openId,
      unionId,
      userId,
      appId,
      senderType,
      isBot: Boolean(record.isBot || record.sender?.isBot || senderType === 'bot'),
      text,
      type: clean(record.type || record.messageType),
      createdAt: clean(record.createdAt),
      attachmentIds: attachmentIdsByMessage.get(id) || [],
    };
  }).filter(Boolean);
}

function serverNameFromState(state = {}) {
  return clean(state.connection?.name || state.cloud?.workspace?.name || state.cloud?.workspaces?.[0]?.name || 'Server');
}

function serverIdFromState(state = {}) {
  return clean(state.connection?.workspaceId || state.cloud?.workspace?.id || state.cloud?.workspaces?.[0]?.id || 'local');
}

function chatTypeFromHydrated(hydrated = {}) {
  return clean(
    hydrated.chat?.type
      || hydrated.chat?.chatType
      || hydrated.chat?.chatMode
      || hydrated.raw?.event?.message?.chat_type
      || hydrated.raw?.event?.message?.chatType
      || hydrated.raw?.message?.chat_type
      || hydrated.raw?.message?.chatType,
  ).toLowerCase();
}

function chatRequiresMention(hydrated = {}) {
  const type = chatTypeFromHydrated(hydrated);
  return type.includes('group') || type.includes('topic');
}

function shouldSilentlyIgnore(hydrated = {}, continuationRoot = null) {
  if (!chatRequiresMention(hydrated)) return false;
  if (hydrated.mentionedBot) return false;
  if (continuationRoot) return false;
  return true;
}

function textWithoutRoute(value = '', routePath = '') {
  let text = cleanFeishuText(value);
  if (routePath) text = cleanFeishuText(text.replace(routePath, ''));
  text = text.replace(/^[-*]\s*/, '').trim();
  return text;
}

function contextLine(record = {}, index, routePath = '', sourceMessageId = '') {
  const id = clean(record.id || record.messageId);
  const text = textWithoutRoute(record.text || record.body || record.content, routePath);
  if (!text) return '';
  if (sourceMessageId && id === sourceMessageId) return '';
  if (/无法读取飞书引用消息/.test(text)) return '';
  const author = cleanFeishuText(record.author || record.senderName || record.sender?.name || `Message ${index + 1}`);
  return `- ${author}: ${text}`;
}

function identityId(record = {}) {
  const senderType = clean(record.senderType || record.sender?.type || '').toLowerCase();
  return clean(
    record.authorId
      || record.id
      || record.sender?.id
      || (senderType === 'bot' ? record.appId || record.sender?.appId : record.openId || record.sender?.openId)
      || record.openId
      || record.sender?.openId
      || record.unionId
      || record.sender?.unionId
      || record.userId
      || record.sender?.userId
      || record.appId
      || record.sender?.appId,
  );
}

function senderTypeLabel(record = {}) {
  const raw = clean(record.senderType || record.sender?.type || '').toLowerCase();
  if (raw.includes('bot') || raw.includes('app') || record.isBot || record.sender?.isBot || record.appId || record.sender?.appId) return 'bot';
  return 'user';
}

function feishuIdType(record = {}) {
  const type = senderTypeLabel(record);
  if (type === 'bot' && clean(record.appId || record.sender?.appId || record.authorId || record.sender?.id)) return 'app_id';
  if (clean(record.openId || record.sender?.openId || record.authorId || record.id || record.sender?.id).startsWith('ou_')) return 'open_id';
  if (clean(record.unionId || record.sender?.unionId || record.authorId || record.id || record.sender?.id).startsWith('on_')) return 'union_id';
  if (clean(record.userId || record.sender?.userId)) return 'user_id';
  return type === 'bot' ? 'app_id' : 'open_id';
}

function identityName(record = {}, fallback = 'Feishu user') {
  return cleanFeishuText(record.name || record.author || record.senderName || record.sender?.name || fallback);
}

function identityLine(record = {}, role = '') {
  const name = identityName(record, role === 'trigger' ? 'Feishu trigger' : 'Feishu participant');
  const id = identityId(record);
  if (!name || !id) return '';
  return `- ${name} (${[role, senderTypeLabel(record), `${feishuIdType(record)}=${id}`].filter(Boolean).join(', ')})`;
}

function feishuIdentityLines(hydrated = {}) {
  const entries = [];
  const seen = new Set();
  function add(record, role) {
    const line = identityLine(record, role);
    const id = identityId(record);
    if (!line || !id || seen.has(id)) return;
    seen.add(id);
    entries.push(line);
  }
  add(hydrated.sender || {}, 'trigger');
  for (const record of safeArray(hydrated.records)) add(record, 'context');
  for (const mention of safeArray(hydrated.mentions)) {
    add({
      name: mention.name,
      author: mention.name,
      authorId: mention.id,
      openId: mention.id,
      senderType: mention.type || 'user',
    }, 'mentioned');
  }
  return entries.slice(0, 20);
}

function buildImportBody({ hydrated, traceId, target }) {
  const routePath = extractChannelImportPath(hydrated.text);
  const instruction = textWithoutRoute(hydrated.text, routePath);
  const contextLines = (hydrated.records || [])
    .map((record, index) => contextLine(record, index, routePath, hydrated.sourceMessageId))
    .filter(Boolean);
  const identityLines = feishuIdentityLines(hydrated);
  return [
    `Trace ID：${traceId}`,
    '',
    identityLines.length ? `Feishu identities:\n${identityLines.join('\n')}` : '',
    instruction ? `Instruction:\n${instruction}` : '',
    contextLines.length ? `Context:\n${contextLines.join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}

function feishuReferenceIds(hydrated = {}) {
  const sourceId = clean(hydrated.sourceMessageId);
  const ids = [
    clean(hydrated.parentMessageId),
    clean(hydrated.rootMessageId),
    ...safeArray(hydrated.relatedMessageIds).map(clean),
    ...safeArray(hydrated.records).map((record) => clean(record.id || record.messageId)),
  ].filter(Boolean);
  return [...new Set(ids.filter((id) => id !== sourceId))];
}

function feishuIdsForRecord(record = {}) {
  const metadata = record.metadata || {};
  const origin = metadata.origin || {};
  const externalImport = metadata.externalImport || {};
  const feishu = metadata.feishu || {};
  const delivery = metadata.externalDelivery?.feishu || {};
  return [
    origin.triggerMessageId,
    origin.parentMessageId,
    origin.rootMessageId,
    externalImport.triggerMessageId,
    feishu.sourceMessageId,
    feishu.parentMessageId,
    feishu.rootMessageId,
    feishu.ackMessageId,
    delivery.feishuMessageId,
  ].map(clean).filter(Boolean);
}

function recordMatchesFeishuReference(record, refIds = []) {
  if (!record || !refIds.length) return false;
  const owned = new Set(feishuIdsForRecord(record));
  return refIds.some((id) => owned.has(id));
}

function externalImportRootForReply(state = {}, reply = {}) {
  if (!reply?.parentMessageId) return null;
  return safeArray(state.messages).find((message) => message.id === reply.parentMessageId) || null;
}

function findContinuationRoot(state = {}, hydrated = {}) {
  const refIds = feishuReferenceIds(hydrated);
  if (!refIds.length) return null;
  const messages = safeArray(state.messages);
  for (const message of messages) {
    if (message.metadata?.systemKind === 'external_import' && recordMatchesFeishuReference(message, refIds)) return message;
  }
  for (const reply of safeArray(state.replies)) {
    if (!recordMatchesFeishuReference(reply, refIds)) continue;
    const root = externalImportRootForReply(state, reply);
    if (root?.metadata?.systemKind === 'external_import') return root;
  }
  return null;
}

function continuationAckPayload({ traceId, task, attachmentCount = 0 } = {}) {
  const lines = [
    '已追加到 MagClaw Thread',
    `Trace ID：${traceId}`,
    task?.number ? `Task：#${task.number} ${compact(task.title)}` : '',
    attachmentCount ? `附件：${attachmentCount}` : '',
  ].filter(Boolean);
  return textPayload(lines.join('\n'));
}

function explicitAgentIdsFromText(text = '', channelAgents = []) {
  const lower = String(text || '').toLowerCase();
  const ids = [];
  for (const agent of channelAgents) {
    const id = clean(agent?.id);
    const name = clean(agent?.name);
    if (!id) continue;
    if (lower.includes(id.toLowerCase()) || (name && lower.includes(`@${name.toLowerCase()}`))) ids.push(id);
  }
  return [...new Set(ids)];
}

export function createFeishuInboundImporter(deps = {}) {
  const {
    addCollabEvent = () => {},
    addSystemEvent = () => {},
    agentAvailableForAutoWork = () => true,
    broadcastState = () => {},
    channelAgentIds = () => [],
    createTaskFromMessage,
    deliverMessageToAgent,
    extractMentions = () => ({ agents: [], humans: [], special: [] }),
    feishuClient,
    findAgent = () => null,
    findChannel = () => null,
    findTaskForThreadMessage,
    getState = () => ({}),
    makeId = (prefix) => `${prefix}_${Date.now()}`,
    normalizeConversationRecord = (record) => record,
    now = () => new Date().toISOString(),
    persistState = async () => {},
    routeThreadReplyForChannel,
    saveAttachmentBuffer,
    scheduleAgentMemoryWriteback = () => Promise.resolve(false),
    startTaskStartupCollaboration: injectedStartTaskStartupCollaboration,
    traceIdFactory,
  } = deps;
  const startup = createTaskStartupCollaboration(deps);
  const startTaskStartupCollaboration = injectedStartTaskStartupCollaboration || startup.startTaskStartupCollaboration;

  async function saveFeishuAttachments(attachments = [], { workspaceId, traceId } = {}) {
    if (!Array.isArray(attachments) || !attachments.length || typeof saveAttachmentBuffer !== 'function') return [];
    const saved = [];
    for (const attachment of attachments) {
      if (!attachment?.buffer) continue;
      const item = await saveAttachmentBuffer({
        name: attachment.name || attachment.fileName || 'feishu-attachment',
        type: attachment.type || attachment.mimeType || 'application/octet-stream',
        buffer: Buffer.isBuffer(attachment.buffer) ? attachment.buffer : Buffer.from(attachment.buffer),
        source: 'feishu',
        extra: {
          workspaceId,
          serverId: workspaceId,
          metadata: {
            origin: {
              provider: 'feishu',
              traceId,
              resourceId: attachment.resourceId || attachment.fileKey || '',
              sourceMessageId: attachment.sourceMessageId || attachment.messageId || '',
              sourceCreatedAt: attachment.sourceCreatedAt || '',
            },
          },
        },
      });
      getState().attachments = Array.isArray(getState().attachments) ? getState().attachments : [];
      getState().attachments.push(item);
      saved.push(item);
    }
    return saved;
  }

  async function writeExternalImportMemory(agentIds = [], trigger, payload = {}) {
    const ids = [...new Set(safeArray(agentIds).map(clean).filter(Boolean))];
    if (!ids.length) return [];
    const writes = ids.map(async (id) => {
      const agent = findAgent(id);
      if (!agent) return { agentId: id, ok: false, reason: 'agent_not_found' };
      try {
        const ok = await scheduleAgentMemoryWriteback(agent, trigger, payload);
        return { agentId: id, ok: Boolean(ok) };
      } catch (error) {
        addSystemEvent('feishu_external_memory_error', `Feishu memory write failed for ${agent.name || id}: ${clean(error?.message || error)}`, {
          agentId: id,
          trigger,
          traceId: payload.externalImport?.traceId || payload.message?.metadata?.origin?.traceId || null,
        });
        return { agentId: id, ok: false, error: clean(error?.message || error) };
      }
    });
    return Promise.all(writes);
  }

  async function replyInvalid(event, rawPath) {
    const payload = invalidPathPayload(rawPath);
    if (feishuClient?.replyToEvent) await feishuClient.replyToEvent(event, payload).catch(() => null);
    return { ok: false, error: invalidChannelPathReply(rawPath), rawPath };
  }

  function taskForThreadMessage(message) {
    if (typeof findTaskForThreadMessage === 'function') return findTaskForThreadMessage(message);
    return safeArray(getState().tasks).find((task) => (
      task.threadMessageId === message?.id
      || task.messageId === message?.id
      || task.sourceMessageId === message?.id
    )) || null;
  }

  async function acknowledgeImport(event, message, payloadFactory) {
    if (!feishuClient?.replyToEvent) return null;
    const result = await feishuClient.replyToEvent(event, payloadFactory()).catch((error) => {
      addSystemEvent('feishu_import_ack_failed', `Feishu import ack failed: ${clean(error?.message || error)}`, {
        traceId: message?.metadata?.origin?.traceId || null,
      });
      return null;
    });
    const feishuMessageId = clean(result?.messageId || result?.message_id);
    if (!feishuMessageId || !message) return result;
    const metadata = metadataObject(message);
    metadata.externalDelivery = metadata.externalDelivery && typeof metadata.externalDelivery === 'object'
      ? metadata.externalDelivery
      : {};
    metadata.externalDelivery.feishu = {
      traceId: clean(metadata.origin?.traceId || metadata.externalImport?.traceId),
      status: 'sent',
      deliveryKind: 'import_ack',
      feishuMessageId,
      sentAt: now(),
    };
    metadata.feishu = metadata.feishu && typeof metadata.feishu === 'object' ? metadata.feishu : {};
    metadata.feishu.ackMessageId = feishuMessageId;
    return result;
  }

  async function routeContinuationReply(parentMessage, reply, text) {
    if (!parentMessage || !reply || typeof deliverMessageToAgent !== 'function') return null;
    if (parentMessage.spaceType !== 'channel') return null;
    const channel = findChannel(parentMessage.spaceId);
    const channelAgents = channel
      ? channelAgentIds(channel).map((id) => findAgent(id)).filter(Boolean).filter(agentAvailableForAutoWork)
      : [];
    if (!channelAgents.length) return null;
    const mentions = extractMentions(text || reply.body || '');
    const linkedTask = taskForThreadMessage(parentMessage);
    const fallbackTargetIds = [
      ...(Array.isArray(linkedTask?.assigneeIds) ? linkedTask.assigneeIds : []),
      linkedTask?.claimedBy,
      linkedTask?.assigneeId,
    ].map(clean).filter(Boolean);
    const routeDecision = typeof routeThreadReplyForChannel === 'function'
      ? await routeThreadReplyForChannel({
        channelAgents,
        mentions,
        parentMessage,
        reply,
        linkedTask,
        spaceId: parentMessage.spaceId,
      })
      : { targetAgentIds: [...new Set(fallbackTargetIds)] };
    const respondingAgents = safeArray(routeDecision?.targetAgentIds)
      .map((id) => channelAgents.find((agent) => agent.id === id))
      .filter(Boolean);
    for (const agent of respondingAgents) {
      deliverMessageToAgent(agent, parentMessage.spaceType, parentMessage.spaceId, reply, {
        parentMessageId: parentMessage.id,
      }).catch((error) => {
        addSystemEvent('delivery_error', `Failed to deliver Feishu thread reply to ${agent.name}: ${clean(error?.message || error)}`, {
          agentId: agent.id,
          replyId: reply.id,
          parentMessageId: parentMessage.id,
        });
      });
    }
    return routeDecision;
  }

  async function handleContinuationEvent(event, hydrated, parentMessage) {
    const state = getState();
    const text = cleanFeishuText(hydrated.text || event.text);
    const traceId = clean(parentMessage.metadata?.origin?.traceId || parentMessage.metadata?.externalImport?.traceId) || traceIdDefault(now());
    const workspaceId = parentMessage.workspaceId || serverIdFromState(state);
    const savedAttachments = await saveFeishuAttachments(hydrated.attachments || [], { workspaceId, traceId });
    const body = buildImportBody({ hydrated: { ...hydrated, text }, traceId, target: { channelId: parentMessage.spaceId } });
    const reply = normalizeConversationRecord({
      id: makeId('rep'),
      workspaceId,
      parentMessageId: parentMessage.id,
      spaceType: parentMessage.spaceType,
      spaceId: parentMessage.spaceId,
      authorType: 'system',
      authorId: 'system',
      body,
      attachmentIds: savedAttachments.map((item) => item.id).filter(Boolean),
      mentionedAgentIds: [],
      mentionedHumanIds: [],
      readBy: [],
      savedBy: [],
      metadata: {
        systemKind: 'external_import_reply',
        origin: {
          provider: 'feishu',
          traceId,
          chatId: clean(hydrated.chat?.id),
          chatName: clean(hydrated.chat?.name),
          chatType: clean(hydrated.chat?.type || hydrated.chat?.chatType || hydrated.chat?.chatMode),
          chatAvatar: clean(hydrated.chat?.avatar),
          senderId: clean(hydrated.sender?.id),
          senderOpenId: clean(hydrated.sender?.openId),
          senderUnionId: clean(hydrated.sender?.unionId),
          senderUserId: clean(hydrated.sender?.userId),
          senderAppId: clean(hydrated.sender?.appId),
          senderType: clean(hydrated.sender?.senderType),
          senderName: clean(hydrated.sender?.name),
          senderAvatar: clean(hydrated.sender?.avatar),
          triggerMessageId: clean(hydrated.sourceMessageId),
          parentMessageId: clean(hydrated.parentMessageId),
          rootMessageId: clean(hydrated.rootMessageId),
          threadId: clean(hydrated.threadId),
        },
        externalImport: {
          provider: 'feishu',
          replyPolicy: 'thread_all',
          syncEnabled: true,
          chatId: clean(hydrated.chat?.id),
          traceId,
          triggerMessageId: clean(hydrated.sourceMessageId),
          threadId: clean(hydrated.threadId),
        },
        feishu: {
          sourceMessageId: clean(hydrated.sourceMessageId),
          parentMessageId: clean(hydrated.parentMessageId),
          rootMessageId: clean(hydrated.rootMessageId),
          threadId: clean(hydrated.threadId),
          mentionedBot: Boolean(hydrated.mentionedBot),
          contextRecords: feishuContextRecords(hydrated.records, savedAttachments, {
            routePath: extractChannelImportPath(hydrated.text),
            sourceMessageId: hydrated.sourceMessageId,
          }),
          selectedRecordCount: Array.isArray(hydrated.records) ? hydrated.records.length : 0,
          attachmentCount: savedAttachments.length,
          skippedAttachmentCount: Array.isArray(hydrated.attachments)
            ? hydrated.attachments.filter((attachment) => attachment?.skipped || !attachment?.buffer).length
            : 0,
          skippedReferenceCount: Array.isArray(hydrated.skippedReferenceIds) ? hydrated.skippedReferenceIds.length : 0,
        },
      },
      createdAt: now(),
      updatedAt: now(),
    });
    state.replies = Array.isArray(state.replies) ? state.replies : [];
    state.replies.push(reply);
    parentMessage.replyCount = Math.max(
      Number(parentMessage.replyCount || 0) + 1,
      state.replies.filter((item) => item.parentMessageId === parentMessage.id).length,
    );
    parentMessage.updatedAt = now();
    const task = taskForThreadMessage(parentMessage);
    addCollabEvent('feishu_import_continued', 'Feishu message appended to existing MagClaw thread.', {
      traceId,
      messageId: parentMessage.id,
      replyId: reply.id,
      taskId: task?.id || null,
      channelId: parentMessage.spaceId,
    });
    addSystemEvent('feishu_import_continued', `Feishu import ${traceId} continued.`, {
      traceId,
      messageId: parentMessage.id,
      replyId: reply.id,
      taskId: task?.id || null,
      channelId: parentMessage.spaceId,
    });
    const routeDecision = await routeContinuationReply(parentMessage, reply, text);
    const memoryAgentIds = safeArray(routeDecision?.targetAgentIds).length
      ? routeDecision.targetAgentIds
      : [
        ...safeArray(task?.assigneeIds),
        task?.claimedBy,
        task?.assigneeId,
      ];
    await writeExternalImportMemory(memoryAgentIds, 'external_import_reply', {
      message: reply,
      parentMessage,
      task,
      channel: findChannel(parentMessage.spaceId),
      externalImport: {
        provider: 'feishu',
        traceId,
      },
    });
    await acknowledgeImport(event, reply, () => continuationAckPayload({
      traceId,
      task,
      attachmentCount: savedAttachments.length,
    }));
    await persistState({ workspaceId, reason: 'feishu_import_continued' });
    broadcastState();
    return { ok: true, continued: true, traceId, message: parentMessage, reply, task, attachments: savedAttachments };
  }

  async function handleMessageEvent(event = {}) {
    const hydrated = feishuClient?.hydrateEvent ? await feishuClient.hydrateEvent(event) : event;
    const text = cleanFeishuText(hydrated.text || event.text);
    const routePath = extractChannelImportPath(text);
    const continuationRoot = !routePath ? findContinuationRoot(getState(), hydrated) : null;
    if (shouldSilentlyIgnore(hydrated, continuationRoot)) {
      addSystemEvent('feishu_import_skipped_no_mention', 'Feishu group/topic message ignored because it did not mention the bot.', {
        chatId: clean(hydrated.chat?.id),
        sourceMessageId: clean(hydrated.sourceMessageId),
      });
      return { ok: false, skipped: true, reason: 'not_mentioned' };
    }
    if (!routePath) {
      if (continuationRoot) return handleContinuationEvent(event, hydrated, continuationRoot);
      return replyInvalid(event, text || '(empty)');
    }
    const target = validateChannelImportPath(routePath, { getState, findChannel });
    if (!target.ok) return replyInvalid(event, routePath);

    const state = getState();
    const traceId = typeof traceIdFactory === 'function' ? traceIdFactory() : traceIdDefault(now());
    const workspaceId = target.serverId || serverIdFromState(state);
    const savedAttachments = await saveFeishuAttachments(hydrated.attachments || [], { workspaceId, traceId });
    const body = buildImportBody({ hydrated: { ...hydrated, text }, traceId, target });
    const message = normalizeConversationRecord({
      id: makeId('msg'),
      workspaceId,
      spaceType: 'channel',
      spaceId: target.channelId,
      authorType: 'system',
      authorId: 'system',
      body,
      attachmentIds: savedAttachments.map((item) => item.id).filter(Boolean),
      mentionedAgentIds: [],
      mentionedHumanIds: [],
      readBy: [],
      replyCount: 0,
      savedBy: [],
      metadata: {
        systemKind: 'external_import',
        origin: {
          provider: 'feishu',
          traceId,
          chatId: clean(hydrated.chat?.id),
          chatName: clean(hydrated.chat?.name),
          chatType: clean(hydrated.chat?.type || hydrated.chat?.chatType || hydrated.chat?.chatMode),
          chatAvatar: clean(hydrated.chat?.avatar),
          senderId: clean(hydrated.sender?.id),
          senderOpenId: clean(hydrated.sender?.openId),
          senderUnionId: clean(hydrated.sender?.unionId),
          senderUserId: clean(hydrated.sender?.userId),
          senderAppId: clean(hydrated.sender?.appId),
          senderType: clean(hydrated.sender?.senderType),
          senderName: clean(hydrated.sender?.name),
          senderAvatar: clean(hydrated.sender?.avatar),
          triggerMessageId: clean(hydrated.sourceMessageId),
          parentMessageId: clean(hydrated.parentMessageId),
          rootMessageId: clean(hydrated.rootMessageId),
          threadId: clean(hydrated.threadId),
        },
        externalImport: {
          provider: 'feishu',
          replyPolicy: 'thread_all',
          syncEnabled: true,
          chatId: clean(hydrated.chat?.id),
          traceId,
          triggerMessageId: clean(hydrated.sourceMessageId),
          threadId: clean(hydrated.threadId),
        },
        feishu: {
          sourceMessageId: clean(hydrated.sourceMessageId),
          parentMessageId: clean(hydrated.parentMessageId),
          rootMessageId: clean(hydrated.rootMessageId),
          threadId: clean(hydrated.threadId),
          mentionedBot: Boolean(hydrated.mentionedBot),
          contextRecords: feishuContextRecords(hydrated.records, savedAttachments, {
            routePath,
            sourceMessageId: hydrated.sourceMessageId,
          }),
          selectedRecordCount: Array.isArray(hydrated.records) ? hydrated.records.length : 0,
          attachmentCount: savedAttachments.length,
          skippedAttachmentCount: Array.isArray(hydrated.attachments)
            ? hydrated.attachments.filter((attachment) => attachment?.skipped || !attachment?.buffer).length
            : 0,
          skippedReferenceCount: Array.isArray(hydrated.skippedReferenceIds) ? hydrated.skippedReferenceIds.length : 0,
        },
      },
      createdAt: now(),
      updatedAt: now(),
    });
    state.messages.push(message);

    const channelAgents = channelAgentIds(target.channel)
      .map((id) => findAgent(id))
      .filter(Boolean);
    const explicitAgentIds = explicitAgentIdsFromText(text, channelAgents);
    const selectedAgentIds = explicitAgentIds.length ? explicitAgentIds : channelAgents.map((agent) => agent.id);
    const firstContextTitle = (hydrated.records || [])
      .map((record, index) => contextLine(record, index, routePath, hydrated.sourceMessageId))
      .find(Boolean);
    const taskTitle = compact(textWithoutRoute(text, routePath) || firstContextTitle, 100) || `Feishu import ${traceId}`;
    const task = createTaskFromMessage(message, taskTitle, {
      assigneeIds: selectedAgentIds,
      createdBy: 'system',
      metadata: {
        systemKind: 'external_import',
        origin: message.metadata.origin,
        externalImport: message.metadata.externalImport,
      },
    });
    metadataObject(task).systemKind = 'external_import';
    metadataObject(task).origin = message.metadata.origin;
    metadataObject(task).externalImport = message.metadata.externalImport;
    message.taskId = task?.id || message.taskId;
    await writeExternalImportMemory(selectedAgentIds, 'external_import', {
      message,
      task,
      channel: target.channel,
      externalImport: {
        provider: 'feishu',
        traceId,
      },
    });

    addCollabEvent('feishu_import_created', 'Feishu message imported into MagClaw.', {
      traceId,
      messageId: message.id,
      taskId: task?.id || null,
      channelId: target.channelId,
    });
    addSystemEvent('feishu_import_created', `Feishu import ${traceId} created.`, {
      traceId,
      messageId: message.id,
      taskId: task?.id || null,
      channelId: target.channelId,
    });
    if (selectedAgentIds.length && task && typeof startTaskStartupCollaboration === 'function') {
      await startTaskStartupCollaboration(task, message, selectedAgentIds);
    }
    await persistState({ workspaceId, reason: 'feishu_import_created' });
    broadcastState();

    await acknowledgeImport(event, message, () => importAckPayload({
        traceId,
        serverName: serverNameFromState(state),
        channelName: target.channel?.name,
        task,
        attachmentCount: savedAttachments.length,
      }));
    await persistState({ workspaceId, reason: 'feishu_import_ack_recorded' });

    return { ok: true, traceId, message, task, attachments: savedAttachments };
  }

  return { handleMessageEvent };
}
