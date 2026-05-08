export const CONSOLE_ROUTES = Object.freeze({
  root: '/console',
  invitations: '/console/invitations',
  servers: '/console/servers',
});

export const SERVER_ROUTE_PREFIX = '/s';

export function serverRoute(serverSlug, suffix = '') {
  const slug = encodeURIComponent(String(serverSlug || 'local').trim() || 'local');
  const cleanSuffix = String(suffix || '').replace(/^\/+/, '');
  return cleanSuffix ? `${SERVER_ROUTE_PREFIX}/${slug}/${cleanSuffix}` : `${SERVER_ROUTE_PREFIX}/${slug}`;
}

export const API_ROUTES = Object.freeze({
  health: '/api/healthz',
  ready: '/api/readyz',
  authLogin: '/api/auth/login',
  authLogout: '/api/auth/logout',
  authRegister: '/api/auth/register',
  authForgotPassword: '/api/auth/forgot-password',
  authResetPassword: '/api/auth/reset-password',
  consoleInvitations: '/api/console/invitations',
  consoleServers: '/api/console/servers',
});

export function consoleInvitationActionRoute(invitationId, action) {
  const id = encodeURIComponent(String(invitationId || ''));
  const verb = String(action || '').trim();
  return `${API_ROUTES.consoleInvitations}/${id}/${verb}`;
}

