import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateOpsEvent,
  validateEventBatch,
  validateEvidence,
  validateEvidenceQueryRequest,
  CURRENT_SCHEMA_VERSION,
  MAX_BATCH_SIZE,
} from '../index.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeValidEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    id: 'evt-0001',
    time: '2026-08-20T12:00:00.000Z',
    source: 'docker',
    nodeId: 'test-svc-02',
    service: 'dataease',
    type: 'container.die',
    severity: 'error',
    message: 'Container dataease exited with code 137',
    attributes: { exitCode: 137, image: 'dataease:latest' },
    ...overrides,
  };
}

// ── OpsEvent validation ──────────────────────────────────────────────────────

describe('validateOpsEvent', () => {
  it('accepts a valid event', () => {
    const result = validateOpsEvent(makeValidEvent());
    assert.ok(result.success);
    if (result.success) {
      assert.equal(result.value.id, 'evt-0001');
      assert.equal((result.value.attributes as Record<string, unknown>).exitCode, 137);
    }
  });

  it('rejects event with missing required field', () => {
    const { id, ...missingId } = makeValidEvent();
    const result = validateOpsEvent(missingId);
    assert.ok(!result.success);
    if (!result.success) {
      assert.ok(result.message.includes('id'));
    }
  });

  it('rejects event with missing attributes', () => {
    const { attributes: _, ...rest } = makeValidEvent();
    const result = validateOpsEvent(rest);
    assert.ok(!result.success);
  });

  it('rejects event with empty id', () => {
    const result = validateOpsEvent(makeValidEvent({ id: '' }));
    assert.ok(!result.success);
  });

  it('rejects event with invalid source', () => {
    const result = validateOpsEvent(makeValidEvent({ source: 'unknown-source' }));
    assert.ok(!result.success);
  });

  it('rejects event with invalid severity', () => {
    const result = validateOpsEvent(makeValidEvent({ severity: 'fatal' }));
    assert.ok(!result.success);
  });

  it('rejects event with wrong schemaVersion', () => {
    const result = validateOpsEvent(makeValidEvent({ schemaVersion: 2 }));
    assert.ok(!result.success);
  });

  it('passes through unknown keys inside attributes', () => {
    const result = validateOpsEvent(
      makeValidEvent({
        attributes: { exitCode: 137, customNested: { deep: true }, extra: 'value' },
      }),
    );
    assert.ok(result.success);
    if (result.success) {
      const attrs = result.value.attributes as Record<string, Record<string, boolean>>;
      assert.equal(attrs.customNested.deep, true);
      assert.equal((result.value.attributes as Record<string, string>).extra, 'value');
    }
  });

  it('accepts optional fingerprint and traceId', () => {
    const result = validateOpsEvent(
      makeValidEvent({ fingerprint: 'abc123', traceId: 'trace-xyz' }),
    );
    assert.ok(result.success);
    if (result.success) {
      assert.equal(result.value.fingerprint, 'abc123');
      assert.equal(result.value.traceId, 'trace-xyz');
    }
  });

  it('accepts event without optional fingerprint/traceId', () => {
    const result = validateOpsEvent(makeValidEvent());
    assert.ok(result.success);
  });

  it('rejects event with invalid time format', () => {
    const result = validateOpsEvent(makeValidEvent({ time: '2026-08-20 12:00:00' }));
    assert.ok(!result.success);
  });

  it('rejects event with empty time string', () => {
    const result = validateOpsEvent(makeValidEvent({ time: '' }));
    assert.ok(!result.success);
  });

  it('rejects event with non-datetime time value', () => {
    const result = validateOpsEvent(makeValidEvent({ time: 'not-a-date' }));
    assert.ok(!result.success);
  });

  it('accepts valid ISO datetime with timezone offset', () => {
    const result = validateOpsEvent(makeValidEvent({ time: '2026-08-20T12:00:00+08:00' }));
    assert.ok(result.success);
  });

  it('accepts valid ISO datetime with Z suffix', () => {
    const result = validateOpsEvent(makeValidEvent({ time: '2026-08-20T12:00:00.000Z' }));
    assert.ok(result.success);
  });

  it('accepts all valid source values', () => {
    const sources = ['jfr', 'application', 'docker', 'host', 'health', 'middleware', 'deployment'];
    for (const source of sources) {
      const result = validateOpsEvent(makeValidEvent({ source }));
      assert.ok(result.success, `source "${source}" should be valid`);
    }
  });
});

// ── EventBatch validation ────────────────────────────────────────────────────

describe('validateEventBatch', () => {
  function makeValidBatch(
    overrides: Record<string, unknown> = {},
    eventCount = 1,
  ): Record<string, unknown> {
    const events = Array.from({ length: eventCount }, (_, i) =>
      makeValidEvent({ id: `evt-${String(i).padStart(4, '0')}` }),
    );
    return {
      producer: { id: 'node-agent-01', type: 'node-agent', version: '0.1.0' },
      events,
      ...overrides,
    };
  }

  it('accepts a valid batch', () => {
    const result = validateEventBatch(makeValidBatch({}, 3));
    assert.ok(result.success);
    if (result.success) {
      assert.equal(result.value.events.length, 3);
      assert.equal(result.value.producer.id, 'node-agent-01');
    }
  });

  it('rejects empty events array', () => {
    const result = validateEventBatch(makeValidBatch({ events: [] }));
    assert.ok(!result.success);
  });

  it('rejects batch exceeding MAX_BATCH_SIZE', () => {
    const result = validateEventBatch(makeValidBatch({}, MAX_BATCH_SIZE + 1));
    assert.ok(!result.success);
    if (!result.success) {
      assert.ok(result.message.includes(String(MAX_BATCH_SIZE)));
    }
  });

  it('accepts batch at MAX_BATCH_SIZE limit', () => {
    const result = validateEventBatch(makeValidBatch({}, MAX_BATCH_SIZE));
    assert.ok(result.success);
  });

  it('rejects batch with invalid producer type', () => {
    const result = validateEventBatch(
      makeValidBatch({ producer: { id: 'x', type: 'unknown', version: '1' } }),
    );
    assert.ok(!result.success);
  });

  it('rejects batch with an invalid event inside', () => {
    const batch = makeValidBatch({}, 2);
    (batch.events as Record<string, unknown>[])[1] = makeValidEvent({ id: '' });
    const result = validateEventBatch(batch);
    assert.ok(!result.success);
  });
});

// ── Evidence validation ──────────────────────────────────────────────────────

describe('validateEvidence', () => {
  function makeValidEvidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'evd-0001',
      incidentId: 'inc-0001',
      nodeId: 'test-svc-02',
      source: 'docker',
      kind: 'docker.logs',
      collectedAt: '2026-08-20T12:01:00.000Z',
      data: { lines: ['line1', 'line2'] },
      ...overrides,
    };
  }

  it('accepts valid evidence', () => {
    const result = validateEvidence(makeValidEvidence());
    assert.ok(result.success);
    if (result.success) {
      assert.equal(result.value.kind, 'docker.logs');
    }
  });

  it('rejects evidence with missing incidentId', () => {
    const { incidentId, ...rest } = makeValidEvidence();
    const result = validateEvidence(rest);
    assert.ok(!result.success);
  });

  it('rejects evidence with invalid collectedAt format', () => {
    const result = validateEvidence(makeValidEvidence({ collectedAt: '2026-08-20 12:01:00' }));
    assert.ok(!result.success);
  });

  it('rejects evidence with empty collectedAt', () => {
    const result = validateEvidence(makeValidEvidence({ collectedAt: '' }));
    assert.ok(!result.success);
  });

  it('accepts valid evidence with timezone offset in collectedAt', () => {
    const result = validateEvidence(
      makeValidEvidence({ collectedAt: '2026-08-20T12:01:00+08:00' }),
    );
    assert.ok(result.success);
  });

  it('accepts arbitrary data shape', () => {
    const result = validateEvidence(
      makeValidEvidence({ data: { nested: { deep: [1, 2, 3] }, scalar: 42 } }),
    );
    assert.ok(result.success);
  });
});

// ── Evidence query validation ────────────────────────────────────────────────

describe('validateEvidenceQueryRequest', () => {
  it('accepts a typed bounded docker.logs query', () => {
    const result = validateEvidenceQueryRequest({
      type: 'docker.logs',
      incidentId: 'inc-0001',
      container: 'dataease',
      since: '2m',
      maxLines: 200,
    });
    assert.ok(result.success);
  });

  it('rejects an arbitrary command query', () => {
    const result = validateEvidenceQueryRequest({
      type: 'shell.exec',
      incidentId: 'inc-0001',
      command: 'whoami',
    });
    assert.ok(!result.success);
  });

  it('rejects query without incidentId', () => {
    const result = validateEvidenceQueryRequest({ type: 'host.memory' });
    assert.ok(!result.success);
  });
});

// ── Constants ────────────────────────────────────────────────────────────────

describe('constants', () => {
  it('CURRENT_SCHEMA_VERSION is 1', () => {
    assert.equal(CURRENT_SCHEMA_VERSION, 1);
  });

  it('MAX_BATCH_SIZE is a positive integer', () => {
    assert.ok(Number.isInteger(MAX_BATCH_SIZE));
    assert.ok(MAX_BATCH_SIZE > 0);
  });
});