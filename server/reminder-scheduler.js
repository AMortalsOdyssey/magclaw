const MAX_TIMER_DELAY_MS = 2_147_483_647;

function toIso(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return date.toISOString();
}

function reminderShortId(id) {
  return String(id || '').split('_').pop()?.slice(0, 8) || 'reminder';
}

function reminderLabel(reminder) {
  return `#${reminderShortId(reminder?.id)}`;
}

function normalizeTargetInput(input = {}, state = {}) {
  const raw = String(input.target || input.channel || '').trim();
  if (!raw) return `#${state.channels?.[0]?.name || 'all'}`;
  if (raw.startsWith('#') || raw.startsWith('dm:')) return raw;
  return `#${raw}`;
}

function normalizeRepeat(value) {
  const repeat = String(value || '').trim().toLowerCase();
  if (!repeat || repeat === 'none' || repeat === 'one-time' || repeat === 'once') return null;
  return repeat;
}

export function createReminderScheduler(deps) {
  const {
    addSystemEvent,
    addSystemMessage,
    addSystemReply,
    broadcastState,
    deliverMessageToAgent,
    findAgent,
    findMessage,
    getState,
    makeId,
    now,
    persistState,
    resolveMessageTarget,
    targetForConversation,
  } = deps;
  const state = new Proxy({}, {
    get(_target, prop) { return getState()[prop]; },
    set(_target, prop, value) { getState()[prop] = value; return true; },
  });
  const timers = new Map();

  function nowIso() {
    return toIso(now());
  }

  function reminderHistory(type, actorId, extra = {}) {
    return {
      type,
      actorId: actorId || null,
      createdAt: nowIso(),
      ...extra,
    };
  }

  function parseFireAt(input = {}) {
    const rawFireAt = input.fireAt || input.fire_at || input.at || '';
    if (rawFireAt) {
      const iso = toIso(rawFireAt);
      if (!iso) throw new Error('Reminder fireAt must be a valid date/time.');
      return iso;
    }
    const rawDelay = input.delaySeconds ?? input.delay_seconds ?? input.delay ?? '';
    const delaySeconds = Number(rawDelay);
    if (Number.isFinite(delaySeconds) && delaySeconds > 0) {
      return new Date(Date.parse(nowIso()) + Math.round(delaySeconds * 1000)).toISOString();
    }
    throw new Error('Reminder requires fireAt or delaySeconds.');
  }

  function resolveReminderTarget(input = {}) {
    const target = resolveMessageTarget(normalizeTargetInput(input, state));
    let parentMessageId = target.parentMessageId || String(input.parentMessageId || input.threadMessageId || input.messageId || '').trim() || null;
    if (parentMessageId) {
      const parent = findMessage(parentMessageId)
        || (state.messages || []).find((message) => String(message.id || '').startsWith(parentMessageId));
      if (!parent) throw new Error(`Thread message not found: ${parentMessageId}`);
      if (parent.spaceType !== target.spaceType || parent.spaceId !== target.spaceId) {
        throw new Error('Reminder thread target does not belong to the selected conversation.');
      }
      parentMessageId = parent.id;
    }
    const label = typeof targetForConversation === 'function'
      ? targetForConversation(target.spaceType, target.spaceId, parentMessageId)
      : target.label;
    return {
      spaceType: target.spaceType,
      spaceId: target.spaceId,
      parentMessageId,
      label,
    };
  }

  function visibleBody(reminder, type) {
    if (type === 'scheduled') {
      return `Reminder scheduled: ${reminderLabel(reminder)} "${reminder.title}" at ${reminder.fireAt}`;
    }
    if (type === 'canceled') {
      return `Reminder canceled: ${reminderLabel(reminder)} "${reminder.title}"`;
    }
    const details = String(reminder.body || '').trim();
    return details
      ? `Reminder: ${reminder.title}\n${details}`
      : `Reminder: ${reminder.title}`;
  }

  function addVisibleReminderRecord(reminder, type) {
    const extra = {
      eventType: type === 'scheduled' ? 'reminder_scheduled' : (type === 'canceled' ? 'reminder_canceled' : 'reminder_fired'),
      reminderId: reminder.id,
    };
    const body = visibleBody(reminder, type);
    if (reminder.parentMessageId) {
      return addSystemReply(reminder.parentMessageId, body, extra);
    }
    return addSystemMessage(reminder.spaceType, reminder.spaceId, body, extra);
  }

  function createReminder(input = {}) {
    if (!Array.isArray(state.reminders)) state.reminders = [];
    const title = String(input.title || input.summary || input.body || '').trim().slice(0, 180);
    if (!title) throw new Error('Reminder title is required.');
    const repeat = normalizeRepeat(input.repeat);
    if (repeat) throw new Error('Repeating reminders are not supported yet.');
    const target = resolveReminderTarget(input);
    const fireAt = parseFireAt(input);
    const createdAt = nowIso();
    const reminder = {
      id: makeId('rem'),
      title,
      body: String(input.body || input.content || '').trim(),
      status: 'scheduled',
      fireAt,
      repeat: null,
      spaceType: target.spaceType,
      spaceId: target.spaceId,
      target: target.label,
      parentMessageId: target.parentMessageId,
      sourceMessageId: String(input.sourceMessageId || input.messageId || target.parentMessageId || '').trim() || null,
      ownerAgentId: String(input.ownerAgentId || input.agentId || '').trim() || null,
      createdBy: String(input.agentId || input.createdBy || '').trim() || null,
      createdAt,
      updatedAt: createdAt,
      firedAt: null,
      canceledAt: null,
      history: [reminderHistory('created', input.agentId || input.createdBy || null, { fireAt })],
    };
    state.reminders.unshift(reminder);
    const receipt = addVisibleReminderRecord(reminder, 'scheduled');
    addSystemEvent?.('reminder_scheduled', `Reminder scheduled: ${reminder.title}`, {
      reminderId: reminder.id,
      ownerAgentId: reminder.ownerAgentId,
      fireAt: reminder.fireAt,
      target: reminder.target,
    });
    scheduleTimer(reminder);
    return {
      ok: true,
      reminder,
      receipt,
      text: `Scheduled ${reminderLabel(reminder)} "${reminder.title}" for ${reminder.fireAt}.`,
    };
  }

  function listReminders(input = {}) {
    const agentId = String(input.agentId || input.ownerAgentId || '').trim();
    const status = String(input.status || '').trim();
    const limit = Math.max(1, Math.min(100, Number(input.limit || 25)));
    const reminders = (state.reminders || [])
      .filter((reminder) => !agentId || reminder.ownerAgentId === agentId || reminder.createdBy === agentId)
      .filter((reminder) => !status || reminder.status === status)
      .sort((a, b) => new Date(a.fireAt || a.createdAt || 0) - new Date(b.fireAt || b.createdAt || 0))
      .slice(0, limit);
    return {
      ok: true,
      reminders,
      text: reminders.length
        ? [
          'Reminders:',
          ...reminders.map((reminder) => `${reminderLabel(reminder)} [${reminder.status}] ${reminder.fireAt} "${reminder.title}"`),
        ].join('\n')
        : 'No reminders.',
    };
  }

  function findReminder(id) {
    const raw = String(id || '').trim();
    if (!raw) return null;
    return (state.reminders || []).find((reminder) => (
      reminder.id === raw
      || reminder.id.startsWith(raw)
      || reminderShortId(reminder.id) === raw.replace(/^#/, '')
    )) || null;
  }

  function cancelReminder(input = {}) {
    const reminder = findReminder(input.reminderId || input.reminder_id || input.id);
    if (!reminder) {
      const error = new Error('Reminder not found.');
      error.status = 404;
      throw error;
    }
    const agentId = String(input.agentId || '').trim();
    if (agentId && reminder.ownerAgentId && reminder.ownerAgentId !== agentId) {
      const error = new Error('Reminder belongs to a different agent.');
      error.status = 403;
      throw error;
    }
    clearTimer(reminder.id);
    if (reminder.status !== 'canceled') {
      reminder.status = 'canceled';
      reminder.canceledAt = nowIso();
      reminder.updatedAt = reminder.canceledAt;
      reminder.history = Array.isArray(reminder.history) ? reminder.history : [];
      reminder.history.push(reminderHistory('canceled', agentId || null));
      addVisibleReminderRecord(reminder, 'canceled');
      addSystemEvent?.('reminder_canceled', `Reminder canceled: ${reminder.title}`, {
        reminderId: reminder.id,
        ownerAgentId: reminder.ownerAgentId,
      });
    }
    return {
      ok: true,
      reminder,
      text: `Canceled ${reminderLabel(reminder)} "${reminder.title}".`,
    };
  }

  async function fireReminder(reminder) {
    if (!reminder || reminder.status !== 'scheduled') return null;
    const firedAt = nowIso();
    if (Date.parse(reminder.fireAt || '') > Date.parse(firedAt)) return null;
    clearTimer(reminder.id);
    reminder.status = 'fired';
    reminder.firedAt = firedAt;
    reminder.updatedAt = firedAt;
    reminder.history = Array.isArray(reminder.history) ? reminder.history : [];
    reminder.history.push(reminderHistory('fired', reminder.ownerAgentId || reminder.createdBy || null, { firedAt }));
    const firedRecord = addVisibleReminderRecord(reminder, 'fired');
    addSystemEvent?.('reminder_fired', `Reminder fired: ${reminder.title}`, {
      reminderId: reminder.id,
      ownerAgentId: reminder.ownerAgentId,
      target: reminder.target,
    });
    const ownerAgent = reminder.ownerAgentId ? findAgent(reminder.ownerAgentId) : null;
    if (ownerAgent && typeof deliverMessageToAgent === 'function' && firedRecord) {
      const delivery = {
        ...firedRecord,
        body: [
          `Reminder fired: ${reminder.title}`,
          reminder.body ? `Details: ${reminder.body}` : '',
          'Reply in this thread with a concise reminder for the user.',
          'Do not update task status just because this reminder fired.',
        ].filter(Boolean).join('\n'),
        reminderId: reminder.id,
        suppressTaskContext: true,
      };
      await deliverMessageToAgent(ownerAgent, reminder.spaceType, reminder.spaceId, delivery, {
        parentMessageId: reminder.parentMessageId || null,
        suppressTaskContext: true,
        contextLimits: { tasks: 0 },
      });
    }
    await persistState?.();
    broadcastState?.();
    return { reminder, message: firedRecord };
  }

  async function fireDueReminders() {
    const dueAt = Date.parse(nowIso());
    const due = (state.reminders || [])
      .filter((reminder) => reminder.status === 'scheduled' && Date.parse(reminder.fireAt || '') <= dueAt)
      .sort((a, b) => new Date(a.fireAt || 0) - new Date(b.fireAt || 0));
    const fired = [];
    for (const reminder of due) {
      const result = await fireReminder(reminder);
      if (result) fired.push(result);
    }
    return fired;
  }

  function clearTimer(reminderId) {
    const timer = timers.get(reminderId);
    if (timer) clearTimeout(timer);
    timers.delete(reminderId);
  }

  function scheduleTimer(reminder) {
    if (!reminder || reminder.status !== 'scheduled') return;
    clearTimer(reminder.id);
    const delayMs = Math.max(0, Date.parse(reminder.fireAt || '') - Date.parse(nowIso()));
    const timer = setTimeout(() => {
      timers.delete(reminder.id);
      fireDueReminders().catch((error) => {
        addSystemEvent?.('reminder_fire_error', `Reminder fire failed: ${error.message}`, {
          reminderId: reminder.id,
        });
        persistState?.().then?.(() => broadcastState?.()).catch?.(() => {});
      });
    }, Math.min(delayMs, MAX_TIMER_DELAY_MS));
    timer.unref?.();
    timers.set(reminder.id, timer);
  }

  function start() {
    stop();
    for (const reminder of state.reminders || []) scheduleTimer(reminder);
    return timers.size;
  }

  function stop() {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  return {
    cancelReminder,
    createReminder,
    fireDueReminders,
    listReminders,
    start,
    stop,
  };
}
