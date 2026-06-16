let knowledgeGraphRuntime = null;
let knowledgeGraphRenderQueued = false;
let knowledgeGraphWindowEventsBound = false;
let knowledgeGraphAnimationToken = 0;
const KNOWLEDGE_GRAPH_CLICK_MOVE_LIMIT = 6;

function knowledgeSpace() {
  return knowledgeSpaceState?.data?.space || null;
}

function knowledgeDocs() {
  return knowledgeSpace()?.documents || [];
}

function knowledgeSessions() {
  return knowledgeSpace()?.changeSessions || [];
}

function knowledgeSelectedDoc() {
  const docs = knowledgeDocs();
  const selectedId = knowledgeSpaceState?.selectedDocId || knowledgeRoute?.docId || docs[0]?.id || '';
  return docs.find((doc) => doc.id === selectedId) || docs[0] || null;
}

function knowledgeConsensusStorageKey() {
  const workspaceId = knowledgeSpace()?.workspaceId || knowledgeSpaceState?.data?.space?.workspaceId || 'local';
  return `magclawKnowledgeCollapsedConsensus:${workspaceId}`;
}

function knowledgeCollapsedConsensusIds() {
  try {
    const parsed = JSON.parse(localStorage.getItem(knowledgeConsensusStorageKey()) || '[]');
    return new Set(Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

function setKnowledgeCollapsedConsensusIds(ids) {
  try {
    localStorage.setItem(knowledgeConsensusStorageKey(), JSON.stringify([...ids].filter(Boolean)));
  } catch {}
}

function knowledgeConsensusGroups() {
  const space = knowledgeSpace();
  const docs = knowledgeDocs();
  const groupRows = Array.isArray(space?.consensusGroups) && space.consensusGroups.length
    ? space.consensusGroups
    : docs.filter((doc) => !doc.parentId).map((doc) => ({
      id: doc.consensusId || doc.id,
      rootDocId: doc.id,
      title: doc.title,
      updatedAt: doc.updatedAt,
    }));
  return groupRows.map((group) => {
    const root = docs.find((doc) => doc.id === group.rootDocId)
      || docs.find((doc) => doc.consensusId === group.id && !doc.parentId)
      || null;
    const children = docs.filter((doc) => doc.id !== root?.id && doc.consensusId === group.id);
    return {
      ...group,
      root,
      children,
      docCount: (root ? 1 : 0) + children.length,
    };
  }).filter((group) => group.root || group.children.length);
}

function expandKnowledgeConsensusForDoc(docId) {
  const doc = knowledgeDocs().find((item) => item.id === docId);
  const consensusId = doc?.consensusId || '';
  if (!consensusId) return;
  const collapsed = knowledgeCollapsedConsensusIds();
  if (!collapsed.has(consensusId)) return;
  collapsed.delete(consensusId);
  setKnowledgeCollapsedConsensusIds(collapsed);
}

async function loadKnowledgeSpace(options = {}) {
  const force = Boolean(options.force);
  if (knowledgeSpaceState.loading && !force) return knowledgeSpaceState.data;
  knowledgeSpaceState = { ...knowledgeSpaceState, loading: true, error: '' };
  if (force) render();
  try {
    const data = await api('/api/knowledge/space');
    const docs = data?.space?.documents || [];
    const selectedDocId = knowledgeRoute?.docId || knowledgeSpaceState.selectedDocId || docs[0]?.id || '';
    knowledgeSpaceState = {
      ...knowledgeSpaceState,
      loading: false,
      error: '',
      data,
      selectedDocId,
      tab: knowledgeRoute?.view || knowledgeSpaceState.tab || 'home',
    };
    return data;
  } catch (error) {
    knowledgeSpaceState = { ...knowledgeSpaceState, loading: false, error: error.message || 'Failed to load Knowledge Space.' };
    throw error;
  } finally {
    render();
  }
}

function ensureKnowledgeSpaceLoad() {
  if (knowledgeSpaceState.loading || knowledgeSpaceState.data) return;
  setTimeout(() => loadKnowledgeSpace().catch((error) => console.warn('Failed to load Knowledge Space:', error)), 0);
}

function knowledgeCanEdit() {
  return Boolean(knowledgeSpace()?.permissions?.canEdit);
}

function knowledgeCanAdmin() {
  return Boolean(knowledgeSpace()?.permissions?.canAdmin);
}

function knowledgeRouteTab() {
  const view = knowledgeRoute?.view || knowledgeSpaceState.tab || 'home';
  if (view === 'docs') return 'home';
  if (view === 'reviews') return 'reviews';
  return view;
}

function knowledgeScrollSnapshot() {
  if (activeView !== 'knowledge') return null;
  const docRail = document.querySelector('.knowledge-doc-rail');
  const reader = document.querySelector('.knowledge-reader');
  const settings = document.querySelector('.knowledge-settings');
  const selected = knowledgeSelectedDoc();
  return {
    tab: knowledgeRouteTab(),
    selectedDocId: knowledgeSpaceState?.selectedDocId || selected?.id || knowledgeRoute?.docId || '',
    docRailTop: docRail?.scrollTop || 0,
    readerTop: reader?.scrollTop || 0,
    settingsTop: settings?.scrollTop || 0,
  };
}

function restoreKnowledgeScroll(snapshot) {
  if (!snapshot || activeView !== 'knowledge') return;
  const docRail = document.querySelector('.knowledge-doc-rail');
  const reader = document.querySelector('.knowledge-reader');
  const settings = document.querySelector('.knowledge-settings');
  if (docRail) docRail.scrollTop = Number(snapshot.docRailTop || 0);
  const sameSelectedDocument = snapshot.selectedDocId === knowledgeSpaceState?.selectedDocId
    || snapshot.selectedDocId === knowledgeSelectedDoc()?.id;
  if (sameSelectedDocument && reader) reader.scrollTop = Number(snapshot.readerTop || 0);
  if (snapshot.tab === knowledgeRouteTab() && settings) settings.scrollTop = Number(snapshot.settingsTop || 0);
}

function renderKnowledgeMain() {
  ensureKnowledgeSpaceLoad();
  if (knowledgeSpaceState.loading && !knowledgeSpaceState.data) {
    return '<main class="knowledge-page"><div class="knowledge-loading">Loading Knowledge Space</div></main>';
  }
  if (knowledgeSpaceState.error && !knowledgeSpaceState.data) {
    return `<main class="knowledge-page"><div class="knowledge-error">${escapeHtml(knowledgeSpaceState.error)}</div></main>`;
  }
  const tab = knowledgeRouteTab();
  const body = tab === 'graph'
    ? renderKnowledgeGraphPanel()
    : tab === 'changelog'
      ? renderKnowledgeChangelog()
      : tab === 'reviews'
        ? renderKnowledgeReview()
        : renderKnowledgeHome();
  return `
    <main class="knowledge-page">
      <header class="knowledge-topbar">
        <div>
          <p>Server Knowledge</p>
          <h1>${escapeHtml(knowledgeSpace()?.title || 'Knowledge Space')}</h1>
        </div>
        <nav class="knowledge-tabs" aria-label="Knowledge Space sections">
          ${renderKnowledgeTab('home', 'Documents')}
          ${renderKnowledgeTab('graph', 'Graph')}
          ${renderKnowledgeTab('changelog', 'Change Log')}
          ${renderKnowledgeTab('reviews', 'Reviews')}
          ${knowledgeCanAdmin() ? renderKnowledgeTab('settings', 'Settings') : ''}
        </nav>
      </header>
      ${tab === 'settings' ? renderKnowledgeSettingsShell() : body}
    </main>
  `;
}

function renderKnowledgeTab(tab, label) {
  const active = knowledgeRouteTab() === tab || (tab === 'home' && knowledgeRoute?.view === 'docs');
  return `<button class="${active ? 'active' : ''}" type="button" data-action="knowledge-tab" data-tab="${escapeHtml(tab)}">${escapeHtml(label)}</button>`;
}

function renderKnowledgeHome() {
  const docs = knowledgeDocs();
  const selected = knowledgeSelectedDoc();
  const groups = knowledgeConsensusGroups();
  const collapsed = knowledgeCollapsedConsensusIds();
  return `
    <section class="knowledge-layout">
      <aside class="knowledge-doc-rail">
        <div class="knowledge-doc-rail-head">
          <span>Outline</span>
          <strong>${docs.length}</strong>
        </div>
        <div class="knowledge-doc-list">
          ${groups.map((group) => renderKnowledgeConsensusGroup(group, selected?.id, knowledgeConsensusGroupCollapsed(group, selected, collapsed))).join('') || '<div class="knowledge-empty">No documents imported.</div>'}
        </div>
      </aside>
      <section class="knowledge-reader">
        ${selected ? renderKnowledgeDocument(selected.id) : renderKnowledgeEmptyState()}
      </section>
    </section>
  `;
}

function knowledgeConsensusGroupCollapsed(group, selected, collapsedIds) {
  if (!collapsedIds?.has?.(group.id)) return false;
  const selectedConsensusId = selected?.consensusId || '';
  if (selectedConsensusId !== group.id) return true;
  return Boolean(selected?.id && selected.id === group.root?.id);
}

function renderKnowledgeConsensusGroup(group, selectedId, collapsed = false) {
  const root = group.root;
  const title = root?.title || group.title || 'Consensus';
  const countLabel = `${group.docCount || 0}`;
  return `
    <section class="knowledge-consensus-group ${collapsed ? 'collapsed' : ''}" data-consensus-id="${escapeHtml(group.id)}">
      <div class="knowledge-consensus-root">
        <button class="knowledge-consensus-disclosure" type="button" data-action="knowledge-toggle-consensus" data-consensus-id="${escapeHtml(group.id)}" aria-label="${collapsed ? 'Expand' : 'Collapse'} ${escapeHtml(title)}">${collapsed ? '▸' : '▾'}</button>
        ${root ? renderKnowledgeDocListItem(root, selectedId, { root: true, countLabel }) : `<div class="knowledge-consensus-title"><span>${escapeHtml(title)}</span><small>${escapeHtml(countLabel)}</small></div>`}
      </div>
      ${collapsed ? '' : `<div class="knowledge-consensus-children">${group.children.map((doc) => renderKnowledgeDocListItem(doc, selectedId)).join('')}</div>`}
    </section>
  `;
}

function renderKnowledgeDocListItem(doc, selectedId, options = {}) {
  const level = Number(doc.level || 1);
  const badgeLabel = options.countLabel && level <= 1 ? `${options.countLabel} docs` : (level <= 1 ? 'Root' : `L${level}`);
  return `
    <button class="knowledge-doc-row ${doc.id === selectedId ? 'active' : ''} ${options.root ? 'knowledge-consensus-root-row' : ''} level-${level}" type="button" data-action="knowledge-select-doc" data-doc-id="${escapeHtml(doc.id)}">
      <span>${escapeHtml(doc.title)}</span>
      ${renderKnowledgeStatusBadge(level <= 1 ? 'root' : 'section', badgeLabel)}
      <small>${escapeHtml(doc.summary || '')}</small>
    </button>
  `;
}

function renderKnowledgeStatusBadge(status = 'draft', label = '') {
  const cleanStatus = String(status || 'draft').toLowerCase().replace(/[^a-z0-9_-]+/g, '-');
  const text = label || cleanStatus.replace(/[_-]+/g, ' ');
  return `<small class="knowledge-status-badge status-${escapeHtml(cleanStatus)}">${escapeHtml(text)}</small>`;
}

function renderKnowledgeEmptyState() {
  return `
    <div class="knowledge-empty-state">
      <h2>No consensus document yet</h2>
      <p>No Knowledge Space document is available yet.</p>
    </div>
  `;
}

function renderKnowledgeDocument(docId) {
  const cached = knowledgeSpaceState[`doc:${docId}`];
  if (!cached && !knowledgeSpaceState[`doc-loading:${docId}`]) {
    knowledgeSpaceState[`doc-loading:${docId}`] = true;
    setTimeout(() => loadKnowledgeDocument(docId).catch((error) => console.warn('Failed to load knowledge doc:', error)), 0);
  }
  if (!cached) return '<div class="knowledge-loading">Loading document</div>';
  const doc = cached.document;
  return `
    <article class="knowledge-document">
      <header>
        <div>
          <p>${escapeHtml(doc.level === 1 ? 'Root Consensus' : `Level ${doc.level}`)}</p>
          <h2>${escapeHtml(doc.title)}</h2>
        </div>
        <div class="knowledge-document-actions">
          ${doc.sourceUrl ? `<a href="${escapeHtml(doc.sourceUrl)}" target="_blank" rel="noreferrer noopener">Source</a>` : ''}
          <button type="button" data-action="knowledge-open-agent-link" data-doc-id="${escapeHtml(doc.id)}">Copy Link to Agent</button>
        </div>
      </header>
      ${renderKnowledgeDocumentMeta(doc)}
      ${renderKnowledgeDocumentBody(doc)}
    </article>
  `;
}

function renderKnowledgeDocumentMeta(doc = {}) {
  return `
    <div class="knowledge-document-meta" aria-label="Knowledge document metadata">
      ${renderKnowledgeStatusBadge(Number(doc.level || 1) <= 1 ? 'root' : 'section', Number(doc.level || 1) <= 1 ? 'Root consensus' : `Level ${Number(doc.level || 1)}`)}
      <span>Updated ${escapeHtml(doc.updatedAt || '')}</span>
      <span>Current version ${escapeHtml(doc.currentVersionId || 'unknown')}</span>
      ${doc.sourceUrl ? '<span>Source linked</span>' : '<span>Markdown source</span>'}
    </div>
  `;
}

function renderKnowledgeDocumentBody(doc = {}) {
  return `
    <div class="knowledge-html">
      ${doc.renderedHtml || ''}
      ${renderKnowledgeChildDocumentLinks(doc)}
    </div>
  `;
}

function renderKnowledgeChildDocumentLinks(doc = {}) {
  const childDocuments = Array.isArray(doc.childDocuments) ? doc.childDocuments : [];
  if (Number(doc.level || 1) > 1 || !childDocuments.length) return '';
  return `
    <nav class="knowledge-child-doc-links" aria-label="Knowledge document hierarchy">
      ${childDocuments.map((child) => `
        <a href="${escapeHtml(currentKnowledgeDocPath(child))}" data-action="knowledge-select-doc" data-doc-id="${escapeHtml(child.id)}">
          <span>${escapeHtml(child.title)}</span>
          ${child.summary ? `<small>${escapeHtml(child.summary)}</small>` : ''}
        </a>
      `).join('')}
    </nav>
  `;
}

async function loadKnowledgeDocument(docId) {
  const data = await api(`/api/knowledge/docs/${encodeURIComponent(docId)}`);
  knowledgeSpaceState = {
    ...knowledgeSpaceState,
    [`doc:${docId}`]: data,
    [`doc-loading:${docId}`]: false,
  };
  render();
}

function currentKnowledgeDocPath(doc = knowledgeSelectedDoc()) {
  const serverSlug = encodeURIComponent(String(
    (typeof currentServerSlug === 'function' && currentServerSlug())
    || (typeof serverSlugFromPath === 'function' && serverSlugFromPath())
    || 'local',
  ).trim() || 'local');
  return doc?.id
    ? `/s/${serverSlug}/knowledge/docs/${encodeURIComponent(doc.id)}`
    : `/s/${serverSlug}/knowledge`;
}

function currentKnowledgePathFromHref(href = '') {
  const value = String(href || '');
  const match = value.match(/^\/s\/[^/]+(\/knowledge(?:[/?#].*)?)$/);
  if (!match) return value;
  const serverSlug = encodeURIComponent(String(
    (typeof currentServerSlug === 'function' && currentServerSlug())
    || (typeof serverSlugFromPath === 'function' && serverSlugFromPath())
    || 'local',
  ).trim() || 'local');
  return `/s/${serverSlug}${match[1]}`;
}

function currentKnowledgeDocUrl(doc = knowledgeSelectedDoc()) {
  const path = currentKnowledgeDocPath(doc);
  return `${window.location.origin}${path}`;
}

function knowledgeAgentLinkDoc() {
  const docId = knowledgeAgentLinkState.docId || knowledgeSelectedDoc()?.id || '';
  return knowledgeDocs().find((doc) => doc.id === docId) || knowledgeSelectedDoc();
}

function renderKnowledgeAgentLinkModal() {
  const doc = knowledgeAgentLinkDoc();
  const url = currentKnowledgeDocUrl(doc);
  const copied = Boolean(knowledgeAgentLinkState.copied);
  return `
    ${modalHeader('复制给 Agent', 'Knowledge Space')}
    <div class="knowledge-agent-link-modal">
      <p>这个链接可以发给同一 Server 里的 Agent 读取。Agent 需要有登录状态，并且有访问这台 Server 的权限。</p>
      <div class="knowledge-agent-link-value${copied ? ' copied' : ''}" aria-live="polite">
        <span>${escapeHtml(url)}</span>
        <button type="button" class="knowledge-agent-copy-button" data-action="knowledge-copy-agent-link" data-link="${escapeHtml(url)}">${copied ? '✓ Copied' : 'Copy'}</button>
      </div>
      <div class="modal-actions">
        <button type="button" class="primary-btn" data-action="close-modal">Done</button>
      </div>
    </div>
  `;
}

function renderKnowledgeMatches(matches) {
  if (!matches.length) return '<div class="knowledge-empty small">No matches.</div>';
  return `
    <div class="knowledge-match-list">
      ${matches.map((match) => `
        <a href="${escapeHtml(match.href || '#')}" data-action="knowledge-open-link">
          <strong>${escapeHtml(match.title)}</strong>
          <span>${escapeHtml(match.summary || '')}</span>
        </a>
      `).join('')}
    </div>
  `;
}

function knowledgeGraphSearchQuery() {
  return String(knowledgeSpaceState.graphSearchQuery || '').trim();
}

function renderKnowledgeGraphPanel() {
  setTimeout(() => loadKnowledgeGraph().catch((error) => console.warn('Failed to load graph:', error)), 0);
  const query = knowledgeGraphSearchQuery();
  return `
    <section class="knowledge-graph-panel">
      <div class="knowledge-graph-search">
        <input id="knowledge-graph-search" data-action="knowledge-graph-search" value="${escapeHtml(query)}" placeholder="Search nodes" autocomplete="off" spellcheck="false" />
        ${query ? '<button type="button" data-action="knowledge-graph-clear-search">Clear</button>' : ''}
      </div>
      <canvas id="knowledge-graph-canvas" width="1280" height="760" aria-label="Knowledge graph" style="touch-action: none"></canvas>
      <div class="knowledge-graph-tooltip" hidden></div>
      <div class="knowledge-graph-legend">
        <span><i class="blue"></i> Consensus hierarchy</span>
        <span><i class="green"></i> Strong consensus relation</span>
        <span><i class="red"></i> Leaf updated within 72h</span>
      </div>
    </section>
  `;
}

async function loadKnowledgeGraph() {
  const activeCanvas = document.querySelector('#knowledge-graph-canvas');
  const runtimeCanvasReady = knowledgeGraphRuntime?.canvas?.isConnected && knowledgeGraphRuntime.canvas === activeCanvas;
  if (runtimeCanvasReady && knowledgeGraphRuntime.loadedFor === (knowledgeSpace()?.updatedAt || '')) {
    queueKnowledgeGraphRender();
    return;
  }
  const data = await api('/api/knowledge/graph');
  setupKnowledgeGraph(data.graph || { nodes: [], edges: [] });
}

function setupKnowledgeGraph(graph) {
  const canvas = document.querySelector('#knowledge-graph-canvas');
  if (!canvas) return;
  knowledgeGraphRuntime?.resizeObserver?.disconnect?.();
  knowledgeGraphAnimationToken += 1;
  const { width, height } = measureKnowledgeGraphCanvas(canvas);
  const edges = graph.edges || [];
  const nodes = initialKnowledgeGraphNodes(graph.nodes || [], edges, width, height);
  knowledgeGraphRuntime = {
    loadedFor: knowledgeSpace()?.updatedAt || '',
    canvas,
    graph: { nodes, edges },
    width,
    height,
    scale: 1,
    panX: 0,
    panY: 0,
    hoveredId: '',
    searchFocusedId: '',
    draggingNode: null,
    panning: null,
    clickCandidate: null,
    tick: 0,
    resizeObserver: null,
  };
  if (window.ResizeObserver) {
    knowledgeGraphRuntime.resizeObserver = new ResizeObserver(() => resizeKnowledgeGraphCanvas());
    knowledgeGraphRuntime.resizeObserver.observe(canvas);
  }
  bindKnowledgeGraphEvents(canvas);
  focusKnowledgeGraphSearchResult({ recenter: false });
  animateKnowledgeGraph(knowledgeGraphAnimationToken);
}

function measureKnowledgeGraphCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(640, Math.floor(rect.width || canvas.clientWidth || 1280));
  const height = Math.max(420, Math.floor(rect.height || canvas.clientHeight || 760));
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  return { width, height };
}

function resizeKnowledgeGraphCanvas() {
  const rt = knowledgeGraphRuntime;
  if (!rt?.canvas?.isConnected) return;
  const previousWidth = rt.width;
  const previousHeight = rt.height;
  const { width, height } = measureKnowledgeGraphCanvas(rt.canvas);
  if (width === previousWidth && height === previousHeight) return;
  const shiftX = (width - previousWidth) / 2;
  const shiftY = (height - previousHeight) / 2;
  rt.width = width;
  rt.height = height;
  for (const node of rt.graph.nodes) {
    node.x += shiftX;
    node.y += shiftY;
    node.homeX = (node.homeX || node.x) + shiftX;
    node.homeY = (node.homeY || node.y) + shiftY;
  }
  rt.panX += shiftX;
  rt.panY += shiftY;
  queueKnowledgeGraphRender();
}

function initialKnowledgeGraphNodes(rawNodes, edges, width, height) {
  const centerX = width / 2;
  const centerY = height / 2;
  const minSize = Math.min(width, height);
  const nodes = rawNodes.map((node) => ({ ...node, x: centerX, y: centerY, vx: 0, vy: 0, homeX: centerX, homeY: centerY }));
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const spaceNode = nodes.find((node) => node.kind === 'space');
  const topDocuments = nodes.filter((node) => node.kind === 'document' && (!node.parentId || Number(node.level || 1) <= 1));
  const placedNodeIds = new Set();
  if (spaceNode) {
    spaceNode.graphHomeRole = 'root';
    placeKnowledgeNode(spaceNode, centerX, centerY);
    placedNodeIds.add(spaceNode.id);
  }

  const buckets = knowledgeGraphConsensusBuckets(nodes, topDocuments, byId);
  const totalWeight = buckets.reduce((sum, bucket) => sum + bucket.weight, 0) || 1;
  const rootRadius = topDocuments.length <= 1 ? 0 : Math.max(32, Math.min(minSize * 0.055, 56));
  const childRadius = Math.max(138, Math.min(minSize * 0.27, 212));
  const childAngleById = new Map();
  let angleCursor = -Math.PI / 2;

  for (const bucket of buckets) {
    const span = Math.PI * 2 * (bucket.weight / totalWeight);
    const gap = buckets.length > 1 ? Math.min(0.14, span * 0.07) : 0;
    const start = angleCursor + gap / 2;
    const end = angleCursor + span - gap / 2;
    const mid = start + (end - start) / 2;
    const root = bucket.root;
    if (root) {
      root.graphHomeRole = 'root';
      placeKnowledgeNode(root, centerX + Math.cos(mid) * rootRadius, centerY + Math.sin(mid) * rootRadius);
      placedNodeIds.add(root.id);
    }
    bucket.children.forEach((node, index) => {
      const progress = bucket.children.length <= 1 ? 0.5 : (index + 0.5) / bucket.children.length;
      const angle = start + (end - start) * progress;
      const ring = childRadius + ((index % 5) - 2) * 8;
      childAngleById.set(node.id, angle);
      placeKnowledgeNode(node, centerX + Math.cos(angle) * ring, centerY + Math.sin(angle) * ring);
      placedNodeIds.add(node.id);
    });
    angleCursor += span;
  }

  const anchorsByDoc = new Map();
  nodes.filter((node) => node.kind === 'anchor').forEach((node) => {
    const list = anchorsByDoc.get(node.docId) || [];
    list.push(node);
    anchorsByDoc.set(node.docId, list);
  });
  for (const [docId, anchors] of anchorsByDoc.entries()) {
    const parent = byId.get(docId);
    const parentX = parent?.x || centerX;
    const parentY = parent?.y || centerY;
    const parentAngle = childAngleById.get(docId) ?? Math.atan2(parentY - centerY, parentX - centerX);
    anchors.forEach((node, index) => {
      const spread = anchors.length <= 1 ? 0 : (index / (anchors.length - 1) - 0.5) * Math.PI * 0.9;
      const angle = parentAngle + spread;
      const radius = 44 + (index % 4) * 9;
      placeKnowledgeNode(node, parentX + Math.cos(angle) * radius, parentY + Math.sin(angle) * radius);
      placedNodeIds.add(node.id);
    });
  }

  nodes.filter((node) => !placedNodeIds.has(node.id) || !Number.isFinite(node.x)).forEach((node, index) => {
    const angle = (index / Math.max(1, nodes.length)) * Math.PI * 2;
    placeKnowledgeNode(node, centerX + Math.cos(angle) * childRadius, centerY + Math.sin(angle) * childRadius);
    placedNodeIds.add(node.id);
  });

  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (source && target) {
      source.linkCount = (source.linkCount || 0) + 1;
      target.linkCount = (target.linkCount || 0) + 1;
    }
  }
  return nodes;
}

function knowledgeGraphConsensusBuckets(nodes, roots, byId) {
  const rootById = new Map(roots.map((root) => [root.id, root]));
  const rootByConsensus = new Map();
  for (const root of roots) rootByConsensus.set(root.consensusId || root.id, root);
  const buckets = roots.map((root) => ({
    id: root.consensusId || root.id,
    root,
    children: [],
    weight: 1,
  }));
  const bucketById = new Map(buckets.map((bucket) => [bucket.id, bucket]));
  const fallback = buckets[0] || { id: 'unassigned', root: null, children: [], weight: 1 };
  if (!buckets.length) buckets.push(fallback);

  for (const node of nodes) {
    if (node.kind !== 'document' || !node.parentId || Number(node.level || 1) <= 1) continue;
    const parent = byId.get(node.parentId);
    const root = rootByConsensus.get(node.consensusId || parent?.consensusId || '') || rootById.get(parent?.id || '') || fallback.root;
    const bucketId = root?.consensusId || root?.id || fallback.id;
    const bucket = bucketById.get(bucketId) || fallback;
    bucket.children.push(node);
  }

  for (const bucket of buckets) {
    bucket.children.sort((left, right) => String(left.createdAt || '').localeCompare(String(right.createdAt || '')) || String(left.title || '').localeCompare(String(right.title || '')));
    bucket.weight = Math.max(2.6, bucket.children.length + 1.4);
  }
  return buckets;
}

function placeKnowledgeNode(node, x, y) {
  node.x = x;
  node.y = y;
  node.homeX = x;
  node.homeY = y;
}

function bindKnowledgeGraphEvents(canvas) {
  if (canvas.dataset.knowledgeBound) return;
  canvas.dataset.knowledgeBound = '1';
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());
  canvas.addEventListener('wheel', (event) => {
    if (!knowledgeGraphRuntime) return;
    event.preventDefault();
    const rt = knowledgeGraphRuntime;
    const rect = canvas.getBoundingClientRect();
    const before = graphPointer(event);
    const factor = event.deltaY < 0 ? 1.08 : 0.92;
    rt.scale = Math.max(0.26, Math.min(5, rt.scale * factor));
    rt.panX = event.clientX - rect.left - before.x * rt.scale;
    rt.panY = event.clientY - rect.top - before.y * rt.scale;
    queueKnowledgeGraphRender();
  }, { passive: false });
  canvas.addEventListener('mousedown', (event) => {
    if (!knowledgeGraphRuntime) return;
    event.preventDefault();
    const point = graphPointer(event);
    const node = nearestKnowledgeNode(point.x, point.y, 10 / knowledgeGraphRuntime.scale);
    knowledgeGraphRuntime.clickCandidate = node?.href && event.button === 0
      ? { nodeId: node.id, href: node.href, x: event.clientX, y: event.clientY }
      : null;
    if (node && event.button === 0) {
      knowledgeGraphRuntime.draggingNode = node;
      node.fx = point.x;
      node.fy = point.y;
      node.vx = 0;
      node.vy = 0;
    } else {
      knowledgeGraphRuntime.clickCandidate = null;
      knowledgeGraphRuntime.panning = { x: event.clientX, y: event.clientY, panX: knowledgeGraphRuntime.panX, panY: knowledgeGraphRuntime.panY };
    }
  });
  canvas.addEventListener('mouseleave', () => {
    if (!knowledgeGraphRuntime || knowledgeGraphRuntime.panning || knowledgeGraphRuntime.draggingNode) return;
    knowledgeGraphRuntime.hoveredId = '';
    canvas.style.cursor = '';
    updateKnowledgeGraphTooltip();
    queueKnowledgeGraphRender();
  });
  canvas.addEventListener('touchstart', (event) => {
    if (!knowledgeGraphRuntime || !event.touches?.length) return;
    event.preventDefault();
    const touch = event.touches[0];
    const point = graphPointer(touch);
    const node = nearestKnowledgeNode(point.x, point.y, 12 / knowledgeGraphRuntime.scale);
    knowledgeGraphRuntime.clickCandidate = node?.href
      ? { nodeId: node.id, href: node.href, x: touch.clientX, y: touch.clientY }
      : null;
    if (node) {
      knowledgeGraphRuntime.draggingNode = node;
      node.fx = point.x;
      node.fy = point.y;
      node.vx = 0;
      node.vy = 0;
    } else {
      knowledgeGraphRuntime.panning = { x: touch.clientX, y: touch.clientY, panX: knowledgeGraphRuntime.panX, panY: knowledgeGraphRuntime.panY };
    }
  }, { passive: false });
  canvas.addEventListener('touchmove', (event) => {
    if (!knowledgeGraphRuntime || !event.touches?.length) return;
    event.preventDefault();
    const touch = event.touches[0];
    const point = graphPointer(touch);
    if (knowledgeGraphRuntime.clickCandidate) {
      const moved = Math.hypot(touch.clientX - knowledgeGraphRuntime.clickCandidate.x, touch.clientY - knowledgeGraphRuntime.clickCandidate.y);
      if (moved > KNOWLEDGE_GRAPH_CLICK_MOVE_LIMIT) knowledgeGraphRuntime.clickCandidate = null;
    }
    if (knowledgeGraphRuntime.draggingNode) {
      knowledgeGraphRuntime.draggingNode.fx = point.x;
      knowledgeGraphRuntime.draggingNode.fy = point.y;
      return;
    }
    if (knowledgeGraphRuntime.panning) {
      const pan = knowledgeGraphRuntime.panning;
      knowledgeGraphRuntime.panX = pan.panX + touch.clientX - pan.x;
      knowledgeGraphRuntime.panY = pan.panY + touch.clientY - pan.y;
      queueKnowledgeGraphRender();
    }
  }, { passive: false });
  canvas.addEventListener('touchend', (event) => {
    if (!knowledgeGraphRuntime) return;
    const touch = event.changedTouches?.[0];
    const candidate = knowledgeGraphRuntime.clickCandidate;
    if (candidate && touch) {
      const movement = Math.hypot(touch.clientX - candidate.x, touch.clientY - candidate.y);
      if (movement <= KNOWLEDGE_GRAPH_CLICK_MOVE_LIMIT) window.location.assign(currentKnowledgePathFromHref(candidate.href));
    }
    knowledgeGraphRuntime.clickCandidate = null;
    if (knowledgeGraphRuntime.draggingNode) {
      delete knowledgeGraphRuntime.draggingNode.fx;
      delete knowledgeGraphRuntime.draggingNode.fy;
      knowledgeGraphRuntime.draggingNode = null;
    }
    knowledgeGraphRuntime.panning = null;
  });
  if (!knowledgeGraphWindowEventsBound) {
    knowledgeGraphWindowEventsBound = true;
    window.addEventListener('mouseup', (event) => {
      if (!knowledgeGraphRuntime) return;
      const candidate = knowledgeGraphRuntime.clickCandidate;
      if (candidate && event.button === 0) {
        const movement = Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y);
        const point = graphPointer(event);
        const node = point.inside ? nearestKnowledgeNode(point.x, point.y, 14 / (knowledgeGraphRuntime.scale || 1)) : null;
        if (movement <= KNOWLEDGE_GRAPH_CLICK_MOVE_LIMIT && node?.id === candidate.nodeId) {
          window.location.assign(currentKnowledgePathFromHref(candidate.href));
        }
      }
      knowledgeGraphRuntime.clickCandidate = null;
      if (knowledgeGraphRuntime.draggingNode) {
        delete knowledgeGraphRuntime.draggingNode.fx;
        delete knowledgeGraphRuntime.draggingNode.fy;
        knowledgeGraphRuntime.draggingNode = null;
      }
      knowledgeGraphRuntime.panning = null;
      if (knowledgeGraphRuntime.canvas?.isConnected) knowledgeGraphRuntime.canvas.style.cursor = knowledgeGraphRuntime.hoveredId ? 'pointer' : '';
    });
    window.addEventListener('mousemove', (event) => {
      if (!knowledgeGraphRuntime) return;
      const point = graphPointer(event);
      if (knowledgeGraphRuntime.clickCandidate) {
        const moved = Math.hypot(event.clientX - knowledgeGraphRuntime.clickCandidate.x, event.clientY - knowledgeGraphRuntime.clickCandidate.y);
        if (moved > KNOWLEDGE_GRAPH_CLICK_MOVE_LIMIT) knowledgeGraphRuntime.clickCandidate = null;
      }
      if (knowledgeGraphRuntime.draggingNode) {
        knowledgeGraphRuntime.draggingNode.fx = point.x;
        knowledgeGraphRuntime.draggingNode.fy = point.y;
        if (knowledgeGraphRuntime.canvas?.isConnected) knowledgeGraphRuntime.canvas.style.cursor = 'grabbing';
        return;
      }
      if (knowledgeGraphRuntime.panning) {
        const pan = knowledgeGraphRuntime.panning;
        knowledgeGraphRuntime.panX = pan.panX + event.clientX - pan.x;
        knowledgeGraphRuntime.panY = pan.panY + event.clientY - pan.y;
        if (knowledgeGraphRuntime.canvas?.isConnected) knowledgeGraphRuntime.canvas.style.cursor = 'grabbing';
        queueKnowledgeGraphRender();
        return;
      }
      if (!point.inside) {
        knowledgeGraphRuntime.hoveredId = '';
        if (knowledgeGraphRuntime.canvas?.isConnected) knowledgeGraphRuntime.canvas.style.cursor = '';
        updateKnowledgeGraphTooltip();
        queueKnowledgeGraphRender();
        return;
      }
      const hovered = nearestKnowledgeNode(point.x, point.y, 9 / knowledgeGraphRuntime.scale);
      knowledgeGraphRuntime.hoveredId = hovered?.id || '';
      if (knowledgeGraphRuntime.canvas?.isConnected) knowledgeGraphRuntime.canvas.style.cursor = hovered?.href ? 'pointer' : '';
      updateKnowledgeGraphTooltip(point.localX, point.localY, hovered);
      queueKnowledgeGraphRender();
    });
    window.addEventListener('resize', () => resizeKnowledgeGraphCanvas());
  }
  canvas.addEventListener('dblclick', (event) => {
    const point = graphPointer(event);
    const node = nearestKnowledgeNode(point.x, point.y, 14 / (knowledgeGraphRuntime?.scale || 1));
    if (node?.href) window.location.assign(currentKnowledgePathFromHref(node.href));
  });
}

function graphPointer(event) {
  const rt = knowledgeGraphRuntime;
  const rect = rt.canvas.getBoundingClientRect();
  const localX = event.clientX - rect.left;
  const localY = event.clientY - rect.top;
  return {
    x: (localX - rt.panX) / rt.scale,
    y: (localY - rt.panY) / rt.scale,
    localX,
    localY,
    inside: localX >= 0 && localY >= 0 && localX <= rect.width && localY <= rect.height,
  };
}

function nearestKnowledgeNode(x, y, padding = 0) {
  const rt = knowledgeGraphRuntime;
  if (!rt) return null;
  let best = null;
  let bestDistance = Infinity;
  for (const node of rt.graph.nodes) {
    const distance = Math.hypot(node.x - x, node.y - y);
    if (distance < bestDistance && distance <= (node.radius || 4) + padding) {
      best = node;
      bestDistance = distance;
    }
  }
  return best;
}

function knowledgeGraphSearchMatch(query = knowledgeGraphSearchQuery()) {
  const rt = knowledgeGraphRuntime;
  const clean = String(query || '').trim().toLowerCase();
  if (!rt || !clean) return null;
  return rt.graph.nodes.find((node) => String(node.title || '').toLowerCase().includes(clean))
    || rt.graph.nodes.find((node) => String(node.summary || '').toLowerCase().includes(clean))
    || null;
}

function focusKnowledgeGraphSearchResult(options = {}) {
  const rt = knowledgeGraphRuntime;
  if (!rt) return;
  const node = knowledgeGraphSearchMatch();
  rt.searchFocusedId = node?.id || '';
  if (node) {
    rt.hoveredId = node.id;
    if (options.recenter !== false) {
      rt.panX = rt.width / 2 - node.x * rt.scale;
      rt.panY = rt.height / 2 - node.y * rt.scale;
    }
  } else if (!knowledgeGraphSearchQuery()) {
    rt.searchFocusedId = '';
  }
  updateKnowledgeGraphTooltip();
  queueKnowledgeGraphRender();
}

function updateKnowledgeGraphTooltip(localX = null, localY = null, node = null) {
  const rt = knowledgeGraphRuntime;
  const tooltip = document.querySelector('.knowledge-graph-tooltip');
  if (!tooltip || !rt) return;
  const activeNode = node || rt.graph.nodes.find((item) => item.id === rt.hoveredId || item.id === rt.searchFocusedId);
  if (!activeNode) {
    tooltip.hidden = true;
    return;
  }
  const x = Number.isFinite(localX) ? localX : activeNode.x * rt.scale + rt.panX;
  const y = Number.isFinite(localY) ? localY : activeNode.y * rt.scale + rt.panY;
  tooltip.hidden = false;
  tooltip.style.left = `${Math.min(rt.width - 220, Math.max(12, x + 14))}px`;
  tooltip.style.top = `${Math.min(rt.height - 96, Math.max(12, y + 14))}px`;
  const semanticReason = rt.graph.edges.find((edge) => (
    edge.kind === 'semantic'
    && (edge.source === activeNode.id || edge.target === activeNode.id)
    && edge.metadata?.reason
  ))?.metadata?.reason || '';
  tooltip.innerHTML = `
    <strong>${escapeHtml(activeNode.title || 'Knowledge node')}</strong>
    <span>${escapeHtml(activeNode.summary || activeNode.kind || '')}</span>
    ${semanticReason ? `<span>${escapeHtml(semanticReason)}</span>` : ''}
  `;
}

function animateKnowledgeGraph(token) {
  if (token !== knowledgeGraphAnimationToken || !knowledgeGraphRuntime?.canvas?.isConnected) return;
  stepKnowledgeGraph();
  drawKnowledgeGraph();
  window.requestAnimationFrame(() => animateKnowledgeGraph(token));
}

function stepKnowledgeGraph() {
  const rt = knowledgeGraphRuntime;
  const nodes = rt.graph.nodes;
  const byId = new Map(nodes.map((node) => [node.id, node]));
  for (const edge of rt.graph.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    const dx = target.x - source.x;
    const dy = target.y - source.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    const desired = desiredKnowledgeEdgeLength(edge, source, target);
    const force = (distance - desired) * knowledgeEdgeSpring(edge);
    const fx = dx / distance * force;
    const fy = dy / distance * force;
    source.vx += fx;
    source.vy += fy;
    target.vx -= fx;
    target.vy -= fy;
  }
  for (let i = 0; i < nodes.length; i += 1) {
    for (let j = i + 1; j < nodes.length; j += 1) {
      const a = nodes[i];
      const b = nodes[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.max(6, Math.hypot(dx, dy));
      const minimum = (a.radius || 3) + (b.radius || 3) + 10;
      if (distance > 150 && distance > minimum) continue;
      const force = distance < minimum ? (minimum - distance) * 0.024 : 14 / (distance * distance);
      const fx = dx / distance * force;
      const fy = dy / distance * force;
      a.vx -= fx;
      a.vy -= fy;
      b.vx += fx;
      b.vy += fy;
    }
  }
  for (const node of nodes) {
    const cx = rt.width / 2;
    const cy = rt.height / 2;
    const homeStrength = node.kind === 'space' || node.graphHomeRole === 'root' ? 0.021 : node.kind === 'document' ? 0.0022 : 0.001;
    node.vx += ((node.homeX || cx) - node.x) * homeStrength;
    node.vy += ((node.homeY || cy) - node.y) * homeStrength;
    node.vx += (cx - node.x) * 0.00036;
    node.vy += (cy - node.y) * 0.00036;
    applyKnowledgeGraphBounds(rt, node);
    if (node.fx != null) {
      node.x = node.fx;
      node.y = node.fy;
      node.vx = 0;
      node.vy = 0;
    } else {
      node.vx *= 0.82;
      node.vy *= 0.82;
      node.x += node.vx;
      node.y += node.vy;
    }
  }
}

function desiredKnowledgeEdgeLength(edge, source, target) {
  if (edge.kind === 'root') return 88;
  if (edge.kind === 'hierarchy') return 112 + Math.max(0, Number(target.level || 2) - 2) * 10;
  if (edge.kind === 'anchor') return 48;
  if (edge.kind === 'semantic') return 104;
  return 126 + Math.min(24, Math.max(source.degree || 0, target.degree || 0) * 2);
}

function knowledgeEdgeSpring(edge) {
  if (edge.kind === 'semantic') return 0.0088;
  if (edge.kind === 'anchor') return 0.0052;
  return 0.0058;
}

function applyKnowledgeGraphBounds(rt, node) {
  const padding = 42;
  const strength = 0.003;
  if (node.x < padding) node.vx += (padding - node.x) * strength;
  if (node.y < padding) node.vy += (padding - node.y) * strength;
  if (node.x > rt.width - padding) node.vx -= (node.x - (rt.width - padding)) * strength;
  if (node.y > rt.height - padding) node.vy -= (node.y - (rt.height - padding)) * strength;
}

function queueKnowledgeGraphRender() {
  if (knowledgeGraphRenderQueued) return;
  knowledgeGraphRenderQueued = true;
  window.requestAnimationFrame(() => {
    knowledgeGraphRenderQueued = false;
    drawKnowledgeGraph();
  });
}

function drawKnowledgeGraph() {
  const rt = knowledgeGraphRuntime;
  if (!rt?.canvas?.isConnected) return;
  const ctx = rt.canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rt.width, rt.height);
  ctx.save();
  ctx.translate(rt.panX, rt.panY);
  ctx.scale(rt.scale, rt.scale);
  const neighbors = new Set();
  const focusId = rt.hoveredId || rt.searchFocusedId;
  if (focusId) {
    neighbors.add(focusId);
    for (const edge of rt.graph.edges) {
      if (edge.source === focusId) neighbors.add(edge.target);
      if (edge.target === focusId) neighbors.add(edge.source);
    }
  }
  const dim = focusId ? 0.12 : 1;
  const byId = new Map(rt.graph.nodes.map((node) => [node.id, node]));
  for (const edge of rt.graph.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    const active = !focusId || (neighbors.has(source.id) && neighbors.has(target.id));
    ctx.strokeStyle = active ? knowledgeEdgeColor(edge) : `rgba(86, 99, 110, ${0.13 * dim})`;
    ctx.lineWidth = (edge.kind === 'semantic' ? (active ? 1.28 : 0.62) : (active ? 0.92 : 0.48)) / Math.sqrt(rt.scale);
    ctx.setLineDash(edge.kind === 'semantic' ? [7 / Math.sqrt(rt.scale), 5 / Math.sqrt(rt.scale)] : []);
    ctx.beginPath();
    ctx.moveTo(source.x, source.y);
    ctx.lineTo(target.x, target.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  for (const node of rt.graph.nodes) {
    const active = !focusId || neighbors.has(node.id);
    ctx.globalAlpha = active ? (node.kind === 'space' ? 0.76 : 0.68) : 0.13;
    ctx.fillStyle = knowledgeNodeColor(node);
    ctx.beginPath();
    ctx.arc(node.x, node.y, Math.max(2.4, node.radius || 3), 0, Math.PI * 2);
    ctx.fill();
    if (active && node.kind !== 'anchor') {
      ctx.globalAlpha = 0.24;
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.4 / Math.sqrt(rt.scale);
      ctx.stroke();
    }
  }
  for (const node of rt.graph.nodes) {
    const active = !focusId || neighbors.has(node.id);
    if (active && shouldShowKnowledgeNodeLabel(rt, node)) drawKnowledgeNodeLabel(ctx, rt, node);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

function knowledgeEdgeColor(edge) {
  if (edge.kind === 'root' || edge.kind === 'hierarchy') return 'rgba(64, 120, 166, 0.22)';
  if (edge.kind === 'anchor') return 'rgba(88, 103, 113, 0.18)';
  if (edge.kind === 'semantic') return 'rgba(40, 150, 125, 0.36)';
  return 'rgba(72, 135, 190, 0.28)';
}

function knowledgeNodeColor(node) {
  if (node.colorRole === 'recent_leaf') return 'rgba(232, 82, 86, 0.72)';
  if (node.kind === 'space') return 'rgba(44, 132, 190, 0.78)';
  if (node.kind === 'document' && (node.consensusRole === 'root' || Number(node.level || 1) <= 1)) return 'rgba(44, 132, 190, 0.72)';
  return 'rgba(53, 143, 199, 0.64)';
}

function shouldShowKnowledgeNodeLabel(rt, node) {
  if (rt.hoveredId === node.id) return true;
  if (node.kind === 'space') return rt.scale > 0.92;
  if (node.kind === 'document') return rt.scale > 1.32 || (Number(node.level || 2) <= 1 && rt.scale > 1.08);
  return rt.scale > 1.72;
}

function drawKnowledgeNodeLabel(ctx, rt, node) {
  const radius = Math.max(2.4, node.radius || 3);
  const fontSize = Math.max(10.5, Math.min(13, 12 / Math.sqrt(Math.max(0.75, rt.scale))));
  const text = String(node.title || '').slice(0, 52);
  const x = node.x + radius + 5;
  const y = node.y + 4;
  ctx.font = `${fontSize}px ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont`;
  ctx.lineWidth = 3.5 / Math.sqrt(rt.scale);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.78)';
  ctx.globalAlpha = rt.hoveredId === node.id ? 0.98 : 0.82;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = 'rgba(43, 51, 57, 0.84)';
  ctx.fillText(text, x, y);
}

function renderKnowledgeChangelog() {
  const groups = knowledgeSpace()?.changelogGroups || [];
  const events = knowledgeSpace()?.changelogEvents || [];
  const sorted = [...groups].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))).slice(0, 100);
  return `
    <section class="knowledge-changelog">
      ${sorted.map((group) => {
        const groupEvents = events.filter((event) => event.changeSessionId === group.changeSessionId)
          .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
        return `
          <article class="knowledge-log-group status-${escapeHtml(group.status || 'draft')}">
            <header>
              <span class="knowledge-log-dot"></span>
              <div>
                <h2>${escapeHtml(group.title || 'Knowledge change')}</h2>
                <p>${escapeHtml(group.updatedAt || '')}</p>
              </div>
              ${renderKnowledgeStatusBadge(group.status || 'draft')}
              <button type="button" data-action="knowledge-open-review" data-session-id="${escapeHtml(group.changeSessionId)}">Open</button>
            </header>
            ${groupEvents.map(renderKnowledgeLogEvent).join('')}
          </article>
        `;
      }).join('') || '<div class="knowledge-empty-state"><h2>No Change Log yet</h2><p>Drafts, diffs, previews, publishes, conflicts, and notification attempts will appear here.</p></div>'}
    </section>
  `;
}

function renderKnowledgeLogEvent(event) {
  return `
    <div class="knowledge-log-event color-${escapeHtml(event.color || 'gray')}" style="--indent:${Number(event.indent || 0)}">
      <strong>${escapeHtml(event.title || event.type)}</strong>
      <span>${escapeHtml(event.detail || '')}</span>
    </div>
  `;
}

function renderKnowledgeReview() {
  const sessionId = knowledgeRoute?.changeSessionId || knowledgeSessions()[0]?.id || '';
  const session = knowledgeSessions().find((item) => item.id === sessionId) || knowledgeSessions()[0] || null;
  if (!session) {
    return '<section class="knowledge-review"><div class="knowledge-empty-state"><h2>No reviews yet</h2><p>Create a draft from a document to enter the diff and preview flow.</p></div></section>';
  }
  const isPublished = session.status === 'published';
  return `
    <section class="knowledge-review">
      <header class="knowledge-review-head">
        <div>
          <p>${escapeHtml(session.status)}${session.conflict ? ' · conflict' : ''} · ${escapeHtml(session.actorHumanId || 'unknown actor')}</p>
          <h2>${escapeHtml(session.summary || 'Knowledge review')}</h2>
          <span>${escapeHtml(reviewImpactSummary(session))}</span>
        </div>
        <div class="knowledge-review-actions">
          ${session.status === 'draft' && knowledgeCanEdit() ? `<button type="button" data-action="knowledge-review-action" data-next="to-diff" data-session-id="${escapeHtml(session.id)}">View Diff</button>` : ''}
          ${session.status === 'diff' && knowledgeCanEdit() ? `<button type="button" data-action="knowledge-review-action" data-next="to-preview" data-session-id="${escapeHtml(session.id)}">Preview</button>` : ''}
          ${session.status === 'preview' && knowledgeCanEdit() ? `<button type="button" data-action="knowledge-review-action" data-next="to-diff" data-session-id="${escapeHtml(session.id)}">Back to Diff</button>` : ''}
          ${session.status === 'preview' && knowledgeCanEdit() ? `<button type="button" data-action="knowledge-open-publish-confirm" data-next="publish" data-session-id="${escapeHtml(session.id)}">Publish</button>` : ''}
          ${isPublished ? `<button type="button" data-action="knowledge-review-action" data-next="retry-notification" data-session-id="${escapeHtml(session.id)}">Retry Feishu</button>` : ''}
        </div>
      </header>
      ${session.conflict ? renderKnowledgeConflict(session) : ''}
      ${(session.changes || []).map((change) => renderKnowledgeReviewChange(change, session.status)).join('')}
      ${isPublished ? '<div class="knowledge-immutable-note">Published links are immutable read-only history.</div>' : ''}
    </section>
  `;
}

function reviewImpactSummary(session) {
  const changes = session.changes || [];
  const titles = changes.map((change) => knowledgeDocs().find((item) => item.id === change.docId)?.title || change.docId);
  if (!titles.length) return 'No documents affected';
  return `Affects ${titles.length} document${titles.length === 1 ? '' : 's'}: ${titles.slice(0, 4).join(', ')}${titles.length > 4 ? '...' : ''}`;
}

function renderKnowledgeConflict(session) {
  return `
    <section class="knowledge-conflict">
      <h3>Conflict detected</h3>
      <p>Another published version changed one or more touched documents. Review the conflict diff, adjust through Codex/Agent, then move back through preview before publishing again.</p>
      ${(session.conflictDetails || []).map((conflict) => `
        <details open>
          <summary>${escapeHtml(conflict.docId)} · ${escapeHtml(conflict.reason)}</summary>
          ${conflict.conflictDiffHtml || ''}
        </details>
      `).join('')}
    </section>
  `;
}

function renderKnowledgeReviewChange(change, status) {
  const doc = knowledgeDocs().find((item) => item.id === change.docId) || { title: change.docId };
  return `
    <article class="knowledge-review-change">
      <h3>${escapeHtml(doc.title)}</h3>
      ${status === 'preview' || status === 'published'
        ? `<div class="knowledge-html preview">${change.proposedHtml || ''}</div>`
        : change.diffHtml || '<div class="knowledge-empty small">No diff available.</div>'}
    </article>
  `;
}

const KNOWLEDGE_ROLE_RANK = { owner: 3, admin: 2, member: 1 };

function knowledgeRoleRank(role) {
  return KNOWLEDGE_ROLE_RANK[String(role || 'member').toLowerCase()] || 0;
}

function sortedKnowledgeMembers(members = []) {
  return [...members].sort((a, b) => {
    const roleDelta = knowledgeRoleRank(b.role) - knowledgeRoleRank(a.role);
    if (roleDelta) return roleDelta;
    return String(a.name || a.email || a.id).localeCompare(String(b.name || b.email || b.id));
  });
}

function knowledgeMemberMap(members = []) {
  return new Map((members || []).filter((member) => member?.id).map((member) => [member.id, member]));
}

function knowledgeMemberFallback(humanId) {
  return { id: humanId, name: humanId, email: '', role: 'member' };
}

function renderKnowledgeRolePill(role) {
  const safeRole = String(role || 'member').toLowerCase();
  return `<small class="knowledge-role-pill role-${escapeHtml(safeRole)}">${escapeHtml(safeRole)}</small>`;
}

const KNOWLEDGE_SETTINGS_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'publishing', label: 'Publishing' },
  { id: 'notifications', label: 'Notifications' },
];

function normalizeKnowledgeSettingsTab(tab = 'overview') {
  const value = String(tab || 'overview').toLowerCase();
  return KNOWLEDGE_SETTINGS_TABS.some((item) => item.id === value) ? value : 'overview';
}

function currentKnowledgeSettingsTab() {
  return normalizeKnowledgeSettingsTab(knowledgeRoute?.settingsTab || 'overview');
}

function knowledgeFeishuConfigured(settings = {}) {
  const feishu = settings.feishu || {};
  return Boolean(feishu.appId || feishu.chatId || feishu.appSecretConfigured);
}

function renderKnowledgeSettingsTab(tab) {
  const active = currentKnowledgeSettingsTab() === tab.id;
  return `
    <button
      class="knowledge-settings-tab ${active ? 'active' : ''}"
      type="button"
      data-action="knowledge-settings-tab"
      data-settings-tab="${escapeHtml(tab.id)}"
      aria-current="${active ? 'page' : 'false'}"
    >${escapeHtml(tab.label)}</button>
  `;
}

function knowledgeSettingsAccessLabel() {
  if (knowledgeCanAdmin()) return 'Admin';
  if (knowledgeCanEdit()) return 'Editor';
  return 'Read only';
}

function renderKnowledgeSettingsShell() {
  const tab = currentKnowledgeSettingsTab();
  const settings = knowledgeSpace()?.settings || {};
  const members = knowledgeSpaceState?.data?.members || [];
  const whitelist = new Set(settings.whitelistHumanIds || []);
  const feishuReady = knowledgeFeishuConfigured(settings);
  return `
    <section class="knowledge-settings knowledge-settings-shell">
      <div class="knowledge-settings-hero">
        <div>
          <p>Knowledge Settings</p>
          <h2>Workspace controls</h2>
          <span>Manage publishing access and Feishu notifications for this Knowledge Space.</span>
        </div>
        <div class="knowledge-settings-hero-meta" aria-label="Knowledge settings status">
          <span>${escapeHtml(knowledgeSettingsAccessLabel())}</span>
          <span>${whitelist.size} publisher${whitelist.size === 1 ? '' : 's'}</span>
          <span>${feishuReady ? 'Feishu connected' : 'Feishu not configured'}</span>
        </div>
      </div>
      <nav class="knowledge-settings-tabs" aria-label="Knowledge settings sections">
        ${KNOWLEDGE_SETTINGS_TABS.map(renderKnowledgeSettingsTab).join('')}
      </nav>
      ${tab === 'publishing'
        ? renderKnowledgeWhitelistCard(members, whitelist)
        : tab === 'notifications'
          ? renderKnowledgeFeishuSettings(settings)
          : renderKnowledgeSettingsOverview(members, whitelist, settings)}
    </section>
  `;
}

function renderKnowledgeSettingsOverview(members, whitelist, settings) {
  const feishuReady = knowledgeFeishuConfigured(settings);
  const feishu = settings.feishu || {};
  return `
    <section class="knowledge-settings-section knowledge-settings-overview">
      <div class="knowledge-settings-summary" aria-label="Knowledge settings overview">
        <article>
          <span>Whitelisted publishers</span>
          <strong>${whitelist.size}</strong>
          <small>Can publish Knowledge Space changes</small>
        </article>
        <article>
          <span>Server members</span>
          <strong>${members.length}</strong>
          <small>Sorted by owner, admin, then member</small>
        </article>
        <article>
          <span>Feishu status</span>
          <strong>${feishuReady ? 'Ready' : 'Off'}</strong>
          <small>${feishuReady ? 'Notifications can be sent' : 'Add App ID, Chat ID, and secret'}</small>
        </article>
        <article>
          <span>Current access</span>
          <strong>${escapeHtml(knowledgeSettingsAccessLabel())}</strong>
          <small>${knowledgeCanAdmin() ? 'Full settings access' : 'Viewing current configuration'}</small>
        </article>
      </div>
      <div class="knowledge-settings-overview-grid">
        <article class="knowledge-settings-overview-card">
          <div>
            <p>Publishing</p>
            <h3>Control who can publish</h3>
            <span>Review the whitelist, add eligible server members, or remove stale access with confirmation.</span>
          </div>
          <button type="button" data-action="knowledge-settings-tab" data-settings-tab="publishing">Manage Publishing</button>
        </article>
        <article class="knowledge-settings-overview-card">
          <div>
            <p>Notifications</p>
            <h3>Configure Feishu delivery</h3>
            <span>${feishu.appSecretConfigured ? `Secret configured ${escapeHtml(feishu.appSecretConfiguredAt || '')}` : 'Set Feishu credentials before publishing notifications.'}</span>
          </div>
          <button type="button" data-action="knowledge-settings-tab" data-settings-tab="notifications">Manage Notifications</button>
        </article>
      </div>
    </section>
  `;
}

function renderKnowledgeWhitelistCard(members, whitelist) {
  const byId = knowledgeMemberMap(members);
  const selectedAddIds = new Set(knowledgeSettingsState.selectedAddIds || []);
  const whitelistRows = [...whitelist]
    .map((id) => byId.get(id) || knowledgeMemberFallback(id))
    .sort((a, b) => {
      const roleDelta = knowledgeRoleRank(b.role) - knowledgeRoleRank(a.role);
      if (roleDelta) return roleDelta;
      return String(a.name || a.email || a.id).localeCompare(String(b.name || b.email || b.id));
    });
  const candidateRows = sortedKnowledgeMembers(members);
  const selectedCount = candidateRows.filter((member) => selectedAddIds.has(member.id) && !whitelist.has(member.id)).length;
  return `
    <section class="knowledge-settings-section knowledge-whitelist-card">
      <header class="knowledge-settings-section-head">
        <div>
          <p>Publishing</p>
          <h2>Publishing Whitelist</h2>
          <span>Only whitelisted members can publish Knowledge Space changes.</span>
        </div>
        <button type="button" data-action="knowledge-toggle-add-members">${knowledgeSettingsState.addOpen ? 'Close' : 'Add Member'}</button>
      </header>
      <div class="knowledge-settings-mini-summary">
        <span><strong>${whitelistRows.length}</strong> whitelisted</span>
        <span><strong>${members.length}</strong> server members</span>
        <span><strong>${candidateRows.filter((member) => !whitelist.has(member.id)).length}</strong> available to add</span>
      </div>
      <div class="knowledge-whitelist-list">
        ${whitelistRows.map((member) => `
          <div class="knowledge-whitelist-row">
            <div class="knowledge-member-main">
              <strong>${escapeHtml(member.name || member.id)}</strong>
              ${member.email ? `<span>${escapeHtml(member.email)}</span>` : ''}
            </div>
            ${renderKnowledgeRolePill(member.role)}
            <button type="button" class="knowledge-row-delete" data-action="knowledge-request-remove-whitelist-member" data-human-id="${escapeHtml(member.id)}">Delete</button>
          </div>
        `).join('') || '<div class="knowledge-empty small">No whitelist members yet.</div>'}
      </div>
      ${knowledgeSettingsState.addOpen ? `
        <div class="knowledge-add-member-panel">
          <div class="knowledge-add-member-list">
            ${candidateRows.map((member) => {
              const alreadyAdded = whitelist.has(member.id);
              const selected = selectedAddIds.has(member.id) && !alreadyAdded;
              return `
                <label class="knowledge-add-member-row${alreadyAdded ? ' disabled' : ''}${selected ? ' selected' : ''}" data-action="knowledge-toggle-add-member" data-human-id="${escapeHtml(member.id)}">
                  <input type="checkbox" value="${escapeHtml(member.id)}" ${alreadyAdded || selected ? 'checked' : ''} ${alreadyAdded ? 'disabled' : ''} tabindex="-1" />
                  <span class="knowledge-add-check" aria-hidden="true">${alreadyAdded || selected ? '✓' : ''}</span>
                  <span class="knowledge-member-main">
                    <strong>${escapeHtml(member.name || member.id)}</strong>
                    ${member.email ? `<span>${escapeHtml(member.email)}</span>` : ''}
                  </span>
                  ${renderKnowledgeRolePill(member.role)}
                </label>
              `;
            }).join('') || '<div class="knowledge-empty small">No members found.</div>'}
          </div>
          <button class="knowledge-save-settings" type="button" data-action="knowledge-save-whitelist-additions" ${selectedCount ? '' : 'disabled'}>Save ${selectedCount ? `(${selectedCount})` : ''}</button>
        </div>
      ` : ''}
    </section>
  `;
}

function renderKnowledgeFeishuField(id, label, value, placeholder = '') {
  const displayValue = String(value || '');
  return `
    <label class="knowledge-field">
      <span>${escapeHtml(label)}</span>
      <input id="${escapeHtml(id)}" value="${escapeHtml(displayValue)}" data-masked-value="${escapeHtml(displayValue)}" placeholder="${escapeHtml(placeholder)}" autocomplete="off" spellcheck="false" />
    </label>
  `;
}

function renderKnowledgeFeishuSettings(settings) {
  const feishu = settings.feishu || {};
  const secretPlaceholder = feishu.appSecretMasked || (feishu.appSecretConfigured ? 'Secret configured' : 'App Secret');
  const ready = knowledgeFeishuConfigured(settings);
  return `
    <section class="knowledge-settings-section knowledge-feishu-card">
      <header class="knowledge-settings-section-head">
        <div>
          <p>Notifications</p>
          <h2>Feishu Notification</h2>
          <span>Keep publishing notifications scoped to this Knowledge Space.</span>
        </div>
        <small class="knowledge-settings-status ${ready ? 'ready' : 'muted'}">${ready ? 'Configured' : 'Not configured'}</small>
      </header>
      <div class="knowledge-feishu-status-note">
        ${ready ? 'Feishu delivery is configured. Leave unchanged fields as-is when updating one credential.' : 'Add the Feishu App ID, Chat ID, and App Secret to enable notifications.'}
      </div>
      ${renderKnowledgeFeishuField('knowledge-feishu-app-id', 'App ID', feishu.appId || '', 'App ID')}
      ${renderKnowledgeFeishuField('knowledge-feishu-chat-id', 'Chat ID', feishu.chatId || '', 'Chat ID')}
      <label class="knowledge-field">
        <span>App Secret</span>
        <input id="knowledge-feishu-secret" type="password" data-masked-value="${escapeHtml(feishu.appSecretMasked || '')}" placeholder="${escapeHtml(secretPlaceholder)}" autocomplete="new-password" />
      </label>
      <p>${feishu.appSecretConfigured ? `Secret configured ${escapeHtml(feishu.appSecretConfiguredAt || '')}` : 'No secret configured.'}</p>
      <button class="knowledge-save-settings" type="button" data-action="knowledge-save-settings">Save Feishu Settings</button>
    </section>
  `;
}

function renderKnowledgeSettings() {
  return renderKnowledgeSettingsShell();
}

function knowledgeFeishuPatchFromInputs() {
  const feishu = {};
  const readChangedInput = (selector, key) => {
    const input = document.querySelector(selector);
    if (!input) return;
    const value = String(input.value || '').trim();
    const maskedValue = String(input.dataset.maskedValue || '').trim();
    if (value && value !== maskedValue) feishu[key] = value;
  };
  readChangedInput('#knowledge-feishu-app-id', 'appId');
  readChangedInput('#knowledge-feishu-chat-id', 'chatId');
  readChangedInput('#knowledge-feishu-secret', 'appSecret');
  return feishu;
}

function knowledgeSettingsMemberById(humanId) {
  const members = knowledgeSpaceState?.data?.members || [];
  return knowledgeMemberMap(members).get(humanId) || knowledgeMemberFallback(humanId);
}

function renderKnowledgeWhitelistRemoveModal() {
  const humanId = knowledgeSettingsState.removeHumanId || '';
  if (!humanId) return '';
  const member = knowledgeSettingsMemberById(humanId);
  return `
    ${modalHeader('Remove Whitelist Member', 'Knowledge Space')}
    <div class="knowledge-remove-confirm">
      <strong>${escapeHtml(member.name || member.id)}</strong>
      ${member.email ? `<span>${escapeHtml(member.email)}</span>` : ''}
      <p>This member will no longer be able to publish Knowledge Space changes.</p>
    </div>
    <div class="modal-actions confirm-stop-actions">
      <button type="button" class="secondary-btn" data-action="close-modal">Cancel</button>
      <button type="button" class="primary-btn danger-btn" data-action="knowledge-confirm-remove-whitelist" data-human-id="${escapeHtml(humanId)}">Delete</button>
    </div>
  `;
}

function renderKnowledgePublishModal() {
  const sessionId = knowledgePublishState.sessionId || knowledgeRoute?.changeSessionId || '';
  const session = knowledgeSessions().find((item) => item.id === sessionId) || null;
  if (!session) return '';
  return `
    ${modalHeader('Publish Knowledge Update', 'Knowledge Space')}
    <div class="knowledge-publish-confirm">
      ${renderKnowledgeStatusBadge(session.status || 'preview')}
      <h3>${escapeHtml(session.summary || 'Knowledge review')}</h3>
      <p>This will publish the previewed Knowledge Space changes and mark this review immutable.</p>
      <div class="knowledge-publish-confirm-meta">
        <span>${escapeHtml(reviewImpactSummary(session))}</span>
        <span>Actor ${escapeHtml(session.actorHumanId || 'unknown')}</span>
      </div>
    </div>
    <div class="modal-actions confirm-stop-actions">
      <button type="button" class="secondary-btn" data-action="close-modal">Cancel</button>
      <button type="button" class="primary-btn" data-action="knowledge-confirm-publish" data-session-id="${escapeHtml(session.id)}">Publish</button>
    </div>
  `;
}

async function handleKnowledgeAction(action, target, event = null) {
  const knowledgeAction = String(action || '');
  if (!knowledgeAction.startsWith('knowledge-') && !knowledgeAction.startsWith('copy-knowledge-')) return false;
  if (action === 'knowledge-tab') {
    const tab = target.dataset.tab || 'home';
    knowledgeRoute = tab === 'settings'
      ? { view: 'settings', docId: '', changeSessionId: '', settingsTab: 'overview' }
      : { view: tab, docId: '', changeSessionId: '', settingsTab: '' };
    knowledgeSpaceState = { ...knowledgeSpaceState, tab };
    syncBrowserRouteForActiveView();
    render();
    return true;
  }
  if (action === 'knowledge-settings-tab') {
    const settingsTab = normalizeKnowledgeSettingsTab(target.dataset.settingsTab || 'overview');
    knowledgeRoute = { view: 'settings', docId: '', changeSessionId: '', settingsTab };
    knowledgeSpaceState = { ...knowledgeSpaceState, tab: 'settings' };
    if (settingsTab !== 'publishing') {
      knowledgeSettingsState = { ...knowledgeSettingsState, addOpen: false, selectedAddIds: [] };
    }
    syncBrowserRouteForActiveView();
    render();
    return true;
  }
  if (action === 'knowledge-select-doc') {
    event?.preventDefault?.();
    const docId = target.dataset.docId || '';
    expandKnowledgeConsensusForDoc(docId);
    knowledgeRoute = { view: 'docs', docId, changeSessionId: '' };
    knowledgeSpaceState = { ...knowledgeSpaceState, tab: 'home', selectedDocId: docId };
    syncBrowserRouteForActiveView();
    render();
    return true;
  }
  if (action === 'knowledge-toggle-consensus') {
    event?.preventDefault?.();
    const consensusId = target.dataset.consensusId || '';
    const collapsed = knowledgeCollapsedConsensusIds();
    if (collapsed.has(consensusId)) collapsed.delete(consensusId);
    else collapsed.add(consensusId);
    setKnowledgeCollapsedConsensusIds(collapsed);
    render();
    return true;
  }
  if (action === 'knowledge-open-review') {
    knowledgeRoute = { view: 'reviews', docId: '', changeSessionId: target.dataset.sessionId || '' };
    knowledgeSpaceState = { ...knowledgeSpaceState, tab: 'reviews' };
    syncBrowserRouteForActiveView();
    render();
    return true;
  }
  if (action === 'knowledge-graph-clear-search') {
    knowledgeSpaceState = { ...knowledgeSpaceState, graphSearchQuery: '' };
    if (knowledgeGraphRuntime) {
      knowledgeGraphRuntime.searchFocusedId = '';
      knowledgeGraphRuntime.hoveredId = '';
      updateKnowledgeGraphTooltip();
      queueKnowledgeGraphRender();
    }
    render();
    return true;
  }
  if (action === 'knowledge-toggle-add-members') {
    knowledgeSettingsState = {
      ...knowledgeSettingsState,
      addOpen: !knowledgeSettingsState.addOpen,
      selectedAddIds: [],
    };
    render();
    return true;
  }
  if (action === 'knowledge-toggle-add-member') {
    const humanId = target.dataset.humanId || target.value || '';
    const whitelist = new Set(knowledgeSpace()?.settings?.whitelistHumanIds || []);
    if (!humanId || whitelist.has(humanId)) return true;
    const selected = new Set(knowledgeSettingsState.selectedAddIds || []);
    if (selected.has(humanId)) selected.delete(humanId);
    else selected.add(humanId);
    knowledgeSettingsState = { ...knowledgeSettingsState, selectedAddIds: [...selected].filter(Boolean) };
    render();
    return true;
  }
  if (action === 'knowledge-save-whitelist-additions') {
    const whitelist = new Set(knowledgeSpace()?.settings?.whitelistHumanIds || []);
    for (const humanId of knowledgeSettingsState.selectedAddIds || []) whitelist.add(humanId);
    await api('/api/knowledge/settings', { method: 'PATCH', body: JSON.stringify({ whitelistHumanIds: [...whitelist] }) });
    knowledgeSettingsState = { ...knowledgeSettingsState, addOpen: false, selectedAddIds: [] };
    toast('Whitelist updated');
    await loadKnowledgeSpace({ force: true });
    return true;
  }
  if (action === 'knowledge-request-remove-whitelist-member') {
    knowledgeSettingsState = { ...knowledgeSettingsState, removeHumanId: target.dataset.humanId || '' };
    modal = 'knowledge-whitelist-remove';
    render();
    return true;
  }
  if (action === 'knowledge-confirm-remove-whitelist') {
    const humanId = target.dataset.humanId || knowledgeSettingsState.removeHumanId || '';
    const whitelistHumanIds = (knowledgeSpace()?.settings?.whitelistHumanIds || []).filter((id) => id !== humanId);
    await api('/api/knowledge/settings', { method: 'PATCH', body: JSON.stringify({ whitelistHumanIds }) });
    modal = null;
    knowledgeSettingsState = { ...knowledgeSettingsState, removeHumanId: '', selectedAddIds: [] };
    toast('Whitelist member removed');
    await loadKnowledgeSpace({ force: true });
    return true;
  }
  if (action === 'knowledge-save-settings') {
    const feishu = knowledgeFeishuPatchFromInputs();
    if (!Object.keys(feishu).length) {
      toast('No Feishu changes');
      return true;
    }
    await api('/api/knowledge/settings', { method: 'PATCH', body: JSON.stringify({ feishu }) });
    toast('Feishu settings saved');
    await loadKnowledgeSpace({ force: true });
    return true;
  }
  if (action === 'knowledge-open-publish-confirm') {
    knowledgePublishState = { sessionId: target.dataset.sessionId || '' };
    modal = 'knowledge-publish';
    render();
    return true;
  }
  if (action === 'knowledge-confirm-publish') {
    const sessionId = target.dataset.sessionId || knowledgePublishState.sessionId || '';
    await api(`/api/knowledge/change-sessions/${encodeURIComponent(sessionId)}/publish`, { method: 'POST', body: JSON.stringify({}) });
    modal = null;
    knowledgePublishState = { sessionId: '' };
    toast('Knowledge published');
    await loadKnowledgeSpace({ force: true });
    return true;
  }
  if (action === 'knowledge-open-agent-link') {
    knowledgeAgentLinkState = { docId: target.dataset.docId || knowledgeSelectedDoc()?.id || '', copied: false };
    modal = 'knowledge-agent-link';
    render();
    return true;
  }
  if (action === 'knowledge-copy-agent-link') {
    const copied = await tryCopyTextToClipboard(target.dataset.link || currentKnowledgeDocUrl(knowledgeAgentLinkDoc()));
    knowledgeAgentLinkState = { ...knowledgeAgentLinkState, copied: true };
    render();
    if (!copied) console.warn('Knowledge agent link copy failed.');
    return true;
  }
  if (action === 'knowledge-review-action') {
    const sessionId = target.dataset.sessionId || '';
    const next = target.dataset.next || '';
    const endpoint = `/api/knowledge/change-sessions/${encodeURIComponent(sessionId)}/${next}`;
    await api(endpoint, { method: 'POST', body: JSON.stringify({}) });
    toast(next === 'publish' ? 'Knowledge published' : 'Review updated');
    await loadKnowledgeSpace({ force: true });
    return true;
  }
  return false;
}
