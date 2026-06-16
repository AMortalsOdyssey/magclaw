import crypto from 'node:crypto';

import { llmConfigFromEnv, llmConfigReady, requestLlmJson } from './llm-client.js';

const RECENT_LEAF_WINDOW_MS = 72 * 60 * 60 * 1000;
const KNOWLEDGE_SECRET_PREFIX = 'enc:v1:';
const CHANGE_STATES = new Set(['draft', 'diff', 'preview', 'published']);
const EVENT_INDENT = {
  draft: 3,
  diff: 2,
  conflict: 2,
  preview: 1,
  published: 0,
  settings_updated: 1,
  notification_failed: 1,
  notification_sent: 1,
};

function cleanString(value) {
  return String(value || '').trim();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function cloneJson(value) {
  return value && typeof value === 'object' ? JSON.parse(JSON.stringify(value)) : value;
}

function isoNow(now = () => new Date().toISOString()) {
  const value = typeof now === 'function' ? now() : now;
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function shortHash(value, length = 10) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, length);
}

function slugify(value, fallback = 'node') {
  const clean = cleanString(value)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return clean || fallback;
}

function stableId(prefix, ...parts) {
  const seed = parts.map((part) => cleanString(part)).join('::');
  const slug = slugify(parts.find((part) => cleanString(part)) || prefix, prefix).slice(0, 42);
  return `${prefix}_${slug}_${shortHash(seed, 8)}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function decodeMarkdownEscapes(value) {
  return String(value || '').replace(/\\([\\`*_{}\[\]()#+\-.!|>])/g, '$1');
}

function preserveMarkdownEscapes(value) {
  const escaped = [];
  const text = String(value || '').replace(/\\([\\`*_{}\[\]()#+\-.!|>])/g, (_match, char) => {
    const token = `\uE000${escaped.length}\uE001`;
    escaped.push(escapeHtml(char));
    return token;
  });
  return {
    text,
    restore(html) {
      return String(html || '').replace(/\uE000(\d+)\uE001/g, (_match, index) => escaped[Number(index)] || '');
    },
  };
}

function normalizeMarkdownLinks(text) {
  return String(text || '').replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_match, label, url) => {
    const cleanUrl = escapeHtml(url);
    return `<a href="${cleanUrl}" target="_blank" rel="noreferrer noopener">${escapeHtml(label)}</a>`;
  });
}

function renderInlineMarkdown(text) {
  const preserved = preserveMarkdownEscapes(text);
  let html = escapeHtml(preserved.text);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return preserved.restore(normalizeMarkdownLinks(html));
}

function uniqueHeadingAnchor(title, level, seen) {
  const base = slugify(title, `h${level}`);
  const count = Number(seen.get(base) || 0);
  seen.set(base, count + 1);
  return count > 0 ? `${base}-${count + 1}` : base;
}

export function renderKnowledgeMarkdown(markdown = '') {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const html = [];
  const headings = [];
  let paragraph = [];
  let listType = '';
  let inCode = false;
  let codeLines = [];
  let quoteLines = [];
  let tableRows = [];
  const headingSlugs = new Map();

  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${renderInlineMarkdown(paragraph.join(' '))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!listType) return;
    html.push(`</${listType}>`);
    listType = '';
  };
  const pushListItem = (type, content) => {
    flushParagraph();
    if (listType && listType !== type) closeList();
    if (!listType) {
      listType = type;
      html.push(`<${type}>`);
    }
    html.push(`<li>${renderInlineMarkdown(content)}</li>`);
  };
  const parseTableRow = (line) => line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
  const isTableSeparator = (cells) => cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
  const isTableLine = (line) => /^\s*\|.+\|\s*$/.test(line) || /^\s*[^|]+\|.+\s*$/.test(line);
  const flushQuote = () => {
    if (!quoteLines.length) return;
    html.push(`<blockquote>\n<p>${renderInlineMarkdown(quoteLines.join(' '))}</p>\n</blockquote>`);
    quoteLines = [];
  };
  const flushTable = () => {
    if (!tableRows.length) return;
    const rows = tableRows.map(parseTableRow);
    if (rows.length >= 2 && isTableSeparator(rows[1])) {
      const header = rows[0].map((cell) => `<th>${renderInlineMarkdown(cell)}</th>`).join('');
      const body = rows.slice(2)
        .filter((row) => row.some((cell) => cell.trim()))
        .map((row) => `<tr>${row.map((cell) => `<td>${renderInlineMarkdown(cell)}</td>`).join('')}</tr>`)
        .join('');
      html.push(`<table class="knowledge-md-table"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`);
    } else {
      paragraph.push(...tableRows.map((line) => line.trim()));
    }
    tableRows = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/g, '');
    if (/^```/.test(line.trim())) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else {
        flushQuote();
        flushTable();
        flushParagraph();
        closeList();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      codeLines.push(rawLine);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushQuote();
      flushTable();
      flushParagraph();
      closeList();
      const level = heading[1].length;
      const rawTitle = heading[2].replace(/\s+#+$/g, '').trim();
      const title = decodeMarkdownEscapes(rawTitle);
      const id = uniqueHeadingAnchor(title, level, headingSlugs);
      headings.push({ level, title, id });
      html.push(`<h${level} id="${escapeHtml(id)}">${renderInlineMarkdown(rawTitle)}</h${level}>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      flushTable();
      flushParagraph();
      closeList();
      quoteLines.push(line.replace(/^\s*>\s?/, '').trim());
      continue;
    }
    if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flushQuote();
      flushTable();
      flushParagraph();
      closeList();
      html.push('<hr>');
      continue;
    }
    if (isTableLine(line)) {
      flushQuote();
      flushParagraph();
      closeList();
      tableRows.push(line);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flushQuote();
      flushTable();
      pushListItem('ul', line.replace(/^\s*[-*]\s+/, ''));
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      flushQuote();
      flushTable();
      pushListItem('ol', line.replace(/^\s*\d+\.\s+/, ''));
      continue;
    }
    if (!line.trim()) {
      flushQuote();
      flushTable();
      flushParagraph();
      closeList();
      continue;
    }
    flushQuote();
    flushTable();
    paragraph.push(line.trim());
  }
  if (inCode) html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  flushQuote();
  flushTable();
  flushParagraph();
  closeList();
  return { html: html.join('\n'), headings };
}

function stripMarkdown(markdown = '') {
  return decodeMarkdownEscapes(String(markdown || ''))
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#>*_`~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeConsensusTitle(value = '') {
  return decodeMarkdownEscapes(value)
    .toLowerCase()
    .replace(/[（(]\s*(?:v|version)?\s*\d+(?:\.\d+)*\s*[)）]/gi, '')
    .replace(/\b(?:v|version)\s*\d+(?:\.\d+)*\b/gi, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

function consensusIdForRoot(workspaceId = 'local', title = '') {
  const normalized = normalizeConsensusTitle(title) || slugify(title || 'consensus');
  return stableId('cns', workspaceId || 'local', normalized);
}

function titleSimilarity(left = '', right = '') {
  const a = [...normalizeConsensusTitle(left)];
  const b = [...normalizeConsensusTitle(right)];
  if (!a.length || !b.length) return 0;
  const dp = Array.from({ length: a.length + 1 }, () => Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp[0][0] / Math.max(a.length, b.length);
}

function jaccard(leftValues = [], rightValues = []) {
  const left = new Set(leftValues.map(normalizeConsensusTitle).filter(Boolean));
  const right = new Set(rightValues.map(normalizeConsensusTitle).filter(Boolean));
  if (!left.size && !right.size) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function summarizeMarkdown(markdown = '', limit = 86) {
  const clean = stripMarkdown(markdown);
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit).replace(/\s+\S*$/, '')}...`;
}

function splitMarkdownByHeadings(markdown = '') {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  let rootTitle = '';
  let rootLines = [];
  const h2Sections = [];
  let current = null;
  let inCode = false;

  for (const line of lines) {
    const fence = /^```/.test(line.trim());
    if (!inCode) {
      const h1 = line.match(/^#\s+(.+)$/);
      const h2 = line.match(/^##\s+(.+)$/);
      if (h1 && !rootTitle) {
        rootTitle = decodeMarkdownEscapes(h1[1].trim());
        rootLines.push(line);
        if (fence) inCode = !inCode;
        continue;
      }
      if (h2) {
        current = { title: decodeMarkdownEscapes(h2[1].trim()), lines: [line] };
        h2Sections.push(current);
        if (fence) inCode = !inCode;
        continue;
      }
    }
    if (current) current.lines.push(line);
    else rootLines.push(line);
    if (fence) {
      inCode = !inCode;
      continue;
    }
  }
  if (!rootTitle) rootTitle = 'Knowledge Space';
  return {
    rootTitle,
    rootMarkdown: rootLines.join('\n').trim(),
    sections: h2Sections.map((section) => ({
      title: section.title,
      markdown: section.lines.join('\n').trim(),
    })),
  };
}

function stripLeadingMarkdownHeading(markdown = '', level = 1) {
  const normalized = String(markdown || '').replace(/\r\n?/g, '\n').trim();
  if (!normalized) return '';
  const cleanLevel = Math.min(6, Math.max(1, Number(level || 1)));
  return normalized.replace(new RegExp(`^#{${cleanLevel}}\\s+.+(?:\\n+|$)`), '').trim();
}

function stripGeneratedRootDocumentLinks(markdown = '') {
  return String(markdown || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !/^\s*[-*]\s+\[[^\]]+\]\(#[^)]+\)\s*$/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function documentDisplayMarkdown(doc = {}) {
  const markdown = stripLeadingMarkdownHeading(doc.sourceMarkdown || '', doc.level || 1);
  return Number(doc.level || 1) <= 1 ? stripGeneratedRootDocumentLinks(markdown) : markdown;
}

function publicKnowledgeDocumentRow(doc = {}) {
  const displayMarkdown = documentDisplayMarkdown(doc);
  return {
    id: doc.id,
    parentId: doc.parentId || '',
    consensusId: doc.consensusId || '',
    consensusRootId: doc.consensusRootId || '',
    consensusTitle: doc.consensusTitle || '',
    title: decodeMarkdownEscapes(doc.title || ''),
    level: doc.level || 1,
    summary: displayMarkdown ? summarizeMarkdown(displayMarkdown) : decodeMarkdownEscapes(doc.summary || ''),
    currentVersionId: doc.currentVersionId || '',
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    sourceUrl: doc.sourceUrl || '',
  };
}

function actorHumanId(actor) {
  return cleanString(actor?.member?.humanId || actor?.user?.id || actor?.userId || actor?.humanId || 'local');
}

function actorRole(actor) {
  return cleanString(actor?.member?.role || actor?.role || '');
}

export function isKnowledgeOwner(actor) {
  return actorRole(actor) === 'owner';
}

export function isKnowledgeAdmin(actor) {
  return ['owner', 'admin'].includes(actorRole(actor));
}

export function ensureKnowledgeSpaceRoot(state) {
  if (!state.knowledgeSpace || typeof state.knowledgeSpace !== 'object') {
    state.knowledgeSpace = { spaces: {} };
  }
  if (!state.knowledgeSpace.spaces || typeof state.knowledgeSpace.spaces !== 'object') {
    state.knowledgeSpace.spaces = {};
  }
  return state.knowledgeSpace;
}

export function ensureKnowledgeSpace(state, workspaceId = 'local', options = {}) {
  const root = ensureKnowledgeSpaceRoot(state);
  const cleanWorkspaceId = cleanString(workspaceId) || 'local';
  if (!root.spaces[cleanWorkspaceId]) {
    const now = isoNow(options.now);
    root.spaces[cleanWorkspaceId] = {
      id: stableId('ks', cleanWorkspaceId),
      workspaceId: cleanWorkspaceId,
      title: options.title || 'Knowledge Space',
      createdAt: now,
      updatedAt: now,
      settings: {
        whitelistHumanIds: [],
        feishu: {
          appId: '',
          chatId: '',
          appSecretEncrypted: '',
          appSecretConfiguredAt: '',
          updatedAt: '',
        },
      },
      documents: [],
      consensusGroups: [],
      versions: [],
      anchors: [],
      links: [],
      changeSessions: [],
      changelogGroups: [],
      changelogEvents: [],
      notificationAttempts: [],
    };
  }
  return root.spaces[cleanWorkspaceId];
}

function orderedRootDocuments(space) {
  return safeArray(space.documents)
    .filter((doc) => !doc.parentId)
    .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')) || String(left.id || '').localeCompare(String(right.id || '')));
}

function ensureConsensusAssignments(space) {
  const docs = safeArray(space.documents);
  const docById = new Map(docs.map((doc) => [doc.id, doc]));
  const inputGroups = safeArray(space.consensusGroups).filter((group) => group && group.id);
  const groupById = new Map(inputGroups.map((group) => [group.id, { ...group }]));
  const groupByRoot = new Map(inputGroups.filter((group) => group.rootDocId).map((group) => [group.rootDocId, { ...group }]));
  const roots = orderedRootDocuments(space);
  const groups = [];
  const rootByConsensus = new Map();

  for (const root of roots) {
    const existing = groupByRoot.get(root.id) || groupById.get(root.consensusId || '');
    const consensusId = cleanString(root.consensusId || existing?.id || consensusIdForRoot(space.workspaceId, root.title || root.id));
    root.consensusId = consensusId;
    root.consensusRootId = root.id;
    root.consensusTitle = decodeMarkdownEscapes(root.title || existing?.title || 'Consensus');
    root.metadata = root.metadata && typeof root.metadata === 'object' ? root.metadata : {};
    root.metadata.consensusId = consensusId;
    root.metadata.consensusRootId = root.id;
    rootByConsensus.set(consensusId, root);
    groups.push({
      id: consensusId,
      workspaceId: space.workspaceId,
      rootDocId: root.id,
      title: decodeMarkdownEscapes(root.title || existing?.title || 'Consensus'),
      sourceName: existing?.sourceName || root.sourceName || '',
      sourceUrl: existing?.sourceUrl || root.sourceUrl || '',
      createdAt: existing?.createdAt || root.createdAt || space.createdAt || '',
      updatedAt: root.updatedAt || existing?.updatedAt || space.updatedAt || '',
      metadata: existing?.metadata && typeof existing.metadata === 'object' ? existing.metadata : {},
    });
  }

  const rootForDoc = (doc) => {
    const seen = new Set();
    let cursor = doc;
    while (cursor?.parentId && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      const parent = docById.get(cursor.parentId);
      if (!parent) break;
      cursor = parent;
    }
    return cursor && !cursor.parentId ? cursor : null;
  };

  for (const doc of docs) {
    const root = rootForDoc(doc);
    if (!root) {
      const consensusId = cleanString(doc.consensusId || consensusIdForRoot(space.workspaceId, doc.title || doc.id));
      doc.consensusId = consensusId;
      doc.consensusRootId = doc.consensusRootId || doc.id;
      doc.consensusTitle = doc.consensusTitle || decodeMarkdownEscapes(doc.title || '');
      continue;
    }
    doc.consensusId = root.consensusId;
    doc.consensusRootId = root.id;
    doc.consensusTitle = root.consensusTitle || decodeMarkdownEscapes(root.title || '');
    doc.metadata = doc.metadata && typeof doc.metadata === 'object' ? doc.metadata : {};
    doc.metadata.consensusId = doc.consensusId;
    doc.metadata.consensusRootId = doc.consensusRootId;
  }

  for (const anchor of safeArray(space.anchors)) {
    const doc = docById.get(anchor.docId);
    anchor.consensusId = doc?.consensusId || anchor.consensusId || '';
    anchor.consensusRootId = doc?.consensusRootId || anchor.consensusRootId || '';
    anchor.metadata = anchor.metadata && typeof anchor.metadata === 'object' ? anchor.metadata : {};
    if (anchor.consensusId) anchor.metadata.consensusId = anchor.consensusId;
    if (anchor.consensusRootId) anchor.metadata.consensusRootId = anchor.consensusRootId;
  }

  const seenGroups = new Set();
  space.consensusGroups = groups
    .filter((group) => {
      if (!group.id || seenGroups.has(group.id)) return false;
      seenGroups.add(group.id);
      return true;
    })
    .map((group) => ({
      ...group,
      rootDocId: rootByConsensus.get(group.id)?.id || group.rootDocId || '',
      updatedAt: rootByConsensus.get(group.id)?.updatedAt || group.updatedAt || '',
    }));
}

function normalizeSpace(space) {
  space.documents = safeArray(space.documents);
  space.consensusGroups = safeArray(space.consensusGroups);
  space.versions = safeArray(space.versions);
  space.anchors = safeArray(space.anchors);
  space.links = safeArray(space.links);
  space.changeSessions = safeArray(space.changeSessions);
  space.changelogGroups = safeArray(space.changelogGroups);
  space.changelogEvents = safeArray(space.changelogEvents);
  space.notificationAttempts = safeArray(space.notificationAttempts);
  space.settings = space.settings && typeof space.settings === 'object' ? space.settings : {};
  space.settings.whitelistHumanIds = safeArray(space.settings.whitelistHumanIds).map(cleanString).filter(Boolean);
  space.settings.feishu = space.settings.feishu && typeof space.settings.feishu === 'object' ? space.settings.feishu : {};
  ensureConsensusAssignments(space);
  return space;
}

export function knowledgeWorkspaceIds(knowledgeState) {
  const root = knowledgeState && typeof knowledgeState === 'object' ? knowledgeState : {};
  return Object.keys(root.spaces || {}).filter(Boolean);
}

export function mergeKnowledgeSpaceState(leftValue, rightValue) {
  const left = leftValue && typeof leftValue === 'object' ? leftValue : {};
  const right = rightValue && typeof rightValue === 'object' ? rightValue : {};
  const merged = { ...cloneJson(left), ...cloneJson(right), spaces: { ...cloneJson(left.spaces || {}) } };
  for (const [workspaceId, space] of Object.entries(right.spaces || {})) {
    merged.spaces[workspaceId] = normalizeSpace({
      ...cloneJson(merged.spaces[workspaceId] || {}),
      ...cloneJson(space),
    });
  }
  return merged;
}

export function filterKnowledgeSpaceStateForWorkspace(knowledgeState, workspaceId, options = {}) {
  const cleanWorkspaceId = cleanString(workspaceId);
  const source = knowledgeState && typeof knowledgeState === 'object' ? knowledgeState : {};
  const result = { ...cloneJson(source), spaces: {} };
  const includeMatches = options.includeMatches !== false;
  for (const [id, space] of Object.entries(source.spaces || {})) {
    const matches = cleanString(space?.workspaceId || id) === cleanWorkspaceId;
    if (includeMatches ? matches : !matches) result.spaces[id] = cloneJson(space);
  }
  return result;
}

export function hasKnowledgeSpaceContent(knowledgeState) {
  return Object.keys(knowledgeState?.spaces || {}).length > 0;
}

export function isKnowledgeWhitelisted(space, actor) {
  const humanId = actorHumanId(actor);
  return normalizeSpace(space).settings.whitelistHumanIds.includes(humanId);
}

export function canWriteKnowledgeContent(space, actor) {
  return isKnowledgeAdmin(actor) || isKnowledgeWhitelisted(space, actor);
}

function maskKnowledgeSettingValue(value) {
  const text = cleanString(value);
  if (!text) return '';
  if (text.length <= 4) return `${text.slice(0, 1)}${'*'.repeat(Math.max(2, text.length - 1))}`;
  const prefixLength = Math.min(3, Math.max(2, Math.floor(text.length * 0.22)));
  const suffixLength = Math.min(3, Math.max(1, Math.floor(text.length * 0.18)));
  if (prefixLength + suffixLength >= text.length) {
    return `${text.slice(0, 2)}${'*'.repeat(Math.max(2, text.length - 3))}${text.slice(-1)}`;
  }
  return `${text.slice(0, prefixLength)}${'*'.repeat(Math.max(4, text.length - prefixLength - suffixLength))}${text.slice(-suffixLength)}`;
}

function maskKnowledgeEncryptedSecret(value, env = process.env) {
  if (!value) return '';
  try {
    return maskKnowledgeSettingValue(decryptKnowledgeSecret(value, env));
  } catch {
    return 'configured';
  }
}

function maskFeishuSettings(feishu = {}, env = process.env) {
  return {
    appId: maskKnowledgeSettingValue(feishu.appId),
    chatId: maskKnowledgeSettingValue(feishu.chatId),
    appSecretConfigured: Boolean(feishu.appSecretEncrypted),
    appSecretMasked: feishu.appSecretEncrypted ? maskKnowledgeEncryptedSecret(feishu.appSecretEncrypted, env) : '',
    appSecretConfiguredAt: feishu.appSecretConfiguredAt || '',
    updatedAt: feishu.updatedAt || '',
  };
}

function publicChangeSession(session) {
  const copy = cloneJson(session);
  delete copy.proposedRaw;
  return copy;
}

export function publicKnowledgeSpace(space, actor = null, options = {}) {
  const normalized = normalizeSpace(space);
  return {
    id: normalized.id,
    workspaceId: normalized.workspaceId,
    title: normalized.title,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    permissions: {
      canAdmin: isKnowledgeAdmin(actor),
      canEdit: canWriteKnowledgeContent(normalized, actor),
    },
    settings: {
      whitelistHumanIds: normalized.settings.whitelistHumanIds,
      feishu: maskFeishuSettings(normalized.settings.feishu, options.env || process.env),
    },
    consensusGroups: normalized.consensusGroups.map((group) => ({
      id: group.id,
      workspaceId: group.workspaceId || normalized.workspaceId,
      rootDocId: group.rootDocId || '',
      title: decodeMarkdownEscapes(group.title || ''),
      sourceName: group.sourceName || '',
      sourceUrl: group.sourceUrl || '',
      createdAt: group.createdAt || '',
      updatedAt: group.updatedAt || '',
    })),
    documents: normalized.documents.map(publicKnowledgeDocumentRow),
    anchors: normalized.anchors.map((anchor) => ({
      id: anchor.id,
      docId: anchor.docId,
      consensusId: anchor.consensusId || '',
      consensusRootId: anchor.consensusRootId || '',
      title: decodeMarkdownEscapes(anchor.title || ''),
      level: anchor.level || 3,
      anchor: anchor.anchor,
      summary: decodeMarkdownEscapes(anchor.summary || ''),
      updatedAt: anchor.updatedAt,
      sourceUrl: anchor.sourceUrl || '',
    })),
    links: normalized.links,
    changeSessions: normalized.changeSessions.map(publicChangeSession),
    changelogGroups: normalized.changelogGroups,
    changelogEvents: normalized.changelogEvents,
  };
}

function addChangelog(space, session, event) {
  normalizeSpace(space);
  const now = event.createdAt || session.updatedAt || session.createdAt;
  let group = space.changelogGroups.find((item) => item.changeSessionId === session.id);
  if (!group) {
    group = {
      id: stableId('clg', space.workspaceId, session.id),
      workspaceId: space.workspaceId,
      changeSessionId: session.id,
      title: session.summary || 'Knowledge update',
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: now,
      publishedAt: session.publishedAt || '',
      actorHumanId: event.actorHumanId || session.actorHumanId || '',
    };
    space.changelogGroups.push(group);
  }
  group.status = session.status;
  group.updatedAt = now;
  group.publishedAt = session.publishedAt || group.publishedAt || '';
  group.actorHumanId = group.actorHumanId || event.actorHumanId || session.actorHumanId || '';
  const type = event.type || session.status;
  space.changelogEvents.push({
    id: event.id || stableId('cle', space.workspaceId, session.id, type, now, space.changelogEvents.length),
    workspaceId: space.workspaceId,
    changeSessionId: session.id,
    type,
    status: event.status || session.status,
    title: event.title || type.replace(/[_-]+/g, ' '),
    detail: event.detail || '',
    color: event.color || eventColor(type),
    indent: Number.isFinite(event.indent) ? event.indent : (EVENT_INDENT[type] ?? EVENT_INDENT[event.status] ?? 0),
    createdAt: now,
    actorHumanId: event.actorHumanId || session.actorHumanId || '',
    link: event.link || `/s/${encodeURIComponent(space.workspaceId)}/knowledge/reviews/${encodeURIComponent(session.id)}`,
    metadata: event.metadata || {},
  });
}

function eventColor(type) {
  if (type === 'published' || type === 'notification_sent') return 'green';
  if (type === 'preview') return 'blue';
  if (type === 'diff') return 'amber';
  if (type === 'conflict' || type === 'notification_failed') return 'red';
  return 'gray';
}

function documentVersionNumber(space, docId) {
  return safeArray(space.versions).filter((version) => version.docId === docId).length + 1;
}

function linksFromMarkdown(markdown, docId, anchorId = '') {
  const links = [];
  const regex = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g;
  let match;
  let index = 0;
  while ((match = regex.exec(markdown))) {
    links.push({
      id: stableId('lnk', docId, anchorId, match[2], index),
      fromDocId: docId,
      fromAnchorId: anchorId,
      toDocId: '',
      toAnchorId: '',
      kind: 'external',
      label: match[1],
      url: match[2],
    });
    index += 1;
  }
  return links;
}

function anchorBlocks(markdown = '') {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let current = null;
  let inCode = false;
  for (const line of lines) {
    const fence = /^```/.test(line.trim());
    const h3 = !inCode ? line.match(/^###\s+(.+)$/) : null;
    if (h3) {
      current = { title: decodeMarkdownEscapes(h3[1].trim()), lines: [line] };
      blocks.push(current);
      if (fence) inCode = !inCode;
      continue;
    }
    if (current) current.lines.push(line);
    if (fence) inCode = !inCode;
  }
  return blocks.map((block) => ({
    title: block.title,
    markdown: block.lines.join('\n').trim(),
  }));
}

function upsertDocumentFromMarkdown(space, docInput, options) {
  const now = options.now;
  const actor = options.actor;
  const rendered = renderKnowledgeMarkdown(docInput.markdown);
  const contentHash = shortHash(docInput.markdown, 16);
  const existing = safeArray(space.documents).find((doc) => doc.id === docInput.id);
  const versionId = stableId('ver', docInput.id, contentHash, documentVersionNumber(space, docInput.id));
  const version = {
    id: versionId,
    workspaceId: space.workspaceId,
    docId: docInput.id,
    versionNumber: documentVersionNumber(space, docInput.id),
    sourceMarkdown: docInput.markdown,
    renderedHtml: rendered.html,
    contentHash,
    baseVersionId: existing?.currentVersionId || '',
    createdAt: now,
    createdBy: actorHumanId(actor),
  };
  const doc = {
    id: docInput.id,
    workspaceId: space.workspaceId,
    parentId: docInput.parentId || '',
    consensusId: docInput.consensusId || existing?.consensusId || '',
    consensusRootId: docInput.consensusRootId || existing?.consensusRootId || (docInput.parentId ? '' : docInput.id),
    consensusTitle: docInput.consensusTitle || existing?.consensusTitle || '',
    title: docInput.title,
    slug: docInput.slug || slugify(docInput.title),
    level: docInput.level || 1,
    sourceMarkdown: docInput.markdown,
    renderedHtml: rendered.html,
    summary: summarizeMarkdown(docInput.markdown),
    currentVersionId: versionId,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    createdBy: existing?.createdBy || actorHumanId(actor),
    sourceUrl: docInput.sourceUrl || existing?.sourceUrl || '',
    metadata: {
      ...(existing?.metadata && typeof existing.metadata === 'object' ? existing.metadata : {}),
      ...(docInput.metadata && typeof docInput.metadata === 'object' ? docInput.metadata : {}),
    },
  };
  if (doc.consensusId) doc.metadata.consensusId = doc.consensusId;
  if (doc.consensusRootId) doc.metadata.consensusRootId = doc.consensusRootId;
  if (existing) Object.assign(existing, doc);
  else space.documents.push(doc);
  ensureConsensusAssignments(space);
  space.versions.push(version);
  return { doc, version };
}

function consensusRootForId(space, consensusId = '') {
  normalizeSpace(space);
  const group = space.consensusGroups.find((item) => item.id === consensusId);
  return group ? space.documents.find((doc) => doc.id === group.rootDocId) || null : null;
}

function childDocumentsForConsensus(space, consensusId = '') {
  return safeArray(space.documents)
    .filter((doc) => doc.consensusId === consensusId && doc.parentId)
    .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')) || String(left.title || '').localeCompare(String(right.title || '')));
}

function resolveConsensusForImport(space, { workspaceId = 'local', rootTitle = '', sections = [], consensusId = '', identity = null } = {}) {
  normalizeSpace(space);
  const cleanConsensusId = cleanString(consensusId);
  const groups = safeArray(space.consensusGroups);
  const sectionTitles = sections.map((section) => section.title);
  if (cleanConsensusId) {
    const group = groups.find((item) => item.id === cleanConsensusId);
    if (group) return { mode: 'existing', group, reason: 'explicit_consensus_id', confidence: 1 };
  }
  const normalizedTitle = normalizeConsensusTitle(rootTitle);
  const exact = groups.find((group) => normalizeConsensusTitle(group.title) === normalizedTitle);
  if (exact) return { mode: 'existing', group: exact, reason: 'root_title_exact', confidence: 1 };

  let best = null;
  for (const group of groups) {
    const titleScore = titleSimilarity(rootTitle, group.title);
    const childTitles = childDocumentsForConsensus(space, group.id).map((doc) => doc.title);
    const h2Score = jaccard(sectionTitles, childTitles);
    const score = (titleScore * 0.55) + (h2Score * 0.45);
    if (!best || score > best.score) best = { group, titleScore, h2Score, score };
  }
  if (best && best.titleScore >= 0.72 && best.h2Score >= 0.55) {
    return { mode: 'existing', group: best.group, reason: 'title_h2_similarity', confidence: Number(best.score.toFixed(3)) };
  }

  const llmConsensusId = cleanString(identity?.consensusId || identity?.consensus_id || identity?.id);
  const llmConfidence = Number(identity?.confidence || 0);
  if (llmConsensusId && llmConfidence >= 0.85) {
    const group = groups.find((item) => item.id === llmConsensusId);
    if (group) return { mode: 'existing', group, reason: 'agent_identity', confidence: llmConfidence };
  }

  const id = cleanConsensusId || consensusIdForRoot(workspaceId, rootTitle);
  return {
    mode: 'new',
    group: {
      id,
      workspaceId,
      rootDocId: '',
      title: rootTitle || 'Consensus',
      createdAt: '',
      updatedAt: '',
    },
    reason: 'new_consensus',
    confidence: 1,
  };
}

function sectionDocIdForConsensus(space, consensusId, sectionTitle) {
  const normalized = normalizeConsensusTitle(sectionTitle);
  const existing = safeArray(space.documents).find((doc) => (
    doc.consensusId === consensusId
    && doc.parentId
    && normalizeConsensusTitle(doc.title) === normalized
  ));
  return existing?.id || stableId('doc', space.workspaceId, consensusId, sectionTitle);
}

function semanticEndpointText(doc = {}) {
  return `${doc.title || ''}\n${doc.summary || ''}\n${doc.sourceMarkdown || ''}`;
}

function semanticRelationship(left = {}, right = {}) {
  const leftTitle = normalizeConsensusTitle(left.title);
  const rightTitle = normalizeConsensusTitle(right.title);
  const leftText = semanticEndpointText(left).toLowerCase();
  const rightText = semanticEndpointText(right).toLowerCase();
  if (leftTitle && rightTitle && leftTitle === rightTitle && Number(left.level || 1) >= 2 && Number(right.level || 1) >= 2) {
    return { confidence: 0.9, reason: `Matching module title: ${decodeMarkdownEscapes(left.title || right.title || '')}`, source: 'deterministic_title_match' };
  }
  const leftMentionsRight = rightTitle && normalizeConsensusTitle(leftText).includes(rightTitle);
  const rightMentionsLeft = leftTitle && normalizeConsensusTitle(rightText).includes(leftTitle);
  if (leftMentionsRight || rightMentionsLeft) {
    return { confidence: 0.88, reason: 'One consensus explicitly mentions the other endpoint title.', source: 'deterministic_explicit_mention' };
  }
  const leftTokens = new Set(searchTokens(leftText).filter((token) => token.length > 1 || /[\u3400-\u9fff]/.test(token)));
  const rightTokens = new Set(searchTokens(rightText).filter((token) => token.length > 1 || /[\u3400-\u9fff]/.test(token)));
  if (!leftTokens.size || !rightTokens.size) return null;
  let overlap = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) overlap += 1;
  const score = overlap / Math.min(leftTokens.size, rightTokens.size);
  if (overlap >= 4 && score >= 0.42) {
    return { confidence: Number(Math.min(0.86, 0.82 + score * 0.08).toFixed(3)), reason: 'High CJK/token overlap across consensus endpoints.', source: 'deterministic_token_overlap' };
  }
  return null;
}

function rebuildKnowledgeSemanticLinks(space) {
  normalizeSpace(space);
  const docs = safeArray(space.documents).filter((doc) => doc.consensusId);
  const semanticLinks = [];
  const pairBest = new Map();
  for (let leftIndex = 0; leftIndex < docs.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < docs.length; rightIndex += 1) {
      const left = docs[leftIndex];
      const right = docs[rightIndex];
      if (!left?.id || !right?.id || left.consensusId === right.consensusId) continue;
      const relation = semanticRelationship(left, right);
      if (!relation || relation.confidence < 0.82) continue;
      const consensusPair = [left.consensusId, right.consensusId].sort().join('::');
      const current = pairBest.get(consensusPair);
      if (!current || relation.confidence > current.relation.confidence) {
        pairBest.set(consensusPair, { left, right, relation });
      }
    }
  }
  for (const { left, right, relation } of pairBest.values()) {
    semanticLinks.push({
      id: stableId('lnk', 'semantic', left.id, right.id, relation.source),
      workspaceId: space.workspaceId,
      fromDocId: left.id,
      fromAnchorId: '',
      toDocId: right.id,
      toAnchorId: '',
      kind: 'semantic',
      label: 'Strong consensus relation',
      url: '',
      metadata: {
        confidence: relation.confidence,
        reason: relation.reason,
        source: relation.source,
        fromConsensusId: left.consensusId,
        toConsensusId: right.consensusId,
      },
    });
  }
  space.links = [
    ...safeArray(space.links).filter((link) => link.kind !== 'semantic' || link.metadata?.source === 'manual'),
    ...semanticLinks,
  ];
  return semanticLinks;
}

export function importKnowledgeMarkdown({ state, workspaceId = 'local', markdown = '', sourceName = '', sourceUrl = '', actor = null, now = () => new Date().toISOString(), consensusId = '', identity = null } = {}) {
  const space = ensureKnowledgeSpace(state, workspaceId, { now });
  normalizeSpace(space);
  const timestamp = isoNow(now);
  const parsed = splitMarkdownByHeadings(markdown);
  const rootTitle = parsed.rootTitle || sourceName || 'Knowledge Space';
  const rootBody = stripLeadingMarkdownHeading(parsed.rootMarkdown, 1);
  const resolved = resolveConsensusForImport(space, {
    workspaceId,
    rootTitle,
    sections: parsed.sections,
    consensusId,
    identity,
  });
  const rootId = resolved.mode === 'existing'
    ? resolved.group.rootDocId
    : stableId('doc', workspaceId, resolved.group.id, 'root');
  const effectiveConsensusId = resolved.group.id;

  const rootExists = resolved.mode === 'existing' && safeArray(space.documents).some((doc) => doc.id === rootId);
  if (rootExists) {
    const changes = [{ docId: rootId, proposedMarkdown: rootBody }];
    for (const section of parsed.sections) {
      const sectionMarkdown = stripLeadingMarkdownHeading(section.markdown, 2);
      const docId = sectionDocIdForConsensus(space, effectiveConsensusId, section.title);
      const exists = safeArray(space.documents).some((doc) => doc.id === docId);
      changes.push(exists
        ? { docId, proposedMarkdown: sectionMarkdown }
        : {
          docId,
          isNew: true,
          title: section.title,
          level: 2,
          parentId: rootId,
          consensusId: effectiveConsensusId,
          consensusRootId: rootId,
          sourceUrl,
          proposedMarkdown: sectionMarkdown,
        });
    }
    const result = createKnowledgeChangeSession({
      state,
      workspaceId,
      summary: `Re-import ${rootTitle}`,
      changes,
      actor,
      now,
    });
    return {
      space,
      session: result.session,
      mode: 'draft',
      consensus: {
        id: effectiveConsensusId,
        rootDocId: rootId,
        reason: resolved.reason,
        confidence: resolved.confidence,
      },
      imported: { documents: changes.length, anchors: 0 },
    };
  }

  const importedDocIds = new Set();
  const importedAnchorIds = new Set();
  const importedLinks = [];
  const root = upsertDocumentFromMarkdown(space, {
    id: rootId,
    title: rootTitle,
    markdown: rootBody,
    level: 1,
    consensusId: effectiveConsensusId,
    consensusRootId: rootId,
    consensusTitle: rootTitle,
    metadata: { consensusId: effectiveConsensusId, consensusRootId: rootId },
    sourceUrl,
  }, { now: timestamp, actor });
  importedDocIds.add(root.doc.id);

  for (let index = 0; index < parsed.sections.length; index += 1) {
    const section = parsed.sections[index];
    const sectionMarkdown = stripLeadingMarkdownHeading(section.markdown, 2);
    const docId = sectionDocIdForConsensus(space, effectiveConsensusId, section.title);
    const { doc } = upsertDocumentFromMarkdown(space, {
      id: docId,
      title: section.title,
      markdown: sectionMarkdown,
      parentId: rootId,
      level: 2,
      consensusId: effectiveConsensusId,
      consensusRootId: rootId,
      consensusTitle: rootTitle,
      metadata: { consensusId: effectiveConsensusId, consensusRootId: rootId },
      sourceUrl,
    }, { now: timestamp, actor });
    importedDocIds.add(doc.id);
    importedLinks.push({
      id: stableId('lnk', rootId, doc.id, 'child', index),
      workspaceId: space.workspaceId,
      fromDocId: rootId,
      fromAnchorId: '',
      toDocId: doc.id,
      toAnchorId: '',
      kind: 'hierarchy',
      label: doc.title,
      url: '',
    });
    const blocks = anchorBlocks(sectionMarkdown);
    for (let anchorIndex = 0; anchorIndex < blocks.length; anchorIndex += 1) {
      const block = blocks[anchorIndex];
      const anchorId = stableId('anch', doc.id, block.title);
      importedAnchorIds.add(anchorId);
      const anchor = {
        id: anchorId,
        workspaceId: space.workspaceId,
        docId: doc.id,
        consensusId: effectiveConsensusId,
        consensusRootId: rootId,
        title: block.title,
        level: 3,
        slug: slugify(block.title),
        anchor: slugify(block.title),
        summary: summarizeMarkdown(block.markdown),
        updatedAt: timestamp,
        sourceUrl,
      };
      const existingAnchor = space.anchors.find((item) => item.id === anchor.id);
      if (existingAnchor) Object.assign(existingAnchor, anchor);
      else space.anchors.push(anchor);
      importedLinks.push({
        id: stableId('lnk', doc.id, anchorId, 'anchor', anchorIndex),
        workspaceId: space.workspaceId,
        fromDocId: doc.id,
        fromAnchorId: '',
        toDocId: doc.id,
        toAnchorId: anchorId,
        kind: 'anchor',
        label: block.title,
        url: '',
      });
      importedLinks.push(...linksFromMarkdown(block.markdown, doc.id, anchorId));
    }
  }
  space.links = [
    ...safeArray(space.links).filter((link) => !importedLinks.some((next) => next.id === link.id)),
    ...importedLinks,
  ];
  ensureConsensusAssignments(space);
  rebuildKnowledgeSemanticLinks(space);
  space.updatedAt = timestamp;

  const session = {
    id: stableId('chg', space.workspaceId, 'import', rootTitle, timestamp),
    workspaceId: space.workspaceId,
    status: 'published',
    summary: `Imported ${rootTitle}`,
    actorHumanId: actorHumanId(actor),
    createdAt: timestamp,
    updatedAt: timestamp,
    publishedAt: timestamp,
    baseVersions: {},
    changes: [...importedDocIds].map((docId) => ({
      docId,
      baseVersionId: '',
      status: 'published',
    })),
    conflict: false,
    immutable: true,
  };
  space.changeSessions.push(session);
  addChangelog(space, session, {
    type: 'published',
    title: `Imported ${rootTitle}`,
    detail: `${importedDocIds.size} documents and ${importedAnchorIds.size} anchors imported.`,
    createdAt: timestamp,
  });
  return {
    space,
    session,
    mode: 'published',
    consensus: {
      id: effectiveConsensusId,
      rootDocId: rootId,
      reason: resolved.reason,
      confidence: resolved.confidence,
    },
    imported: { documents: importedDocIds.size, anchors: importedAnchorIds.size },
  };
}

function orderedConsensusChildren(space, rootDocId = '', consensusId = '') {
  const hierarchyOrder = new Map(safeArray(space.links)
    .filter((link) => link.kind === 'hierarchy' && link.fromDocId === rootDocId && link.toDocId)
    .map((link, index) => [link.toDocId, index]));
  return safeArray(space.documents)
    .filter((doc) => doc.consensusId === consensusId && doc.parentId === rootDocId)
    .map((doc, index) => ({ doc, index }))
    .sort((left, right) => (
      (hierarchyOrder.get(left.doc.id) ?? left.index) - (hierarchyOrder.get(right.doc.id) ?? right.index)
    ))
    .map((item) => item.doc);
}

function resolveConsensusGroup(space, selector = {}) {
  normalizeSpace(space);
  const cleanConsensusId = cleanString(selector.consensusId || selector.consensus_id || selector.id);
  const cleanRootDocId = cleanString(selector.rootDocId || selector.docId || selector.documentId || selector.root_doc_id);
  const cleanTitle = normalizeConsensusTitle(selector.title || selector.rootTitle || '');
  if (cleanConsensusId) {
    const group = space.consensusGroups.find((item) => item.id === cleanConsensusId);
    if (group) return group;
  }
  if (cleanRootDocId) {
    const doc = space.documents.find((item) => item.id === cleanRootDocId);
    if (doc?.consensusId) return space.consensusGroups.find((item) => item.id === doc.consensusId) || null;
  }
  if (cleanTitle) {
    return space.consensusGroups.find((group) => normalizeConsensusTitle(group.title) === cleanTitle)
      || space.consensusGroups.find((group) => titleSimilarity(group.title, selector.title || selector.rootTitle || '') >= 0.92)
      || null;
  }
  return null;
}

export function exportKnowledgeConsensusMarkdown(space, selector = {}) {
  normalizeSpace(space);
  const group = resolveConsensusGroup(space, selector);
  if (!group) throw new Error('Knowledge consensus not found.');
  const root = consensusRootForId(space, group.id);
  if (!root) throw new Error('Knowledge consensus root document not found.');
  const chunks = [`# ${decodeMarkdownEscapes(root.title || group.title || 'Consensus')}`];
  const rootBody = stripGeneratedRootDocumentLinks(stripLeadingMarkdownHeading(root.sourceMarkdown || '', 1));
  if (rootBody) chunks.push(rootBody);
  for (const child of orderedConsensusChildren(space, root.id, group.id)) {
    const body = stripLeadingMarkdownHeading(child.sourceMarkdown || '', 2);
    chunks.push(`## ${decodeMarkdownEscapes(child.title || 'Section')}`);
    if (body) chunks.push(body);
  }
  const markdown = `${chunks.map((chunk) => String(chunk || '').trim()).filter(Boolean).join('\n\n')}\n`;
  return {
    consensusId: group.id,
    rootDocId: root.id,
    title: decodeMarkdownEscapes(root.title || group.title || ''),
    markdown,
    documents: [publicKnowledgeDocumentRow(root), ...orderedConsensusChildren(space, root.id, group.id).map(publicKnowledgeDocumentRow)],
  };
}

export function getKnowledgeDocument(space, docId) {
  normalizeSpace(space);
  const doc = space.documents.find((item) => item.id === docId) || space.documents[0] || null;
  if (!doc) return null;
  const displayMarkdown = documentDisplayMarkdown(doc);
  const rendered = renderKnowledgeMarkdown(displayMarkdown || doc.sourceMarkdown || '');
  const backlinks = space.links
    .filter((link) => (link.toDocId === doc.id || link.toAnchorId) && link.fromDocId !== doc.id)
    .map((link) => ({
      id: link.id,
      fromDocId: link.fromDocId,
      fromAnchorId: link.fromAnchorId || '',
      label: link.label || '',
      sourceTitle: space.documents.find((item) => item.id === link.fromDocId)?.title || '',
    }));
  const anchors = space.anchors.filter((anchor) => anchor.docId === doc.id);
  const hierarchyOrder = new Map(safeArray(space.links)
    .filter((link) => link.fromDocId === doc.id && link.kind === 'hierarchy' && link.toDocId)
    .map((link, index) => [link.toDocId, index]));
  const childDocuments = space.documents
    .filter((item) => item.parentId === doc.id)
    .map((item, index) => ({ item, index }))
    .sort((left, right) => (
      (hierarchyOrder.get(left.item.id) ?? left.index) - (hierarchyOrder.get(right.item.id) ?? right.index)
    ))
    .map(({ item }) => publicKnowledgeDocumentRow(item));
  return {
    ...cloneJson(doc),
    title: decodeMarkdownEscapes(doc.title || ''),
    summary: decodeMarkdownEscapes(doc.summary || ''),
    renderedHtml: rendered.html,
    anchors: anchors.map((anchor) => ({
      ...cloneJson(anchor),
      title: decodeMarkdownEscapes(anchor.title || ''),
      summary: decodeMarkdownEscapes(anchor.summary || ''),
    })),
    backlinks,
    childDocuments,
  };
}

function nodeDegree(edges, nodeId) {
  return edges.reduce((count, edge) => count + (edge.source === nodeId || edge.target === nodeId ? 1 : 0), 0);
}

export function getKnowledgeGraph(space, options = {}) {
  normalizeSpace(space);
  const nowMs = Date.parse(options.now || new Date().toISOString());
  const nodes = [];
  const edges = [];
  const edgeKeys = new Set();
  const rootNodeId = space.id || stableId('ks', space.workspaceId || 'local');
  const rootDocuments = space.documents.filter((doc) => !doc.parentId);
  const includeSpaceNode = rootDocuments.length === 0;
  const pushEdge = (source, target, kind = 'link', id = '', metadata = {}) => {
    if (!source || !target || source === target) return;
    const key = `${source}->${target}->${kind}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ id: id || stableId('edge', source, target, kind), source, target, kind, metadata });
  };
  if (includeSpaceNode) {
    nodes.push({
      id: rootNodeId,
      kind: 'space',
      docId: '',
      title: space.title || 'Knowledge Space',
      summary: 'Server-level knowledge space',
      level: 0,
      updatedAt: space.updatedAt,
      href: `/s/${encodeURIComponent(space.workspaceId)}/knowledge`,
    });
  }
  for (const doc of space.documents) {
    nodes.push({
      id: doc.id,
      kind: 'document',
      docId: doc.id,
      parentId: doc.parentId || '',
      consensusId: doc.consensusId || '',
      consensusRootId: doc.consensusRootId || '',
      consensusTitle: doc.consensusTitle || '',
      consensusRole: doc.parentId ? 'member' : 'root',
      title: doc.title,
      summary: doc.summary || '',
      level: doc.level || 1,
      updatedAt: doc.updatedAt,
      href: `/s/${encodeURIComponent(space.workspaceId)}/knowledge/docs/${encodeURIComponent(doc.id)}`,
    });
    if (doc.parentId) {
      pushEdge(doc.parentId, doc.id, 'hierarchy');
    } else if (includeSpaceNode) {
      pushEdge(rootNodeId, doc.id, 'root');
    }
  }
  for (const anchor of space.anchors) {
    nodes.push({
      id: anchor.id,
      kind: 'anchor',
      docId: anchor.docId,
      anchorId: anchor.id,
      consensusId: anchor.consensusId || '',
      consensusRootId: anchor.consensusRootId || '',
      consensusRole: 'anchor',
      title: anchor.title,
      summary: anchor.summary || '',
      level: anchor.level || 3,
      updatedAt: anchor.updatedAt,
      href: `/s/${encodeURIComponent(space.workspaceId)}/knowledge/docs/${encodeURIComponent(anchor.docId)}#${encodeURIComponent(anchor.anchor)}`,
    });
    pushEdge(anchor.docId, anchor.id, 'anchor');
  }
  for (const link of space.links) {
    if (!link.toDocId && !link.toAnchorId) continue;
    const source = link.fromAnchorId || link.fromDocId;
    const target = link.toAnchorId || link.toDocId;
    pushEdge(source, target, link.kind || 'link', link.id, link.metadata || {});
  }
  const degreeById = new Map(nodes.map((node) => [node.id, nodeDegree(edges, node.id)]));
  const outgoing = new Set(edges.map((edge) => edge.source));
  return {
    nodes: nodes.map((node) => {
      const degree = degreeById.get(node.id) || 0;
      const isLeaf = !outgoing.has(node.id);
      const updatedMs = Date.parse(node.updatedAt || '');
      const recentLeaf = isLeaf && Number.isFinite(updatedMs) && Number.isFinite(nowMs) && nowMs - updatedMs <= RECENT_LEAF_WINDOW_MS;
      return {
        ...node,
        degree,
        radius: knowledgeGraphRadius(node, degree),
        colorRole: recentLeaf ? 'recent_leaf' : 'normal',
      };
    }),
    edges,
  };
}

function knowledgeGraphRadius(node, degree) {
  const level = Number(node.level || 3);
  const base = node.kind === 'space'
    ? 8.5
    : node.consensusRole === 'root' || level <= 1
      ? 8.9
      : level === 2
        ? 4.8
        : 2.8;
  return Math.max(2.6, Math.min(11, base + Math.min(2.6, Math.sqrt(degree + 1) * 0.55)));
}

function searchTokens(value) {
  const text = cleanString(value).toLowerCase();
  const tokens = new Set();
  for (const match of text.matchAll(/[a-z0-9][a-z0-9_-]{1,}/g)) {
    tokens.add(match[0]);
  }
  for (const match of text.matchAll(/[\u3400-\u9fff]+/g)) {
    const chars = [...match[0]];
    for (const char of chars) tokens.add(char);
    for (let size = 2; size <= 4; size += 1) {
      for (let index = 0; index <= chars.length - size; index += 1) {
        tokens.add(chars.slice(index, index + size).join(''));
      }
    }
  }
  return [...tokens].filter(Boolean);
}

function tokenWeight(token) {
  if (/^[\u3400-\u9fff]$/.test(token)) return 0.35;
  return Math.max(1, Math.min(8, [...token].length));
}

function scoreText(query, text) {
  const words = searchTokens(query);
  if (!words.length) return 0;
  const haystack = cleanString(text).toLowerCase();
  const textTokens = new Set(searchTokens(text));
  return words.reduce((score, word) => {
    if (textTokens.has(word)) return score + tokenWeight(word);
    return haystack.includes(word) ? score + Math.min(3, tokenWeight(word)) : score;
  }, 0);
}

function knowledgeSearch(space, query, limit = 5) {
  normalizeSpace(space);
  const rows = [
    ...space.documents.map((doc) => ({
      type: 'document',
      id: doc.id,
      docId: doc.id,
      title: doc.title,
      summary: doc.summary,
      text: `${doc.title}\n${doc.summary}\n${doc.sourceMarkdown || ''}`,
      href: `/s/${encodeURIComponent(space.workspaceId)}/knowledge/docs/${encodeURIComponent(doc.id)}`,
      sourceUrl: doc.sourceUrl || '',
    })),
    ...space.anchors.map((anchor) => ({
      type: 'anchor',
      id: anchor.id,
      docId: anchor.docId,
      anchorId: anchor.id,
      title: anchor.title,
      summary: anchor.summary,
      text: `${anchor.title}\n${anchor.summary}`,
      href: `/s/${encodeURIComponent(space.workspaceId)}/knowledge/docs/${encodeURIComponent(anchor.docId)}#${encodeURIComponent(anchor.anchor)}`,
      sourceUrl: anchor.sourceUrl || '',
    })),
  ];
  return rows
    .map((row) => ({ ...row, score: scoreText(query, row.text) + (row.type === 'anchor' ? 0.5 : 0) }))
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
    .slice(0, limit);
}

function knowledgeSearchSnippet(row = {}, query = '') {
  const summary = cleanString(row.summary);
  if (summary) return summary.slice(0, 220);
  const text = cleanString(row.text);
  if (!text) return '';
  const tokens = searchTokens(query).filter((token) => [...token].length > 1);
  const lower = text.toLowerCase();
  const matchIndex = tokens
    .map((token) => lower.indexOf(token.toLowerCase()))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? 0;
  const start = Math.max(0, matchIndex - 60);
  const snippet = text.slice(start, start + 220).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '...' : ''}${snippet}${start + 220 < text.length ? '...' : ''}`;
}

function compactKnowledgeMatch(row = {}, query = '', options = {}) {
  const compact = {
    type: row.type || '',
    id: row.id || '',
    docId: row.docId || '',
    anchorId: row.anchorId || '',
    title: row.title || '',
    summary: row.summary || '',
    snippet: knowledgeSearchSnippet(row, query),
    href: row.href || '',
    sourceUrl: row.sourceUrl || '',
    score: Number(row.score || 0),
  };
  if (options.includeContent) compact.text = row.text || '';
  return compact;
}

export function searchKnowledgeConsensus(space, query, options = {}) {
  const limit = Math.max(1, Math.min(20, Number(options.limit || 5) || 5));
  const cleanQuery = cleanString(query);
  const matches = knowledgeSearch(space, cleanQuery, limit)
    .map((match) => compactKnowledgeMatch(match, cleanQuery, { includeContent: Boolean(options.includeContent) }));
  return {
    ok: true,
    kind: 'knowledge_consensus_search',
    query: cleanQuery,
    count: matches.length,
    matches,
  };
}

export async function askKnowledgeConsensus(space, query, options = {}) {
  const rawMatches = knowledgeSearch(space, query, 5);
  const matches = options.compact
    ? rawMatches.map((match) => compactKnowledgeMatch(match, query, { includeContent: Boolean(options.includeContent) }))
    : rawMatches;
  const fallbackAnswer = matches.length
    ? `Matched ${matches.length} consensus item${matches.length === 1 ? '' : 's'}. Start with: ${matches[0].summary || matches[0].title}`
    : 'No matching consensus item was found in this Knowledge Space.';
  const config = llmConfigFromEnv(options.env || process.env);
  if (matches.length && llmConfigReady(config) && options.env?.MAGCLAW_LLM_DISABLED !== '1') {
    try {
      const payload = await requestLlmJson({
        config,
        system: 'You answer questions using only the provided MagClaw Knowledge Space consensus items. Return JSON with an "answer" string.',
        user: JSON.stringify({
          question: cleanString(query),
          matches: rawMatches.map((match) => ({
            title: match.title,
            summary: match.summary,
            href: match.href,
          })),
        }),
        maxTokens: 1200,
      });
      const answer = cleanString(payload?.answer);
      if (answer) return { answer, matches, llm: { used: true } };
    } catch (error) {
      console.warn(`[knowledge-space] ask LLM failed: ${cleanString(error?.message || error)}`);
    }
  }
  return {
    answer: fallbackAnswer,
    matches,
    llm: { used: false },
  };
}

export async function alignKnowledgeDiscussion(space, text, options = {}) {
  const rawMatches = knowledgeSearch(space, text, 6);
  const matches = options.compact
    ? rawMatches.map((match) => compactKnowledgeMatch(match, text, { includeContent: Boolean(options.includeContent) }))
    : rawMatches;
  const config = llmConfigFromEnv(options.env || process.env);
  if (!rawMatches.length || !llmConfigReady(config) || options.env?.MAGCLAW_LLM_DISABLED === '1') {
    return { rules: matches, alignmentGaps: [], llm: { used: false } };
  }
  try {
    const payload = await requestLlmJson({
      config,
      system: [
        'You compare a discussion against MagClaw Knowledge Space consensus items.',
        'Return strict JSON: {"alignmentGaps":[{"docId":"","anchorId":"","title":"","observation":"","suggestedAdjustment":"","confidence":0.0}]}',
        'Only include high-confidence, actionable gaps. Do not include generic reminders.',
      ].join('\n'),
      user: JSON.stringify({
        discussion: cleanString(text),
        consensus: rawMatches.map((match) => ({
          docId: match.docId,
          anchorId: match.anchorId || '',
          title: match.title,
          summary: match.summary,
        })),
      }),
      maxTokens: 1600,
    });
    const minConfidence = Number.isFinite(Number(options.minConfidence)) ? Number(options.minConfidence) : 0.7;
    const alignmentGaps = safeArray(payload?.alignmentGaps)
      .map((gap) => ({
        docId: cleanString(gap.docId),
        anchorId: cleanString(gap.anchorId),
        title: cleanString(gap.title),
        observation: cleanString(gap.observation),
        suggestedAdjustment: cleanString(gap.suggestedAdjustment),
        confidence: Number(gap.confidence || 0),
      }))
      .filter((gap) => gap.title && gap.observation && gap.suggestedAdjustment && gap.confidence >= minConfidence);
    return { rules: matches, alignmentGaps, llm: { used: true } };
  } catch (error) {
    console.warn(`[knowledge-space] align LLM failed: ${cleanString(error?.message || error)}`);
  }
  return {
    rules: matches,
    alignmentGaps: [],
    llm: { used: false },
  };
}

function normalizeChangeInput(space, change = {}) {
  const docId = cleanString(change.docId);
  const doc = space.documents.find((item) => item.id === docId);
  if (!doc && !change.isNew) throw new Error(`Unknown knowledge document: ${docId || '(missing)'}`);
  const proposedMarkdown = cleanString(change.proposedMarkdown || change.markdown || doc?.sourceMarkdown || '');
  return {
    docId: doc?.id || docId,
    isNew: Boolean(change.isNew && !doc),
    newDocMeta: change.isNew && !doc
      ? {
        title: cleanString(change.title || change.newDocMeta?.title || docId),
        level: Number(change.level || change.newDocMeta?.level || 1),
        parentId: cleanString(change.parentId || change.newDocMeta?.parentId),
        consensusId: cleanString(change.consensusId || change.newDocMeta?.consensusId),
        consensusRootId: cleanString(change.consensusRootId || change.newDocMeta?.consensusRootId),
        sourceUrl: cleanString(change.sourceUrl || change.newDocMeta?.sourceUrl),
      }
      : null,
    baseVersionId: cleanString(doc?.currentVersionId || ''),
    proposedMarkdown,
    proposedHtml: renderKnowledgeMarkdown(proposedMarkdown).html,
    diffHtml: renderKnowledgeDiff(doc?.sourceMarkdown || '', proposedMarkdown),
    status: 'draft',
  };
}

export function renderKnowledgeDiff(before = '', after = '') {
  const beforeLines = String(before || '').replace(/\r\n?/g, '\n').split('\n');
  const afterLines = String(after || '').replace(/\r\n?/g, '\n').split('\n');
  const dp = Array.from({ length: beforeLines.length + 1 }, () => Array(afterLines.length + 1).fill(0));
  for (let left = beforeLines.length - 1; left >= 0; left -= 1) {
    for (let right = afterLines.length - 1; right >= 0; right -= 1) {
      dp[left][right] = beforeLines[left] === afterLines[right]
        ? dp[left + 1][right + 1] + 1
        : Math.max(dp[left + 1][right], dp[left][right + 1]);
    }
  }
  const rows = [];
  let left = 0;
  let right = 0;
  while (left < beforeLines.length || right < afterLines.length) {
    if (left < beforeLines.length && right < afterLines.length && beforeLines[left] === afterLines[right]) {
      rows.push(`<tr class="same"><td>${left + 1}</td><td>${escapeHtml(beforeLines[left])}</td><td>${escapeHtml(afterLines[right])}</td></tr>`);
      left += 1;
      right += 1;
    } else if (right < afterLines.length && (left >= beforeLines.length || dp[left][right + 1] >= dp[left + 1]?.[right])) {
      rows.push(`<tr class="added"><td></td><td></td><td>${escapeHtml(afterLines[right])}</td></tr>`);
      right += 1;
    } else {
      rows.push(`<tr class="removed"><td>${left + 1}</td><td>${escapeHtml(beforeLines[left])}</td><td></td></tr>`);
      left += 1;
    }
  }
  return `<table class="knowledge-diff-table"><thead><tr><th>#</th><th>Published</th><th>Proposed</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
}

export function createKnowledgeChangeSession({ state, workspaceId = 'local', summary = '', changes = [], actor = null, now = () => new Date().toISOString() }) {
  const space = ensureKnowledgeSpace(state, workspaceId, { now });
  normalizeSpace(space);
  if (!changes.length) throw new Error('At least one document change is required.');
  const timestamp = isoNow(now);
  const normalizedChanges = changes.map((change) => normalizeChangeInput(space, change));
  const session = {
    id: stableId('chg', space.workspaceId, actorHumanId(actor), timestamp, summary || normalizedChanges.map((change) => change.docId).join(',')),
    workspaceId: space.workspaceId,
    status: 'draft',
    summary: summary || 'Knowledge update draft',
    actorHumanId: actorHumanId(actor),
    createdAt: timestamp,
    updatedAt: timestamp,
    publishedAt: '',
    immutable: false,
    conflict: false,
    conflictDetails: [],
    baseVersions: Object.fromEntries(normalizedChanges.map((change) => [change.docId, change.baseVersionId])),
    changes: normalizedChanges,
  };
  space.changeSessions.push(session);
  addChangelog(space, session, {
    type: 'draft',
    title: 'Draft created',
    detail: `${normalizedChanges.length} document change${normalizedChanges.length === 1 ? '' : 's'} staged.`,
    createdAt: timestamp,
  });
  space.updatedAt = timestamp;
  return { space, session };
}

function requireSession(space, sessionId) {
  normalizeSpace(space);
  const session = space.changeSessions.find((item) => item.id === sessionId);
  if (!session) throw new Error('Change session not found.');
  return session;
}

function transitionSession(space, sessionId, nextStatus, options = {}) {
  if (!CHANGE_STATES.has(nextStatus)) throw new Error(`Invalid knowledge change state: ${nextStatus}`);
  const session = requireSession(space, sessionId);
  if (session.immutable || session.status === 'published') throw new Error('Published change sessions are immutable.');
  const allowed = {
    draft: new Set(['draft', 'diff']),
    diff: new Set(['diff', 'preview']),
    preview: new Set(['preview', 'diff']),
  };
  if (!allowed[session.status]?.has(nextStatus)) {
    throw new Error(`Invalid Knowledge Space transition: ${session.status} -> ${nextStatus}.`);
  }
  const timestamp = isoNow(options.now);
  session.status = nextStatus;
  session.updatedAt = timestamp;
  session.changes = safeArray(session.changes).map((change) => ({ ...change, status: nextStatus }));
  if (nextStatus !== 'diff') {
    session.conflict = false;
    session.conflictDetails = [];
  }
  addChangelog(space, session, {
    type: nextStatus,
    title: options.title || `Moved to ${nextStatus}`,
    detail: options.detail || '',
    createdAt: timestamp,
  });
  space.updatedAt = timestamp;
  return session;
}

export function moveKnowledgeSessionToDiff({ state, workspaceId, sessionId, now }) {
  const space = ensureKnowledgeSpace(state, workspaceId, { now });
  return { space, session: transitionSession(space, sessionId, 'diff', { now, title: 'Diff ready' }) };
}

export function moveKnowledgeSessionToPreview({ state, workspaceId, sessionId, now }) {
  const space = ensureKnowledgeSpace(state, workspaceId, { now });
  return { space, session: transitionSession(space, sessionId, 'preview', { now, title: 'Preview ready' }) };
}

function detectPublishConflicts(space, session) {
  const conflicts = [];
  for (const change of safeArray(session.changes)) {
    const doc = space.documents.find((item) => item.id === change.docId);
    if (change.isNew) {
      if (doc) conflicts.push({ docId: change.docId, reason: 'document_created', latestVersionId: doc.currentVersionId || '' });
      continue;
    }
    if (!doc) {
      conflicts.push({ docId: change.docId, reason: 'document_deleted', latestVersionId: '' });
      continue;
    }
    if (doc.currentVersionId !== change.baseVersionId) {
      conflicts.push({
        docId: doc.id,
        reason: 'base_version_changed',
        baseVersionId: change.baseVersionId,
        latestVersionId: doc.currentVersionId,
        conflictDiffHtml: renderKnowledgeDiff(
          space.versions.find((version) => version.id === change.baseVersionId)?.sourceMarkdown || '',
          doc.sourceMarkdown || '',
        ),
      });
    }
  }
  return conflicts;
}

function upsertKnowledgeLink(space, link) {
  const existing = space.links.find((item) => item.id === link.id);
  if (existing) Object.assign(existing, link);
  else space.links.push(link);
}

function rebuildNewDocumentAnchorsAndLinks(space, doc, markdown, timestamp, sourceUrl = '') {
  normalizeSpace(space);
  if (doc.parentId) {
    upsertKnowledgeLink(space, {
      id: stableId('lnk', doc.parentId, doc.id, 'child', doc.title),
      workspaceId: space.workspaceId,
      fromDocId: doc.parentId,
      fromAnchorId: '',
      toDocId: doc.id,
      toAnchorId: '',
      kind: 'hierarchy',
      label: doc.title,
      url: '',
    });
  }
  const links = [];
  const blocks = anchorBlocks(markdown);
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    const anchorId = stableId('anch', doc.id, block.title);
    const anchor = {
      id: anchorId,
      workspaceId: space.workspaceId,
      docId: doc.id,
      consensusId: doc.consensusId || '',
      consensusRootId: doc.consensusRootId || '',
      title: block.title,
      level: 3,
      slug: slugify(block.title),
      anchor: slugify(block.title),
      summary: summarizeMarkdown(block.markdown),
      updatedAt: timestamp,
      sourceUrl,
    };
    const existingAnchor = space.anchors.find((item) => item.id === anchor.id);
    if (existingAnchor) Object.assign(existingAnchor, anchor);
    else space.anchors.push(anchor);
    links.push({
      id: stableId('lnk', doc.id, anchorId, 'anchor', index),
      workspaceId: space.workspaceId,
      fromDocId: doc.id,
      fromAnchorId: '',
      toDocId: doc.id,
      toAnchorId: anchorId,
      kind: 'anchor',
      label: block.title,
      url: '',
    });
    links.push(...linksFromMarkdown(block.markdown, doc.id, anchorId));
  }
  for (const link of links) upsertKnowledgeLink(space, link);
  ensureConsensusAssignments(space);
}

function publishChanges(space, session, now, actor) {
  for (const change of safeArray(session.changes)) {
    if (change.isNew && change.newDocMeta) {
      const { doc } = upsertDocumentFromMarkdown(space, {
        id: change.docId,
        title: change.newDocMeta.title,
        markdown: change.proposedMarkdown,
        parentId: change.newDocMeta.parentId,
        level: change.newDocMeta.level,
        consensusId: change.newDocMeta.consensusId,
        consensusRootId: change.newDocMeta.consensusRootId,
        consensusTitle: space.documents.find((item) => item.id === change.newDocMeta.consensusRootId)?.title || '',
        sourceUrl: change.newDocMeta.sourceUrl,
      }, { now, actor });
      const version = space.versions.find((item) => item.id === doc.currentVersionId);
      if (version) version.changeSessionId = session.id;
      rebuildNewDocumentAnchorsAndLinks(space, doc, change.proposedMarkdown, now, change.newDocMeta.sourceUrl);
      continue;
    }
    const doc = space.documents.find((item) => item.id === change.docId);
    if (!doc) continue;
    const rendered = renderKnowledgeMarkdown(change.proposedMarkdown);
    const versionId = stableId('ver', doc.id, shortHash(change.proposedMarkdown, 16), documentVersionNumber(space, doc.id));
    space.versions.push({
      id: versionId,
      workspaceId: space.workspaceId,
      docId: doc.id,
      versionNumber: documentVersionNumber(space, doc.id),
      sourceMarkdown: change.proposedMarkdown,
      renderedHtml: rendered.html,
      contentHash: shortHash(change.proposedMarkdown, 16),
      baseVersionId: change.baseVersionId || doc.currentVersionId || '',
      createdAt: now,
      createdBy: actorHumanId(actor),
      changeSessionId: session.id,
    });
    doc.sourceMarkdown = change.proposedMarkdown;
    doc.renderedHtml = rendered.html;
    doc.summary = summarizeMarkdown(change.proposedMarkdown);
    doc.currentVersionId = versionId;
    doc.updatedAt = now;
  }
  ensureConsensusAssignments(space);
  rebuildKnowledgeSemanticLinks(space);
}

function explicitKnowledgeSecretRequired(env = process.env) {
  return env.NODE_ENV === 'production'
    || env.MAGCLAW_DEPLOYMENT === 'cloud'
    || env.MAGCLAW_CLOUD_DEPLOY === '1';
}

function secretKey(env = process.env) {
  const explicit = cleanString(env.MAGCLAW_KNOWLEDGE_SECRET_KEY);
  if (explicitKnowledgeSecretRequired(env) && !explicit) {
    throw new Error('MAGCLAW_KNOWLEDGE_SECRET_KEY is required for Knowledge Space secret encryption in production/cloud deployments.');
  }
  const seed = cleanString(explicit || env.MAGCLAW_SESSION_SECRET || env.MAGCLAW_AUTH_SECRET || 'magclaw-knowledge-space-local-dev');
  return crypto.createHash('sha256').update(seed).digest();
}

export function encryptKnowledgeSecret(secret, env = process.env) {
  const clean = cleanString(secret);
  if (!clean) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', secretKey(env), iv);
  const encrypted = Buffer.concat([cipher.update(clean, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${KNOWLEDGE_SECRET_PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${encrypted.toString('base64url')}`;
}

export function decryptKnowledgeSecret(value, env = process.env) {
  const encoded = cleanString(value);
  if (!encoded.startsWith(KNOWLEDGE_SECRET_PREFIX)) return '';
  const [ivRaw, tagRaw, payloadRaw] = encoded.slice(KNOWLEDGE_SECRET_PREFIX.length).split(':');
  if (!ivRaw || !tagRaw || !payloadRaw) return '';
  const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey(env), Buffer.from(ivRaw, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagRaw, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(payloadRaw, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function updateKnowledgeSettings({ state, workspaceId, patch = {}, actor = null, now = () => new Date().toISOString(), env = process.env }) {
  const space = ensureKnowledgeSpace(state, workspaceId, { now });
  normalizeSpace(space);
  if (!isKnowledgeAdmin(actor)) throw new Error('Only owner/admin users can update Knowledge Space settings.');
  const timestamp = isoNow(now);
  let changed = false;
  if (Array.isArray(patch.whitelistHumanIds)) {
    space.settings.whitelistHumanIds = [...new Set(patch.whitelistHumanIds.map(cleanString).filter(Boolean))];
    changed = true;
  }
  if (patch.feishu && typeof patch.feishu === 'object') {
    const feishu = space.settings.feishu;
    if (patch.feishu.appId !== undefined) {
      feishu.appId = cleanString(patch.feishu.appId);
      changed = true;
    }
    if (patch.feishu.chatId !== undefined) {
      feishu.chatId = cleanString(patch.feishu.chatId);
      changed = true;
    }
    if (patch.feishu.appSecret !== undefined) {
      const secret = cleanString(patch.feishu.appSecret);
      if (secret) {
        feishu.appSecretEncrypted = encryptKnowledgeSecret(secret, env);
        feishu.appSecretConfiguredAt = timestamp;
        changed = true;
      }
    }
    feishu.updatedAt = timestamp;
  }
  space.updatedAt = timestamp;
  if (changed) {
    const auditSession = {
      id: stableId('chg', space.workspaceId, 'settings', timestamp, actorHumanId(actor)),
      workspaceId: space.workspaceId,
      status: 'published',
      summary: 'Knowledge settings updated',
      actorHumanId: actorHumanId(actor),
      createdAt: timestamp,
      updatedAt: timestamp,
      publishedAt: timestamp,
    };
    addChangelog(space, auditSession, {
      type: 'settings_updated',
      title: 'Knowledge settings updated',
      detail: 'Knowledge Space settings were updated.',
      actorHumanId: actorHumanId(actor),
      createdAt: timestamp,
      metadata: {
        whitelistHumanIds: [...space.settings.whitelistHumanIds],
        feishuConfigured: Boolean(space.settings.feishu?.appSecretEncrypted),
      },
      link: `/s/${encodeURIComponent(space.workspaceId)}/knowledge/settings`,
    });
  }
  return { space, settings: publicKnowledgeSpace(space, actor, { env }).settings };
}

async function postFeishuCard({ feishu, card, fetchImpl = globalThis.fetch, env = process.env }) {
  const appId = cleanString(feishu.appId);
  const chatId = cleanString(feishu.chatId);
  const appSecret = decryptKnowledgeSecret(feishu.appSecretEncrypted, env);
  if (!appId || !chatId || !appSecret) {
    return { ok: false, status: 0, error: 'Feishu appId, chatId, or secret is not configured.' };
  }
  if (typeof fetchImpl !== 'function') {
    return { ok: false, status: 0, error: 'Fetch is unavailable.' };
  }
  const tokenRes = await fetchImpl('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const tokenJson = await tokenRes.json().catch(() => ({}));
  const token = cleanString(tokenJson.tenant_access_token);
  if (!tokenRes.ok || !token) {
    return { ok: false, status: tokenRes.status || 0, error: cleanString(tokenJson.msg || tokenJson.error || 'Failed to acquire Feishu tenant token.') };
  }
  const messageRes = await fetchImpl('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      receive_id: chatId,
      msg_type: 'interactive',
      content: JSON.stringify(card),
    }),
  });
  const messageJson = await messageRes.json().catch(() => ({}));
  if (!messageRes.ok || Number(messageJson.code || 0) !== 0) {
    return { ok: false, status: messageRes.status || 0, error: cleanString(messageJson.msg || messageJson.error || 'Failed to send Feishu card.') };
  }
  return { ok: true, status: messageRes.status || 200, messageId: cleanString(messageJson?.data?.message_id || messageJson?.data?.messageId) };
}

function knowledgePublishCard(space, session, publicBaseUrl = '') {
  const docTitles = safeArray(session.changes).map((change) => {
    const doc = space.documents.find((item) => item.id === change.docId);
    return doc?.title || change.docId;
  });
  const url = `${String(publicBaseUrl || '').replace(/\/$/, '')}/s/${encodeURIComponent(space.workspaceId)}/knowledge/reviews/${encodeURIComponent(session.id)}`;
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'green',
      title: { tag: 'plain_text', content: 'MagClaw 共识库已发布' },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**${session.summary || '共识更新'}**` } },
      { tag: 'div', text: { tag: 'lark_md', content: docTitles.map((title) => `- ${title}`).join('\n') || '- 暂无文档' } },
      ...(publicBaseUrl ? [{ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '打开发布记录' }, url, type: 'primary' }] }] : []),
    ],
  };
}

export async function sendKnowledgePublishNotification({ state, workspaceId, sessionId, now = () => new Date().toISOString(), fetchImpl, env = process.env, publicBaseUrl = '' }) {
  const space = ensureKnowledgeSpace(state, workspaceId, { now });
  normalizeSpace(space);
  const session = requireSession(space, sessionId);
  const timestamp = isoNow(now);
  const card = knowledgePublishCard(space, session, publicBaseUrl);
  const attempt = {
    id: stableId('kna', space.workspaceId, session.id, timestamp, space.notificationAttempts.length),
    workspaceId: space.workspaceId,
    changeSessionId: session.id,
    status: 'pending',
    createdAt: timestamp,
    updatedAt: timestamp,
    error: '',
    messageId: '',
  };
  space.notificationAttempts.push(attempt);
  try {
    const result = await postFeishuCard({ feishu: space.settings.feishu || {}, card, fetchImpl, env });
    attempt.status = result.ok ? 'sent' : 'failed';
    attempt.error = result.ok ? '' : result.error || 'Unknown Feishu error.';
    attempt.messageId = result.messageId || '';
    attempt.updatedAt = isoNow(now);
    addChangelog(space, session, {
      type: result.ok ? 'notification_sent' : 'notification_failed',
      title: result.ok ? 'Feishu notification sent' : 'Feishu notification failed',
      detail: result.ok ? 'Publish card delivered.' : attempt.error,
      createdAt: attempt.updatedAt,
    });
    return { attempt, result };
  } catch (error) {
    attempt.status = 'failed';
    attempt.error = cleanString(error?.message || error || 'Unknown Feishu error.');
    attempt.updatedAt = isoNow(now);
    addChangelog(space, session, {
      type: 'notification_failed',
      title: 'Feishu notification failed',
      detail: attempt.error,
      createdAt: attempt.updatedAt,
    });
    return { attempt, result: { ok: false, error: attempt.error } };
  }
}

export async function publishKnowledgeSession({ state, workspaceId, sessionId, actor = null, now = () => new Date().toISOString(), fetchImpl, env = process.env, publicBaseUrl = '' }) {
  const space = ensureKnowledgeSpace(state, workspaceId, { now });
  normalizeSpace(space);
  const session = requireSession(space, sessionId);
  if (session.immutable || session.status === 'published') throw new Error('Published change sessions are immutable.');
  if (session.status !== 'preview') throw new Error('Knowledge Space changes must be in preview before publish.');
  const conflicts = detectPublishConflicts(space, session);
  const timestamp = isoNow(now);
  if (conflicts.length) {
    session.status = 'diff';
    session.conflict = true;
    session.conflictDetails = conflicts;
    session.updatedAt = timestamp;
    session.changes = safeArray(session.changes).map((change) => ({ ...change, status: 'diff' }));
    addChangelog(space, session, {
      type: 'conflict',
      title: 'Publish conflict detected',
      detail: `${conflicts.length} touched document${conflicts.length === 1 ? '' : 's'} changed after this draft was created.`,
      createdAt: timestamp,
    });
    return { space, session, published: false, conflicts };
  }
  publishChanges(space, session, timestamp, actor);
  session.status = 'published';
  session.publishedAt = timestamp;
  session.updatedAt = timestamp;
  session.immutable = true;
  session.conflict = false;
  session.conflictDetails = [];
  session.changes = safeArray(session.changes).map((change) => ({ ...change, status: 'published' }));
  addChangelog(space, session, {
    type: 'published',
    title: 'Published',
    detail: `${session.changes.length} document change${session.changes.length === 1 ? '' : 's'} published.`,
    createdAt: timestamp,
  });
  space.updatedAt = timestamp;
  const notification = await sendKnowledgePublishNotification({ state, workspaceId, sessionId, now, fetchImpl, env, publicBaseUrl });
  return { space, session, published: true, conflicts: [], notification };
}

export function getKnowledgeChangelog(space, page = 1, limit = 100) {
  normalizeSpace(space);
  const safeLimit = Math.min(100, Math.max(1, Number(limit || 100)));
  const safePage = Math.max(1, Number(page || 1));
  const groups = [...space.changelogGroups]
    .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
  const total = groups.length;
  const start = (safePage - 1) * safeLimit;
  const selected = groups.slice(start, start + safeLimit).map((group) => ({
    ...group,
    events: space.changelogEvents
      .filter((event) => event.changeSessionId === group.changeSessionId)
      .sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || ''))),
  }));
  return {
    page: safePage,
    limit: safeLimit,
    total,
    totalPages: Math.max(1, Math.ceil(total / safeLimit)),
    groups: selected,
  };
}
