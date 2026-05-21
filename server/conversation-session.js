function cleanPart(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

export function conversationLaneKey({
  workspaceId = 'local',
  spaceType = 'channel',
  spaceId = '',
  parentMessageId = null,
} = {}) {
  const kind = cleanPart(spaceType, 'channel') === 'dm' ? 'dm' : 'channel';
  const workspace = cleanPart(workspaceId, 'local');
  const space = cleanPart(spaceId, kind === 'dm' ? 'dm' : 'chan_all');
  const parent = cleanPart(parentMessageId);
  return parent
    ? `${kind}:${workspace}:${space}:thread:${parent}`
    : `${kind}:${workspace}:${space}:top`;
}

export function agentRuntimeProcessKey(agentId, sessionKey) {
  return `${cleanPart(agentId, 'agent')}:${cleanPart(sessionKey, 'default')}`;
}

export function workspaceIdForConversation(state, {
  workspaceId = '',
  spaceType = '',
  spaceId = '',
  fallbackRecord = null,
  agent = null,
} = {}) {
  const explicit = cleanPart(workspaceId);
  if (explicit) return explicit;
  const collection = spaceType === 'dm' ? state?.dms : state?.channels;
  const space = Array.isArray(collection)
    ? collection.find((item) => item?.id === spaceId)
    : null;
  return cleanPart(
    fallbackRecord?.workspaceId
      || space?.workspaceId
      || agent?.workspaceId
      || state?.connection?.workspaceId
      || state?.cloud?.workspace?.id,
    'local',
  );
}

export function conversationLaneKeyForMessage(state, {
  agent = null,
  spaceType = '',
  spaceId = '',
  message = null,
  parentMessageId = null,
  workspaceId = '',
} = {}) {
  const resolvedParent = parentMessageId || message?.parentMessageId || null;
  const resolvedWorkspace = workspaceIdForConversation(state, {
    workspaceId,
    spaceType,
    spaceId,
    fallbackRecord: message,
    agent,
  });
  return conversationLaneKey({
    workspaceId: resolvedWorkspace,
    spaceType,
    spaceId,
    parentMessageId: resolvedParent,
  });
}

export function runtimeSessionLabel({ spaceType, spaceId, parentMessageId = null } = {}) {
  return `${spaceType || 'space'}:${spaceId || ''}${parentMessageId ? `:${parentMessageId}` : ''}`;
}
