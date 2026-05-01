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
    makeId,
    normalizeConversationRecord,
    now,
    persistState,
    pickAvailableAgent,
    readJson,
    routeMessageForChannel,
    routeThreadReplyForChannel,
    scheduleAgentMemoryWriteback,
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
            deliverMessageToAgent(agent, spaceType, spaceId, message).catch(err => {
              addSystemEvent('delivery_error', `Failed to deliver to ${agent.name}: ${err.message}`, { agentId });
            });
          }
        }
      } else if (spaceType === 'channel') {
        for (const agent of respondingAgents) {
          deliverMessageToAgent(agent, spaceType, spaceId, message).catch(err => {
            addSystemEvent('delivery_error', `Failed to deliver to ${agent.name}: ${err.message}`, { agentId: agent.id });
          });
        }
      }
    }

    if (message.authorType === 'human' && userPreferenceIntent(text)) {
      const memoryTargets = respondingAgents.length
        ? respondingAgents
        : (spaceType === 'channel'
          ? channelAgentIds(findChannel(spaceId)).map((id) => findAgent(id)).filter(Boolean)
          : []);
      for (const agent of memoryTargets) {
        scheduleAgentMemoryWriteback(agent, 'user_preference', { message, spaceType, spaceId });
      }
    }
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

    sendJson(res, 201, { message, task, route: routeDecision });
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
      if (message.spaceType === 'dm') {
        const dm = state.dms.find((item) => item.id === message.spaceId);
        const agentId = dm?.participantIds?.find((id) => id.startsWith('agt_'));
        const agent = agentId ? findAgent(agentId) : null;
        respondingAgents = agent && agentAvailableForAutoWork(agent) ? [agent] : [];
      }
      for (const agent of respondingAgents) {
        deliverMessageToAgent(agent, message.spaceType, message.spaceId, reply, { parentMessageId: message.id }).catch(err => {
          addSystemEvent('delivery_error', `Failed to deliver thread reply to ${agent.name}: ${err.message}`, { agentId: agent.id, replyId: reply.id, parentMessageId: message.id });
        });
      }
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
      route: routeDecision,
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
