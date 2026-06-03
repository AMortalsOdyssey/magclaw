import crypto from 'node:crypto';
import { validateChannelImportPath } from './integrations/feishu-connect/route-token.js';

const DEFAULT_MAX_HOTNESS_BOOST = 0.18;
const FEEDBACK_WEIGHTS = Object.freeze({
  served: 0.01,
  opened: 0.09,
  load_more: 0.06,
  cited: 0.12,
  helpful: 0.12,
  unhelpful: -0.12,
});

function redactSecrets(value = '') {
  return String(value || '')
    .replace(/(?:api[_-]?key|token|secret|password|密钥|秘钥|口令|令牌)\s*[：:=]\s*["']?[^\s"',;，。)）]+/gi, '[redacted-secret]')
    .replace(/(?:App Secret|app_secret|client_secret)(\s*[：:=]\s*)[^\s"',;，。)）]+/gi, '$1[redacted-secret]')
    .replace(/([?&](?:key|api[_-]?key|token|access_token|secret)=)[^\s"'&)）]+/gi, '$1[redacted-secret]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, 'Bearer [redacted-secret]');
}

function cleanText(value = '') {
  return redactSecrets(value)
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanMultilineText(value = '') {
  return redactSecrets(value)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function markdownLinkText(value = '') {
  return String(value || '')
    .replace(/\[([^\]\n]+)\]\((?:https?:\/\/|\/|\.\/|\.\.\/|#)[^)]+\)/g, '$1');
}

function cleanSessionTitle(value = '') {
  const stripped = markdownLinkText(value)
    .replace(/^#+\s+/, '')
    .replace(/^\s*title\s*[:：]\s*/i, '');
  return cleanText(stripped).slice(0, 180) || 'Untitled AI session';
}

function compactSelectedTextSnippet(value = '') {
  return cleanText(markdownLinkText(value))
    .replace(/^#+\s+/, '')
    .slice(0, 80);
}

function normalizeSelectedTextPrompt(value = '') {
  const raw = String(value || '').replace(/\r\n/g, '\n').trim();
  if (!/selected text/i.test(raw) || !/my request for codex/i.test(raw)) return raw;

  const requestMatch = raw.match(/(?:^|\n)\s*#+\s*My request for Codex:\s*\n?([\s\S]*)/i)
    || raw.match(/My request for Codex:\s*([\s\S]*)/i);
  let request = requestMatch?.[1] || '';
  request = request
    .replace(/(?:^|\n)\s*#+\s*In app browser:[\s\S]*$/i, '')
    .replace(/(?:^|\n)\s*The next image[\s\S]*$/i, '')
    .trim();

  let selected = raw.match(/(?:^|\n)\s*#+\s*Selection\s+\d+\s*\n+([\s\S]*?)(?=(?:^|\n)\s*#+\s*My request for Codex:)/i)?.[1] || '';
  if (!selected) {
    selected = raw.match(/Selected text:\s*(?:#+\s*)?(?:Selection\s+\d+\s*)?(?:[→:：-]\s*)?([\s\S]*?)(?:\s*[→\n]\s*#+?\s*My request for Codex:|#+\s*My request for Codex:)/i)?.[1] || '';
  }
  const marker = compactSelectedTextSnippet(selected);
  const parts = [
    request || raw,
    marker ? `已添加文本片段：${marker}` : '已添加文本片段',
  ].filter(Boolean);
  return parts.join('\n\n');
}

function cleanEventText(value = '') {
  return cleanMultilineText(normalizeSelectedTextPrompt(markdownLinkText(value)));
}

function stableHash(value = '') {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function safeSegment(value = '', fallback = 'topic') {
  const text = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return text || `${fallback}-${stableHash(value).slice(0, 8)}`;
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function iso(value, fallback = new Date().toISOString()) {
  const date = new Date(value || fallback);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function ensureTeamSharingState(teamSharingState = null) {
  const target = teamSharingState && typeof teamSharingState === 'object' ? teamSharingState : {};
  target.sessions = target.sessions && typeof target.sessions === 'object' ? target.sessions : {};
  target.events = target.events && typeof target.events === 'object' ? target.events : {};
  target.syncLedger = target.syncLedger && typeof target.syncLedger === 'object' ? target.syncLedger : {};
  target.abstracts = target.abstracts && typeof target.abstracts === 'object' ? target.abstracts : {};
  target.activities = Array.isArray(target.activities) ? target.activities : [];
  target.feedback = Array.isArray(target.feedback) ? target.feedback : [];
  target.vectorDocuments = Array.isArray(target.vectorDocuments) ? target.vectorDocuments : [];
  target.searchTraces = Array.isArray(target.searchTraces) ? target.searchTraces : [];
  return target;
}

export function createInitialTeamSharingState() {
  return ensureTeamSharingState({});
}

function normalizeRuntime(value) {
  const runtime = String(value || '').trim().toLowerCase();
  if (runtime === 'claude' || runtime === 'claude-code') return 'claude_code';
  if (runtime === 'codex') return 'codex';
  return runtime || 'unknown';
}

function runtimeAgentId(runtime) {
  const cleanRuntime = normalizeRuntime(runtime);
  if (cleanRuntime === 'claude_code') return 'team_sharing_claude_code';
  if (cleanRuntime === 'codex') return 'team_sharing_codex';
  return `team_sharing_${safeSegment(cleanRuntime || 'runtime', 'runtime')}`;
}

function toolNamesForEvent(event = {}) {
  return asArray(event.toolCalls || event.tools || event.usedTools)
    .map((tool) => String(tool?.name || tool?.function?.name || tool || '').trim())
    .filter(Boolean)
    .filter((name, index, all) => all.indexOf(name) === index)
    .slice(0, 12);
}

function normalizeTeamSharingEvent(event = {}, sessionId = '') {
  const role = String(event.role || event.type || '').trim().toLowerCase();
  if (!['user', 'assistant', 'agent'].includes(role)) return null;
  const cleanRole = role === 'agent' ? 'assistant' : role;
  const text = cleanEventText(event.cleanText || event.text || event.content || event.body || '');
  const tools = cleanRole === 'assistant' ? toolNamesForEvent(event) : [];
  const body = [text, tools.length ? `used_tools=${tools.join(',')}` : ''].filter(Boolean).join('\n');
  if (!body) return null;
  const ordinal = Number(event.ordinal);
  const eventId = String(event.eventId || event.id || `${sessionId}:${Number.isFinite(ordinal) ? ordinal : stableHash(body)}`).trim();
  return {
    eventId,
    ordinal: Number.isFinite(ordinal) ? ordinal : 0,
    role: cleanRole,
    cleanText: body,
    sourceHash: String(event.sourceHash || stableHash(body)),
    sourceAnchor: String(event.sourceAnchor || `${sessionId}#${eventId}`),
    createdAt: iso(event.createdAt),
    metadata: {
      usedTools: tools,
    },
  };
}

function inferTopicId({ title = '', events = [], optionalLocalDigest = '' } = {}) {
  const haystack = `${title}\n${optionalLocalDigest}\n${events.map((event) => event.cleanText).join('\n')}`.toLowerCase();
  if (haystack.includes('rerank') || haystack.includes('重排')) return 'rerank-feedback';
  if (haystack.includes('claude')) return 'claude-adapter';
  if (haystack.includes('hook')) return 'session-sync-hooks';
  if (haystack.includes('channel')) return 'channel-routing';
  return safeSegment(title || events[0]?.cleanText || 'team-sharing-topic', 'topic');
}

function compactEventText(event = {}, limit = 260) {
  return cleanText(event.cleanText || event.text || '').slice(0, limit);
}

function cleanList(value) {
  return asArray(value).map((item) => cleanText(item)).filter(Boolean).slice(0, 12);
}

function eventDigestByRole(events = [], role = '') {
  return asArray(events)
    .filter((event) => !role || event.role === role)
    .map((event) => compactEventText(event, 220))
    .filter(Boolean);
}

function fallbackConversationAbstract({ title = '', events = [], optionalLocalDigest = '' } = {}) {
  const userItems = eventDigestByRole(events, 'user').slice(-4);
  const assistantItems = eventDigestByRole(events, 'assistant').slice(-4);
  const pieces = [];
  if (userItems.length) pieces.push(`用户主要提出：${userItems.join('；')}`);
  if (assistantItems.length) pieces.push(`Agent 给出的结论和推进：${assistantItems.join('；')}`);
  if (optionalLocalDigest) pieces.push(`本地摘要补充：${cleanText(optionalLocalDigest).slice(0, 360)}`);
  const text = cleanText(pieces.join('。'));
  if (text) return text.slice(0, 1200);
  return cleanText(title || '这段对话暂无可总结内容。');
}

function normalizeSummaryTopic(topic = {}, fallback = {}) {
  const topicId = safeSegment(topic.topicId || topic.id || topic.title || fallback.topicId || fallback.title || 'topic', 'topic');
  const title = cleanText(topic.title || topic.topicId || fallback.title || topicId);
  const overview = cleanText(topic.overview || topic.summary || fallback.overview || '');
  const sourceEventIds = asArray(topic.sourceEventIds || topic.source_event_ids).map((item) => String(item || '').trim()).filter(Boolean);
  return {
    topicId,
    title,
    overview,
    decisions: cleanList(topic.decisions),
    openQuestions: cleanList(topic.openQuestions || topic.open_questions),
    nextActions: cleanList(topic.nextActions || topic.next_actions),
    sourceEventIds: sourceEventIds.length ? sourceEventIds : asArray(fallback.sourceEventIds),
  };
}

function renderBulletList(items = [], fallback = '') {
  const cleanItems = cleanList(items);
  if (!cleanItems.length) return fallback ? [`- ${fallback}`] : ['- 暂无明确记录'];
  return cleanItems.map((item) => `- ${item}`);
}

function renderTopicMarkdown(topic = {}) {
  return [
    `# ${topic.title || topic.topicId}`,
    '',
    '## 主题概览',
    topic.overview || '暂无概览。',
    '',
    '## 已确认结论',
    ...renderBulletList(topic.decisions, topic.overview),
    '',
    '## 待确认问题',
    ...renderBulletList(topic.openQuestions),
    '',
    '## 下一步',
    ...renderBulletList(topic.nextActions),
    '',
    '## Source Anchors',
    ...(asArray(topic.sourceEventIds).length
      ? asArray(topic.sourceEventIds).map((eventId) => `- ${eventId}`)
      : ['- none']),
  ].join('\n');
}

function activityRecordFromSummary({ session, summary, acceptedEvents, topics, updatedAt, revision } = {}) {
  const activity = summary?.activity && typeof summary.activity === 'object' ? summary.activity : {};
  const changedPaths = cleanList(activity.changedPaths || activity.changed_paths);
  const defaultChangedPaths = ['abstract.md', 'activities.json', ...asArray(topics).map((topic) => `topics/${topic.topicId}.md`)];
  return {
    activityId: `act_${stableHash(`${session.sessionId}:${updatedAt}:${acceptedEvents.length}:${revision}`)}`,
    sessionId: session.sessionId,
    revision,
    action: cleanText(activity.action || 'merge_summary') || 'merge_summary',
    summary: cleanText(activity.summary || summary?.activitySummary || `同步 ${acceptedEvents.length} 条清洗事件，并更新 ${topics.map((topic) => topic.topicId).join(', ')} topic。`),
    changedPaths: changedPaths.length ? changedPaths : defaultChangedPaths,
    sourceEventIds: asArray(acceptedEvents).map((event) => event.eventId),
    createdAt: updatedAt,
  };
}

function upsertVectorDocument(teamSharingState, document) {
  const index = teamSharingState.vectorDocuments.findIndex((item) => item.vectorDocumentId === document.vectorDocumentId);
  if (index >= 0) {
    teamSharingState.vectorDocuments[index] = { ...teamSharingState.vectorDocuments[index], ...document };
  } else {
    teamSharingState.vectorDocuments.push(document);
  }
}

function updateSessionAbstract(teamSharingState, session, acceptedEvents, options = {}) {
  const title = session.title || 'Untitled AI session';
  const allEvents = asArray(teamSharingState.events[session.sessionId]);
  const sourceEventIds = allEvents.map((event) => event.eventId);
  const fallbackTopicId = inferTopicId({
    title,
    events: allEvents,
    optionalLocalDigest: session.optionalLocalDigest,
  });
  const fallbackOverview = fallbackConversationAbstract({
    title,
    events: allEvents,
    optionalLocalDigest: session.optionalLocalDigest,
  });
  const summary = options.summary && options.summary.ok !== false ? options.summary : null;
  const l0 = cleanText(summary?.l0 || fallbackOverview).slice(0, 1800);
  const topics = asArray(summary?.topics).length
    ? asArray(summary.topics).map((topic) => normalizeSummaryTopic(topic, {
      topicId: fallbackTopicId,
      title: fallbackTopicId,
      overview: fallbackOverview,
      sourceEventIds,
    }))
    : [normalizeSummaryTopic({
      topicId: fallbackTopicId,
      title: fallbackTopicId,
      overview: fallbackOverview,
      sourceEventIds,
      decisions: [],
      openQuestions: [],
      nextActions: [],
    })];
  const abstractMarkdown = [
    '# abstract.md',
    '',
    `Session: ${title}`,
    '',
    '## L0 Abstract',
    l0,
    '',
    '## Topics',
    ...topics.map((topic) => `- [${topic.title || topic.topicId}](topics/${topic.topicId}.md) - ${topic.overview}`),
    '',
    '## Source Anchors',
    ...sourceEventIds.map((eventId) => `- ${session.sessionId}#${eventId}`),
  ].join('\n');
  const updatedAt = options.now?.() || new Date().toISOString();
  const revision = Number(teamSharingState.abstracts[session.sessionId]?.revision || 0) + 1;
  teamSharingState.abstracts[session.sessionId] = {
    sessionId: session.sessionId,
    revision,
    abstractMarkdown,
    topics: topics.reduce((acc, topic) => {
      acc[topic.topicId] = {
        topicId: topic.topicId,
        title: topic.title,
        overview: topic.overview,
        decisions: topic.decisions,
        openQuestions: topic.openQuestions,
        nextActions: topic.nextActions,
        overviewMarkdown: renderTopicMarkdown(topic),
        sourceEventIds: topic.sourceEventIds,
        updatedAt,
      };
      return acc;
    }, { ...(teamSharingState.abstracts[session.sessionId]?.topics || {}) }),
    updatedAt,
  };
  const common = {
    workspaceId: session.workspaceId,
    channelId: session.channelId,
    projectKey: session.projectKey,
    runtime: session.runtime,
    sessionId: session.sessionId,
    title,
    updatedAt,
    active: true,
  };
  upsertVectorDocument(teamSharingState, {
    ...common,
    vectorDocumentId: `${session.sessionId}:L0`,
    layer: 'L0',
    topicId: '',
    sourceRef: `${session.sessionId}/abstract.md`,
    text: `${title}\n${l0}`,
    vectorScore: 0,
    keywordScore: 0,
    freshnessScore: 1,
  });
  for (const topic of topics) {
    upsertVectorDocument(teamSharingState, {
      ...common,
      vectorDocumentId: `${session.sessionId}:L1:${topic.topicId}`,
      layer: 'L1',
      topicId: topic.topicId,
      sourceRef: `${session.sessionId}/topics/${topic.topicId}.md#${topic.sourceEventIds[0] || ''}`,
      text: `${title}\n${topic.title}\n${topic.overview}`,
      vectorScore: 0,
      keywordScore: 0,
      freshnessScore: 1,
    });
  }
  if (acceptedEvents.length) {
    teamSharingState.activities.push(activityRecordFromSummary({ session, summary, acceptedEvents, topics, updatedAt, revision }));
  }
  session.abstractRevision = teamSharingState.abstracts[session.sessionId].revision;
  session.indexStatus = 'ready';
  session.topicIds = [...new Set([...(session.topicIds || []), ...topics.map((topic) => topic.topicId)])];
}

function ensureChannelExists(state, channelId) {
  if (!channelId) return true;
  return asArray(state.channels).some((channel) => channel.id === channelId);
}

export async function syncTeamSharingBatch(packageBody = {}, deps = {}) {
  const state = deps.state || {};
  const teamSharingState = ensureTeamSharingState(state.teamSharing);
  state.teamSharing = teamSharingState;
  const now = deps.now || (() => new Date().toISOString());
  const makeId = deps.makeId || ((prefix) => `${prefix}_${stableHash(`${prefix}:${Date.now()}:${Math.random()}`)}`);
  const sessionId = String(packageBody.sessionId || '').trim();
  let channelId = String(packageBody.channelId || packageBody.defaultChannelId || '').trim();
  const channelPath = String(packageBody.channelPath || packageBody.defaultChannelPath || '').trim();
  if (!channelId && channelPath) {
    const resolved = validateChannelImportPath(channelPath, { state });
    if (resolved.ok) channelId = resolved.channelId;
  }
  if (!sessionId) return { ok: false, code: 'missing_session_id', error: 'sessionId is required.' };
  if (!channelId) return { ok: false, code: 'missing_channel_id', error: 'channelId is required.' };
  if (!ensureChannelExists(state, channelId)) return { ok: false, code: 'channel_not_found', error: 'Channel not found.' };

  const idempotencyKey = String(packageBody.idempotencyKey || '').trim()
    || `${normalizeRuntime(packageBody.runtime)}:${packageBody.projectKey || ''}:${sessionId}:${packageBody.fromOrdinal || 0}:${packageBody.toOrdinal || 0}:${stableHash(JSON.stringify(packageBody.events || []))}`;
  if (teamSharingState.syncLedger[idempotencyKey]?.status === 'accepted') {
    return {
      ok: true,
      duplicate: true,
      sessionId,
      messageId: teamSharingState.sessions[sessionId]?.messageId || '',
      appendedEventCount: 0,
    };
  }

  const createdAt = now();
  const uploader = {
    id: String(packageBody.humanId || 'hum_local').trim() || 'hum_local',
    name: cleanText(packageBody.humanName || packageBody.uploaderName || packageBody.userName || ''),
    avatar: String(packageBody.humanAvatar || packageBody.uploaderAvatar || packageBody.userAvatar || '').trim(),
    email: String(packageBody.humanEmail || packageBody.uploaderEmail || packageBody.userEmail || '').trim(),
  };
  const session = teamSharingState.sessions[sessionId] || {
    sessionId,
    workspaceId: String(packageBody.workspaceId || state.connection?.workspaceId || 'local'),
    channelId,
    runtime: normalizeRuntime(packageBody.runtime),
    projectKey: String(packageBody.projectKey || ''),
    projectPathHash: String(packageBody.projectPathHash || ''),
    title: cleanSessionTitle(packageBody.title || 'Untitled AI session'),
    messageId: '',
    lastEventOrdinal: 0,
    abstractRevision: 0,
    indexStatus: 'pending',
    topicIds: [],
    createdAt,
    updatedAt: createdAt,
  };
  session.title = cleanSessionTitle(packageBody.title || session.title || 'Untitled AI session');
  session.runtime = normalizeRuntime(packageBody.runtime || session.runtime);
  session.channelId = channelId;
  session.uploader = {
    ...(session.uploader || {}),
    ...Object.fromEntries(Object.entries(uploader).filter(([, value]) => Boolean(value))),
  };
  session.optionalLocalDigest = cleanText(packageBody.optionalLocalDigest || session.optionalLocalDigest || '');
  teamSharingState.sessions[sessionId] = session;

  state.messages = asArray(state.messages);
  let message = session.messageId ? state.messages.find((item) => item.id === session.messageId) : null;
  if (!message) {
    message = {
      id: makeId('msg'),
      workspaceId: session.workspaceId,
      spaceType: 'channel',
      spaceId: channelId,
      authorType: 'human',
      authorId: uploader.id,
      body: session.title,
      attachmentIds: [],
      mentionedAgentIds: [],
      mentionedHumanIds: [],
      readBy: [],
      replyCount: 0,
      savedBy: [],
      reactions: [],
      followedBy: [],
      createdAt,
      updatedAt: createdAt,
      metadata: {},
    };
    state.messages.push(message);
    session.messageId = message.id;
  }
  message.workspaceId = session.workspaceId;
  message.spaceType = 'channel';
  message.spaceId = channelId;
  message.authorType = 'human';
  message.authorId = uploader.id || message.authorId || 'hum_local';
  message.body = session.title;
  message.metadata = {
    ...(message.metadata || {}),
    systemKind: 'team_sharing_session',
    teamSharing: {
      ...(message.metadata?.teamSharing || {}),
      runtime: session.runtime,
      projectKey: session.projectKey,
      sessionId,
      uploader: session.uploader || uploader,
    },
  };

  const existingEvents = new Map(asArray(teamSharingState.events[sessionId]).map((event) => [event.eventId, event]));
  const acceptedEvents = [];
  for (const rawEvent of asArray(packageBody.events)) {
    const event = normalizeTeamSharingEvent(rawEvent, sessionId);
    if (!event) continue;
    const duplicate = existingEvents.get(event.eventId);
    if (duplicate && duplicate.sourceHash === event.sourceHash) continue;
    existingEvents.set(event.eventId, event);
    acceptedEvents.push(event);
  }
  teamSharingState.events[sessionId] = [...existingEvents.values()]
    .sort((left, right) => Number(left.ordinal || 0) - Number(right.ordinal || 0) || left.createdAt.localeCompare(right.createdAt));

  state.replies = asArray(state.replies);
  for (const event of acceptedEvents) {
    const reply = {
      id: makeId('rep'),
      workspaceId: session.workspaceId,
      parentMessageId: session.messageId,
      spaceType: 'channel',
      spaceId: channelId,
      authorType: event.role === 'user' ? 'human' : 'agent',
      authorId: event.role === 'user' ? uploader.id : runtimeAgentId(session.runtime),
      body: event.cleanText,
      attachmentIds: [],
      mentionedAgentIds: [],
      mentionedHumanIds: [],
      savedBy: [],
      readBy: [],
      reactions: [],
      createdAt: event.createdAt || createdAt,
      updatedAt: event.createdAt || createdAt,
      metadata: {
        systemKind: 'team_sharing_event',
        teamSharing: {
          runtime: session.runtime,
          projectKey: session.projectKey,
          sessionId,
          eventId: event.eventId,
          ordinal: event.ordinal,
          sourceAnchor: event.sourceAnchor,
          uploader: session.uploader || uploader,
        },
      },
    };
    state.replies.push(reply);
  }
  const parent = asArray(state.messages).find((message) => message.id === session.messageId);
  if (parent) {
    parent.replyCount = asArray(state.replies).filter((reply) => reply.parentMessageId === session.messageId).length;
    parent.updatedAt = now();
  }

  if (acceptedEvents.length) {
    session.lastEventOrdinal = Math.max(session.lastEventOrdinal || 0, ...acceptedEvents.map((event) => Number(event.ordinal || 0)));
    session.updatedAt = now();
    let summary = null;
    if (typeof deps.summarizeSession === 'function') {
      try {
        summary = await deps.summarizeSession({
          session,
          events: teamSharingState.events[sessionId],
          acceptedEvents,
          previousAbstract: teamSharingState.abstracts[sessionId]?.abstractMarkdown || '',
        });
      } catch {
        summary = null;
      }
    }
    updateSessionAbstract(teamSharingState, session, acceptedEvents, { now, summary });
  }
  teamSharingState.syncLedger[idempotencyKey] = {
    idempotencyKey,
    runtime: session.runtime,
    projectKey: session.projectKey,
    sessionId,
    fromOrdinal: Number(packageBody.fromOrdinal || 0),
    toOrdinal: Number(packageBody.toOrdinal || 0),
    batchHash: stableHash(JSON.stringify(packageBody.events || [])),
    status: 'accepted',
    appendedEventCount: acceptedEvents.length,
    createdAt,
  };
  return {
    ok: true,
    duplicate: false,
    sessionId,
    messageId: session.messageId,
    appendedEventCount: acceptedEvents.length,
    abstractRevision: session.abstractRevision,
  };
}

export function contextWindowForTeamSharingSession(teamSharingStateInput, sessionId, options = {}) {
  const teamSharingState = ensureTeamSharingState(teamSharingStateInput);
  const events = asArray(teamSharingState.events[String(sessionId || '')]).sort((left, right) => Number(left.ordinal || 0) - Number(right.ordinal || 0));
  if (!events.length) return { ok: false, code: 'session_not_found', events: [], pagination: { hasPrev: false, hasNext: false } };
  const anchorEventId = String(options.anchorEventId || '').trim();
  const direction = String(options.direction || 'around').trim().toLowerCase();
  const order = String(options.order || 'asc').trim().toLowerCase() === 'desc' ? 'desc' : 'asc';
  const limit = Math.max(1, Math.min(100, Number(options.limit || 20)));
  const foundAnchorIndex = anchorEventId ? events.findIndex((event) => event.eventId === anchorEventId) : -1;
  let start = 0;
  let end = events.length;
  if (direction === 'prev' || direction === 'previous') {
    end = foundAnchorIndex < 0 ? events.length : Math.max(0, foundAnchorIndex);
    start = Math.max(0, end - limit);
  } else if (direction === 'next') {
    start = foundAnchorIndex < 0 ? 0 : Math.min(events.length, foundAnchorIndex + 1);
    end = Math.min(events.length, start + limit);
  } else {
    const center = foundAnchorIndex < 0
      ? (order === 'desc' ? events.length - 1 : 0)
      : foundAnchorIndex;
    const before = Math.floor((limit - 1) / 2);
    start = Math.max(0, center - before);
    end = Math.min(events.length, start + limit);
    if (end - start < limit) start = Math.max(0, end - limit);
  }
  const selected = events.slice(start, end);
  return {
    ok: true,
    sessionId,
    events: order === 'desc' ? selected.reverse() : selected,
    pagination: {
      hasPrev: start > 0,
      hasNext: end < events.length,
      prevAnchorEventId: start > 0 ? (events[start]?.eventId || '') : '',
      nextAnchorEventId: end < events.length ? (events[end - 1]?.eventId || '') : '',
    },
  };
}

function hotnessFor(teamSharingState, vectorDocumentId, now = () => new Date().toISOString(), options = {}) {
  const maxBoost = Number.isFinite(Number(options.maxHotnessBoost)) ? Number(options.maxHotnessBoost) : DEFAULT_MAX_HOTNESS_BOOST;
  const halfLifeDays = Number.isFinite(Number(options.halfLifeDays)) ? Number(options.halfLifeDays) : 30;
  const nowMs = Date.parse(now());
  const deduped = new Map();
  for (const item of asArray(teamSharingState.feedback)) {
    if (item.vectorDocumentId !== vectorDocumentId) continue;
    const rawWeight = FEEDBACK_WEIGHTS[item.eventType] ?? 0;
    const eventMs = Date.parse(item.createdAt || '');
    const ageDays = Number.isFinite(nowMs) && Number.isFinite(eventMs)
      ? Math.max(0, (nowMs - eventMs) / 86400000)
      : 0;
    const decay = halfLifeDays > 0 ? Math.pow(0.5, ageDays / halfLifeDays) : 1;
    const score = rawWeight * decay;
    const dedupeKey = item.actorId
      ? `${item.actorId}:${item.eventType}`
      : `${item.feedbackId || item.queryId || item.createdAt || Math.random()}:${item.eventType}`;
    const previous = deduped.get(dedupeKey);
    if (!previous || eventMs >= previous.eventMs) {
      deduped.set(dedupeKey, {
        eventMs: Number.isFinite(eventMs) ? eventMs : 0,
        score,
      });
    }
  }
  const score = [...deduped.values()].reduce((total, item) => total + item.score, 0);
  return Math.max(-maxBoost, Math.min(maxBoost, score));
}

export function applyTeamSharingFeedback(teamSharingStateInput, event = {}) {
  const teamSharingState = ensureTeamSharingState(teamSharingStateInput);
  const vectorDocumentId = String(event.vectorDocumentId || '').trim();
  const eventType = String(event.eventType || '').trim();
  if (!vectorDocumentId || !(eventType in FEEDBACK_WEIGHTS)) {
    return { ok: false, code: 'invalid_feedback' };
  }
  const createdAt = iso(event.createdAt);
  const record = {
    feedbackId: event.feedbackId || `fb_${stableHash(`${event.actorId || ''}:${vectorDocumentId}:${eventType}:${createdAt}`)}`,
    workspaceId: String(event.workspaceId || ''),
    actorId: String(event.actorId || ''),
    queryId: String(event.queryId || ''),
    vectorDocumentId,
    sessionId: String(event.sessionId || ''),
    eventType,
    sourceRef: String(event.sourceRef || ''),
    weight: FEEDBACK_WEIGHTS[eventType],
    createdAt,
  };
  teamSharingState.feedback.push(record);
  return { ok: true, feedback: record, hotnessScore: hotnessFor(teamSharingState, vectorDocumentId, () => createdAt) };
}

export function rankTeamSharingCandidates(params = {}) {
  const teamSharingState = ensureTeamSharingState(params.teamSharingState);
  const queryId = params.queryId || `tmq_${stableHash(`${params.query || ''}:${Date.now()}:${Math.random()}`)}`;
  const rerankByIndex = new Map(asArray(params.rerankResults).map((item) => [Number(item.index), clamp01(item.score)]));
  const trace = {
    queryId,
    normalizedQuery: cleanText(params.query || ''),
    vectorCandidates: [],
    filterReasons: {},
    rerankScores: {},
    hotnessScores: {},
    finalScores: {},
    selectedTop5: [],
  };
  const scored = asArray(params.candidates).map((candidate, index) => {
    const vectorScore = clamp01(candidate.vectorScore ?? candidate.score);
    const rerankScore = rerankByIndex.has(index) ? rerankByIndex.get(index) : vectorScore;
    const keywordScore = clamp01(candidate.keywordScore);
    const freshnessScore = clamp01(candidate.freshnessScore);
    const semanticScore = 0.75 * rerankScore + 0.25 * vectorScore;
    const hotnessScore = hotnessFor(teamSharingState, candidate.vectorDocumentId, params.now, params.hotness);
    const finalScore = (0.75 * semanticScore) + (0.10 * keywordScore) + (0.05 * freshnessScore) + hotnessScore;
    trace.vectorCandidates.push(candidate.vectorDocumentId);
    trace.rerankScores[candidate.vectorDocumentId] = rerankScore;
    trace.hotnessScores[candidate.vectorDocumentId] = hotnessScore;
    trace.finalScores[candidate.vectorDocumentId] = finalScore;
    return {
      ...candidate,
      vectorScore,
      rerankScore,
      semanticScore,
      keywordScore,
      freshnessScore,
      hotnessScore,
      finalScore,
    };
  }).sort((left, right) => right.finalScore - left.finalScore || String(left.vectorDocumentId).localeCompare(String(right.vectorDocumentId)));

  const limit = Math.max(1, Math.min(20, Number(params.limit || 5)));
  const selected = [];
  const sessionCounts = new Map();
  const topicCounts = new Map();
  for (const item of scored) {
    const sessionCount = sessionCounts.get(item.sessionId) || 0;
    const topicKey = `${item.sessionId}:${item.topicId || item.vectorDocumentId}`;
    const topicCount = topicCounts.get(topicKey) || 0;
    if (sessionCount >= 2) {
      trace.filterReasons[item.vectorDocumentId] = 'same_session_cap';
      continue;
    }
    if (item.topicId && topicCount >= 1) {
      trace.filterReasons[item.vectorDocumentId] = 'same_topic_cap';
      continue;
    }
    selected.push(item);
    sessionCounts.set(item.sessionId, sessionCount + 1);
    topicCounts.set(topicKey, topicCount + 1);
    if (selected.length >= limit) break;
  }
  trace.selectedTop5 = selected.map((item) => item.vectorDocumentId);
  teamSharingState.searchTraces.push({
    ...trace,
    createdAt: params.now?.() || new Date().toISOString(),
  });
  return {
    ok: true,
    queryId,
    results: selected,
    trace,
  };
}
