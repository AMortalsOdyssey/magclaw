// Collaboration events and Agent memory writeback.
// Keep this module focused on durable notes, task history, and system replies;
// routing/runtime modules call it when work ownership or useful context changes.
import { buildFeishuExternalMemoryOperations } from './external-memory.js';

export function createCollabMemoryManager(deps) {
  const {
    addSystemEvent,
    agentCardCache,
    broadcastState,
    channelAgentIds,
    displayActor,
    findMessage,
    getState,
    makeId,
    normalizeConversationRecord,
    now,
    persistState,
    spaceDisplayName,
    submitAgentMarkdownOperation,
    taskLabel,
  } = deps;
  const state = new Proxy({}, {
    get(_target, prop) { return getState()[prop]; },
    set(_target, prop, value) { getState()[prop] = value; return true; },
  });
  function normalizeName(value, fallback) {
    return String(value || fallback || '')
      .trim()
      .replace(/^#/, '')
      .replace(/\s+/g, '-')
      .toLowerCase()
      .slice(0, 48);
  }
  
  function addCollabEvent(type, message, extra = {}) {
    addSystemEvent(type, message, extra);
  }
  
  function addTaskHistory(task, type, message, actorId = 'hum_local', extra = {}) {
    task.history = Array.isArray(task.history) ? task.history : [];
    const item = {
      id: makeId('hist'),
      type,
      message,
      actorId,
      createdAt: now(),
      ...extra,
    };
    task.history.push(item);
    task.updatedAt = now();
    return item;
  }
  
  function memoryEventTitle(trigger, payload = {}) {
    if (payload.task) return `${trigger}: ${taskLabel(payload.task)} ${payload.task.title || ''}`.trim();
    if (payload.channel) return `${trigger}: #${payload.channel.name}`;
    if (payload.message) return `${trigger}: ${String(payload.message.body || '').slice(0, 90)}`;
    return trigger;
  }
  
  function markdownBulletText(value) {
    return String(value || '')
      .replace(/\r?\n+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 260);
  }

  function memoryKindLabel(kind) {
    if (kind === 'capability') return 'capability';
    if (kind === 'communication_style') return 'communication_style';
    if (kind === 'preference') return 'preference';
    return 'memory';
  }

  async function appendAgentMemoryNote(agent, relPath, heading, bullet, maxItems = 10) {
    if (typeof submitAgentMarkdownOperation !== 'function') {
      throw new Error('Markdown operation applier is not configured.');
    }
    await submitAgentMarkdownOperation(agent, {
      type: 'upsert_bullet',
      target: { relPath, heading },
      text: bullet,
      maxItems,
    }, {
      sourceTrigger: 'agent_memory_note',
    });
  }
  
  async function updateAgentMemoryEntrypoint(agent, bullet) {
    await appendAgentMemoryNote(agent, 'MEMORY.md', 'Recent Work', bullet, 8);
  }

  async function updateAgentMemorySection(agent, heading, bullet, maxItems = 10) {
    await appendAgentMemoryNote(agent, 'MEMORY.md', heading, bullet, maxItems);
  }

  async function writeExplicitAgentMemory(agent, memory) {
    const kind = memoryKindLabel(memory?.kind);
    const summary = markdownBulletText(memory?.summary || memory?.sourceText);
    if (!summary) return;
    const stamp = now();
    const source = markdownBulletText(memory?.sourceText);
    const detail = source && source !== summary
      ? `- ${stamp} [${kind}] ${summary} source="${source}"`
      : `- ${stamp} [${kind}] ${summary}`;

    if (kind === 'capability') {
      const capability = summary.startsWith('擅长') || summary.startsWith('专长')
        ? summary
        : summary.replace(/^(你|you)\s*/i, '').trim();
      await updateAgentMemorySection(agent, 'Capabilities', `- ${capability}`, 12);
      await appendAgentMemoryNote(agent, 'notes/profile.md', 'Strengths And Skills', `- ${capability}`);
      return;
    }

    if (kind === 'communication_style') {
      await updateAgentMemorySection(agent, 'Key Knowledge', '- `notes/communication-style.md` - 用户指定的语气、表达风格和适配规则。', 12);
      await appendAgentMemoryNote(agent, 'notes/communication-style.md', 'Style Adaptations', detail);
      return;
    }

    await updateAgentMemorySection(agent, 'Key Knowledge', '- `notes/user-preferences.md` - 长期用户偏好和明确要求的默认做法。', 12);
    await appendAgentMemoryNote(agent, 'notes/user-preferences.md', 'User Preferences', detail);
  }

  async function writeFeishuExternalMemory(agent, trigger, payload = {}) {
    const operations = buildFeishuExternalMemoryOperations({ trigger, payload, now });
    if (!operations.length) return false;
    for (const operation of operations) {
      await submitAgentMarkdownOperation(agent, operation, {
        sourceTrigger: 'feishu_external_memory',
        metadata: {
          trigger,
          traceId: payload.message?.metadata?.origin?.traceId
            || payload.message?.metadata?.externalImport?.traceId
            || payload.externalImport?.traceId
            || null,
          messageId: payload.message?.id || null,
          taskId: payload.task?.id || null,
        },
      });
    }
    return true;
  }
  
  function memoryWritebackBullet(trigger, payload = {}) {
    const stamp = now();
    if (payload.memory) {
      const kind = memoryKindLabel(payload.memory.kind);
      return `- ${stamp} [${trigger}] kind=${kind} ${markdownBulletText(payload.memory.summary || payload.memory.sourceText)}`;
    }
    if (payload.task) {
      const task = payload.task;
      if (trigger === 'task_collaboration') {
        const peers = payload.peerAgentIds?.map(displayActor).join(', ') || 'none';
        return `- ${stamp} [${trigger}] ${taskLabel(task)} ${markdownBulletText(task.title)} role=${payload.role || 'participant'} peers=${markdownBulletText(peers)} pattern=read-prior-thread-replies-and-add-new-value`;
      }
      return `- ${stamp} [${trigger}] ${taskLabel(task)} ${markdownBulletText(task.title)} status=${task.status || 'todo'} channel=${spaceDisplayName(task.spaceType, task.spaceId)}`;
    }
    if (payload.channel) {
      const channel = payload.channel;
      const members = channelAgentIds(channel).map((id) => displayActor(id)).join(', ') || 'no agent members';
      return `- ${stamp} [${trigger}] #${channel.name} members=${markdownBulletText(members)} description=${markdownBulletText(channel.description || 'none')}`;
    }
    if (payload.message) {
      return `- ${stamp} [${trigger}] ${spaceDisplayName(payload.spaceType || payload.message.spaceType, payload.spaceId || payload.message.spaceId)} ${markdownBulletText(payload.message.body)}`;
    }
    if (payload.routeEvent) {
      return `- ${stamp} [${trigger}] route=${payload.routeEvent.mode} targets=${payload.routeEvent.targetAgentIds?.map(displayActor).join(', ') || 'none'} reason=${markdownBulletText(payload.routeEvent.reason)}`;
    }
    return `- ${stamp} [${trigger}] ${markdownBulletText(memoryEventTitle(trigger, payload))}`;
  }

  function memoryEntrypointBullet(trigger, payload = {}) {
    if (payload.memory) {
      return `- ${memoryKindLabel(payload.memory.kind)}: ${markdownBulletText(payload.memory.summary || payload.memory.sourceText).slice(0, 60)}`;
    }
    if (payload.task) {
      const task = payload.task;
      return `- ${taskLabel(task)} ${markdownBulletText(task.title).slice(0, 40)}`;
    }
    if (payload.channel) {
      return `- #${payload.channel.name} channel context`;
    }
    if (payload.routeEvent) {
      const targets = payload.routeEvent.targetAgentIds?.map(displayActor).join(', ') || 'none';
      return `- ${payload.routeEvent.mode} route: ${markdownBulletText(targets).slice(0, 40)}`;
    }
    if (payload.message) {
      return `- ${markdownBulletText(payload.message.body).slice(0, 40)}`;
    }
    return `- ${markdownBulletText(memoryEventTitle(trigger, payload)).slice(0, 40)}`;
  }
  
  async function writeAgentMemoryUpdate(agent, trigger, payload = {}) {
    if (!agent) return false;
    if (payload.externalImport || payload.message?.metadata?.origin?.provider === 'feishu') {
      const changed = await writeFeishuExternalMemory(agent, trigger, payload);
      if (!changed) return false;
      addSystemEvent('agent_memory_writeback', `${agent.name} workspace memory updated for ${trigger}.`, {
        agentId: agent.id,
        trigger,
        taskId: payload.task?.id || null,
        messageId: payload.message?.id || null,
        channelId: payload.channel?.id || payload.spaceId || null,
      });
      agentCardCache.delete(agent.id);
      return true;
    }
    const bullet = memoryWritebackBullet(trigger, payload);
    await appendAgentMemoryNote(agent, 'notes/work-log.md', 'Memory Writebacks', bullet);
    if (payload.memory) {
      await writeExplicitAgentMemory(agent, payload.memory);
    } else {
      await updateAgentMemoryEntrypoint(agent, memoryEntrypointBullet(trigger, payload));
    }
    if (payload.channel) {
      await appendAgentMemoryNote(agent, 'notes/channels.md', 'Channel Memory', bullet);
    }
    if (payload.routeEvent || payload.peerAgentIds?.length) {
      await appendAgentMemoryNote(agent, 'notes/agents.md', 'Observed Collaboration', bullet);
    }
    addSystemEvent('agent_memory_writeback', `${agent.name} workspace memory updated for ${trigger}.`, {
      agentId: agent.id,
      trigger,
      taskId: payload.task?.id || null,
      messageId: payload.message?.id || null,
      channelId: payload.channel?.id || payload.spaceId || null,
    });
    agentCardCache.delete(agent.id);
    return true;
  }
  
  function scheduleAgentMemoryWriteback(agent, trigger, payload = {}) {
    if (!agent) return Promise.resolve(false);
    return Promise.resolve()
      .then(() => writeAgentMemoryUpdate(agent, trigger, payload))
      .then(async (changed) => {
        if (changed) {
          await persistState();
          broadcastState();
        }
        return Boolean(changed);
      })
      .catch(async (error) => {
        addSystemEvent('agent_memory_writeback_error', `Memory writeback failed for ${agent.name}: ${error.message}`, {
          agentId: agent.id,
          trigger,
        });
        await persistState().then(broadcastState).catch(() => {});
        return false;
      });
  }
  
  function addSystemReply(parentMessageId, body, extra = {}) {
    const parent = findMessage(parentMessageId);
    if (!parent) return null;
    const reply = normalizeConversationRecord({
      id: makeId('rep'),
      workspaceId: parent.workspaceId || state.connection?.workspaceId || 'local',
      parentMessageId,
      spaceType: parent.spaceType,
      spaceId: parent.spaceId,
      authorType: 'system',
      authorId: 'system',
      body,
      attachmentIds: [],
      createdAt: now(),
      updatedAt: now(),
      ...extra,
    });
    state.replies.push(reply);
    parent.replyCount = Math.max(
      Number(parent.replyCount || 0) + 1,
      state.replies.filter((item) => item.parentMessageId === parentMessageId).length,
    );
    parent.updatedAt = now();
    return reply;
  }

  return {
    addCollabEvent,
    addSystemReply,
    addTaskHistory,
    normalizeName,
    scheduleAgentMemoryWriteback,
    writeAgentMemoryUpdate,
  };
}
