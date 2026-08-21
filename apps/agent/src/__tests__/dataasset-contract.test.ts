import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  reasoningJobPollIntervalMs: 1000,
  reasoningJobMaxAttempts: 3,
  reasoningTimeoutMs: 5000,
  reasoningJobBatchSize: 10,
};

function loadGolden(name: string): unknown {
  return JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures', name),
    'utf8',
  )) as unknown;
}

async function ingest(body: unknown) {
  const store = createEventStore(':memory:');
  const engine = createIncidentEngine(store, { aggregationWindowMs: CONFIG.aggregationWindowMs });
  const app = createApp(CONFIG, store, engine);
  const response = await app.request('/v1/events', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-token',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  return { store, response };
}

describe('DataAsset production golden contract', () => {
  it('accepts the real serializer slow_sql payload', async () => {
    const raw = loadGolden('dataasset-slow-sql.eventbatch.json');
    const validation = validateEventBatch(raw);
    assert.equal(validation.success, true);
    if (!validation.success) return;
    const event = validation.value.events[0];
    assert.equal(event.type, 'application.slow_sql');
    assert.equal(event.attributes['sqlFingerprint'], 'deadbeef');
    assert.equal(event.attributes['statementId'], 'com.mbkj.FooMapper.select');
    assert.equal(event.attributes['durationMs'], 1500);
    assert.equal(event.attributes['datasourceRoute'], 'primary');
    assert.equal(event.attributes['containerName'], 'data-asset');
    assert.equal(event.attributes['sql'], undefined);
    const { store, response } = await ingest(raw);
    assert.equal(response.status, 200);
    const stored = store.getEvent(event.id);
    assert.equal(stored?.type, 'application.slow_sql');
    assert.equal(JSON.parse(stored?.attributes ?? '{}').containerName, 'data-asset');
    store.close();
  });

  it('accepts the real serializer business.error payload', async () => {
    const raw = loadGolden('dataasset-business-error.eventbatch.json');
    const validation = validateEventBatch(raw);
    assert.equal(validation.success, true);
    if (!validation.success) return;
    const event = validation.value.events[0];
    assert.equal(event.type, 'business.error');
    assert.equal(event.attributes['businessCode'], 'PAYMENT_TIMEOUT');
    assert.equal(event.attributes['module'], 'payment');
    assert.equal(event.attributes['containerName'], 'data-asset');
    assert.equal(event.traceId, 'trace-1');
    const { store, response } = await ingest(raw);
    assert.equal(response.status, 200);
    assert.ok(store.findIncidentByEventId(event.id));
    store.close();
  });

  it('accepts the real serializer jvm.cpu_pressure payload and preserves containerName', async () => {
    const raw = loadGolden('dataasset-jvm-cpu.eventbatch.json');
    const validation = validateEventBatch(raw);
    assert.equal(validation.success, true);
    if (!validation.success) return;
    const event = validation.value.events[0];
    assert.equal(event.type, 'jvm.cpu_pressure');
    assert.equal(event.source, 'jfr');
    assert.equal(event.attributes['containerName'], 'data-asset');
    const { store, response } = await ingest(raw);
    assert.equal(response.status, 200);
    const stored = store.getEvent(event.id);
    assert.equal(JSON.parse(stored?.attributes ?? '{}').containerName, 'data-asset');
    store.close();
  });
});
