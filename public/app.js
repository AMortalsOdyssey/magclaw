import {
  buildFanoutDecisionCards,
  renderFanoutDecisionToasts as renderFanoutDecisionToastsHtml,
} from './fanout-toast.js';

globalThis.buildFanoutDecisionCards = buildFanoutDecisionCards;
globalThis.renderFanoutDecisionToastsHtml = renderFanoutDecisionToastsHtml;

const appScripts = [
  '/app/i18n.js',
  '/app/prelude.js',
  '/app/state-render-core.js',
  '/app/notifications-layout-avatar.js',
  '/app/avatar-upload.js',
  '/app/data-search-mentions.js',
  '/app/conversation-scroll-notifications.js',
  '/app/render-shell-rail-inbox.js',
  '/app/render-space-chat-tasks.js',
  '/app/render-search-settings.js',
  '/app/render-lost-space.js',
  '/app/render-release-settings.js',
  '/app/render-agent-detail.js',
  '/app/render-modals-uploads.js',
  '/app/sync-events-keyboard.js',
  '/app/click-prepare.js',
  '/app/change-paste-click.js',
  '/app/submit-startup.js',
];

function escapeBootError(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function loadAppScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = false;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load ' + src));
    document.head.appendChild(script);
  });
}

try {
  for (const script of appScripts) {
    await loadAppScript(script);
  }
} catch (error) {
  console.error('Failed to boot MagClaw app:', error);
  const root = document.querySelector('#root');
  if (root) root.innerHTML = '<div class="boot">MAGCLAW LOCAL / ' + escapeBootError(error.message) + '</div>';
}
