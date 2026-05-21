import { ensureWorkspaceAllChannel, findWorkspaceAllChannel } from './workspace-defaults.js';

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactText(value, limit = 260) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function languageLabel(language) {
  return language === 'zh-CN' ? 'Chinese (zh-CN)' : 'English (en)';
}

const RECENT_LANGUAGE_CONTEXT_LIMIT = 40;
const CHINESE_CHAR_RE = /[\u3400-\u9fff\uf900-\ufaff]/g;
const LATIN_WORD_RE = /[A-Za-z][A-Za-z'-]*/g;

function countPattern(value, pattern) {
  return String(value || '').match(pattern)?.length || 0;
}

function classifyTextLanguage(value) {
  const text = String(value || '').replace(/<@[^>]+>/g, ' ');
  const chineseChars = countPattern(text, CHINESE_CHAR_RE);
  const latinWords = countPattern(text, LATIN_WORD_RE);
  if (chineseChars >= 2 && chineseChars >= latinWords) return 'zh-CN';
  if (latinWords >= 3 && chineseChars === 0) return 'en';
  return '';
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

  function recentAllChannelLanguage(channel, workspaceId) {
    if (!channel?.id) return '';
    const counts = { 'zh-CN': 0, en: 0 };
    const records = safeArray(state().messages)
      .filter((message) => message.spaceType === 'channel' && message.spaceId === channel.id)
      .filter((message) => !workspaceId || !message.workspaceId || message.workspaceId === workspaceId)
      .filter((message) => message.authorType !== 'system')
      .sort((a, b) => Date.parse(a.createdAt || '') - Date.parse(b.createdAt || ''))
      .slice(-RECENT_LANGUAGE_CONTEXT_LIMIT);
    for (const record of records) {
      const language = classifyTextLanguage(record.body);
      if (language) counts[language] += 1;
    }
    const classified = counts['zh-CN'] + counts.en;
    if (classified < 2) return '';
    if (counts['zh-CN'] >= 2 && counts['zh-CN'] >= counts.en) return 'zh-CN';
    if (counts.en >= 2 && counts.en > counts['zh-CN']) return 'en';
    return '';
  }

  function contextLanguageInstruction(channel, workspaceId, subject = 'greeting') {
    const language = recentAllChannelLanguage(channel, workspaceId);
    if (language) {
      return `Recent #all language context: ${languageLabel(language)}. Use this language for the visible ${subject}. Do not ask language preference or use the user's system/account language as the deciding signal.`;
    }
    return `No clear recent #all language context is available. Infer the visible ${subject} language from the current server/channel context and your own role; keep it natural and brief. Do not ask language preference or use the user's system/account language as the deciding signal.`;
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

  function internalOnboardingTaskMessage(spaceType, spaceId, body, extra = {}) {
    const metadata = {
      ...(extra.metadata || {}),
      visibility: 'internal',
      hiddenFromChannel: true,
    };
    return {
      id: makeId('msg'),
      spaceType,
      spaceId,
      authorType: 'system',
      authorId: 'system',
      body,
      attachmentIds: [],
      replyCount: 0,
      savedBy: [],
      readBy: [],
      createdAt: now(),
      updatedAt: now(),
      ...extra,
      metadata,
      internal: true,
      hiddenFromChannel: true,
      mentionedAgentIds: normalizeIds(extra.mentionedAgentIds || []),
      mentionedHumanIds: normalizeIds(extra.mentionedHumanIds || []),
    };
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
    const languageInstruction = contextLanguageInstruction(channel, workspaceId, 'human welcome');
    const body = [
      `Onboarding task (system-triggered): This is a new human member onboarding. Please proactively onboard ${humanMention} in #all.`,
      languageInstruction,
      'Generate the visible greeting yourself from your onboarding role, Agent profile, MEMORY.md/notes, and recent server context. Do not copy this system task text.',
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

  function scheduleNewAgentGreeting(agent, {
    workspaceId = '',
    trigger = 'agent_created',
    isDefaultOnboardingAssistant = false,
  } = {}) {
    const cleanWorkspaceId = String(workspaceId || agent?.workspaceId || state().connection?.workspaceId || 'local').trim() || 'local';
    const settings = workspaceSettings(cleanWorkspaceId);
    if (settings.newAgentGreetingEnabled === false) return null;
    if (!agentCanReceiveOnboarding(agent) || !agentBelongsToWorkspace(agent, cleanWorkspaceId)) return null;
    const channel = allChannelForWorkspace(cleanWorkspaceId, { agentIds: [agent.id] });
    if (!channel) return null;
    const agentMention = `<@${agent.id}>`;
    const description = compactText(agent.description || 'No description provided yet.');
    const runtime = compactText(agent.runtime || agent.runtimeId || 'Agent');
    const languageInstruction = contextLanguageInstruction(channel, cleanWorkspaceId, 'greeting');
    const body = [
      `Onboarding task (system-triggered): This is a new Agent greeting. ${agentMention} was just created in this server.`,
      'Please post a short self-introduction in #all using your own words.',
      isDefaultOnboardingAssistant
        ? 'This is the first Agent in this server and it is now the default human onboarding assistant. In the visible greeting, introduce yourself and welcome the humans in #all.'
        : '',
      'Generate the visible greeting yourself from your configured name, description, runtime, MEMORY.md/notes, and current work focus if helpful. Keep it brief and useful for humans deciding how to collaborate with you.',
      languageInstruction,
      'Do NOT ask anyone to configure the server.',
      `Agent description: ${description}`,
      `Runtime: ${runtime}`,
    ].filter(Boolean).join(' ');
    const message = internalOnboardingTaskMessage('channel', channel.id, body, {
      workspaceId: cleanWorkspaceId,
      eventType: 'agent_onboarding_greeting_task',
      mentionedAgentIds: [agent.id],
      metadata: {
        onboarding: {
          type: 'agent',
          trigger,
          targetAgentId: agent.id,
          isDefaultOnboardingAssistant,
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
