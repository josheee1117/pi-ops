import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EVIDENCE_QUERY_TYPES,
  RUNTIME_ALLOWED_EVIDENCE_TYPES,
  type OpsEvent,
  type RuntimeEvidenceType,
} from '@pi-ops/protocol';
import { resolveRuntimeEvidenceQuery } from '../runtime-evidence-resolver.js';
import type { IncidentRow } from '../store.js';

const LOGS_MAX_LINES = 200;

function incident(overrides: Partial<IncidentRow> = {}): IncidentRow {
  return {
    id: 'inc-resolver',
    service: 'data-asset-service',
    node_id: 'test-svc-02',
    type: 'application.slow_sql',
    state: 'OPEN',
    fingerprint: 'fp-resolver',
    first_seen: '2026-08-20T12:00:00.000Z',
    last_seen: '2026-08-20T12:00:00.000Z',
    event_count: 1,
    severity: 'warning',
    ...overrides,
  };
}

function event(overrides: Partial<OpsEvent> = {}): OpsEvent {
  return {
    schemaVersion: 1,
    id: 'evt-resolver',
    time: '2026-08-20T12:00:00.000Z',
    source: 'application',
    nodeId: 'test-svc-02',
    service: 'data-asset-service',
    type: 'application.slow_sql',
    severity: 'warning',
    message: 'slow sql',
    attributes: {},
    ...overrides,
  };
}

describe('runtime evidence target resolver', () => {
  it('keeps the runtime allowlist inside the node-agent capability set', () => {
    for (const type of RUNTIME_ALLOWED_EVIDENCE_TYPES) {
      assert.ok((EVIDENCE_QUERY_TYPES as readonly string[]).includes(type));
    }
    assert.equal((RUNTIME_ALLOWED_EVIDENCE_TYPES as readonly string[]).includes('host.disk'), false);
  });

  it('gives every allowed capability a deterministic outcome', () => {
    const trusted = event({ attributes: { containerName: 'dataease' } });
    const table: Array<{
      type: RuntimeEvidenceType;
      resolvable: boolean;
      incident?: IncidentRow;
      triggeringEvent?: OpsEvent;
    }> = [
      { type: 'host.memory', resolvable: true },
      { type: 'host.load', resolvable: true },
      { type: 'docker.inspect', resolvable: true, triggeringEvent: trusted },
      { type: 'docker.stats', resolvable: true, triggeringEvent: trusted },
      {
        type: 'docker.logs',
        resolvable: true,
        incident: incident({ type: 'container.die' }),
        triggeringEvent: event({ type: 'container.die', source: 'docker', attributes: { containerName: 'dataease' } }),
      },
      {
        type: 'http.probe',
        resolvable: true,
        incident: incident({ type: 'health.failure' }),
        triggeringEvent: event({
          type: 'health.failure',
          source: 'health',
          attributes: { detector: 'http.health', url: 'http://dataease:8100/health', method: 'GET' },
        }),
      },
    ];
    assert.deepEqual(
      table.map((row) => row.type).sort(),
      [...RUNTIME_ALLOWED_EVIDENCE_TYPES].sort(),
    );
    for (const row of table) {
      const target = row.incident ?? incident();
      const query = resolveRuntimeEvidenceQuery(
        target,
        row.triggeringEvent ?? event(),
        row.type,
        LOGS_MAX_LINES,
      );
      if (!row.resolvable) {
        assert.equal(query, undefined, `${row.type} must not resolve`);
        continue;
      }
      assert.ok(query, `${row.type} must resolve`);
      assert.equal(query.type, row.type);
      assert.equal(query.incidentId, target.id);
    }
  });

  it('resolves host capabilities without any model-supplied target', () => {
    const query = resolveRuntimeEvidenceQuery(incident(), event(), 'host.memory', LOGS_MAX_LINES);
    assert.deepEqual(query, { type: 'host.memory', incidentId: 'inc-resolver' });
  });

  it('resolves docker targets only from trusted metadata', () => {
    const untrusted = resolveRuntimeEvidenceQuery(incident(), event(), 'docker.stats', LOGS_MAX_LINES);
    assert.equal(untrusted, undefined);
    const trusted = resolveRuntimeEvidenceQuery(
      incident(),
      event({ attributes: { containerName: 'dataease' } }),
      'docker.stats',
      LOGS_MAX_LINES,
    );
    assert.equal(trusted?.container, 'dataease');
  });

  it('refuses http.probe without a trusted health detector URL', () => {
    const noDetector = resolveRuntimeEvidenceQuery(
      incident({ type: 'health.failure' }),
      event({ type: 'health.failure', source: 'health', attributes: {} }),
      'http.probe',
      LOGS_MAX_LINES,
    );
    assert.equal(noDetector, undefined);
    const trusted = resolveRuntimeEvidenceQuery(
      incident({ type: 'health.failure' }),
      event({
        type: 'health.failure',
        source: 'health',
        attributes: { detector: 'http.health', url: 'http://dataease:8100/health' },
      }),
      'http.probe',
      LOGS_MAX_LINES,
    );
    assert.equal(trusted?.url, 'http://dataease:8100/health');
  });

  it('keeps the bounded docker.logs window and maxLines policy', () => {
    const query = resolveRuntimeEvidenceQuery(
      incident({ type: 'container.die' }),
      event({ type: 'container.die', source: 'docker', attributes: { containerName: 'dataease' } }),
      'docker.logs',
      LOGS_MAX_LINES,
    );
    assert.equal(query?.maxLines, LOGS_MAX_LINES);
    assert.equal(query?.since, '2026-08-20T11:58:00.000Z');
    assert.equal(query?.until, '2026-08-20T12:02:00.000Z');
  });
});
