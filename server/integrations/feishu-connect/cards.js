function compact(value, fallback = '') {
  return String(value || fallback || '').replace(/\s+/g, ' ').trim();
}

function truncate(value, max = 1200) {
  const text = String(value || '');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function normalizeMarkdown(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/([^\n])```/g, '$1\n```')
    .trim();
}

function splitMarkdown(value, max = 1800, maxParts = 4) {
  const text = normalizeMarkdown(value || '(empty)');
  if (text.length <= max) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > max && parts.length < maxParts - 1) {
    let splitAt = rest.lastIndexOf('\n\n', max);
    if (splitAt < max * 0.45) splitAt = rest.lastIndexOf('\n', max);
    if (splitAt < max * 0.45) splitAt = max;
    parts.push(rest.slice(0, splitAt).trim());
    rest = rest.slice(splitAt).trim();
  }
  if (rest) parts.push(truncate(rest, max));
  return parts.filter(Boolean);
}

export function textPayload(content) {
  return {
    msg_type: 'text',
    content: String(content || ''),
  };
}

function interactiveCardPayload(card, fallbackText = '') {
  return {
    msg_type: 'interactive',
    content: JSON.stringify(card),
    fallbackText,
  };
}

export function importAckPayload({ traceId, serverName, channelName, task, attachmentCount = 0, messageUrl = '' } = {}) {
  const lines = [
    '已导入 MagClaw',
    `Trace ID：${traceId}`,
    `目标：${compact(serverName, 'Server')} / #${compact(channelName, 'channel')}`,
    task?.number ? `Task：#${task.number} ${compact(task.title)}` : '',
    attachmentCount ? `附件：${attachmentCount}` : '',
    messageUrl ? `打开：${messageUrl}` : '',
  ].filter(Boolean);
  return textPayload(lines.join('\n'));
}

export function invalidPathPayload(rawPath = '') {
  return textPayload(`未识别到该路径，请使用正确的路径：${rawPath || '(empty)'}`);
}

export function threadReplyPayload({ traceId, actorName, actorType, body, attachmentCount = 0 } = {}) {
  const name = compact(actorName, actorType === 'agent' ? 'Agent' : 'Human');
  const title = actorType === 'agent' ? `Agent ${name} replied` : `${name} replied`;
  const markdownParts = splitMarkdown(body || '(empty)');
  const elements = markdownParts.map((content) => ({
    tag: 'markdown',
    content,
  }));
  const footer = [
    traceId ? `Trace ID: ${traceId}` : '',
    attachmentCount ? `Attachments: ${attachmentCount}` : '',
  ].filter(Boolean).join(' · ');
  if (footer) {
    elements.push({
      tag: 'div',
      text: {
        tag: 'plain_text',
        content: footer,
      },
    });
  }
  const card = {
    schema: '2.0',
    config: {
      wide_screen_mode: true,
      enable_forward_interaction: true,
    },
    header: {
      template: actorType === 'agent' ? 'blue' : 'turquoise',
      title: {
        tag: 'plain_text',
        content: title,
      },
    },
    body: {
      elements,
    },
  };
  return interactiveCardPayload(card, [
    title,
    traceId ? `Trace ID：${traceId}` : '',
    truncate(body || '(empty)', 1800),
    attachmentCount ? `附件：${attachmentCount}` : '',
  ].filter(Boolean).join('\n'));
}
