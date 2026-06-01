import {
  applyTeamMemoryFeedback,
  contextWindowForTeamMemorySession,
  rankTeamMemoryCandidates,
  syncTeamMemoryBatch,
} from '../team-memory.js';

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactText(value = '', max = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}...`;
}

function htmlEscape(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sourceAnchorEventId(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  const hashIndex = text.lastIndexOf('#');
  if (hashIndex >= 0 && hashIndex < text.length - 1) return text.slice(hashIndex + 1);
  return text;
}

function sourceAnchorFromSearchParams(searchParams) {
  return sourceAnchorEventId(searchParams.get('anchorEventId') || searchParams.get('anchor') || '');
}

function resultContextUrl(item, queryId = '') {
  const params = new URLSearchParams();
  const anchorEventId = sourceAnchorEventId(item.sourceRef);
  if (anchorEventId) params.set('anchorEventId', anchorEventId);
  if (item.vectorDocumentId) params.set('vectorDocumentId', item.vectorDocumentId);
  if (queryId) params.set('queryId', queryId);
  if (item.sourceRef) params.set('sourceRef', item.sourceRef);
  const suffix = params.toString();
  return `/team-memory/context/${encodeURIComponent(item.sessionId)}${suffix ? `?${suffix}` : ''}`;
}

function sendContextHtml(res, {
  sessionId = '',
  anchorEventId = '',
  vectorDocumentId = '',
  queryId = '',
  sourceRef = '',
} = {}) {
  const safeSession = encodeURIComponent(sessionId);
  const initialAnchor = String(anchorEventId || '');
  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MagClaw Team Memory Context</title>
  <style>
    :root { color-scheme: light; --ink:#111827; --muted:#64748b; --line:#d7dee8; --bg:#f8fafc; --accent:#0891b2; }
    * { box-sizing:border-box; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--ink); }
    header { position:sticky; top:0; z-index:2; padding:16px 20px; border-bottom:1px solid var(--line); background:rgba(248,250,252,.94); backdrop-filter: blur(14px); }
    h1 { margin:0; font-size:18px; letter-spacing:0; }
    .meta { margin-top:4px; color:var(--muted); font-size:13px; overflow-wrap:anywhere; }
    main { max-width:920px; margin:0 auto; padding:18px; }
    .controls { display:flex; gap:10px; justify-content:center; margin:12px 0; }
    button { border:1px solid var(--line); background:#fff; color:var(--ink); border-radius:6px; padding:8px 12px; cursor:pointer; }
    button:disabled { opacity:.45; cursor:not-allowed; }
    article { background:#fff; border:1px solid var(--line); border-radius:8px; padding:14px 16px; margin:10px 0; box-shadow:0 1px 2px rgba(15,23,42,.04); }
    article.anchor { border-color:var(--accent); box-shadow:0 0 0 2px rgba(8,145,178,.12); }
    .role { font-size:12px; font-weight:700; color:var(--accent); text-transform:uppercase; }
    .time { margin-left:8px; color:var(--muted); font-size:12px; }
    .text { margin-top:8px; white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.55; }
    .empty { color:var(--muted); text-align:center; padding:48px 0; }
  </style>
</head>
<body>
  <header>
    <h1>MagClaw Team Memory Context</h1>
    <div class="meta">session: ${htmlEscape(sessionId)} · anchor: ${htmlEscape(initialAnchor || 'latest')}</div>
  </header>
  <main>
    <div class="controls"><button id="load-more-prev" type="button">Load previous</button></div>
    <section id="events" aria-live="polite"><div class="empty">Loading context...</div></section>
    <div class="controls"><button id="load-more-next" type="button">Load next</button></div>
  </main>
  <script>
    const sessionId = ${JSON.stringify(sessionId)};
    let anchorEventId = ${JSON.stringify(initialAnchor)};
    const vectorDocumentId = ${JSON.stringify(String(vectorDocumentId || ''))};
    const queryId = ${JSON.stringify(String(queryId || ''))};
    const sourceRef = ${JSON.stringify(String(sourceRef || ''))};
    const eventsEl = document.getElementById('events');
    const prevBtn = document.getElementById('load-more-prev');
    const nextBtn = document.getElementById('load-more-next');
    const seen = new Set();
    let prevAnchor = anchorEventId;
    let nextAnchor = anchorEventId;
    let openedRecorded = false;
    function escapeHtml(text) {
      return String(text || '').replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
    }
    function recordFeedback(eventType) {
      if (!vectorDocumentId) return;
      fetch('/api/team-memory/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ queryId, vectorDocumentId, sessionId, eventType, sourceRef })
      }).catch(() => {});
    }
    function eventHtml(event) {
      const anchorClass = anchorEventId && event.eventId === anchorEventId ? ' anchor' : '';
      return '<article id="' + encodeURIComponent(event.eventId || '') + '" class="' + anchorClass.trim() + '">' +
        '<div><span class="role">' + escapeHtml(event.role || '') + '</span><span class="time">' + escapeHtml(event.createdAt || '') + '</span></div>' +
        '<div class="text">' + escapeHtml(event.cleanText || event.text || '') + '</div></article>';
    }
    async function load(direction) {
      const anchor = direction === 'next' ? nextAnchor : prevAnchor;
      const url = '/api/team-memory/context/${safeSession}?anchorEventId=' + encodeURIComponent(anchor || '') + '&direction=' + encodeURIComponent(direction) + '&limit=20';
      const response = await fetch(url);
      const data = await response.json();
      if (!data.ok) throw new Error(data.error || 'Failed to load context');
      const fresh = (data.events || []).filter(event => {
        const key = event.eventId || JSON.stringify(event);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      if (!fresh.length && !seen.size) {
        eventsEl.innerHTML = '<div class="empty">No context found.</div>';
      } else if (fresh.length) {
        const html = fresh.map(eventHtml).join('');
        if (direction === 'prev') eventsEl.insertAdjacentHTML('afterbegin', html);
        else if (eventsEl.querySelector('.empty')) eventsEl.innerHTML = html;
        else eventsEl.insertAdjacentHTML('beforeend', html);
      }
      prevAnchor = data.pagination?.prevAnchorEventId || prevAnchor;
      nextAnchor = data.pagination?.nextAnchorEventId || nextAnchor;
      prevBtn.disabled = !data.pagination?.hasPrev;
      nextBtn.disabled = !data.pagination?.hasNext;
      if (!openedRecorded && direction === 'around') {
        openedRecorded = true;
        recordFeedback('opened');
      } else if (fresh.length && (direction === 'prev' || direction === 'next')) {
        recordFeedback('load_more');
      }
      if (anchorEventId) document.getElementById(encodeURIComponent(anchorEventId))?.scrollIntoView({ block: 'center' });
    }
    prevBtn.addEventListener('click', () => load('prev').catch(console.error));
    nextBtn.addEventListener('click', () => load('next').catch(console.error));
    load('around').catch(error => { eventsEl.innerHTML = '<div class="empty">' + escapeHtml(error.message) + '</div>'; });
  </script>
</body>
</html>`;
  res.writeHead?.(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end?.(body);
}

function queryTerms(query = '') {
  return String(query || '')
    .toLowerCase()
    .split(/[\s,，。.;；:：!?！？()[\]{}"'`]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

function dateBound(dateRange = {}, keys = []) {
  for (const key of keys) {
    const value = dateRange?.[key];
    if (value) return String(value);
  }
  return '';
}

function isWithinDateRange(value = '', dateRange = null) {
  if (!dateRange || typeof dateRange !== 'object') return true;
  const text = String(value || '');
  const from = dateBound(dateRange, ['from', 'start', 'since', 'updatedAfter', 'updated_after']);
  const to = dateBound(dateRange, ['to', 'end', 'until', 'updatedBefore', 'updated_before']);
  if (from && text < from) return false;
  if (to && text > to) return false;
  return true;
}

function localVectorSearch({ memory, query = '', channelId = '', projectKey = '', dateRange = null, limit = 40 } = {}) {
  const terms = queryTerms(query);
  const candidates = asArray(memory?.vectorDocuments)
    .filter((doc) => doc.active !== false)
    .filter((doc) => !channelId || doc.channelId === channelId)
    .filter((doc) => !projectKey || doc.projectKey === projectKey)
    .filter((doc) => isWithinDateRange(doc.updatedAt, dateRange))
    .map((doc) => {
      const haystack = `${doc.title || ''}\n${doc.topicId || ''}\n${doc.text || ''}`.toLowerCase();
      const matchedTerms = terms.filter((term) => haystack.includes(term));
      const keywordScore = terms.length ? matchedTerms.length / terms.length : 0;
      const vectorScore = Math.max(0.05, keywordScore || (doc.layer === 'L0' ? 0.15 : 0.1));
      return {
        ...doc,
        vectorScore,
        keywordScore,
        freshnessScore: 0.5,
      };
    })
    .sort((left, right) => right.vectorScore - left.vectorScore || String(left.vectorDocumentId).localeCompare(String(right.vectorDocumentId)))
    .slice(0, limit);
  return { ok: true, candidates };
}

function localRerank({ query = '', candidates = [] } = {}) {
  const terms = queryTerms(query);
  return asArray(candidates).map((candidate, index) => {
    const haystack = `${candidate.title || ''}\n${candidate.topicId || ''}\n${candidate.text || ''}`.toLowerCase();
    const matches = terms.filter((term) => haystack.includes(term)).length;
    return {
      index,
      score: terms.length ? matches / terms.length : Number(candidate.vectorScore || 0),
    };
  });
}

function actorWorkspaceId(actor, state) {
  return String(actor?.member?.workspaceId || state.connection?.workspaceId || state.cloud?.workspace?.id || 'local').trim();
}

function actorHumanId(actor) {
  return String(actor?.member?.humanId || actor?.human?.id || 'hum_local').trim();
}

function dependencyReady(fn, envKeys = []) {
  if (typeof fn === 'function') return Boolean(fn());
  return envKeys.every((key) => String(process.env[key] || '').trim());
}

function requireTeamMemoryAuth(req, res, { actor, sendError, teamMemoryAuthRequired, validTeamMemoryToken } = {}) {
  const required = typeof teamMemoryAuthRequired === 'function' ? teamMemoryAuthRequired(req) : Boolean(teamMemoryAuthRequired);
  if (!required || actor) return true;
  if (typeof validTeamMemoryToken === 'function' && validTeamMemoryToken(req)) return true;
  sendError(res, 401, 'Team memory login or scoped token is required.');
  return false;
}

export async function handleTeamMemoryApi(req, res, url, deps) {
  const {
    addSystemEvent = () => {},
    broadcastState = () => {},
    currentActor = () => null,
    embeddingProbe = null,
    embeddingReady = null,
    getState,
    indexTeamMemoryDocuments = null,
    makeId,
    now,
    persistState = async () => {},
    readJson,
    rerank = null,
    rerankReady = null,
    sendError,
    sendJson,
    teamMemoryAuthRequired = null,
    validTeamMemoryToken = null,
    vectorSearch = null,
    zillizReady = null,
  } = deps;
  const state = getState();
  const actor = currentActor(req);
  const workspaceId = actorWorkspaceId(actor, state);

  const contextPageMatch = url.pathname.match(/^\/team-memory\/context\/([^/]+)$/);
  if (req.method === 'GET' && contextPageMatch) {
    if (!requireTeamMemoryAuth(req, res, { actor, sendError, teamMemoryAuthRequired, validTeamMemoryToken })) return true;
    sendContextHtml(res, {
      sessionId: decodeURIComponent(contextPageMatch[1]),
      anchorEventId: sourceAnchorFromSearchParams(url.searchParams),
      vectorDocumentId: url.searchParams.get('vectorDocumentId') || '',
      queryId: url.searchParams.get('queryId') || '',
      sourceRef: url.searchParams.get('sourceRef') || '',
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/team-memory/sync') {
    if (!requireTeamMemoryAuth(req, res, { actor, sendError, teamMemoryAuthRequired, validTeamMemoryToken })) return true;
    const body = await readJson(req);
    const result = await syncTeamMemoryBatch({
      ...body,
      workspaceId: body.workspaceId || workspaceId,
      humanId: body.humanId || actorHumanId(actor),
    }, {
      state,
      makeId,
      now,
    });
    if (!result.ok) {
      sendError(res, result.code === 'channel_not_found' ? 404 : 400, result.error || 'Team memory sync failed.');
      return true;
    }
    if (!result.duplicate && result.appendedEventCount > 0 && typeof indexTeamMemoryDocuments === 'function') {
      const documents = asArray(state.teamMemory?.vectorDocuments)
        .filter((doc) => doc.sessionId === result.sessionId && doc.active !== false);
      try {
        const indexed = await indexTeamMemoryDocuments({
          workspaceId,
          sessionId: result.sessionId,
          documents,
          memory: state.teamMemory || {},
        });
        result.indexedDocumentCount = Number(indexed?.count || documents.length || 0);
      } catch (error) {
        result.indexedDocumentCount = 0;
        result.indexError = 'Team memory vector indexing failed.';
        addSystemEvent('team_memory_index_error', 'Team memory vector indexing failed.', {
          workspaceId,
          sessionId: result.sessionId,
          message: String(error?.message || error).slice(0, 300),
        });
      }
    }
    addSystemEvent('team_memory_sync', `Team memory synced ${result.appendedEventCount} event(s).`, {
      workspaceId,
      sessionId: result.sessionId,
      messageId: result.messageId,
      duplicate: result.duplicate,
    });
    await persistState({ workspaceId, reason: 'team_memory_sync' });
    broadcastState();
    sendJson(res, result.duplicate ? 200 : 202, result);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/team-memory/search') {
    if (!requireTeamMemoryAuth(req, res, { actor, sendError, teamMemoryAuthRequired, validTeamMemoryToken })) return true;
    const body = await readJson(req);
    const limit = Math.max(1, Math.min(20, Number(body.limit || 5)));
    const candidateK = Math.max(limit, Math.min(200, Number(body.candidateK || 40)));
    const memory = state.teamMemory || {};
    if (typeof zillizReady === 'function' && !zillizReady()) {
      sendError(res, 503, 'Team memory vector index is not ready.');
      return true;
    }
    const vector = vectorSearch
      ? await vectorSearch({
        memory,
        query: body.query || '',
        channelId: body.channelId || '',
        projectKey: body.projectKey || '',
        dateRange: body.dateRange || null,
        limit: candidateK,
        actor,
      })
      : localVectorSearch({
        memory,
        query: body.query || '',
        channelId: body.channelId || '',
        projectKey: body.projectKey || '',
        dateRange: body.dateRange || null,
        limit: candidateK,
      });
    if (!vector?.ok) {
      sendError(res, 503, vector?.error || 'Team memory vector search failed.');
      return true;
    }
    const rerankResults = rerank
      ? await rerank({ query: body.query || '', candidates: vector.candidates || [], limit: candidateK })
      : localRerank({ query: body.query || '', candidates: vector.candidates || [] });
    const ranked = rankTeamMemoryCandidates({
      query: body.query || '',
      candidates: vector.candidates || [],
      memory,
      rerankResults,
      now,
      limit,
    });
    for (const item of ranked.results) {
      applyTeamMemoryFeedback(memory, {
        workspaceId,
        actorId: actorHumanId(actor),
        queryId: ranked.queryId,
        vectorDocumentId: item.vectorDocumentId,
        sessionId: item.sessionId,
        sourceRef: item.sourceRef,
        eventType: 'served',
        createdAt: now(),
      });
    }
    addSystemEvent('team_memory_search', `Team memory searched: ${compactText(body.query || '', 90)}`, {
      workspaceId,
      queryId: ranked.queryId,
      resultCount: ranked.results.length,
      candidateCount: vector.candidates?.length || 0,
    });
    await persistState({ workspaceId, reason: 'team_memory_search' });
    sendJson(res, 200, {
      ok: true,
      queryId: ranked.queryId,
      traceId: ranked.queryId,
      results: ranked.results.map((item) => ({
        vectorDocumentId: item.vectorDocumentId,
        sessionId: item.sessionId,
        topicId: item.topicId,
        layer: item.layer,
        title: item.title,
        conclusion: compactText(item.text || item.title, 320),
        evidence: compactText(item.text || '', 320),
        sourceRef: item.sourceRef,
        anchorEventId: sourceAnchorEventId(item.sourceRef),
        contextUrl: resultContextUrl(item, ranked.queryId),
        finalScore: item.finalScore,
        vectorScore: item.vectorScore,
        rerankScore: item.rerankScore,
        hotnessScore: item.hotnessScore,
      })),
      rerankUsed: Boolean(rerankResults?.length),
      candidateCount: vector.candidates?.length || 0,
      trace: ranked.trace,
    });
    return true;
  }

  const contextMatch = url.pathname.match(/^\/api\/team-memory\/context\/([^/]+)$/);
  if (req.method === 'GET' && contextMatch) {
    if (!requireTeamMemoryAuth(req, res, { actor, sendError, teamMemoryAuthRequired, validTeamMemoryToken })) return true;
    const sessionId = decodeURIComponent(contextMatch[1]);
    const result = contextWindowForTeamMemorySession(state.teamMemory || {}, sessionId, {
      anchorEventId: sourceAnchorFromSearchParams(url.searchParams),
      direction: url.searchParams.get('direction') || 'around',
      limit: url.searchParams.get('limit') || 20,
    });
    if (!result.ok) {
      sendError(res, 404, 'Team memory session not found.');
      return true;
    }
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/team-memory/feedback') {
    if (!requireTeamMemoryAuth(req, res, { actor, sendError, teamMemoryAuthRequired, validTeamMemoryToken })) return true;
    const body = await readJson(req);
    const result = applyTeamMemoryFeedback(state.teamMemory || {}, {
      ...body,
      workspaceId,
      actorId: body.actorId || actorHumanId(actor),
      createdAt: body.createdAt || now(),
    });
    if (!result.ok) {
      sendError(res, 400, 'Invalid team memory feedback.');
      return true;
    }
    addSystemEvent('team_memory_feedback', `Team memory feedback recorded: ${body.eventType || ''}`, {
      workspaceId,
      vectorDocumentId: body.vectorDocumentId || '',
      eventType: body.eventType || '',
    });
    await persistState({ workspaceId, reason: 'team_memory_feedback' });
    broadcastState();
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/team-memory/doctor') {
    const embeddingCheck = {
      ready: dependencyReady(embeddingReady, ['MAGCLAW_EMBEDDING_BASE_URL', 'MAGCLAW_EMBEDDING_API_KEY', 'MAGCLAW_EMBEDDING_MODEL']),
    };
    if (url.searchParams.get('probe') === '1' && embeddingCheck.ready && typeof embeddingProbe === 'function') {
      try {
        const probe = await embeddingProbe();
        if (probe?.dimension) embeddingCheck.dimension = Number(probe.dimension);
      } catch (error) {
        embeddingCheck.ready = false;
        embeddingCheck.error = String(error?.message || error).slice(0, 160);
      }
    }
    const checks = {
      sync: { ready: true },
      zilliz: {
        ready: dependencyReady(zillizReady, ['MAGCLAW_ZILLIZ_ENDPOINT', 'MAGCLAW_ZILLIZ_TOKEN']),
      },
      embedding: embeddingCheck,
      rerank: {
        ready: dependencyReady(rerankReady, ['MAGCLAW_RERANK_URL', 'MAGCLAW_RERANK_API_KEY']),
      },
      llm: {
        ready: ['MAGCLAW_LLM_BASE_URL', 'MAGCLAW_LLM_API_KEY', 'MAGCLAW_LLM_MODEL']
          .every((key) => String(process.env[key] || '').trim()),
      },
    };
    sendJson(res, 200, {
      ok: Object.values(checks).every((item) => item.ready),
      checks,
    });
    return true;
  }

  return false;
}
