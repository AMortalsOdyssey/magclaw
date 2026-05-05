// Compact context-pack builder for Agent prompts.
// Delivery code uses this to provide the current message plus bounded recent
// channel/thread/task/attachment context without dumping the entire workspace
// into every Codex turn.

const DEFAULT_LIMITS = {
  recentMessages: 12,
  threadReplies: 8,
  tasks: 8,
  attachments: 10,
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function byId(items, id) {
  return asArray(items).find((item) => item?.id === id) || null;
}

function actorById(state, id) {
  return byId(state?.agents, id) || byId(state?.humans, id) || null;
}

function actorName(state, id) {
  return actorById(state, id)?.name || (id === 'system' ? 'System' : 'Unknown');
}

function actorType(state, id) {
  if (byId(state?.agents, id)) return 'agent';
  if (byId(state?.humans, id)) return 'human';
  return id === 'system' ? 'system' : 'unknown';
}

function uniqueById(items) {
  const seen = new Set();
  const result = [];
  for (const item of asArray(items)) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function sortByCreatedAt(records) {
  return [...asArray(records)].sort((a, b) => {
    const left = new Date(a?.createdAt || 0).getTime();
    const right = new Date(b?.createdAt || 0).getTime();
    if (left !== right) return left - right;
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  });
}

function takeLast(records, limit) {
  const value = Number.isFinite(Number(limit)) ? Number(limit) : records.length;
  return records.slice(Math.max(0, records.length - value));
}

function spaceRecord(state, spaceType, spaceId) {
  if (spaceType === 'channel') return byId(state?.channels, spaceId);
  if (spaceType === 'dm') return byId(state?.dms, spaceId);
  return null;
}

function spaceName(state, spaceType, spaceId) {
  const space = spaceRecord(state, spaceType, spaceId);
  if (spaceType === 'channel') return space?.name ? `#${space.name}` : '#channel';
  if (spaceType === 'dm') return space?.name ? `dm:${space.name}` : 'DM';
  return `${spaceType || 'space'}:${spaceId || ''}`;
}

function participantIdsForSpace(state, spaceType, spaceId) {
  const space = spaceRecord(state, spaceType, spaceId);
  if (!space) return [];
  if (spaceType === 'channel') {
    return [
      ...asArray(space.memberIds),
      ...asArray(space.humanIds),
      ...asArray(space.agentIds),
    ];
  }
  if (spaceType === 'dm') return asArray(space.participantIds);
  return [];
}

function participantsForSpace(state, spaceType, spaceId) {
  return uniqueById(
    participantIdsForSpace(state, spaceType, spaceId)
      .map((id) => actorById(state, id))
      .filter(Boolean),
  ).map((actor) => ({
    id: actor.id,
    name: actor.name,
    type: actorType(state, actor.id),
    role: actor.role || actor.description || actor.runtime || '',
    status: actor.status || '',
  }));
}

function sanitizeRecord(record) {
  if (!record) return null;
  return {
    id: record.id,
    parentMessageId: record.parentMessageId || null,
    spaceType: record.spaceType || null,
    spaceId: record.spaceId || null,
    authorType: record.authorType || 'unknown',
    authorId: record.authorId || 'unknown',
    body: String(record.body || ''),
    attachmentIds: asArray(record.attachmentIds).map(String),
    localReferences: asArray(record.localReferences),
    taskId: record.taskId || null,
    target: record.target || null,
    workItemId: record.workItemId || null,
    replyCount: Number(record.replyCount || 0),
    createdAt: record.createdAt || '',
    updatedAt: record.updatedAt || '',
    mentionedAgentIds: asArray(record.mentionedAgentIds).map(String),
    mentionedHumanIds: asArray(record.mentionedHumanIds).map(String),
  };
}

function messageBelongsToSpace(record, spaceType, spaceId) {
  return record?.spaceType === spaceType && record?.spaceId === spaceId;
}

function recentMessagesForSpace(state, spaceType, spaceId, currentMessage, limit) {
  const records = sortByCreatedAt(asArray(state?.messages).filter((record) => messageBelongsToSpace(record, spaceType, spaceId)));
  const currentTime = currentMessage?.createdAt ? new Date(currentMessage.createdAt).getTime() : null;
  const visible = Number.isFinite(currentTime)
    ? records.filter((record) => new Date(record.createdAt || 0).getTime() <= currentTime || record.id === currentMessage.id)
    : records;
  const selected = takeLast(visible, limit);
  if (currentMessage && !selected.some((record) => record.id === currentMessage.id) && messageBelongsToSpace(currentMessage, spaceType, spaceId)) {
    selected.push(currentMessage);
  }
  return sortByCreatedAt(uniqueById(selected)).map(sanitizeRecord);
}

function threadContextFor(state, parentMessageId, currentMessage, limit) {
  const parentId = parentMessageId || currentMessage?.parentMessageId || null;
  if (!parentId) return null;
  const parent = byId(state?.messages, parentId);
  if (!parent) return null;
  const replies = sortByCreatedAt(asArray(state?.replies).filter((reply) => reply.parentMessageId === parentId));
  const selected = takeLast(replies, limit);
  if (currentMessage?.parentMessageId === parentId && !selected.some((record) => record.id === currentMessage.id)) {
    selected.push(currentMessage);
  }
  return {
    parentMessage: sanitizeRecord(parent),
    recentReplies: sortByCreatedAt(uniqueById(selected)).map(sanitizeRecord),
  };
}

function taskMatchesContext(task, { spaceType, spaceId, messageIds }) {
  if (task?.spaceType === spaceType && task?.spaceId === spaceId && task.status !== 'done') return true;
  const ids = new Set(messageIds);
  return [
    task?.messageId,
    task?.sourceMessageId,
    task?.threadMessageId,
  ].some((id) => id && ids.has(id));
}

function tasksForContext(state, spaceType, spaceId, records, limit) {
  const messageIds = asArray(records).map((record) => record?.id).filter(Boolean);
  return asArray(state?.tasks)
    .filter((task) => taskMatchesContext(task, { spaceType, spaceId, messageIds }))
    .sort((a, b) => (Number(a.number) || 0) - (Number(b.number) || 0))
    .slice(0, limit)
    .map((task) => ({
      id: task.id,
      number: task.number,
      title: String(task.title || 'Untitled task'),
      body: String(task.body || ''),
      status: String(task.status || 'todo'),
      assigneeIds: asArray(task.assigneeIds?.length ? task.assigneeIds : [task.assigneeId]).filter(Boolean),
      messageId: task.messageId || task.sourceMessageId || task.threadMessageId || '',
      threadMessageId: task.threadMessageId || '',
    }));
}

function attachmentsForContext(state, records, limit) {
  const messageByAttachment = new Map();
  for (const record of asArray(records)) {
    for (const id of asArray(record?.attachmentIds)) {
      if (!messageByAttachment.has(id)) messageByAttachment.set(id, record.id);
    }
  }
  return asArray(state?.attachments)
    .filter((attachment) => messageByAttachment.has(attachment.id))
    .slice(0, limit)
    .map((attachment) => ({
      id: attachment.id,
      name: attachment.name || attachment.filename || attachment.id,
      type: attachment.type || attachment.mime || 'file',
      bytes: Number(attachment.bytes || attachment.sizeBytes || 0),
      messageId: messageByAttachment.get(attachment.id),
    }));
}

export function buildAgentContextPack({
  state,
  agentId,
  spaceType,
  spaceId,
  currentMessage,
  parentMessageId = null,
  workItem = null,
  peerMemorySearch = null,
  toolBaseUrl = '',
  limits = {},
}) {
  const effectiveLimits = { ...DEFAULT_LIMITS, ...limits };
  const current = sanitizeRecord(currentMessage);
  const recentMessages = recentMessagesForSpace(state, spaceType, spaceId, current, effectiveLimits.recentMessages);
  const thread = threadContextFor(state, parentMessageId, current, effectiveLimits.threadReplies);
  const visibleRecords = uniqueById([
    ...recentMessages,
    current,
    thread?.parentMessage,
    ...asArray(thread?.recentReplies),
  ].filter(Boolean));
  const space = spaceRecord(state, spaceType, spaceId);

  return {
    targetAgentId: agentId,
    space: {
      type: spaceType,
      id: spaceId,
      name: space?.name || spaceName(state, spaceType, spaceId),
      label: spaceName(state, spaceType, spaceId),
      description: space?.description || '',
    },
    participants: participantsForSpace(state, spaceType, spaceId),
    currentMessage: current,
    workItem: workItem ? {
      id: workItem.id,
      target: workItem.target,
      taskId: workItem.taskId || null,
      status: workItem.status || '',
    } : null,
    recentMessages,
    thread,
    tasks: tasksForContext(state, spaceType, spaceId, visibleRecords, effectiveLimits.tasks),
    attachments: attachmentsForContext(state, visibleRecords, effectiveLimits.attachments),
    peerMemorySearch,
    historyTools: {
      baseUrl: toolBaseUrl,
      agentId,
    },
  };
}

function renderMentions(state, text) {
  return String(text || '').replace(/<@(agt_\w+|hum_\w+)>/g, (_, id) => `@${actorName(state, id)}`);
}

function renderActor(state, id) {
  return `@${actorName(state, id)}`;
}

function renderTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toISOString().replace('T', ' ').slice(0, 16);
}

function messageLine(state, record, targetAgentId) {
  const addressed = asArray(record?.mentionedAgentIds).includes(targetAgentId) ? ' mentioned you' : '';
  const refs = asArray(record?.localReferences);
  const refText = refs.length
    ? `\n  local refs: ${refs.map((ref) => `${ref.kind || 'ref'} ${ref.path || ref.absolutePath || ''}`).join('; ')}`
    : '';
  const header = [
    record?.target ? `target=${record.target}` : '',
    record?.workItemId ? `workItem=${record.workItemId}` : '',
    `msg=${record.id}`,
    record?.taskId ? `task=${record.taskId}` : '',
    `time=${renderTime(record.createdAt)}`,
    `type=${record.authorType}`,
  ].filter(Boolean).join(' ');
  return `[${header}] ${renderActor(state, record.authorId)}${addressed}: ${renderMentions(state, record.body)}${refText}`;
}

function renderParticipants(pack) {
  return asArray(pack.participants)
    .map((item) => {
      const self = item.id === pack.targetAgentId ? ' (you)' : '';
      const role = item.role ? ` - ${item.role}` : '';
      return `@${item.name}${self}${role}`;
    })
    .join(', ');
}

function renderTasks(state, tasks) {
  if (!tasks.length) return '- (none)';
  return tasks.map((task) => {
    const assignees = task.assigneeIds.length
      ? ` assignees: ${task.assigneeIds.map((id) => renderActor(state, id)).join(', ')};`
      : '';
    const msg = task.messageId ? ` msg=${task.messageId};` : '';
    return `- task #${task.number || '?'} [${task.status}] ${task.title} (${assignees}${msg} thread=${task.threadMessageId || '-'})`;
  }).join('\n');
}

function renderAttachments(attachments) {
  if (!attachments.length) return '- (none)';
  return attachments
    .map((item) => `- ${item.name} ${item.type} ${item.bytes} bytes (id=${item.id}, from msg=${item.messageId})`)
    .join('\n');
}

function renderPeerMemorySearch(search) {
  if (!search?.required && !search?.results?.length) return '';
  const lines = [
    'Peer memory search:',
    `- Required for this turn: ${search.required ? 'yes' : 'no'}`,
    search.reason ? `- Reason: ${search.reason}` : '',
    search.query ? `- Query: ${search.query}` : '',
  ].filter(Boolean);
  if (!search.results?.length) {
    lines.push('- Results: no matches. If the question asks who is best suited, call search_agent_memory with narrower keywords before answering.');
    return lines.join('\n');
  }
  lines.push('- Results:');
  for (const item of search.results) {
    const location = `${item.path || 'MEMORY.md'}:${item.line || 1}`;
    const matched = item.matchedTerms?.length ? `; matched=${item.matchedTerms.join(', ')}` : '';
    lines.push(`  - @${item.agentName} (${item.agentId}) ${location}${matched}: ${item.preview || ''}`);
  }
  lines.push('- Use these matches as grounding when recommending which agent is best suited. If they are insufficient or contradictory, call search_agent_memory/read_agent_memory before answering.');
  return lines.join('\n');
}

function renderHistoryToolHints(pack) {
  const baseUrl = pack.historyTools?.baseUrl;
  const agentId = pack.historyTools?.agentId || pack.targetAgentId;
  if (!baseUrl || !agentId) return '';
  const target = pack.thread?.parentMessage?.id
    ? `${pack.space.label}:${pack.thread.parentMessage.id}`
    : pack.space.label;
  const encodedTarget = encodeURIComponent(target);
  const currentTarget = pack.currentMessage?.target || pack.workItem?.target || target;
  const currentWorkItemId = pack.currentMessage?.workItemId || pack.workItem?.id || '';
  const hints = [
    'Progressive history tools:',
    '- The recent context above is only a compact snapshot. Do not assume it is the whole conversation.',
    `- read_history(target="${target}", limit=30): curl -s "${baseUrl}/api/agent-tools/history?agentId=${encodeURIComponent(agentId)}&target=${encodedTarget}&limit=30"`,
    `- search_message_history(query="<query>", target="${target}", limit=10): curl -s "${baseUrl}/api/agent-tools/search?agentId=${encodeURIComponent(agentId)}&target=${encodedTarget}&q=<query>&limit=10"`,
    `- search_agent_memory(query="<query>", limit=10): curl -s "${baseUrl}/api/agent-tools/memory/search?agentId=${encodeURIComponent(agentId)}&q=<query>&limit=10"`,
    `- read_agent_memory(targetAgentId="agt_xxx", path="MEMORY.md|notes/profile.md"): curl -s "${baseUrl}/api/agent-tools/memory/read?agentId=${encodeURIComponent(agentId)}&targetAgentId=agt_xxx&path=MEMORY.md"`,
  ];
  if (currentTarget && currentWorkItemId) {
    hints.push(
      `- send_message(target="${currentTarget}", workItemId="${currentWorkItemId}", content="..."): curl -sS -X POST ${baseUrl}/api/agent-tools/messages/send -H 'content-type: application/json' -d '${JSON.stringify({ agentId, workItemId: currentWorkItemId, target: currentTarget, content: '...' })}'`,
    );
  }
  if (asArray(pack.tasks).some((task) => ['todo', 'in_progress', 'in_review'].includes(task.status))) {
    hints.push(
      `- update_task(taskId="<task_id>", status="in_review|done"): curl -sS -X POST ${baseUrl}/api/agent-tools/tasks/update -H 'content-type: application/json' -d '${JSON.stringify({ agentId, taskId: '<task_id>', status: 'in_review' })}'`,
    );
  }
  hints.push(
    pack.peerMemorySearch?.required
      ? '- For agent capability or suitability questions, use the peer memory search results above first. If they are missing or weak, call search_agent_memory/read_agent_memory before giving a recommendation.'
      : '- Use history/search only when the visible snapshot is not enough. Use send_message for explicit routed replies, especially when multiple channels or tasks are active.',
  );
  return hints.join('\n');
}

export function renderAgentContextPack(pack, { state, targetAgentId = pack?.targetAgentId } = {}) {
  if (!pack?.currentMessage) return '';
  const sourceState = state || {
    agents: pack.participants.filter((item) => item.type === 'agent'),
    humans: pack.participants.filter((item) => item.type === 'human'),
  };
  const lines = [
    `Context snapshot for ${pack.space.label}`,
    pack.space.description ? `- Channel description: ${pack.space.description}` : '',
    `- Participants: ${renderParticipants(pack) || '(none)'}`,
    '',
    'Current message:',
    messageLine(sourceState, pack.currentMessage, targetAgentId),
    '',
    `Recent ${pack.space.type === 'dm' ? 'DM' : 'channel'} messages (oldest to newest):`,
    pack.recentMessages.length
      ? pack.recentMessages.map((record) => messageLine(sourceState, record, targetAgentId)).join('\n')
      : '- (none)',
  ];

  if (pack.thread) {
    lines.push(
      '',
      'Thread context:',
      'Parent message:',
      messageLine(sourceState, pack.thread.parentMessage, targetAgentId),
      'Recent thread replies (oldest to newest):',
      pack.thread.recentReplies.length
        ? pack.thread.recentReplies.map((record) => messageLine(sourceState, record, targetAgentId)).join('\n')
        : '- (no earlier thread replies)',
    );
  }

  lines.push(
    '',
    'Relevant tasks:',
    renderTasks(sourceState, pack.tasks),
    '',
    'Visible attachment metadata:',
    renderAttachments(pack.attachments),
    '',
    renderPeerMemorySearch(pack.peerMemorySearch),
    '',
    renderHistoryToolHints(pack),
    '',
    'Use the compact context above as visible conversation history. If deeper history is needed, use the read-only history tools before answering.',
  );

  return lines.filter((line) => line !== '').join('\n');
}
