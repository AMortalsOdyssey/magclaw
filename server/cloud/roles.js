export const CLOUD_ROLES = ['member', 'core_member', 'admin'];

export const CLOUD_ROLE_LABELS = {
  admin: 'Admin',
  core_member: 'Core Member',
  member: 'Member',
};

const LEGACY_ROLE_MAP = {
  owner: 'admin',
  viewer: 'member',
  agent_admin: 'core_member',
  computer_admin: 'core_member',
};

const ROLE_RANK = new Map(CLOUD_ROLES.map((role, index) => [role, index]));

export function normalizeCloudRole(value, fallback = 'member') {
  const raw = String(value || '').trim().toLowerCase();
  const mapped = LEGACY_ROLE_MAP[raw] || raw;
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
  const isCore = roleAllows(normalized, ['core_member']);
  return {
    invite_member: true,
    invite_core_member: isCore,
    manage_member_roles: isCore,
    remove_member: isCore,
    remove_core_member: isAdmin,
    remove_admin: isAdmin,
    manage_computers: isCore,
    manage_agents: isCore,
    manage_channels: isCore,
    manage_projects: isCore,
    manage_system: isAdmin,
    manage_cloud_connection: isAdmin,
    pair_computers: isAdmin,
  };
}

export function canInviteRole(actorRole, targetRole) {
  const target = normalizeCloudRole(targetRole, null);
  if (!target) {
    return false;
  }
  if (target === 'member') {
    return true;
  }
  if (target === 'core_member') {
    return roleAllows(actorRole, ['core_member']);
  }
  return false;
}

export function canRemoveRole(actorRole, targetRole) {
  const target = normalizeCloudRole(targetRole, null);
  if (!target) {
    return false;
  }
  if (normalizeCloudRole(actorRole) === 'admin') {
    return true;
  }
  return normalizeCloudRole(actorRole) === 'core_member' && target === 'member';
}

export function canUpdateMemberRole(actorRole, targetRole, nextRole) {
  const actor = normalizeCloudRole(actorRole, null);
  const target = normalizeCloudRole(targetRole, null);
  const next = normalizeCloudRole(nextRole, null);
  if (!actor || !target || !next) return false;
  if (!roleAllows(actor, ['core_member'])) return false;
  if (target === 'admin' || next === 'admin') return false;
  return next === 'member' || next === 'core_member';
}
