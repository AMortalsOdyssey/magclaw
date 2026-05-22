export const CLOUD_ROLES = ['member', 'admin', 'owner'];

export const CLOUD_ROLE_LABELS = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
};

const LEGACY_ROLE_MAP = new Map([
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
  const isOwner = normalized === 'owner';
  const isAdmin = normalized === 'admin' || isOwner;
  return {
    chat_channels: true,
    chat_agent_dm: true,
    warm_agents: true,
    invite_member: isAdmin,
    manage_member_roles: isAdmin,
    manage_owner_role: isOwner,
    remove_member: isAdmin,
    remove_admin: isAdmin,
    remove_owner: isOwner,
    manage_computers: isAdmin,
    upgrade_computers: isAdmin,
    manage_agents: isAdmin,
    manage_channels: isAdmin,
    manage_projects: isAdmin,
    manage_system: isAdmin,
    manage_cloud_connection: isAdmin,
    pair_computers: isAdmin,
    scan_machine_workspaces: isAdmin,
    detect_runtime: isAdmin,
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
  const actor = normalizeCloudRole(actorRole, null);
  const target = normalizeCloudRole(targetRole, null);
  if (!target) return false;
  if (target === 'owner') return actor === 'owner';
  return roleAllows(actor, ['admin']) && (target === 'member' || target === 'admin');
}

export function canUpdateMemberRole(actorRole, targetRole, nextRole) {
  const actor = normalizeCloudRole(actorRole, null);
  const target = normalizeCloudRole(targetRole, null);
  const rawNext = String(nextRole || '').trim().toLowerCase();
  if (rawNext !== 'member' && rawNext !== 'admin' && rawNext !== 'owner') return false;
  const next = normalizeCloudRole(nextRole, null);
  if (!actor || !target || !next) return false;
  if (!roleAllows(actor, ['admin'])) return false;
  if (target === 'owner' || next === 'owner') return actor === 'owner';
  return (target === 'member' || target === 'admin') && (next === 'member' || next === 'admin');
}
