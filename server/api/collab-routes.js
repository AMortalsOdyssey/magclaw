import os from 'node:os';

// Collaboration object API routes.
// Channels, DMs, computers, and humans are the durable workspace directory
// objects. Message delivery, task flow, and Agent runtime stay in other modules,
// so this route group only manages membership and directory metadata.

export async function handleCollabApi(req, res, url, deps) {
  const {
    addCollabEvent,
    agentParticipatesInChannels,
      broadcastState,
      currentActor,
      daemonRelay,
      findAgent,
    findChannel,
    findComputer,
    getState,
    makeId,
    normalizeConversationRecord,
    normalizeIds,
    normalizeName,
    now,
    persistState,
    readJson,
    scheduleAgentMemoryWriteback,
    sendError,
    sendJson,
  } = deps;
  const state = getState();

  if (req.method === 'POST' && url.pathname === '/api/channels') {
    const body = await readJson(req);
    const name = normalizeName(body.name, 'new-channel');
    if (!name) {
      sendError(res, 400, 'Channel name is required.');
      return true;
    }
    if (state.channels.some((channel) => channel.name === name && !channel.archived)) {
      sendError(res, 409, 'Channel already exists.');
      return true;
    }
    const humanIds = Array.isArray(body.humanIds) && body.humanIds.length ? body.humanIds.map(String) : ['hum_local'];
    const agentIds = Array.isArray(body.agentIds)
      ? body.agentIds.map(String).filter((id) => agentParticipatesInChannels(findAgent(id)))
      : [];
    // Keep the canonical member list and the older humanIds/agentIds fields in
    // sync; parts of the UI still read the legacy split fields directly.
    const memberIds = [...new Set([...humanIds, ...agentIds])];
    const channel = {
      id: makeId('chan'),
      name,
      description: String(body.description || '').trim(),
      ownerId: String(body.ownerId || 'hum_local'),
      humanIds,
      agentIds,
      memberIds,
      archived: false,
      createdAt: now(),
      updatedAt: now(),
    };
    state.channels.push(channel);
    // A system message gives newly-created channels an anchor conversation
    // record, which keeps thread/search/task rendering paths consistent.
    state.messages.push(normalizeConversationRecord({
      id: makeId('msg'),
      spaceType: 'channel',
      spaceId: channel.id,
      authorType: 'system',
      authorId: 'system',
      body: `Channel #${channel.name} created.`,
      attachmentIds: [],
      replyCount: 0,
      savedBy: [],
      createdAt: now(),
      updatedAt: now(),
    }));
    addCollabEvent('channel_created', `Channel #${channel.name} created.`, { channelId: channel.id });
    for (const agentId of agentIds) {
      const agent = findAgent(agentId);
      if (agent) scheduleAgentMemoryWriteback(agent, 'channel_membership_changed', { channel });
    }
    await persistState();
    broadcastState();
    sendJson(res, 201, { channel });
    return true;
  }

  const channelMatch = url.pathname.match(/^\/api\/channels\/([^/]+)$/);
  if (['PATCH', 'POST'].includes(req.method) && channelMatch) {
    const channel = findChannel(channelMatch[1]);
    if (!channel) {
      sendError(res, 404, 'Channel not found.');
      return true;
    }
    const body = await readJson(req);
    if (body.name !== undefined) channel.name = normalizeName(body.name, channel.name);
    if (body.description !== undefined) channel.description = String(body.description || '').trim();
    if (body.ownerId !== undefined) channel.ownerId = String(body.ownerId || channel.ownerId || 'hum_local');
    const previousAgentIds = normalizeIds(channel.agentIds);
    if (Array.isArray(body.agentIds)) {
      channel.agentIds = body.agentIds.map(String).filter((id) => agentParticipatesInChannels(findAgent(id)));
    }
    if (Array.isArray(body.humanIds)) channel.humanIds = body.humanIds.map(String);
    if (Array.isArray(body.memberIds)) {
      channel.memberIds = body.memberIds.map(String).filter((id) => !id.startsWith('agt_') || agentParticipatesInChannels(findAgent(id)));
    }
    const changedAgentIds = normalizeIds([...previousAgentIds, ...(channel.agentIds || [])]);
    if (body.archived !== undefined) channel.archived = Boolean(body.archived);
    channel.updatedAt = now();
    addCollabEvent('channel_updated', `Channel #${channel.name} updated.`, { channelId: channel.id });
    for (const agentId of changedAgentIds) {
      const agent = findAgent(agentId);
      if (agent) scheduleAgentMemoryWriteback(agent, 'channel_membership_changed', { channel });
    }
    await persistState();
    broadcastState();
    sendJson(res, 200, { channel });
    return true;
  }

  const channelMembersMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/members$/);
  if (req.method === 'POST' && channelMembersMatch) {
    const channel = findChannel(channelMembersMatch[1]);
    if (!channel) {
      sendError(res, 404, 'Channel not found.');
      return true;
    }
    const body = await readJson(req);
    const memberId = String(body.memberId || '').trim();
    if (!memberId) {
      sendError(res, 400, 'Member ID is required.');
      return true;
    }
    if (memberId.startsWith('agt_') && !agentParticipatesInChannels(findAgent(memberId))) {
      sendError(res, 400, 'Agent cannot be added as a channel member.');
      return true;
    }
    channel.memberIds = Array.isArray(channel.memberIds) ? channel.memberIds : [];
    if (!channel.memberIds.includes(memberId)) {
      channel.memberIds.push(memberId);
      // Preserve backward compatibility with code paths that still query
      // channel.agentIds/channel.humanIds instead of channel.memberIds.
      if (memberId.startsWith('agt_')) {
        channel.agentIds = Array.isArray(channel.agentIds) ? channel.agentIds : [];
        if (!channel.agentIds.includes(memberId)) channel.agentIds.push(memberId);
      } else if (memberId.startsWith('hum_')) {
        channel.humanIds = Array.isArray(channel.humanIds) ? channel.humanIds : [];
        if (!channel.humanIds.includes(memberId)) channel.humanIds.push(memberId);
      }
      channel.updatedAt = now();
      addCollabEvent('channel_member_added', `Member added to #${channel.name}`, { channelId: channel.id, memberId });
      const agent = memberId.startsWith('agt_') ? findAgent(memberId) : null;
      if (agent) scheduleAgentMemoryWriteback(agent, 'channel_membership_changed', { channel });
      await persistState();
      broadcastState();
    }
    sendJson(res, 200, { channel });
    return true;
  }

  const channelMemberRemoveMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/members\/([^/]+)$/);
  if (req.method === 'DELETE' && channelMemberRemoveMatch) {
    const channel = findChannel(channelMemberRemoveMatch[1]);
    if (!channel) {
      sendError(res, 404, 'Channel not found.');
      return true;
    }
    const memberId = channelMemberRemoveMatch[2];
    // Remove from all membership representations so future route decisions and
    // older UI filters observe the same channel membership.
    channel.memberIds = Array.isArray(channel.memberIds) ? channel.memberIds.filter((id) => id !== memberId) : [];
    channel.agentIds = Array.isArray(channel.agentIds) ? channel.agentIds.filter((id) => id !== memberId) : [];
    channel.humanIds = Array.isArray(channel.humanIds) ? channel.humanIds.filter((id) => id !== memberId) : [];
    channel.updatedAt = now();
    addCollabEvent('channel_member_removed', `Member removed from #${channel.name}`, { channelId: channel.id, memberId });
    const agent = memberId.startsWith('agt_') ? findAgent(memberId) : null;
    if (agent) scheduleAgentMemoryWriteback(agent, 'channel_membership_changed', { channel });
    await persistState();
    broadcastState();
    sendJson(res, 200, { channel });
    return true;
  }

  const channelLeaveMatch = url.pathname.match(/^\/api\/channels\/([^/]+)\/leave$/);
  if (req.method === 'POST' && channelLeaveMatch) {
    const channel = findChannel(channelLeaveMatch[1]);
    if (!channel) {
      sendError(res, 404, 'Channel not found.');
      return true;
    }
    if (channel.id === 'chan_all') {
      sendError(res, 400, 'Cannot leave the #all channel.');
      return true;
    }
    const memberId = 'hum_local';
    // Leaving a channel is local-human only for now; team-wide removal should
    // continue to use the explicit member DELETE endpoint above.
    channel.memberIds = Array.isArray(channel.memberIds) ? channel.memberIds.filter((id) => id !== memberId) : [];
    channel.humanIds = Array.isArray(channel.humanIds) ? channel.humanIds.filter((id) => id !== memberId) : [];
    channel.updatedAt = now();
    addCollabEvent('channel_left', `Left #${channel.name}`, { channelId: channel.id, memberId });
    await persistState();
    broadcastState();
    sendJson(res, 200, { channel });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/dms') {
    const body = await readJson(req);
    const participantId = String(body.participantId || '').trim();
    if (!participantId) {
      sendError(res, 400, 'Participant is required.');
      return true;
    }
    const auth = typeof currentActor === 'function' ? currentActor(req) : null;
    const humanId = auth?.member?.humanId || 'hum_local';
    let dm = state.dms.find((item) => (
      item.participantIds.includes(humanId)
      && item.participantIds.includes(participantId)
    ));
    if (!dm) {
      // DMs are keyed by the current human and the peer so each cloud member
      // keeps a private conversation with the same Agent.
      dm = {
        id: makeId('dm'),
        participantIds: [humanId, participantId],
        createdAt: now(),
        updatedAt: now(),
      };
      state.dms.push(dm);
    }
    addCollabEvent('dm_opened', 'DM opened.', { dmId: dm.id });
    await persistState();
    broadcastState();
    sendJson(res, 200, { dm });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/computers') {
    const body = await readJson(req);
    const createdAt = now();
    const computer = {
      id: makeId('cmp'),
      name: String(body.name || os.hostname()).trim(),
      os: String(body.os || `${os.platform()} ${os.arch()}`),
      daemonVersion: String(body.daemonVersion || ''),
      status: body.status || 'offline',
      runtimeIds: Array.isArray(body.runtimeIds) ? body.runtimeIds.map(String) : ['codex'],
      connectedVia: body.connectedVia || 'manual',
      createdAt,
      updatedAt: createdAt,
      disabledAt: null,
    };
    state.computers.push(computer);
    addCollabEvent('computer_added', `Computer added: ${computer.name}`, { computerId: computer.id });
    await persistState();
    broadcastState();
    sendJson(res, 201, { computer });
    return true;
  }

    const computerMatch = url.pathname.match(/^\/api\/computers\/([^/]+)$/);
    if (req.method === 'DELETE' && computerMatch) {
      const computer = findComputer(computerMatch[1]);
      if (!computer) {
        sendError(res, 404, 'Computer not found.');
        return true;
      }
      const boundAgents = state.agents.filter((agent) => agent.computerId === computer.id);
      if (boundAgents.length) {
        sendError(res, 409, 'Delete or migrate agents before deleting this computer.');
        return true;
      }
      state.computers = state.computers.filter((item) => item.id !== computer.id);
      addCollabEvent('computer_deleted', `Computer deleted: ${computer.name}`, { computerId: computer.id });
      await persistState();
      broadcastState();
      sendJson(res, 200, { ok: true });
      return true;
    }
    if (['PATCH', 'POST'].includes(req.method) && computerMatch) {
    const computer = findComputer(computerMatch[1]);
    if (!computer) {
      sendError(res, 404, 'Computer not found.');
      return true;
    }
    const body = await readJson(req);
    for (const key of ['name', 'os', 'daemonVersion']) {
      if (body[key] !== undefined) computer[key] = String(body[key] || '').trim();
    }
    if (body.status !== undefined) {
      const nextStatus = String(body.status || '').trim().toLowerCase();
      if (!['pairing', 'connected', 'offline', 'disabled'].includes(nextStatus)) {
        sendError(res, 400, 'Unsupported computer status.');
        return true;
      }
      computer.status = nextStatus;
      if (nextStatus === 'disabled') {
        computer.disabledAt = now();
        computer.disconnectedAt = computer.disconnectedAt || computer.disabledAt;
        daemonRelay?.disconnectComputer?.(computer.id, 'This computer was disabled in MagClaw Cloud.');
        for (const agent of state.agents.filter((item) => item.computerId === computer.id && !item.deletedAt)) {
          agent.status = 'disabled';
          agent.disabledByComputerAt = computer.disabledAt;
          agent.statusUpdatedAt = computer.disabledAt;
          agent.updatedAt = computer.disabledAt;
        }
        addCollabEvent('computer_disabled', `Computer disabled: ${computer.name}`, { computerId: computer.id });
      } else if (computer.disabledAt) {
        computer.disabledAt = null;
        for (const agent of state.agents.filter((item) => item.computerId === computer.id && item.disabledByComputerAt && !item.deletedAt)) {
          agent.status = 'idle';
          agent.disabledByComputerAt = null;
          agent.statusUpdatedAt = now();
          agent.updatedAt = agent.statusUpdatedAt;
        }
        addCollabEvent('computer_enabled', `Computer enabled: ${computer.name}`, { computerId: computer.id });
      }
    }
    computer.updatedAt = now();
    await persistState();
    broadcastState();
    sendJson(res, 200, { computer });
      return true;
    }

    const humanMatch = url.pathname.match(/^\/api\/humans\/([^/]+)$/);
    if (['PATCH', 'POST'].includes(req.method) && humanMatch) {
      const human = state.humans.find((item) => item.id === humanMatch[1]);
      if (!human) {
        sendError(res, 404, 'Human not found.');
        return true;
      }
      const auth = typeof currentActor === 'function' ? currentActor(req) : null;
      const ownsHuman = auth && (auth.member?.humanId === human.id || auth.user?.id === human.authUserId);
      if (auth && !ownsHuman && auth.member?.role !== 'admin') {
        sendError(res, 403, 'Workspace role is not allowed.');
        return true;
      }
      if (auth && auth.user?.id === human.authUserId && !auth.member?.humanId) auth.member.humanId = human.id;
      const body = await readJson(req);
      if (body.displayName !== undefined || body.name !== undefined) {
        const name = String(body.displayName ?? body.name ?? '').trim();
        if (name) human.name = name.slice(0, 120);
      }
      if (body.description !== undefined) human.description = String(body.description || '').trim().slice(0, 3000);
      if (body.avatar !== undefined) human.avatar = String(body.avatar || '').trim();
      human.updatedAt = now();
      const cloudUser = auth?.user && auth.member?.humanId === human.id
        ? (state.cloud?.users || []).find((user) => user.id === auth.user.id)
        : null;
      if (cloudUser) {
        cloudUser.name = human.name;
        cloudUser.avatarUrl = human.avatar || '';
        cloudUser.updatedAt = human.updatedAt;
      }
      await persistState();
      broadcastState();
      sendJson(res, 200, { human });
      return true;
    }

    if (req.method === 'POST' && url.pathname === '/api/humans') {
    const body = await readJson(req);
    const email = String(body.email || '').trim();
    const human = {
      id: makeId('hum'),
      name: String(body.name || email.split('@')[0] || 'Human').trim(),
      email,
      role: body.role || 'member',
      status: 'invited',
      createdAt: now(),
    };
    state.humans.push(human);
    const allChannel = findChannel('chan_all');
    if (allChannel) {
      // New humans join #all by default so the shared workspace remains visible
      // without a separate invitation flow.
      allChannel.humanIds = normalizeIds([...(allChannel.humanIds || []), human.id]);
      allChannel.memberIds = normalizeIds([...(allChannel.memberIds || []), human.id]);
      allChannel.updatedAt = now();
    }
    addCollabEvent('human_invited', `Human invited: ${human.email || human.name}`, { humanId: human.id });
    await persistState();
    broadcastState();
    sendJson(res, 201, { human });
    return true;
  }

  return false;
}
