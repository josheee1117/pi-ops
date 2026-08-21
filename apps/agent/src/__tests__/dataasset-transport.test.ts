import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateEventBatch } from '@pi-ops/protocol';
import { createApp } from '../app.js';
import { createEventStore } from '../store.js';
import { createIncidentEngine } from '../incident.js';
import type { AgentConfig } from '../config.js';

const CONFIG: AgentConfig = {
  port: 0,
  ingestToken: 'test-token',
  sqlitePath: ':memory:',
  nodeId: 'test-node',
  maxBodySize: 1024 * 1024,
  aggregationWindowMs: 5 * 60 * 1000,
  nodeAgents: new Map(),
  evidenceTimeoutMs: 5000,
  evidenceMaxResponseBytes: 1024 * 1024,
  evidenceLogsMaxLines: 200,
  evidenceJobPollIntervalMs: 1000,
  evidenceJobMaxAttempts: 3,
  evidenceJobBatchSize: 10,
  eventReplayBatchSize: 100,
};

function dataAssetSlowSqlBatch() {
  return {
    producer: {
      id: 'data-asset',
      type: 'application' as const,
      version: '0.1.0',
    },
    events: [
      {
        schemaVersion: 1 as const,
        id: 'da-slow-sql-001',
        time: '2026-08-20T12:00:00.000Z',
        source: 'application' as const,
        nodeId: 'test-svc-02',
        service: 'data-asset-service',
        type: 'application.slow_sql',
        severity: 'warning' as const,
        message: 'Slow SQL statementId=com.mbkj.FooMapper.select durationMs=1500',
        attributes: {
          statementId: 'com.mbkj.FooMapper.select',
          sqlFingerprint: 'deadbeef',
          datasourceRoute: 'primary',
          outcome: 'SUCCESS',
          durationMs: 1500,
        },
      },
    ],
  };
}

describe('DataAsset event transport contract', () => {
  it('accepts a synthetic DataAsset EventBatch and opens an Incident', async () => {
    const batch = dataAssetSlowSqlBatch();
    const validation = validateEventBatch(batch);
    assert.equal(validation.success, true);

    const store = createEventStore(':memory:');
    const engine = createIncidentEngine(store, { aggregationWindowMs: CONFIG.aggregationWindowMs });
    const app = createApp(CONFIG, store, engine);
    const response = await app.request('/v1/events', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(batch),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { accepted: 1, rejected: 0 });
    const stored = store.getEvent('da-slow-sql-001');
    assert.ok(stored);
    assert.equal(stored.source, 'application');
    assert.equal(stored.type, 'application.slow_sql');
    assert.equal(stored.producer_type, 'application');
    assert.equal(stored.producer_id, 'data-asset');
    const incident = store.findIncidentByEventId('da-slow-sql-001');
    assert.ok(incident);
    assert.equal(incident.state, 'OPEN');
    assert.equal(incident.type, 'application.slow_sql');
    assert.equal(incident.event_count, 1);
    store.close();
  });
});
