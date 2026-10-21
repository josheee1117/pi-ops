import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { criticalOperationFor, DEFAULT_NOTIFICATION_POLICY, loadNotificationPolicy, serviceNotificationPolicy } from '../notification-config.js';

it('matches verified auth templates without treating lab routes or another method as login', () => {
  const policy = serviceNotificationPolicy(DEFAULT_NOTIFICATION_POLICY, 'dataasset');
  assert.equal(criticalOperationFor(policy, 'GET /auth/authorization-code?redirectUrl=private')?.ruleId, 'dataasset-auth-callback-v1');
  assert.equal(criticalOperationFor(policy, 'GET /auth/authClientInfo')?.ruleId, 'dataasset-auth-client-v1');
  assert.equal(criticalOperationFor(policy, 'GET /oauth/wework/code/corp')?.ruleId, 'dataasset-wework-corp-v1');
  assert.equal(criticalOperationFor(policy, 'GET /auth/lab/server-fault'), undefined);
  assert.equal(criticalOperationFor(policy, 'POST /auth/authClientInfo'), undefined);
});

it('loads service waits and operation owners and rejects invalid policies', () => {
  const directory = mkdtempSync(join(tmpdir(), 'notification-config-'));
  const path = join(directory, 'policy.json');
  try {
    const config = { ...DEFAULT_NOTIFICATION_POLICY, services: { orders: { unknownImpactWaitMs: 1000, observationMaxGapMs: 500, criticalOperations: [{ ruleId: 'login', path: '/login', workflow: '登录', owner: 'oncall' }] } } };
    writeFileSync(path, JSON.stringify(config));
    assert.deepEqual(loadNotificationPolicy(path), config);
    for (const bad of [null, {}, { ...config, defaultUnknownImpactWaitMs: -1 }, { ...config, services: { orders: { ...config.services.orders, criticalOperations: [{ ruleId: 'login', path: '/a', operation: 'b', workflow: 'login' }] } } }]) {
      writeFileSync(path, JSON.stringify(bad));
      assert.throws(() => loadNotificationPolicy(path), /Invalid notification|Invalid critical/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
