export function normalizeIds(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map(String)
    .map((id) => id.trim())
    .filter(Boolean))];
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function mentionTokenForId(id) {
  return String(id).startsWith('!') ? `<!${String(id).replace(/^!/, '')}>` : `<@${id}>`;
}

export function isAsciiMentionWordChar(char) {
  return /[A-Za-z0-9_.-]/.test(char);
}

export function isMentionBoundaryChar(char) {
  if (!char) return true;
  if (/\s/.test(char)) return true;
  if (/[，。！？；：、,.!?;:()[\]{}「」『』《》【】"'`“”‘’]/.test(char)) return true;
  return !isAsciiMentionWordChar(char);
}

export function extractMentionTokens(text, { findAgent = null, findHuman = null } = {}) {
  const mentions = {
    agents: [],
    humans: [],
    special: [],
  };
  const body = String(text || '');

  for (const match of body.matchAll(/<@(agt_\w+)>/g)) {
    const agent = typeof findAgent === 'function' ? findAgent(match[1]) : { id: match[1] };
    if (agent && !mentions.agents.includes(agent.id)) {
      mentions.agents.push(agent.id);
    }
  }

  for (const match of body.matchAll(/<@(hum_\w+)>/g)) {
    const human = typeof findHuman === 'function' ? findHuman(match[1]) : { id: match[1] };
    if (human && !mentions.humans.includes(match[1])) {
      mentions.humans.push(match[1]);
    }
  }

  for (const match of body.matchAll(/<!(all|here|channel|everyone)>/g)) {
    if (!mentions.special.includes(match[1])) {
      mentions.special.push(match[1]);
    }
  }

  return mentions;
}

export function applyMentions(record, mentions = extractMentionTokens(record.body || '')) {
  record.mentionedAgentIds = normalizeIds(mentions.agents);
  record.mentionedHumanIds = normalizeIds(mentions.humans);
  return record;
}
