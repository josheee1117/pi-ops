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
import { makeAgentConfig } from './test-config.js';

const CONFIG = makeAgentConfig({ ingestToken: 'test-token', nodeId: 'test-node', evidenceTimeoutMs: 5000 });

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
