import crypto from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildTeamSharingPrivacyContext,
  redactTeamSharingLocalText,
} from './team-sharing-privacy.js';

const CODEX_HOOK_EVENTS = Object.freeze(['Stop', 'PreCompact', 'SessionStart']);
const CLAUDE_HOOK_EVENTS = Object.freeze(['Stop', 'SessionEnd', 'PreCompact', 'SessionStart']);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function stableHash(value = '') {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function redactTeamSharingText(value = '', context = {}) {
  return redactTeamSharingLocalText(value, context).trim();
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
  return clean.startsWith('# AGENTS.md instructions')
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

function claudeTextBlocksFromContent(content) {
  if (typeof content === 'string') return [content];
  return asArray(content)
    .map((block) => {
      if (typeof block === 'string') return block;
      return block?.type === 'text' ? block.text || '' : '';
    })
    .filter(Boolean);
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

function compactPresentationText(value = '', limit = 4000, context = {}) {
  return redactTeamSharingText(value, context).slice(0, limit).trim();
}

function maskSessionIdForTitle(value = '') {
  const clean = String(value || '').trim();
  if (!clean) return '****';
  if (clean.length <= 8) return clean.length <= 4 ? '****' : `${clean.slice(0, 2)}****${clean.slice(-2)}`;
  const visibleStart = 8;
  const visibleEnd = 6;
  if (clean.length <= visibleStart + visibleEnd) return `${clean.slice(0, 3)}****${clean.slice(-3)}`;
  return `${clean.slice(0, visibleStart)}****${clean.slice(-visibleEnd)}`;
}

function fallbackSessionTitle(runtime = 'codex', sessionId = '', seed = '') {
  const identifier = String(sessionId || '').trim() || stableHash(seed);
  return `${normalizeRuntime(runtime)} session ${maskSessionIdForTitle(identifier)}`;
}

function codexSessionTitleFromPayload(payload = {}, context = {}) {
  if (!payload || typeof payload !== 'object') return '';
  const candidates = [
    payload.thread_name,
    payload.threadName,
    payload.session_name,
    payload.sessionName,
    payload.session_title,
    payload.sessionTitle,
    payload.conversation_title,
    payload.conversationTitle,
    payload.thread_title,
    payload.threadTitle,
    payload.title,
    payload.name,
  ];
  for (const candidate of candidates) {
    const title = compactPresentationText(candidate, 180, context);
    if (title) return title;
  }
  return '';
}

function extractProposedPlanText(value = '', context = {}) {
  const match = String(value || '').match(/<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i);
  return match ? compactPresentationText(match[1], 12000, context) : '';
}

function decodeInternalContextMarkup(value = '') {
  return String(value || '')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'");
}

function extractCodexGoalInternalContext(value = '') {
  const text = decodeInternalContextMarkup(value);
  const openTag = text.match(/<codex_internal_context\b[^>]*>/i);
  if (!openTag) return null;
  if (!/\bsource\s*=\s*(?:"goal"|'goal'|goal)/i.test(openTag[0])) return null;
  const bodyStart = Number(openTag.index || 0) + openTag[0].length;
  const body = text.slice(bodyStart).replace(/<\/codex_internal_context>[\s\S]*$/i, '');
  const objectiveMatch = body.match(/<objective>\s*([\s\S]*?)\s*<\/objective>/i);
  const objective = objectiveMatch ? compactPresentationText(objectiveMatch[1], 8000) : '';
  return objective ? { objective } : null;
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

function claudeSkillArgumentsText(value = '') {
  const text = String(value || '').replace(/\r\n/g, '\n').trim();
  if (!text.startsWith('Base directory for this skill:')) return '';
  const match = text.match(/(?:^|\n)\s*ARGUMENTS:\s*([\s\S]*)$/i);
  return match ? compactPresentationText(match[1], 8000) : '';
}

function claudeVisibleUserText(value = '') {
  const skillArguments = claudeSkillArgumentsText(value);
  return skillArguments || String(value || '').trim();
}

function claudeSessionTitleFromEvents(events = []) {
  const userEvent = events.find((event) => event?.role === 'user' && event.text);
  const title = compactPresentationText(userEvent?.text || '', 96)
    .replace(/\s+/g, ' ')
    .replace(/^#+\s*/, '')
    .trim();
  return title;
}

function rememberClaudeContext(raw = {}, item = {}, context = {}) {
  context.sessionId = context.sessionId || raw.session_id || raw.sessionId || item.sessionId || '';
  context.projectPath = context.projectPath || raw.cwd || item.cwd || '';
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

function buildGoalReplyPresentation({ objective = '', runtime = 'codex' } = {}) {
  const presentation = buildGoalPresentation({
    objective,
    source: 'agent',
    objectiveMatchesUser: false,
    runtime,
  });
  if (!presentation) return null;
  presentation.goal.reply = true;
  return presentation;
}

function activeGoalObjective(goalEventRef = {}) {
  return compactPresentationText(goalEventRef.current?.presentation?.goal?.objective || '', 8000);
}

function codexResponseItemPhase(item = {}, payload = {}) {
  return compactPresentationText(payload.phase || item.phase || '', 80).toLowerCase();
}

function isCodexCommentaryPhase(phase = '') {
  return phase === 'commentary';
}

function isCodexFinalAnswerPhase(phase = '') {
  return phase === 'final_answer' || phase === 'final';
}

function codexTextEvent(item, context) {
  if (item?.type === 'session_meta' && item.payload) {
    context.sessionId = context.sessionId || item.payload.id || item.payload.session_id || '';
    context.projectPath = context.projectPath || item.payload.cwd || '';
    context.title = context.title || codexSessionTitleFromPayload(item.payload, context.privacy);
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
  const text = redactTeamSharingText(textFromContentBlocks(payload.content), context.privacy);
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
  rememberClaudeContext(raw, item, context);
  if (raw?.type === 'system' && raw.subtype === 'init') {
    return null;
  }
  if (raw?.type === 'assistant' || raw?.type === 'user') {
    const textBlocks = claudeTextBlocksFromContent(raw.message?.content);
    const rawText = textBlocks.join('\n\n');
    const text = redactTeamSharingText(raw.type === 'user' ? claudeVisibleUserText(rawText) : rawText, context.privacy);
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
  if (Number(event.sourceOrdinal || 0) > 0) {
    sourceOrdinalRef.value = Math.max(sourceOrdinalRef.value, Number(event.sourceOrdinal || 0));
  } else {
    sourceOrdinalRef.value += 1;
    event.sourceOrdinal = sourceOrdinalRef.value;
  }
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
  sourceOrdinal = 0,
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
    sourceOrdinal,
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
  for (const item of parsed) {
    if (item?.type === 'session_meta' && item.payload) {
      context.sessionId = context.sessionId || item.payload.id || item.payload.session_id || '';
      context.projectPath = context.projectPath || item.payload.cwd || '';
      context.title = context.title || codexSessionTitleFromPayload(item.payload, context.privacy);
      continue;
    }
    if (item?.type !== 'response_item') continue;
    sourceOrdinalRef.value += 1;
    const sourceOrdinal = sourceOrdinalRef.value;
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
            sourceOrdinal,
            role: 'assistant',
            text: interactionTextFromPresentation(presentation),
            createdAt,
            presentation,
          });
        }
      } else if (pending?.name === 'create_goal') {
        const objective = goalObjectiveFromPayload(output) || goalObjectiveFromPayload(pending.args);
        const status = goalStatusFromPayload(output) || goalStatusFromPayload(pending.args);
        emitCodexGoalEvent({
          events,
          sourceOrdinalRef,
          goalEventRef,
          runtime: 'codex',
          objective,
          status,
          createdAt,
          sourceOrdinal,
        });
      } else if (pending?.name === 'update_goal') {
        const status = goalStatusFromPayload(output) || goalStatusFromPayload(pending.args);
        updateLastGoalStatus(goalEventRef, status);
      }
      if (pending) pendingCalls.delete(callId);
      continue;
    }
    if (payload.type !== 'message') continue;
    const role = String(payload.role || '').toLowerCase();
    if (!['user', 'assistant'].includes(role)) continue;
    const phase = codexResponseItemPhase(item, payload);
    if (role === 'assistant' && isCodexCommentaryPhase(phase)) continue;
    const text = redactTeamSharingText(textFromContentBlocks(payload.content), context.privacy);
    if (!text) continue;
    if (role === 'user') {
      if (isCodexImplementationPlanPrompt(text)) continue;
      const goalContext = extractCodexGoalInternalContext(text);
      if (goalContext) {
        const event = assignTranscriptEvent(events, sourceOrdinalRef, {
          sourceOrdinal,
          role,
          text: goalContext.objective,
          createdAt,
          toolCalls: [],
          hidden: true,
          isGoalRequest: true,
          presentation: buildGoalPresentation({
            objective: goalContext.objective,
            source: 'user',
            objectiveMatchesUser: true,
            runtime: 'codex',
          }),
        });
        goalEventRef.current = event;
        continue;
      }
      const goalCommand = stripGoalCommandPrefix(text);
      const event = assignTranscriptEvent(events, sourceOrdinalRef, {
        sourceOrdinal,
        role,
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
          runtime: 'codex',
        });
        goalEventRef.current = event;
      } else {
        goalEventRef.current = null;
      }
      continue;
    }
    const proposedPlan = extractProposedPlanText(text, context.privacy);
    if (proposedPlan) {
      assignTranscriptEvent(events, sourceOrdinalRef, {
        sourceOrdinal,
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
    const goalReplyPresentation = buildGoalReplyPresentation({
      objective: activeGoalObjective(goalEventRef),
      runtime: 'codex',
    });
    assignTranscriptEvent(events, sourceOrdinalRef, {
      sourceOrdinal,
      role,
      text,
      createdAt,
      keepAssistant: isCodexFinalAnswerPhase(phase),
      toolCalls: context.toolNames.length ? context.toolNames.map((name) => ({ name })) : [],
      ...(goalReplyPresentation ? { presentation: goalReplyPresentation } : {}),
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
    rememberClaudeContext(raw, item, context);
    if (raw?.type === 'system' && raw.subtype === 'init') {
      continue;
    }
    if (raw?.type === 'assistant') {
      const textBlocks = claudeTextBlocksFromContent(raw.message?.content);
      for (const block of asArray(raw.message?.content)) {
        if (block?.type === 'text' && block.text) {
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
      const text = redactTeamSharingText(textBlocks.join('\n\n'), context.privacy);
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
      const textBlocks = claudeTextBlocksFromContent(raw.message?.content);
      for (const block of asArray(raw.message?.content)) {
        if (block?.type === 'text' && block.text) {
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
      const text = redactTeamSharingText(claudeVisibleUserText(textBlocks.join('\n\n')), context.privacy);
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
    if (event.hidden) {
      continue;
    }
    if (event.role === 'user') {
      users.push(event);
      latestUserOrdinal = Math.max(latestUserOrdinal, Number(event.sourceOrdinal || 0));
      continue;
    }
    if (event.presentation?.mode && event.presentation.mode !== 'normal') {
      if (event.presentation.mode !== 'goal' || !event.presentation.goal?.reply) {
        forced.push(event);
        continue;
      }
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
  return {
    events: visible.sort((left, right) => Number(left.sourceOrdinal || 0) - Number(right.sourceOrdinal || 0)),
  };
}

export function parseTeamSharingTranscript(text = '', options = {}) {
  const runtime = normalizeRuntime(options.runtime);
  const parsed = parseJsonOrJsonl(text);
  const privacy = buildTeamSharingPrivacyContext({
    projectDir: options.projectDir,
    projectPath: options.projectPath,
    cwd: options.cwd,
    env: options.env,
  });
  const context = {
    runtime,
    sessionId: String(options.sessionId || '').trim(),
    projectPath: String(options.projectPath || options.projectDir || '').trim(),
    title: redactTeamSharingText(String(options.title || '').trim(), privacy),
    toolNames: [],
    privacy,
  };
  const extractedEvents = runtime === 'claude_code'
    ? extractClaudeTranscriptEvents(parsed, context)
    : extractCodexTranscriptEvents(parsed, context);
  const visibleTranscript = visibleTeamSharingTranscriptEvents(extractedEvents);
  const visibleEvents = visibleTranscript.events;
  if (!context.title && runtime === 'claude_code') {
    context.title = claudeSessionTitleFromEvents(visibleEvents);
  }
  const sessionSeed = context.sessionId || options.sessionId || 'session';
  const events = visibleEvents.map((event, index) => {
    const ordinal = Number(event.sourceOrdinal || 0) || index + 1;
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
    context.title = fallbackSessionTitle(runtime, context.sessionId, text);
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
  const privacy = buildTeamSharingPrivacyContext({
    projectDir: options.projectDir,
    projectPath: options.projectPath,
    cwd: options.cwd,
    env: options.env,
  });
  const parsed = parseTeamSharingTranscript(text, options);
  const lastOrdinal = Math.max(0, Number(options.lastOrdinal || 0));
  const minCreatedAt = String(options.minCreatedAt || '').trim();
  const projectKey = String(options.projectKey || path.basename(parsed.projectPath || process.cwd()) || 'default').trim();
  const title = redactTeamSharingText(options.title || parsed.title, privacy);
  const incrementalEvents = parsed.events
    .filter((event) => Number(event.ordinal || 0) > lastOrdinal)
    .filter((event) => !minCreatedAt || String(event.createdAt || '') >= minCreatedAt);
  const hookEvent = String(options.hookEvent || options.hookEventName || '').trim();
  const shouldCreateSessionStart = hookEvent === 'SessionStart' && lastOrdinal === 0;
  if (!incrementalEvents.length) {
    if (shouldCreateSessionStart) {
      const createdAt = options.now?.() || new Date().toISOString();
      return {
        ok: true,
        empty: true,
        reason: 'empty_session_start',
        body: null,
        cursor: {
          runtime,
          sessionId: parsed.sessionId,
          lastOrdinal,
          updatedAt: createdAt,
        },
      };
    }
    if (hookEvent && title) {
      const createdAt = options.now?.() || new Date().toISOString();
      const body = {
        runtime,
        projectKey,
        projectPathHash: stableHash(parsed.projectPath || projectKey),
        sessionId: parsed.sessionId,
        title,
        workspaceId: options.workspaceId || '',
        channelId: options.channelId || '',
        channelPath: options.channelPath || '',
        fromOrdinal: lastOrdinal,
        toOrdinal: lastOrdinal,
        idempotencyKey: `${runtime}:${projectKey}:${parsed.sessionId}:title:${lastOrdinal}:${stableHash(title || '')}`,
        optionalLocalDigest: '',
        events: [],
        createdAt,
        metadata: {
          hookEvent,
          titleOnly: true,
        },
      };
      return {
        ok: true,
        empty: false,
        titleOnly: true,
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
    title,
    workspaceId: options.workspaceId || '',
    channelId: options.channelId || '',
    channelPath: options.channelPath || '',
    fromOrdinal,
    toOrdinal,
    idempotencyKey: `${runtime}:${projectKey}:${parsed.sessionId}:${fromOrdinal}:${toOrdinal}:${batchHash}`,
    optionalLocalDigest: [
      redactTeamSharingText(options.localDigest || '', privacy),
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

function windowsPowerShellQuote(value = '') {
  return `'${String(value || '').replace(/'/g, "''")}'`;
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

export function buildTeamSharingWindowsHookCommand(options = {}) {
  const runtime = normalizeRuntime(options.runtime);
  const hookEventName = String(options.hookEventName || (runtime === 'claude_code' ? 'SessionEnd' : 'Stop')).trim();
  const transcriptPath = String(options.transcriptPath || '').trim();
  const sessionTitle = String(options.sessionTitle ?? '').trim();
  const commandPath = String(options.teamSharingCommand || options.commandPath || 'team-sharing').trim() || 'team-sharing';
  const parts = [
    '&',
    windowsPowerShellQuote(commandPath),
    'sync',
    '--runtime',
    windowsPowerShellQuote(runtime),
    '--hook-event',
    windowsPowerShellQuote(hookEventName),
  ];
  if (transcriptPath) parts.push('--transcript', windowsPowerShellQuote(transcriptPath));
  if (sessionTitle) parts.push('--session-title', windowsPowerShellQuote(sessionTitle));
  if (options.integration) parts.push('--integration', windowsPowerShellQuote(String(options.integration).replace(/[^a-zA-Z0-9._-]+/g, '-')));
  if (options.packageVersion) parts.push('--package-version', windowsPowerShellQuote(String(options.packageVersion).replace(/[^a-zA-Z0-9._+-]+/g, '-')));
  if (options.sourceCommit) parts.push('--source-commit', windowsPowerShellQuote(String(options.sourceCommit).replace(/[^a-zA-Z0-9._-]+/g, '-')));
  if (options.projectDir) parts.push('--cwd', windowsPowerShellQuote(options.projectDir));
  return parts.join(' ');
}

function hookCommandCandidates(hook = {}) {
  return [
    hook?.command,
    hook?.commandWindows,
    hook?.command_windows,
  ].map((value) => String(value || '').trim()).filter(Boolean);
}

function isTeamSharingHookCommand(hook, runtime, hookEventName) {
  return hookCommandCandidates(hook).some((command) => isTeamSharingHookCommandText(command, runtime, hookEventName));
}

function escapedRegExp(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasHookFlag(command = '', name = '', value = '') {
  return new RegExp(`--${escapedRegExp(name)}\\s+(?:"${escapedRegExp(value)}"|'${escapedRegExp(value)}'|${escapedRegExp(value)})(?:\\s|$)`).test(String(command || ''));
}

function isTeamSharingHookCommandText(command, runtime, hookEventName) {
  const text = String(command || '');
  const hasTeamSharingSync = (text.includes('team-sharing') && text.includes(' sync '))
    || text.includes('magclaw team-sharing sync');
  return hasTeamSharingSync
    && hasHookFlag(text, 'runtime', runtime)
    && hasHookFlag(text, 'hook-event', hookEventName);
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
        ...(hook.commandWindows ? { commandWindows: String(hook.commandWindows) } : {}),
        ...(hook.command_windows ? { command_windows: String(hook.command_windows) } : {}),
        timeout: Number(hook.timeout || 0) || (hookEventName === 'SessionStart' ? 3 : 15),
      };
    }
  }
  const desired = {
    type: 'command',
    command: buildTeamSharingHookCommand({ ...options, runtime, hookEventName }),
    timeout: hookEventName === 'SessionStart' ? 3 : 15,
  };
  if (normalizeRuntime(runtime) === 'codex' && normalizeCommandPlatform(options.platform || process.platform) === 'win32') {
    desired.commandWindows = buildTeamSharingWindowsHookCommand({ ...options, runtime, hookEventName });
  }
  return desired;
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
    const existingHookIndex = entry.hooks.findIndex((hook) => isTeamSharingHookCommand(hook, runtime, hookEventName));
    if (existingHookIndex >= 0) {
      const nextHook = {
        ...entry.hooks[existingHookIndex],
        type: entry.hooks[existingHookIndex].type || desiredHook.type || 'command',
        command,
        timeout: entry.hooks[existingHookIndex].timeout || desiredHook.timeout,
      };
      if (desiredHook.commandWindows) nextHook.commandWindows = desiredHook.commandWindows;
      else delete nextHook.commandWindows;
      if (desiredHook.command_windows) nextHook.command_windows = desiredHook.command_windows;
      else delete nextHook.command_windows;
      entry.hooks[existingHookIndex] = nextHook;
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
