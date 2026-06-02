function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function trimSlash(value = '') {
  return String(value || '').replace(/\/+$/, '');
}

function cleanText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function extractJsonObject(text = '') {
  const raw = String(text || '').trim();
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fence ? fence[1].trim() : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Summary response did not contain JSON.');
  return JSON.parse(candidate.slice(start, end + 1));
}

function normalizeSummary(value = {}) {
  const topics = asArray(value.topics).map((topic) => ({
    topicId: cleanText(topic.topicId || topic.id || topic.title || 'topic').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '') || 'topic',
    title: cleanText(topic.title || topic.topicId || 'Topic'),
    overview: cleanText(topic.overview || topic.summary || ''),
    sourceEventIds: asArray(topic.sourceEventIds || topic.source_event_ids).map((item) => String(item || '').trim()).filter(Boolean),
  })).filter((topic) => topic.overview);
  return {
    ok: true,
    l0: cleanText(value.l0 || value.abstract || value.summary || ''),
    topics,
    activitySummary: cleanText(value.activitySummary || value.activity_summary || ''),
  };
}

export function buildTeamSharingSummaryPrompt({ session = {}, events = [], previousAbstract = '' } = {}) {
  const eventLines = asArray(events).map((event) => [
    `eventId: ${event.eventId}`,
    `role: ${event.role}`,
    `content: ${event.cleanText || event.text || ''}`,
  ].join('\n')).join('\n\n---\n\n');
  return [
    '# Role',
    'You are MagClaw team-sharing abstract writer. Build a retrieval-grade workspace abstract from AI collaboration transcripts.',
    '',
    '# Goal',
    'Update the authoritative abstract for this session. Keep it useful for future team recall, not just as a chat summary.',
    '',
    '# Hard Rules',
    '- 只基于给定 events 和 previousAbstract 总结，不要编造隐藏思考、未出现的工具输出或未给出的仓库事实。',
    '- Preserve concrete product, architecture, decision, risk, API, and file/path references when they matter.',
    '- Split unrelated topics into separate L1 topics.',
    '- sourceEventIds must point to the event ids that support each topic.',
    '- Output pure JSON only.',
    '',
    '# Output Schema',
    '{"l0":"one concise L0 abstract","topics":[{"topicId":"stable-kebab-topic","title":"short title","overview":"L1 overview for planning and retrieval","sourceEventIds":["evt_1"]}],"activitySummary":"one sentence audit log"}',
    '',
    '# Session',
    `sessionId: ${session.sessionId || ''}`,
    `title: ${session.title || ''}`,
    '',
    '# Previous Abstract',
    previousAbstract || '(none)',
    '',
    '# Events',
    eventLines || '(none)',
  ].join('\n');
}

export function createTeamSharingSummaryClient(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const baseUrl = trimSlash(options.baseUrl || process.env.MAGCLAW_LLM_BASE_URL || process.env.BASE_URL || '');
  const apiKey = options.apiKey || process.env.MAGCLAW_LLM_API_KEY || process.env.API_KEY || '';
  const model = options.model || process.env.MAGCLAW_LLM_MODEL || process.env.MODEL || 'gpt-5.5';
  return {
    async summarizeSession(input = {}) {
      if (!baseUrl) throw new Error('Team sharing summary base URL is not configured.');
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: 'You write precise, source-grounded team sharing abstracts.' },
            { role: 'user', content: buildTeamSharingSummaryPrompt(input) },
          ],
          response_format: { type: 'json_object' },
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error?.message || data?.error || data?.message || `${response.status} ${response.statusText}`);
      }
      const content = data?.choices?.[0]?.message?.content || data?.output_text || data?.content || '';
      return normalizeSummary(extractJsonObject(content));
    },
  };
}
