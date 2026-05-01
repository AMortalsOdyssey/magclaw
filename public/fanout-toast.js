function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function byId(items, id) {
  return (items || []).find((item) => item.id === id);
}

export function routeAgentNames(routeEvent, stateSnapshot = {}) {
  const agents = stateSnapshot?.agents || [];
  const names = (routeEvent?.targetAgentIds || [])
    .map((id) => byId(agents, id)?.name || id)
    .filter(Boolean);
  return names.length ? names.join(', ') : 'No agent selected';
}

export function routeEvidenceSummary(routeEvent) {
  const evidence = (routeEvent?.evidence || [])
    .filter((item) => item?.value)
    .map((item) => `${item.type}: ${item.value}`)
    .slice(0, 2)
    .join(' / ');
  return evidence || 'No extra evidence recorded';
}

export function compactFanoutReason(routeEvent) {
  const reason = String(routeEvent?.reason || routeEvidenceSummary(routeEvent) || '需要语义判断。')
    .replace(/\s+/g, ' ')
    .trim();
  return reason.length > 92 ? `${reason.slice(0, 89)}...` : reason;
}

export function buildFanoutDecisionCards(routeEvent, stateSnapshot = {}) {
  return [
    {
      id: routeEvent.id,
      phase: 'decision',
      title: 'LLM fan-out',
      body: `路由到：${routeAgentNames(routeEvent, stateSnapshot)}`,
      meta: `原因：${compactFanoutReason(routeEvent)}`,
    },
  ];
}

export function renderFanoutDecisionToasts(cards = []) {
  return `
    <div class="fanout-toast-stack" aria-live="polite" aria-atomic="false">
      ${cards.map((card) => `
        <article class="fanout-toast-card fanout-toast-${escapeHtml(card.phase)}${card.exiting ? ' exiting' : ''}">
          <div class="fanout-toast-title">${escapeHtml(card.title)}</div>
          <div class="fanout-toast-body">${escapeHtml(card.body)}</div>
          <div class="fanout-toast-meta">${escapeHtml(card.meta || '')}</div>
        </article>
      `).join('')}
    </div>
  `;
}
