import path from 'node:path';

// Agent control API routes.
// These endpoints mutate Agent records or control local Agent processes. The
// actual runtime/session helpers remain injected so this module stays focused
// on HTTP validation, state updates, and preserving legacy membership fields.

export async function handleAgentApi(req, res, url, deps) {
  const {
    addCollabEvent,
    agentParticipatesInChannels,
    broadcastState,
    clearAgentProcesses,
    ensureAgentWorkspace,
    findAgent,
    findChannel,
    getState,
    hasAgentProcess,
    listAgentSkills,
    listAgentWorkspace,
    makeId,
    normalizeCodexModelName,
    normalizeIds,
    now,
    persistState,
    readAgentWorkspaceFile,
    readJson,
    restartAgentFromControl,
    root,
    sendError,
    sendJson,
    setAgentStatus,
    startAgentFromControl,
    stopAgentProcesses,
    stopRunsForScope,
    stopScopeFromBody,
    warmAgentFromControl,
  } = deps;
  const state = getState();

  if (req.method === 'POST' && url.pathname === '/api/agents') {
    const body = await readJson(req);
    const agent = {
      id: makeId('agt'),
      name: String(body.name || 'New Agent').trim().slice(0, 80),
      description: String(body.description || '').trim(),
      runtime: String(body.runtime || 'Codex CLI'),
      model: normalizeCodexModelName(body.model, state.settings?.model),
      status: 'idle',
      computerId: String(body.computerId || 'cmp_local'),
      workspace: path.resolve(String(body.workspace || state.settings.defaultWorkspace || root)),
      reasoningEffort: body.reasoningEffort ? String(body.reasoningEffort) : null,
      envVars: Array.isArray(body.envVars) ? body.envVars : null,
      avatar: body.avatar ? String(body.avatar) : null,
      statusUpdatedAt: now(),
      heartbeatAt: now(),
      createdAt: now(),
    };
    state.agents.push(agent);

    // Seed the workspace before broadcasting so the UI can open the workspace
    // tab immediately after Agent creation without a second initialization pass.
    await ensureAgentWorkspace(agent);

    const allChannel = findChannel('chan_all');
    if (allChannel && agentParticipatesInChannels(agent)) {
      allChannel.agentIds = normalizeIds([...(allChannel.agentIds || []), agent.id]);
      allChannel.memberIds = normalizeIds([...(allChannel.memberIds || []), agent.id]);
      allChannel.updatedAt = now();
    }

    addCollabEvent('agent_created', `Agent created: ${agent.name}`, { agentId: agent.id });
    await persistState();
    broadcastState();
    sendJson(res, 201, { agent });
    return true;
  }

  if (req.method === 'POST' && url.pathname === '/api/agents/stop-all') {
    const body = await readJson(req);
    let scope = null;
    try {
      scope = stopScopeFromBody(body);
    } catch (error) {
      sendError(res, error.status || 400, error.message);
      return true;
    }
    const stoppedRuns = stopRunsForScope(scope);
    const stopped = stopAgentProcesses(scope);
    if (!scope) {
      // A global stop resets visible Agent status as well as the in-memory
      // process registry; scoped stops only touch work tied to that channel/DM.
      for (const agent of state.agents) setAgentStatus(agent, 'idle', 'stop_all');
      clearAgentProcesses();
    }
    const label = scope?.label || 'all channels';
    addCollabEvent('agents_stopped', `Stop all agents requested in ${label}.`, {
      scope: scope ? { spaceType: scope.spaceType, spaceId: scope.spaceId } : null,
      stoppedRuns,
      stoppedAgents: stopped.stoppedAgents,
      stoppedWorkItems: stopped.stoppedWorkItems,
    });
    await persistState();
    broadcastState();
    sendJson(res, 200, {
      ok: true,
      scope,
      stoppedRuns,
      stoppedAgents: stopped.stoppedAgents,
      stoppedWorkItems: stopped.stoppedWorkItems,
    });
    return true;
  }

  const agentStartMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/start$/);
  if (req.method === 'POST' && agentStartMatch) {
    const agent = findAgent(agentStartMatch[1]);
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    if (!hasAgentProcess(agent.id)) {
      await startAgentFromControl(agent);
      addCollabEvent('agent_start_requested', `Agent start requested: ${agent.name}`, { agentId: agent.id });
      await persistState();
      broadcastState();
    }
    sendJson(res, 202, { agent, running: true });
    return true;
  }

  const agentWarmMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/warm$/);
  if (req.method === 'POST' && agentWarmMatch) {
    const agent = findAgent(agentWarmMatch[1]);
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    const body = await readJson(req);
    const result = await warmAgentFromControl(agent, {
      spaceType: body.spaceType,
      spaceId: body.spaceId,
    });
    addCollabEvent('agent_warmup_requested', `Agent warmup requested: ${agent.name}`, { agentId: agent.id });
    await persistState();
    broadcastState();
    sendJson(res, 202, { agent, ...result });
    return true;
  }

  const agentRestartMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/restart$/);
  if (req.method === 'POST' && agentRestartMatch) {
    const agent = findAgent(agentRestartMatch[1]);
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    const body = await readJson(req);
    const result = await restartAgentFromControl(agent, String(body.mode || 'restart'));
    sendJson(res, 202, { agent, ...result });
    return true;
  }

  const agentWorkspaceMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/workspace$/);
  if (req.method === 'GET' && agentWorkspaceMatch) {
    const agent = findAgent(agentWorkspaceMatch[1]);
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    try {
      const tree = await listAgentWorkspace(agent, url.searchParams.get('path') || '');
      sendJson(res, 200, tree);
    } catch (error) {
      sendError(res, error.status || 500, error.message);
    }
    return true;
  }

  const agentSkillsMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/skills$/);
  if (req.method === 'GET' && agentSkillsMatch) {
    const agent = findAgent(agentSkillsMatch[1]);
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    try {
      sendJson(res, 200, await listAgentSkills(agent));
    } catch (error) {
      sendError(res, error.status || 500, error.message);
    }
    return true;
  }

  const agentWorkspaceFileMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/workspace\/file$/);
  if (req.method === 'GET' && agentWorkspaceFileMatch) {
    const agent = findAgent(agentWorkspaceFileMatch[1]);
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    try {
      const file = await readAgentWorkspaceFile(agent, url.searchParams.get('path') || 'MEMORY.md');
      sendJson(res, 200, file);
    } catch (error) {
      sendError(res, error.status || 500, error.message);
    }
    return true;
  }

  const agentMatch = url.pathname.match(/^\/api\/agents\/([^/]+)$/);
  if (['PATCH', 'POST'].includes(req.method) && agentMatch) {
    const agent = findAgent(agentMatch[1]);
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    const body = await readJson(req);
    for (const key of ['name', 'description', 'runtime', 'model', 'computerId', 'workspace', 'reasoningEffort', 'avatar']) {
      if (body[key] !== undefined) agent[key] = String(body[key] || '').trim();
    }
    if (body.status !== undefined) setAgentStatus(agent, String(body.status || '').trim() || 'idle', 'agent_patch', { forceEvent: true });
    if (body.model !== undefined) agent.model = normalizeCodexModelName(body.model, state.settings?.model);
    if (body.reasoningEffort === null) agent.reasoningEffort = null;
    if (Array.isArray(body.envVars)) agent.envVars = body.envVars;
    addCollabEvent('agent_updated', `Agent updated: ${agent.name}`, { agentId: agent.id });
    await persistState();
    broadcastState();
    sendJson(res, 200, { agent });
    return true;
  }

  if (req.method === 'DELETE' && agentMatch) {
    const agentId = agentMatch[1];
    const agent = findAgent(agentId);
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }

    state.agents = state.agents.filter((item) => item.id !== agentId);
    for (const channel of state.channels) {
      // Keep the old agentIds field and the newer memberIds field synchronized
      // until all callers have moved to canonical memberIds.
      channel.agentIds = Array.isArray(channel.agentIds) ? channel.agentIds.filter((id) => id !== agentId) : [];
      channel.memberIds = Array.isArray(channel.memberIds) ? channel.memberIds.filter((id) => id !== agentId) : [];
    }
    addCollabEvent('agent_deleted', `Agent deleted: ${agent.name}`, { agentId });
    await persistState();
    broadcastState();
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}
