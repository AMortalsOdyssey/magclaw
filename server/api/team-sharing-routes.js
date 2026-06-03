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
  const files = [
    teamSharingWorkspaceFile('abstract.md', abstract.abstractMarkdown || ''),
    teamSharingWorkspaceFile('debug-log.md', abstract.debugLogMarkdown || [
      `# ${session.title || 'Team Sharing Session'} Debug Log`,
      '',
      'No sync log entries yet.',
    ].join('\n')),
    teamSharingWorkspaceFile('activities.json', activitiesJson, { previewKind: 'json' }),
    ...topics.map((topic) => teamSharingWorkspaceFile(`topics/${topic.topicId}.md`, topic.overviewMarkdown || `# ${topic.title || topic.topicId}\n\n${topic.overview || ''}`, {
      topicId: topic.topicId,
      sourceEventIds: asArray(topic.sourceEventIds),
    })),
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
} = {}) {
  const safeSession = encodeURIComponent(sessionId);
  const initialAnchor = String(anchorEventId || '');
  const contextOrder = String(order || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';
  const isDesc = contextOrder === 'desc';
  const body = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MagClaw Team Sharing Context</title>
  <style>
    :root { color-scheme: light; --ink:#111827; --muted:#64748b; --line:#d7dee8; --bg:#f8fafc; --accent:#0891b2; --chip:#e0f2fe; }
    * { box-sizing:border-box; }
    body { margin:0; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:var(--bg); color:var(--ink); }
    header { position:sticky; top:0; z-index:2; padding:16px 20px; border-bottom:1px solid var(--line); background:rgba(248,250,252,.94); backdrop-filter: blur(14px); }
    h1 { margin:0; font-size:20px; letter-spacing:0; line-height:1.28; }
    .meta { margin-top:4px; color:var(--muted); font-size:13px; overflow-wrap:anywhere; }
    main { max-width:920px; margin:0 auto; padding:18px; }
    .controls { display:flex; gap:10px; justify-content:center; margin:12px 0; }
    button { border:1px solid var(--line); background:#fff; color:var(--ink); border-radius:6px; padding:8px 12px; cursor:pointer; }
    button:disabled { opacity:.45; cursor:not-allowed; }
    .scroll-sentinel { height:1px; }
    article { background:#fff; border:1px solid var(--line); border-radius:8px; padding:14px 16px; margin:10px 0; box-shadow:0 1px 2px rgba(15,23,42,.04); }
    article.anchor { border-color:var(--accent); box-shadow:0 0 0 2px rgba(8,145,178,.12); }
    .role { display:inline-flex; align-items:center; min-height:20px; border-radius:999px; background:var(--chip); padding:2px 8px; font-size:12px; font-weight:800; color:#0f5f76; }
    .time { margin-left:8px; color:var(--muted); font-size:12px; }
    .text { margin-top:10px; white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.65; font-size:14px; }
    .text a { color:#0369a1; font-weight:700; }
    .context-segments { display:grid; gap:9px; margin-top:10px; }
    .context-main { white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.65; font-size:14px; }
    .context-quote { border-left:3px solid #9ecfe1; background:#f2f8fb; color:#3f6474; padding:8px 11px; border-radius:0 7px 7px 0; display:grid; gap:4px; }
    .context-quote-label { color:#0f6f89; font-size:11px; font-weight:900; line-height:1.2; }
    .context-quote-text { white-space:pre-wrap; overflow-wrap:anywhere; line-height:1.56; font-size:13px; }
    .context-main a,
    .context-quote a { color:#0369a1; font-weight:700; }
    .empty { color:var(--muted); text-align:center; padding:48px 0; }
  </style>
</head>
<body>
  <header>
    <h1 id="session-title">MagClaw Team Sharing Context</h1>
    <div class="meta" id="session-meta">session: ${htmlEscape(sessionId)} · anchor: ${htmlEscape(initialAnchor || 'latest')} · order: ${htmlEscape(contextOrder === 'desc' ? 'newest first' : 'oldest first')}</div>
  </header>
  <main>
    <div id="top-sentinel" class="scroll-sentinel" aria-hidden="true"></div>
    <div class="controls"><button id="${isDesc ? 'load-more-next' : 'load-more-prev'}" type="button">${isDesc ? 'Load newer' : 'Load previous'}</button></div>
    <section id="events" aria-live="polite"><div class="empty">Loading context...</div></section>
    <div class="controls"><button id="${isDesc ? 'load-more-prev' : 'load-more-next'}" type="button">${isDesc ? 'Load older' : 'Load next'}</button></div>
    <div id="bottom-sentinel" class="scroll-sentinel" aria-hidden="true"></div>
  </main>
  <script>
    const sessionId = ${JSON.stringify(sessionId)};
    let anchorEventId = ${JSON.stringify(initialAnchor)};
    const order = ${JSON.stringify(contextOrder)};
    const vectorDocumentId = ${JSON.stringify(String(vectorDocumentId || ''))};
    const queryId = ${JSON.stringify(String(queryId || ''))};
    const sourceRef = ${JSON.stringify(String(sourceRef || ''))};
    const eventsEl = document.getElementById('events');
    const prevBtn = document.getElementById('load-more-prev');
    const nextBtn = document.getElementById('load-more-next');
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
    function linkifyText(text) {
      return escapeHtml(text).replace(/https?:\\/\\/[^\\s<]+/g, raw => {
        const parts = splitAutolinkUrl(raw);
        if (!parts.href) return raw;
        return '<a href="' + parts.href + '" target="_blank" rel="noreferrer">' + escapeHtml(parts.href) + '</a>' + escapeHtml(parts.trailing);
      });
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
    function recordFeedback(eventType) {
      if (!vectorDocumentId) return;
      fetch('/api/team-sharing/feedback', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ queryId, vectorDocumentId, sessionId, eventType, sourceRef })
      }).catch(() => {});
    }
    function updateButtons() {
      prevBtn.disabled = loading.prev || !hasPrev;
      nextBtn.disabled = loading.next || !hasNext;
    }
    function canLoad(direction) {
      if (direction === 'prev') return hasPrev && !loading.prev;
      if (direction === 'next') return hasNext && !loading.next;
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
    function eventSegments(event) {
      const segments = Array.isArray(event.contentSegments) && event.contentSegments.length
        ? event.contentSegments
        : (Array.isArray(event.metadata?.contentSegments) ? event.metadata.contentSegments : []);
      if (!segments.length) return '';
      return '<div class="context-segments">' + segments.map(segment => {
        const type = String(segment.type || '').toLowerCase();
        const text = segment.text || segment.content || '';
        if (!text) return '';
        if (type === 'body') return '<div class="context-main">' + linkifyText(text) + '</div>';
        return '<blockquote class="context-quote">' +
          (segment.label ? '<div class="context-quote-label">' + escapeHtml(segment.label) + '</div>' : '') +
          '<div class="context-quote-text">' + linkifyText(text) + '</div></blockquote>';
      }).join('') + '</div>';
    }
    function eventHtml(event) {
      const anchorClass = anchorEventId && event.eventId === anchorEventId ? ' anchor' : '';
      const session = window.__teamSharingSession || {};
      const body = eventSegments(event) || '<div class="text">' + linkifyText(event.displayText || event.cleanText || event.text || '') + '</div>';
      return '<article id="' + encodeURIComponent(event.eventId || '') + '" class="' + anchorClass.trim() + '">' +
        '<div><span class="role">' + escapeHtml(roleLabel(event, session)) + '</span><span class="time">' + escapeHtml(chinaTime(event.createdAt || '')) + '</span></div>' +
        body + '</article>';
    }
    async function load(direction) {
      if (loading[direction]) return;
      if (direction !== 'around' && !canLoad(direction)) return;
      loading[direction] = true;
      updateButtons();
      const beforeHeight = document.documentElement.scrollHeight;
      const beforeScrollY = window.scrollY;
      const anchor = direction === 'next' ? nextAnchor : prevAnchor;
      try {
        const url = '/api/team-sharing/context/${safeSession}?anchorEventId=' + encodeURIComponent(anchor || '') + '&direction=' + encodeURIComponent(direction) + '&limit=21&order=' + encodeURIComponent(order);
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
          if (direction !== 'around' && insertsAtTop) preserveScrollForPrepend(beforeHeight, beforeScrollY);
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
      } finally {
        loading[direction] = false;
        updateButtons();
      }
    }
    prevBtn.addEventListener('click', () => load('prev').catch(console.error));
    nextBtn.addEventListener('click', () => load('next').catch(console.error));
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
    const request = {
      deviceCodeHash: hashSecret(deviceCode),
      userCode,
      workspaceId: requestWorkspaceId,
      profile: body.profile || 'default',
      packageName: body.packageName || 'team-sharing',
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
    const approvalActor = actor || currentActor({
      ...req,
      headers: {
        ...(req.headers || {}),
        'x-magclaw-workspace-id': request.workspaceId || workspaceId,
      },
    });
    if (!approvalActor) {
      sendError(res, 401, 'Sign in to MagClaw before approving Team Sharing login.');
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

  const contextPageMatch = url.pathname.match(/^\/team-sharing\/context\/([^/]+)$/);
  if (req.method === 'GET' && contextPageMatch) {
    if (!requestHasTeamSharingAuth(req, { actor, teamSharingState, teamSharingAuthRequired, validTeamSharingToken })) {
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
        workspaceId: effectiveWorkspaceId,
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
      candidateCount: vector.candidates?.length || 0,
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
