function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function clean(value) {
  return String(value || '').trim();
}

function actionAllowed(grant, action) {
  const actions = asArray(grant?.actions).map((item) => clean(item).toLowerCase()).filter(Boolean);
  if (!actions.length) return action === 'read';
  return actions.includes('all') || actions.includes(action) || (action === 'read' && actions.includes('summarize'));
}

function grantActive(grant) {
  return clean(grant?.status || 'active') === 'active' && !grant?.revokedAt;
}

function targetCovered(sourceTarget, requestedTarget) {
  const source = clean(sourceTarget);
  const requested = clean(requestedTarget);
  if (!source || !requested) return false;
  if (source === requested) return true;
  return requested.startsWith(`${source}:`);
}

export function normalizeConversationGrant(grant = {}) {
  return {
    id: clean(grant.id),
    workspaceId: clean(grant.workspaceId),
    grantorHumanId: clean(grant.grantorHumanId),
    agentId: clean(grant.agentId),
    sourceTarget: clean(grant.sourceTarget),
    allowedRecipients: asArray(grant.allowedRecipients || grant.allowedRecipientIds).map(clean).filter(Boolean),
    allowedTargets: asArray(grant.allowedTargets).map(clean).filter(Boolean),
    actions: asArray(grant.actions?.length ? grant.actions : ['read', 'summarize']).map(clean).filter(Boolean),
    status: clean(grant.status || 'active') || 'active',
    sourceMessageId: clean(grant.sourceMessageId) || null,
    scopeText: clean(grant.scopeText || grant.sourceText),
    createdAt: clean(grant.createdAt),
    updatedAt: clean(grant.updatedAt) || null,
    revokedAt: clean(grant.revokedAt) || null,
  };
}

export function conversationGrantAllowsRead(state, {
  agentId = '',
  workspaceId = '',
  target = '',
} = {}) {
  const requestedAgentId = clean(agentId);
  const requestedWorkspaceId = clean(workspaceId);
  const requestedTarget = clean(target);
  if (!requestedAgentId || !requestedTarget) return false;
  return asArray(state?.conversationGrants)
    .map(normalizeConversationGrant)
    .some((grant) => (
      grantActive(grant)
      && grant.agentId === requestedAgentId
      && (!requestedWorkspaceId || !grant.workspaceId || grant.workspaceId === requestedWorkspaceId)
      && actionAllowed(grant, 'read')
      && (
        targetCovered(grant.sourceTarget, requestedTarget)
        || grant.allowedTargets.some((allowedTarget) => targetCovered(allowedTarget, requestedTarget))
      )
    ));
}

const DISCLOSURE_GRANT_PATTERNS = [
  /(授权|允许|准许).{0,30}(告诉|转述|分享|复述|说明|说给|讲给)/i,
  /(可以|以后可以|之后可以).{0,30}(告诉|转述|分享|复述|说给|讲给)/i,
  /(你可以).{0,30}(告诉他|告诉她|告诉他们|转述|分享)/i,
];

const DISCLOSURE_REVOKE_PATTERNS = [
  /(撤销|取消|收回).{0,30}(授权|允许|权限)/i,
  /(不要|不能|不许).{0,30}(再)?(告诉|转述|分享|复述)/i,
];

export function inferConversationDisclosureGrant(text) {
  const raw = clean(text);
  if (!raw) return null;
  const hasGrant = DISCLOSURE_GRANT_PATTERNS.some((pattern) => pattern.test(raw));
  const hasRevoke = DISCLOSURE_REVOKE_PATTERNS.some((pattern) => pattern.test(raw));
  const hasExplicitRevokeVerb = /(撤销|取消|收回)/.test(raw);
  if (hasRevoke && (!hasGrant || hasExplicitRevokeVerb)) {
    return { intent: 'revoke', sourceText: raw };
  }
  if (hasGrant) {
    return {
      intent: 'grant',
      actions: ['read', 'summarize'],
      sourceText: raw,
      summary: '用户持续授权 Agent 在受控范围内总结/转述这段私聊内容。',
    };
  }
  return null;
}

export function recordConversationGrant(state, grant, {
  makeId = (prefix) => `${prefix}_${Date.now().toString(36)}`,
  now = () => new Date().toISOString(),
} = {}) {
  if (!state || !grant?.agentId || !grant?.sourceTarget) return null;
  state.conversationGrants = Array.isArray(state.conversationGrants) ? state.conversationGrants : [];
  const timestamp = now();
  const existing = state.conversationGrants.find((item) => (
    item.agentId === grant.agentId
    && item.sourceTarget === grant.sourceTarget
    && item.grantorHumanId === grant.grantorHumanId
    && String(item.status || 'active') === 'active'
    && !item.revokedAt
  ));
  if (grant.intent === 'revoke') {
    if (!existing) return null;
    existing.status = 'revoked';
    existing.revokedAt = timestamp;
    existing.updatedAt = timestamp;
    return existing;
  }
  if (existing) {
    existing.actions = asArray(grant.actions?.length ? grant.actions : existing.actions);
    existing.scopeText = clean(grant.scopeText || grant.sourceText || existing.scopeText);
    existing.updatedAt = timestamp;
    return existing;
  }
  const record = normalizeConversationGrant({
    id: makeId('grant'),
    workspaceId: grant.workspaceId,
    grantorHumanId: grant.grantorHumanId,
    agentId: grant.agentId,
    sourceTarget: grant.sourceTarget,
    allowedRecipients: grant.allowedRecipients || [],
    allowedTargets: grant.allowedTargets || [],
    actions: grant.actions?.length ? grant.actions : ['read', 'summarize'],
    status: 'active',
    sourceMessageId: grant.sourceMessageId || null,
    scopeText: grant.scopeText || grant.sourceText || '',
    createdAt: timestamp,
  });
  state.conversationGrants.push(record);
  return record;
}
