import { threadReplyPayload } from './cards.js';

function clean(value) {
  return String(value || '').trim();
}

function metadataObject(record = {}) {
  if (!record.metadata || typeof record.metadata !== 'object' || Array.isArray(record.metadata)) {
    record.metadata = {};
  }
  return record.metadata;
}

function originForParent(parent = {}) {
  const metadata = parent?.metadata || {};
  const origin = metadata.origin || {};
  const externalImport = metadata.externalImport || {};
  if (origin.provider !== 'feishu' && externalImport.provider !== 'feishu') return null;
  if (externalImport.syncEnabled === false) return null;
  return {
    traceId: clean(origin.traceId || externalImport.traceId),
    chatId: clean(origin.chatId || externalImport.chatId),
    triggerMessageId: clean(origin.triggerMessageId || externalImport.triggerMessageId),
    threadId: clean(origin.threadId || externalImport.threadId),
    chatType: clean(origin.chatType || externalImport.chatType),
    replyPolicy: clean(externalImport.replyPolicy || 'thread_all'),
  };
}

export function createFeishuOutboundSync(deps = {}) {
  const {
    addSystemEvent = () => {},
    broadcastState = () => {},
    feishuClient,
    findAgent = () => null,
    findHuman = () => null,
    findMessage,
    getState = () => ({}),
    now = () => new Date().toISOString(),
    persistState = async () => {},
  } = deps;

  function parentForReply(reply = {}) {
    if (!reply?.parentMessageId) return null;
    if (typeof findMessage === 'function') return findMessage(reply.parentMessageId);
    return (getState().messages || []).find((message) => message.id === reply.parentMessageId) || null;
  }

  function actorName(reply = {}) {
    if (reply.authorType === 'agent') return findAgent(reply.authorId)?.name || reply.authorId || 'Agent';
    if (reply.authorType === 'human') return findHuman(reply.authorId)?.name || reply.authorId || 'Human';
    return 'MagClaw';
  }

  async function syncReply(reply = {}, options = {}) {
    const parent = options.parentMessage || parentForReply(reply);
    const origin = originForParent(parent);
    if (!origin || origin.replyPolicy !== 'thread_all') return { skipped: true, reason: 'not_feishu_thread' };
    const replyMetadata = metadataObject(reply);
    const existing = replyMetadata.externalDelivery?.feishu || {};
    if (existing.status === 'sent' && existing.feishuMessageId) return { skipped: true, reason: 'already_sent' };
    if (replyMetadata.origin?.provider === 'feishu') return { skipped: true, reason: 'source_is_feishu' };
    if (!feishuClient || typeof feishuClient.sendThreadReply !== 'function') return { skipped: true, reason: 'missing_client' };

    const rendered = threadReplyPayload({
      traceId: origin.traceId,
      actorName: actorName(reply),
      actorType: reply.authorType,
      body: reply.body || '',
      attachmentCount: Array.isArray(reply.attachmentIds) ? reply.attachmentIds.length : 0,
    });
    const payload = {
      traceId: origin.traceId,
      chatId: origin.chatId,
      triggerMessageId: origin.triggerMessageId,
      replyInThread: Boolean(origin.threadId || origin.chatType.toLowerCase().includes('topic')),
      replyId: reply.id,
      actorName: actorName(reply),
      actorType: reply.authorType,
      body: reply.body || '',
      attachmentIds: Array.isArray(reply.attachmentIds) ? reply.attachmentIds : [],
      attachmentCount: Array.isArray(reply.attachmentIds) ? reply.attachmentIds.length : 0,
      msgType: rendered.msg_type,
      content: rendered.content,
    };

    replyMetadata.externalDelivery = replyMetadata.externalDelivery && typeof replyMetadata.externalDelivery === 'object'
      ? replyMetadata.externalDelivery
      : {};
    replyMetadata.externalDelivery.feishu = {
      traceId: origin.traceId,
      status: 'sending',
      updatedAt: now(),
    };
    try {
      const result = await feishuClient.sendThreadReply(payload);
      replyMetadata.externalDelivery.feishu = {
        traceId: origin.traceId,
        status: 'sent',
        feishuMessageId: clean(result?.messageId || result?.message_id),
        sentAt: now(),
      };
      await persistState({ workspaceId: parent.workspaceId || '', reason: 'feishu_reply_sent' });
      broadcastState();
      return { ok: true, payload, result };
    } catch (error) {
      replyMetadata.externalDelivery.feishu = {
        traceId: origin.traceId,
        status: 'failed',
        error: clean(error?.message || error),
        updatedAt: now(),
      };
      addSystemEvent('feishu_reply_send_failed', `Feishu reply sync failed: ${clean(error?.message || error)}`, {
        traceId: origin.traceId,
        replyId: reply.id,
        parentMessageId: parent.id,
      });
      await persistState({ workspaceId: parent.workspaceId || '', reason: 'feishu_reply_failed' }).catch(() => {});
      broadcastState();
      return { ok: false, error };
    }
  }

  return { syncReply };
}
