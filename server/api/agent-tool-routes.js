// Agent tool API routes.
// These endpoints are called by running Agents, not by the human UI. They let an
// Agent inspect bounded history, send a routed response tied to a work item, and
// create/claim/update tasks without reaching across channel boundaries.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, readFile, stat } from 'node:fs/promises';
import { attachmentPathWithinStorage, mimeForPath, safePathWithin } from '../path-utils.js';
import { createTaskStartupCollaboration } from '../task-startup-collaboration.js';

const DEFAULT_ATTACHMENT_READ_MAX_BYTES = 2 * 1024 * 1024;
const HARD_ATTACHMENT_READ_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_AVATAR_READ_MAX_BYTES = 512 * 1024;
const HARD_AVATAR_READ_MAX_BYTES = 2 * 1024 * 1024;
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(MODULE_DIR, '../..', 'public');

export async function handleAgentToolApi(req, res, url, deps) {
  const {
    addSystemEvent,
    addTaskHistory,
    broadcastState,
    cancelReminder,
    claimTask,
    createReminder,
    createTaskFromMessage,
    createTaskMessage,
    displayActor,
    findAgent,
    findConversationRecord,
    findMessage,
    findTaskForAgentTool,
    findWorkItem,
    formatAgentHistory,
    formatAgentSearchResults,
    getState,
    httpError,
    deliverMessageToAgent = null,
    makeId,
    markWorkItemResponded,
    normalizeConversationRecord = (record) => record,
    normalizeIds,
    now,
    persistState,
    postAgentResponse,
    readAgentHistory,
    readAgentMemoryFile,
    readJson,
    resolveConversationSpace,
    resolveMessageTarget,
    routeTaskAssignees,
    scheduleAgentMemoryWriteback,
    listReminders,
    searchAgentMessageHistory,
    searchAgentMemory,
    sendError,
    sendJson,
    submitAgentMarkdownOperation = null,
    taskLabel,
    taskAssignmentDeliveryMessage,
    updateTaskForAgent,
    writeAgentMemoryUpdate,
    workItemTargetMatches,
    attachmentStorageDir,
  } = deps;
  const state = getState();
  const { startTaskStartupCollaboration } = createTaskStartupCollaboration(deps);
  const TASK_CREATE_DEDUPE_WINDOW_MS = 5 * 60 * 1000;
  const PROACTIVE_MESSAGE_DEDUPE_WINDOW_MS = 3 * 1000;

  function canonicalAgentResponseText(value) {
    return String(value || '')
      .replace(/\r\n/g, '\n')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n[ \t]+/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  function broadcastTaskStatusState() {
    broadcastState();
  }

  function headerValue(name) {
    const headers = req.headers || {};
    const lower = name.toLowerCase();
    return headers[name] || headers[lower] || '';
  }

  function requestWorkspaceId() {
    return String(
      req.daemonAuth?.workspaceId
      || headerValue('x-magclaw-workspace-id')
      || state.connection?.workspaceId
      || '',
    ).trim();
  }

  function workspaceIdForRecord(record = null, fallback = '') {
    return String(
      record?.workspaceId
      || fallback
      || requestWorkspaceId()
      || state.cloud?.workspace?.id
      || state.cloud?.workspaces?.[0]?.id
      || '',
    ).trim();
  }

  function persistWorkspaceState(record = null, reason = 'agent_tool_changed') {
    const workspaceId = workspaceIdForRecord(record);
    return persistState(workspaceId ? { workspaceId, reason } : { reason });
  }

  function persistWorkspaceStateSoon(record = null, reason = 'agent_tool_changed') {
    persistWorkspaceState(record, reason).then(broadcastState).catch(() => {});
  }

  function workspaceMatches(record, workspaceId = requestWorkspaceId()) {
    const target = String(workspaceId || '').trim();
    if (!target) return true;
    const recordWorkspace = String(record?.workspaceId || '').trim();
    if (recordWorkspace) return recordWorkspace === target;
    const stateWorkspace = String(state.connection?.workspaceId || '').trim();
    return Boolean(stateWorkspace && stateWorkspace === target);
  }

  function compactText(value, limit = 240) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length <= limit) return text;
    return `${text.slice(0, Math.max(0, limit - 1)).trim()}...`;
  }

  function runtimeLabel(agent) {
    return compactText(agent?.runtimeId || agent?.runtime || agent?.model || 'unknown', 80);
  }

  function avatarValue(agent) {
    return String(agent?.avatar || agent?.avatarUrl || '').trim();
  }

  function avatarKind(value) {
    const avatar = String(value || '').trim();
    if (!avatar) return 'none';
    if (/^data:/i.test(avatar)) return 'data_url';
    if (/^https?:\/\//i.test(avatar)) return 'url';
    if (avatar.startsWith('/')) return 'path';
    return 'value';
  }

  function avatarDescription(value) {
    const avatar = String(value || '').trim();
    const kind = avatarKind(avatar);
    if (kind === 'none') return '';
    if (kind === 'data_url') {
      const mime = avatar.match(/^data:([^;,]+)/i)?.[1] || 'data';
      return `${mime} data URL (${avatar.length} chars)`;
    }
    return avatar;
  }

  function imageMimeFromName(value = '') {
    const mime = mimeForPath(String(value || '').split(/[?#]/)[0], '');
    return mime.startsWith('image/') ? mime : '';
  }

  function avatarReadMaxBytes() {
    const raw = Number(url.searchParams.get('maxBytes') || url.searchParams.get('max_bytes') || DEFAULT_AVATAR_READ_MAX_BYTES);
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_AVATAR_READ_MAX_BYTES;
    return Math.max(1, Math.min(HARD_AVATAR_READ_MAX_BYTES, Math.floor(raw)));
  }

  function decodeAvatarDataUrl(value = '') {
    const match = String(value || '').match(/^data:([^;,]+)(;base64)?,([\s\S]*)$/i);
    if (!match) return null;
    const type = String(match[1] || '').toLowerCase();
    if (!type.startsWith('image/')) return null;
    const body = match[3] || '';
    let decodedBody = body;
    if (!match[2]) {
      try {
        decodedBody = decodeURIComponent(body);
      } catch {
        decodedBody = body;
      }
    }
    const buffer = match[2]
      ? Buffer.from(body, 'base64')
      : Buffer.from(decodedBody, 'utf8');
    return { type, buffer };
  }

  function avatarPublicAssetPath(value = '') {
    const raw = String(value || '').trim().split(/[?#]/)[0];
    if (!raw.startsWith('/avatars/') && !raw.startsWith('/brand/')) return '';
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      decoded = raw;
    }
    return safePathWithin(PUBLIC_DIR, `.${decoded}`) || '';
  }

  async function readResponseBodyWithLimit(response, maxBytes) {
    const chunks = [];
    let total = 0;
    let truncated = false;
    if (!response.body?.getReader) {
      const buffer = Buffer.from(await response.arrayBuffer());
      return {
        buffer: buffer.length > maxBytes ? buffer.subarray(0, maxBytes) : buffer,
        sizeBytes: buffer.length,
        truncated: buffer.length > maxBytes,
      };
    }
    const reader = response.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        const remaining = maxBytes - total;
        if (remaining <= 0) {
          truncated = true;
          await reader.cancel().catch(() => {});
          break;
        }
        if (chunk.length > remaining) {
          chunks.push(chunk.subarray(0, remaining));
          total += remaining;
          truncated = true;
          await reader.cancel().catch(() => {});
          break;
        }
        chunks.push(chunk);
        total += chunk.length;
      }
    } finally {
      reader.releaseLock?.();
    }
    return {
      buffer: Buffer.concat(chunks),
      sizeBytes: total,
      truncated,
    };
  }

  async function fetchAvatarUrlContent(avatarUrl, maxBytes) {
    let parsed = null;
    try {
      parsed = new URL(avatarUrl);
    } catch {
      throw httpError(400, 'Avatar URL is invalid.');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw httpError(400, 'Avatar URL protocol is not supported.');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(parsed, {
        headers: { accept: 'image/*' },
        signal: controller.signal,
      });
      if (!response.ok) throw httpError(response.status || 502, `Avatar URL fetch failed: HTTP ${response.status}`);
      const type = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase()
        || imageMimeFromName(parsed.pathname);
      if (!type.startsWith('image/')) throw httpError(415, 'Avatar URL did not return an image.');
      const body = await readResponseBodyWithLimit(response, maxBytes);
      return {
        type,
        source: 'url',
        sourceUrl: parsed.toString(),
        sizeBytes: body.sizeBytes,
        readBytes: body.buffer.length,
        truncated: body.truncated,
        buffer: body.buffer,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function readAvatarImageContent(summary) {
    const avatar = String(summary?.avatar || '').trim();
    if (!avatar) throw httpError(404, 'Agent avatar is not set.');
    const maxBytes = avatarReadMaxBytes();
    const dataUrl = decodeAvatarDataUrl(avatar);
    if (dataUrl) {
      const buffer = dataUrl.buffer.length > maxBytes ? dataUrl.buffer.subarray(0, maxBytes) : dataUrl.buffer;
      return {
        type: dataUrl.type,
        source: 'data_url',
        sizeBytes: dataUrl.buffer.length,
        readBytes: buffer.length,
        truncated: dataUrl.buffer.length > maxBytes,
        buffer,
      };
    }
    const publicPath = avatarPublicAssetPath(avatar);
    if (publicPath) {
      let fileStat = null;
      try {
        fileStat = await stat(publicPath);
      } catch {
        throw httpError(404, 'Avatar asset is not available on this server.');
      }
      const type = imageMimeFromName(publicPath);
      if (!type) throw httpError(415, 'Avatar asset is not an image.');
      const fileBuffer = await readFile(publicPath);
      const buffer = fileBuffer.length > maxBytes ? fileBuffer.subarray(0, maxBytes) : fileBuffer;
      return {
        type,
        source: 'public_asset',
        path: publicPath,
        sizeBytes: fileStat.size,
        readBytes: buffer.length,
        truncated: fileBuffer.length > maxBytes,
        buffer,
      };
    }
    if (/^https?:\/\//i.test(avatar)) return fetchAvatarUrlContent(avatar, maxBytes);
    throw httpError(404, 'Avatar image content is not available on this server.');
  }

  function normalizedTaskText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function taskTimeMs(task) {
    const value = task?.createdAt || task?.updatedAt || '';
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : 0;
  }

  function currentTimeMs() {
    const value = typeof now === 'function' ? now() : new Date().toISOString();
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : Date.now();
  }

  function taskBodyMatches(task, bodyText) {
    const requested = normalizedTaskText(bodyText);
    const existing = normalizedTaskText(task?.body || '');
    if (!requested && !existing) return true;
    if (!requested || !existing) return false;
    return requested === existing;
  }

  function taskIsReusable(task) {
    return Boolean(task && !['done', 'closed', 'stopped'].includes(String(task.status || '').toLowerCase()));
  }

  function duplicateTaskResult(task, space, reused = true) {
    return {
      task,
      message: findMessage(task.messageId) || null,
      taskNumber: task.number,
      messageId: task.messageId || null,
      title: task.title,
      threadTarget: `${space.label}:${task.threadMessageId || task.messageId || task.id}`,
      reused,
    };
  }

  function findDuplicateAgentTask({ agent, space, title, bodyText = '', sourceMessageId = '', sourceReplyId = '' }) {
    const normalizedTitle = normalizedTaskText(title);
    if (!normalizedTitle) return null;
    const sourceId = String(sourceMessageId || '').trim();
    const replyId = String(sourceReplyId || '').trim();
    const requestMs = currentTimeMs();
    return (state.tasks || []).find((task) => {
      if (!taskIsReusable(task)) return false;
      if (task.spaceType !== space.spaceType || task.spaceId !== space.spaceId) return false;
      if (normalizedTaskText(task.title) !== normalizedTitle) return false;
      if (!taskBodyMatches(task, bodyText)) return false;
      if (sourceId || replyId) {
        return String(task.sourceMessageId || '') === sourceId
          && String(task.sourceReplyId || '') === replyId;
      }
      if (String(task.createdBy || '') !== agent.id) return false;
      const ageMs = requestMs - taskTimeMs(task);
      return ageMs >= 0 && ageMs <= TASK_CREATE_DEDUPE_WINDOW_MS;
    }) || null;
  }

  function findHumanName(id) {
    return (state.humans || []).find((human) => human.id === id)?.name || '';
  }

  function agentChannelNames(agent, workspaceId = requestWorkspaceId()) {
    if (!agent?.id) return [];
    return (state.channels || [])
      .filter((channel) => workspaceMatches(channel, workspaceId))
      .filter((channel) => channelHasMember(channel, agent.id))
      .map((channel) => `#${channel.name || channel.id}`)
      .slice(0, 12);
  }

  function publicAgentSummary(agent, { detailed = false } = {}) {
    const creatorId = agent.ownerId || agent.createdBy || agent.creatorId || '';
    const avatar = avatarValue(agent);
    return {
      id: agent.id,
      name: agent.name || agent.id,
      description: compactText(agent.description || '', detailed ? 1200 : 260),
      runtime: agent.runtime || '',
      runtimeId: agent.runtimeId || '',
      runtimeLabel: runtimeLabel(agent),
      status: agent.status || '',
      model: compactText(agent.model || agent.defaultModel || '', 120),
      reasoningEffort: agent.reasoningEffort || '',
      systemRole: compactText(agent.systemRole || agent.role || '', detailed ? 500 : 160),
      creatorId,
      creatorName: findHumanName(creatorId) || displayActor(creatorId) || creatorId || '',
      createdAt: agent.createdAt || '',
      updatedAt: agent.updatedAt || '',
      avatar,
      avatarKind: avatarKind(avatar),
      avatarDescription: avatarDescription(avatar),
      channels: agentChannelNames(agent),
    };
  }

  function renderAgentSummaryLine(agent) {
    const summary = publicAgentSummary(agent);
    const pieces = [
      `@${summary.name} (${summary.id})`,
      `runtime=${summary.runtimeLabel}`,
      summary.status ? `status=${summary.status}` : '',
      summary.description ? `desc=${summary.description}` : '',
      summary.avatar ? `avatar=${summary.avatarDescription || summary.avatar}; tool=read_agent_avatar(targetAgentId="${summary.id}")` : '',
      summary.channels?.length ? `channels=${summary.channels.join(',')}` : '',
    ].filter(Boolean);
    return `- ${pieces.join(' | ')}`;
  }

  function renderAgentProfile(summary) {
    return [
      `@${summary.name} (${summary.id})`,
      `Runtime: ${summary.runtimeLabel}`,
      summary.status ? `Status: ${summary.status}` : '',
      summary.description ? `Description: ${summary.description}` : '',
      summary.systemRole ? `Role: ${summary.systemRole}` : '',
      summary.model ? `Model: ${summary.model}` : '',
      summary.reasoningEffort ? `Reasoning: ${summary.reasoningEffort}` : '',
      summary.creatorName ? `Creator: ${summary.creatorName}` : '',
      summary.createdAt ? `Created: ${summary.createdAt}` : '',
      summary.updatedAt ? `Updated: ${summary.updatedAt}` : '',
      summary.avatar ? `Avatar: ${summary.avatarDescription || summary.avatar}` : '',
      summary.avatar ? `Avatar image tool: read_agent_avatar(targetAgentId="${summary.id}")` : '',
      summary.channels?.length ? `Channels: ${summary.channels.join(', ')}` : '',
    ].filter(Boolean).join('\n');
  }

  function targetChannelFromQuery(workspaceId = requestWorkspaceId()) {
    const raw = String(url.searchParams.get('target') || url.searchParams.get('channel') || '').trim();
    if (!raw) return null;
    const channelRef = raw.match(/^#([^:]+)(?::.+)?$/)?.[1] || raw.replace(/^#/, '').split(':')[0];
    return (state.channels || []).find((channel) => (
      workspaceMatches(channel, workspaceId)
      && (channel.id === channelRef || channel.id.startsWith(channelRef) || channel.name === channelRef)
    )) || null;
  }

  function workspaceAgents(workspaceId = requestWorkspaceId()) {
    return (state.agents || []).filter((agent) => workspaceMatches(agent, workspaceId));
  }

  function findWorkspaceAgent(ref, workspaceId = requestWorkspaceId()) {
    const value = String(ref || '').trim();
    if (!value) return null;
    return workspaceAgents(workspaceId).find((agent) => (
      agent.id === value
      || agent.id.startsWith(value)
      || agent.name === value
      || `@${agent.name}` === value
    )) || null;
  }

  function findReadableAgentProfile(agentId, targetAgentRef, workspaceId = requestWorkspaceId()) {
    const requester = findAgent(String(agentId || ''));
    const value = String(targetAgentRef || '').trim();
    if (!value || ['me', 'self', 'myself', requester?.id, requester?.name, `@${requester?.name || ''}`].includes(value)) {
      return requester || null;
    }
    return findWorkspaceAgent(value, workspaceId);
  }

  function allConversationRecords() {
    return [
      ...(Array.isArray(state.messages) ? state.messages : []),
      ...(Array.isArray(state.replies) ? state.replies : []),
    ];
  }

  function recordAttachmentIds(record = {}) {
    return Array.isArray(record.attachmentIds) ? record.attachmentIds.map(String) : [];
  }

  function findConversationRecordAny(id) {
    const key = String(id || '').trim();
    if (!key) return null;
    return findConversationRecord(key)
      || findMessage(key)
      || allConversationRecords().find((record) => record.id === key)
      || null;
  }

  function attachmentWorkspaceMatches(attachment, workspaceId = requestWorkspaceId()) {
    const target = String(workspaceId || '').trim();
    if (!target) return true;
    const attachmentWorkspace = String(attachment?.workspaceId || attachment?.serverId || '').trim();
    if (attachmentWorkspace) return attachmentWorkspace === target;
    return workspaceMatches(attachment, target);
  }

  function recordVisibleToAgent(record, agent, workspaceId = requestWorkspaceId()) {
    if (!record || !agent || !workspaceMatches(record, workspaceId)) return false;
    if (record.spaceType === 'dm') {
      const dm = (state.dms || []).find((item) => item.id === record.spaceId && workspaceMatches(item, workspaceId));
      return Boolean(dmHasParticipant(dm, agent.id) || record.authorId === agent.id);
    }
    if (record.spaceType === 'channel') {
      const channel = (state.channels || []).find((item) => item.id === record.spaceId && workspaceMatches(item, workspaceId));
      if (!channel) return true;
      return !channelRequiresMembership(channel) || channelHasMember(channel, agent.id);
    }
    return true;
  }

  function attachmentLinkedRecords(attachment, workspaceId = requestWorkspaceId()) {
    const id = String(attachment?.id || '').trim();
    if (!id) return [];
    return allConversationRecords().filter((record) => (
      workspaceMatches(record, workspaceId)
      && recordAttachmentIds(record).includes(id)
    ));
  }

  function attachmentMessageIds(attachment, workspaceId = requestWorkspaceId()) {
    return attachmentLinkedRecords(attachment, workspaceId)
      .map((record) => record.id)
      .filter(Boolean);
  }

  function attachmentFilePath(attachment = {}) {
    return attachmentPathWithinStorage(attachment, attachmentStorageDir);
  }

  function attachmentName(attachment = {}) {
    return String(attachment.name || attachment.filename || attachment.id || 'attachment');
  }

  function attachmentType(attachment = {}) {
    return String(attachment.type || attachment.mime || attachment.mimeType || 'application/octet-stream');
  }

  function scopedAttachmentUrl(attachment = {}, workspaceId = requestWorkspaceId()) {
    const existing = String(attachment.url || attachment.downloadUrl || '').trim();
    if (existing) return existing;
    const id = String(attachment.id || '').trim();
    if (!id) return '';
    const base = `/api/attachments/${id}/${encodeURIComponent(attachmentName(attachment))}`;
    const scope = String(workspaceId || '').trim();
    return scope ? `${base}?workspaceId=${encodeURIComponent(scope)}` : base;
  }

  function publicAttachmentSummary(attachment, workspaceId = requestWorkspaceId()) {
    const filePath = attachmentFilePath(attachment);
    const messageIds = attachmentMessageIds(attachment, workspaceId);
    return {
      id: String(attachment.id || ''),
      name: attachmentName(attachment),
      type: attachmentType(attachment),
      bytes: Number(attachment.bytes || attachment.sizeBytes || attachment.size || 0),
      source: attachment.source || '',
      createdAt: attachment.createdAt || '',
      createdBy: attachment.createdBy || '',
      workspaceId: attachment.workspaceId || attachment.serverId || workspaceId || '',
      storageMode: attachment.storageMode || '',
      storageKey: attachment.storageKey || '',
      relativePath: attachment.relativePath || '',
      checksumSha256: attachment.checksumSha256 || '',
      path: filePath,
      url: scopedAttachmentUrl(attachment, workspaceId),
      messageIds,
      messageId: messageIds[0] || '',
      toolCall: `read_attachment(attachmentId="${String(attachment.id || '')}")`,
    };
  }

  function renderAttachmentSummaryLine(summary) {
    const details = [
      `id=${summary.id}`,
      summary.messageId ? `from msg=${summary.messageId}` : '',
      summary.path ? `path=${summary.path}` : '',
      summary.url ? `url=${summary.url}` : '',
      `tool=read_attachment(attachmentId="${summary.id}")`,
    ].filter(Boolean).join(', ');
    return `- ${summary.name} ${summary.type} ${summary.bytes} bytes (${details})`;
  }

  function attachmentText(attachments) {
    if (!attachments.length) return 'No visible attachments.';
    return [
      'Visible attachments:',
      ...attachments.map(renderAttachmentSummaryLine),
    ].join('\n');
  }

  function resolveAttachmentForAgent(attachmentId, agent, workspaceId = requestWorkspaceId()) {
    const id = String(attachmentId || '').trim();
    if (!id) return null;
    const attachment = (state.attachments || []).find((item) => String(item.id || '') === id);
    if (!attachment || !attachmentWorkspaceMatches(attachment, workspaceId)) return null;
    const linkedRecords = attachmentLinkedRecords(attachment, workspaceId);
    if (!linkedRecords.length) return attachment;
    return linkedRecords.some((record) => recordVisibleToAgent(record, agent, workspaceId)) ? attachment : null;
  }

  function attachmentRecordsForQuery(agent, workspaceId = requestWorkspaceId()) {
    const messageId = String(url.searchParams.get('messageId') || url.searchParams.get('message_id') || '').trim();
    if (messageId) {
      const record = findConversationRecordAny(messageId);
      if (!record || !recordVisibleToAgent(record, agent, workspaceId)) {
        throw httpError(404, 'Message not found or not visible.');
      }
      return [record];
    }
    const target = String(url.searchParams.get('target') || url.searchParams.get('channel') || '').trim();
    if (target) {
      const history = readAgentHistory(state, {
        agentId: agent.id,
        target,
        workItemId: url.searchParams.get('workItemId') || url.searchParams.get('work_item_id') || undefined,
        limit: url.searchParams.get('limit') || 50,
        workspaceId,
      });
      return Array.isArray(history?.messages) ? history.messages : [];
    }
    return allConversationRecords().filter((record) => recordVisibleToAgent(record, agent, workspaceId));
  }

  function visibleAttachmentsForQuery(agent, workspaceId = requestWorkspaceId()) {
    const records = attachmentRecordsForQuery(agent, workspaceId);
    const ids = new Set(records.flatMap(recordAttachmentIds));
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 20)));
    return (state.attachments || [])
      .filter((attachment) => attachmentWorkspaceMatches(attachment, workspaceId))
      .filter((attachment) => ids.has(String(attachment.id || '')))
      .map((attachment) => publicAttachmentSummary(attachment, workspaceId))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
      .slice(0, limit);
  }

  function attachmentReadMaxBytes() {
    const raw = Number(url.searchParams.get('maxBytes') || url.searchParams.get('max_bytes') || DEFAULT_ATTACHMENT_READ_MAX_BYTES);
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_ATTACHMENT_READ_MAX_BYTES;
    return Math.max(1, Math.min(HARD_ATTACHMENT_READ_MAX_BYTES, Math.floor(raw)));
  }

  function isTextLikeAttachment(attachment) {
    const type = attachmentType(attachment).toLowerCase();
    const name = attachmentName(attachment).toLowerCase();
    return type.startsWith('text/')
      || [
        'application/json',
        'application/xml',
        'application/javascript',
        'application/x-javascript',
        'application/yaml',
        'application/x-yaml',
      ].includes(type)
      || /\.(txt|md|markdown|json|jsonl|csv|tsv|xml|html|css|js|ts|tsx|jsx|yaml|yml|log)$/i.test(name);
  }

  async function readAttachmentContent(attachment) {
    const filePath = attachmentFilePath(attachment);
    if (!filePath) throw httpError(404, 'Attachment file is not available on this server.');
    let fileStat = null;
    try {
      fileStat = await stat(filePath);
    } catch {
      throw httpError(404, 'Attachment file is not available on this server.');
    }
    const maxBytes = attachmentReadMaxBytes();
    const readBytes = Math.min(fileStat.size, maxBytes);
    const buffer = Buffer.alloc(readBytes);
    const handle = await open(filePath, 'r');
    try {
      if (readBytes > 0) await handle.read(buffer, 0, readBytes, 0);
    } finally {
      await handle.close();
    }
    return {
      filePath,
      fileSize: fileStat.size,
      readBytes,
      truncated: fileStat.size > readBytes,
      buffer,
    };
  }

  function resolveProposalChannel(body = {}) {
    const channelRef = String(body.channelId || body.channel_id || '').trim();
    if (channelRef) {
      const channel = (state.channels || []).find((item) => item.id === channelRef || item.id.startsWith(channelRef));
      if (!channel) throw httpError(404, `Channel not found: ${channelRef}`);
      return channel;
    }
    const space = resolveConversationSpace(body, { workspaceId: requestWorkspaceId() });
    if (space.spaceType !== 'channel') throw httpError(400, 'Channel member proposals require a channel target.');
    return (state.channels || []).find((item) => item.id === space.spaceId);
  }

  function findMember(id) {
    return (state.humans || []).find((human) => human.id === id)
      || (state.agents || []).find((agent) => agent.id === id)
      || null;
  }

  function channelHasMember(channel, memberId) {
    return [
      ...(Array.isArray(channel.memberIds) ? channel.memberIds : []),
      ...(Array.isArray(channel.humanIds) ? channel.humanIds : []),
      ...(Array.isArray(channel.agentIds) ? channel.agentIds : []),
    ].includes(memberId);
  }

  function channelRequiresMembership(channel) {
    const visibility = String(channel?.visibility || channel?.privacy || '').trim().toLowerCase();
    return Boolean(channel?.private || channel?.isPrivate || ['private', 'secret'].includes(visibility));
  }

  function findWorkspaceHuman(ref, workspaceId = requestWorkspaceId()) {
    const value = String(ref || '').trim().replace(/^@/, '');
    if (!value) return null;
    const humans = new Map((state.humans || []).map((human) => [human.id, human]));
    const usersById = new Map((state.cloud?.users || []).map((user) => [user.id, user]));
    for (const member of state.cloud?.workspaceMembers || []) {
      if ((member.status || 'active') !== 'active') continue;
      if (workspaceId && member.workspaceId !== workspaceId) continue;
      if (!member.humanId || humans.has(member.humanId)) continue;
      const user = usersById.get(member.userId) || {};
      humans.set(member.humanId, {
        id: member.humanId,
        name: user.name || user.email?.split('@')[0] || member.humanId,
        email: user.email || '',
      });
    }
    return [...humans.values()].find((human) => (
      workspaceMatches(human, workspaceId)
      && (
        human.id === value
        || human.id.startsWith(value)
        || human.name === value
        || `@${human.name}` === value
        || human.email === value
      )
    )) || null;
  }

  function findVisibleDmPeer(ref, workspaceId = requestWorkspaceId()) {
    return findWorkspaceAgent(ref, workspaceId)
      || findWorkspaceHuman(ref, workspaceId)
      || null;
  }

  function canonicalDmParticipants(firstId, secondId) {
    const first = String(firstId || '').trim();
    const second = String(secondId || '').trim();
    return [first, second].filter(Boolean);
  }

  function findOrCreateAgentPeerDm(agent, peer, workspaceId = requestWorkspaceId()) {
    const participants = canonicalDmParticipants(agent.id, peer.id);
    let dm = (state.dms || []).find((item) => (
      workspaceMatches(item, workspaceId)
      && Array.isArray(item.participantIds)
      && participants.every((id) => item.participantIds.includes(id))
    ));
    if (dm) return dm;
    dm = {
      id: makeId('dm'),
      workspaceId,
      participantIds: participants,
      createdAt: now(),
      updatedAt: now(),
    };
    state.dms = Array.isArray(state.dms) ? state.dms : [];
    state.dms.push(dm);
    addSystemEvent('agent_tool_dm_created', `${agent.name} opened a proactive DM.`, {
      agentId: agent.id,
      peerId: peer.id,
      dmId: dm.id,
      workspaceId: workspaceId || null,
    });
    return dm;
  }

  function dmHasParticipant(dm, participantId) {
    const id = String(participantId || '').trim();
    return Boolean(id && Array.isArray(dm?.participantIds) && dm.participantIds.includes(id));
  }

  function dmHumanParticipantIds(dm, workspaceId = requestWorkspaceId()) {
    return (dm?.participantIds || []).filter((id) => (
      String(id || '').startsWith('hum_') || Boolean(findWorkspaceHuman(id, workspaceId))
    ));
  }

  function findCloudAgentDelivery(deliveryKey) {
    const key = String(deliveryKey || '').trim();
    if (!key) return null;
    return (state.cloud?.agentDeliveries || []).find((delivery) => (
      delivery?.id === key
      || delivery?.deliveryId === key
      || delivery?.idempotencyKey === key
      || delivery?.messageId === key
    )) || null;
  }

  function findOrCreateUserAgentHandoffDm(humanId, targetAgent, workspaceId = requestWorkspaceId()) {
    const normalizedWorkspaceId = String(workspaceId || 'local');
    const existing = (state.dms || []).find((dm) => (
      workspaceMatches(dm, normalizedWorkspaceId)
      && dmHasParticipant(dm, humanId)
      && dmHasParticipant(dm, targetAgent.id)
    ));
    if (existing) return { dm: existing, created: false };
    const dm = {
      id: makeId('dm'),
      workspaceId: normalizedWorkspaceId,
      participantIds: [humanId, targetAgent.id],
      createdAt: now(),
      updatedAt: now(),
    };
    state.dms = Array.isArray(state.dms) ? state.dms : [];
    state.dms.push(dm);
    addSystemEvent('agent_tool_handoff_dm_created', `${targetAgent.name} opened a private handoff DM.`, {
      humanId,
      targetAgentId: targetAgent.id,
      dmId: dm.id,
      workspaceId: normalizedWorkspaceId || null,
    });
    return { dm, created: true };
  }

  function workItemTimeMs(workItem) {
    const value = workItem?.updatedAt || workItem?.respondedAt || workItem?.deliveredAt || workItem?.createdAt || '';
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : 0;
  }

  function sourceMessageMentionsPeer(sourceMessage, peer) {
    if (!sourceMessage || !peer) return false;
    if ((sourceMessage.mentionedAgentIds || []).includes(peer.id)) return true;
    const body = String(sourceMessage.body || '');
    const peerName = String(peer.name || '').trim();
    return body.includes(`<@${peer.id}>`)
      || Boolean(peerName && (body.includes(`@${peerName}`) || body.includes(peerName)));
  }

  function findLikelyPrivateHandoffWorkItem(agent, peer, workspaceId = requestWorkspaceId()) {
    return (state.workItems || [])
      .filter((workItem) => (
        workItem?.agentId === agent.id
        && workItem.spaceType === 'dm'
        && workspaceMatches(workItem, workspaceId)
      ))
      .map((workItem) => {
        const sourceMessage = workItem.sourceMessageId
          ? (findConversationRecord(workItem.sourceMessageId) || findMessage(workItem.sourceMessageId))
          : null;
        const sourceDm = sourceMessage?.spaceType === 'dm'
          ? (state.dms || []).find((dm) => dm.id === sourceMessage.spaceId && workspaceMatches(dm, sourceMessage.workspaceId || workspaceId))
          : null;
        return { workItem, sourceMessage, sourceDm };
      })
      .filter(({ sourceMessage, sourceDm }) => (
        sourceMessageMentionsPeer(sourceMessage, peer)
        && dmHasParticipant(sourceDm, agent.id)
        && !dmHasParticipant(sourceDm, peer.id)
        && dmHumanParticipantIds(sourceDm, sourceMessage.workspaceId || workspaceId).length > 0
      ))
      .sort((a, b) => workItemTimeMs(b.workItem) - workItemTimeMs(a.workItem))[0] || null;
  }

  function privateHandoffContextForProactiveDm(agent, peer, requestBody, workspaceId = requestWorkspaceId()) {
    if (!String(peer?.id || '').startsWith('agt_')) return null;
    const deliveryKey = String(
      requestBody?.deliveryId
      || requestBody?.delivery_id
      || requestBody?.idempotencyKey
      || requestBody?.idempotency_key
      || '',
    ).trim();
    const delivery = findCloudAgentDelivery(deliveryKey);
    const inferred = delivery ? null : findLikelyPrivateHandoffWorkItem(agent, peer, workspaceId);
    if (!delivery && !inferred) return null;
    const workItem = delivery?.workItemId ? findWorkItem(String(delivery.workItemId)) : inferred?.workItem || null;
    const sourceMessageId = String(
      workItem?.sourceMessageId
      || delivery?.messageId
      || workItem?.parentMessageId
      || '',
    ).trim();
    const sourceMessage = inferred?.sourceMessage || (sourceMessageId
      ? (findConversationRecord(sourceMessageId) || findMessage(sourceMessageId))
      : null);
    if (!sourceMessage || sourceMessage.spaceType !== 'dm') return null;
    const sourceDm = inferred?.sourceDm || (state.dms || []).find((dm) => (
      dm.id === sourceMessage.spaceId
      && workspaceMatches(dm, sourceMessage.workspaceId || workspaceId)
    ));
    if (!sourceDm || !dmHasParticipant(sourceDm, agent.id) || dmHasParticipant(sourceDm, peer.id)) return null;
    const humanIds = dmHumanParticipantIds(sourceDm, sourceMessage.workspaceId || workspaceId);
    const originHumanId = sourceMessage.authorType === 'human' && humanIds.includes(sourceMessage.authorId)
      ? sourceMessage.authorId
      : humanIds[0] || null;
    if (!originHumanId) return null;
    const handoffWorkspaceId = sourceMessage.workspaceId || sourceDm.workspaceId || workspaceId || 'local';
    const { dm, created } = findOrCreateUserAgentHandoffDm(originHumanId, peer, handoffWorkspaceId);
    return {
      delivery,
      workItem,
      sourceMessage,
      sourceDm,
      originHumanId,
      dm,
      dmCreated: created,
      workspaceId: handoffWorkspaceId,
    };
  }

  function privateHandoffMessageBody(content, sourceAgent, targetAgent, originHumanId, sourceMessage) {
    return [
      `Private handoff for <@${originHumanId}>.`,
      `Source agent: <@${sourceAgent.id}>.`,
      `Target agent: <@${targetAgent.id}>.`,
      sourceMessage?.body ? `Original request: ${String(sourceMessage.body || '').trim()}` : '',
      `Handoff message: ${String(content || '').trim()}`,
      'Continue in this DM with the human if you can help. Create or claim a task only when the work needs tracked follow-up.',
    ].filter(Boolean).join('\n');
  }

  function recordTimeMs(record) {
    const parsed = Date.parse(record?.createdAt || record?.updatedAt || '');
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function privateHandoffMetadata(record) {
    const metadata = record?.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
      ? record.metadata
      : {};
    return {
      ...metadata,
      ...(metadata.state?.metadata && typeof metadata.state.metadata === 'object' ? metadata.state.metadata : {}),
    };
  }

  function attachPrivateHandoffDeliveryIdentity(record, context) {
    const deliveryId = String(context?.delivery?.id || '').trim();
    if (!record || !deliveryId) return false;
    const metadata = privateHandoffMetadata(record);
    if (metadata.deliveryId) return false;
    record.metadata = {
      ...(record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata) ? record.metadata : {}),
      deliveryId,
    };
    record.updatedAt = now();
    if (typeof normalizeConversationRecord === 'function') normalizeConversationRecord(record);
    return true;
  }

  function findRecentPrivateUserAgentHandoffMessage(sourceAgent, targetAgent, context, handoffBody) {
    const baselineMs = Date.parse(now());
    if (!Number.isFinite(baselineMs)) return null;
    const sourceMessageId = String(context?.sourceMessage?.id || '').trim();
    const workItemId = String(context?.workItem?.id || '').trim();
    return (state.messages || []).slice().reverse().find((record) => {
      const metadata = privateHandoffMetadata(record);
      const createdMs = recordTimeMs(record);
      return (
        record?.authorType === 'system'
        && record.spaceType === 'dm'
        && record.spaceId === context.dm.id
        && metadata.kind === 'private_user_agent_handoff'
        && metadata.sourceAgentId === sourceAgent.id
        && metadata.targetAgentId === targetAgent.id
        && metadata.originHumanId === context.originHumanId
        && (!sourceMessageId || metadata.sourceMessageId === sourceMessageId)
        && (!workItemId || !metadata.workItemId || metadata.workItemId === workItemId)
        && String(record.body || '').trim() === String(handoffBody || '').trim()
        && createdMs > 0
        && baselineMs >= createdMs
        && baselineMs - createdMs <= PROACTIVE_MESSAGE_DEDUPE_WINDOW_MS
      );
    }) || null;
  }

  function createPrivateUserAgentHandoffMessage(sourceAgent, targetAgent, context, handoffBody) {
    const message = normalizeConversationRecord({
      id: makeId('msg'),
      workspaceId: context.workspaceId,
      spaceType: 'dm',
      spaceId: context.dm.id,
      authorType: 'system',
      authorId: 'system',
      body: handoffBody,
      attachmentIds: Array.isArray(context.sourceMessage?.attachmentIds) ? context.sourceMessage.attachmentIds : [],
      mentionedAgentIds: [sourceAgent.id, targetAgent.id],
      mentionedHumanIds: [context.originHumanId],
      readBy: [context.originHumanId],
      replyCount: 0,
      savedBy: [],
      agentRelayDepth: Number(context.sourceMessage?.agentRelayDepth || 0) + 1,
      handoffSourceMessageId: context.sourceMessage?.id || null,
      handoffSourceParentMessageId: context.sourceMessage?.parentMessageId || null,
      suppressTaskContext: true,
      internal: true,
      hiddenFromChannel: true,
      metadata: {
        visibility: 'internal',
        kind: 'private_user_agent_handoff',
        sourceAgentId: sourceAgent.id,
        targetAgentId: targetAgent.id,
        originHumanId: context.originHumanId,
        sourceDmId: context.sourceDm?.id || null,
        sourceMessageId: context.sourceMessage?.id || null,
        deliveryId: context.delivery?.id || null,
        workItemId: context.workItem?.id || null,
      },
      createdAt: now(),
      updatedAt: now(),
    });
    state.messages = Array.isArray(state.messages) ? state.messages : [];
    state.messages.push(message);
    return message;
  }

  async function deliverPrivateUserAgentHandoff(sourceAgent, target, content, traceId, startedAt) {
    const context = target.privateHandoffContext;
    const targetAgent = target.peer;
    const handoffBody = privateHandoffMessageBody(content, sourceAgent, targetAgent, context.originHumanId, context.sourceMessage);
    const existingHandoff = findRecentPrivateUserAgentHandoffMessage(sourceAgent, targetAgent, context, handoffBody);
    if (existingHandoff) {
      const changed = attachPrivateHandoffDeliveryIdentity(existingHandoff, context);
      addSystemEvent('agent_tool_private_handoff_deduped', `${sourceAgent.name} repeated a private handoff to ${targetAgent.name}.`, {
        traceId,
        fromAgentId: sourceAgent.id,
        toAgentId: targetAgent.id,
        originHumanId: context.originHumanId,
        sourceMessageId: context.sourceMessage?.id || null,
        sourceDmId: context.sourceDm?.id || null,
        dmId: context.dm.id,
        handoffMessageId: existingHandoff.id,
        deliveryId: context.delivery?.id || null,
        attachedDeliveryIdentity: changed,
        durationMs: Date.now() - startedAt,
      });
      if (changed) {
        await persistWorkspaceState(existingHandoff, 'agent_tool_private_handoff_deduped');
        broadcastState();
      }
      return { handoffMessage: existingHandoff, deliveredAgentIds: [], deduped: true };
    }
    const handoffMessage = createPrivateUserAgentHandoffMessage(sourceAgent, targetAgent, context, handoffBody);
    addSystemEvent('agent_tool_private_handoff', `${sourceAgent.name} routed a private handoff from ${displayActor(context.originHumanId)} to ${targetAgent.name}.`, {
      traceId,
      fromAgentId: sourceAgent.id,
      toAgentId: targetAgent.id,
      originHumanId: context.originHumanId,
      sourceMessageId: context.sourceMessage?.id || null,
      sourceDmId: context.sourceDm?.id || null,
      dmId: context.dm.id,
      handoffMessageId: handoffMessage.id,
      dmCreated: context.dmCreated,
      durationMs: Date.now() - startedAt,
    });
    await persistWorkspaceState(handoffMessage, 'agent_tool_private_handoff_created');
    broadcastState();
    const deliveredAgentIds = [];
    if (typeof deliverMessageToAgent === 'function') {
      try {
        await deliverMessageToAgent(targetAgent, 'dm', context.dm.id, handoffMessage, {
          parentMessageId: null,
          proactive: true,
          sourceAgentId: sourceAgent.id,
          suppressTaskContext: true,
        });
        deliveredAgentIds.push(targetAgent.id);
      } catch (error) {
        addSystemEvent('delivery_error', `Failed to deliver private user-Agent handoff to ${targetAgent.name}: ${error.message}`, {
          agentId: targetAgent.id,
          sourceAgentId: sourceAgent.id,
          messageId: handoffMessage.id,
          dmId: context.dm.id,
        });
      }
    }
    return { handoffMessage, deliveredAgentIds, deduped: false };
  }

  function parentMessageForDmThread(dm, parentRef, workspaceId = requestWorkspaceId()) {
    const ref = String(parentRef || '').trim();
    if (!ref) return null;
    const parent = (state.messages || []).find((message) => (
      workspaceMatches(message, workspaceId)
      && message.spaceType === 'dm'
      && message.spaceId === dm.id
      && (message.id === ref || message.id.startsWith(ref) || message.id.split('_').pop()?.startsWith(ref))
    ));
    if (!parent) throw httpError(404, `Thread message not found: ${parentRef}`);
    return parent;
  }

  function resolveProactiveMessageTarget(agent, rawTarget, requestBody = {}) {
    const workspaceId = requestWorkspaceId();
    const target = String(rawTarget || '').trim();
    if (!target) throw httpError(400, 'Target is required for proactive send_message.');
    const namedDm = target.match(/^dm:@([^:]+)(?::(.+))?$/);
    if (namedDm) {
      const peer = findVisibleDmPeer(namedDm[1], workspaceId);
      if (!peer) throw httpError(404, `DM peer not found: @${namedDm[1]}`);
      if (peer.id === agent.id) throw httpError(400, 'Agent cannot DM itself.');
      const privateHandoffContext = namedDm[2]
        ? null
        : privateHandoffContextForProactiveDm(agent, peer, requestBody, workspaceId);
      if (privateHandoffContext) {
        return {
          kind: 'private_user_agent_handoff',
          spaceType: 'dm',
          spaceId: privateHandoffContext.dm.id,
          parentMessageId: null,
          label: `dm:${privateHandoffContext.dm.id}`,
          dm: privateHandoffContext.dm,
          peer,
          privateHandoffContext,
        };
      }
      const dm = findOrCreateAgentPeerDm(agent, peer, workspaceId);
      const parent = parentMessageForDmThread(dm, namedDm[2] || '', workspaceId);
      return {
        spaceType: 'dm',
        spaceId: dm.id,
        parentMessageId: parent?.id || null,
        label: parent ? `dm:${dm.id}:${parent.id}` : `dm:${dm.id}`,
        dm,
        peer,
      };
    }
    const resolved = resolveMessageTarget(target, { workspaceId });
    if (resolved.spaceType === 'dm') {
      const dm = (state.dms || []).find((item) => item.id === resolved.spaceId);
      if (!dm?.participantIds?.includes(agent.id)) {
        throw httpError(403, 'Agent can only send to a DM it participates in, or use dm:@peer to open one.');
      }
      return { ...resolved, dm };
    }
    if (resolved.spaceType === 'channel') {
      const channel = (state.channels || []).find((item) => item.id === resolved.spaceId);
      if (!channel) throw httpError(404, 'Channel not found.');
      if (channelRequiresMembership(channel) && !channelHasMember(channel, agent.id)) {
        throw httpError(403, 'Agent can only proactively send to private channels it belongs to.');
      }
      return { ...resolved, channel };
    }
    return resolved;
  }

  async function deliverProactiveMessageToAgentPeers(senderAgent, target, posted) {
    if (target.spaceType !== 'dm' || typeof deliverMessageToAgent !== 'function') return [];
    const dm = target.dm || (state.dms || []).find((item) => item.id === target.spaceId);
    const recipientAgents = (dm?.participantIds || [])
      .filter((id) => id.startsWith('agt_') && id !== senderAgent.id)
      .map((id) => findAgent(id))
      .filter(Boolean);
    const delivered = [];
    for (const recipient of recipientAgents) {
      try {
        await deliverMessageToAgent(recipient, 'dm', dm.id, posted, {
          parentMessageId: target.parentMessageId || null,
          proactive: true,
          sourceAgentId: senderAgent.id,
        });
        delivered.push(recipient.id);
      } catch (error) {
        addSystemEvent('delivery_error', `Failed to deliver proactive DM to ${recipient.name}: ${error.message}`, {
          agentId: recipient.id,
          sourceAgentId: senderAgent.id,
          messageId: posted?.id || null,
          dmId: dm.id,
        });
      }
    }
    return delivered;
  }

  if (req.method === 'GET' && url.pathname === '/api/agent-tools/reminders') {
    const agentId = url.searchParams.get('agentId') || '';
    const result = typeof listReminders === 'function'
      ? listReminders({
        agentId,
        status: url.searchParams.get('status') || '',
        limit: url.searchParams.get('limit') || undefined,
      })
      : {
        ok: true,
        reminders: (state.reminders || []).filter((reminder) => (
          (!agentId || reminder.ownerAgentId === agentId || reminder.createdBy === agentId)
          && (!url.searchParams.get('status') || reminder.status === url.searchParams.get('status'))
        )),
      };
    const reminders = result.reminders || [];
    addSystemEvent('agent_reminders_listed', `${displayActor(agentId) || 'Agent'} listed reminders.`, {
      agentId,
      status: url.searchParams.get('status') || null,
      resultCount: reminders.length,
    });
    sendJson(res, 200, {
      ok: true,
      reminders,
      text: result.text || (reminders.length
        ? [
          'Reminders:',
          ...reminders.map((reminder) => `#${String(reminder.id || '').split('_').pop() || reminder.id} [${reminder.status}] ${reminder.fireAt} "${reminder.title}"`),
        ].join('\n')
        : 'No reminders.'),
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent-tools/reminders') {
    const body = await readJson(req);
    const agent = findAgent(String(body.agentId || ''));
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    try {
      const result = createReminder({
        ...body,
        agentId: agent.id,
      });
      addSystemEvent('agent_tool_schedule_reminder', `${agent.name} scheduled a reminder.`, {
        agentId: agent.id,
        reminderId: result.reminder?.id || null,
        fireAt: result.reminder?.fireAt || null,
      });
      await persistWorkspaceState(result.reminder || agent, 'agent_tool_reminder_created');
      broadcastState();
      sendJson(res, 201, result);
    } catch (error) {
      sendError(res, error.status || 400, error.message);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent-tools/reminders/cancel') {
    const body = await readJson(req);
    const agent = findAgent(String(body.agentId || ''));
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    try {
      const result = cancelReminder({
        ...body,
        agentId: agent.id,
      });
      await persistWorkspaceState(result.reminder || agent, 'agent_tool_reminder_canceled');
      broadcastState();
      sendJson(res, 200, result);
    } catch (error) {
      sendError(res, error.status || 400, error.message);
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/agent-tools/attachments') {
    const agentId = url.searchParams.get('agentId') || '';
    const agent = findAgent(String(agentId || ''));
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    const workspaceId = requestWorkspaceId();
    try {
      const attachments = visibleAttachmentsForQuery(agent, workspaceId);
      addSystemEvent('agent_attachments_listed', `${displayActor(agentId) || 'Agent'} listed attachments.`, {
        agentId,
        workspaceId: workspaceId || null,
        resultCount: attachments.length,
      });
      sendJson(res, 200, {
        ok: true,
        workspaceId: workspaceId || null,
        count: attachments.length,
        attachments,
        text: attachmentText(attachments),
      });
    } catch (error) {
      sendError(res, error.status || 400, error.message);
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/agent-tools/attachments/read') {
    const agentId = url.searchParams.get('agentId') || '';
    const agent = findAgent(String(agentId || ''));
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    const workspaceId = requestWorkspaceId();
    const attachmentId = url.searchParams.get('attachmentId') || url.searchParams.get('attachment_id') || url.searchParams.get('id') || '';
    const attachment = resolveAttachmentForAgent(attachmentId, agent, workspaceId);
    if (!attachment) {
      sendError(res, 404, 'Attachment not found or not visible.');
      return true;
    }
    try {
      const summary = publicAttachmentSummary(attachment, workspaceId);
      const content = await readAttachmentContent(attachment);
      const type = summary.type || 'application/octet-stream';
      const contentBase64 = content.buffer.toString('base64');
      const includeText = isTextLikeAttachment(attachment)
        || ['text', 'utf8', 'utf-8'].includes(String(url.searchParams.get('format') || '').toLowerCase());
      const contentText = includeText ? content.buffer.toString('utf8') : '';
      const dataUrl = `data:${type};base64,${contentBase64}`;
      addSystemEvent('agent_attachment_read', `${displayActor(agentId) || 'Agent'} read an attachment.`, {
        agentId,
        workspaceId: workspaceId || null,
        attachmentId: summary.id,
        bytes: content.readBytes,
        truncated: content.truncated,
      });
      sendJson(res, 200, {
        ok: true,
        workspaceId: workspaceId || null,
        attachment: summary,
        file: {
          path: content.filePath,
          name: summary.name,
          type,
          sizeBytes: content.fileSize,
          readBytes: content.readBytes,
          truncated: content.truncated,
        },
        contentText,
        contentBase64,
        dataUrl,
        text: [
          `Attachment ${summary.id} (${summary.name})`,
          `MIME: ${type}`,
          `Bytes: ${content.fileSize}${content.truncated ? ` (returned first ${content.readBytes})` : ''}`,
          `Path: ${content.filePath}`,
          contentText ? `Text:\n${contentText}` : `Base64 content returned in contentBase64; data URL returned in dataUrl.`,
        ].join('\n'),
      });
    } catch (error) {
      sendError(res, error.status || 500, error.message);
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/agent-tools/agents') {
    const agentId = url.searchParams.get('agentId') || '';
    const workspaceId = requestWorkspaceId();
    const query = compactText(url.searchParams.get('q') || url.searchParams.get('query') || '', 120).toLowerCase();
    const limit = Math.max(1, Math.min(50, Number(url.searchParams.get('limit') || 20)));
    const channel = targetChannelFromQuery(workspaceId);
    const channelAgentIds = channel
      ? new Set([
        ...(Array.isArray(channel.agentIds) ? channel.agentIds : []),
        ...(Array.isArray(channel.memberIds) ? channel.memberIds : []),
      ])
      : null;
    const agents = workspaceAgents(workspaceId)
      .filter((agent) => agent.id !== agentId)
      .filter((agent) => !channelAgentIds || channelAgentIds.has(agent.id))
      .filter((agent) => {
        if (!query) return true;
        return [
          agent.name,
          agent.id,
          agent.description,
          agent.runtime,
          agent.runtimeId,
          agent.model,
          agent.systemRole,
        ].some((value) => String(value || '').toLowerCase().includes(query));
      })
      .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id)))
      .slice(0, limit);
    addSystemEvent('agent_profiles_listed', `${displayActor(agentId) || 'Agent'} listed agent profiles.`, {
      agentId,
      workspaceId: workspaceId || null,
      target: channel ? `#${channel.name || channel.id}` : null,
      query: query || null,
      resultCount: agents.length,
    });
    sendJson(res, 200, {
      ok: true,
      workspaceId: workspaceId || null,
      count: agents.length,
      agents: agents.map((agent) => publicAgentSummary(agent)),
      text: agents.length
        ? [
          `Agent profiles${channel ? ` in #${channel.name || channel.id}` : ''}:`,
          ...agents.map(renderAgentSummaryLine),
        ].join('\n')
        : `No matching agents${channel ? ` in #${channel.name || channel.id}` : ''}.`,
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/agent-tools/agents/read') {
    const agentId = url.searchParams.get('agentId') || '';
    const workspaceId = requestWorkspaceId();
    const targetAgentRef = url.searchParams.get('targetAgentId') || url.searchParams.get('targetAgent') || '';
    const targetAgent = findReadableAgentProfile(agentId, targetAgentRef, workspaceId);
    if (!targetAgent) {
      sendError(res, 404, 'Target agent not found.');
      return true;
    }
    const summary = publicAgentSummary(targetAgent, { detailed: true });
    addSystemEvent('agent_profile_read', `${displayActor(agentId) || 'Agent'} read ${targetAgent.name} profile.`, {
      agentId,
      workspaceId: workspaceId || null,
      targetAgentId: targetAgent.id,
    });
    sendJson(res, 200, {
      ok: true,
      workspaceId: workspaceId || null,
      agent: summary,
      text: renderAgentProfile(summary),
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/agent-tools/agents/avatar/read') {
    const agentId = url.searchParams.get('agentId') || '';
    const workspaceId = requestWorkspaceId();
    const targetAgentRef = url.searchParams.get('targetAgentId') || url.searchParams.get('targetAgent') || '';
    const targetAgent = findReadableAgentProfile(agentId, targetAgentRef, workspaceId);
    if (!targetAgent) {
      sendError(res, 404, 'Target agent not found.');
      return true;
    }
    const summary = publicAgentSummary(targetAgent, { detailed: true });
    let content = null;
    try {
      content = await readAvatarImageContent(summary);
    } catch (error) {
      sendError(res, error.status || 500, error.message || 'Avatar image content is not available.');
      return true;
    }
    const contentBase64 = content.buffer.toString('base64');
    addSystemEvent('agent_avatar_read', `${displayActor(agentId) || 'Agent'} read ${targetAgent.name} avatar image.`, {
      agentId,
      workspaceId: workspaceId || null,
      targetAgentId: targetAgent.id,
      source: content.source || null,
      type: content.type || null,
      readBytes: content.readBytes || 0,
      truncated: Boolean(content.truncated),
    });
    sendJson(res, 200, {
      ok: true,
      workspaceId: workspaceId || null,
      agent: summary,
      avatar: {
        kind: summary.avatarKind,
        type: content.type,
        description: summary.avatarDescription || summary.avatar || '',
        source: content.source || '',
        sourceUrl: content.sourceUrl || '',
        path: content.source === 'public_asset' ? summary.avatar : '',
      },
      file: {
        type: content.type,
        sizeBytes: content.sizeBytes,
        readBytes: content.readBytes,
        truncated: Boolean(content.truncated),
      },
      contentBase64,
      dataUrl: content.truncated ? '' : `data:${content.type};base64,${contentBase64}`,
      text: [
        `Avatar image for @${summary.name} (${summary.id})`,
        `Type: ${content.type}`,
        `Source: ${content.source || 'unknown'}`,
        `Read bytes: ${content.readBytes}/${content.sizeBytes}`,
        content.truncated ? 'Content is truncated; request a larger maxBytes value if you need the full image.' : 'Full image content is included as base64/dataUrl.',
      ].join('\n'),
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/agent-tools/history') {
    const agentId = url.searchParams.get('agentId') || '';
    const workspaceId = requestWorkspaceId();
    const history = readAgentHistory(state, {
      agentId,
      workItemId: url.searchParams.get('workItemId') || url.searchParams.get('work_item_id') || undefined,
      target: url.searchParams.get('target') || url.searchParams.get('channel') || '#all',
      limit: url.searchParams.get('limit') || undefined,
      around: url.searchParams.get('around') || undefined,
      before: url.searchParams.get('before') || undefined,
      after: url.searchParams.get('after') || undefined,
      workspaceId,
    });
    addSystemEvent('agent_history_read', `${displayActor(agentId) || 'Agent'} read ${history.target || 'history'}.`, {
      agentId,
      workspaceId: workspaceId || null,
      target: history.target || url.searchParams.get('target') || '#all',
      ok: Boolean(history.ok),
    });
    sendJson(res, history.ok ? 200 : (history.code === 'dm_forbidden' ? 403 : 404), {
      ...history,
      text: formatAgentHistory(history, { state, targetAgentId: agentId }),
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/agent-tools/search') {
    const agentId = url.searchParams.get('agentId') || '';
    const workspaceId = requestWorkspaceId();
    const search = searchAgentMessageHistory(state, {
      agentId,
      workItemId: url.searchParams.get('workItemId') || url.searchParams.get('work_item_id') || undefined,
      query: url.searchParams.get('q') || url.searchParams.get('query') || '',
      target: url.searchParams.get('target') || url.searchParams.get('channel') || '#all',
      limit: url.searchParams.get('limit') || undefined,
      workspaceId,
    });
    addSystemEvent('agent_history_search', `${displayActor(agentId) || 'Agent'} searched message history.`, {
      agentId,
      workspaceId: workspaceId || null,
      query: url.searchParams.get('q') || url.searchParams.get('query') || '',
      target: url.searchParams.get('target') || '#all',
      ok: Boolean(search.ok),
    });
    sendJson(res, search.ok ? 200 : (search.code === 'dm_forbidden' ? 403 : 400), {
      ...search,
      text: formatAgentSearchResults(search, { state, targetAgentId: agentId }),
    });
    return true;
  }

  function memorySearchText(search) {
    if (!search?.ok) return search?.text || 'Memory search failed.';
    if (!search.results?.length) return `No memory matches for "${search.query}".`;
    return [
      `Memory search results for "${search.query}":`,
      ...search.results.map((item, index) => [
        `${index + 1}. @${item.agentName} (${item.agentId}) ${item.path}:${item.line}`,
        `   ${item.preview}`,
      ].join('\n')),
      search.truncated ? '- More matches were omitted by the limit.' : '',
    ].filter(Boolean).join('\n');
  }

  if (req.method === 'GET' && url.pathname === '/api/agent-tools/memory/search') {
    const agentId = url.searchParams.get('agentId') || '';
    const workspaceId = requestWorkspaceId();
    const targetAgentId = url.searchParams.get('targetAgentId') || url.searchParams.get('targetAgent') || '';
    const search = await searchAgentMemory(url.searchParams.get('q') || url.searchParams.get('query') || '', {
      targetAgentId,
      limit: url.searchParams.get('limit') || undefined,
      workspaceId,
      includePaths: ['MEMORY.md'],
    });
    addSystemEvent('agent_memory_search', `${displayActor(agentId) || 'Agent'} searched agent memory.`, {
      agentId,
      workspaceId: workspaceId || null,
      query: search.query || '',
      targetAgentId: targetAgentId || null,
      resultCount: search.results?.length || 0,
      ok: Boolean(search.ok),
    });
    sendJson(res, search.ok ? 200 : 400, {
      ...search,
      text: memorySearchText(search),
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/agent-tools/memory/read') {
    const agentId = url.searchParams.get('agentId') || '';
    const workspaceId = requestWorkspaceId();
    const targetAgentRef = url.searchParams.get('targetAgentId') || url.searchParams.get('targetAgent') || '';
    const targetAgent = findWorkspaceAgent(targetAgentRef, workspaceId)
      || (() => {
        const agent = findAgent(targetAgentRef);
        return agent && workspaceMatches(agent, workspaceId) ? agent : null;
      })();
    if (!targetAgent) {
      sendError(res, 404, 'Target agent not found.');
      return true;
    }
    try {
      const file = await readAgentMemoryFile(targetAgent, url.searchParams.get('path') || 'MEMORY.md');
      addSystemEvent('agent_memory_read', `${displayActor(agentId) || 'Agent'} read ${targetAgent.name} memory.`, {
        agentId,
        workspaceId: workspaceId || null,
        targetAgentId: targetAgent.id,
        path: file.file.path,
      });
      sendJson(res, 200, {
        ok: true,
        ...file,
        text: [
          `@${targetAgent.name} ${file.file.path}`,
          file.file.content,
        ].join('\n'),
      });
    } catch (error) {
      sendError(res, error.status || 400, error.message);
    }
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/agent-tools/files/read') {
    const agentId = url.searchParams.get('agentId') || '';
    const workspaceId = requestWorkspaceId();
    const targetAgentRef = url.searchParams.get('targetAgentId') || url.searchParams.get('targetAgent') || '';
    const relPath = url.searchParams.get('path') || '';
    const targetAgent = findWorkspaceAgent(targetAgentRef, workspaceId)
      || (() => {
        const agent = findAgent(targetAgentRef);
        return agent && workspaceMatches(agent, workspaceId) ? agent : null;
      })();
    if (!targetAgent) {
      sendError(res, 404, 'Target agent not found.');
      return true;
    }
    if (!relPath) {
      sendError(res, 400, 'Explicit file path is required.');
      return true;
    }
    try {
      const file = await readAgentMemoryFile(targetAgent, relPath);
      addSystemEvent('agent_file_read', `${displayActor(agentId) || 'Agent'} read ${targetAgent.name} workspace file.`, {
        agentId,
        workspaceId: workspaceId || null,
        targetAgentId: targetAgent.id,
        path: file.file.path,
      });
      sendJson(res, 200, {
        ok: true,
        ...file,
        text: [
          `@${targetAgent.name} ${file.file.path}`,
          file.file.content,
        ].join('\n'),
      });
    } catch (error) {
      sendError(res, error.status || 400, error.message);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent-tools/memory/mirror') {
    if (typeof submitAgentMarkdownOperation !== 'function') {
      sendError(res, 503, 'Memory mirror applier is not available.');
      return true;
    }
    const body = await readJson(req);
    const workspaceId = requestWorkspaceId();
    const agent = findAgent(String(body.agentId || ''));
    if (!agent || (workspaceId && workspaceId !== 'local' && !workspaceMatches(agent, workspaceId))) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    const markdown = String(body.content || body.markdown || '').trim();
    if (!markdown) {
      sendError(res, 400, 'MEMORY.md content is required.');
      return true;
    }
    try {
      const result = await submitAgentMarkdownOperation(agent, {
        type: 'maintenance_rewrite',
        target: { relPath: 'MEMORY.md' },
        markdown,
      }, {
        idempotencyKey: body.idempotencyKey || `daemon-memory-mirror:${workspaceId || 'local'}:${agent.id}:${body.documentHash || markdown.length}`,
        sourceTrigger: 'daemon_memory_mirror',
        metadata: {
          source: 'daemon_memory_mirror',
          computerId: req.daemonAuth?.computerId || body.computerId || null,
          documentHash: body.documentHash || '',
        },
      });
      addSystemEvent('agent_memory_mirror_sync_received', `Received daemon MEMORY.md mirror for ${agent.name || agent.id}.`, {
        agentId: agent.id,
        workspaceId: workspaceId || null,
        revision: result.revision || null,
        operationId: result.operationId || null,
      });
      sendJson(res, 202, { ok: true, result });
    } catch (error) {
      console.warn('[agent-tools] memory mirror sync failed', {
        agentId: agent.id,
        workspaceId: workspaceId || null,
        error: error.message,
      });
      addSystemEvent('agent_memory_mirror_sync_error', `Daemon MEMORY.md mirror sync failed for ${agent.name || agent.id}: ${error.message}`, {
        agentId: agent.id,
        workspaceId: workspaceId || null,
      });
      sendError(res, error.status || 500, error.message);
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent-tools/memory') {
    const body = await readJson(req);
    const agent = findAgent(String(body.agentId || ''));
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    const summary = String(body.summary || body.content || '').trim();
    if (!summary) {
      sendError(res, 400, 'Memory summary is required.');
      return true;
    }
    const allowedKinds = new Set(['capability', 'communication_style', 'preference', 'memory']);
    const kind = allowedKinds.has(String(body.kind || '')) ? String(body.kind) : 'memory';
    const sourceMessage = body.messageId ? findConversationRecord(String(body.messageId)) : null;
    await writeAgentMemoryUpdate(agent, 'agent_memory_tool', {
      message: sourceMessage || null,
      spaceType: sourceMessage?.spaceType || null,
      spaceId: sourceMessage?.spaceId || null,
      memory: {
        kind,
        summary,
        sourceText: String(body.sourceText || body.source || '').trim() || summary,
      },
    });
    await persistWorkspaceState(sourceMessage || agent, 'agent_tool_memory_updated');
    broadcastState();
    sendJson(res, 200, {
      ok: true,
      text: `Memory updated for ${agent.name}.`,
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent-tools/messages/send') {
    const traceId = makeId ? makeId('tool') : `tool_${Date.now().toString(36)}`;
    const startedAt = Date.now();
    const fail = (status, message, extra = {}) => {
      addSystemEvent('agent_tool_send_message_failed', `send_message failed: ${message}`, {
        traceId,
        status,
        durationMs: Date.now() - startedAt,
        ...extra,
      });
      persistWorkspaceStateSoon({ workspaceId: requestWorkspaceId() }, 'agent_tool_send_message_failed');
      sendError(res, status, message);
      return true;
    };
    const body = await readJson(req);
    const rawAgentId = String(body.agentId || '');
    const rawWorkItemId = String(body.workItemId || body.work_item_id || '');
    const rawTarget = String(body.target || '');
    const rawContent = String(body.content || '');
    const deliveryId = String(body.deliveryId || body.delivery_id || '').trim();
    const idempotencyKey = String(body.idempotencyKey || body.idempotency_key || deliveryId || '').trim();
    addSystemEvent('agent_tool_send_message_started', 'send_message request received.', {
      traceId,
      agentId: rawAgentId || null,
      workItemId: rawWorkItemId || null,
      deliveryId: deliveryId || null,
      idempotencyKey: idempotencyKey || null,
      target: rawTarget || null,
      contentLength: rawContent.trim().length,
    });
    const agent = findAgent(String(body.agentId || ''));
    if (!agent) {
      return fail(404, 'Agent not found.', {
        agentId: rawAgentId || null,
        workItemId: rawWorkItemId || null,
      });
    }
    const workItem = rawWorkItemId ? findWorkItem(String(body.workItemId || body.work_item_id || '')) : null;
    if (rawWorkItemId && !workItem) {
      return fail(404, 'Work item not found.', {
        agentId: agent.id,
        workItemId: rawWorkItemId || null,
      });
    }
    const content = String(body.content || '').trim();
    if (!content) {
      return fail(400, 'Message content is required.', {
        agentId: agent.id,
        workItemId: rawWorkItemId || null,
      });
    }
    if (!workItem) {
      let target;
      try {
        target = resolveProactiveMessageTarget(agent, body.target, body);
      } catch (error) {
        return fail(error.status || 400, error.message, {
          agentId: agent.id,
          target: rawTarget || null,
        });
      }
      try {
        if (target.kind === 'private_user_agent_handoff') {
          const { handoffMessage, deliveredAgentIds, deduped } = await deliverPrivateUserAgentHandoff(agent, target, content, traceId, startedAt);
          sendJson(res, 200, {
            ok: true,
            deduped,
            proactive: true,
            target: target.label,
            message: handoffMessage,
            deliveredAgentIds,
            text: `Private handoff routed to ${target.label}.`,
          });
          return true;
        }
        const posted = await postAgentResponse(agent, target.spaceType, target.spaceId, content, target.parentMessageId || null, {
          deliveryId: deliveryId || null,
          idempotencyKey: idempotencyKey || null,
          proactive: true,
          dedupeWindowMs: PROACTIVE_MESSAGE_DEDUPE_WINDOW_MS,
        });
        const deliveredAgentIds = await deliverProactiveMessageToAgentPeers(agent, target, posted);
        addSystemEvent('agent_tool_send_message', `${agent.name} proactively sent a message to ${target.label}.`, {
          traceId,
          agentId: agent.id,
          proactive: true,
          target: target.label,
          deliveryId: deliveryId || null,
          idempotencyKey: idempotencyKey || null,
          responseId: posted?.id || null,
          deliveredAgentIds,
          durationMs: Date.now() - startedAt,
        });
        await persistState();
        broadcastState();
        sendJson(res, 200, {
          ok: true,
          proactive: true,
          target: target.label,
          message: posted,
          deliveredAgentIds,
          text: `Message sent to ${target.label}.`,
        });
      } catch (error) {
        return fail(error.status || 500, error.message || 'Failed to send message.', {
          agentId: agent.id,
          target: target?.label || rawTarget || null,
        });
      }
      return true;
    }
    if (workItem.agentId !== agent.id) {
      return fail(403, 'Work item belongs to a different agent.', {
        agentId: agent.id,
        workItemId: workItem.id,
        ownerAgentId: workItem.agentId,
      });
    }
    if (workItem.status === 'stopped') {
      return fail(409, 'Work item was stopped by the user.', {
        agentId: agent.id,
        workItemId: workItem.id,
      });
    }
    let target;
    try {
      target = resolveMessageTarget(body.target || workItem.target, { workspaceId: requestWorkspaceId() });
      if (!workItemTargetMatches(workItem, target)) {
        throw httpError(409, 'Target does not match the work item conversation.');
      }
    } catch (error) {
      return fail(error.status || 400, error.message, {
        agentId: agent.id,
        workItemId: workItem.id,
        target: rawTarget || workItem.target || null,
      });
    }

    // send_message is tied to the work item target so an Agent cannot post into
    // another channel or thread just by guessing a conversation id.
    const sourceMessage = findConversationRecord(workItem.sourceMessageId);
    const previousResponse = workItem.lastResponseId ? findConversationRecord(workItem.lastResponseId) : null;
    if (
      previousResponse
      && workItem.sendCount > 0
      && workItem.lastSentTarget === target.label
      && previousResponse.authorType === 'agent'
      && previousResponse.authorId === agent.id
      && canonicalAgentResponseText(previousResponse.body) === canonicalAgentResponseText(content)
    ) {
      addSystemEvent('agent_tool_send_message_deduped', `${agent.name} repeated the same routed message to ${target.label}.`, {
        traceId,
        agentId: agent.id,
        workItemId: workItem.id,
        target: target.label,
        deliveryId: deliveryId || null,
        idempotencyKey: idempotencyKey || null,
        responseId: previousResponse.id,
        durationMs: Date.now() - startedAt,
      });
      await persistWorkspaceState(workItem || previousResponse || agent, 'agent_tool_send_message_deduped');
      broadcastState();
      sendJson(res, 200, {
        ok: true,
        deduped: true,
        target: target.label,
        workItemId: workItem.id,
        workItem,
        message: previousResponse,
        text: `Message already sent to ${target.label}.`,
      });
      return true;
    }
    try {
      const posted = await postAgentResponse(agent, target.spaceType, target.spaceId, content, target.parentMessageId || null, {
        sourceMessage,
        deliveryId: deliveryId || null,
        idempotencyKey: idempotencyKey || null,
        dedupeWindowMs: PROACTIVE_MESSAGE_DEDUPE_WINDOW_MS,
      });
      markWorkItemResponded(workItem, target.label, posted);
      addSystemEvent('agent_tool_send_message', `${agent.name} sent a routed message to ${target.label}.`, {
        traceId,
        agentId: agent.id,
        workItemId: workItem.id,
        target: target.label,
        deliveryId: deliveryId || null,
        idempotencyKey: idempotencyKey || null,
        responseId: posted?.id || null,
        durationMs: Date.now() - startedAt,
      });
      await persistWorkspaceState(workItem || posted || agent, 'agent_tool_send_message_created');
      broadcastState();
      sendJson(res, 200, {
        ok: true,
        target: target.label,
        workItemId: workItem.id,
        workItem,
        message: posted,
        text: `Message sent to ${target.label}.`,
      });
    } catch (error) {
      return fail(error.status || 500, error.message || 'Failed to send message.', {
        agentId: agent.id,
        workItemId: workItem.id,
        target: target.label,
      });
    }
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent-tools/channel-member-proposals') {
    const body = await readJson(req);
    const agent = findAgent(String(body.agentId || ''));
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    let channel;
    try {
      channel = resolveProposalChannel(body);
      if (!channel) throw httpError(404, 'Channel not found.');
      if (!channelHasMember(channel, agent.id)) {
        throw httpError(403, 'Agent can only propose members for channels it belongs to.');
      }
    } catch (error) {
      sendError(res, error.status || 400, error.message);
      return true;
    }
    const requestedMemberIds = normalizeIds([
      ...(Array.isArray(body.memberIds) ? body.memberIds : []),
      ...(Array.isArray(body.member_ids) ? body.member_ids : []),
      ...(body.memberId ? [body.memberId] : []),
    ]);
    const memberIds = requestedMemberIds
      .filter((id) => findMember(id))
      .filter((id) => !channelHasMember(channel, id));
    if (!memberIds.length) {
      sendError(res, 400, 'No eligible non-channel members were proposed.');
      return true;
    }
    const signature = memberIds.slice().sort().join('|');
    const existing = (state.channelMemberProposals || []).find((proposal) => (
      proposal.status === 'pending'
      && proposal.channelId === channel.id
      && proposal.proposedBy === agent.id
      && normalizeIds(proposal.memberIds).sort().join('|') === signature
    ));
    if (existing) {
      sendJson(res, 200, {
        ok: true,
        deduped: true,
        proposal: existing,
        text: `Proposal already pending for #${channel.name}.`,
      });
      return true;
    }
    const createdAt = now();
    const proposal = {
      id: makeId('prop'),
      workspaceId: channel.workspaceId || state.connection?.workspaceId || 'local',
      channelId: channel.id,
      proposedBy: agent.id,
      memberIds,
      reason: String(body.reason || body.body || '').trim() || 'Agent suggested adding these members to the channel.',
      status: 'pending',
      reviewerId: null,
      sourceMessageId: body.messageId || body.sourceMessageId || null,
      createdAt,
      updatedAt: createdAt,
      reviewedAt: null,
      acceptedAt: null,
      declinedAt: null,
    };
    state.channelMemberProposals = Array.isArray(state.channelMemberProposals) ? state.channelMemberProposals : [];
    state.channelMemberProposals.unshift(proposal);
    addSystemEvent('channel_member_proposal_created', `${agent.name} proposed adding ${memberIds.length} member(s) to #${channel.name}.`, {
      agentId: agent.id,
      channelId: channel.id,
      proposalId: proposal.id,
      memberIds,
    });
    await persistWorkspaceState(proposal, 'agent_tool_channel_member_proposal_created');
    broadcastState();
    sendJson(res, 201, {
      ok: true,
      proposal,
      text: `Suggested ${memberIds.length} member(s) for #${channel.name}. Waiting for human review.`,
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/agent-tools/tasks') {
    const agentId = url.searchParams.get('agentId') || '';
    let scope = null;
    if (url.searchParams.get('target') || url.searchParams.get('channel') || url.searchParams.get('spaceType') || url.searchParams.get('spaceId')) {
      try {
        scope = resolveConversationSpace({
          target: url.searchParams.get('target') || '',
          channel: url.searchParams.get('channel') || '',
          spaceType: url.searchParams.get('spaceType') || '',
          spaceId: url.searchParams.get('spaceId') || '',
        }, { workspaceId: requestWorkspaceId() });
      } catch (error) {
        sendError(res, error.status || 400, error.message);
        return true;
      }
    }
    const status = String(url.searchParams.get('status') || '').trim();
    const assigneeId = String(url.searchParams.get('assigneeId') || '').trim();
    const limit = Math.max(1, Math.min(100, Number(url.searchParams.get('limit') || 25)));
    const tasks = (state.tasks || [])
      .filter((task) => !scope || (task.spaceType === scope.spaceType && task.spaceId === scope.spaceId))
      .filter((task) => !status || task.status === status)
      .filter((task) => !assigneeId || (task.assigneeIds || []).includes(assigneeId))
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
      .slice(0, limit);
    addSystemEvent('agent_tasks_listed', `${displayActor(agentId) || 'Agent'} listed tasks.`, {
      agentId,
      target: scope?.label || null,
      status: status || null,
      assigneeId: assigneeId || null,
      resultCount: tasks.length,
    });
    sendJson(res, 200, {
      ok: true,
      tasks,
      text: tasks.length ? [
        `Tasks${scope ? ` in ${scope.label}` : ''}:`,
        ...tasks.map((task) => {
          const assignees = (task.assigneeIds || []).map((id) => displayActor(id) || id).join(', ') || 'unassigned';
          return `${taskLabel(task)} [${task.status || 'todo'}] ${task.title || '(untitled)'} - assignee ${assignees}`;
        }),
      ].join('\n') : `No tasks${scope ? ` in ${scope.label}` : ''}.`,
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent-tools/tasks/update') {
    const body = await readJson(req);
    const agent = findAgent(String(body.agentId || ''));
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    let task;
    try {
      task = findTaskForAgentTool(body);
      updateTaskForAgent(task, agent, body.status || body.nextStatus, { force: body.force === true || body.allowUnclaimed === true });
    } catch (error) {
      sendError(res, error.status || 400, error.message);
      return true;
    }
    await persistWorkspaceState(task, 'agent_tool_task_updated');
    broadcastTaskStatusState();
    sendJson(res, 200, {
      ok: true,
      task,
      text: `${taskLabel(task)} is now ${task.status}.`,
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent-tools/tasks') {
    const body = await readJson(req);
    const agent = findAgent(String(body.agentId || ''));
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    let space;
    try {
      space = resolveConversationSpace(body, { workspaceId: requestWorkspaceId() });
    } catch (error) {
      sendError(res, error.status || 400, error.message);
      return true;
    }
    const taskInputs = Array.isArray(body.tasks) && body.tasks.length
      ? body.tasks
      : [{ title: body.title, body: body.body }];
    const created = [];
    let createdCount = 0;
    let reusedCount = 0;
    try {
      for (const input of taskInputs) {
        // Task creation accepts both per-item and request-level assignee fields
        // because Agents often batch several task suggestions in one tool call.
        const assigneeIds = normalizeIds([
          ...(Array.isArray(input.assigneeIds) ? input.assigneeIds : []),
          ...(input.assigneeId ? [input.assigneeId] : []),
          ...(Array.isArray(body.assigneeIds) ? body.assigneeIds : []),
          ...(body.assigneeId ? [body.assigneeId] : []),
          ...(body.claim ? [agent.id] : []),
        ]);
        const title = input.title;
        const bodyText = String(input.body ?? body.body ?? '').trim();
        const sourceMessageId = input.sourceMessageId || body.sourceMessageId || null;
        const sourceReplyId = input.sourceReplyId || body.sourceReplyId || null;
        const duplicate = input.allowDuplicate === true || body.allowDuplicate === true
          ? null
          : findDuplicateAgentTask({
            agent,
            space,
            title,
            bodyText,
            sourceMessageId,
            sourceReplyId,
          });
        if (duplicate) {
          if (body.claim && (!duplicate.claimedBy || duplicate.claimedBy === agent.id || body.force === true)) {
            claimTask(duplicate, agent.id, { force: body.force });
          }
          reusedCount += 1;
          created.push(duplicateTaskResult(duplicate, space, true));
          continue;
        }
        const { message, task } = createTaskMessage({
          title,
          body: bodyText,
          ...space,
          authorType: 'agent',
          authorId: agent.id,
          assigneeIds,
          attachmentIds: Array.isArray(input.attachmentIds) ? input.attachmentIds : (Array.isArray(body.attachmentIds) ? body.attachmentIds : []),
          sourceMessageId,
          sourceReplyId,
        });
        const shouldStartCollaboration = assigneeIds.length > 1 && typeof routeTaskAssignees === 'function';
        if (body.claim && !shouldStartCollaboration) claimTask(task, agent.id, { force: body.force });
        if (shouldStartCollaboration) {
          await startTaskStartupCollaboration(task, message, assigneeIds);
        }
        createdCount += 1;
        created.push({
          task,
          message,
          taskNumber: task.number,
          messageId: message.id,
          title: task.title,
          threadTarget: `${space.label}:${message.id}`,
          reused: false,
        });
      }
    } catch (error) {
      sendError(res, error.status || 400, error.message);
      return true;
    }
    addSystemEvent('agent_tool_create_tasks', `${agent.name} created ${createdCount} task(s) and reused ${reusedCount} existing task(s).`, {
      agentId: agent.id,
      taskIds: created.map((item) => item.task.id),
      createdTaskIds: created.filter((item) => !item.reused).map((item) => item.task.id),
      reusedTaskIds: created.filter((item) => item.reused).map((item) => item.task.id),
      spaceType: space.spaceType,
      spaceId: space.spaceId,
    });
    await persistWorkspaceState(created[0]?.task || { workspaceId: space.workspaceId || requestWorkspaceId() }, 'agent_tool_tasks_created');
    broadcastState();
    const summary = createdCount && reusedCount
      ? `Created ${createdCount} and reused ${reusedCount} task(s) in ${space.label}:`
      : (createdCount
        ? `Created ${createdCount} task(s) in ${space.label}:`
        : `Reused ${reusedCount} existing task(s) in ${space.label}:`);
    sendJson(res, createdCount ? 201 : 200, {
      ok: true,
      tasks: created,
      text: [
        summary,
        ...created.map((item) => `${taskLabel(item.task)} msg=${item.messageId}${item.reused ? ' reused=true' : ''} "${item.title}"`),
        '',
        'To follow up, reply in:',
        ...created.map((item) => `${taskLabel(item.task)} -> ${item.threadTarget}`),
      ].join('\n'),
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent-tools/tasks/claim') {
    const body = await readJson(req);
    const agent = findAgent(String(body.agentId || ''));
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    let space;
    try {
      space = resolveConversationSpace(body, { workspaceId: requestWorkspaceId() });
    } catch (error) {
      sendError(res, error.status || 400, error.message);
      return true;
    }
    const claimed = [];
    const numbers = Array.isArray(body.taskNumbers) ? body.taskNumbers : (Array.isArray(body.task_numbers) ? body.task_numbers : []);
    const messageIds = Array.isArray(body.messageIds) ? body.messageIds : (Array.isArray(body.message_ids) ? body.message_ids : []);
    try {
      // Agents can claim an existing task by number, or promote a top-level
      // conversation message into a task and claim it in one tool call.
      for (const number of numbers) {
        const task = state.tasks.find((item) => (
          item.spaceType === space.spaceType
          && item.spaceId === space.spaceId
          && Number(item.number) === Number(number)
        ));
        if (!task) throw httpError(404, `Task not found: #${number}`);
        claimed.push(claimTask(task, agent.id, { force: body.force }));
      }
      for (const messageId of messageIds) {
        const message = findMessage(String(messageId)) || state.messages.find((item) => item.id.startsWith(String(messageId)));
        if (!message || message.authorType === 'system' || message.parentMessageId) {
          throw httpError(400, 'Only regular top-level messages can be claimed as tasks.');
        }
        const task = createTaskFromMessage(message, body.title || message.body, { createdBy: message.authorId });
        claimed.push(claimTask(task, agent.id, { force: body.force }));
      }
    } catch (error) {
      sendError(res, error.status || 400, error.message);
      return true;
    }
    await persistWorkspaceState(claimed[0] || { workspaceId: space.workspaceId || requestWorkspaceId() }, 'agent_tool_tasks_claimed');
    broadcastTaskStatusState();
    sendJson(res, 200, {
      ok: true,
      tasks: claimed,
      text: claimed.map((task) => `Claimed ${taskLabel(task)} "${task.title}"`).join('\n'),
    });
    return true;
  }

  return false;
}
