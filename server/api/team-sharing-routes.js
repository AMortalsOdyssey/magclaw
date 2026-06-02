import {
  applyTeamSharingFeedback,
  contextWindowForTeamSharingSession,
  rankTeamSharingCandidates,
  syncTeamSharingBatch,
} from '../team-sharing.js';
import crypto from 'node:crypto';

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
  return `/team-sharing/context/${encodeURIComponent(item.sessionId)}${suffix ? `?${suffix}` : ''}`;
}

const SHARE_CONTENT_TYPES = new Set(['html', 'markdown', 'svg', 'mermaid']);
const MAX_SHARE_CONTENT_LENGTH = 10 * 1024 * 1024;

function normalizeShareContentType(value = '', content = '') {
  const explicit = String(value || '').trim().toLowerCase();
  if (SHARE_CONTENT_TYPES.has(explicit)) return explicit;
  const text = String(content || '').trim();
  if (/^```mermaid/i.test(text) || /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram)\b/i.test(text)) return 'mermaid';
  if (text.startsWith('<svg') && text.includes('</svg>')) return 'svg';
  if (/^<!doctype html/i.test(text) || /^<html[\s>]/i.test(text) || /<(body|head|style|script|div|section|article)\b/i.test(text)) return 'html';
  return 'markdown';
}

function ensureTeamSharingShares(teamSharingState = {}) {
  teamSharingState.shares = Array.isArray(teamSharingState.shares) ? teamSharingState.shares : [];
  return teamSharingState.shares;
}

function publicUrlFromRequest(req) {
  const configured = String(process.env.MAGCLAW_PUBLIC_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  const proto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim()
    || (req?.socket?.encrypted ? 'https' : 'http');
  const forwardedHost = String(req?.headers?.['x-forwarded-host'] || '').split(',')[0].trim();
  const host = forwardedHost || req?.headers?.host || '127.0.0.1:6543';
  return `${proto}://${host}`.replace(/\/+$/, '');
}

function shareUrl(req, shareId = '') {
  return `${publicUrlFromRequest(req)}/s/${encodeURIComponent(shareId)}`;
}

function creatorFromActor(actor = {}) {
  const member = actor?.member || {};
  const user = actor?.user || actor?.human || {};
  const id = String(member.humanId || user.id || 'hum_local').trim();
  const displayName = String(member.name || user.name || member.email || user.email || id || 'Unknown creator').trim();
  return {
    id,
    name: displayName,
    email: String(member.email || user.email || '').trim(),
  };
}

function shareFooterHtml(share = {}) {
  const creator = share.creator?.name || share.createdByName || share.createdBy || 'Unknown creator';
  const createdAt = share.createdAt || '';
  return `<footer class="magclaw-share-footer">Created by ${htmlEscape(creator)}${createdAt ? ` · ${htmlEscape(createdAt)}` : ''}</footer>`;
}

function renderMarkdownInline(value = '') {
  return htmlEscape(value)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" rel="noopener noreferrer">$1</a>');
}

function renderMarkdownToHtml(markdown = '') {
  const lines = String(markdown || '').split(/\r?\n/);
  const out = [];
  let inCode = false;
  let code = [];
  let listOpen = false;
  const closeList = () => {
    if (listOpen) {
      out.push('</ul>');
      listOpen = false;
    }
  };
  const flushCode = () => {
    out.push(`<pre><code>${htmlEscape(code.join('\n'))}</code></pre>`);
    code = [];
  };
  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        closeList();
        inCode = true;
        code = [];
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      continue;
    }
    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = Math.min(4, heading[1].length);
      out.push(`<h${level}>${renderMarkdownInline(heading[2])}</h${level}>`);
      continue;
    }
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      if (!listOpen) {
        out.push('<ul>');
        listOpen = true;
      }
      out.push(`<li>${renderMarkdownInline(bullet[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${renderMarkdownInline(trimmed)}</p>`);
  }
  if (inCode) flushCode();
  closeList();
  return out.join('\n');
}

function shareChromeHtml(share = {}, innerHtml = '') {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlEscape(share.title || 'MagClaw QuickShare')}</title>
  <style>
    :root { color-scheme: light; --ink:#14212b; --muted:#64748b; --line:#d9e2e5; --bg:#f8fafc; --panel:#fff; --accent:#0891b2; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; line-height:1.62; }
    main { max-width:900px; margin:0 auto; padding:28px 18px 80px; }
    .shell { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:28px; box-shadow:0 8px 30px rgba(15,23,42,.05); }
    .brand { color:var(--accent); font-size:13px; font-weight:800; text-transform:uppercase; letter-spacing:0; margin-bottom:10px; }
    h1,h2,h3,h4 { line-height:1.25; letter-spacing:0; }
    h1 { margin:0 0 14px; font-size:32px; }
    p { margin:10px 0; }
    pre { overflow-x:auto; background:#0f1720; color:#d9f4f6; padding:14px; border-radius:8px; }
    code { font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace; }
    a { color:var(--accent); }
    svg { max-width:100%; height:auto; }
    .share-root-intro { color:var(--muted); margin:0 0 22px; }
    .share-folder { border-top:1px solid var(--line); padding-top:18px; margin-top:22px; }
    .share-folder h2 { display:flex; gap:8px; align-items:baseline; margin:0 0 10px; font-size:20px; }
    .share-folder h2 small, .share-project h3 small { color:var(--muted); font-size:12px; font-weight:700; text-transform:uppercase; }
    .share-project { margin:14px 0 0; padding-left:14px; border-left:3px solid #b7e4ea; }
    .share-project h3 { display:flex; gap:8px; align-items:baseline; margin:0 0 8px; font-size:16px; }
    .share-entry { padding:10px 0; border-top:1px dashed var(--line); }
    .share-entry:first-of-type { border-top:0; }
    .share-entry h4 { margin:0 0 4px; font-size:15px; }
    .share-entry p { color:var(--muted); font-size:14px; }
    .share-entry small { color:var(--muted); }
    .magclaw-share-footer { max-width:900px; margin:24px auto 0; padding-top:14px; border-top:1px solid var(--line); color:var(--muted); font-size:13px; }
  </style>
</head>
<body>
  <main>
    <section class="shell">
      <div class="brand">MagClaw QuickShare</div>
      ${innerHtml}
    </section>
    ${shareFooterHtml(share)}
  </main>
</body>
</html>`;
}

function renderShareHtml(share = {}) {
  const title = htmlEscape(share.title || 'Shared page');
  const content = String(share.content || '');
  if (share.contentType === 'html') {
    const footer = shareFooterHtml(share);
    if (/^<!doctype html/i.test(content.trim()) || /^<html[\s>]/i.test(content.trim())) {
      return /<\/body>/i.test(content)
        ? content.replace(/<\/body>/i, `${footer}\n</body>`)
        : `${content}\n${footer}`;
    }
    return shareChromeHtml(share, `<h1>${title}</h1>\n${content}`);
  }
  if (share.contentType === 'svg') {
    const svg = content.trim().startsWith('<svg') ? content : `<pre><code>${htmlEscape(content)}</code></pre>`;
    return shareChromeHtml(share, `<h1>${title}</h1>\n${svg}`);
  }
  if (share.contentType === 'mermaid') {
    return shareChromeHtml(share, `<h1>${title}</h1>
<pre class="mermaid">${htmlEscape(content.replace(/^```mermaid\s*/i, '').replace(/```$/i, '').trim())}</pre>
<script type="module">
  import mermaid from 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs';
  mermaid.initialize({ startOnLoad: true, securityLevel: 'strict' });
</script>`);
  }
  return shareChromeHtml(share, renderMarkdownToHtml(content));
}

function sendShareHtml(res, body, { status = 200 } = {}) {
  res.writeHead?.(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'public, max-age=60',
    'content-security-policy': "sandbox allow-scripts allow-forms allow-popups; default-src 'self' https: data: blob:; script-src 'self' https: 'unsafe-inline'; style-src 'self' https: 'unsafe-inline'; img-src 'self' https: data: blob:; font-src 'self' https: data:;",
  });
  res.end?.(body);
}

function shareChannelFolderLabel(share = {}) {
  return String(share.channelPath || share.channelId || 'Unconfigured Channel').trim();
}

function shareProjectFolderLabel(share = {}) {
  return String(share.projectKey || 'Unconfigured Project').trim();
}

function renderShareIndexHtml(shares = []) {
  const grouped = new Map();
  for (const share of shares.slice().reverse()) {
    const channel = shareChannelFolderLabel(share);
    const project = shareProjectFolderLabel(share);
    if (!grouped.has(channel)) grouped.set(channel, new Map());
    const projects = grouped.get(channel);
    if (!projects.has(project)) projects.set(project, []);
    projects.get(project).push(share);
  }
  const folders = [...grouped.entries()].map(([channel, projects]) => `
    <section class="share-folder">
      <h2><small>Channel</small> ${htmlEscape(channel)}</h2>
      ${[...projects.entries()].map(([project, items]) => `
        <div class="share-project">
          <h3><small>Project</small> ${htmlEscape(project)}</h3>
          ${items.map((share) => `
            <article class="share-entry">
              <h4><a href="/s/${encodeURIComponent(share.id)}">${htmlEscape(share.title || share.id)}</a></h4>
              <p>${htmlEscape(compactText(share.description || share.content || '', 180))}</p>
              <small>${htmlEscape(share.contentType || 'artifact')} · Created by ${htmlEscape(share.creator?.name || 'Unknown creator')} · ${htmlEscape(share.createdAt || '')}</small>
            </article>
          `).join('')}
        </div>
      `).join('')}
    </section>
  `).join('\n') || '<p>No shared pages yet.</p>';
  return shareChromeHtml(
    { title: 'MagClaw Share Root', creator: { name: 'MagClaw' }, createdAt: '' },
    `<h1>MagClaw Share Root</h1>
    <p class="share-root-intro">Server-level share root. Shares are grouped by the configured Channel path and project key.</p>
    ${folders}`,
  );
}

function shareRootWorkspaceId(state = {}) {
  return String(
    state.connection?.workspaceId
    || state.cloud?.workspace?.id
    || state.cloud?.workspaces?.[0]?.id
    || 'local',
  ).trim();
}

function shareRootAccess(req, { actor, teamSharingState, state } = {}) {
  const workspaceId = shareRootWorkspaceId(state);
  const actorWorkspaceId = String(actor?.member?.workspaceId || '').trim();
  if (actorWorkspaceId) {
    if (!workspaceId || workspaceId === 'local' || actorWorkspaceId === workspaceId) {
      return { ok: true, workspaceId, actorId: actorHumanId(actor), via: 'actor' };
    }
    return { ok: false, status: 403, workspaceId, actorId: actorHumanId(actor), error: 'This share root is only available to members of this server.' };
  }
  const tokenRecord = tokenRecordForRequest(teamSharingState, req);
  if (tokenRecord) {
    const tokenWorkspaceId = String(tokenRecord.workspaceId || '').trim();
    if (!workspaceId || workspaceId === 'local' || tokenWorkspaceId === workspaceId) {
      return { ok: true, workspaceId, actorId: tokenRecord.user?.id || '', via: 'token' };
    }
    return { ok: false, status: 403, workspaceId, actorId: tokenRecord.user?.id || '', error: 'This share root is only available to members of this server.' };
  }
  return { ok: false, status: 401, workspaceId, actorId: '', error: 'Sign in to MagClaw and join this server to open the share root.' };
}

function sharesForShareRoot(teamSharingState = {}, workspaceId = '') {
  const shares = ensureTeamSharingShares(teamSharingState);
  const scope = String(workspaceId || '').trim();
  if (!scope || scope === 'local') return shares;
  return shares.filter((share) => String(share.workspaceId || '').trim() === scope);
}

function shareRootDeniedHtml(status = 401, message = '') {
  const title = status === 403 ? 'Server access required' : 'Sign in required';
  return shareChromeHtml(
    { title: 'MagClaw Share Root', creator: { name: 'MagClaw' }, createdAt: '' },
    `<h1>${htmlEscape(title)}</h1><p>${htmlEscape(message || 'Join this server before opening the MagClaw share root.')}</p>`,
  );
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
  <title>MagClaw Team Sharing Context</title>
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
    <h1>MagClaw Team Sharing Context</h1>
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
      fetch('/api/team-sharing/feedback', {
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
      const url = '/api/team-sharing/context/${safeSession}?anchorEventId=' + encodeURIComponent(anchor || '') + '&direction=' + encodeURIComponent(direction) + '&limit=20';
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

function localVectorSearch({ teamSharingState, query = '', channelId = '', projectKey = '', dateRange = null, limit = 40 } = {}) {
  const terms = queryTerms(query);
  const candidates = asArray(teamSharingState?.vectorDocuments)
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

function hashSecret(value = '') {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function randomToken(prefix = 'tm') {
  return `${prefix}_${crypto.randomBytes(24).toString('base64url')}`;
}

function bearerToken(req) {
  return String(req?.headers?.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1] || '';
}

function ensureTeamSharingAuthState(teamSharingState = {}) {
  teamSharingState.auth = teamSharingState.auth && typeof teamSharingState.auth === 'object' ? teamSharingState.auth : {};
  teamSharingState.auth.deviceRequests = teamSharingState.auth.deviceRequests && typeof teamSharingState.auth.deviceRequests === 'object' ? teamSharingState.auth.deviceRequests : {};
  teamSharingState.auth.tokens = teamSharingState.auth.tokens && typeof teamSharingState.auth.tokens === 'object' ? teamSharingState.auth.tokens : {};
  return teamSharingState.auth;
}

function tokenRecordForRequest(teamSharingState = {}, req) {
  const token = bearerToken(req);
  if (!token) return null;
  const record = ensureTeamSharingAuthState(teamSharingState).tokens[hashSecret(token)];
  if (!record || record.revoked) return null;
  return record;
}

function requestUser(actor = {}) {
  return {
    id: actorHumanId(actor),
    email: actor?.member?.email || actor?.user?.email || '',
    name: actor?.member?.name || actor?.user?.name || '',
  };
}

function requireTeamSharingAuth(req, res, { actor, teamSharingState, sendError, teamSharingAuthRequired, validTeamSharingToken } = {}) {
  const required = typeof teamSharingAuthRequired === 'function' ? teamSharingAuthRequired(req) : Boolean(teamSharingAuthRequired);
  if (!required || actor) return true;
  if (typeof validTeamSharingToken === 'function' && validTeamSharingToken(req)) return true;
  if (tokenRecordForRequest(teamSharingState, req)) return true;
  sendError(res, 401, 'Team sharing login or scoped token is required.');
  return false;
}

export async function handleTeamSharingApi(req, res, url, deps) {
  const {
    addSystemEvent = () => {},
    broadcastState = () => {},
    currentActor = () => null,
    embeddingProbe = null,
    embeddingReady = null,
    getState,
    indexTeamSharingDocuments = null,
    makeId,
    now,
    persistState = async () => {},
    readJson,
    rerank = null,
    rerankReady = null,
    sendError,
    sendJson,
    teamSharingAuthRequired = null,
    validTeamSharingToken = null,
    vectorSearch = null,
    zillizReady = null,
  } = deps;
  const state = getState();
  const actor = currentActor(req);
  const workspaceId = actorWorkspaceId(actor, state);
  const teamSharingState = state.teamSharing || {};
  if (!state.teamSharing) state.teamSharing = teamSharingState;

  if (req.method === 'POST' && url.pathname === '/api/team-sharing/auth/start') {
    const body = await readJson(req);
    const auth = ensureTeamSharingAuthState(teamSharingState);
    const deviceCode = randomToken('tmdev');
    const userCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const request = {
      deviceCodeHash: hashSecret(deviceCode),
      userCode,
      workspaceId: body.workspaceId || workspaceId,
      profile: body.profile || 'default',
      packageName: body.packageName || 'team-sharing',
      status: actor ? 'approved' : 'pending',
      approvedUser: actor ? requestUser(actor) : null,
      createdAt: now(),
      expiresAt,
    };
    auth.deviceRequests[request.deviceCodeHash] = request;
    await persistState({ workspaceId, reason: 'team_sharing_auth_start' });
    sendJson(res, 201, {
      ok: true,
      deviceCode,
      userCode,
      verificationUri: `/team-sharing/auth/approve?user_code=${encodeURIComponent(userCode)}`,
      expiresAt,
      intervalMs: 2000,
      status: request.status,
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/team-sharing/auth/token') {
    const body = await readJson(req);
    const auth = ensureTeamSharingAuthState(teamSharingState);
    const request = auth.deviceRequests[hashSecret(body.deviceCode || body.device_code || '')];
    if (!request) {
      sendJson(res, 200, { ok: true, status: 'pending' });
      return true;
    }
    if (String(request.expiresAt || '') < now()) {
      request.status = 'expired';
      sendJson(res, 200, { ok: true, status: 'expired', error: 'Team Sharing login expired.' });
      return true;
    }
    if (request.status !== 'approved') {
      sendJson(res, 200, { ok: true, status: request.status || 'pending' });
      return true;
    }
    const token = randomToken('tm');
    const tokenHash = hashSecret(token);
    auth.tokens[tokenHash] = {
      tokenHash,
      workspaceId: request.workspaceId || workspaceId,
      profile: request.profile || 'default',
      packageName: request.packageName || 'team-sharing',
      user: request.approvedUser || { id: 'hum_local', email: '', name: '' },
      scopes: ['team_sharing:sync', 'team_sharing:search', 'team_sharing:context', 'team_sharing:feedback', 'team_sharing:share'],
      revoked: false,
      createdAt: now(),
      lastUsedAt: now(),
    };
    delete auth.deviceRequests[request.deviceCodeHash];
    await persistState({ workspaceId: request.workspaceId || workspaceId, reason: 'team_sharing_auth_token' });
    sendJson(res, 200, {
      ok: true,
      status: 'approved',
      token,
      workspaceId: request.workspaceId || workspaceId,
      profile: request.profile || 'default',
      user: auth.tokens[tokenHash].user,
      scopes: auth.tokens[tokenHash].scopes,
    });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/team-sharing/auth/whoami') {
    const record = actor
      ? { workspaceId, profile: 'browser', user: requestUser(actor), scopes: ['browser_session'] }
      : tokenRecordForRequest(teamSharingState, req);
    if (!record) {
      sendError(res, 401, 'Team sharing login is required.');
      return true;
    }
    record.lastUsedAt = now();
    sendJson(res, 200, { ok: true, workspaceId: record.workspaceId, profile: record.profile, user: record.user, scopes: record.scopes });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/team-sharing/auth/revoke') {
    const record = tokenRecordForRequest(teamSharingState, req);
    if (!record) {
      sendError(res, 401, 'Team sharing login is required.');
      return true;
    }
    record.revoked = true;
    record.revokedAt = now();
    await persistState({ workspaceId: record.workspaceId || workspaceId, reason: 'team_sharing_auth_revoke' });
    sendJson(res, 200, { ok: true, revoked: true });
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/team-sharing/auth/approve') {
    const userCode = String(url.searchParams.get('user_code') || '').trim().toUpperCase();
    const auth = ensureTeamSharingAuthState(teamSharingState);
    const request = Object.values(auth.deviceRequests).find((item) => item.userCode === userCode);
    if (!request) {
      sendError(res, 404, 'Team Sharing login request not found.');
      return true;
    }
    if (!actor) {
      sendError(res, 401, 'Sign in to MagClaw before approving Team Sharing login.');
      return true;
    }
    request.status = 'approved';
    request.approvedUser = requestUser(actor);
    request.approvedAt = now();
    await persistState({ workspaceId: request.workspaceId || workspaceId, reason: 'team_sharing_auth_approve' });
    res.writeHead?.(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end?.('<!doctype html><meta charset="utf-8"><title>MagClaw Team Sharing</title><p>Team Sharing login approved. You can return to the CLI.</p>');
    return true;
  }

  const publicShareMatch = url.pathname.match(/^\/s\/([^/]+)$/) || url.pathname.match(/^\/share\/([^/]+)$/);
  if (req.method === 'GET' && publicShareMatch) {
    const shareId = decodeURIComponent(publicShareMatch[1] || '');
    const share = ensureTeamSharingShares(teamSharingState).find((item) => item.id === shareId && item.revokedAt == null);
    if (!share) {
      sendShareHtml(res, shareChromeHtml({ title: 'MagClaw QuickShare' }, '<h1>Shared page not found</h1><p>This MagClaw share link may have been removed.</p>'), { status: 404 });
      return true;
    }
    sendShareHtml(res, renderShareHtml(share));
    return true;
  }

  if (req.method === 'GET' && (url.pathname === '/share' || url.pathname === '/share/')) {
    const access = shareRootAccess(req, { actor, teamSharingState, state });
    if (!access.ok) {
      addSystemEvent('team_sharing_share_root_denied', 'Team sharing share root access denied.', {
        workspaceId: access.workspaceId || workspaceId,
        actorId: access.actorId || '',
        status: access.status,
      });
      sendShareHtml(res, shareRootDeniedHtml(access.status, access.error), { status: access.status });
      return true;
    }
    sendShareHtml(res, renderShareIndexHtml(sharesForShareRoot(teamSharingState, access.workspaceId)));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/team-sharing/shares') {
    if (!requireTeamSharingAuth(req, res, { actor, teamSharingState, sendError, teamSharingAuthRequired, validTeamSharingToken })) return true;
    const body = await readJson(req);
    const content = String(body.content || body.markdown || body.html || body.svg || body.mermaid || '');
    if (!content.trim()) {
      sendError(res, 400, 'Share content is required.');
      return true;
    }
    if (content.length > MAX_SHARE_CONTENT_LENGTH) {
      sendError(res, 413, 'Share content is too large.');
      return true;
    }
    const createdAt = now();
    const shareId = typeof makeId === 'function' ? makeId('share') : randomToken('share');
    const share = {
      id: shareId,
      workspaceId: String(body.workspaceId || workspaceId || '').trim(),
      channelId: String(body.channelId || '').trim(),
      channelPath: String(body.channelPath || '').trim(),
      projectKey: String(body.projectKey || '').trim(),
      title: compactText(body.title || body.name || 'MagClaw shared page', 140),
      description: compactText(body.description || content, 260),
      contentType: normalizeShareContentType(body.contentType || body.type, content),
      content,
      creator: creatorFromActor(actor),
      source: body.source && typeof body.source === 'object' ? body.source : {},
      public: true,
      createdAt,
      updatedAt: createdAt,
    };
    ensureTeamSharingShares(teamSharingState).push(share);
    addSystemEvent('team_sharing_share_created', `Team sharing share created: ${share.title}`, {
      workspaceId: share.workspaceId,
      shareId,
      channelId: share.channelId,
      projectKey: share.projectKey,
      contentType: share.contentType,
    });
    await persistState({ workspaceId: share.workspaceId || workspaceId, reason: 'team_sharing_share_created' });
    broadcastState();
    sendJson(res, 201, {
      ok: true,
      shareId,
      url: shareUrl(req, shareId),
      share: {
        id: share.id,
        title: share.title,
        contentType: share.contentType,
        creator: share.creator,
        createdAt: share.createdAt,
        channelId: share.channelId,
        channelPath: share.channelPath,
        projectKey: share.projectKey,
      },
    });
    return true;
  }

  const contextPageMatch = url.pathname.match(/^\/team-sharing\/context\/([^/]+)$/);
  if (req.method === 'GET' && contextPageMatch) {
    if (!requireTeamSharingAuth(req, res, { actor, teamSharingState, sendError, teamSharingAuthRequired, validTeamSharingToken })) return true;
    sendContextHtml(res, {
      sessionId: decodeURIComponent(contextPageMatch[1]),
      anchorEventId: sourceAnchorFromSearchParams(url.searchParams),
      vectorDocumentId: url.searchParams.get('vectorDocumentId') || '',
      queryId: url.searchParams.get('queryId') || '',
      sourceRef: url.searchParams.get('sourceRef') || '',
    });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/team-sharing/sync') {
    if (!requireTeamSharingAuth(req, res, { actor, teamSharingState, sendError, teamSharingAuthRequired, validTeamSharingToken })) return true;
    const body = await readJson(req);
    const result = await syncTeamSharingBatch({
      ...body,
      workspaceId: body.workspaceId || workspaceId,
      humanId: body.humanId || actorHumanId(actor),
    }, {
      state,
      makeId,
      now,
    });
    if (!result.ok) {
      sendError(res, result.code === 'channel_not_found' ? 404 : 400, result.error || 'Team sharing sync failed.');
      return true;
    }
    if (!result.duplicate && result.appendedEventCount > 0 && typeof indexTeamSharingDocuments === 'function') {
      const documents = asArray(state.teamSharing?.vectorDocuments)
        .filter((doc) => doc.sessionId === result.sessionId && doc.active !== false);
      try {
        const indexed = await indexTeamSharingDocuments({
          workspaceId,
          sessionId: result.sessionId,
          documents,
          teamSharingState: state.teamSharing || {},
        });
        result.indexedDocumentCount = Number(indexed?.count || documents.length || 0);
      } catch (error) {
        result.indexedDocumentCount = 0;
        result.indexError = 'Team sharing vector indexing failed.';
        addSystemEvent('team_sharing_index_error', 'Team sharing vector indexing failed.', {
          workspaceId,
          sessionId: result.sessionId,
          message: String(error?.message || error).slice(0, 300),
        });
      }
    }
    addSystemEvent('team_sharing_sync', `Team sharing synced ${result.appendedEventCount} event(s).`, {
      workspaceId,
      sessionId: result.sessionId,
      messageId: result.messageId,
      duplicate: result.duplicate,
    });
    await persistState({ workspaceId, reason: 'team_sharing_sync' });
    broadcastState();
    sendJson(res, result.duplicate ? 200 : 202, result);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/team-sharing/search') {
    if (!requireTeamSharingAuth(req, res, { actor, teamSharingState, sendError, teamSharingAuthRequired, validTeamSharingToken })) return true;
    const body = await readJson(req);
    const limit = Math.max(1, Math.min(20, Number(body.limit || 5)));
    const candidateK = Math.max(limit, Math.min(200, Number(body.candidateK || 40)));
    if (typeof zillizReady === 'function' && !zillizReady()) {
      sendError(res, 503, 'Team sharing vector index is not ready.');
      return true;
    }
    const vector = vectorSearch
      ? await vectorSearch({
        teamSharingState,
        query: body.query || '',
        channelId: body.channelId || '',
        projectKey: body.projectKey || '',
        dateRange: body.dateRange || null,
        limit: candidateK,
        actor,
      })
      : localVectorSearch({
        teamSharingState,
        query: body.query || '',
        channelId: body.channelId || '',
        projectKey: body.projectKey || '',
        dateRange: body.dateRange || null,
        limit: candidateK,
      });
    if (!vector?.ok) {
      sendError(res, 503, vector?.error || 'Team sharing vector search failed.');
      return true;
    }
    const rerankResults = rerank
      ? await rerank({ query: body.query || '', candidates: vector.candidates || [], limit: candidateK })
      : localRerank({ query: body.query || '', candidates: vector.candidates || [] });
    const ranked = rankTeamSharingCandidates({
      query: body.query || '',
      candidates: vector.candidates || [],
      teamSharingState,
      rerankResults,
      now,
      limit,
    });
    for (const item of ranked.results) {
      applyTeamSharingFeedback(teamSharingState, {
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
    addSystemEvent('team_sharing_search', `Team sharing searched: ${compactText(body.query || '', 90)}`, {
      workspaceId,
      queryId: ranked.queryId,
      resultCount: ranked.results.length,
      candidateCount: vector.candidates?.length || 0,
    });
    await persistState({ workspaceId, reason: 'team_sharing_search' });
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

  const contextMatch = url.pathname.match(/^\/api\/team-sharing\/context\/([^/]+)$/);
  if (req.method === 'GET' && contextMatch) {
    if (!requireTeamSharingAuth(req, res, { actor, teamSharingState, sendError, teamSharingAuthRequired, validTeamSharingToken })) return true;
    const sessionId = decodeURIComponent(contextMatch[1]);
    const result = contextWindowForTeamSharingSession(state.teamSharing || {}, sessionId, {
      anchorEventId: sourceAnchorFromSearchParams(url.searchParams),
      direction: url.searchParams.get('direction') || 'around',
      limit: url.searchParams.get('limit') || 20,
    });
    if (!result.ok) {
      sendError(res, 404, 'Team sharing session not found.');
      return true;
    }
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/team-sharing/feedback') {
    if (!requireTeamSharingAuth(req, res, { actor, teamSharingState, sendError, teamSharingAuthRequired, validTeamSharingToken })) return true;
    const body = await readJson(req);
    const result = applyTeamSharingFeedback(state.teamSharing || {}, {
      ...body,
      workspaceId,
      actorId: body.actorId || actorHumanId(actor),
      createdAt: body.createdAt || now(),
    });
    if (!result.ok) {
      sendError(res, 400, 'Invalid team sharing feedback.');
      return true;
    }
    addSystemEvent('team_sharing_feedback', `Team sharing feedback recorded: ${body.eventType || ''}`, {
      workspaceId,
      vectorDocumentId: body.vectorDocumentId || '',
      eventType: body.eventType || '',
    });
    await persistState({ workspaceId, reason: 'team_sharing_feedback' });
    broadcastState();
    sendJson(res, 200, result);
    return true;
  }

  if (req.method === 'GET' && url.pathname === '/api/team-sharing/doctor') {
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
