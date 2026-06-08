import path from 'node:path';
import { roleAllows } from '../cloud/roles.js';
import { findWorkspaceAllChannel } from '../workspace-defaults.js';

// Agent control API routes.
// These endpoints mutate Agent records or control local Agent processes. The
// actual runtime/session helpers remain injected so this module stays focused
// on HTTP validation, state updates, and preserving legacy membership fields.

function normalizeAgentName(value, fallback = '') {
  return String(value || fallback || '').trim().slice(0, 80);
}

function agentNameUniqueKey(value) {
  return normalizeAgentName(value).replace(/\s+/g, '');
}

const RESERVED_AGENT_NAME_KEYS = new Set([
  'all',
  'agent',
  'agents',
  'assistant',
  'bot',
  'channel',
  'channels',
  'computer',
  'computers',
  'console',
  'directmessages',
  'dm',
  'dms',
  'magclaw',
  'me',
  'member',
  'members',
  'server',
  'settings',
  'system',
  'task',
  'tasks',
  'you',
]);

const AGENT_PROFILE_PATCH_KEYS = [
  'name',
  'description',
  'runtime',
  'runtimeId',
  'model',
  'computerId',
  'workspace',
  'reasoningEffort',
  'avatar',
  'envVars',
];

function reservedAgentNameMessage(name) {
  const key = agentNameUniqueKey(name).toLowerCase();
  if (!key || !RESERVED_AGENT_NAME_KEYS.has(key)) return '';
  return 'Agent name is reserved. Choose a more specific name.';
}

function agentPatchRequiresStateResync(body = {}) {
  return AGENT_PROFILE_PATCH_KEYS.some((key) => body[key] !== undefined);
}

function agentWorkspaceKey(agent = {}, fallback = 'local') {
  return String(agent.workspaceId || fallback || 'local').trim() || 'local';
}

function findAgentNameConflict(state, workspaceId, name, excludeAgentId = '') {
  const key = agentNameUniqueKey(name);
  if (!key) return null;
  const workspaceKey = String(workspaceId || 'local').trim() || 'local';
  return (state.agents || []).find((agent) => (
    agent
    && agent.id !== excludeAgentId
    && agentWorkspaceKey(agent, workspaceKey) === workspaceKey
    && agentNameUniqueKey(agent.name) === key
  )) || null;
}

function workspaceForId(state, workspaceId) {
  const cleanWorkspaceId = String(workspaceId || '').trim();
  if (!cleanWorkspaceId) return null;
  return (state.cloud?.workspaces || []).find((workspace) => workspace.id === cleanWorkspaceId) || null;
}

function hasExistingWorkspaceAgent(state, workspaceId) {
  const cleanWorkspaceId = String(workspaceId || '').trim();
  if (!cleanWorkspaceId || cleanWorkspaceId === 'local') {
    return (state.agents || []).some((agent) => agentWorkspaceKey(agent, 'local') === 'local');
  }
  return (state.agents || []).some((agent) => String(agent?.workspaceId || '').trim() === cleanWorkspaceId);
}

function makeUniqueAgentId(makeId, state) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = makeId('agt');
    if (!(state.agents || []).some((agent) => agent?.id === id)) return id;
  }
  throw new Error('Could not allocate a unique Agent ID.');
}

export async function handleAgentApi(req, res, url, deps) {
  const {
    addCollabEvent,
    agentParticipatesInChannels,
    broadcastState,
    clearAgentProcesses,
    currentActor,
    ensureAgentWorkspace,
    findAgent,
    findChannel,
    findComputer,
    getState,
    hasAgentProcess,
    listAgentActivity,
    listAgentMemoryMirrorWorkspace,
    listAgentSkills,
    listAgentWorkspace,
    makeId,
    normalizeCodexModelName,
    normalizeIds,
    now,
    persistState,
    readAgentMemoryMirrorFile,
    readAgentWorkspaceFile,
    readJson,
    requestAgentWorkspaceFile,
    requestAgentWorkspaceList,
    requestAgentSkills,
    restartAgentFromControl,
    root,
    scheduleNewAgentGreeting,
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

  function isLoginRequired() {
    return process.env.MAGCLAW_DEPLOYMENT === 'cloud' || Boolean(state.cloud?.users?.length);
  }

  function requireAgentCapability(allowedRoles = ['admin']) {
    if (!isLoginRequired()) return true;
    const actor = typeof currentActor === 'function' ? currentActor(req) : null;
    if (!actor) {
      sendError(res, 401, 'Login is required.');
      return false;
    }
    if (!roleAllows(actor.member?.role, allowedRoles)) {
      sendError(res, 403, 'Workspace role is not allowed.');
      return false;
    }
    return true;
  }

  function requireAgentWorkspaceRead(agent) {
    if (!isLoginRequired()) return true;
    const actor = typeof currentActor === 'function' ? currentActor(req) : null;
    if (!actor) {
      sendError(res, 401, 'Login is required.');
      return false;
    }
    const actorWorkspaceId = String(actor.member?.workspaceId || '').trim();
    const agentWorkspaceId = agentWorkspaceKey(
      agent,
      actorWorkspaceId || state.connection?.workspaceId || state.cloud?.workspace?.id || 'local',
    );
    if (actorWorkspaceId && agentWorkspaceId && actorWorkspaceId !== agentWorkspaceId) {
      sendError(res, 404, 'Agent not found.');
      return false;
    }
    return true;
  }

  function agentUsesRemoteComputer(agent) {
    return Boolean(agent?.computerId && agent.computerId !== 'cmp_local');
  }

  function computerForAgent(agent) {
    if (!agentUsesRemoteComputer(agent)) return null;
    if (typeof findComputer === 'function') return findComputer(agent.computerId) || null;
    return (state.computers || []).find((computer) => computer?.id === agent.computerId) || null;
  }

  function agentComputerIsOnline(agent) {
    if (!agentUsesRemoteComputer(agent)) return true;
    const computer = computerForAgent(agent);
    const computerStatus = String(computer?.status || '').toLowerCase();
    if (['connected', 'online', 'ready'].includes(computerStatus)) return true;
    const agentStatus = String(agent?.status || '').toLowerCase();
    if (['starting', 'thinking', 'working', 'running', 'busy', 'queued', 'warming', 'idle', 'standby'].includes(agentStatus)
      && ['connected', 'online', 'ready'].includes(computerStatus)) {
      return true;
    }
    return false;
  }

  async function listWorkspaceForAgent(agent, relPath) {
    let daemonError = null;
    if (agentUsesRemoteComputer(agent) && agentComputerIsOnline(agent) && typeof requestAgentWorkspaceList === 'function') {
      try {
        return await requestAgentWorkspaceList(agent, relPath);
      } catch (error) {
        daemonError = error;
        console.warn('[agents] daemon workspace list failed; falling back when possible', {
          agentId: agent.id,
          computerId: agent.computerId,
          error: error.message,
        });
      }
    }
    if (agentUsesRemoteComputer(agent)) {
      if (typeof listAgentMemoryMirrorWorkspace === 'function') {
        const tree = await listAgentMemoryMirrorWorkspace(agent, relPath);
        return {
          ...tree,
          stale: Boolean(daemonError),
          refreshError: daemonError?.message || '',
        };
      }
      throw Object.assign(new Error(daemonError ? 'Mirror stale/error.' : 'Computer offline / file unavailable.'), { status: 409 });
    }
    const tree = await listAgentWorkspace(agent, relPath);
    return {
      ...tree,
      source: tree.source || 'computer_local',
      agent: {
        ...(tree.agent || {}),
        source: tree.agent?.source || 'computer_local',
      },
    };
  }

  async function readWorkspaceFileForAgent(agent, relPath) {
    const cleanPath = String(relPath || 'MEMORY.md').trim() || 'MEMORY.md';
    let daemonError = null;
    if (agentUsesRemoteComputer(agent) && agentComputerIsOnline(agent) && typeof requestAgentWorkspaceFile === 'function') {
      try {
        return await requestAgentWorkspaceFile(agent, cleanPath);
      } catch (error) {
        daemonError = error;
        console.warn('[agents] daemon workspace file read failed; falling back when possible', {
          agentId: agent.id,
          computerId: agent.computerId,
          path: cleanPath,
          error: error.message,
        });
      }
    }
    if (agentUsesRemoteComputer(agent)) {
      if (cleanPath === 'MEMORY.md' && typeof readAgentMemoryMirrorFile === 'function') {
        const file = await readAgentMemoryMirrorFile(agent);
        return {
          ...file,
          file: {
            ...(file.file || {}),
            stale: Boolean(daemonError),
            refreshError: daemonError?.message || '',
          },
        };
      }
      throw Object.assign(new Error(daemonError ? 'Mirror stale/error.' : 'Computer offline / file unavailable.'), { status: 409 });
    }
    const file = await readAgentWorkspaceFile(agent, cleanPath);
    return {
      ...file,
      file: {
        ...(file.file || {}),
        source: file.file?.source || 'computer_local',
      },
    };
  }

  async function autoStartCreatedAgent(agent) {
    if (hasAgentProcess(agent.id)) return null;
    try {
      const result = await startAgentFromControl(agent);
      if (result?.queued === false) {
        console.warn('[agents] auto-start did not queue', {
          agentId: agent.id,
          computerId: agent.computerId,
          error: result.error || '',
        });
        addCollabEvent('agent_start_failed', `Agent auto-start could not be queued: ${agent.name}`, {
          agentId: agent.id,
          computerId: agent.computerId,
          error: result.error || '',
        });
      } else {
        addCollabEvent('agent_start_requested', `Agent start requested: ${agent.name}`, {
          agentId: agent.id,
          reason: 'create',
        });
      }
      return result || null;
    } catch (error) {
      console.error('[agents] auto-start failed', {
        agentId: agent.id,
        computerId: agent.computerId,
        error,
      });
      addCollabEvent('agent_start_failed', `Agent auto-start failed: ${agent.name}`, {
        agentId: agent.id,
        computerId: agent.computerId,
        error: error.message,
      });
      return { queued: false, error: error.message };
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/agents') {
    const body = await readJson(req);
    const actor = typeof currentActor === 'function' ? currentActor(req) : null;
    const workspaceId = String(actor?.member?.workspaceId || body.workspaceId || state.connection?.workspaceId || state.cloud?.workspace?.id || '').trim();
    const name = normalizeAgentName(body.name, 'New Agent');
    if (!name) {
      sendError(res, 400, 'Agent name is required.');
      return true;
    }
    const reservedMessage = reservedAgentNameMessage(name);
    if (reservedMessage) {
      sendError(res, 400, reservedMessage);
      return true;
    }
    const conflict = findAgentNameConflict(state, workspaceId || 'local', name);
    if (conflict) {
      sendError(res, 409, 'Agent name already exists in this server.');
      return true;
    }
    let agentId = '';
    try {
      agentId = makeUniqueAgentId(makeId, state);
    } catch (error) {
      console.error('[agents] failed to allocate Agent ID', error);
      sendError(res, 500, error.message);
      return true;
    }
    const isFirstWorkspaceAgent = Boolean(workspaceId && !hasExistingWorkspaceAgent(state, workspaceId));
    const agent = {
      id: agentId,
      ...(workspaceId ? { workspaceId } : {}),
      name,
      description: String(body.description || '').trim(),
      runtime: String(body.runtime || 'Codex CLI'),
      runtimeId: body.runtimeId ? String(body.runtimeId) : '',
      model: normalizeCodexModelName(body.model, state.settings?.model),
      status: 'idle',
      computerId: String(body.computerId || 'cmp_local'),
      workspace: path.resolve(String(body.workspace || state.settings.defaultWorkspace || root)),
      reasoningEffort: body.reasoningEffort ? String(body.reasoningEffort) : null,
      envVars: Array.isArray(body.envVars) ? body.envVars : null,
      avatar: body.avatar ? String(body.avatar) : null,
      createdByUserId: actor?.user?.id || '',
      createdByHumanId: actor?.member?.humanId || '',
      creatorName: actor?.user?.name || '',
      creatorEmail: actor?.user?.email || '',
      statusUpdatedAt: now(),
      heartbeatAt: now(),
      createdAt: now(),
    };
    state.agents.push(agent);

    // Seed the workspace before broadcasting so the UI can open the workspace
    // tab immediately after Agent creation without a second initialization pass.
    await ensureAgentWorkspace(agent);

    const allChannel = findWorkspaceAllChannel(state, workspaceId) || findChannel('chan_all');
    if (allChannel && agentParticipatesInChannels(agent)) {
      allChannel.agentIds = normalizeIds([...(allChannel.agentIds || []), agent.id]);
      allChannel.memberIds = normalizeIds([...(allChannel.memberIds || []), agent.id]);
      allChannel.updatedAt = now();
    }
    const workspace = workspaceForId(state, workspaceId);
    const becameDefaultOnboardingAssistant = Boolean(isFirstWorkspaceAgent && workspace && !workspace.onboardingAgentId);
    if (becameDefaultOnboardingAssistant) {
      workspace.onboardingAgentId = agent.id;
      workspace.updatedAt = now();
      addCollabEvent('onboarding_agent_assigned', `Default onboarding Agent assigned: ${agent.name}`, {
        agentId: agent.id,
        workspaceId,
        reason: 'first_agent_created',
      });
    }

    addCollabEvent('agent_created', `Agent created: ${agent.name}`, { agentId: agent.id });
    await autoStartCreatedAgent(agent);
    await persistState();
    if (typeof scheduleNewAgentGreeting === 'function') {
      scheduleNewAgentGreeting(agent, {
        workspaceId,
        user: actor?.user || null,
        trigger: 'agent_created',
        isDefaultOnboardingAssistant: becameDefaultOnboardingAssistant,
      });
    }
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
    if (agent.deletedAt || agent.archivedAt || String(agent.status || '').toLowerCase() === 'disabled') {
      sendError(res, 409, 'Agent is disabled or deleted.');
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
    if (agent.deletedAt || agent.archivedAt || String(agent.status || '').toLowerCase() === 'disabled') {
      sendError(res, 409, 'Agent is disabled or deleted.');
      return true;
    }
    const body = await readJson(req);
    setAgentStatus(agent, 'starting', 'agent_restart_requested', { forceEvent: true });
    broadcastState({ realtimeOnly: true });
    const result = await restartAgentFromControl(agent, String(body.mode || 'restart'));
    sendJson(res, 202, { agent, ...result });
    return true;
  }

  const agentRestoreMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/restore$/);
  if (req.method === 'POST' && agentRestoreMatch) {
    const agent = findAgent(agentRestoreMatch[1]);
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    const restoredAt = now();
    agent.deletedAt = null;
    agent.archivedAt = null;
    agent.status = 'idle';
    agent.statusUpdatedAt = restoredAt;
    agent.updatedAt = restoredAt;
    const allChannel = findWorkspaceAllChannel(state, agent.workspaceId || state.connection?.workspaceId || state.cloud?.workspace?.id || 'local')
      || findChannel('chan_all');
    if (allChannel && agentParticipatesInChannels(agent)) {
      allChannel.agentIds = normalizeIds([...(allChannel.agentIds || []), agent.id]);
      allChannel.memberIds = normalizeIds([...(allChannel.memberIds || []), agent.id]);
      allChannel.updatedAt = restoredAt;
    }
    addCollabEvent('agent_restored', `Agent restored from Lost Space: ${agent.name}`, { agentId: agent.id });
    await persistState();
    broadcastState();
    sendJson(res, 200, { ok: true, agent });
    return true;
  }

  const agentWorkspaceMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/workspace$/);
  if (req.method === 'GET' && agentWorkspaceMatch) {
    const agent = findAgent(agentWorkspaceMatch[1]);
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    if (!requireAgentWorkspaceRead(agent)) return true;
    try {
      const tree = await listWorkspaceForAgent(agent, url.searchParams.get('path') || '');
      sendJson(res, 200, tree);
    } catch (error) {
      sendError(res, error.status || 500, error.message);
    }
    return true;
  }

  const agentActivityMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/activity$/);
  if (req.method === 'GET' && agentActivityMatch) {
    if (!requireAgentCapability(['admin'])) return true;
    const agent = findAgent(agentActivityMatch[1]);
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    if (typeof listAgentActivity !== 'function') {
      sendError(res, 501, 'Agent activity is not available.');
      return true;
    }
    try {
      sendJson(res, 200, await listAgentActivity(agent.id, {
        days: url.searchParams.get('days') || '',
        limit: url.searchParams.get('limit') || '',
        before: url.searchParams.get('before') || '',
      }));
    } catch (error) {
      sendError(res, error.status || 500, error.message);
    }
    return true;
  }

  const agentSkillsMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/skills$/);
  if (req.method === 'GET' && agentSkillsMatch) {
    if (!requireAgentCapability(['admin'])) return true;
    const agent = findAgent(agentSkillsMatch[1]);
    if (!agent) {
      sendError(res, 404, 'Agent not found.');
      return true;
    }
    try {
      if (typeof requestAgentSkills === 'function' && agent.computerId && agent.computerId !== 'cmp_local') {
        try {
          sendJson(res, 200, await requestAgentSkills(agent));
          return true;
        } catch (error) {
          if (agent.skillSnapshot) {
            sendJson(res, 200, {
              ...agent.skillSnapshot,
              stale: true,
              refreshError: error.message,
            });
            return true;
          }
        }
      }
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
    if (!requireAgentWorkspaceRead(agent)) return true;
    try {
      const file = await readWorkspaceFileForAgent(agent, url.searchParams.get('path') || 'MEMORY.md');
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
    const statusOnlyPatch = body.status !== undefined && !agentPatchRequiresStateResync(body);
    if (body.name !== undefined) {
      const name = normalizeAgentName(body.name);
      if (!name) {
        sendError(res, 400, 'Agent name is required.');
        return true;
      }
      const reservedMessage = reservedAgentNameMessage(name);
      if (reservedMessage) {
        sendError(res, 400, reservedMessage);
        return true;
      }
      const workspaceId = agent.workspaceId || state.connection?.workspaceId || state.cloud?.workspace?.id || 'local';
      const conflict = findAgentNameConflict(state, workspaceId, name, agent.id);
      if (conflict) {
        sendError(res, 409, 'Agent name already exists in this server.');
        return true;
      }
      agent.name = name;
    }
    for (const key of ['description', 'runtime', 'runtimeId', 'model', 'computerId', 'workspace', 'reasoningEffort', 'avatar']) {
      if (body[key] !== undefined) agent[key] = String(body[key] || '').trim();
    }
    if (body.status !== undefined) setAgentStatus(agent, String(body.status || '').trim() || 'idle', 'agent_patch', { forceEvent: true });
    if (body.model !== undefined) agent.model = normalizeCodexModelName(body.model, state.settings?.model);
    if (body.reasoningEffort === null) agent.reasoningEffort = null;
    if (Array.isArray(body.envVars)) agent.envVars = body.envVars;
    agent.updatedAt = now();
    addCollabEvent('agent_updated', `Agent updated: ${agent.name}`, { agentId: agent.id });
    await persistState();
    broadcastState(statusOnlyPatch ? { realtimeOnly: true } : {});
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

    const deletedAt = now();
    agent.deletedAt = deletedAt;
    agent.status = 'deleted';
    agent.statusUpdatedAt = deletedAt;
    agent.updatedAt = deletedAt;
    for (const channel of state.channels) {
      // Keep the old agentIds field and the newer memberIds field synchronized
      // until all callers have moved to canonical memberIds.
      channel.agentIds = Array.isArray(channel.agentIds) ? channel.agentIds.filter((id) => id !== agentId) : [];
      channel.memberIds = Array.isArray(channel.memberIds) ? channel.memberIds.filter((id) => id !== agentId) : [];
    }
    addCollabEvent('agent_deleted', `Agent moved to Lost Space: ${agent.name}`, { agentId });
    await persistState();
    broadcastState();
    sendJson(res, 200, { ok: true, agent });
    return true;
  }

  return false;
}
