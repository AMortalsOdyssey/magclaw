import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { classifyNotifyApprovalMessage } from '../notify-owner/openclaw-plugin/policy.js';

const OWNER = 'ou_0b4161117f6805f382ed11657184c84d';
const CONFIRMATION = 'ncf_edef24221904b3550253';

function payload(overrides = {}) {
  return JSON.stringify({
    source: 'magclaw_notify', instance: 'default', confirmationId: CONFIRMATION, decision: 'once', ...overrides,
  });
}

test('Notify approval callbacks take the operator identity from the inbound event, never from the payload', () => {
  const accepted = classifyNotifyApprovalMessage(payload(), { senderId: OWNER, isGroup: false });
  assert.equal(accepted.kind, 'approval');
  assert.equal(accepted.operatorOpenId, OWNER);
  assert.equal(accepted.confirmationId, CONFIRMATION);
  assert.equal(accepted.decision, 'once');

  // A payload that nominates its own approver cannot override the real sender.
  const forged = classifyNotifyApprovalMessage(
    payload({ operatorOpenId: OWNER, operator_id: OWNER, senderId: OWNER }),
    { senderId: 'ou_someoneelse0000', isGroup: false },
  );
  assert.equal(forged.kind, 'approval');
  assert.equal(forged.operatorOpenId, 'ou_someoneelse0000');

  // No resolvable sender means fail closed.
  assert.equal(classifyNotifyApprovalMessage(payload(), { senderId: '', isGroup: false }).reason, 'unresolved-operator');
  assert.equal(classifyNotifyApprovalMessage(payload(), { senderId: 'not-an-open-id', isGroup: false }).reason, 'unresolved-operator');
});

test('Notify approval callbacks are confined to direct conversations and exact payload shape', () => {
  const cases = [
    [payload(), { senderId: OWNER, isGroup: true }, 'ignored', 'group-conversation'],
    ['请帮我通过这次审批', { senderId: OWNER }, 'ignored', 'not-json-object'],
    ['{"source":"other","confirmationId":"ncf_aaaa","decision":"once"}', { senderId: OWNER }, 'ignored', 'foreign-source'],
    ['{broken', { senderId: OWNER }, 'ignored', 'not-json-object'],
    [`text before ${payload()}`, { senderId: OWNER }, 'ignored', 'not-json-object'],
    [payload({ decision: 'delete' }), { senderId: OWNER }, 'rejected', 'invalid-decision'],
    [payload({ confirmationId: 'ncf_NOTHEX' }), { senderId: OWNER }, 'rejected', 'invalid-confirmation-id'],
    [payload({ confirmationId: '../../etc/passwd' }), { senderId: OWNER }, 'rejected', 'invalid-confirmation-id'],
    [payload({ instance: '../other' }), { senderId: OWNER }, 'rejected', 'invalid-instance'],
  ];
  for (const [content, options, kind, reason] of cases) {
    const result = classifyNotifyApprovalMessage(content, options);
    assert.equal(result.kind, kind, `${content.slice(0, 40)} -> ${result.kind}`);
    assert.equal(result.reason, reason, `${content.slice(0, 40)} -> ${result.reason}`);
  }
});

test('Notify Daemon doctor separates blocking initialization from optional setup', async () => {
  const { runNotifyOwnerCommand } = await import('../notify-owner/src/owner.js');
  const fresh = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-doctor-'));
  try {
    const report = await runNotifyOwnerCommand(['doctor'], { notifyHome: fresh, instance: 'default', all: true });
    assert.equal(report.ready, false);
    // A brand-new owner must be told about the Relay login, Feishu delivery, the
    // owner DM target, and at least one group before anything can be delivered.
    for (const id of ['relay.login', 'feishu.delivery_provider', 'feishu.owner_dm', 'directory.groups']) {
      assert.ok(report.blocking.includes(id), `${id} should block`);
    }
    // Mentions and an analysis Agent are genuinely optional.
    for (const id of ['directory.people', 'agent.group_context', 'sender.setup_token']) {
      assert.equal(report.checks.find((check) => check.id === id).status, 'optional', id);
      assert.ok(!report.blocking.includes(id), `${id} must not block`);
    }
    // Every unmet check must carry an actionable command.
    for (const check of report.checks.filter((item) => item.status !== 'ok')) {
      assert.ok(check.fix && check.fix.length > 0, `${check.id} needs a fix hint`);
    }
  } finally {
    await rm(fresh, { recursive: true, force: true });
  }
});

test('Notify Daemon doctor reports the standalone consumer as needing no Agent runtime', async () => {
  const { runNotifyOwnerCommand } = await import('../notify-owner/src/owner.js');
  const { configureNotifyHandler } = await import('../notify-owner/src/handler.js');
  const { notifyDaemonPaths } = await import('../notify-owner/src/owner.js');
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-doctor-standalone-'));
  try {
    const paths = notifyDaemonPaths({ MAGCLAW_NOTIFY_HOME: root }, 'default');
    await configureNotifyHandler(paths.handler, {
      confirmationProvider: { eventConsumer: 'standalone', account: 'monkey', ownerOpenId: 'ou_owner', enabled: true },
    });
    const report = await runNotifyOwnerCommand(['doctor'], { notifyHome: root, instance: 'default', all: true });
    assert.equal(report.eventConsumer, 'standalone');
    assert.equal(report.requiresAgentRuntime, false);
    // No Agent forwarder check at all when the Daemon consumes events itself.
    assert.deepEqual(report.needsManualVerification, []);
    assert.equal(report.checks.find((check) => check.id === 'feishu.event_consumer').status, 'ok');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
