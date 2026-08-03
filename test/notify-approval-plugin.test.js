import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { classifyNotifyApprovalMessage } from '../notify-daemon/openclaw-plugin/policy.js';
import { submitNotifyDecision } from '../notify-daemon/openclaw-plugin/control-client.js';

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

test('Notify approval plugin submits the decision over the daemon control socket', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-plugin-'));
  const socketPath = path.join(root, 'control.sock');
  const received = [];
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    let body = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { body += chunk; });
    socket.on('end', () => {
      received.push(JSON.parse(body));
      socket.end(`${JSON.stringify({ ok: true, result: { accepted: true } })}\n`);
    });
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    const result = await submitNotifyDecision(socketPath, {
      action: 'confirm', confirmationId: CONFIRMATION, decision: 'once', operatorOpenId: OWNER,
    });
    assert.equal(result.accepted, true);
    assert.deepEqual(received[0], {
      action: 'confirm', confirmationId: CONFIRMATION, decision: 'once', operatorOpenId: OWNER,
    });
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('Notify approval plugin surfaces a daemon rejection instead of silently succeeding', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'magclaw-notify-plugin-reject-'));
  const socketPath = path.join(root, 'control.sock');
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.setEncoding('utf8');
    socket.on('data', () => {});
    socket.on('end', () => socket.end(`${JSON.stringify({ ok: false, error: 'Only the configured Notify owner can approve this request.' })}\n`));
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  try {
    await assert.rejects(
      submitNotifyDecision(socketPath, { action: 'confirm', confirmationId: CONFIRMATION, decision: 'once', operatorOpenId: OWNER }),
      /Only the configured Notify owner/,
    );
    await assert.rejects(
      submitNotifyDecision(path.join(root, 'missing.sock'), { action: 'confirm' }),
      /control socket unavailable/i,
    );
  } finally {
    server.close();
    await rm(root, { recursive: true, force: true });
  }
});
