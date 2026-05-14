import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { safePathWithin } from './path-utils.js';

// Collaboration events and Agent memory writeback.
// Keep this module focused on durable notes, task history, and system replies;
// routing/runtime modules call it when work ownership or useful context changes.
export function createCollabMemoryManager(deps) {
  const {
    addSystemEvent,
    agentCardCache,
    broadcastState,
    channelAgentIds,
    defaultAgentMemory,
    displayActor,
    ensureAgentWorkspace,
    findMessage,
    getState,
    makeId,
    normalizeConversationRecord,
    now,
    persistState,
    spaceDisplayName,
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

  const SECTION_HEADINGS = new Map([
    ['Recent Work', '近期工作'],
    ['Capabilities', '能力'],
    ['Key Knowledge', '知识索引'],
    ['Strengths And Skills', '优势与技能'],
    ['Style Adaptations', '语气适配'],
    ['User Preferences', '用户偏好'],
    ['Memory Writebacks', '记忆写入记录'],
    ['Channel Memory', '频道记忆'],
    ['Observed Collaboration', '协作观察'],
  ]);

  const SECTION_ALIASES = new Map([
    ['Recent Work', ['近期工作']],
    ['Capabilities', ['能力', 'Skills', '技能']],
    ['Key Knowledge', ['知识索引', 'Knowledge Index']],
    ['Strengths And Skills', ['优势与技能', 'Skills', '技能']],
    ['Style Adaptations', ['语气适配']],
    ['User Preferences', ['用户偏好']],
    ['Memory Writebacks', ['记忆写入记录']],
    ['Channel Memory', ['频道记忆']],
    ['Observed Collaboration', ['协作观察']],
  ]);

  function preferredSectionHeading(heading) {
    return SECTION_HEADINGS.get(heading) || heading;
  }

  function sectionHeadingAliases(heading) {
    return [heading, ...(SECTION_ALIASES.get(heading) || [])]
      .map((item) => String(item || '').trim().toLowerCase())
      .filter(Boolean);
  }

  const PLACEHOLDER_BULLETS = [
    /No recent durable work has been recorded yet/i,
    /No open work has been recorded yet/i,
    /No completed work has been recorded yet/i,
    /No durable decisions have been recorded yet/i,
    /No active task has been recorded yet/i,
    /Before a long task or context-heavy handoff/i,
    /暂无近期可复用记录/,
    /暂无经过真实任务验证的稳定能力/,
    /暂无需要跨回合延续的任务/,
    /暂无进行中的长期工作/,
    /暂无已完成的长期工作/,
    /暂无需要长期保留的决策/,
    /根据真实完成的任务补充/,
  ];
  
  function upsertMarkdownBullet(content, heading, bullet, maxItems = 10) {
    const lines = String(content || '').split(/\r?\n/);
    const preferredHeading = preferredSectionHeading(heading);
    const headingLine = `## ${preferredHeading}`;
    const aliases = sectionHeadingAliases(heading);
    let headingIndex = lines.findIndex((line) => {
      const match = line.trim().match(/^##\s+(.+?)\s*$/);
      return match && aliases.includes(match[1].trim().toLowerCase());
    });
    if (headingIndex === -1) {
      const suffix = lines.length && lines[lines.length - 1].trim() ? ['', headingLine, bullet] : [headingLine, bullet];
      return [...lines, ...suffix].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
    }
    lines[headingIndex] = headingLine;
    let endIndex = lines.length;
    for (let index = headingIndex + 1; index < lines.length; index += 1) {
      if (/^#{1,6}\s+/.test(lines[index])) {
        endIndex = index;
        break;
      }
    }
    const before = lines.slice(0, headingIndex + 1);
    const section = lines.slice(headingIndex + 1, endIndex).filter((line) => line.trim());
    const after = lines.slice(endIndex);
    const bullets = [bullet, ...section.filter((line) => line.trim() !== bullet.trim())]
      .filter((line) => line.trim().startsWith('- '))
      .filter((line) => !PLACEHOLDER_BULLETS.some((pattern) => pattern.test(line)))
      .slice(0, maxItems);
    return [...before, ...bullets, '', ...after].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
  }
  
  async function appendAgentMemoryNote(agent, relPath, heading, bullet) {
    const root = await ensureAgentWorkspace(agent);
    const filePath = safePathWithin(root, relPath);
    if (!filePath) return;
    const existing = await readFile(filePath, 'utf8').catch(() => `# ${agent.name} ${path.basename(relPath, '.md')}\n`);
    await writeFile(filePath, upsertMarkdownBullet(existing, heading, bullet));
  }
  
  async function updateAgentMemoryEntrypoint(agent, bullet) {
    const root = await ensureAgentWorkspace(agent);
    const memoryPath = safePathWithin(root, 'MEMORY.md');
    if (!memoryPath) return;
    const existing = await readFile(memoryPath, 'utf8').catch(() => defaultAgentMemory(agent));
    await writeFile(memoryPath, upsertMarkdownBullet(existing, 'Recent Work', bullet, 8));
  }

  async function updateAgentMemorySection(agent, heading, bullet, maxItems = 10) {
    const root = await ensureAgentWorkspace(agent);
    const memoryPath = safePathWithin(root, 'MEMORY.md');
    if (!memoryPath) return;
    const existing = await readFile(memoryPath, 'utf8').catch(() => defaultAgentMemory(agent));
    await writeFile(memoryPath, upsertMarkdownBullet(existing, heading, bullet, maxItems));
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
  
  function memoryWritebackBullet(trigger, payload = {}) {
    const stamp = now();
    if (payload.memory) {
      const kind = memoryKindLabel(payload.memory.kind);
      return `- ${stamp} [${trigger}] kind=${kind} ${markdownBulletText(payload.memory.summary || payload.memory.sourceText)}`;
    }
    if (payload.task) {
      const task = payload.task;
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
    if (!agent) return;
    writeAgentMemoryUpdate(agent, trigger, payload)
      .then((changed) => (changed ? persistState().then(broadcastState) : null))
      .catch((error) => {
        addSystemEvent('agent_memory_writeback_error', `Memory writeback failed for ${agent.name}: ${error.message}`, {
          agentId: agent.id,
          trigger,
        });
        persistState().then(broadcastState).catch(() => {});
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
    parent.replyCount = state.replies.filter((item) => item.parentMessageId === parentMessageId).length;
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
