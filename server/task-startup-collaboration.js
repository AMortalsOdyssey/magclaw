export const TASK_STARTUP_MAX_PARTICIPANTS = 4;
export const TASK_STARTUP_WAIT_TIMEOUT_MS = 90_000;

function compactErrorMessage(error) {
  return String(error?.message || error || 'Unknown error').slice(0, 240);
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

export function createTaskStartupCollaboration(deps) {
  const {
    addSystemEvent = () => {},
    addTaskHistory = () => {},
    broadcastState = () => {},
    claimTask,
    deliverMessageToAgent,
    displayActor = (id) => id,
    findAgent,
    getState,
    normalizeIds = (ids) => [...new Set(safeArray(ids).filter(Boolean).map(String))],
    now = () => new Date().toISOString(),
    persistState = async () => {},
    routeTaskAssignees,
    scheduleAgentMemoryWriteback = () => Promise.resolve(false),
    taskAssignmentDeliveryMessage,
    taskLabel = (task) => `#${task?.number || task?.id || '?'}`,
    taskStartupWaitMs = TASK_STARTUP_WAIT_TIMEOUT_MS,
  } = deps;

  function workspaceIdForTask(task, message = null) {
    return String(
      task?.workspaceId
      || message?.workspaceId
      || getState?.()?.connection?.workspaceId
      || getState?.()?.cloud?.workspace?.id
      || '',
    ).trim();
  }

  async function persistTaskStartup(task, message, reason = 'task_startup_collaboration') {
    try {
      const workspaceId = workspaceIdForTask(task, message);
      await persistState(workspaceId ? { workspaceId, reason } : { reason });
      broadcastState();
    } catch (error) {
      addSystemEvent('task_startup_persist_error', `Could not persist ${taskLabel(task)} startup collaboration: ${compactErrorMessage(error)}`, {
        taskId: task?.id || null,
        messageId: message?.id || null,
      });
    }
  }

  function workItemById(id) {
    return safeArray(getState?.()?.workItems).find((item) => item.id === id) || null;
  }

  function currentWorkItemStatus(workItem) {
    if (!workItem) return '';
    const fresh = workItem.id ? workItemById(workItem.id) : null;
    return String(firstDefined(fresh?.status, workItem.status, '') || '');
  }

  async function waitForWorkItem(workItem, timeoutMs) {
    if (!workItem) return { status: 'missing_work_item' };
    const started = Date.now();
    const pollMs = Math.min(1000, Math.max(5, Math.floor(timeoutMs / 12) || 5));
    while (Date.now() - started < timeoutMs) {
      const status = currentWorkItemStatus(workItem);
      if (status === 'responded' || status === 'stopped') return { status };
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    return { status: 'timeout' };
  }

  function writeStartupMemory(agent, task, role, participantIds, routeEvent = null) {
    if (!agent) return;
    scheduleAgentMemoryWriteback(agent, 'task_collaboration', {
      task,
      role,
      peerAgentIds: participantIds.filter((id) => id !== agent.id),
      routeEvent,
    }).catch(() => {});
  }

  function ensureStartupMetadata(task, data) {
    task.metadata = { ...(task.metadata || {}) };
    task.metadata.startupCollaboration = {
      ...(task.metadata.startupCollaboration || {}),
      ...data,
      updatedAt: now(),
    };
    return task.metadata.startupCollaboration;
  }

  function normalizeRouteParticipants(route, ownerAgent, selectedIds, maxParticipants) {
    const routeCollaboratorIds = normalizeIds(route?.collaboratorAgentIds || [])
      .filter((id) => id !== ownerAgent.id);
    const participantIds = normalizeIds([
      ownerAgent.id,
      ...routeCollaboratorIds,
    ]).slice(0, maxParticipants);
    const collaboratorIds = participantIds.filter((id) => id !== ownerAgent.id);
    const routeCappedIds = normalizeIds(route?.cappedAgentIds || []);
    const selectedNotParticipating = selectedIds.filter((id) => !participantIds.includes(id));
    const cappedAgentIds = normalizeIds([...routeCappedIds, ...selectedNotParticipating])
      .filter((id) => id !== ownerAgent.id && !collaboratorIds.includes(id));
    return { participantIds, collaboratorIds, cappedAgentIds };
  }

  async function runStartupQueue({ task, message, ownerAgent, collaboratorAgents, routeEvent, startup }) {
    if (!deliverMessageToAgent || !taskAssignmentDeliveryMessage) return;
    const recipients = [
      { agent: ownerAgent, role: 'owner' },
      ...collaboratorAgents.map((agent) => ({ agent, role: 'collaborator' })),
    ];
    const participantIds = recipients.map((item) => item.agent.id);
    for (const [index, item] of recipients.entries()) {
      const delivery = {
        agentId: item.agent.id,
        role: item.role,
        sequence: index + 1,
        status: 'dispatching',
        workItemId: null,
        deliveredAt: null,
        respondedAt: null,
        timedOutAt: null,
      };
      startup.deliveries.push(delivery);
      startup.updatedAt = now();
      writeStartupMemory(item.agent, task, item.role, participantIds, routeEvent);
      let workItem = null;
      try {
        const deliveryMessage = taskAssignmentDeliveryMessage(task, message, {
          recipientAgent: item.agent,
          role: item.role,
          ownerAgent,
          collaboratorAgents,
          routeEvent,
        });
        workItem = await deliverMessageToAgent(item.agent, task.spaceType, task.spaceId, deliveryMessage, {
          parentMessageId: message.id,
        });
        delivery.workItemId = workItem?.id || null;
        delivery.status = 'delivered';
        delivery.deliveredAt = now();
        startup.updatedAt = now();
        await persistTaskStartup(task, message, 'task_startup_delivered');
      } catch (error) {
        delivery.status = 'error';
        delivery.error = compactErrorMessage(error);
        startup.updatedAt = now();
        addTaskHistory(task, 'task_startup_delivery_error', `Startup delivery to ${displayActor(item.agent.id)} failed: ${delivery.error}`, 'system', {
          agentId: item.agent.id,
          role: item.role,
          sequence: delivery.sequence,
        });
        addSystemEvent('task_startup_delivery_error', `Could not deliver ${taskLabel(task)} to ${item.agent.name || item.agent.id}: ${delivery.error}`, {
          taskId: task.id,
          messageId: message.id,
          agentId: item.agent.id,
          role: item.role,
        });
        await persistTaskStartup(task, message, 'task_startup_delivery_error');
        continue;
      }

      const waitResult = await waitForWorkItem(workItem, Number(taskStartupWaitMs || TASK_STARTUP_WAIT_TIMEOUT_MS));
      if (waitResult.status === 'responded' || waitResult.status === 'stopped') {
        delivery.status = waitResult.status;
        delivery.respondedAt = now();
      } else if (waitResult.status === 'timeout') {
        delivery.status = 'timeout';
        delivery.timedOutAt = now();
        addTaskHistory(task, 'task_startup_timeout', `Startup queue continued after waiting for ${displayActor(item.agent.id)}.`, 'system', {
          agentId: item.agent.id,
          role: item.role,
          sequence: delivery.sequence,
          timeoutMs: Number(taskStartupWaitMs || TASK_STARTUP_WAIT_TIMEOUT_MS),
        });
      } else {
        delivery.status = waitResult.status;
      }
      startup.updatedAt = now();
      await persistTaskStartup(task, message, `task_startup_${delivery.status}`);
    }
    startup.status = 'completed';
    startup.completedAt = now();
    startup.updatedAt = startup.completedAt;
    await persistTaskStartup(task, message, 'task_startup_completed');
  }

  async function startTaskStartupCollaboration(task, message, selectedAgentIds, options = {}) {
    const selectedIds = normalizeIds(selectedAgentIds || []);
    if (!selectedIds.length) return null;
    if (!findAgent || !routeTaskAssignees) return null;

    const maxParticipants = Number(options.maxParticipants || TASK_STARTUP_MAX_PARTICIPANTS);
    const selectedAgents = selectedIds
      .map((id) => findAgent(id))
      .filter(Boolean);
    let route;
    try {
      route = await routeTaskAssignees({
        task,
        message,
        selectedAgentIds: selectedIds,
        selectedAgents,
        spaceType: task.spaceType,
        spaceId: task.spaceId,
        maxParticipants,
      });
    } catch (error) {
      const fallbackReason = compactErrorMessage(error);
      addTaskHistory(task, 'task_dispatch_skipped', `Owner selection failed: ${fallbackReason}`, 'system', {
        selectedAgentIds: selectedIds,
        fallbackReason,
      });
      addSystemEvent('task_dispatch_skipped', `Task ${taskLabel(task)} was created but not dispatched because owner selection failed.`, {
        taskId: task?.id || null,
        messageId: message?.id || null,
        selectedAgentIds: selectedIds,
        fallbackReason,
      });
      return null;
    }

    const ownerId = route?.ownerAgentId || route?.claimantAgentId || null;
    const ownerAgent = ownerId ? findAgent(ownerId) : null;
    if (!ownerAgent) {
      ensureStartupMetadata(task, {
        status: 'skipped',
        selectedAgentIds: selectedIds,
        cappedAgentIds: [],
        participantAgentIds: [],
        ownerAgentId: null,
        collaboratorAgentIds: [],
        routeEventId: route?.routeEvent?.id || null,
        routingStrategy: route?.strategy || route?.routeEvent?.strategy || 'none',
        fallbackReason: route?.fallbackReason || route?.routeEvent?.fallbackReason || 'No selected agents are available.',
      });
      addTaskHistory(task, 'task_dispatch_skipped', 'No selected agent could be selected as Owner.', 'system', {
        selectedAgentIds: selectedIds,
        routeEventId: route?.routeEvent?.id || null,
        routingStrategy: route?.strategy || route?.routeEvent?.strategy || 'none',
        fallbackReason: route?.fallbackReason || route?.routeEvent?.fallbackReason || 'No selected agents are available.',
      });
      addSystemEvent('task_dispatch_skipped', `Task ${taskLabel(task)} stayed Todo because no selected agent is available to own it.`, {
        taskId: task.id,
        messageId: message.id,
        selectedAgentIds: selectedIds,
        routeEventId: route?.routeEvent?.id || null,
        routingStrategy: route?.strategy || route?.routeEvent?.strategy || 'none',
        fallbackReason: route?.fallbackReason || route?.routeEvent?.fallbackReason || null,
      });
      return { route, ownerAgent: null };
    }

    const { participantIds, collaboratorIds, cappedAgentIds } = normalizeRouteParticipants(route, ownerAgent, selectedIds, maxParticipants);
    const collaboratorAgents = collaboratorIds
      .map((id) => findAgent(id))
      .filter(Boolean);
    claimTask(task, ownerAgent.id, { force: true });
    task.assigneeIds = collaboratorIds;
    task.assigneeId = collaboratorIds[0] || null;
    task.updatedAt = now();

    const startup = ensureStartupMetadata(task, {
      status: 'running',
      startedAt: now(),
      completedAt: null,
      maxParticipants,
      selectedAgentIds: selectedIds,
      cappedAgentIds,
      participantAgentIds: participantIds,
      ownerAgentId: ownerAgent.id,
      collaboratorAgentIds: collaboratorIds,
      deliveries: [],
      routeEventId: route?.routeEvent?.id || null,
      routingStrategy: route?.strategy || route?.routeEvent?.strategy || 'rules',
      fallbackReason: route?.fallbackReason || route?.routeEvent?.fallbackReason || null,
    });
    addTaskHistory(task, 'task_owner_selected', `Owner selected: ${displayActor(ownerAgent.id)}.`, ownerAgent.id, {
      selectedAgentIds: selectedIds,
      cappedAgentIds,
      ownerAgentId: ownerAgent.id,
      collaboratorAgentIds: collaboratorIds,
      routeEventId: route?.routeEvent?.id || null,
      routingStrategy: route?.strategy || route?.routeEvent?.strategy || 'rules',
      fallbackReason: route?.fallbackReason || route?.routeEvent?.fallbackReason || null,
    });
    addSystemEvent('task_owner_selected', `Task ${taskLabel(task)} assigned to ${ownerAgent.name} as Owner.`, {
      taskId: task.id,
      messageId: message.id,
      selectedAgentIds: selectedIds,
      cappedAgentIds,
      ownerAgentId: ownerAgent.id,
      collaboratorAgentIds: collaboratorIds,
      routeEventId: route?.routeEvent?.id || null,
      routingStrategy: route?.strategy || route?.routeEvent?.strategy || 'rules',
      fallbackReason: route?.fallbackReason || route?.routeEvent?.fallbackReason || null,
    });

    runStartupQueue({
      task,
      message,
      ownerAgent,
      collaboratorAgents,
      routeEvent: route?.routeEvent || null,
      startup,
    }).catch(async (error) => {
      startup.status = 'error';
      startup.error = compactErrorMessage(error);
      startup.updatedAt = now();
      addSystemEvent('task_startup_queue_error', `Startup collaboration failed for ${taskLabel(task)}: ${startup.error}`, {
        taskId: task.id,
        messageId: message.id,
      });
      await persistTaskStartup(task, message, 'task_startup_queue_error');
    });

    return {
      route,
      ownerAgent,
      collaboratorAgents,
      participantAgentIds: participantIds,
      cappedAgentIds,
      startup,
    };
  }

  return { startTaskStartupCollaboration };
}
