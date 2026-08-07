const SUMMARY_TASK_TYPES = new Set([
  'feature',
  'bugfix',
  'performance',
  'investigation',
  'design',
  'deployment',
  'research',
  'documentation',
  'custom',
]);

const SUMMARY_ITEM_STATUSES = new Set(['done', 'verified', 'decision', 'partial', 'blocked', 'info']);

function clean(value = '', max = 4000) {
  return String(value || '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim().slice(0, max);
}

const SENSITIVE_QUERY_KEY = /^(?:access_?token|auth|authorization|code|credential|key|password|secret|signature|token|x-amz-.+)$/i;

export function redactNotifyPublicText(value = '', max = 96 * 1024) {
  return String(value || '')
    .replace(/\u0000/g, '')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [redacted]')
    .replace(/\bglpat-[A-Za-z0-9_-]{8,}\b/g, '[redacted-secret]')
    .replace(/\b(?:ghp|gho|ghs)_[A-Za-z0-9_]{16,}\b/g, '[redacted-secret]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]{16,}\b/g, '[redacted-secret]')
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]{5,})?\b/g, '[redacted-jwt]')
    .replace(/\b(?:sk|rk|pk|mcn|mfp)_[A-Za-z0-9_-]{16,}\b/g, '[redacted-secret]')
    .replace(/\b(?:oc|ou|on|om|cli)_[A-Za-z0-9_-]+\b/g, '[redacted-feishu-id]')
    .replace(/((?:app[_ -]?secret|client[_ -]?secret|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authorization|password|passwd|token|secret)\s*[:=]\s*)[^\s,;\])}"'<>]+/gi, '$1[redacted]')
    .replace(/([?&](?:access_?token|auth|authorization|code|credential|key|password|secret|signature|token|x-amz-[^=&#\s]+)=)[^&#\s\])}"'<>]*/gi, '$1[redacted]')
    .replace(/file:\/\/\/(?:Users|home)\/[^\s)\]}]+/gi, '[local-path]')
    .replace(/\/(?:Users|home)\/[^/\s]+\/(?:code|src|workspace)\/kizuna(?=\/|\b)/gi, '[kizuna]')
    .replace(/\/(?:Users|home)\/[^\s)\]}]+/g, '[local-path]')
    .replace(/\b[A-Za-z]:\\Users\\[^\s)\]}]+/gi, '[local-path]')
    .replace(/\b(?:10|127)\.(?:\d{1,3}\.){2}\d{1,3}\b/g, '[private-ip]')
    .replace(/\b192\.168\.(?:\d{1,3}\.)\d{1,3}\b/g, '[private-ip]')
    .replace(/\b172\.(?:1[6-9]|2\d|3[01])\.(?:\d{1,3}\.)\d{1,3}\b/g, '[private-ip]')
    .replace(/\b169\.254\.(?:\d{1,3}\.)\d{1,3}\b/g, '[private-ip]')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[redacted-email]')
    .replace(/\b(?:[A-Za-z0-9-]+\.)*ttyuyin\.com(?::\d+)?\b/gi, '[private-host]')
    .replace(/\b(?:[A-Za-z0-9-]+\.)+svc\.cluster\.local(?::\d+)?\b/gi, '[cluster-host]')
    .replace(/((?:k8s[_ -]?)?(?:pod(?:[_ -]?name)?|namespace|ns)\s*[:=]\s*)[A-Za-z0-9][A-Za-z0-9._-]*/gi, '$1[cluster-resource]')
    .replace(/(\/api\/v1\/namespaces\/)[A-Za-z0-9][A-Za-z0-9._-]*/gi, '$1[cluster-resource]')
    .replace(/(\/pods\/)[A-Za-z0-9][A-Za-z0-9._-]*/gi, '$1[cluster-resource]')
    .replace(/(?<!\d)1[3-9]\d{9}(?!\d)/g, '[redacted-phone]')
    .replace(/\b(?:localhost|[A-Za-z0-9._-]+\.local)(?::\d+)?\b/gi, '[local-host]')
    .slice(0, max);
}

function stripUnsafeHtml(value = '') {
  return String(value || '')
    .replace(/<(?:script|style|at)\b[^>]*>[\s\S]*?<\/(?:script|style|at)\s*>/gi, '')
    .replace(/<(?:script|style|at)\b[^>]*\/?>/gi, '')
    .replace(/<[^>]*>/g, '');
}

function markdownLabel(value = '', fallback = '查看链接') {
  const label = stripUnsafeHtml(redactNotifyPublicText(value, 1000))
    .replace(/(?:https?:\/\/|www\.)[^\s\])>]+/gi, '')
    .replace(/[<>\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return label.slice(0, 120) || fallback;
}

/**
 * Converts the small supported rich-text surface to Markdown, then removes all
 * remaining HTML. Every link is rebuilt from a validated HTTPS URL so Feishu
 * never receives arbitrary tags or unsafe link labels from sender content.
 */
export function sanitizeNotifyMarkdown(value = '', max = 96 * 1024) {
  let markdown = redactNotifyPublicText(value, max * 2)
    .replace(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi, (_match, _quote, href, label) => {
      try { return `[${markdownLabel(label)}](${httpsUrl(href)})`; } catch { return markdownLabel(label, ''); }
    });
  markdown = stripUnsafeHtml(markdown);
  markdown = markdown.replace(/(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g, (_match, image, label, href) => {
    try { return `${image}[${markdownLabel(label, image ? '图片' : '查看链接')}](${httpsUrl(href)})`; } catch { return markdownLabel(label, ''); }
  });
  return markdown.slice(0, max);
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function httpsUrl(value = '') {
  const text = clean(value, 2048);
  if (!text) return '';
  let parsed;
  try { parsed = new URL(text); } catch { throw new Error(`Invalid Notify URL: ${text}`); }
  if (parsed.protocol !== 'https:') throw new Error('Notify links and images must use HTTPS.');
  parsed.username = '';
  parsed.password = '';
  for (const key of [...parsed.searchParams.keys()]) {
    if (SENSITIVE_QUERY_KEY.test(key)) parsed.searchParams.set(key, '[redacted]');
  }
  return parsed.toString();
}

function normalizeItem(value) {
  const item = typeof value === 'string' ? { text: value } : (value && typeof value === 'object' ? value : {});
  const text = clean(redactNotifyPublicText(item.text || item.result || '', 2000), 500);
  if (!text) return null;
  const status = SUMMARY_ITEM_STATUSES.has(String(item.status || '')) ? String(item.status) : 'info';
  return {
    text,
    status,
    ...(clean(redactNotifyPublicText(item.evidence || '', 1200), 300)
      ? { evidence: clean(redactNotifyPublicText(item.evidence, 1200), 300) }
      : {}),
  };
}

export function normalizeNotifySummary(value, options = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (options.required) throw new Error('Structured Notify summary must be a JSON object.');
    return null;
  }
  const headline = clean(redactNotifyPublicText(value.headline || value.title || '', 600), 120);
  const taskTypes = [...new Set(list(value.taskTypes || value.task_types || (value.taskType ? [value.taskType] : []))
    .map((item) => String(item || '').trim().toLowerCase())
    .filter((item) => SUMMARY_TASK_TYPES.has(item)))]
    .slice(0, 5);
  const sections = list(value.sections).map((section, index) => {
    if (!section || typeof section !== 'object' || Array.isArray(section)) return null;
    const title = clean(redactNotifyPublicText(section.title || section.name || '', 400), 80);
    const type = SUMMARY_TASK_TYPES.has(String(section.type || '').toLowerCase())
      ? String(section.type).toLowerCase()
      : 'custom';
    const items = list(section.items || section.points).map(normalizeItem).filter(Boolean).slice(0, 8);
    if (!title && !items.length) return null;
    return { type, title: title || `结论 ${index + 1}`, items };
  }).filter(Boolean).slice(0, 8);
  const links = list(value.links).map((link) => {
    if (!link || typeof link !== 'object' || Array.isArray(link)) return null;
    const url = httpsUrl(link.url || link.href || '');
    if (!url) return null;
    return { label: markdownLabel(link.label || link.title || '查看详情').slice(0, 80), url };
  }).filter(Boolean).slice(0, 8);
  const images = list(value.images).map((image) => {
    if (!image || typeof image !== 'object' || Array.isArray(image)) return null;
    const url = httpsUrl(image.url || image.src || '');
    if (!url) return null;
    return {
      url,
      alt: markdownLabel(image.alt || image.caption || '任务结果图片', '任务结果图片').slice(0, 120),
      ...(clean(redactNotifyPublicText(image.caption || '', 800), 160)
        ? { caption: clean(redactNotifyPublicText(image.caption, 800), 160) }
        : {}),
    };
  }).filter(Boolean).slice(0, 4);
  if (!headline && !sections.length) throw new Error('Structured Notify summary requires a headline or at least one section.');
  return {
    headline: headline || sections[0].title,
    taskTypes: taskTypes.length ? taskTypes : ['custom'],
    sections,
    links,
    images,
  };
}

function escapeMarkdownLabel(value = '') {
  return String(value || '').replace(/[\[\]]/g, '\\$&');
}

const STATUS_LABELS = {
  done: '已完成',
  verified: '已验证',
  decision: '结论',
  partial: '部分完成',
  blocked: '受阻',
  info: '',
};

export function renderNotifySummaryMarkdown(summaryValue) {
  const summary = normalizeNotifySummary(summaryValue, { required: true });
  const lines = [`**${summary.headline}**`];
  for (const section of summary.sections) {
    lines.push('', `**${section.title}**`);
    for (const item of section.items) {
      const prefix = STATUS_LABELS[item.status] ? `【${STATUS_LABELS[item.status]}】` : '';
      lines.push(`- ${prefix}${item.text}${item.evidence ? `（${item.evidence}）` : ''}`);
    }
  }
  if (summary.links.length) {
    lines.push('', '**相关链接**');
    for (const link of summary.links) lines.push(`- [${escapeMarkdownLabel(link.label)}](${link.url})`);
  }
  if (summary.images.length) {
    lines.push('', '**结果图片**');
    for (const image of summary.images) lines.push(`- [${escapeMarkdownLabel(image.caption || image.alt)}](${image.url})`);
  }
  return sanitizeNotifyMarkdown(lines.join('\n').trim());
}

export function notifySummaryJsonSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      headline: { type: 'string', description: 'One concise outcome sentence, at most 120 characters.' },
      taskTypes: { type: 'array', maxItems: 5, items: { type: 'string', enum: [...SUMMARY_TASK_TYPES] } },
      sections: {
        type: 'array',
        maxItems: 8,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'items'],
          properties: {
            type: { type: 'string', enum: [...SUMMARY_TASK_TYPES] },
            title: { type: 'string' },
            items: {
              type: 'array',
              maxItems: 8,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['text'],
                properties: {
                  text: { type: 'string' },
                  status: { type: 'string', enum: [...SUMMARY_ITEM_STATUSES] },
                  evidence: { type: 'string' },
                },
              },
            },
          },
        },
      },
      links: {
        type: 'array', maxItems: 8,
        items: { type: 'object', additionalProperties: false, required: ['label', 'url'], properties: { label: { type: 'string' }, url: { type: 'string', format: 'uri' } } },
      },
      images: {
        type: 'array', maxItems: 4,
        items: { type: 'object', additionalProperties: false, required: ['url'], properties: { url: { type: 'string', format: 'uri' }, alt: { type: 'string' }, caption: { type: 'string' } } },
      },
    },
  };
}
