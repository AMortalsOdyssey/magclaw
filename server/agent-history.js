// Read-only history/search tools exposed to Agents.
// These helpers implement MagClaw's progressive context disclosure: Agents get
// a small prompt snapshot first, then call these functions when they need more
// channel, thread, or DM history.

const DEFAULT_HISTORY_LIMIT = 50;
const MAX_HISTORY_LIMIT = 100;
const DEFAULT_SEARCH_LIMIT = 10;
const MAX_SEARCH_LIMIT = 20;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function byId(items, id) {
  return asArray(items).find((item) => item?.id === id) || null;
}

function sortByCreatedAt(records) {
  return [...asArray(records)].sort((a, b) => {
    const left = new Date(a?.createdAt || 0).getTime();
    const right = new Date(b?.createdAt || 0).getTime();
    if (left !== right) return left - right;
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  });
}

function clampLimit(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

function actorName(state, id) {
  if (id === 'system') return 'Magclaw';
  return byId(state?.humans, id)?.name || byId(state?.agents, id)?.name || 'Unknown';
}

function renderMentions(state, text) {
  return String(text || '').replace(/<@(agt_\w+|hum_\w+)>/g, (_, id) => `@${actorName(state, id)}`);
}

function spaceLabel(state, spaceType, spaceId) {
  if (spaceType === 'channel') return `#${byId(state?.channels, spaceId)?.name || spaceId || 'channel'}`;
  if (spaceType === 'dm') {
    const dm = byId(state?.dms, spaceId);
    const otherId = dm?.participantIds?.find((id) => id !== 'hum_local');
    return otherId ? `dm:@${actorName(state, otherId)}` : `dm:${spaceId || 'unknown'}`;
  }
  return `${spaceType || 'space'}:${spaceId || ''}`;
}

function findMessageByRef(state, ref) {
  const value = String(ref || '').trim();
  if (!value) return null;
  return asArray(state?.messages).find((message) => (
    message.id === value
    || message.id.startsWith(value)
    || message.id.split('_').pop()?.startsWith(value)
  )) || null;
}

function findReplyByRef(state, ref) {
  const value = String(ref || '').trim();
  if (!value) return null;
  return asArray(state?.replies).find((reply) => (
    reply.id === value
    || reply.id.startsWith(value)
    || reply.id.split('_').pop()?.startsWith(value)
  )) || null;
}

function findChannelByRef(state, ref) {
  const value = String(ref || '').trim().replace(/^#/, '');
  if (!value) return null;
  return asArray(state?.channels).find((channel) => (
    channel.id === value
    || channel.name === value
    || channel.id.startsWith(value)
  )) || null;
}

function findDmByRef(state, ref) {
  const value = String(ref || '').trim().replace(/^dm:/, '').replace(/^@/, '');
  if (!value) return null;
  return asArray(state?.dms).find((dm) => {
    if (dm.id === value || dm.id.startsWith(value)) return true;
    return asArray(dm.participantIds).some((id) => {
      if (id === 'hum_local') return false;
      const name = actorName(state, id);
      return name === value || id === value || id.startsWith(value);
    });
  }) || null;
}

function resolveHistoryTarget(state, rawTarget) {
  const target = String(rawTarget || '#all').trim() || '#all';
  const threadOnly = target.match(/^thread:(.+)$/i);
  if (threadOnly) {
    const parent = findMessageByRef(state, threadOnly[1]);
    if (!parent) return { error: `Thread target not found: ${target}` };
    return { kind: 'thread', spaceType: parent.spaceType, spaceId: parent.spaceId, parent };
  }

  const channelMatch = target.match(/^#([^:]+)(?::(.+))?$/);
  if (channelMatch) {
    const channel = findChannelByRef(state, channelMatch[1]);
    if (!channel) return { error: `Channel not found: ${target}` };
    if (channelMatch[2]) {
      const parent = findMessageByRef(state, channelMatch[2]);
      if (!parent || parent.spaceType !== 'channel' || parent.spaceId !== channel.id) {
        return { error: `Thread target not found: ${target}` };
      }
      return { kind: 'thread', spaceType: 'channel', spaceId: channel.id, parent };
    }
    return { kind: 'channel', spaceType: 'channel', spaceId: channel.id };
  }

  const dmMatch = target.match(/^dm:([^:]+)(?::(.+))?$/i);
  if (dmMatch) {
    const dm = findDmByRef(state, dmMatch[1]);
    if (!dm) return { error: `DM not found: ${target}` };
    if (dmMatch[2]) {
      const parent = findMessageByRef(state, dmMatch[2]);
      if (!parent || parent.spaceType !== 'dm' || parent.spaceId !== dm.id) {
        return { error: `Thread target not found: ${target}` };
      }
      return { kind: 'thread', spaceType: 'dm', spaceId: dm.id, parent };
    }
    return { kind: 'dm', spaceType: 'dm', spaceId: dm.id };
  }

  const parent = findMessageByRef(state, target);
  if (parent) return { kind: 'thread', spaceType: parent.spaceType, spaceId: parent.spaceId, parent };

  const channel = findChannelByRef(state, target);
  if (channel) return { kind: 'channel', spaceType: 'channel', spaceId: channel.id };

  return { error: `History target not found: ${target}` };
}

function centerWindow(records, around, limit) {
  if (!around) return records.slice(Math.max(0, records.length - limit));
  const ref = String(around);
  const index = records.findIndex((record) => (
    record.id === ref
    || record.id.startsWith(ref)
    || record.id.split('_').pop()?.startsWith(ref)
  ));
  if (index === -1) return records.slice(Math.max(0, records.length - limit));
  const before = Math.floor((limit - 1) / 2);
  const start = Math.max(0, index - before);
  return records.slice(start, start + limit);
}

function taskForMessage(state, record) {
  if (!record) return null;
  if (record.taskId) {
    const direct = byId(state?.tasks, record.taskId);
    if (direct) return direct;
  }
  return asArray(state?.tasks).find((task) => (
    task.messageId === record.id
    || task.sourceMessageId === record.id
    || task.threadMessageId === record.id
  )) || null;
}

function normalizeRecord(state, record, targetLabel) {
  const task = taskForMessage(state, record);
  return {
    id: record.id,
    target: targetLabel,
    parentMessageId: record.parentMessageId || null,
    spaceType: record.spaceType || null,
    spaceId: record.spaceId || null,
    authorType: record.authorType || 'unknown',
    authorId: record.authorId || 'unknown',
    authorName: actorName(state, record.authorId),
    body: String(record.body || ''),
    attachmentIds: asArray(record.attachmentIds).map(String),
    createdAt: record.createdAt || '',
    task: task ? {
      id: task.id,
      number: task.number,
      status: task.status || 'todo',
      assigneeIds: asArray(task.assigneeIds?.length ? task.assigneeIds : [task.assigneeId]).filter(Boolean),
    } : null,
  };
}

export function readAgentHistory(state, options = {}) {
  const limit = clampLimit(options.limit, DEFAULT_HISTORY_LIMIT, MAX_HISTORY_LIMIT);
  const resolved = resolveHistoryTarget(state, options.target || '#all');
  if (resolved.error) return { ok: false, error: resolved.error, messages: [] };

  if (resolved.kind === 'thread') {
    const label = `${spaceLabel(state, resolved.spaceType, resolved.spaceId)}:${resolved.parent.id}`;
    const replies = sortByCreatedAt(asArray(state?.replies).filter((reply) => reply.parentMessageId === resolved.parent.id));
    const records = [resolved.parent, ...replies];
    return {
      ok: true,
      kind: 'thread',
      target: label,
      parent: normalizeRecord(state, resolved.parent, label),
      messages: centerWindow(records, options.around, limit).map((record) => normalizeRecord(state, record, label)),
    };
  }

  const label = spaceLabel(state, resolved.spaceType, resolved.spaceId);
  const records = sortByCreatedAt(asArray(state?.messages).filter((message) => (
    message.spaceType === resolved.spaceType && message.spaceId === resolved.spaceId
  )));
  return {
    ok: true,
    kind: resolved.kind,
    target: label,
    messages: centerWindow(records, options.around, limit).map((record) => normalizeRecord(state, record, label)),
  };
}

function recordSearchText(record) {
  return String(record?.body || '').toLowerCase();
}

function snippetFor(text, query) {
  const body = String(text || '');
  const index = body.toLowerCase().indexOf(String(query || '').toLowerCase());
  if (index === -1) return body.slice(0, 160);
  const start = Math.max(0, index - 50);
  const end = Math.min(body.length, index + String(query).length + 80);
  return body.slice(start, end);
}

export function searchAgentMessageHistory(state, options = {}) {
  const query = String(options.query || '').trim();
  const limit = clampLimit(options.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
  if (!query) return { ok: false, error: 'Search query cannot be empty.', results: [] };
  const resolved = resolveHistoryTarget(state, options.target || '#all');
  if (resolved.error) return { ok: false, error: resolved.error, results: [] };
  const q = query.toLowerCase();

  const spaceFilter = (record) => record.spaceType === resolved.spaceType && record.spaceId === resolved.spaceId;
  let records = [];
  if (resolved.kind === 'thread') {
    records = [resolved.parent, ...asArray(state?.replies).filter((reply) => reply.parentMessageId === resolved.parent.id)];
  } else {
    const parentIds = new Set(asArray(state?.messages).filter(spaceFilter).map((message) => message.id));
    records = [
      ...asArray(state?.messages).filter(spaceFilter),
      ...asArray(state?.replies).filter((reply) => parentIds.has(reply.parentMessageId)),
    ];
  }

  const results = sortByCreatedAt(records)
    .filter((record) => recordSearchText(record).includes(q))
    .slice(0, limit)
    .map((record) => {
      const parent = record.parentMessageId ? findMessageByRef(state, record.parentMessageId) : record;
      const target = record.parentMessageId
        ? `${spaceLabel(state, parent?.spaceType || record.spaceType, parent?.spaceId || record.spaceId)}:${parent?.id || record.parentMessageId}`
        : spaceLabel(state, record.spaceType, record.spaceId);
      return {
        ...normalizeRecord(state, record, target),
        snippet: snippetFor(record.body, query),
        next: `read_history(target="${target}", around="${record.id}", limit=20)`,
      };
    });

  return { ok: true, query, target: options.target || '#all', results };
}

function taskSuffix(state, record) {
  if (!record.task) return '';
  const assignees = record.task.assigneeIds?.length
    ? ` assignees=${record.task.assigneeIds.map((id) => `@${actorName(state, id)}`).join(',')}`
    : '';
  return ` [task #${record.task.number || '?'} status=${record.task.status}${assignees}]`;
}

function formatRecordLine(state, record, targetAgentId) {
  const mentionedYou = String(record.body || '').includes(`<@${targetAgentId}>`) ? ' mentioned you' : '';
  const attachmentSuffix = record.attachmentIds?.length ? ` [attachments=${record.attachmentIds.join(',')}]` : '';
  return `[target=${record.target} msg=${record.id} time=${record.createdAt || '-'} type=${record.authorType}${mentionedYou}] @${record.authorName}: ${renderMentions(state, record.body)}${attachmentSuffix}${taskSuffix(state, record)}`;
}

export function formatAgentHistory(history, { state, targetAgentId = '' } = {}) {
  if (!history?.ok) return `Error: ${history?.error || 'History unavailable.'}`;
  const title = history.kind === 'thread'
    ? `## Thread History ${history.target}`
    : `## Message History ${history.target}`;
  const lines = history.messages?.length
    ? history.messages.map((record) => formatRecordLine(state, record, targetAgentId)).join('\n')
    : '- (no messages)';
  return `${title}\n${lines}`;
}

export function formatAgentSearchResults(search, { state, targetAgentId = '' } = {}) {
  if (!search?.ok) return `Error: ${search?.error || 'Search unavailable.'}`;
  if (!search.results?.length) return `No search results for "${search.query}".`;
  return [
    `## Search Results for "${search.query}"`,
    ...search.results.map((record, index) => [
      `[${index + 1}] ${formatRecordLine(state, record, targetAgentId)}`,
      `snippet: ${renderMentions(state, record.snippet)}`,
      `next: ${record.next}`,
    ].join('\n')),
  ].join('\n\n');
}
