function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function trimSlash(value = '') {
  return String(value || '').replace(/\/+$/, '');
}

function cleanText(value = '') {
  return stripOperationalText(value).replace(/\s+/g, ' ').trim();
}

function cleanMarkdownText(value = '') {
  return stripOperationalText(value)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n([，。；：！？,.!?;:])/g, '$1\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripOperationalText(value = '') {
  return String(value || '')
    .replace(/\s*\bused_tools\s*=\s*[^。\n；;]*/gi, '')
    .replace(/\s*(?:本地摘要补充[:：]\s*)?Tool summary\s*:\s*[^。\n；;]*/gi, '')
    .replace(/\s*已运行\s+\d+\s+条命令\s*/g, ' ');
}

function cleanList(value) {
  return asArray(value).map(cleanText).filter(Boolean).slice(0, 12);
}

function cleanSourceEventIds(value) {
  return asArray(value)
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 1);
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
    overview: cleanMarkdownText(topic.overview || topic.summary || ''),
    decisions: cleanList(topic.decisions),
    openQuestions: cleanList(topic.openQuestions || topic.open_questions),
    nextActions: cleanList(topic.nextActions || topic.next_actions),
    sourceEventIds: cleanSourceEventIds(topic.sourceEventIds || topic.source_event_ids),
  })).filter((topic) => topic.overview);
  const activity = value.activity && typeof value.activity === 'object' ? value.activity : {};
  return {
    ok: true,
    l0: cleanMarkdownText(value.l0 || value.abstract || value.summary || ''),
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
    '- `sourceEventIds` must contain exactly one primary event id that can locate the surrounding original context. Do not dump every supporting event id.',
    '- 每个 topic 的内容必须能作为 Markdown 阅读：先总述，再分点展开，最后给出可回溯的结论或下一步。',
    '- `overview` 必须按子模块组织，优先使用小标题、编号列表或无序列表；不要写成一整段。',
    '- 如果某个 overview / decision 太长，必须拆成多个短 bullet 或小标题；不要把多件事写进一个 bullet。',
    '- Raw ID 必须和对应总结点放在一起，让读者知道这一条结论来自哪段上下文；不要在文档顶部或底部集中堆 Raw ID。',
    '- 不要输出 `Tool summary`、`used_tools`、中间状态播报或 hook 内部执行痕迹；只保留用户正文和最终回复里的结论。',
    '- 不要把单个专有名词、英文词或 API 名称拆成孤立一行；需要强调时放在正文里用 **加粗**。',
    '- 不要让逗号、句号、顿号、冒号、分号等标点出现在行首。',
    '- 链接必须单独成行或单独成一个 Markdown 链接，不要把链接和后续中文说明粘在同一行里。',
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
    '- sourceEventIds must point to the primary event id that locates the context for each topic; include one id per topic, not a long list.',
    '- 输出遵循“总-分-总”：l0 先给整体结论，再分 4-6 个编号要点概括关键分支，最后点出后续如何使用这些信息。',
    '- l0 必须是可读 Markdown：使用小标题、编号列表或无序列表，不能输出一整段长文本。',
    '- topics 必须覆盖 l0 中提到的每个重要分支；不要生成 abstract 未提到的孤立 topic。',
    '- Markdown 阅读体验必须清晰：结构化标题、短段落、重点加粗、必要时使用表格语义；不要输出 Source Anchors 大列表。',
    '- 不要把多个结论合并到一个超长 bullet；每个 bullet 只表达一个结论，必要时使用缩进子 bullet。',
    '- 链接必须独立成行；不要写成 `https://example.com后续说明`，也不要让链接把后面的中文文字吞进去。',
    '- 不要输出 `Tool summary`、`used_tools` 或“已运行 N 条命令”等内部执行信息。',
    '- Raw ID 要贴近对应结论或列表项，而不是集中输出 Raw IDs 列表。',
    '- Output pure JSON only. Do not wrap it in Markdown.',
    '',
    '# Output Schema',
    'Use `l0` as the L0 abstract and `topics` as the L1 topic documents.',
    '{"l0":"Markdown string with 4-6 numbered points, short paragraphs, and standalone links","topics":[{"topicId":"stable-kebab-topic","title":"short title","overview":"structured Markdown L1 topic summary with submodules and no Raw ID dump","decisions":["confirmed decision"],"openQuestions":["unresolved risk"],"nextActions":["concrete follow-up"],"sourceEventIds":["evt_1"]}],"activity":{"action":"merge_summary","summary":"one sentence audit log","changedPaths":["abstract.md","topics/example.md","activities.json"]}}',
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
