import {
  applyTeamSharingFeedback,
  contextWindowForTeamSharingSession,
  normalizeTeamSharingSearchMode,
  normalizeTeamSharingSearchSort,
  rankTeamSharingCandidates,
  syncTeamSharingBatch,
} from '../team-sharing.js';
import { TEAM_SHARING_COMMON_LINK_ICONS } from '../team-sharing-link-icons.js';
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

function scriptJson(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
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
  const anchorEventId = String(item.rawEventId || '').trim() || sourceAnchorEventId(item.sourceRef);
  if (anchorEventId) params.set('anchorEventId', anchorEventId);
  params.set('limit', '21');
  params.set('order', 'asc');
  if (item.vectorDocumentId) params.set('vectorDocumentId', item.vectorDocumentId);
  if (queryId) params.set('queryId', queryId);
  if (item.sourceRef) params.set('sourceRef', item.sourceRef);
  const suffix = params.toString();
  return `/team-sharing/context/${encodeURIComponent(item.sessionId)}${suffix ? `?${suffix}` : ''}`;
}

const SHARE_CONTENT_TYPES = new Set(['html', 'markdown', 'svg', 'mermaid']);
const MAX_SHARE_CONTENT_LENGTH = 10 * 1024 * 1024;
const TEAM_SHARING_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 30;
const MACHINE_FINGERPRINT_PATTERN = /^mfp_[a-f0-9]{64}$/;

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

function creatorFromActor(actor = {}, tokenRecord = null) {
  const member = actor?.member || {};
  const user = actor?.user || actor?.human || tokenRecord?.user || {};
  const id = String(member.humanId || user.id || 'hum_local').trim();
  const displayName = String(member.name || user.name || member.email || user.email || id || 'Unknown creator').trim();
  return {
    id,
    name: displayName,
    email: String(member.email || user.email || '').trim(),
  };
}

function formatChinaDateTime(value = '') {
  const date = new Date(value || '');
  if (!Number.isFinite(date.getTime())) return String(value || '').trim();
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date).reduce((memo, part) => {
    if (part.type !== 'literal') memo[part.type] = part.value;
    return memo;
  }, {});
  return `${parts.year}年${parts.month}月${parts.day}日 ${parts.hour}:${parts.minute}:${parts.second}`;
}

function shareFooterHtml(share = {}) {
  const creator = share.creator?.name || share.createdByName || share.createdBy || 'Unknown creator';
  const createdAt = formatChinaDateTime(share.createdAt || '');
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
  <title>${htmlEscape(share.title || 'Team Shares')}</title>
  <style>
    :root { color-scheme: light; --ink:#14212b; --muted:#64748b; --line:#d9e2e5; --bg:#f8fafc; --panel:#fff; --accent:#0891b2; }
    * { box-sizing:border-box; }
    body { margin:0; background:var(--bg); color:var(--ink); font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; line-height:1.62; }
    main { max-width:900px; margin:0 auto; padding:28px 18px 80px; }
    .shell { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:28px; box-shadow:0 8px 30px rgba(15,23,42,.05); }
    .brand { color:var(--accent); font-size:13px; font-weight:800; text-transform:uppercase; letter-spacing:0; margin:0; }
    h1,h2,h3,h4 { line-height:1.25; letter-spacing:0; }
    h1 { margin:0 0 14px; font-size:32px; }
    p { margin:10px 0; }
    pre { overflow-x:auto; background:#0f1720; color:#d9f4f6; padding:14px; border-radius:8px; }
    code { font-family:"SFMono-Regular",Consolas,"Liberation Mono",monospace; }
    blockquote { margin:12px 0; padding:8px 12px; border-left:3px solid #9ecfe1; border-radius:0 7px 7px 0; background:#f2f8fb; color:#3f6474; }
    a { color:var(--accent); }
    svg { max-width:100%; height:auto; }
    .share-root-head { display:flex; align-items:center; justify-content:space-between; gap:14px; margin-bottom:16px; }
    .share-root-actions { display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end; }
    .share-root-actions button { border:1px solid var(--line); background:#fff; color:var(--ink); border-radius:6px; padding:7px 10px; font-size:12px; font-weight:800; cursor:pointer; transition:border-color .16s ease, color .16s ease, transform .16s ease; }
    .share-root-actions button:hover, .share-root-actions button:focus-visible { border-color:var(--accent); color:var(--accent); transform:translateY(-1px); outline:0; }
    .share-channel { border-top:1px solid var(--line); padding-top:14px; margin-top:16px; }
    .share-channel:first-of-type { border-top:0; padding-top:0; margin-top:0; }
    .share-channel summary { list-style:none; display:flex; align-items:center; gap:8px; cursor:pointer; user-select:none; font-size:20px; font-weight:800; line-height:1.2; }
    .share-channel summary::-webkit-details-marker { display:none; }
    .share-channel-caret { display:inline-grid; place-items:center; width:16px; height:16px; color:var(--accent); transform:rotate(0deg); transition:transform .18s ease; }
    .share-channel[open] .share-channel-caret { transform:rotate(90deg); }
    .share-channel-count { color:var(--muted); font-size:12px; font-weight:800; text-transform:uppercase; }
    .share-channel-content { display:grid; gap:10px; overflow:hidden; padding:12px 0 2px 24px; }
    .share-channel[open] .share-channel-content { animation:share-channel-open .18s ease; }
    .share-entry { display:block; border:1px solid var(--line); border-radius:8px; padding:12px 14px; background:#fff; text-decoration:none; color:inherit; transition:border-color .16s ease, box-shadow .16s ease, transform .16s ease; }
    .share-entry:hover, .share-entry:focus-visible { border-color:var(--accent); box-shadow:0 8px 22px rgba(8,145,178,.11); transform:translateY(-1px); outline:0; }
    .share-entry h2 { margin:0 0 5px; font-size:15px; color:var(--accent); }
    .share-entry p { color:var(--muted); font-size:14px; margin:0 0 8px; }
    .share-entry small { color:var(--muted); display:block; }
    .magclaw-share-footer { max-width:900px; margin:24px auto 0; padding-top:14px; border-top:1px solid var(--line); color:var(--muted); font-size:13px; }
    @keyframes share-channel-open { from { opacity:0; transform:translateY(-4px); } to { opacity:1; transform:translateY(0); } }
    @media (max-width: 640px) { .share-root-head { align-items:flex-start; flex-direction:column; } .share-root-actions { justify-content:flex-start; } }
  </style>
</head>
<body>
  <main>
    <section class="shell">
          ${share.hideChromeBrand ? '' : '<div class="brand">Team Shares</div>'}
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

function displayShareChannelName(value = '') {
  const raw = String(value || 'Unconfigured Channel').trim();
  const parts = raw
    .replace(/^[a-z][a-z0-9-]*:\/\//i, '')
    .split(/[/>]+/g)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !/^(manual[-_\s]?upload|manual|upload)$/i.test(part));
  return parts.at(-1) || raw;
}

function renderShareIndexHtml(shares = []) {
  const grouped = new Map();
  for (const share of shares.slice().reverse()) {
    const channel = displayShareChannelName(shareChannelFolderLabel(share));
    if (!grouped.has(channel)) grouped.set(channel, []);
    grouped.get(channel).push(share);
  }
  const folders = [...grouped.entries()].map(([channel, items]) => `
    <details class="share-channel" open>
      <summary><span class="share-channel-caret">▸</span><span># ${htmlEscape(channel)}</span><span class="share-channel-count">${items.length}</span></summary>
      <div class="share-channel-content">
        ${items.map((share) => `
          <a class="share-entry" href="/s/${encodeURIComponent(share.id)}">
            <h2>${htmlEscape(share.title || share.id)}</h2>
            <p>${htmlEscape(compactText(share.description || share.content || '', 180))}</p>
            <small>${htmlEscape(share.contentType || 'artifact')} · 创建者 ${htmlEscape(share.creator?.name || 'Unknown creator')} · ${htmlEscape(formatChinaDateTime(share.createdAt || ''))}</small>
          </a>
        `).join('')}
      </div>
    </details>
  `).join('\n') || '<p>No shared pages yet.</p>';
  const controls = `
    <div class="share-root-head">
      <div class="brand">Team Shares</div>
      <div class="share-root-actions" aria-label="Team Shares view controls">
        <button type="button" data-share-root-action="expand-all">全部展开</button>
        <button type="button" data-share-root-action="collapse-all">全部折叠</button>
      </div>
    </div>
  `;
  const script = `
    <script>
      (() => {
        const channels = () => [...document.querySelectorAll('.share-channel')];
        const animateChannel = (details, shouldOpen) => {
          const content = details.querySelector('.share-channel-content');
          if (!content) {
            details.open = shouldOpen;
            return;
          }
          if (shouldOpen) {
            details.open = true;
            content.animate([{ opacity: 0, transform: 'translateY(-4px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 180, easing: 'ease-out' });
            return;
          }
          const height = content.scrollHeight;
          const animation = content.animate([{ opacity: 1, maxHeight: height + 'px' }, { opacity: 0, maxHeight: '0px' }], { duration: 170, easing: 'ease-in' });
          animation.onfinish = () => { details.open = false; };
        };
        document.addEventListener('click', (event) => {
          const action = event.target.closest('[data-share-root-action]')?.dataset?.shareRootAction;
          if (action) {
            channels().forEach((details) => animateChannel(details, action === 'expand-all'));
            return;
          }
          const summary = event.target.closest('.share-channel > summary');
          if (!summary) return;
          event.preventDefault();
          animateChannel(summary.parentElement, !summary.parentElement.open);
        });
      })();
    </script>
  `;
  return shareChromeHtml(
    { title: 'Team Shares', creator: { name: 'MagClaw' }, createdAt: '', hideChromeBrand: true },
    `${controls}${folders}${script}`,
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

function shareRootPathWorkspaceId(url, state = {}) {
  const match = String(url?.pathname || '').match(/^\/s\/([^/]+)\/share\/?$/);
  if (!match) return '';
  const slug = decodeURIComponent(match[1] || '').trim();
  if (!slug) return '';
  const workspace = asArray(state.cloud?.workspaces).find((item) => (
    String(item.slug || '').trim() === slug
    || String(item.id || '').trim() === slug
  ));
  return String(workspace?.id || slug).trim();
}

function shareRootAccess(req, { actor, teamSharingState, state, targetWorkspaceId = '' } = {}) {
  const workspaceId = String(targetWorkspaceId || shareRootWorkspaceId(state)).trim();
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

function shareAccess(req, { actor, teamSharingState, share } = {}) {
  const workspaceId = String(share?.workspaceId || '').trim();
  const actorWorkspaceId = String(actor?.member?.workspaceId || '').trim();
  if (actorWorkspaceId) {
    if (!workspaceId || workspaceId === 'local' || actorWorkspaceId === workspaceId) {
      return { ok: true, workspaceId, actorId: actorHumanId(actor), via: 'actor' };
    }
    return { ok: false, status: 403, workspaceId, actorId: actorHumanId(actor), error: 'This shared page is only available to members of this server.' };
  }
  const tokenRecord = tokenRecordForRequest(teamSharingState, req);
  if (tokenRecord) {
    const tokenWorkspaceId = String(tokenRecord.workspaceId || '').trim();
    if (!workspaceId || workspaceId === 'local' || tokenWorkspaceId === workspaceId) {
      return { ok: true, workspaceId, actorId: tokenRecord.user?.id || '', via: 'token' };
    }
    return { ok: false, status: 403, workspaceId, actorId: tokenRecord.user?.id || '', error: 'This shared page is only available to members of this server.' };
  }
  return { ok: false, status: 401, workspaceId, actorId: '', error: 'Sign in to MagClaw and join this server to open the shared page.' };
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
    { title: 'Team Shares', creator: { name: 'MagClaw' }, createdAt: '' },
    `<h1>${htmlEscape(title)}</h1><p>${htmlEscape(message || 'Join this server before opening the MagClaw share root.')}</p>`,
  );
}

function teamSharingWorkspaceFile(path = '', content = '', extra = {}) {
  const cleanPath = String(path || '').trim();
  const name = cleanPath.split('/').filter(Boolean).at(-1) || cleanPath;
  const previewKind = cleanPath.endsWith('.json') ? 'json' : 'markdown';
  return {
    path: cleanPath,
    name,
    kind: 'file',
    previewKind,
    bytes: Buffer.byteLength(String(content || ''), 'utf8'),
    content,
    ...extra,
  };
}

function teamSharingWorkspaceFolder(path = '', name = '') {
  const cleanPath = String(path || '').trim();
  return {
    path: cleanPath,
    name: name || cleanPath.split('/').filter(Boolean).at(-1) || cleanPath,
    kind: 'folder',
  };
}

function sourceContextUrlForEvent(sessionId = '', eventId = '') {
  const params = new URLSearchParams();
  if (eventId) params.set('anchorEventId', eventId);
  params.set('limit', '21');
  params.set('order', 'asc');
  return `/team-sharing/context/${encodeURIComponent(sessionId)}${params.toString() ? `?${params.toString()}` : ''}`;
}

function workspaceSourceEventId(markdown = '', fallbackIds = []) {
  const text = String(markdown || '');
  const rawIdMatch = text.match(/(?:^|\n)\s*(?:[-*+]\s+)?Raw ID[:：]\s*`?([^\s`]+)`?/i);
  if (rawIdMatch?.[1]) return rawIdMatch[1];
  const contextLinkMatch = text.match(/\/team-sharing\/context\/[^)\s?]+[^)\s]*[?&]anchorEventId=([^&)\s]+)/);
  if (contextLinkMatch?.[1]) {
    try {
      return decodeURIComponent(contextLinkMatch[1]);
    } catch {
      return contextLinkMatch[1];
    }
  }
  return asArray(fallbackIds).map((item) => String(item || '').trim()).find(Boolean) || '';
}

function stripWorkspaceSourceBlocks(markdown = '') {
  return String(markdown || '').split('\n').filter((line) => {
    const text = line.trim();
    if (!text) return true;
    if (/^(?:[-*+]\s+)?Raw ID[:：]/i.test(text)) return false;
    if (/^(?:[-*+]\s+)?原文[:：]\s*$/.test(text)) return false;
    if (/^(?:[-*+]\s+)?原文[:：]\s*暂无可定位原文/.test(text)) return false;
    if (/^(?:[-*+]\s+)?\[打开原文\]\(/.test(text)) return false;
    if (/^(?:[-*+]\s+)?\[围绕首条来源打开\]\(/.test(text)) return false;
    return true;
  }).join('\n');
}

function appendWorkspaceInlineSource(markdown = '', sessionId = '', sourceEventId = '') {
  const eventId = String(sourceEventId || '').trim();
  if (!eventId || /\[原文\]\(\/team-sharing\/context\//.test(markdown)) return markdown;
  const suffix = `（[原文](${sourceContextUrlForEvent(sessionId, eventId)})）`;
  const lines = String(markdown || '').split('\n');
  const index = lines.findIndex((line) => {
    const text = line.trim();
    return text
      && !/^#+\s+/.test(text)
      && !/^```/.test(text)
      && !/^\[.+\]\(/.test(text);
  });
  if (index >= 0) lines[index] = `${lines[index]}${suffix}`;
  return lines.join('\n');
}

function normalizeWorkspaceMarkdownSources(markdown = '', { sessionId = '', sourceEventIds = [] } = {}) {
  const sourceEventId = workspaceSourceEventId(markdown, sourceEventIds);
  const stripped = stripWorkspaceSourceBlocks(markdown).replace(/\n{3,}/g, '\n\n').trimEnd();
  return appendWorkspaceInlineSource(stripped, sessionId, sourceEventId);
}

function buildTeamSharingWorkspace(teamSharingState = {}, sessionId = '') {
  const session = teamSharingState.sessions?.[sessionId];
  const abstract = teamSharingState.abstracts?.[sessionId];
  if (!session || !abstract) return null;
  const events = asArray(teamSharingState.events?.[sessionId])
    .slice()
    .sort((left, right) => Number(left.ordinal || 0) - Number(right.ordinal || 0) || String(left.createdAt || '').localeCompare(String(right.createdAt || '')));
  const activities = asArray(teamSharingState.activities)
    .filter((activity) => activity.sessionId === sessionId)
    .slice()
    .sort((left, right) => String(right.createdAt || '').localeCompare(String(left.createdAt || '')));
  const topics = Object.values(abstract.topics || {})
    .sort((left, right) => String(left.title || left.topicId || '').localeCompare(String(right.title || right.topicId || '')));
  const activitiesJson = JSON.stringify(activities.map((activity) => ({
    activityId: activity.activityId || '',
    sessionId: activity.sessionId || sessionId,
    revision: activity.revision || 0,
    action: activity.action || 'merge_summary',
    summary: activity.summary || '',
    changedPaths: asArray(activity.changedPaths),
    sourceEventIds: asArray(activity.sourceEventIds),
    createdAt: activity.createdAt || '',
  })), null, 2);
  const abstractMarkdown = normalizeWorkspaceMarkdownSources(abstract.abstractMarkdown || '', {
    sessionId,
    sourceEventIds: asArray(abstract.sourceEventIds),
  });
  const files = [
    teamSharingWorkspaceFile('abstract.md', abstractMarkdown),
    teamSharingWorkspaceFile('debug-log.md', abstract.debugLogMarkdown || [
      `# ${session.title || 'Team Sharing Session'} Debug Log`,
      '',
      'No sync log entries yet.',
    ].join('\n')),
    teamSharingWorkspaceFile('activities.json', activitiesJson, { previewKind: 'json' }),
    ...topics.map((topic) => {
      const sourceEventIds = asArray(topic.sourceEventIds);
      const markdown = normalizeWorkspaceMarkdownSources(
        topic.overviewMarkdown || `# ${topic.title || topic.topicId}\n\n${topic.overview || ''}`,
        { sessionId, sourceEventIds },
      );
      return teamSharingWorkspaceFile(`topics/${topic.topicId}.md`, markdown, {
        topicId: topic.topicId,
        sourceEventIds,
      });
    }),
  ];
  const folders = [
    teamSharingWorkspaceFolder('topics', 'topics'),
  ];
  return {
    ok: true,
    session: {
      sessionId,
      messageId: session.messageId || '',
      title: session.title || '',
      runtime: session.runtime || '',
      projectKey: session.projectKey || '',
      workspaceId: session.workspaceId || '',
      channelId: session.channelId || '',
      abstractRevision: session.abstractRevision || abstract.revision || 0,
      indexStatus: session.indexStatus || '',
      updatedAt: abstract.updatedAt || session.updatedAt || '',
      eventCount: events.length,
      activityCount: activities.length,
      topicCount: topics.length,
    },
    tree: [
      teamSharingWorkspaceFile('abstract.md', '', { bytes: files.find((file) => file.path === 'abstract.md')?.bytes || 0, content: undefined }),
      teamSharingWorkspaceFile('debug-log.md', '', { bytes: files.find((file) => file.path === 'debug-log.md')?.bytes || 0, content: undefined }),
      teamSharingWorkspaceFile('activities.json', '', { bytes: files.find((file) => file.path === 'activities.json')?.bytes || 0, content: undefined, previewKind: 'json' }),
      folders[0],
      ...topics.map((topic) => teamSharingWorkspaceFile(`topics/${topic.topicId}.md`, '', {
        bytes: files.find((file) => file.path === `topics/${topic.topicId}.md`)?.bytes || 0,
        content: undefined,
      })),
    ],
    files,
    activities,
  };
}

function teamSharingWorkspaceAccess({ actor, tokenRecord, session } = {}) {
  const sessionWorkspaceId = String(session?.workspaceId || '').trim();
  const actorWorkspaceId = String(actor?.member?.workspaceId || '').trim();
  if (actorWorkspaceId) {
    return !sessionWorkspaceId || sessionWorkspaceId === 'local' || actorWorkspaceId === sessionWorkspaceId;
  }
  const tokenWorkspaceId = String(tokenRecord?.workspaceId || '').trim();
  if (tokenWorkspaceId) {
    return !sessionWorkspaceId || sessionWorkspaceId === 'local' || tokenWorkspaceId === sessionWorkspaceId;
  }
  return !sessionWorkspaceId || sessionWorkspaceId === 'local';
}

function sendContextHtml(res, {
  sessionId = '',
  anchorEventId = '',
  vectorDocumentId = '',
  queryId = '',
  sourceRef = '',
  order = 'asc',
  workspaceId = '',
  serverSlug = '',
} = {}) {
  const safeSession = encodeURIComponent(sessionId);
  const initialAnchor = String(anchorEventId || '');
  const contextOrder = String(order || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';
  const isDesc = contextOrder === 'desc';
  const contextWorkspaceId = String(workspaceId || '').trim();
  const contextServerSlug = String(serverSlug || '').trim();
  const iconRegistryJson = scriptJson(TEAM_SHARING_COMMON_LINK_ICONS);
  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MagClaw Team Sharing Context</title>
  <style>
    :root { color-scheme: light; --ink:#111827; --muted:#64748b; --line:#d7dee8; --bg:#f8fafc; --accent:#0891b2; --chip:#e0f2fe; --user-bg:#fff1f5; --user-line:#f9cfe0; --plan-bg:#eefcff; --plan-line:#b9e7f2; --plan-accent:#0891b2; --goal-bg:#f0fdf4; --goal-line:#bbf7d0; --goal-accent:#16a34a; }
    * { box-sizing:border-box; }
    [hidden] { display:none !important; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--ink); }
    header { position:sticky; top:0; z-index:2; padding:16px 20px; border-bottom:1px solid var(--line); background:rgba(248,250,252,.94); backdrop-filter: blur(14px); }
    h1 { margin:0; font-size:20px; letter-spacing:0; line-height:1.28; }
    .meta { margin-top:4px; color:var(--muted); font-size:13px; overflow-wrap:anywhere; }
    main { max-width:920px; margin:0 auto; padding:18px; }
    .controls { display:flex; gap:10px; justify-content:center; margin:12px 0; }
    button { border:1px solid var(--line); background:#fff; color:var(--ink); border-radius:6px; padding:8px 12px; cursor:pointer; }
    button:disabled { opacity:.45; cursor:not-allowed; }
    .scroll-sentinel { height:1px; }
    article.context-event { position:relative; background:#fff; border:1px solid var(--line); border-radius:8px; padding:14px 16px; margin:10px 0; box-shadow:0 1px 2px rgba(15,23,42,.04); }
    article.context-event-agent.has-context-note { overflow:visible; }
    article.context-event-user { background:#fff1f5; border-color:var(--user-line); }
    article.context-event-user .role { background:#ffe4ec; color:#9f1239; }
    article.context-event.anchor { border-color:var(--accent); box-shadow:0 0 0 2px rgba(8,145,178,.12); }
    .role { display:inline-flex; align-items:center; min-height:20px; border-radius:999px; background:var(--chip); padding:2px 8px; font-size:12px; font-weight:800; color:#0f5f76; }
    .time { margin-left:8px; color:var(--muted); font-size:12px; }
    .text,
    .context-main { overflow-wrap:anywhere; line-height:1.65; font-size:14px; }
    .text { margin-top:10px; }
    .context-segments { display:grid; gap:9px; margin-top:10px; }
    .context-quote { border-left:3px solid #9ecfe1; background:#f2f8fb; color:#3f6474; padding:8px 11px; border-radius:0 7px 7px 0; display:grid; gap:4px; }
    .context-quote-label { color:#0f6f89; font-size:11px; font-weight:900; line-height:1.2; }
    .context-quote-text { overflow-wrap:anywhere; line-height:1.56; font-size:13px; }
    .context-mode-panel { margin-top:10px; border:1px solid var(--line); border-left:4px solid var(--accent); border-radius:8px; padding:12px 13px; display:grid; gap:8px; overflow-wrap:anywhere; }
    .context-plan-panel { background:#eefcff; border-color:#b9e7f2; border-left-color:#0891b2; }
    .context-goal-panel { background:#f0fdf4; border-color:#bbf7d0; border-left-color:#16a34a; }
    .context-interaction-panel { background:#fff; border-color:#dbe5ef; border-left-color:#0891b2; }
    .context-mode-head { display:flex; align-items:center; justify-content:space-between; gap:8px; color:#334155; font-size:11px; font-weight:900; line-height:1.2; text-transform:uppercase; letter-spacing:0; }
    .context-plan-panel .context-mode-head { color:#0f6f89; }
    .context-goal-panel .context-mode-head { color:#166534; }
    .context-goal-status { color:#16a34a; font-weight:900; }
    .context-interaction-list { display:grid; gap:10px; }
    .context-question-card { display:grid; gap:7px; border:1px solid #e2e8f0; border-radius:7px; padding:10px 11px; background:#fbfdff; }
    .context-question-head { color:#0f6f89; font-size:11px; font-weight:900; line-height:1.2; }
    .context-question-prompt { margin:0; font-size:14px; font-weight:750; line-height:1.52; color:#1f2937; }
    .context-option-list,
    .context-answer-list { display:flex; flex-wrap:wrap; gap:6px; }
    .context-answer-list { align-items:center; }
    .context-answer-item { display:inline-flex; flex-wrap:wrap; align-items:center; gap:4px; max-width:100%; }
    .context-option-chip,
    .context-answer-chip { display:inline-flex; align-items:center; max-width:100%; min-height:24px; border-radius:999px; padding:2px 8px; font-size:12px; font-weight:800; line-height:1.35; overflow-wrap:anywhere; }
    .context-option-chip { border:1px solid #dbeafe; background:#f8fafc; color:#475569; }
    .context-answer-chip { border:1px solid #bae6fd; background:#e0f2fe; color:#075985; }
    .context-answer-description { display:inline-flex; align-items:center; max-width:100%; border-radius:5px; padding:2px 6px; background:#f1f5f9; color:#475569; font-size:12px; font-weight:700; line-height:1.4; overflow-wrap:anywhere; }
    .context-main a,
    .context-quote a,
    .text a { color:#0369a1; font-weight:700; }
    .context-main a,
    .context-quote a,
    .text a,
    .context-source-link { display:inline-flex; align-items:center; gap:4px; vertical-align:baseline; }
    .context-link-icon { display:inline-grid; place-items:center; width:16px; height:16px; flex:0 0 16px; border:1px solid #dbe5ef; border-radius:4px; background:#fff; color:#334155; overflow:hidden; font-size:7px; font-weight:900; line-height:1; text-transform:uppercase; }
    .context-link-icon-img { display:block; width:12px; height:12px; object-fit:contain; }
    .context-link-icon-fallback { display:inline-grid; place-items:center; width:100%; height:100%; padding-top:1px; }
    .context-link-label { min-width:0; }
    .context-color-swatch { display:inline-block; width:10px; height:10px; margin-left:4px; border:1px solid rgba(15,23,42,.24); border-radius:3px; box-shadow:inset 0 0 0 1px rgba(255,255,255,.56); vertical-align:-1px; }
    .text p,
    .context-main p,
    .context-quote-text p { margin:0 0 10px; }
    .text p:last-child,
    .context-main p:last-child,
    .context-quote-text p:last-child { margin-bottom:0; }
    .text ul,
    .text ol,
    .context-main ul,
    .context-main ol,
    .context-quote-text ul,
    .context-quote-text ol { margin:8px 0 10px; padding-left:24px; }
    .text li,
    .context-main li,
    .context-quote-text li { margin:4px 0; }
    .text code,
    .context-main code,
    .context-quote-text code { background:#eef2f7; border-radius:5px; padding:1px 5px; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:.92em; color:#243244; }
    .text pre,
    .context-main pre,
    .context-quote-text pre { margin:10px 0; padding:10px 12px; overflow:auto; background:#0f172a; color:#e2e8f0; border-radius:7px; }
    .text pre code,
    .context-main pre code,
    .context-quote-text pre code { background:transparent; color:inherit; padding:0; border-radius:0; }
    .text h1,
    .text h2,
    .text h3,
    .context-main h1,
    .context-main h2,
    .context-main h3 { margin:0 0 10px; font-size:16px; line-height:1.45; }
    .text blockquote,
    .context-main blockquote,
    .context-quote-text blockquote { margin:8px 0; border-left:3px solid #cbd5e1; padding-left:10px; color:#475569; }
    .context-table-wrap { width:100%; overflow-x:auto; margin:10px 0 12px; border:1px solid var(--line); border-radius:8px; background:#fff; }
    .context-table { width:100%; border-collapse:collapse; min-width:520px; font-size:13px; line-height:1.55; }
    .context-table th { text-align:left; background:#f1f5f9; color:#334155; font-weight:850; border-bottom:1px solid var(--line); }
    .context-table th,
    .context-table td { padding:9px 11px; vertical-align:top; border-right:1px solid #e5edf4; }
    .context-table th:last-child,
    .context-table td:last-child { border-right:0; }
    .context-table tr + tr td { border-top:1px solid #edf2f7; }
    .context-table tr:hover td { background:#fbfdff; }
    .context-sources { display:flex; align-items:center; flex-wrap:wrap; gap:7px; margin:10px 0 0; color:var(--muted); font-size:13px; }
    .context-sources-label { font-size:11px; font-weight:900; text-transform:uppercase; letter-spacing:0; color:#0f6f89; }
    .context-source-link { min-height:24px; border:1px solid #bae6fd; background:#f0f9ff; color:#0369a1; border-radius:999px; padding:2px 8px; font-weight:800; text-decoration:none; }
    .context-source-link:hover,
    .context-source-link:focus-visible { border-color:#0891b2; background:#e0f2fe; outline:0; }
    .context-note { position:absolute; left:calc(100% + 14px); top:88px; z-index:1; width:264px; min-height:118px; padding:18px 20px 17px; overflow:visible; border:1px solid #c7dde8; border-radius:4px; background:#f7fbfd; color:#334155; box-shadow:0 14px 28px rgba(15,23,42,.10), 0 1px 0 rgba(255,255,255,.82) inset; opacity:0; transform-origin:left top; transform:translate(-10px,-8px) scale(.74) rotate(-2deg); clip-path:polygon(0 0, 0 0, 0 0, 0 0); pointer-events:none; }
    .context-note::before { content:""; position:absolute; left:50%; top:-10px; width:58px; height:18px; transform:translateX(-50%) rotate(-2deg); border:1px solid rgba(8,145,178,.18); border-radius:3px; background:rgba(224,242,254,.78); box-shadow:0 2px 5px rgba(71,85,105,.08); }
    .context-note::after { content:""; position:absolute; right:0; bottom:0; width:28px; height:28px; border-radius:4px 0 3px 0; background:linear-gradient(135deg, rgba(255,255,255,0) 0 49%, rgba(203,226,236,.55) 50%, rgba(240,249,255,.96) 100%); }
    .context-note.is-open { pointer-events:auto; animation:contextNoteUnfold .34s cubic-bezier(.2,.8,.22,1) forwards; }
    .context-note-label { margin:0 0 8px; color:#0f6f89; font-size:11px; font-weight:900; line-height:1.2; }
    .context-note-body { max-height:min(520px, calc(100vh - 180px)); overflow:auto; padding-right:4px; font-size:13px; font-weight:600; line-height:1.52; }
    .context-note-body p,
    .context-note-body ul,
    .context-note-body ol,
    .context-note-body blockquote,
    .context-note-body pre { margin:0 0 8px; }
    .context-note-body p:last-child,
    .context-note-body ul:last-child,
    .context-note-body ol:last-child,
    .context-note-body blockquote:last-child,
    .context-note-body pre:last-child { margin-bottom:0; }
    .context-note-body ul,
    .context-note-body ol { padding-left:18px; }
    .context-note-body li { margin:3px 0; }
    .context-note-body strong { color:#172033; font-weight:850; }
    .context-note-body code { background:#eef2f7; border-radius:4px; padding:1px 4px; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:.92em; color:#243244; }
    .context-note-body a { color:#0369a1; font-weight:800; }
    .context-note-body h1,
    .context-note-body h2,
    .context-note-body h3 { margin:0 0 8px; color:#172033; font-size:13px; line-height:1.35; }
    .context-status { min-height:20px; text-align:center; color:var(--muted); font-size:12px; margin:-4px 0 10px; }
    .empty { color:var(--muted); text-align:center; padding:48px 0; }
    @keyframes contextNoteUnfold {
      0% { opacity:0; transform:translate(-10px,-8px) scale(.74) rotate(-2deg); clip-path:polygon(0 0, 0 0, 0 0, 0 0); }
      62% { opacity:1; transform:translate(-2px,-2px) scale(1.02) rotate(-.4deg); clip-path:polygon(0 0, 100% 0, 82% 100%, 0 76%); }
      100% { opacity:1; transform:translate(0,0) scale(1) rotate(0); clip-path:polygon(0 0, 100% 0, 100% 100%, 0 100%); }
    }
    @media (max-width:1240px) {
      .context-note { position:sticky; left:auto; top:104px; width:min(100%, 430px); margin:12px 0 14px 0; transform:translate(-6px,-6px) scale(.84) rotate(-1deg); }
    }
    @media (prefers-reduced-motion: reduce) {
      .context-note,
      .context-note.is-open { opacity:1; transform:none; clip-path:polygon(0 0, 100% 0, 100% 100%, 0 100%); animation:none; }
    }
  </style>
</head>
<body>
  <header>
    <h1 id="session-title">MagClaw Team Sharing Context</h1>
    <div class="meta" id="session-meta">session: ${htmlEscape(sessionId)} · anchor: ${htmlEscape(initialAnchor || 'latest')} · order: ${htmlEscape(contextOrder === 'desc' ? 'newest first' : 'oldest first')}</div>
  </header>
  <main>
    <div id="top-sentinel" class="scroll-sentinel" aria-hidden="true"></div>
    <div class="controls" hidden><button id="${isDesc ? 'load-more-next' : 'load-more-prev'}" type="button" hidden>${isDesc ? 'Load newer' : 'Load previous'}</button></div>
    <section id="events" aria-live="polite"><div class="empty">Loading context...</div></section>
    <div class="controls" hidden><button id="${isDesc ? 'load-more-prev' : 'load-more-next'}" type="button" hidden>${isDesc ? 'Load older' : 'Load next'}</button></div>
    <div id="context-status" class="context-status" aria-live="polite"></div>
    <div id="bottom-sentinel" class="scroll-sentinel" aria-hidden="true"></div>
  </main>
  <script>
    const sessionId = ${JSON.stringify(sessionId)};
    let anchorEventId = ${JSON.stringify(initialAnchor)};
    const order = ${JSON.stringify(contextOrder)};
    const vectorDocumentId = ${JSON.stringify(String(vectorDocumentId || ''))};
    const queryId = ${JSON.stringify(String(queryId || ''))};
    const sourceRef = ${JSON.stringify(String(sourceRef || ''))};
    const CONTEXT_LINK_ICON_REGISTRY = ${iconRegistryJson};
    const workspaceId = ${JSON.stringify(contextWorkspaceId)};
    const serverSlug = ${JSON.stringify(contextServerSlug)};
    const eventsEl = document.getElementById('events');
    const prevBtn = document.getElementById('load-more-prev');
    const nextBtn = document.getElementById('load-more-next');
    const statusEl = document.getElementById('context-status');
    const topSentinel = document.getElementById('top-sentinel');
    const bottomSentinel = document.getElementById('bottom-sentinel');
    const topDirection = order === 'desc' ? 'next' : 'prev';
    const bottomDirection = order === 'desc' ? 'prev' : 'next';
    const seen = new Set();
    let prevAnchor = anchorEventId;
    let nextAnchor = anchorEventId;
    let hasPrev = false;
    let hasNext = false;
    let initialLoaded = false;
    let initialAnchorScrolled = false;
    const loading = { around: false, prev: false, next: false };
    let scrollCheckTimer = null;
    let openedRecorded = false;
    function escapeHtml(text) {
      return String(text || '').replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
    }
    function splitAutolinkUrl(raw) {
      let href = String(raw || '');
      let trailing = '';
      const trailingUrlChars = new Set([String.fromCharCode(96), "'", '"', ']', ')', ',', '.', ';', ':', '!', '?', '，', '。', '；', '：', '！', '？']);
      while (trailingUrlChars.has(href.slice(-1))) {
        trailing = href.slice(-1) + trailing;
        href = href.slice(0, -1);
      }
      return { href, trailing };
    }
    function stripContextMetadata(text) {
      return String(text || '')
        .replace(/\\s*<oai-mem-citation\\b[^>]*>[\\s\\S]*?(?:<\\/oai-mem-citation>|$)\\s*/gi, '\\n')
        .replace(/\\s*<citation_entries\\b[^>]*>[\\s\\S]*?(?:<\\/citation_entries>|$)\\s*/gi, '\\n')
        .replace(/\\s*<rollout_ids\\b[^>]*>[\\s\\S]*?(?:<\\/rollout_ids>|$)\\s*/gi, '\\n')
        .replace(/\\s*::git-[a-z-]+\\{[^}\\n]*\\}\\s*/gi, '\\n')
        .trim();
    }
    function safeContextHref(href) {
      const value = String(href || '').replace(/&amp;/gi, '&').trim();
      if (/^(https?:|mailto:|\\/)/i.test(value)) return value;
      return '#';
    }
    function renderContextAutolinkedUrls(html) {
      return String(html || '').replace(/https?:\\/\\/[^\\s<]+/g, raw => {
        const parts = splitAutolinkUrl(raw);
        if (!parts.href) return raw;
        return contextLinkHtml(parts.href, parts.href) + escapeHtml(parts.trailing);
      });
    }
    function contextHostForHref(href) {
      const match = String(href || '').match(/^https?:\\/\\/([^\\/?#]+)/i);
      return match ? match[1].replace(/^www\\./i, '').toLowerCase() : '';
    }
    function contextLinkIconEntryForHost(host) {
      const cleanHost = String(host || '').replace(/^www\\./i, '').toLowerCase();
      if (!cleanHost) return null;
      return CONTEXT_LINK_ICON_REGISTRY.find(entry => {
        const hosts = Array.isArray(entry.hosts) ? entry.hosts : [];
        return hosts.some(item => cleanHost === item || cleanHost.endsWith('.' + item));
      }) || null;
    }
    function contextLinkIconSrc(entry) {
      if (!entry) return '';
      const slug = String(entry.slug || '').trim();
      if (slug) return 'https://cdn.simpleicons.org/' + encodeURIComponent(slug);
      const iconHost = String(entry.iconHost || (Array.isArray(entry.hosts) ? entry.hosts[0] : '') || '').trim();
      return iconHost ? 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(iconHost) + '&sz=32' : '';
    }
    function contextLinkIconHtml(href) {
      const host = contextHostForHref(href);
      if (!host) return '';
      const entry = contextLinkIconEntryForHost(host);
      const label = String(entry?.label || host.slice(0, 1).toUpperCase() || '?').slice(0, 4);
      const title = entry?.name || host || 'Link';
      const src = contextLinkIconSrc(entry);
      if (!src) {
        return '<span class="context-link-icon" title="' + escapeHtml(title) + '" aria-hidden="true"><span class="context-link-icon-fallback">' + escapeHtml(label) + '</span></span>';
      }
      return '<span class="context-link-icon" title="' + escapeHtml(title) + '" aria-hidden="true">' +
        '<img class="context-link-icon-img" src="' + escapeHtml(src) + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.hidden=true;this.nextElementSibling.hidden=false">' +
        '<span class="context-link-icon-fallback" hidden>' + escapeHtml(label) + '</span></span>';
    }
    function contextLinkHtml(href, label, className = '') {
      const safeHref = safeContextHref(href);
      const classAttr = className ? ' class="' + escapeHtml(className) + '"' : '';
      const icon = safeHref && safeHref !== '#' ? contextLinkIconHtml(safeHref) : '';
      return '<a' + classAttr + ' href="' + escapeHtml(safeHref) + '" target="_blank" rel="noreferrer">' +
        icon + '<span class="context-link-label">' + escapeHtml(label || safeHref) + '</span></a>';
    }
    function isContextHexColorToken(value) {
      return /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/.test(String(value || '').trim());
    }
    function contextColorSwatchHtml(value) {
      const color = String(value || '').trim();
      if (!isContextHexColorToken(color)) return '';
      const safeColor = escapeHtml(color);
      return '<span class="context-color-swatch" style="background-color: ' + safeColor + '" title="' + safeColor + '" aria-label="Color ' + safeColor + '"></span>';
    }
    function renderContextColorSwatches(html) {
      return String(html || '').replace(/(^|[^\\w/?:#&=.%+-])(#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?)(?![\\w-])/g, (_match, prefix, color) => prefix + color + contextColorSwatchHtml(color));
    }
    function renderContextInline(text) {
      const protectedTokens = [];
      const protect = (html) => {
        const marker = 'CTXINLINE' + protectedTokens.length + 'TOKEN';
        protectedTokens.push(html);
        return marker;
      };
      const tick = String.fromCharCode(96);
      const codePattern = new RegExp(tick + '([^' + tick + ']+)' + tick, 'g');
      let html = escapeHtml(text)
        .replace(codePattern, (_match, code) => protect('<code>' + code + '</code>' + contextColorSwatchHtml(code)))
        .replace(/\\[([^\\]\\n]+)\\]\\(([^)\\n]+)\\)/g, (_match, label, href) => protect(contextLinkHtml(href, label)))
        .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
        .replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
      html = renderContextColorSwatches(html);
      html = renderContextAutolinkedUrls(html);
      protectedTokens.forEach((token, index) => {
        html = html.replaceAll('CTXINLINE' + index + 'TOKEN', token);
      });
      return html;
    }
    function markdownLinksFromLine(line) {
      const links = [];
      String(line || '').replace(/\\[([^\\]\\n]+)\\]\\(([^)\\n]+)\\)/g, (_match, label, href) => {
        const safeHref = safeContextHref(href);
        if (safeHref && safeHref !== '#') links.push({ label: String(label || '').trim(), href: safeHref });
        return '';
      });
      return links;
    }
    function renderContextSourcesLine(line) {
      const match = String(line || '').trim().match(/^Sources?\\s*:\\s*(.+)$/i);
      if (!match) return '';
      const links = markdownLinksFromLine(match[1]);
      if (!links.length) {
        return '<p class="context-sources"><span class="context-sources-label">Sources</span><span>' + renderContextInline(match[1]) + '</span></p>';
      }
      return '<p class="context-sources"><span class="context-sources-label">Sources</span>' +
        links.map(link => contextLinkHtml(link.href, link.label || link.href, 'context-source-link')).join('') +
        '</p>';
    }
    function isContextTableCandidate(line) {
      const trimmed = String(line || '').trim();
      if (!trimmed || !trimmed.includes('|')) return false;
      return trimmed.startsWith('|') || trimmed.endsWith('|') || (trimmed.match(/\\|/g) || []).length >= 2;
    }
    function isContextTableSeparatorRow(cells) {
      return cells.length > 1 && cells.every(cell => /^:?-{3,}:?$/.test(String(cell || '').trim()));
    }
    function splitContextTableRow(row) {
      let text = String(row || '').trim();
      if (text.startsWith('|')) text = text.slice(1);
      if (text.endsWith('|')) text = text.slice(0, -1);
      return text.split('|').map(cell => cell.trim());
    }
    function renderContextTable(lines) {
      const rows = lines.map(splitContextTableRow).filter(row => row.length > 1);
      const separatorIndex = rows.findIndex((row, index) => index > 0 && isContextTableSeparatorRow(row));
      if (separatorIndex <= 0 || !rows[0]) {
        return lines.map(line => '<p>' + renderContextInline(line) + '</p>').join('');
      }
      const columnCount = Math.max(...rows.map(row => row.length));
      const normalizeRow = (row) => Array.from({ length: columnCount }, (_item, index) => row[index] || '');
      const header = normalizeRow(rows[0]);
      const bodyRows = rows.slice(separatorIndex + 1)
        .filter(row => !isContextTableSeparatorRow(row))
        .map(normalizeRow);
      return '<div class="context-table-wrap"><table class="context-table"><thead><tr>' +
        header.map(cell => '<th>' + renderContextInline(cell) + '</th>').join('') +
        '</tr></thead><tbody>' +
        bodyRows.map(row => '<tr>' + row.map(cell => '<td>' + renderContextInline(cell) + '</td>').join('') + '</tr>').join('') +
        '</tbody></table></div>';
    }
    function renderContextList(lines) {
      const tag = /^\\s*\\d+\\./.test(lines[0] || '') ? 'ol' : 'ul';
      return '<' + tag + '>' + lines.map(line => {
        const item = String(line || '').replace(/^\\s*(?:[-*+]|\\d+\\.)\\s+/, '');
        return '<li>' + renderContextInline(item) + '</li>';
      }).join('') + '</' + tag + '>';
    }
        function renderContextMarkdown(text) {
          const lines = stripContextMetadata(text).split(/\\r?\\n/);
          const fence = String.fromCharCode(96).repeat(3);
      const blocks = [];
      let paragraph = [];
      let listLines = [];
      let tableLines = [];
      let inCode = false;
      let codeLines = [];
      const flushParagraph = () => {
        if (!paragraph.length) return;
        blocks.push('<p>' + renderContextInline(paragraph.join(' ')) + '</p>');
        paragraph = [];
      };
      const flushList = () => {
        if (!listLines.length) return;
        blocks.push(renderContextList(listLines));
        listLines = [];
      };
      const flushTable = () => {
        if (!tableLines.length) return;
        blocks.push(renderContextTable(tableLines));
        tableLines = [];
      };
      for (const line of lines) {
        if (String(line || '').startsWith(fence)) {
          if (inCode) {
            blocks.push('<pre><code>' + escapeHtml(codeLines.join('\\n')) + '</code></pre>');
            codeLines = [];
            inCode = false;
          } else {
            flushParagraph();
            flushList();
            flushTable();
            inCode = true;
          }
          continue;
        }
        if (inCode) {
          codeLines.push(line);
          continue;
        }
        if (!line.trim()) {
          flushParagraph();
          flushList();
          flushTable();
          continue;
        }
        const sourcesHtml = renderContextSourcesLine(line);
        if (sourcesHtml) {
          flushParagraph();
          flushList();
          flushTable();
          blocks.push(sourcesHtml);
          continue;
        }
        if (isContextTableCandidate(line)) {
          flushParagraph();
          flushList();
          tableLines.push(line);
          continue;
        }
        const heading = line.match(/^(#{1,6})\\s+(.+)$/);
        if (heading) {
          flushParagraph();
          flushList();
          flushTable();
          const level = Math.min(6, heading[1].length);
          blocks.push('<h' + level + '>' + renderContextInline(heading[2]) + '</h' + level + '>');
          continue;
        }
        if (/^\\s*(?:[-*+]|\\d+\\.)\\s+/.test(line)) {
          flushParagraph();
          flushTable();
          listLines.push(line);
          continue;
        }
        const quote = line.match(/^>\\s?(.+)$/);
        if (quote) {
          flushParagraph();
          flushList();
          flushTable();
          blocks.push('<blockquote>' + renderContextInline(quote[1]) + '</blockquote>');
          continue;
        }
        flushTable();
        paragraph.push(line.trim());
      }
      if (inCode) blocks.push('<pre><code>' + escapeHtml(codeLines.join('\\n')) + '</code></pre>');
      flushParagraph();
      flushList();
          flushTable();
          return blocks.join('') || '<p>' + renderContextInline(text) + '</p>';
        }
        const CONTEXT_NOTE_MIN_CHARS = 1200;
        const CONTEXT_NOTE_MAX_CHARS = 1000;
        function contextEventBodyText(event) {
          const segments = Array.isArray(event?.contentSegments) && event.contentSegments.length
            ? event.contentSegments
            : (Array.isArray(event?.metadata?.contentSegments) ? event.metadata.contentSegments : []);
          const body = segments.find(segment => String(segment?.type || '').toLowerCase() === 'body');
          return body?.text || body?.content || event?.displayText || event?.cleanText || event?.text || '';
        }
        function plainContextNoteText(text) {
          const tick = String.fromCharCode(96);
          const fencePattern = new RegExp(tick + tick + tick + '[\\\\s\\\\S]*?' + tick + tick + tick, 'g');
          const inlineCodePattern = new RegExp(tick + '([^' + tick + ']+)' + tick, 'g');
          return stripContextMetadata(text)
            .replace(fencePattern, ' ')
            .replace(inlineCodePattern, '$1')
            .replace(/\\[([^\\]\\n]+)\\]\\(([^)\\n]+)\\)/g, '$1')
            .replace(/^#{1,6}\\s+/gm, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/[>*_|~]/g, ' ')
            .replace(/\\s+/g, ' ')
            .trim();
        }
        function contextVisibleCharCount(text) {
          return Array.from(plainContextNoteText(text)).length;
        }
        function isContextSectionBoundary(line) {
          const clean = String(line || '').trim();
          if (!clean) return false;
          if (/^#{1,6}\\s+/.test(clean)) return true;
          return /^(?:\\*\\*)?[A-Za-z0-9 _-\\u4e00-\\u9fff]{2,28}(?:\\*\\*)?\\s*[:：]\\s*$/.test(clean);
        }
        function extractContextConclusionText(text) {
          const lines = stripContextMetadata(text).replace(/\\r\\n/g, '\\n').split('\\n');
          for (let index = 0; index < lines.length; index += 1) {
            const line = String(lines[index] || '').trim();
            const match = line.match(/^(?:#{1,6}\\s*)?(?:\\*\\*)?\\s*(核心结论|结论|我的判断|总结|最终结论|处理结果|验证结果|已解决|Outcome|Conclusion|Key Takeaways)\\s*(?:\\*\\*)?\\s*[:：]?\\s*(.*)$/i);
            if (!match) continue;
            const parts = [];
            if (match[2]) parts.push(match[2]);
            for (let cursor = index + 1; cursor < lines.length && parts.join('\\n').length < 900; cursor += 1) {
              const next = String(lines[cursor] || '').trim();
              if (!next && parts.length) break;
              if (parts.length && isContextSectionBoundary(next)) break;
              if (next) parts.push(next);
            }
            const conclusion = plainContextNoteText(parts.join('\\n'));
            if (conclusion) return conclusion;
          }
          return '';
        }
        function contextSessionSummaryHint() {
          const session = window.__teamSharingSession || {};
          return String(session.summaryHint || session.activitySummary || session.abstractSummary || '')
            .replace(/\\r\\n/g, '\\n')
            .replace(/[ \\t]+\\n/g, '\\n')
            .replace(/\\n{3,}/g, '\\n\\n')
            .trim();
        }
        function compactContextNoteSummary(text, limit = CONTEXT_NOTE_MAX_CHARS) {
          const clean = String(text || '')
            .replace(/\\r\\n/g, '\\n')
            .replace(/[ \\t]+\\n/g, '\\n')
            .replace(/\\n{3,}/g, '\\n\\n')
            .trim();
          const chars = Array.from(clean);
          if (chars.length <= limit) return clean;
          return chars.slice(0, Math.max(1, limit - 1)).join('').trimEnd() + '…';
        }
        function contextNoteSummary(event) {
          if (eventPresentation(event)?.mode && eventPresentation(event).mode !== 'normal') return '';
          if (!(event?.role === 'assistant' || event?.role === 'system')) return '';
          const text = contextEventBodyText(event);
          if (contextVisibleCharCount(text) <= CONTEXT_NOTE_MIN_CHARS) return '';
          const hint = contextSessionSummaryHint();
          if (!hint) return '';
          return compactContextNoteSummary(hint, CONTEXT_NOTE_MAX_CHARS);
        }
        function renderContextNote(summary) {
          if (!summary) return '';
          return '<aside class="context-note" data-context-note aria-label="本次长回复摘要">' +
        '<div class="context-note-label">Abstract</div>' +
            '<div class="context-note-body">' + renderContextMarkdown(summary) + '</div></aside>';
        }
        function chinaTime(value) {
          const date = new Date(value || '');
      if (!Number.isFinite(date.getTime())) return value || '';
      return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
      }).format(date);
    }
    function runtimeName(runtime) {
      const clean = String(runtime || '').toLowerCase();
      if (clean === 'claude_code' || clean === 'claude-code' || clean === 'claude') return 'ClaudeCode';
      if (clean === 'codex') return 'Codex';
      return clean || 'Assistant';
    }
    function roleLabel(event, session) {
      if (event.role === 'user') {
        return event.metadata?.uploader?.name || session?.uploader?.name || 'User';
      }
      if (event.role === 'assistant') return runtimeName(session?.runtime);
      if (event.role === 'system') return runtimeName(session?.runtime);
      return event.role || 'Unknown';
    }
    function teamSharingScopeQuery(prefix = '&') {
      const params = new URLSearchParams();
      if (serverSlug) params.set('serverSlug', serverSlug);
      else if (workspaceId) params.set('workspaceId', workspaceId);
      const query = params.toString();
      return query ? prefix + query : '';
    }
    function recordFeedback(eventType) {
      if (!vectorDocumentId) return;
      fetch('/api/team-sharing/feedback' + teamSharingScopeQuery('?'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ queryId, vectorDocumentId, sessionId, eventType, sourceRef })
      }).catch(() => {});
    }
    function updateButtons() {
      setContextButtonVisible(prevBtn, initialLoaded && hasPrev);
      setContextButtonVisible(nextBtn, initialLoaded && hasNext);
      prevBtn.disabled = loading.prev || !hasPrev;
      nextBtn.disabled = loading.next || !hasNext;
      prevBtn.title = hasPrev ? 'Load previous context' : 'Check for earlier context';
      nextBtn.title = hasNext ? 'Load next context' : 'Check for newer context';
    }
    function setContextButtonVisible(button, visible) {
      if (!button) return;
      button.hidden = !visible;
      const controls = button.closest?.('.controls') || button.parentElement || null;
      if (controls) controls.hidden = !visible;
    }
    function canLoad(direction, force = false) {
      if (direction === 'prev') return (force || hasPrev) && !loading.prev;
      if (direction === 'next') return (force || hasNext) && !loading.next;
      return !loading.around;
    }
    function preserveScrollForPrepend(beforeHeight, beforeScrollY) {
      const afterHeight = document.documentElement.scrollHeight;
      const delta = afterHeight - beforeHeight;
      if (delta > 0) window.scrollTo({ top: beforeScrollY + delta, behavior: 'auto' });
    }
    function scrollToInitialAnchor() {
      if (initialAnchorScrolled || !anchorEventId) return;
      const anchorEl = document.getElementById(encodeURIComponent(anchorEventId));
      if (!anchorEl) return;
      initialAnchorScrolled = true;
      anchorEl.scrollIntoView({ block: 'center' });
    }
    function checkScrollEdges() {
      if (!initialLoaded) return;
      const topThreshold = 520;
      const bottomThreshold = 520;
      if (window.scrollY <= topThreshold) load(topDirection).catch(console.error);
      const bottomDistance = document.documentElement.scrollHeight - (window.scrollY + window.innerHeight);
      if (bottomDistance <= bottomThreshold) load(bottomDirection).catch(console.error);
    }
        function scheduleScrollCheck() {
          if (scrollCheckTimer) return;
          scrollCheckTimer = window.setTimeout(() => {
            scrollCheckTimer = null;
            checkScrollEdges();
          }, 120);
        }
        function revealContextNote(note) {
          if (!note || note.dataset.notePlayed === '1') return;
          note.dataset.notePlayed = '1';
          note.classList.add('is-open');
          note.classList.add('is-finished');
        }
        function contextNoteVisibleRatio(entry) {
          const total = Number(entry?.boundingClientRect?.height || 0);
          const visible = Number(entry?.intersectionRect?.height || 0);
          if (total <= 0) return entry?.isIntersecting ? 1 : 0;
          return Math.max(0, Math.min(1, visible / total));
        }
        function contextNoteTriggerRatio(article) {
          const height = Number(article?.getBoundingClientRect?.().height || 0);
          if (height >= Math.min(window.innerHeight * 0.9, 720)) return 0.33;
          return 0.95;
        }
        let contextNoteObserver = null;
        function ensureContextNoteObserver() {
          if (contextNoteObserver || typeof window.IntersectionObserver !== 'function') return contextNoteObserver;
          contextNoteObserver = new IntersectionObserver(entries => {
            for (const entry of entries) {
              if (!entry.isIntersecting) continue;
              const article = entry.target;
              const note = article.querySelector?.('[data-context-note]');
              if (!note || note.dataset.notePlayed === '1') continue;
              if (contextNoteVisibleRatio(entry) < contextNoteTriggerRatio(article)) continue;
              revealContextNote(note);
              contextNoteObserver?.unobserve(article);
            }
          }, { root: null, threshold: [0, .33, .66, .95, 1] });
          return contextNoteObserver;
        }
        function observeContextNotes(root = eventsEl) {
          const notes = Array.from(root?.querySelectorAll?.('[data-context-note]:not([data-note-observed])') || []);
          for (const note of notes) {
            note.dataset.noteObserved = '1';
            const article = note.closest?.('article.context-event') || note.parentElement;
            const noteObserver = ensureContextNoteObserver();
            if (article && noteObserver) noteObserver.observe(article);
            else revealContextNote(note);
          }
        }
        function eventPresentation(event) {
          const value = event?.presentation || event?.metadata?.presentation || event?.metadata?.teamSharing?.presentation || null;
          if (!value || typeof value !== 'object') return null;
          const mode = String(value.mode || '').toLowerCase();
          if (!['plan', 'goal', 'interaction'].includes(mode)) return null;
          return { ...value, mode };
        }
        function presentationLabel(presentation, fallback) {
          return escapeHtml(presentation?.title || fallback || 'Context');
        }
        function renderModePanel(className, label, body, extraHead = '') {
          return '<section class="context-mode-panel ' + className + '">' +
            '<div class="context-mode-head"><span>' + label + '</span>' + extraHead + '</div>' +
            body + '</section>';
        }
        function answerValuesForQuestion(presentation, question, index) {
          const answers = Array.isArray(presentation?.interaction?.answers) ? presentation.interaction.answers : [];
          const answer = answers.find(item => String(item.id || '') === String(question?.id || '')) || answers[index] || null;
          return Array.isArray(answer?.values) ? answer.values.filter(Boolean) : [];
        }
        function optionKey(value) {
          return String(value || '').trim().replace(/\\s*\\((?:recommended|推荐)\\)\\s*$/i, '').toLowerCase();
        }
        function optionForAnswerValue(question, value) {
          const options = Array.isArray(question?.options) ? question.options : [];
          const key = optionKey(value);
          return options.find(option => optionKey(option?.label || option?.value || option?.text || '') === key) || null;
        }
        function renderAnswerValue(question, value) {
          const option = optionForAnswerValue(question, value);
          const description = String(option?.description || '').trim();
          return '<span class="context-answer-item"><span class="context-answer-chip">' + escapeHtml(value) + '</span>' +
            (description ? '<span class="context-answer-description">（' + escapeHtml(description) + '）</span>' : '') +
            '</span>';
        }
        function renderInteractionPresentation(presentation) {
          const questions = Array.isArray(presentation?.interaction?.questions) ? presentation.interaction.questions : [];
          const answers = Array.isArray(presentation?.interaction?.answers) ? presentation.interaction.answers : [];
          const cards = questions.length ? questions.map((question, index) => {
            const options = Array.isArray(question.options) ? question.options : [];
            const values = answerValuesForQuestion(presentation, question, index);
            return '<div class="context-question-card">' +
              (question.header ? '<div class="context-question-head">' + escapeHtml(question.header) + '</div>' : '') +
              '<p class="context-question-prompt">' + escapeHtml(question.question || question.prompt || question.header || 'Question') + '</p>' +
              (options.length ? '<div class="context-option-list">' + options.map(option => '<span class="context-option-chip">' + escapeHtml(option.label || option.description || '') + '</span>').join('') + '</div>' : '') +
              (values.length ? '<div class="context-answer-list">' + values.map(value => renderAnswerValue(question, value)).join('') + '</div>' : '') +
              '</div>';
          }) : answers.map(answer => {
            const values = Array.isArray(answer.values) ? answer.values : [];
            return '<div class="context-question-card">' +
              '<div class="context-question-head">' + escapeHtml(answer.id || 'Answer') + '</div>' +
              '<div class="context-answer-list">' + values.map(value => '<span class="context-answer-chip">' + escapeHtml(value) + '</span>').join('') + '</div>' +
              '</div>';
          });
          return renderModePanel(
            'context-interaction-panel',
            presentationLabel(presentation, 'Interaction'),
            '<div class="context-interaction-list">' + cards.join('') + '</div>',
          );
        }
        function presentationBody(event) {
          const presentation = eventPresentation(event);
          if (!presentation) return '';
          const text = contextEventBodyText(event);
          if (presentation.mode === 'plan') {
            return renderModePanel(
              'context-plan-panel',
              presentationLabel(presentation, 'Plan'),
              '<div class="context-main">' + renderContextMarkdown(text) + '</div>',
            );
          }
          if (presentation.mode === 'goal') {
            const goal = presentation.goal || {};
            const objective = goal.objective || text;
            const status = goal.status ? '<span class="context-goal-status">' + escapeHtml(goal.status) + '</span>' : '';
            return renderModePanel(
              'context-goal-panel',
              presentationLabel(presentation, 'Goal'),
              '<div class="context-main">' + renderContextMarkdown(objective) + '</div>',
              status,
            );
          }
          if (presentation.mode === 'interaction') return renderInteractionPresentation(presentation);
          return '';
        }
        function eventSegments(event) {
          const segments = Array.isArray(event.contentSegments) && event.contentSegments.length
            ? event.contentSegments
        : (Array.isArray(event.metadata?.contentSegments) ? event.metadata.contentSegments : []);
      if (!segments.length) return '';
      return '<div class="context-segments">' + segments.map(segment => {
        const type = String(segment.type || '').toLowerCase();
        const text = segment.text || segment.content || '';
        if (!text) return '';
        if (type === 'body') return '<div class="context-main">' + renderContextMarkdown(text) + '</div>';
        return '<blockquote class="context-quote">' +
          (segment.label ? '<div class="context-quote-label">' + escapeHtml(segment.label) + '</div>' : '') +
          '<div class="context-quote-text">' + renderContextMarkdown(text) + '</div></blockquote>';
      }).join('') + '</div>';
    }
        function eventHtml(event) {
          const anchorClass = anchorEventId && event.eventId === anchorEventId ? ' anchor' : '';
          const roleClass = event.role === 'user' ? ' context-event-user' : (event.role === 'assistant' || event.role === 'system' ? ' context-event-agent' : ' context-event-other');
          const session = window.__teamSharingSession || {};
          const body = presentationBody(event) || eventSegments(event) || '<div class="text">' + renderContextMarkdown(event.displayText || event.cleanText || event.text || '') + '</div>';
          const note = renderContextNote(contextNoteSummary(event));
          const noteClass = note ? ' has-context-note' : '';
          return '<article id="' + encodeURIComponent(event.eventId || '') + '" class="' + ('context-event' + roleClass + anchorClass + noteClass).trim() + '">' +
            '<div><span class="role">' + escapeHtml(roleLabel(event, session)) + '</span><span class="time">' + escapeHtml(chinaTime(event.createdAt || '')) + '</span></div>' +
            note + body + '</article>';
        }
    async function load(direction, options = {}) {
      const force = Boolean(options.force);
      if (loading[direction]) return;
      if (direction !== 'around' && !canLoad(direction, force)) return;
      loading[direction] = true;
      updateButtons();
      if (statusEl) statusEl.textContent = direction === 'around' ? '' : 'Checking context...';
      const beforeHeight = document.documentElement.scrollHeight;
      const beforeScrollY = window.scrollY;
      const anchor = direction === 'next' ? nextAnchor : prevAnchor;
      try {
        const url = '/api/team-sharing/context/${safeSession}?anchorEventId=' + encodeURIComponent(anchor || '') + '&direction=' + encodeURIComponent(direction) + '&limit=21&order=' + encodeURIComponent(order) + teamSharingScopeQuery('&');
        const response = await fetch(url);
        const data = await response.json();
        if (!data.ok) throw new Error(data.error || 'Failed to load context');
        window.__teamSharingSession = data.session || window.__teamSharingSession || {};
        if (data.session?.title) document.getElementById('session-title').textContent = data.session.title;
        document.getElementById('session-meta').textContent = 'session: ' + sessionId + ' · anchor: ' + (anchorEventId || 'latest') + ' · order: ' + (order === 'desc' ? 'newest first' : 'oldest first');
        const fresh = (data.events || []).filter(event => {
          const key = event.eventId || JSON.stringify(event);
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        const insertsAtTop = (order === 'desc' && direction === 'next') || (order !== 'desc' && direction === 'prev');
        if (!fresh.length && !seen.size) {
          eventsEl.innerHTML = '<div class="empty">No context found.</div>';
            } else if (fresh.length) {
              const html = fresh.map(eventHtml).join('');
              if (insertsAtTop) eventsEl.insertAdjacentHTML('afterbegin', html);
              else if (eventsEl.querySelector('.empty')) eventsEl.innerHTML = html;
              else eventsEl.insertAdjacentHTML('beforeend', html);
              observeContextNotes(eventsEl);
              if (direction !== 'around' && insertsAtTop) preserveScrollForPrepend(beforeHeight, beforeScrollY);
            }
        if (statusEl) {
          if (fresh.length) statusEl.textContent = '';
          else if (force && direction === 'next') statusEl.textContent = 'No newer context yet. Try again after hooks sync.';
          else if (force && direction === 'prev') statusEl.textContent = 'No previous context yet.';
          else statusEl.textContent = '';
        }
        prevAnchor = data.pagination?.prevAnchorEventId || prevAnchor;
        nextAnchor = data.pagination?.nextAnchorEventId || nextAnchor;
        hasPrev = Boolean(data.pagination?.hasPrev);
        hasNext = Boolean(data.pagination?.hasNext);
        if (!openedRecorded && direction === 'around') {
          openedRecorded = true;
          recordFeedback('opened');
        } else if (fresh.length && (direction === 'prev' || direction === 'next')) {
          recordFeedback('load_more');
        }
        initialLoaded = true;
        if (direction === 'around') scrollToInitialAnchor();
      } catch (error) {
        if (statusEl && direction !== 'around') statusEl.textContent = error?.message || 'Failed to load context.';
        throw error;
      } finally {
        loading[direction] = false;
        updateButtons();
      }
    }
    prevBtn.addEventListener('click', () => load('prev', { force: true }).catch(console.error));
    nextBtn.addEventListener('click', () => load('next', { force: true }).catch(console.error));
    const observer = typeof window.IntersectionObserver === 'function' ? new IntersectionObserver(entries => {
      if (!initialLoaded) return;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        if (entry.target === topSentinel) load(topDirection).catch(console.error);
        if (entry.target === bottomSentinel) load(bottomDirection).catch(console.error);
      }
    }, { root: null, rootMargin: '640px 0px', threshold: 0 }) : null;
    observer?.observe(topSentinel);
    observer?.observe(bottomSentinel);
    window.addEventListener('scroll', scheduleScrollCheck, { passive: true });
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

function booleanFlag(value) {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  return /^(1|true|yes|y|on)$/i.test(String(value).trim());
}

function normalizeSearchList(value = []) {
  const values = Array.isArray(value) ? value : [value];
  const items = [];
  for (const item of values) {
    if (item === undefined || item === null || item === false || item === true) continue;
    const text = String(item || '').trim();
    if (!text) continue;
    if (text.startsWith('[')) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          items.push(...normalizeSearchList(parsed));
          continue;
        }
      } catch {}
    }
    items.push(...text.split(/[\n,，、;；|]+/g).map((part) => part.trim()).filter(Boolean));
  }
  return items;
}

function uniqueSearchList(values = [], limit = 24) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 120) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function inferTimePreferenceFromQuery(query = '') {
  const text = String(query || '').toLowerCase();
  if (/(今天|今日|\btoday\b)/i.test(text)) return 'today';
  if (/(昨天|昨日|\byesterday\b)/i.test(text)) return 'yesterday';
  if (/(这周|本周|\bthis\s*week\b)/i.test(text)) return 'this-week';
  if (/(上周|\blast\s*week\b)/i.test(text)) return 'last-week';
  return '';
}

function splitTopicText(value = '') {
  return String(value || '')
    .replace(/\b(and|or)\b/gi, '、')
    .replace(/(?:以及|或者|还有|和|与|及|跟|、|\/)+/g, '、')
    .split(/[、,，;；]+/g)
    .map((part) => part.replace(/^(关于|围绕|讲的|聊的|讨论|话题|topic)\s*/i, '').trim())
    .filter((part) => part && !/^(昨天|今天|本周|这周|上周|what|who|when|where|why|how)$/i.test(part));
}

function extractQuotedPhrases(query = '') {
  const phrases = [];
  const text = String(query || '');
  const pattern = /["'`“”‘’]([^"'`“”‘’]{2,80})["'`“”‘’]/g;
  for (const match of text.matchAll(pattern)) phrases.push(match[1]);
  return phrases;
}

function extractIntentTopics(query = '') {
  const text = String(query || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const topics = [];
  topics.push(...extractQuotedPhrases(text));
  const topicPatterns = [
    /(?:关于|围绕|讲的|聊的|讨论|提到|看看|看一下)\s*([^。！？!?；;\n]{2,140})/gi,
    /(?:topic|topics|subject|subjects)\s*(?:of|about|:|：)?\s*([^。！？!?；;\n]{2,140})/gi,
  ];
  for (const pattern of topicPatterns) {
    for (const match of text.matchAll(pattern)) topics.push(...splitTopicText(match[1]));
  }
  const enumMatch = text.match(/([A-Z0-9_\-.一-龥]{1,40}(?:[、,，/]\s*[A-Z0-9_\-.一-龥]{1,40}){1,12})/);
  if (enumMatch) topics.push(...splitTopicText(enumMatch[1]));
  return uniqueSearchList(topics, 16);
}

function extractIntentKeywords(query = '') {
  const text = String(query || '');
  const quoted = extractQuotedPhrases(text);
  const technicalTokens = text.match(/[A-Za-z][A-Za-z0-9_.:/-]{2,}|[A-Z][A-Z0-9_-]{1,}/g) || [];
  const codeTokens = text.match(/`([^`]{2,80})`/g)?.map((item) => item.replace(/^`|`$/g, '')) || [];
  return uniqueSearchList([...quoted, ...technicalTokens, ...codeTokens], 24);
}

function normalizeTeamSharingSearchIntentBody(body = {}, nowValue = '') {
  const query = String(body.query || '').replace(/\s+/g, ' ').trim();
  const explicitTime = normalizeTimePreference(body.timePreference || body.time || body.when || body.period || '');
  const inferredTime = inferTimePreferenceFromQuery(query);
  const timePreference = explicitTime || inferredTime || '';
  const modeBias = normalizeTeamSharingSearchMode(body.modeBias || body.searchMode || body.mode || (body.exact ? 'keyword' : body.fuzzy ? 'semantic' : 'hybrid'));
  const keywordOnly = booleanFlag(body.keywordOnly || body.keywordsOnly || body.exactOnly || body.retrievalIntent?.keywordOnly);
  const semanticOnly = booleanFlag(body.semanticOnly || body.vectorOnly || body.fuzzyOnly || body.retrievalIntent?.semanticOnly);
  const searchMode = keywordOnly ? 'keyword' : semanticOnly ? 'semantic' : 'hybrid';
  const topics = uniqueSearchList([
    ...normalizeSearchList(body.topics),
    ...normalizeSearchList(body.topic),
    ...normalizeSearchList(body.retrievalIntent?.topics),
    ...extractIntentTopics(query),
  ], 24);
  const keywords = uniqueSearchList([
    ...normalizeSearchList(body.keywords),
    ...normalizeSearchList(body.keyword),
    ...normalizeSearchList(body.exactKeywords),
    ...normalizeSearchList(body.exactKeyword),
    ...normalizeSearchList(body.retrievalIntent?.keywords),
    ...topics,
    ...extractIntentKeywords(query),
  ], 32);
  const semanticQuery = String(
    body.semanticQuery
      || body.semantic_query
      || body.retrievalIntent?.semanticQuery
      || body.retrievalIntent?.semantic_query
      || query,
  ).replace(/\s+/g, ' ').trim() || query;
  const dateRange = normalizeSearchDateRange({
    ...body,
    ...(timePreference && !body.timePreference && !body.time && !body.when && !body.period ? { timePreference } : {}),
  }, nowValue);
  const keywordQuery = uniqueSearchList([
    ...normalizeSearchList(body.keywordQuery || body.keyword_query),
    ...keywords,
    ...topics,
    query,
  ], 40).join('\n');
  return {
    query,
    semanticQuery,
    keywordQuery,
    keywords,
    topics,
    timePreference: timePreference || null,
    dateRange,
    searchMode,
    modeBias,
    useKeyword: searchMode !== 'semantic',
    useSemantic: searchMode !== 'keyword',
  };
}

function clamp01(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function normalizeTimePreference(value = '') {
  const clean = String(value || '').trim().toLowerCase();
  if (['today', '今天'].includes(clean)) return 'today';
  if (['yesterday', '昨天'].includes(clean)) return 'yesterday';
  if (['week', 'this-week', 'thisweek', '本周', '这周'].includes(clean)) return 'this-week';
  if (['last-week', 'lastweek', '上周'].includes(clean)) return 'last-week';
  return '';
}

function localDayStartUtcMs(nowMs, offsetMinutes = 480) {
  const offsetMs = offsetMinutes * 60 * 1000;
  const shifted = new Date(nowMs + offsetMs);
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - offsetMs;
}

function relativeDateRange(period = '', nowValue = '', offsetMinutes = 480) {
  const preference = normalizeTimePreference(period);
  if (!preference) return null;
  const nowMs = new Date(nowValue || Date.now()).getTime();
  const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
  const todayStart = localDayStartUtcMs(safeNowMs, offsetMinutes);
  const oneDayMs = 24 * 60 * 60 * 1000;
  if (preference === 'today') return { from: new Date(todayStart).toISOString(), to: new Date(todayStart + oneDayMs).toISOString() };
  if (preference === 'yesterday') return { from: new Date(todayStart - oneDayMs).toISOString(), to: new Date(todayStart).toISOString() };
  const shifted = new Date(safeNowMs + offsetMinutes * 60 * 1000);
  const localDay = shifted.getUTCDay() || 7;
  const weekStart = todayStart - ((localDay - 1) * oneDayMs);
  if (preference === 'this-week') return { from: new Date(weekStart).toISOString(), to: new Date(weekStart + 7 * oneDayMs).toISOString() };
  return { from: new Date(weekStart - 7 * oneDayMs).toISOString(), to: new Date(weekStart).toISOString() };
}

function normalizeSearchDateRange(body = {}, nowValue = '') {
  const rawRange = body.dateRange;
  if (rawRange && typeof rawRange === 'object') return rawRange;
  if (typeof rawRange === 'string' && rawRange.trim()) {
    const text = rawRange.trim();
    const relative = relativeDateRange(text, nowValue, Number(body.timezoneOffsetMinutes || body.timeZoneOffsetMinutes || 480));
    if (relative) return relative;
    if (text.startsWith('{')) {
      try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch {}
    }
    const separator = text.includes('..') ? '..' : text.includes(',') ? ',' : '';
    if (separator) {
      const [from = '', to = ''] = text.split(separator).map((part) => part.trim());
      return { ...(from ? { from } : {}), ...(to ? { to } : {}) };
    }
    return { from: text };
  }
  const explicitPreference = body.timePreference || body.time || body.when || body.period || '';
  const relative = relativeDateRange(explicitPreference, nowValue, Number(body.timezoneOffsetMinutes || body.timeZoneOffsetMinutes || 480));
  if (relative) return relative;
  const from = body.from || body.since || body.start || body.updatedAfter || body.updated_after || '';
  const to = body.to || body.until || body.end || body.updatedBefore || body.updated_before || '';
  return from || to ? { ...(from ? { from: String(from) } : {}), ...(to ? { to: String(to) } : {}) } : null;
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

function keywordSearchInputs({ query = '', keywordQuery = '', keywords = [], topics = [] } = {}) {
  const phrases = uniqueSearchList([
    ...normalizeSearchList(keywords),
    ...normalizeSearchList(topics),
    ...normalizeSearchList(keywordQuery),
  ], 40);
  const terms = uniqueSearchList([
    ...phrases.flatMap((phrase) => queryTerms(phrase)),
    ...queryTerms(query),
  ], 80);
  return { phrases, terms };
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

function localKeywordSearch({ teamSharingState, query = '', keywordQuery = '', keywords = [], topics = [], channelId = '', projectKey = '', dateRange = null, limit = 40 } = {}) {
  const { phrases, terms } = keywordSearchInputs({ query, keywordQuery, keywords, topics });
  const candidates = asArray(teamSharingState?.vectorDocuments)
    .filter((doc) => doc.active !== false)
    .filter((doc) => !channelId || doc.channelId === channelId)
    .filter((doc) => !projectKey || doc.projectKey === projectKey)
    .filter((doc) => isWithinDateRange(doc.updatedAt, dateRange))
    .map((doc) => {
      const haystack = `${doc.title || ''}\n${doc.topicId || ''}\n${doc.text || ''}`.toLowerCase();
      const matchedTerms = terms.filter((term) => haystack.includes(term));
      const termScore = terms.length ? matchedTerms.length / terms.length : 0;
      const matchedPhrases = phrases.filter((phrase) => haystack.includes(String(phrase || '').toLowerCase()));
      const phraseScore = phrases.length ? matchedPhrases.length / phrases.length : 0;
      const topicScore = topics.length
        ? normalizeSearchList(topics).filter((topic) => haystack.includes(String(topic || '').toLowerCase())).length / normalizeSearchList(topics).length
        : 0;
      const keywordScore = clamp01((0.50 * phraseScore) + (0.35 * termScore) + (0.15 * topicScore));
      return {
        ...doc,
        vectorScore: Number(doc.vectorScore || 0.05),
        keywordScore,
        freshnessScore: 0.5,
      };
    })
    .filter((doc) => doc.keywordScore > 0)
    .sort((left, right) => right.keywordScore - left.keywordScore || String(left.vectorDocumentId).localeCompare(String(right.vectorDocumentId)))
    .slice(0, limit);
  return { ok: true, candidates };
}

function fuseTeamSharingCandidates({ semanticCandidates = [], keywordCandidates = [], limit = 40, rrfK = 30 } = {}) {
  const byId = new Map();
  const add = (candidate, source, index) => {
    const id = String(candidate?.vectorDocumentId || '').trim();
    if (!id) return;
    const existing = byId.get(id) || {
      ...candidate,
      vectorScore: 0,
      keywordScore: 0,
      rrfScore: 0,
      retrievalSources: [],
    };
    existing.rrfScore += 1 / (rrfK + index + 1);
    if (!existing.retrievalSources.includes(source)) existing.retrievalSources.push(source);
    if (source === 'semantic') {
      existing.vectorScore = Math.max(clamp01(existing.vectorScore), clamp01(candidate.vectorScore ?? candidate.score));
    } else {
      existing.keywordScore = Math.max(clamp01(existing.keywordScore), clamp01(candidate.keywordScore ?? candidate.score));
      existing.vectorScore = Math.max(clamp01(existing.vectorScore), clamp01(candidate.vectorScore ?? 0.05));
    }
    byId.set(id, { ...existing, ...candidate, rrfScore: existing.rrfScore, retrievalSources: existing.retrievalSources, vectorScore: existing.vectorScore, keywordScore: existing.keywordScore });
  };
  asArray(semanticCandidates).forEach((candidate, index) => add(candidate, 'semantic', index));
  asArray(keywordCandidates).forEach((candidate, index) => add(candidate, 'keyword', index));
  return [...byId.values()]
    .sort((left, right) => right.rrfScore - left.rrfScore || right.keywordScore - left.keywordScore || right.vectorScore - left.vectorScore)
    .slice(0, limit);
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

function requestWorkspaceId({ actor = null, tokenRecord = null, state = {}, fallback = '' } = {}) {
  return String(
    actor?.member?.workspaceId
      || tokenRecord?.workspaceId
      || fallback
      || state.connection?.workspaceId
      || state.cloud?.workspace?.id
      || 'local',
  ).trim();
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

function normalizeMachineFingerprint(value = '') {
  const clean = String(value || '').trim().toLowerCase();
  return MACHINE_FINGERPRINT_PATTERN.test(clean) ? clean : '';
}

function machineFingerprintForRequest(req) {
  const header = req?.headers?.['x-magclaw-machine-fingerprint'];
  return normalizeMachineFingerprint(Array.isArray(header) ? header[0] : header);
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
  const expiresAtMs = Date.parse(record.expiresAt || '');
  if (Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now()) return null;
  const expectedFingerprint = normalizeMachineFingerprint(record.machineFingerprint || '');
  if (expectedFingerprint && machineFingerprintForRequest(req) !== expectedFingerprint) return null;
  return record;
}

function requestUser(actor = {}) {
  return {
    id: actorHumanId(actor),
    email: actor?.member?.email || actor?.user?.email || '',
    name: actor?.member?.name || actor?.user?.name || '',
    avatar: actor?.member?.avatar || actor?.user?.avatar || '',
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

function requestHasTeamSharingAuth(req, { actor, teamSharingState, teamSharingAuthRequired, validTeamSharingToken } = {}) {
  const required = typeof teamSharingAuthRequired === 'function' ? teamSharingAuthRequired(req) : Boolean(teamSharingAuthRequired);
  if (!required || actor) return true;
  if (typeof validTeamSharingToken === 'function' && validTeamSharingToken(req)) return true;
  return Boolean(tokenRecordForRequest(teamSharingState, req));
}

function requestHasTeamSharingIdentity(req, { actor, teamSharingState, validTeamSharingToken } = {}) {
  if (actor) return true;
  if (typeof validTeamSharingToken === 'function' && validTeamSharingToken(req)) return true;
  return Boolean(tokenRecordForRequest(teamSharingState, req));
}

function safeRelativePathFromUrl(url) {
  const path = `${url?.pathname || '/'}${url?.search || ''}`;
  return path.startsWith('/') && !path.startsWith('//') ? path : '/console';
}

function redirectToLoginWithReturnTo(res, url) {
  const returnTo = safeRelativePathFromUrl(url);
  const location = `/?returnTo=${encodeURIComponent(returnTo)}`;
  res.writeHead?.(302, { location, 'cache-control': 'no-store' });
  res.end?.('');
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
    keywordSearch = null,
    keywordSearchReady = null,
    makeId,
    now,
    persistState = async () => {},
    readJson,
    rerank = null,
    rerankReady = null,
    sendError,
    sendJson,
    summarizeSession = null,
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
    const requestWorkspaceId = String(body.workspaceId || workspaceId || '').trim();
    const machineFingerprint = normalizeMachineFingerprint(body.machineFingerprint || body.machine_fingerprint || '');
    const request = {
      deviceCodeHash: hashSecret(deviceCode),
      userCode,
      workspaceId: requestWorkspaceId,
      profile: body.profile || 'default',
      packageName: body.packageName || 'team-sharing',
      machineFingerprint,
      client: body.client && typeof body.client === 'object' ? {
        hostname: compactText(body.client.hostname || '', 120),
        platform: compactText(body.client.platform || '', 40),
        arch: compactText(body.client.arch || '', 40),
      } : {},
      status: actor ? 'approved' : 'pending',
      approvedUser: actor ? requestUser(actor) : null,
      createdAt: now(),
      expiresAt,
    };
    auth.deviceRequests[request.deviceCodeHash] = request;
    await persistState({ workspaceId: requestWorkspaceId || workspaceId, reason: 'team_sharing_auth_start' });
    sendJson(res, 201, {
      ok: true,
      deviceCode,
      userCode,
      verificationUri: `/team-sharing/auth/approve?user_code=${encodeURIComponent(userCode)}${requestWorkspaceId ? `&workspaceId=${encodeURIComponent(requestWorkspaceId)}` : ''}`,
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
    const requestedFingerprint = normalizeMachineFingerprint(body.machineFingerprint || body.machine_fingerprint || '');
    if (request.machineFingerprint && requestedFingerprint && request.machineFingerprint !== requestedFingerprint) {
      sendError(res, 401, 'Team Sharing login was requested from another machine.');
      return true;
    }
    const token = randomToken('tm');
    const tokenHash = hashSecret(token);
    const tokenExpiresAt = new Date(Date.now() + TEAM_SHARING_TOKEN_TTL_MS).toISOString();
    auth.tokens[tokenHash] = {
      tokenHash,
      workspaceId: request.workspaceId || workspaceId,
      profile: request.profile || 'default',
      packageName: request.packageName || 'team-sharing',
      user: request.approvedUser || { id: 'hum_local', email: '', name: '' },
      scopes: ['team_sharing:sync', 'team_sharing:search', 'team_sharing:context', 'team_sharing:feedback', 'team_sharing:share'],
      revoked: false,
      machineFingerprint: request.machineFingerprint || requestedFingerprint || '',
      expiresAt: tokenExpiresAt,
      createdAt: now(),
      lastUsedAt: now(),
    };
    delete auth.deviceRequests[request.deviceCodeHash];
    await persistState({ workspaceId: request.workspaceId || workspaceId, reason: 'team_sharing_auth_token' });
    sendJson(res, 200, {
      ok: true,
      status: 'approved',
      token,
      tokenExpiresAt,
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
    const approvalActor = actor || currentActor({
      ...req,
      headers: {
        ...(req.headers || {}),
        'x-magclaw-workspace-id': request.workspaceId || workspaceId,
      },
    });
    if (!approvalActor) {
      redirectToLoginWithReturnTo(res, url);
      return true;
    }
    request.status = 'approved';
    request.approvedUser = requestUser(approvalActor);
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
      sendShareHtml(res, shareChromeHtml({ title: 'Team Shares' }, '<h1>Shared page not found</h1><p>This MagClaw share link may have been removed.</p>'), { status: 404 });
      return true;
    }
    const access = shareAccess(req, { actor, teamSharingState, share });
    if (!access.ok) {
      addSystemEvent('team_sharing_share_denied', 'Team sharing share access denied.', {
        workspaceId: access.workspaceId || workspaceId,
        actorId: access.actorId || '',
        shareId,
        status: access.status,
      });
      if (access.status === 401) {
        redirectToLoginWithReturnTo(res, url);
        return true;
      }
      sendShareHtml(res, shareRootDeniedHtml(access.status, access.error), { status: access.status });
      return true;
    }
    sendShareHtml(res, renderShareHtml(share));
    return true;
  }

  const shareRootPath = url.pathname === '/share'
    || url.pathname === '/share/'
    || /^\/s\/[^/]+\/share\/?$/.test(url.pathname);
  if (req.method === 'GET' && shareRootPath) {
    const access = shareRootAccess(req, {
      actor,
      teamSharingState,
      state,
      targetWorkspaceId: shareRootPathWorkspaceId(url, state),
    });
    if (!access.ok) {
      addSystemEvent('team_sharing_share_root_denied', 'Team sharing share root access denied.', {
        workspaceId: access.workspaceId || workspaceId,
        actorId: access.actorId || '',
        status: access.status,
      });
      if (access.status === 401) {
        redirectToLoginWithReturnTo(res, url);
        return true;
      }
      sendShareHtml(res, shareRootDeniedHtml(access.status, access.error), { status: access.status });
      return true;
    }
    sendShareHtml(res, renderShareIndexHtml(sharesForShareRoot(teamSharingState, access.workspaceId)));
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/team-sharing/shares') {
    if (!requireTeamSharingAuth(req, res, { actor, teamSharingState, sendError, teamSharingAuthRequired, validTeamSharingToken })) return true;
    const tokenRecord = tokenRecordForRequest(teamSharingState, req);
    const body = await readJson(req);
    const effectiveWorkspaceId = requestWorkspaceId({ actor, tokenRecord, state, fallback: body.workspaceId || workspaceId });
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
      workspaceId: effectiveWorkspaceId,
      channelId: String(body.channelId || '').trim(),
      channelPath: String(body.channelPath || '').trim(),
      projectKey: String(body.projectKey || '').trim(),
      title: compactText(body.title || body.name || 'MagClaw shared page', 140),
      description: compactText(body.description || content, 260),
      contentType: normalizeShareContentType(body.contentType || body.type, content),
      content,
      creator: creatorFromActor(actor, tokenRecord),
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

  const scopedContextPageMatch = url.pathname.match(/^\/s\/([^/]+)\/team-sharing\/context\/([^/]+)$/);
  const contextPageMatch = url.pathname.match(/^\/team-sharing\/context\/([^/]+)$/) || (scopedContextPageMatch ? [scopedContextPageMatch[0], scopedContextPageMatch[2]] : null);
  if (req.method === 'GET' && contextPageMatch) {
    if (!requestHasTeamSharingIdentity(req, { actor, teamSharingState, validTeamSharingToken })) {
      redirectToLoginWithReturnTo(res, url);
      return true;
    }
    const tokenRecord = tokenRecordForRequest(teamSharingState, req);
    const sessionId = decodeURIComponent(contextPageMatch[1]);
    const session = teamSharingState.sessions?.[sessionId] || null;
    if (!session) {
      sendError(res, 404, 'Team sharing session not found.');
      return true;
    }
    if (!teamSharingWorkspaceAccess({ actor, tokenRecord, session })) {
      sendError(res, 403, 'This Team Sharing context belongs to another server.');
      return true;
    }
    sendContextHtml(res, {
      sessionId,
      anchorEventId: sourceAnchorFromSearchParams(url.searchParams),
      vectorDocumentId: url.searchParams.get('vectorDocumentId') || '',
      queryId: url.searchParams.get('queryId') || '',
      sourceRef: url.searchParams.get('sourceRef') || '',
      order: url.searchParams.get('order') || 'asc',
      workspaceId: session.workspaceId || actor?.member?.workspaceId || tokenRecord?.workspaceId || workspaceId || '',
      serverSlug: scopedContextPageMatch ? decodeURIComponent(scopedContextPageMatch[1]) : (url.searchParams.get('serverSlug') || ''),
    });
    return true;
  }

  const workspaceMatch = url.pathname.match(/^\/api\/team-sharing\/workspace\/([^/]+)$/);
  if (req.method === 'GET' && workspaceMatch) {
    if (!requireTeamSharingAuth(req, res, { actor, teamSharingState, sendError, teamSharingAuthRequired, validTeamSharingToken })) return true;
    const tokenRecord = tokenRecordForRequest(teamSharingState, req);
    const sessionId = decodeURIComponent(workspaceMatch[1]);
    const workspace = buildTeamSharingWorkspace(teamSharingState, sessionId);
    if (!workspace) {
      sendError(res, 404, 'Team sharing workspace not found.');
      return true;
    }
    if (!teamSharingWorkspaceAccess({ actor, tokenRecord, session: workspace.session })) {
      sendError(res, 403, 'This Team Sharing workspace belongs to another server.');
      return true;
    }
    addSystemEvent('team_sharing_workspace_read', `Team sharing workspace read: ${compactText(workspace.session.title || sessionId, 90)}`, {
      workspaceId,
      sessionId,
      messageId: workspace.session.messageId,
    });
    sendJson(res, 200, workspace);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/team-sharing/sync') {
    if (!requireTeamSharingAuth(req, res, { actor, teamSharingState, sendError, teamSharingAuthRequired, validTeamSharingToken })) return true;
    const tokenRecord = tokenRecordForRequest(teamSharingState, req);
    const body = await readJson(req);
    const effectiveWorkspaceId = requestWorkspaceId({ actor, tokenRecord, state, fallback: body.workspaceId || workspaceId });
    const result = await syncTeamSharingBatch({
      ...body,
      workspaceId: effectiveWorkspaceId,
      humanId: body.humanId || actorHumanId(actor) || tokenRecord?.user?.id || '',
      humanName: body.humanName || body.uploaderName || actor?.member?.name || actor?.user?.name || tokenRecord?.user?.name || '',
      humanEmail: body.humanEmail || body.uploaderEmail || actor?.member?.email || actor?.user?.email || tokenRecord?.user?.email || '',
      humanAvatar: body.humanAvatar || body.uploaderAvatar || actor?.member?.avatar || actor?.user?.avatar || tokenRecord?.user?.avatar || '',
    }, {
      state,
      makeId,
      now,
      summarizeSession,
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
          workspaceId: effectiveWorkspaceId,
          sessionId: result.sessionId,
          documents,
          teamSharingState: state.teamSharing || {},
        });
        result.indexedDocumentCount = Number(indexed?.count || documents.length || 0);
      } catch (error) {
        result.indexedDocumentCount = 0;
        result.indexError = 'Team sharing vector indexing failed.';
        addSystemEvent('team_sharing_index_error', 'Team sharing vector indexing failed.', {
          workspaceId: effectiveWorkspaceId,
          sessionId: result.sessionId,
          message: String(error?.message || error).slice(0, 300),
        });
      }
    }
    addSystemEvent('team_sharing_sync', `Team sharing synced ${result.appendedEventCount} event(s).`, {
      workspaceId: effectiveWorkspaceId,
      sessionId: result.sessionId,
      messageId: result.messageId,
      duplicate: result.duplicate,
    });
    await persistState({ workspaceId: effectiveWorkspaceId, reason: 'team_sharing_sync' });
    broadcastState();
    sendJson(res, result.duplicate ? 200 : 202, result);
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/team-sharing/search') {
    if (!requireTeamSharingAuth(req, res, { actor, teamSharingState, sendError, teamSharingAuthRequired, validTeamSharingToken })) return true;
    const tokenRecord = tokenRecordForRequest(teamSharingState, req);
    const body = await readJson(req);
    const effectiveWorkspaceId = requestWorkspaceId({ actor, tokenRecord, state, fallback: body.workspaceId || workspaceId });
    const limit = Math.max(1, Math.min(20, Number(body.limit || 5)));
    const candidateK = Math.max(limit, Math.min(200, Number(body.candidateK || 40)));
    const intent = normalizeTeamSharingSearchIntentBody(body, now?.());
    const searchMode = intent.searchMode;
    const sortBy = normalizeTeamSharingSearchSort(body.sortBy || body.sort || body.orderBy);
    const dateRange = intent.dateRange;
    const needsSemantic = intent.useSemantic;
    const needsKeyword = intent.useKeyword;
    const semanticRemoteReady = needsSemantic && vectorSearch && (typeof zillizReady !== 'function' || zillizReady());
    if (needsSemantic && searchMode === 'semantic' && !semanticRemoteReady) {
      sendError(res, 503, 'Team sharing vector index is not ready.');
      return true;
    }
    const semanticPromise = needsSemantic
      ? (semanticRemoteReady
        ? vectorSearch({
          teamSharingState,
          query: intent.semanticQuery,
          channelId: body.channelId || '',
          projectKey: body.projectKey || '',
          dateRange,
          limit: candidateK,
          actor,
          workspaceId: effectiveWorkspaceId,
          searchMode,
          modeBias: intent.modeBias,
          keywords: intent.keywords,
          topics: intent.topics,
        }).catch((error) => ({ ok: false, error: error?.message || 'Team sharing vector search failed.' }))
        : Promise.resolve(localVectorSearch({
          teamSharingState,
          query: intent.semanticQuery,
          channelId: body.channelId || '',
          projectKey: body.projectKey || '',
          dateRange,
          limit: candidateK,
        })))
      : Promise.resolve({ ok: true, candidates: [] });
    const keywordPromise = needsKeyword
      ? (async () => {
        const canUseRemoteKeyword = keywordSearch && (typeof keywordSearchReady !== 'function' || keywordSearchReady());
        if (canUseRemoteKeyword) {
          const remote = await keywordSearch({
            teamSharingState,
            query: intent.keywordQuery || intent.query,
            keywordQuery: intent.keywordQuery,
            keywords: intent.keywords,
            topics: intent.topics,
            channelId: body.channelId || '',
            projectKey: body.projectKey || '',
            dateRange,
            limit: candidateK,
            actor,
            workspaceId: effectiveWorkspaceId,
            searchMode,
            modeBias: intent.modeBias,
          }).catch((error) => ({ ok: false, error: error?.message || 'Team sharing keyword search failed.' }));
          if (remote?.ok) return remote;
          const fallback = localKeywordSearch({
            teamSharingState,
            query: intent.query,
            keywordQuery: intent.keywordQuery,
            keywords: intent.keywords,
            topics: intent.topics,
            channelId: body.channelId || '',
            projectKey: body.projectKey || '',
            dateRange,
            limit: candidateK,
          });
          return { ...fallback, degraded: true, remoteError: remote?.error || remote?.code || 'keyword_search_failed' };
        }
        const fallback = localKeywordSearch({
          teamSharingState,
          query: intent.query,
          keywordQuery: intent.keywordQuery,
          keywords: intent.keywords,
          topics: intent.topics,
          channelId: body.channelId || '',
          projectKey: body.projectKey || '',
          dateRange,
          limit: candidateK,
        });
        return { ...fallback, degraded: Boolean(keywordSearch), remoteError: keywordSearch ? 'keyword_search_not_ready' : '' };
      })()
      : Promise.resolve({ ok: true, candidates: [] });
    const [semantic, keyword] = await Promise.all([semanticPromise, keywordPromise]);
    if (needsSemantic && !semantic?.ok && searchMode === 'semantic') {
      sendError(res, 503, semantic?.error || 'Team sharing vector search failed.');
      return true;
    }
    const candidates = searchMode === 'semantic'
      ? asArray(semantic.candidates)
      : searchMode === 'keyword'
        ? asArray(keyword.candidates)
        : fuseTeamSharingCandidates({
          semanticCandidates: asArray(semantic?.ok ? semantic.candidates : []),
          keywordCandidates: asArray(keyword.candidates),
          limit: candidateK,
        });
    const rerankQuery = uniqueSearchList([
      intent.query,
      intent.semanticQuery,
      intent.keywords.join(' '),
    ], 3).join('\n');
    const rerankResults = rerank
      ? await rerank({ query: rerankQuery, candidates, limit: candidateK })
      : localRerank({ query: rerankQuery, candidates });
    const ranked = rankTeamSharingCandidates({
      query: intent.query,
      semanticQuery: intent.semanticQuery,
      keywords: intent.keywords,
      topics: intent.topics,
      intent,
      candidates,
      teamSharingState,
      rerankResults,
      keywordCandidates: keyword.candidates || [],
      searchMode,
      modeBias: intent.modeBias,
      sortBy,
      minScore: body.minScore,
      now,
      limit,
    });
    for (const item of ranked.results) {
      applyTeamSharingFeedback(teamSharingState, {
        workspaceId: effectiveWorkspaceId,
        actorId: actorHumanId(actor) || tokenRecord?.user?.id || '',
        queryId: ranked.queryId,
        vectorDocumentId: item.vectorDocumentId,
        sessionId: item.sessionId,
        sourceRef: item.sourceRef,
        eventType: 'served',
        createdAt: now(),
      });
    }
    addSystemEvent('team_sharing_search', `Team sharing searched: ${compactText(body.query || '', 90)}`, {
      workspaceId: effectiveWorkspaceId,
      queryId: ranked.queryId,
      resultCount: ranked.results.length,
      candidateCount: candidates.length,
      searchMode,
      modeBias: intent.modeBias,
      sortBy,
      keywordCount: intent.keywords.length,
      topicCount: intent.topics.length,
    });
    await persistState({ workspaceId: effectiveWorkspaceId, reason: 'team_sharing_search' });
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
        rawEventId: String(item.rawEventId || '').trim() || sourceAnchorEventId(item.sourceRef),
        anchorEventId: String(item.rawEventId || '').trim() || sourceAnchorEventId(item.sourceRef),
        contextUrl: resultContextUrl(item, ranked.queryId),
        finalScore: item.finalScore,
        vectorScore: item.vectorScore,
        rerankScore: item.rerankScore,
        keywordScore: item.keywordScore,
        hotnessScore: item.hotnessScore,
      })),
      rerankUsed: Boolean(rerankResults?.length),
      candidateCount: candidates.length,
      semanticCandidateCount: asArray(semantic?.candidates).length,
      keywordCandidateCount: asArray(keyword?.candidates).length,
      searchMode,
      modeBias: intent.modeBias,
      sortBy,
      dateRange,
      timePreference: intent.timePreference,
      semanticQuery: intent.semanticQuery,
      keywords: intent.keywords,
      topics: intent.topics,
      retrievalIntent: {
        useKeyword: needsKeyword,
        useSemantic: needsSemantic,
        modeBias: intent.modeBias,
      },
      degraded: {
        semantic: needsSemantic && !semantic?.ok ? (semantic?.error || 'semantic_search_failed') : '',
        keyword: keyword?.degraded ? (keyword.remoteError || 'keyword_search_degraded') : '',
      },
      trace: ranked.trace,
    });
    return true;
  }

  const contextMatch = url.pathname.match(/^\/api\/team-sharing\/context\/([^/]+)$/);
  if (req.method === 'GET' && contextMatch) {
    if (!requireTeamSharingAuth(req, res, { actor, teamSharingState, sendError, teamSharingAuthRequired, validTeamSharingToken })) return true;
    const tokenRecord = tokenRecordForRequest(teamSharingState, req);
    const sessionId = decodeURIComponent(contextMatch[1]);
    const session = teamSharingState.sessions?.[sessionId] || null;
    if (!session) {
      sendError(res, 404, 'Team sharing session not found.');
      return true;
    }
    if (!teamSharingWorkspaceAccess({ actor, tokenRecord, session })) {
      sendError(res, 403, 'This Team Sharing context belongs to another server.');
      return true;
    }
    const result = contextWindowForTeamSharingSession(state.teamSharing || {}, sessionId, {
      anchorEventId: sourceAnchorFromSearchParams(url.searchParams),
      direction: url.searchParams.get('direction') || 'around',
      limit: url.searchParams.get('limit') || 21,
      order: url.searchParams.get('order') || 'asc',
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
