import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLOUD_ROLE_LABELS,
  CLOUD_ROLES,
  canUpdateMemberRole,
  cloudCapabilitiesForRole,
  normalizeCloudRole,
} from '../server/cloud/roles.js';

test('cloud roles keep Owner as a first-class server membership role', () => {
  assert.deepEqual(CLOUD_ROLES, ['member', 'admin', 'owner']);
  assert.equal(CLOUD_ROLE_LABELS.owner, 'Owner');
  assert.equal(normalizeCloudRole('owner'), 'owner');

  const memberCapabilities = cloudCapabilitiesForRole('member');
  assert.equal(memberCapabilities.manage_computers, false);
  assert.equal(memberCapabilities.detect_runtime, false);
  assert.equal(memberCapabilities.manage_owner_role, false);

  const adminCapabilities = cloudCapabilitiesForRole('admin');
  assert.equal(adminCapabilities.manage_computers, true);
  assert.equal(adminCapabilities.detect_runtime, true);
  assert.equal(adminCapabilities.manage_owner_role, false);

  const ownerCapabilities = cloudCapabilitiesForRole('owner');
  assert.equal(ownerCapabilities.manage_computers, true);
  assert.equal(ownerCapabilities.detect_runtime, true);
  assert.equal(ownerCapabilities.manage_owner_role, true);
});

test('only Owner can assign or remove another Owner role', () => {
  assert.equal(canUpdateMemberRole('owner', 'member', 'owner'), true);
  assert.equal(canUpdateMemberRole('owner', 'owner', 'member'), true);
  assert.equal(canUpdateMemberRole('admin', 'member', 'owner'), false);
  assert.equal(canUpdateMemberRole('admin', 'owner', 'member'), false);
  assert.equal(canUpdateMemberRole('admin', 'member', 'admin'), true);
  assert.equal(canUpdateMemberRole('member', 'admin', 'member'), false);
});
