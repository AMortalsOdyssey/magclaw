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

function cleanText(value = '') {
  return String(value || '')
    .replace(/(?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?[^\s"',;)]+/gi, '[redacted-secret]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, 'Bearer [redacted-secret]')
    .replace(/\s+/g, ' ')
    .trim();
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
  const text = cleanText(event.cleanText || event.text || event.content || event.body || '');
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
  const fallbackTopicId = inferTopicId({
    title,
    events: allEvents,
    optionalLocalDigest: session.optionalLocalDigest,
  });
  const sourceEventIds = allEvents.map((event) => event.eventId);
  const firstLine = allEvents.find((event) => event.role === 'assistant')?.cleanText
    || allEvents.find((event) => event.role === 'user')?.cleanText
    || session.optionalLocalDigest
    || title;
  const fallbackOverview = cleanText(firstLine).slice(0, 700);
  const summary = options.summary && options.summary.ok !== false ? options.summary : null;
  const l0 = cleanText(summary?.l0 || `本 session 围绕「${title}」沉淀团队可召回上下文。${fallbackOverview}`);
  const topics = asArray(summary?.topics).length
    ? asArray(summary.topics).map((topic) => ({
      topicId: safeSegment(topic.topicId || topic.title || fallbackTopicId, 'topic'),
      title: cleanText(topic.title || topic.topicId || fallbackTopicId),
      overview: cleanText(topic.overview || fallbackOverview).slice(0, 1600),
      sourceEventIds: asArray(topic.sourceEventIds).length ? asArray(topic.sourceEventIds) : sourceEventIds,
    }))
    : [{
      topicId: fallbackTopicId,
      title: fallbackTopicId,
      overview: fallbackOverview,
      sourceEventIds,
    }];
  const abstractMarkdown = [
    `# ${title}`,
    '',
    '## L0 Abstract',
    l0,
    '',
    '## Topics Index',
    ...topics.map((topic) => `- [${topic.title || topic.topicId}](topics/${topic.topicId}/overview.md) - ${topic.overview}`),
    '',
    '## Workspace Files',
    '- [Activities](activities.md) - 每次同步与摘要更新的审计记录。',
    '- [Original Context](details/original-context.md) - L2 原文锚点与动态上下文页入口。',
    '',
    '## Source Anchors',
    ...sourceEventIds.map((eventId) => `- ${session.sessionId}#${eventId}`),
  ].join('\n');
  const updatedAt = options.now?.() || new Date().toISOString();
  teamSharingState.abstracts[session.sessionId] = {
    sessionId: session.sessionId,
    revision: Number(teamSharingState.abstracts[session.sessionId]?.revision || 0) + 1,
    abstractMarkdown,
    topics: topics.reduce((acc, topic) => {
      acc[topic.topicId] = {
        topicId: topic.topicId,
        title: topic.title,
        overviewMarkdown: [
          `# ${topic.title || topic.topicId}`,
          '',
          topic.overview,
          '',
          `Source events: ${topic.sourceEventIds.join(', ') || 'none'}`,
        ].join('\n'),
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
      sourceRef: `${session.sessionId}/topics/${topic.topicId}/overview.md#${topic.sourceEventIds[0] || ''}`,
      text: `${title}\n${topic.title}\n${topic.overview}`,
      vectorScore: 0,
      keywordScore: 0,
      freshnessScore: 1,
    });
  }
  if (acceptedEvents.length) {
    const changedPaths = ['abstract.md', 'activities.md', 'details/original-context.md', ...topics.map((topic) => `topics/${topic.topicId}/overview.md`)];
    teamSharingState.activities.push({
      activityId: `act_${stableHash(`${session.sessionId}:${updatedAt}:${acceptedEvents.length}`)}`,
      sessionId: session.sessionId,
      summary: cleanText(summary?.activitySummary || `同步 ${acceptedEvents.length} 条清洗事件，并更新 ${topics.map((topic) => topic.topicId).join(', ')} topic。`),
      changedPaths,
      createdAt: updatedAt,
    });
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
  const session = teamSharingState.sessions[sessionId] || {
    sessionId,
    workspaceId: String(packageBody.workspaceId || state.connection?.workspaceId || 'local'),
    channelId,
    runtime: normalizeRuntime(packageBody.runtime),
    projectKey: String(packageBody.projectKey || ''),
    projectPathHash: String(packageBody.projectPathHash || ''),
    title: cleanText(packageBody.title || 'Untitled AI session') || 'Untitled AI session',
    messageId: '',
    lastEventOrdinal: 0,
    abstractRevision: 0,
    indexStatus: 'pending',
    topicIds: [],
    createdAt,
    updatedAt: createdAt,
  };
  session.channelId = channelId;
  session.optionalLocalDigest = cleanText(packageBody.optionalLocalDigest || session.optionalLocalDigest || '');
  teamSharingState.sessions[sessionId] = session;

  if (!session.messageId) {
    const message = {
      id: makeId('msg'),
      workspaceId: session.workspaceId,
      spaceType: 'channel',
      spaceId: channelId,
      authorType: 'system',
      authorId: 'team_sharing',
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
      metadata: {
        systemKind: 'team_sharing_session',
        teamSharing: {
          runtime: session.runtime,
          projectKey: session.projectKey,
          sessionId,
        },
      },
    };
    state.messages = asArray(state.messages);
    state.messages.push(message);
    session.messageId = message.id;
  }

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
      authorId: event.role === 'user' ? String(packageBody.humanId || 'hum_local') : String(packageBody.agentId || 'team_sharing_agent'),
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
    const center = foundAnchorIndex < 0 ? 0 : foundAnchorIndex;
    const before = Math.floor((limit - 1) / 2);
    start = Math.max(0, center - before);
    end = Math.min(events.length, start + limit);
  }
  return {
    ok: true,
    sessionId,
    events: events.slice(start, end),
    pagination: {
      hasPrev: start > 0,
      hasNext: end < events.length,
      prevAnchorEventId: events[Math.max(0, start - 1)]?.eventId || '',
      nextAnchorEventId: events[end]?.eventId || '',
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
