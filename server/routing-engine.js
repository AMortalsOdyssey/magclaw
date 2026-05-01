import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  agentCapabilityQuestionIntent,
  agentResponseIntent,
  autoTaskMessageIntent,
  availabilityBroadcastIntent,
  availabilityFollowupIntent,
  channelGreetingIntent,
  contextualAgentFollowupIntent,
  directAvailabilityIntent,
  inferTaskIntentKind,
} from './intents.js';
import { fanoutApiEndpoint, fanoutApiResponseText, parseFanoutApiJson } from './fanout-api.js';
import { escapeRegExp, normalizeIds } from './mentions.js';
import { safePathWithin, httpError } from './path-utils.js';
import { normalizeFanoutApiConfig } from './runtime-config.js';

// Fan-out routing and Agent-card dispatch.
// This is the first stop for investigating why a message reached an Agent:
// it owns deterministic routing, optional LLM fan-out calls, and compact
// Agent-card loading from each Agent workspace.
export function createRoutingEngine(deps) {
  const {
    addSystemEvent,
    agentAvailableForAutoWork,
    agentCardCache,
    agentDataDir,
    agentIdleForAvailability,
    agentParticipatesInChannels,
    findAgent,
    findChannel,
    findHuman,
    findTask,
    findTaskForThreadMessage,
    getState,
    isBrainAgent,
    makeId,
    now,
    renderMentionsForAgent,
    spaceDisplayName,
    taskIsClosed,
    taskLabel,
    visibleMentionLabel,
    AGENT_CARD_TEXT_LIMIT,
    BRAIN_AGENT_DESCRIPTION,
    BRAIN_AGENT_NAME,
    FANOUT_API_TIMEOUT_MS,
    LEGACY_BRAIN_AGENT_ID,
    ROUTE_EVENTS_LIMIT,
  } = deps;
  const state = new Proxy({}, {
    get(_target, prop) {
      return getState()[prop];
    },
    set(_target, prop, value) {
      getState()[prop] = value;
      return true;
    },
  });

  function fanoutApiConfigured(config = state?.settings?.fanoutApi) {
    const normalized = normalizeFanoutApiConfig(config || {});
    return normalized.enabled && normalized.baseUrl && normalized.apiKey && normalized.model;
  }

  function messageTimeMs(record) {
    const time = Date.parse(record?.createdAt || '');
    return Number.isFinite(time) ? time : 0;
  }
  
  const CONTEXTUAL_FOLLOWUP_WINDOW_MS = 30 * 60 * 1000;
  
  function latestRouteEventForMessage(messageId, spaceId) {
    return [...(state.routeEvents || [])]
      .reverse()
      .find((event) => event.messageId === messageId
        && event.spaceType === 'channel'
        && (!spaceId || event.spaceId === spaceId));
  }
  
  function recentChannelMessageEntries(message, spaceId, windowMs = CONTEXTUAL_FOLLOWUP_WINDOW_MS) {
    const records = state.messages || [];
    const currentIndex = records.findIndex((record) => record.id === message?.id);
    const currentMs = messageTimeMs(message) || Date.now();
    return records
      .map((record, index) => ({ record, index, ms: messageTimeMs(record) }))
      .filter((entry) => entry.record.id !== message?.id
        && entry.record.spaceType === 'channel'
        && entry.record.spaceId === spaceId
        && (currentIndex < 0 || entry.index < currentIndex)
        && (!entry.ms || !currentMs || currentMs - entry.ms <= windowMs))
      .sort((a, b) => b.ms - a.ms || b.index - a.index);
  }
  
  function focusedRecentAgentForHumanFollowup(channelAgents, message, spaceId) {
    if (message?.authorType !== 'human') return null;
    if (!contextualAgentFollowupIntent(message?.body)) return null;
  
    const channelAgentById = new Map((channelAgents || [])
      .filter(agentParticipatesInChannels)
      .map((agent) => [agent.id, agent]));
    if (!channelAgentById.size) return null;
  
    const recent = recentChannelMessageEntries(message, spaceId);
    const lastHuman = recent.find((entry) => entry.record.authorType === 'human');
    if (lastHuman) {
      const routeEvent = latestRouteEventForMessage(lastHuman.record.id, spaceId);
      const routedIds = normalizeIds(routeEvent?.targetAgentIds || [])
        .filter((id) => channelAgentById.has(id));
      if (routedIds.length === 1) {
        return {
          agent: channelAgentById.get(routedIds[0]),
          source: 'recent_directed_human_message',
          referenceMessageId: lastHuman.record.id,
          routeEventId: routeEvent?.id || null,
        };
      }
  
      const agentIdsAfterLastHuman = normalizeIds(recent
        .filter((entry) => entry.index > lastHuman.index
          && entry.record.authorType === 'agent'
          && channelAgentById.has(entry.record.authorId))
        .map((entry) => entry.record.authorId));
      if (agentIdsAfterLastHuman.length === 1) {
        return {
          agent: channelAgentById.get(agentIdsAfterLastHuman[0]),
          source: 'single_recent_agent_reply',
          referenceMessageId: recent.find((entry) => entry.record.authorId === agentIdsAfterLastHuman[0])?.record.id || null,
          routeEventId: null,
        };
      }
    }
  
    const latest = recent[0]?.record || null;
    if (!lastHuman && latest?.authorType === 'agent' && channelAgentById.has(latest.authorId)) {
      return {
        agent: channelAgentById.get(latest.authorId),
        source: 'latest_agent_message',
        referenceMessageId: latest.id,
        routeEventId: null,
      };
    }
    return null;
  }
  
  function availabilityTargetAgentIds(channelAgents, record) {
    if (!record || record.authorType !== 'human') return [];
    if (!directAvailabilityIntent(record.body) && !availabilityBroadcastIntent(record.body)) return [];
    const channelIds = new Set((channelAgents || []).map((agent) => agent.id));
    const namedIds = (channelAgents || [])
      .filter((agent) => textAddressesAgent(agent, record.body))
      .map((agent) => agent.id);
    return normalizeIds([...(record.mentionedAgentIds || []), ...namedIds])
      .filter((id) => channelIds.has(id));
  }
  
  function recentAvailabilityContextAgentIds(channelAgents, message, spaceId) {
    const currentMs = messageTimeMs(message) || Date.now();
    const contextWindowMs = 30 * 60 * 1000;
    return [...(state.messages || [])]
      .filter((record) => record.id !== message?.id
        && record.spaceType === 'channel'
        && record.spaceId === spaceId
        && record.authorType === 'human')
      .sort((a, b) => messageTimeMs(b) - messageTimeMs(a))
      .map((record) => {
        const recordMs = messageTimeMs(record);
        if (recordMs && currentMs && currentMs - recordMs > contextWindowMs) return [];
        return availabilityTargetAgentIds(channelAgents, record);
      })
      .find((ids) => ids.length)
      || [];
  }
  
  function availabilityFollowupAgents(channelAgents, message, spaceId) {
    if (!availabilityFollowupIntent(message?.body)) return [];
    const previouslyAskedIds = new Set(recentAvailabilityContextAgentIds(channelAgents, message, spaceId));
    if (!previouslyAskedIds.size) return [];
    return uniqueAgents((channelAgents || [])
      .filter(agentIdleForAvailability)
      .filter((agent) => !previouslyAskedIds.has(agent.id)));
  }
  
  function dispatchSearchTerms(text) {
    const value = String(text || '')
      .toLowerCase()
      .replace(/<[@!#][^>]+>/g, ' ');
    const stopwords = new Set([
      'the', 'and', 'for', 'you', 'can', 'help', 'please', 'with', 'this', 'that',
      '知道', '帮忙', '帮我', '一下', '大家', '今天', '有空', '谁去', '谁能',
    ]);
    return value
      .split(/[^a-z0-9_.\-\u4e00-\u9fa5]+/i)
      .map((term) => term.trim())
      .filter((term) => term.length >= 2 && !stopwords.has(term))
      .slice(0, 24);
  }
  
  function agentDispatchHaystack(agent) {
    const personality = agent?.personality || {};
    const memory = agent?.memory || {};
    return [
      agent?.name,
      agent?.displayName,
      agent?.description,
      agent?.runtime,
      ...(Array.isArray(personality.interests) ? personality.interests : []),
      ...(Array.isArray(personality.traits) ? personality.traits : []),
      ...(Array.isArray(memory.knownTopics) ? memory.knownTopics : []),
    ].filter(Boolean).join(' ').toLowerCase();
  }
  
  function agentDispatchScore(agent, text) {
    if (!agentAvailableForAutoWork(agent)) return -Infinity;
    let score = 0;
    if (textAddressesAgent(agent, text)) score += 100;
    const haystack = agentDispatchHaystack(agent);
    for (const term of dispatchSearchTerms(text)) {
      if (haystack.includes(term)) score += Math.min(24, term.length * 3);
    }
    if (agentIdleForAvailability(agent)) score += 4;
    if (String(agent.status || '').toLowerCase() === 'working') score -= 2;
    if (agent.id === 'agt_codex') score += 0.1;
    return score;
  }
  
  function pickAvailableAgent(channelAgents, preferredIds = []) {
    const candidates = (channelAgents || []).filter(agentAvailableForAutoWork);
    if (!candidates.length) return null;
    for (const id of normalizeIds(preferredIds)) {
      const preferred = candidates.find((agent) => agent.id === id);
      if (preferred) return preferred;
    }
    return candidates.find((agent) => ['idle', 'online'].includes(String(agent.status || '').toLowerCase()))
      || candidates[0]
      || null;
  }
  
  function pickBestFitAgent(channelAgents, message, preferredIds = []) {
    const preferred = pickAvailableAgent(channelAgents, preferredIds);
    if (preferred && preferredIds.length) return preferred;
    const candidates = (channelAgents || []).filter(agentAvailableForAutoWork);
    if (!candidates.length) return null;
    const text = String(message?.body || '');
    const ranked = candidates
      .map((agent, index) => ({ agent, index, score: agentDispatchScore(agent, text) }))
      .sort((a, b) => b.score - a.score
        || (agentIdleForAvailability(b.agent) ? 1 : 0) - (agentIdleForAvailability(a.agent) ? 1 : 0)
        || a.index - b.index);
    return ranked[0]?.agent || null;
  }
  
  function uniqueAgents(agents) {
    return normalizeIds((agents || []).map((agent) => agent?.id))
      .map((id) => (agents || []).find((agent) => agent?.id === id))
      .filter(Boolean);
  }
  
  function cleanTaskTitle(text, fallback = 'Follow-up task') {
    const cleaned = String(text || '')
      .replace(/<[@!#][^>]+>/g, ' ')
      .replace(/(创建|新建|开启|开|建)(一个|个)?\s*(task|任务)/gi, ' ')
      .replace(/\b(create|make|open|start)\s+(a\s+)?task\b/gi, ' ')
      .replace(/^[\s，。！？；：、,.!?;:\-]+/, '')
      .replace(/\s+/g, ' ')
      .trim();
    return (cleaned || fallback).slice(0, 120);
  }
  
  function displayActor(id) {
    if (id === 'system') return 'Magclaw';
    if (id === 'agt_codex') return 'Codex Local';
    const human = findHuman(id);
    if (human) return human.name;
    const agent = findAgent(id);
    if (agent) return agent.name;
    return id || 'Someone';
  }
  
  function channelAgentIds(channel) {
    if (!channel) return [];
    if (channel.id === 'chan_all') return state.agents.filter(agentParticipatesInChannels).map((agent) => agent.id);
    return normalizeIds([...(channel.agentIds || []), ...(channel.memberIds || []).filter((id) => id.startsWith('agt_'))])
      .filter((id) => agentParticipatesInChannels(findAgent(id)));
  }
  
  function channelHumanIds(channel) {
    if (!channel) return [];
    if (channel.id === 'chan_all') return state.humans.map((human) => human.id);
    return normalizeIds([...(channel.humanIds || []), ...(channel.memberIds || []).filter((id) => id.startsWith('hum_'))]);
  }
  
  function directedPrimaryAgentId(mentions, message) {
    if (!Array.isArray(mentions?.agents) || mentions.agents.length < 2) return null;
    const visibleText = renderMentionsForAgent(message?.body || '').replace(/\s+/g, '');
    const ordered = mentions.agents
      .map((id) => {
        const actor = findAgent(id);
        const label = actor ? visibleMentionLabel(actor).replace(/\s+/g, '') : '';
        return { id, label, index: label ? visibleText.indexOf(label) : -1 };
      })
      .filter((item) => item.index >= 0)
      .sort((a, b) => a.index - b.index);
    if (ordered.length < 2) return null;
  
    const [first, second] = ordered;
    const bridge = visibleText.slice(first.index + first.label.length, second.index);
    if (/(你|请你|麻烦你|帮我|去)?(找|叫|问|联系|拉|邀请|带|和|跟)$/.test(bridge)) return first.id;
    if (/(你|请你|麻烦你|帮我).*(找|叫|问|联系|拉|邀请|带|和|跟)/.test(bridge)) return first.id;
    return null;
  }
  
  function textAddressesAgent(agent, text) {
    const raw = String(text || '');
    const aliases = normalizeIds([agent?.name, agent?.displayName]);
    for (const alias of aliases) {
      const value = String(alias || '').trim();
      if (!value) continue;
      if (/^[A-Za-z0-9_.-]+$/.test(value)) {
        const pattern = new RegExp(`(^|[^A-Za-z0-9_.-])@?${escapeRegExp(value)}(?=$|[^A-Za-z0-9_.-])`, 'i');
        if (pattern.test(raw)) return true;
      } else if (raw.toLowerCase().includes(value.toLowerCase())) {
        return true;
      }
    }
    return false;
  }
  
  function markdownSection(content, heading) {
    const lines = String(content || '').split(/\r?\n/);
    const target = String(heading || '').trim().toLowerCase();
    let start = -1;
    let level = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(/^(#{1,6})\s+(.+?)\s*$/);
      if (!match) continue;
      if (match[2].trim().toLowerCase() === target) {
        start = index + 1;
        level = match[1].length;
        break;
      }
    }
    if (start === -1) return '';
    const collected = [];
    for (let index = start; index < lines.length; index += 1) {
      const match = lines[index].match(/^(#{1,6})\s+/);
      if (match && match[1].length <= level) break;
      collected.push(lines[index]);
    }
    return collected.join('\n').trim();
  }
  
  function compactMarkdownText(value, limit = AGENT_CARD_TEXT_LIMIT) {
    return String(value || '')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
      .replace(/\[[^\]]+]\(([^)]+)\)/g, ' $1 ')
      .replace(/[#>*_\-[\]]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, limit);
  }
  
  async function fileSignature(filePath) {
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) return 'missing';
    return `${info.size}:${Number(info.mtimeMs || 0).toFixed(0)}`;
  }
  
  async function readAgentCardFile(root, relPath, maxChars = AGENT_CARD_TEXT_LIMIT) {
    const filePath = safePathWithin(root, relPath);
    if (!filePath) return '';
    const content = await readFile(filePath, 'utf8').catch(() => '');
    return content.slice(0, maxChars);
  }
  
  function recentAgentTasks(agent) {
    return [...(state.tasks || [])]
      .filter((task) => task.claimedBy === agent.id || (task.assigneeIds || []).includes(agent.id))
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
      .slice(0, 6)
      .map((task) => `#${task.number || '?'} ${task.status || 'todo'} ${task.title || ''}`.trim());
  }
  
  function agentChannelNames(agent) {
    return (state.channels || [])
      .filter((channel) => !channel.archived && channelAgentIds(channel).includes(agent.id))
      .map((channel) => `#${channel.name}`);
  }
  
  async function buildAgentCard(agent) {
    if (!agent) return null;
    const root = agentDataDir(agent);
    const files = ['MEMORY.md', 'notes/profile.md', 'notes/agents.md', 'notes/work-log.md'];
    const signatureParts = await Promise.all(files.map((relPath) => fileSignature(path.join(root, relPath))));
    const signature = [
      agent.id,
      agent.name,
      agent.description,
      agent.status,
      agent.runtime,
      signatureParts.join('|'),
      (state.tasks || []).length,
    ].join('::');
    const cached = agentCardCache.get(agent.id);
    if (cached?.signature === signature) return cached.card;
  
    const [memory, profile, peers, workLog] = await Promise.all(files.map((relPath) => readAgentCardFile(root, relPath)));
    const role = markdownSection(memory, 'Role') || markdownSection(profile, 'Role') || agent.description || '';
    const capabilities = [
      markdownSection(memory, 'Capabilities'),
      markdownSection(profile, 'Strengths And Skills'),
      markdownSection(profile, 'Skills'),
      markdownSection(memory, 'Key Knowledge'),
    ].filter(Boolean).join('\n');
    const activeContext = markdownSection(memory, 'Active Context');
    const collaboration = [
      markdownSection(memory, 'Collaboration Rules'),
      markdownSection(profile, 'Response Boundaries'),
    ].filter(Boolean).join('\n');
    const recentTasks = recentAgentTasks(agent);
    const card = {
      id: agent.id,
      name: agent.name,
      description: agent.description || '',
      runtime: agent.runtime || '',
      status: agent.status || 'offline',
      systemRole: agent.systemRole || '',
      isBrain: isBrainAgent(agent),
      channels: agentChannelNames(agent),
      role: compactMarkdownText(role, 1600),
      capabilities: compactMarkdownText(capabilities || profile, 2200),
      collaboration: compactMarkdownText(collaboration, 1600),
      activeContext: compactMarkdownText(activeContext, 1400),
      peers: compactMarkdownText(peers, 1800),
      workLog: compactMarkdownText(workLog, 2200),
      recentTasks,
      haystack: compactMarkdownText([
        agent.name,
        agent.displayName,
        agent.description,
        agent.runtime,
        role,
        capabilities,
        activeContext,
        peers,
        workLog,
        recentTasks.join(' '),
      ].filter(Boolean).join('\n'), 9000).toLowerCase(),
      sourceFiles: files,
    };
    agentCardCache.set(agent.id, { signature, card });
    return card;
  }
  
  async function buildAgentCards(agents) {
    const cards = await Promise.all((agents || []).map((agent) => buildAgentCard(agent).catch((error) => {
      addSystemEvent('agent_card_error', `Could not build agent card for ${agent?.name || 'agent'}: ${error.message}`, {
        agentId: agent?.id || null,
      });
      return null;
    })));
    return new Map(cards.filter(Boolean).map((card) => [card.id, card]));
  }
  
  function threadParticipantAgentIds(message, linkedTask = null) {
    const ids = [];
    if (message?.authorType === 'agent') ids.push(message.authorId);
    ids.push(...(message?.mentionedAgentIds || []));
    ids.push(...(latestRouteEventForMessage(message?.id, message?.spaceId)?.targetAgentIds || []));
    if (linkedTask?.claimedBy) ids.push(linkedTask.claimedBy);
    ids.push(...(linkedTask?.assigneeIds || []));
    ids.push(...state.replies
      .filter((reply) => reply.parentMessageId === message?.id && reply.authorType === 'agent')
      .map((reply) => reply.authorId));
    return normalizeIds(ids);
  }
  
  function determineThreadRespondingAgents(message, reply, channelAgents, mentions, linkedTask = null) {
    if (mentions.agents.length || mentions.special.length) {
      return determineRespondingAgents(channelAgents, mentions, reply, message.spaceId);
    }
    const named = channelAgents.filter((agent) => textAddressesAgent(agent, reply.body));
    if (named.length) return named;
    const participantIds = threadParticipantAgentIds(message, linkedTask);
    const participants = participantIds
      .map((id) => channelAgents.find((agent) => agent.id === id))
      .filter(Boolean);
    if (participants.length) return normalizeIds(participants.map((agent) => agent.id))
      .map((id) => participants.find((agent) => agent.id === id))
      .filter(Boolean);
    if (reply?.authorType === 'human' && agentResponseIntent(reply.body)) {
      const agent = pickAvailableAgent(channelAgents);
      return agent ? [agent] : [];
    }
    return [];
  }
  
  function routeEvidence(type, value) {
    return { type, value: String(value || '').slice(0, 240) };
  }
  
  function namedAgentsOutsideExplicitMentions(channelAgents, text, mentionedIds = []) {
    const explicit = new Set(normalizeIds(mentionedIds));
    return availableChannelAgents(channelAgents)
      .filter((agent) => !explicit.has(agent.id))
      .filter((agent) => textAddressesAgent(agent, text));
  }
  
  function agentReferenceVariants(agent) {
    const variants = new Set();
    for (const alias of [agent?.name, agent?.displayName]) {
      const value = String(alias || '').trim();
      if (!value) continue;
      variants.add(value);
      if (!/^[A-Za-z0-9_.-]+$/.test(value)) {
        if (value.length >= 2) variants.add(value.slice(-2));
        if (value.length >= 3) variants.add(value.slice(-3));
        const first = value.slice(0, 1);
        if (/[\u4e00-\u9fa5]/.test(first)) {
          variants.add(`${first}道友`);
          variants.add(`${first}老师`);
          variants.add(`${first}师`);
        }
      }
    }
    return [...variants].filter((variant) => variant.length >= 2);
  }
  
  function implicitAgentReferences(channelAgents, text, mentionedIds = []) {
    const explicit = new Set(normalizeIds(mentionedIds));
    const raw = String(text || '').toLowerCase();
    if (!raw.trim()) return [];
    return availableChannelAgents(channelAgents)
      .filter((agent) => !explicit.has(agent.id))
      .filter((agent) => agentReferenceVariants(agent).some((variant) => raw.includes(variant.toLowerCase())));
  }
  
  function fanoutApiTriggerReason({ channelAgents, mentions, message, thread = null }) {
    if (!fanoutApiConfigured()) return null;
    if (message?.authorType !== 'human') return null;
    const text = String(message?.body || '');
    if (!text.trim()) return null;
    if (mentions.special.includes('all') || mentions.special.includes('everyone')) return null;
    if (mentions.special.includes('here') || mentions.special.includes('channel')) return null;
  
    const extraNamed = namedAgentsOutsideExplicitMentions(channelAgents, text, mentions.agents);
    const implicitNamed = implicitAgentReferences(channelAgents, text, mentions.agents);
    if (thread) {
      const threadParticipantIds = normalizeIds(thread.participantAgentIds || []);
      const combinedNamed = uniqueAgents([...extraNamed, ...implicitNamed]);
      if (mentions.agents.length && combinedNamed.length) {
        return {
          type: 'thread_explicit_mention_plus_named_agent',
          reason: 'Thread reply explicitly @mentions one agent and also appears to reference another agent.',
          namedAgentIds: combinedNamed.map((agent) => agent.id),
          participantAgentIds: threadParticipantIds,
        };
      }
      if (!mentions.agents.length && combinedNamed.length) {
        return {
          type: 'thread_named_agent',
          reason: 'Thread reply names or nicknames one or more agents; semantic routing should decide the reply targets.',
          namedAgentIds: combinedNamed.map((agent) => agent.id),
          participantAgentIds: threadParticipantIds,
        };
      }
      if (!mentions.agents.length && threadParticipantIds.length > 1) {
        return {
          type: 'thread_reply_semantic',
          reason: 'Thread reply has multiple possible agent participants and needs semantic routing.',
          namedAgentIds: [],
          participantAgentIds: threadParticipantIds,
        };
      }
      if (agentCapabilityQuestionIntent(text)) {
        return {
          type: 'thread_capability_question',
          reason: 'Thread capability comparison should use all agent cards before deciding fan-out.',
          namedAgentIds: combinedNamed.map((agent) => agent.id),
          participantAgentIds: threadParticipantIds,
        };
      }
      if (autoTaskMessageIntent(text)) {
        return {
          type: 'thread_task_claim',
          reason: 'Thread work request needs semantic routing and a single claimant when possible.',
          namedAgentIds: combinedNamed.map((agent) => agent.id),
          participantAgentIds: threadParticipantIds,
        };
      }
    }
    if (mentions.agents.length && extraNamed.length) {
      return {
        type: 'explicit_mention_plus_named_agent',
        reason: 'Message explicitly @mentions one agent and also names another channel agent.',
        namedAgentIds: extraNamed.map((agent) => agent.id),
      };
    }
    if (mentions.agents.length) return null;
    if (!mentions.agents.length && extraNamed.length > 1) {
      return {
        type: 'multiple_named_agents',
        reason: 'Message names multiple channel agents without explicit @mentions.',
        namedAgentIds: extraNamed.map((agent) => agent.id),
      };
    }
    if (agentCapabilityQuestionIntent(text)) {
      return {
        type: 'capability_question',
        reason: 'Capability comparison should use all agent cards before deciding fan-out.',
        namedAgentIds: extraNamed.map((agent) => agent.id),
      };
    }
    if (autoTaskMessageIntent(text)) {
      return {
        type: 'task_claim',
        reason: 'Concrete work request needs semantic routing and a single claimant when possible.',
        namedAgentIds: extraNamed.map((agent) => agent.id),
      };
    }
    return null;
  }
  
  function serializeFanoutCard(card, channelAgentIds) {
    const channelMember = channelAgentIds.has(card.id);
    return {
      id: card.id,
      name: card.name,
      description: card.description,
      status: card.status,
      channels: card.channels || [],
      channelMember,
      selectable: channelMember,
      role: card.role || '',
      capabilities: card.capabilities || '',
      activeContext: card.activeContext || '',
      collaboration: card.collaboration || '',
      recentTasks: card.recentTasks || [],
      sourceFiles: card.sourceFiles || [],
    };
  }
  
  function fanoutConversationRecord(record) {
    if (!record) return null;
    return {
      id: record.id || null,
      parentMessageId: record.parentMessageId || null,
      authorType: record.authorType || 'unknown',
      authorId: record.authorId || null,
      authorName: displayActor(record.authorId),
      body: renderMentionsForAgent(record.body || ''),
      mentionedAgentIds: normalizeIds(record.mentionedAgentIds || []),
      taskId: record.taskId || null,
      createdAt: record.createdAt || null,
    };
  }
  
  function threadFanoutContext(parentMessage, reply, linkedTask = null) {
    if (!parentMessage) return null;
    const participantAgentIds = threadParticipantAgentIds(parentMessage, linkedTask);
    const recentReplies = [...(state.replies || [])]
      .filter((item) => item.parentMessageId === parentMessage.id)
      .sort((a, b) => messageTimeMs(a) - messageTimeMs(b))
      .slice(-10);
    return {
      parentMessage: fanoutConversationRecord(parentMessage),
      currentReplyId: reply?.id || null,
      participantAgentIds,
      participantAgents: participantAgentIds
        .map((id) => findAgent(id))
        .filter(Boolean)
        .map((agent) => ({
          id: agent.id,
          name: agent.name,
          description: agent.description || '',
          status: agent.status || '',
        })),
      linkedTask: linkedTask ? {
        id: linkedTask.id,
        number: linkedTask.number || null,
        title: linkedTask.title || '',
        status: linkedTask.status || '',
        claimedBy: linkedTask.claimedBy || null,
        assigneeIds: normalizeIds(linkedTask.assigneeIds || []),
      } : null,
      recentReplies: recentReplies.map(fanoutConversationRecord),
    };
  }
  
  function fanoutApiMessages({ channelAgents, mentions, message, allCards, trigger, thread = null }) {
    const channelAgentIds = new Set((channelAgents || []).map((agent) => agent.id));
    const availableIds = availableChannelAgents(channelAgents).map((agent) => agent.id);
    const payload = {
      message: {
        id: message?.id || null,
        parentMessageId: message?.parentMessageId || null,
        authorType: message?.authorType || 'human',
        body: renderMentionsForAgent(message?.body || ''),
        mentionedAgentIds: normalizeIds(mentions.agents),
        specialMentions: normalizeIds(mentions.special),
      },
      thread,
      trigger,
      allowedChannelAgentIds: availableIds,
      channelAgents: (channelAgents || []).map((agent) => ({
        id: agent.id,
        name: agent.name,
        description: agent.description || '',
        status: agent.status || '',
      })),
      agentCards: [...(allCards?.values?.() || [])].map((card) => serializeFanoutCard(card, channelAgentIds)),
      outputSchema: {
        mode: 'directed | broadcast | availability | task_claim | contextual_follow_up | passive_awareness',
        targetAgentIds: ['agt_id'],
        claimantAgentId: 'agt_id or null',
        confidence: 'number from 0 to 1',
        reason: 'short routing explanation',
        taskIntent: { title: 'short title', kind: 'coding | research | docs | ops | planning | unknown' },
      },
    };
    return [
      {
        role: 'system',
        content: [
          'You are Magclaw fan-out router.',
          'Decide which selectable channel agents should receive this message.',
          'Use all agent cards for capability awareness, but targetAgentIds and claimantAgentId must be chosen only from allowedChannelAgentIds.',
          'Prefer one claimant for concrete work. Use broadcast only for open group discussion or capability comparison.',
          'For thread replies, use the parent message, recent replies, participants, and nicknames/titles to avoid waking unrelated agents.',
          'If a thread reply is simple chat, prefer the smallest useful target set; use passive_awareness with no targets if no agent should answer.',
          'Return only a single JSON object matching the requested schema. Do not include markdown.',
        ].join(' '),
      },
      {
        role: 'user',
        content: JSON.stringify(payload),
      },
    ];
  }
  
  async function callFanoutApi({ channelAgents, mentions, message, spaceId, allCards, trigger, thread = null }) {
    const config = normalizeFanoutApiConfig(state.settings?.fanoutApi || {});
    if (!fanoutApiConfigured(config)) throw new Error('Fan-out API is not fully configured.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
    const startedAt = Date.now();
    try {
      const response = await fetch(fanoutApiEndpoint(config.baseUrl), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          messages: fanoutApiMessages({ channelAgents, mentions, message, spaceId, allCards, trigger, thread }),
          temperature: 0,
        }),
      });
      const text = await response.text();
      const data = text ? JSON.parse(text) : {};
      if (!response.ok) {
        throw new Error(data?.error?.message || data?.message || response.statusText);
      }
      const rawDecision = parseFanoutApiJson(fanoutApiResponseText(data));
      const latencyMs = Date.now() - startedAt;
      const decision = normalizeRouteDecision({
        ...rawDecision,
        targetAgentIds: rawDecision.targetAgentIds || rawDecision.agentIds || rawDecision.targets || [],
        claimantAgentId: rawDecision.claimantAgentId || null,
        reason: rawDecision.reason || 'Fan-out API selected agents.',
        evidence: [
          routeEvidence('llm_trigger', trigger?.type || 'semantic'),
          routeEvidence('llm_reason', trigger?.reason || ''),
          routeEvidence('llm_model', config.model),
          routeEvidence('llm_latency_ms', String(latencyMs)),
          ...(Array.isArray(rawDecision.evidence) ? rawDecision.evidence : []),
        ],
        llmUsed: true,
        llmAttempted: true,
        llmLatencyMs: latencyMs,
        llmModel: config.model,
        llmBaseUrl: config.baseUrl,
        strategy: 'llm',
      }, channelAgents);
      return decision;
    } finally {
      clearTimeout(timeout);
    }
  }
  
  function selectBrainAgent() {
    const activeId = state.router?.brainAgentId || null;
    const active = activeId
      ? (state.brainAgents || []).find((brain) => brain.id === activeId && brain.active && brain.runtime)
      : null;
    return active || null;
  }
  
  function findBrainAgent(id) {
    return (state.brainAgents || []).find((brain) => brain.id === id) || null;
  }
  
  function activateBrainAgent(brainId) {
    const brain = findBrainAgent(brainId);
    if (!brain) throw httpError(404, 'Brain Agent not found.');
    if (!brain.runtime) throw httpError(400, 'Brain Agent runtime must be configured before activation.');
    for (const item of state.brainAgents || []) {
      item.active = item.id === brain.id;
      item.status = item.runtime ? 'configured' : 'offline';
      item.updatedAt = item.id === brain.id ? now() : item.updatedAt;
    }
    state.router = {
      mode: 'brain_agent',
      brainAgentId: brain.id,
      fallback: 'rules',
      cardSource: 'workspace_markdown',
      ...(state.router || {}),
    };
    state.router.mode = 'brain_agent';
    state.router.brainAgentId = brain.id;
    return brain;
  }
  
  function deactivateBrainAgent(brainId = null) {
    for (const item of state.brainAgents || []) {
      if (!brainId || item.id === brainId) {
        item.active = false;
        item.status = item.runtime ? 'configured' : 'offline';
        item.updatedAt = now();
      }
    }
    if (!brainId || state.router?.brainAgentId === brainId) {
      state.router = {
        mode: 'rules_fallback',
        brainAgentId: null,
        fallback: 'rules',
        cardSource: 'workspace_markdown',
        ...(state.router || {}),
      };
      state.router.mode = 'rules_fallback';
      state.router.brainAgentId = null;
    }
  }
  
  function createBrainAgentConfig(body = {}) {
    const runtime = String(body.runtime || '').trim();
    if (!runtime || isLegacyBrainRuntime(runtime)) throw httpError(400, 'Brain Agent runtime is required.');
    const brain = normalizeBrainAgentConfig({
      runtime,
      model: body.model || state.settings?.model,
      computerId: body.computerId || 'cmp_local',
      workspace: body.workspace || state.settings?.defaultWorkspace || ROOT,
      reasoningEffort: body.reasoningEffort || null,
      createdAt: now(),
      updatedAt: now(),
    });
    state.brainAgents.push(brain);
    const shouldActivate = body.active === true || (body.active === undefined && !selectBrainAgent());
    if (shouldActivate) activateBrainAgent(brain.id);
    return brain;
  }
  
  function updateBrainAgentConfig(brain, body = {}) {
    if (!brain) throw httpError(404, 'Brain Agent not found.');
    const next = {
      ...brain,
      runtime: body.runtime !== undefined ? String(body.runtime || '').trim() : brain.runtime,
      model: body.model !== undefined ? body.model : brain.model,
      computerId: body.computerId !== undefined ? body.computerId : brain.computerId,
      workspace: body.workspace !== undefined ? body.workspace : brain.workspace,
      reasoningEffort: body.reasoningEffort !== undefined ? body.reasoningEffort : brain.reasoningEffort,
      updatedAt: now(),
    };
    const normalized = normalizeBrainAgentConfig(next, { active: brain.active });
    if (!normalized.runtime) throw httpError(400, 'Brain Agent runtime is required.');
    Object.assign(brain, normalized);
    if (body.active === true) activateBrainAgent(brain.id);
    if (body.active === false) deactivateBrainAgent(brain.id);
    return brain;
  }
  
  function availableChannelAgents(channelAgents) {
    return (channelAgents || [])
      .filter(agentParticipatesInChannels)
      .filter(agentAvailableForAutoWork);
  }
  
  function idleChannelAgents(channelAgents) {
    return availableChannelAgents(channelAgents).filter(agentIdleForAvailability);
  }
  
  function agentDispatchScoreFromCard(agent, card, text) {
    if (!agentAvailableForAutoWork(agent)) return -Infinity;
    let score = agentDispatchScore(agent, text);
    const haystack = String(card?.haystack || agentDispatchHaystack(agent)).toLowerCase();
    for (const term of dispatchSearchTerms(text)) {
      if (haystack.includes(term)) score += Math.min(36, term.length * 4);
    }
    if (card?.recentTasks?.length) score += Math.min(3, card.recentTasks.length * 0.4);
    if (String(agent.status || '').toLowerCase() === 'idle') score += 3;
    return score;
  }
  
  function pickBestFitAgentWithCards(channelAgents, message, cards, preferredIds = []) {
    const preferred = pickAvailableAgent(channelAgents, preferredIds);
    if (preferred && preferredIds.length) return { agent: preferred, score: 999 };
    const candidates = availableChannelAgents(channelAgents);
    if (!candidates.length) return { agent: null, score: -Infinity };
    const text = String(message?.body || '');
    const ranked = candidates
      .map((agent, index) => ({
        agent,
        index,
        score: agentDispatchScoreFromCard(agent, cards?.get(agent.id), text),
      }))
      .sort((a, b) => b.score - a.score
        || (agentIdleForAvailability(b.agent) ? 1 : 0) - (agentIdleForAvailability(a.agent) ? 1 : 0)
        || a.index - b.index);
    return ranked[0] || { agent: null, score: -Infinity };
  }
  
  function normalizeRouteDecision(decision, channelAgents) {
    const allowed = new Set((channelAgents || []).map((agent) => agent.id));
    const targetAgentIds = normalizeIds(decision?.targetAgentIds || []).filter((id) => allowed.has(id));
    const claimantAgentId = targetAgentIds.includes(decision?.claimantAgentId)
      ? decision.claimantAgentId
      : null;
    const llmUsed = Boolean(decision?.llmUsed);
    const fallbackUsed = Boolean(decision?.fallbackUsed);
    return {
      mode: decision?.mode || 'passive_awareness',
      targetAgentIds,
      claimantAgentId,
      confidence: Number.isFinite(Number(decision?.confidence)) ? Number(decision.confidence) : 0.5,
      reason: String(decision?.reason || 'Router selected agents.'),
      evidence: Array.isArray(decision?.evidence) ? decision.evidence : [],
      taskIntent: decision?.taskIntent || null,
      brainAgentId: decision?.brainAgentId || null,
      fallbackUsed,
      strategy: decision?.strategy || (llmUsed ? 'llm' : (fallbackUsed ? 'fallback_rules' : 'rules')),
      llmUsed,
      llmAttempted: Boolean(decision?.llmAttempted || llmUsed),
      llmLatencyMs: Number.isFinite(Number(decision?.llmLatencyMs)) ? Number(decision.llmLatencyMs) : null,
      llmModel: decision?.llmModel ? String(decision.llmModel) : null,
      llmBaseUrl: decision?.llmBaseUrl ? String(decision.llmBaseUrl) : null,
    };
  }
  
  function evaluateBrainRouteDecision({ channelAgents, mentions, message, spaceId, cards, brainAgent = null, fallbackUsed = false, fallbackError = null }) {
    const available = availableChannelAgents(channelAgents);
    const idle = idleChannelAgents(channelAgents);
    const text = String(message?.body || '');
    const evidence = [
      routeEvidence('router', brainAgent?.name || 'rules'),
      routeEvidence('channel_member', `${available.length}/${channelAgents.length} available member agents`),
      ...(fallbackError ? [routeEvidence('fallback_error', fallbackError.message || fallbackError)] : []),
    ];
    const baseDecision = {
      brainAgentId: brainAgent?.id || null,
      fallbackUsed,
      strategy: fallbackUsed ? 'fallback_rules' : 'rules',
      llmAttempted: Boolean(fallbackError),
    };
  
    if (mentions.agents.length > 0) {
      const directedPrimary = message?.authorType === 'human' ? directedPrimaryAgentId(mentions, message) : null;
      const targetAgentIds = directedPrimary
        ? [directedPrimary]
        : mentions.agents.filter((id) => available.some((agent) => agent.id === id));
      return normalizeRouteDecision({
        mode: 'directed',
        targetAgentIds,
        confidence: 0.98,
        reason: directedPrimary
          ? 'Explicit multi-agent mention looked like a request for the first named agent to coordinate.'
          : 'Explicit agent mention routes to the mentioned agent(s).',
        evidence: [...evidence, routeEvidence('mention', mentions.agents.join(', '))],
        ...baseDecision,
      }, channelAgents);
    }
  
    if (mentions.special.includes('all') || mentions.special.includes('everyone')) {
      return normalizeRouteDecision({
        mode: 'broadcast',
        targetAgentIds: available.map((agent) => agent.id),
        confidence: 0.95,
        reason: '@all/@everyone wakes every available channel agent.',
        evidence: [...evidence, routeEvidence('mention', '@all')],
        ...baseDecision,
      }, channelAgents);
    }
  
    if (mentions.special.includes('here') || mentions.special.includes('channel')) {
      return normalizeRouteDecision({
        mode: 'availability',
        targetAgentIds: idle.map((agent) => agent.id),
        confidence: 0.92,
        reason: '@here/@channel wakes idle/online channel agents.',
        evidence: [...evidence, routeEvidence('status', `${idle.length} idle/online agents`)],
        ...baseDecision,
      }, channelAgents);
    }
  
    if (message?.authorType === 'human') {
      const named = available.filter((agent) => textAddressesAgent(agent, text));
      if (named.length) {
        return normalizeRouteDecision({
          mode: directAvailabilityIntent(text) ? 'availability' : 'directed',
          targetAgentIds: named.map((agent) => agent.id),
          confidence: 0.93,
          reason: 'Natural-language agent name matched a channel member.',
          evidence: [...evidence, routeEvidence('mention', named.map((agent) => agent.name).join(', '))],
          ...baseDecision,
        }, channelAgents);
      }
  
      const followupAgents = availabilityFollowupAgents(channelAgents, message, spaceId);
      if (followupAgents.length) {
        return normalizeRouteDecision({
          mode: 'follow_up',
          targetAgentIds: followupAgents.map((agent) => agent.id),
          confidence: 0.88,
          reason: 'Availability follow-up targets remaining idle agents from recent channel context.',
          evidence: [...evidence, routeEvidence('recent_context', 'availability follow-up')],
          ...baseDecision,
        }, channelAgents);
      }
  
      const focusedFollowup = focusedRecentAgentForHumanFollowup(channelAgents, message, spaceId);
      if (focusedFollowup?.agent) {
        return normalizeRouteDecision({
          mode: 'contextual_follow_up',
          targetAgentIds: [focusedFollowup.agent.id],
          confidence: 0.89,
          reason: `Recent single-agent context indicates this follow-up is for ${focusedFollowup.agent.name}.`,
          evidence: [
            ...evidence,
            routeEvidence('recent_context', focusedFollowup.source),
            routeEvidence('reference_message', focusedFollowup.referenceMessageId || ''),
            routeEvidence('reference_route', focusedFollowup.routeEventId || ''),
          ],
          ...baseDecision,
        }, channelAgents);
      }
  
      if (availabilityBroadcastIntent(text)) {
        return normalizeRouteDecision({
          mode: 'availability',
          targetAgentIds: idle.map((agent) => agent.id),
          confidence: 0.9,
          reason: 'Availability check should let available channel agents answer for themselves.',
          evidence: [...evidence, routeEvidence('status', `${idle.length} idle/online agents`)],
          ...baseDecision,
        }, channelAgents);
      }
  
      if (agentCapabilityQuestionIntent(text)) {
        return normalizeRouteDecision({
          mode: 'broadcast',
          targetAgentIds: available.map((agent) => agent.id),
          confidence: 0.86,
          reason: 'Capability or identity comparison needs agents to self-report and sense each other.',
          evidence: [...evidence, routeEvidence('agent_card', 'capability comparison')],
          ...baseDecision,
        }, channelAgents);
      }
  
      if (autoTaskMessageIntent(text)) {
        const best = pickBestFitAgentWithCards(channelAgents, message, cards, mentions.agents || []);
        return normalizeRouteDecision({
          mode: 'task_claim',
          targetAgentIds: best.agent ? [best.agent.id] : [],
          claimantAgentId: best.agent?.id || null,
          confidence: best.agent ? Math.min(0.94, Math.max(0.66, 0.62 + (best.score / 200))) : 0.2,
          reason: best.agent
            ? `Concrete work detected; ${best.agent.name} is the best-fit claimant from agent card scoring.`
            : 'Concrete work detected but no available channel agent could claim it.',
          evidence: [
            ...evidence,
            routeEvidence('agent_card', best.agent ? `${best.agent.name} score=${Number(best.score || 0).toFixed(1)}` : 'none'),
            routeEvidence('task_lock', 'claim before execution'),
          ],
          taskIntent: best.agent ? {
            title: cleanTaskTitle(text),
            kind: inferTaskIntentKind(text),
          } : null,
          ...baseDecision,
        }, channelAgents);
      }
  
      return normalizeRouteDecision({
        mode: channelGreetingIntent(text) ? 'broadcast' : 'broadcast',
        targetAgentIds: available.map((agent) => agent.id),
        confidence: channelGreetingIntent(text) ? 0.82 : 0.74,
        reason: 'Open human channel message fans out to available member agents.',
        evidence,
        ...baseDecision,
      }, channelAgents);
    }
  
    const targetAgentIds = available
      .filter((agent) => shouldAgentRespond(agent, message, spaceId))
      .map((agent) => agent.id);
    return normalizeRouteDecision({
      mode: 'passive_awareness',
      targetAgentIds,
      confidence: 0.5,
      reason: 'Non-human message used passive awareness fallback.',
      evidence,
      ...baseDecision,
    }, channelAgents);
  }
  
  function legacyRouteDecision(channelAgents, mentions, message, spaceId, error = null) {
    const agents = determineRespondingAgents(channelAgents, mentions, message, spaceId);
    const claimant = message?.authorType === 'human' && autoTaskMessageIntent(message.body)
      ? pickBestFitAgent(channelAgents, message)
      : null;
    const focusedFollowup = focusedRecentAgentForHumanFollowup(channelAgents, message, spaceId);
    const isContextualFollowup = Boolean(focusedFollowup?.agent
      && agents.length === 1
      && agents[0]?.id === focusedFollowup.agent.id);
    const isDirected = Boolean(!claimant
      && !isContextualFollowup
      && message?.authorType === 'human'
      && agents.length
      && agents.length < availableChannelAgents(channelAgents).length);
    return normalizeRouteDecision({
      mode: claimant ? 'task_claim' : (isContextualFollowup ? 'contextual_follow_up' : (isDirected ? 'directed' : 'broadcast')),
      targetAgentIds: agents.map((agent) => agent.id),
      claimantAgentId: claimant?.id || null,
      confidence: isContextualFollowup ? 0.76 : 0.45,
      reason: isContextualFollowup
        ? `Rules fallback kept the recent focused conversation with ${focusedFollowup.agent.name}.`
        : (error ? `Fan-out router failed; rules fallback used: ${error.message}` : 'Rules fallback selected agents.'),
      evidence: [
        routeEvidence('fallback', error?.message || 'legacy rules'),
        ...(isContextualFollowup ? [
          routeEvidence('recent_context', focusedFollowup.source),
          routeEvidence('reference_message', focusedFollowup.referenceMessageId || ''),
          routeEvidence('reference_route', focusedFollowup.routeEventId || ''),
        ] : []),
      ],
      taskIntent: claimant ? { title: cleanTaskTitle(message?.body || ''), kind: inferTaskIntentKind(message?.body || '') } : null,
      brainAgentId: selectBrainAgent()?.id || null,
      fallbackUsed: true,
    }, channelAgents);
  }
  
  function addRouteEvent(decision, { message, spaceType = 'channel', spaceId = null } = {}) {
    state.routeEvents = Array.isArray(state.routeEvents) ? state.routeEvents : [];
    const event = {
      id: makeId('route'),
      messageId: message?.id || null,
      parentMessageId: message?.parentMessageId || null,
      spaceType,
      spaceId,
      mode: decision.mode,
      targetAgentIds: decision.targetAgentIds,
      claimantAgentId: decision.claimantAgentId || null,
      confidence: decision.confidence,
      reason: decision.reason,
      evidence: decision.evidence || [],
      taskIntent: decision.taskIntent || null,
      brainAgentId: decision.brainAgentId || null,
      fallbackUsed: Boolean(decision.fallbackUsed),
      strategy: decision.strategy || (decision.llmUsed ? 'llm' : (decision.fallbackUsed ? 'fallback_rules' : 'rules')),
      llmUsed: Boolean(decision.llmUsed),
      llmAttempted: Boolean(decision.llmAttempted || decision.llmUsed),
      llmLatencyMs: Number.isFinite(Number(decision.llmLatencyMs)) ? Number(decision.llmLatencyMs) : null,
      llmModel: decision.llmModel || null,
      createdAt: now(),
    };
    state.routeEvents.push(event);
    if (state.routeEvents.length > ROUTE_EVENTS_LIMIT) {
      state.routeEvents = state.routeEvents.slice(state.routeEvents.length - ROUTE_EVENTS_LIMIT);
    }
    addSystemEvent('route_decision', `Route ${event.mode}: ${event.targetAgentIds.length} agent(s) selected.`, {
      routeEventId: event.id,
      messageId: event.messageId,
      parentMessageId: event.parentMessageId,
      spaceType: event.spaceType,
      spaceId: event.spaceId,
      mode: event.mode,
      targetAgentIds: event.targetAgentIds,
      claimantAgentId: event.claimantAgentId,
      confidence: event.confidence,
      reason: event.reason,
      evidence: event.evidence,
      taskIntent: event.taskIntent,
      brainAgentId: event.brainAgentId,
      fallbackUsed: event.fallbackUsed,
      strategy: event.strategy,
      llmUsed: event.llmUsed,
      llmAttempted: event.llmAttempted,
      llmLatencyMs: event.llmLatencyMs,
      llmModel: event.llmModel,
    });
    return event;
  }
  
  async function routeMessageForChannel({ channelAgents, mentions, message, spaceId }) {
    try {
      const allRoutingAgents = (state.agents || []).filter(agentParticipatesInChannels);
      const allCards = await buildAgentCards(allRoutingAgents);
      const trigger = fanoutApiTriggerReason({ channelAgents, mentions, message });
      if (trigger) {
        try {
          const decision = await callFanoutApi({ channelAgents, mentions, message, spaceId, allCards, trigger });
          const routeEvent = addRouteEvent(decision, { message, spaceId });
          return { ...decision, routeEvent };
        } catch (error) {
          const decision = evaluateBrainRouteDecision({
            channelAgents,
            mentions,
            message,
            spaceId,
            cards: allCards,
            fallbackUsed: true,
            fallbackError: error,
          });
          const routeEvent = addRouteEvent(decision, { message, spaceId });
          return { ...decision, routeEvent };
        }
      }
      const decision = evaluateBrainRouteDecision({
        channelAgents,
        mentions,
        message,
        spaceId,
        cards: allCards,
        fallbackUsed: !fanoutApiConfigured(),
      });
      const routeEvent = addRouteEvent(decision, { message, spaceId });
      return { ...decision, routeEvent };
    } catch (error) {
      const decision = legacyRouteDecision(channelAgents, mentions, message, spaceId, error);
      const routeEvent = addRouteEvent(decision, { message, spaceId });
      return { ...decision, routeEvent };
    }
  }
  
  function evaluateThreadRouteDecision({ channelAgents, mentions, parentMessage, reply, linkedTask = null, fallbackUsed = false, fallbackError = null }) {
    const respondingAgents = determineThreadRespondingAgents(parentMessage, reply, channelAgents, mentions, linkedTask);
    const named = (channelAgents || []).filter((agent) => textAddressesAgent(agent, reply?.body));
    const evidence = [
      routeEvidence('router', 'thread_rules'),
      routeEvidence('thread_parent', parentMessage?.id || ''),
      routeEvidence('thread_participants', threadParticipantAgentIds(parentMessage, linkedTask).join(', ')),
      ...(fallbackError ? [routeEvidence('fallback_error', fallbackError.message || fallbackError)] : []),
    ];
    const hasExplicitMention = Boolean(mentions.agents.length || mentions.special.length || named.length);
    let mode = 'passive_awareness';
    if (mentions.special.includes('all') || mentions.special.includes('everyone')) {
      mode = 'broadcast';
    } else if (mentions.special.includes('here') || mentions.special.includes('channel')) {
      mode = 'availability';
    } else if (hasExplicitMention) {
      mode = 'directed';
    } else if (respondingAgents.length) {
      mode = 'contextual_follow_up';
    }
    return normalizeRouteDecision({
      mode,
      targetAgentIds: respondingAgents.map((agent) => agent.id),
      confidence: hasExplicitMention ? 0.9 : (respondingAgents.length ? 0.72 : 0.4),
      reason: fallbackError
        ? `Thread fan-out router failed; rules fallback used: ${fallbackError.message}`
        : (respondingAgents.length ? 'Thread rules selected responding agents.' : 'Thread rules found no agent that needs to answer.'),
      evidence,
      fallbackUsed,
      strategy: fallbackUsed ? 'fallback_rules' : 'rules',
      llmAttempted: Boolean(fallbackError),
    }, channelAgents);
  }
  
  async function routeThreadReplyForChannel({ channelAgents, mentions, parentMessage, reply, linkedTask = null, spaceId }) {
    try {
      const thread = threadFanoutContext(parentMessage, reply, linkedTask);
      const trigger = fanoutApiTriggerReason({ channelAgents, mentions, message: reply, thread });
      if (trigger) {
        try {
          const allRoutingAgents = (state.agents || []).filter(agentParticipatesInChannels);
          const allCards = await buildAgentCards(allRoutingAgents);
          const decision = await callFanoutApi({ channelAgents, mentions, message: reply, spaceId, allCards, trigger, thread });
          const routeEvent = addRouteEvent(decision, { message: reply, spaceId });
          return { ...decision, routeEvent };
        } catch (error) {
          const decision = evaluateThreadRouteDecision({
            channelAgents,
            mentions,
            parentMessage,
            reply,
            linkedTask,
            fallbackUsed: true,
            fallbackError: error,
          });
          const routeEvent = addRouteEvent(decision, { message: reply, spaceId });
          return { ...decision, routeEvent };
        }
      }
      const decision = evaluateThreadRouteDecision({
        channelAgents,
        mentions,
        parentMessage,
        reply,
        linkedTask,
        fallbackUsed: !fanoutApiConfigured(),
      });
      const routeEvent = addRouteEvent(decision, { message: reply, spaceId });
      return { ...decision, routeEvent };
    } catch (error) {
      const decision = evaluateThreadRouteDecision({
        channelAgents,
        mentions,
        parentMessage,
        reply,
        linkedTask,
        fallbackUsed: true,
        fallbackError: error,
      });
      const routeEvent = addRouteEvent(decision, { message: reply, spaceId });
      return { ...decision, routeEvent };
    }
  }
  
  // Determine which agents should respond based on mentions and personality
  function determineRespondingAgents(channelAgents, mentions, message, spaceId) {
    const respondingAgents = [];
  
    // Case 1: Specific agent(s) mentioned via <@agt_xxx>
    if (mentions.agents.length > 0) {
      const directedPrimary = message?.authorType === 'human' ? directedPrimaryAgentId(mentions, message) : null;
      if (directedPrimary) {
        const agent = channelAgents.find(a => a.id === directedPrimary);
        return agent ? [agent] : [];
      }
      for (const agentId of mentions.agents) {
        const agent = channelAgents.find(a => a.id === agentId);
        if (agent) respondingAgents.push(agent);
      }
      return respondingAgents;
    }
  
    // Case 2: @all or @everyone - all available agents respond
    if (mentions.special.includes('all') || mentions.special.includes('everyone')) {
      return channelAgents.filter(agentAvailableForAutoWork);
    }
  
    // Case 3: @here - only online/idle agents respond
    if (mentions.special.includes('here') || mentions.special.includes('channel')) {
      return channelAgents.filter(agentIdleForAvailability);
    }
  
    // Case 4: Top-level human channel messages follow Slock-style channel membership.
    if (message?.authorType === 'human') {
      const named = channelAgents.filter((agent) => textAddressesAgent(agent, message.body));
      if (named.length) return uniqueAgents(named.filter(agentAvailableForAutoWork));
      const followupAgents = availabilityFollowupAgents(channelAgents, message, spaceId);
      if (followupAgents.length) return followupAgents;
      const focusedFollowup = focusedRecentAgentForHumanFollowup(channelAgents, message, spaceId);
      if (focusedFollowup?.agent) return [focusedFollowup.agent];
      if (autoTaskMessageIntent(message.body)) {
        const agent = pickBestFitAgent(channelAgents, message);
        return agent ? [agent] : [];
      }
      return channelAgents.filter(agentAvailableForAutoWork);
    }
  
    // Case 5: Non-human messages without mentions can still use personality-based routing.
    for (const agent of channelAgents) {
      if (shouldAgentRespond(agent, message, spaceId)) {
        respondingAgents.push(agent);
      }
    }
  
    return respondingAgents;
  }
  
  // Personality-based decision: should this agent respond without direct mention?
  function shouldAgentRespond(agent, message, spaceId) {
    const personality = agent.personality || {};
    const memory = agent.memory || {};
    const proactivity = typeof personality.proactivity === 'number' ? personality.proactivity : 0.3;
  
    // Base score starts at proactivity level
    let score = proactivity;
  
    // Factor 1: Message mentions topics in agent's interests
    const interests = personality.interests || [];
    const messageText = (message.body || '').toLowerCase();
    const topicMatch = interests.some(topic => messageText.includes(topic.toLowerCase()));
    if (topicMatch) score += 0.3;
  
    // Factor 2: Agent has recent context in this space (within 30 minutes)
    const recentThreshold = 30 * 60 * 1000;
    const hasRecentContext = (memory.conversationSummaries || []).some(
      s => s.spaceId === spaceId && Date.now() - new Date(s.updatedAt).getTime() < recentThreshold
    );
    if (hasRecentContext) score += 0.2;
  
    // Factor 3: Random factor for natural variation
    const randomFactor = Math.random() * 0.3;
  
    // Decision: respond if combined score exceeds threshold
    return (score + randomFactor) > 0.6;
  }

  return {
    addRouteEvent,
    buildAgentCard,
    buildAgentCards,
    channelAgentIds,
    channelHumanIds,
    cleanTaskTitle,
    determineRespondingAgents,
    determineThreadRespondingAgents,
    displayActor,
    evaluateBrainRouteDecision,
    evaluateThreadRouteDecision,
    implicitAgentReferences,
    namedAgentsOutsideExplicitMentions,
    pickAvailableAgent,
    pickBestFitAgent,
    routeMessageForChannel,
    routeThreadReplyForChannel,
    shouldAgentRespond,
    textAddressesAgent,
    threadParticipantAgentIds,
    uniqueAgents,
  };
}
