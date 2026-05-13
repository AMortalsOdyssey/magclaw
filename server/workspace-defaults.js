function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function defaultNormalizeIds(items) {
  return [...new Set(safeArray(items).filter(Boolean).map(String))];
}

function cleanWorkspaceId(value) {
  return String(value || '').trim();
}

export function isWorkspaceAllChannel(channel) {
  return Boolean(channel && (
    channel.locked
    || channel.defaultChannel
    || String(channel.id || '') === 'chan_all'
    || String(channel.name || '').trim().toLowerCase() === 'all'
  ));
}

export function findWorkspaceAllChannel(state, workspaceId = '') {
  const cleanId = cleanWorkspaceId(workspaceId);
  const channels = safeArray(state?.channels).filter((channel) => !channel?.archived);
  const scoped = channels.find((channel) => (
    isWorkspaceAllChannel(channel)
    && cleanWorkspaceId(channel.workspaceId) === cleanId
  ));
  if (scoped) return scoped;
  if (!cleanId || cleanId === 'local') {
    return channels.find((channel) => String(channel.id || '') === 'chan_all') || null;
  }
  return null;
}

export function ensureWorkspaceAllChannel({
  state,
  workspaceId,
  workspace = null,
  humanIds = [],
  agentIds = [],
  makeId,
  now,
  normalizeIds = defaultNormalizeIds,
}) {
  const cleanId = cleanWorkspaceId(workspaceId || workspace?.id || state?.connection?.workspaceId || 'local');
  if (!state || !cleanId) return { channel: null, changed: false };
  state.channels = safeArray(state.channels);
  const timestamp = typeof now === 'function' ? now() : new Date().toISOString();
  let changed = false;
  let channel = findWorkspaceAllChannel(state, cleanId);
  if (!channel) {
    const existingIds = new Set(state.channels.map((item) => item?.id).filter(Boolean));
    const channelId = cleanId === 'local' && !existingIds.has('chan_all')
      ? 'chan_all'
      : (typeof makeId === 'function' ? makeId('chan') : `chan_all_${cleanId.replace(/[^a-zA-Z0-9_-]/g, '_')}`);
    channel = {
      id: channelId,
      workspaceId: cleanId,
      name: 'all',
      description: 'Default server-wide channel.',
      ownerId: safeArray(humanIds)[0] || '',
      humanIds: [],
      agentIds: [],
      memberIds: [],
      locked: true,
      defaultChannel: true,
      archived: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    state.channels.push(channel);
    changed = true;
  }
  if (!channel.workspaceId) {
    channel.workspaceId = cleanId;
    changed = true;
  }
  if (!channel.locked) {
    channel.locked = true;
    changed = true;
  }
  if (!channel.defaultChannel) {
    channel.defaultChannel = true;
    changed = true;
  }
  if (!channel.name) {
    channel.name = 'all';
    changed = true;
  }
  const nextHumanIds = normalizeIds([...(channel.humanIds || []), ...humanIds]);
  const nextAgentIds = normalizeIds([...(channel.agentIds || []), ...agentIds]);
  const nextMemberIds = normalizeIds([...(channel.memberIds || []), ...nextHumanIds, ...nextAgentIds]);
  if (nextHumanIds.join('\0') !== safeArray(channel.humanIds).map(String).join('\0')) {
    channel.humanIds = nextHumanIds;
    changed = true;
  }
  if (nextAgentIds.join('\0') !== safeArray(channel.agentIds).map(String).join('\0')) {
    channel.agentIds = nextAgentIds;
    changed = true;
  }
  if (nextMemberIds.join('\0') !== safeArray(channel.memberIds).map(String).join('\0')) {
    channel.memberIds = nextMemberIds;
    changed = true;
  }
  if (changed) channel.updatedAt = timestamp;
  return { channel, changed };
}
