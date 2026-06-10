import crypto from 'node:crypto';

const RECENT_LEAF_WINDOW_MS = 72 * 60 * 60 * 1000;
const KNOWLEDGE_SECRET_PREFIX = 'enc:v1:';
const CHANGE_STATES = new Set(['draft', 'diff', 'preview', 'published']);
const EVENT_INDENT = {
  draft: 3,
  diff: 2,
  conflict: 2,
  preview: 1,
  published: 0,
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

function normalizeMarkdownLinks(text) {
  return String(text || '').replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_match, label, url) => {
    const cleanUrl = escapeHtml(url);
    return `<a href="${cleanUrl}" target="_blank" rel="noreferrer noopener">${escapeHtml(label)}</a>`;
  });
}

function renderInlineMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  return normalizeMarkdownLinks(html);
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

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/g, '');
    if (/^```/.test(line.trim())) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else {
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
      flushParagraph();
      closeList();
      const level = heading[1].length;
      const title = heading[2].replace(/\s+#+$/g, '').trim();
      const id = uniqueHeadingAnchor(title, level, headingSlugs);
      headings.push({ level, title, id });
      html.push(`<h${level} id="${escapeHtml(id)}">${renderInlineMarkdown(title)}</h${level}>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      pushListItem('ul', line.replace(/^\s*[-*]\s+/, ''));
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      pushListItem('ol', line.replace(/^\s*\d+\.\s+/, ''));
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      closeList();
      continue;
    }
    paragraph.push(line.trim());
  }
  if (inCode) html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  flushParagraph();
  closeList();
  return { html: html.join('\n'), headings };
}

function stripMarkdown(markdown = '') {
  return String(markdown || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#>*_`~-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

  for (const line of lines) {
    const h1 = line.match(/^#\s+(.+)$/);
    const h2 = line.match(/^##\s+(.+)$/);
    if (h1 && !rootTitle) {
      rootTitle = h1[1].trim();
      rootLines.push(line);
      continue;
    }
    if (h2) {
      current = { title: h2[1].trim(), lines: [line] };
      h2Sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else rootLines.push(line);
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

function actorHumanId(actor) {
  return cleanString(actor?.member?.humanId || actor?.user?.id || actor?.userId || actor?.humanId || 'local');
}

function actorRole(actor) {
  return cleanString(actor?.member?.role || actor?.role || 'owner') || 'owner';
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

function normalizeSpace(space) {
  space.documents = safeArray(space.documents);
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

function maskFeishuSettings(feishu = {}) {
  return {
    appId: feishu.appId || '',
    chatId: feishu.chatId || '',
    appSecretConfigured: Boolean(feishu.appSecretEncrypted),
    appSecretConfiguredAt: feishu.appSecretConfiguredAt || '',
    updatedAt: feishu.updatedAt || '',
  };
}

function publicChangeSession(session) {
  const copy = cloneJson(session);
  delete copy.proposedRaw;
  return copy;
}

export function publicKnowledgeSpace(space, actor = null) {
  const normalized = normalizeSpace(space);
  return {
    id: normalized.id,
    workspaceId: normalized.workspaceId,
    title: normalized.title,
    createdAt: normalized.createdAt,
    updatedAt: normalized.updatedAt,
    permissions: {
      canAdmin: isKnowledgeAdmin(actor),
      canEdit: isKnowledgeWhitelisted(normalized, actor),
    },
    settings: {
      whitelistHumanIds: normalized.settings.whitelistHumanIds,
      feishu: maskFeishuSettings(normalized.settings.feishu),
    },
    documents: normalized.documents.map((doc) => ({
      id: doc.id,
      parentId: doc.parentId || '',
      title: doc.title,
      level: doc.level || 1,
      summary: doc.summary || '',
      currentVersionId: doc.currentVersionId || '',
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
      sourceUrl: doc.sourceUrl || '',
    })),
    anchors: normalized.anchors.map((anchor) => ({
      id: anchor.id,
      docId: anchor.docId,
      title: anchor.title,
      level: anchor.level || 3,
      anchor: anchor.anchor,
      summary: anchor.summary || '',
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
      actorHumanId: session.actorHumanId || '',
    };
    space.changelogGroups.push(group);
  }
  group.status = session.status;
  group.updatedAt = now;
  group.publishedAt = session.publishedAt || group.publishedAt || '';
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
  for (const line of lines) {
    const h3 = line.match(/^###\s+(.+)$/);
    if (h3) {
      current = { title: h3[1].trim(), lines: [line] };
      blocks.push(current);
      continue;
    }
    if (current) current.lines.push(line);
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
  };
  if (existing) Object.assign(existing, doc);
  else space.documents.push(doc);
  space.versions.push(version);
  return { doc, version };
}

export function importKnowledgeMarkdown({ state, workspaceId = 'local', markdown = '', sourceName = '', sourceUrl = '', actor = null, now = () => new Date().toISOString() }) {
  const space = ensureKnowledgeSpace(state, workspaceId, { now });
  normalizeSpace(space);
  const timestamp = isoNow(now);
  const parsed = splitMarkdownByHeadings(markdown);
  const rootTitle = sourceName || parsed.rootTitle;
  const rootId = stableId('doc', workspaceId, rootTitle, 'root');
  const rootBody = [
    `# ${rootTitle}`,
    parsed.rootMarkdown.replace(/^#\s+.+$/m, '').trim(),
    parsed.sections.map((section) => `- [${section.title}](#${slugify(section.title)})`).join('\n'),
  ].filter(Boolean).join('\n\n');

  const importedDocIds = new Set();
  const importedAnchorIds = new Set();
  const importedLinks = [];
  const root = upsertDocumentFromMarkdown(space, {
    id: rootId,
    title: rootTitle,
    markdown: rootBody,
    level: 1,
    sourceUrl,
  }, { now: timestamp, actor });
  importedDocIds.add(root.doc.id);

  for (let index = 0; index < parsed.sections.length; index += 1) {
    const section = parsed.sections[index];
    const docId = stableId('doc', workspaceId, rootTitle, section.title);
    const { doc } = upsertDocumentFromMarkdown(space, {
      id: docId,
      title: section.title,
      markdown: section.markdown,
      parentId: rootId,
      level: 2,
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
    const blocks = anchorBlocks(section.markdown);
    for (let anchorIndex = 0; anchorIndex < blocks.length; anchorIndex += 1) {
      const block = blocks[anchorIndex];
      const anchorId = stableId('anch', doc.id, block.title);
      importedAnchorIds.add(anchorId);
      const anchor = {
        id: anchorId,
        workspaceId: space.workspaceId,
        docId: doc.id,
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
  return { space, session, imported: { documents: importedDocIds.size, anchors: importedAnchorIds.size } };
}

export function getKnowledgeDocument(space, docId) {
  normalizeSpace(space);
  const doc = space.documents.find((item) => item.id === docId) || space.documents[0] || null;
  if (!doc) return null;
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
  return { ...cloneJson(doc), anchors, backlinks };
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
  const pushEdge = (source, target, kind = 'link', id = '') => {
    if (!source || !target || source === target) return;
    const key = `${source}->${target}->${kind}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ id: id || stableId('edge', source, target, kind), source, target, kind });
  };
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
  for (const doc of space.documents) {
    nodes.push({
      id: doc.id,
      kind: 'document',
      docId: doc.id,
      parentId: doc.parentId || '',
      title: doc.title,
      summary: doc.summary || '',
      level: doc.level || 1,
      updatedAt: doc.updatedAt,
      href: `/s/${encodeURIComponent(space.workspaceId)}/knowledge/docs/${encodeURIComponent(doc.id)}`,
    });
    if (doc.parentId) {
      pushEdge(doc.parentId, doc.id, 'hierarchy');
    } else {
      pushEdge(rootNodeId, doc.id, 'root');
    }
  }
  for (const anchor of space.anchors) {
    nodes.push({
      id: anchor.id,
      kind: 'anchor',
      docId: anchor.docId,
      anchorId: anchor.id,
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
    pushEdge(source, target, link.kind || 'link', link.id);
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
    : level <= 1
      ? 7
      : level === 2
        ? 4.8
        : 2.8;
  return Math.max(2.6, Math.min(11, base + Math.min(2.6, Math.sqrt(degree + 1) * 0.55)));
}

function scoreText(query, text) {
  const words = cleanString(query).toLowerCase().split(/[\s,，。.!?、;；:：]+/).filter(Boolean);
  if (!words.length) return 0;
  const haystack = cleanString(text).toLowerCase();
  return words.reduce((score, word) => score + (haystack.includes(word) ? Math.max(1, Math.min(6, word.length)) : 0), 0);
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

export function askKnowledgeConsensus(space, query) {
  const matches = knowledgeSearch(space, query, 5);
  return {
    answer: matches.length
      ? `Matched ${matches.length} consensus item${matches.length === 1 ? '' : 's'}. Start with: ${matches[0].summary || matches[0].title}`
      : 'No matching consensus item was found in this Knowledge Space.',
    matches,
  };
}

export function alignKnowledgeDiscussion(space, text) {
  const matches = knowledgeSearch(space, text, 6);
  return {
    rules: matches,
    alignmentGaps: matches.slice(0, 3).map((match) => ({
      docId: match.docId,
      anchorId: match.anchorId || '',
      title: match.title,
      observation: `Check whether the current discussion explicitly satisfies "${match.title}".`,
      suggestedAdjustment: match.summary || 'Restate the decision against this consensus item before proceeding.',
    })),
  };
}

function normalizeChangeInput(space, change = {}) {
  const docId = cleanString(change.docId);
  const doc = space.documents.find((item) => item.id === docId);
  if (!doc) throw new Error(`Unknown knowledge document: ${docId || '(missing)'}`);
  const proposedMarkdown = cleanString(change.proposedMarkdown || change.markdown || doc.sourceMarkdown);
  return {
    docId: doc.id,
    baseVersionId: cleanString(change.baseVersionId || doc.currentVersionId),
    proposedMarkdown,
    proposedHtml: renderKnowledgeMarkdown(proposedMarkdown).html,
    diffHtml: renderKnowledgeDiff(doc.sourceMarkdown || '', proposedMarkdown),
    status: 'draft',
  };
}

export function renderKnowledgeDiff(before = '', after = '') {
  const beforeLines = String(before || '').replace(/\r\n?/g, '\n').split('\n');
  const afterLines = String(after || '').replace(/\r\n?/g, '\n').split('\n');
  const max = Math.max(beforeLines.length, afterLines.length);
  const rows = [];
  for (let index = 0; index < max; index += 1) {
    const left = beforeLines[index] ?? '';
    const right = afterLines[index] ?? '';
    if (left === right) {
      rows.push(`<tr class="same"><td>${index + 1}</td><td>${escapeHtml(left)}</td><td>${escapeHtml(right)}</td></tr>`);
    } else {
      rows.push(`<tr class="changed"><td>${index + 1}</td><td>${escapeHtml(left)}</td><td>${escapeHtml(right)}</td></tr>`);
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

function publishChanges(space, session, now, actor) {
  for (const change of safeArray(session.changes)) {
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
}

function secretKey(env = process.env) {
  const seed = cleanString(
    env.MAGCLAW_KNOWLEDGE_SECRET_KEY
    || env.MAGCLAW_SESSION_SECRET
    || env.MAGCLAW_AUTH_SECRET
    || 'magclaw-knowledge-space-local-dev',
  );
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
  if (Array.isArray(patch.whitelistHumanIds)) {
    space.settings.whitelistHumanIds = [...new Set(patch.whitelistHumanIds.map(cleanString).filter(Boolean))];
  }
  if (patch.feishu && typeof patch.feishu === 'object') {
    const feishu = space.settings.feishu;
    if (patch.feishu.appId !== undefined) feishu.appId = cleanString(patch.feishu.appId);
    if (patch.feishu.chatId !== undefined) feishu.chatId = cleanString(patch.feishu.chatId);
    if (patch.feishu.appSecret !== undefined) {
      const secret = cleanString(patch.feishu.appSecret);
      if (secret) {
        feishu.appSecretEncrypted = encryptKnowledgeSecret(secret, env);
        feishu.appSecretConfiguredAt = timestamp;
      }
    }
    feishu.updatedAt = timestamp;
  }
  space.updatedAt = timestamp;
  return { space, settings: publicKnowledgeSpace(space, actor).settings };
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
      title: { tag: 'plain_text', content: 'MagClaw Knowledge Space Published' },
    },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `**${session.summary || 'Knowledge update'}**` } },
      { tag: 'div', text: { tag: 'lark_md', content: docTitles.map((title) => `- ${title}`).join('\n') || '- No documents listed' } },
      ...(publicBaseUrl ? [{ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: 'Open publish link' }, url, type: 'primary' }] }] : []),
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
