import { normalizeIds } from './mentions.js';

function defaultAgentAvailable(agent) {
  const status = String(agent?.status || '').trim().toLowerCase();
  return !['offline', 'stopped', 'error', 'disabled', 'working'].includes(status);
}

function isTopLevelChannelAgentMessage(record) {
  return Boolean(
    record
    && record.authorType === 'agent'
    && record.spaceType === 'channel'
    && !record.parentMessageId
  );
}

export function selectAgentAwarenessTargets({
  state,
  channel,
  record,
  channelAgentIds,
  findAgent,
  agentAvailableForAutoWork = defaultAgentAvailable,
  maxRelayDepth = 1,
} = {}) {
  if (!isTopLevelChannelAgentMessage(record)) return [];
  const relayDepth = Number(record.agentRelayDepth || 0);
  if (relayDepth > maxRelayDepth) return [];
  if (!channel) return [];

  const agentIds = typeof channelAgentIds === 'function'
    ? channelAgentIds(channel)
    : normalizeIds([
      ...(Array.isArray(channel.agentIds) ? channel.agentIds : []),
      ...(Array.isArray(channel.memberIds) ? channel.memberIds.filter((id) => String(id).startsWith('agt_')) : []),
    ]);
  const lookup = typeof findAgent === 'function'
    ? findAgent
    : (id) => (state?.agents || []).find((agent) => agent.id === id) || null;

  return normalizeIds(agentIds)
    .filter((id) => id !== record.authorId)
    .map((id) => lookup(id))
    .filter(Boolean)
    .filter((agent) => agentAvailableForAutoWork(agent));
}
