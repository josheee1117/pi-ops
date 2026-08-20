import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { EvidenceQueryRequest, OpsEvent } from '@pi-ops/protocol';
import type { AgentConfig } from '../config.js';
import {
  createEvidenceOrchestrator,
  planEvidenceQueries,
  type FetchLike,
} from '../evidence-orchestrator.js';
import { createEventStore, type IncidentRow } from '../store.js';

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    port: 0,
    ingestToken: 'ingest-token',
    sqlitePath: ':memory:',
    nodeId: 'central',
    maxBodySize: 1024 * 1024,
    aggregationWindowMs: 5 * 60 * 1000,
    nodeAgents: new Map([
      [
        'test-svc-02',
        {
          nodeId: 'test-svc-02',
          url: 'http://node-agent.test',
          token: 'node-token',
        },
      ],
    ]),
    evidenceTimeoutMs: 1000,
    evidenceMaxResponseBytes: 1024 * 1024,
    evidenceLogsMaxLines: 200,
    evidenceJobPollIntervalMs: 1000,
    evidenceJobMaxAttempts: 3,
    evidenceJobBatchSize: 10,
    eventReplayBatchSize: 100,
    ...overrides,
  };
}

function makeIncident(overrides: Partial<IncidentRow> = {}): IncidentRow {
  return {
    id: 'inc-001',
    service: 'dataease',
    node_id: 'test-svc-02',
    type: 'container.oom',
    state: 'OPEN',
    fingerprint: JSON.stringify(['docker', 'test-svc-02', 'dataease', 'container.oom']),
    first_seen: '2026-08-20T12:00:00.000Z',
    last_seen: '2026-08-20T12:00:00.000Z',
    event_count: 1,
    severity: 'critical',
    ...overrides,
  };
}

function makeEvent(overrides: Partial<OpsEvent> = {}): OpsEvent {
  return {
    schemaVersion: 1,
    id: 'evt-001',
    time: '2026-08-20T12:00:00.000Z',
    source: 'docker',
    nodeId: 'test-svc-02',
    service: 'dataease',
    type: 'container.oom',
    severity: 'critical',
    message: 'Container OOM killed',
    attributes: {
      containerName: 'dataease',
      containerId: 'abc123',
      oomKilled: true,
    },
    ...overrides,
  };
}

function successfulNodeFetch(): FetchLike {
  let id = 0;
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    const query = JSON.parse(String(init?.body)) as EvidenceQueryRequest;
    id++;
    return new Response(
      JSON.stringify({
        id: `evd-${id}`,
        incidentId: query.incidentId,
        nodeId: 'test-svc-02',
        source: query.type.split('.')[0],
        kind: query.type,
        collectedAt: '2026-08-20T12:00:01.000Z',
        data: { queryType: query.type },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as FetchLike;
}

describe('planEvidenceQueries', () => {
  it('maps container.oom to inspect, stats, bounded logs, and host memory', () => {
    const queries = planEvidenceQueries(makeIncident(), makeEvent(), 120);
    assert.deepEqual(
      queries.map((query) => query.type),
      ['docker.inspect', 'docker.stats', 'docker.logs', 'host.memory'],
    );
    const logs = queries.find((query) => query.type === 'docker.logs');
    assert.equal(logs?.container, 'dataease');
    assert.equal(logs?.maxLines, 120);
    assert.equal(logs?.since, '2m');
  });

  it('maps container.die to inspect and bounded logs', () => {
    const incident = makeIncident({ type: 'container.die' });
    const event = makeEvent({ type: 'container.die', severity: 'error' });
    const queries = planEvidenceQueries(incident, event, 200);
    assert.deepEqual(
      queries.map((query) => query.type),
      ['docker.inspect', 'docker.logs'],
    );
  });

  it('maps health.failure to probe and optional mapped-container evidence', () => {
    const incident = makeIncident({ type: 'health.failure', service: 'dataease-health' });
    const event = makeEvent({
      source: 'health',
      type: 'health.failure',
      severity: 'error',
      service: 'dataease-health',
      attributes: {
        detector: 'http.health',
        url: 'http://dataease:8100/health',
        method: 'GET',
        containerName: 'dataease',
      },
    });
    const queries = planEvidenceQueries(incident, event, 200);
    assert.deepEqual(
      queries.map((query) => query.type),
      ['http.probe', 'docker.inspect', 'docker.logs'],
    );
  });

  it('maps Docker health failure to container evidence without HTTP probe', () => {
    const incident = makeIncident({ type: 'health.failure' });
    const event = makeEvent({
      source: 'docker',
      type: 'health.failure',
      severity: 'error',
      attributes: { containerName: 'dataease', dockerAction: 'health_status' },
    });
    assert.deepEqual(
      planEvidenceQueries(incident, event, 200).map((query) => query.type),
      ['docker.inspect', 'docker.logs'],
    );
  });

  it('returns no queries for an unmapped incident type', () => {
    const incident = makeIncident({ type: 'application.error' });
    assert.deepEqual(planEvidenceQueries(incident, makeEvent(), 200), []);
  });
});

describe('evidence orchestration', () => {
  it('persists a complete evidence set for a synthetic OOM incident', async () => {
    const store = createEventStore(':memory:');
    const incident = store.createIncident({
      service: 'dataease',
      node_id: 'test-svc-02',
      type: 'container.oom',
      state: 'OPEN',
      fingerprint: JSON.stringify(['docker', 'test-svc-02', 'dataease', 'container.oom']),
      first_seen: '2026-08-20T12:00:00.000Z',
      last_seen: '2026-08-20T12:00:00.000Z',
      event_count: 1,
      severity: 'critical',
    });
    const orchestrator = createEvidenceOrchestrator(
      makeConfig(),
      store,
      successfulNodeFetch(),
    );

    const summary = await orchestrator.collectForIncident(
      incident,
      makeEvent(),
    );

    assert.deepEqual(summary, {
      incidentId: incident.id,
      requested: 4,
      succeeded: 4,
      failed: 0,
      retryableFailures: 0,
      terminalFailures: 0,
    });
    const evidence = store.listEvidence(incident.id);
    assert.equal(evidence.length, 4);
    assert.ok(evidence.every((item) => item.status === 'succeeded'));
    assert.deepEqual(
      new Set(evidence.map((item) => item.kind)),
      new Set(['docker.inspect', 'docker.stats', 'docker.logs', 'host.memory']),
    );
    // Evidence is separate; the Incident remains present and unchanged.
    assert.equal(store.getIncident(incident.id)?.state, 'OPEN');
    assert.equal(store.incidentCount(), 1);
    store.close();
  });

  it('upserts deterministic evidence records when a durable job is retried', async () => {
    const store = createEventStore(':memory:');
    const incident = store.createIncident({
      service: 'dataease',
      node_id: 'test-svc-02',
      type: 'container.die',
      state: 'OPEN',
      fingerprint: 'fp-retry',
      first_seen: '2026-08-20T12:00:00.000Z',
      last_seen: '2026-08-20T12:00:00.000Z',
      event_count: 1,
      severity: 'error',
    });
    const orchestrator = createEvidenceOrchestrator(
      makeConfig(),
      store,
      successfulNodeFetch(),
    );
    await orchestrator.collectForIncident(
      incident,
      makeEvent({ type: 'container.die', severity: 'error' }),
      'job-retry',
    );
    await orchestrator.collectForIncident(
      incident,
      makeEvent({ type: 'container.die', severity: 'error' }),
      'job-retry',
    );

    assert.equal(store.listEvidence(incident.id).length, 2);
    assert.deepEqual(
      store.listEvidence(incident.id).map((item) => item.id).sort(),
      ['job-retry-evidence-docker.inspect', 'job-retry-evidence-docker.logs'],
    );
    store.close();
  });

  it('uses deterministic Evidence IDs without an explicit collection id', async () => {
    const store = createEventStore(':memory:');
    const incident = store.createIncident({
      service: 'dataease',
      node_id: 'test-svc-02',
      type: 'container.die',
      state: 'OPEN',
      fingerprint: 'fp-default-retry',
      first_seen: '2026-08-20T12:00:00.000Z',
      last_seen: '2026-08-20T12:00:00.000Z',
      event_count: 1,
      severity: 'error',
    });
    const orchestrator = createEvidenceOrchestrator(
      makeConfig(),
      store,
      successfulNodeFetch(),
    );
    const event = makeEvent({ type: 'container.die', severity: 'error' });

    await orchestrator.collectForIncident(incident, event);
    await orchestrator.collectForIncident(incident, event);

    assert.equal(store.listEvidence(incident.id).length, 2);
    assert.deepEqual(
      store.listEvidence(incident.id).map((item) => item.id).sort(),
      [
        `incident-${incident.id}-evidence-docker.inspect`,
        `incident-${incident.id}-evidence-docker.logs`,
      ],
    );
    store.close();
  });

  it('persists a complete evidence set for a synthetic container-die incident', async () => {
    const store = createEventStore(':memory:');
    const incident = store.createIncident({
      service: 'dataease',
      node_id: 'test-svc-02',
      type: 'container.die',
      state: 'OPEN',
      fingerprint: JSON.stringify(['docker', 'test-svc-02', 'dataease', 'container.die']),
      first_seen: '2026-08-20T12:00:00.000Z',
      last_seen: '2026-08-20T12:00:00.000Z',
      event_count: 1,
      severity: 'error',
    });
    const summary = await createEvidenceOrchestrator(
      makeConfig(),
      store,
      successfulNodeFetch(),
    ).collectForIncident(incident, makeEvent({ type: 'container.die', severity: 'error' }));

    assert.equal(summary.requested, 2);
    assert.equal(summary.succeeded, 2);
    assert.deepEqual(
      new Set(store.listEvidence(incident.id).map((item) => item.kind)),
      new Set(['docker.inspect', 'docker.logs']),
    );
    store.close();
  });

  it('persists each failure explicitly without discarding the Incident', async () => {
    const store = createEventStore(':memory:');
    const incident = store.createIncident({
      service: 'dataease',
      node_id: 'test-svc-02',
      type: 'container.oom',
      state: 'OPEN',
      fingerprint: 'fp',
      first_seen: '2026-08-20T12:00:00.000Z',
      last_seen: '2026-08-20T12:00:00.000Z',
      event_count: 1,
      severity: 'critical',
    });

    let id = 0;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const query = JSON.parse(String(init?.body)) as EvidenceQueryRequest;
      if (query.type === 'docker.stats') {
        return new Response('stats unavailable', { status: 500 });
      }
      id++;
      return new Response(JSON.stringify({
        id: `evd-ok-${id}`,
        incidentId: incident.id,
        nodeId: 'test-svc-02',
        source: query.type.split('.')[0],
        kind: query.type,
        collectedAt: '2026-08-20T12:00:01.000Z',
        data: { ok: true },
      }), { status: 200 });
    }) as FetchLike;

    const summary = await createEvidenceOrchestrator(
      makeConfig(),
      store,
      fetchImpl,
    ).collectForIncident(incident, makeEvent());

    assert.equal(summary.succeeded, 3);
    assert.equal(summary.failed, 1);
    const evidence = store.listEvidence(incident.id);
    assert.equal(evidence.length, 4);
    const failed = evidence.find((item) => item.kind === 'docker.stats');
    assert.equal(failed?.status, 'failed');
    assert.match(failed?.error ?? '', /HTTP 500/);
    assert.equal(store.getIncident(incident.id)?.state, 'OPEN');
    store.close();
  });

  it('records failures for every planned query when the node is not configured', async () => {
    const store = createEventStore(':memory:');
    const incident = store.createIncident({
      service: 'dataease',
      node_id: 'missing-node',
      type: 'container.die',
      state: 'OPEN',
      fingerprint: 'fp',
      first_seen: '2026-08-20T12:00:00.000Z',
      last_seen: '2026-08-20T12:00:00.000Z',
      event_count: 1,
      severity: 'error',
    });
    const config = makeConfig({ nodeAgents: new Map() });
    const summary = await createEvidenceOrchestrator(config, store)
      .collectForIncident(incident, makeEvent({ type: 'container.die', nodeId: 'missing-node' }));

    assert.equal(summary.requested, 2);
    assert.equal(summary.failed, 2);
    const evidence = store.listEvidence(incident.id);
    assert.equal(evidence.length, 2);
    assert.ok(evidence.every((item) => item.status === 'failed'));
    assert.ok(evidence.every((item) => item.error?.includes('No node-agent configured')));
    store.close();
  });

  it('rejects a mismatched Evidence incidentId and persists it as failure', async () => {
    const store = createEventStore(':memory:');
    const incident = store.createIncident({
      service: 'dataease',
      node_id: 'test-svc-02',
      type: 'container.die',
      state: 'OPEN',
      fingerprint: 'fp',
      first_seen: '2026-08-20T12:00:00.000Z',
      last_seen: '2026-08-20T12:00:00.000Z',
      event_count: 1,
      severity: 'error',
    });
    let id = 0;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const query = JSON.parse(String(init?.body)) as EvidenceQueryRequest;
      id++;
      return new Response(JSON.stringify({
        id: `evd-${id}`,
        incidentId: 'wrong-incident',
        nodeId: 'test-svc-02',
        source: 'docker',
        kind: query.type,
        collectedAt: '2026-08-20T12:00:01.000Z',
        data: {},
      }), { status: 200 });
    }) as FetchLike;

    const summary = await createEvidenceOrchestrator(makeConfig(), store, fetchImpl)
      .collectForIncident(incident, makeEvent({ type: 'container.die' }));
    assert.equal(summary.failed, 2);
    assert.ok(
      store.listEvidence(incident.id).every((item) =>
        item.error?.includes('incidentId does not match'),
      ),
    );
    store.close();
  });

  it('rejects a mismatched Evidence source', async () => {
    const store = createEventStore(':memory:');
    const incident = store.createIncident({
      service: 'dataease',
      node_id: 'test-svc-02',
      type: 'container.die',
      state: 'OPEN',
      fingerprint: 'fp',
      first_seen: '2026-08-20T12:00:00.000Z',
      last_seen: '2026-08-20T12:00:00.000Z',
      event_count: 1,
      severity: 'error',
    });
    let id = 0;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      const query = JSON.parse(String(init?.body)) as EvidenceQueryRequest;
      id++;
      return new Response(JSON.stringify({
        id: `evd-source-${id}`,
        incidentId: incident.id,
        nodeId: 'test-svc-02',
        source: 'host',
        kind: query.type,
        collectedAt: '2026-08-20T12:00:01.000Z',
        data: {},
      }), { status: 200 });
    }) as FetchLike;

    const summary = await createEvidenceOrchestrator(makeConfig(), store, fetchImpl)
      .collectForIncident(incident, makeEvent({ type: 'container.die' }));
    assert.equal(summary.failed, 2);
    assert.ok(
      store.listEvidence(incident.id).every((item) =>
        item.error?.includes('source does not match'),
      ),
    );
    store.close();
  });

  it('stops reading and records failure when a streaming response exceeds the cap', async () => {
    const store = createEventStore(':memory:');
    const incident = store.createIncident({
      service: 'dataease',
      node_id: 'test-svc-02',
      type: 'container.die',
      state: 'OPEN',
      fingerprint: 'fp',
      first_seen: '2026-08-20T12:00:00.000Z',
      last_seen: '2026-08-20T12:00:00.000Z',
      event_count: 1,
      severity: 'error',
    });
    const oversizedFetch = (async () => new Response('x'.repeat(256), { status: 200 })) as FetchLike;
    const summary = await createEvidenceOrchestrator(
      makeConfig({ evidenceMaxResponseBytes: 32 }),
      store,
      oversizedFetch,
    ).collectForIncident(incident, makeEvent({ type: 'container.die' }));

    assert.equal(summary.failed, 2);
    assert.equal(summary.retryableFailures, 0);
    assert.equal(summary.terminalFailures, 2);
    assert.ok(
      store.listEvidence(incident.id).every((item) =>
        item.failureClass === 'terminal' && item.error?.includes('exceeds 32 bytes'),
      ),
    );
    store.close();
  });

  it('classifies a response stream failure after headers as retryable', async () => {
    const store = createEventStore(':memory:');
    const incident = store.createIncident({
      service: 'dataease',
      node_id: 'test-svc-02',
      type: 'container.die',
      state: 'OPEN',
      fingerprint: 'fp-stream-reset',
      first_seen: '2026-08-20T12:00:00.000Z',
      last_seen: '2026-08-20T12:00:00.000Z',
      event_count: 1,
      severity: 'error',
    });
    const resetFetch = (async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'));
        controller.error(new Error('connection reset'));
      },
    }), { status: 200 })) as FetchLike;

    const summary = await createEvidenceOrchestrator(makeConfig(), store, resetFetch)
      .collectForIncident(incident, makeEvent({ type: 'container.die' }));

    assert.equal(summary.failed, 2);
    assert.equal(summary.retryableFailures, 2);
    assert.equal(summary.terminalFailures, 0);
    assert.ok(
      store.listEvidence(incident.id).every((item) =>
        item.failureClass === 'retryable' && item.error?.includes('response stream failed'),
      ),
    );
    store.close();
  });

  it('propagates Evidence persistence failures', async () => {
    const store = createEventStore(':memory:');
    const incident = store.createIncident({
      service: 'dataease',
      node_id: 'test-svc-02',
      type: 'container.die',
      state: 'OPEN',
      fingerprint: 'fp-persistence',
      first_seen: '2026-08-20T12:00:00.000Z',
      last_seen: '2026-08-20T12:00:00.000Z',
      event_count: 1,
      severity: 'error',
    });
    const originalInsertEvidence = store.insertEvidence;
    store.insertEvidence = () => {
      throw new Error('sqlite write failed');
    };

    await assert.rejects(
      createEvidenceOrchestrator(makeConfig(), store, successfulNodeFetch())
        .collectForIncident(incident, makeEvent({ type: 'container.die' })),
      /sqlite write failed/,
    );
    store.insertEvidence = originalInsertEvidence;
    store.close();
  });

  it('records a planning failure when health.failure has no probe URL', async () => {
    const store = createEventStore(':memory:');
    const incident = store.createIncident({
      service: 'dataease-health',
      node_id: 'test-svc-02',
      type: 'health.failure',
      state: 'OPEN',
      fingerprint: 'fp',
      first_seen: '2026-08-20T12:00:00.000Z',
      last_seen: '2026-08-20T12:00:00.000Z',
      event_count: 1,
      severity: 'error',
    });
    const summary = await createEvidenceOrchestrator(
      makeConfig(),
      store,
      successfulNodeFetch(),
    ).collectForIncident(
      incident,
      makeEvent({
        source: 'health',
        service: 'dataease-health',
        type: 'health.failure',
        severity: 'error',
        attributes: { detector: 'http.health' },
      }),
    );

    assert.equal(summary.requested, 1);
    assert.equal(summary.failed, 1);
    const evidence = store.listEvidence(incident.id);
    assert.equal(evidence[0]?.kind, 'http.probe');
    assert.match(evidence[0]?.error ?? '', /no URL/);
    store.close();
  });

  it('does not create missing-URL evidence for Docker health failure', async () => {
    const store = createEventStore(':memory:');
    const { id: _id, ...incidentInput } = makeIncident({
      type: 'health.failure',
      fingerprint: 'docker-health',
    });
    const incident = store.createIncident(incidentInput);
    const summary = await createEvidenceOrchestrator(
      makeConfig(),
      store,
      successfulNodeFetch(),
    ).collectForIncident(incident, makeEvent({
      source: 'docker',
      type: 'health.failure',
      severity: 'error',
      attributes: { containerName: 'dataease', dockerAction: 'health_status' },
    }));

    assert.equal(summary.requested, 2);
    assert.equal(summary.failed, 0);
    assert.equal(summary.retryableFailures, 0);
    assert.deepEqual(
      store.listEvidence(incident.id).map((item) => item.kind).sort(),
      ['docker.inspect', 'docker.logs'],
    );
    store.close();
  });

  it('routes requests to the node endpoint matching Incident.node_id', async () => {
    const store = createEventStore(':memory:');
    const config = makeConfig({
      nodeAgents: new Map([
        ['node-a', { nodeId: 'node-a', url: 'http://node-a', token: 'token-a' }],
        ['node-b', { nodeId: 'node-b', url: 'http://node-b', token: 'token-b' }],
      ]),
    });
    const seen: Array<{ url: string; auth: string }> = [];
    let id = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = init?.headers as Record<string, string>;
      seen.push({ url, auth: headers.Authorization });
      const query = JSON.parse(String(init?.body)) as EvidenceQueryRequest;
      const nodeId = url.includes('node-a') ? 'node-a' : 'node-b';
      id++;
      return new Response(JSON.stringify({
        id: `evd-route-${id}`,
        incidentId: query.incidentId,
        nodeId,
        source: 'docker',
        kind: query.type,
        collectedAt: '2026-08-20T12:00:01.000Z',
        data: {},
      }), { status: 200 });
    }) as FetchLike;
    const orchestrator = createEvidenceOrchestrator(config, store, fetchImpl);

    for (const nodeId of ['node-a', 'node-b']) {
      const incident = store.createIncident({
        service: 'dataease',
        node_id: nodeId,
        type: 'container.die',
        state: 'OPEN',
        fingerprint: `fp-${nodeId}`,
        first_seen: '2026-08-20T12:00:00.000Z',
        last_seen: '2026-08-20T12:00:00.000Z',
        event_count: 1,
        severity: 'error',
      });
      const summary = await orchestrator.collectForIncident(
        incident,
        makeEvent({ nodeId, type: 'container.die' }),
      );
      assert.equal(summary.succeeded, 2);
    }

    assert.ok(seen.filter((call) => call.url.startsWith('http://node-a/')).length === 2);
    assert.ok(seen.filter((call) => call.url.startsWith('http://node-b/')).length === 2);
    assert.ok(seen.filter((call) => call.auth === 'Bearer token-a').length === 2);
    assert.ok(seen.filter((call) => call.auth === 'Bearer token-b').length === 2);
    store.close();
  });

  it('times out each node request and persists failures', async () => {
    const store = createEventStore(':memory:');
    const incident = store.createIncident({
      service: 'dataease',
      node_id: 'test-svc-02',
      type: 'container.die',
      state: 'OPEN',
      fingerprint: 'fp-timeout',
      first_seen: '2026-08-20T12:00:00.000Z',
      last_seen: '2026-08-20T12:00:00.000Z',
      event_count: 1,
      severity: 'error',
    });
    const hangingFetch = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as FetchLike;

    const summary = await createEvidenceOrchestrator(
      makeConfig({ evidenceTimeoutMs: 10 }),
      store,
      hangingFetch,
    ).collectForIncident(incident, makeEvent({ type: 'container.die' }));

    assert.equal(summary.failed, 2);
    assert.equal(summary.retryableFailures, 2);
    assert.ok(store.listEvidence(incident.id).every((item) => item.error?.includes('timed out')));
    store.close();
  });

  it('redacts node tokens from persisted error messages', async () => {
    const store = createEventStore(':memory:');
    const incident = store.createIncident({
      service: 'dataease',
      node_id: 'test-svc-02',
      type: 'container.die',
      state: 'OPEN',
      fingerprint: 'fp-secret',
      first_seen: '2026-08-20T12:00:00.000Z',
      last_seen: '2026-08-20T12:00:00.000Z',
      event_count: 1,
      severity: 'error',
    });
    const echoingFetch = (async () =>
      new Response('authentication failed for node-token', { status: 401 })) as FetchLike;

    await createEvidenceOrchestrator(makeConfig(), store, echoingFetch)
      .collectForIncident(incident, makeEvent({ type: 'container.die' }));

    const errors = store.listEvidence(incident.id).map((item) => item.error ?? '');
    assert.ok(errors.every((error) => !error.includes('node-token')));
    assert.ok(errors.every((error) => error.includes('[REDACTED]')));
    store.close();
  });
});
