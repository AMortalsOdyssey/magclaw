import { importAckPayload, textPayload, threadReplyPayload } from './cards.js';
import {
  isLikelyFeishuId,
  safeFeishuDisplayName,
} from './identity-display.js';

function parseJson(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return {};
  }
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

function cleanText(value) {
  return stripMarkup(value).replace(/\r\n?/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
}

function cleanUrl(value) {
  const text = cleanText(value);
  return /^https?:\/\//i.test(text) ? text : '';
}

function cellLink(cell = {}) {
  return cleanUrl(
    cell.href
      || cell.url
      || cell.link
      || cell.text_link?.url
      || cell.doc_url
      || cell.docUrl
      || cell.record_url
      || cell.recordUrl
      || '',
  );
}

function cellLabel(cell = {}) {
  return cleanText(
    cell.text
      || cell.name
      || cell.title
      || cell.file_name
      || cell.fileName
      || cell.doc_name
      || cell.docName
      || cell.token
      || cell.file_key
      || cell.image_key
      || '',
  );
}

function postCellText(cell = {}) {
  if (!cell || typeof cell !== 'object') return '';
  const tag = cleanText(cell.tag).toLowerCase();
  const link = cellLink(cell);
  const label = cellLabel(cell);
  if (link) return label ? `${label} (${link})` : link;
  if (label) return label;
  if (tag === 'img' && cell.image_key) return '[Image]';
  if (tag === 'media' && cell.file_key) return `[File: ${cell.file_name || cell.file_key}]`;
  if (tag.includes('doc') || tag === 'docs') return `[Feishu doc: ${cell.token || cell.obj_token || 'unknown'}]`;
  return '';
}

function extractFeishuDocLinks(text = '') {
  const links = [];
  const re = /https?:\/\/[^\s)>\]]+/gi;
  for (const match of String(text || '').matchAll(re)) {
    const url = match[0];
    const tokenMatch = url.match(/\/(?:docx|docs|wiki|file|mindnotes|base)\/([A-Za-z0-9]+)/i);
    if (!tokenMatch) continue;
    links.push({
      url,
      token: tokenMatch[1],
      type: tokenMatch[0].split('/')[1] || 'doc',
    });
  }
  return links;
}

function textFromPostItems(items = []) {
  const parts = [];
  const rows = Array.isArray(items) ? items : [];
  for (const row of rows) {
    const cells = Array.isArray(row) ? row : [row];
    for (const cell of cells) {
      if (!cell || typeof cell !== 'object') continue;
      const text = postCellText(cell);
      if (text) parts.push(text);
    }
  }
  return cleanText(parts.join(' '));
}

function mentionNameLooksUnreadable(value = '') {
  const text = cleanText(value).replace(/^@+/, '');
  return !text || /^_?user_\d+$/i.test(text) || isLikelyFeishuId(text);
}

function readableMentionName(value = '') {
  const text = cleanText(value).replace(/^@+/, '');
  return mentionNameLooksUnreadable(text) ? '' : text;
}

function unresolvedMentionLabel(id = '') {
  return safeFeishuDisplayName('', {
    fallbackId: id,
    kind: 'user',
    fallback: '无法读取飞书用户或 Bot 名称，请申请飞书通讯录权限',
  });
}

function mentionToken(value = '') {
  const text = cleanText(value);
  if (!text) return '';
  return text.startsWith('@') ? text : `@${text}`;
}

function atAttributeValue(attrs = '', name = '') {
  const match = String(attrs || '').match(new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`, 'i'));
  return cleanText(match?.[1] || '');
}

function textWithMentionNames(value, mentions = [], mentionDisplayMap = new Map()) {
  let index = 0;
  let text = String(value || '');
  for (const mention of safeMentions(mentions)) {
    const key = cleanText(mention.key || mention.text || '');
    const openId = mentionOpenId(mention);
    const name = mentionDisplayMap.get(openId)
      || mentionDisplayMap.get(key)
      || readableMentionName(mentionName(mention))
      || unresolvedMentionLabel();
    if (key && name) text = text.replaceAll(key, mentionToken(name));
  }
  text = text.replace(/<at\b([^>]*)>(.*?)<\/at>/gi, (match, attrs, rawLabel) => {
    const mention = safeMentions(mentions)[index] || {};
    index += 1;
    const openId = atAttributeValue(attrs, 'open_id') || atAttributeValue(attrs, 'user_id') || atAttributeValue(attrs, 'id') || mentionOpenId(mention);
    const name = mentionDisplayMap.get(openId)
      || mentionDisplayMap.get(cleanText(rawLabel))
      || readableMentionName(mentionName(mention))
      || readableMentionName(rawLabel)
      || unresolvedMentionLabel();
    return mentionToken(name);
  });
  return text;
}

function textFromContent(content, mentionDisplayMap = new Map()) {
  const json = parseJson(content);
  if (typeof json.text === 'string') return cleanText(textWithMentionNames(json.text, json.mentions, mentionDisplayMap));
  if (typeof json.content === 'string') return cleanText(textWithMentionNames(json.content, json.mentions, mentionDisplayMap));
  if (Array.isArray(json.content)) {
    return textFromPostItems(json.content);
  }
  if (json.image_key) return '[Image]';
  if (json.file_key) return `[File: ${json.file_name || json.name || json.file_key}]`;
  return cleanText(textWithMentionNames(content || '', [], mentionDisplayMap));
}

function resourceName(resource = {}) {
  const ext = resource.type === 'image' ? 'png' : 'bin';
  return resource.fileName || resource.name || `${resource.type || 'file'}-${resource.fileKey || 'resource'}.${ext}`;
}

function collectResourcesFromPost(content = {}) {
  const resources = [];
  const rows = Array.isArray(content.content) ? content.content : [];
  for (const row of rows) {
    const cells = Array.isArray(row) ? row : [row];
    for (const cell of cells) {
      if (!cell || typeof cell !== 'object') continue;
      if (cell.tag === 'img' && cell.image_key) resources.push({ type: 'image', fileKey: cell.image_key });
      if (cell.tag === 'media' && cell.file_key) resources.push({ type: 'file', fileKey: cell.file_key, fileName: cell.file_name });
    }
  }
  return resources;
}

function messageContent(message = {}) {
  return message.content ?? message.body?.content ?? '';
}

function safeMentions(value) {
  return Array.isArray(value) ? value : [];
}

function messageMentions(message = {}) {
  const content = parseJson(messageContent(message));
  return safeMentions(message.mentions || message.mention_list || message.mentions_v2 || content.mentions);
}

function mentionOpenId(mention = {}) {
  const id = mention.id || mention.user_id || mention.userId || mention.tenant_key || {};
  if (typeof id === 'string') return cleanText(id);
  return cleanText(id.open_id || id.openId || mention.open_id || mention.openId || mention.user_id || mention.userId || '');
}

function mentionName(mention = {}) {
  return cleanText(mention.name || mention.text || mention.key || mention.id?.name || '');
}

function messageMentionedBot(message = {}, botOpenId = '') {
  const mentions = messageMentions(message);
  if (botOpenId) return mentions.some((mention) => mentionOpenId(mention) === botOpenId);
  if (mentions.length > 0) return true;
  const raw = String(messageContent(message) || '');
  return /<at\b/i.test(raw) || /"tag"\s*:\s*"at"/i.test(raw);
}

function messageMentionedAll(message = {}) {
  const raw = String(messageContent(message) || '').toLowerCase();
  return messageMentions(message).some((mention) => /all|everyone|here|全员/.test(mentionName(mention).toLowerCase()))
    || /@all|@everyone|@here|全员/.test(raw);
}

function collectMessageResources(message = {}) {
  const content = parseJson(messageContent(message));
  const type = String(message.message_type || message.msg_type || '').trim();
  if (type === 'image' && content.image_key) return [{ type: 'image', fileKey: content.image_key }];
  if (['file', 'audio', 'media'].includes(type) && content.file_key) {
    return [{ type: 'file', fileKey: content.file_key, fileName: content.file_name || content.name }];
  }
  if (type === 'post') return collectResourcesFromPost(content);
  return [];
}

function messageType(message = {}) {
  return String(message.message_type || message.msg_type || '').trim();
}

function messageId(message = {}) {
  return message.message_id || message.messageId || '';
}

function parentMessageId(message = {}) {
  return message.parent_id || message.parentId || '';
}

function rootMessageId(message = {}) {
  return message.root_id || message.rootId || '';
}

function threadMessageId(message = {}) {
  return message.thread_id || message.threadId || message.message_thread_id || message.messageThreadId || '';
}

function senderName(message = {}) {
  const sender = message.sender || {};
  const senderId = sender.sender_id || sender.senderId || {};
  const explicit = cleanText(sender.name || sender.sender_name || sender.senderName || '');
  const fallbackId = cleanText(
    senderId.user_id
      || sender.user_id
      || sender.userId
      || sender.id
      || senderId.open_id
      || sender.open_id
      || sender.openId
      || senderId.app_id
      || sender.app_id
      || sender.appId
      || '',
  );
  if (explicit || fallbackId) {
    return safeFeishuDisplayName(explicit, {
      fallbackId,
      kind: rawSenderType(sender).includes('bot') || rawSenderType(sender).includes('app') ? 'bot' : 'user',
      fallback: 'Feishu',
    });
  }
  return message.sender?.name
    || message.sender?.sender_name
    || message.sender?.senderName
    || message.sender?.sender_id?.user_id
    || message.sender?.id
    || message.sender?.sender_id?.open_id
    || message.sender?.sender_id?.app_id
    || 'Feishu';
}

function messageCreatedAt(message = {}) {
  const raw = cleanText(message.create_time || message.createTime || message.created_at || message.createdAt || '');
  if (!raw) return '';
  const num = Number(raw);
  if (Number.isFinite(num)) {
    const ms = raw.length <= 10 ? num * 1000 : num;
    const date = new Date(ms);
    return Number.isFinite(date.getTime()) ? date.toISOString() : '';
  }
  const date = new Date(raw);
  return Number.isFinite(date.getTime()) ? date.toISOString() : '';
}

function bestUserName(user = {}) {
  return cleanText(user.name || user.nickname || user.en_name || user.i18n_name?.zh_cn || user.i18n_name?.en_us || '');
}

function bestUserAvatar(user = {}) {
  return cleanText(user.avatar?.avatar_72 || user.avatar?.avatar_240 || user.avatar?.avatar_origin || user.avatar_url || '');
}

function bestAvatarUrl(value) {
  if (!value) return '';
  if (typeof value === 'string') return cleanText(value);
  if (typeof value !== 'object') return '';
  return cleanText(value.avatar_72 || value.avatar_240 || value.avatar_origin || value.avatar_url || value.url || '');
}

function bestChatAvatar(chat = {}) {
  return cleanText(
    bestAvatarUrl(chat.avatar)
      || bestAvatarUrl(chat.avatar_url)
      || bestAvatarUrl(chat.avatarUrl)
      || '',
  );
}

function senderIds(sender = {}) {
  const senderId = sender.sender_id || sender.senderId || {};
  return {
    openId: cleanText(senderId.open_id || sender.open_id || sender.openId || ''),
    unionId: cleanText(senderId.union_id || sender.union_id || sender.unionId || ''),
    userId: cleanText(senderId.user_id || sender.user_id || sender.userId || ''),
    appId: cleanText(senderId.app_id || sender.app_id || sender.appId || ''),
  };
}

function messageSenderIds(message = {}) {
  const ids = senderIds(message.sender || {});
  if (!ids.openId && message.sender?.id_type === 'open_id') ids.openId = cleanText(message.sender.id || '');
  if (!ids.appId && message.sender?.id_type === 'app_id') ids.appId = cleanText(message.sender.id || '');
  return ids;
}

function rawSenderName(sender = {}) {
  const ids = senderIds(sender);
  const explicit = cleanText(sender.name || sender.sender_name || sender.senderName || '');
  return safeFeishuDisplayName(explicit, {
    fallbackId: ids.userId || ids.openId || ids.appId || ids.unionId || sender.id || '',
    kind: normalizedSenderType(sender, ids),
    fallback: '',
  });
}

function rawSenderType(sender = {}) {
  return cleanText(sender.sender_type || sender.senderType || sender.type || sender.id_type || sender.idType || '').toLowerCase();
}

function normalizedSenderType(sender = {}, ids = senderIds(sender)) {
  const raw = rawSenderType(sender);
  if (raw.includes('app') || raw.includes('bot')) return 'bot';
  if (ids.appId && !ids.openId && !ids.userId && !ids.unionId) return 'bot';
  return 'user';
}

function recordFromMessage(message = {}, senderProfile = {}, mentionDisplayMap = new Map()) {
  const ids = messageSenderIds(message);
  const senderType = senderProfile.senderType || normalizedSenderType(message.sender || {}, ids);
  const authorId = cleanText(
    senderProfile.id
      || (senderType === 'bot' ? ids.appId : ids.openId)
      || ids.openId
      || ids.unionId
      || ids.userId
      || ids.appId,
  );
  return {
    id: messageId(message),
    author: senderProfile.name || senderName(message),
    authorId,
    openId: cleanText(senderProfile.openId || ids.openId),
    unionId: cleanText(senderProfile.unionId || ids.unionId),
    userId: cleanText(senderProfile.userId || ids.userId),
    appId: cleanText(senderProfile.appId || ids.appId),
    senderType,
    isBot: Boolean(senderProfile.isBot || senderType === 'bot'),
    sender: {
      id: authorId,
      openId: cleanText(senderProfile.openId || ids.openId),
      unionId: cleanText(senderProfile.unionId || ids.unionId),
      userId: cleanText(senderProfile.userId || ids.userId),
      appId: cleanText(senderProfile.appId || ids.appId),
      type: senderType,
      isBot: Boolean(senderProfile.isBot || senderType === 'bot'),
      name: senderProfile.name || senderName(message),
      avatar: senderProfile.avatar || '',
    },
    text: textFromContent(messageContent(message), mentionDisplayMap),
    type: messageType(message),
    createdAt: messageCreatedAt(message),
  };
}

function dedupeMessages(messages = []) {
  const seen = new Set();
  const results = [];
  for (const message of messages) {
    const id = messageId(message);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    results.push(message);
  }
  return results;
}

async function readableToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function loadLarkSdk() {
  return import('@larksuiteoapi/node-sdk');
}

export async function createFeishuConnectClient(config, options = {}) {
  const Lark = options.larkSdk || await loadLarkSdk();
  const domain = String(config.tenant || '').toLowerCase() === 'lark'
    ? Lark.Domain?.Lark
    : Lark.Domain?.Feishu;
  const baseConfig = {
    appId: config.appId,
    appSecret: config.appSecret,
    ...(domain ? { domain } : {}),
  };
  const client = options.client || new Lark.Client(baseConfig);
  const userCache = new Map();
  const chatCache = new Map();
  const botOpenId = cleanText(options.botOpenId || config.botOpenId || '');
  let wsClient = null;

  function normalizeEvent(data = {}) {
    const message = data.message || data.event?.message || data;
    const sender = data.sender || data.event?.sender || {};
    return {
      raw: data,
      text: textFromContent(messageContent(message)),
      message,
      sender,
      chat: {
        id: message.chat_id || message.chatId || '',
        name: message.chat_name || message.chatName || '',
        type: message.chat_type || message.chatType || message.chat_mode || message.chatMode || '',
      },
      sourceMessageId: message.message_id || message.messageId || '',
    };
  }

  async function resolveUserByOpenId(openId, fallback = {}) {
    const cleanOpenId = cleanText(openId);
    if (!cleanOpenId) return fallback;
    if (userCache.has(cleanOpenId)) return userCache.get(cleanOpenId);
    let profile = { ...fallback, id: cleanOpenId, openId: cleanOpenId };
    try {
      const res = await client.contact?.v3?.user?.basicBatch?.({
        data: { user_ids: [cleanOpenId] },
        params: { user_id_type: 'open_id' },
      });
      const user = res?.data?.users?.[0] || null;
      if (user) profile = { ...profile, name: bestUserName(user) || profile.name };
    } catch {
      // Name lookup is best-effort; keep event IDs in metadata only.
    }
    try {
      const res = await client.contact?.v3?.user?.batch?.({
        params: { user_ids: [cleanOpenId], user_id_type: 'open_id' },
      });
      const user = res?.data?.items?.[0] || null;
      if (user) {
        profile = {
          ...profile,
          name: bestUserName(user) || profile.name,
          avatar: bestUserAvatar(user) || profile.avatar || '',
        };
      }
    } catch {
      // Avatar lookup may need broader contact permissions; do not fail import.
    }
    profile = {
      ...profile,
      name: safeFeishuDisplayName(profile.name, {
        fallbackId: profile.userId || cleanOpenId,
        kind: 'user',
      }),
    };
    userCache.set(cleanOpenId, profile);
    return profile;
  }

  async function resolveSender(sender = {}) {
    const ids = senderIds(sender);
    const fallbackName = rawSenderName(sender);
    const senderType = normalizedSenderType(sender, ids);
    if (senderType === 'bot') {
      return {
        id: ids.appId || ids.openId || ids.unionId || ids.userId || '',
        openId: ids.openId || '',
        unionId: ids.unionId || '',
        userId: ids.userId || '',
        appId: ids.appId || '',
        name: safeFeishuDisplayName(fallbackName, {
          fallbackId: ids.appId || ids.openId || ids.userId || ids.unionId,
          kind: 'bot',
          fallback: 'Feishu Bot',
        }),
        avatar: '',
        senderType,
        isBot: true,
      };
    }
    const profile = await resolveUserByOpenId(ids.openId, {
      id: ids.openId || ids.unionId || ids.userId,
      openId: ids.openId,
      unionId: ids.unionId,
      userId: ids.userId,
      name: fallbackName,
      avatar: '',
    });
    return {
      id: profile.openId || profile.id || ids.openId || ids.unionId || ids.userId || '',
      openId: profile.openId || ids.openId || '',
      unionId: profile.unionId || ids.unionId || '',
      userId: profile.userId || ids.userId || '',
      name: safeFeishuDisplayName(profile.name || fallbackName, {
        fallbackId: ids.userId || ids.openId || ids.unionId,
        kind: 'user',
        fallback: 'Feishu user',
      }),
      avatar: cleanText(profile.avatar || ''),
      senderType,
      isBot: false,
    };
  }

  async function resolveMessageSender(message = {}) {
    const ids = messageSenderIds(message);
    const senderType = normalizedSenderType(message.sender || {}, ids);
    if (senderType === 'bot') {
      return {
        id: ids.appId || ids.openId || ids.unionId || ids.userId || '',
        openId: ids.openId || '',
        unionId: ids.unionId || '',
        userId: ids.userId || '',
        appId: ids.appId || '',
        name: safeFeishuDisplayName(senderName(message), {
          fallbackId: ids.appId || ids.openId || ids.userId || ids.unionId,
          kind: 'bot',
          fallback: 'Feishu Bot',
        }),
        avatar: '',
        senderType,
        isBot: true,
      };
    }
    if (!ids.openId) {
      return {
        id: ids.userId || ids.unionId || '',
        openId: '',
        unionId: ids.unionId || '',
        userId: ids.userId || '',
        appId: '',
        name: safeFeishuDisplayName(senderName(message), {
          fallbackId: ids.userId || ids.unionId,
          kind: 'user',
          fallback: 'Feishu user',
        }),
        avatar: '',
        senderType,
        isBot: false,
      };
    }
    const profile = await resolveUserByOpenId(ids.openId, {
      id: ids.openId,
      openId: ids.openId,
      unionId: ids.unionId,
      userId: ids.userId,
      name: safeFeishuDisplayName(senderName(message), {
        fallbackId: ids.userId || ids.openId || ids.unionId,
        kind: 'user',
        fallback: 'Feishu user',
      }),
      avatar: '',
    });
    return {
      ...profile,
      id: profile.openId || profile.id || ids.openId,
      openId: profile.openId || ids.openId,
      unionId: profile.unionId || ids.unionId || '',
      userId: profile.userId || ids.userId || '',
      appId: '',
      senderType,
      isBot: false,
    };
  }

  async function resolveMentionDisplayMap(messages = []) {
    const displayMap = new Map();
    const mentions = [];
    for (const message of messages) mentions.push(...messageMentions(message));
    for (const mention of mentions) {
      const openId = mentionOpenId(mention);
      const key = cleanText(mention.key || mention.text || '');
      let name = readableMentionName(mentionName(mention));
      if (!name && openId) {
        const profile = await resolveUserByOpenId(openId, {
          id: openId,
          openId,
          name: '',
          avatar: '',
        });
        name = readableMentionName(profile?.name || '');
      }
      const display = name || unresolvedMentionLabel(openId);
      if (openId) displayMap.set(openId, display);
      if (key) displayMap.set(key, display);
      const rawName = cleanText(mentionName(mention));
      if (rawName) displayMap.set(rawName, display);
    }
    return displayMap;
  }

  async function resolveChat(chat = {}, sender = {}) {
    const chatId = cleanText(chat.id || chat.chat_id || chat.chatId || '');
    if (!chatId) return { id: '', name: sender.name || 'Feishu chat', type: 'p2p', avatar: sender.avatar || '' };
    if (chatCache.has(chatId)) {
      const cached = chatCache.get(chatId);
      if (cached.type === 'p2p' && !cached.name) return { ...cached, name: sender.name || 'Feishu user', avatar: sender.avatar || cached.avatar || '' };
      return cached;
    }
    let resolved = {
      id: chatId,
      name: cleanText(chat.name || ''),
      type: '',
      avatar: '',
    };
    try {
      const res = await client.im?.v1?.chat?.get?.({
        path: { chat_id: chatId },
        params: { user_id_type: 'open_id' },
      });
      const data = res?.data || {};
      resolved = {
        ...resolved,
        name: cleanText(data.name || data.i18n_names?.zh_cn || data.i18n_names?.en_us || resolved.name),
        type: cleanText(data.chat_mode || data.chat_type || ''),
        avatar: bestChatAvatar(data),
      };
    } catch {
      // Chat lookup is best-effort. The ID is kept in metadata for delivery.
    }
    if (resolved.type === 'p2p' || !resolved.name) {
      resolved = {
        ...resolved,
        name: safeFeishuDisplayName(resolved.name || sender.name, {
          fallbackId: chatId,
          kind: resolved.type === 'p2p' ? 'user' : 'chat',
          fallback: sender.name || 'Feishu chat',
        }),
        avatar: resolved.avatar || sender.avatar || '',
      };
    }
    chatCache.set(chatId, resolved);
    return resolved;
  }

  async function fetchMessageItems(messageId) {
    if (!messageId || !client.im?.v1?.message?.get) return [];
    const res = await client.im.v1.message.get({ path: { message_id: messageId } });
    const items = res?.data?.items || res?.data?.messages || [];
    if (Array.isArray(items) && items.length) return items;
    const item = res?.data?.message || res?.data?.item || null;
    return item ? [item] : [];
  }

  function mergeMessageDetails(primary = {}, fetched = {}) {
    return {
      ...fetched,
      ...primary,
      body: primary.body || fetched.body,
      content: primary.content ?? fetched.content,
      msg_type: primary.msg_type || primary.message_type || fetched.msg_type || fetched.message_type,
      message_type: primary.message_type || primary.msg_type || fetched.message_type || fetched.msg_type,
      parent_id: primary.parent_id || primary.parentId || fetched.parent_id || fetched.parentId,
      parentId: primary.parentId || primary.parent_id || fetched.parentId || fetched.parent_id,
      root_id: primary.root_id || primary.rootId || fetched.root_id || fetched.rootId,
      rootId: primary.rootId || primary.root_id || fetched.rootId || fetched.root_id,
      thread_id: primary.thread_id || primary.threadId || fetched.thread_id || fetched.threadId,
      threadId: primary.threadId || primary.thread_id || fetched.threadId || fetched.thread_id,
      chat_type: primary.chat_type || primary.chatType || fetched.chat_type || fetched.chatType,
      chatType: primary.chatType || primary.chat_type || fetched.chatType || fetched.chat_type,
      mentions: primary.mentions || fetched.mentions,
      sender: primary.sender || fetched.sender,
    };
  }

  async function enrichCurrentMessage(normalized = {}) {
    const primary = normalized.message || {};
    const sourceMessageId = normalized.sourceMessageId || messageId(primary);
    const hasReplyPointers = Boolean(primary.parent_id || primary.parentId || primary.root_id || primary.rootId);
    if (!sourceMessageId || (hasReplyPointers && messageContent(primary))) return normalized;
    try {
      const items = await fetchMessageItems(sourceMessageId);
      const fetched = items.find((item) => messageId(item) === sourceMessageId) || items[0] || null;
      if (!fetched) return normalized;
      const message = mergeMessageDetails(primary, fetched);
      return {
        ...normalized,
        message,
        text: normalized.text || textFromContent(messageContent(message)),
      };
    } catch {
      return normalized;
    }
  }

  async function hydrateRelatedMessages(normalized = {}) {
    const primary = normalized.message || {};
    const related = [primary];
    const skippedReferenceIds = [];
    const ids = [
      primary.parent_id || primary.parentId,
      primary.root_id || primary.rootId,
    ].filter((id) => id && id !== normalized.sourceMessageId);

    if (messageType(primary) === 'merge_forward' && normalized.sourceMessageId) {
      ids.unshift(normalized.sourceMessageId);
    }

    for (const id of [...new Set(ids)]) {
      try {
        related.push(...await fetchMessageItems(id));
      } catch {
        skippedReferenceIds.push(id);
      }
    }
    return { messages: dedupeMessages(related), skippedReferenceIds };
  }

  function docTextFromResponse(res = {}) {
    const data = res?.data || {};
    return cleanText(
      data.content
        || data.text
        || data.raw_content
        || data.rawContent
        || data.document?.content
        || data.document?.title
        || data.title
        || '',
    );
  }

  async function fetchDocumentSnippet(link = {}) {
    if (!link.token) return '';
    const attempts = [
      () => client.docx?.v1?.document?.rawContent?.get?.({ path: { document_id: link.token } }),
      () => client.docx?.v1?.document?.get?.({ path: { document_id: link.token } }),
      () => client.drive?.v1?.file?.get?.({ path: { file_token: link.token } }),
    ];
    for (const attempt of attempts) {
      try {
        const res = await attempt();
        const text = docTextFromResponse(res);
        if (text) return text.length > 1200 ? `${text.slice(0, 1199)}…` : text;
      } catch {
        // Document expansion is best-effort and permission-dependent.
      }
    }
    return '';
  }

  async function enrichRecordWithDocuments(record = {}) {
    const links = extractFeishuDocLinks(record.text);
    if (!links.length) return record;
    const snippets = [];
    for (const link of links.slice(0, 3)) {
      const snippet = await fetchDocumentSnippet(link);
      if (snippet) snippets.push(`Feishu doc ${link.token}: ${snippet}`);
    }
    if (!snippets.length) return record;
    return {
      ...record,
      text: `${record.text}\n${snippets.join('\n')}`,
    };
  }

  function topicIdForMessage(message = {}) {
    return cleanText(threadMessageId(message) || rootMessageId(message) || '');
  }

  function messageBelongsToTopic(message = {}, topicId = '') {
    if (!topicId) return false;
    return [
      messageId(message),
      threadMessageId(message),
      rootMessageId(message),
      parentMessageId(message),
    ].map(cleanText).includes(topicId);
  }

  function listResponseItems(res = {}) {
    const data = res?.data || {};
    return data.items || data.messages || data.message_list || data.messageList || [];
  }

  async function fetchTopicMessages(normalized = {}, chat = {}) {
    const primary = normalized.message || {};
    const topicId = topicIdForMessage(primary);
    const chatId = cleanText(chat.id || normalized.chat?.id || '');
    if (!topicId || !chatId || !client.im?.v1?.message?.list) return [];
    const attempts = [
      { params: { container_id_type: 'chat', container_id: chatId, page_size: 50 } },
      { params: { chat_id: chatId, page_size: 50 } },
      { path: { chat_id: chatId }, params: { page_size: 50 } },
    ];
    for (const args of attempts) {
      try {
        const res = await client.im.v1.message.list(args);
        const items = listResponseItems(res);
        if (!Array.isArray(items) || !items.length) continue;
        const filtered = items.filter((item) => messageBelongsToTopic(item, topicId));
        if (filtered.length) return filtered;
      } catch {
        // Some SDK versions do not expose list for this endpoint shape.
      }
    }
    return [];
  }

  async function sendMessage({ chatId, content, msgType = 'text' }) {
    if (!chatId) return null;
    const payload = msgType === 'text'
      ? { text: String(content || '') }
      : parseJson(content);
    const res = await client.im.v1.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: chatId,
        msg_type: msgType,
        content: JSON.stringify(payload),
      },
    });
    return { messageId: res?.data?.message_id || res?.data?.messageId || '' };
  }

  async function replyToMessage({ messageId, content, msgType = 'text', replyInThread = false }) {
    if (!messageId) return null;
    const payload = msgType === 'text'
      ? { text: String(content || '') }
      : parseJson(content);
    const res = await client.im.v1.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: msgType,
        content: JSON.stringify(payload),
        ...(replyInThread ? { reply_in_thread: true } : {}),
      },
    });
    return { messageId: res?.data?.message_id || res?.data?.messageId || '' };
  }

  async function downloadMessageResources(message = {}) {
    const resources = collectMessageResources(message);
    const messageId = message.message_id || message.messageId || '';
    if (!messageId) return [];
    const attachments = [];
    for (const resource of resources) {
      try {
        const response = await client.im.v1.messageResource.get({
          path: {
            message_id: messageId,
            file_key: resource.fileKey,
          },
          params: {
            type: resource.type === 'image' ? 'image' : 'file',
          },
        });
        attachments.push({
          name: resourceName(resource),
          type: resource.type === 'image' ? 'image/png' : 'application/octet-stream',
          buffer: await readableToBuffer(response.getReadableStream()),
          resourceId: resource.fileKey,
          sourceMessageId: messageId,
          sourceCreatedAt: messageCreatedAt(message),
        });
      } catch {
        attachments.push({
          name: resourceName(resource),
          type: resource.type === 'image' ? 'image/png' : 'application/octet-stream',
          buffer: null,
          resourceId: resource.fileKey,
          sourceMessageId: messageId,
          sourceCreatedAt: messageCreatedAt(message),
          skipped: true,
        });
      }
    }
    return attachments;
  }

  async function hydrateEvent(event = {}) {
    const normalized = await enrichCurrentMessage(event.raw ? normalizeEvent(event.raw) : normalizeEvent(event));
    const sender = await resolveSender(normalized.sender);
    const chat = await resolveChat(normalized.chat, sender);
    const topicMessages = await fetchTopicMessages(normalized, chat);
    const { messages: relatedMessages, skippedReferenceIds } = await hydrateRelatedMessages(normalized);
    const allMessages = dedupeMessages([...topicMessages, ...relatedMessages]);
    const mentionDisplayMap = await resolveMentionDisplayMap(allMessages);
    const hydratedText = textFromContent(messageContent(normalized.message), mentionDisplayMap) || normalized.text;
    const attachments = [];
    for (const message of allMessages) {
      attachments.push(...await downloadMessageResources(message));
    }
    const records = [];
    for (const message of allMessages) {
      const hasMessageSender = Boolean(message.sender);
      const messageSender = !hasMessageSender && messageId(message) === normalized.sourceMessageId
        ? sender
        : await resolveMessageSender(message);
      records.push(await enrichRecordWithDocuments(recordFromMessage(message, messageSender, mentionDisplayMap)));
    }
    const visibleRecords = records
      .filter((record) => record.text && record.text !== 'Merged and Forwarded Message');
    return {
      text: hydratedText,
      sender,
      chat,
      sourceMessageId: normalized.sourceMessageId,
      parentMessageId: parentMessageId(normalized.message),
      rootMessageId: rootMessageId(normalized.message),
      threadId: threadMessageId(normalized.message),
      relatedMessageIds: allMessages.map((message) => messageId(message)).filter(Boolean),
      records: visibleRecords.length ? visibleRecords : [{ author: sender.name || 'Feishu user', text: hydratedText }],
      attachments,
      skippedReferenceIds,
      mentionedBot: messageMentionedBot(normalized.message, botOpenId),
      mentionedAll: messageMentionedAll(normalized.message),
      mentions: allMessages.flatMap((message) => messageMentions(message)).map((mention) => {
        const id = mentionOpenId(mention);
        const key = cleanText(mention.key || mention.text || '');
        return {
          id,
          name: mentionDisplayMap.get(id) || mentionDisplayMap.get(key) || readableMentionName(mentionName(mention)) || unresolvedMentionLabel(id),
        };
      }).filter((mention, index, all) => mention.id || all.findIndex((item) => item.name === mention.name) === index),
      raw: normalized.raw,
    };
  }

  async function replyToEvent(event = {}, payload = {}) {
    const normalized = event.raw ? normalizeEvent(event.raw) : normalizeEvent(event);
    const content = payload.content || payload.text || '';
    if (normalized.sourceMessageId) {
      return replyToMessage({ messageId: normalized.sourceMessageId, content, msgType: payload.msg_type || 'text' });
    }
    return sendMessage({ chatId: normalized.chat.id, content, msgType: payload.msg_type || 'text' });
  }

  async function sendThreadReply(payload = {}) {
    const rendered = threadReplyPayload(payload);
    try {
      if (payload.triggerMessageId) {
        return await replyToMessage({
          messageId: payload.triggerMessageId,
          content: rendered.content,
          msgType: rendered.msg_type,
          replyInThread: Boolean(payload.replyInThread),
        });
      }
      return await sendMessage({ chatId: payload.chatId, content: rendered.content, msgType: rendered.msg_type });
    } catch (error) {
      if (rendered.msg_type !== 'text' && rendered.fallbackText) {
        if (payload.triggerMessageId) {
          return replyToMessage({
            messageId: payload.triggerMessageId,
            content: rendered.fallbackText,
            msgType: 'text',
            replyInThread: Boolean(payload.replyInThread),
          });
        }
        return sendMessage({ chatId: payload.chatId, content: rendered.fallbackText, msgType: 'text' });
      }
      throw error;
    }
  }

  async function startLongConnection({ onMessage } = {}) {
    if (typeof onMessage !== 'function') return null;
    wsClient = new Lark.WSClient(baseConfig);
    const dispatcher = new Lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => onMessage({ raw: data }),
    });
    wsClient.start({ eventDispatcher: dispatcher });
    return {
      stop() {
        try {
          wsClient?.close?.();
          wsClient?.stop?.();
        } catch {
          // The SDK does not require shutdown for process exit; ignore close variance.
        }
      },
    };
  }

  return {
    client,
    hydrateEvent,
    importAckPayload,
    replyToEvent,
    sendMessage,
    sendThreadReply,
    startLongConnection,
    textPayload,
  };
}
