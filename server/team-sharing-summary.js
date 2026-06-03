function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function trimSlash(value = '') {
  return String(value || '').replace(/\/+$/, '');
}

function cleanText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function cleanList(value) {
  return asArray(value).map(cleanText).filter(Boolean).slice(0, 12);
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
    decisions: cleanList(topic.decisions),
    openQuestions: cleanList(topic.openQuestions || topic.open_questions),
    nextActions: cleanList(topic.nextActions || topic.next_actions),
    sourceEventIds: asArray(topic.sourceEventIds || topic.source_event_ids).map((item) => String(item || '').trim()).filter(Boolean),
  })).filter((topic) => topic.overview);
  const activity = value.activity && typeof value.activity === 'object' ? value.activity : {};
  return {
    ok: true,
    l0: cleanText(value.l0 || value.abstract || value.summary || ''),
    topics,
    activity: {
      action: cleanText(activity.action || 'merge_summary') || 'merge_summary',
      summary: cleanText(activity.summary || value.activitySummary || value.activity_summary || ''),
      changedPaths: cleanList(activity.changedPaths || activity.changed_paths),
    },
    activitySummary: cleanText(value.activitySummary || value.activity_summary || activity.summary || ''),
  };
}

export function buildCodexLocalDigestPrompt({ session = {}, events = [] } = {}) {
  const eventLines = asArray(events).map((event) => [
    `eventId: ${event.eventId || ''}`,
    `role: ${event.role || ''}`,
    `content: ${event.cleanText || event.text || ''}`,
  ].join('\n')).join('\n\n---\n\n');
  return [
    '# Role',
    'You are the local Codex session digest writer for MagClaw Team Sharing.',
    '',
    '# Goal',
    'Summarize the current AI session using the context you can see locally, so the cloud service receives a richer digest than raw user/assistant text alone.',
    '',
    '# Output',
    'Return concise Markdown with these headings: `Task / Topic`, `Important Context`, `Decisions`, `Open Questions`, `Useful Artifacts`, `Source Event IDs`.',
    '',
    '# Rules',
    '- Summarize what actually happened in the conversation, including user corrections, final conclusions, and reusable insights.',
    '- Mention tools or skills only by name when they materially affected the result.',
    '- Do not include hidden reasoning, private secrets, long tool output, or unrelated injected system context.',
    '- Preserve concrete names, APIs, commands, file paths, and product decisions when they are relevant.',
    '',
    '# Session',
    `sessionId: ${session.sessionId || ''}`,
    `title: ${session.title || ''}`,
    '',
    '# Events',
    eventLines || '(none)',
  ].join('\n');
}

export function buildTeamSharingTopicsPromptSection() {
  return [
    '# Topics Contract',
    'Create L1 topic documents from the transcript. A topic is a real work subject, decision area, feature, bug, research question, or implementation thread.',
    '',
    'For each topic:',
    '- Use a stable `topicId` in kebab-case Chinese/English-safe text.',
    '- `title` must be human-readable and specific.',
    '- `overview` must explain the actual discussion, important context, conclusion, and why it matters for future recall.',
    '- `decisions` lists confirmed conclusions, not vague summaries.',
    '- `openQuestions` lists unresolved uncertainties or risks.',
    '- `nextActions` lists concrete follow-ups when present.',
    '- `sourceEventIds` must cite the event ids that support the topic.',
    '',
    'Do not create a topic for generic session bookkeeping, title text, cloned repository names, or incidental setup unless that setup is the actual subject.',
  ].join('\n');
}

export function buildTeamSharingSummaryPrompt({ session = {}, events = [], previousAbstract = '' } = {}) {
  const eventLines = asArray(events).map((event) => [
    `eventId: ${event.eventId}`,
    `role: ${event.role}`,
    `content: ${event.cleanText || event.text || ''}`,
  ].join('\n')).join('\n\n---\n\n');
  return [
    '# Role',
    'You are the MagClaw cloud abstract curator for team AI sessions.',
    '',
    '# Goal',
    'Merge the latest hook upload, optional local digest, and previous abstract into an authoritative retrieval workspace. The result must describe the conversation content itself, not just rephrase the session title.',
    '',
    '# Hard Rules',
    '- 只基于 events、optionalLocalDigest 和 previousAbstract 总结，不要编造隐藏思考、未出现的工具输出或未给出的仓库事实。',
    '- Abstract 的目标是让团队后来能快速理解这段对话沉淀了什么判断、结论、上下文、风险和下一步，而不是写“本 session 围绕某标题”。',
    '- Preserve concrete product, architecture, decision, risk, API, command, and file/path references when they matter.',
    '- If the new events correct or refine earlier conclusions, update the abstract instead of appending contradictory text.',
    '- Split unrelated topics into separate L1 topic documents.',
    '- sourceEventIds must point to the event ids that support each topic.',
    '- Output pure JSON only. Do not wrap it in Markdown.',
    '',
    '# Output Schema',
    'Use `l0` as the L0 abstract and `topics` as the L1 topic documents.',
    '{"l0":"200-500 Chinese chars summarizing the actual conversation content and key conclusions","topics":[{"topicId":"stable-kebab-topic","title":"short title","overview":"L1 topic document body for planning and retrieval","decisions":["confirmed decision"],"openQuestions":["unresolved risk"],"nextActions":["concrete follow-up"],"sourceEventIds":["evt_1"]}],"activity":{"action":"merge_summary","summary":"one sentence audit log","changedPaths":["abstract.md","topics/example.md","activities.json"]}}',
    '',
    buildTeamSharingTopicsPromptSection(),
    '',
    '# Session',
    `sessionId: ${session.sessionId || ''}`,
    `title: ${session.title || ''}`,
    `optionalLocalDigest: ${session.optionalLocalDigest || ''}`,
    '',
    '# Previous Abstract And Topics',
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
