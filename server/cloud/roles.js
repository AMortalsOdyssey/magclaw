export const CLOUD_ROLES = ['member', 'admin'];

export const CLOUD_ROLE_LABELS = {
  admin: 'Admin',
  member: 'Member',
};

const LEGACY_ROLE_MAP = new Map([
  ['owner', 'admin'],
  ['viewer', 'member'],
  [['agent', 'admin'].join('_'), 'admin'],
  [['computer', 'admin'].join('_'), 'admin'],
]);

const ROLE_RANK = new Map(CLOUD_ROLES.map((role, index) => [role, index]));

export function normalizeCloudRole(value, fallback = 'member') {
  const raw = String(value || '').trim().toLowerCase();
  const mapped = LEGACY_ROLE_MAP.get(raw) || raw;
  return ROLE_RANK.has(mapped) ? mapped : fallback;
}

export function roleAllows(role, allowedRoles = []) {
  if (!allowedRoles.length) return true;
  const normalized = normalizeCloudRole(role);
  const rank = ROLE_RANK.get(normalized) ?? 0;
  return allowedRoles.some((allowedRole) => rank >= (ROLE_RANK.get(normalizeCloudRole(allowedRole)) ?? Number.POSITIVE_INFINITY));
}

export function cloudCapabilitiesForRole(role) {
  const normalized = normalizeCloudRole(role);
  const isAdmin = normalized === 'admin';
  return {
    chat_channels: true,
    chat_agent_dm: true,
    warm_agents: true,
    invite_member: isAdmin,
    manage_member_roles: isAdmin,
    remove_member: isAdmin,
    remove_admin: isAdmin,
    manage_computers: isAdmin,
    manage_agents: isAdmin,
    manage_channels: isAdmin,
    manage_projects: isAdmin,
    manage_system: isAdmin,
    manage_cloud_connection: isAdmin,
    pair_computers: isAdmin,
  };
}

export function canInviteRole(actorRole, targetRole) {
  const rawTarget = String(targetRole || '').trim().toLowerCase();
  if (rawTarget !== 'member' && rawTarget !== 'admin') return false;
  const target = normalizeCloudRole(targetRole, null);
  if (!target) return false;
  return roleAllows(actorRole, ['admin']) && (target === 'member' || target === 'admin');
}

export function canRemoveRole(actorRole, targetRole) {
  const target = normalizeCloudRole(targetRole, null);
  if (!target) return false;
  return normalizeCloudRole(actorRole) === 'admin' && (target === 'member' || target === 'admin');
}

export function canUpdateMemberRole(actorRole, targetRole, nextRole) {
  const actor = normalizeCloudRole(actorRole, null);
  const target = normalizeCloudRole(targetRole, null);
  const rawNext = String(nextRole || '').trim().toLowerCase();
  if (rawNext !== 'member' && rawNext !== 'admin') return false;
  const next = normalizeCloudRole(nextRole, null);
  if (!actor || !target || !next) return false;
  if (!roleAllows(actor, ['admin'])) return false;
  return (target === 'member' || target === 'admin') && (next === 'member' || next === 'admin');
}
