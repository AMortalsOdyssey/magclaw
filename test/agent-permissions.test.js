import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inferAgentPermissionGrant,
  recordAgentPermissionGrant,
  renderAgentPermissionGuidance,
} from '../server/agent-permissions.js';

test('agent permission grants recognize Slock-style development access', () => {
  const grant = inferAgentPermissionGrant('好的，给你开发完全访问权限。');

  assert.equal(grant.kind, 'development_full_access');
  assert.match(grant.summary, /常规开发/);
  assert.match(grant.requiresConfirmation.join('\n'), /生产部署/);
  assert.match(grant.requiresConfirmation.join('\n'), /sudo/);
});

test('agent permission grants recognize test deployment default authorization', () => {
  const grant = inferAgentPermissionGrant('以后运行流水线，部署测试环境，不需要我确认，你有这个权限');

  assert.equal(grant.kind, 'test_deployment_without_confirmation');
  assert.match(grant.summary, /测试环境/);
  assert.match(grant.requiresConfirmation.join('\n'), /生产/);
  assert.match(grant.requiresConfirmation.join('\n'), /回滚/);
});

test('agent permission grants persist on the agent and render into runtime guidance', () => {
  const agent = { id: 'agt_cindy', name: 'Cindy', permissionGrants: [] };
  const grant = inferAgentPermissionGrant('以后运行流水线，部署测试环境，不需要我确认，你有这个权限');

  assert.equal(recordAgentPermissionGrant(agent, grant, {
    now: () => '2026-05-21T07:42:00.000Z',
    sourceMessageId: 'msg_42',
  }), true);
  assert.equal(recordAgentPermissionGrant(agent, grant, {
    now: () => '2026-05-21T07:43:00.000Z',
    sourceMessageId: 'msg_43',
  }), false);
  assert.equal(agent.permissionGrants.length, 1);
  assert.equal(agent.permissionGrants[0].sourceMessageId, 'msg_42');

  const guidance = renderAgentPermissionGuidance(agent);
  assert.match(guidance, /默认允许常规开发操作/);
  assert.match(guidance, /部署测试环境/);
  assert.match(guidance, /生产部署/);
  assert.match(guidance, /固定确认句/);
});
