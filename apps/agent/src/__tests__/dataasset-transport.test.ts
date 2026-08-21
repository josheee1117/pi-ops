import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateEventBatch } from '@pi-ops/protocol';
import { createApp } from '../app.js';
import { createEventStore } from '../store.js';
import { createIncidentEngine } from '../incident.js';
import { planEvidenceQueries } from '../evidence-orchestrator.js';
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
  reasoningJobPollIntervalMs: 1000,
  reasoningJobMaxAttempts: 3,
  reasoningTimeoutMs: 5000,
  reasoningJobBatchSize: 10,
  reasonerType: 'fake',
  piProvider: '',
  piModel: '',
  reasoningMaxRetries: 2,
  reasoningMaxContextBytes: 32_768,
  reasoningMaxEvidenceItems: 12,
  reasoningMaxLogLines: 50,
  reasoningMaxOutputBytes: 8192,
};

function dataAssetSlowSqlBatch(): unknown {
  const fixturePath = join(
    dirname(fileURLToPath(import.meta.url)),
    'fixtures/dataasset-slow-sql.eventbatch.json',
  );
  return JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown;
}

describe('DataAsset event transport contract', () => {
  it('accepts a golden DataAsset EventBatch and opens an Incident with an evidence plan', async () => {
    const raw = dataAssetSlowSqlBatch();
    const validation = validateEventBatch(raw);
    assert.equal(validation.success, true);
    if (!validation.success) return;
    const batch = validation.value;

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
    const stored = store.getEvent(batch.events[0].id);
    assert.ok(stored);
    assert.equal(stored.source, 'application');
    assert.equal(stored.type, 'application.slow_sql');
    assert.equal(stored.producer_type, 'application');
    assert.equal(stored.producer_id, 'data-asset');
    const incident = store.findIncidentByEventId(batch.events[0].id);
    assert.ok(incident);
    assert.equal(incident.state, 'OPEN');
    assert.equal(incident.type, 'application.slow_sql');
    assert.equal(incident.event_count, 1);
    const triggeringEvent = batch.events[0];
    const plan = planEvidenceQueries(incident, triggeringEvent, CONFIG.evidenceLogsMaxLines);
    assert.deepEqual(plan.map((query) => query.type), ['docker.inspect', 'docker.stats', 'host.load']);
    assert.equal(plan[0]?.container, 'data-asset');
    store.close();
  });
});
