let knowledgeGraphRuntime = null;
let knowledgeGraphRenderQueued = false;
let knowledgeGraphWindowEventsBound = false;
let knowledgeGraphAnimationToken = 0;

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
  const toolbox = document.querySelector('.knowledge-toolbox');
  const settings = document.querySelector('.knowledge-settings');
  const selected = knowledgeSelectedDoc();
  return {
    tab: knowledgeRouteTab(),
    selectedDocId: knowledgeSpaceState?.selectedDocId || selected?.id || knowledgeRoute?.docId || '',
    docRailTop: docRail?.scrollTop || 0,
    readerTop: reader?.scrollTop || 0,
    toolboxTop: toolbox?.scrollTop || 0,
    settingsTop: settings?.scrollTop || 0,
  };
}

function restoreKnowledgeScroll(snapshot) {
  if (!snapshot || activeView !== 'knowledge') return;
  const docRail = document.querySelector('.knowledge-doc-rail');
  const reader = document.querySelector('.knowledge-reader');
  const toolbox = document.querySelector('.knowledge-toolbox');
  const settings = document.querySelector('.knowledge-settings');
  if (docRail) docRail.scrollTop = Number(snapshot.docRailTop || 0);
  const sameSelectedDocument = snapshot.selectedDocId === knowledgeSpaceState?.selectedDocId
    || snapshot.selectedDocId === knowledgeSelectedDoc()?.id;
  if (sameSelectedDocument && reader) reader.scrollTop = Number(snapshot.readerTop || 0);
  if (snapshot.tab === knowledgeRouteTab() && toolbox) toolbox.scrollTop = Number(snapshot.toolboxTop || 0);
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
      ${tab === 'settings' ? renderKnowledgeSettings() : body}
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
  return `
    <section class="knowledge-layout">
      <aside class="knowledge-doc-rail">
        <div class="knowledge-doc-rail-head">
          <span>Outline</span>
          <strong>${docs.length}</strong>
        </div>
        <div class="knowledge-doc-list">
          ${docs.map((doc) => renderKnowledgeDocListItem(doc, selected?.id)).join('') || '<div class="knowledge-empty">No documents imported.</div>'}
        </div>
        ${renderKnowledgeImportPanel()}
      </aside>
      <section class="knowledge-reader">
        ${selected ? renderKnowledgeDocument(selected.id) : renderKnowledgeEmptyState()}
      </section>
      <aside class="knowledge-toolbox">
        ${renderKnowledgeCodexHandoffPanel()}
      </aside>
    </section>
  `;
}

function renderKnowledgeDocListItem(doc, selectedId) {
  return `
    <button class="knowledge-doc-row ${doc.id === selectedId ? 'active' : ''} level-${Number(doc.level || 1)}" type="button" data-action="knowledge-select-doc" data-doc-id="${escapeHtml(doc.id)}">
      <span>${escapeHtml(doc.title)}</span>
      <small>${escapeHtml(doc.summary || '')}</small>
    </button>
  `;
}

function renderKnowledgeEmptyState() {
  return `
    <div class="knowledge-empty-state">
      <h2>No consensus document yet</h2>
      <p>Import a Markdown consensus file to create the root page, child documents, anchors, links, and graph data.</p>
    </div>
  `;
}

function renderKnowledgeImportPanel() {
  if (!knowledgeCanAdmin()) return '';
  return `
    <details class="knowledge-import-panel">
      <summary>Import Markdown</summary>
      <input id="knowledge-import-title" placeholder="Source title" value="Kizuna consensus" />
      <textarea id="knowledge-import-markdown" placeholder="Paste Markdown to import"></textarea>
      <button type="button" data-action="knowledge-import">Import</button>
    </details>
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
  const anchors = doc.anchors || [];
  return `
    <article class="knowledge-document">
      <header>
        <div>
          <p>${escapeHtml(doc.level === 1 ? 'Root Consensus' : `Level ${doc.level}`)}</p>
          <h2>${escapeHtml(doc.title)}</h2>
        </div>
        ${doc.sourceUrl ? `<a href="${escapeHtml(doc.sourceUrl)}" target="_blank" rel="noreferrer noopener">Source</a>` : ''}
      </header>
      <div class="knowledge-html">${doc.renderedHtml || ''}</div>
      ${anchors.length ? `
        <section class="knowledge-anchors">
          <h3>Anchors</h3>
          ${anchors.map((anchor) => `<a href="#${escapeHtml(anchor.anchor)}">${escapeHtml(anchor.title)}</a>`).join('')}
        </section>
      ` : ''}
      ${renderKnowledgeBacklinks(doc.backlinks || [])}
      ${renderKnowledgeDraftEditor(doc)}
    </article>
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

function renderKnowledgeBacklinks(backlinks) {
  if (!backlinks.length) return '';
  return `
    <section class="knowledge-backlinks">
      <h3>Referenced By</h3>
      ${backlinks.map((link) => `<button type="button" data-action="knowledge-select-doc" data-doc-id="${escapeHtml(link.fromDocId)}">${escapeHtml(link.sourceTitle || link.label || link.fromDocId)}</button>`).join('')}
    </section>
  `;
}

function renderKnowledgeDraftEditor(doc) {
  if (!knowledgeCanEdit()) return '';
  return `
    <details class="knowledge-draft-editor">
      <summary>Create review draft</summary>
      <input id="knowledge-draft-summary" placeholder="Change summary" value="Update ${escapeHtml(doc.title)}" />
      <textarea id="knowledge-proposed-markdown">${escapeHtml(doc.sourceMarkdown || '')}</textarea>
      <button type="button" data-action="knowledge-create-draft" data-doc-id="${escapeHtml(doc.id)}">Create Draft</button>
    </details>
  `;
}

function currentKnowledgeDocUrl(doc = knowledgeSelectedDoc()) {
  const serverSlug = encodeURIComponent(String(
    (typeof currentServerSlug === 'function' && currentServerSlug())
    || (typeof serverSlugFromPath === 'function' && serverSlugFromPath())
    || 'local',
  ).trim() || 'local');
  const path = doc?.id
    ? `/s/${serverSlug}/knowledge/docs/${encodeURIComponent(doc.id)}`
    : `/s/${serverSlug}/knowledge`;
  return `${window.location.origin}${path}`;
}

function knowledgeCodexPrompt(doc = knowledgeSelectedDoc()) {
  const title = doc?.title || knowledgeSpace()?.title || 'Knowledge Space';
  const url = currentKnowledgeDocUrl(doc);
  return [
    `请读取这个 MagClaw Knowledge Space 页面：${url}`,
    `目标章节：${title}`,
    '请基于页面内容和当前讨论，帮我判断是否需要修改共识文档；如果我有编辑权限，请生成 review draft，再进入预览/发布流程。',
  ].join('\n');
}

function renderKnowledgeCodexHandoffPanel() {
  const doc = knowledgeSelectedDoc();
  const url = currentKnowledgeDocUrl(doc);
  return `
    <section class="knowledge-tool-panel knowledge-codex-handoff">
      <h2>Discuss in Codex</h2>
      <label>
        <span>Current page</span>
        <input id="knowledge-codex-link" value="${escapeHtml(url)}" readonly />
      </label>
      <div class="knowledge-tool-actions">
        <button type="button" data-action="copy-knowledge-codex-link">Copy Link</button>
        <button type="button" data-action="copy-knowledge-codex-prompt">Copy Agent Prompt</button>
      </div>
      ${knowledgeCanEdit() && doc ? `
        <button class="knowledge-review-shortcut" type="button" data-action="knowledge-focus-draft" data-doc-id="${escapeHtml(doc.id)}">Create Review Draft</button>
      ` : ''}
    </section>
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

function renderKnowledgeGraphPanel() {
  setTimeout(() => loadKnowledgeGraph().catch((error) => console.warn('Failed to load graph:', error)), 0);
  return `
    <section class="knowledge-graph-panel">
      <canvas id="knowledge-graph-canvas" width="1280" height="760" aria-label="Knowledge graph"></canvas>
      <div class="knowledge-graph-legend">
        <span><i class="blue"></i> Consensus hierarchy</span>
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
    draggingNode: null,
    panning: null,
    tick: 0,
    resizeObserver: null,
  };
  if (window.ResizeObserver) {
    knowledgeGraphRuntime.resizeObserver = new ResizeObserver(() => resizeKnowledgeGraphCanvas());
    knowledgeGraphRuntime.resizeObserver.observe(canvas);
  }
  bindKnowledgeGraphEvents(canvas);
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
  if (spaceNode) placeKnowledgeNode(spaceNode, centerX, centerY);

  const topDocuments = nodes.filter((node) => node.kind === 'document' && (!node.parentId || Number(node.level || 1) <= 1));
  const childDocuments = nodes.filter((node) => node.kind === 'document' && node.parentId && Number(node.level || 1) > 1);
  const topRadius = Math.max(34, minSize * 0.07);
  topDocuments.forEach((node, index) => {
    const angle = topDocuments.length === 1 ? -Math.PI / 2 : (index / topDocuments.length) * Math.PI * 2 - Math.PI / 2;
    placeKnowledgeNode(node, centerX + Math.cos(angle) * topRadius, centerY + Math.sin(angle) * topRadius);
  });

  const childRadius = Math.max(120, Math.min(minSize * 0.29, 230));
  childDocuments.forEach((node, index) => {
    const angle = (index / Math.max(1, childDocuments.length)) * Math.PI * 2 - Math.PI / 2;
    const wobble = 1 + ((index % 3) - 1) * 0.08;
    placeKnowledgeNode(node, centerX + Math.cos(angle) * childRadius * wobble, centerY + Math.sin(angle) * childRadius * wobble);
  });

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
    const parentAngle = Math.atan2(parentY - centerY, parentX - centerX);
    anchors.forEach((node, index) => {
      const spread = anchors.length <= 1 ? 0 : (index / (anchors.length - 1) - 0.5) * Math.PI * 0.9;
      const angle = parentAngle + spread;
      const radius = 44 + (index % 4) * 9;
      placeKnowledgeNode(node, parentX + Math.cos(angle) * radius, parentY + Math.sin(angle) * radius);
    });
  }

  nodes.filter((node) => !Number.isFinite(node.x) || (node.x === centerX && node.y === centerY && node.kind !== 'space')).forEach((node, index) => {
    const angle = (index / Math.max(1, nodes.length)) * Math.PI * 2;
    placeKnowledgeNode(node, centerX + Math.cos(angle) * childRadius, centerY + Math.sin(angle) * childRadius);
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
    if (node && event.button === 0) {
      knowledgeGraphRuntime.draggingNode = node;
      node.fx = point.x;
      node.fy = point.y;
      node.vx = 0;
      node.vy = 0;
    } else {
      knowledgeGraphRuntime.panning = { x: event.clientX, y: event.clientY, panX: knowledgeGraphRuntime.panX, panY: knowledgeGraphRuntime.panY };
    }
  });
  canvas.addEventListener('mouseleave', () => {
    if (!knowledgeGraphRuntime || knowledgeGraphRuntime.panning || knowledgeGraphRuntime.draggingNode) return;
    knowledgeGraphRuntime.hoveredId = '';
    queueKnowledgeGraphRender();
  });
  if (!knowledgeGraphWindowEventsBound) {
    knowledgeGraphWindowEventsBound = true;
    window.addEventListener('mouseup', () => {
      if (!knowledgeGraphRuntime) return;
      if (knowledgeGraphRuntime.draggingNode) {
        delete knowledgeGraphRuntime.draggingNode.fx;
        delete knowledgeGraphRuntime.draggingNode.fy;
        knowledgeGraphRuntime.draggingNode = null;
      }
      knowledgeGraphRuntime.panning = null;
    });
    window.addEventListener('mousemove', (event) => {
      if (!knowledgeGraphRuntime) return;
      const point = graphPointer(event);
      if (knowledgeGraphRuntime.draggingNode) {
        knowledgeGraphRuntime.draggingNode.fx = point.x;
        knowledgeGraphRuntime.draggingNode.fy = point.y;
        return;
      }
      if (knowledgeGraphRuntime.panning) {
        const pan = knowledgeGraphRuntime.panning;
        knowledgeGraphRuntime.panX = pan.panX + event.clientX - pan.x;
        knowledgeGraphRuntime.panY = pan.panY + event.clientY - pan.y;
        queueKnowledgeGraphRender();
        return;
      }
      if (!point.inside) {
        knowledgeGraphRuntime.hoveredId = '';
        queueKnowledgeGraphRender();
        return;
      }
      const hovered = nearestKnowledgeNode(point.x, point.y, 9 / knowledgeGraphRuntime.scale);
      knowledgeGraphRuntime.hoveredId = hovered?.id || '';
      queueKnowledgeGraphRender();
    });
    window.addEventListener('resize', () => resizeKnowledgeGraphCanvas());
  }
  canvas.addEventListener('dblclick', (event) => {
    const point = graphPointer(event);
    const node = nearestKnowledgeNode(point.x, point.y, 14 / (knowledgeGraphRuntime?.scale || 1));
    if (node?.href) window.location.assign(node.href);
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
    const force = (distance - desired) * 0.0055;
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
    const homeStrength = node.kind === 'space' ? 0.018 : node.kind === 'document' ? 0.0026 : 0.0012;
    node.vx += ((node.homeX || cx) - node.x) * homeStrength;
    node.vy += ((node.homeY || cy) - node.y) * homeStrength;
    node.vx += (cx - node.x) * 0.0002;
    node.vy += (cy - node.y) * 0.0002;
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
  if (edge.kind === 'hierarchy') return 104 + Math.max(0, Number(target.level || 2) - 2) * 12;
  if (edge.kind === 'anchor') return 48;
  return 126 + Math.min(24, Math.max(source.degree || 0, target.degree || 0) * 2);
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
  if (rt.hoveredId) {
    neighbors.add(rt.hoveredId);
    for (const edge of rt.graph.edges) {
      if (edge.source === rt.hoveredId) neighbors.add(edge.target);
      if (edge.target === rt.hoveredId) neighbors.add(edge.source);
    }
  }
  const dim = rt.hoveredId ? 0.12 : 1;
  const byId = new Map(rt.graph.nodes.map((node) => [node.id, node]));
  for (const edge of rt.graph.edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    const active = !rt.hoveredId || (neighbors.has(source.id) && neighbors.has(target.id));
    ctx.strokeStyle = active ? knowledgeEdgeColor(edge) : `rgba(86, 99, 110, ${0.13 * dim})`;
    ctx.lineWidth = (active ? 0.92 : 0.48) / Math.sqrt(rt.scale);
    ctx.beginPath();
    ctx.moveTo(source.x, source.y);
    ctx.lineTo(target.x, target.y);
    ctx.stroke();
  }
  for (const node of rt.graph.nodes) {
    const active = !rt.hoveredId || neighbors.has(node.id);
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
    const active = !rt.hoveredId || neighbors.has(node.id);
    if (active && shouldShowKnowledgeNodeLabel(rt, node)) drawKnowledgeNodeLabel(ctx, rt, node);
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

function knowledgeEdgeColor(edge) {
  if (edge.kind === 'root' || edge.kind === 'hierarchy') return 'rgba(64, 120, 166, 0.22)';
  if (edge.kind === 'anchor') return 'rgba(88, 103, 113, 0.18)';
  return 'rgba(72, 135, 190, 0.28)';
}

function knowledgeNodeColor(node) {
  if (node.colorRole === 'recent_leaf') return 'rgba(232, 82, 86, 0.72)';
  if (node.kind === 'space') return 'rgba(44, 132, 190, 0.78)';
  if (node.kind === 'document' && Number(node.level || 1) <= 1) return 'rgba(44, 132, 190, 0.72)';
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
          ${session.status === 'preview' && knowledgeCanEdit() ? `<button type="button" data-action="knowledge-review-action" data-next="publish" data-session-id="${escapeHtml(session.id)}">Publish</button>` : ''}
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
    <div class="knowledge-settings-card knowledge-whitelist-card">
      <header class="knowledge-card-head">
        <h2>Publishing Whitelist</h2>
        <button type="button" data-action="knowledge-toggle-add-members">${knowledgeSettingsState.addOpen ? 'Close' : 'Add'}</button>
      </header>
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
    </div>
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
  return `
    <div class="knowledge-settings-card knowledge-feishu-card">
      <h2>Feishu Notification</h2>
      ${renderKnowledgeFeishuField('knowledge-feishu-app-id', 'App ID', feishu.appId || '', 'App ID')}
      ${renderKnowledgeFeishuField('knowledge-feishu-chat-id', 'Chat ID', feishu.chatId || '', 'Chat ID')}
      <label class="knowledge-field">
        <span>App Secret</span>
        <input id="knowledge-feishu-secret" type="password" data-masked-value="${escapeHtml(feishu.appSecretMasked || '')}" placeholder="${escapeHtml(secretPlaceholder)}" autocomplete="new-password" />
      </label>
      <p>${feishu.appSecretConfigured ? `Secret configured ${escapeHtml(feishu.appSecretConfiguredAt || '')}` : 'No secret configured.'}</p>
      <button class="knowledge-save-settings" type="button" data-action="knowledge-save-settings">Save Feishu Settings</button>
    </div>
  `;
}

function renderKnowledgeSettings() {
  const members = knowledgeSpaceState?.data?.members || [];
  const settings = knowledgeSpace()?.settings || {};
  const whitelist = new Set(settings.whitelistHumanIds || []);
  return `
    <section class="knowledge-settings">
      ${renderKnowledgeWhitelistCard(members, whitelist)}
      ${renderKnowledgeFeishuSettings(settings)}
    </section>
  `;
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

async function handleKnowledgeAction(action, target) {
  const knowledgeAction = String(action || '');
  if (!knowledgeAction.startsWith('knowledge-') && !knowledgeAction.startsWith('copy-knowledge-')) return false;
  if (action === 'knowledge-tab') {
    const tab = target.dataset.tab || 'home';
    knowledgeRoute = { view: tab, docId: '', changeSessionId: '' };
    knowledgeSpaceState = { ...knowledgeSpaceState, tab };
    syncBrowserRouteForActiveView();
    render();
    return true;
  }
  if (action === 'knowledge-select-doc') {
    const docId = target.dataset.docId || '';
    knowledgeRoute = { view: 'docs', docId, changeSessionId: '' };
    knowledgeSpaceState = { ...knowledgeSpaceState, tab: 'home', selectedDocId: docId };
    syncBrowserRouteForActiveView();
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
  if (action === 'knowledge-focus-draft') {
    const draft = document.querySelector('.knowledge-draft-editor');
    if (draft) {
      draft.open = true;
      draft.scrollIntoView({ block: 'nearest' });
    }
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
  if (action === 'knowledge-import') {
    const markdown = document.querySelector('#knowledge-import-markdown')?.value || '';
    const sourceName = document.querySelector('#knowledge-import-title')?.value || '';
    await api('/api/knowledge/import', {
      method: 'POST',
      body: JSON.stringify({ markdown, sourceName }),
    });
    toast('Knowledge imported');
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
  if (action === 'knowledge-copy-link' || action === 'copy-knowledge-codex-link') {
    const copied = await tryCopyTextToClipboard(currentKnowledgeDocUrl());
    toast(copied ? 'Knowledge link copied' : 'Copy failed');
    return true;
  }
  if (action === 'copy-knowledge-codex-prompt') {
    const copied = await tryCopyTextToClipboard(knowledgeCodexPrompt());
    toast(copied ? 'Agent prompt copied' : 'Copy failed');
    return true;
  }
  if (action === 'knowledge-create-draft') {
    const docId = target.dataset.docId || knowledgeSelectedDoc()?.id || '';
    const proposedMarkdown = document.querySelector('#knowledge-proposed-markdown')?.value || '';
    const summary = document.querySelector('#knowledge-draft-summary')?.value || 'Knowledge update draft';
    const result = await api('/api/knowledge/change-sessions', {
      method: 'POST',
      body: JSON.stringify({ summary, changes: [{ docId, proposedMarkdown }] }),
    });
    toast('Draft created');
    knowledgeRoute = { view: 'reviews', docId: '', changeSessionId: result.session.id };
    await loadKnowledgeSpace({ force: true });
    syncBrowserRouteForActiveView();
    return true;
  }
  if (action === 'knowledge-review-action') {
    const sessionId = target.dataset.sessionId || '';
    const next = target.dataset.next || '';
    if (next === 'publish' && !window.confirm('Publish this Knowledge Space change session?')) return true;
    const endpoint = `/api/knowledge/change-sessions/${encodeURIComponent(sessionId)}/${next}`;
    await api(endpoint, { method: 'POST', body: JSON.stringify({}) });
    toast(next === 'publish' ? 'Knowledge published' : 'Review updated');
    await loadKnowledgeSpace({ force: true });
    return true;
  }
  return false;
}
