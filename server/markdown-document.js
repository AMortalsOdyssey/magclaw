// Pure Markdown transforms used by the operation log applier and maintenance.
// Keep this module side-effect free so damaged documents can be rebuilt by
// replaying operation logs in tests and recovery code.

const SECTION_HEADINGS = new Map([
  ['Recent Work', '近期工作'],
  ['Capabilities', '能力'],
  ['Key Knowledge', '知识索引'],
  ['Strengths And Skills', '优势与技能'],
  ['Style Adaptations', '语气适配'],
  ['User Preferences', '用户偏好'],
  ['Memory Writebacks', '记忆写入记录'],
  ['Channel Memory', '频道记忆'],
  ['Observed Collaboration', '协作观察'],
]);

const SECTION_ALIASES = new Map([
  ['Recent Work', ['近期工作']],
  ['Capabilities', ['能力', 'Skills', '技能']],
  ['Key Knowledge', ['知识索引', 'Knowledge Index']],
  ['Strengths And Skills', ['优势与技能', 'Skills', '技能']],
  ['Style Adaptations', ['语气适配']],
  ['User Preferences', ['用户偏好']],
  ['Memory Writebacks', ['记忆写入记录']],
  ['Channel Memory', ['频道记忆']],
  ['Observed Collaboration', ['协作观察']],
]);

const PLACEHOLDER_BULLETS = [
  /No recent durable work has been recorded yet/i,
  /No open work has been recorded yet/i,
  /No completed work has been recorded yet/i,
  /No durable decisions have been recorded yet/i,
  /No active task has been recorded yet/i,
  /Before a long task or context-heavy handoff/i,
  /暂无近期可复用记录/,
  /暂无经过真实任务验证的稳定能力/,
  /暂无需要跨回合延续的任务/,
  /暂无进行中的长期工作/,
  /暂无已完成的长期工作/,
  /暂无需要长期保留的决策/,
  /根据真实完成的任务补充/,
];

function preferredSectionHeading(heading) {
  return SECTION_HEADINGS.get(heading) || heading;
}

function sectionHeadingAliases(heading) {
  return [heading, ...(SECTION_ALIASES.get(heading) || [])]
    .map((item) => String(item || '').trim().toLowerCase())
    .filter(Boolean);
}

function normalizeNewline(content) {
  return String(content || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function ensureTrailingNewline(content) {
  return `${String(content || '').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

function sectionBounds(lines, heading) {
  const aliases = sectionHeadingAliases(heading);
  const headingIndex = lines.findIndex((line) => {
    const match = line.trim().match(/^##\s+(.+?)\s*$/);
    return match && aliases.includes(match[1].trim().toLowerCase());
  });
  if (headingIndex === -1) return { headingIndex: -1, endIndex: -1 };
  let endIndex = lines.length;
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    if (/^#{1,6}\s+/.test(lines[index])) {
      endIndex = index;
      break;
    }
  }
  return { headingIndex, endIndex };
}

export function upsertMarkdownBullet(content, heading, bullet, maxItems = 10) {
  const lines = normalizeNewline(content).split('\n');
  const preferredHeading = preferredSectionHeading(heading);
  const headingLine = `## ${preferredHeading}`;
  const { headingIndex, endIndex } = sectionBounds(lines, heading);
  if (headingIndex === -1) {
    const suffix = lines.length && lines[lines.length - 1].trim() ? ['', headingLine, bullet] : [headingLine, bullet];
    return ensureTrailingNewline([...lines, ...suffix].join('\n'));
  }
  lines[headingIndex] = headingLine;
  const before = lines.slice(0, headingIndex + 1);
  const section = lines.slice(headingIndex + 1, endIndex).filter((line) => line.trim());
  const after = lines.slice(endIndex);
  const bullets = [bullet, ...section.filter((line) => line.trim() !== String(bullet || '').trim())]
    .filter((line) => line.trim().startsWith('- '))
    .filter((line) => !PLACEHOLDER_BULLETS.some((pattern) => pattern.test(line)))
    .slice(0, maxItems);
  return ensureTrailingNewline([...before, ...bullets, '', ...after].join('\n'));
}

export function replaceMarkdownSection(content, heading, markdown) {
  const lines = normalizeNewline(content).split('\n');
  const preferredHeading = preferredSectionHeading(heading);
  const headingLine = `## ${preferredHeading}`;
  const sectionLines = normalizeNewline(markdown)
    .split('\n')
    .filter((line, index) => !(index === 0 && /^##\s+/.test(line.trim())));
  const { headingIndex, endIndex } = sectionBounds(lines, heading);
  if (headingIndex === -1) {
    const suffix = lines.length && lines[lines.length - 1].trim()
      ? ['', headingLine, ...sectionLines]
      : [headingLine, ...sectionLines];
    return ensureTrailingNewline([...lines, ...suffix].join('\n'));
  }
  return ensureTrailingNewline([
    ...lines.slice(0, headingIndex),
    headingLine,
    ...sectionLines,
    ...lines.slice(endIndex),
  ].join('\n'));
}

function markdownScalar(value) {
  if (value === null || value === undefined) return '""';
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'object') return JSON.stringify(value);
  const raw = String(value);
  if (!raw || /[:#\n\r]/.test(raw)) return JSON.stringify(raw);
  return raw;
}

export function upsertMarkdownFrontmatter(content, key, value) {
  const cleanKey = String(key || '').trim().replace(/[^A-Za-z0-9_-]/g, '_');
  if (!cleanKey) return ensureTrailingNewline(content);
  const lines = normalizeNewline(content).split('\n');
  const nextLine = `${cleanKey}: ${markdownScalar(value)}`;
  if (lines[0] !== '---') {
    return ensureTrailingNewline(['---', nextLine, '---', '', ...lines].join('\n'));
  }
  const endIndex = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (endIndex === -1) return ensureTrailingNewline(['---', nextLine, '---', '', ...lines.slice(1)].join('\n'));
  const existingIndex = lines.slice(1, endIndex).findIndex((line) => line.trim().startsWith(`${cleanKey}:`));
  if (existingIndex >= 0) {
    lines[1 + existingIndex] = nextLine;
  } else {
    lines.splice(endIndex, 0, nextLine);
  }
  return ensureTrailingNewline(lines.join('\n'));
}

function sectionKey(line) {
  const match = line.trim().match(/^(#{2})\s+(.+?)\s*$/);
  return match ? match[2].trim().toLowerCase() : '';
}

export function deterministicCleanupMarkdown(content) {
  const lines = normalizeNewline(content).split('\n');
  const intro = [];
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (/^##\s+/.test(line.trim())) {
      current = { heading: line.trim(), lines: [] };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else intro.push(line);
  }
  const byHeading = new Map();
  const ordered = [];
  for (const section of sections) {
    const key = sectionKey(section.heading);
    if (!key || !byHeading.has(key)) {
      byHeading.set(key || section.heading, section);
      ordered.push(section);
      continue;
    }
    const target = byHeading.get(key);
    target.lines.push(...section.lines);
  }
  const out = [...intro];
  for (const section of ordered) {
    out.push(section.heading);
    const seen = new Set();
    for (const line of section.lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- ')) {
        if (PLACEHOLDER_BULLETS.some((pattern) => pattern.test(trimmed))) continue;
        const key = trimmed.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
      }
      out.push(line);
    }
  }
  return ensureTrailingNewline(out.join('\n'));
}

export function applyMarkdownOperation(content, operation = {}) {
  const type = String(operation.type || '').trim();
  if (type === 'initial_snapshot') return ensureTrailingNewline(operation.markdown || '');
  if (type === 'append_bullet' || type === 'upsert_bullet') {
    return upsertMarkdownBullet(
      content,
      operation.target?.heading || operation.heading,
      operation.text || operation.bullet || '',
      operation.maxItems || operation.target?.maxItems || 10,
    );
  }
  if (type === 'replace_section') {
    return replaceMarkdownSection(content, operation.target?.heading || operation.heading, operation.markdown || '');
  }
  if (type === 'upsert_frontmatter') {
    return upsertMarkdownFrontmatter(content, operation.key, operation.value);
  }
  if (type === 'maintenance_rewrite') {
    return ensureTrailingNewline(operation.markdown || '');
  }
  if (type === 'deterministic_cleanup') {
    return deterministicCleanupMarkdown(content);
  }
  throw new Error(`Unsupported Markdown operation type: ${type || 'unknown'}`);
}
