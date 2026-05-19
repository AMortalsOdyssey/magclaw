import { ensureWorkspaceAllChannel, findWorkspaceAllChannel } from './workspace-defaults.js';

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactText(value, limit = 260) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function workspaceIdForRecord(record, fallback = 'local') {
  return String(record?.workspaceId || record?.id || fallback || 'local').trim() || 'local';
}

function workspaceForId(state, workspaceId) {
  const cleanId = String(workspaceId || '').trim();
  return safeArray(state.cloud?.workspaces).find((workspace) => workspace.id === cleanId) || null;
}

function agentCanReceiveOnboarding(agent) {
  if (!agent || agent.deletedAt || agent.archivedAt) return false;
  const status = String(agent.status || '').toLowerCase();
  if (status === 'deleted' || status === 'disabled') return false;
  return true;
}

function agentBelongsToWorkspace(agent, workspaceId) {
  const target = String(workspaceId || 'local').trim() || 'local';
  const agentWorkspaceId = String(agent?.workspaceId || (target === 'local' ? 'local' : '')).trim();
  return agentWorkspaceId === target;
}

export function createOnboardingManager(deps) {
  const {
    addSystemEvent,
    addSystemMessage,
    broadcastState,
    deliverMessageToAgent,
    findAgent,
    getState,
    makeId,
    normalizeIds,
    now,
    persistState,
  } = deps;

  function state() {
    return getState?.() || {};
  }

  function allChannelForWorkspace(workspaceId, seeds = {}) {
    const current = state();
    const workspace = workspaceForId(current, workspaceId);
    return findWorkspaceAllChannel(current, workspaceId)
      || ensureWorkspaceAllChannel({
        state: current,
        workspaceId,
        workspace,
        humanIds: seeds.humanIds || [],
        agentIds: seeds.agentIds || [],
        makeId,
        now,
        normalizeIds,
      }).channel;
  }

  function workspaceSettings(workspaceId) {
    const current = state();
    return workspaceForId(current, workspaceId) || current.cloud?.workspace || {};
  }

  function enqueueOnboardingDelivery({ agent, channel, message, reason }) {
    if (!agent || !channel || !message) return;
    Promise.resolve()
      .then(() => persistState?.({ workspaceId: message.workspaceId || channel.workspaceId || '', reason }))
      .then(() => deliverMessageToAgent?.(agent, 'channel', channel.id, message, { suppressTaskContext: true }))
      .catch((error) => {
        addSystemEvent?.('onboarding_delivery_error', `Onboarding delivery failed for ${agent.name || agent.id}: ${error.message}`, {
          agentId: agent.id,
          messageId: message.id,
          workspaceId: message.workspaceId || channel.workspaceId || '',
        });
        persistState?.({ workspaceId: message.workspaceId || channel.workspaceId || '', reason: 'onboarding_delivery_error' }).catch(() => {});
        broadcastState?.();
      });
  }

  function scheduleHumanOnboarding({ human, member = null, workspace = null, trigger = 'member_joined' } = {}) {
    const workspaceId = workspaceIdForRecord(workspace, member?.workspaceId || human?.workspaceId || state().connection?.workspaceId || 'local');
    const settings = workspace || workspaceSettings(workspaceId);
    const onboardingAgentId = String(settings.onboardingAgentId || '').trim();
    if (!onboardingAgentId) return null;
    const agent = findAgent?.(onboardingAgentId);
    if (!agentCanReceiveOnboarding(agent) || !agentBelongsToWorkspace(agent, workspaceId)) {
      addSystemEvent?.('onboarding_agent_unavailable', 'Human onboarding skipped because the configured Agent is unavailable.', {
        agentId: onboardingAgentId || null,
        humanId: human?.id || null,
        workspaceId,
        trigger,
      });
      return null;
    }
    const channel = allChannelForWorkspace(workspaceId, {
      humanIds: [human?.id].filter(Boolean),
      agentIds: [agent.id],
    });
    if (!channel) return null;
    const humanMention = human?.id ? `<@${human.id}>` : `@${human?.name || 'new member'}`;
    const body = [
      `Onboarding task (system-triggered): This is a new human member onboarding. Please proactively onboard ${humanMention} in #all.`,
      'Default language is English; first ask what language they prefer: English or Chinese. Include a short Chinese option in the first question, for example: "你希望用英语还是中文完成入门引导？" If they choose Chinese or are already using Chinese, continue in Chinese.',
      'Goals (soft guidance, do not force): 1) Help them understand what Slock is and what this server is for. 2) Introduce relevant humans/channels/agents for their current work, not a full catalog dump. 3) Suggest where they should start collaborating right away.',
      'Do NOT ask them to set up the server or create agents/channels. If they are already working on a concrete task, keep onboarding lightweight and adapt to their flow.',
    ].join(' ');
    const message = addSystemMessage('channel', channel.id, body, {
      workspaceId,
      eventType: 'human_onboarding_task',
      mentionedAgentIds: [agent.id],
      mentionedHumanIds: human?.id ? [human.id] : [],
      metadata: {
        onboarding: {
          type: 'human',
          trigger,
          targetHumanId: human?.id || '',
          targetAgentId: agent.id,
        },
      },
    });
    addSystemEvent?.('human_onboarding_task_created', `Human onboarding queued for ${human?.name || human?.email || human?.id || 'new member'}.`, {
      agentId: agent.id,
      humanId: human?.id || null,
      messageId: message.id,
      channelId: channel.id,
      workspaceId,
      trigger,
    });
    enqueueOnboardingDelivery({ agent, channel, message, reason: 'human_onboarding_task_created' });
    broadcastState?.();
    return message;
  }

  function scheduleNewAgentGreeting(agent, { workspaceId = '', trigger = 'agent_created' } = {}) {
    const cleanWorkspaceId = String(workspaceId || agent?.workspaceId || state().connection?.workspaceId || 'local').trim() || 'local';
    const settings = workspaceSettings(cleanWorkspaceId);
    if (settings.newAgentGreetingEnabled === false) return null;
    if (!agentCanReceiveOnboarding(agent) || !agentBelongsToWorkspace(agent, cleanWorkspaceId)) return null;
    const channel = allChannelForWorkspace(cleanWorkspaceId, { agentIds: [agent.id] });
    if (!channel) return null;
    const agentMention = `<@${agent.id}>`;
    const description = compactText(agent.description || 'No description provided yet.');
    const runtime = compactText(agent.runtime || agent.runtimeId || 'Agent');
    const body = [
      `Onboarding task (system-triggered): This is a new Agent greeting. ${agentMention} was just created in this server.`,
      'Please post a short self-introduction in #all using your own words.',
      'Use your configured name, description, runtime, and current work focus if helpful. Keep it brief and useful for humans deciding how to collaborate with you.',
      'Language: default to English, but if the server context, your description, or recent conversation is Chinese, write in Chinese; a short bilingual greeting is also acceptable.',
      'Do NOT ask anyone to configure the server.',
      `Agent description: ${description}`,
      `Runtime: ${runtime}`,
    ].join(' ');
    const message = addSystemMessage('channel', channel.id, body, {
      workspaceId: cleanWorkspaceId,
      eventType: 'agent_onboarding_greeting_task',
      mentionedAgentIds: [agent.id],
      metadata: {
        onboarding: {
          type: 'agent',
          trigger,
          targetAgentId: agent.id,
        },
      },
    });
    addSystemEvent?.('agent_onboarding_greeting_task_created', `Agent greeting queued for ${agent.name || agent.id}.`, {
      agentId: agent.id,
      messageId: message.id,
      channelId: channel.id,
      workspaceId: cleanWorkspaceId,
      trigger,
    });
    enqueueOnboardingDelivery({ agent, channel, message, reason: 'agent_onboarding_greeting_task_created' });
    broadcastState?.();
    return message;
  }

  return {
    scheduleHumanOnboarding,
    scheduleNewAgentGreeting,
  };
}
