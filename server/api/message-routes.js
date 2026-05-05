// Message and thread API routes.
// This route group owns the human-facing conversation writes: top-level
// messages, thread replies, saved toggles, and message-to-task promotion. The
// delivery/routing helpers are injected so the route remains a thin workflow
// coordinator rather than a second Agent runtime implementation.

export async function handleMessageApi(req, res, url, deps) {
  const {
    addCollabEvent,
    addSystemEvent,
    addSystemReply,
    agentAvailableForAutoWork,
    agentCapabilityQuestionIntent,
    agentMemoryWriteIntent,
    applyMentions,
    availabilityFollowupIntent,
    broadcastState,
    channelAgentIds,
    createOrClaimTaskForMessage,
    createTaskFromMessage,
    createTaskFromThreadIntent,
    deliverMessageToAgent,
    extractMentions,
    findAgent,
    findChannel,
    findConversationRecord,
    findMessage,
    findTaskForThreadMessage,
    finishTaskFromThread,
    getState,
    inferAgentMemoryWriteback,
    makeId,
    normalizeConversationRecord,
    now,
    persistState,
    pickAvailableAgent,
    readJson,
    routeMessageForChannel,
    routeThreadReplyForChannel,
    scheduleAgentMemoryWriteback,
    searchAgentMemory,
    sendError,
    sendJson,
    stopTaskFromThread,
    taskCreationIntent,
    taskEndIntent,
    taskStopIntent,
    taskThreadDeliveryMessage,
    userPreferenceIntent,
  } = deps;
  const state = getState();

  function publicRouteDecision(routeDecision) {
    if (!routeDecision) return null;
    const { runFanoutSupplement, ...publicDecision } = routeDecision;
    return publicDecision;
  }

  function scheduleFanoutSupplementDelivery({
    routeDecision,
    channelAgents,
    message,
    spaceType,
    spaceId,
    parentMessageId = null,
    alreadyDeliveredAgentIds = [],
    deliveryContext = {},
  }) {
    if (typeof routeDecision?.runFanoutSupplement !== 'function') return;
    const delivered = new Set(alreadyDeliveredAgentIds.map(String));
    routeDecision.runFanoutSupplement().then(async (supplement) => {
      const targetAgents = (supplement?.targetAgentIds || [])
        .map((id) => channelAgents.find((agent) => agent.id === id))
        .filter(Boolean)
        .filter(agentAvailableForAutoWork)
        .filter((agent) => !delivered.has(agent.id));
      for (const agent of targetAgents) {
        delivered.add(agent.id);
        deliverMessageToAgent(agent, spaceType, spaceId, message, { parentMessageId, ...deliveryContext }).catch(err => {
          addSystemEvent('delivery_error', `Failed to deliver LLM supplement to ${agent.name}: ${err.message}`, {
            agentId: agent.id,
            messageId: message.id,
            parentMessageId,
            routeEventId: supplement?.routeEvent?.id || null,
          });
        });
      }
      await persistState();
      broadcastState();
    }).catch(async (err) => {
      addSystemEvent('fanout_api_supplement_delivery_error', `LLM supplement delivery failed: ${err.message}`, {
        messageId: message?.id || null,
        parentMessageId,
      });
      await persistState().catch(() => {});
      broadcastState();
    });
  }

  function uniqueAgents(agents) {
    const seen = new Set();
    return (agents || []).filter((agent) => {
      if (!agent || seen.has(agent.id)) return false;
      seen.add(agent.id);
      return true;
    });
  }

  function dmAgent(spaceId) {
    const dm = state.dms.find(d => d.id === spaceId);
    const agentId = dm?.participantIds?.find(id => id.startsWith('agt_'));
    return agentId ? findAgent(agentId) : null;
  }

  function memoryTargetsForConversation({ spaceType, spaceId, respondingAgents = [], mentions = {}, parentMessage = null }) {
    const mentionedAgents = (mentions.agents || []).map((id) => findAgent(id)).filter(Boolean);
    if (respondingAgents.length || mentionedAgents.length) return uniqueAgents([...respondingAgents, ...mentionedAgents]);
    if (spaceType === 'dm') return uniqueAgents([dmAgent(spaceId)]);
    const parentAgent = parentMessage?.authorType === 'agent' ? findAgent(parentMessage.authorId) : null;
    if (parentAgent) return [parentAgent];
    const channel = findChannel(spaceId);
    return channel ? channelAgentIds(channel).map((id) => findAgent(id)).filter(Boolean) : [];
  }

  function scheduleMessageMemoryWritebacks({ record, text, spaceType, spaceId, respondingAgents = [], mentions = {}, parentMessage = null }) {
    if (!record || record.authorType !== 'human') return;
    const memory = inferAgentMemoryWriteback(text);
    const explicitMemory = agentMemoryWriteIntent(text);
    if (!memory && !userPreferenceIntent(text)) return;
    const targets = memoryTargetsForConversation({
      spaceType,
      spaceId,
      respondingAgents,
      mentions,
      parentMessage,
    });
    const trigger = memory
      ? (explicitMemory ? 'explicit_user_memory' : 'user_preference')
      : 'user_preference';
    for (const agent of targets) {
      scheduleAgentMemoryWriteback(agent, trigger, {
        message: record,
        spaceType,
        spaceId,
        parentMessageId: parentMessage?.id || null,
        memory,
      });
    }
  }

  function compactPeerMemoryResult(item) {
    return {
      agentId: item.agentId,
      agentName: item.agentName,
      agentDescription: item.agentDescription || '',
      path: item.path,
      line: item.line,
      score: Number(item.score || 0),
      matchedTerms: Array.isArray(item.matchedTerms) ? item.matchedTerms.slice(0, 8) : [],
      preview: String(item.preview || '').slice(0, 280),
    };
  }

  function appendRouteEvidence(routeDecision, evidence) {
    if (!routeDecision || !evidence) return;
    routeDecision.evidence = Array.isArray(routeDecision.evidence) ? routeDecision.evidence : [];
    routeDecision.evidence.push(evidence);
    if (routeDecision.routeEvent) {
      routeDecision.routeEvent.evidence = Array.isArray(routeDecision.routeEvent.evidence) ? routeDecision.routeEvent.evidence : [];
      if (routeDecision.routeEvent.evidence !== routeDecision.evidence) {
        routeDecision.routeEvent.evidence.push(evidence);
      }
    }
  }

  async function buildPeerMemorySearchContext({
    text,
    message,
    routeDecision = null,
    parentMessageId = null,
  }) {
    if (!agentCapabilityQuestionIntent(text) || typeof searchAgentMemory !== 'function') return null;
    const reason = 'This message asks which agent is best suited, so agent memory and notes must be searched before recommending an agent.';
    let search = null;
    try {
      search = await searchAgentMemory(text, {
        limit: 12,
        purpose: 'agent_discovery',
        excludePaths: ['notes/work-log.md', 'notes/agents.md'],
      });
    } catch (error) {
      addSystemEvent('agent_peer_memory_search_error', `Peer memory search failed: ${error.message}`, {
        messageId: message?.id || null,
        parentMessageId,
        query: text,
        error: error.message,
      });
      appendRouteEvidence(routeDecision, { type: 'peer_memory_search_error', value: String(error.message || error).slice(0, 240) });
      return {
        required: true,
        ok: false,
        query: text,
        reason,
        results: [],
        error: error.message,
      };
    }
    const results = (search?.results || []).map(compactPeerMemoryResult);
    addSystemEvent('agent_peer_memory_search', 'Peer memory searched for agent capability question.', {
      messageId: message?.id || null,
      parentMessageId,
      routeEventId: routeDecision?.routeEvent?.id || null,
      query: search?.query || text,
      terms: search?.terms || [],
      resultCount: results.length,
      topResults: results.slice(0, 5).map((item) => ({
        agentId: item.agentId,
        agentName: item.agentName,
        path: item.path,
        line: item.line,
        score: item.score,
        matchedTerms: item.matchedTerms,
      })),
    });
    appendRouteEvidence(routeDecision, {
      type: 'peer_memory_search',
      value: results.length
        ? `${results.length} match(es): ${results.slice(0, 3).map((item) => `${item.agentName} ${item.path}:${item.line}`).join('; ')}`
        : '0 matches',
    });
    return {
      required: true,
      ok: Boolean(search?.ok),
      query: search?.query || text,
      terms: search?.terms || [],
      reason,
      results,
      truncated: Boolean(search?.truncated),
    };
  }

  const messageMatch = url.pathname.match(/^\/api\/spaces\/(channel|dm)\/([^/]+)\/messages$/);
  if (req.method === 'POST' && messageMatch) {
    const body = await readJson(req);
    const [, spaceType, spaceId] = messageMatch;
    const targetExists = spaceType === 'channel'
      ? state.channels.some((channel) => channel.id === spaceId)
      : state.dms.some((dm) => dm.id === spaceId);
    if (!targetExists) {
      sendError(res, 404, 'Conversation not found.');
      return true;
    }
    const text = String(body.body || '').trim();
    const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds.map(String) : [];
    if (!text && !attachmentIds.length) {
      sendError(res, 400, 'Message body or attachment is required.');
      return true;
    }
    const mentions = extractMentions(text);
    const message = normalizeConversationRecord({
      id: makeId('msg'),
      spaceType,
      spaceId,
      authorType: body.authorType === 'agent' ? 'agent' : 'human',
      authorId: String(body.authorId || 'hum_local'),
      body: text,
      attachmentIds,
      mentionedAgentIds: mentions.agents,
      mentionedHumanIds: mentions.humans,
      readBy: body.authorType === 'agent' ? [] : ['hum_local'],
      replyCount: 0,
      savedBy: [],
      createdAt: now(),
      updatedAt: now(),
    });
    applyMentions(message, mentions);
    state.messages.push(message);

    let task = null;
    if (body.asTask) {
      task = createTaskFromMessage(message, body.taskTitle || text);
      message.taskId = task.id;
    }

    let respondingAgents = [];
    let routeDecision = null;
    if (message.authorType === 'human' && spaceType === 'channel') {
      const channel = findChannel(spaceId);
      if (channel) {
        const channelAgents = channelAgentIds(channel)
          .map(id => findAgent(id))
          .filter(Boolean);
        routeDecision = await routeMessageForChannel({
          channelAgents,
          mentions,
          message,
          spaceId,
        });
        respondingAgents = routeDecision.targetAgentIds
          .map((id) => channelAgents.find((agent) => agent.id === id))
          .filter(Boolean);
        const claimant = routeDecision.claimantAgentId
          ? channelAgents.find((agent) => agent.id === routeDecision.claimantAgentId)
          : null;
        if (claimant && routeDecision.mode === 'task_claim' && routeDecision.taskIntent) {
          task = createOrClaimTaskForMessage(message, claimant, {
            title: body.taskTitle || routeDecision.taskIntent.title || text,
            createdBy: message.authorId,
          });
          message.taskId = task.id;
        }
      }
    }

    const peerMemorySearch = await buildPeerMemorySearchContext({
      text,
      message,
      routeDecision,
    });
    const deliveryContext = peerMemorySearch ? { peerMemorySearch } : {};

    addCollabEvent('message_sent', 'Message sent.', { messageId: message.id, spaceType, spaceId });
    await persistState();
    broadcastState();

    // Delivery happens after the message is durably stored so a background
    // Agent turn can always read the source record and thread context.
    if (message.authorType === 'human') {
      if (spaceType === 'dm') {
        const dm = state.dms.find(d => d.id === spaceId);
        if (dm) {
          const agentId = dm.participantIds.find(id => id.startsWith('agt_'));
          const agent = agentId ? findAgent(agentId) : null;
          if (agent) {
            deliverMessageToAgent(agent, spaceType, spaceId, message, deliveryContext).catch(err => {
              addSystemEvent('delivery_error', `Failed to deliver to ${agent.name}: ${err.message}`, { agentId });
            });
          }
        }
      } else if (spaceType === 'channel') {
        for (const agent of respondingAgents) {
          deliverMessageToAgent(agent, spaceType, spaceId, message, deliveryContext).catch(err => {
            addSystemEvent('delivery_error', `Failed to deliver to ${agent.name}: ${err.message}`, { agentId: agent.id });
          });
        }
        scheduleFanoutSupplementDelivery({
          routeDecision,
          channelAgents: channelAgentIds(findChannel(spaceId)).map((id) => findAgent(id)).filter(Boolean),
          message,
          spaceType,
          spaceId,
          alreadyDeliveredAgentIds: respondingAgents.map((agent) => agent.id),
          deliveryContext,
        });
      }
    }

    scheduleMessageMemoryWritebacks({
      record: message,
      text,
      spaceType,
      spaceId,
      respondingAgents,
      mentions,
    });
    if (routeDecision?.targetAgentIds?.length > 1 && (agentCapabilityQuestionIntent(text) || availabilityFollowupIntent(text))) {
      for (const agent of respondingAgents) {
        scheduleAgentMemoryWriteback(agent, 'multi_agent_collaboration', {
          message,
          spaceType,
          spaceId,
          routeEvent: routeDecision.routeEvent,
          peerAgentIds: routeDecision.targetAgentIds.filter((id) => id !== agent.id),
        });
      }
    }

    sendJson(res, 201, { message, task, route: publicRouteDecision(routeDecision) });
    return true;
  }

  const replyMatch = url.pathname.match(/^\/api\/messages\/([^/]+)\/replies$/);
  if (req.method === 'POST' && replyMatch) {
    const message = findMessage(replyMatch[1]);
    if (!message) {
      sendError(res, 404, 'Message not found.');
      return true;
    }
    const body = await readJson(req);
    if (body.asTask) {
      sendError(res, 400, 'Thread replies cannot become tasks. Create a new top-level task message instead.');
      return true;
    }
    const text = String(body.body || '').trim();
    const attachmentIds = Array.isArray(body.attachmentIds) ? body.attachmentIds.map(String) : [];
    if (!text && !attachmentIds.length) {
      sendError(res, 400, 'Reply body or attachment is required.');
      return true;
    }
    const mentions = extractMentions(text);
    const reply = normalizeConversationRecord({
      id: makeId('rep'),
      parentMessageId: message.id,
      spaceType: message.spaceType,
      spaceId: message.spaceId,
      authorType: body.authorType === 'agent' ? 'agent' : 'human',
      authorId: String(body.authorId || 'hum_local'),
      body: text,
      attachmentIds,
      mentionedAgentIds: mentions.agents,
      mentionedHumanIds: mentions.humans,
      readBy: body.authorType === 'agent' ? [] : ['hum_local'],
      createdAt: now(),
      updatedAt: now(),
    });
    applyMentions(reply, mentions);
    state.replies.push(reply);
    message.replyCount = state.replies.filter((item) => item.parentMessageId === message.id).length;
    message.updatedAt = now();
    addCollabEvent('thread_reply', 'Thread reply added.', { messageId: message.id, replyId: reply.id });
    const linkedTask = findTaskForThreadMessage(message);
    let createdThreadTask = null;
    let createdThreadTaskMessage = null;
    let endedThreadTask = null;
    let stoppedThreadTask = null;
    let stopResult = null;
    let routeDecision = null;
    let threadChannelAgents = [];
    if (reply.authorType === 'human' && linkedTask && taskStopIntent(text)) {
      stopResult = stopTaskFromThread(linkedTask, reply.authorId, reply.id);
      stoppedThreadTask = linkedTask;
      addSystemReply(message.id, 'Task marked done from thread stop request.');
    } else if (reply.authorType === 'human' && linkedTask && taskEndIntent(text)) {
      finishTaskFromThread(linkedTask, reply.authorId, reply.id);
      endedThreadTask = linkedTask;
      addSystemReply(message.id, 'Task marked done from thread request.');
    }
    if (reply.authorType === 'human' && message.spaceType === 'channel' && taskCreationIntent(text)) {
      const channel = findChannel(message.spaceId);
      const channelAgents = channel
        ? channelAgentIds(channel).map(id => findAgent(id)).filter(Boolean)
        : [];
      const preferredAgentIds = [
        ...(mentions.agents || []),
        ...(linkedTask?.claimedBy ? [linkedTask.claimedBy] : []),
        ...(linkedTask?.assigneeIds || []),
        ...(message.mentionedAgentIds || []),
      ];
      const agent = pickAvailableAgent(channelAgents, preferredAgentIds);
      if (agent) {
        const created = createTaskFromThreadIntent(message, reply, agent);
        createdThreadTask = created.task;
        createdThreadTaskMessage = created.message;
      }
    }
    await persistState();
    broadcastState();

    if (createdThreadTask && createdThreadTaskMessage) {
      const taskAgent = findAgent(createdThreadTask.claimedBy || createdThreadTask.assigneeId);
      if (taskAgent) {
        const taskDeliveryMessage = taskThreadDeliveryMessage(createdThreadTask, createdThreadTaskMessage, reply, taskAgent);
        deliverMessageToAgent(taskAgent, message.spaceType, message.spaceId, taskDeliveryMessage, { parentMessageId: createdThreadTaskMessage.id }).catch(err => {
          addSystemEvent('delivery_error', `Failed to deliver created task to ${taskAgent.name}: ${err.message}`, {
            agentId: taskAgent.id,
            taskId: createdThreadTask.id,
            messageId: createdThreadTaskMessage.id,
          });
        });
      }
    }

    if (reply.authorType === 'human' && !createdThreadTask && !endedThreadTask && !stoppedThreadTask) {
      const channel = message.spaceType === 'channel' ? findChannel(message.spaceId) : null;
      const channelAgents = channel
        ? channelAgentIds(channel).map(id => findAgent(id)).filter(Boolean)
        : [];
      threadChannelAgents = channelAgents;
      let respondingAgents = [];
      if (message.spaceType === 'channel') {
        routeDecision = await routeThreadReplyForChannel({
          channelAgents,
          mentions,
          parentMessage: message,
          reply,
          linkedTask,
          spaceId: message.spaceId,
        });
        respondingAgents = routeDecision.targetAgentIds
          .map((id) => channelAgents.find((agent) => agent.id === id))
          .filter(Boolean);
      }
      const peerMemorySearch = await buildPeerMemorySearchContext({
        text,
        message: reply,
        routeDecision,
        parentMessageId: message.id,
      });
      const deliveryContext = peerMemorySearch ? { peerMemorySearch } : {};
      if (message.spaceType === 'dm') {
        const dm = state.dms.find((item) => item.id === message.spaceId);
        const agentId = dm?.participantIds?.find((id) => id.startsWith('agt_'));
        const agent = agentId ? findAgent(agentId) : null;
        respondingAgents = agent && agentAvailableForAutoWork(agent) ? [agent] : [];
      }
      for (const agent of respondingAgents) {
        deliverMessageToAgent(agent, message.spaceType, message.spaceId, reply, { parentMessageId: message.id, ...deliveryContext }).catch(err => {
          addSystemEvent('delivery_error', `Failed to deliver thread reply to ${agent.name}: ${err.message}`, { agentId: agent.id, replyId: reply.id, parentMessageId: message.id });
        });
      }
      scheduleFanoutSupplementDelivery({
        routeDecision,
        channelAgents: threadChannelAgents,
        message: reply,
        spaceType: message.spaceType,
        spaceId: message.spaceId,
        parentMessageId: message.id,
        alreadyDeliveredAgentIds: respondingAgents.map((agent) => agent.id),
        deliveryContext,
      });
      scheduleMessageMemoryWritebacks({
        record: reply,
        text,
        spaceType: message.spaceType,
        spaceId: message.spaceId,
        respondingAgents,
        mentions,
        parentMessage: message,
      });
    }

    if (routeDecision) {
      await persistState();
      broadcastState();
    }

    sendJson(res, 201, {
      reply,
      createdTask: createdThreadTask,
      createdTaskMessage: createdThreadTaskMessage,
      endedTask: endedThreadTask,
      stoppedTask: stoppedThreadTask,
      stopResult,
      route: publicRouteDecision(routeDecision),
    });
    return true;
  }

  const saveMatch = url.pathname.match(/^\/api\/messages\/([^/]+)\/save$/);
  if (req.method === 'POST' && saveMatch) {
    const message = findConversationRecord(saveMatch[1]);
    if (!message) {
      sendError(res, 404, 'Message not found.');
      return true;
    }
    const userId = 'hum_local';
    message.savedBy = Array.isArray(message.savedBy) ? message.savedBy : [];
    if (message.savedBy.includes(userId)) {
      message.savedBy = message.savedBy.filter((id) => id !== userId);
    } else {
      message.savedBy.push(userId);
    }
    message.updatedAt = now();
    await persistState();
    broadcastState();
    sendJson(res, 200, { message });
    return true;
  }

  const taskFromMessageMatch = url.pathname.match(/^\/api\/messages\/([^/]+)\/task$/);
  if (req.method === 'POST' && taskFromMessageMatch) {
    const message = findMessage(taskFromMessageMatch[1]);
    if (!message) {
      sendError(res, 404, 'Message not found.');
      return true;
    }
    const body = await readJson(req);
    normalizeConversationRecord(message);
    const task = createTaskFromMessage(message, body.title || message.body);
    message.taskId = task.id;
    await persistState();
    broadcastState();
    sendJson(res, 201, { task });
    return true;
  }

  return false;
}
