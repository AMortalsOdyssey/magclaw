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
  return stripOperationalText(redactSecrets(value))
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanMultilineText(value = '') {
  return stripOperationalText(redactSecrets(value))
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripOperationalText(value = '') {
  return String(value || '')
    .replace(/\s*\bused_tools\s*=\s*[^。\n；;]*/gi, '')
    .replace(/\s*(?:本地摘要补充[:：]\s*)?Tool summary\s*:\s*[^。\n；;]*/gi, '')
    .replace(/\s*已运行\s+\d+\s+条命令\s*/g, ' ');
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

function extractCodexPromptRequest(value = '') {
  const raw = String(value || '').replace(/\r\n/g, '\n').trim();
  const match = raw.match(/(?:^|\n)\s*#+\s*My request for Codex:\s*\n?([\s\S]*)/i)
    || raw.match(/My request for Codex:\s*([\s\S]*)/i);
  const request = match?.[1] || raw;
  return cleanMultilineText(markdownLinkText(request
    .replace(/(?:^|\n)\s*#+\s*In app browser:[\s\S]*$/i, '')
    .replace(/(?:^|\n)\s*The next image[\s\S]*$/i, '')
    .replace(/(?:^|\n)\s*Attached image:[\s\S]*$/i, '')
    .trim()));
}

function extractSelectedTextSnippet(value = '') {
  const raw = String(value || '').replace(/\r\n/g, '\n');
  let selected = raw.match(/(?:^|\n)\s*#+\s*Selection\s+\d+\s*\n+([\s\S]*?)(?=(?:^|\n)\s*#+\s*My request for Codex:)/i)?.[1] || '';
  if (!selected) {
    selected = raw.match(/Selected text:\s*(?:#+\s*)?(?:Selection\s+\d+\s*)?(?:[→:：-]\s*)?([\s\S]*?)(?:\s*[→\n]\s*#+?\s*My request for Codex:|#+\s*My request for Codex:)/i)?.[1] || '';
  }
  return cleanMultilineText(markdownLinkText(selected)).slice(0, 800);
}

function extractBrowserCommentSnippets(value = '') {
  const raw = String(value || '').replace(/\r\n/g, '\n');
  const comments = [];
  const commentPattern = /(?:^|\n)Comment:\s*\n([\s\S]*?)(?=(?:^|\n)(?:#+\s*Comment\s+\d+|#\s+In app browser:|#+\s*My request for Codex:|The next image|Attached image:|Target selector:|Target path:)|$)/gi;
  for (const match of raw.matchAll(commentPattern)) {
    const comment = cleanMultilineText(markdownLinkText(match[1] || '')).slice(0, 1200);
    if (comment) comments.push(comment);
  }
  return comments.slice(0, 12);
}

function extractContextLocationSnippet(value = '') {
  const raw = String(value || '');
  const currentUrl = raw.match(/Current URL:\s*(https?:\/\/[^\s]+)/i)?.[1]
    || raw.match(/Page URL:\s*(https?:\/\/[^\s]+)/i)?.[1]
    || '';
  return cleanMultilineText(currentUrl).slice(0, 300);
}

function extractAttachmentContextSnippet(value = '') {
  const raw = String(value || '');
  const imageCount = (raw.match(/Attached image:/gi) || []).length;
  const appshotCount = (raw.match(/<appshot\b/gi) || []).length;
  const screenshotCount = (raw.match(/screenshot|截图|image evidence/gi) || []).length;
  const pieces = [];
  if (imageCount) pieces.push(`${imageCount} 张图片/截图`);
  if (appshotCount) pieces.push(`${appshotCount} 个页面快照`);
  if (!pieces.length && screenshotCount) pieces.push('包含截图或页面证据');
  return pieces.join('，');
}

function normalizeContentSegments(value = '', role = 'user', provided = []) {
  const providedSegments = asArray(provided)
    .map((segment) => ({
      type: String(segment?.type || '').trim() || 'quote',
      label: cleanText(segment?.label || '').slice(0, 40),
      text: cleanMultilineText(segment?.text || segment?.content || '').slice(0, 2000),
    }))
    .filter((segment) => segment.text);
  const raw = String(value || '');
  const body = role === 'user' && /my request for codex/i.test(raw)
    ? extractCodexPromptRequest(raw)
    : cleanEventText(raw);
  const segments = [];
  if (body) segments.push({ type: 'body', text: body });
  if (providedSegments.length) {
    for (const segment of providedSegments) {
      if (segment.type !== 'body') segments.push(segment);
    }
  } else if (role === 'user') {
    const selected = extractSelectedTextSnippet(raw);
    if (selected) segments.push({ type: 'quote', label: '选取片段', text: selected });
    for (const comment of extractBrowserCommentSnippets(raw)) {
      segments.push({ type: 'quote', label: '页面批注', text: comment });
    }
    const location = extractContextLocationSnippet(raw);
    if (location) segments.push({ type: 'quote', label: '页面位置', text: location });
    const attachment = extractAttachmentContextSnippet(raw);
    if (attachment) segments.push({ type: 'quote', label: '附件与截图', text: attachment });
  }
  const displayText = body || cleanEventText(raw);
  const quoteText = segments
    .filter((segment) => segment.type !== 'body')
    .map((segment) => `${segment.label ? `${segment.label}：` : ''}${segment.text}`)
    .join('\n');
  return {
    displayText,
    cleanText: cleanMultilineText([displayText, quoteText].filter(Boolean).join('\n\n')),
    contentSegments: segments,
  };
}

function cleanMarkdownBody(value = '') {
  return stripOperationalText(redactSecrets(String(value || '').replace(/\r\n/g, '\n')))
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n([，。；：！？,.!?;:])/g, '$1\n')
    .replace(/\n{3,}/g, '\n\n')
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
  const rawText = event.cleanText || event.text || event.content || event.body || '';
  const content = normalizeContentSegments(rawText, cleanRole, event.contentSegments || event.segments || event.metadata?.contentSegments || []);
  const text = content.cleanText;
  const tools = cleanRole === 'assistant' ? toolNamesForEvent(event) : [];
  if (!text) return null;
  const ordinal = Number(event.ordinal);
  const eventId = String(event.eventId || event.id || `${sessionId}:${Number.isFinite(ordinal) ? ordinal : stableHash(text)}`).trim();
  const rawEventId = String(event.rawEventId || event.raw_event_id || eventId).trim();
  return {
    eventId,
    rawEventId,
    ordinal: Number.isFinite(ordinal) ? ordinal : 0,
    role: cleanRole,
    cleanText: text,
    displayText: content.displayText,
    contentSegments: content.contentSegments,
    sourceHash: String(event.sourceHash || stableHash(text)),
    sourceAnchor: String(event.sourceAnchor || `${sessionId}#${eventId}`),
    createdAt: iso(event.createdAt),
    metadata: {
      usedTools: tools,
      rawEventId,
      contentSegments: content.contentSegments,
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
  return cleanText(event.displayText || event.cleanText || event.text || '').slice(0, limit);
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
  const localDigest = cleanText(optionalLocalDigest);
  if (localDigest && !/^Tool summary\b/i.test(localDigest)) pieces.push(`本地摘要补充：${localDigest.slice(0, 360)}`);
  const text = cleanText(pieces.join('。'));
  if (text) return text.slice(0, 1200);
  return cleanText(title || '这段对话暂无可总结内容。');
}

function normalizeSummaryTopic(topic = {}, fallback = {}) {
  const topicId = safeSegment(topic.topicId || topic.id || topic.title || fallback.topicId || fallback.title || 'topic', 'topic');
  const title = cleanText(topic.title || topic.topicId || fallback.title || topicId);
  const overview = cleanMarkdownBody(topic.overview || topic.summary || fallback.overview || '');
  const sourceEventIds = asArray(topic.sourceEventIds || topic.source_event_ids).map((item) => String(item || '').trim()).filter(Boolean);
  const fallbackSourceEventIds = asArray(fallback.sourceEventIds).map((item) => String(item || '').trim()).filter(Boolean);
  const primarySourceEventId = sourceEventIds[0] || fallbackSourceEventIds[0] || '';
  return {
    topicId,
    title,
    overview,
    decisions: cleanList(topic.decisions),
    openQuestions: cleanList(topic.openQuestions || topic.open_questions),
    nextActions: cleanList(topic.nextActions || topic.next_actions),
    sourceEventIds: primarySourceEventId ? [primarySourceEventId] : [],
  };
}

function renderBulletList(items = [], fallback = '') {
  const cleanItems = cleanList(items);
  if (!cleanItems.length) return fallback ? [`- ${fallback}`] : ['- 暂无明确记录'];
  return cleanItems.map((item) => `- ${item}`);
}

function sourceContextUrl(sessionId = '', eventId = '') {
  const params = new URLSearchParams();
  if (eventId) params.set('anchorEventId', eventId);
  params.set('limit', '21');
  params.set('order', 'asc');
  return `/team-sharing/context/${encodeURIComponent(sessionId)}?${params.toString()}`;
}

function markdownHasStructure(value = '') {
  return String(value || '').split('\n').some((line) => /^\s*(#{1,6}\s+|[-*+]\s+|\d+\.\s+|\|.+\|)\S*/.test(line));
}

function summaryLead(value = '') {
  const text = cleanText(value);
  return text.replace(/^([^：:]{2,18})[：:]\s*/, (_match, lead) => `**${lead}**：`);
}

function splitSummaryPoints(value = '', limit = 6) {
  const source = String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\s*页面位置[:：]\s*https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/g, '')
    .replace(/\s*Current URL[:：]\s*https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/gi, '')
    .replace(/(^|[：:。！？!?；;])\s*-\s*/g, '$1\n- ');
  const points = source
    .replace(/([。！？!?])\s*/g, '$1\n')
    .replace(/[；;]\s*/g, '；\n')
    .split('\n')
    .map((item) => cleanText(item).replace(/^[-*+]\s*/, '').replace(/[；;]$/, '。'))
    .filter((item) => item.length >= 6);
  if (points.length <= limit) return points;
  return points.slice(0, limit);
}

function isolateMarkdownLinks(value = '') {
  const urlPattern = /https?:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+/g;
  return String(value || '').split('\n').flatMap((line) => {
    const pieces = [];
    let lastIndex = 0;
    for (const match of line.matchAll(urlPattern)) {
      const before = line.slice(lastIndex, match.index);
      const cleanBefore = cleanText(before)
        .replace(/(?:链接|页面位置|Current URL|URL)[:：]\s*$/i, '')
        .replace(/\s+([，。；：！？,.!?;:])/g, '$1');
      if (cleanBefore) pieces.push(cleanBefore);
      pieces.push(String(match[0] || '').replace(/[，。；：！？,.!?;:]+$/, ''));
      lastIndex = Number(match.index || 0) + String(match[0] || '').length;
    }
    if (!pieces.length) return [line];
    const after = line.slice(lastIndex);
    const cleanAfter = cleanText(after).replace(/^\s*([，。；：！？,.!?;:])/, '');
    if (cleanAfter) pieces.push(cleanAfter);
    return pieces;
  }).join('\n');
}

function stripStandaloneSourceReferences(value = '') {
  return String(value || '').split('\n').filter((line) => {
    const text = line.trim();
    if (!text) return true;
    if (/^(?:[-*+]\s+)?Raw ID[:：]/i.test(text)) return false;
    if (/^(?:[-*+]\s+)?原文[:：]\s*$/.test(text)) return false;
    if (/^(?:[-*+]\s+)?原文[:：]\s*暂无可定位原文/.test(text)) return false;
    if (/^(?:[-*+]\s+)?\[打开原文\]\(/.test(text)) return false;
    if (/^(?:[-*+]\s+)?\[围绕首条来源打开\]\(/.test(text)) return false;
    return true;
  }).join('\n');
}

function sourceReferenceLink(sessionId = '', sourceEventId = '', label = '原文') {
  const eventId = String(sourceEventId || '').trim();
  if (!eventId) return '';
  return `[${label}](${sourceContextUrl(sessionId, eventId)})`;
}

function sourceReferenceSuffix(sessionId = '', sourceEventId = '') {
  const link = sourceReferenceLink(sessionId, sourceEventId);
  return link ? `（${link}）` : '';
}

function appendInlineSourceReference(markdown = '', { sessionId = '', sourceEventId = '' } = {}) {
  const suffix = sourceReferenceSuffix(sessionId, sourceEventId);
  const lines = String(markdown || '').split('\n');
  if (!suffix || lines.some((line) => /\[原文\]\(\/team-sharing\/context\//.test(line))) return lines.join('\n');
  const index = lines.findIndex((line) => {
    const text = line.trim();
    return text
      && !/^#+\s+/.test(text)
      && !/^https?:\/\//i.test(text)
      && !/^```/.test(text)
      && !/^\[.+\]\(/.test(text);
  });
  if (index < 0) return lines.join('\n');
  lines[index] = `${lines[index]}${suffix}`;
  return lines.join('\n');
}

function renderSummaryMarkdown(value = '', options = {}) {
  const body = isolateMarkdownLinks(stripStandaloneSourceReferences(cleanMarkdownBody(value || '')));
  if (!body) return '这段会话暂无可总结内容。';
  const standaloneLinks = body.split('\n').map((line) => line.trim()).filter((line) => /^https?:\/\//i.test(line));
  const textBody = body.split('\n').filter((line) => !/^https?:\/\//i.test(line.trim())).join('\n');
  let rendered = '';
  if (markdownHasStructure(body)) {
    rendered = ensureNestedSummaryMarkdown(normalizeStructuredMarkdown(body), textBody, standaloneLinks);
  } else {
    const points = splitSummaryPoints(textBody);
    rendered = points.length ? ensureNestedSummaryMarkdown(renderNumberedSummaryPoints(points, standaloneLinks), textBody, standaloneLinks) : body;
  }
  return appendInlineSourceReference(rendered, options);
}

function renderNumberedSummaryPoints(points = [], standaloneLinks = []) {
  const rows = [];
  let displayIndex = 1;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const nested = splitSummaryPoints(point, 5);
    const [head, ...rest] = nested.length > 1 ? nested : [point];
    rows.push(`${displayIndex}. ${summaryLead(head)}`);
    if (displayIndex === 1 && standaloneLinks.length) rows.push(...standaloneLinks);
    for (const part of rest) rows.push(`   - ${summaryLead(part)}`);
    if (!rest.length && /[：:]$/.test(point.trim())) {
      let subCount = 0;
      while (index + 1 < points.length && subCount < 4) {
        const next = points[index + 1];
        if (/^[^：:]{2,18}[：:]/.test(next.trim())) break;
        rows.push(`   - ${summaryLead(next)}`);
        index += 1;
        subCount += 1;
      }
    }
    displayIndex += 1;
  }
  if (!rows.some((line) => /^\s+-\s+/.test(line)) && points.length >= 1) {
    return renderGroupedSummaryPoints(points, standaloneLinks);
  }
  return rows.join('\n');
}

function ensureNestedSummaryMarkdown(markdown = '', rawText = '', standaloneLinks = []) {
  const rendered = String(markdown || '').trim();
  if (!rendered || /\n\s+-\s+/.test(rendered)) return rendered;
  const points = splitSummaryPoints(rawText || rendered);
  if (!points.length) return rendered;
  return renderGroupedSummaryPoints(points, standaloneLinks);
}

function summaryGroupKey(value = '') {
  const text = String(value || '');
  if (/部署|上线|发布|验收|测试环境|readyz|Sentinel|CI\/CD/i.test(text)) return 'deploy';
  if (/workspace|Markdown|abstract|summary|Key Changes|topic|Raw ID|链接|预览|阅读体验/i.test(text)) return 'workspace';
  if (/context|上下文|检索|索引|hook|sync|session title|Agent|Codex|ClaudeCode/i.test(text)) return 'context';
  return 'general';
}

function summaryGroupTitle(key = 'general') {
  if (key === 'deploy') return '部署与验收';
  if (key === 'workspace') return 'Workspace Markdown 体验';
  if (key === 'context') return '上下文与索引';
  return '本轮诉求';
}

function renderGroupedSummaryPoints(points = [], standaloneLinks = []) {
  const groups = [];
  const byKey = new Map();
  for (const point of points) {
    const cleaned = cleanText(point);
    if (!cleaned) continue;
    const key = summaryGroupKey(cleaned);
    if (!byKey.has(key)) {
      const group = { key, title: summaryGroupTitle(key), items: [] };
      byKey.set(key, group);
      groups.push(group);
    }
    byKey.get(key).items.push(cleaned);
  }
  if (!groups.length) return '';
  const rows = [];
  groups.forEach((group, index) => {
    rows.push(`${index + 1}. **${group.title}**`);
    for (const item of group.items.slice(0, 5)) rows.push(`   - ${summaryLead(item)}`);
    if (index === 0 && standaloneLinks.length) {
      for (const link of standaloneLinks.slice(0, 3)) rows.push(`   - ${link}`);
    }
  });
  return rows.join('\n');
}

function normalizeStructuredMarkdown(value = '') {
  const lines = String(value || '').split('\n');
  return lines.flatMap((line) => {
    const match = line.match(/^(\s*)((?:[-*+])|(?:\d+\.))\s+(.+)$/);
    if (!match) return [line];
    const [, indent, marker, body] = match;
    if (/^(Raw ID|原文)[:：]/i.test(body.trim()) || /^\[打开原文\]/.test(body.trim())) return [line];
    const pieces = splitSummaryPoints(body, 6);
    if (pieces.length <= 1 && cleanText(body).length <= 180) return [line];
    const [head, ...rest] = pieces.length ? pieces : [body];
    return [
      `${indent}${marker} ${summaryLead(head)}`,
      ...rest.map((item) => `${indent}  - ${summaryLead(item)}`),
    ];
  }).join('\n');
}

function renderSourceReferenceLines(sessionId = '', sourceEventId = '', indent = '') {
  const eventId = String(sourceEventId || '').trim();
  if (!eventId) return [`${indent}- Raw ID: \`none\``, `${indent}- 原文：暂无可定位原文`];
  return [
    `${indent}- Raw ID: \`${eventId}\``,
    `${indent}- 原文：${sourceReferenceLink(sessionId, eventId)}`,
  ];
}

function renderSourcedBulletList(items = [], { fallback = '', sessionId = '', sourceEventId = '' } = {}) {
  const cleanItems = cleanList(items);
  const values = cleanItems.length ? cleanItems : (fallback ? splitSummaryPoints(fallback, 3) : []);
  if (!values.length) return ['- 暂无明确记录'];
  return values.flatMap((item, index) => {
    const pieces = splitSummaryPoints(item, 6);
    const [head, ...rest] = pieces.length ? pieces : [item];
    const renderedHead = cleanItems.length && rest.length === 0
      ? `**${head}**`
      : summaryLead(head);
    const inlineSource = index === 0 ? sourceReferenceSuffix(sessionId, sourceEventId) : '';
    return [
      `- ${renderedHead}${inlineSource}`,
      ...rest.map((part) => `  - ${summaryLead(part)}`),
    ];
  });
}

function renderTopicMarkdown(topic = {}, session = {}) {
  const sourceEventIds = asArray(topic.sourceEventIds).map((eventId) => String(eventId || '').trim()).filter(Boolean);
  const primarySource = sourceEventIds[0] || '';
  return [
    `# ${topic.title || topic.topicId}`,
    '',
    '## Summary',
    ...renderSourcedBulletList([], {
      fallback: cleanMarkdownBody(topic.overview || '暂无概览。'),
      sessionId: session.sessionId,
      sourceEventId: primarySource,
    }),
    '',
    '## Key Changes',
    ...renderSourcedBulletList(topic.decisions, {
      fallback: topic.overview,
      sessionId: session.sessionId,
      sourceEventId: primarySource,
    }),
    '',
    '## Open Questions',
    ...renderBulletList(topic.openQuestions),
    '',
    '## Next Actions',
    ...renderBulletList(topic.nextActions),
    '',
    '## Original Context',
    primarySource
      ? [
        `点击正文里的 ${sourceReferenceLink(session.sessionId, primarySource)} 可以打开动态原始上下文。`,
        '页面会以该消息为中心，按时间正序展示前后消息，并支持继续向上或向下加载。',
      ].join('\n')
      : '暂无可定位原始上下文。',
  ].join('\n');
}

function renderTopicOverviewBlocks(topics = [], session = {}) {
  const cleanTopics = asArray(topics);
  if (!cleanTopics.length) return ['- 暂无 topic'];
  return cleanTopics.flatMap((topic, index) => {
    const rawId = asArray(topic.sourceEventIds)[0] || '';
    const summaryPoints = splitSummaryPoints(cleanText(topic.overview), 4);
    const topicTitle = topic.title || topic.topicId;
    return [
      ...(index > 0 ? [''] : []),
      `### [${topicTitle}](topics/${topic.topicId}.md)`,
      '',
      '- 摘要：',
      ...(summaryPoints.length
        ? summaryPoints.map((item, itemIndex) => `  - ${summaryLead(item)}${itemIndex === 0 ? sourceReferenceSuffix(session.sessionId, rawId) : ''}`)
        : [`  - 暂无摘要${sourceReferenceSuffix(session.sessionId, rawId)}`]),
    ];
  });
}

function debugExcerpt(value = '', limit = 900) {
  const text = cleanMarkdownBody(value || '');
  if (!text) return '(empty)';
  return text.length > limit ? `${text.slice(0, limit).trim()}...` : text;
}

function debugFence(value = '', limit = 900) {
  return [
    '```markdown',
    debugExcerpt(value, limit).replace(/```/g, '~~~'),
    '```',
  ].join('\n');
}

function debugEventLines(events = [], role = '') {
  const selected = asArray(events)
    .filter((event) => !role || event.role === role)
    .map((event) => {
      const rawId = event.rawEventId || event.eventId || '';
      const text = debugExcerpt(event.displayText || event.cleanText || event.text || '', 520);
      return `- \`${rawId || 'unknown'}\`: ${text}`;
    });
  return selected.length ? selected : ['- 暂无本轮记录'];
}

function summaryMarkdownFromAbstract(abstractMarkdown = '') {
  return String(abstractMarkdown || '').match(/## Summary\n([\s\S]*?)(?=\n## |$)/)?.[1]?.trim() || '';
}

function topicDebugBody(topic = {}) {
  return cleanMarkdownBody([
    topic.title || topic.topicId || '',
    topic.overview || topic.overviewMarkdown || '',
    ...cleanList(topic.decisions || []).map((item) => `Decision: ${item}`),
    ...cleanList(topic.openQuestions || []).map((item) => `Open: ${item}`),
    ...cleanList(topic.nextActions || []).map((item) => `Next: ${item}`),
  ].filter(Boolean).join('\n'));
}

function changeTypeForText(before = '', after = '') {
  if (!before && after) return 'created';
  if (before && !after) return 'deleted';
  if (before !== after) return 'updated';
  return 'unchanged';
}

function renderTopicDebugChanges(previousTopics = {}, nextTopics = {}) {
  const ids = [...new Set([
    ...Object.keys(previousTopics || {}),
    ...Object.keys(nextTopics || {}),
  ])].sort();
  if (!ids.length) return ['- 暂无 topic 文档变更'];
  return ids.flatMap((topicId) => {
    const beforeTopic = previousTopics?.[topicId] || null;
    const afterTopic = nextTopics?.[topicId] || null;
    const beforeBody = topicDebugBody(beforeTopic || {});
    const afterBody = topicDebugBody(afterTopic || {});
    const type = changeTypeForText(beforeBody, afterBody);
    return [
      `- \`topics/${topicId}.md\`: \`${type}\``,
      `  - Before: ${debugExcerpt(beforeBody, 220)}`,
      `  - After: ${debugExcerpt(afterBody, 220)}`,
    ];
  });
}

function renderTeamSharingDebugLogEntry({
  session = {},
  acceptedEvents = [],
  summary = null,
  l0Markdown = '',
  previousAbstract = '',
  nextAbstract = '',
  previousTopics = {},
  nextTopics = {},
  updatedAt = '',
  revision = 0,
} = {}) {
  const type = !previousAbstract ? 'create_abstract' : (previousAbstract === nextAbstract ? 'append_round_summary' : 'patch_abstract');
  const curatedSummary = l0Markdown || summary?.l0 || summaryMarkdownFromAbstract(nextAbstract);
  const changedPaths = ['abstract.md', 'debug-log.md', ...renderTopicDebugChanges(previousTopics, nextTopics)
    .map((line) => line.match(/`(topics\/[^`]+\.md)`/)?.[1])
    .filter(Boolean)];
  return [
    `## ${updatedAt || new Date().toISOString()} · rev ${revision}`,
    '',
    `- Type: \`${type}\``,
    `- Accepted events: ${acceptedEvents.length}`,
    `- Session: \`${session.sessionId || ''}\``,
    `- Changed paths: ${[...new Set(changedPaths)].map((item) => `\`${item}\``).join(', ')}`,
    '',
    '### Round Summary',
    '',
    '#### Hook Prompt Summary',
    ...debugEventLines(acceptedEvents, 'user'),
    '',
    '#### Agent Reply Summary',
    ...debugEventLines(acceptedEvents, 'assistant'),
    '',
    '#### Curated Summary Output',
    debugFence(curatedSummary, 1200),
    '',
    '### Cloud Merge',
    '',
    `- Merge source: latest hook events + optional local digest + ${previousAbstract ? 'existing Abstract.md' : 'empty Abstract.md'}.`,
    `- Operation: \`${type}\`, producing Abstract.md revision ${revision}.`,
    `- Summary model result: ${summary?.ok === false ? 'fallback summary' : (summary ? 'authoritative summary' : 'fallback summary')}.`,
    '',
    '### Abstract Diff',
    '',
    '#### Before',
    debugFence(previousAbstract, 900),
    '',
    '#### After',
    debugFence(nextAbstract, 1200),
    '',
    '### Topics Folder Changes',
    ...renderTopicDebugChanges(previousTopics, nextTopics),
  ].join('\n');
}

function appendTeamSharingDebugLog(existing = '', title = '', entry = '') {
  const header = [
    `# ${title || 'Team Sharing Session'} Debug Log`,
    '',
    'Append-only sync log for inspecting hook prompts, agent summaries, cloud merge output, and workspace file changes.',
  ].join('\n');
  const base = String(existing || '').trim() || header;
  return `${base}\n\n${String(entry || '').trim()}\n`;
}

function activityRecordFromSummary({ session, summary, acceptedEvents, topics, updatedAt, revision } = {}) {
  const activity = summary?.activity && typeof summary.activity === 'object' ? summary.activity : {};
  const changedPaths = cleanList(activity.changedPaths || activity.changed_paths);
  const defaultChangedPaths = ['abstract.md', 'debug-log.md', 'activities.json', ...asArray(topics).map((topic) => `topics/${topic.topicId}.md`)];
  const effectiveChangedPaths = changedPaths.length
    ? [...new Set([...changedPaths, 'debug-log.md'])]
    : defaultChangedPaths;
  return {
    activityId: `act_${stableHash(`${session.sessionId}:${updatedAt}:${acceptedEvents.length}:${revision}`)}`,
    sessionId: session.sessionId,
    revision,
    action: cleanText(activity.action || 'merge_summary') || 'merge_summary',
    summary: cleanText(activity.summary || summary?.activitySummary || `同步 ${acceptedEvents.length} 条清洗事件，并更新 ${topics.map((topic) => topic.topicId).join(', ')} topic。`),
    changedPaths: effectiveChangedPaths,
    sourceEventIds: asArray(acceptedEvents).map((event) => event.eventId),
    createdAt: updatedAt,
  };
}

function applyTeamSharingSessionTitle({ state = {}, teamSharingState = {}, session = {}, title = '', updatedAt = '' } = {}) {
  const cleanTitle = cleanSessionTitle(title || session.title || 'Untitled AI session');
  let changed = false;
  if (session.title !== cleanTitle) {
    session.title = cleanTitle;
    session.updatedAt = updatedAt || session.updatedAt;
    changed = true;
  }
  const message = session.messageId ? asArray(state.messages).find((item) => item.id === session.messageId) : null;
  if (message) {
    if (message.body !== cleanTitle) {
      message.body = cleanTitle;
      message.updatedAt = updatedAt || message.updatedAt;
      changed = true;
    }
    message.metadata = {
      ...(message.metadata || {}),
      teamSharing: {
        ...(message.metadata?.teamSharing || {}),
        title: cleanTitle,
      },
    };
  }
  const abstract = teamSharingState.abstracts?.[session.sessionId];
  if (abstract?.abstractMarkdown) {
    const nextMarkdown = String(abstract.abstractMarkdown).replace(/^#\s+.*$/m, `# ${cleanTitle}`);
    if (nextMarkdown !== abstract.abstractMarkdown) {
      abstract.abstractMarkdown = nextMarkdown;
      abstract.updatedAt = updatedAt || abstract.updatedAt;
      changed = true;
    }
  }
  for (const doc of asArray(teamSharingState.vectorDocuments)) {
    if (doc.sessionId !== session.sessionId) continue;
    if (doc.title !== cleanTitle) {
      doc.title = cleanTitle;
      changed = true;
    }
    if (typeof doc.text === 'string') {
      const parts = doc.text.split('\n');
      if (parts[0] !== cleanTitle) {
        parts[0] = cleanTitle;
        doc.text = parts.join('\n');
        changed = true;
      }
    }
  }
  return changed;
}

function upsertVectorDocument(teamSharingState, document) {
  const index = teamSharingState.vectorDocuments.findIndex((item) => item.vectorDocumentId === document.vectorDocumentId);
  if (index >= 0) {
    teamSharingState.vectorDocuments[index] = { ...teamSharingState.vectorDocuments[index], ...document };
  } else {
    teamSharingState.vectorDocuments.push(document);
  }
}

function authoritativeSearchDocument(teamSharingState, candidate = {}, currentDocument = null) {
  if (currentDocument) return currentDocument;
  const sessionId = String(candidate.sessionId || '').trim();
  const session = teamSharingState.sessions?.[sessionId] || {};
  const title = cleanSessionTitle(session.title || candidate.title || 'Untitled AI session');
  const abstract = teamSharingState.abstracts?.[sessionId] || null;
  if (!abstract) return session.title ? { title } : null;
  if (candidate.layer === 'L0' || !candidate.topicId) {
    const sourceEventIds = asArray(candidate.sourceEventIds || abstract.sourceEventIds).filter(Boolean);
    const rawEventId = String(sourceEventIds[0] || candidate.rawEventId || '').trim();
    return {
      title,
      text: `${title}\n${abstract.abstractMarkdown || candidate.text || ''}`,
      rawEventId,
      sourceEventIds,
      sourceRef: rawEventId ? `${sessionId}/abstract.md#${rawEventId}` : `${sessionId}/abstract.md`,
    };
  }
  const topic = abstract.topics?.[candidate.topicId] || null;
  if (!topic) return { title };
  const sourceEventIds = asArray(topic.sourceEventIds || candidate.sourceEventIds).filter(Boolean);
  const rawEventId = String(topic.rawEventId || sourceEventIds[0] || candidate.rawEventId || '').trim();
  return {
    title,
    text: `${title}\n${topic.title || candidate.topicId}\n${topic.overview || topic.overviewMarkdown || candidate.text || ''}`,
    rawEventId,
    sourceEventIds,
    sourceRef: rawEventId ? `${sessionId}/topics/${topic.topicId || candidate.topicId}.md#${rawEventId}` : `${sessionId}/topics/${topic.topicId || candidate.topicId}.md`,
  };
}

function updateSessionAbstract(teamSharingState, session, acceptedEvents, options = {}) {
  const title = session.title || 'Untitled AI session';
  const allEvents = asArray(teamSharingState.events[session.sessionId]);
  const previousRecord = teamSharingState.abstracts[session.sessionId] || {};
  const previousAbstract = previousRecord.abstractMarkdown || '';
  const previousTopics = previousRecord.topics || {};
  const sourceEventIds = allEvents.map((event) => event.rawEventId || event.eventId);
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
  const l0 = cleanMarkdownBody(summary?.l0 || fallbackOverview).slice(0, 1800);
  const l0Markdown = renderSummaryMarkdown(l0, {
    sessionId: session.sessionId,
    sourceEventId: sourceEventIds[0] || '',
  });
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
    `# ${title}`,
    '',
    '## Summary',
    l0Markdown || '这段会话暂无可总结内容。',
    '',
    '## Key Topics',
    ...renderTopicOverviewBlocks(topics, session),
    '',
    '## Original Context',
    sourceEventIds[0]
      ? [
        `点击正文里的 ${sourceReferenceLink(session.sessionId, sourceEventIds[0])} 可以打开动态原始上下文。`,
        '页面会以该消息为中心，按时间正序展示前后消息，并支持继续向上或向下加载。',
      ].join('\n')
      : '暂无可定位的原始上下文。',
    '',
    '## Closing Notes',
    '这份 workspace 用于检索后的快速复盘：先看 **Summary** 和 **Key Topics**，再通过正文里的 **原文** 链接回到对应对话。具体公开分享仍使用独立的 `/s/<shareId>` 文档链接。',
  ].join('\n');
  const updatedAt = options.now?.() || new Date().toISOString();
  const revision = Number(teamSharingState.abstracts[session.sessionId]?.revision || 0) + 1;
  const nextTopics = topics.reduce((acc, topic) => {
    acc[topic.topicId] = {
      topicId: topic.topicId,
      title: topic.title,
      overview: topic.overview,
      decisions: topic.decisions,
      openQuestions: topic.openQuestions,
      nextActions: topic.nextActions,
      overviewMarkdown: renderTopicMarkdown(topic, session),
      sourceEventIds: topic.sourceEventIds,
      updatedAt,
    };
    return acc;
  }, { ...(teamSharingState.abstracts[session.sessionId]?.topics || {}) });
  const debugEntry = renderTeamSharingDebugLogEntry({
    session,
    acceptedEvents,
    summary,
    l0Markdown,
    previousAbstract,
    nextAbstract: abstractMarkdown,
    previousTopics,
    nextTopics,
    updatedAt,
    revision,
  });
  teamSharingState.abstracts[session.sessionId] = {
    sessionId: session.sessionId,
    revision,
    abstractMarkdown,
    topics: nextTopics,
    debugLogMarkdown: appendTeamSharingDebugLog(previousRecord.debugLogMarkdown || '', title, debugEntry),
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
    rawEventId: sourceEventIds[0] || '',
    sourceEventIds,
    sourceRef: `${session.sessionId}/abstract.md#${sourceEventIds[0] || ''}`,
    text: `${title}\n${l0Markdown}`,
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
      rawEventId: topic.sourceEventIds[0] || '',
      sourceEventIds: topic.sourceEventIds,
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
      title: session.title,
      uploader: session.uploader || uploader,
    },
  };
  const titleChanged = applyTeamSharingSessionTitle({
    state,
    teamSharingState,
    session,
    title: packageBody.title || session.title,
    updatedAt: createdAt,
  });
  if (teamSharingState.syncLedger[idempotencyKey]?.status === 'accepted') {
    return {
      ok: true,
      duplicate: true,
      sessionId,
      messageId: teamSharingState.sessions[sessionId]?.messageId || '',
      appendedEventCount: 0,
      titleChanged,
      abstractRevision: session.abstractRevision,
    };
  }

  const existingEvents = new Map(asArray(teamSharingState.events[sessionId]).map((event) => [event.eventId, event]));
  const acceptedEvents = [];
  for (const rawEvent of asArray(packageBody.events)) {
    const event = normalizeTeamSharingEvent(rawEvent, sessionId);
    if (!event) continue;
    const duplicate = existingEvents.get(event.eventId);
    if (duplicate && duplicate.sourceHash === event.sourceHash) continue;
    existingEvents.set(event.eventId, event);
    event.metadata = {
      ...(event.metadata || {}),
      uploader: session.uploader || uploader,
    };
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
      body: event.displayText || event.cleanText,
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
          contentSegments: event.contentSegments || event.metadata?.contentSegments || [],
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
  const session = teamSharingState.sessions[String(sessionId || '')] || null;
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
    session: session ? {
      sessionId: session.sessionId,
      title: session.title || '',
      runtime: session.runtime || '',
      uploader: session.uploader || {},
      workspaceId: session.workspaceId || '',
      channelId: session.channelId || '',
    } : { sessionId, title: '', runtime: '', uploader: {} },
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
  const currentDocumentsById = new Map(asArray(teamSharingState.vectorDocuments).map((doc) => [doc.vectorDocumentId, doc]));
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
    const currentDocument = authoritativeSearchDocument(teamSharingState, candidate, currentDocumentsById.get(candidate.vectorDocumentId));
    const enrichedCandidate = currentDocument ? {
      ...candidate,
      ...currentDocument,
      vectorScore: candidate.vectorScore ?? candidate.score ?? currentDocument.vectorScore,
      score: candidate.score,
      keywordScore: candidate.keywordScore ?? currentDocument.keywordScore,
      freshnessScore: candidate.freshnessScore ?? currentDocument.freshnessScore,
    } : candidate;
    candidate = enrichedCandidate;
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
