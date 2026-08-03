const DECISIONS = new Set(['once', 'always', 'approve', 'reject']);
const INSTANCE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const CONFIRMATION_PATTERN = /^ncf_[a-f0-9]{4,64}$/;
const OPERATOR_PATTERN = /^ou_[A-Za-z0-9]{4,180}$/;

/**
 * Classifies one inbound Feishu message as a MagClaw Notify approval callback.
 *
 * The card payload is untrusted: it only selects which stored confirmation is
 * being decided. The operator identity is never read from it — callers must pass
 * the sender id OpenClaw resolved from the inbound event.
 */
export function classifyNotifyApprovalMessage(input, options = {}) {
  if (options.isGroup === true) {
    return { kind: 'ignored', reason: 'group-conversation' };
  }
  const body = typeof input === 'string' ? input.trim() : '';
  if (!body.startsWith('{') || !body.endsWith('}')) {
    return { kind: 'ignored', reason: 'not-json-object' };
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return { kind: 'ignored', reason: 'invalid-json' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { kind: 'ignored', reason: 'not-json-object' };
  }
  if (payload.source !== 'magclaw_notify') {
    return { kind: 'ignored', reason: 'foreign-source' };
  }
  const instance = String(payload.instance ?? 'default');
  const confirmationId = String(payload.confirmationId ?? '');
  const decision = String(payload.decision ?? '');
  if (!INSTANCE_PATTERN.test(instance)) {
    return { kind: 'rejected', reason: 'invalid-instance' };
  }
  if (!CONFIRMATION_PATTERN.test(confirmationId)) {
    return { kind: 'rejected', reason: 'invalid-confirmation-id' };
  }
  if (!DECISIONS.has(decision)) {
    return { kind: 'rejected', reason: 'invalid-decision' };
  }
  const operatorOpenId = String(options.senderId ?? '');
  if (!OPERATOR_PATTERN.test(operatorOpenId)) {
    // OpenClaw could not resolve a usable sender for this event. Fail closed
    // rather than letting the card payload nominate its own approver.
    return { kind: 'rejected', reason: 'unresolved-operator' };
  }
  return { kind: 'approval', instance, confirmationId, decision, operatorOpenId };
}

export { DECISIONS as NOTIFY_APPROVAL_DECISIONS };
