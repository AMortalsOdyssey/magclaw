import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const CODEX_HOOK_EVENTS = Object.freeze(['Stop', 'PreCompact', 'SessionStart']);
const CLAUDE_HOOK_EVENTS = Object.freeze(['Stop', 'SessionEnd', 'PreCompact', 'SessionStart']);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function stableHash(value = '') {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function redactTeamSharingText(value = '') {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/(?:api[_-]?key|token|secret|password|密钥|秘钥|口令|令牌)\s*[：:=]\s*["']?[^\s"',;，。)）]+/gi, '[redacted-secret]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, 'Bearer [redacted-secret]')
    .replace(/([?&](?:key|api[_-]?key|token|access_token|secret)=)[^\s"'&)）]+/gi, '$1[redacted-secret]')
    .replace(/(App Secret|app_secret|client_secret)(\s*[：:=]\s*)[^\s"',;，。)）]+/gi, '$1$2[redacted-secret]')
    .trim();
}

function iso(value, fallback = new Date().toISOString()) {
  const date = new Date(value || fallback);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function parseJsonOrJsonl(text = '') {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      // Fall through to JSONL parsing. Codex transcripts are newline-delimited
      // JSON objects and usually start with "{".
    }
  }
  return trimmed.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function isInjectedCodexContext(text = '') {
  const clean = String(text || '').trim();
  return clean.startsWith('# AGENTS.md instructions for ')
    || clean.startsWith('<environment_context>')
    || clean.startsWith('<permissions instructions>')
    || clean.startsWith('<skills_instructions>')
    || clean.startsWith('<plugins_instructions>');
}

function textFromContentBlocks(content) {
  const blocks = asArray(content);
  if (!blocks.length && typeof content === 'string') return content;
  return blocks
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      return block.text || block.content || '';
    })
    .filter((text) => text && !isInjectedCodexContext(text))
    .join('\n\n');
}

function pushUnique(target, value) {
  const clean = String(value || '').trim();
  if (clean && !target.includes(clean)) target.push(clean);
}

function normalizeRuntime(value = '') {
  const runtime = String(value || '').trim().toLowerCase();
  if (runtime === 'claude' || runtime === 'claude-code') return 'claude_code';
  if (runtime === 'codex') return 'codex';
  return runtime || 'codex';
}

function parseJsonValue(value, fallback = null) {
  if (value && typeof value === 'object') return value;
  const text = String(value || '').trim();
  if (!text) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function compactPresentationText(value = '', limit = 4000) {
  return redactTeamSharingText(value).slice(0, limit).trim();
}

function extractProposedPlanText(value = '') {
  const match = String(value || '').match(/<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i);
  return match ? compactPresentationText(match[1], 12000) : '';
}

function codexVisibleUserRequestText(value = '') {
  const raw = String(value || '').replace(/\r\n/g, '\n').trim();
  const match = raw.match(/(?:^|\n)\s*#+\s*My request for Codex:\s*\n?([\s\S]*)/i)
    || raw.match(/My request for Codex:\s*([\s\S]*)/i);
  const request = match ? match[1] : raw;
  return request
    .replace(/(?:^|\n)\s*#+\s*In app browser:[\s\S]*$/i, '')
    .replace(/(?:^|\n)\s*The next image[\s\S]*$/i, '')
    .replace(/(?:^|\n)\s*Attached image:[\s\S]*$/i, '')
    .trim();
}

function isCodexImplementationPlanPrompt(value = '') {
  return /^\s*PLEASE IMPLEMENT THIS PLAN\s*:/i.test(codexVisibleUserRequestText(value));
}

function stripGoalCommandPrefix(value = '') {
  const text = codexVisibleUserRequestText(value);
  const match = text.match(/^\/goal\b\s*([\s\S]*)$/i);
  return {
    isGoalRequest: Boolean(match),
    text: match ? compactPresentationText(match[1], 8000) : text,
  };
}

function normalizeComparableGoalText(value = '') {
  return String(value || '')
    .toLowerCase()
    .replace(/^\/goal\b/i, '')
    .replace(/[^\p{L}\p{N}\u4e00-\u9fff]+/gu, '')
    .trim();
}

function charBigrams(value = '') {
  const chars = Array.from(value);
  if (chars.length <= 1) return chars;
  const grams = [];
  for (let index = 0; index < chars.length - 1; index += 1) {
    grams.push(`${chars[index]}${chars[index + 1]}`);
  }
  return grams;
}

function overlapRatio(left = '', right = '') {
  const leftGrams = charBigrams(left);
  const rightGrams = new Set(charBigrams(right));
  if (!leftGrams.length || !rightGrams.size) return 0;
  let overlap = 0;
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) overlap += 1;
  }
  return overlap / leftGrams.length;
}

function goalObjectiveMatchesUser(objective = '', userText = '') {
  const cleanObjective = normalizeComparableGoalText(objective);
  const cleanUser = normalizeComparableGoalText(userText);
  if (!cleanObjective || !cleanUser) return false;
  if (cleanObjective === cleanUser) return true;
  if (cleanObjective.length >= 8 && cleanUser.includes(cleanObjective)) return true;
  if (cleanUser.length >= 8 && cleanObjective.includes(cleanUser)) return true;
  return overlapRatio(cleanObjective, cleanUser) >= 0.68 && overlapRatio(cleanUser, cleanObjective) >= 0.42;
}

function normalizeInteractionOption(option = {}) {
  const raw = option && typeof option === 'object' ? option : { label: option };
  const label = compactPresentationText(raw.label || raw.value || raw.text || '', 80);
  const description = compactPresentationText(raw.description || raw.help || '', 220);
  return {
    label,
    description,
  };
}

function normalizeInteractionQuestion(question = {}, index = 0) {
  const raw = question && typeof question === 'object' ? question : { question };
  const id = compactPresentationText(raw.id || raw.key || `question_${index + 1}`, 80);
  const header = compactPresentationText(raw.header || raw.title || raw.label || '', 80);
  const prompt = compactPresentationText(raw.question || raw.prompt || raw.text || raw.body || header, 1200);
  const options = asArray(raw.options || raw.choices)
    .map(normalizeInteractionOption)
    .filter((option) => option.label || option.description)
    .slice(0, 12);
  return {
    id,
    header,
    question: prompt,
    options,
    multiSelect: Boolean(raw.multiSelect || raw.multiselect || raw.multiple),
  };
}

function normalizeInteractionQuestions(value) {
  return asArray(value).map(normalizeInteractionQuestion).filter((question) => question.question || question.header);
}

function normalizeAnswerValues(value) {
  if (Array.isArray(value)) {
    return value.flatMap((item) => normalizeAnswerValues(item)).filter(Boolean).slice(0, 12);
  }
  if (value && typeof value === 'object') {
    if (Array.isArray(value.answers)) return normalizeAnswerValues(value.answers);
    if (Array.isArray(value.values)) return normalizeAnswerValues(value.values);
    if (value.answer !== undefined) return normalizeAnswerValues(value.answer);
    if (value.value !== undefined) return normalizeAnswerValues(value.value);
    if (value.text !== undefined) return normalizeAnswerValues(value.text);
    if (value.label !== undefined) return normalizeAnswerValues(value.label);
    return Object.values(value).flatMap((item) => normalizeAnswerValues(item)).filter(Boolean).slice(0, 12);
  }
  const text = compactPresentationText(value, 1000);
  return text ? [text] : [];
}

function normalizeInteractionAnswers(value, questions = []) {
  const raw = value && typeof value === 'object' && value.answers !== undefined ? value.answers : value;
  if (Array.isArray(raw)) {
    return raw.map((item, index) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        const id = compactPresentationText(item.id || item.key || questions[index]?.id || `answer_${index + 1}`, 80);
        return { id, values: normalizeAnswerValues(item.values ?? item.answers ?? item.answer ?? item.value ?? item.text ?? item) };
      }
      return { id: questions[index]?.id || `answer_${index + 1}`, values: normalizeAnswerValues(item) };
    }).filter((answer) => answer.values.length);
  }
  if (raw && typeof raw === 'object') {
    return Object.entries(raw).map(([id, item]) => ({
      id: compactPresentationText(id, 80),
      values: normalizeAnswerValues(item),
    })).filter((answer) => answer.values.length);
  }
  const fallbackValues = normalizeAnswerValues(raw);
  return fallbackValues.length ? [{ id: questions[0]?.id || 'answer', values: fallbackValues }] : [];
}

function buildInteractionPresentation({ questions = [], answers = [], source = 'codex' } = {}) {
  const normalizedQuestions = normalizeInteractionQuestions(questions);
  const normalizedAnswers = normalizeInteractionAnswers(answers, normalizedQuestions);
  if (!normalizedQuestions.length && !normalizedAnswers.length) return null;
  return {
    mode: 'interaction',
    source,
    title: 'Interaction',
    interaction: {
      questions: normalizedQuestions,
      answers: normalizedAnswers,
    },
  };
}

function interactionTextFromPresentation(presentation = {}) {
  const interaction = presentation.interaction || {};
  const questions = asArray(interaction.questions);
  const answers = asArray(interaction.answers);
  const lines = [];
  for (const question of questions) {
    const label = question.header ? `${question.header}：` : '';
    lines.push(`Agent 提问：${label}${question.question || ''}`.trim());
  }
  for (const answer of answers) {
    const question = questions.find((item) => item.id === answer.id);
    const prefix = question?.header || question?.question || answer.id || '回答';
    lines.push(`用户回答：${prefix}：${asArray(answer.values).join('，')}`.trim());
  }
  return compactPresentationText(lines.join('\n'), 6000) || 'Agent asked for user input.';
}

function goalObjectiveFromPayload(value = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  return compactPresentationText(raw.objective || raw.goal?.objective || raw.goal || raw.title || '', 8000);
}

function goalStatusFromPayload(value = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  const status = compactPresentationText(raw.status || raw.goal?.status || '', 40).toLowerCase();
  return status || undefined;
}

function buildGoalPresentation({ objective = '', status = '', source = 'agent', objectiveMatchesUser = false, runtime = 'codex' } = {}) {
  const cleanObjective = compactPresentationText(objective, 8000);
  if (!cleanObjective) return null;
  return {
    mode: 'goal',
    source: runtime,
    title: 'Goal',
    goal: {
      objective: cleanObjective,
      ...(status ? { status: compactPresentationText(status, 40).toLowerCase() } : {}),
      source,
      objectiveMatchesUser: Boolean(objectiveMatchesUser),
    },
  };
}

function codexTextEvent(item, context) {
  if (item?.type === 'session_meta' && item.payload) {
    context.sessionId = context.sessionId || item.payload.id || item.payload.session_id || '';
    context.projectPath = context.projectPath || item.payload.cwd || '';
    context.title = context.title || item.payload.title || item.payload.thread_title || '';
    return null;
  }
  if (item?.type !== 'response_item') return null;
  const payload = item.payload || {};
  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
    pushUnique(context.toolNames, payload.name);
    return null;
  }
  if (payload.type !== 'message') return null;
  const role = String(payload.role || '').toLowerCase();
  if (!['user', 'assistant'].includes(role)) return null;
  const text = redactTeamSharingText(textFromContentBlocks(payload.content));
  if (!text) return null;
  return {
    role,
    text,
    createdAt: iso(item.timestamp),
    toolCalls: role === 'assistant' && context.toolNames.length
      ? context.toolNames.map((name) => ({ name }))
      : [],
  };
}

function claudeTextEvent(item, context) {
  const raw = item?.payload && typeof item.payload === 'object' ? item.payload : item;
  if (raw?.type === 'system' && raw.subtype === 'init') {
    context.sessionId = context.sessionId || raw.session_id || raw.sessionId || '';
    context.projectPath = context.projectPath || raw.cwd || '';
    return null;
  }
  if (raw?.type === 'assistant' || raw?.type === 'user') {
    const textBlocks = asArray(raw.message?.content)
      .map((block) => (block?.type === 'text' ? block.text : ''))
      .filter(Boolean);
    const text = redactTeamSharingText(textBlocks.join('\n\n'));
    if (!text) return null;
    return {
      role: raw.type === 'assistant' ? 'assistant' : 'user',
      text,
      createdAt: iso(item.timestamp || raw.timestamp),
      toolCalls: raw.type === 'assistant' && context.toolNames.length
        ? context.toolNames.map((name) => ({ name }))
        : [],
    };
  }
  for (const block of asArray(raw?.message?.content)) {
    if (block?.type === 'tool_use') pushUnique(context.toolNames, block.name);
  }
  return null;
}

function assignTranscriptEvent(events, sourceOrdinalRef, event = {}) {
  sourceOrdinalRef.value += 1;
  event.sourceOrdinal = sourceOrdinalRef.value;
  events.push(event);
  return event;
}

function latestUserTranscriptEvent(events = []) {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.role === 'user') return events[index];
  }
  return null;
}

function updateLastGoalStatus(goalEventRef, status = '') {
  const cleanStatus = compactPresentationText(status, 40).toLowerCase();
  const event = goalEventRef.current;
  if (!cleanStatus || !event?.presentation?.goal) return;
  event.presentation.goal.status = cleanStatus;
}

function emitCodexGoalEvent({
  events,
  sourceOrdinalRef,
  goalEventRef,
  runtime = 'codex',
  objective = '',
  status = '',
  createdAt = '',
} = {}) {
  const previousUser = latestUserTranscriptEvent(events);
  const matchesUser = previousUser && goalObjectiveMatchesUser(objective, previousUser.text);
  if (matchesUser) {
    previousUser.presentation = buildGoalPresentation({
      objective,
      status,
      source: 'user',
      objectiveMatchesUser: true,
      runtime,
    });
    goalEventRef.current = previousUser;
    return previousUser;
  }
  const presentation = buildGoalPresentation({
    objective,
    status,
    source: 'agent',
    objectiveMatchesUser: false,
    runtime,
  });
  if (!presentation) return null;
  const event = assignTranscriptEvent(events, sourceOrdinalRef, {
    role: 'assistant',
    text: presentation.goal.objective,
    createdAt,
    presentation,
  });
  goalEventRef.current = event;
  return event;
}

function extractCodexTranscriptEvents(parsed = [], context = {}) {
  const events = [];
  const sourceOrdinalRef = { value: 0 };
  const pendingCalls = new Map();
  const goalEventRef = { current: null };
  let goalActive = false;
  for (const item of parsed) {
    if (item?.type === 'session_meta' && item.payload) {
      context.sessionId = context.sessionId || item.payload.id || item.payload.session_id || '';
      context.projectPath = context.projectPath || item.payload.cwd || '';
      context.title = context.title || item.payload.title || item.payload.thread_title || '';
      continue;
    }
    if (item?.type !== 'response_item') continue;
    const payload = item.payload || {};
    const createdAt = iso(item.timestamp);
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      const name = String(payload.name || '').trim();
      pushUnique(context.toolNames, name);
      const callId = String(payload.call_id || payload.callId || payload.id || `${name}:${pendingCalls.size}`).trim();
      const args = parseJsonValue(payload.arguments, {});
      if (['request_user_input', 'create_goal', 'update_goal'].includes(name)) {
        pendingCalls.set(callId, { name, args, createdAt });
      }
      continue;
    }
    if (payload.type === 'function_call_output') {
      const callId = String(payload.call_id || payload.callId || payload.id || '').trim();
      const pending = pendingCalls.get(callId);
      const output = parseJsonValue(payload.output, {});
      if (pending?.name === 'request_user_input') {
        const presentation = buildInteractionPresentation({
          questions: pending.args?.questions || pending.args?.prompts || [],
          answers: output?.answers !== undefined ? output.answers : output,
          source: 'codex',
        });
        if (presentation) {
          assignTranscriptEvent(events, sourceOrdinalRef, {
            role: 'assistant',
            text: interactionTextFromPresentation(presentation),
            createdAt,
            presentation,
          });
        }
      } else if (pending?.name === 'create_goal') {
        const objective = goalObjectiveFromPayload(output) || goalObjectiveFromPayload(pending.args);
        const status = goalStatusFromPayload(output) || goalStatusFromPayload(pending.args);
        const event = emitCodexGoalEvent({
          events,
          sourceOrdinalRef,
          goalEventRef,
          runtime: 'codex',
          objective,
          status,
          createdAt,
        });
        if (event) goalActive = true;
      } else if (pending?.name === 'update_goal') {
        const status = goalStatusFromPayload(output) || goalStatusFromPayload(pending.args);
        updateLastGoalStatus(goalEventRef, status);
        if (['complete', 'completed', 'blocked'].includes(String(status || '').toLowerCase())) goalActive = false;
      }
      if (pending) pendingCalls.delete(callId);
      continue;
    }
    if (payload.type !== 'message') continue;
    const role = String(payload.role || '').toLowerCase();
    if (!['user', 'assistant'].includes(role)) continue;
    const text = redactTeamSharingText(textFromContentBlocks(payload.content));
    if (!text) continue;
    if (role === 'user') {
      if (isCodexImplementationPlanPrompt(text)) continue;
      const goalCommand = stripGoalCommandPrefix(text);
      assignTranscriptEvent(events, sourceOrdinalRef, {
        role,
        text: goalCommand.text,
        createdAt,
        toolCalls: [],
        isGoalRequest: goalCommand.isGoalRequest,
      });
      continue;
    }
    const proposedPlan = extractProposedPlanText(text);
    if (proposedPlan) {
      assignTranscriptEvent(events, sourceOrdinalRef, {
        role: 'assistant',
        text: proposedPlan,
        createdAt,
        toolCalls: [],
        presentation: {
          mode: 'plan',
          source: 'codex',
          title: 'Plan',
        },
      });
      continue;
    }
    assignTranscriptEvent(events, sourceOrdinalRef, {
      role,
      text,
      createdAt,
      keepAssistant: goalActive,
      toolCalls: context.toolNames.length ? context.toolNames.map((name) => ({ name })) : [],
    });
  }
  return events;
}

function claudeToolResultPayload(raw = {}, block = {}) {
  const direct = raw.toolUseResult ?? raw.tool_use_result ?? raw.result ?? null;
  if (direct !== null && direct !== undefined) return parseJsonValue(direct, direct);
  const content = block?.content;
  if (Array.isArray(content)) {
    const text = content.map((item) => (item?.type === 'text' ? item.text : item?.text || '')).filter(Boolean).join('\n');
    return parseJsonValue(text, text);
  }
  return parseJsonValue(content, content);
}

function emitClaudeToolResultEvent({
  pending,
  raw,
  block,
  events,
  sourceOrdinalRef,
  runtime = 'claude_code',
  createdAt = '',
} = {}) {
  if (!pending) return null;
  const result = claudeToolResultPayload(raw, block);
  if (pending.name === 'AskUserQuestion') {
    const presentation = buildInteractionPresentation({
      questions: pending.input?.questions || pending.input?.prompts || [],
      answers: (result && typeof result === 'object' && result.answers !== undefined) ? result.answers : result,
      source: runtime,
    });
    if (!presentation) return null;
    return assignTranscriptEvent(events, sourceOrdinalRef, {
      role: 'assistant',
      text: interactionTextFromPresentation(presentation),
      createdAt,
      presentation,
    });
  }
  if (pending.name === 'ExitPlanMode') {
    const approvedPlan = compactPresentationText(
      (result && typeof result === 'object' ? result.plan || result.toolUseResult?.plan : '')
        || pending.input?.plan
        || '',
      12000,
    );
    if (!approvedPlan) return null;
    return assignTranscriptEvent(events, sourceOrdinalRef, {
      role: 'assistant',
      text: approvedPlan,
      createdAt,
      presentation: {
        mode: 'plan',
        source: runtime,
        title: 'Plan',
      },
    });
  }
  return null;
}

function extractClaudeTranscriptEvents(parsed = [], context = {}) {
  const events = [];
  const sourceOrdinalRef = { value: 0 };
  const pendingToolUses = new Map();
  for (const item of parsed) {
    const raw = item?.payload && typeof item.payload === 'object' ? item.payload : item;
    const createdAt = iso(item.timestamp || raw.timestamp);
    if (raw?.type === 'system' && raw.subtype === 'init') {
      context.sessionId = context.sessionId || raw.session_id || raw.sessionId || '';
      context.projectPath = context.projectPath || raw.cwd || '';
      continue;
    }
    if (raw?.type === 'assistant') {
      const textBlocks = [];
      for (const block of asArray(raw.message?.content)) {
        if (block?.type === 'text' && block.text) {
          textBlocks.push(block.text);
          continue;
        }
        if (block?.type !== 'tool_use') continue;
        const name = String(block.name || '').trim();
        pushUnique(context.toolNames, name);
        if (['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode'].includes(name)) {
          pendingToolUses.set(String(block.id || block.tool_use_id || `${name}:${pendingToolUses.size}`), {
            name,
            input: block.input || {},
            createdAt,
          });
        }
      }
      const text = redactTeamSharingText(textBlocks.join('\n\n'));
      if (text) {
        assignTranscriptEvent(events, sourceOrdinalRef, {
          role: 'assistant',
          text,
          createdAt,
          toolCalls: context.toolNames.length ? context.toolNames.map((name) => ({ name })) : [],
        });
      }
      continue;
    }
    if (raw?.type === 'user') {
      const textBlocks = [];
      for (const block of asArray(raw.message?.content)) {
        if (block?.type === 'text' && block.text) {
          textBlocks.push(block.text);
          continue;
        }
        if (block?.type !== 'tool_result') continue;
        const toolUseId = String(block.tool_use_id || block.toolUseId || block.id || '').trim();
        const pending = pendingToolUses.get(toolUseId);
        emitClaudeToolResultEvent({
          pending,
          raw,
          block,
          events,
          sourceOrdinalRef,
          runtime: 'claude_code',
          createdAt,
        });
        if (pending) pendingToolUses.delete(toolUseId);
      }
      const text = redactTeamSharingText(textBlocks.join('\n\n'));
      if (!text) continue;
      const goalCommand = stripGoalCommandPrefix(text);
      const event = assignTranscriptEvent(events, sourceOrdinalRef, {
        role: 'user',
        text: goalCommand.text,
        createdAt,
        toolCalls: [],
        isGoalRequest: goalCommand.isGoalRequest,
      });
      if (goalCommand.isGoalRequest && goalCommand.text) {
        event.presentation = buildGoalPresentation({
          objective: goalCommand.text,
          source: 'user',
          objectiveMatchesUser: true,
          runtime: 'claude_code',
        });
      }
    }
  }
  return events;
}

function visibleTeamSharingTranscriptEvents(events = []) {
  const users = [];
  let finalAssistant = null;
  let latestUserOrdinal = 0;
  const forced = [];
  for (const event of events) {
    if (event.role === 'user') {
      users.push(event);
      latestUserOrdinal = Math.max(latestUserOrdinal, Number(event.sourceOrdinal || 0));
      continue;
    }
    if (event.presentation?.mode && event.presentation.mode !== 'normal') {
      forced.push(event);
      continue;
    }
    if (event.keepAssistant) {
      forced.push(event);
      continue;
    }
    if (event.role === 'assistant') finalAssistant = event;
  }
  const visible = [];
  const keptOrdinals = new Set();
  const keepEvent = (event) => {
    const ordinal = Number(event.sourceOrdinal || 0);
    if (keptOrdinals.has(ordinal)) return;
    visible.push(event);
    keptOrdinals.add(ordinal);
  };
  for (const event of users) keepEvent(event);
  for (const event of forced) keepEvent(event);
  if (finalAssistant && Number(finalAssistant.sourceOrdinal || 0) > latestUserOrdinal) {
    keepEvent(finalAssistant);
  }
  const hasDroppedAssistantBeforeUser = events.some((event) => {
    if (event.role !== 'assistant' || keptOrdinals.has(Number(event.sourceOrdinal || 0))) return false;
    return users.some((userEvent) => Number(userEvent.sourceOrdinal || 0) > Number(event.sourceOrdinal || 0));
  });
  return {
    events: visible.sort((left, right) => Number(left.sourceOrdinal || 0) - Number(right.sourceOrdinal || 0)),
    useSourceOrdinals: hasDroppedAssistantBeforeUser,
  };
}

export function parseTeamSharingTranscript(text = '', options = {}) {
  const runtime = normalizeRuntime(options.runtime);
  const parsed = parseJsonOrJsonl(text);
  const context = {
    runtime,
    sessionId: String(options.sessionId || '').trim(),
    projectPath: String(options.projectPath || options.projectDir || '').trim(),
    title: String(options.title || '').trim(),
    toolNames: [],
  };
  const extractedEvents = runtime === 'claude_code'
    ? extractClaudeTranscriptEvents(parsed, context)
    : extractCodexTranscriptEvents(parsed, context);
  const visibleTranscript = visibleTeamSharingTranscriptEvents(extractedEvents);
  const visibleEvents = visibleTranscript.events;
  const sessionSeed = context.sessionId || options.sessionId || 'session';
  const events = visibleEvents.map((event, index) => {
    const ordinal = visibleTranscript.useSourceOrdinals
      ? (Number(event.sourceOrdinal || 0) || index + 1)
      : index + 1;
    const eventId = `${sessionSeed}:${ordinal}:${stableHash(`${event.role}:${event.text}`)}`;
    return {
      eventId,
      rawEventId: eventId,
      ordinal,
      role: event.role,
      text: event.text,
      createdAt: event.createdAt,
      sourceHash: stableHash(event.text),
      sourceAnchor: `${sessionSeed}#${eventId}`,
      toolCalls: event.toolCalls,
      ...(event.presentation ? { presentation: event.presentation } : {}),
    };
  });
  if (!context.title) {
    context.title = `${runtime} session ${context.sessionId || stableHash(text)}`;
  }
  if (!context.sessionId) context.sessionId = stableHash(`${runtime}:${context.projectPath}:${text}`);
  return {
    runtime,
    sessionId: context.sessionId,
    projectPath: context.projectPath,
    title: context.title,
    toolNames: context.toolNames,
    events,
  };
}

export function buildTeamSharingSyncPackageFromTranscript(text = '', options = {}) {
  const runtime = normalizeRuntime(options.runtime);
  const parsed = parseTeamSharingTranscript(text, options);
  const lastOrdinal = Math.max(0, Number(options.lastOrdinal || 0));
  const minCreatedAt = String(options.minCreatedAt || '').trim();
  const projectKey = String(options.projectKey || path.basename(parsed.projectPath || process.cwd()) || 'default').trim();
  const incrementalEvents = parsed.events
    .filter((event) => Number(event.ordinal || 0) > lastOrdinal)
    .filter((event) => !minCreatedAt || String(event.createdAt || '') >= minCreatedAt);
  const hookEvent = String(options.hookEvent || options.hookEventName || '').trim();
  const shouldCreateSessionStart = hookEvent === 'SessionStart' && lastOrdinal === 0;
  if (!incrementalEvents.length) {
    if (shouldCreateSessionStart) {
      const createdAt = options.now?.() || new Date().toISOString();
      const body = {
        runtime,
        projectKey,
        projectPathHash: stableHash(parsed.projectPath || projectKey),
        sessionId: parsed.sessionId,
        title: options.title || parsed.title,
        workspaceId: options.workspaceId || '',
        channelId: options.channelId || '',
        channelPath: options.channelPath || '',
        fromOrdinal: 0,
        toOrdinal: 0,
        idempotencyKey: `${runtime}:${projectKey}:${parsed.sessionId}:session-start:${stableHash(options.title || parsed.title || '')}`,
        optionalLocalDigest: '',
        events: [],
        createdAt,
        metadata: {
          hookEvent,
          emptySessionStart: true,
        },
      };
      return {
        ok: true,
        empty: false,
        sessionStart: true,
        body,
        cursor: {
          runtime,
          sessionId: parsed.sessionId,
          lastOrdinal,
          updatedAt: createdAt,
        },
      };
    }
    return {
      ok: true,
      empty: true,
      body: null,
      cursor: {
        runtime,
        sessionId: parsed.sessionId,
        lastOrdinal,
      },
    };
  }
  const fromOrdinal = incrementalEvents[0].ordinal;
  const toOrdinal = incrementalEvents[incrementalEvents.length - 1].ordinal;
  const batchHash = stableHash(JSON.stringify(incrementalEvents.map((event) => ({
    eventId: event.eventId,
    sourceHash: event.sourceHash,
  }))));
  const body = {
    runtime,
    projectKey,
    projectPathHash: stableHash(parsed.projectPath || projectKey),
    sessionId: parsed.sessionId,
    title: options.title || parsed.title,
    workspaceId: options.workspaceId || '',
    channelId: options.channelId || '',
    channelPath: options.channelPath || '',
    fromOrdinal,
    toOrdinal,
    idempotencyKey: `${runtime}:${projectKey}:${parsed.sessionId}:${fromOrdinal}:${toOrdinal}:${batchHash}`,
    optionalLocalDigest: [
      options.localDigest || '',
      parsed.toolNames.length ? `Tool summary: ${parsed.toolNames.join(', ')}` : '',
    ].filter(Boolean).join('\n'),
    events: incrementalEvents,
    createdAt: options.now?.() || new Date().toISOString(),
  };
  return {
    ok: true,
    empty: false,
    body,
    cursor: {
      runtime,
      sessionId: parsed.sessionId,
      lastOrdinal: toOrdinal,
      lastEventId: incrementalEvents[incrementalEvents.length - 1].eventId,
      updatedAt: body.createdAt,
    },
  };
}

export function shouldRunTeamSharingHook({ runtime = 'codex', hookEventName = '' } = {}) {
  const normalized = normalizeRuntime(runtime);
  const event = String(hookEventName || '').trim();
  const allowed = normalized === 'claude_code' ? CLAUDE_HOOK_EVENTS : CODEX_HOOK_EVENTS;
  return allowed.includes(event);
}

function normalizeCommandPlatform(value = process.platform) {
  return String(value || '').toLowerCase() === 'win32' ? 'win32' : 'posix';
}

function posixShellQuote(value = '') {
  return `'${String(value || '').replace(/'/g, "'\\''")}'`;
}

function windowsCmdQuote(value = '') {
  const text = String(value || '');
  return `"${text.replace(/(["^&|<>])/g, '^$1')}"`;
}

function shellQuote(value = '', platform = process.platform) {
  return normalizeCommandPlatform(platform) === 'win32'
    ? windowsCmdQuote(value)
    : posixShellQuote(value);
}

function shouldQuoteCommandPath(value = '', platform = process.platform) {
  const text = String(value || '');
  if (!text) return false;
  if (normalizeCommandPlatform(platform) === 'win32') {
    return /[\s"&|<>^]/.test(text) || /[\\/]/.test(text);
  }
  return /[\s'"$`\\]/.test(text);
}

export function buildTeamSharingHookCommand(options = {}) {
  const runtime = normalizeRuntime(options.runtime);
  const platform = options.platform || process.platform;
  const hookEventName = String(options.hookEventName || (runtime === 'claude_code' ? 'SessionEnd' : 'Stop')).trim();
  const transcriptPath = String(options.transcriptPath || '').trim();
  const sessionTitle = String(options.sessionTitle ?? '').trim();
  const commandPath = String(options.teamSharingCommand || options.commandPath || 'team-sharing').trim() || 'team-sharing';
  const parts = [
    shouldQuoteCommandPath(commandPath, platform) ? shellQuote(commandPath, platform) : commandPath,
    'sync',
    '--runtime',
    runtime,
    '--hook-event',
    hookEventName,
  ];
  if (transcriptPath) parts.push('--transcript', shellQuote(transcriptPath, platform));
  if (sessionTitle) parts.push('--session-title', shellQuote(sessionTitle, platform));
  if (options.integration) parts.push('--integration', String(options.integration).replace(/[^a-zA-Z0-9._-]+/g, '-'));
  if (options.packageVersion) parts.push('--package-version', shellQuote(String(options.packageVersion).replace(/[^a-zA-Z0-9._+-]+/g, '-'), platform));
  if (options.sourceCommit) parts.push('--source-commit', shellQuote(String(options.sourceCommit).replace(/[^a-zA-Z0-9._-]+/g, '-'), platform));
  if (options.projectDir) parts.push('--cwd', shellQuote(options.projectDir, platform));
  return parts.join(' ');
}

function isTeamSharingHookCommand(command, runtime, hookEventName) {
  const text = String(command || '');
  const hasTeamSharingSync = (text.includes('team-sharing') && text.includes(' sync '))
    || text.includes('magclaw team-sharing sync');
  return hasTeamSharingSync
    && text.includes(`--runtime ${runtime}`)
    && text.includes(`--hook-event ${hookEventName}`);
}

function hookEventsForRuntime(runtime, templateConfig = null) {
  const templateEvents = templateConfig?.hooks && typeof templateConfig.hooks === 'object'
    ? Object.keys(templateConfig.hooks).filter(Boolean)
    : [];
  return templateEvents.length ? templateEvents : (normalizeRuntime(runtime) === 'claude_code' ? CLAUDE_HOOK_EVENTS : CODEX_HOOK_EVENTS);
}

async function readJson(file, fallback = {}) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function desiredTeamSharingHook(options = {}, runtime = 'codex', hookEventName = 'Stop') {
  const entries = asArray(options.templateConfig?.hooks?.[hookEventName]);
  for (const entry of entries) {
    for (const hook of asArray(entry?.hooks)) {
      const command = String(hook?.command || '').trim();
      if (!command) continue;
      return {
        type: hook.type || 'command',
        command,
        timeout: Number(hook.timeout || 0) || (hookEventName === 'SessionStart' ? 3 : 15),
      };
    }
  }
  return {
    type: 'command',
    command: buildTeamSharingHookCommand({ ...options, runtime, hookEventName }),
    timeout: hookEventName === 'SessionStart' ? 3 : 15,
  };
}

export async function installTeamSharingHookConfig(options = {}) {
  const runtime = normalizeRuntime(options.runtime);
  const configPath = String(options.configPath || '').trim();
  if (!configPath) throw new Error('configPath is required.');
  const config = await readJson(configPath, {});
  config.hooks = config.hooks && typeof config.hooks === 'object' ? config.hooks : {};
  const installed = [];
  for (const hookEventName of hookEventsForRuntime(runtime, options.templateConfig)) {
    const desiredHook = desiredTeamSharingHook(options, runtime, hookEventName);
    const command = desiredHook.command;
    const entries = asArray(config.hooks[hookEventName]);
    const entry = entries[0] || { hooks: [] };
    entry.hooks = asArray(entry.hooks);
    const existingHookIndex = entry.hooks.findIndex((hook) => isTeamSharingHookCommand(hook?.command, runtime, hookEventName));
    if (existingHookIndex >= 0) {
      entry.hooks[existingHookIndex] = {
        ...entry.hooks[existingHookIndex],
        type: entry.hooks[existingHookIndex].type || desiredHook.type || 'command',
        command,
        timeout: entry.hooks[existingHookIndex].timeout || desiredHook.timeout,
      };
    } else {
      entry.hooks.push(desiredHook);
      installed.push(hookEventName);
    }
    config.hooks[hookEventName] = entries.length ? entries : [entry];
  }
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return {
    ok: true,
    runtime,
    configPath,
    installed,
  };
}
